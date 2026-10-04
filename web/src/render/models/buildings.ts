import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { FogOfWar } from '../fog';
import { pbr, worldUV, type TexKind, type TexOpts } from '../textures';
import type { Builder } from './registry';
import type { AnimState, Model, ModelStyle, Region } from './types';
import { drawFlag } from '../flags';
import { BuildFx, FxTpl, newRec, type FxModel, type FxRec } from './buildfx';
import { atlasPatch, bldAtlas, netTexture, signCell, signTexture, Tile, type SignSpec } from './bldtex';
import { flagPatchCell, makeDecalMaterial, roundelCell, type Cell } from './insignia';
import { registerLods } from '../perf/lod';

/*
 * Detailed procedural buildings, one design per building type, with four
 * regional architectural styles (west / east / asia / mideast) and faction
 * specific air-defence launchers.
 *
 * Every building is assembled from many small primitives which are merged per
 * material (one draw call per material) - animated parts live in their own
 * named child objects. A finished building is cached as a template per
 * (key, faction, team, fog) and each instance is a cheap clone that shares
 * geometry and materials; the animation handles are re-bound by name.
 */

type V3 = [number, number, number];
type P2 = [number, number];
type Mat = THREE.Material;
type SMat = THREE.MeshStandardMaterial;
type Ax = 'x' | 'y' | 'z';

const TAU = Math.PI * 2;

// ================================================================ utilities

function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function strHash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function mix(a: number, b: number, t: number) {
  return new THREE.Color(a).lerp(new THREE.Color(b), t).getHex();
}
function shade(a: number, f: number) {
  const c = new THREE.Color(a);
  return new THREE.Color(Math.min(1, c.r * f), Math.min(1, c.g * f), Math.min(1, c.b * f)).getHex();
}

// ================================================================ materials

const fogIds = new WeakMap<FogOfWar, number>();
let fogSeq = 0;
function fogId(fog: FogOfWar | null) {
  if (!fog) return 0;
  let id = fogIds.get(fog);
  if (id === undefined) {
    id = ++fogSeq;
    fogIds.set(fog, id);
  }
  return id;
}

const matCache = new Map<string, Mat>();
const texCache = new Map<string, THREE.Texture>();

function canvasTex(key: string, w: number, h: number, draw: (c: CanvasRenderingContext2D, w: number, h: number) => void, srgb = true): THREE.Texture {
  let t = texCache.get(key);
  if (!t) {
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d')!;
    draw(ctx, w, h);
    t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4;
    texCache.set(key, t);
  }
  return t;
}
const css = (c: number) => '#' + c.toString(16).padStart(6, '0');

// --- canvas texture painters
function texChain() {
  return canvasTex('chain', 64, 64, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.strokeStyle = 'rgba(200,205,210,1)';
    c.lineWidth = 3;
    for (let i = -4; i <= 8; i++) {
      c.beginPath();
      c.moveTo(i * 16, 0);
      c.lineTo(i * 16 + 64, h);
      c.stroke();
      c.beginPath();
      c.moveTo(i * 16 + 64, 0);
      c.lineTo(i * 16, h);
      c.stroke();
    }
  });
}
function texHelipad(color: string) {
  return canvasTex('helipad' + color, 256, 256, (c, w) => {
    c.clearRect(0, 0, w, w);
    c.strokeStyle = color;
    c.lineWidth = 10;
    c.beginPath();
    c.arc(w / 2, w / 2, w / 2 - 14, 0, TAU);
    c.stroke();
    c.fillStyle = color;
    const s = w / 256;
    c.fillRect(82 * s, 70 * s, 22 * s, 116 * s);
    c.fillRect(152 * s, 70 * s, 22 * s, 116 * s);
    c.fillRect(100 * s, 117 * s, 56 * s, 22 * s);
  });
}
/** AESA radar face: grid of transmit / receive modules. */
function texFlag(cols: number[], faction: string) {
  return canvasTex('flag' + cols.join(',') + faction, 96, 64, (c, w, h) => {
    if (drawFlag(c, faction, w, h)) return;
    for (let i = 0; i < 3; i++) {
      c.fillStyle = css(cols[i] ?? 0x888888);
      c.fillRect(0, (i * h) / 3, w, h / 3 + 1);
    }
  });
}

/** Default texture repeats per world unit for each atlas tile. */
const TILE_UV: Record<Tile, number> = {
  [Tile.Panel]: 1.25,
  [Tile.Cast]: 1.4,
  [Tile.Corr]: 1.6,
  [Tile.Plate]: 2.2,
  [Tile.Paint]: 2.5,
  [Tile.Clad]: 1.6,
  [Tile.CamoA]: 1.6,
  [Tile.CamoB]: 1.6,
  [Tile.CamoC]: 1.8,
  [Tile.Bag]: 3,
  [Tile.Canvas]: 2,
  [Tile.Asphalt]: 1.2,
  [Tile.Soil]: 1.1,
  [Tile.Brick]: 1.4,
  [Tile.Plaster]: 1.3,
  [Tile.Grate]: 4,
  [Tile.Wood]: 4,
  [Tile.RoofTile]: 2.2,
  [Tile.Hazard]: 4.5,
  [Tile.Stone]: 1.3,
  [Tile.Glass]: 1,
  [Tile.Aesa]: 3,
  [Tile.Solar]: 2.5,
  [Tile.Roof]: 1.6,
};

/** Old procedural texture kinds (textures.ts names) mapped onto atlas tiles. */
const KIND_TILE: Record<string, Tile> = {
  concrete: Tile.Panel,
  concreteDark: Tile.Panel,
  plaster: Tile.Plaster,
  sandstone: Tile.Stone,
  brick: Tile.Brick,
  corrugated: Tile.Corr,
  metalPanel: Tile.Plate,
  roofTiles: Tile.RoofTile,
  asphalt: Tile.Asphalt,
  sandbag: Tile.Bag,
  wood: Tile.Wood,
  canvas: Tile.Canvas,
  grating: Tile.Grate,
  rust: Tile.Corr,
  soil: Tile.Soil,
};

/** Multiply two colours (hex), with a brightness gain (atlas tiles average ~0.82 albedo). */
function mulHex(a: number, b: number, gain = 1) {
  const ca = new THREE.Color(a);
  const cb = new THREE.Color(b);
  return new THREE.Color(Math.min(1, ca.r * cb.r * gain), Math.min(1, ca.g * cb.g * gain), Math.min(1, ca.b * cb.b * gain)).getHex();
}

/**
 * Per-template material factory bound to an owner (style) and a fog instance.
 *
 * To keep draw calls low most materials handed out are *virtual*: lightweight
 * descriptors pointing at a shared real material plus a tint (baked into a
 * vertex colour attribute) and, for the building atlas, a tile index (baked
 * into uv1.x). Every textured surface of a building (concrete, steel, paint,
 * camo, sandbags, soil...) shares ONE atlas material; plain glass and lamps
 * have their own, so a building draws in a handful of calls.
 */
class Mats {
  readonly glow = new Set<Mat>();
  readonly flags: SMat[] = [];
  private readonly fid: number;
  private readonly own: string;
  private readonly pal: { value: THREE.Color[] };
  constructor(
    readonly s: ModelStyle,
    readonly fog: FogOfWar | null,
    readonly N: Nation,
  ) {
    this.fid = fogId(fog);
    this.own = `${s.faction}:${s.team}`;
    this.pal = { value: N.camo.map((c) => new THREE.Color(c)) };
  }
  private cached<T extends Mat>(key: string, perOwner: boolean, make: () => T): T {
    const k = `${this.fid}|${perOwner ? this.own : '*'}|${key}`;
    let m = matCache.get(k) as T | undefined;
    if (!m) {
      m = make();
      if (this.fog) this.fog.apply(m);
      matCache.set(k, m);
    }
    return m;
  }
  private virt(real: Mat, color: THREE.Color, uv: number, tile = -1): SMat {
    const k = `v|${real.uuid}|${color.getHexString()}|${color.r.toFixed(4)}|${uv}|${tile}`;
    let m = matCache.get(k) as SMat | undefined;
    if (!m) {
      m = new THREE.MeshStandardMaterial();
      m.userData.real = real;
      m.userData.vc = color;
      m.userData.uv = uv;
      m.userData.tile = tile;
      matCache.set(k, m);
    }
    return m;
  }
  /** The shared atlas material (per owner: the camo palette is a uniform). */
  private atlasReal(double: boolean): SMat {
    const pal = this.pal;
    const m = this.cached(`atlas:${double}:${this.N.camo.join(',')}`, true, () => {
      const A = bldAtlas();
      const mm = new THREE.MeshStandardMaterial({
        map: A.map,
        normalMap: A.normalMap,
        roughness: 1,
        metalness: 1,
        vertexColors: true,
        side: double ? THREE.DoubleSide : THREE.FrontSide,
        normalScale: new THREE.Vector2(1.25, 1.25),
      });
      mm.userData.atlas = true;
      mm.onBeforeCompile = (sh) => atlasPatch(sh, pal);
      return mm;
    });
    m.customProgramCacheKey = () => (this.fog ? 'fog-' : '') + 'batlas';
    return m;
  }
  /** Atlas surface: tile + tint (per vertex) + texture repeats per world unit. */
  at(tile: Tile, tint = 0xffffff, uv?: number, double = false): SMat {
    return this.virt(this.atlasReal(double), new THREE.Color(tint), uv ?? TILE_UV[tile], tile);
  }
  /** Old procedural texture kinds (textures.ts names), served from the atlas. */
  tex(kind: TexKind, opts: TexOpts, tint = 0xffffff, uv = 3, _rough = 1, _metal = 0.03, _nScale = 1.6): SMat {
    if (kind === 'camo') return this.at(this.N.camoTile, 0xffffff, uv * 0.5);
    const tile = KIND_TILE[kind] ?? Tile.Paint;
    const base = opts.color ?? 0xd8d8d4;
    return this.at(tile, mulHex(tint, base, kind === 'concreteDark' ? 1.05 : 1.15), uv * 0.55);
  }
  /** National insignia / flag decals (shared atlas, alpha tested). */
  decal(): SMat {
    const m = this.cached('decal', false, () => {
      const mm = makeDecalMaterial();
      mm.userData.uv = 0;
      return mm;
    });
    return m;
  }
  /** Plain colour: painted (atlas paint tile), bare metal (atlas plate tile), glossy (plain) or double sided. */
  col(color: number, rough = 0.7, metal = 0.1, double = false): SMat {
    if (double) return this.at(Tile.Paint, color, 3, true);
    if (rough < 0.2 && metal > 0.5) return this.at(Tile.Glass, mulHex(color, 0xffffff, 1.15), 1);
    if (metal >= 0.45) return this.at(Tile.Plate, color, 3.2);
    return this.at(Tile.Paint, color, 3);
  }
  /** Emissive lamp (one shared per-owner material; colour/intensity via vertex colours). */
  light(color: number, ei = 2.6): SMat {
    const base = 2.6;
    const real = this.cached('lights', true, () => {
      const mm = new THREE.MeshStandardMaterial({ color: 0x050505, emissive: 0xffffff, emissiveIntensity: base, roughness: 0.4, metalness: 0, vertexColors: true, toneMapped: false });
      mm.userData.baseEI = base;
      mm.userData.uv = 0;
      mm.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = emissive * vColor.rgb;');
      };
      return mm;
    });
    real.customProgramCacheKey = () => (this.fog ? 'fog-bvcglow' : 'bvcglow');
    this.glow.add(real);
    const c = new THREE.Color(color).multiplyScalar(ei / base);
    return this.virt(real, c, 0);
  }
  /** Synchronised red obstruction lights (per owner; flashed by the instances, not a night lamp). */
  blink(): SMat {
    const base = 3.2;
    const real = this.cached('blinkl', true, () => {
      const mm = new THREE.MeshStandardMaterial({ color: 0x050505, emissive: 0xff2a1a, emissiveIntensity: base, roughness: 0.4, metalness: 0, toneMapped: false });
      mm.userData.blinkEI = base;
      mm.userData.uv = 0;
      return mm;
    });
    this.blinks.add(real);
    return real;
  }
  readonly blinks = new Set<SMat>();
  /** Window panes with random lit cells (per owner, dimmable). */
  win(curtain = false): SMat {
    const m = this.cached(`win:${curtain}`, true, () => {
      const set = curtain
        ? pbr('windows', { color: 0x9aa2aa, color2: 0x23415a, color3: 0xfff0c8, divisions: 8, seed: 5 })
        : pbr('windows', { color: 0x2e3236, color2: 0x24323e, color3: 0xffcf86, divisions: 8, seed: 3 });
      const mm = new THREE.MeshStandardMaterial({
        map: set.map,
        normalMap: set.normalMap,
        roughnessMap: set.roughnessMap,
        roughness: 0.75,
        metalness: 0.45,
        emissiveMap: set.emissiveMap ?? null,
        emissive: 0xffffff,
        emissiveIntensity: curtain ? 1.15 : 1.45,
      });
      mm.userData.uv = 0;
      mm.userData.baseEI = mm.emissiveIntensity;
      return mm;
    });
    this.glow.add(m);
    return m;
  }
  /** Canvas texture based material. */
  canvas(key: string, tex: THREE.Texture, o: { rough?: number; metal?: number; alphaTest?: number; double?: boolean; uv?: number; color?: number } = {}): SMat {
    return this.cached(`cv:${key}:${JSON.stringify(o)}`, false, () => {
      const m = new THREE.MeshStandardMaterial({
        map: tex,
        roughness: o.rough ?? 0.8,
        metalness: o.metal ?? 0.05,
        alphaTest: o.alphaTest ?? 0,
        side: o.double ? THREE.DoubleSide : THREE.FrontSide,
        color: o.color ?? 0xffffff,
      });
      m.userData.uv = o.uv ?? 0;
      return m;
    });
  }
  /** Shared sign / stencil atlas (boards opaque, stencils alpha tested). */
  signs(): SMat {
    return this.cached('signs', false, () => {
      const m = new THREE.MeshStandardMaterial({ map: signTexture(), roughness: 0.75, metalness: 0.05, alphaTest: 0.45 });
      m.userData.uv = 0;
      return m;
    });
  }
  /** Camouflage net in the nation's colours (alpha cut, double sided). */
  net(): SMat {
    return this.cached(`net:${this.N.camo.join(',')}`, false, () => {
      const m = new THREE.MeshStandardMaterial({ map: netTexture(this.N.camo), roughness: 0.95, metalness: 0, alphaTest: 0.45, side: THREE.DoubleSide });
      m.userData.uv = 2.2;
      return m;
    });
  }
  /** Waving flag (vertex shader wave driven by a per-owner time uniform). */
  flag(): SMat {
    const s = this.s;
    const m = this.cached(`flag:${s.flag.join(',')}`, true, () => {
      const mm = new THREE.MeshStandardMaterial({ map: texFlag(s.flag, s.faction), roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
      const uTime = { value: 0 };
      mm.userData.uTime = uTime;
      mm.userData.uv = 0;
      mm.onBeforeCompile = (sh) => {
        sh.uniforms.uTime = uTime;
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;')
          .replace(
            '#include <begin_vertex>',
            `vec3 transformed = vec3( position );
            float fw = clamp( position.x / 0.34, 0.0, 1.0 );
            transformed.z += sin( position.x * 16.0 - uTime * 5.0 ) * 0.025 * fw + sin( position.x * 7.0 - uTime * 2.3 ) * 0.012 * fw;
            transformed.y -= fw * fw * 0.02;`,
          );
      };
      return mm;
    });
    // the fog patch installs its own cache key: make sure ours differs from plain fog materials
    m.customProgramCacheKey = () => (this.fog ? 'fog-bflag' : 'bflag');
    if (!this.flags.includes(m)) this.flags.push(m);
    return m;
  }
}

// ================================================================ nations

type RoofStyle = 'flat' | 'gable' | 'hip';

/**
 * Architectural flavour per nation: paint, wall finish, roof style, camo,
 * signage (script, colours, emblem). Team colour accents are added on top by
 * the builders (roof copings, bands, door frames) for readability.
 */
interface Nation {
  /** Main wall tint and atlas finish. */
  wall: number;
  wallTile: Tile;
  /** Secondary wall (annexes, cladding). */
  wall2: number;
  wall2Tile: Tile;
  /** Flat roof membrane tint. */
  roof: number;
  /** Pitched roof tint (corrugated or tiles). */
  pitch: number;
  roofStyle: RoofStyle;
  /** Nation drab paint for steel doors, sheds, vehicles. */
  drab: number;
  /** Dark structural trim. */
  trim: number;
  /** 4 camo colours (base, 2, 3, highlight) + pattern tile. */
  camo: number[];
  camoTile: Tile;
  /** Sandbag / hesco fabric. */
  bag: number;
  /** Ground hardstand (gravel) tint. */
  ground: number;
  /** Concrete tint (barriers, footings). */
  conc: number;
  /** ISO container tints. */
  boxes: number[];
  /** Big industrial halls (factory hangar, turbine hall, workshop) are camo painted. */
  camoHalls?: boolean;
  sign: { base: string; sub: string; fg: string; bg: string; border: string; font?: string; rtl?: boolean; mark?: string; markColor?: string; num: string };
}

const NATIONS: Record<string, Nation> = {
  usa: {
    wall: 0xcdbd98,
    wallTile: Tile.Panel,
    wall2: 0xb4aa90,
    wall2Tile: Tile.Clad,
    roof: 0xa8a294,
    pitch: 0x9a9480,
    roofStyle: 'flat',
    drab: 0x857a5a,
    trim: 0x4c4a42,
    camo: [0xb8a57c, 0xa08c62, 0x7c6c4c, 0xcab890],
    camoTile: Tile.CamoA,
    bag: 0xc2ad84,
    ground: 0xb0a690,
    conc: 0xccc6b6,
    boxes: [0xb49a6a, 0x7a7e5c, 0x9a5a3a],
    sign: { base: 'US ARMY', sub: 'FORWARD OPERATING BASE', fg: '#f4f0e0', bg: '#3b4a2f', border: '#d8c89a', mark: 'star', markColor: '#f4f0e0', num: 'BLDG' },
  },
  israel: {
    wall: 0xe2d4b0,
    wallTile: Tile.Stone,
    wall2: 0xd0c4a4,
    wall2Tile: Tile.Panel,
    roof: 0xc2baa4,
    pitch: 0xb0a888,
    roofStyle: 'flat',
    drab: 0x8e8a6c,
    trim: 0x5a5648,
    camo: [0x9e9a7e, 0x8a8668, 0x6e6a54, 0xb2ae92],
    camoTile: Tile.CamoA,
    bag: 0xcdb98e,
    ground: 0xc8b896,
    conc: 0xd8d0bc,
    boxes: [0xc8b48a, 0x8e8a6c, 0x5a6a7a],
    sign: { base: 'צה״ל', sub: 'בסיס צבאי', fg: '#1d3f8f', bg: '#f2efe4', border: '#1d3f8f', rtl: true, font: '"Noto Sans Hebrew", Arial, "DejaVu Sans", sans-serif', mark: 'magen', markColor: '#1d3f8f', num: 'מבנה' },
  },
  china: {
    wall: 0xdcdcd4,
    wallTile: Tile.Panel,
    wall2: 0x5e6c4a,
    wall2Tile: Tile.Paint,
    roof: 0x8e968a,
    pitch: 0x4e7a84,
    roofStyle: 'gable',
    drab: 0x56643e,
    trim: 0x3e4438,
    camo: [0x5d6b47, 0x3d4a2e, 0x26281e, 0x8a8462],
    camoTile: Tile.CamoB,
    bag: 0x9a9268,
    ground: 0x9a9888,
    conc: 0xc8c8c0,
    boxes: [0x5e6c4a, 0x8a3a2a, 0x3a5a7a],
    sign: { base: '中国人民解放军', sub: '八一', fg: '#f8d84a', bg: '#a8201a', border: '#f8d84a', font: '"Noto Sans CJK SC", "WenQuanYi Zen Hei", "Microsoft YaHei", sans-serif', mark: 'star', markColor: '#f8d84a', num: '营' },
  },
  russia: {
    wall: 0xaeb0a2,
    wallTile: Tile.Panel,
    wall2: 0x5a6a40,
    wall2Tile: Tile.Paint,
    roof: 0x7e8072,
    pitch: 0x6c7660,
    roofStyle: 'gable',
    drab: 0x4e5c38,
    trim: 0x3a3c34,
    camo: [0x56663e, 0x3e4a2c, 0x26261c, 0x8a8060],
    camoTile: Tile.CamoA,
    bag: 0x8a8462,
    ground: 0x8a887a,
    conc: 0xb4b2a8,
    boxes: [0x5a6a40, 0x7a3a2a, 0x40566e],
    camoHalls: true,
    sign: { base: 'ВОЙСКОВАЯ ЧАСТЬ', sub: '№ 45321', fg: '#f0e8d0', bg: '#2e4a2e', border: '#c8b060', mark: 'star', markColor: '#d02818', num: 'КОРП' },
  },
  germany: {
    wall: 0xa4a8a0,
    wallTile: Tile.Panel,
    wall2: 0x4e5c40,
    wall2Tile: Tile.Clad,
    roof: 0x70746c,
    pitch: 0x5e665a,
    roofStyle: 'flat',
    drab: 0x4b5640,
    trim: 0x34382f,
    camo: [0x7a7c5a, 0x4b5a38, 0x5e4a36, 0x1f2018],
    camoTile: Tile.CamoC,
    bag: 0x8e8866,
    ground: 0x96968a,
    conc: 0xbcbcb4,
    boxes: [0x4e5c40, 0x8a8a7c, 0x6a4e36],
    camoHalls: true,
    sign: { base: 'BUNDESWEHR', sub: 'KASERNE', fg: '#141414', bg: '#f2f2ec', border: '#141414', mark: 'cross', markColor: '#141414', num: 'GEB' },
  },
  korea: {
    wall: 0xd0d0c6,
    wallTile: Tile.Panel,
    wall2: 0x56643e,
    wall2Tile: Tile.Paint,
    roof: 0x8e9488,
    pitch: 0x3e6a8a,
    roofStyle: 'hip',
    drab: 0x505c3a,
    trim: 0x34382e,
    camo: [0x6a7050, 0x4a5236, 0x2c2e24, 0x8c8466],
    camoTile: Tile.CamoB,
    bag: 0x928c66,
    ground: 0x9a988a,
    conc: 0xc6c6be,
    boxes: [0x56643e, 0x3a6a9a, 0xa83a2a],
    sign: { base: '대한민국 육군', sub: 'ROK ARMY', fg: '#ffffff', bg: '#1f3f2a', border: '#e0c050', font: '"Noto Sans CJK KR", "WenQuanYi Zen Hei", "Malgun Gothic", sans-serif', mark: 'taeguk', num: '동' },
  },
  ukraine: {
    wall: 0xb8b6a8,
    wallTile: Tile.Panel,
    wall2: 0x5f6a3e,
    wall2Tile: Tile.Paint,
    roof: 0x727866,
    pitch: 0x606a54,
    roofStyle: 'gable',
    drab: 0x56603a,
    trim: 0x34362c,
    camo: [0x5f6a3e, 0x464f2e, 0x2c2e22, 0x857a58],
    camoTile: Tile.CamoB,
    bag: 0x8a8462,
    ground: 0x8e8c7c,
    conc: 0xb8b6ac,
    boxes: [0x5f6a3e, 0x2a5aa0, 0x8a6a3a],
    camoHalls: true,
    sign: { base: 'ЗСУ', sub: 'ЗБРОЙНІ СИЛИ УКРАЇНИ', fg: '#f6d43a', bg: '#1f4fa0', border: '#f6d43a', mark: 'trident', markColor: '#f6d43a', num: 'БУД' },
  },
  turkey: {
    wall: 0xd8ccb2,
    wallTile: Tile.Plaster,
    wall2: 0x6b7356,
    wall2Tile: Tile.Paint,
    roof: 0xa49a82,
    pitch: 0x8a5a3a,
    roofStyle: 'flat',
    drab: 0x5e6448,
    trim: 0x3e3e34,
    camo: [0x6b7356, 0x4a5040, 0x2a2c24, 0x8c8a70],
    camoTile: Tile.CamoA,
    bag: 0xa89a74,
    ground: 0xaaa090,
    conc: 0xccc4b0,
    boxes: [0x6b7356, 0xb8202e, 0xc8b48a],
    sign: { base: 'TSK', sub: 'TÜRK SİLAHLI KUVVETLERİ', fg: '#ffffff', bg: '#c8102e', border: '#ffffff', mark: 'crescent', markColor: '#ffffff', num: 'BİNA' },
  },
  iran: {
    wall: 0xcbb68c,
    wallTile: Tile.Plaster,
    wall2: 0xb09870,
    wall2Tile: Tile.Stone,
    roof: 0xb0a07e,
    pitch: 0x9a8a6a,
    roofStyle: 'flat',
    drab: 0x8a7552,
    trim: 0x4e4234,
    camo: [0xb19a6c, 0x8a7552, 0x6a5a40, 0xc8b48a],
    camoTile: Tile.CamoA,
    bag: 0xc4ad80,
    ground: 0xc0aa84,
    conc: 0xd4c6a8,
    boxes: [0xb19a6c, 0x5a6a48, 0x2f6a5a],
    sign: { base: 'ارتش', sub: 'جمهوری اسلامی ایران', fg: '#ffffff', bg: '#2a5a32', border: '#e8e0c8', rtl: true, font: '"Noto Naskh Arabic", "Noto Sans Arabic", Tahoma, "DejaVu Sans", sans-serif', mark: 'disc', markColor: '#d8202a', num: 'ساختمان' },
  },
  neutral: {
    wall: 0xd6d2c6,
    wallTile: Tile.Panel,
    wall2: 0xb8bcc0,
    wall2Tile: Tile.Clad,
    roof: 0x9a9890,
    pitch: 0x8a8e90,
    roofStyle: 'flat',
    drab: 0x7a7a70,
    trim: 0x4a4c4e,
    camo: [0x8a8070, 0x6e6658, 0x4a463c, 0xa49a88],
    camoTile: Tile.CamoA,
    bag: 0xb0a07c,
    ground: 0xa8a49a,
    conc: 0xc8c6be,
    boxes: [0x3a6a9a, 0xb8a27a, 0x8a3a2a],
    sign: { base: 'CIVIL', sub: '', fg: '#ffffff', bg: '#3a4a5a', border: '#ffffff', num: 'NO' },
  },
};

for (const n of Object.values(NATIONS)) {
  // hardstand gravel a touch lighter than the concrete so structures stand out from their apron
  n.ground = shade(n.ground, 1.08);
}

function nationOf(s: ModelStyle): Nation {
  return NATIONS[s.faction] ?? NATIONS.neutral;
}

// ================================================================ palette

/** Material palette of one owner (nation paint + team colour). */
interface Pal {
  R: Region;
  N: Nation;
  wall: SMat; // main facade
  wall2: SMat; // secondary facade (cladding / paint)
  wallB: SMat; // slight colour variation of the main wall
  base: SMat; // plinth / dark concrete
  trim: SMat; // coping, cornices, frames
  roof: SMat; // flat roof surface
  pitch: SMat; // pitched roof cladding
  slab: SMat; // ground hardstand
  asphalt: SMat;
  concrete: SMat; // neutral cast concrete (barriers, pads, foundations)
  panel: SMat; // precast concrete panels (T-walls, bunkers)
  team: SMat;
  teamD: SMat;
  accent: SMat; // nation drab paint (doors, gates, sheds)
  drab: SMat; // nation drab, steel
  steel: SMat;
  galv: SMat; // galvanised steel (light)
  dark: SMat;
  black: SMat;
  rubber: SMat;
  glass: SMat; // reflective non-emissive glass
  win: SMat; // punched windows (lit)
  winC: SMat; // curtain wall (lit)
  door: SMat; // door leaves
  rollup: SMat; // roll-up door
  white: SMat;
  yellow: SMat;
  red: SMat;
  hazard: SMat;
  sandbag: SMat;
  hesco: SMat;
  wood: SMat;
  canvas: SMat;
  grating: SMat;
  rust: SMat;
  corr: SMat; // corrugated metal (clean)
  corrRust: SMat; // corrugated metal (weathered)
  brick: SMat;
  tank: SMat; // painted storage tanks
  pipe: SMat;
  crane: SMat; // crane / machinery paint
  green: SMat; // vegetation
  soil: SMat;
  camo: SMat; // nation camo paint
  net: SMat; // camo net (alpha)
  lamp: SMat; // warm lamp glow
  flood: SMat; // cold white floodlight
  red_l: SMat; // red aviation light
  green_l: SMat;
  cyan_l: SMat;
  amber_l: SMat;
  chain: SMat;
  solar: SMat;
  aesa: SMat;
  tile: SMat; // decorative band (national accent)
  dome: SMat; // radome
  nation: SMat; // national accent colour (bold secondary band)
  clad: SMat; // composite / steel wall cladding (ribbed panels, bolt rows)
  pier: SMat; // dark structural trim: corner pilasters, plinths
  emb: SMat; // insignia decal atlas
  signs: SMat; // sign atlas
  mats: Mats;
  s: ModelStyle;
  T: TexSet;
}
type TexSet = ReturnType<typeof texSet>;
function texSet(M: Mats) {
  return {
    concrete: (tint: number, uv = 2.2) => M.at(Tile.Cast, mulHex(tint, 0xdedcd6, 1.1), uv * 0.6),
    concreteDark: (tint: number, uv = 2) => M.at(Tile.Panel, mulHex(tint, 0xc4c0b6, 1.1), uv * 0.6),
    plaster: (tint: number, uv = 2) => M.at(Tile.Plaster, tint, uv * 0.6),
    sandstone: (tint: number, uv = 2.5) => M.at(Tile.Stone, tint, uv * 0.55),
    brick: (tint: number, uv = 3) => M.at(Tile.Brick, tint, uv * 0.45),
    corr: (tint: number, uv = 3) => M.at(Tile.Corr, tint, uv * 0.5),
    corrRust: (tint: number, uv = 4) => M.at(Tile.Corr, mulHex(tint, 0xb0a490), uv * 0.45),
    panel: (tint: number, uv = 2.5) => M.at(Tile.Plate, tint, uv * 0.8),
    tiles: (tint: number, uv = 4) => M.at(Tile.RoofTile, tint, uv * 0.55),
    asphalt: (tint: number, uv = 1.5) => M.at(Tile.Asphalt, tint, uv * 0.8),
  };
}

function makePal(s: ModelStyle, fog: FogOfWar | null): Pal {
  return lazyObj<Pal>(palSpec(s, fog));
}

type Thunks<T> = { [K in keyof T]: () => T[K] };

/** Object whose properties are computed on first access (materials/textures are only created when used). */
function lazyObj<T extends object>(spec: Thunks<T>): T {
  const o = {} as T;
  for (const k of Object.keys(spec) as (keyof T)[]) {
    let done = false;
    let v: T[keyof T] | undefined;
    Object.defineProperty(o, k, {
      get: () => {
        if (!done) {
          v = spec[k]();
          done = true;
        }
        return v;
      },
      enumerable: true,
    });
  }
  return o;
}

function palSpec(s: ModelStyle, fog: FogOfWar | null): Thunks<Pal> {
  const N = nationOf(s);
  const M = new Mats(s, fog, N);
  const T = texSet(M);
  const team = M.col(s.team, 0.55, 0.2);
  team.userData.team = true;
  return {
    R: () => s.region,
    N: () => N,
    wall: () => M.at(N.wallTile, N.wall),
    wallB: () => M.at(N.wallTile, shade(N.wall, 0.92)),
    wall2: () => M.at(N.wall2Tile, N.wall2),
    base: () => M.at(Tile.Cast, shade(N.conc, 0.62)),
    trim: () => M.col(N.trim, 0.5, 0.4),
    roof: () => M.at(Tile.Roof, N.roof),
    pitch: () => (N.roofStyle === 'hip' ? M.at(Tile.RoofTile, N.pitch) : M.at(Tile.Corr, N.pitch)),
    slab: () => M.at(Tile.Soil, N.ground),
    asphalt: () => M.at(Tile.Asphalt, 0xe8e6e0),
    concrete: () => M.at(Tile.Cast, N.conc),
    panel: () => M.at(Tile.Panel, N.conc),
    team: () => team,
    teamD: () => {
      const m = M.col(shade(s.team, 0.6), 0.6, 0.2);
      m.userData.team = true;
      return m;
    },
    accent: () => M.col(N.drab, 0.7, 0.2),
    drab: () => M.col(N.drab, 0.6, 0.5),
    steel: () => M.col(0x6f757b, 0.45, 0.65),
    galv: () => M.col(0xa8adb0, 0.4, 0.75),
    dark: () => M.col(0x2c2f33, 0.75, 0.3),
    black: () => M.col(0x141516, 0.9, 0.1),
    rubber: () => M.col(0x1c1c1c, 0.95, 0),
    glass: () => M.col(0x3a5a74, 0.08, 0.85),
    white: () => M.col(0xe8e8e2, 0.75, 0.02),
    yellow: () => M.col(0xe0ae22, 0.7, 0.05),
    red: () => M.col(0xb3261e, 0.6, 0.1),
    hazard: () => M.at(Tile.Hazard, 0xffffff),
    sandbag: () => M.at(Tile.Bag, N.bag),
    hesco: () => M.at(Tile.Bag, mulHex(N.bag, 0xe8e0c8), 2.2),
    wood: () => M.at(Tile.Wood, 0xe8dcc8),
    canvas: () => M.at(Tile.Canvas, mulHex(N.drab, 0xffffff, 1.2)),
    grating: () => M.at(Tile.Grate, 0xc8ccd0),
    rust: () => M.at(Tile.Corr, 0xa06a48),
    soil: () => M.at(Tile.Soil, mulHex(N.ground, 0xb0a080)),
    corr: () => T.corr(0xd0d4d6),
    corrRust: () => T.corrRust(0xffffff),
    brick: () => T.brick(0xffffff),
    tank: () => M.col(mix(N.wall, 0xe8e8e0, 0.4), 0.5, 0.3),
    pipe: () => M.col(0x8c9196, 0.45, 0.6),
    crane: () => M.col(0xd8a422, 0.6, 0.3),
    green: () => M.col(0x3f6a2c, 0.9, 0),
    camo: () => M.at(N.camoTile, 0xffffff),
    net: () => M.net(),
    lamp: () => M.light(0xfff0c8, 2.8),
    flood: () => M.light(0xe8f0ff, 3.4),
    red_l: () => M.light(0xff2a1a, 3.2),
    green_l: () => M.light(0x30ff6a, 2.6),
    cyan_l: () => M.light(0x5fe0ff, 2.6),
    amber_l: () => M.light(0xffa21a, 3),
    chain: () => M.canvas('chain', texChain(), { alphaTest: 0.4, double: true, uv: 9, metal: 0.6, rough: 0.5 }),
    solar: () => M.at(Tile.Solar, 0xffffff, 5),
    aesa: () => M.at(Tile.Aesa, 0xd0d6d0, 5),
    win: () => M.win(false),
    winC: () => M.win(true),
    door: () => M.col(shade(N.drab, 0.85), 0.6, 0.45),
    rollup: () => M.at(Tile.Corr, mulHex(N.drab, 0xffffff, 1.5), 2.6),
    tile: () => M.col(s.accent, 0.6, 0.2),
    dome: () => M.col(0xeeeee8, 0.6, 0.05),
    nation: () => M.col(s.accent, 0.55, 0.2),
    clad: () => M.at(Tile.Clad, N.wall2),
    pier: () => M.col(N.trim, 0.6, 0.2),
    emb: () => M.decal(),
    signs: () => M.signs(),
    mats: () => M,
    s: () => s,
    T: () => T,
  };
}

// ================================================================ animation specs

type AnimSpec =
  | { k: 'spin'; n: string; ax: Ax; v: number }
  | { k: 'osc'; n: string; ax: Ax; a: number; f: number; p: number; b: number }
  | { k: 'slide'; n: string; ax: Ax; a: number; f: number; p: number; b: number }
  | { k: 'blink'; n: string; per: number; on: number; p: number }
  /** Driven by unit production (AnimState.produced): pos / rot ease by `a` while a unit rolls out; vis shows (and spins about ax at v) only then. */
  | { k: 'prod'; n: string; ax: Ax; a: number; mode: 'pos' | 'rot' | 'scl' | 'vis'; v?: number }
  | { k: 'pump'; crank: string; beam: string; rod: string; pit: string; G: P2; P: P2; r: number; R: number; Rf: number; amp: number; rodY: number };

interface Tpl {
  root: THREE.Group;
  specs: AnimSpec[];
  glow: Mat[];
  flags: SMat[];
  blinks: SMat[];
  emitters: Model['emitters'];
  height: number;
  size: { x: number; y: number; z: number };
  turret: boolean;
  muzzles: number;
  recoil: number;
  /** Construction / damage visuals (scaffolding, cuts, decals, damageFx, nightLights). */
  fx: FxTpl;
}

// ================================================================ build kit

const IDENT = new THREE.Matrix4();
const KEEP = new Set(['position', 'normal', 'uv']);
const WHITE = new THREE.Color(1, 1, 1);

/**
 * Collects primitives (transformed into the current frame) per target object
 * and material, and merges them into one mesh per (object, material).
 */
class Kit {
  readonly root = new THREE.Group();
  readonly specs: AnimSpec[] = [];
  readonly emitters: Model['emitters'] = [];
  height = 1;
  turret = false;
  muzzles = 0;
  recoil = 0;
  /** Roof roundels placed so far (one per building). */
  emb = 0;
  rnd: () => number;
  /** Walls, windows, lamps... recorded for the construction / damage visuals. */
  readonly rec: FxRec = newRec();
  private bins = new Map<THREE.Object3D, Map<Mat, THREE.BufferGeometry[]>>();
  /** Project texture UVs in the primitive's local frame instead of building space. */
  luv = false;
  /** Bake weathering data (streak depth) into uv1.y for root level atlas parts. */
  weather = true;
  /**
   * Vertical stretch of everything above the ground slab (root level only:
   * animated / turret parts keep their proportions, their pivots move up).
   * Makes the structures taller and chunkier relative to the units.
   */
  sy = 1;
  wy(y: number) {
    return y <= Y0 ? y : Y0 + (y - Y0) * this.sy;
  }
  private warp(geo: THREE.BufferGeometry) {
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, this.wy(p.getY(i)));
    const n = geo.attributes.normal;
    if (n)
      for (let i = 0; i < n.count; i++) {
        const x = n.getX(i);
        const y = n.getY(i) / this.sy;
        const z = n.getZ(i);
        const l = Math.hypot(x, y, z) || 1;
        n.setXYZ(i, x / l, y / l, z / l);
      }
  }
  local(fn: () => void) {
    const prev = this.luv;
    this.luv = true;
    try {
      fn();
    } finally {
      this.luv = prev;
    }
  }
  private T = new THREE.Matrix4();
  private cur: THREE.Object3D;
  constructor(
    readonly P: Pal,
    seed: number,
  ) {
    this.cur = this.root;
    this.rnd = rng(seed);
  }

  // ------------------------------------------------------------ frames
  /** Run fn in a local frame translated to (x,y,z) and rotated (Euler YXZ). */
  at(x: number, y: number, z: number, ry: number, fn: () => void, rx = 0, rz = 0, sc = 1) {
    const prev = this.T.clone();
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(sc, sc, sc));
    this.T.multiply(m);
    try {
      fn();
    } finally {
      this.T.copy(prev);
    }
  }
  /** Run fn with primitives going into another (animated) object, in its local space. */
  on(obj: THREE.Object3D, fn: () => void) {
    const prevT = this.T.clone();
    const prevC = this.cur;
    this.T.copy(IDENT);
    this.cur = obj;
    try {
      fn();
    } finally {
      this.T.copy(prevT);
      this.cur = prevC;
    }
  }
  /** New named child object of the current target at (x,y,z) in the current frame. */
  node(name: string, x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0): THREE.Object3D {
    const o = new THREE.Group();
    o.name = name;
    const m = this.T.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(1, 1, 1)));
    m.decompose(o.position, o.quaternion, o.scale);
    if (this.cur === this.root) o.position.y = this.wy(o.position.y);
    this.cur.add(o);
    return o;
  }
  muzzle(x: number, y: number, z: number) {
    this.node('muzzle' + this.muzzles++, x, y, z);
  }
  emit(x: number, y: number, z: number, kind: 'smoke' | 'steam' | 'spark' | 'fire') {
    const v = new THREE.Vector3(x, y, z).applyMatrix4(this.T);
    if (this.cur === this.root) v.y = this.wy(v.y);
    this.emitters.push({ pos: v, kind });
  }
  /** Record a point (current frame) into one of the fx record lists. */
  mark(list: 'elec' | 'blinks', x: number, y: number, z: number) {
    if (this.cur !== this.root) return;
    const v = new THREE.Vector3(x, y, z).applyMatrix4(this.T);
    this.rec[list].push(v.x, this.wy(v.y), v.z);
  }
  /** Current frame has no tilt and a quarter-turn yaw only (AABBs stay exact). */
  private axisAligned() {
    const e = this.T.elements;
    const z = (v: number) => Math.abs(v) < 1e-4;
    const o = (v: number) => Math.abs(Math.abs(v) - 1) < 1e-4;
    return z(e[1]) && z(e[4]) && z(e[6]) && z(e[9]) && o(e[5]) && ((o(e[0]) && z(e[2])) || (z(e[0]) && o(e[2])));
  }
  private recWall(m: Mat, w: number, h: number, d: number, x: number, y: number, z: number) {
    if (this.cur !== this.root || h < 0.1 || Math.max(w, d) < 0.15) return;
    const real = (m.userData.real as Mat | undefined) ?? m;
    if (real.userData.baseEI || !this.axisAligned()) return;
    const a = new THREE.Vector3(x - w / 2, y, z - d / 2).applyMatrix4(this.T);
    const b = new THREE.Vector3(x + w / 2, y + h, z + d / 2).applyMatrix4(this.T);
    this.rec.walls.push(Math.min(a.x, b.x), this.wy(Math.min(a.y, b.y)), Math.min(a.z, b.z), Math.max(a.x, b.x), this.wy(Math.max(a.y, b.y)), Math.max(a.z, b.z));
  }

  // ------------------------------------------------------------ core
  add(g: THREE.BufferGeometry, mv: Mat, uv?: number) {
    const m = (mv.userData.real as Mat | undefined) ?? mv;
    let geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const scale = uv ?? (mv.userData.uv as number | undefined) ?? 3;
    if (scale > 0 && this.luv) worldUV(geo, scale);
    geo.applyMatrix4(this.T);
    if (this.sy !== 1 && this.cur === this.root) this.warp(geo);
    if (scale > 0 && !this.luv) worldUV(geo, scale);
    else if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    for (const name of Object.keys(geo.attributes)) if (!KEEP.has(name)) geo.deleteAttribute(name);
    if (m.userData.atlas) {
      // atlas tile index per vertex (uv1.x; uv1 survives the fracture / wreck geometry rebuild)
      const tile = (mv.userData.tile as number | undefined) ?? 0;
      const n = geo.attributes.position.count;
      const arr = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) arr[i * 2] = tile;
      if (this.cur === this.root && !mv.userData.team && this.weather) {
        // weathering data (bldtex WEATHER_FRAG): 1 + depth below the top of this primitive, so run-off
        // streaks start under every parapet / sill / cabinet top; flat or tiny parts only get dirt
        const pa = geo.attributes.position;
        let top = -Infinity;
        let bot = Infinity;
        for (let i = 0; i < n; i++) {
          const y = pa.getY(i);
          if (y > top) top = y;
          if (y < bot) bot = y;
        }
        const tall = top - bot > 0.035;
        for (let i = 0; i < n; i++) arr[i * 2 + 1] = tall ? 1 + (top - pa.getY(i)) : 9;
      }
      geo.setAttribute('uv1', new THREE.BufferAttribute(arr, 2));
    }
    if ((m as SMat).vertexColors) {
      const c = (mv.userData.vc as THREE.Color | undefined) ?? WHITE;
      const n = geo.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        arr[i * 3] = c.r;
        arr[i * 3 + 1] = c.g;
        arr[i * 3 + 2] = c.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    }
    geo.clearGroups();
    geo.morphAttributes = {};
    if (this.cur === this.root && m.userData.baseEI && !(m as SMat).map) {
      // small lamp: remember it for the night lights
      geo.computeBoundingBox();
      const bb = geo.boundingBox!;
      const c = (mv.userData.vc as THREE.Color | undefined) ?? WHITE;
      this.rec.lamps.push((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2, c.r, c.g, c.b);
    }
    // small root-level parts (rails, bolts, props) go to a separate detail mesh the far-zoom LOD hides
    let target = this.cur;
    if (target === this.root && this.detailOk(m, mv)) {
      geo.computeBoundingSphere();
      if (geo.boundingSphere!.radius < 0.045) target = this.detailObj();
    }
    let bin = this.bins.get(target);
    if (!bin) {
      bin = new Map();
      this.bins.set(target, bin);
    }
    let list = bin.get(m);
    if (!list) {
      list = [];
      bin.set(m, list);
    }
    list.push(geo);
    geo = null as unknown as THREE.BufferGeometry;
  }

  private detail: THREE.Group | null = null;
  private detailObj() {
    if (!this.detail) {
      this.detail = new THREE.Group();
      this.detail.name = 'lod-detail';
      this.root.add(this.detail);
    }
    return this.detail;
  }
  /** Parts that may go to the far-zoom detail mesh: plain surfaces (no lamps, glass panes, team colour, decals). */
  private detailOk(m: Mat, mv: Mat) {
    if (mv.userData.team || m.userData.baseEI) return false;
    return !!m.userData.atlas;
  }

  /** Merge everything into meshes. */
  finish() {
    for (const [obj, bin] of this.bins) {
      for (const [m, src] of bin) {
        // coarse parts first: the geometry LODs are prefixes of the merged buffer (perf/lod.ts swaps them)
        const rad = new Map<THREE.BufferGeometry, number>();
        for (const g of src) {
          g.computeBoundingSphere();
          rad.set(g, g.boundingSphere!.radius);
        }
        const list = src.length > 1 ? [...src].sort((a, b) => rad.get(b)! - rad.get(a)!) : src;
        let geo: THREE.BufferGeometry | null = null;
        try {
          geo = list.length === 1 ? list[0] : mergeGeometries(list, false);
        } catch (e) {
          console.warn('building merge failed', e);
        }
        if (!geo) continue;
        if (list.length > 1) for (const g of list) g.dispose();
        geo.computeBoundingSphere();
        if (obj !== this.detail && list.length > 1) {
          let n1 = 0;
          let n2 = 0;
          for (const g of list) {
            const r = rad.get(g)!;
            const c = g.attributes.position.count;
            if (r >= LOD1_R) n1 += c;
            if (r >= LOD2_R) n2 += c;
          }
          const n = geo.attributes.position.count;
          lodStats.tris += n / 3;
          lodStats.lod1 += n1 / 3;
          lodStats.lod2 += n2 / 3;
          if (n1 < n * 0.97 && n > 600) registerLods(geo, [lodPrefix(geo, n1), lodPrefix(geo, n2)]);
        }
        const mesh = new THREE.Mesh(geo, m);
        const sm = m as SMat;
        const isGlow = (!!sm.userData.baseEI || !!sm.userData.blinkEI) && !sm.map;
        mesh.castShadow = !isGlow && !sm.alphaTest;
        mesh.receiveShadow = true;
        if (obj === this.detail) mesh.userData.lodDetail = true;
        obj.add(mesh);
      }
    }
    this.bins.clear();
  }

  // ------------------------------------------------------------ primitives
  /** Box with its base at y. */
  box(m: Mat, w: number, h: number, d: number, x: number, y: number, z: number, uv?: number) {
    this.recWall(m, w, h, d, x, y, z);
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y + h / 2, z);
    this.add(g, m, uv);
  }
  /** Box rotated about Y around its own centre. */
  boxR(m: Mat, w: number, h: number, d: number, x: number, y: number, z: number, ry: number, rx = 0, rz = 0, uv?: number) {
    this.at(x, y, z, ry, () => this.box(m, w, h, d, 0, 0, 0, uv), rx, rz);
  }
  /** Bevelled (rounded) box, base at y. */
  rbox(m: Mat, w: number, h: number, d: number, x: number, y: number, z: number, r = 0.015, uv?: number) {
    this.recWall(m, w, h, d, x, y, z);
    const g = new RoundedBoxGeometry(w, h, d, 1, Math.min(r, w / 2.01, h / 2.01, d / 2.01));
    g.translate(x, y + h / 2, z);
    this.add(g, m, uv);
  }
  /** Vertical cylinder, base at y. */
  cyl(m: Mat, r: number, h: number, x: number, y: number, z: number, seg = 12, rt = r, open = false, uv?: number) {
    const g = new THREE.CylinderGeometry(rt, r, h, seg, 1, open);
    g.translate(x, y + h / 2, z);
    this.add(g, m, uv);
  }
  /** Cylinder between two points. */
  tube(m: Mat, a: V3, b: V3, r: number, seg = 8, rb = r, uv?: number) {
    const va = new THREE.Vector3(...a);
    const vb = new THREE.Vector3(...b);
    const d = vb.clone().sub(va);
    const len = d.length();
    if (len < 1e-5) return;
    const g = new THREE.CylinderGeometry(rb, r, len, seg, 1, false);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    g.applyQuaternion(q);
    g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    this.add(g, m, uv);
  }
  /** Square-section bar between two points. */
  bar(m: Mat, a: V3, b: V3, t: number) {
    const va = new THREE.Vector3(...a);
    const vb = new THREE.Vector3(...b);
    const d = vb.clone().sub(va);
    const len = d.length();
    if (len < 1e-5) return;
    const g = new THREE.BoxGeometry(t, len, t);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
    g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    this.add(g, m, 0);
  }
  /** Polyline pipe with elbow joints. */
  pipe(m: Mat, pts: V3[], r: number, seg = 8) {
    for (let i = 0; i + 1 < pts.length; i++) this.tube(m, pts[i], pts[i + 1], r, seg);
    for (let i = 1; i + 1 < pts.length; i++) this.sph(m, r * 1.05, pts[i][0], pts[i][1], pts[i][2], seg, 6);
  }
  sph(m: Mat, r: number, x: number, y: number, z: number, ws = 12, hs = 8, uv?: number) {
    const g = new THREE.SphereGeometry(r, ws, hs);
    g.translate(x, y, z);
    this.add(g, m, uv);
  }
  /** Dome (part of a sphere) whose base circle sits at y. sy squashes vertically. */
  dome(m: Mat, r: number, x: number, y: number, z: number, seg = 20, rings = 8, sy = 1, uv?: number) {
    const g = new THREE.SphereGeometry(r, seg, rings, 0, TAU, 0, Math.PI / 2);
    g.scale(1, sy, 1);
    g.translate(x, y, z);
    this.add(g, m, uv);
  }
  /** Lathe about Y from (radius, y) points. */
  lathe(m: Mat, pts: P2[], x: number, y: number, z: number, seg = 20, uv?: number) {
    const g = new THREE.LatheGeometry(
      pts.map(([r, yy]) => new THREE.Vector2(Math.max(0.0005, r), yy)),
      seg,
    );
    g.translate(x, y, z);
    this.add(g, m, uv);
  }
  /** Torus lying flat (ring around Y). */
  ring(m: Mat, R: number, t: number, x: number, y: number, z: number, seg = 24) {
    const g = new THREE.TorusGeometry(R, t, 4, seg);
    g.rotateX(Math.PI / 2);
    g.translate(x, y, z);
    this.add(g, m, 0);
  }
  /** Profile in the XY plane extruded along Z (centred on z). */
  prism(m: Mat, pts: P2[], depth: number, x = 0, y = 0, z = 0, uv?: number, holes?: P2[][], bevel = 0) {
    const sh = shapeOf(pts);
    if (holes) for (const h of holes) sh.holes.push(new THREE.Path(h.map(([a, b]) => new THREE.Vector2(a, b))));
    const g = new THREE.ExtrudeGeometry(sh, {
      depth: depth - bevel * 2,
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelOffset: -bevel,
      bevelSegments: 1,
      curveSegments: 8,
    });
    g.translate(x, y, z - depth / 2 + bevel);
    this.add(g, m, uv);
  }
  /** Shape (with optional holes) in XY extruded along Z. */
  shape(m: Mat, sh: THREE.Shape, depth: number, x = 0, y = 0, z = 0, uv?: number) {
    const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false, curveSegments: 10 });
    g.translate(x, y, z - depth / 2);
    this.add(g, m, uv);
  }
  /** Plan outline (x,z) extruded up from y by h. */
  plan(m: Mat, pts: P2[], h: number, x = 0, y = 0, z = 0, bevel = 0, uv?: number) {
    const d = h - bevel * 2;
    const g = new THREE.ExtrudeGeometry(shapeOf(pts.map(([a, b]) => [a, -b] as P2)), {
      depth: Math.max(0.001, d),
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelOffset: -bevel,
      bevelSegments: 1,
    });
    g.rotateX(-Math.PI / 2);
    g.translate(x, y + bevel, z);
    this.add(g, m, uv);
  }
  /** Flat quad from 4 corners (counter-clockwise seen from the front), with explicit UVs. */
  quad(m: Mat, a: V3, b: V3, c: V3, d: V3, uv: number[] = [0, 0, 1, 1]) {
    const g = new THREE.BufferGeometry();
    const p = new Float32Array([...a, ...b, ...c, ...a, ...c, ...d]);
    let t: Float32Array;
    if (uv.length === 8) {
      const [au, av, bu, bv, cu, cv, du, dv] = uv;
      t = new Float32Array([au, av, bu, bv, cu, cv, au, av, cu, cv, du, dv]);
    } else {
      const [u0, v0, u1, v1] = uv;
      t = new Float32Array([u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1]);
    }
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(t, 2));
    g.computeVertexNormals();
    this.add(g, m, 0);
  }
  /** Vertical quad facing +Z (centre x, base y, at z) or, with face 'x', facing +X. sign flips to -Z/-X. */
  panel(m: Mat, face: 'x' | 'z', sign: number, c: number, y: number, at: number, w: number, h: number, uv: number[] = [0, 0, 1, 1]) {
    const real = (m.userData.real as Mat | undefined) ?? m;
    if (this.cur === this.root && (real as SMat).emissiveMap) {
      // lit window pane: remember it for soot streaks / broken glass
      const p = (face === 'z' ? new THREE.Vector3(c, y, at) : new THREE.Vector3(at, y, c)).applyMatrix4(this.T);
      const n = (face === 'z' ? new THREE.Vector3(0, 0, sign) : new THREE.Vector3(sign, 0, 0)).transformDirection(this.T);
      if (Math.abs(n.y) < 0.1) this.rec.wins.push(p.x, this.wy(p.y), p.z, n.x, n.z, w, h * this.sy);
    }
    const a = c - w / 2;
    const b = c + w / 2;
    if (face === 'z') {
      if (sign > 0) this.quad(m, [a, y, at], [b, y, at], [b, y + h, at], [a, y + h, at], uv);
      else this.quad(m, [b, y, at], [a, y, at], [a, y + h, at], [b, y + h, at], uv);
    } else {
      if (sign > 0) this.quad(m, [at, y, b], [at, y, a], [at, y + h, a], [at, y + h, b], uv);
      else this.quad(m, [at, y, a], [at, y, b], [at, y + h, b], [at, y + h, a], uv);
    }
  }
  /** Horizontal decal quad on the ground (y), centred, w along x, d along z. */
  decal(m: Mat, x: number, y: number, z: number, w: number, d: number, uv: [number, number, number, number] = [0, 0, 1, 1], ry = 0) {
    this.at(x, y, z, ry, () => this.quad(m, [-w / 2, 0, d / 2], [w / 2, 0, d / 2], [w / 2, 0, -d / 2], [-w / 2, 0, -d / 2], uv));
  }
  /** Custom indexed geometry. */
  mesh(m: Mat, pos: number[], idx: number[], uvs?: number[], uv?: number) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    if (uvs) g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    this.add(g, m, uvs ? 0 : uv);
  }

  // ------------------------------------------------------------ anim helpers
  spin(n: string, ax: Ax, v: number) {
    this.specs.push({ k: 'spin', n, ax, v });
  }
  osc(n: string, ax: Ax, a: number, f: number, p = 0, b = 0) {
    this.specs.push({ k: 'osc', n, ax, a, f, p, b });
  }
  /**
   * Aviation obstruction light. All of an owner's obstruction lights share one emissive material that the
   * instances flash in sync (like a real synchronised obstruction lighting system), so they merge into the
   * static geometry instead of costing a draw call each. Animated parts keep a per-node blinker.
   */
  blinkLight(x: number, y: number, z: number, r = 0.022, per = 1.4, p = 0) {
    if (this.cur === this.root) {
      this.mark('blinks', x, y, z);
      this.sph(this.P.mats.blink(), r, x, y, z, 8, 6);
      return;
    }
    const n = 'blink' + this.specs.length;
    const o = this.node(n, x, y, z);
    this.on(o, () => this.sph(this.P.red_l, r, 0, 0, 0, 8, 6));
    this.specs.push({ k: 'blink', n, per, on: 0.45, p });
  }
}

