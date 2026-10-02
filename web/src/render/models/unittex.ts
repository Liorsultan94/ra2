import * as THREE from 'three';

/*
 * Shared procedural surface textures + material look for units (vehicles,
 * aircraft, infantry). No image assets: every set is generated lazily on a
 * canvas once and shared by every unit of that kind.
 *
 *  - armour (vehicles): welded / bolted armour plates: bevelled panel seams,
 *    bolt rows along the seams, cast-steel grain, paint chipping on the plate
 *    edges and rain / grime streaks under the seams. `armourMod()` is a
 *    near-white modulation map for the vertex-coloured detail bucket;
 *    `vehCamo(faction)` bakes the nation's real paint scheme over the same
 *    plate layout (both share the normal + roughness maps).
 *  - air (aircraft): flush skin panels with fine panel lines, rivet lines,
 *    access hatches and fastener dots.
 *  - fabric (infantry): `uniformCamo(faction)` = the army's real uniform
 *    pattern (OCP, Flecktarn, EMR, MM-14, Type 07, granite, ...) on a twill weave.
 *
 * `unitLook()` chains an onBeforeCompile on a cached material: a subtle
 * view-grazing rim that scales with the ambient / sky light (readable
 * silhouettes at RTS zoom, fades at night with the light) and, for vehicles,
 * team-colour stripes that stay free of dust and glow slightly.
 */

export interface UnitTexSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

// ----------------------------------------------------------------- noise

function hash(x: number, y: number, s: number) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
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
/** Periodic fBm over the unit square, base frequency f (integer). */
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
function lineDist(t: number, n: number) {
  const f = frac(t * n);
  return Math.min(f, 1 - f) / n;
}
const rgb = (c: number): [number, number, number] => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];

// ------------------------------------------------------------ texture io

