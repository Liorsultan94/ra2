import type { ArmorClass, BuildingDef, Def, Faction, UnitDef, Warhead, WeaponDef } from './types';
import { CIVILIAN_BUILDINGS, SW_WEAPONS, TECH_BUILDINGS, superweaponBuilding } from './specialdefs';
import { TPS } from './types';

/** Sniper lock-on: 3 s on every new target (sniper.ts SNIPER_AIM). */
const SNIPER_AIM_TICKS = 3 * TPS;

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
  // sniper rifle (sniper.ts): one shot kills any soldier (World.damage), a scratch on light armour,
  // next to nothing on tanks and buildings, can't engage aircraft
  sniper: { infantry: 1.0, light: 0.13, heavy: 0.03, building: 0.02, aircraft: 0 },
};

// ------------------------------------------------------------------ weapons

const BASE_WEAPONS: WeaponDef[] = [
  // Ground-only small arms, MGs, RPGs and autocannons: only dedicated air defence (AA vehicles, SAM sites,
  // the M-SHORAD laser, the Rocket Team's shoulder-fired missile) and air-to-air missiles can engage aircraft.
  { id: 'rifle', damage: 15, range: 4.5, rof: 18, warhead: 'mg', projectile: 'instant', air: 'no' },
  // sniper rifle: 2.5x the rifleman's reach, a 3 s lock-on per new target (sniper.ts), bolt cycle 2.5 s
  { id: 'sniper', damage: 125, range: 4.5 * 2.5, rof: 50, warhead: 'sniper', projectile: 'instant', air: 'no', aim: SNIPER_AIM_TICKS },
  { id: 'mgHeavy', damage: 14, range: 5, rof: 7, warhead: 'mg', projectile: 'instant', air: 'no' },
  { id: 'atRocket', damage: 42, range: 5.5, rof: 42, warhead: 'rocket', projectile: 'rocket', speed: 0.45, air: 'no' , flight: 'atgm', munition: 'rpg' },
  { id: 'cannon', damage: 62, range: 5.5, rof: 42, warhead: 'cannon', projectile: 'shell', speed: 0.9, air: 'no' , flight: 'shell', munition: 'tankShell' },
  { id: 'cannonHeavy', damage: 76, range: 6, rof: 44, warhead: 'cannon', projectile: 'shell', speed: 0.95, air: 'no' , flight: 'shell', munition: 'tankShell' },
  { id: 'flak', damage: 20, range: 7, rof: 6, warhead: 'flak', projectile: 'instant', air: 'only' },
  // MANPADS (Stinger / Verba / QW-2 / Misagh...): the Rocket Team's secondary weapon (UnitDef.weapon2), a shoulder-launched
  // IR-homing missile, air targets only. Slow to reload (3.5 s, its own reload apart from the RPG's). 3 hits down an attack
  // helicopter (2 a light one); the small warhead does 60% against a fast jet (4 hits). Stealth and decoy flares (stealth.ts)
  // apply as to any anti-air weapon.
  { id: 'manpads', damage: 180, range: 7, rof: 70, warhead: 'missile', projectile: 'rocket', speed: 0.6, air: 'only', flight: 'sam', munition: 'manpads', shoulder: true, vsFixedWing: 0.6 },
  { id: 'sam', damage: 80, range: 9, rof: 45, warhead: 'missile', projectile: 'rocket', speed: 0.6, air: 'only' , flight: 'sam', munition: 'sam', intercept: { kinds: ['ballistic', 'hypersonic', 'rocketSalvo', 'cruise'], pk: 0.8, pkHypersonic: 0.3, pkBy: { cruise: 0.7 }, ceiling: 9 } },
  // ---- national air & missile defence (all also engage aircraft). pk per engagement; heavy missiles need several hits.
  // Iron Dome: Tamir interceptors, superb vs rockets / shells / cruise missiles; cues David's Sling Stunners vs ballistic threats;
  // fires up to 6 interceptors a second into a salvo (each at its own threat)
  { id: 'ironDome', damage: 80, range: 10, rof: 26, warhead: 'missile', projectile: 'rocket', speed: 0.7, air: 'only', flight: 'interceptor', munition: 'interceptor', intercept: { kinds: ['artillery', 'mortar', 'rocketSalvo', 'ballistic', 'hypersonic', 'cruise'], pk: 0.92, pkHypersonic: 0.35, pkBy: { ballistic: 0.55, cruise: 0.85 }, ceiling: 6, layer: { kinds: ['ballistic', 'hypersonic'], weapon: 'stunner' }, perSec: 6 } },
  { id: 'stunner', damage: 80, range: 10, rof: 26, warhead: 'missile', projectile: 'rocket', speed: 0.8, air: 'only', flight: 'sam', munition: 'sam', intercept: { kinds: ['ballistic', 'hypersonic'], pk: 0.8, pkHypersonic: 0.45, ceiling: 12 } },
  // Patriot PAC-3 MSE: hit-to-kill, the best ballistic-missile killer
  { id: 'patriot', damage: 85, range: 11, rof: 34, warhead: 'missile', projectile: 'rocket', speed: 0.7, air: 'only', flight: 'sam', munition: 'sam', intercept: { kinds: ['ballistic', 'hypersonic', 'rocketSalvo', 'cruise'], pk: 0.75, pkBy: { ballistic: 0.92, hypersonic: 0.45, cruise: 0.7 }, ceiling: 12 } },
  // S-400 / HQ-9 / Bavar-373: long-range area defence, solid but slower to reload
  { id: 's400', damage: 90, range: 13, rof: 50, warhead: 'missile', projectile: 'rocket', speed: 0.7, air: 'only', flight: 'sam', munition: 'sam', intercept: { kinds: ['ballistic', 'hypersonic', 'rocketSalvo', 'cruise'], pk: 0.72, pkBy: { ballistic: 0.82, hypersonic: 0.4, cruise: 0.6 }, ceiling: 13 } },
  { id: 'hq9', damage: 85, range: 12, rof: 46, warhead: 'missile', projectile: 'rocket', speed: 0.7, air: 'only', flight: 'sam', munition: 'sam', intercept: { kinds: ['ballistic', 'hypersonic', 'rocketSalvo', 'cruise'], pk: 0.75, pkBy: { ballistic: 0.8, hypersonic: 0.35, cruise: 0.65 }, ceiling: 12 } },
  { id: 'bavar', damage: 80, range: 12, rof: 50, warhead: 'missile', projectile: 'rocket', speed: 0.65, air: 'only', flight: 'sam', munition: 'sam', intercept: { kinds: ['ballistic', 'hypersonic', 'rocketSalvo', 'cruise'], pk: 0.72, pkBy: { ballistic: 0.75, hypersonic: 0.3, cruise: 0.6 }, ceiling: 11 } },
  // IRIS-T SLM / Hisar-O: fast-reacting medium-range defence, deadly vs cruise missiles and rockets, weak vs ballistic
  { id: 'irisT', damage: 80, range: 9, rof: 32, warhead: 'missile', projectile: 'rocket', speed: 0.75, air: 'only', flight: 'sam', munition: 'sam', intercept: { kinds: ['ballistic', 'hypersonic', 'rocketSalvo', 'cruise'], pk: 0.85, pkBy: { ballistic: 0.6, hypersonic: 0.2, cruise: 0.9 }, ceiling: 8 } },
  { id: 'hisar', damage: 75, range: 8, rof: 34, warhead: 'missile', projectile: 'rocket', speed: 0.7, air: 'only', flight: 'sam', munition: 'sam', intercept: { kinds: ['ballistic', 'hypersonic', 'rocketSalvo', 'cruise'], pk: 0.8, pkBy: { ballistic: 0.6, hypersonic: 0.2, cruise: 0.85 }, ceiling: 6 } },
  // Cheongung II (KM-SAM Block 2): hit-to-kill upgrade, good vs ballistic missiles
  { id: 'kmsam', damage: 80, range: 10, rof: 42, warhead: 'missile', projectile: 'rocket', speed: 0.7, air: 'only', flight: 'sam', munition: 'sam', intercept: { kinds: ['ballistic', 'hypersonic', 'rocketSalvo', 'cruise'], pk: 0.78, pkBy: { ballistic: 0.85, hypersonic: 0.35, cruise: 0.75 }, ceiling: 11 } },
  { id: 'atgm', damage: 95, range: 7, rof: 55, warhead: 'rocket', projectile: 'rocket', speed: 0.5, air: 'no' , flight: 'topAttack', munition: 'atgm' },
  { id: 'laser', damage: 40, range: 7, rof: 16, warhead: 'laser', projectile: 'beam', air: 'yes' , intercept: { kinds: ['mortar', 'artillery', 'rocketSalvo', 'cruise'], pk: 0.45, pkBy: { cruise: 0.3 }, ceiling: 6 } },
  { id: 'howitzer', damage: 95, range: 10, minRange: 3, rof: 90, warhead: 'artillery', projectile: 'artillery', speed: 0.25, splash: 1.2, air: 'no' , flight: 'artillery', munition: 'artilleryShell' },
  { id: 'k9', damage: 80, range: 11, minRange: 3, rof: 64, burst: 2, burstDelay: 8, warhead: 'artillery', projectile: 'artillery', speed: 0.28, splash: 1.2, air: 'no' , flight: 'artillery', munition: 'artilleryShell' },
  { id: 'tos', damage: 40, range: 9, minRange: 3, rof: 140, burst: 6, burstDelay: 3, warhead: 'thermo', projectile: 'artillery', speed: 0.22, splash: 2, air: 'no' , flight: 'rocketSalvo', munition: 'thermoRocket' },
  { id: 'mortar', damage: 55, range: 9, minRange: 2, rof: 60, warhead: 'artillery', projectile: 'artillery', speed: 0.2, splash: 1, air: 'no', precise: true , flight: 'mortar', munition: 'mortarBomb' },
  // ---- strike missiles. interceptHp = successful intercepts needed to destroy one round.
  { id: 'dfMissile', damage: 340, range: 16, minRange: 5, rof: 300, warhead: 'missile', projectile: 'missile', speed: 0.45, splash: 1.6, air: 'no', precise: true , flight: 'hypersonic', munition: 'hypersonic', interceptHp: 2 },
  { id: 'fateh', damage: 260, range: 15, minRange: 5, rof: 250, warhead: 'missile', projectile: 'missile', speed: 0.35, splash: 2, air: 'no' , flight: 'ballistic', munition: 'ballistic' },
  // Khorramshahr-4: heavy liquid-fuelled MRBM, 1.5 t warhead, very high apogee, slow to reload. Takes 3 intercepts.
  { id: 'khorramshahr', damage: 560, range: 20, minRange: 7, rof: 520, warhead: 'missile', projectile: 'missile', speed: 0.3, splash: 3, air: 'no', flight: 'ballistic', munition: 'heavyBallistic', interceptHp: 3, apogee: 1.0, flightTime: 1.4 },
  // Iskander-M: depressed quasi-ballistic trajectory (seen late, below the radar horizon) with a weaving terminal phase
  { id: 'iskander', damage: 330, range: 17, minRange: 5, rof: 300, warhead: 'missile', projectile: 'missile', speed: 0.4, splash: 1.8, air: 'no', precise: true, flight: 'ballistic', munition: 'quasiBallistic', interceptHp: 2, apogee: 0.55, flightTime: 0.9, maneuver: 1.1, lowObservable: 0.75 },
  // PrSM (HIMARS): fast, precise, flat trajectory
  { id: 'prsm', damage: 250, range: 16, minRange: 5, rof: 220, warhead: 'missile', projectile: 'missile', speed: 0.45, splash: 1.4, air: 'no', precise: true, flight: 'ballistic', munition: 'quasiBallistic', apogee: 0.7, flightTime: 0.8 },
  // LORA: sea / land based theatre missile with a manoeuvring warhead
  { id: 'lora', damage: 300, range: 18, minRange: 5, rof: 280, warhead: 'missile', projectile: 'missile', speed: 0.4, splash: 1.6, air: 'no', precise: true, flight: 'ballistic', munition: 'quasiBallistic', interceptHp: 2, apogee: 0.85, maneuver: 0.5 },
  { id: 'hyunmoo', damage: 320, range: 18, minRange: 5, rof: 300, warhead: 'missile', projectile: 'missile', speed: 0.4, splash: 1.8, air: 'no', precise: true, flight: 'ballistic', munition: 'quasiBallistic', interceptHp: 2 },
  { id: 'tayfun', damage: 300, range: 18, minRange: 5, rof: 290, warhead: 'missile', projectile: 'missile', speed: 0.42, splash: 1.8, air: 'no', precise: true, flight: 'ballistic', munition: 'quasiBallistic', interceptHp: 2, apogee: 0.8, flightTime: 0.9 },
  // cruise missiles: slow and fragile but terrain-hugging - defences only see them at a fraction of their range
  { id: 'tomahawk', damage: 300, range: 22, minRange: 6, rof: 320, warhead: 'missile', projectile: 'missile', speed: 0.15, splash: 1.6, air: 'no', precise: true, flight: 'cruise', munition: 'cruiseMissile', lowObservable: 0.4 },
  { id: 'taurus', damage: 360, range: 20, minRange: 6, rof: 340, warhead: 'missile', projectile: 'missile', speed: 0.15, splash: 1.3, air: 'no', precise: true, flight: 'cruise', munition: 'stealthCruise', lowObservable: 0.3 },
  { id: 'neptune', damage: 280, range: 19, minRange: 6, rof: 300, warhead: 'missile', projectile: 'missile', speed: 0.15, splash: 1.6, air: 'no', precise: true, flight: 'cruise', munition: 'cruiseMissile', lowObservable: 0.45 },
  { id: 'autocannon', damage: 16, range: 5.5, rof: 7, warhead: 'flak', projectile: 'instant', air: 'no' },
  { id: 'heliMissile', damage: 105, range: 7, rof: 70, burst: 2, burstDelay: 10, warhead: 'missile', projectile: 'rocket', speed: 0.55, air: 'no' , flight: 'airMissile', munition: 'airMissile' },
  { id: 'airMissile', damage: 95, range: 8, rof: 70, burst: 2, burstDelay: 8, warhead: 'missile', projectile: 'rocket', speed: 0.8, air: 'yes' , flight: 'airMissile', munition: 'airMissile' },
  // jet sortie (airbase.ts): ONE heavy bomb per sortie, released in level flight ~3 tiles short of the target.
  // Tuned to the 2000-credit jet and its ~45 s cycle: a direct hit kills a main battle tank, two sorties a refinery.
  { id: 'jetBomb', damage: 400, range: 3.2, rof: 1, warhead: 'missile', projectile: 'missile', speed: 0.2, splash: 1.9, air: 'no', flight: 'bomb', munition: 'bomb', precise: true },
  { id: 'uavMissile', damage: 48, range: 6, rof: 50, warhead: 'rocket', projectile: 'rocket', speed: 0.6, air: 'no' , flight: 'airMissile', munition: 'airMissile' },
  { id: 'heavyUavMissile', damage: 90, range: 7, rof: 60, burst: 2, burstDelay: 8, warhead: 'missile', projectile: 'rocket', speed: 0.6, air: 'no' , flight: 'airMissile', munition: 'airMissile' },
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
for (const w of SW_WEAPONS) WEAPONS[w.id] = w; // superweapon munitions (specialdefs.ts)

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
  aps?: number; // Trophy-style active protection fitted to every vehicle (1 = full system; ballistics.ts APS_PK)
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
    signature: ['usa_laser', 'usa_fighter'],
  },
  {
    id: 'israel',
    name: 'Israel',
    doctrine: 'Urban & Active-Protection Maneuver',
    bonuses: ['All vehicles carry active protection (intercepts rockets & missiles)', '+20% infantry damage in close combat'],
    hull: 0x9c9878,
    accent: 0x2f5fa8,
    flag: [0x0038b8, 0xffffff, 0x0038b8],
    mods: { aps: 1, infantryDamage: 1.2 },
    signature: ['israel_mbt', 'israel_mortar'],
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
  // airbase (airbase.ts): runway along the front row, 4 jet stands along the back; each base parks 4 jets (the jet cap)
  airfield: { name: 'Airbase', category: 'building', role: 'airfield', model: 'airfield', cost: 1000, buildTime: 12, hp: 1100, sight: 6, w: 7, h: 4, power: -40, exit: [6, 3], produces: 'air', prereq: ['radar'], desc: 'Runway and 4 jet stands: builds aircraft and drones. Each airbase parks and rearms 4 jets.' },
  tech: { name: 'Battle Lab', category: 'building', role: 'tech', model: 'tech', cost: 2000, buildTime: 20, hp: 1000, sight: 5, w: 3, h: 3, power: -100, prereq: ['factory', 'radar'], desc: 'Unlocks advanced technology.' },
  def_gun: { name: 'MG Bunker', category: 'defense', role: 'def_gun', model: 'bunker', cost: 450, buildTime: 6, hp: 500, sight: 6, w: 1, h: 1, power: 0, weapon: 'mgHeavy', prereq: ['barracks'], desc: 'Machine gun nest. Shreds infantry; ground targets only.' },
  def_aa: { name: 'SAM Battery', category: 'defense', role: 'def_aa', model: 'sam', cost: 900, buildTime: 9, hp: 550, sight: 10, w: 1, h: 1, power: -40, weapon: 'sam', needsPower: true, prereq: ['barracks'], desc: 'Surface-to-air interceptors. Shoots down aircraft, drones, rockets and missiles. Needs power.' },
  def_at: { name: 'ATGM Tower', category: 'defense', role: 'def_at', model: 'atgm', cost: 1200, buildTime: 12, hp: 700, sight: 8, w: 1, h: 1, power: -60, weapon: 'atgm', needsPower: true, prereq: ['radar'], desc: 'Long-range anti-tank missiles. Needs power.' },
};

