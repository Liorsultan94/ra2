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
  ISLE_KNOLL,
  type SeaDeco,
  type SeaFrame,
  type SeaGrid,
  SEA_GRID_Q,
  type Biome,
  type GameMap,
  type MapDeco,
  type MapId,
  type Point,
  type Structure,
} from './map';
import { Rng, fbm, hash2 } from './rng';
import { SINAI_MASK, SINAI_MASK_H, SINAI_MASK_W } from './sinaimask';

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
/** The halves mirror across the x == y diagonal, not through the centre (GameMap.mirror). */
let TRANS = false;
/** No mirror at all (the Sinai traced from the owner's picture: GameMap.mirror 'none'). */
let NOMIRROR = false;
function mapSize(n: number, trans = false, none = false) {
  W = H = n;
  CX = (n - 1) / 2;
  TRANS = trans;
  NOMIRROR = none;
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

/**
 * Ore / gem fields (same shape rules as Frontline Crossing, symmetric jitter). `local`: the jitter follows each
 * field's own offsets (integer centres), so fields of the same size paint alike wherever they lie (an unmirrored map).
 */
function paintOre(g: Grids, fields: Field[], sandTo: Tile = Tile.Dirt, local = false) {
  for (const f of fields) {
    for (let y = Math.floor(f.y - f.r - 1); y <= f.y + f.r + 1; y++) {
      for (let x = Math.floor(f.x - f.r - 1); x <= f.x + f.r + 1; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        const t = g.tiles[i];
        if (t === Tile.Water || t === Tile.Rock || t === Tile.Bridge) continue;
        const d = Math.hypot(x - f.x, y - f.y);
        if (d < f.r + (local ? hash2(x - f.x, y - f.y, 7) : symHash(x, y, 7)) * 1.2 - 0.6) {
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
  /** An unmirrored map: each structure's twin (the same length as the layout; placed both or neither). */
  pairs?: Structure[];
}

/**
 * Structures from a fixed layout for player 0's half, mirrored for player 1. Each footprint is
 * validated (open flat ground, away from bases, ore, oil and roads, a walkable one tile margin) and a
 * flood fill makes sure it cuts nothing off; failures are skipped.
 */
function placeStructures(g: Grids, layout: Structure[], o: PlaceOpts) {
  // (a transposed footprint swaps its sides; rot r faces (0,-1), (1,0), (0,1), (-1,0) for r = 0..3: mirrored 3 - r)
  // (an unmirrored map without twins: each structure stands on its own)
  const single = NOMIRROR && !o.pairs;
  const all = single ? layout : o.pairs ? [...layout, ...o.pairs] : [
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
    let pair = single || self(all[k], all[k + n]) ? [all[k]] : [all[k], all[k + n]];
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
  return { ...base, w: W, h: H, tiles: g.tiles, heights: g.heights, trees: g.trees, ore: g.ore, oreKind: g.oreKind, ...(TRANS ? { mirror: 'transpose' as const } : NOMIRROR ? { mirror: 'none' as const } : {}), ...more };
}

// ================================================================== desert

/*
 * "Wadi Al-Rimal": the Sinai Peninsula (SN1), its coasts traced from the owner's picture of it (sim/sinaimask.ts, a
 * satellite view, north up): the Mediterranean along the top, the long Gulf of Suez slanting down the west and the
 * narrower Gulf of Aqaba slanting down the east, both opening into the Red Sea round the southern tip (Sharm
 * el-Sheikh). Map north is the top of the screen (the tile map's north-west corner). Player 0 (blue) starts on the
 * Egyptian mainland west of the gulf of Suez's head, player 1 (red) on the Arabian mainland east of the lower Gulf of
 * Aqaba, both where the owner marked them. There are no bridges: armies cross over land at the head of each gulf -
 * on the west the isthmus between the Mediterranean and the Gulf of Suez, on the east between the Gulf of Aqaba and
 * the granite ridge running north from it to the sea - each with its village on the Sinai side.
 *
 * Fairness: the sides are not mirror images (the real coasts are not). What each player holds is kept equal by hand:
 * the ground round each base is laid out once in the base's own frame and turned half round for the other (buildings
 * turn half round too: turn.ts), and everything else comes in pairs - one nearer each base by road (ore fields of the
 * same size, oil, tech sites, villages and towns of the same houses placed both or neither). bench/sinai-fair.test.ts
 * prints the numbers. Positions below are pixels of the picture (u east, v south; 250 x 270) unless stated.
 */

/** The Sinai map's size (tiles). */
export const SINAI_N = 176;
const R2 = Math.SQRT2;
/** Tiles per pixel of the owner's picture, and the picture pixel at the map's centre. */
const PK = 0.48;
const PU = 125;
const PV = 135;
/** Screen south (tiles from the top corner) of the map's centre. */
const SC = (SINAI_N / 2) * R2;
/** Continuous map point of screen position (e east, s south of the map's top corner; tiles). */
const scr = (e: number, s: number): Point => ({ x: (s + e) / R2, y: (s - e) / R2 });
/** Continuous map point of picture pixel (u, v). */
const pp = (u: number, v: number): Point => scr((u - PU) * PK, SC + (v - PV) * PK);
/** Continuous map point of a pixel of the owner's picture (the render's landmarks use it). */
export const sinaiPoint = (u: number, v: number): Point => pp(u, v);
/** Tile-index point (a tile's centre at its index) of a continuous point. */
const ti = (p: Point): Point => ({ x: p.x - 0.5, y: p.y - 0.5 });
/** Tile-index point of picture pixel (u, v). */
const pi = (u: number, v: number): Point => ti(pp(u, v));
/** Screen east / south of continuous map point (x, y). */
const scrE = (x: number, y: number) => (x - y) / R2;
const scrS = (x: number, y: number) => (x + y) / R2;
/** Picture pixel of continuous map point (x, y). */
const toPx = (x: number, y: number) => ({ u: PU + scrE(x, y) / PK, v: PV + (scrS(x, y) - SC) / PK });
/** The point de east, ds south (screen tiles) of continuous point p. */
const offs = (p: Point, de: number, ds: number): Point => ({ x: p.x + (ds + de) / R2, y: p.y + (ds - de) / R2 });

/** The owner's marks: blue on the Egyptian mainland, red on the Arabian. */
const START_PX: [number, number][] = [
  [11, 67],
  [214, 183],
];
const BASES = START_PX.map(([u, v]) => pp(u, v));
/**
 * The ground round a base in that base's frame (screen tiles from it; player 0's, turned half round for player 1:
 * the Mediterranean north of blue's base is the Red Sea south of red's, the Gulf of Suez east of it the Gulf of
 * Aqaba west of red's).
 */
const own = (side: number, de: number, ds: number): Point => (side === 0 ? offs(BASES[0], de, ds) : offs(BASES[1], -de, -ds));

/**
 * The old 160 x 160 layout's interior of the Sinai (the St Catherine massif, its graded tracks, the coloured canyon
 * and its highland, the oasis gorge) keeps its shape: screen positions of that layout (e, s), moved OLD_UP tiles up
 * the diagonal into the traced peninsula.
 */
export const SINAI_OLD_UP = 10;
const OLD_UP = SINAI_OLD_UP;
const oldAt = (e: number, s: number): Point => scr(e, s - OLD_UP * R2);

/** The open seas past the picture (sim/map.ts openSeaDist): the coasts at its left and right edges. */
const MED_OFF = (PV - 50) * PK;
const RED_OFF = (200 - PV) * PK;

/** The granite ridge from the Mediterranean down to the head of the Gulf of Aqaba (east; impassable): capsule. */
const RIDGE_PX: [number, number, number, number] = [234, 6, 241, 68];
const RIDGE_HW = 3.2;
/** The AI's crossings: the isthmus at the head of the Gulf of Suez, the gap between the ridge and the Gulf of Aqaba. */
const CROSS_PX: [number, number][] = [
  [42, 61],
  [240, 79],
];

/** Ore fields (u, v, radius, kind 1 ore / 2 gems): pairs, the first nearer blue by road, the second nearer red. */
const SINAI_ORE_PAIRS: [[number, number, number, number], [number, number, number, number]][] = [
  // (the fields in the Sinai nearest blue's crossing; red's twins in the north-east corner and on its mainland)
  [
    [76, 80, 3.0, 1],
    [268, 124, 3.0, 1],
  ],
  [
    [70, 146, 3.0, 1],
    [268, 100, 3.0, 1],
  ],
  [
    [112, 108, 2.4, 2],
    [300, 140, 2.4, 2],
  ],
];
/** Each base's own fields (screen tiles in its frame: own()). */
const BASE_ORE: [number, number, number, number][] = [
  // (the home fields due west and south of blue's base, due east and north of red's: the refinery docks face +y for
  // blue and -y for red, turn.ts, so they relate to them alike)
  [-17, 0, 3.6, 1],
  [-6, 15, 3.2, 1],
  [-34, 10, 3.0, 1],
  [-30, 22, 2.4, 2],
];
/** Oil derricks (centres): each base's own (screen tiles in its frame) and pairs in the Sinai. */
const BASE_OIL: [number, number][] = [
  [-9, 9],
  [-22, 4],
];
const SINAI_OIL_PAIRS: [[number, number], [number, number]][] = [
  [
    [84, 86],
    [262, 82],
  ],
  [
    [92, 98],
    [240, 148],
  ],
];
/** Tech sites: candidate spots for blue and, candidate for candidate, red's (base frame, or Sinai pixel pairs). */
const BASE_TECH: { def: string; at: [number, number][] }[] = [
  { def: 'tech_hospital', at: [[-8, 18], [-10, 20], [-6, 20], [-12, 16]] },
  { def: 'tech_airport', at: [[-36, 30], [-38, 30], [-34, 32], [-38, 28]] },
];
const SINAI_TECH: { def: string; at: [number, number][]; at2: [number, number][] }[] = [
  { def: 'tech_comms', at: [[92, 74], [96, 76], [88, 72], [98, 72], [94, 80], [90, 68]], at2: [[248, 142], [246, 146], [250, 138], [244, 140], [252, 146], [242, 136]] },
  { def: 'tech_hospital', at: [[104, 86], [108, 88], [100, 84], [110, 84], [106, 92], [102, 80]], at2: [[190, 70], [184, 74], [196, 64], [178, 80], [200, 58], [172, 70]] },
];

/** The massif of south Sinai (St Catherine): crest spines of the old layout (e, s, height), each with its mirror. */
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
  ],
];
/** The mountains along the gulfs' outer coasts: Egypt's Galala (south-west) and Arabia's Midian (east; pixels). */
const SINAI_COAST_MTS: { u: number; v: number; h: number }[][] = [
  [
    { u: -12, v: 150, h: 1.2 },
    { u: -20, v: 175, h: 3.1 },
    { u: -14, v: 200, h: 2.6 },
    { u: -4, v: 225, h: 1.0 },
  ],
  [
    { u: 318, v: 92, h: 1.0 },
    { u: 328, v: 116, h: 2.8 },
    { u: 326, v: 142, h: 3.1 },
  ],
];
/** The sandstone highland the coloured canyon cuts through (old layout: the eastern one). */
const SINAI_HIGHLAND: { e: number; s: number; h: number }[][] = [
  [
    { e: 16.6, s: 119, h: 3.1 },
    { e: 19.6, s: 124.6, h: 3.4 },
  ],
];
/** The coloured canyon's floor centre line (old layout, the eastern one: inland of Nuweiba). */
const SINAI_CANYON: [number, number][] = [
  [13.2, 111],
  [15.2, 115],
  [16, 118.8],
  [18.2, 121.4],
  [19, 124.6],
  [21.3, 127],
  [22.6, 131],
];
/** Sandstone mesas and buttes of El Tih (impassable, flat-topped): capsule ends and radius (pixels; radius tiles). */
const SINAI_MESAS: [number, number, number, number, number][] = [
  [108, 74, 111, 82, 2.0],
  [139, 74, 142, 82, 2.0],
];
/**
 * A rocky headland on the Mediterranean shore north-west of blue's base (base frame: capsule ends, radius): the Red
 * Sea and the Gulf of Aqaba come closer round red's base than the Mediterranean and the Gulf of Suez round blue's, so
 * this keeps the open ground round the two bases alike (bench/sinai-fair.test.ts: build space).
 */
const BLUE_HEADLAND: [number, number, number, number, number] = [-12, -3.5, -1, -5, 2.6];
/** Oases and springs (pixels, radius tiles) in the Sinai; each base has its own (base frame). */
const SINAI_OASES: [number, number, number][] = [
  [82, 100, 1.9],
  [186, 96, 1.9],
];
const BASE_OASIS: [number, number, number] = [-14, 26, 1.8];
/**
 * The oasis gorge in the El Tih plateau (Ain Khudra; render/seaside.ts buildOasisGorge): a lake under two sandstone
 * escarpments with a spring pool below each, irrigated plots and a side wadi; tile-index offsets from GORGE (the
 * lake's tile on the map's diagonal; the pools and ridges mirror each other across it).
 */
export const GORGE = 92 - OLD_UP;
const GORGE_LAKE = 3.3;
const GORGE_POOL: [number, number, number] = [-8, 6, 1.8];
const GORGE_RIDGE: [number, number, number, number, number] = [-14, 3, -7, 9, 2.3];
const GORGE_WADI: [number, number][] = [
  [-17, 14],
  [-14, 8.5],
  [-10, 4],
];
/** Wadi el-Arish from the gorge north to the Mediterranean, and its tributaries (pixels). */
const SINAI_WADIS: [number, number][][] = [
  [
    [125, 106],
    [123, 92],
    [126, 72],
    [124, 50],
    [125, 30],
  ],
  [
    [100, 104],
    [112, 97],
    [122, 92],
  ],
  [
    [150, 104],
    [138, 97],
    [127, 92],
  ],
];
/** Sharm el-Sheikh (Naama Bay) on the south-east coast of the tip, Nuweiba's town on the Aqaba coast (pixels). */
const SHARM_SITE_PX: [number, number] = [141, 214];
const SHARM_TOWN_PX: [number, number] = [124, 200];
const NUWEIBA_TOWN_PX: [number, number] = [186, 128];

/** The gulfs and seas (render and sim share it: sim/map.ts seaDist): the traced coasts and the places by the sea. */
function sinaiSea(): SeaDeco {
  const c = SINAI_N / 2;
  const sea: SeaDeco = { c, top: MED_OFF, bottom: RED_OFF, gulfs: [], sites: [], grid: sinaiGrid() };
  /** A frame on the coast nearest pixel (u, v): origin on the waterline, +v seaward; `back` tiles inland of it. */
  const shoreAt = (u: number, v: number, back = 0): SeaFrame => {
    const p = pp(u, v);
    let nx = 1;
    let ny = 0;
    for (let k = 0; k < 40; k++) {
      const d = seaDist(sea, p.x, p.y);
      const gx = seaDist(sea, p.x + 0.25, p.y) - seaDist(sea, p.x - 0.25, p.y);
      const gy = seaDist(sea, p.x, p.y + 0.25) - seaDist(sea, p.x, p.y - 0.25);
      const gl = Math.hypot(gx, gy) || 1;
      nx = gx / gl;
      ny = gy / gl;
      p.x -= nx * d * 0.8;
      p.y -= ny * d * 0.8;
      if (Math.abs(d) < 0.01) break;
    }
    return { x: p.x - nx * back, y: p.y - ny * back, ang: Math.atan2(nx, -ny) };
  };
  // a resort on the Sinai's Gulf of Suez coast (Ras Sudr) and one on its Gulf of Aqaba coast (north of Nuweiba,
  // clear of the massif's flank)
  sea.sites.push({ ...shoreAt(47, 104, 0.3), resort: { u0: -6, u1: 5, v0: -11, v1: -4.8 }, beach: [-11, 9], look: 1 });
  sea.sites.push({ ...shoreAt(212, 104, 0.3), resort: { u0: -5, u1: 6, v0: -11, v1: -4.8 }, beach: [-9, 11], look: 2 });
  // Sharm el-Sheikh / Naama Bay on the tip, facing the Strait of Tiran
  sea.sites.push({ ...shoreAt(...SHARM_SITE_PX), resort: { u0: -6, u1: 6, v0: -11.2, v1: -4.8 }, beach: [-10, 10], look: 0 });
  // Tiran with its lighthouse in the strait at the mouth of the Gulf of Aqaba (u along the strait)
  const ti0 = pp(170, 210);
  const a = pp(238, 90);
  const b = pp(165, 205);
  sea.isle = { x: ti0.x, y: ti0.y, ang: Math.atan2(b.y - a.y, b.x - a.x), ru: 2.7, rv: 2.05 };
  // the Blue Hole off the Sinai's Aqaba coast north of Dahab
  sea.hole = shoreAt(184, 150, -0.2);
  return sea;
}

/** The picture's water mask (sim/sinaimask.ts) decoded: 1 = water, row-major. */
function sinaiMask(): Uint8Array {
  const m = new Uint8Array(SINAI_MASK_W * SINAI_MASK_H);
  SINAI_MASK.split(';').forEach((row, y) => {
    if (!row) return;
    const nums = row.split(',').map(Number);
    for (let k = 0; k + 1 < nums.length; k += 2) m.fill(1, y * SINAI_MASK_W + nums[k], y * SINAI_MASK_W + nums[k] + nums[k + 1]);
  });
  return m;
}

/** Squared Euclidean distance transform along one line (Felzenszwalb & Huttenlocher), in place. */
function edt1(f: Float32Array, n: number, d: Float32Array, v: Int32Array, z: Float32Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}
/** Squared distance from every cell to the nearest cell where `on` is set (cols x rows). */
function edt2(on: Uint8Array, cols: number, rows: number): Float32Array {
  const INF = 1e12;
  const g = new Float32Array(cols * rows);
  for (let i = 0; i < g.length; i++) g[i] = on[i] ? 0 : INF;
  const n = Math.max(cols, rows);
  const f = new Float32Array(n);
  const d = new Float32Array(n);
  const v = new Int32Array(n);
  const z = new Float32Array(n + 1);
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) f[y] = g[y * cols + x];
    edt1(f, rows, d, v, z);
    for (let y = 0; y < rows; y++) g[y * cols + x] = d[y];
  }
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) f[x] = g[y * cols + x];
    edt1(f, cols, d, v, z);
    for (let x = 0; x < cols; x++) g[y * cols + x] = d[x];
  }
  return g;
}

