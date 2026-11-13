import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
    appliedFixes, combine, fixesMarkdown, helperTerms, inheritedRules, itemNames, knownTerm, locationIndex, ownRules,
    parseTerm, resolveCheck, sameRules, termLabel, validFixes,
} from "../public/rules.mjs";

const items = [
    { name: "High Jump", codes: "high_jump" },
    { name: "Recusant Sigil", codes: "recusant_sigil,recusants_sigil" },
    { name: "Lucky Emblem", codes: "lucky_emblem" },
    { name: "La Cité [Sora]", codes: "world_cite_sora" },
    { name: "Goal", stages: [
        { name: "Goal: Boss", codes: "opt_goal,opt_goal_boss" },
        { name: "Goal: Emblems", codes: "opt_goal,opt_goal_emblems" },
    ] },
];

const tree = () => [
    { name: "Town", access_rules: ["world_town"], children: [
        { name: "Roof", access_rules: ["high_jump", "$can_glide"], sections: [
            { name: "Roof Chest" },
            { name: "Roof Prize", access_rules: ["lucky_emblem:3"] },
        ] },
        { name: "Square", sections: [{ name: "Square Chest" }] },
        { name: "Boss", sections: [{ name: "Boss Prize", ref: "Town/Roof/Roof Chest" }, { name: "Gone", ref: "Town/Attic/Gone" }] },
    ] },
    { name: "Annex", parent: "@Town/Roof", access_rules: "recusant_sigil", sections: [{ name: "Annex Chest" }] },
];

describe("rules", () => {
    test("reads access_rules like PopTracker: commas join terms, a plain string is one term", () => {
        assert.deepEqual(ownRules({ access_rules: ["a, b", "c", ""] }), [["a", "b"], ["c"]]);
        assert.deepEqual(ownRules({ access_rules: [["a", "b"]] }), [["a", "b"]]);
        assert.deepEqual(ownRules({ access_rules: "a,b" }), [["a,b"]]);
        assert.deepEqual(ownRules({}), []);
    });

    test("combines every parent alternative with every own one, parent terms first", () => {
        assert.deepEqual(combine([["p"], ["q"]], [["a"], ["b", "c"]]), [["p", "a"], ["p", "b", "c"], ["q", "a"], ["q", "b", "c"]]);
        assert.deepEqual(combine([], [["a"]]), [["a"]]);
        assert.deepEqual(combine([["p"]], []), [["p"]]);
    });

    test("inherits from the tree parent, or from the location a parent key names", () => {
        const index = locationIndex(tree());
        assert.deepEqual(inheritedRules(index, "Town/Roof"), [["world_town"]]);
        assert.deepEqual(inheritedRules(index, "Town"), []);
        assert.deepEqual(inheritedRules(index, "Annex"), [["world_town", "high_jump"], ["world_town", "$can_glide"]]);
    });

    test("resolves a check through its ref, with the section's own rules on its location's", () => {
        const index = locationIndex(tree());
        assert.deepEqual(resolveCheck(index, "Town/Roof", { name: "Roof Prize" }), {
            id: "Town/Roof/Roof Prize", name: "Roof Prize", location: "Town/Roof",
            own: [["high_jump", "lucky_emblem:3"], ["$can_glide", "lucky_emblem:3"]], inherited: [["world_town"]],
        });
        const via = resolveCheck(index, "Town/Boss", { name: "Boss Prize", ref: "Town/Roof/Roof Chest" });
        assert.equal(via.id, "Town/Roof/Roof Chest");
        assert.deepEqual(via.own, [["high_jump"], ["$can_glide"]]);
        assert.equal(resolveCheck(index, "Town/Boss", { name: "Gone", ref: "Town/Attic/Gone" }).missing, true);
    });

    test("compares rules regardless of order and repeats", () => {
        assert.ok(sameRules([["b", "a"], ["c"]], [["c", "c"], ["a", "b"]]));
        assert.ok(!sameRules([["a"]], [["a", "b"]]));
        assert.ok(sameRules([], []));
    });

    test("names codes after their items; a code all stages share names the item", () => {
        const names = itemNames(items);
        assert.equal(names.get("recusants_sigil"), "Recusant Sigil");
        assert.equal(names.get("opt_goal"), "Goal");
        assert.equal(names.get("opt_goal_emblems"), "Goal: Emblems");
    });

    test("labels terms and reads them back from names, codes and counts", () => {
        const names = itemNames(items);
        assert.equal(termLabel("lucky_emblem:3", names), "Lucky Emblem ×3");
        assert.equal(termLabel("$opt_off|opt_goal_boss", names), "opt_off(Goal: Boss)");
        assert.equal(termLabel("^$board_gate|3|1", names), "board_gate(3, 1)");
        assert.equal(termLabel("@Town/Roof/Roof Chest", names), "reach Roof Chest");
        assert.equal(termLabel("[high_jump]", names), "High Jump (optional)");
        assert.equal(termLabel("mystery", names), "mystery");
        assert.equal(parseTerm("  high jump ", names), "high_jump");
        assert.equal(parseTerm("la cite [sora]", names), "world_cite_sora");
        assert.equal(parseTerm("Lucky Emblem:5", names), "lucky_emblem:5");
        assert.equal(parseTerm("lucky_emblem ×1", names), "lucky_emblem");
        assert.equal(parseTerm("recusants_sigil", names), "recusants_sigil");
        assert.equal(parseTerm("$has_worlds|6", names), "$has_worlds|6");
        assert.equal(parseTerm("New Item", names), "New Item");
        assert.equal(parseTerm("  ", names), null);
        assert.ok(knownTerm("lucky_emblem:5", names));
        assert.ok(knownTerm("$anything", names));
        assert.ok(!knownTerm("New Item", names));
    });

    test("collects the helper terms the rules use", () => {
        assert.deepEqual(helperTerms(locationIndex(tree())), ["$can_glide"]);
    });

    test("accepts only fixes shaped like rule-fixes.json", () => {
        assert.ok(validFixes({}));
        assert.ok(validFixes({ "Town/Roof/Roof Chest": { check: "Roof Chest", wanted: [["a"]], note: "", was: [] } }));
        assert.ok(validFixes({ "Town/Roof/Roof Chest": { check: "Roof Chest", wanted: null, note: "why" } }));
        assert.ok(!validFixes([]));
        assert.ok(!validFixes({ "Roof Chest": { check: "Roof Chest", wanted: null, note: "" } }));
        assert.ok(!validFixes({ "Town/Roof/Roof Chest": { check: "Roof Chest", wanted: ["a"], note: "" } }));
        assert.ok(!validFixes({ "Town/Roof/Roof Chest": { check: "Roof Chest", wanted: null } }));
    });
});

