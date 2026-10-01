import type { ArmorClass, BuildingDef, Def, Faction, UnitDef, Warhead, WeaponDef } from './types';

// ----------------------------------------------------------------- warheads

export const VERSUS: Record<Warhead, Record<ArmorClass, number>> = {
  mg: { infantry: 1.0, light: 0.45, heavy: 0.15, building: 0.2, aircraft: 0.6 },
  cannon: { infantry: 0.3, light: 0.9, heavy: 1.0, building: 0.6, aircraft: 0 },
  rocket: { infantry: 0.4, light: 1.0, heavy: 1.0, building: 0.7, aircraft: 0.9 },
  artillery: { infantry: 1.0, light: 0.6, heavy: 0.45, building: 1.0, aircraft: 0 },
  flak: { infantry: 0.6, light: 0.8, heavy: 0.2, building: 0.1, aircraft: 1.2 },
  missile: { infantry: 0.5, light: 1.0, heavy: 1.0, building: 1.1, aircraft: 1.0 },
  laser: { infantry: 0.8, light: 0.7, heavy: 0.25, building: 0.3, aircraft: 1.6 },
  thermo: { infantry: 1.3, light: 0.7, heavy: 0.35, building: 1.2, aircraft: 0 },
};

// ------------------------------------------------------------------ weapons

const BASE_WEAPONS: WeaponDef[] = [
  { id: 'rifle', damage: 15, range: 4.5, rof: 18, warhead: 'mg', projectile: 'instant', air: 'yes' },
  { id: 'mgHeavy', damage: 14, range: 5, rof: 7, warhead: 'mg', projectile: 'instant', air: 'yes' },
  { id: 'atRocket', damage: 42, range: 5.5, rof: 42, warhead: 'rocket', projectile: 'rocket', speed: 0.45, air: 'yes' },
  { id: 'cannon', damage: 62, range: 5.5, rof: 42, warhead: 'cannon', projectile: 'shell', speed: 0.9, air: 'no' },
  { id: 'cannonHeavy', damage: 76, range: 6, rof: 44, warhead: 'cannon', projectile: 'shell', speed: 0.95, air: 'no' },
  { id: 'flak', damage: 20, range: 7, rof: 6, warhead: 'flak', projectile: 'instant', air: 'only' },
  { id: 'sam', damage: 80, range: 9, rof: 45, warhead: 'missile', projectile: 'rocket', speed: 0.6, air: 'only' },
  { id: 'atgm', damage: 95, range: 7, rof: 55, warhead: 'rocket', projectile: 'rocket', speed: 0.5, air: 'no' },
  { id: 'laser', damage: 40, range: 7, rof: 16, warhead: 'laser', projectile: 'beam', air: 'yes' },
  { id: 'howitzer', damage: 95, range: 10, minRange: 3, rof: 90, warhead: 'artillery', projectile: 'artillery', speed: 0.25, splash: 1.2, air: 'no' },
  { id: 'k9', damage: 80, range: 11, minRange: 3, rof: 64, burst: 2, burstDelay: 8, warhead: 'artillery', projectile: 'artillery', speed: 0.28, splash: 1.2, air: 'no' },
  { id: 'tos', damage: 40, range: 9, minRange: 3, rof: 140, burst: 6, burstDelay: 3, warhead: 'thermo', projectile: 'artillery', speed: 0.22, splash: 2, air: 'no' },
  { id: 'mortar', damage: 55, range: 9, minRange: 2, rof: 60, warhead: 'artillery', projectile: 'artillery', speed: 0.2, splash: 1, air: 'no', precise: true },
  { id: 'dfMissile', damage: 340, range: 16, minRange: 5, rof: 300, warhead: 'missile', projectile: 'missile', speed: 0.45, splash: 1.6, air: 'no', precise: true },
  { id: 'fateh', damage: 260, range: 15, minRange: 5, rof: 250, warhead: 'missile', projectile: 'missile', speed: 0.35, splash: 2, air: 'no' },
  { id: 'uavMissile', damage: 48, range: 6, rof: 50, warhead: 'rocket', projectile: 'rocket', speed: 0.6, air: 'no' },
  { id: 'heavyUavMissile', damage: 90, range: 7, rof: 60, burst: 2, burstDelay: 8, warhead: 'missile', projectile: 'rocket', speed: 0.6, air: 'no' },
  { id: 'jetMissile', damage: 70, range: 7.5, rof: 60, burst: 2, burstDelay: 6, warhead: 'missile', projectile: 'rocket', speed: 0.8, air: 'yes' },
  { id: 'fpvLaunch', damage: 0, range: 9, rof: 110, warhead: 'rocket', projectile: 'spawn', spawn: 'fpv', air: 'no' },
  { id: 'swarmLaunch', damage: 0, range: 10, rof: 170, burst: 3, burstDelay: 5, warhead: 'rocket', projectile: 'spawn', spawn: 'micro', air: 'no' },
  { id: 'shahedLaunch', damage: 0, range: 15, rof: 220, burst: 2, burstDelay: 12, warhead: 'missile', projectile: 'spawn', spawn: 'shahed', air: 'no' },
  // kamikaze warheads (range = contact distance)
  { id: 'fpvWarhead', damage: 150, range: 0.5, rof: 1, warhead: 'rocket', projectile: 'instant', air: 'no' },
  { id: 'microWarhead', damage: 85, range: 0.5, rof: 1, warhead: 'rocket', projectile: 'instant', air: 'no', splash: 0.8 },
  { id: 'shahedWarhead', damage: 230, range: 0.6, rof: 1, warhead: 'missile', projectile: 'instant', air: 'no', splash: 1.6 },
];