/**
 * Geometry LODs of the merged building meshes (perf/lod.ts picks them from the on-screen size, like the
 * vehicles): LOD1 (battle zoom) leaves out the small fittings (bolts, brackets, lamps' housings, rails),
 * LOD2 (far) keeps the silhouette parts only. The parts are merged coarse-first, so a LOD is an index
 * prefix sharing the full buffer's attributes (no extra vertex memory).
 */
const LOD1_R = 0.06;
const LOD2_R = 0.16;
/** Merged / LOD1 / LOD2 triangle totals of every building template built so far (debug / perf report). */
export const lodStats = { tris: 0, lod1: 0, lod2: 0 };
(globalThis as { __bldLod?: typeof lodStats }).__bldLod = lodStats;
function lodPrefix(geo: THREE.BufferGeometry, n: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(geo.attributes)) g.setAttribute(name, a);
  const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.boundingSphere = geo.boundingSphere;
  g.name = geo.name;
  return g;
}

function shapeOf(pts: P2[]): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  return s;
}
const rect = (w: number, d: number, cx = 0, cz = 0): P2[] => [
  [cx - w / 2, cz - d / 2],
  [cx + w / 2, cz - d / 2],
  [cx + w / 2, cz + d / 2],
  [cx - w / 2, cz + d / 2],
];
const regular = (n: number, r: number, rot = 0): P2[] => {
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * TAU;
    out.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return out;
};

/** Multiply a geometry's UVs (for primitives whose own UV layout is kept). */
function scaleUV<T extends THREE.BufferGeometry>(g: T, su: number, sv: number): T {
  const uv = g.attributes.uv;
  if (uv) for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return g;
}

// ================================================================ architecture helpers

/** Slab top height (the ground apron under every building). */
const Y0 = 0.04;
type Face = 'x' | 'z';

function slab(k: Kit, w: number, d: number, h = Y0, notch?: [number, number, number], m?: Mat) {
  const W = w / 2 - 0.012;
  const D = d / 2 - 0.012;
  const pts: P2[] = notch
    ? [
        [-W, -D],
        [W, -D],
        [W, D],
        [notch[1], D],
        [notch[1], notch[2]],
        [notch[0], notch[2]],
        [notch[0], D],
        [-W, D],
      ]
    : rect(W * 2, D * 2);
  k.plan(m ?? k.P.slab, pts, h, 0, 0, 0, 0.008);
}

/** Random window cell(s) of the 8x4 window texture: n columns, rows rows. */
function cell(k: Kit, n = 1, rows = 1): number[] {
  const u0 = Math.floor(k.rnd() * 8) / 8;
  const v0 = Math.floor(k.rnd() * 4) / 4;
  return [u0, v0, u0 + n / 8, v0 + rows / 4];
}

/** Box placed against a face: `a` along the face, `out` = protrusion outward from the face plane `at`. */
function faceBox(k: Kit, m: Mat, face: Face, sign: number, a: number, y: number, at: number, w: number, h: number, out: number, uv?: number) {
  if (face === 'z') k.box(m, w, h, out, a, y, at + (sign * out) / 2, uv);
  else k.box(m, out, h, w, at + (sign * out) / 2, y, a, uv);
}

/** Pointed (two-centred) arch outline: rectangle from yb to yb+hs topped by a pointed arch. */
function archPts(xc: number, yb: number, w: number, hs: number, pointed = 0.4, steps = 5): P2[] {
  const R = (w / 2) * (1 + pointed);
  const off = (w / 2) * pointed;
  const tmax = Math.acos(Math.min(1, off / R));
  const out: P2[] = [
    [xc - w / 2, yb],
    [xc + w / 2, yb],
  ];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * tmax;
    out.push([xc - off + R * Math.cos(t), yb + hs + R * Math.sin(t)]);
  }
  for (let i = steps - 1; i >= 0; i--) {
    const t = (i / steps) * tmax;
    out.push([xc + off - R * Math.cos(t), yb + hs + R * Math.sin(t)]);
  }
  return out;
}
/** Round (semicircular) arch outline. */
function roundArchPts(xc: number, yb: number, w: number, hs: number, steps = 7): P2[] {
  const out: P2[] = [
    [xc - w / 2, yb],
    [xc + w / 2, yb],
  ];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI;
    out.push([xc + (Math.cos(t) * w) / 2, yb + hs + (Math.sin(t) * w) / 2]);
  }
  return out;
}

/** Row of punched windows on a facade. */
function punched(k: Kit, face: Face, sign: number, a0: number, a1: number, n: number, y: number, at: number, ww: number, wh: number, style: 'plain' | 'arch' | 'mash' | 'round' = 'plain', skip?: [number, number]) {
  const P = k.P;
  for (let i = 0; i < n; i++) {
    const c = a0 + ((a1 - a0) * (i + 0.5)) / n;
    if (skip && c + ww / 2 > skip[0] && c - ww / 2 < skip[1]) continue;
    if (style === 'mash') {
      // projecting wooden mashrabiya bay
      faceBox(k, P.trim, face, sign, c, y - 0.015, at, ww + 0.03, 0.012, 0.035);
      faceBox(k, P.accent, face, sign, c, y - 0.003, at, ww + 0.016, wh + 0.01, 0.02);
      for (let j = 0; j < 4; j++) faceBox(k, P.dark, face, sign, c, y + 0.006 + (j * wh) / 4, at, ww + 0.01, 0.006, 0.026);
      continue;
    }
    const off = sign * 0.003;
    k.panel(P.win, face, sign, c, y, at + off, ww, wh, cell(k));
    faceBox(k, P.trim, face, sign, c, y - 0.012, at, ww + 0.024, 0.012, 0.024);
    if (style === 'plain') faceBox(k, P.trim, face, sign, c, y + wh, at, ww + 0.014, 0.01, 0.014);
    else {
      // arched head: glass tympanum + stone hood
      const pts = style === 'arch' ? archPts(0, 0, ww, 0, 0.45, 4).slice(2) : roundArchPts(0, 0, ww, 0, 6).slice(2);
      const head = [[-ww / 2, 0] as P2, ...pts.reverse(), [ww / 2, 0] as P2].reverse();
      const outer = (style === 'arch' ? archPts(0, 0, ww + 0.03, 0, 0.45, 4) : roundArchPts(0, 0, ww + 0.03, 0, 6)).slice(1);
      const ry = face === 'z' ? (sign > 0 ? 0 : Math.PI) : sign > 0 ? Math.PI / 2 : -Math.PI / 2;
      const px = face === 'z' ? c : at;
      const pz = face === 'z' ? at : c;
      k.at(px, y + wh, pz, ry, () => {
        k.prism(P.glass, head, 0.008, 0, 0, 0.002);
        k.prism(P.trim, outer, 0.012, 0, 0.001, 0.004, undefined, [head.map(([a, b]) => [a * 0.98, b * 0.98 - 0.001] as P2)]);
      });
    }
  }
}

/** Continuous ribbon window on a facade. */
function ribbon(k: Kit, face: Face, sign: number, a0: number, a1: number, y: number, at: number, h: number, curtain = false, skip?: [number, number]) {
  const P = k.P;
  const seg = (s0: number, s1: number) => {
    if (s1 - s0 < 0.05) return;
    const n = Math.max(1, Math.round((s1 - s0) / 0.1));
    k.panel(curtain ? P.winC : P.win, face, sign, (s0 + s1) / 2, y, at + sign * 0.003, s1 - s0, h, cell(k, n));
    faceBox(k, P.trim, face, sign, (s0 + s1) / 2, y - 0.01, at, s1 - s0 + 0.01, 0.01, 0.02);
    faceBox(k, P.trim, face, sign, (s0 + s1) / 2, y + h, at, s1 - s0 + 0.01, 0.008, 0.012);
  };
  if (skip) {
    seg(a0, Math.min(a1, skip[0] - 0.02));
    seg(Math.max(a0, skip[1] + 0.02), a1);
  } else seg(a0, a1);
}

/** Personnel door with team coloured frame, canopy and lamp. */
function door(k: Kit, face: Face, sign: number, c: number, y: number, at: number, w = 0.11, h = 0.19, canopy = true) {
  const P = k.P;
  k.panel(P.door, face, sign, c, y, at + sign * 0.004, w, h);
  if (w > 0.1) faceBox(k, P.black, face, sign, c, y, at, 0.006, h, 0.006);
  faceBox(k, P.team, face, sign, c - w / 2 - 0.008, y, at, 0.016, h + 0.016, 0.014);
  faceBox(k, P.team, face, sign, c + w / 2 + 0.008, y, at, 0.016, h + 0.016, 0.014);
  faceBox(k, P.team, face, sign, c, y + h, at, w + 0.032, 0.016, 0.014);
  // step
  faceBox(k, P.concrete, face, sign, c, y - 0.02, at, w + 0.06, 0.02, 0.05);
  if (canopy) {
    faceBox(k, P.dark, face, sign, c, y + h + 0.03, at, w + 0.08, 0.012, 0.07);
    faceBox(k, P.lamp, face, sign, c, y + h + 0.022, at + sign * 0.035, 0.04, 0.008, 0.012);
  }
}

/** Roll-up vehicle door with hazard striped jambs and a team header. */
function rollDoor(k: Kit, face: Face, sign: number, c: number, y: number, at: number, w: number, h: number, open = 0) {
  const P = k.P;
  const hh = h * (1 - open);
  const s = 9;
  if (hh > 0.01) k.panel(P.rollup, face, sign, c, y + h - hh, at + sign * 0.004, w, hh, [0, 0, 0, w * s, hh * s, w * s, hh * s, 0]);
  if (open > 0) k.panel(P.black, face, sign, c, y, at + sign * 0.002, w, h - hh);
  faceBox(k, P.hazard, face, sign, c - w / 2 - 0.016, y, at, 0.032, h, 0.024);
  faceBox(k, P.hazard, face, sign, c + w / 2 + 0.016, y, at, 0.032, h, 0.024);
  faceBox(k, P.team, face, sign, c, y + h, at, w + 0.064, 0.04, 0.026);
  faceBox(k, P.dark, face, sign, c, y + h + 0.04, at, w + 0.02, 0.03, 0.04);
  faceBox(k, P.amber_l, face, sign, c + w / 2 + 0.016, y + h + 0.045, at + sign * 0.02, 0.018, 0.018, 0.018);
}

/** Flat roof membrane, parapet and coping (or crenellations in the Middle East). */
function flatRoof(k: Kit, x0: number, x1: number, z0: number, z1: number, y: number, ph = 0.04, pm?: Mat) {
  const P = k.P;
  const W = x1 - x0;
  const D = z1 - z0;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const t = 0.02;
  k.box(P.roof, W - 0.02, 0.01, D - 0.02, cx, y, cz);
  const m = pm ?? P.wall;
  k.box(m, W, ph, t, cx, y, z1 - t / 2);
  k.box(m, W, ph, t, cx, y, z0 + t / 2);
  k.box(m, t, ph, D - 2 * t, x1 - t / 2, y, cz);
  k.box(m, t, ph, D - 2 * t, x0 + t / 2, y, cz);
  {
    // team coloured coping: outlines every roof in the owner's colour from above
    const ct = P.team;
    const ch = 0.014;
    k.box(ct, W + 0.016, ch, t + 0.016, cx, y + ph, z1 - t / 2);
    k.box(ct, W + 0.016, ch, t + 0.016, cx, y + ph, z0 + t / 2);
    k.box(ct, t + 0.016, ch, D - 2 * t, x1 - t / 2, y + ph, cz);
    k.box(ct, t + 0.016, ch, D - 2 * t, x0 + t / 2, y + ph, cz);
    k.box(P.pier, W + 0.018, 0.006, t + 0.018, cx, y + ph - 0.006, z1 - t / 2);
    k.box(P.pier, t + 0.018, 0.006, D + 0.018, x1 - t / 2, y + ph - 0.006, cz);
    if (W * D > 0.3) {
      // safety rail along the back and left edges (roof access side)
      const yr = y + ph + ch;
      const pts: P2[] = [
        [x0 + 0.012, z1 - 0.06],
        [x0 + 0.012, z0 + 0.012],
        [x1 - 0.06, z0 + 0.012],
      ];
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, az] = pts[i];
        const [bx, bz] = pts[i + 1];
        const n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / 0.16));
        for (let j = 0; j <= n; j++) {
          if (j === 0 && i > 0) continue;
          k.box(P.yellow, 0.005, 0.045, 0.005, ax + ((bx - ax) * j) / n, yr, az + ((bz - az) * j) / n);
        }
        k.bar(P.yellow, [ax, yr + 0.045, az], [bx, yr + 0.045, bz], 0.006);
      }
    }
  }
}

/**
 * National roundel painted on a flat roof (dark field with a team coloured
 * frame), in the front part of the roof. Returns false when the roof is too small.
 */
function roofEmblem(k: Kit, x0: number, x1: number, z0: number, z1: number, y: number): boolean {
  const P = k.P;
  const f = P.s.faction;
  const W = x1 - x0;
  const D = z1 - z0;
  const sz = Math.min(W * 0.4, D * 0.38, 0.32);
  if (f === 'neutral' || sz < 0.2 || k.emb > 0) return false;
  k.emb++;
  const cell = roundelCell(f);
  const ew = cell.aspect > 1.4 ? Math.min(W - 0.12, sz * 1.7) : sz;
  const cx = x0 + W * 0.5;
  const cz = z1 - D * 0.08 - sz / 2 - 0.04;
  k.box(P.dark, ew + 0.03, 0.004, sz + 0.03, cx, y, cz);
  const fr = 0.016;
  k.box(P.team, ew + 0.05, 0.006, fr, cx, y, cz + sz / 2 + 0.018);
  k.box(P.team, ew + 0.05, 0.006, fr, cx, y, cz - sz / 2 - 0.018);
  k.box(P.team, fr, 0.006, sz + 0.02, cx + ew / 2 + 0.018, y, cz);
  k.box(P.team, fr, 0.006, sz + 0.02, cx - ew / 2 - 0.018, y, cz);
  const dh = cell.aspect > 1.4 ? Math.min(sz * 0.9, (ew * 0.92) / cell.aspect) : sz * 0.86;
  k.decal(P.emb, cx, y + 0.0055, cz, dh * cell.aspect, dh, cell.r);
  return true;
}

/** Flag sign board on a wall: team frame, dark backing, national flag. */
function wallEmblem(k: Kit, face: Face, sign: number, c: number, y: number, at: number, w: number, cell?: Cell) {
  const P = k.P;
  if (P.s.faction === 'neutral') return;
  const cl = cell ?? flagPatchCell(P.s.faction);
  const h = w / cl.aspect;
  faceBox(k, P.team, face, sign, c, y - 0.016, at, w + 0.04, h + 0.032, 0.012);
  faceBox(k, P.dark, face, sign, c, y - 0.008, at, w + 0.016, h + 0.016, 0.016);
  k.panel(P.emb, face, sign, c, y, at + sign * 0.0175, w, h, cl.r);
}

/**
 * Exterior dressing of a rectangular structure on its visible faces (+Z, +X):
 * dark corner pilasters with hazard striped bases, wall-pack lamps, a utility
 * cabinet with its conduit, a louvred vent and roof-corner warning lights.
 */
function dress(k: Kit, x0: number, x1: number, z0: number, z1: number, y0: number, h: number, o: { cab?: boolean; vent?: boolean; beacons?: boolean } = {}) {
  const P = k.P;
  const W = x1 - x0;
  const D = z1 - z0;
  if (W < 0.25 || D < 0.25 || h < 0.12) return;
  const pw = 0.034;
  // corner pilasters (the three corners the camera sees)
  for (const [px, pz] of [
    [x1, z1],
    [x0, z1],
    [x1, z0],
  ] as P2[]) {
    k.box(P.pier, pw, h + 0.004, pw, px - Math.sign(px - (x0 + x1) / 2) * (pw / 2 - 0.008), y0, pz - Math.sign(pz - (z0 + z1) / 2) * (pw / 2 - 0.008));
  }
  // impact-protection stripes at the exposed corner
  k.box(P.hazard, pw + 0.006, 0.07, pw + 0.006, x1 - pw / 2 + 0.008, y0, z1 - pw / 2 + 0.008, 9);
  // wall-pack lamps under the first floor line
  const ly = y0 + Math.min(h * 0.86, 0.21);
  for (const a of W > 0.6 ? [x0 + 0.1, x1 - 0.1] : [(x0 + x1) / 2]) {
    faceBox(k, P.dark, 'z', 1, a, ly, z1, 0.034, 0.022, 0.02);
    faceBox(k, P.lamp, 'z', 1, a, ly - 0.004, z1 + 0.004, 0.026, 0.005, 0.016);
  }
  for (const a of D > 0.6 ? [z0 + 0.1, z1 - 0.1] : [(z0 + z1) / 2]) {
    faceBox(k, P.dark, 'x', 1, a, ly, x1, 0.034, 0.022, 0.02);
    faceBox(k, P.lamp, 'x', 1, a, ly - 0.004, x1 + 0.004, 0.026, 0.005, 0.016);
  }
  if (o.cab !== false && D > 0.35) {
    // electrical cabinet + conduit up to the roof on the +X face
    const cz = z0 + 0.08;
    faceBox(k, P.galv, 'x', 1, cz, y0, x1, 0.07, 0.1, 0.03);
    faceBox(k, P.team, 'x', 1, cz, y0 + 0.08, x1 + 0.0005, 0.072, 0.012, 0.031);
    faceBox(k, P.green_l, 'x', 1, cz + 0.022, y0 + 0.064, x1 + 0.03, 0.008, 0.008, 0.004);
    k.box(P.steel, 0.012, h - 0.1, 0.012, x1 + 0.009, y0 + 0.1, cz - 0.022);
    for (let yy = y0 + 0.16; yy < y0 + h - 0.04; yy += 0.12) k.box(P.dark, 0.016, 0.006, 0.02, x1 + 0.009, yy, cz - 0.022);
  }
  if (o.vent !== false && W > 0.45) {
    // louvred intake on the +Z face, high up
    const vx = x0 + 0.13;
    const vy = y0 + h - 0.11;
    faceBox(k, P.pier, 'z', 1, vx, vy, z1, 0.1, 0.07, 0.014);
    for (let i = 0; i < 4; i++) faceBox(k, P.galv, 'z', 1, vx, vy + 0.008 + i * 0.015, z1 + 0.006, 0.084, 0.006, 0.014);
  }
  if (o.beacons !== false && D > 0.45) {
    // roof access ladder with safety cage + a pair of service pipes on the +X face
    ladder(k, 'x', 1, z1 - 0.2, y0, y0 + h, x1);
    for (let yy = y0 + 0.2; yy < y0 + h; yy += 0.07) k.ring(P.galv, 0.026, 0.002, x1 + 0.035, yy, z1 - 0.2, 8);
    for (const [py, r] of [
      [y0 + 0.045, 0.008],
      [y0 + 0.065, 0.006],
    ])
      k.tube(P.pipe, [x1 + 0.012, py, z0 + 0.13], [x1 + 0.012, py, z1 - 0.26], r, 6);
  }
  if (o.beacons !== false && h >= 0.32) {
    k.sph(P.red_l, 0.011, x1 - 0.012, y0 + h + 0.055, z1 - 0.012, 6, 4);
    k.sph(P.red_l, 0.011, x0 + 0.012, y0 + h + 0.055, z0 + 0.012, 6, 4);
  }
}

