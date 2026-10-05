// Core simulation types. The simulation is deterministic and driven only by
// commands, so it can later run in lockstep over the network.

export const TPS = 20; // simulation ticks per second
export const TICK_MS = 1000 / TPS;

export type Faction = 'usa' | 'israel' | 'china' | 'russia' | 'germany' | 'korea' | 'ukraine' | 'turkey' | 'iran';
export type ArmorClass = 'infantry' | 'light' | 'heavy' | 'building' | 'aircraft';
export type Warhead = 'mg' | 'cannon' | 'rocket' | 'artillery' | 'flak' | 'missile' | 'laser' | 'thermo' | 'sniper';
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
  | 'cruise' // subsonic, terrain-hugging, dog-leg route, pop-up and terminal dive
  | 'bomb'; // free-fall / glide bomb released by a jet in level flight (airbase.ts sortie)

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
  /**
   * Lock-on (sniper.ts): ticks the shooter must hold its aim on a NEW target before the first shot.
   * The aim resets on a new target and cancels when the target leaves range / sight, hides inside a
   * building or vehicle, or dies, and when the shooter moves or gets another order.
   */
  aim?: number;
  /**
   * Shoulder-launched (MANPADS, ballistics.ts launch): the missile leaves the tube at the gunner's shoulder,
   * along his line of sight at a raised launch angle, with only a short kick-up instead of a vertical boost.
   */
  shoulder?: boolean;
  /** Damage multiplier against airborne fixed-wing aircraft (fast jets are hard to hit squarely with a small warhead). */
  vsFixedWing?: number;
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
  /**
   * Secondary weapon, used against the targets the main weapon can't hit (World.weaponVs): the Rocket Team's
   * shoulder-fired AA missile next to its ground-only RPG. It has its own reload (Entity.cooldown2).
   */
  weapon2?: string;
  aps?: number; // active protection: chance to intercept rockets / missiles
  ewRadius?: number; // electronic warfare jamming radius vs drones
  repairAura?: number; // repairs friendly vehicles within radius
  transport?: number; // infantry capacity
  fixedWing?: boolean; // jets: always moving, attack in passes
  cruiseAlt?: number; // flight altitude above ground
  airlift?: boolean; // support-power transport plane: flies a straight drop run, then leaves the map
  supply?: boolean; // air-dropped supply pallet: heals friendly units nearby, then expires
  /** Heavy ground vehicle that runs over enemy infantry in its path (crush.ts). */
  crusher?: boolean;
  /** Can be run over by an enemy crusher (infantry on the ground; crush.ts). */
  crushable?: boolean;
  /**
   * Stealth aircraft (stealth.ts): while airborne, enemy air-targeting weapons acquire and fire at it only
   * within this fraction of their normal range (the aircraft counterpart of WeaponDef.lowObservable).
   */
  lowObservable?: number;
  /**
   * Stealth aircraft (stealth.ts): chance that each anti-air shot or missile aimed at it while airborne misses
   * (seeded roll). Missiles are decoyed onto a flare, gun / flak / beam shots just miss.
   */
  evasion?: number;
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
  /** Civilian house: infantry capacity (garrison.ts). */
  garrison?: number;
  /** Capturable tech structure effect (capture.ts). */
  techKind?: 'hospital' | 'airport' | 'comms';
  /** Superweapon structure (superweapons.ts). */
  superweapon?: string;
}

