import type { Biome, GameMap } from '../sim/map';

/*
 * Per-biome look table (render only). Every system that paints the
 * battlefield reads its palette, plant mix, water tint, outskirts style and
 * default weather from here, keyed by GameMap.biome. 'temperate' holds the
 * original Frontline Crossing values, so that map renders exactly as before.
 */

export type MapWeather = 'clear' | 'rain' | 'snow' | 'sandstorm' | 'dynamic';

export interface BiomeLook {
  biome: Biome;
  /** Shader switch (ground, outskirts, roads): 0 temperate, 1 desert, 2 winter, 3 urban. */
  code: 0 | 1 | 2 | 3;
  /** Grass palette (sRGB hex): lush / meadow / dry / fresh blades / clover. */
  grass: { lush: number; mid: number; dry: number; fresh: number; clover: number };
  /** Splat layer colours (sRGB hex). */
  ground: { dirt: number; rock: number; sand: number; mud: number; soil: number; crop: number; wheat: number; hay: number };
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
  grass: { lush: 0x2a5523, mid: 0x426f2b, dry: 0x7e8047, fresh: 0x5f8e35, clover: 0x28542d },
  ground: { dirt: 0x7a6448, rock: 0x77716a, sand: 0xa89a7a, mud: 0x4a3e30, soil: 0x5e4632, crop: 0x4f6a22, wheat: 0xb59a52, hay: 0x8e8a4a },
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
    grass: { lush: 0x5e6233, mid: 0x857a48, dry: 0xb39b66, fresh: 0x7d8040, clover: 0x5a5c34 },
    ground: { dirt: 0x9a8160, rock: 0x9c785c, sand: 0xd6b47e, mud: 0x6f5a42, soil: 0x7a5a3a, crop: 0x5c7a2c, wheat: 0xc4a35a, hay: 0x9a8c50 },
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
    grass: { lush: 0x4d5a40, mid: 0x6a6e52, dry: 0x8c8466, fresh: 0x6f7856, clover: 0x4a5642 },
    ground: { dirt: 0x5e5248, rock: 0x6c6e72, sand: 0xb8c4cc, mud: 0x3a3632, soil: 0x4a3e34, crop: 0x5a6a48, wheat: 0x9a9070, hay: 0x84806a },
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
    grass: { lush: 0x2c5a26, mid: 0x3f6e2c, dry: 0x6c7442, fresh: 0x5a8c38, clover: 0x2a5530 },
    ground: { dirt: 0x8e8a84, rock: 0x77746e, sand: 0x857a6c, mud: 0x3c3a36, soil: 0x5a4632, crop: 0x4f6a22, wheat: 0xb59a52, hay: 0x8e8a4a },
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
