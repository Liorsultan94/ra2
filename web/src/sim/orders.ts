// Unit orders beyond move / attack: stances, patrol, guard (escort) and queued
// waypoints. Everything here runs inside the deterministic simulation and is
// driven only by commands (see World.applyCommand / World.updateUnit hooks).

import { WEAPONS, unitDef } from './defs';
import type { Category, Command, Entity, QueuedOrder, Stance, UnitDef } from './types';
import type { World } from './world';

export const STANCES: Stance[] = ['aggressive', 'guard', 'hold', 'holdFire'];
export const DEFAULT_STANCE: Stance = 'guard';
/** Longest waypoint queue a unit keeps. */
export const MAX_QUEUE = 16;
/** Units of one kind a factory queue holds (per producing building). */
export const QUEUE_PER_FACTORY = 9;

const SPIRAL: [number, number][] = (() => {
  const out: [number, number, number][] = [];
  for (let y = -8; y <= 8; y++) for (let x = -8; x <= 8; x++) out.push([x, y, x * x + y * y + (x + y) * 0.001]);
  out.sort((a, b) => a[2] - b[2]);
  return out.map(([x, y]) => [x, y]);
})();
const INF_SLOTS: [number, number][] = [
  [-0.22, -0.18],
  [0.22, -0.18],
  [0, 0.22],
];

// ------------------------------------------------------------------ stances

/** How far from its guard point a unit chases a target on its own. */
export function leashRange(e: Entity, d: UnitDef): number {
  switch (e.stance) {
    case 'aggressive':
      return d.sight + 12;
    case 'hold':
    case 'holdFire':
      return 0;
    default:
      return d.sight + 3;
  }
}

/** May the unit pick targets on its own (idle scan, attack-move, retaliation, interception)? */
export function autoFire(e: Entity) {
  return e.stance !== 'holdFire';
}

/** Radius an idle unit scans for targets: hold-position units only look as far as they can shoot. */
export function scanRange(w: World, e: Entity, d: UnitDef) {
  if (e.stance !== 'hold' || !d.weapon) return d.sight;
  return Math.min(d.sight, w.weaponRange(e, WEAPONS[d.weapon]));
}

/** Idle unit without a target: return to its post (guard), stay put (hold), or make this its new post (aggressive). */
export function idleReturn(e: Entity): 'return' | 'stay' {
  if (e.stance === 'hold') return 'stay';
  if (e.stance === 'aggressive' && e.guardId < 0) {
    e.guardX = e.x;
    e.guardY = e.y;
    return 'stay';
  }
  return 'return';
}

// ------------------------------------------------------------------ commands

/** Per-unit formation slots around (x, y) (same packing as World.formationMove). */
export function formationSlots(w: World, units: Entity[], x: number, y: number): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  const { w: mw, h: mh } = w.map;
  const gx = Math.floor(x);
  const gy = Math.floor(y);
  const sorted = [...units].sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y) || a.id - b.id);
  const taken = new Map<number, number>();
  for (const e of sorted) {
    const d = unitDef(e.def);
    const cap = d.category === 'infantry' ? 3 : 1;
    const air = !!d.air;
    let tx = gx;
    let ty = gy;
    let slot = 0;
    for (const [ox, oy] of SPIRAL) {
      const cx = gx + ox;
      const cy = gy + oy;
      if (air ? cx < 0 || cy < 0 || cx >= mw || cy >= mh : !w.pf.passable(cx, cy)) continue;
      const i = cy * mw + cx + (air ? 1e6 : 0);
      const used = taken.get(i) ?? 0;
      if (used >= 100 || (used > 0 && cap === 1) || (cap === 3 && used >= 3)) continue;
      tx = cx;
      ty = cy;
      slot = used;
      taken.set(i, cap === 1 ? 100 : used + 1);
      break;
    }
    const off = cap === 3 ? INF_SLOTS[slot % 3] : [0, 0];
    out.set(e.id, [tx + 0.5 + off[0], ty + 0.5 + off[1]]);
  }
  return out;
}

function clearOrders(units: Entity[]) {
  for (const e of units) {
    e.queue.length = 0;
    e.patrol = null;
    e.guardId = -1;
  }
}

/** Does the unit have nothing to do right now (so a queued order starts at once)? */
function free(e: Entity) {
  return e.order.type === 'idle' && e.queue.length === 0 && !e.patrol && e.guardId < 0;
}

function enqueue(w: World, e: Entity, q: QueuedOrder) {
  if (free(e)) start(w, e, q);
  else if (e.queue.length < MAX_QUEUE) e.queue.push(q);
}

/**
 * Order commands handled here: stance, patrol, guard, repeat-build and queued move / attack.
 * Any other unit command cancels queued waypoints, patrols and escorts of the units it addresses.
 * Returns true when the command was fully handled.
 */
