import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const MAPS_JSON = "maps/maps.json";
export const LOCATIONS_JSON = "locations/locations.json";
export const IMAGE_EXTENSIONS = [".png", ".gif", ".jpg", ".jpeg"];
const LAYOUT_ROOTS = ["tracker_default", "tracker_horizontal", "tracker_vertical", "tracker_broadcast"];

/** Same layout as `dumps` in gen/gen_access_rules.py, so files round-trip byte for byte. */
export function dumps(value, indent = 0) {
    const pad = " ".repeat(indent);
    const inner = " ".repeat(indent + 4);
    if (Array.isArray(value)) {
        if (!value.length) return "[]";
        if (value.every((item) => typeof item === "string" || typeof item === "number")) {
            return "[" + value.map((item) => JSON.stringify(item)).join(", ") + "]";
        }
        return "[\n" + value.map((item) => inner + dumps(item, indent + 4)).join(",\n") + "\n" + pad + "]";
    }
    if (value !== null && typeof value === "object") {
        const keys = Object.keys(value);
        if (!keys.length) return "{}";
        return "{\n" + keys.map((key) => `${inner}${JSON.stringify(key)}: ${dumps(value[key], indent + 4)}`).join(",\n")
            + "\n" + pad + "}";
    }
    return JSON.stringify(value);
}

function stringEnd(text, start) {
    let i = start + 1;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    return i + 1;
}

/** Parses PopTracker-style JSON: `//` and block comments, trailing commas. */
export function parseJsonc(text) {
    let bare = "";
    for (let i = 0; i < text.length;) {
        if (text[i] === '"') {
            const end = stringEnd(text, i);
            bare += text.slice(i, end);
            i = end;
        } else if (text.startsWith("//", i)) {
            const end = text.indexOf("\n", i);
            i = end < 0 ? text.length : end;
        } else if (text.startsWith("/*", i)) {
            const end = text.indexOf("*/", i + 2);
            i = end < 0 ? text.length : end + 2;
        } else {
            bare += text[i++];
        }
    }
    let out = "";
    for (let i = 0; i < bare.length;) {
        if (bare[i] === '"') {
            const end = stringEnd(bare, i);
            out += bare.slice(i, end);
            i = end;
        } else if (bare[i] === "," && /^\s*[}\]]/.test(bare.slice(i + 1, i + 200))) {
            i++;
        } else {
            out += bare[i++];
        }
    }
    return JSON.parse(out);
}

/** Resolves a pack-relative path, refusing anything that escapes the pack root. */
export function resolveInside(root, relative) {
    if (typeof relative !== "string" || !relative || relative.includes("\0") || path.isAbsolute(relative)) {
        throw new PackError(400, `bad path ${JSON.stringify(relative)}`);
    }
    const full = path.resolve(root, relative);
    const rel = path.relative(root, full);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new PackError(400, `path escapes the pack: ${relative}`);
    return full;
}

