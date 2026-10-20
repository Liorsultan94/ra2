// Naval warfare (NV1): the water locomotion classes, the Shipyard and its coast placement rule, naval production,
// landing craft that carry tanks and soldiers across the sea, and the Shipyard's dockside repair.
//
// Water classes (slope.ts Loco), each with its own passability, regions and path finder (World.passes / regions
// / pfs), all built once per map:
// - Boat: water at least BOAT_DEPTH deep (the open sea past the reef's drop-off, the gulfs' channels);
// - Landing (landing craft): any water, the reef flats and the surf included, so it can beach to load and unload;
// - Hover (hovercraft): any water, plus open beach up to HOVER_REACH tiles inland of the waterline.
// Slopes do not apply to them. Boats and land units do not shove each other (World.separate): a boat by the
// shore and a tank on the beach are on different layers.
//
// The Shipyard (SHIP_W x SHIP_H) straddles the coast: at least SHIP_MIN_WATER of its tiles water (deep enough to
// float a hull, past the surf) and SHIP_MIN_LAND buildable land, each part in one piece (the shoreline runs across the footprint), the land part
// gentle enough to build on, and boat-deep water of the open sea (a water body of at least SEA_MIN boat tiles:
// narrow rivers do not qualify) in front of its slipway. Its slipway faces the water (Entity.slip); boats roll
// out of it into the sea. Every check is deterministic (the heights are the map's own floats, read the same way
// on every machine) and per tile.

import { buildingDef, unitDef } from './defs';
import { Tile, WATER_LEVEL, buildMaxRise, onBridgeHead, terrainPassable, tileOpen, type GameMap } from './map';
import { Loco, groundRegions } from './slope';
import { TPS, type Entity, type UnitDef } from './types';
import type { World } from './world';

/** Depth below the waterline (height units, one = a tile's width) a boat needs. The reef flats are 0.07..0.25. */
export const BOAT_DEPTH = 0.4;
/** Smallest body of boat water (tiles) that counts as sea: the rivers of Frontline, Winter and Urban are smaller. */
export const SEA_MIN = 1200;
/** How far up the beach (tiles from the nearest water tile, Chebyshev) a hovercraft rides. */
export const HOVER_REACH = 2;
/** Shipyard footprint (tiles) and the share of it that must be sea / land. */
export const SHIP_W = 4;
export const SHIP_H = 4;
export const SHIP_MIN_WATER = 0.375;
export const SHIP_MIN_LAND = 0.375;
/**
 * A footprint tile counts as the yard's water part only this deep (height units): the surf at the waterline (the
 * reef flat's first tile, drawn as wet beach and foam) counts as neither water nor land.
 */
export const SHIP_WATER_DEPTH = 0.1;
/** The open sea must start within this many tiles of the slipway's mouth. */
export const SHIP_MOUTH_REACH = 4;
/**
 * A Shipyard may stand this far (tiles, gap between footprints) from its owner's other structures: coasts rarely
 * run right past a base, so a yard may reach out to the shore (the other structures keep World BUILD_RADIUS).
 */
export const SHIP_BUILD_RADIUS = 9;
/**
 * ...or anywhere on suitable coast this far (tiles, centre to centre) from one of its owner's Construction Yards:
 * on the Sinai (SN2) both bases stand inland, the nearest Shipyard coast 41 tiles from the west base and 48 from the
 * east one, too far to creep out to with structures, so the Construction Yard can put a yard down on the shore.
 */
export const SHIP_YARD_REACH = 56;
/** Cargo slots a vehicle takes in a landing craft (a soldier takes 1). */
export const NAVAL_VEHICLE_SLOTS = 3;
/** Landing craft: a unit boards when this close to it (tiles, centre to centre)... */
export const EMBARK_REACH = 2.2;
/** ...or when standing by its own Shipyard while the craft lies within this distance of the yard. */
export const EMBARK_YARD = 4;
/** Unloading: landing spots up to this far from the craft. */
export const UNLOAD_REACH = 3.5;
/** Dockside repair: naval units within this distance of an own Shipyard regain this share of their hp per second. */
export const DOCK_REPAIR_RANGE = 2.5;
export const DOCK_REPAIR_RATE = 0.02;

