import * as THREE from 'three';
import { drawFlag } from '../flags';

/*
 * National insignia, flag patches and stencil digits drawn once with Canvas 2D
 * into a single 1024 x 1024 atlas. Every decal in the game (aircraft roundels,
 * vehicle hull numbers, flag patches, chevrons) samples this one texture, so a
 * model's markings merge into ONE extra mesh / draw call.
 *
 * Decal quads are white vertex-coloured by default; digits and chevrons are
 * drawn white so the vertex colour picks white / black / yellow stencils.
 */

export type Nation = 'usa' | 'israel' | 'china' | 'russia' | 'germany' | 'korea' | 'ukraine' | 'turkey' | 'iran';

/** UV rectangle [u0, v0, u1, v1] (v up, CanvasTexture flipY) + width / height aspect. */
export interface Cell {
  r: [number, number, number, number];
  aspect: number;
}

const N = 1024;
const C = 128; // cell size
const TAU = Math.PI * 2;

type Ctx = CanvasRenderingContext2D;

/** Pixel rect -> UV cell. */
function px(x: number, y: number, w: number, h: number): Cell {
  return { r: [x / N, 1 - (y + h) / N, (x + w) / N, 1 - y / N], aspect: w / h };
}

// ------------------------------------------------------------ layout

const ROUNDEL: Record<Nation, Cell> = {
  usa: px(4, 4, 248, 120), // star-and-bar, full colour (2 cells)
  israel: px(4 * C + 4, 4, 120, 120),
  china: px(5 * C + 4, 4, 120, 120),
  russia: px(6 * C + 4, 4, 120, 120),
  germany: px(7 * C + 4, 4, 120, 120),
  korea: px(4, C + 4, 120, 120),
  ukraine: px(C + 4, C + 4, 120, 120),
  turkey: px(2 * C + 4, C + 4, 120, 120),
  iran: px(3 * C + 4, C + 4, 120, 120),
};
const USA_LOWVIS = px(2 * C + 4, 4, 248, 120);
const CHEVRON = px(4 * C + 4, C + 4, 120, 120);
const STAR = px(5 * C + 4, C + 4, 120, 120);
const TRIDENT = px(6 * C + 4, C + 4, 120, 120);
const BAND = px(7 * C + 8, C + 8, 112, 112); // plain white square (team / ID band, tintable)
const FLAG_ORDER: Nation[] = ['usa', 'israel', 'china', 'russia', 'germany', 'korea', 'ukraine', 'turkey', 'iran'];
function flagCell(i: number): Cell {
  const cx = (i % 8) * C;
  const cy = (2 + Math.floor(i / 8)) * C;
  return px(cx + 4, cy + 24, 120, 80);
}
function digitCell(d: number): Cell {
  return px(d * 64 + 4, 4 * C + 4, 56, 120);
}

export function roundelCell(n: string, lowVis = false): Cell {
  if (n === 'usa' && lowVis) return USA_LOWVIS;
  return ROUNDEL[(n in ROUNDEL ? n : 'usa') as Nation];
}
export function flagPatchCell(n: string): Cell {
  const i = FLAG_ORDER.indexOf(n as Nation);
  return flagCell(i < 0 ? 0 : i);
}
export const chevronCell = (): Cell => CHEVRON;
export const starCell = (): Cell => STAR;
export const tridentCell = (): Cell => TRIDENT;
export const bandCell = (): Cell => BAND;
export const digit = (d: number): Cell => digitCell(((d % 10) + 10) % 10);

// ------------------------------------------------------------ drawing

function starPath(c: Ctx, x: number, y: number, r: number, rot = 0) {
  const inner = r * 0.382;
  c.beginPath();
  for (let k = 0; k < 10; k++) {
    const rr = k % 2 ? inner : r;
    const a = rot - Math.PI / 2 + (k / 10) * TAU;
    const px2 = x + Math.cos(a) * rr;
    const py2 = y + Math.sin(a) * rr;
    if (k) c.lineTo(px2, py2);
    else c.moveTo(px2, py2);
  }
  c.closePath();
}
function disc(c: Ctx, x: number, y: number, r: number, col: string) {
  c.fillStyle = col;
  c.beginPath();
  c.arc(x, y, r, 0, TAU);
  c.fill();
}