let sinaiGridCache: SeaGrid | null = null;
/**
 * The traced coasts as a seaward-distance grid (sim/map.ts SeaGrid), two samples per picture pixel: the mask
 * smoothed (so the coast runs between the pixels, not along their steps), carried on past the picture's edges (its
 * edge rows and columns repeated out to the map's corners), then the exact distance to the other side. The same for
 * every seed (built once).
 */
function sinaiGrid(): SeaGrid {
  if (sinaiGridCache) return sinaiGridCache;
  const MW = SINAI_MASK_W;
  const MH = SINAI_MASK_H;
  const mask = sinaiMask();
  // smoothed mask (two passes of a 3 x 3 blur)
  let f = Float32Array.from(mask);
  for (let pass = 0; pass < 2; pass++) {
    const o = new Float32Array(MW * MH);
    const at = (x: number, y: number) => f[Math.max(0, Math.min(MH - 1, y)) * MW + Math.max(0, Math.min(MW - 1, x))];
    for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) o[y * MW + x] = (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1) + 4 * at(x, y) + at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) / 12;
    f = o;
  }
  // the grid reaches past the picture to the map's corners (pixels of padding on every side)
  const reach = (SINAI_N / 2) * R2 / PK;
  const padU = Math.ceil(reach - PU) + 2;
  const padV = Math.ceil(reach - PV) + 2;
  const S = 2;
  const cols = (MW + 2 * padU) * S;
  const rows = (MH + 2 * padV) * S;
  const water = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      // sample (i, j) at picture pixel ((i + 0.5) / S - padU, ...); pixel centres at x + 0.5; past the edges the edge
      // pixels carry on
      const u = Math.max(0, Math.min(MW - 1.0001, (i + 0.5) / S - padU - 0.5));
      const v = Math.max(0, Math.min(MH - 1.0001, (j + 0.5) / S - padV - 0.5));
      const x = Math.floor(u);
      const y = Math.floor(v);
      const tx = u - x;
      const ty = v - y;
      const val = (f[y * MW + x] * (1 - tx) + f[y * MW + x + 1] * tx) * (1 - ty) + (f[(y + 1) * MW + x] * (1 - tx) + f[(y + 1) * MW + x + 1] * tx) * ty;
      water[j * cols + i] = val > 0.5 ? 1 : 0;
    }
  const land = water.map((w) => 1 - w);
  const toLand = edt2(land, cols, rows);
  const toWater = edt2(water, cols, rows);
  const step = PK / S;
  const d = new Int16Array(cols * rows);
  for (let k = 0; k < d.length; k++) d[k] = Math.max(-32767, Math.min(32767, Math.round((water[k] ? Math.sqrt(toLand[k]) - 0.5 : 0.5 - Math.sqrt(toWater[k])) * step * SEA_GRID_Q)));
  sinaiGridCache = { cols, rows, e0: (0.5 / S - padU - PU) * PK, s0: SC + (0.5 / S - padV - PV) * PK, step, d, band: 10 };
  return sinaiGridCache;
}