const UNITS: Record<string, UnitTpl> = {
  rifle: { name: 'Rifleman', category: 'infantry', model: 'rifle', cost: 150, buildTime: 4, hp: 110, armor: 'infantry', sight: 5, speed: 1.35, turnRate: 0.5, turret: false, radius: 0.18, weapon: 'rifle', prereq: ['barracks'], desc: 'Basic infantry. Ground targets only: cannot hit aircraft.', aiWeight: 5, aiTag: 'main' },
  // the one soldier that fights both: RPG against ground targets, a shoulder-fired guided missile (weapon2) against aircraft
  at: { name: 'Rocket Team (AT/AA)', category: 'infantry', model: 'at', cost: 400, buildTime: 5, hp: 110, armor: 'infantry', sight: 7, speed: 1.25, turnRate: 0.5, turret: false, radius: 0.18, weapon: 'atRocket', weapon2: 'manpads', prereq: ['barracks'], desc: 'RPG against tanks, infantry and buildings, plus a shoulder-fired guided missile against helicopters, jets and drones.', aiWeight: 4, aiTag: 'main' },
  sniper: { name: 'Sniper', category: 'infantry', model: 'sniper', cost: 600, buildTime: 8, hp: 90, armor: 'infantry', sight: 11, speed: 1.2, turnRate: 0.5, turret: false, radius: 0.18, weapon: 'sniper', prereq: ['barracks', 'radar'], desc: 'Long-range marksman: 2.5x rifle range, takes 3 s to lock on to each new target, then one shot kills any soldier. Barely scratches armour; cannot hit aircraft. +20% range from a building window.', aiWeight: 2, aiTag: 'main' },
  // combat medic (medic.ts): unarmed, treats wounded friendly soldiers back onto their feet and injured ones back to full health
  medic: { name: 'Combat Medic', category: 'infantry', model: 'medic', cost: 300, buildTime: 5, hp: 100, armor: 'infantry', sight: 6, speed: 1.35, turnRate: 0.5, turret: false, radius: 0.18, medic: true, prereq: ['barracks'], desc: 'Unarmed. Runs to wounded soldiers nearby and treats them back into the fight before they bleed out; patches injured infantry back to full health.', aiWeight: 0, aiTag: 'support' },
  engineer: { name: 'Engineer', category: 'infantry', model: 'engineer', cost: 500, buildTime: 6, hp: 75, armor: 'infantry', sight: 4, speed: 1.2, turnRate: 0.5, turret: false, radius: 0.18, engineer: true, prereq: ['barracks'], desc: 'Captures enemy and neutral buildings, repairs your own.', aiWeight: 0 },
  mbt: { name: 'Main Battle Tank', category: 'vehicle', model: 'mbt', cost: 800, buildTime: 9, hp: 380, armor: 'heavy', sight: 6, speed: 2.2, turnRate: 0.11, turret: true, radius: 0.45, weapon: 'cannon', prereq: ['factory'], desc: 'Main battle tank.', aiWeight: 7, aiTag: 'main' },
  aa: { name: 'AA Vehicle', category: 'vehicle', model: 'aa', cost: 700, buildTime: 8, hp: 230, armor: 'light', sight: 8, speed: 2.3, turnRate: 0.12, turret: true, radius: 0.42, weapon: 'flak', prereq: ['factory'], desc: 'Rapid-fire air defense. Air targets only.', aiWeight: 1, aiTag: 'aa' },
  arty: { name: 'Self-Propelled Howitzer', category: 'vehicle', model: 'arty', cost: 1000, buildTime: 11, hp: 180, armor: 'light', sight: 6, speed: 1.7, turnRate: 0.09, turret: true, radius: 0.45, weapon: 'howitzer', prereq: ['factory', 'radar'], desc: 'Long-range artillery.', aiWeight: 2, aiTag: 'arty' },
  harvester: { name: 'Ore Harvester', category: 'vehicle', model: 'harvester', cost: 1400, buildTime: 14, hp: 1000, armor: 'heavy', sight: 4, speed: 1.6, turnRate: 0.1, turret: false, radius: 0.5, harvester: true, prereq: ['factory', 'refinery'], desc: 'Gathers ore and gems.', aiWeight: 0 },
  mcv: { name: 'MCV', category: 'vehicle', model: 'mcv', cost: 3000, buildTime: 30, hp: 1000, armor: 'heavy', sight: 5, speed: 1.4, turnRate: 0.08, turret: false, radius: 0.55, mcv: true, prereq: ['factory', 'radar'], desc: 'Deploys into a Construction Yard.', aiWeight: 0 },
  apc: { name: 'Infantry Fighting Vehicle', category: 'vehicle', model: 'apc', cost: 800, buildTime: 9, hp: 320, armor: 'light', sight: 7, speed: 2.6, turnRate: 0.12, turret: true, radius: 0.45, weapon: 'autocannon', transport: 5, prereq: ['factory'], desc: 'Autocannon IFV. Carries 5 infantry who fire from inside. Ground targets only.', aiWeight: 3, aiTag: 'main' },
  robot: { name: 'Combat Robot', category: 'vehicle', model: 'ugv', cost: 450, buildTime: 6, hp: 200, armor: 'light', sight: 7, speed: 2.8, turnRate: 0.2, turret: true, radius: 0.3, weapon: 'mgHeavy', prereq: ['factory'], desc: 'Unmanned armed ground robot.', aiWeight: 2, aiTag: 'scout' },
  heli: { name: 'Attack Helicopter', category: 'air', model: 'heli', cost: 1500, buildTime: 14, hp: 420, armor: 'aircraft', sight: 8, speed: 3.0, turnRate: 0.12, turret: false, radius: 0.5, air: true, rotary: true, cruiseAlt: 1.15, weapon: 'heliMissile', prereq: ['airfield'], desc: 'Attack helicopter with anti-tank missiles. Badly damaged, it flies back to its airbase to land and be repaired.', aiWeight: 3, aiTag: 'main' },
  fighter: { name: 'Fighter Jet', category: 'air', model: 'fighter', cost: 2000, buildTime: 18, hp: 380, armor: 'aircraft', sight: 10, speed: 5.0, turnRate: 0.12, turret: false, radius: 0.55, air: true, fixedWing: true, cruiseAlt: 2.6, weapon: 'jetBomb', prereq: ['airfield', 'tech'], desc: 'Strike jet. Takes off from its airbase, drops one heavy bomb on the target, lands, repairs and rearms (10 s), then strikes again until the target is destroyed. 4 jets per airbase.', aiWeight: 2, aiTag: 'main' },
  uav: { name: 'Strike UAV', category: 'air', model: 'uav', cost: 900, buildTime: 10, hp: 180, armor: 'aircraft', sight: 8, speed: 3.0, turnRate: 0.15, turret: false, radius: 0.4, air: true, weapon: 'uavMissile', prereq: ['airfield'], desc: 'Armed drone. Attacks ground targets.', aiWeight: 3, aiTag: 'main' },
};

