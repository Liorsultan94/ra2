import * as THREE from 'three';
import { Tile, groundHeight, type Biome, type GameMap } from '../sim/map';
import { fbm, valueNoise } from '../sim/rng';
import type { FogOfWar } from './fog';
import type { SceneryLod } from './geo';
import { surfaceHeight } from './ground';
import { assetBase, fetchBitmap } from './photoground';
import { rockTexture } from './terraintex';
import { strataGlsl } from './strata';

/*
 * Relief (render only): real rock faces on the map's impassable rock.
 *
 * The simulation's heights stay as they are; units, buildings, roads and
 * bridges all stand on passable tiles, so nothing here may rise above the
 * ground outside a Tile.Rock tile. Inside the rock (ridges, desert mesas,
 * winter crags) a fine height field (F samples per tile) lifts the ground into
 * cliffs:
 *  - an exact distance field to the nearest non-rock ground (intersected with
 *    a blurred copy of the rock mask, so the tile staircase of a diagonal
 *    ridge becomes a smooth cliff line) drives a steep cliff profile; at the
 *    rock's border the surface sinks a little under the ground mesh, so it
 *    can never clip anything standing next to it;
 *  - the cliff climbs to the local crest of the sim's own ground (mesas get
 *    their flat cap rock and stepped ledges, the talus below stays the sim's
 *    slope), a ridged noise crest turns the frontline / winter ridges into
 *    jagged ridge lines, a wiggled contour cuts gullies and spurs into the
 *    faces;
 *  - one merged mesh per 24 x 24 tile sector (frustum culled), a half
 *    resolution far LOD, smooth normals;
 *  - triplanar photoscanned rock (the CC0 ground stack's rock layers:
 *    sandstone in the desert, weathered grey rock elsewhere on the faces, the
 *    biome's own rock / moss / snow on top) with sediment strata, crevice
 *    darkening and permanent snow on winter ledges.
 * `reliefHeight()` gives the top of the relief for things that sit on it
 * (rocks.ts lays its photoscanned boulders along the crests; waterfalls).
 */

/** Relief on? (?relief=0 turns the cliffs, waterfalls and spray off for comparisons.) */
export function reliefEnabled(): boolean {
  return !(typeof location !== 'undefined' && /[?&]relief=0\b/.test(location.search));
}

const ON = reliefEnabled();

/** Field samples per tile. */
export const RELIEF_F = 4;
/** How far the relief sinks under the ground at the rock's border. */
const SINK = 0.08;
/** Sector size (tiles) of the merged meshes. */
const SECTOR = 24;

interface Style {
  /** Width (tiles) of the cliff ramp. */
  ramp: number;
  /** Ridged crest height above the local top. */
  crest: number;
  /** Raised lip at the cliff edge. */
  rim: number;
  /** Extra height of the rock wall over the local top (the ridges' faces). */
  wall: number;
  /** Ledges on the cliff (0 = one face). */
  terraces: number;
  /** Contour wiggle (gullies / spurs), tiles. */
  wiggle: number;
}

const STYLE: Record<Biome, Style> = {
  temperate: { ramp: 0.3, crest: 0.5, rim: 0.05, wall: 0.32, terraces: 0, wiggle: 0.5 },
  // South Sinai granite: jagged crests, broken faces
  desert: { ramp: 0.32, crest: 0.5, rim: 0.04, wall: 0.3, terraces: 1, wiggle: 0.5 },
  winter: { ramp: 0.3, crest: 0.46, rim: 0.05, wall: 0.3, terraces: 1, wiggle: 0.5 },
  urban: { ramp: 0.3, crest: 0.4, rim: 0.05, wall: 0.3, terraces: 0, wiggle: 0.5 },
};

