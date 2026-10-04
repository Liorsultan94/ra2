// Airbases and the fixed-wing jet sortie cycle (RA2 style, deterministic lockstep).
//
// A combat jet lives on one of its airbase's 4 parking pads. Ordered to strike, it
// taxis out along the taxiway, holds short of the runway until the runway is free,
// lines up, rolls and takes off, flies to the target and drops ONE heavy bomb in
// level flight, flies home, joins the final approach, lands, rolls out, taxis back
// to its pad and rearms there for 10 s. Only one jet uses a runway at a time (the
// airbase's `dockedBy` holds the runway lock), taxiing jets keep their distance, and
// the jet cap is the number of pads (4 per completed airbase).
//
// Losing the airbase: jets on the ground die with it; airborne jets divert to another
// airbase with a free pad, or circle until one frees up and crash when their fuel
// runs out (30 s).
//
// Everything here is plain arithmetic on entity state in tick order, no randomness,
// so every client computes the same thing.

import { WEAPONS, buildingDef, unitDef } from './defs';
import { launch } from './ballistics';
import { TPS, type Entity, type Sortie, type SortiePhase, type UnitDef } from './types';
import type { World } from './world';

/** Parking pads (and so jets) per airbase. */
export const PADS_PER_BASE = 4;
/** Rearm time on the pad after a strike. */
export const REARM_TICKS = TPS * 10;
/** Endurance of a jet that has lost its airbase. */
export const FUEL_TICKS = TPS * 30;

const TAXI_V = 1.5 / TPS; // tiles per tick
const TAXI_ACC = 1.6 / TPS / TPS;
const TAXI_TURN = 0.12; // rad per tick
const TO_ACC = 2.4 / TPS / TPS; // take-off roll acceleration
const ROTATE_K = 0.66; // rotate at this fraction of cruise speed
const CLIMB = 0.028; // tiles per tick on climb-out
const APPROACH_V = 3.2 / TPS;
const TOUCH_V = 2.6 / TPS;
const ROLL_DEC = 1.4 / TPS / TPS;
const GLIDE_ALT = 1.3; // altitude at the final approach fix
const FINAL_LEN = 6; // final approach fix: tiles before touchdown
const RELEASE_DIST = 3.0; // bomb release: tiles short of the target
const PARK_FACING = Math.PI / 2; // nose out of the stand, towards the taxiway
/** Below this altitude a jet counts as on the ground (ground weapons can hit it, AA cannot). */
export const GROUND_Z = 0.3;

const GROUND_PHASES: ReadonlySet<SortiePhase> = new Set(['parked', 'taxiOut', 'hold', 'lineup', 'rollout', 'taxiIn']);

export function isSortieJet(d: UnitDef | undefined): boolean {
  return !!d && !!d.fixedWing && !!d.weapon && !d.airlift;
}

/** Jet on its wheels (parked, taxiing, rolling): a ground target, not an aircraft. */
export function jetGrounded(e: Entity): boolean {
  return !!e.sortie && e.z < GROUND_Z;
}

