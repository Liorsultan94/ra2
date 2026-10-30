// Computer player: reacting to what it sees (AIController's helper; ai.ts calls it once per think).
//
// - Snipers: a few, never a swarm. They take a house (or high ground) covering a route the enemy uses, or keep
//   a few tiles behind the wave in contact to pick off its soldiers; any enemy vehicle seen close sends them back.
// - Air defence: once enemy aircraft have been SEEN, waves that leave without AA get AA escorts (Hard raids an AA
//   vehicle), and once they have been seen over our side a few AA soldiers stay home.
// - Enemy armour seen massing: an anti-tank ambush on its way in (RPG teams in a house or on the high ground at
//   a crossing, holding fire until it is close), more anti-tank in production, an ATGM tower (Hard).
// - The enemy base seen empty (its army seen away): a fast raid group goes for its economy.
// - Enemy artillery / missile launchers seen: a few fast units hunt them.
//
// Fair play: everything here is driven by the AI's own intel (ai.ts updateIntel: what its units and structures
// saw, with the night's shorter sight and the fog of war) and by ground it can see now (World.visibleTo, the
// player's own rules). It never reads where enemy units are from the world. Deterministic: its own seeded RNG is
// not even needed - every choice is ordered by distance / id. Normal and Hard only (Easy plays as before).

import { DEFS, VERSUS, WEAPONS, buildingDef, factionDefByRole, hitsAir, unitDef } from './defs';
import { canGarrisonUnit, garrisonRoom } from './garrison';
import { isFast } from './plans';
import { TPS, type Entity, type Stance } from './types';
import type { World } from './world';

/** What the AI remembers of an enemy unit or structure (ai.ts Intel). */
export interface SeenIntel {
  x: number;
  y: number;
  def: string;
  building: boolean;
  seen: number;
}

type Known = [number, SeenIntel][];

/** What AIReact needs from its AIController (closures over its private state, like navalai.ts's host). */
export interface ReactHost {
  peace(): boolean;
  /** The first wave has gone out (the first attack stays the surprise it was). */
  attacked(): boolean;
  known(pred: (it: SeenIntel, id: number) => boolean, fresh: number): Known;
  home(): [number, number];
  rally(): [number, number];
  enemyBase(): [number, number] | null;
  lanes(): { x: number; y: number }[];
  bank(l: { x: number; y: number }, k: number): [number, number];
  highSpot(x: number, y: number, r: number): [number, number];
  threatAt(x: number, y: number, r: number): number;
  /** The enemy army seen away from its base (ai.ts enemyArmyAway). */
  armyAway(): boolean;
  klass(def: string): string;
  /** Is the unit free for the army (role 'army'), on a job here ('react'), or busy elsewhere. */
  role(u: Entity): string;
  claim(ids: number[], on: boolean): void;
  stance(ids: number[], s: Stance): void;
  /** The waves out now (newest last). */
  waves(): readonly { ids: number[]; born: number; feint?: boolean }[];
}

/** Per difficulty (Normal / Hard; Easy has none of this). */
interface ReactCfg {
  /** Most snipers alive or queued at once, posts they hold (houses / high ground). */
  snipers: number;
  sniperPosts: number;
  /** AA soldiers / vehicles kept home, AA escorts per wave, once enemy aircraft have been seen. */
  aaHome: number;
  aaEscort: number;
  /** Enemy armour (heavy 1, light 0.6) seen together that sets up the anti-tank ambush; its size; an ATGM tower too. */
  atMass: number;
  atSquad: number;
  atgm: boolean;
  /** Fast units in a base raid, in an artillery hunt. */
  raid: number;
  hunt: number;
  /** Threat (ai.ts threatAt) a hunt / a base raid still goes into. */
  huntThreat: number;
  raidThreat: number;
}

/** Switch (benches / tests measure what the reactions are worth). */
export const REACT_ON = { on: true, snipers: true, sniperCap: true, aa: true, at: true, raid: true, hunt: true };

export const REACT: Record<'normal' | 'hard', ReactCfg> = {
  normal: { snipers: 2, sniperPosts: 1, aaHome: 1, aaEscort: 1, atMass: 6, atSquad: 2, atgm: false, raid: 4, hunt: 2, huntThreat: 3, raidThreat: 6 },
  hard: { snipers: 3, sniperPosts: 2, aaHome: 2, aaEscort: 2, atMass: 5, atSquad: 3, atgm: true, raid: 6, hunt: 3, huntThreat: 5, raidThreat: 9 },
};