/** Why a Shipyard can or can't stand at a footprint (the HUD shows `reason`). */
export interface ShipSite {
  ok: boolean;
  reason: string;
  /** Slipway direction 0 +x, 1 +y, 2 -x, 3 -y (towards the water part). */
  dir: number;
  water: number;
  land: number;
}

const DIRS: [number, number][] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

/** Depth of the water at a tile (height units below the waterline at its centre; <= 0 on land). */
export function tileDepth(m: GameMap, x: number, y: number): number {
  const W1 = m.w + 1;
  const H = m.heights;
  const i = y * W1 + x;
  return WATER_LEVEL - (H[i] + H[i + 1] + H[i + W1] + H[i + W1 + 1]) * 0.25;
}

/** Naval terrain of a map: per water class, the tiles it may use before any structure stands (Boat, Landing, Hover). */
export interface NavalTerrain {
  base: Uint8Array[];
  /** Per tile: 1 = boat water of a body of at least SEA_MIN tiles (the open sea). */
  sea: Uint8Array;
  /** Boat water tiles in the sea. */
  seaTiles: number;
}

export function navalTerrain(m: GameMap): NavalTerrain {
  const { w: W, h: H } = m;
  const n = W * H;
  const water = new Uint8Array(n);
  const boat = new Uint8Array(n);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (m.tiles[i] !== Tile.Water) continue;
      water[i] = 1;
      if (tileDepth(m, x, y) >= BOAT_DEPTH) boat[i] = 1;
    }
  // hovercraft: the water and the open beach just inland of it
  const hover = water.slice();
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (water[i] || !terrainPassable(m, x, y) || m.tiles[i] === Tile.Bridge) continue;
      let near = false;
      for (let oy = -HOVER_REACH; oy <= HOVER_REACH && !near; oy++)
        for (let ox = -HOVER_REACH; ox <= HOVER_REACH; ox++) {
          const xx = x + ox;
          const yy = y + oy;
          if (xx >= 0 && yy >= 0 && xx < W && yy < H && water[yy * W + xx]) {
            near = true;
            break;
          }
        }
      if (near) hover[i] = 1;
    }
  // the open sea: boat water bodies of at least SEA_MIN tiles
  const reg = groundRegions(W, H, boat);
  const size = new Map<number, number>();
  for (let i = 0; i < n; i++) if (reg[i]) size.set(reg[i], (size.get(reg[i]) ?? 0) + 1);
  const sea = new Uint8Array(n);
  let seaTiles = 0;
  for (let i = 0; i < n; i++)
    if (reg[i] && (size.get(reg[i]) ?? 0) >= SEA_MIN) {
      sea[i] = 1;
      seaTiles++;
    }
  return { base: [boat, water, hover], sea, seaTiles };
}

/**
 * Terrain check of a Shipyard footprint with its top-left tile at (tx, ty): the coast rule (see the header).
 * `free(i)`: tile i is not taken by another structure (the world's occupancy; terrain-only checks pass () => true).
 */
