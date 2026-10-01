import * as THREE from 'three';
import type { FogOfWar } from './fog';

/*
 * Procedural PBR texture library. Every texture is generated on a canvas at
 * start-up (no image assets): an albedo map, a height field turned into a
 * normal map, and a roughness map. All textures tile seamlessly.
 *
 * Use pbrMaterial() to get a cached MeshStandardMaterial, and worldUV() on
 * geometries so texel density is constant regardless of the primitive size.
 */

export type TexKind =
  | 'concrete' // light grey cast concrete, optional panel seams
  | 'concreteDark' // Soviet-style precast panels with rain streaks
  | 'plaster' // smooth stucco (Middle East / Mediterranean)
  | 'sandstone' // coursed sandstone blocks
  | 'brick' // generic brick bond
  | 'corrugated' // corrugated metal sheet (vertical ridges)
  | 'metalPanel' // painted steel plates with seams and rivets
  | 'roofTiles' // curved clay/ceramic roof tiles (East Asian)
  | 'asphalt'
  | 'windows' // window grid; also yields an emissive map with random lit panes
  | 'camo' // vehicle camouflage, pattern chosen by opts.pattern
  | 'tread' // tank track links (tiles along U)
  | 'rubber'
  | 'sandbag'
  | 'wood'
  | 'canvas' // tarpaulin / tent fabric
  | 'grating' // steel floor grating
  | 'rust'
  | 'soil';

export type CamoPattern = 'woodland' | 'desert' | 'digital' | 'flecktarn' | 'plain' | 'urban';

export interface TexOpts {
  color?: number; // primary colour
  color2?: number;
  color3?: number;
  color4?: number;
  pattern?: CamoPattern;
  seed?: number;
  /** concrete panels per tile, window columns/rows, etc. */
  divisions?: number;
  /** 0..1 dirt / weathering amount */
  grime?: number;
  size?: number;
}

export interface PbrSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
  emissiveMap?: THREE.Texture;
}

// ------------------------------------------------------------------ noise

function hash(x: number, y: number, s: number) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Periodic value noise: tiles with period p (in noise cells). */
function pnoise(x: number, y: number, p: number, s: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const m = (a: number) => ((a % p) + p) % p;
  const a = hash(m(xi), m(yi), s);
  const b = hash(m(xi + 1), m(yi), s);
  const c = hash(m(xi), m(yi + 1), s);
  const d = hash(m(xi + 1), m(yi + 1), s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Periodic fBm over the unit square [0,1)^2 with base frequency f (integer). */
function fbm(u: number, v: number, f: number, s: number, oct = 4) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = f;
  for (let i = 0; i < oct; i++) {
    sum += pnoise(u * freq, v * freq, freq, s + i * 31) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

const rgb = (c: number): [number, number, number] => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// ------------------------------------------------------------- generation

interface Fields {
  N: number;
  col: Float32Array; // rgb
  h: Float32Array; // height 0..1
  r: Float32Array; // roughness 0..1
  e?: Float32Array; // emissive rgb
}

function newFields(N: number, emissive = false): Fields {
  return { N, col: new Float32Array(N * N * 3), h: new Float32Array(N * N), r: new Float32Array(N * N), e: emissive ? new Float32Array(N * N * 3) : undefined };
}

type Painter = (u: number, v: number, out: { c: [number, number, number]; h: number; r: number; e?: [number, number, number] }) => void;

function paint(F: Fields, fn: Painter) {
  const { N } = F;
  const o = { c: [0, 0, 0] as [number, number, number], h: 0, r: 0.8, e: F.e ? ([0, 0, 0] as [number, number, number]) : undefined };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      o.h = 0.5;
      o.r = 0.8;
      if (o.e) o.e[0] = o.e[1] = o.e[2] = 0;
      fn((x + 0.5) / N, (y + 0.5) / N, o);
      F.col[i * 3] = o.c[0];
      F.col[i * 3 + 1] = o.c[1];
      F.col[i * 3 + 2] = o.c[2];
      F.h[i] = o.h;
      F.r[i] = o.r;
      if (F.e && o.e) {
        F.e[i * 3] = o.e[0];
        F.e[i * 3 + 1] = o.e[1];
        F.e[i * 3 + 2] = o.e[2];
      }
    }
  }
}

function toTexture(N: number, data: (i: number) => [number, number, number], srgb: boolean): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(N, N);
  for (let i = 0; i < N * N; i++) {
    const [r, g, b] = data(i);
    img.data[i * 4] = Math.max(0, Math.min(255, r * 255));
    img.data[i * 4 + 1] = Math.max(0, Math.min(255, g * 255));
    img.data[i * 4 + 2] = Math.max(0, Math.min(255, b * 255));
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

function finish(F: Fields, normalStrength: number): PbrSet {
  const { N, h } = F;
  const nrm = new Float32Array(N * N * 3);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const at = (xx: number, yy: number) => h[((yy + N) % N) * N + ((xx + N) % N)];
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) * normalStrength;
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) * normalStrength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * N + x) * 3;
      nrm[i] = (-dx / len) * 0.5 + 0.5;
      nrm[i + 1] = (dy / len) * 0.5 + 0.5;
      nrm[i + 2] = (1 / len) * 0.5 + 0.5;
    }
  }
  const set: PbrSet = {
    map: toTexture(N, (i) => [F.col[i * 3], F.col[i * 3 + 1], F.col[i * 3 + 2]], true),
    normalMap: toTexture(N, (i) => [nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]], false),
    roughnessMap: toTexture(N, (i) => [0, F.r[i], 0], false),
  };
  if (F.e) set.emissiveMap = toTexture(N, (i) => [F.e![i * 3], F.e![i * 3 + 1], F.e![i * 3 + 2]], true);
  return set;
}

