// Skirmish maps. Frontline Crossing (map.ts) is the temperate original; this
// module adds three hand-designed, point-symmetric two player maps with their
// own climates - a desert wadi with mesas and oases, a frozen river valley and
// a canal city - and the `createMap` dispatcher the world uses.
//
// Every layout is fixed in code for player 0's half and mirrored through the
// map centre (fair starts). The seed only varies the details (dune and hill
// noise, forest patches, river meanders, which building stands on which city
// lot, palms, ...) through its own Rng, never the world's, so two clients with
// the same seed build bit-identical maps. Generators validate as they go:
// structures that would cut the walkable map are dropped, trees that wall in
// a pocket of land are cleared.

import {
  BRIDGE_HEIGHT,
  ORE_MAX,
  StructureKind,
  Tile,
  WATER_LEVEL,
  createFrontlineMap,
  distToSegment,
  smoothstep,
  type Biome,
  type GameMap,
  type MapDeco,
  type MapId,
  type Point,
  type Structure,
} from './map';
import { Rng, fbm, hash2 } from './rng';

void BRIDGE_HEIGHT;

/** Menu / briefing facts about every map. */
export interface MapInfo {
  id: MapId;
  name: string;
  biome: Biome;
  /** One line for the map picker. */
  blurb: string;
  /** Climate / region line of the briefing. */
  region: string;
}

export const MAPS: MapInfo[] = [
  { id: 'frontline', name: 'Frontline Crossing', biome: 'temperate', blurb: 'River valley, villages, three bridges', region: 'Temperate river valley' },
  { id: 'desert', name: 'Wadi Al-Rimal', biome: 'desert', blurb: 'Dunes, mesas, a dry wadi and oases', region: 'Arid desert basin' },
  { id: 'winter', name: 'Frozen Pass', biome: 'winter', blurb: 'Snowfields, pine forest, an icy river', region: 'Sub-arctic river valley' },
  { id: 'urban', name: 'Canal City', biome: 'urban', blurb: 'Street fighting across a canal city', region: 'Dense urban centre' },
];

export const MAP_IDS: MapId[] = MAPS.map((m) => m.id);

export function isMapId(v: unknown): v is MapId {
  return typeof v === 'string' && (MAP_IDS as string[]).includes(v);
}

export function mapInfo(id: MapId): MapInfo {
  return MAPS.find((m) => m.id === id) ?? MAPS[0];
}

/** Build a map. Frontline Crossing ignores the seed (it is the fixed original). */
export function createMap(id: MapId = 'frontline', seed = 1): GameMap {
  switch (id) {
    case 'desert':
      return createDesertMap(seed);
    case 'winter':
      return createWinterMap(seed);
    case 'urban':
      return createUrbanMap(seed);
    default:
      return createFrontlineMap();
  }
}

// ------------------------------------------------------------------ shared

const W = 96;
const H = 96;
const CX = (W - 1) / 2;
const CY = (H - 1) / 2;

const mirror = (p: Point): Point => ({ x: W - 1 - p.x, y: H - 1 - p.y });
const half = <T extends Point>(arr: T[]): T[] => [...arr, ...arr.map((p) => ({ ...p, ...mirror(p) }))];

interface Field extends Point {
  r: number;
  kind: number;
}
interface Capsule extends Point {
  x2: number;
  y2: number;
  r: number;
}

/** Oil derricks are 2 x 2 from their top-left tile: the mirrored footprint starts one tile further in. */
const halfOils = (arr: Point[]): Point[] => [...arr, ...arr.map((p) => ({ x: W - 2 - p.x, y: H - 2 - p.y }))];

/** Mirror capsules (both end points). */
function halfCapsules(arr: Capsule[]): Capsule[] {
  return [...arr, ...arr.map((c) => ({ x: W - 1 - c.x, y: H - 1 - c.y, x2: W - 1 - c.x2, y2: H - 1 - c.y2, r: c.r }))];
}

/*
 * Coordinates: features live in tile-index space (tile (x, y) is evaluated at (x, y), vertex
 * (vx, vy) at (vx - 0.5, vy - 0.5)), where the mirror is p -> 95 - p, so every test below is
 * exactly point symmetric.
 */
/** Point-symmetric fbm (average of the field and its mirror). */
const symNoise = (x: number, y: number, scale: number, seed: number) => (fbm(x * scale, y * scale, seed) + fbm((W - 1 - x) * scale, (H - 1 - y) * scale, seed)) / 2;
/** Point-symmetric tile hash. */
const symHash = (x: number, y: number, seed: number) => (hash2(x, y, seed) + hash2(W - 1 - x, H - 1 - y, seed)) / 2;

/** River / wadi along the x == y diagonal: offset across it at diagonal coordinate s (odd around the centre: symmetric). */
function riverShape(a1: number, k1: number, a2: number, k2: number) {
  const off = (s: number) => a1 * Math.sin((s - CX) * k1) + a2 * Math.sin((s - CX) * k2);
  return {
    off,
    /** Distance from the centreline (approximate, across the diagonal). */
    dist: (x: number, y: number) => Math.abs((x - y) / Math.SQRT2 - off((x + y) / 2)),
    /** Centreline point at diagonal coordinate s (tile space, + d across). */
    at: (s: number, d = 0): Point => {
      const o = off(s) + d;
      return { x: s + o / Math.SQRT2, y: s - o / Math.SQRT2 };
    },
  };
}

function newGrids() {
  return {
    heights: new Float32Array((W + 1) * (H + 1)),
    tiles: new Uint8Array(W * H),
    trees: new Uint8Array(W * H),
    ore: new Uint8Array(W * H),
    oreKind: new Uint8Array(W * H),
  };
}
type Grids = ReturnType<typeof newGrids>;

/** Roads become dirt tiles in the sim (the renderer paves them). */
function markRoads(g: Grids, roads: Point[][], halfW: number[], over: Tile[]) {
  roads.forEach((road, ri) => {
    const r = halfW[ri] ?? 0.9;
    for (let k = 0; k < road.length - 1; k++) {
      const a = road[k];
      const b = road[k + 1];
      const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - r - 1));
      const x1 = Math.min(W - 1, Math.ceil(Math.max(a.x, b.x) + r + 1));
      const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - r - 1));
      const y1 = Math.min(H - 1, Math.ceil(Math.max(a.y, b.y) + r + 1));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const i = y * W + x;
          if (!over.includes(g.tiles[i] as Tile)) continue;
          if (distToSegment(x + 0.5, y + 0.5, a.x + 0.5, a.y + 0.5, b.x + 0.5, b.y + 0.5) < r) g.tiles[i] = Tile.Dirt;
        }
    }
  });
}

