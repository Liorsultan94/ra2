import { fbm, hash2 } from './rng';

export const enum Tile {
  Grass = 0,
  Dirt = 1,
  Sand = 2,
  Water = 3,
  Rock = 4,
  Bridge = 5,
}

export const WATER_LEVEL = -0.25;
export const BRIDGE_HEIGHT = 0.35;

export interface Point {
  x: number;
  y: number;
}

/** Climate / look of a map (render palette, plants, water, weather default). */
export type Biome = 'temperate' | 'desert' | 'winter' | 'urban';
/** Selectable skirmish maps (src/sim/maps.ts). */
export type MapId = 'frontline' | 'desert' | 'winter' | 'urban';

export interface GameMap {
  name: string;
  /** Which map generator built it. */
  id: MapId;
  /** Climate / look (the renderer picks palettes, plants and water from it). */
  biome: Biome;
  w: number;
  h: number;
  tiles: Uint8Array;
  /** Vertex heights, (w+1) * (h+1). */
  heights: Float32Array;
  trees: Uint8Array; // 0 none, 1 pine, 2 broadleaf
  ore: Uint8Array; // amount of ore units on tile
  oreKind: Uint8Array; // 1 ore, 2 gems
  oreMines: Point[];
  starts: Point[];
  oils: Point[];
  bridges: { x: number; y: number; angle: number; length: number }[];
  /** Road centerlines (the sim only marks them as dirt tiles; the renderer paves them). */
  roads: Point[][];
  /** Civilian scenery buildings. Their footprints are impassable (see `blocked`). */
  structures: Structure[];
  /** 1 where a civilian structure stands. */
  blocked: Uint8Array;
  /**
   * Capturable tech sites: candidate top-left corners for player 0's half (mirrored for player 1, or on a map with
   * no mirror player 1's own candidates `at2`), the first valid one is used (capture.ts). Absent: the Frontline
   * Crossing defaults.
   */
  techSites?: { def: string; at: [number, number][]; at2?: [number, number][] }[];
  /** Extra AI attack lanes (fords, passes, avenues) besides the bridges (ai.ts). */
  lanes?: Point[];
  /** 1 on land that no ground unit can reach on purpose (offshore islands): kept open, never sealed with trees. */
  offshore?: Uint8Array;
  /**
   * How the two halves mirror each other (fair starts): 'point' (absent) through the map centre, x -> w - 1 - x and
   * y -> h - 1 - y; 'transpose' across the x == y diagonal, (x, y) -> (y, x) (the screen's left-right mirror: the
   * Sinai map, whose gulfs both open to the south); 'none': no mirror (the Sinai traced from the owner's picture:
   * the sides differ, the resources each holds are kept equal by hand).
   */
  mirror?: 'point' | 'transpose' | 'none';
  /** Render-only hints of the hand-designed maps (road widths, tracks, plazas, parks, rubble lots). */
  deco?: MapDeco;
}

/** Visual-only layout data a map generator hands to the renderer (render/biomelayout.ts). */
export interface MapDeco {
  /** Per entry of `GameMap.roads`: width (tiles), 0 = highway / avenue, 1 = country road / street, routed around obstacles or straight. */
  roadStyles: { width: number; variant: 0 | 1; straight?: boolean }[];
  /** Dirt tracks (via points; routed). */
  tracks: Point[][];
  /**
   * Per entry of `tracks` (absent: 0): how much wider (tiles, either side) its worn band is drawn - the tracks graded
   * up the mountains (sim/maps.ts rampSet) are cut wide enough for a column of tanks.
   */
  trackBeds?: number[];
  /** Per entry of `tracks`: no civilian traffic on it (a footpath, a dead-end mountain track). */
  trackNoCars?: boolean[];
  /** Paved plazas / squares (axis-aligned rectangles, tile space). */
  plazas: { x0: number; y0: number; x1: number; y1: number }[];
  /** Park lawns (rectangles) with hedges and paths. */
  parks: { x0: number; y0: number; x1: number; y1: number }[];
  /** Ruined / rubble lots (rectangles, passable). */
  lots: { x0: number; y0: number; x1: number; y1: number }[];
  /** Irrigated plots / snowy fields (rectangles, row direction 0 = along x, 1 = along y). */
  fields: { x0: number; y0: number; x1: number; y1: number; rows: 0 | 1 }[];
  /** Power line runs (via points). */
  power: Point[][];
  /** Render-only trees (street trees, roadside palms): kind 1 / 2 as `GameMap.trees`. Vehicles knock them over. */
  trees: { x: number; y: number; kind: number }[];
  /** The seas of the Sinai (Wadi Al-Rimal): see `seaDist`. */
  sea?: SeaDeco;
  /** Coloured canyons (Wadi Al-Rimal): floor centre lines (tile index space) and the floor's half width (render/canyon.ts). */
  canyons?: { pts: Point[]; hw: number }[];
}

/**
 * The seas of the Sinai map (Wadi Al-Rimal): the Mediterranean across the top corner of the screen (the map's
 * north-west tile corner), the Red Sea across the bottom one (south-east) and the two gulfs between them, the
 * Gulf of Suez on the west and the Gulf of Aqaba on the east (`seaDist`). Map north is the top of the screen:
 * screen east E = (x - y) / sqrt 2, screen south S = (x + y) / sqrt 2 (continuous map coordinates).
 * Seaside places (resort beaches, the lighthouse island, the Blue Hole's lagoon) each have a straight local
 * frame (`SeaFrame`): u along the coast, v seaward (> 0 = sea), in tiles.
 */
