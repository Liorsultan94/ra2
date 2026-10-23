import { StructureKind, type Structure } from '../sim/map';
import { hash2 } from '../sim/rng';
import type { BuildingInfo, BuildingSlot, SlotKind } from './buildingslots';

/*
 * The desert town's building plans (BD1): which house stands on a structure's footprint, as plain data.
 *
 * A plan is a list of build operations (plaster boxes, kit cards and pieces, swatch boxes, solids) in the
 * structure's local frame plus the openings (slots) the night lights use. Everything is a pure function of the
 * structure's tile position, kind, look and town: variant, mirror, palette, wear, height, which extras it has.
 * (Hash of the tile position, like the old houses: no Math.random, nothing from the sim state.) sinaitown.ts
 * turns a plan into meshes; buildingslots.ts hands the openings to the night lights.
 *
 * Scale: one storey is FLOOR = 0.44 tile (about 3 m: the infantry man is 0.34 tile, a door 0.32), so a 1-, 2-
 * and 3-storey house are 0.5, 0.95 and 1.4 tiles tall with a belt course at every floor line, a window row per
 * floor and a balcony / a different roof on the upper floors.
 *
 * 16 silhouettes on a 2 x 2 footprint (flat cube, shop-house, apartment block, tower house, stepped terrace,
 * arcaded loggia, L-house, domed shrine, mud-brick house, cafe, hipped-roof villa, terrace of two, outer-stair
 * house, unfinished concrete frame, guest house with a thatch terrace, bakery), the 3 x 2 courtyard houses and the
 * mosque; 9 palettes; mirror, wear, window family, roof clutter and trims from the seed.
 */

export const FLOOR = 0.44;
const PAR = 0.07;

/** Colour keys of plaster solids (resolved per building: plan.col). */
export type ColKey = 'wall' | 'wall2' | 'trim' | 'dado' | 'conc' | 'brick' | 'tile' | 'earth' | 'sand' | 'white' | 'ochre' | 'dark';
/** Accent paint of kit cards / pieces: a key into plan.acc or a linear RGB colour. */
export type AccKey = 'acc' | 'acc2' | 'door' | 'awn' | 'tankc' | 'cloth';
export type Acc = AccKey | [number, number, number];
/** Wall material of a plaster solid: 0 plaster, 1 brick, 2 raw concrete, 3 sand. */
export type Mat = 0 | 1 | 2 | 3;
export type LodSel = 'both' | 0 | 1;

export type Op =
  | { t: 'box'; x: number; y: number; z: number; w: number; h: number; d: number; c: ColKey; m?: number; ry?: number; bottom?: boolean; mat?: Mat }
  | { t: 'card'; n: string; x: number; y: number; z: number; ry: number; sx: number; sy: number; tint: ColKey; a: Acc }
  | { t: 'piece'; n: string; x: number; y: number; z: number; ry?: number; rx?: number; rz?: number; s?: [number, number, number]; tint?: ColKey; a?: Acc; col?: [number, number, number]; lod?: LodSel }
  | { t: 'sw'; s: string; x: number; y: number; z: number; w: number; h: number; d: number; ry?: number; rx?: number; rz?: number; a?: Acc; col?: [number, number, number]; lod?: LodSel }
  | { t: 'geo'; g: 'cyl' | 'pyramid' | 'vault' | 'prism' | 'wedge' | 'cone'; x: number; y: number; z: number; w: number; h: number; d: number; ry?: number; seg?: number; c: ColKey; m?: number; mat?: Mat; sw?: string }
  | { t: 'tree'; x: number; z: number; r: number; hgt: number }
  | { t: 'sign'; i: number; x: number; y: number; z: number; ry: number; w: number; h: number };

export interface BuildingPlan extends BuildingInfo {
  ops: Op[];
  /** Resolved colours (sRGB hex) by key, accent paints (linear rgb) by key. */
  col: Record<ColKey, number>;
  acc: Record<AccKey, [number, number, number]>;
  /** Feature tags (for tests and the report): 'balcony', 'tank', 'dish', 'laundry', 'viga', 'dome', ... */
  features: string[];
  kind: StructureKind;
}

// ------------------------------------------------------------------ palettes

interface Palette {
  name: string;
  walls: number[];
  trims: number[];
  dado: number;
  /** Shutter / door / awning paints (linear RGB). */
  acc: [number, number, number][];
  /** Unpainted: the upper storeys of a few houses stay raw (concrete / brick). */
  mud?: boolean;
}

export const PALETTES: Palette[] = [
  { name: 'whitewash', walls: [0xf3efe6, 0xf7f3ea, 0xeeeae0], trims: [0xdfe6ee, 0xf7f7f4], dado: 0x6f9fc8, acc: [[0.18, 0.4, 0.66], [0.14, 0.3, 0.52], [0.16, 0.56, 0.56]] },
  { name: 'sandstone', walls: [0xe9d4ac, 0xe4d2ae, 0xdcc8a0, 0xe6c28e], trims: [0xf0e4c8, 0xf6ecd6], dado: 0x9a6a46, acc: [[0.7, 0.36, 0.22], [0.85, 0.66, 0.28], [0.42, 0.3, 0.2]] },
  { name: 'salmon', walls: [0xe9b9a0, 0xe5a98f, 0xedc2a8], trims: [0xf7ece0, 0xfbf4ea], dado: 0x8a5a4a, acc: [[0.24, 0.46, 0.3], [0.16, 0.56, 0.56], [0.9, 0.9, 0.88]] },
  { name: 'adobe', walls: [0xcaa57c, 0xc29a70, 0xd1ae85], trims: [0xd8bc98, 0xdcc4a0], dado: 0xb38e66, acc: [[0.42, 0.3, 0.2], [0.3, 0.2, 0.12], [0.16, 0.56, 0.56]], mud: true },
  { name: 'turquoise', walls: [0xf2e0c8, 0xeee2c8, 0xf0e8da], trims: [0xffffff, 0xf4f1ea], dado: 0x3aa59a, acc: [[0.16, 0.56, 0.56], [0.14, 0.3, 0.52], [0.7, 0.36, 0.22]] },
  { name: 'straw', walls: [0xf0d98a, 0xe8cf7c, 0xf3e0a0], trims: [0xfaf2d8, 0xfff8e4], dado: 0x8a6a3a, acc: [[0.42, 0.3, 0.2], [0.55, 0.25, 0.15], [0.24, 0.46, 0.3]] },
  { name: 'concrete', walls: [0xb9b6ae, 0xc4c1b8, 0xaeaba3], trims: [0xd0cdc4, 0xdad7ce], dado: 0x86837b, acc: [[0.18, 0.4, 0.66], [0.7, 0.36, 0.22], [0.24, 0.46, 0.3]] },
  { name: 'rust', walls: [0xdc9a62, 0xd9895a, 0xe3a574], trims: [0xf3e6d2, 0xfaf0e0], dado: 0x7a4a34, acc: [[0.16, 0.56, 0.56], [0.85, 0.66, 0.28], [0.18, 0.4, 0.66]] },
  { name: 'mint', walls: [0xcfe3d4, 0xdbe8d6, 0xe3eee4], trims: [0xffffff, 0xf2f6f0], dado: 0x4f8f6f, acc: [[0.24, 0.46, 0.3], [0.9, 0.9, 0.88], [0.18, 0.4, 0.66]] },
];

/** Palette weights per town style (0 Egyptian canal town, 1 Arabian town, 2 Sharm / every other). */
const PAL_W: number[][] = [
  [0.3, 0, 0.1, 0, 0.2, 0.08, 0.14, 0, 0.18],
  [0, 0.3, 0.05, 0.25, 0, 0.14, 0.08, 0.18, 0],
  [0.16, 0.14, 0.1, 0.1, 0.12, 0.1, 0.1, 0.1, 0.08],
];

function pick(r: number, w: number[]): number {
  let s = 0;
  for (const x of w) s += x;
  let a = r * s;
  for (let i = 0; i < w.length; i++) {
    a -= w[i];
    if (a < 0) return i;
  }
  return w.length - 1;
}

// ------------------------------------------------------------------ the kit's cards (sizes from sinai_kit.py)

interface CardInfo {
  w: number;
  h: number;
  /** The opening (glass) size and its centre above the card's centre. */
  ow: number;
  oh: number;
  cy: number;
  kind: SlotKind | null;
}

export const CARDS: Record<string, CardInfo> = {
  win: { w: 0.17, h: 0.24, ow: 0.11, oh: 0.15, cy: 0, kind: 'window' },
  win_shut: { w: 0.25, h: 0.24, ow: 0.11, oh: 0.15, cy: 0, kind: 'window' },
  win_closed: { w: 0.17, h: 0.24, ow: 0.11, oh: 0.15, cy: 0, kind: 'window' },
  win_grille: { w: 0.17, h: 0.24, ow: 0.11, oh: 0.15, cy: 0, kind: 'window' },
  win_arch: { w: 0.17, h: 0.28, ow: 0.11, oh: 0.19, cy: 0, kind: 'window' },
  win_tall: { w: 0.15, h: 0.36, ow: 0.1, oh: 0.27, cy: -0.005, kind: 'window' },
  win_hotel: { w: 0.2, h: 0.2, ow: 0.15, oh: 0.15, cy: 0, kind: 'window' },
  win_small: { w: 0.12, h: 0.16, ow: 0.075, oh: 0.1, cy: 0, kind: 'window' },
  win_wide: { w: 0.3, h: 0.2, ow: 0.23, oh: 0.12, cy: 0, kind: 'window' },
  win_round: { w: 0.14, h: 0.14, ow: 0.09, oh: 0.09, cy: 0, kind: 'window' },
  win_bifora: { w: 0.27, h: 0.3, ow: 0.21, oh: 0.2, cy: -0.005, kind: 'window' },
  door_balc: { w: 0.3, h: 0.38, ow: 0.13, oh: 0.31, cy: -0.025, kind: 'balcony' },
  door_hotel: { w: 0.24, h: 0.26, ow: 0.2, oh: 0.22, cy: -0.015, kind: 'balcony' },
  door: { w: 0.2, h: 0.32, ow: 0.14, oh: 0.27, cy: -0.013, kind: 'door' },
  door_plank: { w: 0.2, h: 0.32, ow: 0.14, oh: 0.27, cy: -0.013, kind: 'door' },
  door_arch: { w: 0.28, h: 0.4, ow: 0.2, oh: 0.34, cy: -0.018, kind: 'door' },
  gate: { w: 0.32, h: 0.26, ow: 0.27, oh: 0.235, cy: 0, kind: 'door' },
  shop: { w: 0.5, h: 0.3, ow: 0.44, oh: 0.23, cy: -0.027, kind: 'shop' },
  arch: { w: 0.3, h: 0.3, ow: 0.22, oh: 0.26, cy: -0.02, kind: null },
  vent: { w: 0.08, h: 0.08, ow: 0.05, oh: 0.05, cy: 0, kind: null },
};

/** The sign boards the kit paints at load (sinaikit.ts SIGNS, same order): fictional names, no brands. */
export const SIGN_COUNT = 8;

// ------------------------------------------------------------------ the builder

type Side = 'f' | 'b' | 'l' | 'r';

interface Vol {
  x: number;
  z: number;
  lx: number;
  dz: number;
  floors: number;
  y0: number;
  fh: number;
  top: number;
  c: ColKey;
}

interface CardRec {
  n: string;
  x: number;
  y: number;
  z: number;
  ry: number;
  sx: number;
  sy: number;
  p: number;
  tint: ColKey;
  a: Acc;
  fl: number;
}