export function shipSite(m: GameMap, sea: Uint8Array, tx: number, ty: number, free: (i: number) => boolean = () => true, w = SHIP_W, h = SHIP_H): ShipSite {
  const out: ShipSite = { ok: false, reason: '', dir: 0, water: 0, land: 0 };
  const W = m.w;
  if (tx < 0 || ty < 0 || tx + w > W || ty + h > m.h) {
    out.reason = 'Off the map';
    return out;
  }
  const kind = new Int8Array(w * h); // 1 water, 2 land, 3 surf (neither)
  let wx = 0;
  let wy = 0;
  let lx = 0;
  let ly = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const gx = tx + x;
      const gy = ty + y;
      const i = gy * W + gx;
      if (!free(i)) {
        out.reason = 'Blocked by a structure';
        return out;
      }
      const t = m.tiles[i];
      if (t === Tile.Water && tileDepth(m, gx, gy) < SHIP_WATER_DEPTH) {
        kind[y * w + x] = 3;
      } else if (t === Tile.Water) {
        kind[y * w + x] = 1;
        out.water++;
        wx += x;
        wy += y;
      } else if (tileOpen(m, gx, gy) && !onBridgeHead(m, gx, gy)) {
        kind[y * w + x] = 2;
        out.land++;
        lx += x;
        ly += y;
      } else {
        out.reason = t === Tile.Rock ? 'Rocks in the way' : 'Ground blocked (trees, ore or a bridge)';
        return out;
      }
    }
  const n = w * h;
  if (out.water < Math.ceil(n * SHIP_MIN_WATER)) {
    out.reason = out.water === 0 ? 'Must stand half in the sea: no water here' : 'Must stand half in the sea: too little water';
    return out;
  }
  if (out.land < Math.ceil(n * SHIP_MIN_LAND)) {
    out.reason = 'Must stand half on land: too little shore';
    return out;
  }
  // each part in one piece: the shoreline runs across the footprint
  for (const k of [1, 2]) {
    const seen = new Uint8Array(n);
    let first = -1;
    for (let i = 0; i < n; i++) if (kind[i] === k) (first = i), (i = n);
    const q = [first];
    seen[first] = 1;
    let cnt = 0;
    while (q.length) {
      const c = q.pop()!;
      cnt++;
      const cx = c % w;
      const cy = (c / w) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!seen[j] && kind[j] === k) (seen[j] = 1), q.push(j);
      }
    }
    if (cnt !== (k === 1 ? out.water : out.land)) {
      out.reason = 'The shoreline must run straight across the yard';
      return out;
    }
  }
  // the land part gentle enough to build on (its own vertices only: the slipway runs down into the water)
  let lo = Infinity;
  let hi = -Infinity;
  const W1 = W + 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (kind[y * w + x] !== 2) continue;
      for (let vy = 0; vy < 2; vy++)
        for (let vx = 0; vx < 2; vx++) {
          const v = m.heights[(ty + y + vy) * W1 + tx + x + vx];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
    }
  if (hi - lo > buildMaxRise(w, h)) {
    out.reason = 'The shore is too steep';
    return out;
  }
  // the slipway faces the water: the main axis of land centroid -> water centroid
  const dx = wx / out.water - lx / out.land;
  const dy = wy / out.water - ly / out.land;
  out.dir = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 2) : dy >= 0 ? 1 : 3;
  // open sea in front of the slipway
  const [mx, my] = mouthTile(tx, ty, w, h, out.dir);
  let open = false;
  for (let r = 0; r <= SHIP_MOUTH_REACH && !open; r++)
    for (let oy = -r; oy <= r && !open; oy++)
      for (let ox = -r; ox <= r; ox++) {
        if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
        const x = mx + ox;
        const y = my + oy;
        if (x < 0 || y < 0 || x >= W || y >= m.h) continue;
        if (x >= tx && x < tx + w && y >= ty && y < ty + h) continue;
        if (sea[y * W + x]) {
          open = true;
          break;
        }
      }
  if (!open) {
    out.reason = 'No open sea in front of the slipway (a river or a lagoon is too small)';
    return out;
  }
  out.ok = true;
  return out;
}

/** The tile just outside a footprint in the middle of its side `dir` (the slipway's mouth). */
export function mouthTile(tx: number, ty: number, w: number, h: number, dir: number): [number, number] {
  switch (dir) {
    case 0:
      return [tx + w, ty + (h >> 1)];
    case 1:
      return [tx + (w >> 1), ty + h];
    case 2:
      return [tx - 1, ty + (h >> 1)];
    default:
      return [tx + (w >> 1), ty - 1];
  }
}

