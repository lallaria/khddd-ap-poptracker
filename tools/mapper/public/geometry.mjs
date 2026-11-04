// Affine transforms {a, b, c, d, e, f}: x' = a*x + b*y + c, y' = d*x + e*y + f.

export const IDENTITY = Object.freeze({ a: 1, b: 0, c: 0, d: 0, e: 1, f: 0 });
const MIN_SPREAD = 2;

export function apply(t, p) {
    return { x: t.a * p.x + t.b * p.y + t.c, y: t.d * p.x + t.e * p.y + t.f };
}

export function invert(t) {
    const det = t.a * t.e - t.b * t.d;
    if (Math.abs(det) < 1e-12) throw new Error("transform is not invertible");
    const a = t.e / det;
    const b = -t.b / det;
    const d = -t.d / det;
    const e = t.a / det;
    return { a, b, c: -(a * t.c + b * t.f), d, e, f: -(d * t.c + e * t.f) };
}

export function translate(t, dx, dy) {
    return { ...t, c: t.c + dx, f: t.f + dy };
}

/** Scales the transform's output about point p, which stays fixed. */
export function scaleAbout(t, kx, ky, p) {
    return {
        a: t.a * kx, b: t.b * kx, c: p.x + kx * (t.c - p.x),
        d: t.d * ky, e: t.e * ky, f: p.y + ky * (t.f - p.y),
    };
}

export function stretch(oldW, oldH, newW, newH) {
    return { a: newW / oldW, b: 0, c: 0, d: 0, e: newH / oldH, f: 0 };
}

/** Linear scale of the transform, for resizing markers along with the image. */
export function scaleFactor(t) {
    return Math.sqrt(Math.abs(t.a * t.e - t.b * t.d));
}

export function isAxisAligned(t) {
    return Math.abs(t.b) < 1e-9 && Math.abs(t.d) < 1e-9;
}

function axisFit(from, to) {
    const n = from.length;
    const mf = from.reduce((s, v) => s + v, 0) / n;
    const mt = to.reduce((s, v) => s + v, 0) / n;
    let cov = 0;
    let varf = 0;
    for (let i = 0; i < n; i++) {
        cov += (from[i] - mf) * (to[i] - mt);
        varf += (from[i] - mf) ** 2;
    }
    const spread = Math.max(...from) - Math.min(...from);
    return { scale: spread >= MIN_SPREAD ? cov / varf : null, mf, mt, cov, varf };
}

function solve3(m, v) {
    const det = (r) => r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1])
        - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0])
        + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
    const base = det(m);
    if (Math.abs(base) < 1e-9) return null;
    return [0, 1, 2].map((col) => det(m.map((row, i) => row.map((cell, j) => (j === col ? v[i] : cell)))) / base);
}

function fitAffine(pairs) {
    const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const vx = [0, 0, 0];
    const vy = [0, 0, 0];
    for (const { from, to } of pairs) {
        const row = [from.x, from.y, 1];
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) m[i][j] += row[i] * row[j];
            vx[i] += row[i] * to.x;
            vy[i] += row[i] * to.y;
        }
    }
    const px = solve3(m, vx);
    const py = solve3(m, vy);
    if (!px || !py) return null;
    return { a: px[0], b: px[1], c: px[2], d: py[0], e: py[1], f: py[2] };
}

function fitScale(pairs, uniform) {
    const x = axisFit(pairs.map((p) => p.from.x), pairs.map((p) => p.to.x));
    const y = axisFit(pairs.map((p) => p.from.y), pairs.map((p) => p.to.y));
    let sx = x.scale;
    let sy = y.scale;
    if (uniform || sx === null || sy === null) {
        const varf = (sx === null ? 0 : x.varf) + (sy === null ? 0 : y.varf);
        if (!varf) return null;
        sx = sy = ((sx === null ? 0 : x.cov) + (sy === null ? 0 : y.cov)) / varf;
    }
    return { a: sx, b: 0, c: x.mt - sx * x.mf, d: 0, e: sy, f: y.mt - sy * y.mf };
}

/**
 * Fits old-image -> new-image coordinates from reference point pairs.
 *
 * One pair only shifts `current`. Models: "scale" (independent x/y scale + offset, 2+ pairs), "uniform"
 * (one scale + offset, 2+ pairs), "affine" (also rotation and shear, 3+ pairs, else falls back to "scale").
 *
 * Returns:
 *     `{transform, residuals}`, residuals being each pair's distance in new-image pixels; null if the
 *     pairs cannot determine a transform.
 */
export function fit(pairs, model, current = IDENTITY) {
    if (!pairs.length) return null;
    let t;
    if (pairs.length === 1) {
        const moved = apply(current, pairs[0].from);
        t = translate(current, pairs[0].to.x - moved.x, pairs[0].to.y - moved.y);
    } else {
        t = (model === "affine" && pairs.length >= 3 && fitAffine(pairs)) || fitScale(pairs, model === "uniform");
    }
    if (!t) return null;
    const residuals = pairs.map(({ from, to }) => {
        const p = apply(t, from);
        return Math.hypot(p.x - to.x, p.y - to.y);
    });
    return { transform: t, residuals };
}