/** Star-and-bar in a 256 x 128 box at (x, y). */
function starAndBar(c: Ctx, x: number, y: number, cols: { outline: string; white: string; red: string; blue: string }) {
  const cx = x + 128;
  const cy = y + 64;
  const R = 46;
  const bw = 100; // bar half-length from the centre
  const bh = 19; // bar half-height
  const shape = (grow: number) => {
    c.beginPath();
    c.rect(cx - bw - grow, cy - bh - grow + 4, 2 * (bw + grow), 2 * (bh + grow));
    c.arc(cx, cy, R + grow, 0, TAU);
  };
  c.fillStyle = cols.outline;
  shape(6);
  c.fill();
  c.fillStyle = cols.white;
  c.fillRect(cx - bw, cy - bh + 4, 2 * bw, 2 * bh);
  c.fillStyle = cols.red;
  c.fillRect(cx - bw, cy - 3, 2 * bw, 13);
  disc(c, cx, cy, R, cols.blue);
  c.fillStyle = cols.white;
  starPath(c, cx, cy, R * 0.96);
  c.fill();
}

function magenDavid(c: Ctx, x: number, y: number) {
  disc(c, x, y, 58, '#f4f4f0');
  c.strokeStyle = '#1f4fbf';
  c.lineWidth = 8;
  c.lineJoin = 'miter';
  for (const rot of [0, Math.PI]) {
    c.beginPath();
    for (let i = 0; i < 3; i++) {
      const a = rot - Math.PI / 2 + (i * TAU) / 3;
      const px2 = x + Math.cos(a) * 44;
      const py2 = y + Math.sin(a) * 44;
      if (i) c.lineTo(px2, py2);
      else c.moveTo(px2, py2);
    }
    c.closePath();
    c.stroke();
  }
}

function chinaStar(c: Ctx, x: number, y: number) {
  c.fillStyle = '#e8c021';
  starPath(c, x, y + 4, 62);
  c.fill();
  c.fillStyle = '#c8201e';
  starPath(c, x, y + 4, 53);
  c.fill();
  c.fillStyle = '#f2c62a';
  c.font = 'bold 22px "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText('八一', x, y + 8);
}

function russiaStar(c: Ctx, x: number, y: number) {
  c.fillStyle = '#1f3f9f';
  starPath(c, x, y + 4, 62);
  c.fill();
  c.fillStyle = '#f4f4f0';
  starPath(c, x, y + 4, 56);
  c.fill();
  c.fillStyle = '#d0201c';
  starPath(c, x, y + 4, 45);
  c.fill();
}

/** Bundeswehr Eisernes Kreuz: flared (pattee) black cross with a white border. */
function ironCross(c: Ctx, x: number, y: number) {
  const arm = (L: number, w0: number, w1: number) => {
    c.beginPath();
    for (let k = 0; k < 4; k++) {
      const a = (k * TAU) / 4;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // local: along = ca,sa ; across = -sa,ca
      const P = (al: number, ac: number): [number, number] => [x + ca * al - sa * ac, y + sa * al + ca * ac];
      const p0 = P(0, -w0);
      const p1 = P(L, -w1);
      const p2 = P(L * 0.86, 0);
      const p3 = P(L, w1);
      const pts = [p0, p1, p2, p3];
      for (let i = 0; i < pts.length; i++) {
        if (k === 0 && i === 0) c.moveTo(pts[i][0], pts[i][1]);
        else c.lineTo(pts[i][0], pts[i][1]);
      }
    }
    c.closePath();
  };
  c.fillStyle = '#f4f4f0';
  arm(60, 13, 34);
  c.fill();
  c.fillStyle = '#111111';
  arm(52, 8, 26);
  c.fill();
}