export interface ReliefField {
  readonly F: number;
  /** Vertices per row / column: w * F + 1, h * F + 1. */
  readonly NW: number;
  readonly NH: number;
  /** Relief surface height per vertex (only meaningful where d > 0). */
  readonly H: Float32Array;
  /** Distance (tiles) inside the rock; 0 outside / on the border. */
  readonly d: Float32Array;
  /** Horizontal jitter of the vertices (x, z), keeps the faces from looking gridded. */
  readonly jx: Float32Array;
  readonly jz: Float32Array;
  /** Height of the cliff ramp 0..1 per vertex (0 at the foot, 1 on top). */
  readonly p: Float32Array;
  readonly count: number;
  /** Smooth clearance over the relief per tile corner ((w + 1) x (h + 1)): how much aircraft climb to clear it. */
  readonly clr: Float32Array;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Exact Euclidean distance transform (Felzenszwalb): distance in samples from each set sample to the nearest unset one. */
function edt(inside: Uint8Array, W: number, H: number): Float32Array {
  const INF = 1e20;
  const n = Math.max(W, H);
  const f = new Float64Array(n);
  const dd = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const g = new Float64Array(W * H);
  for (let k = 0; k < W * H; k++) g[k] = inside[k] ? INF : 0;
  const pass = (len: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      dd[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  };
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = g[y * W + x];
    pass(H);
    for (let y = 0; y < H; y++) g[y * W + x] = dd[y];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = g[y * W + x];
    pass(W);
    for (let x = 0; x < W; x++) g[y * W + x] = dd[x];
  }
  const out = new Float32Array(W * H);
  for (let k = 0; k < W * H; k++) out[k] = Math.sqrt(g[k]);
  return out;
}

/** Separable box blur (radius r) of a W x H float grid, in place. */
function boxBlur(a: Float32Array, W: number, H: number, r: number) {
  const tmp = new Float32Array(Math.max(W, H));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      let c = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= W) continue;
        s += a[y * W + xx];
        c++;
      }
      tmp[x] = s / c;
    }
    for (let x = 0; x < W; x++) a[y * W + x] = tmp[x];
  }
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let s = 0;
      let c = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= H) continue;
        s += a[yy * W + x];
        c++;
      }
      tmp[y] = s / c;
    }
    for (let y = 0; y < H; y++) a[y * W + x] = tmp[y];
  }
}

const fields = new WeakMap<GameMap, ReliefField>();