type Job =
  /** A sniper post: a house (id) or a spot on the ground; pulled back from vehicles until `back`. */
  | { kind: 'sniper'; house: number; x: number; y: number; back: number }
  /** A sniper keeping behind the wave in contact. */
  | { kind: 'overwatch'; back: number }
  /** Anti-tank ambush: in a house (id) or at a spot (holding fire until sprung). */
  | { kind: 'at'; house: number; x: number; y: number }
  /** Air defence at home. */
  | { kind: 'aa'; x: number; y: number }
  /** Base raid / artillery hunt: the target (id, last seen at x, y), until when. */
  | { kind: 'raid'; target: number; x: number; y: number; until: number }
  | { kind: 'hunt'; target: number; x: number; y: number; until: number };

/** Ambush ground / house and units within this many tiles of the rally point are free to take. */
const POOL_R = 14;
const AIR_MEMORY = TPS * 180;

/** Distance from (x, y) to the segment (x0, y0)-(x1, y1). */
function segDist(x: number, y: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l2)) : 0;
  return Math.hypot(x - x0 - dx * t, y - y0 - dy * t);
}

export const isSniper = (def: string): boolean => {
  const d = unitDef(def);
  return !!d.weapon && !!WEAPONS[d.weapon].aim;
};

/** Anti-armour soldier (an RPG team): infantry whose weapon does full damage to heavy armour. */
const isATSoldier = (def: string): boolean => {
  const d = unitDef(def);
  return d.category === 'infantry' && !!d.weapon && VERSUS[WEAPONS[d.weapon].warhead].heavy >= 0.8 && canGarrisonUnit(def);
};

/** Can it shoot at aircraft (an AA vehicle, a Rocket Team's MANPADS)? Ground units only. */
const isAA = (def: string): boolean => {
  const d = unitDef(def);
  return !d.air && hitsAir(d);
};

/** Enemy armour seen (a vehicle with a gun or launcher, on the ground). */
const armourWeight = (def: string): number => {
  const d = unitDef(def);
  if (d.category !== 'vehicle' || !d.weapon || d.air || d.harvester || d.mcv) return 0;
  return d.armor === 'heavy' ? 1 : 0.6;
};

/**
 * Enemy air power the AI has SEEN (fog of war: intel only, units seen in the last 90 s - ai.ts forgets them after
 * that), drone launchers half; at least 1 for three minutes after the last aircraft seen.
 */
export function seenAir(known: Known, lastSeen: number, tick: number): number {
  let n = 0;
  for (const [, it] of known) {
    if (it.building) continue;
    const d = unitDef(it.def);
    if (d.air && !d.temp && !d.airlift) n++;
    else if (d.weapon && WEAPONS[d.weapon].projectile === 'spawn') n += 0.5;
  }
  return n > 0 ? n : lastSeen >= 0 && tick - lastSeen < AIR_MEMORY ? 1 : 0;
}

export class AIReact {
  /** Debug / tests: snipers posted (house or high ground) and sent to overwatch, AA escorts attached, AA kept home,
   * anti-tank ambushes set up, ATGM towers ordered, base raids and artillery hunts launched. */
  readonly stats = { snipersPosted: 0, overwatch: 0, aaEscorts: 0, aaHome: 0, atAmbush: 0, atgm: 0, baseRaid: 0, artyHunt: 0 };
  private jobs = new Map<number, Job>();
  private cfg: ReactCfg;
  private airSeen = -1;
  /** When enemy aircraft were last seen over our side (near home). */
  private airHome = -Infinity;
  private escorted = 0;
  /** Anti-tank alert: until when, where the armour massed, when the last ambush was set up. */
  private atUntil = -1;
  private atAt: [number, number] = [0, 0];
  private atNext = 0;
  private raidNext = 0;
  private huntNext = 0;
  private postNext = 0;

  constructor(
    private w: World,
    private pid: number,
    difficulty: 'normal' | 'hard',
    private host: ReactHost,
  ) {
    this.cfg = REACT[difficulty];
  }

  /** Enemy aircraft seen (fog of war), for production and escorts (ai.ts enemyAirCount). */
  enemyAir(): number {
    return seenAir(this.host.known(() => true, TPS * 90), this.airSeen, this.w.tick);
  }