function grimeAt(u: number, v: number, s: number, amt: number) {
  // large soft blotches + vertical streaks
  const blot = fbm(u, v, 4, s + 900, 4);
  const streak = fbm(u * 1, v * 0.15, 16, s + 950, 3);
  return clamp01((blot - 0.45) * 1.6 + (streak - 0.5) * 0.6) * amt;
}

const GEN: Record<TexKind, (F: Fields, o: Required<Pick<TexOpts, 'seed' | 'grime' | 'divisions'>> & TexOpts) => number> = {
  concrete(F, o) {
    const base = rgb(o.color ?? 0x9c9a94);
    const div = o.divisions || 2;
    paint(F, (u, v, out) => {
      const n = fbm(u, v, 8, o.seed, 5);
      const fine = hash(Math.floor(u * F.N), Math.floor(v * F.N), o.seed) - 0.5;
      const pu = (u * div) % 1;
      const pv = (v * div) % 1;
      const seam = Math.min(pu, 1 - pu, pv, 1 - pv) < 0.006 ? 1 : 0;
      const pores = hash(Math.floor(u * F.N), Math.floor(v * F.N), o.seed + 7) > 0.985 ? 1 : 0;
      const g = grimeAt(u, v, o.seed, o.grime);
      const k = 0.86 + n * 0.22 + fine * 0.05 - seam * 0.25 - pores * 0.15 - g * 0.35;
      out.c = [base[0] * k, base[1] * k, base[2] * k];
      out.h = 0.6 + n * 0.25 - seam * 0.5 - pores * 0.3;
      out.r = 0.85 + fine * 0.1;
    });
    return 2.5;
  },
  concreteDark(F, o) {
    const base = rgb(o.color ?? 0x86827a);
    const div = o.divisions || 3;
    paint(F, (u, v, out) => {
      const n = fbm(u, v, 6, o.seed, 5);
      const pu = (u * div) % 1;
      const pv = (v * div) % 1;
      const panelId = Math.floor(u * div) + Math.floor(v * div) * 17;
      const tint = (hash(panelId, 3, o.seed) - 0.5) * 0.12;
      const seam = Math.min(pu, 1 - pu, pv, 1 - pv) < 0.012 ? 1 : 0;
      const streak = smooth(0.4, 0.9, fbm(u, v * 0.1, 24, o.seed + 3, 2)) * (1 - pv) * 0.5;
      const g = grimeAt(u, v, o.seed, o.grime) + streak * o.grime;
      const k = 0.8 + n * 0.25 + tint - seam * 0.35 - g * 0.4;
      out.c = [base[0] * k, base[1] * k, base[2] * k * 0.98];
      out.h = 0.6 + n * 0.2 - seam * 0.6;
      out.r = 0.9;
    });
    return 3;
  },
  plaster(F, o) {
    const base = rgb(o.color ?? 0xd8c7a4);
    paint(F, (u, v, out) => {
      const n = fbm(u, v, 6, o.seed, 5);
      const fine = fbm(u, v, 64, o.seed + 1, 2);
      const g = grimeAt(u, v, o.seed, o.grime);
      const chip = smooth(0.72, 0.76, fbm(u, v, 5, o.seed + 9, 4));
      const k = 0.9 + n * 0.12 + (fine - 0.5) * 0.08 - g * 0.3;
      out.c = [lerp(base[0] * k, 0.62, chip * 0.5), lerp(base[1] * k, 0.52, chip * 0.5), lerp(base[2] * k, 0.42, chip * 0.5)];
      out.h = 0.55 + fine * 0.2 - chip * 0.25;
      out.r = 0.92;
    });
    return 2;
  },
  sandstone(F, o) {
    const base = rgb(o.color ?? 0xcbb48a);
    const rows = o.divisions || 8;
    paint(F, (u, v, out) => {
      const row = Math.floor(v * rows);
      const off = (row % 2) * 0.5;
      const cols = rows / 2;
      const cu = (u * cols + off) % 1;
      const cv = (v * rows) % 1;
      const blockId = Math.floor(u * cols + off) * 31 + row;
      const mortar = Math.min(cu * 2, (1 - cu) * 2, cv, 1 - cv) < 0.06 ? 1 : 0;
      const n = fbm(u, v, 16, o.seed, 4);
      const tint = (hash(blockId, 1, o.seed) - 0.5) * 0.15;
      const g = grimeAt(u, v, o.seed, o.grime);
      const k = 0.85 + n * 0.2 + tint - g * 0.3;
      out.c = mortar ? [base[0] * 0.75, base[1] * 0.72, base[2] * 0.68] : [base[0] * k, base[1] * k, base[2] * k];
      out.h = mortar ? 0.2 : 0.65 + n * 0.25;
      out.r = 0.9;
    });
    return 4;
  },
  brick(F, o) {
    const base = rgb(o.color ?? 0x9a4a32);
    const mortarC = rgb(o.color2 ?? 0xb8ae9c);
    const rows = o.divisions || 16;
    paint(F, (u, v, out) => {
      const row = Math.floor(v * rows);
      const cols = rows / 2;
      const off = (row % 2) * 0.5;
      const cu = (u * cols + off) % 1;
      const cv = (v * rows) % 1;
      const id = Math.floor(u * cols + off) * 13 + row * 7;
      const mortar = cu < 0.05 || cv < 0.12;
      const n = fbm(u, v, 32, o.seed, 3);
      const tint = (hash(id, 2, o.seed) - 0.5) * 0.25;
      const g = grimeAt(u, v, o.seed, o.grime);
      const k = 0.85 + n * 0.2 + tint - g * 0.35;
      out.c = mortar ? [mortarC[0] * (0.9 - g * 0.3), mortarC[1] * (0.9 - g * 0.3), mortarC[2] * (0.9 - g * 0.3)] : [base[0] * k, base[1] * k, base[2] * k];
      out.h = mortar ? 0.25 : 0.7 + n * 0.15;
      out.r = 0.9;
    });
    return 4;
  },
  corrugated(F, o) {
    const base = rgb(o.color ?? 0x8f969a);
    const ribs = o.divisions || 24;
    paint(F, (u, v, out) => {
      const s = Math.sin(u * ribs * Math.PI * 2);
      const n = fbm(u, v, 8, o.seed, 4);
      const rust = smooth(0.62, 0.8, fbm(u, v, 6, o.seed + 5, 4) + (1 - v) * 0.15) * o.grime;
      const streak = smooth(0.5, 0.9, fbm(u, v * 0.1, 30, o.seed + 2, 2)) * 0.25 * o.grime;
      const shade = 0.88 + s * 0.08 + n * 0.1 - streak;
      out.c = [lerp(base[0] * shade, 0.45, rust), lerp(base[1] * shade, 0.24, rust), lerp(base[2] * shade, 0.12, rust)];
      out.h = 0.5 + s * 0.45;
      out.r = lerp(0.45, 0.9, rust);
    });
    return 3;
  },
  metalPanel(F, o) {
    const base = rgb(o.color ?? 0x7d8288);
    const div = o.divisions || 3;
    paint(F, (u, v, out) => {
      const pu = (u * div) % 1;
      const pv = (v * div * 0.75) % 1;
      const seam = Math.min(pu, 1 - pu, pv, 1 - pv);
      const groove = seam < 0.008 ? 1 : 0;
      // rivets along seams
      const ru = (u * div * 12) % 1;
      const rivet = seam > 0.015 && seam < 0.035 && Math.hypot(ru - 0.5, 0) < 0.18 ? 1 : 0;
      const n = fbm(u, v, 8, o.seed, 4);
      const scratch = hash(Math.floor(u * F.N * 0.25), Math.floor(v * F.N), o.seed + 4) > 0.997 ? 1 : 0;
      const g = grimeAt(u, v, o.seed, o.grime);
      const k = 0.88 + n * 0.12 - groove * 0.35 + rivet * 0.1 + scratch * 0.25 - g * 0.3;
      out.c = [base[0] * k, base[1] * k, base[2] * k];
      out.h = 0.5 - groove * 0.45 + rivet * 0.35;
      out.r = 0.5 + n * 0.2 + g * 0.3 - scratch * 0.2;
    });
    return 3;
  },
  roofTiles(F, o) {
    const base = rgb(o.color ?? 0x4a5a5a);
    const rows = o.divisions || 10;
    paint(F, (u, v, out) => {
      const cols = rows * 1.5;
      const cu = (u * cols) % 1;
      const cv = (v * rows) % 1;
      const s = Math.sin(cu * Math.PI);
      const overlap = smooth(0.85, 1, cv);
      const n = fbm(u, v, 16, o.seed, 3);
      const id = Math.floor(u * cols) * 7 + Math.floor(v * rows) * 13;
      const tint = (hash(id, 9, o.seed) - 0.5) * 0.12;
      const g = grimeAt(u, v, o.seed, o.grime);
      const k = (0.7 + s * 0.35) * (1 - overlap * 0.4) + tint + n * 0.08 - g * 0.3;
      out.c = [base[0] * k, base[1] * k, base[2] * k];
      out.h = s * 0.7 + (1 - cv) * 0.25;
      out.r = 0.6;
    });
    return 4;
  },
  asphalt(F, o) {
    const base = rgb(o.color ?? 0x3a3b3d);
    paint(F, (u, v, out) => {
      const n = fbm(u, v, 8, o.seed, 4);
      const grain = hash(Math.floor(u * F.N), Math.floor(v * F.N), o.seed);
      const k = 0.8 + n * 0.3 + (grain - 0.5) * 0.25;
      out.c = [base[0] * k, base[1] * k, base[2] * k];
      out.h = grain * 0.5 + n * 0.3;
      out.r = 0.9;
    });
    return 2;
  },
  windows(F, o) {
    const frame = rgb(o.color ?? 0x3a3e44);
    const glass = rgb(o.color2 ?? 0x2a3a48);
    const lit = rgb(o.color3 ?? 0xffd38a);
    const cols = o.divisions || 4;
    const rows = Math.max(1, Math.round(cols / 2));
    paint(F, (u, v, out) => {
      const cu = (u * cols) % 1;
      const cv = (v * rows) % 1;
      const id = Math.floor(u * cols) + Math.floor(v * rows) * 37;
      const pane = cu > 0.12 && cu < 0.88 && cv > 0.18 && cv < 0.86;
      const mullion = pane && Math.abs(cu - 0.5) < 0.025;
      const on = hash(id, 5, o.seed) < 0.55;
      if (pane && !mullion) {
        const refl = 0.15 + (1 - cv) * 0.25;
        out.c = [glass[0] + refl * 0.3, glass[1] + refl * 0.3, glass[2] + refl * 0.35];
        out.h = 0.3;
        out.r = 0.08;
        if (out.e && on) {
          const flick = 0.7 + hash(id, 8, o.seed) * 0.6;
          out.e = [lit[0] * flick, lit[1] * flick, lit[2] * flick];
        }
      } else {
        const n = fbm(u, v, 8, o.seed, 3);
        out.c = [frame[0] * (0.9 + n * 0.2), frame[1] * (0.9 + n * 0.2), frame[2] * (0.9 + n * 0.2)];
        out.h = 0.7;
        out.r = 0.6;
      }
    });
    return 3;
  },
  camo(F, o) {
    const c1 = rgb(o.color ?? 0x5b6b44);
    const c2 = rgb(o.color2 ?? 0x3f4a2e);
    const c3 = rgb(o.color3 ?? 0x2a2a22);
    const c4 = rgb(o.color4 ?? 0x8a7a5a);
    const pat = o.pattern ?? 'woodland';
    paint(F, (u, v, out) => {
      let c = c1;
      if (pat === 'woodland' || pat === 'desert' || pat === 'urban') {
        const a = fbm(u, v, 3, o.seed, 4);
        const b = fbm(u, v, 4, o.seed + 50, 4);
        if (a > 0.58) c = c2;
        if (b > 0.62) c = c3;
        if (pat !== 'desert' && a < 0.36) c = c4;
      } else if (pat === 'digital') {
        const q = 64;
        const qu = Math.floor(u * q) / q;
        const qv = Math.floor(v * q) / q;
        const a = fbm(qu, qv, 4, o.seed, 3);
        const b = fbm(qu, qv, 6, o.seed + 70, 3);
        if (a > 0.56) c = c2;
        if (b > 0.6) c = c3;
        if (a < 0.38) c = c4;
      } else if (pat === 'flecktarn') {
        const a = fbm(u, v, 4, o.seed, 3);
        const dot = hash(Math.floor(u * 90), Math.floor(v * 90), o.seed + 3);
        if (a > 0.55) c = c2;
        if (dot > 0.82) c = c3;
        else if (dot < 0.08) c = c4;
      }
      const n = fbm(u, v, 16, o.seed + 9, 4);
      const g = grimeAt(u, v, o.seed, o.grime);
      // dust settles low on vehicles (v near 1 = bottom when mapped with worldUV)
      const k = 0.88 + n * 0.18 - g * 0.15;
      const dust = g * 0.6;
      out.c = [lerp(c[0] * k, 0.52, dust), lerp(c[1] * k, 0.46, dust), lerp(c[2] * k, 0.36, dust)];
      out.h = 0.5 + n * 0.15;
      out.r = 0.65 + g * 0.25;
    });
    return 1.5;
  },
  tread(F, o) {
    const steel = rgb(o.color ?? 0x3b3a37);
    const links = o.divisions || 8;
    paint(F, (u, v, out) => {
      const lu = (u * links) % 1;
      const cleat = lu > 0.12 && lu < 0.45;
      const pin = Math.abs(lu - 0.8) < 0.05;
      const guide = Math.abs(v - 0.5) < 0.06 && lu > 0.55 && lu < 0.95;
      const n = fbm(u, v, 8, o.seed, 3);
      const mud = smooth(0.5, 0.7, fbm(u, v, 6, o.seed + 1, 3)) * o.grime;
      const k = cleat ? 1.1 : pin ? 0.6 : 0.8;
      out.c = [lerp(steel[0] * k * (0.9 + n * 0.2), 0.36, mud), lerp(steel[1] * k * (0.9 + n * 0.2), 0.3, mud), lerp(steel[2] * k * (0.9 + n * 0.2), 0.22, mud)];
      out.h = cleat ? 0.9 : guide ? 0.75 : pin ? 0.2 : 0.4;
      out.r = cleat ? 0.45 : 0.75;
    });
    return 4;
  },
  rubber(F, o) {
    const base = rgb(o.color ?? 0x1e1e1e);
    paint(F, (u, v, out) => {
      const n = fbm(u, v, 16, o.seed, 3);
      const lug = Math.sin(u * 40 * Math.PI) > 0.3 ? 1 : 0;
      out.c = [base[0] * (0.9 + n * 0.2), base[1] * (0.9 + n * 0.2), base[2] * (0.9 + n * 0.2)];
      out.h = 0.4 + lug * 0.4;
      out.r = 0.92;
    });
    return 3;
  },
  sandbag(F, o) {
    const base = rgb(o.color ?? 0xa89670);
    paint(F, (u, v, out) => {
      const rows = 6;
      const row = Math.floor(v * rows);
      const cu = (u * 3 + (row % 2) * 0.5) % 1;
      const cv = (v * rows) % 1;
      const bulge = Math.sin(cu * Math.PI) * Math.sin(cv * Math.PI);
      const weave = (Math.sin(u * 400) * Math.sin(v * 400)) * 0.05;
      const n = fbm(u, v, 12, o.seed, 3);
      const k = 0.65 + bulge * 0.45 + n * 0.1 + weave;
      out.c = [base[0] * k, base[1] * k, base[2] * k];
      out.h = bulge;
      out.r = 0.95;
    });
    return 3;
  },
  wood(F, o) {
    const base = rgb(o.color ?? 0x7a5a3a);
    const planks = o.divisions || 6;
    paint(F, (u, v, out) => {
      const pv = (v * planks) % 1;
      const id = Math.floor(v * planks);
      const grain = fbm(u * 0.2 + id * 0.37, v * 4, 8, o.seed + id, 4);
      const gap = pv < 0.04 ? 1 : 0;
      const k = 0.75 + grain * 0.4 + (hash(id, 1, o.seed) - 0.5) * 0.2 - gap * 0.5;
      out.c = [base[0] * k, base[1] * k, base[2] * k];
      out.h = 0.6 + grain * 0.2 - gap * 0.5;
      out.r = 0.85;
    });
    return 2.5;
  },
  canvas(F, o) {
    const base = rgb(o.color ?? 0x6b6a4a);
    paint(F, (u, v, out) => {
      const weave = Math.sin(u * F.N * 1.2) * Math.sin(v * F.N * 1.2) * 0.04;
      const fold = fbm(u, v, 3, o.seed, 4);
      const g = grimeAt(u, v, o.seed, o.grime);
      const k = 0.8 + fold * 0.3 + weave - g * 0.25;
      out.c = [base[0] * k, base[1] * k, base[2] * k];
      out.h = fold;
      out.r = 0.95;
    });
    return 3;
  },
  grating(F, o) {
    const base = rgb(o.color ?? 0x5a5c5e);
    const cells = o.divisions || 16;
    paint(F, (u, v, out) => {
      const cu = (u * cells) % 1;
      const cv = (v * cells * 2) % 1;
      const bar = cu < 0.18 || cv < 0.25;
      out.c = bar ? [base[0], base[1], base[2]] : [0.05, 0.05, 0.05];
      out.h = bar ? 0.8 : 0;
      out.r = bar ? 0.5 : 1;
    });
    return 4;
  },
  rust(F, o) {
    paint(F, (u, v, out) => {
      const n = fbm(u, v, 6, o.seed, 5);
      const m = fbm(u, v, 24, o.seed + 3, 3);
      out.c = [0.42 + n * 0.2, 0.22 + n * 0.1, 0.1 + m * 0.05];
      out.h = n * 0.6 + m * 0.4;
      out.r = 0.9;
    });
    return 2.5;
  },
  soil(F, o) {
    const base = rgb(o.color ?? 0x6a5a40);
    paint(F, (u, v, out) => {
      const n = fbm(u, v, 8, o.seed, 5);
      const pebble = hash(Math.floor(u * 128), Math.floor(v * 128), o.seed) > 0.93 ? 1 : 0;
      const k = 0.75 + n * 0.4 + pebble * 0.15;
      out.c = [base[0] * k, base[1] * k, base[2] * k];
      out.h = n * 0.6 + pebble * 0.4;
      out.r = 0.95;
    });
    return 3;
  },
};

