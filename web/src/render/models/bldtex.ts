import * as THREE from 'three';

/*
 * Procedural PBR surface textures for the detailed buildings (no image
 * assets). Each set (albedo, normal from a height field, roughness) tiles
 * seamlessly and is generated lazily once, then shared by every building.
 * Albedo stays near white / neutral so the per-vertex tint (team colour,
 * regional paint) carries the hue.
 *
 *  - clad:  composite wall cladding: trapezoidal ribs, horizontal joints with
 *           bolt rows, weathered edges and rain streaks under the joints
 *  - plate: heavy steel plates with bevelled seams, rivet rows, scuffs
 *  - paint: painted surfaces: orange peel, mottling, chipped edges, faint drips
 */

export type BldTexKind = 'clad' | 'plate' | 'paint';

export interface BldSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

function hash(x: number, y: number, s: number) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
/** Periodic value noise with period p cells. */
function vnoise(x: number, y: number, p: number, s: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const m = (a: number) => ((a % p) + p) % p;
  const a = hash(m(xi), m(yi), s);
  const b = hash(m(xi + 1), m(yi), s);
  const c = hash(m(xi), m(yi + 1), s);
  const d = hash(m(xi + 1), m(yi + 1), s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(u: number, v: number, f: number, s: number, oct = 4) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let fq = f;
  for (let i = 0; i < oct; i++) {
    sum += vnoise(u * fq, v * fq, fq, s + i * 17) * amp;
    norm += amp;
    amp *= 0.5;
    fq *= 2;
  }
  return sum / norm;
}
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const frac = (x: number) => x - Math.floor(x);

type Px = { c: number; h: number; r: number; m?: number };
type Gen = (u: number, v: number, o: Px) => void;

/** Distance (in uv units) to the nearest repeating line of period 1/n. */
function lineDist(t: number, n: number) {
  const f = frac(t * n);
  return Math.min(f, 1 - f) / n;
}

const GEN: Record<BldTexKind, { N: number; strength: number; gen: Gen }> = {
  clad: {
    N: 512,
    strength: 3.2,
    gen(u, v, o) {
      // 4 panels across, each with two minor ribs; one horizontal joint per tile
      const pu = frac(u * 4);
      const major = Math.min(pu, 1 - pu) * 4; // uv distance to the main rib / 0.25
      const rib = 1 - sstep(0.018, 0.045, major);
      const minor = Math.min(Math.abs(pu - 0.333), Math.abs(pu - 0.667));
      const mrib = 1 - sstep(0.012, 0.03, minor);
      const jv = lineDist(v, 1);
      const joint = 1 - sstep(0.004, 0.012, jv);
      // bolt rows just above / below the joint
      const bu = frac(u * 24);
      const bd = Math.hypot(Math.min(bu, 1 - bu) / 24, Math.abs(jv - 0.022));
      const bolt = 1 - sstep(0.0035, 0.0065, bd);
      // rain streaks hanging below the joint (v runs downward on walls)
      const below = frac(v);
      const streak = clamp01((fbm(u * 1.0, v * 0.12, 24, 7, 3) - 0.48) * 3) * (1 - sstep(0.0, 0.55, below)) * 0.55;
      const blot = clamp01((fbm(u, v, 3, 11, 4) - 0.5) * 2.2);
      const wear = rib * clamp01((fbm(u, v, 16, 3, 3) - 0.45) * 3);
      let c = 0.9 - 0.06 * blot - 0.16 * streak - 0.22 * joint + 0.06 * wear + (fbm(u, v, 32, 5, 2) - 0.5) * 0.05;
      c -= bolt * 0.18;
      o.c = clamp01(c);
      o.h = 0.5 + rib * 0.32 + mrib * 0.12 - joint * 0.35 + bolt * 0.25 + (fbm(u, v, 64, 9, 2) - 0.5) * 0.02;
      o.r = clamp01(0.62 + blot * 0.12 + streak * 0.2 - wear * 0.25 - rib * 0.08);
    },
  },
  plate: {
    N: 512,
    strength: 3.6,
    gen(u, v, o) {
      // 2 x 2 plates per tile, offset rows; bevelled seams and rivet rows
      const row = Math.floor(v * 2);
      const uu = u + (row % 2) * 0.25;
      const su = lineDist(uu, 2);
      const sv = lineDist(v, 2);
      const seam = Math.min(su, sv);
      const bevel = sstep(0.0, 0.012, seam);
      const groove = 1 - sstep(0.002, 0.006, seam);
      // rivets along the seams
      const ru = frac(uu * 20);
      const rv = frac(v * 20);
      const nearU = Math.hypot(Math.min(ru, 1 - ru) / 20, su - 0.02);
      const nearV = Math.hypot(Math.min(rv, 1 - rv) / 20, sv - 0.02);
      const rivet = 1 - sstep(0.004, 0.0075, Math.min(nearU, nearV));
      const pid = hash(Math.floor(uu * 2) & 1, row & 1, 3);
      const scuff = clamp01((fbm(u * 6, v * 0.6, 8, 21, 3) - 0.55) * 3);
      const grime = clamp01((fbm(u, v, 4, 23, 4) - 0.5) * 2.5);
      const edgeWear = (1 - sstep(0.008, 0.03, seam)) * clamp01((fbm(u, v, 24, 29, 2) - 0.4) * 2);
      let c = 0.82 + (pid - 0.5) * 0.08 - grime * 0.12 + edgeWear * 0.1 + scuff * 0.06 - groove * 0.3;
      c -= rivet * 0.08;
      o.c = clamp01(c);
      o.h = 0.35 + bevel * 0.4 + rivet * 0.3 + (fbm(u, v, 48, 31, 2) - 0.5) * 0.03;
      o.r = clamp01(0.36 + grime * 0.25 - edgeWear * 0.15 + (pid - 0.5) * 0.1 - scuff * 0.1);
    },
  },
  paint: {
    N: 256,
    strength: 1.4,
    gen(u, v, o) {
      const mott = fbm(u, v, 4, 41, 4);
      const peel = fbm(u, v, 64, 43, 2);
      const chip = clamp01((fbm(u, v, 12, 47, 4) - 0.66) * 6);
      const drip = clamp01((fbm(u * 1.0, v * 0.1, 32, 49, 3) - 0.55) * 2.5) * 0.5;
      o.c = clamp01(0.95 - (mott - 0.5) * 0.12 - chip * 0.25 - drip * 0.1);
      o.h = 0.5 + (peel - 0.5) * 0.12 - chip * 0.25;
      o.r = clamp01(0.55 + (mott - 0.5) * 0.3 + chip * 0.3 + drip * 0.15);
    },
  },
};

function toTex(N: number, data: Float32Array, ch: number, srgb: boolean) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(N, N);
  for (let i = 0; i < N * N; i++) {
    for (let k = 0; k < 3; k++) img.data[i * 4 + k] = Math.max(0, Math.min(255, Math.round(data[i * ch + (ch === 1 ? 0 : k)] * 255)));
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

const cache = new Map<BldTexKind, BldSet>();

/** Lazily generated, shared texture set. */
export function bldTex(kind: BldTexKind): BldSet {
  let s = cache.get(kind);
  if (s) return s;
  const { N, strength, gen } = GEN[kind];
  const col = new Float32Array(N * N);
  const h = new Float32Array(N * N);
  const rgh = new Float32Array(N * N * 3);
  const o: Px = { c: 0, h: 0, r: 0 };
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      gen((x + 0.5) / N, (y + 0.5) / N, o);
      const i = y * N + x;
      col[i] = o.c;
      h[i] = o.h;
      rgh[i * 3 + 1] = o.r; // roughness lives in G
    }
  const nrm = new Float32Array(N * N * 3);
  const at = (xx: number, yy: number) => h[((yy + N) % N) * N + ((xx + N) % N)];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) * strength;
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * N + x) * 3;
      nrm[i] = (-dx / len) * 0.5 + 0.5;
      nrm[i + 1] = (dy / len) * 0.5 + 0.5;
      nrm[i + 2] = (1 / len) * 0.5 + 0.5;
    }
  s = { map: toTex(N, col, 1, true), normalMap: toTex(N, nrm, 3, false), roughnessMap: toTex(N, rgh, 3, false) };
  cache.set(kind, s);
  return s;
}
