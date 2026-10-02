import * as THREE from 'three';

/*
 * Procedural PBR surface textures for the detailed buildings (no image
 * assets), packed into ONE texture atlas so a whole building draws its
 * textured surfaces with a single material (a handful of draw calls per
 * building, bounded memory).
 *
 * The atlas holds ATLAS_COLS x ATLAS_ROWS seamless tiles of TILE px, three
 * maps of the same layout:
 *  - albedo (sRGB): near neutral so the per-vertex tint (team colour, nation
 *    paint) carries the hue; stains / rust / runoff keep a little colour.
 *    Camouflage tiles store a palette index in R (0, 1/3, 2/3, 1) and a grime
 *    factor in G: the building shader maps them onto the nation's 4 colours.
 *  - normal (tangent space, from a height field)
 *  - rough/metal: roughness in G, metalness in B (three's channel layout, so
 *    one texture serves both maps).
 * Buildings carry the tile index per vertex (uv1.x); the shader wraps the
 * tile UV with fract() and samples with textureGrad on the unwrapped UV, so
 * mip selection stays seamless (see `atlasPatch`).
 *
 * Every tile is built from three precomputed tileable noise fields (cheap
 * lookups instead of per-pixel fbm), so the whole atlas generates in a few
 * hundred ms even on a phone, once, lazily.
 *
 * Also here: the shared sign/stencil atlas (canvas text in every nation's
 * script, drawn on demand into cells of one texture) and the per-nation camo
 * net texture (alpha cut garnish).
 */

/** Atlas tile ids (stored per vertex in uv1.x). */
export enum Tile {
  Panel = 0, // precast concrete panels: seams, tie holes, rust streaks, runoff, edge wear
  Cast = 1, // cast-in-place concrete: formwork lines, blotches, stains
  Corr = 2, // corrugated steel sheet with rust streaks
  Plate = 3, // heavy steel plates, bevelled seams, rivets
  Paint = 4, // painted metal: orange peel, chips
  Clad = 5, // composite cladding: trapezoid ribs, joints, bolt rows
  CamoA = 6, // woodland / blob camo (palette)
  CamoB = 7, // digital / pixel camo (palette)
  CamoC = 8, // flecktarn dots (palette)
  Bag = 9, // sandbag / hesco geotextile
  Canvas = 10, // canvas tarp
  Asphalt = 11,
  Soil = 12, // soil / gravel
  Brick = 13,
  Plaster = 14,
  Grate = 15, // steel grating
  Wood = 16,
  RoofTile = 17, // East Asian curved roof tiles
  Hazard = 18, // yellow / black stripes (coloured)
  Stone = 19, // coursed sandstone blocks
}

export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 5;
const T = 256;
const AW = ATLAS_COLS * T;
const AH = ATLAS_ROWS * T;

// ------------------------------------------------------------------ noise fields

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
/** Tileable fbm field T x T (base frequency f cells per tile). */
function field(f: number, oct: number, s: number): Float32Array {
  const out = new Float32Array(T * T);
  let norm = 0;
  for (let o = 0, a = 0.5; o < oct; o++, a *= 0.5) norm += a;
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      let sum = 0;
      let amp = 0.5;
      let fq = f;
      for (let o = 0; o < oct; o++) {
        sum += vnoise((x / T) * fq, (y / T) * fq, fq, s + o * 17) * amp;
        amp *= 0.5;
        fq *= 2;
      }
      out[y * T + x] = sum / norm;
    }
  return out;
}

