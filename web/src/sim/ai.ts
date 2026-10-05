import { airdropStatus } from './airdrop';
import { isSortieJet, jetReady } from './airbase';
import { bridgeTactics } from './bridges';
import { CRUSH_CHASE, isCrushable } from './crush';
import { DEFS, WEAPONS, airReach, buildingDef, defsForFaction, factionDefByRole, hitsAir, unitDef } from './defs';
import { DOCTRINES, type Doctrine } from './doctrine';
import { PEACE_BUILDING_R, PEACE_HOME_R, RAMP_GAP } from './peace';
import { Rng } from './rng';
import { FLARE_RADIUS, illumReady, pickIllum } from './night';
import { TPS, type Command, type Entity, type Player, type Stance } from './types';
import type { Controller, World } from './world';

export type Difficulty = 'easy' | 'normal' | 'hard';

interface DiffCfg {
  think: number;
  firstWave: number;
  waveGrowth: number;
  maxWave: number;
  defenses: number;
  tech: boolean;
  queueDepth: number;
  harvesters: number;
  /** Tactical skill: 0 = waves only, 1 = retreats / raids / flanks / some focus fire, 2 = full micro. */
  micro: number;
}

const CFG: Record<Difficulty, DiffCfg> = {
  easy: { think: 40, firstWave: 6, waveGrowth: 1, maxWave: 10, defenses: 1, tech: false, queueDepth: 1, harvesters: 1, micro: 0 },
  normal: { think: 20, firstWave: 8, waveGrowth: 2, maxWave: 16, defenses: 3, tech: true, queueDepth: 2, harvesters: 2, micro: 1 },
  hard: { think: 10, firstWave: 9, waveGrowth: 3, maxWave: 24, defenses: 5, tech: true, queueDepth: 3, harvesters: 2, micro: 2 },
};

/** Long-range strike missile launchers (ballistic / hypersonic / cruise): the AI uses them for standoff strikes. */
function isStrike(def: string) {
  const w = unitDef(def)?.weapon;
  const f = w ? WEAPONS[w]?.flight : undefined;
  return f === 'ballistic' || f === 'hypersonic' || f === 'cruise';
}

/** Missile-defence batteries the AI wants once the enemy fields strike missiles. */
const MISSILE_DEFENSE: Record<Difficulty, number> = { easy: 1, normal: 2, hard: 4 };

const BUILD_ORDER: [string, number][] = [
  ['power', 1],
  ['refinery', 1],
  ['barracks', 1],
  ['factory', 1],
  ['power', 2],
  ['refinery', 2],
  ['radar', 1],
  ['power', 3],
  ['airfield', 1],
  ['power', 4],
  ['tech', 1],
  ['factory', 2],
  ['power', 5],
  ['power', 6],
];

type Klass = 'main' | 'arty' | 'strike' | 'jet' | 'aa' | 'support' | 'none';
type Role = 'army' | 'scout' | 'raid' | 'choke' | 'retreat' | 'wing';

interface Intel {
  x: number;
  y: number;
  def: string;
  building: boolean;
  seen: number;
}

interface Wave {
  ids: number[];
  tx: number;
  ty: number;
  focus: number; // focus-fire target
  born: number;
}

function klass(def: string): Klass {
  const d = unitDef(def);
  if (d.harvester || d.mcv || d.engineer || d.temp || d.airlift || d.supply) return 'none';
  if (isStrike(def)) return 'strike';
  if (isSortieJet(d)) return 'jet';
  if (d.aiTag === 'support') return 'support';
  if (!d.weapon) return 'none';
  if (d.aiTag === 'arty') return 'arty';
  if (d.aiTag === 'aa') return 'aa';
  return 'main';
}

/**
 * Computer player. Builds a base, runs the economy and fights according to its
 * nation's doctrine (doctrine.ts): unit mix, defences, wave size, flanking lanes,
 * harvester raids, scouting, focus fire, retreat-to-repair, artillery standoff,
 * anti-air escorts, bridge pickets and missile salvos. Everything it does is a
 * command, it thinks only every `think` ticks, and it keeps its own seeded RNG,
 * so AI games stay deterministic.
 */
export class AIController implements Controller {
  private cfg: DiffCfg;
  private difficulty: Difficulty;
  readonly doctrine: Doctrine;
  private rng: Rng;
  private waveSize: number;
  private lastWave = 0;
  private engineerSent = new Set<number>();
  private intel = new Map<number, Intel>();
  private role = new Map<number, Role>();
  private retreatUntil = new Map<number, number>();
  private waves: Wave[] = [];
  private raidAt = 0;
  private raidStart = 0;
  private scoutAt = 0;
  private scoutsSent = 0;
  private thinks = 0;
  private lastLane = -1;
  private chokeAt = 0;
  /** Night: no new illumination call before this tick (night.ts). */
  private illumNext = 0;
  /**
   * Early-game grace (peace.ts): until this tick the AI builds, scouts and defends itself but
   * launches nothing at the enemy. 0 = no grace (and waves leave as soon as they are big enough).
   */
  readonly peaceUntil: number;
  private defensibleCache = { tick: -1, pts: [] as number[] };

  constructor(
    private world: World,
    private pid: number,
    difficulty: Difficulty,
    opts: { peaceTicks?: number } = {},
  ) {
    this.peaceUntil = Math.max(0, opts.peaceTicks ?? 0);
    this.cfg = CFG[difficulty];
    this.difficulty = difficulty;
    this.rng = new Rng(9001 + pid * 77);
    this.doctrine = DOCTRINES[world.players[pid].faction];
    this.waveSize = Math.max(4, Math.round(this.cfg.firstWave * this.doctrine.wave));
    this.raidAt = TPS * 150;
    this.scoutAt = TPS * 25;
  }

  private get p(): Player {
    return this.world.players[this.pid];
  }

  /** Still in the early-game grace: no offensive action against the enemy. */
  get peace(): boolean {
    return this.world.tick < this.peaceUntil;
  }

  /** During the grace the AI only fights near home or next to one of its own structures (local defence). */
  private defensible(x: number, y: number): boolean {
    const [hx, hy] = this.home();
    if (Math.hypot(x - hx, y - hy) <= PEACE_HOME_R) return true;
    const c = this.defensibleCache;
    if (c.tick !== this.world.tick) {
      c.tick = this.world.tick;
      c.pts.length = 0;
      for (const e of this.world.list) if (!e.dead && e.owner === this.pid && e.kind === 'building') c.pts.push(e.x, e.y);
    }
    for (let i = 0; i < c.pts.length; i += 2) if (Math.hypot(x - c.pts[i], y - c.pts[i + 1]) <= PEACE_BUILDING_R) return true;
    return false;
  }

  private cmd(c: Command) {
    this.world.issue(this.pid, c);
  }

  update() {
    const w = this.world;
    if (this.p.defeated || w.over) return;
    if ((w.tick + this.pid * 3) % this.cfg.think !== 0) return;
    this.thinks++;
    const mine = w.list.filter((e) => !e.dead && e.owner === this.pid);
    const buildings = mine.filter((e) => e.kind === 'building');
    // (soldiers lying wounded don't count as fighting units, and helicopters on a repair trip are left alone: medic.ts, helipad.ts)
    const units = mine.filter((e) => e.kind === 'unit' && e.inside < 0 && !e.para && !e.drop && !e.wound && !e.heli);

    const conyard = buildings.find((b) => buildingDef(b.def).role === 'conyard');
    if (!conyard) {
      const mcv = units.find((u) => unitDef(u.def).mcv);
      if (mcv) {
        this.cmd({ type: 'deploy', ids: [mcv.id] });
        if (mcv.order.type === 'idle' && !mcv.path) {
          // shuffle to a nearby spot if deployment was blocked
          const dx = this.rng.int(5) - 2;
          const dy = this.rng.int(5) - 2;
          this.cmd({ type: 'move', ids: [mcv.id], x: mcv.x + dx, y: mcv.y + dy });
        }
      }
    } else {
      this.manageBuildings(buildings, conyard);
    }
    this.updateIntel();
    this.manageProduction(buildings, units);
    this.manageArmy(buildings, units);
    this.manageRepairs(buildings);
    this.manageIllum(buildings, units);
    this.manageSupport();
    bridgeTactics(w, this.pid, units); // rebuild fallen bridges, drop one under a big assault (bridges.ts)
  }

