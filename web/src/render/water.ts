import * as THREE from 'three';
import { BRIDGE_HEIGHT, Tile, WATER_LEVEL, groundHeight, type GameMap } from '../sim/map';
import type { FogOfWar } from './fog';
import { WX, WX_PARS } from './wxuniforms';
import { biomeLook } from './biome';

/*
 * The river: a flat, alpha-blended sheet at WATER_LEVEL covering only the
 * tiles near water. The map's water is analysed once (RiverInfo): the main
 * axis, a centreline with local widths, a velocity field (faster in the
 * narrows and the rapids, slower along the banks, eddies behind bridge piers
 * and rocks, a roller below the weir) and the spots for the river features
 * (rapids, weir, jetty). The shader then draws
 *  - the riverbed seen through the water (procedural sand / pebbles / stones /
 *    weed, refracted by depth and ripples) with depth absorption from clear
 *    turquoise-green shallows to the dark green-blue channel, and animated
 *    caustics on the sunlit shallows (medium / high; low: a depth gradient),
 *  - flow-mapped ripples advected by the velocity field (two phases
 *    cross-faded so they never stretch), standing waves and whitewater on the
 *    rapids, foam streaks, eddy foam and drifting foam / leaves,
 *  - reflections: HIGH renders the scene mirrored into a half resolution
 *    target; MEDIUM marches the reflected ray through a coarse height field
 *    of the banks, trees and bridge decks; LOW reflects a sky gradient,
 *  - weather (RIVER uniforms, driven by fx/waterfx.ts): glassy calm, wind
 *    chop with whitecaps, a muddy tint after heavy rain, ice rims and floes
 *    in the snow; at night a moon glitter path and shimmering reflections of
 *    nearby lamps / fires,
 *  - combat: expanding ring waves from impacts and burning fuel slicks.
 * Fog of war keeps the `fogV / fogK` block that FogOfWar.upgradeShader swaps
 * for the shared shroud / haze, and atmos.ts tints it through wxLight.
 */

export type WaterQuality = 'low' | 'medium' | 'high';

/** Pixels per tile of the shore / flow / wake data maps. */
const RES = 4;
/** Shore distance (tiles) stored in the data map's G channel at 1.0. */
const SHORE_MAX = 3;
/** Velocity (tiles / s) stored at the ends of the flow channels. */
const VMAX = 1.6;
/** Calm surface speed of the river (tiles / s). */
const BASE_SPEED = 0.42;

export const MAX_RINGS = 8;
export const MAX_SLICKS = 4;
export const MAX_WLIGHTS = 4;

/**
 * Live river state shared by the water shader (terrain + outskirts), the bank
 * ribbon / reeds (waterside.ts) and written by fx/waterfx.ts once per frame.
 */
export const RIVER = {
  /** x: wind chop 0..1, y: glassy calm 0..1, z: mud after heavy rain 0..1, w: ice 0..1. */
  wState: { value: new THREE.Vector4(0, 0.3, 0, 0) },
  /** x: night darkness 0..1, yz: wind direction (world x / z), w: caustic strength (sun up, clear sky). */
  wState2: { value: new THREE.Vector4(0, 0.8, -0.6, 1) },
  /** Ring waves: x, z, start time (water clock), amplitude (0 = unused). */
  wRings: { value: Array.from({ length: MAX_RINGS }, () => new THREE.Vector4(0, 0, -100, 0)) },
  /** Fuel slicks: x, z, radius, burning 0..1 (radius 0 = unused). */
  wSlicks: { value: Array.from({ length: MAX_SLICKS }, () => new THREE.Vector4()) },
  /** Lights reflected on the water: x, y, z, intensity (0 = unused) and colour. */
  wLightP: { value: Array.from({ length: MAX_WLIGHTS }, () => new THREE.Vector4()) },
  wLightC: { value: Array.from({ length: MAX_WLIGHTS }, () => new THREE.Vector3()) },
  /** Key light (sun / moon) direction (world, towards the light) and colour. */
  sunDir: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
  sunCol: { value: new THREE.Vector3(1, 0.97, 0.9) },
  /** Water clock (seconds; Terrain.update). */
  time: { value: 0 },
};

/** Ring waves on the surface (impacts, fish, ducks, boats). Analytic rings in the shader. */
export const waterRings = {
  next: 0,
  /** A ring wave at (x, z) (tiles); amp ~0.15 (a fish) .. 1.5 (a heavy shell). */
  add(x: number, z: number, amp: number) {
    const arr = RIVER.wRings.value;
    // round robin: the oldest ring makes way
    const v = arr[this.next];
    this.next = (this.next + 1) % MAX_RINGS;
    v.set(x, z, RIVER.time.value, amp);
  },
};

function periodicNoise(N: number, cells: number, seed: number) {
  const g = new Float32Array(cells * cells);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < g.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    g[i] = s / 4294967296;
  }
  const out = new Float32Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const fx = (x / N) * cells;
      const fy = (y / N) * cells;
      const xi = Math.floor(fx);
      const yi = Math.floor(fy);
      let u = fx - xi;
      let v = fy - yi;
      u = u * u * (3 - 2 * u);
      v = v * v * (3 - 2 * v);
      const at = (a: number, b: number) => g[((b + cells) % cells) * cells + ((a + cells) % cells)];
      const a = at(xi, yi);
      const b = at(xi + 1, yi);
      const c = at(xi, yi + 1);
      const d = at(xi + 1, yi + 1);
      out[y * N + x] = a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    }
  return out;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Periodic Worley distances (F1, F2) on an N x N grid with `cells` x `cells` jittered points. */
function worley(N: number, cells: number, seed: number) {
  const r = rng(seed);
  const px = new Float32Array(cells * cells);
  const py = new Float32Array(cells * cells);
  for (let i = 0; i < cells * cells; i++) {
    px[i] = r();
    py[i] = r();
  }
  const f1 = new Float32Array(N * N);
  const f2 = new Float32Array(N * N);
  const id = new Int32Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const fx = (x / N) * cells;
      const fy = (y / N) * cells;
      const cx = Math.floor(fx);
      const cy = Math.floor(fy);
      let a = 9;
      let b = 9;
      let best = 0;
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const gx = (((cx + i) % cells) + cells) % cells;
          const gy = (((cy + j) % cells) + cells) % cells;
          const k = gy * cells + gx;
          const dx = cx + i + px[k] - fx;
          const dy = cy + j + py[k] - fy;
          const d = Math.hypot(dx, dy);
          if (d < a) {
            b = a;
            a = d;
            best = k;
          } else if (d < b) b = d;
        }
      f1[y * N + x] = a;
      f2[y * N + x] = b;
      id[y * N + x] = best;
    }
  return { f1, f2, id };
}

function dataTex(data: Uint8Array, w: number, h: number, repeat: boolean, mips = true, srgb = false) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.generateMipmaps = mips;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

let waveTexC: THREE.DataTexture | null = null;
/** Tiling ripple map: RG = surface slope (x, z), B = height, A = foam breakup noise. */
function waveTexture(): THREE.DataTexture {
  if (waveTexC) return waveTexC;
  const N = 128;
  const H = new Float32Array(N * N);
  // a few periodic directional waves (integer frequencies tile seamlessly) + noise chop
  const waves = [
    [3, 1, 0.5, 0.3],
    [-2, 3, 0.35, 1.7],
    [5, -2, 0.22, 2.9],
    [1, 7, 0.14, 0.8],
    [-7, -4, 0.1, 4.1],
    [9, 5, 0.07, 5.3],
  ];
  const n1 = periodicNoise(N, 8, 11);
  const n2 = periodicNoise(N, 16, 23);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = x / N;
      const v = y / N;
      let h = 0;
      for (const [a, b, amp, ph] of waves) h += Math.sin((a * u + b * v) * Math.PI * 2 + ph) * amp;
      h += (n1[y * N + x] - 0.5) * 0.7 + (n2[y * N + x] - 0.5) * 0.35;
      H[y * N + x] = h;
    }
  const foam1 = periodicNoise(N, 12, 37);
  const foam2 = periodicNoise(N, 32, 41);
  const data = new Uint8Array(N * N * 4);
  const at = (x: number, y: number) => H[((y + N) % N) * N + ((x + N) % N)];
  let mn = Infinity;
  let mx = -Infinity;
  for (const h of H) {
    mn = Math.min(mn, h);
    mx = Math.max(mx, h);
  }
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 0.5 * 8;
      const dz = (at(x, y + 1) - at(x, y - 1)) * 0.5 * 8;
      const k = (y * N + x) * 4;
      data[k] = Math.max(0, Math.min(255, dx * 127.5 + 127.5));
      data[k + 1] = Math.max(0, Math.min(255, dz * 127.5 + 127.5));
      data[k + 2] = ((H[y * N + x] - mn) / (mx - mn)) * 255;
      data[k + 3] = Math.max(0, Math.min(1, foam1[y * N + x] * 0.65 + foam2[y * N + x] * 0.35)) * 255;
    }
  waveTexC = dataTex(data, N, N, true);
  return waveTexC;
}

