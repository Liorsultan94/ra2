import { StructureKind, type GameMap, type Structure } from '../../../sim/map';
import { hash2 } from '../../../sim/rng';

/*
 * Window, door and roof-lamp slots of the desert town's buildings, in world space, for the night lights.
 *
 * The shared file is render/buildingslots.ts (BD1 owns it: each building variant's windows, doors, shop fronts,
 * porch and roof lamps and a 'lit tonight' flag per slot, as plain data). Until it is on this branch, this module
 * derives the slots itself from the footprint and the model's height, repeating the numbers of the old
 * sinaitown.ts buildHouse (the same hashes: which type a house is, how many windows a bay gets); as soon as
 * render/buildingslots.ts exists its `buildingInfo` / `slotWorld` are used instead (import.meta.glob keeps this
 * file building while it does not exist), awake flag and lit windows included.
 */

export interface SlotWindow {
  /** The slots file says a lamp is on behind it tonight (absent: this module decides). */
  lit?: boolean;
  /** A TV's flicker (absent: this module decides). */
  tv?: boolean;
  x: number;
  y: number;
  z: number;
  /** Outward normal (unit, ground plane). */
  nx: number;
  nz: number;
  w: number;
  h: number;
  /** A shop front (a wide lit window). */
  shop?: boolean;
}

export interface SlotDoor {
  x: number;
  y: number;
  z: number;
  nx: number;
  nz: number;
}