let F: { lo: Float32Array; mid: Float32Array; hi: Float32Array } | null = null;
function fields() {
  if (!F) F = { lo: field(3, 4, 101), mid: field(12, 3, 202), hi: field(48, 2, 303) };
  return F;
}
/** Sample a field at integer-scaled, offset coordinates (keeps tiling: k must be an integer). */
function at(f: Float32Array, x: number, y: number, kx = 1, ky = 1, ox = 0, oy = 0) {
  const xi = (((Math.floor(x * kx + ox) % T) + T) % T) | 0;
  const yi = (((Math.floor(y * ky + oy) % T) + T) % T) | 0;
  return f[yi * T + xi];
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const frac = (x: number) => x - Math.floor(x);
/** Distance (tile fraction) to the nearest line of a grid with n lines per tile. */
const lineD = (t: number, n: number) => {
  const f = frac(t * n);
  return Math.min(f, 1 - f) / n;
};

/** Per pixel output: albedo rgb, height, roughness, metalness. */
interface Px {
  r: number;
  g: number;
  b: number;
  h: number;
  ro: number;
  me: number;
}
/** x, y in pixels (0..T); u, v = x / T, y / T. On walls v increases UPWARD. */
type Gen = (x: number, y: number, u: number, v: number, o: Px) => void;

const grey = (o: Px, c: number) => {
  o.r = o.g = o.b = c;
};

/** Rust / runoff colour helpers: blend albedo towards a stain colour. */
function stain(o: Px, k: number, r: number, g: number, b: number) {
  if (k <= 0) return;
  o.r += (r - o.r) * k;
  o.g += (g - o.g) * k;
  o.b += (b - o.b) * k;
}

const GENS: { tile: Tile; strength: number; gen: Gen }[] = [
  {
    tile: Tile.Panel,
    strength: 3.0,
    gen(x, y, u, v, o) {
      const { lo, mid, hi } = fields();
      // 2 x 2 precast panels per tile, recessed joints, 4 tie holes per panel
      const ju = lineD(u, 2);
      const jv = lineD(v, 2);
      const joint = 1 - sstep(0.004, 0.01, Math.min(ju, jv));
      const bevel = sstep(0.004, 0.022, Math.min(ju, jv));
      const pu = frac(u * 2);
      const pv = frac(v * 2);
      const hu = Math.min(Math.abs(pu - 0.22), Math.abs(pu - 0.78));
      const hv = Math.min(Math.abs(pv - 0.25), Math.abs(pv - 0.75));
      const hole = 1 - sstep(0.012, 0.022, Math.hypot(hu, hv));
      // runoff streaks: below the tie holes and the horizontal joints (v up = wall up)
      const col = at(mid, x, y, 4, 1, 37, 11);
      const hv0 = pv < 0.25 ? 0.25 : pv < 0.75 ? 0.75 : 1.25; // nearest hole row above
      const dHole = hv0 - pv; // distance below that row
      const runHole = (1 - sstep(0.004, 0.022, hu)) * clamp01(1 - dHole / 0.32) * (0.6 + 0.4 * at(mid, x, y, 1, 2, 3, 3));
      const runJoint = clamp01((col - 0.5) * 3) * clamp01(1 - (1 - pv) * 1.6);
      const rust = clamp01(runHole * 1.4) * (0.5 + 0.5 * at(hi, x, y, 1, 1, 5, 9));
      const blot = clamp01((at(lo, x, y, 1, 1, 17, 3) - 0.45) * 2.2);
      const edge = (1 - sstep(0.006, 0.03, Math.min(ju, jv))) * clamp01((at(hi, x, y, 1, 1, 91, 7) - 0.4) * 3);
      const pid = hash(Math.floor(u * 2), Math.floor(v * 2), 7);
      const pores = at(hi, x, y, 2, 2, 3, 41);
      let c = 0.84 + (pid - 0.5) * 0.07 - blot * 0.1 - runJoint * 0.14 + edge * 0.08 + (pores - 0.5) * 0.06 - joint * 0.3 - hole * 0.4;
      grey(o, clamp01(c));
      stain(o, rust * 0.75, 0.48, 0.27, 0.14);
      stain(o, runJoint * blot * 0.3, 0.42, 0.44, 0.36);
      o.h = 0.55 + bevel * 0.25 - joint * 0.3 - hole * 0.35 + (pores - 0.5) * 0.06 - edge * 0.05;
      o.ro = clamp01(0.86 - runJoint * 0.18 + blot * 0.06 - rust * 0.1);
      o.me = 0;
    },
  },
  {
    tile: Tile.Cast,
    strength: 2.2,
    gen(x, y, u, v, o) {
      const { lo, mid, hi } = fields();
      // formwork board lines (horizontal) and snap-tie dots, large blotches
      const board = 1 - sstep(0.002, 0.006, lineD(v, 6));
      const tie = 1 - sstep(0.008, 0.014, Math.hypot(lineD(u, 4), lineD(v - 1 / 12, 3)));
      const blot = at(lo, x, y, 1, 1, 60, 20);
      const m = at(mid, x, y, 1, 1, 13, 77);
      const pores = at(hi, x, y, 2, 2, 50, 9);
      const streak = clamp01((at(mid, x, y, 4, 1, 3, 30) - 0.55) * 3) * 0.6;
      const c = 0.8 - (blot - 0.5) * 0.18 - (m - 0.5) * 0.08 - streak * 0.12 + (pores - 0.5) * 0.08 - board * 0.06 - tie * 0.25;
      grey(o, clamp01(c));
      stain(o, streak * 0.25, 0.36, 0.38, 0.3);
      o.h = 0.5 + (pores - 0.5) * 0.12 - board * 0.08 - tie * 0.2 + (m - 0.5) * 0.06;
      o.ro = clamp01(0.88 + (blot - 0.5) * 0.1);
      o.me = 0;
    },
  },
  {
    tile: Tile.Corr,
    strength: 3.6,
    gen(x, y, u, v, o) {
      const { lo, mid, hi } = fields();
      // 12 trapezoidal ribs across, sheet laps every half tile, screw rows
      const p = frac(u * 12);
      const prof = sstep(0.1, 0.25, p) - sstep(0.6, 0.75, p);
      const lap = 1 - sstep(0.002, 0.007, lineD(v, 2));
      const sv = lineD(v - 0.02, 2);
      const screw = 1 - sstep(0.004, 0.008, Math.hypot(lineD(u + 1 / 48, 12), sv));
      const streakN = at(mid, x, y, 8, 1, 21, 9);
      // rust streaks running down from the screw row under each lap
      const rustRun = clamp01((streakN - 0.55) * 4) * clamp01(1 - (1 - frac(v * 2)) * 1.8) * 0.9;
      const patch = clamp01((at(lo, x, y, 1, 1, 70, 40) - 0.62) * 4);
      const grain = at(hi, x, y, 1, 4, 0, 0);
      let c = 0.82 + prof * 0.06 - lap * 0.25 + (grain - 0.5) * 0.06;
      grey(o, clamp01(c));
      stain(o, clamp01(rustRun + patch * 0.8) * 0.8, 0.5, 0.26, 0.12);
      o.h = 0.3 + prof * 0.5 - lap * 0.2 + screw * 0.15;
      o.ro = clamp01(0.45 + rustRun * 0.4 + patch * 0.35 + (grain - 0.5) * 0.15);
      o.me = clamp01(0.6 - patch * 0.5 - rustRun * 0.4);
    },
  },
  {
    tile: Tile.Plate,
    strength: 3.6,
    gen(x, y, u, v, o) {
      const { lo, mid, hi } = fields();
      const row = Math.floor(v * 2);
      const uu = u + (row % 2) * 0.25;
      const su = lineD(uu, 2);
      const sv = lineD(v, 2);
      const seam = Math.min(su, sv);
      const bevel = sstep(0.0, 0.012, seam);
      const groove = 1 - sstep(0.002, 0.006, seam);
      const nearU = Math.hypot(lineD(uu + 0.025, 20) * 1, su - 0.02);
      const nearV = Math.hypot(lineD(v + 0.025, 20), sv - 0.02);
      const rivet = 1 - sstep(0.004, 0.0075, Math.min(nearU, nearV));
      const pid = hash(Math.floor(uu * 2) & 1, row & 1, 3);
      const scuff = clamp01((at(mid, x, y, 1, 4, 9, 0) - 0.55) * 3);
      const grime = clamp01((at(lo, x, y, 1, 1, 33, 7) - 0.5) * 2.5);
      const edgeWear = (1 - sstep(0.008, 0.03, seam)) * clamp01((at(hi, x, y, 1, 1, 4, 4) - 0.4) * 2);
      const c = 0.8 + (pid - 0.5) * 0.08 - grime * 0.12 + edgeWear * 0.12 + scuff * 0.06 - groove * 0.3 - rivet * 0.06;
      grey(o, clamp01(c));
      stain(o, grime * 0.25, 0.42, 0.33, 0.24);
      o.h = 0.35 + bevel * 0.4 + rivet * 0.3 + (at(hi, x, y, 2, 2, 7, 1) - 0.5) * 0.03;
      o.ro = clamp01(0.4 + grime * 0.25 - edgeWear * 0.18 + (pid - 0.5) * 0.12 - scuff * 0.12);
      o.me = clamp01(0.72 - grime * 0.3 + edgeWear * 0.2);
    },
  },
  {
    tile: Tile.Paint,
    strength: 1.4,
    gen(x, y, _u, _v, o) {
      const { lo, mid, hi } = fields();
      const mott = at(lo, x, y, 1, 1, 90, 30);
      const peel = at(hi, x, y, 1, 1, 13, 61);
      const chip = clamp01((at(mid, x, y, 1, 1, 44, 2) - 0.68) * 5);
      const drip = clamp01((at(mid, x, y, 8, 1, 5, 99) - 0.58) * 2.5) * 0.5;
      grey(o, clamp01(0.95 - (mott - 0.5) * 0.08 - chip * 0.12 - drip * 0.08));
      stain(o, chip * 0.5, 0.45, 0.38, 0.32);
      o.h = 0.5 + (peel - 0.5) * 0.1 - chip * 0.15;
      o.ro = clamp01(0.58 + (mott - 0.5) * 0.25 + chip * 0.25 + drip * 0.12);
      o.me = clamp01(0.12 + chip * 0.4);
    },
  },
  {
    tile: Tile.Clad,
    strength: 3.0,
    gen(x, y, u, v, o) {
      const { lo, mid, hi } = fields();
      const pu = frac(u * 4);
      const major = Math.min(pu, 1 - pu) * 4;
      const rib = 1 - sstep(0.018, 0.045, major);
      const minor = Math.min(Math.abs(pu - 0.333), Math.abs(pu - 0.667));
      const mrib = 1 - sstep(0.012, 0.03, minor);
      const jv = lineD(v, 1);
      const joint = 1 - sstep(0.004, 0.012, jv);
      const bd = Math.hypot(lineD(u, 24), Math.abs(jv - 0.022));
      const bolt = 1 - sstep(0.0035, 0.0065, bd);
      const streak = clamp01((at(mid, x, y, 8, 1, 17, 3) - 0.5) * 3) * (1 - sstep(0.0, 0.55, 1 - frac(v))) * 0.55;
      const blot = clamp01((at(lo, x, y, 1, 1, 8, 51) - 0.5) * 2.2);
      const wear = rib * clamp01((at(hi, x, y, 1, 1, 70, 3) - 0.45) * 3);
      const c = 0.88 - 0.06 * blot - 0.16 * streak - 0.22 * joint + 0.06 * wear - bolt * 0.18;
      grey(o, clamp01(c));
      stain(o, streak * 0.3, 0.4, 0.36, 0.3);
      o.h = 0.5 + rib * 0.32 + mrib * 0.12 - joint * 0.35 + bolt * 0.25;
      o.ro = clamp01(0.6 + blot * 0.12 + streak * 0.2 - wear * 0.25 - rib * 0.08);
      o.me = clamp01(0.3 + wear * 0.3);
    },
  },
  {
    tile: Tile.CamoA,
    strength: 1.2,
    gen(x, y, _u, _v, o) {
      const { lo, mid, hi } = fields();
      const a = at(lo, x, y, 2, 2, 0, 0) * 0.75 + at(mid, x, y, 1, 1, 0, 0) * 0.25;
      const b = at(lo, x, y, 2, 2, 128, 64) * 0.75 + at(mid, x, y, 1, 1, 64, 128) * 0.25;
      let idx = 0;
      if (a > 0.56) idx = 1;
      if (b > 0.6) idx = 2;
      if (a < 0.38 && b < 0.45) idx = 3;
      o.r = idx / 3;
      o.g = clamp01(0.88 + (at(hi, x, y, 1, 1, 3, 3) - 0.5) * 0.18 - clamp01((at(mid, x, y, 1, 1, 9, 9) - 0.6) * 2) * 0.12);
      o.b = 0;
      o.h = 0.5 + (at(hi, x, y, 1, 1, 30, 30) - 0.5) * 0.15;
      o.ro = 0.78;
      o.me = 0.05;
    },
  },
  {
    tile: Tile.CamoB,
    strength: 1.0,
    gen(x, y, _u, _v, o) {
      const { lo, mid, hi } = fields();
      // pixel camo: quantise the blob fields to 8 px squares
      const qx = Math.floor(x / 8) * 8 + 4;
      const qy = Math.floor(y / 8) * 8 + 4;
      const a = at(lo, qx, qy, 2, 2, 0, 0) * 0.6 + at(mid, qx, qy, 1, 1, 20, 0) * 0.4;
      const b = at(lo, qx, qy, 2, 2, 128, 64) * 0.6 + at(mid, qx, qy, 1, 1, 0, 90) * 0.4;
      let idx = 0;
      if (a > 0.55) idx = 1;
      if (b > 0.58) idx = 2;
      if (a < 0.42 && b < 0.42) idx = 3;
      o.r = idx / 3;
      o.g = clamp01(0.9 + (at(hi, x, y, 1, 1, 3, 3) - 0.5) * 0.16);
      o.b = 0;
      o.h = 0.5 + (at(hi, x, y, 1, 1, 30, 30) - 0.5) * 0.12;
      o.ro = 0.8;
      o.me = 0.05;
    },
  },
  {
    tile: Tile.CamoC,
    strength: 1.0,
    gen(x, y, _u, _v, o) {
      const { lo, mid, hi } = fields();
      // flecktarn: overlapping small dots of three colours on the base
      let idx = 0;
      const dots = (cell: number, s: number, thr: number, id: number) => {
        const cx = Math.floor(x / cell);
        const cy = Math.floor(y / cell);
        for (let j = -1; j <= 1; j++)
          for (let i = -1; i <= 1; i++) {
            const gx = cx + i;
            const gy = cy + j;
            const n = T / cell;
            const hx = hash(((gx % n) + n) % n, ((gy % n) + n) % n, s);
            if (hx > thr) continue;
            const px = (gx + hash(gx, gy, s + 1)) * cell;
            const py = (gy + hash(gx, gy, s + 2)) * cell;
            const r = cell * (0.35 + hash(gx, gy, s + 3) * 0.3);
            let dx = Math.abs(x - px);
            let dy = Math.abs(y - py);
            dx = Math.min(dx, T - dx);
            dy = Math.min(dy, T - dy);
            if (dx * dx + dy * dy < r * r) idx = id;
          }
      };
      dots(14, 11, 0.45, 1);
      dots(10, 23, 0.4, 2);
      dots(8, 37, 0.3, 3);
      o.r = idx / 3;
      o.g = clamp01(0.9 + (at(hi, x, y, 1, 1, 3, 3) - 0.5) * 0.16 - clamp01((at(lo, x, y, 1, 1, 9, 9) - 0.6) * 2) * 0.1);
      o.b = 0;
      o.h = 0.5 + (at(mid, x, y, 1, 1, 30, 30) - 0.5) * 0.1;
      o.ro = 0.8;
      o.me = 0.05;
    },
  },
  {
    tile: Tile.Bag,
    strength: 2.6,
    gen(x, y, u, v, o) {
      const { lo, hi } = fields();
      // woven geotextile with a coarse diamond / grid of bulging fill
      const weave = (Math.sin(x * Math.PI * 0.5) * Math.sin(y * Math.PI * 0.5)) * 0.5 + 0.5;
      const cu = lineD(u, 4);
      const cv = lineD(v, 4);
      const bulge = sstep(0.0, 0.06, Math.min(cu, cv));
      const dirt = clamp01((at(lo, x, y, 1, 1, 5, 80) - 0.45) * 2.4);
      const c = 0.84 - dirt * 0.18 + (weave - 0.5) * 0.06 - (1 - bulge) * 0.12 + (at(hi, x, y, 1, 1, 0, 0) - 0.5) * 0.06;
      grey(o, clamp01(c));
      stain(o, dirt * 0.35, 0.42, 0.34, 0.22);
      o.h = 0.35 + bulge * 0.45 + weave * 0.05;
      o.ro = 0.92;
      o.me = 0;
    },
  },
  {
    tile: Tile.Canvas,
    strength: 1.8,
    gen(x, y, _u, _v, o) {
      const { lo, mid, hi } = fields();
      const weave = (Math.sin(x * Math.PI) * Math.sin(y * Math.PI)) * 0.5 + 0.5;
      const fold = at(mid, x, y, 4, 1, 40, 0);
      const dirt = clamp01((at(lo, x, y, 1, 1, 20, 20) - 0.5) * 2.2);
      grey(o, clamp01(0.86 - dirt * 0.16 + (fold - 0.5) * 0.12 + (weave - 0.5) * 0.04 + (at(hi, x, y, 1, 1, 9, 9) - 0.5) * 0.04));
      o.h = 0.5 + (fold - 0.5) * 0.5 + weave * 0.04;
      o.ro = 0.9;
      o.me = 0;
    },
  },
  {
    tile: Tile.Asphalt,
    strength: 1.6,
    gen(x, y, _u, _v, o) {
      const { lo, mid, hi } = fields();
      const agg = at(hi, x, y, 2, 2, 11, 3);
      const patch = clamp01((at(lo, x, y, 1, 1, 200, 10) - 0.6) * 5);
      const crack = 1 - sstep(0.0, 0.012, Math.abs(at(mid, x, y, 1, 1, 0, 0) - 0.5));
      const c = 0.52 + (agg - 0.5) * 0.18 - patch * 0.12 - crack * 0.18 + (at(lo, x, y, 1, 1, 30, 30) - 0.5) * 0.1;
      grey(o, clamp01(c));
      o.h = 0.5 + (agg - 0.5) * 0.3 - crack * 0.3;
      o.ro = clamp01(0.9 - patch * 0.1);
      o.me = 0;
    },
  },
  {
    tile: Tile.Soil,
    strength: 2.2,
    gen(x, y, _u, _v, o) {
      const { lo, mid, hi } = fields();
      const pebble = clamp01((at(hi, x, y, 2, 2, 31, 7) - 0.62) * 4);
      const m = at(mid, x, y, 1, 1, 5, 5);
      const l = at(lo, x, y, 1, 1, 99, 9);
      grey(o, clamp01(0.7 + (m - 0.5) * 0.25 + (l - 0.5) * 0.15 + pebble * 0.12));
      stain(o, clamp01((l - 0.5) * 2) * 0.2, 0.5, 0.4, 0.28);
      o.h = 0.4 + m * 0.3 + pebble * 0.3;
      o.ro = 0.95;
      o.me = 0;
    },
  },
  {
    tile: Tile.Brick,
    strength: 2.8,
    gen(x, y, u, v, o) {
      const { lo, hi } = fields();
      const rows = 16;
      const row = Math.floor(v * rows);
      const uu = u * 8 + (row % 2) * 0.5;
      const mu = Math.min(frac(uu), 1 - frac(uu)) / 8;
      const mv = lineD(v, rows);
      const mortar = 1 - sstep(0.002, 0.005, Math.min(mu, mv));
      const bid = hash(Math.floor(uu) % 8, row, 5);
      const soot = clamp01((at(lo, x, y, 1, 1, 77, 7) - 0.55) * 2);
      const c = mortar ? 0.82 : 0.7 + (bid - 0.5) * 0.2 - soot * 0.2 + (at(hi, x, y, 1, 1, 0, 0) - 0.5) * 0.08;
      if (mortar > 0.5) grey(o, clamp01(c));
      else {
        o.r = clamp01(c * 1.0);
        o.g = clamp01(c * 0.62);
        o.b = clamp01(c * 0.5);
      }
      o.h = mortar > 0.5 ? 0.25 : 0.6 + (at(hi, x, y, 1, 1, 9, 9) - 0.5) * 0.1;
      o.ro = 0.88;
      o.me = 0;
    },
  },
  {
    tile: Tile.Plaster,
    strength: 1.4,
    gen(x, y, _u, v, o) {
      const { lo, mid, hi } = fields();
      const trowel = at(mid, x, y, 1, 1, 50, 50);
      const dirt = clamp01((at(lo, x, y, 1, 1, 7, 7) - 0.5) * 2) * 0.5 + clamp01((at(mid, x, y, 8, 1, 3, 3) - 0.6) * 3) * clamp01(1 - frac(v) * 1.5) * 0.5;
      const crack = 1 - sstep(0.0, 0.006, Math.abs(at(lo, x, y, 2, 2, 40, 0) - 0.5));
      grey(o, clamp01(0.94 - (trowel - 0.5) * 0.08 - dirt * 0.16 - crack * 0.15));
      stain(o, dirt * 0.2, 0.55, 0.47, 0.36);
      o.h = 0.5 + (trowel - 0.5) * 0.2 + (at(hi, x, y, 1, 1, 0, 0) - 0.5) * 0.06 - crack * 0.2;
      o.ro = 0.9;
      o.me = 0;
    },
  },
  {
    tile: Tile.Grate,
    strength: 3.0,
    gen(x, y, u, v, o) {
      const { lo } = fields();
      const bu = lineD(u, 16);
      const bv = lineD(v, 48);
      const bar = 1 - sstep(0.004, 0.008, bu);
      const cross = 1 - sstep(0.0015, 0.004, bv);
      const metal = Math.max(bar, cross * 0.8);
      const dirt = clamp01((at(lo, x, y, 1, 1, 3, 3) - 0.5) * 2);
      grey(o, clamp01(0.12 + metal * (0.62 - dirt * 0.2)));
      o.h = 0.1 + metal * 0.8;
      o.ro = clamp01(0.85 - metal * 0.4);
      o.me = metal * 0.7;
    },
  },
  {
    tile: Tile.Wood,
    strength: 2.0,
    gen(x, y, _u, v, o) {
      const { mid, hi } = fields();
      const plank = lineD(v, 8);
      const gap = 1 - sstep(0.002, 0.005, plank);
      const pid = hash(Math.floor(v * 8), 1, 9);
      const grain = at(hi, x, y, 1, 8, Math.floor(pid * 200), 0) * 0.5 + at(mid, x, y, 1, 4, 0, 0) * 0.5;
      const c = 0.72 + (pid - 0.5) * 0.15 + (grain - 0.5) * 0.18 - gap * 0.4;
      o.r = clamp01(c);
      o.g = clamp01(c * 0.82);
      o.b = clamp01(c * 0.62);
      o.h = 0.55 - gap * 0.4 + (grain - 0.5) * 0.1;
      o.ro = 0.85;
      o.me = 0;
    },
  },
  {
    tile: Tile.RoofTile,
    strength: 3.0,
    gen(x, y, u, v, o) {
      const { lo, hi } = fields();
      const p = frac(u * 8);
      const curve = Math.sin(p * Math.PI);
      const course = frac(v * 10);
      const lip = sstep(0.75, 0.95, course);
      const dirt = clamp01((at(lo, x, y, 1, 1, 15, 15) - 0.5) * 2);
      grey(o, clamp01(0.78 + curve * 0.12 - (1 - course) * 0.08 - dirt * 0.15 + (at(hi, x, y, 1, 1, 0, 0) - 0.5) * 0.05));
      o.h = 0.25 + curve * 0.45 + lip * 0.2;
      o.ro = 0.55 + dirt * 0.2;
      o.me = 0.05;
    },
  },
  {
    tile: Tile.Hazard,
    strength: 1.0,
    gen(x, y, u, v, o) {
      const { lo, hi } = fields();
      const s = frac((u + v) * 4);
      const black = s > 0.5 ? 1 : 0;
      const wear = clamp01((at(hi, x, y, 1, 1, 0, 0) - 0.62) * 4) * 0.6 + clamp01((at(lo, x, y, 1, 1, 0, 0) - 0.6) * 2) * 0.3;
      if (black) grey(o, 0.08 + wear * 0.25);
      else {
        o.r = 0.9 - wear * 0.3;
        o.g = 0.68 - wear * 0.2;
        o.b = 0.1 + wear * 0.15;
      }
      o.h = 0.5 - wear * 0.2;
      o.ro = 0.6 + wear * 0.25;
      o.me = 0.1;
    },
  },
  {
    tile: Tile.Stone,
    strength: 2.4,
    gen(x, y, u, v, o) {
      const { lo, mid, hi } = fields();
      const rows = 6;
      const row = Math.floor(v * rows);
      const uu = u * 3 + (row % 2) * 0.5 + hash(row, 2, 3) * 0.2;
      const ju = Math.min(frac(uu), 1 - frac(uu)) / 3;
      const jv = lineD(v, rows);
      const joint = 1 - sstep(0.003, 0.007, Math.min(ju, jv));
      const sid = hash(Math.floor(uu), row, 11);
      const tex = at(mid, x, y, 1, 1, 30, 70);
      const c = 0.86 + (sid - 0.5) * 0.1 + (tex - 0.5) * 0.12 - joint * 0.25 - clamp01((at(lo, x, y, 1, 1, 4, 4) - 0.55) * 2) * 0.1;
      o.r = clamp01(c);
      o.g = clamp01(c * 0.95);
      o.b = clamp01(c * 0.86);
      o.h = 0.55 - joint * 0.35 + (at(hi, x, y, 1, 1, 0, 0) - 0.5) * 0.12;
      o.ro = 0.88;
      o.me = 0;
    },
  },
];

export interface AtlasSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  rmMap: THREE.Texture;
}

