import { StructureKind, Tile, WATER_LEVEL, groundHeight, type GameMap, type Structure } from '../sim/map';
import { hash2 } from '../sim/rng';
import type { BiomeLook } from './biome';
import { FieldType, type Layout } from './layout';
import { cityHeight, isCityKind } from './models/citybldgs';
import { reliefHeight } from './relief';
import { Species, type TreeSpot } from './treekinds';

/*
 * The minimap's recon photo: a top-down picture of the battlefield baked once
 * at load (Terrain.steps, in row bands, so it adds no long task), composed in
 * 2D from the same data the 3D terrain is painted from:
 *  - the ground: the splat / tint / grass control maps of ground.ts and the
 *    biome's layer colours (grass palette, soil, rock, sand, mud, forest
 *    floor, gravel, the winter's painted snow), with a little photo grain;
 *  - hillshade from the relief (relief.ts: the sim's heights plus the real
 *    cliffs on the rock), sun from the north-west;
 *  - water by depth below the water line (shallows -> deep), shore foam, the
 *    winter's ice rims;
 *  - farm fields with their rows, city squares and streets (layout fields),
 *    hedges, roads with their markings, bridges with their shadow on the water;
 *  - village houses (the 3D roof colours, gabled roofs lit / shaded), city
 *    blocks (flat roofs, parapets, roof clutter), each with its cast shadow;
 *  - tree canopies per species (conifer stars, palm fronds, snow on the
 *    winter crowns) over their shadows.
 * A second, half resolution layer holds the night lights (lit windows, street
 * lamps), added by the HUD after dark.
 *
 * Changes after the bake are partial re-bakes of a small rectangle: a bridge
 * that collapses (or is rebuilt) and the ruins of destroyed buildings.
 * Everything is a pure function of the map (plus those changes), with no
 * DOM needed (tests run it in node); the canvases are made at the end when a
 * document exists. Memory: the photo canvas (S = 5 px per tile: 480 x 480
 * on a 96 x 96 map, 0.9 MB) and the lights (240 x 240, 0.23 MB).
 */

/** Photo pixels per tile (the minimap shows ~2.6 canvas px per tile: 2x supersampled). */
export const MINIMAP_S = 5;
/** Night light pixels per tile (soft glows: half resolution is plenty). */
export const MINIMAP_LS = 3;
/** Size cap of the baked layers (bytes, RGBA): the S above shrinks on a huge map rather than exceed it. */
export const MINIMAP_MAX_BYTES = 1.5 * 1024 * 1024;

/** The ground's painted control maps (ground.ts). */
export interface GroundMaps {
  splat: Uint8Array;
  tint: Uint8Array;
  ctl: Uint8Array;
  ctl2: Uint8Array;
  res: number;
}

export interface MinimapInputs {
  map: GameMap;
  layout: Layout;
  look: BiomeLook;
  ground: GroundMaps;
  trees: readonly TreeSpot[];
}