export interface SeaFrame {
  /** Origin (continuous map coordinates) and the tile-space heading of +u; +v (seaward) is (sin ang, -cos ang). */
  x: number;
  y: number;
  ang: number;
}

/** A resort beach on the coast (render/seaside.ts; the compound is impassable). */
export interface SeaSite extends SeaFrame {
  /** The resort compound: along-coast u0..u1, seaward v0..v1 (negative = inland). */
  resort: { u0: number; u1: number; v0: number; v1: number };
  /** The bathing beach's along-coast stretch. */
  beach: [number, number];
  /** Look of the place: 0 the big resort (Sharm: jetty, boats, the most people), 1 and 2 the smaller gulf resorts. */
  look: number;
}

export interface SeaDeco {
  /** Map centre (continuous coordinates; the map is square). */
  c: number;
  /** Coast distance from the map centre along the diagonal: the Mediterranean (top corner) and the Red Sea (bottom). */
  top: number;
  bottom: number;
  /** The gulfs: centre lines (continuous coordinates, from the head to the open sea) with half widths. */
  gulfs: { x: number; y: number; hw: number }[][];
  /**
   * The coasts traced from a picture (SeaGrid): the seaward distance comes from the grid (past its rectangle its edge
   * rows and columns carry on), turning into the open seas above (top / bottom) over the last `band` tiles before the
   * map's edge, where the world past the map takes over (render/horizonworld.ts).
   */
  grid?: SeaGrid;
  /** Resort beaches. */
  sites: SeaSite[];
  /**
   * An offshore island (sim land: a sandy rim, a rocky knoll the lighthouse stands on), ringed by a reef flat
   * and cut off from the mainland by water: centre and heading of its frame, the radii of its wobbly ellipse along
   * (ru) and across (rv). No ground unit can reach it (GameMap.offshore; World.region).
   */
  isle?: SeaFrame & { ru: number; rv: number };
  /** The Blue Hole's reef lagoon (render only): its frame's origin on the waterline (render/bluehole.ts LAGOON). */
  hole?: SeaFrame;
}

/**
 * Seaward distance sampled over a rectangle of screen positions (E east, S south of the map's top corner; tiles):
 * sample (i, j) at E = e0 + i * step, S = s0 + j * step, row-major, `d` in tiles (> 0 = water).
 */
export interface SeaGrid {
  cols: number;
  rows: number;
  e0: number;
  s0: number;
  step: number;
  d: Float32Array;
  /** Width (tiles) of the band along the map's edge over which the grid turns into the open seas. */
  band: number;
}

/** The grid's seaward distance at screen position (e, s) (past the grid, its nearest edge sample's). */
export function gridSea(g: SeaGrid, e: number, s: number): number {
  const fx = (e - g.e0) / g.step;
  const fy = (s - g.s0) / g.step;
  const cx = Math.max(0, Math.min(g.cols - 1.0001, fx));
  const cy = Math.max(0, Math.min(g.rows - 1.0001, fy));
  const i = Math.floor(cx);
  const j = Math.floor(cy);
  const tx = cx - i;
  const ty = cy - j;
  const k = j * g.cols + i;
  const d = g.d;
  return (d[k] * (1 - tx) + d[k + 1] * tx) * (1 - ty) + (d[k + g.cols] * (1 - tx) + d[k + g.cols + 1] * tx) * ty;
}

/** Frame coordinates (u along, v seaward) of map point (x, y). */
export function frameUV(f: SeaFrame, x: number, y: number, out = { u: 0, v: 0 }) {
  const c = Math.cos(f.ang);
  const s = Math.sin(f.ang);
  const dx = x - f.x;
  const dy = y - f.y;
  out.u = dx * c + dy * s;
  out.v = dx * s - dy * c;
  return out;
}

/** Map point of frame position (u, v). */
export function framePoint(f: SeaFrame, u: number, v: number): Point {
  const c = Math.cos(f.ang);
  const s = Math.sin(f.ang);
  return { x: f.x + u * c + v * s, y: f.y + u * s - v * c };
}

/** Signed distance (tiles; < 0 on the island) from island-frame point (u, v) (centre at 0, 0) to its shore. */
export function isleDist(isle: { ru: number; rv: number }, u: number, v: number) {
  const du = u / isle.ru;
  const dv = v / isle.rv;
  const a = Math.atan2(dv, du);
  const e = Math.hypot(du, dv) * (1 + 0.1 * Math.sin(3 * a + 1.3) + 0.06 * Math.sin(5 * a + 0.4));
  return (e - 1) * Math.min(isle.ru, isle.rv);
}

/** isleDist at map point (x, y). */
export function isleAt(isle: SeaFrame & { ru: number; rv: number }, x: number, y: number) {
  const f = frameUV(isle, x, y);
  return isleDist(isle, f.u, f.v);
}

/** The rocky knoll in the island's middle (impassable rock): isleDist below this. */
export const ISLE_KNOLL = -1.25;

/** The coastline's wiggle along u (shared by the map and the world past its edge: Canal City's bay). */
export function coastWiggle(u: number) {
  return 4 * Math.sin(u * 0.045) + 2.5 * Math.sin(u * 0.13 + 1.0);
}

/** The Sinai's open-sea coasts' wiggle along screen east (even: the same on both halves of the mirrored map). */
export function seaWiggle(u: number) {
  return 2.6 * Math.cos(u * 0.047) + 1.5 * Math.cos(u * 0.131);
}