function makeTex(data: Uint8ClampedArray, srgb: boolean): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = AW;
  cv.height = AH;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(AW, AH);
  img.data.set(data);
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  return t;
}

let atlas: AtlasSet | null = null;

/** The shared building texture atlas (generated once, lazily). */
export function bldAtlas(): AtlasSet {
  if (atlas) return atlas;
  const alb = new Uint8ClampedArray(AW * AH * 4);
  const nrm = new Uint8ClampedArray(AW * AH * 4);
  const rm = new Uint8ClampedArray(AW * AH * 4);
  const h = new Float32Array(T * T);
  const o: Px = { r: 0, g: 0, b: 0, h: 0, ro: 0, me: 0 };
  for (const { tile, strength, gen } of GENS) {
    const ox = (tile % ATLAS_COLS) * T;
    const oy = Math.floor(tile / ATLAS_COLS) * T;
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++) {
        gen(x, y, (x + 0.5) / T, (y + 0.5) / T, o);
        // canvas row 0 is the top of the image; three flips Y on upload so tile row y maps to v = 1 - y / T.
        // Generators treat v as "up the wall" (worldUV maps wall height to -v), so write rows as generated.
        const i = ((oy + y) * AW + ox + x) * 4;
        alb[i] = o.r * 255;
        alb[i + 1] = o.g * 255;
        alb[i + 2] = o.b * 255;
        alb[i + 3] = 255;
        rm[i] = 255;
        rm[i + 1] = o.ro * 255;
        rm[i + 2] = o.me * 255;
        rm[i + 3] = 255;
        h[y * T + x] = o.h;
      }
    const H = (xx: number, yy: number) => h[((yy + T) % T) * T + ((xx + T) % T)];
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++) {
        const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1) - H(x - 1, y - 1) - 2 * H(x - 1, y) - H(x - 1, y + 1)) * strength;
        const dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1) - H(x - 1, y - 1) - 2 * H(x, y - 1) - H(x + 1, y - 1)) * strength;
        const len = Math.hypot(dx, dy, 1);
        const i = ((oy + y) * AW + ox + x) * 4;
        nrm[i] = ((-dx / len) * 0.5 + 0.5) * 255;
        nrm[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
        nrm[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
        nrm[i + 3] = 255;
      }
  }
  atlas = { map: makeTex(alb, true), normalMap: makeTex(nrm, false), rmMap: makeTex(rm, false) };
  return atlas;
}