let bedTexC: THREE.DataTexture | null = null;
/** Riverbed albedo (sRGB): sand with ripples, pebbles, a few larger stones and patches of weed. */
function bedTexture(): THREE.DataTexture {
  if (bedTexC) return bedTexC;
  const N = 256;
  const col = new Float32Array(N * N * 3);
  const n1 = periodicNoise(N, 8, 101);
  const n2 = periodicNoise(N, 32, 103);
  const weedN = periodicNoise(N, 6, 107);
  const weedF = periodicNoise(N, 48, 109);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const k = y * N + x;
      // sand: warm grey-brown, soft current ripples
      const rip = Math.sin(((x + y * 0.35) / N) * Math.PI * 2 * 18 + n1[k] * 6) * 0.04;
      const v = 0.86 + (n1[k] - 0.5) * 0.3 + (n2[k] - 0.5) * 0.14 + rip;
      col[k * 3] = 0.6 * v;
      col[k * 3 + 1] = 0.53 * v;
      col[k * 3 + 2] = 0.4 * v;
    }
  const r = rng(977);
  const blob = (cx: number, cy: number, rx: number, ry: number, ang: number, c: number[], shade: number) => {
    const R = Math.ceil(Math.max(rx, ry)) + 1;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    for (let j = -R; j <= R; j++)
      for (let i = -R; i <= R; i++) {
        const u = (i * ca + j * sa) / rx;
        const w = (-i * sa + j * ca) / ry;
        const d = u * u + w * w;
        if (d > 1) continue;
        const x = (((Math.round(cx) + i) % N) + N) % N;
        const y = (((Math.round(cy) + j) % N) + N) % N;
        const k = (y * N + x) * 3;
        // dome shading: lit from the upper left, dark rim
        const lit = 1 + shade * (-(u * 0.6 + w * 0.6) * 0.5 - d * 0.45);
        const a = d > 0.8 ? (1 - d) * 5 : 1;
        for (let q = 0; q < 3; q++) col[k + q] = col[k + q] * (1 - a) + c[q] * lit * a;
      }
  };
  // contact shadow ring under the bigger stones first
  const stones: number[][] = [];
  for (let i = 0; i < 26; i++) stones.push([r() * N, r() * N, 5 + r() * 8, r()]);
  for (const [x, y, s] of stones) blob(x + 1.5, y + 1.5, s * 1.15, s * 0.95, 0, [0.22, 0.2, 0.16], 0);
  for (const [x, y, s, t] of stones) {
    const g = 0.42 + t * 0.2;
    blob(x, y, s, s * (0.7 + t * 0.25), t * 6, [g * 0.98, g * 0.96, g * 0.9], 0.9);
  }
  const PEB = [
    [0.5, 0.48, 0.44],
    [0.62, 0.55, 0.44],
    [0.38, 0.36, 0.34],
    [0.56, 0.42, 0.3],
    [0.7, 0.66, 0.58],
    [0.3, 0.27, 0.24],
  ];
  for (let i = 0; i < 900; i++) {
    const c = PEB[Math.floor(r() * PEB.length)];
    const s = 1.2 + r() * r() * 3.6;
    const tint = 0.85 + r() * 0.3;
    blob(r() * N, r() * N, s, s * (0.6 + r() * 0.35), r() * 6, [c[0] * tint, c[1] * tint, c[2] * tint], 0.8);
  }
  // weed: dark green patches of streaky fronds
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const k = y * N + x;
      const w = Math.max(0, Math.min(1, (weedN[k] - 0.6) * 6));
      if (w <= 0) continue;
      const streak = 0.5 + 0.5 * Math.sin(((x * 0.8 + y * 0.6) / N) * Math.PI * 2 * 40 + weedF[k] * 9);
      const a = w * (0.3 + 0.3 * streak);
      const g = 0.75 + weedF[k] * 0.5;
      col[k * 3] = col[k * 3] * (1 - a) + 0.2 * g * a;
      col[k * 3 + 1] = col[k * 3 + 1] * (1 - a) + 0.27 * g * a;
      col[k * 3 + 2] = col[k * 3 + 2] * (1 - a) + 0.1 * g * a;
    }
  const data = new Uint8Array(N * N * 4);
  for (let k = 0; k < N * N; k++) {
    for (let q = 0; q < 3; q++) data[k * 4 + q] = Math.max(0, Math.min(255, Math.pow(Math.max(0, col[k * 3 + q]), 1 / 2.2) * 255));
    data[k * 4 + 3] = 255;
  }
  bedTexC = dataTex(data, N, N, true, true, true);
  return bedTexC;
}

let causTexC: THREE.DataTexture | null = null;
/** Caustic network: bright thin cell borders (Worley F2 - F1). Two drifting layers are min-combined. */
function causticTexture(): THREE.DataTexture {
  if (causTexC) return causTexC;
  const N = 128;
  const w = worley(N, 7, 313);
  const data = new Uint8Array(N * N * 4);
  for (let k = 0; k < N * N; k++) {
    const e = w.f2[k] - w.f1[k];
    const v = Math.pow(Math.max(0, 1 - e / 0.32), 3.2);
    const b = Math.round(Math.min(1, v) * 255);
    data[k * 4] = data[k * 4 + 1] = data[k * 4 + 2] = b;
    data[k * 4 + 3] = 255;
  }
  causTexC = dataTex(data, N, N, true);
  return causTexC;
}

let fleckTexC: THREE.DataTexture | null = null;
/** Drifting surface bits: R = foam flecks, G = leaves, B = ice floes (cell shapes), A = unused. */
function fleckTexture(): THREE.DataTexture {
  if (fleckTexC) return fleckTexC;
  const N = 128;
  const data = new Uint8Array(N * N * 4);
  const r = rng(4242);
  const put = (cx: number, cy: number, rad: number, ch: number, el = 1, ang = 0) => {
    const R = Math.ceil(rad * Math.max(1, el)) + 1;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    for (let j = -R; j <= R; j++)
      for (let i = -R; i <= R; i++) {
        const u = (i * ca + j * sa) / (rad * el);
        const v = (-i * sa + j * ca) / rad;
        const d = Math.sqrt(u * u + v * v);
        if (d >= 1) continue;
        const x = (((Math.round(cx) + i) % N) + N) % N;
        const y = (((Math.round(cy) + j) % N) + N) % N;
        const k = (y * N + x) * 4 + ch;
        data[k] = Math.max(data[k], Math.round((1 - d * d) * 255));
      }
  };
  // foam: loose clusters of small blobs
  for (let c = 0; c < 9; c++) {
    const cx = r() * N;
    const cy = r() * N;
    for (let i = 0; i < 9; i++) put(cx + (r() - 0.5) * 16, cy + (r() - 0.5) * 9, 0.8 + r() * 2.4, 0);
  }
  // leaves: a few small elongated flakes
  for (let i = 0; i < 14; i++) put(r() * N, r() * N, 0.9 + r() * 0.5, 1, 1.9, r() * 6);
  // floes: some Worley cells, shrunk away from their borders
  const w = worley(N, 5, 777);
  const on = new Uint8Array(64);
  for (let i = 0; i < on.length; i++) on[i] = r() < 0.55 ? 1 : 0;
  for (let k = 0; k < N * N; k++) {
    if (!on[w.id[k] % 64]) continue;
    const e = w.f2[k] - w.f1[k];
    data[k * 4 + 2] = Math.round(Math.max(0, Math.min(1, (e - 0.05) / 0.25)) * 255);
  }
  fleckTexC = dataTex(data, N, N, true);
  return fleckTexC;
}

interface Pier {
  x: number;
  y: number;
  /** Half extent across the flow / along the flow (tiles). */
  hw: number;
  hl: number;
}

/** A point on the river's centreline (every 0.5 tiles along the main axis). */
export interface RiverSample {
  /** Position along the main axis. */
  s: number;
  x: number;
  y: number;
  /** Unit tangent (downstream). */
  tx: number;
  ty: number;
  /** Wet width (tiles). */
  width: number;
}

export interface RiverFeatures {
  /** Whitewater stretch along the axis (s0..s1) and its centre. */
  rapids: { s0: number; s1: number; x: number; y: number } | null;
  /** Low weir across the river: centre, across-river unit vector, half length, downstream tangent. */
  weir: { x: number; y: number; ax: number; ay: number; half: number; tx: number; ty: number; s: number } | null;
  /** Wooden jetty: bank point, unit direction out into the water, length. */
  jetty: { x: number; y: number; dx: number; dy: number; len: number; s: number } | null;
  /** Rocks breaking the surface in the rapids. */
  rocks: { x: number; y: number; r: number }[];
}

/**
 * The map's river, analysed once: main axis, centreline, widths, a velocity
 * field and the feature spots. Shared by the shader data maps, waterside.ts
 * (banks, reeds, jetty, weir), fx/waterfx.ts (drifting debris and slicks) and
 * ambient/river.ts (ducks, boats).
 */
export class RiverInfo {
  /** Main axis (unit, downstream) and its origin. */
  readonly ax: number;
  readonly ay: number;
  readonly ox: number;
  readonly oy: number;
  readonly samples: RiverSample[] = [];
  readonly s0: number;
  readonly meanWidth: number;
  /** Data map size (RES texels per tile). */
  readonly N: number;
  readonly NH: number;
  readonly res = RES;
  /** Per texel: distance to the shore (tiles, 0 on dry ground), velocity (tiles / s). */
  readonly shore: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  /** Per texel: 1 where the ground is under water. */
  readonly wetMask: Uint8Array;
  readonly features: RiverFeatures = { rapids: null, weir: null, jetty: null, rocks: [] };
  /** Bridge positions along the axis. */
  readonly bridgeS: number[];

