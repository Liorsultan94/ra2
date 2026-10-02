// Core simulation types. The simulation is deterministic and driven only by
// commands, so it can later run in lockstep over the network.

export const TPS = 20; // simulation ticks per second
export const TICK_MS = 1000 / TPS;

export type Faction = 'usa' | 'israel' | 'china' | 'russia' | 'germany' | 'korea' | 'ukraine' | 'turkey' | 'iran';
export type ArmorClass = 'infantry' | 'light' | 'heavy' | 'building' | 'aircraft';
export type Warhead = 'mg' | 'cannon' | 'rocket' | 'artillery' | 'flak' | 'missile' | 'laser' | 'thermo';
export type ProjectileKind = 'instant' | 'shell' | 'rocket' | 'beam' | 'artillery' | 'missile' | 'spawn';

/** Physical flight model of a travelling projectile. */
export type Flight =
  | 'shell' // flat fast ballistic (tank gun)
  | 'artillery' // high ballistic arc
  | 'mortar' // very high arc, slow
  | 'rocketSalvo' // unguided MLRS / thermobaric rockets
  | 'atgm' // guided direct-attack missile (RPG/ATGM/Hellfire)
  | 'topAttack' // climbs then dives onto the roof of the target (Javelin style)
  | 'sam' // vertical launch surface-to-air missile with proportional navigation
  | 'interceptor' // Iron Dome style interceptor
  | 'airMissile' // air-launched guided missile
  | 'ballistic' // boost, apogee, steep terminal dive
  | 'hypersonic' // boost then manoeuvring glide
  | 'cruise'; // subsonic, terrain-hugging, dog-leg route, pop-up and terminal dive

/** Flights that air defences can shoot down. */
export const INTERCEPTABLE: Flight[] = ['artillery', 'mortar', 'rocketSalvo', 'ballistic', 'hypersonic', 'cruise'];
export type Category = 'building' | 'defense' | 'infantry' | 'vehicle' | 'air';
export const CATEGORIES: Category[] = ['building', 'defense', 'infantry', 'vehicle', 'air'];

export interface WeaponDef {
  id: string;
  damage: number;
  range: number; // tiles
  minRange?: number;
  rof: number; // ticks between bursts
  burst?: number;
  burstDelay?: number;
  warhead: Warhead;
  projectile: ProjectileKind;
  speed?: number; // tiles per tick for travelling projectiles
  splash?: number; // tiles
  air: 'no' | 'yes' | 'only'; // can it hit aircraft?
  flight?: Flight; // physical model for travelling projectiles
  munition?: string; // visual munition kind (render)
  /**
   * Air-defence weapons: projectile flights they can engage and the hit probability per engagement.
   * pkBy overrides pk per threat flight (pkHypersonic is the legacy hypersonic override).
   * ceiling: highest altitude (above the battery) it can engage at, so high-apogee missiles are only
   * vulnerable in their terminal dive (default 9).
   * layer: fire a different interceptor (another weapon id, with its own pk / munition) at these
   * threat kinds, e.g. Iron Dome batteries cueing David's Sling Stunners against ballistic missiles.
   */
  intercept?: { kinds: Flight[]; pk: number; pkHypersonic?: number; pkBy?: Partial<Record<Flight, number>>; ceiling?: number; layer?: { kinds: Flight[]; weapon: string } };
  /** Interceptable munitions: successful intercepts needed to destroy one round (default 1). */
  interceptHp?: number;
  /** Interceptable munitions: fraction of a defence's range at which it is detected (cruise missiles; default 1). */
  lowObservable?: number;
  /** Analytic flights: apogee (arc height) multiplier, e.g. < 1 for depressed quasi-ballistic trajectories. */
  apogee?: number;
  /** Analytic flights: flight-time multiplier (> 1 = slower). */
  flightTime?: number;
  /** Ballistic: amplitude (tiles) of evasive weaving in the terminal phase; interceptors lose pk against it. */
  maneuver?: number;
  spawn?: string; // unit launched by a 'spawn' weapon (drones)
  precise?: boolean; // artillery without scatter
}

export interface BaseDef {
  id: string;
  name: string;
  faction: Faction | 'neutral';
  category: Category;
  cost: number;
  buildTime: number; // seconds
  hp: number;
  armor: ArmorClass;
  sight: number;
  weapon?: string;
  prereq: string[]; // building roles
  desc: string;
  buildable: boolean;
  model: string;
  aiWeight?: number;
  aiTag?: 'main' | 'aa' | 'arty' | 'support' | 'scout';
}