/** The map's relief field (built once per map, shared by the cliff meshes, rocks.ts and the waterfalls). */
export function reliefField(m: GameMap): ReliefField {
  let rf = fields.get(m);
  if (rf) return rf;
  const F = RELIEF_F;
  const NW = m.w * F + 1;
  const NH = m.h * F + 1;
  const CW = m.w * F;
  const CH = m.h * F;
  const rockTile = (tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < m.w && ty < m.h && m.tiles[ty * m.w + tx] === Tile.Rock;
  // fine cells: 1 on rock; blurred so the tile staircase rounds off
  const cell = new Float32Array(CW * CH);
  let any = false;
  for (let cj = 0; cj < CH; cj++)
    for (let ci = 0; ci < CW; ci++)
      if (rockTile(Math.floor(ci / F), Math.floor(cj / F))) {
        cell[cj * CW + ci] = 1;
        any = true;
      }
  const N = NW * NH;
  const d = new Float32Array(N);
  const H = new Float32Array(N);
  const jx = new Float32Array(N);
  const jz = new Float32Array(N);
  const p = new Float32Array(N);
  const clr = new Float32Array((m.w + 1) * (m.h + 1));
  if (!any) {
    rf = { F, NW, NH, H, d, jx, jz, p, count: 0, clr };
    fields.set(m, rf);
    return rf;
  }
  const blur = cell.slice();
  boxBlur(blur, CW, CH, Math.round(F * 0.55));
  boxBlur(blur, CW, CH, Math.round(F * 0.4));
  const cellAt = (a: Float32Array, ci: number, cj: number) => (ci < 0 || cj < 0 || ci >= CW || cj >= CH ? 0 : a[cj * CW + ci]);
  const inside = new Uint8Array(N);
  for (let j = 0; j < NH; j++)
    for (let i = 0; i < NW; i++) {
      // strictly inside the rock: all four cells round the vertex are rock tiles
      const strict = cellAt(cell, i - 1, j - 1) + cellAt(cell, i, j - 1) + cellAt(cell, i - 1, j) + cellAt(cell, i, j) === 4;
      if (!strict) continue;
      const sm = (cellAt(blur, i - 1, j - 1) + cellAt(blur, i, j - 1) + cellAt(blur, i - 1, j) + cellAt(blur, i, j)) / 4;
      if (sm > 0.5) inside[j * NW + i] = 1;
    }
  const dist = edt(inside, NW, NH);
  const G = new Float32Array(N);
  let count = 0;
  for (let j = 0; j < NH; j++)
    for (let i = 0; i < NW; i++) {
      const k = j * NW + i;
      d[k] = dist[k] / F;
      if (d[k] > 0) count++;
      // every corner of a rock cell needs the ground height (the meshes only cover rock tiles)
      if (cellAt(cell, i - 1, j - 1) + cellAt(cell, i, j - 1) + cellAt(cell, i - 1, j) + cellAt(cell, i, j) > 0) G[k] = surfaceHeight(m, i / F, j / F);
    }
  const st = STYLE[m.biome] ?? STYLE.temperate;
  // the coloured canyons' sandstone walls: rougher, more broken faces and ragged rims
  const canyonAt = canyonMask(m);
  // local top: the highest rock ground nearby (the sim's crest / mesa top), a separable max filter
  const R = Math.round(1.5 * F);
  const top = new Float32Array(N).fill(-1e9);
  const tmp = new Float32Array(N).fill(-1e9);
  for (let j = 0; j < NH; j++)
    for (let i = 0; i < NW; i++) {
      let mx = -1e9;
      for (let a = Math.max(0, i - R); a <= Math.min(NW - 1, i + R); a++) {
        const kk = j * NW + a;
        if (d[kk] > 0 && G[kk] > mx) mx = G[kk];
      }
      tmp[j * NW + i] = mx;
    }
  for (let j = 0; j < NH; j++)
    for (let i = 0; i < NW; i++) {
      const k = j * NW + i;
      if (d[k] <= 0) continue;
      let mx = -1e9;
      for (let b = Math.max(0, j - R); b <= Math.min(NH - 1, j + R); b++) mx = Math.max(mx, tmp[b * NW + i]);
      top[k] = mx;
    }
  for (let j = 0; j < NH; j++)
    for (let i = 0; i < NW; i++) {
      const k = j * NW + i;
      const x = i / F;
      const y = j / F;
      if (d[k] <= 0) {
        H[k] = G[k] - SINK;
        continue;
      }
      const tk = Math.max(G[k], top[k]);
      const dk = d[k];
      const cm = canyonAt ? canyonAt(x, y) : 0;
      const n1 = fbm(x * 0.9, y * 0.9, 811, 3);
      const dn = dk + (n1 - 0.5) * st.wiggle * smooth(0.04, 0.5, dk);
      let pr = smooth(0.1, 0.1 + st.ramp, dn);
      if (st.terraces > 0) {
        const t = pr * (st.terraces + 1);
        const fl = Math.floor(t);
        pr = Math.min(1, (fl + smooth(0.3, 0.7, t - fl)) / (st.terraces + 1));
      }
      const rn = 1 - Math.abs(fbm(x * 0.75 + 3.1, y * 0.75, 823, 4) * 2 - 1);
      let crest = st.crest * (0.3 + 0.7 * rn * rn) * smooth(0.2, 0.95, dn);
      let crag = (valueNoise(x * 3.3, y * 3.3, 829) - 0.5) * 0.12 * smooth(0.12, 0.4, dn);
      if (cm > 0) {
        // jagged teeth along the canyon rims, knobs and hollows on its faces
        crest += cm * (valueNoise(x * 2.7, y * 2.7, 831) - 0.3) * 0.32 * smooth(0.2, 0.9, dn);
        crag += cm * ((valueNoise(x * 3.3, y * 3.3, 833) - 0.5) * 0.16 + (valueNoise(x * 7.1, y * 7.1, 835) - 0.5) * 0.08) * smooth(0.08, 0.35, dn);
      }
      const rim = st.rim * smooth(0.25, 0.55, dn);
      H[k] = G[k] + (tk + rim + st.wall - G[k]) * pr + crest + crag;
      p[k] = pr;
      // horizontal jitter off the border (keeps it inside the rock)
      const jk = (0.09 + 0.03 * cm) * smooth(0.18, 0.45, dk);
      if (jk > 0) {
        jx[k] = (valueNoise(x * 2.1, y * 2.1, 841) - 0.5) * 2 * jk;
        jz[k] = (valueNoise(x * 2.1, y * 2.1, 843) - 0.5) * 2 * jk;
      }
    }
  // aircraft clearance: the relief's lift over the sim ground, dilated by a tile and smoothed so they climb gently
  const TW = m.w + 1;
  const TH = m.h + 1;
  for (let k = 0; k < N; k++) {
    if (d[k] <= 0) continue;
    const lift = H[k] - G[k];
    if (lift <= 0) continue;
    const i = k % NW;
    const j = (k - i) / NW;
    const tx0 = Math.max(0, Math.floor(i / F - 1.2));
    const tx1 = Math.min(TW - 1, Math.ceil(i / F + 1.2));
    const ty0 = Math.max(0, Math.floor(j / F - 1.2));
    const ty1 = Math.min(TH - 1, Math.ceil(j / F + 1.2));
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) if (clr[ty * TW + tx] < lift) clr[ty * TW + tx] = lift;
  }
  boxBlur(clr, TW, TH, 1);
  rf = { F, NW, NH, H, d, jx, jz, p, count, clr };
  fields.set(m, rf);
  return rf;
}