function toTex(N: number, data: Float32Array, ch: 1 | 3, srgb: boolean) {
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

function normalFrom(N: number, h: Float32Array, strength: number): Float32Array {
  const nrm = new Float32Array(N * N * 3);
  const at = (x: number, y: number) => h[((y + N) % N) * N + ((x + N) % N)];
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
  return nrm;
}
/** Roughness in G (three reads .g), metal-ish chips could go in B. */
function roughTex(N: number, r: Float32Array) {
  const d = new Float32Array(N * N * 3);
  for (let i = 0; i < N * N; i++) {
    d[i * 3] = 1;
    d[i * 3 + 1] = r[i];
    d[i * 3 + 2] = 0;
  }
  return toTex(N, d, 3, false);
}

// -------------------------------------------------------- armour plates

/** Plate layout sampled per texel (shared by the modulation map and every camo albedo). */
interface Plate {
  h: number; // height 0..1
  ao: number; // 0..1 cavity darkening (seams, bolt bases)
  chip: number; // 0..1 chipped paint (bare primer / steel)
  edge: number; // 0..1 worn-bright plate edge
  grime: number; // 0..1 grime / streaks
  r: number; // roughness
}

const AN = 512;
let plateCache: Plate[] | null = null;

function plateAt(u: number, v: number, o: Plate) {
  // 4 x 3 plates per repeat, every other row offset (welded hull / turret plates)
  const row = Math.floor(v * 3);
  const uu = u + (row % 2) * 0.125;
  // irregular plates: drop some seam segments so it never reads as a regular grid
  const ci = Math.floor(uu * 4 + 0.5);
  const ri = Math.floor(v * 3 + 0.5);
  const vOn = hash(ci & 3, row % 3, 41) > 0.3 ? 1 : 0;
  const hOn = hash(Math.floor(uu * 4) & 3, ri % 3, 43) > 0.35 ? 1 : 0;
  const su = vOn ? lineDist(uu, 4) : 1;
  const sv = hOn ? lineDist(v, 3) : 1;
  const seam = Math.min(su, sv);
  // bevelled plate edge -> groove
  const groove = 1 - sstep(0.0015, 0.0045, seam);
  const bevel = sstep(0.0, 0.01, seam);
  // bolt rows just inside the horizontal seams, every 1/28
  const bu = frac(uu * 28);
  const bd = Math.hypot((Math.min(bu, 1 - bu) / 28) * 1.0, sv - 0.011);
  const bolt = 1 - sstep(0.0028, 0.0052, bd);
  const boltRing = (1 - sstep(0.0048, 0.0065, bd)) * (1 - bolt);
  // a weld bead on some vertical seams (cast + welded look)
  const pid = hash(Math.floor(uu * 4) & 3, row % 3, 7);
  const weld = pid > 0.55 ? (1 - sstep(0.002, 0.005, su)) * (0.6 + 0.4 * vnoise(v * 400, 0, 400, 3)) : 0;
  // plate surface: cast grain + slight per-plate tilt / dents
  const grain = fbm(u, v, 48, 11, 2) - 0.5;
  const dent = fbm(u, v, 8, 13, 3) - 0.5;
  // chipping: noisy, concentrated along seams and bolt heads
  const nearEdge = 1 - sstep(0.004, 0.022, seam);
  const chipN = fbm(u, v, 32, 17, 3);
  const chip = clamp01((chipN - 0.7 + nearEdge * 0.2 + bolt * 0.3) * 6) * (0.45 + 0.55 * nearEdge);
  const speck = hash(Math.floor(u * 512), Math.floor(v * 512), 19) > 0.996 ? 1 : 0;
  // grime streaks running down from the horizontal seams (v grows downward on side faces)
  const below = frac(v * 3);
  const streak = clamp01((fbm(u * 1.0, v * 0.08, 40, 23, 3) - 0.5) * 3.2) * (1 - sstep(0.0, 0.7, below));
  const blot = clamp01((fbm(u, v, 3, 29, 4) - 0.5) * 2.4);
  o.h = 0.5 + bevel * 0.18 - groove * 0.32 + bolt * 0.32 + boltRing * 0.05 + weld * 0.12 + grain * 0.035 + dent * 0.06 - Math.max(chip, speck) * 0.05;
  o.ao = Math.max(groove * 0.6, boltRing * 0.25);
  o.chip = Math.max(chip, speck * 0.8);
  o.edge = (1 - sstep(0.0045, 0.009, seam)) * (1 - groove) * 0.8 + bolt * 0.5;
  o.grime = clamp01(streak * 0.7 + blot * 0.35);
  o.r = clamp01(0.74 + blot * 0.1 + streak * 0.12 - chip * 0.3 - bolt * 0.2 - o.edge * 0.15 + grain * 0.1);
}

function plates(): Plate[] {
  if (plateCache) return plateCache;
  const out: Plate[] = new Array(AN * AN);
  for (let y = 0; y < AN; y++)
    for (let x = 0; x < AN; x++) {
      const o: Plate = { h: 0, ao: 0, chip: 0, edge: 0, grime: 0, r: 0 };
      plateAt((x + 0.5) / AN, (y + 0.5) / AN, o);
      out[y * AN + x] = o;
    }
  plateCache = out;
  return out;
}

let armourNR: { normalMap: THREE.Texture; roughnessMap: THREE.Texture } | null = null;
function armourMaps() {
  if (armourNR) return armourNR;
  const P = plates();
  const h = new Float32Array(AN * AN);
  const r = new Float32Array(AN * AN);
  for (let i = 0; i < AN * AN; i++) {
    h[i] = P[i].h;
    r[i] = P[i].r;
  }
  armourNR = { normalMap: toTex(AN, normalFrom(AN, h, 4.2), 3, false), roughnessMap: roughTex(AN, r) };
  return armourNR;
}

const PRIMER: [number, number, number] = [0.2, 0.19, 0.17];

let modSet: UnitTexSet | null = null;
/** Near-white modulation (seams, chips, grime) for vertex-coloured armour detail. */
export function armourMod(): UnitTexSet {
  if (modSet) return modSet;
  const P = plates();
  const c = new Float32Array(AN * AN * 3);
  for (let i = 0; i < AN * AN; i++) {
    const p = P[i];
    let k = 1 - p.ao * 0.45 - p.grime * 0.12 + p.edge * 0.08;
    k = Math.max(0.3, k);
    for (let j = 0; j < 3; j++) c[i * 3 + j] = k * (1 - p.chip * 0.55) + PRIMER[j] * p.chip * 0.55 * 1.6;
  }
  const m = armourMaps();
  modSet = { map: toTex(AN, c, 3, true), normalMap: m.normalMap, roughnessMap: m.roughnessMap };
  return modSet;
}

// ------------------------------------------------------- nation camo

type Scheme = 'carc' | 'sinai' | 'nato3' | 'ru3' | 'ua3' | 'pla' | 'kor3' | 'tr4' | 'ir';

interface CamoSpec {
  scheme: Scheme;
  cols: number[]; // base, 2, 3, 4
}

/** Real-world paint schemes (colours close to the factionCamo() base so vertex-coloured parts match). */
const CAMO: Record<string, CamoSpec> = {
  usa: { scheme: 'carc', cols: [0xb8a57c, 0xa8946a, 0x8c7a56, 0xc4b48c] }, // CARC tan 686A
  israel: { scheme: 'sinai', cols: [0x9e9a7e, 0x8f8a6e, 0x7a7660, 0xaaa68a] }, // Sinai grey
  germany: { scheme: 'nato3', cols: [0x4b5a38, 0x5e4a36, 0x1f2018, 0x4b5a38] }, // NATO 3-tone: green / brown / black
  russia: { scheme: 'ru3', cols: [0x56663e, 0x8a8060, 0x26261c, 0x3e4a2c] }, // green / sand / black
  ukraine: { scheme: 'ua3', cols: [0x5f6a3e, 0x6a5538, 0x2c2e22, 0x857a58] }, // green with brown + black bands
  china: { scheme: 'pla', cols: [0x5d6b47, 0x3d4a2e, 0x26281e, 0x8a8462] }, // PLA digital
  korea: { scheme: 'kor3', cols: [0x56623f, 0x5c4a34, 0x22241c, 0x7a6a4a] }, // ROK 3-tone
  turkey: { scheme: 'tr4', cols: [0x6b7356, 0x4a5040, 0x2a2c24, 0x8c8a70] }, // TSK 4-tone
  iran: { scheme: 'ir', cols: [0xb19a6c, 0x8a7552, 0x6a5a40, 0xc8b48a] }, // desert tan, brown blotches
};

/** Index 0..3 of the camo colour at (u, v). `w` = soft weight for anti-aliasing (unused by hard schemes). */
function schemeAt(s: Scheme, u: number, v: number): number {
  switch (s) {
    case 'carc':
    case 'sinai':
      return 0;
    case 'nato3': {
      // large hard-edged blotches: brown and black over green
      const a = fbm(u, v, 3, 101, 4);
      const b = fbm(u + 0.37, v + 0.21, 3, 131, 4);
      if (b > 0.6) return 2;
      if (a > 0.54) return 1;
      return 0;
    }
    case 'ru3': {
      // wavy diagonal bands: sand + black on green (T-90M style)
      const w = fbm(u, v, 2, 211, 3);
      const t = frac((u * 2 + v * 1 + w * 0.9) * 1.0);
      const n = fbm(u, v, 6, 223, 3);
      if (t < 0.18 + n * 0.08) return 2;
      if (t > 0.48 && t < 0.72 + n * 0.08) return 1;
      return 0;
    }
    case 'ua3': {
      const a = fbm(u, v, 4, 311, 4);
      const b = fbm(u + 0.5, v, 4, 331, 4);
      if (b > 0.62) return 2;
      if (a > 0.57) return 1;
      if (a < 0.33) return 3;
      return 0;
    }
    case 'pla': {
      // digital: 2-level pixel blocks
      const P = 48;
      const cu = (Math.floor(u * P) + 0.5) / P;
      const cv = (Math.floor(v * P) + 0.5) / P;
      const a = fbm(cu, cv, 4, 411, 3) + (hash(Math.floor(u * P), Math.floor(v * P), 413) - 0.5) * 0.08;
      const b = fbm(cu + 0.3, cv, 5, 431, 3) + (hash(Math.floor(u * P), Math.floor(v * P), 433) - 0.5) * 0.08;
      if (b > 0.6) return 2;
      if (a > 0.56) return 1;
      if (a < 0.36) return 3;
      return 0;
    }
    case 'kor3': {
      // smaller, elongated brown + black patches on green
      const a = fbm(u * 1.0, v * 1.0, 5, 511, 4);
      const b = fbm(u + 0.2, v + 0.6, 5, 531, 4);
      if (b > 0.61) return 2;
      if (a > 0.58) return 1;
      return 0;
    }
    case 'tr4': {
      const a = fbm(u, v, 4, 611, 4);
      const b = fbm(u + 0.1, v + 0.4, 4, 631, 4);
      if (b > 0.64) return 2;
      if (a > 0.6) return 1;
      if (a < 0.34) return 3;
      return 0;
    }
    case 'ir': {
      const a = fbm(u, v, 3, 711, 4);
      const b = fbm(u, v, 6, 731, 3);
      if (a > 0.61) return 1;
      if (b > 0.68) return 2;
      return 0;
    }
  }
}

const camoCache = new Map<string, UnitTexSet>();

/** Nation camo albedo (darkened by `dk` like the vertex-coloured base paint) over the shared armour plates. */
export function vehCamo(faction: string, dk = 0.8): UnitTexSet {
  const key = faction + '|' + dk;
  let s = camoCache.get(key);
  if (s) return s;
  const spec = CAMO[faction] ?? { scheme: 'carc' as Scheme, cols: [0x8a8070, 0x80786a, 0x706858, 0x948a7a] };
  const cols = spec.cols.map((c) => rgb(c).map((x) => x * dk) as [number, number, number]);
  const P = plates();
  const c = new Float32Array(AN * AN * 3);
  const plain = spec.scheme === 'carc' || spec.scheme === 'sinai';
  for (let y = 0; y < AN; y++)
    for (let x = 0; x < AN; x++) {
      const u = (x + 0.5) / AN;
      const v = (y + 0.5) / AN;
      const i = y * AN + x;
      const p = P[i];
      let col: [number, number, number];
      if (plain) {
        // single colour, sun-faded mottling and slightly different repaint patches per plate
        const m = fbm(u, v, 4, 801, 4);
        const t = clamp01((m - 0.35) * 1.6);
        const base = cols[0];
        const alt = t < 0.5 ? cols[1] : cols[3];
        const k = Math.abs(t - 0.5) * 0.3;
        col = [base[0] + (alt[0] - base[0]) * k, base[1] + (alt[1] - base[1]) * k, base[2] + (alt[2] - base[2]) * k];
      } else {
        // 2x2 supersample the hard pattern edges
        const acc: [number, number, number] = [0, 0, 0];
        for (const [ox, oy] of [
          [-0.25, -0.25],
          [0.25, -0.25],
          [-0.25, 0.25],
          [0.25, 0.25],
        ]) {
          const cc = cols[schemeAt(spec.scheme, (x + 0.5 + ox) / AN, (y + 0.5 + oy) / AN)];
          acc[0] += cc[0] / 4;
          acc[1] += cc[1] / 4;
          acc[2] += cc[2] / 4;
        }
        col = acc;
        const m = (fbm(u, v, 8, 811, 3) - 0.5) * 0.08;
        col = [col[0] * (1 + m), col[1] * (1 + m), col[2] * (1 + m)];
      }
      // plate detail: seams, edge wear, chipping to primer, grime streaks
      const k = Math.max(0.3, 1 - p.ao * 0.45 - p.grime * 0.12) + p.edge * 0.07;
      for (let j = 0; j < 3; j++) {
        let ch = col[j] * k;
        ch = ch * (1 - p.chip * 0.6) + PRIMER[j] * p.chip * 0.6;
        c[i * 3 + j] = ch;
      }
    }
  const m = armourMaps();
  s = { map: toTex(AN, c, 3, true), normalMap: m.normalMap, roughnessMap: m.roughnessMap };
  camoCache.set(key, s);
  return s;
}

// ------------------------------------------------------------ aircraft

let airSet: UnitTexSet | null = null;
/** Aircraft skin detail: flush panels with fine lines, rivet rows, hatches (near-white albedo modulation). */
export function airPanels(): UnitTexSet {
  if (airSet) return airSet;
  const N = 512;
  const c = new Float32Array(N * N * 3);
  const h = new Float32Array(N * N);
  const r = new Float32Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N;
      const v = (y + 0.5) / N;
      // irregular panel grid: 3 columns, rows of varying height per column
      const col = Math.floor(u * 3);
      const vv = v + hash(col, 0, 5) * 0.37;
      const rows = 2 + Math.floor(hash(col, 1, 5) * 3);
      const su = lineDist(u, 3);
      const sv = lineDist(vv, rows);
      const seam = Math.min(su, sv);
      const line = 1 - sstep(0.0008, 0.0026, seam);
      // rivet lines parallel to the panel lines
      const ru = frac(vv * 64);
      const rv = frac(u * 64);
      const rivA = Math.hypot(Math.min(ru, 1 - ru) / 64, Math.abs(su - 0.008));
      const rivB = Math.hypot(Math.min(rv, 1 - rv) / 64, Math.abs(sv - 0.008));
      const rivet = 1 - sstep(0.0012, 0.0024, Math.min(rivA, rivB));
      // a small access hatch in some panels (rounded rectangle outline + fasteners)
      const pr = Math.floor(vv * rows);
      const hh = hash(col, pr, 9);
      let hatch = 0;
      if (hh > 0.45) {
        const cu = (col + 0.3 + hash(col, pr, 11) * 0.4) / 3;
        const cv = (pr + 0.3 + hash(col, pr, 13) * 0.4) / rows;
        const du = Math.abs(u - cu) - 0.035;
        const dv = Math.abs(frac(vv) - frac(cv)) - 0.022;
        const d = Math.hypot(Math.max(du, 0), Math.max(dv, 0)) + Math.min(Math.max(du, dv), 0) - 0.006;
        hatch = 1 - sstep(0.0006, 0.0022, Math.abs(d));
      }
      const tone = (hash(col, pr, 17) - 0.5) * 0.06 + (fbm(u, v, 6, 19, 3) - 0.5) * 0.06;
      const streak = clamp01((fbm(u * 0.6, v * 0.08, 24, 23, 3) - 0.55) * 2) * 0.5;
      const k = 0.97 + tone - line * 0.3 - hatch * 0.22 - rivet * 0.08 - streak * 0.08;
      const i = y * N + x;
      c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = clamp01(k);
      h[i] = 0.5 - line * 0.35 - hatch * 0.25 + rivet * 0.18 + (fbm(u, v, 32, 29, 2) - 0.5) * 0.02;
      r[i] = clamp01(0.62 + tone * 2 + streak * 0.2 + line * 0.15 - rivet * 0.2);
    }
  airSet = { map: toTex(N, c, 3, true), normalMap: toTex(N, normalFrom(N, h, 3.0), 3, false), roughnessMap: roughTex(N, r) };
  return airSet;
}