export function applyOrderCommand(w: World, pid: number, cmd: Command, own: (ids: number[]) => Entity[]): boolean {
  switch (cmd.type) {
    case 'stance': {
      if (!STANCES.includes(cmd.stance)) return true;
      for (const e of own(cmd.ids)) {
        e.stance = cmd.stance;
        if (e.order.type !== 'idle') continue;
        if (cmd.stance === 'holdFire') {
          e.targetId = -1;
          e.burstLeft = 0;
        }
        if (cmd.stance === 'hold' || cmd.stance === 'holdFire') {
          // stop any chase in progress and hold here
          e.path = null;
          e.moving = false;
          e.guardX = e.x;
          e.guardY = e.y;
        }
      }
      return true;
    }
    case 'patrol': {
      const units = own(cmd.ids);
      if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y)) return true;
      if (!cmd.queue) clearOrders(units);
      const slots = formationSlots(w, units, cmd.x, cmd.y);
      for (const e of units) {
        const s = slots.get(e.id)!;
        const q: QueuedOrder = { type: 'patrol', x: s[0], y: s[1] };
        if (cmd.queue) enqueue(w, e, q);
        else {
          e.order = { type: 'idle' };
          start(w, e, q);
        }
      }
      return true;
    }
    case 'guard': {
      const units = own(cmd.ids).filter((e) => e.id !== cmd.target);
      const t = w.get(cmd.target);
      if (!t || t.owner !== pid) return true;
      if (!cmd.queue) clearOrders(units);
      for (const e of units) {
        if (unitDef(e.def).harvester) continue;
        const q: QueuedOrder = { type: 'guard', target: t.id };
        if (cmd.queue) enqueue(w, e, q);
        else {
          e.order = { type: 'idle' };
          e.path = null;
          start(w, e, q);
        }
      }
      return true;
    }
    case 'repeat': {
      const p = w.players[pid];
      if (cmd.cat !== 'infantry' && cmd.cat !== 'vehicle' && cmd.cat !== 'air') return true;
      p.repeat = { ...p.repeat, [cmd.cat]: !!cmd.on };
      return true;
    }
    case 'move': {
      const units = own(cmd.ids);
      if (!cmd.queue) {
        clearOrders(units);
        return false;
      }
      if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y)) return true;
      const slots = formationSlots(w, units, cmd.x, cmd.y);
      for (const e of units) {
        const s = slots.get(e.id)!;
        enqueue(w, e, { type: cmd.attackMove ? 'attackMove' : 'move', x: s[0], y: s[1] });
      }
      return true;
    }
    case 'attack': {
      const units = own(cmd.ids);
      if (!cmd.queue) {
        clearOrders(units);
        return false;
      }
      const t = w.get(cmd.target);
      if (!t) return true;
      for (const e of units) if (canAttack(w, e, t)) enqueue(w, e, { type: 'attack', target: t.id });
      return true;
    }
    case 'stop':
    case 'capture':
    case 'enter':
    case 'harvest':
    case 'deploy':
      clearOrders(own(cmd.ids));
      return false;
    default:
      return false;
  }
}

function canAttack(w: World, e: Entity, t: Entity) {
  const d = unitDef(e.def);
  return !!d.weapon && !d.temp && t.owner !== e.owner && w.canHit(WEAPONS[d.weapon], t);
}

function goTo(w: World, e: Entity, x: number, y: number, attackMove: boolean) {
  e.order = attackMove ? { type: 'attackMove', x, y } : { type: 'move', x, y };
  e.targetId = -1;
  e.autoTarget = false;
  if (unitDef(e.def).harvester) e.hstate = 'seek';
  w.pathTo(e, x, y);
}

/** Begin a (queued) order now. */
function start(w: World, e: Entity, q: QueuedOrder) {
  switch (q.type) {
    case 'move':
    case 'attackMove':
      goTo(w, e, q.x, q.y, q.type === 'attackMove');
      break;
    case 'patrol': {
      const d = unitDef(e.def);
      if (!d.weapon || d.harvester || Math.hypot(q.x - e.x, q.y - e.y) < 1) {
        goTo(w, e, q.x, q.y, false);
        break;
      }
      e.patrol = { ax: e.x, ay: e.y, bx: q.x, by: q.y };
      goTo(w, e, q.x, q.y, true);
      break;
    }
    case 'attack': {
      const t = w.get(q.target);
      if (!t || !canAttack(w, e, t)) break;
      e.order = { type: 'attack', target: t.id, forced: true };
      e.targetId = t.id;
      e.autoTarget = false;
      e.path = null;
      break;
    }
    case 'guard': {
      const t = w.get(q.target);
      if (!t || t.owner !== e.owner || t.id === e.id) break;
      e.guardId = t.id;
      e.order = { type: 'idle' };
      e.targetId = -1;
      guardPoint(e, t);
      break;
    }
  }
}