/** A gulf shore's wiggle by the distance s (tiles) from the gulf's head (the same on both gulfs). */
export function gulfWiggle(s: number) {
  return 0.55 * Math.sin(s * 0.21 + 0.7) + 0.35 * Math.sin(s * 0.57);
}

/** Seaward distance (tiles; > 0 = water) of the open seas only (the twin coasts past the map's top and bottom corners). */
export function openSeaDist(sea: SeaDeco, x: number, y: number) {
  const n = Math.SQRT1_2;
  const e = (x - y) * n;
  const s = (x + y - 2 * sea.c) * n;
  const w = seaWiggle(e);
  return Math.max(-s - sea.top + w, s - sea.bottom + w);
}

/**
 * Seaward distance (tiles; > 0 = water, < 0 = inland) at continuous map point (x, y): the open seas and the
 * gulfs (the island is land in the water: isleAt). Exactly symmetric under x <-> y on the mirrored map.
 */
export function seaDist(sea: SeaDeco, x: number, y: number): number {
  let best = openSeaDist(sea, x, y);
  if (sea.grid) {
    const n = Math.SQRT1_2;
    const d = gridSea(sea.grid, (x - y) * n, (x + y) * n);
    // (the open seas take over towards the map's edge)
    const edge = Math.min(x, y, 2 * sea.c - x, 2 * sea.c - y);
    const t = Math.max(0, Math.min(1, 1 - edge / sea.grid.band));
    best = d + (best - d) * t * t * (3 - 2 * t);
  }
  for (const g of sea.gulfs) {
    let s0 = 0;
    for (let k = 0; k < g.length - 1; k++) {
      const a = g[k];
      const b = g[k + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      const len = Math.sqrt(l2);
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
      const d = Math.hypot(x - a.x - dx * t, y - a.y - dy * t);
      const v = a.hw + (b.hw - a.hw) * t - d + gulfWiggle(s0 + t * len);
      if (v > best) best = v;
      s0 += len;
    }
  }
  return best;
}

export const enum StructureKind {
  House = 0,
  Cottage = 1,
  Barn = 2,
  Tower = 3,
  WaterTower = 4,
  Silo = 5,
  // desert villages
  MudHouse = 6,
  Courtyard = 7,
  // city (render/models/citybldgs.ts)
  Apartment = 8,
  Block = 9,
  Office = 10,
  Shop = 11,
  Townhouse = 12,
}

export interface Structure {
  kind: StructureKind;
  /** Footprint in tiles (top-left corner + size). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Facing (0..3, quarter turns): which side the front door / gable faces. */
  rot: number;
  /** Look variant 0..1 (render only: floors, facade, colours); seeded by the map generator. */
  variant?: number;
  /** Render-only role hint (Wadi Al-Rimal's town): the mosque, a shop-house facing a street, a row of shops. */
  look?: 'mosque' | 'shop' | 'shops';
  /** Render-only: the town it belongs to (render/townstyle.ts: 0 Egyptian, 1 Arabian, 2 Sharm / any other). */
  town?: 0 | 1 | 2;
}

export const ORE_MAX = 10;
export const ORE_VALUE = 25;
export const GEM_VALUE = 50;

/** The mirror image of tile (x, y) on the other player's half (GameMap.mirror). */
export function mirrorTile(m: GameMap, x: number, y: number): Point {
  return m.mirror === 'transpose' ? { x: y, y: x } : { x: m.w - 1 - x, y: m.h - 1 - y };
}

/** The mirror image of a w x h footprint with its top-left tile at (x, y): top-left tile and size. */
export function mirrorRect(m: GameMap, x: number, y: number, w: number, h: number) {
  return m.mirror === 'transpose' ? { x: y, y: x, w: h, h: w } : { x: m.w - x - w, y: m.h - y - h, w, h };
}

/** The mirror image of a continuous map point (tile centres at + 0.5). */
export function mirrorPoint(m: GameMap, x: number, y: number): Point {
  return m.mirror === 'transpose' ? { x: y, y: x } : { x: m.w - x, y: m.h - y };
}

export function inBounds(m: GameMap, x: number, y: number) {
  return x >= 0 && y >= 0 && x < m.w && y < m.h;
}

/** Ground-unit passability from terrain alone (buildings handled by the world). */
export function terrainPassable(m: GameMap, x: number, y: number): boolean {
  if (!inBounds(m, x, y)) return false;
  const i = y * m.w + x;
  const t = m.tiles[i];
  return t !== Tile.Water && t !== Tile.Rock && m.trees[i] === 0 && m.blocked[i] === 0;
}

/** Can a ground unit (or special amphibious unit) traverse this tile? Standard ground units cannot cross water. */
export function unitPassable(m: GameMap, x: number, y: number, amphibious = false): boolean {
  if (!inBounds(m, x, y)) return false;
  const i = y * m.w + x;
  const t = m.tiles[i];
  if (t === Tile.Water) return amphibious;
  return t !== Tile.Rock && m.trees[i] === 0 && m.blocked[i] === 0;
}

/** Open ground for a single tile: walkable, no bridge deck, no ore (no slope or bridge-head rule: see terrainBuildable). */
export function tileOpen(m: GameMap, x: number, y: number): boolean {
  if (!terrainPassable(m, x, y)) return false;
  const i = y * m.w + x;
  return m.tiles[i] !== Tile.Bridge && m.ore[i] === 0;
}

/**
 * Steepest ground a footprint may stand on: the largest height difference between its corner
 * vertices, growing with its size (a 1x1 0.33, 2x2 0.46, 3x3 0.59, 4x4 0.72; about one in five).
 * Steeper slots float the apron on the downhill side and bury the back wall in the hill / cliff.
 */
export const buildMaxRise = (w: number, h: number) => 0.2 + 0.13 * Math.max(w, h);
/** Bridge heads: the deck plus its approach ramps this far beyond each deck end (render/deckramp.ts RAMP_RUN 2.2, plus margin)... */
export const BRIDGE_HEAD_RUN = 3;
/** ...and this far either side of the deck's centreline (deck half width 1.05, the rails, a tile's half diagonal). */
export const BRIDGE_HEAD_HALF = 1.9;

/** Height difference over the vertices of a footprint. */
export function footprintRise(m: GameMap, tx: number, ty: number, w: number, h: number): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let vy = ty; vy <= ty + h; vy++)
    for (let vx = tx; vx <= tx + w; vx++) {
      const v = vertexHeight(m, vx, vy);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  return hi - lo;
}

