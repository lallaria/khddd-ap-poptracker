import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { LOCATIONS_JSON, readPack } from "../lib/pack.mjs";
import { isSummary, isSummaryGroup, missingRefs, summarySections } from "../public/summary.mjs";

const PACK = fileURLToPath(new URL("../../..", import.meta.url));

const tree = () => [
    { name: "Town", children: [
        { name: "Gate", sections: [{ name: "Gate Chest" }, { name: "Gate Prize" }], map_locations: [{ map: "Town", x: 1, y: 1 }] },
        { name: "Hidden", sections: [{ name: "Hidden Chest" }] },
        { name: "Square", sections: [{}, { name: "Square Chest" }], map_locations: [{ map: "Town", x: 2, y: 2 }] },
    ] },
    { name: "Overworld", children: [
        { name: "Town", sections: [{ name: "Gate Chest", ref: "Town/Gate/Gate Chest" }], map_locations: [{ map: "World", x: 5, y: 5 }] },
    ] },
];

describe("summarySections", () => {
    test("refers to every named check with a marker on the maps, once", () => {
        assert.deepEqual(summarySections(tree(), ["Town"]), [
            { name: "Gate Chest", ref: "Town/Gate/Gate Chest" },
            { name: "Gate Prize", ref: "Town/Gate/Gate Prize" },
            { name: "Square Chest", ref: "Town/Square/Square Chest" },
        ]);
    });

    test("follows refs, so summarising a map of summaries reaches the checks", () => {
        assert.deepEqual(summarySections(tree(), ["Town", "World"]).map((s) => s.ref),
            ["Town/Gate/Gate Chest", "Town/Gate/Gate Prize", "Town/Square/Square Chest"]);
        assert.deepEqual(summarySections(tree(), ["World"]), [{ name: "Gate Chest", ref: "Town/Gate/Gate Chest" }]);
    });

    test("takes whole regions and keeps to the given checks", () => {
        const checks = new Set(["Town/Gate/Gate Chest", "Town/Hidden/Hidden Chest", "Town/Square/Square Chest"]);
        assert.deepEqual(summarySections(tree(), ["Town"], { wholeRegions: true, checks }).map((s) => s.ref),
            ["Town/Gate/Gate Chest", "Town/Hidden/Hidden Chest", "Town/Square/Square Chest"]);
        assert.deepEqual(summarySections(tree(), ["Town"], { checks }).map((s) => s.ref),
            ["Town/Gate/Gate Chest", "Town/Square/Square Chest"]);
    });

    test("covers a real world's checks, unplaced ones too, without its logic events", async () => {
        const pack = await readPack(PACK);
        const checks = new Set(pack.checks);
        assert.ok(checks.has("Traverse Town [Sora]/Secret Portal/Traverse Town Secret Portal [Sora]"));
        const placed = summarySections(pack.locations, ["Traverse Town [Sora]"], { checks });
        const whole = summarySections(pack.locations, ["Traverse Town [Sora]"], { wholeRegions: true, checks });
        assert.ok(placed.length > 30 && whole.length > placed.length, `${placed.length} placed, ${whole.length} in all`);
        assert.ok(whole.some((s) => s.name === "Traverse Town Secret Portal [Sora]"));
        assert.ok(!whole.some((s) => s.ref.includes("/Cleared/")));
        assert.equal(new Set(whole.map((s) => s.ref)).size, whole.length);
        assert.deepEqual(missingRefs(pack.locations, whole), []);
        assert.ok(whole.every((s) => s.ref.endsWith(`/${s.name}`)));
    });
});

describe("summary groups", () => {
    test("recognises summaries, and none of the generated top-level locations is one", async () => {
        const [town, overworld] = tree();
        assert.ok(isSummaryGroup(overworld) && isSummary(overworld.children[0]));
        assert.ok(!isSummaryGroup(town) && !isSummaryGroup({ name: "Empty", children: [] }));
        const locations = JSON.parse(await readFile(path.join(PACK, LOCATIONS_JSON), "utf8"));
        for (const name of ["Traverse Town [Sora]", "World Map [Sora]", "Levels", "Link Boards"]) {
            assert.ok(!isSummaryGroup(locations.find((node) => node.name === name)), name);
        }
    });

    test("missingRefs names refs whose section is gone", () => {
        const sections = [{ name: "Gate Chest", ref: "Town/Gate/Gate Chest" }, { name: "Old", ref: "Town/Gone/Old" }];
        assert.deepEqual(missingRefs(tree(), sections), ["Town/Gone/Old"]);
    });
});
