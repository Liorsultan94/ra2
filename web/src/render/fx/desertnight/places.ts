import { WATER_LEVEL, groundHeight, Tile, type GameMap, type Structure } from '../../../sim/map';
import { hash2 } from '../../../sim/rng';
import { surfaceHeight } from '../../ground';
import { buildingSlotsFor } from './slots';

/*
 * The desert night's light plan (NT1, render only): WHERE the lights of Sinai's villages, towns and roads are.
 * Pure functions of the map and the seed (hash of tile positions; no Math.random, no THREE), so the plan is the
 * same on every client and every run and can be tested without a GL context. The sim never reads any of this.
 *
 *  - windows: only the lit ones (about half the houses sleep with every light out), 1 in 10 of them a TV;
 *  - lamps: porch lamps by the doors, street lamps along the roads inside the villages, the mosque's lights,
 *    courtyard cooking fires;
 *  - posts: the street lamps' poles.
 * Sea, resort and oil-site lights are planned in sea.ts the same way.
 */

/** Light modes of a lamp sprite (the shader animates them from the clock: nothing per frame on the CPU). */
export const enum Mode {
  Steady = 0,
  /** Cooking fire / candle: an irregular flicker. */
  Fire = 1,
  /** A slow navigation blink (buoys): a short flash every few seconds. */
  Blink = 2,
  /** A red aviation / mast light: a slow pulse. */
  Pulse = 3,
  /** A lit sign or string of bulbs: steady with a faint buzz. */
  Sign = 4,
}

export interface NightWindow {
  x: number;
  y: number;
  z: number;
  /** Outward normal on the ground plane (unit). */
  nx: number;
  nz: number;
  w: number;
  h: number;
  /** Index into plan.houses. */
  house: number;
  /** 1: a TV's cold flicker. */
  tv: number;
  /** 0..1: warm tone variation (bulb / tube / curtain). */
  tone: number;
  /** 1: a shop front (brighter, whiter). */
  shop: number;
}

export interface NightLamp {
  x: number;
  y: number;
  z: number;
  /** Sprite size (tiles). */
  size: number;
  r: number;
  g: number;
  b: number;
  mode: Mode;
  phase: number;
  /** Radius of the soft pool of light it throws on the ground (0: none). */
  pool: number;
  kind: string;
  /** Index into plan.houses (-1: none): the lamp goes out with its house. */
  house: number;
}

export interface NightPost {
  x: number;
  y: number;
  z: number;
  h: number;
}

export interface HouseNight {
  st: Structure;
  /** Its lights are on tonight (about half of the houses; the mosque always). */
  awake: boolean;
  cx: number;
  cz: number;
}

export interface DesertPlan {
  houses: HouseNight[];
  windows: NightWindow[];
  lamps: NightLamp[];
  posts: NightPost[];
  /** Gas flare stacks of the oil sites (a pipe; the flame is a lamp). */
  stacks: NightPost[];
  /** Highway marker posts (a low post with a small reflector light each). */
  markers: NightPost[];
}

/** The desert layout (a map with a Red Sea coast and the Sinai towns): the only map this plan exists for. */
export function isDesertLayout(m: GameMap): boolean {
  return m.biome === 'desert' && !!m.deco?.sea;
}

export function emptyPlan(): DesertPlan {
  return { houses: [], windows: [], lamps: [], posts: [], stacks: [], markers: [] };
}

/** Is a structure's light on tonight? Deterministic by tile position and the match seed; about half sleep. */
export function houseAwake(st: Structure, seed: number): boolean {
  if (st.look === 'mosque') return true;
  // shop-houses keep their lights on more often
  return hash2(st.x, st.y, 4917 + (seed | 0) * 31) < (st.look === 'shop' ? 0.62 : 0.5);
}

const WARM: [number, number, number][] = [
  [1.0, 0.62, 0.28],
  [1.0, 0.7, 0.36],
  [1.0, 0.55, 0.22],
  [1.0, 0.78, 0.5],
];

/** Caps on the plan (the instance buffers are sized from them). */
export const CAPS = { windows: 900, lamps: 700, posts: 160, markers: 160, lampsTotal: 1400 };