/** Rooftop air-conditioning unit with a fan grille. */
function hvac(k: Kit, x: number, y: number, z: number, w = 0.15, d = 0.11, ry = 0) {
  const P = k.P;
  k.at(x, y, z, ry, () => {
    k.box(P.dark, w + 0.01, 0.012, d + 0.01, 0, 0, 0);
    k.rbox(P.galv, w, 0.07, d, 0, 0.012, 0, 0.008);
    const n = w > 0.14 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      const fx = n === 1 ? 0 : (i - 0.5) * w * 0.5;
      k.cyl(P.black, d * 0.36, 0.004, fx, 0.082, 0);
      k.ring(P.dark, d * 0.36, 0.004, fx, 0.087, 0, 14);
      k.box(P.dark, d * 0.7, 0.004, 0.006, fx, 0.084, 0);
      k.box(P.dark, 0.006, 0.004, d * 0.7, fx, 0.084, 0);
    }
    k.box(P.dark, w * 0.9, 0.04, 0.004, 0, 0.022, d / 2 + 0.001);
  });
}

/** Mushroom roof vent. */
function vent(k: Kit, x: number, y: number, z: number, r = 0.022) {
  const P = k.P;
  k.cyl(P.galv, r, 0.05, x, y, z, 8);
  k.cyl(P.galv, r * 1.6, 0.014, x, y + 0.05, z, 8, r * 0.8);
}

/** Nation flavoured rooftop clutter on a flat roof. */
function roofKit(k: Kit, x0: number, x1: number, z0: number, z1: number, y: number, n = 2) {
  const P = k.P;
  const r = k.rnd;
  const W = x1 - x0;
  const D = z1 - z0;
  const px = (f: number) => x0 + 0.1 + (W - 0.2) * f;
  const pz = (f: number) => z0 + 0.1 + (D - 0.2) * f;
  switch (P.s.faction) {
    case 'israel':
      // solar water heaters (dud shemesh) + water tanks: the Israeli roofline
      for (let i = 0; i < n + 1; i++) {
        const xx = px((i + 0.5) / (n + 1));
        const zz = pz(0.3 + (i % 2) * 0.3);
        k.at(xx, y, zz, 0.2, () => {
          k.boxR(P.solar, 0.12, 0.008, 0.09, 0, 0.05, 0.03, 0, -0.7, 0, 6);
          k.box(P.galv, 0.006, 0.07, 0.006, -0.05, 0, -0.01);
          k.box(P.galv, 0.006, 0.07, 0.006, 0.05, 0, -0.01);
          k.at(0, 0.09, -0.035, 0, () => k.tube(P.white, [-0.06, 0, 0], [0.06, 0, 0], 0.022, 10));
        });
      }
      vent(k, px(0.9), y, pz(0.85));
      break;
    case 'russia':
    case 'ukraine':
      for (let i = 0; i < n; i++) {
        const xx = px((i + 0.5) / n);
        const zz = pz(0.3 + r() * 0.3);
        k.box(P.brick, 0.06, 0.12, 0.06, xx, y, zz);
        k.box(P.concrete, 0.075, 0.012, 0.075, xx, y + 0.12, zz);
      }
      k.pipe(P.rust, [[px(0.1), y + 0.03, pz(0.9)], [px(0.6), y + 0.03, pz(0.9)], [px(0.6), y + 0.03, pz(0.5)]], 0.01, 6);
      antenna(k, px(0.85), y, pz(0.2), 0.25);
      k.box(P.wall2, 0.16, 0.08, 0.12, px(0.2), y, pz(0.75));
      break;
    case 'china':
    case 'korea':
      for (let i = 0; i < n; i++) hvac(k, px((i + 0.5) / n), y, pz(0.3), 0.14, 0.1);
      // stainless water tank on a stand
      k.at(px(0.78), y, pz(0.78), 0, () => {
        for (const sx of [-1, 1]) k.box(P.steel, 0.012, 0.05, 0.08, sx * 0.05, 0, 0);
        k.tube(P.galv, [-0.08, 0.085, 0], [0.08, 0.085, 0], 0.04, 12);
      });
      break;
    case 'turkey':
    case 'iran':
      for (let i = 0; i < n + 1; i++) {
        const xx = px((i + 0.5) / (n + 1));
        const zz = pz(0.2 + r() * 0.4);
        const c = i % 2 ? P.black : P.white;
        k.box(P.steel, 0.07, 0.03, 0.07, xx, y, zz);
        k.cyl(c, 0.035, 0.07, xx, y + 0.03, zz, 12);
      }
      hvac(k, px(0.8), y, pz(0.8), 0.12, 0.09);
      satDish(k, px(0.15), y, pz(0.85), 0.05, 0.6);
      break;
    default: {
      // western roofs: HVAC packages, a photovoltaic array on big roofs (energy resilient bases), vents
      const pv = W > 0.7 && D > 0.55;
      for (let i = 0; i < n; i++) hvac(k, px((i + 0.5) / n), y, pz(pv ? 0.12 + r() * 0.12 : 0.25 + r() * 0.2), 0.16, 0.11, r() > 0.5 ? 0 : Math.PI / 2);
      if (pv) {
        const m = Math.max(2, Math.floor((W - 0.45) / 0.2));
        for (let i = 0; i < m; i++) solarPanel(k, x0 + 0.16 + i * 0.2, y, pz(0.74), 0.18, 0.12, 0.5);
        k.box(P.galv, 0.2 * (m - 1) + 0.02, 0.01, 0.025, x0 + 0.16 + 0.1 * (m - 1), y, pz(0.74) - 0.09);
      }
      vent(k, px(pv ? 0.93 : r()), y, pz(pv ? 0.42 : 0.8));
      vent(k, px(pv ? 0.96 : r()), y, pz(pv ? 0.54 : 0.7));
      if (W > 0.6) k.box(P.wall2, 0.14, 0.1, 0.12, px(0.85), y, pz(0.75)); // stair housing
    }
  }
}

/** Regional facade windows for a block. */
function facade(k: Kit, face: Face, sign: number, a0: number, a1: number, at: number, y0: number, H: number, floors: number, style: string, skip?: [number, number]) {
  const fh = H / floors;
  const L = a1 - a0;
  for (let f = 0; f < floors; f++) {
    const yf = y0 + f * fh;
    const sk = f === 0 ? skip : undefined;
    switch (style) {
      case 'ribbon':
        ribbon(k, face, sign, a0 + 0.05, a1 - 0.05, yf + fh * 0.36, at, fh * 0.4, false, sk);
        break;
      case 'ribbonC':
        ribbon(k, face, sign, a0 + 0.04, a1 - 0.04, yf + fh * 0.3, at, fh * 0.5, true, sk);
        break;
      case 'punched': {
        const n = Math.max(1, Math.round(L / 0.13));
        punched(k, face, sign, a0, a1, n, yf + fh * 0.36, at, 0.07, fh * 0.42, 'plain', sk);
        break;
      }
      case 'arched': {
        const n = Math.max(1, Math.round(L / 0.16));
        const st = f > 0 && f === floors - 1 && k.rnd() > 0.3 ? 'mash' : 'arch';
        punched(k, face, sign, a0, a1, n, yf + fh * 0.3, at, 0.06, fh * 0.36, st, sk);
        break;
      }
      case 'round': {
        const n = Math.max(1, Math.round(L / 0.15));
        punched(k, face, sign, a0, a1, n, yf + fh * 0.3, at, 0.06, fh * 0.36, 'round', sk);
        break;
      }
      case 'slit': {
        const n = Math.max(1, Math.round(L / 0.2));
        punched(k, face, sign, a0, a1, n, yf + fh * 0.55, at, 0.08, 0.035, 'plain', sk);
        break;
      }
    }
  }
}

interface BlockOpt {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  y?: number;
  h: number;
  floors?: number;
  wall?: Mat;
  roof?: 'flat' | 'gable' | 'asian' | 'none' | 'hip';
  win?: string;
  equip?: number;
  band?: boolean;
  door?: number; // x of a +Z door (ground floor)
  doorX?: number; // z of a +X door
  rise?: number;
  parapet?: number;
  pm?: Mat;
  emblem?: boolean; // roundel on the flat roof (default on when it fits)
  sign?: boolean; // flag board on the +Z facade
}

/** Regional building block: walls, windows on the visible faces, team band, roof. Returns the roof top height. */
function block(k: Kit, o: BlockOpt): number {
  const P = k.P;
  const y0 = o.y ?? Y0;
  const { x0, x1, z0, z1, h } = o;
  const W = x1 - x0;
  const D = z1 - z0;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const wall = o.wall ?? P.wall;
  const floors = o.floors ?? Math.max(1, Math.round(h / 0.24));
  k.box(P.base, W + 0.014, 0.03, D + 0.014, cx, y0, cz);
  k.rbox(wall, W, h, D, cx, y0, cz, 0.008);
  const f = P.s.faction;
  const style = o.win ?? (f === 'usa' || f === 'germany' || f === 'neutral' ? 'ribbon' : 'punched');
  const skipZ: [number, number] | undefined = o.door !== undefined ? [o.door - 0.09, o.door + 0.09] : undefined;
  const skipX: [number, number] | undefined = o.doorX !== undefined ? [o.doorX - 0.09, o.doorX + 0.09] : undefined;
  if (style !== 'none') {
    facade(k, 'z', 1, x0, x1, z1, y0, h, floors, style, skipZ);
    facade(k, 'x', 1, z0, z1, x1, y0, h, floors, style, skipX);
  }
  if (o.door !== undefined) door(k, 'z', 1, o.door, y0, z1, 0.12, Math.min(0.2, h * 0.8));
  if (o.doorX !== undefined) door(k, 'x', 1, o.doorX, y0, x1, 0.12, Math.min(0.2, h * 0.8));
  // floor lines
  for (let fl = 1; fl < floors; fl++) {
    const yy = y0 + (h * fl) / floors - 0.006;
    k.box(P.base, W + 0.012, 0.012, D + 0.012, cx, yy, cz);
  }
  // downpipes at the visible corners
  k.cyl(P.galv, 0.007, h, x1 + 0.01, y0, z1 - 0.03, 6);
  if (W > 0.8) k.cyl(P.galv, 0.007, h, x0 + 0.03, y0, z1 + 0.01, 6);
  // bold team band with dark keylines and a national accent stripe below
  if (o.band !== false) {
    const by = y0 + h - (o.roof === 'flat' || !o.roof ? 0.05 : 0.044);
    k.box(P.dark, W + 0.01, 0.006, D + 0.01, cx, by + 0.044, cz);
    k.box(P.team, W + 0.012, 0.044, D + 0.012, cx, by, cz);
    k.box(P.dark, W + 0.01, 0.006, D + 0.01, cx, by - 0.006, cz);
    if (h > 0.3) k.box(P.nation, W + 0.009, 0.014, D + 0.009, cx, by - 0.02, cz);
  }
  dress(k, x0, x1, z0, z1, y0, h, { beacons: (o.roof ?? 'flat') === 'flat' });
  if (o.sign !== false && W >= 0.6 && h >= 0.24) wallEmblem(k, 'z', 1, x1 - 0.16, y0 + h - 0.15, z1, 0.13);
  const top = y0 + h;
  const roof = o.roof ?? 'flat';
  if (roof === 'flat') {
    const ph = o.parapet ?? 0.035;
    flatRoof(k, x0, x1, z0, z1, top, ph, o.pm ?? wall);
    const emb = o.emblem === true && D >= 0.5 && roofEmblem(k, x0, x1, z0, z1, top + 0.011);
    if ((o.equip ?? 2) > 0) roofKit(k, x0, x1, z0, emb ? z0 + D * 0.42 : z1, top + 0.01, o.equip ?? 2);
    return top + ph + 0.01;
  }
  if (roof === 'gable') {
    const rise = o.rise ?? Math.min(W, D) * 0.32;
    gable(k, P.pitch, wall, cx, top, cz, W, D, rise, 0.035, W >= D);
    return top + rise;
  }
  if (roof === 'hip') {
    const rise = o.rise ?? Math.min(W, D) * 0.28;
    asianRoof(k, P.pitch, P.dark, cx, top, cz, W + 0.06, D + 0.06, rise, 0.0, P.dark);
    return top + rise;
  }
  if (roof === 'asian') {
    const rise = o.rise ?? Math.min(W, D) * 0.36;
    k.box(P.accent, W + 0.02, 0.03, D + 0.02, cx, top - 0.005, cz);
    asianRoof(k, P.pitch, ridgeMat(k), cx, top + 0.02, cz, W + 0.14, D + 0.14, rise, 0.05, P.accent);
    return top + rise;
  }
  return top;
}

function ridgeMat(k: Kit) {
  return k.P.mats.col(k.P.s.faction === 'korea' ? 0x39465a : 0x2f4a42, 0.6, 0.15);
}

const yc0 = (rise: number, a: number, run: number) => rise - (run / 2) * Math.tan(a);

/** Pitched (gable) roof: attic prism + two overhanging roof slabs + ridge cap. */
function gable(k: Kit, roofM: Mat, endM: Mat, cx: number, y: number, cz: number, W: number, D: number, rise: number, over = 0.03, alongX = true) {
  const L = alongX ? W : D;
  const S = alongX ? D : W;
  k.at(cx, y, cz, alongX ? 0 : Math.PI / 2, () => {
    k.at(0, 0, 0, Math.PI / 2, () =>
      k.prism(
        endM,
        [
          [-S / 2, 0],
          [S / 2, 0],
          [0, rise],
        ],
        L,
      ),
    );
    const a = Math.atan2(rise, S / 2);
    const run = S / 2 + over;
    const sl = run / Math.cos(a);
    const t = 0.018;
    for (const sg of [-1, 1]) {
      const zc = (sg * run) / 2;
      const yc = rise - (run / 2) * Math.tan(a);
      k.at(0, yc, zc, 0, () => k.local(() => k.box(roofM, L + 2 * over, t, sl, 0, -0.002, 0)), sg * a);
    }
    k.box(k.P.team, L + 2 * over + 0.01, 0.022, 0.042, 0, rise - 0.006, 0);
    // fascia boards (team coloured: pitched roofs outline in the owner's colour like flat roof copings)
    for (const sg of [-1, 1]) k.box(k.P.team, L + 2 * over, 0.022, 0.01, 0, -over * Math.tan(a) - 0.018, sg * run);
    // verge boards along the sloped gable edges
    for (const sx of [-1, 1])
      for (const sg of [-1, 1]) k.at(sx * (L / 2 + over), yc0(rise, a, run), (sg * run) / 2, 0, () => k.box(k.P.pier, 0.012, 0.02, sl + 0.01, 0, 0, 0), sg * a);
  });
}

/** East Asian hip-and-gable style roof with concave slopes and upturned eave corners. */
function asianRoof(k: Kit, roofM: Mat, ridgeM: Mat, cx: number, y: number, cz: number, W: number, D: number, H: number, lift: number, soffit: Mat) {
  const NV = 10;
  const s = D / NV;
  const NU = Math.max(NV, Math.round(W / s / 2) * 2);
  const hx = (NU * s) / 2;
  const hz = D / 2;
  const f = (x: number, z: number) => {
    const tz = (hz - Math.abs(z)) / hz;
    const tx = (hx - Math.abs(x)) / hz;
    const t = Math.min(1, Math.max(0, Math.min(tx, tz)));
    const ax = Math.abs(x) / hx;
    const az = Math.abs(z) / hz;
    return H * Math.pow(t, 1.45) + lift * Math.pow(ax * az, 3) + lift * 0.35 * Math.pow(Math.max(ax, az), 6) * (1 - t);
  };
  const thick = 0.022;
  const pos: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  const cols = NU + 1;
  const rows = NV + 1;
  const sc = 4;
  for (let layer = 0; layer < 2; layer++) {
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const x = -hx + i * s;
        const z = -hz + j * s;
        const yy = f(x, z) - layer * thick;
        pos.push(cx + x, y + yy, cz + z);
        const zoneZ = (hz - Math.abs(z)) / hz <= (hx - Math.abs(x)) / hz;
        uvs.push(zoneZ ? x * sc : z * sc, zoneZ ? z * sc : x * sc);
      }
  }
  const base = cols * rows;
  for (let j = 0; j < NV; j++)
    for (let i = 0; i < NU; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      const xm = -hx + (i + 0.5) * s;
      const zm = -hz + (j + 0.5) * s;
      const diag = xm * zm > 0;
      if (diag) idx.push(a, c, d, a, d, b);
      else idx.push(a, c, b, b, c, d);
    }
  const top = { pos: [...pos.slice(0, base * 3)], uv: [...uvs.slice(0, base * 2)], idx: [...idx] };
  k.mesh(roofM, top.pos, top.idx, top.uv);
  // underside (soffit), reversed winding
  const bidx: number[] = [];
  for (let n = 0; n < idx.length; n += 3) bidx.push(idx[n], idx[n + 2], idx[n + 1]);
  k.mesh(soffit, pos.slice(base * 3), bidx, uvs.slice(base * 2));
  // eave edge band
  const ring: number[] = [];
  for (let i = 0; i < NU; i++) ring.push(i);
  for (let j = 0; j < NV; j++) ring.push(j * cols + NU);
  for (let i = NU; i > 0; i--) ring.push(NV * cols + i);
  for (let j = NV; j > 0; j--) ring.push(j * cols);
  const ep: number[] = [];
  const ei: number[] = [];
  for (let n = 0; n < ring.length; n++) {
    const v = ring[n];
    ep.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2], pos[v * 3], pos[v * 3 + 1] - thick - 0.012, pos[v * 3 + 2]);
  }
  for (let n = 0; n < ring.length; n++) {
    const a = n * 2;
    const b = ((n + 1) % ring.length) * 2;
    ei.push(a, b, a + 1, b, b + 1, a + 1);
  }
  k.mesh(ridgeM, ep, ei, undefined, 0);
  // ridge + hip caps
  const rl = hx - hz;
  if (rl > 0.01) k.box(ridgeM, rl * 2 + 0.03, 0.035, 0.035, cx, y + H - 0.012, cz);
  for (const sx of [-1, 1]) {
    // ridge end ornaments
    k.at(cx + sx * (rl + 0.01), y + H + 0.015, cz, 0, () => k.box(ridgeM, 0.03, 0.05, 0.03, 0, 0, 0), 0, sx * 0.25);
    for (const sz of [-1, 1]) {
      const pts: V3[] = [];
      for (let i = 0; i <= 5; i++) {
        const t = i / 5;
        const x = sx * (rl + (hx - rl) * t);
        const z = sz * hz * t;
        pts.push([cx + x * 0.995, y + f(x * 0.995, z * 0.995) + 0.008, cz + z * 0.995]);
      }
      k.pipe(ridgeM, pts, 0.013, 6);
    }
  }
}

// ---------------------------------------------------------------- props

function lightPole(k: Kit, x: number, z: number, h = 0.42, ry = 0, y = 0) {
  const P = k.P;
  k.cyl(P.concrete, 0.02, 0.025, x, y, z, 8);
  k.cyl(P.galv, 0.007, h, x, y + 0.025, z, 6, 0.005);
  k.at(x, y + h + 0.02, z, ry, () => {
    k.box(P.galv, 0.07, 0.008, 0.01, 0.03, 0, 0);
    k.box(P.dark, 0.045, 0.014, 0.026, 0.065, -0.008, 0);
    k.box(P.lamp, 0.035, 0.004, 0.018, 0.065, -0.011, 0);
  });
}

function jersey(k: Kit, x: number, z: number, len: number, ry: number, m?: Mat) {
  const pr: P2[] = [
    [-0.045, 0],
    [0.045, 0],
    [0.045, 0.012],
    [0.018, 0.035],
    [0.012, 0.075],
    [-0.012, 0.075],
    [-0.018, 0.035],
    [-0.045, 0.012],
  ];
  k.at(x, 0, z, ry, () => k.prism(m ?? k.P.concrete, pr, len));
}

/** Chain-link fence along a polyline (ground level y). */
function fence(k: Kit, pts: P2[], h = 0.17, y = 0) {
  const P = k.P;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / 0.3));
    for (let j = 0; j <= n; j++) {
      if (j === 0 && i > 0) continue;
      const t = j / n;
      k.cyl(P.galv, 0.006, h + 0.02, ax + (bx - ax) * t, y, az + (bz - az) * t, 5);
    }
    k.tube(P.galv, [ax, y + h, az], [bx, y + h, bz], 0.004, 4);
    const s = 9;
    k.quad(P.chain, [ax, y + 0.005, az], [bx, y + 0.005, bz], [bx, y + h, bz], [ax, y + h, az], [0, 0, len * s, 0, len * s, h * s, 0, h * s]);
  }
}

function crate(k: Kit, x: number, y: number, z: number, s = 0.08, ry = 0) {
  const P = k.P;
  k.at(x, y, z, ry, () => {
    k.box(P.wood, s, s * 0.8, s, 0, 0, 0, 12);
    k.box(P.dark, s + 0.004, 0.008, s + 0.004, 0, s * 0.15, 0);
    k.box(P.dark, s + 0.004, 0.008, s + 0.004, 0, s * 0.6, 0);
  });
}

function barrels(k: Kit, x: number, z: number, n = 3, tint = 0x3f5a8a, y = 0) {
  const P = k.P;
  const m = P.mats.col(tint, 0.55, 0.35);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + 0.4;
    const bx = n > 1 ? x + Math.cos(a) * 0.035 : x;
    const bz = n > 1 ? z + Math.sin(a) * 0.035 : z;
    k.cyl(m, 0.022, 0.06, bx, y, bz, 10);
    k.ring(P.dark, 0.022, 0.003, bx, y + 0.02, bz, 10);
    k.ring(P.dark, 0.022, 0.003, bx, y + 0.04, bz, 10);
  }
}

/** Sandbag wall from a to b: textured core + individually bevelled top bags. */
function sandbags(k: Kit, a: P2, b: P2, rows = 2, y = 0) {
  const P = k.P;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ry = -Math.atan2(b[1] - a[1], b[0] - a[0]);
  const bh = 0.032;
  k.at((a[0] + b[0]) / 2, y, (a[1] + b[1]) / 2, ry, () => {
    if (rows > 1) k.rbox(P.sandbag, len, bh * (rows - 1), 0.075, 0, 0, 0, 0.01);
    const n = Math.max(1, Math.round(len / 0.07));
    for (let i = 0; i < n; i++) {
      const xx = -len / 2 + (len * (i + 0.5)) / n;
      k.rbox(P.sandbag, len / n - 0.004, bh, 0.06, xx, bh * (rows - 1) - 0.004, 0, 0.012);
    }
  });
}

/** HESCO bastion line (geotextile lined wire baskets filled with soil). */
function hesco(k: Kit, a: P2, b: P2, h = 0.12, y = 0, dd = 0.1) {
  const P = k.P;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ry = -Math.atan2(b[1] - a[1], b[0] - a[0]);
  k.at((a[0] + b[0]) / 2, y, (a[1] + b[1]) / 2, ry, () => {
    const n = Math.max(1, Math.round(len / dd));
    const cw = len / n;
    k.box(P.hesco, len, h, dd, 0, 0, 0);
    k.box(P.soil, len - 0.01, 0.006, dd - 0.012, 0, h - 0.003, 0);
    // wire mesh frame: vertical posts at the cell joints + top rails
    for (let i = 0; i <= n; i++) {
      const xx = -len / 2 + i * cw;
      for (const sz of [-1, 1]) k.box(P.galv, 0.004, h + 0.004, 0.004, xx, 0, sz * (dd / 2 + 0.001));
    }
    for (const sz of [-1, 1]) k.box(P.galv, len, 0.004, 0.004, 0, h - 0.002, sz * (dd / 2 + 0.001));
    for (const sz of [-1, 1]) k.box(P.galv, len, 0.003, 0.003, 0, h * 0.5, sz * (dd / 2 + 0.001));
  });
}

/** Satellite dish (fixed). */
function satDish(k: Kit, x: number, y: number, z: number, r = 0.06, tilt = 0.7, ry = 0.6) {
  const P = k.P;
  const m = P.mats.col(0xe6e6e0, 0.45, 0.1, true);
  k.at(x, y, z, ry, () => {
    k.cyl(P.dark, 0.006, r * 0.9, 0, 0, 0, 6);
    k.at(0, r * 0.9, 0, 0, () => {
      const pts: P2[] = [];
      for (let i = 0; i <= 5; i++) {
        const t = i / 5;
        pts.push([r * t + 0.001, r * 0.35 * t * t]);
      }
      k.lathe(m, pts, 0, 0, 0, 16, 0);
      k.tube(P.dark, [0, 0, 0], [0, r * 0.75, 0], 0.003, 4);
      k.box(P.dark, 0.012, 0.012, 0.012, 0, r * 0.75, 0);
    }, -tilt);
  });
}

/** Thin antenna mast with a red light. */
function antenna(k: Kit, x: number, y: number, z: number, h: number) {
  const P = k.P;
  k.cyl(P.dark, 0.004, h, x, y, z, 4, 0.002);
  k.box(P.dark, 0.05, 0.004, 0.004, x, y + h * 0.7, z);
  k.sph(P.red_l, 0.008, x, y + h, z, 6, 4);
}

/** Tilted ground-mounted solar panel. */
function solarPanel(k: Kit, x: number, y: number, z: number, w: number, d: number, tilt = 0.5, ry = 0) {
  const P = k.P;
  k.at(x, y, z, ry, () => {
    k.box(P.galv, 0.012, d * 0.45, 0.012, -w / 2 + 0.02, 0, d * 0.25);
    k.box(P.galv, 0.012, d * 0.45, 0.012, w / 2 - 0.02, 0, d * 0.25);
    k.box(P.galv, 0.012, d * 0.2, 0.012, -w / 2 + 0.02, 0, -d * 0.25);
    k.box(P.galv, 0.012, d * 0.2, 0.012, w / 2 - 0.02, 0, -d * 0.25);
    k.at(0, d * 0.3, 0, 0, () => k.box(P.solar, w, 0.008, d, 0, 0, 0, 6), tilt);
  });
}

/** Ceramic insulator stack. */
function insulator(k: Kit, x: number, y: number, z: number, h = 0.08) {
  const P = k.P;
  const m = P.mats.col(0x7a3a26, 0.35, 0.05);
  const n = Math.max(3, Math.round(h / 0.014));
  k.cyl(P.galv, 0.004, h, x, y, z, 5);
  for (let i = 0; i < n; i++) k.cyl(m, 0.012, 0.006, x, y + (i + 0.5) * (h / n), z, 8, 0.009);
}

/** Power transformer with radiator fins, bushings and conservator. */
function transformer(k: Kit, x: number, y: number, z: number, ry = 0, s = 1) {
  const P = k.P;
  const body = P.mats.col(0x7f8a7c, 0.55, 0.4);
  k.mark('elec', x, y + 0.15 * s, z);
  k.at(x, y, z, ry, () => {
    k.box(P.concrete, 0.2 * s, 0.02, 0.16 * s, 0, 0, 0);
    k.rbox(body, 0.14 * s, 0.13 * s, 0.09 * s, 0, 0.02, 0, 0.008);
    for (let i = 0; i < 5; i++) {
      k.box(body, 0.006, 0.1 * s, 0.03 * s, -0.05 * s + i * 0.025 * s, 0.035, 0.06 * s);
      k.box(body, 0.006, 0.1 * s, 0.03 * s, -0.05 * s + i * 0.025 * s, 0.035, -0.06 * s);
    }
    k.tube(body, [-0.06 * s, 0.17 * s, -0.02 * s], [0.06 * s, 0.17 * s, -0.02 * s], 0.018 * s, 10);
    for (let i = 0; i < 3; i++) insulator(k, (-0.04 + i * 0.04) * s, 0.02 + 0.13 * s, 0.02 * s, 0.07 * s);
    k.box(P.team, 0.06 * s, 0.03 * s, 0.002, 0, 0.08 * s, 0.046 * s);
  });
}

/** Lattice mast/tower (square section, tapering). */
function lattice(k: Kit, m: Mat, x: number, z: number, y0: number, h: number, wb: number, wt: number, levels: number, t = 0.008) {
  const lv = (j: number) => {
    const f = j / levels;
    const w = wb + (wt - wb) * f;
    return { y: y0 + h * f, w: w / 2 };
  };
  for (let j = 0; j < levels; j++) {
    const A = lv(j);
    const B = lv(j + 1);
    const cs: P2[] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    for (let c = 0; c < 4; c++) {
      const [sx, sz] = cs[c];
      const [nx, nz] = cs[(c + 1) % 4];
      k.bar(m, [x + sx * A.w, A.y, z + sz * A.w], [x + sx * B.w, B.y, z + sz * B.w], t * 1.4);
      k.bar(m, [x + sx * A.w, A.y, z + sz * A.w], [x + nx * B.w, B.y, z + nz * B.w], t * 0.7);
      k.bar(m, [x + nx * A.w, A.y, z + nz * A.w], [x + sx * B.w, B.y, z + sz * B.w], t * 0.7);
      k.bar(m, [x + sx * B.w, B.y, z + sz * B.w], [x + nx * B.w, B.y, z + nz * B.w], t * 0.8);
    }
  }
}

/** Steel ladder up a wall face. */
function ladder(k: Kit, face: Face, sign: number, a: number, y0: number, y1: number, at: number) {
  const P = k.P;
  const o = at + sign * 0.02;
  const pts = (da: number, y: number): V3 => (face === 'z' ? [a + da, y, o] : [o, y, a + da]);
  k.tube(P.galv, pts(-0.02, y0), pts(-0.02, y1 + 0.04), 0.003, 4);
  k.tube(P.galv, pts(0.02, y0), pts(0.02, y1 + 0.04), 0.003, 4);
  for (let y = y0 + 0.03; y < y1; y += 0.03) k.tube(P.galv, pts(-0.02, y), pts(0.02, y), 0.002, 4);
}

/** Handrail along a polyline at height y. */
function railing(k: Kit, pts: P2[], y: number, h = 0.06, m?: Mat) {
  const P = k.P;
  const mm = m ?? P.yellow;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / 0.12));
    for (let j = 0; j <= n; j++) {
      const t = j / n;
      k.bar(mm, [ax + (bx - ax) * t, y, az + (bz - az) * t], [ax + (bx - ax) * t, y + h, az + (bz - az) * t], 0.004);
    }
    k.bar(mm, [ax, y + h, az], [bx, y + h, bz], 0.005);
    k.bar(mm, [ax, y + h * 0.5, az], [bx, y + h * 0.5, bz], 0.003);
  }
}

/** Flag pole with a waving flag (faction colours) and team coloured finial. */
function flagPole(k: Kit, x: number, z: number, h: number, y = 0) {
  const P = k.P;
  k.cyl(P.concrete, 0.035, 0.03, x, y, z, 10, 0.03);
  k.cyl(P.galv, 0.008, h, x, y + 0.03, z, 8, 0.005);
  k.sph(P.team, 0.014, x, y + h + 0.035, z, 8, 6);
  const node = k.node('flag', x + 0.006, y + h - 0.005, z, -0.5);
  const g = new THREE.PlaneGeometry(0.34, 0.21, 12, 2);
  g.translate(0.17, -0.105, 0);
  k.on(node, () => k.add(g, P.mats.flag(), 0));
}

/** Small guard booth. */
function guardBooth(k: Kit, x: number, z: number, ry = 0) {
  const P = k.P;
  k.at(x, 0, z, ry, () => {
    k.box(P.concrete, 0.16, 0.02, 0.16, 0, 0, 0);
    k.box(P.R === 'east' ? P.wall2 : P.wall, 0.13, 0.18, 0.13, 0, 0.02, 0);
    k.panel(P.glass, 'z', 1, 0, 0.1, 0.067, 0.1, 0.07);
    k.panel(P.glass, 'x', 1, 0, 0.1, 0.067, 0.1, 0.07);
    k.box(P.R === 'east' ? P.accent : P.dark, 0.16, 0.02, 0.16, 0, 0.2, 0);
    k.box(P.team, 0.135, 0.015, 0.135, 0, 0.185, 0);
    k.sph(P.lamp, 0.01, 0.06, 0.22, 0.06, 6, 4);
  });
}

/** Steel stair flight from (x,z,y0) rising along +dir to y1. */
function stairs(k: Kit, x: number, z: number, y0: number, y1: number, alongX: boolean, sgn = 1, w = 0.08) {
  const P = k.P;
  const n = Math.max(2, Math.round((y1 - y0) / 0.03));
  const run = (y1 - y0) * 0.9;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const a = sgn * run * t;
    if (alongX) k.box(P.grating, 0.03, 0.006, w, x + a, y0 + (y1 - y0) * t, z);
    else k.box(P.grating, w, 0.006, 0.03, x, y0 + (y1 - y0) * t, z + a);
  }
  for (const s of [-1, 1]) {
    const o = (s * w) / 2;
    if (alongX) k.bar(P.yellow, [x, y0 + 0.06, z + o], [x + sgn * run, y1 + 0.06, z + o], 0.005);
    else k.bar(P.yellow, [x + o, y0 + 0.06, z], [x + o, y1 + 0.06, z + sgn * run], 0.005);
  }
}

/** Stencilled number / text decal on a wall (alpha tested, shared sign atlas). */
function stencil(k: Kit, text: string, face: Face, sign: number, c: number, y: number, at: number, w: number, color = '#f0eee6') {
  const uv = signCell('st|' + text + color, { text, fg: color });
  k.panel(k.P.signs, face, sign, c, y, at + sign * 0.005, w, w / 4, uv);
}

/** Painted road markings: dashed line along x or z. */
function dashes(k: Kit, m: Mat, x0: number, z0: number, x1: number, z1: number, dash = 0.08, gap = 0.06, w = 0.012, y = 0.002) {
  const len = Math.hypot(x1 - x0, z1 - z0);
  const ry = -Math.atan2(z1 - z0, x1 - x0);
  for (let s = 0; s + dash <= len + 1e-6; s += dash + gap) {
    const t = (s + dash / 2) / len;
    k.at(x0 + (x1 - x0) * t, y, z0 + (z1 - z0) * t, ry, () => k.box(m, dash, 0.002, w, 0, 0, 0));
  }
}

// ================================================================ templates & instances

const tplCache = new Map<string, Tpl>();

/** Vertical stretch per building (the pump jack keeps its exact linkage geometry). */
const STRETCH: Record<string, number> = { conyard: 1.2, power: 1.2, refinery: 1.2, barracks: 1.22, factory: 1.18, radar: 1.18, airfield: 1.18, tech: 1.2, bunker: 1.12, sentry: 1.1, sam: 1.08, atgm: 1.15, oil: 1 };

function buildTpl(key: string, s: ModelStyle, fog: FogOfWar | null, w: number, d: number, fn: (k: Kit) => void): Tpl {
  const P = makePal(s, fog);
  const k = new Kit(P, strHash(key + ':' + s.faction));
  k.sy = STRETCH[key] ?? 1;
  fn(k);
  k.height = k.wy(k.height);
  k.finish();
  k.root.name = 'building:' + key;
  return {
    root: k.root,
    specs: k.specs,
    glow: [...P.mats.glow],
    flags: P.mats.flags,
    blinks: [...P.mats.blinks],
    emitters: k.emitters,
    height: k.height,
    size: { x: w, y: k.height, z: d },
    turret: k.turret,
    muzzles: k.muzzles,
    recoil: k.recoil,
    fx: new FxTpl(k.root, k.rec, { key, w, d, height: k.height, region: s.region, fog, seed: strHash(key + ':' + s.faction + ':' + s.region) }),
  };
}

const _v = new THREE.Vector3();

