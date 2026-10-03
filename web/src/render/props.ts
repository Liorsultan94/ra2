import * as THREE from 'three';
import { Tile, StructureKind, type GameMap, type Structure } from '../sim/map';
import { buildingDef } from '../sim/defs';
import { hash2 } from '../sim/rng';
import type { Entity } from '../sim/types';
import type { Effects } from './effects';
import type { FogOfWar } from './fog';
import { CulledInstances, type Inst } from './geo';
import { surfaceHeight } from './ground';
import { FieldType, OCC_FIELD, OCC_ROAD, OCC_TRACK, occAt, segDist, type Layout, type V2 } from './layout';

/*
 * Photoscanned battlefield props (CC0 scans from Poly Haven / ambientCG,
 * baked by tools/bake-props.mjs into web/public/props/): oil drums, crates,
 * jerrycans, tyres, log piles, covered cars, concrete barriers, sandbag walls,
 * tank traps, generators, and in the city benches, bins, dumpsters, lamps,
 * bollards, utility boxes and hydrants.
 *
 *  - Placement is deterministic (a pure function of the map, its scenery
 *    layout and the quality) and purely visual: props keep off roads, tracks,
 *    junctions, bridges, ore fields, derricks, tech sites and the bases' build
 *    areas, and favour spots units never use (inside the village houses'
 *    footprints, along walls, beside road shoulders and river banks). Vehicles
 *    crush them anyway, and a building placed later swallows whatever it covers.
 *  - Rendering: one InstancedMesh per prop type, all sharing ONE material and
 *    three atlases (albedo, normal, AO/roughness/metal). Instances are culled
 *    to the camera's ground footprint on the CPU (CulledInstances), swap to
 *    the ~300-triangle LOD1 when zoomed out and the small ones hide at
 *    strategic zoom. Fog of war, weather (snow / wet / dust), cloud shadows
 *    and the post grade come from the shared FogOfWar patch like all scenery;
 *    on winter maps the props sit in the snow (a noisy snow line).
 *    Shadows: high = every prop flagged in the manifest; medium = the big ones
 *    and only when zoomed in; low quality loads nothing.
 *  - Destruction (driven by EnvDamage): moving vehicles flatten small props and
 *    shove / crush big ones, blasts throw them about (a short ballistic tumble),
 *    char and set the flammable ones burning, red drums and gas bottles may go
 *    up; wreckage sinks out of sight after a while.
 */

// ------------------------------------------------------------------ manifest

export interface PropInfo {
  size: [number, number, number];
  footprint: [number, number];
  height: number;
  biomes: string[];
  destructible: boolean;
  kind: 'small' | 'big' | 'tall' | 'fixed';
  shadow: boolean;
  tris: [number, number];
}

export interface PropsManifest {
  version: number;
  cols: number;
  rows: number;
  model: string;
  atlas: Record<string, { albedo: string; normal: string; orm: string; bytes: number }>;
  props: Record<string, PropInfo>;
}

/** One planned prop: ground position, heading (rotY: local +x turns to (cos, -sin)), optional lean / laid down. */
export interface PropSpot {
  x: number;
  z: number;
  rot: number;
  /** Laid on its side (drums, gas bottles, tyres). */
  lay?: boolean;
  /** Extra sink into the ground (winter snow, rubble). */
  sink?: number;
  /** Brightness / dust tint 0..1 variation seed. */
  tone?: number;
}

export type PropPlan = Map<string, PropSpot[]>;

type Q = 'low' | 'medium' | 'high';

// ------------------------------------------------------------------ placement

/** Frontline Crossing's default tech site candidates (sim/capture.ts; maps without techSites use them). */
const DEFAULT_TECH: { def: string; at: [number, number][] }[] = [
  { def: 'tech_hospital', at: [[18, 60], [14, 40], [22, 66], [12, 44], [28, 44]] },
  { def: 'tech_comms', at: [[54, 88], [36, 82], [22, 90], [40, 86], [52, 66]] },
  { def: 'tech_airport', at: [[6, 30], [8, 24], [4, 36], [10, 34], [12, 28]] },
];

const BASE_CLEAR = 12.5;

/**
 * Plan every prop of the map. Pure and deterministic. `man` supplies the
 * prop sizes (props.json); props whose biome list excludes the map are skipped.
 */
