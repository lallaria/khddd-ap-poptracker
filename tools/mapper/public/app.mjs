import * as G from "./geometry.mjs";
import * as L from "./layout.mjs";
import * as S from "./summary.mjs";

const $ = (selector) => document.querySelector(selector);
const canvas = $("#map-canvas");
const ctx = canvas.getContext("2d");

// PopTracker's map defaults (src/core/map.h) and the release that added each marker shape.
const DEFAULT_SIZE = 65;
const DEFAULT_BORDER = 8;
const SHAPES = { rect: null, diamond: "0.26.2", trapezoid: "0.32.0", triangle: "0.36.0", concave_kite: "0.36.0" };
const COLORS = {
    marker: "#4fd17a", hover: "#a8f5c2", selected: "#ffd23f", duplicate: "#ff4d4d",
    old: "#ff2bd6", oldShared: "#ff9f1c", newPoint: "#21e6ff",
};
const ROTATION = { north: 0, east: Math.PI / 2, south: Math.PI, west: -Math.PI / 2 };
const OUTLINES = {
    rect: [[-1, -1], [1, -1], [1, 1], [-1, 1]],
    diamond: [[0, -1], [1, 0], [0, 1], [-1, 0]],
    trapezoid: [[-0.5, -1], [0.5, -1], [1, 1], [-1, 1]],
    triangle: [[0, -1], [1, 1], [-1, 1]],
    concave_kite: [[0, -1], [1, 1], [0, 0.35], [-1, 1]],
};

const state = {
    pack: null,
    tree: [],               // L.layoutTree of pack.layouts
    index: [],              // every location with sections, in tree order
    byKey: new Map(),
    mapName: null,
    lastMap: null,
    sel: null,             // {key, idx}; idx points into the location's map_locations
    picked: new Set(),     // keys of every selected location, sel's included
    anchor: null,          // key that Shift+click ranges start from
    hover: null,
    pointer: null,
    view: { scale: 1, x: 0, y: 0 },
    views: new Map(),
    pendingFit: null,
    baseline: new Map(),    // "loc:<key>" / "map:<name>" / "layout:<key>" / "group:<name>" / "node:<key>" -> JSON as last loaded or saved
    undo: [],
    redo: [],
    visibleLocs: [],
    collapsed: new Set(),
    dragPreview: null,
    align: null,
    editTabs: false,
    lastTabTarget: null,    // label of the place the last tab went
    summaryGroup: "Overworld",
    spaceHeld: false,
    cacheBust: Date.now(),
};
let drag = null;

const clone = (value) => (value === undefined || value === null ? value : structuredClone(value));
const fold = (text) => String(text).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const words = (input) => fold(input.value).split(/\s+/).filter(Boolean);
const matchesWords = (haystack, wanted) => wanted.every((word) => haystack.includes(word));
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((child) => child !== null && child !== undefined));
    return node;
}

function status(text, warn = false) {
    const box = $("#status");
    box.textContent = text;
    box.title = text;
    box.classList.toggle("warning", warn);
}

async function api(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { "X-Mapper": "1", ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw Object.assign(new Error(data.error || response.statusText), { status: response.status, path: data.path });
    }
    return data;
}

// --- pack data ---------------------------------------------------------------------------------

function buildIndex() {
    state.index = [];
    state.byKey = new Map();
    const walk = (nodes, names) => {
        for (const node of nodes || []) {
            if (typeof node?.name !== "string") continue;
            const path = [...names, node.name];
            if (Array.isArray(node.sections)) {
                const checks = node.sections.map((section) => section.name ?? section.ref ?? "");
                const entry = {
                    node, path, key: JSON.stringify(path), region: path[0],
                    label: path.length > 1 ? path.slice(1).join(" / ") : path[0],
                    search: fold(`${path.join(" / ")}\n${checks.join("\n")}`),
                };
                state.index.push(entry);
                state.byKey.set(entry.key, entry);
            }
            walk(node.children, path);
        }
    };
    walk(state.pack.locations, []);
    state.picked = new Set([...state.picked].filter((key) => state.byKey.has(key)));
}

function nodeAt(names) {
    let level = state.pack.locations;
    let node = null;
    for (const name of names) {
        node = (level || []).find((child) => child.name === name);
        if (!node) return null;
        level = node.children;
    }
    return node;
}

/** Name of the sibling right after the location at `names`, which a new or restored one is put before. */
function besideOf(names) {
    const siblings = nodeAt(names.slice(0, -1))?.children ?? [];
    const index = siblings.findIndex((node) => node.name === names.at(-1));
    return index >= 0 ? siblings[index + 1]?.name ?? null : null;
}

function applyPack(pack) {
    state.pack = pack;
    state.tree = L.layoutTree(pack.layouts);
    buildIndex();
    if (!currentMap()) {
        const known = new Set(pack.maps.map((map) => map.name));
        state.mapName = null;
        const first = L.layoutMaps(state.tree).find((name) => known.has(name)) ?? pack.maps[0]?.name;
        if (first) openMap(first);
    }
    if (state.sel && !state.byKey.has(state.sel.key)) state.sel = null;
    $("#pack-name").textContent = pack.name;
    refreshAll();
}

const currentMap = () => state.pack?.maps.find((map) => map.name === state.mapName);
const onMap = (entry, name) => (entry.node.map_locations || []).some((m) => m.map === name);

function markersOn(name) {
    const out = [];
    for (const entry of state.index) {
        (entry.node.map_locations || []).forEach((m, idx) => {
            if (m.map === name) out.push({ entry, idx, m });
        });
    }
    return out;
}

function markerStyle(map, m = {}) {
    return {
        size: m.size ?? map.location_size ?? DEFAULT_SIZE,
        border: m.border_thickness ?? map.location_border_thickness ?? DEFAULT_BORDER,
        shape: m.shape ?? map.location_shape ?? "rect",
        orientation: map.location_orientation ?? "north",
    };
}

function versionLess(a, b) {
    const pa = String(a).split(".").map(Number);
    const pb = String(b).split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
    }
    return false;
}

// --- edits, undo, save -------------------------------------------------------------------------

const changeId = (change) => `${change.type}:${change.type === "map" ? change.name : change.key}`;

function currentValue(id) {
    const [type, ...rest] = id.split(":");
    const ref = rest.join(":");
    if (type === "loc") return state.byKey.get(ref)?.node.map_locations;
    if (type === "layout") return state.pack.layouts[ref];
    if (type === "group") return state.pack.locations.find((node) => node.name === ref);
    if (type === "node") return nodeAt(JSON.parse(ref));
    return state.pack.maps.find((m) => m.name === ref);
}

/** A group or node as it is on disk: `value` with the unsaved marker edits below it undone. */
function asSaved(change, value) {
    if (!value || (change.type !== "group" && change.type !== "node")) return value;
    const root = change.type === "group" ? [change.key] : JSON.parse(change.key);
    const copy = clone(value);
    for (const [id, json] of state.baseline) {
        if (!id.startsWith("loc:")) continue;
        const names = JSON.parse(id.slice(4));
        if (names.length < root.length || root.some((name, i) => names[i] !== name)) continue;
        let node = copy;
        for (const name of names.slice(root.length)) node = node?.children?.find((child) => child.name === name);
        if (!node) continue;
        const markers = JSON.parse(json);
        if (markers?.length) node.map_locations = markers;
        else delete node.map_locations;
    }
    return copy;
}

function applyChange(change, value) {
    const id = changeId(change);
    if (!state.baseline.has(id)) state.baseline.set(id, JSON.stringify(asSaved(change, currentValue(id)) ?? null));
    if (change.type === "loc") {
        const entry = state.byKey.get(change.key);
        if (!entry) return;
        if (value?.length) entry.node.map_locations = clone(value);
        else delete entry.node.map_locations;
    } else if (change.type === "layout") {
        state.pack.layouts[change.key] = clone(value);
        state.tree = L.layoutTree(state.pack.layouts);
    } else if (change.type === "group") {
        const list = state.pack.locations;
        const index = list.findIndex((node) => node.name === change.key);
        if (value && index >= 0) list[index] = clone(value);
        else if (value) list.push(clone(value));
        else if (index >= 0) list.splice(index, 1);
        buildIndex();
        if (state.sel && !state.byKey.has(state.sel.key)) state.sel = null;
    } else if (change.type === "node") {
        const names = JSON.parse(change.key);
        const parent = nodeAt(names.slice(0, -1));
        if (!parent) return;
        const siblings = parent.children ?? [];
        const index = siblings.findIndex((node) => node.name === names.at(-1));
        if (value && index >= 0) {
            siblings[index] = clone(value);
        } else if (value) {
            const at = siblings.findIndex((node) => node.name === change.beside);
            siblings.splice(at < 0 ? siblings.length : at, 0, clone(value));
            parent.children = siblings;
        } else if (index >= 0) {
            siblings.splice(index, 1);
        }
        buildIndex();
        if (state.sel && !state.byKey.has(state.sel.key)) state.sel = null;
    } else {
        const maps = state.pack.maps;
        const index = maps.findIndex((m) => m.name === change.name);
        if (value && index >= 0) maps[index] = clone(value);
        else if (value) maps.push(clone(value));
        else if (index >= 0) maps.splice(index, 1);
    }
}

function dirty() {
    const changed = { loc: [], map: [], layout: [], group: [], node: [] };
    for (const [id, json] of state.baseline) {
        if (JSON.stringify(currentValue(id) ?? null) === json) continue;
        const [type, ...rest] = id.split(":");
        changed[type].push(rest.join(":"));
    }
    return changed;
}

const dirtyCount = (changed = dirty()) => Object.values(changed).reduce((sum, list) => sum + list.length, 0);

function describe(changed) {
    const parts = [["loc", "location"], ["node", "grouped location"], ["group", "summary group"], ["map", "map"], ["layout", "layout"]]
        .filter(([type]) => changed[type].length).map(([type, word]) => plural(changed[type].length, word));
    return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0] ?? "nothing";
}

/** Records one undo step; a repeated `tag` within 1.5 s (arrow-key nudges) extends the previous step. */
function commit(changes, label, tag) {
    changes = changes.filter((c) => JSON.stringify(c.before ?? null) !== JSON.stringify(c.after ?? null));
    if (!changes.length) return;
    const last = state.undo.at(-1);
    if (tag && last?.tag === tag && performance.now() - last.time < 1500) {
        for (const change of changes) {
            const previous = last.changes.find((p) => changeId(p) === changeId(change));
            if (previous) previous.after = change.after;
            else last.changes.push(change);
        }
        last.label = label;
        last.time = performance.now();
    } else {
        state.undo.push({ label, changes, tag, time: performance.now() });
    }
    state.redo = [];
    changes.forEach((change) => applyChange(change, change.after));
    status(label);
    refreshAll();
}

function undo() {
    if (state.align) {
        state.align.pairs.pop();
        refitAlign();
        return;
    }
    const step = state.undo.pop();
    if (!step) return;
    [...step.changes].reverse().forEach((change) => applyChange(change, change.before));
    state.redo.push(step);
    afterHistory(`Undid: ${step.label}`);
}