function instance(t: Tpl): FxModel {
  const root = t.root.clone(true);
  const byName = new Map<string, THREE.Object3D>();
  root.traverse((o) => {
    if (o.name) byName.set(o.name, o);
  });
  const find = (n: string) => byName.get(n);
  const muzzles: THREE.Object3D[] = [];
  for (let i = 0; i < t.muzzles; i++) {
    const m = find('muzzle' + i);
    if (m) muzzles.push(m);
  }
  const recoil: THREE.Object3D[] = [];
  for (let i = 0; i < t.recoil; i++) {
    const m = find('recoil' + i);
    if (m) recoil.push(m);
  }
  const bound: { sp: AnimSpec; o: THREE.Object3D | undefined; base: number; tax: Ax; t0: number; tilt: number }[] = t.specs.map((sp, i) => {
    const o = sp.k === 'pump' ? undefined : find(sp.n);
    let base = 0;
    if (o && (sp.k === 'osc' || sp.k === 'slide')) base = sp.k === 'osc' ? o.rotation[sp.ax] : o.position[sp.ax];
    if (o && sp.k === 'prod') {
      base = sp.mode === 'pos' ? o.position[sp.ax] : sp.mode === 'rot' ? o.rotation[sp.ax] : sp.mode === 'scl' ? o.scale[sp.ax] : 0;
      if (sp.mode === 'vis') o.visible = false;
    }
    // battle damage knocks dishes / masts askew about an axis they don't animate on
    const tax: Ax = sp.k === 'spin' || sp.k === 'osc' ? (sp.ax === 'x' ? 'z' : 'x') : 'x';
    const tilt = (0.16 + ((i * 0.618 + t.specs.length * 0.37) % 1) * 0.2) * (i % 2 ? 1 : -1);
    return { sp, o, base, tax, t0: o ? o.rotation[tax] : 0, tilt };
  });
  const bfx = new BuildFx(t.fx, root);
  const posePump = (p: { sp: Extract<AnimSpec, { k: 'pump' }>; crank?: THREE.Object3D; beam?: THREE.Object3D; rod?: THREE.Object3D; pit?: THREE.Object3D }, a: number) => {
    const sp = p.sp;
    if (p.crank) p.crank.rotation.z = -a;
    const th = -sp.amp * Math.sin(a);
    if (p.beam) p.beam.rotation.z = th;
    // crank pin and beam tail
    const cx = sp.G[0] + Math.cos(-a + Math.PI) * sp.r;
    const cy = sp.G[1] + Math.sin(-a + Math.PI) * sp.r;
    const bx = sp.P[0] - Math.cos(th) * sp.R;
    const by = sp.P[1] - Math.sin(th) * sp.R;
    if (p.pit) {
      _v.set(bx - cx, by - cy, 0);
      p.pit.position.x = cx;
      p.pit.position.y = cy;
      p.pit.rotation.z = Math.atan2(_v.y, _v.x) - Math.PI / 2;
      p.pit.scale.y = _v.length();
    }
    if (p.rod) p.rod.position.y = sp.rodY + Math.sin(th) * sp.Rf;
  };
  const pumps = t.specs
    .filter((sp): sp is Extract<AnimSpec, { k: 'pump' }> => sp.k === 'pump')
    .map((sp) => ({ sp, crank: find(sp.crank), beam: find(sp.beam), rod: find(sp.rod), pit: find(sp.pit), phase: 0 }));
  const glow = t.glow as SMat[];
  const flags = t.flags;
  /** Production door / lift / beacon easing (0 closed .. 1 open). */
  let prodK = 0;
  const anim = (s: AnimState) => {
    const pw = s.powered;
    const f = pw ? 1 : 0.22;
    for (const g of glow) g.emissiveIntensity = (g.userData.baseEI as number) * f;
    for (const fm of flags) (fm.userData.uTime as { value: number }).value = s.time;
    const blinkOn = pw && s.built >= 1 && s.time % 1.5 < 0.55;
    for (const bm of t.blinks) bm.emissiveIntensity = blinkOn ? (bm.userData.blinkEI as number) : 0;
    bfx.update(s);
    if (s.built < 1) return;
    const t0 = s.time;
    const dmg = s.damage;
    const pAge = s.produced ?? Infinity;
    prodK += ((pAge < 3.2 ? 1 : 0) - prodK) * Math.min(1, s.dt * (pAge < 3.2 ? 2.6 : 1.4));
    // heavy damage: dishes / radars tilt and jam
    const tiltK = dmg < 0.6 ? 0 : Math.min(1, (dmg - 0.6) / 0.25);
    const jam = dmg >= 0.85 ? 0 : 1;
    for (const b of bound) {
      const { sp, o } = b;
      if (!o) continue;
      if (sp.k === 'spin' || sp.k === 'osc') o.rotation[b.tax] = b.t0 + b.tilt * tiltK;
      switch (sp.k) {
        case 'spin':
          o.rotation[sp.ax] += sp.v * s.dt * (pw ? 1 : 0.15) * jam;
          break;
        case 'osc':
          o.rotation[sp.ax] = b.base + sp.b + sp.a * Math.sin((jam ? t0 : 0) * sp.f + sp.p);
          break;
        case 'slide':
          o.position[sp.ax] = b.base + sp.b + sp.a * Math.sin(t0 * sp.f + sp.p);
          break;
        case 'blink':
          o.visible = pw && ((t0 + sp.p) % sp.per) / sp.per < sp.on;
          break;
        case 'prod':
          if (sp.mode === 'pos') o.position[sp.ax] = b.base + sp.a * prodK;
          else if (sp.mode === 'rot') o.rotation[sp.ax] = b.base + sp.a * prodK;
          else if (sp.mode === 'scl') o.scale[sp.ax] = b.base + sp.a * prodK;
          else {
            o.visible = prodK > 0.08;
            if (o.visible) o.rotation[sp.ax] += (sp.v ?? 6) * s.dt;
          }
          break;
      }
    }
    for (const p of pumps) {
      p.phase += s.dt * 2.2;
      posePump(p, p.phase);
    }
  };
  for (const p of pumps) posePump(p, 0);
  return {
    root,
    turret: t.turret ? find('turret') : undefined,
    muzzles,
    recoil: recoil.length ? recoil : undefined,
    height: t.height,
    size: { ...t.size },
    glow: [...t.glow],
    emitters: t.emitters.map((e) => ({ pos: e.pos.clone(), kind: e.kind })),
    anim,
    damageFx: bfx.damageFx,
    nightLights: t.fx.night,
  };
}

/** Plain fallback if a builder fails. */
function fallbackModel(s: ModelStyle, w: number, d: number): Model {
  const root = new THREE.Group();
  const m1 = new THREE.MeshStandardMaterial({ color: 0xb0aca0, roughness: 0.9 });
  const m2 = new THREE.MeshStandardMaterial({ color: s.team, roughness: 0.6 });
  const a = new THREE.Mesh(new THREE.BoxGeometry(w * 0.8, 0.4, d * 0.8), m1);
  a.position.y = 0.2;
  const b = new THREE.Mesh(new THREE.BoxGeometry(w * 0.82, 0.06, d * 0.82), m2);
  b.position.y = 0.36;
  root.add(a, b);
  return { root, muzzles: [], height: 0.45, glow: [], emitters: [], size: { x: w, y: 0.45, z: d } };
}

function building(key: string, w: number, d: number, fn: (k: Kit) => void): Builder {
  return (style, fog) => {
    try {
      const ck = `${key}|${style.region}|${style.faction}|${style.team}|${style.flag.join(',')}|${fogId(fog)}`;
      let t = tplCache.get(ck);
      if (!t) {
        t = buildTpl(key, style, fog, w, d, fn);
        tplCache.set(ck, t);
      }
      return instance(t);
    } catch (e) {
      console.error('building model failed', key, e);
      return fallbackModel(style, w, d);
    }
  };
}

// ================================================================ shared structures

/** Barrel vault roof (half cylinder flattened to `rise`), axis along Z (or X). */
function vault(k: Kit, m: Mat, endM: Mat | null, cx: number, y: number, cz: number, span: number, len: number, rise: number, alongX = false, uvs = 4, ribs = 0) {
  const r = span / 2;
  k.at(cx, y, cz, alongX ? Math.PI / 2 : 0, () => {
    const g = new THREE.CylinderGeometry(r, r, len, 22, 1, true, -Math.PI / 2, Math.PI);
    g.rotateX(-Math.PI / 2);
    g.scale(1, rise / r, 1);
    // UVs: u around the arch, v along the axis -> ribs run along the slope
    scaleUV(g, (Math.PI * r + rise) * uvs, len * uvs);
    k.add(g, m, 0);
    // team coloured arch rims at both ends
    for (const s of [-1, 1]) {
      const t = new THREE.TorusGeometry(r + 0.004, 0.016, 4, 22, Math.PI);
      t.scale(1, (rise + 0.004) / (r + 0.004), 1.4);
      t.translate(0, 0, s * (len / 2 - 0.012));
      k.add(t, k.P.team, 0);
    }
    // structural steel arch ribs over the sheeting + a ridge vent / skylight strip
    for (let i = 1; i <= ribs; i++) {
      const t = new THREE.TorusGeometry(r + 0.006, 0.009, 3, 18, Math.PI);
      t.scale(1, (rise + 0.006) / (r + 0.006), 1.2);
      t.translate(0, 0, -len / 2 + (len * i) / (ribs + 1));
      k.add(t, k.P.steel, 0);
    }
    if (endM) {
      const pts: P2[] = [];
      for (let i = 0; i <= 16; i++) {
        const a = (i / 16) * Math.PI;
        pts.push([Math.cos(a) * r * 0.995, Math.sin(a) * rise * 0.995]);
      }
      for (const s of [-1, 1]) k.prism(endM, pts, 0.02, 0, 0, s * (len / 2 - 0.012));
    }
  });
}

// ================================================================ POWER PLANT (2x2)

/** Transmission pylon with insulators and sagging conductors running off toward +X. */
function pylon(k: Kit, x: number, z: number, h: number, ry = 0, wireLen = 0.4) {
  const P = k.P;
  lattice(k, P.galv, x, z, Y0, h, 0.15, 0.05, 6, 0.007);
  k.at(x, Y0, z, ry, () => {
    for (const [y, w] of [
      [h * 0.72, 0.36],
      [h * 0.92, 0.26],
    ] as P2[]) {
      k.bar(P.galv, [0, y, -w / 2], [0, y, w / 2], 0.012);
      k.bar(P.galv, [0, y - 0.06, -0.03], [0, y, -w / 2], 0.006);
      k.bar(P.galv, [0, y - 0.06, 0.03], [0, y, w / 2], 0.006);
      for (const sz of [-1, 1]) {
        const zz = (sz * w) / 2;
        insulator(k, 0, y - 0.07, zz, 0.06);
        const a: V3 = [0, y - 0.07, zz];
        k.tube(P.black, a, [wireLen * 0.5, y - 0.12, zz], 0.0025, 3);
        k.tube(P.black, [wireLen * 0.5, y - 0.12, zz], [wireLen, y - 0.09, zz], 0.0025, 3);
      }
    }
    k.bar(P.galv, [0, h, 0], [0, h + 0.06, 0], 0.01);
  });
}

/** Hyperbolic natural draught cooling tower (open top, steam). */
function coolingTower(k: Kit, x: number, z: number, R: number, H: number) {
  const P = k.P;
  const pts: P2[] = [];
  const inner: P2[] = [];
  const yw = H * 0.72;
  const rw = R * 0.62;
  const b = H * 0.42;
  for (let i = 0; i <= 12; i++) {
    const y = 0.06 + ((H - 0.06) * i) / 12;
    const t = (y - yw) / b;
    const r = Math.min(R, rw * Math.sqrt(1 + t * t * (y < yw ? ((R / rw) ** 2 - 1) / ((yw - 0.06) / b) ** 2 : 0.35)));
    pts.push([r, y]);
    inner.push([r - 0.025, y]);
  }
  k.lathe(P.wall, pts, x, Y0, z, 28, 3);
  k.lathe(P.mats.col(0x3a3a38, 0.95, 0), inner.reverse(), x, Y0, z, 28, 0);
  k.ring(P.concrete, pts[pts.length - 1][0] - 0.012, 0.016, x, Y0 + H, z, 28);
  // raker columns at the base
  const n = 18;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * TAU;
    const a1 = ((i + 0.5) / n) * TAU;
    const r0 = R * 1.0;
    k.bar(P.concrete, [x + Math.cos(a0) * r0, Y0, z + Math.sin(a0) * r0], [x + Math.cos(a1) * r0, Y0 + 0.07, z + Math.sin(a1) * r0], 0.014);
    k.bar(P.concrete, [x + Math.cos(a1 + TAU / n / 2) * r0, Y0, z + Math.sin(a1 + TAU / n / 2) * r0], [x + Math.cos(a1) * r0, Y0 + 0.07, z + Math.sin(a1) * r0], 0.014);
  }
  k.cyl(P.mats.col(0x2a3a40, 0.2, 0.3), R * 0.96, 0.012, x, Y0, z, 24);
  k.box(P.team, 0.18, 0.06, 0.01, x + R * 0.66 * Math.cos(0.7), Y0 + H * 0.82, z + R * 0.66 * Math.sin(0.7));
  k.emit(x, Y0 + H + 0.05, z, 'steam');
  k.emit(x + 0.08, Y0 + H + 0.08, z - 0.05, 'steam');
}

/** Chimney with banded paint (red/white aviation marking), platforms and smoke. */
function chimney(k: Kit, x: number, z: number, H: number, r0: number, r1: number, banded = true, y0 = Y0) {
  const P = k.P;
  const n = 10;
  for (let i = 0; i < n; i++) {
    const ya = y0 + (H * i) / n;
    const ra = r0 + ((r1 - r0) * i) / n;
    const rb = r0 + ((r1 - r0) * (i + 1)) / n;
    const m = banded && i >= n / 2 ? (i % 2 ? P.white : P.red) : P.concrete;
    k.cyl(m, ra, H / n, x, ya, z, 14, rb, false, m === P.concrete ? 3 : 0);
  }
  k.cyl(P.black, r1 * 1.05, 0.03, x, y0 + H - 0.02, z, 14);
  for (const f of [0.55, 0.85]) {
    const y = y0 + H * f;
    const r = r0 + (r1 - r0) * f;
    k.ring(P.grating, r + 0.03, 0.016, x, y, z, 16);
    k.ring(P.galv, r + 0.045, 0.003, x, y + 0.04, z, 16);
  }
  ladder(k, 'x', 1, z, y0, y0 + H, x + r0 * 0.8);
  k.blinkLight(x, y0 + H + 0.03, z, 0.018, 1.6, 0);
}

/** Mechanical-draft cooling cell block with spinning fans in shrouds. */
function coolingCells(k: Kit, x0: number, x1: number, z0: number, z1: number, h: number, nFans: number) {
  const P = k.P;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const W = x1 - x0;
  const D = z1 - z0;
  k.box(P.base, W + 0.02, 0.04, D + 0.02, cx, Y0, cz);
  k.box(P.concrete, W, h, D, cx, Y0 + 0.04, cz);
  // louvres
  for (let i = 0; i < 6; i++) {
    faceBox(k, P.dark, 'z', 1, cx, Y0 + 0.07 + i * 0.03, z1, W - 0.04, 0.014, 0.012);
    faceBox(k, P.dark, 'x', 1, cz, Y0 + 0.07 + i * 0.03, x1, D - 0.04, 0.014, 0.012);
  }
  const top = Y0 + 0.04 + h;
  k.box(P.grating, W - 0.02, 0.01, D - 0.02, cx, top, cz);
  railing(k, [[x0 + 0.01, z0 + 0.01], [x1 - 0.01, z0 + 0.01], [x1 - 0.01, z1 - 0.01], [x0 + 0.01, z1 - 0.01], [x0 + 0.01, z0 + 0.01]], top + 0.01, 0.05);
  k.box(P.team, W + 0.004, 0.02, D + 0.004, cx, top - 0.03, cz);
  const along = D > W;
  for (let i = 0; i < nFans; i++) {
    const t = (i + 0.5) / nFans;
    const fx = along ? cx : x0 + W * t;
    const fz = along ? z0 + D * t : cz;
    const r = Math.min(along ? W : D, (along ? D : W) / nFans) * 0.4;
    // fan shroud (velocity recovery stack)
    k.lathe(P.wall2, [[r * 1.05, 0], [r * 0.98, 0.04], [r * 1.0, 0.07], [r * 1.12, 0.1]], fx, top + 0.01, fz, 20, 4);
    k.lathe(P.mats.col(0x2a2c2e, 0.9, 0.1), [[r * 1.1, 0.1], [r * 0.97, 0.07], [r * 0.95, 0.04], [r * 1.02, 0]], fx, top + 0.01, fz, 20, 0);
    k.cyl(P.black, r * 0.98, 0.006, fx, top + 0.015, fz, 20);
    const fan = k.node('fan' + i, fx, top + 0.05, fz);
    k.on(fan, () => {
      k.cyl(P.dark, 0.02, 0.025, 0, -0.01, 0, 8);
      for (let b = 0; b < 6; b++) k.boxR(P.galv, r * 0.9, 0.004, 0.03, Math.cos((b / 6) * TAU) * r * 0.45, 0, -Math.sin((b / 6) * TAU) * r * 0.45, (b / 6) * TAU, 0.25);
    });
    k.spin('fan' + i, 'y', 7 + i);
    k.emit(fx, top + 0.15, fz, 'steam');
  }
}

/** Substation: transformers, gantry with insulators and a fence. */
function switchyard(k: Kit, x0: number, x1: number, z0: number, z1: number, nT = 2) {
  const P = k.P;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  k.box(P.mats.tex('soil', { color: 0x8a8478, seed: 27, size: 256 }, 0xffffff, 6), x1 - x0, 0.006, z1 - z0, cx, Y0, cz);
  for (let i = 0; i < nT; i++) transformer(k, x0 + ((x1 - x0) * (i + 0.5)) / nT, Y0, cz + 0.02, 0, 1.15);
  // gantry
  const gy = 0.42;
  for (const gx of [x0 + 0.06, x1 - 0.06]) lattice(k, P.galv, gx, z0 + 0.08, Y0, gy, 0.05, 0.04, 3, 0.005);
  k.bar(P.galv, [x0 + 0.06, Y0 + gy, z0 + 0.08], [x1 - 0.06, Y0 + gy, z0 + 0.08], 0.014);
  for (let i = 0; i < nT; i++) {
    const tx = x0 + ((x1 - x0) * (i + 0.5)) / nT;
    for (let j = -1; j <= 1; j++) {
      const wx = tx + j * 0.046;
      k.cyl(P.mats.col(0x7a3a26, 0.35, 0.05), 0.008, 0.05, wx, Y0 + gy - 0.05, z0 + 0.08, 6);
      k.tube(P.black, [wx, Y0 + gy - 0.05, z0 + 0.08], [tx + j * 0.046, Y0 + 0.24, cz + 0.04], 0.002, 3);
    }
  }
  fence(k, [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0 + 0.15]], 0.14, Y0);
}

// ================================================================ military props (shared)

/** Nation sign board on two posts (entrance sign) or flat on a wall; text from the nation's sign spec. */
function signSpec(k: Kit, which: 'main' | 'unit' | 'num', num = ''): { key: string; spec: SignSpec } {
  const S = k.P.N.sign;
  const f = k.P.s.faction;
  if (which === 'main') return { key: `main|${f}`, spec: { text: S.base, sub: S.sub || undefined, fg: S.fg, bg: S.bg, border: S.border, font: S.font, rtl: S.rtl, mark: S.mark, markColor: S.markColor } };
  if (which === 'unit') return { key: `unit|${f}|${num}`, spec: { text: num, fg: S.fg, bg: S.bg, border: S.border, font: S.font, rtl: S.rtl } };
  return { key: `num|${f}|${num}`, spec: { text: `${S.num} ${num}`, fg: '#f2f0e8', bg: '#2a2c2a', border: '#f2f0e8', font: S.font, rtl: S.rtl } };
}

/** Wall mounted sign board (face / sign / c / y / at as panel()). */
function wallSign(k: Kit, face: Face, sign: number, c: number, y: number, at: number, w: number, which: 'main' | 'unit' | 'num' = 'main', num = '') {
  const P = k.P;
  const { key, spec } = signSpec(k, which, num);
  const uv = signCell(key, spec);
  faceBox(k, P.dark, face, sign, c, y - 0.006, at, w + 0.012, w / 4 + 0.012, 0.008);
  k.panel(P.signs, face, sign, c, y, at + sign * 0.0085, w, w / 4, uv);
}

/** Free standing sign on two posts, facing +Z rotated by ry. */
function postSign(k: Kit, x: number, z: number, ry: number, w = 0.34, which: 'main' | 'unit' | 'num' = 'main', num = '', y = 0) {
  const P = k.P;
  const { key, spec } = signSpec(k, which, num);
  const uv = signCell(key, spec);
  k.at(x, y, z, ry, () => {
    for (const sx of [-1, 1]) k.box(P.dark, 0.012, 0.12 + w / 4, 0.012, sx * (w / 2 - 0.03), 0, -0.012);
    k.box(P.dark, w + 0.012, w / 4 + 0.012, 0.012, 0, 0.11, -0.004);
    k.panel(P.signs, 'z', 1, 0, 0.116, 0.0025, w, w / 4, uv);
    k.box(P.concrete, w * 0.9, 0.03, 0.06, 0, 0, -0.01);
  });
}

/** Precast concrete T-wall line (blast barrier) from a to b. */
function tWall(k: Kit, a: P2, b: P2, h = 0.24, y = 0) {
  const P = k.P;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ry = -Math.atan2(b[1] - a[1], b[0] - a[0]);
  const n = Math.max(1, Math.round(len / 0.12));
  const sw = len / n;
  k.at((a[0] + b[0]) / 2, y, (a[1] + b[1]) / 2, ry, () => {
    for (let i = 0; i < n; i++) {
      const xx = -len / 2 + sw * (i + 0.5);
      k.box(P.panel, sw - 0.006, 0.026, 0.09, xx, 0, 0, 1.3);
      k.box(P.panel, sw - 0.006, h, 0.032, xx, 0.026, 0, 1.3);
      // lifting eyes
      k.box(P.dark, 0.008, 0.008, 0.034, xx, h + 0.024, 0);
    }
    // team painted band along the top (readable from the RTS camera)
    k.box(P.team, len - 0.004, 0.022, 0.034, 0, h - 0.03, 0);
  });
}

/** Concertina razor wire coil along a to b at height y. */
function razor(k: Kit, a: P2, b: P2, y: number, r = 0.022) {
  const P = k.P;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ry = -Math.atan2(b[1] - a[1], b[0] - a[0]);
  const n = Math.max(2, Math.round(len / 0.035));
  k.at((a[0] + b[0]) / 2, y + r, (a[1] + b[1]) / 2, ry, () => {
    for (let i = 0; i < n; i++) {
      const xx = -len / 2 + (len * (i + 0.5)) / n;
      k.at(xx, 0, 0, 0, () => {
        const g = new THREE.TorusGeometry(r, 0.0018, 3, 9);
        g.rotateY(Math.PI / 2 + (i % 2 ? 0.35 : -0.35));
        k.add(g, P.galv, 0);
      });
    }
  });
}

/** Light mast with a cluster of floodlights aimed along ry (+X when ry = 0). */
function floodMast(k: Kit, x: number, z: number, h = 0.62, ry = 0, y = Y0) {
  const P = k.P;
  k.box(P.concrete, 0.07, 0.03, 0.07, x, y, z);
  k.cyl(P.galv, 0.009, h, x, y + 0.03, z, 6, 0.006);
  k.at(x, y + h + 0.03, z, ry, () => {
    k.box(P.galv, 0.012, 0.012, 0.12, 0.0, 0, 0);
    for (const sz of [-0.04, 0.04]) {
      k.at(0.015, 0.008, sz, 0, () => {
        k.box(P.dark, 0.03, 0.036, 0.04, 0, -0.018, 0);
        k.box(P.flood, 0.004, 0.028, 0.032, 0.016, -0.014, 0);
      }, 0, -0.35);
    }
  });
}

/** Trailer mounted diesel generator set (exhaust smoke), facing +X rotated by ry. */
function genset(k: Kit, x: number, z: number, ry = 0, s = 1, y = Y0, smoke = false) {
  const P = k.P;
  k.at(x, y, z, ry, () => {
    k.box(P.dark, 0.26 * s, 0.02 * s, 0.11 * s, 0, 0.03 * s, 0);
    for (const sz of [-1, 1]) k.tube(P.rubber, [-0.03 * s, 0.03 * s, sz * 0.06 * s], [-0.03 * s, 0.03 * s, sz * 0.075 * s], 0.03 * s, 10);
    k.bar(P.dark, [0.13 * s, 0.035 * s, 0], [0.22 * s, 0.01 * s, 0], 0.008 * s);
    k.rbox(P.accent, 0.22 * s, 0.11 * s, 0.12 * s, 0, 0.05 * s, 0, 0.008);
    // louvres + control panel + exhaust
    for (let i = 0; i < 4; i++) k.box(P.dark, 0.004, 0.006, 0.08 * s, 0.111 * s, 0.07 * s + i * 0.018 * s, 0);
    k.box(P.dark, 0.05 * s, 0.04 * s, 0.003, -0.05 * s, 0.09 * s, 0.061 * s);
    k.box(P.green_l, 0.008, 0.006, 0.002, -0.06 * s, 0.1 * s, 0.063 * s);
    k.cyl(P.dark, 0.008 * s, 0.05 * s, -0.07 * s, 0.16 * s, -0.03 * s, 6);
    k.box(P.team, 0.222 * s, 0.012 * s, 0.122 * s, 0, 0.15 * s, 0);
    if (smoke) k.emit(-0.07 * s, 0.24 * s, -0.03 * s, 'smoke');
  });
}

/** Collapsible fuel bladder (pillow tank) inside a low earth berm. */
function fuelBladder(k: Kit, x: number, z: number, L = 0.5, W = 0.3, ry = 0, y = Y0) {
  const P = k.P;
  k.at(x, y, z, ry, () => {
    const berm: P2[] = [
      [-0.04, 0],
      [0.04, 0],
      [0.015, 0.04],
      [-0.015, 0.04],
    ];
    for (const sz of [-1, 1]) k.at(0, 0, (sz * (W + 0.08)) / 2, 0, () => k.at(0, 0, 0, Math.PI / 2, () => k.prism(P.soil, berm, L + 0.12)));
    for (const sx of [-1, 1]) k.at((sx * (L + 0.08)) / 2, 0, 0, 0, () => k.prism(P.soil, berm, W + 0.04));
    const g = new THREE.CapsuleGeometry(W / 2, L - W, 4, 14);
    g.rotateZ(Math.PI / 2);
    g.scale(1, 0.16, 1);
    g.translate(0, W * 0.08, 0);
    k.add(g, P.mats.col(0x2a2e26, 0.7, 0.1), 0);
    k.tube(P.dark, [L / 2 - 0.02, 0.02, 0], [L / 2 + 0.06, 0.02, 0.0], 0.008, 6);
  });
}

/** Military truck (cab at +X), kind: cargo (tarp), fuel (tank), crane. */
function truck(k: Kit, x: number, z: number, ry: number, kind: 'cargo' | 'fuel' | 'crane' = 'cargo', s = 1, y = Y0) {
  const P = k.P;
  const body = P.accent;
  k.at(x, y, z, ry, () => {
    k.box(P.dark, 0.5 * s, 0.03 * s, 0.1 * s, 0, 0.035 * s, 0);
    for (const wx of [0.17, -0.07, -0.17])
      for (const sz of [-1, 1]) k.tube(P.rubber, [wx * s, 0.035 * s, sz * 0.055 * s], [wx * s, 0.035 * s, sz * 0.085 * s], 0.035 * s, 10);
    // cab
    k.rbox(body, 0.12 * s, 0.12 * s, 0.16 * s, 0.18 * s, 0.05 * s, 0, 0.012);
    k.box(P.glass, 0.004, 0.045 * s, 0.13 * s, 0.241 * s, 0.11 * s, 0);
    for (const sz of [-1, 1]) k.box(P.glass, 0.05 * s, 0.035 * s, 0.003, 0.19 * s, 0.11 * s, sz * 0.081 * s);
    k.box(P.dark, 0.012, 0.03 * s, 0.17 * s, 0.245 * s, 0.05 * s, 0);
    for (const sz of [-1, 1]) k.sph(P.lamp, 0.008 * s, 0.248 * s, 0.07 * s, sz * 0.06 * s, 6, 4);
    if (kind === 'fuel') {
      k.tube(P.mats.col(mix(P.N.drab, 0xd8d8d0, 0.2), 0.5, 0.35), [-0.25 * s, 0.13 * s, 0], [0.1 * s, 0.13 * s, 0], 0.06 * s, 12);
      k.sph(P.mats.col(mix(P.N.drab, 0xd8d8d0, 0.2), 0.5, 0.35), 0.06 * s, -0.25 * s, 0.13 * s, 0, 12, 6);
      k.box(P.red, 0.03 * s, 0.03 * s, 0.003, -0.08 * s, 0.13 * s, 0.061 * s);
      k.box(P.dark, 0.3 * s, 0.006, 0.02 * s, -0.08 * s, 0.19 * s, 0);
    } else if (kind === 'crane') {
      k.box(body, 0.34 * s, 0.04 * s, 0.15 * s, -0.08 * s, 0.05 * s, 0);
      k.cyl(P.crane, 0.035 * s, 0.04 * s, -0.12 * s, 0.09 * s, 0, 10);
      k.at(-0.12 * s, 0.13 * s, 0, 0.4, () => {
        k.box(P.crane, 0.05 * s, 0.05 * s, 0.05 * s, 0, 0, 0);
        k.boxR(P.crane, 0.38 * s, 0.03 * s, 0.035 * s, 0.17 * s, 0.07 * s, 0, 0, 0, 0.35);
        k.tube(P.dark, [0.34 * s, 0.13 * s, 0], [0.34 * s, -0.05 * s, 0], 0.002, 3);
        k.box(P.yellow, 0.02 * s, 0.025 * s, 0.02 * s, 0.34 * s, -0.08 * s, 0);
      });
      for (const sz of [-1, 1]) k.box(P.dark, 0.02 * s, 0.05 * s, 0.03 * s, -0.2 * s, 0, sz * 0.1 * s);
    } else {
      k.box(body, 0.33 * s, 0.04 * s, 0.16 * s, -0.08 * s, 0.05 * s, 0);
      // tarp over hoops
      const tarp = P.canvas;
      k.box(tarp, 0.32 * s, 0.1 * s, 0.155 * s, -0.08 * s, 0.09 * s, 0);
      k.at(-0.08 * s, 0.19 * s, 0, Math.PI / 2, () => {
        const g = new THREE.CylinderGeometry(0.0775 * s, 0.0775 * s, 0.32 * s, 10, 1, false, -Math.PI / 2, Math.PI);
        g.rotateX(-Math.PI / 2);
        g.scale(1, 0.4, 1);
        k.add(g, tarp, 3);
      });
    }
    k.box(P.team, 0.122 * s, 0.014 * s, 0.162 * s, 0.18 * s, 0.17 * s, 0);
  });
}

/** Light utility vehicle (Humvee / Tigr / Wolf style), facing +X rotated by ry. */
function jeep(k: Kit, x: number, z: number, ry: number, s = 1, y = Y0) {
  const P = k.P;
  k.at(x, y, z, ry, () => {
    for (const wx of [0.09, -0.09]) for (const sz of [-1, 1]) k.tube(P.rubber, [wx * s, 0.03 * s, sz * 0.055 * s], [wx * s, 0.03 * s, sz * 0.078 * s], 0.03 * s, 10);
    k.rbox(P.accent, 0.3 * s, 0.06 * s, 0.15 * s, 0, 0.03 * s, 0, 0.012);
    k.rbox(P.accent, 0.16 * s, 0.05 * s, 0.14 * s, -0.03 * s, 0.09 * s, 0, 0.01);
    k.box(P.glass, 0.004, 0.035 * s, 0.12 * s, 0.051 * s, 0.095 * s, 0);
    for (const sz of [-1, 1]) k.box(P.glass, 0.07 * s, 0.03 * s, 0.003, -0.03 * s, 0.1 * s, sz * 0.071 * s);
    k.box(P.dark, 0.01, 0.03 * s, 0.13 * s, 0.152 * s, 0.035 * s, 0);
    k.box(P.team, 0.12 * s, 0.006, 0.08 * s, -0.03 * s, 0.141 * s, 0);
    k.cyl(P.dark, 0.003, 0.14 * s, -0.12 * s, 0.09 * s, -0.05 * s, 4);
  });
}

/** Tracked engineering dozer with blade (facing +X). */
function dozer(k: Kit, x: number, z: number, ry: number, s = 1, y = Y0) {
  const P = k.P;
  k.at(x, y, z, ry, () => {
    for (const sz of [-1, 1]) {
      k.rbox(P.rubber, 0.3 * s, 0.07 * s, 0.05 * s, 0, 0, sz * 0.075 * s, 0.025 * s);
      k.box(P.dark, 0.22 * s, 0.05 * s, 0.052 * s, 0, 0.01 * s, sz * 0.075 * s);
    }
    k.rbox(P.accent, 0.26 * s, 0.08 * s, 0.12 * s, -0.01 * s, 0.06 * s, 0, 0.01);
    k.rbox(P.accent, 0.1 * s, 0.09 * s, 0.1 * s, -0.06 * s, 0.14 * s, 0, 0.01);
    k.box(P.glass, 0.004, 0.05 * s, 0.08 * s, -0.009 * s, 0.155 * s, 0);
    k.cyl(P.dark, 0.008 * s, 0.07 * s, 0.07 * s, 0.14 * s, 0.03 * s, 6);
    // blade + push arms
    k.at(0.2 * s, 0, 0, 0, () => {
      k.boxR(P.drab, 0.025 * s, 0.09 * s, 0.24 * s, 0, 0.0, 0, 0, 0, 0.15);
      k.box(P.dark, 0.012 * s, 0.012 * s, 0.24 * s, 0.012 * s, 0.0, 0);
    });
    for (const sz of [-1, 1]) k.bar(P.dark, [0.1 * s, 0.04 * s, sz * 0.09 * s], [0.19 * s, 0.05 * s, sz * 0.09 * s], 0.014 * s);
    k.box(P.team, 0.1 * s, 0.012 * s, 0.102 * s, -0.06 * s, 0.23 * s, 0);
  });
}

/** Wooden pallet with strapped crates under a tarp. */
function pallet(k: Kit, x: number, z: number, ry = 0, y = Y0) {
  const P = k.P;
  k.at(x, y, z, ry, () => {
    k.box(P.wood, 0.14, 0.018, 0.12, 0, 0, 0, 8);
    k.box(P.canvas, 0.13, 0.07, 0.11, 0, 0.018, 0);
    k.box(P.dark, 0.132, 0.004, 0.012, 0, 0.088, 0.02);
    k.box(P.dark, 0.132, 0.004, 0.012, 0, 0.088, -0.02);
  });
}

/** Ammunition / equipment boxes in olive drab. */
function ammoBoxes(k: Kit, x: number, z: number, n = 4, ry = 0, y = Y0) {
  const P = k.P;
  k.at(x, y, z, ry, () => {
    for (let i = 0; i < n; i++) {
      const row = i % 3;
      const lvl = Math.floor(i / 3);
      k.rbox(P.drab, 0.07, 0.035, 0.04, -0.075 + row * 0.075, lvl * 0.036, 0, 0.004);
      k.box(P.yellow, 0.02, 0.008, 0.002, -0.075 + row * 0.075, lvl * 0.036 + 0.015, 0.021);
    }
  });
}

/** Camouflage net on poles over a rectangle (sagging between the poles, peak at the centre). */
function camoNet(k: Kit, x0: number, x1: number, z0: number, z1: number, h: number, peak = 0.05, y = Y0) {
  const P = k.P;
  const nx = 6;
  const nz = 6;
  const pos: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  const W = x1 - x0;
  const D = z1 - z0;
  for (let j = 0; j <= nz; j++)
    for (let i = 0; i <= nx; i++) {
      const u = i / nx;
      const v = j / nz;
      const xx = x0 + W * u;
      const zz = z0 + D * v;
      // sag between edge poles, lifted to a peak in the middle, hanging lower at the very edges
      const eu = Math.sin(u * Math.PI);
      const ev = Math.sin(v * Math.PI);
      const yy = y + h - 0.04 * (1 - eu * ev) + peak * eu * ev + 0.008 * Math.sin(u * 17 + v * 11);
      pos.push(xx, yy, zz);
      uvs.push(xx * 2.2, zz * 2.2);
    }
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  k.mesh(P.net, pos, idx, uvs);
  // poles at the corners and the centre
  for (const [px, pz] of [
    [x0 + 0.02, z0 + 0.02],
    [x1 - 0.02, z0 + 0.02],
    [x0 + 0.02, z1 - 0.02],
    [x1 - 0.02, z1 - 0.02],
  ] as P2[])
    k.cyl(P.dark, 0.005, h - 0.04, px, y, pz, 4);
  k.cyl(P.dark, 0.005, h + peak, (x0 + x1) / 2, y, (z0 + z1) / 2, 4);
}

/** Wall mounted split air conditioner. */
function aircon(k: Kit, face: Face, sign: number, a: number, y: number, at: number) {
  const P = k.P;
  faceBox(k, P.galv, face, sign, a, y, at, 0.07, 0.05, 0.03);
  if (face === 'z') k.at(a, y + 0.025, at + sign * 0.031, sign > 0 ? 0 : Math.PI, () => k.cyl(P.dark, 0.016, 0.002, 0, 0, 0, 10), Math.PI / 2);
  else k.at(at + sign * 0.031, y + 0.025, a, sign > 0 ? Math.PI / 2 : -Math.PI / 2, () => k.cyl(P.dark, 0.016, 0.002, 0, 0, 0, 10), Math.PI / 2);
}

/** Cable tray on short posts along a polyline at height h (power cable runs). */
function cableRun(k: Kit, pts: P2[], h = 0.08, y = Y0) {
  const P = k.P;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const ry = -Math.atan2(bz - az, bx - ax);
    k.at((ax + bx) / 2, y, (az + bz) / 2, ry, () => {
      k.box(P.galv, len + 0.03, 0.012, 0.04, 0, h, 0);
      k.box(P.black, len + 0.02, 0.008, 0.03, 0, h + 0.008, 0);
      const n = Math.max(1, Math.round(len / 0.18));
      for (let j = 0; j <= n; j++) k.box(P.galv, 0.008, h, 0.008, -len / 2 + (len * j) / n, 0, 0);
    });
  }
}

/** Fixed AESA radar face (team framed), facing +X in the current frame. */
function aesaFace(k: Kit, w: number, h: number, x = 0, y = 0, z = 0) {
  const P = k.P;
  k.box(P.drab, 0.03, h, w, x - 0.015, y, z);
  k.box(P.aesa, 0.004, h - 0.02, w - 0.02, x + 0.002, y + 0.01, z, 10);
  k.box(P.team, 0.034, 0.014, w + 0.004, x - 0.015, y + h - 0.014, z);
}

