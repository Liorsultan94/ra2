/*
 * Shared plant definitions (a leaf module: no imports, so vegetation.ts and
 * trees.ts can both use them without an import cycle).
 */

/** Foliage wind clock (seconds); Atmosphere speeds it up in strong wind. */
export const windTime = { value: 0 };

export const enum Species {
  Spruce = 0,
  Pine = 1,
  Oak = 2,
  Birch = 3,
  Young = 4,
  Poplar = 5,
  Willow = 6,
  Fruit = 7,
}

export interface TreeSpot {
  x: number;
  y: number;
  s: number;
  species: Species;
  rot: number;
}
