import type { Biome, GameMap } from '../sim/map';
import { PHOTO_MATERIALS } from './terrainset';

/*
 * Per-biome look table (render only). Every system that paints the
 * battlefield reads its palette, plant mix, water tint, outskirts style and
 * default weather from here, keyed by GameMap.biome. 'temperate' holds the
 * original Frontline Crossing art values (now blended with the scans, below).
 *
 * Ground and grass colours are derived from the photoscanned materials'
 * mean albedo (terrainset.ts, baked by tools/bake-terrain.mjs): each is the
 * scan's average pulled part of the way towards the art direction of the
 * biome. The photo ground shader multiplies every scan by look / mean, so
 * these are also the colours the ground averages to - which is what the
 * minimap, the outskirts and the low quality (procedural) ground paint with.
 */

/** sRGB mix of a scan's mean colour and an art colour: k = 0 -> the scan, 1 -> the art colour. */
function scan(key: string, art: number, k: number): number {
  const m = PHOTO_MATERIALS[key]?.hex ?? art;
  let out = 0;
  for (const sh of [16, 8, 0]) {
    const a = (m >> sh) & 255;
    const b = (art >> sh) & 255;
    out |= Math.round(a + (b - a) * k) << sh;
  }
  return out;
}

export type MapWeather = 'clear' | 'rain' | 'snow' | 'sandstorm' | 'dynamic';

export interface BiomeLook {
  biome: Biome;
  /** Shader switch (ground, outskirts, roads): 0 temperate, 1 desert, 2 winter, 3 urban. */
  code: 0 | 1 | 2 | 3;
  /** Grass palette (sRGB hex): lush / meadow / dry / fresh blades / clover. */
  grass: { lush: number; mid: number; dry: number; fresh: number; clover: number };
  /**
   * Splat layer colours (sRGB hex). forest / gravel / snow / asphalt / paving are the extra
   * photo layers (forest floor and gravel split off the dirt layer; snow, streets, squares).
   */
  ground: { dirt: number; rock: number; sand: number; mud: number; soil: number; crop: number; wheat: number; hay: number; forest?: number; gravel?: number; snow?: number; asphalt?: number; paving?: number };
  /** Saturation of a photoscan layer's detail around its mean colour (1 = as scanned; ground.ts). */
  photoSat?: Partial<Record<'grass' | 'dirt' | 'rock' | 'sand' | 'mud' | 'forest' | 'gravel' | 'soil' | 'snow' | 'asphalt' | 'paving', number>>;
  /** How far a photoscan layer's hue follows the look colour (0 = the scan's own, 1 = the look's; default 0.4). */
  photoHue?: Partial<Record<'grass' | 'dirt' | 'rock' | 'sand' | 'mud' | 'forest' | 'gravel' | 'soil' | 'snow' | 'asphalt' | 'paving', number>>;
  /** 3D grass blades density multiplier (0 = none). */
  blades: number;
  /** Clover / wildflower patches (0..1). */
  clover: number;
  flowers: number;
  /** Snow lying on everything regardless of the weather (WX.wxSnow floor). */
  snowFloor: number;
  /** River ice reach (1 = rims along the banks, 2+ = mostly frozen over). */
  iceK: number;
  /** Weather when neither the URL nor the menu picks one. */
  weather: MapWeather;
  /** Water body tints (linear): shallow scatter, deep scatter, bed. */
  water: { turq: [number, number, number]; deep: [number, number, number]; bed: [number, number, number] };
  /** Minimap colours (sRGB 0-255): water, trees. */
  mini: { water: [number, number, number]; tree: [number, number, number] };
  /** Atmosphere grade on top of the time of day: haze colour / distance, sky and ground light, sun tint, saturation. */
  atmos: { haze: [number, number, number] | null; hazeK: number; sky: number | null; gnd: number | null; sun: number | null; sunK: number; sat: number; highTint: [number, number, number] | null };
}

const TEMPERATE: BiomeLook = {
  biome: 'temperate',
  code: 0,
  // (a healthy summer green: the meadow scan itself is olive, so the look pulls its hue well towards green)
  grass: { lush: scan('meadow', 0x2a5a26, 0.9), mid: scan('meadow', 0x3e7630, 0.9), dry: 0x6e8044, fresh: 0x5a9036, clover: 0x28542d },
  ground: {
    dirt: scan('drysoil', 0x7a6448, 0.55),
    rock: scan('mossrock', 0x77716a, 0.6),
    sand: scan('beach', 0xa89a7a, 0.5),
    mud: scan('mud', 0x4a3e30, 0.3),
    soil: scan('farmsoil', 0x5e4632, 0.5),
    crop: 0x4f6a22,
    wheat: 0xb59a52,
    hay: 0x8e8a4a,
    forest: scan('litter', 0x5a4a30, 0.45),
    gravel: scan('gravel', 0x8a8070, 0.4),
  },
  // the mossy cliff scan has lilac lichen-covered stone: calm it to grey
  photoSat: { rock: 0.5, dirt: 0.8 },
  photoHue: { grass: 0.75 },
  blades: 1,
  clover: 1,
  flowers: 1,
  snowFloor: 0,
  iceK: 1,
  weather: 'clear',
  water: { turq: [0.03, 0.085, 0.06], deep: [0.007, 0.03, 0.032], bed: [0.24, 0.2, 0.13] },
  mini: { water: [38, 74, 88], tree: [34, 54, 26] },
  atmos: { haze: null, hazeK: 1, sky: null, gnd: null, sun: null, sunK: 1, sat: 1, highTint: null },
};