// ------------------------------------------------------------- uniforms

type Uni = 'ocp' | 'olive' | 'fleck' | 'emr' | 'mm14' | 't07' | 'granite' | 'trdig' | 'irdes';

const UNIFORM: Record<string, { p: Uni; cols: number[] }> = {
  usa: { p: 'ocp', cols: [0xa89a76, 0x787a54, 0x5e4c36, 0xcbbf98, 0x8a7a52] }, // OCP (Scorpion W2)
  israel: { p: 'olive', cols: [0x5c5d3d, 0x535539, 0x4a4b33, 0x66664a] }, // IDF olive drab
  germany: { p: 'fleck', cols: [0x737755, 0x48512f, 0x23241c, 0x6e4e32, 0x5c6a3e] }, // Flecktarn 5-colour
  russia: { p: 'emr', cols: [0x7a7a5c, 0x50583a, 0x34362a, 0x8c8060] }, // EMR "digital flora"
  ukraine: { p: 'mm14', cols: [0x87835f, 0x5a613e, 0x3a3b2c, 0x9e9372] }, // MM-14
  china: { p: 't07', cols: [0x6a7452, 0x404e35, 0x25291f, 0x887e5c] }, // Type 07 woodland digital
  korea: { p: 'granite', cols: [0x6e7462, 0x4b5242, 0x2b2d28, 0x8d886e] }, // granite-B
  turkey: { p: 'trdig', cols: [0x7a7c5c, 0x4e5540, 0x2e2f27, 0x9a8f6e] }, // TSK digital
  iran: { p: 'irdes', cols: [0xb6a37c, 0x8f7c57, 0x6b5b3f, 0xcdbd93] }, // desert digital
};