export const WEAPONS: Record<string, WeaponDef> = {};
for (const w of BASE_WEAPONS) WEAPONS[w.id] = w;

// ----------------------------------------------------------------- factions

export interface FactionMods {
  infantryCost?: number;
  vehicleCost?: number;
  airCost?: number;
  airHp?: number;
  airBuild?: number;
  vehicleBuild?: number;
  vehicleSpeed?: number;
  buildingHp?: number;
  sight?: number;
  defenseRange?: number;
  artilleryDamage?: number;
  infantryDamage?: number;
  aps?: number; // APS fitted to every vehicle
  radarRange?: number; // weapon range bonus while a radar is online
}

export interface FactionInfo {
  id: Faction;
  name: string;
  doctrine: string;
  bonuses: string[];
  hull: number; // vehicle paint
  accent: number; // building trim
  flag: number[]; // flag colour stripes
  mods: FactionMods;
  signature: string[]; // unit ids shown in the menu
}

export const FACTIONS: FactionInfo[] = [
  {
    id: 'usa',
    name: 'United States',
    doctrine: 'Network-Centric & Multi-Domain Operations',
    bonuses: ['Sensor-to-shooter network: +1 weapon range while a radar is online', '+1 sight for all units'],
    hull: 0xb3a07a,
    accent: 0x3c5a8c,
    flag: [0xb22234, 0xffffff, 0x3c3b6e],
    mods: { radarRange: 1, sight: 1 },
    signature: ['usa_laser', 'usa_jet'],
  },
  {
    id: 'israel',
    name: 'Israel',
    doctrine: 'Urban & Active-Protection Maneuver',
    bonuses: ['All vehicles carry active protection (intercepts rockets & missiles)', '+20% infantry damage in close combat'],
    hull: 0x9c9878,
    accent: 0x2f5fa8,
    flag: [0x0038b8, 0xffffff, 0x0038b8],
    mods: { aps: 0.3, infantryDamage: 1.2 },
    signature: ['israel_mortar', 'israel_ugv'],
  },
  {
    id: 'china',
    name: 'China',
    doctrine: 'Anti-Access / Area Denial & Drone Swarming',
    bonuses: ['Drones and aircraft cost 25% less', 'Hypersonic long-range strike missiles'],
    hull: 0x5d6b47,
    accent: 0xb8312f,
    flag: [0xde2910, 0xffde00, 0xde2910],
    mods: { airCost: 0.75 },
    signature: ['china_swarm', 'china_df'],
  },
  {
    id: 'russia',
    name: 'Russia',
    doctrine: 'Mass Artillery Attrition & Electronic Warfare',
    bonuses: ['+25% artillery damage', 'EW complexes jam enemy drones'],
    hull: 0x5a6a44,
    accent: 0x8a2a24,
    flag: [0xffffff, 0x0039a6, 0xd52b1e],
    mods: { artilleryDamage: 1.25 },
    signature: ['russia_tos', 'russia_ew'],
  },
  {
    id: 'germany',
    name: 'Germany',
    doctrine: 'Heavy Mechanized Maneuver & Rapid Logistics',
    bonuses: ['Vehicles move 12% faster and build 20% faster', 'Recovery vehicles repair armor in the field'],
    hull: 0x4b5638,
    accent: 0x2b2b2b,
    flag: [0x000000, 0xdd0000, 0xffce00],
    mods: { vehicleSpeed: 1.12, vehicleBuild: 0.8 },
    signature: ['germany_mbt', 'germany_berge'],
  },
  {
    id: 'korea',
    name: 'South Korea',
    doctrine: 'Fortified Mountainous Defense & Automated Counter-Battery',
    bonuses: ['Structures have 30% more armor', 'Defenses get +1 range'],
    hull: 0x56623f,
    accent: 0x2a4f9e,
    flag: [0xffffff, 0xcd2e3a, 0x0047a0],
    mods: { buildingHp: 1.3, defenseRange: 1 },
    signature: ['korea_arty', 'korea_def_gun'],
  },
  {
    id: 'ukraine',
    name: 'Ukraine',
    doctrine: 'Asymmetric Decentralized Attrition & Drone Integration',
    bonuses: ['Infantry costs 20% less', 'Distributed battle network: +1 sight for all units'],
    hull: 0x667045,
    accent: 0x0057b7,
    flag: [0x0057b7, 0x0057b7, 0xffd700],
    mods: { infantryCost: 0.8, sight: 1 },
    signature: ['ukraine_fpvteam', 'ukraine_ewinf'],
  },
  {
    id: 'turkey',
    name: 'Turkey',
    doctrine: 'Persistent UAV Dominance',
    bonuses: ['Drones build 30% faster', 'Drones have 20% more armor'],
    hull: 0x7b8070,
    accent: 0xb8202e,
    flag: [0xe30a17, 0xffffff, 0xe30a17],
    mods: { airBuild: 0.7, airHp: 1.2 },
    signature: ['turkey_uav', 'turkey_akinci'],
  },
  {
    id: 'iran',
    name: 'Iran',
    doctrine: 'Asymmetric Deterrence & Rocket Saturation',
    bonuses: ['Missile and rocket units cost 20% less', 'Loitering munitions launched from container trucks'],
    hull: 0xa38d64,
    accent: 0x239f40,
    flag: [0x239f40, 0xffffff, 0xda0000],
    mods: {},
    signature: ['iran_shahedl', 'iran_fateh'],
  },
];