export interface SlotLamp {
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

export interface BuildingSlots {
  /** The building's lights are on tonight (absent: this module decides). */
  awake?: boolean;
  windows: SlotWindow[];
  /** Extra small lamps of the shared slots (porch / wall lamps, roof lights, sign boards). */
  lamps?: (SlotLamp & { lit: boolean })[];
  doors: SlotDoor[];
  /** The mosque's lights (minaret, dome, gate). */
  mosque: SlotLamp[];
  /** A spot inside the yard for a cooking fire, when the building has a yard. */
  yardFire: { x: number; y: number; z: number } | null;
}

/** The part of render/buildingslots.ts used here (structural: the file may not be on this branch yet). */
interface SharedSlot {
  kind: 'window' | 'door' | 'shop' | 'balcony' | 'sign' | 'lamp' | 'roof';
  x: number;
  y: number;
  z: number;
  ry: number;
  w: number;
  h: number;
  floor: number;
  lit: boolean;
  flicker: number;
}
interface SharedInfo {
  awake: boolean;
  slots: SharedSlot[];
}
interface SharedModule {
  buildingInfo?: (m: GameMap, st: Structure) => SharedInfo;
  slotWorld?: (st: Structure, s: SharedSlot) => { x: number; y: number; z: number; nx: number; nz: number };
}
const shared = import.meta.glob('../../buildingslots.ts', { eager: true }) as Record<string, SharedModule>;
const sharedMod = Object.values(shared)[0];

/** True when the shared slots file is in use (tests / debug). */
export const usesSharedSlots = !!(sharedMod?.buildingInfo && sharedMod.slotWorld);

export function buildingSlotsFor(m: GameMap, st: Structure, gy: number): BuildingSlots {
  if (sharedMod?.buildingInfo && sharedMod.slotWorld) return fromShared(sharedMod.buildingInfo(m, st), sharedMod.slotWorld, st, gy);
  return placeholderSlots(st, gy);
}

/** The shared file's plan as this module's slots (positions above the ground gy). */
function fromShared(info: SharedInfo, slotWorld: NonNullable<SharedModule['slotWorld']>, st: Structure, gy: number): BuildingSlots {
  const out: BuildingSlots = { awake: info.awake, windows: [], doors: [], mosque: [], lamps: [], yardFire: null };
  const mosque = st.look === 'mosque';
  for (const s of info.slots) {
    const w = slotWorld(st, s);
    const y = gy + w.y;
    if (s.kind === 'window' || s.kind === 'balcony' || s.kind === 'shop') {
      // a mosque's lattice windows glow all night; a window faces its normal, a hair out of the wall
      out.windows.push({ x: w.x + w.nx * 0.006, y, z: w.z + w.nz * 0.006, nx: w.nx, nz: w.nz, w: Math.max(0.05, s.w * 0.92), h: Math.max(0.06, s.h * 0.92), shop: s.kind === 'shop', lit: mosque ? true : s.lit, tv: s.kind === 'window' && s.flicker > 0.9 && !mosque });
    } else if (s.kind === 'door') {
      out.doors.push({ x: w.x, y, z: w.z, nx: w.nx, nz: w.nz });
    } else if (s.kind === 'lamp') {
      out.lamps!.push({ x: w.x + w.nx * 0.03, y, z: w.z + w.nz * 0.03, size: 0.1, r: 1.0, g: 0.66, b: 0.32, mode: 0, phase: s.flicker, pool: 0.45, kind: 'porch', lit: s.lit });
    } else if (s.kind === 'roof') {
      // a roof light: a lit dome / a terrace lamp (the mosque's dome glows pale, the others warm)
      out.lamps!.push(
        mosque
          ? { x: w.x, y, z: w.z, size: 0.16, r: 0.9, g: 0.95, b: 1.0, mode: 0, phase: 0, pool: 0, kind: 'dome', lit: true }
          : { x: w.x, y, z: w.z, size: 0.07, r: 1.0, g: 0.74, b: 0.4, mode: 4, phase: s.flicker, pool: 0, kind: 'string', lit: s.lit },
      );
    } else if (s.kind === 'sign') {
      // a fictional shop sign board: a small warm glow in front of it
      out.lamps!.push({ x: w.x + w.nx * 0.05, y, z: w.z + w.nz * 0.05, size: 0.12, r: 1.0, g: 0.62 + 0.3 * s.flicker, b: 0.35 + 0.5 * s.flicker, mode: 4, phase: s.flicker, pool: 0, kind: 'sign', lit: s.lit });
    }
  }
  if (mosque) {
    // the minaret (1.08, 0, 0.42 in the mosque's frame: 2.08 tiles tall): a green crown light and a warm balcony ring, a gate lamp
    const cx = st.x + st.w / 2;
    const cz = st.y + st.h / 2;
    const th = (st.rot * Math.PI) / 2;
    const P = (lx: number, ly: number, lz: number) => ({ x: cx + lx * Math.cos(th) + lz * Math.sin(th), y: gy + ly, z: cz - lx * Math.sin(th) + lz * Math.cos(th) });
    const mq = (lx: number, ly: number, lz: number, size: number, r: number, g: number, b: number, pool: number, kind: string): SlotLamp => ({ ...P(lx, ly, lz), size, r, g, b, mode: 0, phase: 0, pool, kind });
    out.mosque.push(mq(1.08, 1.98, 0.42, 0.22, 0.3, 1.0, 0.45, 0, 'minaret'), mq(1.08, 1.45, 0.42, 0.13, 1.0, 0.82, 0.5, 0, 'minaret'), mq(-0.42, 0.3, 1.0, 0.1, 1.0, 0.72, 0.38, 1.4, 'gate'));
  }
  return out;
}

// ------------------------------------------------------------------ the placeholder

/** One flat-roofed block of buildHouse's flatHouse(): size, height, offset, door. */
interface Block {
  lx: number;
  dz: number;
  hw: number;
  ox: number;
  oz: number;
  oy?: number;
  door?: boolean;
  /** Front-face floors covered by an arcade / shutters / a shop front (no plain window there). */
  cover?: number[];
}

/** The main blocks of the 10 house types (sinaitown.ts), index = the type buildHouse picks. */
const TYPES: Block[][] = [
  [{ lx: 1.3, dz: 1.05, hw: 0.62, ox: 0, oz: 0, cover: [0, 1] }],
  [{ lx: 1.0, dz: 1.0, hw: 0.42, ox: -0.15, oz: 0, door: true }, { lx: 0.48, dz: 0.62, hw: 0.3, ox: 0.55, oz: 0.2 }],
  [{ lx: 0.72, dz: 1.15, hw: 0.9, ox: -0.32, oz: 0, door: true }, { lx: 0.68, dz: 0.72, hw: 0.36, ox: 0.38, oz: 0.22 }],
  [{ lx: 1.42, dz: 1.15, hw: 0.36, ox: 0, oz: 0, door: true }, { lx: 0.82, dz: 0.62, hw: 0.3, ox: -0.25, oz: -0.25, oy: 0.36 }],
  [{ lx: 1.36, dz: 1.0, hw: 0.86, ox: 0, oz: 0, door: true, cover: [1] }],
  [{ lx: 1.3, dz: 1.08, hw: 0.7, ox: 0, oz: 0, cover: [0, 1] }],
  [{ lx: 1.3, dz: 0.95, hw: 0.66, ox: 0, oz: -0.12, cover: [0, 1] }],
  [{ lx: 0.95, dz: 1.0, hw: 0.95, ox: -0.25, oz: -0.05, door: true }, { lx: 0.55, dz: 0.75, hw: 0.32, ox: 0.55, oz: 0.12 }],
  [{ lx: 1.35, dz: 1.05, hw: 0.64, ox: 0, oz: -0.05, cover: [0, 1] }],
  [{ lx: 1.2, dz: 1.0, hw: 0.58, ox: -0.1, oz: -0.05, door: true }],
];
const HOUSES = [0, 1, 2, 3, 4, 7, 8, 9];

/** Window size (tiles): the lit glass inside the kit's 0.17 x 0.24 window card. */
const WW = 0.085;
const WH = 0.13;

export function placeholderSlots(st: Structure, gy: number): BuildingSlots {
  const out: BuildingSlots = { windows: [], doors: [], mosque: [], yardFire: null };
  const cx = st.x + st.w / 2;
  const cz = st.y + st.h / 2;
  const th = (st.rot * Math.PI) / 2;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const h = (k: number) => hash2(st.x * 7 + k, st.y * 13, 911);
  /** Local (x, y, z) to world. */
  const W = (lx: number, ly: number, lz: number) => ({ x: cx + lx * c + lz * s, y: gy + ly, z: cz - lx * s + lz * c });
  const N = (lx: number, lz: number) => ({ nx: lx * c + lz * s, nz: -lx * s + lz * c });
  const win = (lx: number, ly: number, lz: number, nlx: number, nlz: number, w = WW, hh = WH, shop = false) => {
    const p = W(lx, ly, lz);
    const n = N(nlx, nlz);
    out.windows.push({ ...p, ...n, w, h: hh, shop });
  };

  if (st.kind === StructureKind.Courtyard && st.look === 'mosque') {
    // the prayer hall's tall lattice windows (sides and back) and the lamps: minaret, dome, gate
    const hx = -0.42;
    const hz = -0.28;
    const LX = 1.85;
    const DZ = 1.3;
    for (const sx of [-1, 1]) for (const z of [-0.6, -0.15]) win(hx + sx * (LX / 2 + 0.006), 0.28, z, sx, 0, 0.09, 0.26);
    for (const x of [-0.6, -0.2, 0.2, 0.6]) win(hx + x, 0.28, hz - DZ / 2 - 0.006, 0, -1, 0.09, 0.26);
    const mq = (lx: number, ly: number, lz: number, size: number, r: number, g: number, b: number, pool: number, kind: string): SlotLamp => ({ ...W(lx, ly, lz), size, r, g, b, mode: 0, phase: 0, pool, kind });
    // the minaret (2.08 tiles tall at (1.08, 0.42)): a green crown light, the balcony ring, a warm window light
    out.mosque.push(mq(1.08, 1.98, 0.42, 0.22, 0.3, 1.0, 0.45, 0, 'minaret'));
    out.mosque.push(mq(1.08, 1.45, 0.42, 0.13, 1.0, 0.82, 0.5, 0, 'minaret'));
    out.mosque.push(mq(hx, 0.98, hz, 0.16, 0.9, 0.95, 1.0, 0, 'dome'));
    out.mosque.push(mq(hx, 0.3, 1.0, 0.1, 1.0, 0.72, 0.38, 1.4, 'gate'));
    out.doors.push({ ...W(hx, 0.16, 0.92), ...N(0, 1) });
    return out;
  }
  if (st.kind === StructureKind.Courtyard) {
    // (not on the Sinai map: the courtyard house / villa / shop rows of other layouts) one generic wing
    block({ lx: 2.2, dz: 0.66, hw: 0.6, ox: 0, oz: -0.4 });
    return out;
  }

  function block(b: Block) {
    const lift = b.oy ?? 0;
    const nx = Math.max(1, Math.floor(b.lx / 0.38));
    const floors = b.hw > 0.55 ? 2 : 1;
    for (let f = 0; f < floors; f++) {
      const wy = lift + (floors === 1 ? b.hw * 0.6 : b.hw * (0.3 + f * 0.42));
      for (let i = 0; i < nx; i++) {
        const x = b.ox - b.lx / 2 + (b.lx / nx) * (i + 0.5);
        for (const sz of [-1, 1]) {
          if (b.door && sz > 0 && f === 0 && i === Math.floor(nx / 2)) continue;
          if (sz > 0 && b.cover?.includes(f)) continue;
          win(x, wy, b.oz + sz * (b.dz / 2 + 0.006), 0, sz);
        }
      }
    }
    // the side walls: a window per bay and floor, some left out or vents
    for (const sx of [-1, 1]) {
      const nz = Math.max(1, Math.floor(b.dz / 0.42));
      for (let f = 0; f < floors; f++) {
        const wy = lift + (floors === 1 ? b.hw * 0.6 : b.hw * (0.3 + f * 0.42));
        for (let i = 0; i < nz; i++) {
          const r = h(260 + i * 3 + f * 7 + (sx > 0 ? 40 : 0));
          if (r < 0.45) continue;
          win(b.ox + sx * (b.lx / 2 + 0.006), wy, b.oz - b.dz / 2 + (b.dz / nz) * (i + 0.5), sx, 0);
        }
      }
    }
    if (b.door) out.doors.push({ ...W(b.ox, lift + 0.16, b.oz + b.dz / 2 + 0.01), ...N(0, 1) });
  }

  // which type this house is (buildHouse: shop-houses face the streets, the rest pick from HOUSES)
  const type = st.look === 'shop' ? (h(58) < 0.55 ? 5 : 6) : HOUSES[Math.floor(h(58) * HOUSES.length)];
  for (const b of TYPES[type]) block(b);
  // the shop fronts of types 5 and 6: two wide glazed windows under the awning
  if (type === 5) for (const sg of [-1, 1]) win(sg * 0.25, 0.14, 0.552, 0, 1, 0.3, 0.17, true);
  if (type === 6) for (const sg of [-1, 1]) win(sg * 0.275, 0.14, 0.362, 0, 1, 0.3, 0.17, true);
  // a yard (60% of the town houses, buildHouse): a cooking fire by the wall, opposite the yard tree
  if (st.look !== 'shop' && h(90) < 0.6) {
    const treeSide = h(92) < 0.5 ? (h(93) < 0.5 ? -1 : 1) : 0;
    const side = treeSide === 0 ? (h(94) < 0.5 ? -1 : 1) : -treeSide;
    out.yardFire = { ...W(side * 0.68, 0.0, 0.74) };
  }
  return out;
}