/** Escort post: a spot beside the protected unit / around the protected building. */
function guardPoint(e: Entity, t: Entity) {
  const a = ((e.id * 0.61803398875) % 1) * Math.PI * 2;
  const r = t.kind === 'building' ? 2.2 : 1.3;
  e.guardX = t.x + Math.cos(a) * r;
  e.guardY = t.y + Math.sin(a) * r;
}

/**
 * Called every tick for an idle unit (before its idle behaviour): keeps escorts with
 * their charge, turns patrols around at the ends, and starts the next queued order.
 */
export function ordersIdle(w: World, e: Entity) {
  if (e.guardId >= 0) {
    const t = w.get(e.guardId);
    if (t && t.owner === e.owner) {
      if ((w.tick + e.id) % 10 !== 0) return;
      guardPoint(e, t);
      // defend the charge: go for whoever is shooting at it
      if (e.targetId < 0 && autoFire(e) && w.tick - t.lastHurt < 30 && unitDef(e.def).weapon) {
        const d = unitDef(e.def);
        let best: Entity | null = null;
        let bd = Infinity;
        w.queryRadius(t.x, t.y, d.sight, (o) => {
          if (!w.isEnemy(e.owner, o.owner) || o.kind !== 'unit' || unitDef(o.def).temp || !w.canHit(WEAPONS[d.weapon!], o)) return;
          const dd = Math.hypot(o.x - t.x, o.y - t.y);
          if (dd < bd && w.visibleTo(e.owner, o.x, o.y)) {
            bd = dd;
            best = o;
          }
        });
        if (best) {
          e.targetId = (best as Entity).id;
          e.autoTarget = true;
        }
      }
      // follow: re-plan when the charge has moved away from our current goal
      if (e.targetId < 0 && !unitDef(e.def).fixedWing) {
        const far = Math.hypot(e.x - e.guardX, e.y - e.guardY) > 2;
        const goal = w.tileOf(e.guardX, e.guardY);
        const gx = goal % w.map.w;
        const gy = Math.floor(goal / w.map.w);
        const stale = !e.path || Math.hypot(e.moveGoal % w.map.w - gx, Math.floor(e.moveGoal / w.map.w) - gy) > 2;
        if (far && stale) w.pathTo(e, e.guardX, e.guardY);
      }
      return;
    }
    e.guardId = -1;
  }
  if (e.patrol) {
    // reached one end: turn round (throttled so an unreachable end can't re-plan every tick)
    if ((w.tick + e.id) % 10 !== 0) return;
    const p = e.patrol;
    if (Math.hypot(p.ax - p.bx, p.ay - p.by) < 1) {
      e.patrol = null;
      return;
    }
    e.patrol = { ax: p.bx, ay: p.by, bx: p.ax, by: p.ay };
    goTo(w, e, p.ax, p.ay, true);
    return;
  }
  const next = e.queue.shift();
  if (next) start(w, e, next);
}

// ------------------------------------------------------------------ production

/** Units one production category may hold in its queue. */
export function queueCap(producers: number) {
  return QUEUE_PER_FACTORY * Math.max(1, producers);
}

export function repeatOn(w: World, pid: number, cat: Category) {
  return !!w.players[pid]?.repeat?.[cat];
}

// ------------------------------------------------------------------ UI helpers

export interface WaypointPt {
  x: number;
  y: number;
  kind: 'move' | 'attackMove' | 'attack' | 'patrol' | 'guard';
}

/** The chain of points a unit is heading for: current order, then its queue (and the far end of a patrol). */
export function waypointChain(w: World, e: Entity): WaypointPt[] {
  const out: WaypointPt[] = [];
  const o = e.order;
  if (e.patrol) out.push({ x: e.patrol.bx, y: e.patrol.by, kind: 'patrol' }, { x: e.patrol.ax, y: e.patrol.ay, kind: 'patrol' });
  else if (o.type === 'move' || o.type === 'attackMove') out.push({ x: o.x, y: o.y, kind: o.type });
  else if (o.type === 'attack') {
    const t = w.get(o.target);
    if (t) out.push({ x: t.x, y: t.y, kind: 'attack' });
  }
  if (e.guardId >= 0) {
    const t = w.get(e.guardId);
    if (t) out.push({ x: t.x, y: t.y, kind: 'guard' });
  }
  for (const q of e.queue) {
    if ('target' in q) {
      const t = w.get(q.target);
      if (t) out.push({ x: t.x, y: t.y, kind: q.type });
    } else out.push({ x: q.x, y: q.y, kind: q.type });
  }
  return out;
}