  // ------------------------------------------------------------------ intel

  /** Remember enemy units and structures we have seen (fog of war); forget the dead. */
  private updateIntel() {
    const w = this.world;
    for (const e of w.list) {
      if (e.dead || !w.isEnemy(this.pid, e.owner)) continue;
      if (e.kind === 'unit' && (unitDef(e.def).temp || e.inside >= 0 || e.wound)) continue;
      if (!w.sees(this.pid, e)) continue;
      const it = this.intel.get(e.id);
      if (it) {
        it.x = e.x;
        it.y = e.y;
        it.seen = w.tick;
      } else this.intel.set(e.id, { x: e.x, y: e.y, def: e.def, building: e.kind === 'building', seen: w.tick });
    }
    if (this.thinks % 6 === 0) {
      for (const [id, it] of this.intel) {
        const e = w.get(id);
        // dead, captured, or a unit not seen for a long time
        if (!e || !w.isEnemy(this.pid, e.owner) || (!it.building && w.tick - it.seen > TPS * 90)) this.intel.delete(id);
      }
    }
  }

  /** Known enemies matching a filter (fresh units only). */
  private known(pred: (it: Intel, id: number) => boolean, fresh = TPS * 30): [number, Intel][] {
    const out: [number, Intel][] = [];
    const t = this.world.tick;
    for (const [id, it] of this.intel) if ((it.building || t - it.seen <= fresh) && pred(it, id)) out.push([id, it]);
    return out;
  }

  private enemyAirCount() {
    let n = 0;
    for (const e of this.world.list) {
      if (e.dead || e.kind !== 'unit' || !this.world.isEnemy(this.pid, e.owner)) continue;
      const d = unitDef(e.def);
      if (d.air && !d.temp && !d.airlift) n++;
      else if (d.weapon && WEAPONS[d.weapon].projectile === 'spawn') n += 0.5; // drone launchers
    }
    return n;
  }

  // ------------------------------------------------------------------ support power

  /** Airborne drop: as soon as it is charged, drop behind the lines onto a weakly defended high-value target, else contest ore. */
  private manageSupport() {
    const w = this.world;
    // after a grace the first drop waits one ramp gap, so the regular first wave comes first
    if (this.peaceUntil > 0 && w.tick < this.peaceUntil + RAMP_GAP[this.difficulty]) return;
    if (!airdropStatus(w, this.pid).ready) return;
    const z = this.pickDropZone();
    if (z) w.issue(this.pid, { type: 'airdrop', x: z[0], y: z[1] });
  }

  /** Enemy firepower around a point (defences count most; SAMs threaten the transport on its run-in). */
  private threatAt(x: number, y: number, r: number, airOnly = false) {
    const w = this.world;
    let threat = 0;
    w.queryRadius(x, y, r, (o) => {
      if (!w.isEnemy(this.pid, o.owner)) return;
      // by night only what we know of: structures we have found, units we see now (night.ts)
      if (w.night && (o.kind === 'building' ? !this.knowsBuilding(o) : !w.sees(this.pid, o))) return;
      const od = DEFS[o.def];
      if (!od.weapon || Math.hypot(o.x - x, o.y - y) > r) return;
      const air = airReach(od); // main + secondary weapon (an RPG + MANPADS team counts as 'yes')
      if (airOnly && air === 'no') return;
      if (o.kind === 'building') threat += air === 'only' ? 3 : 4;
      else if (od.category === 'air') threat += 1;
      else threat += air === 'only' ? (airOnly ? 3 : 1) : od.category === 'infantry' ? 1 : 2;
    });
    return threat;
  }

  private pickDropZone(): [number, number] | null {
    const w = this.world;
    const VALUE: Record<string, number> = { refinery: 9, factory: 8, tech: 8, conyard: 7, power: 7, radar: 6, airfield: 6, barracks: 5, oil: 5 };
    let best: Entity | null = null;
    let bestScore = 0;
    for (const e of w.list) {
      if (e.dead || !w.isEnemy(this.pid, e.owner)) continue;
      // by night only targets we know of: structures we have found, harvesters we see now (night.ts)
      if (w.night && (e.kind === 'building' ? !this.knowsBuilding(e) : !w.sees(this.pid, e))) continue;
      let value: number;
      if (e.kind === 'building') {
        const bd = buildingDef(e.def);
        if (bd.category === 'defense') continue;
        value = VALUE[bd.role] ?? 4;
      } else if (unitDef(e.def).harvester) value = 7;
      else continue;
      const score = value - this.threatAt(e.x, e.y, 8);
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    const base = [this.p.startX + 0.5, this.p.startY + 0.5];
    if (best) {
      // land just short of the target, on our side of it
      const dx = base[0] - best.x;
      const dy = base[1] - best.y;
      const len = Math.hypot(dx, dy) || 1;
      return [best.x + (dx / len) * 2.5, best.y + (dy / len) * 2.5];
    }
    // nothing soft enough: seize the contested ore field nearest the middle, if it is not a killing ground
    const enemy = this.enemyBase();
    if (!enemy) return null;
    let mine: [number, number] | null = null;
    let md = Infinity;
    for (const m of w.map.oreMines) {
      const da = Math.hypot(m.x - base[0], m.y - base[1]);
      const db = Math.hypot(m.x - enemy[0], m.y - enemy[1]);
      const d = Math.abs(da - db) + this.threatAt(m.x, m.y, 7) * 4;
      if (d < md && this.threatAt(m.x, m.y, 7) < 6) {
        md = d;
        mine = [m.x + 0.5, m.y + 0.5];
      }
    }
    return mine;
  }

  // ------------------------------------------------------------------ base

  private count(buildings: Entity[], role: string) {
    return buildings.filter((b) => buildingDef(b.def).role === role).length;
  }

  private manageBuildings(buildings: Entity[], conyard: Entity) {
    const w = this.world;
    const p = this.p;
    const doc = this.doctrine;
    for (const cat of ['building', 'defense'] as const) {
      const ready = p.ready[cat];
      if (ready) {
        const spot = this.findSpot(ready, conyard);
        if (spot) w.issue(this.pid, { type: 'place', def: ready, tx: spot[0], ty: spot[1] });
        else w.issue(this.pid, { type: 'cancel', def: ready });
      }
    }
    if (p.queues.building.length === 0 && !p.ready.building) {
      const next = this.nextBuilding(buildings);
      if (next) w.issue(this.pid, { type: 'produce', def: next });
    }
    if (p.queues.defense.length === 0 && !p.ready.defense && this.count(buildings, 'factory') > 0 && p.credits > 1200) {
      const defenses = buildings.filter((b) => buildingDef(b.def).category === 'defense').length;
      // layered air defence: some doctrines keep a SAM floor; everyone adds missile defence vs strike missiles
      const sams = this.count(buildings, 'def_aa');
      const samWant = Math.max(this.enemyStrikeUnits() > 0 ? MISSILE_DEFENSE[this.difficulty] : 0, this.cfg.micro > 0 ? doc.samFloor : 0);
      const wantSam = sams < samWant && this.count(buildings, 'radar') > 0;
      const maxDef = Math.round(this.cfg.defenses * doc.defense);
      if (defenses < maxDef || wantSam) {
        const order = doc.defenseOrder;
        const role = wantSam ? 'def_aa' : order[defenses % order.length];
        const pick = factionDefByRole(p.faction, role);
        const alt = factionDefByRole(p.faction, 'def_gun');
        if (w.canBuild(this.pid, pick.id)) w.issue(this.pid, { type: 'produce', def: pick.id });
        else if (w.canBuild(this.pid, alt.id)) w.issue(this.pid, { type: 'produce', def: alt.id });
      }
    }
  }

  private enemyStrikeUnits() {
    let n = 0;
    for (const e of this.world.list) if (!e.dead && e.kind === 'unit' && this.world.isEnemy(this.pid, e.owner) && isStrike(e.def)) n++;
    return n;
  }

  private nextBuilding(buildings: Entity[]): string | null {
    const w = this.world;
    const p = this.p;
    const f = p.faction;
    const powerDef = factionDefByRole(f, 'power');
    for (const [role, n] of BUILD_ORDER) {
      if (role === 'tech' && !this.cfg.tech) continue;
      if (this.count(buildings, role) >= n) continue;
      const d = factionDefByRole(f, role);
      if (!w.canBuild(this.pid, d.id)) continue;
      if (role !== 'power' && p.powerOut - p.powerUse + d.power < 0 && w.canBuild(this.pid, powerDef.id)) return powerDef.id;
      return d.id;
    }
    if (p.powerOut - p.powerUse < 40 && w.canBuild(this.pid, powerDef.id)) return powerDef.id;
    return null;
  }

  private findSpot(defId: string, conyard: Entity): [number, number] | null {
    const w = this.world;
    const d = buildingDef(defId);
    const { map } = w;
    const enemy = this.enemyBase();
    let bx = conyard.x;
    let by = conyard.y;
    if (d.category === 'defense' && enemy) {
      const dx = enemy[0] - bx;
      const dy = enemy[1] - by;
      const len = Math.hypot(dx, dy) || 1;
      // missile defence sits close to the base it protects; other defences face the enemy
      const off = (d.role === 'def_aa' ? 2 : 6) + this.rng.int(3);
      const side = (this.rng.next() - 0.5) * 8;
      bx += (dx / len) * off - (dy / len) * side;
      by += (dy / len) * off + (dx / len) * side;
    }
    let oreX = -1;
    let oreY = -1;
    if (d.role === 'refinery') {
      let best = Infinity;
      for (const m of map.oreMines) {
        const dist = Math.hypot(m.x - conyard.x, m.y - conyard.y);
        const taken = w.list.some((b) => !b.dead && b.kind === 'building' && buildingDef(b.def).role === 'refinery' && Math.hypot(b.x - m.x, b.y - m.y) < 8);
        if (!taken && dist < best && dist < 26) {
          best = dist;
          oreX = m.x;
          oreY = m.y;
        }
      }
    }
    let best: [number, number] | null = null;
    let bestScore = Infinity;
    // scan in a canonical frame (the north-east base mirrored onto the south-west one) so rounding and
    // tie-breaks favour neither start position on the point-symmetric map
    const flip = conyard.x > map.w / 2;
    const cbx = flip ? map.w - bx : bx;
    const cby = flip ? map.h - by : by;
    for (let r = 0; r <= 14; r++) {
      for (let oy = -r; oy <= r; oy++) {
        for (let ox = -r; ox <= r; ox++) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
          const ctx = Math.round(cbx + ox - d.w / 2);
          const cty = Math.round(cby + oy - d.h / 2);
          const tx = flip ? map.w - ctx - d.w : ctx;
          const ty = flip ? map.h - cty - d.h : cty;
          if (!w.canPlace(this.pid, defId, tx, ty)) continue;
          if (d.category !== 'defense' && !this.hasClearance(tx, ty, d.w, d.h)) continue;
          let score = Math.hypot(tx + d.w / 2 - bx, ty + d.h / 2 - by);
          if (oreX >= 0) score = Math.hypot(tx + d.w / 2 - oreX, ty + d.h / 2 - oreY) * 1.5 + score * 0.3;
          if (score < bestScore) {
            bestScore = score;
            best = [tx, ty];
          }
        }
      }
      if (best && (oreX < 0 || r > 10)) break;
    }
    return best;
  }

