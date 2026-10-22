import { DEFS, FACTION_INFO, VERSUS, WEAPONS, buildingDef, factionDefByRole, factionUnit, munitionDef, unitDef } from './defs';
import {
  ORE_MAX,
  Tile,
  standHeight,
  terrainBuildable,
  tileOpen,
  terrainPassable,
  type GameMap,
  type MapId,
} from './map';
import { createMap } from './maps';
import { entityZ, launch, stepProjectiles, tryIntercept } from './ballistics';
import { AIRDROP_COOLDOWN, AIRDROP_FIRST, AIRDROP_GAP, AIRDROP_STICK, CHUTE_TICKS, CRATE_CHUTE_TICKS, CRATE_HEAL, CRATE_LIFE, CRATE_RADIUS, descentHeight } from './airdrop';
import { PathFinder } from './path';
import { LOCO_ALL, LOCO_COUNT, Loco, dirOf, groundRegions, locoOf, slopeField, type SlopeField } from './slope';
import { diverSpeed, swimBlock } from './diver';
import { canFireNow, canHurtSubmerged, holdsWhenBlocked, spottedWhenSubmerged, updateSubmerged } from './submerge';
import { SHIP_BUILD_RADIUS, SHIP_YARD_REACH, arriveLanding, deepYard, callCraft, cargoSize, deliverNaval, isCarrier, navalTerrain, orderUnload, shipSite, shipSpots, stepEmbark, updateNaval, type NavalTerrain, type ShipSite } from './naval';
import { canGarrisonUnit, ejectAll, enterGarrison, garrisonHit, garrisonOf, garrisonRangeBonus, garrisonRoom, isGarrison, spawnGarrisons, updateGarrisons, GARRISON_FIREPOWER } from './garrison';
import { spawnTechSites, updateTechs } from './capture';
import { fireSuperweapon, newSuperweaponState, updateSuperweapons } from './superweapons';
import { bridgeHutEnter, bridgeProof, canHurtBridge, initBridges, isBridge, updateBridges, type BridgeState } from './bridges';
import { DEFAULT_STANCE, applyOrderCommand, autoFire, idleReturn, leashRange, ordersIdle, queueCap, scanRange } from './orders';
import { ELITE, ELITE_HEAL, RANK_ARMOR, RANK_FIREPOWER, RANK_ROF, canRank, rankFor, xpValue } from './veterancy';
import { Rng } from './rng';
import { carrierWithPad, deckCap, isSortieJet, jetCount, jetGrounded, jetsQueued, padCap, parkJet, updateSortie, freePad } from './airbase';
import { crushContact, stepDodge, updateCrush, wantsCrush } from './crush';
import { releaseDefender, setAutoDefend, updateBaseDefense } from './basedefense';
import { aimOrder, aimSees, aimStep, aimTargetScore, aimUpkeep, cancelAim } from './sniper';
import { evades, lowObsFactor, rangeVs } from './stealth';
import { bigBlast, canWound, forgetWounded, orderTreat, releasePatient, treatable, updateMedic, updateWounded, woundUnit } from './medic';
import { heliGrounded, isHeli, orderLand, updateHeli } from './helipad';
import { harvesterHit, hvPriority, orderHarvest, updateHarvester } from './harvest';
import { layoutTile, northStart, turnable } from './turn';
import { DAY_CLOCK, isNight, nightLevel, nightSight, simHours, type SimClock } from './clock';
import { FLARE_RADIUS, FLOOD_RADIUS, flareLit, flashLit, floodCentre, floodlit, hasNightVision, muzzleFlash, orderIllum, pickIllum, stepIllum, updateFlares } from './night';
import {
  CATEGORIES,
  TPS,
  type BuildingDef,
  type Category,
  type Command,
  type Def,
  type Entity,
  type Faction,
  type Flare,
  type FogMode,
  type Player,
  type Projectile,
  type SimEvent,
  type UnitDef,
  type WeaponDef,
} from './types';

export interface PlayerSetup {
  name: string;
  faction: Faction;
  color: number;
  isAI: boolean;
  /** Automatic base defence for this player (basedefense.ts; default off in the sim, the game passes the setting). */
  autoDefend?: boolean;
}

export interface WorldOptions {
  players: PlayerSetup[];
  seed?: number;
  credits?: number;
  /** Which map (default Frontline Crossing); the seed varies its details (sim/maps.ts). */
  map?: MapId;
  /**
   * The match's day clock (sim/clock.ts; the game passes the one the sky shows: render/atmos.ts simClockOf).
   * Default: a fixed afternoon (DAY_CLOCK).
   */
  clock?: SimClock;
  /**
   * Tests only: force a fog rule whatever the hour. Default: automatic (types.ts FogMode), classic by day and
   * the night fog by night; there is no player choice.
   */
  fog?: FogMode;
  /**
   * Wounded soldiers (medic.ts): off in the game (the owner's call: a soldier brought to 0 HP dies, medics
   * heal the hurt on their feet). Tests only switch it on to keep the dormant mechanic covered.
   */
  wounds?: boolean;
}

export interface Controller {
  update(): void;
}

const BUILD_RADIUS = 5;
const SPATIAL_CELL = 4;
/** Units with two weapons (UnitDef.weapon2): ticks to swap launchers before the other one can fire. */
export const WEAPON_SWAP = TPS;
/** Soldiers firing on the move (a plain move order) shoot this much slower than standing. */
export const MOVE_FIRE_ROF = 1.4;

// Precomputed offsets sorted by distance, used for formations and spiral searches.
/** Climbing slows a unit: speed / (1 + CLIMB_SLOW x grade); a vehicle at its steepest (0.53) makes some 80%. */
const CLIMB_SLOW = 0.45;
/** Ground cut off on every side by steps too steep to climb, smaller than this many tiles, is closed (World constructor). */
const POCKET = 10;
const DX8 = [1, -1, 0, 0, 1, 1, -1, -1];
const DY8 = [0, 0, 1, -1, 1, -1, 1, -1];
const SPIRAL: [number, number][] = (() => {
  const out: [number, number, number][] = [];
  for (let y = -12; y <= 12; y++) for (let x = -12; x <= 12; x++) out.push([x, y, x * x + y * y + (x + y) * 0.001]);
  out.sort((a, b) => a[2] - b[2]);
  return out.map(([x, y]) => [x, y]);
})();
const INF_SLOTS: [number, number][] = [
  [-0.22, -0.18],
  [0.22, -0.18],
  [0, 0.22],
];

const DISCS: [number, number][][] = [];
function disc(r: number) {
  if (!DISCS[r]) {
    const d: [number, number][] = [];
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + r) d.push([x, y]);
    DISCS[r] = d;
  }
  return DISCS[r];
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

export class World {
  map: GameMap;
  players: Player[] = [];
  entities = new Map<number, Entity>();
  list: Entity[] = [];
  projectiles: Projectile[] = [];
  events: SimEvent[] = [];
  tick = 0;
  rng: Rng;
  pass: Uint8Array;
  /**
   * Ground region of every tile: terrain-passable land connected by ground (0 = impassable). The bases stand in
   * `mainland`; an offshore island (Wadi Al-Rimal's lighthouse islands) is a region of its own that no ground
   * unit can reach, so move orders, spawn spots and the AI's picks keep to the region they start from.
   */
  region: Uint16Array;
  mainland = 0;
  /** The Combat Diver's slope blocks (diver.ts swimBlock): the infantry's on land, none where water is involved. */
  swimBlock: Uint8Array;
  /**
   * Per locomotion class (slope.ts Loco): ground regions over the steps that class can take, the region of
   * player 0's start, and its path finder. `region`, `mainland` and `pf` are the vehicles' (the strictest):
   * what vehicles reach, soldiers reach too.
   */
  regions: Uint16Array[];
  mainlands: number[];
  pfs: PathFinder[];
  /** Steps too steep per locomotion class, climbing costs (slope.ts; built once per map). */
  slope: SlopeField;
  /**
   * Passability per locomotion class (slope.ts Loco): the two ground classes share `pass`; the water classes
   * (naval.ts) have their own, built from the map's water and kept up to date as structures come and go.
   */
  passes: Uint8Array[];
  /** The map's water: per water class the tiles it may use with no structure on them, the open sea (naval.ts). */
  naval: NavalTerrain;
  /** Footprints (top-left tile indices) where a Shipyard could stand terrain-wise; empty on a map with no sea coast. */
  shipSpots: number[];
  occ: Int32Array;
  pf: PathFinder;
  controllers: Controller[] = [];
  winner = -1;
  over = false;
  /** Collapsible river bridges (bridges.ts). */
  bridges: BridgeState[] = [];
  /** The match's day clock (sim/clock.ts): the hour is derived from the tick. */
  readonly clock: SimClock;
  /** Forced fog rule (tests), else null: automatic by the clock. */
  private forcedFog: FogMode | null;
  /** 0 = day .. 1 = night (clock.ts nightLevel), updated at the fog cadence: scales the sight of ordinary units. */
  nightLevel = 0;
  /** The night rules apply (night fog, muzzle flashes, floodlights; night.ts), updated at the fog cadence. */
  night = false;
  /** Illumination flares in flight / burning (night.ts). */
  flares: Flare[] = [];
  /** The match seed (seeded per-event rolls that must not disturb the shared RNG stream, e.g. medic.ts wound rolls). */
  readonly seed: number;
  /** Soldiers down wounded, waiting for a medic (medic.ts): the short list medics search instead of scanning everything. */
  wounded: Entity[] = [];
  /** Soldiers may go down wounded instead of dying (WorldOptions.wounds; off in the game). */
  wounds = false;
  /** Refinery dock queue tickets handed out so far (harvest.ts). */
  hvSeq = 0;
  /** Ore fields where harvesters were attacked or saw hostiles lately, per player (harvest.ts). */
  hvHot: { owner: number; x: number; y: number; at: number; chk: number }[] = [];
  private nextId = 1;
  private pending: { player: number; cmd: Command }[] = [];
  private grid: Entity[][];
  private gridW: number;
  private gridH: number;

  constructor(opts: WorldOptions) {
    this.rng = new Rng(opts.seed ?? 12345);
    this.seed = (opts.seed ?? 12345) | 0;
    this.wounds = !!opts.wounds;
    this.clock = opts.clock && Number.isFinite(opts.clock.start) ? { start: opts.clock.start, live: !!opts.clock.live } : DAY_CLOCK;
    this.forcedFog = opts.fog === 'classic' || opts.fog === 'modern' ? opts.fog : null;
    this.updateNight();
    this.map = createMap(opts.map ?? 'frontline', opts.seed ?? 12345);
    const { w, h } = this.map;
    this.pass = new Uint8Array(w * h);
    this.occ = new Int32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) this.pass[y * w + x] = terrainPassable(this.map, x, y) ? 1 : 0;
    this.slope = slopeField(this.map);
    // scraps of level ground walled in by steps too steep even to climb (a ledge on a cliff, the foot of a crag):
    // nobody can ever reach them, so nothing is sent, dropped or pushed there either
    const foot = groundRegions(w, h, this.pass, this.slope.block[Loco.Foot]);
    const size = new Uint32Array(w * h + 1);
    for (let i = 0; i < w * h; i++) size[foot[i]]++;
    for (let i = 0; i < w * h; i++) if (foot[i] && size[foot[i]] < POCKET) this.pass[i] = 0;
    const s0 = this.map.starts[0];
    this.regions = [];
    this.mainlands = [];
    this.pfs = [];
    for (let c = 0; c < LOCO_COUNT; c++) {
      this.regions.push(groundRegions(w, h, this.pass, this.slope.block[c]));
      this.mainlands.push(this.regions[c][s0.y * w + s0.x]);
      this.pfs.push(new PathFinder(w, h, this.pass, this.slope.block[c], this.slope.climb));
    }
    // the water classes (naval.ts): no slope rule; their "mainland" is their largest body of water
    this.naval = navalTerrain(this.map);
    this.swimBlock = swimBlock(this.map, this.slope.block[Loco.Foot]);
    this.passes = [this.pass, this.pass];
    for (let c = LOCO_COUNT; c < LOCO_ALL; c++) {
      const pass = this.naval.base[c - LOCO_COUNT].slice();
      this.passes.push(pass);
      const swim = c === Loco.Swim;
      const reg = groundRegions(w, h, pass, swim ? this.swimBlock : undefined);
      this.regions.push(reg);
      const size = new Map<number, number>();
      let big = 0;
      for (let i = 0; i < w * h; i++) {
        if (!reg[i]) continue;
        const n = (size.get(reg[i]) ?? 0) + 1;
        size.set(reg[i], n);
        if (n > (size.get(big) ?? 0)) big = reg[i];
      }
      this.mainlands.push(big);
      this.pfs.push(swim ? new PathFinder(w, h, pass, this.swimBlock, this.slope.climb, 24000) : new PathFinder(w, h, pass, null, null, 24000));
    }
    this.shipSpots = this.naval.seaTiles ? shipSpots(this.map, this.naval.sea) : [];
    this.region = this.regions[Loco.Vehicle];
    this.mainland = this.mainlands[Loco.Vehicle];
    this.pf = this.pfs[Loco.Vehicle];
    this.gridW = Math.ceil(w / SPATIAL_CELL);
    this.gridH = Math.ceil(h / SPATIAL_CELL);
    this.grid = Array.from({ length: this.gridW * this.gridH }, () => []);