  constructor(readonly map: GameMap) {
    const m = map;
    // main axis: principal direction of the water tiles
    let n = 0;
    let mx = 0;
    let my = 0;
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++) {
        const t = m.tiles[y * m.w + x];
        if (t !== Tile.Water && t !== Tile.Bridge) continue;
        mx += x + 0.5;
        my += y + 0.5;
        n++;
      }
    mx /= Math.max(1, n);
    my /= Math.max(1, n);
    let cxx = 0;
    let cxy = 0;
    let cyy = 0;
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++) {
        const t = m.tiles[y * m.w + x];
        if (t !== Tile.Water && t !== Tile.Bridge) continue;
        const dx = x + 0.5 - mx;
        const dy = y + 0.5 - my;
        cxx += dx * dx;
        cxy += dx * dy;
        cyy += dy * dy;
      }
    const ang = n > 1 ? 0.5 * Math.atan2(2 * cxy, cxx - cyy) : Math.PI / 4;
    let ax = Math.cos(ang);
    let ay = Math.sin(ang);
    if (ax + ay < 0) {
      ax = -ax;
      ay = -ay;
    }
    this.ax = ax;
    this.ay = ay;
    this.ox = mx;
    this.oy = my;
    const px = -ay;
    const py = ax;
    const wetAt = (x: number, y: number) => x >= 0 && y >= 0 && x <= m.w && y <= m.h && groundHeight(m, x, y) < WATER_LEVEL;
    // centreline: scan across the axis every half tile, follow the wet run nearest the previous centre
    const span = Math.hypot(m.w, m.h) * 0.5 + 2;
    const raw: { s: number; c: number; w: number }[] = [];
    let prevC = 0;
    for (let s = -span; s <= span; s += 0.5) {
      const runs: [number, number][] = [];
      let st = NaN;
      for (let c = -24; c <= 24.001; c += 0.1) {
        const x = mx + ax * s + px * c;
        const y = my + ay * s + py * c;
        const w = wetAt(x, y);
        if (w && Number.isNaN(st)) st = c;
        if (!w && !Number.isNaN(st)) {
          runs.push([st, c]);
          st = NaN;
        }
      }
      if (!Number.isNaN(st)) runs.push([st, 24]);
      if (!runs.length) continue;
      let best = runs[0];
      let bd = Infinity;
      for (const r of runs) {
        const d = Math.abs((r[0] + r[1]) / 2 - prevC) - (r[1] - r[0]) * 0.3;
        if (d < bd) {
          bd = d;
          best = r;
        }
      }
      prevC = (best[0] + best[1]) / 2;
      raw.push({ s, c: prevC, w: best[1] - best[0] });
    }
    // smooth and build samples
    const sm = (k: number, f: (o: { c: number; w: number }) => number) => {
      let a = 0;
      let c = 0;
      for (let j = -3; j <= 3; j++) {
        const o = raw[k + j];
        if (!o) continue;
        a += f(o);
        c++;
      }
      return a / c;
    };
    const cs = raw.map((_, k) => sm(k, (o) => o.c));
    const ws = raw.map((_, k) => sm(k, (o) => o.w));
    let wsum = 0;
    for (let k = 0; k < raw.length; k++) {
      const s = raw[k].s;
      const k0 = Math.max(0, k - 2);
      const k1 = Math.min(raw.length - 1, k + 2);
      const x0 = mx + ax * raw[k0].s + px * cs[k0];
      const y0 = my + ay * raw[k0].s + py * cs[k0];
      const x1 = mx + ax * raw[k1].s + px * cs[k1];
      const y1 = my + ay * raw[k1].s + py * cs[k1];
      const tl = Math.hypot(x1 - x0, y1 - y0) || 1;
      this.samples.push({ s, x: mx + ax * s + px * cs[k], y: my + ay * s + py * cs[k], tx: (x1 - x0) / tl, ty: (y1 - y0) / tl, width: Math.max(0.6, ws[k]) });
      wsum += ws[k];
    }
    this.s0 = this.samples.length ? this.samples[0].s : 0;
    this.meanWidth = this.samples.length ? wsum / this.samples.length : 4;
    this.bridgeS = m.bridges.map((b) => this.sAt(b.x, b.y)).sort((a, b) => a - b);
    // ---- texel fields
    const N = (this.N = m.w * RES);
    const NH = (this.NH = m.h * RES);
    this.shore = new Float32Array(N * NH);
    this.vx = new Float32Array(N * NH);
    this.vy = new Float32Array(N * NH);
    this.wetMask = new Uint8Array(N * NH);
    this.pickFeatures();
  }

  /** Position along the main axis. */
  sAt(x: number, y: number) {
    return (x - this.ox) * this.ax + (y - this.oy) * this.ay;
  }

  /** Nearest centreline sample to axis position s (null without a river). */
  sample(s: number): RiverSample | null {
    const sa = this.samples;
    if (!sa.length) return null;
    const i = Math.max(0, Math.min(sa.length - 1, Math.round((s - this.s0) / 0.5)));
    return sa[i];
  }

  /** Point at axis position s, `off` tiles across the river (positive = left of the flow). */
  at(s: number, off = 0, out = { x: 0, y: 0 }) {
    const c = this.sample(s);
    if (!c) return out;
    out.x = c.x - c.ty * off;
    out.y = c.y + c.tx * off;
    return out;
  }

  private texel(x: number, y: number) {
    const i = Math.max(0, Math.min(this.N - 1, Math.floor(x * RES)));
    const j = Math.max(0, Math.min(this.NH - 1, Math.floor(y * RES)));
    return j * this.N + i;
  }

  /** Distance to the shore (tiles; 0 on dry ground). */
  shoreAt(x: number, y: number) {
    return this.shore[this.texel(x, y)];
  }

  isWet(x: number, y: number) {
    if (x < 0 || y < 0 || x >= this.map.w || y >= this.map.h) return false;
    return this.wetMask[this.texel(x, y)] === 1;
  }

  /** Surface velocity at (x, y) into `out` (tiles / s); returns the speed. */
  velAt(x: number, y: number, out: { x: number; y: number }) {
    const k = this.texel(x, y);
    out.x = this.vx[k];
    out.y = this.vy[k];
    return Math.hypot(out.x, out.y);
  }

  /** Water depth (world units) at (x, y); <= 0 on dry ground. */
  depthAt(x: number, y: number) {
    return WATER_LEVEL - groundHeight(this.map, Math.max(0, Math.min(this.map.w, x)), Math.max(0, Math.min(this.map.h, y)));
  }

  private pickFeatures() {
    const m = this.map;
    const sa = this.samples;
    if (sa.length < 20) return;
    // oases and the walled canal have no rapids, weir or jetty
    if (m.biome === 'desert' || m.biome === 'urban') return;
    // usable stretch: the river inside the map, away from the edges
    const inside = sa.filter((c) => c.x > 6 && c.y > 6 && c.x < m.w - 6 && c.y < m.h - 6);
    if (!inside.length) return;
    const sLo = inside[0].s;
    const sHi = inside[inside.length - 1].s;
    const farFromBridges = (s: number, d: number) => this.bridgeS.every((b) => Math.abs(b - s) > d);
    // jetty: the bank point nearest a village house
    let best: { s: number; side: number; d: number } | null = null;
    for (const st of m.structures) {
      const hx = st.x + st.w / 2;
      const hy = st.y + st.h / 2;
      const s = this.sAt(hx, hy);
      if (s < sLo || s > sHi || !farFromBridges(s, 7)) continue;
      const c = this.sample(s)!;
      const off = -(hx - c.x) * c.ty + (hy - c.y) * c.tx;
      const d = Math.abs(off) - c.width / 2;
      if (d > 2 && (!best || d < best.d)) best = { s, side: Math.sign(off) || 1, d };
    }
    if (best) {
      const c = this.sample(best.s)!;
      // walk out from the house side to the waterline
      const half = c.width / 2;
      const nx = -c.ty * best.side;
      const ny = c.tx * best.side;
      const bx = c.x + nx * (half - 0.15);
      const by = c.y + ny * (half - 0.15);
      this.features.jetty = { x: bx, y: by, dx: -nx, dy: -ny, len: Math.min(2.2, half * 0.9), s: best.s };
    }
    // the gaps between bridges (and the map edges)
    const cuts = [sLo, ...this.bridgeS.filter((b) => b > sLo && b < sHi), sHi];
    const gaps: [number, number][] = [];
    for (let i = 0; i < cuts.length - 1; i++) gaps.push([cuts[i], cuts[i + 1]]);
    const js = this.features.jetty?.s;
    const inGap = (g: [number, number], s: number | undefined) => s !== undefined && s > g[0] && s < g[1];
    // weir: in the jetty's gap, half way between the jetty and the far bridge; else the longest gap
    let weirS: number | null = null;
    const jg = gaps.find((g) => inGap(g, js));
    if (jg && js !== undefined) {
      const a = js - jg[0] > jg[1] - js ? [jg[0], js] : [js, jg[1]];
      if (a[1] - a[0] > 13) weirS = (a[0] + a[1]) / 2;
    }
    const others = gaps.filter((g) => !inGap(g, js)).sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
    if (weirS === null && others.length > 1) weirS = (others[1][0] + others[1][1]) / 2;
    if (weirS !== null) {
      const c = this.sample(weirS)!;
      this.features.weir = { x: c.x, y: c.y, ax: -c.ty, ay: c.tx, half: c.width / 2, tx: c.tx, ty: c.ty, s: weirS };
    }
    // rapids: the middle of the longest gap without the jetty
    const rg = others[0];
    if (rg && rg[1] - rg[0] > 12) {
      const sm = (rg[0] + rg[1]) / 2;
      const c = this.sample(sm)!;
      this.features.rapids = { s0: sm - 3.2, s1: sm + 3.2, x: c.x, y: c.y };
      const r = rng(31337);
      for (let i = 0; i < 8; i++) {
        const s = sm - 2.8 + (i / 7) * 5.6 + (r() - 0.5) * 0.5;
        const cc = this.sample(s)!;
        const off = (i % 2 ? 1 : -1) * (0.15 + r() * 0.3) * cc.width * 0.5;
        const p = this.at(s, off);
        this.features.rocks.push({ x: p.x, y: p.y, r: 0.2 + r() * 0.17 });
      }
    }
  }
}

function bridgePiers(m: GameMap): Pier[] {
  const D = Math.SQRT1_2;
  const out: Pier[] = [];
  // same layout as scenery.ts: three piers along the deck, which runs along (1, -1)
  for (const br of m.bridges) {
    const L = br.length;
    for (const k of [-L / 2 + 1.5, 0, L / 2 - 1.5]) out.push({ x: br.x + k * D, y: br.y - k * D, hw: 0.2, hl: 2.1 * 0.35 });
  }
  return out;
}

