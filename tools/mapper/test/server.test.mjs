import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "../server.mjs";

const PACK = fileURLToPath(new URL("../../..", import.meta.url));

function request(port, method, url, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, method, path: url, headers }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve({ status: res.statusCode, type: res.headers["content-type"], body: Buffer.concat(chunks) }));
        });
        req.on("error", reject);
        req.end(body);
    });
}

describe("server", () => {
    let root;
    let server;
    let port;
    const post = (url, body) => request(port, "POST", url, { headers: { "X-Mapper": "1" }, body });

    before(async () => {
        root = await mkdtemp(path.join(tmpdir(), "mapper-srv-"));
        for (const part of ["manifest.json", "maps", "locations", "layouts"]) {
            await cp(path.join(PACK, part), path.join(root, part), { recursive: true });
        }
        await cp(path.join(PACK, "images", "maps", "Link_Boards.png"), path.join(root, "images", "maps", "Link_Boards.png"));
        await writeFile(path.join(root, "secret.png"), "outside images");
        server = createServer(root);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        port = server.address().port;
    });
    after(async () => {
        await new Promise((resolve) => server.close(resolve));
        await rm(root, { recursive: true, force: true });
    });

    test("serves the page, its modules and the pack", async () => {
        const page = await request(port, "GET", "/");
        assert.equal(page.status, 200);
        assert.match(page.body.toString(), /PopTracker Mapper/);
        const app = await request(port, "GET", "/static/app.mjs");
        assert.equal(app.status, 200);
        assert.match(app.type, /javascript/);
        const pack = JSON.parse((await request(port, "GET", "/api/pack")).body);
        assert.ok(pack.maps.some((map) => map.name === "Link Boards"));
        assert.ok(pack.images.includes("images/maps/Link_Boards.png"));
        const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
        assert.equal(pack.minVersion, manifest.min_poptracker_version);
    });

    test("serves images only from images/", async () => {
        assert.equal((await request(port, "GET", "/pack/images/maps/Link_Boards.png")).status, 200);
        for (const url of ["/pack/images/..%2fsecret.png", "/pack/images/%2e%2e/secret.png", "/pack/manifest.json",
            "/pack/images/..%2f..%2fsecret.png"]) {
            const response = await request(port, "GET", url);
            assert.ok(response.status === 400 || response.status === 404, `${url} gave ${response.status}`);
            assert.notEqual(response.body.toString(), "outside images", url);
        }
    });

    test("refuses foreign hosts and posts without the mapper header", async () => {
        assert.equal((await request(port, "GET", "/api/pack", { headers: { Host: "evil.example" } })).status, 403);
        assert.equal((await request(port, "POST", "/api/save", { body: "{}" })).status, 403);
    });

    test("saves a patch and returns the fresh pack", async () => {
        const response = await post("/api/save", JSON.stringify({
            locations: [{ path: ["World Map [Sora]", "Lord Kyroo Defeated"], map_locations: [{ map: "Link Boards", x: 1, y: 2 }] }],
        }));
        assert.equal(response.status, 200);
        const result = JSON.parse(response.body);
        assert.deepEqual(result.missing, []);
        const node = result.pack.locations.find((n) => n.name === "World Map [Sora]").children
            .find((n) => n.name === "Lord Kyroo Defeated");
        assert.deepEqual(node.map_locations, [{ map: "Link Boards", x: 1, y: 2 }]);
        assert.match(await readFile(path.join(root, "locations", "locations.json"), "utf8"), /"Lord Kyroo Defeated",[^]*?"x": 1,/);
    });

    test("keeps rule fixes and their handoff beside the pack, never in it", async () => {
        const file = path.join(root, "rule-fixes.json");
        const empty = JSON.parse((await request(port, "GET", "/api/fixes")).body);
        assert.deepEqual(empty, { file, markdown: path.join(root, "rule-fixes.md"), fixes: {} });
        const locations = await readFile(path.join(root, "locations", "locations.json"), "utf8");
        const fixes = {
            "Traverse Town [Sora]/Secret Portal/Traverse Town Secret Portal [Sora]": {
                check: "Traverse Town Secret Portal [Sora]", wanted: [["high_jump"]], note: "no world count", was: [],
            },
        };
        const saved = await post("/api/fixes", JSON.stringify({ fixes }));
        assert.equal(saved.status, 200);
        assert.deepEqual(JSON.parse(saved.body).fixes, fixes);
        assert.deepEqual(JSON.parse((await request(port, "GET", "/api/fixes")).body).fixes, fixes);
        assert.match(await readFile(path.join(root, "rule-fixes.md"), "utf8"), /### Traverse Town Secret Portal \[Sora\][^]*- Note: no world count/);
        assert.equal(await readFile(path.join(root, "locations", "locations.json"), "utf8"), locations);
        assert.equal((await post("/api/fixes", JSON.stringify({ fixes: { x: {} } }))).status, 400);
        assert.equal((await post("/api/fixes", JSON.stringify({ fixes: {} }))).status, 200);
        await assert.rejects(readFile(file), { code: "ENOENT" });
        await assert.rejects(readFile(path.join(root, "rule-fixes.md")), { code: "ENOENT" });
    });

    test("uploads images and reports clashes with their path", async () => {
        const first = await post("/api/image?dir=images/maps&name=Overworld.png", Buffer.from("png"));
        assert.equal(first.status, 200);
        assert.equal(JSON.parse(first.body).path, "images/maps/Overworld.png");
        const clash = await post("/api/image?dir=images/maps&name=Overworld.png", Buffer.from("png"));
        assert.equal(clash.status, 409);
        assert.equal(JSON.parse(clash.body).path, "images/maps/Overworld.png");
        assert.equal((await post("/api/image?dir=scripts&name=x.png", Buffer.from(""))).status, 400);
    });
});