function clamp(x: number, a: number, b: number) {
  return x < a ? a : x > b ? b : x;
}
function angleDiff(a: number, b: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function turnToward(a: number, b: number, rate: number) {
  const d = angleDiff(a, b);
  if (Math.abs(d) <= rate) return b;
  return a + Math.sign(d) * rate;
}

// ------------------------------------------------------------------ geometry

/**
 * Airbase layout in world tiles. The footprint is 7 x 4: four parking stands along the back row
 * (1.5 tiles apart), the control tower in the back-right corner, the taxiway across the middle and
 * the runway along the front row. Runway ops are one-way: take-off and landing both head along
 * `dir` (+1 east / -1 west), chosen so the final approach comes in over the roomier side of the map.
 */
export interface BaseGeo {
  dir: 1 | -1;
  pads: number[]; // pad centre x
  padY: number;
  taxiY: number;
  rwyY: number;
  startX: number; // threshold end: take-off rolls start, landings touch down just past it
  endX: number;
  tdX: number; // touchdown point
  fx: number; // final approach fix (x on the extended centreline)
}

export function baseGeo(w: World, b: Entity): BaseGeo {
  const d = buildingDef(b.def);
  const roomW = b.tx;
  const roomE = w.map.w - (b.tx + d.w);
  const dir: 1 | -1 = roomW >= roomE ? 1 : -1;
  const x0 = b.tx + 0.55;
  const x1 = b.tx + d.w - 0.55;
  const startX = dir > 0 ? x0 : x1;
  const tdX = startX + dir * 1.1;
  const pads: number[] = [];
  for (let i = 0; i < PADS_PER_BASE; i++) pads.push(b.tx + 0.75 + i * 1.5);
  return {
    dir,
    pads,
    padY: b.ty + 0.85,
    taxiY: b.ty + 2.05,
    rwyY: b.ty + d.h - 0.8,
    startX,
    endX: dir > 0 ? x1 : x0,
    tdX,
    fx: clamp(tdX - dir * FINAL_LEN, 1, w.map.w - 1),
  };
}

function isBase(b: Entity | undefined, owner: number): b is Entity {
  return !!b && !b.dead && b.kind === 'building' && b.owner === owner && buildingDef(b.def).role === 'airfield' && b.buildAnim >= 1;
}

/** Pads 0..3 of an airbase taken by jets assigned to it (the pad is theirs while they are out on a sortie, too). */
function padsTaken(w: World, b: Entity): boolean[] {
  const taken: boolean[] = new Array(PADS_PER_BASE).fill(false);
  for (const e of w.list) {
    if (e.dead || !e.sortie || e.sortie.base !== b.id) continue;
    if (e.sortie.pad >= 0 && e.sortie.pad < PADS_PER_BASE) taken[e.sortie.pad] = true;
  }
  return taken;
}

export function freePad(w: World, b: Entity): number {
  return padsTaken(w, b).indexOf(false);
}

/** Nearest completed airbase of the jet's owner with a free pad. */
function findBase(w: World, e: Entity): Entity | null {
  let best: Entity | null = null;
  let bd = Infinity;
  for (const b of w.list) {
    if (!isBase(b, e.owner) || freePad(w, b) < 0) continue;
    const dd = Math.hypot(b.x - e.x, b.y - e.y);
    if (dd < bd) {
      bd = dd;
      best = b;
    }
  }
  return best;
}

/** Jet cap: 4 jets per completed airbase. */
export function padCap(w: World, pid: number): number {
  let n = 0;
  for (const b of w.list) if (isBase(b, pid)) n++;
  return n * PADS_PER_BASE;
}

/** Combat jets a player owns (on the ground and in the air). */
export function jetCount(w: World, pid: number): number {
  let n = 0;
  for (const e of w.list) if (!e.dead && e.owner === pid && e.kind === 'unit' && isSortieJet(unitDef(e.def))) n++;
  return n;
}

/** Jets waiting in a player's air production queue. */
export function jetsQueued(w: World, pid: number): number {
  let n = 0;
  for (const q of w.players[pid].queues.air) if (isSortieJet(unitDef(q.def))) n++;
  return n;
}

function newSortie(e: Entity, d: UnitDef): Sortie {
  return { phase: 'return', base: -1, pad: -1, ammo: 1, rearm: 0, v: d.speed / TPS, path: [], wp: 0, tx: -1, ty: -1, fuel: FUEL_TICKS, ox: e.x, oy: e.y };
}

/** Put a jet on a free pad of base b, parked, armed and ready (new jets from production). */
export function parkJet(w: World, e: Entity, b: Entity): boolean {
  const pad = freePad(w, b);
  if (pad < 0) return false;
  const d = unitDef(e.def);
  const s = e.sortie ?? newSortie(e, d);
  e.sortie = s;
  const g = baseGeo(w, b);
  s.base = b.id;
  s.pad = pad;
  s.phase = 'parked';
  s.v = 0;
  s.ammo = 1;
  s.rearm = 0;
  s.path = [];
  s.wp = 0;
  e.x = e.px = g.pads[pad];
  e.y = e.py = g.padY;
  e.z = e.pz = 0;
  e.facing = e.pfacing = e.turret = e.pturret = PARK_FACING;
  e.moving = false;
  e.order = { type: 'idle' };
  return true;
}

/** Ready for a strike: parked on its pad, armed, rearm finished. */
export function jetReady(e: Entity): boolean {
  const s = e.sortie;
  return !!s && s.phase === 'parked' && s.ammo > 0 && s.rearm <= 0;
}

/** Rearm progress 0..1 for the UI (1 = ready / not rearming), or -1 for non-jets. */
export function rearmProgress(e: Entity): number {
  const s = e.sortie;
  if (!s) return -1;
  if (s.rearm > 0) return 1 - s.rearm / REARM_TICKS;
  return s.ammo > 0 ? 1 : 0;
}

// ------------------------------------------------------------------ runway lock

function takeRunway(b: Entity, e: Entity): boolean {
  if (b.dockedBy >= 0 && b.dockedBy !== e.id) return false;
  b.dockedBy = e.id;
  return true;
}
function freeRunway(b: Entity | undefined, e: Entity) {
  if (b && b.dockedBy === e.id) b.dockedBy = -1;
}

// ------------------------------------------------------------------ movement

function frontBlocked(w: World, e: Entity): boolean {
  const s = e.sortie!;
  const fx = Math.cos(e.facing);
  const fy = Math.sin(e.facing);
  for (const o of w.list) {
    if (o === e || o.dead || !o.sortie || o.sortie.base !== s.base || o.z > 0.05) continue;
    const op = o.sortie.phase;
    if (op === 'parked' || op === 'takeoff') continue;
    const dx = o.x - e.x;
    const dy = o.y - e.y;
    const dd = Math.hypot(dx, dy);
    if (dd > 1.25 || dd < 1e-6) continue;
    if ((dx * fx + dy * fy) / dd < 0.55) continue;
    // head-on: the lower id goes first
    const bx = Math.cos(o.facing);
    const by = Math.sin(o.facing);
    if ((-dx * bx - dy * by) / dd > 0.55 && e.id < o.id) continue;
    return true;
  }
  return false;
}

/** Follow the taxi waypoints. Returns true once the last one is reached. */
function taxi(w: World, e: Entity, s: Sortie): boolean {
  e.z = 0;
  if (s.wp * 2 >= s.path.length) {
    s.v = 0;
    e.moving = false;
    return true;
  }
  const wx = s.path[s.wp * 2];
  const wy = s.path[s.wp * 2 + 1];
  const dx = wx - e.x;
  const dy = wy - e.y;
  const dist = Math.hypot(dx, dy);
  const last = (s.wp + 1) * 2 >= s.path.length;
  if (dist < (last ? 0.03 : 0.16)) {
    s.wp++;
    if (last) {
      e.x = wx;
      e.y = wy;
      s.v = 0;
      e.moving = false;
      return true;
    }
    return false;
  }
  const want = Math.atan2(dy, dx);
  e.facing = turnToward(e.facing, want, TAXI_TURN);
  const off = Math.abs(angleDiff(e.facing, want));
  let target = TAXI_V * clamp(1 - off / 1.1, 0, 1);
  if (last) target = Math.min(target, Math.max(0.006, dist * 0.15));
  if (frontBlocked(w, e)) target = 0;
  s.v += clamp(target - s.v, -TAXI_ACC * 3, TAXI_ACC);
  if (s.v < 0) s.v = 0;
  const step = Math.min(s.v, dist);
  e.x += Math.cos(e.facing) * step;
  e.y += Math.sin(e.facing) * step;
  e.moving = s.v > 0.002;
  e.turret = e.facing;
  return false;
}

/** Airborne: steer for (gx, gy) at a speed and altitude. */
function fly(w: World, e: Entity, d: UnitDef, s: Sortie, gx: number, gy: number, speed: number, alt: number, turnMul = 1, steer = true) {
  if (steer) e.facing = turnToward(e.facing, Math.atan2(gy - e.y, gx - e.x), d.turnRate * turnMul);
  const jam = e.jammedUntil > w.tick ? 0.5 : 1;
  s.v += clamp(speed * jam - s.v, -0.006, 0.004);
  e.x += Math.cos(e.facing) * s.v;
  e.y += Math.sin(e.facing) * s.v;
  const { w: mw, h: mh } = w.map;
  if (e.x < 0.5 || e.y < 0.5 || e.x > mw - 0.5 || e.y > mh - 0.5) {
    e.x = clamp(e.x, 0.5, mw - 0.5);
    e.y = clamp(e.y, 0.5, mh - 0.5);
  }
  e.z += clamp(alt - e.z, -0.045, 0.05);
  e.turret = e.facing;
  e.moving = true;
  e.path = null;
}

// ------------------------------------------------------------------ missions

/** A ground target the bomb can hit (enemy, visible to the owner), nearest to (x, y) within r. */
function targetNear(w: World, e: Entity, x: number, y: number, r: number): Entity | null {
  const wpn = WEAPONS[unitDef(e.def).weapon!];
  let best: Entity | null = null;
  let bs = Infinity;
  w.queryRadius(x, y, r, (o) => {
    if (!w.isEnemy(e.owner, o.owner) || o.inside >= 0 || !w.canHit(wpn, o)) return;
    if (o.kind === 'unit' && unitDef(o.def).temp) return;
    if (!w.visibleTo(e.owner, o.x, o.y)) return;
    const dd = Math.hypot(o.x - x, o.y - y);
    if (dd > r) return;
    // structures and armour first: a heavy bomb is wasted on one rifleman
    const score = dd + (o.kind === 'building' ? -1 : unitDef(o.def).category === 'infantry' ? 1.5 : 0);
    if (score < bs) {
      bs = score;
      best = o;
    }
  });
  return best;
}

/** The current strike target of an attack order, re-acquired near the last aim point if it is gone. */
function strikeTarget(w: World, e: Entity, s: Sortie): Entity | null {
  const o = e.order;
  if (o.type !== 'attack') return null;
  const wpn = WEAPONS[unitDef(e.def).weapon!];
  const t = w.get(o.target);
  if (t && w.isEnemy(e.owner, t.owner) && w.canHit(wpn, t)) {
    s.tx = t.x;
    s.ty = t.y;
    return t;
  }
  if (s.tx >= 0) {
    const n = targetNear(w, e, s.tx, s.ty, 2.5);
    if (n) {
      e.order = { type: 'attack', target: n.id, forced: true };
      return n;
    }
  }
  e.order = { type: 'idle' };
  return null;
}

/** Does the jet have somewhere to go (an attack / attack-move needs a bomb aboard)? Drops dead attack orders. */
function hasMission(w: World, e: Entity, s: Sortie): boolean {
  const o = e.order;
  if (o.type === 'move') return true;
  if (o.type === 'attackMove') return s.ammo > 0;
  if (o.type === 'attack') {
    const t = strikeTarget(w, e, s);
    return !!t && s.ammo > 0;
  }
  if (o.type !== 'idle') e.order = { type: 'idle' };
  return false;
}

function release(w: World, e: Entity, d: UnitDef, s: Sortie, t: Entity) {
  const wpn = WEAPONS[d.weapon!];
  launch(w, e, t, wpn, t.x, t.y);
  e.firedAt = w.tick;
  s.ammo = 0;
  e.order = { type: 'idle' };
  e.targetId = -1;
  s.phase = 'return';
  w.events.push({ t: 'sortie', id: e.id, owner: e.owner, what: 'release', x: e.x, y: e.y });
}

// ------------------------------------------------------------------ the cycle

function setPath(s: Sortie, pts: number[]) {
  s.path = pts;
  s.wp = 0;
}

function taxiHome(s: Sortie, g: BaseGeo, x: number) {
  setPath(s, [x, g.taxiY, g.pads[s.pad], g.taxiY, g.pads[s.pad], g.padY]);
  s.phase = 'taxiIn';
}

function goHomeless(w: World, e: Entity, s: Sortie, x: number, y: number) {
  s.base = -1;
  s.pad = -1;
  s.ox = x;
  s.oy = y;
  if (s.phase !== 'sortie') {
    s.phase = 'orbit';
    w.events.push({ t: 'sortie', id: e.id, owner: e.owner, what: 'orbit', x: e.x, y: e.y });
  }
}

function crash(w: World, e: Entity) {
  w.events.push({ t: 'sortie', id: e.id, owner: e.owner, what: 'crash', x: e.x, y: e.y });
  w.kill(e, -1);
}

/** One tick of a combat jet (World.updateUnit hands fixed-wing combat jets here). */
export function updateSortie(w: World, e: Entity, d: UnitDef) {
  if (!e.sortie) {
    // spawned outside production (scripts, tests): find it a pad, or send it round in circles
    const s = newSortie(e, d);
    e.sortie = s;
    const b = findBase(w, e);
    if (b && e.z < GROUND_Z) parkJet(w, e, b);
    else if (b) {
      s.base = b.id;
      s.pad = freePad(w, b);
    } else {
      if (e.z < GROUND_Z) e.z = e.pz = d.cruiseAlt ?? 2.6;
      goHomeless(w, e, s, e.x, e.y);
    }
  }
  const s = e.sortie!;
  // jets ignore waypoint queues, patrols and escort duty: one strike at a time
  if (e.queue.length) e.queue.length = 0;
  e.patrol = null;
  e.guardId = -1;

  let base: Entity | undefined;
  if (s.base >= 0) {
    base = w.get(s.base);
    if (!isBase(base, e.owner)) {
      // airbase destroyed, sold or captured
      if (GROUND_PHASES.has(s.phase) || (s.phase === 'takeoff' && e.z < 0.05)) {
        crash(w, e);
        return;
      }
      const old = base ?? { x: e.x, y: e.y };
      freeRunway(base, e);
      base = undefined;
      const nb = findBase(w, e);
      if (nb) {
        s.base = nb.id;
        s.pad = freePad(w, nb);
        if (s.phase !== 'sortie') s.phase = 'return';
        s.fuel = FUEL_TICKS;
        w.events.push({ t: 'sortie', id: e.id, owner: e.owner, what: 'divert', x: e.x, y: e.y });
        base = nb;
      } else goHomeless(w, e, s, old.x, old.y);
    }
  }
  if (!base) {
    // homeless: the clock is running
    if (--s.fuel <= 0) {
      crash(w, e);
      return;
    }
    if ((w.tick + e.id) % 20 === 0) {
      const nb = findBase(w, e);
      if (nb) {
        s.base = nb.id;
        s.pad = freePad(w, nb);
        s.fuel = FUEL_TICKS;
        if (s.phase === 'orbit') s.phase = 'return';
        w.events.push({ t: 'sortie', id: e.id, owner: e.owner, what: 'divert', x: e.x, y: e.y });
        base = nb;
      }
    }
  }
  const g = base ? baseGeo(w, base) : null;
  const cruise = d.cruiseAlt ?? 2.6;
  const vCruise = d.speed / TPS;
  const dirA = g ? (g.dir > 0 ? 0 : Math.PI) : 0;

  switch (s.phase) {
    case 'parked': {
      if (!g) break;
      e.z = 0;
      s.v = 0;
      e.moving = false;
      const px = g.pads[s.pad];
      e.x += (px - e.x) * 0.2;
      e.y += (g.padY - e.y) * 0.2;
      // a tug turns it round on the stand, nose out
      e.facing = turnToward(e.facing, PARK_FACING, 0.05);
      e.turret = e.facing;
      if (s.rearm > 0 && --s.rearm === 0) s.ammo = 1;
      if (s.rearm <= 0 && s.ammo <= 0) s.ammo = 1;
      if (s.rearm <= 0 && hasMission(w, e, s)) {
        setPath(s, [px, g.taxiY, g.startX, g.taxiY]);
        s.phase = 'taxiOut';
      }
      break;
    }
    case 'taxiOut': {
      if (!g) break;
      if (!hasMission(w, e, s)) {
        taxiHome(s, g, e.x);
        break;
      }
      if (taxi(w, e, s)) s.phase = 'hold';
      break;
    }
    case 'hold': {
      // short of the runway, waiting for it to be free
      if (!g || !base) break;
      e.z = 0;
      s.v = 0;
      e.moving = false;
      e.facing = turnToward(e.facing, Math.PI / 2, TAXI_TURN);
      if (!hasMission(w, e, s)) {
        taxiHome(s, g, e.x);
        break;
      }
      if (takeRunway(base, e)) {
        setPath(s, [g.startX, g.rwyY]);
        s.phase = 'lineup';
      }
      break;
    }
    case 'lineup': {
      if (!g || !base) break;
      if (!hasMission(w, e, s)) {
        freeRunway(base, e);
        setPath(s, [g.startX, g.taxiY, g.pads[s.pad], g.taxiY, g.pads[s.pad], g.padY]);
        s.phase = 'taxiIn';
        break;
      }
      if (!taxi(w, e, s)) break;
      e.facing = turnToward(e.facing, dirA, TAXI_TURN);
      e.turret = e.facing;
      if (Math.abs(angleDiff(e.facing, dirA)) < 1e-3) {
        s.phase = 'takeoff';
        s.v = 0;
        w.events.push({ t: 'sortie', id: e.id, owner: e.owner, what: 'takeoff', x: e.x, y: e.y });
      }
      break;
    }
    case 'takeoff': {
      s.v = Math.min(vCruise, s.v + TO_ACC);
      if (e.z < 0.6) e.facing = dirA;
      e.x += Math.cos(e.facing) * s.v;
      e.y += Math.sin(e.facing) * s.v;
      if (g && e.z < 0.05) e.y += (g.rwyY - e.y) * 0.3;
      if (s.v >= vCruise * ROTATE_K) e.z = Math.min(cruise, e.z + CLIMB * clamp((s.v - vCruise * ROTATE_K) / (vCruise * 0.12), 0.25, 1));
      e.moving = true;
      e.turret = e.facing;
      // stream take-off: the next jet may line up once this one is well down the runway
      if (g && (e.x - g.startX) * g.dir > 2.6) freeRunway(base, e);
      if (e.z > GROUND_Z + 0.05) {
        freeRunway(base, e);
        s.phase = 'sortie';
      }
      break;
    }
    case 'sortie': {
      const o = e.order;
      // climb out straight before turning
      const turnMul = e.z < 0.9 ? 0.35 : 1;
      if (s.ammo <= 0 && o.type !== 'move') {
        s.phase = base ? 'return' : 'orbit';
        break;
      }
      if (o.type === 'attack') {
        const t = strikeTarget(w, e, s);
        if (!t) {
          s.phase = base ? 'return' : 'orbit';
          break;
        }
        e.targetId = t.id;
        const dx = t.x - e.x;
        const dy = t.y - e.y;
        const dc = Math.hypot(dx, dy);
        // overshoot after a missed run instead of pivoting over the target
        fly(w, e, d, s, t.x, t.y, vCruise, cruise, turnMul, dc > 1.6);
        const off = Math.abs(angleDiff(e.facing, Math.atan2(dy, dx)));
        if (dc <= RELEASE_DIST && dc >= 1.2 && off < 0.3 && e.z > 1.0 && e.jammedUntil <= w.tick) release(w, e, d, s, t);
        break;
      }
      if (o.type === 'attackMove' || o.type === 'move') {
        const dc = Math.hypot(o.x - e.x, o.y - e.y);
        fly(w, e, d, s, o.x, o.y, vCruise, cruise, turnMul, dc > 1.2);
        if (o.type === 'attackMove' && dc < 4.5) {
          const t = targetNear(w, e, o.x, o.y, 4);
          if (t) {
            e.order = { type: 'attack', target: t.id, forced: true };
            s.tx = t.x;
            s.ty = t.y;
            break;
          }
        }
        if (dc < 1.4) {
          e.order = { type: 'idle' };
          s.phase = base ? 'return' : 'orbit';
        }
        break;
      }
      s.phase = base ? 'return' : 'orbit';
      break;
    }
    case 'return': {
      if (!g || !base) {
        s.phase = 'orbit';
        break;
      }
      // a fresh strike order for an armed jet on its way home
      if (s.ammo > 0 && e.order.type !== 'idle' && hasMission(w, e, s)) {
        s.phase = 'sortie';
        break;
      }
      const along = (e.x - g.fx) * g.dir; // > 0: past the fix, towards (or beyond) the runway
      const lat = e.y - g.rwyY;
      const distF = Math.hypot(e.x - g.fx, lat);
      const near = distF < 9;
      let gx: number;
      let gy: number;
      if (along < -0.6 && Math.abs(lat) < 1 + -along * 0.9) {
        // on the approach cone: head for the fix along the extended centreline
        gx = g.fx + g.dir * 1.2;
        gy = g.rwyY;
      } else {
        // join downwind: a point behind the fix, off to the side we are on
        const side = lat >= 0 ? 1 : -1;
        gx = clamp(g.fx - g.dir * 3.6, 1, w.map.w - 1);
        gy = clamp(g.rwyY + side * 2.8, 1, w.map.h - 1);
      }
      fly(w, e, d, s, gx, gy, near ? APPROACH_V : vCruise, near ? GLIDE_ALT : cruise);
      if (along > -0.8 && along < 1.2 && Math.abs(lat) < 1 && Math.abs(angleDiff(e.facing, dirA)) < 0.8 && e.z < GLIDE_ALT + 0.6 && takeRunway(base, e)) s.phase = 'final';
      break;
    }
    case 'final': {
      if (!g || !base) {
        s.phase = 'orbit';
        break;
      }
      const dTd = (g.tdX - e.x) * g.dir;
      const len = Math.max(1.5, Math.abs(g.tdX - g.fx));
      e.facing = turnToward(e.facing, Math.atan2(g.rwyY - e.y, g.dir * 1.5), d.turnRate);
      if (dTd < 2) e.facing = turnToward(e.facing, dirA, 0.08);
      e.y += (g.rwyY - e.y) * (dTd < 2.5 ? 0.2 : 0.07);
      s.v += clamp(TOUCH_V - s.v, -0.005, 0.002);
      e.x += Math.cos(e.facing) * s.v;
      e.y += Math.sin(e.facing) * s.v;
      // glide slope, then the flare over the threshold
      const zt = dTd > 0.7 ? GLIDE_ALT * clamp((dTd - 0.7) / (len - 0.7), 0, 1) + 0.07 : 0.1 * Math.max(0, dTd / 0.7);
      e.z += clamp(zt - e.z, -0.06, 0.03);
      e.turret = e.facing;
      e.moving = true;
      if (dTd <= 0 || (e.z <= 0.02 && dTd < 0.7)) {
        e.z = 0;
        e.y = g.rwyY;
        e.facing = dirA;
        s.phase = 'rollout';
        w.events.push({ t: 'sortie', id: e.id, owner: e.owner, what: 'touchdown', x: e.x, y: e.y });
      } else if (Math.abs(e.y - g.rwyY) > 1.3 || dTd < -1) {
        // go around
        freeRunway(base, e);
        s.phase = 'return';
      }
      break;
    }
    case 'rollout': {
      if (!g || !base) break;
      e.z = 0;
      s.v = Math.max(TAXI_V, s.v - ROLL_DEC);
      e.facing = dirA;
      e.x += Math.cos(e.facing) * s.v;
      e.y += (g.rwyY - e.y) * 0.3;
      e.moving = true;
      const left = (g.endX - e.x) * g.dir;
      if (s.v <= TAXI_V + 1e-9 || left < 0.8) {
        freeRunway(base, e);
        taxiHome(s, g, e.x + g.dir * 0.5);
      }
      break;
    }
    case 'taxiIn': {
      if (!g) break;
      if (taxi(w, e, s)) {
        s.phase = 'parked';
        if (s.ammo <= 0) s.rearm = REARM_TICKS;
      }
      break;
    }
    case 'orbit': {
      if (base) {
        s.phase = 'return';
        break;
      }
      const a = Math.atan2(e.y - s.oy, e.x - s.ox) + 0.6;
      fly(w, e, d, s, s.ox + Math.cos(a) * 3, s.oy + Math.sin(a) * 3, vCruise * 0.8, cruise);
      break;
    }
  }
}