/** An RGBA pixel rectangle (ImageData-compatible). */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const rgb = (v: number): [number, number, number] => [(v >> 16) & 255, (v >> 8) & 255, v & 255];
/** The ground's tint (0..1, 0.5 = neutral) as a colour factor: (2 t) ^ 0.7. */
const TINT_LUT = Float32Array.from({ length: 1024 }, (_, i) => Math.pow(((i + 0.5) / 1024) * 2, 0.7));
const setMul = (o: number[], a: ArrayLike<number>, k: number) => {
  o[0] = a[0] * k;
  o[1] = a[1] * k;
  o[2] = a[2] * k;
};
const setMix = (o: number[], a: ArrayLike<number>, b: ArrayLike<number>, t: number) => {
  o[0] = a[0] + (b[0] - a[0]) * t;
  o[1] = a[1] + (b[1] - a[1]) * t;
  o[2] = a[2] + (b[2] - a[2]) * t;
};
const hit = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/** HSL (0..1) -> sRGB 0..255. */
function hsl(h: number, s: number, l: number): [number, number, number] {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return v * 255;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

// sun from the north-west (tile space: x east, y south), ~48 degrees high
const SUN = (() => {
  const v = [-1, -1, 1.6];
  const l = Math.hypot(v[0], v[1], v[2]);
  return v.map((c) => c / l);
})();
/** Cast shadow offset per unit of height (towards the south-east). */
const SHADOW_K = 0.42;
/** Deck width of a bridge (bridgefx.ts). */
const DECK_W = 2.1;
/** Daylight grade per biome code (r, g, b multipliers, saturation). */
const GRADE: [number, number, number, number][] = [
  [1.05, 0.97, 0.84, 0.9],
  [1.02, 0.96, 0.86, 0.95],
  [0.94, 0.97, 1.04, 0.9],
  [1.0, 0.99, 0.97, 0.9],
];
/** Grass tone per biome code: the photoscanned meadow reads olive in the summer sun (the art palette is greener). */
const GRASS_TONE: [number, number, number][] = [
  [1.34, 0.95, 0.52],
  [1, 1, 1],
  [1, 1, 1],
  [1.0, 1.0, 0.85],
];

// village roofs (scenery.ts: the same hash picks the same colour as the 3D house)
const ROOFS = [0xa04a30, 0x8a3c28, 0xb0603a, 0x5a5652, 0x6e3a2c, 0x8f5a3a];
const ROOFS_WINTER = [0x3a3a3c, 0x2e3a30, 0x4a3a30, 0x34383e];
const WALLS_DESERT = [0xd8b98c, 0xe2c9a0, 0xc9a378, 0xe8d6b4, 0xcfae84, 0xbf9a70];
const ASPHALT: [number, number, number] = [86, 85, 82];
const MARKING: [number, number, number] = [226, 220, 196];
const CENTRE_YELLOW: [number, number, number] = [214, 176, 64];
const SNOW_PACKED: [number, number, number] = [200, 206, 216];

interface TreeItem extends Box {
  x: number;
  y: number;
  r: number;
  sp: Species;
  col: [number, number, number];
  rot: number;
}
interface StructItem extends Box {
  st: Structure;
  idx: number;
  /** Footprint (tile space). */
  fx0: number;
  fy0: number;
  fx1: number;
  fy1: number;
  h: number;
}
interface SegItem extends Box {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Half width; kind 0 highway, 1 country road, 2 hedge, 3 fence. */
  hw: number;
  kind: number;
  /** Arc length at a (for dashed markings). */
  arc: number;
}
interface FieldItem extends Box {
  cx: number;
  cy: number;
  hl: number;
  hw: number;
  ca: number;
  sa: number;
  type: FieldType;
}
interface BridgeItem extends Box {
  idx: number;
  cx: number;
  cy: number;
  dx: number;
  dy: number;
  half: number;
}
interface LightItem extends Box {
  x: number;
  y: number;
  r: number;
  c: [number, number, number];
  /** Owning structure (lights go out with a ruin), -1 none. */
  st: number;
}

export class MinimapBake {
  /** Photo pixels per tile, and the photo size. */
  readonly S: number;
  readonly W: number;
  readonly H: number;
  /** Night light pixels per tile, and that layer's size. */
  readonly LS: number;
  readonly LW: number;
  readonly LH: number;
  /** The photo / the night lights (made once a document exists; null in node). */
  canvas: HTMLCanvasElement | null = null;
  lights: HTMLCanvasElement | null = null;
  /** The raw layers (kept only without a DOM: tests read them). */
  pixels: Uint8ClampedArray | null = null;
  lightPixels: Uint8ClampedArray | null = null;
  /** Bumped by every change (full bake, partial re-bakes). */
  version = 0;
  /** Done baking. */
  ready = false;
  /** Longest single band (ms) of the last bake, and the whole bake. */
  worstSliceMs = 0;
  totalMs = 0;
  /** Partial re-bakes done (tests / stats). */
  rebakes = 0;

  private readonly m: GameMap;
  private readonly look: BiomeLook;
  private readonly g: GroundMaps;
  private readonly wetNear: Uint8Array;
  private readonly trees: TreeItem[] = [];
  private readonly structs: StructItem[] = [];
  private readonly segs: SegItem[] = [];
  private readonly fields: FieldItem[] = [];
  private readonly bridges: BridgeItem[] = [];
  private readonly lamps: LightItem[] = [];
  private readonly ruins: Box[] = [];
  private readonly ruined: Uint8Array;
  private readonly bridgeDown: Uint8Array;
  // biome colours (sRGB 0..255)
  private readonly C: Record<string, [number, number, number]>;
  /** Grass palette (0..1 sRGB): lush, mid, dry (grasstex.ts grassRGB). */
  private readonly grassPal: number[];
  /** Scratch of the rectangle being rendered: the winter's painted snow cover per pixel. */
  private snow: Float32Array<ArrayBufferLike> = new Float32Array(0);
  /** Reused scratch buffers of the band renderer (no garbage per band). */
  private readonly scratch: Float32Array[] = [];
  private f32(slot: number, n: number, fill = 0): Float32Array {
    let a = this.scratch[slot];
    if (!a || a.length < n) a = this.scratch[slot] = new Float32Array(n);
    return a.subarray(0, n).fill(fill);
  }

  constructor(inp: MinimapInputs, S = MINIMAP_S) {
    const m = (this.m = inp.map);
    this.look = inp.look;
    this.g = inp.ground;
    // never more than the cap (a much larger map gets fewer pixels per tile)
    const ls = (s: number) => Math.max(1, Math.min(MINIMAP_LS, Math.ceil(s / 2)));
    while (S > 1 && m.w * m.h * (S * S + ls(S) * ls(S)) * 4 > MINIMAP_MAX_BYTES) S--;
    this.S = S;
    this.W = m.w * S;
    this.H = m.h * S;
    this.LS = Math.max(1, Math.min(MINIMAP_LS, Math.ceil(S / 2)));
    this.LW = m.w * this.LS;
    this.LH = m.h * this.LS;
    this.ruined = new Uint8Array(m.structures.length);
    this.bridgeDown = new Uint8Array(m.bridges.length);
    const lk = inp.look.ground;
    const gp = inp.look.grass;
    this.grassPal = [...rgb(gp.lush), ...rgb(gp.mid), ...rgb(gp.dry)].map((v) => v / 255);
    const lift = (c: [number, number, number], k = 1.06): [number, number, number] => [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)];
    this.C = {
      dirt: lift(rgb(lk.dirt)),
      rock: lift(rgb(lk.rock)),
      sand: lift(rgb(lk.sand)),
      mud: lift(rgb(lk.mud)),
      soil: rgb(lk.soil),
      crop: rgb(lk.crop),
      wheat: rgb(lk.wheat),
      hay: rgb(lk.hay),
      forest: rgb(lk.forest ?? lk.dirt),
      gravel: rgb(lk.gravel ?? lk.dirt),
      snow: lift(rgb(lk.snow ?? 0xd6deec), 1.02),
      paving: rgb(lk.paving ?? 0xb4aea4),
      clover: rgb(inp.look.grass.clover),
      water: inp.look.mini.water,
    };
    // tiles next to water (the water surface only shows there: no puddles in inland hollows)
    const W = m.w;
    const wet = (this.wetNear = new Uint8Array(W * m.h));
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < W; x++) {
        let n = 0;
        for (let j = -2; j <= 2 && !n; j++)
          for (let i = -2; i <= 2 && !n; i++) {
            const xx = x + i;
            const yy = y + j;
            if (xx >= 0 && yy >= 0 && xx < W && yy < m.h && (m.tiles[yy * W + xx] === Tile.Water || m.tiles[yy * W + xx] === Tile.Bridge)) n = 1;
          }
        wet[y * W + x] = n;
      }
    this.collect(inp);
  }

  // ---------------------------------------------------------------- items

  private collect(inp: MinimapInputs) {
    const { map: m, layout: L } = inp;
    const code = this.look.code;
    // trees: canopy colour per species (trees.ts treeTint hues, darkened to what the crowns read as from above)
    for (const t of inp.trees) {
      const r = (([0.36, 0.32, 0.44, 0.3, 0.28, 0.2, 0.44, 0.36, 0.42, 0.48][t.species] ?? 0.3) * t.s) * 1.18;
      const r1 = hash2(Math.floor(t.x * 31), Math.floor(t.y * 37), 5);
      const r2 = hash2(Math.floor(t.x * 41), Math.floor(t.y * 43), 6);
      let col: [number, number, number];
      switch (t.species) {
        case Species.Spruce:
          col = hsl(0.36 + r1 * 0.04, 0.3 + r2 * 0.1, 0.17 + r2 * 0.04);
          break;
        case Species.Pine:
          col = hsl(0.3 + r1 * 0.05, 0.28 + r2 * 0.08, 0.2 + r2 * 0.04);
          break;
        case Species.Birch:
          col = hsl(0.21 + r1 * 0.04, 0.42 + r2 * 0.1, 0.3 + r2 * 0.05);
          break;
        case Species.Palm:
          col = hsl(0.19 + r1 * 0.05, 0.36 + r2 * 0.1, 0.27 + r2 * 0.05);
          break;
        case Species.Acacia:
          col = hsl(0.18 + r1 * 0.04, 0.3 + r2 * 0.08, 0.25 + r2 * 0.05);
          break;
        default:
          col = r2 < 0.06 ? hsl(0.1 + r1 * 0.04, 0.45, 0.3) : hsl(0.24 + r1 * 0.06, 0.4 + r2 * 0.12, 0.22 + r2 * 0.06);
      }
      const reach = r * (1 + 2 * SHADOW_K) + 0.2;
      this.trees.push({ x: t.x, y: t.y, r, sp: t.species, col, rot: t.rot, x0: t.x - r - 0.1, y0: t.y - r - 0.1, x1: t.x + reach, y1: t.y + reach });
    }
    // structures (village houses, city blocks)
    m.structures.forEach((st, idx) => {
      const h = isCityKind(st.kind) ? cityHeight(st.kind) : st.kind === StructureKind.Tower ? 2 : st.kind === StructureKind.Silo || st.kind === StructureKind.WaterTower ? 1.6 : st.kind === StructureKind.Barn ? 1.15 : 0.9;
      const inset = isCityKind(st.kind) ? 0.06 : 0.14;
      const it: StructItem = { st, idx, h, fx0: st.x + inset, fy0: st.y + inset, fx1: st.x + st.w - inset, fy1: st.y + st.h - inset, x0: 0, y0: 0, x1: 0, y1: 0 };
      it.x0 = it.fx0 - 0.2;
      it.y0 = it.fy0 - 0.2;
      it.x1 = it.fx1 + h * SHADOW_K + 0.3;
      it.y1 = it.fy1 + h * SHADOW_K + 0.3;
      this.structs.push(it);
    });
    // roads, hedges and fences as segments
    const addLine = (pts: { x: number; y: number }[], hw: number, kind: number) => {
      let arc = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const pad = hw + 0.3;
        this.segs.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, hw, kind, arc, x0: Math.min(a.x, b.x) - pad, y0: Math.min(a.y, b.y) - pad, x1: Math.max(a.x, b.x) + pad + 0.3, y1: Math.max(a.y, b.y) + pad + 0.3 });
        arc += Math.hypot(b.x - a.x, b.y - a.y);
      }
    };
    for (const r of L.roads) addLine(r.pts, r.width / 2, r.variant === 0 ? 0 : 1);
    for (const e of L.edges) addLine([e.a, e.b], e.kind === 'hedge' ? 0.16 : 0.05, e.kind === 'hedge' ? 2 : 3);
    // fields, city squares and streets
    for (const f of L.fields) {
      // (the rotated rectangle's own bounds: the city's streets are long and thin)
      const ca = Math.cos(f.angle);
      const sa = Math.sin(f.angle);
      const ex = Math.abs(ca) * f.hl + Math.abs(sa) * f.hw + 0.2;
      const ey = Math.abs(sa) * f.hl + Math.abs(ca) * f.hw + 0.2;
      this.fields.push({ cx: f.cx, cy: f.cy, hl: f.hl, hw: f.hw, ca, sa, type: f.type, x0: f.cx - ex, y0: f.cy - ey, x1: f.cx + ex, y1: f.cy + ey });
    }
    // bridges (sim/bridges.ts geometry)
    m.bridges.forEach((b, idx) => {
      const dx = Math.cos(b.angle);
      const dy = Math.sin(b.angle);
      const half = b.length / 2 + 0.35;
      const R = half + DECK_W;
      this.bridges.push({ idx, cx: b.x, cy: b.y, dx, dy, half, x0: b.x - R, y0: b.y - R, x1: b.x + R + 0.6, y1: b.y + R + 0.6 });
    });
    // night lights: windows of the houses and blocks, street lamps in the towns
    const warm: [number, number, number] = [255, 178, 96];
    const cool: [number, number, number] = [190, 214, 255];
    const sodium: [number, number, number] = [255, 160, 70];
    const lamp = (x: number, y: number, r: number, c: [number, number, number], st: number) => this.lamps.push({ x, y, r, c, st, x0: x - r, y0: y - r, x1: x + r, y1: y + r });
    m.structures.forEach((st, idx) => {
      const city = isCityKind(st.kind);
      const n = city ? Math.max(2, Math.round(st.w * st.h * 1.4)) : st.kind === StructureKind.Barn || st.kind === StructureKind.Silo || st.kind === StructureKind.WaterTower ? 0 : 1 + (hash2(st.x, st.y, 17) < 0.5 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const u = hash2(st.x * 3 + k, st.y * 5, 19);
        const v = hash2(st.x * 7, st.y * 11 + k, 23);
        if (city && hash2(st.x + k * 13, st.y, 29) < 0.35) continue; // dark windows
        lamp(st.x + 0.2 + u * (st.w - 0.4), st.y + 0.2 + v * (st.h - 0.4), city ? 0.45 : 0.55, city && hash2(k, st.x + st.y, 31) < 0.3 ? cool : warm, idx);
      }
    });
    const towns = m.structures.map((s) => ({ x: s.x + s.w / 2, y: s.y + s.h / 2 }));
    const lit = (x: number, y: number) => code === 3 || towns.some((t) => Math.abs(t.x - x) < 5 && Math.abs(t.y - y) < 5);
    for (const r of L.roads) {
      let acc = 1;
      let side = 1;
      for (let i = 0; i < r.pts.length - 1; i++) {
        const a = r.pts[i];
        const b = r.pts[i + 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        acc += len;
        if (acc < 2.6 || len < 1e-6) continue;
        acc = 0;
        side = -side;
        const nx = (-(b.y - a.y) / len) * side * (r.width / 2 + 0.15);
        const ny = ((b.x - a.x) / len) * side * (r.width / 2 + 0.15);
        const x = a.x + nx;
        const y = a.y + ny;
        if (x < 0 || y < 0 || x >= m.w || y >= m.h || !lit(x, y)) continue;
        if (this.wetNear[Math.floor(y) * m.w + Math.floor(x)] && groundHeight(m, x, y) < WATER_LEVEL + 0.05) continue;
        lamp(x, y, 0.7, sodium, -1);
      }
    }
  }

  // ---------------------------------------------------------------- bake

  /** The full bake, one band of rows per yield (Terrain.steps runs it in time slices). */
  *steps(rows = 10): Generator<void> {
    const t0 = now();
    this.worstSliceMs = 0;
    const photo = new Uint8ClampedArray(this.W * this.H * 4);
    const light = new Uint8ClampedArray(this.LW * this.LH * 4);
    for (let y = 0; y < this.H; y += rows) {
      const s0 = now();
      const r = this.renderPhoto(0, y, this.W, Math.min(rows, this.H - y));
      photo.set(r.data, y * this.W * 4);
      this.worstSliceMs = Math.max(this.worstSliceMs, now() - s0);
      yield;
    }
    const s0 = now();
    const lr = this.renderLights(0, 0, this.LW, this.LH);
    light.set(lr.data);
    this.worstSliceMs = Math.max(this.worstSliceMs, now() - s0);
    yield;
    const s1 = now();
    this.canvas = toCanvas(photo, this.W, this.H);
    this.lights = toCanvas(light, this.LW, this.LH);
    // the canvases hold the pixels from here on (node / tests: keep the arrays)
    this.pixels = this.canvas ? null : photo;
    this.lightPixels = this.lights ? null : light;
    this.worstSliceMs = Math.max(this.worstSliceMs, now() - s1);
    this.totalMs = now() - t0;
    this.ready = true;
    this.version++;
  }

  /** Bytes held by the baked layers. */
  bytes(): number {
    return (this.W * this.H + this.LW * this.LH) * 4;
  }

  /** Bridge `idx` collapsed (true) or standing again: re-bake its patch. Returns whether anything changed. */
  setBridgeDown(idx: number, down: boolean): boolean {
    if (idx < 0 || idx >= this.bridgeDown.length || !!this.bridgeDown[idx] === down) return false;
    this.bridgeDown[idx] = down ? 1 : 0;
    const b = this.bridges[idx];
    this.rebake(b);
    return true;
  }

  isBridgeDown(idx: number): boolean {
    return !!this.bridgeDown[idx];
  }

  /**
   * A building destroyed at centre (x, y) with a w x h tile footprint (a base structure, a village house or a
   * city block): its ruin goes into the photo, a village house / block standing there goes (lights too).
   */
  ruin(x: number, y: number, w: number, h: number) {
    const r: Box = { x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 };
    if (this.ruins.some((o) => Math.abs(o.x0 - r.x0) < 0.01 && Math.abs(o.y0 - r.y0) < 0.01 && Math.abs(o.x1 - r.x1) < 0.01)) return;
    this.ruins.push(r);
    for (const s of this.structs) {
      const st = s.st;
      const ix = Math.min(r.x1, st.x + st.w) - Math.max(r.x0, st.x);
      const iy = Math.min(r.y1, st.y + st.h) - Math.max(r.y0, st.y);
      if (ix > 0 && iy > 0 && ix * iy >= st.w * st.h * 0.5) this.ruined[s.idx] = 1;
    }
    this.rebake({ x0: r.x0 - 1, y0: r.y0 - 1, x1: r.x1 + 2.5, y1: r.y1 + 2.5 });
  }

  /** Re-bake a tile-space rectangle into the layers (a few ms: bridges and ruins only). */
  private rebake(b: Box) {
    if (!this.ready) return;
    const S = this.S;
    const px0 = Math.max(0, Math.floor(b.x0 * S));
    const py0 = Math.max(0, Math.floor(b.y0 * S));
    const px1 = Math.min(this.W, Math.ceil(b.x1 * S));
    const py1 = Math.min(this.H, Math.ceil(b.y1 * S));
    if (px1 <= px0 || py1 <= py0) return;
    const r = this.renderPhoto(px0, py0, px1 - px0, py1 - py0);
    const LS = this.LS;
    const lx0 = Math.max(0, Math.floor(b.x0 * LS));
    const ly0 = Math.max(0, Math.floor(b.y0 * LS));
    const lx1 = Math.min(this.LW, Math.ceil(b.x1 * LS));
    const ly1 = Math.min(this.LH, Math.ceil(b.y1 * LS));
    const l = lx1 > lx0 && ly1 > ly0 ? this.renderLights(lx0, ly0, lx1 - lx0, ly1 - ly0) : null;
    put(this.canvas, this.pixels, this.W, r);
    if (l) put(this.lights, this.lightPixels, this.LW, l);
    this.rebakes++;
    this.version++;
  }

  // ---------------------------------------------------------------- photo

  /** Render the photo pixels of a rectangle (pixel space) from scratch. */
  renderPhoto(px0: number, py0: number, pw: number, ph: number): PixelRect {
    const { m, g, S, C, look } = this;
    const out = new Uint8ClampedArray(pw * ph * 4);
    const col = this.f32(0, pw * ph * 3);
    const water = this.f32(1, pw * ph, -1); // depth below the water line (> 0: water)
    const snow = (this.snow = this.f32(2, pw * ph));
    const box: Box = { x0: px0 / S, y0: py0 / S, x1: (px0 + pw) / S, y1: (py0 + ph) / S };
    // heights at the pixel centres, one pixel of padding all round (hillshade gradients)
    const HW = pw + 2;
    const hb = this.f32(3, HW * (ph + 2));
    for (let j = 0; j < ph + 2; j++)
      for (let i = 0; i < HW; i++) {
        const x = Math.max(0.01, Math.min(m.w - 0.01, (px0 + i - 1 + 0.5) / S));
        const y = Math.max(0.01, Math.min(m.h - 0.01, (py0 + j - 1 + 0.5) / S));
        hb[j * HW + i] = reliefHeight(m, x, y);
      }
    // ---- ground
    const N = m.w * g.res;
    const code = look.code;
    const { splat, tint, ctl, ctl2 } = g;
    const gl = this.grassPal;
    const tone = GRASS_TONE[code] ?? GRASS_TONE[1];
    const cDirt = C.dirt;
    const cRock = C.rock;
    const cSand = C.sand;
    const cMud = C.mud;
    const cFo = C.forest;
    const cGv = C.gravel;
    const cCl = C.clover;
    const cSnow = C.snow;
    for (let j = 0; j < ph; j++) {
      const y = (py0 + j + 0.5) / S;
      // bilinear taps into the control maps (texel centres at (i + 0.5) / res)
      const gyf = Math.max(0, Math.min(N - 1.001, y * g.res - 0.5));
      const gy = Math.floor(gyf);
      const fy = gyf - gy;
      const ty = Math.min(m.h - 1, Math.floor(y));
      for (let i = 0; i < pw; i++) {
        const x = (px0 + i + 0.5) / S;
        const gxf = Math.max(0, Math.min(N - 1.001, x * g.res - 0.5));
        const gx = Math.floor(gxf);
        const fx = gxf - gx;
        const a = (gy * N + gx) * 4;
        const b = a + 4;
        const c = a + N * 4;
        const d = c + 4;
        const w00 = ((1 - fx) * (1 - fy)) / 255;
        const w10 = (fx * (1 - fy)) / 255;
        const w01 = ((1 - fx) * fy) / 255;
        const w11 = (fx * fy) / 255;
        const d0 = splat[a] * w00 + splat[b] * w10 + splat[c] * w01 + splat[d] * w11;
        const r0 = splat[a + 1] * w00 + splat[b + 1] * w10 + splat[c + 1] * w01 + splat[d + 1] * w11;
        const s0 = splat[a + 2] * w00 + splat[b + 2] * w10 + splat[c + 2] * w01 + splat[d + 2] * w11;
        const m0 = splat[a + 3] * w00 + splat[b + 3] * w10 + splat[c + 3] * w01 + splat[d + 3] * w11;
        const wg = Math.max(0, 1 - d0 - r0 - s0 - m0);
        const lush = ctl[a] * w00 + ctl[b] * w10 + ctl[c] * w01 + ctl[d] * w11;
        const cl = (ctl[a + 1] * w00 + ctl[b + 1] * w10 + ctl[c + 1] * w01 + ctl[d + 1] * w11) * 0.35;
        const worn = (ctl[a + 3] * w00 + ctl[b + 3] * w10 + ctl[c + 3] * w01 + ctl[d + 3] * w11) * wg * 0.25;
        const dry = tint[a + 3] * w00 + tint[b + 3] * w10 + tint[c + 3] * w01 + tint[d + 3] * w11;
        // dirt splits into forest floor and gravel (photo layers)
        const fo = ctl2[a] * w00 + ctl2[b] * w10 + ctl2[c] * w01 + ctl2[d] * w11;
        const gv = ctl2[a + 1] * w00 + ctl2[b + 1] * w10 + ctl2[c + 1] * w01 + ctl2[d + 1] * w11;
        const o = (j * pw + i) * 3;
        for (let k = 0; k < 3; k++) {
          // grass (grasstex.ts grassRGB), clover patches a touch darker / bluer
          const mid = gl[3 + k] + (gl[k] - gl[3 + k]) * lush;
          let grass = (mid + (gl[6 + k] - mid) * dry) * 260 * tone[k];
          grass += (cCl[k] - grass) * cl;
          let dirt = cDirt[k];
          dirt += (cFo[k] - dirt) * fo;
          dirt += (cGv[k] - dirt) * gv;
          let v = grass * wg + dirt * d0 + cRock[k] * r0 + cSand[k] * s0 + cMud[k] * m0;
          // worn paths / yards: bare soil showing through the turf
          v += (cDirt[k] - v) * worn;
          // the painted tint: macro brightness, wetness, shade under the trees, ore stain
          const t = tint[a + k] * w00 + tint[b + k] * w10 + tint[c + k] * w01 + tint[d + k] * w11;
          col[o + k] = v * TINT_LUT[Math.min(1023, (t * 1024) | 0)];
        }
        // winter: the painted snow cover
        if (code === 2) {
          const sn = smooth(0.25, 0.65, ctl[a + 2] * w00 + ctl[b + 2] * w10 + ctl[c + 2] * w01 + ctl[d + 2] * w11);
          snow[j * pw + i] = sn;
          for (let k = 0; k < 3; k++) col[o + k] += (cSnow[k] - col[o + k]) * sn;
        }
        // water: depth below the water line next to the river / lake / canal tiles
        const tx = Math.min(m.w - 1, Math.floor(x));
        water[j * pw + i] = this.wetNear[ty * m.w + tx] ? WATER_LEVEL - groundHeight(m, x, y) : -1;
      }
    }
    // ---- fields, city squares and streets
    for (const f of this.fields) if (hit(f, box)) this.drawField(f, px0, py0, pw, ph, col, water);
    // ---- hedges, fences, roads
    this.drawLines(box, px0, py0, pw, ph, col, water);
    // ---- hillshade + grain (ground level), then the water over it
    const wc = C.water;
    const shallow = [wc[0] * 1.35 + 18, wc[1] * 1.3 + 14, wc[2] * 1.18 + 8];
    const deep = [wc[0] * 0.55, wc[1] * 0.62, wc[2] * 0.7];
    const iceK = look.iceK;
    for (let j = 0; j < ph; j++)
      for (let i = 0; i < pw; i++) {
        const o = (j * pw + i) * 3;
        const hi = (j + 1) * HW + i + 1;
        const dhx = ((hb[hi + 1] - hb[hi - 1]) * S) / 2;
        const dhy = ((hb[hi + HW] - hb[hi - HW]) * S) / 2;
        const ex = 1.6; // relief exaggeration: the map is mostly gentle
        const nx = -dhx * ex;
        const ny = -dhy * ex;
        const nl = Math.hypot(nx, ny, 1);
        const lam = (nx * SUN[0] + ny * SUN[1] + SUN[2]) / nl / SUN[2];
        const shade = 0.42 + 0.58 * Math.max(0.25, Math.min(1.45, lam));
        const n = (hash2(px0 + i, py0 + j, 71) - 0.5) * 0.07 + (hash2((px0 + i) >> 1, (py0 + j) >> 1, 73) - 0.5) * 0.05;
        const d = water[j * pw + i];
        if (d > 0) {
          // water: shallows over the bed to deep, foam on the shore, the winter's ice rims
          const t = smooth(0.0, 0.55, d);
          let r = shallow[0] + (deep[0] - shallow[0]) * t;
          let gg = shallow[1] + (deep[1] - shallow[1]) * t;
          let b = shallow[2] + (deep[2] - shallow[2]) * t;
          const ripple = 1 + (hash2((px0 + i) >> 1, py0 + j, 79) - 0.5) * 0.06;
          r *= ripple;
          gg *= ripple;
          b *= ripple;
          if (iceK > 1) {
            const ice = 1 - smooth(0.1 * iceK - 0.06, 0.1 * iceK + 0.06, d + (hash2((px0 + i) >> 2, (py0 + j) >> 2, 83) - 0.5) * 0.12);
            const crack = hash2(px0 + i, py0 + j, 89) < 0.04 ? 0.85 : 1;
            r += (198 * crack - r) * ice;
            gg += (212 * crack - gg) * ice;
            b += (226 * crack - b) * ice;
          }
          const foam = (1 - smooth(0.0, 0.06, d)) * (0.3 + hash2((px0 + i) >> 1, (py0 + j) >> 1, 97) * 0.25) * (iceK > 1 ? 0.4 : 1);
          col[o] = r + (205 - r) * foam;
          col[o + 1] = gg + (212 - gg) * foam;
          col[o + 2] = b + (206 - b) * foam;
          continue;
        }
        // damp dark band just above the water line
        const damp = d > -0.1 ? (1 - smooth(0, 0.1, -d)) * 0.2 : 0;
        const k = shade * (1 + n) * (1 - damp);
        col[o] *= k;
        col[o + 1] *= k;
        col[o + 2] *= k;
      }
    // ---- bridges (deck and its shadow on the water; stubs and debris once down)
    for (const b of this.bridges) if (hit(b, box)) this.drawBridge(b, px0, py0, pw, ph, col);
    // ---- structures: shadows, then roofs; ruins
    for (const s of this.structs) if (hit(s, box) && !this.ruined[s.idx]) this.drawShadowBox(s.fx0, s.fy0, s.fx1, s.fy1, s.h * SHADOW_K, px0, py0, pw, ph, col, 0.55);
    for (const s of this.structs) if (hit(s, box) && !this.ruined[s.idx]) this.drawRoof(s, px0, py0, pw, ph, col);
    for (const r of this.ruins) if (hit({ x0: r.x0 - 0.6, y0: r.y0 - 0.6, x1: r.x1 + 0.6, y1: r.y1 + 0.6 }, box)) this.drawRuin(r, px0, py0, pw, ph, col);
    // ---- trees: all shadows first, then the crowns
    const tl: TreeItem[] = [];
    for (const t of this.trees) if (hit(t, box)) tl.push(t);
    for (const t of tl) this.drawTreeShadow(t, px0, py0, pw, ph, col);
    for (const t of tl) this.drawCanopy(t, px0, py0, pw, ph, col);
    // ---- grade: the biome's daylight (the 3D ground reads olive in the summer sun, cool blue-grey in the
    // snow), a little haze lifting the blacks, like a recon photo
    const gr = GRADE[look.code] ?? GRADE[0];
    for (let p = 0, q = 0; p < pw * ph; p++, q += 3) {
      const r = col[q] * gr[0];
      const gg = col[q + 1] * gr[1];
      const b = col[q + 2] * gr[2];
      const l = r * 0.3 + gg * 0.59 + b * 0.11;
      const sat = gr[3];
      out[p * 4] = (l + (r - l) * sat) * 0.97 + 6;
      out[p * 4 + 1] = (l + (gg - l) * sat) * 0.97 + 7;
      out[p * 4 + 2] = (l + (b - l) * sat) * 0.97 + 9;
      out[p * 4 + 3] = 255;
    }
    return { x: px0, y: py0, width: pw, height: ph, data: out };
  }

  /** Pixel loop over the bounding box of a tile-space box, clipped to the rect. */
  private span(b: Box, px0: number, py0: number, pw: number, ph: number, fn: (i: number, j: number, x: number, y: number) => void) {
    const S = this.S;
    const i0 = Math.max(0, Math.floor(b.x0 * S) - px0);
    const i1 = Math.min(pw, Math.ceil(b.x1 * S) - px0);
    const j0 = Math.max(0, Math.floor(b.y0 * S) - py0);
    const j1 = Math.min(ph, Math.ceil(b.y1 * S) - py0);
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) fn(i, j, (px0 + i + 0.5) / S, (py0 + j + 0.5) / S);
  }

  private drawField(f: FieldItem, px0: number, py0: number, pw: number, ph: number, col: Float32Array, water: Float32Array) {
    const { C, S } = this;
    const city = f.type >= FieldType.Plaza;
    const winter = this.look.code === 2;
    const c = [0, 0, 0];
    this.span(f, px0, py0, pw, ph, (i, j, x, y) => {
      if (water[j * pw + i] > 0) return;
      const px = x - f.cx;
      const py = y - f.cy;
      const a = px * f.ca + py * f.sa;
      const b = -px * f.sa + py * f.ca;
      const qx = Math.abs(a) - f.hl;
      const qy = Math.abs(b) - f.hw;
      const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
      const cov = clamp01(0.5 - sd * S);
      if (cov <= 0) return;
      // rows across b (0.45 tiles apart), a little noise
      const row = 0.5 + 0.5 * Math.sin((b / 0.45) * Math.PI * 2);
      const nz = hash2(Math.floor(x * 9), Math.floor(y * 9), 101) - 0.5;
      let k = 0.9;
      switch (f.type) {
        case FieldType.Plowed:
          setMul(c, C.soil, 0.82 + row * 0.26 + nz * 0.06);
          break;
        case FieldType.Green:
          setMix(c, C.soil, C.crop, 0.45 + row * 0.5 + nz * 0.1);
          break;
        case FieldType.Wheat:
          setMul(c, C.wheat, 0.9 + row * 0.12 + nz * 0.08);
          break;
        case FieldType.Fallow:
          setMix(c, C.hay, C.soil, clamp01(0.3 + nz * 1.4));
          break;
        case FieldType.Plaza: {
          // stone flags: joints every 0.5 tile
          const jx = Math.abs(((x * 2) % 1) - 0.5) > 0.44 || Math.abs(((y * 2) % 1) - 0.5) > 0.44;
          setMul(c, C.paving, jx ? 0.86 : 0.98 + nz * 0.06);
          k = 0.95;
          break;
        }
        default: {
          // city streets: asphalt with the lane markings / zebra crossings
          setMul(c, ASPHALT, 0.97 + nz * 0.08);
          if (f.type === FieldType.Avenue && Math.abs(Math.abs(b) - 0.07) < 0.045) setMul(c, CENTRE_YELLOW, 1);
          else if (f.type !== FieldType.Crossing && Math.abs(Math.abs(b) - 1.1) < 0.05 && (a + 100) % 1.2 < 0.6) setMul(c, MARKING, 0.86);
          if (f.type === FieldType.Crossing && Math.abs(Math.abs(a) - f.hl + 0.45) < 0.32 && (b + 100) % 0.36 < 0.18) setMul(c, MARKING, 0.84);
          k = 1;
        }
      }
      // winter: the snow lies on the fields, the furrows show through (the ground's painted cover)
      if (winter && !city) setMix(c, c, C.snow, Math.min(0.9, this.snow[j * pw + i] * (0.75 + row * 0.3)));
      const o = (j * pw + i) * 3;
      const t = cov * k;
      for (let n = 0; n < 3; n++) col[o + n] += (c[n] - col[o + n]) * t;
    });
  }

  /** Hedges, fences and roads (with their markings). */
  private drawLines(box: Box, px0: number, py0: number, pw: number, ph: number, col: Float32Array, water: Float32Array) {
    const S = this.S;
    const near: SegItem[] = [];
    for (const s of this.segs) if (hit(s, box)) near.push(s);
    if (!near.length) return;
    // hedges and fences first (roads cut through them)
    for (const s of near) {
      if (s.kind < 2) continue;
      const hedge = s.kind === 2;
      const tc = this.look.mini.tree;
      this.span(s, px0, py0, pw, ph, (i, j, x, y) => {
        if (water[j * pw + i] > 0) return;
        const o = (j * pw + i) * 3;
        // the hedge's shadow (south-east), then the hedge itself
        if (hedge) {
          const ds = segDist(x - 0.12, y - 0.12, s);
          const sh = clamp01(0.5 - (ds - s.hw) * S) * 0.35;
          for (let n = 0; n < 3; n++) col[o + n] *= 1 - sh;
        }
        const d = segDist(x, y, s);
        const cov = clamp01(0.5 - (d - s.hw) * S) * (hedge ? 0.9 : 0.35);
        if (cov <= 0) return;
        const lit = hedge ? 1.1 + (hash2(Math.floor(x * 11), Math.floor(y * 11), 103) - 0.5) * 0.3 : 1;
        const c = hedge ? [tc[0] * 1.15 * lit, tc[1] * 1.2 * lit, tc[2] * 1.1 * lit] : [138, 122, 100];
        for (let n = 0; n < 3; n++) col[o + n] += (c[n] - col[o + n]) * cov;
      });
    }
    // roads: each segment stamps its distance into the band (the nearest road wins), then one pass paints
    // the asphalt, highways with their centre dashes and edge lines
    const roads = near.filter((s) => s.kind < 2);
    if (!roads.length) return;
    const n = pw * ph;
    const edge = this.f32(4, n, 99); // distance from the road's edge (< 0 on it)
    const cen = this.f32(5, n);
    const arcs = this.f32(6, n);
    const segOf = new Int32Array(n).fill(-1);
    roads.forEach((s, si) => {
      const dx = s.bx - s.ax;
      const dy = s.by - s.ay;
      const l2 = dx * dx + dy * dy;
      const len = Math.sqrt(l2);
      const i0 = Math.max(0, Math.floor((Math.min(s.ax, s.bx) - s.hw) * S - 1) - px0);
      const i1 = Math.min(pw, Math.ceil((Math.max(s.ax, s.bx) + s.hw) * S + 1) - px0);
      const j0 = Math.max(0, Math.floor((Math.min(s.ay, s.by) - s.hw) * S - 1) - py0);
      const j1 = Math.min(ph, Math.ceil((Math.max(s.ay, s.by) + s.hw) * S + 1) - py0);
      for (let j = j0; j < j1; j++) {
        const y = (py0 + j + 0.5) / S;
        for (let i = i0; i < i1; i++) {
          const x = (px0 + i + 0.5) / S;
          const t = l2 > 0 ? clamp01(((x - s.ax) * dx + (y - s.ay) * dy) / l2) : 0;
          const d = Math.hypot(x - s.ax - dx * t, y - s.ay - dy * t);
          const p = j * pw + i;
          if (d - s.hw < edge[p]) {
            edge[p] = d - s.hw;
            cen[p] = d;
            arcs[p] = s.arc + t * len;
            segOf[p] = si;
          }
        }
      }
    });
    const winter = this.look.code === 2;
    const mk = (dd: number, hw: number) => clamp01((hw - Math.abs(dd)) * S + 0.5);
    const c = [0, 0, 0];
    for (let p = 0; p < n; p++) {
      if (segOf[p] < 0 || water[p] > 0) continue;
      const cov = clamp01(0.5 - edge[p] * S);
      if (cov <= 0) continue;
      const s = roads[segOf[p]];
      const d = cen[p];
      const nz = 1 + (hash2(px0 + (p % pw), py0 + ((p / pw) | 0), 107) - 0.5) * 0.08;
      const country = s.kind === 1;
      c[0] = (country ? ASPHALT[0] * 1.1 + 6 : ASPHALT[0]) * nz;
      c[1] = (country ? ASPHALT[1] * 1.08 + 4 : ASPHALT[1]) * nz;
      c[2] = (country ? ASPHALT[2] * 1.04 : ASPHALT[2]) * nz;
      // markings: dashed centre line, solid edge lines (highways; country roads only the dashes)
      let paint = mk(d, 0.07) * ((arcs[p] + 100) % 1.3 < 0.7 ? 1 : 0) * (s.hw > 0.55 ? 0.8 : 0);
      if (!country && s.hw > 0.7) paint = Math.max(paint, mk(d - (s.hw - 0.16), 0.06) * 0.55);
      if (paint > 0) for (let k = 0; k < 3; k++) c[k] += (MARKING[k] - c[k]) * paint;
      // winter: the ploughed roads keep a thin packed cover (the ground's painted snow there)
      if (winter) for (let k = 0; k < 3; k++) c[k] += (SNOW_PACKED[k] - c[k]) * Math.min(0.85, 0.42 + this.snow[p] * 0.6);
      const o = p * 3;
      for (let k = 0; k < 3; k++) col[o + k] += (c[k] - col[o + k]) * cov;
    }
  }

  private drawBridge(b: BridgeItem, px0: number, py0: number, pw: number, ph: number, col: Float32Array) {
    const S = this.S;
    const down = !!this.bridgeDown[b.idx];
    const hw = DECK_W / 2;
    // local coords: a along the deck, c across
    const deck = (x: number, y: number) => {
      const px = x - b.cx;
      const py = y - b.cy;
      return [px * b.dx + py * b.dy, -px * b.dy + py * b.dx];
    };
    const inDeck = (a: number, c: number) => {
      if (Math.abs(c) > hw || Math.abs(a) > b.half) return 0;
      // once down only the stubs on the banks stand
      if (down && Math.abs(a) < b.half - 1.3) return 0;
      return clamp01((hw - Math.abs(c)) * S + 0.5) * clamp01((b.half - Math.abs(a)) * S + 0.5);
    };
    const off = 0.55; // the deck stands ~1.3 above the water: its shadow falls south-east
    this.span(b, px0, py0, pw, ph, (i, j, x, y) => {
      const o = (j * pw + i) * 3;
      const [sa, sc] = deck(x - off, y - off);
      const sh = inDeck(sa, sc);
      if (sh > 0) for (let n = 0; n < 3; n++) col[o + n] *= 1 - sh * 0.5;
      if (down) {
        // debris in the water under the gap
        const [a, c] = deck(x, y);
        if (Math.abs(c) < hw && Math.abs(a) < b.half - 1.3 && hash2(px0 + i, py0 + j, 109) < 0.12) for (let n = 0; n < 3; n++) col[o + n] = [92, 88, 82][n];
      }
    });
    this.span(b, px0, py0, pw, ph, (i, j, x, y) => {
      const [a, c] = deck(x, y);
      const cov = inDeck(a, c);
      if (cov <= 0) return;
      const o = (j * pw + i) * 3;
      // concrete deck, darker asphalt lanes, parapets lit on the sun's side
      let v: number[] = Math.abs(c) < hw - 0.28 ? ASPHALT.map((q) => q * 1.08) : [168, 164, 156];
      if (Math.abs(c) > hw - 0.12) v = c * (b.dx + b.dy) < 0 ? [196, 192, 184] : [120, 116, 110];
      if (Math.abs(c) < 0.05 && ((a + 100) % 1.1) < 0.55 && !down) v = [214, 208, 186];
      if (down && Math.abs(Math.abs(a) - (b.half - 1.3)) < 0.18) v = [70, 66, 62]; // broken edge
      for (let n = 0; n < 3; n++) col[o + n] += (v[n] - col[o + n]) * cov;
    });
  }

  /** A box's shadow cast south-east by `off` tiles (the swept footprint). */
  private drawShadowBox(x0: number, y0: number, x1: number, y1: number, off: number, px0: number, py0: number, pw: number, ph: number, col: Float32Array, k: number) {
    const S = this.S;
    const soft = 0.5 / S;
    this.span({ x0, y0, x1: x1 + off + 0.2, y1: y1 + off + 0.2 }, px0, py0, pw, ph, (i, j, x, y) => {
      // some t in [0, 1] with (x, y) - t * (off, off) inside the box
      const tA = Math.max((x - x1 - soft) / off, (y - y1 - soft) / off, 0);
      const tB = Math.min((x - x0 + soft) / off, (y - y0 + soft) / off, 1);
      if (tA > tB) return;
      // soft edge: how deep inside
      const dx = Math.min(x - x0 - tA * off, x1 - x + tA * off);
      const dy = Math.min(y - y0 - tA * off, y1 - y + tA * off);
      const e = clamp01(Math.min(dx, dy) * S + 0.5) * clamp01((tB - tA) * off * S + 0.5);
      const o = (j * pw + i) * 3;
      const f = 1 - (1 - k) * e;
      col[o] *= f;
      col[o + 1] *= f * 1.01;
      col[o + 2] *= f * 1.05;
    });
  }

  private drawRoof(s: StructItem, px0: number, py0: number, pw: number, ph: number, col: Float32Array) {
    const S = this.S;
    const st = s.st;
    const code = this.look.code;
    const city = isCityKind(st.kind);
    const hh = (k: number) => hash2(st.x * 7 + k, st.y * 13, 911);
    const round = st.kind === StructureKind.Silo || st.kind === StructureKind.WaterTower || st.kind === StructureKind.Tower;
    const flatVillage = st.kind === StructureKind.MudHouse || st.kind === StructureKind.Courtyard || (code === 1 && !city);
    let roof: number[];
    if (city) {
      const v = hh(4);
      roof = st.kind === StructureKind.Townhouse ? [78, 82, 92] : v < 0.3 ? [96, 96, 98] : v < 0.7 ? [148, 146, 140] : [170, 166, 158];
    } else if (flatVillage) roof = rgb(WALLS_DESERT[Math.floor(hh(1) * WALLS_DESERT.length)]).map((q) => q * 0.96);
    else if (round) roof = st.kind === StructureKind.Silo ? [176, 178, 176] : [120, 112, 100];
    else {
      const pal = code === 2 ? ROOFS_WINTER : ROOFS;
      roof = rgb(pal[Math.floor(hh(2) * pal.length)]);
    }
    const snowRoof = code === 2 && !city;
    const ridgeX = (st.rot & 1) === 0; // gable ridge along x (rot 0 / 2) or y
    const cx = (s.fx0 + s.fx1) / 2;
    const cy = (s.fy0 + s.fy1) / 2;
    const rr = Math.min(s.fx1 - s.fx0, s.fy1 - s.fy0) / 2;
    this.span(s, px0, py0, pw, ph, (i, j, x, y) => {
      let cov: number;
      let lit = 1;
      if (round) {
        const d = Math.hypot(x - cx, y - cy);
        cov = clamp01((rr - d) * S + 0.5);
        lit = 1.08 - ((x - cx + y - cy) / (rr * 1.41)) * 0.3;
      } else {
        cov = clamp01(Math.min(x - s.fx0, s.fx1 - x) * S + 0.5) * clamp01(Math.min(y - s.fy0, s.fy1 - y) * S + 0.5);
        if (city) {
          // parapet ring lit on the north-west, roof clutter (vents, AC units) with tiny shadows
          const e = Math.min(x - s.fx0, s.fx1 - x, y - s.fy0, s.fy1 - y);
          if (e < 0.12) lit = x - s.fx0 < 0.12 || y - s.fy0 < 0.12 ? 1.25 : 0.82;
          else {
            const cxk = Math.floor(x * 2.5);
            const cyk = Math.floor(y * 2.5);
            const hk = hash2(cxk, cyk, 113 + st.x);
            if (hk < 0.1 && e > 0.3) lit = 1.32;
            else if (hash2(Math.floor((x - 0.12) * 2.5), Math.floor((y - 0.12) * 2.5), 113 + st.x) < 0.1 && e > 0.3) lit = 0.72;
            else lit = 0.97 + (hash2(Math.floor(x * 9), Math.floor(y * 9), 127) - 0.5) * 0.06;
          }
          if (st.kind === StructureKind.Townhouse) lit *= (ridgeX ? y < cy : x < cx) ? 1.12 : 0.84;
        } else if (flatVillage) {
          const e = Math.min(x - s.fx0, s.fx1 - x, y - s.fy0, s.fy1 - y);
          if (st.kind === StructureKind.Courtyard && e > Math.min(s.fx1 - s.fx0, s.fy1 - s.fy0) * 0.3) lit = 0.68; // the open court
          else lit = e < 0.08 ? (x - s.fx0 < 0.08 || y - s.fy0 < 0.08 ? 1.12 : 0.85) : 1;
        } else {
          // gabled: the slope facing the sun (north / west) lit, the other in shade, a ridge line between
          const side = ridgeX ? y - cy : x - cx;
          lit = side < 0 ? 1.18 : 0.78;
          if (Math.abs(side) < 0.5 / S) lit = 1.3;
          // tile courses
          lit *= 0.97 + 0.06 * Math.sin((ridgeX ? y : x) * Math.PI * 2 * 4);
        }
      }
      if (cov <= 0) return;
      const o = (j * pw + i) * 3;
      for (let n = 0; n < 3; n++) {
        let v = roof[n] * lit;
        if (snowRoof && !round) v += ([228, 234, 242][n] * (lit > 1 ? 1 : 0.86) - v) * 0.62;
        col[o + n] += (v - col[o + n]) * cov;
      }
    });
  }

  private drawRuin(r: Box, px0: number, py0: number, pw: number, ph: number, col: Float32Array) {
    const S = this.S;
    const cx = (r.x0 + r.x1) / 2;
    const cy = (r.y0 + r.y1) / 2;
    const rx = (r.x1 - r.x0) / 2;
    const ry = (r.y1 - r.y0) / 2;
    this.span({ x0: r.x0 - 0.7, y0: r.y0 - 0.7, x1: r.x1 + 0.7, y1: r.y1 + 0.7 }, px0, py0, pw, ph, (i, j, x, y) => {
      const o = (j * pw + i) * 3;
      // scorch halo, then the rubble heap over the footprint
      const e = Math.max(Math.abs(x - cx) - rx, Math.abs(y - cy) - ry);
      const halo = (1 - smooth(-0.1, 0.7, e)) * 0.55;
      for (let n = 0; n < 3; n++) col[o + n] *= 1 - halo;
      const cov = clamp01(-e * S + 0.5);
      if (cov <= 0) return;
      const h = hash2(px0 + i, py0 + j, 131);
      const lump = hash2(Math.floor(x * 4), Math.floor(y * 4), 137);
      const v = h < 0.25 ? [44, 40, 36] : lump < 0.35 ? [128, 120, 110] : lump < 0.6 ? [104, 92, 80] : [76, 70, 64];
      const k = 0.9 + h * 0.2;
      for (let n = 0; n < 3; n++) col[o + n] += (v[n] * k - col[o + n]) * cov;
    });
  }

  private drawTreeShadow(t: TreeItem, px0: number, py0: number, pw: number, ph: number, col: Float32Array) {
    const S = this.S;
    const off = t.r * 2 * SHADOW_K;
    const sx = t.x + off;
    const sy = t.y + off;
    const R = t.r * 1.02;
    this.span({ x0: sx - R, y0: sy - R, x1: sx + R, y1: sy + R }, px0, py0, pw, ph, (i, j, x, y) => {
      const d = Math.hypot(x - sx, y - sy);
      const cov = clamp01((R - d) * S + 0.3);
      if (cov <= 0) return;
      const o = (j * pw + i) * 3;
      const f = 1 - 0.42 * cov;
      col[o] *= f;
      col[o + 1] *= f;
      col[o + 2] *= f * 1.04;
    });
  }

  private drawCanopy(t: TreeItem, px0: number, py0: number, pw: number, ph: number, col: Float32Array) {
    const S = this.S;
    const R = t.r;
    const winter = this.look.code === 2;
    const conifer = t.sp === Species.Spruce || t.sp === Species.Pine;
    const palm = t.sp === Species.Palm;
    this.span({ x0: t.x - R, y0: t.y - R, x1: t.x + R, y1: t.y + R }, px0, py0, pw, ph, (i, j, x, y) => {
      const dx = x - t.x;
      const dy = y - t.y;
      const d = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx) + t.rot;
      // outline: conifers a ragged star, palms their fronds, broadleaves lumpy
      let edge = R;
      if (conifer) edge *= 0.86 + 0.14 * Math.abs(Math.cos(ang * 3.5));
      else if (palm) edge *= 0.45 + 0.55 * Math.pow(Math.abs(Math.cos(ang * 3)), 0.6);
      else edge *= 0.9 + 0.1 * Math.cos(ang * 5 + t.x);
      const cov = clamp01((edge - d) * S + 0.5);
      if (cov <= 0) return;
      // dome lit from the north-west, darker rim, clumps of leaves
      const u = d / R;
      const dome = 1 + (-(dx + dy) / (R * 1.41)) * 0.42 - u * u * 0.18;
      const clump = 1 + (hash2(px0 + i, py0 + j, 139 + (t.sp | 0)) - 0.5) * 0.22;
      const o = (j * pw + i) * 3;
      for (let n = 0; n < 3; n++) {
        let v = t.col[n] * dome * clump;
        // snow lies on the winter crowns (more on the sunny upper side)
        if (winter) v += ([214, 222, 232][n] * Math.min(1.05, dome) - v) * (conifer ? 0.38 : 0.28) * smooth(0.2, 0.9, dome - 0.1 + (clump - 1) * 3);
        col[o + n] += (v - col[o + n]) * cov;
      }
    });
  }

  // ---------------------------------------------------------------- night lights

  /** Night lights of a rectangle (light pixel space): additive glows on black. */
  renderLights(lx0: number, ly0: number, lw: number, lh: number): PixelRect {
    const LS = this.LS;
    const acc = new Float32Array(lw * lh * 3);
    const box: Box = { x0: lx0 / LS, y0: ly0 / LS, x1: (lx0 + lw) / LS, y1: (ly0 + lh) / LS };
    for (const l of this.lamps) {
      if (!hit(l, box) || (l.st >= 0 && this.ruined[l.st])) continue;
      const i0 = Math.max(0, Math.floor(l.x0 * LS) - lx0);
      const i1 = Math.min(lw, Math.ceil(l.x1 * LS) - lx0);
      const j0 = Math.max(0, Math.floor(l.y0 * LS) - ly0);
      const j1 = Math.min(lh, Math.ceil(l.y1 * LS) - ly0);
      for (let j = j0; j < j1; j++)
        for (let i = i0; i < i1; i++) {
          const d = Math.hypot((lx0 + i + 0.5) / LS - l.x, (ly0 + j + 0.5) / LS - l.y) / l.r;
          if (d >= 1) continue;
          const k = (1 - d) * (1 - d);
          const o = (j * lw + i) * 3;
          acc[o] += l.c[0] * k;
          acc[o + 1] += l.c[1] * k;
          acc[o + 2] += l.c[2] * k;
        }
    }
    const out = new Uint8ClampedArray(lw * lh * 4);
    for (let p = 0; p < lw * lh; p++) {
      out[p * 4] = acc[p * 3];
      out[p * 4 + 1] = acc[p * 3 + 1];
      out[p * 4 + 2] = acc[p * 3 + 2];
      out[p * 4 + 3] = 255;
    }
    return { x: lx0, y: ly0, width: lw, height: lh, data: out };
  }
}

