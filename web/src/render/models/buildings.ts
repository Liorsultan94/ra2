import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { FogOfWar } from '../fog';
import { pbr, worldUV, type TexKind, type TexOpts } from '../textures';
import type { Builder } from './registry';
import type { AnimState, Model, ModelStyle, Region } from './types';
import { drawFlag } from '../flags';
import { BuildFx, FxTpl, newRec, type FxModel, type FxRec } from './buildfx';

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
function texHazard() {
  return canvasTex('hazard', 64, 64, (c, w, h) => {
    c.fillStyle = '#e2b021';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#1c1c1c';
    for (let i = -2; i < 4; i++) {
      c.beginPath();
      c.moveTo(i * 32, 0);
      c.lineTo(i * 32 + 16, 0);
      c.lineTo(i * 32 + 16 + 64, h);
      c.lineTo(i * 32 + 64, h);
      c.closePath();
      c.fill();
    }
  });
}
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
    c.lineWidth = 14;
    c.beginPath();
    c.arc(w / 2, w / 2, w / 2 - 14, 0, TAU);
    c.stroke();
    c.fillStyle = color;
    const s = w / 256;
    c.fillRect(78 * s, 64 * s, 26 * s, 128 * s);
    c.fillRect(152 * s, 64 * s, 26 * s, 128 * s);
    c.fillRect(100 * s, 116 * s, 56 * s, 24 * s);
  });
}
function texMashrabiya() {
  return canvasTex('mashrabiya', 128, 128, (c, w, h) => {
    c.fillStyle = '#20150c';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = '#8a6440';
    c.lineWidth = 5;
    const n = 4;
    const s = w / n;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const x = i * s + s / 2;
        const y = j * s + s / 2;
        c.beginPath();
        c.arc(x, y, s * 0.3, 0, TAU);
        c.stroke();
        c.strokeRect(i * s, j * s, s, s);
        c.beginPath();
        c.moveTo(x - s / 2, y);
        c.lineTo(x + s / 2, y);
        c.moveTo(x, y - s / 2);
        c.lineTo(x, y + s / 2);
        c.stroke();
      }
  });
}
function texTileBand(main: number, alt: number) {
  return canvasTex('tileband' + main + alt, 128, 64, (c, w, h) => {
    c.fillStyle = css(main);
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#f0ead8';
    c.fillRect(0, 0, w, 6);
    c.fillRect(0, h - 6, w, 6);
    for (let i = 0; i < 4; i++) {
      const x = i * 32 + 16;
      const y = h / 2;
      c.fillStyle = '#f2ecd6';
      c.beginPath();
      for (let k = 0; k < 16; k++) {
        const r = k % 2 ? 9 : 17;
        const a = (k / 16) * TAU;
        if (k) c.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        else c.moveTo(x + r, y);
      }
      c.closePath();
      c.fill();
      c.fillStyle = css(alt);
      c.beginPath();
      c.arc(x, y, 7, 0, TAU);
      c.fill();
      c.fillStyle = '#d8b04a';
      c.beginPath();
      c.arc(x + 16, y, 3, 0, TAU);
      c.fill();
    }
  });
}
function texSolar() {
  return canvasTex('solar', 64, 64, (c, w, h) => {
    c.fillStyle = '#1b2a4a';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = '#8c9aac';
    c.lineWidth = 1;
    for (let i = 0; i <= 8; i++) {
      c.beginPath();
      c.moveTo(i * 8, 0);
      c.lineTo(i * 8, h);
      c.stroke();
    }
    for (let j = 0; j <= 4; j++) {
      c.beginPath();
      c.moveTo(0, j * 16);
      c.lineTo(w, j * 16);
      c.stroke();
    }
    c.fillStyle = 'rgba(120,160,220,0.15)';
    c.fillRect(0, 0, w, h / 3);
  });
}
function texStencil(text: string, color: string) {
  return canvasTex('sten' + text + color, 128, 64, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.fillStyle = color;
    c.font = 'bold 50px Arial, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, w / 2, h / 2 + 2);
  });
}
function texFlag(cols: number[], faction: string) {
  return canvasTex('flag' + cols.join(',') + faction, 96, 64, (c, w, h) => {
    if (drawFlag(c, faction, w, h)) return;
    for (let i = 0; i < 3; i++) {
      c.fillStyle = css(cols[i] ?? 0x888888);
      c.fillRect(0, (i * h) / 3, w, h / 3 + 1);
    }
  });
}

/**
 * Per-template material factory bound to an owner (style) and a fog instance.
 *
 * To keep draw calls low most materials handed out are *virtual*: lightweight
 * descriptors pointing at a shared real material plus a tint which the kit
 * bakes into a vertex colour attribute. Plain colours collapse into a handful
 * of roughness/metalness buckets, tinted textures share one material per
 * texture, and all small lamps share one emissive material.
 */
