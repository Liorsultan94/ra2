/*
 * Battle-scar decal atlas pixels (scarsdecal.ts), as pure code with no three.js or DOM, so it can run in a
 * worker (scarsatlas.worker.ts): the procedural channels cost ~2 s of CPU at 256 px per tile on a desktop
 * (several seconds on a phone), far too long for the main thread.
 */

export const COLS = 4;
export const ROWS = 2;


function hash(x: number, y: number, s: number) {
  const h = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
function vnoise(x: number, y: number, s: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s);
  const b = hash(xi + 1, yi, s);
  const c = hash(xi, yi + 1, s);
  const d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number, s: number, oct = 4) {
  let sum = 0;
  let amp = 0.5;
  let n = 0;
  for (let o = 0; o < oct; o++) {
    sum += vnoise(x, y, s + o * 13) * amp;
    n += amp;
    amp *= 0.5;
    x *= 2.03;
    y *= 2.03;
  }
  return sum / n;
}
/** Angular noise, periodic around the circle. */
function anoise(a: number, f: number, s: number) {
  return fbm(Math.cos(a) * f + 7, Math.sin(a) * f + 3, s, 3);
}
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const gauss = (x: number, w: number) => Math.exp(-(x * x) / (w * w));

type Px = (u: number, v: number) => [number, number, number, number];

/** u, v in -1..1 (tile centre at 0). Returns [char, soil, depth, rim], 0..1. */
function craterPx(seed: number, oblique: number): Px {
  // clods: random blobs on the ejecta apron
  const clods: [number, number, number][] = [];
  for (let i = 0; i < 70; i++) {
    const a = hash(i, 1, seed) * Math.PI * 2;
    const bias = 1 + oblique * Math.cos(a - 0.6);
    const r = (0.48 + Math.pow(hash(i, 2, seed), 1.6) * 0.42) * Math.min(1.05, 0.85 + 0.2 * bias);
    clods.push([Math.cos(a) * r, Math.sin(a) * r, 0.012 + hash(i, 3, seed) * 0.03]);
  }
  return (u, v) => {
    const a = Math.atan2(v, u);
    const r0 = Math.hypot(u, v);
    const wob = 1 + (anoise(a, 1.6, seed) - 0.5) * 0.28;
    const r = r0 * wob;
    const R = 0.4;
    const bowl = r < R ? Math.pow(1 - (r / R) * (r / R), 0.75) : 0;
    const rim = gauss(r - R - 0.03, 0.085) * (0.75 + 0.5 * fbm(u * 6, v * 6, seed + 5));
    // ejecta rays (an oblique hit throws them to one side)
    const bias = 1 + oblique * Math.cos(a - 0.6);
    const ray = Math.min(1, Math.pow(anoise(a, 9, seed + 2) * 1.6, 4) * 1.2);
    const reach = Math.min(1.02, (0.6 + 0.32 * bias) * (0.8 + 0.35 * ray));
    const apron = Math.pow(sstep(reach, 0.42, r0), 0.8) * (0.35 + 0.65 * ray);
    let soil = Math.max(bowl > 0 ? 0.85 : 0, sstep(0.55, 0.38, r), apron * (0.6 + 0.4 * fbm(u * 9, v * 9, seed + 7)));
    let rimH = rim;
    for (const [cx, cy, cr] of clods) {
      const d = Math.hypot(u - cx, v - cy);
      if (d < cr) {
        const k = 1 - d / cr;
        soil = Math.max(soil, 0.9);
        rimH = Math.max(rimH, k * 0.7);
      }
    }
    // char: the scorched centre and soot streaks
    const sootRay = Math.pow(anoise(a, 6, seed + 9), 3) * 2.5;
    const char = Math.max(sstep(0.5, 0.05, r) * (0.55 + 0.35 * fbm(u * 5, v * 5, seed + 11)), sstep(0.95, 0.35, r0) * sootRay * 0.55 * fbm(u * 7, v * 7, seed + 12));
    return [clamp01(char), clamp01(soil), clamp01(bowl), clamp01(rimH)];
  };
}