  /** Production weight multiplier (ai.ts manageProduction): snipers capped; anti-tank up while enemy armour masses. */
  prodWeight(d: ReturnType<typeof unitDef>): number {
    if (isSniper(d.id) && REACT_ON.sniperCap) {
      let n = 0;
      for (const e of this.w.list) if (!e.dead && e.owner === this.pid && e.kind === 'unit' && isSniper(e.def)) n++;
      for (const q of this.w.players[this.pid].queues.infantry) if (isSniper(q.def)) n++;
      return n >= this.cfg.snipers ? 0 : 1;
    }
    if (this.w.tick < this.atUntil && d.weapon && (d.category === 'infantry' || d.category === 'vehicle') && VERSUS[WEAPONS[d.weapon].warhead].heavy >= 0.8) return 1.3;
    return 1;
  }

  /** Once per think, before the army's own business (ai.ts update): `units` are ours, out in the open. */
  update(units: Entity[]) {
    const w = this.w;
    this.prune();
    // remember when enemy aircraft were last seen
    const [hx, hy] = this.host.home();
    for (const [, it] of this.host.known((it) => !it.building && !!unitDef(it.def).air && !unitDef(it.def).temp, TPS * 3)) {
      this.airSeen = w.tick;
      if (Math.hypot(it.x - hx, it.y - hy) < 35) this.airHome = w.tick;
    }
    const air = this.enemyAir();
    const free = this.free(units);
    if (REACT_ON.snipers) this.snipers(units, free);
    if (REACT_ON.aa) this.airDefence(units, free, air);
    if (REACT_ON.at) this.antiTank(free);
    if (!this.host.peace()) {
      if (REACT_ON.raid) this.baseRaid(free, air);
      if (REACT_ON.hunt) this.artyHunt(free);
    }
    this.runJobs();
  }

  // ------------------------------------------------------------------ bookkeeping

  /** Forget the dead and units the rest of the AI took back (a retreat to repair, a base defence). */
  private prune() {
    for (const [id] of this.jobs) {
      const u = this.w.get(id);
      if (!u || u.dead || this.host.role(u) !== 'react') this.jobs.delete(id);
    }
  }

  /** Our idle army units near the rally point (not escorting anyone): free to take. */
  private free(units: Entity[]): Entity[] {
    const [rx, ry] = this.host.rally();
    const [hx, hy] = this.host.home();
    return units.filter((u) => this.host.role(u) === 'army' && u.order.type === 'idle' && u.guardId < 0 && (Math.hypot(u.x - rx, u.y - ry) < POOL_R || Math.hypot(u.x - hx, u.y - hy) < POOL_R));
  }

  private take(free: Entity[], picked: Entity[], job: (u: Entity) => Job) {
    const ids = picked.map((u) => u.id);
    this.host.claim(ids, true);
    for (const u of picked) {
      this.jobs.set(u.id, job(u));
      const k = free.indexOf(u);
      if (k >= 0) free.splice(k, 1);
    }
  }

  private release(ids: number[], to?: [number, number]) {
    if (!ids.length) return;
    for (const id of ids) this.jobs.delete(id);
    this.host.claim(ids, false);
    this.host.stance(ids, 'guard');
    const [x, y] = to ?? this.host.rally();
    this.w.issue(this.pid, { type: 'move', ids, x, y });
  }

  private count(kind: Job['kind']): number {
    let n = 0;
    for (const j of this.jobs.values()) if (j.kind === kind) n++;
    return n;
  }

  /** Known enemy vehicles seen just now within r of (x, y) - what a sniper keeps away from. */
  private vehiclesNear(x: number, y: number, r: number): boolean {
    for (const [, it] of this.host.known((it) => !it.building && armourWeight(it.def) > 0, TPS * 3)) if (Math.hypot(it.x - x, it.y - y) < r) return true;
    return false;
  }

  /** Houses (neutral, or ours with room) within `reach` of the way a->b, on our part of the map; best first. */
  private houses(ax: number, ay: number, bx: number, by: number, reach: number, room: number, maxHome: number): Entity[] {
    const w = this.w;
    const [hx, hy] = this.host.home();
    const near = this.host.known((it) => !it.building, TPS * 10);
    const out: { h: Entity; s: number }[] = [];
    for (const h of w.list) {
      if (h.dead || h.kind !== 'building' || !buildingDef(h.def).garrison || garrisonRoom(w, h, this.pid) < room) continue;
      const dh = Math.hypot(h.x - hx, h.y - hy);
      if (dh > maxHome || dh < 6) continue;
      const r = segDist(h.x, h.y, ax, ay, bx, by);
      if (r > reach) continue;
      // (not one the enemy is standing next to)
      if (near.some(([, it]) => Math.hypot(it.x - h.x, it.y - h.y) < 7)) continue;
      out.push({ h, s: r + dh * 0.08 });
    }
    out.sort((a, b) => a.s - b.s || a.h.id - b.h.id);
    return out.map((o) => o.h);
  }