export function planProps(m: GameMap, layout: Layout, quality: Q, man: PropsManifest): PropPlan {
  const plan: PropPlan = new Map();
  if (quality === 'low') return plan;
  const W = m.w;
  const H = m.h;
  const biome = m.biome;
  const dens = quality === 'high' ? 1 : 0.62;
  const info = (id: string) => man.props[id];
  const usable = (id: string) => !!info(id) && info(id).biomes.includes(biome);
  let salt = 0;
  const rnd = (a: number, b = 0) => hash2(Math.floor(a), Math.floor(b), 7001 + (salt++ % 9973));
  const tile = (x: number, z: number) => {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    return tx < 0 || tz < 0 || tx >= W || tz >= H ? -1 : tz * W + tx;
  };

  // ---- static exclusion zones
  const zones: { x0: number; z0: number; x1: number; z1: number }[] = [];
  for (const site of m.techSites ?? (m.id === 'frontline' ? DEFAULT_TECH : [])) {
    const d = buildingDef(site.def);
    for (const [x, y] of site.at)
      for (const [ax, ay] of [
        [x, y],
        [W - x - d.w, H - y - d.h],
      ])
        zones.push({ x0: ax - 0.8, z0: ay - 0.8, x1: ax + d.w + 0.8, z1: ay + d.h + 0.8 });
  }
  for (const o of m.oils) zones.push({ x0: Math.min(o.x, W - 2) - 0.35, z0: Math.min(o.y, H - 2) - 0.35, x1: Math.min(o.x, W - 2) + 2.35, z1: Math.min(o.y, H - 2) + 2.35 });
  // road junctions (traffic lights / roundabouts live there) and the city's painted streets
  const junctions: V2[] = [];
  const roads = layout.roads;
  for (let a = 0; a < roads.length; a++)
    for (let b = 0; b < roads.length; b++) {
      if (a === b) continue;
      const B = roads[b].pts;
      for (const p of [roads[a].pts[0], roads[a].pts[roads[a].pts.length - 1]]) {
        let best = 9;
        for (let i = 0; i < B.length - 1; i += 2) best = Math.min(best, segDist(p.x, p.y, B[i], B[Math.min(B.length - 1, i + 2)]));
        if (best < 1.6) junctions.push(p);
      }
      if (a < b) {
        const A = roads[a].pts;
        for (let i = 0; i < A.length; i += 4)
          for (let j = 0; j < B.length; j += 4) if (Math.abs(A[i].x - B[j].x) < 0.6 && Math.abs(A[i].y - B[j].y) < 0.6) junctions.push(A[i]);
      }
    }
  const streets = layout.fields.filter((f) => f.type === FieldType.Avenue || f.type === FieldType.Street || f.type === FieldType.Crossing);
  for (const f of layout.fields) if (f.type === FieldType.Crossing) junctions.push({ x: f.cx, y: f.cy });
  const onStreet = (x: number, z: number, r: number) => {
    for (const f of streets) {
      const ca = Math.cos(f.angle);
      const sa = Math.sin(f.angle);
      const a = (x - f.cx) * ca + (z - f.cy) * sa;
      const b = -(x - f.cx) * sa + (z - f.cy) * ca;
      if (f.type === FieldType.Crossing ? Math.abs(a) < f.hl + r && Math.abs(b) < f.hw + r : Math.abs(a) < f.hl + r && Math.abs(b) < 1.32 + r) return true;
    }
    return false;
  };
  const avoidPts: { x: number; z: number; r: number }[] = [];
  for (const w of layout.wrecks) avoidPts.push({ x: w.x, z: w.y, r: 0.4 });
  for (const run of layout.poles) for (const p of run) avoidPts.push({ x: p.x, z: p.y, r: 0.12 });
  for (const line of layout.pylons.lines) for (const p of line) avoidPts.push({ x: p.x, z: p.y, r: 0.45 });
  for (const t of m.deco?.trees ?? []) avoidPts.push({ x: t.x, z: t.y, r: 0.25 });

  // ---- placed props (collision between props)
  const placed = new Map<number, { x: number; z: number; r: number }[]>();
  const bucket = (x: number, z: number) => Math.floor(z) * W + Math.floor(x);
  const clearOfProps = (x: number, z: number, r: number) => {
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const l = placed.get(bucket(x + dx, z + dz));
        if (l) for (const p of l) if (Math.hypot(p.x - x, p.z - z) < (p.r + r) * 0.9) return false;
      }
    return true;
  };
  const near = (pts: { x: number; z: number; r: number }[], x: number, z: number, r: number) => pts.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + r);

  interface Opts {
    /** May stand on a structure's (blocked) footprint: village yards. */
    yard?: boolean;
    /** May stand on farm fields / plazas. */
    field?: boolean;
    /** Skip the prop-to-prop spacing check (tight clusters handle their own). */
    tight?: boolean;
    lay?: boolean;
    sink?: number;
  }
  /** Can a prop of radius r stand at (x, z)? */
  const ok = (x: number, z: number, r: number, o: Opts = {}) => {
    if (x < 1.2 || z < 1.2 || x > W - 1.2 || z > H - 1.2) return false;
    if (m.starts.some((s) => Math.hypot(x - s.x - 0.5, z - s.y - 0.5) < BASE_CLEAR)) return false;
    for (const [sx, sz] of [
      [0, 0],
      [r, 0],
      [-r, 0],
      [0, r],
      [0, -r],
    ]) {
      const i = tile(x + sx, z + sz);
      if (i < 0) return false;
      const t = m.tiles[i];
      if (t === Tile.Water || t === Tile.Bridge || t === Tile.Rock || m.trees[i] || m.ore[i] || m.oreKind[i]) return false;
      if (m.blocked[i] && !o.yard) return false;
      const oc = occAt(layout, m, x + sx, z + sz);
      if (oc & (OCC_ROAD | OCC_TRACK)) return false;
      if (oc & OCC_FIELD && !o.field) return false;
    }
    for (const mm of m.oreMines) if (Math.hypot(x - mm.x - 0.5, z - mm.y - 0.5) < 4.6) return false;
    for (const zn of zones) if (x > zn.x0 - r && x < zn.x1 + r && z > zn.z0 - r && z < zn.z1 + r) return false;
    for (const j of junctions) if (Math.hypot(x - j.x, z - j.y) < 3 + r) return false;
    if (streets.length && onStreet(x, z, r)) return false;
    if (near(avoidPts, x, z, r)) return false;
    for (const b of m.bridges) if (Math.hypot(x - b.x, z - b.y) < b.length / 2 + 0.9) return false;
    // steep ground: props would float or dig in
    const h0 = surfaceHeight(m, x, z);
    if (Math.abs(surfaceHeight(m, x + r + 0.05, z) - h0) + Math.abs(surfaceHeight(m, x, z + r + 0.05) - h0) > 0.12 + r * 0.3) return false;
    return true;
  };
  const radius = (id: string) => {
    const f = info(id).footprint;
    return Math.hypot(f[0], f[1]) / 2;
  };
  /** Place prop `id` if the spot is valid; returns success. */
  const put = (id: string, x: number, z: number, rot: number, o: Opts = {}): boolean => {
    if (!usable(id)) return false;
    const r = o.lay ? Math.max(info(id).height, info(id).footprint[0]) / 2 : radius(id);
    if (!ok(x, z, r * 0.8, o)) return false;
    if (!o.tight && !clearOfProps(x, z, r)) return false;
    let l = plan.get(id);
    if (!l) plan.set(id, (l = []));
    l.push({ x, z, rot, lay: o.lay, sink: o.sink, tone: rnd(x * 31, z * 17) });
    const k = bucket(x, z);
    let pl = placed.get(k);
    if (!pl) placed.set(k, (pl = []));
    pl.push({ x, z, r: r * 0.85 });
    return true;
  };
  const pick = <T>(arr: T[], h: number) => arr[Math.min(arr.length - 1, Math.floor(h * arr.length))];
  /** Keep only the props this biome uses. */
  const avail = (ids: string[]) => ids.filter(usable);
  const winterSink = biome === 'winter' ? 0.012 : 0;

  /** A tight group of small props around (x, z): drums standing (some lying), cans, bottles. */
  const cluster = (cx: number, cz: number, ids: string[], n: number, spread: number, seed: number, o: Opts = {}) => {
    const set = avail(ids);
    if (!set.length) return 0;
    let done = 0;
    for (let k = 0; k < n * 3 && done < n; k++) {
      const a = hash2(seed, k, 811) * Math.PI * 2;
      const d = Math.sqrt(hash2(seed, k, 812)) * spread;
      const id = pick(set, hash2(seed, k, 813));
      const lay = (id.startsWith('drum') || id === 'propane') && hash2(seed, k, 814) < 0.16;
      if (put(id, cx + Math.cos(a) * d, cz + Math.sin(a) * d, hash2(seed, k, 815) * Math.PI * 2, { ...o, lay, sink: winterSink + (o.sink ?? 0) })) done++;
    }
    return done;
  };

  // ------------------------------------------------ village yards
  const yardSets: Record<string, { wall: string[]; out: string[]; big: string[] }> = {
    temperate: { wall: ['drum_blue', 'barrel_wood', 'crate_long', 'jerrycan', 'drum_red', 'tyre', 'drum_plastic'], out: ['pallets', 'crate_long', 'barrel_wood', 'tyre', 'generator'], big: ['car_covered', 'woodpile'] },
    desert: { wall: ['drum_red', 'drum_blue', 'drum_rust', 'jerrycan', 'propane', 'tyre'], out: ['pallets', 'tyre_stack', 'drum_rust', 'generator'], big: ['car_covered'] },
    winter: { wall: ['woodpile', 'barrel_wood', 'drum_rust', 'crate_long', 'tyre', 'jerrycan'], out: ['tyre_stack', 'pallets', 'woodpile', 'drum_blue'], big: ['car_covered', 'woodpile'] },
  };
  const ys = yardSets[biome];
  if (ys)
    m.structures.forEach((st, si) => {
      const body = houseBody(st, biome);
      if (!body) return;
      const cx = st.x + st.w / 2;
      const cz = st.y + st.h / 2;
      const a = (st.rot * Math.PI) / 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // local -> world (rotation about +y, as in scenery.ts)
      const W2 = (lx: number, lz: number): [number, number] => [cx + lx * ca + lz * sa, cz - lx * sa + lz * ca];
      const hx = st.rot % 2 ? st.h / 2 : st.w / 2;
      const hz = st.rot % 2 ? st.w / 2 : st.h / 2;
      const h = (k: number) => hash2(st.x * 7 + k, st.y * 13 + si, 4242);
      if (h(0) > 0.92 * dens + 0.08) return;
      // back band (inside the footprint, behind the house): a row of clutter along the wall
      const bz0 = -body.hz - 0.04;
      const bandD = hz - body.hz;
      if (bandD > 0.12) {
        const n = 1 + Math.floor(h(1) * 3 * dens + 0.4);
        for (let k = 0; k < n; k++) {
          const id = pick(avail(ys.wall), h(10 + k));
          if (!id) break;
          const d = info(id).footprint;
          const lx = (h(20 + k) - 0.5) * 2 * Math.max(0, hx - 0.2);
          const lz = bz0 - Math.min(d[1], bandD * 0.5);
          const [x, z] = W2(lx, lz);
          if (id === 'woodpile' || id === 'crate_long') put(id, x, z, -a + (h(30 + k) - 0.5) * 0.15, { yard: true, sink: winterSink });
          else cluster(x, z, [id, ...avail(ys.wall).filter((s) => s.startsWith('drum') || s === 'jerrycan')], 2 + Math.floor(h(40 + k) * 3), 0.12, st.x * 977 + st.y * 31 + k, { yard: true });
        }
      }
      // side bands: single drums / barrels against the gable walls
      for (const s of [-1, 1]) {
        if (h(50 + s) > 0.55 * dens) continue;
        const id = pick(avail(ys.wall.filter((i) => i !== 'woodpile' && i !== 'crate_long')), h(52 + s));
        if (!id) continue;
        const [x, z] = W2(s * (body.hx + 0.09), (h(54 + s) - 0.5) * body.hz);
        put(id, x, z, h(56 + s) * 6.28, { yard: true, sink: winterSink });
      }
      // just outside the footprint (behind / beside, never the front): bigger things
      if (h(60) < 0.7 * dens) {
        const id = pick(avail(ys.out), h(61));
        const side = h(62) < 0.5 ? -1 : 1;
        const back = h(63) < 0.5;
        if (id) {
          const off = 0.05 + info(id).footprint[1] / 2;
          const [x, z] = back ? W2((h(64) - 0.5) * hx, -hz - off) : W2(side * (hx + off), (h(64) - 0.6) * hz);
          put(id, x, z, -a + (back ? 0 : Math.PI / 2) + (h(65) - 0.5) * 0.5, { sink: winterSink });
        }
      }
      if (h(70) < 0.32 * dens) {
        const id = pick(avail(ys.big), h(71));
        if (id) {
          const side = h(72) < 0.5 ? -1 : 1;
          // outside the yard fence (0.35 off the footprint)
          const [x, z] = W2(side * (hx + 0.42 + info(id).footprint[1] / 2), (h(73) - 0.5) * 0.3);
          put(id, x, z, -a + Math.PI / 2 + (h(74) - 0.5) * 0.4, { sink: winterSink });
        }
      }
      // desert courtyards: the walled yard is full of stuff
      if (st.kind === StructureKind.Courtyard) {
        const n = Math.round(3 + h(80) * 4 * dens);
        for (let k = 0; k < n; k++) {
          const [x, z] = W2(-1.0 + h(81 + k) * 1.35, 0.12 + h(90 + k) * 0.45);
          const id = pick(avail(['drum_red', 'drum_blue', 'jerrycan', 'propane', 'pallets', 'drum_rust']), h(100 + k));
          if (id) put(id, x, z, h(110 + k) * 6.28, { yard: true, lay: id.startsWith('drum') && h(120 + k) < 0.2 });
        }
      }
    });

  // ------------------------------------------------ road shoulders (country roads)
  const shoulderSets: Record<string, string[][]> = {
    temperate: [['barrier', 'barrier'], ['car_covered'], ['drum_blue', 'drum_red', 'drum_blue'], ['pallets'], ['crate_long', 'crate_ammo'], ['tyre', 'tyre']],
    desert: [['block', 'block', 'block'], ['car_covered'], ['drum_rust', 'drum_red'], ['tyre_stack'], ['jerrycan', 'jerrycan', 'drum_red'], ['barrier', 'barrier']],
    winter: [['tyre_stack'], ['car_covered'], ['drum_rust', 'drum_blue'], ['woodpile'], ['barrel_wood', 'crate_long'], ['tyre', 'tyre']],
  };
  const ss = shoulderSets[biome];
  if (ss)
    roads.forEach((r, ri) => {
      if (r.painted) return;
      const step = Math.round((quality === 'high' ? 26 : 40) + hash2(ri, 3, 9100) * 12);
      for (let i = 10; i < r.pts.length - 10; i += step + Math.floor(hash2(ri, i, 9101) * 18)) {
        const p = r.pts[i];
        const q = r.pts[i + 1];
        const L = Math.hypot(q.x - p.x, q.y - p.y) || 1;
        const dx = (q.x - p.x) / L;
        const dz = (q.y - p.y) / L;
        const side = hash2(ri, i, 9102) < 0.5 ? -1 : 1;
        const set = pick(ss, hash2(ri, i, 9103)).filter(usable);
        if (!set.length) continue;
        const rot = Math.atan2(-dz, dx);
        let along = 0;
        set.forEach((id, k) => {
          const d = info(id).footprint;
          const off = r.width / 2 + 0.36 + d[1] / 2 + (id === 'car_covered' ? 0.05 : 0);
          const x = p.x - dz * off * side + dx * along;
          const z = p.y + dx * off * side + dz * along;
          along += d[0] + 0.04;
          const jit = (hash2(ri, i + k, 9104) - 0.5) * (id === 'barrier' || id === 'block' ? 0.12 : 0.8);
          put(id, x, z, rot + jit, { sink: winterSink });
        });
      }
    });

  // ------------------------------------------------ derricks: fuel drums, jerrycans, gas bottles, pallets
  m.oils.forEach((o, oi) => {
    const cx = Math.min(o.x, W - 2) + 1;
    const cz = Math.min(o.y, H - 2) + 1;
    const n = quality === 'high' ? 3 : 2;
    for (let k = 0; k < n; k++) {
      const a = hash2(oi, k, 9200) * Math.PI * 2 + (k * Math.PI * 2) / n;
      const d = 1.75 + hash2(oi, k, 9201) * 0.5;
      const x = cx + Math.cos(a) * d;
      const z = cz + Math.sin(a) * d;
      const done = cluster(x, z, biome === 'winter' ? ['drum_rust', 'drum_blue', 'jerrycan'] : ['drum_red', 'drum_blue', 'drum_red', 'drum_rust', 'jerrycan', 'propane'], 4 + Math.floor(hash2(oi, k, 9202) * 4), 0.26, oi * 31 + k);
      if (done && hash2(oi, k, 9203) < 0.6) put(pick(avail(['pallets', 'generator', 'crate_ammo']), hash2(oi, k, 9204)) ?? 'pallets', x + Math.cos(a + 1.4) * 0.45, z + Math.sin(a + 1.4) * 0.45, a, {});
    }
  });

  // ------------------------------------------------ battle zones: bridge heads, fords / passes, river banks
  const fort = (x: number, z: number, faceX: number, faceZ: number, seed: number) => {
    // a short sandbag wall facing (faceX, faceZ), an ammo crate / jerrycan behind it
    const rot = Math.atan2(faceX, faceZ) + Math.PI; // wall's long axis (local x) across the facing
    const rx = Math.cos(rot);
    const rz = -Math.sin(rot);
    let ok2 = put('sandbags', x, z, rot, { sink: winterSink });
    if (ok2 && hash2(seed, 1, 9300) < 0.6) put('sandbags', x + rx * 0.47 - faceX * 0.08, z + rz * 0.47 - faceZ * 0.08, rot - 0.35, { sink: winterSink });
    if (ok2 && hash2(seed, 2, 9300) < 0.6) put(pick(avail(['crate_ammo', 'jerrycan', 'crate_ammo']), hash2(seed, 3, 9300)), x - faceX * 0.24, z - faceZ * 0.24, rot + 0.3, { sink: winterSink });
    return ok2;
  };
  const hedgehogs = (x: number, z: number, dirX: number, dirZ: number, n: number, seed: number) => {
    for (let k = 0; k < n; k++) {
      const t = (k - (n - 1) / 2) * 0.44;
      const j = (hash2(seed, k, 9310) - 0.5) * 0.14;
      put('hedgehog', x + dirX * t - dirZ * j, z + dirZ * t + dirX * j, hash2(seed, k, 9311) * 6.28, { sink: winterSink });
    }
  };
  m.bridges.forEach((b, bi) => {
    const dx = Math.cos(b.angle);
    const dz = Math.sin(b.angle);
    for (const e of [-1, 1]) {
      // deck end and the outward road direction
      const ex = b.x + (dx * e * b.length) / 2;
      const ez = b.y + (dz * e * b.length) / 2;
      const ox = dx * e;
      const oz = dz * e;
      const nx = -oz;
      const nz = ox;
      for (const s of [-1, 1]) {
        // sandbag posts either side of the approach, facing the river
        fort(ex + ox * 1.1 + nx * s * 1.15, ez + oz * 1.1 + nz * s * 1.15, -ox, -oz, bi * 13 + e * 5 + s);
        // a staggered pair of concrete barriers beside the road
        put(usable('barrier') ? 'barrier' : 'block', ex + ox * (2.1 + (s > 0 ? 0.6 : 0)) + nx * s * 0.95, ez + oz * (2.1 + (s > 0 ? 0.6 : 0)) + nz * s * 0.95, Math.atan2(-oz, ox) + (hash2(bi, s, 9320) - 0.5) * 0.2, { sink: winterSink });
        // tank traps along the bank on either side of the bridge head
        if (usable('hedgehog')) hedgehogs(ex + nx * s * 2.6 + ox * 0.6, ez + nz * s * 2.6 + oz * 0.6, nx, nz, quality === 'high' ? 4 : 3, bi * 101 + e * 7 + s);
      }
    }
  });
  for (const [li, l] of (m.lanes ?? []).entries()) {
    for (const s of [-1, 1]) {
      const a = hash2(li, s + 2, 9330) * Math.PI * 2;
      const x = l.x + 0.5 + Math.cos(a) * (2.4 + hash2(li, s, 9331));
      const z = l.y + 0.5 + Math.sin(a) * (2.4 + hash2(li, s, 9331));
      if (usable('hedgehog')) hedgehogs(x, z, Math.cos(a + 1.57), Math.sin(a + 1.57), 3, li * 17 + s);
      else fort(x, z, l.x + 0.5 - x, l.y + 0.5 - z, li * 17 + s);
    }
  }
  // river banks in no-man's land: an outpost every few tiles of bank
  if (biome !== 'urban') {
    const step = quality === 'high' ? 5 : 7;
    let seed = 0;
    for (let tz = 4; tz < H - 4; tz += step)
      for (let tx = 4; tx < W - 4; tx += step) {
        seed++;
        if (hash2(tx, tz, 9340) > 0.5 * dens) continue;
        const x = tx + hash2(tx, tz, 9341) * step;
        const z = tz + hash2(tx, tz, 9342) * step;
        // nearest water within 2 tiles
        let wx = 0;
        let wz = 0;
        let wn = 0;
        for (let dz2 = -2; dz2 <= 2; dz2++)
          for (let dx2 = -2; dx2 <= 2; dx2++) {
            const i = tile(x + dx2, z + dz2);
            if (i >= 0 && m.tiles[i] === Tile.Water) {
              wx += dx2;
              wz += dz2;
              wn++;
            }
          }
        if (wn < 3) continue;
        const d0 = Math.min(Math.hypot(x - m.starts[0].x, z - m.starts[0].y), Math.hypot(x - m.starts[1].x, z - m.starts[1].y));
        if (d0 < 20) continue;
        const l = Math.hypot(wx, wz) || 1;
        const fx = wx / l;
        const fz = wz / l;
        // stand back from the water's edge
        const bx = x - fx * 0.9;
        const bz = z - fz * 0.9;
        if (hash2(tx, tz, 9343) < 0.55) fort(bx, bz, fx, fz, seed);
        else if (usable('hedgehog')) hedgehogs(bx + fx * 0.3, bz + fz * 0.3, -fz, fx, 3, seed);
      }
  }

  // ------------------------------------------------ forest edges: stumps (and log piles in the winter woods)
  if (usable('stump')) {
    const step = quality === 'high' ? 3 : 4;
    for (let tz = 2; tz < H - 2; tz += step)
      for (let tx = 2; tx < W - 2; tx += step) {
        const x = tx + hash2(tx, tz, 9400) * step;
        const z = tz + hash2(tx, tz, 9401) * step;
        const i = tile(x, z);
        if (i < 0 || m.trees[i]) continue;
        let trees = 0;
        for (const [ax, az] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const j = tile(x + ax, z + az);
          if (j >= 0 && m.trees[j]) trees++;
        }
        if (!trees || hash2(tx, tz, 9402) > 0.3 * dens) continue;
        if (biome === 'winter' && hash2(tx, tz, 9403) < 0.35) put('woodpile', x, z, hash2(tx, tz, 9404) * 6.28, { sink: winterSink });
        else put('stump', x, z, hash2(tx, tz, 9405) * 6.28, { sink: winterSink + 0.01 });
      }
  }

  // ------------------------------------------------ city: squares, sidewalks, rubble lots, parks
  if (biome === 'urban') {
    const deco = m.deco;
    for (const [pi, p] of (deco?.plazas ?? []).entries()) {
      const cx = (p.x0 + p.x1) / 2;
      const cz = (p.y0 + p.y1) / 2;
      if (m.starts.some((s) => Math.hypot(cx - s.x - 0.5, cz - s.y - 0.5) < BASE_CLEAR + 2)) continue;
      const inset = 0.5;
      const edges: [V2, V2, V2][] = [
        [{ x: p.x0 + inset, y: p.y0 + inset }, { x: p.x1 - inset, y: p.y0 + inset }, { x: 0, y: 1 }],
        [{ x: p.x1 - inset, y: p.y0 + inset }, { x: p.x1 - inset, y: p.y1 - inset }, { x: -1, y: 0 }],
        [{ x: p.x1 - inset, y: p.y1 - inset }, { x: p.x0 + inset, y: p.y1 - inset }, { x: 0, y: -1 }],
        [{ x: p.x0 + inset, y: p.y1 - inset }, { x: p.x0 + inset, y: p.y0 + inset }, { x: 1, y: 0 }],
      ];
      // lamps in the corners
      for (const [a] of edges) put('lamp', a.x, a.y, Math.atan2(cx - a.x, cz - a.y) - Math.PI / 2, { field: true });
      edges.forEach(([a, b, n], ei) => {
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        const ux = (b.x - a.x) / L;
        const uz = (b.y - a.y) / L;
        // bollards across the middle of the edge (where the square opens to the street)
        const nb = 5;
        for (let k = 0; k < nb; k++) {
          const t = L / 2 + (k - (nb - 1) / 2) * 0.3;
          put('bollard', a.x + ux * t - n.x * 0.15, a.y + uz * t - n.y * 0.15, 0, { field: true, tight: true });
        }
        // benches facing in, a bin beside every other one
        const gap = quality === 'high' ? 1.5 : 2.2;
        for (let t = 0.9, k = 0; t < L - 0.6; t += gap, k++) {
          if (Math.abs(t - L / 2) < 1.0) continue;
          const x = a.x + ux * t + n.x * 0.12;
          const z = a.y + uz * t + n.y * 0.12;
          if (put('bench', x, z, Math.atan2(n.x, n.y), { field: true }) && k % 2 === 0) put('bin', x + ux * 0.36, z + uz * 0.36, hash2(pi, k, 9500) * 6.28, { field: true });
        }
        // a checkpoint on one side: barriers, sandbags, a couple of tank traps
        if (hash2(pi, ei, 9501) < 0.35 * dens) {
          const t = L * (0.2 + hash2(pi, ei, 9502) * 0.15);
          fort(a.x + ux * t + n.x * 0.55, a.y + uz * t + n.y * 0.55, -n.x, -n.y, pi * 7 + ei);
          put('barrier', a.x + ux * (t + 0.7) + n.x * 0.45, a.y + uz * (t + 0.7) + n.y * 0.45, Math.atan2(-uz, ux), { field: true });
        }
      });
    }
    // sidewalks: between the street lamps (citybldgs.ts puts them every 5 tiles from 2.5), both sides
    m.roads.forEach((pts, ri) => {
      const st = deco?.roadStyles[ri];
      if (!st?.straight || pts.length !== 2) return;
      const a = { x: pts[0].x + 0.5, y: pts[0].y + 0.5 };
      const b = { x: pts[1].x + 0.5, y: pts[1].y + 0.5 };
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      const dx = (b.x - a.x) / L;
      const dz = (b.y - a.y) / L;
      for (let s = 5, k = 0; s < L - 2; s += 5, k++)
        for (const side of [-1, 1]) {
          const h = hash2(ri * 131 + k, side + 2, 9600);
          if (h > 0.85 * dens) continue;
          const off = side * 1.62;
          const x = a.x + dx * s - dz * off;
          const z = a.y + dz * s + dx * off;
          const roll = hash2(ri * 131 + k, side + 2, 9601);
          const along = Math.atan2(-dz, dx);
          if (roll < 0.22) put('hydrant', x, z, along, {});
          else if (roll < 0.42) put('utility_box', x - dz * side * 0.03, z + dx * side * 0.03, along + (side > 0 ? Math.PI : 0), {});
          else if (roll < 0.62) {
            put('bin', x, z, roll * 40, {});
            cluster(x + dx * 0.2, z + dz * 0.2, ['trashbag'], 2, 0.08, ri * 7 + k * 3 + side, { tight: false });
          } else if (roll < 0.8) put('bench', x, z, Math.atan2(side * dz, -side * dx), {});
          else cluster(x, z, ['trashbag', 'trashbag', 'drum_plastic'], 3, 0.14, ri * 11 + k * 5 + side);
        }
    });
    // rubble lots: dumpsters, bags, drums, pallets, the odd covered car and concrete blocks
    for (const [li, lt] of (deco?.lots ?? []).entries()) {
      const n = Math.round((3 + (lt.x1 - lt.x0) * (lt.y1 - lt.y0) * 0.12) * dens);
      for (let k = 0; k < n; k++) {
        const x = lt.x0 + 0.6 + hash2(li, k, 9700) * (lt.x1 - lt.x0 - 1.2);
        const z = lt.y0 + 0.6 + hash2(li, k, 9701) * (lt.y1 - lt.y0 - 1.2);
        const roll = hash2(li, k, 9702);
        const rot = Math.round(hash2(li, k, 9703) * 4) * (Math.PI / 2) + (hash2(li, k, 9704) - 0.5) * 0.3;
        if (roll < 0.25) {
          if (put('dumpster', x, z, rot, { field: true })) cluster(x + Math.cos(rot) * 0.3, z - Math.sin(rot) * 0.3, ['trashbag'], 3, 0.16, li * 13 + k, { field: true });
        } else if (roll < 0.4) put('car_covered', x, z, rot, { field: true });
        else if (roll < 0.55) put('block', x, z, rot, { field: true });
        else if (roll < 0.7) put('pallets', x, z, rot, { field: true });
        else if (roll < 0.85) cluster(x, z, ['drum_rust', 'drum_plastic', 'drum_rust'], 4, 0.2, li * 19 + k, { field: true });
        else put('sandbags', x, z, rot, { field: true });
      }
    }
    // parks: benches along the cross paths
    for (const [pi, pk] of (deco?.parks ?? []).entries()) {
      const mx = (pk.x0 + pk.x1) / 2;
      const mz = (pk.y0 + pk.y1) / 2;
      for (const [k, [x, z, rot]] of ([
        // facing the path: rot turns the bench's front (local +z) to (sin rot, cos rot)
        [mx + 0.48, pk.y0 + 1.6, -Math.PI / 2],
        [mx - 0.48, pk.y1 - 1.6, Math.PI / 2],
        [pk.x0 + 1.6, mz - 0.48, 0],
        [pk.x1 - 1.6, mz + 0.48, Math.PI],
      ] as [number, number, number][]).entries())
        if (hash2(pi, k, 9800) < 0.8 * dens && put('bench', x, z, rot, { field: true })) put('bin', x + Math.cos(rot) * 0.32, z - Math.sin(rot) * 0.32, 0, { field: true });
    }
  }
  return plan;
}