/** Is continuous point (x, y) on the granite ridge's footprint (east)? */
function ridgeFoot(x: number, y: number) {
  const [u0, v0, u1, v1] = RIDGE_PX;
  const a = pp(u0, v0);
  const b = pp(u1, v1);
  return distToSegment(x, y, a.x, a.y, b.x, b.y) < RIDGE_HW;
}

/** A mountain range given as spine polylines (continuous points, crest heights): its height at a point, how far up (0 foot .. 1 crest), ridge noise. */
function ridgeAt(lines: { x: number; y: number; h: number }[][], foot: number, lift: number, x: number, y: number, ns: number) {
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
/** The old layout's spines, each with its mirror across that layout's axis. */
const oldSpines = (src: { e: number; s: number; h: number }[][], both = true) =>
  src.flatMap((l) => {
    const a = l.map((p) => ({ ...oldAt(p.e, p.s), h: p.h }));
    return both ? [a, l.map((p) => ({ ...oldAt(-p.e, p.s), h: p.h }))] : [a];
  });

export function createDesertMap(seed: number): GameMap {
  mapSize(SINAI_N, false, true);
  const rng = new Rng((seed ^ 0x51a7d00d) >>> 0);
  const NS = 4000 + rng.int(4000);
  const g = newGrids();
  const sea = sinaiSea();
  const starts: Point[] = BASES.map((p) => ({ x: Math.round(p.x - 0.5), y: Math.round(p.y - 0.5) }));
  const startsC = starts.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 }));
  // ore: each base's own fields (its frame) and the Sinai pairs; integer centres, so a pair's fields paint alike
  const field = (p: Point, r: number, kind: number): Field => ({ x: Math.round(p.x - 0.5), y: Math.round(p.y - 0.5), r, kind });
  const oreFields: Field[] = [];
  for (let side = 0; side < 2; side++) for (const [de, ds, r, kind] of BASE_ORE) oreFields.push(field(own(side, de, ds), r, kind));
  for (const pair of SINAI_ORE_PAIRS) for (const [u, v, r, kind] of pair) oreFields.push(field(pp(u, v), r, kind));
  const oilAt = (p: Point) => ({ x: Math.round(p.x - 1), y: Math.round(p.y - 1) });
  const oils: Point[] = [];
  for (let side = 0; side < 2; side++) for (const [de, ds] of BASE_OIL) oils.push(oilAt(own(side, de, ds)));
  for (const pair of SINAI_OIL_PAIRS) for (const [u, v] of pair) oils.push(oilAt(pp(u, v)));

  const massifL = oldSpines(SINAI_MASSIF);
  const highL = oldSpines(SINAI_HIGHLAND, false);
  const coastL = SINAI_COAST_MTS.map((l) => l.map((p) => ({ ...pp(p.u, p.v), h: p.h })));
  const lift = MASSIF_LIFT * (1 + rng.range(-0.03, 0.03));
  const mesas: Capsule[] = SINAI_MESAS.map(([u0, v0, u1, v1, r]) => {
    const a = pp(u0, v0);
    const b = pp(u1, v1);
    return { x: a.x, y: a.y, x2: b.x, y2: b.y, r: r + rng.range(-0.15, 0.15) };
  });
  {
    const [e0, s0, e1, s1, r] = BLUE_HEADLAND;
    const a = own(0, e0, s0);
    const b = own(0, e1, s1);
    mesas.push({ x: a.x, y: a.y, x2: b.x, y2: b.y, r });
  }
  const oases = SINAI_OASES.map(([u, v, r]) => ({ ...pp(u, v), r }));
  for (let side = 0; side < 2; side++) oases.push({ ...own(side, BASE_OASIS[0], BASE_OASIS[1]), r: BASE_OASIS[2] });
  // the oasis gorge (tile-index offsets -> continuous points)
  const gz = (dx: number, dy: number) => ({ x: GORGE + dx + 0.5, y: GORGE + dy + 0.5 });
  oases.push({ ...gz(0, 0), r: GORGE_LAKE }, { ...gz(GORGE_POOL[0], GORGE_POOL[1]), r: GORGE_POOL[2] }, { ...gz(GORGE_POOL[1], GORGE_POOL[0]), r: GORGE_POOL[2] });
  {
    const [x0, y0, x1, y1, r] = GORGE_RIDGE;
    const a = gz(x0, y0);
    const b = gz(x1, y1);
    mesas.push({ x: a.x, y: a.y, x2: b.x, y2: b.y, r }, { x: a.y, y: a.x, x2: b.y, y2: b.x, r });
  }
  const wadis = SINAI_WADIS.map((l) => l.map(([u, v]) => pp(u, v)));
  {
    const pts = GORGE_WADI.map(([dx, dy]) => gz(dx, dy));
    wadis.push(pts, pts.map((p) => ({ x: p.y, y: p.x })));
  }
  const wadiDist = (x: number, y: number) => {
    let d = 1e9;
    for (const l of wadis) for (let k = 0; k < l.length - 1; k++) d = Math.min(d, distToSegment(x, y, l[k].x, l[k].y, l[k + 1].x, l[k + 1].y));
    return d;
  };
  // the villages at the two crossings and the towns (Sharm, Nuweiba) stand on graded ground
  const townAt = [
    { ...pp(...VILLAGE_PX[0]), r: 11 },
    { ...pp(...VILLAGE_PX[1]), r: 11 },
    { ...pp(...SHARM_TOWN_PX), r: 7 },
    { ...pp(...NUWEIBA_TOWN_PX), r: 7 },
  ];
  const townK = (x: number, y: number) => {
    let k = 0;
    for (const t of townAt) k = Math.max(k, 1 - smoothstep(t.r, t.r + 3, Math.hypot(x - t.x, y - t.y)));
    return k;
  };
  const lowGround = (x: number, y: number) => {
    const { v } = toPx(x, y);
    let h = 0.42 + (fbm(x * 0.045, y * 0.045, NS) - 0.5) * 1.3;
    // the north: long east-west dunes, higher towards the Mediterranean (the sand sea); villages on levelled ground
    const warp = (fbm(x * 0.06, y * 0.06, NS + 3) - 0.5) * 9;
    const s = scrS(x, y);
    const dune = Math.pow(0.5 + 0.5 * Math.cos((s + warp) * 0.56), 1.6);
    h += dune * 0.5 * smoothstep(96, 56, v) * (1 - 0.9 * townK(x, y));
    // El Tih: the limestone plateau of central Sinai, a gentle rise
    h += 0.3 * smoothstep(84, 104, v) * (1 - smoothstep(170, 200, v));
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
  // the coloured canyon (continuous points): the floor falls evenly from the ground at one mouth to the other
  const canyonPts = SINAI_CANYON.map(([e, s]) => oldAt(e, s));
  const canyons = [canyonPts].map((pts) => {
    let len = 0;
    const at = pts.map((p, i) => (i ? (len += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y)) : 0));
    const a = surface(pts[0].x, pts[0].y);
    const b = surface(pts[pts.length - 1].x, pts[pts.length - 1].y);
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
      const top = 2.25 + mesaBase[j] + (hash2(x, y, NS + 9) - 0.5) * 0.12;
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
  const rampsSrc = SINAI_RAMPS.flatMap((r) => [r, { ...r, pts: r.pts.map((p) => ({ ...p, x: -p.x })) }]).map((r) => ({ ...r, pts: r.pts.map((p) => ({ ...p, ...ti(oldAt(p.x, p.y)) })) }));
  const ramps = rampSet(W, H, rampsSrc, natural);
  for (let vy = 0; vy <= H; vy++) for (let vx = 0; vx <= W; vx++) g.heights[vy * (W + 1) + vx] = ramps.grade(vx - 0.5, vy - 0.5, groundC(vx, vy));
  // the granite ridge: its banks keep the ground's height; only vertices with ridge on all four sides rise into crags
  const barrier = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ridgeFoot(x + 0.5, y + 0.5) && seaDist(sea, x + 0.5, y + 0.5) < 0.3) barrier[y * W + x] = 1;
  for (let vy = 1; vy < H; vy++)
    for (let vx = 1; vx < W; vx++) {
      const i = (vy - 1) * W + vx - 1;
      if (!barrier[i] || !barrier[i + 1] || !barrier[i + W] || !barrier[i + W + 1]) continue;
      g.heights[vy * (W + 1) + vx] += 1.2 + fbm(vx * 0.11, vy * 0.11, NS + 76) * 2.8 + fbm(vx * 0.4, vy * 0.4, NS + 77) * 1.1;
    }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const fx = x + 0.5;
      const fy = y + 0.5;
      let t: Tile = Tile.Sand;
      if (fbm(fx * 0.07, fy * 0.07, NS + 5) > 0.57) t = Tile.Dirt; // gravel plains
      const mt = mountAt(fx, fy);
      if (mt.f > 0.06) {
        // stony slopes and talus, drift sand in the gullies, bare granite crags on the high ridges
        t = mt.r < 0.3 && mt.f > 0.12 ? Tile.Sand : Tile.Dirt;
        if (mt.f > 0.55 && mt.r > 0.86 && mt.h > 2.4) t = Tile.Rock;
      }
      const wd = wadiDist(fx, fy);
      if (wd < 1.8) t = Tile.Dirt;
      else if (townK(fx, fy) > 0.5) t = Tile.Dirt;
      else if (wd < 3.6 && fbm(fx * 0.2, fy * 0.2, NS + 6) > 0.48) t = Tile.Grass;
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
      if (barrier[i]) t = Tile.Rock;
      g.tiles[i] = t;
    }
  const roads = SINAI_ROADS.map((l) => l.map(([u, v]) => pi(u, v)));
  markRoads(g, roads, roads.map((_, i) => [0.95, 0.85, 0.85, 0.7][Math.min(i, 3)]), [Tile.Sand, Tile.Dirt, Tile.Grass]);
  paintOre(g, oreFields, Tile.Dirt, true);

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
      const h = hash2(x, y, NS + 11);
      if (h < palm) g.trees[i] = 2;
      else if ((t === Tile.Grass || t === Tile.Dirt) && h > 0.982) g.trees[i] = 1;
    }
  /** Next to the ridge (no trees on its banks). */
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

  // houses: the two villages, Sharm's town and Nuweiba's, the hamlets; each pair of places ends with as many
  // garrisonable houses as the other (the extra ones of the bigger come down, the farthest from its centre first)
  const groups = sinaiHouses(roads);
  const placeOpts = { starts, oils, ore: oreFields, roads, roadClear: 1.6, startClear: 15, flat: 0.45, footFlat: 0.4, tilesOk: [Tile.Grass, Tile.Dirt, Tile.Sand] };
  // each place's mosque first: the candidate spot nearest its centre that takes it (the places lie far apart)
  for (const gr of groups) {
    const cands = gr.houses.filter((st) => st.look === 'mosque');
    const rest = gr.houses.filter((st) => st.look !== 'mosque');
    const pick = cands.find((st) => placeStructures(g, [st], placeOpts).structures.length === 1);
    gr.houses = pick ? [pick, ...rest] : rest;
  }
  // (each house carries its group's index through placement, which may copy it a tile over)
  groups.forEach((gr, k) => gr.houses.forEach((st) => ((st as Structure & { grp?: number }).grp = k)));
  const { structures: placed, blocked } = placeStructures(g, groups.flatMap((gr) => gr.houses), placeOpts);
  const structures = balanceHouses(placed, groups, blocked);
  // the resort compounds by the sea (impassable; render/seaside.ts draws them)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inResort(sea, x + 0.5, y + 0.5)) blocked[y * W + x] = 1;
  for (const st of structures) st.variant = hash2(st.x, st.y, NS + 21);

  const deco = emptyDeco();
  deco.roadStyles = roads.map((_, i) => [{ width: 1.05, variant: 0 as const }, { width: 0.9, variant: 1 as const }, { width: 0.9, variant: 1 as const }, { width: 0.75, variant: 1 as const }][Math.min(i, 3)]);
  const tracks0 = SINAI_TRACKS.map((l) => l.map(([u, v]) => pi(u, v)));
  const baseTracks = [0, 1].map((side) => BASE_TRACK.map(([de, ds]) => ti(own(side, de, ds))));
  deco.tracks = [...tracks0, ...baseTracks, ...ramps.lines];
  deco.trackBeds = [...tracks0.map(() => 0), ...baseTracks.map(() => 0), ...ramps.beds];
  deco.trackNoCars = [...tracks0.map(() => false), ...baseTracks.map(() => false), ...ramps.noCars];
  // irrigated plots by the oases, the villages and in the gorge
  const plot = (p: Point, w: number, h: number, rows: 0 | 1) => ({ x0: p.x - w / 2, y0: p.y - h / 2, x1: p.x + w / 2, y1: p.y + h / 2, rows });
  deco.fields = [
    ...SINAI_FIELDS.map(([u, v, w, h, rows]) => plot(pp(u, v), w, h, rows as 0 | 1)),
    ...[0, 1].map((side) => plot(own(side, BASE_OASIS[0] + 3.5, BASE_OASIS[1] - 3), 4, 3, side as 0 | 1)),
    { x0: GORGE - 7.5, y0: GORGE - 5.5, x1: GORGE - 2.5, y1: GORGE - 1.5, rows: 0 },
    { x0: GORGE - 5.5, y0: GORGE - 7.5, x1: GORGE - 1.5, y1: GORGE - 2.5, rows: 1 },
  ];
  deco.power = SINAI_POWER.map((l) => l.map(([u, v]) => pp(u, v)));
  // palms lining the village streets and at the back of the beaches
  deco.trees.push(...townPalms(g, [roads[0]], structures, blocked).filter((p) => townK(p.x, p.y) > 0.3));
  deco.trees.push(...beachPalms(sea, g, NS));
  deco.sea = sea;
  deco.canyons = canyons.map((c) => ({ pts: c.pts.map((p) => ({ x: p.x - 0.5, y: p.y - 0.5 })), hw: CANYON_HW }));

  const offshore = new Uint8Array(W * H);
  if (sea.isle) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (isleAt(sea.isle, x + 0.5, y + 0.5) < 0) offshore[y * W + x] = 1;

  const techAt = (p: Point): [number, number] => [Math.round(p.x - 1), Math.round(p.y - 1)];
  const techSites = [
    ...BASE_TECH.map((t) => ({ def: t.def, at: t.at.map(([de, ds]) => techAt(own(0, de, ds))), at2: t.at.map(([de, ds]) => techAt(own(1, de, ds))) })),
    ...SINAI_TECH.map((t) => ({ def: t.def, at: t.at.map(([u, v]) => techAt(pp(u, v))), at2: t.at2.map(([u, v]) => techAt(pp(u, v))) })),
  ];
  return assemble({ name: 'Wadi Al-Rimal', id: 'desert', biome: 'desert' }, g, {
    offshore,
    oreMines: oreFields.map((f) => ({ x: f.x, y: f.y })),
    starts,
    oils,
    bridges: [],
    roads,
    structures,
    blocked,
    techSites,
    // the AI's crossings: the land at the gulfs' heads (every ground route takes both; a picket and the ambushes
    // hold the own one, ai.ts manageChoke)
    lanes: CROSS_PX.map(([u, v]) => pi(u, v)),
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

/** Roads (pixel polylines): the highway base to base over both crossings, the Sinai's coast roads. */
const SINAI_ROADS: [number, number][][] = [
  // the highway: from blue's base over the isthmus, through the west village, across north Sinai, through the east
  // village and the gap by the ridge, down the Arabian coast inland of Midian's mountains to red's base
  [
    [11, 67],
    [24, 62],
    [42, 61],
    [62, 62],
    [88, 58],
    [125, 53],
    [160, 56],
    [196, 67],
    [222, 76],
    [240, 79],
    [250, 92],
    [254, 115],
    [262, 140],
    [250, 170],
    [214, 183],
  ],
  // the coast road from the west village down the Sinai's Gulf of Suez coast to Sharm
  [
    [62, 62],
    [60, 80],
    [64, 96],
    [72, 110],
    [70, 126],
    [64, 142],
    [70, 158],
    [78, 172],
    [86, 186],
    [98, 196],
    [112, 200],
    [124, 200],
  ],
  // from the east village down the Gulf of Aqaba coast to Nuweiba
  [
    [222, 76],
    [212, 90],
    [200, 104],
    [192, 116],
    [186, 128],
  ],
];
/** Dirt tracks (pixel polylines). */
const SINAI_TRACKS: [number, number][][] = [
  // from the highway south over El Tih down the coloured canyon to Nuweiba's road
  [
    [158, 56],
    [154, 68],
    [152.5, 77],
  ],
  [
    [172, 120],
    [182, 124],
    [190, 118],
  ],
  // from the highway down Wadi el-Arish to the gorge
  [
    [125, 53],
    [124, 76],
    [125, 100],
  ],
  // from the coast road to the massif's summit track
  [
    [70, 126],
    [76.7, 125.3],
  ],
];
/** Each base's track to its hamlet (base frame). */
const BASE_TRACK: [number, number][] = [
  [-6, 6],
  [-14, 14],
  [-21, 22],
  [-24, 26],
];
/** Irrigated plots (centre u, v, size w x h tiles, row direction). */
const SINAI_FIELDS: [number, number, number, number, number][] = [
  [74, 70, 5, 3.5, 0],
  [210, 84, 5, 3.5, 1],
  [86, 106, 4, 3, 0],
  [182, 102, 4, 3, 1],
];
/** Power lines (pixel polylines): each base to its crossing's village. */
const SINAI_POWER: [number, number][][] = [
  [
    [8, 74],
    [26, 66],
    [44, 64],
    [62, 66],
    [90, 62],
  ],
  [
    [218, 176],
    [244, 160],
    [256, 120],
    [246, 90],
    [228, 80],
    [200, 72],
  ],
];

/**
 * Mountain tracks graded into the massif (SL1; via points in the old layout's screen positions, the west one;
 * mirrored across the massif): the summit track up the north-west flank to the plateau under the summit, a steep
 * footpath (soldiers only).
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

/** The villages at the crossings (pixel centres): the Egyptian one east of the isthmus, the Arabian one west of the gap. */
const VILLAGE_PX: [number, number][] = [
  [64, 62],
  [222, 76],
];
/** The Sinai's hamlets: pairs (pixel anchors). */
const HAMLET_PX: [number, number][][] = [
  [
    [96, 112],
    [205, 118],
  ],
];

/** A house at continuous point p (kind, facing, look); a 3 x 2 courtyard turned a quarter becomes 2 x 3. */
function houseAt(p: Point, kind: StructureKind, rot: number, look?: Structure['look'], town?: 0 | 1 | 2): Structure {
  const w = kind === StructureKind.Courtyard ? (rot % 2 ? 2 : 3) : 2;
  const h = kind === StructureKind.Courtyard ? (rot % 2 ? 3 : 2) : 2;
  return { kind, x: Math.round(p.x - w / 2), y: Math.round(p.y - h / 2), w, h, rot, ...(look ? { look } : {}), ...(town !== undefined ? { town } : {}) };
}
/** The facing (rot 0..3: (0,-1), (1,0), (0,1), (-1,0) in tile space) nearest to direction (dx, dy). */
const facing = (dx: number, dy: number) => (Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0);
/** A group of candidate houses: one place (a village, a town, a hamlet) and the other side's twin place it is held level with. */
interface HouseGroup {
  /** Places of the same pair share it; side 0 nearer blue, 1 nearer red. */
  pair: number;
  side: number;
  centre: Point;
  houses: Structure[];
}
/**
 * Candidate houses lining the roads through a place: both sides of every road within `r` tiles of its centre, every
 * 3.3 tiles, in two rows (the first facing the road), shop-houses on the street, the mosque the first house north of
 * the road nearest the centre.
 */
function roadHouses(c: Point, r: number, roads: Point[][], town: 0 | 1 | 2, rows = 2): Structure[] {
  const out: Structure[] = [];
  const M = StructureKind.MudHouse;
  // (the houses nearest the centre, the back row's first, are the mosque's candidate spots)
  const back: Structure[] = [];
  const front: Structure[] = [];
  let k = 0;
  for (const road of roads)
    for (let j = 0; j < road.length - 1; j++) {
      const a = { x: road[j].x + 0.5, y: road[j].y + 0.5 };
      const b = { x: road[j + 1].x + 0.5, y: road[j + 1].y + 0.5 };
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      const nx = -(b.y - a.y) / L;
      const ny = (b.x - a.x) / L;
      for (let t = 1.6; t < L; t += 3.3) {
        const px = a.x + ((b.x - a.x) * t) / L;
        const py = a.y + ((b.y - a.y) * t) / L;
        if (Math.hypot(px - c.x, py - c.y) > r) continue;
        for (const side of [-1, 1])
          for (let row = 0; row < rows; row++) {
            const off = 3.4 + row * 3.2;
            const hx = px + nx * side * off;
            const hy = py + ny * side * off;
            const rot = facing(px - hx, py - hy);
            const shop = row === 0 && k++ % 3 === 0;
            const st = houseAt({ x: hx, y: hy }, M, rot, shop ? 'shop' : undefined, town);
            out.push(st);
            (row === rows - 1 ? back : front).push(st);
          }
      }
    }
  const byDist = (p: Structure, q: Structure) => Math.hypot(p.x - c.x, p.y - c.y) - Math.hypot(q.x - c.x, q.y - c.y);
  back.sort(byDist);
  front.sort(byDist);
  // the mosque: a courtyard (createDesertMap keeps the first candidate that fits)
  const mosques = [...back, ...front].map((h) => houseAt({ x: h.x + 1, y: h.y + 1 }, StructureKind.Courtyard, h.rot & 2, 'mosque', town));
  return [...mosques, ...out];
}
/**
 * Every house of the map, by place: the villages at the crossings (houses along the roads through them), Sharm's
 * and Nuweiba's towns, the Sinai's hamlets and each base's own; places of one pair are held level by balanceHouses.
 */
export function sinaiHouses(roads: Point[][]): HouseGroup[] {
  const M = StructureKind.MudHouse;
  const hamlet: [number, number, number][] = [
    [0, 0, 1],
    [3.4, 2.4, 2],
    [-3, 3, 0],
  ];
  const cluster = (c: Point, turned: boolean, town: 0 | 1 | 2) => hamlet.map(([de, ds, rot]) => houseAt(turned ? offs(c, -de, -ds) : offs(c, de, ds), M, turned ? (rot + 2) % 4 : rot, undefined, town));
  const groups: HouseGroup[] = [];
  VILLAGE_PX.forEach(([u, v], side) => {
    const c = pp(u, v);
    groups.push({ pair: 0, side, centre: c, houses: roadHouses(c, 13, roads, side ? 1 : 0) });
  });
  const sharm = pp(...SHARM_TOWN_PX);
  const nuweiba = pp(...NUWEIBA_TOWN_PX);
  groups.push({ pair: 1, side: 0, centre: sharm, houses: roadHouses(sharm, 8, roads, 2) });
  groups.push({ pair: 1, side: 1, centre: nuweiba, houses: roadHouses(nuweiba, 8, roads, 1) });
  HAMLET_PX.forEach(([h0, h1], k) => {
    groups.push({ pair: 2 + k, side: 0, centre: pp(...h0), houses: cluster(pp(...h0), false, 0) });
    groups.push({ pair: 2 + k, side: 1, centre: pp(...h1), houses: cluster(pp(...h1), true, 1) });
  });
  const P = 2 + HAMLET_PX.length;
  for (let side = 0; side < 2; side++) {
    const c = own(side, BASE_HAMLET[0], BASE_HAMLET[1]);
    groups.push({ pair: P, side, centre: c, houses: cluster(c, side === 1, side ? 1 : 0) });
  }
  return groups;
}
/** Does a house take a garrison (sim/garrison.ts: the defined footprints only)? */
const garrisons = (st: Structure) => st.kind === StructureKind.MudHouse || (st.kind === StructureKind.Courtyard && st.w === 3);
/**
 * Hold each pair of places level: the same number of garrisonable houses (the bigger place's farthest from its
 * centre come down; their footprints open again).
 */
function balanceHouses(placed: Structure[], groups: HouseGroup[], blocked: Uint8Array): Structure[] {
  const groupOf = new Map<Structure, HouseGroup>();
  for (const st of placed) {
    const k = (st as Structure & { grp?: number }).grp;
    if (k !== undefined) groupOf.set(st, groups[k]);
    delete (st as Structure & { grp?: number }).grp;
  }
  const drop = new Set<Structure>();
  const pairs = new Set(groups.map((gr) => gr.pair));
  for (const p of pairs) {
    const sides = [0, 1].map((side) => placed.filter((st) => garrisons(st) && groupOf.get(st)?.pair === p && groupOf.get(st)?.side === side));
    const n = Math.min(sides[0].length, sides[1].length);
    for (const list of sides) {
      const c = groupOf.get(list[0])?.centre;
      if (!c) continue;
      list.sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y));
      for (const st of list.slice(n)) drop.add(st);
    }
  }
  for (const st of drop) for (let y = st.y; y < st.y + st.h; y++) for (let x = st.x; x < st.x + st.w; x++) blocked[y * W + x] = 0;
  // one mosque a place: any further one that found room becomes a row of shops
  const hasMosque = new Set<HouseGroup>();
  for (const st of placed) {
    if (st.look !== 'mosque') continue;
    const gr = groupOf.get(st)!;
    if (hasMosque.has(gr)) st.look = 'shops';
    hasMosque.add(gr);
  }
  return placed.filter((st) => !drop.has(st));
}
/** Each base's hamlet (base frame). */
const BASE_HAMLET: [number, number] = [-24, 26];

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

/**
 * A track or footpath graded into a mountainside (SL1, sim/slope.ts): via points in tile index space, the ground along it evened out to a steady grade between the points whose height is known (the
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
    /** Centre lines of the drawn tracks... */
    lines: src.flatMap((r) => (!r.track ? [] : [r.pts.map((p) => ({ x: p.x, y: p.y }))])),
    /** ...and how much wider than a plain dirt track each one's worn band is drawn (MapDeco.trackBeds). */
    beds: src.flatMap((r) => (!r.track ? [] : [Math.max(0, r.hw - 0.45)])),
    noCars: src.flatMap((r) => (!r.track ? [] : [!!r.noCars])),
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


/** Reef shelf width (tiles from the waterline) and the open sea's floor. */
const REEF = 2.4;
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
      h = shelf + (SEA_FLOOR - shelf) * smoothstep(REEF, REEF + 1.8, ve);
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
