import { DEFS, WEAPONS } from '../sim/defs';
import { SW_INFO, type SwKind } from '../sim/specialdefs';
import { RANK_NAMES, xpValue } from '../sim/veterancy';
import { TPS, type SimEvent, type UnitDef } from '../sim/types';
import type { World } from '../sim/world';

/*
 * Match statistics for the after-action report. A purely observing tracker:
 * it listens to the simulation events the game already drains and samples a
 * little world state every few seconds. It never writes to the world.
 */

export interface SidePerf {
  unitsBuilt: number;
  unitsLost: number;
  unitsKilled: number;
  structuresBuilt: number;
  structuresLost: number;
  structuresDestroyed: number;
  harvested: number;
  superweapons: number;
  /** Hostile missiles / rockets this side shot down. */
  intercepted: number;
  peakArmy: number;
}

export interface StatSample {
  /** Match seconds. */
  t: number;
  /** Army value (credits) of each side's live combat units. */
  army: [number, number];
  /** Harvest income of each side over the last interval, credits per minute. */
  income: [number, number];
}

export interface Highlight {
  t: number;
  text: string;
  kind: 'good' | 'bad' | 'info';
}

export interface MvpInfo {
  name: string;
  def: string;
  rank: number;
  rankName: string;
  kills: number;
  xp: number;
  alive: boolean;
}

export interface MatchReport {
  win: boolean;
  /** Match seconds (simulation time). */
  time: number;
  local: number;
  you: SidePerf;
  enemy: SidePerf;
  samples: StatSample[];
  highlights: Highlight[];
  mvp: MvpInfo | null;
}

const SAMPLE_TICKS = TPS * 5;

const newSide = (): SidePerf => ({ unitsBuilt: 0, unitsLost: 0, unitsKilled: 0, structuresBuilt: 0, structuresLost: 0, structuresDestroyed: 0, harvested: 0, superweapons: 0, intercepted: 0, peakArmy: 0 });