/** Ore / gem fields (same shape rules as Frontline Crossing, symmetric jitter). */
function paintOre(g: Grids, fields: Field[], sandTo: Tile = Tile.Dirt) {
  for (const f of fields) {
    for (let y = Math.floor(f.y - f.r - 1); y <= f.y + f.r + 1; y++) {
      for (let x = Math.floor(f.x - f.r - 1); x <= f.x + f.r + 1; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        const t = g.tiles[i];
        if (t === Tile.Water || t === Tile.Rock || t === Tile.Bridge) continue;
        const d = Math.hypot(x - f.x, y - f.y);
        if (d < f.r + symHash(x, y, 7) * 1.2 - 0.6) {
          g.oreKind[i] = f.kind;
          g.ore[i] = Math.min(ORE_MAX, Math.max(2, Math.round(ORE_MAX * (1 - d / (f.r + 1.5)) + 2)));
          if (t === Tile.Sand) g.tiles[i] = sandTo;
          g.trees[i] = 0;
        }
      }
    }
  }
}

const walkable = (g: Grids, blocked: Uint8Array | null, i: number) => {
  const t = g.tiles[i];
  return t !== Tile.Water && t !== Tile.Rock && !g.trees[i] && !(blocked && blocked[i]);
};

/** Flood fill of walkable tiles from a start; returns the seen mask and the count. */
function flood(g: Grids, blocked: Uint8Array | null, from: Point) {
  const seen = new Uint8Array(W * H);
  const s0 = from.y * W + from.x;
  const q = [s0];
  seen[s0] = 1;
  let n = 0;
  while (q.length) {
    const t = q.pop()!;
    n++;
    const x = t % W;
    const y = (t / W) | 0;
    if (x > 0 && !seen[t - 1] && walkable(g, blocked, t - 1)) (seen[t - 1] = 1), q.push(t - 1);
    if (x < W - 1 && !seen[t + 1] && walkable(g, blocked, t + 1)) (seen[t + 1] = 1), q.push(t + 1);
    if (y > 0 && !seen[t - W] && walkable(g, blocked, t - W)) (seen[t - W] = 1), q.push(t - W);
    if (y < H - 1 && !seen[t + W] && walkable(g, blocked, t + W)) (seen[t + W] = 1), q.push(t + W);
  }
  return { seen, n };
}

/**
 * Trees must never wall in land: while some open (non-tree) land tile can't be reached
 * from player 0's start, clear the trees (symmetrically) that border the reached area.
 */
function unblockTrees(g: Grids, start: Point) {
  // the land that should be reachable: everything connected to the start when trees don't count
  const saved = g.trees.slice();
  g.trees.fill(0);
  const should = flood(g, null, start).seen;
  g.trees.set(saved);
  for (let iter = 0; iter < 64; iter++) {
    const { seen } = flood(g, null, start);
    let stuck = false;
    for (let i = 0; i < W * H && !stuck; i++) if (should[i] && !seen[i] && !g.trees[i]) stuck = true;
    if (!stuck) return;
    // clear the tree tiles next to the reached region that lead into the unreached land
    const clear: number[] = [];
    for (let i = 0; i < W * H; i++) {
      if (!g.trees[i]) continue;
      const x = i % W;
      const y = (i / W) | 0;
      if ((x > 0 && seen[i - 1]) || (x < W - 1 && seen[i + 1]) || (y > 0 && seen[i - W]) || (y < H - 1 && seen[i + W])) {
        // only trees with unreached open land somewhere behind them (a 2 tile look-around)
        let behind = false;
        for (let dy = -2; dy <= 2 && !behind; dy++)
          for (let dx = -2; dx <= 2 && !behind; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const j = yy * W + xx;
            if (should[j] && !seen[j] && !g.trees[j]) behind = true;
          }
        if (behind || iter > 8) clear.push(i);
      }
    }
    if (!clear.length) return;
    for (const i of clear) {
      g.trees[i] = 0;
      g.trees[W * H - 1 - i] = 0; // mirror tile
    }
  }
}

interface PlaceOpts {
  starts: Point[];
  oils: Point[];
  ore: Field[];
  roads: Point[][];
  /** Minimum distance from road centrelines to a footprint tile centre. */
  roadClear: number;
  /** Keep this far from the starts. */
  startClear: number;
  /** Max height difference over a footprint tile. */
  flat: number;
  tilesOk: Tile[];
}

/**
 * Structures from a fixed layout for player 0's half, mirrored for player 1. Each footprint is
 * validated (open flat ground, away from bases, ore, oil and roads, a walkable one tile margin) and a
 * flood fill makes sure it cuts nothing off; failures are skipped.
 */
function placeStructures(g: Grids, layout: Structure[], o: PlaceOpts) {
  const all = [
    ...layout,
    ...layout.map((st) => {
      const p = mirror({ x: st.x + st.w - 1, y: st.y + st.h - 1 });
      return { ...st, x: p.x, y: p.y, rot: (st.rot + 2) % 4 };
    }),
  ];
  const blocked = new Uint8Array(W * H);
  const structures: Structure[] = [];
  const vh = (vx: number, vy: number) => g.heights[vy * (W + 1) + vx];
  const roadDist = (x: number, y: number) => {
    let best = 1e9;
    for (const r of o.roads) for (let k = 0; k < r.length - 1; k++) best = Math.min(best, distToSegment(x, y, r[k].x + 0.5, r[k].y + 0.5, r[k + 1].x + 0.5, r[k + 1].y + 0.5));
    return best;
  };
  const okTile = (x: number, y: number) => {
    if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) return false;
    const i = y * W + x;
    if (!o.tilesOk.includes(g.tiles[i] as Tile) || g.trees[i] || g.ore[i] || blocked[i]) return false;
    if (o.starts.some((s) => Math.hypot(x - s.x, y - s.y) < o.startClear)) return false;
    if (o.oils.some((p) => Math.hypot(x - p.x - 0.5, y - p.y - 0.5) < 4.5)) return false;
    if (o.ore.some((f) => Math.hypot(x - f.x, y - f.y) < f.r + 2.2)) return false;
    if (roadDist(x + 0.5, y + 0.5) < o.roadClear) return false;
    const hs = [vh(x, y), vh(x + 1, y), vh(x, y + 1), vh(x + 1, y + 1)];
    if (Math.max(...hs) - Math.min(...hs) > o.flat) return false;
    return true;
  };
  let reachable = flood(g, blocked, o.starts[0]).n;
  // mirrored pairs go in together so the map stays fair
  const n = layout.length;
  for (let k = 0; k < n; k++) {
    const pair = [all[k], all[k + n]];
    let ok = true;
    for (const st of pair)
      for (let y = st.y - 1; y <= st.y + st.h && ok; y++)
        for (let x = st.x - 1; x <= st.x + st.w && ok; x++) {
          const inside = x >= st.x && y >= st.y && x < st.x + st.w && y < st.y + st.h;
          if (inside ? !okTile(x, y) : x < 0 || y < 0 || x >= W || y >= H || blocked[y * W + x] || !walkable(g, null, y * W + x)) ok = false;
        }
    if (!ok) continue;
    const mark = (v: number) => {
      for (const st of pair) for (let y = st.y; y < st.y + st.h; y++) for (let x = st.x; x < st.x + st.w; x++) blocked[y * W + x] = v;
    };
    mark(1);
    const now = flood(g, blocked, o.starts[0]).n;
    const area = pair.reduce((s, st) => s + st.w * st.h, 0);
    if (now !== reachable - area) {
      mark(0);
      continue;
    }
    reachable = now;
    structures.push(...pair);
  }
  return { structures, blocked };
}

