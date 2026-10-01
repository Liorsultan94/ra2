import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { FogOfWar } from '../fog';
import { pbr, worldUV, type TexKind, type TexOpts } from '../textures';
import type { Builder } from './registry';
import type { AnimState, Model, ModelStyle, Region } from './types';

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
    for (let i = 0; i < 3; i++) {
      c.fillStyle = css(cols[i] ?? 0x888888);
      c.fillRect(0, (i * h) / 3, w, h / 3 + 1);
    }
    // a few recognisable emblems on top of the three bands
    if (faction === 'usa') {
      for (let i = 0; i < 13; i++) {
        c.fillStyle = i % 2 ? '#ffffff' : '#b22234';
        c.fillRect(0, (i * h) / 13, w, h / 13 + 1);
      }
      c.fillStyle = '#3c3b6e';
      c.fillRect(0, 0, w * 0.42, h * 0.54);
      c.fillStyle = '#ffffff';
      for (let i = 0; i < 5; i++) for (let j = 0; j < 4; j++) c.fillRect(4 + i * 7.5, 4 + j * 8, 2, 2);
    } else if (faction === 'israel') {
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#0038b8';
      c.fillRect(0, h * 0.1, w, h * 0.14);
      c.fillRect(0, h * 0.76, w, h * 0.14);
      c.strokeStyle = '#0038b8';
      c.lineWidth = 3;
      for (const r of [0, Math.PI]) {
        c.beginPath();
        for (let k = 0; k < 3; k++) {
          const a = r + (k / 3) * TAU - Math.PI / 2;
          const x = w / 2 + Math.cos(a) * 12;
          const y = h / 2 + Math.sin(a) * 12;
          if (k) c.lineTo(x, y);
          else c.moveTo(x, y);
        }
        c.closePath();
        c.stroke();
      }
    } else if (faction === 'china') {
      c.fillStyle = '#de2910';
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#ffde00';
      const star = (x: number, y: number, r: number) => {
        c.beginPath();
        for (let k = 0; k < 10; k++) {
          const rr = k % 2 ? r * 0.4 : r;
          const a = (k / 10) * TAU - Math.PI / 2;
          if (k) c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
          else c.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
        }
        c.closePath();
        c.fill();
      };
      star(16, 16, 10);
      star(32, 6, 3);
      star(38, 13, 3);
      star(38, 22, 3);
      star(32, 29, 3);
    } else if (faction === 'korea') {
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#cd2e3a';
      c.beginPath();
      c.arc(w / 2, h / 2, 14, Math.PI, TAU);
      c.fill();
      c.fillStyle = '#0047a0';
      c.beginPath();
      c.arc(w / 2, h / 2, 14, 0, Math.PI);
      c.fill();
      c.fillStyle = '#111';
      for (const [x, y] of [
        [16, 12],
        [80, 12],
        [16, 52],
        [80, 52],
      ])
        c.fillRect(x - 6, y - 5, 12, 10);
    } else if (faction === 'turkey') {
      c.fillStyle = '#e30a17';
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#ffffff';
      c.beginPath();
      c.arc(34, h / 2, 16, 0, TAU);
      c.fill();
      c.fillStyle = '#e30a17';
      c.beginPath();
      c.arc(38, h / 2, 13, 0, TAU);
      c.fill();
      c.fillStyle = '#ffffff';
      c.beginPath();
      c.arc(56, h / 2, 5, 0, TAU);
      c.fill();
    } else if (faction === 'iran') {
      c.fillStyle = '#da0000';
      c.beginPath();
      c.arc(w / 2, h / 2, 7, 0, TAU);
      c.fill();
    } else if (faction === 'germany' || faction === 'russia' || faction === 'ukraine') {
      // plain tricolours / bicolour: the three bands are already right
    }
  });
}