export function planTown(m: GameMap, seed: number, posts = true): DesertPlan {
  const plan = emptyPlan();
  if (!isDesertLayout(m)) return plan;
  const hs = (a: number, b: number, c: number) => hash2(a | 0, b | 0, c + (seed | 0) * 17);
  m.structures.forEach((st) => {
    const cx = st.x + st.w / 2;
    const cz = st.y + st.h / 2;
    // (the shared slots file decides who is awake when it exists: the models' lit windows and these lights agree)
    let gy = 99;
    for (const [x, z] of [
      [st.x, st.y],
      [st.x + st.w, st.y],
      [st.x, st.y + st.h],
      [st.x + st.w, st.y + st.h],
      [cx, cz],
    ])
      gy = Math.min(gy, surfaceHeight(m, x, z));
    const slots = buildingSlotsFor(m, st, gy);
    const awake = st.look === 'mosque' || (slots.awake ?? houseAwake(st, seed));
    const hi = plan.houses.length;
    plan.houses.push({ st, awake, cx, cz });
    const lit = slots.windows.filter((w, i) => awake && (w.lit ?? (st.look === 'mosque' || hs(st.x * 13 + i, st.y, 61) < 0.72)));
    // at least one window of an awake house is on
    if (awake && !lit.length && slots.windows.length) lit.push(slots.windows[0]);
    lit.forEach((w, i) => {
      if (plan.windows.length >= CAPS.windows) return;
      const r = hs(st.x * 7 + i, st.y * 3, 62);
      const tv = w.tv ?? (r < 0.1 && !w.shop && st.look !== 'mosque');
      plan.windows.push({ x: w.x, y: w.y, z: w.z, nx: w.nx, nz: w.nz, w: w.w, h: w.h, house: hi, tv: tv ? 1 : 0, tone: hs(st.x + i * 5, st.y, 63), shop: w.shop ? 1 : 0 });
    });
    // lamps by the doors (also on some sleeping houses: a porch lamp is left on)
    for (const d of slots.lamps?.length ? [] : slots.doors) {
      if (plan.lamps.length >= CAPS.lamps) break;
      const p = hs(st.x + 3, st.y + 5, 64);
      if (p > (awake ? 0.7 : 0.28)) continue;
      const c = WARM[Math.floor(hs(st.x, st.y, 65) * WARM.length)];
      plan.lamps.push({ x: d.x + d.nx * 0.04, y: d.y + 0.2, z: d.z + d.nz * 0.04, size: 0.1, r: c[0], g: c[1], b: c[2], mode: Mode.Steady, phase: p, pool: 0.5, kind: 'porch', house: hi });
    }
    // the shared slots' own lamps: porch / wall lamps, roof lights, shop signs (only the ones switched on)
    for (const l of slots.lamps ?? []) {
      if (!l.lit || plan.lamps.length >= CAPS.lamps) continue;
      plan.lamps.push({ x: l.x, y: l.y, z: l.z, size: l.size, r: l.r, g: l.g, b: l.b, mode: l.mode, phase: l.phase, pool: l.pool, kind: l.kind, house: hi });
    }
    // the mosque: a lit minaret with a green crown light, an uplit dome, a lamp over the gate
    if (st.look === 'mosque') {
      for (const l of slots.mosque) plan.lamps.push({ ...l, house: hi });
    }
    // a cooking fire in some yards
    if (slots.yardFire && hs(st.x, st.y, 66) < 0.4) {
      const f = slots.yardFire;
      plan.lamps.push({ x: f.x, y: f.y + 0.05, z: f.z, size: 0.2, r: 1.0, g: 0.5, b: 0.16, mode: Mode.Fire, phase: hs(st.x, st.y, 67) * 6.28, pool: 1.1, kind: 'fire', house: -1 });
    }
  });
  if (posts) {
    streetLamps(m, plan, seed);
    highwayMarkers(m, plan);
  }
  return plan;
}

