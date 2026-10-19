// The computer player's navy (NV1), run by AIController on maps with open sea (World.hasSea).
//
// - The Shipyard: built once the War Factory stands, on the coast nearest the base whose water reaches the
//   enemy's shore (a yard on a sea that leads nowhere is not worth it). Easy rarely bothers, Hard always does.
// - Patrol and missile boats gather off the yard and, once the war is on (after the first land wave, never in
//   the peace grace: the first attack stays a surprise), sail out in a group to harass: enemy boats first, then
//   harvesters and structures near the shore. Badly hurt, they come home to the yard for repair.
// - Landing craft (Normal, Hard): flanking landings. A craft beaches near the base, a few tanks and soldiers
//   board, it crosses to a beach on the enemy's side away from its defences, puts them ashore, and they attack
//   whatever they find there (harvesters, the refinery, the base). That way round, the long land corridors are
//   not the only way in (the Sinai's gulfs).
// Everything is a command, decided every `think` ticks, with its own seeded RNG (the land AI's stream is
// untouched, so maps without sea play exactly as before).

import { buildingDef, defsForFaction, unitDef } from './defs';
import { SHIP_H, SHIP_W, beachSpot, cargoSize, launchSpot, mouthTile } from './naval';
import { Rng } from './rng';
import { Loco } from './slope';
import { TPS, type Entity, type UnitDef } from './types';
import type { World } from './world';

export type NavalDifficulty = 'easy' | 'normal' | 'hard';

interface NavCfg {
  /** Chance per match that this AI goes to sea at all. */
  chance: number;
  /** Earliest tick for the Shipyard. */
  yardAt: number;
  /** Fleet it keeps: patrol boats, missile boats, landing craft. */
  patrol: number;
  corvette: number;
  lander: number;
  /** Combat boats needed before the fleet sails on a raid. */
  sortie: number;
  /** Ticks between landing operations (0: none). */
  landEvery: number;
  /** Credits it keeps in hand before spending on the navy. */
  reserve: number;
}

const NAV: Record<NavalDifficulty, NavCfg> = {
  easy: { chance: 0.3, yardAt: TPS * 60 * 11, patrol: 1, corvette: 0, lander: 0, sortie: 1, landEvery: 0, reserve: 1400 },
  normal: { chance: 0.75, yardAt: TPS * 60 * 6, patrol: 2, corvette: 1, lander: 1, sortie: 2, landEvery: TPS * 60 * 4, reserve: 900 },
  hard: { chance: 1, yardAt: TPS * 60 * 4, patrol: 3, corvette: 2, lander: 1, sortie: 2, landEvery: TPS * 60 * 3, reserve: 600 },
};

/** What the land AI lends the navy (AIController). */
export interface NavalHooks {
  /** In the early-game grace (no offensive action). */
  peace(): boolean;
  /** Land waves launched so far. */
  waves(): number;
  /** Tick the grace ends. */
  peaceUntil(): number;
  /** Is this land unit free for a landing (the land AI's idle army)? */
  free(u: Entity): boolean;
  /** Hand units to the navy ('navy' role) or back to the army. */
  claim(ids: number[], on: boolean): void;
}

interface Landing {
  craft: number;
  ids: number[];
  phase: 'toBeach' | 'boarding' | 'sailing' | 'ashore';
  since: number;
  /** Beach to load at (water tile) and the landing point ashore on the enemy's side. */
  ex: number;
  ey: number;
  lx: number;
  ly: number;
}

export class NavalAI {
  private rng: Rng;
  private cfg: NavCfg;
  /** This match the AI goes to sea (seeded roll by difficulty). */
  readonly active: boolean;
  /** Water (Landing-class regions) that reaches the enemy's shore near its base. */
  private enemyWater = new Set<number>();
  private raidIds: number[] = [];
  private raidAt = 0;
  private landing: Landing | null = null;
  private nextLanding = 0;
  private yardsSeen = new Set<number>();
  /** Debug / tests: yards placed, raids sailed, landings made, units put ashore. */
  readonly stats = { yards: 0, raids: 0, landings: 0, ashore: 0, boats: 0 };