/** Does tile (x, y) belong to a bridge's deck or head ramps (the deck rectangle stretched along its axis)? */
export function onBridgeHead(m: GameMap, x: number, y: number): boolean {
  const px = x + 0.5;
  const py = y + 0.5;
  for (const b of m.bridges) {
    const ux = Math.cos(b.angle);
    const uy = Math.sin(b.angle);
    const a = b.length / 2 + BRIDGE_HEAD_RUN;
    const t = Math.max(-a, Math.min(a, (px - b.x) * ux + (py - b.y) * uy));
    if (Math.hypot(px - b.x - ux * t, py - b.y - uy * t) < BRIDGE_HEAD_HALF) return true;
  }
  return false;
}

/**
 * Can a w x h structure stand with its top-left tile at (x, y), terrain-wise (other buildings are the
 * world's business)? Every tile open ground (tileOpen), never on a bridge deck or head ramp, and the
 * ground no steeper than buildMaxRise.
 */
export function terrainBuildable(m: GameMap, x: number, y: number, w = 1, h = 1): boolean {
  for (let ty = y; ty < y + h; ty++) for (let tx = x; tx < x + w; tx++) if (!tileOpen(m, tx, ty) || onBridgeHead(m, tx, ty)) return false;
  return footprintRise(m, x, y, w, h) <= buildMaxRise(w, h);
}

/**
 * No walkable land the armies can never reach: every walkable tile cut off from player 0's start
 * (4-connected, as the path finder moves: no corner cutting) gets a tree, so it is impassable like
 * the forest or bank that walls it in (Frontline's border pockets behind the edge forest). Returns the
 * number of tiles sealed. Deterministic, and point symmetric on a symmetric map.
 */
export function sealPockets(m: GameMap): number {
  const W = m.w;
  const H = m.h;
  const seen = new Uint8Array(W * H);
  const q: number[] = [];
  for (const s of m.starts) {
    const i = s.y * W + s.x;
    if (!seen[i] && terrainPassable(m, s.x, s.y)) {
      seen[i] = 1;
      q.push(i);
    }
  }
  while (q.length) {
    const t = q.pop()!;
    const x = t % W;
    const y = (t / W) | 0;
    if (x > 0 && !seen[t - 1] && terrainPassable(m, x - 1, y)) (seen[t - 1] = 1), q.push(t - 1);
    if (x < W - 1 && !seen[t + 1] && terrainPassable(m, x + 1, y)) (seen[t + 1] = 1), q.push(t + 1);
    if (y > 0 && !seen[t - W] && terrainPassable(m, x, y - 1)) (seen[t - W] = 1), q.push(t - W);
    if (y < H - 1 && !seen[t + W] && terrainPassable(m, x, y + 1)) (seen[t + W] = 1), q.push(t + W);
  }
  let n = 0;
  for (let i = 0; i < W * H; i++) {
    const x = i % W;
    const y = (i / W) | 0;
    if (seen[i] || !terrainPassable(m, x, y) || m.tiles[i] === Tile.Bridge || m.offshore?.[i]) continue;
    // (the same kind on both mirrored tiles)
    m.trees[i] = (m.mirror === 'transpose' ? hash2(Math.min(x, y), Math.max(x, y), 6) : hash2(Math.min(x, W - 1 - x), Math.min(y, H - 1 - y), 6)) < 0.5 ? 1 : 2;
    m.ore[i] = 0;
    m.oreKind[i] = 0;
    n++;
  }
  return n;
}

function vertexHeight(m: GameMap, vx: number, vy: number) {
  vx = Math.max(0, Math.min(m.w, vx));
  vy = Math.max(0, Math.min(m.h, vy));
  return m.heights[vy * (m.w + 1) + vx];
}