function frame(v: Vol, s: Side) {
  switch (s) {
    case 'f':
      return { ry: 0, len: v.lx, at: (u: number, o = 0): [number, number] => [v.x + u, v.z + v.dz / 2 + o] };
    case 'b':
      return { ry: Math.PI, len: v.lx, at: (u: number, o = 0): [number, number] => [v.x + u, v.z - v.dz / 2 - o] };
    case 'r':
      return { ry: Math.PI / 2, len: v.dz, at: (u: number, o = 0): [number, number] => [v.x + v.lx / 2 + o, v.z + u] };
    default:
      return { ry: -Math.PI / 2, len: v.dz, at: (u: number, o = 0): [number, number] => [v.x - v.lx / 2 - o, v.z + u] };
  }
}


class P {
  ops: Op[] = [];
  cards: CardRec[] = [];
  features = new Set<string>();
  /** Highest wall top (parapet included) and highest anything. */
  wallTop = 0;
  top = 0;
  storeys = 1;
  readonly h: (k: number) => number;
  readonly mirror: boolean;
  readonly pal: Palette;
  readonly palIdx: number;
  readonly wear: number;
  readonly awake: boolean;
  readonly col: Record<ColKey, number>;
  readonly acc: Record<AccKey, [number, number, number]>;
  /** Which window family this house uses. */
  readonly fam: string[];
  readonly accIdx: number;
  /** Storey height factor of this house (a few percent either way). */
  readonly fhk: number;

  constructor(
    readonly st: Structure,
    readonly town: 0 | 1 | 2,
  ) {
    this.h = (k: number) => hash2(st.x * 7 + k, st.y * 13 + k * 3, 4711);
    this.mirror = this.h(300) < 0.5;
    this.palIdx = pick(this.h(301), PAL_W[town]);
    this.pal = PALETTES[this.palIdx];
    this.wear = 0.12 + 0.88 * Math.pow(this.h(302), 1.3);
    this.awake = this.h(303) < 0.55;
    this.fhk = 0.97 + 0.07 * this.h(307);
    const pal = this.pal;
    const wall = pal.walls[Math.floor(this.h(304) * pal.walls.length)];
    let wall2 = pal.walls[Math.floor(this.h(305) * pal.walls.length)];
    if (wall2 === wall) wall2 = pal.walls[(pal.walls.indexOf(wall) + 1) % pal.walls.length];
    this.col = {
      wall,
      wall2,
      trim: pal.trims[Math.floor(this.h(306) * pal.trims.length)],
      dado: pal.dado,
      conc: 0xa9a69e,
      brick: 0xb0603e,
      tile: 0xb9603a,
      earth: 0xb59468,
      sand: 0xd2ba8c,
      white: 0xf4f1ea,
      ochre: 0xdcb88a,
      dark: 0x4a463e,
    };
    const A = pal.acc;
    this.accIdx = Math.floor(this.h(51) * A.length);
    const aw: [number, number, number][] = [[0.7, 0.22, 0.16], [0.2, 0.36, 0.58], [0.75, 0.62, 0.3], [0.24, 0.46, 0.3], [0.8, 0.8, 0.78]];
    this.acc = {
      acc: A[this.accIdx],
      acc2: A[Math.floor(this.h(52) * A.length)],
      door: [[0.24, 0.36, 0.5], [0.42, 0.28, 0.16], [0.2, 0.42, 0.36], A[this.accIdx]][Math.floor(this.h(7) * 4)] as [number, number, number],
      awn: aw[Math.floor(this.h(8) * aw.length)],
      tankc: this.h(11) < 0.5 ? [0.86, 0.86, 0.83] : [0.1, 0.1, 0.11],
      cloth: [[0.9, 0.9, 0.88], [0.75, 0.2, 0.18], [0.2, 0.35, 0.65], [0.85, 0.7, 0.25], [0.3, 0.55, 0.35]][Math.floor(this.h(12) * 5)] as [number, number, number],
    };
    this.fam = [['win', 'win_shut', 'win_closed', 'win_grille', 'win_arch', 'win_shut', 'win_small', 'win_wide'][Math.floor(this.h(201) * 6)], ['win', 'win_grille', 'win_closed', 'win_arch'][Math.floor(this.h(202) * 4)]];
  }

  // ---------------------------------------------------------------- primitives

  note(f: string) {
    this.features.add(f);
  }

  box(x: number, y: number, z: number, w: number, h: number, d: number, c: ColKey = 'wall', o: { m?: number; ry?: number; bottom?: boolean; mat?: Mat } = {}) {
    this.ops.push({ t: 'box', x, y, z, w, h, d, c, ...o });
    this.top = Math.max(this.top, y + h / 2);
  }

  piece(n: string, x: number, y: number, z: number, o: Omit<Extract<Op, { t: 'piece' }>, 't' | 'n' | 'x' | 'y' | 'z'> = {}) {
    this.ops.push({ t: 'piece', n, x, y, z, ...o });
  }

  sw(s: string, x: number, y: number, z: number, w: number, h: number, d: number, o: Omit<Extract<Op, { t: 'sw' }>, 't' | 's' | 'x' | 'y' | 'z' | 'w' | 'h' | 'd'> = {}) {
    this.ops.push({ t: 'sw', s, x, y, z, w, h, d, ...o });
  }

  geo(g: Extract<Op, { t: 'geo' }>['g'], x: number, y: number, z: number, w: number, h: number, d: number, c: ColKey, o: { ry?: number; seg?: number; m?: number; mat?: Mat; sw?: string } = {}) {
    this.ops.push({ t: 'geo', g, x, y, z, w, h, d, c, ...o });
    this.top = Math.max(this.top, y + h / 2);
  }

  card(n: string, x: number, y: number, z: number, ry: number, o: { sx?: number; sy?: number; p?: number; tint?: ColKey; a?: Acc; fl?: number } = {}) {
    this.cards.push({ n, x, y, z, ry, sx: o.sx ?? 1, sy: o.sy ?? 1, p: o.p ?? 1, tint: o.tint ?? 'wall', a: o.a ?? 'acc', fl: o.fl ?? 0 });
  }

  tree(x: number, z: number, r: number, hgt: number) {
    this.ops.push({ t: 'tree', x, z, r, hgt });
  }

  // ---------------------------------------------------------------- walls

  /**
   * A storeyed block: plaster body, a belt course at every floor line, a plinth band, the parapet.
   * `y0` lifts it onto a lower volume (set-back upper floors).
   */
  body(o: { x: number; z: number; lx: number; dz: number; floors: number; y0?: number; c?: ColKey; fh?: number; parapet?: 'plain' | 'merlon' | 'low' | 'none' | 'step'; belt?: boolean; plinth?: boolean; mat?: Mat }): Vol {
    const fh = (o.fh ?? FLOOR) * this.fhk;
    const y0 = o.y0 ?? 0;
    const c = o.c ?? 'wall';
    const hgt = o.floors * fh;
    const v: Vol = { x: o.x, z: o.z, lx: o.lx, dz: o.dz, floors: o.floors, y0, fh, top: y0 + hgt, c };
    this.box(o.x, y0 + hgt / 2, o.z, o.lx, hgt, o.dz, c, { mat: o.mat ?? 0 });
    if (o.belt !== false)
      for (let f = 1; f < o.floors; f++) this.box(o.x, y0 + f * fh, o.z, o.lx + 0.024, 0.02, o.dz + 0.024, 'trim', { mat: 0 });
    if (o.plinth !== false && y0 === 0) this.box(o.x, 0.03, o.z, o.lx + 0.016, 0.06, o.dz + 0.016, 'dado', { mat: 0 });
    this.parapet(v, o.parapet ?? 'plain');
    this.storeys = Math.max(this.storeys, o.floors);
    return v;
  }

  parapet(v: Vol, style: 'plain' | 'merlon' | 'low' | 'none' | 'step') {
    const T = v.top;
    if (style === 'none') {
      this.wallTop = Math.max(this.wallTop, T);
      return;
    }
    const ph = style === 'low' ? 0.045 : PAR;
    const pt = style === 'low' ? 0.07 : 0.05;
    const c = v.c;
    this.box(v.x, T + ph / 2, v.z + v.dz / 2 - pt / 2, v.lx, ph, pt, c);
    this.box(v.x, T + ph / 2, v.z - v.dz / 2 + pt / 2, v.lx, ph, pt, c);
    this.box(v.x + v.lx / 2 - pt / 2, T + ph / 2, v.z, pt, ph, v.dz - 2 * pt, c);
    this.box(v.x - v.lx / 2 + pt / 2, T + ph / 2, v.z, pt, ph, v.dz - 2 * pt, c);
    // the coping: a slightly wider cap, a shade lighter
    const cp = 0.012;
    this.box(v.x, T + ph + cp / 2, v.z + v.dz / 2 - pt / 2, v.lx + cp, cp, pt + cp, 'trim');
    this.box(v.x, T + ph + cp / 2, v.z - v.dz / 2 + pt / 2, v.lx + cp, cp, pt + cp, 'trim');
    this.box(v.x + v.lx / 2 - pt / 2, T + ph + cp / 2, v.z, pt + cp, cp, v.dz - 2 * pt - cp, 'trim');
    this.box(v.x - v.lx / 2 + pt / 2, T + ph + cp / 2, v.z, pt + cp, cp, v.dz - 2 * pt - cp, 'trim');
    // the roof slab
    this.box(v.x, T + 0.006, v.z, v.lx - 0.1, 0.012, v.dz - 0.1, 'earth', { m: 0.72 });
    if (style === 'merlon') {
      const n = Math.max(2, Math.round(v.lx / 0.1));
      for (const s of [-1, 1]) {
        for (let i = 0; i < n; i++) this.piece('merlon', v.x - v.lx / 2 + (v.lx * (i + 0.5)) / n, T + ph + cp, v.z + (s * (v.dz / 2 - pt / 2)), { tint: v.c, lod: 0 });
        const k = Math.max(2, Math.round(v.dz / 0.1));
        for (let i = 1; i < k - 1; i++) this.piece('merlon', v.x + s * (v.lx / 2 - pt / 2), T + ph + cp, v.z - v.dz / 2 + (v.dz * (i + 0.5)) / k, { tint: v.c, ry: Math.PI / 2, lod: 0 });
      }
      this.note('merlons');
    }
    this.wallTop = Math.max(this.wallTop, T + ph + cp);
  }

  // ---------------------------------------------------------------- openings

  /** Window / door height centre of floor `fl` for a card of height `ch`. */
  wy(v: Vol, fl: number, ch = 0.24) {
    return v.y0 + fl * v.fh + Math.max(ch / 2 + 0.04, v.fh * 0.6);
  }

  /** A card on face `s` at tangent offset u (centre of the face = 0). */
  put(v: Vol, s: Side, u: number, y: number, n: string, o: { sx?: number; sy?: number; p?: number; tint?: ColKey; a?: Acc; fl?: number; off?: number } = {}) {
    const f = frame(v, s);
    const [x, z] = f.at(u, (o.off ?? 0.004));
    this.card(n, x, y, z, f.ry, { ...o, tint: o.tint ?? v.c });
  }

  /**
   * A row of windows on floor(s) of a face. `pick(fl, i, n)` names the card (null leaves a bay blank: a bricked-up
   * window, a pipe, a blank wall); bays by pitch.
   */
  windows(v: Vol, s: Side, o: { floors?: number[]; pitch?: number; n?: number; pick?: (fl: number, i: number, n: number) => string | null; skip?: (fl: number, i: number, n: number) => boolean; inset?: number; y?: (fl: number) => number } = {}) {
    const f = frame(v, s);
    const n = o.n ?? Math.max(1, Math.floor((f.len - (o.inset ?? 0) * 2) / (o.pitch ?? 0.42)));
    const len = f.len - (o.inset ?? 0) * 2;
    const floors = o.floors ?? Array.from({ length: v.floors }, (_, i) => i);
    for (const fl of floors) {
      for (let i = 0; i < n; i++) {
        if (o.skip?.(fl, i, n)) continue;
        const nm = o.pick ? o.pick(fl, i, n) : this.fam[0];
        if (!nm) continue;
        const u = -len / 2 + (len * (i + 0.5)) / n;
        const ch = CARDS[nm]?.h ?? 0.24;
        this.put(v, s, u, o.y ? o.y(fl) : this.wy(v, fl, ch), nm, { fl });
      }
    }
  }