  // ------------------------------------------------------------------ snipers

  private snipers(units: Entity[], free: Entity[]) {
    const w = this.w;
    const host = this.host;
    const enemy = host.enemyBase();
    if (!enemy) return;
    const [hx, hy] = host.home();
    const span = Math.hypot(enemy[0] - hx, enemy[1] - hy);
    const idle = free.filter((u) => isSniper(u.def));
    // (a sniper that came back from a wave: idle at home again)
    for (const u of units) if (isSniper(u.def) && host.role(u) === 'army' && u.order.type === 'idle' && u.guardId < 0 && !idle.includes(u) && Math.hypot(u.x - hx, u.y - hy) < 30) idle.push(u);
    for (const u of idle) {
      if (this.count('sniper') < this.cfg.sniperPosts && w.tick >= this.postNext) {
        const post = this.sniperPost(enemy, span);
        if (post) {
          this.take(free, [u], () => ({ kind: 'sniper', house: post.house, x: post.x, y: post.y, back: 0 }));
          host.stance([u.id], 'hold');
          if (post.house >= 0) w.issue(this.pid, { type: 'enter', ids: [u.id], target: post.house });
          else w.issue(this.pid, { type: 'move', ids: [u.id], x: post.x, y: post.y });
          this.stats.snipersPosted++;
          this.postNext = w.tick + TPS * 20;
          continue;
        }
      }
      this.take(free, [u], () => ({ kind: 'overwatch', back: 0 }));
      host.stance([u.id], 'hold');
      this.stats.overwatch++;
    }
  }

  /** A sniper post: a house on a route the enemy uses (the first post), else high ground behind a crossing on our half. */
  private sniperPost(enemy: [number, number], span: number): { house: number; x: number; y: number } | null {
    const host = this.host;
    const [hx, hy] = host.home();
    const taken = [...this.jobs.values()].filter((j) => j.kind === 'sniper') as Extract<Job, { kind: 'sniper' }>[];
    // routes: home -> lane -> enemy base, and the straight way
    const lanes = host.lanes();
    for (const [ax, ay, bx, by] of [[hx, hy, enemy[0], enemy[1]], ...lanes.map((l) => [l.x, l.y, hx, hy])]) {
      const h = this.houses(ax, ay, bx, by, 6, 1, span * 0.45).find((h) => !taken.some((j) => j.house === h.id));
      if (h) return { house: h.id, x: h.x, y: h.y };
    }
    // high ground a few tiles behind the crossings on our half (nearest home first), else on the straight way
    const ours = lanes.filter((l) => Math.hypot(l.x - hx, l.y - hy) < span * 0.55).sort((a, b) => Math.hypot(a.x - hx, a.y - hy) - Math.hypot(b.x - hx, b.y - hy));
    for (const l of ours) {
      const [bx, by] = host.bank(l, 7);
      const p = host.highSpot(bx, by, 3);
      if (!taken.some((j) => Math.hypot(j.x - p[0], j.y - p[1]) < 5) && !this.vehiclesNear(p[0], p[1], 10)) return { house: -1, x: p[0], y: p[1] };
    }
    if (taken.length) return null;
    const k = Math.min(0.3, 30 / Math.max(1, span));
    const p = host.highSpot(hx + (enemy[0] - hx) * k, hy + (enemy[1] - hy) * k, 4);
    return this.vehiclesNear(p[0], p[1], 10) ? null : { house: -1, x: p[0], y: p[1] };
  }

  // ------------------------------------------------------------------ air defence