/**
 * Shader patch for a MeshStandardMaterial using the atlas (map, normalMap,
 * roughnessMap = metalnessMap = rmMap). `pal` holds the 4 camo colours
 * (linear) used by the camo tiles. Chain it into onBeforeCompile.
 */
export function atlasPatch(sh: THREE.WebGLProgramParametersWithUniforms, pal: { value: THREE.Color[] }) {
  sh.uniforms.bPal = pal;
  sh.vertexShader = sh.vertexShader
    .replace(
      '#include <common>',
      `#include <common>
      #ifndef USE_UV1
      attribute vec2 uv1;
      #endif
      flat varying float vBTile;`,
    )
    .replace('#include <uv_vertex>', '#include <uv_vertex>\nvBTile = uv1.x;');
  const C = THREE.ShaderChunk;
  sh.fragmentShader = sh.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
      flat varying float vBTile;
      uniform vec3 bPal[4];
      vec4 bAtlas( sampler2D t, vec2 uv ) {
        float ti = floor( vBTile + 0.5 );
        vec2 cell = vec2( mod( ti, ${ATLAS_COLS}.0 ), ${ATLAS_ROWS - 1}.0 - floor( ti / ${ATLAS_COLS}.0 ) );
        const vec2 GRID = vec2( ${ATLAS_COLS}.0, ${ATLAS_ROWS}.0 );
        const float IN = 1.5 / ${T}.0;
        vec2 f = fract( uv );
        vec2 auv = ( cell + IN + f * ( 1.0 - 2.0 * IN ) ) / GRID;
        vec2 gx = dFdx( uv ) / GRID;
        vec2 gy = dFdy( uv ) / GRID;
        // keep mips above ~16 px per tile so neighbouring tiles never bleed in
        float g = max( length( gx ), length( gy ) ) * ${T * ATLAS_COLS}.0;
        float k = g > 12.0 ? 12.0 / g : 1.0;
        return textureGrad( t, auv, gx * k, gy * k );
      }`,
    )
    .replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
        vec4 sampledDiffuseColor = bAtlas( map, vMapUv );
        float bt = floor( vBTile + 0.5 );
        if ( bt > 5.5 && bt < 8.5 ) {
          // camo tile: palette index in R (stored sRGB: undo the decode), grime in G
          float lv = pow( sampledDiffuseColor.r, 1.0 / 2.2 ) * 3.0;
          vec3 pc = lv < 0.5 ? bPal[0] : lv < 1.5 ? bPal[1] : lv < 2.5 ? bPal[2] : bPal[3];
          sampledDiffuseColor.rgb = pc * pow( sampledDiffuseColor.g, 1.0 / 2.2 );
        }
        diffuseColor *= sampledDiffuseColor;
      #endif`,
    )
    .replace('#include <roughnessmap_fragment>', C.roughnessmap_fragment.replace('texture2D( roughnessMap, vRoughnessMapUv )', 'bAtlas( roughnessMap, vRoughnessMapUv )'))
    .replace('#include <metalnessmap_fragment>', C.metalnessmap_fragment.replace('texture2D( metalnessMap, vMetalnessMapUv )', 'bAtlas( metalnessMap, vMetalnessMapUv )'))
    .replace('#include <normal_fragment_maps>', C.normal_fragment_maps.replace('texture2D( normalMap, vNormalMapUv )', 'bAtlas( normalMap, vNormalMapUv )'));
}