  /** The window card for floor fl, bay i on a street / side / back face of this house: one family with a few variations. */
  win(side: 'front' | 'side' | 'back', fl: number, i: number, k = 0): string {
    const r = this.h(600 + fl * 17 + i * 5 + k * 31 + (side === 'back' ? 100 : side === 'side' ? 200 : 0));
    let n = this.fam[side === 'front' ? 0 : 1];
    if (side === 'front') {
      if (n === 'win_shut' && r < 0.3) n = 'win_closed';
      else if (n === 'win' && r < 0.2) n = 'win_grille';
    } else if (r < 0.2) n = 'win_grille';
    return n;
  }

  door(v: Vol, s: Side, u: number, n = 'door', o: { awning?: boolean; step?: boolean; lamp?: boolean } = {}) {
    const f = frame(v, s);
    const ch = CARDS[n].h;
    this.put(v, s, u, v.y0 + ch / 2 + 0.004, n, { p: 3, a: 'door', fl: 0 });
    const [x, z] = f.at(u, 0.006);
    if (o.awning) {
      this.piece('awning', x, v.y0 + 0.335, z, { ry: f.ry, s: [0.34 / 0.6, 1, 0.8], a: 'awn' });
      this.note('awning');
    }
    if (o.lamp !== false) this.lamp(f, u, v.y0 + 0.31, 0.2);
  }

  /** A porch lamp slot + its small fixture. */
  lamp(f: ReturnType<typeof frame>, u: number, y: number, du: number) {
    const [x, z] = f.at(u + du, 0.014);
    this.sw('iron', x, y, z, 0.016, 0.03, 0.016, { a: 'tankc' });
    this.sw('frame', x, y - 0.002, z, 0.012, 0.016, 0.012, { col: [4, 3.4, 2.2] });
    this.lamps.push({ x, y, z, ry: f.ry });
  }
  lamps: { x: number; y: number; z: number; ry: number }[] = [];

  /** An upper-floor balcony on face s at tangent u, width w, serving floor fl (>= 1): slab, rails, a balcony door + windows each side. */
  balcony(v: Vol, s: Side, u: number, w: number, fl: number, o: { rail?: 'iron' | 'wood' | 'solid'; door?: boolean; depth?: number } = {}) {
    const f = frame(v, s);
    const y = v.y0 + fl * v.fh;
    const dep = o.depth ?? 0.14;
    const [cx, cz] = f.at(u, dep / 2);
    const horizontal = s === 'f' || s === 'b';
    const sw = horizontal ? w : dep;
    const sd = horizontal ? dep : w;
    this.box(cx, y + 0.0125, cz, sw, 0.025, sd, v.c, { bottom: true });
    this.box(cx, y - 0.004, cz, sw + 0.02, 0.012, sd + 0.02, 'trim', { bottom: true });
    const rail = o.rail ?? 'iron';
    const [ax, az] = f.at(u - w / 2 + 0.01, dep - 0.012);
    const [bx, bz] = f.at(u + w / 2 - 0.01, dep - 0.012);
    const [a2x, a2z] = f.at(u - w / 2 + 0.012, 0.01);
    const [b2x, b2z] = f.at(u + w / 2 - 0.012, 0.01);
    if (rail === 'iron') {
      this.rail(ax, az, bx, bz, y + 0.025, 0.85);
      this.rail(a2x, a2z, ax, az, y + 0.025, 0.85);
      this.rail(b2x, b2z, bx, bz, y + 0.025, 0.85);
    } else if (rail === 'wood') {
      for (const [px, pz, qx, qz] of [[ax, az, bx, bz], [a2x, a2z, ax, az], [b2x, b2z, bx, bz]]) this.woodRail(px, pz, qx, qz, y + 0.025);
    } else {
      // a solid plaster balustrade with a coping
      for (const [px, pz, qx, qz] of [[ax, az, bx, bz], [a2x, a2z, ax, az], [b2x, b2z, bx, bz]]) {
        const L = Math.hypot(qx - px, qz - pz);
        const ang = Math.atan2(qx - px, qz - pz);
        this.box((px + qx) / 2, y + 0.025 + 0.04, (pz + qz) / 2, 0.03, 0.08, L + 0.03, v.c, { ry: ang });
        this.box((px + qx) / 2, y + 0.025 + 0.086, (pz + qz) / 2, 0.042, 0.012, L + 0.04, 'trim', { ry: ang });
      }
    }
    if (o.door !== false) {
      this.put(v, s, u, y + 0.19 + 0.02 + 0.004, 'door_balc', { p: 2, a: 'acc', fl });
    }
    this.note('balcony');
  }