  private airDefence(units: Entity[], free: Entity[], air: number) {
    const w = this.w;
    const host = this.host;
    const home = [...this.jobs].filter(([, j]) => j.kind === 'aa').map(([id]) => id);
    const overUs = w.tick - this.airHome < AIR_MEMORY;
    if (air <= 0 || !overUs) {
      // no enemy aircraft over our side for a while: the home guard rejoins the army
      this.release(home);
      if (air <= 0) return;
    }
    // AA at home: the AA vehicles waiting at the rally point already guard it (ai.ts launch takes only escorts from
    // them); once enemy aircraft have come over our side, Rocket Teams stay home where they are too few
    const need = this.cfg.aaHome - home.length - free.filter((u) => host.klass(u.def) === 'aa').length;
    if (need > 0 && overUs) {
      const [hx, hy] = host.home();
      const [rx, ry] = host.rally();
      const pick = free
        .filter((u) => isAA(u.def) && host.klass(u.def) === 'main')
        .sort((a, b) => a.id - b.id)
        .slice(0, need);
      if (pick.length) {
        // between the base and the rally point
        const [x, y] = host.highSpot(hx + (rx - hx) * 0.35, hy + (ry - hy) * 0.35, 2);
        this.take(free, pick, () => ({ kind: 'aa', x, y }));
        host.stance(pick.map((u) => u.id), 'guard');
        w.issue(this.pid, { type: 'move', ids: pick.map((u) => u.id), x, y });
        this.stats.aaHome += pick.length;
      }
    }
    // escorts for the waves that left since the last look: AA vehicles first, then Rocket Teams
    for (const wv of host.waves()) {
      if (wv.born <= this.escorted || wv.feint) continue;
      const mem = wv.ids.map((id) => w.get(id)).filter((u): u is Entity => !!u && !u.dead);
      if (!mem.length) continue;
      let have = 0;
      for (const u of mem) if (isAA(u.def)) have++;
      // (Rocket Teams marching with it count; and those guarding its leader: ai.ts launch's AA vehicles)
      const leader = [...mem].sort((a, b) => b.maxHp - a.maxHp || a.id - b.id)[0];
      for (const u of units) if (u.guardId === leader.id && isAA(u.def)) have++;
      const want = Math.min(this.cfg.aaEscort, Math.ceil(mem.length / 4));
      if (have >= want) continue;
      const esc = free
        .filter((u) => isAA(u.def))
        .sort((a, b) => (host.klass(b.def) === 'aa' ? 1 : 0) - (host.klass(a.def) === 'aa' ? 1 : 0) || a.id - b.id)
        .slice(0, want - have);
      if (!esc.length) continue;
      w.issue(this.pid, { type: 'guard', ids: esc.map((u) => u.id), target: leader.id });
      for (const u of esc) free.splice(free.indexOf(u), 1);
      this.stats.aaEscorts += esc.length;
    }
    const last = host.waves().at(-1);
    if (last) this.escorted = Math.max(this.escorted, last.born);
  }

  // ------------------------------------------------------------------ anti-tank ambush