/** Local half extents of a village structure's main body (scenery.ts sizes), null for towers / city blocks. */
function houseBody(st: Structure, biome: string): { hx: number; hz: number } | null {
  switch (st.kind) {
    case StructureKind.House:
      return biome === 'desert' ? { hx: 0.68, hz: 0.55 } : { hx: 0.73, hz: 0.53 };
    case StructureKind.Cottage:
      return biome === 'desert' ? { hx: 0.68, hz: 0.55 } : { hx: 0.6, hz: 0.45 };
    case StructureKind.MudHouse:
      return { hx: 0.68, hz: 0.55 };
    case StructureKind.Barn:
      return { hx: 1.25, hz: 0.75 };
    case StructureKind.Courtyard:
      return { hx: 1.25, hz: 0.75 };
    default:
      return null;
  }
}

// ------------------------------------------------------------------ runtime

const enum State {
  Standing = 0,
  /** Crushed flat / knocked over (static). */
  Down = 1,
  /** Flying / tumbling after a blast. */
  Moving = 2,
  /** Sinking out of sight. */
  Fading = 3,
  Gone = 4,
}

interface Kind {
  id: string;
  info: PropInfo;
  ci: CulledInstances;
  lo: THREE.BufferGeometry;
  hi: THREE.BufferGeometry;
  big: boolean;
  /** Hidden beyond this view span (world units). */
  hideSpan: number;
}