// Munitions launched by drone carriers (never built directly).
const MUNITIONS: Record<string, UnitTpl> = {
  fpv: { name: 'FPV Drone', category: 'air', model: 'fpv', cost: 0, buildTime: 1, hp: 30, armor: 'aircraft', sight: 4, speed: 5.5, turnRate: 0.4, turret: false, radius: 0.15, air: true, kamikaze: true, temp: true, weapon: 'fpvWarhead', prereq: [], buildable: false, desc: '' },
  micro: { name: 'Swarm Drone', category: 'air', model: 'micro', cost: 0, buildTime: 1, hp: 35, armor: 'aircraft', sight: 4, speed: 4.5, turnRate: 0.4, turret: false, radius: 0.15, air: true, kamikaze: true, temp: true, weapon: 'microWarhead', prereq: [], buildable: false, desc: '' },
  shahed: { name: 'Loitering Munition', category: 'air', model: 'shahed', cost: 0, buildTime: 1, hp: 70, armor: 'aircraft', sight: 4, speed: 2.6, turnRate: 0.2, turret: false, radius: 0.25, air: true, kamikaze: true, temp: true, weapon: 'shahedWarhead', prereq: [], buildable: false, desc: '' },
};

/**
 * Airborne-drop support power: the transport each nation flies the stick in with (real types in service).
 * Model keys map to the procedural airframes in render/models/aircraft.ts.
 */