/** Simple rotating beacon (production / warning), shown only while a unit rolls out. */
function prodBeacon(k: Kit, name: string, x: number, y: number, z: number) {
  const P = k.P;
  k.cyl(P.dark, 0.014, 0.012, x, y, z, 8);
  k.cyl(P.mats.col(0x6a4a10, 0.3, 0.1), 0.012, 0.02, x, y + 0.012, z, 8);
  const o = k.node(name, x, y + 0.012, z);
  k.on(o, () => {
    k.box(P.amber_l, 0.03, 0.016, 0.008, 0, 0.002, 0);
  });
  k.specs.push({ k: 'prod', n: name, ax: 'y', a: 0, mode: 'vis', v: 9 });
}

/** Earth-covered bunker mound (ammo / command) with a concrete portal facing +Z. */
function bermBunker(k: Kit, x: number, z: number, w: number, d: number, h: number, ry = 0) {
  const P = k.P;
  k.at(x, Y0, z, ry, () => {
    const prof: P2[] = [
      [-w / 2 - h * 0.6, 0],
      [w / 2 + h * 0.6, 0],
      [w / 2, h],
      [-w / 2, h],
    ];
    k.at(0, 0, 0, 0, () => k.prism(P.soil, prof, d));
    k.box(P.soil, w - 0.02, 0.012, d - 0.04, 0, h, 0);
    // portal
    k.box(P.panel, w * 0.62, h * 0.95, 0.05, 0, 0, d / 2 + 0.02);
    k.box(P.door, w * 0.4, h * 0.62, 0.01, 0, 0, d / 2 + 0.046);
    k.box(P.team, w * 0.62, 0.02, 0.052, 0, h * 0.95 - 0.03, d / 2 + 0.021);
    k.box(P.lamp, 0.03, 0.01, 0.012, 0, h * 0.72, d / 2 + 0.05);
    for (const sx of [-1, 1]) k.box(P.panel, 0.03, h * 0.8, 0.1, sx * (w * 0.31 + 0.015), 0, d / 2 + 0.05);
    vent(k, w * 0.25, h, -d * 0.2, 0.018);
  });
}

/** Container stack / prefab module (ISO 20ft) with optional windows + door (prefab cabin). */
function cabin(k: Kit, x: number, y: number, z: number, ry: number, tint: number, L = 0.42, win = true) {
  const P = k.P;
  const H = 0.17;
  const Wd = 0.17;
  const m = P.mats.at(Tile.Corr, tint, 2.4);
  k.at(x, y, z, ry, () => {
    k.box(m, L, H, Wd, 0, 0, 0);
    k.box(P.mats.col(shade(tint, 0.7), 0.6, 0.4), L + 0.006, 0.012, Wd + 0.006, 0, H - 0.006, 0);
    k.box(P.mats.col(shade(tint, 0.7), 0.6, 0.4), L + 0.006, 0.012, Wd + 0.006, 0, 0, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(P.dark, 0.012, H, 0.012, sx * (L / 2 - 0.004), 0, sz * (Wd / 2 - 0.004));
    if (win) {
      for (let i = 0; i < 2; i++) {
        const c = -L / 2 + L * (0.3 + i * 0.4);
        k.panel(P.win, 'z', 1, c, 0.07, Wd / 2 + 0.003, 0.06, 0.05, cell(k));
        faceBox(k, P.dark, 'z', 1, c, 0.065, Wd / 2, 0.07, 0.006, 0.012);
        for (let j = 0; j < 3; j++) faceBox(k, P.dark, 'z', 1, c - 0.02 + j * 0.02, 0.07, Wd / 2 + 0.002, 0.003, 0.05, 0.004);
      }
      k.panel(P.door, 'x', 1, 0, 0.0, L / 2 + 0.003, 0.07, 0.13);
      k.box(P.lamp, 0.006, 0.006, 0.02, L / 2 + 0.006, 0.14, 0);
    }
  });
}

// ================================================================ CONSTRUCTION YARD (3x3)

/** Rail-mounted gantry crane spanning the yard: travels along z, trolley along x, with a prefab module on the hook. */
function gantryCrane(k: Kit, cx: number, z: number, span: number, H: number, zAmp: number) {
  const P = k.P;
  const cm = P.crane;
  // rails on concrete sleepers (static, root)
  for (const sx of [-1, 1]) {
    const rx = cx + (sx * span) / 2;
    k.box(P.concrete, 0.08, 0.018, 1.9, rx, Y0, 0.47);
    k.box(P.steel, 0.018, 0.016, 1.9, rx, Y0 + 0.018, 0.47);
    for (const zz of [-0.47, 1.41]) k.box(P.hazard, 0.06, 0.04, 0.03, rx, Y0, zz);
  }
  const g = k.node('gantry', cx, Y0 + 0.034, z);
  k.on(g, () => {
    for (const sx of [-1, 1]) {
      const lx = (sx * span) / 2;
      // end bogie with wheels
      k.box(cm, 0.07, 0.045, 0.42, lx, 0, 0);
      for (const sz of [-0.15, 0.15]) k.at(lx, 0.022, sz, 0, () => k.tube(P.dark, [-0.04, 0, 0], [0.04, 0, 0], 0.022, 10));
      k.box(P.hazard, 0.072, 0.02, 0.43, lx, 0.044, 0);
      // A-frame legs
      for (const sz of [-1, 1]) k.bar(cm, [lx, 0.06, sz * 0.17], [lx, H, sz * 0.07], 0.034);
      k.bar(cm, [lx, 0.3, -0.13], [lx, 0.3, 0.13], 0.02);
      k.bar(cm, [lx, 0.3, -0.13], [lx, 0.62, 0.1], 0.014);
      // ladder up one leg
      if (sx > 0) for (let yy = 0.12; yy < H - 0.05; yy += 0.05) k.box(P.galv, 0.004, 0.004, 0.04, lx + 0.02, yy, 0.19 - (yy / H) * 0.1);
    }
    // twin box girders + end ties + walkway
    for (const sz of [-1, 1]) {
      k.box(cm, span + 0.08, 0.075, 0.04, 0, H, sz * 0.07);
      k.box(P.team, span - 0.1, 0.02, 0.042, 0, H + 0.04, sz * 0.07);
    }
    for (const sx of [-1, 1]) k.box(cm, 0.07, 0.09, 0.2, (sx * span) / 2, H - 0.005, 0);
    k.box(P.grating, span - 0.06, 0.006, 0.06, 0, H + 0.075, 0.13);
    railing(k, [[-span / 2 + 0.05, 0.16], [span / 2 - 0.05, 0.16]], H + 0.081, 0.045, P.yellow);
    // operator cab under the girder
    k.box(cm, 0.12, 0.09, 0.11, span / 2 - 0.16, H - 0.1, -0.11);
    k.box(P.glass, 0.004, 0.05, 0.09, span / 2 - 0.22, H - 0.08, -0.11);
    k.box(P.glass, 0.1, 0.05, 0.004, span / 2 - 0.16, H - 0.08, -0.165);
    for (const sx of [-1, 1]) k.box(P.yellow, 0.02, 0.025, 0.02, sx * (span / 2 + 0.03), H + 0.075, -0.07);
    // trolley + hoist + load
    const tr = k.node('trolley', 0, H + 0.075, 0);
    k.on(tr, () => {
      k.box(cm, 0.18, 0.05, 0.22, 0, 0, 0);
      k.box(P.dark, 0.12, 0.05, 0.08, 0, 0.05, -0.03);
      k.tube(P.galv, [-0.06, 0.06, 0.06], [0.06, 0.06, 0.06], 0.025, 10);
      const drop = 0.48;
      for (const sx of [-0.03, 0.03]) k.tube(P.dark, [sx, 0, 0], [sx, -drop, 0], 0.0025, 3);
      k.box(P.yellow, 0.05, 0.04, 0.035, 0, -drop - 0.035, 0);
      // spreader + slings
      k.box(P.dark, 0.36, 0.012, 0.02, 0, -drop - 0.06, 0);
      for (const sx of [-1, 1]) k.tube(P.dark, [sx * 0.17, -drop - 0.06, 0], [sx * 0.17, -drop - 0.12, 0], 0.002, 3);
      // prefab module on the hook
      k.at(0, -drop - 0.12 - 0.15, 0, 0, () => {
        k.box(P.wall, 0.4, 0.15, 0.17, 0, 0, 0);
        k.box(P.team, 0.402, 0.015, 0.172, 0, 0.13, 0);
        for (const wx of [-0.08, 0.08]) k.box(P.glass, 0.07, 0.05, 0.004, wx, 0.05, 0.086);
      });
    });
  });
  k.specs.push({ k: 'slide', n: 'gantry', ax: 'z', a: zAmp, f: 0.1, p: 0.6, b: 0 });
  k.specs.push({ k: 'slide', n: 'trolley', ax: 'x', a: span * 0.3, f: 0.17, p: 2.1, b: 0 });
}

/** A-frame rack of precast wall panels. */
function panelRack(k: Kit, x: number, z: number, ry: number) {
  const P = k.P;
  k.at(x, Y0, z, ry, () => {
    k.box(P.dark, 0.36, 0.02, 0.14, 0, 0, 0);
    for (const sx of [-0.16, 0, 0.16]) {
      k.bar(P.drab, [sx, 0.02, -0.06], [sx, 0.24, 0], 0.012);
      k.bar(P.drab, [sx, 0.02, 0.06], [sx, 0.24, 0], 0.012);
    }
    for (const sz of [-1, 1])
      for (let i = 0; i < 2; i++) k.boxR(P.panel, 0.34, 0.22, 0.016, 0, 0.13, sz * (0.025 + i * 0.022), 0, sz * -0.22, 0, 1.6);
  });
}

/** Half assembled prefab module: floor frame, two walls, corner posts. */
function prefabFrame(k: Kit, x: number, z: number, ry: number) {
  const P = k.P;
  k.at(x, Y0, z, ry, () => {
    k.box(P.dark, 0.42, 0.025, 0.18, 0, 0, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(P.steel, 0.014, 0.17, 0.014, sx * 0.2, 0.025, sz * 0.083);
    k.box(P.wall, 0.42, 0.17, 0.012, 0, 0.025, -0.084);
    k.box(P.wall, 0.012, 0.17, 0.17, -0.205, 0.025, 0);
    k.box(P.steel, 0.42, 0.014, 0.014, 0, 0.19, 0.083);
    k.box(P.grating, 0.38, 0.006, 0.15, 0, 0.025, 0.0);
  });
}

function conyard(k: Kit) {
  const P = k.P;
  const N = P.N;
  slab(k, 3, 3);
  // cast concrete work pad under the gantry (bare concrete, no markings)
  k.box(P.concrete, 2.66, 0.006, 1.88, 0.0, Y0, 0.48);
  const roof = N.roofStyle === 'hip' ? 'hip' : N.roofStyle === 'gable' ? 'gable' : 'flat';

  // ---------------------------------------------------------- command block (back left)
  const top = block(k, { x0: -1.42, x1: -0.34, z0: -1.42, z1: -0.68, h: 0.5, floors: 2, door: -0.62, equip: 2, roof, sign: false, emblem: true });
  wallSign(k, 'z', 1, -1.08, Y0 + 0.31, -0.68, 0.36, 'main');
  aircon(k, 'x', 1, -1.0, Y0 + 0.08, -0.34);
  aircon(k, 'x', 1, -1.2, Y0 + 0.32, -0.34);
  sandbags(k, [-0.78, -0.56], [-0.46, -0.56], 2, Y0);
  if (roof === 'flat') satDish(k, -1.25, top - 0.05, -1.25, 0.09, 0.8, 0.7);
  // comms mast in the gap behind the yard
  lattice(k, P.galv, -0.17, -1.3, Y0, 1.25, 0.14, 0.05, 8, 0.007);
  for (const [y, a] of [
    [0.9, 0.5],
    [1.05, 2.2],
  ] as P2[])
    k.at(-0.17, Y0 + y, -1.3, a, () => k.box(P.white, 0.03, 0.12, 0.05, 0.05, 0, 0));
  k.blinkLight(-0.17, Y0 + 1.3, -1.3, 0.016, 1.5, 0);
  satDish(k, -0.17, Y0, -0.88, 0.08, 0.85, 0.9);

  // ---------------------------------------------------------- engineering workshop (back right)
  const wx0 = 0.04;
  const wx1 = 1.42;
  const wz0 = -1.42;
  const wz1 = -0.62;
  const wcx = (wx0 + wx1) / 2;
  const wcz = (wz0 + wz1) / 2;
  const shed = N.camoHalls ? P.camo : P.mats.at(Tile.Corr, mix(N.wall2, 0xd8d4c8, 0.35), 1.8);
  k.box(P.base, wx1 - wx0 + 0.014, 0.03, wz1 - wz0 + 0.014, wcx, Y0, wcz);
  k.box(shed, wx1 - wx0, 0.4, wz1 - wz0, wcx, Y0, wcz);
  dress(k, wx0, wx1, wz0, wz1, Y0, 0.4, { beacons: false, vent: false });
  k.box(P.team, wx1 - wx0 + 0.008, 0.026, wz1 - wz0 + 0.008, wcx, Y0 + 0.36, wcz);
  if (roof === 'flat') vault(k, P.mats.at(Tile.Corr, N.pitch, 1.8), shed, wcx, Y0 + 0.4, wcz, wz1 - wz0 + 0.04, wx1 - wx0 + 0.04, 0.2, true, 4, 2);
  else gable(k, P.pitch, shed, wcx, Y0 + 0.4, wcz, wx1 - wx0, wz1 - wz0, 0.2, 0.03, true);
  rollDoor(k, 'z', 1, 0.42, Y0, wz1, 0.36, 0.3, 0.65);
  k.box(P.lamp, 0.24, 0.012, 0.01, 0.42, Y0 + 0.27, wz1 - 0.12);
  rollDoor(k, 'z', 1, 1.0, Y0, wz1, 0.36, 0.3, 0);
  stencil(k, '01', 'z', 1, 0.42, Y0 + 0.36, wz1, 0.2);
  stencil(k, '02', 'z', 1, 1.0, Y0 + 0.36, wz1, 0.2);
  for (let i = 0; i < 3; i++) vent(k, 0.3 + i * 0.4, Y0 + 0.62, -1.02, 0.026);

  // ---------------------------------------------------------- gantry crane over the prefab yard
  gantryCrane(k, 0.0, 0.48, 2.62, 1.02, 0.36);
  // prefab sections under the crane path (kept low so the hook load clears them)
  prefabFrame(k, -0.42, 0.62, 0);
  k.emit(-0.62, Y0 + 0.2, 0.62, 'spark');
  cabin(k, 0.62, Y0, 0.08, 0, N.wall, 0.42);
  cabin(k, 0.62, Y0, 0.34, 0, N.wall, 0.42);
  panelRack(k, -0.88, 1.0, 0.0);
  // steel beams + rebar on dunnage
  for (let i = 0; i < 3; i++) k.box(P.mats.col(0x8a3b26, 0.6, 0.45), 0.5, 0.02, 0.025, 0.55, Y0 + 0.012 + i * 0.02, 0.98 + i * 0.006);
  k.box(P.wood, 0.03, 0.012, 0.12, 0.35, Y0, 0.99);
  k.box(P.wood, 0.03, 0.012, 0.12, 0.75, Y0, 0.99);
  for (let i = 0; i < 6; i++) k.tube(P.rust, [0.3, Y0 + 0.012, 1.2 + i * 0.012], [0.82, Y0 + 0.012, 1.2 + i * 0.012], 0.005, 4);
  pallet(k, -0.15, 1.05, 0.2);
  pallet(k, 0.02, 1.12, -0.1);
  ammoBoxes(k, -0.4, 0.15, 5, 0.3);

  // ---------------------------------------------------------- vehicles, power, perimeter
  dozer(k, -1.0, 0.3, 0.5, 1.15);
  truck(k, 1.0, 1.25, Math.PI, 'crane', 1.05);
  genset(k, 0.36, -0.44, 0, 0.9);
  cableRun(k, [[0.48, -0.44], [0.62, -0.44], [0.62, -0.6]], 0.05);
  postSign(k, -0.62, 1.38, 0, 0.34, 'main');
  flagPole(k, -0.12, -0.44, 0.8, Y0);
  hesco(k, [-1.46, -0.6], [-1.46, 1.44], 0.12, Y0);
  razor(k, [-1.46, -0.6], [-1.46, 1.44], Y0 + 0.12);
  floodMast(k, -1.34, -0.5, 0.62, 0.6);
  floodMast(k, 1.4, -0.5, 0.62, Math.PI - 0.6);
  k.height = 1.45;
}

// ================================================================ POWER PLANT (2x2)

/** Small wind turbine with a spinning three-blade rotor (German energy flavour). */
function windTurbine(k: Kit, x: number, z: number, H: number, ry: number) {
  const P = k.P;
  k.box(P.concrete, 0.12, 0.03, 0.12, x, Y0, z);
  k.cyl(P.white, 0.025, H, x, Y0 + 0.03, z, 10, 0.014);
  const head = k.node('nacelle', x, Y0 + 0.03 + H, z, ry);
  k.on(head, () => {
    k.rbox(P.white, 0.12, 0.05, 0.05, -0.02, -0.02, 0, 0.015);
    k.box(P.team, 0.122, 0.012, 0.052, -0.02, 0.012, 0);
    const rot = k.node('rotor', 0.05, 0.005, 0);
    k.on(rot, () => {
      k.sph(P.white, 0.025, 0.01, 0, 0, 8, 6);
      for (let i = 0; i < 3; i++) k.at(0.015, 0, 0, 0, () => k.boxR(P.white, 0.006, 0.36, 0.03, 0, 0.19, 0, 0, 0.08), (i / 3) * TAU);
    });
  });
  k.spin('rotor', 'x', 2.2);
  k.osc('nacelle', 'y', 0.25, 0.07, 0.4, 0);
  k.blinkLight(x, Y0 + 0.07 + H, z, 0.012, 1.6, 0.4);
}

/** Gas flare stack with a burning tip (Iranian gas-fired plant flavour). */
function flareStack(k: Kit, x: number, z: number, H: number) {
  const P = k.P;
  k.box(P.concrete, 0.12, 0.03, 0.12, x, Y0, z);
  lattice(k, P.mats.col(0xb8402a, 0.6, 0.4), x, z, Y0 + 0.03, H, 0.1, 0.05, 6, 0.006);
  k.cyl(P.dark, 0.016, H + 0.05, x, Y0 + 0.03, z, 8);
  k.cyl(P.dark, 0.026, 0.04, x, Y0 + 0.06 + H, z, 8);
  k.emit(x, Y0 + 0.14 + H, z, 'fire');
  k.emit(x, Y0 + 0.24 + H, z, 'smoke');
  k.blinkLight(x + 0.05, Y0 + H * 0.7, z, 0.01, 1.5, 0.3);
}

function power(k: Kit) {
  const P = k.P;
  const N = P.N;
  const f = P.s.faction;
  slab(k, 2, 2);
  // ------------------------------------------------ gas turbine generator hall (back)
  const x0 = -0.95;
  const x1 = 0.32;
  const z0 = -0.95;
  const z1 = -0.3;
  const H = 0.4;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const hall = N.camoHalls ? P.camo : P.mats.at(N.wall2Tile === Tile.Paint ? Tile.Clad : N.wall2Tile, N.wall2);
  k.box(P.base, x1 - x0 + 0.014, 0.03, z1 - z0 + 0.014, cx, Y0, cz);
  k.box(hall, x1 - x0, H, z1 - z0, cx, Y0, cz);
  dress(k, x0, x1, z0, z1, Y0, H, { beacons: false, vent: false });
  k.box(P.team, x1 - x0 + 0.01, 0.03, z1 - z0 + 0.01, cx, Y0 + H - 0.05, cz);
  flatRoof(k, x0, x1, z0, z1, Y0 + H, 0.03, hall);
  rollDoor(k, 'z', 1, -0.55, Y0, z1, 0.28, 0.26, 0);
  door(k, 'z', 1, -0.12, Y0, z1, 0.09, 0.18);
  wallSign(k, 'z', 1, 0.12, Y0 + 0.24, z1, 0.26, 'num', 'G1');
  // louvred ventilation band on the +X face
  for (let i = 0; i < 4; i++) faceBox(k, P.dark, 'x', 1, cz, Y0 + 0.2 + i * 0.03, x1, z1 - z0 - 0.16, 0.012, 0.012);
  // combustion air intake filter house (roof, -X end) + exhaust stacks (+X end)
  const ry = Y0 + H + 0.01;
  k.box(P.drab, 0.34, 0.16, 0.3, -0.7, ry, -0.62);
  for (let i = 0; i < 5; i++) k.box(P.dark, 0.012, 0.12, 0.31, -0.86 + i * 0.075, ry + 0.02, -0.62);
  k.box(P.team, 0.342, 0.014, 0.302, -0.7, ry + 0.16, -0.62);
  k.box(P.steel, 0.2, 0.08, 0.14, -0.42, ry, -0.62);
  for (const sx of [-0.12, 0.12]) {
    k.box(P.drab, 0.13, 0.12, 0.13, sx, ry, -0.62);
    k.cyl(P.galv, 0.05, 0.62, sx, ry + 0.12, -0.62, 14, 0.046);
    k.cyl(P.dark, 0.052, 0.03, sx, ry + 0.72, -0.62, 14);
    k.ring(P.grating, 0.075, 0.012, sx, ry + 0.48, -0.62, 14);
    k.emit(sx, ry + 0.82, -0.62, 'steam');
  }
  k.blinkLight(-0.12, ry + 0.76, -0.62, 0.014, 1.5, 0);
  k.blinkLight(0.12, ry + 0.76, -0.62, 0.014, 1.5, 0.75);
  // ------------------------------------------------ radiator cooling bank (back right)
  coolingCells(k, 0.42, 0.95, -0.95, -0.12, 0.26, 2);
  // ------------------------------------------------ switchyard + cable runs (front left)
  switchyard(k, -0.95, 0.22, 0.2, 0.95, 2);
  cableRun(k, [[-0.62, -0.28], [-0.62, 0.18]], 0.07);
  cableRun(k, [[-0.25, -0.28], [-0.25, 0.18]], 0.07);
  // ------------------------------------------------ front right: nation flavour + fuel / gensets
  if (f === 'germany') {
    windTurbine(k, 0.72, 0.62, 1.15, -0.6);
    genset(k, 0.62, 0.15, Math.PI / 2, 0.85);
  } else if (f === 'israel') {
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) solarPanel(k, 0.48 + j * 0.3, Y0, 0.25 + i * 0.32, 0.26, 0.18, 0.55);
    genset(k, 0.72, 0.88, 0, 0.8);
  } else if (f === 'iran') {
    flareStack(k, 0.78, 0.78, 0.95);
    fuelBladder(k, 0.62, 0.3, 0.46, 0.26, Math.PI / 2);
  } else if (f === 'russia') {
    coolingTower(k, 0.66, 0.6, 0.32, 0.78);
  } else if (f === 'ukraine') {
    chimney(k, 0.75, 0.72, 1.55, 0.075, 0.055, true);
    k.emit(0.75, Y0 + 1.62, 0.72, 'smoke');
    genset(k, 0.55, 0.2, Math.PI / 2, 0.85);
  } else {
    // bunded diesel day tank + gensets
    k.box(P.concrete, 0.5, 0.05, 0.3, 0.68, Y0, 0.35);
    k.box(P.concrete, 0.46, 0.04, 0.26, 0.68, Y0 + 0.01, 0.35);
    k.at(0.68, Y0 + 0.12, 0.35, 0, () => {
      k.tube(P.tank, [-0.18, 0, 0], [0.18, 0, 0], 0.08, 14);
      k.sph(P.tank, 0.08, -0.18, 0, 0, 12, 6);
      k.sph(P.tank, 0.08, 0.18, 0, 0, 12, 6);
      k.tube(P.team, [-0.02, 0, 0], [0.02, 0, 0], 0.082, 14);
    });
    genset(k, 0.6, 0.78, 0, 0.85);
  }
  pylon(k, 0.86, -0.02, 0.62, 0, 0.18);
  floodMast(k, 0.32, 0.92, 0.5, -2.2);
  k.height = 1.3;
}

// ================================================================ BARRACKS (2x2)

/** Guard tower (steel legs, sandbagged platform under a camo roof). */
function watchtower(k: Kit, x: number, z: number) {
  const P = k.P;
  const h = 0.5;
  const s = 0.07;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.bar(P.drab, [x + sx * s * 1.3, Y0, z + sz * s * 1.3], [x + sx * s, Y0 + h, z + sz * s], 0.018);
  for (const yy of [0.15, 0.32]) {
    k.bar(P.drab, [x - s * 1.2, Y0 + yy, z + s * 1.2], [x + s * 1.2, Y0 + yy + 0.1, z + s * 1.2], 0.008);
    k.bar(P.drab, [x + s * 1.2, Y0 + yy, z - s * 1.2], [x + s * 1.2, Y0 + yy + 0.1, z + s * 1.2], 0.008);
  }
  k.box(P.grating, 0.2, 0.015, 0.2, x, Y0 + h, z);
  sandbags(k, [x - 0.09, z + 0.09], [x + 0.09, z + 0.09], 1, Y0 + h + 0.015);
  sandbags(k, [x + 0.09, z - 0.09], [x + 0.09, z + 0.09], 1, Y0 + h + 0.015);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(P.galv, 0.01, 0.14, 0.01, x + sx * 0.09, Y0 + h, z + sz * 0.09);
  k.box(P.camo, 0.25, 0.015, 0.25, x, Y0 + h + 0.14, z);
  k.box(P.team, 0.252, 0.012, 0.252, x, Y0 + h + 0.13, z);
  k.box(P.dark, 0.03, 0.02, 0.04, x + 0.06, Y0 + h + 0.1, z + 0.06);
  k.box(P.flood, 0.004, 0.014, 0.03, x + 0.077, Y0 + h + 0.1, z + 0.06);
  ladder(k, 'x', 1, z, Y0, Y0 + h, x + 0.07);
}

/** Two storey stack of accommodation modules with an access gallery and a roof canopy (nation style). */
function chuStack(k: Kit, x0: number, x1: number, z0: number, z1: number) {
  const P = k.P;
  const N = P.N;
  const L = x1 - x0;
  const D = z1 - z0;
  const cz = (z0 + z1) / 2;
  const H = 0.19;
  const n = 2;
  const ml = (L - 0.02) / n;
  for (let lvl = 0; lvl < 2; lvl++)
    for (let i = 0; i < n; i++) {
      const mx = x0 + 0.01 + ml * (i + 0.5);
      const y = Y0 + lvl * H;
      k.box(P.wall, ml - 0.012, H - 0.006, D, mx, y, cz);
      k.box(P.base, ml - 0.008, 0.014, D + 0.004, mx, y, cz);
      // windows + door per module on the +Z face
      for (let w = 0; w < 2; w++) {
        const c = mx - ml * 0.3 + w * ml * 0.32;
        k.panel(P.win, 'z', 1, c, y + 0.07, z1 + 0.003, 0.07, 0.06, cell(k));
        faceBox(k, P.trim, 'z', 1, c, y + 0.065, z1, 0.08, 0.006, 0.012);
        faceBox(k, P.accent, 'z', 1, c - 0.055, y + 0.06, z1, 0.022, 0.075, 0.006);
      }
      k.panel(P.door, 'z', 1, mx + ml * 0.33, y + 0.015, z1 + 0.003, 0.06, 0.14);
      faceBox(k, P.lamp, 'z', 1, mx + ml * 0.33, y + 0.16, z1, 0.02, 0.006, 0.012);
      aircon(k, 'z', 1, mx + ml * 0.12, y + 0.1, z1);
    }
  // team band between the levels + on top
  k.box(P.team, L + 0.006, 0.02, D + 0.006, (x0 + x1) / 2, Y0 + H - 0.012, cz);
  k.box(P.team, L + 0.006, 0.02, D + 0.006, (x0 + x1) / 2, Y0 + 2 * H - 0.016, cz);
  // access gallery (upper level) + stair at the +X end
  const gz = z1 + 0.06;
  k.box(P.grating, L, 0.008, 0.11, (x0 + x1) / 2, Y0 + H, gz);
  for (let i = 0; i <= 4; i++) k.box(P.steel, 0.012, H, 0.012, x0 + (L * i) / 4, Y0, gz + 0.05);
  railing(k, [[x0, gz + 0.055], [x1 - 0.12, gz + 0.055]], Y0 + H + 0.008, 0.06, P.galv);
  stairs(k, x1 - 0.06, gz + 0.02, Y0, Y0 + H, false, 1, 0.07);
  // canopy roof
  const ry = Y0 + 2 * H;
  if (N.roofStyle === 'flat') {
    for (const sx of [x0 + 0.03, x1 - 0.03]) for (const sz of [z0 + 0.03, gz + 0.04]) k.box(P.steel, 0.012, 0.07, 0.012, sx, ry, sz);
    k.box(P.mats.at(Tile.Corr, N.roof, 2), L + 0.06, 0.012, D + 0.17, (x0 + x1) / 2, ry + 0.07, (z0 + gz + 0.06) / 2);
    k.box(P.team, L + 0.065, 0.016, 0.014, (x0 + x1) / 2, ry + 0.068, gz + 0.1);
    hvac(k, x0 + 0.3, ry + 0.082, cz - 0.02, 0.14, 0.1);
  } else if (N.roofStyle === 'hip') {
    asianRoof(k, P.pitch, P.dark, (x0 + x1) / 2, ry, (z0 + gz + 0.05) / 2, L + 0.08, D + 0.18, 0.16, 0.01, P.dark);
  } else {
    gable(k, P.pitch, P.wall, (x0 + x1) / 2, ry, (z0 + gz + 0.05) / 2, L, D + 0.12, 0.14, 0.04, true);
  }
}

function barracks(k: Kit) {
  const P = k.P;
  const N = P.N;
  slab(k, 2, 2);
  // accommodation stack (back)
  chuStack(k, -0.95, 0.95, -0.95, -0.6);
  // HQ / armoury hut (front left)
  const hx0 = -0.95;
  const hx1 = -0.3;
  const hz0 = -0.3;
  const hz1 = 0.18;
  block(k, { x0: hx0, x1: hx1, z0: hz0, z1: hz1, h: 0.26, floors: 1, doorX: -0.06, equip: 1, roof: N.roofStyle === 'hip' ? 'hip' : N.roofStyle === 'gable' ? 'gable' : 'flat', sign: false, rise: 0.12 });
  wallSign(k, 'z', 1, (hx0 + hx1) / 2, Y0 + 0.13, hz1, 0.3, 'main');
  sandbags(k, [hx1 + 0.06, -0.2], [hx1 + 0.06, 0.08], 2, Y0);
  // camo net over the ammunition / kit area (centre)
  camoNet(k, -0.2, 0.42, -0.4, 0.12, 0.26, 0.05);
  ammoBoxes(k, -0.05, -0.2, 6, 0.1);
  pallet(k, 0.24, -0.25, 0.4);
  ammoBoxes(k, 0.2, -0.0, 4, -0.3);
  // perimeter: hesco along the left and back of the front, guard tower at the front left
  hesco(k, [-0.98, 0.25], [-0.98, 0.98], 0.13, Y0);
  hesco(k, [-0.95, 0.98], [-0.3, 0.98], 0.13, Y0);
  razor(k, [-0.98, 0.25], [-0.98, 0.98], Y0 + 0.13);
  watchtower(k, -0.78, 0.78);
  flagPole(k, -0.12, 0.5, 0.72, Y0);
  // training bars + water tank + generator (right side, leaving the exit at the front right clear)
  for (let i = 0; i < 3; i++) k.box(P.galv, 0.008, 0.18, 0.008, 0.62 + i * 0.12, Y0, -0.3);
  k.bar(P.galv, [0.62, Y0 + 0.17, -0.3], [0.86, Y0 + 0.17, -0.3], 0.006);
  k.at(0.86, Y0, 0.0, 0, () => {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(P.steel, 0.01, 0.12, 0.01, sx * 0.05, 0, sz * 0.05);
    k.cyl(P.black, 0.065, 0.12, 0, 0.12, 0, 14);
    k.cyl(P.dark, 0.05, 0.012, 0, 0.24, 0, 14);
  });
  genset(k, 0.55, 0.05, Math.PI / 2, 0.8);
  sandbags(k, [0.3, 0.98], [0.95, 0.98], 2, Y0);
  floodMast(k, 0.95, 0.4, 0.5, Math.PI);
  postSign(k, -0.05, 0.92, 0, 0.26, 'unit', P.s.faction === 'neutral' ? '' : N.sign.num + ' 3');
  k.height = 0.95;
}

// ================================================================ WAR FACTORY (3x3)

/** Roof turbine ventilator (spinning). */
function turbineVent(k: Kit, name: string, x: number, y: number, z: number) {
  const P = k.P;
  k.cyl(P.galv, 0.03, 0.04, x, y, z, 10);
  const o = k.node(name, x, y + 0.04, z);
  k.on(o, () => {
    k.sph(P.galv, 0.04, 0, 0.025, 0, 10, 6);
    for (let i = 0; i < 8; i++) k.boxR(P.steel, 0.004, 0.04, 0.02, Math.cos((i / 8) * TAU) * 0.038, 0.02, Math.sin((i / 8) * TAU) * 0.038, -(i / 8) * TAU, 0, 0.3);
  });
  k.spin(name, 'y', 3 + (x * 7) % 2);
}

function factory(k: Kit) {
  const P = k.P;
  const N = P.N;
  slab(k, 3, 3, Y0, [-0.53, 0.53, -0.5]);
  // vehicle lane through the middle at ground level (cast concrete, no paint)
  k.box(P.concrete, 1.04, 0.002, 2.0, 0, 0, 0.5);
  // vehicle lift deck on the exit tile (steel plate flush with the apron, hazard edged, corner lamps)
  k.box(P.mats.at(Tile.Plate, 0x8a8e90, 2.6), 0.82, 0.012, 0.82, 0, 0.002, 0.0);
  k.box(P.hazard, 0.84, 0.014, 0.03, 0, 0.002, 0.415);
  k.box(P.hazard, 0.84, 0.014, 0.03, 0, 0.002, -0.415);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    k.box(P.yellow, 0.025, 0.05, 0.025, sx * 0.45, 0, sz * 0.45);
    k.box(P.amber_l, 0.02, 0.008, 0.02, sx * 0.45, 0.05, sz * 0.45);
  }

  // ------------------------------------------------ main assembly hangar (back, full width)
  const z0 = -1.42;
  const z1 = -0.5;
  const zc = (z0 + z1) / 2;
  const L = z1 - z0;
  const H = 0.64;
  const DH = 0.5; // door height
  const hall = N.camoHalls ? P.camo : P.mats.at(N.wall2Tile === Tile.Paint ? Tile.Clad : N.wall2Tile, N.wall2);
  k.box(P.base, 2.86, 0.03, L + 0.014, 0, Y0, zc);
  for (const sx of [-1, 1]) {
    // hall walls either side of the bay
    const wx = sx * (0.55 + 0.44);
    k.box(hall, 0.88, H, L, wx, Y0, zc);
    dress(k, wx - 0.44, wx + 0.44, z0, z1, Y0, H, { beacons: false, cab: sx > 0, vent: sx < 0 });
  }
  k.box(hall, 1.1, H, 0.3, 0, Y0, z0 + 0.15); // back of the bay
  k.box(hall, 1.1, H - DH, 0.06, 0, Y0 + DH, z1 - 0.03); // lintel over the door
  k.box(P.team, 2.87, 0.04, L + 0.01, 0, Y0 + H - 0.07, zc);
  // bay interior (dark, lit) behind the big roller door
  k.box(P.dark, 1.1, 0.01, L - 0.3, 0, Y0, zc + 0.15);
  k.box(P.mats.col(0x3a3d40, 0.8, 0.2), 0.012, DH, L - 0.3, -0.545, Y0, zc + 0.15);
  k.box(P.mats.col(0x3a3d40, 0.8, 0.2), 0.012, DH, L - 0.3, 0.545, Y0, zc + 0.15);
  k.box(P.lamp, 0.8, 0.012, 0.012, 0, Y0 + DH - 0.04, zc);
  k.box(P.lamp, 0.8, 0.012, 0.012, 0, Y0 + DH - 0.04, zc + 0.3);
  // big roller door (animated: rolls up while a vehicle rolls out)
  const dh = DH * k.sy;
  const bdoor = k.node('bigdoor', 0, Y0 + DH, z1 + 0.004);
  k.on(bdoor, () => {
    k.panel(P.rollup, 'z', 1, 0, -dh, 0, 1.06, dh, [0, 0, 0, 1.06 * 9, dh * 9, 1.06 * 9, dh * 9, 0]);
    k.box(P.dark, 1.06, 0.02, 0.012, 0, -dh, 0);
  });
  k.specs.push({ k: 'prod', n: 'bigdoor', ax: 'y', a: -0.92, mode: 'scl' });
  // door portal: hazard jambs, team header, beacons
  for (const sx of [-1, 1]) {
    k.box(P.hazard, 0.05, DH, 0.05, sx * 0.555, Y0, z1 + 0.02);
    prodBeacon(k, 'beacon' + (sx > 0 ? 'R' : 'L'), sx * 0.6, Y0 + DH + 0.02, z1 + 0.05);
  }
  k.box(P.team, 1.16, 0.05, 0.05, 0, Y0 + DH + 0.005, z1 + 0.02);
  k.box(P.dark, 1.08, 0.04, 0.05, 0, Y0 + DH + 0.055, z1 + 0.02);
  wallSign(k, 'z', 1, 0, Y0 + DH + 0.14, z1, 0.5, 'main');
  // hall facades: high window bands + small doors
  for (const sx of [-1, 1]) {
    const a0 = sx > 0 ? 0.6 : -1.38;
    const a1 = sx > 0 ? 1.38 : -0.6;
    ribbon(k, 'z', 1, a0, a1, Y0 + 0.4, z1, 0.08, false);
    door(k, 'z', 1, sx * 1.15, Y0, z1, 0.1, 0.18, true);
  }
  ribbon(k, 'x', 1, z0 + 0.08, z1 - 0.08, Y0 + 0.4, 1.42, 0.08, false);
  // roof: nation style over the full hangar + ventilators + skylights
  const rTop = Y0 + H;
  if (N.roofStyle === 'gable' || N.roofStyle === 'hip') {
    gable(k, P.pitch, hall, 0, rTop, zc, 2.86, L, 0.3, 0.04, true);
    for (let i = 0; i < 4; i++) turbineVent(k, 'tv' + i, -1.05 + i * 0.7, rTop + 0.3, zc);
    for (let i = 0; i < 3; i++) k.at(-0.9 + i * 0.9, rTop + 0.15, zc + L * 0.24, 0, () => k.box(P.glass, 0.3, 0.012, 0.16, 0, 0, 0), Math.atan2(0.3, L / 2));
  } else {
    vault(k, P.mats.at(Tile.Corr, N.pitch, 1.6), hall, 0, rTop, zc, L + 0.04, 2.9, 0.3, true, 4, 4);
    for (let i = 0; i < 4; i++) turbineVent(k, 'tv' + i, -1.05 + i * 0.7, rTop + 0.28, zc);
    k.box(P.glass, 2.2, 0.014, 0.12, 0, rTop + 0.29, zc + 0.12);
  }
  // exhaust stacks (paint shop / engine test cell)
  for (const sx of [-1.25, -1.05]) {
    k.cyl(P.galv, 0.035, 0.55, sx, Y0, z0 + 0.08, 10);
    k.cyl(P.dark, 0.037, 0.03, sx, Y0 + 0.55, z0 + 0.08, 10);
  }
  k.emit(-1.25, Y0 + 0.64, z0 + 0.08, 'smoke');

  // ------------------------------------------------ front left: maintenance bays opening onto the lane
  const ax0 = -1.42;
  const ax1 = -0.6;
  const az0 = -0.42;
  const az1 = 0.62;
  k.box(P.base, ax1 - ax0 + 0.014, 0.03, az1 - az0 + 0.014, (ax0 + ax1) / 2, Y0, (az0 + az1) / 2);
  k.box(P.wall, ax1 - ax0, 0.36, az1 - az0, (ax0 + ax1) / 2, Y0, (az0 + az1) / 2);
  rollDoor(k, 'x', 1, -0.15, Y0, ax1, 0.32, 0.26, 0.7);
  rollDoor(k, 'x', 1, 0.33, Y0, ax1, 0.32, 0.26, 0);
  k.box(P.lamp, 0.01, 0.012, 0.22, ax1 - 0.1, Y0 + 0.24, -0.15);
  dress(k, ax0, ax1, az0, az1, Y0, 0.36, { beacons: false, cab: false });
  k.box(P.team, ax1 - ax0 + 0.008, 0.026, az1 - az0 + 0.008, (ax0 + ax1) / 2, Y0 + 0.32, (az0 + az1) / 2);
  flatRoof(k, ax0, ax1, az0, az1, Y0 + 0.36, 0.03);
  roofKit(k, ax0, ax1, az0, az1, Y0 + 0.37, 2);
  // ------------------------------------------------ front right: stores / office block + parts yard
  block(k, { x0: 0.6, x1: 1.42, z0: -0.42, z1: 0.36, h: 0.42, floors: 2, door: 1.0, equip: 2, sign: false, roof: 'flat' });
  wallSign(k, 'x', 1, -0.05, Y0 + 0.28, 1.42, 0.3, 'num', '7');
  // engine on a stand + spare track + crates (front right corner)
  k.at(1.0, Y0, 0.82, 0.2, () => {
    k.box(P.steel, 0.2, 0.06, 0.14, 0, 0, 0);
    k.rbox(P.dark, 0.18, 0.1, 0.12, 0, 0.06, 0, 0.01);
    k.cyl(P.drab, 0.03, 0.06, 0.05, 0.16, 0, 8);
  });
  for (let i = 0; i < 2; i++) k.box(P.rubber, 0.5, 0.02, 0.07, 1.05, Y0 + i * 0.02, 1.18 + i * 0.01);
  crate(k, 0.72, Y0, 1.22, 0.09);
  crate(k, 0.74, Y0 + 0.072, 1.2, 0.07, 0.4);
  ammoBoxes(k, 1.3, 0.62, 5, Math.PI / 2);
  // front left corner: fuel bowser + jeep
  truck(k, -1.0, 1.0, 0, 'fuel', 1.05);
  jeep(k, -1.05, 1.32, 0.1, 1.0);
  floodMast(k, -0.58, 1.38, 0.55, -Math.PI / 2 - 0.5);
  floodMast(k, 0.58, 1.38, 0.55, -Math.PI / 2 + 0.5);
  k.height = 1.15;
}

