// Skirmish maps. Frontline Crossing (map.ts) is the temperate original; this
// module adds three hand-designed, point-symmetric two player maps with their
// own climates - the Sinai Peninsula, a frozen river valley and a canal city -
// and the `createMap` dispatcher the world uses.
//
// Every layout is fixed in code for player 0's half and mirrored (fair starts):
// through the map centre, or across the diagonal for the Sinai (GameMap.mirror). The seed only varies the details (dune and hill
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
  sealPockets,
  smoothstep,
  frameUV,
  framePoint,
  isleAt,
  seaDist,
  seaWiggle,
  ISLE_KNOLL,
  type SeaDeco,
  type SeaFrame,
  type SeaSite,
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
  { id: 'desert', name: 'Wadi Al-Rimal', biome: 'desert', blurb: 'The Sinai: two gulfs, crossings at their heads, Sharm and the high massif', region: 'The Sinai Peninsula between the Gulfs of Suez and Aqaba' },
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
  const m = id === 'desert' ? createDesertMap(seed) : id === 'winter' ? createWinterMap(seed) : id === 'urban' ? createUrbanMap(seed) : createFrontlineMap();
  // no walkable pockets nobody can ever reach (map.ts)
  sealPockets(m);
  return m;
}

// ------------------------------------------------------------------ shared

// The map being built (each generator sets it first: Wadi Al-Rimal is SINAI_N, the others 96 x 96).
let W = 96;
let H = 96;
let CX = (W - 1) / 2;
/** The halves mirror across the x == y diagonal (the Sinai), not through the centre (GameMap.mirror). */
let TRANS = false;
function mapSize(n: number, trans = false) {
  W = H = n;
  CX = (n - 1) / 2;
  TRANS = trans;
}

/** Mirror of a tile-index point (tile centres at integers) onto the other player's half. */
const mirror = (p: Point): Point => (TRANS ? { x: p.y, y: p.x } : { x: W - 1 - p.x, y: H - 1 - p.y });
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

/** Ore regrowth centres of fields built by `half` (player 0's first): rounded on player 0's half, then mirrored (x.5 never rounds apart). */
function mines(fields: Field[]): Point[] {
  const own = fields.slice(0, fields.length / 2).map((f) => ({ x: Math.round(f.x), y: Math.round(f.y) }));
  return [...own, ...own.map(mirror)];
}

/** Oil derricks are 2 x 2 from their top-left tile: the mirrored footprint starts one tile further in. */
const halfOils = (arr: Point[]): Point[] => [...arr, ...arr.map((p) => (TRANS ? { x: p.y, y: p.x } : { x: W - 2 - p.x, y: H - 2 - p.y }))];

/** Mirror capsules (both end points). */
function halfCapsules(arr: Capsule[]): Capsule[] {
  return [...arr, ...arr.map((c) => (TRANS ? { x: c.y, y: c.x, x2: c.y2, y2: c.x2, r: c.r } : { x: W - 1 - c.x, y: H - 1 - c.y, x2: W - 1 - c.x2, y2: H - 1 - c.y2, r: c.r }))];
}

/*
 * Coordinates: features live in tile-index space (tile (x, y) is evaluated at (x, y), vertex
 * (vx, vy) at (vx - 0.5, vy - 0.5)), where the mirror is p -> 95 - p, so every test below is
 * exactly point symmetric.
 */
/** Symmetric fbm (average of the field and its mirror; tile-index space). */
const symNoise = (x: number, y: number, scale: number, seed: number) => (fbm(x * scale, y * scale, seed) + (TRANS ? fbm(y * scale, x * scale, seed) : fbm((W - 1 - x) * scale, (H - 1 - y) * scale, seed))) / 2;
/** Symmetric tile hash. */
const symHash = (x: number, y: number, seed: number) => (hash2(x, y, seed) + (TRANS ? hash2(y, x, seed) : hash2(W - 1 - x, H - 1 - y, seed))) / 2;

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
      g.trees[TRANS ? (i % W) * W + ((i / W) | 0) : W * H - 1 - i] = 0; // mirror tile
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
  /** Max height difference over the whole footprint: a pair on steeper ground moves up to a tile to a gentler spot, else is skipped. */
  footFlat?: number;
  tilesOk: Tile[];
}

/**
 * Structures from a fixed layout for player 0's half, mirrored for player 1. Each footprint is
 * validated (open flat ground, away from bases, ore, oil and roads, a walkable one tile margin) and a
 * flood fill makes sure it cuts nothing off; failures are skipped.
 */
