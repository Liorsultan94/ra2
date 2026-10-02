// Static data for the "special" map objects and powers: garrisonable civilian
// houses, capturable tech structures and the per-nation superweapons.
// Only imports types, so defs.ts can pull it in without an import cycle.

import { TPS, type BuildingDef, type Faction, type WeaponDef } from './types';

// ------------------------------------------------------------- garrisons

/** Civilian houses infantry can occupy (RA2 style); one def per footprint / look. */
export const CIVILIAN_BUILDINGS: BuildingDef[] = [
  civ('civ_house', 'Village House', 2, 2, 900, 6),
  civ('civ_cottage', 'Cottage', 2, 2, 700, 5),
  civ('civ_barn', 'Farm Barn', 3, 2, 1100, 6),
];

function civ(id: string, name: string, w: number, h: number, hp: number, garrison: number): BuildingDef {
  return {
    kind: 'building',
    id,
    name,
    faction: 'neutral',
    category: 'building',
    role: 'civilian',
    model: 'civ_garrison',
    cost: 0,
    buildTime: 1,
    hp,
    armor: 'building',
    sight: 6,
    w,
    h,
    power: 0,
    garrison,
    prereq: [],
    buildable: false,
    desc: `Civilian building. Up to ${garrison} infantry can garrison it and fire from the windows (+range, +firepower). Flamethrowers and thermobaric weapons burn garrisons out.`,
  };
}

// ---------------------------------------------------------- tech buildings

export type TechKind = 'hospital' | 'airport' | 'comms';

export const TECH_BUILDINGS: BuildingDef[] = [
  tech('tech_hospital', 'hospital', 'Field Hospital', 2, 2, 900, 5, 'Capture with an Engineer: heals your infantry nearby.'),
  tech('tech_airport', 'airport', 'Civilian Airport', 3, 3, 1300, 6, 'Capture with an Engineer: your Airborne drop recharges 50% faster.'),
  tech('tech_comms', 'comms', 'Comms Tower', 2, 2, 700, 15, 'Capture with an Engineer: reveals a wide area and works as a radar.'),
];

function tech(id: string, kind: TechKind, name: string, w: number, h: number, hp: number, sight: number, desc: string): BuildingDef {
  return {
    kind: 'building',
    id,
    name,
    faction: 'neutral',
    category: 'building',
    role: `tech_${kind}`,
    model: id,
    cost: 0,
    buildTime: 1,
    hp,
    armor: 'building',
    sight,
    w,
    h,
    power: 0,
    capturable: true,
    techKind: kind,
    prereq: [],
    buildable: false,
    desc,
  };
}

/** Field hospital: heal radius (tiles) and heal per second (fraction of max hp). */
export const HOSPITAL_RADIUS = 5;
export const HOSPITAL_HEAL = 0.05;

// ------------------------------------------------------------ superweapons

export type SwKind = 'darkEagle' | 'ironBeam' | 'droneSwarm' | 'tos2' | 'taurusSalvo' | 'hyunmoo5' | 'neptuneFpv' | 'kizilelma' | 'kheibar';

export interface SwInfo {
  kind: SwKind;
  name: string; // the power
  building: string; // the structure's name
  charge: number; // ticks
  radius: number; // targeting circle shown to the player (tiles)
  desc: string;
  /** defensive power (Iron Beam): targeted on your own forces */
  defensive?: boolean;
}

export const SW_BY_FACTION: Record<Faction, SwKind> = {
  usa: 'darkEagle',
  israel: 'ironBeam',
  china: 'droneSwarm',
  russia: 'tos2',
  germany: 'taurusSalvo',
  korea: 'hyunmoo5',
  ukraine: 'neptuneFpv',
  turkey: 'kizilelma',
  iran: 'kheibar',
};

const MIN = TPS * 60;

export const SW_INFO: Record<SwKind, SwInfo> = {
  darkEagle: { kind: 'darkEagle', name: 'Dark Eagle Strike', building: 'Dark Eagle LRHW Battery', charge: 7 * MIN, radius: 3, desc: 'Three hypersonic glide vehicles slam into the target area. Each takes 2 intercepts.' },
  ironBeam: { kind: 'ironBeam', name: 'Iron Beam', building: 'Iron Beam Laser Array', charge: 6 * MIN, radius: 11, defensive: true, desc: 'A 100 kW laser dome: for 30 s every enemy missile, rocket, shell and drone entering the zone is burned out of the sky.' },
  droneSwarm: { kind: 'droneSwarm', name: 'Swarm Carrier Strike', building: 'Swarm Carrier Complex', charge: 7 * MIN, radius: 5, desc: 'Launches 24 kamikaze drones that saturate the target area.' },
  tos2: { kind: 'tos2', name: 'TOS-2 Barrage', building: 'TOS-2 Tosochka Battery Site', charge: 7 * MIN, radius: 4.5, desc: 'A carpet of 30 thermobaric rockets over the target area. Rockets can be intercepted.' },
  taurusSalvo: { kind: 'taurusSalvo', name: 'Taurus Salvo', building: 'Taurus KEPD Strike Wing', charge: 7 * MIN, radius: 7, desc: 'Four stealthy bunker-busting cruise missiles, each locked on a high-value structure.' },
  hyunmoo5: { kind: 'hyunmoo5', name: 'Hyunmoo-5', building: 'Hyunmoo-5 Silo', charge: 8 * MIN, radius: 4.5, desc: 'An 8-tonne bunker-buster on a heavy ballistic missile: one enormous blast. Takes 4 intercepts.' },
  neptuneFpv: { kind: 'neptuneFpv', name: 'Neptune + FPV Strike', building: 'Neptune Strike Center', charge: 7 * MIN, radius: 5, desc: 'Two Neptune cruise missiles followed by a wave of 12 FPV kamikaze drones.' },
  kizilelma: { kind: 'kizilelma', name: 'Kizilelma Strike Wave', building: 'Baykar Drone Base', charge: 7 * MIN, radius: 6, desc: 'Three Akinci strike drones and twelve loitering munitions sweep the target area.' },
  kheibar: { kind: 'kheibar', name: 'Kheibar / Fattah Salvo', building: 'Underground Missile City', charge: 7 * MIN, radius: 4, desc: 'Four Kheibar Shekan and two Fattah hypersonic missiles. Each needs 3 intercepts.' },
};

