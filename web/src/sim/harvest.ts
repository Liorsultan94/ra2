// Ore harvesters (deterministic lockstep): spreading over the ore field, the refinery dock queue, and the
// run home to unload and be repaired when attacked.
//
// Work cycle: seek -> toOre -> mining -> toRefinery -> unloading -> leaving -> seek.
//  - Ore claims: a harvester picks the nearest ore tile no other harvester is driving to or mining, and keeps
//    off tiles right next to a claimed one when it can, so a group spreads over the field instead of piling
//    onto one cell. A tile it failed to reach is avoided on the next pick (no ping-pong between two cells).
//  - Dock queue: one harvester at a time owns a refinery's dock (Entity.dockedBy) from the moment it is
//    granted the dock until it has driven out of the lane again. The others take a ticket (Entity.dockSeq)
//    once close, wait at distinct queue spots beside the refinery, off the dock lane and its apron, and are
//    granted the dock in ticket order. A harvester stuck in line switches to another refinery that is free.
//  - Right of way (World.separate): the harvester using the dock, then miners, then the rest.
//
// Under attack: a harvester hit by an enemy, or with a visible enemy combat unit within HV_THREAT_R tiles
// while it is away from the refinery, stops work and returns to the nearest own refinery, even with a partial
// load. It unloads what it carries (credited as usual), then parks on a spot beside the refinery off the dock
// lane and is repaired for free at HV_REPAIR_RATE while damaged. It goes back to work once fully repaired and
// its ore field has been calm (no hostile seen near it and no harvester hit there) for HV_CALM; if that field
// is still hot it takes another field when there is one, else waits. An explicit order from its owner cancels
// the trip, and for HV_ORDER_GRACE after one it does not run on its own. Hot fields are remembered per player
// (World.hvHot) so the other harvesters keep away from them too; at most one "harvester under attack" alert
// per HV_ALERT_GAP per player. The AI's harvesters follow the same rules.
//
// Plain arithmetic on entity state in tick order, no randomness.

import { buildingDef, unitDef } from './defs';
import { GEM_VALUE, ORE_VALUE } from './map';
import { TPS, type Entity, type HarvestFlee, type UnitDef } from './types';
import type { World } from './world';

export const HARVEST_CAPACITY = 900;
/** Free repair beside the refinery: fraction of max HP per second. */
export const HV_REPAIR_RATE = 0.03;
/** A visible enemy combat unit this close (tiles) sends a working harvester home. */
export const HV_THREAT_R = 5;
/** Radius (tiles) of an ore field around the point a harvester worked at, for the calm check. */
export const HV_FIELD_R = 7;
/** How far (path steps) from the tile its owner picked a harvester looks for ore on that field (pickOre). */
const HV_FIELD_KEEP = 10;
/** A field must have been calm this long (ticks) before a harvester goes back to it. */
export const HV_CALM = TPS * 15;
/** At most one "harvester under attack" alert per player this often (ticks). */
export const HV_ALERT_GAP = TPS * 20;
/** After an explicit order from its owner the harvester does not run home on its own for this long (ticks). */
export const HV_ORDER_GRACE = TPS * 10;
/** After going back to work, a hostile merely in sight does not send it home again for this long (ticks). */
export const HV_RESUME_COOLDOWN = TPS * 8;
/** Distance (tiles) from the dock at which a returning harvester takes its place in the queue. */
const QUEUE_NEAR = 6;
/** Ticks per ore unit mined. */
const MINE_TICKS = 7;
/** Credits unloaded per tick. */
const UNLOAD_RATE = 15;
/** A harvester making no headway towards its ore tile for this long (ticks) picks another. */
const STUCK_LIMIT = TPS * 3;
/** Least distance between two waiting / repair spots beside a refinery (tiles). */
const SPOT_GAP = 1.9;
/** Threat / calm scan period (ticks). */
const SCAN = 10;
/** A granted harvester that cannot reach the dock for this long goes to the back of the line. */
const APPROACH_LIMIT = TPS * 15;
/** Leaving the dock: the lane counts as clear this far from the dock (tiles), or after this many ticks. */
const LANE_CLEAR = 2.2;
const LEAVE_LIMIT = TPS * 5;

const DOCKING = new Set(['toRefinery', 'unloading', 'leaving']);

function isRefinery(b: Entity | undefined, owner: number): b is Entity {
  return !!b && !b.dead && b.kind === 'building' && b.owner === owner && !!buildingDef(b.def).dock;
}

function tileCenter(w: World, t: number): [number, number] {
  return [(t % w.map.w) + 0.5, Math.floor(t / w.map.w) + 0.5];
}