function placeStructures(g: Grids, layout: Structure[], o: PlaceOpts) {
  // (a transposed footprint swaps its sides; rot r faces (0,-1), (1,0), (0,1), (-1,0) for r = 0..3: mirrored 3 - r)
  const all = [
    ...layout,
    ...layout.map((st) => {
      if (TRANS) return { ...st, x: st.y, y: st.x, w: st.h, h: st.w, rot: (3 - st.rot) & 3 };
      const p = mirror({ x: st.x + st.w - 1, y: st.y + st.h - 1 });
      return { ...st, x: p.x, y: p.y, rot: (st.rot + 2) % 4 };
    }),
  ];
  /** A structure that is its own mirror image (on the mirror axis): it stands once. */
  const self = (a: Structure, b: Structure) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
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
  const fits = (pair: Structure[]) => {
    for (const st of pair)
      for (let y = st.y - 1; y <= st.y + st.h; y++)
        for (let x = st.x - 1; x <= st.x + st.w; x++) {
          const inside = x >= st.x && y >= st.y && x < st.x + st.w && y < st.y + st.h;
          if (inside ? !okTile(x, y) : x < 0 || y < 0 || x >= W || y >= H || blocked[y * W + x] || !walkable(g, null, y * W + x)) return false;
        }
    return true;
  };
  const rise = (st: Structure) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let y = st.y; y <= st.y + st.h; y++)
      for (let x = st.x; x <= st.x + st.w; x++) {
        lo = Math.min(lo, vh(x, y));
        hi = Math.max(hi, vh(x, y));
      }
    return hi - lo;
  };
  const gentle = (pair: Structure[]) => o.footFlat === undefined || pair.every((st) => rise(st) <= o.footFlat!);
  const nudges = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, -1],
    [1, -1],
    [-1, 1],
  ];
  for (let k = 0; k < n; k++) {
    let pair = self(all[k], all[k + n]) ? [all[k]] : [all[k], all[k + n]];
    if (!fits(pair)) continue;
    if (!gentle(pair)) {
      // too steep where it was drawn: the nearest gentle spot a tile away (mirrored), if any
      const base = pair;
      pair = [];
      for (const [dx, dy] of nudges) {
        const q = [{ ...base[0], x: base[0].x + dx, y: base[0].y + dy }];
        if (base.length > 1) q.push(TRANS ? { ...base[1], x: base[1].x + dy, y: base[1].y + dx } : { ...base[1], x: base[1].x - dx, y: base[1].y - dy });
        // (a structure on the axis only moves along it)
        else if (TRANS && dx !== dy) continue;
        if (fits(q) && gentle(q)) {
          pair = q;
          break;
        }
      }
      if (!pair.length) continue;
    }
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
const mirrorRects = <T extends { x0: number; y0: number; x1: number; y1: number; rows?: 0 | 1 }>(rs: T[]) => [
  ...rs,
  ...rs.map((r) => (TRANS ? { ...r, x0: r.y0, y0: r.x0, x1: r.y1, y1: r.x1, ...(r.rows !== undefined ? { rows: (1 - r.rows) as 0 | 1 } : {}) } : { ...r, x0: W - r.x1, y0: H - r.y1, x1: W - r.x0, y1: H - r.y0 })),
];

function assemble(
  base: { name: string; id: MapId; biome: Biome },
  g: Grids,
  more: Pick<GameMap, 'oreMines' | 'starts' | 'oils' | 'bridges' | 'roads' | 'structures' | 'blocked' | 'techSites' | 'lanes' | 'deco' | 'offshore'>,
): GameMap {
  return { ...base, w: W, h: H, tiles: g.tiles, heights: g.heights, trees: g.trees, ore: g.ore, oreKind: g.oreKind, ...(TRANS ? { mirror: 'transpose' as const } : {}), ...more };
}

// ================================================================== desert

/*
 * "Wadi Al-Rimal": the Sinai Peninsula (SN1). Map north is the top of the screen (the tile map's north-west
 * corner): the Mediterranean along the top, the Gulf of Suez down the west and the Gulf of Aqaba down the east,
 * meeting the Red Sea at the southern tip (Sharm el-Sheikh). Player 0 (blue) holds the Egyptian mainland west of
 * the upper Gulf of Suez, player 1 (red) the Arabian mainland east of the Gulf of Aqaba; the Sinai lies between.
 * There are no bridges: armies cross over land at the head of each gulf - on the west between the gulf and the
 * Suez Canal's Great Bitter Lake (the canal runs on north to the Mediterranean), on the east between the gulf and
 * the granite ridge running north from it - two corridors of the same width, each with its village. Aircraft fly
 * straight over the gulfs.
 *
 * Fairness: the halves mirror across the x == y diagonal (the screen's left-right mirror; GameMap.mirror), so the
 * gameplay is laid out once for player 0 and transposed: ground, slopes, ore, oil, tech sites, villages, roads.
 * What differs is scenery: the canal is water where the ridge is rock (both impassable, the heights of their banks
 * the same), the resorts' looks, the Blue Hole's reef lagoon (render only) and Tiran (an island no ground unit
 * reaches). Layout below in screen coordinates (E east, S south of the map's top corner, tiles), player 0's half.
 */

/** The Sinai map's size (tiles). */
export const SINAI_N = 160;
const R2 = Math.SQRT2;
/** Continuous map point of screen position (e, s). */
const sp = (e: number, s: number): Point => ({ x: (s + e) / R2, y: (s - e) / R2 });
/** Tile-index point (a tile's centre at its index) of screen position (e, s). */
const si = (e: number, s: number): Point => ({ x: (s + e) / R2 - 0.5, y: (s - e) / R2 - 0.5 });
/** Screen east / south of continuous map point (x, y). */
const scrE = (x: number, y: number) => (x - y) / R2;
const scrS = (x: number, y: number) => (x + y) / R2;

/** The open seas' coasts: distance from the map centre along the diagonal (the Mediterranean, the Red Sea). */
const MED_OFF = 70;
const RED_OFF = 89;
/** The Gulf of Suez (E, S, half width) from its head to the Red Sea; the Gulf of Aqaba is its mirror. */
const SUEZ: [number, number, number][] = [
  [-39, 93, 2.8],
  [-38, 106, 3.8],
  [-36, 124, 4.7],
  [-33, 142, 5.4],
  [-27, 162, 6.2],
  [-21.5, 178, 6.8],
  [-20, 192, 7.6],
  [-21, 214, 9],
];
/**
 * The Suez Canal (west only) from the Mediterranean to the Great Bitter Lake, which ends short of the gulf's head
 * (the west corridor between them): centre line (E, S) and half width; its lakes (E, S, half extents along E, S).
 * The Arabian side has a granite ridge on the mirror of this footprint.
 */
const CANAL: [number, number][] = [
  [-27, 30],
  [-28.5, 44],
  [-30.5, 51],
  [-32, 56.5],
  [-34.5, 63],
  [-36, 70],
];
const CANAL_HW = 2.2;
const CANAL_LAKES: [number, number, number, number][] = [
  [-32, 56.5, 3.0, 2.6],
  [-36, 70.5, 3.4, 5.8],
];
/** Player 0's start (screen position). */
const START0: [number, number] = [-68, 100];
/** Ore fields (E, S, radius, kind 1 ore / 2 gems), player 0's half. */
const SINAI_ORE: [number, number, number, number][] = [
  [-55, 113, 3.6, 1],
  [-63, 82, 3.2, 1],
  [-62, 141, 3.0, 1],
  [-45, 62, 2.8, 1],
  [-20, 69, 2.5, 2],
  [-19, 95, 3.0, 1],
  [-12, 166, 2.3, 2],
];
/** Oil derricks (centres, E, S). */
const SINAI_OIL: [number, number][] = [
  [-57, 106],
  [-57, 78],
  [-27, 118],
  [-11, 96],
];
/** The high granite massif of south Sinai (St Catherine): spine (E, S, crest height) to the axis; mirrored. */
const SINAI_MASSIF: { e: number; s: number; h: number }[][] = [
  [
    { e: -19.5, s: 139, h: 2.0 },
    { e: -17, s: 142, h: 3.4 },
    { e: -13, s: 147, h: 4.6 },
    { e: -7, s: 151, h: 3.8 },
    { e: 0, s: 153, h: 3.4 },
  ],
  [
    { e: -13, s: 147, h: 4.6 },
    { e: -12.5, s: 155, h: 3.0 },
    { e: -11.5, s: 159, h: 2.0 },
  ],
  [
    { e: 0, s: 153, h: 3.4 },
    { e: 0, s: 162, h: 2.6 },
    { e: 0, s: 168, h: 1.2 },
  ],
];
/** The mountains along the outer gulf coast (Egypt's Galala; Arabia's Midian on the mirror). */
const SINAI_COAST_MTS: { e: number; s: number; h: number }[][] = [
  [
    { e: -47.5, s: 116, h: 1.2 },
    { e: -48, s: 124, h: 3.1 },
    { e: -45, s: 137, h: 2.6 },
    { e: -41.5, s: 154, h: 3.3 },
    { e: -36, s: 170, h: 2.5 },
    { e: -33, s: 182, h: 1.0 },
  ],
];
/** The sandstone highland the coloured canyon cuts through (spine; the canyon itself: SINAI_CANYON). */
const SINAI_HIGHLAND: { e: number; s: number; h: number }[][] = [
  [
    { e: -16.6, s: 119, h: 3.1 },
    { e: -19.6, s: 124.6, h: 3.4 },
  ],
];
/** The coloured canyon's floor centre line (E, S), player 0's (the Arabian one near the Aqaba coast is its mirror). */
const SINAI_CANYON: [number, number][] = [
  [-13.2, 111],
  [-15.2, 115],
  [-16, 118.8],
  [-18.2, 121.4],
  [-19, 124.6],
  [-21.3, 127],
  [-22.6, 131],
];
/** Sandstone mesas and buttes (impassable, flat-topped): capsule ends (E, S) and radius. */
const SINAI_MESAS: [number, number, number, number, number][] = [
  [-31, 97, -27.5, 101.5, 2.2],
  [-8.5, 109, -5.5, 113, 1.9],
  [-58, 121, -55, 126, 2.2],
];
/** Oases and springs (E, S, radius). */
const SINAI_OASES: [number, number, number][] = [
  [-27, 109, 1.9],
  [-52, 68, 2.1],
  [-67, 126, 1.7],
];
/**
 * The oasis gorge at the massif's north foot, on the axis (Ain Khudra; render/seaside.ts buildOasisGorge): a lake
 * under two sandstone escarpments with a spring pool below each, irrigated plots and a side wadi; tile-index
 * offsets from GORGE (the lake's tile on the diagonal), player 0's (the pools and ridges mirror each other).
 */
export const GORGE = 92;
const GORGE_LAKE = 3.3;
const GORGE_POOL: [number, number, number] = [-8, 6, 1.8];
const GORGE_RIDGE: [number, number, number, number, number] = [-14, 3, -7, 9, 2.3];
const GORGE_WADI: [number, number][] = [
  [-17, 14],
  [-14, 8.5],
  [-10, 4],
];
/** Wadi el-Arish runs north to the Mediterranean on the axis; its tributaries (E, S polylines; mirrored). */
const SINAI_WADIS: [number, number][][] = [
  [
    [-17, 109],
    [-11, 100],
    [-6, 93],
    [-2.5, 88],
  ],
];
/** The main wadi's bed on the axis from El Tih to the coast (S range). */
const ARISH = [48, 127];

/** The gulfs and seas (render and sim share it: sim/map.ts seaDist). */
function sinaiSea(): SeaDeco {
  const c = W / 2;
  const suez = SUEZ.map(([e, s, hw]) => ({ ...sp(e, s), hw }));
  const aqaba = suez.map((p) => ({ x: p.y, y: p.x, hw: p.hw }));
  const sea: SeaDeco = { c, top: MED_OFF, bottom: RED_OFF, gulfs: [suez, aqaba], sites: [] };
  /** The frame of a beach on the Sinai's own shore of the Gulf of Suez at screen south s (u northwards, v seaward). */
  const shoreAt = (s: number) => {
    let k = 0;
    while (SUEZ[k + 1][1] < s) k++;
    const [e0, s0, h0] = SUEZ[k];
    const [e1, s1, h1] = SUEZ[k + 1];
    const t = (s - s0) / (s1 - s0);
    // the inner (east) shore: centre + half width along the segment's normal towards the Sinai; its heading follows
    // the shore's own slant (the half width grows down the gulf)
    const dE = e1 - e0;
    const dS = s1 - s0;
    const L = Math.hypot(dE, dS);
    const nE = dS / L;
    const nS = -dE / L;
    const p0 = { e: e0 + nE * h0, s: s0 + nS * h0 };
    const p1 = { e: e1 + nE * h1, s: s1 + nS * h1 };
    const pe = p0.e + (p1.e - p0.e) * t;
    const ps = p0.s + (p1.s - p0.s) * t;
    return { p: sp(pe, ps), along: sp(pe + (p1.e - p0.e) * 0.01, ps + (p1.s - p0.s) * 0.01) };
  };
  /** A frame on the shore at s: origin on the waterline, +u along the shore (to the north), +v seaward (west). */
  const frameAt = (s: number, back = 0) => {
    const { p, along } = shoreAt(s);
    // (+u runs up the gulf, towards its head)
    const tx = p.x - along.x;
    const ty = p.y - along.y;
    const ang = Math.atan2(ty, tx);
    const n = { x: Math.sin(ang), y: -Math.cos(ang) };
    return { x: p.x - n.x * back, y: p.y - n.y * back, ang };
  };
  // a resort on the Gulf of Suez's Sinai shore (Ras Sudr) and its mirror on the Gulf of Aqaba's (Taba / Nuweiba)
  const west = { ...frameAt(108, 0.3), resort: { u0: -6, u1: 5, v0: -11, v1: -4.8 }, beach: [-11, 9] as [number, number], look: 1 };
  sea.sites.push(west, mirrorSite(west, 2));
  // Sharm el-Sheikh / Naama Bay on the southern tip, facing the Red Sea, astride the axis
  const sharmS = c * R2 + RED_OFF - seaWiggle(0);
  const sh = sp(0, sharmS);
  sea.sites.push({ x: sh.x, y: sh.y, ang: (3 * Math.PI) / 4, resort: { u0: -6, u1: 6, v0: -11.2, v1: -4.8 }, beach: [-10, 10], look: 0 });
  // Tiran with its lighthouse in the mouth of the Gulf of Aqaba, east of Sharm (u along the strait)
  const ti = mirrorSP(sp(-20.3, 187));
  const aq = { x: aqaba[6].x - aqaba[5].x, y: aqaba[6].y - aqaba[5].y };
  sea.isle = { x: ti.x, y: ti.y, ang: Math.atan2(aq.y, aq.x), ru: 2.7, rv: 2.05 };
  // the Blue Hole off Dahab, on the Sinai's Aqaba shore north of Sharm
  const bh = frameAt(153, -0.2);
  sea.hole = mirrorFrame(bh);
  return sea;
}

/** The mirror image of a continuous point (transposed halves). */
const mirrorSP = (p: Point): Point => ({ x: p.y, y: p.x });
/** A frame mirrored onto the other half: its u axis turns round (a mirror flips handedness; v stays seaward). */
function mirrorFrame<T extends SeaFrame>(f: T): T {
  // seaward n = (sin a, -cos a) mirrors to (-cos a, sin a) = (sin a', -cos a') with a' = -a - pi / 2
  return { ...f, x: f.y, y: f.x, ang: -f.ang - Math.PI / 2 };
}
/** A resort mirrored: the same compound (its u range turned round with the frame), another look. */
function mirrorSite(s: SeaSite, look: number): SeaSite {
  return { ...mirrorFrame(s), resort: { u0: -s.resort.u1, u1: -s.resort.u0, v0: s.resort.v0, v1: s.resort.v1 }, beach: [-s.beach[1], -s.beach[0]], look };
}

/** Is continuous point (x, y) in the canal (player 0's side) / the ridge's footprint (player 1's)? Symmetric. */
function barrierAt(x: number, y: number) {
  const e = -Math.abs(scrE(x, y));
  const s = scrS(x, y);
  if (e > -22 || s > 80) return false;
  for (const [le, ls, re, rs] of CANAL_LAKES) if (((e - le) / re) ** 2 + ((s - ls) / rs) ** 2 < 1) return true;
  for (let k = 0; k < CANAL.length - 1; k++) if (distToSegment(e, s, CANAL[k][0], CANAL[k][1], CANAL[k + 1][0], CANAL[k + 1][1]) < CANAL_HW) return true;
  return false;
}

/** A mountain range given as spine polylines (screen positions, crest heights): its height at a point, how far up (0 foot .. 1 crest), ridge noise. */
function ridgeHalf(lines: { x: number; y: number; h: number }[][], foot: number, lift: number, x: number, y: number, ns: number) {
  const ft = foot + (fbm(x * 0.08, y * 0.08, ns + 41) - 0.5) * (foot * 0.32);
  let hs = 0;
  let f = 0;
  for (const line of lines)
    for (let j = 0; j < line.length - 1; j++) {
      const a = line[j];
      const b = line[j + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)));
      const p = massifProfile(Math.hypot(x - a.x - dx * t, y - a.y - dy * t) / ft);
      if (p <= 0) continue;
      hs = Math.max(hs, (a.h + (b.h - a.h) * smoothstep(0, 1, t)) * lift * p);
      f = Math.max(f, p);
    }
  if (f <= 0) return { h: 0, f: 0, r: 0 };
  const r = 1 - Math.abs(2 * fbm(x * 0.15, y * 0.15, ns + 43) - 1);
  const gully = Math.max(0, 0.3 - r) * 2.2 * Math.min(1, f * 3);
  return { h: Math.max(0, hs * (0.8 + 0.34 * r) - gully), f, r };
}
/** ridgeHalf over both halves (the higher one; continuous across the axis). */
function ridgeAt(lines: { x: number; y: number; h: number }[][], foot: number, lift: number, x: number, y: number, ns: number) {
  const a = ridgeHalf(lines, foot, lift, x, y, ns);
  const b = ridgeHalf(lines, foot, lift, y, x, ns);
  return a.h >= b.h ? a : b;
}
const spine = (src: { e: number; s: number; h: number }[][]) => src.map((l) => l.map((p) => ({ ...sp(p.e, p.s), h: p.h })));