  private antiTank(free: Entity[]) {
    const w = this.w;
    const host = this.host;
    if (host.peace()) return;
    const [hx, hy] = host.home();
    // enemy armour seen together (intel only: what our units and structures saw lately)
    const armour = host.known((it) => !it.building && armourWeight(it.def) > 0, TPS * 20);
    let best = 0;
    let at: [number, number] = [0, 0];
    for (const [, a] of armour) {
      let s = 0;
      let cx = 0;
      let cy = 0;
      for (const [, b] of armour) {
        if (Math.hypot(a.x - b.x, a.y - b.y) > 12) continue;
        const k = armourWeight(b.def);
        s += k;
        cx += b.x * k;
        cy += b.y * k;
      }
      if (s > best) {
        best = s;
        at = [cx / s, cy / s];
      }
    }
    // (an armoured force already in our base is the base defence's business)
    const enemy = host.enemyBase();
    const span = enemy ? Math.hypot(enemy[0] - hx, enemy[1] - hy) : 60;
    // (on our part of the way: armour massing at its own base may go anywhere; already in our base is the base defence's)
    const dAt = Math.hypot(at[0] - hx, at[1] - hy);
    if (best >= this.cfg.atMass && dAt > 18 && dAt < span * 0.45) {
      if (w.tick >= this.atUntil) this.orderATGM();
      this.atUntil = w.tick + TPS * 60;
      this.atAt = at;
    }
    if (w.tick >= this.atUntil) {
      // the alert is over: the squad on open ground rejoins the army (those in a house hold it)
      this.release([...this.jobs].filter(([, j]) => j.kind === 'at' && j.house < 0).map(([id]) => id));
      return;
    }
    const have = this.count('at');
    if (have >= this.cfg.atSquad || w.tick < this.atNext) return;
    const [cx, cy] = this.atAt;
    const squad = free
      .filter((u) => isATSoldier(u.def))
      .sort((a, b) => a.id - b.id)
      .slice(0, this.cfg.atSquad - have);
    if (squad.length < Math.min(2, this.cfg.atSquad - have)) return;
    // the way in: a house next to it on our half, else the high ground behind the crossing it would take
    const ids = squad.map((u) => u.id);
    const house = this.houses(cx, cy, hx, hy, 6, squad.length, span * 0.5)[0];
    if (house) {
      this.take(free, squad, () => ({ kind: 'at', house: house.id, x: house.x, y: house.y }));
      w.issue(this.pid, { type: 'enter', ids, target: house.id });
    } else {
      let spot: [number, number] | null = null;
      let sd = 10;
      for (const l of host.lanes()) {
        const dl = Math.hypot(l.x - hx, l.y - hy);
        const d = segDist(l.x, l.y, cx, cy, hx, hy);
        if (dl < span * 0.55 && dl > 8 && d < sd) {
          sd = d;
          spot = host.bank(l, 4);
        }
      }
      if (!spot) {
        const d = Math.hypot(cx - hx, cy - hy) || 1;
        const k = Math.min(0.45, Math.max(14, d * 0.35) / d);
        spot = [hx + (cx - hx) * k, hy + (cy - hy) * k];
      }
      const [x, y] = host.highSpot(spot[0], spot[1], 3);
      this.take(free, squad, () => ({ kind: 'at', house: -1, x, y }));
      host.stance(ids, 'holdFire');
      w.issue(this.pid, { type: 'move', ids, x, y });
    }
    this.atNext = w.tick + TPS * 30;
    this.stats.atAmbush++;
  }

  /** Hard: an ATGM tower at home against the armour seen massing (placed by ai.ts manageBuildings). */
  private orderATGM() {
    const w = this.w;
    const p = w.players[this.pid];
    if (!this.cfg.atgm || p.credits < 1200 || p.queues.defense.length || p.ready.defense) return;
    const d = factionDefByRole(p.faction, 'def_at');
    if (!d || !w.canBuild(this.pid, d.id)) return;
    let n = 0;
    for (const e of w.list) if (!e.dead && e.owner === this.pid && e.def === d.id) n++;
    if (n >= 2) return;
    w.issue(this.pid, { type: 'produce', def: d.id });
    this.stats.atgm++;
  }

  // ------------------------------------------------------------------ base raid

  /**
   * The enemy base seen with its army away (extends ai.ts's opportunity wave): fast units go for its economy
   * while it is empty. Only with the base in sight now (or the ground there revealed, by day) and its army seen
   * elsewhere: an unscouted base, or one hidden by the night, is not known to be empty.
   */
  private baseRaid(free: Entity[], air: number) {
    const w = this.w;
    const host = this.host;
    if (!host.attacked() || w.tick < this.raidNext || this.count('raid')) return;
    const base = host.enemyBase();
    if (!base || !w.visibleTo(this.pid, base[0], base[1])) return;
    // its fighting units seen at home just now, and seen away lately
    let home = 0;
    let away = 0;
    for (const [, it] of host.known((it) => !it.building && ['main', 'aa', 'arty'].includes(host.klass(it.def)) && !unitDef(it.def).air, TPS * 25)) {
      const d = Math.hypot(it.x - base[0], it.y - base[1]);
      if (d < 16 && w.tick - it.seen <= TPS * 3) home++;
      else if (d > 30) away++;
    }
    if (home > 2 || (away < 4 && !host.armyAway())) return;
    // the softest valuable structure we know of there
    const VALUE: Record<string, number> = { refinery: 9, power: 8, factory: 7, conyard: 7, barracks: 5, radar: 5, airfield: 5 };
    let target = -1;
    let ts = -Infinity;
    let tx = 0;
    let ty = 0;
    for (const [id, it] of host.known((it) => it.building && Math.hypot(it.x - base[0], it.y - base[1]) < 20, TPS * 30)) {
      const v = VALUE[buildingDef(it.def).role];
      if (!v) continue;
      const threat = host.threatAt(it.x, it.y, 8);
      if (threat > this.cfg.raidThreat) continue;
      const s = v * 2 - threat;
      if (s > ts || (s === ts && id < target)) {
        ts = s;
        target = id;
        tx = it.x;
        ty = it.y;
      }
    }
    if (target < 0) return;
    const fast = free
      .filter((u) => host.klass(u.def) === 'main' && isFast(u.def) && !unitDef(u.def).fixedWing)
      .sort((a, b) => unitDef(b.def).speed - unitDef(a.def).speed || a.id - b.id)
      .slice(0, this.cfg.raid);
    if (fast.length < 3) return;
    const ids = fast.map((u) => u.id);
    this.take(free, fast, () => ({ kind: 'raid', target, x: tx, y: ty, until: w.tick + TPS * 80 }));
    host.stance(ids, 'aggressive');
    w.issue(this.pid, { type: 'attack', ids, target });
    w.issue(this.pid, { type: 'move', ids, x: base[0], y: base[1], attackMove: true, queue: true });
    // with an AA vehicle along when enemy aircraft have been seen
    const aa = air > 0 ? free.find((u) => host.klass(u.def) === 'aa') : undefined;
    if (aa) {
      w.issue(this.pid, { type: 'guard', ids: [aa.id], target: fast[0].id });
      free.splice(free.indexOf(aa), 1);
      this.stats.aaEscorts++;
    }
    this.raidNext = w.tick + TPS * 150;
    this.stats.baseRaid++;
  }