  constructor(
    private w: World,
    private pid: number,
    difficulty: NavalDifficulty,
    private hooks: NavalHooks,
    seed: number,
  ) {
    this.rng = new Rng(seed);
    this.cfg = NAV[difficulty];
    this.active = w.hasSea && this.rng.next() < this.cfg.chance;
    this.nextLanding = Math.round(this.cfg.landEvery * this.rng.range(0.6, 1));
    if (!this.active) return;
    // the water within reach of the enemy's base (its ground region's shore)
    const W = w.map.w;
    const veh = w.regions[Loco.Vehicle];
    const land = w.regions[Loco.Landing];
    for (const p of w.players) {
      if (p.id === pid) continue;
      const er = veh[p.startY * W + p.startX];
      const R = 45;
      for (let y = Math.max(1, p.startY - R); y < Math.min(w.map.h - 1, p.startY + R); y++)
        for (let x = Math.max(1, p.startX - R); x < Math.min(W - 1, p.startX + R); x++) {
          const i = y * W + x;
          if (!land[i]) continue;
          if (veh[i - 1] === er || veh[i + 1] === er || veh[i - W] === er || veh[i + W] === er) this.enemyWater.add(land[i]);
        }
    }
  }

  private get p() {
    return this.w.players[this.pid];
  }

  private cmd(c: Parameters<World['issue']>[1]) {
    this.w.issue(this.pid, c);
  }

  /** May the navy strike at the enemy yet (after the grace and the first land wave, or well after the grace)? */
  private offensive(): boolean {
    if (this.hooks.peace()) return false;
    return this.hooks.waves() > 0 || this.w.tick > this.hooks.peaceUntil() + TPS * 60 * 4;
  }

  /** The Shipyard to build now, or null (the land AI checks the power and queues it). */
  wantYard(buildings: Entity[]): string | null {
    if (!this.active || this.w.tick < this.cfg.yardAt) return null;
    let factory = false;
    let radar = false;
    for (const b of buildings) {
      const d = buildingDef(b.def);
      if (d.shipyard) return null;
      if (d.role === 'factory') factory = true;
      if (d.role === 'radar') radar = true;
    }
    // (after the core base: the War Factory, and the radar unless it is long overdue)
    if (!factory || (!radar && this.w.tick < this.cfg.yardAt + TPS * 180)) return null;
    const id = `${this.p.faction}_shipyard`;
    if (!this.w.canBuild(this.pid, id)) return null;
    return this.yardSpot(id) ? id : null;
  }

  /** Where to put the Shipyard: the placeable coast nearest the base whose water leads to the enemy's shore. */
  yardSpot(defId: string): [number, number] | null {
    const w = this.w;
    const W = w.map.w;
    const hx = this.p.startX + 0.5;
    const hy = this.p.startY + 0.5;
    let best: [number, number] | null = null;
    let bd = Infinity;
    for (const i of w.shipSpots) {
      const tx = i % W;
      const ty = Math.floor(i / W);
      const d = Math.hypot(tx + SHIP_W / 2 - hx, ty + SHIP_H / 2 - hy);
      if (d >= bd || d > 40) continue;
      const site = w.shipSite(defId, tx, ty);
      if (!site.ok) continue;
      const [mx, my] = mouthTile(tx, ty, SHIP_W, SHIP_H, site.dir);
      const wr = w.regionOf(mx + 0.5, my + 0.5, Loco.Landing);
      if (!this.enemyWater.has(wr)) continue;
      if (!w.canPlace(this.pid, defId, tx, ty)) continue;
      bd = d;
      best = [tx, ty];
    }
    return best;
  }

  private yard(): Entity | null {
    for (const e of this.w.list) if (!e.dead && e.owner === this.pid && e.kind === 'building' && buildingDef(e.def).shipyard) return e;
    return null;
  }

  /** The fleet's anchorage: open water a few tiles off the slipway. */
  private anchorage(yard: Entity): [number, number] | null {
    const s = launchSpot(this.w, yard, Loco.Boat);
    if (!s) return null;
    const dir = yard.slip ?? 0;
    const dx = [1, 0, -1, 0][dir];
    const dy = [0, 1, 0, -1][dir];
    const p = this.w.nearestPassable(s[0] + 0.5 + dx * 4, s[1] + 0.5 + dy * 4, 6, this.w.regionOf(s[0] + 0.5, s[1] + 0.5, Loco.Boat), Loco.Boat);
    return p ? [p[0] + 0.5, p[1] + 0.5] : [s[0] + 0.5, s[1] + 0.5];
  }