// ------------------------------------------------------------------ refinery geometry

/** Centre of the dock tile (world tiles). */
export function dockXY(ref: Entity): [number, number] {
  const dock = buildingDef(ref.def).dock!;
  return [ref.tx + dock[0] + 0.5, ref.ty + dock[1] + 0.5];
}

/** The dock lane's direction out of the refinery (unit grid step) and the exit tile (tile coords). */
function laneOf(ref: Entity): { ex: number; ey: number; sx: number; sy: number } {
  const bd = buildingDef(ref.def);
  const dock = bd.dock!;
  const exit = bd.exit ?? [dock[0], dock[1] + 1];
  const sx = Math.sign(exit[0] - dock[0]);
  const sy = Math.sign(exit[1] - dock[1]) || (sx === 0 ? 1 : 0);
  return { ex: ref.tx + exit[0], ey: ref.ty + exit[1], sx, sy };
}

/** Where a harvester leaving the dock drives to: two tiles out along the lane past the exit tile (centre). */
function apronXY(ref: Entity): [number, number] {
  const l = laneOf(ref);
  return [l.ex + l.sx * 2 + 0.5, l.ey + l.sy * 2 + 0.5];
}

/**
 * Spots beside a refinery (tile centres), off the dock lane and the apron in front of it: `repair` spots on
 * the sides and back of the building (where damaged harvesters park), `queue` spots in order of closeness
 * to the lane (where harvesters wait their turn). Spots are at least SPOT_GAP tiles apart.
 */
export function refinerySpots(w: World, ref: Entity): Spots {
  // cached per refinery for a second (they only change when something is built next to it)
  let per = spotCache.get(w);
  if (!per) spotCache.set(w, (per = new Map()));
  const c = per.get(ref.id);
  if (c && w.tick - c.at < TPS && c.at <= w.tick) return c.spots;
  const spots = computeSpots(w, ref);
  per.set(ref.id, { at: w.tick, spots });
  return spots;
}

type Spots = { queue: [number, number][]; repair: [number, number][] };
const spotCache = new WeakMap<World, Map<number, { at: number; spots: Spots }>>();

function computeSpots(w: World, ref: Entity): Spots {
  const bd = buildingDef(ref.def);
  const { w: W, h: H } = w.map;
  const l = laneOf(ref);
  const [ax, ay] = apronXY(ref);
  const cx = ref.tx + bd.w / 2;
  const cy = ref.ty + bd.h / 2;
  // along = how far out of the front (lane side) of the building a tile is; across = sideways from the lane
  const along = (x: number, y: number) => (x - (l.ex - l.sx)) * l.sx + (y - (l.ey - l.sy)) * l.sy;
  const across = (x: number, y: number) => Math.abs((x - l.ex) * l.sy) + Math.abs((y - l.ey) * l.sx);
  type C = { x: number; y: number; ring: number; a: number };
  const cands: C[] = [];
  for (let y = ref.ty - 4; y < ref.ty + bd.h + 4; y++) {
    for (let x = ref.tx - 4; x < ref.tx + bd.w + 4; x++) {
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
      const i = y * W + x;
      if (!w.pass[i] || w.occ[i]) continue;
      const ring = Math.max(ref.tx - x, x - (ref.tx + bd.w - 1), ref.ty - y, y - (ref.ty + bd.h - 1));
      if (ring < 1) continue;
      const a = along(x, y);
      // the lane and a 3-wide apron in front of the exit stay clear
      if (a >= 1 && a <= 4 && across(x, y) <= 1) continue;
      cands.push({ x, y, ring, a });
    }
  }
  const chosen: [number, number][] = [];
  // (a harvester is some 1.6 tiles long: spots this far apart keep parked ones from looking piled up)
  const spaced = (x: number, y: number) => chosen.every(([px, py]) => Math.hypot(px - x - 0.5, py - y - 0.5) >= SPOT_GAP);
  const repair: [number, number][] = [];
  const side = cands.filter((c) => c.ring <= 2 && c.a <= 0);
  // beside the middle of the building first (in view, and clear of the queue by the lane), then behind it
  const mid = -Math.floor((l.sy !== 0 ? bd.h : bd.w) / 2);
  side.sort((p, q) => p.ring - q.ring || Math.abs(p.a - mid) - Math.abs(q.a - mid) || Math.hypot(p.x + 0.5 - cx, p.y + 0.5 - cy) - Math.hypot(q.x + 0.5 - cx, q.y + 0.5 - cy) || p.y - q.y || p.x - q.x);
  for (const c of side) {
    if (repair.length >= 4) break;
    if (!spaced(c.x, c.y)) continue;
    repair.push([c.x + 0.5, c.y + 0.5]);
    chosen.push([c.x + 0.5, c.y + 0.5]);
  }
  const queue: [number, number][] = [];
  const front = cands.slice().sort((p, q) => Math.hypot(p.x + 0.5 - ax, p.y + 0.5 - ay) - Math.hypot(q.x + 0.5 - ax, q.y + 0.5 - ay) || p.y - q.y || p.x - q.x);
  for (const c of front) {
    if (queue.length >= 10) break;
    if (!spaced(c.x, c.y)) continue;
    queue.push([c.x + 0.5, c.y + 0.5]);
    chosen.push([c.x + 0.5, c.y + 0.5]);
  }
  return { queue, repair };
}