function taegeuk(c: Ctx, x: number, y: number) {
  disc(c, x, y, 60, '#1f3f9f');
  disc(c, x, y, 50, '#f4f4f0');
  const r = 38;
  c.save();
  c.translate(x, y);
  c.rotate(-0.59);
  disc(c, 0, 0, r, '#0f47af');
  c.fillStyle = '#cd2e3a';
  c.beginPath();
  c.arc(0, 0, r, Math.PI, TAU);
  c.fill();
  disc(c, -r / 2, 0, r / 2, '#cd2e3a');
  disc(c, r / 2, 0, r / 2, '#0f47af');
  c.restore();
}

function rings(c: Ctx, x: number, y: number, cols: string[]) {
  const rs = [60, 42, 24];
  cols.forEach((col, i) => disc(c, x, y, rs[i] ?? 20, col));
}

function chevron(c: Ctx, x: number, y: number) {
  c.fillStyle = '#ffffff';
  c.beginPath();
  c.moveTo(x - 54, y - 40);
  c.lineTo(x - 30, y - 40);
  c.lineTo(x, y + 8);
  c.lineTo(x + 30, y - 40);
  c.lineTo(x + 54, y - 40);
  c.lineTo(x, y + 44);
  c.closePath();
  c.fill();
}

/** Ukrainian tryzub (simplified) in yellow on a blue shield. */
function trident(c: Ctx, x: number, y: number) {
  c.fillStyle = '#0057b7';
  c.beginPath();
  c.moveTo(x - 44, y - 54);
  c.lineTo(x + 44, y - 54);
  c.lineTo(x + 44, y + 18);
  c.quadraticCurveTo(x + 40, y + 50, x, y + 60);
  c.quadraticCurveTo(x - 40, y + 50, x - 44, y + 18);
  c.closePath();
  c.fill();
  c.strokeStyle = '#ffd700';
  c.fillStyle = '#ffd700';
  c.lineWidth = 7;
  c.lineCap = 'butt';
  // centre spike
  c.fillRect(x - 4, y - 44, 8, 74);
  // outer tines
  c.beginPath();
  c.moveTo(x - 30, y - 40);
  c.lineTo(x - 30, y + 12);
  c.quadraticCurveTo(x - 28, y + 32, x - 4, y + 32);
  c.moveTo(x + 30, y - 40);
  c.lineTo(x + 30, y + 12);
  c.quadraticCurveTo(x + 28, y + 32, x + 4, y + 32);
  c.stroke();
  c.fillRect(x - 34, y + 30, 68, 8);
}

function digits(c: Ctx) {
  c.fillStyle = '#ffffff';
  c.textAlign = 'center';
  c.textBaseline = 'alphabetic';
  c.font = 'bold 116px "Arial Narrow", "Liberation Sans Narrow", Impact, Arial, sans-serif';
  for (let d = 0; d < 10; d++) {
    const s = String(d);
    const m = c.measureText(s);
    const sx = Math.min(1, 52 / Math.max(1, m.width));
    c.save();
    c.translate(d * 64 + 32, 4 * C + 112);
    c.scale(sx, 1);
    c.fillText(s, 0, 0);
    c.restore();
  }
}

let atlas: THREE.CanvasTexture | null = null;