function scorchPx(seed: number, streaky: number): Px {
  return (u, v) => {
    const a = Math.atan2(v, u);
    const r0 = Math.hypot(u, v);
    const edge = 0.62 + (anoise(a, 2.2, seed) - 0.5) * 0.45;
    const blot = fbm(u * 3.2, v * 3.2, seed + 1);
    const body = sstep(edge + 0.15, edge - 0.25, r0 + (blot - 0.5) * 0.35);
    const streak = Math.pow(anoise(a, 11, seed + 3), 3) * 3 * sstep(0.98, 0.3, r0) * streaky;
    const speck = fbm(u * 14, v * 14, seed + 4) > 0.68 ? sstep(0.95, 0.5, r0) * 0.5 : 0;
    const c = Math.max(body * (0.55 + 0.45 * blot), streak * 0.7, speck);
    return [clamp01(c), 0, 0, 0];
  };
}

function potholePx(seed: number): Px {
  return (u, v) => {
    const a = Math.atan2(v, u);
    const r0 = Math.hypot(u, v);
    const edge = 0.3 + (anoise(a, 3.5, seed) - 0.5) * 0.22 + (fbm(u * 12, v * 12, seed + 1) - 0.5) * 0.06;
    const hole = sstep(edge + 0.02, edge - 0.06, r0);
    const depth = hole * (0.55 + 0.45 * sstep(edge, 0, r0));
    // broken asphalt edge: a darker ring of crumbs
    const lip = gauss(r0 - edge - 0.03, 0.04);
    // crack web (ridged noise), denser near the hole, some of it sealed with tar (wider, darker lines)
    const n1 = fbm(u * 3.5, v * 3.5, seed + 2, 3);
    const n2 = fbm(u * 6, v * 6, seed + 3, 3);
    const crack = sstep(0.025, 0.0, Math.abs(n1 - 0.5)) * sstep(0.95, 0.4, r0);
    const sealed = sstep(0.05, 0.025, Math.abs(n2 - 0.5)) * sstep(0.9, 0.5, r0) * (hash(Math.floor(u * 3), Math.floor(v * 3), seed) > 0.45 ? 1 : 0);
    const radial = Math.pow(anoise(a, 14, seed + 5), 6) * 9 * sstep(0.8, edge, r0) * (r0 > edge ? 1 : 0);
    const char = Math.max(crack * 0.85, sealed * 0.6, Math.min(1, radial) * 0.8, lip * 0.5, hole * 0.35);
    const soil = hole * (0.45 + 0.35 * fbm(u * 10, v * 10, seed + 6));
    return [clamp01(char), clamp01(soil), clamp01(depth), clamp01(lip * 0.35)];
  };
}

function patchPx(seed: number): Px {
  return (u, v) => {
    const ex = 0.62 + (fbm(v * 4, 1, seed) - 0.5) * 0.1;
    const ey = 0.42 + (fbm(u * 4, 2, seed) - 0.5) * 0.08;
    const box = sstep(0.03, -0.01, Math.max(Math.abs(u) - ex, Math.abs(v) - ey));
    const seam = gauss(Math.max(Math.abs(u) - ex, Math.abs(v) - ey), 0.02);
    const n = fbm(u * 5, v * 5, seed + 1, 3);
    const sealed = sstep(0.04, 0.02, Math.abs(n - 0.5)) * sstep(0.98, 0.7, Math.hypot(u * 0.8, v)) * (1 - box);
    const tex = 0.32 + 0.12 * fbm(u * 18, v * 18, seed + 2);
    return [clamp01(Math.max(box * tex, seam * 0.6, sealed * 0.55)), 0, 0, clamp01(box * 0.12 + seam * 0.2)];
  };
}

