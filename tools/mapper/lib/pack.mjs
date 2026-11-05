import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { eachTab, layoutTree } from "../public/layout.mjs";

export const MAPS_JSON = "maps/maps.json";
export const LOCATIONS_JSON = "locations/locations.json";
export const IMAGE_EXTENSIONS = [".png", ".gif", ".jpg", ".jpeg"];
const LAYOUT_WIDTH = 80;

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

const textWidth = (text) => [...text].length;

function flat(value) {
    if (Array.isArray(value)) {
        const items = value.map(flat);
        return items.includes(null) ? null : `[${items.join(", ")}]`;
    }
    if (value !== null && typeof value === "object") return Object.keys(value).length ? null : "{}";
    return JSON.stringify(value);
}

/** Prettier's JSON style, which the hand-edited layouts use: objects expanded, arrays on one line when they fit. */
export function formatLayout(value, unit = "    ", width = LAYOUT_WIDTH) {
    function print(node, indent, column, after) {
        const inner = indent + unit;
        if (Array.isArray(node)) {
            const line = flat(node);
            const forced = node.length > 1 && node.every((item) => Array.isArray(item) && item.length > 1);
            if (line !== null && !forced && column + textWidth(line) + after <= width) return line;
            return "[\n" + node.map((item, i) => inner + print(item, inner, textWidth(inner), i < node.length - 1 ? 1 : 0))
                .join(",\n") + "\n" + indent + "]";
        }
        if (node !== null && typeof node === "object") {
            const keys = Object.keys(node);
            if (!keys.length) return "{}";
            return "{\n" + keys.map((key, i) => {
                const head = `${inner}${JSON.stringify(key)}: `;
                return head + print(node[key], inner, textWidth(head), i < keys.length - 1 ? 1 : 0);
            }).join(",\n") + "\n" + indent + "}";
        }
        return JSON.stringify(node);
    }
    return print(value, "", 0, 0);
}

/** `value` formatted like `original`: same indent unit, line endings and final newline. */
function layoutText(value, original) {
    const unit = /\n([ \t]+)\S/.exec(original)?.[1] ?? "    ";
    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    const text = formatLayout(value, unit).replace(/\n/g, eol);
    return original.endsWith("\n") ? text + eol : text;
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

async function listFiles(root, dir, extensions) {
    const found = [];
    async function walk(rel) {
        let entries;
        try {
            entries = await readdir(path.join(root, rel), { withFileTypes: true });
        } catch (error) {
            if (error.code === "ENOENT") return;
            throw error;
        }
        for (const entry of entries) {
            const child = `${rel}/${entry.name}`;
            if (entry.isDirectory()) await walk(child);
            else if (extensions.includes(path.extname(entry.name).toLowerCase())) found.push(child);
        }
    }
    await walk(dir);
    return found.sort();
}

/** Layout files in load order; a key defined twice resolves to the last file, as in `readLayouts`. */
async function readLayoutFiles(root) {
    const names = await listFiles(root, "layouts", [".json", ".jsonc"]);
    return Promise.all(names.map(async (rel) => {
        const text = await readFile(path.join(root, rel), "utf8");
        return { rel, text, value: parseJsonc(text) };
    }));
}

async function readLayouts(root) {
    return Object.assign({}, ...(await readLayoutFiles(root)).map((file) => file.value));
}

/** Tab titles that Lua quotes, since `UiHint("ActivateTab", ...)` finds tabs by title. */
async function tabRefs(root, tree) {
    const titles = new Set();
    eachTab(tree, (tab) => titles.add(tab.title));
    const scripts = await Promise.all((await listFiles(root, "scripts", [".lua"])).map(async (rel) => ({
        rel, text: await readFile(path.join(root, rel), "utf8"),
    })));
    const refs = {};
    for (const title of titles) {
        const files = scripts.filter(({ text }) => text.includes(`"${title}"`) || text.includes(`'${title}'`));
        if (title && files.length) refs[title] = files.map((file) => file.rel);
    }
    return refs;
}

export async function readPack(root) {
    const [maps, locations, layouts, images, manifest] = await Promise.all([
        readFile(path.join(root, MAPS_JSON), "utf8").then(JSON.parse),
        readFile(path.join(root, LOCATIONS_JSON), "utf8").then(JSON.parse),
        readLayouts(root),
        listFiles(root, "images", IMAGE_EXTENSIONS),
        readFile(path.join(root, "manifest.json"), "utf8").then(parseJsonc).catch(() => ({})),
    ]);
    return {
        name: manifest.name ?? path.basename(root),
        minVersion: manifest.min_poptracker_version ?? null,
        maps, locations, layouts, images,
        tabRefs: await tabRefs(root, layoutTree(layouts)),
    };
}

/** Checks every layout edit against the files on disk and returns the texts to write, before anything is written. */
async function layoutWrites(root, edits) {
    if (!edits.length) return [];
    const files = await readLayoutFiles(root);
    const changed = new Set();
    for (const { key, before, after } of edits) {
        const file = files.findLast((candidate) => Object.hasOwn(candidate.value, key));
        if (!file) throw new PackError(409, `layout ${key} is no longer in layouts/; Reload, then redo the tab edits`);
        if (JSON.stringify(file.value[key]) !== JSON.stringify(before)) {
            throw new PackError(409, `${file.rel} changed on disk since it was loaded; Reload, then redo the tab edits`);
        }
        if (!changed.has(file) && layoutText(file.value, file.text) !== file.text) {
            throw new PackError(409, `${file.rel} has comments or formatting the mapper cannot keep; edit its tabs by hand`);
        }
        file.value[key] = after;
        changed.add(file);
    }
    return [...changed].map((file) => [path.join(root, file.rel), layoutText(file.value, file.text)]);
}

/**
 * Applies the mapper's edits onto the files as they are on disk now, so a generator run in between keeps its changes.
 *
 * Args:
 *     patch: `locations` lists `{path, map_locations}` by node name chain (null or [] drops the key);
 *         `maps` lists `{name, entry}` (null entry removes that map, otherwise replaced in place or appended);
 *         `layouts` lists `{key, before, after}`, refused with 409 if the key on disk no longer equals `before`.
 *
 * Returns:
 *     `{missing}`: location paths that no longer exist on disk and were skipped.
 */
export async function applyPatch(root, { locations = [], maps = [], layouts = [] }) {
    const layoutTexts = await layoutWrites(root, layouts);
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
    for (const [file, text] of layoutTexts) await writeAtomic(file, text);
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