export function createDesertMap(seed: number): GameMap {
  mapSize(SINAI_N, true);
  const rng = new Rng((seed ^ 0x51a7d00d) >>> 0);
  const NS = 4000 + rng.int(4000);
  const g = newGrids();
  const sea = sinaiSea();
  /** Symmetric fbm at a continuous point. */
  const symN = (x: number, y: number, sc: number, s: number) => (fbm(x * sc, y * sc, s) + fbm(y * sc, x * sc, s)) / 2;
  const s0 = si(...START0);
  const starts: Point[] = [{ x: Math.round(s0.x), y: Math.round(s0.y) }];
  starts.push(mirror(starts[0]));
  const startsC = starts.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
  const oreFields: Field[] = half(SINAI_ORE.map(([e, s, r, kind]) => ({ ...si(e, s), r: r + (kind === 2 ? rng.range(-0.1, 0.1) : 0), kind })));
  const oils = halfOils(
    SINAI_OIL.map(([e, s]) => {
      const p = sp(e, s);
      return { x: Math.round(p.x - 1), y: Math.round(p.y - 1) };
    }),
  );
  const massifL = spine(SINAI_MASSIF);
  const coastL = spine(SINAI_COAST_MTS);
  const highL = spine(SINAI_HIGHLAND);
  const lift = MASSIF_LIFT * (1 + rng.range(-0.03, 0.03));
  // sandstone mesas (continuous capsules)
  const mesas = SINAI_MESAS.flatMap(([e0, s0_, e1, s1, r]) => {
    const a = sp(e0, s0_);
    const b = sp(e1, s1);
    const rr = r + rng.range(-0.15, 0.15);
    return [
      { x: a.x, y: a.y, x2: b.x, y2: b.y, r: rr },
      { x: a.y, y: a.x, x2: b.y, y2: b.x, r: rr },
    ];
  });
  const oases = SINAI_OASES.flatMap(([e, s, r]) => {
    const p = sp(e, s);
    return [
      { x: p.x, y: p.y, r },
      { x: p.y, y: p.x, r },
    ];
  });
  // the oasis gorge (tile-index offsets -> continuous points)
  const gz = (dx: number, dy: number) => ({ x: GORGE + dx + 0.5, y: GORGE + dy + 0.5 });
  oases.push({ ...gz(0, 0), r: GORGE_LAKE }, { ...gz(GORGE_POOL[0], GORGE_POOL[1]), r: GORGE_POOL[2] }, { ...gz(GORGE_POOL[1], GORGE_POOL[0]), r: GORGE_POOL[2] });
  {
    const [x0, y0, x1, y1, r] = GORGE_RIDGE;
    const a = gz(x0, y0);
    const b = gz(x1, y1);
    mesas.push({ x: a.x, y: a.y, x2: b.x, y2: b.y, r }, { x: a.y, y: a.x, x2: b.y, y2: b.x, r });
  }
  const wadis = SINAI_WADIS.flatMap((l) => {
    const pts = l.map(([e, s]) => sp(e, s));
    return [pts, pts.map(mirrorSP)];
  });
  {
    const pts = GORGE_WADI.map(([dx, dy]) => gz(dx, dy));
    wadis.push(pts, pts.map(mirrorSP));
  }
  const wadiDist = (x: number, y: number) => {
    let d = Math.abs(scrE(x, y)) + Math.max(0, ARISH[0] - scrS(x, y), scrS(x, y) - ARISH[1]);
    for (const l of wadis) for (let k = 0; k < l.length - 1; k++) d = Math.min(d, distToSegment(x, y, l[k].x, l[k].y, l[k + 1].x, l[k + 1].y));
    return d;
  };
  // the villages at the two crossings and Sharm's town stand on graded ground
  const villageAt = sp(-37.5, 84);
  const sharmAt = sp(0, 184);
  const townK = (x: number, y: number) => {
    const k = (cx: number, cy: number, r: number) => 1 - smoothstep(r, r + 3, Math.hypot(x - cx, y - cy));
    return Math.max(k(villageAt.x, villageAt.y, 11), k(villageAt.y, villageAt.x, 11), k(sharmAt.x, sharmAt.y, 8));
  };
  const lowGround = (x: number, y: number) => {
    const s = scrS(x, y);
    let h = 0.42 + (symN(x, y, 0.045, NS) - 0.5) * 1.3;
    // north Sinai: long east-west dunes, higher towards the Mediterranean (the sand sea); the corridors and
    // villages on levelled ground
    const warp = (symN(x, y, 0.06, NS + 3) - 0.5) * 9;
    const dune = Math.pow(0.5 + 0.5 * Math.cos((s + warp) * 0.56), 1.6);
    h += dune * 0.5 * smoothstep(108, 72, s) * (1 - 0.9 * townK(x, y));
    // El Tih: the limestone plateau of central Sinai, a gentle rise
    h += 0.3 * smoothstep(96, 118, s) * (1 - smoothstep(150, 175, s));
    return h;
  };
  const massifAt = (x: number, y: number) => ridgeAt(massifL, MASSIF_FOOT, lift, x, y, NS);
  const coastMtAt = (x: number, y: number) => ridgeAt(coastL, 8.5, 1.1, x, y, NS + 100);
  const highAt = (x: number, y: number) => ridgeAt(highL, 12, 1, x, y, NS + 200);
  const mountAt = (x: number, y: number) => {
    const a = massifAt(x, y);
    const b = coastMtAt(x, y);
    const c = highAt(x, y);
    return { h: a.h + b.h + c.h, f: Math.max(a.f, b.f, c.f), r: a.f >= b.f && a.f >= c.f ? a.r : b.f >= c.f ? b.r : c.r, massif: a.f };
  };
  const mesaBase = mesas.map((m) => mountAt((m.x + m.x2) / 2, (m.y + m.y2) / 2).h * 0.92);
  const surface = (x: number, y: number) => {
    let h = lowGround(x, y) + mountAt(x, y).h;
    for (let j = 0; j < mesas.length; j++) {
      const m = mesas[j];
      const d = distToSegment(x, y, m.x, m.y, m.x2, m.y2);
      h = h + (2.25 + mesaBase[j] - h) * (1 - smoothstep(m.r - 0.45, m.r + 0.65, d));
    }
    return h;
  };
  // the coloured canyons (continuous points): the floor falls evenly from the ground at one mouth to the other
  const canyonPts = SINAI_CANYON.map(([e, s]) => sp(e, s));
  const canyons = [canyonPts, canyonPts.map(mirrorSP)].map((pts) => {
    let len = 0;
    const at = pts.map((p, i) => (i ? (len += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y)) : 0));
    // (the same floor heights on both: the canyons are mirror twins)
    const a = surface(canyonPts[0].x, canyonPts[0].y);
    const b = surface(canyonPts[canyonPts.length - 1].x, canyonPts[canyonPts.length - 1].y);
    return { pts, at, len, a, b };
  });
  const canyonAt = (x: number, y: number) => {
    let best = { d: 1e9, floor: 0 };
    for (const c of canyons)
      for (let k = 0; k < c.pts.length - 1; k++) {
        const p = c.pts[k];
        const q = c.pts[k + 1];
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const l2 = dx * dx + dy * dy;
        const t = Math.max(0, Math.min(1, ((x - p.x) * dx + (y - p.y) * dy) / l2));
        const d = Math.hypot(x - p.x - dx * t, y - p.y - dy * t);
        if (d < best.d) {
          const s = (c.at[k] + t * Math.sqrt(l2)) / c.len;
          best = { d, floor: c.a + (c.b - c.a) * s - Math.sin(s * Math.PI) * 0.55 };
        }
      }
    return best;
  };
  const canyonWall = (x: number, y: number, floor: number) => surface(x, y) - floor > 0.75;
  /** The ground before the tracks are graded into it (continuous vertex point). */
  const naturalC = (x: number, y: number) => {
    let h = lowGround(x, y) + mountAt(x, y).h;
    for (const s of startsC) h = h + (0.45 - h) * (1 - smoothstep(9, 15, Math.hypot(x - s.x, y - s.y)));
    h = h + (0.4 - h) * townK(x, y) * 0.85;
    // Wadi el-Arish and its tributaries: broad shallow beds
    const wd = wadiDist(x, y);
    h = h + (-0.02 - h) * (1 - smoothstep(1.6, 4.2, wd)) * 0.9;
    for (const o of oases) {
      const d = Math.hypot(x - o.x, y - o.y);
      h = h + (-0.95 - h) * (1 - smoothstep(o.r - 0.6, o.r + 1.6, d));
    }
    for (let j = 0; j < mesas.length; j++) {
      const m = mesas[j];
      const d = distToSegment(x, y, m.x, m.y, m.x2, m.y2);
      const top = 2.25 + mesaBase[j] + ((hash2(x, y, NS + 9) + hash2(y, x, NS + 9)) / 2 - 0.5) * 0.12;
      h = h + (top - h) * (1 - smoothstep(m.r - 0.45, m.r + 0.65, d));
    }
    const cy = canyonAt(x, y);
    if (cy.d < CANYON_HW + CANYON_FLAT + 2.4) h = Math.min(h, cy.floor + smoothstep(CANYON_HW + CANYON_FLAT, CANYON_HW + CANYON_FLAT + 1.3, cy.d) * 6);
    return h;
  };
  // the ground by the sea (beaches, reefs, the resorts' terraces), then the tracks graded into it (rampSet works
  // in tile-index space)
  const groundC = (x: number, y: number) => coastHeight(sea, x, y, naturalC(x, y), NS);
  const natural = (fx: number, fy: number) => groundC(fx + 0.5, fy + 0.5);
  const ramps = rampSet(W, H, SINAI_RAMPS.map((r) => ({ ...r, pts: r.pts.map((p) => ({ ...p, ...si(p.x, p.y) })) })), natural);
  for (let vy = 0; vy <= H; vy++) for (let vx = 0; vx <= W; vx++) g.heights[vy * (W + 1) + vx] = ramps.grade(vx - 0.5, vy - 0.5, groundC(vx, vy));
  // the canal and the ridge: their banks keep the ground's height (the same on both halves); only vertices with
  // canal / ridge on all four sides sink into the canal's bed or rise into the ridge's crags
  const barrier = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (barrierAt(x + 0.5, y + 0.5) && seaDist(sea, x + 0.5, y + 0.5) < 0.3) barrier[y * W + x] = 1;
  for (let vy = 1; vy < H; vy++)
    for (let vx = 1; vx < W; vx++) {
      const i = (vy - 1) * W + vx - 1;
      if (!barrier[i] || !barrier[i + 1] || !barrier[i + W] || !barrier[i + W + 1]) continue;
      const k = vy * (W + 1) + vx;
      if (vx < vy) {
        // the canal (west of the diagonal: player 0's half), its lakes a little deeper
        const e = scrE(vx, vy);
        const s = scrS(vx, vy);
        const lake = CANAL_LAKES.some(([le, ls, re, rs]) => ((e - le) / re) ** 2 + ((s - ls) / rs) ** 2 < 0.7);
        g.heights[k] = WATER_LEVEL - (lake ? 0.85 : 0.6);
      } else {
        // the granite ridge: crags, higher where the canal's lakes are mirrored (knots of mountain)
        const e = -scrE(vx, vy);
        const s = scrS(vx, vy);
        const knot = CANAL_LAKES.some(([le, ls, re, rs]) => ((e - le) / re) ** 2 + ((s - ls) / rs) ** 2 < 0.8);
        g.heights[k] += 1.5 + (knot ? 1.4 : 0) + fbm(vx * 0.3, vy * 0.3, NS + 77) * 1.6;
      }
    }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const fx = x + 0.5;
      const fy = y + 0.5;
      let t: Tile = Tile.Sand;
      if (symN(fx, fy, 0.07, NS + 5) > 0.57) t = Tile.Dirt; // gravel plains
      const mt = mountAt(fx, fy);
      if (mt.f > 0.06) {
        // stony slopes and talus, drift sand in the gullies, bare granite crags on the high ridges
        t = mt.r < 0.3 && mt.f > 0.12 ? Tile.Sand : Tile.Dirt;
        if (mt.f > 0.55 && mt.r > 0.86 && mt.h > 2.4) t = Tile.Rock;
      }
      const wd = wadiDist(fx, fy);
      if (wd < 1.8) t = Tile.Dirt;
      else if (townK(fx, fy) > 0.5) t = Tile.Dirt;
      else if (wd < 3.6 && symN(fx, fy, 0.2, NS + 6) > 0.48) t = Tile.Grass;
      for (const o of oases) {
        const d = Math.hypot(fx - o.x, fy - o.y);
        if (d < o.r) t = Tile.Water;
        else if (d < o.r + 2.4 && t !== Tile.Water) t = Tile.Grass;
      }
      for (const m of mesas) if (distToSegment(fx, fy, m.x, m.y, m.x2, m.y2) < m.r + 0.1) t = Tile.Rock;
      const cy = canyonAt(fx, fy);
      if (cy.d < CANYON_HW) t = Tile.Sand;
      else if (cy.d < CANYON_HW + 1.1 && canyonWall(fx, fy, cy.floor)) t = Tile.Rock;
      if (ramps.onTrack(x, y)) t = Tile.Dirt;
      t = coastTile(sea, fx, fy, t);
      if (barrier[i]) t = x < y ? Tile.Water : Tile.Rock;
      g.tiles[i] = t;
    }
  const roads0 = SINAI_ROADS.map((l) => l.map(([e, s]) => si(e, s)));
  // the highway across the north and the coast road round the tip meet their mirrors on the axis: one road each,
  // base to base and gulf to gulf (each is its own mirror image); the Egyptian road has its Arabian twin
  const whole = (l: Point[]) => [...l, ...[...l].reverse().map(mirror).slice(1)];
  const roads = [whole(roads0[0]), whole(roads0[1]), roads0[2], ...mirrorLines([roads0[2]])];
  const roadKind = (i: number) => SINAI_ROAD_KIND[Math.min(i, 2)];
  markRoads(g, roads, roads.map((_, i) => [0.95, 0.85, 0.7][roadKind(i)]), [Tile.Sand, Tile.Dirt, Tile.Grass]);
  paintOre(g, oreFields);

  const reserved = (x: number, y: number) =>
    starts.some((s) => Math.hypot(x - s.x, y - s.y) < 10) ||
    oils.some((o) => Math.abs(x - o.x - 0.5) < 3 && Math.abs(y - o.y - 0.5) < 3) ||
    oreFields.some((f) => Math.hypot(x - f.x, y - f.y) < f.r + 2.5) ||
    canyonAt(x + 0.5, y + 0.5).d < CANYON_HW + CANYON_FLAT + 1.2 ||
    ramps.near(x, y, 1.5) ||
    townK(x + 0.5, y + 0.5) > 0.3 ||
    roads.some((r) => r.some((p, k) => k > 0 && distToSegment(x + 0.5, y + 0.5, r[k - 1].x + 0.5, r[k - 1].y + 0.5, p.x + 0.5, p.y + 0.5) < 1.8));
  // date palms ring the oases and dot the wadis; acacias stand alone on the scrub and gravel
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const t = g.tiles[i];
      if ((t !== Tile.Grass && t !== Tile.Dirt && t !== Tile.Sand) || reserved(x, y) || g.ore[i] || coastBusy(sea, x + 0.5, y + 0.5) || barrierNear(x, y)) continue;
      let wet = false;
      for (let dy = -1; dy <= 1 && !wet; dy++)
        for (let dx = -1; dx <= 1 && !wet; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H && g.tiles[yy * W + xx] === Tile.Water) wet = true;
        }
      if (wet) continue;
      let palm = 0;
      for (const o of oases) {
        const d = Math.hypot(x + 0.5 - o.x, y + 0.5 - o.y);
        if (d > o.r + 0.4 && d < o.r + 3.2) palm = Math.max(palm, 0.55 - (d - o.r) * 0.1);
      }
      const wd = wadiDist(x + 0.5, y + 0.5);
      if (wd > 1.8 && wd < 3.8) palm = Math.max(palm, 0.06);
      const h = symHash(x, y, NS + 11);
      if (h < palm) g.trees[i] = 2;
      else if ((t === Tile.Grass || t === Tile.Dirt) && h > 0.982) g.trees[i] = 1;
    }
  /** Next to the canal or the ridge (no trees: the banks are the same on both halves). */
  function barrierNear(x: number, y: number) {
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H && barrier[yy * W + xx]) return true;
      }
    return false;
  }
  unblockTrees(g, starts[0]);

  const layout: Structure[] = [...sinaiVillage(), ...SINAI_HAMLETS.flatMap(([e, s, list]) => houseRow(e, s, list))];
  const { structures, blocked } = placeStructures(g, layout, { starts, oils, ore: oreFields, roads, roadClear: 1.6, startClear: 15, flat: 0.45, footFlat: 0.4, tilesOk: [Tile.Grass, Tile.Dirt, Tile.Sand] });
  // the resort compounds by the sea (impassable; render/seaside.ts draws them)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inResort(sea, x + 0.5, y + 0.5)) blocked[y * W + x] = 1;
  for (const st of structures) st.variant = hash2(Math.min(st.x, st.y), Math.max(st.x, st.y), NS + 21);
  // (one mosque per village and Sharm's on the axis; any other becomes shops)
  let mosques = 0;
  for (const st of structures) if (st.look === 'mosque' && ++mosques > 3) st.look = 'shops';

  const deco = emptyDeco();
  deco.roadStyles = roads.map((_, i) => [{ width: 1.05, variant: 0 as const }, { width: 0.9, variant: 1 as const }, { width: 0.75, variant: 1 as const }][roadKind(i)]);
  const tracks0 = SINAI_TRACKS.map((l) => l.map(([e, s]) => si(e, s)));
  deco.tracks = [...tracks0, ...mirrorLines(tracks0), ...ramps.lines];
  deco.trackBeds = [...tracks0.map(() => 0), ...tracks0.map(() => 0), ...ramps.beds];
  deco.trackNoCars = [...tracks0.map(() => false), ...tracks0.map(() => false), ...ramps.noCars];
  // irrigated plots by the oases, the villages and in the gorge (its two mirror each other)
  deco.fields = mirrorRects(
    SINAI_FIELDS.map(([e, s, w, h, rows]) => {
      const p = sp(e, s);
      return { x0: p.x - w / 2, y0: p.y - h / 2, x1: p.x + w / 2, y1: p.y + h / 2, rows: rows as 0 | 1 };
    }),
  );
  deco.fields.push({ x0: GORGE - 7.5, y0: GORGE - 5.5, x1: GORGE - 2.5, y1: GORGE - 1.5, rows: 0 }, { x0: GORGE - 5.5, y0: GORGE - 7.5, x1: GORGE - 1.5, y1: GORGE - 2.5, rows: 1 });
  deco.power = [SINAI_POWER.map(([e, s]) => sp(e, s))];
  deco.power.push(...deco.power.map((l) => [...l].reverse().map(mirrorSP)));
  // palms lining the village streets, along the canal's west bank (render only) and at the back of the beaches
  deco.trees.push(...townPalms(g, [roads[0]], structures, blocked).filter((p) => townK(p.x, p.y) > 0.3));
  deco.trees.push(...canalPalms(g, barrier, NS));
  deco.trees.push(...beachPalms(sea, g, NS));
  deco.sea = sea;
  deco.canyons = canyons.map((c) => ({ pts: c.pts.map((p) => ({ x: p.x - 0.5, y: p.y - 0.5 })), hw: CANYON_HW }));

  const offshore = new Uint8Array(W * H);
  if (sea.isle) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (isleAt(sea.isle, x + 0.5, y + 0.5) < 0) offshore[y * W + x] = 1;

  const tech = (at: [number, number][]) =>
    at.map(([e, s]) => {
      const p = sp(e, s);
      return [Math.round(p.x - 1), Math.round(p.y - 1)] as [number, number];
    });
  return assemble({ name: 'Wadi Al-Rimal', id: 'desert', biome: 'desert' }, g, {
    offshore,
    oreMines: mines(oreFields),
    starts,
    oils,
    bridges: [],
    roads,
    structures,
    blocked,
    techSites: [
      { def: 'tech_hospital', at: tech([[-48, 97], [-52, 101], [-44, 101], [-54, 89]]) },
      { def: 'tech_comms', at: tech([[-22, 80], [-26, 76], [-18, 92], [-28, 90]]) },
      { def: 'tech_airport', at: tech([[-74, 124], [-78, 118], [-70, 130], [-82, 112]]) },
      { def: 'tech_hospital', at: tech([[-16, 158], [-20, 154], [-12, 160], [-18, 162]]) },
    ],
    // the AI's crossings: the two corridors at the gulfs' heads (every ground route takes both; a picket and the
    // ambushes hold the own one, ai.ts manageChoke)
    lanes: [si(-37.5, 84), si(37.5, 84)],
    deco,
  });
}