// ------------------------------------------------------------------ dock queue

/** Drop a dock reservation whose holder no longer uses it (dead, ordered elsewhere, gone to another refinery). */
function checkDock(w: World, ref: Entity) {
  if (ref.dockedBy < 0) return;
  const h = w.get(ref.dockedBy);
  if (!h || h.dead || h.order.type !== 'harvest' || h.targetId !== ref.id || !DOCKING.has(h.hstate)) ref.dockedBy = -1;
}

/** Harvesters of this refinery's owner waiting in its line (ticket taken, not the dock holder). */
function waiting(w: World, ref: Entity): Entity[] {
  const out: Entity[] = [];
  for (const h of w.list) {
    if (h.dead || h.kind !== 'unit' || h.owner !== ref.owner || h.dockSeq < 0 || h.targetId !== ref.id || h.id === ref.dockedBy) continue;
    if (h.order.type !== 'harvest' || h.hstate !== 'toRefinery') continue;
    out.push(h);
  }
  return out;
}

/** How busy a refinery is: the dock holder plus everyone in line (and those on their way to it). */
function load(w: World, ref: Entity, self: Entity): number {
  let n = ref.dockedBy >= 0 && ref.dockedBy !== self.id ? 1 : 0;
  for (const h of w.list) {
    if (h === self || h.dead || h.kind !== 'unit' || h.owner !== ref.owner || h.targetId !== ref.id || h.id === ref.dockedBy) continue;
    if (h.order.type === 'harvest' && h.hstate === 'toRefinery') n++;
  }
  return n;
}

/** The refinery to unload at: the nearest, a busy one counting as further away (8 tiles per harvester ahead). */
function pickRefinery(w: World, e: Entity, nearestOnly = false): Entity | null {
  let best: Entity | null = null;
  let bd = Infinity;
  for (const b of w.list) {
    if (!isRefinery(b, e.owner)) continue;
    checkDock(w, b);
    const [dx, dy] = dockXY(b);
    const cost = Math.hypot(dx - e.x, dy - e.y) + (nearestOnly ? 0 : load(w, b, e) * 8);
    if (cost < bd) {
      bd = cost;
      best = b;
    }
  }
  return best;
}

function leaveQueue(e: Entity) {
  e.dockSeq = -1;
  e.qspot = -1;
}

/**
 * A queue spot for a harvester joining the line: the free one nearest to it (a little preference for spots
 * close to the lane), so nobody crosses the lane to get to its spot. It keeps that spot until its turn.
 */
function takeSpot(e: Entity, line: Entity[], spots: [number, number][]): number {
  const used = new Set<number>();
  for (const h of line) if (h !== e && h.qspot >= 0) used.add(h.qspot);
  let best = -1;
  let bd = Infinity;
  spots.forEach(([x, y], i) => {
    if (used.has(i)) return;
    const c = Math.hypot(x - e.x, y - e.y) + i * 0.5;
    if (c < bd) {
      bd = c;
      best = i;
    }
  });
  return best >= 0 ? best : spots.length - 1;
}

// ------------------------------------------------------------------ ore

/** Ore tiles harvesters are driving to or mining (any owner), except `self`'s. */
function claims(w: World, self: Entity): Set<number> {
  const s = new Set<number>();
  for (const o of w.list) {
    if (o === self || o.dead || o.kind !== 'unit' || o.oreTile < 0) continue;
    if (o.order.type !== 'harvest' || (o.hstate !== 'toOre' && o.hstate !== 'mining') || o.hflee) continue;
    s.add(o.oreTile);
  }
  return s;
}

/**
 * The best ore tile for a harvester, searched outwards over passable ground from `start` (default: where it
 * is): the nearest one nobody has claimed, preferring tiles with no claimed neighbour and off hot fields.
 * `strict`: never a tile on a hot field (going back to work after an attack). -1 when there is none.
 */
