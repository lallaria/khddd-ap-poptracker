export const LAYOUT_ROOTS = ["tracker_default", "tracker_horizontal", "tracker_vertical", "tracker_broadcast"];

/**
 * Map hierarchy as laid out by `tabbed` nodes, starting from the tracker root layouts.
 *
 * Returns a list of `{map}` leaves and tab groups `{key, path, parent, tabs}`, one per `tabbed` node.
 * Each tab is `{title, key, path, group, children}`; `parent` is the tab holding the group, if any.
 * `layouts[key]` followed by `path` reaches the group's or tab's JSON node.
 */
export function layoutTree(layouts) {
    const seen = new Set();
    function walk(node, key, path, parent, out) {
        if (Array.isArray(node)) {
            node.forEach((item, i) => walk(item, key, [...path, i], parent, out));
            return out;
        }
        if (!node || typeof node !== "object") return out;
        if (node.type === "tabbed") {
            const group = { key, path, parent, tabs: [] };
            (node.tabs || []).forEach((tab, i) => {
                const tabPath = [...path, "tabs", i];
                const entry = { title: tab?.title ?? "", key, path: tabPath, group, children: [] };
                walk(tab?.content, key, [...tabPath, "content"], entry, entry.children);
                group.tabs.push(entry);
            });
            out.push(group);
        } else if (node.type === "map") {
            for (const map of node.maps || []) out.push({ map });
        } else if (node.type === "layout") {
            if (node.key in layouts && !seen.has(node.key)) {
                seen.add(node.key);
                walk(layouts[node.key], node.key, [], parent, out);
            }
        } else {
            walk(node.content, key, [...path, "content"], parent, out);
        }
        return out;
    }
    const roots = LAYOUT_ROOTS.filter((key) => key in layouts);
    const tree = [];
    for (const key of roots.length ? roots : Object.keys(layouts)) {
        if (seen.has(key)) continue;
        seen.add(key);
        walk(layouts[key], key, [], null, tree);
    }
    return tree;
}

/** Map names in layout order, repeats included. */
export function layoutMaps(items, out = []) {
    for (const item of items) {
        if (item.map) out.push(item.map);
        else for (const tab of item.tabs) layoutMaps(tab.children, out);
    }
    return out;
}

export function eachTab(items, visit) {
    for (const item of items) {
        if (item.map) continue;
        for (const tab of item.tabs) {
            visit(tab);
            eachTab(tab.children, visit);
        }
    }
}

/** True when the group is its parent tab's whole content, so it can be folded back into that tab. */
export function holdsDirectly(group) {
    const tab = group.parent;
    return Boolean(tab) && tab.key === group.key && group.path.length === tab.path.length + 1
        && group.path.at(-1) === "content";
}

/**
 * Places a tab can be put: `{group, trail}` adds to a group, `{tab, trail}` turns that tab's content into sub-tabs.
 *
 * `trail` is the tab titles leading there. Tabs inside `moving` are left out, as are groups showing no map.
 */
export function tabTargets(tree, moving = null) {
    const out = [];
    const walk = (items, trail) => {
        for (const item of items) {
            if (item.map || !layoutMaps([item]).length) continue;
            out.push({ group: item, trail });
            for (const tab of item.tabs) {
                if (tab === moving) continue;
                const path = [...trail, tab.title];
                if (!tab.children.some((child) => !child.map)) out.push({ tab, trail: path });
                walk(tab.children, path);
            }
        }
    };
    walk(tree, []);
    return out;
}

// The edits below take `layouts` (a copy to change) and nodes of a `layoutTree` built from it.

const resolve = (layouts, ref) => ref.path.reduce((value, step) => value[step], layouts[ref.key]);

/** Adds tab JSON at a `tabTargets` entry; under a tab, its old content becomes the first sub-tab, `firstTitle`. */
export function addTab(layouts, target, json, firstTitle) {
    if (target.group) {
        resolve(layouts, target.group).tabs.push(json);
        return;
    }
    const holder = resolve(layouts, target.tab);
    holder.content = { type: "tabbed", tabs: [{ title: firstTitle, content: holder.content }, json] };
}

function detach(layouts, tab) {
    const group = resolve(layouts, tab.group);
    const json = resolve(layouts, tab);
    const holder = holdsDirectly(tab.group) ? resolve(layouts, tab.group.parent) : null;
    return () => {
        group.tabs.splice(group.tabs.indexOf(json), 1);
        if (!holder || group.tabs.length !== 1) return false;
        holder.content = group.tabs[0].content;
        return true;
    };
}

/** Returns true when a nested group was left with one tab and folded back into its parent tab. */
export const removeTab = (layouts, tab) => detach(layouts, tab)();

/** Moves a tab to a `tabTargets` entry; returns true like `removeTab` when its old group was folded. */
export function moveTab(layouts, tab, target, firstTitle) {
    const json = resolve(layouts, tab);
    const take = detach(layouts, tab);
    addTab(layouts, target, json, firstTitle);
    return take();
}

export function shiftTab(layouts, tab, step) {
    const tabs = resolve(layouts, tab.group).tabs;
    const from = tabs.indexOf(resolve(layouts, tab));
    const to = from + step;
    if (to < 0 || to >= tabs.length) return;
    [tabs[from], tabs[to]] = [tabs[to], tabs[from]];
}

export function renameTab(layouts, tab, title) {
    resolve(layouts, tab).title = title;
}
