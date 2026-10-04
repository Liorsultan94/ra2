// Side events: small, seeded objectives that turn up every few minutes in the
// no-man's-land between the bases, worth fighting over but never decisive.
//
//   crash    a crashed aircraft with intel: the first infantry to reach it reveals
//            the whole map to its side for 30 s.
//   supply   a supply drop: 3 money crates parachute in (the paradrop canopies);
//            any ground unit that touches one collects $400.
//   rescue   civilians trapped in a burning building: the first infantry to reach
//            it gets them out: $600 and every soldier of that side within 3 tiles
//            gains a rank. Left alone, the building burns down (ruins: cover).
//   convoy   a neutral supply convoy (3 trucks) crosses the map along the line
//            between the bases. Ground units that stay next to a truck for 2 s
//            (uncontested) capture it ($500); a destroyed truck pays a $200 bounty
//            (attack it like an enemy).
//
// Schedule and places are a pure function of the match seed and the sim state
// (own Rng, never the world's), so every client agrees. The spot is chosen fair:
// about as far from every base, never close to one.

import { DEFS, buildingDef, unitDef } from './defs';
import { isGarrison } from './garrison';
import { Rng } from './rng';
import { TPS, type Entity, type UnitDef } from './types';
import { ELITE } from './veterancy';
import type { World } from './world';

export type SideKind = 'crash' | 'supply' | 'rescue' | 'convoy';

// ------------------------------------------------------------------ balance

export const SIDE = {
  /** First event, then one every GAP_MIN .. GAP_MAX (seeded). */
  FIRST: TPS * 150,
  GAP_MIN: TPS * 150,
  GAP_MAX: TPS * 230,
  /** Crashed aircraft: stays this long, reveals the map for INTEL to the first infantry within CLAIM_R. */
  CRASH_LIFE: TPS * 120,
  INTEL: TPS * 30,
  /** Supply drop: crates, credits each, time on the ground. */
  CRATES: 3,
  CRATE_CASH: 400,
  CRATE_LIFE: TPS * 90,
  /** Burning building: rescue reward, burn time before it collapses. */
  RESCUE_CASH: 600,
  RESCUE_LIFE: TPS * 100,
  RESCUE_RANK_R: 3,
  /** Convoy: trucks, speed (tiles/s), capture reward / time, bounty for a kill. */
  TRUCKS: 3,
  TRUCK_SPEED: 1.25,
  CAPTURE_CASH: 500,
  CAPTURE_TICKS: TPS * 2,
  CAPTURE_R: 1.8,
  BOUNTY: 200,
  /** Claim radius for crash / rescue (infantry) and crates (any ground unit). */
  CLAIM_R: 1.6,
  CRATE_R: 1.0,
} as const;

// ------------------------------------------------------------------ defs (neutral props)

const PROP = { faction: 'neutral' as const, cost: 0, buildTime: 1, turnRate: 0.1, turret: false, prereq: [] as string[], buildable: false };
const EVENT_DEFS: UnitDef[] = [
  { ...PROP, kind: 'unit', id: 'ev_wreck', name: 'Crashed Aircraft', category: 'vehicle', model: 'ev_wreck', hp: 600, armor: 'heavy', sight: 0, speed: 0, radius: 0.6, event: 'wreck', desc: 'A downed aircraft. Its flight recorder holds enemy positions: send infantry.' },
  { ...PROP, kind: 'unit', id: 'ev_cash', name: 'Supply Crate', category: 'vehicle', model: 'supplycrate', hp: 200, armor: 'light', sight: 0, speed: 0, radius: 0.25, supply: true, temp: true, event: 'cash', desc: 'Parachuted funds: drive or walk over it.' },
  { ...PROP, kind: 'unit', id: 'ev_truck', name: 'Supply Convoy Truck', category: 'vehicle', model: 'container', hp: 320, armor: 'light', sight: 0, speed: SIDE.TRUCK_SPEED, radius: 0.42, event: 'truck', desc: 'Neutral supply truck: stay next to it to capture it, or destroy it for a bounty.' },
];
for (const d of EVENT_DEFS) DEFS[d.id] = d;