/** Half width of the canyon's sand floor (tiles; the renderer's measure of it: MapDeco.canyons). */
const CANYON_HW = 2.2;
/**
 * How far beyond CANYON_HW the floor stays level before the walls rise (SL1): every tile of the sand floor is level
 * ground (sim/slope.ts), some four tiles across even in the bends, room for groups to pass each other.
 */
const CANYON_FLAT = 0.75;
/** Half width of the massif's foot (tiles; it wanders by +-16%). */
const MASSIF_FOOT = 12.5;
/** The massif's cross profile (SL1): the flank's foot (MASSIF_U2) and top (MASSIF_U1) as fractions of the foot distance, the profile's height there. */
const MASSIF_U1 = 0.3;
const MASSIF_U2 = 0.46;
const MASSIF_P1 = 0.88;
const MASSIF_P2 = 0.26;
/** The spine's crest heights are lifted this much (SL1: a higher mountain, steep flanks). */
const MASSIF_LIFT = 1.25;
/**
 * Height fraction of a mountain at u = distance from the spine / foot distance (1 at the spine, 0 from the foot
 * out): a talus apron easing up from the foot to MASSIF_P2, a steep, even flank to MASSIF_P1, a rounded crest.
 */
function massifProfile(u: number): number {
  if (u >= 1) return 0;
  if (u > MASSIF_U2) {
    const t = (1 - u) / (1 - MASSIF_U2);
    return MASSIF_P2 * t * t * (2 - t);
  }
  if (u > MASSIF_U1) return MASSIF_P2 + ((MASSIF_P1 - MASSIF_P2) * (MASSIF_U2 - u)) / (MASSIF_U2 - MASSIF_U1);
  const t = u / MASSIF_U1;
  return MASSIF_P1 + (1 - MASSIF_P1) * (1 - t * t);
}