/** Bridge records on a diagonal river (decks run along (1, -1), as in Frontline Crossing). */
function diagonalBridges(river: ReturnType<typeof riverShape>, at: number[], length: number) {
  return at.map((s) => {
    const p = river.at(s);
    return { x: p.x + 0.5, y: p.y + 0.5, angle: -Math.PI / 4, length };
  });
}

function emptyDeco(): MapDeco {
  return { roadStyles: [], tracks: [], plazas: [], parks: [], lots: [], fields: [], power: [], trees: [] };
}

/** Mirror a list of polylines (each reversed so it reads from the other base). */
const mirrorLines = (lines: Point[][]) => lines.map((l) => [...l].reverse().map(mirror));
const mirrorRects = <T extends { x0: number; y0: number; x1: number; y1: number }>(rs: T[]) => [...rs, ...rs.map((r) => ({ ...r, x0: W - r.x1, y0: H - r.y1, x1: W - r.x0, y1: H - r.y0 }))];

function assemble(
  base: { name: string; id: MapId; biome: Biome },
  g: Grids,
  more: Pick<GameMap, 'oreMines' | 'starts' | 'oils' | 'bridges' | 'roads' | 'structures' | 'blocked' | 'techSites' | 'lanes' | 'deco'>,
): GameMap {
  return { ...base, w: W, h: H, tiles: g.tiles, heights: g.heights, trees: g.trees, ore: g.ore, oreKind: g.oreKind, ...more };
}

// ================================================================== desert

/**
 * "Wadi Al-Rimal": open dune country split by a dry wadi that runs corner to
 * corner, with palm-ringed oases on it and a walled oasis town at the centre.
 * Sandstone mesas (impassable, high) funnel the approaches into a few passes;
 * there are no bridges - the wadi is crossed anywhere, but its oases and the
 * mesas make the centre ring road and the two outer passes the lanes.
 */
