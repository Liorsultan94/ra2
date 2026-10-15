import { airdropStatus } from './airdrop';
import { isSortieJet, jetReady } from './airbase';
import { bridgeTactics } from './bridges';
import { CRUSH_CHASE, isCrushable } from './crush';
import { DEFS, VERSUS, WEAPONS, airReach, buildingDef, defsForFaction, factionDefByRole, hitsAir, unitDef } from './defs';
import { DOCTRINES, NO_WAR, type Doctrine, type WarDoctrine } from './doctrine';
import { canGarrisonUnit, garrisonRoom } from './garrison';
import { inDockApron } from './harvest';
import { northStart, turnable } from './turn';
import { WATER_LEVEL, groundHeight } from './map';
import { Loco } from './slope';
import { PEACE_BUILDING_R, PEACE_HOME_R, RAMP_GAP } from './peace';
import { PLAN_CFG, isFast, pickPlan, planBuildOrder, planWeights, type Plan, type PlanCfg } from './plans';
import { Rng } from './rng';
import { FLARE_RADIUS, hasNightVision, illumReady, pickIllum } from './night';
import { TPS, type ArmorClass, type Command, type Entity, type Player, type Stance } from './types';
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

/** How strongly production shifts toward counters of what the enemy fields (0 = doctrine mix only). */
const ADAPT: Record<Difficulty, number> = { easy: 0.4, normal: 0.8, hard: 1.1 };
/** Chance that a main push is preceded by a feint on another lane (micro > 0 only). */
const FEINT: Record<Difficulty, number> = { easy: 0, normal: 0.25, hard: 0.4 };

/**
 * Per-AI seed: the match seed mixed with the player id and the nation (every match differs, a replay /
 * lockstep peer does not; one seed does not hand the same opening plan to a slot whichever nations play).
 */
