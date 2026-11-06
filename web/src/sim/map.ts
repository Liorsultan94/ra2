import { hash2 } from './rng';

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
   * no mirror player 1's own candidates `at2`), the first valid one is used (capture.ts). Absent: capture.ts's
   * defaults.
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
  /**
   * Irrigated plots / snowy fields (rectangles, row direction 0 = along x, 1 = along y). `crop`: what grows there
   * when the map knows (the Litani's real orchards and greenhouses), else the renderer picks.
   */
  fields: { x0: number; y0: number; x1: number; y1: number; rows: 0 | 1; crop?: 'orchard' | 'greenhouse' }[];
  /**
   * Farm plots at any angle (centre, half length along `ang` (radians, tile space), half width; tiles): the Litani's
   * orchards, greenhouses and fields. The renderer shrinks each to fit between the roads, tracks and houses.
   */
  plots?: { cx: number; cy: number; hl: number; hw: number; ang: number; crop?: 'orchard' | 'greenhouse' }[];
  /**
   * The river's course downstream (continuous map coordinates), when the map knows it (the Litani's real course,
   * meanders and all): the water renderer follows it instead of guessing a straight axis (render/water.ts RiverInfo).
   */
  river?: Point[];
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
  /**
   * The Mediterranean's coast as drawn by the map's owner (in place of `top`, wiggle included): its distance from the
   * map centre (as `top`) sampled every `step` tiles of screen east from `e0` (linear between; past the ends, the end
   * value). It runs on past the map (render/horizonworld.ts).
   */
  north?: { e0: number; step: number; off: number[] };
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
 * sample (i, j) at E = e0 + i * step, S = s0 + j * step, row-major, `d` in 1 / SEA_GRID_Q tiles (> 0 = water).
 */
export interface SeaGrid {
  cols: number;
  rows: number;
  e0: number;
  s0: number;
  step: number;
  d: Int16Array;
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
  return ((d[k] * (1 - tx) + d[k + 1] * tx) * (1 - ty) + (d[k + g.cols] * (1 - tx) + d[k + g.cols + 1] * tx) * ty) / SEA_GRID_Q;
}
/** SeaGrid's fixed point: steps per tile (to +-256 tiles). */
export const SEA_GRID_Q = 128;

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

/**
 * The top sea's coast at screen east e (tiles from the map's centre line): its distance from the centre, the wiggle
 * taken off (the coast is at s = -topCoast).
 */
export function topCoast(sea: SeaDeco, e: number): number {
  const nc = sea.north;
  if (!nc) return sea.top - seaWiggle(e);
  const f = Math.max(0, Math.min(nc.off.length - 1.0001, (e - nc.e0) / nc.step));
  const i = Math.floor(f);
  const t = f - i;
  // (a ragged edge on the owner's line: dunes, spits and small bays)
  return nc.off[i] * (1 - t) + nc.off[i + 1] * t - (0.9 * Math.sin(e * 0.23 + 0.4) + 0.55 * Math.sin(e * 0.57 + 1.9) + 0.3 * Math.sin(e * 1.31));
}

/** Seaward distance (tiles; > 0 = water) of the open seas only (the twin coasts past the map's top and bottom corners). */
export function openSeaDist(sea: SeaDeco, x: number, y: number) {
  const n = Math.SQRT1_2;
  const e = (x - y) * n;
  const s = (x + y - 2 * sea.c) * n;
  return Math.max(-s - topCoast(sea, e), s - sea.bottom + seaWiggle(e));
}

/**
 * Seaward distance (tiles; > 0 = water, < 0 = inland) at continuous map point (x, y): the open seas and the
 * gulfs (the island is land in the water: isleAt). Exactly symmetric under x <-> y on the mirrored map.
 */
export function seaDist(sea: SeaDeco, x: number, y: number): number {
  let best = openSeaDist(sea, x, y);
  if (sea.grid) {
    const n = Math.SQRT1_2;
    let d = gridSea(sea.grid, (x - y) * n, (x + y) * n);
    // (the owner's Mediterranean coast is not in the grid)
    if (sea.north) d = Math.max(d, -(x + y - 2 * sea.c) * n - topCoast(sea, (x - y) * n));
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

/**
 * Unit vector along a bridge deck (its `angle`, tile space), from ends[0] to ends[1]. Exactly (sqrt 1/2, -sqrt 1/2)
 * for the diagonal decks of the hand-drawn maps (angle -pi / 4), so their numbers stay bit for bit what they were.
 */
export function deckAxis(b: { angle: number }): { x: number; y: number } {
  if (b.angle === -Math.PI / 4) return { x: Math.SQRT1_2, y: -Math.SQRT1_2 };
  return { x: Math.cos(b.angle), y: Math.sin(b.angle) };
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
 * the forest or bank that walls it in (pockets behind a river bend or a village). Returns the
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