export function findOre(w: World, e: Entity, start = w.tileOf(e.x, e.y), strict = false, maxDist = Infinity): number {
  const { w: W, h: H, ore } = w.map;
  const taken = claims(w, e);
  const hot = hotList(w, e.owner).map((f) => ({ x: f.x, y: f.y, far: Math.hypot(f.x - e.x, f.y - e.y) > HV_THREAT_R + 1 }));
  const seen = new Uint8Array(W * H);
  const queue = [start];
  const dist = [0];
  seen[start] = 1;
  let best = -1;
  let bestScore = Infinity;
  for (let qi = 0; qi < queue.length && qi < 6000; qi++) {
    const t = queue[qi];
    const dd = dist[qi];
    if (dd > bestScore || dd > maxDist) break;
    if (ore[t] > 0) {
      const x = t % W;
      const y = (t - x) / W;
      let score = dd;
      // a little extra for tiles behind it: a slow-turning harvester keeps working forwards
      if (dd > 0) score += (Math.abs(angleDiff(e.facing, Math.atan2(y + 0.5 - e.y, x + 0.5 - e.x))) / Math.PI) * 1.5;
      if (taken.has(t)) score += 400;
      else if (taken.size) score += crowding(taken, x, y, W);
      if (t === e.oreAvoid) score += 400;
      // on a hot field, or the way there runs past one (one it is at already does not count for the way)
      if (hot.length && hot.some((f) => Math.hypot(f.x - x - 0.5, f.y - y - 0.5) <= HV_FIELD_R || (f.far && segDist(f.x, f.y, e.x, e.y, x + 0.5, y + 0.5) <= HV_THREAT_R + 1))) {
        if (strict) score = Infinity;
        else score += 60;
      }
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    const x = t % W;
    const y = (t - x) / W;
    const push = (n: number) => {
      if (!seen[n] && w.pass[n]) {
        seen[n] = 1;
        queue.push(n);
        dist.push(dd + 1);
      }
    };
    if (x > 0) push(t - 1);
    if (x < W - 1) push(t + 1);
    if (y > 0) push(t - W);
    if (y < H - 1) push(t + W);
  }
  return best;
}

/**
 * Extra cost of an ore tile for its claimed neighbours: harvesters are some 1.6 tiles long, so two on tiles
 * next to each other look (and drive) piled up - keep a tile or two between them when there is room.
 */
function crowding(taken: Set<number>, x: number, y: number, W: number): number {
  let c = 0;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      if ((dx === 0 && dy === 0) || !taken.has((y + dy) * W + x + dx)) continue;
      c += Math.max(Math.abs(dx), Math.abs(dy)) === 1 ? 3 : 1;
    }
  return c;
}

/**
 * Next ore tile for a harvester: on the field its owner sent it to while that field has ore and is not under
 * attack (a crowd there queues or spreads over it, it does not wander off to the nearest field), else the
 * best one anywhere.
 */
function pickOre(w: World, e: Entity): number {
  if (e.hfield >= 0) {
    const W = w.map.w;
    if (!fieldHot(w, e.owner, (e.hfield % W) + 0.5, Math.floor(e.hfield / W) + 0.5)) {
      const t = findOre(w, e, e.hfield, false, HV_FIELD_KEEP);
      if (t >= 0) return t;
      e.hfield = -1; // worked out
    }
  }
  return findOre(w, e);
}

function goToOre(w: World, e: Entity, t: number) {
  e.oreTile = t;
  e.hstate = 'toOre';
  e.htimer = 0;
  e.hvProg = Infinity;
  const [x, y] = tileCenter(w, t);
  w.pathTo(e, x, y);
}

// ------------------------------------------------------------------ hot fields / threats

/** Hot ore fields of a player (World.hvHot): places a harvester was attacked at, or saw hostiles at, lately. */
function hotList(w: World, owner: number) {
  return w.hvHot.filter((f) => f.owner === owner && w.tick - f.at < HV_CALM);
}

function markHot(w: World, owner: number, x: number, y: number) {
  w.hvHot = w.hvHot.filter((f) => w.tick - f.at < HV_CALM * 2);
  const f = w.hvHot.find((f) => f.owner === owner && Math.hypot(f.x - x, f.y - y) < 3);
  if (f) f.at = w.tick;
  else w.hvHot.push({ owner, x, y, at: w.tick, chk: w.tick });
}

/**
 * A hot spot stays hot while a hostile is still seen there (it follows that hostile); the player's harvesters
 * keep checking their hot spots (each one once per SCAN ticks), so a hostile parked by a field keeps them off
 * it for as long as it is there, instead of luring them back every HV_CALM.
 */