function redo() {
    if (state.align) return;
    const step = state.redo.pop();
    if (!step) return;
    step.changes.forEach((change) => applyChange(change, change.after));
    state.undo.push(step);
    afterHistory(`Redid: ${step.label}`);
}

function afterHistory(label) {
    if (!currentMap()) {
        const known = new Set(state.pack.maps.map((map) => map.name));
        const fallback = [state.lastMap, ...L.layoutMaps(state.tree), state.pack.maps[0]?.name].find((name) => known.has(name));
        state.mapName = null;
        if (fallback) openMap(fallback);
    }
    if (state.sel) select(state.sel.key, null, state.picked);
    status(label);
    refreshAll();
}

async function save() {
    const changed = dirty();
    if (!dirtyCount(changed)) {
        status("Nothing to save.");
        return;
    }
    $("#btn-save").disabled = true;
    try {
        const groups = new Set(changed.group);
        // a changed group or node is written whole, markers included
        const nodes = changed.node.filter((key) => !groups.has(JSON.parse(key)[0]));
        const whole = new Set(nodes);
        const patch = {
            locations: changed.loc.filter((key) => !groups.has(JSON.parse(key)[0]) && !whole.has(key) && state.byKey.has(key)).map((key) => ({
                path: JSON.parse(key), map_locations: state.byKey.get(key)?.node.map_locations ?? null,
            })),
            groups: changed.group.map((name) => ({
                name, before: JSON.parse(state.baseline.get(`group:${name}`)), after: currentValue(`group:${name}`) ?? null,
            })),
            nodes: nodes.map((key) => ({
                path: JSON.parse(key), before: JSON.parse(state.baseline.get(`node:${key}`)),
                after: currentValue(`node:${key}`) ?? null, beside: besideOf(JSON.parse(key)),
            })),
            maps: changed.map.map((name) => ({ name, entry: state.pack.maps.find((m) => m.name === name) ?? null })),
            layouts: changed.layout.map((key) => ({
                key, before: JSON.parse(state.baseline.get(`layout:${key}`)), after: state.pack.layouts[key],
            })),
        };
        const result = await api("/api/save", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
        });
        state.baseline.clear();
        applyPack(result.pack);
        if (result.missing.length) {
            status(`Saved, but these locations are gone from disk and were skipped: ${result.missing.join(", ")}`, true);
        } else {
            status(`Saved ${describe(changed)}.`);
        }
    } catch (error) {
        status(`Save failed: ${error.message}`, true);
    } finally {
        renderToolbar();
    }
}

async function reload() {
    if (dirtyCount() && !confirm("Discard unsaved changes and reload from disk?")) return;
    state.baseline.clear();
    state.undo = [];
    state.redo = [];
    state.cacheBust = Date.now();
    images.clear();
    applyPack(await api("/api/pack"));
    status("Reloaded from disk.");
}

// --- placing markers ---------------------------------------------------------------------------

function activeIndex(entry) {
    const list = entry.node.map_locations || [];
    if (state.sel?.key === entry.key && state.sel.idx !== null && list[state.sel.idx]?.map === state.mapName) {
        return state.sel.idx;
    }
    return list.findIndex((m) => m.map === state.mapName);
}

function nextUnplaced(fromKey, dir) {
    const list = state.visibleLocs;
    const n = list.length;
    let i = list.findIndex((entry) => entry.key === fromKey);
    if (i < 0) i = dir > 0 ? -1 : 0;
    for (let step = 1; step <= n; step++) {
        const entry = list[(((i + dir * step) % n) + n) % n];
        if (entry.key !== fromKey && !onMap(entry, state.mapName)) return entry;
    }
    return null;
}

function placeAt(entry, x, y, add) {
    const before = clone(entry.node.map_locations);
    const after = clone(before) ?? [];
    let idx = add ? -1 : activeIndex(entry);
    const placing = idx < 0;
    const next = placing && !add && $("#auto-advance").checked ? nextUnplaced(entry.key, 1) : null;
    if (placing) {
        after.push({ map: state.mapName, x, y });
        idx = after.length - 1;
    } else {
        after[idx] = { ...after[idx], x, y };
    }
    commit([{ type: "loc", key: entry.key, before, after }], `${placing ? "Placed" : "Moved"} ${entry.node.name} at ${x}, ${y}`);
    if (next) {
        select(next.key);
        status(`Placed ${entry.node.name} at ${x}, ${y}. Next: ${next.path.join(" / ")}`);
    } else {
        select(entry.key, idx);
    }
}

function moveMarker(entry, idx, x, y) {
    const before = clone(entry.node.map_locations);
    const after = clone(before);
    after[idx] = { ...after[idx], x, y };
    commit([{ type: "loc", key: entry.key, before, after }], `Moved ${entry.node.name} to ${x}, ${y}`);
    select(entry.key, idx);
}

function nudge(dx, dy) {
    const entry = state.sel && state.byKey.get(state.sel.key);
    if (!entry) return;
    const idx = activeIndex(entry);
    if (idx < 0) return;
    const before = clone(entry.node.map_locations);
    const after = clone(before);
    after[idx] = { ...after[idx], x: after[idx].x + dx, y: after[idx].y + dy };
    commit([{ type: "loc", key: entry.key, before, after }],
        `Nudged ${entry.node.name} to ${after[idx].x}, ${after[idx].y}`, `nudge:${entry.key}:${idx}`);
    select(entry.key, idx);
}

function removeMarker(entry, idx) {
    const before = clone(entry.node.map_locations);
    const removed = before[idx];
    const after = before.filter((_, i) => i !== idx);
    commit([{ type: "loc", key: entry.key, before, after }], `Removed ${entry.node.name} from ${removed.map}`);
    select(entry.key);
}

function removeActive() {
    const entry = state.sel && state.byKey.get(state.sel.key);
    const idx = entry ? activeIndex(entry) : -1;
    if (idx >= 0) removeMarker(entry, idx);
}

/** Makes `key` the selected location; `picked` keeps more selected with it (by default only `key` is). */
function select(key, idx = null, picked = null) {
    const entry = key === null || key === undefined ? null : state.byKey.get(key);
    if (!entry) {
        state.sel = null;
    } else {
        if (idx === null) idx = (entry.node.map_locations || []).findIndex((m) => m.map === state.mapName);
        state.sel = { key, idx: idx >= 0 ? idx : null };
    }
    state.picked = new Set([...(picked ?? []), ...(state.sel ? [state.sel.key] : [])].filter((k) => state.byKey.has(k)));
    if (!state.sel) state.picked.clear();
    markActiveRows();
    renderDetails();
    updateCursorStyle();
    invalidate();
}

const pickedEntries = () => state.index.filter((entry) => state.picked.has(entry.key));

function togglePick(key) {
    const picked = new Set(state.picked);
    if (picked.delete(key)) select(state.sel?.key === key ? [...picked].at(-1) ?? null : state.sel.key, null, picked);
    else select(key, null, picked.add(key));
}

/** List click: Ctrl toggles a location in the selection, Shift selects the range from the last one clicked. */
function pickRow(entry, event) {
    const toggle = event.ctrlKey || event.metaKey;
    const keys = state.visibleLocs.map((listed) => listed.key);
    const from = event.shiftKey ? keys.indexOf(state.anchor) : -1;
    const to = keys.indexOf(entry.key);
    if (from >= 0 && to >= 0) {
        const picked = new Set(toggle ? state.picked : []);
        for (const key of keys.slice(Math.min(from, to), Math.max(from, to) + 1)) picked.add(key);
        select(entry.key, null, picked);
        return;
    }
    state.anchor = entry.key;
    if (toggle) togglePick(entry.key);
    else select(entry.key);
}

function centerOnSelection(onlyIfHidden) {
    const entry = state.sel && state.byKey.get(state.sel.key);
    const m = entry && state.sel.idx !== null ? entry.node.map_locations[state.sel.idx] : null;
    if (!m || m.map !== state.mapName) return;
    const s = toScreen(m);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (onlyIfHidden && s.x > 40 && s.y > 40 && s.x < w - 40 && s.y < h - 40) return;
    state.view.x += w / 2 - s.x;
    state.view.y += h / 2 - s.y;
    invalidate();
}

function openMap(name) {
    if (state.align) {
        status("Apply or cancel the alignment first.");
        return;
    }
    if (state.mapName) state.views.set(state.mapName, { ...state.view });
    if (state.mapName !== name) state.lastMap = state.mapName;
    state.mapName = name;
    const map = currentMap();
    if (state.sel) select(state.sel.key, null, state.picked);
    const saved = state.views.get(name);
    if (saved) state.view = { ...saved };
    else if (map) state.pendingFit = map.img;
    refreshAll();
}

// --- images ------------------------------------------------------------------------------------

const images = new Map();
const ready = (img) => Boolean(img && img.complete && img.naturalWidth > 0);
const packUrl = (path) => `/pack/${path.split("/").map(encodeURIComponent).join("/")}?v=${state.cacheBust}`;

function image(src) {
    let img = images.get(src);
    if (!img) {
        img = new Image();
        img.onload = () => {
            invalidate();
            renderMapSettings();
        };
        img.onerror = () => status(`Could not load ${src}`, true);
        img.src = src.startsWith("blob:") ? src : packUrl(src);
        images.set(src, img);
    }
    return img;
}

async function loaded(img) {
    if (ready(img)) return img;
    await img.decode().catch(() => {
        throw new Error("That image could not be loaded.");
    });
    return img;
}

async function uploadImage(file, dir, name, overwrite = false) {
    const query = new URLSearchParams({ dir: dir || "images/maps", name: name || file.name, overwrite: overwrite ? "1" : "0" });
    try {
        const { path } = await api(`/api/image?${query}`, { method: "POST", body: file });
        if (overwrite) {
            state.cacheBust = Date.now();
            images.delete(path);
        }
        return path;
    } catch (error) {
        if (error.status !== 409 || overwrite) throw error;
        const users = state.pack.maps.filter((m) => m.img === error.path).map((m) => m.name);
        const question = `${error.path} already exists${users.length ? ` and is used by ${users.join(", ")}` : ""}. `
            + "Overwrite it? Undo cannot bring the old file back.";
        if (!confirm(question)) throw new Error("Upload cancelled.");
        return uploadImage(file, dir, name, true);
    }
}

// --- view and drawing --------------------------------------------------------------------------

const toImage = (sx, sy) => ({ x: (sx - state.view.x) / state.view.scale, y: (sy - state.view.y) / state.view.scale });
const toScreen = (p) => ({ x: p.x * state.view.scale + state.view.x, y: p.y * state.view.scale + state.view.y });

function world() {
    const d = devicePixelRatio || 1;
    const v = state.view;
    ctx.setTransform(d * v.scale, 0, 0, d * v.scale, d * v.x, d * v.y);
}

function screen() {
    const d = devicePixelRatio || 1;
    ctx.setTransform(d, 0, 0, d, 0, 0);
}

