import { townStyle } from './townstyle';
import { planBuilding, type BuildingPlan } from './buildingplan';
import type { GameMap, Structure } from '../sim/map';

/*
 * The openings and lamps of the desert town's buildings (BD1), as plain data, for the night lights (NT1: lit
 * windows, porch lamps, signs) and anything else that wants to know where the doors and windows are, without
 * reading the meshes. Pure functions of the structure (its tile position, kind, look and town) - deterministic,
 * no Math.random, no THREE, no sim state.
 *
 *   const info = buildingInfo(map, st);          // variant, storeys, height, slots
 *   for (const s of info.slots) { const w = slotWorld(st, info, s); ... w.x, w.y, w.z, w.nx, w.nz }
 *
 * Local frame: origin at the middle of the footprint on the ground (tile units, 1 tile = the map's tile), x to the
 * right, y up, z towards the front of the building (before the structure's quarter turns `rot`, which slotWorld
 * applies). `ry` is the yaw of the opening's outward normal (sin ry, cos ry) in that frame. The building's
 * mirror is already applied to the slots.
 */

export type SlotKind =
  /** A window (glass): `lit` says a lamp is on behind it tonight. */
  | 'window'
  /** A door (the front door, a yard gate, an arch door). */
  | 'door'
  /** A shop front (a big glazed opening): the brightest at night. */
  | 'shop'
  /** A balcony door (full height, onto a balcony). */
  | 'balcony'
  /** A fictional shop sign board. */
  | 'sign'
  /** A porch / wall lamp position (small warm point). */
  | 'lamp'
  /** A roof light: a dome or a roof terrace lamp (a mosque dome glows, a terrace string light). */
  | 'roof';

export interface BuildingSlot {
  kind: SlotKind;
  /** Centre of the opening / lamp (local tiles; y above the ground). */
  x: number;
  y: number;
  z: number;
  /** Outward yaw (radians, local frame). */
  ry: number;
  /** Size of the opening (tiles). */
  w: number;
  h: number;
  /** Storey (0 = ground). */
  floor: number;
  /** A lamp is on here at night (always false when the house is asleep). */
  lit: boolean;
  /** A stable 0..1 random number per slot (e.g. > 0.9 = a flickering TV). */
  flicker: number;
}

export interface BuildingInfo {
  /** Variant id ('apt', 'shop', 'tower', 'mud', 'mosque', ...). */
  variant: string;
  /** Index of the silhouette among all variants (0..n-1). */
  silhouette: number;
  /** Storeys of the main body (the tallest part). */
  storeys: number;
  /** Visual height of the tallest wall incl. its parapet (tiles): taller storeys give strictly taller buildings. */
  height: number;
  /** Top of everything (roof clutter, minaret, domes), tiles. */
  top: number;
  /** About half of the houses are awake after dark (lit windows); the rest sleep. */
  awake: boolean;
  /** The structure is drawn mirrored left-right. */
  mirror: boolean;
  /** Palette index (0..8). */
  palette: number;
  /** Wear 0..1 (how weathered the plaster is). */
  wear: number;
  slots: BuildingSlot[];
}

/** The plan of a structure (variant, openings, lamps); cached per structure. */
export function buildingInfo(m: GameMap, st: Structure): BuildingInfo {
  return planOf(m, st);
}

const CACHE = new WeakMap<Structure, BuildingPlan>();

/** The full plan (render/buildingplan.ts) of a structure: what sinaitown.ts builds. */
export function planOf(m: GameMap, st: Structure): BuildingPlan {
  let p = CACHE.get(st);
  if (!p) CACHE.set(st, (p = planBuilding(st, townStyle(m, st))));
  return p;
}

export interface SlotWorld {
  /** World position in tiles (x, z on the map plane; y above the ground under the footprint). */
  x: number;
  y: number;
  z: number;
  /** Outward horizontal normal in the world. */
  nx: number;
  nz: number;
}

/** A slot's position and outward normal in the world (the structure's centre, its quarter turns). */
export function slotWorld(st: Structure, s: BuildingSlot): SlotWorld {
  const th = (st.rot * Math.PI) / 2;
  const c = Math.cos(th);
  const sn = Math.sin(th);
  const cx = st.x + st.w / 2;
  const cz = st.y + st.h / 2;
  return {
    x: cx + s.x * c + s.z * sn,
    y: s.y,
    z: cz - s.x * sn + s.z * c,
    nx: Math.sin(s.ry + th),
    nz: Math.cos(s.ry + th),
  };
}