function refreshHot(w: World, e: Entity) {
  for (const f of w.hvHot) {
    if (f.owner !== e.owner || w.tick - f.at >= HV_CALM || w.tick - f.chk < SCAN) continue;
    f.chk = w.tick;
    const foe = hostileNear(w, e.owner, f.x, f.y, 3, e);
    if (foe) {
      f.at = w.tick;
      f.x = foe.x;
      f.y = foe.y;
    }
  }
}

/** Distance from (px, py) to the segment a-b. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const k = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - dx * k, py - ay - dy * k);
}

/** Is there a hot spot within a field's radius of (x, y)? */
export function fieldHot(w: World, owner: number, x: number, y: number): boolean {
  return w.hvHot.some((f) => f.owner === owner && w.tick - f.at < HV_CALM && Math.hypot(f.x - x, f.y - y) <= HV_FIELD_R);
}

/** The nearest visible enemy combat unit (one that could shoot a harvester) within r of (x, y), else null. */
function hostileNear(w: World, owner: number, x: number, y: number, r: number, victim: Entity): Entity | null {
  let found: Entity | null = null;
  let bd = r;
  w.queryRadius(x, y, r, (o) => {
    if (o.kind !== 'unit' || o.dead || o.inside >= 0 || o.wound || !w.isEnemy(owner, o.owner)) return;
    const dist = Math.hypot(o.x - x, o.y - y);
    if (dist > bd || (dist === bd && found && o.id > found.id)) return;
    const d = unitDef(o.def);
    if (!d.weapon || d.harvester || !w.canAttack(o.def, victim) || !w.sees(owner, o)) return;
    found = o;
    bd = dist;
  });
  return found;
}

/** "Harvester under attack", at most once per HV_ALERT_GAP per player. */
export function harvesterAlert(w: World, e: Entity) {
  const p = w.players[e.owner];
  if (!p || w.tick - p.harvWarnAt < HV_ALERT_GAP) return;
  p.harvWarnAt = w.tick;
  w.events.push({ t: 'harvesterAttack', id: e.id, owner: e.owner, x: e.x, y: e.y });
}

/** At its refinery: in the dock queue, on the dock, driving out of it, or parked beside it. */
function atRefinery(e: Entity): boolean {
  return (e.hstate === 'toRefinery' && e.dockSeq >= 0) || e.hstate === 'unloading' || e.hstate === 'leaving' || !!e.hflee?.parked;
}

/** An enemy hit a harvester (World.damage): the place it was at is hot now, and its owner hears of it. */
export function harvesterHit(w: World, e: Entity) {
  e.hitAt = w.tick;
  // under fire at its own refinery: the base is under attack, not the ore field
  if (!atRefinery(e)) markHot(w, e.owner, e.x, e.y);
  harvesterAlert(w, e);
}

function startFlee(w: World, e: Entity) {
  const [fx, fy] = e.oreTile >= 0 ? tileCenter(w, e.oreTile) : [e.x, e.y];
  const f: HarvestFlee = { phase: e.cargo > 0 ? 'return' : 'repair', at: w.tick, fx, fy, ref: -1, spot: -1, parked: false };
  e.hflee = f;
  markHot(w, e.owner, fx, fy);
  if (Math.hypot(fx - e.x, fy - e.y) > 3) markHot(w, e.owner, e.x, e.y);
  harvesterAlert(w, e);
  if (e.hstate === 'unloading' || e.hstate === 'leaving') return; // finishes at the dock first
  if (f.phase === 'return') {
    if (e.hstate !== 'toRefinery') {
      e.hstate = 'toRefinery';
      e.targetId = pickRefinery(w, e, true)?.id ?? -1;
      leaveQueue(e);
      e.path = null;
    }
  } else {
    e.hstate = 'seek';
    leaveQueue(e);
    e.path = null;
  }
}

/** Should this harvester run home now? */
function threatened(w: World, e: Entity): boolean {
  const grace = w.tick - e.orderAt < HV_ORDER_GRACE;
  if (!grace && w.tick - e.hitAt <= 1) return true;
  if (w.tick % SCAN !== e.id % SCAN || atRefinery(e)) return false;
  const foe = hostileNear(w, e.owner, e.x, e.y, HV_FIELD_R, e);
  if (!foe) return false;
  // a hostile in sight makes the ore around it hot (the harvesters work elsewhere meanwhile: no run-home loops);
  // it sends this one home once it is close
  markHot(w, e.owner, foe.x, foe.y);
  // (already on its way home: it just carries on - a shot still sends it to the repair spot)
  if (e.hstate === 'toRefinery') return false;
  return !grace && w.tick - e.hresumeAt >= HV_RESUME_COOLDOWN && Math.hypot(foe.x - e.x, foe.y - e.y) <= HV_THREAT_R;
}