export function createDesertMap(seed: number): GameMap {
  const rng = new Rng((seed ^ 0x51a7d00d) >>> 0);
  const NS = 4000 + rng.int(4000);
  const g = newGrids();
  const starts: Point[] = [
    { x: 14, y: 81 },
    { x: W - 1 - 14, y: H - 1 - 81 },
  ];
  const wadi = riverShape(4.6 + rng.range(-0.8, 0.8), 0.1 + rng.range(-0.012, 0.012), 1.4 + rng.range(-0.4, 0.4), 0.29);
  // oases: the centre (on the wadi, so on the axis of symmetry) and a mirrored pair up / down the wadi
  const oS = 24 + rng.int(4);
  const oasisSide = wadi.at(CX - oS);
  const oases = [{ x: CX, y: CY, r: 3.1 }, ...half([{ x: oasisSide.x, y: oasisSide.y, r: 2.1 + rng.range(0, 0.3) }])];
  const mesas = halfCapsules([
    { x: 27, y: 60, x2: 33, y2: 65, r: 2.5 + rng.range(-0.2, 0.3) },
    { x: 43, y: 80, x2: 47, y2: 85, r: 2.3 + rng.range(-0.2, 0.2) },
    { x: 9, y: 41, x2: 16, y2: 36, r: 2.7 + rng.range(-0.2, 0.3) },
    { x: 62, y: 90, x2: 68, y2: 89, r: 2.1 },
    { x: 24, y: 22, x2: 27, y2: 16, r: 2.2 + rng.range(-0.2, 0.2) },
  ]);
  const oreFields: Field[] = half([
    { x: 26, y: 88, r: 3.6, kind: 1 },
    { x: 6, y: 64, r: 3.2, kind: 1 },
    { x: 39, y: 71, r: 3.0, kind: 1 },
    { x: 18, y: 48, r: 2.6, kind: 2 },
    { x: 55, y: 85, r: 2.5, kind: 2 },
  ]);
  const oils = halfOils([
    { x: 35, y: 87 },
    { x: 4, y: 52 },
    { x: 30, y: 41 },
  ]);
  // roads: highway from each base to the oasis town's ring road, the ring itself, an outer desert road
  const ringR = 7.6;
  const ring = (a0: number, a1: number) => Array.from({ length: 9 }, (_, i) => {
    const a = ((a0 + ((a1 - a0) * i) / 8) * Math.PI) / 180;
    return { x: CX + Math.cos(a) * ringR, y: CY + Math.sin(a) * ringR };
  });
  const r0 = [
    [starts[0], { x: 24, y: 77 }, { x: 35, y: 74 }, { x: 40, y: 62 }, ring(135, 135)[0]],
    ring(45, 225),
    [starts[0], { x: 33, y: 91 }, { x: 50, y: 88 }, { x: 58, y: 81 }, { x: 66, y: 73 }, { x: 72, y: 64 }],
  ];
  const roads = [...r0, ...mirrorLines(r0)];
  const tracks0 = [
    [starts[0], { x: 9, y: 70 }, { x: 8, y: 57 }, { x: 13, y: 47 }, { x: 22, y: 41 }, { x: 30, y: 40 }],
    [{ x: 40, y: 62 }, { x: 30, y: 54 }, { x: 25, y: 47 }],
  ];

  const lowGround = (x: number, y: number) => {
    // long transverse dunes: an even function of the offset from the centre (point symmetric) with a symmetric warp
    const u = (x - CX) * 0.29 + (y - CY) * 0.13;
    const warp = (fbm(x * 0.06, y * 0.06, NS + 3) - fbm((W - 1 - x) * 0.06, (H - 1 - y) * 0.06, NS + 3)) * 3.2;
    const dune = Math.pow(0.5 + 0.5 * Math.cos(u * 2.1 + warp), 1.6);
    return 0.42 + (symNoise(x, y, 0.045, NS) - 0.5) * 1.5 + dune * 0.42;
  };
  for (let vy = 0; vy <= H; vy++)
    for (let vx = 0; vx <= W; vx++) {
      const fx = vx - 0.5;
      const fy = vy - 0.5;
      let h = lowGround(fx, fy);
      for (const s of starts) h = h + (0.45 - h) * (1 - smoothstep(9, 15, Math.hypot(fx - s.x, fy - s.y)));
      // roads run on graded ground
      // the wadi: a broad shallow bed with low banks
      const wd = wadi.dist(fx, fy);
      h = h + (-0.06 - h) * (1 - smoothstep(2.2, 5.0, wd));
      for (const o of oases) {
        const d = Math.hypot(fx - o.x, fy - o.y);
        h = h + (-0.95 - h) * (1 - smoothstep(o.r - 0.6, o.r + 1.6, d));
      }
      for (const m of mesas) {
        const d = distToSegment(vx, vy, m.x + 0.5, m.y + 0.5, m.x2 + 0.5, m.y2 + 0.5);
        const top = 2.25 + ((hash2(vx, vy, NS + 9) + hash2(W - vx, H - vy, NS + 9)) / 2 - 0.5) * 0.12;
        // a flat-topped plateau with steep sandstone cliffs
        h = h + (top - h) * (1 - smoothstep(m.r - 0.45, m.r + 0.65, d));
      }
      g.heights[vy * (W + 1) + vx] = h;
    }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const fx = x + 0.5;
      const fy = y + 0.5;
      let t: Tile = Tile.Sand;
      if (symNoise(x, y, 0.07, NS + 5) > 0.57) t = Tile.Dirt; // gravel plains
      const wd = wadi.dist(x, y);
      if (wd < 2.4) t = Tile.Dirt; // the wadi floor: gravel and cracked mud
      else if (wd < 4.6 && symNoise(x, y, 0.2, NS + 6) > 0.48) t = Tile.Grass; // scrub on its banks
      for (const o of oases) {
        const d = Math.hypot(x - o.x, y - o.y);
        if (d < o.r) t = Tile.Water;
        else if (d < o.r + 2.4 && t !== Tile.Water) t = Tile.Grass;
      }
      for (const m of mesas) if (distToSegment(fx, fy, m.x + 0.5, m.y + 0.5, m.x2 + 0.5, m.y2 + 0.5) < m.r + 0.1) t = Tile.Rock;
      g.tiles[i] = t;
    }
  markRoads(g, roads, roads.map((_, i) => (i % 3 === 2 ? 0.8 : 0.95)), [Tile.Sand, Tile.Dirt, Tile.Grass]);
  paintOre(g, oreFields);

  const reserved = (x: number, y: number) =>
    starts.some((s) => Math.hypot(x - s.x, y - s.y) < 10) ||
    oils.some((o) => Math.abs(x - o.x - 0.5) < 3 && Math.abs(y - o.y - 0.5) < 3) ||
    oreFields.some((f) => Math.hypot(x - f.x, y - f.y) < f.r + 2.5) ||
    roads.some((r) => r.some((p, k) => k > 0 && distToSegment(x + 0.5, y + 0.5, r[k - 1].x + 0.5, r[k - 1].y + 0.5, p.x + 0.5, p.y + 0.5) < 1.8));
  // date palms ring the oases and dot the wadi; acacias stand alone on the scrub and gravel
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const t = g.tiles[i];
      if ((t !== Tile.Grass && t !== Tile.Dirt && t !== Tile.Sand) || reserved(x, y) || g.ore[i]) continue;
      let palm = 0;
      for (const o of oases) {
        const d = Math.hypot(x - o.x, y - o.y);
        if (d > o.r + 0.4 && d < o.r + 3.2) palm = Math.max(palm, 0.55 - (d - o.r) * 0.1);
      }
      const wd = wadi.dist(x, y);
      if (wd > 2.0 && wd < 4.2) palm = Math.max(palm, 0.07);
      const h = symHash(x, y, NS + 11);
      if (h < palm) g.trees[i] = 2;
      else if ((t === Tile.Grass || t === Tile.Dirt) && h > 0.982) g.trees[i] = 1;
    }
  unblockTrees(g, starts[0]);

  const layout: Structure[] = [
    // oasis town on player 0's side of the ring road
    { kind: StructureKind.MudHouse, x: 35, y: 51, w: 2, h: 2, rot: 1 },
    { kind: StructureKind.Courtyard, x: 36, y: 55, w: 3, h: 2, rot: 1 },
    { kind: StructureKind.MudHouse, x: 40, y: 58, w: 2, h: 2, rot: 0 },
    { kind: StructureKind.Courtyard, x: 44, y: 59, w: 3, h: 2, rot: 2 },
    { kind: StructureKind.MudHouse, x: 49, y: 59, w: 2, h: 2, rot: 2 },
    { kind: StructureKind.MudHouse, x: 34, y: 46, w: 2, h: 2, rot: 1 },
    { kind: StructureKind.Tower, x: 39, y: 54, w: 1, h: 1, rot: 0 },
    { kind: StructureKind.WaterTower, x: 33, y: 50, w: 1, h: 1, rot: 0 },
    // roadside hamlet in the south
    { kind: StructureKind.MudHouse, x: 54, y: 76, w: 2, h: 2, rot: 3 },
    { kind: StructureKind.Courtyard, x: 58, y: 75, w: 3, h: 2, rot: 2 },
    { kind: StructureKind.MudHouse, x: 61, y: 79, w: 2, h: 2, rot: 3 },
    // caravan stop on the western track
    { kind: StructureKind.MudHouse, x: 12, y: 55, w: 2, h: 2, rot: 1 },
    { kind: StructureKind.Courtyard, x: 13, y: 59, w: 3, h: 2, rot: 1 },
  ];
  const { structures, blocked } = placeStructures(g, layout, { starts, oils, ore: oreFields, roads, roadClear: 1.7, startClear: 15, flat: 0.45, tilesOk: [Tile.Grass, Tile.Dirt, Tile.Sand] });
  for (const st of structures) st.variant = symHash(Math.min(st.x, W - 1 - st.x), Math.min(st.y, H - 1 - st.y), NS + 21);

  const deco = emptyDeco();
  deco.roadStyles = roads.map((_, i) => (i % 3 === 0 ? { width: 1.05, variant: 0 as const } : i % 3 === 1 ? { width: 0.95, variant: 1 as const } : { width: 0.8, variant: 1 as const }));
  deco.tracks = [...tracks0, ...mirrorLines(tracks0)];
  // irrigated plots by the oases
  deco.fields = mirrorRects([
    { x0: oasisSide.x - 7.5, y0: oasisSide.y + 2.5, x1: oasisSide.x - 2.5, y1: oasisSide.y + 6, rows: 0 },
    { x0: 26.5, y0: 61.5 - 9, x1: 31.5, y1: 57 - 2, rows: 1 },
  ]);
  deco.power = [
    [
      { x: 2, y: 58 },
      { x: 30, y: 30 },
      { x: 60, y: 2 },
    ],
  ];
  deco.power.push(...mirrorLines(deco.power));
  // palms along the ring road (render only)
  for (let k = 0; k < 18; k++) {
    const a = (k / 18) * Math.PI * 2 + 0.17;
    deco.trees.push({ x: CX + 0.5 + Math.cos(a) * (ringR + 1.55), y: CY + 0.5 + Math.sin(a) * (ringR + 1.55), kind: 2 });
  }

  return assemble({ name: 'Wadi Al-Rimal', id: 'desert', biome: 'desert' }, g, {
    oreMines: oreFields.map((f) => ({ x: Math.round(f.x), y: Math.round(f.y) })),
    starts,
    oils,
    bridges: [],
    roads,
    structures,
    blocked,
    techSites: [
      { def: 'tech_hospital', at: [[30, 50], [22, 58], [18, 62], [26, 52], [16, 34]] },
      { def: 'tech_comms', at: [[50, 92], [40, 90], [20, 92], [8, 30], [52, 68]] },
      { def: 'tech_airport', at: [[4, 30], [6, 24], [4, 18], [12, 28], [16, 26]] },
    ],
    lanes: [ring(225, 225)[0], ring(45, 45)[0], wadi.at(CX - 26), wadi.at(CX + 26)],
    deco,
  });
}