/** Ground height at a continuous tile-space position (bilinear over vertices). */
export function groundHeight(m: GameMap, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const a = vertexHeight(m, x0, y0);
  const b = vertexHeight(m, x0 + 1, y0);
  const c = vertexHeight(m, x0, y0 + 1);
  const d = vertexHeight(m, x0 + 1, y0 + 1);
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/** Height at which a unit stands (bridges lift units above the water). */
export function standHeight(m: GameMap, x: number, y: number): number {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (inBounds(m, tx, ty) && m.tiles[ty * m.w + tx] === Tile.Bridge) return BRIDGE_HEIGHT;
  return Math.max(groundHeight(m, x, y), WATER_LEVEL);
}

export function smoothstep(e0: number, e1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return Math.hypot(px - cx, py - cy);
}

/** Frontline Crossing and Wadi Al-Rimal are built this size (their layouts were drawn on 96 x 96 tiles). */
export const BIG_MAP = 128;

/**
 * The hand layouts' design space (drawn on 96 x 96 tiles) on a map of w tiles: distances from the centre
 * grow by w / 96 and the point symmetry is kept, sizes do not (callers keep the radii, widths and
 * lengths, and move a whole cluster - a village, a mesa - by its anchor). `x` / `pt` take continuous
 * tile-space coordinates (a tile's centre at +0.5), `ti` / `tp` tile indices.
 */
export function designScale(w: number) {
  const k = w / 96;
  const x = (v: number) => w / 2 + (v - 48) * k;
  const ti = (v: number) => x(v + 0.5) - 0.5;
  return { k, x, ti, pt: (px: number, py: number): Point => ({ x: x(px), y: x(py) }), tp: (px: number, py: number): Point => ({ x: ti(px), y: ti(py) }) };
}

/**
 * Frontline Crossing's clusters in design space: points within `r` of an anchor move with it (the
 * houses, their lanes and yards keep their spacing), everything else scales (render/layout.ts uses the
 * same table for the tracks through them).
 */
export const FRONTLINE_CLUSTERS = [
  // the village west of the centre bridge
  { x: 30, y: 52.5, r: 9 },
  // the farmstead in the southern fields
  { x: 61, y: 87.5, r: 5 },
  // the roadside hamlet
  { x: 50.5, y: 75.5, r: 4.5 },
];

/** Frontline Crossing design point (continuous coordinates) -> map point, clusters moving rigidly. */
export function frontlinePoint(w: number, x: number, y: number): Point {
  const S = designScale(w);
  for (const c of FRONTLINE_CLUSTERS) if (Math.hypot(x - c.x, y - c.y) <= c.r) return { x: x + S.x(c.x) - c.x, y: y + S.x(c.y) - c.y };
  return S.pt(x, y);
}

/**
 * "Frontline Crossing": a hand-designed, point-symmetric two player map.
 * A meandering river runs between the bases and is crossed by three bridges.
 * Drawn on 96 x 96 tiles and built on BIG_MAP: the design scales out from the centre
 * (designScale), the bases stay near the corners, and the room it gains holds more
 * forest, fields, ore and a few more hamlets.
 */
export function createFrontlineMap(): GameMap {
  const W = BIG_MAP;
  const H = BIG_MAP;
  const SEED = 1337;
  const cx = (W - 1) / 2;
  const cy = (H - 1) / 2;
  const S = designScale(W);
  const k = S.k;
  const T = (x: number, y: number) => S.tp(x, y);
  const Tr = (x: number, y: number) => ({ x: Math.round(S.ti(x)), y: Math.round(S.ti(y)) });

  const starts: Point[] = [
    { x: 17, y: 110 },
    { x: W - 1 - 17, y: H - 1 - 110 },
  ];

  // Features are described for player 0's half and mirrored through the center.
  const mirror = (p: Point): Point => ({ x: W - 1 - p.x, y: H - 1 - p.y });
  const half = <T extends Point>(arr: T[]) => [...arr, ...arr.map((p) => ({ ...p, ...mirror(p) }))];

  const oreFields = half([
    // the two by the base keep their distance from it (harvest runs as designed)
    { x: 29, y: 117, r: 3.6, kind: 1 },
    { x: 10, y: 96, r: 3.2, kind: 1 },
    { ...Tr(33, 62), r: 3.0, kind: 1 },
    { ...Tr(20, 46), r: 2.6, kind: 2 },
    { ...Tr(46, 89), r: 2.6, kind: 2 },
    // on the ground the bigger map gained: an outlying field on the western flank, gems by the farmstead
    { x: 6, y: 76, r: 3.0, kind: 1 },
    { x: 88, y: 121, r: 2.4, kind: 2 },
  ]);
  // derricks are 2 x 2 from their top-left tile: the mirrored footprint starts one tile further in
  const oils0 = [{ x: 32, y: 104 }, Tr(6, 50)];
  const oils = [...oils0, ...oils0.map((o) => ({ x: W - 2 - o.x, y: H - 2 - o.y }))];
  // rock ridges: centres scale, lengths stay
  const ridgeSrc = [
    { x: 24, y: 70, x2: 31, y2: 74 },
    { x: 40, y: 64, x2: 44, y2: 58 },
    { x: 12, y: 56, x2: 18, y2: 58 },
    { x: 54, y: 80, x2: 60, y2: 84 },
  ].map((r) => {
    const c = S.tp((r.x + r.x2) / 2, (r.y + r.y2) / 2);
    const hx = (r.x2 - r.x) / 2;
    const hy = (r.y2 - r.y) / 2;
    return { x: c.x - hx, y: c.y - hy, x2: c.x + hx, y2: c.y + hy };
  });
  // (ridge ends are continuous positions - the relief tests vertices, the rock tiles their centres - so they mirror through W, H)
  const ridges = [...ridgeSrc, ...ridgeSrc.map((r) => ({ x: W - r.x, y: H - r.y, x2: W - r.x2, y2: H - r.y2 }))];
  const roads: Point[][] = [
    [starts[0], T(30, 72), T(44, 60), { x: cx, y: cy }],
    [starts[0], T(30, 84), T(52, 82), T(64, 76)],
    [starts[0], T(12, 62), T(18, 44), T(24, 30)],
  ];
  const allRoads = [...roads, ...roads.map((r) => r.map(mirror))];

  // River geometry: centerline x == y, meandering perpendicular to it.
  const riverOffset = (s: number) => k * (4.5 * Math.sin(((s - cx) * 0.11) / k) + 1.5 * Math.sin(((s - cx) * 0.31) / k));
  const riverDist = (x: number, y: number) => {
    const s = (x + y) / 2;
    const d = (x - y) / Math.SQRT2;
    return Math.abs(d - riverOffset(s));
  };
  const bridgeS = [cx, cx - 27 * k, cx + 27 * k];

  // point-symmetric noise on vertices (vx -> W - vx)
  const symNoise = (x: number, y: number, scale: number, seed: number) =>
    (fbm(x * scale, y * scale, seed) + fbm((W - x) * scale, (H - y) * scale, seed)) / 2;
  // tiles mirror through x -> W - 1 - x: player 0's half (the larger tile indices) is the original field and
  // player 1's half repeats it mirrored (fair starts; the seam is a one-tile shift of a smooth field)
  const p0Tile = (x: number, y: number) => y * W + x >= (H - 1 - y) * W + (W - 1 - x);
  const symNoiseT = (x: number, y: number, scale: number, seed: number) => (p0Tile(x, y) ? symNoise(x, y, scale, seed) : symNoise(W - 1 - x, H - 1 - y, scale, seed));
  const canonT = (x: number, y: number, seed: number) => (p0Tile(x, y) ? hash2(x, y, seed) : hash2(W - 1 - x, H - 1 - y, seed));
  const canonV = (vx: number, vy: number, seed: number) => (vy * (W + 1) + vx >= (H - vy) * (W + 1) + (W - vx) ? hash2(vx, vy, seed) : hash2(W - vx, H - vy, seed));
  const kindHash = (x: number, y: number) => hash2(Math.min(x, W - 1 - x), Math.min(y, H - 1 - y) + (x < W - 1 - x ? 0 : 1000), 11);

  const heights = new Float32Array((W + 1) * (H + 1));
  for (let vy = 0; vy <= H; vy++) {
    for (let vx = 0; vx <= W; vx++) {
      let h = (symNoise(vx, vy, 0.055, SEED) - 0.5) * 2.4 + 0.5;
      // flatten bases
      for (const s of starts) {
        const d = Math.hypot(vx - s.x - 0.5, vy - s.y - 0.5);
        h = h + (0.45 - h) * (1 - smoothstep(9, 15, d));
      }
      // river carving
      const rd = riverDist(vx - 0.5, vy - 0.5);
      h = h + (-0.9 - h) * (1 - smoothstep(1.6, 3.6, rd));
      // ridges
      for (const r of ridges) {
        const d = distToSegment(vx, vy, r.x, r.y, r.x2, r.y2);
        h += 1.6 * (1 - smoothstep(0.6, 2.4, d)) * (0.85 + 0.3 * canonV(vx, vy, 99));
      }
      heights[vy * (W + 1) + vx] = h;
    }
  }

  const tiles = new Uint8Array(W * H);
  const trees = new Uint8Array(W * H);
  const ore = new Uint8Array(W * H);
  const oreKind = new Uint8Array(W * H);

  const nearStart = (x: number, y: number, r: number) => starts.some((s) => Math.hypot(x - s.x, y - s.y) < r);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const fx = x + 0.5;
      const fy = y + 0.5;
      const rd = riverDist(x, y);
      let t: Tile = Tile.Grass;
      const s = (x + y) / 2;
      if (rd < 2.3) {
        t = Tile.Water;
        for (const bs of bridgeS) if (Math.abs(s - bs) <= 1.0) t = Tile.Bridge;
      } else if (rd < 3.4) {
        t = Tile.Sand;
      } else {
        const n = symNoiseT(x, y, 0.09, SEED + 5);
        if (n > 0.6) t = Tile.Dirt;
      }
      for (const r of ridges) {
        if (distToSegment(fx, fy, r.x, r.y, r.x2, r.y2) < 1.15) t = Tile.Rock;
      }
      tiles[i] = t;
    }
  }

  // Roads (visual dirt paths, passable)
  for (const road of allRoads) {
    for (let k = 0; k < road.length - 1; k++) {
      const a = road[k];
      const b = road[k + 1];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (tiles[i] !== Tile.Grass && tiles[i] !== Tile.Dirt && tiles[i] !== Tile.Sand) continue;
          if (distToSegment(x + 0.5, y + 0.5, a.x + 0.5, a.y + 0.5, b.x + 0.5, b.y + 0.5) < 0.9) tiles[i] = Tile.Dirt;
        }
      }
    }
  }

  // Ore fields
  for (const f of oreFields) {
    for (let y = Math.floor(f.y - f.r - 1); y <= f.y + f.r + 1; y++) {
      for (let x = Math.floor(f.x - f.r - 1); x <= f.x + f.r + 1; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        if (tiles[i] === Tile.Water || tiles[i] === Tile.Rock || tiles[i] === Tile.Bridge) continue;
        const d = Math.hypot(x - f.x, y - f.y);
        const jitter = (hash2(x, y, 7) + hash2(W - 1 - x, H - 1 - y, 7)) / 2;
        if (d < f.r + jitter * 1.2 - 0.6) {
          oreKind[i] = f.kind;
          ore[i] = Math.max(2, Math.round(ORE_MAX * (1 - d / (f.r + 1.5)) + 2));
          if (ore[i] > ORE_MAX) ore[i] = ORE_MAX;
          if (tiles[i] === Tile.Sand) tiles[i] = Tile.Dirt;
        }
      }
    }
  }

  const reserved = (x: number, y: number) =>
    nearStart(x, y, 10) ||
    oils.some((o) => Math.abs(x - o.x - 0.5) < 3 && Math.abs(y - o.y - 0.5) < 3) ||
    oreFields.some((f) => Math.hypot(x - f.x, y - f.y) < f.r + 2.5);

  // Trees: forest patches + scattered singles, symmetric
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (tiles[i] !== Tile.Grass || reserved(x, y)) continue;
      if (riverDist(x, y) < 4.5) continue;
      const n = symNoiseT(x, y, 0.07, SEED + 31);
      const single = (hash2(x, y, 3) + hash2(W - 1 - x, H - 1 - y, 3)) / 2;
      const kindSel = p0Tile(x, y) ? kindHash(x, y) : kindHash(W - 1 - x, H - 1 - y);
      if (n > 0.64 || single > 0.93) trees[i] = kindSel < 0.6 ? 1 : 2;
    }
  }
  // Edge forest frame for looks
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const e = Math.min(x, y, W - 1 - x, H - 1 - y);
      if (e < 2 && tiles[i] === Tile.Grass && !reserved(x, y) && canonT(x, y, 5) < 0.55) trees[i] = 1 + (canonT(x, y, 6) < 0.5 ? 0 : 1);
    }
  }

  const { structures, blocked } = placeStructures(W, H, tiles, trees, ore, heights, starts, oils, oreFields, allRoads, mirror, frontlineLayout(W));

  const bridges = bridgeS.map((s) => {
    // bridge center lies on the river centerline at diagonal coordinate s
    const d = riverOffset(s);
    const x = s + d / Math.SQRT2;
    const y = s - d / Math.SQRT2;
    return { x: x + 0.5, y: y + 0.5, angle: -Math.PI / 4, length: 7.5 };
  });
  const sites = (at: [number, number][]) => at.map(([x, y]) => [Math.round(S.ti(x)), Math.round(S.ti(y))] as [number, number]);

  return {
    name: 'Frontline Crossing',
    id: 'frontline',
    biome: 'temperate',
    w: W,
    h: H,
    tiles,
    heights,
    trees,
    ore,
    oreKind,
    oreMines: oreFields.map((f) => ({ x: Math.round(f.x), y: Math.round(f.y) })),
    starts,
    oils,
    bridges,
    roads: allRoads,
    structures,
    blocked,
    // capturable tech sites (sim/capture.ts): the 96 x 96 candidates scaled out, and a second field hospital on the new ground
    techSites: [
      { def: 'tech_hospital', at: sites([[18, 60], [14, 40], [22, 66], [12, 44], [28, 44]]) },
      { def: 'tech_comms', at: sites([[54, 88], [36, 82], [22, 90], [40, 86], [52, 66]]) },
      { def: 'tech_airport', at: sites([[6, 30], [8, 24], [4, 36], [10, 34], [12, 28]]) },
      { def: 'tech_hospital', at: [[44, 100], [36, 98], [52, 104], [24, 94], [60, 96]] },
    ],
  };
}

