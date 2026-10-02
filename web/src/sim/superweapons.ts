// Per-nation superweapons (Red Alert 2 style): one special structure per nation,
// unlocked by the Battle Lab, charging a long timer (paused on low power). Every
// player is told when one is built, when it is ready and when it is launched.
// The strikes reuse the normal simulation: real projectiles with their flights
// (interceptable by air defences, multi-hit interceptHp), kamikaze drones (shot
// down by AA, jammed by EW), and Israel's Iron Beam is a temporary laser dome
// that burns every enemy rocket / missile / shell-less munition and drone out of
// the sky. Deterministic: only the world's seeded RNG, no wall clock.

import { DEFS, WEAPONS, buildingDef, munitionDef, unitDef } from './defs';
import { launch } from './ballistics';
import { canGarrisonUnit, garrisonRoom } from './garrison';
import { standHeight } from './map';
import { IRON_BEAM_AIR_DPT, IRON_BEAM_RADIUS, IRON_BEAM_SHOTS, IRON_BEAM_TICKS, SW_BY_FACTION, SW_INFO, type SwInfo, type SwKind } from './specialdefs';
import { TPS, type Entity, type Player, type SuperweaponState } from './types';
import type { Controller, World } from './world';

export function newSuperweaponState(): SuperweaponState {
  return { at: -1, from: 0, readyTold: false, beam: null, queue: [] };
}

export function swKindOf(p: Player): SwKind {
  return SW_BY_FACTION[p.faction];
}

export function swInfoOf(p: Player): SwInfo {
  return SW_INFO[swKindOf(p)];
}

/** The player's completed superweapon structure (lowest id), if any. */
export function swBuilding(w: World, pid: number): Entity | undefined {
  let best: Entity | undefined;
  for (const e of w.list) {
    if (e.dead || e.owner !== pid || e.kind !== 'building' || e.buildAnim < 1) continue;
    if (!buildingDef(e.def).superweapon) continue;
    if (!best || e.id < best.id) best = e;
  }
  return best;
}

export interface SuperweaponStatus {
  kind: SwKind;
  info: SwInfo;
  unlocked: boolean; // owns a completed superweapon structure
  ready: boolean;
  progress: number; // 0..1
  secondsLeft: number;
  /** Iron Beam: seconds of dome left (0 when off). */
  beamLeft: number;
}

export function superweaponStatus(w: World, pid: number): SuperweaponStatus {
  const p = w.players[pid];
  const info = swInfoOf(p);
  const sw = p.sw;
  const beamLeft = sw.beam ? Math.max(0, Math.ceil((sw.beam.until - w.tick) / TPS)) : 0;
  if (sw.at < 0) return { kind: info.kind, info, unlocked: false, ready: false, progress: 0, secondsLeft: 0, beamLeft };
  const total = Math.max(1, sw.at - sw.from);
  const left = Math.max(0, sw.at - w.tick);
  return { kind: info.kind, info, unlocked: true, ready: left === 0, progress: 1 - left / total, secondsLeft: Math.ceil(left / TPS), beamLeft };
}

// ------------------------------------------------------------------ per tick

/** Charge timers, warnings, staggered salvos and the Iron Beam dome. Runs every tick after the economy update. */
export function updateSuperweapons(w: World) {
  for (const p of w.players) {
    const sw = p.sw;
    const b = p.defeated ? undefined : swBuilding(w, p.id);
    const kind = swKindOf(p);
    if (!b) {
      if (sw.at >= 0) {
        sw.at = -1;
        sw.readyTold = false;
        w.events.push({ t: 'superweapon', owner: p.id, sw: kind, phase: 'lost', x: p.startX, y: p.startY });
      }
      sw.queue.length = 0;
    } else if (sw.at < 0) {
      sw.from = w.tick;
      sw.at = w.tick + SW_INFO[kind].charge;
      sw.readyTold = false;
      w.events.push({ t: 'superweapon', owner: p.id, sw: kind, phase: 'detected', x: b.x, y: b.y });
    } else if (w.tick < sw.at) {
      if (w.isLowPower(p)) {
        sw.at++;
        sw.from++;
      }
    } else if (!sw.readyTold) {
      sw.readyTold = true;
      w.events.push({ t: 'superweapon', owner: p.id, sw: kind, phase: 'ready', x: b.x, y: b.y });
    }
    if (b && sw.queue.length) runQueue(w, p, b);
    if (sw.beam) updateBeam(w, p);
  }
}