  update(navy: Entity[], land: Entity[]) {
    if (!this.active) return;
    const yard = this.yard();
    if (yard && !this.yardsSeen.has(yard.id)) {
      this.yardsSeen.add(yard.id);
      this.stats.yards++;
    }
    if (yard && yard.buildAnim >= 1) this.produce(navy);
    this.stats.boats = Math.max(this.stats.boats, navy.length);
    const combat = navy.filter((u) => !!unitDef(u.def).weapon && !unitDef(u.def).cargoSlots);
    this.fleet(yard, combat);
    this.manageLanding(yard, navy, land);
  }

  private produce(navy: Entity[]) {
    const p = this.p;
    if (p.queues.naval.length >= 1 || p.credits < this.cfg.reserve) return;
    const have = { patrol: 0, corvette: 0, lander: 0 };
    for (const u of navy) {
      const k = u.def.slice(p.faction.length + 1) as keyof typeof have;
      if (k in have) have[k]++;
    }
    const want: (keyof typeof have)[] = [];
    if (have.patrol < this.cfg.patrol) want.push('patrol');
    if (have.corvette < this.cfg.corvette) want.push('corvette');
    if (have.lander < this.cfg.lander && this.landingsOn()) want.push('lander');
    if (!want.length) return;
    // a patrol boat first, then whatever is short, picked by the seeded roll
    const k = have.patrol === 0 && want.includes('patrol') ? 'patrol' : want[this.rng.int(want.length)];
    const id = `${p.faction}_${k}`;
    if (this.w.canBuild(this.pid, id)) this.cmd({ type: 'produce', def: id });
  }

  private landingsOn() {
    return this.cfg.landEvery > 0 && this.enemyWater.size > 0;
  }

  // ---------------------------------------------------------------- the fleet

  /** Enemy targets a group of boats in this water region can reach (seen units, known structures), best first. */
  private pickTarget(boats: Entity[], region: number): { id: number; x: number; y: number } | null {
    const w = this.w;
    let cx = 0;
    let cy = 0;
    for (const b of boats) {
      cx += b.x;
      cy += b.y;
    }
    cx /= boats.length;
    cy /= boats.length;
    const corv = boats.some((b) => b.def.endsWith('_corvette'));
    const reach = corv ? 8 : 5;
    let best: { id: number; x: number; y: number } | null = null;
    let bs = Infinity;
    const me = this.p;
    for (const e of w.list) {
      if (e.dead || !w.isEnemy(this.pid, e.owner) || e.inside >= 0) continue;
      let pri: number;
      if (e.kind === 'unit') {
        const d = unitDef(e.def);
        if (d.air || d.temp || !w.sees(this.pid, e)) continue;
        pri = d.naval ? 0 : d.harvester ? 6 : d.category === 'infantry' ? 22 : 16;
      } else {
        const t = Math.floor(e.y) * w.map.w + Math.floor(e.x);
        if (!me.explored[t]) continue;
        const bd = buildingDef(e.def);
        if (bd.faction === 'neutral') continue;
        pri = bd.shipyard ? 4 : bd.role === 'refinery' ? 10 : bd.weapon ? 26 : 18;
      }
      // the water to shoot from
      const spot = w.nearestPassable(e.x, e.y, reach, region, Loco.Boat);
      if (!spot) continue;
      const s = pri + Math.hypot(spot[0] - cx, spot[1] - cy) * 0.35;
      if (s < bs) {
        bs = s;
        best = { id: e.id, x: spot[0] + 0.5, y: spot[1] + 0.5 };
      }
    }
    return best;
  }