interface Mover {
  item: number;
  t: number;
  life: number;
  p: THREE.Vector3;
  v: THREE.Vector3;
  q: THREE.Quaternion;
  spin: THREE.Vector3;
  /** Rest orientation after landing. */
  rest: THREE.Quaternion;
  restY: number;
  burn: boolean;
}

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _ax = new THREE.Vector3();
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _ray = new THREE.Ray();

/** Span (world units) where the props swap to LOD1, and where the small ones hide. */
const LO_SPAN = 15;
const HIDE_SMALL = 24;
const HIDE_BIG = 40;

export class Props {
  readonly group = new THREE.Group();
  ready = false;
  private kinds: Kind[] = [];
  private effects: Effects | null = null;
  // items (structure of arrays): kind index, instance index (CulledInstances order), position, state
  private n = 0;
  private kindOf = new Uint8Array(0);
  private idx = new Int32Array(0);
  private ix = new Float32Array(0);
  private iz = new Float32Array(0);
  private state = new Uint8Array(0);
  private fadeAt = new Float32Array(0);
  private cellStart = new Int32Array(0);
  private cellItems = new Int32Array(0);
  private movers: Mover[] = [];
  private fading: { item: number; t: number; base: THREE.Matrix4; depth: number }[] = [];
  private time = 0;
  private lastT = -1;
  private camKey = '';
  private versions = -1;
  private lod = -1;
  private span = 12;
  private shadowOn = false;
  private seenBuildings = new Set<number>();
  private buildingScan = 0;
  private qi = new Int32Array(512);