function baseImage() {
    if (state.align) return state.align.newImg;
    const map = currentMap();
    return map ? image(map.img) : null;
}

function fitView() {
    const img = baseImage();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!ready(img) || !w || !h) return;
    const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight) * 0.96;
    state.view = { scale, x: (w - img.naturalWidth * scale) / 2, y: (h - img.naturalHeight * scale) / 2 };
    invalidate();
}

function zoomAt(sx, sy, factor) {
    const p = toImage(sx, sy);
    const scale = Math.min(40, Math.max(0.02, state.view.scale * factor));
    state.view = { scale, x: sx - p.x * scale, y: sy - p.y * scale };
    invalidate();
}

let frame = 0;
function invalidate() {
    if (!frame) frame = requestAnimationFrame(draw);
}

function draw() {
    frame = 0;
    const d = devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * d) || canvas.height !== Math.round(h * d)) {
        canvas.width = Math.round(w * d);
        canvas.height = Math.round(h * d);
    }
    if (state.pendingFit && w && ready(image(state.pendingFit))) {
        state.pendingFit = null;
        fitView();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const base = baseImage();
    if (!ready(base)) {
        screen();
        ctx.fillStyle = "#9aa1b2";
        ctx.font = "14px system-ui, sans-serif";
        ctx.fillText(!state.pack ? "Loading pack…" : currentMap() ? "Loading image…" : "No map selected", 16, 28);
        return;
    }
    world();
    ctx.imageSmoothingEnabled = state.view.scale < 2;
    ctx.drawImage(base, 0, 0);
    if (state.align) drawAlign();
    else drawMarkers(currentMap());
    renderCursorText();
}

function outline(style, x, y, half) {
    const points = OUTLINES[style.shape] ?? OUTLINES.rect;
    const r = ROTATION[style.orientation] ?? 0;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    ctx.beginPath();
    points.forEach(([px, py], i) => {
        const X = x + (px * cos - py * sin) * half;
        const Y = y + (px * sin + py * cos) * half;
        if (i) ctx.lineTo(X, Y);
        else ctx.moveTo(X, Y);
    });
    ctx.closePath();
}

function drawMarkerShape(style, p, fill, alpha) {
    ctx.globalAlpha = alpha;
    outline(style, p.x, p.y, style.size / 2 + style.border);
    ctx.fillStyle = "#000";
    ctx.fill();
    outline(style, p.x, p.y, style.size / 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.globalAlpha = 1;
}

function crosshair(p, reach) {
    const px = 1 / state.view.scale;
    ctx.beginPath();
    ctx.moveTo(p.x - reach, p.y);
    ctx.lineTo(p.x + reach, p.y);
    ctx.moveTo(p.x, p.y - reach);
    ctx.lineTo(p.x, p.y + reach);
    ctx.lineWidth = 3 * px;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
    ctx.stroke();
    ctx.lineWidth = px;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
}

function label(text, s, offset) {
    ctx.font = "12px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
    ctx.strokeText(text, s.x + offset, s.y);
    ctx.fillStyle = "#fff";
    ctx.fillText(text, s.x + offset, s.y);
}

function displayPos(hit) {
    const preview = state.dragPreview;
    return preview && preview.key === hit.entry.key && preview.idx === hit.idx ? preview : hit.m;
}

function drawMarkers(map) {
    const hits = markersOn(map.name);
    const spots = new Map();
    for (const hit of hits) spots.set(`${hit.m.x},${hit.m.y}`, (spots.get(`${hit.m.x},${hit.m.y}`) || 0) + 1);
    const selKey = state.sel?.key;
    const isPicked = (h) => state.picked.has(h.entry.key);
    const order = [...hits.filter((h) => !isPicked(h)), ...hits.filter((h) => isPicked(h) && h.entry.key !== selKey),
        ...hits.filter((h) => h.entry.key === selKey)];
    const px = 1 / state.view.scale;
    const isHover = (h) => state.hover?.entry === h.entry && state.hover.idx === h.idx;

    world();
    for (const hit of order) {
        const style = markerStyle(map, hit.m);
        const p = displayPos(hit);
        const selected = isPicked(hit);
        drawMarkerShape(style, p, selected ? COLORS.selected : isHover(hit) ? COLORS.hover : COLORS.marker, selected ? 1 : 0.85);
        if (spots.get(`${hit.m.x},${hit.m.y}`) > 1) {
            outline(style, p.x, p.y, style.size / 2 + style.border + 3 * px);
            ctx.lineWidth = 2.5 * px;
            ctx.strokeStyle = COLORS.duplicate;
            ctx.stroke();
        }
        if (hit.entry.key === selKey && hit.idx === state.sel.idx) crosshair(p, style.size / 2 + style.border + 8 * px);
    }

    const ghostVisible = state.sel && state.pointer && !state.hover && !drag && !state.spaceHeld;
    if (ghostVisible) {
        const q = toImage(state.pointer.x, state.pointer.y);
        const g = { x: Math.round(q.x), y: Math.round(q.y) };
        const entry = state.byKey.get(state.sel.key);
        const idx = entry ? activeIndex(entry) : -1;
        const style = markerStyle(map, idx >= 0 ? entry.node.map_locations[idx] : {});
        drawMarkerShape(style, g, COLORS.selected, 0.5);
        crosshair(g, style.size / 2 + style.border + 8 * px);
    }

    screen();
    for (const hit of order) {
        const selected = isPicked(hit);
        if (!state.labels && !selected && !isHover(hit)) continue;
        const style = markerStyle(map, hit.m);
        const p = displayPos(hit);
        const text = isHover(hit) || selected ? `${hit.entry.node.name} (${p.x}, ${p.y})` : hit.entry.node.name;
        label(text, toScreen(p), (style.size / 2 + style.border) * state.view.scale + 6);
    }
}

function dot(s, radius, color) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#000";
    ctx.stroke();
}

function ring(s, radius, color) {
    ctx.beginPath();
    ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#000";
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.stroke();
}

function cross(s, reach, color) {
    ctx.beginPath();
    ctx.moveTo(s.x - reach, s.y);
    ctx.lineTo(s.x + reach, s.y);
    ctx.moveTo(s.x, s.y - reach);
    ctx.lineTo(s.x, s.y + reach);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#000";
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.stroke();
}

function alignTargets() {
    const al = state.align;
    return new Set([al.mapName, ...($("#al-shared").checked ? al.sharing : [])]);
}

function drawAlign() {
    const al = state.align;
    const t = al.transform;
    if (al.show) {
        world();
        ctx.save();
        ctx.globalAlpha = al.opacity;
        ctx.transform(t.a, t.d, t.b, t.e, t.c, t.f);
        ctx.imageSmoothingEnabled = state.view.scale * G.scaleFactor(t) < 2;
        ctx.drawImage(al.oldImg, 0, 0);
        ctx.restore();
    }
    screen();
    const targets = alignTargets();
    for (const entry of state.index) {
        for (const m of entry.node.map_locations || []) {
            if (targets.has(m.map)) dot(toScreen(G.apply(t, m)), 3.5, m.map === al.mapName ? COLORS.old : COLORS.oldShared);
        }
    }
    al.pairs.forEach((pair, i) => {
        const from = toScreen(G.apply(t, pair.from));
        const to = toScreen(pair.to);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = "#fff";
        ctx.stroke();
        ctx.setLineDash([]);
        ring(from, 7, COLORS.old);
        cross(to, 8, COLORS.newPoint);
        label(String(i + 1), to, 10);
    });
    if (al.pending) {
        const s = toScreen(G.apply(t, al.pending));
        ring(s, 9, COLORS.old);
        label(`${al.pairs.length + 1}?`, s, 12);
    }
}

function renderCursorText() {
    const parts = [];
    if (state.pointer && ready(baseImage())) {
        const p = toImage(state.pointer.x, state.pointer.y);
        parts.push(`x ${Math.round(p.x)}, y ${Math.round(p.y)}`);
    }
    parts.push(`zoom ${Math.round(state.view.scale * 100)}%`);
    $("#cursor-pos").textContent = parts.join(" · ");
}

/** Markers under a screen point, nearest first, the selected location's first among equals. */
function hitsAt(sx, sy) {
    const map = currentMap();
    if (!map || state.align) return [];
    const p = toImage(sx, sy);
    const found = [];
    for (const hit of markersOn(map.name)) {
        const style = markerStyle(map, hit.m);
        const pos = displayPos(hit);
        const half = Math.max(style.size / 2 + style.border, 6 / state.view.scale);
        const dx = Math.abs(p.x - pos.x);
        const dy = Math.abs(p.y - pos.y);
        if (dx > half || dy > half) continue;
        found.push({ hit, distance: dx * dx + dy * dy - (hit.entry.key === state.sel?.key ? 0.5 : 0) });
    }
    return found.sort((a, b) => a.distance - b.distance).map(({ hit }) => hit);
}

const hitTest = (sx, sy) => hitsAt(sx, sy)[0] ?? null;

function updateCursorStyle() {
    let cursor = "default";
    if (drag?.moved && (drag.mode === "pan" || drag.mode === "click" || drag.mode === "pick")) cursor = "grabbing";
    else if (state.spaceHeld) cursor = "grab";
    else if (state.align) cursor = state.align.tool === "move" ? "move" : "crosshair";
    else if (state.hover) cursor = "pointer";
    else if (state.sel) cursor = "crosshair";
    canvas.style.cursor = cursor;
}

// --- canvas input ------------------------------------------------------------------------------

canvas.addEventListener("pointerdown", (event) => {
    canvas.focus();
    try {
        canvas.setPointerCapture(event.pointerId);
    } catch {
        // synthetic events have no active pointer to capture
    }
    const pan = event.button === 1 || event.button === 2 || state.spaceHeld;
    let mode = "pan";
    let hit = null;
    if (!pan && event.button === 0) {
        if (state.align) {
            mode = state.align.tool === "move" ? "layer" : "pick";
        } else {
            const hits = event.altKey ? [] : hitsAt(event.offsetX, event.offsetY);
            // Ctrl+click works through markers stacked on one spot
            hit = (event.ctrlKey || event.metaKey ? hits.find((h) => !state.picked.has(h.entry.key)) : null) ?? hits[0] ?? null;
            mode = hit && !event.shiftKey ? "marker" : "click";
        }
    }
    drag = {
        mode, hit, x: event.offsetX, y: event.offsetY, moved: false, shift: event.shiftKey, ctrl: event.ctrlKey || event.metaKey,
        view: { ...state.view }, transform: state.align && { ...state.align.transform },
    };
});