// ------------------------------------------------------------------ cache

const texCache = new Map<string, PbrSet>();
let defaultSize = 512;

/** Lower texture resolution (e.g. 256) for weak devices. Call before generating anything. */
export function setTextureSize(n: number) {
  defaultSize = n;
}

export function pbr(kind: TexKind, opts: TexOpts = {}): PbrSet {
  const key = kind + JSON.stringify(opts);
  let set = texCache.get(key);
  if (!set) {
    const N = opts.size ?? defaultSize;
    const F = newFields(N, kind === 'windows');
    const strength = GEN[kind](F, { seed: opts.seed ?? 1, grime: opts.grime ?? 0.4, divisions: opts.divisions ?? 0, ...opts });
    set = finish(F, strength);
    texCache.set(key, set);
  }
  return set;
}

export interface MatOpts extends TexOpts {
  metalness?: number;
  roughness?: number; // multiplier over the roughness map
  normalScale?: number;
  emissiveIntensity?: number; // only for 'windows'
  side?: THREE.Side;
  transparent?: boolean;
  opacity?: number;
}

const matCache = new Map<string, THREE.MeshStandardMaterial>();
const fogIds = new WeakMap<FogOfWar, number>();
let fogCounter = 0;

/**
 * Cached PBR material. Texture repeat is NOT set here: use worldUV() on the
 * geometry so 1 texture tile = 1 / uvScale world units.
 */