  rail(ax: number, az: number, bx: number, bz: number, y: number, hk = 1) {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.05) return;
    const n = Math.max(1, Math.round(len / 0.5));
    const ang = Math.atan2(-(bz - az), bx - ax);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      this.piece('rail', ax + (bx - ax) * t, y, az + (bz - az) * t, { ry: ang, s: [len / n / 0.5, hk, 1], col: [0.8, 0.84, 0.88] });
    }
  }

  woodRail(ax: number, az: number, bx: number, bz: number, y: number) {
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.05) return;
    const ang = Math.atan2(bx - ax, bz - az);
    const mx = (ax + bx) / 2;
    const mz = (az + bz) / 2;
    this.sw('wood', mx, y + 0.085, mz, 0.018, 0.014, L, { ry: ang });
    this.sw('wood', mx, y + 0.03, mz, 0.012, 0.012, L, { ry: ang });
    const n = Math.max(2, Math.round(L / 0.07));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      this.sw('wood', ax + (bx - ax) * t, y + 0.045, az + (bz - az) * t, 0.012, 0.09, 0.012, { lod: i % 2 ? 0 : 'both' });
    }
  }

  awningOn(v: Vol, s: Side, u: number, w: number, y: number, a: Acc = 'awn') {
    const f = frame(v, s);
    const [x, z] = f.at(u, 0.006);
    this.piece('awning', x, y, z, { ry: f.ry, s: [w / 0.6, 1, 1], a });
    this.note('awning');
  }

  /** A wide arcade of open arches on a face (the 'arch' card stretched). */
  arcade(v: Vol, s: Side, y0: number, n: number, ah = 0.22, tint: ColKey = v.c) {
    const f = frame(v, s);
    const len = f.len;
    for (let i = 0; i < n; i++) {
      const u = -len / 2 + (len * (i + 0.5)) / n;
      const aw = (len / n) * 0.62;
      const sx = aw / (0.3 * 0.72);
      const sy = (ah + aw / 2) / (0.3 * 0.86);
      this.put(v, s, u, y0 + (0.3 * sy) / 2, 'arch', { sx, sy, p: 2, tint });
    }
    this.note('arches');
  }

  // ---------------------------------------------------------------- roof clutter

  /**
   * Things on a flat roof, each on its own spot of the roof (no overlaps): water tanks, a satellite dish, a stair
   * head, a solar heater, an AC unit, washing on a line, an antenna mast, a pergola with a shade.
   */
  roof(v: Vol, o: { tanks?: number; dish?: number; stair?: number; solar?: number; ac?: number; laundry?: number; mast?: number; pergola?: number; shed?: number; rail?: boolean; spare?: number } = {}) {
    const T = v.top;
    const sx = (v.lx - 0.16) / 2;
    const sz = (v.dz - 0.16) / 2;
    const free = [
      [-0.55, -0.55], [0.55, -0.55], [0, -0.55],
      [-0.55, 0.45], [0.55, 0.45], [0, 0.45],
      [-0.55, 0], [0.55, 0],
    ].map(([a, b]) => [v.x + a * sx * 1.5, v.z + b * sz * 1.4]) as [number, number][];
    // (shuffle by the seed)
    for (let i = free.length - 1; i > 0; i--) {
      const j = Math.floor(this.h(700 + i) * (i + 1));
      [free[i], free[j]] = [free[j], free[i]];
    }
    const take = () => free.pop();
    const hp = (k: number, d = 0.5) => this.h(720 + k) < (o.spare ?? d);
    const small = v.lx < 0.9 || v.dz < 0.7;
    const tanksN = o.tanks ?? (hp(1, 0.75) ? 1 + (hp(2, 0.35) ? 1 : 0) : 0);
    if (o.rail) this.railing(v, 0.9);
    if ((o.stair ?? (hp(3, 0.4) ? 1 : 0)) && !small) {
      const p = take();
      if (p) {
        const [x, z] = p;
        const wc = v.c === 'wall' ? 'wall2' : 'wall';
        this.box(x, T + 0.1, z, 0.24, 0.2, 0.24, wc);
        this.box(x, T + 0.205, z, 0.26, 0.012, 0.26, 'trim');
        this.card('door', x, T + 0.085, z + 0.123, 0, { sx: 0.5, sy: 0.45, p: 2, tint: wc, a: 'door' });
        this.top = Math.max(this.top, T + 0.21);
        this.note('stairhead');
      }
    }
    for (let i = 0; i < tanksN; i++) {
      const p = take();
      if (!p) break;
      this.piece('tank', p[0], T, p[1], { ry: this.h(740 + i) * 6, a: 'tankc' });
      this.top = Math.max(this.top, T + 0.17);
      this.note('tank');
    }
    if (o.dish ?? (hp(4, 0.5) ? 1 : 0)) {
      const p = take();
      if (p) {
        this.piece('dish', p[0], T, p[1], { ry: (this.h(748) - 0.5) * 3, lod: 0 });
        this.note('dish');
      }
    }
    if (!small && (o.solar ?? (hp(5, 0.35) ? 1 : 0))) {
      const p = take();
      if (p) {
        this.piece('solar', p[0], T, p[1], { ry: this.h(749) < 0.5 ? 0 : Math.PI });
        this.note('solar');
      }
    }
    if (o.ac ?? (hp(6, 0.3) ? 1 : 0)) {
      const p = take();
      if (p) this.piece('ac', p[0], T + 0.002, p[1], { ry: this.h(750) < 0.5 ? 0 : Math.PI / 2 });
    }
    if (!small && (o.laundry ?? (hp(7, 0.4) ? 1 : 0))) {
      const p = take();
      if (p) this.laundry(p[0], T, p[1]);
    }
    if (o.mast ?? (hp(8, 0.18) ? 1 : 0)) {
      const p = take();
      if (p) {
        this.sw('steel', p[0], T + 0.16, p[1], 0.008, 0.32, 0.008, { lod: 0 });
        for (let i = 0; i < 3; i++) this.sw('steel', p[0], T + 0.12 + i * 0.07, p[1], 0.14 - i * 0.03, 0.006, 0.006, { lod: 0, ry: 0.4 });
        this.top = Math.max(this.top, T + 0.32);
        this.note('mast');
      }
    }
    if (!small && o.pergola) {
      const p = take();
      if (p) this.pergola(p[0], p[1], 0.55, 0.42, T);
    }
  }

  laundry(x: number, y: number, z: number) {
    for (const sx of [-0.22, 0.22]) this.sw('wood', x + sx, y + 0.07, z, 0.01, 0.14, 0.01, { lod: 0 });
    this.sw('frame', x, y + 0.13, z, 0.44, 0.004, 0.004, { lod: 0 });
    const cl: [number, number, number][] = [[0.9, 0.9, 0.88], [0.75, 0.2, 0.18], [0.2, 0.35, 0.65], [0.85, 0.7, 0.25], [0.3, 0.55, 0.35]];
    for (let i = 0; i < 4; i++) {
      this.sw('fabric_acc', x - 0.15 + i * 0.1, y + 0.1 - this.h(30 + i) * 0.02, z, 0.06, 0.06 + this.h(30 + i) * 0.04, 0.004, { a: cl[Math.floor(this.h(40 + i) * cl.length)], lod: 0 });
    }
    this.note('laundry');
  }

  pergola(x: number, z: number, lx: number, dz: number, y: number, cloth = true) {
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) this.sw('wood', x + (sx * lx) / 2, y + 0.1, z + (sz * dz) / 2, 0.025, 0.2, 0.025, { col: [2.4, 2.4, 2.4] });
    for (const sz of [-1, 1]) this.sw('wood', x, y + 0.19, z + (sz * dz) / 2, lx + 0.05, 0.02, 0.025);
    for (let i = 0; i < 6; i++) this.sw('wood_lt', x - lx / 2 + (lx * i) / 5, y + 0.205, z, 0.02, 0.015, dz + 0.06, { lod: 0 });
    if (cloth && this.h(54) < 0.5) this.sw('fabric_acc', x, y + 0.216, z, lx + 0.04, 0.008, dz + 0.04, { a: 'cloth' });
    this.top = Math.max(this.top, y + 0.22);
    this.note('pergola');
  }

  railing(v: Vol, hk = 1) {
    const T = v.top + 0.012;
    const x0 = v.x - v.lx / 2 + 0.03;
    const x1 = v.x + v.lx / 2 - 0.03;
    const z0 = v.z - v.dz / 2 + 0.03;
    const z1 = v.z + v.dz / 2 - 0.03;
    this.rail(x0, z1, x1, z1, T, hk);
    this.rail(x0, z0, x1, z0, T, hk);
    this.rail(x0, z0, x0, z1, T, hk);
    this.rail(x1, z0, x1, z1, T, hk);
    this.note('roof rail');
  }

  // ---------------------------------------------------------------- trims and weathering

  /** A rain pipe down a corner of a face. */
  pipe(v: Vol, s: Side, u: number, h = v.top - v.y0) {
    const f = frame(v, s);
    const [x, z] = f.at(u, 0);
    this.piece('pipe', x, v.y0, z, { ry: f.ry, s: [1, Math.max(0.3, (h - 0.04) / 0.5), 1], lod: 0, col: [1, 1, 1] });
    this.note('pipe');
  }

  /** The electric meter + a conduit and two cables along a face (wires). */
  wires(v: Vol, s: Side, u: number) {
    const f = frame(v, s);
    const [x, z] = f.at(u, 0.016);
    this.sw('metal', x, 0.2, z, 0.05, 0.07, 0.03, { lod: 0 });
    this.sw('iron', x, 0.32 + 0.12, z, 0.006, 0.24, 0.006, { lod: 0 });
    const top = Math.min(v.top - 0.1, v.y0 + FLOOR * 1.0 + 0.3);
    const len = f.len * 0.75;
    const [cx, cz] = f.at(u + len / 2 - 0.02, 0.016);
    const horiz = s === 'f' || s === 'b';
    for (const dy of [0, 0.022]) this.sw('iron', cx, Math.max(0.5, top) - dy, cz, horiz ? len : 0.005, 0.005, horiz ? 0.005 : len, { lod: 0 });
    this.note('wires');
  }

  /** A shop sign board (a frame and one of the painted fictional names). */
  sign(v: Vol, s: Side, u: number, y: number, w = 0.34, i = Math.floor(this.h(800) * SIGN_COUNT)) {
    const f = frame(v, s);
    const [x, z] = f.at(u, 0.012);
    const hh = w * 0.25;
    this.sw('frame', x, y, z, w + 0.02, hh + 0.02, 0.012, { ry: f.ry, lod: 0 });
    this.ops.push({ t: 'sign', i, x, y, z: z, ry: f.ry, w, h: hh });
    this.signs.push({ x, y, z, ry: f.ry, w, h: hh });
    this.note('sign');
  }
  signs: { x: number; y: number; z: number; ry: number; w: number; h: number }[] = [];

  /** Exposed mud-brick / lighter repair patches on a face (small boxes a hair proud of the wall). */
  patches(v: Vol, s: Side, n: number) {
    const f = frame(v, s);
    for (let i = 0; i < n; i++) {
      const u = (this.h(900 + i * 3) - 0.5) * (f.len - 0.3);
      const y = v.y0 + 0.08 + this.h(901 + i * 3) * (v.top - v.y0 - 0.2);
      const [x, z] = f.at(u, 0.002);
      const w = 0.07 + this.h(902 + i * 3) * 0.1;
      const hh = 0.05 + this.h(903 + i) * 0.08;
      if (s === 'f' || s === 'b') this.sw(this.h(904 + i) < 0.6 ? 'brick' : 'earth', x, y, z + (s === 'f' ? 0.0006 : -0.0006), w, hh, 0.003, { lod: 0 });
      else this.sw(this.h(904 + i) < 0.6 ? 'brick' : 'earth', x + (s === 'r' ? 0.0006 : -0.0006), y, z, 0.003, hh, w, { lod: 0 });
    }
    this.note('patches');
  }

  /** A drift of sand against the foot of a wall. */
  drift(v: Vol, s: Side, u: number, w: number, hgt = 0.07, dep = 0.16) {
    const f = frame(v, s);
    const [x, z] = f.at(u, 0.0);
    this.geo('wedge', x, 0, z, w, hgt, dep, 'sand', { ry: f.ry, mat: 3 });
    this.note('sand drift');
  }

  /** A walled yard round the house: low wall, gate posts and a gate in the front (+z) wall. */
  yard(o: { z0: number; z1: number; x0: number; x1: number; h?: number }) {
    const yh = o.h ?? 0.16 + this.h(91) * 0.08;
    const yc: ColKey = 'wall2';
    const { x0, x1, z0, z1 } = o;
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const gw = 0.27;
    this.box(cx, yh / 2, z0, x1 - x0, yh, 0.05, yc);
    for (const sx of [x0, x1]) this.box(sx, yh / 2, cz, 0.05, yh, z1 - z0, yc);
    // the front wall in two pieces either side of the gate, a post and a cap each side of it
    const segL = cx - gw - x0;
    const segR = x1 - cx - gw;
    this.box(x0 + segL / 2, yh / 2, z1, segL, yh, 0.05, yc);
    this.box(x1 - segR / 2, yh / 2, z1, segR, yh, 0.05, yc);
    for (const sx of [-1, 1]) {
      this.box(cx + sx * gw, yh / 2 + 0.02, z1, 0.08, yh + 0.04, 0.08, 'trim');
      this.box(cx + sx * gw, yh + 0.048, z1, 0.1, 0.016, 0.1, 'trim');
    }
    this.card('gate', cx, yh * 0.47, z1 + 0.004, 0, { sx: 0.52 / 0.32, sy: (yh * 0.94) / 0.26, p: 3, tint: yc, a: 'door' });
    this.card('gate', cx, yh * 0.47, z1 - 0.004, Math.PI, { sx: 0.52 / 0.32, sy: (yh * 0.94) / 0.26, p: 3, tint: yc, a: 'door' });
    this.note('yard');
  }

  // ---------------------------------------------------------------- assembling the plan

  finish(variant: string, silhouette: number): BuildingPlan {
    // 1. the cards: a later, more important card wins over a plain window it overlaps
    const keep = this.cards.filter((a) => {
      const ai = CARDS[a.n];
      const aw = ai.w * a.sx;
      const ah = ai.h * a.sy;
      const an = [Math.sin(a.ry), Math.cos(a.ry)];
      return !this.cards.some((b) => {
        if (b === a || b.p <= a.p) return false;
        const bn = [Math.sin(b.ry), Math.cos(b.ry)];
        if (an[0] * bn[0] + an[1] * bn[1] < 0.9) return false;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        if (Math.abs(dx * an[0] + dz * an[1]) > 0.04) return false;
        const bi = CARDS[b.n];
        const bw = bi.w * b.sx;
        const bh = bi.h * b.sy;
        // tangent = up x normal = (cos ry, -sin ry) in (x, z)
        const t = dx * an[1] - dz * an[0];
        return Math.abs(t) < (aw + bw) * 0.38 && Math.abs(b.y - a.y) < (ah + bh) * 0.38;
      });
    });
    const slots: BuildingSlot[] = [];
    let k = 0;
    for (const c of keep) {
      this.ops.push({ t: 'card', n: c.n, x: c.x, y: c.y, z: c.z, ry: c.ry, sx: c.sx, sy: c.sy, tint: c.tint, a: c.a });
      const ci = CARDS[c.n];
      if (ci.kind) {
        const fl = c.fl;
        const r1 = this.h(1000 + k * 7);
        const lit = this.awake && r1 < (ci.kind === 'shop' ? 0.9 : 0.62);
        slots.push({ kind: ci.kind, x: c.x, y: c.y + ci.cy * c.sy, z: c.z, ry: c.ry, w: ci.ow * c.sx, h: ci.oh * c.sy, floor: fl, lit, flicker: this.h(1100 + k * 5) });
      }
      k++;
    }
    this.cards = [];
    for (const l of this.lamps) slots.push({ kind: 'lamp', x: l.x, y: l.y, z: l.z, ry: l.ry, w: 0.03, h: 0.04, floor: 0, lit: this.awake || this.h(1200 + slots.length) < 0.3, flicker: 0 });
    for (const sg of this.signs) slots.push({ kind: 'sign', x: sg.x, y: sg.y, z: sg.z, ry: sg.ry, w: sg.w, h: sg.h, floor: 0, lit: this.h(1300 + slots.length) < 0.7, flicker: 0 });
    // 2. mirror: x -> -x, yaw -> -yaw
    if (this.mirror) {
      for (const o of this.ops) {
        o.x = -o.x;
        if ('ry' in o && o.ry !== undefined) o.ry = -o.ry;
        if ('rz' in o && o.rz !== undefined) o.rz = -o.rz;
      }
      for (const s of slots) {
        s.x = -s.x;
        s.ry = -s.ry;
      }
    }
    const wallTop = Math.max(this.wallTop, FLOOR);
    return {
      variant,
      silhouette,
      storeys: this.storeys,
      height: wallTop,
      top: Math.max(this.top, wallTop),
      awake: this.awake,
      mirror: this.mirror,
      palette: this.palIdx,
      wear: this.wear,
      slots,
      ops: this.ops,
      col: this.col,
      acc: this.acc,
      features: [...this.features],
      kind: this.st.kind,
    };
  }
}

// ------------------------------------------------------------------ the 2 x 2 houses

/** A variant builder: lays the house on a 2 x 2 footprint (local -1..1) and returns nothing. */
type Builder = (p: P) => void;

/** Windows on all four faces of a body: the front's family, the sides' and the back's. */
function allWindows(p: P, v: Vol, o: { front?: boolean; doorU?: number; doorFloor?: boolean; frontPick?: (fl: number, i: number, n: number) => string | null; sidePitch?: number; sideSkip?: number; backSkip?: number } = {}) {
  const dn = o.doorU;
  p.windows(v, 'f', {
    skip: (fl, i, n) => o.front === false || (fl === 0 && dn !== undefined && Math.abs(-v.lx / 2 + (v.lx * (i + 0.5)) / n - dn) < 0.22),
    pick: o.frontPick ?? ((fl, i) => p.win('front', fl, i)),
  });
  p.windows(v, 'b', { skip: (fl, i) => p.h(1400 + fl * 11 + i) < (o.backSkip ?? 0.25), pick: (fl, i) => p.win('back', fl, i) });
  for (const [s, k] of [['l', 0], ['r', 40]] as const)
    p.windows(v, s, { pitch: o.sidePitch ?? 0.46, skip: (fl, i) => p.h(1500 + fl * 11 + i * 3 + k) < (o.sideSkip ?? 0.3), pick: (fl, i) => (p.h(1600 + fl * 7 + i + k) < 0.16 && fl === 0 ? 'vent' : p.win('side', fl, i, k)) });
}