/** Frontline Crossing's villages, farmsteads and hamlets (player 0's half), on a map of w tiles. */
function frontlineLayout(w: number): Structure[] {
  // a cluster's houses keep their spacing: they move with its anchor (FRONTLINE_CLUSTERS)
  const at = (st: Structure): Structure => {
    const p = frontlinePoint(w, st.x + st.w / 2, st.y + st.h / 2);
    return { ...st, x: Math.round(p.x - st.w / 2), y: Math.round(p.y - st.h / 2) };
  };
  const design: Structure[] = [
    // village west of the centre bridge, around an east-west lane at y ~ 52.5
    { kind: StructureKind.House, x: 25, y: 49, w: 2, h: 2, rot: 2 },
    { kind: StructureKind.Cottage, x: 28, y: 49, w: 2, h: 2, rot: 2 },
    { kind: StructureKind.House, x: 32, y: 49, w: 2, h: 2, rot: 2 },
    { kind: StructureKind.House, x: 24, y: 55, w: 2, h: 2, rot: 0 },
    { kind: StructureKind.Cottage, x: 29, y: 55, w: 2, h: 2, rot: 0 },
    { kind: StructureKind.Tower, x: 35, y: 54, w: 1, h: 1, rot: 0 },
    { kind: StructureKind.WaterTower, x: 36, y: 50, w: 1, h: 1, rot: 0 },
    // farmstead in the southern fields
    { kind: StructureKind.House, x: 58, y: 88, w: 2, h: 2, rot: 3 },
    { kind: StructureKind.Barn, x: 61, y: 88, w: 3, h: 2, rot: 0 }, // (x 62 on the 96 map: a tree stands there now)
    { kind: StructureKind.Silo, x: 62, y: 86, w: 1, h: 1, rot: 0 },
    // roadside hamlet on the highway to the centre bridge
    { kind: StructureKind.Cottage, x: 48, y: 73, w: 2, h: 2, rot: 1 },
    { kind: StructureKind.House, x: 52, y: 73, w: 2, h: 2, rot: 1 },
    { kind: StructureKind.Cottage, x: 49, y: 77, w: 2, h: 2, rot: 1 },
  ];
  return [...design.map(at), ...FRONTLINE_EXTRA];
}