  private fleet(yard: Entity | null, boats: Entity[]) {
    const w = this.w;
    if (!boats.length) {
      this.raidIds = [];
      return;
    }
    const home = yard ? this.anchorage(yard) : null;
    // the badly hurt come home to the yard for repair
    for (const b of boats) {
      if (home && b.hp < b.maxHp * 0.35 && Math.hypot(b.x - home[0], b.y - home[1]) > 4 && b.order.type !== 'move') {
        this.cmd({ type: 'move', ids: [b.id], x: home[0], y: home[1] });
        this.raidIds = this.raidIds.filter((id) => id !== b.id);
      }
    }
    // enemy boats close to our yard: everyone at home engages
    if (yard) {
      let threat: Entity | null = null;
      w.queryRadius(yard.x, yard.y, 14, (e) => {
        if (!threat && e.kind === 'unit' && w.isEnemy(this.pid, e.owner) && unitDef(e.def).naval && w.sees(this.pid, e)) threat = e;
      });
      const t = threat as Entity | null;
      if (t) {
        const ids = boats.filter((b) => b.hp >= b.maxHp * 0.35 && !this.raidIds.includes(b.id) && b.order.type !== 'attack').map((b) => b.id);
        if (ids.length) this.cmd({ type: 'attack', ids, target: t.id });
      }
    }
    const raid = this.raidIds.map((id) => w.get(id)).filter((e): e is Entity => !!e);
    this.raidIds = raid.map((e) => e.id);
    if (raid.length) {
      // a raid in progress: on to the next target once the current one is done
      if (raid.every((b) => b.order.type === 'idle') && w.tick >= this.raidAt) {
        this.raidAt = w.tick + TPS * 4;
        const t = this.pickTarget(raid, w.regionOf(raid[0].x, raid[0].y, Loco.Boat));
        const hurt = raid.reduce((s, b) => s + b.hp / b.maxHp, 0) / raid.length < 0.5;
        if (t && !hurt) this.cmd({ type: 'move', ids: this.raidIds, x: t.x, y: t.y, attackMove: true });
        else {
          if (home) this.cmd({ type: 'move', ids: this.raidIds, x: home[0], y: home[1] });
          this.raidIds = [];
        }
      }
      return;
    }
    // gather at the anchorage, then sail out once there are enough and the war is on
    const idle = boats.filter((b) => b.order.type === 'idle' && b.hp >= b.maxHp * 0.7);
    if (home) {
      const strays = idle.filter((b) => Math.hypot(b.x - home[0], b.y - home[1]) > 7);
      if (strays.length) this.cmd({ type: 'move', ids: strays.map((b) => b.id), x: home[0], y: home[1] });
    }
    if (!this.offensive() || idle.length < this.cfg.sortie || w.tick < this.raidAt) return;
    const t = this.pickTarget(idle, w.regionOf(idle[0].x, idle[0].y, Loco.Boat));
    this.raidAt = w.tick + TPS * 20;
    if (!t) return;
    this.raidIds = idle.map((b) => b.id);
    this.stats.raids++;
    this.cmd({ type: 'move', ids: this.raidIds, x: t.x, y: t.y, attackMove: true });
  }

  // ---------------------------------------------------------------- landings

  /** A beach on the enemy's side, away from its defences, near something worth hitting. */
  private landingSite(craft: Entity): { bx: number; by: number; lx: number; ly: number } | null {
    const w = this.w;
    const W = w.map.w;
    const region = w.regionOf(craft.x, craft.y, w.locoOf(craft));
    const veh = w.regions[Loco.Vehicle];
    const me = this.p;
    let best: { bx: number; by: number; lx: number; ly: number } | null = null;
    let bs = Infinity;
    for (const p of w.players) {
      if (!w.isEnemy(this.pid, p.id) || p.defeated) continue;
      const er = veh[p.startY * W + p.startX];
      // aim points: known enemy refineries and the base itself
      const aims: [number, number][] = [[p.startX + 0.5, p.startY + 0.5]];
      for (const e of w.list) {
        if (e.dead || e.owner !== p.id || e.kind !== 'building' || buildingDef(e.def).role !== 'refinery') continue;
        if (me.explored[Math.floor(e.y) * W + Math.floor(e.x)]) aims.push([e.x, e.y]);
      }
      for (const [ax, ay] of aims) {
        const b = beachSpot(w, ax, ay, region, w.locoOf(craft), 26);
        if (!b) continue;
        const ash = w.nearestPassable(b[0] + 0.5, b[1] + 0.5, 4, er, Loco.Vehicle);
        if (!ash) continue;
        // keep off the defences: a beach under the guns costs the whole landing
        let guns = 0;
        for (const e of w.list) {
          if (e.dead || e.owner !== p.id || e.kind !== 'building' || !buildingDef(e.def).weapon) continue;
          if (Math.hypot(e.x - ash[0], e.y - ash[1]) < 9 && me.explored[Math.floor(e.y) * W + Math.floor(e.x)]) guns++;
        }
        const s = Math.hypot(ash[0] - ax, ash[1] - ay) + guns * 20 + this.rng.next() * 3;
        if (s < bs) {
          bs = s;
          best = { bx: b[0] + 0.5, by: b[1] + 0.5, lx: ash[0] + 0.5, ly: ash[1] + 0.5 };
        }
      }
    }
    return best;
  }