export interface UnitDef extends BaseDef {
  kind: 'unit';
  category: 'infantry' | 'vehicle' | 'air';
  speed: number; // tiles per second
  turnRate: number; // radians per tick
  turret: boolean;
  radius: number;
  harvester?: boolean;
  mcv?: boolean;
  engineer?: boolean;
  selfHeal?: number; // hp per second
  air?: boolean;
  kamikaze?: boolean;
  temp?: boolean; // spawned munition: not selectable, expires
  aps?: number; // active protection: chance to intercept rockets / missiles
  ewRadius?: number; // electronic warfare jamming radius vs drones
  repairAura?: number; // repairs friendly vehicles within radius
  transport?: number; // infantry capacity
  fixedWing?: boolean; // jets: always moving, attack in passes
  cruiseAlt?: number; // flight altitude above ground
  airlift?: boolean; // support-power transport plane: flies a straight drop run, then leaves the map
  supply?: boolean; // air-dropped supply pallet: heals friendly units nearby, then expires
}

export interface BuildingDef extends BaseDef {
  kind: 'building';
  category: 'building' | 'defense';
  role: string;
  w: number;
  h: number;
  power: number;
  passable?: [number, number][]; // local tiles units can drive through
  exit?: [number, number]; // local spawn tile for produced units
  dock?: [number, number]; // local tile a harvester unloads on
  needsPower?: boolean;
  produces?: 'infantry' | 'vehicle' | 'air';
  income?: number; // credits per income interval (oil derricks)
  capturable?: boolean;
}

export type Def = UnitDef | BuildingDef;

export type Order =
  | { type: 'idle' }
  | { type: 'move'; x: number; y: number }
  | { type: 'attackMove'; x: number; y: number }
  | { type: 'attack'; target: number; forced?: boolean }
  | { type: 'harvest' }
  | { type: 'capture'; target: number }
  | { type: 'enter'; target: number }
  | { type: 'deploy' };

/** Support-power transport on its drop run (sim state, read by the renderer for the ramp door). */
export interface DropRun {
  x: number; // drop zone centre
  y: number;
  dx: number; // unit flight direction
  dy: number;
  jumpers: string[]; // defs still aboard, in exit order
  crate: boolean; // supply pallet aboard
  phase: 'inbound' | 'dropping' | 'outbound';
  next: number; // tick of the next exit
  ramp: number; // 1 while the ramp door is open
  closeAt: number; // tick the ramp closes after the stick has gone
}

/** Parachute descent (jumpers and supply pallets); the landing point is guardX / guardY. */
export interface ParaState {
  t: number; // ticks of descent left
  T: number; // total descent ticks
  z0: number; // exit altitude
  x0: number; // exit point
  y0: number;
}

export type HarvestState = 'seek' | 'toOre' | 'mining' | 'toRefinery' | 'unloading';

export interface Entity {
  id: number;
  def: string;
  kind: 'unit' | 'building';
  owner: number; // player index, -1 = neutral
  x: number;
  y: number;
  px: number;
  py: number;
  facing: number;
  turret: number;
  pfacing: number;
  pturret: number;
  hp: number;
  maxHp: number;
  dead: boolean;

  order: Order;
  path: number[] | null;
  pathIdx: number;
  repathAt: number;
  stuckTicks: number;
  progX: number;
  progY: number;
  progAt: number;
  moveGoal: number; // tile index of current path goal, -1 if none
  slotX: number; // sub-tile offset for infantry
  slotY: number;
  moving: boolean;

  targetId: number;
  autoTarget: boolean;
  cooldown: number;
  burstLeft: number;
  burstTimer: number;
  scanAt: number;
  guardX: number;
  guardY: number;

  // harvester
  cargo: number;
  hstate: HarvestState;
  htimer: number;
  oreTile: number;

  // building
  tx: number;
  ty: number;
  buildAnim: number; // 0..1 construction rise animation
  rallyX: number;
  rallyY: number;
  repairing: boolean;
  incomeTimer: number;
  z: number; // altitude above ground (aircraft)
  pz: number;
  inside: number; // transport id when riding inside an APC, else -1
  passengers: number[];
  life: number; // ticks left for temporary units, -1 = permanent
  jammedUntil: number;
  dockedBy: number;
  idleTicks: number;

  lastHurt: number;
  firedAt: number;
  drop: DropRun | null; // airlift transports only
  para: ParaState | null; // under canopy
}

export interface QueueItem {
  def: string;
  progress: number; // 0..1
  paid: number;
}

export interface Player {
  id: number;
  name: string;
  faction: Faction;
  color: number;
  isAI: boolean;
  credits: number;
  powerOut: number;
  powerUse: number;
  queues: Record<Category, QueueItem[]>;
  ready: Record<Category, string | null>; // completed building awaiting placement
  explored: Uint8Array;
  visible: Uint8Array;
  defeated: boolean;
  startX: number;
  startY: number;
  stats: { built: number; lost: number; killed: number; harvested: number };
  noFundsWarnAt: number;
  attackWarnAt: number;
  lowPowerWarned: boolean;
  radarOnline: boolean;
  /** Airborne-drop support power: tick it is ready at (-1 = locked: no completed airfield), and when it started charging. */
  airdropAt: number;
  airdropFrom: number;
}