/** Per-template material factory bound to an owner (style) and a fog instance. */
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
  /** Textured PBR material (procedural texture from textures.ts), tinted. */
  tex(kind: TexKind, opts: TexOpts, tint = 0xffffff, uv = 3, rough = 1, metal = 0.03, nScale = 1): SMat {
    return this.cached(`tex:${kind}:${JSON.stringify(opts)}:${tint}:${uv}:${rough}:${metal}:${nScale}`, false, () => {
      const set = pbr(kind, opts);
      const m = new THREE.MeshStandardMaterial({
        map: set.map,
        normalMap: set.normalMap,
        roughnessMap: set.roughnessMap,
        roughness: rough,
        metalness: metal,
        color: tint,
        normalScale: new THREE.Vector2(nScale, nScale),
      });
      m.userData.uv = uv;
      return m;
    });
  }
  col(color: number, rough = 0.7, metal = 0.1, double = false): SMat {
    return this.cached(`col:${color}:${rough}:${metal}:${double}`, false, () => {
      const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, side: double ? THREE.DoubleSide : THREE.FrontSide });
      m.userData.uv = 0;
      return m;
    });
  }
  /** Emissive light (per owner so it can be dimmed on low power). */
  light(color: number, ei = 2.6): SMat {
    const m = this.cached(`glow:${color}:${ei}`, true, () => {
      const mm = new THREE.MeshStandardMaterial({ color: shade(color, 0.4), emissive: color, emissiveIntensity: ei, roughness: 0.4, metalness: 0, toneMapped: false });
      mm.userData.uv = 0;
      mm.userData.baseEI = ei;
      return mm;
    });
    this.glow.add(m);
    return m;
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
  canvas(key: string, tex: THREE.Texture, o: { rough?: number; metal?: number; alphaTest?: number; double?: boolean; uv?: number; color?: number; emissive?: number } = {}): SMat {
    return this.cached(`cv:${key}:${JSON.stringify(o)}`, false, () => {
      const m = new THREE.MeshStandardMaterial({
        map: tex,
        roughness: o.rough ?? 0.8,
        metalness: o.metal ?? 0.05,
        alphaTest: o.alphaTest ?? 0,
        transparent: false,
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
    corrRust: (tint: number, uv = 3) => M.tex('corrugated', { color: 0xa8a49a, grime: 0.85, divisions: 24, seed: 17 }, tint, uv, 1, 0.35),
    panel: (tint: number, uv = 2.5) => M.tex('metalPanel', { color: 0xdadde0, divisions: 3, grime: 0.2, seed: 18 }, tint, uv, 1, 0.35),
    tiles: (tint: number, uv = 4) => M.tex('roofTiles', { color: 0xe6e8e6, divisions: 10, grime: 0.25, seed: 19 }, tint, uv, 0.9, 0.1),
    asphalt: (tint: number, uv = 1.5) => M.tex('asphalt', { color: 0x46474a, seed: 20 }, tint, uv),
  };
}

function makePal(s: ModelStyle, fog: FogOfWar | null): Pal {
  const M = new Mats(s, fog);
  const R = s.region;
  const f = s.faction;
  const T = texSet(M);
  const team = M.col(s.team, 0.55, 0.2);
  const common = {
    team,
    teamD: M.col(shade(s.team, 0.6), 0.6, 0.2),
    steel: M.col(0x6f757b, 0.45, 0.65),
    galv: M.col(0xa8adb0, 0.4, 0.75),
    dark: M.col(0x2c2f33, 0.75, 0.3),
    black: M.col(0x141516, 0.9, 0.1),
    rubber: M.col(0x1c1c1c, 0.95, 0),
    glass: M.col(0x1d3346, 0.08, 0.85),
    white: M.col(0xe8e8e2, 0.75, 0.02),
    yellow: M.col(0xe0ae22, 0.7, 0.05),
    red: M.col(0xb3261e, 0.6, 0.1),
    hazard: M.canvas('hazard', texHazard(), { uv: 8, rough: 0.7 }),
    sandbag: M.tex('sandbag', { color: 0xb09c72, seed: 21, size: 256 }, 0xffffff, 7),
    wood: M.tex('wood', { color: 0x8a6a46, seed: 22, size: 256 }, 0xffffff, 5),
    canvas: M.tex('canvas', { color: 0x6b6a4a, seed: 23, grime: 0.4, size: 256 }, 0xffffff, 3),
    grating: M.tex('grating', { color: 0x6a6c6e, seed: 24, size: 256 }, 0xffffff, 8, 1, 0.6),
    rust: M.tex('rust', { seed: 25, size: 256 }, 0xffffff, 3),
    soil: M.tex('soil', { color: 0x6a5a40, seed: 26, size: 256 }, 0xffffff, 2),
    green: M.col(0x3f6a2c, 0.9, 0),
    pipe: M.col(0x8c9196, 0.45, 0.6),
    lamp: M.light(0xfff0c8, 2.8),
    red_l: M.light(0xff2a1a, 3.2),
    green_l: M.light(0x30ff6a, 2.6),
    cyan_l: M.light(0x5fe0ff, 2.6),
    amber_l: M.light(0xffa21a, 3),
    chain: M.canvas('chain', texChain(), { alphaTest: 0.4, double: true, uv: 9, metal: 0.6, rough: 0.5 }),
    solar: M.canvas('solar', texSolar(), { uv: 6, rough: 0.25, metal: 0.4 }),
    mash: M.canvas('mash', texMashrabiya(), { uv: 9, rough: 0.8 }),
    win: M.win(false),
    winC: M.win(true),
    corr: T.corr(0xffffff),
    corrRust: T.corrRust(0xffffff),
    brick: T.brick(0xffffff),
    mats: M,
    s,
    T,
  };
  switch (R) {
    case 'east': {
      const ukr = f === 'ukraine';
      return {
        ...common,
        R,
        wall: T.concreteDark(0xffffff),
        wallB: T.concreteDark(0xe8e2d4),
        wall2: ukr ? T.plaster(0xe2cf92) : T.brick(0xffffff),
        base: T.concreteDark(0x9a968e),
        trim: T.concrete(0xb8b4aa),
        roof: T.asphalt(0xb0aaa0),
        pitch: T.corrRust(0xd8c8b0),
        slab: T.concreteDark(0xd8d4cc, 1.2),
        asphalt: T.asphalt(0xffffff),
        concrete: T.concrete(0xc0bcb2),
        accent: M.col(ukr ? 0x3a5a8a : 0x3f5e3a, 0.7, 0.2), // painted gates (Soviet green / Ukrainian blue)
        door: M.col(0x4a5a3c, 0.75, 0.3),
        rollup: T.corrRust(0x9aa08a),
        tank: M.col(0x9ea08e, 0.6, 0.35),
        crane: M.col(0xd09a2a, 0.65, 0.3),
        tile: M.col(0xa83228, 0.7, 0.1),
        dome: T.panel(0xb4b8ba),
      };
    }
    case 'asia': {
      const kor = f === 'korea';
      const trimC = kor ? 0x2f7a5a : 0xa8261e;
      return {
        ...common,
        R,
        wall: T.plaster(0xf2f2ee),
        wallB: T.plaster(0xe6e8e6),
        wall2: T.concrete(0xd8dcdc),
        base: T.concrete(0x8e9294),
        trim: M.col(trimC, 0.55, 0.1),
        roof: T.concrete(0xa2a8aa),
        pitch: T.tiles(kor ? 0x6d7f9e : 0x5fae96),
        slab: T.concrete(0xd4d6d4, 1.2),
        asphalt: T.asphalt(0xffffff),
        concrete: T.concrete(0xd0d0cc),
        accent: M.col(trimC, 0.55, 0.1),
        door: M.col(kor ? 0x2a4f6e : 0x7a1e1a, 0.6, 0.2),
        rollup: T.corr(kor ? 0x7a96b8 : 0x8ab0a4),
        tank: M.col(0xe8ecec, 0.45, 0.3),
        crane: M.col(0xe0b020, 0.6, 0.3),
        tile: M.col(kor ? 0x2a6a8e : 0x2f8a6e, 0.6, 0.1),
        dome: T.panel(0xeef2f2),
      };
    }
    case 'mideast': {
      const tur = f === 'turkey';
      return {
        ...common,
        R,
        wall: T.plaster(tur ? 0xeee2c8 : 0xe6cfa2),
        wallB: T.plaster(tur ? 0xe2d4b4 : 0xdcc396),
        wall2: T.sandstone(tur ? 0xf0e4cc : 0xffffff),
        base: T.sandstone(0xb8a27a),
        trim: T.sandstone(0xf4e8d0),
        roof: T.plaster(0xd6c6a6),
        pitch: T.plaster(0xd0bc96),
        slab: T.concrete(0xe0cfa8, 1.2),
        asphalt: T.asphalt(0xd8ccb0),
        concrete: T.concrete(0xe0d4b8),
        accent: M.col(tur ? 0xb8202e : 0x1f9a8e, 0.5, 0.1),
        door: M.col(0x6a4a2a, 0.8, 0.05),
        rollup: T.corr(0xd8c8a4),
        tank: M.col(0xe8e2d4, 0.5, 0.3),
        crane: M.col(0xe8c040, 0.6, 0.3),
        tile: M.canvas('tb' + f, texTileBand(tur ? 0x1f5fa8 : 0x1f9aa0, tur ? 0xb8202e : 0x1a3f8a), { uv: 0, rough: 0.35, metal: 0.1 }),
        dome: tur ? T.panel(0x9aa2a8) : T.tiles(0x49c0b8),
      };
    }
    default: {
      // west
      const isr = f === 'israel';
      const ger = f === 'germany';
      const wallT = isr ? 0xf2ead8 : ger ? 0xd2d2ce : 0xe0d6c0;
      return {
        ...common,
        R: 'west',
        wall: isr ? T.sandstone(0xfaf2e0, 2.2) : T.concrete(wallT),
        wallB: T.concrete(shade(wallT, 0.93)),
        wall2: T.panel(ger ? 0x9ea694 : isr ? 0xc8ccd0 : 0xa9b4bc),
        base: T.concrete(0x8e8c88),
        trim: M.col(0x8a9096, 0.4, 0.6),
        roof: T.concrete(0x8e9092, 1.6),
        pitch: T.corr(ger ? 0x6c7466 : 0x8a9298),
        slab: T.concrete(0xd8d6d0, 1.2),
        asphalt: T.asphalt(0xffffff),
        concrete: T.concrete(0xd2d0ca),
        accent: M.col(s.accent, 0.6, 0.2),
        door: M.col(0x5a6066, 0.5, 0.5),
        rollup: T.corr(0xc8ccce),
        tank: M.col(0xdadcda, 0.45, 0.4),
        crane: M.col(0xf0c020, 0.55, 0.3),
        tile: M.col(s.accent, 0.6, 0.2),
        dome: T.panel(0xf2f2f0),
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
}

// ================================================================ build kit

const IDENT = new THREE.Matrix4();
const KEEP = new Set(['position', 'normal', 'uv']);

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
  private bins = new Map<THREE.Object3D, Map<Mat, THREE.BufferGeometry[]>>();
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

  // ------------------------------------------------------------ core
  add(g: THREE.BufferGeometry, m: Mat, uv?: number) {
    let geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    geo.applyMatrix4(this.T);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const scale = uv ?? (m.userData.uv as number | undefined) ?? 3;
    if (scale > 0) worldUV(geo, scale);
    else if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    for (const name of Object.keys(geo.attributes)) if (!KEEP.has(name)) geo.deleteAttribute(name);
    geo.clearGroups();
    geo.morphAttributes = {};
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
  k.box(wall, W, h, D, cx, y0, cz);
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
  if (P.R === 'east') {
    // drain pipe
    k.cyl(P.galv, 0.008, h, x1 + 0.01, y0, z1 - 0.03, 6);
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
      k.at(0, yc, zc, 0, () => k.box(roofM, L + 2 * over, t, sl, 0, -0.002, 0), sg * a);
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
  };
}

const _v = new THREE.Vector3();

function instance(t: Tpl): Model {
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
  const bound: { sp: AnimSpec; o: THREE.Object3D | undefined; base: number }[] = t.specs.map((sp) => {
    const o = sp.k === 'pump' ? undefined : find(sp.n);
    let base = 0;
    if (o && (sp.k === 'osc' || sp.k === 'slide')) base = sp.k === 'osc' ? o.rotation[sp.ax] : o.position[sp.ax];
    return { sp, o, base };
  });
  const pumps = t.specs
    .filter((sp): sp is Extract<AnimSpec, { k: 'pump' }> => sp.k === 'pump')
    .map((sp) => ({ sp, crank: find(sp.crank), beam: find(sp.beam), rod: find(sp.rod), pit: find(sp.pit), phase: 0 }));
  const glow = t.glow as SMat[];
  const flags = t.flags;
  let wasPowered = true;
  const anim = (s: AnimState) => {
    const pw = s.powered;
    if (pw !== wasPowered || s.built < 1) {
      wasPowered = pw;
    }
    const f = pw ? 1 : 0.22;
    for (const g of glow) g.emissiveIntensity = (g.userData.baseEI as number) * f;
    for (const fm of flags) (fm.userData.uTime as { value: number }).value = s.time;
    if (s.built < 1) return;
    const t0 = s.time;
    for (const b of bound) {
      const { sp, o } = b;
      if (!o) continue;
      switch (sp.k) {
        case 'spin':
          o.rotation[sp.ax] += sp.v * s.dt * (pw ? 1 : 0.15);
          break;
        case 'osc':
          o.rotation[sp.ax] = b.base + sp.b + sp.a * Math.sin(t0 * sp.f + sp.p);
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
      const sp = p.sp;
      p.phase += s.dt * 2.2;
      const a = p.phase;
      if (p.crank) p.crank.rotation.z = -a;
      const th = sp.amp * Math.sin(a);
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
    }
  };
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
    const top = block(k, { x0: hx0, x1: hx1, z0: hz0, z1: hz1, h: 0.48, door: -0.75, roof: 'asian', rise: 0.3 });
    void top;
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
    k.box(P.team, hx1 - hx0, 0.012, 0.155, (hx0 + hx1) / 2, Y0 + 0.275, hz1 + 0.062);
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
    const roofM = R === 'west' ? P.T.corr(0x9aa3a8) : R === 'asia' ? P.T.corr(0x5f86b8) : P.roof;
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
