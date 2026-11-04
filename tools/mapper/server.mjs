#!/usr/bin/env node
/**
 * PopTracker mapper: a local web UI for placing map_locations and swapping map images.
 *
 * Usage: node tools/mapper/server.mjs [pack dir] [--port 8765] [--no-open]
 * The pack dir defaults to the pack this tool sits in.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { applyPatch, PackError, readPack, resolveInside, saveImage } from "./lib/pack.mjs";

const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));
const MAX_BODY = 64 * 1024 * 1024;
const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
};

async function body(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY) throw new PackError(413, "request too large");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function send(res, status, data, type = "application/json; charset=utf-8") {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(type.startsWith("application/json") ? JSON.stringify(data) : data);
}

async function sendFile(res, file) {
    const type = TYPES[path.extname(file).toLowerCase()];
    if (!type) throw new PackError(404, "not found");
    send(res, 200, await readFile(file), type);
}

export function createServer(root) {
    return http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, "http://localhost");
            const host = (req.headers.host || "").replace(/:\d+$/, "");
            if (host !== "localhost" && host !== "127.0.0.1") throw new PackError(403, "local use only");
            if (req.method === "POST" && req.headers["x-mapper"] !== "1") throw new PackError(403, "missing X-Mapper header");

            if (req.method === "GET" && url.pathname === "/") return await sendFile(res, path.join(PUBLIC, "index.html"));
            if (req.method === "GET" && url.pathname.startsWith("/static/")) {
                return await sendFile(res, resolveInside(PUBLIC, decodeURIComponent(url.pathname.slice(8))));
            }
            if (req.method === "GET" && url.pathname.startsWith("/pack/images/")) {
                const relative = decodeURIComponent(url.pathname.slice("/pack/images/".length));
                return await sendFile(res, resolveInside(path.join(root, "images"), relative));
            }
            if (req.method === "GET" && url.pathname === "/api/pack") return send(res, 200, await readPack(root));
            if (req.method === "POST" && url.pathname === "/api/save") {
                const result = await applyPatch(root, JSON.parse((await body(req)).toString("utf8")));
                return send(res, 200, { ...result, pack: await readPack(root) });
            }
            if (req.method === "POST" && url.pathname === "/api/image") {
                const saved = await saveImage(root, url.searchParams.get("dir"), url.searchParams.get("name"),
                    await body(req), url.searchParams.get("overwrite") === "1");
                return send(res, 200, { path: saved });
            }
            throw new PackError(404, "not found");
        } catch (error) {
            const status = error.status ?? (error.code === "ENOENT" ? 404 : 500);
            if (status === 500) console.error(error);
            send(res, status, { error: error.message, path: error.path });
        }
    });
}

function openBrowser(url) {
    const [command, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    spawn(command, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}

function listen(server, port, attempts = 20) {
    return new Promise((resolve, reject) => {
        server.once("error", (error) => {
            if (error.code === "EADDRINUSE" && attempts > 1) resolve(listen(server, port + 1, attempts - 1));
            else reject(error);
        });
        server.listen(port, "127.0.0.1", () => resolve(server.address().port));
    });
}

async function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: { port: { type: "string", default: "8765" }, "no-open": { type: "boolean", default: false } },
    });
    const root = path.resolve(positionals[0] ?? fileURLToPath(new URL("../..", import.meta.url)));
    await readPack(root);
    const port = await listen(createServer(root), Number(values.port));
    const url = `http://127.0.0.1:${port}/`;
    console.log(`mapping ${root}\nopen ${url}  (Ctrl+C to stop)`);
    if (!values["no-open"]) openBrowser(url);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    main().catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}