export interface Projectile {
  id: number;
  owner: number;
  weapon: string;
  flight: Flight;
  sourceId: number;
  targetId: number; // target entity (or -1)
  targetProj: number; // target projectile for interceptors (or -1)
  // absolute world position (z = height) this tick and last tick
  x: number;
  y: number;
  z: number;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  // launch and aim points (analytic flights)
  sx: number;
  sy: number;
  sz: number;
  tx: number;
  ty: number;
  tz: number;
  age: number; // ticks
  T: number; // total flight ticks for analytic flights
  arc: number; // apex height above the straight line
  speed: number; // guided flights: current speed (tiles/s)
  maxSpeed: number;
  turn: number; // guided: max turn per tick (rad)
  phase: number;
  engaged: number; // interceptors currently in flight towards this projectile (recounted every tick)
  /** Interceptable munitions: intercepts still needed to destroy it (starts at the weapon's interceptHp). */
  hp: number;
  maxHp: number;
  /** Times this round was hit by an interceptor and survived (render: damaged = hits > 0 -> smoke, sparks, wobble). */
  hits: number;
  // aim error from intercept damage: the impact point drifts from (dbx, dby) at progress dk to (dox, doy) at impact
  dox: number;
  doy: number;
  dbx: number;
  dby: number;
  dk: number;
  // cruise missiles: dog-leg waypoint (control point of the ground track)
  wx: number;
  wy: number;
  dead: boolean;
}

export type Command =
  | { type: 'move'; ids: number[]; x: number; y: number; attackMove?: boolean }
  | { type: 'attack'; ids: number[]; target: number }
  | { type: 'capture'; ids: number[]; target: number }
  | { type: 'stop'; ids: number[] }
  | { type: 'deploy'; ids: number[] }
  | { type: 'harvest'; ids: number[]; x: number; y: number }
  | { type: 'produce'; def: string; count?: number }
  | { type: 'cancel'; def: string }
  | { type: 'place'; def: string; tx: number; ty: number }
  | { type: 'sell'; id: number }
  | { type: 'repair'; id: number }
  | { type: 'rally'; id: number; x: number; y: number }
  | { type: 'enter'; ids: number[]; target: number }
  | { type: 'airdrop'; x: number; y: number };

export type SimEvent =
  | { t: 'fire'; id: number; weapon: string; x: number; y: number; tx: number; ty: number; targetId: number; owner: number }
  | { t: 'impact'; x: number; y: number; z: number; weapon: string; air?: boolean; direct?: boolean }
  | { t: 'launch'; id: number; flight: Flight; weapon: string; x: number; y: number; z: number; owner: number; sourceId: number }
  /**
   * Something exploded in the sky. kind: 'kill' = the threat was destroyed; 'hit' = the interceptor struck the
   * threat but it survived (hpLeft > 0, it flies on damaged); 'miss' / 'expire' = interceptor self-destructed.
   * victimId / victimWeapon / hpLeft / maxHp are set for 'kill' and 'hit'.
   */
  | { t: 'airburst'; x: number; y: number; z: number; kind: 'kill' | 'hit' | 'miss' | 'expire'; weapon: string; victim?: Flight; victimId?: number; victimWeapon?: string; hpLeft?: number; maxHp?: number }
  | { t: 'intercept'; x: number; y: number; id: number }
  | { t: 'death'; id: number; def: string; x: number; y: number; owner: number; kind: 'unit' | 'building' }
  | { t: 'placed'; id: number; owner: number }
  | { t: 'unitReady'; owner: number; def: string }
  | { t: 'buildingReady'; owner: number; def: string }
  | { t: 'noFunds'; owner: number }
  | { t: 'lowPower'; owner: number }
  | { t: 'underAttack'; owner: number; x: number; y: number }
  | { t: 'captured'; id: number; owner: number }
  | { t: 'sold'; id: number; owner: number }
  | { t: 'deployed'; id: number; owner: number }
  | { t: 'defeated'; owner: number }
  /** Support power: a transport is inbound (id) to the drop zone; 'paradrop' when the stick jumps; 'landed' per jumper / pallet. */
  | { t: 'airdrop'; owner: number; id: number; x: number; y: number }
  | { t: 'paradrop'; owner: number; id: number; x: number; y: number; z: number }
  | { t: 'landed'; owner: number; id: number; x: number; y: number }
  | { t: 'gameOver'; winner: number };