/** "m:ss" of match seconds. */
export function clock(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const SW_WEAPON_NAME: Record<string, string> = {
  sw_darkEagle: 'Dark Eagle hypersonic strike',
  sw_tos2: 'TOS-2 thermobaric barrage',
  sw_taurus: 'Taurus bunker-buster',
  sw_hyunmoo5: 'Hyunmoo-5 heavy warhead',
  sw_neptune: 'Neptune cruise missile',
  sw_kheibar: 'Kheibar ballistic warhead',
  sw_fattah: 'Fattah hypersonic warhead',
};

function weaponLabel(id: string): string {
  if (SW_WEAPON_NAME[id]) return SW_WEAPON_NAME[id];
  const words = id.replace(/^[a-z]+_/, (m) => (m === 'sw_' ? '' : m)).replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export class MatchTracker {
  readonly side: SidePerf[] = [newSide(), newSide()];
  readonly samples: StatSample[] = [];
  private highlights: Highlight[] = [];
  private nextSample = 0;
  private lastHarvest: [number, number] = [0, 0];
  /** Projectile id -> owner, for interceptions. */
  private shots = new Map<number, number>();
  /** Experience already credited per local unit (kill attribution). */
  private xpSeen = new Map<number, number>();
  private vets = new Map<number, MvpInfo>();
  private bridgeDown: boolean[] = [];
  private firstBlood = false;
  private firstStructure = false;
  private firstSw = [false, false];
  private firstElite = false;
  private firstIntercept = false;
  private firstDrop = [false, false];
  private bigBlast: { score: number; t: number; weapon: string } | null = null;

  constructor(
    private world: World,
    private local: number,
  ) {
    this.bridgeDown = world.bridges.map((b) => b.status === 'down');
  }

  private get t() {
    return this.world.tick / TPS;
  }

  private opp(p: number) {
    return p === 0 ? 1 : p === 1 ? 0 : -1;
  }

  private note(text: string, kind: Highlight['kind']) {
    this.highlights.push({ t: this.t, text, kind });
  }

  private nameOf(def: string) {
    return DEFS[def]?.name ?? def;
  }

  private sideName(p: number) {
    return p === this.local ? 'you' : this.world.players[p]?.name ?? 'enemy';
  }

  /** Feed every drained simulation event. */
  onEvent(ev: SimEvent) {
    const w = this.world;
    switch (ev.t) {
      case 'unitReady':
        if (ev.owner >= 0 && ev.owner < 2) this.side[ev.owner].unitsBuilt++;
        break;
      case 'placed':
      case 'deployed':
        if (ev.owner >= 0 && ev.owner < 2) this.side[ev.owner].structuresBuilt++;
        break;
      case 'death': {
        const d = DEFS[ev.def];
        if (!d || ev.owner < 0 || ev.owner > 1) break;
        if (d.kind === 'unit' && (d as UnitDef).temp) break;
        const o = this.opp(ev.owner);
        if (ev.kind === 'building') {
          this.side[ev.owner].structuresLost++;
          if (o >= 0) this.side[o].structuresDestroyed++;
          if (!this.firstStructure) {
            this.firstStructure = true;
            this.note(ev.owner === this.local ? `First structure lost: your ${d.name}` : `First enemy structure destroyed: ${d.name}`, ev.owner === this.local ? 'bad' : 'good');
          }
        } else {
          this.side[ev.owner].unitsLost++;
          if (o >= 0) this.side[o].unitsKilled++;
          if (!this.firstBlood) {
            this.firstBlood = true;
            this.note(ev.owner === this.local ? `First blood to the enemy: your ${d.name} was destroyed` : `First blood: enemy ${d.name} destroyed`, ev.owner === this.local ? 'bad' : 'good');
          }
        }
        if (ev.owner === this.local) {
          const v = this.vets.get(ev.id);
          if (v) v.alive = false;
        } else if (this.local >= 0) this.creditKill(ev.def);
        break;
      }
      case 'promoted': {
        if (ev.owner !== this.local) break;
        const e = w.get(ev.id);
        const v = this.vets.get(ev.id);
        if (v) {
          v.rank = ev.rank;
          v.rankName = RANK_NAMES[ev.rank] ?? '';
        }
        if (ev.rank >= 2 && !this.firstElite && e) {
          this.firstElite = true;
          this.note(`${this.nameOf(e.def)} promoted to Elite`, 'good');
        }
        break;
      }
      case 'launch':
        this.shots.set(ev.id, ev.owner);
        if (this.shots.size > 3000) {
          // forget the oldest shots (they have long since landed)
          let n = 1000;
          for (const k of this.shots.keys()) {
            this.shots.delete(k);
            if (--n <= 0) break;
          }
        }
        break;
      case 'airburst': {
        if (ev.kind !== 'kill' || ev.victimId === undefined) break;
        const owner = this.shots.get(ev.victimId);
        this.shots.delete(ev.victimId);
        if (owner === undefined || owner < 0 || owner > 1) break;
        const by = this.opp(owner);
        if (by < 0) break;
        this.side[by].intercepted++;
        if (!this.firstIntercept && by === this.local && (ev.victim === 'ballistic' || ev.victim === 'hypersonic' || ev.victim === 'cruise')) {
          this.firstIntercept = true;
          this.note(`Air defence intercepted an enemy ${ev.victim === 'cruise' ? 'cruise' : ev.victim} missile`, 'good');
        }
        break;
      }
      case 'superweapon': {
        if (ev.phase !== 'launch' || ev.owner < 0 || ev.owner > 1) break;
        this.side[ev.owner].superweapons++;
        const info = SW_INFO[ev.sw as SwKind];
        if (!this.firstSw[ev.owner]) {
          this.firstSw[ev.owner] = true;
          this.note(ev.owner === this.local ? `You unleashed the ${info?.name ?? 'superweapon'}` : `Enemy ${info?.name ?? 'superweapon'} launched`, ev.owner === this.local ? 'good' : 'bad');
        }
        break;
      }
      case 'captured': {
        const e = w.get(ev.id);
        if (!e || ev.owner !== this.local) break;
        this.note(`Captured the ${this.nameOf(e.def)}`, 'good');
        break;
      }
      case 'paradrop':
        if (ev.owner >= 0 && ev.owner < 2 && !this.firstDrop[ev.owner]) {
          this.firstDrop[ev.owner] = true;
          this.note(ev.owner === this.local ? 'Your airborne troops jumped over the battlefield' : 'Enemy paratroopers dropped', ev.owner === this.local ? 'good' : 'bad');
        }
        break;
      case 'impact': {
        const wd = WEAPONS[ev.weapon];
        const dmg = wd ? wd.damage * (1 + (wd.splash ?? 0)) : 0;
        if (dmg > 0 && (!this.bigBlast || dmg > this.bigBlast.score)) this.bigBlast = { score: dmg, t: this.t, weapon: ev.weapon };
        break;
      }
    }
  }

  /** Attribute an enemy death to the local unit whose experience just grew by the victim's value. */
  private creditKill(victimDef: string) {
    const value = xpValue(victimDef);
    if (value <= 0) return;
    for (const e of this.world.list) {
      if (e.dead || e.owner !== this.local || e.kind !== 'unit' || !e.xp) continue;
      const seen = this.xpSeen.get(e.id) ?? 0;
      if (e.xp - seen < value - 1e-6) continue;
      this.xpSeen.set(e.id, seen + value);
      let v = this.vets.get(e.id);
      if (!v) {
        v = { name: this.nameOf(e.def), def: e.def, rank: e.rank, rankName: RANK_NAMES[e.rank] ?? '', kills: 0, xp: 0, alive: true };
        this.vets.set(e.id, v);
      }
      v.kills++;
      v.xp = e.xp;
      v.rank = e.rank;
      v.rankName = RANK_NAMES[e.rank] ?? '';
      return;
    }
  }

  /** Call once per frame; samples on simulation time. */
  update() {
    const w = this.world;
    if (w.tick < this.nextSample) return;
    this.nextSample = w.tick + SAMPLE_TICKS;
    this.sample();
    // bridge collapses (bridges.ts keeps their state on the world)
    w.bridges.forEach((b, i) => {
      const down = b.status === 'down';
      if (down && !this.bridgeDown[i]) this.note(`${['Centre', 'North', 'South'][i] ?? 'A'} bridge collapsed into the river`, 'info');
      this.bridgeDown[i] = down;
    });
  }

  private sample() {
    const w = this.world;
    const army: [number, number] = [0, 0];
    for (const e of w.list) {
      if (e.dead || e.kind !== 'unit' || e.owner < 0 || e.owner > 1) continue;
      const d = DEFS[e.def] as UnitDef;
      if (!d || d.temp || d.harvester || d.mcv) continue;
      army[e.owner] += d.cost;
    }
    const income: [number, number] = [0, 0];
    const dtMin = this.samples.length ? (this.t - this.samples[this.samples.length - 1].t) / 60 : 0;
    for (const p of [0, 1] as const) {
      const h = w.players[p]?.stats.harvested ?? 0;
      income[p] = dtMin > 0 ? Math.max(0, (h - this.lastHarvest[p]) / dtMin) : 0;
      this.lastHarvest[p] = h;
      this.side[p].peakArmy = Math.max(this.side[p].peakArmy, army[p]);
    }
    this.samples.push({ t: this.t, army, income });
  }

  /** Close the books: final sample, harvest totals, MVP and the highlight reel. */
  report(win: boolean): MatchReport {
    if (!this.samples.length || this.samples[this.samples.length - 1].t < this.t - 0.5) this.sample();
    for (const p of [0, 1] as const) this.side[p].harvested = this.world.players[p]?.stats.harvested ?? 0;
    const local = Math.max(0, this.local);
    let mvp: MvpInfo | null = null;
    for (const v of this.vets.values()) if (!mvp || v.kills > mvp.kills || (v.kills === mvp.kills && v.xp > mvp.xp)) mvp = v;
    const hl = [...this.highlights];
    if (this.bigBlast) hl.push({ t: this.bigBlast.t, text: `Biggest blast of the battle: ${weaponLabel(this.bigBlast.weapon)}`, kind: 'info' });
    const peak = this.side[local].peakArmy;
    if (peak > 0) {
      const at = this.samples.find((s) => s.army[local] === peak);
      hl.push({ t: at?.t ?? this.t, text: `Your army peaked at $${peak.toLocaleString('en-US')}`, kind: 'info' });
    }
    hl.push({ t: this.t, text: win ? 'Last enemy structure destroyed - victory' : 'Last of your structures fell - defeat', kind: win ? 'good' : 'bad' });
    hl.sort((a, b) => a.t - b.t);
    return {
      win,
      time: this.t,
      local,
      you: this.side[local],
      enemy: this.side[1 - local],
      samples: this.samples.slice(),
      highlights: hl.slice(-9),
      mvp,
    };
  }

  /** Name of a side for messages. */
  label(p: number) {
    return this.sideName(p);
  }
}