  constructor(
    private map: GameMap,
    private layout: Layout,
    private fog: FogOfWar,
    private quality: Q,
  ) {
    this.group.name = 'props';
    this.group.userData.perfCat = 'props';
  }

  /** Effects hook for fires / dust (EnvDamage passes its Effects). */
  attach(effects: Effects) {
    this.effects = effects;
  }

  /** Fetch the manifest, geometry and atlases, plan and build (resolves false on failure / low quality). */
  async load(base = 'props/'): Promise<boolean> {
    if (this.quality === 'low' || typeof fetch === 'undefined') return false;
    try {
      const res = await fetch(base + 'props.json');
      if (!res.ok) return false;
      const man = (await res.json()) as PropsManifest;
      const plan = planProps(this.map, this.layout, this.quality, man);
      if (!plan.size) return false;
      const S = this.quality === 'high' ? '512' : '256';
      const at = man.atlas[S] ?? man.atlas['256'];
      const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([import('three/addons/loaders/GLTFLoader.js'), import('three/addons/libs/meshopt_decoder.module.js')]);
      const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
      const [gltf, albedo, normal, orm] = await Promise.all([loader.loadAsync(base + man.model), texture(base + at.albedo, true), texture(base + at.normal, false), texture(base + at.orm, false)]);
      const geos = new Map<string, THREE.BufferGeometry>();
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) geos.set(mesh.name, dequantize(mesh.geometry, mesh.matrixWorld));
      });
      this.build(plan, man, geos, makeMaterial(this.fog, albedo, normal, orm, this.map.biome === 'winter'));
      return true;
    } catch (e) {
      console.warn('props unavailable', e);
      return false;
    }
  }

  private build(plan: PropPlan, man: PropsManifest, geos: Map<string, THREE.BufferGeometry>, mat: THREE.Material) {
    const m = this.map;
    const items: { k: number; x: number; z: number }[] = [];
    const tint = biomeTint(m.biome);
    const c = new THREE.Color();
    for (const [id, spots] of plan) {
      const hi = geos.get(id);
      const lo = geos.get(`${id}.lod1`);
      const info = man.props[id];
      if (!hi || !lo || !info || !spots.length) continue;
      const insts: Inst[] = spots.map((s) => {
        const inst = spotInst(m, s, info);
        const tone = s.tone ?? 0.5;
        c.setRGB(tint[0], tint[1], tint[2]).multiplyScalar(0.86 + tone * 0.22);
        inst.color = c.clone();
        return inst;
      });
      const k = this.kinds.length;
      const big = info.kind !== 'small';
      const ci = new CulledInstances(hi, mat, insts, m.w, m.h, 4, { castShadow: false, receiveShadow: true, name: `prop-${id}` });
      ci.mesh.userData.perfCat = 'props';
      // the bounding sphere is irrelevant (frustumCulled = false); the CPU cull handles visibility
      this.kinds.push({ id, info, ci, hi, lo, big, hideSpan: big || info.size[1] > 0.3 ? HIDE_BIG : HIDE_SMALL });
      this.group.add(ci.mesh);
      for (let j = 0; j < ci.size; j++) items.push({ k, x: ci.posX(j), z: ci.posZ(j) });
    }
    // items + spatial hash (1-tile cells)
    const n = (this.n = items.length);
    this.kindOf = new Uint8Array(n);
    this.idx = new Int32Array(n);
    this.ix = new Float32Array(n);
    this.iz = new Float32Array(n);
    this.state = new Uint8Array(n);
    this.fadeAt = new Float32Array(n);
    const perKind = new Int32Array(this.kinds.length);
    items.forEach((it, i) => {
      this.kindOf[i] = it.k;
      this.idx[i] = perKind[it.k]++;
      this.ix[i] = it.x;
      this.iz[i] = it.z;
    });
    const W = m.w;
    const cell = (i: number) => Math.max(0, Math.min(m.h - 1, Math.floor(this.iz[i]))) * W + Math.max(0, Math.min(W - 1, Math.floor(this.ix[i])));
    this.cellStart = new Int32Array(W * m.h + 1);
    for (let i = 0; i < n; i++) this.cellStart[cell(i) + 1]++;
    for (let k = 0; k < W * m.h; k++) this.cellStart[k + 1] += this.cellStart[k];
    const fill = this.cellStart.slice(0, W * m.h);
    this.cellItems = new Int32Array(n);
    for (let i = 0; i < n; i++) this.cellItems[fill[cell(i)]++] = i;
    this.ready = true;
    let tris = 0;
    for (const k of this.kinds) tris += k.ci.size * k.info.tris[0];
    console.info(`props: ${n} instances of ${this.kinds.length} kinds (${Math.round(tris / 1000)}k tris at LOD0)`);
  }

  /** Number of instances per prop id (debug / tests). */
  counts(): Record<string, number> {
    const o: Record<string, number> = {};
    for (const k of this.kinds) o[k.id] = k.ci.size;
    return o;
  }

  // ------------------------------------------------------------ per frame

  /** Per frame (Terrain.update): LOD, shadows, view culling, animation, buildings covering props. */
  frame(cam: THREE.Camera | null, time: number, units?: readonly Entity[]) {
    if (!this.ready) return;
    const dt = this.lastT < 0 ? 0 : Math.min(0.1, Math.max(0, time - this.lastT));
    this.lastT = time;
    this.time += dt;
    if (units && (this.buildingScan -= dt) <= 0) {
      this.buildingScan = 0.5;
      this.coverBuildings(units);
    }
    if (dt > 0) this.animate(dt);
    if (!cam) return;
    const oc = cam as THREE.OrthographicCamera;
    const span = oc.isOrthographicCamera ? (oc.top - oc.bottom) / oc.zoom : cam.position.y * 0.9;
    if (Math.abs(span - this.span) > 0.3 || this.lod < 0) this.span = span;
    const lod = this.span > LO_SPAN + (this.lod === 1 ? -1 : 1) ? 1 : 0;
    // shadows: high = flagged props while not zoomed far out; medium = the big ones, zoomed in only
    const shadow = this.quality === 'high' ? this.span < 26 : this.span < 12.6;
    if (lod !== this.lod || shadow !== this.shadowOn) {
      this.lod = lod;
      this.shadowOn = shadow;
      for (const k of this.kinds) {
        const g = lod ? k.lo : k.hi;
        if (k.ci.mesh.geometry !== g) k.ci.mesh.geometry = g;
        k.ci.mesh.castShadow = shadow && k.info.shadow && (this.quality === 'high' || k.big) && lod === 0;
      }
    }
    this.cull(cam);
    for (const k of this.kinds) k.ci.mesh.visible = k.ci.mesh.count > 0 && this.span <= k.hideSpan;
  }

  private cull(cam: THREE.Camera) {
    cam.updateMatrixWorld();
    const poly: number[] = [];
    for (const [x, y] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      _v0.set(x, y, -1).unproject(cam);
      _v1.set(x, y, 1).unproject(cam);
      _ray.set(_v0, _v1.sub(_v0).normalize());
      const dy = _ray.direction.y;
      const t = Math.abs(dy) > 1e-4 ? (0.3 - _ray.origin.y) / dy : 0;
      _ray.at(Math.max(0, Math.min(1e4, t)), _v0);
      poly.push(_v0.x, _v0.z);
    }
    const key = poly.map((v) => Math.round(v / 1.5)).join(',');
    let ver = 0;
    for (const k of this.kinds) ver += k.ci.version;
    if (key === this.camKey && ver === this.versions) return;
    this.camKey = key;
    this.versions = ver;
    for (const k of this.kinds) k.ci.cull(poly, 3);
  }

  // ------------------------------------------------------------ destruction

  private query(x: number, z: number, r: number): number {
    let n = 0;
    const W = this.map.w;
    const x0 = Math.max(0, Math.floor(x - r));
    const x1 = Math.min(W - 1, Math.floor(x + r));
    const z0 = Math.max(0, Math.floor(z - r));
    const z1 = Math.min(this.map.h - 1, Math.floor(z + r));
    for (let cz = z0; cz <= z1; cz++)
      for (let cx = x0; cx <= x1; cx++) {
        const c = cz * W + cx;
        for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
          const i = this.cellItems[k];
          if (this.state[i] >= State.Fading) continue;
          const kk = this.kinds[this.kindOf[i]];
          const rr = r + Math.max(kk.info.footprint[0], kk.info.footprint[1]) * 0.5;
          if ((this.ix[i] - x) ** 2 + (this.iz[i] - z) ** 2 <= rr * rr && n < this.qi.length) this.qi[n++] = i;
        }
      }
    return n;
  }

  private matrixOf(i: number, out: THREE.Matrix4) {
    return this.kinds[this.kindOf[i]].ci.getMatrix(this.idx[i], out);
  }

  private setMatrix(i: number, m: THREE.Matrix4) {
    this.kinds[this.kindOf[i]].ci.setMatrix(this.idx[i], m);
  }

  private char(i: number, k = 0.3) {
    this.kinds[this.kindOf[i]].ci.tint(this.idx[i], k, k * 0.92, k * 0.85);
  }

  /** A moving vehicle at (x, z), footprint radius r, heading (fx, fz): it flattens / shoves what it runs over. */
  crush(x: number, z: number, r: number, fx: number, fz: number, heavy: boolean) {
    if (!this.ready) return;
    const n = this.query(x, z, r * 0.85);
    for (let q = 0; q < n; q++) {
      const i = this.qi[q];
      if (this.state[i] !== State.Standing) continue;
      const k = this.kinds[this.kindOf[i]];
      if (!k.info.destructible) continue;
      const kind = k.info.kind;
      const base = this.matrixOf(i, new THREE.Matrix4());
      base.decompose(_p, _q, _s);
      const gy = this.ground(_p.x, _p.z);
      // which side of the vehicle it was on
      const side = (this.ix[i] - x) * -fz + (this.iz[i] - z) * fx >= 0 ? 1 : -1;
      if (kind === 'tall' || (kind === 'big' && !heavy && k.id !== 'sandbags')) {
        // shoved over / pushed aside
        this.launch(i, fx * 1.2 + -fz * side * 0.8, 0.6, fz * 1.2 + fx * side * 0.8, false, 0.35);
        continue;
      }
      // flattened: squash, lean, darken a little; crushed scrap lingers a while, then sinks away
      const flat = kind === 'big' ? (k.id === 'car_covered' ? 0.5 : 0.42) : 0.22;
      _e.set((Math.random() - 0.5) * 0.25, 0, (Math.random() - 0.5) * 0.25);
      _q2.setFromEuler(_e);
      _q.premultiply(_q2);
      _s.y *= flat;
      _s.x *= 1.12;
      _s.z *= 1.12;
      _p.y = Math.min(_p.y, gy - 0.004);
      _p.x += -fz * side * 0.05;
      _p.z += fx * side * 0.05;
      this.setMatrix(i, _m.compose(_p, _q, _s));
      this.char(i, 0.78);
      this.state[i] = State.Down;
      this.fadeAt[i] = this.time + 45 + Math.random() * 40;
      if (kind === 'big' && Math.random() < 0.6) this.effects?.dust(_p.x, gy + 0.05, _p.z, 0.8);
    }
  }

  /** A ground blast of profile size `size` at (x, z). */
  blast(x: number, z: number, size: number) {
    if (!this.ready || size < 0.4) return;
    const reach = 0.3 + size * 0.75;
    const n = this.query(x, z, reach);
    let booms = 0;
    for (let q = 0; q < n; q++) {
      const i = this.qi[q];
      if (this.state[i] === State.Fading || this.state[i] === State.Gone) continue;
      const k = this.kinds[this.kindOf[i]];
      let dx = this.ix[i] - x;
      let dz = this.iz[i] - z;
      const d = Math.hypot(dx, dz);
      if (d < 1e-3) {
        dx = Math.random() - 0.5;
        dz = Math.random() - 0.5;
      }
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      const f = Math.max(0, 1 - d / reach);
      const burn = size >= 0.85 && f > 0.35 && /drum|car|crate|pallet|wood|jerry|propane|bag|bench|generator|barrel|tyre/.test(k.id);
      if (!k.info.destructible) {
        if (burn) this.char(i, 0.45);
        continue;
      }
      // flammable bits char; the red drums and gas bottles may go up
      if (burn) this.char(i, 0.35);
      if ((k.id === 'drum_red' || k.id === 'propane' || k.id === 'jerrycan') && f > 0.4 && booms < 2 && Math.random() < 0.55) {
        booms++;
        const px = this.ix[i];
        const pz = this.iz[i];
        const gy = this.ground(px, pz);
        this.effects?.after(0.15 + Math.random() * 0.4, () => {
          this.effects?.explosion(px, gy + 0.1, pz, 'small', 'fire');
          this.effects?.scorch(px, gy, pz, 0.45);
        });
      }
      const heavy = k.info.kind !== 'small';
      const mass = heavy ? (k.id === 'car_covered' || k.id === 'dumpster' || k.id === 'block' || k.id === 'barrier' ? 0.25 : 0.55) : 1;
      if (f * size * mass < 0.12) continue;
      const pw = (0.6 + f * size * 1.6) * mass;
      this.launch(i, dx * pw, (0.8 + f * size * 2.2) * mass, dz * pw, burn, heavy ? 0.45 : 1);
    }
  }

  /** Throw item i (velocity in world units / s); `spinK` scales the tumble. */
  private launch(i: number, vx: number, vy: number, vz: number, burn: boolean, spinK: number) {
    if (this.state[i] === State.Moving) return;
    const base = this.matrixOf(i, new THREE.Matrix4());
    base.decompose(_p, _q, _s);
    const k = this.kinds[this.kindOf[i]];
    // where it ends up: on its side (long props topple across their short axis)
    const restQ = _q.clone();
    const tip = k.info.size[1] > k.info.footprint[1] * 0.9 || k.info.kind === 'tall';
    _ax.set(vz, 0, -vx).normalize();
    if (_ax.lengthSq() < 1e-6) _ax.set(1, 0, 0);
    const restY = tip ? Math.min(k.info.footprint[0], k.info.footprint[1]) * 0.5 : 0;
    if (tip) restQ.premultiply(_q2.setFromAxisAngle(_ax, Math.PI / 2));
    else restQ.premultiply(_q2.setFromAxisAngle(_ax, (Math.random() - 0.5) * 0.4));
    this.state[i] = State.Moving;
    this.movers.push({
      item: i,
      t: 0,
      life: 0,
      p: _p.clone(),
      v: new THREE.Vector3(vx, vy, vz),
      q: _q.clone(),
      spin: new THREE.Vector3(vz, 0, -vx).multiplyScalar(4 * spinK).add(new THREE.Vector3((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 3).multiplyScalar(spinK)),
      rest: restQ,
      restY,
      burn,
    });
    // scale kept in the item's matrix (crushed items stay squashed)
    this.moverScale.set(i, _s.clone());
  }
  private moverScale = new Map<number, THREE.Vector3>();

  private ground(x: number, z: number) {
    return surfaceHeight(this.map, Math.max(0, Math.min(this.map.w - 0.01, x)), Math.max(0, Math.min(this.map.h - 0.01, z)));
  }

  private animate(dt: number) {
    // flying / tumbling
    for (let k = this.movers.length - 1; k >= 0; k--) {
      const M = this.movers[k];
      M.t += dt;
      const gy = this.ground(M.p.x, M.p.z);
      let landed = false;
      if (M.life === 0) {
        M.v.y -= 9 * dt;
        M.p.addScaledVector(M.v, dt);
        _q2.setFromEuler(_e.set(M.spin.x * dt, M.spin.y * dt, M.spin.z * dt));
        M.q.premultiply(_q2);
        if (M.p.y <= gy + M.restY && M.v.y < 0) {
          M.p.y = gy + M.restY;
          M.life = M.t;
          if (Math.random() < 0.5) this.effects?.dust(M.p.x, gy + 0.03, M.p.z, 0.5);
        }
      } else {
        // settle into the rest pose
        const s = Math.min(1, (M.t - M.life) / 0.25);
        M.q.slerp(M.rest, s);
        M.p.y = gy + M.restY;
        landed = s >= 1;
      }
      this.setMatrix(M.item, _m.compose(M.p, M.q, this.moverScale.get(M.item) ?? _s.set(1, 1, 1)));
      if (landed) {
        const i = M.item;
        this.ix[i] = M.p.x;
        this.iz[i] = M.p.z;
        this.state[i] = State.Down;
        this.fadeAt[i] = this.time + 25 + Math.random() * 25;
        if (M.burn && this.effects) {
          const life = 6 + Math.random() * 8;
          this.fires.push({ x: M.p.x, y: gy + 0.08, z: M.p.z, t: life });
        }
        this.moverScale.delete(i);
        this.movers.splice(k, 1);
      }
    }
    // fires on burning wreckage
    for (let b = this.fires.length - 1; b >= 0; b--) {
      const F = this.fires[b];
      F.t -= dt;
      if (F.t <= 0) {
        this.fires.splice(b, 1);
        continue;
      }
      if (Math.random() < dt * 4) this.effects?.flame(F.x + (Math.random() - 0.5) * 0.12, F.y, F.z + (Math.random() - 0.5) * 0.12, 0.45);
      if (Math.random() < dt * 1.5) this.effects?.smoke(F.x, F.y + 0.15, F.z, 0.5);
    }
    // wreckage sinks out of sight after a while (checked a few items per frame)
    const n = this.n;
    if (n) {
      const per = Math.min(n, 64);
      for (let s = 0; s < per; s++) {
        const i = (this.sweep = (this.sweep + 1) % n);
        if (this.state[i] === State.Down && this.time >= this.fadeAt[i]) this.fade(i, 3.5);
      }
    }
    for (let f = this.fading.length - 1; f >= 0; f--) {
      const F = this.fading[f];
      F.t += dt;
      const k = Math.min(1, F.t / F.depth);
      F.base.decompose(_p, _q, _s);
      const h = this.kinds[this.kindOf[F.item]].info.size[1] * Math.max(_s.y, 0.3) + 0.03;
      _p.y -= h * k * k;
      if (k >= 1) _s.set(0, 0, 0);
      this.setMatrix(F.item, _m.compose(_p, _q, _s));
      if (k >= 1) {
        this.state[F.item] = State.Gone;
        this.fading.splice(f, 1);
      }
    }
  }
  private sweep = 0;
  private fires: { x: number; y: number; z: number; t: number }[] = [];

  private fade(i: number, secs: number) {
    if (this.state[i] === State.Fading || this.state[i] === State.Gone) return;
    this.state[i] = State.Fading;
    this.fading.push({ item: i, t: 0, base: this.matrixOf(i, new THREE.Matrix4()), depth: secs });
  }

  /** New buildings swallow the props on their footprint. */
  private coverBuildings(units: readonly Entity[]) {
    for (const e of units) {
      if (e.kind !== 'building' || e.dead || this.seenBuildings.has(e.id)) continue;
      this.seenBuildings.add(e.id);
      const d = buildingDef(e.def);
      const x0 = e.tx - 0.15;
      const z0 = e.ty - 0.15;
      const x1 = e.tx + d.w + 0.15;
      const z1 = e.ty + d.h + 0.15;
      const n = this.query((x0 + x1) / 2, (z0 + z1) / 2, Math.hypot(x1 - x0, z1 - z0) / 2);
      for (let q = 0; q < n; q++) {
        const i = this.qi[q];
        if (this.ix[i] > x0 && this.ix[i] < x1 && this.iz[i] > z0 && this.iz[i] < z1 && this.state[i] !== State.Gone) {
          this.state[i] = State.Gone;
          this.setMatrix(i, _m2.makeScale(0, 0, 0));
        }
      }
    }
  }
}

