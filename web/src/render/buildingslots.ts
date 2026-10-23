import { townStyle } from './townstyle';
import { planBuilding, type BuildingPlan } from './buildingplan';
import { StructureKind, type GameMap, type Structure } from '../sim/map';

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

// ------------------------------------------------------------------ the night lights' view (NT1: fx/desertnight/slots.ts)

/** A lit glass: world position (y above sea level), outward normal on the ground plane, size in tiles. */
export interface NightWindow {
  x: number;
  y: number;
  z: number;
  nx: number;
  nz: number;
  w: number;
  h: number;
  /** A shop front (a wide lit window). */
  shop?: boolean;
  /** This window is lit tonight (the house is awake and a lamp is on behind it). */
  lit: boolean;
  /** A stable 0..1 number per window (> 0.9: a flickering TV). */
  flicker: number;
  /** Storey (0 = ground). */
  floor: number;
}

export interface NightDoor {
  x: number;
  y: number;
  z: number;
  nx: number;
  nz: number;
}

/** A small lamp (a porch lamp, a sign light) or a mosque light (minaret, dome, gate). */
export interface NightLamp {
  x: number;
  y: number;
  z: number;
  size: number;
  r: number;
  g: number;
  b: number;
  mode: number;
  phase: number;
  pool: number;
  kind: string;
}

export interface NightSign {
  x: number;
  y: number;
  z: number;
  nx: number;
  nz: number;
  w: number;
  h: number;
  lit: boolean;
}

export interface NightSlots {
  windows: NightWindow[];
  doors: NightDoor[];
  /** The mosque's lights (minaret, dome, gate). */
  mosque: NightLamp[];
  /** A spot inside the yard for a cooking fire, when the building has a yard (world). */
  yardFire: { x: number; y: number; z: number } | null;
  /** Wall lamps by the doors (world): lit when the house is awake. */
  porch: NightSign[];
  /** The fictional shop signs (world). */
  signs: NightSign[];
  /** The house is awake after dark. */
  awake: boolean;
}

/** The mosque's minaret (piece 'minaret' at local (1.08, 0.42), 2.08 tiles tall) and dome. */
const MINARET = { x: 1.08, z: 0.42, h: 2.08 };

/**
 * Windows, doors, lamps and signs of the building on `st`, in world space (`groundY` = the ground height under the
 * footprint, as sinaitown.ts uses it), for fx/desertnight (NT1). Pure and deterministic.
 */
export function buildingSlots(st: Structure, groundY: number): NightSlots | null {
  let pl = CACHE.get(st);
  if (!pl) CACHE.set(st, (pl = planBuilding(st, st.town ?? 2)));
  const out: NightSlots = { windows: [], doors: [], mosque: [], yardFire: null, porch: [], signs: [], awake: pl.awake };
  const th = (st.rot * Math.PI) / 2;
  const c = Math.cos(th);
  const sn = Math.sin(th);
  const cx = st.x + st.w / 2;
  const cz = st.y + st.h / 2;
  const W = (lx: number, ly: number, lz: number) => ({ x: cx + lx * c + lz * sn, y: groundY + ly, z: cz - lx * sn + lz * c });
  for (const s of pl.slots) {
    const w = slotWorld(st, s);
    const p = { x: w.x, y: groundY + s.y, z: w.z, nx: w.nx, nz: w.nz };
    if (s.kind === 'window' || s.kind === 'balcony' || s.kind === 'shop') out.windows.push({ ...p, w: s.w, h: s.h, shop: s.kind === 'shop', lit: s.lit, flicker: s.flicker, floor: s.floor });
    else if (s.kind === 'door') out.doors.push({ x: p.x, y: p.y, z: p.z, nx: p.nx, nz: p.nz });
    else if (s.kind === 'lamp') out.porch.push({ ...p, w: 0.03, h: 0.04, lit: s.lit });
    else if (s.kind === 'sign') out.signs.push({ ...p, w: s.w, h: s.h, lit: s.lit });
  }
  if (st.kind === StructureKind.Courtyard && st.look === 'mosque') {
    const mq = (lx: number, ly: number, lz: number, size: number, r: number, g: number, b: number, pool: number, kind: string): NightLamp => ({ ...W(lx, ly, lz), size, r, g, b, mode: 0, phase: 0, pool, kind });
    const hx = pl.mirror ? 0.42 : -0.42;
    const mxx = pl.mirror ? -MINARET.x : MINARET.x;
    out.mosque.push(mq(mxx, MINARET.h - 0.1, MINARET.z, 0.22, 0.3, 1.0, 0.45, 0, 'minaret'));
    out.mosque.push(mq(mxx, MINARET.h * 0.7, MINARET.z, 0.13, 1.0, 0.82, 0.5, 0, 'minaret'));
    out.mosque.push(mq(hx, pl.height + 0.45, -0.28, 0.16, 0.9, 0.95, 1.0, 0, 'dome'));
    out.mosque.push(mq(hx, 0.3, 1.0, 0.1, 1.0, 0.72, 0.38, 1.4, 'gate'));
  }
  if (pl.yardFire) out.yardFire = W(pl.yardFire[0], 0, pl.yardFire[1]);
  return out;
}