export const TRANSPORTS: Record<Faction, { name: string; model: string }> = {
  usa: { name: 'C-17A Globemaster III', model: 'tr_c17' },
  israel: { name: 'C-130J Shimshon', model: 'tr_c130j' },
  china: { name: 'Y-20 Kunpeng', model: 'tr_y20' },
  russia: { name: 'Il-76MD', model: 'tr_il76' },
  germany: { name: 'A400M Atlas', model: 'tr_a400m' },
  korea: { name: 'C-130J-30 Super Hercules', model: 'tr_c130j' },
  ukraine: { name: 'An-26', model: 'tr_an26' },
  turkey: { name: 'A400M Atlas', model: 'tr_a400m' },
  iran: { name: 'C-130H Hercules', model: 'tr_c130h' },
};

const TRANSPORT_TPL: UnitTpl = { name: 'Transport', category: 'air', model: 'tr_c130j', cost: 0, buildTime: 1, hp: 900, armor: 'aircraft', sight: 6, speed: 3.6, turnRate: 0.05, turret: false, radius: 0.9, air: true, fixedWing: true, airlift: true, cruiseAlt: 3.2, prereq: [], buildable: false, desc: 'Airborne-drop transport.' };

/** Per-faction overrides of the shared roster and signature additions. Real-world equipment names. */
type UnitOverride = Partial<UnitTpl> & { replaces?: string; remove?: boolean };
const FACTION_UNITS: Record<Faction, Record<string, UnitOverride>> = {
  usa: {
    sniper: { name: 'M2010 Sniper' },
    mbt: { name: 'M1A2 Abrams' },
    apc: { name: 'M2A4 Bradley' },
    laser: { replaces: 'aa', name: 'DE M-SHORAD', model: 'laser', category: 'vehicle', cost: 900, hp: 240, armor: 'light', weapon: 'laser', desc: 'Directed-energy air defense. Shreds drones, also hits ground targets.', aiWeight: 2, aiTag: 'aa' },
    arty: { name: 'M109A7 Paladin' },
    heli: { name: 'AH-64E Apache' },
    fighter: { name: 'F-35A Lightning II', sight: 11, speed: 6.0, lowObservable: 0.6, evasion: 0.3, desc: 'Fifth-generation stealth strike jet, 20% faster: one 2,000 lb JDAM per sortie, then back to its airbase to repair, rearm and strike again. Stealth: enemy air defences only lock on at 60% of their range. Evasion: decoy flares and jinking make 30% of anti-air shots and missiles miss. 4 jets per airbase.' },
    robot: { name: 'Vision 60 Robot Dog', model: 'robodog' },
    uav: { name: 'MQ-9 Reaper' },
    himars: { name: 'M142 HIMARS (PrSM)', model: 'tel_himars', category: 'vehicle', cost: 1500, buildTime: 15, hp: 220, armor: 'light', sight: 6, speed: 2.2, turnRate: 0.1, weapon: 'prsm', prereq: ['factory', 'tech'], desc: 'Precision Strike Missile: fast, flat quasi-ballistic shot. 1 intercept kills it.', aiWeight: 1, aiTag: 'arty' },
    typhon: { name: 'Typhon MRC (Tomahawk)', model: 'tel_typhon', category: 'vehicle', cost: 1800, buildTime: 18, hp: 200, armor: 'light', sight: 6, speed: 1.6, turnRate: 0.08, weapon: 'tomahawk', prereq: ['factory', 'tech'], desc: 'Tomahawk cruise missile: very long range, hugs the terrain - defences spot it only at 40% of their range.', aiWeight: 1, aiTag: 'arty' },
  },
  israel: {
    medic: { name: 'Medic' },
    sniper: { name: 'Matzpen Sniper' },
    mbt: { name: 'Merkava Mk4', model: 'mbt_heavy', cost: 1000, hp: 470, aps: 1, desc: 'Front-engined heavy tank with Trophy active protection.' },
    apc: { name: 'Namer', hp: 430, armor: 'heavy', cost: 950, desc: 'Heavily armored infantry carrier on a Merkava chassis.' },
    aa: { name: 'Machbet' },
    arty: { name: 'M109 Doher' },
    mortar: { name: 'Iron Sting Mortar Team', model: 'mortar', category: 'infantry', cost: 450, buildTime: 6, hp: 90, armor: 'infantry', sight: 7, speed: 1.1, weapon: 'mortar', prereq: ['barracks', 'radar'], desc: 'Precision-guided mortar.', aiWeight: 2, aiTag: 'arty' },
    ugv: { replaces: 'robot', name: 'Jaguar UGV', model: 'ugv', category: 'vehicle', cost: 450, buildTime: 6, hp: 220, armor: 'light', sight: 7, speed: 3.0, turnRate: 0.2, turret: true, weapon: 'mgHeavy', radius: 0.32, prereq: ['factory'], desc: 'Armed unmanned ground vehicle for route clearance.', aiWeight: 3, aiTag: 'scout' },
    heli: { name: 'AH-64D Saraf' },
    fighter: { name: 'F-35I Adir', speed: 6.0, lowObservable: 0.6, evasion: 0.3, desc: 'Israeli stealth strike jet, 20% faster: one heavy bomb per sortie, then back to its airbase to repair, rearm and strike again. Stealth: enemy air defences only lock on at 60% of their range. Evasion: decoy flares and jinking make 30% of anti-air shots and missiles miss. 4 jets per airbase.' },
    uav: { name: 'Hermes 450' },
    lora: { name: 'LORA Launcher', model: 'tel_lora', category: 'vehicle', cost: 1900, buildTime: 18, hp: 210, armor: 'light', sight: 6, speed: 1.7, turnRate: 0.08, weapon: 'lora', prereq: ['factory', 'tech'], desc: 'Long-range precision ballistic missile with a manoeuvring warhead. Takes 2 intercepts.', aiWeight: 1, aiTag: 'arty' },
  },
  china: {
    medic: { name: 'Field Medic' },
    sniper: { name: 'QBU-88 Sharpshooter' },
    mbt: { name: 'Type 99A' },
    apc: { name: 'ZBL-08' },
    aa: { name: 'PGZ-09' },
    arty: { name: 'PLZ-05' },
    swarm: { name: 'Swarm Drone Carrier', model: 'swarm', category: 'vehicle', cost: 1100, buildTime: 12, hp: 220, armor: 'light', sight: 8, speed: 2.0, turnRate: 0.1, turret: false, weapon: 'swarmLaunch', prereq: ['factory', 'airfield'], desc: 'Launches coordinated kamikaze drone swarms.', aiWeight: 3, aiTag: 'main' },
    df: { name: 'DF-17 Launcher', model: 'missile_truck', category: 'vehicle', cost: 1800, buildTime: 18, hp: 200, armor: 'light', sight: 6, speed: 1.6, turnRate: 0.08, turret: false, weapon: 'dfMissile', prereq: ['factory', 'tech'], desc: 'Hypersonic glide vehicle on a ballistic booster. Very hard to intercept - takes 2 hits.', aiWeight: 1, aiTag: 'arty' },
    heli: { name: 'Z-10' },
    fighter: { name: 'J-20' },
    robot: { name: 'Armed Robot Dog', model: 'robodog' },
    uav: { name: 'Wing Loong II' },
  },
  russia: {
    medic: { name: 'Field Medic' },
    sniper: { name: 'SV-98 Sniper' },
    mbt: { name: 'T-90M', hp: 420 },
    apc: { name: 'BMP-3' },
    aa: { name: 'Pantsir-S1' },
    tos: { replaces: 'arty', name: 'TOS-1A', model: 'tos', category: 'vehicle', cost: 1300, buildTime: 13, hp: 300, armor: 'heavy', sight: 6, speed: 1.8, turnRate: 0.09, turret: true, weapon: 'tos', prereq: ['factory', 'radar'], desc: 'Thermobaric rocket salvos. Devastating vs infantry and structures.', aiWeight: 2, aiTag: 'arty' },
    ew: { name: 'Krasukha-4 EW', model: 'ew', category: 'vehicle', cost: 1000, buildTime: 11, hp: 280, armor: 'light', sight: 9, speed: 1.8, turnRate: 0.09, turret: false, ewRadius: 8, prereq: ['factory', 'radar'], desc: 'Jams enemy drones in a wide radius: slows them, stops their weapons and downs kamikaze drones.', aiWeight: 1, aiTag: 'support' },
    heli: { name: 'Ka-52 Alligator' },
    fighter: { name: 'Su-35' },
    robot: { name: 'Uran-9 UGV', model: 'ugv', hp: 260, weapon: 'autocannon', speed: 2.3 },
    uav: { name: 'Orion' },
    iskander: { name: '9K720 Iskander-M', model: 'tel_iskander', category: 'vehicle', cost: 2000, buildTime: 20, hp: 240, armor: 'light', sight: 6, speed: 1.7, turnRate: 0.08, weapon: 'iskander', prereq: ['factory', 'tech'], desc: 'Quasi-ballistic missile: low trajectory, weaving terminal dive. Takes 2 intercepts.', aiWeight: 1, aiTag: 'arty' },
  },
  germany: {
    sniper: { name: 'G29 Sniper' },
    mbt: { name: 'Leopard 2A8', model: 'mbt_heavy', cost: 1000, buildTime: 11, hp: 540, speed: 2.4, weapon: 'cannonHeavy', desc: 'Superior tank with modular composite armor.' },
    apc: { name: 'Puma', hp: 360 },
    berge: { name: 'Bergepanzer 3', model: 'berge', category: 'vehicle', cost: 800, buildTime: 9, hp: 450, armor: 'heavy', sight: 6, speed: 2.1, turnRate: 0.1, turret: false, repairAura: 3, prereq: ['factory'], desc: 'Armored recovery vehicle. Repairs nearby vehicles.', aiWeight: 1, aiTag: 'support' },
    aa: { name: 'Skyranger 30' },
    arty: { name: 'PzH 2000' },
    heli: { name: 'Tiger UHT' },
    fighter: { name: 'Eurofighter Typhoon' },
    robot: { name: 'Mission Master UGV', model: 'ugv' },
    uav: { name: 'Heron TP' },
    taurus: { name: 'Taurus KEPD 350 Launcher', model: 'tel_taurus', category: 'vehicle', cost: 1900, buildTime: 18, hp: 200, armor: 'light', sight: 6, speed: 1.7, turnRate: 0.08, weapon: 'taurus', prereq: ['factory', 'tech'], desc: 'Stealthy bunker-busting cruise missile. Terrain-following; defences spot it only at a third of their range.', aiWeight: 1, aiTag: 'arty' },
  },
  korea: {
    sniper: { name: 'K14 Sniper' },
    mbt: { name: 'K2 Black Panther' },
    apc: { name: 'K21' },
    aa: { name: 'K30 Biho' },
    arty: { name: 'K9A1 Thunder', model: 'arty', hp: 260, armor: 'heavy', cost: 1200, weapon: 'k9', desc: 'Auto-loading howitzer with burst fire.' },
    heli: { name: 'AH-64E Apache' },
    fighter: { name: 'F-15K Slam Eagle' },
    robot: { name: 'Robot Dog', model: 'robodog' },
    uav: { name: 'KUS-FS' },
    hyunmoo: { name: 'Hyunmoo-2 TEL', model: 'tel_hyunmoo', category: 'vehicle', cost: 1900, buildTime: 18, hp: 220, armor: 'light', sight: 6, speed: 1.7, turnRate: 0.08, weapon: 'hyunmoo', prereq: ['factory', 'tech'], desc: 'Precision ballistic missile with a heavy warhead. Takes 2 intercepts.', aiWeight: 1, aiTag: 'arty' },
  },
  ukraine: {
    sniper: { name: 'UAR-10 Sniper' },
    mbt: { name: 'T-84 Oplot' },
    apc: { name: 'BTR-4' },
    aa: { name: 'Gepard' },
    arty: { name: 'PzH 2000' },
    fpvteam: { name: 'FPV Drone Team', model: 'fpvteam', category: 'infantry', cost: 450, buildTime: 5, hp: 90, armor: 'infantry', sight: 7, speed: 1.25, weapon: 'fpvLaunch', prereq: ['barracks'], desc: 'Launches FPV kamikaze drones that hunt armor.', aiWeight: 4, aiTag: 'main' },
    ewinf: { name: 'EW Trooper', model: 'ewinf', category: 'infantry', cost: 350, buildTime: 5, hp: 110, armor: 'infantry', sight: 6, speed: 1.3, weapon: 'rifle', ewRadius: 4.5, prereq: ['barracks'], desc: 'Backpack jammer protects nearby troops from drones.', aiWeight: 1, aiTag: 'support' },
    heli: { name: 'Mi-24 Hind', hp: 520 },
    fighter: { name: 'F-16 Fighting Falcon' },
    robot: { name: 'THeMIS UGV', model: 'ugv' },
    uav: { name: 'Bayraktar TB2' },
    neptune: { name: 'R-360 Neptune Launcher', model: 'tel_neptune', category: 'vehicle', cost: 1600, buildTime: 16, hp: 200, armor: 'light', sight: 6, speed: 1.8, turnRate: 0.08, weapon: 'neptune', prereq: ['factory', 'tech'], desc: 'Sea-skimming cruise missile. Hugs the ground; defences spot it only at half range.', aiWeight: 1, aiTag: 'arty' },
  },
  turkey: {
    sniper: { name: 'KNT-308 Sniper' },
    mbt: { name: 'Altay' },
    apc: { name: 'Pars III' },
    aa: { name: 'Korkut' },
    arty: { name: 'T-155 Firtina' },
    uav: { name: 'Bayraktar TB2', cost: 750, hp: 240, speed: 3.2, desc: 'Long-endurance strike drone with micro-guided munitions.', aiWeight: 6 },
    akinci: { name: 'Bayraktar Akinci', model: 'heavy_uav', category: 'air', cost: 1500, buildTime: 15, hp: 460, armor: 'aircraft', sight: 9, speed: 2.8, turnRate: 0.12, air: true, weapon: 'heavyUavMissile', prereq: ['airfield', 'tech'], radius: 0.55, desc: 'Heavy strike drone with guided missiles.', aiWeight: 3, aiTag: 'main' },
    heli: { name: 'T129 ATAK' },
    fighter: { name: 'F-16 Fighting Falcon' },
    robot: { name: 'Barkan UGV', model: 'ugv' },
    tayfun: { name: 'Tayfun TEL', model: 'tel_tayfun', category: 'vehicle', cost: 1900, buildTime: 18, hp: 220, armor: 'light', sight: 6, speed: 1.7, turnRate: 0.08, weapon: 'tayfun', prereq: ['factory', 'tech'], desc: 'Fast quasi-ballistic missile. Takes 2 intercepts.', aiWeight: 1, aiTag: 'arty' },
  },
  iran: {
    medic: { name: 'Medic' },
    sniper: { name: 'Nakhjir Sniper' },
    mbt: { name: 'Karrar' },
    apc: { name: 'Boragh' },
    at: { cost: 320 },
    aa: { name: 'ZSU-23-4 Shilka' },
    arty: { name: 'Raad-2' },
    shahedl: { name: 'Shahed-136 Launcher', model: 'container', category: 'vehicle', cost: 1100, buildTime: 12, hp: 220, armor: 'light', sight: 6, speed: 1.9, turnRate: 0.1, turret: false, weapon: 'shahedLaunch', prereq: ['factory', 'airfield'], desc: 'Container launcher for long-range loitering munitions.', aiWeight: 3, aiTag: 'arty' },
    fateh: { name: 'Fateh-110 Launcher', model: 'missile_truck', category: 'vehicle', cost: 1300, buildTime: 15, hp: 200, armor: 'light', sight: 6, speed: 1.7, turnRate: 0.08, turret: false, weapon: 'fateh', prereq: ['factory', 'tech'], desc: 'Road-mobile ballistic missile.', aiWeight: 1, aiTag: 'arty' },
    khorramshahr: { name: 'Khorramshahr-4 TEL', model: 'tel_khorramshahr', category: 'vehicle', cost: 2600, buildTime: 26, hp: 260, armor: 'light', sight: 6, speed: 1.4, turnRate: 0.07, turret: false, weapon: 'khorramshahr', prereq: ['factory', 'tech'], desc: 'Heavy MRBM with a huge warhead. Slow to reload; it takes 3 successful intercepts to bring one down.', aiWeight: 1, aiTag: 'arty' },
    heli: { name: 'AH-1J Cobra', hp: 360 },
    fighter: { remove: true },
    robot: { name: 'Armed UGV', model: 'ugv' },
    uav: { name: 'Mohajer-6' },
  },
};