  private release(l: Landing) {
    const ids = l.ids.filter((id) => this.w.get(id));
    if (ids.length) this.hooks.claim(ids, false);
  }

  private manageLanding(yard: Entity | null, navy: Entity[], land: Entity[]) {
    const w = this.w;
    const l = this.landing;
    if (l) {
      const craft = w.get(l.craft);
      if (!craft) {
        this.release(l);
        this.landing = null;
        return;
      }
      const age = w.tick - l.since;
      switch (l.phase) {
        case 'toBeach':
          if (craft.order.type === 'idle' || age > TPS * 60) {
            l.phase = 'boarding';
            l.since = w.tick;
            const ids = l.ids.filter((id) => w.get(id) && w.get(id)!.inside < 0);
            if (ids.length) this.cmd({ type: 'enter', ids, target: craft.id });
          }
          break;
        case 'boarding': {
          const waiting = l.ids.filter((id) => {
            const u = w.get(id);
            return u && u.inside < 0;
          });
          if (age % (TPS * 6) === 0 && waiting.length) this.cmd({ type: 'enter', ids: waiting, target: craft.id });
          if (!waiting.length || age > TPS * 50) {
            if (!craft.passengers.length) {
              this.release(l);
              this.landing = null;
              return;
            }
            // the stragglers go back to the army
            if (waiting.length) {
              this.hooks.claim(waiting, false);
              l.ids = l.ids.filter((id) => !waiting.includes(id));
            }
            const site = this.landingSite(craft);
            if (!site) {
              this.cmd({ type: 'deploy', ids: [craft.id] });
              this.release(l);
              this.landing = null;
              return;
            }
            l.lx = site.lx;
            l.ly = site.ly;
            l.phase = 'sailing';
            l.since = w.tick;
            this.cmd({ type: 'move', ids: [craft.id], x: site.lx, y: site.ly });
            // an escort: the idle boats sail along
            const esc = navy.filter((b) => b.order.type === 'idle' && !!unitDef(b.def).weapon && !unitDef(b.def).cargoSlots && !this.raidIds.includes(b.id));
            if (esc.length) this.cmd({ type: 'move', ids: esc.map((b) => b.id), x: site.lx, y: site.ly, attackMove: true });
          }
          break;
        }
        case 'sailing':
          if (!craft.passengers.length) {
            l.phase = 'ashore';
            l.since = w.tick;
            this.stats.landings++;
            const ashore = l.ids.filter((id) => w.get(id) && w.get(id)!.inside < 0);
            this.stats.ashore += ashore.length;
            const tgt = this.ashoreTarget(l.lx, l.ly);
            if (ashore.length && tgt) this.cmd({ type: 'move', ids: ashore, x: tgt[0], y: tgt[1], attackMove: true });
            if (yard) {
              const home = this.anchorage(yard);
              if (home) this.cmd({ type: 'move', ids: [craft.id], x: home[0], y: home[1] });
            }
          } else if (craft.order.type === 'idle' && age > TPS * 10) {
            // stuck at sea or the beach was unreachable: try putting ashore wherever it lies
            this.cmd({ type: 'deploy', ids: [craft.id] });
            if (age > TPS * 150) {
              this.release(l);
              this.landing = null;
            }
          }
          break;
        case 'ashore': {
          // the landing party fights on round the beachhead; when they are done they rejoin the army
          const alive = l.ids.map((id) => w.get(id)).filter((e): e is Entity => !!e);
          if (!alive.length) {
            this.landing = null;
            break;
          }
          if (alive.every((u) => u.order.type === 'idle')) {
            const tgt = this.ashoreTarget(alive[0].x, alive[0].y);
            if (tgt && age < TPS * 240) this.cmd({ type: 'move', ids: alive.map((u) => u.id), x: tgt[0], y: tgt[1], attackMove: true });
            else {
              this.release(l);
              this.landing = null;
            }
          }
          break;
        }
      }
      return;
    }
    // a new landing: Normal / Hard, war on, a craft at hand, time for one
    if (!this.landingsOn() || !this.offensive() || w.tick < this.nextLanding) return;
    const craft = navy.find((u) => !!unitDef(u.def).cargoSlots && u.order.type === 'idle' && u.hp > u.maxHp * 0.6 && !u.passengers.length);
    if (!craft) return;
    const hx = this.p.startX + 0.5;
    const hy = this.p.startY + 0.5;
    // the landing party: up to 2 vehicles and 5 soldiers from the idle army at home
    const pool = land.filter((u) => this.hooks.free(u) && Math.hypot(u.x - hx, u.y - hy) < 32 && cargoSize(u.def) > 0 && !unitDef(u.def).harvester && !unitDef(u.def).mcv && !unitDef(u.def).engineer && !!unitDef(u.def).weapon);
    const veh = pool.filter((u) => unitDef(u.def).category === 'vehicle').sort((a, b) => a.id - b.id).slice(0, 2);
    const inf = pool.filter((u) => unitDef(u.def).category === 'infantry').sort((a, b) => a.id - b.id).slice(0, 5);
    if (veh.length + inf.length < 4) return;
    const lc = w.locoOf(craft);
    const spot = beachSpot(w, hx, hy, w.regionOf(craft.x, craft.y, lc), lc, 30);
    if (!spot) return;
    this.nextLanding = w.tick + Math.round(this.cfg.landEvery * this.rng.range(0.8, 1.25));
    const ids = [...veh, ...inf].map((u) => u.id);
    this.hooks.claim(ids, true);
    this.landing = { craft: craft.id, ids, phase: 'toBeach', since: w.tick, ex: spot[0] + 0.5, ey: spot[1] + 0.5, lx: 0, ly: 0 };
    this.cmd({ type: 'move', ids: [craft.id], x: spot[0] + 0.5, y: spot[1] + 0.5 });
    // the party walks to the shore by the beach meanwhile
    const shore = w.nearestPassable(spot[0] + 0.5, spot[1] + 0.5, 5, w.regionOf(hx, hy, Loco.Vehicle), Loco.Vehicle);
    if (shore) this.cmd({ type: 'move', ids, x: shore[0] + 0.5, y: shore[1] + 0.5 });
  }