// ================================================================ signs

const SW = 1024;
const SH = 1024;
const CW = 256;
const CH = 64;
const signCells = new Map<string, number>();
let signCanvas: HTMLCanvasElement | null = null;
let signTex: THREE.CanvasTexture | null = null;

/** Shared sign atlas texture (cells of 256 x 64 px). */
export function signTexture(): THREE.CanvasTexture {
  if (!signTex) {
    signCanvas = document.createElement('canvas');
    signCanvas.width = SW;
    signCanvas.height = SH;
    signTex = new THREE.CanvasTexture(signCanvas);
    signTex.colorSpace = THREE.SRGBColorSpace;
    signTex.anisotropy = 4;
    signTex.generateMipmaps = true;
    signTex.minFilter = THREE.LinearMipmapLinearFilter;
  }
  return signTex;
}

export interface SignSpec {
  text: string;
  /** Second, smaller line. */
  sub?: string;
  fg: string;
  /** Board colour; undefined = transparent stencil. */
  bg?: string;
  /** Border colour (boards only). */
  border?: string;
  /** Font family list (script specific). */
  font?: string;
  /** Right-to-left script. */
  rtl?: boolean;
  /** Small emblem drawn at the left of the board: 'star' | 'cross' | 'trident' | 'crescent' | 'disc'. */
  mark?: string;
  markColor?: string;
}