  // ------------------------------------------------------------------ artillery hunt

  /** Enemy guns / missile launchers seen out in the field: a few fast units hunt them down. */
  private artyHunt(free: Entity[]) {
    const w = this.w;
    const host = this.host;
    if (w.tick < this.huntNext || this.count('hunt')) return;
    const base = host.enemyBase();
    const [rx, ry] = host.rally();
    const [hx, hy] = host.home();
    const span = base ? Math.hypot(base[0] - hx, base[1] - hy) : 0;
    let target = -1;
    let td = Infinity;
    let at: SeenIntel | null = null;
    for (const [id, it] of host.known((it) => !it.building && ['arty', 'strike'].includes(host.klass(it.def)) && !unitDef(it.def).air, TPS * 12)) {
      // (deep in its base: that is a raid's business, not a hunt's)
      if (base && Math.hypot(it.x - base[0], it.y - base[1]) < 14) continue;
      // (guns on our half of the map - shelling us - not escorted by more than a few: never into an enemy wave)
      if (span > 0 && Math.hypot(it.x - hx, it.y - hy) > span * 0.5) continue;
      if (host.threatAt(it.x, it.y, 7) > this.cfg.huntThreat) continue;
      const d = Math.hypot(it.x - rx, it.y - ry);
      if (d < td) {
        td = d;
        target = id;
        at = it;
      }
    }
    if (!at) return;
    const hunters = free
      .filter((u) => host.klass(u.def) === 'main' && isFast(u.def) && !unitDef(u.def).fixedWing)
      .sort((a, b) => unitDef(b.def).speed - unitDef(a.def).speed || a.id - b.id)
      .slice(0, this.cfg.hunt);
    if (hunters.length < 2) return;
    const ids = hunters.map((u) => u.id);
    this.take(free, hunters, () => ({ kind: 'hunt', target, x: at!.x, y: at!.y, until: w.tick + TPS * 70 }));
    host.stance(ids, 'aggressive');
    w.issue(this.pid, { type: 'attack', ids, target });
    this.huntNext = w.tick + TPS * 75;
    this.stats.artyHunt++;
  }

  // ------------------------------------------------------------------ the jobs