const FACTION_BUILDINGS: Partial<Record<Faction, Record<string, Partial<BldTpl>>>> = {
  usa: { def_aa: { name: 'Patriot Battery', weapon: 'patriot', desc: 'PAC-3 hit-to-kill interceptors: the best ballistic-missile killer. Also downs aircraft, rockets and cruise missiles. Needs power.' } },
  israel: { def_aa: { name: 'Iron Dome Battery', weapon: 'ironDome', desc: "Tamir interceptors shred rockets, shells, mortars and cruise missiles; cues David's Sling Stunners against ballistic missiles. Needs power." } },
  china: { def_aa: { name: 'HQ-9 Battery', weapon: 'hq9', desc: 'Long-range area air and missile defence. Needs power.' } },
  russia: { def_aa: { name: 'S-400 Battery', weapon: 's400', desc: 'Very long-range area air and missile defence, slow to reload. Needs power.' } },
  germany: { def_aa: { name: 'IRIS-T SLM Battery', weapon: 'irisT', desc: 'Fast-reacting medium-range SAM: deadly against cruise missiles, rockets and aircraft, weak against ballistic missiles. Needs power.' } },
  korea: {
    def_gun: { name: 'SGR-A1 Sentry', model: 'sentry', cost: 400, hp: 650, sight: 9, desc: 'Automated thermal-tracking sentry gun. Shreds infantry; ground targets only.' },
    def_aa: { name: 'Cheongung II KM-SAM', weapon: 'kmsam', desc: 'Hit-to-kill medium-range SAM, good against ballistic missiles. Needs power.' },
  },
  ukraine: { def_aa: { name: 'IRIS-T SLM Battery', weapon: 'irisT', desc: 'Fast-reacting medium-range SAM: deadly against cruise missiles, rockets and aircraft, weak against ballistic missiles. Needs power.' } },
  turkey: { def_aa: { name: 'Hisar-O Battery', weapon: 'hisar', desc: 'Short-range rapid SAM, strong against cruise missiles and rockets. Needs power.' } },
  iran: { def_aa: { name: 'Bavar-373 Battery', weapon: 'bavar', desc: 'Long-range area air and missile defence. Needs power.' } },
};