export const FACTION_INFO: Record<Faction, FactionInfo> = Object.fromEntries(FACTIONS.map((f) => [f.id, f])) as Record<Faction, FactionInfo>;

// ---------------------------------------------------------------- templates

type UnitTpl = Omit<UnitDef, 'kind' | 'buildable' | 'faction' | 'id'> & { buildable?: boolean };
type BldTpl = Omit<BuildingDef, 'kind' | 'buildable' | 'faction' | 'id' | 'armor'> & { buildable?: boolean };

const BUILDINGS: Record<string, BldTpl> = {
  conyard: { name: 'Construction Yard', category: 'building', role: 'conyard', model: 'conyard', cost: 3000, buildTime: 30, hp: 1500, sight: 7, w: 3, h: 3, power: 0, prereq: [], buildable: false, desc: 'Builds structures.' },
  power: { name: 'Power Plant', category: 'building', role: 'power', model: 'power', cost: 700, buildTime: 8, hp: 750, sight: 5, w: 2, h: 2, power: 175, prereq: ['conyard'], desc: 'Provides 175 power.' },
  refinery: { name: 'Ore Refinery', category: 'building', role: 'refinery', model: 'refinery', cost: 2000, buildTime: 18, hp: 1000, sight: 6, w: 3, h: 3, power: -50, passable: [[1, 2]], dock: [1, 2], exit: [1, 3], prereq: ['power'], desc: 'Processes ore. Comes with an Ore Harvester.' },
  barracks: { name: 'Barracks', category: 'building', role: 'barracks', model: 'barracks', cost: 500, buildTime: 7, hp: 800, sight: 5, w: 2, h: 2, power: -10, exit: [1, 2], produces: 'infantry', prereq: ['power'], desc: 'Trains infantry.' },
  factory: { name: 'War Factory', category: 'building', role: 'factory', model: 'factory', cost: 2000, buildTime: 18, hp: 1500, sight: 5, w: 3, h: 3, power: -25, passable: [[1, 1], [1, 2]], exit: [1, 1], produces: 'vehicle', prereq: ['refinery', 'barracks'], desc: 'Builds vehicles.' },
  radar: { name: 'Radar Center', category: 'building', role: 'radar', model: 'radar', cost: 1000, buildTime: 12, hp: 1000, sight: 9, w: 2, h: 2, power: -50, prereq: ['refinery'], desc: 'Enables the radar minimap.' },
  airfield: { name: 'Drone Hub', category: 'building', role: 'airfield', model: 'airfield', cost: 1000, buildTime: 12, hp: 900, sight: 6, w: 3, h: 3, power: -40, exit: [1, 1], produces: 'air', prereq: ['radar'], desc: 'Builds drones and aircraft.' },
  tech: { name: 'Battle Lab', category: 'building', role: 'tech', model: 'tech', cost: 2000, buildTime: 20, hp: 1000, sight: 5, w: 3, h: 3, power: -100, prereq: ['factory', 'radar'], desc: 'Unlocks advanced technology.' },
  def_gun: { name: 'MG Bunker', category: 'defense', role: 'def_gun', model: 'bunker', cost: 450, buildTime: 6, hp: 500, sight: 6, w: 1, h: 1, power: 0, weapon: 'mgHeavy', prereq: ['barracks'], desc: 'Machine gun nest. Hits infantry and drones.' },
  def_aa: { name: 'SAM Site', category: 'defense', role: 'def_aa', model: 'sam', cost: 800, buildTime: 9, hp: 550, sight: 9, w: 1, h: 1, power: -40, weapon: 'sam', needsPower: true, prereq: ['barracks'], desc: 'Surface-to-air missiles. Air targets only. Needs power.' },
  def_at: { name: 'ATGM Tower', category: 'defense', role: 'def_at', model: 'atgm', cost: 1200, buildTime: 12, hp: 700, sight: 8, w: 1, h: 1, power: -60, weapon: 'atgm', needsPower: true, prereq: ['radar'], desc: 'Long-range anti-tank missiles. Needs power.' },
};