class Mats {
  readonly glow = new Set<Mat>();
  readonly flags: SMat[] = [];
  private readonly fid: number;
  private readonly own: string;
  constructor(
    readonly s: ModelStyle,
    readonly fog: FogOfWar | null,
  ) {
    this.fid = fogId(fog);
    this.own = `${s.faction}:${s.team}`;
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
  private virt(real: Mat, color: THREE.Color, uv: number): SMat {
    const k = `v|${real.uuid}|${color.getHexString()}|${color.r.toFixed(4)}|${uv}`;
    let m = matCache.get(k) as SMat | undefined;
    if (!m) {
      m = new THREE.MeshStandardMaterial();
      m.userData.real = real;
      m.userData.vc = color;
      m.userData.uv = uv;
      matCache.set(k, m);
    }
    return m;
  }
  /** Textured PBR material (procedural texture from textures.ts), tinted per vertex. */
  tex(kind: TexKind, opts: TexOpts, tint = 0xffffff, uv = 3, rough = 1, metal = 0.03, nScale = 1): SMat {
    const real = this.cached(`tex:${kind}:${JSON.stringify(opts)}:${rough}:${metal}:${nScale}`, false, () => {
      const set = pbr(kind, opts);
      return new THREE.MeshStandardMaterial({
        map: set.map,
        normalMap: set.normalMap,
        roughnessMap: set.roughnessMap,
        roughness: rough,
        metalness: metal,
        vertexColors: true,
        normalScale: new THREE.Vector2(nScale, nScale),
      });
    });
    return this.virt(real, new THREE.Color(tint), uv);
  }
  /** Plain colour: bucketed by roughness / metalness into a few shared vertex coloured materials. */
  col(color: number, rough = 0.7, metal = 0.1, double = false): SMat {
    let b: string;
    let r: number;
    let mt: number;
    if (double) [b, r, mt] = ['dbl', 0.8, 0.05];
    else if (rough < 0.2 && metal > 0.5) [b, r, mt] = ['gloss', 0.08, 0.85];
    else if (metal >= 0.45) [b, r, mt] = ['metal', 0.42, 0.65];
    else [b, r, mt] = ['paint', 0.7, 0.12];
    const real = this.cached(`vc:${b}`, false, () => new THREE.MeshStandardMaterial({ roughness: r, metalness: mt, vertexColors: true, side: double ? THREE.DoubleSide : THREE.FrontSide }));
    return this.virt(real, new THREE.Color(color), 0);
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
        roughness: 1,
        metalness: 0.35,
        emissiveMap: set.emissiveMap ?? null,
        emissive: 0xffffff,
        emissiveIntensity: curtain ? 0.7 : 0.9,
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

// ================================================================ palette

/** Regional material palette. */
interface Pal {
  R: Region;
  wall: SMat; // main facade
  wall2: SMat; // secondary facade (cladding / brick / stone)
  wallB: SMat; // slight colour variation of the main wall
  base: SMat; // plinth / dark concrete
  trim: SMat; // coping, cornices, frames
  roof: SMat; // flat roof surface
  pitch: SMat; // pitched roof cladding
  slab: SMat; // ground apron
  asphalt: SMat;
  concrete: SMat; // neutral cast concrete (barriers, pads, foundations)
  team: SMat;
  teamD: SMat;
  accent: SMat; // faction/regional trim colour
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
  lamp: SMat; // warm lamp glow
  red_l: SMat; // red aviation light
  green_l: SMat;
  cyan_l: SMat;
  amber_l: SMat;
  chain: SMat;
  solar: SMat;
  mash: SMat;
  tile: SMat; // decorative tile band (mideast) / dancheong band (asia)
  dome: SMat; // dome cladding
  mats: Mats;
  s: ModelStyle;
  T: TexSet;
}
type TexSet = ReturnType<typeof texSet>;
function texSet(M: Mats) {
  return {
    concrete: (tint: number, uv = 2.2) => M.tex('concrete', { color: 0xe4e2dc, divisions: 2, grime: 0.35, seed: 11 }, tint, uv),
    concreteDark: (tint: number, uv = 2) => M.tex('concreteDark', { color: 0xc4c0b6, divisions: 3, grime: 0.6, seed: 12 }, tint, uv),
    plaster: (tint: number, uv = 2) => M.tex('plaster', { color: 0xf4f1ea, grime: 0.3, seed: 13 }, tint, uv),
    sandstone: (tint: number, uv = 2.5) => M.tex('sandstone', { color: 0xe8d6b0, grime: 0.3, divisions: 8, seed: 14 }, tint, uv),
    brick: (tint: number, uv = 3) => M.tex('brick', { color: 0x9a4a32, grime: 0.45, seed: 15 }, tint, uv),
    corr: (tint: number, uv = 3) => M.tex('corrugated', { color: 0xd0d4d6, grime: 0.15, divisions: 24, seed: 16 }, tint, uv, 1, 0.45),
    corrRust: (tint: number, uv = 4) => M.tex('corrugated', { color: 0xa8a49a, grime: 0.85, divisions: 24, seed: 17 }, tint, uv, 1, 0.35),
    panel: (tint: number, uv = 2.5) => M.tex('metalPanel', { color: 0xdadde0, divisions: 3, grime: 0.2, seed: 18 }, tint, uv, 1, 0.35),
    tiles: (tint: number, uv = 4) => M.tex('roofTiles', { color: 0xe6e8e6, divisions: 10, grime: 0.25, seed: 19 }, tint, uv, 0.9, 0.1),
    asphalt: (tint: number, uv = 1.5) => M.tex('asphalt', { color: 0x46474a, seed: 20 }, tint, uv),
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
  const M = new Mats(s, fog);
  const R = s.region;
  const f = s.faction;
  const T = texSet(M);
  const team = M.col(s.team, 0.55, 0.2);
  const common = {
    team: () => team,
    teamD: () => M.col(shade(s.team, 0.6), 0.6, 0.2),
    steel: () => M.col(0x6f757b, 0.45, 0.65),
    galv: () => M.col(0xa8adb0, 0.4, 0.75),
    dark: () => M.col(0x2c2f33, 0.75, 0.3),
    black: () => M.col(0x141516, 0.9, 0.1),
    rubber: () => M.col(0x1c1c1c, 0.95, 0),
    glass: () => M.col(0x3a5a74, 0.08, 0.85),
    white: () => M.col(0xe8e8e2, 0.75, 0.02),
    yellow: () => M.col(0xe0ae22, 0.7, 0.05),
    red: () => M.col(0xb3261e, 0.6, 0.1),
    hazard: () => M.canvas('hazard', texHazard(), { uv: 8, rough: 0.7 }),
    sandbag: () => M.tex('sandbag', { color: 0xb09c72, seed: 21, size: 256 }, 0xffffff, 7),
    wood: () => M.tex('wood', { color: 0x8a6a46, seed: 22, size: 256 }, 0xffffff, 5),
    canvas: () => M.tex('canvas', { color: 0x6b6a4a, seed: 23, grime: 0.4, size: 256 }, 0xffffff, 3),
    grating: () => M.tex('grating', { color: 0x6a6c6e, seed: 24, size: 256 }, 0xffffff, 8, 1, 0.6),
    rust: () => M.tex('rust', { seed: 25, size: 256 }, 0xffffff, 3),
    soil: () => M.tex('soil', { color: 0x6a5a40, seed: 26, size: 256 }, 0xffffff, 2),
    green: () => M.col(0x3f6a2c, 0.9, 0),
    pipe: () => M.col(0x8c9196, 0.45, 0.6),
    lamp: () => M.light(0xfff0c8, 2.8),
    red_l: () => M.light(0xff2a1a, 3.2),
    green_l: () => M.light(0x30ff6a, 2.6),
    cyan_l: () => M.light(0x5fe0ff, 2.6),
    amber_l: () => M.light(0xffa21a, 3),
    chain: () => M.canvas('chain', texChain(), { alphaTest: 0.4, double: true, uv: 9, metal: 0.6, rough: 0.5 }),
    solar: () => M.canvas('solar', texSolar(), { uv: 6, rough: 0.45, metal: 0.15 }),
    mash: () => M.canvas('mash', texMashrabiya(), { uv: 9, rough: 0.8 }),
    win: () => M.win(false),
    winC: () => M.win(true),
    corr: () => T.corr(0xffffff),
    corrRust: () => T.corrRust(0xffffff),
    brick: () => T.brick(0xffffff),
    mats: () => M,
    s: () => s,
    T: () => T,
  };
  switch (R) {
    case 'east': {
      const ukr = f === 'ukraine';
      return {
        ...common,
        R: () => R,
        wall: () => T.concreteDark(0xffffff),
        wallB: () => T.concreteDark(0xe8e2d4),
        wall2: () => ukr ? T.plaster(0xe2cf92) : T.brick(0xffffff),
        base: () => T.concreteDark(0x9a968e),
        trim: () => T.concrete(0xb8b4aa),
        roof: () => T.asphalt(0xb0aaa0),
        pitch: () => T.corr(0xa8a8a0, 1.6),
        slab: () => T.concreteDark(0xd8d4cc, 1.2),
        asphalt: () => T.asphalt(0xffffff),
        concrete: () => T.concrete(0xc0bcb2),
        accent: () => M.col(ukr ? 0x3a5a8a : 0x3f5e3a, 0.7, 0.2), // painted gates (Soviet green / Ukrainian blue)
        door: () => M.col(0x4a5a3c, 0.75, 0.3),
        rollup: () => T.corrRust(0x9aa08a),
        tank: () => M.col(0x9ea08e, 0.6, 0.35),
        crane: () => M.col(0xd09a2a, 0.65, 0.3),
        tile: () => M.col(0xa83228, 0.7, 0.1),
        dome: () => T.panel(0xb4b8ba),
      };
    }
    case 'asia': {
      const kor = f === 'korea';
      const trimC = kor ? 0x2f7a5a : 0xa8261e;
      return {
        ...common,
        R: () => R,
        wall: () => T.plaster(0xf2f2ee),
        wallB: () => T.plaster(0xe6e8e6),
        wall2: () => T.concrete(0xd8dcdc),
        base: () => T.concrete(0x8e9294),
        trim: () => M.col(trimC, 0.55, 0.1),
        roof: () => T.concrete(0xa2a8aa),
        pitch: () => T.tiles(kor ? 0x6d7f9e : 0x5fae96),
        slab: () => T.concrete(0xd4d6d4, 1.2),
        asphalt: () => T.asphalt(0xffffff),
        concrete: () => T.concrete(0xd0d0cc),
        accent: () => M.col(trimC, 0.55, 0.1),
        door: () => M.col(kor ? 0x2a4f6e : 0x7a1e1a, 0.6, 0.2),
        rollup: () => T.corr(kor ? 0x7a96b8 : 0x8ab0a4),
        tank: () => M.col(0xe8ecec, 0.45, 0.3),
        crane: () => M.col(0xe0b020, 0.6, 0.3),
        tile: () => M.col(kor ? 0x2a6a8e : 0x2f8a6e, 0.6, 0.1),
        dome: () => T.panel(0xeef2f2),
      };
    }
    case 'mideast': {
      const tur = f === 'turkey';
      return {
        ...common,
        R: () => R,
        wall: () => T.plaster(tur ? 0xeee2c8 : 0xe6cfa2),
        wallB: () => T.plaster(tur ? 0xe2d4b4 : 0xdcc396),
        wall2: () => T.sandstone(tur ? 0xf0e4cc : 0xffffff),
        base: () => T.sandstone(0xb8a27a),
        trim: () => T.sandstone(0xf4e8d0),
        roof: () => T.plaster(0xd6c6a6),
        pitch: () => T.plaster(0xd0bc96),
        slab: () => T.concrete(0xe0cfa8, 1.2),
        asphalt: () => T.asphalt(0xd8ccb0),
        concrete: () => T.concrete(0xe0d4b8),
        accent: () => M.col(tur ? 0xb8202e : 0x1f9a8e, 0.5, 0.1),
        door: () => M.col(0x6a4a2a, 0.8, 0.05),
        rollup: () => T.corr(0xd8c8a4),
        tank: () => M.col(0xe8e2d4, 0.5, 0.3),
        crane: () => M.col(0xe8c040, 0.6, 0.3),
        tile: () => M.canvas('tb' + f, texTileBand(tur ? 0x1f5fa8 : 0x1f9aa0, tur ? 0xb8202e : 0x1a3f8a), { uv: 0, rough: 0.35, metal: 0.1 }),
        dome: () => tur ? T.panel(0x9aa2a8) : T.tiles(0x49c0b8),
      };
    }
    default: {
      // west
      const isr = f === 'israel';
      const ger = f === 'germany';
      const wallT = isr ? 0xf2ead8 : ger ? 0xd2d2ce : 0xe0d6c0;
      return {
        ...common,
        R: () => 'west',
        wall: () => isr ? T.sandstone(0xfaf2e0, 2.2) : T.concrete(wallT),
        wallB: () => T.concrete(shade(wallT, 0.93)),
        wall2: () => T.panel(ger ? 0x9ea694 : isr ? 0xc8ccd0 : 0xa9b4bc),
        base: () => T.concrete(0x8e8c88),
        trim: () => M.col(0x8a9096, 0.4, 0.6),
        roof: () => T.concrete(0x8e9092, 1.6),
        pitch: () => T.corr(ger ? 0x6c7466 : 0x8a9298),
        slab: () => T.concrete(0xd8d6d0, 1.2),
        asphalt: () => T.asphalt(0xffffff),
        concrete: () => T.concrete(0xd2d0ca),
        accent: () => M.col(s.accent, 0.6, 0.2),
        door: () => M.col(0x5a6066, 0.5, 0.5),
        rollup: () => T.corr(0xc8ccce),
        tank: () => M.col(0xdadcda, 0.45, 0.4),
        crane: () => M.col(0xf0c020, 0.55, 0.3),
        tile: () => M.col(s.accent, 0.6, 0.2),
        dome: () => T.panel(0xf2f2f0),
      };
    }
  }
}

// ================================================================ animation specs

type AnimSpec =
  | { k: 'spin'; n: string; ax: Ax; v: number }
  | { k: 'osc'; n: string; ax: Ax; a: number; f: number; p: number; b: number }
  | { k: 'slide'; n: string; ax: Ax; a: number; f: number; p: number; b: number }
  | { k: 'blink'; n: string; per: number; on: number; p: number }
  | { k: 'pump'; crank: string; beam: string; rod: string; pit: string; G: P2; P: P2; r: number; R: number; Rf: number; amp: number; rodY: number };

interface Tpl {
  root: THREE.Group;
  specs: AnimSpec[];
  glow: Mat[];
  flags: SMat[];
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
  rnd: () => number;
  /** Walls, windows, lamps... recorded for the construction / damage visuals. */
  readonly rec: FxRec = newRec();
  private bins = new Map<THREE.Object3D, Map<Mat, THREE.BufferGeometry[]>>();
  /** Project texture UVs in the primitive's local frame instead of building space. */
  luv = false;
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
    this.cur.add(o);
    return o;
  }
  muzzle(x: number, y: number, z: number) {
    this.node('muzzle' + this.muzzles++, x, y, z);
  }
  emit(x: number, y: number, z: number, kind: 'smoke' | 'steam' | 'spark' | 'fire') {
    const v = new THREE.Vector3(x, y, z).applyMatrix4(this.T);
    this.emitters.push({ pos: v, kind });
  }
  /** Record a point (current frame) into one of the fx record lists. */
  mark(list: 'elec' | 'blinks', x: number, y: number, z: number) {
    if (this.cur !== this.root) return;
    const v = new THREE.Vector3(x, y, z).applyMatrix4(this.T);
    this.rec[list].push(v.x, v.y, v.z);
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
    this.rec.walls.push(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z));
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
    if (scale > 0 && !this.luv) worldUV(geo, scale);
    else if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    for (const name of Object.keys(geo.attributes)) if (!KEEP.has(name)) geo.deleteAttribute(name);
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
    let bin = this.bins.get(this.cur);
    if (!bin) {
      bin = new Map();
      this.bins.set(this.cur, bin);
    }
    let list = bin.get(m);
    if (!list) {
      list = [];
      bin.set(m, list);
    }
    list.push(geo);
    geo = null as unknown as THREE.BufferGeometry;
  }

  /** Merge everything into meshes. */
  finish() {
    for (const [obj, bin] of this.bins) {
      for (const [m, list] of bin) {
        let geo: THREE.BufferGeometry | null = null;
        try {
          geo = list.length === 1 ? list[0] : mergeGeometries(list, false);
        } catch (e) {
          console.warn('building merge failed', e);
        }
        if (!geo) continue;
        if (list.length > 1) for (const g of list) g.dispose();
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, m);
        const sm = m as SMat;
        const isGlow = !!sm.userData.baseEI && !sm.map;
        mesh.castShadow = !isGlow && !sm.alphaTest;
        mesh.receiveShadow = true;
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
      if (Math.abs(n.y) < 0.1) this.rec.wins.push(p.x, p.y, p.z, n.x, n.z, w, h);
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
  blinkLight(x: number, y: number, z: number, r = 0.022, per = 1.4, p = 0) {
    const n = 'blink' + this.specs.length;
    const o = this.node(n, x, y, z);
    this.mark('blinks', x, y, z);
    this.on(o, () => this.sph(this.P.red_l, r, 0, 0, 0, 8, 6));
    this.specs.push({ k: 'blink', n, per, on: 0.45, p });
  }
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
      faceBox(k, P.wood, face, sign, c, y - 0.015, at, ww + 0.03, 0.012, 0.035);
      faceBox(k, P.mash, face, sign, c, y - 0.003, at, ww + 0.016, wh + 0.01, 0.03);
      faceBox(k, P.wood, face, sign, c, y + wh + 0.007, at, ww + 0.03, 0.012, 0.038);
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

/** Glass curtain wall section with frame. */
function curtain(k: Kit, face: Face, sign: number, a0: number, a1: number, y0: number, y1: number, at: number, cw = 0.1, ch = 0.12) {
  const P = k.P;
  const n = Math.max(1, Math.round((a1 - a0) / cw));
  const m = Math.max(1, Math.round((y1 - y0) / ch));
  k.panel(P.winC, face, sign, (a0 + a1) / 2, y0, at + sign * 0.004, a1 - a0, y1 - y0, cell(k, n, m));
  for (const a of [a0, a1]) faceBox(k, P.trim, face, sign, a, y0, at, 0.012, y1 - y0, 0.012);
  for (let i = 0; i <= m; i++) faceBox(k, P.trim, face, sign, (a0 + a1) / 2, y0 + ((y1 - y0) * i) / m - 0.004, at, a1 - a0, 0.008, 0.01);
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
  if (P.R === 'mideast') {
    // crenellated parapet (stepped merlons)
    const mer = (a0: number, a1: number, fixed: number, alongX: boolean) => {
      const n = Math.max(2, Math.round((a1 - a0) / 0.07));
      for (let i = 0; i < n; i++) {
        const a = a0 + ((a1 - a0) * (i + 0.5)) / n;
        if (alongX) {
          k.box(P.trim, 0.034, 0.022, t + 0.006, a, y + ph, fixed);
          k.box(P.trim, 0.018, 0.014, t + 0.006, a, y + ph + 0.022, fixed);
        } else {
          k.box(P.trim, t + 0.006, 0.022, 0.034, fixed, y + ph, a);
          k.box(P.trim, t + 0.006, 0.014, 0.018, fixed, y + ph + 0.022, a);
        }
      }
    };
    mer(x0, x1, z1 - t / 2, true);
    mer(x0, x1, z0 + t / 2, true);
    mer(z0 + t, z1 - t, x1 - t / 2, false);
    mer(z0 + t, z1 - t, x0 + t / 2, false);
    k.box(P.trim, W + 0.01, 0.01, 0.01, cx, y + ph - 0.012, z1 + 0.003);
    k.box(P.trim, 0.01, 0.01, D + 0.01, x1 + 0.003, y + ph - 0.012, cz);
  } else {
    const ct = P.R === 'east' ? P.concrete : P.trim;
    k.box(ct, W + 0.008, 0.008, t + 0.01, cx, y + ph, z1 - t / 2);
    k.box(ct, W + 0.008, 0.008, t + 0.01, cx, y + ph, z0 + t / 2);
    k.box(ct, t + 0.01, 0.008, D - 2 * t, x1 - t / 2, y + ph, cz);
    k.box(ct, t + 0.01, 0.008, D - 2 * t, x0 + t / 2, y + ph, cz);
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

/** Regional rooftop clutter on a flat roof. */
function roofKit(k: Kit, x0: number, x1: number, z0: number, z1: number, y: number, n = 2) {
  const P = k.P;
  const r = k.rnd;
  const W = x1 - x0;
  const D = z1 - z0;
  const px = (f: number) => x0 + 0.1 + (W - 0.2) * f;
  const pz = (f: number) => z0 + 0.1 + (D - 0.2) * f;
  switch (P.R) {
    case 'west':
      for (let i = 0; i < n; i++) hvac(k, px((i + 0.5) / n), y, pz(0.25 + r() * 0.2), 0.16, 0.11, r() > 0.5 ? 0 : Math.PI / 2);
      vent(k, px(r()), y, pz(0.8));
      vent(k, px(r()), y, pz(0.7));
      if (W > 0.6) k.box(P.wall2, 0.14, 0.1, 0.12, px(0.85), y, pz(0.75)); // stair housing
      break;
    case 'east':
      for (let i = 0; i < n; i++) {
        const xx = px((i + 0.5) / n);
        const zz = pz(0.3 + r() * 0.3);
        k.box(P.brick, 0.06, 0.12, 0.06, xx, y, zz);
        k.box(P.concrete, 0.075, 0.012, 0.075, xx, y + 0.12, zz);
      }
      k.pipe(P.rust, [[px(0.1), y + 0.03, pz(0.9)], [px(0.6), y + 0.03, pz(0.9)], [px(0.6), y + 0.03, pz(0.5)]], 0.01, 6);
      k.cyl(P.dark, 0.004, 0.25, px(0.85), y, pz(0.2), 4);
      k.box(P.wall, 0.16, 0.08, 0.12, px(0.2), y, pz(0.75));
      break;
    case 'asia':
      for (let i = 0; i < n; i++) hvac(k, px((i + 0.5) / n), y, pz(0.3), 0.14, 0.1);
      // solar water heater
      k.at(px(0.75), y, pz(0.75), 0, () => {
        k.cyl(P.galv, 0.025, 0.2, -0.1, 0.1, 0, 10);
        k.tube(P.galv, [-0.1, 0.1, 0], [0.1, 0.1, 0], 0.022, 10);
        k.boxR(P.solar, 0.2, 0.008, 0.12, 0, 0.05, 0.05, 0, -0.6, 0, 6);
      });
      break;
    case 'mideast':
      for (let i = 0; i < n + 1; i++) {
        const xx = px((i + 0.5) / (n + 1));
        const zz = pz(0.2 + r() * 0.4);
        // water tank on a stand
        const c = i % 2 ? P.black : P.white;
        k.box(P.steel, 0.07, 0.03, 0.07, xx, y, zz);
        k.cyl(c, 0.035, 0.07, xx, y + 0.03, zz, 12);
      }
      k.rbox(P.white, 0.1, 0.06, 0.07, px(0.8), y, pz(0.8), 0.006);
      k.cyl(P.black, 0.02, 0.003, px(0.8), y + 0.06, pz(0.8), 10);
      satDish(k, px(0.15), y, pz(0.85), 0.05, 0.6);
      break;
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
  const style = o.win ?? { west: 'ribbon', east: 'punched', asia: 'ribbonC', mideast: 'arched' }[P.R];
  const skipZ: [number, number] | undefined = o.door !== undefined ? [o.door - 0.09, o.door + 0.09] : undefined;
  const skipX: [number, number] | undefined = o.doorX !== undefined ? [o.doorX - 0.09, o.doorX + 0.09] : undefined;
  if (style !== 'none') {
    facade(k, 'z', 1, x0, x1, z1, y0, h, floors, style, skipZ);
    facade(k, 'x', 1, z0, z1, x1, y0, h, floors, style, skipX);
  }
  if (o.door !== undefined) door(k, 'z', 1, o.door, y0, z1, 0.12, Math.min(0.2, h * 0.8));
  if (o.doorX !== undefined) door(k, 'x', 1, o.doorX, y0, x1, 0.12, Math.min(0.2, h * 0.8));
  // floor lines
  if (P.R === 'west' || P.R === 'asia') {
    for (let f = 1; f < floors; f++) {
      const yy = y0 + (h * f) / floors - 0.006;
      k.box(P.R === 'asia' ? P.white : P.wall2, W + 0.012, 0.014, D + 0.012, cx, yy, cz);
    }
  }
  // downpipes at the visible corners
  if (P.R !== 'mideast') {
    k.cyl(P.R === 'asia' ? P.white : P.galv, 0.007, h, x1 + 0.01, y0, z1 - 0.03, 6);
    if (W > 0.8) k.cyl(P.R === 'asia' ? P.white : P.galv, 0.007, h, x0 + 0.03, y0, z1 + 0.01, 6);
  }
  // team band
  if (o.band !== false) {
    const by = y0 + h - (o.roof === 'flat' || !o.roof ? 0.035 : 0.03);
    k.box(P.team, W + 0.008, 0.022, D + 0.008, cx, by, cz);
  }
  const top = y0 + h;
  const roof = o.roof ?? 'flat';
  if (roof === 'flat') {
    const ph = o.parapet ?? 0.035;
    flatRoof(k, x0, x1, z0, z1, top, ph, o.pm ?? (P.R === 'west' ? P.wall2 : wall));
    if ((o.equip ?? 2) > 0) roofKit(k, x0, x1, z0, z1, top + 0.01, o.equip ?? 2);
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
    k.box(k.P.dark, L + 2 * over + 0.01, 0.016, 0.03, 0, rise - 0.004, 0);
    // fascia boards
    for (const sg of [-1, 1]) k.box(k.P.trim, L + 2 * over, 0.016, 0.008, 0, -over * Math.tan(a) - 0.014, sg * run);
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

/** Wall with pointed (or round) arch openings, lying in the XY plane, centred on z. */
function arcade(k: Kit, m: Mat, x0: number, x1: number, y: number, h: number, z: number, t: number, n: number, aw: number, spring: number, round = false) {
  const outer: P2[] = [
    [x0, y],
    [x1, y],
    [x1, y + h],
    [x0, y + h],
  ];
  const holes: P2[][] = [];
  for (let i = 0; i < n; i++) {
    const xc = x0 + ((x1 - x0) * (i + 0.5)) / n;
    holes.push(round ? roundArchPts(xc, y - 0.0001, aw, spring) : archPts(xc, y - 0.0001, aw, spring, 0.4, 5));
  }
  // holes touching the base edge are not allowed in a shape: lift a hair
  for (const hl of holes) {
    hl[0][1] = y + 0.002;
    hl[1][1] = y + 0.002;
  }
  k.prism(m, outer, t, 0, 0, z, undefined, holes);
}

/** Persian pointed-bulb dome on a drum, or a low Ottoman dome. */
function dome(k: Kit, x: number, y: number, z: number, r: number, kind: 'persian' | 'ottoman' | 'hemi' | 'observatory') {
  const P = k.P;
  if (kind === 'persian') {
    const dh = r * 0.5;
    k.cyl(P.wall, r * 1.02, dh, x, y, z, 24);
    const band = new THREE.CylinderGeometry(r * 1.035, r * 1.035, dh * 0.4, 24, 1, true);
    scaleUV(band, 8, 1);
    band.translate(x, y + dh * 0.55, z);
    k.add(band, P.tile, 0);
    k.cyl(P.trim, r * 1.06, 0.015, x, y + dh, z, 24);
    const pts: P2[] = [
      [r * 1.0, 0],
      [r * 1.07, r * 0.22],
      [r * 1.05, r * 0.46],
      [r * 0.92, r * 0.76],
      [r * 0.66, r * 1.05],
      [r * 0.34, r * 1.3],
      [r * 0.08, r * 1.48],
      [0.001, r * 1.56],
    ];
    const g = new THREE.LatheGeometry(
      pts.map(([a, b]) => new THREE.Vector2(a, b)),
      28,
    );
    scaleUV(g, 10, 4);
    g.translate(x, y + dh + 0.015, z);
    k.add(g, P.dome, 0);
    k.cyl(P.mats.col(0xd8b04a, 0.3, 0.8), 0.006, r * 0.35, x, y + dh + r * 1.5, z, 6);
    k.sph(P.mats.col(0xd8b04a, 0.3, 0.8), 0.014, x, y + dh + r * 1.62, z, 8, 6);
  } else if (kind === 'ottoman') {
    const dh = r * 0.35;
    k.cyl(P.wall2, r * 1.02, dh, x, y, z, 24);
    k.cyl(P.trim, r * 1.06, 0.012, x, y + dh, z, 24);
    const g = new THREE.SphereGeometry(r, 28, 8, 0, TAU, 0, Math.PI / 2);
    g.scale(1, 0.8, 1);
    scaleUV(g, 12, 3);
    g.translate(x, y + dh + 0.012, z);
    k.add(g, P.dome, 0);
    k.cyl(P.mats.col(0xd8b04a, 0.3, 0.8), 0.005, r * 0.4, x, y + dh + r * 0.78, z, 6);
    k.sph(P.mats.col(0xd8b04a, 0.3, 0.8), 0.012, x, y + dh + r * 1.0, z, 8, 6);
  } else if (kind === 'observatory') {
    k.cyl(P.wall, r, r * 0.3, x, y, z, 24);
    k.dome(P.dome, r * 0.98, x, y + r * 0.3, z, 28, 10);
    k.box(P.team, r * 0.36, r * 1.1, r * 0.06, x, y + r * 0.3, z + r * 0.3);
    k.box(P.dark, r * 0.3, r * 0.95, 0.01, x, y + r * 0.32, z + r * 0.85);
  } else {
    k.dome(P.dome, r, x, y, z, 28, 10);
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

function container(k: Kit, x: number, y: number, z: number, ry: number, tint: number, L = 0.4) {
  const P = k.P;
  const m = P.T.corr(tint, 6);
  const H = 0.16;
  const Wd = 0.155;
  k.at(x, y, z, ry, () => {
    k.box(m, L, H, Wd, 0, 0, 0);
    // door end + frame rails + corner castings
    k.box(P.mats.col(shade(tint, 0.75), 0.6, 0.3), 0.006, H - 0.01, Wd - 0.01, L / 2 + 0.003, 0.005, 0);
    for (const zz of [-0.025, 0.025]) k.box(P.steel, 0.008, H - 0.02, 0.004, L / 2 + 0.007, 0.01, zz);
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        k.box(P.dark, 0.014, H, 0.014, sx * (L / 2 - 0.007), 0, sz * (Wd / 2 - 0.007));
      }
    k.box(P.dark, L, 0.01, 0.008, 0, H - 0.01, Wd / 2 - 0.002);
    k.box(P.dark, L, 0.01, 0.008, 0, 0, Wd / 2 - 0.002);
  });
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

/** HESCO style barrier (wire mesh baskets filled with soil). */
function hesco(k: Kit, a: P2, b: P2, h = 0.12) {
  const P = k.P;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ry = -Math.atan2(b[1] - a[1], b[0] - a[0]);
  k.at((a[0] + b[0]) / 2, 0, (a[1] + b[1]) / 2, ry, () => {
    const n = Math.max(1, Math.round(len / 0.1));
    for (let i = 0; i < n; i++) {
      const xx = -len / 2 + (len * (i + 0.5)) / n;
      k.box(P.mats.tex('canvas', { color: 0x6b6a4a, seed: 23, grime: 0.4, size: 256 }, 0xd8c8a0, 6), len / n - 0.004, h, 0.1, xx, 0, 0);
      k.box(P.soil, len / n - 0.012, 0.004, 0.09, xx, h, 0);
      for (const sz of [-1, 1]) k.box(P.galv, len / n - 0.002, 0.004, 0.003, xx, h - 0.004, sz * 0.05);
    }
  });
}

function shrub(k: Kit, x: number, y: number, z: number, r = 0.04) {
  const g = new THREE.IcosahedronGeometry(r, 1);
  g.scale(1, 0.8, 1);
  g.translate(x, y + r * 0.7, z);
  k.add(g, k.P.green, 0);
}

function tree(k: Kit, x: number, z: number, h = 0.3, y = 0) {
  const P = k.P;
  k.cyl(P.mats.col(0x5a4632, 0.9, 0), 0.008, h * 0.5, x, y, z, 6, 0.006);
  shrub(k, x, y + h * 0.4, z, h * 0.28);
  shrub(k, x + 0.03, y + h * 0.55, z - 0.02, h * 0.2);
}

function palm(k: Kit, x: number, z: number, h = 0.4, y = 0) {
  const P = k.P;
  const trunk = P.mats.col(0x7a6448, 0.95, 0);
  const lean = 0.04;
  k.tube(trunk, [x, y, z], [x + lean * 0.5, y + h * 0.5, z], 0.012, 6, 0.016);
  k.tube(trunk, [x + lean * 0.5, y + h * 0.5, z], [x + lean, y + h, z], 0.01, 6, 0.012);
  const leaf = P.mats.col(0x4c7a2e, 0.85, 0, true);
  const n = 8;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + 0.3;
    const L = h * 0.42;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    const pts: V3[] = [
      [0, 0, 0],
      [cx * L * 0.5, L * 0.18, cz * L * 0.5],
      [cx * L, -L * 0.15, cz * L],
    ];
    const px = -cz * 0.03;
    const pz = cx * 0.03;
    k.at(x + lean, y + h, z, 0, () => {
      for (let j = 0; j < 2; j++) {
        const [a0, a1] = [pts[j], pts[j + 1]];
        const w0 = j === 0 ? 0.6 : 1;
        const w1 = j === 0 ? 1 : 0.1;
        k.quad(leaf, [a0[0] - px * w0, a0[1], a0[2] - pz * w0], [a0[0] + px * w0, a0[1], a0[2] + pz * w0], [a1[0] + px * w1, a1[1], a1[2] + pz * w1], [a1[0] - px * w1, a1[1], a1[2] - pz * w1]);
      }
    });
  }
}

function planter(k: Kit, x: number, z: number, w: number, d: number, kind: 'shrub' | 'palm' | 'tree' = 'shrub', y = 0) {
  const P = k.P;
  k.box(P.R === 'mideast' ? P.wall2 : P.concrete, w, 0.05, d, x, y, z);
  k.box(P.soil, w - 0.02, 0.004, d - 0.02, x, y + 0.05, z);
  if (kind === 'palm') palm(k, x, z, 0.42, y + 0.05);
  else if (kind === 'tree') tree(k, x, z, 0.32, y + 0.05);
  else {
    const n = Math.max(1, Math.round(Math.max(w, d) / 0.07));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      shrub(k, w > d ? x - w / 2 + w * t : x, y + 0.05, w > d ? z : z - d / 2 + d * t, 0.03 + k.rnd() * 0.012);
    }
  }
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

/** Barrier boom gate. */
function boomGate(k: Kit, x: number, z: number, len: number, ry = 0) {
  const P = k.P;
  k.at(x, 0, z, ry, () => {
    k.box(P.dark, 0.04, 0.08, 0.04, 0, 0, 0);
    k.box(P.red, len, 0.012, 0.012, len / 2, 0.07, 0);
    for (let i = 0; i < 4; i++) k.box(P.white, len / 9, 0.013, 0.013, len * (0.2 + i * 0.22), 0.07, 0);
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

/** Stencilled number / text decal on a wall (alpha tested). */
function stencil(k: Kit, text: string, face: Face, sign: number, c: number, y: number, at: number, w: number, color = '#f0eee6') {
  const m = k.P.mats.canvas('st' + text + color, texStencil(text, color), { alphaTest: 0.5, rough: 0.8 });
  k.panel(m, face, sign, c, y, at + sign * 0.005, w, w / 2);
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

function buildTpl(key: string, s: ModelStyle, fog: FogOfWar | null, w: number, d: number, fn: (k: Kit) => void): Tpl {
  const P = makePal(s, fog);
  const k = new Kit(P, strHash(key + ':' + s.faction));
  fn(k);
  k.finish();
  k.root.name = 'building:' + key;
  return {
    root: k.root,
    specs: k.specs,
    glow: [...P.mats.glow],
    flags: P.mats.flags,
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
  const anim = (s: AnimState) => {
    const pw = s.powered;
    const f = pw ? 1 : 0.22;
    for (const g of glow) g.emissiveIntensity = (g.userData.baseEI as number) * f;
    for (const fm of flags) (fm.userData.uTime as { value: number }).value = s.time;
    bfx.update(s);
    if (s.built < 1) return;
    const t0 = s.time;
    const dmg = s.damage;
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
function vault(k: Kit, m: Mat, endM: Mat | null, cx: number, y: number, cz: number, span: number, len: number, rise: number, alongX = false, uvs = 4) {
  const r = span / 2;
  k.at(cx, y, cz, alongX ? Math.PI / 2 : 0, () => {
    const g = new THREE.CylinderGeometry(r, r, len, 22, 1, true, -Math.PI / 2, Math.PI);
    g.rotateX(-Math.PI / 2);
    g.scale(1, rise / r, 1);
    // UVs: u around the arch, v along the axis -> ribs run along the slope
    scaleUV(g, (Math.PI * r + rise) * uvs, len * uvs);
    k.add(g, m, 0);
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

/** Steel frame of a building under construction. */
function steelFrame(k: Kit, x0: number, x1: number, z0: number, z1: number, levels: number, lh: number) {
  const P = k.P;
  const m = P.mats.col(0x8a3b26, 0.6, 0.4); // red oxide primer
  const nx = 3;
  const nz = 2;
  for (let i = 0; i <= nx; i++)
    for (let j = 0; j <= nz; j++) {
      const x = x0 + ((x1 - x0) * i) / nx;
      const z = z0 + ((z1 - z0) * j) / nz;
      const top = i === nx && j === 0 ? levels - 1 : levels;
      k.box(m, 0.022, lh * top, 0.022, x, Y0, z);
      k.box(P.concrete, 0.05, 0.015, 0.05, x, Y0, z);
    }
  for (let l = 1; l <= levels; l++) {
    const y = Y0 + l * lh - 0.02;
    for (let j = 0; j <= nz; j++) {
      const z = z0 + ((z1 - z0) * j) / nz;
      k.box(m, x1 - x0, 0.02, 0.016, (x0 + x1) / 2, y, z);
    }
    for (let i = 0; i <= nx; i++) {
      const x = x0 + ((x1 - x0) * i) / nx;
      if (l === levels && i === nx) continue;
      k.box(m, 0.016, 0.02, z1 - z0, x, y, (z0 + z1) / 2);
    }
  }
  // first floor deck (partly poured) + bracing + scaffold
  k.box(P.concrete, (x1 - x0) * 0.67, 0.018, z1 - z0, x0 + (x1 - x0) * 0.335, Y0 + lh, (z0 + z1) / 2);
  k.bar(m, [x1, Y0, z1], [x1, Y0 + lh, (z0 + z1) / 2], 0.01);
  k.bar(m, [x0, Y0, z1], [x0 + (x1 - x0) / 3, Y0 + lh, z1], 0.01);
  for (let l = 0; l < levels; l++)
    for (let i = 0; i < 4; i++) {
      const x = x0 + ((x1 - x0) * (i + 0.5)) / 4;
      k.box(P.wood, 0.1, 0.006, 0.05, x, Y0 + l * lh + lh * 0.55, z1 + 0.04, 12);
    }
  for (let i = 0; i <= 4; i++) k.box(P.galv, 0.006, lh * levels, 0.006, x0 + ((x1 - x0) * i) / 4, Y0, z1 + 0.065);
}

/** Tower crane with slewing jib, trolley and hanging load (animated). */
function towerCrane(k: Kit, x: number, z: number, H: number, jib: number, cj: number, ang: number) {
  const P = k.P;
  const cm = P.crane;
  k.box(P.concrete, 0.3, 0.05, 0.3, x, Y0, z);
  k.box(P.dark, 0.16, 0.03, 0.16, x, Y0 + 0.05, z);
  lattice(k, cm, x, z, Y0 + 0.08, H - Y0 - 0.08, 0.13, 0.13, Math.round(H / 0.13), 0.008);
  ladder(k, 'z', 1, x - 0.03, Y0 + 0.08, H - 0.05, z + 0.065);
  const sl = k.node('slew', x, H, z, ang);
  k.on(sl, () => {
    k.cyl(P.dark, 0.085, 0.035, 0, 0, 0, 14);
    k.box(cm, 0.16, 0.05, 0.16, 0, 0.035, 0);
    // operator cab
    k.rbox(P.white, 0.085, 0.085, 0.075, 0.07, 0.0, 0.12, 0.01);
    k.panel(P.glass, 'x', 1, 0.12, 0.03, 0.1135, 0.06, 0.045);
    k.panel(P.glass, 'z', 1, 0.07, 0.03, 0.1585, 0.07, 0.045);
    k.box(P.team, 0.087, 0.016, 0.077, 0.07, 0.07, 0.12);
    // tower head
    const ap: V3 = [0, 0.5, 0];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.bar(cm, [sx * 0.06, 0.085, sz * 0.06], ap, 0.012);
    k.bar(cm, [-0.06, 0.25, 0], [0.06, 0.25, 0], 0.008);
    k.sph(P.red_l, 0.012, 0, 0.51, 0, 6, 4);
    // jib (triangular lattice)
    const seg = 0.1;
    const n = Math.round(jib / seg);
    const yb = 0.09;
    const ht = 0.085;
    const zz = 0.045;
    for (let i = 0; i < n; i++) {
      const xa = 0.08 + i * seg;
      const xb = xa + seg;
      const xm = xa + seg / 2;
      const taper = 1 - (i / n) * 0.35;
      const tb = 1 - ((i + 1) / n) * 0.35;
      for (const s of [-1, 1]) {
        k.bar(cm, [xa, yb, s * zz * taper], [xb, yb, s * zz * tb], 0.008);
        k.bar(cm, [xa, yb, s * zz * taper], [xm, yb + ht * taper, 0], 0.005);
        k.bar(cm, [xm, yb + ht * taper, 0], [xb, yb, s * zz * tb], 0.005);
      }
      k.bar(cm, [xa, yb + ht * taper, 0], [xb, yb + ht * tb, 0], 0.008);
      k.bar(cm, [xa, yb, -zz * taper], [xa, yb, zz * taper], 0.004);
    }
    // counter jib with walkway, winch and counterweights
    k.box(cm, cj, 0.02, 0.012, -cj / 2 - 0.06, yb, 0.05);
    k.box(cm, cj, 0.02, 0.012, -cj / 2 - 0.06, yb, -0.05);
    k.box(P.grating, cj, 0.006, 0.09, -cj / 2 - 0.06, yb + 0.02, 0);
    railing(k, [[-0.08, 0.055], [-cj - 0.04, 0.055]], yb + 0.026, 0.05, P.galv);
    k.box(P.dark, 0.1, 0.06, 0.07, -cj * 0.45, yb + 0.026, 0);
    k.box(P.team, 0.101, 0.015, 0.071, -cj * 0.45, yb + 0.06, 0);
    for (let i = 0; i < 3; i++) k.box(P.concrete, 0.04, 0.11, 0.12, -cj + 0.015 - i * 0.043, yb - 0.07, 0, 6);
    // pendant ties
    k.tube(P.dark, ap, [jib * 0.55, yb + ht * 0.8, 0], 0.003, 4);
    k.tube(P.dark, ap, [-cj + 0.02, yb + 0.03, 0], 0.003, 4);
    // trolley + hook + load
    const tr = k.node('trolley', jib * 0.62, yb, 0);
    k.on(tr, () => {
      k.box(P.dark, 0.06, 0.02, 0.08, 0, -0.02, 0);
      const drop = H - 0.55;
      k.tube(P.dark, [0, -0.02, -0.01], [0, -drop, -0.01], 0.0025, 3);
      k.tube(P.dark, [0, -0.02, 0.01], [0, -drop, 0.01], 0.0025, 3);
      k.box(P.yellow, 0.03, 0.04, 0.03, 0, -drop - 0.04, 0);
      k.tube(P.dark, [0, -drop - 0.04, 0], [-0.09, -drop - 0.12, 0], 0.002, 3);
      k.tube(P.dark, [0, -drop - 0.04, 0], [0.09, -drop - 0.12, 0], 0.002, 3);
      // steel beam bundle
      k.box(P.mats.col(0x8a3b26, 0.6, 0.4), 0.26, 0.025, 0.05, 0, -drop - 0.15, 0);
    });
  });
  k.osc('slew', 'y', 0.55, 0.11, 0, 0);
  k.specs.push({ k: 'slide', n: 'trolley', ax: 'x', a: jib * 0.22, f: 0.19, p: 1.2, b: 0 });
}

// ================================================================ CONSTRUCTION YARD (3x3)

function conyard(k: Kit) {
  const P = k.P;
  const R = P.R;
  slab(k, 3, 3);
  // yard surface + markings
  k.box(P.asphalt, 1.9, 0.004, 1.5, 0.45, Y0, 0.7);
  dashes(k, P.yellow, -0.45, -0.02, 1.38, -0.02, 0.1, 0.05, 0.014, Y0 + 0.004);
  dashes(k, P.yellow, -0.45, 1.42, 1.38, 1.42, 0.1, 0.05, 0.014, Y0 + 0.004);
  for (let i = 0; i < 4; i++) k.box(P.white, 0.012, 0.002, 0.3, 0.75 + i * 0.16, Y0 + 0.004, 1.2);

  // ---------------------------------------------------------- HQ (back left)
  const hx0 = -1.42;
  const hx1 = -0.12;
  const hz0 = -1.42;
  const hz1 = -0.52;
  if (R === 'west') {
    const top = block(k, { x0: hx0, x1: hx1 - 0.36, z0: hz0, z1: hz1, h: 0.5, door: -0.95, equip: 2 });
    // glass curtain corner tower
    k.box(P.base, 0.37, 0.03, 0.62, hx1 - 0.18, Y0, hz1 - 0.3);
    k.box(P.wall2, 0.36, 0.66, 0.6, hx1 - 0.18, Y0, hz1 - 0.3);
    curtain(k, 'z', 1, hx1 - 0.34, hx1 - 0.02, Y0 + 0.03, Y0 + 0.62, hz1, 0.08, 0.11);
    curtain(k, 'x', 1, hz1 - 0.58, hz1 - 0.02, Y0 + 0.03, Y0 + 0.62, hx1, 0.08, 0.11);
    k.box(P.team, 0.37, 0.025, 0.61, hx1 - 0.18, Y0 + 0.62, hz1 - 0.3);
    flatRoof(k, hx1 - 0.36, hx1, hz1 - 0.6, hz1, Y0 + 0.66, 0.03, P.wall2);
    satDish(k, hx1 - 0.18, Y0 + 0.67, hz1 - 0.3, 0.08, 0.8, 0.7);
    antenna(k, hx0 + 0.12, top - 0.04, hz0 + 0.15, 0.4);
    // entrance canopy
    k.box(P.trim, 0.32, 0.015, 0.14, -0.95, Y0 + 0.23, hz1 + 0.07);
    k.box(P.team, 0.32, 0.03, 0.01, -0.95, Y0 + 0.215, hz1 + 0.14);
    for (const sx of [-1, 1]) k.cyl(P.galv, 0.006, 0.23, -0.95 + sx * 0.14, Y0, hz1 + 0.13, 6);
  } else if (R === 'east') {
    block(k, { x0: hx0, x1: hx1 - 0.3, z0: hz0, z1: hz1, h: 0.5, door: -1.0, equip: 3 });
    // stair tower with vertical glazing and painted number
    k.box(P.base, 0.31, 0.03, 0.4, hx1 - 0.15, Y0, hz1 - 0.2);
    k.box(P.wallB, 0.3, 0.74, 0.38, hx1 - 0.15, Y0, hz1 - 0.2);
    k.panel(P.win, 'z', 1, hx1 - 0.15, Y0 + 0.08, hz1 + 0.003, 0.08, 0.6, [0.125, 0, 0.25, 1.5]);
    stencil(k, '07', 'x', 1, hz1 - 0.2, Y0 + 0.45, hx1, 0.3);
    k.box(P.team, 0.31, 0.04, 0.39, hx1 - 0.15, Y0 + 0.66, hz1 - 0.2);
    k.box(P.concrete, 0.32, 0.015, 0.4, hx1 - 0.15, Y0 + 0.74, hz1 - 0.2);
    lattice(k, P.dark, hx1 - 0.15, hz1 - 0.25, Y0 + 0.75, 0.55, 0.08, 0.03, 4, 0.005);
    k.sph(P.red_l, 0.012, hx1 - 0.15, Y0 + 1.31, hz1 - 0.25, 6, 4);
    // exposed heating pipe along the front
    k.pipe(P.rust, [[hx0 + 0.05, Y0 + 0.07, hz1 + 0.03], [hx1 - 0.35, Y0 + 0.07, hz1 + 0.03], [hx1 - 0.35, Y0 + 0.07, hz1 + 0.25], [hx1 - 0.35, Y0 + 0.2, hz1 + 0.25]], 0.014, 8);
    k.pipe(P.galv, [[hx0 + 0.05, Y0 + 0.11, hz1 + 0.03], [hx1 - 0.36, Y0 + 0.11, hz1 + 0.03]], 0.008, 6);
  } else if (R === 'asia') {
    block(k, { x0: hx0, x1: hx1, z0: hz0, z1: hz1, h: 0.48, door: -0.75, roof: 'asian', rise: 0.3 });
    // red/green columned portico with its own small roof
    for (let i = 0; i < 4; i++) k.cyl(P.accent, 0.018, 0.24, -0.95 + i * 0.13, Y0, hz1 + 0.14, 10);
    k.box(P.white, 0.48, 0.02, 0.17, -0.755, Y0, hz1 + 0.085);
    k.box(P.accent, 0.46, 0.03, 0.03, -0.755, Y0 + 0.24, hz1 + 0.14);
    asianRoof(k, P.pitch, ridgeMat(k), -0.755, Y0 + 0.27, hz1 + 0.09, 0.6, 0.24, 0.1, 0.03, P.accent);
    // sign board with team colour
    k.box(P.team, 0.24, 0.06, 0.012, -0.755, Y0 + 0.4, hz1 + 0.007);
  } else {
    const top = block(k, { x0: hx0, x1: hx1, z0: hz0, z1: hz1, h: 0.46, equip: 1 });
    dome(k, -0.78, top - 0.04, -0.98, 0.24, P.s.faction === 'turkey' ? 'ottoman' : 'persian');
    // arcade porch along the front
    arcade(k, P.wall2, hx0 + 0.02, hx1 - 0.02, Y0, 0.25, hz1 + 0.12, 0.03, 6, 0.12, 0.1);
    k.box(P.wall2, hx1 - hx0, 0.025, 0.15, (hx0 + hx1) / 2, Y0 + 0.25, hz1 + 0.06);
    k.box(P.tile, hx1 - hx0 - 0.04, 0.03, 0.004, (hx0 + hx1) / 2, Y0 + 0.2, hz1 + 0.137, 0);
    k.box(P.team, hx1 - hx0, 0.008, 0.01, (hx0 + hx1) / 2, Y0 + 0.262, hz1 + 0.137);
    door(k, 'z', 1, -0.78, Y0, hz1, 0.12, 0.19, false);
  }

  // ---------------------------------------------------------- fabrication hall (back right)
  const fx0 = 0.02;
  const fx1 = 0.92;
  const fz0 = -1.42;
  const fz1 = -0.4;
  const fcx = (fx0 + fx1) / 2;
  const fcz = (fz0 + fz1) / 2;
  const FW = fx1 - fx0;
  const FD = fz1 - fz0;
  if (R === 'east') {
    k.box(P.brick, FW, 0.12, FD, fcx, Y0, fcz);
    k.box(P.corrRust, FW, 0.32, FD, fcx, Y0 + 0.12, fcz);
    gable(k, P.pitch, P.corrRust, fcx, Y0 + 0.44, fcz, FW, FD, 0.2, 0.03, false);
    // painted double gate with a star
    const gw = 0.42;
    for (const s of [-1, 1]) {
      k.box(P.accent, gw / 2 - 0.006, 0.34, 0.012, fcx + (s * gw) / 4, Y0, fz1 + 0.006);
      k.box(P.dark, 0.008, 0.34, 0.016, fcx + (s * gw) / 2, Y0, fz1 + 0.008);
    }
    const star = regular(10, 0.06, Math.PI / 2).map(([a, b], i) => [a * (i % 2 ? 0.42 : 1), b * (i % 2 ? 0.42 : 1)] as P2);
    k.prism(P.red, star, 0.006, fcx, Y0 + 0.2, fz1 + 0.014);
    k.box(P.team, gw + 0.04, 0.03, 0.02, fcx, Y0 + 0.34, fz1 + 0.01);
    punched(k, 'x', 1, fz0 + 0.1, fz1 - 0.1, 5, Y0 + 0.24, fx1, 0.08, 0.1);
    k.box(P.brick, 0.08, 0.95, 0.08, fx0 + 0.15, Y0, fz0 + 0.15);
    k.emit(fx0 + 0.15, Y0 + 1.0, fz0 + 0.15, 'smoke');
  } else {
    const wallM = R === 'west' ? P.wall2 : R === 'asia' ? P.wall2 : P.wall;
    k.box(P.base, FW + 0.012, 0.03, FD + 0.012, fcx, Y0, fcz);
    k.box(wallM, FW, 0.42, FD, fcx, Y0, fcz);
    const roofM = R === 'west' ? P.T.corr(0x9aa3a8) : R === 'asia' ? P.T.corr(0x5f86b8) : P.T.sandstone(0xe8dcc0, 5);
    vault(k, roofM, wallM, fcx, Y0 + 0.42, fcz, FW + 0.03, FD + 0.04, 0.22, false);
    k.box(P.team, FW + 0.01, 0.024, FD + 0.01, fcx, Y0 + 0.38, fcz);
    if (R === 'mideast') {
      // pointed arch gateway
      const op = archPts(fcx, Y0 + 0.001, 0.36, 0.2, 0.4, 6);
      k.prism(P.wall2, [[fx0, Y0], [fx1, Y0], [fx1, Y0 + 0.42], [fx0, Y0 + 0.42]], 0.04, 0, 0, fz1 + 0.02, undefined, [op]);
      k.prism(P.door, op.map(([a, b]) => [a, b] as P2), 0.01, 0, 0, fz1 - 0.01);
      k.box(P.tile, 0.5, 0.04, 0.004, fcx, Y0 + 0.36, fz1 + 0.042, 0);
      k.box(P.team, 0.06, 0.06, 0.006, fcx, Y0 + 0.3, fz1 + 0.042);
    } else {
      rollDoor(k, 'z', 1, fcx - 0.08, Y0, fz1, 0.44, 0.3, 0.3);
      ribbon(k, 'x', 1, fz0 + 0.06, fz1 - 0.06, Y0 + 0.27, fx1, 0.08, R === 'asia');
      door(k, 'z', 1, fx1 - 0.12, Y0, fz1, 0.09, 0.17, false);
    }
  }

  // ---------------------------------------------------------- tower crane (behind the hall, slewing over the yard)
  const cH = R === 'east' ? 1.95 : 1.85;
  towerCrane(k, 1.2, -1.2, cH, 1.55, 0.5, -2.2);

  // ---------------------------------------------------------- containers + prefab modules (front left)
  const tints: Record<Region, number[]> = {
    west: [0xb8a27a, 0x8a949a, 0x5f6b4a],
    east: [0x8a3a2a, 0x3f5a7a, 0x5f6b4a],
    asia: [0x3a6aa8, 0xd8dcdc, 0xa83a2a],
    mideast: [0xc8b088, 0x8a3a2a, 0xe0dcd0],
  };
  const tc = tints[R];
  container(k, -1.12, Y0, 0.35, 0, tc[0]);
  container(k, -1.12, Y0, 0.52, 0, tc[1]);
  container(k, -1.12, Y0 + 0.16, 0.44, 0, P.s.team);
  container(k, -1.18, Y0, 1.2, Math.PI / 2, tc[2]);
  // prefab office modules
  for (let i = 0; i < 2; i++) {
    const zx = -0.62;
    const zz = 0.9 + i * 0.2;
    k.rbox(P.white, 0.36, 0.15, 0.17, zx, Y0 + 0.02, zz, 0.008);
    k.box(P.dark, 0.36, 0.02, 0.17, zx, Y0, zz);
    punched(k, 'x', 1, zz - 0.06, zz + 0.06, 2, Y0 + 0.08, zx + 0.18, 0.04, 0.05);
    k.box(P.team, 0.362, 0.014, 0.172, zx, Y0 + 0.15, zz);
  }
  door(k, 'z', 1, -0.62, Y0 + 0.02, 1.185, 0.06, 0.12, false);
  hvac(k, -0.62, Y0 + 0.17, 0.9, 0.12, 0.08);
  crate(k, -0.82, Y0, -0.1, 0.09);
  crate(k, -0.72, Y0, -0.12, 0.08, 0.4);
  crate(k, -0.77, Y0 + 0.072, -0.11, 0.07, 0.2);
  barrels(k, -0.9, 0.05, 3, R === 'east' ? 0x4a5a3a : 0x2f5f8a, Y0);

  // ---------------------------------------------------------- steel frame under construction (front right)
  steelFrame(k, 0.35, 1.25, 0.25, 0.75, 2, 0.26);
  // girders on dunnage
  for (let i = 0; i < 3; i++) k.box(P.mats.col(0x8a3b26, 0.6, 0.4), 0.5, 0.02, 0.025, 0.75, Y0 + 0.012 + i * 0.02, 1.05 + i * 0.006);
  k.box(P.wood, 0.03, 0.012, 0.12, 0.55, Y0, 1.06, 12);
  k.box(P.wood, 0.03, 0.012, 0.12, 0.95, Y0, 1.06, 12);

  // ---------------------------------------------------------- perimeter / entrance
  if (R === 'west') {
    jersey(k, 1.2, 1.42, 0.35, 0);
    jersey(k, -0.1, 1.42, 0.35, 0);
    boomGate(k, 0.2, 1.38, 0.5);
    fence(k, [[-1.46, -0.25], [-1.46, 1.46], [-0.4, 1.46]], 0.16, Y0);
  } else if (R === 'east') {
    for (let i = 0; i < 4; i++) {
      const x = -1.35 + i * 0.25;
      k.box(P.concrete, 0.24, 0.16, 0.02, x, Y0, 1.46, 6);
      k.box(P.concrete, 0.03, 0.18, 0.03, x + 0.125, Y0, 1.46);
    }
    guardBooth(k, 0.15, 1.3);
    boomGate(k, 0.25, 1.42, 0.45);
  } else if (R === 'asia') {
    planter(k, -0.2, 1.38, 0.4, 0.1, 'shrub', Y0);
    planter(k, 1.2, 1.38, 0.4, 0.1, 'shrub', Y0);
    planter(k, -1.35, -0.3, 0.1, 0.35, 'tree', Y0);
    boomGate(k, 0.25, 1.38, 0.45);
  } else {
    planter(k, -0.25, 1.36, 0.14, 0.14, 'palm', Y0);
    planter(k, 1.32, 1.36, 0.14, 0.14, 'palm', Y0);
    sandbags(k, [-1.45, 1.44], [-0.45, 1.44], 2, Y0);
  }
  flagPole(k, -1.3, -0.25, 0.75, Y0);
  lightPole(k, 1.38, 0.1, 0.42, Math.PI, Y0);
  lightPole(k, -0.35, 1.3, 0.42, 0, Y0);
  k.height = 1.4;
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

function power(k: Kit) {
  const P = k.P;
  const R = P.R;
  slab(k, 2, 2);
  if (R === 'west') {
    // turbine hall with stacks
    block(k, { x0: -0.95, x1: 0.18, z0: -0.95, z1: -0.12, h: 0.42, wall: P.wall2, win: 'ribbon', equip: 0, floors: 1 });
    rollDoor(k, 'z', 1, -0.55, Y0, -0.12, 0.26, 0.24, 0);
    door(k, 'z', 1, -0.1, Y0, -0.12, 0.1, 0.18);
    stencil(k, 'G1', 'x', 1, -0.55, Y0 + 0.3, 0.18, 0.12, '#1d2a38');
    for (const sx of [-0.78, -0.48]) {
      k.box(P.wall2, 0.22, 0.32, 0.26, sx, Y0 + 0.42, -0.72);
      k.box(P.team, 0.222, 0.025, 0.262, sx, Y0 + 0.66, -0.72);
      k.cyl(P.galv, 0.055, 0.85, sx, Y0 + 0.74, -0.72, 14, 0.05);
      k.cyl(P.dark, 0.056, 0.03, sx, Y0 + 1.56, -0.72, 14);
      k.ring(P.grating, 0.08, 0.012, sx, Y0 + 1.25, -0.72, 14);
      k.emit(sx, Y0 + 1.65, -0.72, 'steam');
    }
    k.blinkLight(-0.78, Y0 + 1.62, -0.72, 0.016, 1.5, 0);
    k.blinkLight(-0.48, Y0 + 1.62, -0.72, 0.016, 1.5, 0.7);
    coolingCells(k, 0.32, 0.95, -0.95, 0.05, 0.3, 2);
    switchyard(k, -0.95, 0.4, 0.2, 0.95, 2);
    pylon(k, 0.72, 0.6, 0.72, 0, 0.3);
    lightPole(k, 0.55, 0.92, 0.38, Math.PI);
    k.height = 1.3;
  } else if (R === 'east') {
    coolingTower(k, 0.43, -0.43, 0.52, 1.18);
    chimney(k, -0.76, -0.76, 1.95, 0.085, 0.06, true);
    k.emit(-0.76, Y0 + 2.05, -0.76, 'smoke');
    // brick turbine hall with pitched roof and tall windows
    const x0 = -0.95;
    const x1 = -0.1;
    const z0 = -0.5;
    const z1 = 0.62;
    k.box(P.base, x1 - x0 + 0.014, 0.03, z1 - z0 + 0.014, (x0 + x1) / 2, Y0, (z0 + z1) / 2);
    k.box(P.wall2, x1 - x0, 0.42, z1 - z0, (x0 + x1) / 2, Y0, (z0 + z1) / 2);
    punched(k, 'x', 1, z0 + 0.05, z1 - 0.05, 5, Y0 + 0.1, x1, 0.1, 0.24, 'round');
    punched(k, 'z', 1, x0 + 0.05, x1 - 0.05, 3, Y0 + 0.1, z1, 0.1, 0.24, 'round', [-0.6, -0.4]);
    door(k, 'z', 1, -0.52, Y0, z1, 0.14, 0.2, true);
    k.box(P.team, x1 - x0 + 0.008, 0.03, z1 - z0 + 0.008, (x0 + x1) / 2, Y0 + 0.39, (z0 + z1) / 2);
    gable(k, P.pitch, P.wall2, (x0 + x1) / 2, Y0 + 0.42, (z0 + z1) / 2, x1 - x0, z1 - z0, 0.22, 0.03, false);
    k.box(P.concrete, 0.3, 0.06, 0.14, (x0 + x1) / 2, Y0 + 0.6, (z0 + z1) / 2 - 0.1);
    // hot water pipes to the tower
    k.pipe(P.rust, [[x1, Y0 + 0.2, -0.3], [0.05, Y0 + 0.2, -0.3], [0.05, Y0 + 0.2, -0.15]], 0.025, 10);
    k.pipe(P.galv, [[x1, Y0 + 0.12, -0.38], [0.0, Y0 + 0.12, -0.38]], 0.018, 8);
    for (const px of [-0.05, 0.02]) k.box(P.concrete, 0.03, 0.12, 0.12, px, Y0, -0.34);
    switchyard(k, 0.05, 0.95, 0.25, 0.95, 1);
    pylon(k, 0.78, 0.45, 0.7, 0, 0.25);
    k.height = 1.4;
  } else if (R === 'asia') {
    // reactor containment building
    const cx = -0.48;
    const cz = -0.46;
    k.cyl(P.base, 0.4, 0.04, cx, Y0, cz, 28);
    k.cyl(P.wall2, 0.37, 0.48, cx, Y0 + 0.04, cz, 28);
    k.dome(P.wall2, 0.37, cx, Y0 + 0.52, cz, 28, 9, 0.7);
    k.cyl(P.team, 0.375, 0.03, cx, Y0 + 0.44, cz, 28);
    k.cyl(P.accent, 0.38, 0.02, cx, Y0 + 0.08, cz, 28);
    for (let i = 0; i < 4; i++) k.box(P.base, 0.02, 0.44, 0.02, cx + Math.cos(i * 0.5 + 0.2) * 0.37, Y0 + 0.04, cz + Math.sin(i * 0.5 + 0.2) * 0.37);
    // vent stack with lattice support
    k.cyl(P.wall, 0.035, 1.55, -0.86, Y0, -0.9, 10);
    lattice(k, P.galv, -0.86, -0.9, Y0, 1.35, 0.2, 0.08, 7, 0.006);
    k.cyl(P.red, 0.037, 0.1, -0.86, Y0 + 1.35, -0.9, 10);
    k.cyl(P.white, 0.037, 0.1, -0.86, Y0 + 1.45, -0.9, 10);
    k.blinkLight(-0.86, Y0 + 1.58, -0.9, 0.016, 1.5, 0);
    // turbine hall with curved roof
    const tx0 = 0.02;
    const tx1 = 0.95;
    const tz0 = -0.95;
    const tz1 = -0.08;
    k.box(P.base, tx1 - tx0 + 0.014, 0.03, tz1 - tz0 + 0.014, (tx0 + tx1) / 2, Y0, (tz0 + tz1) / 2);
    k.box(P.wall, tx1 - tx0, 0.4, tz1 - tz0, (tx0 + tx1) / 2, Y0, (tz0 + tz1) / 2);
    ribbon(k, 'z', 1, tx0 + 0.05, tx1 - 0.05, Y0 + 0.24, tz1, 0.1, true);
    ribbon(k, 'x', 1, tz0 + 0.05, tz1 - 0.05, Y0 + 0.24, tx1, 0.1, true);
    rollDoor(k, 'z', 1, 0.3, Y0, tz1, 0.22, 0.18, 0);
    k.box(P.team, tx1 - tx0 + 0.008, 0.024, tz1 - tz0 + 0.008, (tx0 + tx1) / 2, Y0 + 0.37, (tz0 + tz1) / 2);
    vault(k, P.T.corr(0x5f86b8), P.wall, (tx0 + tx1) / 2, Y0 + 0.4, (tz0 + tz1) / 2, tz1 - tz0 + 0.03, tx1 - tx0 + 0.03, 0.14, true);
    switchyard(k, -0.95, 0.35, 0.22, 0.95, 2);
    pylon(k, 0.72, 0.55, 0.7, 0, 0.25);
    planter(k, 0.7, 0.05, 0.4, 0.09, 'shrub', Y0);
    k.height = 1.3;
  } else {
    // solar power tower with heliostat field
    const tx = -0.62;
    const tz = -0.62;
    k.box(P.base, 0.34, 0.05, 0.34, tx, Y0, tz);
    k.at(tx, Y0 + 0.05, tz, Math.PI / 4, () => k.cyl(P.concrete, 0.15, 1.3, 0, 0, 0, 4, 0.09, false, 2.5));
    // square solar receiver (white hot) with a steel crown
    k.box(P.steel, 0.2, 0.03, 0.2, tx, Y0 + 1.27, tz);
    k.box(P.mats.light(0xfff2c8, 4.2), 0.17, 0.24, 0.17, tx, Y0 + 1.3, tz);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) k.box(P.steel, 0.02, 0.26, 0.02, tx + sx * 0.088, Y0 + 1.29, tz + sz * 0.088);
    k.box(P.steel, 0.2, 0.04, 0.2, tx, Y0 + 1.55, tz);
    lattice(k, P.galv, tx, tz, Y0 + 1.59, 0.14, 0.12, 0.04, 2, 0.006);
    k.cyl(P.team, 0.13, 0.05, tx, Y0 + 1.0, tz, 4, 0.125);
    ladder(k, 'x', 1, tz, Y0 + 0.05, Y0 + 1.25, tx + 0.09);
    k.blinkLight(tx, Y0 + 1.75, tz, 0.016, 1.5, 0);
    const mirror = P.mats.col(0xbcd6ee, 0.3, 0.3);
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 4; j++) {
        const hx = -0.82 + i * 0.4 + (j % 2) * 0.08;
        const hz = 0.1 + j * 0.25;
        if (hx > 0.9) continue;
        const ry = Math.atan2(tx - hx, tz - hz);
        k.cyl(P.galv, 0.008, 0.09, hx, Y0, hz, 6);
        k.at(hx, Y0 + 0.1, hz, ry, () => {
          k.box(P.dark, 0.2, 0.01, 0.14, 0, -0.008, 0);
          k.box(mirror, 0.195, 0.004, 0.135, 0, 0.002, 0);
        }, 0.55);
      }
    for (let i = 0; i < 2; i++) {
        const hx = 0.2 + i * 0.25;
        const hz = -0.25;
        const ry = Math.atan2(tx - hx, tz - hz);
        k.cyl(P.galv, 0.008, 0.09, hx, Y0, hz, 6);
        k.at(hx, Y0 + 0.1, hz, ry, () => {
          k.box(P.dark, 0.16, 0.01, 0.11, 0, -0.008, 0);
          k.box(mirror, 0.155, 0.004, 0.105, 0, 0.002, 0);
        }, 0.55);
      }
    // power block
    const top = block(k, { x0: 0.1, x1: 0.95, z0: -0.95, z1: -0.45, h: 0.34, floors: 1, equip: 1 });
    k.cyl(P.wall2, 0.04, 0.45, 0.82, top - 0.03, -0.82, 10);
    k.emit(0.82, top + 0.47, -0.82, 'steam');
    transformer(k, -0.15, Y0, -0.62, Math.PI / 2, 1.1);
    planter(k, -0.85, -0.1, 0.12, 0.12, 'palm', Y0);
    k.height = 1.4;
  }
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
  const m = k.P.mats.tex('soil', { color: 0xc89a3a, seed: 28, size: 256 }, 0xffffff, 6);
  k.lathe(m, [[r, 0], [r * 0.75, h * 0.45], [r * 0.4, h * 0.85], [0.001, h]], x, Y0, z, 12);
}

function refinery(k: Kit) {
  const P = k.P;
  const R = P.R;
  slab(k, 3, 3, Y0, [-0.52, 0.52, 0.52]);
  // ------------------------------------------------ harvester dock pad (front centre tile, flat)
  k.box(P.T.concrete(0x9a9890, 2), 1.02, 0.008, 1.0, 0, 0, 1.0);
  k.box(P.hazard, 0.05, 0.004, 0.96, -0.47, 0.008, 1.0, 9);
  k.box(P.hazard, 0.05, 0.004, 0.96, 0.47, 0.008, 1.0, 9);
  k.box(P.hazard, 0.9, 0.004, 0.05, 0, 0.008, 0.545, 9);
  k.box(P.yellow, 0.022, 0.003, 0.7, -0.18, 0.008, 1.05);
  k.box(P.yellow, 0.022, 0.003, 0.7, 0.18, 0.008, 1.05);
  for (let i = 0; i < 3; i++) {
    const zz = 1.2 - i * 0.16;
    k.at(-0.05, 0.008, zz, -0.6, () => k.box(P.white, 0.12, 0.003, 0.02, 0, 0, 0));
    k.at(0.05, 0.008, zz, 0.6, () => k.box(P.white, 0.12, 0.003, 0.02, 0, 0, 0));
  }
  k.box(P.team, 0.5, 0.003, 0.03, 0, 0.008, 0.62);
  // ------------------------------------------------ ore intake hopper behind the pad
  const hz = 0.3;
  k.box(P.concrete, 0.94, 0.08, 0.04, 0, Y0, hz - 0.2);
  k.box(P.concrete, 0.04, 0.08, 0.38, -0.45, Y0, hz);
  k.box(P.concrete, 0.04, 0.08, 0.38, 0.45, Y0, hz);
  k.box(P.black, 0.86, 0.01, 0.36, 0, Y0 + 0.02, hz);
  k.box(P.grating, 0.86, 0.006, 0.36, 0, Y0 + 0.05, hz, 8);
  // steel hopper funnel with team stripe
  k.at(0, Y0 + 0.08, hz - 0.1, Math.PI / 2, () =>
    k.prism(P.steel, [[-0.1, 0], [0.12, 0], [0.18, 0.2], [-0.18, 0.2]], 0.7),
  );
  k.box(P.team, 0.72, 0.03, 0.01, 0, Y0 + 0.22, hz + 0.08);
  k.box(P.hazard, 0.72, 0.02, 0.012, 0, Y0 + 0.26, hz + 0.075);
  // inclined conveyor gallery up into the plant
  const c0: V3 = [0, Y0 + 0.24, hz - 0.12];
  const c1: V3 = [0, Y0 + 0.7, -0.5];
  const len = Math.hypot(c1[1] - c0[1], c1[2] - c0[2]);
  const ang = Math.atan2(c1[1] - c0[1], -(c1[2] - c0[2]));
  k.at(0, (c0[1] + c1[1]) / 2, (c0[2] + c1[2]) / 2, 0, () => {
    k.local(() => k.box(R === 'east' ? P.corrRust : P.corr, 0.16, 0.1, len, 0, -0.05, 0));
    k.box(P.team, 0.165, 0.016, len, 0, 0.03, 0);
    k.box(P.steel, 0.18, 0.012, len, 0, -0.06, 0);
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
  if (R === 'east') {
    k.box(P.base, px1 - px0 + 0.014, 0.03, pz1 - pz0 + 0.014, 0, Y0, (pz0 + pz1) / 2);
    k.box(P.wall2, px1 - px0, 0.6, pz1 - pz0, 0, Y0, (pz0 + pz1) / 2);
    punched(k, 'z', 1, px0, px1, 6, Y0 + 0.12, pz1, 0.09, 0.3, 'round', [-0.1, 0.1]);
    punched(k, 'x', 1, pz0, pz1, 5, Y0 + 0.12, px1, 0.09, 0.3, 'round');
    k.box(P.team, px1 - px0 + 0.008, 0.03, pz1 - pz0 + 0.008, 0, Y0 + 0.55, (pz0 + pz1) / 2);
    gable(k, P.pitch, P.wall2, 0, Y0 + 0.6, (pz0 + pz1) / 2, px1 - px0, pz1 - pz0, 0.26, 0.03, true);
    k.box(P.corrRust, 0.3, 0.14, 0.2, 0.0, Y0 + 0.78, (pz0 + pz1) / 2, 4);
    chimney(k, -0.45, -1.25, 1.6, 0.07, 0.05, false, Y0);
    k.emit(-0.45, Y0 + 1.7, -1.25, 'smoke');
    stencil(k, '3', 'x', 1, -0.75, Y0 + 0.75, px1, 0.18);
  } else {
    const top = block(k, { x0: px0, x1: px1, z0: pz0, z1: pz1, h: 0.66, floors: 3, wall: R === 'west' ? P.wall2 : P.wall, equip: 2 });
    // smelter / kiln tower on top
    const sm = R === 'mideast' ? P.wall2 : R === 'asia' ? P.wall : P.wallB;
    k.box(sm, 0.4, 0.3, 0.36, -0.3, top - 0.03, -1.15);
    k.box(P.team, 0.402, 0.03, 0.362, -0.3, top + 0.22, -1.15);
    k.cyl(R === 'asia' ? P.white : P.concrete, 0.06, 0.6, -0.36, top + 0.27, -1.2, 12, 0.05);
    if (R === 'asia') k.cyl(P.red, 0.052, 0.1, -0.36, top + 0.77, -1.2, 12);
    k.emit(-0.36, top + 0.95, -1.2, 'smoke');
    k.blinkLight(-0.36, top + 0.9, -1.2, 0.014, 1.4, 0.3);
  }
  // ------------------------------------------------ left: silos / storage
  if (R === 'west') {
    for (let i = 0; i < 3; i++) silo(k, -1.12, -1.2 + i * 0.34, 0.15, 0.78, P.tank, 'cone');
    k.box(P.grating, 0.06, 0.012, 0.75, -1.12, Y0 + 0.92, -0.86);
    railing(k, [[-1.15, -1.23], [-1.15, -0.5]], Y0 + 0.93, 0.05);
    ladder(k, 'x', 1, -0.86, Y0, Y0 + 0.8, -0.97);
  } else if (R === 'east') {
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) silo(k, -1.25 + i * 0.3, -1.25 + j * 0.3, 0.145, 1.05, P.wall, 'flat');
    k.box(P.wallB, 0.5, 0.18, 0.5, -1.1, Y0 + 1.07, -1.1);
    punched(k, 'z', 1, -1.3, -0.9, 3, Y0 + 1.13, -0.85, 0.06, 0.06);
    k.box(P.concrete, 0.52, 0.015, 0.52, -1.1, Y0 + 1.25, -1.1);
    // conveyor bridge to the plant roof
    k.at(-0.75, Y0 + 1.0, -1.0, 0, () => k.box(P.corrRust, 0.36, 0.08, 0.1, 0, 0, 0), 0, -0.25);
    oreHeap(k, -1.1, -0.35, 0.28, 0.22);
  } else if (R === 'asia') {
    for (let i = 0; i < 2; i++) {
      const x = -1.08;
      const z = -1.12 + i * 0.52;
      for (let a = 0; a < 6; a++) k.box(P.steel, 0.018, 0.22, 0.018, x + Math.cos((a / 6) * TAU) * 0.17, Y0, z + Math.sin((a / 6) * TAU) * 0.17);
      k.sph(P.tank, 0.23, x, Y0 + 0.4, z, 20, 14);
      k.ring(P.team, 0.232, 0.012, x, Y0 + 0.4, z, 24);
      stairs(k, x + 0.28, z, Y0, Y0 + 0.5, false, -1, 0.05);
    }
  } else {
    for (let i = 0; i < 3; i++) silo(k, -1.12, -1.22 + i * 0.32, 0.14, 0.62, P.wallB, 'dome');
    oreHeap(k, -1.15, -0.25, 0.22, 0.16);
  }
  // ------------------------------------------------ right: tanks, pipes
  if (R === 'west' || R === 'asia') {
    // pipe rack along z
    const rx = 0.8;
    for (let i = 0; i < 5; i++) {
      const z = -1.3 + i * 0.32;
      k.box(P.steel, 0.02, 0.36, 0.02, rx - 0.08, Y0, z);
      k.box(P.steel, 0.02, 0.36, 0.02, rx + 0.08, Y0, z);
      k.box(P.steel, 0.2, 0.02, 0.025, rx, Y0 + 0.34, z);
      k.box(P.steel, 0.2, 0.02, 0.025, rx, Y0 + 0.22, z);
    }
    const pc = [P.yellow, P.galv, P.mats.col(0x3f6a9a, 0.5, 0.4), P.galv];
    for (let i = 0; i < 4; i++) k.tube(pc[i], [rx - 0.06 + i * 0.04, Y0 + 0.385, -1.36], [rx - 0.06 + i * 0.04, Y0 + 0.385, 0.0], 0.014, 8);
    k.pipe(P.galv, [[px1, Y0 + 0.385, -0.9], [rx - 0.02, Y0 + 0.385, -0.9]], 0.014, 8);
    // horizontal bullet tanks
    for (let i = 0; i < 2; i++) {
      const z = -1.1 + i * 0.5;
      const x = 1.22;
      k.box(P.concrete, 0.05, 0.06, 0.18, x, Y0, z - 0.1);
      k.box(P.concrete, 0.05, 0.06, 0.18, x, Y0, z + 0.1);
      k.at(x, Y0 + 0.14, z, 0, () => {
        k.tube(P.tank, [0, 0, -0.18], [0, 0, 0.18], 0.1, 16);
        k.sph(P.tank, 0.1, 0, 0, -0.18, 16, 8);
        k.sph(P.tank, 0.1, 0, 0, 0.18, 16, 8);
        k.tube(P.team, [0, 0, -0.03], [0, 0, 0.03], 0.102, 16);
      });
    }
  } else if (R === 'east') {
    for (let i = 0; i < 2; i++) {
      const z = -1.05 + i * 0.6;
      silo(k, 1.1, z, 0.24, 0.42, P.T.corrRust(0xb8b0a0, 5), 'flat');
      stencil(k, String(i + 1), 'x', 1, z, Y0 + 0.2, 1.1 + 0.245, 0.14, '#e8e4d8');
    }
    k.pipe(P.rust, [[px1, Y0 + 0.3, -1.05], [0.86, Y0 + 0.3, -1.05]], 0.025, 8);
    k.pipe(P.rust, [[px1, Y0 + 0.2, -0.6], [0.75, Y0 + 0.2, -0.6], [0.75, Y0 + 0.2, -0.45], [0.86, Y0 + 0.2, -0.45]], 0.022, 8);
  } else {
    for (let i = 0; i < 2; i++) silo(k, 1.08, -1.05 + i * 0.6, 0.22, 0.38, P.tank, 'dome');
    k.pipe(P.galv, [[px1, Y0 + 0.25, -1.05], [0.86, Y0 + 0.25, -1.05]], 0.02, 8);
  }
  // ------------------------------------------------ front left: control office
  const ox0 = -1.42;
  const ox1 = -0.72;
  const oz0 = 0.35;
  const oz1 = 1.2;
  if (R === 'asia') block(k, { x0: ox0, x1: ox1, z0: oz0, z1: oz1, h: 0.36, floors: 2, roof: 'asian', rise: 0.18, door: -1.07 });
  else if (R === 'mideast') {
    block(k, { x0: ox0, x1: ox1, z0: oz0, z1: oz1 - 0.1, h: 0.34, floors: 2, equip: 1 });
    arcade(k, P.wall2, ox0, ox1, Y0, 0.2, oz1 - 0.02, 0.03, 4, 0.11, 0.08);
    k.box(P.wall2, ox1 - ox0, 0.02, 0.12, (ox0 + ox1) / 2, Y0 + 0.2, oz1 - 0.06);
    k.box(P.tile, ox1 - ox0 - 0.02, 0.025, 0.004, (ox0 + ox1) / 2, Y0 + 0.16, oz1 - 0.003);
  } else block(k, { x0: ox0, x1: ox1, z0: oz0, z1: oz1, h: 0.34, floors: 2, door: -1.07, equip: 1 });
  // ------------------------------------------------ front right
  if (R === 'east' || R === 'mideast') {
    oreHeap(k, 1.02, 0.95, 0.32, 0.24);
    oreHeap(k, 1.2, 0.45, 0.2, 0.14);
    if (R === 'mideast') planter(k, 0.7, 1.35, 0.12, 0.12, 'palm', Y0);
    else guardBooth(k, 0.75, 1.32, 0);
  } else {
    k.box(P.concrete, 0.66, 0.05, 0.02, 1.05, Y0, 0.55);
    k.box(P.concrete, 0.66, 0.05, 0.02, 1.05, Y0, 1.38);
    k.box(P.concrete, 0.02, 0.05, 0.83, 0.73, Y0, 0.965);
    k.box(P.concrete, 0.02, 0.05, 0.83, 1.37, Y0, 0.965);
    silo(k, 0.9, 0.78, 0.15, 0.4, P.tank, 'cone');
    silo(k, 1.18, 1.12, 0.15, 0.4, P.tank, 'cone');
    if (R === 'asia') planter(k, 0.95, 1.43, 0.6, 0.06, 'shrub', Y0);
  }
  lightPole(k, 0.62, 1.38, 0.42, Math.PI);
  lightPole(k, -0.62, 1.38, 0.42, 0);
  k.height = 1.25;
}

// ================================================================ BARRACKS (2x2)

/** Regional guard / watch tower. */
function watchtower(k: Kit, x: number, z: number) {
  const P = k.P;
  const R = P.R;
  const h = 0.5;
  if (R === 'mideast') {
    k.box(P.wall2, 0.18, h, 0.18, x, Y0, z);
    punched(k, 'z', 1, x - 0.05, x + 0.05, 1, Y0 + h - 0.15, z + 0.09, 0.04, 0.08, 'arch');
    flatRoof(k, x - 0.09, x + 0.09, z - 0.09, z + 0.09, Y0 + h, 0.03, P.wall2);
    k.box(P.team, 0.182, 0.02, 0.182, x, Y0 + h - 0.05, z);
    return;
  }
  if (R === 'asia') {
    k.box(P.wall, 0.16, h - 0.1, 0.16, x, Y0, z);
    k.box(P.accent, 0.164, 0.02, 0.164, x, Y0 + h - 0.12, z);
    k.box(P.mats.col(0x2a3a48, 0.15, 0.8), 0.2, 0.08, 0.2, x, Y0 + h - 0.1, z);
    asianRoof(k, P.pitch, ridgeMat(k), x, Y0 + h - 0.02, z, 0.3, 0.3, 0.09, 0.03, P.accent);
    k.box(P.team, 0.205, 0.015, 0.205, x, Y0 + h - 0.035, z);
    return;
  }
  const leg = R === 'east' ? P.wood : P.galv;
  const s = 0.07;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.bar(leg, [x + sx * s * 1.3, Y0, z + sz * s * 1.3], [x + sx * s, Y0 + h, z + sz * s], 0.018);
  for (const yy of [0.15, 0.32]) {
    k.bar(leg, [x - s * 1.2, Y0 + yy, z + s * 1.2], [x + s * 1.2, Y0 + yy + 0.1, z + s * 1.2], 0.008);
    k.bar(leg, [x + s * 1.2, Y0 + yy, z - s * 1.2], [x + s * 1.2, Y0 + yy + 0.1, z + s * 1.2], 0.008);
  }
  k.box(R === 'east' ? P.wood : P.grating, 0.2, 0.015, 0.2, x, Y0 + h, z);
  if (R === 'east') {
    for (const sx of [-1, 1]) k.box(P.wood, 0.2, 0.06, 0.01, x, Y0 + h + 0.015, z + sx * 0.095);
    for (const sx of [-1, 1]) k.box(P.wood, 0.01, 0.06, 0.2, x + sx * 0.095, Y0 + h + 0.015, z);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(P.wood, 0.012, 0.13, 0.012, x + sx * 0.09, Y0 + h, z + sz * 0.09);
    gable(k, P.corrRust, P.wood, x, Y0 + h + 0.13, z, 0.22, 0.22, 0.07, 0.02, true);
    k.box(P.team, 0.2, 0.02, 0.005, x, Y0 + h + 0.05, z + 0.102);
  } else {
    sandbags(k, [x - 0.09, z + 0.09], [x + 0.09, z + 0.09], 1, Y0 + h + 0.015);
    sandbags(k, [x + 0.09, z - 0.09], [x + 0.09, z + 0.09], 1, Y0 + h + 0.015);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(P.galv, 0.01, 0.14, 0.01, x + sx * 0.09, Y0 + h, z + sz * 0.09);
    k.box(P.mats.col(P.s.hull, 0.7, 0.2), 0.24, 0.015, 0.24, x, Y0 + h + 0.14, z);
    k.box(P.team, 0.242, 0.012, 0.242, x, Y0 + h + 0.13, z);
  }
  k.box(P.dark, 0.03, 0.02, 0.04, x + 0.06, Y0 + h + 0.1, z + 0.06);
  k.box(P.lamp, 0.004, 0.014, 0.03, x + 0.077, Y0 + h + 0.1, z + 0.06);
}

function barracks(k: Kit) {
  const P = k.P;
  const R = P.R;
  slab(k, 2, 2);
  // parade ground (front left)
  const pg = R === 'east' ? P.asphalt : P.T.asphalt(R === 'mideast' ? 0xd8ccb0 : 0xc8c8c8);
  k.box(pg, 0.95, 0.004, 0.8, -0.45, Y0, 0.52);
  for (let i = 0; i < 4; i++) k.box(P.white, 0.012, 0.002, 0.6, -0.8 + i * 0.22, Y0 + 0.004, 0.55);
  k.box(P.white, 0.8, 0.002, 0.012, -0.47, Y0 + 0.004, 0.22);
  k.box(R === 'east' ? P.red : P.team, 0.12, 0.002, 0.12, -0.47, Y0 + 0.004, 0.75);
  flagPole(k, -0.85, 0.2, 0.72, Y0);
  watchtower(k, -0.8, 0.8);
  // main dormitory (back) + wing with entrance (front right)
  const x0 = -0.95;
  const x1 = 0.95;
  const z0 = -0.95;
  const z1 = -0.2;
  const wx0 = 0.2;
  const wx1 = 0.95;
  const wz1 = 0.48;
  if (R === 'west') {
    block(k, { x0, x1, z0, z1, h: 0.46, floors: 2, equip: 3 });
    block(k, { x0: wx0, x1: wx1, z0: z1 - 0.02, z1: wz1, h: 0.26, floors: 1, door: 0.5, equip: 1, wall: P.wallB });
    // entrance canopy
    k.box(P.trim, 0.3, 0.012, 0.12, 0.5, Y0 + 0.22, wz1 + 0.06);
    k.box(P.team, 0.3, 0.025, 0.008, 0.5, Y0 + 0.205, wz1 + 0.12);
    // pull-up / training bars
    for (let i = 0; i < 3; i++) {
      const bx = -0.85 + i * 0.12;
      k.box(P.galv, 0.008, 0.18, 0.008, bx, Y0, 0.0);
    }
    k.bar(P.galv, [-0.85, Y0 + 0.17, 0.0], [-0.61, Y0 + 0.17, 0.0], 0.006);
    jersey(k, 0.15, 0.95, 0.25, Math.PI / 2);
    jersey(k, -0.2, 0.95, 0.25, Math.PI / 2);
    lightPole(k, 0.12, 0.6, 0.38, 0);
  } else if (R === 'east') {
    const zc = (z0 + z1) / 2;
    k.box(P.base, x1 - x0 + 0.014, 0.03, z1 - z0 + 0.014, 0, Y0, zc);
    k.box(P.wall2, x1 - x0, 0.44, z1 - z0, 0, Y0, zc);
    facade(k, 'z', 1, x0, x1, z1, Y0, 0.44, 2, 'punched');
    facade(k, 'x', 1, z0, z1, x1, Y0, 0.44, 2, 'punched');
    k.box(P.concrete, x1 - x0 + 0.012, 0.02, z1 - z0 + 0.012, 0, Y0 + 0.21, zc);
    k.box(P.team, x1 - x0 + 0.01, 0.025, z1 - z0 + 0.01, 0, Y0 + 0.41, zc);
    gable(k, P.pitch, P.wall2, 0, Y0 + 0.44, zc, x1 - x0, z1 - z0, 0.22, 0.035, true);
    k.box(P.brick, 0.06, 0.16, 0.06, -0.5, Y0 + 0.5, zc - 0.12);
    k.box(P.brick, 0.06, 0.16, 0.06, 0.5, Y0 + 0.5, zc - 0.12);
    // entrance wing (single storey, flat)
    block(k, { x0: wx0, x1: wx1, z0: z1, z1: wz1, h: 0.25, floors: 1, door: 0.5, equip: 1, wall: P.wall });
    stencil(k, '12', 'x', 1, 0.15, Y0 + 0.1, wx1, 0.14);
    // painted kerbs + watch post
    for (let i = 0; i < 6; i++) k.box(i % 2 ? P.white : P.black, 0.12, 0.02, 0.025, -0.88 + i * 0.12, Y0, 0.95);
    guardBooth(k, -0.1, 0.85);
  } else if (R === 'asia') {
    block(k, { x0, x1, z0, z1, h: 0.44, floors: 2, roof: 'asian', rise: 0.28 });
    block(k, { x0: wx0, x1: wx1, z0: z1 - 0.02, z1: wz1 - 0.08, h: 0.24, floors: 1, door: 0.5, equip: 0, roof: 'asian', rise: 0.14 });
    for (let i = 0; i < 2; i++) k.cyl(P.accent, 0.016, 0.22, 0.38 + i * 0.24, Y0, wz1 - 0.02, 10);
    k.box(P.white, 0.4, 0.02, 0.12, 0.5, Y0, wz1 - 0.04);
    planter(k, -0.9, 0.2, 0.08, 0.5, 'shrub', Y0);
    planter(k, 0.05, 0.9, 0.2, 0.12, 'tree', Y0);
    lightPole(k, 0.12, 0.55, 0.38, 0);
  } else {
    block(k, { x0, x1, z0, z1, h: 0.46, floors: 2, equip: 2 });
    block(k, { x0: wx0, x1: wx1, z0: z1 - 0.02, z1: wz1 - 0.12, h: 0.24, floors: 1, door: 0.5, equip: 1, win: 'arched' });
    arcade(k, P.wall2, wx0, wx1, Y0, 0.22, wz1 - 0.01, 0.03, 4, 0.11, 0.07);
    k.box(P.wall2, wx1 - wx0, 0.02, 0.15, (wx0 + wx1) / 2, Y0 + 0.22, wz1 - 0.08);
    k.box(P.tile, wx1 - wx0 - 0.02, 0.025, 0.004, (wx0 + wx1) / 2, Y0 + 0.18, wz1 + 0.006);
    planter(k, 0.1, 0.9, 0.12, 0.12, 'palm', Y0);
    sandbags(k, [-0.95, 0.96], [-0.25, 0.96], 2, Y0);
  }
  crate(k, 0.85, Y0, 0.85, 0.08);
  crate(k, 0.76, Y0, 0.88, 0.07, 0.3);
  k.height = 0.95;
}

// ================================================================ WAR FACTORY (3x3)

function factory(k: Kit) {
  const P = k.P;
  const R = P.R;
  slab(k, 3, 3, Y0, [-0.53, 0.53, -0.6]);
  // vehicle bay floor + apron (ground level, open to +Z)
  k.box(P.T.concrete(0x8e8c86, 2), 1.06, 0.01, 2.12, 0, 0, 0.44);
  for (const sx of [-1, 1]) k.box(P.yellow, 0.022, 0.003, 1.95, sx * 0.4, 0.01, 0.5);
  for (let i = 0; i < 4; i++) {
    const zz = 1.25 - i * 0.22;
    k.at(-0.06, 0.01, zz, -0.6, () => k.box(P.white, 0.13, 0.003, 0.022, 0, 0, 0));
    k.at(0.06, 0.01, zz, 0.6, () => k.box(P.white, 0.13, 0.003, 0.022, 0, 0, 0));
  }
  k.box(P.hazard, 0.9, 0.003, 0.05, 0, 0.01, 0.92, 9);
  const z0 = -1.42;
  const z1 = 0.95;
  const zc = (z0 + z1) / 2;
  const L = z1 - z0;
  const H = R === 'east' ? 0.5 : 0.6;
  const DH = 0.56; // door height
  const hallW = 1.42 - 0.55;
  const hallM = R === 'west' ? P.wall2 : R === 'east' ? P.wall2 : R === 'asia' ? P.wall : P.wall;
  // side halls
  for (const sx of [-1, 1]) {
    const hx = sx * (0.55 + hallW / 2);
    k.box(P.base, hallW + 0.012, 0.03, L + 0.012, hx, Y0, zc);
    k.box(hallM, hallW, H, L, hx, Y0, zc);
    k.box(P.team, hallW + 0.008, 0.026, L + 0.008, hx, Y0 + H - 0.06, zc);
  }
  // bay interior: back wall + inner lighting
  k.box(P.dark, 1.1, H, 0.04, 0, 0, -0.6);
  k.box(P.lamp, 0.7, 0.03, 0.01, 0, 0.42, -0.575);
  k.box(P.mats.col(0x3a3d40, 0.8, 0.2), 1.1, 0.02, 1.55, 0, H - 0.01, 0.17);
  // back block behind the bay
  k.box(hallM, 1.1, H, 0.82, 0, Y0, -1.01);
  // facade windows (+X side and fronts of the halls)
  const style = { west: 'ribbon', east: 'round', asia: 'ribbonC', mideast: 'arched' }[R];
  facade(k, 'x', 1, z0, z1, 1.42, Y0, H, 1, style);
  for (const sx of [-1, 1]) facade(k, 'z', 1, sx * 0.55 + (sx > 0 ? 0.08 : -hallW), sx * 0.55 + (sx > 0 ? hallW : -0.08), z1, Y0, H, 1, style);
  door(k, 'z', 1, 1.25, Y0, z1, 0.1, 0.18, true);
  // door portal
  const doorFrame = () => {
    for (const sx of [-1, 1]) {
      k.box(P.hazard, 0.04, DH, 0.05, sx * 0.53, 0, z1 + 0.025, 9);
      k.sph(P.amber_l, 0.018, sx * 0.53, DH + 0.03, z1 + 0.06, 8, 6);
    }
    k.tube(P.steel, [-0.52, DH + 0.05, z1 - 0.03], [0.52, DH + 0.05, z1 - 0.03], 0.04, 12);
  };
  if (R === 'west') {
    vault(k, P.T.corr(0xa8b0b6, 3), hallM, 0, Y0 + H, zc, 2.86, L + 0.04, 0.42, false);
    // structural ribs + ridge ventilator
    for (let i = 0; i < 6; i++) {
      const g = new THREE.TorusGeometry(1.435, 0.012, 4, 22, Math.PI);
      g.scale(1, 0.42 / 1.435, 1);
      g.translate(0, Y0 + H, z0 + 0.05 + (i * (L - 0.1)) / 5);
      k.add(g, P.trim, 0);
    }
    k.box(P.trim, 0.12, 0.04, L * 0.8, 0, Y0 + H + 0.41, zc);
    k.box(P.dark, 0.13, 0.012, L * 0.8, 0, Y0 + H + 0.45, zc);
    k.box(P.team, 0.6, 0.12, 0.012, 0, Y0 + H + 0.1, z1 + 0.025);
    k.box(hallM, 1.1, H - DH, 0.04, 0, DH, z1 - 0.02);
    k.box(P.team, 1.12, 0.05, 0.05, 0, DH + 0.01, z1 + 0.02);
    doorFrame();
    // skylights + roof vents along the vault crown
    for (let i = 0; i < 3; i++) k.box(P.glass, 0.18, 0.012, L * 0.26, -0.5 + i * 0.5, Y0 + H + 0.405 - Math.abs(-0.5 + i * 0.5) * 0.12, zc);
    for (let i = 0; i < 4; i++) vent(k, 0.9, Y0 + H + 0.28, -1.1 + i * 0.5, 0.03);
    // front office annex + parking
    block(k, { x0: 0.62, x1: 1.42, z0: 1.0, z1: 1.42, h: 0.24, floors: 1, door: 0.9, equip: 1 });
    jersey(k, -1.0, 1.35, 0.6, 0);
    lightPole(k, -0.62, 1.38, 0.42, 0);
  } else if (R === 'east') {
    // sawtooth roof with north lights (glazing faces +Z)
    const n = 5;
    const tz = L / n;
    const th = 0.2;
    for (let i = 0; i < n; i++) {
      const za = z0 + i * tz;
      const zb = za + tz;
      k.at(0, Y0 + H, 0, -Math.PI / 2, () => k.prism(P.pitch, [[za, 0], [zb, 0], [zb - 0.02, th]], 2.86, 0, 0, 0));
      k.panel(P.win, 'z', 1, 0, Y0 + H + 0.03, zb - 0.02, 2.8, th - 0.05, [0, 0, 28 / 8, 0.25]);
      k.box(P.dark, 2.86, 0.012, 0.03, 0, Y0 + H + th - 0.004, zb - 0.02);
    }
    k.box(P.wall2, 1.1, H - DH, 0.05, 0, DH, z1 - 0.025);
    k.box(P.team, 1.12, 0.04, 0.05, 0, DH + 0.02, z1 + 0.01);
    doorFrame();
    // swung-open painted gate leaves with stars
    for (const sx of [-1, 1]) {
      k.box(P.accent, 0.012, DH - 0.02, 0.5, sx * 0.57, 0.01, z1 + 0.25);
      const star = regular(10, 0.07, Math.PI / 2).map(([a, b], i) => [a * (i % 2 ? 0.42 : 1), b * (i % 2 ? 0.42 : 1)] as P2);
      k.at(sx * 0.565 - sx * 0.01, 0.3, z1 + 0.25, Math.PI / 2, () => k.prism(P.red, star, 0.006, 0, 0, sx * 0.003));
    }
    chimney(k, -1.15, -1.15, 1.7, 0.08, 0.055, false, Y0);
    k.emit(-1.15, Y0 + 1.8, -1.15, 'smoke');
    stencil(k, '1', 'x', 1, 0.6, Y0 + 0.3, 1.42, 0.22);
    k.pipe(P.rust, [[1.44, Y0 + 0.4, -1.3], [1.44, Y0 + 0.4, 0.8]], 0.016, 8);
    guardBooth(k, 1.2, 1.25);
    boomGate(k, 0.6, 1.3, 0.4, 0);
  } else if (R === 'asia') {
    k.box(P.T.corr(0x5f86b8, 3), 2.86, 0.12, L, 0, Y0 + H - 0.12, zc);
    k.box(hallM, 1.1, H - DH, 0.04, 0, DH, z1 - 0.02);
    k.box(P.T.corr(0x5f86b8, 3), 1.1, 0.12, 0.045, 0, Y0 + H - 0.12, z1 - 0.02);
    gable(k, P.T.corr(0x5f86b8, 3), P.T.corr(0x5f86b8, 3), 0, Y0 + H, zc, 2.86, L, 0.2, 0.04, false);
    for (const sx of [-1, 1]) k.box(P.glass, 0.12, 0.01, L * 0.8, sx * 0.7, Y0 + H + 0.1, zc);
    k.box(P.team, 1.12, 0.05, 0.05, 0, DH + 0.01, z1 + 0.02);
    doorFrame();
    planter(k, -1.0, 1.35, 0.7, 0.1, 'shrub', Y0);
    planter(k, 1.0, 1.35, 0.7, 0.1, 'shrub', Y0);
    lightPole(k, 0.62, 1.2, 0.42, Math.PI);
  } else {
    // flat crenellated roofs over the halls with small vaults, and a tall iwan portal
    for (const sx of [-1, 1]) {
      const hx = sx * (0.55 + hallW / 2);
      flatRoof(k, hx - hallW / 2, hx + hallW / 2, z0, z1, Y0 + H, 0.04);
      for (let i = 0; i < 3; i++) vault(k, P.T.sandstone(0xe8dcc0, 5), null, hx, Y0 + H, z0 + 0.4 + i * 0.78, hallW - 0.12, 0.6, 0.14, true);
    }
    k.box(P.roof, 1.1, 0.02, 2.4, 0, Y0 + H, zc);
    for (let i = 0; i < 3; i++) dome(k, 0, Y0 + H, -1.0 + i * 0.6, 0.18, 'hemi');
    const op = archPts(0, 0.0, 1.0, 0.42, 0.25, 7);
    op[0][1] = 0.003;
    op[1][1] = 0.003;
    k.prism(P.wall2, [[-0.66, 0], [0.66, 0], [0.66, 1.18], [-0.66, 1.18]], 0.12, 0, 0, z1 - 0.01, undefined, [op]);
    const band = archPts(0, 0.0, 1.08, 0.42, 0.25, 7).slice(1);
    k.prism(P.tile, ([...band, [-0.62, 0.0], [-0.62, 1.12], [0.62, 1.12], [0.62, 0.0]] as P2[]).reverse(), 0.01, 0, 0.0, z1 + 0.055, 0, [op.map(([a, b]) => [a * 0.999, b] as P2)]);
    k.box(P.trim, 1.36, 0.04, 0.14, 0, 1.18, z1 - 0.01);
    for (let i = 0; i < 7; i++) k.box(P.trim, 0.06, 0.05, 0.13, -0.6 + i * 0.2, 1.22, z1 - 0.01);
    k.box(P.team, 0.5, 0.06, 0.006, 0, 1.06, z1 + 0.062);
    for (const sx of [-1, 1]) k.box(P.hazard, 0.03, 0.4, 0.02, sx * 0.53, 0, z1 + 0.06, 9);
    planter(k, -1.2, 1.3, 0.14, 0.14, 'palm', Y0);
    planter(k, 1.2, 1.3, 0.14, 0.14, 'palm', Y0);
    sandbags(k, [-1.0, 1.0], [-0.6, 1.0], 2, Y0);
  }
  // back block roof equipment
  roofKit(k, -0.55, 0.55, -1.42, -0.6, Y0 + H + (R === 'west' ? 0.38 : R === 'east' ? 0.2 : 0.2), 0);
  k.height = R === 'mideast' ? 1.25 : 1.1;
}

// ================================================================ RADAR (2x2)

/** Curved reflector strip (part of a vertical cylinder), facing +X, double sided. */
function reflector(k: Kit, m: Mat, R: number, arc: number, h: number, x: number, y: number, z: number) {
  const g = new THREE.CylinderGeometry(R, R, h, 14, 1, true, Math.PI / 2 - arc / 2, arc);
  // the arc is centred on +X after rotating: cylinder theta 0 = +Z, so shift by -PI/2
  g.translate(x - R, y + h / 2, z);
  k.add(g, m, 0);
}

function radar(k: Kit) {
  const P = k.P;
  const R = P.R;
  slab(k, 2, 2);
  const white = P.mats.col(0xeceee8, 0.55, 0.05, true);
  if (R === 'west') {
    const top = block(k, { x0: -0.95, x1: 0.1, z0: 0.0, z1: 0.95, h: 0.34, floors: 1, door: -0.4, equip: 1 });
    k.cyl(P.wall2, 0.14, 0.06, -0.62, top - 0.04, 0.3, 16);
    k.sph(P.mats.col(0xf2f2ee, 0.6, 0.05), 0.15, -0.62, top + 0.14, 0.3, 20, 14);
    satDish(k, -0.2, top - 0.04, 0.7, 0.08, 0.7, 0.8);
    // lattice tower with rotating ASR antenna
    const tx = 0.45;
    const tz = -0.45;
    k.box(P.concrete, 0.42, 0.04, 0.42, tx, Y0, tz);
    lattice(k, P.galv, tx, tz, Y0 + 0.04, 1.15, 0.38, 0.18, 7, 0.011);
    const ty = Y0 + 1.19;
    k.box(P.grating, 0.3, 0.012, 0.3, tx, ty, tz);
    railing(k, [[tx - 0.15, tz - 0.15], [tx + 0.15, tz - 0.15], [tx + 0.15, tz + 0.15], [tx - 0.15, tz + 0.15], [tx - 0.15, tz - 0.15]], ty + 0.012, 0.05);
    k.box(P.wall2, 0.24, 0.16, 0.18, tx - 0.1, Y0, tz + 0.32);
    const d = k.node('dish', tx, ty + 0.012, tz);
    k.on(d, () => {
      k.cyl(P.dark, 0.05, 0.08, 0, 0, 0, 12);
      k.box(P.galv, 0.05, 0.03, 0.08, 0, 0.08, 0);
      reflector(k, white, 0.6, 1.15, 0.22, 0.04, 0.07, 0);
      for (let i = -2; i <= 2; i++) k.bar(P.galv, [-0.02, 0.1, 0], [0.04 - 0.6 * (1 - Math.cos(i * 0.25)), 0.18, Math.sin(i * 0.25) * 0.6], 0.008);
      k.bar(P.galv, [0.0, 0.1, 0], [-0.3, 0.12, 0], 0.012);
      k.box(P.dark, 0.05, 0.045, 0.045, -0.32, 0.1, 0);
      k.box(P.galv, 0.016, 0.035, 0.6, 0.02, 0.3, 0);
      k.box(P.team, 0.018, 0.014, 0.6, 0.02, 0.335, 0);
    });
    k.spin('dish', 'y', 1.4);
    k.blinkLight(tx + 0.15, ty + 0.07, tz + 0.15, 0.014, 1.4, 0);
    k.blinkLight(tx - 0.15, ty + 0.07, tz - 0.15, 0.014, 1.4, 0.7);
    fence(k, [[0.15, 0.1], [0.95, 0.1], [0.95, 0.95], [0.25, 0.95]], 0.14, Y0);
    k.box(P.wall2, 0.3, 0.14, 0.2, 0.55, Y0, 0.5);
    hvac(k, 0.55, Y0 + 0.14, 0.5, 0.14, 0.1);
    k.height = 1.6;
  } else if (R === 'east') {
    const x0 = -0.95;
    const x1 = -0.05;
    const z0 = 0.05;
    const z1 = 0.95;
    k.box(P.base, x1 - x0 + 0.014, 0.03, z1 - z0 + 0.014, (x0 + x1) / 2, Y0, (z0 + z1) / 2);
    k.box(P.wall2, x1 - x0, 0.32, z1 - z0, (x0 + x1) / 2, Y0, (z0 + z1) / 2);
    facade(k, 'z', 1, x0, x1, z1, Y0, 0.32, 1, 'punched', [-0.6, -0.3]);
    facade(k, 'x', 1, z0, z1, x1, Y0, 0.32, 1, 'punched');
    door(k, 'z', 1, -0.45, Y0, z1, 0.12, 0.19);
    k.box(P.team, x1 - x0 + 0.008, 0.024, z1 - z0 + 0.008, (x0 + x1) / 2, Y0 + 0.29, (z0 + z1) / 2);
    gable(k, P.pitch, P.wall2, (x0 + x1) / 2, Y0 + 0.32, (z0 + z1) / 2, x1 - x0, z1 - z0, 0.18, 0.03, true);
    // P-18 style yagi mast (static)
    const yx = -0.6;
    const yz = -0.55;
    k.box(P.concrete, 0.2, 0.04, 0.2, yx, Y0, yz);
    k.cyl(P.dark, 0.016, 1.1, yx, Y0, yz, 8, 0.012);
    for (let r = 0; r < 2; r++)
      for (let i = 0; i < 6; i++) {
        const y = Y0 + 0.86 + r * 0.14;
        const xx = yx - 0.25 + i * 0.1;
        k.bar(P.galv, [xx, y, yz - 0.18], [xx, y, yz + 0.18], 0.006);
      }
    k.bar(P.galv, [yx - 0.27, Y0 + 0.86, yz], [yx + 0.27, Y0 + 0.86, yz], 0.012);
    k.bar(P.galv, [yx - 0.27, Y0 + 1.0, yz], [yx + 0.27, Y0 + 1.0, yz], 0.012);
    // concrete tower with rotating mesh reflector (P-37 style)
    const tx = 0.45;
    const tz = -0.42;
    k.cyl(P.wall, 0.22, 0.6, tx, Y0, tz, 16, 0.18);
    k.cyl(P.team, 0.182, 0.03, tx, Y0 + 0.54, tz, 16);
    stencil(k, '5', 'x', 1, tz, Y0 + 0.25, tx + 0.2, 0.12);
    const d = k.node('dish', tx, Y0 + 0.6, tz);
    const mesh = P.mats.col(0x9aa0a4, 0.5, 0.5, true);
    k.on(d, () => {
      k.cyl(P.dark, 0.13, 0.04, 0, 0, 0, 16);
      k.box(P.accent, 0.22, 0.13, 0.18, -0.02, 0.04, 0);
      k.box(P.glass, 0.005, 0.05, 0.14, -0.132, 0.1, 0);
      // big mesh reflector (concave side toward the feed at -X) + truss
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
    k.blinkLight(-0.6, Y0 + 1.12, -0.55, 0.014, 1.5, 0);
    k.box(P.mats.col(0x55603f, 0.85, 0.1), 0.3, 0.14, 0.16, 0.55, Y0, 0.45);
    k.box(P.canvas, 0.32, 0.03, 0.18, 0.55, Y0 + 0.14, 0.45);
    for (let i = 0; i < 4; i++) k.box(P.concrete, 0.2, 0.14, 0.02, 0.1 + i * 0.22, Y0, 0.95, 6);
    k.height = 1.15;
  } else if (R === 'asia') {
    block(k, { x0: -0.95, x1: 0.1, z0: 0.0, z1: 0.95, h: 0.36, floors: 1, door: -0.4, equip: 1 });
    // square white tower with rotating AESA panel
    const tx = 0.45;
    const tz = -0.45;
    k.box(P.base, 0.34, 0.04, 0.34, tx, Y0, tz);
    k.box(P.wall, 0.3, 1.0, 0.3, tx, Y0 + 0.04, tz);
    for (const yy of [0.5, 0.8]) {
      ribbon(k, 'z', 1, tx - 0.13, tx + 0.13, Y0 + yy, tz + 0.15, 0.08, true);
      ribbon(k, 'x', 1, tz - 0.13, tz + 0.13, Y0 + yy, tx + 0.15, 0.08, true);
    }
    k.box(P.accent, 0.33, 0.03, 0.33, tx, Y0 + 1.04, tz);
    k.box(P.team, 0.305, 0.025, 0.305, tx, Y0 + 0.4, tz);
    const d = k.node('dish', tx, Y0 + 1.07, tz);
    k.on(d, () => {
      k.cyl(P.dark, 0.07, 0.06, 0, 0, 0, 14);
      for (const sx of [-1, 1]) {
        k.at(sx * 0.05, 0.2, 0, sx > 0 ? 0 : Math.PI, () => {
          k.box(P.white, 0.05, 0.36, 0.54, 0, -0.18, 0);
          k.box(P.mats.canvas('aesa', texSolar(), { uv: 0, rough: 0.4, metal: 0.3, color: 0x8899aa }), 0.006, 0.33, 0.51, 0.026, -0.165, 0, 10);
          k.box(P.team, 0.052, 0.024, 0.542, 0, 0.16, 0);
        }, 0, sx * 0.3);
      }
    });
    k.spin('dish', 'y', 0.9);
    k.blinkLight(tx - 0.15, Y0 + 1.08, tz + 0.15, 0.014, 1.4, 0);
    planter(k, 0.6, 0.2, 0.5, 0.1, 'shrub', Y0);
    planter(k, 0.85, 0.6, 0.1, 0.6, 'tree', Y0);
    k.height = 1.25;
  } else {
    const top = block(k, { x0: -0.95, x1: 0.1, z0: 0.0, z1: 0.95, h: 0.34, floors: 1, door: -0.4, equip: 0 });
    // rotating dish on the ops roof
    const d = k.node('dish', -0.45, top - 0.03, 0.45);
    k.on(d, () => {
      k.cyl(P.dark, 0.06, 0.08, 0, 0, 0, 12);
      k.at(0, 0.2, 0, 0, () => {
        const pts: P2[] = [];
        for (let i = 0; i <= 6; i++) pts.push([0.2 * (i / 6) + 0.001, 0.07 * (i / 6) ** 2]);
        k.lathe(white, pts, 0, 0, 0, 20, 0);
        k.tube(P.dark, [0, 0, 0], [0, 0.17, 0], 0.005, 4);
        k.box(P.dark, 0.03, 0.03, 0.03, 0, 0.17, 0);
        k.ring(P.team, 0.2, 0.008, 0, 0.07, 0, 20);
      }, 0, Math.PI / 2 - 0.35);
      k.box(P.galv, 0.03, 0.14, 0.03, -0.02, 0.06, 0);
    });
    k.spin('dish', 'y', 1.1);
    // stone tower with a large radome
    const tx = 0.45;
    const tz = -0.45;
    k.box(P.base, 0.42, 0.04, 0.42, tx, Y0, tz);
    k.box(P.wall2, 0.36, 0.6, 0.36, tx, Y0 + 0.04, tz);
    punched(k, 'z', 1, tx - 0.12, tx + 0.12, 2, Y0 + 0.3, tz + 0.18, 0.05, 0.12, 'arch');
    punched(k, 'x', 1, tz - 0.12, tz + 0.12, 2, Y0 + 0.3, tx + 0.18, 0.05, 0.12, 'arch');
    flatRoof(k, tx - 0.18, tx + 0.18, tz - 0.18, tz + 0.18, Y0 + 0.64, 0.03, P.wall2);
    k.box(P.tile, 0.362, 0.04, 0.362, tx, Y0 + 0.52, tz, 0);
    k.cyl(P.concrete, 0.16, 0.05, tx, Y0 + 0.65, tz, 16);
    k.sph(P.mats.col(0xf0f0ea, 0.6, 0.05), 0.27, tx, Y0 + 0.92, tz, 24, 16);
    k.ring(P.team, 0.2, 0.012, tx, Y0 + 0.74, tz, 24);
    k.blinkLight(tx, Y0 + 1.2, tz, 0.014, 1.5, 0);
    planter(k, 0.75, 0.75, 0.14, 0.14, 'palm', Y0);
    sandbags(k, [0.2, 0.25], [0.2, 0.95], 2, Y0);
    k.height = 1.25;
  }
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

function airfield(k: Kit) {
  const P = k.P;
  const R = P.R;
  slab(k, 3, 3);
  // runway strip along the front
  const rz = 1.0;
  k.box(P.asphalt, 2.96, 0.004, 0.78, 0, Y0, rz);
  for (const sz of [-1, 1]) k.box(P.white, 2.9, 0.002, 0.014, 0, Y0 + 0.004, rz + sz * 0.35);
  dashes(k, P.white, -1.0, rz, 1.0, rz, 0.12, 0.08, 0.016, Y0 + 0.004);
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 6; i++) k.box(P.white, 0.16, 0.002, 0.03, sx * 1.32, Y0 + 0.004, rz - 0.27 + i * 0.108);
    const m = P.mats.canvas('rw' + (sx > 0 ? '27' : '09'), texStencil(sx > 0 ? '27' : '09', '#f0f0f0'), { alphaTest: 0.5 });
    k.decal(m, sx * 1.1, Y0 + 0.005, rz, 0.28, 0.14, [0, 0, 1, 1], sx > 0 ? -Math.PI / 2 : Math.PI / 2);
  }
  for (let i = 0; i <= 7; i++) {
    const x = -1.4 + i * 0.4;
    for (const sz of [-1, 1]) k.box(i === 0 || i === 7 ? P.green_l : P.lamp, 0.016, 0.012, 0.016, x, Y0 + 0.004, rz + sz * 0.375);
  }
  // central launch pad (aircraft spawn at the centre)
  k.cyl(P.T.concrete(0x9a9a96, 2), 0.47, 0.006, 0, Y0, 0, 32);
  k.decal(P.mats.canvas('helipad', texHelipad('#f2c230'), { alphaTest: 0.5 }), 0, Y0 + 0.007, 0, 0.82, 0.82);
  k.ring(P.team, 0.46, 0.012, 0, Y0 + 0.006, 0, 40);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    k.box(P.amber_l, 0.02, 0.012, 0.02, Math.cos(a) * 0.48, Y0, Math.sin(a) * 0.48);
  }
  // taxiway
  k.box(P.asphalt, 0.26, 0.004, 0.2, 0, Y0, 0.52);
  k.box(P.yellow, 0.014, 0.002, 0.22, 0, Y0 + 0.004, 0.52);

  // ------------------------------------------------ hangar (back left)
  const hx0 = -1.42;
  const hx1 = -0.08;
  const hz0 = -1.42;
  const hz1 = -0.55;
  const hcx = (hx0 + hx1) / 2;
  const hcz = (hz0 + hz1) / 2;
  const span = hx1 - hx0;
  const hl = hz1 - hz0;
  const opening = (w: number, h: number): P2[] => rect(w, h, hcx, h / 2 + 0.002);
  if (R === 'east') {
    // hardened aircraft shelter: concrete arch half buried under earth
    const rise = 0.5;
    k.at(hcx, Y0, hcz, 0, () => {
      const g = new THREE.CylinderGeometry(span / 2 + 0.06, span / 2 + 0.06, hl + 0.02, 22, 1, true, -Math.PI / 2, Math.PI);
      g.rotateX(-Math.PI / 2);
      g.scale(1, (rise + 0.06) / (span / 2 + 0.06), 1);
      k.add(g, P.mats.tex('soil', { color: 0x5f6a3a, seed: 29, size: 256 }, 0xffffff, 3));
    });
    vault(k, P.wall, null, hcx, Y0, hcz + 0.02, span - 0.02, hl + 0.02, rise, false, 3);
    const outer: P2[] = [];
    for (let i = 0; i <= 18; i++) {
      const a = (i / 18) * Math.PI;
      outer.push([hcx + (Math.cos(a) * span) / 2, Y0 + Math.sin(a) * rise]);
    }
    k.prism(P.concrete, outer, 0.06, 0, 0, hz1 + 0.03, undefined, [opening(span * 0.7, rise * 0.62).map(([a, b]) => [a, b + Y0] as P2)]);
    k.box(P.black, span * 0.7, rise * 0.62, 0.01, hcx, Y0, hz1 - 0.2);
    // blast door leaves pushed aside
    for (const sx of [-1, 1]) k.box(P.wallB, span * 0.2, rise * 0.62, 0.06, hcx + sx * span * 0.42, Y0, hz1 + 0.09);
    k.box(P.team, span * 0.7, 0.03, 0.012, hcx, Y0 + rise * 0.62 + 0.01, hz1 + 0.066);
    stencil(k, '04', 'z', 1, hcx, Y0 + rise * 0.7, hz1 + 0.06, 0.16);
  } else {
    const wallM = R === 'west' ? P.wall2 : R === 'mideast' ? P.wall2 : P.wall;
    const wh = R === 'mideast' ? 0.36 : 0.22;
    const rise = R === 'mideast' ? 0.16 : R === 'asia' ? 0.22 : 0.34;
    k.box(P.base, span + 0.012, 0.03, hl + 0.012, hcx, Y0, hcz);
    k.box(wallM, 0.04, wh, hl, hx0 + 0.02, Y0, hcz);
    k.box(wallM, 0.04, wh, hl, hx1 - 0.02, Y0, hcz);
    k.box(wallM, span, wh, 0.04, hcx, Y0, hz0 + 0.02);
    const roofM = R === 'west' ? P.T.corr(0x9aa3a8) : R === 'asia' ? P.T.corr(0x5f86b8) : P.T.sandstone(0xe8dcc0, 5);
    vault(k, roofM, null, hcx, Y0 + wh, hcz, span + 0.03, hl + 0.03, rise, false);
    // front wall with the door opening
    const outer: P2[] = [[hx0, Y0], [hx1, Y0]];
    for (let i = 0; i <= 18; i++) {
      const a = (i / 18) * Math.PI;
      outer.push([hcx + (Math.cos(a) * (span + 0.03)) / 2, Y0 + wh + Math.sin(a) * rise]);
    }
    outer.splice(2, 0, [hx1, Y0 + wh]);
    outer.push([hx0, Y0 + wh]);
    const hole = R === 'mideast' ? archPts(hcx, Y0 + 0.002, span * 0.7, 0.16, 0.3, 6) : opening(span * 0.78, wh + rise * 0.55).map(([a, b]) => [a, b + Y0] as P2);
    k.prism(wallM, outer, 0.04, 0, 0, hz1 - 0.02, undefined, [hole]);
    const back: P2[] = [[hx0 + 0.05, Y0], [hx1 - 0.05, Y0]];
    for (let i = 0; i <= 12; i++) {
      const a = (i / 12) * Math.PI;
      back.push([hcx + (Math.cos(a) * (span - 0.1)) / 2, Y0 + wh + Math.sin(a) * (rise - 0.03)]);
    }
    back.splice(2, 0, [hx1 - 0.05, Y0 + wh]);
    back.push([hx0 + 0.05, Y0 + wh]);
    k.prism(P.black, back, 0.01, 0, 0, hz0 + 0.05);
    k.box(P.lamp, span * 0.5, 0.02, 0.01, hcx, Y0 + wh + 0.05, hz0 + 0.06);
    if (R === 'mideast') {
      k.box(P.tile, span * 0.85, 0.035, 0.004, hcx, Y0 + 0.47, hz1 + 0.001);
      k.box(P.team, 0.2, 0.06, 0.006, hcx, Y0 + 0.4, hz1 + 0.002);
    } else {
      const dw = span * 0.78;
      for (const sx of [-1, 1]) k.box(P.rollup, 0.03, wh + rise * 0.55, dw * 0.25, hcx + sx * (dw / 2 + 0.02), Y0, hz1 + 0.01);
      k.box(P.team, dw + 0.04, 0.04, 0.03, hcx, Y0 + wh + rise * 0.55, hz1 + 0.0);
      for (const sx of [-1, 1]) k.box(P.hazard, 0.03, wh + rise * 0.55, 0.03, hcx + sx * (dw / 2 + 0.015), Y0, hz1 + 0.015, 9);
    }
  }
  parkedDrone(k, hcx, Y0, hz1 - 0.28, Math.PI / 2, 1.1);
  parkedDrone(k, -1.05, Y0, -0.15, 0.3, 1.0);

  // ------------------------------------------------ control tower (back right)
  const tx = 1.0;
  const tz = -1.0;
  block(k, { x0: 0.62, x1: 1.42, z0: -1.42, z1: -0.62, h: 0.24, floors: 1, door: 0.8, equip: 1, roof: R === 'asia' ? 'flat' : 'flat' });
  const shaftTop = Y0 + 1.0;
  if (R === 'asia') {
    k.cyl(P.wall, 0.11, 1.0, tx, Y0, tz, 18, 0.09);
    k.lathe(P.wall, [[0.09, 0], [0.2, 0.06], [0.2, 0.08]], tx, shaftTop - 0.08, tz, 18);
  } else if (R === 'east') {
    k.box(P.wall2, 0.2, 1.0, 0.2, tx, Y0, tz);
    k.panel(P.win, 'z', 1, tx, Y0 + 0.3, tz + 0.1, 0.06, 0.6, [0, 0, 0.125, 1.5]);
    stencil(k, 'КДП', 'x', 1, tz, Y0 + 0.75, tx + 0.1, 0.18);
    k.box(P.concrete, 0.38, 0.03, 0.38, tx, shaftTop - 0.03, tz);
  } else if (R === 'mideast') {
    k.box(P.wall, 0.22, 1.0, 0.22, tx, Y0, tz);
    punched(k, 'z', 1, tx - 0.06, tx + 0.06, 1, Y0 + 0.55, tz + 0.11, 0.05, 0.12, 'arch');
    punched(k, 'x', 1, tz - 0.06, tz + 0.06, 1, Y0 + 0.55, tx + 0.11, 0.05, 0.12, 'arch');
    k.box(P.tile, 0.224, 0.04, 0.224, tx, Y0 + 0.85, tz, 0);
    k.box(P.trim, 0.36, 0.03, 0.36, tx, shaftTop - 0.03, tz);
  } else {
    k.box(P.wall, 0.2, 1.0, 0.2, tx, Y0, tz);
    k.box(P.wall2, 0.06, 0.9, 0.06, tx + 0.1, Y0, tz + 0.1);
    k.box(P.trim, 0.36, 0.03, 0.36, tx, shaftTop - 0.03, tz);
  }
  // glazed cab (outward-leaning octagon)
  k.cyl(P.mats.col(0x2a4258, 0.15, 0.8), 0.17, 0.13, tx, shaftTop, tz, 8, 0.2);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + TAU / 16;
    k.bar(P.dark, [tx + Math.cos(a) * 0.172, shaftTop, tz + Math.sin(a) * 0.172], [tx + Math.cos(a) * 0.202, shaftTop + 0.13, tz + Math.sin(a) * 0.202], 0.008);
  }
  k.cyl(P.lamp, 0.165, 0.004, tx, shaftTop + 0.06, tz, 8);
  if (R === 'asia') asianRoof(k, P.pitch, ridgeMat(k), tx, shaftTop + 0.13, tz, 0.5, 0.5, 0.12, 0.04, P.accent);
  else if (R === 'mideast') {
    k.cyl(P.trim, 0.22, 0.03, tx, shaftTop + 0.13, tz, 8);
    dome(k, tx, shaftTop + 0.13, tz, 0.13, P.s.faction === 'turkey' ? 'ottoman' : 'persian');
  } else {
    k.cyl(P.dark, 0.22, 0.035, tx, shaftTop + 0.13, tz, 8);
    k.cyl(P.team, 0.222, 0.015, tx, shaftTop + 0.14, tz, 8);
    antenna(k, tx - 0.06, shaftTop + 0.165, tz, 0.25);
    satDish(k, tx + 0.08, shaftTop + 0.165, tz - 0.04, 0.05, 0.6);
    if (R === 'east') {
      for (let i = 0; i < 4; i++) k.cyl(i % 2 ? P.white : P.red, 0.012, 0.06, tx + 0.05, shaftTop + 0.165 + i * 0.06, tz + 0.06, 6);
    }
  }
  k.blinkLight(tx, shaftTop + 0.45, tz, 0.016, 1.3, 0);
  k.cyl(P.dark, 0.004, 0.3, tx, shaftTop + 0.15, tz, 4);

  // ------------------------------------------------ windsock + fuel bowser + lights
  k.cyl(P.concrete, 0.025, 0.02, 1.3, Y0, 0.42, 8);
  k.cyl(P.galv, 0.007, 0.36, 1.3, Y0, 0.42, 6);
  const sock = k.node('sock', 1.3, Y0 + 0.35, 0.42, -0.6);
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
  k.blinkLight(1.3, Y0 + 0.39, 0.42, 0.01, 1.0, 0.2);
  const tank = P.mats.col(R === 'west' ? 0xb8a27a : 0xd8d8d0, 0.5, 0.3);
  k.at(1.05, Y0, -0.3, 0.3, () => {
    k.box(P.dark, 0.32, 0.03, 0.11, 0, 0.02, 0);
    k.tube(tank, [-0.12, 0.09, 0], [0.12, 0.09, 0], 0.05, 12);
    k.rbox(P.mats.col(P.s.hull, 0.6, 0.2), 0.08, 0.08, 0.11, 0.15, 0.04, 0, 0.01);
    for (const wx of [-0.1, 0.06, 0.15]) for (const sz of [-1, 1]) k.tube(P.rubber, [wx, 0.025, sz * 0.05], [wx, 0.025, sz * 0.06], 0.025, 10);
  });
  lightPole(k, -1.38, 0.5, 0.42, 0);
  lightPole(k, 0.55, -0.5, 0.42, Math.PI);
  if (R === 'mideast') planter(k, -0.6, -0.42, 0.12, 0.12, 'palm', Y0);
  if (R === 'asia') planter(k, 0.62, -0.45, 0.4, 0.08, 'shrub', Y0);
  k.height = 1.45;
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
  k.plan(P.T.concrete(0x8a8c8e, 2), regular(6, 0.26, Math.PI / 6), 0.02, x, Y0, z, 0.006);
  k.ring(P.yellow, 0.24, 0.006, x, Y0 + 0.022, z, 6);
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

function tech(k: Kit) {
  const P = k.P;
  const R = P.R;
  slab(k, 3, 3);
  const cyan = P.cyan_l;
  if (R === 'west') {
    const x0 = -1.42;
    const x1 = 0.25;
    const z0 = -1.42;
    const z1 = -0.35;
    k.box(P.base, x1 - x0 + 0.014, 0.03, z1 - z0 + 0.014, (x0 + x1) / 2, Y0, (z0 + z1) / 2);
    k.box(P.wall2, x1 - x0, 0.8, z1 - z0, (x0 + x1) / 2, Y0, (z0 + z1) / 2);
    curtain(k, 'z', 1, x0 + 0.04, x1 - 0.04, Y0 + 0.04, Y0 + 0.74, z1, 0.09, 0.117);
    curtain(k, 'x', 1, z0 + 0.04, z1 - 0.04, Y0 + 0.04, Y0 + 0.74, x1, 0.09, 0.117);
    k.box(cyan, x1 - x0 + 0.01, 0.012, z1 - z0 + 0.01, (x0 + x1) / 2, Y0 + 0.755, (z0 + z1) / 2);
    k.box(P.team, x1 - x0 + 0.012, 0.03, z1 - z0 + 0.012, (x0 + x1) / 2, Y0 + 0.77, (z0 + z1) / 2);
    flatRoof(k, x0, x1, z0, z1, Y0 + 0.8, 0.03, P.wall2);
    roofKit(k, x0, x1 - 0.6, z0, z1, Y0 + 0.81, 2);
    satcom(k, 'dish', -0.15, Y0 + 0.81, -0.9, 0.16);
    for (let i = 0; i < 3; i++) antenna(k, -1.3 + i * 0.12, Y0 + 0.81, -1.3, 0.35 + i * 0.08);
    // glass entrance atrium
    k.box(P.base, 0.56, 0.02, 0.32, -0.7, Y0, -0.19);
    curtain(k, 'z', 1, -0.97, -0.43, Y0 + 0.02, Y0 + 0.3, -0.03, 0.09, 0.093);
    curtain(k, 'x', 1, -0.34, -0.04, Y0 + 0.02, Y0 + 0.3, -0.43, 0.1, 0.093);
    k.box(P.mats.col(0x2a3a48, 0.15, 0.8), 0.54, 0.28, 0.3, -0.7, Y0 + 0.02, -0.19);
    k.box(P.trim, 0.6, 0.025, 0.36, -0.7, Y0 + 0.3, -0.19);
    k.box(cyan, 0.6, 0.008, 0.36, -0.7, Y0 + 0.296, -0.19);
    // big radome
    k.cyl(P.wall, 0.4, 0.22, 0.9, Y0, -0.9, 24);
    k.cyl(P.team, 0.405, 0.03, 0.9, Y0 + 0.16, -0.9, 24);
    k.sph(P.mats.col(0xf4f4f0, 0.6, 0.05), 0.44, 0.9, Y0 + 0.5, -0.9, 28, 18);
    door(k, 'x', 1, -0.9, Y0, 1.3, 0.1, 0.18, false);
    // solar field + antenna farm
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) solarPanel(k, -1.15 + j * 0.42, Y0, 0.35 + i * 0.32, 0.38, 0.2, 0.5);
    for (let i = 0; i < 3; i++) satDish(k, 1.25, Y0, 0.15 + i * 0.35, 0.09, 0.9, 0.9);
    lattice(k, P.galv, 0.55, 0.55, Y0, 1.55, 0.14, 0.05, 8, 0.007);
    k.blinkLight(0.55, Y0 + 1.58, 0.55, 0.016, 1.5, 0);
    k.box(cyan, 0.04, 0.04, 0.04, 0.55, Y0 + 1.0, 0.55);
    fence(k, [[0.25, 1.45], [1.45, 1.45], [1.45, -0.2]], 0.15, Y0);
    lightPole(k, -0.2, 1.3, 0.42, 0);
    k.height = 1.5;
  } else if (R === 'east') {
    // brutalist institute: stepped concrete blocks with vertical fins
    block(k, { x0: -1.42, x1: 0.3, z0: -1.42, z1: -0.35, h: 0.42, floors: 2, equip: 0 });
    const ux0 = -1.3;
    const ux1 = -0.2;
    const uz0 = -1.3;
    const uz1 = -0.6;
    k.box(P.wallB, ux1 - ux0, 0.56, uz1 - uz0, (ux0 + ux1) / 2, Y0 + 0.42, (uz0 + uz1) / 2);
    for (let i = 0; i <= 13; i++) {
      const x = ux0 + ((ux1 - ux0) * i) / 13;
      k.box(P.concrete, 0.025, 0.56, 0.05, x, Y0 + 0.42, uz1 + 0.025);
      if (i < 13) k.panel(P.win, 'z', 1, x + (ux1 - ux0) / 26, Y0 + 0.46, uz1 + 0.003, 0.055, 0.46, [(i % 8) / 8, 0, (i % 8) / 8 + 0.125, 0.75]);
    }
    for (let i = 0; i <= 8; i++) {
      const z = uz0 + ((uz1 - uz0) * i) / 8;
      k.box(P.concrete, 0.05, 0.56, 0.025, ux1 + 0.025, Y0 + 0.42, z);
    }
    k.box(P.team, ux1 - ux0 + 0.01, 0.03, uz1 - uz0 + 0.01, (ux0 + ux1) / 2, Y0 + 0.92, (uz0 + uz1) / 2);
    flatRoof(k, ux0, ux1, uz0, uz1, Y0 + 0.98, 0.03);
    roofKit(k, ux0, ux1, uz0, uz1, Y0 + 0.99, 2);
    stencil(k, 'НИИ-9', 'x', 1, -0.95, Y0 + 0.75, ux1 + 0.05, 0.36, '#e6e2d6');
    dome(k, 0.88, Y0, -0.9, 0.38, 'observatory');
    // tall lattice TV / comms mast with aviation bands
    const mx = 1.05;
    const mz = 0.55;
    k.box(P.concrete, 0.3, 0.04, 0.3, mx, Y0, mz);
    lattice(k, P.galv, mx, mz, Y0 + 0.04, 2.0, 0.26, 0.05, 10, 0.008);
    for (let i = 0; i < 3; i++) k.box(i % 2 ? P.white : P.red, 0.09 - i * 0.012, 0.1, 0.09 - i * 0.012, mx, Y0 + 1.5 + i * 0.16, mz);
    k.blinkLight(mx, Y0 + 2.08, mz, 0.018, 1.5, 0);
    k.blinkLight(mx, Y0 + 1.2, mz, 0.014, 1.5, 0.75);
    satcom(k, 'dish', 0.35, Y0, 0.2, 0.16);
    // cryo tanks + pipes
    for (let i = 0; i < 3; i++) silo(k, -1.15 + i * 0.25, 0.75, 0.09, 0.5, P.white, 'dome');
    k.pipe(P.galv, [[-1.15, Y0 + 0.3, 0.66], [-1.15, Y0 + 0.3, -0.33]], 0.014, 6);
    k.pipe(P.rust, [[-0.6, Y0 + 0.2, 0.75], [-0.3, Y0 + 0.2, 0.75], [-0.3, Y0 + 0.2, -0.33]], 0.018, 6);
    for (let i = 0; i < 5; i++) k.box(P.concrete, 0.24, 0.16, 0.02, -1.3 + i * 0.25, Y0, 1.45, 6);
    guardBooth(k, 0.25, 1.25);
    k.height = 1.6;
  } else if (R === 'asia') {
    // podium + glass tower with tiled crown + glass dome
    block(k, { x0: -1.42, x1: 0.35, z0: -1.42, z1: -0.25, h: 0.3, floors: 1, equip: 0, door: -0.3 });
    const tx0 = -1.15;
    const tx1 = -0.45;
    const tz0 = -1.2;
    const tz1 = -0.55;
    k.box(P.wall, tx1 - tx0, 1.05, tz1 - tz0, (tx0 + tx1) / 2, Y0 + 0.3, (tz0 + tz1) / 2);
    curtain(k, 'z', 1, tx0 + 0.04, tx1 - 0.04, Y0 + 0.34, Y0 + 1.31, tz1, 0.09, 0.108);
    curtain(k, 'x', 1, tz0 + 0.04, tz1 - 0.04, Y0 + 0.34, Y0 + 1.31, tx1, 0.09, 0.108);
    k.box(P.team, tx1 - tx0 + 0.01, 0.03, tz1 - tz0 + 0.01, (tx0 + tx1) / 2, Y0 + 1.32, (tz0 + tz1) / 2);
    asianRoof(k, P.pitch, ridgeMat(k), (tx0 + tx1) / 2, Y0 + 1.35, (tz0 + tz1) / 2, tx1 - tx0 + 0.16, tz1 - tz0 + 0.16, 0.22, 0.05, P.accent);
    k.blinkLight((tx0 + tx1) / 2, Y0 + 1.62, (tz0 + tz1) / 2, 0.014, 1.4, 0);
    flatRoof(k, -0.4, 0.35, -1.42, -0.25, Y0 + 0.3, 0.03);
    // glass dome lab
    const dx = 0.88;
    const dz = -0.8;
    k.cyl(P.wall, 0.44, 0.12, dx, Y0, dz, 28);
    k.cyl(P.accent, 0.445, 0.02, dx, Y0 + 0.1, dz, 28);
    k.sph(cyan, 0.12, dx, Y0 + 0.32, dz, 14, 10);
    k.cyl(P.galv, 0.03, 0.2, dx, Y0 + 0.12, dz, 8);
    const gl = P.mats.col(0x6aa8c8, 0.15, 0.85);
    k.dome(gl, 0.42, dx, Y0 + 0.12, dz, 28, 10);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      const pts: V3[] = [];
      for (let j = 0; j <= 5; j++) {
        const t = (j / 5) * (Math.PI / 2);
        pts.push([dx + Math.cos(a) * Math.cos(t) * 0.425, Y0 + 0.12 + Math.sin(t) * 0.425, dz + Math.sin(a) * Math.cos(t) * 0.425]);
      }
      k.pipe(P.white, pts, 0.007, 4);
    }
    satcom(k, 'dish', 0.9, Y0, 0.3, 0.16);
    prototypeLaser(k, 0.25, 0.85);
    planter(k, -1.2, 0.3, 0.12, 0.8, 'tree', Y0);
    planter(k, -0.6, 1.3, 0.9, 0.1, 'shrub', Y0);
    planter(k, 0.4, 1.3, 0.6, 0.1, 'shrub', Y0);
    for (let i = 0; i < 2; i++) tree(k, -0.7 + i * 0.4, 0.4, 0.32, Y0);
    lightPole(k, 1.3, 1.3, 0.42, Math.PI);
    k.height = 1.65;
  } else {
    // octagonal domed hall, modern glass wing, reflecting pool
    const cx = -0.6;
    const cz = -0.62;
    k.cyl(P.base, 0.66, 0.04, cx, Y0, cz, 8);
    k.cyl(P.wall, 0.62, 0.48, cx, Y0 + 0.04, cz, 8);
    const band = new THREE.CylinderGeometry(0.625, 0.625, 0.06, 8, 1, true);
    scaleUV(band, 10, 1);
    band.translate(cx, Y0 + 0.43, cz);
    k.add(band, P.tile, 0);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU + TAU / 16;
      if (Math.cos(a) + Math.sin(a) < -0.3) continue;
      const r = 0.62 * Math.cos(TAU / 16);
      k.at(cx + Math.cos(a) * r, Y0 + 0.12, cz + Math.sin(a) * r, Math.PI / 2 - a, () => {
        k.prism(P.glass, archPts(0, 0, 0.12, 0.14, 0.4, 5), 0.01, 0, 0, 0.004);
        k.prism(P.trim, archPts(0, -0.01, 0.16, 0.15, 0.4, 5).slice(1), 0.012, 0, 0, 0.008, undefined, [archPts(0, 0.0, 0.125, 0.14, 0.4, 5).slice(1)]);
      });
    }
    k.cyl(P.trim, 0.64, 0.03, cx, Y0 + 0.52, cz, 8);
    dome(k, cx, Y0 + 0.55, cz, 0.46, P.s.faction === 'turkey' ? 'ottoman' : 'persian');
    k.cyl(P.team, 0.635, 0.025, cx, Y0 + 0.36, cz, 8);
    // modern research wing
    const wx0 = 0.35;
    const wx1 = 1.42;
    const wz0 = -1.42;
    const wz1 = -0.4;
    k.box(P.base, wx1 - wx0 + 0.014, 0.03, wz1 - wz0 + 0.014, (wx0 + wx1) / 2, Y0, (wz0 + wz1) / 2);
    k.box(P.wall2, wx1 - wx0, 0.52, wz1 - wz0, (wx0 + wx1) / 2, Y0, (wz0 + wz1) / 2);
    curtain(k, 'z', 1, wx0 + 0.06, wx1 - 0.06, Y0 + 0.06, Y0 + 0.46, wz1, 0.09, 0.1);
    curtain(k, 'x', 1, wz0 + 0.06, wz1 - 0.06, Y0 + 0.06, Y0 + 0.46, wx1, 0.09, 0.1);
    for (let i = 0; i < 9; i++) faceBox(k, P.mash, 'z', 1, wx0 + 0.1 + i * 0.11, Y0 + 0.06, wz1, 0.05, 0.4, 0.03);
    k.box(P.team, wx1 - wx0 + 0.01, 0.025, wz1 - wz0 + 0.01, (wx0 + wx1) / 2, Y0 + 0.49, (wz0 + wz1) / 2);
    flatRoof(k, wx0, wx1, wz0, wz1, Y0 + 0.52, 0.035);
    satcom(k, 'dish', 0.95, Y0 + 0.53, -0.95, 0.15);
    antenna(k, 1.3, Y0 + 0.53, -1.3, 0.5);
    // reflecting pool with arcade
    const water = P.mats.col(0x2f8aa6, 0.1, 0.9);
    k.box(P.wall2, 1.3, 0.04, 0.62, -0.55, Y0, 0.75);
    k.box(water, 1.2, 0.005, 0.52, -0.55, Y0 + 0.036, 0.75);
    k.cyl(P.wall2, 0.05, 0.08, -0.55, Y0 + 0.04, 0.75, 10);
    k.cyl(cyan, 0.02, 0.06, -0.55, Y0 + 0.11, 0.75, 8);
    arcade(k, P.wall2, -1.3, 0.1, Y0, 0.24, 0.0, 0.03, 6, 0.13, 0.08);
    k.box(P.wall2, 1.4, 0.025, 0.08, -0.6, Y0 + 0.24, 0.0);
    k.box(P.tile, 1.36, 0.03, 0.004, -0.6, Y0 + 0.19, 0.017);
    for (const [px, pz] of [
      [-1.3, 0.45],
      [0.2, 0.45],
      [-1.3, 1.2],
      [0.2, 1.2],
    ])
      planter(k, px, pz, 0.12, 0.12, 'palm', Y0);
    k.box(cyan, 0.4, 0.01, 0.01, (wx0 + wx1) / 2, Y0 + 0.03, wz1 + 0.012);
    lightPole(k, 1.3, 1.3, 0.42, Math.PI);
    k.height = 1.5;
  }
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
    // EL/M-2084 radar on its own mast (static)
    k.box(hull, 0.16, 0.1, 0.16, -0.32, g, -0.3);
    k.cyl(P.dark, 0.012, 0.18, -0.32, g + 0.1, -0.3, 6);
    k.at(-0.32, g + 0.3, -0.3, Math.PI / 4, () => {
      k.box(hull, 0.03, 0.2, 0.28, 0, -0.1, 0);
      k.box(P.mats.canvas('aesa2', texSolar(), { uv: 0, rough: 0.5, metal: 0.2, color: 0x9aa48a }), 0.006, 0.18, 0.26, 0.018, -0.09, 0, 12);
    }, 0, -0.3);
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
  if (R === 'west' && f !== 'israel') jersey(k, -0.25, 0.42, 0.4, 0);
  if (R === 'mideast') sandbags(k, [0.42, -0.3], [0.42, 0.3], 2, g);
  if (R === 'asia') fence(k, [[-0.45, 0.45], [0.45, 0.45]], 0.12, g);
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
  airfield: building('airfield', 3, 3, airfield),
  tech: building('tech', 3, 3, tech),
  bunker: building('bunker', 1, 1, bunker),
  sentry: building('sentry', 1, 1, sentry),
  sam: building('sam', 1, 1, sam),
  atgm: building('atgm', 1, 1, atgm),
  oil: building('oil', 2, 2, oil),
};