/** Validate and fire the player's superweapon at (x, y) (the 'superweapon' command). */
export function fireSuperweapon(w: World, pid: number, x: number, y: number): boolean {
  const p = w.players[pid];
  if (!p || p.defeated || !Number.isFinite(x) || !Number.isFinite(y)) return false;
  const { w: W, h: H } = w.map;
  if (x < 0 || y < 0 || x >= W || y >= H) return false;
  const sw = p.sw;
  const b = swBuilding(w, pid);
  if (!b || sw.at < 0 || w.tick < sw.at) return false;
  const kind = swKindOf(p);
  sw.from = w.tick;
  sw.at = w.tick + SW_INFO[kind].charge;
  sw.readyTold = false;
  w.events.push({ t: 'superweapon', owner: pid, sw: kind, phase: 'launch', x, y });
  const q = sw.queue;
  const t0 = w.tick;
  const spread = (r: number): [number, number] => {
    const a = w.rng.next() * Math.PI * 2;
    const d = Math.sqrt(w.rng.next()) * r;
    return [x + Math.cos(a) * d, y + Math.sin(a) * d];
  };
  switch (kind) {
    case 'darkEagle':
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.4;
        q.push({ at: t0 + i * 6, what: 'sw_darkEagle', x: x + Math.cos(a) * 1.4, y: y + Math.sin(a) * 1.4, target: -1 });
      }
      break;
    case 'ironBeam':
      sw.beam = { x, y, until: w.tick + IRON_BEAM_TICKS };
      break;
    case 'droneSwarm':
      for (let i = 0; i < 24; i++) q.push({ at: t0 + Math.floor(i / 2) * 2, what: 'drone:micro', x, y, target: -1 });
      break;
    case 'tos2':
      for (let i = 0; i < 30; i++) {
        const [ax, ay] = spread(4.5);
        q.push({ at: t0 + i * 2, what: 'sw_tos2', x: ax, y: ay, target: -1 });
      }
      break;
    case 'taurusSalvo': {
      const targets = valuableBuildings(w, pid, x, y, 7, 4);
      for (let i = 0; i < 4; i++) {
        const t = targets.length ? targets[i % targets.length] : null;
        const [ax, ay] = t ? [t.x, t.y] : spread(2);
        q.push({ at: t0 + i * 10, what: 'sw_taurus', x: ax, y: ay, target: t ? t.id : -1 });
      }
      break;
    }
    case 'hyunmoo5':
      q.push({ at: t0, what: 'sw_hyunmoo5', x, y, target: -1 });
      break;
    case 'neptuneFpv':
      for (let i = 0; i < 2; i++) {
        const [ax, ay] = spread(1.5);
        q.push({ at: t0 + i * 12, what: 'sw_neptune', x: ax, y: ay, target: -1 });
      }
      for (let i = 0; i < 12; i++) q.push({ at: t0 + TPS * 6 + i * 3, what: 'drone:fpv', x, y, target: -1 });
      break;
    case 'kizilelma':
      for (let i = 0; i < 3; i++) q.push({ at: t0 + i * 8, what: 'akinci', x, y, target: -1 });
      for (let i = 0; i < 12; i++) q.push({ at: t0 + TPS * 2 + i * 3, what: i % 3 === 0 ? 'drone:shahed' : 'drone:micro', x, y, target: -1 });
      break;
    case 'kheibar':
      for (let i = 0; i < 6; i++) {
        const [ax, ay] = spread(3.2);
        q.push({ at: t0 + i * 8, what: i % 3 === 2 ? 'sw_fattah' : 'sw_kheibar', x: ax, y: ay, target: -1 });
      }
      break;
  }
  return true;
}