function uniformIdx(p: Uni, u: number, v: number): number {
  switch (p) {
    case 'olive':
      return fbm(u, v, 4, 901, 3) > 0.62 ? 1 : 0;
    case 'ocp': {
      // soft multi-scale blobs + small dark "branches"
      const a = fbm(u, v, 3, 911, 4);
      const b = fbm(u + 0.3, v, 4, 921, 4);
      const tw = fbm(u * 2, v * 0.5, 8, 931, 3);
      if (tw > 0.68) return 2;
      if (b > 0.6) return 3;
      if (a > 0.56) return 1;
      if (a < 0.36) return 4;
      return 0;
    }
    case 'fleck': {
      // dense dots of 4 colours on the light base
      const g = 22;
      const cx = Math.floor(u * g);
      const cy = Math.floor(v * g);
      let best = 0;
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          const hx = cx + ox;
          const hy = cy + oy;
          const hm = ((hx % g) + g) % g;
          const hn = ((hy % g) + g) % g;
          const k = hash(hm, hn, 941);
          const px = (hx + 0.2 + hash(hm, hn, 943) * 0.6) / g;
          const py = (hy + 0.2 + hash(hm, hn, 947) * 0.6) / g;
          const rr = (0.012 + hash(hm, hn, 949) * 0.016) * (0.85 + vnoise(u * 90, v * 90, 90, 951) * 0.4);
          if (Math.hypot(u - px, v - py) < rr) best = 1 + Math.floor(k * 4);
        }
      return best;
    }
    case 'emr':
    case 't07':
    case 'granite':
    case 'trdig':
    case 'irdes':
    case 'mm14': {
      const P = p === 'mm14' ? 40 : p === 'irdes' ? 48 : 64;
      const iu = Math.floor(u * P);
      const iv = Math.floor(v * P);
      const cu = (iu + 0.5) / P;
      const cv = (iv + 0.5) / P;
      const j = (hash(iu, iv, 961) - 0.5) * 0.1;
      const f = p === 'mm14' ? 3 : 4;
      const a = fbm(cu, cv, f, p.length * 37 + 971, 3) + j;
      const b = fbm(cu + 0.4, cv, f + 1, p.length * 41 + 977, 3) + j;
      if (b > 0.62) return 2;
      if (a > 0.57) return 1;
      if (a < 0.35) return 3;
      return 0;
    }
  }
}