/** How far aircraft rise over the relief at (x, y) (smooth; 0 away from the rock). renderer.ts adds it to their altitude. */
export function reliefClearance(m: GameMap, x: number, y: number): number {
  if (!ON) return 0;
  const rf = reliefField(m);
  if (!rf.count) return 0;
  const TW = m.w + 1;
  const fx = Math.max(0, Math.min(m.w - 0.001, x));
  const fy = Math.max(0, Math.min(m.h - 0.001, y));
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const tx = fx - i;
  const ty = fy - j;
  const c = rf.clr;
  const a = c[j * TW + i];
  const b = c[j * TW + i + 1];
  const e = c[(j + 1) * TW + i];
  const f = c[(j + 1) * TW + i + 1];
  return a + (b - a) * tx + (e - a) * ty + (a - b - e + f) * tx * ty;
}

/**
 * Top of the relief at (x, y) in tile space: the cliff surface on the rock,
 * the sim's ground elsewhere (never lower than the ground).
 */
export function reliefHeight(m: GameMap, x: number, y: number): number {
  const g = groundHeight(m, x, y);
  const rf = reliefField(m);
  if (!rf.count) return g;
  const F = rf.F;
  const fx = Math.max(0, Math.min(rf.NW - 1.001, x * F));
  const fy = Math.max(0, Math.min(rf.NH - 1.001, y * F));
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const k = j * rf.NW + i;
  if (rf.d[k] <= 0 && rf.d[k + 1] <= 0 && rf.d[k + rf.NW] <= 0 && rf.d[k + rf.NW + 1] <= 0) return g;
  const tx = fx - i;
  const ty = fy - j;
  const a = rf.H[k];
  const b = rf.H[k + 1];
  const c = rf.H[k + rf.NW];
  const e = rf.H[k + rf.NW + 1];
  return Math.max(g, a + (b - a) * tx + (c - a) * ty + (a - b - c + e) * tx * ty);
}