/** Every footprint on the map where a Shipyard could stand, terrain-wise (top-left tile indices): for the AI, tests and the HUD. */
export function shipSpots(m: GameMap, sea: Uint8Array): number[] {
  const out: number[] = [];
  for (let ty = 0; ty + SHIP_H <= m.h; ty++)
    for (let tx = 0; tx + SHIP_W <= m.w; tx++) {
      // quick reject: a footprint needs both water and land among its corners' neighbourhood
      let wtr = 0;
      for (let y = ty; y < ty + SHIP_H; y++) for (let x = tx; x < tx + SHIP_W; x++) if (m.tiles[y * m.w + x] === Tile.Water) wtr++;
      if (wtr < SHIP_W * SHIP_H * SHIP_MIN_WATER || wtr > SHIP_W * SHIP_H * (1 - SHIP_MIN_LAND)) continue;
      if (shipSite(m, sea, tx, ty).ok) out.push(ty * m.w + tx);
    }
  return out;
}

// ---------------------------------------------------------------- units

export function isNaval(d: { naval?: unknown }): boolean {
  return !!d.naval;
}

/** Does this entity carry cargo across the water (a landing craft / hovercraft)? */
export function isCarrier(e: Entity | undefined): boolean {
  return !!e && e.kind === 'unit' && !!unitDef(e.def).cargoSlots;
}

/** Cargo slots a unit takes aboard a landing craft (0: it can't board one). */
export function cargoSize(defId: string): number {
  const d = unitDef(defId);
  if (!d || d.kind !== 'unit' || d.air || d.naval || d.temp || d.supply) return 0;
  return d.category === 'infantry' ? 1 : d.category === 'vehicle' ? NAVAL_VEHICLE_SLOTS : 0;
}

/** Free cargo slots aboard a craft. */
export function cargoRoom(w: World, craft: Entity): number {
  let used = 0;
  for (const id of craft.passengers) {
    const p = w.get(id);
    if (p) used += cargoSize(p.def);
  }
  return (unitDef(craft.def).cargoSlots ?? 0) - used;
}

/** The Shipyard a naval unit rolls out of: the owner's yard with a rally point set, else any of them. */
export function shipyardFor(w: World, owner: number): Entity | null {
  let yard: Entity | null = null;
  for (const e of w.list) {
    if (e.dead || e.owner !== owner || e.kind !== 'building' || !buildingDef(e.def).shipyard) continue;
    yard = e;
    if (e.rallyX >= 0) break;
  }
  return yard;
}

/** Launch point of a new naval unit of class `lc` at a yard: the nearest water it can sail from the slipway's mouth. */
export function launchSpot(w: World, yard: Entity, lc: number): [number, number] | null {
  const d = buildingDef(yard.def);
  const dir = yard.slip ?? 0;
  const [mx, my] = mouthTile(yard.tx, yard.ty, d.w, d.h, dir);
  const pass = w.passes[lc];
  const { w: W, h: H } = w.map;
  const sea = w.naval.sea;
  for (let r = 0; r <= 8; r++)
    for (let oy = -r; oy <= r; oy++)
      for (let ox = -r; ox <= r; ox++) {
        if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
        // (straight out of the slipway first)
        const x = mx + ox + DIRS[dir][0] * (r > 0 ? 1 : 0);
        const y = my + oy + DIRS[dir][1] * (r > 0 ? 1 : 0);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        if (pass[i] && (lc !== Loco.Boat || sea[i])) return [x, y];
      }
  return null;
}