// ================================================================ REFINERY (3x3)

function silo(k: Kit, x: number, z: number, r: number, h: number, m: Mat, top: 'cone' | 'dome' | 'flat' = 'cone', y = Y0, legs = 0) {
  const P = k.P;
  const y0 = y + legs;
  if (legs > 0) {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU + Math.PI / 4;
      k.box(P.steel, 0.025, legs + 0.05, 0.025, x + Math.cos(a) * r * 0.75, y, z + Math.sin(a) * r * 0.75);
    }
    k.cyl(m, r * 0.3, legs * 0.6, x, y + legs * 0.4, z, 10, r * 0.95);
  }
  k.cyl(m, r, h, x, y0, z, 18);
  if (top === 'cone') k.cyl(m, 0.03, r * 0.6, x, y0 + h, z, 18, r);
  else if (top === 'dome') k.dome(m, r, x, y0 + h, z, 18, 6, 0.75);
  else k.cyl(P.concrete, r * 1.02, 0.02, x, y0 + h, z, 18);
  k.cyl(P.team, r * 1.01, 0.035, x, y0 + h * 0.82, z, 18);
  for (const f of [0.3, 0.55]) k.ring(P.dark, r * 1.003, 0.004, x, y0 + h * f, z, 18);
}

function oreHeap(k: Kit, x: number, z: number, r: number, h: number) {
  const m = k.P.mats.at(Tile.Soil, 0xd8a848, 1.6);
  k.lathe(m, [[r, 0], [r * 0.75, h * 0.45], [r * 0.4, h * 0.85], [0.001, h]], x, Y0, z, 12);
}

/** Round thickener / settling tank with a slowly rotating rake bridge. */
function thickener(k: Kit, name: string, x: number, z: number, r: number) {
  const P = k.P;
  k.lathe(P.concrete, [[r - 0.03, 0.1], [r - 0.03, 0.12], [r, 0.12], [r, 0]], x, Y0, z, 28);
  k.cyl(P.mats.col(0x4e5236, 0.15, 0.6), r - 0.03, 0.1, x, Y0, z, 24);
  k.ring(P.team, r + 0.002, 0.008, x, Y0 + 0.11, z, 28);
  k.cyl(P.steel, 0.03, 0.16, x, Y0, z, 10);
  const b = k.node(name, x, Y0 + 0.16, z);
  k.on(b, () => {
    k.box(P.grating, r * 2 - 0.04, 0.008, 0.05, 0, 0, 0);
    railing(k, [[-r + 0.03, 0.025], [r - 0.03, 0.025]], 0.008, 0.035, P.yellow);
    k.box(P.drab, 0.06, 0.04, 0.06, 0, 0.008, 0);
    k.box(P.steel, 0.015, 0.06, 0.015, r - 0.04, -0.06, 0);
  });
  k.spin(name, 'y', 0.25);
}

/** Rotary dryer drum on roller stations (spins slowly), axis along z. */
function rotaryDrum(k: Kit, x: number, z0: number, z1: number, r: number) {
  const P = k.P;
  const y = Y0 + r + 0.06;
  for (const zz of [z0 + 0.12, z1 - 0.12]) {
    k.box(P.concrete, r * 2 + 0.08, 0.05, 0.08, x, Y0, zz);
    for (const sx of [-1, 1]) k.at(x + sx * r * 0.7, Y0 + 0.07, zz, 0, () => k.tube(P.dark, [0, 0, -0.03], [0, 0, 0.03], 0.025, 8));
  }
  const d = k.node('drum', x, y, (z0 + z1) / 2);
  k.on(d, () => {
    k.tube(P.mats.col(0x6a5040, 0.6, 0.5), [0, 0, -(z1 - z0) / 2], [0, 0, (z1 - z0) / 2], r, 16);
    for (const f of [-0.3, 0.3]) k.tube(P.steel, [0, 0, f * (z1 - z0) - 0.015], [0, 0, f * (z1 - z0) + 0.015], r + 0.012, 16);
    k.tube(P.team, [0, 0, -0.02], [0, 0, 0.02], r + 0.008, 16);
    k.box(P.dark, 0.02, r * 0.6, 0.06, r, -r * 0.3, 0);
  });
  k.spin('drum', 'z', 0.6);
  // firing hood + stack at the far end
  k.box(P.drab, r * 2 + 0.06, r * 2 + 0.06, 0.1, x, Y0 + 0.04, z0 - 0.03);
  k.cyl(P.galv, 0.04, 0.55, x, Y0 + r * 2 + 0.1, z0 - 0.03, 10);
  k.emit(x, Y0 + r * 2 + 0.7, z0 - 0.03, 'steam');
}

function refinery(k: Kit) {
  const P = k.P;
  const N = P.N;
  slab(k, 3, 3, Y0, [-0.52, 0.52, 0.52]);
  // ------------------------------------------------ harvester dock (front centre tile, ground level, bare concrete)
  k.box(P.concrete, 1.02, 0.008, 1.0, 0, 0, 1.0);
  // flush steel kerb plates (the harvester drives over them)
  for (const sx of [-1, 1]) k.box(P.hazard, 0.03, 0.006, 0.9, sx * 0.46, 0.008, 1.0);
  k.box(P.mats.at(Tile.Plate, 0x9a9e9c, 2.4), 0.8, 0.006, 0.5, 0, 0.008, 0.85);
  // ------------------------------------------------ ore intake hopper behind the dock
  const hz = 0.3;
  k.box(P.concrete, 0.94, 0.08, 0.04, 0, Y0, hz - 0.2);
  k.box(P.concrete, 0.04, 0.08, 0.38, -0.45, Y0, hz);
  k.box(P.concrete, 0.04, 0.08, 0.38, 0.45, Y0, hz);
  k.box(P.black, 0.86, 0.01, 0.36, 0, Y0 + 0.02, hz);
  k.box(P.grating, 0.86, 0.006, 0.36, 0, Y0 + 0.05, hz, 8);
  k.at(0, Y0 + 0.08, hz - 0.1, Math.PI / 2, () => k.prism(P.steel, [[-0.1, 0], [0.12, 0], [0.18, 0.2], [-0.18, 0.2]], 0.7));
  k.box(P.team, 0.72, 0.03, 0.01, 0, Y0 + 0.22, hz + 0.08);
  k.box(P.hazard, 0.72, 0.02, 0.012, 0, Y0 + 0.26, hz + 0.075);
  oreHeap(k, -0.32, hz + 0.02, 0.12, 0.08);
  // inclined conveyor gallery up into the plant
  const c0: V3 = [0, Y0 + 0.24, hz - 0.12];
  const c1: V3 = [0, Y0 + 0.72, -0.5];
  const len = Math.hypot(c1[1] - c0[1], c1[2] - c0[2]);
  const ang = Math.atan2(c1[1] - c0[1], -(c1[2] - c0[2]));
  k.at(0, (c0[1] + c1[1]) / 2, (c0[2] + c1[2]) / 2, 0, () => {
    k.local(() => k.box(P.mats.at(Tile.Corr, mix(N.wall2, 0xd8d8d0, 0.4), 2), 0.16, 0.1, len, 0, -0.05, 0));
    k.box(P.team, 0.165, 0.016, len, 0, 0.03, 0);
    k.box(P.steel, 0.18, 0.012, len, 0, -0.06, 0);
    for (let i = 0; i < 5; i++) k.box(P.lamp, 0.004, 0.012, 0.03, 0.082, -0.03, -len / 2 + 0.08 + i * (len - 0.16) / 4);
  }, ang);
  for (const t of [0.35, 0.7]) {
    const y = c0[1] + (c1[1] - c0[1]) * t - 0.06;
    const z = c0[2] + (c1[2] - c0[2]) * t;
    k.box(P.steel, 0.02, y - Y0, 0.02, -0.06, Y0, z);
    k.box(P.steel, 0.02, y - Y0, 0.02, 0.06, Y0, z);
    k.box(P.steel, 0.14, 0.015, 0.02, 0, y - 0.015, z);
  }
  // ------------------------------------------------ processing plant (back centre)
  const px0 = -0.62;
  const px1 = 0.62;
  const pz0 = -1.42;
  const pz1 = -0.5;
  const top = block(k, { x0: px0, x1: px1, z0: pz0, z1: pz1, h: 0.66, floors: 3, wall: P.mats.at(N.wall2Tile === Tile.Paint ? Tile.Clad : N.wall2Tile, N.wall2), equip: 2, sign: false, roof: 'flat' });
  wallSign(k, 'z', 1, -0.3, Y0 + 0.5, pz1, 0.36, 'main');
  // crusher / kiln tower on top + stack
  k.box(P.wallB, 0.4, 0.3, 0.36, -0.3, top - 0.03, -1.15);
  k.box(P.team, 0.402, 0.03, 0.362, -0.3, top + 0.22, -1.15);
  k.cyl(P.concrete, 0.06, 0.6, -0.36, top + 0.27, -1.2, 12, 0.05);
  k.cyl(P.red, 0.052, 0.06, -0.36, top + 0.8, -1.2, 12);
  k.emit(-0.36, top + 0.95, -1.2, 'smoke');
  k.blinkLight(-0.36, top + 0.9, -1.2, 0.014, 1.4, 0.3);
  // ------------------------------------------------ left: storage silos on legs with a conveyor gallery on top
  for (let i = 0; i < 3; i++) silo(k, -1.12, -1.2 + i * 0.34, 0.15, 0.62, P.tank, 'cone', Y0, 0.2);
  k.box(P.mats.at(Tile.Corr, mix(N.wall2, 0xd8d8d0, 0.4), 2), 0.08, 0.06, 0.75, -1.12, Y0 + 0.94, -0.86);
  k.box(P.grating, 0.1, 0.008, 0.75, -1.12, Y0 + 1.0, -0.86);
  railing(k, [[-1.17, -1.23], [-1.17, -0.5]], Y0 + 1.0, 0.05);
  k.at(-0.84, Y0 + 0.97, -0.9, 0, () => k.box(P.mats.at(Tile.Corr, mix(N.wall2, 0xd8d8d0, 0.4), 2), 0.48, 0.06, 0.08, 0, 0, 0), 0, -0.12);
  ladder(k, 'x', 1, -0.75, Y0, Y0 + 0.98, -0.97);
  oreHeap(k, -1.12, -0.2, 0.26, 0.2);
  // ------------------------------------------------ right: rotary dryer + thickener + pipe rack
  rotaryDrum(k, 0.98, -1.35, -0.55, 0.09);
  thickener(k, 'rake', 1.05, 0.05, 0.34);
  const rx = 0.72;
  for (let i = 0; i < 3; i++) {
    const z = -0.4 + i * 0.28;
    k.box(P.steel, 0.02, 0.32, 0.02, rx - 0.06, Y0, z);
    k.box(P.steel, 0.02, 0.32, 0.02, rx + 0.06, Y0, z);
    k.box(P.steel, 0.16, 0.02, 0.025, rx, Y0 + 0.3, z);
  }
  const pc = [P.yellow, P.galv, P.mats.col(0x3f6a9a, 0.5, 0.4)];
  for (let i = 0; i < 3; i++) k.tube(pc[i], [rx - 0.045 + i * 0.045, Y0 + 0.34, -0.5], [rx - 0.045 + i * 0.045, Y0 + 0.34, 0.2], 0.014, 8);
  k.pipe(P.galv, [[px1, Y0 + 0.34, -0.55], [rx, Y0 + 0.34, -0.55], [rx, Y0 + 0.34, -0.5]], 0.014, 8);
  k.pipe(P.mats.col(0x3f6a9a, 0.5, 0.4), [[rx + 0.045, Y0 + 0.34, 0.2], [rx + 0.045, Y0 + 0.14, 0.2], [0.85, Y0 + 0.14, 0.2]], 0.014, 8);
  // ------------------------------------------------ front left: weighbridge / control cabin + loader
  cabin(k, -1.0, Y0, 0.62, 0, N.wall, 0.5);
  k.box(N.roofStyle === 'flat' ? P.roof : P.pitch, 0.56, 0.012, 0.24, -1.0, Y0 + 0.18, 0.62);
  wallSign(k, 'z', 1, -1.0, Y0 + 0.11, 0.705, 0.22, 'num', 'R1');
  dozer(k, -0.95, 1.12, -0.4, 1.05);
  floodMast(k, -0.62, 1.4, 0.5, -1.2);
  floodMast(k, 0.62, 1.4, 0.5, -1.9);
  // front right: ore stockpile
  oreHeap(k, 1.08, 0.95, 0.32, 0.22);
  oreHeap(k, 0.78, 1.25, 0.18, 0.12);
  k.height = 1.25;
}

// ================================================================ RADAR (2x2)

/** Curved reflector strip (part of a vertical cylinder), facing +X, double sided. */
function reflector(k: Kit, m: Mat, R: number, arc: number, h: number, x: number, y: number, z: number) {
  const g = new THREE.CylinderGeometry(R, R, h, 14, 1, true, Math.PI / 2 - arc / 2, arc);
  g.translate(x - R, y + h / 2, z);
  k.add(g, m, 0);
}

function radar(k: Kit) {
  const P = k.P;
  const N = P.N;
  const R = P.R;
  slab(k, 2, 2);
  const white = P.mats.col(0xeceee8, 0.55, 0.05, true);
  // ------------------------------------------------ operations shelters under a camo net (front left)
  cabin(k, -0.55, Y0, 0.3, 0, N.wall, 0.62);
  cabin(k, -0.55, Y0, 0.68, 0, N.boxes[0], 0.62);
  camoNet(k, -0.95, -0.12, 0.08, 0.92, 0.3, 0.05);
  genset(k, -0.1, 0.55, Math.PI / 2, 0.8);
  cableRun(k, [[-0.2, 0.15], [0.3, 0.15], [0.3, -0.2]], 0.05);
  satcom(k, 'sat', -0.6, Y0, -0.45, 0.13);
  for (let i = 0; i < 3; i++) antenna(k, -0.92 + i * 0.12, Y0, -0.9, 0.42 + i * 0.1);
  postSign(k, 0.2, 0.9, 0, 0.28, 'main');
  // ------------------------------------------------ radar head (back right)
  const tx = 0.45;
  const tz = -0.45;
  if (R === 'east') {
    // P-18 style yagi mast (static) + concrete pedestal with a rotating mesh reflector
    const yx = -0.1;
    const yz = -0.75;
    k.box(P.concrete, 0.16, 0.04, 0.16, yx, Y0, yz);
    k.cyl(P.dark, 0.016, 1.0, yx, Y0, yz, 8, 0.012);
    for (let r = 0; r < 2; r++) for (let i = 0; i < 5; i++) k.bar(P.galv, [yx - 0.2 + i * 0.1, Y0 + 0.8 + r * 0.14, yz - 0.16], [yx - 0.2 + i * 0.1, Y0 + 0.8 + r * 0.14, yz + 0.16], 0.006);
    k.bar(P.galv, [yx - 0.24, Y0 + 0.8, yz], [yx + 0.24, Y0 + 0.8, yz], 0.012);
    k.bar(P.galv, [yx - 0.24, Y0 + 0.94, yz], [yx + 0.24, Y0 + 0.94, yz], 0.012);
    k.blinkLight(yx, Y0 + 1.02, yz, 0.014, 1.5, 0);
    k.cyl(P.panel, 0.22, 0.6, tx, Y0, tz, 16, 0.18);
    k.cyl(P.team, 0.182, 0.03, tx, Y0 + 0.54, tz, 16);
    stencil(k, '5', 'x', 1, tz, Y0 + 0.25, tx + 0.2, 0.2);
    const d = k.node('dish', tx, Y0 + 0.6, tz);
    const mesh = P.mats.col(0x9aa0a4, 0.5, 0.5, true);
    k.on(d, () => {
      k.cyl(P.dark, 0.13, 0.04, 0, 0, 0, 16);
      k.box(P.accent, 0.22, 0.13, 0.18, -0.02, 0.04, 0);
      k.box(P.glass, 0.005, 0.05, 0.14, -0.132, 0.1, 0);
      k.at(0, 0, 0, Math.PI, () => {
        reflector(k, mesh, 0.75, 1.05, 0.46, -0.2, 0.17, 0);
        reflector(k, P.chain, 0.752, 1.05, 0.46, -0.198, 0.17, 0);
        for (let i = -2; i <= 2; i++) {
          const a = i * 0.24;
          const px = -0.2 - 0.75 * (1 - Math.cos(a));
          const pz = Math.sin(a) * 0.75;
          k.bar(P.galv, [-0.1, 0.17, 0], [px - 0.01, 0.17, pz], 0.01);
          k.bar(P.galv, [-0.1, 0.17, 0], [px - 0.01, 0.63, pz], 0.01);
        }
        k.bar(P.galv, [-0.2, 0.4, 0], [0.42, 0.3, 0], 0.01);
        k.box(P.dark, 0.06, 0.06, 0.06, 0.42, 0.27, 0);
      });
    });
    k.spin('dish', 'y', 1.0);
    k.height = 1.15;
  } else if (R === 'mideast') {
    // stone tower with a large radome + rotating dish beside it
    k.box(P.base, 0.42, 0.04, 0.42, tx, Y0, tz);
    k.box(P.wall2, 0.36, 0.6, 0.36, tx, Y0 + 0.04, tz);
    punched(k, 'z', 1, tx - 0.12, tx + 0.12, 2, Y0 + 0.3, tz + 0.18, 0.05, 0.12, 'plain');
    punched(k, 'x', 1, tz - 0.12, tz + 0.12, 2, Y0 + 0.3, tx + 0.18, 0.05, 0.12, 'plain');
    flatRoof(k, tx - 0.18, tx + 0.18, tz - 0.18, tz + 0.18, Y0 + 0.64, 0.03, P.wall2);
    k.cyl(P.concrete, 0.16, 0.05, tx, Y0 + 0.65, tz, 16);
    k.sph(P.dome, 0.27, tx, Y0 + 0.92, tz, 24, 16);
    k.ring(P.team, 0.2, 0.012, tx, Y0 + 0.74, tz, 24);
    k.blinkLight(tx, Y0 + 1.2, tz, 0.014, 1.5, 0);
    const d = k.node('dish', -0.1, Y0, -0.6);
    k.on(d, () => {
      k.cyl(P.dark, 0.06, 0.08, 0, 0, 0, 12);
      k.box(P.galv, 0.03, 0.22, 0.03, -0.02, 0.06, 0);
      k.at(0, 0.32, 0, 0, () => {
        const pts: P2[] = [];
        for (let i = 0; i <= 6; i++) pts.push([0.2 * (i / 6) + 0.001, 0.07 * (i / 6) ** 2]);
        k.lathe(white, pts, 0, 0, 0, 20, 0);
        k.tube(P.dark, [0, 0, 0], [0, 0.17, 0], 0.005, 4);
        k.ring(P.team, 0.2, 0.008, 0, 0.07, 0, 20);
      }, 0, Math.PI / 2 - 0.35);
    });
    k.spin('dish', 'y', 1.1);
    k.height = 1.25;
  } else {
    // lattice mast with four fixed AESA faces and a rotating surveillance array on top
    k.box(P.concrete, 0.42, 0.04, 0.42, tx, Y0, tz);
    lattice(k, P.galv, tx, tz, Y0 + 0.04, 0.95, 0.36, 0.2, 6, 0.011);
    const ty = Y0 + 0.99;
    k.box(P.grating, 0.34, 0.012, 0.34, tx, ty, tz);
    railing(k, [[tx - 0.17, tz - 0.17], [tx + 0.17, tz - 0.17], [tx + 0.17, tz + 0.17], [tx - 0.17, tz + 0.17], [tx - 0.17, tz - 0.17]], ty + 0.012, 0.045);
    k.box(P.drab, 0.22, 0.22, 0.22, tx, ty + 0.012, tz);
    for (let i = 0; i < 4; i++) k.at(tx, ty + 0.012, tz, (i / 4) * TAU + Math.PI / 4, () => aesaFace(k, 0.2, 0.2, 0.125, 0.01, 0));
    k.box(P.team, 0.24, 0.02, 0.24, tx, ty + 0.234, tz);
    const d = k.node('dish', tx, ty + 0.254, tz);
    k.on(d, () => {
      k.cyl(P.dark, 0.05, 0.06, 0, 0, 0, 12);
      k.at(0.0, 0.08, 0, 0, () => {
        k.boxR(P.drab, 0.04, 0.16, 0.5, 0.02, 0.0, 0, 0, 0, -0.25);
        k.boxR(P.aesa, 0.004, 0.14, 0.48, 0.042, 0.01, 0, 0, 0, -0.25);
        k.box(P.team, 0.042, 0.014, 0.5, 0.0, 0.15, 0);
      });
    });
    k.spin('dish', 'y', 1.3);
    k.blinkLight(tx + 0.17, ty + 0.06, tz + 0.17, 0.014, 1.4, 0);
    k.blinkLight(tx - 0.17, ty + 0.06, tz - 0.17, 0.014, 1.4, 0.7);
    k.box(P.wall2, 0.24, 0.16, 0.18, tx - 0.05, Y0, tz + 0.36);
    hvac(k, tx - 0.05, Y0 + 0.16, tz + 0.36, 0.14, 0.1);
    k.height = 1.45;
  }
  // perimeter fence with razor wire (right + front)
  fence(k, [[0.12, 0.98], [0.98, 0.98], [0.98, -0.98]], 0.14, Y0);
  razor(k, [0.98, 0.98], [0.98, -0.98], Y0 + 0.14);
  floodMast(k, 0.92, 0.3, 0.5, Math.PI - 0.4);
}

// ================================================================ DRONE HUB / AIRFIELD (3x3)

/** Parked MALE drone (MQ-9 / TB2 style) facing +X. */
function parkedDrone(k: Kit, x: number, y: number, z: number, ry: number, s = 1) {
  const P = k.P;
  const body = P.mats.col(0xc4c8cc, 0.5, 0.25);
  k.at(x, y, z, ry, () => {
    k.tube(body, [-0.22 * s, 0.07 * s, 0], [0.18 * s, 0.07 * s, 0], 0.03 * s, 10, 0.022 * s);
    k.sph(body, 0.032 * s, 0.18 * s, 0.07 * s, 0, 10, 8);
    k.sph(body, 0.022 * s, -0.22 * s, 0.07 * s, 0, 8, 6);
    k.box(body, 0.07 * s, 0.008 * s, 0.7 * s, 0.0, 0.085 * s, 0);
    k.box(P.team, 0.072 * s, 0.009 * s, 0.06 * s, 0.0, 0.085 * s, 0.32 * s);
    k.box(P.team, 0.072 * s, 0.009 * s, 0.06 * s, 0.0, 0.085 * s, -0.32 * s);
    for (const sz of [-1, 1]) k.boxR(body, 0.07 * s, 0.006 * s, 0.14 * s, -0.2 * s, 0.1 * s, sz * 0.05 * s, 0, sz * 0.7);
    k.box(P.dark, 0.01 * s, 0.1 * s, 0.012 * s, -0.255 * s, 0.03 * s, 0);
    for (const [gx, gz] of [
      [0.12, 0],
      [-0.04, -0.05],
      [-0.04, 0.05],
    ])
      k.box(P.dark, 0.006 * s, 0.05 * s, 0.006 * s, gx * s, 0, gz * s);
    k.sph(P.dark, 0.022 * s, 0.14 * s, 0.04 * s, 0, 8, 6);
  });
}

/** Painted runway designator / stand number (white on transparent), read from the approach end. */
function texPaint(text: string, color = '#f2f0e8') {
  return canvasTex('paint|' + text + color, 128, 128, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.fillStyle = color;
    c.font = 'bold 92px "DejaVu Sans Condensed", Arial Narrow, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, w / 2, h / 2 + 4);
  });
}

/** Bomb trolley with two heavy bombs (stand dressing: the rearm crew's load). */
function bombTrolley(k: Kit, x: number, z: number, ry: number, y = Y0) {
  const P = k.P;
  const olive = P.mats.col(0x5c6248, 0.6, 0.25);
  k.at(x, y, z, ry, () => {
    k.box(P.yellow, 0.2, 0.012, 0.09, 0, 0.026, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.cyl(P.rubber, 0.014, 0.012, sx * 0.08, 0.004, sz * 0.045, 8);
    k.tube(P.dark, [0.1, 0.03, 0], [0.17, 0.03, 0], 0.004, 4);
    for (const sz of [-1, 1]) {
      k.tube(olive, [-0.085, 0.058, sz * 0.024], [0.07, 0.058, sz * 0.024], 0.02, 10);
      k.sph(olive, 0.02, 0.07, 0.058, sz * 0.024, 8, 6);
      k.box(P.yellow, 0.004, 0.042, 0.042, 0.04, 0.038, sz * 0.024);
      k.box(P.dark, 0.03, 0.03, 0.004, -0.095, 0.045, sz * 0.024);
    }
  });
}

/**
 * Airbase (7 x 4 tiles; sim/airbase.ts): runway along the front row, a taxiway across the middle,
 * four revetted jet stands along the back (1.5 tiles apart, centred 0.75 + 1.5 i from the left edge)
 * and the control tower in the back-right corner. The sim parks its jets on the stands; the runway
 * is used one way (take-off and landing in the same direction).
 */
function airfield(k: Kit) {
  const P = k.P;
  const N = P.N;
  // level slab with a deep skirt: it sits on the highest ground under the footprint (renderer slabHeight)
  k.plan(P.slab, rect(7 - 0.024, 4 - 0.024), Y0 + 0.4, 0, -0.4, 0, 0.008);
  const yM = Y0 + 0.006; // paint
  // ------------------------------------------------ runway (local z 0.62 .. 1.78)
  const rz = 1.2;
  const rw = 1.16;
  const rx = 3.48;
  k.box(P.asphalt, rx * 2, 0.005, rw, 0, Y0, rz);
  // shoulders
  for (const sz of [-1, 1]) k.box(P.concrete, rx * 2, 0.004, 0.05, 0, Y0, rz + sz * (rw / 2 + 0.02));
  for (const sz of [-1, 1]) k.box(P.white, rx * 2 - 0.1, 0.002, 0.018, 0, yM, rz + sz * (rw / 2 - 0.04));
  dashes(k, P.white, -2.25, rz, 2.25, rz, 0.22, 0.14, 0.022, yM);
  for (const sx of [-1, 1]) {
    const xe = sx * (rx - 0.05);
    // threshold piano keys
    for (let i = 0; i < 8; i++) {
      const zz = rz - rw / 2 + 0.11 + (i + (i >= 4 ? 1 : 0)) * ((rw - 0.22) / 8);
      k.box(P.white, 0.3, 0.002, 0.045, xe - sx * 0.2, yM, zz);
    }
    // designator: 09 at the west end, 27 at the east end (read on the approach)
    const num = sx < 0 ? '09' : '27';
    k.decal(P.mats.canvas('rwy' + num, texPaint(num), { alphaTest: 0.45 }), xe - sx * 0.62, yM + 0.001, rz, 0.34, 0.34, [0, 0, 1, 1], sx < 0 ? Math.PI / 2 : -Math.PI / 2);
    // aiming point and touchdown zone bars
    for (const sz of [-1, 1]) {
      k.box(P.white, 0.36, 0.002, 0.07, sx * 1.75, yM, rz + sz * 0.26);
      k.box(P.white, 0.2, 0.002, 0.035, sx * 2.35, yM, rz + sz * 0.3);
      k.box(P.white, 0.2, 0.002, 0.035, sx * 2.35, yM, rz + sz * 0.22);
    }
    // runway end lights: green threshold bar, red end bar behind it
    for (let i = 0; i < 7; i++) {
      const zz = rz - rw / 2 + 0.08 + (i * (rw - 0.16)) / 6;
      k.box(P.green_l, 0.022, 0.012, 0.022, xe, Y0, zz);
    }
  }
  // edge lights (white, every half tile) and the approach strobe posts
  for (let i = 0; i <= 13; i++) {
    const x = -rx + 0.25 + i * 0.5;
    for (const sz of [-1, 1]) k.box(P.lamp, 0.018, 0.014, 0.018, x, Y0, rz + sz * (rw / 2 + 0.035));
  }
  // ------------------------------------------------ taxiway (local z -0.18 .. 0.28) + links to the runway ends
  const tz = 0.05;
  k.box(P.asphalt, 6.9, 0.004, 0.46, 0, Y0, tz);
  for (const sx of [-1, 1]) k.box(P.asphalt, 0.62, 0.004, 0.4, sx * 2.95, Y0, 0.42);
  // yellow centreline + lead-ins
  k.box(P.yellow, 6.4, 0.002, 0.016, -0.05, yM, tz);
  for (const sx of [-1, 1]) k.box(P.yellow, 0.016, 0.002, 1.1, sx * 2.95, yM, 0.6);
  // holding position markings (double solid + double dashed) at both runway links
  for (const sx of [-1, 1]) {
    for (const dz of [0, 0.035]) k.box(P.yellow, 0.56, 0.002, 0.01, sx * 2.95, yM, 0.5 + dz);
    dashes(k, P.yellow, sx * 2.95 - 0.27, 0.58, sx * 2.95 + 0.27, 0.58, 0.05, 0.04, 0.01, yM);
  }
  // blue taxiway edge lights
  for (let i = 0; i < 12; i++) {
    const x = -3.2 + i * 0.56;
    for (const sz of [-1, 1]) k.box(P.cyan_l, 0.014, 0.012, 0.014, x, Y0, tz + sz * 0.25);
  }

  // ------------------------------------------------ four jet stands (local x -2.75, -1.25, 0.25, 1.75; z -1.95 .. -0.2)
  const pz = -1.15;
  for (let i = 0; i < 4; i++) {
    const cx = -2.75 + i * 1.5;
    k.box(P.concrete, 1.36, 0.005, 1.66, cx, Y0, -1.1);
    // expansion joints
    for (const dz of [-0.55, 0]) k.box(P.dark, 1.34, 0.001, 0.008, cx, Y0 + 0.005, -1.1 + dz);
    // lead-in line from the taxiway to the nose wheel stop, then the stop bar
    k.box(P.yellow, 0.016, 0.002, 1.05, cx, yM, -0.68);
    k.box(P.yellow, 0.2, 0.002, 0.03, cx, yM, pz - 0.38);
    // stand number on the apron
    const n = String(i + 1);
    k.decal(P.mats.canvas('stand' + n, texPaint(n, '#f2d23a'), { alphaTest: 0.45 }), cx + 0.42, yM + 0.001, -0.42, 0.22, 0.22);
    // team chevron in front of the stand
    k.box(P.team, 0.5, 0.003, 0.03, cx, yM, -0.3);
    // ground equipment: bomb trolley (the 10 s rearm), chocks rack, power cart
    bombTrolley(k, cx - 0.5, -1.72, 0);
    k.rbox(P.mats.col(0xd8c040, 0.6, 0.15), 0.12, 0.06, 0.08, cx + 0.48, Y0, -1.74, 0.01);
    k.box(P.dark, 0.08, 0.02, 0.04, cx + 0.48, Y0 + 0.06, -1.74);
    // stand floodlight
    if (i % 2 === 0) lightPole(k, cx - 0.66, -1.88, 0.42, 0.6, Y0);
  }
  // revetments: precast T-walls between and behind the stands, low enough to see the jets from the RTS camera
  for (let i = 0; i <= 4; i++) {
    const x = -3.42 + i * 1.5 - (i === 4 ? 0.02 : 0);
    tWall(k, [x, -1.95], [x, -0.72], 0.13, Y0);
  }
  tWall(k, [-3.42, -1.95], [2.48, -1.95], 0.13, Y0);

  // ------------------------------------------------ control tower (back-right corner): stacked containers + glass cab
  const tx = 3.0;
  const twz = -1.2;
  cabin(k, tx, Y0, twz + 0.18, 0, N.wall, 0.6);
  cabin(k, tx, Y0, twz - 0.2, 0, N.boxes[0], 0.6);
  cabin(k, tx, Y0 + 0.17, twz - 0.01, 0, N.wall, 0.6, false);
  k.box(P.steel, 0.28, 0.02, 0.28, tx, Y0 + 0.34, twz);
  k.box(P.mats.col(0x2a4258, 0.15, 0.8), 0.24, 0.12, 0.24, tx, Y0 + 0.36, twz);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(P.dark, 0.012, 0.12, 0.012, tx + sx * 0.12, Y0 + 0.36, twz + sz * 0.12);
  k.box(P.lamp, 0.22, 0.004, 0.22, tx, Y0 + 0.42, twz);
  k.box(P.dark, 0.3, 0.03, 0.3, tx, Y0 + 0.48, twz);
  k.box(P.team, 0.302, 0.014, 0.302, tx, Y0 + 0.5, twz);
  stairs(k, tx - 0.36, twz + 0.12, Y0, Y0 + 0.34, true, 1, 0.07);
  antenna(k, tx - 0.08, Y0 + 0.51, twz, 0.35);
  satDish(k, tx + 0.08, Y0 + 0.51, twz - 0.05, 0.05, 0.6);
  k.blinkLight(tx, Y0 + 0.9, twz, 0.016, 1.3, 0);
  k.cyl(P.dark, 0.004, 0.38, tx, Y0 + 0.51, twz, 4);
  wallSign(k, 'z', 1, tx, Y0 + 0.08, twz + 0.27, 0.3, 'main');
  // windsock
  k.cyl(P.concrete, 0.025, 0.02, 3.3, Y0, -0.42, 8);
  k.cyl(P.galv, 0.007, 0.36, 3.3, Y0, -0.42, 6);
  const sock = k.node('sock', 3.3, Y0 + 0.35, -0.42, -0.6);
  k.on(sock, () => {
    k.ring(P.galv, 0.026, 0.004, 0, 0, 0, 10);
    for (let i = 0; i < 5; i++) {
      const g = new THREE.CylinderGeometry(0.026 - i * 0.004, 0.026 - (i + 1) * 0.004, 0.036, 10, 1, true);
      g.rotateZ(-Math.PI / 2);
      g.translate(0.018 + i * 0.036, -i * 0.006, 0);
      k.add(g, i % 2 ? P.white : P.mats.col(0xf06a1a, 0.7, 0, true), 0);
    }
  });
  k.osc('sock', 'y', 0.35, 0.9, 0, 0);
  k.blinkLight(3.3, Y0 + 0.39, -0.42, 0.01, 1.0, 0.2);
  // fuel bowser by the tower, fuel bladder, generator
  truck(k, 2.75, -0.55, Math.PI, 'fuel', 0.9);
  fuelBladder(k, 3.22, -1.82, 0.36, 0.2, Math.PI / 2);
  genset(k, 2.68, -1.88, 0, 0.7);
  floodMast(k, 3.38, 0.4, 0.5, Math.PI);
  floodMast(k, -3.38, -0.1, 0.5, 0);
  k.height = 1.3;
}

// ================================================================ BATTLE LAB / RESEARCH CENTRE (3x3)

/** Rotating satellite-communications dish on a pedestal (animated). */
function satcom(k: Kit, name: string, x: number, y: number, z: number, r: number) {
  const P = k.P;
  const white = P.mats.col(0xeceee8, 0.5, 0.05, true);
  k.cyl(P.concrete, r * 0.5, 0.04, x, y, z, 12);
  k.cyl(P.galv, r * 0.16, r * 0.8, x, y + 0.04, z, 10);
  const d = k.node(name, x, y + 0.04 + r * 0.8, z);
  k.on(d, () => {
    k.box(P.galv, r * 0.4, r * 0.25, r * 0.3, 0, 0, 0);
    k.at(0, r * 0.35, 0, 0, () => {
      const pts: P2[] = [];
      for (let i = 0; i <= 6; i++) pts.push([r * (i / 6) + 0.001, r * 0.3 * (i / 6) ** 2]);
      k.lathe(white, pts, 0, 0, 0, 24, 0);
      k.ring(P.team, r, r * 0.04, 0, r * 0.3, 0, 24);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU;
        k.tube(P.dark, [Math.cos(a) * r * 0.8, r * 0.2, Math.sin(a) * r * 0.8], [0, r * 0.75, 0], 0.003, 4);
      }
      k.box(P.dark, r * 0.12, r * 0.12, r * 0.12, 0, r * 0.75, 0);
    }, 0, Math.PI / 2 - 0.5);
  });
  k.osc(name, 'y', 1.2, 0.12, x * 3, 0);
}