function frontDoor(p: P, v: Vol, u: number, plank = false) {
  const kind = plank ? 'door_plank' : p.h(14) < 0.22 ? 'door_arch' : 'door';
  p.door(v, 'f', u, kind, { awning: kind === 'door' && p.h(9) < 0.6 });
}

/** The extras every house may pick up: AC units on a back wall, rain pipes, wires, a sand drift, repair patches. */
function extras(p: P, v: Vol, o: { pipes?: boolean; ac?: boolean; patch?: number } = {}) {
  if (o.ac !== false && p.h(206) < 0.75) {
    const n = v.floors > 1 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const u = (k === 0 ? -0.25 : 0.25) * v.lx + (p.h(207 + k) - 0.5) * 0.08;
      const f = frame(v, 'b');
      const [x, z] = f.at(u, 0.03);
      p.piece('ac', x, k === 0 ? v.y0 + Math.min(v.top - v.y0 - 0.16, 0.2) : v.y0 + (v.top - v.y0) * 0.62, z, { ry: Math.PI, lod: 0 });
    }
  }
  if (o.pipes !== false && p.h(210) < 0.55) p.pipe(v, p.h(211) < 0.5 ? 'f' : 'b', (p.h(212) < 0.5 ? -1 : 1) * (v.lx / 2 - 0.035));
  if (p.h(213) < 0.28) p.wires(v, 'f', -v.lx / 2 + 0.18);
  const dr = p.h(214);
  if (dr < 0.45) {
    const s: Side = (['f', 'b', 'l', 'r'] as Side[])[Math.floor(p.h(215) * 4)];
    const f = frame(v, s);
    p.drift(v, s, (p.h(216) - 0.5) * f.len * 0.4, f.len * (0.35 + p.h(217) * 0.3));
  }
  p.patches(v, (['b', 'l', 'r'] as Side[])[Math.floor(p.h(218) * 3)], o.patch ?? Math.floor(p.wear * 3.4));
}

const V_CUBE: Builder = (p) => {
  const fl = p.h(310) < 0.45 ? 1 : 2;
  const lx = 1.3 + p.h(311) * 0.25;
  const dz = 1.05 + p.h(312) * 0.1;
  const v = p.body({ x: 0, z: -0.02, lx, dz, floors: fl, parapet: p.h(313) < 0.25 ? 'merlon' : 'plain' });
  const du = p.h(314) < 0.5 ? 0 : (p.h(315) < 0.5 ? -1 : 1) * lx * 0.22;
  frontDoor(p, v, du);
  allWindows(p, v, { doorU: du });
  if (fl === 2 && p.h(316) < 0.6) p.balcony(v, 'f', -du * 0.5 - 0.0, 0.7, 1, { rail: p.h(317) < 0.5 ? 'iron' : 'solid' });
  if (fl === 1 && p.h(318) < 0.5) p.pergola(-0.2, -0.1, 0.7, 0.5, v.top);
  p.roof(v, { rail: fl === 2 && p.h(319) < 0.4, pergola: 0 });
  extras(p, v);
};

const V_SHOP: Builder = (p) => {
  const fl = 2 + (p.h(320) < 0.35 ? 1 : 0);
  const v = p.body({ x: 0, z: -0.04, lx: 1.55, dz: 1.18, floors: fl });
  const two = p.h(321) < 0.6;
  const us = two ? [-0.36, 0.36] : [0];
  for (const u of us) p.put(v, 'f', u, 0.135, 'shop', { sx: two ? 1 : 1.3, sy: 1, p: 3, a: p.h(322) < 0.5 ? 'acc2' : 'awn' });
  p.awningOn(v, 'f', 0, 1.46, 0.3);
  p.sign(v, 'f', 0, 0.36, 0.42);
  if (!two) p.door(v, 'f', 0.66, 'door_plank', { lamp: true });
  else p.door(v, 'f', 0.66, 'door', { lamp: true });
  // the upper floors: a balcony on the second floor, windows on the rest
  p.windows(v, 'f', { floors: Array.from({ length: fl - 1 }, (_, i) => i + 1), pick: (f, i) => p.win('front', f, i), n: 3, skip: (f, i) => f === 1 && i === 1 });
  p.balcony(v, 'f', 0, 0.62, 1, { rail: p.h(323) < 0.5 ? 'iron' : 'wood' });
  allWindows(p, v, { front: false });
  p.roof(v, { rail: p.h(324) < 0.3 });
  extras(p, v, { pipes: true });
};

const V_APT: Builder = (p) => {
  const fl = p.h(330) < 0.2 ? 2 : 3;
  const lx = 1.3 + p.h(331) * 0.2;
  const v = p.body({ x: 0, z: -0.05, lx, dz: 1.1, floors: fl, parapet: 'plain' });
  frontDoor(p, v, -lx * 0.28);
  const bs = [-lx * 0.28, lx * 0.2];
  for (let f = 1; f < fl; f++) {
    // balconies in a staggered pattern; windows in the other bays
    const u = f % 2 ? bs[1] : bs[0] * 0.6;
    p.balcony(v, 'f', u, 0.58, f, { rail: p.h(332) < 0.55 ? 'iron' : 'solid' });
  }
  p.windows(v, 'f', {
    pitch: 0.44,
    skip: (f, i, n) => {
      const u = -v.lx / 2 + (v.lx * (i + 0.5)) / n;
      if (f === 0) return Math.abs(u - -lx * 0.28) < 0.25;
      const bu = f % 2 ? bs[1] : bs[0] * 0.6;
      return Math.abs(u - bu) < 0.32;
    },
    pick: (f, i) => (f === 0 ? p.win('front', f, i) : p.h(333 + f + i) < 0.5 ? 'win_wide' : p.win('front', f, i)),
  });
  allWindows(p, v, { front: false, backSkip: 0.15 });
  p.pipe(v, 'f', lx / 2 - 0.035);
  p.pipe(v, 'b', -lx / 2 + 0.035);
  p.roof(v, { stair: 1, tanks: 2, rail: p.h(334) < 0.4 });
  extras(p, v, { pipes: false });
};

const V_TOWER: Builder = (p) => {
  const lx = 0.92 + p.h(340) * 0.1;
  const v = p.body({ x: (p.h(341) - 0.5) * 0.3, z: -0.05, lx, dz: 0.92, floors: 3, parapet: 'merlon', c: p.h(342) < 0.5 ? 'wall' : 'wall2' });
  p.door(v, 'f', 0, 'door_plank', { lamp: true });
  // ground floor: small windows, first: a bay window (mashrabiya) between two arched windows, top: coupled windows
  p.put(v, 'f', -0.28, 0.2, 'win_small', { fl: 0 });
  p.put(v, 'f', 0.28, 0.2, 'win_small', { fl: 0 });
  p.put(v, 'f', -0.31, p.wy(v, 1), 'win_arch', { fl: 1 });
  p.put(v, 'f', 0.31, p.wy(v, 1), 'win_arch', { fl: 1 });
  {
    const f = frame(v, 'f');
    const [x, z] = f.at(0, 0);
    p.piece('bay', x, FLOOR + 0.07, z, { ry: f.ry, a: 'acc' });
    p.note('bay window');
  }
  p.put(v, 'f', 0, p.wy(v, 2, 0.3), 'win_bifora', { fl: 2, p: 2 });
  for (const s of ['l', 'r'] as Side[]) {
    p.put(v, s, -0.15, 0.2, 'win_small', { fl: 0 });
    for (let f = 1; f < 3; f++) p.put(v, s, (s === 'l' ? 1 : -1) * 0.18, p.wy(v, f), f === 2 ? 'win_round' : 'win_small', { fl: f });
  }
  for (let f = 0; f < 3; f++) p.put(v, 'b', 0, p.wy(v, f), f === 0 ? 'vent' : 'win_small', { fl: f });
  // a corner turret with a little dome (or open merlons)
  if (p.h(343) < 0.7) {
    const tx = v.x + (p.h(344) < 0.5 ? -1 : 1) * (v.lx / 2 - 0.1);
    const tz = v.z - v.dz / 2 + 0.1;
    p.box(tx, v.top + 0.15, tz, 0.22, 0.3, 0.22, v.c);
    p.box(tx, v.top + 0.306, tz, 0.25, 0.012, 0.25, 'trim');
    p.piece('dome', tx, v.top + 0.312, tz, { s: [0.5, 0.5, 0.5], tint: 'wall' });
    p.card('win_small', tx, v.top + 0.15, tz + 0.114, 0, { fl: 3, tint: 'wall' });
    p.note('turret');
  }
  p.roof(v, { tanks: p.h(345) < 0.6 ? 1 : 0, dish: 0, ac: 0 });
  p.pipe(v, 'f', -lx / 2 + 0.03);
  extras(p, v, { pipes: false, ac: false });
};

const V_STEPPED: Builder = (p) => {
  const lo = p.body({ x: 0, z: 0.0, lx: 1.6, dz: 1.25, floors: 1, parapet: 'plain' });
  p.door(lo, 'f', -0.5, p.h(350) < 0.5 ? 'door' : 'door_arch', { awning: true });
  p.windows(lo, 'f', { skip: (_f, i, n) => i === 0 || n < 3, pick: (f, i) => p.win('front', f, i), n: 3 });
  allWindows(p, lo, { front: false });
  // the upper floor set back behind a terrace
  const up = p.body({ x: -0.28, z: -0.25, lx: 0.95, dz: 0.66, floors: 1, y0: FLOOR + 0.0, c: 'wall2', parapet: 'plain', plinth: false });
  p.windows(up, 'f', { n: 2, pick: () => p.win('front', 1, 0) });
  p.put(up, 'f', 0.2, up.y0 + 0.19 + 0.004, 'door_balc', { p: 2, fl: 1 });
  p.windows(up, 'l', { n: 1, pick: () => 'win' });
  p.windows(up, 'b', { n: 2, pick: () => 'win_grille' });
  // terrace in front of the upper floor: rail + shade pergola + an outside stair on the right
  p.rail(-0.78, 0.5, 0.2, 0.5, lo.top + 0.012, 1);
  p.rail(0.2, 0.5, 0.2, 0.08, lo.top + 0.012, 1);
  p.pergola(-0.3, 0.2, 0.9, 0.5, lo.top, true);
  stairs(p, 0.62, 0.55, lo);
  p.roof(up, { tanks: 1, dish: 1 });
  p.storeys = 2;
  extras(p, lo, { pipes: false });
};

/** An outside stair: treads from the front (z0) going back (-z) at x, rising to the roof of `lo`, a side wall and a handrail post. */
function stairs(p: P, x: number, z0: number, lo: Vol) {
  const n = 7;
  const rise = lo.top / n;
  const run = 0.1;
  for (let i = 0; i < n; i++) p.box(x, (rise * (i + 1)) / 2, z0 - i * run - run / 2, 0.2, rise * (i + 1), run + 0.002, 'wall');
  p.box(x + 0.108, lo.top / 2 + 0.02, z0 - (n * run) / 2, 0.016, lo.top * 0.85, n * run, 'wall');
  p.sw('iron', x - 0.1, lo.top + 0.06, z0 - n * run, 0.01, 0.12, 0.01, { lod: 0 });
  p.note('outer stair');
}