function runQueue(w: World, p: Player, b: Entity) {
  const q = p.sw.queue;
  let k = 0;
  for (const item of q) {
    if (item.at > w.tick) {
      q[k++] = item;
      continue;
    }
    if (item.what.startsWith('drone:')) launchDrone(w, p, b, item.what.slice(6), item.x, item.y);
    else if (item.what === 'akinci') launchAkinci(w, p, b, item.x, item.y);
    else strike(w, b, item.what, item.x, item.y, item.target);
  }
  q.length = k;
}

/** Fire one superweapon munition from the structure at (x, y) (optionally locked on an entity). */
function strike(w: World, src: Entity, weaponId: string, x: number, y: number, target: number) {
  const wpn = WEAPONS[weaponId];
  if (!wpn) return;
  const t = target >= 0 ? w.get(target) : undefined;
  const aim = t ?? ({ id: -1, kind: 'building', def: '', x, y } as unknown as Entity);
  launch(w, src, aim, wpn, t ? t.x : x, t ? t.y : y);
}

/** Enemy entities near (x, y) for drones to hunt: structures and ground units, nearest first (falls back to the nearest enemy anywhere). */
function huntList(w: World, pid: number, x: number, y: number, r: number): Entity[] {
  const near: { e: Entity; d: number }[] = [];
  let fallback: Entity | null = null;
  let fd = Infinity;
  for (const e of w.list) {
    if (e.dead || e.inside >= 0 || !w.isEnemy(pid, e.owner)) continue;
    if (e.kind === 'unit') {
      const d = unitDef(e.def);
      if (d.air || d.temp) continue;
    }
    const d = w.distTo({ x, y } as Entity, e);
    if (d <= r) near.push({ e, d });
    else if (d < fd) {
      fd = d;
      fallback = e;
    }
  }
  near.sort((a, b) => a.d - b.d || a.e.id - b.e.id);
  if (near.length) return near.map((n) => n.e);
  return fallback ? [fallback] : [];
}

function launchDrone(w: World, p: Player, b: Entity, kind: string, x: number, y: number) {
  const defId = munitionDef(p.faction, kind);
  if (!DEFS[defId]) return;
  const list = huntList(w, p.id, x, y, 5);
  const m = w.spawnUnit(defId, p.id, b.x + w.rng.range(-0.8, 0.8), b.y + w.rng.range(-0.8, 0.8));
  m.z = m.pz = 0.5;
  m.life = TPS * 60;
  m.facing = m.pfacing = m.turret = m.pturret = Math.atan2(y - b.y, x - b.x) + w.rng.range(-0.5, 0.5);
  m.spawner = b.id;
  if (list.length) {
    const t = list[m.id % Math.min(list.length, 8)];
    m.order = { type: 'attack', target: t.id };
    m.targetId = t.id;
  }
}

function launchAkinci(w: World, p: Player, b: Entity, x: number, y: number) {
  const defId = `${p.faction}_akinci`;
  const d = DEFS[defId] ? defId : `${p.faction}_uav`;
  if (!DEFS[d]) return;
  const u = w.spawnUnit(d, p.id, b.x + w.rng.range(-1, 1), b.y + w.rng.range(-1, 1));
  u.z = u.pz = 1.2;
  u.facing = u.pfacing = u.turret = u.pturret = Math.atan2(y - b.y, x - b.x);
  u.order = { type: 'attackMove', x, y };
  u.guardX = x;
  u.guardY = y;
  w.pathTo(u, x, y);
}

/** Highest-value enemy structures within r of (x, y) (Taurus targets). */
function valuableBuildings(w: World, pid: number, x: number, y: number, r: number, n: number): Entity[] {
  const out: { e: Entity; v: number }[] = [];
  for (const e of w.list) {
    if (e.dead || e.kind !== 'building' || !w.isEnemy(pid, e.owner)) continue;
    const d = w.distTo({ x, y } as Entity, e);
    if (d > r) continue;
    out.push({ e, v: buildingValue(e) - d * 0.5 });
  }
  out.sort((a, b) => b.v - a.v || a.e.id - b.e.id);
  return out.slice(0, n).map((o) => o.e);
}