canvas.addEventListener("pointermove", (event) => {
    state.pointer = { x: event.offsetX, y: event.offsetY };
    if (!drag) {
        const hover = hitTest(event.offsetX, event.offsetY);
        if (hover?.entry !== state.hover?.entry || hover?.idx !== state.hover?.idx) state.hover = hover;
        updateCursorStyle();
        invalidate();
        return;
    }
    const dx = event.offsetX - drag.x;
    const dy = event.offsetY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    if (drag.mode === "marker") {
        const p = toImage(event.offsetX, event.offsetY);
        if (state.sel?.key !== drag.hit.entry.key || state.sel.idx !== drag.hit.idx) select(drag.hit.entry.key, drag.hit.idx);
        state.dragPreview = { key: drag.hit.entry.key, idx: drag.hit.idx, x: Math.round(p.x), y: Math.round(p.y) };
    } else if (drag.mode === "layer") {
        state.align.transform = G.translate(drag.transform, dx / state.view.scale, dy / state.view.scale);
        syncAlignFields();
    } else {
        state.view.x = drag.view.x + dx;
        state.view.y = drag.view.y + dy;
    }
    updateCursorStyle();
    invalidate();
});

canvas.addEventListener("pointerup", (event) => {
    const d = drag;
    drag = null;
    updateCursorStyle();
    if (!d) return;
    if (d.mode === "marker" && d.moved) {
        const preview = state.dragPreview;
        state.dragPreview = null;
        if (preview) moveMarker(d.hit.entry, d.hit.idx, preview.x, preview.y);
        return;
    }
    if (d.moved || d.mode === "pan" || d.mode === "layer") return;
    const p = toImage(event.offsetX, event.offsetY);
    if (d.mode === "pick") {
        pickPoint(p);
    } else if (d.mode === "marker") {
        if (d.ctrl) togglePick(d.hit.entry.key);
        else select(d.hit.entry.key, d.hit.idx);
    } else if (d.ctrl) {
        status("Ctrl+click a marker to add it to the selection, or take it out.");
    } else if (state.picked.size > 1) {
        openGroupDialog({ x: Math.round(p.x), y: Math.round(p.y) });
    } else {
        const entry = state.sel && state.byKey.get(state.sel.key);
        if (entry) placeAt(entry, Math.round(p.x), Math.round(p.y), d.shift);
        else status("Select a location in the list first.");
    }
});

canvas.addEventListener("pointercancel", () => {
    drag = null;
    state.dragPreview = null;
    invalidate();
});

canvas.addEventListener("pointerleave", () => {
    state.pointer = null;
    state.hover = null;
    invalidate();
});

canvas.addEventListener("contextmenu", (event) => event.preventDefault());

canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const raw = event.deltaY || event.deltaX;
    const delta = raw * (event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? 400 : 1);
    const factor = Math.exp(-delta * 0.0015);
    if (state.align && event.ctrlKey) {
        const p = toImage(event.offsetX, event.offsetY);
        state.align.transform = G.scaleAbout(state.align.transform, event.altKey ? 1 : factor, event.shiftKey ? 1 : factor, p);
        syncAlignFields();
        invalidate();
        return;
    }
    zoomAt(event.offsetX, event.offsetY, factor);
}, { passive: false });

new ResizeObserver(() => invalidate()).observe(canvas);