/** Iron Beam: active time, dome radius, max engagements per tick, and its damage to aircraft per tick. */
export const IRON_BEAM_TICKS = TPS * 30;
export const IRON_BEAM_RADIUS = 11;
export const IRON_BEAM_SHOTS = 3;
export const IRON_BEAM_AIR_DPT = 6;

export const SW_WEAPONS: WeaponDef[] = [
  { id: 'sw_darkEagle', damage: 700, range: 999, rof: 1, warhead: 'missile', projectile: 'missile', speed: 0.5, splash: 2.6, air: 'no', precise: true, flight: 'hypersonic', munition: 'hypersonic', interceptHp: 2, flightTime: 1.1 },
  { id: 'sw_tos2', damage: 120, range: 999, rof: 1, warhead: 'thermo', projectile: 'artillery', speed: 0.3, splash: 2.0, air: 'no', precise: true, flight: 'rocketSalvo', munition: 'thermoRocket', apogee: 0.6 },
  { id: 'sw_taurus', damage: 950, range: 999, rof: 1, warhead: 'missile', projectile: 'missile', speed: 0.15, splash: 1.5, air: 'no', precise: true, flight: 'cruise', munition: 'stealthCruise', lowObservable: 0.33 },
  { id: 'sw_hyunmoo5', damage: 3200, range: 999, rof: 1, warhead: 'missile', projectile: 'missile', speed: 0.3, splash: 4.5, air: 'no', precise: true, flight: 'ballistic', munition: 'heavyBallistic', interceptHp: 4, apogee: 1.35 },
  { id: 'sw_neptune', damage: 520, range: 999, rof: 1, warhead: 'missile', projectile: 'missile', speed: 0.15, splash: 1.8, air: 'no', precise: true, flight: 'cruise', munition: 'cruiseMissile', lowObservable: 0.5 },
  { id: 'sw_kheibar', damage: 520, range: 999, rof: 1, warhead: 'missile', projectile: 'missile', speed: 0.3, splash: 2.4, air: 'no', precise: true, flight: 'ballistic', munition: 'heavyBallistic', interceptHp: 3, maneuver: 0.5 },
  { id: 'sw_fattah', damage: 460, range: 999, rof: 1, warhead: 'missile', projectile: 'missile', speed: 0.45, splash: 2.2, air: 'no', precise: true, flight: 'hypersonic', munition: 'hypersonic', interceptHp: 3 },
  // the Iron Beam itself (events / effects only; it does not fire through the normal weapon path)
  { id: 'sw_ironBeam', damage: 0, range: IRON_BEAM_RADIUS, rof: 1, warhead: 'laser', projectile: 'beam', air: 'yes' },
];

/** The superweapon structure of a nation (one per faction, unlocked by the Battle Lab). */
export function superweaponBuilding(f: Faction): BuildingDef {
  const sw = SW_INFO[SW_BY_FACTION[f]];
  const variant = sw.kind === 'ironBeam' ? 'laser' : sw.kind === 'droneSwarm' || sw.kind === 'kizilelma' ? 'drone' : sw.kind === 'tos2' ? 'rocket' : sw.kind === 'taurusSalvo' || sw.kind === 'neptuneFpv' ? 'cruise' : 'silo';
  return {
    kind: 'building',
    id: `${f}_superweapon`,
    name: sw.building,
    faction: f,
    category: 'building',
    role: 'superweapon',
    model: `sw_${variant}`,
    cost: 4000,
    buildTime: 40,
    hp: 1500,
    armor: 'building',
    sight: 6,
    w: 3,
    h: 3,
    power: -150,
    superweapon: sw.kind,
    prereq: ['tech'],
    buildable: true,
    desc: `Superweapon: ${sw.name}. ${sw.desc} Charges in ${Math.round(sw.charge / MIN)} min (paused on low power). All players are warned.`,
    aiWeight: 0,
  };
}