// ------------------------------------------------------------------ status (UI / render)

/** Parked beside the refinery being repaired (for the repair sparks and the HUD). */
export function harvesterRepairing(e: Entity): boolean {
  return !!e.hflee && e.hflee.parked && e.hp < e.maxHp && e.order.type === 'harvest';
}

/** Status line for the UI, or '' when working normally. */
export function harvestStatus(e: Entity): string {
  const f = e.hflee;
  if (!f || e.order.type !== 'harvest') return '';
  if (!f.parked) return 'Returning - under attack';
  if (e.hp < e.maxHp) return `Repairing ${Math.floor(Math.min(1, e.hp / e.maxHp) * 100)}%`;
  return 'Waiting - ore field under attack';
}

// ------------------------------------------------------------------ orders

/** Command 'harvest' (an explicit order: it cancels a run home). */
export function orderHarvest(w: World, e: Entity, x: number, y: number) {
  e.order = { type: 'harvest' };
  e.hflee = null;
  leaveQueue(e);
  e.oreAvoid = -1;
  const t = w.tileOf(x, y);
  e.hfield = w.map.ore[t] > 0 ? t : -1;
  if (w.map.ore[t] > 0) goToOre(w, e, t);
  else {
    e.hstate = e.cargo > 0 ? 'toRefinery' : 'seek';
    e.targetId = -1;
  }
}

// ------------------------------------------------------------------ the work cycle

export function updateHarvester(w: World, e: Entity, d: UnitDef) {
  e.idleTicks = 0;
  if (e.hflee && e.orderAt > e.hflee.at) e.hflee = null; // its owner gave it an order since
  if (e.hstate !== 'toRefinery' && e.dockSeq >= 0) leaveQueue(e);
  if (w.tick % SCAN === e.id % SCAN) refreshHot(w, e);
  if (!e.hflee && threatened(w, e)) startFlee(w, e);
  const f = e.hflee;
  if (f) {
    if (f.phase === 'return' && e.cargo <= 0 && e.hstate !== 'unloading' && e.hstate !== 'leaving') {
      // nothing (left) to unload: straight to the repair spot
      const r = w.get(e.targetId);
      if (e.hstate === 'toRefinery' && r && r.dockedBy === e.id) r.dockedBy = -1;
      leaveQueue(e);
      f.phase = 'repair';
      e.hstate = 'seek'; // (not in anyone's dock line any more)
      e.path = null;
    }
    if (f.phase === 'return' && (e.hstate === 'seek' || e.hstate === 'toOre' || e.hstate === 'mining')) {
      e.hstate = 'toRefinery';
      e.targetId = pickRefinery(w, e, true)?.id ?? -1;
      e.path = null;
    }
    if (f.phase === 'repair') {
      stepRepair(w, e, d, f);
      return;
    }
  }
  const { ore, oreKind } = w.map;
  switch (e.hstate) {
    case 'seek': {
      if (e.htimer > 0) {
        e.htimer--;
        if (e.path) w.walk(e, d);
        break;
      }
      const t = pickOre(w, e);
      if (t < 0) {
        if (e.cargo > 0) e.hstate = 'toRefinery';
        else e.htimer = TPS * 3;
        break;
      }
      goToOre(w, e, t);
      break;
    }
    case 'toOre': {
      if (ore[e.oreTile] === 0) {
        e.hstate = 'seek';
        e.oreTile = -1;
        break;
      }
      const [ox, oy] = tileCenter(w, e.oreTile);
      const left = Math.hypot(e.x - ox, e.y - oy);
      // watchdog: no headway for a few seconds (jammed against a miner, shoved about) -> re-plan
      if (left < e.hvProg - 0.25) {
        e.hvProg = left;
        e.htimer = 0;
      }
      const jammed = ++e.htimer > STUCK_LIMIT;
      if (w.walk(e, d) || jammed) {
        if (w.tileOf(e.x, e.y) === e.oreTile || left < 0.75) {
          e.hstate = 'mining';
          e.htimer = 0;
          e.oreAvoid = -1;
        } else {
          // could not get there (blocked, or jammed in): try another tile, not this one again
          e.oreAvoid = e.oreTile;
          e.oreTile = -1;
          e.hstate = 'seek';
          e.htimer = 0;
          e.path = null;
        }
      }
      break;
    }
    case 'mining': {
      e.moving = false;
      e.path = null;
      if (++e.htimer < MINE_TICKS) break;
      e.htimer = 0;
      const t = e.oreTile;
      if (ore[t] > 0) {
        ore[t]--;
        e.cargo += oreKind[t] === 2 ? GEM_VALUE : ORE_VALUE;
        if (ore[t] === 0) oreKind[t] = 0;
      }
      if (e.cargo >= HARVEST_CAPACITY) {
        e.hstate = 'toRefinery';
        e.targetId = -1;
        e.path = null;
        break;
      }
      if (ore[t] === 0) {
        const next = pickOre(w, e);
        if (next >= 0) goToOre(w, e, next);
        else if (e.cargo > 0) {
          e.hstate = 'toRefinery';
          e.targetId = -1;
        } else e.hstate = 'seek';
      }
      break;
    }
    case 'toRefinery':
      toRefinery(w, e, d);
      break;
    case 'unloading': {
      const ref = w.get(e.targetId);
      if (!isRefinery(ref, e.owner)) {
        e.hstate = 'toRefinery';
        e.targetId = -1;
        break;
      }
      e.facing = turnToward(e.facing, -Math.PI / 2, d.turnRate);
      e.moving = false;
      const amt = Math.min(e.cargo, UNLOAD_RATE);
      e.cargo -= amt;
      const p = w.players[e.owner];
      p.credits += amt;
      p.stats.harvested += amt;
      if (e.cargo <= 0) {
        e.cargo = 0;
        // drive out along the lane; the dock stays ours until the lane is clear
        e.hstate = 'leaving';
        e.htimer = 0;
        const [ax, ay] = apronXY(ref);
        w.pathTo(e, ax, ay);
      }
      break;
    }
    case 'leaving': {
      const ref = w.get(e.targetId);
      const [dx, dy] = ref ? dockXY(ref) : [e.x, e.y];
      const done = w.walk(e, d);
      if (!ref || done || ++e.htimer > LEAVE_LIMIT || Math.hypot(e.x - dx, e.y - dy) >= LANE_CLEAR) {
        if (ref && ref.dockedBy === e.id) ref.dockedBy = -1;
        e.targetId = -1;
        e.hstate = 'seek';
        e.htimer = 0;
        leaveQueue(e);
      }
      break;
    }
  }
}