document.addEventListener("keydown", (event) => {
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (ctrl && key === "s") {
        event.preventDefault();
        save();
        return;
    }
    if (document.querySelector("dialog[open]")) return;
    const target = event.target;
    const typing = target.closest?.("input, select, textarea") && !["checkbox", "radio", "range"].includes(target.type);
    if (typing) return;
    if (ctrl && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
    }
    if (ctrl && key === "y") {
        event.preventDefault();
        redo();
        return;
    }
    if (ctrl || event.altKey) return;
    const step = event.shiftKey ? 10 : 1;
    const arrows = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (state.picked.size > 1 && !state.align && (arrows[event.key] || event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        status("Select a single location to nudge or remove its marker.");
        return;
    }
    if (arrows[event.key]) {
        event.preventDefault();
        if (state.align) nudgeLayer(...arrows[event.key]);
        else nudge(...arrows[event.key]);
        return;
    }
    if (event.key === " ") {
        event.preventDefault();
        state.spaceHeld = true;
        updateCursorStyle();
        invalidate();
        return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
        if (!state.align) removeActive();
    } else if (event.key === "Escape") {
        if (state.align) {
            state.align.pending = null;
            renderAlignPanel();
            invalidate();
        } else {
            select(null);
        }
    } else if (key === "n" && !state.align) {
        const next = nextUnplaced(state.sel?.key, event.shiftKey ? -1 : 1);
        if (next) select(next.key);
        else status("Every listed location is on this map.");
    } else if (key === "f") {
        fitView();
    } else if (key === "l") {
        $("#show-labels").checked = !$("#show-labels").checked;
        state.labels = $("#show-labels").checked;
        invalidate();
    } else if (key === "h" && state.align) {
        state.align.show = !state.align.show;
        renderAlignPanel();
        invalidate();
    } else if (event.key === "?") {
        $("#dlg-help").showModal();
    } else {
        return;
    }
    event.preventDefault();
});

document.addEventListener("keyup", (event) => {
    if (event.key === " ") {
        state.spaceHeld = false;
        updateCursorStyle();
        invalidate();
    }
});

window.addEventListener("beforeunload", (event) => {
    if (dirtyCount()) event.preventDefault();
});

// --- panels ------------------------------------------------------------------------------------

function refreshAll() {
    renderToolbar();
    renderMapList();
    renderMapSettings();
    renderLocList();
    renderDetails();
    renderAlignPanel();
    invalidate();
}

function renderToolbar() {
    const changed = dirty();
    const count = dirtyCount(changed);
    const saveButton = $("#btn-save");
    saveButton.disabled = !count;
    saveButton.textContent = count ? `Save (${count})` : "Save";
    saveButton.title = count ? `Write ${describe(changed)} (Ctrl+S)` : "Nothing to save";
    $("#btn-undo").disabled = !state.undo.length;
    $("#btn-undo").title = state.undo.length ? `Undo: ${state.undo.at(-1).label} (Ctrl+Z)` : "Undo (Ctrl+Z)";
    $("#btn-redo").disabled = !state.redo.length;
    $("#btn-redo").title = state.redo.length ? `Redo: ${state.redo.at(-1).label} (Ctrl+Y)` : "Redo (Ctrl+Y)";
    document.title = `${count ? "• " : ""}PopTracker Mapper`;
}

function groupToggle(details, id, filtering) {
    details.addEventListener("toggle", () => {
        if (filtering) return;
        if (details.open) state.collapsed.delete(id);
        else state.collapsed.add(id);
    });
}

function tool(text, title, action, disabled = false) {
    return el("button", {
        type: "button", className: "tool", textContent: text, title, disabled,
        onclick: (event) => {
            event.preventDefault();
            event.stopPropagation();
            action();
        },
    });
}

function tabTools(tab) {
    const tabs = tab.group.tabs;
    const index = tabs.indexOf(tab);
    const inner = tab.children.find((child) => !child.map);
    return el("span", { className: "tools" },
        tool("↑", "Move up", () => shiftTab(tab, -1), index === 0),
        tool("↓", "Move down", () => shiftTab(tab, 1), index === tabs.length - 1),
        tool("+", inner ? "Add a sub-tab" : "Add a sub-tab; what this tab shows now becomes the first sub-tab",
            () => openTabDialog({ mode: "add", target: inner ? { group: inner } : { tab } })),
        tool("✎", "Rename or move this tab", () => openTabDialog({ mode: "edit", tab })),
        tool("✕", "Remove this tab from the layout; its maps stay in maps.json", () => removeTab(tab)));
}

function refsNote(title) {
    const files = state.pack.tabRefs?.[title];
    return files ? `${files.join(", ")} switches to this tab by its title` : "";
}

function renderMapList() {
    const list = $("#map-list");
    const top = list.scrollTop;
    const wanted = words($("#map-filter"));
    const filter = wanted.length > 0;
    const editing = state.editTabs;
    const counts = new Map();
    for (const entry of state.index) {
        for (const m of entry.node.map_locations || []) counts.set(m.map, (counts.get(m.map) || 0) + 1);
    }
    const known = new Set(state.pack.maps.map((map) => map.name));
    const listed = new Set(L.layoutMaps(state.tree));
    const indent = (node, depth) => {
        node.style.paddingLeft = `${8 + depth * 14}px`;
        return node;
    };

    const mapRow = (name, depth, tab, tools) => {
        if (!matchesWords(fold(`${name} ${tab?.title ?? ""}`), wanted)) return [];
        const row = indent(el("div", {
            className: `row${name === state.mapName ? " active" : ""}${known.has(name) ? "" : " missing"}`,
            title: [
                known.has(name) ? `${name}\n${state.pack.maps.find((m) => m.name === name).img}`
                    : `${name} is in a layout but missing from maps.json`,
                tab ? refsNote(tab.title) : "",
            ].filter(Boolean).join("\n"),
        }), depth);
        const text = el("span", { className: "label", textContent: name });
        if (tab && fold(tab.title) !== fold(name)) text.append(el("div", { className: "sub", textContent: `tab: ${tab.title}` }));
        row.append(text, el("span", { className: "badge", textContent: counts.get(name) ?? 0, title: "markers on this map" }));
        if (tools) row.append(tools);
        if (known.has(name)) row.onclick = () => openMap(name);
        return [row];
    };

    const renderTab = (tab, depth, trail) => {
        const tools = editing ? tabTools(tab) : null;
        if (tab.children.length === 1 && tab.children[0].map) return mapRow(tab.children[0].map, depth, tab, tools);
        const path = `${trail}/${tab.title}`;
        const children = build(tab.children, depth + 1, path);
        if (!children.length) {
            if (!editing || L.layoutMaps(tab.children).length || !matchesWords(fold(tab.title), wanted)) return [];
            return [indent(el("div", { className: "row", title: "This tab shows no map" },
                el("span", { className: "label", textContent: tab.title || "(untitled tab)" },
                    el("div", { className: "sub", textContent: "no map" })), tools), depth)];
        }
        const id = `maps:${path}`;
        const details = el("details", { className: "group", open: filter ? true : !state.collapsed.has(id) });
        const summary = indent(el("summary", { title: refsNote(tab.title) },
            el("span", { className: "label", textContent: tab.title || "(untitled tab)" }), tools), depth);
        details.append(summary, ...children);
        groupToggle(details, id, filter);
        return [details];
    };

    const build = (items, depth, trail) => items.flatMap((item) => {
        if (item.map) return mapRow(item.map, depth);
        if (!L.layoutMaps([item]).length) return [];
        const rows = item.tabs.flatMap((tab) => renderTab(tab, depth, trail));
        if (editing && !filter) {
            const add = indent(el("div", { className: "row add", textContent: "+ Add tab…", title: "Add a tab here" }), depth);
            add.onclick = () => openTabDialog({ mode: "add", target: { group: item } });
            rows.push(add);
        }
        return rows;
    });

    const rows = build(state.tree, 0, "");
    const loose = state.pack.maps.map((map) => map.name).filter((name) => !listed.has(name)).flatMap((name) =>
        mapRow(name, 1, null, editing ? el("span", { className: "tools" },
            tool("+", "Put this map in a tab", () => openTabDialog({ mode: "add", map: name }))) : null));
    if (loose.length) {
        const details = el("details", { className: "group", open: true });
        details.append(el("summary", { title: "Maps in maps.json that no layout shows yet" },
            el("span", { className: "label", textContent: "Not in a layout" })), ...loose);
        rows.push(details);
    }
    if (!rows.length) rows.push(el("div", { className: "heading", textContent: "No maps match." }));
    list.replaceChildren(...rows);
    list.scrollTop = top;
    $("#btn-edit-tabs").classList.toggle("on", editing);
    document.querySelector("main").classList.toggle("editing-tabs", editing);
}

function setField(input, value) {
    if (document.activeElement !== input) input.value = value;
}

function renderMapSettings() {
    const map = currentMap();
    $("#map-settings").hidden = !map;
    if (!map) return;
    $("#ms-name").textContent = map.name;
    const img = image(map.img);
    $("#ms-img").textContent = ready(img) ? `${map.img} · ${img.naturalWidth}×${img.naturalHeight}` : map.img;
    setField($("#ms-size"), map.location_size ?? "");
    $("#ms-size").placeholder = DEFAULT_SIZE;
    setField($("#ms-border"), map.location_border_thickness ?? "");
    $("#ms-border").placeholder = DEFAULT_BORDER;
    setField($("#ms-shape"), map.location_shape ?? "rect");
    const warnings = [];
    const needs = SHAPES[map.location_shape];
    if (needs && state.pack.minVersion && versionLess(state.pack.minVersion, needs)) {
        warnings.push(`${map.location_shape} needs PopTracker ${needs}; the pack's min_poptracker_version is ${state.pack.minVersion}.`);
    }
    const spots = new Map();
    for (const { m } of markersOn(map.name)) spots.set(`${m.x},${m.y}`, (spots.get(`${m.x},${m.y}`) || 0) + 1);
    const shared = [...spots.values()].filter((n) => n > 1).reduce((sum, n) => sum + n, 0);
    if (shared) warnings.push(`${shared} markers share a spot with another (red ring); Universal Tracker keeps only one per spot.`);
    $("#ms-warning").hidden = !warnings.length;
    $("#ms-warning").textContent = warnings.join(" ");
    $("#btn-replace").disabled = Boolean(state.align);
    $("#btn-add-map").disabled = Boolean(state.align);
}

function editMap(field, value, label) {
    const map = currentMap();
    if (!map) return;
    const before = clone(map);
    const after = { ...clone(map) };
    if (value === null || value === "" || Number.isNaN(value)) delete after[field];
    else after[field] = value;
    commit([{ type: "map", name: map.name, before, after }], label);
}

function matchesStatus(entry, want) {
    if (want === "here") return onMap(entry, state.mapName);
    if (want === "missing") return !onMap(entry, state.mapName);
    if (want === "nowhere") return !entry.node.map_locations?.length;
    return true;
}

function renderLocList() {
    const list = $("#loc-list");
    const top = list.scrollTop;
    const wanted = words($("#loc-filter"));
    const filter = wanted.length > 0;
    const want = $("#loc-status").value;
    let regions = null;
    if ($("#loc-scope").value === "map") {
        regions = new Set(state.index.filter((entry) => onMap(entry, state.mapName)).map((entry) => entry.region));
    }
    const note = $("#loc-note");
    note.hidden = !(regions && !regions.size);
    note.textContent = "No markers on this map yet, so every region is listed.";
    if (regions && !regions.size) regions = null;

    state.visibleLocs = state.index.filter((entry) =>
        (!regions || regions.has(entry.region)) && matchesWords(entry.search, wanted) && matchesStatus(entry, want));
    const groups = new Map();
    for (const entry of state.visibleLocs) {
        if (!groups.has(entry.region)) groups.set(entry.region, []);
        groups.get(entry.region).push(entry);
    }
    const rows = [];
    for (const [region, entries] of groups) {
        const id = `locs:${region}`;
        const details = el("details", { className: "group", open: filter ? true : !state.collapsed.has(id) });
        const placed = entries.filter((entry) => onMap(entry, state.mapName)).length;
        details.append(el("summary", {},
            el("span", { className: "label", textContent: region }),
            el("span", { className: "badge", textContent: `${placed}/${entries.length}`, title: "on this map / listed" })));
        for (const entry of entries) details.append(locRow(entry));
        groupToggle(details, id, filter);
        rows.push(details);
    }
    if (!rows.length) rows.push(el("div", { className: "heading", textContent: "No locations match." }));
    list.replaceChildren(...rows);
    list.scrollTop = top;
}

function locRow(entry) {
    const markers = entry.node.map_locations || [];
    const here = markers.some((m) => m.map === state.mapName);
    const elsewhere = [...new Set(markers.filter((m) => m.map !== state.mapName).map((m) => m.map))];
    const row = el("div", { className: `row${state.picked.has(entry.key) ? " active" : ""}` });
    row.dataset.key = entry.key;
    row.title = [
        entry.path.join(" / "),
        elsewhere.length ? `On: ${elsewhere.join(", ")}` : "",
        !here && elsewhere.length ? "Double-click to open that map" : "",
    ].filter(Boolean).join("\n");
    row.append(
        el("span", { className: `dot${here ? " here" : elsewhere.length ? " elsewhere" : ""}` }),
        el("span", { className: "label", textContent: entry.label }));
    if (entry.node.sections.length > 1) {
        row.append(el("span", { className: "badge", textContent: plural(entry.node.sections.length, "check") }));
    }
    row.onmousedown = (event) => {
        if (event.shiftKey) event.preventDefault(); // keeps Shift+click from selecting text
    };
    row.onclick = (event) => {
        pickRow(entry, event);
        if (state.picked.size === 1) centerOnSelection(true);
    };
    row.ondblclick = () => {
        if (here || !elsewhere.length) return;
        openMap(elsewhere[0]);
        select(entry.key);
        centerOnSelection(false);
    };
    return row;
}

function markActiveRows() {
    let active = null;
    for (const row of $("#loc-list").querySelectorAll(".row")) {
        row.classList.toggle("active", state.picked.has(row.dataset.key));
        if (row.dataset.key === state.sel?.key) active = row;
    }
    if (active) {
        active.closest("details").open = true;
        active.scrollIntoView({ block: "nearest" });
    }
}

function renderDetails() {
    const box = $("#loc-details");
    const entry = state.sel && state.byKey.get(state.sel.key);
    if (!entry) {
        box.replaceChildren(el("div", { className: "dim small", textContent: "Select a location, then click the map to place it." }));
        return;
    }
    if (state.picked.size > 1) {
        box.replaceChildren(...pickedDetails());
        return;
    }
    const node = entry.node;
    const markers = node.map_locations || [];
    const checks = node.sections.map((s) => s.name ?? (s.ref ? `→ ${s.ref}` : "(unnamed)"));
    const shown = checks.length > 6 ? checks.slice(0, 5) : checks;
    const list = el("ul", { className: "small" }, ...shown.map((check) => el("li", { textContent: check })));
    if (shown.length < checks.length) list.append(el("li", { className: "dim", textContent: `… ${checks.length - shown.length} more` }));

    const table = el("table", { className: "small" });
    markers.forEach((m, idx) => {
        const coordinate = (axis) => {
            const input = el("input", { type: "number", step: 1, value: m[axis], title: axis });
            input.onchange = () => {
                const value = Math.round(Number(input.value));
                if (!Number.isFinite(value)) return;
                const before = clone(entry.node.map_locations);
                const after = clone(before);
                after[idx] = { ...after[idx], [axis]: value };
                commit([{ type: "loc", key: entry.key, before, after }], `Set ${axis} of ${node.name} to ${value}`);
                select(entry.key, idx);
            };
            return input;
        };
        const mapLink = el("button", {
            className: "maplink", textContent: m.map, title: "Open this map",
            onclick: () => {
                openMap(m.map);
                select(entry.key, idx);
                centerOnSelection(false);
            },
        });
        const remove = el("button", { textContent: "✕", title: "Remove this marker", onclick: () => removeMarker(entry, idx) });
        const row = el("tr", { className: m.map === state.mapName ? "current" : "" },
            el("td", {}, mapLink), el("td", {}, coordinate("x")), el("td", {}, coordinate("y")), el("td", {}, remove));
        table.append(row);
    });

    const here = onMap(entry, state.mapName);
    box.replaceChildren(...[
        el("h3", { textContent: node.name }),
        el("div", {
            className: "dim small",
            textContent: entry.path.slice(0, -1).join(" / ") + (node.parent ? ` (parent: ${node.parent})` : ""),
        }),
        el("div", { className: "small", textContent: plural(checks.length, "check") }),
        list,
        ...summaryTools(entry),
        ...ungroupTools(entry),
        markers.length ? table : el("div", { className: "dim small", textContent: "Not on any map yet." }),
        el("div", {
            className: "dim small",
            textContent: (here ? "Click the map to move this marker; Shift+click adds another." : "Click the map to place it here.")
                + " Ctrl+click more locations to group them.",
        }),
    ]);
}

function pickedDetails() {
    const members = pickedEntries();
    const here = members.filter((entry) => onMap(entry, state.mapName)).length;
    const shown = members.length > 8 ? members.slice(0, 7) : members;
    const list = el("ul", { className: "small" }, ...shown.map((entry) => el("li", { textContent: entry.path.join(" / ") })));
    if (shown.length < members.length) list.append(el("li", { className: "dim", textContent: `… ${members.length - shown.length} more` }));
    return [
        el("h3", { textContent: `${members.length} locations selected` }),
        list,
        el("div", {
            className: "dim small",
            textContent: `${here} of them on this map. Click the map to put them in one location there, with a section`
                + " for each check, or use Group to put it where their markers are.",
        }),
        el("div", { className: "buttons" },
            el("button", { textContent: "Clear", onclick: () => select(null) }),
            el("button", { className: "primary", textContent: "Group…", onclick: () => openGroupDialog() })),
    ];
}

// --- layout tabs -------------------------------------------------------------------------------

function targetLabel(target) {
    const where = target.trail.map((title) => title || "(untitled tab)").join(" / ");
    if (target.tab) return `Inside ${where} (makes sub-tabs)`;
    if (where) return `Inside ${where}`;
    return state.tree.filter((item) => !item.map).length > 1 ? `Top level of ${target.group.key}` : "Top level";
}

const targets = (moving = null) => L.tabTargets(state.tree, moving).map((target) => ({ ...target, label: targetLabel(target) }));
const placeName = (place) => place.trail.join(" / ") || "the top level";

/** Remembers a place for the next tab; adding under a tab made it a group, so the next tab goes in that group. */
function rememberPlace(place) {
    state.lastTabTarget = place.tab ? targetLabel({ group: place.tab.group, trail: place.trail }) : place.label;
}

/** Records one undo step for an edit made on a copy of the layouts, plus `extra` changes such as a new map. */
function editLayout(label, edit, extra = []) {
    const next = clone(state.pack.layouts);
    const result = edit(next);
    const changes = Object.keys(next)
        .filter((key) => JSON.stringify(next[key]) !== JSON.stringify(state.pack.layouts[key]))
        .map((key) => ({ type: "layout", key, before: clone(state.pack.layouts[key]), after: next[key] }));
    commit([...extra, ...changes], label);
    return result;
}

function checkTitle(place, title, firstTitle, except = null) {
    if (place.tab && !firstTitle) throw new Error("Give the first sub-tab a title.");
    const taken = place.group ? place.group.tabs.filter((tab) => tab !== except).map((tab) => tab.title) : [firstTitle];
    if (taken.includes(title)) throw new Error(`There is already a tab named ${title} there.`);
}

function confirmRefs(title, verb) {
    const files = state.pack.tabRefs?.[title];
    return !files || confirm(`${files.join(", ")} switches to the tab "${title}" by its title. ${verb} it anyway?`);
}

const foldNote = (group) => `${group.parent.title} had one sub-tab left, so it shows that sub-tab's content directly again.`;

function shiftTab(tab, step) {
    editLayout(`Moved tab ${tab.title} ${step < 0 ? "up" : "down"}`, (next) => L.shiftTab(next, tab, step));
}

function removeTab(tab) {
    const group = tab.group;
    if (group.tabs.length === 1) {
        status(group.parent ? `${tab.title} is the only tab in ${group.parent.title}; remove ${group.parent.title} instead.`
            : `${tab.title} is the only tab in its group.`, true);
        return;
    }
    if (!confirmRefs(tab.title, "Remove")) return;
    const nested = tab.children.some((child) => !child.map);
    if (nested && !confirm(`Remove ${tab.title} and its sub-tabs from the layout? Their maps stay in maps.json.`)) return;
    if (editLayout(`Removed tab ${tab.title}`, (next) => L.removeTab(next, tab))) {
        status(`Removed tab ${tab.title}. ${foldNote(group)}`);
    }
}

function editTab(tab, place, title, firstTitle) {
    const stay = place.group === tab.group;
    if (stay && title === tab.title) return;
    if (!stay && tab.group.tabs.length === 1) {
        const parent = tab.group.parent;
        throw new Error(`${tab.title} is the only tab ${parent ? `in ${parent.title}; move ${parent.title}` : "in its group; move the group"} instead.`);
    }
    checkTitle(place, title, firstTitle, tab);
    if (title !== tab.title && !confirmRefs(tab.title, "Rename")) return;
    const label = stay ? `Renamed tab ${tab.title} to ${title}` : `Moved tab ${title} to ${placeName(place)}`;
    const folded = editLayout(label, (next) => {
        L.renameTab(next, tab, title);
        return !stay && L.moveTab(next, tab, place, firstTitle);
    });
    if (folded) status(`${label}. ${foldNote(tab.group)}`);
}

const tabDialog = $("#dlg-tab");
const tabForm = tabDialog.querySelector("form");
let tabEdit = null;

function openTabDialog({ mode, target = null, tab = null, map = null }) {
    const f = tabForm.elements;
    tabForm.reset();
    const places = targets(mode === "edit" ? tab : null);
    tabEdit = { mode, tab, places };
    f.parent.replaceChildren(...places.map((place, i) => el("option", { value: i, textContent: place.label })));
    const wanted = mode === "edit" ? tab.group : target && (target.group ?? target.tab);
    let index = places.findIndex((place) => (place.group ?? place.tab) === wanted);
    if (index < 0) index = places.findIndex((place) => place.label === state.lastTabTarget);
    f.parent.value = String(Math.max(0, index));
    $("#dt-heading").textContent = mode === "edit" ? `Tab ${tab.title}` : "Add tab";
    $("#dt-map-row").hidden = mode === "edit";
    $("#dt-submit").textContent = mode === "edit" ? "Apply" : "Add tab";
    $("#dt-error").hidden = true;
    if (mode === "add") {
        const listed = new Set(L.layoutMaps(state.tree));
        const names = state.pack.maps.map((m) => m.name);
        const group = (label, list) => list.length
            ? [el("optgroup", { label }, ...list.map((name) => el("option", { value: name, textContent: name })))] : [];
        f.map.replaceChildren(...group("Not in a layout", names.filter((name) => !listed.has(name))),
            ...group("Already in a tab", names.filter((name) => listed.has(name))));
        f.map.value = map ?? names.find((name) => !listed.has(name)) ?? state.mapName ?? names[0] ?? "";
        f.title.value = f.map.value;
        f.title.dataset.auto = "1";
    } else {
        f.title.value = tab.title;
    }
    syncTabDialog();
    tabDialog.showModal();
}

function syncTabDialog() {
    const place = tabEdit.places[tabForm.elements.parent.value];
    $("#dt-first-row").hidden = !place?.tab;
    if (place?.tab) tabForm.elements.first.value = place.tab.title;
}

tabForm.elements.parent.addEventListener("change", syncTabDialog);
tabForm.elements.title.addEventListener("input", () => delete tabForm.elements.title.dataset.auto);
tabForm.elements.map.addEventListener("change", () => {
    if (tabForm.elements.title.dataset.auto) tabForm.elements.title.value = tabForm.elements.map.value;
});
tabForm.querySelector("button[value=cancel]").addEventListener("click", () => tabDialog.close());

tabForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const f = tabForm.elements;
    const place = tabEdit.places[f.parent.value];
    const title = f.title.value.trim();
    const firstTitle = f.first.value.trim();
    try {
        if (!place) throw new Error("Choose where the tab goes.");
        if (!title) throw new Error("Give the tab a title.");
        if (tabEdit.mode === "add") {
            if (!f.map.value) throw new Error("Choose a map.");
            checkTitle(place, title, firstTitle);
            const json = { title, content: { type: "map", maps: [f.map.value] } };
            editLayout(`Added tab ${title} to ${placeName(place)}`, (next) => L.addTab(next, place, json, firstTitle));
        } else {
            editTab(tabEdit.tab, place, title, firstTitle);
        }
        rememberPlace(place);
        tabDialog.close();
    } catch (failure) {
        $("#dt-error").textContent = failure.message;
        $("#dt-error").hidden = false;
    }
});