export class PackError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const SAFE_SEGMENT = /^[A-Za-z0-9 _.()'\[\],&+-]+$/;

/** ASCII file name for an uploaded image; pack file names stay ASCII. */
export function sanitizeImageName(name) {
    const ascii = String(name).normalize("NFD").replace(/[̀-ͯ]/g, "");
    const ext = path.extname(ascii).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) throw new PackError(400, `images must be one of ${IMAGE_EXTENSIONS.join(" ")}`);
    const stem = path.basename(ascii, path.extname(ascii)).replace(/[^A-Za-z0-9 _.()'\[\],&+-]/g, "_").trim();
    if (!stem || /^\.+$/.test(stem)) throw new PackError(400, "empty image name");
    return stem + ext;
}

function imageDir(dir) {
    const segments = String(dir || "images/maps").replace(/\\/g, "/").split("/").filter(Boolean);
    if (segments[0] !== "images" || segments.some((s) => !SAFE_SEGMENT.test(s) || /^\.+$/.test(s))) {
        throw new PackError(400, `images go in a plain folder under images/, not ${JSON.stringify(dir)}`);
    }
    return segments.join("/");
}

function findNode(tree, names) {
    let level = tree;
    let node;
    for (const name of names) {
        node = (level || []).find((child) => child.name === name);
        if (!node) return null;
        level = node.children;
    }
    return node;
}

async function writeAtomic(file, text) {
    const temp = `${file}.mapper-tmp`;
    await writeFile(temp, text, "utf8");
    try {
        await rename(temp, file);
    } catch (error) {
        if (error.code !== "EPERM" && error.code !== "EBUSY") throw error;
        // Windows refuses the replace while another process holds the file open.
        await writeFile(file, text, "utf8");
        await rm(temp, { force: true });
    }
}

async function listImages(root) {
    const found = [];
    async function walk(dir) {
        let entries;
        try {
            entries = await readdir(path.join(root, dir), { withFileTypes: true });
        } catch (error) {
            if (error.code === "ENOENT") return;
            throw error;
        }
        for (const entry of entries) {
            const rel = dir ? `${dir}/${entry.name}` : entry.name;
            if (entry.isDirectory()) await walk(rel);
            else if (IMAGE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) found.push(rel);
        }
    }
    await walk("images");
    return found.sort();
}

/**
 * Map hierarchy as laid out by nested `tabbed` nodes, starting from the tracker root layouts.
 *
 * Returns a list of `{title, children}` tab nodes and `{map}` leaves.
 */
export function layoutTree(layouts) {
    const seen = new Set();
    function walk(node, out) {
        if (Array.isArray(node)) {
            node.forEach((item) => walk(item, out));
            return out;
        }
        if (!node || typeof node !== "object") return out;
        if (node.type === "tabbed") {
            for (const tab of node.tabs || []) {
                const children = walk(tab.content, []);
                if (children.length) out.push({ title: tab.title ?? "", children });
            }
        } else if (node.type === "map") {
            for (const map of node.maps || []) out.push({ map });
        } else if (node.type === "layout") {
            if (node.key in layouts && !seen.has(node.key)) {
                seen.add(node.key);
                walk(layouts[node.key], out);
            }
        } else {
            walk(node.content, out);
        }
        return out;
    }
    const roots = LAYOUT_ROOTS.filter((key) => key in layouts);
    const tree = [];
    for (const key of roots.length ? roots : Object.keys(layouts)) {
        if (seen.has(key)) continue;
        seen.add(key);
        walk(layouts[key], tree);
    }
    return tree;
}

async function readLayouts(root) {
    const layouts = {};
    let names;
    try {
        names = await readdir(path.join(root, "layouts"));
    } catch (error) {
        if (error.code === "ENOENT") return layouts;
        throw error;
    }
    for (const name of names.filter((n) => /\.jsonc?$/.test(n)).sort()) {
        Object.assign(layouts, parseJsonc(await readFile(path.join(root, "layouts", name), "utf8")));
    }
    return layouts;
}

export async function readPack(root) {
    const [maps, locations, layouts, images, manifest] = await Promise.all([
        readFile(path.join(root, MAPS_JSON), "utf8").then(JSON.parse),
        readFile(path.join(root, LOCATIONS_JSON), "utf8").then(JSON.parse),
        readLayouts(root),
        listImages(root),
        readFile(path.join(root, "manifest.json"), "utf8").then(parseJsonc).catch(() => ({})),
    ]);
    return {
        name: manifest.name ?? path.basename(root),
        minVersion: manifest.min_poptracker_version ?? null,
        maps, locations, layoutTree: layoutTree(layouts), images,
    };
}

/**
 * Applies the mapper's edits onto the files as they are on disk now, so a generator run in between keeps its changes.
 *
 * Args:
 *     patch: `locations` lists `{path, map_locations}` by node name chain (null or [] drops the key);
 *         `maps` lists `{name, entry}` (null entry removes that map, otherwise replaced in place or appended).
 *
 * Returns:
 *     `{missing}`: location paths that no longer exist on disk and were skipped.
 */
export async function applyPatch(root, { locations = [], maps = [] }) {
    const missing = [];
    if (locations.length) {
        const file = path.join(root, LOCATIONS_JSON);
        const tree = JSON.parse(await readFile(file, "utf8"));
        for (const { path: names, map_locations: markers } of locations) {
            const node = Array.isArray(names) && findNode(tree, names);
            if (!node) {
                missing.push(Array.isArray(names) ? names.join("/") : String(names));
                continue;
            }
            if (markers?.length) node.map_locations = markers;
            else delete node.map_locations;
        }
        await writeAtomic(file, dumps(tree) + "\n");
    }
    if (maps.length) {
        const file = path.join(root, MAPS_JSON);
        const list = JSON.parse(await readFile(file, "utf8"));
        for (const { name, entry } of maps) {
            const index = list.findIndex((map) => map.name === name);
            if (entry && index >= 0) list[index] = entry;
            else if (entry) list.push(entry);
            else if (index >= 0) list.splice(index, 1);
        }
        await writeAtomic(file, dumps(list) + "\n");
    }
    return { missing };
}

export async function saveImage(root, dir, name, bytes, overwrite) {
    const relative = `${imageDir(dir)}/${sanitizeImageName(name)}`;
    const full = resolveInside(root, relative);
    if (!overwrite) {
        const existing = await stat(full).catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
        if (existing) throw Object.assign(new PackError(409, `${relative} already exists`), { path: relative });
    }
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, bytes);
    return relative;
}
