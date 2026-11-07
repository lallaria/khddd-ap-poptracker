/** A summary location: a leaf whose sections all `ref` checks elsewhere, so its marker shows theirs. */
export const isSummary = (node) => !node?.children && Array.isArray(node?.sections) && node.sections.length > 0
    && node.sections.every((section) => section.ref);

/** A top-level location holding only summaries, which the mapper may rewrite as a whole. */
export const isSummaryGroup = (node) => Boolean(node) && !node.sections && Array.isArray(node.children)
    && node.children.length > 0 && node.children.every(isSummary);

function walk(nodes, prefix, visit) {
    for (const node of nodes || []) {
        if (typeof node?.name !== "string") continue;
        const path = prefix + node.name;
        visit(node, path);
        walk(node.children, `${path}/`, visit);
    }
}

/**
 * Ref sections for the named checks behind the markers on `maps`.
 *
 * Sections keep their AP names, which Universal Tracker matches on. Refs are followed, so a summary of maps that
 * show summaries still points at the checks themselves.
 *
 * Args:
 *     wholeRegions: take every check of the top-level locations with a marker there, placed or not;
 *         otherwise only the checks of the marked locations.
 *     checks: section paths that are real checks (the autotracker's mapping); null takes every named section.
 */
export function summarySections(locations, maps, { wholeRegions = false, checks = null } = {}) {
    const wanted = new Set(maps);
    const marked = (node) => (node.map_locations || []).some((m) => wanted.has(m.map));
    const regions = new Set();
    if (wholeRegions) {
        for (const top of locations) walk([top], "", (node) => marked(node) && regions.add(top.name));
    }
    const seen = new Set();
    const out = [];
    walk(locations, "", (node, path) => {
        if (wholeRegions ? !regions.has(path.split("/")[0]) : !marked(node)) return;
        for (const section of node.sections || []) {
            if (typeof section.name !== "string" || !section.name) continue;
            const ref = section.ref ?? `${path}/${section.name}`;
            if (seen.has(ref) || (checks && !checks.has(ref))) continue;
            seen.add(ref);
            out.push({ name: section.name, ref });
        }
    });
    return out;
}

/** Ref sections for the named sections of `members` (`{node, path}` with `path` a name array), refs followed, each once. */
export function groupSections(members) {
    const seen = new Set();
    const out = [];
    for (const { node, path } of members) {
        for (const section of node.sections || []) {
            if (typeof section.name !== "string" || !section.name) continue;
            const ref = section.ref ?? `${path.join("/")}/${section.name}`;
            if (seen.has(ref)) continue;
            seen.add(ref);
            out.push({ name: section.name, ref });
        }
    }
    return out;
}

/** The leading words all `names` share, short of the whole of any name; otherwise the first name. */
export function sharedName(names) {
    const split = names.map((name) => name.trim().split(/\s+/));
    let length = 0;
    while (split.every((words) => length < words.length - 1 && words[length] === split[0][length])) length++;
    return length ? split[0].slice(0, length).join(" ") : names[0] ?? "";
}

/** Paths, as name arrays, of the locations that `sections` refer into, each once and in order. */
export function refLocations(sections) {
    const seen = new Set();
    const out = [];
    for (const { ref } of sections) {
        if (!ref) continue;
        const location = ref.slice(0, ref.lastIndexOf("/"));
        if (seen.has(location)) continue;
        seen.add(location);
        out.push(location.split("/"));
    }
    return out;
}

/** Refs among `sections` that no longer name a section in `locations`. */
export function missingRefs(locations, sections) {
    const known = new Set();
    walk(locations, "", (node, path) => {
        for (const section of node.sections || []) known.add(`${path}/${section.name ?? ""}`);
    });
    return sections.filter((section) => !known.has(section.ref)).map((section) => section.ref);
}