function drawMark(c: CanvasRenderingContext2D, kind: string, x: number, y: number, r: number, col: string) {
  c.fillStyle = col;
  c.strokeStyle = col;
  c.beginPath();
  if (kind === 'star') {
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 ? r * 0.42 : r;
      if (i) c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      else c.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    c.closePath();
    c.fill();
  } else if (kind === 'cross') {
    // Bundeswehr Balkenkreuz: white bordered black cross
    const t = r * 0.42;
    c.fillStyle = '#f2f2f2';
    c.fillRect(x - r, y - t * 1.3, r * 2, t * 2.6);
    c.fillRect(x - t * 1.3, y - r, t * 2.6, r * 2);
    c.fillStyle = col;
    c.fillRect(x - r * 0.86, y - t * 0.7, r * 1.72, t * 1.4);
    c.fillRect(x - t * 0.7, y - r * 0.86, t * 1.4, r * 1.72);
  } else if (kind === 'magen') {
    // Star of David outline
    c.lineWidth = r * 0.2;
    for (const rot of [-Math.PI / 2, Math.PI / 2]) {
      c.beginPath();
      for (let i = 0; i < 3; i++) {
        const a = rot + (i * Math.PI * 2) / 3;
        if (i) c.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        else c.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      }
      c.closePath();
      c.stroke();
    }
  } else if (kind === 'taeguk') {
    c.fillStyle = '#c8102e';
    c.arc(x, y, r, Math.PI, 0);
    c.fill();
    c.beginPath();
    c.fillStyle = '#003478';
    c.arc(x, y, r, 0, Math.PI);
    c.fill();
    c.beginPath();
    c.fillStyle = '#c8102e';
    c.arc(x - r / 2, y, r / 2, 0, Math.PI);
    c.fill();
    c.beginPath();
    c.fillStyle = '#003478';
    c.arc(x + r / 2, y, r / 2, Math.PI, 0);
    c.fill();
  } else if (kind === 'trident') {
    c.lineWidth = r * 0.22;
    c.moveTo(x, y - r);
    c.lineTo(x, y + r);
    c.moveTo(x - r * 0.7, y - r * 0.8);
    c.quadraticCurveTo(x - r * 0.7, y + r * 0.6, x, y + r * 0.6);
    c.quadraticCurveTo(x + r * 0.7, y + r * 0.6, x + r * 0.7, y - r * 0.8);
    c.stroke();
  } else if (kind === 'crescent') {
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
    c.globalCompositeOperation = 'destination-out';
    c.beginPath();
    c.arc(x + r * 0.3, y, r * 0.8, 0, Math.PI * 2);
    c.fill();
    c.globalCompositeOperation = 'source-over';
  } else {
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }
}