/** Roll a finished naval unit out of the yard's slipway and send it to the rally point (on the water). */
export function deliverNaval(w: World, owner: number, d: UnitDef): Entity | null {
  const yard = shipyardFor(w, owner);
  if (!yard) return null;
  const lc = w.locoOfDef(d);
  const spot = launchSpot(w, yard, lc);
  if (!spot) return null;
  const dir = yard.slip ?? 0;
  const u = w.spawnUnit(d.id, owner, spot[0] + 0.5, spot[1] + 0.5);
  u.facing = u.pfacing = u.turret = u.pturret = (dir * Math.PI) / 2;
  w.events.push({ t: 'unitReady', owner, def: d.id });
  const rx = yard.rallyX >= 0 ? yard.rallyX : spot[0] + 0.5 + DIRS[dir][0] * 3 + w.rng.range(-1.5, 1.5) * (1 - Math.abs(DIRS[dir][0]));
  const ry = yard.rallyY >= 0 ? yard.rallyY : spot[1] + 0.5 + DIRS[dir][1] * 3 + w.rng.range(-1.5, 1.5) * (1 - Math.abs(DIRS[dir][1]));
  w.formationMove([u], rx, ry, false);
  u.guardX = u.order.type === 'move' ? u.order.x : rx;
  u.guardY = u.order.type === 'move' ? u.order.y : ry;
  return u;
}

// ---------------------------------------------------------------- landing craft

/** Is there ground (passable for class c) within `r` tiles of (x, y)? */
function landNear(w: World, x: number, y: number, r: number, c: number = Loco.Foot): [number, number] | null {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  const pass = w.passes[c];
  const reg = w.regions[c];
  const { w: W, h: H } = w.map;
  let best: [number, number] | null = null;
  let bd = Infinity;
  const R = Math.ceil(r);
  for (let oy = -R; oy <= R; oy++)
    for (let ox = -R; ox <= R; ox++) {
      const tx = cx + ox;
      const ty = cy + oy;
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      const i = ty * W + tx;
      if (!pass[i] || !reg[i]) continue;
      const d = Math.hypot(tx + 0.5 - x, ty + 0.5 - y);
      if (d <= r && d < bd) {
        bd = d;
        best = [tx, ty];
      }
    }
  return best;
}

/** Is the craft lying at a beach (land within reach to put its cargo ashore)? */
export function atBeach(w: World, craft: Entity): boolean {
  return !!landNear(w, craft.x, craft.y, UNLOAD_REACH - 0.6);
}

/**
 * A unit with an 'enter' order on a landing craft (World.updateUnit): board once beside it, at a beach or by the
 * Shipyard; otherwise go to the shore nearest it and wait there while it is on its way. Returns false when the
 * order is over (the caller makes the unit idle).
 */
export function stepEmbark(w: World, e: Entity, craft: Entity): boolean {
  const size = cargoSize(e.def);
  if (!size || craft.dead || craft.owner !== e.owner || cargoRoom(w, craft) < size) return false;
  const dist = Math.hypot(craft.x - e.x, craft.y - e.y);
  let near = dist <= EMBARK_REACH;
  if (!near) {
    // loading at the Shipyard's quay: beside the yard while the craft lies off its slipway
    for (const b of w.list) {
      if (b.dead || b.owner !== e.owner || b.kind !== 'building' || !buildingDef(b.def).shipyard) continue;
      if (w.distTo(e, b) <= 1.2 && w.distTo(craft, b) <= EMBARK_YARD) {
        near = true;
        break;
      }
    }
  }
  if (near) {
    w.board(e, craft);
    return true;
  }
  // walk to the shore nearest the craft and wait for it
  const lc = w.locoOf(e);
  if (!e.path || w.tick >= e.repathAt) {
    const spot = w.nearestPassable(craft.x, craft.y, 12, w.regionOf(e.x, e.y, lc), lc);
    if (spot && Math.hypot(spot[0] + 0.5 - e.x, spot[1] + 0.5 - e.y) > 0.6 && (spot[1] * w.map.w + spot[0] !== e.moveGoal || !e.path)) w.pathTo(e, spot[0] + 0.5, spot[1] + 0.5);
    e.repathAt = w.tick + 30 + (e.id % 7);
  }
  if (e.path) w.walk(e, unitDef(e.def));
  else e.moving = false;
  return true;
}

