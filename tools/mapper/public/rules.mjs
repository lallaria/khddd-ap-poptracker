/**
 * PopTracker access rules as the mapper reads them, and the rule fixes it records for the apworld.
 *
 * A rule is a list of alternatives, any one of which is enough; an alternative is a list of terms that must all
 * hold. `[]` adds no requirement. Locations combine their rules with their parent's like PopTracker does
 * (src/core/location.cpp): every parent alternative followed by every own alternative.
 */

export const fold = (text) => String(text).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const splitTerms = (text) => String(text).split(",").map((term) => term.trim()).filter(Boolean);

/** A location's or section's own access_rules; a plain string is a single term, as in PopTracker. */
export function ownRules(node) {
    const rules = node?.access_rules;
    if (typeof rules === "string") return rules.trim() ? [[rules.trim()]] : [];
    if (!Array.isArray(rules)) return [];
    return rules.map((rule) => (Array.isArray(rule) ? rule.map(String) : splitTerms(rule))).filter((rule) => rule.length);
}

export function combine(outer, inner) {
    if (!inner.length) return outer;
    if (!outer.length) return inner;
    return outer.flatMap((a) => inner.map((b) => [...a, ...b]));
}

/** Every location by its PopTracker id (`World/Location`), with the id rules are inherited from. */
export function locationIndex(locations) {
    const index = new Map();
    const walk = (nodes, prefix, up) => {
        for (const node of nodes || []) {
            if (typeof node?.name !== "string") continue;
            const id = prefix + node.name;
            index.set(id, { node, up });
            walk(node.children, `${id}/`, id);
        }
    };
    walk(locations, "", null);
    for (const [id, entry] of index) {
        const parent = typeof entry.node.parent === "string" ? entry.node.parent.replace(/^@/, "") : "";
        if (!parent) continue;
        // exact id first, then an id ending in it; an unknown parent leaves the tree parent
        const found = index.has(parent) ? parent
            : [...index.keys()].find((other) => other.length > parent.length && other.endsWith(parent));
        if (found && found !== id) entry.up = found;
    }
    return index;
}

function locationRules(index, id, seen = new Set()) {
    const entry = index.get(id);
    if (!entry || seen.has(id)) return [];
    seen.add(id);
    return combine(entry.up ? locationRules(index, entry.up, seen) : [], ownRules(entry.node));
}

export const inheritedRules = (index, id) => {
    const up = index.get(id)?.up;
    return up ? locationRules(index, up, new Set([id])) : [];
};

/**
 * The check a section stands for, refs followed.
 *
 * Returns:
 *     `{id, name, location, own, inherited}`: `id` is the section's PopTracker path, `own` the rules the check adds
 *     to its location's parents, `inherited` theirs; `missing` instead of rules when the ref leads nowhere.
 */
export function resolveCheck(index, locationId, section) {
    let id = section.ref ?? `${locationId}/${section.name ?? ""}`;
    for (let hops = 0; hops < 16; hops++) {
        const cut = id.lastIndexOf("/");
        const location = id.slice(0, cut);
        const name = id.slice(cut + 1);
        const holder = index.get(location);
        const target = holder?.node.sections?.find((candidate) => candidate.name === name);
        if (!target) return { id, name, location, missing: true };
        if (target.ref && target.ref !== id) {
            id = target.ref;
            continue;
        }
        return {
            id, name, location,
            own: combine(ownRules(holder.node), ownRules(target)),
            inherited: inheritedRules(index, location),
        };
    }
    return { id, name: id.slice(id.lastIndexOf("/") + 1), location: id.slice(0, id.lastIndexOf("/")), missing: true };
}

/** Ids of every named section in tree order. */
export function checkOrder(index) {
    const order = new Map();
    for (const [id, { node }] of index) {
        for (const section of node.sections || []) {
            const check = `${id}/${section.name}`;
            if (typeof section.name === "string" && !order.has(check)) order.set(check, order.size);
        }
    }
    return order;
}

export function normalizeRules(rules) {
    const unique = new Map();
    for (const rule of rules) {
        const terms = [...new Set(rule)].sort();
        unique.set(terms.join(","), terms);
    }
    return [...unique.keys()].sort().map((key) => unique.get(key));
}

export const sameRules = (a, b) => JSON.stringify(normalizeRules(a)) === JSON.stringify(normalizeRules(b));

/** code -> display name from item definitions; a code shared by several stages names the item. */
export function itemNames(items) {
    const names = new Map();
    for (const item of items || []) {
        const stages = new Map();
        for (const stage of item.stages || []) {
            for (const code of splitTerms(stage.codes ?? "")) {
                stages.set(code, stages.has(code) ? item.name : stage.name ?? item.name);
            }
        }
        for (const code of splitTerms(item.codes ?? "")) if (!names.has(code)) names.set(code, item.name);
        for (const [code, name] of stages) if (!names.has(code)) names.set(code, name);
    }
    return names;
}

const HELPER = /^\^?\$([^|]+)(?:\|(.*))?$/;
const COUNTED = /^(.*?)(?::(\d+))?$/;

export function termLabel(term, names) {
    if (/^\[.*\]$/.test(term)) return `${termLabel(term.slice(1, -1), names)} (optional)`;
    if (/^\{.*\}$/.test(term)) return `${termLabel(term.slice(1, -1), names)} (checkable)`;
    if (term.startsWith("@")) return `reach ${term.slice(term.lastIndexOf("/") + 1)}`;
    const helper = HELPER.exec(term);
    if (helper) {
        const args = (helper[2] ?? "").split("|").filter(Boolean).map((arg) => names.get(arg) ?? arg);
        return `${helper[1]}(${args.join(", ")})`;
    }
    const [, code, count] = COUNTED.exec(term);
    const name = names.get(code);
    if (!name) return term;
    return count ? `${name} ×${count}` : name;
}