/** Superweapon state of a player (superweapons.ts). at: tick it is ready (-1 = no superweapon structure). */
export interface SuperweaponState {
  at: number;
  from: number;
  readyTold: boolean;
  /** Iron Beam dome while active. */
  beam: { x: number; y: number; until: number } | null;
  /** Staggered launches still to fire (salvos, drone waves). */
  queue: { at: number; what: string; x: number; y: number; target: number }[];
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

/**
 * Fog of war rule (World option, the same for every player):
 * 'classic' (Red Alert 2): once explored, ground stays revealed - terrain, structures and units there
 * stay visible and targetable; only the black shroud of unexplored ground hides anything.
 * 'modern': explored ground outside current sight is dimmed fog and hides enemy units.
 */
export type FogMode = 'classic' | 'modern';

/** Unit stance (see orders.ts): how far a unit goes on its own to fight. */
export type Stance = 'aggressive' | 'guard' | 'hold' | 'holdFire';

/** An order waiting in a unit's waypoint queue (Shift-queued / phone queue mode). */
export type QueuedOrder =
  | { type: 'move' | 'attackMove' | 'patrol'; x: number; y: number }
  | { type: 'attack' | 'guard'; target: number };

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

/**
 * Infantry sidestepping a vehicle about to run it over (crush.ts). The soldier keeps its order: it
 * reacts at tick `go`, sprints to (x, y), dives and rolls on a close call, stands clear until the
 * vehicle has passed, then resumes what it was doing.
 */
export interface DodgeState {
  by: number; // the threatening vehicle
  x: number; // sidestep goal
  y: number;
  go: number; // tick the soldier reacts (starts moving)
  until: number; // tick the dodge ends at the latest
  phase: 'wait' | 'run' | 'down' | 'clear';
  downUntil: number; // dive: tick the soldier is back on his feet
  dive: boolean; // close call: dive and roll
  yield: boolean; // a friendly vehicle: just stepping out of its way
  order: Order; // the order he had: a new one (player command) takes over once he is out of the way
}

/**
 * Fixed-wing combat jet sortie cycle (airbase.ts): parked on its pad -> taxi -> hold short -> line up ->
 * take-off roll -> strike sortie -> return -> final approach -> roll-out -> taxi in -> rearm on the pad.
 * 'orbit': its airbase is gone and no other has a free pad: it circles until a pad frees up or fuel runs out.
 */
export type SortiePhase = 'parked' | 'taxiOut' | 'hold' | 'lineup' | 'takeoff' | 'sortie' | 'return' | 'final' | 'rollout' | 'taxiIn' | 'orbit';

export interface Sortie {
  phase: SortiePhase;
  base: number; // airbase (airfield building) id, -1 = none
  pad: number; // parking pad index 0..3 on that base, -1 = none
  ammo: number; // strikes aboard (0 or 1)
  rearm: number; // ticks of rearming left on the pad (0 = done)
  v: number; // ground / air speed, tiles per tick
  path: number[]; // taxi waypoints [x0, y0, x1, y1, ...]
  wp: number; // next waypoint index (pairs)
  tx: number; // last known strike aim point (target lost: look for another one near it)
  ty: number;
  fuel: number; // ticks of fuel left while homeless (orbit)
  ox: number; // orbit centre
  oy: number;
  /** Automatic re-strike: the target kept after a bomb release (-1 = none), while the attack order is the one given at tick autoAt. */
  auto: number;
  autoAt: number;
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
  /** Reload of the secondary weapon (UnitDef.weapon2). */
  cooldown2: number;
  /** Weapon of the burst in progress ('' = the main weapon). */
  burstWpn: string;
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

  // veterancy (see veterancy.ts)
  xp: number; // value of everything this unit has destroyed
  rank: number; // 0 rookie, 1 veteran, 2 elite
  spawner: number; // spawned munitions (drones): the launcher credited with their kills, else -1

  // orders (see orders.ts)
  stance: Stance;
  queue: QueuedOrder[]; // waypoints / orders to run after the current one
  patrol: { ax: number; ay: number; bx: number; by: number } | null; // patrolling between a and b
  guardId: number; // friendly unit / building this unit escorts, else -1
  orderAt: number; // tick of the owner's last explicit order to this unit (move / attack / stop ...), else -9999
  hurtBy: number; // the enemy that last damaged this entity (its container for garrison / APC shots), else -1

  // automatic base defence (see basedefense.ts)
  defend: { x: number; y: number } | null; // pulled in to defend the base: the post it returns to afterwards

  // crushing / dodging (see crush.ts)
  dodge: DodgeState | null; // infantry: sidestepping a vehicle
  dodgeAt: number; // infantry: tick before which it won't try another dodge (cooldown)
  stillAt: number; // tick the unit last moved (dug in after standing still a while)

  // fixed-wing combat jets (airbase.ts)
  sortie: Sortie | null;