  /** Keep a one-tile walkable ring around new buildings so the base doesn't seal itself in. */
  private hasClearance(tx: number, ty: number, bw: number, bh: number) {
    const w = this.world;
    const { map } = w;
    for (let y = ty - 1; y <= ty + bh; y++) {
      for (let x = tx - 1; x <= tx + bw; x++) {
        if (x >= tx && x < tx + bw && y >= ty && y < ty + bh) continue;
        if (x < 0 || y < 0 || x >= map.w || y >= map.h) return false;
        if (w.occ[y * map.w + x] !== 0) return false;
      }
    }
    return true;
  }

  /**
   * Does the AI know of this enemy structure: found (intel), or part of the enemy base around its start
   * (common knowledge, as for the waves' objective)? Never anything else (fog of war, night.ts).
   */
  private knowsBuilding(b: Entity): boolean {
    if (this.intel.has(b.id)) return true;
    const p = this.world.players[b.owner];
    return !!p && Math.hypot(b.x - p.startX - 0.5, b.y - p.startY - 0.5) < 10;
  }

  private enemyBase(): [number, number] | null {
    for (const p of this.world.players) if (p.id !== this.pid && !p.defeated) return [p.startX + 0.5, p.startY + 0.5];
    return null;
  }

  // ------------------------------------------------------------------ production

  private manageProduction(buildings: Entity[], units: Entity[]) {
    const w = this.world;
    const p = this.p;
    const f = p.faction;
    const doc = this.doctrine;
    const refineries = this.count(buildings, 'refinery');
    const harvesters = units.filter((u) => unitDef(u.def).harvester).length;
    const harvDef = `${f}_harvester`;
    const vq = p.queues.vehicle;
    const iq = p.queues.infantry;
    const aq = p.queues.air;
    if (refineries > 0 && harvesters < Math.min(4, refineries * this.cfg.harvesters) && !vq.some((q) => q.def === harvDef) && w.canBuild(this.pid, harvDef)) {
      w.issue(this.pid, { type: 'produce', def: harvDef });
      return;
    }
    const savingForBuilding = p.queues.building.length === 0 && p.credits < 800;
    if (savingForBuilding && buildings.length < 6) return;

    // capture an oil derrick early with an engineer
    const eng = `${f}_engineer`;
    const engineers = units.filter((u) => u.def === eng);
    for (const e of engineers) {
      if (this.engineerSent.has(e.id)) continue;
      const oil = this.nearestOil(e);
      if (oil) {
        w.issue(this.pid, { type: 'capture', ids: [e.id], target: oil.id });
        this.engineerSent.add(e.id);
      }
    }
    if (this.cfg.tech && engineers.length === 0 && this.engineerSent.size < 2 && w.tick > TPS * 60 && w.canBuild(this.pid, eng) && !iq.some((q) => q.def === eng) && this.nearestOil(null)) {
      w.issue(this.pid, { type: 'produce', def: eng });
    }

    // medics (medic.ts): a couple once it fields infantry
    const med = `${f}_medic`;
    if (w.canBuild(this.pid, med) && p.credits > 400) {
      let soldiers = 0;
      let medics = 0;
      for (const u of units) {
        const ud = unitDef(u.def);
        if (ud.medic) medics++;
        else if (ud.category === 'infantry' && ud.weapon) soldiers++;
      }
      for (const q of iq) if (q.def === med) medics++;
      const want = soldiers >= 3 ? (this.difficulty === 'hard' ? 3 : this.difficulty === 'easy' ? 1 : 2) : 0;
      if (medics < want) w.issue(this.pid, { type: 'produce', def: med });
    }

    // react to enemy air power (and drone launchers) with more anti-air
    const enemyAir = this.enemyAirCount();
    // dedicated AA counts fully, a Rocket Team (RPG + shoulder-fired AA missile) as half a launcher
    let myAA = 0;
    for (const u of units) {
      const d = unitDef(u.def);
      if (d.aiTag === 'aa') myAA++;
      else if (d.weapon2 && hitsAir(d)) myAA += 0.5;
    }
    const wantAA = enemyAir > 0 && myAA < Math.ceil(enemyAir * 0.7) + 1;
    // counter-battery doctrines answer enemy artillery with their own guns
    const enemyArty = this.cfg.micro > 0 && doc.counterBattery ? this.known((it) => !it.building && klass(it.def) === 'arty').length : 0;

    const queues: [typeof iq, 'infantry' | 'vehicle' | 'air', number][] = [
      [iq, 'infantry', 300],
      [vq, 'vehicle', 700],
      [aq, 'air', 900],
    ];
    const prefix = f.length + 1;
    for (const [q, cat, min] of queues) {
      const prio = doc.spend[cat];
      if (q.length >= this.cfg.queueDepth + (prio >= 1.5 ? 1 : 0) || p.credits < min / prio) continue;
      const opts: [string, number][] = [];
      for (const d of defsForFaction(f)) {
        if (d.kind !== 'unit' || d.category !== cat || !d.aiWeight) continue;
        let wgt = d.aiWeight * (doc.bias[d.id.slice(prefix)] ?? 1);
        if (d.aiTag === 'aa') wgt = wantAA ? 10 : enemyAir > 0 ? 2 : 0.3 * (doc.bias[d.id.slice(prefix)] ?? 1);
        else if (enemyAir > 0 && d.weapon2 && hitsAir(d)) wgt *= wantAA ? 2.5 : 1.5; // Rocket Teams double as AA
        if (d.aiTag === 'arty' && enemyArty > 0) wgt *= 1.8;
        opts.push([d.id, wgt]);
      }
      const pick = this.weighted(opts);
      if (pick) w.issue(this.pid, { type: 'produce', def: pick });
    }
  }