const UNITS: Record<string, UnitTpl> = {
  rifle: { name: 'Rifleman', category: 'infantry', model: 'rifle', cost: 150, buildTime: 4, hp: 110, armor: 'infantry', sight: 5, speed: 1.35, turnRate: 0.5, turret: false, radius: 0.18, weapon: 'rifle', prereq: ['barracks'], desc: 'Basic infantry. Can fire at drones.', aiWeight: 5, aiTag: 'main' },
  at: { name: 'AT Rocket Team', category: 'infantry', model: 'at', cost: 300, buildTime: 5, hp: 110, armor: 'infantry', sight: 6, speed: 1.25, turnRate: 0.5, turret: false, radius: 0.18, weapon: 'atRocket', prereq: ['barracks'], desc: 'Anti-armor rockets. Also hits aircraft.', aiWeight: 4, aiTag: 'main' },
  engineer: { name: 'Engineer', category: 'infantry', model: 'engineer', cost: 500, buildTime: 6, hp: 75, armor: 'infantry', sight: 4, speed: 1.2, turnRate: 0.5, turret: false, radius: 0.18, engineer: true, prereq: ['barracks'], desc: 'Captures enemy and neutral buildings, repairs your own.', aiWeight: 0 },
  mbt: { name: 'Main Battle Tank', category: 'vehicle', model: 'mbt', cost: 800, buildTime: 9, hp: 380, armor: 'heavy', sight: 6, speed: 2.2, turnRate: 0.11, turret: true, radius: 0.45, weapon: 'cannon', prereq: ['factory'], desc: 'Main battle tank.', aiWeight: 7, aiTag: 'main' },
  aa: { name: 'AA Vehicle', category: 'vehicle', model: 'aa', cost: 700, buildTime: 8, hp: 230, armor: 'light', sight: 8, speed: 2.3, turnRate: 0.12, turret: true, radius: 0.42, weapon: 'flak', prereq: ['factory'], desc: 'Rapid-fire air defense. Air targets only.', aiWeight: 1, aiTag: 'aa' },
  arty: { name: 'Self-Propelled Howitzer', category: 'vehicle', model: 'arty', cost: 1000, buildTime: 11, hp: 180, armor: 'light', sight: 6, speed: 1.7, turnRate: 0.09, turret: true, radius: 0.45, weapon: 'howitzer', prereq: ['factory', 'radar'], desc: 'Long-range artillery.', aiWeight: 2, aiTag: 'arty' },
  harvester: { name: 'Ore Harvester', category: 'vehicle', model: 'harvester', cost: 1400, buildTime: 14, hp: 1000, armor: 'heavy', sight: 4, speed: 1.6, turnRate: 0.1, turret: false, radius: 0.5, harvester: true, prereq: ['factory', 'refinery'], desc: 'Gathers ore and gems.', aiWeight: 0 },
  mcv: { name: 'MCV', category: 'vehicle', model: 'mcv', cost: 3000, buildTime: 30, hp: 1000, armor: 'heavy', sight: 5, speed: 1.4, turnRate: 0.08, turret: false, radius: 0.55, mcv: true, prereq: ['factory', 'radar'], desc: 'Deploys into a Construction Yard.', aiWeight: 0 },
  uav: { name: 'Strike UAV', category: 'air', model: 'uav', cost: 900, buildTime: 10, hp: 180, armor: 'aircraft', sight: 8, speed: 3.0, turnRate: 0.15, turret: false, radius: 0.4, air: true, weapon: 'uavMissile', prereq: ['airfield'], desc: 'Armed drone. Attacks ground targets.', aiWeight: 3, aiTag: 'main' },
};