  // lock-on weapons (sniper.ts): the target being aimed at (-1 = none) and the ticks aimed so far
  aimTarget: number;
  aimTicks: number;
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
  /** Superweapon timer / Iron Beam / pending salvos (superweapons.ts). */
  sw: SuperweaponState;
  /** Repeat-build per production category: finished units are queued again. */
  repeat?: Partial<Record<Category, boolean>>;
  /** Automatic base defence (basedefense.ts): idle units near the base engage attackers on their own. */
  autoDefend: boolean;
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
  /**
   * Missiles fired at an evasive aircraft (stealth.ts): 0 = not rolled, -1 = not fooled, 1 = will be decoyed,
   * 2 = diverted onto the decoy flare at (dcx, dcy, dcz) moving at (dcvx, dcvy, dcvz) tiles/s (absolute height z).
   */
  decoy: number;
  dcx: number;
  dcy: number;
  dcz: number;
  dcvx: number;
  dcvy: number;
  dcvz: number;
  dcAt: number; // age at which it was diverted
  dcr: number; // distance to the flare last tick (closest-approach fuze)
  dead: boolean;
}

export type Command =
  | { type: 'move'; ids: number[]; x: number; y: number; attackMove?: boolean; queue?: boolean }
  | { type: 'attack'; ids: number[]; target: number; queue?: boolean }
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
  | { type: 'airdrop'; x: number; y: number }
  | { type: 'stance'; ids: number[]; stance: Stance }
  | { type: 'patrol'; ids: number[]; x: number; y: number; queue?: boolean }
  | { type: 'guard'; ids: number[]; target: number; queue?: boolean }
  | { type: 'repeat'; cat: Category; on: boolean }
  /** Fire the player's superweapon at (x, y) (superweapons.ts). */
  | { type: 'superweapon'; x: number; y: number }
  /** Send the garrison out of an occupied civilian building (garrison.ts). */
  | { type: 'evacuate'; id: number }
  /** Automatic base defence on / off for the issuing player (basedefense.ts). */
  | { type: 'autoDefend'; on: boolean };

export type SimEvent =
  | { t: 'fire'; id: number; weapon: string; x: number; y: number; tx: number; ty: number; targetId: number; owner: number }
  | { t: 'impact'; x: number; y: number; z: number; weapon: string; air?: boolean; direct?: boolean }
  | { t: 'launch'; id: number; flight: Flight; weapon: string; x: number; y: number; z: number; owner: number; sourceId: number }
  /**
   * Something exploded in the sky. kind: 'kill' = the threat was destroyed; 'hit' = the interceptor struck the
   * threat but it survived (hpLeft > 0, it flies on damaged); 'miss' / 'expire' = interceptor self-destructed.
   * victimId / victimWeapon / hpLeft / maxHp are set for 'kill' and 'hit'.
   */
  | { t: 'airburst'; x: number; y: number; z: number; kind: 'kill' | 'hit' | 'miss' | 'expire'; weapon: string; victim?: Flight; victimId?: number; victimWeapon?: string; hpLeft?: number; maxHp?: number; decoy?: boolean }
  /**
   * A missile (proj) homing on an evasive aircraft (id, owner) was fooled: the jet's decoy flare leaves (x, y, z)
   * at (vx, vy, vz) tiles/s and the missile turns onto it (stealth.ts). The airburst on the flare follows ('miss', decoy).
   */
  | { t: 'decoy'; id: number; owner: number; proj: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }
  | { t: 'intercept'; x: number; y: number; id: number }
  | { t: 'death'; id: number; def: string; x: number; y: number; owner: number; kind: 'unit' | 'building'; cause?: 'crushed' }
  /** A vehicle (by, byDef, byOwner) ran over infantry (id); the 'death' event (cause 'crushed') follows. */
  | { t: 'crushed'; id: number; def: string; owner: number; by: number; byDef: string; byOwner: number; x: number; y: number }
  /** Infantry (id) saw a vehicle (by) coming and jumps out of its way; dive = close call. yield = a friendly vehicle. */
  | { t: 'dodge'; id: number; owner: number; by: number; x: number; y: number; dive: boolean; yield: boolean }
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
  /** Veterancy: a unit reached a new rank (1 veteran, 2 elite). */
  | { t: 'promoted'; id: number; owner: number; rank: number; x: number; y: number }
  /** Superweapon status (superweapons.ts): structure detected, charged, launched (target x, y), lost; Iron Beam engagements ('beam': from x, y, z to tx, ty, tz) and dome end. */
  | { t: 'superweapon'; owner: number; sw: string; phase: 'detected' | 'ready' | 'launch' | 'lost' | 'beam' | 'end'; x: number; y: number; z?: number; tx?: number; ty?: number; tz?: number }
  /** Infantry entered (enter) or left a civilian building (garrison.ts). */
  | { t: 'garrison'; id: number; owner: number; enter: boolean }
  /** Jet sortie milestones (airbase.ts): take-off roll begins, wheels touch down, bomb away, base lost (diverting / orbiting), out of fuel. */
  | { t: 'sortie'; id: number; owner: number; what: 'takeoff' | 'touchdown' | 'release' | 'divert' | 'orbit' | 'crash'; x: number; y: number }
  /** Lock-on weapons (sniper.ts): aim taken on a new target ('start') and steady for the final shot ('lock'). */
  | { t: 'aim'; id: number; owner: number; target: number; phase: 'start' | 'lock'; x: number; y: number }
  | { t: 'gameOver'; winner: number };