const ROLE_VALUE: Record<string, number> = { superweapon: 14, conyard: 12, factory: 10, refinery: 9, tech: 9, airfield: 7, radar: 6, power: 6, barracks: 5, def_aa: 5, def_at: 4, def_gun: 3 };

export function buildingValue(e: Entity): number {
  const bd = buildingDef(e.def);
  return ROLE_VALUE[bd.role] ?? (bd.garrison ? 2 + e.passengers.length : 4);
}

// ------------------------------------------------------------------ Iron Beam

function updateBeam(w: World, p: Player) {
  const beam = p.sw.beam!;
  const kind = swKindOf(p);
  const g = standHeight(w.map, beam.x, beam.y);
  const ez = Math.max(g, 0) + 0.7;
  if (w.tick >= beam.until) {
    p.sw.beam = null;
    w.events.push({ t: 'superweapon', owner: p.id, sw: kind, phase: 'end', x: beam.x, y: beam.y });
    return;
  }
  const R = IRON_BEAM_RADIUS;
  let shots = IRON_BEAM_SHOTS;
  const zap = (tx: number, ty: number, tz: number) => w.events.push({ t: 'superweapon', owner: p.id, sw: kind, phase: 'beam', x: beam.x, y: beam.y, z: ez, tx, ty, tz });
  // every enemy rocket, missile and bomb in flight inside the dome (shells are too small and too fast)
  for (const pr of w.projectiles) {
    if (shots <= 0) break;
    if (pr.dead || pr.flight === 'shell' || !w.isEnemy(p.id, pr.owner)) continue;
    if (Math.hypot(pr.x - beam.x, pr.y - beam.y) > R) continue;
    if (pr.z - Math.max(0, standHeight(w.map, pr.x, pr.y)) < 0.3 || pr.age < 2) continue;
    pr.dead = true;
    w.events.push({ t: 'airburst', x: pr.x, y: pr.y, z: pr.z, kind: 'kill', weapon: 'sw_ironBeam', victim: pr.flight, victimId: pr.id, victimWeapon: pr.weapon, hpLeft: 0, maxHp: pr.maxHp });
    zap(pr.x, pr.y, pr.z);
    shots--;
  }
  // drones: kamikazes are burned outright, other aircraft take heavy laser damage
  if (shots <= 0) return;
  const src = { id: -1, owner: p.id, rank: 0, inside: -1 } as unknown as Entity;
  w.queryRadius(beam.x, beam.y, R, (o) => {
    if (shots <= 0 || o.kind !== 'unit' || !w.isEnemy(p.id, o.owner) || o.para) return;
    const od = unitDef(o.def);
    if (!od.air || Math.hypot(o.x - beam.x, o.y - beam.y) > R) return;
    const oz = Math.max(0, standHeight(w.map, o.x, o.y)) + o.z;
    if (od.kamikaze) {
      zap(o.x, o.y, oz);
      w.damage(o, o.hp + 1e3, 'laser', src);
      shots--;
      return;
    }
    w.damage(o, IRON_BEAM_AIR_DPT, 'laser', src);
    if ((w.tick + o.id) % 4 === 0) zap(o.x, o.y, oz);
    shots--;
  });
}

// ------------------------------------------------------------------ AI

/**
 * Superweapon AI (a separate controller next to the main AIController): builds
 * the structure once a Battle Lab stands and the economy allows, fires offensive
 * powers at the most valuable enemy cluster, and raises the Iron Beam when a
 * strike or a swarm is inbound. Also tucks idle infantry into an empty house
 * next to them. Deterministic (decisions only from world state).
 */
export class SuperweaponAI implements Controller {
  constructor(
    private w: World,
    private pid: number,
  ) {}