/** The new ground of the 128 x 128 Frontline Crossing (map tile coordinates, player 0's half). */
const FRONTLINE_EXTRA: Structure[] = [
  // a farm hamlet south of the country road, between the base and the farmstead
  { kind: StructureKind.House, x: 45, y: 120, w: 2, h: 2, rot: 2 },
  { kind: StructureKind.Cottage, x: 48, y: 121, w: 2, h: 2, rot: 2 },
  { kind: StructureKind.Barn, x: 51, y: 120, w: 3, h: 2, rot: 2 },
  { kind: StructureKind.Silo, x: 55, y: 121, w: 1, h: 1, rot: 0 },
  // a hamlet on the western flank
  { kind: StructureKind.Cottage, x: 3, y: 53, w: 2, h: 2, rot: 1 },
  { kind: StructureKind.House, x: 3, y: 57, w: 2, h: 2, rot: 1 },
  { kind: StructureKind.House, x: 7, y: 56, w: 2, h: 2, rot: 0 },
  { kind: StructureKind.Tower, x: 7, y: 53, w: 1, h: 1, rot: 0 },
  // a ferryman's hamlet on the river bank above the southern bridge
  { kind: StructureKind.House, x: 92, y: 108, w: 2, h: 2, rot: 0 },
  { kind: StructureKind.Cottage, x: 95, y: 110, w: 2, h: 2, rot: 1 },
  { kind: StructureKind.Barn, x: 91, y: 112, w: 3, h: 2, rot: 0 },
  { kind: StructureKind.WaterTower, x: 96, y: 114, w: 1, h: 1, rot: 0 },
];