/** Distance (tiles) inside the relief at (x, y) (0 off the rock). */
export function reliefDepth(m: GameMap, x: number, y: number): number {
  const rf = reliefField(m);
  if (!rf.count) return 0;
  const i = Math.max(0, Math.min(rf.NW - 1, Math.round(x * rf.F)));
  const j = Math.max(0, Math.min(rf.NH - 1, Math.round(y * rf.F)));
  return rf.d[j * rf.NW + i];
}

// ------------------------------------------------------------------ meshes

/** One sector's merged cliff geometry at a sample stride (1 = full, 2 = far LOD). */
/** Wadi Al-Rimal's coloured canyons: how much a point (tile space) belongs to a canyon's walls (0..1). */
function canyonMask(m: GameMap): ((x: number, y: number) => number) | null {
  const list = m.deco?.canyons;
  if (!list?.length) return null;
  const cs = list.map((c) => {
    const xs = c.pts.map((p) => p.x + 0.5);
    const ys = c.pts.map((p) => p.y + 0.5);
    return { c, x0: Math.min(...xs) - 4.5, x1: Math.max(...xs) + 4.5, y0: Math.min(...ys) - 4.5, y1: Math.max(...ys) + 4.5 };
  });
  return (x, y) => {
    let best = 99;
    for (const { c, x0, x1, y0, y1 } of cs) {
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      for (let i = 0; i < c.pts.length - 1; i++) {
        const ax = c.pts[i].x + 0.5;
        const ay = c.pts[i].y + 0.5;
        const dx = c.pts[i + 1].x + 0.5 - ax;
        const dy = c.pts[i + 1].y + 0.5 - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
        best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t) - c.hw);
      }
    }
    return 1 - smooth(2.4, 4.4, best);
  };
}

function sectorGeometry(m: GameMap, rf: ReliefField, sx: number, sy: number, stride: number): THREE.BufferGeometry | null {
  const F = rf.F;
  const canyon = canyonMask(m);
  const can: number[] = [];
  const i0 = sx * SECTOR * F;
  const j0 = sy * SECTOR * F;
  const i1 = Math.min(rf.NW - 1, i0 + SECTOR * F);
  const j1 = Math.min(rf.NH - 1, j0 + SECTOR * F);
  const remap = new Map<number, number>();
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const vert = (i: number, j: number) => {
    const k = j * rf.NW + i;
    let v = remap.get(k);
    if (v !== undefined) return v;
    v = pos.length / 3;
    remap.set(k, v);
    const x = i / F;
    const y = j / F;
    pos.push(x + rf.jx[k], rf.H[k], y + rf.jz[k]);
    // crevices and the damp cliff foot darker, sun-bleached tops
    const dk = rf.d[k];
    const tone = 0.82 + valueNoise(x * 1.7, y * 1.7, 851) * 0.3;
    const cav = 0.78 + 0.22 * smooth(0.0, 0.5, rf.p[k]) - (dk <= 0 ? 0.15 : 0);
    const c = tone * cav;
    col.push(c, c, c);
    if (canyon) can.push(canyon(x, y));
    return v;
  };
  for (let j = j0; j < j1; j += stride)
    for (let i = i0; i < i1; i += stride) {
      const ie = Math.min(i + stride, i1);
      const je = Math.min(j + stride, j1);
      // any sample of the cell inside the rock?
      let hit = false;
      for (let b = j; b <= je && !hit; b++) for (let a = i; a <= ie && !hit; a++) if (rf.d[b * rf.NW + a] > 0) hit = true;
      if (!hit) continue;
      const a = vert(i, j);
      const b = vert(ie, j);
      const c = vert(i, je);
      const e = vert(ie, je);
      // split along the diagonal with the smaller height step (follows the cliff)
      const ha = rf.H[j * rf.NW + i];
      const hb = rf.H[j * rf.NW + ie];
      const hc = rf.H[je * rf.NW + i];
      const he = rf.H[je * rf.NW + ie];
      if (Math.abs(ha - he) <= Math.abs(hb - hc)) idx.push(a, c, e, a, e, b);
      else idx.push(a, c, b, b, c, e);
    }
  if (!idx.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  if (canyon) g.setAttribute('aCanyon', new THREE.Float32BufferAttribute(can, 1));
  g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  g.computeBoundingBox();
  void m;
  return g;
}

interface RockLook {
  side: string;
  top: string;
  /** Tint of the faces / tops (linear multipliers on the photo albedo). */
  sideTint: number;
  topTint: number;
  /** Saturation of the photo albedo. */
  sat: number;
  strata: number;
  snow: number;
  moss: number;
}

const LOOK: Record<Biome, RockLook> = {
  temperate: { side: 'greyrock', top: 'mossrock', sideTint: 0x9c968c, topTint: 0xb8b4a6, sat: 0.55, strata: 0.08, snow: 0, moss: 0.55 },
  desert: { side: 'greyrock', top: 'greyrock', sideTint: 0x9a7262, topTint: 0xa88470, sat: 0.75, strata: 0.06, snow: 0, moss: 0 },
  winter: { side: 'greyrock', top: 'snowrock', sideTint: 0x8c9098, topTint: 0xd0d4dc, sat: 0.4, strata: 0.06, snow: 0.85, moss: 0 },
  urban: { side: 'greyrock', top: 'greyrock', sideTint: 0xa09c94, topTint: 0xa8a49c, sat: 0.5, strata: 0.05, snow: 0, moss: 0.2 },
};

function placeholder(r: number, g: number, b: number): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
}