function segDist(x: number, y: number, s: SegItem) {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? clamp01(((x - s.ax) * dx + (y - s.ay) * dy) / l2) : 0;
  return Math.hypot(x - s.ax - dx * t, y - s.ay - dy * t);
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function toCanvas(data: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(w, h);
  img.data.set(data);
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Write a re-baked rectangle into the canvas (or the raw array without a DOM). */
function put(c: HTMLCanvasElement | null, arr: Uint8ClampedArray | null, W: number, r: PixelRect) {
  if (c) {
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(r.width, r.height);
    img.data.set(r.data);
    ctx.putImageData(img, r.x, r.y);
  } else if (arr) for (let j = 0; j < r.height; j++) arr.set(r.data.subarray(j * r.width * 4, (j + 1) * r.width * 4), ((r.y + j) * W + r.x) * 4);
}

// ------------------------------------------------------------------ fog of war

/** Minimap fog alpha (0..255) of a tile: visible clear, explored but out of sight dimmed, unexplored dark. */
export const FOG_DIM = 110;
export function fogAlpha(visible: number, explored: number): number {
  return visible ? 0 : explored ? FOG_DIM : 255;
}

/** Fill an RGBA fog image (one pixel per tile) from a player's visibility: dark blue-black, alpha per fogAlpha. */
export function fillFog(data: Uint8ClampedArray, visible: ArrayLike<number>, explored: ArrayLike<number>) {
  for (let i = 0; i < visible.length; i++) {
    const a = fogAlpha(visible[i], explored[i]);
    data[i * 4] = 4;
    data[i * 4 + 1] = 7;
    data[i * 4 + 2] = 10;
    data[i * 4 + 3] = a;
  }
}