/** A neutral convoy truck: may be attacked like an enemy. */
export function isPrey(t: Entity): boolean {
  return t.owner < 0 && t.kind === 'unit' && (DEFS[t.def] as UnitDef).event === 'truck';
}

// ------------------------------------------------------------------ state

export interface SideEvent {
  id: number;
  kind: SideKind;
  /** Marker position (follows the convoy's lead truck). */
  x: number;
  y: number;
  start: number;
  /** Expiry tick (the convoy: when it would have crossed). */
  until: number;
  done: boolean;
  /** Player who claimed it (crash / rescue), -1 = nobody yet / several (supply, convoy). */
  winner: number;
  ents: number[];
  /** Convoy route (tile centres) and each truck's distance along it; capture progress per truck. */
  route?: { x: number; y: number }[];
  along?: number[];
  cap?: { pid: number; t: number }[];
  /** Supply drop: crates on the ground. */
  landed?: number[];
}

export class SideEvents {
  enabled = false;
  events: SideEvent[] = [];
  /** Map revealed to a player until this tick (crash intel). */
  intel: number[] = [];
  next: number = SIDE.FIRST;
  private rng: Rng;
  private order: SideKind[] = [];
  private nextId = 1;

  constructor(
    private w: World,
    seed: number,
  ) {
    this.rng = new Rng((seed ^ 0x51de7e57) >>> 0);
  }

  /** Active (unfinished) events. */
  get active(): SideEvent[] {
    return this.events.filter((e) => !e.done);
  }

  private nextKind(): SideKind {
    if (!this.order.length) {
      const k: SideKind[] = ['crash', 'supply', 'rescue', 'convoy'];
      for (let i = k.length - 1; i > 0; i--) {
        const j = this.rng.int(i + 1);
        [k[i], k[j]] = [k[j], k[i]];
      }
      this.order = k;
    }
    return this.order.shift()!;
  }

  update() {
    const w = this.w;
    if (!this.enabled || w.over) return;
    if (w.tick >= this.next) {
      this.next = w.tick + SIDE.GAP_MIN + this.rng.int(SIDE.GAP_MAX - SIDE.GAP_MIN + 1);
      this.spawn(this.nextKind());
    }
    for (const ev of this.events) if (!ev.done) this.step(ev);
    if (this.events.length > 12) this.events = this.events.filter((e) => !e.done || w.tick - e.until < TPS * 10);
  }

  /** Start an event of this kind now (tests / debug). Returns null when there is no place for it. */
  spawn(kind: SideKind): SideEvent | null {
    const w = this.w;
    let ev: SideEvent | null = null;
    if (kind === 'rescue') ev = this.startRescue();
    if (!ev && kind === 'convoy') ev = this.startConvoy();
    if (!ev) {
      const spot = this.pickSpot();
      if (!spot) return null;
      if (kind === 'crash') ev = this.startCrash(spot);
      else ev = this.startSupply(spot);
    }
    this.events.push(ev);
    w.events.push({ t: 'side', id: ev.id, kind: ev.kind, phase: 'start', x: ev.x, y: ev.y, owner: -1 });
    return ev;
  }

  private make(kind: SideKind, x: number, y: number, life: number): SideEvent {
    return { id: this.nextId++, kind, x, y, start: this.w.tick, until: this.w.tick + life, done: false, winner: -1, ents: [] };
  }

