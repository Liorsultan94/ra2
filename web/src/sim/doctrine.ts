// AI personalities: how each nation's doctrine (defs.ts FACTIONS) shapes the
// computer player's army, defences and tactics. Pure data, read by ai.ts.

import type { Faction } from './types';

export interface Doctrine {
  /** Short description of how this AI plays (debug / UI). */
  summary: string;
  /** Unit-mix multipliers on aiWeight, keyed by roster key (def id without the faction prefix). */
  bias: Record<string, number>;
  /** Multiplier on the number of defensive structures. */
  defense: number;
  /** SAM batteries built even before the enemy fields missiles (layered air defence). */
  samFloor: number;
  /** Defence build order by role (cycled). */
  defenseOrder: string[];
  /** Wave size multiplier (mass waves > 1, fast small raids < 1). */
  wave: number;
  /** Chance that a wave (or its fast wing) takes a flanking lane instead of the front. */
  flank: number;
  /** Harvester-raid appetite (0 never, 1 every ~2 minutes, 2 twice as often). */
  harass: number;
  /** Health fraction at which vehicles / aircraft pull back to repair (0 = fight to the death). */
  retreat: number;
  /** Long-range strike launchers that fire together (missile saturation). */
  salvo: number;
  /** Artillery and strike missiles hunt enemy artillery and launchers first. */
  counterBattery: boolean;
  /** Units posted on the bridge nearest home (choke-point control). */
  choke: number;
  /** Air units that fly as an independent strike wing (0 = aircraft join the ground waves). */
  airWing: number;
  /** Preferred targets for waves and strikes (building roles), deepest first. */
  deep: string[];
  /** Spending priority per production line (> 1 = buys from it with less money in the bank). */
  spend: { infantry: number; vehicle: number; air: number };
}

const BASE_DEF = ['def_gun', 'def_aa', 'def_at', 'def_gun', 'def_at', 'def_aa'];

