import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
    applyPatch, dumps, formatLayout, LOCATIONS_JSON, MAPS_JSON, parseJsonc, resolveInside, sanitizeImageName, saveImage,
} from "../lib/pack.mjs";
import { addTab, layoutTree, tabTargets } from "../public/layout.mjs";

const PACK = fileURLToPath(new URL("../../..", import.meta.url));

async function tempPack() {
    const root = await mkdtemp(path.join(tmpdir(), "mapper-"));
    for (const part of ["manifest.json", "maps", "locations", "layouts"]) {
        await cp(path.join(PACK, part), path.join(root, part), { recursive: true });
    }
    return root;
}

describe("dumps", () => {
    test("round-trips the pack's own files byte for byte", async () => {
        for (const file of [MAPS_JSON, LOCATIONS_JSON]) {
            const text = await readFile(path.join(PACK, file), "utf8");
            assert.equal(dumps(JSON.parse(text)) + "\n", text, file);
        }
    });

    test("matches the generator's layout", () => {
        const value = { name: "Cité", rules: ["a,b", "c"], nested: [["x", "y"]], empty: [], none: {}, n: 3 };
        assert.equal(dumps(value), [
            "{",
            '    "name": "Cité",',
            '    "rules": ["a,b", "c"],',
            '    "nested": [',
            '        ["x", "y"]',
            "    ],",
            '    "empty": [],',
            '    "none": {},',
            '    "n": 3',
            "}",
        ].join("\n"));
    });
});

describe("parseJsonc", () => {
    test("drops comments and trailing commas outside strings", () => {
        const text = '{\n  // note\n  "a": "x // not a comment", /* block */\n  "b": [1, 2,],\n  "c": "keep ,}",\n}';
        assert.deepEqual(parseJsonc(text), { a: "x // not a comment", b: [1, 2], c: "keep ,}" });
    });

    test("keeps escaped quotes inside strings", () => {
        assert.deepEqual(parseJsonc('["a\\"//b",]'), ['a"//b']);
    });
});

describe("formatLayout", () => {
    test("round-trips the pack's tracker and item layouts byte for byte", async () => {
        for (const file of ["layouts/tracker.json", "layouts/items.json"]) {
            const text = await readFile(path.join(PACK, file), "utf8");
            assert.equal(formatLayout(parseJsonc(text)) + "\n", text, file);
        }
    });

    test("keeps arrays on one line while they fit in 80 columns", () => {
        const fits = "x".repeat(80 - '    "maps": [""]'.length);
        assert.equal(formatLayout({ maps: [fits] }), `{\n    "maps": ["${fits}"]\n}`);
        assert.equal(formatLayout({ maps: [fits], n: 1 }), `{\n    "maps": [\n        "${fits}"\n    ],\n    "n": 1\n}`);
        assert.equal(formatLayout({ rows: [["a", "b"], ["c", "d"]] }, "  "), '{\n  "rows": [\n    ["a", "b"],\n    ["c", "d"]\n  ]\n}');
        assert.equal(formatLayout({ tabs: [{ title: "A" }], none: [], empty: {} }),
            '{\n    "tabs": [\n        {\n            "title": "A"\n        }\n    ],\n    "none": [],\n    "empty": {}\n}');
    });
});

describe("paths", () => {
    test("sanitizeImageName keeps names ASCII and image-typed", () => {
        assert.equal(sanitizeImageName("Minimap_(La_Cité_des_Cloches).PNG"), "Minimap_(La_Cite_des_Cloches).png");
        assert.equal(sanitizeImageName("board: Meow/Wow?.png"), "Wow_.png");
        assert.equal(sanitizeImageName("a<b>.jpg"), "a_b_.jpg");
        assert.throws(() => sanitizeImageName("map.svg"), /images must be/);
        assert.throws(() => sanitizeImageName(".png"), /images must be/);
        assert.throws(() => sanitizeImageName(" .png"), /empty image name/);
    });

    test("resolveInside refuses paths that leave the root", () => {
        const root = path.resolve("pack");
        assert.equal(resolveInside(root, "images/a.png"), path.join(root, "images", "a.png"));
        assert.throws(() => resolveInside(root, "../a.png"), /escapes/);
        assert.throws(() => resolveInside(root, "images/../../a.png"), /escapes/);
        assert.throws(() => resolveInside(root, path.resolve("elsewhere.png")), /bad path/);
        assert.throws(() => resolveInside(root, ""), /bad path/);
    });
});