  /** What the landing party attacks from (x, y): the nearest enemy harvester, refinery or structure it knows of. */
  private ashoreTarget(x: number, y: number): [number, number] | null {
    const w = this.w;
    let best: [number, number] | null = null;
    let bs = Infinity;
    for (const e of w.list) {
      if (e.dead || !w.isEnemy(this.pid, e.owner)) continue;
      let pri: number;
      if (e.kind === 'unit') {
        const d: UnitDef = unitDef(e.def);
        if (!d.harvester || !w.sees(this.pid, e)) continue;
        pri = 0;
      } else {
        if (!this.p.explored[Math.floor(e.y) * w.map.w + Math.floor(e.x)] && Math.hypot(e.x - w.players[e.owner].startX, e.y - w.players[e.owner].startY) > 10) continue;
        const bd = buildingDef(e.def);
        if (bd.faction === 'neutral') continue;
        pri = bd.role === 'refinery' ? 4 : bd.weapon ? 18 : 10;
      }
      const s = pri + Math.hypot(e.x - x, e.y - y);
      if (s < bs) {
        bs = s;
        best = [e.x, e.y];
      }
    }
    return best;
  }
}

/** Every buildable naval unit of a nation (tests). */
export function navalRoster(f: string): UnitDef[] {
  return defsForFaction(f as never).filter((d): d is UnitDef => d.kind === 'unit' && d.category === 'naval');
}