// --- summary locations -------------------------------------------------------------------------

function groupOf(entry) {
    if (entry.path.length !== 2) return null;
    const group = state.pack.locations.find((node) => node.name === entry.path[0]);
    return S.isSummaryGroup(group) ? group : null;
}

function summaryTools(entry) {
    const group = groupOf(entry);
    if (!group) return [];
    const missing = S.missingRefs(state.pack.locations, entry.node.sections);
    return [
        el("div", { className: "dim small", textContent: `A summary in ${group.name}: its marker shows whether any of these checks is available.` }),
        missing.length ? el("div", {
            className: "warning small", title: missing.join("\n"),
            textContent: `${missing.length} of its sections point at checks that no longer exist; rebuild it.`,
        }) : null,
        el("div", { className: "buttons" },
            el("button", { textContent: "Delete", onclick: () => deleteSummary(entry) }),
            el("button", { textContent: "Rebuild…", onclick: () => openSummaryDialog(entry) })),
    ].filter(Boolean);
}

/** Records one undo step that rewrites a summary group; a group left empty is removed. */
function editGroup(name, edit, label) {
    const current = state.pack.locations.find((node) => node.name === name) ?? null;
    const after = clone(current) ?? { name, children: [] };
    edit(after);
    commit([{ type: "group", key: name, before: clone(current), after: after.children.length ? after : null }], label);
}

function deleteSummary(entry) {
    const [group, name] = entry.path;
    if (!confirm(`Delete the summary location ${name}${entry.node.map_locations?.length ? " and its markers" : ""}?`)) return;
    editGroup(group, (node) => {
        node.children = node.children.filter((child) => child.name !== name);
    }, `Deleted summary ${name}`);
}

function summarySources() {
    const out = [];
    const walk = (items, trail) => {
        for (const item of items) {
            if (item.map) continue;
            for (const tab of item.tabs) {
                const path = [...trail, tab.title || "(untitled tab)"];
                if (L.layoutMaps(tab.children).length) out.push({ tab, label: path.join(" / ") });
                walk(tab.children, path);
            }
        }
    };
    walk(state.tree, []);
    return out;
}

function summaryName(tab) {
    const maps = [...new Set(L.layoutMaps(tab.children))];
    return maps.length === 1 ? maps[0] : tab.title;
}

const subTabs = (tab) => (tab.children.find((child) => !child.map)?.tabs ?? []).filter((sub) => L.layoutMaps(sub.children).length);
const summaryOf = (tab) => S.summarySections(state.pack.locations, L.layoutMaps(tab.children), {
    wholeRegions: summaryForm.elements.scope.value === "regions",
    checks: state.pack.checks && new Set(state.pack.checks),
});

const summaryDialog = $("#dlg-summary");
const summaryForm = summaryDialog.querySelector("form");
let summaryEdit = null;

function openSummaryDialog(entry = null) {
    const f = summaryForm.elements;
    summaryForm.reset();
    const sources = summarySources();
    summaryEdit = { entry, sources };
    f.source.replaceChildren(...sources.map((source, i) => el("option", { value: i, textContent: source.label })));
    const name = entry ? entry.path[1] : state.mapName;
    f.source.value = String(Math.max(0, sources.findIndex((source) => summaryName(source.tab) === name)));
    $("#ds-heading").textContent = entry ? `Rebuild ${entry.path[1]}` : "Add summary location";
    $("#ds-group-row").hidden = Boolean(entry);
    $("#ds-groups").replaceChildren(...state.pack.locations.filter(S.isSummaryGroup).map((node) => el("option", { value: node.name })));
    f.group.value = entry ? entry.path[0] : state.summaryGroup;
    f.name.value = entry ? entry.path[1] : "";
    $("#ds-submit").textContent = entry ? "Rebuild" : "Add";
    $("#ds-error").hidden = true;
    syncSummaryDialog(!entry);
    summaryDialog.showModal();
}

function syncSummaryDialog(renaming) {
    const f = summaryForm.elements;
    const source = summaryEdit.sources[f.source.value];
    const subs = source && !summaryEdit.entry ? subTabs(source.tab) : [];
    $("#ds-each-row").hidden = !subs.length;
    if (!subs.length) f.each.checked = false;
    $("#ds-each-row").lastElementChild.textContent = `One location per sub-tab (${subs.length})`;
    $("#ds-name-row").hidden = f.each.checked;
    if (renaming && source) f.name.value = summaryName(source.tab);
    $("#ds-note").textContent = !source ? "No tab shows a map yet."
        : f.each.checked ? `Adds or rebuilds ${subs.map(summaryName).join(", ")}.`
            : `${plural(summaryOf(source.tab).length, "check")} on ${[...new Set(L.layoutMaps(source.tab.children))].join(", ")}.`;
}

summaryForm.elements.source.addEventListener("change", () => syncSummaryDialog(!summaryEdit.entry));
summaryForm.elements.each.addEventListener("change", () => syncSummaryDialog(false));
summaryForm.elements.scope.addEventListener("change", () => syncSummaryDialog(false));
summaryForm.querySelector("button[value=cancel]").addEventListener("click", () => summaryDialog.close());

summaryForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const f = summaryForm.elements;
    const { entry, sources } = summaryEdit;
    const source = sources[f.source.value];
    try {
        if (!source) throw new Error("Choose a tab.");
        const groupName = entry ? entry.path[0] : f.group.value.trim();
        if (!groupName || groupName.includes("/")) throw new Error("Give the group a name without slashes.");
        const existing = state.pack.locations.find((node) => node.name === groupName);
        if (existing && !S.isSummaryGroup(existing)) {
            throw new Error(`${groupName} holds the pack's own locations; pick another group name.`);
        }
        const tabs = f.each.checked ? subTabs(source.tab) : [source.tab];
        const items = tabs.map((tab) => ({ tab, name: f.each.checked ? summaryName(tab) : f.name.value.trim(), sections: summaryOf(tab) }));
        for (const item of items) {
            if (!item.name || item.name.includes("/")) throw new Error("Give the location a name without slashes.");
            if (!item.sections.length) throw new Error(`No location has a marker on the maps of ${item.tab.title} yet.`);
        }
        const names = items.map((item) => item.name);
        if (new Set(names).size < names.length) throw new Error(`Two sub-tabs would both be named ${names.find((n, i) => names.indexOf(n) !== i)}.`);
        const taken = new Set((existing?.children ?? []).map((child) => child.name));
        if (entry) {
            const [, oldName] = entry.path;
            const [{ name, sections }] = items;
            if (name !== oldName && taken.has(name)) throw new Error(`${groupName} already has a location named ${name}.`);
            editGroup(groupName, (group) => {
                Object.assign(group.children.find((child) => child.name === oldName), { name, sections });
            }, `Rebuilt summary ${name} from ${source.label}`);
            select(JSON.stringify([groupName, name]));
        } else {
            const added = names.filter((name) => !taken.has(name)).length;
            const label = [added && `Added ${plural(added, "summary location")}`, added < names.length && `rebuilt ${names.length - added}`]
                .filter(Boolean).join(", ") + ` in ${groupName}`;
            editGroup(groupName, (group) => {
                for (const { name, sections } of items) {
                    const node = group.children.find((child) => child.name === name);
                    if (node) node.sections = sections;
                    else group.children.push({ name, sections });
                }
            }, label);
            state.summaryGroup = groupName;
            select(JSON.stringify([groupName, names[0]]));
            status(`${label}. Open the overworld map and click it to place ${names[0]}.`);
        }
        summaryDialog.close();
    } catch (failure) {
        $("#ds-error").textContent = failure.message;
        $("#ds-error").hidden = false;
    }
});

// --- grouping locations ------------------------------------------------------------------------

const MARKER_STYLE = ["size", "border_thickness", "shape"];
const groupDialog = $("#dlg-group");
const groupForm = groupDialog.querySelector("form");
let grouping = null;

/** Asks for a name for one location that refers to every check of the selected ones, its marker at `at`. */
function openGroupDialog(at = null) {
    const members = pickedEntries();
    if (members.length < 2) return;
    const spots = members.flatMap((entry) => (entry.node.map_locations || []).filter((m) => m.map === state.mapName));
    const center = (axis) => Math.round(spots.reduce((sum, m) => sum + m[axis], 0) / spots.length);
    const spot = at ?? (spots.length ? { x: center("x"), y: center("y") } : null);
    const parent = members[0].path.slice(0, -1);
    const sections = S.groupSections(members);
    const style = Object.fromEntries(Object.entries(spots[0] ?? {}).filter(([field]) => MARKER_STYLE.includes(field)));
    grouping = { members, parent, sections, marker: spot && { map: state.mapName, ...spot, ...style } };
    groupForm.reset();
    groupForm.elements.name.value = S.sharedName(members.map((entry) => entry.node.name));
    const regions = new Set(members.map((entry) => entry.region));
    $("#dg-note").textContent = [
        `${plural(sections.length, "check")} from ${plural(members.length, "location")}; it goes in ${parent.join(" / ") || "the top level"}.`,
        regions.size > 1 ? `They come from ${regions.size} top-level locations.` : "",
        spot ? `Its marker goes at ${spot.x}, ${spot.y} on ${state.mapName}.` : "None of them is on this map, so click the map to place it afterwards.",
    ].filter(Boolean).join(" ");
    $("#dg-error").hidden = true;
    groupDialog.showModal();
}

groupForm.querySelector("button[value=cancel]").addEventListener("click", () => groupDialog.close());

groupForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const { members, parent, sections, marker } = grouping;
    const name = groupForm.elements.name.value.trim();
    try {
        if (!parent.length) throw new Error("Top-level locations cannot be grouped.");
        const summary = members.find(groupOf);
        if (summary) throw new Error(`${summary.path.join(" / ")} is a summary location; rebuild it instead.`);
        if (!name || name.includes("/")) throw new Error("Give the location a name without slashes.");
        if (!sections.length) throw new Error("None of these locations has a named section.");
        const path = [...parent, name];
        const key = JSON.stringify(path);
        const kept = (entry) => (entry.node.map_locations || []).filter((m) => m.map !== state.mapName);
        // a ref-only location left without markers would be an empty copy of the new one
        const dropped = new Set(members.filter((entry) => entry.path.length > 1 && S.isSummary(entry.node) && !kept(entry).length)
            .map((entry) => entry.key));
        const existing = nodeAt(path);
        if (existing && !dropped.has(key)) throw new Error(`${parent.join(" / ")} already has a location named ${name}.`);
        const node = { name, sections, ...(marker ? { map_locations: [marker] } : {}) };
        const changes = [{ type: "node", key, before: clone(existing), after: node, beside: members[0].node.name }];
        for (const entry of members) {
            if (entry.key === key) continue;
            if (dropped.has(entry.key)) {
                changes.push({ type: "node", key: entry.key, before: clone(entry.node), after: null, beside: besideOf(entry.path) });
            } else {
                changes.push({ type: "loc", key: entry.key, before: clone(entry.node.map_locations), after: kept(entry) });
            }
        }
        const label = `Grouped ${plural(members.length, "location")} into ${name}`;
        commit(changes, label);
        select(key);
        groupDialog.close();
        status(marker ? `${label}.` : `${label}. Click the map to place it.`);
    } catch (failure) {
        $("#dg-error").textContent = failure.message;
        $("#dg-error").hidden = false;
    }
});

function ungroupTools(entry) {
    if (entry.path.length < 2 || !S.isSummary(entry.node) || groupOf(entry)) return [];
    return [el("div", { className: "buttons" }, el("button", {
        textContent: "Ungroup",
        title: "Delete this location and give each location it refers to a marker where this one is",
        onclick: () => ungroup(entry),
    }))];
}

function ungroup(entry) {
    const markers = entry.node.map_locations || [];
    const targets = S.refLocations(entry.node.sections).map((names) => state.byKey.get(JSON.stringify(names))).filter(Boolean);
    const give = markers.length ? ` and give its ${plural(targets.length, "location")} a marker where it is` : "";
    if (!confirm(`Delete ${entry.node.name}${give}?`)) return;
    const changes = [{ type: "node", key: entry.key, before: clone(entry.node), after: null, beside: besideOf(entry.path) }];
    for (const target of targets) {
        const before = clone(target.node.map_locations);
        const after = [...(before ?? []), ...markers.filter((m) => !onMap(target, m.map)).map(clone)];
        changes.push({ type: "loc", key: target.key, before, after });
    }
    commit(changes, `Ungrouped ${entry.node.name}`);
    select(targets[0]?.key ?? null, null, new Set(targets.map((target) => target.key)));
}

// --- adding maps and replacing images ----------------------------------------------------------

const dialog = $("#dlg-image");
const form = dialog.querySelector("form");
let mapPlaces = [];

function fillShapeSelect(select) {
    select.replaceChildren(...Object.entries(SHAPES).map(([shape, version]) =>
        el("option", { value: shape, textContent: version ? `${shape} (PopTracker ${version}+)` : shape })));
}

function openImageDialog(mode) {
    const f = form.elements;
    const map = currentMap();
    form.reset();
    dialog.dataset.mode = mode;
    $("#di-title").textContent = mode === "add" ? "Add map" : `Replace the image of ${map.name}`;
    $("#di-name-row").hidden = mode !== "add";
    $("#di-tab-row").hidden = mode !== "add";
    $("#di-marker-fields").hidden = mode !== "add";
    $("#di-submit").textContent = mode === "add" ? "Add map" : "Align…";
    $("#di-note").textContent = mode === "add"
        ? "The map is appended to the end of maps.json, and gets a tab named after it at the end of the place you pick."
        : "Next you line the old image up with the new one; every marker on this map moves with it.";
    mapPlaces = targets();
    f.tab.replaceChildren(el("option", { value: "", textContent: "Not in a layout yet" }),
        ...mapPlaces.map((place, i) => el("option", { value: i, textContent: place.label })));
    const last = mapPlaces.findIndex((place) => place.label === state.lastTabTarget);
    f.tab.value = last < 0 ? "" : String(last);
    $("#di-error").hidden = true;
    f.existing.replaceChildren(el("option", { value: "", textContent: "choose…" }),
        ...state.pack.images.map((path) => el("option", { value: path, textContent: path })));
    if (map) {
        f.dir.value = map.img.includes("/") ? map.img.slice(0, map.img.lastIndexOf("/")) : "images/maps";
        f.size.value = map.location_size ?? DEFAULT_SIZE;
        f.border.value = map.location_border_thickness ?? DEFAULT_BORDER;
        f.shape.value = map.location_shape ?? "rect";
    }
    dialog.showModal();
}

form.elements.file.addEventListener("change", () => {
    const file = form.elements.file.files[0];
    if (file) form.elements.saveName.value = file.name;
    form.elements.source.value = "file";
});
form.elements.existing.addEventListener("change", () => {
    form.elements.source.value = "existing";
});
form.querySelector("button[value=cancel]").addEventListener("click", () => dialog.close());

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const f = form.elements;
    const error = $("#di-error");
    error.hidden = true;
    const submit = $("#di-submit");
    submit.disabled = true;
    try {
        const file = f.source.value === "file" ? f.file.files[0] : null;
        const existing = f.source.value === "existing" ? f.existing.value : null;
        if (!file && !existing) throw new Error(f.source.value === "file" ? "Choose an image file." : "Choose a pack image.");
        let saveName = f.saveName.value.trim() || file?.name;
        if (file && !/\.[A-Za-z]+$/.test(saveName)) saveName += file.name.slice(file.name.lastIndexOf("."));
        if (dialog.dataset.mode === "add") {
            const name = f.mapName.value.trim();
            if (!name) throw new Error("Give the map a name.");
            if (state.pack.maps.some((m) => m.name === name)) throw new Error(`There is already a map named ${name}.`);
            const place = f.tab.value === "" ? null : mapPlaces[f.tab.value];
            if (place) checkTitle(place, name, place.tab?.title);
            const img = file ? await uploadImage(file, f.dir.value, saveName) : existing;
            const entry = {
                name,
                location_size: Math.max(1, Math.round(Number(f.size.value) || DEFAULT_SIZE)),
                location_border_thickness: Math.max(0, Math.round(Number(f.border.value) || 0)),
                location_shape: f.shape.value,
                img,
            };
            dialog.close();
            const added = { type: "map", name, before: null, after: entry };
            if (place) {
                rememberPlace(place);
                const json = { title: name, content: { type: "map", maps: [name] } };
                editLayout(`Added map ${name} to ${placeName(place)}`, (next) => L.addTab(next, place, json, place.tab?.title), [added]);
            } else {
                commit([added], `Added map ${name}`);
            }
            openMap(name);
        } else {
            const src = file ? URL.createObjectURL(file) : existing;
            await startAlign({ src, file, existing, saveName, dir: f.dir.value });
            dialog.close();
        }
    } catch (failure) {
        error.textContent = failure.message;
        error.hidden = false;
    } finally {
        submit.disabled = false;
    }
});