export function pbrMaterial(kind: TexKind, opts: MatOpts = {}, fog: FogOfWar | null = null): THREE.MeshStandardMaterial {
  let fid = 0;
  if (fog) {
    if (!fogIds.has(fog)) fogIds.set(fog, ++fogCounter);
    fid = fogIds.get(fog)!;
  }
  const key = `${fid}:${kind}:${JSON.stringify(opts)}`;
  let m = matCache.get(key);
  if (!m) {
    const { metalness, roughness, normalScale, emissiveIntensity, side, transparent, opacity, ...tex } = opts;
    const set = pbr(kind, tex);
    m = new THREE.MeshStandardMaterial({
      map: set.map,
      normalMap: set.normalMap,
      roughnessMap: set.roughnessMap,
      roughness: roughness ?? 1,
      metalness: metalness ?? (kind === 'metalPanel' || kind === 'corrugated' || kind === 'tread' || kind === 'grating' ? 0.55 : 0.02),
      normalScale: new THREE.Vector2(normalScale ?? 1, normalScale ?? 1),
      side: side ?? THREE.FrontSide,
      transparent: transparent ?? false,
      opacity: opacity ?? 1,
    });
    if (set.emissiveMap) {
      m.emissiveMap = set.emissiveMap;
      m.emissive = new THREE.Color(0xffffff);
      m.emissiveIntensity = emissiveIntensity ?? 1.6;
    }
    if (fog) fog.apply(m);
    matCache.set(key, m);
  }
  return m;
}