/** Directed-energy prototype on a test pad (battle lab yard prop). */
function prototypeLaser(k: Kit, x: number, z: number) {
  const P = k.P;
  k.plan(P.concrete, regular(6, 0.26, Math.PI / 6), 0.02, x, Y0, z, 0.006);
  k.cyl(P.dark, 0.09, 0.06, x, Y0 + 0.02, z, 12);
  k.rbox(P.white, 0.14, 0.1, 0.12, x, Y0 + 0.08, z, 0.015);
  k.box(P.team, 0.142, 0.02, 0.122, x, Y0 + 0.14, z);
  k.at(x, Y0 + 0.2, z, 0.6, () => {
    k.tube(P.galv, [-0.05, 0, 0], [0.16, 0.06, 0], 0.035, 12);
    k.tube(P.cyan_l, [0.16, 0.06, 0], [0.17, 0.063, 0], 0.028, 12);
    k.box(P.dark, 0.06, 0.05, 0.1, -0.06, -0.03, 0);
    for (const sz of [-1, 1]) k.box(P.galv, 0.012, 0.06, 0.012, 0.0, -0.06, sz * 0.05);
  });
  k.box(P.mats.col(0x3a3d40, 0.8, 0.2), 0.16, 0.12, 0.04, x - 0.3, Y0, z + 0.25);
  k.box(P.cyan_l, 0.004, 0.02, 0.025, x - 0.219, Y0 + 0.08, z + 0.25);
  k.tube(P.black, [x - 0.22, Y0 + 0.01, z + 0.25], [x - 0.05, Y0 + 0.02, z + 0.05], 0.006, 4);
}

/** Bank of server / chiller units with spinning fans on top. */
function chillers(k: Kit, x0: number, x1: number, z: number, n: number, tag: string, spin = true) {
  const P = k.P;
  const w = (x1 - x0) / n;
  for (let i = 0; i < n; i++) {
    const cx = x0 + w * (i + 0.5);
    k.box(P.galv, w - 0.02, 0.14, 0.22, cx, Y0, z);
    for (let j = 0; j < 5; j++) k.box(P.dark, w - 0.04, 0.008, 0.004, cx, Y0 + 0.03 + j * 0.02, z + 0.111);
    k.cyl(P.black, 0.07, 0.005, cx, Y0 + 0.14, z, 14);
    k.ring(P.dark, 0.07, 0.006, cx, Y0 + 0.147, z, 14);
    const blades = () => {
      for (let b = 0; b < 5; b++) k.boxR(P.steel, 0.06, 0.003, 0.018, Math.cos((b / 5) * TAU) * 0.03, 0, -Math.sin((b / 5) * TAU) * 0.03, (b / 5) * TAU, 0.3);
    };
    if (spin) {
      k.on(k.node(tag + i, cx, Y0 + 0.146, z), blades);
      k.spin(tag + i, 'y', 6 + i);
    } else k.at(cx, Y0 + 0.146, z, i * 0.7, blades);
    k.box(P.team, w - 0.018, 0.012, 0.222, cx, Y0 + 0.12, z);
  }
}

function tech(k: Kit) {
  const P = k.P;
  slab(k, 3, 3);
  // ------------------------------------------------ hardened lab block (back left): windowless, blast door
  const x0 = -1.42;
  const x1 = 0.25;
  const z0 = -1.42;
  const z1 = -0.4;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  k.box(P.base, x1 - x0 + 0.014, 0.03, z1 - z0 + 0.014, cx, Y0, cz);
  k.box(P.panel, x1 - x0, 0.62, z1 - z0, cx, Y0, cz, 1.1);
  // vertical precast ribs + slit windows
  for (let i = 0; i <= 10; i++) faceBox(k, P.concrete, 'z', 1, x0 + 0.04 + i * ((x1 - x0 - 0.08) / 10), Y0, z1, 0.03, 0.6, 0.03);
  for (let i = 0; i < 10; i++) k.panel(P.win, 'z', 1, x0 + 0.04 + (i + 0.5) * ((x1 - x0 - 0.08) / 10), Y0 + 0.44, z1 + 0.003, 0.08, 0.06, cell(k));
  for (let i = 0; i < 6; i++) k.panel(P.win, 'x', 1, z0 + 0.1 + (i + 0.5) * ((z1 - z0 - 0.2) / 6), Y0 + 0.44, x1 + 0.003, 0.08, 0.06, cell(k));
  dress(k, x0, x1, z0, z1, Y0, 0.62, { vent: false });
  k.box(P.team, x1 - x0 + 0.01, 0.034, z1 - z0 + 0.01, cx, Y0 + 0.36, cz);
  k.box(P.cyan_l, x1 - x0 + 0.012, 0.008, z1 - z0 + 0.012, cx, Y0 + 0.34, cz);
  flatRoof(k, x0, x1, z0, z1, Y0 + 0.62, 0.035, P.panel);
  roofEmblem(k, x0 + 0.5, x1, z0, z1, Y0 + 0.631);
  satcom(k, 'dish', -1.1, Y0 + 0.63, -1.05, 0.15);
  for (let i = 0; i < 3; i++) antenna(k, -0.78 + i * 0.12, Y0 + 0.63, -1.3, 0.32 + i * 0.08);
  // blast door portal
  k.box(P.panel, 0.42, 0.34, 0.08, -0.55, Y0, z1 + 0.04);
  k.box(P.mats.at(Tile.Plate, 0x7a8078, 2.4), 0.3, 0.26, 0.012, -0.55, Y0, z1 + 0.086);
  k.box(P.hazard, 0.42, 0.03, 0.082, -0.55, Y0 + 0.31, z1 + 0.04);
  k.box(P.amber_l, 0.03, 0.012, 0.012, -0.55, Y0 + 0.29, z1 + 0.095);
  wallSign(k, 'z', 1, -1.08, Y0 + 0.2, z1, 0.34, 'main');
  wallSign(k, 'z', 1, -0.05, Y0 + 0.2, z1, 0.22, 'num', 'R&D');
  // ------------------------------------------------ radome on a drum (back right)
  k.cyl(P.panel, 0.4, 0.22, 0.9, Y0, -0.9, 24);
  k.cyl(P.team, 0.405, 0.03, 0.9, Y0 + 0.16, -0.9, 24);
  k.sph(P.dome, 0.44, 0.9, Y0 + 0.5, -0.9, 28, 18);
  // radome panel seams
  for (let i = 0; i < 6; i++) k.ring(P.mats.col(0xd8d8d2, 0.6, 0.05), 0.44 * Math.cos(0.3 + i * 0.2), 0.003, 0.9, Y0 + 0.5 + 0.44 * Math.sin(0.3 + i * 0.2), -0.9, 28);
  k.blinkLight(0.9, Y0 + 0.96, -0.9, 0.016, 1.5, 0);
  // ------------------------------------------------ server chillers + cryo tanks + test pad
  chillers(k, 0.38, 1.38, -0.2, 3, 'fan', false);
  for (let i = 0; i < 3; i++) silo(k, -1.2 + i * 0.24, -0.1, 0.085, 0.42, P.white, 'dome');
  k.pipe(P.galv, [[-1.2, Y0 + 0.3, -0.19], [-1.2, Y0 + 0.3, -0.38]], 0.014, 6);
  k.pipe(P.rust, [[-0.7, Y0 + 0.2, -0.1], [-0.5, Y0 + 0.2, -0.1], [-0.5, Y0 + 0.2, -0.38]], 0.016, 6);
  prototypeLaser(k, 0.55, 0.65);
  satDish(k, -0.25, Y0, 0.35, 0.16, 0.85, 0.7);
  // antenna farm: lattice mast
  lattice(k, P.galv, -1.05, 0.75, Y0, 1.45, 0.16, 0.05, 8, 0.007);
  k.blinkLight(-1.05, Y0 + 1.48, 0.75, 0.016, 1.5, 0);
  k.box(P.cyan_l, 0.04, 0.04, 0.04, -1.05, Y0 + 0.95, 0.75);
  for (let i = 0; i < 2; i++) satDish(k, -0.55 + i * 0.3, Y0, 1.1, 0.09, 0.9, 0.9);
  // security: fence with razor wire, guard booth, floodlights
  fence(k, [[-1.45, 1.45], [1.45, 1.45], [1.45, 0.1]], 0.16, Y0);
  razor(k, [-1.45, 1.45], [1.45, 1.45], Y0 + 0.16);
  razor(k, [1.45, 1.45], [1.45, 0.1], Y0 + 0.16);
  guardBooth(k, 1.2, 1.2, 0);
  floodMast(k, 1.35, -0.45, 0.6, Math.PI);
  floodMast(k, -1.38, 0.2, 0.55, 0.2);
  jeep(k, 0.0, 1.15, Math.PI, 1);
  k.height = 1.5;
}

// ================================================================ air defence radars (1x1 site corner)

/** Fire-control / surveillance radar for the SAM sites: a panel on a short mast, rotating or slewing per system. */
function samRadar(k: Kit, x: number, z: number, y: number) {
  const P = k.P;
  const f = P.s.faction;
  const hull = P.mats.col(P.s.hull, 0.68, 0.2);
  if (f === 'israel') return; // EL/M-2084 is part of the launcher layout
  if (f === 'usa') {
    // AN/MPQ-65 style: shelter with a fixed, tilted phased array facing the threat axis
    k.at(x, y, z, -Math.PI / 4, () => {
      k.box(P.dark, 0.2, 0.03, 0.14, 0, 0, 0);
      k.rbox(hull, 0.18, 0.1, 0.13, 0, 0.03, 0, 0.01);
      k.at(0.1, 0.07, 0, 0, () => aesaFace(k, 0.15, 0.16, 0, -0.04, 0), 0, -0.35);
      k.box(P.team, 0.182, 0.014, 0.132, 0, 0.12, 0);
    });
    return;
  }
  // mast mounted panel: S-400 / HQ-9 / Bavar slew, TRML-4D / KM-SAM / Hisar rotate
  const spin = f === 'germany' || f === 'ukraine' || f === 'korea' || f === 'turkey';
  const tall = f === 'russia' || f === 'china' || f === 'iran';
  const h = tall ? 0.36 : 0.22;
  k.box(hull, 0.12, 0.06, 0.12, x, y, z);
  lattice(k, P.drab, x, z, y + 0.06, h, 0.08, 0.05, 3, 0.006);
  const n = 'srad';
  const o = k.node(n, x, y + 0.06 + h, z, -Math.PI / 4);
  k.on(o, () => {
    k.cyl(P.dark, 0.03, 0.025, 0, 0, 0, 10);
    k.at(0.0, 0.025, 0, 0, () => {
      if (tall) aesaFace(k, 0.22, 0.2, 0.03, 0, 0);
      else aesaFace(k, 0.18, 0.1, 0.03, 0, 0);
    }, 0, tall ? -0.25 : -0.15);
  });
  if (spin) k.spin(n, 'y', 1.6);
  else k.osc(n, 'y', 0.6, 0.25, x * 5, 0);
  k.blinkLight(x, y + 0.08 + h + (tall ? 0.25 : 0.14), z, 0.01, 1.4, 0.2);
}

// ================================================================ SUPERWEAPON COMPLEXES (3x3)

/** Shared walled compound: hardstand, T-wall blast walls, berm command bunker, floodlights, razor wire, power. */
function swCompound(k: Kit) {
  slab(k, 3, 3);
  tWall(k, [-1.44, -1.44], [1.44, -1.44], 0.26, Y0);
  tWall(k, [-1.44, -1.32], [-1.44, 0.9], 0.26, Y0);
  bermBunker(k, -0.95, -0.98, 0.5, 0.5, 0.2, 0);
  wallSign(k, 'z', 1, -0.95, Y0 + 0.24, -0.66, 0.34, 'main');
  for (let i = 0; i < 3; i++) antenna(k, -1.2 + i * 0.1, Y0 + 0.2, -1.15, 0.3 + i * 0.07);
  fence(k, [[1.46, -1.3], [1.46, 1.46], [-0.4, 1.46]], 0.16, Y0);
  razor(k, [1.46, -1.3], [1.46, 1.46], Y0 + 0.16);
  razor(k, [1.46, 1.46], [-0.4, 1.46], Y0 + 0.16);
  floodMast(k, 1.36, -1.32, 0.66, Math.PI * 0.75);
  floodMast(k, -1.34, 1.36, 0.6, -Math.PI * 0.25);
  genset(k, -1.12, -0.42, Math.PI / 2, 0.9, Y0, true);
  cableRun(k, [[-1.12, -0.25], [-1.12, 0.1], [-0.6, 0.1]], 0.05);
  postSign(k, 0.9, 1.38, 0, 0.3, 'num', 'SW');
  // warning lights on the wall corners
  k.blinkLight(-1.44, Y0 + 0.31, -1.44, 0.016, 1.2, 0);
  k.blinkLight(1.4, Y0 + 0.31, -1.44, 0.016, 1.2, 0.6);
}

function swSilo(k: Kit) {
  const P = k.P;
  swCompound(k);
  // twin launch silos: concrete collars, sliding hatch (one open), missile standing in the open silo
  for (const [x, z, open] of [
    [0.05, 0.15, true],
    [0.05, 0.95, false],
  ] as [number, number, boolean][]) {
    k.cyl(P.panel, 0.34, 0.06, x, Y0, z, 24);
    k.cyl(P.team, 0.345, 0.012, x, Y0 + 0.045, z, 24);
    k.cyl(P.black, 0.25, 0.004, x, Y0 + 0.06, z, 20);
    // hatch rails + hatch
    for (const sz of [-1, 1]) k.box(P.steel, 0.9, 0.02, 0.03, x + 0.3, Y0 + 0.06, z + sz * 0.22);
    const hx = open ? x + 0.6 : x;
    k.box(P.mats.at(Tile.Plate, 0x8a8e86, 2.2), 0.5, 0.05, 0.5, hx, Y0 + 0.07, z);
    k.box(P.hazard, 0.5, 0.012, 0.04, hx, Y0 + 0.12, z - 0.23);
    k.box(P.team, 0.12, 0.012, 0.5, hx, Y0 + 0.12, z);
    if (open) {
      // missile (raised) + umbilical arm
      const my = Y0 + 0.06;
      k.cyl(P.white, 0.09, 0.95, x, my, z, 16);
      k.cyl(P.team, 0.092, 0.05, x, my + 0.55, z, 16);
      k.cyl(P.dark, 0.092, 0.02, x, my + 0.3, z, 16);
      k.lathe(P.white, [[0.09, 0], [0.085, 0.12], [0.06, 0.26], [0.025, 0.36], [0.001, 0.4]], x, my + 0.95, z, 16);
      for (let i = 0; i < 4; i++) k.at(x, my + 0.05, z, (i / 4) * TAU + Math.PI / 4, () => k.box(P.dark, 0.1, 0.12, 0.008, 0.11, 0, 0));
      k.blinkLight(x, my + 1.38, z, 0.012, 0.9, 0);
    }
  }
  // service tower beside the open silo
  const gx = -0.42;
  const gz = 0.15;
  k.box(P.concrete, 0.24, 0.04, 0.24, gx, Y0, gz);
  lattice(k, P.crane, gx, gz, Y0 + 0.04, 1.2, 0.2, 0.16, 8, 0.01);
  for (const y of [0.45, 0.85, 1.2]) {
    k.box(P.grating, 0.3, 0.01, 0.24, gx + 0.06, Y0 + y, gz);
    k.bar(P.steel, [gx + 0.1, Y0 + y - 0.02, gz], [0.05 - 0.09, Y0 + y - 0.02, gz], 0.02);
  }
  k.blinkLight(gx, Y0 + 1.28, gz, 0.016, 1.5, 0.3);
  // propellant / service trucks
  truck(k, 0.95, -0.55, Math.PI, 'fuel', 1.1);
  truck(k, -0.55, 1.1, 0, 'cargo', 1.05);
  ammoBoxes(k, 0.95, 0.5, 5, Math.PI / 2);
  k.height = 1.55;
}

function swLaser(k: Kit) {
  const P = k.P;
  const N = P.N;
  swCompound(k);
  // power + thermal management containers with spinning fans
  for (let i = 0; i < 3; i++) cabin(k, 1.05, Y0, -1.0 + i * 0.26, Math.PI / 2, i === 1 ? N.boxes[1] : N.wall, 0.42, false);
  chillers(k, 0.6, 1.36, -0.3, 2, 'lfan');
  // laser weapon: armoured base + slewing beam director (yaw + slow nod)
  const lx = 0.0;
  const lz = 0.35;
  k.cyl(P.panel, 0.42, 0.08, lx, Y0, lz, 24);
  k.cyl(P.team, 0.425, 0.014, lx, Y0 + 0.07, lz, 24);
  k.cyl(P.drab, 0.3, 0.2, lx, Y0 + 0.08, lz, 18, 0.26);
  const tur = k.node('lturret', lx, Y0 + 0.28, lz);
  k.on(tur, () => {
    k.cyl(P.dark, 0.24, 0.03, 0, 0, 0, 18);
    for (const sz of [-1, 1]) k.rbox(P.white, 0.26, 0.26, 0.06, 0, 0.03, sz * 0.18, 0.02);
    const el = k.node('lelev', 0, 0.2, 0);
    k.on(el, () => {
      k.rbox(P.white, 0.34, 0.2, 0.26, 0.02, -0.1, 0, 0.03);
      k.box(P.team, 0.342, 0.03, 0.262, 0.02, 0.06, 0);
      k.tube(P.dark, [0.19, 0, 0], [0.24, 0, 0], 0.1, 20);
      k.tube(P.cyan_l, [0.238, 0, 0], [0.246, 0, 0], 0.075, 20);
      k.tube(P.dark, [-0.1, 0.12, 0.08], [0.12, 0.12, 0.08], 0.025, 10);
      k.box(P.glass, 0.004, 0.03, 0.03, 0.12, 0.12, 0.08);
    });
  });
  k.osc('lturret', 'y', 1.4, 0.18, 0, 0);
  k.osc('lelev', 'z', 0.18, 0.31, 1.0, 0.25);
  // EL/M-2084 style radar on its trailer + mast (slewing)
  k.box(P.dark, 0.36, 0.04, 0.2, -0.6, Y0 + 0.02, 0.85);
  for (const sx of [-1, 1]) k.tube(P.rubber, [-0.6 + sx * 0.1, Y0 + 0.04, 0.95], [-0.6 + sx * 0.1, Y0 + 0.04, 0.98], 0.04, 10);
  k.rbox(P.drab, 0.3, 0.1, 0.18, -0.6, Y0 + 0.05, 0.85, 0.01);
  const rd = k.node('lradar', -0.6, Y0 + 0.17, 0.85, 0.6);
  k.on(rd, () => {
    k.cyl(P.dark, 0.04, 0.05, 0, 0, 0, 10);
    k.at(0, 0.05, 0, 0, () => aesaFace(k, 0.34, 0.26, 0.04, 0, 0), 0, -0.3);
  });
  k.spin('lradar', 'y', 1.2);
  k.height = 1.0;
}

function swDrone(k: Kit) {
  const P = k.P;
  const N = P.N;
  swCompound(k);
  // fabric hangar (back right)
  const hx = 0.62;
  const hz = -0.9;
  vault(k, P.camo, null, hx, Y0, hz, 1.2, 0.95, 0.46, false, 2);
  k.box(P.dark, 0.9, 0.02, 0.85, hx, Y0, hz);
  parkedDrone(k, hx, Y0, hz + 0.2, Math.PI / 2, 1.1);
  k.box(P.team, 0.9, 0.03, 0.02, hx, Y0 + 0.38, hz + 0.47);
  // launch rails (angled) with loitering munitions ready
  for (let i = 0; i < 4; i++) {
    const x = -0.75 + i * 0.4;
    const z = 0.55;
    k.at(x, Y0, z, -Math.PI / 2, () => {
      k.box(P.dark, 0.14, 0.04, 0.12, 0.0, 0, 0);
      k.boxR(P.drab, 0.62, 0.03, 0.06, 0.25, 0.14, 0, 0, 0, 0.32);
      for (const t of [0.1, 0.4]) k.box(P.steel, 0.02, 0.07 + t * 0.4, 0.02, t, 0.0, 0);
      k.at(0.3, 0.183, 0, 0, () => {
        k.tube(P.mats.col(0xa8aca4, 0.5, 0.3), [-0.1, 0, 0], [0.1, 0, 0], 0.018, 8);
        k.box(P.mats.col(0xa8aca4, 0.5, 0.3), 0.07, 0.005, 0.24, -0.04, 0.0, 0);
        k.box(P.team, 0.02, 0.006, 0.24, -0.04, 0.003, 0);
      }, 0, 0.32);
    });
  }
  // ground control containers + satcom under a camo net
  cabin(k, 0.95, Y0, 0.2, Math.PI / 2, N.wall, 0.5);
  cabin(k, 1.2, Y0, 0.2, Math.PI / 2, N.boxes[0], 0.5);
  camoNet(k, 0.78, 1.4, -0.12, 0.55, 0.28, 0.04);
  satcom(k, 'gcs', 0.4, Y0, 0.05, 0.14);
  ammoBoxes(k, -0.4, 1.15, 6, 0);
  truck(k, -0.25, -0.3, 0, 'cargo', 1.05);
  k.height = 1.0;
}

function swRocket(k: Kit) {
  const P = k.P;
  swCompound(k);
  const hull = P.mats.col(P.s.hull, 0.68, 0.2);
  // two heavy launchers (TOS style) on hardstands with raised launch boxes
  for (const z of [-0.25, 0.65]) {
    k.box(P.concrete, 1.5, 0.012, 0.56, 0.2, Y0, z);
    k.at(0.2, Y0, z, 0, () => {
      for (const sz of [-1, 1]) {
        k.rbox(P.rubber, 1.2, 0.09, 0.09, -0.05, 0.0, sz * 0.17, 0.04);
        k.box(P.dark, 1.0, 0.07, 0.092, -0.05, 0.01, sz * 0.17);
      }
      k.rbox(hull, 1.25, 0.12, 0.42, -0.05, 0.07, 0, 0.02);
      k.rbox(hull, 0.34, 0.12, 0.4, 0.42, 0.19, 0, 0.02);
      k.box(P.glass, 0.004, 0.04, 0.3, 0.592, 0.24, 0);
      k.box(P.team, 0.342, 0.016, 0.402, 0.42, 0.31, 0);
      const tilt = 0.55;
      k.at(-0.1, 0.22, 0, 0, () => {
        k.box(P.dark, 0.2, 0.06, 0.3, 0, 0, 0);
        k.at(0.0, 0.06, 0, 0, () => {
          k.box(hull, 0.85, 0.34, 0.38, 0.3, 0, 0);
          for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) k.box(P.black, 0.006, 0.06, 0.07, 0.726, 0.025 + r * 0.08, -0.12 + c * 0.08);
          k.box(P.team, 0.04, 0.344, 0.384, 0.12, 0, 0);
        }, 0, tilt);
      });
    });
  }
  truck(k, -0.65, 1.15, 0, 'crane', 1.05);
  ammoBoxes(k, -0.95, 0.75, 6, Math.PI / 2);
  ammoBoxes(k, -0.95, 0.2, 6, Math.PI / 2);
  k.height = 1.05;
}

function swCruise(k: Kit) {
  const P = k.P;
  const N = P.N;
  swCompound(k);
  const hull = P.mats.col(P.s.hull, 0.68, 0.2);
  const can = P.mats.col(mix(P.s.hull, 0xd8d8cc, 0.25), 0.6, 0.2);
  // four canister launchers on trailer chassis, raised
  for (let i = 0; i < 4; i++) {
    const z = -0.45 + i * 0.42;
    k.at(0.2, Y0, z, 0, () => {
      k.box(P.dark, 0.9, 0.05, 0.16, 0, 0.06, 0);
      for (const x of [-0.3, -0.18]) for (const sz of [-1, 1]) k.tube(P.rubber, [x, 0.045, sz * 0.1], [x, 0.045, sz * 0.13], 0.045, 10);
      k.box(hull, 0.86, 0.03, 0.26, 0, 0.1, 0);
      for (const sx of [-1, 1]) k.box(P.steel, 0.012, 0.08, 0.012, 0.36, 0.0, sx * 0.14);
      k.at(-0.25, 0.14, 0, 0, () => {
        for (let c = 0; c < 2; c++) {
          k.box(can, 0.95, 0.1, 0.1, 0.47, 0.0, -0.055 + c * 0.11);
          k.box(P.black, 0.006, 0.08, 0.08, 0.948, 0.01, -0.055 + c * 0.11);
        }
        k.box(P.team, 0.03, 0.105, 0.225, 0.3, 0.0, 0);
        for (let c = 0; c < 2; c++) k.muzzle(0.96, 0.05, -0.055 + c * 0.11);
      }, 0, 0.62);
    });
  }
  // fire control: container with a rotating panel radar
  cabin(k, -0.75, Y0, 0.95, 0, N.wall, 0.5);
  k.box(P.steel, 0.12, 0.08, 0.12, -0.6, Y0 + 0.17, 0.95);
  const rd = k.node('crad', -0.6, Y0 + 0.25, 0.95);
  k.on(rd, () => {
    k.cyl(P.dark, 0.03, 0.03, 0, 0, 0, 10);
    k.at(0, 0.03, 0, 0, () => aesaFace(k, 0.3, 0.14, 0.03, 0, 0), 0, -0.2);
  });
  k.spin('crad', 'y', 1.4);
  truck(k, -0.6, 1.25, 0, 'cargo', 1.0);
  k.height = 1.0;
}

// ================================================================ CAPTURABLE TECH STRUCTURES (neutral until captured)

/** Red cross marking: flat on a roof, or upright on a +Z facing wall. */
function redCross(k: Kit, x: number, y: number, z: number, s: number, wall = false) {
  const P = k.P;
  if (!wall) {
    k.box(P.white, s * 1.15, 0.004, s * 1.15, x, y, z);
    k.box(P.red, s, 0.006, s * 0.3, x, y + 0.002, z);
    k.box(P.red, s * 0.3, 0.006, s, x, y + 0.002, z);
    return;
  }
  k.box(P.white, s * 1.15, s * 1.15, 0.006, x, y - s * 0.575, z + 0.003);
  k.box(P.red, s, s * 0.3, 0.008, x, y - s * 0.15, z + 0.004);
  k.box(P.red, s * 0.3, s, 0.008, x, y - s * 0.5, z + 0.004);
}

function techHospital(k: Kit) {
  const P = k.P;
  slab(k, 2, 2);
  // prefab ward block (two modules) with a covered entrance
  const x0 = -0.95;
  const x1 = 0.35;
  const z0 = -0.95;
  const z1 = -0.35;
  block(k, { x0, x1, z0, z1, h: 0.36, floors: 2, wall: P.mats.at(Tile.Clad, 0xe8e8e2), door: -0.3, equip: 2, sign: false, roof: 'flat' });
  redCross(k, -0.62, Y0 + 0.385, -0.65, 0.26);
  redCross(k, 0.1, Y0 + 0.3, z1, 0.1, true);
  k.box(P.white, 0.34, 0.012, 0.16, -0.3, Y0 + 0.2, z1 + 0.08);
  for (const sx of [-1, 1]) k.cyl(P.galv, 0.006, 0.2, -0.3 + sx * 0.15, Y0, z1 + 0.15, 6);
  // field tents (canvas, gable) on the right
  for (let i = 0; i < 2; i++) {
    const tz = -0.75 + i * 0.42;
    k.box(P.mats.at(Tile.Canvas, 0xa8a488), 0.5, 0.14, 0.34, 0.68, Y0, tz);
    gable(k, P.mats.at(Tile.Canvas, 0x9a9878), P.mats.at(Tile.Canvas, 0xa8a488), 0.68, Y0 + 0.14, tz, 0.5, 0.34, 0.12, 0.02, true);
    redCross(k, 0.68, Y0 + 0.24, tz + 0.085, 0.07);
  }
  // helipad (front left) + ambulances
  k.cyl(P.concrete, 0.4, 0.008, -0.45, Y0, 0.5, 28);
  k.decal(P.mats.canvas('helipad-h', texHelipad('#f2f2ea'), { alphaTest: 0.5 }), -0.45, Y0 + 0.009, 0.5, 0.7, 0.7);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    k.box(P.green_l, 0.016, 0.01, 0.016, -0.45 + Math.cos(a) * 0.41, Y0, 0.5 + Math.sin(a) * 0.41);
  }
  for (const [ax, az] of [
    [0.55, 0.2],
    [0.55, 0.52],
  ] as P2[]) {
    k.at(ax, Y0, az, 0, () => {
      for (const wx of [0.1, -0.1]) for (const sz of [-1, 1]) k.tube(P.rubber, [wx, 0.03, sz * 0.06], [wx, 0.03, sz * 0.08], 0.03, 10);
      k.rbox(P.white, 0.34, 0.16, 0.15, 0, 0.03, 0, 0.015);
      k.box(P.red, 0.345, 0.025, 0.152, 0, 0.09, 0);
      k.box(P.glass, 0.004, 0.05, 0.12, 0.171, 0.12, 0);
      k.box(P.mats.light(0x3a7aff, 3), 0.03, 0.015, 0.1, 0.12, 0.19, 0);
    });
  }
  genset(k, 0.0, 0.0, 0, 0.8);
  flagPole(k, 0.9, 0.9, 0.7, Y0);
  floodMast(k, -0.95, 0.0, 0.5, 0);
  k.height = 0.85;
}

function techAirport(k: Kit) {
  const P = k.P;
  slab(k, 3, 3);
  // runway strip with edge lights
  const rz = 0.95;
  k.box(P.asphalt, 2.96, 0.004, 0.7, 0, Y0, rz);
  for (const sz of [-1, 1]) k.box(P.white, 2.9, 0.002, 0.014, 0, Y0 + 0.004, rz + sz * 0.31);
  dashes(k, P.white, -1.2, rz, 1.2, rz, 0.16, 0.1, 0.02, Y0 + 0.004);
  for (let i = 0; i <= 7; i++) for (const sz of [-1, 1]) k.box(i === 0 || i === 7 ? P.green_l : P.lamp, 0.016, 0.012, 0.016, -1.4 + i * 0.4, Y0 + 0.004, rz + sz * 0.34);
  // terminal: glass front, flat roof
  const tx0 = -1.42;
  const tx1 = 0.05;
  const tz0 = -1.42;
  const tz1 = -0.6;
  block(k, { x0: tx0, x1: tx1, z0: tz0, z1: tz1, h: 0.4, floors: 2, wall: P.mats.at(Tile.Clad, 0xd8dade), win: 'ribbon', door: -0.7, equip: 3, sign: false, roof: 'flat' });
  k.panel(P.winC, 'z', 1, -0.7, Y0 + 0.03, tz1 + 0.006, 1.2, 0.18, cell(k, 8, 1));
  k.box(P.mats.col(0x2a6ac0, 0.5, 0.2), 1.3, 0.05, 0.02, -0.68, Y0 + 0.33, tz1 + 0.01);
  // control tower
  const cx = 0.45;
  const cz = -1.05;
  k.cyl(P.mats.at(Tile.Panel, 0xd8d6d0), 0.1, 0.95, cx, Y0, cz, 12, 0.08);
  k.cyl(P.mats.col(0x2a4258, 0.15, 0.8), 0.17, 0.12, cx, Y0 + 0.95, cz, 8, 0.2);
  k.cyl(P.lamp, 0.165, 0.004, cx, Y0 + 1.01, cz, 8);
  k.cyl(P.dark, 0.22, 0.035, cx, Y0 + 1.07, cz, 8);
  antenna(k, cx - 0.05, Y0 + 1.1, cz, 0.22);
  k.blinkLight(cx, Y0 + 1.34, cz, 0.016, 1.3, 0);
  const rd = k.node('trad', cx + 0.08, Y0 + 1.11, cz + 0.02);
  k.on(rd, () => {
    k.box(P.dark, 0.02, 0.03, 0.02, 0, 0, 0);
    k.box(P.white, 0.02, 0.04, 0.16, 0.01, 0.03, 0);
  });
  k.spin('trad', 'y', 2);
  // hangar (back right, vault)
  vault(k, P.mats.at(Tile.Corr, 0xb8bcc0, 1.6), P.mats.at(Tile.Clad, 0xd0d2d4), 1.05, Y0, -0.95, 0.75, 0.9, 0.42, false, 2);
  k.box(P.dark, 0.5, 0.3, 0.01, 1.05, Y0, -0.49);
  // parked airliner on the apron
  const ax = -0.45;
  const az = 0.1;
  const body = P.mats.col(0xeef0f2, 0.45, 0.2);
  k.at(ax, Y0, az, 0, () => {
    k.tube(body, [-0.5, 0.14, 0], [0.42, 0.14, 0], 0.07, 14);
    k.sph(body, 0.07, 0.42, 0.14, 0, 12, 8);
    k.tube(body, [-0.5, 0.14, 0], [-0.62, 0.17, 0], 0.07, 12, 0.035);
    k.box(body, 0.22, 0.012, 1.0, -0.05, 0.11, 0);
    for (const sz of [-1, 1]) k.tube(P.mats.col(0xc8ccd0, 0.4, 0.5), [0.0, 0.08, sz * 0.24], [0.12, 0.08, sz * 0.24], 0.035, 10);
    k.box(body, 0.12, 0.012, 0.34, -0.55, 0.17, 0);
    k.box(P.mats.col(0x2a6ac0, 0.5, 0.2), 0.14, 0.17, 0.012, -0.56, 0.18, 0);
    k.box(P.mats.col(0x2a6ac0, 0.5, 0.2), 0.9, 0.018, 0.142, -0.05, 0.14, 0);
    for (let i = 0; i < 8; i++) k.box(P.dark, 0.016, 0.012, 0.142, -0.35 + i * 0.09, 0.17, 0);
    for (const gx of [0.3, -0.05]) k.box(P.dark, 0.012, 0.07, 0.012, gx, 0, 0);
  });
  truck(k, 0.35, 0.35, Math.PI / 2, 'fuel', 0.9);
  jeep(k, 0.7, -0.25, 0.4, 0.9);
  flagPole(k, -1.3, -0.4, 0.8, Y0);
  floodMast(k, 1.35, 0.45, 0.55, Math.PI);
  k.height = 1.35;
}