export function aiSeed(seed: number, pid: number, faction = ''): number {
  let f = 0;
  for (let i = 0; i < faction.length; i++) f = Math.imul(f ^ faction.charCodeAt(i), 0x01000193);
  let h = Math.imul((seed | 0) ^ 0x5bd1e995 ^ f, 0x9e3779b1) ^ Math.imul(pid + 1, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/** What the AI has seen the enemy field, by class (units seen in the last 90 s, structures until destroyed). */
export interface EnemyMix {
  armour: number;
  infantry: number;
  air: number;
  arty: number;
  defence: number;
}

/** Long-range strike missile launchers (ballistic / hypersonic / cruise): the AI uses them for standoff strikes. */
function isStrike(def: string) {
  const w = unitDef(def)?.weapon;
  const f = w ? WEAPONS[w]?.flight : undefined;
  return f === 'ballistic' || f === 'hypersonic' || f === 'cruise';
}

/** Missile-defence batteries the AI wants once the enemy fields strike missiles. */
const MISSILE_DEFENSE: Record<Difficulty, number> = { easy: 1, normal: 2, hard: 4 };

/** Our harvesters keep this far (tiles) from an enemy base centre: its home ore fields lie inside it. */
export const HARVEST_KEEP_OUT = 24;
/** A scout looks at the enemy base from this far out (tiles from its centre), at the edge of its sight. */
export const SCOUT_LOOKOUT_R = 22;
/** During the grace the scout keeps this far from the enemy base: the middle of the map only. */
export const SCOUT_PEACE_KEEP_OUT = 34;

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

/**
 * The seeded build order: the economy core always comes first; then barracks / factory and the mid-game
 * (second refinery, radar, airfield) come in one of a few orders, so no two matches open quite alike.
 */
function buildOrderFor(rng: Rng, plan: Plan): [string, number][] {
  const o = BUILD_ORDER.map((s) => [...s] as [string, number]);
  if (rng.next() < 0.4) [o[2], o[3]] = [o[3], o[2]]; // factory before barracks
  const v = rng.next();
  if (v < 0.3) [o[4], o[5]] = [o[5], o[4]]; // greedy: second refinery before more power
  else if (v < 0.6) {
    // tech: radar before the second refinery
    const [r] = o.splice(6, 1);
    o.splice(5, 0, r);
  }
  return planBuildOrder(o, plan);
}

/**
 * The war doctrine's build order (on the plan's): rapid expansion puts the second refinery straight after the first
 * war factory and a third after the radar; an artillery doctrine gets the radar (its guns' prerequisite) right after
 * the war factory.
 */
function warOrder(o: [string, number][], war: WarDoctrine): [string, number][] {
  if (!war.expand && !war.prep) return o;
  const out = [...o];
  const after = (role: string, n: number, item: [string, number]) => {
    const i = out.findIndex(([r, k]) => r === item[0] && k === item[1]);
    if (i >= 0) out.splice(i, 1);
    const j = out.findIndex(([r, k]) => r === role && k === n);
    out.splice(j < 0 ? out.length : j + 1, 0, item);
  };
  if (war.prep) after('factory', 1, ['radar', 1]);
  if (war.expand) {
    after('factory', 1, ['refinery', 2]);
    if (!out.some(([q, n]) => q === 'refinery' && n === 3)) after('radar', 1, ['refinery', 3]);
  }
  return out;
}

type Klass = 'main' | 'arty' | 'strike' | 'jet' | 'aa' | 'support' | 'none';
type Role = 'army' | 'scout' | 'raid' | 'choke' | 'retreat' | 'wing' | 'staged' | 'ambush' | 'fallback' | 'post';

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
  /** Lane key it went by ('' = none / a feint's own), its value at launch and the enemy value it is seen to kill. */
  lane: string;
  value: number;
  killed: number;
  feint?: boolean;
  /** Orderly retreat (AI2): consecutive losing estimates, committed (no retreat) until this tick, retreats so far, fallen back. */
  low?: number;
  commit?: number;
  retreats?: number;
  fell?: boolean;
}

/** A group falling back to a defensive position (AI2 orderly retreat), then regrouping there. */
interface Fallback {
  ids: number[];
  x: number;
  y: number;
  since: number;
  /** When most of it got there (-1: still on the way). */
  arrived: number;
  /** The enemy force it broke off from: strength (vs our mix at the time), armour mix, where. */
  enemy: number;
  mix: ArmourMix;
  fx: number;
  fy: number;
  /** The objective it returns to. */
  tx: number;
  ty: number;
  retreats: number;
}

type ArmourMix = Record<ArmorClass, number>;
const ARMOURS: ArmorClass[] = ['infantry', 'light', 'heavy', 'building', 'aircraft'];

/**
 * Orderly retreat (AI2) by difficulty: a group whose estimated strength falls below `ratio` of the enemy force
 * it is in contact with (twice running) falls back to its defences; it holds there at least `hold` s and returns
 * (`relaunch`) once it is `back` times as strong as what it broke off from, else merges into the army after
 * `merge` s. At most `max` retreats per wave; a returning group is committed (no retreat) for `commit` s.
 */
/**
 * Terrain use (AI2) by difficulty: town houses held on the enemy's routes, the infantry / AT squad posted at each
 * mouth of our coloured canyon (ambush), the detachment holding the summit plateau (with AA on Hard), and the tech
 * sites engineers capture besides the oil.
 */
const TERRAIN: Record<Difficulty, { houses: number; canyon: number; plateau: number; plateauAA: boolean; techs: number }> = {
  easy: { houses: 0, canyon: 0, plateau: 0, plateauAA: false, techs: 0 },
  normal: { houses: 1, canyon: 0, plateau: 2, plateauAA: false, techs: 1 },
  hard: { houses: 2, canyon: 2, plateau: 3, plateauAA: true, techs: 2 },
};

const RETREAT: Record<Difficulty, { ratio: number; every: number; max: number; hold: number; merge: number; relaunch: boolean; back: number; commit: number } | null> = {
  easy: null,
  normal: { ratio: 0.45, every: 2, max: 1, hold: 12, merge: 20, relaunch: false, back: 1.3, commit: 40 },
  hard: { ratio: 0.6, every: 1, max: 2, hold: 8, merge: 45, relaunch: true, back: 1.3, commit: 40 },
};

/** A main body held at the rally point while its feint draws the defence onto another lane. */
interface Staged {
  ids: number[];
  wing: number[];
  lane: [number, number] | null;
  laneKey: string;
  wingLane: [number, number] | null;
  tx: number;
  ty: number;
  at: number;
  /** Artillery preparation (war doctrine): the guns, their firing position, when they opened fire (-1: not yet). */
  prep?: { guns: number[]; x: number; y: number; fired: number };
}

const cost = (def: string) => DEFS[def]?.cost ?? 0;

/** Distance from (x, y) to the segment (x0, y0)-(x1, y1). */
function segDist(x: number, y: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l2)) : 0;
  return Math.hypot(x - x0 - dx * t, y - y0 - dy * t);
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
  /** The nation's war doctrine (AI2), layered on the plan: Normal and Hard only (NO_WAR on Easy); tests may swap it. */
  war: WarDoctrine;
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
  private baseCache = { tick: -1, pts: [] as number[] };
  private mineUnits: Entity[] = [];
  private mineBuildings: Entity[] = [];
  /** This match's build order (seeded variation of BUILD_ORDER, shaped by the plan). */
  buildOrder: [string, number][];
  /** Opening strategy (plans.ts), the plans played so far, when it may next change. */
  plan: Plan;
  readonly planLog: Plan[] = [];
  private planCfg: PlanCfg;
  private planSince = 0;
  private planBad = 0;
  /** Seeded style: raid cadence multiplier, the size jitter of the next wave, the earliest tick it may leave. */
  private raidPace: number;
  private waveJitter = 0;
  private waveNotBefore = 0;
  private waveStale: number;
  /** What the enemy is seen to field (updateIntel), and a temporary boost to counter it after a bad trade. */
  readonly mix: EnemyMix = { armour: 0, infantry: 0, air: 0, arty: 0, defence: 0 };
  private adaptBoost = 0;
  private adaptBoostUntil = 0;
  /** Lanes that cost us a wave for little in return (key -> penalty, decays as waves go out). */
  private lanePenalty = new Map<string, number>();
  /** Raid targets found well defended: avoided for a while. */
  private avoid: { x: number; y: number; until: number }[] = [];
  private raid: { ids: number[]; prey: number; x: number; y: number } | null = null;
  private staged: Staged | null = null;
  /** Groups falling back / regrouping (AI2 orderly retreat). */
  private fallbacks: Fallback[] = [];
  /** Terrain posts (AI2): unit id -> post key, the posts (canyon mouths, the summit plateau), reinforcement cooldowns. */
  private posts = new Map<number, string>();
  private postSpots: { key: string; x: number; y: number; ambush: boolean }[] | null = null;
  private postNext = new Map<string, number>();
  private postSent = new Map<string, number>();
  private postBudget = 0;
  /** Artillery-preparation doctrines: since when a ready wave waits for its guns (-1: not waiting). */
  private prepWait = -1;
  private houseNext = 0;
  private plateauSeen = new Set<number>();
  /** Debug / tests (AI2): houses garrisoned, canyon squads posted, plateau detachments sent and units that got up there, tech sites targeted. */
  readonly terrainStats = { garrisons: 0, canyon: 0, plateau: 0, plateauVisits: 0, techs: 0 };
  /** Debug / tests: feints made, opportunity attacks (enemy army away), bad trades remembered. */
  readonly stats = { waves: 0, feints: 0, opportunist: 0, night: 0, badTrades: 0, ambushes: 0, lanes: [] as string[], firstWave: -1, retreats: 0, returns: 0, regroups: 0, preps: 0, broad: 0, strikes: {} as Record<string, number> };
  /** Terrain (heightmap) normalisation and lazily found chokepoints for maps without bridges / lanes. */
  private hMin = 0;
  private hSpan = 1;
  private rallyCache: { key: number; pt: [number, number] } | null = null;
  private chokes: { x: number; y: number }[] | null = null;
  private chokeScan = 0;
  private chokeFound: { x: number; y: number; w: number }[] = [];
  private ambushUntil = 0;
  private ambushAt: [number, number] = [0, 0];

  constructor(
    private world: World,
    private pid: number,
    difficulty: Difficulty,
    opts: { peaceTicks?: number } = {},
  ) {
    this.peaceUntil = Math.max(0, opts.peaceTicks ?? 0);
    this.cfg = CFG[difficulty];
    this.difficulty = difficulty;
    // seeded from the match: every match plays differently, a replay / lockstep peer identically
    this.rng = new Rng(aiSeed(world.seed, pid, world.players[pid].faction));
    this.doctrine = DOCTRINES[world.players[pid].faction];
    // the game plan (opening strategy): seeded, weighted by doctrine and difficulty, within the arsenal
    this.plan = pickPlan(this.rng, planWeights(world.players[pid].faction, this.doctrine, difficulty));
    this.planCfg = PLAN_CFG[this.plan];
    this.planLog.push(this.plan);
    this.buildOrder = buildOrderFor(this.rng, this.plan);
    this.waveSize = Math.min(this.cfg.maxWave, Math.max(4, Math.round(this.cfg.firstWave * this.doctrine.wave * this.planCfg.wave)));
    this.raidPace = this.rng.range(0.75, 1.35);
    this.raidAt = Math.round(TPS * this.rng.range(115, 195));
    this.scoutAt = Math.round(TPS * this.rng.range(18, 40));
    this.waveStale = Math.round(TPS * this.rng.range(180, 300) * this.planCfg.stale);
    this.waveJitter = this.rng.int(3) - 1;
    this.war = this.cfg.micro > 0 ? this.doctrine.war : NO_WAR;
    this.buildOrder = warOrder(this.buildOrder, this.war);
    this.scoutAt = Math.round(this.scoutAt * this.war.scoutEarly);
    const hs = world.map.heights;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < hs.length; i++) {
      const h = hs[i];
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    this.hMin = Math.max(lo, WATER_LEVEL);
    this.hSpan = Math.max(0.5, Math.min(4, hi - this.hMin));
  }

  /** Play this plan from now on (tests / debug; plans.ts). */
  setPlan(plan: Plan) {
    this.plan = plan;
    this.planCfg = PLAN_CFG[plan];
    this.planLog.push(plan);
    this.planSince = this.world.tick;
    this.buildOrder = buildOrderFor(this.rng, plan);
    this.buildOrder = warOrder(this.buildOrder, this.war);
    this.waveSize = Math.min(this.cfg.maxWave, Math.max(4, Math.round(this.cfg.firstWave * this.doctrine.wave * this.planCfg.wave)));
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
    const buildings = this.mineBuildings;
    const units = this.mineUnits;
    buildings.length = 0;
    units.length = 0;
    for (let i = 0; i < w.list.length; i++) {
      const e = w.list[i];
      if (e.dead || e.owner !== this.pid) continue;
      if (e.kind === 'building') buildings.push(e);
      else if (e.kind === 'unit' && e.inside < 0 && !e.para && !e.drop && !e.wound && !e.heli) units.push(e);
    }

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
    this.manageHarvesters(units);
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
        // a death we saw near one of our waves counts toward its trade (lane memory)
        if (!e && w.tick - it.seen <= this.cfg.think * 6 + TPS * 2) this.creditKill(it);
        // dead, captured, or a unit not seen for a long time
        if (!e || !w.isEnemy(this.pid, e.owner) || (!it.building && w.tick - it.seen > TPS * 90)) this.intel.delete(id);
      }
    }
    if (this.thinks % 4 === 0) this.updateMix();
  }

  /** Tally what the enemy fields, by class, from what we have seen (fog of war: intel only). */
  private updateMix() {
    const m = this.mix;
    m.armour = m.infantry = m.air = m.arty = m.defence = 0;
    for (const it of this.intel.values()) {
      const d = DEFS[it.def];
      if (!d) continue;
      if (it.building) {
        if (d.category === 'defense') m.defence++;
        continue;
      }
      const ud = unitDef(it.def);
      if (ud.temp || ud.airlift || !ud.weapon) continue;
      const k = klass(it.def);
      if (k === 'arty' || k === 'strike') m.arty++;
      else if (ud.air || WEAPONS[ud.weapon].projectile === 'spawn') m.air++;
      else if (ud.category === 'infantry') m.infantry++;
      else if (ud.category === 'vehicle') m.armour += ud.armor === 'heavy' ? 1 : 0.5;
    }
  }

  /** An enemy we saw die: credit it to the wave fighting next to it. */
  private creditKill(it: Intel) {
    for (const wv of this.waves) {
      const c = this.centroid(wv);
      if (c && Math.hypot(c[0] - it.x, c[1] - it.y) < 12) {
        wv.killed += cost(it.def);
        return;
      }
    }
  }

  private centroid(wv: Wave): [number, number] | null {
    let cx = 0;
    let cy = 0;
    let n = 0;
    for (const id of wv.ids) {
      const u = this.world.get(id);
      if (!u) continue;
      cx += u.x;
      cy += u.y;
      n++;
    }
    return n ? [cx / n, cy / n] : null;
  }

  /** Unit-mix multiplier of the game plan (plans.ts): fast raiders, guns / launchers, aircraft, heavy armour. */
  private planMix(d: ReturnType<typeof unitDef>): number {
    const c = this.planCfg;
    let m = 1;
    const k = klass(d.id);
    if (k === 'arty' || k === 'strike') m *= c.arty;
    else if (d.category === 'air') m *= c.air;
    else if (isFast(d.id)) m *= c.fast;
    if (d.category === 'vehicle' && d.armor === 'heavy') m *= c.heavy;
    return m;
  }

  /**
   * Production multiplier for a unit type from what the enemy fields: anti-armour weapons vs armour, anti-infantry
   * vs mass infantry, anti-air vs air, artillery / strike missiles vs a turtle (static defences) and vs enemy guns.
   */
  private counterWeight(d: ReturnType<typeof unitDef>): number {
    const m = this.mix;
    const total = m.armour + m.infantry + m.air + m.arty + m.defence * 1.5;
    if (total < 3 || !d.weapon) return 1;
    const gain = ADAPT[this.difficulty] + (this.world.tick < this.adaptBoostUntil ? this.adaptBoost : 0);
    const vs = (armor: 'heavy' | 'infantry') => {
      let v = VERSUS[WEAPONS[d.weapon!].warhead][armor];
      if (d.weapon2) v = Math.max(v, VERSUS[WEAPONS[d.weapon2].warhead][armor]);
      return v;
    };
    const k = klass(d.id);
    const fit =
      (m.armour / total) * (vs('heavy') - 0.55) * 1.6 +
      (m.infantry / total) * (vs('infantry') - 0.6) * 1.6 +
      (m.air / total) * (hitsAir(d) ? 1 : -0.3) +
      ((m.defence * 1.5) / total) * (k === 'arty' || k === 'strike' ? 1.4 : 0) +
      (m.arty / total) * (k === 'arty' || k === 'strike' || (d.speed ?? 0) >= 2.3 ? 0.8 : 0);
    return Math.max(0.25, 1 + gain * fit * 2);
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

  private isExplored(x: number, y: number): boolean {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const { w, h } = this.world.map;
    return tx >= 0 && ty >= 0 && tx < w && ty < h && !!this.p.explored[ty * w + tx];
  }

  // ------------------------------------------------------------------ terrain

  /** Ground height above the lowest dry ground of this map (world units, capped: a summit is not worth any detour). */
  private hNorm(x: number, y: number): number {
    return Math.min(Math.max(groundHeight(this.world.map, x, y), WATER_LEVEL) - this.hMin, this.hSpan);
  }

  /**
   * The best position within r tiles of (x, y): passable dry ground, as high as it gets without straying far.
   * Generic (heightmap + passability, any map size), (2r+1)^2 samples: artillery, pickets, rally point.
   */
  private highSpot(x: number, y: number, r: number): [number, number] {
    const w = this.world;
    const { map } = w;
    let best: [number, number] = [x, y];
    let bs = -Infinity;
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    for (let oy = -r; oy <= r; oy++) {
      for (let ox = -r; ox <= r; ox++) {
        const tx = cx + ox;
        const ty = cy + oy;
        if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h || !w.pf.passable(tx, ty) || w.region[ty * map.w + tx] !== w.mainland) continue;
        const px = tx + 0.5;
        const py = ty + 0.5;
        const d = Math.hypot(px - x, py - y);
        if (d > r + 0.5) continue;
        // (straight up there: a ledge above a cliff is no position for a gun that has to drive round to it)
        if (!w.lineOk(x, y, px, py, Loco.Vehicle)) continue;
        // a tile of height is worth some six tiles of detour
        const s = this.hNorm(px, py) * 2 - d * 0.35;
        if (s > bs) {
          bs = s;
          best = [px, py];
        }
      }
    }
    return best;
  }

  /** Passable run from (x, y) along (dx, dy), both ways, capped. */
  private run(x: number, y: number, dx: number, dy: number, cap: number): number {
    const pf = this.world.pf;
    let n = 1;
    for (const s of [1, -1]) {
      for (let k = 1; k <= cap; k++) {
        if (!pf.passable(Math.floor(x + dx * k * s), Math.floor(y + dy * k * s))) break;
        n++;
      }
    }
    return n;
  }

  /**
   * Chokepoints (passes between impassable ground) found from passability alone, for maps that list no bridges
   * or lanes: the middle band between the bases is sampled a few hundred points per think, and a point that is
   * narrow one way but runs on the other (a corridor, not a pocket) is a choke. Done once, spread over thinks.
   */
  private scanChokes() {
    if (this.chokes) return;
    const w = this.world;
    const { map } = w;
    const enemy = this.enemyBase();
    if (!enemy) return;
    const [hx, hy] = this.home();
    const ax = enemy[0] - hx;
    const ay = enemy[1] - hy;
    const L2 = ax * ax + ay * ay || 1;
    const S = 3;
    const cols = Math.ceil(map.w / S);
    const total = cols * Math.ceil(map.h / S);
    const end = Math.min(total, this.chokeScan + 240);
    const D = [
      [1, 0],
      [0, 1],
      [Math.SQRT1_2, Math.SQRT1_2],
      [Math.SQRT1_2, -Math.SQRT1_2],
    ];
    for (let i = this.chokeScan; i < end; i++) {
      const x = (i % cols) * S + 1.5;
      const y = Math.floor(i / cols) * S + 1.5;
      const t = ((x - hx) * ax + (y - hy) * ay) / L2;
      if (t < 0.2 || t > 0.8 || !w.pf.passable(Math.floor(x), Math.floor(y)) || w.regionOf(x, y) !== w.mainland) continue;
      let lo = Infinity;
      let hi = 0;
      for (const [dx, dy] of D) {
        const r = this.run(x, y, dx, dy, 12);
        if (r < lo) lo = r;
        if (r > hi) hi = r;
      }
      if (lo <= 7 && hi >= 16) this.chokeFound.push({ x, y, w: lo });
    }
    this.chokeScan = end;
    if (end < total) return;
    const picked: { x: number; y: number }[] = [];
    for (const c of [...this.chokeFound].sort((a, b) => a.w - b.w || a.y - b.y || a.x - b.x)) {
      if (picked.every((p) => Math.hypot(p.x - c.x, p.y - c.y) >= 12)) picked.push({ x: c.x, y: c.y });
      if (picked.length >= 4) break;
    }
    this.chokes = picked;
    this.chokeFound = [];
  }

  private pickDropZone(): [number, number] | null {
    const w = this.world;
    const VALUE: Record<string, number> = { refinery: 9, factory: 8, tech: 8, conyard: 7, power: 7, radar: 6, airfield: 6, barracks: 5, oil: 5 };
    let best: Entity | null = null;
    let bestScore = 0;
    for (const e of w.list) {
      if (e.dead || !w.isEnemy(this.pid, e.owner)) continue;
      // cannot target units or structures in unexplored shroud
      if (!this.isExplored(e.x, e.y)) continue;
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
      // land just short of the target, on our side of it (only if explored)
      const dx = base[0] - best.x;
      const dy = base[1] - best.y;
      const len = Math.hypot(dx, dy) || 1;
      const dropX = best.x + (dx / len) * 2.5;
      const dropY = best.y + (dy / len) * 2.5;
      if (this.isExplored(dropX, dropY)) return [dropX, dropY];
      if (this.isExplored(best.x, best.y)) return [best.x, best.y];
    }
    // nothing soft enough: seize the contested ore field nearest the middle, if explored and not a killing ground
    const enemy = this.enemyBase();
    if (!enemy) return null;
    let mine: [number, number] | null = null;
    let md = Infinity;
    for (const m of w.map.oreMines) {
      if (!this.isExplored(m.x, m.y)) continue;
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
      const maxDef = Math.round(this.cfg.defenses * doc.defense * this.planCfg.defense);
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
    for (const [role, n] of this.buildOrder) {
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
    let foundAt = -1;
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
          if (this.blocksDock(defId, tx, ty, d.w, d.h)) continue;
          let score = Math.hypot(tx + d.w / 2 - bx, ty + d.h / 2 - by);
          // defences prefer the high ground (a commanding position) within a few tiles
          if (d.category === 'defense') score -= this.hNorm(tx + d.w / 2, ty + d.h / 2) * 2;
          if (oreX >= 0) score = Math.hypot(tx + d.w / 2 - oreX, ty + d.h / 2 - oreY) * 1.5 + score * 0.3;
          if (score < bestScore) {
            bestScore = score;
            best = [tx, ty];
          }
        }
      }
      if (best && foundAt < 0) foundAt = r;
      if (best && (oreX < 0 || r > 10) && (d.category !== 'defense' || r >= foundAt + 3)) break;
    }
    return best;
  }

  /**
   * Never wall in a refinery's dock: no footprint on the lane / apron in front of one of our refineries, and
   * a new refinery only where its own apron is open ground (else its harvesters queue at a dead end).
   */
  private blocksDock(defId: string, tx: number, ty: number, bw: number, bh: number): boolean {
    const w = this.world;
    for (const r of w.list) {
      if (r.dead || r.kind !== 'building' || r.owner !== this.pid || !buildingDef(r.def).dock) continue;
      const rd = buildingDef(r.def);
      // only refineries within reach of this footprint
      if (tx > r.tx + rd.w + 5 || tx + bw < r.tx - 5 || ty > r.ty + rd.h + 5 || ty + bh < r.ty - 5) continue;
      for (let y = ty; y < ty + bh; y++) for (let x = tx; x < tx + bw; x++) if (inDockApron(r.def, r.tx, r.ty, x, y, r.flip)) return true;
    }
    if (buildingDef(defId).dock) {
      const { map } = w;
      const d = buildingDef(defId);
      const flip = turnable(defId) && northStart(this.p.startY, map.h);
      for (let y = ty - 5; y <= ty + d.h + 4; y++)
        for (let x = tx - 2; x <= tx + d.w + 1; x++) {
          if (!inDockApron(defId, tx, ty, x, y, flip)) continue;
          if (x < 0 || y < 0 || x >= map.w || y >= map.h) return true;
          if (x >= tx && x < tx + d.w && y >= ty && y < ty + d.h) continue;
          if (!w.pf.passable(x, y) || w.occ[y * map.w + x] !== 0) return true;
        }
    }
    return false;
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
    if (refineries > 0 && harvesters < Math.min(4 + this.planCfg.harvesters + this.war.expand, refineries * (this.cfg.harvesters + this.planCfg.harvesters + this.war.expand)) && !vq.some((q) => q.def === harvDef) && w.canBuild(this.pid, harvDef)) {
      w.issue(this.pid, { type: 'produce', def: harvDef });
      return;
    }
    const savingForBuilding = p.queues.building.length === 0 && p.credits < 800;
    if (savingForBuilding && buildings.length < 6) return;

    // capture an oil derrick early with an engineer
    const eng = `${f}_engineer`;
    const engineers = units.filter((u) => u.def === eng);
    // (AI2: Normal / Hard also take the neutral tech sites on our side of the map while they are cheap to hold)
    const techs = TERRAIN[this.difficulty].techs;
    for (const e of engineers) {
      if (this.engineerSent.has(e.id)) continue;
      const oil = this.nearestOil(e) ?? (techs ? this.nearestTech(e) : null);
      if (oil) {
        w.issue(this.pid, { type: 'capture', ids: [e.id], target: oil.id });
        this.engineerSent.add(e.id);
        if (oil.def !== 'oil') this.terrainStats.techs++;
      }
    }
    if (
      this.cfg.tech &&
      engineers.length === 0 &&
      w.tick > TPS * this.planCfg.oilAt &&
      w.canBuild(this.pid, eng) &&
      !iq.some((q) => q.def === eng) &&
      ((this.engineerSent.size < 2 && this.nearestOil(null)) || (techs > 0 && this.engineerSent.size < 2 + techs && p.credits > 1500 && this.count(buildings, 'refinery') >= 2 && this.nearestTech(null)))
    ) {
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
      const prio = doc.spend[cat] * this.planCfg.spend[cat] * (cat === 'infantry' ? this.war.infantry : 1);
      if (q.length >= this.cfg.queueDepth + (prio >= 1.5 ? 1 : 0) || p.credits < min / prio) continue;
      const opts: [string, number][] = [];
      for (const d of defsForFaction(f)) {
        if (d.kind !== 'unit' || d.category !== cat || !d.aiWeight) continue;
        // (the war doctrine's mix on top; the artillery build-up before the first big attacks)
        let wgt = d.aiWeight * (doc.bias[d.id.slice(prefix)] ?? 1) * (this.war.mix[d.id.slice(prefix)] ?? 1);
        if (d.aiTag === 'arty' && this.stats.waves < 2) wgt *= this.war.prepMix;
        if (d.aiTag === 'aa') wgt = wantAA ? 10 : enemyAir > 0 ? 2 : 0.3 * (doc.bias[d.id.slice(prefix)] ?? 1);
        else if (enemyAir > 0 && d.weapon2 && hitsAir(d)) wgt *= wantAA ? 2.5 : 1.5; // Rocket Teams double as AA
        if (d.aiTag === 'arty' && enemyArty > 0) wgt *= 1.8;
        if (d.aiTag !== 'aa') wgt *= this.counterWeight(d) * this.planMix(d);
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

  /**
   * The nearest neutral tech site (hospital, comms, airport...) on our side of the map that nothing we know of
   * guards: an engineer takes it while it is cheap to hold (AI2).
   */
  private nearestTech(from: Entity | null): Entity | null {
    const enemy = this.enemyBase();
    if (!enemy) return null;
    const [hx, hy] = this.home();
    const ox = from ? from.x : hx;
    const oy = from ? from.y : hy;
    let best: Entity | null = null;
    let bd = Infinity;
    for (const e of this.world.list) {
      if (e.dead || e.kind !== 'building' || e.owner >= 0 || !buildingDef(e.def).techKind) continue;
      const dh = Math.hypot(e.x - hx, e.y - hy);
      if (dh > 55 || dh > Math.hypot(e.x - enemy[0], e.y - enemy[1]) * 0.85) continue;
      if (this.known((it) => !it.building || !!DEFS[it.def].weapon, TPS * 20).some(([, it]) => Math.hypot(it.x - e.x, it.y - e.y) < 9)) continue;
      const d = Math.hypot(e.x - ox, e.y - oy);
      if (d < bd) {
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
    // the best ground near the point 10 tiles out towards the enemy (cached: the base is fixed)
    const key = Math.round(enemy[0]) * 4096 + Math.round(enemy[1]);
    if (this.rallyCache?.key !== key) this.rallyCache = { key, pt: this.highSpot(hx + (dx / len) * 10, hy + (dy / len) * 10, 3) };
    return this.rallyCache.pt;
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
    this.retireWaves();
    if (this.staged && !this.staged.ids.some((id) => w.get(id))) this.staged = null;
    if (force.length === 0) return;

    if (micro > 0) this.manageRetreats(force);
    // orderly retreat of losing groups to the defences, regrouping and returning (AI2)
    if (RETREAT[this.difficulty]) {
      this.manageEngagements(buildings);
      this.manageFallbacks(force);
    }
    // defend the base: respond to buildings or harvesters under attack
    if (this.defendBase(buildings, units, force)) return;
    if (micro > 0 || this.scoutsSent === 0) this.manageScout(force);
    if (micro > 0 && doc.choke > 0) this.manageChoke(force);
    if (micro > 0 && doc.harass > 0) this.manageRaids(force);
    if (doc.airWing > 0) this.manageAirWing(force);
    if (micro > 0) this.manageAmbush(force);
    if (micro > 0 && this.thinks % 3 === 0) this.manageTerrain(force);
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
    if (t >= 0) {
      this.cmd({ type: 'attack', ids: ready.map((u) => u.id), target: t });
      this.tally(t);
    }
  }

  /** Debug / tests: what our strikes and jets go for (a building role, 'harvester', 'arty', 'aa' or 'unit'). */
  private tally(id: number) {
    const e = this.world.get(id);
    if (!e) return;
    const k = this.targetKey(e.def, e.kind === 'building');
    this.stats.strikes[k] = (this.stats.strikes[k] ?? 0) + 1;
  }

  private targetKey(def: string, building: boolean): string {
    if (building) return buildingDef(def).role;
    const k = klass(def);
    return unitDef(def).harvester ? 'harvester' : k === 'arty' || k === 'strike' ? 'arty' : k === 'aa' ? 'aa' : 'unit';
  }

  /**
   * The war doctrine's priority of a known enemy (0 = none, higher = more wanted): its rank in the doctrine's
   * high-value target list (Israel: superweapon, refineries, power, artillery; Iran: the economy; USA: air defences).
   */
  private hvtRank(def: string, building: boolean): number {
    const hvt = this.war.hvt;
    if (!hvt.length) return 0;
    let key = this.targetKey(def, building);
    if (key === 'def_aa' && !hvt.includes(key)) key = 'aa';
    const i = hvt.indexOf(key);
    return i < 0 ? 0 : hvt.length - i;
  }

  /** Air superiority doctrine: hunt air defences while we know of any. */
  private huntAA(): boolean {
    return this.war.aaHunt && this.known((it) => (it.building ? buildingDef(it.def).role === 'def_aa' : klass(it.def) === 'aa'), TPS * 30).length > 0;
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
    if (t >= 0) {
      this.cmd({ type: 'attack', ids: ready.map((u) => u.id), target: t });
      this.tally(t);
    }
  }

  private pickJetTarget(from: Entity): number {
    const w = this.world;
    const [hx, hy] = this.home();
    const deep = this.doctrine.deep;
    let best = -1;
    let bs = -Infinity;
    const hunt = this.huntAA();
    for (const [id, it] of this.known((it) => !it.building || buildingDef(it.def).category !== 'defense' || (hunt && buildingDef(it.def).role === 'def_aa'), TPS * 15)) {
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
      // the war doctrine: its high-value targets; air superiority first (the air defences, braving their fire)
      value += this.hvtRank(it.def, it.building) * 2;
      const aaMark = hunt && this.targetKey(it.def, it.building).endsWith('aa');
      if (aaMark) value += 8;
      const s = value * 3 - this.threatAt(it.x, it.y, 7, true) * (aaMark ? 1.2 : 2.5) - Math.hypot(it.x - from.x, it.y - from.y) * 0.04;
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
      // (the war doctrine's high-value targets weigh most)
      consider(id, it.x, it.y, bonus + this.hvtRank(it.def, true) * 4);
    }
    // the doctrine's unit targets (harvesters, guns, air defences) seen just now
    if (this.war.hvt.length && !peace)
      for (const [id, it] of this.known((it) => !it.building && this.hvtRank(it.def, false) > 0, TPS * 6)) consider(id, it.x, it.y, this.hvtRank(it.def, false) * 4);
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
      return (r === 'army' || r === 'wing' || r === 'retreat' || r === 'staged' || r === 'ambush' || r === 'fallback') && Math.hypot(u.x - hx, u.y - hy) < 28;
    });
    // a last stand: the base itself is under attack, so groups regrouping near it fight
    const amb = home.filter((u) => this.roleOf(u) === 'ambush' || this.roleOf(u) === 'fallback').map((u) => u.id);
    if (amb.length) {
      this.setRole(amb, 'army');
      this.stance(amb, 'guard');
    }
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

  // ------------------------------------------------------------------ orderly retreat (AI2)

  /** Armour mix (hp shares) of a set of entities. */
  private armourMix(es: Entity[]): ArmourMix {
    const m: ArmourMix = { infantry: 0, light: 0, heavy: 0, building: 0, aircraft: 0 };
    let t = 0;
    for (const e of es) {
      m[DEFS[e.def].armor] += e.hp;
      t += e.hp;
    }
    if (t > 0) for (const a of ARMOURS) m[a] /= t;
    return m;
  }

  /** Damage per second of a unit / structure type against an armour mix (its better weapon for each class). */
  private firepower(def: string, mix: ArmourMix): number {
    const d = DEFS[def];
    if (!d?.weapon) return 0;
    const ws = [WEAPONS[d.weapon]];
    if (d.kind === 'unit' && d.weapon2) ws.push(WEAPONS[d.weapon2]);
    let f = 0;
    for (const a of ARMOURS) {
      if (!mix[a]) continue;
      let best = 0;
      for (const wp of ws) {
        if (a === 'aircraft' ? wp.air === 'no' : wp.air === 'only') continue;
        // (a drone launcher's damage is its drones': about a light rocket each)
        const dmg = wp.projectile === 'spawn' ? 60 : wp.damage;
        best = Math.max(best, ((dmg * (wp.burst ?? 1) * TPS) / Math.max(1, wp.rof)) * VERSUS[wp.warhead][a]);
      }
      f += mix[a] * best;
    }
    return f;
  }

  /** Combat strength of a force against an armour mix: the sum of hp x dps (unit-type matchups); a held house counts its garrison. */
  private strength(es: Entity[], vs: ArmourMix): number {
    let s = 0;
    for (const e of es) {
      if (e.passengers.length && buildingDef(e.def)?.garrison) {
        for (const id of e.passengers) {
          const p = this.world.get(id);
          if (p) s += e.hp * this.firepower(p.def, vs) * 1.25;
        }
      } else s += e.hp * this.firepower(e.def, vs);
    }
    return s;
  }

  /**
   * The engagement around a group: its strength against the visible enemy force near it (units we see now, plus the
   * enemy defences and held houses we know of in range of it). null when no enemy is in contact.
   */
  private engagement(mem: Entity[], cx: number, cy: number): { ratio: number; theirs: number; mix: ArmourMix } | null {
    const w = this.world;
    const foes: Entity[] = [];
    w.queryRadius(cx, cy, 11, (o) => {
      if (o.dead || !w.isEnemy(this.pid, o.owner)) return;
      if (o.kind === 'unit') {
        const d = unitDef(o.def);
        if (d.temp || !d.weapon || o.inside >= 0 || !w.sees(this.pid, o)) return;
      } else if (!DEFS[o.def].weapon && !o.passengers.length) return;
      else if (!this.knowsBuilding(o) && !w.sees(this.pid, o)) return;
      foes.push(o);
    });
    if (!foes.length) return null;
    const theirMix = this.armourMix(foes);
    const theirs = this.strength(foes, this.armourMix(mem));
    if (theirs <= 0) return null;
    return { ratio: this.strength(mem, theirMix) / theirs, theirs, mix: theirMix };
  }

  /**
   * Each wave in contact estimates the fight: when it is clearly losing (twice running, below the difficulty's
   * ratio) it falls back together to the nearest friendly defensive position or the rally point - towards our
   * defences, so a pursuer runs into them. No retreat while committed (a returning group), after the wave's last
   * allowed retreat, or near home while the base itself is under attack (a last stand).
   */
  private manageEngagements(buildings: Entity[]) {
    const R = RETREAT[this.difficulty]!;
    if (this.thinks % R.every !== 0) return;
    const w = this.world;
    const [hx, hy] = this.home();
    const baseHit = buildings.some((b) => w.tick - b.lastHurt < TPS * 5);
    for (const wv of this.waves) {
      if (wv.feint || wv.fell) continue;
      const mem: Entity[] = [];
      for (const id of wv.ids) {
        const u = w.get(id);
        if (u && this.roleOf(u) === 'army') mem.push(u);
      }
      const fighters = mem.filter((u) => klass(u.def) !== 'arty');
      if (fighters.length < 2) continue;
      let cx = 0;
      let cy = 0;
      for (const u of fighters) {
        cx += u.x;
        cy += u.y;
      }
      cx /= fighters.length;
      cy /= fighters.length;
      if (baseHit && Math.hypot(cx - hx, cy - hy) < 30) {
        wv.low = 0;
        continue;
      }
      const eng = this.engagement(fighters, cx, cy);
      if (!eng || eng.ratio >= R.ratio * this.war.pitched || w.tick < (wv.commit ?? 0) || (wv.retreats ?? 0) >= R.max) {
        wv.low = 0;
        continue;
      }
      wv.low = (wv.low ?? 0) + 1;
      if (wv.low < 2) continue;
      const pt = this.fallbackPoint(cx, cy);
      // already at our defences: stand and fight there
      if (!pt) {
        wv.low = 0;
        continue;
      }
      wv.fell = true;
      wv.retreats = (wv.retreats ?? 0) + 1;
      const ids = mem.map((u) => u.id);
      this.setRole(ids, 'fallback');
      this.stance(ids, 'guard');
      // (plain moves, not attack-moves: they do not stop to fight on the way)
      this.cmd({ type: 'move', ids, x: pt[0], y: pt[1] });
      this.fallbacks.push({ ids, x: pt[0], y: pt[1], since: w.tick, arrived: -1, enemy: eng.theirs, mix: eng.mix, fx: cx, fy: cy, tx: wv.tx, ty: wv.ty, retreats: wv.retreats });
      this.stats.retreats++;
    }
  }

  /**
   * Where a group at (x, y) falls back to: just behind the nearest of our armed defences on the way home (a pursuer
   * runs into the guns), else the rally point, else home. null when it is already at the defences.
   */
  private fallbackPoint(x: number, y: number): [number, number] | null {
    const w = this.world;
    const [hx, hy] = this.home();
    let best: Entity | null = null;
    let bs = Infinity;
    for (const b of this.mineBuildings) {
      if (b.dead || buildingDef(b.def).category !== 'defense' || !DEFS[b.def].weapon) continue;
      const s = Math.hypot(b.x - x, b.y - y) + Math.hypot(b.x - hx, b.y - hy) * 0.5;
      if (s < bs) {
        bs = s;
        best = b;
      }
    }
    let px: number;
    let py: number;
    if (best) {
      const dx = hx - best.x;
      const dy = hy - best.y;
      const len = Math.hypot(dx, dy) || 1;
      px = best.x + (dx / len) * 2.5;
      py = best.y + (dy / len) * 2.5;
    } else [px, py] = this.rally();
    if (Math.hypot(px - x, py - y) < 7) {
      if (best) return null;
      [px, py] = [hx, hy];
      if (Math.hypot(px - x, py - y) < 7) return null;
    }
    const p = w.nearestPassable(px, py, 4, w.mainland);
    return p ? [p[0] + 0.5, p[1] + 0.5] : [px, py];
  }

  /**
   * Groups falling back: they keep moving (no stopping to fight) unless cornered by a pursuer they cannot outrun;
   * damaged vehicles go on to repair (manageRetreats). At the defences they regroup with the reinforcements there,
   * and once strong enough again (Hard) they return to their objective together, committed; else they merge into
   * the army at the rally point.
   */
  private manageFallbacks(force: Entity[]) {
    const R = RETREAT[this.difficulty]!;
    const w = this.world;
    for (const f of this.fallbacks) {
      const mem: Entity[] = [];
      for (const id of f.ids) {
        const u = w.get(id);
        if (u && this.roleOf(u) === 'fallback') mem.push(u);
      }
      if (!mem.length) {
        f.ids = [];
        continue;
      }
      const near = mem.filter((u) => Math.hypot(u.x - f.x, u.y - f.y) < 5);
      if (f.arrived < 0) {
        if (near.length * 5 >= mem.length * 3 || w.tick - f.since > TPS * 30) f.arrived = w.tick;
        for (const u of mem) {
          if (near.includes(u)) continue;
          // cornered: a pursuer at its heels that it cannot outrun - turn and fight it
          if (w.tick - u.lastHurt < TPS * 1.5) {
            let foe: Entity | null = null;
            let fd = 3;
            w.queryRadius(u.x, u.y, 3, (o) => {
              if (o.kind !== 'unit' || !w.isEnemy(this.pid, o.owner) || !w.sees(this.pid, o) || !w.canAttack(u.def, o)) return;
              const d = Math.hypot(o.x - u.x, o.y - u.y);
              if (d < fd && unitDef(o.def).speed >= unitDef(u.def).speed) {
                fd = d;
                foe = o;
              }
            });
            if (foe) {
              this.cmd({ type: 'attack', ids: [u.id], target: (foe as Entity).id });
              this.cmd({ type: 'move', ids: [u.id], x: f.x, y: f.y, queue: true });
              continue;
            }
          }
          if (u.order.type === 'idle') this.cmd({ type: 'move', ids: [u.id], x: f.x, y: f.y });
        }
        continue;
      }
      const held = w.tick - f.arrived;
      if (held < TPS * R.hold) continue;
      // regroup: the group and the army reinforcements idle near it or at the rally point
      const [rx, ry] = this.rally();
      const reinf = force.filter((u) => this.roleOf(u) === 'army' && u.order.type === 'idle' && klass(u.def) === 'main' && (Math.hypot(u.x - f.x, u.y - f.y) < 10 || Math.hypot(u.x - rx, u.y - ry) < 9));
      const all = [...mem, ...reinf];
      if (R.relaunch && this.strength(all, f.mix) >= f.enemy * R.back && !this.peace) {
        const ids = all.map((u) => u.id);
        this.setRole(ids, 'army');
        this.stance(ids, 'guard');
        this.send(ids, null, f.tx, f.ty);
        let value = 0;
        for (const u of all) value += cost(u.def);
        this.waves.push({ ids, tx: f.tx, ty: f.ty, focus: -1, born: w.tick, lane: '', value, killed: 0, commit: w.tick + TPS * R.commit, retreats: f.retreats });
        while (this.waves.length > 6) this.judgeWave(this.waves.shift()!);
        this.stats.returns++;
        f.ids = [];
      } else if (held >= TPS * R.merge) {
        // not strong enough yet: join the army; the next wave takes them along
        const ids = mem.map((u) => u.id);
        this.setRole(ids, 'army');
        this.cmd({ type: 'move', ids, x: rx, y: ry });
        this.stats.regroups++;
        f.ids = [];
      }
    }
    this.fallbacks = this.fallbacks.filter((f) => f.ids.length);
  }

  /**
   * Scouting: limited, and never into the enemy base. One light, fast vehicle on hold-fire tours and comes home:
   * - during the grace one tour of the middle of the map (the centre lane, the contested ore field, a side lane),
   *   well clear of the enemy base, so the first attack stays a surprise;
   * - afterwards, now and then, it also looks at the enemy base from the edge of its sight (a lookout just outside
   *   the base on our side of it). It never drives through the base or parks in it.
   */
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
    if (w.tick < this.scoutAt || this.scoutsSent >= (this.cfg.micro > 0 ? 3 + this.war.scouts : 1)) return;
    const enemy = this.enemyBase();
    if (!enemy) return;
    const [rx, ry] = this.rally();
    // a light vehicle: no main battle tank (that reads as an attack), no infantry walking across the map, no aircraft
    const cands = force.filter((u) => {
      const d = unitDef(u.def);
      // (intelligence-first doctrines send drones too)
      return this.roleOf(u) === 'army' && u.order.type === 'idle' && klass(u.def) === 'main' && ((d.category === 'vehicle' && d.armor === 'light') || (this.war.scouts > 0 && !!d.air && !d.fixedWing));
    });
    if (!cands.length) return;
    const speed = (u: Entity) => unitDef(u.def).speed - DEFS[u.def].cost / 2000 + (unitDef(u.def).aiTag === 'scout' ? 2 : 0);
    cands.sort((a, b) => speed(b) - speed(a) || Math.hypot(a.x - rx, a.y - ry) - Math.hypot(b.x - rx, b.y - ry) || a.id - b.id);
    const u = cands[0];
    const peace = this.peace;
    const keepOut = peace ? SCOUT_PEACE_KEEP_OUT : SCOUT_LOOKOUT_R - 1;
    const pts: [number, number][] = [];
    const add = (x: number, y: number) => {
      const p = w.nearestPassable(x, y, 4, w.mainland);
      if (p && !this.nearEnemyBase(p[0] + 0.5, p[1] + 0.5, keepOut)) pts.push([p[0] + 0.5, p[1] + 0.5]);
    };
    const mid = (x: number, y: number) => Math.hypot(x - w.map.w / 2, y - w.map.h / 2);
    const lanes = this.lanes();
    const center = lanes.reduce((b, l) => (mid(l.x, l.y) < mid(b.x, b.y) ? l : b), lanes[0]);
    if (center) add(center.x, center.y);
    // the contested ore field: the one about as far from both bases
    const [hx, hy] = this.home();
    let ore: { x: number; y: number } | null = null;
    let od = Infinity;
    for (const m of w.map.oreMines) {
      const d = Math.abs(Math.hypot(m.x - hx, m.y - hy) - Math.hypot(m.x - enemy[0], m.y - enemy[1]));
      if (d < od) {
        od = d;
        ore = m;
      }
    }
    if (ore) add(ore.x + 0.5, ore.y + 0.5);
    if (!peace) {
      // lookout: the edge of the enemy base, seen from our side of it, a little to one flank
      const a = Math.atan2(hy - enemy[1], hx - enemy[0]) + this.rng.range(-0.6, 0.6);
      add(enemy[0] + Math.cos(a) * SCOUT_LOOKOUT_R, enemy[1] + Math.sin(a) * SCOUT_LOOKOUT_R);
    }
    const side = lanes[(this.scoutsSent + 1) % Math.max(1, lanes.length)];
    if (side && side !== center) add(side.x, side.y);
    if (!pts.length) {
      this.scoutAt = w.tick + TPS * 30;
      return;
    }
    pts.push([rx, ry]);
    this.setRole([u.id], 'scout');
    this.stance([u.id], 'holdFire');
    pts.forEach(([x, y], i) => this.cmd({ type: 'move', ids: [u.id], x, y, queue: i > 0 }));
    if (peace) {
      // one tour of the middle during the grace; the base lookouts come after it
      this.scoutAt = Math.max(w.tick + TPS * 150, this.peaceUntil);
    } else {
      this.scoutsSent++;
      this.scoutAt = w.tick + Math.round((TPS * 240) / (1 + this.war.scouts * 0.5));
    }
  }

  /** Centres of the enemy bases: every enemy's start and the construction yards we know of (an MCV that moved). Cached per tick. */
  private enemyBaseCentres(): number[] {
    const c = this.baseCache;
    const w = this.world;
    if (c.tick === w.tick) return c.pts;
    c.tick = w.tick;
    c.pts.length = 0;
    for (const p of w.players) if (p.id !== this.pid && !p.defeated && w.isEnemy(this.pid, p.id)) c.pts.push(p.startX + 0.5, p.startY + 0.5);
    for (const e of w.list) {
      if (e.dead || e.kind !== 'building' || !w.isEnemy(this.pid, e.owner) || buildingDef(e.def).role !== 'conyard') continue;
      if (this.knowsBuilding(e)) c.pts.push(e.x, e.y);
    }
    return c.pts;
  }

  /** Is a point within `r` tiles of an enemy base? */
  private nearEnemyBase(x: number, y: number, r: number): boolean {
    const pts = this.enemyBaseCentres();
    for (let i = 0; i < pts.length; i += 2) if (Math.hypot(x - pts[i], y - pts[i + 1]) <= r) return true;
    return false;
  }

  /**
   * Our harvesters never work the ore fields of an enemy base (its home fields lie inside it). One that picked
   * such a field (its own fields mined out, say) is sent to the nearest ore outside every enemy base instead,
   * or home when there is none.
   */
  private manageHarvesters(units: Entity[]) {
    const w = this.world;
    const { map } = w;
    for (const u of units) {
      if (!unitDef(u.def).harvester || u.order.type !== 'harvest' || u.oreTile < 0) continue;
      if (u.hstate !== 'toOre' && u.hstate !== 'mining') continue;
      const ox = u.oreTile % map.w;
      const oy = (u.oreTile - ox) / map.w;
      if (!this.nearEnemyBase(ox + 0.5, oy + 0.5, HARVEST_KEEP_OUT)) continue;
      let best = -1;
      let bd = Infinity;
      for (let t = 0; t < map.ore.length; t++) {
        if (map.ore[t] <= 0) continue;
        const x = t % map.w;
        const y = (t - x) / map.w;
        const d = Math.hypot(x + 0.5 - u.x, y + 0.5 - u.y);
        if (d >= bd || !w.pf.passable(x, y) || w.region[t] !== w.mainland || this.nearEnemyBase(x + 0.5, y + 0.5, HARVEST_KEEP_OUT)) continue;
        bd = d;
        best = t;
      }
      if (best >= 0) this.cmd({ type: 'harvest', ids: [u.id], x: (best % map.w) + 0.5, y: Math.floor(best / map.w) + 0.5 });
      else {
        const [hx, hy] = this.home();
        this.cmd({ type: 'move', ids: [u.id], x: hx, y: hy });
      }
    }
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
    // a map that lists neither: the chokepoints found from its passability (scanned over a few thinks)
    if (!out.length && !w.map.bridges.length && !w.map.lanes?.length) {
      this.scanChokes();
      for (const c of this.chokes ?? []) out.push(c);
    }
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
    const p = this.world.nearestPassable(x, y, 4, this.world.mainland);
    return p ? [p[0] + 0.5, p[1] + 0.5] : [x, y];
  }

  /** Choke-point control: keep a picket on the bridge nearest home. */
  private manageChoke(force: Entity[]) {
    if (this.thinks % 3 !== 0 || (this.lastWave === 0 && this.world.tick < TPS * 240)) return;
    const lanes = this.lanes();
    const candidateCrossings = lanes.length ? lanes : this.world.map.bridges.map((b) => ({ x: b.x, y: b.y }));
    if (!candidateCrossings.length) return;
    const [hx, hy] = this.home();
    const bridge = candidateCrossings.reduce((b, l) => (Math.hypot(l.x - hx, l.y - hy) < Math.hypot(b.x - hx, b.y - hy) ? l : b), candidateCrossings[0]);
    const [bx, by] = this.bank(bridge, 4);
    const [px, py] = this.highSpot(bx, by, 2);
    const picket = force.filter((u) => this.roleOf(u) === 'choke');
    // an outpost, not a last stand: spot the enemy wave, then fall back to the main body
    let near = 0;
    let close = 0;
    for (const [, it] of this.known((it) => !it.building, TPS * 3)) {
      const d = Math.hypot(it.x - px, it.y - py);
      if (d < 10) near++;
      if (d < 5.5) close++;
    }
    // an ambush: hold fire while scouts and raiders walk in, open up together once they are close (or shoot first)
    if (picket.length && this.cfg.micro >= 2) {
      const sprung = close > 0 || picket.some((u) => this.world.tick - u.lastHurt < TPS * 2);
      this.stance(picket.map((u) => u.id), sprung ? 'guard' : 'holdFire');
    }
    if (near >= 4 && picket.length) {
      const ids = picket.map((u) => u.id);
      this.stance(ids, 'guard');
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

  /**
   * Hold the chokepoint when defending: a sizeable enemy group seen closing on a crossing (bridge, pass) near home
   * meets the army at the rally point waiting in ambush on the best ground on our side of it - holding fire until
   * the enemy is close (or shoots), then all together. Intel only; never during the grace; ends after 45 s.
   */
  private manageAmbush(force: Entity[]) {
    const w = this.world;
    const amb = force.filter((u) => this.roleOf(u) === 'ambush');
    if (amb.length) {
      const ids = amb.map((u) => u.id);
      if (w.tick > this.ambushUntil) {
        this.setRole(ids, 'army');
        this.stance(ids, 'guard');
        return;
      }
      const c = this.ambushAt;
      let close = false;
      for (const [, it] of this.known((it) => !it.building, TPS * 2)) if (Math.hypot(it.x - c[0], it.y - c[1]) < 6) close = true;
      const sprung = close || amb.some((u) => w.tick - u.lastHurt < TPS * 2);
      this.stance(ids, sprung ? 'guard' : 'holdFire');
      if (sprung) this.ambushUntil = Math.max(this.ambushUntil, w.tick + TPS * 15);
      return;
    }
    if (this.peace || this.staged || this.thinks % 2 !== 0) return;
    const [hx, hy] = this.home();
    const enemies = this.known((it) => !it.building && klass(it.def) === 'main' && !unitDef(it.def).air, TPS * 5);
    if (enemies.length < 5) return;
    let best: { x: number; y: number } | null = null;
    let bn = 0;
    const enemy = this.enemyBase();
    if (!enemy) return;
    // crossings on our half of the way (map-size independent)
    const reach = Math.hypot(enemy[0] - hx, enemy[1] - hy) * 0.55;
    for (const l of this.lanes()) {
      const dl = Math.hypot(l.x - hx, l.y - hy);
      if (dl > reach) continue;
      let n = 0;
      // closing in from the far side
      for (const [, it] of enemies) if (Math.hypot(it.x - l.x, it.y - l.y) < 16 && Math.hypot(it.x - hx, it.y - hy) > dl) n++;
      if (n > bn) {
        bn = n;
        best = l;
      }
    }
    if (!best || bn < 5) return;
    const [rx, ry] = this.rally();
    const cands = force.filter((u) => this.roleOf(u) === 'army' && u.order.type === 'idle' && klass(u.def) === 'main' && !unitDef(u.def).air && Math.hypot(u.x - rx, u.y - ry) < 8);
    if (cands.length < Math.ceil(bn * 0.8)) return;
    const [bx, by] = this.bank(best, 5);
    this.ambushAt = this.highSpot(bx, by, 3);
    const ids = cands.map((u) => u.id);
    this.setRole(ids, 'ambush');
    this.stance(ids, 'holdFire');
    this.cmd({ type: 'move', ids, x: this.ambushAt[0], y: this.ambushAt[1] });
    this.ambushUntil = w.tick + TPS * 45;
    this.stats.ambushes++;
  }

  // ------------------------------------------------------------------ terrain use (AI2)

  /**
   * The posts this map offers on our side (found once, from the map alone): the summit plateau - the highest ground
   * a vehicle can reach on our half, if it stands well above the plain (Wadi Al-Rimal's Jebel, by its summit track) -
   * and, on maps with a coloured canyon on our half, a spot on the walls above each of its mouths that soldiers can
   * reach (foot passability and slope rules: sim/slope.ts).
   */
  private findPosts(): { key: string; x: number; y: number; ambush: boolean }[] {
    const w = this.world;
    const { map } = w;
    const enemy = this.enemyBase();
    if (!enemy) return [];
    const [hx, hy] = this.home();
    const out: { key: string; x: number; y: number; ambush: boolean }[] = [];
    // the summit plateau
    let top = -Infinity;
    let tx = -1;
    let ty = -1;
    for (let y = 0; y < map.h; y++)
      for (let x = 0; x < map.w; x++) {
        if (!w.pf.passable(x, y) || w.region[y * map.w + x] !== w.mainland) continue;
        const dh = Math.hypot(x + 0.5 - hx, y + 0.5 - hy);
        if (dh < 14 || dh > Math.hypot(x + 0.5 - enemy[0], y + 0.5 - enemy[1]) * 0.85) continue;
        const h = groundHeight(map, x + 0.5, y + 0.5);
        if (h > top) {
          top = h;
          tx = x;
          ty = y;
        }
      }
    if (tx >= 0 && top - Math.max(groundHeight(map, hx, hy), WATER_LEVEL) >= 1.2) {
      // the middle of the level ground up there, not its edge
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let y = ty - 5; y <= ty + 5; y++)
        for (let x = tx - 5; x <= tx + 5; x++) {
          if (x < 0 || y < 0 || x >= map.w || y >= map.h || !w.pf.passable(x, y) || w.region[y * map.w + x] !== w.mainland) continue;
          if (groundHeight(map, x + 0.5, y + 0.5) < top - 0.35) continue;
          sx += x + 0.5;
          sy += y + 0.5;
          n++;
        }
      const p = w.nearestPassable(sx / n, sy / n, 4, w.mainland);
      if (p) out.push({ key: 'plateau', x: p[0] + 0.5, y: p[1] + 0.5, ambush: false });
    }
    // the canyon mouths
    const foot = w.pfs[Loco.Foot];
    const fReg = w.regions[Loco.Foot];
    const fMain = w.mainlands[Loco.Foot];
    (map.deco?.canyons ?? []).forEach((c, ci) => {
      if (c.pts.length < 2) return;
      const mid = c.pts[c.pts.length >> 1];
      if (Math.hypot(mid.x - hx, mid.y - hy) > Math.hypot(mid.x - enemy[0], mid.y - enemy[1])) return;
      for (const [k, m] of [c.pts[0], c.pts[c.pts.length - 1]].entries()) {
        const mx = m.x + 0.5;
        const my = m.y + 0.5;
        const floor = groundHeight(map, mx, my);
        let best: [number, number] | null = null;
        let bs = -Infinity;
        for (let oy = -5; oy <= 5; oy++)
          for (let ox = -5; ox <= 5; ox++) {
            const x = Math.floor(mx) + ox;
            const y = Math.floor(my) + oy;
            if (x < 0 || y < 0 || x >= map.w || y >= map.h || !foot.passable(x, y) || fReg[y * map.w + x] !== fMain) continue;
            const d = Math.hypot(x + 0.5 - mx, y + 0.5 - my);
            if (d > 5.5 || d < 1.5) continue;
            // up on the wall above the mouth, looking down on the floor
            const s = (groundHeight(map, x + 0.5, y + 0.5) - floor) * 2 - d * 0.3;
            if (s > bs) {
              bs = s;
              best = [x + 0.5, y + 0.5];
            }
          }
        if (best) out.push({ key: `canyon${ci}.${k}`, x: best[0], y: best[1], ambush: true });
      }
    });
    return out;
  }

  /**
   * Terrain use on any map with such features (AI2): town houses garrisoned on the enemy's routes, ambush squads on
   * the walls over our canyon's mouths, a detachment (with AA) holding and contesting the summit plateau. Not before
   * the first wave has gone (or two minutes after the grace), so the first attack keeps its strength and timing.
   */
  private manageTerrain(force: Entity[]) {
    const w = this.world;
    const T = TERRAIN[this.difficulty];
    if (this.stats.firstWave < 0 && w.tick < Math.max(this.peaceUntil + TPS * 120, TPS * 240)) return;
    this.postSpots ??= this.findPosts();
    if (this.thinks % 30 === 0) for (const [id] of this.posts) if (!w.get(id)) this.posts.delete(id);
    // soldiers who found their house taken (or destroyed) rejoin the army
    const lost = force.filter((u) => this.roleOf(u) === 'post' && this.posts.get(u.id) === 'house' && u.order.type === 'idle').map((u) => u.id);
    if (lost.length) this.setRole(lost, 'army');
    // the posts take at most a fifth of the army (held houses count three soldiers each)
    let posted = 0;
    for (const u of force) if (this.roleOf(u) === 'post') posted++;
    for (const e of w.list) if (!e.dead && e.kind === 'building' && e.owner === this.pid && buildingDef(e.def).garrison) posted += 3;
    this.postBudget = Math.floor(force.length * 0.2) - posted;
    if (this.postBudget < 2) return;
    if (T.houses) this.manageHouses(force, T.houses);
    for (const p of this.postSpots) {
      if (p.key === 'plateau') {
        if (T.plateau) this.holdPost(force, p, T.plateau, T.plateauAA);
      } else if (T.canyon) this.holdPost(force, p, T.canyon, false);
    }
  }

  /** Keep a post manned: idle army units from the rally point (infantry / AT for an ambush, AA with the plateau's). */
  private holdPost(force: Entity[], p: { key: string; x: number; y: number; ambush: boolean }, want: number, aa: boolean) {
    const w = this.world;
    const mem = force.filter((u) => this.roleOf(u) === 'post' && this.posts.get(u.id) === p.key);
    // contested: enemies seen on the post - send more (a few times a game at most, so the posts never bleed the army)
    let foes = 0;
    for (const [, it] of this.known((it) => !it.building && klass(it.def) !== 'none', TPS * 4)) if (Math.hypot(it.x - p.x, it.y - p.y) < 7) foes++;
    const need = Math.min(this.postBudget, Math.max(want, p.ambush ? 0 : Math.min(want + 3, foes + 1)) - mem.length);
    const sent = this.postSent.get(p.key) ?? 0;
    if (need > 0 && sent < 4 && w.tick >= (this.postNext.get(p.key) ?? 0)) {
      const [rx, ry] = this.rally();
      const pool = force.filter((u) => this.roleOf(u) === 'army' && u.order.type === 'idle' && !unitDef(u.def).air && Math.hypot(u.x - rx, u.y - ry) < 14);
      const vsHeavy = (u: Entity) => this.firepower(u.def, { infantry: 0, light: 0, heavy: 1, building: 0, aircraft: 0 });
      let cands = pool.filter((u) => klass(u.def) === 'main' && (!p.ambush || (DEFS[u.def].category === 'infantry' && canGarrisonUnit(u.def))));
      // ambushers: anti-tank soldiers first
      cands.sort((a, b) => (p.ambush ? vsHeavy(b) - vsHeavy(a) : 0) || Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y) || a.id - b.id);
      cands = cands.slice(0, need);
      if (aa && !mem.some((u) => klass(u.def) === 'aa' || hitsAir(unitDef(u.def)))) {
        const g = pool.find((u) => klass(u.def) === 'aa') ?? pool.find((u) => klass(u.def) === 'main' && hitsAir(unitDef(u.def)) && !cands.includes(u));
        if (g) cands.push(g);
      }
      if (cands.length && (mem.length > 0 || cands.length >= Math.min(2, need))) {
        const ids = cands.map((u) => u.id);
        this.setRole(ids, 'post');
        this.postBudget -= ids.length;
        for (const id of ids) this.posts.set(id, p.key);
        this.stance(ids, p.ambush ? 'holdFire' : 'guard');
        this.cmd({ type: 'move', ids, x: p.x, y: p.y, attackMove: !p.ambush });
        this.postNext.set(p.key, w.tick + TPS * 90);
        this.postSent.set(p.key, sent + 1);
        if (p.ambush) this.terrainStats.canyon++;
        else this.terrainStats.plateau++;
      }
    }
    if (!mem.length) return;
    if (p.ambush) {
      // hold fire while the enemy walks in, open up together once it is close (or shoots)
      let close = false;
      for (const [, it] of this.known((it) => !it.building, TPS * 2)) if (Math.hypot(it.x - p.x, it.y - p.y) < 6) close = true;
      const sprung = close || mem.some((u) => w.tick - u.lastHurt < TPS * 2);
      this.stance(mem.map((u) => u.id), sprung ? 'guard' : 'holdFire');
    }
    for (const u of mem) if (Math.hypot(u.x - p.x, u.y - p.y) < 3.5 && !this.plateauSeen.has(u.id) && p.key === 'plateau') {
      this.plateauSeen.add(u.id);
      this.terrainStats.plateauVisits++;
    }
    const away = mem.filter((u) => u.order.type === 'idle' && u.targetId < 0 && Math.hypot(u.x - p.x, u.y - p.y) > 4).map((u) => u.id);
    if (away.length) this.cmd({ type: 'move', ids: away, x: p.x, y: p.y });
  }

  /**
   * Town houses on the enemy's routes (garrison.ts): soldiers move into the best empty house on our side of the map
   * close to a route the enemy uses (a lane's approach) - near our base or a contested point - up to the
   * difficulty's number of held houses.
   */
  private manageHouses(force: Entity[], want: number) {
    const w = this.world;
    if (w.tick < this.houseNext) return;
    const enemy = this.enemyBase();
    if (!enemy) return;
    const [hx, hy] = this.home();
    let held = 0;
    for (const e of w.list) if (!e.dead && e.kind === 'building' && e.owner === this.pid && buildingDef(e.def).garrison) held++;
    if (held >= want || this.terrainStats.garrisons >= want * 2) return;
    // routes: home -> lane -> enemy base for every lane, and the straight way
    const segs: number[][] = [[hx, hy, enemy[0], enemy[1]]];
    for (const l of this.lanes()) segs.push([hx, hy, l.x, l.y], [l.x, l.y, enemy[0], enemy[1]]);
    let best: Entity | null = null;
    let bs = Infinity;
    for (const h of w.list) {
      if (h.dead || h.kind !== 'building' || h.owner >= 0 || !buildingDef(h.def).garrison || garrisonRoom(w, h, this.pid) < 2) continue;
      const dh = Math.hypot(h.x - hx, h.y - hy);
      if (dh > Math.hypot(enemy[0] - hx, enemy[1] - hy) * 0.4) continue;
      let r = Infinity;
      for (const [x0, y0, x1, y1] of segs) r = Math.min(r, segDist(h.x, h.y, x0, y0, x1, y1));
      if (r > 7) continue;
      const s = r + dh * 0.08;
      if (s < bs) {
        bs = s;
        best = h;
      }
    }
    if (!best) return;
    const room = Math.min(garrisonRoom(w, best, this.pid), this.difficulty === 'hard' ? 4 : 3, this.postBudget);
    const [rx, ry] = this.rally();
    const vsHeavy = (u: Entity) => this.firepower(u.def, { infantry: 0, light: 0, heavy: 1, building: 0, aircraft: 0 });
    const b = best;
    const inf = force
      .filter((u) => this.roleOf(u) === 'army' && u.order.type === 'idle' && canGarrisonUnit(u.def) && Math.hypot(u.x - rx, u.y - ry) < 14)
      .sort((p, q) => vsHeavy(q) - vsHeavy(p) || Math.hypot(p.x - b.x, p.y - b.y) - Math.hypot(q.x - b.x, q.y - b.y) || p.id - q.id)
      .slice(0, room);
    if (inf.length < 2) return;
    const ids = inf.map((u) => u.id);
    this.setRole(ids, 'post');
    this.postBudget -= ids.length;
    for (const id of ids) this.posts.set(id, 'house');
    this.cmd({ type: 'enter', ids, target: best.id });
    this.houseNext = w.tick + TPS * 90;
    this.terrainStats.garrisons++;
  }

  /** Harvester raids by fast units (and drones), on aggressive stance; they come home when the prey is gone. */
  private manageRaids(force: Entity[]) {
    const w = this.world;
    const raiders = force.filter((u) => this.roleOf(u) === 'raid');
    if (this.raid && (!raiders.length || raiders.every((u) => u.order.type === 'idle'))) {
      // raid over: a target that cost us half the raiders and still lives was well defended - look elsewhere
      const r = this.raid;
      this.raid = null;
      const alive = r.ids.filter((id) => w.get(id)).length;
      if (alive * 2 <= r.ids.length && w.get(r.prey)) this.avoid.push({ x: r.x, y: r.y, until: w.tick + TPS * 300 });
    }
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
    this.raidAt = w.tick + Math.round((TPS * 120) / (this.doctrine.harass * this.planCfg.raids * this.raidPace) + this.rng.range(-15, 15) * TPS);
    const [rx, ry] = this.rally();
    let fast = force.filter((u) => {
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
      if (threat <= 10 && sc < ps && !this.avoid.some((a) => a.until > w.tick && Math.hypot(a.x - it.x, a.y - it.y) < 10)) {
        ps = sc;
        prey = id;
      }
    }
    // no harvester in reach: economy-raiding doctrines go for a lightly defended refinery or power plant (supply)
    if (prey < 0 && this.war.econ > 0)
      for (const [id, it] of this.known((it) => it.building && ['refinery', 'power'].includes(buildingDef(it.def).role))) {
        const sc = this.threatAt(it.x, it.y, 7) + Math.hypot(it.x - rx, it.y - ry) * 0.05;
        if (sc - Math.hypot(it.x - rx, it.y - ry) * 0.05 <= 6 && sc < ps) {
          ps = sc;
          prey = id;
        }
      }
    if (prey < 0) return;
    const preyEnt = w.get(prey);
    const riverSevered = w.map.bridges.length > 0 && this.lanes().length === 0;
    if (riverSevered && preyEnt) {
      const [hx, hy] = this.home();
      const myBank = (hx - w.map.w / 2) - (hy - w.map.h / 2) < 0 ? 0 : 1;
      const preyBank = (preyEnt.x - w.map.w / 2) - (preyEnt.y - w.map.h / 2) < 0 ? 0 : 1;
      if (myBank !== preyBank) {
        fast = fast.filter((u) => unitDef(u.def).air);
        if (fast.length < 2) return;
      }
    }
    fast.sort((a, b) => unitDef(b.def).speed - unitDef(a.def).speed || a.id - b.id);
    const ids = fast.slice(0, Math.round((2 + this.rng.int(3)) * this.war.raid)).map((u) => u.id);
    this.setRole(ids, 'raid');
    this.stance(ids, 'aggressive');
    this.raidStart = w.tick;
    const pi = this.intel.get(prey)!;
    this.raid = { ids, prey, x: pi.x, y: pi.y };
    this.avoid = this.avoid.filter((a) => a.until > w.tick);
    // approach along a flank lane when there is one
    const lane = this.pickLane(true)?.pos;
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
    const hunt = this.huntAA();
    for (const [id, it] of this.known((it) => !it.building || buildingDef(it.def).category !== 'defense', TPS * 20)) {
      if (this.peace && !this.defensible(it.x, it.y)) continue;
      const d = DEFS[it.def];
      const aaMark = hunt && klass(it.def) === 'aa' && !it.building;
      let value = it.building ? 3 : d.kind === 'unit' && d.harvester ? 7 : klass(it.def) === 'arty' || klass(it.def) === 'strike' ? 8 : klass(it.def) === 'aa' ? (aaMark ? 10 : -10) : 4;
      if (it.building && this.doctrine.deep.includes(buildingDef(it.def).role)) value += 3;
      value += this.hvtRank(it.def, it.building) * 1.5;
      const s = value * 3 - this.threatAt(it.x, it.y, 8, true) * (aaMark ? 2 : 4) - Math.hypot(it.x - c.x, it.y - c.y) * 0.05;
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

  private laneKey(l: { x: number; y: number }) {
    return `${Math.round(l.x)},${Math.round(l.y)}`;
  }

  /**
   * Lane (bridge, pass) to approach by: the front is where the enemy is strongest; a flank avoids it. Lanes where
   * a wave was lost for little in return weigh against (lane memory); `not` excludes one (a feint's lane).
   */
  private pickLane(flank: boolean, not = ''): { pos: [number, number]; far: [number, number]; key: string } | null {
    const lanes = this.lanes();
    if (lanes.length < 2) return null;
    const known = this.known((it) => !it.building, TPS * 40);
    const [hx, hy] = this.home();
    const enemy = this.enemyBase() ?? [this.world.map.w / 2, this.world.map.h / 2];
    let best = -1;
    let bs = Infinity;
    lanes.forEach((l, i) => {
      const key = this.laneKey(l);
      if (key === not) return;
      let presence = 0;
      for (const [, it] of known) if (Math.hypot(it.x - l.x, it.y - l.y) < 14) presence++;
      // route length via the lane
      const len = Math.hypot(l.x - hx, l.y - hy) + Math.hypot(enemy[0] - l.x, enemy[1] - l.y);
      const pen = (this.lanePenalty.get(key) ?? 0) * 10;
      const s = flank ? presence * 6 + len * 0.2 + (i === this.lastLane ? 8 : 0) + this.rng.next() * 6 + pen : len - presence * 2 + pen + this.rng.next() * 4;
      if (s < bs) {
        bs = s;
        best = i;
      }
    });
    if (best < 0) return null;
    this.lastLane = best;
    const l = lanes[best];
    return { pos: this.bank(l, 3), far: this.bank(l, -7), key: this.laneKey(l) };
  }

  /** Does what we know say the enemy army is away from its base (out on the map or pressing ours)? Intel only. */
  private enemyArmyAway(): boolean {
    const enemy = this.enemyBase();
    if (!enemy) return false;
    let home = 0;
    let away = 0;
    const t = this.world.tick;
    for (const it of this.intel.values()) {
      if (it.building || t - it.seen > TPS * 25) continue;
      const k = klass(it.def);
      if (k !== 'main' && k !== 'arty') continue;
      if (Math.hypot(it.x - enemy[0], it.y - enemy[1]) > 30) away++;
      else home++;
    }
    return away >= 5 && away >= home * 2;
  }

  /**
   * Gather at the rally point; launch waves along a lane (sometimes splitting off a flanking wing, sometimes behind
   * a feint on another lane), with AA / EW escorts. Waves leave at irregular times and sizes; the AI goes early when
   * the enemy army is seen away from its base, or by night when most of the wave has night vision.
   */
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
    // a big army does not fit within 7 tiles of the rally point
    const rr = Math.max(7, Math.sqrt(army.length) * 1.6);
    const atRally = idle.filter((u) => Math.hypot(u.x - rx, u.y - ry) < rr);
    const strays = idle.filter((u) => Math.hypot(u.x - rx, u.y - ry) >= rr && Math.hypot(u.x - hx, u.y - hy) < 22);
    if (strays.length) this.cmd({ type: 'move', ids: strays.map((u) => u.id), x: rx, y: ry });

    // AA stays home as air defence unless the enemy flies; artillery and support never count towards the wave size
    let fighters = atRally.filter((u) => klass(u.def) === 'main');
    const sinceWave = w.tick - this.lastWave;
    // early-game grace (peace.ts): mass at the rally point, launch nothing; afterwards ramp up wave by wave
    const ramp = this.peaceUntil > 0;
    const rampOk = !ramp || (!this.peace && (this.lastWave === 0 || sinceWave >= RAMP_GAP[this.difficulty]));
    const openLanes = this.lanes();
    const riverSevered = w.map.bridges.length > 0 && openLanes.length === 0;
    if (this.staged) {
      // a feint went in on another lane: the main body follows once the defence has had time to react
      const pr = this.staged.prep;
      if (pr && pr.fired < 0 && pr.guns.some((id) => { const g = w.get(id); return !!g && (g.cooldown > 0 || Math.hypot(g.x - pr.x, g.y - pr.y) < 4); })) {
        // the guns are in position and firing: the main body goes after the preparation
        pr.fired = w.tick;
        this.staged.at = Math.min(this.staged.at, w.tick + Math.round(TPS * this.war.prep));
      }
      if (w.tick >= this.staged.at) this.launchStaged(atRally, enemyAir);
    } else if (rampOk && w.tick >= this.waveNotBefore) {
      // (the first wave is never smaller than the doctrine's: no token rush with the starting units)
      let want = Math.max(this.lastWave === 0 ? 6 : 4, this.waveSize + this.waveJitter);
      const opportunity = micro > 0 && this.lastWave > 0 && fighters.length >= 4 && this.thinks % 3 === 0 && this.enemyArmyAway();
      const nightEdge = w.night && fighters.length >= 4 && fighters.filter((u) => hasNightVision(u)).length * 2 >= fighters.length;
      if (opportunity) want = Math.max(4, Math.ceil(want * 0.6));
      else if (nightEdge) want = Math.max(4, Math.ceil(want * 0.8));
      let go = fighters.length >= want || (fighters.length >= 4 && sinceWave > this.waveStale);
      // artillery-preparation doctrines (Hard) wait up to 90 s for their guns before a wave goes
      if (go && micro >= 2 && this.war.prep > 0 && this.homeGuns().length < 2 && defsForFaction(this.p.faction).some((d) => d.kind === 'unit' && d.aiWeight && klass(d.id) === 'arty' && w.canBuild(this.pid, d.id))) {
        if (this.prepWait < 0) this.prepWait = w.tick;
        if (w.tick - this.prepWait < TPS * 90) go = false;
      }
      if (go) {
        this.prepWait = -1;
        if (fighters.length >= want) {
          if (opportunity) this.stats.opportunist++;
          else if (nightEdge) this.stats.night++;
        }
        if (ramp && fighters.length > want) fighters = [...fighters].sort((a, b) => a.id - b.id).slice(0, want);
        const target = this.pickTarget();
        const tx = target ? target[0] : enemy[0];
        const ty = target ? target[1] : enemy[1];
        if (riverSevered) {
          // Every bridge across the river is destroyed: ground forces cannot cross.
          // Air units fly across to strike the enemy; ground forces secure our bridge approach and defend the engineer.
          const air = fighters.filter((u) => unitDef(u.def).air);
          const ground = fighters.filter((u) => !unitDef(u.def).air);
          if (air.length) this.cmd({ type: 'move', ids: air.map((u) => u.id), x: tx, y: ty, attackMove: true });
          if (ground.length) {
            const nearestBr = w.map.bridges.reduce((b, br) => (Math.hypot(br.x - hx, br.y - hy) < Math.hypot(b.x - hx, b.y - hy) ? br : b), w.map.bridges[0]);
            const [bx, by] = this.bank(nearestBr, 6);
            this.cmd({ type: 'move', ids: ground.map((u) => u.id), x: bx, y: by });
          }
          this.lastWave = w.tick;
          return;
        }
        // a broad front (war doctrine, Hard): the wave goes in on two lanes at once, half and half
        const broad = micro >= 2 && this.war.front >= 2 && openLanes.length >= 2 && fighters.length >= 8;
        const flank = broad || (micro > 0 && this.rng.next() < doc.flank * this.war.flank * (micro >= 2 ? 1 : 0.6));
        let body = fighters.map((u) => u.id);
        let wing: number[] = [];
        if (broad) {
          wing = [...fighters].sort((a, b) => a.id - b.id).filter((_, i) => i % 2 === 1).map((u) => u.id);
          body = body.filter((id) => !wing.includes(id));
          this.stats.broad++;
        } else if (flank && fighters.length >= 8) {
          // the fastest third (fast-flanking doctrines: two fifths) swings round a flank while the main body pins the front
          const sorted = [...fighters].sort((a, b) => unitDef(b.def).speed - unitDef(a.def).speed || a.id - b.id);
          wing = sorted.slice(0, this.war.flank >= 1.3 ? Math.floor((sorted.length * 2) / 5) : Math.floor(sorted.length / 3)).map((u) => u.id);
          body = body.filter((id) => !wing.includes(id));
        }
        const front = micro > 0 ? this.pickLane(flank && !wing.length) : null;
        const wingLane = wing.length ? this.pickLane(true, front?.key) : null;
        // feint: a few cheap fighters show themselves on another lane shortly before the main push
        const feintLane = micro > 0 && openLanes.length >= 2 && body.length >= 6 && this.rng.next() < FEINT[this.difficulty] ? this.pickLane(true, front?.key ?? '') : null;
        if (feintLane && feintLane.key !== wingLane?.key) {
          const fe = body
            .map((id) => w.get(id)!)
            .sort((a, b) => cost(a.def) - cost(b.def) || unitDef(b.def).speed - unitDef(a.def).speed || a.id - b.id)
            .slice(0, Math.min(3, Math.floor(body.length / 4)))
            .map((u) => u.id);
          body = body.filter((id) => !fe.includes(id));
          this.cmd({ type: 'move', ids: fe, x: feintLane.pos[0], y: feintLane.pos[1], attackMove: true });
          this.cmd({ type: 'move', ids: fe, x: feintLane.far[0], y: feintLane.far[1], attackMove: true, queue: true });
          this.cmd({ type: 'move', ids: fe, x: rx, y: ry, queue: true });
          this.waves.push({ ids: fe, tx: feintLane.far[0], ty: feintLane.far[1], focus: -1, born: w.tick, lane: '', value: 0, killed: 0, feint: true });
          this.staged = { ids: body, wing, lane: front?.pos ?? null, laneKey: front?.key ?? '', wingLane: wingLane?.pos ?? null, tx, ty, at: w.tick + Math.round(TPS * this.rng.range(10, 22)) };
          this.setRole([...body, ...wing], 'staged');
          this.stats.feints++;
          this.lastWave = w.tick;
        } else if (!this.prepare(tx, ty, body, wing, front)) this.launch(body, wing, front?.pos ?? null, front?.key ?? '', wingLane?.pos ?? null, tx, ty, atRally, enemyAir);
      }
    }
    // units that finished an attack-move far from home keep pushing toward the next target
    const deep = idle.filter((u) => Math.hypot(u.x - hx, u.y - hy) >= 22 && klass(u.def) !== 'arty');
    if (deep.length && this.peace) {
      // grace: defenders that chased a raider away come back to the rally point
      this.cmd({ type: 'move', ids: deep.map((u) => u.id), x: rx, y: ry });
    } else if (deep.length) {
      if (riverSevered) {
        this.cmd({ type: 'move', ids: deep.map((u) => u.id), x: rx, y: ry });
      } else {
        const target = this.pickTarget(deep[0]);
        const [tx, ty] = target ?? enemy;
        this.cmd({ type: 'move', ids: deep.map((u) => u.id), x: tx, y: ty, attackMove: true });
      }
    }
  }

  /**
   * Artillery preparation (war doctrine, Hard): the guns and rocket launchers at the rally point go first and shell
   * the enemy structures we know of around the objective (defences first); the main body is held back for the
   * doctrine's preparation time, then goes (as after a feint). false when there is nothing to prepare with or on.
   */
  /** Our guns at home (artillery of the army, not out with a wave). */
  private homeGuns(): Entity[] {
    const [hx, hy] = this.home();
    return this.mineUnits.filter((u) => klass(u.def) === 'arty' && this.roleOf(u) === 'army' && u.order.type !== 'illum' && Math.hypot(u.x - hx, u.y - hy) < 25);
  }

  private prepare(tx: number, ty: number, body: number[], wing: number[], front: { pos: [number, number]; key: string } | null): boolean {
    if (this.cfg.micro < 2 || this.war.prep <= 0) return false;
    const guns = this.homeGuns();
    if (guns.length < 2) return false;
    const w = this.world;
    // structures we know of there: scouted ones, or the enemy base round its start (common knowledge: knowsBuilding)
    const marks: { id: number; s: number }[] = [];
    for (const b of w.list) {
      if (b.dead || b.kind !== 'building' || !w.isEnemy(this.pid, b.owner) || Math.hypot(b.x - tx, b.y - ty) > 16 || !this.knowsBuilding(b)) continue;
      const known = this.intel.get(b.id);
      const [x, y] = known ? [known.x, known.y] : [b.x, b.y];
      marks.push({ id: b.id, s: (buildingDef(b.def).category === 'defense' ? 0 : 6) + Math.hypot(x - tx, y - ty) * 0.2 });
    }
    marks.sort((a, b) => a.s - b.s || a.id - b.id);
    if (!marks.length) return false;
    // the firing position: within the guns' reach of the objective, on our side of it; the main body waits just behind
    let range = Infinity;
    for (const g of guns) range = Math.min(range, w.weaponRange(g, WEAPONS[unitDef(g.def).weapon!]));
    const [hx, hy] = this.home();
    const len = Math.hypot(hx - tx, hy - ty) || 1;
    const at = (k: number): [number, number] => {
      const p = w.nearestPassable(tx + ((hx - tx) / len) * k, ty + ((hy - ty) / len) * k, 5, w.mainland);
      return p ? [p[0] + 0.5, p[1] + 0.5] : [tx + ((hx - tx) / len) * k, ty + ((hy - ty) / len) * k];
    };
    const [gx, gy] = at(Math.max(4, range * 0.85));
    const [bx, by] = at(Math.max(6, range * 0.85 + 2.5));
    const gids = guns.map((u) => u.id);
    this.cmd({ type: 'move', ids: gids, x: gx, y: gy });
    guns.forEach((u, i) => this.cmd({ type: 'attack', ids: [u.id], target: marks[i % Math.min(marks.length, 3)].id, queue: true }));
    this.send([...body, ...wing], front?.pos ?? null, bx, by);
    // (released by the guns opening fire plus the preparation time, or after two minutes whatever happens)
    this.staged = { ids: body, wing, lane: null, laneKey: front?.key ?? '', wingLane: null, tx, ty, at: w.tick + TPS * 120, prep: { guns: gids, x: gx, y: gy, fired: -1 } };
    this.setRole([...body, ...wing], 'staged');
    this.stats.preps++;
    this.lastWave = w.tick;
    return true;
  }

  /** The held main body goes now (those still alive and not pulled into the base's defence). */
  private launchStaged(atRally: Entity[], enemyAir: number) {
    const s = this.staged!;
    this.staged = null;
    const ok = (id: number) => {
      const u = this.world.get(id);
      return !!u && this.roleOf(u) === 'staged';
    };
    const body = s.ids.filter(ok);
    const wing = s.wing.filter(ok);
    this.setRole([...s.ids, ...s.wing], 'army');
    if (body.length + wing.length === 0) return;
    // (after a preparation the body is already up front: straight at the objective)
    this.launch(body, wing, s.prep ? null : s.lane, s.laneKey, s.prep ? null : s.wingLane, s.tx, s.ty, atRally, enemyAir);
  }

  private launch(body: number[], wing: number[], lane: [number, number] | null, laneKey: string, wingLane: [number, number] | null, tx: number, ty: number, atRally: Entity[], enemyAir: number) {
    const w = this.world;
    this.send(body, lane, tx, ty);
    if (wing.length) this.send(wing, wingLane, tx, ty);
    // escorts: AA when the enemy flies, EW / recovery vehicles always
    const leader = [...body, ...wing]
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
    if (this.peaceUntil > 0) arty = arty.slice(0, Math.max(1, Math.ceil(body.length / 4)));
    const ids = [...body, ...wing, ...arty];
    let value = 0;
    for (const id of ids) value += cost(w.get(id)?.def ?? '');
    this.waves.push({ ids, tx, ty, focus: -1, born: w.tick, lane: laneKey, value, killed: 0 });
    while (this.waves.length > 4) this.judgeWave(this.waves.shift()!);
    this.lastWave = w.tick;
    if (this.stats.firstWave < 0) this.stats.firstWave = w.tick;
    this.stats.waves++;
    this.stats.lanes.push(laneKey);
    for (const [k, v] of this.lanePenalty) this.lanePenalty.set(k, v * 0.7);
    this.waveSize = Math.min(this.cfg.maxWave, this.waveSize + this.cfg.waveGrowth);
    // the doctrine's wave size from the second wave on (the first one keeps the old size: no earlier first attack)
    if (this.stats.waves === 1 && this.war.wave !== 1) this.waveSize = Math.min(this.cfg.maxWave, Math.max(4, Math.round(this.waveSize * this.war.wave)));
    // irregular timing: no metronome, no fixed size
    this.waveJitter = this.rng.int(4) - 1;
    this.waveNotBefore = w.tick + Math.round(TPS * this.rng.range(0, 40));
    this.waveStale = Math.round(TPS * this.rng.range(180, 300) * this.planCfg.stale * this.war.pace);
  }

  /**
   * Lane / outcome memory: a wave that lost most of its value for little seen in return marks its lane, makes
   * the next wave bigger and the production lean harder on counters for a while; repeated bad trades switch plan.
   */
  private judgeWave(wv: Wave) {
    if (wv.feint || wv.value <= 0) return;
    const w = this.world;
    let alive = 0;
    for (const id of wv.ids) alive += cost(w.get(id)?.def ?? '');
    const lost = wv.value - alive;
    wv.value = 0; // judged once
    if (lost > (lost + alive) * 0.6 && wv.killed < lost * 0.6) {
      this.stats.badTrades++;
      if (wv.lane) this.lanePenalty.set(wv.lane, (this.lanePenalty.get(wv.lane) ?? 0) + 1);
      this.waveSize = Math.min(this.cfg.maxWave, this.waveSize + 2);
      this.adaptBoost = 0.6;
      this.adaptBoostUntil = w.tick + TPS * 240;
      this.planBad++;
      this.maybeSwitchPlan();
    } else if (wv.killed > lost) this.planBad = Math.max(0, this.planBad - 1);
  }

  /** Retire waves: judge each once, when it is wiped out or after its fight (150 s); forget the wiped out. */
  private retireWaves() {
    const w = this.world;
    for (const wv of this.waves) if (wv.value > 0 && (w.tick - wv.born > TPS * 150 || !wv.ids.some((id) => w.get(id)))) this.judgeWave(wv);
    this.waves = this.waves.filter((wv) => wv.ids.some((id) => w.get(id)));
  }

  /** The plan is failing (waves keep trading badly): pick another one the arsenal supports (not on Easy). */
  private maybeSwitchPlan() {
    const w = this.world;
    if (this.cfg.micro === 0 || this.planBad < 2 || w.tick - this.planSince < TPS * 300) return;
    const next = pickPlan(this.rng, planWeights(this.p.faction, this.doctrine, this.difficulty), this.plan);
    if (next === this.plan) return;
    const old = this.planCfg;
    this.plan = next;
    this.planCfg = PLAN_CFG[next];
    this.planLog.push(next);
    this.planSince = w.tick;
    this.planBad = 0;
    this.buildOrder = buildOrderFor(this.rng, next);
    this.buildOrder = warOrder(this.buildOrder, this.war);
    this.waveSize = Math.min(this.cfg.maxWave, Math.max(4, Math.round((this.waveSize * this.planCfg.wave) / old.wave)));
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
        // the war doctrine: its targets, the enemy economy and base (missile and drone doctrines)
        s += this.hvtRank(o.def, o.kind === 'building');
        if (this.war.econ && (o.kind === 'building' ? ['refinery', 'power', 'conyard'].includes(buildingDef(o.def).role) : !!unitDef(o.def).harvester)) s += this.war.econ * 3;
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
      if (Math.hypot(u.x - sx, u.y - sy) > 3) {
        // the guns take the high ground near their standoff point
        const [gx, gy] = this.highSpot(sx, sy, 2);
        this.cmd({ type: 'move', ids: [u.id], x: gx, y: gy });
      }
    }
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
      if (!d.crusher || !d.weapon || u.stance === 'hold' || this.roleOf(u) === 'retreat' || this.roleOf(u) === 'fallback') continue;
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
    const [hx, hy] = this.home();
    const enemy = this.enemyBase();
    for (const [, it] of this.known(() => true, TPS * 15)) {
      // units are worth a wave's trip when they press our base or stand in theirs; ones roaming the middle get
      // fought on the way (attack-move), else every wave just trades with the other side's in the open middle
      // of a map with no river between the bases (desert) and nobody ever reaches a base
      // (an outpost - a captured derrick or tech site, a forward gun - is worth less than the base itself)
      const away = Math.hypot(it.x - hx, it.y - hy) > 20 && (!enemy || Math.hypot(it.x - enemy[0], it.y - enemy[1]) > 20);
      let d = Math.hypot(it.x - ox, it.y - oy) + (it.building ? (away ? 40 : 0) : away ? 100 : 15);
      if (it.building) {
        const k = deep.indexOf(buildingDef(it.def).role);
        if (k >= 0 && this.cfg.micro > 0) d -= 6 - k * 1.5;
      }
      if (d < bd) {
        bd = d;
        best = [it.x, it.y];
      }
    }
    if (!best && enemy) best = [enemy[0], enemy[1]];
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