const uniCache = new Map<string, UnitTexSet>();

/** Uniform camouflage on a twill weave for the infantry of a nation (256 px tile). */
export function uniformCamo(faction: string): UnitTexSet {
  let s = uniCache.get(faction);
  if (s) return s;
  const spec = UNIFORM[faction] ?? UNIFORM.usa;
  const cols = spec.cols.map(rgb);
  const N = 256;
  const c = new Float32Array(N * N * 3);
  const h = new Float32Array(N * N);
  const r = new Float32Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N;
      const v = (y + 0.5) / N;
      const col = cols[Math.min(cols.length - 1, uniformIdx(spec.p, u, v))];
      // diagonal twill + rip-stop grid
      const tw = Math.sin((x + y) * Math.PI * 0.5) * 0.5 + 0.5;
      const rip = lineDist(u, 16) < 0.0018 || lineDist(v, 16) < 0.0018 ? 1 : 0;
      const fold = fbm(u, v, 4, 991, 3) - 0.5;
      const k = 0.94 + tw * 0.06 - rip * 0.05 + fold * 0.12;
      const i = y * N + x;
      for (let j = 0; j < 3; j++) c[i * 3 + j] = col[j] * k;
      h[i] = 0.5 + tw * 0.08 + rip * 0.06 + fold * 0.25;
      r[i] = 0.88 + tw * 0.06;
    }
  s = { map: toTex(N, c, 3, true), normalMap: toTex(N, normalFrom(N, h, 2.2), 3, false), roughnessMap: roughTex(N, r) };
  uniCache.set(faction, s);
  return s;
}