function techComms(k: Kit) {
  const P = k.P;
  slab(k, 2, 2);
  // tall lattice telecom mast with aviation bands, dishes and panel antennas
  const H = 2.2;
  const cx = 0.2;
  const cz = -0.2;
  k.box(P.concrete, 0.66, 0.05, 0.66, cx, Y0, cz);
  const red = P.mats.col(0xc03020, 0.6, 0.3);
  for (let i = 0; i < 6; i++) lattice(k, i % 2 ? red : P.white, cx, cz, Y0 + 0.05 + (i * H) / 6, H / 6, 0.6 - i * 0.09, 0.6 - (i + 1) * 0.09, 2, 0.012);
  for (const [y, a] of [
    [1.4, 0.6],
    [1.7, 2.4],
    [1.15, 4.1],
  ] as P2[])
    k.at(cx + Math.cos(a) * 0.12, Y0 + y, cz + Math.sin(a) * 0.12, -a, () => {
      const pts: P2[] = [];
      for (let i = 0; i <= 5; i++) pts.push([0.13 * (i / 5) + 0.001, 0.05 * (i / 5) ** 2]);
      k.at(0, 0, 0, 0, () => k.lathe(P.mats.col(0xdcdcd4, 0.5, 0.1, true), pts, 0, 0, 0, 16, 0), 0, Math.PI / 2);
      k.box(P.dark, 0.04, 0.03, 0.03, -0.02, -0.015, 0);
    });
  for (let i = 0; i < 3; i++) k.at(cx, Y0 + H - 0.05, cz, i * 2.1, () => k.box(P.white, 0.03, 0.24, 0.07, 0.07, 0, 0));
  k.blinkLight(cx, Y0 + H + 0.25, cz, 0.02, 1.5, 0);
  k.blinkLight(cx + 0.15, Y0 + H * 0.5, cz + 0.15, 0.016, 1.5, 0.7);
  k.cyl(P.dark, 0.006, 0.22, cx, Y0 + H, cz, 4);
  // equipment shelter + generator + cable bridge
  block(k, { x0: -0.95, x1: -0.3, z0: 0.25, z1: 0.75, h: 0.24, floors: 1, wall: P.mats.at(Tile.Panel, 0xd0cec6), doorX: 0.5, equip: 1, sign: false, roof: 'flat' });
  genset(k, 0.55, 0.62, 0, 0.85);
  cableRun(k, [[-0.3, 0.35], [cx - 0.2, 0.35], [cx - 0.2, cz + 0.2]], 0.12);
  fence(k, [[-0.95, -0.95], [0.95, -0.95], [0.95, 0.95], [-0.2, 0.95]], 0.16, Y0);
  razor(k, [0.95, -0.95], [0.95, 0.95], Y0 + 0.16);
  flagPole(k, -0.85, -0.85, 0.7, Y0);
  k.height = H;
}

// ================================================================ DEFENCES (1x1)

/** Regional emplacement for 1x1 defences. Returns the ground top height. */
function emplacement(k: Kit, kind: 'pad' | 'low') {
  const P = k.P;
  const R = P.R;
  if (R === 'west') {
    k.plan(P.concrete, rect(0.94, 0.94), 0.035, 0, 0, 0, 0.008);
    if (kind === 'pad') {
      hesco(k, [-0.44, -0.44], [-0.44, 0.3], 0.11);
      hesco(k, [-0.34, -0.44], [0.3, -0.44], 0.11);
    }
  } else if (R === 'east') {
    k.plan(P.T.concreteDark(0xd8d4cc, 1.5), rect(0.94, 0.94), 0.035, 0, 0, 0, 0.008);
    // earth revetment on the back sides
    const soil = P.mats.tex('soil', { color: 0x6a6a44, seed: 30, size: 256 }, 0xffffff, 3);
    k.at(-0.4, 0, 0, 0, () => k.prism(soil, [[-0.07, 0], [0.07, 0], [0.03, 0.12], [-0.03, 0.12]], 0.9));
    k.at(0.05, 0, -0.4, Math.PI / 2, () => k.prism(soil, [[-0.07, 0], [0.07, 0], [0.03, 0.12], [-0.03, 0.12]], 0.8));
  } else if (R === 'asia') {
    k.plan(P.concrete, regular(8, 0.47, Math.PI / 8), 0.035, 0, 0, 0, 0.008);
    k.plan(P.accent, regular(8, 0.475, Math.PI / 8), 0.012, 0, 0.02, 0, 0);
  } else {
    k.plan(P.slab, rect(0.94, 0.94), 0.03, 0, 0, 0, 0.008);
    const soil = P.mats.tex('soil', { color: 0xb09a70, seed: 31, size: 256 }, 0xffffff, 3);
    const ring: P2[] = [];
    for (let i = 0; i <= 12; i++) {
      const a = Math.PI * 0.6 + (i / 12) * Math.PI * 1.3;
      ring.push([Math.cos(a) * 0.4, Math.sin(a) * 0.4]);
    }
    for (let i = 0; i + 1 < ring.length; i++) {
      const [ax, az] = ring[i];
      const [bx, bz] = ring[i + 1];
      const ry = -Math.atan2(bz - az, bx - ax);
      k.at((ax + bx) / 2, 0, (az + bz) / 2, ry, () => k.local(() => k.prism(soil, [[-0.06, 0], [0.06, 0], [0.025, 0.1], [-0.025, 0.1]], Math.hypot(bx - ax, bz - az) + 0.02)), 0, 0);
    }
  }
  return 0.035;
}

/** Pintle machine gun turret (gun along +X). */
function mgTurret(k: Kit, y: number, shield = true, scale = 1) {
  const P = k.P;
  const hull = P.mats.col(P.s.hull, 0.7, 0.2);
  const t = k.node('turret', 0, y, 0);
  k.turret = true;
  k.on(t, () => {
    const s = scale;
    k.cyl(P.dark, 0.1 * s, 0.03 * s, 0, 0, 0, 14);
    k.cyl(P.steel, 0.018 * s, 0.09 * s, 0, 0.03 * s, 0, 8);
    k.box(P.dark, 0.17 * s, 0.045 * s, 0.045 * s, 0.0, 0.11 * s, 0);
    k.box(P.dark, 0.05 * s, 0.03 * s, 0.03 * s, -0.11 * s, 0.11 * s, 0);
    k.box(P.mats.col(0x4a5a34, 0.8, 0.1), 0.06 * s, 0.05 * s, 0.04 * s, -0.01 * s, 0.1 * s, 0.05 * s);
    k.tube(P.dark, [-0.12 * s, 0.12 * s, -0.025 * s], [-0.16 * s, 0.13 * s, -0.025 * s], 0.006 * s, 4);
    if (shield) {
      k.box(hull, 0.014 * s, 0.11 * s, 0.17 * s, 0.07 * s, 0.07 * s, 0);
      for (const sz of [-1, 1]) k.boxR(hull, 0.014 * s, 0.11 * s, 0.06 * s, 0.05 * s, 0.07 * s, sz * 0.105 * s, sz * 0.6);
      k.box(P.team, 0.016 * s, 0.02 * s, 0.172 * s, 0.071 * s, 0.16 * s, 0);
    }
    const b = k.node('recoil0', 0.09 * s, 0.115 * s, 0);
    k.recoil = 1;
    k.on(b, () => {
      k.tube(P.dark, [0, 0, 0], [0.2 * s, 0, 0], 0.009 * s, 8);
      k.tube(P.dark, [0.04 * s, 0, 0], [0.12 * s, 0, 0], 0.014 * s, 8);
      k.tube(P.black, [0.19 * s, 0, 0], [0.22 * s, 0, 0], 0.012 * s, 8);
      k.muzzle(0.23 * s, 0, 0);
    });
  });
}

function bunker(k: Kit) {
  const P = k.P;
  const R = P.R;
  const g = emplacement(k, 'pad');
  let top: number;
  if (R === 'west') {
    k.rbox(P.concrete, 0.56, 0.22, 0.5, 0.05, g, 0.05, 0.03);
    k.box(P.black, 0.2, 0.035, 0.01, 0.12, g + 0.12, 0.3);
    k.box(P.black, 0.01, 0.035, 0.2, 0.33, g + 0.12, 0.05);
    k.box(P.team, 0.562, 0.025, 0.502, 0.05, g + 0.17, 0.05);
    k.box(P.dark, 0.1, 0.16, 0.012, -0.12, g, 0.302);
    hesco(k, [0.42, -0.2], [0.42, 0.44], 0.1);
    hesco(k, [-0.3, 0.44], [0.32, 0.44], 0.1);
    top = g + 0.22;
    k.cyl(P.concrete, 0.13, 0.03, 0.05, top, 0.05, 16);
    top += 0.03;
    k.at(0.05, 0, 0.05, 0, () => mgTurret(k, top));
  } else if (R === 'east') {
    k.cyl(P.wall, 0.3, 0.17, 0, g, 0, 20);
    k.dome(P.wall, 0.3, 0, g + 0.17, 0, 20, 6, 0.3);
    for (const a of [0, 0.8, -0.8]) k.at(Math.cos(a) * 0.29, g + 0.08, -Math.sin(a) * 0.29, a, () => k.box(P.black, 0.02, 0.035, 0.12, 0, 0, 0));
    k.cyl(P.team, 0.303, 0.025, 0, g + 0.12, 0, 20);
    stencil(k, '21', 'z', 1, -0.12, g + 0.03, 0.27, 0.12);
    sandbags(k, [0.38, -0.3], [0.38, 0.3], 2, g);
    sandbags(k, [-0.3, 0.38], [0.3, 0.38], 2, g);
    // camouflage netting over the back
    k.at(-0.15, g + 0.2, -0.15, 0.4, () => k.boxR(P.mats.tex('camo', { pattern: 'woodland', color: 0x56663e, color2: 0x3e4a2c, color3: 0x26261c, color4: 0x8a8060, size: 256, seed: 40 }, 0xffffff, 4), 0.42, 0.01, 0.3, 0, 0, 0, 0, 0.25));
    top = g + 0.26;
    mgTurret(k, top, true);
  } else if (R === 'asia') {
    const hex = regular(6, 0.34, Math.PI / 6);
    k.plan(P.mats.tex('concrete', { color: 0xe4e2dc, divisions: 2, grime: 0.35, seed: 11 }, 0x9aa68a, 2.2), hex, 0.2, 0, g, 0, 0.02);
    k.plan(P.black, regular(6, 0.32, Math.PI / 6), 0.04, 0, g + 0.2, 0);
    k.plan(P.concrete, regular(6, 0.36, Math.PI / 6), 0.05, 0, g + 0.24, 0, 0.015);
    k.plan(P.team, regular(6, 0.362, Math.PI / 6), 0.015, 0, g + 0.15, 0);
    sandbags(k, [0.42, -0.28], [0.42, 0.28], 2, g);
    sandbags(k, [-0.28, 0.42], [0.28, 0.42], 2, g);
    top = g + 0.29;
    mgTurret(k, top);
  } else {
    k.rbox(P.wall2, 0.5, 0.2, 0.46, 0, g, 0, 0.02);
    k.box(P.black, 0.18, 0.04, 0.01, 0.05, g + 0.11, 0.232);
    k.box(P.black, 0.01, 0.04, 0.18, 0.252, g + 0.11, 0.0);
    k.box(P.team, 0.502, 0.022, 0.462, 0, g + 0.16, 0);
    sandbags(k, [-0.22, 0.0], [0.22, 0.0], 2, g + 0.2);
    sandbags(k, [0.36, -0.36], [0.36, 0.36], 3, g);
    sandbags(k, [-0.3, 0.38], [0.3, 0.38], 2, g);
    top = g + 0.2;
    mgTurret(k, top + 0.01);
  }
  // camo net over the ammunition corner behind the nest
  camoNet(k, -0.47, -0.12, -0.47, -0.12, 0.2, 0.03, g);
  ammoBoxes(k, -0.3, -0.3, 3, 0.4, g);
  k.height = 0.55;
}

function sentry(k: Kit) {
  const P = k.P;
  const R = P.R;
  const g = emplacement(k, 'low');
  if (R === 'west') hesco(k, [0.42, -0.35], [0.42, 0.35], 0.1);
  if (R === 'east') {
    sandbags(k, [0.38, -0.3], [0.38, 0.3], 2, g);
    for (let i = 0; i < 12; i++) k.at(0.43, g + 0.045, -0.3 + i * 0.055, 0, () => k.ring(P.galv, 0.04, 0.0025, 0, 0, 0, 10), Math.PI / 2 + (i % 2 ? 0.25 : -0.25));
  }
  if (R === 'asia') fence(k, [[-0.44, 0.44], [0.44, 0.44], [0.44, -0.44]], 0.14, g);
  if (R === 'mideast') sandbags(k, [0.36, -0.35], [0.36, 0.35], 3, g);
  // pedestal + control box
  k.plan(P.concrete, regular(8, 0.2, Math.PI / 8), 0.06, 0, g, 0, 0.012);
  k.cyl(P.steel, 0.05, 0.28, 0, g + 0.06, 0, 12, 0.04);
  k.rbox(P.dark, 0.1, 0.14, 0.08, -0.2, g, 0.18, 0.01);
  k.box(P.green_l, 0.004, 0.02, 0.03, -0.148, g + 0.1, 0.18);
  k.box(P.team, 0.102, 0.02, 0.082, -0.2, g + 0.1, 0.18);
  k.tube(P.black, [-0.15, g + 0.04, 0.18], [0, g + 0.1, 0.03], 0.006, 4);
  const t = k.node('turret', 0, g + 0.34, 0);
  k.turret = true;
  const housing = P.mats.col(0xb4b9b2, 0.5, 0.3);
  k.on(t, () => {
    k.cyl(P.dark, 0.07, 0.03, 0, 0, 0, 14);
    k.box(P.dark, 0.04, 0.08, 0.2, -0.02, 0.03, 0);
    // sensor housing (SGR-A1 style) with camera windows
    k.rbox(housing, 0.2, 0.12, 0.16, 0.0, 0.1, 0, 0.025);
    k.box(P.team, 0.202, 0.02, 0.162, 0.0, 0.19, 0);
    k.box(P.black, 0.01, 0.07, 0.12, 0.1, 0.125, 0);
    k.tube(P.dark, [0.1, 0.165, 0.035], [0.12, 0.165, 0.035], 0.022, 12);
    k.tube(P.red_l, [0.118, 0.165, 0.035], [0.123, 0.165, 0.035], 0.014, 12);
    k.tube(P.dark, [0.1, 0.165, -0.035], [0.12, 0.165, -0.035], 0.016, 10);
    k.tube(P.cyan_l, [0.118, 0.165, -0.035], [0.123, 0.165, -0.035], 0.01, 10);
    k.box(P.glass, 0.006, 0.03, 0.08, 0.104, 0.125, 0);
    k.box(P.dark, 0.14, 0.04, 0.04, 0.03, 0.06, 0);
    const b = k.node('recoil0', 0.09, 0.07, 0);
    k.recoil = 1;
    k.on(b, () => {
      k.tube(P.dark, [0, 0, 0], [0.16, 0, 0], 0.008, 8);
      k.tube(P.black, [0.15, 0, 0], [0.18, 0, 0], 0.011, 8);
      k.muzzle(0.19, 0, 0);
    });
    k.box(P.mats.col(0x4a5a34, 0.8, 0.1), 0.06, 0.05, 0.04, -0.03, 0.04, -0.09);
  });
  k.height = 0.6;
}

/** Wheeled truck chassis facing +X (cab at the -X end when reversed). */
function truckChassis(k: Kit, L: number, W: number, cabAtMinusX: boolean, y: number) {
  const P = k.P;
  const hull = P.mats.col(P.s.hull, 0.7, 0.2);
  k.box(P.dark, L, 0.05, W * 0.6, 0, y + 0.06, 0);
  const n = 4;
  for (let i = 0; i < n; i++) {
    const x = -L / 2 + 0.08 + ((L - 0.16) * i) / (n - 1);
    for (const sz of [-1, 1]) {
      k.tube(P.rubber, [x, y + 0.045, sz * (W / 2 - 0.03)], [x, y + 0.045, sz * (W / 2 + 0.005)], 0.045, 12);
      k.tube(hull, [x, y + 0.045, sz * (W / 2 + 0.004)], [x, y + 0.045, sz * (W / 2 + 0.008)], 0.025, 8);
    }
  }
  const cx = cabAtMinusX ? -L / 2 + 0.08 : L / 2 - 0.08;
  const fx = cabAtMinusX ? -1 : 1;
  k.rbox(hull, 0.16, 0.14, W, cx, y + 0.09, 0, 0.02);
  k.box(P.glass, 0.006, 0.05, W * 0.8, cx + fx * 0.081, y + 0.17, 0);
  for (const sz of [-1, 1]) k.box(P.glass, 0.06, 0.04, 0.004, cx + fx * 0.03, y + 0.17, sz * (W / 2 + 0.001));
  k.box(P.dark, 0.02, 0.03, W + 0.01, cx + fx * 0.085, y + 0.07, 0);
  for (const sz of [-1, 1]) k.sph(P.lamp, 0.01, cx + fx * 0.09, y + 0.11, sz * (W / 2 - 0.03), 6, 4);
  // fuel tanks + deployed outrigger jacks
  for (const sz of [-1, 1]) k.tube(P.galv, [cx - fx * 0.1, y + 0.08, sz * (W / 2 - 0.01)], [cx - fx * 0.2, y + 0.08, sz * (W / 2 - 0.01)], 0.022, 8);
  for (const ox of [L / 2 - 0.05, -L / 2 + 0.22]) {
    for (const sz of [-1, 1]) {
      k.box(P.dark, 0.025, 0.02, 0.08, ox, y + 0.07, sz * (W / 2 + 0.03));
      k.box(P.steel, 0.012, 0.07, 0.012, ox, y + 0.01, sz * (W / 2 + 0.06));
      k.box(P.dark, 0.04, 0.008, 0.04, ox, y, sz * (W / 2 + 0.06));
    }
  }
  k.box(hull, L - 0.18, 0.03, W, cabAtMinusX ? 0.09 : -0.09, y + 0.11, 0);
  k.box(P.team, 0.162, 0.02, W + 0.002, cx, y + 0.2, 0);
}

function sam(k: Kit) {
  const P = k.P;
  const R = P.R;
  const f = P.s.faction;
  const g = emplacement(k, 'low');
  const hull = P.mats.col(P.s.hull, 0.68, 0.2);
  const hullD = P.mats.col(shade(P.s.hull, 0.72), 0.7, 0.2);
  const can = P.mats.col(mix(P.s.hull, 0xd8d8cc, 0.25), 0.6, 0.2);
  const capM = P.black;
  const trucked = f === 'china' || f === 'russia' || f === 'germany' || f === 'ukraine' || f === 'korea' || f === 'turkey' || f === 'iran';
  let ty = g + 0.08;
  if (trucked) {
    truckChassis(k, 0.84, 0.28, true, g);
    ty = g + 0.14;
  } else if (f === 'usa') {
    // M860 semi-trailer
    k.box(P.dark, 0.78, 0.05, 0.18, 0, g + 0.07, 0);
    for (const x of [-0.25, -0.15]) for (const sz of [-1, 1]) k.tube(P.rubber, [x, g + 0.045, sz * 0.11], [x, g + 0.045, sz * 0.15], 0.045, 12);
    k.box(hull, 0.06, 0.08, 0.04, 0.34, g, 0.12);
    k.box(hull, 0.06, 0.08, 0.04, 0.34, g, -0.12);
    k.box(hull, 0.76, 0.03, 0.28, 0, g + 0.11, 0);
    ty = g + 0.14;
  } else if (f === 'israel') {
    k.box(P.dark, 0.6, 0.05, 0.24, 0, g + 0.02, 0);
    k.box(hull, 0.62, 0.04, 0.3, 0, g + 0.07, 0);
    ty = g + 0.11;
    // EL/M-2084 multi-mission radar on its own mast (rotating)
    k.box(hull, 0.16, 0.1, 0.16, -0.32, g, -0.3);
    k.cyl(P.dark, 0.012, 0.18, -0.32, g + 0.1, -0.3, 6);
    const mmr = k.node('srad', -0.32, g + 0.28, -0.3, Math.PI / 4);
    k.on(mmr, () => k.at(0, 0, 0, 0, () => aesaFace(k, 0.28, 0.2, 0.02, -0.1, 0), 0, -0.3));
    k.spin('srad', 'y', 1.4);
  }
  const t = k.node('turret', 0.06, ty, 0);
  k.turret = true;
  k.on(t, () => {
    k.cyl(P.dark, 0.13, 0.03, 0, 0, 0, 16);
    k.box(hullD, 0.2, 0.05, 0.22, -0.02, 0.03, 0);
    k.box(P.team, 0.202, 0.016, 0.222, -0.02, 0.065, 0);
    // erector arms
    for (const sz of [-1, 1]) k.box(hull, 0.16, 0.05, 0.02, -0.06, 0.06, sz * 0.12);
    type Lay = { elev: number; rows: number; cols: number; len: number; w: number; h: number; round: boolean; gap: number; px: number; py: number };
    const lay: Lay = (() => {
      switch (f) {
        case 'usa':
          return { elev: 0.66, rows: 2, cols: 2, len: 0.62, w: 0.11, h: 0.11, round: false, gap: 0.006, px: -0.12, py: 0.13 };
        case 'israel':
          return { elev: 0.95, rows: 4, cols: 5, len: 0.42, w: 0.05, h: 0.05, round: true, gap: 0.004, px: -0.1, py: 0.12 };
        case 'china':
          return { elev: 1.45, rows: 2, cols: 2, len: 0.62, w: 0.1, h: 0.1, round: true, gap: 0.01, px: -0.18, py: 0.1 };
        case 'russia':
          return { elev: 1.25, rows: 2, cols: 2, len: 0.7, w: 0.09, h: 0.09, round: true, gap: 0.008, px: -0.2, py: 0.1 };
        case 'germany':
        case 'ukraine':
          return { elev: 1.35, rows: 2, cols: 4, len: 0.42, w: 0.065, h: 0.065, round: false, gap: 0.006, px: -0.14, py: 0.1 };
        case 'korea':
          return { elev: 1.45, rows: 2, cols: 4, len: 0.48, w: 0.07, h: 0.07, round: false, gap: 0.006, px: -0.16, py: 0.1 };
        case 'turkey':
          return { elev: 1.4, rows: 2, cols: 3, len: 0.46, w: 0.075, h: 0.075, round: true, gap: 0.008, px: -0.16, py: 0.1 };
        case 'iran':
          return { elev: 1.4, rows: 2, cols: 2, len: 0.6, w: 0.12, h: 0.12, round: false, gap: 0.008, px: -0.18, py: 0.1 };
        default:
          return { elev: 0.7, rows: 2, cols: 2, len: 0.5, w: 0.09, h: 0.09, round: true, gap: 0.01, px: -0.1, py: 0.12 };
      }
    })();
    const pack = k.node('pack', lay.px, lay.py, 0, 0, 0, lay.elev);
    k.on(pack, () => {
      const W = lay.cols * (lay.w + lay.gap);
      const H = lay.rows * (lay.h + lay.gap);
      if (f === 'israel') {
        // Tamir launcher box with 20 tubes on the face
        k.box(hull, lay.len, H + 0.02, W + 0.02, lay.len / 2, -H / 2 - 0.01, 0);
        k.box(P.team, 0.04, H + 0.024, W + 0.024, lay.len * 0.3, -H / 2 - 0.012, 0);
      } else {
        k.box(hullD, 0.03, H + 0.016, W + 0.016, 0.05, -H / 2 - 0.008, 0);
        k.box(hullD, 0.03, H + 0.016, W + 0.016, lay.len - 0.06, -H / 2 - 0.008, 0);
        // erector rail under the pack
        k.box(hull, lay.len * 0.9, 0.025, W * 0.6, lay.len * 0.45, -H - 0.035, 0);
      }
      for (let r = 0; r < lay.rows; r++)
        for (let c = 0; c < lay.cols; c++) {
          const y = (r + 0.5) * (lay.h + lay.gap) - H;
          const z = (c + 0.5) * (lay.w + lay.gap) - W / 2;
          if (f !== 'israel') {
            if (lay.round) {
              k.tube(can, [0, y, z], [lay.len, y, z], lay.w / 2, 12);
              k.tube(capM, [lay.len, y, z], [lay.len + 0.006, y, z], lay.w / 2 - 0.006, 12);
              k.ring(P.dark, lay.w / 2, 0.004, lay.len * 0.5, y, z, 12);
            } else {
              k.box(can, lay.len, lay.h, lay.w, lay.len / 2, y - lay.h / 2, z);
              k.box(capM, 0.006, lay.h - 0.012, lay.w - 0.012, lay.len + 0.003, y - lay.h / 2 + 0.006, z);
            }
          } else {
            k.tube(capM, [lay.len, y, z], [lay.len + 0.004, y, z], lay.w / 2 - 0.006, 10);
          }
          k.muzzle(lay.len + 0.02, y, z);
        }
      if (f !== 'israel') k.box(P.team, 0.03, H + 0.026, W + 0.026, lay.len * 0.45, -H / 2 - 0.013, 0);
    });
  });
  // radar on the front left corner (the raised launcher would hide it at the back)
  samRadar(k, -0.33, 0.33, g);
  sandbags(k, [0.44, -0.36], [0.44, 0.36], 2, g);
  sandbags(k, [-0.12, 0.44], [0.36, 0.44], 2, g);
  if (R === 'west' && f !== 'israel') jersey(k, -0.15, -0.42, 0.5, 0);
  k.height = 0.75;
}

function atgm(k: Kit) {
  const P = k.P;
  const R = P.R;
  const g = emplacement(k, 'low');
  const th = 0.42;
  let top = g + th;
  if (R === 'west') {
    k.rbox(P.concrete, 0.4, th, 0.4, 0, g, 0, 0.02);
    k.box(P.team, 0.404, 0.03, 0.404, 0, g + th - 0.08, 0);
    k.box(P.grating, 0.5, 0.02, 0.5, 0, g + th, 0);
    railing(k, [[-0.24, -0.24], [0.24, -0.24], [0.24, 0.24], [-0.24, 0.24], [-0.24, -0.24]], g + th + 0.02, 0.06);
    ladder(k, 'z', 1, 0.08, g, g + th, 0.2);
    door(k, 'x', 1, 0.0, g, 0.2, 0.09, 0.17, false);
    top = g + th + 0.02;
  } else if (R === 'east') {
    for (let i = 0; i < 3; i++) {
      k.cyl(P.wall, 0.2, th / 3 - 0.006, 0, g + (i * th) / 3, 0, 18);
      k.ring(P.base, 0.2, 0.006, 0, g + ((i + 1) * th) / 3 - 0.004, 0, 18);
    }
    k.cyl(P.team, 0.202, 0.03, 0, g + th - 0.08, 0, 18);
    k.cyl(P.concrete, 0.26, 0.03, 0, g + th, 0, 18);
    ladder(k, 'z', 1, 0.0, g, g + th, 0.18);
    stencil(k, '8', 'x', 1, -0.08, g + 0.12, 0.2, 0.12);
    sandbags(k, [0.38, -0.3], [0.38, 0.3], 2, g);
    top = g + th + 0.03;
  } else if (R === 'asia') {
    k.box(P.wall, 0.38, th, 0.38, 0, g, 0);
    k.box(P.accent, 0.384, 0.03, 0.384, 0, g + th - 0.06, 0);
    k.box(P.team, 0.384, 0.02, 0.384, 0, g + th - 0.11, 0);
    punched(k, 'z', 1, -0.1, 0.1, 1, g + 0.22, 0.19, 0.08, 0.04);
    punched(k, 'x', 1, -0.1, 0.1, 1, g + 0.22, 0.19, 0.08, 0.04);
    k.box(P.concrete, 0.46, 0.03, 0.46, 0, g + th, 0);
    door(k, 'z', 1, 0.0, g, 0.19, 0.09, 0.16, false);
    top = g + th + 0.03;
  } else {
    k.box(P.wall2, 0.4, th, 0.4, 0, g, 0);
    punched(k, 'z', 1, -0.1, 0.1, 1, g + 0.2, 0.2, 0.05, 0.1, 'arch');
    punched(k, 'x', 1, -0.1, 0.1, 1, g + 0.2, 0.2, 0.05, 0.1, 'arch');
    flatRoof(k, -0.2, 0.2, -0.2, 0.2, g + th, 0.03, P.wall2);
    k.box(P.tile, 0.404, 0.035, 0.404, 0, g + th - 0.06, 0, 0);
    k.box(P.team, 0.404, 0.015, 0.404, 0, g + th - 0.08, 0);
    sandbags(k, [0.38, -0.3], [0.38, 0.3], 2, g);
    top = g + th + 0.01;
  }
  const hull = P.mats.col(P.s.hull, 0.68, 0.2);
  const t = k.node('turret', 0, top, 0);
  k.turret = true;
  k.on(t, () => {
    k.cyl(P.dark, 0.09, 0.03, 0, 0, 0, 14);
    k.cyl(P.steel, 0.02, 0.09, 0, 0.03, 0, 8);
    const pod = k.node('pod', 0, 0.14, 0, 0, 0, 0.08);
    k.on(pod, () => {
      k.box(hull, 0.08, 0.06, 0.08, 0, -0.03, 0);
      for (const sz of [-1, 1]) {
        k.tube(hull, [-0.18, 0, sz * 0.06], [0.2, 0, sz * 0.06], 0.035, 12);
        k.tube(P.black, [0.2, 0, sz * 0.06], [0.205, 0, sz * 0.06], 0.028, 12);
        k.ring(P.team, 0.036, 0.004, 0.0, 0, sz * 0.06, 12);
      }
      k.rbox(P.mats.col(0x30343a, 0.4, 0.5), 0.1, 0.07, 0.06, 0.02, 0.04, 0, 0.01);
      k.tube(P.red_l, [0.07, 0.075, 0], [0.074, 0.075, 0], 0.016, 10);
      k.box(P.glass, 0.004, 0.03, 0.03, 0.071, 0.05, 0.0);
      k.muzzle(0.21, 0, 0.06);
      k.muzzle(0.21, 0, -0.06);
    });
  });
  k.height = 0.75;
}

// ================================================================ OIL DERRICK (2x2, neutral)

function oil(k: Kit) {
  const P = k.P;
  slab(k, 2, 2, 0.03, undefined, P.mats.tex('soil', { color: 0x8a7a5a, seed: 32, size: 256 }, 0xffffff, 2));
  const Y = 0.03;
  k.box(P.concrete, 1.3, 0.03, 0.5, -0.05, Y, 0.15);
  // oil stain
  k.at(0.45, Y + 0.031, 0.32, 0.3, () => k.cyl(P.mats.col(0x2a2620, 0.3, 0.3), 0.2, 0.002, 0, 0, 0, 20));
  const Yp = Y + 0.03;
  const zc = 0.15;
  const beamM = P.mats.col(mix(P.s.team, 0x707070, 0.2), 0.55, 0.3);
  const frame = P.mats.col(0x5a5e60, 0.55, 0.5);
  // skid + samson post
  k.box(P.dark, 1.15, 0.05, 0.24, -0.05, Yp, zc);
  const Px = 0.0;
  const Py = Yp + 0.62;
  for (const sz of [-1, 1]) {
    k.bar(frame, [-0.17, Yp + 0.05, zc + sz * 0.1], [Px, Py - 0.03, zc + sz * 0.03], 0.024);
    k.bar(frame, [0.17, Yp + 0.05, zc + sz * 0.1], [Px, Py - 0.03, zc + sz * 0.03], 0.024);
  }
  k.bar(frame, [-0.1, Yp + 0.3, zc - 0.07], [0.1, Yp + 0.3, zc - 0.07], 0.012);
  k.bar(frame, [-0.1, Yp + 0.3, zc + 0.07], [0.1, Yp + 0.3, zc + 0.07], 0.012);
  ladder(k, 'z', 1, 0.15, Yp + 0.05, Py - 0.1, zc + 0.05);
  // walking beam + horse head (animated)
  const beam = k.node('beam', Px, Py, zc);
  k.on(beam, () => {
    k.box(beamM, 0.98, 0.06, 0.05, 0.06, -0.03, 0);
    k.box(P.team, 0.3, 0.062, 0.052, 0.06, -0.031, 0);
    k.prism(beamM, [[0.52, 0.06], [0.6, 0.04], [0.65, -0.03], [0.63, -0.17], [0.56, -0.17], [0.57, -0.03], [0.52, 0.0]], 0.09);
    k.box(P.dark, 0.08, 0.07, 0.07, -0.42, -0.06, 0);
    k.tube(P.dark, [0, 0, -0.05], [0, 0, 0.05], 0.035, 12);
  });
  // polished rod hanging from the horse head
  const rodY = Py - 0.17;
  const rod = k.node('rod', 0.62 + Px, rodY, zc);
  k.on(rod, () => {
    k.tube(P.galv, [0, 0, 0], [0, -0.42, 0], 0.005, 4);
    k.box(P.dark, 0.05, 0.015, 0.03, 0, -0.01, 0);
  });
  // wellhead (christmas tree)
  const wx = 0.62;
  k.cyl(P.mats.col(0x8a3b2a, 0.55, 0.4), 0.04, 0.12, wx, Yp, zc, 10);
  k.box(P.steel, 0.12, 0.04, 0.12, wx, Yp + 0.12, zc);
  k.cyl(P.galv, 0.02, 0.08, wx, Yp + 0.16, zc, 8);
  k.tube(P.red, [wx, Yp + 0.08, zc], [wx, Yp + 0.08, zc + 0.08], 0.012, 8);
  k.sph(P.red, 0.02, wx, Yp + 0.08, zc + 0.09, 8, 6);
  // gearbox, crank (animated) and pitman arms (animated)
  const Gx = -0.42;
  const Gy = Yp + 0.2;
  k.box(P.mats.col(0x55595d, 0.55, 0.4), 0.18, 0.17, 0.13, Gx, Yp, zc);
  k.box(P.dark, 0.14, 0.1, 0.1, Gx - 0.2, Yp, zc);
  k.tube(P.dark, [Gx - 0.12, Yp + 0.06, zc], [Gx - 0.04, Yp + 0.12, zc], 0.02, 8);
  const crank = k.node('crank', Gx, Gy, zc);
  k.on(crank, () => {
    for (const sz of [-1, 1]) {
      k.box(P.dark, 0.3, 0.04, 0.02, -0.03, -0.02, sz * 0.09);
      k.prism(P.red, [[-0.16, -0.08], [-0.08, -0.1], [-0.08, 0.1], [-0.16, 0.08]], 0.035, 0, 0, sz * 0.09);
    }
    k.tube(P.steel, [0, 0, -0.1], [0, 0, 0.1], 0.02, 10);
  });
  const pit = k.node('pit', Gx + 0.12, Gy, zc);
  k.on(pit, () => {
    for (const sz of [-1, 1]) k.box(P.steel, 0.014, 1, 0.014, 0, 0, sz * 0.095);
  });
  k.specs.push({ k: 'pump', crank: 'crank', beam: 'beam', rod: 'rod', pit: 'pit', G: [Gx, Gy], P: [Px, Py], r: 0.12, R: 0.42, Rf: 0.62, amp: 0.2, rodY });
  // storage tanks, separator, pipes, shed
  silo(k, 0.5, -0.55, 0.28, 0.48, P.tank, 'flat', Y);
  ladder(k, 'x', 1, -0.55, Y, Y + 0.48, 0.78);
  silo(k, -0.42, -0.6, 0.22, 0.36, P.tank, 'flat', Y);
  k.at(-0.75, Y, 0.72, 0, () => {
    k.box(P.concrete, 0.3, 0.02, 0.18, 0, 0, 0);
    k.tube(P.mats.col(0x9aa08a, 0.5, 0.4), [-0.11, 0.1, 0], [0.11, 0.1, 0], 0.06, 12);
    k.box(P.dark, 0.03, 0.05, 0.12, -0.09, 0.02, 0);
    k.box(P.dark, 0.03, 0.05, 0.12, 0.09, 0.02, 0);
  });
  const pm = P.mats.col(0x55504a, 0.55, 0.5);
  k.pipe(pm, [[wx, Yp + 0.05, zc + 0.08], [wx, Yp + 0.05, -0.2], [0.5, Yp + 0.05, -0.27]], 0.016, 8);
  k.pipe(pm, [[0.22, Y + 0.1, -0.55], [-0.2, Y + 0.1, -0.58]], 0.016, 8);
  k.pipe(pm, [[-0.42, Y + 0.06, -0.38], [-0.42, Y + 0.06, 0.4], [-0.75, Y + 0.06, 0.62]], 0.014, 8);
  k.box(P.corrRust, 0.32, 0.2, 0.26, 0.62, Y, 0.72);
  k.at(0.62, Y + 0.2, 0.72, 0, () => k.box(P.corr, 0.36, 0.015, 0.3, 0, 0, 0), 0.1);
  door(k, 'x', 1, 0.72, Y, 0.78, 0.08, 0.15, false);
  barrels(k, 0.3, 0.85, 3, 0x2f4f6f, Y);
  barrels(k, 0.18, 0.88, 1, 0x7a2a1a, Y);
  lightPole(k, -0.85, -0.05, 0.38, 0, Y);
  fence(k, [[-0.95, -0.95], [0.95, -0.95], [0.95, 0.4]], 0.13, Y);
  k.height = 0.85;
}
// ================================================================ registry

/** Model builders keyed by model key (see sim/defs.ts `model` fields). */
export const BUILDINGS: Record<string, Builder> = {
  conyard: building('conyard', 3, 3, conyard),
  power: building('power', 2, 2, power),
  refinery: building('refinery', 3, 3, refinery),
  barracks: building('barracks', 2, 2, barracks),
  factory: building('factory', 3, 3, factory),
  radar: building('radar', 2, 2, radar),
  airfield: building('airfield', 7, 4, airfield),
  tech: building('tech', 3, 3, tech),
  bunker: building('bunker', 1, 1, bunker),
  sentry: building('sentry', 1, 1, sentry),
  sam: building('sam', 1, 1, sam),
  atgm: building('atgm', 1, 1, atgm),
  oil: building('oil', 2, 2, oil),
  // the nations' superweapon complexes (sim/specialdefs.ts superweaponBuilding)
  sw_silo: building('sw_silo', 3, 3, swSilo),
  sw_laser: building('sw_laser', 3, 3, swLaser),
  sw_drone: building('sw_drone', 3, 3, swDrone),
  sw_rocket: building('sw_rocket', 3, 3, swRocket),
  sw_cruise: building('sw_cruise', 3, 3, swCruise),
  // capturable neutral tech structures (sim/specialdefs.ts)
  tech_hospital: building('tech_hospital', 2, 2, techHospital),
  tech_airport: building('tech_airport', 3, 3, techAirport),
  tech_comms: building('tech_comms', 2, 2, techComms),
};