  private nearestOil(from: Entity | null): Entity | null {
    let best: Entity | null = null;
    let bd = Infinity;
    const ox = from ? from.x : this.p.startX + 0.5;
    const oy = from ? from.y : this.p.startY + 0.5;
    for (const e of this.world.list) {
      if (e.dead || e.def !== 'oil' || e.owner === this.pid) continue;
      if (e.owner >= 0) continue;
      const d = Math.hypot(e.x - ox, e.y - oy);
      if (d < bd && d < 40) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  private weighted(opts: [string, number][]): string | null {
    const ok = opts.filter(([id]) => this.world.canBuild(this.pid, id));
    const total = ok.reduce((s, [, n]) => s + n, 0);
    if (total === 0) return null;
    let r = this.rng.next() * total;
    for (const [id, n] of ok) {
      r -= n;
      if (r <= 0) return id;
    }
    return ok[ok.length - 1][0];
  }

  // ------------------------------------------------------------------ army

  private roleOf(u: Entity): Role {
    return this.role.get(u.id) ?? 'army';
  }

  private setRole(ids: number[], r: Role) {
    for (const id of ids) {
      if (r === 'army') this.role.delete(id);
      else this.role.set(id, r);
    }
  }

  private stance(ids: number[], s: Stance) {
    const need = ids.filter((id) => this.world.get(id)?.stance !== s);
    if (need.length) this.cmd({ type: 'stance', ids: need, stance: s });
  }

  private home(): [number, number] {
    return [this.p.startX + 0.5, this.p.startY + 0.5];
  }

  private rally(): [number, number] {
    const enemy = this.enemyBase() ?? [this.world.map.w / 2, this.world.map.h / 2];
    const [hx, hy] = this.home();
    const dx = enemy[0] - hx;
    const dy = enemy[1] - hy;
    const len = Math.hypot(dx, dy) || 1;
    return [hx + (dx / len) * 10, hy + (dy / len) * 10];
  }

  private manageArmy(buildings: Entity[], units: Entity[]) {
    const w = this.world;
    const doc = this.doctrine;
    const micro = this.cfg.micro;
    // forget the dead
    if (this.thinks % 10 === 0) {
      for (const id of this.role.keys()) if (!w.get(id)) this.role.delete(id);
      for (const id of this.retreatUntil.keys()) if (!w.get(id)) this.retreatUntil.delete(id);
    }
    const combat = units.filter((u) => klass(u.def) !== 'none');
    this.manageStrikes(combat.filter((u) => klass(u.def) === 'strike'));
    this.manageJets(combat.filter((u) => klass(u.def) === 'jet'));
    // (a medic at work on a wounded soldier is left to finish: medic.ts)
    const force = combat.filter((u) => klass(u.def) !== 'strike' && klass(u.def) !== 'jet' && u.order.type !== 'treat');
    if (force.length === 0) return;

    if (micro > 0) this.manageRetreats(force);
    // defend the base: respond to buildings or harvesters under attack
    if (this.defendBase(buildings, units, force)) return;
    if (micro > 0 || this.scoutsSent === 0) this.manageScout(force);
    if (micro > 0 && doc.choke > 0) this.manageChoke(force);
    if (micro > 0 && doc.harass > 0) this.manageRaids(force);
    if (doc.airWing > 0) this.manageAirWing(force);
    this.manageWaves(force);
    this.manageArtillery(force);
    if (micro > 0) this.manageCrush(force);
    if (micro >= 2 || (micro === 1 && this.thinks % 2 === 0)) this.focusFire();
  }

  /** Strike launchers stand off and fire at high-value structures, in coordinated salvos when the doctrine says so. */
  private manageStrikes(strike: Entity[]) {
    if (!strike.length) return;
    const idle = strike.filter((u) => u.order.type === 'idle');
    const salvo = Math.min(this.cfg.micro > 0 ? this.doctrine.salvo : 1, strike.length);
    const ready = idle.filter((u) => u.cooldown <= 0);
    if (ready.length < salvo) return;
    const t = this.pickStrikeTarget(ready[0]);
    if (t >= 0) this.cmd({ type: 'attack', ids: ready.map((u) => u.id), target: t });
  }

  /**
   * Strike jets fly the airbase sortie cycle (airbase.ts): every jet that sits armed on its pad is sent
   * against the best target it knows - enemy forces pressing the base first, then artillery / missile
   * launchers, harvesters and high-value structures, away from heavy air defences. Jets that are ready
   * together strike together.
   */
  private manageJets(jets: Entity[]) {
    const ready = jets.filter((u) => jetReady(u) && u.order.type === 'idle');
    if (!ready.length) return;
    const t = this.pickJetTarget(ready[0]);
    if (t >= 0) this.cmd({ type: 'attack', ids: ready.map((u) => u.id), target: t });
  }

  private pickJetTarget(from: Entity): number {
    const w = this.world;
    const [hx, hy] = this.home();
    const deep = this.doctrine.deep;
    let best = -1;
    let bs = -Infinity;
    for (const [id, it] of this.known((it) => !it.building || buildingDef(it.def).category !== 'defense', TPS * 15)) {
      const e = w.get(id);
      if (!e || (!it.building && !w.sees(this.pid, e))) continue;
      if (this.peace && !this.defensible(it.x, it.y)) continue;
      const d = DEFS[it.def];
      let value: number;
      if (it.building) {
        const role = buildingDef(it.def).role;
        const k = deep.indexOf(role);
        value = 5 + (k >= 0 ? 6 - k : role === 'conyard' || role === 'superweapon' ? 5 : role === 'refinery' ? 3 : 0);
      } else {
        const k = klass(it.def);
        value = d.kind === 'unit' && d.harvester ? 8 : k === 'arty' || k === 'strike' ? 9 : k === 'aa' ? 2 : d.category === 'infantry' ? 1 : 5;
        // armour pressing our base: hit it before it gets in
        if (Math.hypot(it.x - hx, it.y - hy) < 16) value += 6;
      }
      const s = value * 3 - this.threatAt(it.x, it.y, 7, true) * 2.5 - Math.hypot(it.x - from.x, it.y - from.y) * 0.04;
      if (s > bs) {
        bs = s;
        best = id;
      }
    }
    if (best < 0 && !this.peace) {
      // nothing scouted yet: the enemy base location is common knowledge
      const enemy = this.enemyBase();
      if (enemy)
        for (const e of w.list)
          if (!e.dead && e.kind === 'building' && w.isEnemy(this.pid, e.owner) && buildingDef(e.def).category !== 'defense' && Math.hypot(e.x - enemy[0], e.y - enemy[1]) < 10) return e.id;
    }
    return best;
  }

  /** Strike target: a known high-value structure (or enemy artillery for counter-battery doctrines), nearest first. */
  private pickStrikeTarget(from: Entity): number {
    const w = this.world;
    const deep = this.doctrine.deep;
    let best = -1;
    let bd = Infinity;
    const peace = this.peace;
    const consider = (id: number, x: number, y: number, bonus: number) => {
      if (peace && !this.defensible(x, y)) return;
      const d = Math.hypot(x - from.x, y - from.y) - bonus;
      if (d < bd) {
        bd = d;
        best = id;
      }
    };
    if (this.cfg.micro > 0 && this.doctrine.counterBattery) {
      for (const [id, it] of this.known((it) => !it.building && (klass(it.def) === 'arty' || klass(it.def) === 'strike'), TPS * 10)) consider(id, it.x, it.y, 14);
    }
    for (const [id, it] of this.known((it) => it.building)) {
      const role = buildingDef(it.def).role;
      const k = deep.indexOf(role);
      const bonus = k >= 0 ? 10 - k * 2 : role === 'def_aa' || role === 'conyard' ? 6 : role === 'refinery' || role === 'airfield' ? 4 : 0;
      consider(id, it.x, it.y, bonus);
    }
    if (peace) {
      // grace: only enemy units pressing our base
      for (const [id, it] of this.known((it) => !it.building, TPS * 5)) consider(id, it.x, it.y, 0);
      return best;
    }
    if (best < 0) {
      // nothing scouted yet: the enemy base location is common knowledge
      const enemy = this.enemyBase();
      if (enemy)
        for (const e of w.list) if (!e.dead && e.kind === 'building' && w.isEnemy(this.pid, e.owner) && Math.hypot(e.x - enemy[0], e.y - enemy[1]) < 10) consider(e.id, e.x, e.y, 0);
    }
    return best;
  }

  /** Respond to buildings or harvesters under attack with the units at home. Returns true when it took over the army. */
  private defendBase(buildings: Entity[], units: Entity[], force: Entity[]) {
    const w = this.world;
    const threatened = [...buildings, ...units.filter((u) => unitDef(u.def).harvester)].find((b) => w.tick - b.lastHurt < TPS * 3);
    if (!threatened) return false;
    // ground attackers first; an aircraft is answered only by units that can shoot at aircraft (AA, MANPADS)
    let threat: Entity | null = null;
    let airThreat: Entity | null = null;
    w.queryRadius(threatened.x, threatened.y, 10, (o) => {
      if (o.kind !== 'unit' || !w.isEnemy(this.pid, o.owner) || unitDef(o.def).temp) return;
      // by night only threats we can see, or the one that just fired at us (it gave itself away: night.ts)
      if (w.night && o.id !== threatened.hurtBy && !w.sees(this.pid, o)) return;
      if (w.isAir(o)) airThreat ??= o;
      else threat ??= o;
    });
    const t = (threat ?? airThreat) as Entity | null;
    if (!t) return false;
    const air = w.isAir(t);
    const [hx, hy] = this.home();
    const home = force.filter((u) => {
      const r = this.roleOf(u);
      if (u.order.type === 'attack') return false;
      if (air && !w.canAttack(u.def, t)) return false;
      // already on its way there: don't re-plan every think
      if (u.order.type === 'attackMove' && Math.hypot(u.order.x - t.x, u.order.y - t.y) < 5) return false;
      return (r === 'army' || r === 'wing' || r === 'retreat') && Math.hypot(u.x - hx, u.y - hy) < 28;
    });
    if (home.length) this.cmd({ type: 'move', ids: home.map((u) => u.id), x: t.x, y: t.y, attackMove: true });
    return home.length > 0;
  }

  /** Damaged vehicles / aircraft (and hurt elite veterans) pull back to a recovery vehicle or the base, then rejoin. */
  private manageRetreats(force: Entity[]) {
    const w = this.world;
    const th = this.doctrine.retreat;
    const medic = force.find((u) => unitDef(u.def).repairAura && this.roleOf(u) !== 'retreat');
    for (const u of force) {
      const d = unitDef(u.def);
      const r = this.roleOf(u);
      const hp = u.hp / u.maxHp;
      if (r === 'retreat') {
        const until = this.retreatUntil.get(u.id) ?? 0;
        if (hp >= 0.9 || w.tick > until) {
          this.setRole([u.id], 'army');
          this.retreatUntil.delete(u.id);
        }
        continue;
      }
      if (r === 'scout' || d.repairAura) continue;
      const elite = u.rank >= 2 && hp < 0.5;
      const hurt = th > 0 && hp < th && d.category !== 'infantry' && u.lastHurt > w.tick - TPS * 8;
      if (!elite && !hurt) continue;
      let [x, y] = this.home();
      if (medic && d.category === 'vehicle' && Math.hypot(medic.x - u.x, medic.y - u.y) < 25) {
        // fall back behind the recovery vehicle
        const [hx, hy] = this.home();
        const dx = hx - medic.x;
        const dy = hy - medic.y;
        const len = Math.hypot(dx, dy) || 1;
        x = medic.x + (dx / len) * 1.5;
        y = medic.y + (dy / len) * 1.5;
      } else {
        x += this.rng.range(-3, 3);
        y += this.rng.range(-3, 3);
      }
      this.setRole([u.id], 'retreat');
      this.retreatUntil.set(u.id, w.tick + TPS * (medic ? 30 : 50));
      this.cmd({ type: 'move', ids: [u.id], x, y });
    }
  }

  /** One fast unit tours the map on hold-fire (bridges, enemy ore fields, the enemy base) and comes home. */
  private manageScout(force: Entity[]) {
    const w = this.world;
    const scout = force.find((u) => this.roleOf(u) === 'scout');
    if (scout) {
      if (scout.order.type === 'idle' && scout.queue.length === 0) {
        this.setRole([scout.id], 'army');
        this.stance([scout.id], 'guard');
      }
      return;
    }
    if (w.tick < this.scoutAt || this.scoutsSent >= (this.cfg.micro > 0 ? 3 : 1)) return;
    const [rx, ry] = this.rally();
    const cands = force.filter((u) => this.roleOf(u) === 'army' && u.order.type === 'idle' && !unitDef(u.def).fixedWing && klass(u.def) === 'main');
    if (!cands.length) return;
    const speed = (u: Entity) => unitDef(u.def).speed - DEFS[u.def].cost / 2000 + (unitDef(u.def).aiTag === 'scout' ? 2 : 0);
    cands.sort((a, b) => speed(b) - speed(a) || Math.hypot(a.x - rx, a.y - ry) - Math.hypot(b.x - rx, b.y - ry) || a.id - b.id);
    const u = cands[0];
    const enemy = this.enemyBase();
    if (!enemy) return;
    const pts: [number, number][] = [];
    const lanes = this.lanes();
    const center = lanes.reduce((b, l) => (Math.hypot(l.x - w.map.w / 2, l.y - w.map.h / 2) < Math.hypot(b.x - w.map.w / 2, b.y - w.map.h / 2) ? l : b), lanes[0]);
    if (center) pts.push([center.x, center.y]);
    const ores = [...w.map.oreMines].sort((a, b) => Math.hypot(a.x - enemy[0], a.y - enemy[1]) - Math.hypot(b.x - enemy[0], b.y - enemy[1]));
    for (const m of ores.slice(0, 2)) pts.push([m.x + 0.5, m.y + 0.5]);
    pts.push([enemy[0] + this.rng.range(-6, 6), enemy[1] + this.rng.range(-6, 6)]);
    const side = lanes[(this.scoutsSent + 1) % Math.max(1, lanes.length)];
    if (side) pts.push([side.x, side.y]);
    pts.push([rx, ry]);
    this.setRole([u.id], 'scout');
    this.stance([u.id], 'holdFire');
    pts.forEach(([x, y], i) => this.cmd({ type: 'move', ids: [u.id], x, y, queue: i > 0 }));
    this.scoutsSent++;
    this.scoutAt = w.tick + TPS * 150;
  }

  /** Bridges the armies can cross (the lanes of the map), skipping any that are impassable (destroyed). */
  private lanes(): { x: number; y: number }[] {
    const w = this.world;
    const out: { x: number; y: number }[] = [];
    for (const b of w.map.bridges) {
      if (w.pf.passable(Math.floor(b.x), Math.floor(b.y))) out.push({ x: b.x, y: b.y });
    }
    // fords, passes and avenues of maps with few or no bridges (sim/maps.ts)
    for (const l of w.map.lanes ?? []) if (w.pf.passable(Math.floor(l.x), Math.floor(l.y))) out.push({ x: l.x, y: l.y });
    return out;
  }

  /** Point `k` tiles from a bridge towards our (k > 0) or the enemy's (k < 0) side. */
  private bank(l: { x: number; y: number }, k: number): [number, number] {
    const [hx, hy] = this.home();
    const dx = hx - l.x;
    const dy = hy - l.y;
    const len = Math.hypot(dx, dy) || 1;
    const x = l.x + (dx / len) * k;
    const y = l.y + (dy / len) * k;
    const p = this.world.nearestPassable(x, y, 4);
    return p ? [p[0] + 0.5, p[1] + 0.5] : [x, y];
  }

  /** Choke-point control: keep a picket on the bridge nearest home. */
  private manageChoke(force: Entity[]) {
    if (this.thinks % 3 !== 0 || (this.lastWave === 0 && this.world.tick < TPS * 240)) return;
    const lanes = this.lanes();
    if (!lanes.length) return;
    const [hx, hy] = this.home();
    const bridge = lanes.reduce((b, l) => (Math.hypot(l.x - hx, l.y - hy) < Math.hypot(b.x - hx, b.y - hy) ? l : b), lanes[0]);
    const [px, py] = this.bank(bridge, 4);
    const picket = force.filter((u) => this.roleOf(u) === 'choke');
    // an outpost, not a last stand: spot the enemy wave, then fall back to the main body
    let near = 0;
    for (const [, it] of this.known((it) => !it.building, TPS * 3)) if (Math.hypot(it.x - px, it.y - py) < 10) near++;
    if (near >= 4 && picket.length) {
      const ids = picket.map((u) => u.id);
      const [rx, ry] = this.rally();
      this.setRole(ids, 'army');
      this.cmd({ type: 'move', ids, x: rx, y: ry });
      this.chokeAt = this.world.tick + TPS * 90;
      return;
    }
    const want = this.doctrine.choke;
    if (picket.length < want && this.world.tick >= this.chokeAt) {
      this.chokeAt = this.world.tick + TPS * 120;
      const [rx, ry] = this.rally();
      const cands = force.filter((u) => this.roleOf(u) === 'army' && u.order.type === 'idle' && !unitDef(u.def).air && Math.hypot(u.x - rx, u.y - ry) < 8 && klass(u.def) !== 'support');
      // anti-tank infantry and defensive guns first
      cands.sort((a, b) => (DEFS[b.def].category === 'infantry' ? 1 : 0) - (DEFS[a.def].category === 'infantry' ? 1 : 0) || a.id - b.id);
      const take = cands.slice(0, want - picket.length).map((u) => u.id);
      if (take.length) {
        this.setRole(take, 'choke');
        this.cmd({ type: 'move', ids: take, x: px, y: py });
      }
    }
    // stragglers back to their post
    const away = picket.filter((u) => u.order.type === 'idle' && u.targetId < 0 && Math.hypot(u.x - px, u.y - py) > 5).map((u) => u.id);
    if (away.length) this.cmd({ type: 'move', ids: away, x: px, y: py });
  }

  /** Harvester raids by fast units (and drones), on aggressive stance; they come home when the prey is gone. */
  private manageRaids(force: Entity[]) {
    const w = this.world;
    const raiders = force.filter((u) => this.roleOf(u) === 'raid');
    if (raiders.length) {
      const idle = raiders.filter((u) => u.order.type === 'idle');
      if (idle.length) {
        const prey = this.nearestKnown(idle[0], (it) => !!unitDef(it.def)?.harvester && !it.building, TPS * 20, 14);
        if (prey >= 0 && w.tick - this.raidStart < TPS * 90) this.cmd({ type: 'attack', ids: idle.map((u) => u.id), target: prey });
        else {
          const [rx, ry] = this.rally();
          this.cmd({ type: 'move', ids: idle.map((u) => u.id), x: rx, y: ry });
          this.stance(idle.map((u) => u.id), 'guard');
          this.setRole(idle.map((u) => u.id), 'army');
        }
      }
      return;
    }
    if (w.tick < this.raidAt || this.peace) return;
    this.raidAt = w.tick + Math.round((TPS * 120) / this.doctrine.harass);
    const [rx, ry] = this.rally();
    const fast = force.filter((u) => {
      const d = unitDef(u.def);
      const drones = !!d.weapon && WEAPONS[d.weapon].projectile === 'spawn';
      return this.roleOf(u) === 'army' && u.order.type === 'idle' && Math.hypot(u.x - rx, u.y - ry) < 10 && (d.speed >= 2.3 || drones || (d.air && !d.fixedWing)) && klass(u.def) === 'main';
    });
    if (fast.length < 2) return;
    // the least defended harvester we know of (they keep to their ore fields, so old sightings are good leads)
    let prey = -1;
    let ps = Infinity;
    for (const [id, it] of this.known((it) => !it.building && !!unitDef(it.def)?.harvester, TPS * 240)) {
      const threat = this.threatAt(it.x, it.y, 7);
      const sc = threat + Math.hypot(it.x - rx, it.y - ry) * 0.05;
      if (threat <= 10 && sc < ps) {
        ps = sc;
        prey = id;
      }
    }
    if (prey < 0) return;
    fast.sort((a, b) => unitDef(b.def).speed - unitDef(a.def).speed || a.id - b.id);
    const ids = fast.slice(0, 2 + this.rng.int(3)).map((u) => u.id);
    this.setRole(ids, 'raid');
    this.stance(ids, 'aggressive');
    this.raidStart = w.tick;
    // approach along a flank lane when there is one
    const lane = this.pickLane(true);
    if (lane) this.cmd({ type: 'move', ids, x: lane[0], y: lane[1] });
    this.cmd({ type: 'attack', ids, target: prey, queue: !!lane });
  }

  /** Known enemy nearest to a unit (within maxD), by intel. */
  private nearestKnown(from: Entity, pred: (it: Intel) => boolean, fresh: number, maxD: number): number {
    let best = -1;
    let bd = maxD;
    for (const [id, it] of this.known(pred, fresh)) {
      const d = Math.hypot(it.x - from.x, it.y - from.y);
      if (d < bd) {
        bd = d;
        best = id;
      }
    }
    return best;
  }

  /** UAV-dominance doctrines: aircraft operate as a strike wing hunting soft, lightly defended targets. */
  private manageAirWing(force: Entity[]) {
    const air = force.filter((u) => unitDef(u.def).air && klass(u.def) === 'main' && this.roleOf(u) !== 'retreat');
    for (const u of air) if (this.roleOf(u) === 'army') this.setRole([u.id], 'wing');
    const idle = air.filter((u) => u.order.type === 'idle');
    if (idle.length < this.doctrine.airWing || this.thinks % 2 !== 0) return;
    const c = idle[0];
    let best = -1;
    let bs = -Infinity;
    for (const [id, it] of this.known((it) => !it.building || buildingDef(it.def).category !== 'defense', TPS * 20)) {
      if (this.peace && !this.defensible(it.x, it.y)) continue;
      const d = DEFS[it.def];
      let value = it.building ? 3 : d.kind === 'unit' && d.harvester ? 7 : klass(it.def) === 'arty' || klass(it.def) === 'strike' ? 8 : klass(it.def) === 'aa' ? -10 : 4;
      if (it.building && this.doctrine.deep.includes(buildingDef(it.def).role)) value += 3;
      const s = value * 3 - this.threatAt(it.x, it.y, 8, true) * 4 - Math.hypot(it.x - c.x, it.y - c.y) * 0.05;
      if (s > bs) {
        bs = s;
        best = id;
      }
    }
    if (best < 0 || bs < 0) return;
    const ids = idle.map((u) => u.id);
    const [rx, ry] = this.rally();
    this.cmd({ type: 'attack', ids, target: best });
    this.cmd({ type: 'move', ids, x: rx, y: ry, queue: true });
  }

  /** Lane (bridge) to approach by: the front is where the enemy is strongest; a flank avoids it. */
  private pickLane(flank: boolean): [number, number] | null {
    const lanes = this.lanes();
    if (lanes.length < 2) return null;
    const presence = lanes.map((l) => {
      let n = 0;
      for (const [, it] of this.known((it) => !it.building, TPS * 40)) if (Math.hypot(it.x - l.x, it.y - l.y) < 14) n++;
      return n;
    });
    const [hx, hy] = this.home();
    const enemy = this.enemyBase() ?? [this.world.map.w / 2, this.world.map.h / 2];
    // route length via each bridge
    const len = lanes.map((l) => Math.hypot(l.x - hx, l.y - hy) + Math.hypot(enemy[0] - l.x, enemy[1] - l.y));
    let best = 0;
    let bs = Infinity;
    lanes.forEach((_, i) => {
      const s = flank ? presence[i] * 6 + len[i] * 0.2 + (i === this.lastLane ? 8 : 0) + this.rng.next() * 6 : len[i] - presence[i] * 2;
      if (s < bs) {
        bs = s;
        best = i;
      }
    });
    this.lastLane = best;
    return this.bank(lanes[best], 3);
  }

  /** Gather at the rally point; launch waves along a lane (sometimes splitting off a flanking wing), with AA / EW escorts. */
  private manageWaves(force: Entity[]) {
    const w = this.world;
    const doc = this.doctrine;
    const micro = this.cfg.micro;
    const army = force.filter((u) => this.roleOf(u) === 'army');
    const idle = army.filter((u) => u.order.type === 'idle' && u.guardId < 0);
    const enemy = this.enemyBase();
    if (!enemy) return;
    const [rx, ry] = this.rally();
    const [hx, hy] = this.home();
    const enemyAir = this.enemyAirCount();
    const atRally = idle.filter((u) => Math.hypot(u.x - rx, u.y - ry) < 7);
    const strays = idle.filter((u) => Math.hypot(u.x - rx, u.y - ry) >= 7 && Math.hypot(u.x - hx, u.y - hy) < 22);
    if (strays.length) this.cmd({ type: 'move', ids: strays.map((u) => u.id), x: rx, y: ry });

    // AA stays home as air defence unless the enemy flies; artillery and support never count towards the wave size
    let fighters = atRally.filter((u) => klass(u.def) === 'main');
    const sinceWave = w.tick - this.lastWave;
    // early-game grace (peace.ts): mass at the rally point, launch nothing; afterwards ramp up wave by wave
    const ramp = this.peaceUntil > 0;
    const rampOk = !ramp || (!this.peace && (this.lastWave === 0 || sinceWave >= RAMP_GAP[this.difficulty]));
    if (rampOk && (fighters.length >= this.waveSize || (fighters.length >= 4 && sinceWave > TPS * 240))) {
      if (ramp && fighters.length > this.waveSize) fighters = [...fighters].sort((a, b) => a.id - b.id).slice(0, this.waveSize);
      const target = this.pickTarget();
      const tx = target ? target[0] : enemy[0];
      const ty = target ? target[1] : enemy[1];
      const flank = micro > 0 && this.rng.next() < doc.flank * (micro >= 2 ? 1 : 0.6);
      const main = fighters.map((u) => u.id);
      let wing: number[] = [];
      if (flank && fighters.length >= 8) {
        // the fastest third swings round a flank while the main body pins the front
        const sorted = [...fighters].sort((a, b) => unitDef(b.def).speed - unitDef(a.def).speed || a.id - b.id);
        wing = sorted.slice(0, Math.floor(sorted.length / 3)).map((u) => u.id);
      }
      const body = main.filter((id) => !wing.includes(id));
      const frontLane = micro > 0 ? this.pickLane(flank && !wing.length) : null;
      this.send(body, frontLane, tx, ty);
      if (wing.length) this.send(wing, this.pickLane(true), tx, ty);
      // escorts: AA when the enemy flies, EW / recovery vehicles always
      const leader = body
        .map((id) => w.get(id)!)
        .sort((a, b) => b.maxHp - a.maxHp || a.id - b.id)[0];
      if (leader) {
        const esc = atRally.filter((u) => {
          const k = klass(u.def);
          return k === 'support' || (k === 'aa' && enemyAir > 0);
        });
        const nAA = Math.max(1, Math.ceil(body.length / 4));
        let aa = 0;
        const ids = esc.filter((u) => klass(u.def) !== 'aa' || aa++ < nAA).map((u) => u.id);
        if (ids.length) this.cmd({ type: 'guard', ids, target: leader.id });
      }
      // artillery follows behind the wave
      let arty = atRally.filter((u) => klass(u.def) === 'arty').map((u) => u.id);
      // after a grace the guns massed at home go out a few at a time with the growing waves
      if (ramp) arty = arty.slice(0, Math.max(1, Math.ceil(body.length / 4)));
      this.waves.push({ ids: [...body, ...wing, ...arty], tx, ty, focus: -1, born: w.tick });
      if (this.waves.length > 3) this.waves.shift();
      this.lastWave = w.tick;
      this.waveSize = Math.min(this.cfg.maxWave, this.waveSize + this.cfg.waveGrowth);
    }
    // units that finished an attack-move far from home keep pushing toward the next target
    const deep = idle.filter((u) => Math.hypot(u.x - hx, u.y - hy) >= 22 && klass(u.def) !== 'arty');
    if (deep.length && this.peace) {
      // grace: defenders that chased a raider away come back to the rally point
      this.cmd({ type: 'move', ids: deep.map((u) => u.id), x: rx, y: ry });
    } else if (deep.length) {
      const target = this.pickTarget(deep[0]);
      const [tx, ty] = target ?? enemy;
      this.cmd({ type: 'move', ids: deep.map((u) => u.id), x: tx, y: ty, attackMove: true });
    }
  }

  /** Send a group by a lane: attack-move to our bank of the bridge, then on to the objective (queued waypoints). */
  private send(ids: number[], lane: [number, number] | null, tx: number, ty: number) {
    if (!ids.length) return;
    if (lane) {
      this.cmd({ type: 'move', ids, x: lane[0], y: lane[1], attackMove: true });
      this.cmd({ type: 'move', ids, x: tx, y: ty, attackMove: true, queue: true });
    } else this.cmd({ type: 'move', ids, x: tx, y: ty, attackMove: true });
  }

  /** Artillery keeps a few tiles behind its wave and shells what the front line spots (counter-battery first). */
  private manageArtillery(force: Entity[]) {
    const w = this.world;
    const arty = force.filter((u) => klass(u.def) === 'arty' && this.roleOf(u) === 'army');
    if (!arty.length) return;
    // guns don't charge the enemy on their own: hold position, fire missions come from here
    if (this.cfg.micro > 0 && this.thinks % 5 === 0) this.stance(arty.map((u) => u.id), 'hold');
    const wave = this.waves.length ? this.waves[this.waves.length - 1] : null;
    let cx = 0;
    let cy = 0;
    let n = 0;
    if (wave) {
      for (const id of wave.ids) {
        const u = w.get(id);
        if (!u || klass(u.def) === 'arty') continue;
        cx += u.x;
        cy += u.y;
        n++;
      }
    }
    const [hx, hy] = this.home();
    const peace = this.peace;
    for (const u of arty) {
      if (u.order.type === 'attack' || u.order.type === 'illum') continue;
      const d = unitDef(u.def);
      const wpn = WEAPONS[d.weapon!];
      const range = w.weaponRange(u, wpn);
      // fire mission: best visible target in range
      let best: Entity | null = null;
      let bs = -Infinity;
      w.queryRadius(u.x, u.y, range, (o) => {
        if (!w.isEnemy(this.pid, o.owner) || o.dead) return;
        if (o.kind === 'unit' && (unitDef(o.def).temp || unitDef(o.def).air)) return;
        const dist = w.distTo(u, o);
        if (dist > range || dist < (wpn.minRange ?? 0) + 0.5 || !w.sees(this.pid, o)) return;
        if (peace && !this.defensible(o.x, o.y)) return;
        const k = o.kind === 'unit' ? klass(o.def) : 'none';
        let s = o.kind === 'building' ? (buildingDef(o.def).category === 'defense' ? 6 : 3) : 5;
        if (this.doctrine.counterBattery && (k === 'arty' || k === 'strike')) s += 10;
        s -= o.hp / o.maxHp;
        if (s > bs) {
          bs = s;
          best = o;
        }
      });
      if (best) {
        this.cmd({ type: 'attack', ids: [u.id], target: (best as Entity).id });
        continue;
      }
      if (!n || u.order.type !== 'idle' || this.cfg.micro === 0) continue;
      // standoff: behind the front, towards home
      const fx = cx / n;
      const fy = cy / n;
      const dx = hx - fx;
      const dy = hy - fy;
      const len = Math.hypot(dx, dy) || 1;
      const back = Math.min(range * 0.6, 5);
      const sx = fx + (dx / len) * back;
      const sy = fy + (dy / len) * back;
      if (Math.hypot(u.x - sx, u.y - sy) > 3) this.cmd({ type: 'move', ids: [u.id], x: sx, y: sy });
    }
    // waves whose fighters are all gone
    this.waves = this.waves.filter((wv) => wv.ids.some((id) => w.get(id)));
  }

  /**
   * Night (night.ts): illumination rounds from the artillery / mortars, under the same rules as the player.
   * - Suspected enemies near the base: one of our structures was hit in the last seconds. The shooter's muzzle
   *   flash may show it, but what comes with it stays dark: light up the structure (or, when the shooter is
   *   seen, the ground between the two).
   * - Attacking: a wave closing on its objective lights the ground ahead of its front.
   * Only spots no flare of ours already lights, only guns that have them in range (nobody leaves its post
   * for it), at most one call every few seconds.
   */
  private manageIllum(buildings: Entity[], units: Entity[]) {
    const w = this.world;
    if (!w.night || w.tick < this.illumNext) return;
    const guns = units.filter((u) => illumReady(w, u) && u.order.type !== 'illum' && this.roleOf(u) !== 'retreat');
    if (!guns.length) return;
    const lit = (x: number, y: number) => w.flares.some((f) => f.owner === this.pid && f.end - w.tick > 6 * TPS && Math.hypot(f.x - x, f.y - y) < FLARE_RADIUS * 0.7);
    const spots: [number, number][] = [];
    for (const b of buildings) {
      if (w.tick - b.lastHurt >= TPS * 4) continue;
      const a = w.get(b.hurtBy);
      const [x, y] = a && !a.dead && w.sees(this.pid, a) ? [(a.x + b.x) / 2, (a.y + b.y) / 2] : [b.x, b.y];
      if (!lit(x, y)) spots.push([x, y]);
      if (spots.length >= 2) break;
    }
    if (!this.peace) {
      for (const wave of this.waves) {
        let cx = 0;
        let cy = 0;
        let n = 0;
        for (const id of wave.ids) {
          const u = w.get(id);
          if (!u || klass(u.def) === 'arty') continue;
          cx += u.x;
          cy += u.y;
          n++;
        }
        if (!n) continue;
        cx /= n;
        cy /= n;
        const dx = wave.tx - cx;
        const dy = wave.ty - cy;
        const dist = Math.hypot(dx, dy);
        if (dist > 18) continue;
        const ahead = Math.min(dist, 5);
        const x = cx + (dist > 0 ? (dx / dist) * ahead : 0);
        const y = cy + (dist > 0 ? (dy / dist) * ahead : 0);
        if (!lit(x, y)) spots.push([x, y]);
      }
    }
    for (const [x, y] of spots) {
      const gun = pickIllum(w, guns, x, y);
      if (!gun || Math.hypot(gun.x - x, gun.y - y) > w.weaponRange(gun, WEAPONS[unitDef(gun.def).weapon!])) continue;
      this.cmd({ type: 'illum', ids: [gun.id], x, y });
      this.illumNext = w.tick + TPS * 6;
      return;
    }
  }

  /** Is this unit busy running over a soldier (attack order on infantry in contact; crush.ts)? */
  private crushing(u: Entity): boolean {
    if (u.order.type !== 'attack' || !unitDef(u.def).crusher) return false;
    const t = this.world.get(u.order.target);
    return !!t && isCrushable(t) && Math.hypot(t.x - u.x, t.y - u.y) <= CRUSH_CHASE + 0.5;
  }

  /** Opportunistic crushing: heavy vehicles on the move or idle drive over enemy soldiers right in front of them, then carry on. */
  private manageCrush(force: Entity[]) {
    const w = this.world;
    const peace = this.peace;
    for (const u of force) {
      const d = unitDef(u.def);
      if (!d.crusher || !d.weapon || u.stance === 'hold' || this.roleOf(u) === 'retreat') continue;
      const o = u.order;
      if (o.type !== 'attackMove' && o.type !== 'idle') continue;
      const wpn = WEAPONS[d.weapon];
      const fx = Math.cos(u.facing);
      const fy = Math.sin(u.facing);
      let best: Entity | null = null;
      let bd = CRUSH_CHASE - 0.2;
      w.queryRadius(u.x, u.y, CRUSH_CHASE, (t) => {
        if (!w.isEnemy(this.pid, t.owner) || !isCrushable(t) || !w.canHit(wpn, t) || !w.sees(this.pid, t)) return;
        if (peace && !this.defensible(t.x, t.y)) return;
        const dx = t.x - u.x;
        const dy = t.y - u.y;
        const dist = Math.hypot(dx, dy);
        // roughly ahead: no turning round for a soldier behind
        if (dist >= bd || (dist > 0.3 && (dx * fx + dy * fy) / dist < 0.35)) return;
        bd = dist;
        best = t;
      });
      if (!best) continue;
      this.cmd({ type: 'attack', ids: [u.id], target: (best as Entity).id });
      if (o.type === 'attackMove') this.cmd({ type: 'move', ids: [u.id], x: o.x, y: o.y, attackMove: true, queue: true });
    }
  }

  /** Focus fire: units of a wave in contact shoot the same (weakest, most dangerous) enemy, then resume the advance. */
  private focusFire() {
    const w = this.world;
    for (const wave of this.waves) {
      const alive = wave.ids.map((id) => w.get(id)).filter((u): u is Entity => !!u && klass(u.def) === 'main' && this.roleOf(u) === 'army');
      if (alive.length < 2) continue;
      let cx = 0;
      let cy = 0;
      for (const u of alive) {
        cx += u.x;
        cy += u.y;
      }
      cx /= alive.length;
      cy /= alive.length;
      let t = w.get(wave.focus);
      if (!t || Math.hypot(t.x - cx, t.y - cy) > 9 || !w.sees(this.pid, t)) {
        t = undefined;
        let bs = Infinity;
        w.queryRadius(cx, cy, 8, (o) => {
          if (!w.isEnemy(this.pid, o.owner) || o.kind !== 'unit' || o.dead) return;
          const od = unitDef(o.def);
          if (od.temp || !od.weapon || !w.sees(this.pid, o)) return;
          // weakest first, dangerous ones (artillery, launchers, anti-tank) a little earlier
          const k = klass(o.def);
          const s = o.hp * (k === 'arty' || k === 'strike' ? 0.6 : 1) + Math.hypot(o.x - cx, o.y - cy) * 25;
          if (s < bs) {
            bs = s;
            t = o;
          }
        });
        wave.focus = t ? (t as Entity).id : -1;
      }
      if (!t) continue;
      const tgt = t as Entity;
      const ids = alive
        .filter((u) => {
          if ((u.order.type === 'attack' && u.order.target === tgt.id) || this.crushing(u)) return false;
          const wpn = w.weaponVs(u.def, tgt);
          return !!wpn && wpn.projectile !== 'spawn' && w.distTo(u, tgt) <= w.weaponRange(u, wpn) + 1.5;
        })
        .map((u) => u.id);
      if (ids.length < 2) continue;
      this.cmd({ type: 'attack', ids, target: tgt.id });
      this.cmd({ type: 'move', ids, x: wave.tx, y: wave.ty, attackMove: true, queue: true });
    }
  }

  /** Wave objective: a known enemy structure (doctrine's preferred roles weigh in), else the enemy base. */
  private pickTarget(from?: Entity): [number, number] | null {
    const ox = from ? from.x : this.p.startX + 0.5;
    const oy = from ? from.y : this.p.startY + 0.5;
    const deep = this.doctrine.deep;
    let best: [number, number] | null = null;
    let bd = Infinity;
    for (const [, it] of this.known(() => true, TPS * 15)) {
      let d = Math.hypot(it.x - ox, it.y - oy) + (it.building ? 0 : 15);
      if (it.building) {
        const k = deep.indexOf(buildingDef(it.def).role);
        if (k >= 0 && this.cfg.micro > 0) d -= 6 - k * 1.5;
      }
      if (d < bd) {
        bd = d;
        best = [it.x, it.y];
      }
    }
    if (!best) {
      const enemy = this.enemyBase();
      if (enemy) best = [enemy[0], enemy[1]];
    }
    return best;
  }

  private manageRepairs(buildings: Entity[]) {
    if (this.p.credits < 600) return;
    for (const b of buildings) {
      if (!b.repairing && b.hp < b.maxHp * 0.6 && this.world.tick - b.lastHurt > TPS * 2) {
        this.world.issue(this.pid, { type: 'repair', id: b.id });
      }
    }
  }
}