/** Street lamps along the roads, inside the villages only (a pole every ~5 tiles, alternating sides). */
function streetLamps(m: GameMap, plan: DesertPlan, seed: number) {
  const centres = plan.houses.map((h) => [h.cx, h.cz] as const);
  if (!centres.length) return;
  const near = (x: number, z: number, r: number) => {
    const r2 = r * r;
    for (const [cx, cz] of centres) if ((cx - x) * (cx - x) + (cz - z) * (cz - z) < r2) return true;
    return false;
  };
  const blockedAt = (x: number, z: number) => {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 1 || tz < 1 || tx >= m.w - 1 || tz >= m.h - 1) return true;
    const i = tz * m.w + tx;
    return m.tiles[i] === Tile.Water || m.tiles[i] === Tile.Rock || m.blocked[i] === 1;
  };
  const STEP = 5;
  let side = 1;
  m.roads.forEach((r, ri) => {
    const wd = (m.deco?.roadStyles[ri]?.width ?? 1) / 2;
    let next = hash2(ri, seed | 0, 70) * STEP;
    let done = 0;
    for (let i = 0; i + 1 < r.length; i++) {
      const ax = r[i].x + 0.5;
      const az = r[i].y + 0.5;
      const bx = r[i + 1].x + 0.5;
      const bz = r[i + 1].y + 0.5;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-3) continue;
      const dx = (bx - ax) / len;
      const dz = (bz - az) / len;
      while (next - done < len) {
        const t = next - done;
        next += STEP;
        const px = ax + dx * t;
        const pz = az + dz * t;
        if (!near(px, pz, 7.5)) continue;
        side = -side;
        const off = wd + 0.5;
        const x = px - dz * off * side;
        const z = pz + dx * off * side;
        if (blockedAt(x, z) || plan.posts.length >= CAPS.posts) continue;
        const gy = surfaceHeight(m, x, z);
        const ph = hash2(Math.floor(x * 4), Math.floor(z * 4), 71);
        plan.posts.push({ x, y: gy, z, h: 0.52 });
        if (plan.lamps.length < CAPS.lamps) plan.lamps.push({ x, y: gy + 0.54, z, size: 0.14, r: 1.0, g: 0.68, b: 0.34, mode: Mode.Steady, phase: ph, pool: 1.6, kind: 'street', house: -1 });
      }
      done += len;
    }
  });
}

/** Ground height at (x, z) for lights standing on the sea floor / shore (never below the sea). */
export function standY(m: GameMap, x: number, z: number): number {
  return Math.max(groundHeight(m, Math.max(0, Math.min(m.w - 0.01, x)), Math.max(0, Math.min(m.h - 0.01, z))), WATER_LEVEL);
}


/**
 * Marker posts along the highway (the wide road, style variant 0): a low post with a small cool reflector light
 * every ~7 tiles on alternating sides, outside the villages (the street lamps do the towns). Gentle: tiny points.
 */
function highwayMarkers(m: GameMap, plan: DesertPlan) {
  const styles = m.deco?.roadStyles ?? [];
  const centres = plan.houses.map((h) => [h.cx, h.cz] as const);
  const inTown = (x: number, z: number) => centres.some(([cx, cz]) => (cx - x) * (cx - x) + (cz - z) * (cz - z) < 64);
  m.roads.forEach((r, ri) => {
    const st = styles[ri];
    if (!st || st.variant !== 0) return;
    const wd = st.width / 2;
    const STEP = 7;
    let next = 3;
    let done = 0;
    let side = 1;
    for (let i = 0; i + 1 < r.length; i++) {
      const ax = r[i].x + 0.5;
      const az = r[i].y + 0.5;
      const bx = r[i + 1].x + 0.5;
      const bz = r[i + 1].y + 0.5;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-3) continue;
      const dx = (bx - ax) / len;
      const dz = (bz - az) / len;
      while (next - done < len) {
        const t = next - done;
        next += STEP;
        const px = ax + dx * t;
        const pz = az + dz * t;
        side = -side;
        const off = wd + 0.34;
        const x = px - dz * off * side;
        const z = pz + dx * off * side;
        const tx = Math.floor(x);
        const tz = Math.floor(z);
        if (tx < 1 || tz < 1 || tx >= m.w - 1 || tz >= m.h - 1 || m.tiles[tz * m.w + tx] === Tile.Water || inTown(x, z) || plan.markers.length >= CAPS.markers) continue;
        const gy = surfaceHeight(m, x, z);
        plan.markers.push({ x, y: gy, z, h: 0.11 });
        if (plan.lamps.length < CAPS.lampsTotal) plan.lamps.push({ x, y: gy + 0.105, z, size: 0.05, r: 0.8, g: 0.92, b: 1.0, mode: Mode.Steady, phase: 0, pool: 0, kind: 'marker', house: -1 });
      }
      done += len;
    }
  });
}