  update() {
    const w = this.w;
    const p = w.players[this.pid];
    if (!p || p.defeated || w.over || (w.tick + this.pid * 7) % 20 !== 0) return;
    this.build(p);
    if ((w.tick + this.pid * 7) % 200 === 0) this.garrison();
    const st = superweaponStatus(w, this.pid);
    if (st.ready) {
      const t = st.info.defensive ? this.defensiveSpot() : this.offensiveSpot();
      if (t) w.issue(this.pid, { type: 'superweapon', x: t[0], y: t[1] });
    }
  }

  private build(p: Player) {
    const w = this.w;
    const id = `${p.faction}_superweapon`;
    if (p.queues.building.length || p.ready.building || p.credits < 1500 || !w.canBuild(this.pid, id)) return;
    for (const e of w.list) if (!e.dead && e.owner === this.pid && e.def === id) return;
    if (p.powerOut - p.powerUse < 150) return; // let the main AI add power first
    w.issue(this.pid, { type: 'produce', def: id });
  }

  /** Idle riflemen near an empty house move in (one held house at a time, so the waves keep their infantry). */
  private garrison() {
    const w = this.w;
    let held = 0;
    for (const e of w.list) if (!e.dead && e.owner === this.pid && e.kind === 'building' && buildingDef(e.def).garrison) held++;
    if (held >= 1) return;
    for (const h of w.list) {
      if (h.dead || h.kind !== 'building' || h.owner >= 0 || !buildingDef(h.def).garrison) continue;
      const room = garrisonRoom(w, h, this.pid);
      const ids: number[] = [];
      w.queryRadius(h.x, h.y, 7, (o) => {
        if (ids.length >= Math.min(room, 4) || o.owner !== this.pid || o.kind !== 'unit' || o.order.type !== 'idle' || o.path) return;
        if (canGarrisonUnit(o.def) && w.distTo(o, h) < 7) ids.push(o.id);
      });
      if (ids.length >= 2) {
        w.issue(this.pid, { type: 'enter', ids, target: h.id });
        return;
      }
    }
  }

  /** Centre of the richest enemy cluster (structures weigh most). */
  private offensiveSpot(): [number, number] | null {
    const w = this.w;
    const r = Math.max(3, swInfoOf(w.players[this.pid]).radius);
    let best: Entity | null = null;
    let bestV = 0;
    for (const e of w.list) {
      if (e.dead || e.kind !== 'building' || !w.isEnemy(this.pid, e.owner)) continue;
      let v = 0;
      w.queryRadius(e.x, e.y, r, (o) => {
        if (!w.isEnemy(this.pid, o.owner) || w.distTo({ x: e.x, y: e.y } as Entity, o) > r) return;
        if (o.kind === 'building') v += buildingValue(o);
        else if (!unitDef(o.def).temp) v += Math.min(4, DEFS[o.def].cost / 400);
      });
      if (v > bestV || (v === bestV && best && e.id < best.id)) {
        bestV = v;
        best = e;
      }
    }
    return best ? [best.x, best.y] : null;
  }

  /** Iron Beam: raise the dome over our own stuff when several threats (or an enemy superweapon) are inbound. */
  private defensiveSpot(): [number, number] | null {
    const w = this.w;
    let n = 0;
    let sx = 0;
    let sy = 0;
    let heavy = false;
    for (const pr of w.projectiles) {
      if (pr.dead || pr.flight === 'shell' || !w.isEnemy(this.pid, pr.owner)) continue;
      // aimed at something of ours?
      let ours = false;
      w.queryRadius(pr.tx, pr.ty, 2, (o) => {
        if (o.owner === this.pid) ours = true;
      });
      if (!ours) continue;
      n++;
      sx += pr.tx;
      sy += pr.ty;
      if (pr.weapon.startsWith('sw_')) heavy = true;
    }
    for (const e of w.list) {
      if (e.dead || e.kind !== 'unit' || !w.isEnemy(this.pid, e.owner) || !unitDef(e.def).kamikaze) continue;
      const t = w.get(e.targetId);
      if (!t || t.owner !== this.pid) continue;
      n++;
      sx += t.x;
      sy += t.y;
    }
    if (n >= 6 || (heavy && n >= 1)) return [sx / n, sy / n];
    return null;
  }
}