/**
 * Box-project UVs from vertex positions so texel density is uniform:
 * one texture repeat per `1 / scale` world units. Call after the geometry
 * has its final size (before or after translation, but in the space the
 * mesh will be scaled 1:1). Returns the same geometry.
 */
export function worldUV<T extends THREE.BufferGeometry>(geo: T, scale = 1, offset: [number, number, number] = [0, 0, 0]): T {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + offset[0];
    const y = pos.getY(i) + offset[1];
    const z = pos.getZ(i) + offset[2];
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    let u: number;
    let v: number;
    if (ny >= nx && ny >= nz) {
      u = x;
      v = z;
    } else if (nx >= nz) {
      u = z;
      v = -y;
    } else {
      u = x;
      v = -y;
    }
    uv[i * 2] = u * scale;
    uv[i * 2 + 1] = v * scale;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/** Camouflage scheme per faction (colours tuned to real-world paint schemes). */
export function factionCamo(faction: string): TexOpts {
  switch (faction) {
    case 'usa':
      return { pattern: 'plain', color: 0xb8a57c, color2: 0xa8946a, color3: 0x8c7a56, color4: 0xc4b48c, grime: 0.5 }; // CARC tan
    case 'israel':
      return { pattern: 'plain', color: 0x9e9a7e, color2: 0x8f8a6e, color3: 0x7a7660, color4: 0xaaa68a, grime: 0.55 }; // Sinai grey
    case 'germany':
      return { pattern: 'woodland', color: 0x4b5a38, color2: 0x5e4a36, color3: 0x1f2018, color4: 0x4b5a38, grime: 0.45 }; // NATO 3-tone
    case 'russia':
      return { pattern: 'woodland', color: 0x56663e, color2: 0x3e4a2c, color3: 0x26261c, color4: 0x8a8060, grime: 0.55 };
    case 'ukraine':
      return { pattern: 'digital', color: 0x5f6a3e, color2: 0x464f2e, color3: 0x2c2e22, color4: 0x857a58, grime: 0.55 };
    case 'china':
      return { pattern: 'digital', color: 0x5d6b47, color2: 0x3d4a2e, color3: 0x26281e, color4: 0x8a8462, grime: 0.4 };
    case 'korea':
      return { pattern: 'woodland', color: 0x56623f, color2: 0x3a4430, color3: 0x22241c, color4: 0x7a6a4a, grime: 0.45 };
    case 'turkey':
      return { pattern: 'woodland', color: 0x6b7356, color2: 0x4a5040, color3: 0x2a2c24, color4: 0x8c8a70, grime: 0.45 };
    case 'iran':
      return { pattern: 'desert', color: 0xb19a6c, color2: 0x8a7552, color3: 0x6a5a40, color4: 0xc8b48a, grime: 0.55 };
    default:
      return { pattern: 'plain', color: 0x8a8070, grime: 0.4 };
  }
}