/**
 * Units told to board a craft: an idle craft comes to the beach nearest them (World 'enter' command).
 */
export function callCraft(w: World, craft: Entity, units: Entity[]) {
  if (!units.length || craft.order.type !== 'idle' || craft.passengers.length >= (unitDef(craft.def).cargoSlots ?? 0)) return;
  let sx = 0;
  let sy = 0;
  for (const u of units) {
    sx += u.x;
    sy += u.y;
  }
  sx /= units.length;
  sy /= units.length;
  if (Math.hypot(craft.x - sx, craft.y - sy) <= EMBARK_REACH + 1) return;
  const lc = w.locoOf(craft);
  const spot = beachSpot(w, sx, sy, w.regionOf(craft.x, craft.y, lc), lc);
  if (spot) w.formationMove([craft], spot[0] + 0.5, spot[1] + 0.5, false);
}

/** The water tile (class lc, region) nearest (x, y) that lies at a beach (open ground within reach). */
export function beachSpot(w: World, x: number, y: number, region: number, lc: number, maxR = 14): [number, number] | null {
  const pass = w.passes[lc];
  const reg = w.regions[lc];
  const { w: W, h: H } = w.map;
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  let best: [number, number] | null = null;
  let bd = Infinity;
  for (let oy = -maxR; oy <= maxR; oy++)
    for (let ox = -maxR; ox <= maxR; ox++) {
      const tx = cx + ox;
      const ty = cy + oy;
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      const i = ty * W + tx;
      if (!pass[i] || (region && reg[i] !== region)) continue;
      const d = ox * ox + oy * oy;
      if (d >= bd) continue;
      if (!landNear(w, tx + 0.5, ty + 0.5, 1.6)) continue;
      bd = d;
      best = [tx, ty];
    }
  return best;
}

/**
 * Put a craft's cargo ashore on the beach beside it, towards (gx, gy) (default: the nearest land). Vehicles first,
 * one per tile, soldiers three to a tile, each on ground its class can use. Those who made it ashore then move
 * on to (gx, gy) when given. Returns the number unloaded (0: no beach within reach).
 */
export function unloadCraft(w: World, craft: Entity, gx?: number, gy?: number): number {
  const ashore = landNear(w, craft.x, craft.y, UNLOAD_REACH);
  if (!ashore) return 0;
  const tx0 = gx ?? ashore[0] + 0.5;
  const ty0 = gy ?? ashore[1] + 0.5;
  const dl = Math.hypot(tx0 - craft.x, ty0 - craft.y) || 1;
  // aim the landing a little towards the goal
  const ax = craft.x + ((tx0 - craft.x) / dl) * 1.5;
  const ay = craft.y + ((ty0 - craft.y) / dl) * 1.5;
  const { w: W, h: H } = w.map;
  const taken = new Map<number, number>();
  const out: Entity[] = [];
  const pax = craft.passengers
    .map((id) => w.get(id))
    .filter((p): p is Entity => !!p)
    .sort((a, b) => cargoSize(b.def) - cargoSize(a.def) || a.id - b.id);
  const left: number[] = [];
  for (const p of pax) {
    const lc = w.locoOf(p);
    const pass = w.passes[lc];
    const reg = w.regions[lc];
    const cap = cargoSize(p.def) === 1 ? 3 : 1;
    let spot: [number, number] | null = null;
    let bd = Infinity;
    const R = Math.ceil(UNLOAD_REACH) + 1;
    const cx = Math.floor(craft.x);
    const cy = Math.floor(craft.y);
    for (let oy = -R; oy <= R; oy++)
      for (let ox = -R; ox <= R; ox++) {
        const tx = cx + ox;
        const ty = cy + oy;
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        const i = ty * W + tx;
        if (!pass[i] || !reg[i] || w.occ[i]) continue;
        if (Math.hypot(tx + 0.5 - craft.x, ty + 0.5 - craft.y) > UNLOAD_REACH) continue;
        const used = taken.get(i) ?? 0;
        if (used >= 100 || (cap === 1 && used > 0) || used >= cap) continue;
        const d = Math.hypot(tx + 0.5 - ax, ty + 0.5 - ay) + used * 0.3;
        if (d < bd) {
          bd = d;
          spot = [tx, ty];
        }
      }
    if (!spot) {
      left.push(p.id);
      continue;
    }
    const i = spot[1] * W + spot[0];
    const used = taken.get(i) ?? 0;
    taken.set(i, cap === 1 ? 100 : used + 1);
    p.inside = -1;
    const off = cap === 3 ? [[-0.22, -0.18], [0.22, -0.18], [0, 0.22]][used % 3] : [0, 0];
    p.x = p.px = spot[0] + 0.5 + off[0];
    p.y = p.py = spot[1] + 0.5 + off[1];
    p.facing = p.pfacing = p.turret = p.pturret = Math.atan2(p.y - craft.y, p.x - craft.x);
    p.order = { type: 'idle' };
    p.path = null;
    p.guardX = p.x;
    p.guardY = p.y;
    p.scanAt = w.tick + 2;
    out.push(p);
  }
  craft.passengers = left;
  if (out.length) {
    w.events.push({ t: 'unloaded', id: craft.id, owner: craft.owner, x: craft.x, y: craft.y, n: out.length });
    // on to the beachhead goal
    if (gx !== undefined && gy !== undefined) w.formationMove(out, gx, gy, false);
  }
  return out.length;
}