const V_LOGGIA: Builder = (p) => {
  const v = p.body({ x: 0, z: -0.05, lx: 1.4, dz: 1.1, floors: 2, parapet: 'plain' });
  p.arcade(v, 'f', 0.0, 3, 0.25);
  // upper floor: a loggia of three smaller arches over a rail, windows on the other faces
  p.arcade({ ...v, lx: 1.1, x: 0 }, 'f', FLOOR + 0.02, 3, 0.15);
  p.rail(-0.55, 0.5, 0.55, 0.5, FLOOR + 0.02, 0.9);
  p.door(v, 'b', 0, 'door_arch', { lamp: false });
  p.windows(v, 'b', { floors: [1], pick: () => 'win_bifora', n: 2 });
  for (const s of ['l', 'r'] as Side[]) {
    p.windows(v, s, { pitch: 0.5, pick: (f, i) => (f === 0 ? 'win_grille' : p.win('side', f, i)) });
  }
  p.piece('dome', 0.42, v.top, -0.3, { s: [0.17 / 0.25, 0.17 / 0.25, 0.17 / 0.25], tint: p.h(360) < 0.5 ? 'wall' : 'trim' });
  p.note('dome');
  p.railing({ ...v, lx: v.lx - 0.5, x: -0.25 }, 1);
  p.roof(v, { tanks: 1, stair: 0, dish: 1, laundry: 0 });
  extras(p, v, { pipes: true });
};

const V_ELL: Builder = (p) => {
  const a = p.body({ x: -0.36, z: 0, lx: 0.72, dz: 1.2, floors: 3, parapet: 'plain' });
  const b = p.body({ x: 0.4, z: 0.24, lx: 0.72, dz: 0.72, floors: 2, c: 'wall2', parapet: 'plain' });
  p.door(a, 'f', 0, 'door', { awning: true });
  p.windows(a, 'f', { n: 2, skip: (f, i) => (f === 0 && i === 0) || (f === 0 && i === 1), pick: (f, i) => p.win('front', f, i) });
  p.balcony(a, 'f', 0, 0.58, 1);
  p.balcony(a, 'f', 0, 0.58, 2, { rail: 'solid' });
  p.windows(a, 'l', { pitch: 0.4, pick: (f, i) => p.win('side', f, i) });
  p.windows(a, 'b', { n: 2, pick: (f, i) => p.win('back', f, i) });
  p.windows(b, 'f', { n: 2, skip: (f, i) => f === 0 && i === 1, pick: (f, i) => p.win('front', f, i) });
  p.put(b, 'f', 0.12, 0.19, 'door_plank', { p: 3, a: 'door' });
  p.awningOn(b, 'f', 0.12, 0.4, 0.31, 'acc2');
  p.windows(b, 'r', { n: 2, pick: (f, i) => p.win('side', f, i) });
  p.windows(b, 'b', { n: 1, pick: (f) => (f === 0 ? 'vent' : 'win') });
  p.windows(a, 'r', { n: 2, skip: (f) => f === 0, floors: [1, 2], pick: (f, i) => p.win('side', f, i, 3) });
  p.pipe(a, 'f', 0.33);
  p.roof(a, { tanks: 2, dish: 1, stair: 1 });
  p.roof(b, { tanks: 0, laundry: 1, dish: 0, solar: p.h(370) < 0.5 ? 1 : 0, rail: true });
  extras(p, a, { pipes: false });
};

const V_DOME: Builder = (p) => {
  // a domed house / small shrine: tall hall with a dome on a drum, a low annex with beam ends
  const fh = FLOOR * 1.15;
  const v = p.body({ x: -0.1, z: -0.02, lx: 1.0, dz: 1.0, floors: 1, fh, parapet: 'low', c: p.h(380) < 0.6 ? 'wall' : 'trim' });
  const r = 0.36;
  p.geo('cyl', v.x, v.top + 0.07, v.z, r * 2 * 0.82, 0.14, r * 2 * 0.82, v.c, { seg: 24 });
  p.box(v.x, v.top + 0.145, v.z, r * 1.8, 0.012, r * 1.8, 'trim');
  p.piece('dome', v.x, v.top + 0.14, v.z, { s: [r / 0.25 * 0.85, r / 0.25 * 0.85, r / 0.25 * 0.85], tint: p.h(381) < 0.5 ? 'white' : 'wall' });
  p.top = Math.max(p.top, v.top + 0.14 + 0.25 * (r / 0.25) * 0.85 + 0.05);
  p.wallTop = Math.max(p.wallTop, v.top + 0.145);
  p.note('dome');
  p.door(v, 'f', 0, 'door_arch', { lamp: true });
  p.windows(v, 'f', { n: 2, pick: () => 'win_arch', inset: 0.12, y: () => 0.24, skip: (_f, i, n) => Math.abs(-v.lx / 2 + (v.lx * (i + 0.5)) / n) < 0.2 });
  p.put(v, 'l', 0, 0.23, 'win_tall', { fl: 0 });
  p.put(v, 'r', 0, 0.23, 'win_tall', { fl: 0 });
  p.put(v, 'b', 0, 0.23, 'win_arch', { fl: 0 });
  // the annex: a low room with vigas under its parapet and a plank door
  const an = p.body({ x: 0.62, z: 0.24, lx: 0.5, dz: 0.62, floors: 1, fh: 0.36, c: 'wall2', parapet: 'low', plinth: false });
  p.door(an, 'f', 0, 'door_plank', { lamp: false });
  p.windows(an, 'r', { n: 1, pick: () => 'win_small', y: () => 0.2 });
  for (const s of ['f', 'r'] as Side[]) {
    const f = frame(an, s);
    const [x, z] = f.at(0, 0);
    p.piece('viga', x, an.top - 0.035, z, { ry: f.ry, lod: 0, s: [s === 'f' ? 1.2 : 1.5, 1, 1] });
  }
  p.note('viga');
  // a finial / a small minaret-like pole on 30 %
  if (p.h(382) < 0.3) p.piece('minaret', -0.62, 0, -0.5, { s: [0.55, 0.55, 0.55], tint: 'white' });
  p.pipe(v, 'b', v.lx / 2 - 0.04, v.top);
  extras(p, v, { pipes: false, ac: false, patch: Math.floor(p.wear * 3) });
};

const V_MUD: Builder = (p) => {
  // a mud-brick house: thick battered walls (earth palette), beam ends under the roof edge, few small windows, a
  // plank door, a roof room, a bread oven dome
  const fl = 1;
  const v = p.body({ x: 0, z: 0.02, lx: 1.32, dz: 1.1, floors: fl, fh: FLOOR * 1.1, c: 'earth', parapet: 'low', belt: false, plinth: false });
  // the battered foot: a slightly wider band
  p.box(0, 0.06, 0.02, 1.4, 0.12, 1.18, 'earth', { m: 0.93 });
  p.door(v, 'f', -0.28, 'door_plank', { lamp: true });
  p.put(v, 'f', 0.2, 0.22, 'win_small', { fl: 0 });
  p.put(v, 'f', 0.48, 0.22, 'win_small', { fl: 0 });
  p.put(v, 'l', -0.1, 0.22, 'win_small', { fl: 0 });
  p.put(v, 'r', 0.22, 0.22, 'win_small', { fl: 0 });
  p.put(v, 'r', -0.25, 0.22, 'win_round', { fl: 0 });
  p.put(v, 'b', 0, 0.22, 'win_small', { fl: 0 });
  for (const s of ['f', 'b'] as Side[]) {
    for (const u of [-0.4, 0.0, 0.4]) {
      const f = frame(v, s);
      const [x, z] = f.at(u, 0);
      p.piece('viga', x, v.top - 0.035, z, { ry: f.ry, lod: 0 });
    }
  }
  for (const s of ['l', 'r'] as Side[]) {
    const f = frame(v, s);
    for (const u of [-0.3, 0.2]) {
      const [x, z] = f.at(u, 0);
      p.piece('viga', x, v.top - 0.035, z, { ry: f.ry, lod: 0 });
    }
  }
  p.note('viga');
  // a roof room (half a storey) with a window and a ladder
  const room = p.body({ x: 0.3, z: -0.25, lx: 0.5, dz: 0.5, floors: 1, y0: v.top, fh: 0.34, c: 'earth', parapet: 'low', belt: false, plinth: false });
  p.windows(room, 'f', { n: 1, pick: () => 'win_small', y: () => v.top + 0.19 });
  p.put(room, 'l', 0, v.top + 0.19, 'door_plank', { sx: 0.8, sy: 0.7, fl: 1 });
  p.sw('wood', -0.1, 0.25, 0.4, 0.03, 0.5, 0.012, { rx: -0.28, lod: 0 });
  p.sw('wood', -0.16, 0.25, 0.4, 0.03, 0.5, 0.012, { rx: -0.28, lod: 0 });
  p.wallTop = v.top + 0.045;
  // an oven dome on the roof, a few clay pots at the door
  if (p.h(390) < 0.6) p.piece('dome', -0.3, v.top, -0.25, { s: [0.45, 0.4, 0.45], tint: 'earth' });
  p.piece('pots', -0.55, 0, 0.6, { ry: p.h(391) * 6, lod: 0 });
  if (p.h(392) < 0.5) p.laundry(-0.25, v.top, 0.2);
  if (p.h(393) < 0.5) p.piece('tank', 0.5, v.top, 0.2, { a: 'tankc' });
  extras(p, v, { pipes: false, ac: false, patch: 2 + Math.floor(p.wear * 3) });
};

const V_CAFE: Builder = (p) => {
  const v = p.body({ x: 0, z: -0.15, lx: 1.4, dz: 0.95, floors: 2, parapet: 'plain' });
  for (const u of [-0.37, 0.37]) p.put(v, 'f', u, 0.135, 'shop', { sx: 0.95, sy: 1, p: 3, a: 'acc2' });
  p.awningOn(v, 'f', 0, 1.34, 0.3, 'awn');
  p.sign(v, 'f', 0, 0.37, 0.36);
  // upper floor: a continuous terrace with rails and arched windows behind
  p.windows(v, 'f', { floors: [1], n: 3, pick: () => (p.h(400) < 0.5 ? 'win_arch' : 'win_shut') });
  p.box(0, FLOOR + 0.0125, v.z + v.dz / 2 + 0.07, 1.44, 0.025, 0.14, 'wall', { bottom: true });
  p.rail(-0.7, v.z + v.dz / 2 + 0.135, 0.7, v.z + v.dz / 2 + 0.135, FLOOR + 0.025, 0.85);
  p.rail(-0.7, v.z + v.dz / 2 + 0.005, -0.7, v.z + v.dz / 2 + 0.135, FLOOR + 0.025, 0.85);
  p.rail(0.7, v.z + v.dz / 2 + 0.005, 0.7, v.z + v.dz / 2 + 0.135, FLOOR + 0.025, 0.85);
  allWindows(p, v, { front: false });
  for (const x of [-0.45, 0.0, 0.45]) p.piece('table', x, 0, 0.58, { a: [0.25, 0.5, 0.75], ry: p.h(401) * 6 });
  p.roof(v, { tanks: 2, dish: 1, rail: false });
  extras(p, v, { pipes: true });
};