// ---------------------------------------------------------------- generation

function factionWeapon(f: FactionInfo, base: string, kind: 'unit' | 'building', category: string): string {
  const w = WEAPONS[base];
  const m = f.mods;
  let dmg = 1;
  let range = 0;
  if (m.artilleryDamage && (w.projectile === 'artillery' || w.warhead === 'thermo')) dmg *= m.artilleryDamage;
  if (m.infantryDamage && category === 'infantry' && w.air !== 'only') dmg *= m.infantryDamage; // close combat, not MANPADS
  if (m.defenseRange && kind === 'building') range += m.defenseRange;
  if (dmg === 1 && range === 0) return base;
  const id = `${f.id}_${base}_${kind}`;
  WEAPONS[id] = { ...w, id, damage: Math.round(w.damage * dmg), range: w.range + range };
  return id;
}

/**
 * Crushing (crush.ts). Every ground vehicle in the roster is a crusher - tanks, IFVs / APCs, SPAAGs and
 * self-propelled guns (20-60 t tracked or 8x8 hulls), the TOS, EW and missile trucks / TELs (15-40 t
 * heavy trucks), the recovery tank, the harvester and the MCV - except the light unmanned robots: robot
 * dogs weigh tens of kilograms and the small UGVs (THeMIS, Mission Master, Jaguar, Barkan) one to a few
 * tonnes on a narrow footprint, and their remote operators steer round people. The roster has no jeeps or
 * buggies; a ~5 t light vehicle would be the cut-off. Infantry on the ground are crushable.
 */