function ruinPadPx(seed: number): Px {
  const bits: [number, number, number][] = [];
  for (let i = 0; i < 70; i++) bits.push([(hash(i, 1, seed) - 0.5) * 1.8, (hash(i, 2, seed) - 0.5) * 1.8, 0.015 + hash(i, 3, seed) * 0.035]);
  return (u, v) => {
    // rounded square footprint with ragged edges
    const q = Math.pow(Math.pow(Math.abs(u), 4) + Math.pow(Math.abs(v), 4), 0.25);
    const ed = 0.78 + (fbm(u * 3, v * 3, seed) - 0.5) * 0.3;
    const body = sstep(ed + 0.12, ed - 0.2, q);
    const dust = body * (0.45 + 0.55 * fbm(u * 6, v * 6, seed + 1));
    const char = body * sstep(0.45, 0.75, fbm(u * 2.5, v * 2.5, seed + 2)) * 0.9;
    let rim = 0;
    let soil = dust;
    for (const [cx, cy, cr] of bits) {
      const d = Math.hypot(u - cx, v - cy);
      if (d < cr) {
        rim = Math.max(rim, (1 - d / cr) * 0.6);
        soil = Math.max(soil, 0.8);
      }
    }
    return [clamp01(char), clamp01(soil), 0, clamp01(rim + body * 0.08)];
  };
}

function clodsPx(seed: number): Px {
  const bits: [number, number, number][] = [];
  for (let i = 0; i < 14; i++) {
    const a = hash(i, 1, seed) * Math.PI * 2;
    const r = Math.sqrt(hash(i, 2, seed)) * 0.75;
    bits.push([Math.cos(a) * r, Math.sin(a) * r, 0.06 + hash(i, 3, seed) * 0.12]);
  }
  return (u, v) => {
    let rim = 0;
    let soil = 0;
    for (const [cx, cy, cr] of bits) {
      const d = Math.hypot(u - cx, v - cy);
      if (d < cr) {
        rim = Math.max(rim, (1 - d / cr) * 0.8);
        soil = Math.max(soil, sstep(cr, cr * 0.6, d));
      }
    }
    return [0, clamp01(soil), 0, clamp01(rim)];
  };
}

/** The decal atlas pixels (COLS x ROWS tiles of `tile` px, RGBA8). Texel row 0 is v = 0. */
export function scarAtlasData(tile: number): Uint8Array {
  const g = scarAtlasRows(tile);
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}

/** The same, one yield per pixel row of a tile (main-thread fallback in slices). */
export function* scarAtlasRows(tile: number): Generator<void, Uint8Array> {
  const W = tile * COLS;
  const H = tile * ROWS;
  const data = new Uint8Array(W * H * 4);
  const tiles: Px[] = [craterPx(11, 0.15), craterPx(23, 0.75), scorchPx(31, 0.6), scorchPx(43, 1.4), potholePx(53), patchPx(61), ruinPadPx(71), clodsPx(83)];
  const Z: [number, number, number, number] = [0, 0, 0, 0];
  for (let t = 0; t < tiles.length; t++) {
    const fn = tiles[t];
    const ox = (t % COLS) * tile;
    const oy = Math.floor(t / COLS) * tile;
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        // keep a 2 px empty border so the bilinear filter never bleeds between tiles
        const border = x < 2 || y < 2 || x >= tile - 2 || y >= tile - 2;
        const px = border ? Z : fn(((x + 0.5) / tile) * 2 - 1, ((y + 0.5) / tile) * 2 - 1);
        const o = ((oy + y) * W + ox + x) * 4;
        // fade every channel out towards the tile edge (no hard square cut-off)
        const e = sstep(1.0, 0.9, Math.max(Math.abs(((x + 0.5) / tile) * 2 - 1), Math.abs(((y + 0.5) / tile) * 2 - 1)));
        data[o] = Math.round(px[0] * e * 255);
        data[o + 1] = Math.round(px[1] * e * 255);
        data[o + 2] = Math.round(px[2] * e * 255);
        data[o + 3] = Math.round(px[3] * e * 255);
      }
      yield;
    }
  }
  return data;
}