// ================================================================== winter

/**
 * "Frozen Pass": snowbound hills and spruce forest either side of a half
 * frozen river. Two bridges and, between them, an ice ford the armour can
 * cross; log-built villages and farmsteads along snow-dusted roads.
 */
export function createWinterMap(seed: number): GameMap {
  const rng = new Rng((seed ^ 0x0ce0ffee) >>> 0);
  const NS = 6000 + rng.int(4000);
  const g = newGrids();
  const starts: Point[] = [
    { x: 16, y: 79 },
    { x: W - 1 - 16, y: H - 1 - 79 },
  ];
  const river = riverShape(3.8 + rng.range(-0.6, 0.6), 0.12 + rng.range(-0.01, 0.01), 1.5 + rng.range(-0.4, 0.4), 0.33);
  const bridgeS = [CX - 21, CX + 21];
  const fordS = CX;
  const ridges = halfCapsules([
    { x: 26, y: 64, x2: 31, y2: 69, r: 1.15 },
    { x: 46, y: 70, x2: 51, y2: 66, r: 1.1 },
    { x: 11, y: 52, x2: 15, y2: 47, r: 1.15 },
    { x: 60, y: 86, x2: 66, y2: 84, r: 1.0 },
  ]);
  const oreFields: Field[] = half([
    { x: 28, y: 87, r: 3.6, kind: 1 },
    { x: 7, y: 65, r: 3.2, kind: 1 },
    { x: 34, y: 59, r: 3.0, kind: 1 },
    { x: 20, y: 40, r: 2.6, kind: 2 },
    { x: 52, y: 90, r: 2.6, kind: 2 },
  ]);
  const oils = halfOils([
    { x: 40, y: 78 },
    { x: 5, y: 47 },
  ]);
  const bridgeEnd = (s: number, side: number) => river.at(s, side * 5.2);
  const fordEnd = (side: number) => river.at(fordS, side * 5.4);
  const r0 = [
    [starts[0], { x: 24, y: 74 }, { x: 31, y: 62 }, { x: 38, y: 58 }, fordEnd(1)],
    [starts[0], { x: 30, y: 83 }, { x: 46, y: 80 }, { x: 56, y: 76 }, bridgeEnd(CX + 21, 1)],
    [starts[0], { x: 13, y: 62 }, { x: 18, y: 46 }, bridgeEnd(CX - 21, 1)],
  ];
  const roads = [...r0, ...mirrorLines(r0)];
  const tracks0 = [
    [{ x: 13, y: 62 }, { x: 22, y: 57 }, { x: 30, y: 55 }],
    [{ x: 46, y: 80 }, { x: 50, y: 86 }, { x: 58, y: 90 }, { x: 68, y: 92 }],
  ];

  for (let vy = 0; vy <= H; vy++)
    for (let vx = 0; vx <= W; vx++) {
      const fx = vx - 0.5;
      const fy = vy - 0.5;
      let h = (symNoise(fx, fy, 0.05, NS) - 0.5) * 3.0 + 0.55;
      for (const s of starts) h = h + (0.5 - h) * (1 - smoothstep(9, 15, Math.hypot(fx - s.x, fy - s.y)));
      const rd = river.dist(fx, fy);
      h = h + (-0.9 - h) * (1 - smoothstep(1.6, 3.6, rd));
      // the ice ford: a shallow, frozen-over shoal between the bridges
      const fs = Math.abs((fx + fy) / 2 - fordS);
      const fk = (1 - smoothstep(1.4, 2.4, fs)) * (1 - smoothstep(3.6, 5.0, rd));
      h = h + (-0.17 - h) * fk;
      for (const r of ridges) {
        const d = distToSegment(fx, fy, r.x, r.y, r.x2, r.y2);
        h += 1.5 * (1 - smoothstep(0.6, 2.4, d)) * (0.85 + 0.3 * (hash2(vx, vy, 99) + hash2(W - vx, H - vy, 99)) / 2);
      }
      g.heights[vy * (W + 1) + vx] = h;
    }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const rd = river.dist(x, y);
      const s = (x + y) / 2;
      let t: Tile = Tile.Grass;
      if (rd < 2.3) {
        t = Tile.Water;
        for (const bs of bridgeS) if (Math.abs(s - bs) <= 1.0) t = Tile.Bridge;
        if (Math.abs(s - fordS) <= 1.0) t = Tile.Sand; // ice
      } else if (rd < 3.4) t = Tile.Sand;
      else if (symNoise(x, y, 0.09, NS + 5) > 0.62) t = Tile.Dirt;
      for (const r of ridges) if (distToSegment(x, y, r.x, r.y, r.x2, r.y2) < 1.15) t = Tile.Rock;
      g.tiles[i] = t;
    }
  markRoads(g, roads, roads.map(() => 0.9), [Tile.Grass, Tile.Dirt, Tile.Sand]);
  paintOre(g, oreFields);

  const reserved = (x: number, y: number) =>
    starts.some((s) => Math.hypot(x - s.x, y - s.y) < 10) ||
    oils.some((o) => Math.abs(x - o.x - 0.5) < 3 && Math.abs(y - o.y - 0.5) < 3) ||
    oreFields.some((f) => Math.hypot(x - f.x, y - f.y) < f.r + 2.5) ||
    Math.abs((x + y) / 2 - fordS) < 4.5;
  // spruce / pine forests (1), birch groves near the river (2), single trees
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (g.tiles[i] !== Tile.Grass || reserved(x, y)) continue;
      const rd = river.dist(x, y);
      if (rd < 4.5) continue;
      const n = symNoise(x, y, 0.075, NS + 31);
      const single = symHash(x, y, NS + 3);
      const birch = rd < 9 && symNoise(x, y, 0.12, NS + 37) > 0.55;
      if (n > 0.625 || single > 0.94) g.trees[i] = birch ? 2 : 1;
      else if (birch && single > 0.8) g.trees[i] = 2;
    }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const e = Math.min(x, y, W - 1 - x, H - 1 - y);
      if (e < 2 && g.tiles[i] === Tile.Grass && !reserved(x, y) && symHash(x, y, 5) < 0.6) g.trees[i] = 1;
    }
  unblockTrees(g, starts[0]);

  const layout: Structure[] = [
    // riverside village by the ford road
    { kind: StructureKind.House, x: 30, y: 49, w: 2, h: 2, rot: 2 },
    { kind: StructureKind.Cottage, x: 33, y: 49, w: 2, h: 2, rot: 2 },
    { kind: StructureKind.House, x: 27, y: 52, w: 2, h: 2, rot: 1 },
    { kind: StructureKind.Cottage, x: 33, y: 53, w: 2, h: 2, rot: 0 },
    { kind: StructureKind.Tower, x: 37, y: 52, w: 1, h: 1, rot: 0 },
    // farmstead in the south
    { kind: StructureKind.House, x: 59, y: 79, w: 2, h: 2, rot: 3 },
    { kind: StructureKind.Barn, x: 62, y: 79, w: 3, h: 2, rot: 0 },
    { kind: StructureKind.Silo, x: 66, y: 79, w: 1, h: 1, rot: 0 },
    // forester's hamlet on the western road
    { kind: StructureKind.Cottage, x: 15, y: 55, w: 2, h: 2, rot: 1 },
    { kind: StructureKind.House, x: 19, y: 53, w: 2, h: 2, rot: 1 },
    { kind: StructureKind.Barn, x: 20, y: 57, w: 3, h: 2, rot: 2 },
    { kind: StructureKind.WaterTower, x: 24, y: 55, w: 1, h: 1, rot: 0 },
  ];
  const { structures, blocked } = placeStructures(g, layout, { starts, oils, ore: oreFields, roads, roadClear: 1.6, startClear: 16, flat: 0.4, tilesOk: [Tile.Grass, Tile.Dirt] });
  for (const st of structures) st.variant = symHash(Math.min(st.x, W - 1 - st.x), Math.min(st.y, H - 1 - st.y), NS + 21);

  const deco = emptyDeco();
  deco.roadStyles = roads.map((_, i) => (i % 3 === 0 ? { width: 1.05, variant: 0 as const } : { width: 0.85, variant: 1 as const }));
  deco.tracks = [...tracks0, ...mirrorLines(tracks0)];
  deco.fields = mirrorRects([
    { x0: 4, y0: 26, x1: 12, y1: 40, rows: 1 },
    { x0: 40, y0: 84, x1: 50, y1: 92, rows: 0 },
    { x0: 20, y0: 60, x1: 27, y1: 66, rows: 0 },
  ]);
  deco.power = [
    [
      { x: 1, y: 63 },
      { x: 63, y: 1 },
    ],
  ];
  deco.power.push(...mirrorLines(deco.power));

  return assemble({ name: 'Frozen Pass', id: 'winter', biome: 'winter' }, g, {
    oreMines: oreFields.map((f) => ({ x: Math.round(f.x), y: Math.round(f.y) })),
    starts,
    oils,
    bridges: diagonalBridges(river, bridgeS, 7.5),
    roads,
    structures,
    blocked,
    techSites: [
      { def: 'tech_hospital', at: [[22, 66], [14, 40], [18, 60], [26, 46], [10, 44]] },
      { def: 'tech_comms', at: [[56, 88], [38, 84], [22, 90], [44, 88], [50, 68]] },
      { def: 'tech_airport', at: [[6, 30], [8, 24], [4, 36], [10, 34], [12, 28]] },
    ],
    lanes: [river.at(fordS)],
    deco,
  });
}