describe("applyPatch", () => {
    let root;
    before(async () => {
        root = await tempPack();
    });
    after(() => rm(root, { recursive: true, force: true }));

    test("rewrites only the patched markers and maps", async () => {
        const originalLocations = await readFile(path.join(root, LOCATIONS_JSON), "utf8");
        const tree = JSON.parse(originalLocations);
        const town = tree.find((node) => node.name === "Traverse Town [Sora]");
        const placed = town.children.find((node) => node.map_locations);
        const unplaced = town.children.find((node) => !node.map_locations);
        const maps = JSON.parse(await readFile(path.join(root, MAPS_JSON), "utf8"));

        const result = await applyPatch(root, {
            locations: [
                { path: [town.name, placed.name], map_locations: null },
                { path: [town.name, unplaced.name], map_locations: [{ map: "Traverse Town [Sora]", x: 10, y: 20 }] },
                { path: [town.name, "No Such Place"], map_locations: [] },
            ],
            maps: [
                { name: maps[0].name, entry: { ...maps[0], location_size: 99 } },
                { name: "Mapper Test", entry: { name: "Mapper Test", location_size: 30, img: "images/maps/World.png" } },
                { name: maps[1].name, entry: null },
            ],
        });
        assert.deepEqual(result.missing, [`${town.name}/No Such Place`]);

        delete placed.map_locations;
        unplaced.map_locations = [{ map: "Traverse Town [Sora]", x: 10, y: 20 }];
        const written = await readFile(path.join(root, LOCATIONS_JSON), "utf8");
        assert.equal(written, dumps(tree) + "\n");
        assert.ok(!written.includes("\r"));

        const writtenMaps = JSON.parse(await readFile(path.join(root, MAPS_JSON), "utf8"));
        assert.equal(writtenMaps[0].location_size, 99);
        assert.equal(writtenMaps.at(-1).name, "Mapper Test");
        assert.ok(!writtenMaps.some((map) => map.name === maps[1].name));
        assert.equal(writtenMaps.length, maps.length);
    });

    test("leaves files untouched when nothing of theirs is patched", async () => {
        const original = await readFile(path.join(root, MAPS_JSON), "utf8");
        await writeFile(path.join(root, MAPS_JSON), original.replace("\n", "\n// sentinel\n"));
        await applyPatch(root, { locations: [] });
        assert.match(await readFile(path.join(root, MAPS_JSON), "utf8"), /sentinel/);
        await writeFile(path.join(root, MAPS_JSON), original);
    });
});

describe("applyPatch groups", () => {
    let root;
    before(async () => {
        root = await tempPack();
    });
    after(() => rm(root, { recursive: true, force: true }));

    const readTree = async () => JSON.parse(await readFile(path.join(root, LOCATIONS_JSON), "utf8"));
    const overworld = {
        name: "Mapper Test",
        children: [{ name: "Traverse Town [Sora]", sections: [{ name: "a", ref: "Traverse Town [Sora]/x/a" }] }],
    };

    test("adds, replaces and removes whole top-level locations", async () => {
        const original = await readTree();
        await applyPatch(root, { groups: [{ name: "Mapper Test", before: null, after: overworld }] });
        assert.deepEqual(await readTree(), [...original, overworld]);

        const placed = structuredClone(overworld);
        placed.children[0].map_locations = [{ map: "World", x: 1, y: 2 }];
        await applyPatch(root, { groups: [{ name: "Mapper Test", before: overworld, after: placed }] });
        assert.deepEqual((await readTree()).at(-1), placed);

        await applyPatch(root, { groups: [{ name: "Mapper Test", before: placed, after: null }] });
        assert.equal(await readFile(path.join(root, LOCATIONS_JSON), "utf8"), dumps(original) + "\n");
    });

    test("refuses a group that changed on disk, or a name already taken, before writing", async () => {
        const text = await readFile(path.join(root, LOCATIONS_JSON), "utf8");
        const town = JSON.parse(text).find((node) => node.name === "Traverse Town [Sora]");
        for (const group of [
            { name: "Mapper Test", before: overworld, after: null },
            { name: "Traverse Town [Sora]", before: null, after: overworld },
        ]) {
            await assert.rejects(applyPatch(root, {
                locations: [{ path: [town.name, town.children[0].name], map_locations: null }],
                groups: [group],
            }), (error) => error.status === 409 && /changed on disk/.test(error.message), group.name);
        }
        assert.equal(await readFile(path.join(root, LOCATIONS_JSON), "utf8"), text);
    });
});