/**
 * Villages and farmsteads: a fixed layout for player 0's half, mirrored for
 * player 1. Every footprint is validated (open, flat ground away from bases,
 * ore, oil, roads and bridges) and a flood fill makes sure no structure cuts
 * off any part of the walkable map; anything that fails is simply skipped.
 */
function placeStructures(
  W: number,
  H: number,
  tiles: Uint8Array,
  trees: Uint8Array,
  ore: Uint8Array,
  heights: Float32Array,
  starts: Point[],
  oils: Point[],
  oreFields: (Point & { r: number })[],
  roads: Point[][],
  mirror: (p: Point) => Point,
  layout: Structure[],
) {
  const all = [
    ...layout,
    ...layout.map((st) => {
      const p = mirror({ x: st.x + st.w - 1, y: st.y + st.h - 1 });
      return { ...st, x: p.x, y: p.y, rot: (st.rot + 2) % 4 };
    }),
  ];
  const blocked = new Uint8Array(W * H);
  const structures: Structure[] = [];
  const vh = (vx: number, vy: number) => heights[vy * (W + 1) + vx];
  const roadDist = (x: number, y: number) => {
    let best = 1e9;
    for (const r of roads)
      for (let k = 0; k < r.length - 1; k++) best = Math.min(best, distToSegment(x, y, r[k].x + 0.5, r[k].y + 0.5, r[k + 1].x + 0.5, r[k + 1].y + 0.5));
    return best;
  };
  const okTile = (x: number, y: number) => {
    if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) return false;
    const i = y * W + x;
    if ((tiles[i] !== Tile.Grass && tiles[i] !== Tile.Dirt) || trees[i] || ore[i] || blocked[i]) return false;
    const cx = x + 0.5;
    const cy = y + 0.5;
    if (starts.some((s) => Math.hypot(cx - s.x, cy - s.y) < 16)) return false;
    if (oils.some((o) => Math.hypot(cx - o.x - 1, cy - o.y - 1) < 4.5)) return false;
    if (oreFields.some((f) => Math.hypot(cx - f.x, cy - f.y) < f.r + 2.2)) return false;
    if (roadDist(cx, cy) < 1.6) return false;
    const hs = [vh(x, y), vh(x + 1, y), vh(x, y + 1), vh(x + 1, y + 1)];
    if (Math.max(...hs) - Math.min(...hs) > 0.35) return false;
    return true;
  };
  // flood fill over walkable tiles, returns the reachable count from a start
  const reach = () => {
    const seen = new Uint8Array(W * H);
    const s0 = starts[0].y * W + starts[0].x;
    const q = [s0];
    seen[s0] = 1;
    let n = 0;
    while (q.length) {
      const t = q.pop()!;
      n++;
      const x = t % W;
      const y = (t / W) | 0;
      const nb = [x > 0 ? t - 1 : -1, x < W - 1 ? t + 1 : -1, y > 0 ? t - W : -1, y < H - 1 ? t + W : -1];
      for (const u of nb) {
        if (u < 0 || seen[u]) continue;
        if (tiles[u] === Tile.Water || tiles[u] === Tile.Rock || trees[u] || blocked[u]) continue;
        seen[u] = 1;
        q.push(u);
      }
    }
    return n;
  };
  let reachable = reach();
  for (const st of all) {
    let ok = true;
    // footprint plus a one tile walkable margin
    for (let y = st.y - 1; y <= st.y + st.h && ok; y++)
      for (let x = st.x - 1; x <= st.x + st.w && ok; x++) {
        const inside = x >= st.x && y >= st.y && x < st.x + st.w && y < st.y + st.h;
        if (inside ? !okTile(x, y) : x < 0 || y < 0 || x >= W || y >= H || blocked[y * W + x]) ok = false;
      }
    if (!ok) continue;
    for (let y = st.y; y < st.y + st.h; y++) for (let x = st.x; x < st.x + st.w; x++) blocked[y * W + x] = 1;
    const now = reach();
    if (now !== reachable - st.w * st.h) {
      for (let y = st.y; y < st.y + st.h; y++) for (let x = st.x; x < st.x + st.w; x++) blocked[y * W + x] = 0;
      continue;
    }
    reachable = now;
    structures.push(st);
  }
  return { structures, blocked };
}