// Munitions launched by drone carriers (never built directly).
const MUNITIONS: Record<string, UnitTpl> = {
  fpv: { name: 'FPV Drone', category: 'air', model: 'fpv', cost: 0, buildTime: 1, hp: 30, armor: 'aircraft', sight: 4, speed: 5.5, turnRate: 0.4, turret: false, radius: 0.15, air: true, kamikaze: true, temp: true, weapon: 'fpvWarhead', prereq: [], buildable: false, desc: '' },
  micro: { name: 'Swarm Drone', category: 'air', model: 'micro', cost: 0, buildTime: 1, hp: 35, armor: 'aircraft', sight: 4, speed: 4.5, turnRate: 0.4, turret: false, radius: 0.15, air: true, kamikaze: true, temp: true, weapon: 'microWarhead', prereq: [], buildable: false, desc: '' },
  shahed: { name: 'Loitering Munition', category: 'air', model: 'shahed', cost: 0, buildTime: 1, hp: 70, armor: 'aircraft', sight: 4, speed: 2.6, turnRate: 0.2, turret: false, radius: 0.25, air: true, kamikaze: true, temp: true, weapon: 'shahedWarhead', prereq: [], buildable: false, desc: '' },
};

/** Per-faction overrides of the shared roster and signature additions. */
const FACTION_UNITS: Record<Faction, Record<string, Partial<UnitTpl> & { replaces?: string }>> = {
  usa: {
    mbt: { name: 'Liberty MBT' },
    laser: { replaces: 'aa', name: 'DE-SHORAD Laser', model: 'laser', category: 'vehicle', cost: 900, hp: 240, armor: 'light', weapon: 'laser', desc: 'Directed-energy weapon. Shreds drones, also hits ground.', aiWeight: 2, aiTag: 'aa' },
    jet: { name: 'Lightning VTOL Jet', model: 'jet', category: 'air', cost: 1600, buildTime: 16, hp: 320, armor: 'aircraft', sight: 10, speed: 4.2, turnRate: 0.15, air: true, weapon: 'jetMissile', prereq: ['airfield', 'tech'], radius: 0.5, desc: 'Fifth-generation sensor node. Hits ground and air.', aiWeight: 2, aiTag: 'main' },
    uav: { name: 'Reaper UAV' },
  },
  israel: {
    mbt: { name: 'Chariot MBT', model: 'mbt_heavy', cost: 1000, hp: 470, aps: 0.55, desc: 'Heavily armored tank with active protection.' },
    mortar: { name: 'Sting Mortar Team', model: 'mortar', category: 'infantry', cost: 450, buildTime: 6, hp: 90, armor: 'infantry', sight: 7, speed: 1.1, weapon: 'mortar', prereq: ['barracks', 'radar'], desc: 'Precision-guided mortar.', aiWeight: 2, aiTag: 'arty' },
    ugv: { name: 'Pathfinder UGV', model: 'ugv', category: 'vehicle', cost: 450, buildTime: 6, hp: 220, armor: 'light', sight: 7, speed: 3.0, turnRate: 0.2, turret: true, weapon: 'mgHeavy', radius: 0.32, prereq: ['factory'], desc: 'Fast unmanned ground vehicle for route clearance.', aiWeight: 3, aiTag: 'scout' },
    uav: { name: 'Hermes UAV' },
  },
  china: {
    mbt: { name: 'Type-99 MBT' },
    swarm: { name: 'Swarm Carrier', model: 'swarm', category: 'vehicle', cost: 1100, buildTime: 12, hp: 220, armor: 'light', sight: 8, speed: 2.0, turnRate: 0.1, turret: false, weapon: 'swarmLaunch', prereq: ['factory', 'airfield'], desc: 'Launches coordinated kamikaze drone swarms.', aiWeight: 3, aiTag: 'main' },
    df: { name: 'DF Hypersonic Launcher', model: 'missile_truck', category: 'vehicle', cost: 1800, buildTime: 18, hp: 200, armor: 'light', sight: 6, speed: 1.6, turnRate: 0.08, turret: false, weapon: 'dfMissile', prereq: ['factory', 'tech'], desc: 'Extreme-range hypersonic strike missile.', aiWeight: 1, aiTag: 'arty' },
    uav: { name: 'Wing UAV' },
  },
  russia: {
    mbt: { name: 'T-90 MBT', hp: 420 },
    tos: { replaces: 'arty', name: 'TOS Thermobaric Launcher', model: 'tos', category: 'vehicle', cost: 1300, buildTime: 13, hp: 300, armor: 'heavy', sight: 6, speed: 1.8, turnRate: 0.09, turret: true, weapon: 'tos', prereq: ['factory', 'radar'], desc: 'Thermobaric rocket salvos. Devastating vs infantry and structures.', aiWeight: 2, aiTag: 'arty' },
    ew: { name: 'Krasukha EW Complex', model: 'ew', category: 'vehicle', cost: 1000, buildTime: 11, hp: 280, armor: 'light', sight: 9, speed: 1.8, turnRate: 0.09, turret: false, ewRadius: 8, prereq: ['factory', 'radar'], desc: 'Jams enemy drones in a wide radius: slows them, stops their weapons and downs kamikaze drones.', aiWeight: 1, aiTag: 'support' },
    uav: { name: 'Orion UAV' },
  },
  germany: {
    mbt: { name: 'Leo 2A8 MBT', model: 'mbt_heavy', cost: 1000, buildTime: 11, hp: 540, speed: 2.4, weapon: 'cannonHeavy', desc: 'Superior tank with modular composite armor.' },
    berge: { name: 'Berge Recovery Vehicle', model: 'berge', category: 'vehicle', cost: 800, buildTime: 9, hp: 450, armor: 'heavy', sight: 6, speed: 2.1, turnRate: 0.1, turret: false, repairAura: 3, prereq: ['factory'], desc: 'Repairs nearby vehicles.', aiWeight: 1, aiTag: 'support' },
    aa: { name: 'Cheetah AA' },
    uav: { name: 'Heron UAV' },
  },
  korea: {
    mbt: { name: 'K2 MBT' },
    arty: { name: 'K9 Thunder SPH', model: 'arty', hp: 260, armor: 'heavy', cost: 1200, weapon: 'k9', desc: 'Auto-loading howitzer with rapid fire.' },
    uav: { name: 'KUS UAV' },
  },
  ukraine: {
    mbt: { name: 'Oplot MBT' },
    fpvteam: { name: 'FPV Drone Team', model: 'fpvteam', category: 'infantry', cost: 450, buildTime: 5, hp: 90, armor: 'infantry', sight: 7, speed: 1.25, weapon: 'fpvLaunch', prereq: ['barracks'], desc: 'Launches FPV kamikaze drones that hunt armor.', aiWeight: 4, aiTag: 'main' },
    ewinf: { name: 'EW Trooper', model: 'ewinf', category: 'infantry', cost: 350, buildTime: 5, hp: 110, armor: 'infantry', sight: 6, speed: 1.3, weapon: 'rifle', ewRadius: 4.5, prereq: ['barracks'], desc: 'Backpack jammer protects nearby troops from drones.', aiWeight: 1, aiTag: 'support' },
    uav: { name: 'Recon Strike UAV' },
  },
  turkey: {
    mbt: { name: 'Altay MBT' },
    uav: { name: 'Kestrel TB UAV', cost: 750, hp: 240, speed: 3.2, desc: 'Long-endurance strike drone with micro-guided munitions.', aiWeight: 6 },
    akinci: { name: 'Akinci Heavy UAV', model: 'heavy_uav', category: 'air', cost: 1500, buildTime: 15, hp: 460, armor: 'aircraft', sight: 9, speed: 2.8, turnRate: 0.12, air: true, weapon: 'heavyUavMissile', prereq: ['airfield', 'tech'], radius: 0.55, desc: 'Heavy strike drone with guided missiles.', aiWeight: 3, aiTag: 'main' },
  },
  iran: {
    mbt: { name: 'Karrar MBT' },
    at: { cost: 240 },
    shahedl: { name: 'Shahed Launcher', model: 'container', category: 'vehicle', cost: 1100, buildTime: 12, hp: 220, armor: 'light', sight: 6, speed: 1.9, turnRate: 0.1, turret: false, weapon: 'shahedLaunch', prereq: ['factory', 'airfield'], desc: 'Container launcher for long-range loitering munitions.', aiWeight: 3, aiTag: 'arty' },
    fateh: { name: 'Fateh Missile Launcher', model: 'missile_truck', category: 'vehicle', cost: 1300, buildTime: 15, hp: 200, armor: 'light', sight: 6, speed: 1.7, turnRate: 0.08, turret: false, weapon: 'fateh', prereq: ['factory', 'tech'], desc: 'Road-mobile ballistic missile.', aiWeight: 1, aiTag: 'arty' },
    uav: { name: 'Mohajer UAV' },
  },
};