// ------------------------------------------------------------- look patch

export interface LookCfg {
  /** Rim strength (multiplies the ambient light at grazing angles). */
  rim: number;
  /** Vehicles: team-colour vertices (aWear.x < -0.5 via the wear patch's vWDirt) glow slightly and stay clean. */
  team?: boolean;
}

/**
 * Chain the unit look onto a cached material (call after fog.apply / wearPatch).
 * The rim boosts the indirect (sky / hemisphere / IBL) light at grazing view
 * angles, so it follows the time of day instead of glowing at night.
 */
export function unitLook<T extends THREE.Material>(m: T, cfg: LookCfg): T {
  if (m.userData.unitLook) return m;
  m.userData.unitLook = true;
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey();
  const key = `${prevKey}|look${cfg.rim}${cfg.team ? 'T' : ''}`;
  m.onBeforeCompile = function (this: THREE.Material, shader, renderer) {
    prev.call(this, shader, renderer);
    let fs = shader.fragmentShader;
    fs = fs.replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
      {
        float uRimF = 1.0 - clamp(dot(normal, geometryViewDir), 0.0, 1.0);
        float uRimK = uRimF * uRimF * uRimF;
        reflectedLight.indirectDiffuse *= 1.0 + ${cfg.rim.toFixed(3)} * 2.2 * uRimK;
        reflectedLight.indirectSpecular += reflectedLight.indirectDiffuse * ${(cfg.rim * 0.35).toFixed(3)} * uRimK;
      }`,
    );
    if (cfg.team && fs.includes('varying float vWDirt;')) {
      fs = fs.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        if (vWDirt < -0.5) totalEmissiveRadiance += diffuseColor.rgb * 0.3;`,
      );
    }
    shader.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => key;
  return m;
}