/** Cell uv rect [u0, v0, u1, v1] of a sign (drawn on first use). */
export function signCell(key: string, s: SignSpec): [number, number, number, number] {
  signTexture();
  let i = signCells.get(key);
  if (i === undefined) {
    i = signCells.size;
    const n = (SW / CW) * (SH / CH);
    if (i >= n) i = n - 1;
    else signCells.set(key, i);
    const cx = (i % (SW / CW)) * CW;
    const cy = Math.floor(i / (SW / CW)) * CH;
    const c = signCanvas!.getContext('2d')!;
    c.save();
    c.beginPath();
    c.rect(cx, cy, CW, CH);
    c.clip();
    c.clearRect(cx, cy, CW, CH);
    if (s.bg) {
      c.fillStyle = s.border ?? s.bg;
      c.fillRect(cx, cy, CW, CH);
      c.fillStyle = s.bg;
      c.fillRect(cx + 4, cy + 4, CW - 8, CH - 8);
    }
    let x0 = cx + 8;
    if (s.mark) {
      drawMark(c, s.mark, cx + 34, cy + CH / 2, 22, s.markColor ?? s.fg);
      x0 = cx + 62;
    }
    const font = s.font ?? 'Arial, "DejaVu Sans", sans-serif';
    c.fillStyle = s.fg;
    c.textBaseline = 'middle';
    c.textAlign = 'center';
    if (s.rtl) c.direction = 'rtl';
    const mid = (x0 + cx + CW - 8) / 2;
    const maxW = cx + CW - 8 - x0;
    const fit = (txt: string, px: number) => {
      let sz = px;
      c.font = `bold ${sz}px ${font}`;
      while (sz > 10 && c.measureText(txt).width > maxW) {
        sz -= 2;
        c.font = `bold ${sz}px ${font}`;
      }
    };
    if (s.sub) {
      fit(s.text, 30);
      c.fillText(s.text, mid, cy + 23, maxW);
      fit(s.sub, 16);
      c.fillText(s.sub, mid, cy + 50, maxW);
    } else {
      fit(s.text, 40);
      c.fillText(s.text, mid, cy + CH / 2 + 2, maxW);
    }
    c.restore();
    signTex!.needsUpdate = true;
  }
  const cx = (i % (SW / CW)) * CW;
  const cy = Math.floor(i / (SW / CW)) * CH;
  // canvas y down, uv v up (flipY)
  return [cx / SW, 1 - (cy + CH) / SH, (cx + CW) / SW, 1 - cy / SH];
}