const FACTION_BUILDINGS: Partial<Record<Faction, Record<string, Partial<BldTpl>>>> = {
  korea: { def_gun: { name: 'SGR Sentry', model: 'sentry', cost: 400, hp: 650, sight: 9, desc: 'Automated thermal-tracking sentry gun. Hits infantry and drones.' } },
  russia: { power: { name: 'Power Plant' } },
};

// ---------------------------------------------------------------- generation

function factionWeapon(f: FactionInfo, base: string, kind: 'unit' | 'building', category: string): string {
  const w = WEAPONS[base];
  const m = f.mods;
  let dmg = 1;
  let range = 0;
  if (m.artilleryDamage && (w.projectile === 'artillery' || w.warhead === 'thermo')) dmg *= m.artilleryDamage;
  if (m.infantryDamage && category === 'infantry') dmg *= m.infantryDamage;
  if (m.defenseRange && kind === 'building') range += m.defenseRange;
  if (dmg === 1 && range === 0) return base;
  const id = `${f.id}_${base}_${kind}`;
  WEAPONS[id] = { ...w, id, damage: Math.round(w.damage * dmg), range: w.range + range };
  return id;
}

const list: Def[] = [];

for (const f of FACTIONS) {
  const m = f.mods;
  const overrides = FACTION_UNITS[f.id];
  const replaced = new Set(Object.values(overrides).map((o) => o.replaces).filter(Boolean) as string[]);
  const roster: Record<string, UnitTpl> = {};
  for (const [k, t] of Object.entries(UNITS)) if (!replaced.has(k)) roster[k] = { ...t };
  for (const [k, o] of Object.entries(overrides)) {
    const { replaces, ...rest } = o;
    const base = roster[k] ?? (replaces ? UNITS[replaces] : undefined);
    const inf = rest.category === 'infantry';
    roster[k] = base ? { ...base, ...rest } : ({ radius: inf ? 0.18 : 0.42, turnRate: inf ? 0.5 : 0.1, turret: false, ...rest } as UnitTpl);
  }
  for (const [k, t] of Object.entries(roster)) {
    const u: UnitDef = { kind: 'unit', buildable: true, faction: f.id, id: `${f.id}_${k}`, ...t };
    const cat = u.category;
    if (cat === 'infantry' && m.infantryCost) u.cost = Math.round((u.cost * m.infantryCost) / 10) * 10;
    if (cat === 'vehicle' && m.vehicleCost) u.cost = Math.round((u.cost * m.vehicleCost) / 10) * 10;
    if (cat === 'air' && m.airCost) u.cost = Math.round((u.cost * m.airCost) / 10) * 10;
    if (cat === 'air' && m.airHp) u.hp = Math.round(u.hp * m.airHp);
    if (cat === 'air' && m.airBuild) u.buildTime *= m.airBuild;
    if (cat === 'vehicle' && m.vehicleBuild) u.buildTime *= m.vehicleBuild;
    if (cat === 'vehicle' && m.vehicleSpeed) u.speed *= m.vehicleSpeed;
    if (cat === 'vehicle' && m.aps && !u.harvester && !u.mcv) u.aps = Math.max(u.aps ?? 0, m.aps);
    if (m.sight) u.sight += m.sight;
    if (f.id === 'iran' && u.weapon && ['rocket', 'missile'].includes(WEAPONS[u.weapon].warhead) && k !== 'at') u.cost = Math.round((u.cost * 0.8) / 10) * 10;
    if (u.weapon) u.weapon = factionWeapon(f, u.weapon, 'unit', cat);
    list.push(u);
  }
  for (const [k, t] of Object.entries(MUNITIONS)) {
    list.push({ kind: 'unit', buildable: false, faction: f.id, id: `${f.id}_${k}`, ...t });
  }
  for (const [k, t] of Object.entries(BUILDINGS)) {
    const o = FACTION_BUILDINGS[f.id]?.[k] ?? {};
    const b: BuildingDef = { kind: 'building', buildable: true, armor: 'building', faction: f.id, id: `${f.id}_${k}`, ...t, ...o };
    if (m.buildingHp) b.hp = Math.round(b.hp * m.buildingHp);
    if (b.weapon) b.weapon = factionWeapon(f, b.weapon, 'building', b.category);
    list.push(b);
  }
}