/** Roads (E, S polylines, player 0's; mirrored): kind by SINAI_ROAD_KIND (0 highway, 1 coast road, 2 country road). */
const SINAI_ROADS: [number, number][][] = [
  // the highway from the base through the village and the corridor, across north Sinai to the axis
  [
    [-68, 100],
    [-58, 95],
    [-48, 87.5],
    [-40, 84],
    [-32, 84],
    [-22, 85.5],
    [-10, 86.5],
    [0, 86.5],
  ],
  // the coast road down the Sinai's gulf shore to Sharm (inland of the resort and the canyon's highland)
  [
    [-29, 85],
    [-27, 94],
    [-24, 104],
    [-23, 112],
    [-28, 126],
    [-26, 138],
    [-21.5, 152],
    [-16, 166],
    [-9, 177],
    [0, 179],
  ],
  // the Egyptian road north along the canal to the coast
  [
    [-48, 87.5],
    [-46, 76],
    [-42, 64],
    [-38, 52],
  ],
];
const SINAI_ROAD_KIND = [0, 1, 2];
/** Dirt tracks (E, S polylines; mirrored). */
const SINAI_TRACKS: [number, number][][] = [
  // along the Mediterranean dunes
  [
    [-30, 60],
    [-20, 56],
    [-8, 52],
    [0, 51],
  ],
  // from the highway south over El Tih to the canyon's upper mouth and on to the massif's foot
  [
    [-10, 86.5],
    [-12, 98],
    [-13, 108],
  ],
  // to the Egyptian oasis and the hamlet in the south
  [
    [-52, 90.5],
    [-64, 110],
    [-68, 124],
    [-62, 134],
  ],
];
/** Irrigated plots (centre E, S, size w x h in tiles, row direction). */
const SINAI_FIELDS: [number, number, number, number, number][] = [
  [-55, 73, 5, 3.5, 0],
  [-45, 79, 4, 3, 1],
  [-25, 112, 4, 3, 0],
];
/** Power line (E, S; mirrored). */
const SINAI_POWER: [number, number][] = [
  [-74, 94],
  [-52, 80],
  [-42, 75],
  [-28, 75],
  [-12, 76],
  [0, 76],
];