async function startAlign({ src, file, existing, saveName, dir }) {
    const map = currentMap();
    const oldImg = await loaded(image(map.img));
    const newImg = await loaded(image(src));
    state.views.set(map.name, { ...state.view });
    state.align = {
        mapName: map.name, oldImg, newImg, src, file, existing, saveName, dir,
        transform: G.stretch(oldImg.naturalWidth, oldImg.naturalHeight, newImg.naturalWidth, newImg.naturalHeight),
        pairs: [], pending: null, tool: "move", opacity: 0.5, show: true, model: "scale",
        sharing: state.pack.maps.filter((m) => m.img === map.img && m.name !== map.name).map((m) => m.name),
    };
    state.hover = null;
    $("#al-shared").checked = true;
    $("#al-scale-markers").checked = true;
    fitView();
    refreshAll();
    status(`Aligning ${newImg.naturalWidth}×${newImg.naturalHeight} over the old ${oldImg.naturalWidth}×${oldImg.naturalHeight}; `
        + "the old layer starts stretched to fit.");
}

function exitAlign() {
    const al = state.align;
    if (al.src.startsWith("blob:")) {
        images.delete(al.src);
        URL.revokeObjectURL(al.src);
    }
    state.align = null;
}

function syncAlignFields() {
    const t = state.align.transform;
    setField($("#al-sx"), +t.a.toFixed(5));
    setField($("#al-sy"), +t.e.toFixed(5));
    setField($("#al-tx"), +t.c.toFixed(2));
    setField($("#al-ty"), +t.f.toFixed(2));
    const affine = $("#al-affine");
    affine.hidden = G.isAxisAligned(t);
    affine.textContent = `Rotation/shear terms: ${t.b.toFixed(5)}, ${t.d.toFixed(5)}`;
    $("#al-scale-markers").nextElementSibling.textContent = `Scale marker sizes (×${G.scaleFactor(t).toFixed(3)})`;
    renderPairs();
}

function renderPairs() {
    const al = state.align;
    $("#al-pairs").replaceChildren(...al.pairs.map((pair, i) => {
        const moved = G.apply(al.transform, pair.from);
        const off = Math.hypot(moved.x - pair.to.x, moved.y - pair.to.y);
        return el("li", {},
            el("span", {
                textContent: `(${Math.round(pair.from.x)}, ${Math.round(pair.from.y)}) → `
                    + `(${Math.round(pair.to.x)}, ${Math.round(pair.to.y)}) · off by ${off.toFixed(1)} px`,
            }),
            el("button", {
                textContent: "✕", title: "Remove this pair",
                onclick: () => {
                    al.pairs.splice(i, 1);
                    refitAlign();
                },
            }));
    }));
}

function renderAlignPanel() {
    const al = state.align;
    $("#align-panel").hidden = !al;
    if (!al) return;
    for (const button of $("#align-panel").querySelectorAll("[data-tool]")) {
        button.classList.toggle("on", button.dataset.tool === al.tool);
    }
    $("#al-opacity").value = al.opacity;
    $("#al-show").checked = al.show;
    $("#al-model").value = al.model;
    syncAlignFields();
    $("#al-pending").hidden = !al.pending;
    $("#al-clear").disabled = !al.pairs.length && !al.pending;
    $("#al-shared-row").hidden = !al.sharing.length;
    $("#al-shared").nextElementSibling.textContent = `Also move the markers of ${al.sharing.join(", ")} (same image)`;
}

function refitAlign() {
    const al = state.align;
    const result = G.fit(al.pairs, al.model, al.transform);
    if (result) al.transform = result.transform;
    renderAlignPanel();
    invalidate();
}

function pickPoint(p) {
    const al = state.align;
    if (!al.pending) {
        al.pending = G.apply(G.invert(al.transform), p);
        status("Old landmark picked; now click the same spot on the new image.");
    } else {
        al.pairs.push({ from: al.pending, to: p });
        al.pending = null;
        refitAlign();
        status(al.pairs.length === 1 ? "One pair shifts the layer; add a second to fit the scale."
            : `Fitted from ${plural(al.pairs.length, "pair")}.`);
    }
    renderAlignPanel();
    invalidate();
}

function nudgeLayer(dx, dy) {
    state.align.transform = G.translate(state.align.transform, dx, dy);
    syncAlignFields();
    invalidate();
}

function scaleMarker(value, k, floor) {
    return Math.max(floor, Math.round(value * k));
}

async function applyAlign() {
    const al = state.align;
    $("#al-apply").disabled = true;
    try {
        const path = al.file ? await uploadImage(al.file, al.dir, al.saveName) : al.existing;
        const t = al.transform;
        const k = G.scaleFactor(t);
        const resize = $("#al-scale-markers").checked && Math.abs(k - 1) > 0.005;
        const targets = alignTargets();
        const oldPath = state.pack.maps.find((m) => m.name === al.mapName).img;
        const changes = [];
        for (const name of targets) {
            const before = clone(state.pack.maps.find((m) => m.name === name));
            const after = { ...clone(before), img: path };
            if (resize) {
                after.location_size = scaleMarker(before.location_size ?? DEFAULT_SIZE, k, 1);
                after.location_border_thickness = scaleMarker(before.location_border_thickness ?? DEFAULT_BORDER, k,
                    before.location_border_thickness === 0 ? 0 : 1);
                if ("location_border_strength" in before) after.location_border_strength = scaleMarker(before.location_border_strength, k, 0);
            }
            changes.push({ type: "map", name, before, after });
        }
        let moved = 0;
        for (const entry of state.index) {
            const list = entry.node.map_locations;
            if (!list?.some((m) => targets.has(m.map))) continue;
            const after = list.map((m) => {
                if (!targets.has(m.map)) return clone(m);
                moved++;
                const p = G.apply(t, m);
                const out = { ...clone(m), x: Math.round(p.x), y: Math.round(p.y) };
                if (resize && m.size !== undefined) out.size = scaleMarker(m.size, k, 1);
                if (resize && m.border_thickness !== undefined) out.border_thickness = scaleMarker(m.border_thickness, k, 0);
                if (resize && m.border_strength !== undefined) out.border_strength = scaleMarker(m.border_strength, k, 0);
                return out;
            });
            changes.push({ type: "loc", key: entry.key, before: clone(list), after });
        }
        exitAlign();
        if (path === oldPath) {
            state.cacheBust = Date.now();
            images.delete(path);
        }
        state.views.delete(al.mapName);
        state.pendingFit = path;
        commit(changes, `Replaced the image of ${[...targets].join(", ")}`);
        const unused = !state.pack.maps.some((m) => m.img === oldPath);
        status(`Replaced the image of ${[...targets].join(", ")} and moved ${plural(moved, "marker")}`
            + (resize ? `; marker sizes ×${k.toFixed(3)}` : "")
            + (unused ? `. ${oldPath} is no longer used by any map` : "")
            + ". Save to write the files.");
    } catch (error) {
        status(error.message, true);
    } finally {
        $("#al-apply").disabled = false;
    }
}

function cancelAlign() {
    const name = state.align.mapName;
    exitAlign();
    const saved = state.views.get(name);
    if (saved) state.view = { ...saved };
    refreshAll();
    status("Alignment cancelled.");
}

// --- wiring ------------------------------------------------------------------------------------

fillShapeSelect($("#ms-shape"));
fillShapeSelect(form.elements.shape);

$("#btn-save").onclick = save;
$("#btn-undo").onclick = undo;
$("#btn-redo").onclick = redo;
$("#btn-reload").onclick = () => reload().catch((error) => status(error.message, true));
$("#btn-fit").onclick = fitView;
$("#btn-help").onclick = () => $("#dlg-help").showModal();
$("#help-close").onclick = () => $("#dlg-help").close();
$("#show-labels").onchange = (event) => {
    state.labels = event.target.checked;
    invalidate();
};
$("#btn-add-map").onclick = () => openImageDialog("add");
$("#btn-summary").onclick = () => openSummaryDialog();
$("#btn-edit-tabs").onclick = () => {
    state.editTabs = !state.editTabs;
    renderMapList();
};
$("#btn-replace").onclick = () => openImageDialog("replace");
$("#map-filter").oninput = renderMapList;
$("#loc-filter").oninput = renderLocList;
$("#loc-scope").onchange = renderLocList;
$("#loc-status").onchange = renderLocList;
$("#ms-size").onchange = (event) => editMap("location_size",
    event.target.value === "" ? null : Math.max(1, Math.round(Number(event.target.value))), "Changed marker size");
$("#ms-border").onchange = (event) => editMap("location_border_thickness",
    event.target.value === "" ? null : Math.max(0, Math.round(Number(event.target.value))), "Changed marker border");
$("#ms-shape").onchange = (event) => editMap("location_shape", event.target.value, "Changed marker shape");

for (const button of $("#align-panel").querySelectorAll("[data-tool]")) {
    button.onclick = () => {
        state.align.tool = button.dataset.tool;
        state.align.pending = null;
        renderAlignPanel();
        updateCursorStyle();
        invalidate();
    };
}
$("#al-opacity").oninput = (event) => {
    state.align.opacity = Number(event.target.value);
    invalidate();
};
$("#al-show").onchange = (event) => {
    state.align.show = event.target.checked;
    invalidate();
};
for (const [id, term] of [["#al-sx", "a"], ["#al-sy", "e"], ["#al-tx", "c"], ["#al-ty", "f"]]) {
    $(id).onchange = (event) => {
        const value = Number(event.target.value);
        if (!Number.isFinite(value) || ((term === "a" || term === "e") && value === 0)) return;
        state.align.transform = { ...state.align.transform, [term]: value };
        renderAlignPanel();
        invalidate();
    };
}
$("#al-model").onchange = (event) => {
    state.align.model = event.target.value;
    refitAlign();
};
$("#al-clear").onclick = () => {
    state.align.pairs = [];
    state.align.pending = null;
    renderAlignPanel();
    invalidate();
};
$("#al-shared").onchange = invalidate;
$("#al-apply").onclick = applyAlign;
$("#al-cancel").onclick = cancelAlign;

api("/api/pack").then(applyPack).catch((error) => status(`Could not load the pack: ${error.message}`, true));