/** False for a plain code that no item defines; helpers and references are taken on trust. */
export function knownTerm(term, names) {
    if (/^[\^$@[{]/.test(term)) return true;
    return names.has(COUNTED.exec(term)[1]);
}

/** A term from what the user typed: an item name or code, `:N` or `×N` for a count, or a raw helper or reference. */
export function parseTerm(text, names) {
    const raw = String(text).trim();
    if (!raw) return null;
    if (/^[\^$@[{]/.test(raw)) return raw;
    const [, typed, count] = /^(.*?)(?:\s*[:×]\s*(\d+))?$/.exec(raw);
    const base = typed.trim();
    const wanted = fold(base);
    const code = names.has(base) ? base : [...names].find(([, name]) => fold(name) === wanted)?.[0] ?? base;
    return count && Number(count) > 1 ? `${code}:${Number(count)}` : code;
}

/** Distinct helper terms the pack's access rules use, for suggestions. */
export function helperTerms(index) {
    const terms = new Set();
    for (const { node } of index.values()) {
        for (const holder of [node, ...(node.sections || [])]) {
            for (const rule of ownRules(holder)) for (const term of rule) if (HELPER.test(term)) terms.add(term);
        }
    }
    return [...terms].sort();
}

/** Checks a fixes object from the client: id -> `{check, wanted: rules or null, note, was}`. */
export function validFixes(fixes) {
    const rules = (value) => Array.isArray(value)
        && value.every((rule) => Array.isArray(rule) && rule.every((term) => typeof term === "string"));
    return fixes !== null && typeof fixes === "object" && !Array.isArray(fixes) && Object.entries(fixes).every(([id, fix]) =>
        id.includes("/") && fix && typeof fix.check === "string" && (fix.wanted === null || rules(fix.wanted))
        && typeof fix.note === "string" && (fix.was === undefined || rules(fix.was)));
}

/** Fixes whose wanted rule is what the check has now, so the apworld change has reached locations.json. */
export function appliedFixes(index, fixes) {
    return Object.keys(fixes).filter((id) => {
        const fix = fixes[id];
        if (!fix.wanted) return false;
        const check = resolveCheck(index, id.slice(0, id.lastIndexOf("/")), { name: id.slice(id.lastIndexOf("/") + 1) });
        return !check.missing && sameRules(check.own, fix.wanted);
    });
}

function markdownRules(rules, names) {
    const line = (rule) => `${rule.map((term) => termLabel(term, names)).join(" & ")} \`${rule.join(",")}\``;
    if (!rules.length) return " nothing";
    if (rules.length === 1) return ` ${line(rules[0])}`;
    return " any of\n" + rules.map((rule) => `  - ${line(rule)}`).join("\n");
}

/** The handoff for a session that fixes the logic in the apworld; checks already fixed are left out. */
export function fixesMarkdown({ name, locations, items }, fixes) {
    const index = locationIndex(locations);
    const names = itemNames(items);
    const order = checkOrder(index);
    const applied = new Set(appliedFixes(index, fixes));
    const pending = Object.keys(fixes).filter((id) => !applied.has(id))
        .sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity) || (a < b ? -1 : a > b ? 1 : 0));
    const out = [
        `# Rule fixes: ${name}`,
        "",
        `${pending.length} ${pending.length === 1 ? "check needs" : "checks need"} different access rules. These notes come from`
            + " the PopTracker mapper and change nothing in the pack: fix the logic in the apworld, then regenerate the"
            + " pack's locations.json from it.",
        "",
        "Each check lists what its parent locations (world, region) already require, its own rule in locations.json"
            + " now, and the rule it should have on top of the parents' instead. Any one alternative of a rule is enough;"
            + " terms joined by `&` are all needed. Names come from the pack's items, with PopTracker codes in backticks:"
            + " `code:N` is N of an item, `$helper|args` a Lua helper, `@path` needs that location reachable. Whether a fix"
            + " belongs on the location, a region or an entrance is for the apworld to decide.",
    ];
    if (applied.size) out.push("", `${applied.size} more already match locations.json and are left out.`);
    let world = null;
    for (const id of pending) {
        const fix = fixes[id];
        const check = resolveCheck(index, id.slice(0, id.lastIndexOf("/")), { name: id.slice(id.lastIndexOf("/") + 1) });
        const top = check.missing ? "Not in locations.json any more" : id.split("/")[0];
        if (top !== world) {
            world = top;
            out.push("", `## ${world}`);
        }
        out.push("", `### ${fix.check}`, `\`${id}\``);
        if (check.missing) {
            if (fix.was) out.push(`- Was:${markdownRules(fix.was, names)}`);
        } else {
            out.push(`- Parents require:${markdownRules(check.inherited, names)}`, `- Now:${markdownRules(check.own, names)}`);
        }
        out.push(fix.wanted ? `- Should be:${markdownRules(fix.wanted, names)}` : "- Should be: see the note");
        if (fix.note.trim()) out.push(`- Note: ${fix.note.trim().replace(/\s*\n\s*/g, " ")}`);
    }
    return out.join("\n") + "\n";
}