/**
 * A craft at the end of its move with a landing order (Entity.landing): unload, or, with no beach in reach,
 * head for the beach nearest the goal (once).
 */
export function arriveLanding(w: World, craft: Entity) {
  const l = craft.landing;
  if (!l) return;
  craft.landing = null;
  if (!craft.passengers.length) return;
  if (unloadCraft(w, craft, l.x, l.y) > 0 || l.last) return;
  const lc = w.locoOf(craft);
  const spot = beachSpot(w, l.x, l.y, w.regionOf(craft.x, craft.y, lc), lc);
  if (spot && Math.hypot(spot[0] + 0.5 - craft.x, spot[1] + 0.5 - craft.y) > 1) {
    w.formationMove([craft], spot[0] + 0.5, spot[1] + 0.5, false);
    // (once: at that beach it unloads whatever lies in reach, or gives up)
    craft.landing = { x: l.x, y: l.y, last: true };
  }
}

/** Deploy command on a loaded craft: unload here, or go to the nearest beach and unload there. */
export function orderUnload(w: World, craft: Entity) {
  if (!craft.passengers.length) return;
  if (unloadCraft(w, craft) > 0) return;
  const lc = w.locoOf(craft);
  const spot = beachSpot(w, craft.x, craft.y, w.regionOf(craft.x, craft.y, lc), lc, 18);
  if (!spot) return;
  w.formationMove([craft], spot[0] + 0.5, spot[1] + 0.5, false);
  craft.landing = { x: spot[0] + 0.5, y: spot[1] + 0.5 };
}

// ---------------------------------------------------------------- upkeep

/** Once a second: Shipyards patch up their own naval units alongside. */
export function updateNaval(w: World) {
  if (w.tick % TPS !== 0 || !w.naval.seaTiles) return;
  for (const b of w.list) {
    if (b.dead || b.kind !== 'building' || b.owner < 0 || b.buildAnim < 1 || !buildingDef(b.def).shipyard) continue;
    w.queryRadius(b.x, b.y, DOCK_REPAIR_RANGE + 3, (o) => {
      if (o.kind !== 'unit' || o.owner !== b.owner || o.hp >= o.maxHp || !unitDef(o.def).naval) return;
      if (w.distTo(o, b) > DOCK_REPAIR_RANGE) return;
      o.hp = Math.min(o.maxHp, o.hp + o.maxHp * DOCK_REPAIR_RATE);
    });
  }
}