  /** A fair spot: passable open ground about as far from every live base, never close to one. */
  pickSpot(): [number, number] | null {
    const w = this.w;
    const m = w.map;
    const starts = w.players.filter((p) => !p.defeated).map((p) => [p.startX + 0.5, p.startY + 0.5]);
    const diag = Math.hypot(m.w, m.h);
    let best: [number, number] | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < 90; i++) {
      const x = Math.floor(m.w * (0.15 + 0.7 * this.rng.next()));
      const y = Math.floor(m.h * (0.15 + 0.7 * this.rng.next()));
      if (!w.pf.passable(x, y) || w.occ[y * m.w + x]) continue;
      const ds = starts.map(([sx, sy]) => Math.hypot(x + 0.5 - sx, y + 0.5 - sy));
      const near = Math.min(...ds);
      if (near < diag * 0.22) continue;
      // fairness first (equal distance), then not too far out of the way
      const score = (Math.max(...ds) - near) * 3 + near * 0.15;
      if (score < bestScore) {
        bestScore = score;
        best = [x + 0.5, y + 0.5];
      }
    }
    if (!best) {
      const c = w.nearestPassable(m.w / 2, m.h / 2, 12);
      if (c) best = [c[0] + 0.5, c[1] + 0.5];
    }
    return best;
  }

  // ------------------------------------------------------------ kinds

  private startCrash([x, y]: [number, number]): SideEvent {
    const ev = this.make('crash', x, y, SIDE.CRASH_LIFE);
    const e = this.w.spawnUnit('ev_wreck', -1, x, y);
    e.facing = e.pfacing = this.rng.range(-Math.PI, Math.PI);
    e.hp = e.maxHp * 0.15; // smoking, burning wreck
    ev.ents.push(e.id);
    return ev;
  }

  private startSupply([x, y]: [number, number]): SideEvent {
    const ev = this.make('supply', x, y, SIDE.CRATE_LIFE + TPS * 6);
    const w = this.w;
    const T = TPS * 5;
    for (let i = 0; i < SIDE.CRATES; i++) {
      const a = (i / SIDE.CRATES) * Math.PI * 2 + this.rng.range(-0.4, 0.4);
      let lx = x + Math.cos(a) * 1.4;
      let ly = y + Math.sin(a) * 1.4;
      if (!w.pf.passable(Math.floor(lx), Math.floor(ly))) {
        lx = x;
        ly = y;
      }
      const e = w.spawnUnit('ev_cash', -1, lx - 2.2, ly - 1.2);
      e.life = SIDE.CRATE_LIFE;
      e.z = e.pz = 7;
      e.guardX = lx;
      e.guardY = ly;
      e.para = { t: T + i * 6, T: T + i * 6, z0: 7, x0: lx - 2.2, y0: ly - 1.2 };
      ev.ents.push(e.id);
    }
    return ev;
  }

  private startRescue(): SideEvent | null {
    const w = this.w;
    const m = w.map;
    const starts = w.players.filter((p) => !p.defeated).map((p) => [p.startX + 0.5, p.startY + 0.5]);
    const diag = Math.hypot(m.w, m.h);
    let best: Entity | null = null;
    let bestScore = Infinity;
    for (const b of w.list) {
      if (b.dead || b.kind !== 'building' || b.owner >= 0 || !isGarrison(b) || b.passengers.length || b.hp < b.maxHp * 0.6) continue;
      const ds = starts.map(([sx, sy]) => Math.hypot(b.x - sx, b.y - sy));
      const near = Math.min(...ds);
      if (near < diag * 0.2) continue;
      const score = (Math.max(...ds) - near) * 3 + near * 0.15 + (b.id % 7) * 0.01;
      if (score < bestScore) {
        bestScore = score;
        best = b;
      }
    }
    if (!best) return null;
    const ev = this.make('rescue', best.x, best.y, SIDE.RESCUE_LIFE);
    best.hp = best.maxHp * 0.28; // on fire (the renderer burns buildings under 30%)
    ev.ents.push(best.id);
    return ev;
  }

  private startConvoy(): SideEvent | null {
    const w = this.w;
    const m = w.map;
    const live = w.players.filter((p) => !p.defeated);
    if (live.length < 2) return null;
    // along the perpendicular bisector of the two bases: every point is as far from both
    const ax = live[0].startX + 0.5;
    const ay = live[0].startY + 0.5;
    const bx = live[1].startX + 0.5;
    const by = live[1].startY + 0.5;
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    let nx = -(by - ay);
    let ny = bx - ax;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    if (this.rng.next() < 0.5) {
      nx = -nx;
      ny = -ny;
    }
    const edge = (sgn: number): [number, number] | null => {
      let t = 0;
      while (t < 200) {
        const x = mx + nx * sgn * (t + 1);
        const y = my + ny * sgn * (t + 1);
        if (x < 1.5 || y < 1.5 || x > m.w - 1.5 || y > m.h - 1.5) break;
        t++;
      }
      return w.nearestPassable(mx + nx * sgn * t, my + ny * sgn * t, 10);
    };
    const a = edge(-1);
    const b = edge(1);
    if (!a || !b) return null;
    const tiles = w.pf.find(a[0], a[1], b[0], b[1], 40000);
    if (tiles.length < 6) return null;
    const route = [{ x: a[0] + 0.5, y: a[1] + 0.5 }, ...tiles.map((t) => ({ x: (t % m.w) + 0.5, y: Math.floor(t / m.w) + 0.5 }))];
    let len = 0;
    for (let i = 1; i < route.length; i++) len += Math.hypot(route[i].x - route[i - 1].x, route[i].y - route[i - 1].y);
    const ev = this.make('convoy', route[0].x, route[0].y, Math.ceil(((len + SIDE.TRUCKS * 1.4) / SIDE.TRUCK_SPEED) * TPS * 1.8) + TPS * 20);
    ev.route = route;
    ev.along = [];
    ev.cap = [];
    for (let i = 0; i < SIDE.TRUCKS; i++) {
      const e = w.spawnUnit('ev_truck', -1, route[0].x, route[0].y);
      ev.ents.push(e.id);
      ev.along.push(-i * 1.4); // in column, 1.4 tiles apart
      ev.cap.push({ pid: -1, t: 0 });
    }
    this.placeTrucks(ev);
    return ev;
  }

  // ------------------------------------------------------------ per tick

  private finish(ev: SideEvent, phase: 'end' | 'fail', owner = -1, reward = 0) {
    ev.done = true;
    ev.until = this.w.tick;
    this.w.events.push({ t: 'side', id: ev.id, kind: ev.kind, phase, x: ev.x, y: ev.y, owner, reward });
  }

  private claim(ev: SideEvent, owner: number, reward: number, x: number, y: number) {
    this.w.events.push({ t: 'side', id: ev.id, kind: ev.kind, phase: 'claim', x, y, owner, reward });
  }

  private step(ev: SideEvent) {
    const w = this.w;
    switch (ev.kind) {
      case 'crash': {
        const wreck = w.get(ev.ents[0]);
        if (!wreck || w.tick >= ev.until) {
          if (wreck) w.remove(wreck);
          this.finish(ev, 'fail');
          return;
        }
        if ((w.tick + ev.id) % 5) return;
        const u = this.nearest(wreck.x, wreck.y, SIDE.CLAIM_R, (o) => unitDef(o.def).category === 'infantry');
        if (!u) return;
        ev.winner = u.owner;
        this.intel[u.owner] = w.tick + SIDE.INTEL;
        w.remove(wreck);
        this.claim(ev, u.owner, 0, ev.x, ev.y);
        this.finish(ev, 'end', u.owner);
        w.updateVisibility();
        return;
      }
      case 'supply': {
        let left = 0;
        for (const id of ev.ents) {
          const c = w.get(id);
          if (!c) continue;
          left++;
          if (c.para) continue;
          if (!ev.landed) ev.landed = [];
          if (!ev.landed.includes(id)) {
            ev.landed.push(id);
            c.life = SIDE.CRATE_LIFE; // (the pallet code gives its own crates a shorter life on touchdown)
          }
          if ((w.tick + id) % 4) continue;
          const u = this.nearest(c.x, c.y, SIDE.CRATE_R, (o) => !w.isAir(o));
          if (!u) continue;
          w.players[u.owner].credits += SIDE.CRATE_CASH;
          w.remove(c);
          left--;
          this.claim(ev, u.owner, SIDE.CRATE_CASH, c.x, c.y);
        }
        if (!left) this.finish(ev, 'end');
        return;
      }
      case 'rescue': {
        const b = w.get(ev.ents[0]);
        if (!b) {
          this.finish(ev, 'fail');
          return;
        }
        if (b.owner >= 0) {
          // somebody moved in: they got the civilians out
          this.rescue(ev, b, b.owner);
          return;
        }
        if (w.tick % TPS === 0) b.hp -= b.maxHp * (0.25 / (SIDE.RESCUE_LIFE / TPS));
        if (w.tick >= ev.until || b.hp <= b.maxHp * 0.02) {
          w.kill(b, -1); // burnt down: ruins
          this.finish(ev, 'fail');
          return;
        }
        if ((w.tick + ev.id) % 5) return;
        const d = buildingDef(b.def);
        const u = this.nearest(b.tx + d.w / 2, b.ty + d.h / 2, Math.max(d.w, d.h) / 2 + 1.1, (o) => unitDef(o.def).category === 'infantry');
        if (u) this.rescue(ev, b, u.owner);
        return;
      }
      case 'convoy': {
        this.stepConvoy(ev);
        return;
      }
    }
  }

  private rescue(ev: SideEvent, b: Entity, owner: number) {
    const w = this.w;
    ev.winner = owner;
    w.players[owner].credits += SIDE.RESCUE_CASH;
    b.hp = Math.max(b.hp, b.maxHp * 0.6); // the fire is out
    w.queryRadius(b.x, b.y, SIDE.RESCUE_RANK_R + 1, (o) => {
      if (o.owner !== owner || o.kind !== 'unit' || o.inside >= 0 || o.rank >= ELITE || Math.hypot(o.x - b.x, o.y - b.y) > SIDE.RESCUE_RANK_R + 0.5) return;
      if (unitDef(o.def).category !== 'infantry' || unitDef(o.def).temp) return;
      o.rank++;
      w.events.push({ t: 'promoted', id: o.id, owner, rank: o.rank, x: o.x, y: o.y });
    });
    this.claim(ev, owner, SIDE.RESCUE_CASH, b.x, b.y);
    this.finish(ev, 'end', owner, SIDE.RESCUE_CASH);
  }

  /** Nearest live ground unit of any player within r that passes `ok` (ties: lower id). */
  private nearest(x: number, y: number, r: number, ok: (o: Entity) => boolean): Entity | null {
    let best: Entity | null = null;
    let bd = r;
    this.w.queryRadius(x, y, r, (o) => {
      if (o.owner < 0 || o.kind !== 'unit' || o.para || o.inside >= 0 || unitDef(o.def).temp || !ok(o)) return;
      const d = Math.hypot(o.x - x, o.y - y);
      if (d < bd || (d === bd && best && o.id < best.id)) {
        bd = d;
        best = o;
      }
    });
    return best;
  }

  private posAt(route: { x: number; y: number }[], s: number): [number, number, number] {
    if (s <= 0) {
      const a = route[0];
      const b = route[1];
      return [a.x, a.y, Math.atan2(b.y - a.y, b.x - a.x)];
    }
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1];
      const b = route[i];
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      if (s <= l) {
        const k = l > 0 ? s / l : 0;
        return [a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, Math.atan2(b.y - a.y, b.x - a.x)];
      }
      s -= l;
    }
    const a = route[route.length - 2];
    const b = route[route.length - 1];
    return [b.x, b.y, Math.atan2(b.y - a.y, b.x - a.x)];
  }

  private routeLen(route: { x: number; y: number }[]) {
    let len = 0;
    for (let i = 1; i < route.length; i++) len += Math.hypot(route[i].x - route[i - 1].x, route[i].y - route[i - 1].y);
    return len;
  }

  private placeTrucks(ev: SideEvent) {
    const w = this.w;
    let lead = -Infinity;
    ev.ents.forEach((id, i) => {
      const e = w.get(id);
      if (!e) return;
      const [x, y, f] = this.posAt(ev.route!, Math.max(0, ev.along![i]));
      e.x = x;
      e.y = y;
      e.facing = e.turret = f;
      if (ev.along![i] > lead) {
        lead = ev.along![i];
        ev.x = x;
        ev.y = y;
      }
    });
  }

  private stepConvoy(ev: SideEvent) {
    const w = this.w;
    const route = ev.route!;
    const len = this.routeLen(route);
    let left = 0;
    let blocked = false;
    for (let i = 0; i < ev.ents.length; i++) {
      const e = w.get(ev.ents[i]);
      if (!e) continue;
      left++;
      // who is next to the truck? one side alone captures it, a contested truck just stops
      let pid = -1;
      let several = false;
      w.queryRadius(e.x, e.y, SIDE.CAPTURE_R, (o) => {
        if (o.owner < 0 || o.kind !== 'unit' || o.para || o.inside >= 0 || w.isAir(o) || unitDef(o.def).temp) return;
        if (Math.hypot(o.x - e.x, o.y - e.y) > SIDE.CAPTURE_R) return;
        if (pid < 0) pid = o.owner;
        else if (o.owner !== pid) several = true;
      });
      const cap = ev.cap![i];
      if (pid >= 0) {
        blocked = true;
        if (several) cap.t = 0;
        else {
          if (cap.pid !== pid) cap.t = 0;
          cap.pid = pid;
          if (++cap.t >= SIDE.CAPTURE_TICKS) {
            w.players[pid].credits += SIDE.CAPTURE_CASH;
            this.claim(ev, pid, SIDE.CAPTURE_CASH, e.x, e.y);
            w.remove(e);
            left--;
            continue;
          }
        }
      } else cap.t = 0;
      e.moving = false;
    }
    if (!left) {
      this.finish(ev, 'end');
      return;
    }
    // the column moves together and halts when any truck is stopped by soldiers
    if (!blocked) {
      const step = (SIDE.TRUCK_SPEED / TPS) * w.cond.moveMul(DEFS.ev_truck as UnitDef, w.tileOf(ev.x, ev.y));
      for (let i = 0; i < ev.ents.length; i++) {
        ev.along![i] += step;
        const e = w.get(ev.ents[i]);
        if (e) e.moving = true;
      }
    }
    this.placeTrucks(ev);
    // reached the far edge: the convoy is gone
    const tail = Math.min(...ev.ents.map((id, i) => (w.get(id) ? ev.along![i] : Infinity)));
    if (tail >= len || w.tick >= ev.until) {
      for (const id of ev.ents) {
        const e = w.get(id);
        if (e) w.remove(e);
      }
      this.finish(ev, 'fail');
    }
  }

  /** A convoy truck was destroyed: bounty for the killer's side. */
  onKill(t: Entity, by: number) {
    if (!isPrey(t)) return;
    const ev = this.events.find((e) => !e.done && e.ents.includes(t.id));
    if (!ev || by < 0) return;
    this.w.players[by].credits += SIDE.BOUNTY;
    this.claim(ev, by, SIDE.BOUNTY, t.x, t.y);
  }

  /** Is the map revealed to this player (crash intel)? */
  revealed(pid: number): boolean {
    return (this.intel[pid] ?? -1) > this.w.tick;
  }
}