list.push({
  kind: 'building',
  id: 'oil',
  name: 'Oil Derrick',
  faction: 'neutral',
  category: 'building',
  role: 'oil',
  model: 'oil',
  cost: 0,
  buildTime: 1,
  hp: 800,
  armor: 'building',
  sight: 3,
  w: 2,
  h: 2,
  power: 0,
  income: 25,
  capturable: true,
  prereq: [],
  buildable: false,
  desc: 'Capture with an Engineer for steady income.',
});

export const DEFS: Record<string, Def> = Object.fromEntries(list.map((d) => [d.id, d]));
export const DEF_LIST = list;

export function unitDef(id: string): UnitDef {
  return DEFS[id] as UnitDef;
}
export function buildingDef(id: string): BuildingDef {
  return DEFS[id] as BuildingDef;
}

export function defsForFaction(f: Faction): Def[] {
  return list.filter((d) => d.faction === f && d.buildable);
}

export function factionDefByRole(f: Faction, role: string): BuildingDef {
  return list.find((d) => d.kind === 'building' && d.faction === f && d.role === role) as BuildingDef;
}

export function factionUnit(f: Faction, pred: (d: UnitDef) => boolean): UnitDef {
  return list.find((d) => d.kind === 'unit' && d.faction === f && pred(d)) as UnitDef;
}

/** Spawned munition def for a launcher's weapon, in the launcher's faction. */
export function munitionDef(f: Faction | 'neutral', spawn: string): string {
  return `${f}_${spawn}`;
}