describe("fixesMarkdown", () => {
    const pack = { name: "Test Pack", locations: tree(), items };
    const fixes = {
        "Town/Square/Square Chest": { check: "Square Chest", wanted: null, note: "Needs the\nbell rung first.", was: [] },
        "Town/Roof/Roof Chest": { check: "Roof Chest", wanted: [["high_jump", "recusant_sigil"], ["$can_glide"]], note: "", was: [] },
        "Town/Roof/Roof Prize": { check: "Roof Prize", wanted: [["$can_glide", "lucky_emblem:3"], ["lucky_emblem:3", "high_jump"]], note: "" },
        "Town/Attic/Gone": { check: "Gone", wanted: [], note: "", was: [["high_jump"]] },
    };

    test("leaves out fixes locations.json already has", () => {
        assert.deepEqual(appliedFixes(locationIndex(tree()), fixes), ["Town/Roof/Roof Prize"]);
    });

    test("tells the session to work on the checked-out apworld branch only and report its commit", () => {
        const text = fixesMarkdown(pack, fixes);
        assert.match(text, /^# Apworld rule fixes: Test Pack\n\n3 checks need different access rules in the apworld\.\n/);
        assert.ok(text.includes("- Base the changes on the apworld branch that is checked out now.\n"), text);
        assert.ok(text.includes("- When done, commit the apworld changes and reply with the commit ID.\n"), text);
        assert.doesNotMatch(text, /locations\.json|regenerate the/);
        assert.doesNotMatch(text, /`Town\//);
    });

    test("lists the pending fixes in pack order, by top-level location", () => {
        const text = fixesMarkdown(pack, fixes);
        assert.doesNotMatch(text, /Roof Prize/);
        assert.ok(text.indexOf("### Roof Chest") < text.indexOf("### Square Chest"));
        assert.ok(text.includes([
            "## Town",
            "",
            "### Roof Chest",
            "- Parents require: world_town `world_town`",
            "- Now: any of",
            "  - High Jump `high_jump`",
            "  - can_glide() `$can_glide`",
            "- Should be: any of",
            "  - High Jump & Recusant Sigil `high_jump,recusant_sigil`",
            "  - can_glide() `$can_glide`",
        ].join("\n")), text);
        assert.ok(text.includes("- Now: nothing\n- Should be: see the note\n- Note: Needs the bell rung first."), text);
        assert.ok(text.includes("## No longer in the tracker\n\n### Gone\n- Was: High Jump `high_jump`\n- Should be: nothing"), text);
    });
});