const LOOKS: Record<Biome, BiomeLook> = {
  temperate: TEMPERATE,
  desert: {
    biome: 'desert',
    code: 1,
    // scrub: olive-khaki to bleached straw
    grass: { lush: 0x5e6233, mid: scan('withered', 0x857a48, 0.7), dry: 0xb39b66, fresh: 0x7d8040, clover: 0x5a5c34 },
    ground: {
      dirt: scan('drysoil', 0x9a8160, 0.5),
      rock: scan('sandstone', 0x9c785c, 0.5),
      // the dune scan is pale grey: its ripples, the biome's gold
      sand: scan('dunes', 0xdcb478, 0.95),
      mud: scan('cracked', 0x8a7052, 0.45),
      soil: scan('farmsoil', 0x7a5a3a, 0.6),
      crop: 0x5c7a2c,
      wheat: 0xc4a35a,
      hay: 0x9a8c50,
      gravel: scan('gravel', 0xa08a6a, 0.5),
    },
    // the grey dune scan takes the desert's gold entirely
    photoHue: { sand: 1 },
    blades: 0.35,
    clover: 0,
    flowers: 0.15,
    snowFloor: 0,
    iceK: 1,
    weather: 'clear',
    // oasis: clear turquoise over pale sand
    water: { turq: [0.03, 0.12, 0.1], deep: [0.008, 0.045, 0.05], bed: [0.36, 0.3, 0.2] },
    mini: { water: [40, 96, 104], tree: [70, 84, 40] },
    atmos: { haze: [0.62, 0.5, 0.36], hazeK: 0.85, sky: 0xb8c4d8, gnd: 0x9a7a52, sun: 0xffe2b8, sunK: 1.1, sat: 1.04, highTint: [0.05, 0.022, -0.035] },
  },
  winter: {
    biome: 'winter',
    code: 2,
    // frozen, bleached grass where the snow is thin
    grass: { lush: 0x4d5a40, mid: scan('withered', 0x6a6e52, 0.75), dry: 0x8c8466, fresh: 0x6f7856, clover: 0x4a5642 },
    ground: {
      dirt: scan('drysoil', 0x5e5248, 0.6),
      rock: scan('snowrock', 0x6c6e72, 0.4),
      sand: 0xb8c4cc,
      mud: scan('mud', 0x3a3632, 0.5),
      soil: scan('farmsoil', 0x4a3e34, 0.6),
      crop: 0x5a6a48,
      wheat: 0x9a9070,
      hay: 0x84806a,
      forest: scan('litter', 0x4a4438, 0.7),
      gravel: scan('gravel', 0x6e6c68, 0.6),
      // the scan's de-lit snow is mid grey: lift it to fresh snow
      snow: scan('snow', 0xdae2ee, 0.9),
    },
    photoHue: { snow: 0.8 },
    blades: 0,
    clover: 0,
    flowers: 0,
    snowFloor: 1,
    iceK: 2.2,
    weather: 'snow',
    water: { turq: [0.02, 0.06, 0.075], deep: [0.004, 0.018, 0.03], bed: [0.18, 0.18, 0.17] },
    mini: { water: [70, 100, 120], tree: [40, 58, 46] },
    atmos: { haze: [0.62, 0.68, 0.78], hazeK: 0.9, sky: 0xa8c0e8, gnd: 0xa8b0bc, sun: 0xe8eeff, sunK: 0.95, sat: 0.92, highTint: [-0.01, 0.0, 0.02] },
  },
  urban: {
    biome: 'urban',
    code: 3,
    // park lawns: kept, watered, a little blue-green
    grass: { lush: scan('meadow', 0x2c5a26, 0.9), mid: scan('meadow', 0x3f6e2c, 0.85), dry: 0x6c7442, fresh: 0x5a8c38, clover: 0x2a5530 },
    ground: {
      dirt: scan('pavement', 0x8e8a84, 0.6),
      rock: scan('greyrock', 0x77746e, 0.5),
      sand: scan('rubble', 0x857a6c, 0.4),
      mud: scan('mud', 0x3c3a36, 0.5),
      soil: 0x5a4632,
      crop: 0x4f6a22,
      wheat: 0xb59a52,
      hay: 0x8e8a4a,
      gravel: scan('gravel', 0x7a7670, 0.5),
      asphalt: scan('asphalt', 0x58595c, 0.4),
      paving: scan('flags', 0xbab4aa, 0.85),
    },
    blades: 1,
    clover: 0.4,
    flowers: 0.5,
    snowFloor: 0,
    iceK: 1,
    weather: 'clear',
    // canal: murky green-grey
    water: { turq: [0.025, 0.06, 0.05], deep: [0.008, 0.025, 0.026], bed: [0.16, 0.15, 0.12] },
    mini: { water: [44, 70, 80], tree: [40, 66, 34] },
    atmos: { haze: [0.36, 0.37, 0.39], hazeK: 0.95, sky: 0xa4b4cc, gnd: 0x5c5a56, sun: 0xfff0dc, sunK: 1, sat: 0.97, highTint: [0.02, 0.01, -0.01] },
  },
};

export function biomeLook(b: Biome | GameMap | undefined): BiomeLook {
  const k = typeof b === 'object' ? b.biome : b;
  return LOOKS[k ?? 'temperate'] ?? TEMPERATE;
}

export const hexRGB = (v: number): [number, number, number] => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