const LIGHT_VEHICLES = new Set(['robot', 'ugv']);

const list: Def[] = [];

for (const f of FACTIONS) {
  const m = f.mods;
  const overrides = FACTION_UNITS[f.id];
  const replaced = new Set(Object.values(overrides).map((o) => o.replaces).filter(Boolean) as string[]);
  for (const [k, o] of Object.entries(overrides)) if (o.remove) replaced.add(k);
  const roster: Record<string, UnitTpl> = {};
  for (const [k, t] of Object.entries(UNITS)) if (!replaced.has(k)) roster[k] = { ...t };
  for (const [k, o] of Object.entries(overrides)) {
    if (o.remove) continue;
    const { replaces, remove: _r, ...rest } = o;
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
    if (u.weapon2) u.weapon2 = factionWeapon(f, u.weapon2, 'unit', cat);
    if (cat === 'vehicle' && !u.temp && !u.supply && !LIGHT_VEHICLES.has(k)) u.crusher = true;
    if (cat === 'infantry') u.crushable = true;
    list.push(u);
  }
  for (const [k, t] of Object.entries(MUNITIONS)) {
    list.push({ kind: 'unit', buildable: false, faction: f.id, id: `${f.id}_${k}`, ...t });
  }
  {
    const tr = TRANSPORTS[f.id];
    const u: UnitDef = { kind: 'unit', faction: f.id, id: `${f.id}_transport`, ...TRANSPORT_TPL, buildable: false, name: tr.name, model: tr.model, desc: `${tr.name}: airborne-drop transport.` };
    if (m.airHp) u.hp = Math.round(u.hp * m.airHp);
    list.push(u);
  }
  for (const [k, t] of Object.entries(BUILDINGS)) {
    const o = FACTION_BUILDINGS[f.id]?.[k] ?? {};
    const b: BuildingDef = { kind: 'building', buildable: true, armor: 'building', faction: f.id, id: `${f.id}_${k}`, ...t, ...o };
    if (m.buildingHp) b.hp = Math.round(b.hp * m.buildingHp);
    if (b.weapon) b.weapon = factionWeapon(f, b.weapon, 'building', b.category);
    list.push(b);
  }
  {
    // the nation's superweapon structure (specialdefs.ts)
    const b = superweaponBuilding(f.id);
    if (m.buildingHp) b.hp = Math.round(b.hp * m.buildingHp);
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

// collapsible river bridges (sim/bridges.ts): the targetable deck and the engineer repair huts
list.push(
  { kind: 'building', id: 'bridge', name: 'Bridge', faction: 'neutral', category: 'building', role: 'bridge', model: 'bridge', cost: 0, buildTime: 1, hp: 2400, armor: 'building', sight: 0, w: 1, h: 1, power: 0, passable: [[0, 0]], prereq: [], buildable: false, desc: 'Only heavy ordnance (artillery, missiles) can bring it down. Engineers rebuild it from a repair hut.' },
  { kind: 'building', id: 'bridgehut', name: 'Bridge Repair Hut', faction: 'neutral', category: 'building', role: 'bridgehut', model: 'bridgehut', cost: 0, buildTime: 1, hp: 1000, armor: 'building', sight: 0, w: 1, h: 1, power: 0, capturable: true, prereq: [], buildable: false, desc: 'Send an Engineer in to rebuild a destroyed bridge or restore a damaged one.' },
);

list.push({
  kind: 'unit',
  id: 'supply_crate',
  name: 'Supply Pallet',
  faction: 'neutral',
  category: 'vehicle',
  model: 'supplycrate',
  cost: 0,
  buildTime: 1,
  hp: 160,
  armor: 'light',
  sight: 2,
  speed: 0,
  turnRate: 0,
  turret: false,
  radius: 0.25,
  temp: true,
  supply: true,
  prereq: [],
  buildable: false,
  desc: 'Air-dropped ammunition and medical supplies: heals friendly units nearby.',
});

// garrisonable civilian houses and capturable tech structures (specialdefs.ts)
list.push(...CIVILIAN_BUILDINGS, ...TECH_BUILDINGS);

/**
 * Night combat equipment (night.ts), the same for every faction:
 *  - night vision / thermal sights (UnitDef.nvg, full sight by night): snipers, main battle tanks, attack
 *    helicopters, drones / UAVs (the kamikaze drones too), fighter jets;
 *  - illumination rounds (UnitDef.illum): tube artillery, mortars and rocket artillery;
 *  - air defence sensors (airSensor: radar / IR, full sight against aircraft by night): flak, SAM sites, laser
 *    air defence, the Rocket Team's IR-seeker AA missile.
 */
export const NVG_MODELS: ReadonlySet<string> = new Set(['sniper', 'mbt', 'mbt_heavy', 'heli', 'uav', 'heavy_uav', 'fighter', 'fpv', 'micro', 'shahed']);
for (const d of list) {
  // dedicated air defence: an air-only weapon (flak, SAMs, MANPADS) or an air-capable interceptor (laser air defence)
  const aw = d.weapon ? WEAPONS[d.weapon] : undefined;
  const aw2 = d.kind === 'unit' && d.weapon2 ? WEAPONS[d.weapon2] : undefined;
  if ((aw && (aw.air === 'only' || (aw.air === 'yes' && aw.intercept))) || aw2?.air === 'only') d.airSensor = true;
  if (d.kind !== 'unit') continue;
  if (NVG_MODELS.has(d.model) && !d.airlift && !d.supply) d.nvg = true;
  const f = d.weapon && d.category !== 'air' ? WEAPONS[d.weapon]?.flight : undefined;
  if (f === 'artillery' || f === 'mortar' || f === 'rocketSalvo') d.illum = true;
}

export const DEFS: Record<string, Def> = Object.fromEntries(list.map((d) => [d.id, d]));
export const DEF_LIST = list;

export function unitDef(id: string): UnitDef {
  return DEFS[id] as UnitDef;
}
export function buildingDef(id: string): BuildingDef {
  return DEFS[id] as BuildingDef;
}

/** What a unit / structure can engage, main and secondary weapons together (an RPG + MANPADS team: 'yes'). */
export function airReach(d: Def): 'no' | 'yes' | 'only' {
  if (!d.weapon) return 'no';
  const a = WEAPONS[d.weapon].air;
  const w2 = d.kind === 'unit' && d.weapon2 ? WEAPONS[d.weapon2].air : undefined;
  if (!w2 || w2 === a) return a;
  return a === 'yes' || w2 === 'yes' || (a === 'no') !== (w2 === 'no') ? 'yes' : a;
}

/** Can this unit shoot at aircraft at all (dedicated AA, or a secondary AA weapon)? */
export function hitsAir(d: Def): boolean {
  return airReach(d) !== 'no';
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