// ================================================================== urban

/** City block templates (local tile coords inside a 9 x 9 block between streets). */
const BLOCKS: { kind: StructureKind; x: number; y: number; w: number; h: number; rot: number }[][] = [
  // perimeter block: corner apartments, shops and a tenement, open courtyard
  [
    { kind: StructureKind.Apartment, x: 0, y: 0, w: 3, h: 3, rot: 2 },
    { kind: StructureKind.Shop, x: 4, y: 0, w: 2, h: 2, rot: 2 },
    { kind: StructureKind.Townhouse, x: 7, y: 0, w: 2, h: 2, rot: 1 },
    { kind: StructureKind.Block, x: 0, y: 6, w: 3, h: 2, rot: 0 },
    { kind: StructureKind.Apartment, x: 6, y: 5, w: 3, h: 3, rot: 0 },
  ],
  // dense block: a ring of townhouses and shops around a slab
  [
    { kind: StructureKind.Block, x: 0, y: 0, w: 3, h: 2, rot: 2 },
    { kind: StructureKind.Townhouse, x: 4, y: 0, w: 2, h: 2, rot: 2 },
    { kind: StructureKind.Shop, x: 7, y: 0, w: 2, h: 2, rot: 1 },
    { kind: StructureKind.Townhouse, x: 0, y: 4, w: 2, h: 2, rot: 3 },
    { kind: StructureKind.Apartment, x: 4, y: 4, w: 3, h: 3, rot: 0 },
    { kind: StructureKind.Shop, x: 0, y: 7, w: 2, h: 2, rot: 0 },
  ],
  // office corner
  [
    { kind: StructureKind.Office, x: 0, y: 0, w: 3, h: 3, rot: 2 },
    { kind: StructureKind.Townhouse, x: 7, y: 0, w: 2, h: 2, rot: 2 },
    { kind: StructureKind.Shop, x: 0, y: 6, w: 2, h: 2, rot: 3 },
    { kind: StructureKind.Block, x: 5, y: 6, w: 3, h: 2, rot: 0 },
  ],
  // row of townhouses and a slab
  [
    { kind: StructureKind.Townhouse, x: 0, y: 0, w: 2, h: 2, rot: 2 },
    { kind: StructureKind.Townhouse, x: 3, y: 0, w: 2, h: 2, rot: 2 },
    { kind: StructureKind.Block, x: 0, y: 6, w: 3, h: 2, rot: 0 },
    { kind: StructureKind.Office, x: 6, y: 5, w: 3, h: 3, rot: 0 },
  ],
];

/**
 * "Canal City": a dense town on a street grid, split corner to corner by a
 * walled canal with four bridges. Wide avenues are the lanes; each base sits
 * on an open plaza. Apartment blocks, offices, shops and townhouses can all
 * be garrisoned; parks, squares and rubble lots break up the blocks.
 */