describe("applyPatch layouts", () => {
    const TRACKER = "layouts/tracker.json";
    let root;
    before(async () => {
        root = await tempPack();
    });
    after(() => rm(root, { recursive: true, force: true }));

    async function boardsSubTab() {
        const file = parseJsonc(await readFile(path.join(root, TRACKER), "utf8"));
        const target = tabTargets(layoutTree(file)).find((t) => t.tab?.title === "Link Boards");
        const { key } = target.tab;
        const before = structuredClone(file[key]);
        addTab(file, target, { title: "Meow Wow", content: { type: "map", maps: ["Meow Wow"] } }, "All spirits");
        return { file, edit: { key, before, after: file[key] } };
    }

    test("refuses a layout that changed on disk, before writing anything", async () => {
        const { edit } = await boardsSubTab();
        const locations = await readFile(path.join(root, LOCATIONS_JSON), "utf8");
        const town = JSON.parse(locations).find((node) => node.name === "Traverse Town [Sora]");
        const stale = { ...edit, before: { ...edit.before, background: "#ffffff" } };
        await assert.rejects(applyPatch(root, {
            locations: [{ path: [town.name, town.children[0].name], map_locations: null }],
            layouts: [stale],
        }), (error) => error.status === 409 && /changed on disk/.test(error.message));
        assert.equal(await readFile(path.join(root, LOCATIONS_JSON), "utf8"), locations);
    });

    test("rewrites the layout file in its own style", async () => {
        const original = await readFile(path.join(root, TRACKER), "utf8");
        const { file, edit } = await boardsSubTab();
        await applyPatch(root, { layouts: [edit] });
        const written = await readFile(path.join(root, TRACKER), "utf8");
        assert.equal(written, formatLayout(file) + "\n");
        assert.deepEqual(parseJsonc(written), file);
        const kept = original.split("\n").filter((line) => written.includes(line));
        assert.ok(kept.length >= original.split("\n").length - 4, "only the Link Boards tab's lines change");
    });

    test("refuses files whose comments or formatting it would lose", async () => {
        const layouts = path.join(root, "layouts", "extra.jsonc");
        const value = { extra_layout: { type: "tabbed", tabs: [] } };
        await writeFile(layouts, `{\n  // keep me\n  "extra_layout": {"type": "tabbed", "tabs": []}\n}\n`);
        await assert.rejects(applyPatch(root, {
            layouts: [{ key: "extra_layout", before: value.extra_layout, after: { type: "tabbed", tabs: [{ title: "A" }] } }],
        }), (error) => error.status === 409 && /comments or formatting/.test(error.message));
        assert.match(await readFile(layouts, "utf8"), /keep me/);
    });
});

describe("saveImage", () => {
    let root;
    before(async () => {
        root = await mkdtemp(path.join(tmpdir(), "mapper-img-"));
    });
    after(() => rm(root, { recursive: true, force: true }));

    test("writes under images/ and refuses to overwrite unless asked", async () => {
        const saved = await saveImage(root, "images/maps/boards", "Meow Wow.png", Buffer.from("one"), false);
        assert.equal(saved, "images/maps/boards/Meow Wow.png");
        await assert.rejects(saveImage(root, "images/maps/boards", "Meow Wow.png", Buffer.from("two"), false),
            (error) => error.status === 409 && error.path === saved);
        await saveImage(root, "images/maps/boards", "Meow Wow.png", Buffer.from("two"), true);
        assert.equal(await readFile(path.join(root, saved), "utf8"), "two");
    });

    test("refuses folders outside images/", async () => {
        for (const dir of ["maps", "images/../scripts", "images/./x", "images\\..\\x", "images/a:b"]) {
            await assert.rejects(saveImage(root, dir, "a.png", Buffer.from(""), false), /plain folder under images/, dir);
        }
    });

    test("normalises separators in the folder", async () => {
        assert.equal(await saveImage(root, "images\\maps\\", "b.png", Buffer.from(""), false), "images/maps/b.png");
        assert.equal(await saveImage(root, null, "c.png", Buffer.from(""), false), "images/maps/c.png");
    });
});