/** The shared insignia atlas (built on first use). */
export function insigniaAtlas(): THREE.CanvasTexture {
  if (atlas) return atlas;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const c = cv.getContext('2d')!;
  c.clearRect(0, 0, N, N);
  starAndBar(c, 0, 0, { outline: '#1f3a7a', white: '#f4f4f0', red: '#c8202a', blue: '#1f3a7a' });
  starAndBar(c, 2 * C, 0, { outline: '#3d4246', white: '#a9aeb3', red: '#6c7176', blue: '#5e6368' });
  magenDavid(c, 4 * C + 64, 64);
  chinaStar(c, 5 * C + 64, 64);
  russiaStar(c, 6 * C + 64, 64);
  ironCross(c, 7 * C + 64, 64);
  taegeuk(c, 64, C + 64);
  rings(c, C + 64, C + 64, ['#0057b7', '#ffd700']);
  rings(c, 2 * C + 64, C + 64, ['#e30a17', '#f4f4f0', '#e30a17']);
  rings(c, 3 * C + 64, C + 64, ['#239f40', '#f4f4f0', '#da0000']);
  chevron(c, 4 * C + 64, C + 64);
  c.fillStyle = '#ffffff';
  starPath(c, 5 * C + 64, C + 68, 58);
  c.fill();
  trident(c, 6 * C + 64, C + 64);
  c.fillStyle = '#ffffff';
  c.fillRect(7 * C + 4, C + 4, 120, 120);
  FLAG_ORDER.forEach((f, i) => {
    const x = (i % 8) * C + 4;
    const y = (2 + Math.floor(i / 8)) * C + 24;
    c.save();
    c.translate(x, y);
    if (!drawFlag(c, f, 120, 80)) {
      c.fillStyle = '#777';
      c.fillRect(0, 0, 120, 80);
    }
    c.restore();
    c.strokeStyle = 'rgba(20,20,20,0.85)';
    c.lineWidth = 3;
    c.strokeRect(x + 1.5, y + 1.5, 117, 77);
  });
  digits(c);
  atlas = new THREE.CanvasTexture(cv);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 4;
  atlas.generateMipmaps = true;
  atlas.minFilter = THREE.LinearMipmapLinearFilter;
  atlas.magFilter = THREE.LinearFilter;
  return atlas;
}

/** Base decal material (not fog / wear patched: callers cache + patch it). */
export function makeDecalMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map: insigniaAtlas(),
    vertexColors: true,
    alphaTest: 0.42,
    roughness: 0.72,
    metalness: 0.08,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
}

// ------------------------------------------------------------ geometry

const _c = new THREE.Color();
const _n = new THREE.Vector3();

/**
 * One decal quad centred at `c`, spanning `w` along unit vector `u` and `h`
 * along unit vector `v` (normal = u x v). Non-indexed, position / normal / uv / color.
 */
export function decalQuad(c: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3, w: number, h: number, cell: Cell, color = 0xffffff): THREE.BufferGeometry {
  const [u0, v0, u1, v1] = cell.r;
  const hw = w / 2;
  const hh = h / 2;
  const P = (a: number, b: number) => [c.x + u.x * a + v.x * b, c.y + u.y * a + v.y * b, c.z + u.z * a + v.z * b];
  const p00 = P(-hw, -hh);
  const p10 = P(hw, -hh);
  const p11 = P(hw, hh);
  const p01 = P(-hw, hh);
  const pos = [...p00, ...p10, ...p11, ...p00, ...p11, ...p01];
  const uv = [u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1];
  _n.crossVectors(u, v).normalize();
  const nor: number[] = [];
  const col: number[] = [];
  _c.setHex(color);
  for (let i = 0; i < 6; i++) {
    nor.push(_n.x, _n.y, _n.z);
    col.push(_c.r, _c.g, _c.b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/** A row of stencil digits (height h) centred at c, reading along u. */
export function numberQuads(c: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3, h: number, text: string, color: number): THREE.BufferGeometry[] {
  const w = h * 0.47;
  const gap = h * 0.08;
  const total = text.length * w + (text.length - 1) * gap;
  const out: THREE.BufferGeometry[] = [];
  const p = new THREE.Vector3();
  for (let i = 0; i < text.length; i++) {
    const d = text.charCodeAt(i) - 48;
    if (d < 0 || d > 9) continue;
    const off = -total / 2 + w / 2 + i * (w + gap);
    p.copy(c).addScaledVector(u, off);
    out.push(decalQuad(p, u, v, w, h, digit(d), color));
  }
  return out;
}

/** Deterministic hash -> [0, 1). */
export function hash01(n: number): number {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