// ------------------------------------------------------------------ helpers

/** Instance transform for a planned spot: on the ground, leaning with the slope (or lying on its side). */
function spotInst(m: GameMap, s: PropSpot, info: PropInfo): Inst {
  const [fx, fz] = info.footprint;
  const ca = Math.cos(s.rot);
  const sa = -Math.sin(s.rot);
  const g = (lx: number, lz: number) => surfaceHeight(m, s.x + lx * ca - lz * sa, s.z + lx * sa + lz * ca);
  const hx = Math.max(0.03, fx / 2);
  const hz = Math.max(0.03, fz / 2);
  const gxp = g(hx, 0);
  const gxn = g(-hx, 0);
  const gzp = g(0, hz);
  const gzn = g(0, -hz);
  const g0 = surfaceHeight(m, s.x, s.z);
  // big rigid props sit on the lowest corner (no floating), small ones lean with the ground
  const lowest = Math.min(g0, gxp, gxn, gzp, gzn);
  const sink = 0.004 + (s.sink ?? 0);
  if (s.lay) {
    // lying on its side: local +y turned to -x (rotation about local z), centred back over the spot
    const r = Math.min(fx, fz) / 2;
    const h = info.height;
    return { x: s.x + (h / 2) * ca, y: lowest + r * 0.92 - sink * 0.5, z: s.z + (h / 2) * sa, rotY: s.rot, sx: 1, sy: 1, sz: 1, tiltZ: Math.PI / 2 };
  }
  const lean = info.kind === 'small' || info.kind === 'fixed';
  return {
    x: s.x,
    y: (lean ? g0 : lowest) - sink,
    z: s.z,
    rotY: s.rot,
    sx: 1,
    sy: 1,
    sz: 1,
    tiltZ: lean ? Math.atan((gxp - gxn) / (2 * hx)) * 0.8 : 0,
    tiltX: lean ? -Math.atan((gzp - gzn) / (2 * hz)) * 0.8 : 0,
  };
}

