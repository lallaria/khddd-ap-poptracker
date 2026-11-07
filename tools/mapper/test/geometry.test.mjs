import assert from "node:assert/strict";
import { describe, test } from "node:test";

import * as G from "../public/geometry.mjs";

const close = (actual, expected, message, epsilon = 1e-6) => {
    for (const key of Object.keys(expected)) {
        assert.ok(Math.abs(actual[key] - expected[key]) < epsilon, `${message}: ${key} ${actual[key]} != ${expected[key]}`);
    }
};
const pairsFor = (t, points) => points.map(([x, y]) => ({ from: { x, y }, to: G.apply(t, { x, y }) }));

describe("transforms", () => {
    test("invert undoes apply", () => {
        const t = { a: 1.7, b: 0.2, c: -40, d: -0.1, e: 0.9, f: 12 };
        const p = { x: 123, y: -45 };
        close(G.apply(G.invert(t), G.apply(t, p)), p, "round trip");
        assert.throws(() => G.invert({ a: 0, b: 0, c: 0, d: 0, e: 1, f: 0 }), /not invertible/);
    });

    test("scaleAbout keeps its anchor fixed", () => {
        const t = { a: 2, b: 0, c: 5, d: 0, e: 3, f: -7 };
        const anchor = { x: 40, y: 60 };
        const scaled = G.scaleAbout(t, 1.5, 0.5, anchor);
        const source = G.apply(G.invert(t), anchor);
        close(G.apply(scaled, source), anchor, "anchor");
        close(scaled, { a: 3, e: 1.5 }, "scales");
    });

    test("stretch maps the old image's corners onto the new one", () => {
        const t = G.stretch(1350, 3213, 2700, 4000);
        close(G.apply(t, { x: 1350, y: 3213 }), { x: 2700, y: 4000 }, "corner");
        assert.ok(Math.abs(G.scaleFactor(t) - Math.sqrt(2 * 4000 / 3213)) < 1e-9);
    });
});

describe("fit", () => {
    const scaleOffset = { a: 1.25, b: 0, c: 30, d: 0, e: 0.8, f: -12 };

    test("recovers independent x/y scale and offset from two pairs", () => {
        const result = G.fit(pairsFor(scaleOffset, [[100, 200], [900, 1400]]), "scale");
        close(result.transform, scaleOffset, "scale");
        assert.ok(result.residuals.every((r) => r < 1e-6));
    });

    test("least-squares fit spreads error over every pair", () => {
        const pairs = pairsFor(scaleOffset, [[0, 0], [1000, 0], [0, 1000], [1000, 1000]]);
        pairs[0].to.x += 4;
        const result = G.fit(pairs, "scale");
        result.residuals.forEach((r, i) => assert.ok(Math.abs(r - [2, 0, 2, 0][i]) < 1e-9, `pair ${i}: ${r}`));
        close(result.transform, { a: 1.248, c: 32, e: scaleOffset.e, f: scaleOffset.f }, "fit");
    });

    test("uniform model shares one scale", () => {
        const uniform = { a: 2, b: 0, c: -5, d: 0, e: 2, f: 9 };
        close(G.fit(pairsFor(uniform, [[10, 10], [300, 50], [40, 500]]), "uniform").transform, uniform, "uniform");
    });

    test("affine model recovers a rotation from three pairs", () => {
        const angle = 0.1;
        const rotated = { a: Math.cos(angle) * 1.5, b: -Math.sin(angle) * 1.5, c: 20, d: Math.sin(angle) * 1.5, e: Math.cos(angle) * 1.5, f: 40 };
        close(G.fit(pairsFor(rotated, [[0, 0], [500, 30], [80, 700]]), "affine").transform, rotated, "affine");
    });

    test("affine model falls back to scale + offset with two pairs or collinear points", () => {
        const pairs = pairsFor(scaleOffset, [[0, 0], [400, 300]]);
        close(G.fit(pairs, "affine").transform, scaleOffset, "two pairs");
        const collinear = pairsFor({ ...scaleOffset, e: scaleOffset.a }, [[0, 0], [100, 100], [200, 200]]);
        assert.ok(G.isAxisAligned(G.fit(collinear, "affine").transform));
    });

    test("one pair only shifts the current transform", () => {
        const current = { a: 2, b: 0, c: 0, d: 0, e: 3, f: 0 };
        const { transform } = G.fit([{ from: { x: 10, y: 10 }, to: { x: 50, y: 70 } }], "scale", current);
        close(transform, { a: 2, e: 3, c: 30, f: 40 }, "shift");
    });

    test("an axis without spread borrows the other axis's scale", () => {
        const { transform } = G.fit([{ from: { x: 100, y: 0 }, to: { x: 210, y: 5 } },
            { from: { x: 100, y: 400 }, to: { x: 210, y: 805 } }], "scale");
        close(transform, { a: 2, e: 2, c: 10, f: 5 }, "borrowed");
    });

    test("returns null when the pairs cannot determine a transform", () => {
        assert.equal(G.fit([], "scale"), null);
        const same = { from: { x: 5, y: 5 }, to: { x: 9, y: 9 } };
        assert.equal(G.fit([same, structuredClone(same)], "scale"), null);
    });
});
