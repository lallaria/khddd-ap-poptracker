import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
    applyPatch, dumps, layoutTree, LOCATIONS_JSON, MAPS_JSON, parseJsonc, readPack, resolveInside, sanitizeImageName,
    saveImage,
} from "../lib/pack.mjs";

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

describe("layoutTree", () => {
    test("nests maps under tab titles and follows layout references once", () => {
        const layouts = {
            tracker_default: {
                type: "dock",
                content: [
                    { type: "layout", key: "maps" },
                    { type: "layout", key: "maps" },
                ],
            },
            maps: {
                type: "tabbed",
                tabs: [
                    { title: "Overworld", content: { type: "tabbed", tabs: [
                        { title: "Overview", content: { type: "map", maps: ["World"] } },
                        { title: "Town", content: { type: "map", maps: ["Town"] } },
                    ] } },
                    { title: "Items", content: { type: "itemgrid", rows: [] } },
                ],
            },
            loop: { type: "layout", key: "loop" },
        };
        assert.deepEqual(layoutTree(layouts), [
            { title: "Overworld", children: [
                { title: "Overview", children: [{ map: "World" }] },
                { title: "Town", children: [{ map: "Town" }] },
            ] },
        ]);
    });

    test("reads the pack's tracker layout", async () => {
        const pack = await readPack(PACK);
        const titles = pack.layoutTree.map((node) => node.title);
        assert.ok(titles.includes("Sora") && titles.includes("Riku"), titles.join(", "));
        const sora = pack.layoutTree.find((node) => node.title === "Sora");
        assert.deepEqual(sora.children[0], { title: "Traverse Town", children: [{ map: "Traverse Town [Sora]" }] });
        const listed = JSON.stringify(pack.layoutTree);
        for (const map of pack.maps) assert.ok(listed.includes(JSON.stringify(map.name)), `${map.name} is in a layout`);
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
                { name: "Overworld", entry: { name: "Overworld", location_size: 30, img: "images/maps/World.png" } },
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
        assert.equal(writtenMaps.at(-1).name, "Overworld");
        assert.ok(!writtenMaps.some((map) => map.name === maps[1].name));
        assert.equal(writtenMaps.length, maps.length);
    });

    test("leaves files untouched when nothing of theirs is patched", async () => {
        const original = await readFile(path.join(root, MAPS_JSON), "utf8");
        await writeFile(path.join(root, MAPS_JSON), original.replace("\n", "\n// sentinel\n"));
        await applyPatch(root, { locations: [] });
        assert.match(await readFile(path.join(root, MAPS_JSON), "utf8"), /sentinel/);
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