/**
 * Mountain tracks graded into the massif (SL1; via points in screen positions, player 0's; mirrored): the
 * summit track up the north-west flank to the plateau under the summit, a steep footpath (soldiers only) and the
 * canyon's upper mouth.
 */
const SINAI_RAMPS: Ramp[] = [
  {
    pts: [
      { x: -23.2, y: 133.6 },
      { x: -22.2, y: 136.4 },
      { x: -20.5, y: 139.6 },
      { x: -17.6, y: 140.6 },
      { x: -19.0, y: 143.4 },
      { x: -16.2, y: 145.6 },
      { x: -13.6, y: 146.4 },
    ],
    hw: 1.5,
    track: true,
    noCars: true,
  },

  {
    // (a steep pitch up the north face: soldiers only)
    pts: [
      { x: -14, y: 135.5 },
      { x: -13.9, y: 139, f: 0.28 },
      { x: -13.8, y: 142.5, f: 0.82 },
      { x: -13.6, y: 145.8 },
    ],
    hw: 0.6,
    track: true,
    noCars: true,
  },
];

/** A row of houses (centres E, S; kind, facing; screen positions round to tiles). */
type HouseSpec = [number, number, StructureKind, number, Structure['look']?];
function houseRow(_e: number, _s: number, list: HouseSpec[]): Structure[] {
  return list.map(([e, s, kind, rot, look]) => {
    const w = kind === StructureKind.Courtyard ? (rot % 2 ? 2 : 3) : 2;
    const h = kind === StructureKind.Courtyard ? (rot % 2 ? 3 : 2) : 2;
    const p = sp(e, s);
    return { kind, x: Math.round(p.x - w / 2), y: Math.round(p.y - h / 2), w, h, rot, ...(look ? { look } : {}) };
  });
}

/**
 * The village at the west crossing (player 0's; the Arabian one at the east crossing is its mirror): houses lining
 * the highway on both sides through the corridor between the Great Bitter Lake and the gulf's head, the mosque on
 * the Egyptian side, shop-houses along the road; Sharm's town on the southern tip (on the axis: each house and its
 * mirror; the mosque straddles the axis).
 */
