import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { readPack } from "../lib/pack.mjs";
import {
    addTab, eachTab, holdsDirectly, layoutMaps, layoutTree, moveTab, removeTab, renameTab, shiftTab, tabTargets,
} from "../public/layout.mjs";

const PACK = fileURLToPath(new URL("../../..", import.meta.url));

const map = (name) => ({ type: "map", maps: [name] });
const tabbed = (...tabs) => ({ type: "tabbed", tabs });
const tab = (title, content) => ({ title, content });

function shape(items) {
    return items.map((item) => (item.map ? item.map : item.tabs.map((t) => ({ [t.title]: shape(t.children) }))));
}

const at = (layouts, ref) => ref.path.reduce((value, step) => value[step], layouts[ref.key]);

function findTab(tree, title) {
    let found = null;
    eachTab(tree, (t) => {
        if (t.title === title) found ??= t;
    });
    assert.ok(found, `tab ${title}`);
    return found;
}

function sample() {
    return {
        tracker_default: { type: "dock", content: [{ type: "layout", key: "maps" }, { type: "layout", key: "maps" }] },
        maps: tabbed(
            tab("Sora", tabbed(tab("Town", map("Town [Sora]")), tab("City", map("City [Sora]")))),
            tab("Boards", map("Boards")),
            tab("Items", { type: "itemgrid", rows: [] }),
        ),
        loop: { type: "layout", key: "loop" },
    };
}

describe("layoutTree", () => {
    test("nests tabs, follows layout references once and locates every node", () => {
        const layouts = sample();
        const tree = layoutTree(layouts);
        assert.deepEqual(shape(tree), [[
            { Sora: [[{ Town: ["Town [Sora]"] }, { City: ["City [Sora]"] }]] },
            { Boards: ["Boards"] },
            { Items: [] },
        ]]);
        assert.equal(at(layouts, tree[0]), layouts.maps);
        eachTab(tree, (t) => assert.equal(at(layouts, t).title, t.title));
        const sora = findTab(tree, "Sora");
        assert.equal(sora.children[0].parent, sora);
        assert.ok(holdsDirectly(sora.children[0]));
        assert.equal(tree[0].parent, null);
        assert.deepEqual(layoutMaps(tree), ["Town [Sora]", "City [Sora]", "Boards"]);
    });

    test("reads the pack's tracker layout with every map in a tab", async () => {
        const pack = await readPack(PACK);
        const tree = layoutTree(pack.layouts);
        const top = tree.find((item) => item.tabs).tabs.map((t) => t.title);
        assert.ok(top.includes("Sora") && top.includes("Riku"), top.join(", "));
        const town = findTab(tree, "Traverse Town");
        assert.deepEqual(town.children, [{ map: "Traverse Town [Sora]" }]);
        assert.equal(town.group.parent.title, "Sora");
        const listed = new Set(layoutMaps(tree));
        for (const m of pack.maps) assert.ok(listed.has(m.name), `${m.name} is in a layout`);
        assert.ok(pack.tabRefs.Sora.includes("scripts/autotracking/auto_tab.lua"), JSON.stringify(pack.tabRefs));
    });
});

describe("tabTargets", () => {
    test("lists groups and tabs without sub-tabs, skipping map-less groups and the moving tab", () => {
        const layouts = sample();
        layouts.maps.tabs[2].content = tabbed(tab("Keys", { type: "itemgrid" }));
        const tree = layoutTree(layouts);
        const describe = (list) => list.map((t) => `${t.group ? "group" : "tab"} ${t.trail.join("/")}`);
        assert.deepEqual(describe(tabTargets(tree)), ["group ", "group Sora", "tab Sora/Town", "tab Sora/City", "tab Boards"]);
        assert.deepEqual(describe(tabTargets(tree, findTab(tree, "Sora"))), ["group ", "tab Boards"]);
    });
});

describe("tab edits", () => {
    test("addTab appends to a group or turns a tab into sub-tabs", () => {
        const layouts = sample();
        const targets = tabTargets(layoutTree(layouts));
        const root = targets.find((t) => t.group && !t.trail.length);
        const boardsTarget = targets.find((t) => t.tab?.title === "Boards");
        addTab(layouts, root, tab("Riku", map("Town [Riku]")));
        addTab(layouts, boardsTarget, tab("Meow Wow", map("Meow Wow")), "All spirits");
        assert.deepEqual(layouts.maps.tabs.map((t) => t.title), ["Sora", "Boards", "Items", "Riku"]);
        assert.deepEqual(layouts.maps.tabs[1].content, tabbed(tab("All spirits", map("Boards")), tab("Meow Wow", map("Meow Wow"))));
    });

    test("removeTab folds a nested group left with one tab back into its parent", () => {
        const layouts = sample();
        assert.equal(removeTab(layouts, findTab(layoutTree(layouts), "City")), true);
        assert.deepEqual(layouts.maps.tabs[0], tab("Sora", map("Town [Sora]")));
        assert.equal(removeTab(layouts, findTab(layoutTree(layouts), "Items")), false);
        assert.deepEqual(layouts.maps.tabs.map((t) => t.title), ["Sora", "Boards"]);
    });

    test("moveTab moves a tab between groups and folds what it leaves", () => {
        const layouts = sample();
        let tree = layoutTree(layouts);
        const root = tabTargets(tree).find((t) => t.group && !t.trail.length);
        assert.equal(moveTab(layouts, findTab(tree, "City"), root), true);
        assert.deepEqual(layouts.maps.tabs.map((t) => t.title), ["Sora", "Boards", "Items", "City"]);
        assert.deepEqual(layouts.maps.tabs[0].content, map("Town [Sora]"));

        tree = layoutTree(layouts);
        const underBoards = tabTargets(tree).find((t) => t.tab?.title === "Boards");
        assert.equal(moveTab(layouts, findTab(tree, "City"), underBoards, "Boards"), false);
        assert.deepEqual(layouts.maps.tabs[1].content, tabbed(tab("Boards", map("Boards")), tab("City", map("City [Sora]"))));
    });

    test("moveTab under its only sibling keeps both maps", () => {
        const layouts = sample();
        const tree = layoutTree(layouts);
        const underCity = tabTargets(tree).find((t) => t.tab?.title === "City");
        assert.equal(moveTab(layouts, findTab(tree, "Town"), underCity, "City"), true);
        assert.deepEqual(layouts.maps.tabs[0], tab("Sora", tabbed(tab("City", map("City [Sora]")), tab("Town", map("Town [Sora]")))));
    });

    test("shiftTab and renameTab change only that group", () => {
        const layouts = sample();
        shiftTab(layouts, findTab(layoutTree(layouts), "Boards"), -1);
        shiftTab(layouts, findTab(layoutTree(layouts), "Town"), -1);
        renameTab(layouts, findTab(layoutTree(layouts), "City"), "La Cité");
        assert.deepEqual(layouts.maps.tabs.map((t) => t.title), ["Boards", "Sora", "Items"]);
        assert.deepEqual(layouts.maps.tabs[1].content.tabs.map((t) => t.title), ["Town", "La Cité"]);
    });
});