export function createUrbanMap(seed: number): GameMap {
  const rng = new Rng((seed ^ 0x0c17ab1e) >>> 0);
  const NS = 8000 + rng.int(4000);
  const g = newGrids();
  const starts: Point[] = [
    { x: 14, y: 81 },
    { x: W - 1 - 14, y: H - 1 - 81 },
  ];
  const canal = riverShape(2.2 + rng.range(-0.5, 0.5), 0.07, 0.6, 0.21);
  const CANAL = 2.55;
  const bridgeS = [CX - 29, CX - 9, CX + 9, CX + 29];
  // street grid: centre lines (tile index); player 0's half mirrored (x -> 95 - x)
  const lines0 = [7, 19, 31, 43];
  const lines = [...lines0, ...lines0.map((v) => W - 1 - v)].sort((a, b) => a - b);
  const SW = 1; // street half width in tiles (3 tiles wide)

  for (let vy = 0; vy <= H; vy++)
    for (let vx = 0; vx <= W; vx++) {
      const fx = vx - 0.5;
      const fy = vy - 0.5;
      let h = 0.42 + (symNoise(fx, fy, 0.035, NS) - 0.5) * 0.35;
      const rd = canal.dist(fx, fy);
      // quay walls: a steep drop to the canal bed
      h = h + (-1.0 - h) * (1 - smoothstep(CANAL - 0.15, CANAL + 0.35, rd));
      g.heights[vy * (W + 1) + vx] = h;
    }
  const street = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const rd = canal.dist(x, y);
      const s = (x + y) / 2;
      let t: Tile = Tile.Grass;
      if (rd < CANAL) {
        t = Tile.Water;
        for (const bs of bridgeS) if (Math.abs(s - bs) <= 1.0) t = Tile.Bridge;
      } else if (lines.some((l) => Math.abs(x - l) <= SW) || lines.some((l) => Math.abs(y - l) <= SW)) {
        t = Tile.Dirt;
        street[i] = 1;
      }
      g.tiles[i] = t;
    }
  // blocks: the cells of the grid
  const edges = [-2, ...lines, W + 1];
  type Cell = { x0: number; y0: number; x1: number; y1: number; i: number; j: number };
  const cells: Cell[] = [];
  for (let j = 0; j < edges.length - 1; j++)
    for (let i = 0; i < edges.length - 1; i++) {
      const x0 = edges[i] + SW + 1;
      const x1 = edges[i + 1] - SW - 1; // inclusive
      const y0 = edges[j] + SW + 1;
      const y1 = edges[j + 1] - SW - 1;
      if (x1 - x0 < 3 || y1 - y0 < 3) continue;
      cells.push({ x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(W - 1, x1), y1: Math.min(H - 1, y1), i, j });
    }
  const nearStart = (x: number, y: number, r: number) => starts.some((s) => Math.hypot(x - s.x, y - s.y) < r);
  const cellMid = (c: Cell) => ({ x: (c.x0 + c.x1 + 1) / 2, y: (c.y0 + c.y1 + 1) / 2 });
  const cellCanal = (c: Cell) => {
    let wet = 0;
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (canal.dist(x, y) < CANAL + 1.2) wet++;
    return wet;
  };
  // player 0's half: cells whose centre is on its side (y > x), the rest mirror them
  const own = cells.filter((c) => {
    const m = cellMid(c);
    return m.y - m.x > 0.01;
  });
  // fixed roles: bases (plazas), ore lots, parks, the central squares
  const oreFields: Field[] = half([
    { x: 26, y: 88.5, r: 3.4, kind: 1 },
    { x: 3.5, y: 63, r: 3.0, kind: 1 },
    { x: 37, y: 63, r: 2.9, kind: 1 },
    { x: 13, y: 38, r: 2.5, kind: 2 },
    { x: 49, y: 89, r: 2.5, kind: 2 },
  ]);
  const oils = halfOils([{ x: 35, y: 75 }]);
  const roles = new Map<Cell, 'base' | 'ore' | 'park' | 'square' | 'lot' | 'block'>();
  for (const c of own) {
    const m = cellMid(c);
    if (nearStart(m.x, m.y, 15)) roles.set(c, 'base');
    else if (oreFields.some((f) => f.x >= c.x0 - 2 && f.x <= c.x1 + 3 && f.y >= c.y0 - 2 && f.y <= c.y1 + 3)) roles.set(c, 'ore');
    else if (oils.some((o) => o.x >= c.x0 - 1 && o.x <= c.x1 && o.y >= c.y0 - 1 && o.y <= c.y1)) roles.set(c, 'lot');
    else roles.set(c, 'block');
  }
  // the square by the central bridges and a park on each side; a couple of rubble lots by seed
  const blocks = own.filter((c) => roles.get(c) === 'block');
  const byDist = (p: Point) => [...blocks].sort((a, b) => Math.hypot(cellMid(a).x - p.x, cellMid(a).y - p.y) - Math.hypot(cellMid(b).x - p.x, cellMid(b).y - p.y));
  const sq = byDist({ x: 38, y: 56 })[0];
  if (sq) roles.set(sq, 'square');
  const pk = byDist({ x: 22, y: 50 }).find((c) => roles.get(c) === 'block');
  if (pk) roles.set(pk, 'park');
  const pk2 = byDist({ x: 56, y: 84 }).find((c) => roles.get(c) === 'block');
  if (pk2) roles.set(pk2, 'park');
  const rest = own.filter((c) => roles.get(c) === 'block' && cellCanal(c) < 8);
  for (let k = 0; k < 3 && rest.length; k++) {
    const c = rest.splice(rng.int(rest.length), 1)[0];
    roles.set(c, 'lot');
  }
  const deco = emptyDeco();
  const layout: Structure[] = [];
  const rect = (c: Cell) => ({ x0: c.x0, y0: c.y0, x1: c.x1 + 1, y1: c.y1 + 1 });
  for (const c of own) {
    const role = roles.get(c)!;
    if (role === 'square' || role === 'base') deco.plazas.push(rect(c));
    else if (role === 'park') deco.parks.push(rect(c));
    else if (role === 'lot' || role === 'ore') deco.lots.push(rect(c));
    if (role !== 'block') continue;
    const tpl = BLOCKS[rng.int(BLOCKS.length)];
    const flipX = rng.next() < 0.5;
    const flipY = rng.next() < 0.5;
    const bw = c.x1 - c.x0 + 1;
    const bh = c.y1 - c.y0 + 1;
    for (const b of tpl) {
      // fit the 9 x 9 template to the cell, mirrored by seed; facing follows the flip
      let x = flipX ? 9 - b.x - b.w : b.x;
      let y = flipY ? 9 - b.y - b.h : b.y;
      if (x + b.w > bw) x = bw - b.w;
      if (y + b.h > bh) y = bh - b.h;
      if (x < 0 || y < 0) continue;
      let rot = b.rot;
      if (flipX && (rot === 1 || rot === 3)) rot = 4 - rot;
      if (flipY && (rot === 0 || rot === 2)) rot = 2 - rot;
      layout.push({ kind: b.kind, x: c.x0 + x, y: c.y0 + y, w: b.w, h: b.h, rot });
    }
  }
  // the city's parks get trees (park trees, 2), its avenues street trees (render only)
  for (const p of deco.parks) {
    for (let y = p.y0 + 1; y < p.y1 - 1; y++)
      for (let x = p.x0 + 1; x < p.x1 - 1; x++) {
        const edge = x === p.x0 + 1 || y === p.y0 + 1 || x === p.x1 - 2 || y === p.y1 - 2;
        const mid = Math.abs(x + 0.5 - (p.x0 + p.x1) / 2) < 1.2 || Math.abs(y + 0.5 - (p.y0 + p.y1) / 2) < 1.2;
        if (!mid && (edge ? symHash(x, y, NS + 41) < 0.55 : symHash(x, y, NS + 42) < 0.3)) g.trees[y * W + x] = 2;
      }
  }
  deco.parks = mirrorRects(deco.parks);
  deco.plazas = mirrorRects(deco.plazas);
  deco.lots = mirrorRects(deco.lots);
  for (const p of deco.parks)
    for (let y = p.y0; y < p.y1; y++)
      for (let x = p.x0; x < p.x1; x++) {
        const i = y * W + x;
        if (g.tiles[i] === Tile.Grass && !g.trees[i]) g.trees[i] = g.trees[(H - 1 - y) * W + W - 1 - x];
      }
  // paving everywhere but the parks (render: plazas / pavements); the sim calls it dirt
  for (let i = 0; i < W * H; i++) {
    if (g.tiles[i] !== Tile.Grass) continue;
    const x = i % W;
    const y = (i / W) | 0;
    if (!deco.parks.some((p) => x >= p.x0 && x < p.x1 && y >= p.y0 && y < p.y1)) g.tiles[i] = Tile.Dirt;
  }
  paintOre(g, oreFields);
  unblockTrees(g, starts[0]);

  // street centrelines as roads (avenues on the lines through the centre)
  const roads: Point[][] = [];
  const styles: MapDeco['roadStyles'] = [];
  const addLine = (pts: Point[], width: number, variant: 0 | 1) => {
    roads.push(pts);
    styles.push({ width, variant, straight: true });
  };
  // cut each grid line where it meets the canal
  const runs = (fixed: number, vertical: boolean) => {
    const out: Point[][] = [];
    let cur: Point[] = [];
    for (let k = 0; k <= W; k++) {
      const x = vertical ? fixed : k;
      const y = vertical ? k : fixed;
      const wet = k < W && canal.dist(x, y) < CANAL + 0.8;
      if (!wet && k < W) cur.push({ x, y });
      if ((wet || k === W) && cur.length > 2) {
        out.push([cur[0], cur[cur.length - 1]]);
        cur = [];
      } else if (wet) cur = [];
    }
    return out;
  };
  for (const l of lines) {
    const avenue = l === 31 || l === W - 1 - 31 || l === 19 || l === W - 1 - 19;
    for (const r of runs(l, true)) addLine(r, avenue ? 2.6 : 2.2, avenue ? 0 : 1);
    for (const r of runs(l, false)) addLine(r, avenue ? 2.6 : 2.2, avenue ? 0 : 1);
  }
  // bridge approaches: from each deck end to the nearest street crossing
  const bridges = diagonalBridges(canal, bridgeS, 7.5);
  for (const b of bridges) {
    for (const side of [1, -1]) {
      const e = { x: b.x - 0.5 - side * (b.length / 2) * Math.SQRT1_2, y: b.y - 0.5 + side * (b.length / 2) * Math.SQRT1_2 };
      let best: Point | null = null;
      let bd = 1e9;
      for (const lx of lines)
        for (const ly of lines) {
          const d = Math.hypot(lx - e.x, ly - e.y);
          // on this bank only
          if (Math.sign((lx - ly) / Math.SQRT2 - canal.off((lx + ly) / 2)) !== Math.sign((e.x - e.y) / Math.SQRT2 - canal.off((e.x + e.y) / 2))) continue;
          if (d < bd) {
            bd = d;
            best = { x: lx, y: ly };
          }
        }
      const deck = { x: b.x - 0.5 - side * (b.length / 2 - 1.5) * Math.SQRT1_2, y: b.y - 0.5 + side * (b.length / 2 - 1.5) * Math.SQRT1_2 };
      const app = { x: e.x - side * 1.6 * Math.SQRT1_2, y: e.y + side * 1.6 * Math.SQRT1_2 };
      if (best) addLine([best, app, deck], 2.2, 0);
    }
  }
  // the approaches are paved (dirt) in the sim too
  markRoads(g, roads.slice(roads.length - bridges.length * 2), roads.map(() => 1.3), [Tile.Grass, Tile.Dirt]);

  const { structures, blocked } = placeStructures(g, layout, { starts, oils, ore: oreFields, roads: [], roadClear: 0, startClear: 13, flat: 0.5, tilesOk: [Tile.Dirt, Tile.Grass] });
  // no footprint on a street
  for (const st of structures) st.variant = symHash(Math.min(st.x, W - 1 - st.x), Math.min(st.y, H - 1 - st.y), NS + 21);
  deco.roadStyles = styles;
  // street trees along the avenues' pavements (render only, knocked over by tanks)
  for (const l of [19, 31, W - 1 - 19, W - 1 - 31])
    for (let k = 3; k < W - 3; k += 3) {
      for (const [x, y] of [
        [l - 1.4, k + 0.5],
        [l + 2.4, k + 0.5],
        [k + 0.5, l - 1.4],
        [k + 0.5, l + 2.4],
      ]) {
        const tx = Math.floor(x);
        const ty = Math.floor(y);
        if (tx < 1 || ty < 1 || tx >= W - 1 || ty >= H - 1) continue;
        const i = ty * W + tx;
        if (blocked[i] || g.ore[i] || g.trees[i] || g.tiles[i] === Tile.Water || g.tiles[i] === Tile.Bridge || street[i]) continue;
        if (canal.dist(x - 0.5, y - 0.5) < CANAL + 1.5 || nearStart(x - 0.5, y - 0.5, 12) || symHash(tx, ty, NS + 51) < 0.25) continue;
        if (bridges.some((b) => Math.hypot(b.x - x, b.y - y) < 6)) continue;
        deco.trees.push({ x, y, kind: 1 });
      }
    }
  void street;

  return assemble({ name: 'Canal City', id: 'urban', biome: 'urban' }, g, {
    oreMines: oreFields.map((f) => ({ x: Math.round(f.x), y: Math.round(f.y) })),
    starts,
    oils,
    bridges,
    roads,
    structures,
    blocked,
    techSites: [
      { def: 'tech_hospital', at: [[22, 50], [24, 46], [20, 54], [10, 54], [22, 58]] },
      { def: 'tech_comms', at: [[56, 84], [58, 88], [54, 80], [46, 82], [34, 92]] },
      { def: 'tech_airport', at: [[2, 22], [4, 26], [10, 22], [2, 34], [22, 22]] },
    ],
    lanes: [],
    deco,
  });
}

/** Ground is high enough to be dry land (sanity helper for tests). */
export function dryAt(m: GameMap, x: number, y: number) {
  return m.heights[y * (m.w + 1) + x] > WATER_LEVEL;
}