function toRefinery(w: World, e: Entity, d: UnitDef) {
  let ref = w.get(e.targetId);
  if (!isRefinery(ref, e.owner)) {
    ref = pickRefinery(w, e, !!e.hflee) ?? undefined;
    leaveQueue(e);
    e.path = null;
    if (!ref) {
      e.targetId = -1;
      if (e.hflee) {
        // no refinery left to run to: carry on as best it can
        e.hflee = null;
        return;
      }
      e.order = { type: 'idle' };
      return;
    }
    e.targetId = ref.id;
  }
  checkDock(w, ref);
  const [dx, dy] = dockXY(ref);
  const dist = Math.hypot(e.x - dx, e.y - dy);
  if (ref.dockedBy !== e.id) {
    if (dist > QUEUE_NEAR) {
      // on the way: head for the apron in front of the dock
      leaveQueue(e);
      const [ax, ay] = apronXY(ref);
      if (!e.path || e.moveGoal !== w.tileOf(ax, ay)) w.pathTo(e, ax, ay);
      w.walk(e, d);
      return;
    }
    if (e.dockSeq < 0) e.dockSeq = ++w.hvSeq;
    const line = waiting(w, ref);
    let rank = 0;
    for (const h of line) if (h.dockSeq < e.dockSeq || (h.dockSeq === e.dockSeq && h.id < e.id)) rank++;
    if (ref.dockedBy < 0 && rank === 0) {
      ref.dockedBy = e.id; // our turn
      e.htimer = 0;
      e.path = null;
    } else {
      // a free refinery elsewhere beats waiting in a long line here
      if (rank >= 1 && w.tick % 40 === e.id % 40) {
        const alt = pickRefinery(w, e);
        if (alt && alt !== ref) {
          const [ax, ay] = dockXY(alt);
          if (Math.hypot(ax - e.x, ay - e.y) + load(w, alt, e) * 8 + 6 < dist + (rank + 1) * 8) {
            e.targetId = alt.id;
            leaveQueue(e);
            e.path = null;
            return;
          }
        }
      }
      // wait our turn on our queue spot, off the lane
      const spots = refinerySpots(w, ref).queue;
      if (e.qspot < 0 && spots.length) e.qspot = takeSpot(e, line, spots);
      const [sx, sy] = spots.length ? spots[Math.min(e.qspot, spots.length - 1)] : apronXY(ref);
      const st = w.tileOf(sx, sy);
      if (Math.hypot(e.x - sx, e.y - sy) < 0.35) {
        e.path = null;
        e.moving = false;
      } else {
        if (!e.path || e.moveGoal !== st) w.pathTo(e, sx, sy);
        if (w.walk(e, d)) e.moving = false;
      }
      return;
    }
  }
  // our turn: drive onto the dock
  if (dist < 0.15) {
    e.x = dx;
    e.y = dy;
    e.hstate = 'unloading';
    e.path = null;
    e.moving = false;
    leaveQueue(e);
    return;
  }
  if (++e.htimer > APPROACH_LIMIT) {
    // something is in the way: let the next one try, back of the line
    ref.dockedBy = -1;
    e.dockSeq = ++w.hvSeq;
    e.htimer = 0;
    e.path = null;
    return;
  }
  if (!e.path || e.moveGoal !== w.tileOf(dx, dy)) w.pathTo(e, dx, dy);
  if (w.walk(e, d) && Math.hypot(e.x - dx, e.y - dy) >= 0.15) e.path = null; // retry
}