function smooth(e0: number, e1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Data maps (RES px per tile).
 * waterData:  R = occluder height (ground, tree canopies, bridge decks) for the
 *             medium reflection march (bridgefx.ts patches it), G = distance to
 *             the shore, B = rapids, A = pier wake / bow foam.
 * waterData2: RG = surface velocity, B = eddy foam, A = obstacle foam (rocks,
 *             weir roller, collapsed bridge slabs: patched by fx/waterfx.ts).
 */
function buildWaterData(m: GameMap, info: RiverInfo): { data: THREE.DataTexture; data2: THREE.DataTexture } {
  const N = info.N;
  const NH = info.NH;
  const main = { x: info.ax, y: info.ay };
  const piers = bridgePiers(m);
  const inPier = (x: number, y: number) => {
    for (const p of piers) {
      const dx = x - p.x;
      const dy = y - p.y;
      const a = Math.abs(dx * main.x + dy * main.y);
      const c = Math.abs(-dx * main.y + dy * main.x);
      if (a < p.hl && c < p.hw) return true;
    }
    return false;
  };
  const dry = new Uint8Array(N * NH);
  const occ = new Float32Array(N * NH);
  for (let j = 0; j < NH; j++)
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) / RES;
      const y = (j + 0.5) / RES;
      const h = groundHeight(m, x, y);
      const k = j * N + i;
      dry[k] = h > WATER_LEVEL || inPier(x, y) ? 1 : 0;
      info.wetMask[k] = h < WATER_LEVEL ? 1 : 0;
      const tx = Math.min(m.w - 1, Math.floor(x));
      const ty = Math.min(m.h - 1, Math.floor(y));
      const ti = ty * m.w + tx;
      let o = h;
      if (m.trees[ti]) o = Math.max(o, h + 1.1);
      if (m.tiles[ti] === Tile.Bridge) o = Math.max(o, BRIDGE_HEIGHT);
      if (m.blocked[ti]) o = Math.max(o, h + 0.6);
      occ[k] = o;
    }
  const dist = chamfer(dry, N, NH);
  const sd = (i: number, j: number) => Math.min(dist[Math.max(0, Math.min(NH - 1, j)) * N + Math.max(0, Math.min(N - 1, i))] / RES, SHORE_MAX);
  const f = info.features;
  const rap = f.rapids;
  const weir = f.weir;
  // vortex pairs (eddies): behind piers and rapids rocks
  const vort: { x: number; y: number; g: number; r: number }[] = [];
  const addPair = (x: number, y: number, tx: number, ty: number, back: number, sideOff: number, g: number, r: number) => {
    const bx = x + tx * back;
    const by = y + ty * back;
    vort.push({ x: bx - ty * sideOff, y: by + tx * sideOff, g, r });
    vort.push({ x: bx + ty * sideOff, y: by - tx * sideOff, g: -g, r });
  };
  for (const p of piers) addPair(p.x, p.y, main.x, main.y, p.hl + 0.55, p.hw + 0.28, 0.5, 0.42);
  for (const r of f.rocks) {
    const c = info.sample(info.sAt(r.x, r.y))!;
    addPair(r.x, r.y, c.tx, c.ty, r.r + 0.35, r.r + 0.12, 0.22, 0.3);
  }
  const data = new Uint8Array(N * NH * 4);
  const data2 = new Uint8Array(N * NH * 4);
  for (let j = 0; j < NH; j++)
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const o = k * 4;
      data[o] = Math.max(0, Math.min(255, ((occ[k] + 1.5) / 6) * 255));
      const d = sd(i, j);
      info.shore[k] = info.wetMask[k] ? d : 0;
      data[o + 1] = (d / SHORE_MAX) * 255;
      const x = (i + 0.5) / RES;
      const y = (j + 0.5) / RES;
      const s = info.sAt(x, y);
      const c = info.sample(s);
      let vx = 0;
      let vy = 0;
      let rapids = 0;
      let eddy = 0;
      let obst = 0;
      if (c && !dry[k]) {
        const half = c.width / 2;
        const off = -(x - c.x) * c.ty + (y - c.y) * c.tx;
        const prof = Math.max(0.12, 1 - (off / Math.max(0.5, half)) ** 2);
        let sp = BASE_SPEED * Math.min(2.2, Math.pow(info.meanWidth / c.width, 1.4)) * (0.3 + 0.7 * prof) * smooth(0, 0.6, d);
        let tx = c.tx;
        let ty = c.ty;
        // near the banks the water follows the bank
        const gx = (sd(i + 2, j) - sd(i - 2, j)) * 0.25;
        const gy = (sd(i, j + 2) - sd(i, j - 2)) * 0.25;
        const gl = Math.hypot(gx, gy);
        if (gl > 0.05 && d < 1.2) {
          const nx = gx / gl;
          const ny = gy / gl;
          const dd = tx * nx + ty * ny;
          const k2 = 1 - smooth(0.2, 1.2, d);
          tx -= dd * nx * k2;
          ty -= dd * ny * k2;
          const l = Math.hypot(tx, ty) || 1;
          tx /= l;
          ty /= l;
        }
        if (rap && s > rap.s0 - 1.5 && s < rap.s1 + 2.5) {
          rapids = smooth(rap.s0 - 1.5, rap.s0 + 0.5, s) * (1 - smooth(rap.s1 - 0.5, rap.s1 + 2.5, s)) * smooth(0.05, 0.5, d);
          sp *= 1 + rapids * 1.7;
        }
        vx = tx * sp;
        vy = ty * sp;
        // eddies
        for (const v of vort) {
          const dx = x - v.x;
          const dy = y - v.y;
          const r2 = dx * dx + dy * dy;
          if (r2 > v.r * v.r * 9) continue;
          const fall = Math.exp(-r2 / (v.r * v.r));
          const tang = (v.g * fall) / Math.sqrt(r2 + 0.02);
          vx += -dy * tang * 0.6;
          vy += dx * tang * 0.6;
          eddy = Math.max(eddy, fall * 0.9);
        }
        // the weir: a smooth tongue over the crest, then a white roller that turns back on itself
        if (weir) {
          const along = (x - weir.x) * weir.tx + (y - weir.y) * weir.ty;
          const across = Math.abs((x - weir.x) * weir.ax + (y - weir.y) * weir.ay);
          if (across < weir.half + 0.4) {
            if (along > -0.6 && along < 0) {
              const k3 = smooth(-0.6, 0, along);
              vx *= 1 + k3 * 1.2;
              vy *= 1 + k3 * 1.2;
            }
            if (along > 0.05 && along < 2.4) {
              const roll = (1 - smooth(0.2, 0.75, along)) * smooth(0.05, 0.15, along);
              obst = Math.max(obst, roll * 0.95 + (1 - smooth(0.2, 2.4, along)) * 0.45);
              const back = roll * 0.9;
              vx -= weir.tx * sp * back * 2;
              vy -= weir.ty * sp * back * 2;
              eddy = Math.max(eddy, (1 - smooth(0.3, 2.2, along)) * 0.6);
            }
          }
        }
        for (const r of f.rocks) {
          const dr = Math.hypot(x - r.x, y - r.y) - r.r;
          if (dr < 0.35) obst = Math.max(obst, 1 - smooth(0, 0.35, dr));
        }
      }
      info.vx[k] = vx;
      info.vy[k] = vy;
      data[o + 2] = Math.round(rapids * 255);
      data2[o] = Math.max(0, Math.min(255, Math.round((vx / VMAX) * 127.5 + 127.5)));
      data2[o + 1] = Math.max(0, Math.min(255, Math.round((vy / VMAX) * 127.5 + 127.5)));
      data2[o + 2] = Math.round(Math.min(1, eddy) * 255);
      data2[o + 3] = Math.round(Math.min(1, obst) * 255);
    }
  // pier wakes (downstream trails) and bow foam (upstream)
  for (const p of piers) {
    const R = 5;
    const i0 = Math.max(0, Math.floor((p.x - R) * RES));
    const i1 = Math.min(N - 1, Math.ceil((p.x + R) * RES));
    const j0 = Math.max(0, Math.floor((p.y - R) * RES));
    const j1 = Math.min(NH - 1, Math.ceil((p.y + R) * RES));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = j * N + i;
        if (dry[k]) continue;
        const dx = (i + 0.5) / RES - p.x;
        const dy = (j + 0.5) / RES - p.y;
        const a = dx * main.x + dy * main.y;
        const c = Math.abs(-dx * main.y + dy * main.x);
        let w = 0;
        const t = a - p.hl;
        if (t > -0.1 && t < 3.6) {
          const half = p.hw + 0.04 + t * 0.1;
          w = Math.max(w, (1 - smooth(half * 0.4, half, c)) * (1 - smooth(0.2, 3.6, t)));
        }
        const u = -a - p.hl;
        if (u > -0.2 && u < 0.5) w = Math.max(w, (1 - smooth(0.05, 0.5, u)) * (1 - smooth(p.hw * 0.6, p.hw + 0.35, c)));
        data[k * 4 + 3] = Math.max(data[k * 4 + 3], Math.round(w * 255));
      }
  }
  const mk = (d: Uint8Array) => {
    const t = new THREE.DataTexture(d, N, NH, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    return t;
  };
  return { data: mk(data), data2: mk(data2) };
}

/** Chamfer distance transform (texels) to the nearest set texel of `src`. */
export function chamfer(src: Uint8Array, N: number, NH: number): Float32Array {
  const INF = 1e9;
  const dist = new Float32Array(N * NH);
  for (let k = 0; k < N * NH; k++) dist[k] = src[k] ? 0 : INF;
  const A = 1;
  const B = Math.SQRT2;
  const relax = (k: number, k2: number, w: number) => {
    const v = dist[k2] + w;
    if (v < dist[k]) dist[k] = v;
  };
  for (let j = 0; j < NH; j++)
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      if (i > 0) relax(k, k - 1, A);
      if (j > 0) {
        relax(k, k - N, A);
        if (i > 0) relax(k, k - N - 1, B);
        if (i < N - 1) relax(k, k - N + 1, B);
      }
    }
  for (let j = NH - 1; j >= 0; j--)
    for (let i = N - 1; i >= 0; i--) {
      const k = j * N + i;
      if (i < N - 1) relax(k, k + 1, A);
      if (j < NH - 1) {
        relax(k, k + N, A);
        if (i < N - 1) relax(k, k + N + 1, B);
        if (i > 0) relax(k, k + N - 1, B);
      }
    }
  return dist;
}