const V_VILLA: Builder = (p) => {
  const v = p.body({ x: 0, z: -0.12, lx: 1.2, dz: 0.95, floors: 2, parapet: 'none', c: 'wall2', belt: true });
  // a hipped terracotta roof with eaves
  p.geo('pyramid', 0, v.top + 0.14, v.z, v.lx + 0.16, 0.28, v.dz + 0.16, 'tile', { mat: 0 });
  p.box(0, v.top + 0.012, v.z, v.lx + 0.18, 0.024, v.dz + 0.18, 'tile');
  p.wallTop = Math.max(p.wallTop, v.top + 0.28);
  p.note('hip roof');
  p.door(v, 'f', 0, 'door_arch', { lamp: true });
  p.windows(v, 'f', { n: 3, skip: (f, i) => f === 0 && i === 1, pick: (f, i) => (f === 0 ? 'win_grille' : i === 1 ? 'win_bifora' : p.win('front', f, i)) });
  allWindows(p, v, { front: false });
  // a porch: two columns and a flat slab with a rail (a balcony)
  p.box(-0.27, 0.2, 0.46, 0.05, 0.4, 0.05, 'trim');
  p.box(0.27, 0.2, 0.46, 0.05, 0.4, 0.05, 'trim');
  p.box(0, 0.41, 0.37, 0.7, 0.03, 0.22, 'wall2', { bottom: true });
  p.rail(-0.33, 0.47, 0.33, 0.47, 0.425, 0.8);
  // a garden wall
  p.yard({ x0: -0.9, x1: 0.9, z0: -0.9, z1: 0.9, h: 0.18 });
  if (p.h(410) < 0.6) p.tree(0.62, 0.62, 0.16, 0.28);
  extras(p, v, { pipes: true });
};

const V_ROW: Builder = (p) => {
  const a = p.body({ x: -0.42, z: -0.02, lx: 0.8, dz: 1.2, floors: 3, parapet: 'plain', c: 'wall' });
  const b = p.body({ x: 0.42, z: -0.02, lx: 0.8, dz: 1.2, floors: 2, parapet: 'plain', c: 'wall2' });
  for (const [v, k] of [[a, 0], [b, 1]] as const) {
    p.door(v, 'f', k ? 0.18 : -0.18, k ? 'door_plank' : 'door', { awning: !k, lamp: true });
    p.windows(v, 'f', { n: 2, skip: (f, i) => f === 0 && i === (k ? 1 : 0), pick: (f, i) => p.win('front', f, i + k) });
    p.windows(v, 'b', { n: 2, pick: (f, i) => p.win('back', f, i) });
  }
  p.windows(a, 'l', { pitch: 0.45, skip: (_f, i) => i === 2, pick: (f, i) => p.win('side', f, i) });
  p.windows(b, 'r', { pitch: 0.45, skip: (_f, i) => i === 2, pick: (f, i) => p.win('side', f, i, 5) });
  p.balcony(a, 'f', 0.0, 0.5, 1, { rail: 'iron' });
  p.balcony(a, 'f', 0.0, 0.5, 2, { rail: 'wood' });
  p.pipe(a, 'f', 0.38);
  p.roof(a, { tanks: 2, stair: 1, dish: 1 });
  p.roof(b, { tanks: 0, laundry: 1, solar: 1, rail: true, dish: 0 });
  extras(p, a, { pipes: false });
};

const V_OUTER: Builder = (p) => {
  const v = p.body({ x: -0.12, z: -0.05, lx: 1.2, dz: 1.0, floors: 2, parapet: 'plain', c: 'ochre' });
  p.door(v, 'f', -0.3, 'door_plank', { lamp: true });
  p.windows(v, 'f', { n: 3, skip: (f, i) => f === 0 && i === 0, pick: (f, i) => p.win('front', f, i) });
  allWindows(p, v, { front: false });
  // the outside stair along the front of the right wall up to a landing at the roof
  const lx = v.x + v.lx / 2 + 0.12;
  const n = 7;
  const rise = v.top / n;
  const run = 0.12;
  for (let i = 0; i < n; i++) p.box(lx, rise * (i + 0.5), 0.5 - i * run - run / 2 - 0.0, 0.22, rise * (i + 1), run + 0.002, 'ochre', { bottom: false });
  p.box(lx + 0.112, v.top / 2 + 0.03, 0.5 - (n * run) / 2, 0.016, v.top * 0.9, n * run, 'ochre');
  p.box(lx, v.top - 0.012, 0.5 - n * run - 0.04, 0.22, 0.024, 0.14, 'ochre');
  p.rail(lx - 0.1, 0.5 - n * run - 0.11, lx + 0.1, 0.5 - n * run - 0.11, v.top + 0.012, 0.8);
  p.note('outer stair');
  // a shade sail and washing on the roof
  p.sw('fabric_acc', -0.2, v.top + 0.26, -0.05, 0.8, 0.008, 0.6, { rx: 0.12, a: 'cloth' });
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) p.sw('steel', -0.2 + sx * 0.4, v.top + 0.13, -0.05 + sz * 0.3, 0.01, 0.26, 0.01, { lod: 0 });
  p.top = Math.max(p.top, v.top + 0.27);
  p.roof(v, { tanks: 2, dish: 0, laundry: 0, stair: 0, solar: 0, ac: 0, mast: 0 });
  extras(p, v, { pipes: true });
};

const V_FRAME: Builder = (p) => {
  // an unfinished concrete frame: two finished storeys, a third of columns and slab with bars sticking out, brick infill
  const v = p.body({ x: 0, z: -0.02, lx: 1.3, dz: 1.05, floors: 2, parapet: 'none', c: 'conc', belt: true });
  p.door(v, 'f', -0.3, 'door', { awning: true });
  p.windows(v, 'f', { n: 3, skip: (f, i) => f === 0 && i === 0, pick: (f, i) => (p.h(420 + f + i) < 0.5 ? 'win_wide' : 'win') });
  allWindows(p, v, { front: false });
  const T = v.top;
  const fh = FLOOR;
  // a slab on top and the columns of the third storey
  p.box(0, T + 0.01, v.z, v.lx + 0.04, 0.02, v.dz + 0.04, 'conc', { bottom: true, mat: 2 });
  const xs = [-0.6, -0.2, 0.2, 0.6];
  for (const x of xs) for (const z of [v.z - v.dz / 2 + 0.05, v.z + v.dz / 2 - 0.05]) p.box(x, T + 0.02 + fh / 2 - 0.02, z, 0.08, fh - 0.0, 0.08, 'conc', { mat: 2 });
  // brick infill on the back and one side, the rest open
  p.box(0, T + 0.02 + fh * 0.4, v.z - v.dz / 2 + 0.05, 1.2, fh * 0.8, 0.07, 'brick', { mat: 1 });
  p.box(-0.6, T + 0.02 + fh * 0.4, v.z, 0.07, fh * 0.8, v.dz - 0.1, 'brick', { mat: 1 });
  p.box(0.2, T + 0.02 + fh * 0.35, v.z + v.dz / 2 - 0.05, 0.8, fh * 0.7, 0.07, 'brick', { mat: 1 });
  // the roof slab and its rebar
  p.box(0, T + 0.02 + fh + 0.012, v.z, v.lx + 0.08, 0.024, v.dz + 0.08, 'conc', { bottom: true, mat: 2 });
  for (const x of xs) for (const z of [v.z - v.dz / 2 + 0.05, v.z + v.dz / 2 - 0.05]) p.sw('rust', x, T + 0.02 + fh + 0.1, z, 0.008, 0.16, 0.008, { lod: 0 });
  p.wallTop = Math.max(p.wallTop, T + 0.02 + fh + 0.024);
  p.storeys = 3;
  // building materials: a stack of bricks and a heap of sand at the door
  for (let i = 0; i < 3; i++) p.sw('brick', 0.6 + (i % 2) * 0.01, 0.022 + i * 0.044, 0.7, 0.2, 0.04, 0.1);
  p.geo('wedge', 0.25, 0, 0.7, 0.4, 0.16, 0.3, 'sand', { mat: 3, ry: 0 });
  p.piece('tank', 0.1, T + 0.02 + fh + 0.024, -0.2, { a: 'tankc' });
  p.top = Math.max(p.top, T + 0.02 + fh + 0.2);
  p.note('rebar');
  extras(p, v, { pipes: true, ac: false });
};

const V_PENSION: Builder = (p) => {
  const v = p.body({ x: 0, z: -0.18, lx: 1.4, dz: 0.9, floors: 2, parapet: 'plain', c: p.h(430) < 0.5 ? 'wall' : 'wall2' });
  p.door(v, 'f', -0.45, 'door_arch', { lamp: true });
  p.windows(v, 'f', { n: 3, skip: (f, i) => f === 0 && i === 0, pick: (f, i) => (f === 0 ? 'win_arch' : p.h(431 + i) < 0.5 ? 'win_bifora' : 'win_arch') });
  p.sign(v, 'f', 0.2, FLOOR - 0.04, 0.3);
  // a thatch-roofed terrace in front: posts, a thatch slab, a bench
  const tz = v.z + v.dz / 2 + 0.22;
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) p.sw('wood', sx * 0.45 + 0.15, 0.17, tz + sz * 0.18, 0.03, 0.34, 0.03);
  p.sw('thatch', 0.15, 0.37, tz, 1.0, 0.05, 0.5, { rx: -0.0 });
  p.sw('thatch', 0.15, 0.4, tz, 0.9, 0.03, 0.42, {});
  p.sw('wood', 0.15, 0.06, tz + 0.1, 0.7, 0.05, 0.1);
  for (const x of [-0.1, 0.3]) p.piece('table', x, 0, tz - 0.05, { a: [0.2, 0.45, 0.6], lod: 0 });
  p.note('thatch');
  p.box(0, FLOOR + 0.0125, v.z + v.dz / 2 + 0.05, 1.4, 0.025, 0.1, 'wall', { bottom: true });
  allWindows(p, v, { front: false });
  p.roof(v, { tanks: 1, dish: 1, solar: 1, pergola: 0 });
  extras(p, v, { pipes: true });
};

const V_BAKERY: Builder = (p) => {
  const v = p.body({ x: 0, z: -0.05, lx: 1.4, dz: 1.15, floors: 1, fh: FLOOR * 1.05, parapet: 'plain' });
  p.put(v, 'f', -0.28, 0.135, 'shop', { sx: 0.95, p: 3, a: 'acc' });
  p.door(v, 'f', 0.42, 'door', { awning: true });
  p.sign(v, 'f', -0.28, v.top - 0.1, 0.4);
  p.awningOn(v, 'f', -0.28, 0.6, 0.28, 'acc2');
  allWindows(p, v, { front: false, backSkip: 0.2 });
  // the oven chimney: a tall square flue with a cap, a stack of firewood
  const cx = v.x + 0.45;
  const cz = v.z - 0.3;
  p.box(cx, v.top + 0.26, cz, 0.16, 0.52, 0.16, 'wall');
  p.box(cx, v.top + 0.53, cz, 0.2, 0.03, 0.2, 'trim');
  p.box(cx, v.top + 0.575, cz, 0.12, 0.06, 0.12, 'dark');
  p.top = Math.max(p.top, v.top + 0.6);
  p.note('chimney');
  for (let i = 0; i < 5; i++) p.sw('wood', 0.7, 0.025 + (i > 2 ? 0.045 : 0), -0.2 + (i % 3) * 0.07, 0.04, 0.04, 0.3, { ry: 1.57, lod: 0 });
  p.piece('pots', -0.55, 0, 0.62, { lod: 0 });
  p.roof(v, { tanks: 1, dish: 1 });
  extras(p, v, { pipes: true });
};

interface Variant {
  id: string;
  fn: Builder;
  /** Weight for a plain house, a shop-house (look 'shop'), per structure kind. */
  w: number;
  shop: number;
  mud: number;
  /** Storeys of the variant (for the report / the tests). */
  floors: number | [number, number];
  /** Can have a walled yard in front. */
  yard?: boolean;
}