  private runJobs() {
    const w = this.w;
    const host = this.host;
    const done: number[] = [];
    // the newest wave in contact out on the map (for the snipers' overwatch)
    const [hx, hy] = host.home();
    let front: [number, number] | null = null;
    const wv = [...host.waves()].reverse().find((wv) => !wv.feint);
    if (wv) {
      let cx = 0;
      let cy = 0;
      let n = 0;
      for (const id of wv.ids) {
        const u = w.get(id);
        if (!u || u.dead || isSniper(u.def)) continue;
        cx += u.x;
        cy += u.y;
        n++;
      }
      if (n >= 3 && Math.hypot(cx / n - hx, cy / n - hy) > 18) front = [cx / n, cy / n];
    }
    const ends = new Map<string, number[]>();
    for (const [id, j] of this.jobs) {
      const u = w.get(id)!;
      const out = u.inside < 0;
      switch (j.kind) {
        case 'sniper':
        case 'overwatch': {
          if (!out) break;
          // a house that fell (or was taken): find another post
          if (j.kind === 'sniper' && j.house >= 0 && u.order.type === 'idle' && garrisonRoom(w, w.get(j.house) ?? u, this.pid) <= 0) {
            done.push(id);
            break;
          }
          // keep away from vehicles: back towards home, out of their way, for a while
          if (this.vehiclesNear(u.x, u.y, 9)) {
            if (w.tick >= j.back) {
              const dx = hx - u.x;
              const dy = hy - u.y;
              const len = Math.hypot(dx, dy) || 1;
              const step = Math.min(10, len);
              w.issue(this.pid, { type: 'move', ids: [id], x: u.x + (dx / len) * step, y: u.y + (dy / len) * step });
            }
            j.back = w.tick + TPS * 15;
            break;
          }
          if (w.tick < j.back || u.order.type !== 'idle') break;
          let x: number;
          let y: number;
          if (j.kind === 'sniper') {
            if (j.house >= 0) {
              w.issue(this.pid, { type: 'enter', ids: [id], target: j.house });
              break;
            }
            [x, y] = [j.x, j.y];
          } else if (front) {
            // a few tiles behind the wave, on its home side
            const dx = hx - front[0];
            const dy = hy - front[1];
            const len = Math.hypot(dx, dy) || 1;
            [x, y] = [front[0] + (dx / len) * 6, front[1] + (dy / len) * 6];
          } else [x, y] = host.rally();
          if (Math.hypot(u.x - x, u.y - y) > 3.5) w.issue(this.pid, { type: 'move', ids: [id], x, y });
          break;
        }
        case 'at': {
          if (!out) break;
          if (j.house >= 0) {
            if (u.order.type === 'idle') {
              // the house fell or was taken first: hold the ground next to it instead
              if (garrisonRoom(w, w.get(j.house) ?? u, this.pid) <= 0) {
                j.house = -1;
                host.stance([id], 'holdFire');
              } else w.issue(this.pid, { type: 'enter', ids: [id], target: j.house });
            }
            break;
          }
          // hold fire while the armour walks in, open up together once it is close (or shoots)
          let close = false;
          for (const [, it] of host.known((it) => !it.building, TPS * 2)) if (Math.hypot(it.x - j.x, it.y - j.y) < 6) close = true;
          host.stance([id], close || w.tick - u.lastHurt < TPS * 2 ? 'guard' : 'holdFire');
          if (u.order.type === 'idle' && u.targetId < 0 && Math.hypot(u.x - j.x, u.y - j.y) > 4) w.issue(this.pid, { type: 'move', ids: [id], x: j.x, y: j.y });
          break;
        }
        case 'aa':
          if (u.order.type === 'idle' && u.targetId < 0 && Math.hypot(u.x - j.x, u.y - j.y) > 4) w.issue(this.pid, { type: 'move', ids: [id], x: j.x, y: j.y });
          break;
        case 'raid':
        case 'hunt': {
          // the target seen just now: keep after it; gone, lost from sight, or time up: home
          const seen = host.known((_it, k) => k === j.target, TPS * 3)[0];
          if (seen) {
            j.x = seen[1].x;
            j.y = seen[1].y;
          }
          const gone = !host.known((_it, k) => k === j.target, TPS * 15).length;
          const key = `${j.kind}:${j.target}`;
          if (w.tick > j.until || (gone && (u.order.type === 'idle' || Math.hypot(u.x - j.x, u.y - j.y) < 4))) {
            ends.set(key, [...(ends.get(key) ?? []), id]);
          } else if (u.order.type === 'idle' && seen) w.issue(this.pid, { type: 'attack', ids: [id], target: j.target });
          else if (u.order.type === 'idle' && j.kind === 'raid') {
            // the structure fell: the next soft one we know of nearby
            const next = host.known((it) => it.building && Math.hypot(it.x - j.x, it.y - j.y) < 12 && DEFS[it.def]?.category !== 'defense', TPS * 30)[0];
            if (next) {
              j.target = next[0];
              w.issue(this.pid, { type: 'attack', ids: [id], target: next[0] });
            }
          }
          break;
        }
      }
    }
    for (const id of done) {
      this.jobs.delete(id);
      this.host.claim([id], false);
    }
    for (const ids of ends.values()) this.release(ids);
  }
}