const texLoads = new Map<string, Promise<THREE.Texture | null>>();

/** A tiling ground photoscan (public/tex/terrain) as a plain repeating 2D texture. */
function loadTile(name: string, kind: 'a' | 'n', size: number): Promise<THREE.Texture | null> {
  const key = `${name}_${kind}_${size}`;
  let p = texLoads.get(key);
  if (!p) {
    p = fetchBitmap(`${assetBase()}tex/terrain/${size}/${name}_${kind}.webp`)
      .then((bm) => {
        const t = new THREE.Texture(bm);
        t.flipY = false;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = kind === 'a' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.anisotropy = 4;
        t.needsUpdate = true;
        return t;
      })
      .catch((e) => {
        console.warn('[relief] rock texture unavailable', name, e);
        return null;
      });
    texLoads.set(key, p);
  }
  return p;
}

function cliffMaterial(biome: Biome, fog: FogOfWar, quality: 'low' | 'medium' | 'high', canyon = false): THREE.MeshStandardMaterial {
  const lk = LOOK[biome] ?? LOOK.temperate;
  const flatN = placeholder(128, 128, 255);
  const u = {
    rSideA: { value: (quality === 'low' ? rockTexture(128) : placeholder(150, 144, 136)) as THREE.Texture },
    rTopA: { value: (quality === 'low' ? rockTexture(128) : placeholder(150, 144, 136)) as THREE.Texture },
    rSideN: { value: flatN as THREE.Texture },
    rTopN: { value: flatN as THREE.Texture },
    rSideTint: { value: new THREE.Color(lk.sideTint) },
    rTopTint: { value: new THREE.Color(lk.topTint) },
  };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vRWp;\nvarying vec3 vRWn;${canyon ? '\nattribute float aCanyon;\nvarying float vCanyon;' : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvRWp = position;\nvRWn = normal;${canyon ? '\nvCanyon = aCanyon;' : ''}`);
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vRWp;
        varying vec3 vRWn;
        uniform sampler2D rSideA;
        uniform sampler2D rTopA;
        uniform sampler2D rSideN;
        uniform sampler2D rTopN;
        uniform vec3 rSideTint;
        uniform vec3 rTopTint;
        vec3 rTriW;
        vec3 rTriN;
        float rRough = 0.0;${canyon ? `
        varying float vCanyon;
        // the coloured canyon's sandstone (render/strata.ts)
        ${strataGlsl()}` : ''}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec3 n = normalize( vRWn );
          vec3 bw = pow( abs( n ), vec3( 4.0 ) );
          bw /= dot( bw, vec3( 1.0 ) );
          rTriW = bw;
          vec3 p = vRWp * 0.55;
          vec3 ax = texture2D( rSideA, p.zy ).rgb;
          vec3 az = texture2D( rSideA, p.xy + 0.37 ).rgb;
          vec3 ay = texture2D( rTopA, p.xz * 0.8 ).rgb;
          float up = smoothstep( 0.45, 0.85, n.y );
          vec3 side = ( ax * bw.x + az * bw.z ) / max( 1e-3, bw.x + bw.z );
          vec3 alb = mix( side * rSideTint, ay * rTopTint, max( up, bw.y * 0.6 ) );
          alb = mix( vec3( dot( alb, vec3( 0.2126, 0.7152, 0.0722 ) ) ), alb, ${lk.sat.toFixed(2)} );
          float steep = 1.0 - up;
          // sediment strata on the faces
          float sn = texture2D( fogNoise, vRWp.xz * 0.07 ).r;
          float strata = sin( vRWp.y * 15.0 + sn * 6.0 ) * 0.5 + sin( vRWp.y * 37.0 + sn * 3.0 ) * 0.25;
          alb *= 1.0 + strata * ${lk.strata.toFixed(2)} * steep;
          #if ${canyon ? 1 : 0}
          if ( vCanyon > 0.01 ) {
            // muted sandstone layers that follow the rock (strata.ts), the scan's grain and relief kept through
            // its luminance; ledges and tops carry drift sand over the paler rock
            float cShade;
            float cRough;
            vec3 band = cyStrata( vRWp, n, cShade, cRough );
            float grain = clamp( dot( side, vec3( 0.2126, 0.7152, 0.0722 ) ) * 1.65, 0.6, 1.4 );
            vec3 cAlb = band * mix( 1.0, grain, 0.5 ) * cShade * 0.78;
            vec3 sand = vec3( 0.5, 0.36, 0.22 ) * mix( 1.0, grain, 0.3 ) * 0.78;
            cAlb = mix( cAlb, sand, smoothstep( 0.62, 0.9, n.y ) * 0.7 );
            // (canyon.ts' ledges and boulders carry 2: sandstone all over)
            float ck = min( 1.0, vCanyon * ( 0.5 + 0.5 * steep ) );
            alb = mix( alb, cAlb, ck );
            rRough = cRough * ck;
          }
          #endif
          #if ${lk.moss > 0 ? 1 : 0}
          {
            float mn = texture2D( fogNoise, vRWp.xz * 0.6 ).g;
            float moss = smoothstep( 0.62, 0.92, n.y + ( mn - 0.5 ) * 0.5 ) * ${lk.moss.toFixed(2)};
            alb = mix( alb, vec3( 0.075, 0.085, 0.035 ) * ( 0.75 + mn * 0.6 ), moss );
          }
          #endif
          #if ${lk.snow > 0 ? 1 : 0}
          {
            float sn2 = texture2D( fogNoise, vRWp.xz * 0.45 ).b;
            float snow = smoothstep( 0.5, 0.78, n.y + ( sn2 - 0.5 ) * 0.35 ) * ${lk.snow.toFixed(2)};
            alb = mix( alb, vec3( 0.78, 0.82, 0.88 ), snow );
          }
          #endif
          diffuseColor.rgb *= alb * 1.6;
          rTriN = n;
        }`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n        roughnessFactor = clamp( roughnessFactor + rRough, 0.6, 1.0 );')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          vec3 n = rTriN;
          vec3 bw = rTriW;
          vec3 p = vRWp * 0.55;
          vec3 tx = texture2D( rSideN, p.zy ).xyz * 2.0 - 1.0;
          vec3 tz = texture2D( rSideN, p.xy + 0.37 ).xyz * 2.0 - 1.0;
          vec3 ty = texture2D( rTopN, p.xz * 0.8 ).xyz * 2.0 - 1.0;
          // whiteout blend (Golus)
          vec3 nX = vec3( tx.xy + n.zy, abs( tx.z ) * n.x );
          vec3 nY = vec3( ty.xy + n.xz, abs( ty.z ) * n.y );
          vec3 nZ = vec3( tz.xy + n.xy, abs( tz.z ) * n.z );
          vec3 wn = normalize( nX.zyx * bw.x + nY.xzy * bw.y + nZ.xyz * bw.z );
          normal = normalize( ( viewMatrix * vec4( wn, 0.0 ) ).xyz );
        }`,
      );
  };
  fog.apply(mat);
  mat.customProgramCacheKey = () => 'relief-cliff-' + biome + (canyon ? '-canyon' : '');
  if (quality !== 'low') {
    const size = quality === 'high' ? 1024 : 512;
    void Promise.all([loadTile(lk.side, 'a', size), loadTile(lk.top, 'a', size), loadTile(lk.side, 'n', size), loadTile(lk.top, 'n', size)]).then(([sa, ta, sn, tn]) => {
      if (sa) u.rSideA.value = sa;
      if (ta) u.rTopA.value = ta;
      if (sn) u.rSideN.value = sn;
      if (tn) u.rTopN.value = tn;
    });
  }
  return mat;
}

const mats = new WeakMap<FogOfWar, Map<string, THREE.MeshStandardMaterial>>();

/** The map's cliff material (one per fog, biome and quality; canyon.ts puts its ledges and boulders on it too). */
export function reliefMaterial(m: GameMap, fog: FogOfWar, quality: 'low' | 'medium' | 'high'): THREE.MeshStandardMaterial {
  const canyon = !!m.deco?.canyons?.length;
  const biome = m.biome ?? 'temperate';
  const key = `${biome}-${quality}-${canyon}`;
  let per = mats.get(fog);
  if (!per) mats.set(fog, (per = new Map()));
  let mat = per.get(key);
  if (!mat) per.set(key, (mat = cliffMaterial(biome, fog, quality, canyon)));
  return mat;
}

/**
 * The cliff meshes over the map's rock (one per sector with rock in it),
 * registered with the scenery LOD (half resolution when zoomed out).
 */
export function buildRelief(m: GameMap, fog: FogOfWar, quality: 'low' | 'medium' | 'high', lod: SceneryLod): THREE.Object3D[] {
  const rf = reliefField(m);
  if (!rf.count) return [];
  const t0 = performance.now();
  const mat = reliefMaterial(m, fog, quality);
  const out: THREE.Object3D[] = [];
  const low = quality === 'low';
  let tris = 0;
  for (let sy = 0; sy * SECTOR < m.h; sy++)
    for (let sx = 0; sx * SECTOR < m.w; sx++) {
      const hi = sectorGeometry(m, rf, sx, sy, low ? 2 : 1);
      if (!hi) continue;
      const lo = low ? null : sectorGeometry(m, rf, sx, sy, 2);
      const mesh = new THREE.Mesh(hi, mat);
      mesh.name = 'relief';
      mesh.castShadow = !low;
      mesh.receiveShadow = true;
      mesh.userData.perfCat = 'relief';
      out.push(mesh);
      tris += (hi.index?.count ?? 0) / 3;
      if (lo) lod.add([mesh], hi, lo, quality === 'high' ? 24 : 17);
    }
  console.info(`[relief] ${out.length} cliff sectors, ${tris} tris, field ${rf.count} samples, ${Math.round(performance.now() - t0)} ms`);
  return out;
}