export const VARIANTS: Variant[] = [
  { id: 'cube', fn: V_CUBE, w: 1.1, shop: 0.05, mud: 0.3, floors: [1, 2], yard: true },
  { id: 'shop', fn: V_SHOP, w: 0.2, shop: 1.2, mud: 0.1, floors: [2, 3] },
  { id: 'apt', fn: V_APT, w: 1.2, shop: 0.2, mud: 0.2, floors: [2, 3] },
  { id: 'tower', fn: V_TOWER, w: 0.7, shop: 0, mud: 0.6, floors: 3 },
  { id: 'stepped', fn: V_STEPPED, w: 0.8, shop: 0, mud: 0.4, floors: 2 },
  { id: 'loggia', fn: V_LOGGIA, w: 0.7, shop: 0.1, mud: 0.2, floors: 2 },
  { id: 'ell', fn: V_ELL, w: 0.8, shop: 0, mud: 0.3, floors: 3 },
  { id: 'dome', fn: V_DOME, w: 0.6, shop: 0, mud: 1.0, floors: 1 },
  { id: 'mud', fn: V_MUD, w: 0.7, shop: 0, mud: 2.4, floors: 1 },
  { id: 'cafe', fn: V_CAFE, w: 0.1, shop: 0.9, mud: 0.05, floors: 2 },
  { id: 'villa', fn: V_VILLA, w: 0.6, shop: 0, mud: 0.1, floors: 2 },
  { id: 'row', fn: V_ROW, w: 0.7, shop: 0, mud: 0.3, floors: [2, 3] },
  { id: 'outer', fn: V_OUTER, w: 0.8, shop: 0, mud: 0.7, floors: 2 },
  { id: 'frame', fn: V_FRAME, w: 0.5, shop: 0, mud: 0.1, floors: 3 },
  { id: 'pension', fn: V_PENSION, w: 0.5, shop: 0.3, mud: 0.05, floors: 2 },
  { id: 'bakery', fn: V_BAKERY, w: 0.2, shop: 0.7, mud: 0.2, floors: 1 },
];

// ------------------------------------------------------------------ 3 x 2 courtyard houses and the mosque

function buildCourt(p: P, which: 0 | 1 | 2) {
  if (which === 0) {
    // a row of arcaded shops under flat roofs of different heights, coloured awnings
    for (let i = 0; i < 3; i++) {
      const hw = p.h(60 + i) < 0.5 ? 1 : 2;
      const v = p.body({ x: -0.82 + i * 0.82, z: -0.05, lx: 0.8, dz: 1.2, floors: hw, c: i === 1 ? 'wall2' : 'wall' });
      p.put(v, 'f', 0, 0.135, 'shop', { sx: 0.62 / 0.5, sy: 0.9, p: 3, a: 'acc' });
      p.awningOn(v, 'f', 0, 0.62, 0.27, i % 2 ? 'awn' : 'acc2');
      p.sign(v, 'f', 0, 0.34, 0.3, (i * 3 + Math.floor(p.h(61) * 5)) % SIGN_COUNT);
      if (hw > 1) p.windows(v, 'f', { floors: [1], n: 2, pick: () => p.win('front', 1, i) });
      p.windows(v, 'l', { n: 1, pick: (f, _i) => (f === 0 ? 'vent' : 'win') });
      p.windows(v, 'b', { n: 2, pick: (f, j) => p.win('back', f, j) });
      p.roof(v, { tanks: i === 1 ? 1 : 0, dish: i === 2 ? 1 : 0, spare: 0.3 });
    }
    return;
  }
  if (which === 1) {
    // a courtyard house: a two-storey back wing and two low wings round a court with a pergola, a street wall with a gate
    const a = p.body({ x: 0, z: -0.62, lx: 2.6, dz: 0.7, floors: 2, parapet: 'plain' });
    p.windows(a, 'f', { n: 5, pick: (f, i) => p.win('front', f, i), floors: [0, 1] });
    p.windows(a, 'b', { n: 5, pick: (f, i) => p.win('back', f, i) });
    p.railing(a, 1);
    p.roof(a, { tanks: 2, dish: 1 });
    for (const sx of [-1, 1]) {
      const b = p.body({ x: sx, z: 0.2, lx: 0.62, dz: 0.72, floors: 1, c: sx > 0 ? 'wall2' : 'wall' });
      p.windows(b, sx > 0 ? 'l' : 'r', { n: 1, pick: () => p.win('side', 0, 0) });
      p.windows(b, 'f', { n: 1, pick: () => 'win_shut' });
      p.roof(b, { tanks: 0, laundry: sx > 0 ? 1 : 0, dish: 0 });
    }
    p.box(0, 0.13, 0.86, 1.38, 0.26, 0.06, 'wall');
    p.box(0, 0.266, 0.86, 1.39, 0.012, 0.075, 'trim');
    p.card('gate', 0.3, 0.13, 0.86 + 0.034, 0, { sx: 0.95, p: 3, a: 'door' });
    p.card('gate', 0.3, 0.13, 0.86 - 0.034, Math.PI, { sx: 0.95, p: 3, a: 'door' });
    p.pergola(-0.25, 0.3, 0.9, 0.7, 0);
    p.tree(0.42, 0.32, 0.17, 0.3);
    return;
  }
  // a walled villa: two storeys with a balcony and a dome, a garden wall with a gate
  const a = p.body({ x: 0, z: -0.4, lx: 2.2, dz: 0.66, floors: 2, parapet: 'plain' });
  p.windows(a, 'f', { n: 4, pick: (f, i) => p.win('front', f, i) });
  p.balcony(a, 'f', 0, 1.1, 1, { rail: 'iron' });
  p.windows(a, 'b', { n: 4, pick: (f, i) => p.win('back', f, i) });
  if (p.h(56) < 0.6) p.piece('dome', 0.7, a.top, -0.45, { s: [0.8, 0.8, 0.8], tint: p.h(57) < 0.5 ? 'wall' : 'trim' });
  else p.pergola(-0.5, -0.4, 0.7, 0.45, a.top);
  p.roof(a, { tanks: 1, dish: 1 });
  const b = p.body({ x: -0.86, z: 0.32, lx: 0.55, dz: 0.7, floors: 1, c: 'wall2' });
  p.door(b, 'f', 0, 'door', { awning: true });
  p.box(0.25, 0.13, 0.72, 1.65, 0.26, 0.06, 'wall');
  p.box(1.1, 0.13, 0.33, 0.06, 0.26, 0.8, 'wall');
  p.card('gate', 0.35, 0.13, 0.72 + 0.034, 0, { sx: 0.95, p: 3, a: 'door' });
  p.card('gate', 0.35, 0.13, 0.72 - 0.034, Math.PI, { sx: 0.95, p: 3, a: 'door' });
  if (p.h(250) < 0.6) p.tree(0.85, 0.35, 0.15, 0.28);
}

function buildMosque(p: P) {
  // the town mosque: a prayer hall with lattice windows under a crown of merlons, an arcaded portico, the big dome on
  // its windowed drum, two small domes, a walled forecourt with a gate and a fountain, the minaret
  const hx = -0.42;
  const hz = -0.28;
  const LX = 1.85;
  const DZ = 1.3;
  const HW = FLOOR * 1.4;
  const v = p.body({ x: hx, z: hz, lx: LX, dz: DZ, floors: 1, fh: HW, c: 'white', parapet: 'merlon', belt: false });
  p.box(hx, HW - 0.02, hz, LX + 0.02, 0.018, DZ + 0.02, 'trim');
  p.piece('mdome', hx, HW + 0.012 + 0.06, hz, { s: [0.46 / 0.44, 0.46 / 0.44, 0.46 / 0.44], tint: 'white' });
  p.top = Math.max(p.top, HW + 0.012 + 0.06 + 0.75);
  p.note('dome');
  for (const sx of [-1, 1]) {
    p.box(hx + sx * 0.72, HW + 0.09, 0.22, 0.3, 0.06, 0.3, 'white');
    p.piece('dome', hx + sx * 0.72, HW + 0.12, 0.22, { s: [0.52, 0.57, 0.52], tint: 'white' });
  }
  p.arcade(v, 'f', 0.0, 5, 0.3, 'white');
  for (const sx of [-1, 1]) for (const z of [-0.6, -0.15]) p.card('win_tall', hx + sx * (LX / 2 + 0.003), 0.3, z, (sx * Math.PI) / 2, { p: 1, tint: 'white', fl: 0 });
  for (const x of [-0.6, -0.2, 0.2, 0.6]) p.card('win_tall', hx + x, 0.3, hz - DZ / 2 - 0.003, Math.PI, { p: 1, tint: 'white', fl: 0 });
  // the forecourt
  p.box(-0.15, 0.1, 0.92, 2.3, 0.2, 0.05, 'white');
  p.box(-1.38, 0.1, 0.66, 0.05, 0.2, 0.55, 'white');
  for (let i = 0; i < 20; i++) if (Math.abs(-1.27 + i * 0.115 - hx) > 0.2) p.piece('merlon', -1.27 + i * 0.115, 0.2, 0.92, { s: [0.8, 0.8, 0.8], tint: 'white', lod: 0 });
  for (const sx of [-1, 1]) p.box(hx + sx * 0.17, 0.15, 0.92, 0.07, 0.3, 0.08, 'trim');
  p.card('gate', hx, 0.13, 0.92 + 0.029, 0, { p: 3, tint: 'white', a: [0.32, 0.22, 0.14], sx: 1 });
  p.card('gate', hx, 0.13, 0.92 - 0.029, Math.PI, { p: 3, tint: 'white', a: [0.32, 0.22, 0.14], sx: 1 });
  p.sw('stone', hx, 0.004, 0.64, 1.95, 0.008, 0.55, { col: [0.97, 0.92, 0.83] });
  p.geo('cyl', hx + 0.5, 0.03, 0.64, 0.26, 0.06, 0.26, 'white', { seg: 8 });
  p.sw('glass', hx + 0.5, 0.055, 0.64, 0.2, 0.004, 0.2, { col: [0.5, 0.75, 0.85], lod: 0 });
  p.piece('minaret', 1.08, 0, 0.42, { tint: 'white' });
  p.top = Math.max(p.top, 1.45);
  p.note('minaret');
  p.storeys = 1;
}

// ------------------------------------------------------------------ choosing and building

/** The plan of a structure on a 2 x 2 / 3 x 2 footprint: variant, palette, mirror, wear, height, openings. */
export function planBuilding(st: Structure, town: 0 | 1 | 2 = 2): BuildingPlan {
  const p = new P(st, town);
  if (st.kind === StructureKind.Courtyard) {
    if (st.look === 'mosque') {
      buildMosque(p);
      return p.finish('mosque', VARIANTS.length + 3);
    }
    const t = p.h(55);
    const which: 0 | 1 | 2 = st.look === 'shops' || t < 0.3 ? 0 : t < 0.65 ? 1 : 2;
    buildCourt(p, which);
    return p.finish(['court-shops', 'court-house', 'court-villa'][which], VARIANTS.length + which);
  }
  const shop = st.look === 'shop';
  const mud = st.kind === StructureKind.MudHouse;
  const ws = VARIANTS.map((v) => (shop ? v.shop : v.w) * (mud ? 0.35 + v.mud : 1));
  const vi = pick(p.h(58), ws);
  const v = VARIANTS[vi];
  // many town houses stand in a walled yard on the street side (the old yard walls)
  if (v.yard && p.h(90) < 0.5 && !shop) p.yard({ x0: -0.93, x1: 0.93, z0: -0.93, z1: 0.93 });
  v.fn(p);
  return p.finish(v.id, vi);
}

/** Variant id and storeys of a structure without building ops (for tests / reports). */
export function variantOf(st: Structure, town: 0 | 1 | 2 = 2): { id: string; silhouette: number } {
  const p = planBuilding(st, town);
  return { id: p.variant, silhouette: p.silhouette };
}