/** Per-biome instance tint (dust on the desert props, a cold cast in the snow). */
function biomeTint(b: string): [number, number, number] {
  return b === 'desert' ? [1.04, 0.98, 0.88] : b === 'winter' ? [0.94, 0.97, 1.02] : [1, 1, 1];
}

async function texture(url: string, srgb: boolean): Promise<THREE.Texture> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const t = new THREE.Texture(bmp);
  // glTF uv convention (v runs down the image): no flip
  t.flipY = false;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** Float copy of a (quantised) glTF geometry with its node transform baked in. */
function dequantize(src: THREE.BufferGeometry, world: THREE.Matrix4): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const a = src.getAttribute(name);
    if (!a) continue;
    const out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent(i, c);
    g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
  }
  if (src.index) g.setIndex(new THREE.BufferAttribute(src.index.array.slice(), 1));
  g.applyMatrix4(world);
  const n = g.getAttribute('normal');
  if (n) for (let i = 0; i < n.count; i++) _p.fromBufferAttribute(n, i).normalize().toArray(n.array as Float32Array, i * 3);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/** The one material every prop shares (fog of war / weather patched; the winter props stand in the snow). */
function makeMaterial(fog: FogOfWar, map: THREE.Texture, normal: THREE.Texture, orm: THREE.Texture, snowy: boolean): THREE.Material {
  const mat = new THREE.MeshStandardMaterial({
    map,
    normalMap: normal,
    // glTF tangent-space normals with derivative tangents (as GLTFLoader does)
    normalScale: new THREE.Vector2(1, -1),
    aoMap: orm,
    aoMapIntensity: 0.85,
    roughnessMap: orm,
    metalnessMap: orm,
    roughness: 1,
    metalness: 1,
    envMapIntensity: 0.8,
  });
  if (snowy) {
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vPropY;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvPropY = position.y;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vPropY;').replace(
        '#include <emissivemap_fragment>',
        `{
          // drifted snow around the foot of the prop (a noisy snow line)
          float snl = 0.035 + ( texture2D( fogNoise, vFogP.xz * 1.9 ).r - 0.5 ) * 0.05;
          float snk = 1.0 - smoothstep( snl - 0.012, snl + 0.012, vPropY );
          diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.84, 0.88, 0.94 ), snk );
          roughnessFactor = mix( roughnessFactor, 0.6, snk );
          metalnessFactor = mix( metalnessFactor, 0.0, snk );
        }
        #include <emissivemap_fragment>`,
      );
    };
  }
  fog.apply(mat);
  mat.customProgramCacheKey = () => (snowy ? 'fog2-props-snow' : 'fog2-props');
  return mat;
}

/**
 * Snow line for other scenery materials on winter maps (fence posts half
 * buried): surfaces below `h` (model-space height above the mesh origin, ±40%
 * noise) turn to snow. Applies the fog-of-war patch too and returns `mat`.
 */
export function snowLine<T extends THREE.Material>(fog: FogOfWar, mat: T, h: number): T {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev.call(mat, sh, r);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vSnowY;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvSnowY = position.y;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vSnowY;').replace(
      '#include <emissivemap_fragment>',
      `{
        float snl = ${h.toFixed(3)} + ( texture2D( fogNoise, vFogP.xz * 1.9 ).r - 0.5 ) * ${(h * 0.8).toFixed(3)};
        diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.84, 0.88, 0.94 ), 1.0 - smoothstep( snl - 0.01, snl + 0.01, vSnowY ) );
      }
      #include <emissivemap_fragment>`,
    );
  };
  fog.apply(mat);
  // the patched source differs from plain fog-patched materials: keep the programs apart
  mat.customProgramCacheKey = () => `fog2-snowline-${h}`;
  return mat;
}