// ================================================================ camo net

const netCache = new Map<string, THREE.CanvasTexture>();

/** Camo net (alpha cut leaf garnish over a mesh), coloured with the nation's 4 camo colours. */
export function netTexture(cols: number[]): THREE.CanvasTexture {
  const key = cols.join(',');
  let t = netCache.get(key);
  if (t) return t;
  const N = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const c = cv.getContext('2d')!;
  c.clearRect(0, 0, N, N);
  const css = (v: number) => '#' + v.toString(16).padStart(6, '0');
  // net strings
  c.strokeStyle = css(cols[2] ?? 0x333333);
  c.lineWidth = 2;
  for (let i = -N; i < N * 2; i += 16) {
    c.beginPath();
    c.moveTo(i, 0);
    c.lineTo(i + N, N);
    c.stroke();
    c.beginPath();
    c.moveTo(i + N, 0);
    c.lineTo(i, N);
    c.stroke();
  }
  // leaf garnish: many small irregular blobs (wrap around the edges)
  let s = 12345;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let k = 0; k < 520; k++) {
    const x = rnd() * N;
    const y = rnd() * N;
    const r = 4 + rnd() * 8;
    const ci = rnd();
    c.fillStyle = css(ci < 0.45 ? cols[0] : ci < 0.75 ? cols[1] : ci < 0.9 ? cols[3] : cols[2]);
    for (const [dx, dy] of [
      [0, 0],
      [N, 0],
      [-N, 0],
      [0, N],
      [0, -N],
    ]) {
      c.beginPath();
      const a0 = rnd() * Math.PI;
      for (let j = 0; j < 5; j++) {
        const a = a0 + (j / 5) * Math.PI * 2;
        const rr = r * (0.6 + ((j * 7 + k) % 5) * 0.12);
        const px = x + dx + Math.cos(a) * rr;
        const py = y + dy + Math.sin(a) * rr * 0.6;
        if (j) c.lineTo(px, py);
        else c.moveTo(px, py);
      }
      c.closePath();
      c.fill();
    }
  }
  t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  netCache.set(key, t);
  return t;
}