// ------------------------------------------------------------------ repair beside the refinery

function stepRepair(w: World, e: Entity, d: UnitDef, f: HarvestFlee) {
  let ref = w.get(f.ref);
  if (!isRefinery(ref, e.owner)) {
    ref = pickRefinery(w, e, true) ?? undefined;
    f.spot = -1;
    f.parked = false;
    e.path = null;
    if (!ref) {
      e.hflee = null; // nowhere to go: back to work
      e.hstate = 'seek';
      return;
    }
    f.ref = ref.id;
  }
  const spots = refinerySpots(w, ref).repair;
  const all = spots.length ? spots : refinerySpots(w, ref).queue.slice().reverse();
  if (f.spot < 0) {
    const used = new Set<number>();
    for (const o of w.list) if (o !== e && !o.dead && o.hflee && o.hflee.ref === ref.id && o.hflee.phase === 'repair') used.add(o.hflee.spot);
    let k = 0;
    while (used.has(k) && k < all.length - 1) k++;
    f.spot = k;
  }
  const [sx, sy] = all.length ? all[Math.min(f.spot, all.length - 1)] : apronXY(ref);
  const dist = Math.hypot(e.x - sx, e.y - sy);
  if (!f.parked) {
    if (!e.path || e.moveGoal !== w.tileOf(sx, sy)) w.pathTo(e, sx, sy);
    if (w.walk(e, d) || dist < 0.2) {
      f.parked = true;
      e.path = null;
      e.moving = false;
    }
  } else {
    e.moving = false;
    if (dist > 1.5) f.parked = false; // shoved off the spot
  }
  if (f.parked && e.hp < e.maxHp) e.hp = Math.min(e.maxHp, e.hp + (e.maxHp * HV_REPAIR_RATE) / TPS);
  // keep an eye on the field it left
  if (w.tick % SCAN === e.id % SCAN && hostileNear(w, e.owner, f.fx, f.fy, HV_FIELD_R, e)) markHot(w, e.owner, f.fx, f.fy);
  if (!f.parked || e.hp < e.maxHp || w.tick % SCAN !== e.id % SCAN) return;
  // repaired: back to its field once that has been calm long enough, else to another one, else wait
  let t = -1;
  if (!fieldHot(w, e.owner, f.fx, f.fy)) t = findOre(w, e, w.tileOf(f.fx, f.fy));
  else t = findOre(w, e, w.tileOf(e.x, e.y), true);
  if (t < 0) {
    if (fieldHot(w, e.owner, f.fx, f.fy)) return; // wait
  }
  e.hflee = null;
  e.hresumeAt = w.tick;
  e.oreAvoid = -1;
  if (t >= 0) goToOre(w, e, t);
  else e.hstate = 'seek';
}

// ------------------------------------------------------------------ right of way

/** Right of way between two harvesters of one owner (World.separate): higher stands firm. */
export function hvPriority(w: World, e: Entity): number {
  if (e.order.type !== 'harvest') return 1;
  switch (e.hstate) {
    case 'unloading':
      return 5;
    case 'leaving':
      return 4;
    case 'toRefinery':
      return w.get(e.targetId)?.dockedBy === e.id ? 4 : 1;
    case 'mining':
      return 2;
    default:
      return e.hflee?.parked ? 2 : 1;
  }
}

function angleDiff(a: number, b: number) {
  let dd = b - a;
  while (dd > Math.PI) dd -= Math.PI * 2;
  while (dd < -Math.PI) dd += Math.PI * 2;
  return dd;
}

function turnToward(a: number, b: number, rate: number) {
  const dd = angleDiff(a, b);
  if (Math.abs(dd) <= rate) return b;
  return a + Math.sign(dd) * rate;
}