export const DOCTRINES: Record<Faction, Doctrine> = {
  usa: {
    summary: 'Network-centric combined arms: balanced task forces with air cover, focus fire and Tomahawk/PrSM deep strikes.',
    bias: { heli: 1.5, fighter: 1.8, uav: 1.4, apc: 1.3, mbt: 1.1, laser: 1.2, himars: 1.3, typhon: 1.2 },
    defense: 1,
    samFloor: 1,
    defenseOrder: BASE_DEF,
    wave: 1,
    flank: 0.4,
    harass: 1,
    retreat: 0.35,
    salvo: 1,
    counterBattery: false,
    choke: 0,
    airWing: 3,
    deep: ['radar', 'airfield', 'factory', 'tech'],
    spend: { infantry: 1, vehicle: 1, air: 1.3 },
  },
  israel: {
    summary: 'Precision strikes and a layered air-defence umbrella; Merkava/Trophy armour is preserved and pulled back to repair.',
    bias: { mbt: 1.5, apc: 1.2, mortar: 1.5, lora: 1.8, aa: 1.3, manpads: 1.3, ugv: 1.2, uav: 1.2, sniper: 1.4 },
    defense: 1,
    samFloor: 2,
    defenseOrder: ['def_gun', 'def_aa', 'def_at', 'def_aa', 'def_gun', 'def_aa'],
    wave: 1,
    flank: 0.35,
    harass: 0.6,
    retreat: 0.4,
    salvo: 1,
    counterBattery: true,
    choke: 2,
    airWing: 0,
    deep: ['tech', 'factory', 'radar'],
    spend: { infantry: 1, vehicle: 1.1, air: 1 },
  },
  china: {
    summary: 'A2/AD and drone swarms: swarm carriers lead, DF-17 hypersonic salvos strike the rear, cheap massed aircraft.',
    bias: { swarm: 2.2, df: 2, uav: 1.5, heli: 1.2, aa: 1.1 },
    defense: 1,
    samFloor: 1,
    defenseOrder: BASE_DEF,
    wave: 1.1,
    flank: 0.3,
    harass: 0.8,
    retreat: 0.3,
    salvo: 2,
    counterBattery: false,
    choke: 0,
    airWing: 0,
    deep: ['factory', 'tech', 'conyard'],
    spend: { infantry: 1, vehicle: 1, air: 1.3 },
  },
  russia: {
    summary: 'Mass artillery attrition: TOS/howitzer fire behind big armour waves, Krasukha EW escorting against drones.',
    bias: { tos: 2.2, mbt: 1.5, ew: 1.8, apc: 1.1, iskander: 1.4, at: 0.8, heli: 0.8 },
    defense: 1,
    samFloor: 1,
    defenseOrder: BASE_DEF,
    wave: 1.35,
    flank: 0.15,
    harass: 0.4,
    retreat: 0.2,
    salvo: 1,
    counterBattery: false,
    choke: 0,
    airWing: 0,
    deep: ['conyard', 'factory', 'refinery'],
    spend: { infantry: 0.9, vehicle: 1.3, air: 0.8 },
  },
  germany: {
    summary: 'Heavy mechanised manoeuvre: early, fast Leopard/Puma thrusts through the flanks with Bergepanzer recovery.',
    bias: { mbt: 1.7, apc: 1.5, berge: 1.6, aa: 1.1, at: 0.8, rifle: 0.7 },
    defense: 0.8,
    samFloor: 1,
    defenseOrder: BASE_DEF,
    wave: 1,
    flank: 0.45,
    harass: 1,
    retreat: 0.3,
    salvo: 1,
    counterBattery: false,
    choke: 0,
    airWing: 0,
    deep: ['factory', 'refinery', 'conyard'],
    spend: { infantry: 0.8, vehicle: 1.4, air: 0.8 },
  },
  korea: {
    summary: 'Fortified defence with K9 counter-battery fire: holds the bridges, out-guns enemy artillery, then counter-attacks in strength.',
    bias: { arty: 1.8, mbt: 1.2, at: 1.2, hyunmoo: 1.3, aa: 1.1 },
    defense: 1.4,
    samFloor: 1,
    defenseOrder: ['def_gun', 'def_at', 'def_aa', 'def_gun', 'def_at', 'def_at', 'def_aa'],
    wave: 1.1,
    flank: 0.2,
    harass: 0.4,
    retreat: 0.35,
    salvo: 1,
    counterBattery: true,
    choke: 3,
    airWing: 0,
    deep: ['factory', 'conyard'],
    spend: { infantry: 1.1, vehicle: 1.1, air: 0.9 },
  },
  ukraine: {
    summary: 'Asymmetric drone war: FPV teams and EW troopers in small mobile groups that raid harvesters and strike the flanks.',
    bias: { fpvteam: 1.8, ewinf: 1.5, manpads: 1.5, apc: 1.3, robot: 1.5, uav: 1.3, mbt: 0.8, neptune: 1.3, sniper: 1.3 },
    defense: 0.9,
    samFloor: 1,
    defenseOrder: BASE_DEF,
    wave: 1,
    flank: 0.5,
    harass: 1.2,
    retreat: 0.35,
    salvo: 1,
    counterBattery: false,
    choke: 0,
    airWing: 0,
    deep: ['refinery', 'factory', 'radar'],
    spend: { infantry: 1.5, vehicle: 1, air: 1.1 },
  },
  turkey: {
    summary: 'Persistent UAV dominance: TB2 / Akinci wings hunt harvesters, artillery and launchers far ahead of the ground forces.',
    bias: { uav: 1.5, akinci: 1.8, heli: 1.1, mbt: 1.3, apc: 1.1, aa: 1 },
    defense: 1,
    samFloor: 1,
    defenseOrder: BASE_DEF,
    wave: 1,
    flank: 0.3,
    harass: 1.2,
    retreat: 0.35,
    salvo: 1,
    counterBattery: false,
    choke: 0,
    airWing: 4,
    deep: ['refinery', 'radar', 'factory'],
    spend: { infantry: 1, vehicle: 1, air: 1.3 },
  },
  iran: {
    summary: 'Missile saturation: Fateh / Khorramshahr launchers fire in coordinated volleys while Shahed loitering munitions swarm the defences.',
    bias: { fateh: 2, khorramshahr: 1.6, shahedl: 2.2, at: 1.2, manpads: 1.3, rifle: 1.1, mbt: 0.9 },
    defense: 1.1,
    samFloor: 1,
    defenseOrder: BASE_DEF,
    wave: 1.1,
    flank: 0.25,
    harass: 0.6,
    retreat: 0.25,
    salvo: 2,
    counterBattery: false,
    choke: 1,
    airWing: 0,
    deep: ['def_aa', 'factory', 'refinery'],
    spend: { infantry: 1.1, vehicle: 1.2, air: 0.8 },
  },
};