export function sinaiVillage(): Structure[] {
  const M = StructureKind.MudHouse;
  const Q = StructureKind.Courtyard;
  // (candidates in rows along the highway: placeStructures keeps those on open, gentle ground off the roads, the
  // lake and the gulf, the first one wins where they would overlap)
  const village: HouseSpec[] = [[-42.5, 79.2, Q, 2, 'mosque']];
  const rows: [number, number, number][] = [
    // screen south, facing (north of the highway the houses face it: rot 1 / 2 alternate; south of it 0 / 3)
    [80.4, 1, 1],
    [88.0, 0, 1],
    [77.2, 1, 0],
    [91.2, 0, 0],
    [74.2, 1, 0],
  ];
  for (const [rs, north, street] of rows)
    for (let e = -50, k = 0; e <= -22; e += 3.3, k++) {
      const rot = north ? (k % 2 ? 1 : 2) : k % 2 ? 0 : 3;
      village.push([e + (rs > 85 ? 1.1 : 0), rs, M, rot, street && k % 2 === 0 ? 'shop' : undefined]);
    }
  // Sharm el-Sheikh's town behind the resort on the tip: rows either side of the axis, the mosque on it
  const sharm: HouseSpec[] = [];
  for (const [rs, rot] of [
    [181.6, 2],
    [185.0, 1],
  ] as [number, number][])
    for (let e = -3.6, k = 0; e >= -12; e -= 3.3, k++) sharm.push([e - (rot === 1 ? 1.2 : 0), rs, M, rot, k === 0 ? 'shop' : undefined]);
  const out = houseRow(0, 0, [...village, ...sharm]);
  // (the mosque: a 3 x 3 courtyard on the axis, its own mirror image)
  const mq = sp(0, 183.2);
  out.splice(1, 0, { kind: Q, x: Math.round(mq.x - 1.5), y: Math.round(mq.x - 1.5), w: 3, h: 3, rot: 0, look: 'mosque' });
  return out;
}
/** Bedouin hamlets (anchor E, S unused; their houses). */
const SINAI_HAMLETS: [number, number, HouseSpec[]][] = [
  [
    -14,
    100,
    [
      [-15, 99, StructureKind.MudHouse, 1],
      [-11.5, 101.5, StructureKind.MudHouse, 2],
    ],
  ],
  [
    -66,
    132,
    [
      [-68, 131, StructureKind.MudHouse, 1],
      [-64.5, 134, StructureKind.MudHouse, 0],
      [-70, 135, StructureKind.MudHouse, 3],
    ],
  ],
  [
    -12,
    126,
    [[-11, 126, StructureKind.MudHouse, 2]],
  ],
];

/**
 * A track or footpath graded into a mountainside (SL1, sim/slope.ts): via points in tile index space (player 0's
 * half; mirrored), the ground along it evened out to a steady grade between the points whose height is known (the
 * ends and any marked `nat`: the natural ground there) and level across, cut into the slope on the uphill side and
 * built up on the other, easing back into the natural ground over SHOULDER tiles either side. Vehicle tracks keep a
 * gentle grade (well under slope.ts's vehicle limit); footpaths are narrow and steeper than vehicles take.
 */
interface Ramp {
  /** nat: the natural ground's height here is kept; f: the fraction of the whole rise reached here (a footpath's steep pitch). */
  pts: (Point & { nat?: boolean; f?: number })[];
  /** Half width of the level bed (tiles). */
  hw: number;
  /** Drawn as a worn track (render/biomelayout.ts). */
  track?: boolean;
  /** Only the ground is graded: the tiles keep their kind (no gravel bed, crags kept). */
  gradeOnly?: boolean;
  /** No civilian traffic on it (a footpath, a dead end up a mountain: MapDeco.trackNoCars). */
  noCars?: boolean;
}
/** Width (tiles) over which a graded track's bed eases back into the natural slope beside it. */
const RAMP_SHOULDER = 1.4;

/** The graded tracks of a map (both halves): heights along them, the tiles they cover, their centre lines. */
function rampSet(W: number, H: number, src: Ramp[], natural: (x: number, y: number) => number) {
  type Line = { pts: Point[]; at: number[]; hs: number[]; hw: number; bed: boolean };
  const lines: Line[] = [];
  void W;
  void H;
  for (const r of src) {
    let len = 0;
    const at = r.pts.map((p, i) => (i ? (len += Math.hypot(p.x - r.pts[i - 1].x, p.y - r.pts[i - 1].y)) : 0));
    // known heights: the ends and the marked points; the rest on a steady grade between them (by arc length)
    const h0 = natural(r.pts[0].x, r.pts[0].y);
    const h1 = natural(r.pts[r.pts.length - 1].x, r.pts[r.pts.length - 1].y);
    const known = r.pts.map((p, i) => (i === 0 ? h0 : i === r.pts.length - 1 ? h1 : p.f !== undefined ? h0 + (h1 - h0) * p.f : p.nat ? natural(p.x, p.y) : NaN));
    const hs = known.map((h, i) => {
      if (!Number.isNaN(h)) return h;
      let a = i - 1;
      while (Number.isNaN(known[a])) a--;
      let b = i + 1;
      while (Number.isNaN(known[b])) b++;
      return known[a] + ((known[b] - known[a]) * (at[i] - at[a])) / (at[b] - at[a]);
    });
    const bed = !r.gradeOnly;
    lines.push({ pts: r.pts, at, hs, hw: r.hw, bed });
    // the mirror image takes the same heights (the halves stay exact twins)
    lines.push({ pts: r.pts.map(mirror), at, hs, hw: r.hw, bed });
  }
  /** Nearest line within reach: distance from its centre line and its grade height there. */
  const nearest = (x: number, y: number, reach: number, beds = false) => {
    let best: { d: number; h: number; hw: number } | null = null;
    for (const l of lines) {
      if (beds && !l.bed) continue;
      for (let k = 0; k < l.pts.length - 1; k++) {
        const p = l.pts[k];
        const q = l.pts[k + 1];
        if (Math.min(p.x, q.x) - reach > x || Math.max(p.x, q.x) + reach < x || Math.min(p.y, q.y) - reach > y || Math.max(p.y, q.y) + reach < y) continue;
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const l2 = dx * dx + dy * dy;
        const t = Math.max(0, Math.min(1, ((x - p.x) * dx + (y - p.y) * dy) / l2));
        const d = Math.hypot(x - p.x - dx * t, y - p.y - dy * t);
        if (d > reach || (best && d >= best.d)) continue;
        best = { d, h: l.hs[k] + (l.hs[k + 1] - l.hs[k]) * t, hw: l.hw };
      }
    }
    return best;
  };
  return {
    /** Height of vertex (fx, fy) (tile index space) with the tracks graded in, given the natural height there. */
    grade(fx: number, fy: number, h: number): number {
      const n = nearest(fx, fy, 4);
      if (!n || n.d >= n.hw + RAMP_SHOULDER) return h;
      return h + (n.h - h) * (1 - smoothstep(n.hw, n.hw + RAMP_SHOULDER, n.d));
    },
    /** Does a track's bed cover tile (x, y)? (Tile index space, as the via points: a tile's centre is at (x, y).) */
    onTrack(x: number, y: number): boolean {
      const n = nearest(x, y, 4, true);
      return !!n && n.d < n.hw;
    },
    /** Is tile (x, y) within r tiles of a track's bed? */
    near(x: number, y: number, r: number): boolean {
      const n = nearest(x, y, 4 + r);
      return !!n && n.d < n.hw + r;
    },
    /** Centre lines of the drawn tracks (both halves)... */
    lines: src.flatMap((r) => (!r.track ? [] : [r.pts.map((p) => ({ x: p.x, y: p.y })), r.pts.map(mirror).reverse()])),
    /** ...and how much wider than a plain dirt track each one's worn band is drawn (MapDeco.trackBeds). */
    beds: src.flatMap((r) => (!r.track ? [] : [Math.max(0, r.hw - 0.45), Math.max(0, r.hw - 0.45)])),
    noCars: src.flatMap((r) => (!r.track ? [] : [!!r.noCars, !!r.noCars])),
  };
}

/** Render-only palms along the town streets: both pavements, every ~2.6 tiles, clear of houses and junctions. */
function townPalms(g: Grids, streets: Point[][], structures: Structure[], blocked: Uint8Array) {
  const out: { x: number; y: number; kind: number }[] = [];
  const free = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const tx = Math.floor(x + dx * 0.3);
        const ty = Math.floor(y + dy * 0.3);
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
        const i = ty * W + tx;
        if (blocked[i] || g.tiles[i] === Tile.Water || g.tiles[i] === Tile.Rock) return false;
      }
    return true;
  };
  void structures;
  for (const st of streets) {
    for (let k = 0; k < st.length - 1; k++) {
      const a = st[k];
      const b = st[k + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const nx = -(b.y - a.y) / len;
      const ny = (b.x - a.x) / len;
      for (let t = 1.6; t < len - 1.2; t += 2.6) {
        for (const side of [-1, 1]) {
          const x = a.x + 0.5 + ((b.x - a.x) * t) / len + nx * side * 1.05;
          const y = a.y + 0.5 + ((b.y - a.y) * t) / len + ny * side * 1.05;
          if (free(x, y)) out.push({ x, y, kind: 2 });
        }
      }
    }
  }
  return out;
}