    opts.players.forEach((ps, i) => {
      const s = this.map.starts[i % this.map.starts.length];
      this.players.push({
        id: i,
        name: ps.name,
        faction: ps.faction,
        color: ps.color,
        isAI: ps.isAI,
        credits: opts.credits ?? 10000,
        powerOut: 0,
        powerUse: 0,
        queues: { building: [], defense: [], infantry: [], vehicle: [], air: [], naval: [] },
        ready: { building: null, defense: null, infantry: null, vehicle: null, air: null, naval: null },
        explored: new Uint8Array(w * h),
        visible: new Uint8Array(w * h),
        airVisible: new Uint8Array(w * h),
        defeated: false,
        startX: s.x,
        startY: s.y,
        stats: { built: 0, lost: 0, killed: 0, harvested: 0 },
        noFundsWarnAt: -9999,
        attackWarnAt: -9999,
        harvWarnAt: -9999,
        lowPowerWarned: false,
        radarOnline: false,
        airdropAt: -1,
        airdropFrom: 0,
        sw: newSuperweaponState(),
        autoDefend: !!ps.autoDefend,
      });
      const f = ps.faction;
      this.spawnUnit(factionUnit(f, (d) => !!d.mcv).id, i, s.x + 0.5, s.y + 0.5);
      const inf = `${f}_rifle`;
      const tank = `${f}_mbt`;
      const toCenter = Math.sign(this.map.w / 2 - s.x);
      this.spawnUnit(tank, i, s.x + 0.5 + 3 * toCenter, s.y + 0.5 - 2 * toCenter);
      for (let k = 0; k < 4; k++) this.spawnUnit(inf, i, s.x + 0.5 + (2 + (k % 2)) * toCenter, s.y + 0.5 + (1 + (k >> 1)) * -toCenter * -1);
    });
    for (const o of this.map.oils) this.spawnBuilding('oil', -1, Math.min(o.x, w - 2), Math.min(o.y, h - 2), true);
    spawnGarrisons(this); // garrisonable village houses (garrison.ts)
    spawnTechSites(this); // capturable tech structures (capture.ts)
    this.bridges = initBridges(this);
    this.updateVisibility();
  }

  // ------------------------------------------------------------------ API

  allocId() {
    return this.nextId++;
  }

  issue(player: number, cmd: Command) {
    this.pending.push({ player, cmd });
  }

  get(id: number): Entity | undefined {
    const e = this.entities.get(id);
    return e && !e.dead ? e : undefined;
  }

  /** A live entity that can be fought: not a soldier lying wounded (medic.ts: nobody targets him). */
  foe(id: number): Entity | undefined {
    const e = this.entities.get(id);
    return e && !e.dead && !e.wound ? e : undefined;
  }

  def(e: Entity): Def {
    return DEFS[e.def];
  }

  isLowPower(p: Player) {
    return p.powerUse > p.powerOut;
  }

  hasRole(player: number, role: string) {
    for (const e of this.list) if (!e.dead && e.owner === player && e.kind === 'building' && buildingDef(e.def).role === role) return true;
    return false;
  }

  /**
   * inQueue: the head of a production queue asking whether it may finish (it is already counted among
   * the queued jets, so the jet cap leaves room for it).
   */
  canBuild(player: number, defId: string, inQueue = false): boolean {
    const p = this.players[player];
    const d = DEFS[defId];
    if (!d || !d.buildable || d.faction !== p.faction) return false;
    // the navy only where there is sea to sail (naval.ts)
    if ((d.category === 'naval' || (d.kind === 'building' && d.shipyard)) && !this.hasSea) return false;
    if (d.category === 'building' || d.category === 'defense') {
      if (!this.hasRole(player, 'conyard')) return false;
    }
    if (!d.prereq.every((r) => this.hasRole(player, r))) return false;
    if (d.kind === 'unit') {
      // one of a kind (the aircraft carrier): built or in production
      if (d.limit && this.ownedOrQueued(player, d) - (inQueue ? 1 : 0) >= d.limit) return false;
      // a carrier needs deep water by one of its owner's Shipyards (naval.ts)
      if (d.naval === 'deep' && !deepYard(this, player)) return false;
      // jet cap: one parking pad per jet, 4 per airbase (airbase.ts); a carrier's air wing: its deck pads
      if (isSortieJet(d)) {
        const deck = !!d.deckJet;
        return jetCount(this, player, deck) + jetsQueued(this, player, deck) - (inQueue ? 1 : 0) < (deck ? deckCap(this, player) : padCap(this, player));
      }
    }
    return true;
  }

  /** Units of this kind the player has, built and in its production queue. */
  ownedOrQueued(player: number, d: UnitDef): number {
    let n = 0;
    for (const e of this.list) if (!e.dead && e.owner === player && e.def === d.id) n++;
    for (const q of this.players[player].queues[d.category]) if (q.def === d.id) n++;
    return n;
  }

  // ------------------------------------------------------------ entities

  private blank(defId: string, owner: number, x: number, y: number, kind: 'unit' | 'building'): Entity {
    const d = DEFS[defId];
    const facing = owner >= 0 && this.players[owner] ? Math.atan2(this.map.h / 2 - y, this.map.w / 2 - x) : 0;
    return {
      id: this.nextId++,
      def: defId,
      kind,
      owner,
      x,
      y,
      px: x,
      py: y,
      facing,
      turret: facing,
      pfacing: facing,
      pturret: facing,
      hp: d.hp,
      maxHp: d.hp,
      dead: false,
      order: { type: 'idle' },
      path: null,
      pathIdx: 0,
      repathAt: 0,
      stuckTicks: 0,
      progX: x,
      progY: y,
      progAt: 0,
      progIdx: 0,
      progBest: 1e9,
      noProg: 0,
      moveGoal: -1,
      slotX: 0,
      slotY: 0,
      moving: false,
      targetId: -1,
      autoTarget: false,
      cooldown: 0,
      cooldown2: 0,
      burstWpn: '',
      burstLeft: 0,
      burstTimer: 0,
      scanAt: this.tick + (this.nextId % 10),
      guardX: x,
      guardY: y,
      cargo: 0,
      hstate: 'seek',
      htimer: 0,
      oreTile: -1,
      dockSeq: -1,
      qspot: -1,
      oreAvoid: -1,
      hfield: -1,
      hflee: null,
      hitAt: -9999,
      hresumeAt: -9999,
      hvProg: 0,
      tx: 0,
      ty: 0,
      buildAnim: 1,
      rallyX: -1,
      rallyY: -1,
      repairing: false,
      incomeTimer: 0,
      life: -1,
      jammedUntil: -1,
      z: 0,
      pz: 0,
      inside: -1,
      passengers: [],
      dockedBy: -1,
      idleTicks: 0,
      lastHurt: -9999,
      firedAt: -9999,
      drop: null,
      para: null,
      xp: 0,
      rank: 0,
      spawner: -1,
      stance: DEFAULT_STANCE,
      queue: [],
      patrol: null,
      guardId: -1,
      orderAt: -9999,
      hurtBy: -1,
      defend: null,
      dodge: null,
      dodgeAt: 0,
      stillAt: 0,
      sortie: null,
      aimTarget: -1,
      aimTicks: 0,
      wound: null,
      treat: 0,
      tendedBy: -1,
      heli: null,
      flashAt: -9999,
      illumAt: 0,
    };
  }

  spawnUnit(defId: string, owner: number, x: number, y: number): Entity {
    const e = this.blank(defId, owner, x, y, 'unit');
    this.add(e);
    const d = unitDef(defId);
    if (d.harvester) e.order = { type: 'harvest' };
    if (d.temp) e.life = TPS * 25;
    return e;
  }

  spawnBuilding(defId: string, owner: number, tx: number, ty: number, instant = false): Entity {
    const d = buildingDef(defId);
    const e = this.blank(defId, owner, tx + d.w / 2, ty + d.h / 2, 'building');
    e.tx = tx;
    e.ty = ty;
    e.facing = 0;
    e.turret = Math.PI * 0.75;
    e.pturret = e.turret;
    e.buildAnim = instant ? 1 : 0;
    // a Shipyard's slipway faces the water (naval.ts)
    if (d.shipyard) e.slip = this.shipSite(defId, tx, ty).dir;
    // the north base's exits / docks face north, the mirror of the south base's (turn.ts)
    if (owner >= 0 && this.players[owner] && turnable(defId) && northStart(this.players[owner].startY, this.map.h)) e.flip = true;
    this.add(e);
    this.occupy(e, true);
    return e;
  }

  private add(e: Entity) {
    this.entities.set(e.id, e);
    this.list.push(e);
  }

  private occupy(b: Entity, on: boolean) {
    const d = buildingDef(b.def);
    const { w } = this.map;
    for (let y = 0; y < d.h; y++) {
      for (let x = 0; x < d.w; x++) {
        const i = (b.ty + y) * w + b.tx + x;
        const lx = b.flip ? d.w - 1 - x : x;
        const ly = b.flip ? d.h - 1 - y : y;
        const through = d.passable?.some(([px, py]) => px === lx && py === ly);
        this.occ[i] = on ? b.id : 0;
        this.pass[i] = on && !through ? 0 : terrainPassable(this.map, b.tx + x, b.ty + y) ? 1 : 0;
        // (the water classes: a structure on the shore or in the sea - the Shipyard - blocks them too)
        for (let c = LOCO_COUNT; c < LOCO_ALL; c++) this.passes[c][i] = on && !through ? 0 : this.naval.base[c - LOCO_COUNT][i];
      }
    }
    this.clearPaths();
  }

  /** Passability changed (a building, a bridge): drop every class's cached paths. */
  clearPaths() {
    for (const pf of this.pfs) pf.clearCache();
  }

  /** Locomotion class of a unit (slope.ts; -1 for aircraft, the water classes for naval units). */
  locoOf(e: Entity): number {
    return locoOf(unitDef(e.def));
  }

  /** Locomotion class of a unit type. */
  locoOfDef(d: UnitDef): number {
    return locoOf(d);
  }

  /** Does this map have open sea a Shipyard can stand by (naval.ts)? Without it the navy is not on offer. */
  get hasSea(): boolean {
    return this.shipSpots.length > 0;
  }

  /**
   * Can a unit of locomotion class c move from tile a to tile b (the same tile or a neighbour; farther: false)?
   * Orthogonal: the step within the class's slope limit (slope.ts). Diagonal (passing a corner): by either of the
   * two tiles beside the corner, passable, both its steps within the limit.
   */
  stepOk(a: number, b: number, c: number): boolean {
    if (a === b || c < 0) return true;
    const w = this.map.w;
    const ax = a % w;
    const dx = (b % w) - ax;
    const dy = Math.floor(b / w) - Math.floor(a / w);
    const k = dirOf(dx, dy);
    if (k < 0) return false;
    if (c >= LOCO_COUNT && c !== Loco.Swim) {
      // water classes: no slopes; a diagonal passes a corner only past one open tile beside it
      if (k < 4) return true;
      const pc = this.passes[c];
      return pc[a + dx] === 1 || pc[a + dy * w] === 1;
    }
    // (the diver: the infantry's slope rule over land, none in or into the water: swimBlock)
    const bl = c === Loco.Swim ? this.swimBlock : this.slope.block[c];
    const pc = c === Loco.Swim ? this.passes[c] : this.pass;
    if (k < 4) return !(bl[a] & (1 << k));
    // (a diagonal is never off the map's edge here: b is on the map, so both corner tiles are)
    const kx = dx > 0 ? 0 : 1;
    const ky = dy > 0 ? 2 : 3;
    const tx = a + dx;
    const ty = a + dy * w;
    return (pc[tx] === 1 && !(bl[a] & (1 << kx)) && !(bl[tx] & (1 << ky))) || (pc[ty] === 1 && !(bl[a] & (1 << ky)) && !(bl[ty] & (1 << kx)));
  }

  /**
   * Is the straight line from (x0, y0) to (x1, y1) open ground for class c: every tile it passes through passable,
   * every move between them within the class's slope limit (stepOk)? An exact walk over the tile boundaries the line
   * crosses (a corner crossed exactly is a diagonal move).
   */
  lineOk(x0: number, y0: number, x1: number, y1: number, c: number): boolean {
    const { w, h } = this.map;
    let tx = Math.floor(x0);
    let ty = Math.floor(y0);
    const ex = Math.floor(x1);
    const ey = Math.floor(y1);
    if (tx === ex && ty === ey) return true;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const sx = dx > 0 ? 1 : -1;
    const sy = dy > 0 ? 1 : -1;
    const ix = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const iy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    // line parameter t (0..1) at the next x / y boundary
    let nx = dx !== 0 ? (dx > 0 ? tx + 1 - x0 : x0 - tx) * ix : Infinity;
    let ny = dy !== 0 ? (dy > 0 ? ty + 1 - y0 : y0 - ty) * iy : Infinity;
    let guard = 4 * (Math.abs(ex - tx) + Math.abs(ey - ty)) + 4;
    while ((tx !== ex || ty !== ey) && guard-- > 0) {
      const a = ty * w + tx;
      if (Math.min(nx, ny) > 1) break;
      if (nx < ny) {
        tx += sx;
        nx += ix;
      } else if (ny < nx) {
        ty += sy;
        ny += iy;
      } else {
        tx += sx;
        ty += sy;
        nx += ix;
        ny += iy;
      }
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) return false;
      const b = ty * w + tx;
      if (!this.passes[c < 0 ? Loco.Vehicle : c][b] || !this.stepOk(a, b, c)) return false;
    }
    return true;
  }

  // ------------------------------------------------------------ helpers

  tileOf(x: number, y: number) {
    return Math.floor(y) * this.map.w + Math.floor(x);
  }

  distTo(e: Entity, t: Entity): number {
    if (t.kind === 'building') {
      const d = buildingDef(t.def);
      const dx = Math.max(t.tx - e.x, 0, e.x - (t.tx + d.w));
      const dy = Math.max(t.ty - e.y, 0, e.y - (t.ty + d.h));
      return Math.hypot(dx, dy);
    }
    return Math.hypot(t.x - e.x, t.y - e.y);
  }

  /** Airborne (a jet on its wheels at its airbase, or a helicopter set down there for repair, is a ground target: airbase.ts, helipad.ts). */
  isAir(e: Entity) {
    return e.kind === 'unit' && !!unitDef(e.def).air && !jetGrounded(e) && !heliGrounded(e);
  }

  canHit(wpn: WeaponDef, t: Entity) {
    const air = this.isAir(t);
    // submarines' weapons (defs.ts): a torpedo only at ships and submarines; a missile never at a submerged boat
    if (wpn.vs === 'naval' && !(t.kind === 'unit' && unitDef(t.def).category === 'naval')) return false;
    if (wpn.vs === 'surface' && t.dive) return false;
    if (wpn.air === 'only') return air;
    if (wpn.air === 'no') return !air;
    return true;
  }

  /**
   * The weapon a unit / structure of this def uses against t: its main weapon, else its secondary one
   * (UnitDef.weapon2: the Rocket Team's shoulder-fired AA missile next to its ground-only RPG); null if neither can hit it.
   */
  weaponVs(defId: string, t: Entity): WeaponDef | null {
    const d = DEFS[defId];
    if (!d?.weapon) return null;
    const main = WEAPONS[d.weapon];
    if (this.canHit(main, t)) return main;
    const id2 = d.kind === 'unit' ? d.weapon2 : undefined;
    const alt = id2 ? WEAPONS[id2] : undefined;
    return alt && this.canHit(alt, t) ? alt : null;
  }

  /** Can a unit / structure of this def shoot at t with any of its weapons? */
  canAttack(defId: string, t: Entity) {
    return !!this.weaponVs(defId, t);
  }

  /** Longest reach of an entity's weapons (main and secondary). */
  maxWeaponRange(e: Entity) {
    const d = DEFS[e.def];
    if (!d.weapon) return 0;
    const r = this.weaponRange(e, WEAPONS[d.weapon]);
    const id2 = d.kind === 'unit' ? d.weapon2 : undefined;
    return id2 ? Math.max(r, this.weaponRange(e, WEAPONS[id2])) : r;
  }

  weaponRange(e: Entity, wpn: WeaponDef) {
    let r = wpn.range;
    if (e.inside >= 0) {
      const h = garrisonOf(this, e);
      if (h) r += garrisonRangeBonus(h, wpn); // firing from a civilian building (garrison.ts)
    }
    if (e.owner >= 0) {
      const p = this.players[e.owner];
      if (p.radarOnline) r += FACTION_INFO[p.faction].mods.radarRange ?? 0;
    }
    return r;
  }

  isEnemy(a: number, b: number) {
    return a !== b && a >= 0 && b >= 0;
  }

  /**
   * Fog of war rule now (types.ts FogMode): automatic, classic (Red Alert 2: explored ground stays revealed)
   * by day, the night fog ('modern': only current sight shows units) by night.
   */
  get fog(): FogMode {
    return this.forcedFog ?? (this.night ? 'modern' : 'classic');
  }

  /** Clock hour now (clock.ts; may pass 24 on later days). */
  hours(): number {
    return simHours(this.tick, this.clock);
  }

  private updateNight() {
    this.nightLevel = nightLevel(this.hours());
    this.night = isNight(this.nightLevel);
  }

  /** Sight radius of an entity now: half by night for ordinary units and structures, full with night vision (night.ts). */
  sightOf(e: Entity): number {
    const s = DEFS[e.def].sight;
    return this.nightLevel > 0 && !hasNightVision(e) ? s * nightSight(this.nightLevel) : s;
  }

  /**
   * Can this player see this entity now? Its own always; others on currently visible ground (night.ts: by night
   * that is current sight, flares and floodlights), or given away by a muzzle flash by night.
   */
  sees(player: number, e: Entity): boolean {
    if (e.owner === player) return true;
    // a submerged unit is out of sight, but for what its rule spots it with (a diver: the sonar of the viewer's ships and boats; submerge.ts)
    if (e.dive && this.isEnemy(player, e.owner)) return spottedWhenSubmerged(this, player, e);
    return this.visibleTo(player, e.x, e.y) || flashLit(this, e) || (this.nightLevel > 0 && this.airSeen(player, e));
  }

  /** By night: an airborne target inside this player's air defence sensor cover (night.ts, Player.airVisible). */
  private airSeen(player: number, e: Entity): boolean {
    const tx = Math.floor(e.x);
    const ty = Math.floor(e.y);
    if (tx < 0 || ty < 0 || tx >= this.map.w || ty >= this.map.h) return false;
    return this.players[player].airVisible[ty * this.map.w + tx] > 0 && this.isAir(e);
  }

  visibleTo(player: number, x: number, y: number) {
    const { w, h } = this.map;
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= w || ty >= h) return false;
    return this.players[player].visible[ty * w + tx] > 0;
  }

  /** The nearest passable tile within maxR; with `region`, only tiles of that ground region of locomotion class `loco`. */
  nearestPassable(x: number, y: number, maxR = 12, region = 0, loco: number = Loco.Vehicle): [number, number] | null {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const reg = this.regions[loco < 0 ? Loco.Vehicle : loco];
    const pf = this.pfs[loco < 0 ? Loco.Vehicle : loco];
    for (const [ox, oy] of SPIRAL) {
      if (Math.abs(ox) > maxR || Math.abs(oy) > maxR) continue;
      if (pf.passable(tx + ox, ty + oy) && (!region || reg[(ty + oy) * this.map.w + tx + ox] === region)) return [tx + ox, ty + oy];
    }
    return null;
  }

  /**
   * Ground region a ground unit of locomotion class `loco` stands in (default: vehicles). Standing on no
   * passable tile (pushed onto a building's edge), the region of the nearest passable tile next to it, else the mainland.
   */
  regionOf(x: number, y: number, loco: number = Loco.Vehicle): number {
    const c = loco < 0 ? Loco.Vehicle : loco;
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= this.map.w || ty >= this.map.h) return this.mainlands[c];
    const reg = this.regions[c];
    const r = reg[ty * this.map.w + tx];
    if (r) return r;
    for (let k = 0; k < 8; k++) {
      const nx = tx + DX8[k];
      const ny = ty + DY8[k];
      if (nx >= 0 && ny >= 0 && nx < this.map.w && ny < this.map.h && reg[ny * this.map.w + nx]) return reg[ny * this.map.w + nx];
    }
    return this.mainlands[c];
  }

  queryRadius(x: number, y: number, r: number, cb: (e: Entity) => void) {
    const c0 = Math.max(0, Math.floor((x - r - 2) / SPATIAL_CELL));
    const c1 = Math.min(this.gridW - 1, Math.floor((x + r + 2) / SPATIAL_CELL));
    const r0 = Math.max(0, Math.floor((y - r - 2) / SPATIAL_CELL));
    const r1 = Math.min(this.gridH - 1, Math.floor((y + r + 2) / SPATIAL_CELL));
    for (let gy = r0; gy <= r1; gy++) for (let gx = c0; gx <= c1; gx++) for (const e of this.grid[gy * this.gridW + gx]) if (!e.dead) cb(e);
  }

  private rebuildGrid() {
    for (const cell of this.grid) cell.length = 0;
    for (const e of this.list) {
      // (soldiers lying wounded are off the grid: nothing targets, splashes, crushes or shoves them; medic.ts)
      if (e.dead || e.inside >= 0 || e.wound) continue;
      const gx = Math.min(this.gridW - 1, Math.max(0, Math.floor(e.x / SPATIAL_CELL)));
      const gy = Math.min(this.gridH - 1, Math.max(0, Math.floor(e.y / SPATIAL_CELL)));
      this.grid[gy * this.gridW + gx].push(e);
    }
  }

  /** The coast rule of a Shipyard footprint here, with the structures standing now (naval.ts). */
  shipSite(defId: string, tx: number, ty: number): ShipSite {
    const d = buildingDef(defId);
    return shipSite(this.map, this.naval.sea, tx, ty, (i) => this.occ[i] === 0, d.w, d.h);
  }

  /** Why a structure can't go here (the HUD's placement tooltip), '' when it can or there is nothing to explain. */
  placeWhy(player: number, defId: string, tx: number, ty: number): string {
    if (this.canPlace(player, defId, tx, ty)) return '';
    const d = buildingDef(defId);
    if (d.shipyard) {
      const s = this.shipSite(defId, tx, ty);
      if (!s.ok) return s.reason;
      if (this.canPlace(player, defId, tx, ty, -1, false)) return `Too far from your base: within ${SHIP_YARD_REACH} tiles of your Construction Yard`;
      return 'Enemy units in the way';
    }
    return '';
  }

  canPlace(player: number, defId: string, tx: number, ty: number, ignoreId = -1, checkRadius = true): boolean {
    const d = buildingDef(defId);
    const { w, h } = this.map;
    if (tx < 0 || ty < 0 || tx + d.w > w || ty + d.h > h) return false;
    if (d.shipyard) {
      // half in the sea, half on the shore (naval.ts)
      if (!this.shipSite(defId, tx, ty).ok) return false;
    }
    // open, gentle ground off the bridge heads (map.ts), not taken by another building
    else if (!terrainBuildable(this.map, tx, ty, d.w, d.h)) return false;
    for (let y = ty; y < ty + d.h; y++) for (let x = tx; x < tx + d.w; x++) if (this.occ[y * w + x] !== 0) return false;
    // enemy units block placement
    let blocked = false;
    this.queryRadius(tx + d.w / 2, ty + d.h / 2, Math.max(d.w, d.h), (e) => {
      if (e.kind !== 'unit' || e.id === ignoreId || e.owner === player || this.isAir(e)) return;
      if (e.x >= tx && e.x < tx + d.w && e.y >= ty && e.y < ty + d.h) blocked = true;
    });
    if (blocked) return false;
    if (!checkRadius) return true;
    for (const b of this.list) {
      if (b.dead || b.kind !== 'building' || b.owner !== player) continue;
      const bd = buildingDef(b.def);
      const gx = Math.max(0, tx - (b.tx + bd.w), b.tx - (tx + d.w));
      const gy = Math.max(0, ty - (b.ty + bd.h), b.ty - (ty + d.h));
      if (Math.max(gx, gy) <= (d.shipyard ? SHIP_BUILD_RADIUS : BUILD_RADIUS)) return true;
      // (a Shipyard: also on any suitable coast within reach of a Construction Yard, naval.ts SHIP_YARD_REACH)
      if (d.shipyard && bd.role === 'conyard' && Math.hypot(tx + d.w / 2 - b.tx - bd.w / 2, ty + d.h / 2 - b.ty - bd.h / 2) <= SHIP_YARD_REACH) return true;
    }
    return false;
  }

  /** Push the given player's units out of a freshly placed footprint. */
  private evictUnits(b: Entity) {
    const d = buildingDef(b.def);
    for (const e of this.list) {
      if (e.dead || e.kind !== 'unit' || this.isAir(e)) continue;
      if (e.x >= b.tx && e.x < b.tx + d.w && e.y >= b.ty && e.y < b.ty + d.h) {
        const lc = this.locoOf(e);
        if (this.passes[lc < 0 ? Loco.Vehicle : lc][this.tileOf(e.x, e.y)]) continue;
        const p = this.nearestPassable(e.x, e.y, 12, this.regionOf(e.x, e.y, lc), lc);
        if (p) {
          e.x = e.px = p[0] + 0.5;
          e.y = e.py = p[1] + 0.5;
          e.path = null;
        }
      }
    }
  }

  // ------------------------------------------------------------ commands

  private applyCommand(pid: number, cmd: Command) {
    const p = this.players[pid];
    if (!p || p.defeated) return;
    const own = (ids: number[]) => {
      // (a soldier lying wounded takes no orders: medic.ts)
      const units = ids.map((id) => this.get(id)).filter((e): e is Entity => !!e && e.owner === pid && e.kind === 'unit' && e.inside < 0 && !e.para && !e.drop && !e.wound);
      // an explicit order: base defence leaves these units alone for a while (basedefense.ts);
      // a stance change only calls them off a defence run
      for (const e of units) {
        if (cmd.type !== 'stance') e.orderAt = this.tick;
        if (e.defend) releaseDefender(this, e, cmd.type === 'stance');
        // a harvester running home after an attack does what it is told instead (harvest.ts)
        if (cmd.type !== 'stance') e.hflee = null;
        // a medic given another order leaves his patient for someone else (medic.ts)
        if (cmd.type !== 'stance' && cmd.type !== 'treat') releasePatient(this, e);
      }
      return units;
    };
    if (cmd.type === 'autoDefend') {
      setAutoDefend(this, pid, !!cmd.on);
      return;
    }
    // a new order breaks a sniper's aim (sniper.ts)
    if ('ids' in cmd) for (const id of cmd.ids) { const e = this.get(id); if (e && e.owner === pid && e.kind === 'unit') aimOrder(e, cmd); }
    if (applyOrderCommand(this, pid, cmd, own)) return; // stances, patrol, guard, queued waypoints (orders.ts)
    switch (cmd.type) {
      case 'move': {
        const units = own(cmd.ids);
        this.formationMove(units, cmd.x, cmd.y, !!cmd.attackMove);
        // a loaded landing craft sent onto land: it beaches as near as it can and puts its cargo ashore (naval.ts)
        const tx = Math.floor(cmd.x);
        const ty = Math.floor(cmd.y);
        const onLand = tx >= 0 && ty >= 0 && tx < this.map.w && ty < this.map.h && this.map.tiles[ty * this.map.w + tx] !== Tile.Water;
        for (const e of units) if (isCarrier(e)) e.landing = onLand && e.passengers.length ? { x: cmd.x, y: cmd.y } : null;
        break;
      }
      case 'attack': {
        const t = this.foe(cmd.target);
        if (!t) break;
        for (const e of own(cmd.ids)) {
          const d = unitDef(e.def);
          if (d.engineer && t.kind === 'building') {
            const bd = buildingDef(t.def);
            if (t.owner !== pid || t.hp < t.maxHp) {
              if (t.owner === pid || bd.capturable || t.owner >= 0) e.order = { type: 'capture', target: t.id, repair: t.owner === pid };
            }
            continue;
          }
          if (!d.weapon || t.owner === pid || d.temp || !this.canAttack(d.id, t)) continue;
          if (isBridge(t) && !canHurtBridge(d.weapon)) continue; // only heavy ordnance can drop a bridge
          e.order = { type: 'attack', target: t.id, forced: true };
          e.targetId = t.id;
          e.autoTarget = false;
          e.path = null;
        }
        break;
      }
      case 'capture': {
        const t = this.get(cmd.target);
        if (!t || t.kind !== 'building') break;
        const isRepair = t.owner === pid;
        for (const e of own(cmd.ids)) if (unitDef(e.def).engineer) e.order = { type: 'capture', target: t.id, repair: isRepair };
        break;
      }
      case 'stop':
        for (const e of own(cmd.ids)) {
          e.order = { type: 'idle' };
          e.path = null;
          e.targetId = -1;
          e.guardX = e.x;
          e.guardY = e.y;
        }
        break;
      case 'deploy':
        for (const e of own(cmd.ids)) {
          if (unitDef(e.def).mcv) this.tryDeploy(e);
          else if (isCarrier(e)) orderUnload(this, e); // landing craft: put ashore (naval.ts)
          else if (e.passengers.length) this.unload(e);
        }
        break;
      case 'enter': {
        const t = this.get(cmd.target);
        if (t && t.kind === 'building') {
          // garrison a civilian building (garrison.ts)
          if (garrisonRoom(this, t, pid) > 0) for (const e of own(cmd.ids)) if (canGarrisonUnit(e.def)) e.order = { type: 'enter', target: t.id };
          break;
        }
        if (t && t.owner === pid && isCarrier(t)) {
          // board a landing craft (naval.ts): soldiers and vehicles; an idle craft comes to the beach nearest them
          const boarders = own(cmd.ids).filter((e) => cargoSize(e.def) > 0 && !e.dive);
          for (const e of boarders) {
            e.order = { type: 'enter', target: t.id };
            e.path = null;
          }
          callCraft(this, t, boarders);
          break;
        }
        if (!t || t.owner !== pid || !unitDef(t.def).transport) break;
        for (const e of own(cmd.ids)) if (unitDef(e.def).category === 'infantry' && !e.dive) e.order = { type: 'enter', target: t.id };
        break;
      }
      case 'harvest':
        for (const e of own(cmd.ids)) if (unitDef(e.def).harvester) orderHarvest(this, e, cmd.x, cmd.y); // harvest.ts
        break;
      case 'produce': {
        if (!this.canBuild(pid, cmd.def)) break;
        const d = DEFS[cmd.def];
        const q = p.queues[d.category];
        const n = Math.max(1, Math.min(cmd.count ?? 1, 10));
        if (d.kind === 'building') {
          if (q.length > 0 || p.ready[d.category]) break;
          q.push({ def: d.id, progress: 0, paid: 0 });
        } else {
          for (let k = 0, cap = queueCap(this.producerCount(p, d.category)); k < n && q.length < cap && (k === 0 || this.canBuild(pid, d.id)); k++) q.push({ def: d.id, progress: 0, paid: 0 });
        }
        break;
      }
      case 'cancel': {
        const d = DEFS[cmd.def];
        if (!d) break;
        const cat = d.category;
        if (p.ready[cat] === cmd.def) {
          p.ready[cat] = null;
          p.credits += d.cost;
          break;
        }
        const q = p.queues[cat];
        for (let i = q.length - 1; i >= 0; i--) {
          if (q[i].def === cmd.def) {
            p.credits += q[i].paid;
            q.splice(i, 1);
            break;
          }
        }
        break;
      }
      case 'place': {
        const d = DEFS[cmd.def];
        if (!d || d.kind !== 'building' || p.ready[d.category] !== cmd.def) break;
        if (!this.canPlace(pid, cmd.def, cmd.tx, cmd.ty)) break;
        p.ready[d.category] = null;
        const b = this.spawnBuilding(cmd.def, pid, cmd.tx, cmd.ty);
        this.evictUnits(b);
        p.stats.built++;
        this.events.push({ t: 'placed', id: b.id, owner: pid });
        if (d.role === 'refinery') {
          const ex = d.exit ?? [1, d.h];
          const [hx, hy] = layoutTile(b, ex[0], ex[1]);
          const hv = this.spawnUnit(factionUnit(p.faction, (u) => !!u.harvester).id, pid, hx + 0.5, hy + 0.5);
          hv.facing = hv.pfacing = b.flip ? -Math.PI / 2 : Math.PI / 2;
        }
        break;
      }
      case 'sell': {
        const b = this.get(cmd.id);
        if (!b || b.owner !== pid || b.kind !== 'building' || DEFS[b.def].faction === 'neutral') break; // captured / garrisoned civilian buildings can't be sold
        const d = buildingDef(b.def);
        p.credits += Math.floor((d.cost * 0.5 * b.hp) / b.maxHp);
        this.events.push({ t: 'sold', id: b.id, owner: pid });
        this.remove(b);
        break;
      }
      case 'repair': {
        const b = this.get(cmd.id);
        if (!b || b.owner !== pid || b.kind !== 'building') break;
        b.repairing = !b.repairing && b.hp < b.maxHp;
        break;
      }
      case 'rally': {
        const b = this.get(cmd.id);
        if (!b || b.owner !== pid || b.kind !== 'building') break;
        b.rallyX = cmd.x;
        b.rallyY = cmd.y;
        break;
      }
      case 'superweapon':
        fireSuperweapon(this, pid, cmd.x, cmd.y); // validated there (superweapons.ts)
        break;
      case 'treat': {
        // medics to a wounded or hurt friendly soldier (medic.ts)
        const t = this.get(cmd.target);
        if (t && t.owner === pid && treatable(t)) orderTreat(this, own(cmd.ids), t);
        break;
      }
      case 'illum': {
        // illumination round (night.ts): the nearest ready gun of the selection takes the fire mission
        if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y)) break;
        const cand = cmd.ids.map((id) => this.get(id)).filter((e): e is Entity => !!e && e.owner === pid && e.kind === 'unit' && e.inside < 0 && !e.para && !e.wound);
        const gun = pickIllum(this, cand, cmd.x, cmd.y);
        if (gun) for (const e of own([gun.id])) orderIllum(this, e, cmd.x, cmd.y);
        break;
      }
      case 'land': {
        // helicopters to an own airbase for repair (helipad.ts)
        const b = this.get(cmd.target);
        if (b && b.owner === pid && b.kind === 'building') orderLand(this, own(cmd.ids), b);
        break;
      }
      case 'evacuate': {
        const b = this.get(cmd.id);
        if (b && b.owner === pid && isGarrison(b)) ejectAll(this, b, false); // garrison.ts
        break;
      }
      case 'airdrop': {
        // support power: needs a completed airfield (airdropAt >= 0), a full charge, and an explored drop zone
        if (p.airdropAt < 0 || this.tick < p.airdropAt || !Number.isFinite(cmd.x) || !Number.isFinite(cmd.y)) break;
        const tx = Math.floor(cmd.x);
        const ty = Math.floor(cmd.y);
        if (tx < 0 || ty < 0 || tx >= this.map.w || ty >= this.map.h) break;
        if (!p.explored[ty * this.map.w + tx]) break;
        p.airdropFrom = this.tick;
        p.airdropAt = this.tick + AIRDROP_COOLDOWN;
        this.launchAirdrop(p, cmd.x, cmd.y);
        break;
      }
    }
  }

  // ------------------------------------------------------------ airborne drop

  /** Distance from (x, y) along (dx, dy) to the map edge (inset). */
  private rayToEdge(x: number, y: number, dx: number, dy: number, inset: number) {
    const { w, h } = this.map;
    let t = 1e9;
    if (dx > 1e-6) t = Math.min(t, (w - inset - x) / dx);
    else if (dx < -1e-6) t = Math.min(t, (inset - x) / dx);
    if (dy > 1e-6) t = Math.min(t, (h - inset - y) / dy);
    else if (dy < -1e-6) t = Math.min(t, (inset - y) / dy);
    return Math.max(0, t);
  }

  /** A transport enters from the owner's side of the map and flies a straight run over the drop zone. */
  launchAirdrop(p: Player, x: number, y: number): Entity {
    const { w, h } = this.map;
    x = Math.max(1, Math.min(w - 1, x));
    y = Math.max(1, Math.min(h - 1, y));
    let dx = x - (p.startX + 0.5);
    let dy = y - (p.startY + 0.5);
    let len = Math.hypot(dx, dy);
    if (len < 4) {
      dx = w / 2 - (p.startX + 0.5);
      dy = h / 2 - (p.startY + 0.5);
      len = Math.hypot(dx, dy);
    }
    if (len < 1e-3) {
      dx = 1;
      dy = 0;
      len = 1;
    }
    dx /= len;
    dy /= len;
    const back = this.rayToEdge(x, y, -dx, -dy, 0.6);
    const e = this.spawnUnit(`${p.faction}_transport`, p.id, x - dx * back, y - dy * back);
    e.life = -1;
    e.facing = e.pfacing = e.turret = e.pturret = Math.atan2(dy, dx);
    e.z = e.pz = unitDef(e.def).cruiseAlt ?? 3;
    e.moving = true;
    e.drop = { x, y, dx, dy, jumpers: AIRDROP_STICK.map((k) => `${p.faction}_${k}`), crate: true, phase: 'inbound', next: 0, ramp: 0, closeAt: 0 };
    this.events.push({ t: 'airdrop', owner: p.id, id: e.id, x, y });
    return e;
  }

  /** Transport on its drop run: inbound straight and level, the stick jumps over the zone, then it turns for home and leaves the map. */
  private updateAirlift(e: Entity, d: UnitDef) {
    const r = e.drop;
    if (!r) {
      this.remove(e);
      return;
    }
    const step = (d.speed / TPS) * (e.jammedUntil > this.tick ? 0.7 : 1);
    if (r.phase === 'outbound') e.facing = turnToward(e.facing, Math.atan2(-r.dy, -r.dx), 0.035);
    e.turret = e.facing;
    e.x += Math.cos(e.facing) * step;
    e.y += Math.sin(e.facing) * step;
    e.moving = true;
    e.path = null;
    const along = (r.x - e.x) * r.dx + (r.y - e.y) * r.dy;
    if (r.phase === 'inbound') {
      // the ramp opens on the run-in
      if (along < d.speed * 2.4) r.ramp = 1;
      const n = r.jumpers.length + (r.crate ? 1 : 0);
      if (along <= ((n - 1) * AIRDROP_GAP * step) / 2) {
        // a damaged aircraft gets fewer of its stick out (wounded jumpers, a fire in the hold)
        const frac = Math.max(0, e.hp / e.maxHp);
        const keep = Math.max(1, Math.ceil(r.jumpers.length * frac - 1e-6));
        if (keep < r.jumpers.length) {
          const at = r.jumpers.findIndex((j) => j.endsWith('_at'));
          const kept = r.jumpers.filter((_, i) => i !== at).slice(0, at >= 0 && keep >= 3 ? keep - 1 : keep);
          if (at >= 0 && keep >= 3) kept.splice(Math.min(2, kept.length), 0, r.jumpers[at]);
          r.jumpers = kept;
        }
        if (frac < 0.5) r.crate = false;
        r.phase = 'dropping';
        r.next = this.tick;
        r.ramp = 1;
        this.events.push({ t: 'paradrop', owner: e.owner, id: e.id, x: e.x, y: e.y, z: e.z });
      }
    }
    if (r.phase === 'dropping' && this.tick >= r.next) {
      const j = r.jumpers.shift();
      if (j) this.paraExit(e, j, CHUTE_TICKS);
      else if (r.crate) {
        r.crate = false;
        this.paraExit(e, 'supply_crate', CRATE_CHUTE_TICKS);
      }
      r.next = this.tick + AIRDROP_GAP;
      if (!r.jumpers.length && !r.crate) {
        r.phase = 'outbound';
        r.closeAt = this.tick + TPS * 2;
      }
    }
    if (r.phase === 'outbound' && this.tick >= r.closeAt) r.ramp = 0;
    const { w, h } = this.map;
    const out = e.x < 0.3 || e.y < 0.3 || e.x > w - 0.3 || e.y > h - 0.3;
    if (out) {
      if (r.phase === 'outbound') this.remove(e);
      else {
        e.x = Math.max(0.3, Math.min(w - 0.3, e.x));
        e.y = Math.max(0.3, Math.min(h - 0.3, e.y));
      }
    }
  }

  /** One jumper (or the supply pallet) leaves the ramp: it drifts on with the aircraft's momentum and lands with a little scatter. */
  private paraExit(plane: Entity, defId: string, T: number) {
    const r = plane.drop!;
    const u = this.spawnUnit(defId, plane.owner, plane.x, plane.y);
    u.facing = u.pfacing = u.turret = u.pturret = plane.facing;
    u.z = u.pz = Math.max(0.6, plane.z - 0.25);
    let lx = plane.x + r.dx * 0.8 + this.rng.range(-0.5, 0.5);
    let ly = plane.y + r.dy * 0.8 + this.rng.range(-0.5, 0.5);
    const { w, h } = this.map;
    lx = Math.max(0.6, Math.min(w - 0.6, lx));
    ly = Math.max(0.6, Math.min(h - 0.6, ly));
    if (!this.pf.passable(Math.floor(lx), Math.floor(ly))) {
      const spot = this.nearestPassable(lx, ly, 10);
      if (spot) {
        lx = spot[0] + 0.5 + this.rng.range(-0.25, 0.25);
        ly = spot[1] + 0.5 + this.rng.range(-0.25, 0.25);
      }
    }
    u.guardX = lx;
    u.guardY = ly;
    u.para = { t: T, T, z0: u.z, x0: plane.x, y0: plane.y };
    u.order = { type: 'idle' };
    u.moving = false;
  }

  /** Under canopy: drift to the landing point while descending; helpless (no orders, no fire) until touchdown. */
  private updatePara(e: Entity, d: UnitDef) {
    const pa = e.para!;
    pa.t--;
    const u = 1 - pa.t / pa.T;
    const k = 1 - (1 - u) * (1 - u);
    e.x = pa.x0 + (e.guardX - pa.x0) * k;
    e.y = pa.y0 + (e.guardY - pa.y0) * k;
    e.z = pa.z0 * descentHeight(u);
    e.moving = false;
    if (pa.t > 0) return;
    e.para = null;
    e.z = 0;
    e.x = e.guardX;
    e.y = e.guardY;
    e.scanAt = this.tick + 2;
    if (d.supply) e.life = CRATE_LIFE;
    this.events.push({ t: 'landed', owner: e.owner, id: e.id, x: e.x, y: e.y });
  }

  /** Supply pallet on the ground: field medical kits and ammunition patch up friendly units around it, then it is used up. */
  private updateSupply(e: Entity) {
    if (--e.life <= 0) {
      this.remove(e);
      return;
    }
    if ((this.tick + e.id) % TPS !== 0) return;
    this.queryRadius(e.x, e.y, CRATE_RADIUS, (o) => {
      if (o === e || o.owner !== e.owner || o.kind !== 'unit' || o.para || o.hp >= o.maxHp || this.isAir(o)) return;
      if (Math.hypot(o.x - e.x, o.y - e.y) > CRATE_RADIUS) return;
      o.hp = Math.min(o.maxHp, o.hp + o.maxHp * CRATE_HEAL);
    });
  }

  formationMove(units: Entity[], x: number, y: number, attackMove: boolean) {
    if (units.length === 0) return;
    const { w } = this.map;
    const gx = Math.floor(x);
    const gy = Math.floor(y);
    units.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
    const taken = new Map<number, number>();
    for (const e of units) {
      const d = unitDef(e.def);
      const cap = d.category === 'infantry' ? 3 : 1;
      let tx = gx;
      let ty = gy;
      let slot = 0;
      const air = !!d.air;
      // (ground units only ever head for land they can reach: islands, and plateaus their slope limit keeps them off)
      const lc = locoOf(d);
      const home = air ? 0 : this.regionOf(e.x, e.y, lc);
      const reg = this.regions[lc < 0 ? Loco.Vehicle : lc];
      const pf = this.pfs[lc < 0 ? Loco.Vehicle : lc];
      for (const [ox, oy] of SPIRAL) {
        const cx = gx + ox;
        const cy = gy + oy;
        if (air ? cx < 0 || cy < 0 || cx >= w || cy >= this.map.h : !pf.passable(cx, cy) || reg[cy * w + cx] !== home) continue;
        const i = cy * w + cx + (air ? 1e6 : 0);
        const used = taken.get(i) ?? 0;
        // infantry and vehicles don't share tiles
        if (used >= 100 || (used > 0 && cap === 1) || (cap === 3 && used >= 3)) continue;
        tx = cx;
        ty = cy;
        slot = used;
        taken.set(i, cap === 1 ? 100 : used + 1);
        break;
      }
      const off = cap === 3 ? INF_SLOTS[slot % 3] : [0, 0];
      e.order = attackMove ? { type: 'attackMove', x: tx + 0.5 + off[0], y: ty + 0.5 + off[1] } : { type: 'move', x: tx + 0.5 + off[0], y: ty + 0.5 + off[1] };
      e.targetId = -1;
      e.autoTarget = false;
      if (unitDef(e.def).harvester) e.hstate = 'seek';
      this.pathTo(e, tx + 0.5 + off[0], ty + 0.5 + off[1]);
    }
  }

  private tryDeploy(e: Entity) {
    const p = this.players[e.owner];
    const id = factionDefByRole(p.faction, 'conyard').id;
    const tx = Math.floor(e.x) - 1;
    const ty = Math.floor(e.y) - 1;
    if (!this.canPlace(e.owner, id, tx, ty, e.id, false)) return false;
    this.remove(e);
    const b = this.spawnBuilding(id, e.owner, tx, ty);
    this.evictUnits(b);
    this.events.push({ t: 'deployed', id: b.id, owner: e.owner });
    return true;
  }

  // ------------------------------------------------------------ movement

  pathTo(e: Entity, x: number, y: number) {
    const sx = Math.floor(e.x);
    const sy = Math.floor(e.y);
    let gx = Math.floor(x);
    let gy = Math.floor(y);
    gx = Math.max(0, Math.min(this.map.w - 1, gx));
    gy = Math.max(0, Math.min(this.map.h - 1, gy));
    const lc = this.locoOf(e);
    if (lc >= 0) {
      // a goal this unit can never reach (an island, a plateau too steep for it): the nearest point it can
      const W = this.map.w;
      const home = this.regionOf(e.x, e.y, lc);
      const r = this.regions[lc][gy * W + gx];
      if (r !== home) {
        const np = this.nearestPassable(gx + 0.5, gy + 0.5, 12, home, lc);
        if (np && Math.hypot(np[0] - gx, np[1] - gy) > 0.5) {
          gx = np[0];
          gy = np[1];
          x = gx + 0.5;
          y = gy + 0.5;
        }
      }
    }
    e.slotX = x;
    e.slotY = y;
    e.moveGoal = gy * this.map.w + gx;
    e.path = lc < 0 ? [] : this.pfs[lc].find(sx, sy, gx, gy);
    e.pathIdx = 0;
    e.moving = true;
    e.repathAt = this.tick + 20 + (e.id % 7);
    e.progX = e.x;
    e.progY = e.y;
    e.progAt = this.tick + (e.id % 5);
    e.progIdx = 0;
    e.progBest = 1e9;
    e.noProg = 0;
  }

  /** Walk one tick along the current path (medic.ts). Returns true when the destination is reached. */
  walk(e: Entity, d: UnitDef): boolean {
    return this.followPath(e, d);
  }

  /** Advance along the path. Returns true when the destination is reached. */
  private followPath(e: Entity, d: UnitDef): boolean {
    if (!e.path) return true;
    if (d.air) return this.fly(e, d);
    const { w } = this.map;
    // stuck detection: units jammed against each other re-plan, then give up
    if (this.tick - e.progAt >= 20) {
      const moved = Math.hypot(e.x - e.progX, e.y - e.progY);
      e.progX = e.x;
      e.progY = e.y;
      e.progAt = this.tick;
      if (moved < 0.2) {
        e.stuckTicks++;
        const left = Math.hypot(e.slotX - e.x, e.slotY - e.y);
        if (left < 1.6 || e.stuckTicks >= 5) {
          e.path = null;
          e.moving = false;
          e.stuckTicks = 0;
          return true;
        }
        if (e.stuckTicks >= 2) {
          const sx = e.slotX;
          const sy = e.slotY;
          const st = e.stuckTicks;
          this.pathTo(e, sx, sy);
          e.stuckTicks = st;
        }
      } else {
        e.stuckTicks = 0;
        // jostle watchdog: shoved about by the crowd, moving but getting no nearer to the waypoint. Skip a
        // waypoint we can see past after 6 s, re-plan after 10 s, settle where we are after 30 s.
        const k = e.pathIdx;
        const wp = k < e.path.length ? e.path[k] : -1;
        const dw = wp < 0 ? Math.hypot(e.slotX - e.x, e.slotY - e.y) : Math.hypot((wp % w) + 0.5 - e.x, Math.floor(wp / w) + 0.5 - e.y);
        if (k !== e.progIdx || dw < e.progBest - 0.25) {
          e.progIdx = k;
          e.progBest = dw;
          e.noProg = 0;
        } else if (++e.noProg >= 30) {
          e.path = null;
          e.moving = false;
          e.noProg = 0;
          return true;
        } else if (e.noProg % 6 === 0 && k < e.path.length && this.legClear(e, k + 1)) {
          e.pathIdx++;
        } else if (e.noProg === 10) {
          const n = e.noProg;
          this.pathTo(e, e.slotX, e.slotY);
          e.noProg = n;
        }
      }
    }
    // a waypoint counts as reached once we are inside its tile and can drive straight on to the next one: a
    // group sharing one string-pulled corner would otherwise circle its exact centre, shoving each other off it
    while (e.pathIdx < e.path.length && this.tileOf(e.x, e.y) === e.path[e.pathIdx] && this.legClear(e, e.pathIdx + 1)) e.pathIdx++;
    const atEnd = e.pathIdx >= e.path.length;
    let wx: number;
    let wy: number;
    if (atEnd) {
      // final approach to the exact slot, only if the goal tile was reached
      const goalReached = e.path.length === 0 ? this.tileOf(e.x, e.y) === e.moveGoal : e.path[e.path.length - 1] === e.moveGoal;
      if (!goalReached) {
        e.path = null;
        e.moving = false;
        return true;
      }
      wx = e.slotX;
      wy = e.slotY;
    } else {
      const t = e.path[e.pathIdx];
      wx = (t % w) + 0.5;
      wy = Math.floor(t / w) + 0.5;
      if (!this.passes[this.locoOf(e)][t]) {
        // something was built on our path
        this.pathTo(e, e.slotX, e.slotY);
        return false;
      }
    }
    const dx = wx - e.x;
    const dy = wy - e.y;
    const dist = Math.hypot(dx, dy);
    // uphill they slow down a little (half a tile ahead along the leg; downhill and on the level full speed)
    let step = d.speed / TPS;
    if (d.swim) step *= diverSpeed(this, e); // fins under water, wading in the shallows (diver.ts)
    if (dist > 1e-3) {
      const up = standHeight(this.map, e.x + (dx / dist) * 0.5, e.y + (dy / dist) * 0.5) - standHeight(this.map, e.x, e.y);
      if (up > 0) step /= 1 + CLIMB_SLOW * up * 2;
    }
    if (dist < 0.02) {
      if (atEnd) {
        e.path = null;
        e.moving = false;
        return true;
      }
      e.pathIdx++;
      return false;
    }
    const want = Math.atan2(dy, dx);
    if (d.category === 'infantry') {
      e.facing = want;
    } else {
      e.facing = turnToward(e.facing, want, d.turnRate);
      if (!d.turret) e.turret = e.facing;
      if (Math.abs(angleDiff(e.facing, want)) > 0.7) {
        // turn in place; a slow-turning harvester swinging round is not stuck (harvest.ts: it would give up on a
        // tile behind it and swing back and forth between two tiles)
        if (d.harvester) e.progAt = this.tick;
        return false;
      }
    }
    e.moving = true;
    const nx = dist <= step ? wx : e.x + (dx / dist) * step;
    const ny = dist <= step ? wy : e.y + (dy / dist) * step;
    const ct = this.tileOf(e.x, e.y);
    const nt = this.tileOf(nx, ny);
    const lc0 = this.locoOf(e);
    // (a naval unit never leaves its water: a leg off the planned tiles that would cut over a reef or a spit of land
    // is blocked like a step too steep; naval.ts)
    if (nt !== ct && this.passes[lc0][ct] && (!this.stepOk(ct, nt, lc0) || (lc0 >= LOCO_COUNT && !this.passes[lc0][nt]))) {
      // the straight leg from where we actually stand (off the tile centres the path was planned through: shoved by
      // the crowd, a dodge, a start off-centre) crosses a step too steep for us (a ramp's edge, a canyon wall's
      // foot): first back to our tile's centre, and if the leg is still blocked from there, plan again from it
      const lc = this.locoOf(e);
      const cx = ct % w;
      const cy = Math.floor(ct / w);
      const wt = e.path[e.pathIdx] === ct ? e.path[e.pathIdx + 1] : atEnd ? e.moveGoal : e.path[e.pathIdx];
      const fromCentre = wt === undefined || this.pfs[lc].lineClear(cx, cy, wt % w, Math.floor(wt / w));
      if (Math.hypot(cx + 0.5 - e.x, cy + 0.5 - e.y) > 0.05 && fromCentre) {
        if (e.path[e.pathIdx] !== ct) e.path.splice(e.pathIdx, 0, ct);
      } else {
        const st = e.stuckTicks;
        this.pathTo(e, e.slotX, e.slotY);
        e.stuckTicks = st;
      }
      return false;
    }
    e.x = nx;
    e.y = ny;
    if (dist <= step && !atEnd) e.pathIdx++;
    return false;
  }

  /** Can e drive in a straight line from where it stands to path waypoint k (past the end: its slot)? */
  private legClear(e: Entity, k: number): boolean {
    const path = e.path!;
    const { w } = this.map;
    let tx: number;
    let ty: number;
    if (k >= path.length) {
      if (path.length && path[path.length - 1] !== e.moveGoal) return false; // partial path: walk to its end
      tx = e.slotX;
      ty = e.slotY;
    } else {
      tx = (path[k] % w) + 0.5;
      ty = Math.floor(path[k] / w) + 0.5;
    }
    return this.lineOk(e.x, e.y, tx, ty, this.locoOf(e));
  }

  /** Aircraft fly straight to their goal, banking round in an arc. */
  private fly(e: Entity, d: UnitDef): boolean {
    const dx = e.slotX - e.x;
    const dy = e.slotY - e.y;
    const dist = Math.hypot(dx, dy);
    const jammed = e.jammedUntil > this.tick;
    const step = (d.speed / TPS) * (jammed ? 0.35 : 1);
    if (dist <= step) {
      e.x = e.slotX;
      e.y = e.slotY;
      e.path = null;
      e.moving = false;
      return true;
    }
    const want = Math.atan2(dy, dx);
    e.facing = turnToward(e.facing, want, d.turnRate * 1.5);
    if (!d.turret) e.turret = e.facing;
    const k = Math.max(0.35, Math.cos(angleDiff(e.facing, want)));
    e.x += Math.cos(e.facing) * step * k;
    e.y += Math.sin(e.facing) * step * k;
    e.x = Math.max(0.2, Math.min(this.map.w - 0.2, e.x));
    e.y = Math.max(0.2, Math.min(this.map.h - 0.2, e.y));
    e.moving = true;
    return false;
  }

  private separate() {
    for (const e of this.list) {
      if (e.dead || e.kind !== 'unit' || e.inside >= 0 || e.para) continue;
      const d = unitDef(e.def);
      if (d.supply || d.airlift || (e.sortie && e.z < 1) || (e.heli && e.z < 1) || e.wound) continue;
      this.queryRadius(e.x, e.y, 1.2, (o) => {
        if (o === e || o.kind !== 'unit' || o.id < e.id || o.para || (o.sortie && o.z < 1) || (o.heli && o.z < 1)) return;
        const od = unitDef(o.def);
        // (boats and land units are on different layers: a boat by the shore, a tank on the beach, naval.ts)
        if (!!od.air !== !!d.air || !!od.naval !== !!d.naval || od.kamikaze || d.kamikaze || od.supply || od.airlift) return;
        // heavy vehicles and infantry: enemies go under the tracks, the rest are shoved aside (crush.ts)
        if ((d.crusher && od.crushable) || (od.crusher && d.crushable)) {
          if (crushContact(this, e, d, o, od)) return;
        }
        const min = d.radius + od.radius;
        const dx = o.x - e.x;
        const dy = o.y - e.y;
        const dist2 = dx * dx + dy * dy;
        if (dist2 >= min * min) return;
        const dist = Math.sqrt(dist2) || 0.01;
        const push = (min - dist) * 0.5;
        const nx = dist2 > 0 ? dx / dist : 1;
        const ny = dist2 > 0 ? dy / dist : 0;
        // moving units barge through; idle ones yield
        let we = e.moving && !o.moving ? 0.25 : !e.moving && o.moving ? 0.75 : 0.5;
        // hold-position units stand firm; others step round them
        const eh = !e.moving && e.stance === 'hold';
        const oh = !o.moving && o.stance === 'hold';
        if (eh !== oh) we = eh ? 0 : 1;
        // harvesters of one owner give way by task: the one on the dock, then miners, then the rest (harvest.ts)
        if (d.harvester && od.harvester && e.owner === o.owner) {
          const pe = hvPriority(this, e);
          const po = hvPriority(this, o);
          if (pe !== po) we = pe > po ? 0.1 : 0.9;
        }
        const wo = 1 - we;
        this.nudge(e, -nx * push * we * 2, -ny * push * we * 2);
        this.nudge(o, nx * push * wo * 2, ny * push * wo * 2);
        // two vehicles (or two soldiers) meeting head-on both keep right, so they slide past instead of
        // deadlocking in a lane or on a bridge
        if (e.moving && o.moving && !d.air && d.category === od.category && d.category !== 'air' && Math.abs(angleDiff(e.facing, o.facing)) > 2.3) {
          const k = d.category === 'vehicle' ? 0.05 : 0.025;
          this.nudge(e, -Math.sin(e.facing) * k, Math.cos(e.facing) * k);
          this.nudge(o, -Math.sin(o.facing) * k, Math.cos(o.facing) * k);
        }
      });
    }
  }

  private nudge(e: Entity, dx: number, dy: number) {
    const nx = e.x + dx;
    const ny = e.y + dy;
    if (this.isAir(e)) {
      if (nx > 0.2 && ny > 0.2 && nx < this.map.w - 0.2 && ny < this.map.h - 0.2) {
        e.x = nx;
        e.y = ny;
      }
      return;
    }
    // (never shoved off the map, onto a blocked tile - a boat onto land -, or up / down a step too steep for it)
    const lc = this.locoOf(e);
    if (nx > 0 && ny > 0 && nx < this.map.w && ny < this.map.h && this.passes[lc < 0 ? Loco.Vehicle : lc][this.tileOf(nx, ny)] && this.stepOk(this.tileOf(e.x, e.y), this.tileOf(nx, ny), lc)) {
      e.x = nx;
      e.y = ny;
    }
  }

  // ------------------------------------------------------------ combat

  /**
   * Two-weapon units (the Rocket Team's RPG + AA missile) busy with a ground target they picked themselves:
   * an aircraft that comes inside the AA missile's reach takes over (checked every 8 ticks). A target the
   * player ordered (forced attack) is kept. The launcher swap delay (WEAPON_SWAP) still applies.
   */
  private airPreempt(e: Entity, t: Entity | undefined): Entity | undefined {
    const d = DEFS[e.def];
    if (!t || d.kind !== 'unit' || !d.weapon2 || this.isAir(t) || (this.tick + e.id) % 8 !== 0 || !autoFire(e)) return t;
    if (e.order.type === 'attack' && e.order.forced) return t;
    const a = this.findTarget(e, this.weaponRange(e, WEAPONS[d.weapon2]), true);
    if (!a) return t;
    e.targetId = a.id;
    e.autoTarget = true;
    if (e.order.type === 'attack') e.order = { type: 'attack', target: a.id };
    return a;
  }

  private findTarget(e: Entity, range: number, airOnly = false): Entity | null {
    let best: Entity | null = null;
    let bestScore = Infinity;
    const vis = this.players[e.owner];
    const d0 = DEFS[e.def];
    const two = d0.kind === 'unit' && !!d0.weapon2;
    this.queryRadius(e.x, e.y, range + 2, (t) => {
      if (!this.isEnemy(e.owner, t.owner) || t.dead || t.wound || (airOnly && !this.isAir(t))) return;
      // the weapon for this target (main, or the secondary AA missile); unarmed (kamikaze steering) scans everything
      const wpn = d0.weapon ? this.weaponVs(e.def, t) : null;
      if (d0.weapon && !wpn) return;
      const dist = this.distTo(e, t);
      if (dist > range) return;
      // stealth aircraft: picked up only well inside weapon range (stealth.ts)
      if (wpn && lowObsFactor(this, wpn, t) < 1 && dist > rangeVs(this, e, wpn, t)) return;
      if (vis && !this.sees(e.owner, t)) return;
      let score = dist;
      if (wpn?.aim) {
        // lock-on weapons (sniper.ts): infantry first, no buildings
        const s = aimTargetScore(t);
        if (s === null) return;
        score += s;
      }
      if (t.kind === 'building') {
        const bd = buildingDef(t.def);
        score += bd.weapon ? 3 : 8;
      } else {
        const td = unitDef(t.def);
        if (td.supply) return;
        if (td.weapon) score -= 1;
        if (td.temp) score -= wpn?.air === 'no' ? 0 : 3; // shoot down incoming drones first
        // two weapons (RPG + MANPADS): air threats first, the RPG keeps its own reload for the ground
        if (two && wpn?.air === 'only') score -= 3;
      }
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    });
    return best;
  }

  /**
   * Fire on the move (a plain 'move' order): a soldier keeps walking his path and shoots at any enemy within
   * weapon range, rifle half-raised (MOVE_FIRE_ROF x slower). Never chases: a target that leaves range is
   * dropped. Lock-on weapons (snipers) and indirect fire (mortars) can't shoot on the move. Facing stays on
   * the path (it drives the movement); the aim goes into turret, which the renderer turns him to while he
   * shoots (Entity.moveFireAt).
   */
  private fireOnTheMove(e: Entity, d: UnitDef) {
    let t = this.foe(e.targetId);
    let wpn = t ? this.weaponVs(e.def, t) : undefined;
    if (!t || !wpn || this.distTo(e, t) > rangeVs(this, e, wpn, t)) {
      t = undefined;
      e.targetId = -1;
      if (this.tick < e.scanAt) return;
      e.scanAt = this.tick + 8;
      const main = WEAPONS[d.weapon!];
      t = this.findTarget(e, Math.max(main.range, d.weapon2 ? WEAPONS[d.weapon2].range : 0)) ?? undefined;
      if (!t) return;
      wpn = this.weaponVs(e.def, t);
      if (!wpn || this.distTo(e, t) > rangeVs(this, e, wpn, t)) return;
      e.targetId = t.id;
      e.autoTarget = true;
    }
    if (!wpn || wpn.aim || wpn.flight === 'mortar' || wpn.flight === 'artillery' || wpn.spawn) return;
    if (wpn.minRange && this.distTo(e, t) < wpn.minRange) return;
    e.turret = Math.atan2(t.y - e.y, t.x - e.x);
    e.moveFireAt = this.tick;
    const alt = wpn.id !== d.weapon;
    if ((alt ? e.cooldown2 : e.cooldown) > 0 || e.burstLeft !== 0) return;
    e.burstLeft = wpn.burst ?? 1;
    e.burstTimer = 0;
    e.burstWpn = alt ? wpn.id : '';
    const rof = Math.round(wpn.rof * RANK_ROF[e.rank] * MOVE_FIRE_ROF);
    if (alt) e.cooldown2 = rof;
    else e.cooldown = rof;
    if (d.weapon2) {
      if (alt) e.cooldown = Math.max(e.cooldown, WEAPON_SWAP);
      else e.cooldown2 = Math.max(e.cooldown2, WEAPON_SWAP);
    }
  }

  /** Aim and fire at a target. Returns 'fired' | 'aiming' | 'out' (out of range). */
  private engage(e: Entity, t: Entity): 'aiming' | 'out' {
    const d = DEFS[e.def];
    const wpn = this.weaponVs(e.def, t);
    if (!wpn) return 'out';
    // (cannot fire yet: a diver swims in closer, a submarine coming up waits for its target to be in range: submerge.ts)
    const blocked = !canFireNow(e);
    if (blocked && !holdsWhenBlocked(e)) return 'out';
    const dist = this.distTo(e, t);
    // the secondary weapon (UnitDef.weapon2) reloads on its own clock
    const alt = wpn.id !== d.weapon;
    if (dist > rangeVs(this, e, wpn, t) || (wpn.minRange && dist < wpn.minRange) || (wpn.aim && !aimSees(this, e, t))) {
      if (wpn.aim) cancelAim(e); // target left range / sight: the lock is lost (sniper.ts)
      return 'out';
    }
    if (blocked) return 'aiming';
    const want = Math.atan2(t.y - e.y, t.x - e.x);
    let aligned: boolean;
    if (d.kind === 'building') {
      e.turret = turnToward(e.turret, want, 0.25);
      aligned = Math.abs(angleDiff(e.turret, want)) < 0.2;
    } else if ((d as UnitDef).turret) {
      e.turret = turnToward(e.turret, want, 0.16);
      aligned = Math.abs(angleDiff(e.turret, want)) < 0.12;
    } else {
      const ud = d as UnitDef;
      e.facing = turnToward(e.facing, want, ud.category === 'infantry' ? 1 : ud.turnRate);
      e.turret = e.facing;
      aligned = Math.abs(angleDiff(e.facing, want)) < 0.15;
    }
    if (wpn.aim) {
      // lock-on weapon (sniper.ts): hold the aim, then release the shot this very tick
      if (aimStep(this, e, t, wpn) && aligned && e.cooldown <= 0 && e.burstLeft === 0) {
        e.burstLeft = 1;
        e.burstTimer = 0;
        e.burstWpn = '';
        e.cooldown = Math.round(wpn.rof * RANK_ROF[e.rank]);
        this.processBurst(e);
        if (t.dead) cancelAim(e);
      }
      return 'aiming';
    }
    // one weapon at a time: a new burst only once the previous one (of either weapon) is out
    if (aligned && (alt ? e.cooldown2 : e.cooldown) <= 0 && e.burstLeft === 0) {
      e.burstLeft = wpn.burst ?? 1;
      e.burstTimer = 0;
      e.burstWpn = alt ? wpn.id : '';
      if (alt) e.cooldown2 = Math.round(wpn.rof * RANK_ROF[e.rank]);
      else e.cooldown = Math.round(wpn.rof * RANK_ROF[e.rank]);
      // two launchers: putting one down and shouldering the other takes a moment
      if (d.kind === 'unit' && d.weapon2) {
        if (alt) e.cooldown = Math.max(e.cooldown, WEAPON_SWAP);
        else e.cooldown2 = Math.max(e.cooldown2, WEAPON_SWAP);
      }
    }
    return 'aiming';
  }

  private processBurst(e: Entity) {
    if (e.burstLeft <= 0) return;
    if (e.burstTimer > 0) {
      e.burstTimer--;
      return;
    }
    const t = this.foe(e.targetId);
    const d = DEFS[e.def];
    if (!t || !d.weapon) {
      e.burstLeft = 0;
      return;
    }
    const wpn = WEAPONS[e.burstWpn || d.weapon];
    if (!this.canHit(wpn, t)) {
      e.burstLeft = 0; // the target changed (landed / took off) mid-burst
      return;
    }
    this.fire(e, t, wpn.id);
    e.burstLeft--;
    e.burstTimer = wpn.burstDelay ?? 0;
  }

  private fire(e: Entity, t: Entity, weaponId: string) {
    const wpn = WEAPONS[weaponId];
    let tx = t.x;
    let ty = t.y;
    if ((wpn.flight === 'artillery' || wpn.flight === 'rocketSalvo' || wpn.flight === 'ballistic' || wpn.flight === 'mortar') && !wpn.precise) {
      const spread = wpn.flight === 'rocketSalvo' ? 1.1 : 0.7;
      tx += this.rng.range(-spread, spread);
      ty += this.rng.range(-spread, spread);
    }
    e.firedAt = this.tick;
    muzzleFlash(this, e); // gives the shooter away by night (night.ts)
    this.events.push({ t: 'fire', id: e.id, weapon: weaponId, x: e.x, y: e.y, tx, ty, targetId: t.id, owner: e.owner });
    if (wpn.projectile === 'spawn') {
      const m = this.spawnUnit(munitionDef(DEFS[e.def].faction, wpn.spawn!), e.owner, e.x, e.y);
      m.z = m.pz = e.kind === 'unit' && this.isAir(e) ? e.z : 0.35;
      m.facing = m.pfacing = m.turret = m.pturret = Math.atan2(t.y - e.y, t.x - e.x) + this.rng.range(-0.6, 0.6);
      m.order = { type: 'attack', target: t.id };
      m.targetId = t.id;
      // the launcher is credited with the drone's kill; a veteran crew flies its drones better
      m.spawner = e.id;
      m.rank = e.rank;
      return;
    }
    if (wpn.projectile === 'instant' || wpn.projectile === 'beam') {
      if (evades(this, wpn, t)) {
        // an evasive stealth jet jinks: the burst goes wide (stealth.ts)
        const a = Math.atan2(t.y - e.y, t.x - e.x) + (this.tick % 2 ? 1 : -1) * Math.PI * 0.5;
        this.events.push({ t: 'impact', x: t.x + Math.cos(a) * 0.7, y: t.y + Math.sin(a) * 0.7, z: entityZ(this, t) + 0.2, weapon: weaponId, direct: false, air: true });
        return;
      }
      this.damage(t, wpn.damage, wpn.warhead, e);
      if (wpn.splash) this.splash(tx, ty, wpn.splash, wpn.damage * 0.6, wpn.warhead, e, t.id);
      this.events.push({ t: 'impact', x: tx, y: ty, z: entityZ(this, t), weapon: weaponId, direct: true, air: this.isAir(t) });
      return;
    }
    launch(this, e, t, wpn, tx, ty);
  }

  /** big: a big explosion (medic.ts bigBlast): nobody it brings down is left wounded. */
  splash(x: number, y: number, r: number, dmg: number, warhead: keyof typeof VERSUS, src: Entity, skip: number, big = false) {
    this.queryRadius(x, y, r, (o) => {
      if (o.id === skip || !this.isEnemy(src.owner, o.owner)) return;
      const dist = this.distTo({ x, y } as Entity, o);
      if (dist > r) return;
      this.damage(o, dmg * (1 - dist / (r + 0.01)), warhead, src, false, big);
    });
  }

  /** big: the hit comes from a big explosion (medic.ts bigBlast): a soldier it brings down dies outright. */
  damage(t: Entity, amount: number, warhead: keyof typeof VERSUS, src: Entity, raw = false, big = false) {
    if (!raw && t.inside >= 0) t = garrisonOf(this, t) ?? t; // garrisoned infantry: the house takes the hit (garrison.ts)
    if (t.dead || t.wound || bridgeProof(t)) return; // bridges take damage from impacts (bridges.ts); the wounded lie out of the fight (medic.ts)
    if (t.dive && !canHurtSubmerged(src, t)) return; // submerged: only what its rule lets (submerge.ts)
    const d = DEFS[t.def];
    // veterancy: the shooter's firepower and the target's armour
    amount *= RANK_FIREPOWER[src.rank ?? 0] * RANK_ARMOR[t.rank];
    if (src.inside >= 0 && garrisonOf(this, src)) amount *= GARRISON_FIREPOWER;
    if (!raw && t.passengers.length && isGarrison(t)) amount = garrisonHit(this, t, amount, warhead, src);
    // a jet on its wheels (or a helicopter set down for repair) is soft-skinned, not an aircraft dodging flak (airbase.ts, helipad.ts)
    let dealt = amount * VERSUS[warhead][jetGrounded(t) || heliGrounded(t) ? 'light' : d.armor];
    if (warhead === 'sniper' && d.armor === 'infantry') dealt = Math.max(dealt, t.hp); // one shot, one kill (sniper.ts)
    t.hp -= dealt;
    t.lastHurt = this.tick;
    if (t.owner >= 0 && src.owner !== t.owner) {
      const p = this.players[t.owner];
      t.hitAt = this.tick;
      // a harvester runs home and its owner hears "harvester under attack" (harvest.ts)
      if (t.kind === 'unit' && (d as UnitDef).harvester) harvesterHit(this, t);
      else if (this.tick - p.attackWarnAt > TPS * 12) {
        p.attackWarnAt = this.tick;
        this.events.push({ t: 'underAttack', owner: t.owner, x: t.x, y: t.y });
      }
      // retaliate
      const att = this.get(src.inside >= 0 ? src.inside : src.id); // shots from a garrison / APC: answer the container
      if (att) t.hurtBy = att.spawner >= 0 && this.get(att.spawner) ? att.spawner : att.id; // a drone: blame its launcher
      if (t.kind === 'unit' && d.weapon && autoFire(t) && (t.order.type === 'idle' || t.order.type === 'attackMove') && t.targetId < 0 && att && this.canAttack(t.def, att)) {
        t.targetId = att.id;
        t.autoTarget = true;
      }
    }
    if (t.hp <= 0) {
      // a soldier may go down wounded instead (medic.ts): never to a sniper or a big explosion, never inside anything
      if (canWound(this, t, warhead, big)) woundUnit(this, t, src.owner, src);
      else this.kill(t, src.owner, src);
    }
  }

  /** Dies outright (no wounded state: crushing, the passengers of a destroyed vehicle, a defeated player's army...). */
  kill(t: Entity, by: number, killer?: Entity, cause?: 'crushed') {
    if (t.dead) return;
    t.hp = 0;
    if (t.wound) forgetWounded(this, t);
    releasePatient(this, t); // a medic killed on the job (medic.ts)
    if (t.passengers.length && isGarrison(t)) for (const p of ejectAll(this, t, true)) this.kill(p, by, killer); // garrison.ts
    for (const pid of t.passengers) {
      const p = this.get(pid);
      if (p) this.kill(p, by, killer);
    }
    this.events.push(cause ? { t: 'death', id: t.id, def: t.def, x: t.x, y: t.y, owner: t.owner, kind: t.kind, cause } : { t: 'death', id: t.id, def: t.def, x: t.x, y: t.y, owner: t.owner, kind: t.kind });
    if (t.owner >= 0) this.players[t.owner].stats.lost++;
    if (by >= 0 && by !== t.owner) {
      this.players[by].stats.killed++;
      if (killer) this.creditKill(killer, t);
    }
    this.remove(t);
  }

  /** Veterancy: the unit that destroyed `victim` (or the launcher of the drone that did) gains its value as experience. */
  creditKill(killer: Entity, victim: Entity) {
    let k = this.get(killer.id);
    if (k && k.spawner >= 0) k = this.get(k.spawner);
    if (!k || k.kind !== 'unit' || !this.isEnemy(k.owner, victim.owner) || !canRank(DEFS[k.def])) return;
    k.xp += xpValue(victim.def);
    const rank = rankFor(k.def, k.xp);
    if (rank > k.rank) {
      k.rank = rank;
      this.events.push({ t: 'promoted', id: k.id, owner: k.owner, rank, x: k.x, y: k.y });
    }
  }

  remove(t: Entity) {
    t.dead = true;
    if (t.kind === 'building') this.occupy(t, false);
    if (t.kind === 'unit') {
      for (const b of this.list) if (b.dockedBy === t.id) b.dockedBy = -1;
    }
  }

  // ------------------------------------------------------------ units

  private updateUnit(e: Entity) {
    const d = unitDef(e.def);
    if (d.submerge) updateSubmerged(this, e); // submerged or not, by its rule (submerge.ts)
    if (e.inside >= 0) {
      this.updatePassenger(e, d);
      return;
    }
    if (e.para) {
      this.updatePara(e, d);
      return;
    }
    if (d.supply) {
      this.updateSupply(e);
      return;
    }
    if (d.kamikaze) {
      this.updateKamikaze(e, d);
      return;
    }
    if (e.wound) {
      updateWounded(this, e); // lying wounded, bleeding out (medic.ts)
      return;
    }
    const jammed = e.jammedUntil > this.tick;
    if (jammed) e.cooldown = Math.max(e.cooldown, 2);
    if (d.selfHeal && e.hp < e.maxHp && this.tick % TPS === 0) e.hp = Math.min(e.maxHp, e.hp + d.selfHeal);
    if (e.rank >= ELITE && e.hp < e.maxHp && this.tick % TPS === 0) e.hp = Math.min(e.maxHp, e.hp + e.maxHp * ELITE_HEAL);
    if (e.cooldown > 0) e.cooldown--;
    if (e.cooldown2 > 0) e.cooldown2--;
    this.processBurst(e);
    aimUpkeep(this, e); // sniper lock-on (sniper.ts)
    if (e.dodge && stepDodge(this, e, d)) return; // jumping out of a vehicle's way (crush.ts)
    if (isSortieJet(d)) {
      updateSortie(this, e, d); // airbase sortie cycle (airbase.ts)
      return;
    }
    if (isHeli(d) && updateHeli(this, e, d)) return; // repair trip to the airbase (helipad.ts)
    if (d.air) {
      const alt = d.cruiseAlt ?? (d.model === 'heavy_uav' ? 2.0 : 1.7);
      e.z += Math.max(-0.05, Math.min(0.05, alt - e.z));
    }
    if (d.airlift) {
      this.updateAirlift(e, d);
      return;
    }
    if (e.order.type === 'idle' && (e.queue.length || e.patrol || e.guardId >= 0)) ordersIdle(this, e); // orders.ts
    if (d.medic && updateMedic(this, e, d)) return; // treating the wounded and hurt (medic.ts)
    const o = e.order;
    if (d.weapon && !jammed && o.type !== 'attack' && autoFire(e) && WEAPONS[d.weapon].intercept) tryIntercept(this, e, WEAPONS[d.weapon]);
    switch (o.type) {
      case 'idle':
        this.updateIdle(e, d);
        break;
      case 'move':
        if (this.followPath(e, d)) {
          e.order = { type: 'idle' };
          e.guardX = e.x;
          e.guardY = e.y;
          if (e.landing) arriveLanding(this, e); // a landing craft at the beach (naval.ts)
        }
        // soldiers on the march shoot at what comes into range without stopping
        else if (d.category === 'infantry' && d.weapon && !jammed && autoFire(e)) this.fireOnTheMove(e, d);
        break;
      case 'attackMove': {
        if (d.weapon) {
          let t = this.airPreempt(e, this.foe(e.targetId));
          if (!t && this.tick >= e.scanAt && autoFire(e)) {
            e.scanAt = this.tick + 8;
            t = this.findTarget(e, this.sightOf(e)) ?? undefined;
            if (t) e.targetId = t.id;
          }
          if (t) {
            if (this.engage(e, t) === 'out') {
              if (this.distTo(e, t) > d.sight + 2) e.targetId = -1;
              else this.chase(e, t, d);
            } else {
              e.path = null;
              e.moving = false;
            }
            break;
          }
          e.targetId = -1;
        }
        if (!e.path && Math.hypot(e.x - o.x, e.y - o.y) > 0.3) this.pathTo(e, o.x, o.y);
        if (this.followPath(e, d)) {
          e.order = { type: 'idle' };
          e.guardX = e.x;
          e.guardY = e.y;
        }
        break;
      }
      case 'attack': {
        const t = this.airPreempt(e, this.foe(o.target));
        if (!t || (!this.isEnemy(e.owner, t.owner) && !isBridge(t)) || !d.weapon) {
          e.order = { type: 'idle' };
          e.targetId = -1;
          e.path = null;
          e.moving = false;
          e.guardX = e.x;
          e.guardY = e.y;
          break;
        }
        e.targetId = t.id;
        const aim = this.engage(e, t);
        // infantry in contact: a heavy vehicle runs them over instead of standing off (crush.ts)
        if (aim === 'out' || wantsCrush(this, e, d, t)) this.chase(e, t, d);
        else {
          e.path = null;
          e.moving = false;
        }
        break;
      }
      case 'harvest':
        updateHarvester(this, e, d); // harvest.ts
        break;
      case 'capture': {
        const t = this.get(o.target);
        if (!t || t.kind !== 'building') {
          e.order = { type: 'idle' };
          e.path = null;
          e.guardX = e.x;
          e.guardY = e.y;
          break;
        }
        // If ordered to capture an enemy/neutral building, stop if it is already ours
        if (!o.repair && t.owner === e.owner) {
          e.order = { type: 'idle' };
          e.path = null;
          e.guardX = e.x;
          e.guardY = e.y;
          break;
        }
        // If ordered to repair our building, stop if it is already at full HP or no longer ours
        if (o.repair && (t.owner !== e.owner || t.hp >= t.maxHp)) {
          e.order = { type: 'idle' };
          e.path = null;
          e.guardX = e.x;
          e.guardY = e.y;
          break;
        }
        if (this.distTo(e, t) < 0.75) {
          this.engineerEnter(e, t, o);
          break;
        }
        this.chase(e, t, d);
        break;
      }
      case 'deploy':
        e.order = { type: 'idle' };
        break;
      case 'illum':
        stepIllum(this, e, d); // illumination round (night.ts)
        break;
      case 'enter': {
        const t = this.get(o.target);
        if (t && isCarrier(t)) {
          // boarding a landing craft (naval.ts)
          if (!stepEmbark(this, e, t)) {
            e.order = { type: 'idle' };
            e.path = null;
            e.moving = false;
            e.guardX = e.x;
            e.guardY = e.y;
          }
          break;
        }
        const cap = t && t.kind === 'unit' ? (unitDef(t.def).transport ?? 0) : 0;
        const house = !!t && t.kind === 'building'; // garrisoning a civilian building (garrison.ts)
        if (!t || t.dead || (house ? !isGarrison(t) || (t.owner >= 0 && t.owner !== e.owner) : t.owner !== e.owner || cap <= 0)) {
          e.order = { type: 'idle' };
          e.path = null;
          e.guardX = e.x;
          e.guardY = e.y;
          break;
        }
        const full = house ? garrisonRoom(this, t, e.owner) <= 0 : t.passengers.length >= cap;
        const dist = house ? this.distTo(e, t) : Math.hypot(t.x - e.x, t.y - e.y);
        if (full) {
          // Building / transport is full: walk up beside it and stay stationed next to it
          if (dist < 1.35) {
            e.order = { type: 'idle' };
            e.path = null;
            e.guardX = e.x;
            e.guardY = e.y;
            break;
          }
          this.chase(e, t, d);
          if (!e.path || (house ? this.distTo(e, t) : Math.hypot(t.x - e.x, t.y - e.y)) < 1.35) {
            e.order = { type: 'idle' };
            e.path = null;
            e.guardX = e.x;
            e.guardY = e.y;
          }
          break;
        }
        if (dist < (house ? 0.75 : 0.8)) {
          if (house) {
            if (!enterGarrison(this, e, t)) {
              e.order = { type: 'idle' };
              e.path = null;
              e.guardX = e.x;
              e.guardY = e.y;
            }
          } else this.board(e, t);
          break;
        }
        this.chase(e, t, d);
        break;
      }
    }
  }

  /**
   * Loitering munitions / FPV / swarm drones: cruise at their profile altitude,
   * fan out so a swarm arrives from several directions, weave (FPV), then dive
   * onto the target and detonate on contact.
   */
  private updateKamikaze(e: Entity, d: UnitDef) {
    const jammed = e.jammedUntil > this.tick;
    if (--e.life <= 0 || (jammed && (e.hp -= 2) <= 0)) {
      // out of battery or jammed: crash where it is
      this.events.push({ t: 'impact', x: e.x, y: e.y, z: standHeight(this.map, e.x, e.y) + Math.max(0, e.z * 0.3), weapon: d.weapon!, air: e.z > 0.6 });
      this.kill(e, -1);
      return;
    }
    const prof = d.model === 'shahed' ? { cruise: 2.3, dive: 3.2, weave: 0 } : d.model === 'fpv' ? { cruise: 0.55, dive: 1.3, weave: 0.45 } : { cruise: 1.0, dive: 2.0, weave: 0.15 };
    let t = this.foe(e.targetId);
    if (!t || !this.isEnemy(e.owner, t.owner) || this.isAir(t)) {
      t = this.findTarget(e, 7) ?? undefined;
      e.targetId = t ? t.id : -1;
    }
    const age = TPS * 25 - e.life;
    let gx: number;
    let gy: number;
    let tz = 0.2;
    let dist: number;
    if (t) {
      [gx, gy] = t.kind === 'building' ? this.closestTileOf(e, t) : [t.x, t.y];
      dist = this.distTo(e, t);
      tz = entityZ(this, t) - standHeight(this.map, t.x, t.y);
    } else {
      // loiter in a wide circle
      gx = e.x + Math.cos(e.facing + 0.6) * 3;
      gy = e.y + Math.sin(e.facing + 0.6) * 3;
      dist = 99;
    }
    // swarm: each drone takes its own approach angle, converging at the end
    const spread = (((e.id * 0.61803) % 1) - 0.5) * 1.6 * Math.max(0, Math.min(1, (dist - 1.2) / 5));
    const weave = prof.weave * Math.sin(age * 0.45 + e.id) * Math.min(1, dist / 3);
    let want = Math.atan2(gy - e.y, gx - e.x) + spread + weave;
    // separation from nearby drones of the same wave
    let sx = 0;
    let sy = 0;
    this.queryRadius(e.x, e.y, 0.6, (o) => {
      if (o === e || o.kind !== 'unit' || o.owner !== e.owner || !unitDef(o.def).kamikaze) return;
      const dx = e.x - o.x;
      const dy = e.y - o.y;
      const dd = Math.hypot(dx, dy) || 0.01;
      if (dd < 0.45) {
        sx += dx / dd;
        sy += dy / dd;
      }
    });
    if (sx || sy) want = Math.atan2(Math.sin(want) + sy * 0.6, Math.cos(want) + sx * 0.6);
    e.facing = turnToward(e.facing, want, d.turnRate * 1.4);
    e.turret = e.facing;
    const step = (d.speed / TPS) * (jammed ? 0.35 : 1) * (dist < prof.dive ? 1.25 : 1);
    e.x = Math.max(0.2, Math.min(this.map.w - 0.2, e.x + Math.cos(e.facing) * step));
    e.y = Math.max(0.2, Math.min(this.map.h - 0.2, e.y + Math.sin(e.facing) * step));
    e.moving = true;
    // altitude: climb to cruise, then terminal dive
    const k = Math.max(0, Math.min(1, dist / prof.dive));
    const wantZ = tz + (prof.cruise - tz) * (dist < prof.dive ? k * k : 1);
    e.z += Math.max(-0.12, Math.min(0.06, wantZ - e.z));
    if (!t) return;
    const wpn = WEAPONS[d.weapon!];
    if (dist <= wpn.range && Math.abs(e.z - tz) < 0.5) {
      const big = bigBlast(wpn);
      this.damage(t, wpn.damage, wpn.warhead, e, false, big);
      if (wpn.splash) this.splash(e.x, e.y, wpn.splash, wpn.damage * 0.6, wpn.warhead, e, t.id, big);
      this.events.push({ t: 'impact', x: e.x, y: e.y, z: standHeight(this.map, e.x, e.y) + e.z, weapon: wpn.id, direct: true });
      this.remove(e);
    }
  }

  /** Infantry riding in an APC shoot out of the firing ports. */
  private updatePassenger(e: Entity, d: UnitDef) {
    const apc = this.get(e.inside);
    if (!apc) {
      e.inside = -1;
      return;
    }
    e.x = e.px = apc.x;
    e.y = e.py = apc.y;
    if (e.cooldown > 0) e.cooldown--;
    if (e.cooldown2 > 0) e.cooldown2--;
    this.processBurst(e);
    aimUpkeep(this, e); // sniper lock-on (sniper.ts)
    // (aboard a landing craft nobody fires: the cargo rides below the bulwarks, naval.ts)
    if (!d.weapon || d.engineer || isCarrier(apc)) return;
    let t = this.airPreempt(e, this.foe(e.targetId));
    const tw = t ? this.weaponVs(e.def, t) : null;
    if (t && (!tw || !this.isEnemy(e.owner, t.owner) || this.distTo(e, t) > rangeVs(this, e, tw, t))) t = undefined;
    if (!t && this.tick >= e.scanAt) {
      e.scanAt = this.tick + 8;
      t = this.findTarget(e, this.maxWeaponRange(e)) ?? undefined;
    }
    e.targetId = t ? t.id : -1;
    if (t && this.engage(e, t) === 'out') e.targetId = -1;
  }

  board(e: Entity, apc: Entity) {
    e.inside = apc.id;
    e.dodge = null;
    apc.passengers.push(e.id);
    e.path = null;
    e.moving = false;
    e.order = { type: 'idle' };
    e.targetId = -1;
  }

  private unload(apc: Entity) {
    for (const pid of apc.passengers) {
      const p = this.get(pid);
      if (!p) continue;
      p.inside = -1;
      const spot = this.nearestPassable(apc.x - Math.cos(apc.facing) * 0.8, apc.y - Math.sin(apc.facing) * 0.8, 4, this.regionOf(apc.x, apc.y, Loco.Foot), Loco.Foot);
      const [x, y] = spot ? [spot[0] + 0.5, spot[1] + 0.5] : [apc.x, apc.y];
      p.x = p.px = x + this.rng.range(-0.2, 0.2);
      p.y = p.py = y + this.rng.range(-0.2, 0.2);
      p.order = { type: 'idle' };
      p.guardX = p.x;
      p.guardY = p.y;
    }
    apc.passengers = [];
  }

  private updateIdle(e: Entity, d: UnitDef) {
    if (e.path) this.followPath(e, d);
    else e.moving = false;
    if (d.harvester) {
      if (++e.idleTicks > TPS * 6) {
        e.idleTicks = 0;
        e.order = { type: 'harvest' };
        e.hstate = e.cargo > 0 ? 'toRefinery' : 'seek';
      }
      return;
    }
    if (!d.weapon) return;
    let t = this.foe(e.targetId);
    if (t && (!this.isEnemy(e.owner, t.owner) || !autoFire(e))) t = undefined;
    t = this.airPreempt(e, t);
    if (!t && this.tick >= e.scanAt && autoFire(e)) {
      e.scanAt = this.tick + 10;
      t = this.findTarget(e, scanRange(this, e, d)) ?? undefined;
    }
    if (!t) {
      e.targetId = -1;
      // drift back to guard position after a chase (stance: hold stays, aggressive makes this its post)
      if (!e.path && Math.hypot(e.x - e.guardX, e.y - e.guardY) > 1.5 && idleReturn(e) === 'return') this.pathTo(e, e.guardX, e.guardY);
      return;
    }
    e.targetId = t.id;
    if (this.engage(e, t) === 'out') {
      // leash: don't chase far from where we were told to stand
      if (Math.hypot(t.x - e.guardX, t.y - e.guardY) > leashRange(e, d) || e.stance === 'hold' || (this.weaponVs(e.def, t)?.minRange ?? 0) > this.distTo(e, t)) {
        e.targetId = -1;
        return;
      }
      this.chase(e, t, d);
    } else {
      e.path = null;
      e.moving = false;
    }
  }

  private chase(e: Entity, t: Entity, d: UnitDef) {
    const goal = t.kind === 'building' ? this.closestTileOf(e, t) : [t.x, t.y];
    const goalTile = this.tileOf(goal[0], goal[1]);
    if (!e.path || this.tick >= e.repathAt || (e.moveGoal !== goalTile && this.tick % 10 === e.id % 10)) {
      this.pathTo(e, goal[0], goal[1]);
      e.repathAt = this.tick + 30;
    }
    this.followPath(e, d);
  }

  private closestTileOf(e: Entity, b: Entity): [number, number] {
    const d = buildingDef(b.def);
    const cx = Math.max(b.tx - 0.5, Math.min(b.tx + d.w + 0.5, e.x));
    const cy = Math.max(b.ty - 0.5, Math.min(b.ty + d.h + 0.5, e.y));
    return [cx, cy];
  }

  private engineerEnter(e: Entity, t: Entity, o?: { repair?: boolean }) {
    if (t.def === 'bridgehut') {
      if (bridgeHutEnter(this, t, e)) this.remove(e);
      else {
        e.order = { type: 'idle' };
        e.path = null;
      }
      return;
    }
    const td = buildingDef(t.def);
    if (td.garrison && t.owner !== e.owner) {
      e.order = { type: 'idle' }; // engineers can't clear or capture civilian buildings (garrison.ts)
      e.path = null;
      return;
    }
    if (t.owner === e.owner) {
      // If the engineer was ordered to capture an enemy/neutral building, but it is already ours:
      // He cannot enter it and stands outside!
      if (o && !o.repair) {
        e.order = { type: 'idle' };
        e.path = null;
        return;
      }
      // If repairing our building, only enter if it's damaged
      if (t.hp < t.maxHp) {
        t.hp = t.maxHp;
        this.remove(e);
      } else {
        e.order = { type: 'idle' };
        e.path = null;
      }
      return;
    } else if (t.owner === -1 ? td.capturable : true) {
      const old = t.owner;
      t.owner = e.owner;
      t.repairing = false;
      t.dockedBy = -1;
      t.targetId = -1;
      this.events.push({ t: 'captured', id: t.id, owner: e.owner });
      if (old >= 0) this.players[old].stats.lost++;
      this.remove(e);
    } else {
      e.order = { type: 'idle' };
      e.path = null;
      return;
    }
  }

  // ------------------------------------------------------------ harvesting

  private growOre() {
    const { w, h, ore, oreKind, oreMines } = this.map;
    if (this.tick % (TPS * 6) === 0) {
      for (let i = 0; i < ore.length; i++) if (ore[i] > 0 && ore[i] < ORE_MAX && this.rng.next() < 0.15) ore[i]++;
    }
    if (this.tick % (TPS * 4) === 0) {
      for (const m of oreMines) {
        const x = m.x + this.rng.int(7) - 3;
        const y = m.y + this.rng.int(7) - 3;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = y * w + x;
        if (!tileOpen(this.map, x, y) && ore[i] === 0) continue;
        if (this.occ[i] || !this.pass[i]) continue;
        const kind = oreKind[i] || oreKind[m.y * w + m.x] || 1;
        if (ore[i] < ORE_MAX) {
          ore[i] = Math.min(ORE_MAX, ore[i] + 2);
          oreKind[i] = kind;
        }
      }
    }
  }

  // ------------------------------------------------------------ buildings

  private updateBuilding(b: Entity) {
    const d = buildingDef(b.def);
    if (b.buildAnim < 1) b.buildAnim = Math.min(1, b.buildAnim + 1 / (TPS * 1.5));
    if (b.cooldown > 0) b.cooldown--;
    if (b.owner < 0) return;
    const p = this.players[b.owner];
    const unpowered = this.isLowPower(p) && (d.category === 'defense' || !!d.needsPower);
    if (d.weapon && b.buildAnim >= 1 && !unpowered) {
      this.processBurst(b);
      const bw = WEAPONS[d.weapon];
      if (bw.intercept) tryIntercept(this, b, bw);
      const range = this.weaponRange(b, bw);
      let t = this.foe(b.targetId);
      if (t && (this.distTo(b, t) > rangeVs(this, b, bw, t) || !this.isEnemy(b.owner, t.owner))) t = undefined;
      if (!t && this.tick >= b.scanAt) {
        b.scanAt = this.tick + 6;
        t = this.findTarget(b, range) ?? undefined;
      }
      b.targetId = t ? t.id : -1;
      if (t) this.engage(b, t);
    } else if (unpowered) {
      b.targetId = -1;
    }
    if (b.repairing) {
      if (b.hp >= b.maxHp) b.repairing = false;
      else if (this.tick % 5 === 0) {
        const heal = Math.min(b.maxHp - b.hp, b.maxHp * 0.012);
        const cost = Math.ceil(((d.cost || 500) * heal) / b.maxHp / 2);
        if (p.credits >= cost) {
          p.credits -= cost;
          b.hp += heal;
        }
      }
    }
    if (d.income && ++b.incomeTimer >= TPS * 3) {
      b.incomeTimer = 0;
      p.credits += d.income;
    }
    if (b.dockedBy >= 0 && !this.get(b.dockedBy)) b.dockedBy = -1;
  }

  // ------------------------------------------------------------ production

  private updateEconomy() {
    const airfield = new Uint8Array(this.players.length);
    for (const p of this.players) {
      p.powerOut = 0;
      p.powerUse = 0;
      p.radarOnline = false;
    }
    for (const e of this.list) {
      if (e.dead || e.kind !== 'building' || e.owner < 0) continue;
      const d = buildingDef(e.def);
      const p = this.players[e.owner];
      if (d.power > 0) p.powerOut += Math.round(d.power * (0.5 + 0.5 * (e.hp / e.maxHp)));
      else p.powerUse -= d.power;
      if (d.role === 'radar') p.radarOnline = true;
      if (d.role === 'airfield' && e.buildAnim >= 1) airfield[e.owner] = 1;
    }
    for (const p of this.players) if (this.isLowPower(p)) p.radarOnline = false;
    // airborne-drop support power: charges while an airfield stands (paused on low power), locked without one
    for (const p of this.players) {
      if (!airfield[p.id]) p.airdropAt = -1;
      else if (p.airdropAt < 0) {
        p.airdropFrom = this.tick;
        p.airdropAt = this.tick + AIRDROP_FIRST;
      } else if (this.tick < p.airdropAt && this.isLowPower(p)) {
        p.airdropAt++;
        p.airdropFrom++;
      }
    }
    for (const p of this.players) {
      if (p.defeated) continue;
      const low = this.isLowPower(p);
      if (low && !p.lowPowerWarned) {
        p.lowPowerWarned = true;
        this.events.push({ t: 'lowPower', owner: p.id });
      } else if (!low) p.lowPowerWarned = false;
      for (const cat of CATEGORIES) this.updateQueue(p, cat, low);
    }
  }

  private producerCount(p: Player, cat: Category) {
    let n = 0;
    for (const e of this.list) {
      if (e.dead || e.owner !== p.id || e.kind !== 'building') continue;
      const d = buildingDef(e.def);
      if (cat === 'building' || cat === 'defense' ? d.role === 'conyard' : d.produces === cat) n++;
    }
    return n;
  }

  private updateQueue(p: Player, cat: Category, low: boolean) {
    const q = p.queues[cat];
    if (q.length === 0 || p.ready[cat]) return;
    const item = q[0];
    const d = DEFS[item.def];
    if (!this.canBuild(p.id, item.def, true)) {
      // lost prerequisite (or the jet cap shrank with a lost airbase): refund and drop
      p.credits += item.paid;
      q.shift();
      return;
    }
    // (a carrier's air wing is built for its deck: the carrier is its producer)
    const n = d.kind === 'unit' && d.deckJet ? 1 : this.producerCount(p, cat);
    if (n === 0) return;
    const speed = (1 + 0.5 * Math.min(3, n - 1)) * (low ? 0.4 : 1);
    const delta = Math.min(1 - item.progress, speed / (d.buildTime * TPS));
    const cost = Math.min(d.cost - item.paid, d.cost * delta);
    if (p.credits < cost) {
      if (this.tick - p.noFundsWarnAt > TPS * 10) {
        p.noFundsWarnAt = this.tick;
        this.events.push({ t: 'noFunds', owner: p.id });
      }
      return;
    }
    p.credits -= cost;
    item.paid += cost;
    item.progress += delta;
    if (item.progress >= 0.9999) {
      q.shift();
      if (d.kind === 'building') {
        p.ready[cat] = d.id;
        this.events.push({ t: 'buildingReady', owner: p.id, def: d.id });
      } else {
        this.deliverUnit(p, d as UnitDef);
        if (p.repeat?.[cat]) q.push({ def: d.id, progress: 0, paid: 0 }); // repeat-build
      }
    }
  }

  private deliverUnit(p: Player, d: UnitDef) {
    if (d.naval) {
      deliverNaval(this, p.id, d); // out of the Shipyard's slipway (naval.ts)
      return;
    }
    if (d.deckJet) {
      // a carrier's jet: onto a free deck pad (airbase.ts)
      const c = carrierWithPad(this, p.id);
      if (!c) return;
      const u = this.spawnUnit(d.id, p.id, c.x, c.y);
      parkJet(this, u, c);
      this.events.push({ t: 'unitReady', owner: p.id, def: d.id });
      return;
    }
    let factory: Entity | null = null;
    for (const e of this.list) {
      if (e.dead || e.owner !== p.id || e.kind !== 'building') continue;
      if (buildingDef(e.def).produces === d.category) {
        factory = e;
        if (e.rallyX >= 0) break;
      }
    }
    if (!factory) return;
    if (isSortieJet(d)) {
      // combat jets roll out onto a free parking pad of an airbase (airbase.ts)
      let pads: Entity | null = null;
      for (const e of this.list) {
        if (e.dead || e.owner !== p.id || e.kind !== 'building' || buildingDef(e.def).role !== 'airfield' || e.buildAnim < 1) continue;
        if (freePad(this, e) >= 0) {
          pads = e;
          break;
        }
      }
      if (!pads) return;
      const u = this.spawnUnit(d.id, p.id, pads.x, pads.y);
      parkJet(this, u, pads);
      this.events.push({ t: 'unitReady', owner: p.id, def: d.id });
      return;
    }
    const fd = buildingDef(factory.def);
    const ex = fd.exit ?? [Math.floor(fd.w / 2), fd.h];
    let [sx, sy] = layoutTile(factory, ex[0], ex[1]);
    if (!d.air && !this.pf.passable(sx, sy)) {
      const lc = locoOf(d);
      const np = this.nearestPassable(sx + 0.5, sy + 0.5, 12, this.regionOf(factory.x, factory.y, lc), lc);
      if (!np) return;
      [sx, sy] = np;
    }
    const u = this.spawnUnit(d.id, p.id, sx + 0.5, sy + 0.5);
    u.facing = u.pfacing = u.turret = u.pturret = factory.flip ? -Math.PI / 2 : Math.PI / 2;
    this.events.push({ t: 'unitReady', owner: p.id, def: d.id });
    if (d.harvester) return;
    // default rally: just out of the exit side (south, or north for a turned building, turn.ts)
    const rx = factory.rallyX >= 0 ? factory.rallyX : factory.tx + fd.w / 2 + this.rng.range(-1.5, 1.5) * (factory.flip ? -1 : 1);
    const ry = factory.rallyY >= 0 ? factory.rallyY : factory.flip ? factory.ty - 2 - this.rng.range(0, 1.5) : factory.ty + fd.h + 2 + this.rng.range(0, 1.5);
    this.formationMove([u], rx, ry, false);
    u.guardX = rx;
    u.guardY = ry;
  }

  /** Electronic warfare jamming and field repair auras. */
  private updateAuras() {
    for (const e of this.list) {
      if (e.dead || e.kind !== 'unit') continue;
      const d = unitDef(e.def);
      if (d.ewRadius && this.tick % 10 === 0) {
        this.queryRadius(e.x, e.y, d.ewRadius, (o) => {
          if (this.isAir(o) && this.isEnemy(e.owner, o.owner) && Math.hypot(o.x - e.x, o.y - e.y) <= d.ewRadius!) o.jammedUntil = this.tick + 14;
        });
      }
      if (d.repairAura && this.tick % 20 === 0) {
        this.queryRadius(e.x, e.y, d.repairAura, (o) => {
          if (o === e || o.owner !== e.owner || o.kind !== 'unit' || o.hp >= o.maxHp) return;
          const od = unitDef(o.def);
          if (od.category !== 'vehicle' || Math.hypot(o.x - e.x, o.y - e.y) > d.repairAura!) return;
          o.hp = Math.min(o.maxHp, o.hp + o.maxHp * 0.025);
        });
      }
    }
  }

  // ------------------------------------------------------------ visibility

  updateVisibility() {
    const { w, h } = this.map;
    for (const p of this.players) p.visible.fill(0);
    // air defence sensors keep their daytime reach against aircraft by night (night.ts)
    const night = this.nightLevel > 0;
    if (night) for (const p of this.players) p.airVisible.fill(0);
    const radar = (p: Player, cx: number, cy: number, r: number) => {
      for (const [ox, oy] of disc(r)) {
        const x = cx + ox;
        const y = cy + oy;
        if (x >= 0 && y >= 0 && x < w && y < h) p.airVisible[y * w + x] = 1;
      }
    };
    const reveal = (p: Player, cx: number, cy: number, r: number) => {
      for (const [ox, oy] of disc(r)) {
        const x = cx + ox;
        const y = cy + oy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = y * w + x;
        p.visible[i] = 1;
        p.explored[i] = 1;
      }
    };
    for (const e of this.list) {
      if (e.dead || e.owner < 0) continue;
      // (by night ordinary units see half as far, night vision keeps its full sight: night.ts)
      reveal(this.players[e.owner], Math.floor(e.x), Math.floor(e.y), Math.round(this.sightOf(e)));
      if (night && DEFS[e.def].airSensor && e.inside < 0) radar(this.players[e.owner], Math.floor(e.x), Math.floor(e.y), Math.round(DEFS[e.def].sight));
      // base floodlights by night (powered structures)
      if (e.kind === 'building' && this.night && floodlit(this, e)) {
        const [fx, fy] = floodCentre(e);
        reveal(this.players[e.owner], Math.floor(fx), Math.floor(fy), FLOOD_RADIUS);
      }
    }
    // illumination flares: their owner sees the lit area as by day
    for (const f of this.flares) if (flareLit(f, this.tick) && this.players[f.owner]) reveal(this.players[f.owner], Math.floor(f.x), Math.floor(f.y), FLARE_RADIUS);
    // classic (RA2, by day): explored ground stays revealed for good while powered; on low power vision cuts to direct line-of-sight
    if (this.fog === 'classic') {
      for (const p of this.players) {
        if (!this.isLowPower(p)) p.visible.set(p.explored);
      }
    }
  }

  // ------------------------------------------------------------ victory

  private checkVictory() {
    let alive = 0;
    let last = -1;
    for (const p of this.players) {
      if (p.defeated) continue;
      let ok = false;
      for (const e of this.list) {
        if (e.dead || e.owner !== p.id) continue;
        if ((e.kind === 'building' && DEFS[e.def].faction !== 'neutral') || (e.kind === 'unit' && unitDef(e.def).mcv)) {
          ok = true;
          break;
        }
      }
      if (!ok) {
        p.defeated = true;
        this.events.push({ t: 'defeated', owner: p.id });
        for (const e of this.list) {
          if (e.dead || e.owner !== p.id) continue;
          // captured tech structures / garrisoned houses go back to neutral (their garrison dies with the player)
          if (e.kind === 'building' && DEFS[e.def].faction === 'neutral') {
            for (const id of e.passengers) {
              const u = this.get(id);
              if (u) this.kill(u, -1);
            }
            e.passengers = [];
            e.owner = -1;
            e.targetId = -1;
            continue;
          }
          this.kill(e, -1);
        }
      } else {
        alive++;
        last = p.id;
      }
    }
    if (alive <= 1 && !this.over) {
      this.over = true;
      this.winner = last;
      this.events.push({ t: 'gameOver', winner: last });
    }
  }

  // ------------------------------------------------------------ main tick

  step() {
    this.tick++;
    const ev0 = this.events.length;
    for (const e of this.list) {
      e.px = e.x;
      e.py = e.y;
      e.pfacing = e.facing;
      e.pturret = e.turret;
      e.pz = e.z;
    }
    const cmds = this.pending;
    if (cmds.length > 0) {
      this.pending = [];
      for (let i = 0; i < cmds.length; i++) this.applyCommand(cmds[i].player, cmds[i].cmd);
    }

    this.rebuildGrid();
    updateBaseDefense(this); // idle units near an attacked base engage on their own (basedefense.ts)
    this.updateEconomy();
    updateTechs(this); // captured tech structures (capture.ts)
    updateSuperweapons(this); // superweapon timers, salvos, Iron Beam (superweapons.ts)
    const n = this.list.length;
    for (let i = 0; i < n; i++) {
      const e = this.list[i];
      if (e.dead) continue;
      if (e.kind === 'unit') this.updateUnit(e);
      else this.updateBuilding(e);
    }
    stepProjectiles(this);
    updateNaval(this); // dockside repair (naval.ts)
    updateGarrisons(this); // garrison.ts
    updateBridges(this, ev0);
    this.updateAuras();
    this.separate();
    updateCrush(this); // vehicles run over enemy infantry, infantry jump out of the way (crush.ts)
    this.growOre();
    updateFlares(this); // burnt-out illumination flares go (night.ts)
    if (this.tick % 4 === 0) {
      // the day clock moves the night rules on at the fog cadence (clock.ts, night.ts)
      this.updateNight();
      this.updateVisibility();
    }
    if (this.tick % TPS === 0) this.checkVictory();
    if (this.tick % 50 === 0) {
      let write = 0;
      for (let i = 0; i < this.list.length; i++) {
        const e = this.list[i];
        if (e.dead) {
          this.entities.delete(e.id);
        } else {
          this.list[write++] = e;
        }
      }
      this.list.length = write;
    }
    for (const c of this.controllers) c.update();
  }

  private static readonly EMPTY_EVENTS: SimEvent[] = [];

  drainEvents(): SimEvent[] {
    if (this.events.length === 0) return World.EMPTY_EVENTS;
    const ev = this.events;
    this.events = [];
    return ev;
  }
}

export type { BuildingDef, UnitDef };