/**
 * Planar reflection for the high setting: the scene seen by a camera
 * mirrored below the water plane (with an oblique near plane at the water)
 * rendered into a half resolution target from the water mesh's
 * onBeforeRender, once every other frame.
 */
export class WaterReflection {
  readonly camera = new THREE.PerspectiveCamera();
  readonly target: THREE.WebGLRenderTarget;
  readonly matrix = new THREE.Matrix4();
  /** Water meshes hidden while the reflection renders. */
  readonly meshes: THREE.Mesh[] = [];
  /** Cleared by the quality ladder when the GPU struggles. */
  enabled = true;
  /** 1 while the target holds a usable image (shader uniform). */
  readonly on = { value: 0 };
  private frame = 0;
  private done = -1;
  private rendering = false;
  private readonly plane = new THREE.Plane();
  private readonly clip = new THREE.Vector4();
  private readonly q = new THREE.Vector4();
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();
  private readonly rot = new THREE.Matrix4();
  private readonly size = new THREE.Vector2();
  private readonly clearC = new THREE.Color();

  constructor(private level: number) {
    this.target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: true });
    this.target.texture.generateMipmaps = false;
    this.camera.userData.waterReflection = true;
  }

  /** Called once per frame (Terrain.update). */
  tick() {
    this.frame++;
  }

  isRendering() {
    return this.rendering;
  }

  readonly hook = (renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) => {
    if (this.rendering || camera === this.camera) return;
    const cam = camera as THREE.PerspectiveCamera;
    if (!this.enabled || !cam.isPerspectiveCamera) {
      this.on.value = 0;
      return;
    }
    // every other frame (the image lags a frame at most; ripples hide it)
    if (this.done === this.frame || (this.done >= 0 && this.frame - this.done < 2 && this.on.value > 0)) return;
    this.done = this.frame;
    const L = this.level;
    const camPos = this.v1.setFromMatrixPosition(cam.matrixWorld);
    if (camPos.y <= L + 0.05) {
      this.on.value = 0;
      return;
    }
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(64, Math.min(1024, Math.round(this.size.x * 0.5)));
    const h = Math.max(64, Math.round((w * this.size.y) / Math.max(1, this.size.x)));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
    // mirrored camera
    const vc = this.camera;
    this.rot.extractRotation(cam.matrixWorld);
    vc.position.set(camPos.x, 2 * L - camPos.y, camPos.z);
    const look = this.v2.set(0, 0, -1).applyMatrix4(this.rot).add(camPos);
    look.y = 2 * L - look.y;
    vc.up.set(0, 1, 0).applyMatrix4(this.rot);
    vc.up.y = -vc.up.y;
    vc.lookAt(look);
    vc.far = cam.far;
    vc.near = cam.near;
    vc.layers.mask = cam.layers.mask;
    vc.updateMatrixWorld();
    vc.projectionMatrix.copy(cam.projectionMatrix);
    vc.projectionMatrixInverse.copy(cam.projectionMatrixInverse);
    // oblique near plane at the water surface (Lengyel), as in three's Reflector
    this.plane.setFromNormalAndCoplanarPoint(this.v3.set(0, 1, 0), this.v2.set(0, L, 0));
    this.plane.applyMatrix4(vc.matrixWorldInverse);
    const clip = this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const pm = vc.projectionMatrix.elements;
    const q = this.q.set((Math.sign(clip.x) + pm[8]) / pm[0], (Math.sign(clip.y) + pm[9]) / pm[5], -1, (1 + pm[10]) / pm[14]);
    clip.multiplyScalar(2 / clip.dot(q));
    pm[2] = clip.x;
    pm[6] = clip.y;
    pm[10] = clip.z + 1 - 0.003;
    pm[14] = clip.w;
    this.matrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);
    // Only the part of the mirrored image under visible water is ever sampled (plus the ripple distortion):
    // render just that rectangle. Same projection, same pixels there; everything that can only land outside
    // it is frustum culled (most of the units and scenery when the river is a band across the view).
    const sub = this.waterRect(cam, w, h);
    if (sub && sub[2] <= 0) {
      // no water on screen: nothing samples the reflection this frame
      return;
    }
    // render
    this.rendering = true;
    const prevTarget = renderer.getRenderTarget();
    const prevShadow = renderer.shadowMap.autoUpdate;
    const prevBg = scene.background;
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.clearC);
    const vis = this.meshes.map((m) => m.visible);
    for (const m of this.meshes) m.visible = false;
    renderer.shadowMap.autoUpdate = false;
    scene.background = null;
    renderer.setClearColor(0x000000, 0);
    const T = this.target;
    T.viewport.set(0, 0, w, h);
    T.scissor.set(0, 0, w, h);
    T.scissorTest = false;
    renderer.setRenderTarget(T);
    renderer.state.buffers.depth.setMask(true);
    if (sub) {
      // (texels outside the rectangle read as 'nothing reflected' should a ripple ever reach them)
      renderer.clear();
      const [px, py, pw, ph] = sub;
      // P' = S P: the rectangle's pixels land exactly where the full frame puts them
      const a = w / pw;
      const b = (w - 2 * px) / pw - 1;
      const c = h / ph;
      const d = (h - 2 * py) / ph - 1;
      const e = vc.projectionMatrix.elements;
      for (let i = 0; i < 4; i++) {
        e[i * 4] = a * e[i * 4] + b * e[i * 4 + 3];
        e[i * 4 + 1] = c * e[i * 4 + 1] + d * e[i * 4 + 3];
      }
      vc.projectionMatrixInverse.copy(vc.projectionMatrix).invert();
      T.viewport.set(px, py, pw, ph);
      T.scissor.set(px, py, pw, ph);
      T.scissorTest = true;
      renderer.setRenderTarget(null);
      renderer.setRenderTarget(T);
    } else if (renderer.autoClear === false) renderer.clear();
    renderer.render(scene, vc);
    if (sub) {
      T.viewport.set(0, 0, w, h);
      T.scissor.set(0, 0, w, h);
      T.scissorTest = false;
    }
    this.meshes.forEach((m, i) => (m.visible = vis[i]));
    renderer.setClearColor(this.clearC, prevAlpha);
    scene.background = prevBg;
    renderer.shadowMap.autoUpdate = prevShadow;
    renderer.setRenderTarget(prevTarget);
    const vp = (cam as THREE.PerspectiveCamera & { viewport?: THREE.Vector4 }).viewport;
    if (vp !== undefined) renderer.state.viewport(vp);
    this.rendering = false;
    this.on.value = 1;
  };

  dispose() {
    this.target.dispose();
  }

  // ------------------------------------------------ visible water rectangle

  /** Water surface rectangles (x0, z0, x1, z1 in world units) of the reflecting meshes. */
  private rects: Float32Array | null = null;
  private rectMeshes = 0;
  private readonly fp: number[] = [];
  private readonly poly: number[] = [];
  private readonly tmp: number[] = [];
  private readonly far = new THREE.Vector3();

  private buildRects() {
    const seen = new Set<string>();
    const out: number[] = [];
    const v = new THREE.Vector3();
    for (const mesh of this.meshes) {
      const g = mesh.geometry;
      const pos = g.attributes.position as THREE.BufferAttribute | undefined;
      if (!pos) continue;
      mesh.updateMatrixWorld();
      const idx = g.index;
      const n = idx ? idx.count : pos.count;
      for (let t = 0; t + 2 < n; t += 3) {
        let x0 = Infinity;
        let z0 = Infinity;
        let x1 = -Infinity;
        let z1 = -Infinity;
        for (let k = 0; k < 3; k++) {
          const i = idx ? idx.getX(t + k) : t + k;
          v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
          x0 = Math.min(x0, v.x);
          x1 = Math.max(x1, v.x);
          z0 = Math.min(z0, v.z);
          z1 = Math.max(z1, v.z);
        }
        const key = `${x0},${z0},${x1},${z1}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(x0, z0, x1, z1);
      }
    }
    this.rects = new Float32Array(out);
    this.rectMeshes = this.meshes.length;
  }

  /**
   * Pixel rectangle [x, y, w, h] of the reflection target that the visible water can sample (its
   * reflected uv's bounding box plus the ripple distortion), [0, 0, 0, 0] when no water is on screen,
   * or null to render the whole frame (view reaching the horizon, or most of the frame anyway).
   */
  private waterRect(cam: THREE.PerspectiveCamera, w: number, h: number): [number, number, number, number] | null {
    if (!this.rects || this.rectMeshes !== this.meshes.length) this.buildRects();
    const L = this.level;
    // the view's footprint on the water plane (the four corner rays)
    const fp = this.fp;
    fp.length = 0;
    const camPos = this.v1.setFromMatrixPosition(cam.matrixWorld);
    for (const [nx, ny] of CORNERS) {
      const p = this.far.set(nx, ny, 1).unproject(cam);
      const dy = p.y - camPos.y;
      if (dy >= -1e-6) return null;
      const t = (L - camPos.y) / dy;
      if (t <= 0 || t > 1e4) return null;
      fp.push(camPos.x + (p.x - camPos.x) * t, camPos.z + (p.z - camPos.z) * t);
    }
    // make the footprint counter-clockwise (x, z) for the clip
    let area = 0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      area += fp[i * 2] * fp[j * 2 + 1] - fp[j * 2] * fp[i * 2 + 1];
    }
    const sgn = area >= 0 ? 1 : -1;
    const r = this.rects!;
    const M = this.matrix.elements;
    let u0 = Infinity;
    let v0 = Infinity;
    let u1 = -Infinity;
    let v1 = -Infinity;
    let poly = this.poly;
    let tmp = this.tmp;
    for (let k = 0; k < r.length; k += 4) {
      poly.length = 0;
      poly.push(r[k], r[k + 1], r[k + 2], r[k + 1], r[k + 2], r[k + 3], r[k], r[k + 3]);
      // Sutherland-Hodgman against the four footprint edges
      for (let e = 0; e < 4 && poly.length; e++) {
        const ax = fp[e * 2];
        const az = fp[e * 2 + 1];
        const bx = fp[((e + 1) % 4) * 2];
        const bz = fp[((e + 1) % 4) * 2 + 1];
        const side = (x: number, z: number) => sgn * ((bx - ax) * (z - az) - (bz - az) * (x - ax));
        tmp.length = 0;
        const n = poly.length / 2;
        for (let i = 0; i < n; i++) {
          const px = poly[i * 2];
          const pz = poly[i * 2 + 1];
          const qx = poly[((i + 1) % n) * 2];
          const qz = poly[((i + 1) % n) * 2 + 1];
          const sp = side(px, pz);
          const sq = side(qx, qz);
          if (sp >= 0) tmp.push(px, pz);
          if ((sp >= 0) !== (sq >= 0)) {
            const t = sp / (sp - sq);
            tmp.push(px + (qx - px) * t, pz + (qz - pz) * t);
          }
        }
        const sw = poly;
        poly = tmp;
        tmp = sw;
      }
      for (let i = 0; i < poly.length; i += 2) {
        const x = poly[i];
        const z = poly[i + 1];
        // reflMatrix * (x, L, z, 1)
        const cw = M[3] * x + M[7] * L + M[11] * z + M[15];
        if (cw <= 1e-6) return null;
        const u = (M[0] * x + M[4] * L + M[8] * z + M[12]) / cw;
        const v = (M[1] * x + M[5] * L + M[9] * z + M[13]) / cw;
        if (u < u0) u0 = u;
        if (u > u1) u1 = u;
        if (v < v0) v0 = v;
        if (v > v1) v1 = v;
      }
    }
    this.poly.length = 0;
    this.tmp.length = 0;
    if (u0 > u1) return [0, 0, 0, 0];
    // ripple distortion (n.xz * 0.05 in the shader) and bilinear filtering
    const m = 0.06;
    const x0 = Math.max(0, Math.floor((u0 - m) * w) - 2);
    const x1 = Math.min(w, Math.ceil((u1 + m) * w) + 2);
    const y0 = Math.max(0, Math.floor((v0 - m) * h) - 2);
    const y1 = Math.min(h, Math.ceil((v1 + m) * h) + 2);
    if (x1 <= x0 || y1 <= y0) return [0, 0, 0, 0];
    // (most of the frame anyway: render it whole)
    if ((x1 - x0) * (y1 - y0) > 0.85 * w * h) return null;
    return [x0, y0, x1 - x0, y1 - y0];
  }
}

const CORNERS: [number, number][] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];


export interface WaterBuild {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  reflection: WaterReflection | null;
  river: RiverInfo;
}

export function buildWater(m: GameMap, fog: FogOfWar, quality: WaterQuality): WaterBuild {
  // height texture so the shader knows the depth (vertex grid)
  const hw = m.w + 1;
  const hh = m.h + 1;
  const hdata = new Uint8Array(hw * hh);
  for (let i = 0; i < hw * hh; i++) hdata[i] = Math.max(0, Math.min(255, ((m.heights[i] + 1.5) / 4.5) * 255));
  const htex = new THREE.DataTexture(hdata, hw, hh, THREE.RedFormat, THREE.UnsignedByteType);
  htex.magFilter = htex.minFilter = THREE.LinearFilter;
  htex.needsUpdate = true;
  const river = new RiverInfo(m);
  const maps = buildWaterData(m, river);
  const reflection = quality === 'high' ? new WaterReflection(WATER_LEVEL) : null;
  const Q = quality === 'high' ? 2 : quality === 'medium' ? 1 : 0;
  // biome water: clear turquoise oasis, icy river, murky canal (temperate = the original river)
  const bw = biomeLook(m).water;
  // the rapids' frame: centre + downstream direction (world x / z), and half length, so the whitewater is
  // drawn in stable flow-aligned coordinates (dot(worldPos, localFlowDir) warps into marbled swirls)
  const rap = river.features.rapids;
  const rapC = rap ? river.sample((rap.s0 + rap.s1) / 2) : null;
  const rapF = rapC ? new THREE.Vector4(rapC.x, rapC.y, rapC.tx, rapC.ty) : new THREE.Vector4(0, 0, 1, 0);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    defines: { WATER_Q: Q },
    uniforms: {
      time: RIVER.time,
      heightTex: { value: htex },
      waterData: { value: maps.data },
      waterData2: { value: maps.data2 },
      waveTex: { value: waveTexture() },
      bedTex: { value: Q > 0 ? bedTexture() : null },
      causTex: { value: Q > 0 ? causticTexture() : null },
      fleckTex: { value: Q > 0 ? fleckTexture() : null },
      mapSize: { value: new THREE.Vector2(m.w, m.h) },
      sunDir: RIVER.sunDir,
      sunCol: RIVER.sunCol,
      waterLevel: { value: WATER_LEVEL },
      wxLight: { value: new THREE.Vector3(1, 1, 1) },
      wxSpec: { value: 1 },
      wTurq: { value: new THREE.Vector3(...bw.turq) },
      wDeep: { value: new THREE.Vector3(...bw.deep) },
      wBed: { value: new THREE.Vector3(...bw.bed) },
      wIceK: { value: biomeLook(m).iceK },
      skyTop: { value: new THREE.Color(0x4a6488) },
      skyHorizon: { value: new THREE.Color(0x8a8678) },
      reflTex: { value: reflection ? reflection.target.texture : null },
      reflMatrix: { value: reflection ? reflection.matrix : new THREE.Matrix4() },
      reflOn: reflection ? reflection.on : { value: 0 },
      wState: RIVER.wState,
      wState2: RIVER.wState2,
      wRings: RIVER.wRings,
      wSlicks: RIVER.wSlicks,
      wLightP: RIVER.wLightP,
      wLightC: RIVER.wLightC,
      rapF: { value: rapF },
      rapH: { value: rap ? (rap.s1 - rap.s0) / 2 : 0 },
      ...fog.uniforms,
      ...WX,
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      #define SHORE ${SHORE_MAX.toFixed(1)}
      #define VMAX ${VMAX.toFixed(2)}
      uniform float time;
      uniform sampler2D heightTex;
      uniform sampler2D waterData;
      uniform sampler2D waterData2;
      uniform sampler2D waveTex;
      uniform sampler2D bedTex;
      uniform sampler2D causTex;
      uniform sampler2D fleckTex;
      uniform vec2 mapSize;
      uniform vec3 sunDir;
      uniform vec3 sunCol;
      uniform float waterLevel;
      uniform vec3 wxLight;
      uniform float wxSpec;
      uniform vec3 skyTop;
      uniform vec3 skyHorizon;
      uniform vec3 wTurq;
      uniform vec3 wDeep;
      uniform vec3 wBed;
      uniform float wIceK;
      uniform sampler2D reflTex;
      uniform mat4 reflMatrix;
      uniform float reflOn;
      uniform vec4 wState;
      uniform vec4 wState2;
      uniform vec4 wRings[${MAX_RINGS}];
      uniform vec4 wSlicks[${MAX_SLICKS}];
      uniform vec4 wLightP[${MAX_WLIGHTS}];
      uniform vec3 wLightC[${MAX_WLIGHTS}];
      uniform vec4 rapF;
      uniform float rapH;
      ${WX_PARS}
      uniform sampler2D fogTex;
      uniform vec2 fogSize;
      uniform float fogEnabled;
      varying vec3 vWorld;
      vec2 waveN(vec2 uv) { return texture2D(waveTex, uv).rg * 2.0 - 1.0; }
      void main() {
        vec2 p = vWorld.xz;
        vec2 tuv = p / mapSize;
        float ground = texture2D(heightTex, (p + 0.5) / (mapSize + 1.0)).r * 4.5 - 1.5;
        float depthW = waterLevel - ground;
        if (depthW <= 0.0) discard;
        float depth = clamp(depthW / 0.7, 0.0, 1.0);
        vec4 dat = texture2D(waterData, tuv);
        vec4 dat2 = texture2D(waterData2, tuv);
        float shore = dat.g * SHORE;
        vec2 vel = (dat2.rg * 2.0 - 1.0) * VMAX;
        float spd = length(vel);
        vec2 fd = spd > 0.002 ? vel / spd : vec2(0.7071);
        vec2 sideV = vec2(-fd.y, fd.x);
        float rapids = dat.b;
        float chop = wState.x;
        float calm = wState.y * (1.0 - rapids);
        float mud = wState.z;
        float ice = wState.w;
        float dark = wState2.x;
        vec2 wind = wState2.yz;
        // fuel slicks: oil calms the ripples under it; burning ones glow
        float oil = 0.0;
        float oilR = 0.0;
        float burn = 0.0;
        for (int i = 0; i < ${MAX_SLICKS}; i++) {
          vec4 s = wSlicks[i];
          if (s.z <= 0.0) continue;
          float d = length(p - s.xy) / s.z;
          if (d > 1.4) continue;
          float nz = texture2D(waveTex, p * 0.31 + s.xy * 0.17).a;
          float mk = 1.0 - smoothstep(0.5, 1.0, d + (nz - 0.5) * 0.7);
          if (mk > oil) { oil = mk; oilR = d * 1.3 + nz * 1.6; }
          burn = max(burn, mk * s.w * (1.0 - smoothstep(0.2, 0.95, d + (nz - 0.5) * 0.5)));
        }
        // flow-mapped ripples (two phases of a 3 s cycle, cross-faded)
        float ph0 = fract(time / 3.0);
        float ph1 = fract(time / 3.0 + 0.5);
        float w0 = 1.0 - abs(1.0 - 2.0 * ph0);
        float w1 = 1.0 - w0;
        vec2 q0 = p - vel * (ph0 * 3.0);
        vec2 q1 = p - vel * (ph1 * 3.0) + 0.37;
        float amp = 0.07 * (1.0 - 0.78 * calm) * (1.0 + 1.5 * chop) * (1.0 + rapids * 0.7) * (1.0 - 0.65 * oil);
        vec2 g = (waveN(q0 * 0.42) * w0 + waveN(q1 * 0.42) * w1) * amp;
        #if WATER_Q > 0
          g += (waveN(q0 * 1.13 + 0.21) * w0 + waveN(q1 * 1.13 + 0.53) * w1) * amp * 0.5;
        #endif
        // wind: short choppy waves running downwind
        if (chop > 0.01) {
          g += waveN(p * 1.1 - wind * time * 0.8 + 0.13) * chop * 0.085 * (1.0 - oil);
          #if WATER_Q > 0
            g += waveN(p * 2.7 - wind * time * 1.5 + 0.71) * chop * 0.045 * (1.0 - oil);
          #endif
        }
        // a slow cross swell so still water isn't dead
        g += vec2(0.8, 0.6) * cos(dot(p, vec2(0.8, 0.6)) * 2.3 + time * 1.1) * 0.012 * (1.0 - 0.7 * calm);
        float alongR = dot(p, fd);
        // ---- rapids: whitewater in a stable flow-aligned frame about the rapids' centre (rapF);
        // dot(p, fd) with the per-pixel flow direction swings by whole texture periods and marbles
        float rCov = 0.0;   // whitewater coverage, with a ragged soft edge into the calm river
        float rN = 0.5;     // churning streak noise (contrast-stretched, ~0..1)
        float rDrop = 0.0;  // the tumbling line where the river drops into the rapids
        vec2 rUv2 = vec2(0.0);
        if (rapids > 0.01) {
          vec2 rd = rapF.zw;
          vec2 rq = p - rapF.xy;
          float ra = dot(rq, rd);                 // downstream
          float rc = dot(rq, vec2(-rd.y, rd.x));  // across
          // long streaks and shorter, faster ones dragged downstream; slower boils break them up
          vec2 rUv1 = vec2(rc * 0.6, (ra - time * 1.1) * 0.07);
          rUv2 = vec2(rc * 1.5 + 0.31, (ra - time * 1.55) * 0.2 + 0.17);
          vec2 rUv3 = vec2(rc * 0.4, (ra - time * 0.8) * 0.22) + 0.61;
          float s1 = texture2D(waveTex, rUv1).a;
          float s2 = texture2D(waveTex, rUv2).a;
          float s3 = texture2D(waveTex, rUv3).a;
          // standing waves: crests across the flow behind the rocks, wobbling with the boils
          float sw = sin(ra * 7.0 + s3 * 6.0 + rc * 0.9);
          rN = (s1 * 0.45 + s2 * 0.4 + s3 * 0.15 - 0.5) * 2.6 + 0.5 + max(sw, 0.0) * 0.12;
          float dz = ra + rapH - 0.55 + (s2 - 0.5) * 0.5;
          rDrop = exp(-dz * dz * 9.0) * rapids;
          rCov = clamp(rapids * 1.3 - 0.2 + (s3 - 0.5) * 0.9, 0.0, 1.0);
          // a churned surface: choppy slopes from the streak and boil layers, plus the standing waves
          g += (waveN(rUv2 * 1.7) * 0.6 + waveN(rUv3 * 2.3) * 0.4) * 0.2 * rCov;
          g += rd * sw * rapids * 0.08;
          #if WATER_Q > 0
            g += waveN(vec2(rc * 2.9, (ra - time * 2.0) * 1.1) + 0.27) * 0.08 * rCov;
          #endif
        }
        if (wxRain > 0.001) {
          // rain: rings from drops on the surface (wxRain: while it rains)
          vec2 rp = p / 0.5;
          vec2 ci = floor(rp);
          vec2 h = fract(sin(vec2(dot(ci, vec2(127.1, 311.7)), dot(ci, vec2(269.5, 183.3)))) * 43758.5453);
          vec2 o = rp - (ci + 0.2 + h * 0.6);
          float ph = fract(wxTime * 0.9 + h.x * 7.3);
          float d = length(o) - ph * 0.5;
          g += normalize(o + 1e-4) * sin(d * 40.0) * exp(-abs(d) * 14.0) * (1.0 - ph) * 0.12 * wxRain * (1.0 - oil);
        }
        // ring waves from impacts, fish, ducks, boats
        float ringFoam = 0.0;
        #if WATER_Q > 0
        for (int i = 0; i < ${MAX_RINGS}; i++) {
          vec4 r = wRings[i];
          float age = time - r.z;
          if (r.w <= 0.0 || age < 0.0 || age > 5.0) continue;
          vec2 o = p - r.xy;
          float d = length(o);
          float x = d - age * (0.9 + 0.35 * min(r.w, 2.0));
          if (abs(x) > 1.1) continue;
          float env = r.w * exp(-age * 0.75) * exp(-x * x * 5.0) / (1.0 + d * 0.6);
          g += (o / (d + 0.001)) * sin(x * 13.0) * env * 0.42;
          ringFoam = max(ringFoam, env * (1.0 - smoothstep(0.0, 0.25, abs(x + 0.08))) * (1.0 - smoothstep(0.4, 2.0, age)) * 1.4);
        }
        #endif
        vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
        vec3 viewDir = normalize(cameraPosition - vWorld);
        float cosT = max(dot(n, viewDir), 0.0);
        float fres = 0.1 + 0.9 * pow(1.0 - cosT, 4.0);
        // ---- the water body: bed through the water, absorbed with depth
        vec3 deepC = mix(wDeep, vec3(0.06, 0.05, 0.026), mud);
        vec3 turq = mix(wTurq, vec3(0.11, 0.09, 0.045), mud);
        vec3 absorb = mix(vec3(4.2, 2.7, 3.1), vec3(9.0, 8.0, 9.5), mud) * (1.0 + chop * 0.5);
        vec3 trans = exp(-absorb * depthW);
        vec3 scatter = mix(turq, deepC, smoothstep(0.1, 0.5, depthW));
        #if WATER_Q > 0
          vec2 bp = p - viewDir.xz / max(viewDir.y, 0.35) * depthW * 0.72 + n.xz * depthW * 0.9;
          vec3 bed = texture2D(bedTex, bp * 0.42).rgb;
          // caustics dancing on the sunlit shallows
          float ck = wState2.w * (1.0 - smoothstep(0.06, 0.48, depthW)) * (1.0 - oil) * (1.0 - mud * 0.8) * (1.0 - ice);
          if (ck > 0.01) {
            vec2 cq = bp * 0.85;
            float c1 = texture2D(causTex, cq + vec2(time * 0.045, time * 0.03)).r;
            float c2 = texture2D(causTex, cq * 1.19 + vec2(-time * 0.037, time * 0.041) + 0.5).r;
            bed *= 1.0 + min(c1, c2) * 2.6 * ck;
          }
          bed *= 0.62 * wBed / vec3(0.24, 0.2, 0.13);
        #else
          vec3 bed = wBed;
        #endif
        vec3 under = bed * trans + scatter * (1.0 - trans);
        // ---- reflection: sky gradient, then banks / bridges / everything on high
        vec3 R = reflect(-viewDir, n);
        R.y = abs(R.y);
        vec3 refl = mix(skyHorizon, skyTop, smoothstep(0.05, 0.8, R.y)) * 0.55;
        // drifting clouds in the reflected sky
        float cl = texture2D(waveTex, R.xz / (R.y + 0.25) * 0.12 + vec2(time * 0.004, time * 0.002)).a;
        refl = mix(refl, skyHorizon * 0.9, smoothstep(0.45, 0.75, cl) * 0.6);
        float bankK = 1.0 - smoothstep(0.0, 1.6, shore);
        #if WATER_Q == 0
          refl *= 1.0 - bankK * 0.55;
        #elif WATER_Q >= 1
          #if WATER_Q == 2
          if (reflOn < 0.5) {
          #endif
          vec3 rp0 = vec3(p.x, waterLevel, p.y);
          float hit = 0.0;
          float t = 0.12;
          for (int i = 0; i < 7; i++) {
            vec3 q = rp0 + R * t;
            float occ = texture2D(waterData, q.xz / mapSize).r * 6.0 - 1.5;
            if (occ > q.y) { hit = 1.0 - float(i) * 0.08; break; }
            t *= 1.55;
          }
          refl = mix(refl, vec3(0.035, 0.04, 0.026), hit);
          #if WATER_Q == 2
          }
          #endif
        #endif
        #if WATER_Q == 2
          if (reflOn > 0.5) {
            vec4 rc = reflMatrix * vec4(vWorld, 1.0);
            vec2 ruv = rc.xy / rc.w + n.xz * 0.05 * (1.0 - 0.6 * calm);
            vec4 sc = texture2D(reflTex, ruv);
            // the mirrored sky is HDR: compress it so it never washes the river out
            vec3 rs = sc.rgb / (1.0 + dot(sc.rgb, vec3(0.3, 0.59, 0.11)) * 0.6);
            refl = mix(refl, rs, sc.a);
          }
        #endif
        float fr = fres * (0.85 + 0.15 * calm) * (1.0 - 0.5 * rapids);
        vec3 col = mix(under, refl, fr);
        col *= wxLight * (1.0 - 0.22 * chop);
        // ---- light on the surface: sun / moon highlight and its glitter path, nearby lamps and fires
        float sd = max(dot(R, sunDir), 0.0);
        float spec = pow(sd, mix(90.0, 420.0, calm)) * mix(1.6, 2.6, calm);
        #if WATER_Q > 0
          float spark = smoothstep(0.66, 0.93, texture2D(waveTex, q0 * 1.9).b * w0 + texture2D(waveTex, q1 * 1.9).b * w1);
          spec += pow(sd, 12.0) * spark * (0.06 + 2.4 * dark) * (1.0 - 0.6 * calm);
        #endif
        col += sunCol * spec * wxSpec * (1.0 - 0.7 * ice);
        #if WATER_Q > 0
        for (int i = 0; i < ${MAX_WLIGHTS}; i++) {
          vec4 L = wLightP[i];
          if (L.w <= 0.0) continue;
          vec3 tl = L.xyz - vWorld;
          float dl = length(tl);
          float ls = pow(max(dot(R, tl / dl), 0.0), 22.0);
          col += wLightC[i] * ls * L.w / (1.0 + dl * dl * 0.06);
        }
        #endif
        // ---- foam (advected noise never stretches: same two phases as the ripples)
        float fA = texture2D(waveTex, q0 * 0.55).a * w0 + texture2D(waveTex, q1 * 0.55 + 0.4).a * w1;
        #if WATER_Q > 0
          float fB = texture2D(waveTex, q0 * 1.7 + 0.3).a * w0 + texture2D(waveTex, q1 * 1.7 + 0.7).a * w1;
        #else
          float fB = fA * 0.8 + 0.1;
        #endif
        // ---- whitewater on the rapids: broken bright foam streaks over dark aerated troughs
        float wwF = 0.0;
        if (rCov > 0.001) {
          // the streaks break into tumbling clumps carried by the real flow (fB: flow-mapped foam noise)
          rN += (fB - 0.5) * 0.55;
          float th = mix(0.92, 0.52, rCov);
          wwF = max(smoothstep(th, th + 0.16, rN), rDrop * smoothstep(0.32, 0.6, fA * 0.5 + fB * 0.5 + 0.08)) * smoothstep(0.0, 0.7, rCov) * (1.0 - oil * 0.85);
          col *= 1.0 - 0.38 * rCov * (1.0 - wwF);
          // thin foam is a translucent grey-green, thick foam bright white, shaded by the churned surface
          float thick = smoothstep(th, th + 0.45, rN);
          float lit = 0.72 + 0.38 * clamp(dot(n, sunDir), 0.0, 1.0);
          vec3 wwC = mix(vec3(0.6, 0.7, 0.7), vec3(0.97, 0.99, 1.0), thick) * lit * wxLight * (1.0 - 0.42 * dark);
          col = mix(col, wwC, wwF * 0.96);
          // sparkle off the broken surface and the wet foam
          #if WATER_Q > 0
            float gl = smoothstep(0.76, 0.9, texture2D(waveTex, rUv2 * 2.6 + vec2(0.0, time * 0.35)).b);
          #else
            float gl = smoothstep(0.7, 0.85, rN);
          #endif
          col += sunCol * wxSpec * (pow(sd, 6.0) * 1.4 + pow(sd, 40.0) * 2.0) * gl * rCov * (1.0 - 0.7 * ice);
        }
        float lapK = 1.0 + chop * 1.2 - calm * 0.5;
        float band = 1.0 - smoothstep(0.0, (0.22 + fA * 0.28) * lapK, shore);
        float lap = 0.5 + 0.5 * sin(shore * 18.0 - time * 1.7 + fA * 5.0);
        float foam = band * smoothstep(0.5, 0.85, fB * 0.6 + lap * 0.4 + band * 0.2) * 0.85 * (1.0 - 0.4 * calm);
        foam = max(foam, (1.0 - smoothstep(0.0, 0.05 + fB * 0.05, shore)) * smoothstep(0.35, 0.75, fB) * 0.6);
        // streaks dragged along the flow: pier wakes (the rapids' whitewater is drawn above)
        if (dat.a > 0.003) {
          vec2 ax = vec2(alongR, dot(p, sideV));
          float sp2 = 1.0 + rapids * 1.6;
          float st = texture2D(waveTex, vec2(ax.x * 0.3 - time * 0.4 * sp2, ax.y * 2.2)).a;
          float st2 = texture2D(waveTex, vec2(ax.x * 0.9 - time * 0.9 * sp2, ax.y * 4.1) + 0.5).a;
          float streak = smoothstep(0.5, 0.78, st * 0.65 + st2 * 0.35 + dat.a * 0.12);
          foam = max(foam, dat.a * dat.a * mix(streak, 1.0, smoothstep(0.85, 1.0, dat.a)) * 0.8);
        }
        // eddies swirl foam; rocks and the weir churn it white
        foam = max(foam, dat2.b * smoothstep(0.42, 0.75, fB) * 0.75);
        foam = max(foam, dat2.a * smoothstep(0.25, 0.65, fA * 0.5 + fB * 0.5 + dat2.a * 0.35));
        #if WATER_Q > 0
          // drifting foam flecks and leaves
          vec4 fl = texture2D(fleckTex, q0 * 0.31) * w0 + texture2D(fleckTex, q1 * 0.31 + 0.5) * w1;
          foam = max(foam, smoothstep(0.35, 0.8, fl.r) * (0.15 + 0.85 * max(max(rapids, dat2.b), dat2.a * 0.8)) * 0.7 * (1.0 - calm * 0.4));
        #endif
        // storm whitecaps
        if (chop > 0.3) foam = max(foam, (chop - 0.3) * 1.4 * smoothstep(0.74, 0.92, texture2D(waveTex, p * 0.7 - wind * time * 0.7).b * 0.8 + fB * 0.3));
        foam = max(foam, ringFoam);
        foam = clamp(foam * (1.0 - oil * 0.85), 0.0, 1.0);
        vec3 foamC = vec3(0.78, 0.83, 0.82) * mix(1.0, 0.82, mud);
        col = mix(col, foamC * wxLight, foam * 0.78);
        #if WATER_Q > 0
          float leaf = smoothstep(0.45, 0.7, fl.g) * (1.0 - ice) * (1.0 - oil);
          col = mix(col, vec3(0.2, 0.11, 0.035) * wxLight, leaf * 0.85);
        #endif
        // ---- fuel slick: black film with a rainbow sheen; burning slicks glow
        if (oil > 0.001) {
          vec3 irid = 0.5 + 0.5 * cos(6.2832 * (oilR + vec3(0.0, 0.33, 0.67)));
          vec3 oilC = vec3(0.012, 0.011, 0.01) + irid * 0.05 * (0.4 + 0.6 * fres);
          col = mix(col, oilC * wxLight + sunCol * pow(sd, 160.0) * 1.4 * wxSpec, oil * 0.86);
          col += vec3(1.0, 0.38, 0.06) * burn * (0.45 + 0.55 * texture2D(waveTex, p * 1.4 + vec2(0.0, time * 0.9)).a) * 1.6;
        }
        // ---- ice: rims along the banks, floes drifting with the current
        if (ice > 0.01) {
          float rn = texture2D(waveTex, p * 0.35).b;
          float rimW = ice * (0.25 + 0.6 * rn) * wIceK;
          float im = 1.0 - smoothstep(rimW * 0.75, rimW, shore);
          #if WATER_Q > 0
            im = max(im, smoothstep(0.42, 0.5, fl.b) * smoothstep(0.5, 0.62, fA) * smoothstep(0.35, 0.9, shore) * smoothstep(0.2, 0.8, ice) * (0.7 + 0.3 * rn));
          #endif
          vec3 iceC = mix(vec3(0.42, 0.5, 0.56), vec3(0.8, 0.84, 0.88), clamp(wxSnow * 0.8 + rn * 0.3, 0.0, 1.0));
          vec3 iceL = iceC * wxLight + sunCol * pow(sd, 40.0) * 0.4 * wxSpec;
          col = mix(col, iceL, im * 0.95);
          foam *= 1.0 - im;
        }
        float fogV = texture2D(fogTex, p / fogSize).r;
        float fogK = fogV < 0.5 ? fogV * 0.9 : 0.45 + (fogV - 0.5) * 1.1;
        col *= mix(1.0, fogK, fogEnabled);
        #if WATER_Q > 0
          float alpha = smoothstep(0.0, 0.06, depthW) * (0.9 + 0.1 * fres) + max(foam, wwF) * 0.1 + oil * 0.3;
          alpha *= smoothstep(0.0, 0.06, depthW);
        #else
          float alpha = (max(mix(0.55, 0.92, depth), fres * 0.85) + max(foam, wwF) * 0.25 + oil * 0.3) * smoothstep(0.0, 0.06, depthW);
        #endif
        // never hand NaN / Inf to the HDR chain (bloom would smear it over the frame)
        col = (col.r >= 0.0 && col.g >= 0.0 && col.b >= 0.0) ? min(col, vec3(32.0)) : vec3(0.0);
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  // shared smoky shroud / haze instead of the plain darkening above
  fog.upgradeShader(material);
  const mesh = new THREE.Mesh(waterGeometry(m), material);
  mesh.position.set(0, WATER_LEVEL, 0);
  mesh.renderOrder = 1;
  mesh.name = 'water';
  if (reflection) {
    reflection.meshes.push(mesh);
    mesh.onBeforeRender = reflection.hook;
  }
  mesh.userData.waterReflection = reflection;
  return { mesh, material, reflection, river };
}

/** Quads over the tiles that are (partly) under water, plus a margin, instead of a map-wide sheet. */
function waterGeometry(m: GameMap): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const W = m.w;
  const H = m.h;
  const vh = (x: number, y: number) => m.heights[Math.max(0, Math.min(H, y)) * (W + 1) + Math.max(0, Math.min(W, x))];
  const wet = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const lo = Math.min(vh(x, y), vh(x + 1, y), vh(x, y + 1), vh(x + 1, y + 1));
      if (lo < WATER_LEVEL + 0.02) wet[y * W + x] = 1;
    }
  // merge runs of wet tiles per row into one quad
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (!wet[y * W + x]) {
        x++;
        continue;
      }
      let e = x;
      while (e < W && wet[y * W + e]) e++;
      const b = pos.length / 3;
      // extend the edges of the map so the outskirts water meets it
      const x0 = x === 0 ? -0.001 : x;
      const x1 = e === W ? W + 0.001 : e;
      pos.push(x0, 0, y, x1, 0, y, x1, 0, y + 1, x0, 0, y + 1);
      idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
      x = e;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}