/** Render-only date palms along the canal's west bank (the Egyptian side), in clumps, clear of its water. */
function canalPalms(g: Grids, barrier: Uint8Array, ns: number) {
  const out: { x: number; y: number; kind: number }[] = [];
  for (let k = 0; k < CANAL.length - 1; k++) {
    const [e0, s0] = CANAL[k];
    const [e1, s1] = CANAL[k + 1];
    const len = Math.hypot(e1 - e0, s1 - s0);
    for (let t = 0.6; t < len; t += 1.25) {
      const j = hash2(k * 97 + Math.round(t * 10), 3, ns + 81);
      if (j < 0.3) continue;
      const e = e0 + ((e1 - e0) * t) / len - CANAL_HW - 1.1 - j * 1.6;
      const s = s0 + ((s1 - s0) * t) / len;
      const p = sp(e, s);
      const tx = Math.floor(p.x);
      const ty = Math.floor(p.y);
      if (tx < 1 || ty < 1 || tx >= W - 1 || ty >= H - 1) continue;
      const i = ty * W + tx;
      if (barrier[i] || g.tiles[i] === Tile.Water || g.tiles[i] === Tile.Rock || g.trees[i]) continue;
      out.push({ x: p.x, y: p.y, kind: 2 });
    }
  }
  return out;
}

/** Reef shelf width (tiles from the waterline) and the open sea's floor. */
const REEF = 3.6;
const SEA_FLOOR = -1.46;

const seaF = { u: 0, v: 0 };
/** Inside a resort compound (continuous point)? */
function inResort(sea: SeaDeco, x: number, y: number) {
  for (const st of sea.sites) {
    const f = frameUV(st, x, y, seaF);
    const r = st.resort;
    if (f.u > r.u0 && f.u < r.u1 && f.v > r.v0 && f.v < r.v1) return true;
  }
  return false;
}
/** Beach, sea or resort at a point (no trees, no clutter)? */
function coastBusy(sea: SeaDeco, x: number, y: number) {
  if (seaDist(sea, x, y) > -4.6) return true;
  for (const st of sea.sites) {
    const f = frameUV(st, x, y, seaF);
    const r = st.resort;
    if (f.u > r.u0 - 1 && f.u < r.u1 + 1 && f.v > r.v0 - 1 && f.v < r.v1 + 1) return true;
  }
  return false;
}
/** Ground height by the sea at vertex (vx, vy): the reef shelf and the deep water, the beach, the resorts' terraces, the island. */
function coastHeight(sea: SeaDeco, vx: number, vy: number, h: number, ns: number) {
  const ve = seaDist(sea, vx, vy);
  if (ve > -10) {
    if (ve > 0) {
      // the reef flat, shelving gently, then the drop-off into the deep
      const shelf = WATER_LEVEL - 0.07 - 0.065 * Math.min(ve, REEF) + ((hash2(vx, vy, ns + 61) + hash2(vy, vx, ns + 61)) / 2 - 0.5) * 0.03;
      h = shelf + (SEA_FLOOR - shelf) * smoothstep(REEF, REEF + 2.2, ve);
    } else {
      // the beach rises from the waterline into the dunes
      const beach = WATER_LEVEL + 0.03 - ve * 0.075;
      h = h + (beach - h) * smoothstep(-7.5, -4.2, ve);
    }
  }
  for (const st of sea.sites) {
    const f = frameUV(st, vx, vy, seaF);
    const r = st.resort;
    const k = (1 - smoothstep(0.2, 1.2, r.u0 - f.u)) * (1 - smoothstep(0.2, 1.2, f.u - r.u1)) * (1 - smoothstep(0.2, 1.2, r.v0 - f.v)) * (1 - smoothstep(0.2, 1.2, f.v - r.v1));
    if (k > 0) h = h + (0.17 - h) * k;
  }
  if (sea.isle) {
    const d = isleAt(sea.isle, vx, vy);
    if (d < 4.5) {
      const n = (hash2(vx, vy, ns + 65) - 0.5) * 0.08;
      // the island: a low sandy rim rising to the rocky knoll; round it the reef flat, then the drop-off
      const ih =
        d < 0
          ? WATER_LEVEL + 0.06 + Math.min(-d, 1.2) * 0.17 + smoothstep(-ISLE_KNOLL - 0.35, -ISLE_KNOLL + 0.5, -d) * 0.2 + n * smoothstep(0.4, 1.2, -d)
          : WATER_LEVEL + 0.06 - 0.25 * smoothstep(0, 0.7, d) - 0.05 * Math.min(d, 1.6) + n * 0.2;
      h = Math.max(h, ih + (SEA_FLOOR - ih) * smoothstep(1.7, 3.8, d));
    }
  }
  return h;
}
/** Tile type by the sea at a tile centre. */
function coastTile(sea: SeaDeco, x: number, y: number, t: Tile): Tile {
  if (sea.isle) {
    const d = isleAt(sea.isle, x, y);
    if (d < 0) return d < ISLE_KNOLL ? Tile.Rock : d < -0.6 ? Tile.Dirt : Tile.Sand;
  }
  const ve = seaDist(sea, x, y);
  if (ve > 0) return Tile.Water;
  if (inResort(sea, x, y)) return Tile.Dirt;
  if (ve > -4.4) return Tile.Sand;
  return t;
}
/** Palms along the back of the resort beaches and round the compounds (render only; kind 2). */
function beachPalms(sea: SeaDeco, g: Grids, ns: number): { x: number; y: number; kind: number }[] {
  const out: { x: number; y: number; kind: number }[] = [];
  sea.sites.forEach((st, b) => {
    const add = (u: number, v: number) => {
      const p = framePoint(st, u, v);
      const tx = Math.floor(p.x);
      const ty = Math.floor(p.y);
      if (tx < 1 || ty < 1 || tx >= W - 1 || ty >= H - 1) return;
      const i = ty * W + tx;
      if (g.tiles[i] === Tile.Water || g.tiles[i] === Tile.Rock || g.trees[i]) return;
      out.push({ x: p.x, y: p.y, kind: 2 });
    };
    // a ragged row at the back of the bathing beach
    for (let u = st.beach[0] + 0.6; u < st.beach[1] - 0.3; u += 1.15) {
      const j = hash2(Math.round(u * 10), 3 + b, ns + 71);
      if (j < 0.3) continue;
      add(u + (j - 0.5) * 0.5, -3.7 - hash2(Math.round(u * 10), 5 + b, ns + 71) * 0.9);
    }
    // the resort's palm-lined edges
    const r = st.resort;
    for (let u = r.u0 + 0.4; u < r.u1; u += 1.6) add(u, r.v1 + 0.45);
    for (let v = r.v0 + 0.5; v < r.v1; v += 1.7) {
      add(r.u0 - 0.5, v);
      add(r.u1 + 0.5, v);
    }
  });
  return out;
}

// ================================================================== winter

/**
 * "Frozen Pass": snowbound hills and spruce forest either side of a half
 * frozen river. Two bridges and, between them, an ice ford the armour can
 * cross; log-built villages and farmsteads along snow-dusted roads.
 */
export function createWinterMap(seed: number): GameMap {
  mapSize(96);
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
  // spruce / pine forests (1), birch groves near the river (2), single trees. The forest threshold is a
  // quantile of the noise over the open land, so every seed grows about as much forest (~11%)
  const vals: number[] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) if (g.tiles[y * W + x] === Tile.Grass && !reserved(x, y) && river.dist(x, y) >= 4.5) vals.push(symNoise(x, y, 0.075, NS + 31));
  vals.sort((a, b) => a - b);
  const forestT = vals.length ? vals[Math.floor(vals.length * 0.89)] : 0.62;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (g.tiles[i] !== Tile.Grass || reserved(x, y)) continue;
      const rd = river.dist(x, y);
      if (rd < 4.5) continue;
      const n = symNoise(x, y, 0.075, NS + 31);
      const single = symHash(x, y, NS + 3);
      const birch = rd < 9 && symNoise(x, y, 0.12, NS + 37) > 0.55;
      if (n > forestT || single > 0.94) g.trees[i] = birch ? 2 : 1;
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
    oreMines: mines(oreFields),
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
  mapSize(96);
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
  // (in its lot, a tile clear of the street at y = 76)
  const oils = halfOils([{ x: 35, y: 72 }]);
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
    oreMines: mines(oreFields),
    starts,
    oils,
    bridges,
    roads,
    structures,
    blocked,
    techSites: [
      // (in the park's south-west corner, off the street)
      { def: 'tech_hospital', at: [[22, 49], [24, 46], [20, 54], [10, 54], [22, 58]] },
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
