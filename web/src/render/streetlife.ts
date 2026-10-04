import * as THREE from 'three';
import { Tile, type GameMap } from '../sim/map';
import { hash2 } from '../sim/rng';
import type { FogOfWar } from './fog';
import { GeoBuilder, chunkedInstances, type Inst, type SceneryLod } from './geo';
import { surfaceHeight } from './ground';
import { FieldType, type Layout } from './layout';

/*
 * City street dressing (urban maps, render only): stone kerbs along the
 * painted streets (a few runs painted red / white or blue / white, as the
 * local parking rules have it), and a street market on the city squares:
 * stalls with striped canopies or big umbrellas, heaps of produce, hand
 * painted signs in the local language (Hebrew; fictional stall names, no
 * brands), and cafe tables with parasols round the edges.
 *
 * Cost: kerbs one merged mesh; stalls one merged mesh + one sign mesh
 * (canvas atlas); cafe sets and parasols one instanced draw each. The
 * market and cafes are hidden at far zoom.
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const C = (h: number) => new THREE.Color(h);

/** Market signs: fictional stalls, local language (the city's: Hebrew). */
const SIGNS = [
  { t: 'ירקות טריים', bg: '#f4d03f', fg: '#b03a2e' },
  { t: 'פירות העונה', bg: '#ffffff', fg: '#1e8449' },
  { t: 'תבלינים ופיצוחים', bg: '#7b241c', fg: '#fdebd0' },
  { t: 'דגים טריים', bg: '#2e86c1', fg: '#ffffff' },
  { t: 'פרחים', bg: '#f5b7b1', fg: '#78281f' },
  { t: 'מאפים חמים', bg: '#f0b27a', fg: '#4a235a' },
  { t: 'גבינות וזיתים', bg: '#fcf3cf', fg: '#145a32' },
  { t: 'הכל ב-10 ₪', bg: '#e74c3c', fg: '#ffffff' },
  { t: 'מיצים טבעיים', bg: '#58d68d', fg: '#0b3d20' },
  { t: 'הדוכן של רינה', bg: '#ffffff', fg: '#1a5276' },
  { t: 'אצל שלומי', bg: '#f9e79f', fg: '#6e2c00' },
  { t: 'קפה ותה', bg: '#4e342e', fg: '#ffe0b2' },
];
const SIGN_ROWS = 6;
const SIGN_COLS = 2;

function signAtlas(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  const cw = c.width / SIGN_COLS;
  const ch = c.height / SIGN_ROWS;
  SIGNS.forEach((s, i) => {
    const x = (i % SIGN_COLS) * cw;
    const y = Math.floor(i / SIGN_COLS) * ch;
    g.fillStyle = s.bg;
    g.fillRect(x, y, cw, ch);
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 3;
    g.strokeRect(x + 2, y + 2, cw - 4, ch - 4);
    g.fillStyle = s.fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.direction = 'rtl';
    let size = 30;
    const font = (px: number) => `bold ${px}px "Noto Sans Hebrew", "Noto Sans", "DejaVu Sans", "FreeSans", Arial, sans-serif`;
    g.font = font(size);
    while (size > 12 && g.measureText(s.t).width > cw - 16) g.font = font((size -= 2));
    g.fillText(s.t, x + cw / 2, y + ch / 2 + 1);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const PRODUCE = [0xd8341e, 0xf08a1a, 0x5a9a2a, 0x5a2a5a, 0xf2d43a, 0x8a6a3a, 0x2a6a2a, 0xe85a6a];
const CANOPY = [0xc0392b, 0x2471a3, 0x229954, 0xd4ac0d, 0x7d3c98, 0xe67e22];

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const UNIT_BALL = new THREE.IcosahedronGeometry(1, 0);

/** A stall: table with produce, canopy (striped) or none (it gets an umbrella), sign over the front. Local +z faces the shoppers. */
function stall(b: GeoBuilder, signs: GeoBuilder, M: THREE.Matrix4, seed: number, canopy: boolean) {
  const put = (g: THREE.BufferGeometry, x: number, y: number, z: number, sx: number, sy: number, sz: number, c: THREE.Color, rx = 0) =>
    b.add(g, M.clone().multiply(new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, 0, 0)), V(sx, sy, sz))), null, c);
  const h = (k: number) => hash2(seed, k, 5101);
  const W = 0.42;
  // trestle table with a cloth skirt
  put(UNIT_BOX, 0, 0.085, 0, W, 0.012, 0.2, C(0x9a7a52));
  put(UNIT_BOX, 0, 0.045, 0.098, W, 0.08, 0.004, C([0x2a5a8a, 0x8a2a2a, 0x3a6a3a, 0xd8d0c0][Math.floor(h(1) * 4)]));
  for (const sx of [-1, 1]) put(UNIT_BOX, (sx * W) / 2 - sx * 0.01, 0.04, -0.08, 0.01, 0.08, 0.01, C(0x5a4a3a));
  // produce: crates with heaped tops
  const n = 4;
  for (let i = 0; i < n; i++) {
    const x = -W / 2 + (W * (i + 0.5)) / n;
    const col = C(PRODUCE[Math.floor(h(10 + i) * PRODUCE.length)]);
    put(UNIT_BOX, x, 0.105, 0.02, W / n - 0.015, 0.03, 0.15, C(0xb89a6a));
    put(UNIT_BALL, x, 0.12, 0.02, W / n / 2 - 0.01, 0.022, 0.07, col);
  }
  // crates stacked behind
  for (let i = 0; i < 2; i++) put(UNIT_BOX, -0.12 + i * 0.22, 0.03 + (h(20 + i) < 0.5 ? 0 : 0), -0.16, 0.1, 0.06, 0.07, C(0xa88a5a));
  if (!canopy) return;
  const cc = C(CANOPY[Math.floor(h(2) * CANOPY.length)]);
  const white = C(0xf2efe6);
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ])
    put(UNIT_BOX, (sx * W) / 2, sz > 0 ? 0.12 : 0.14, sz * 0.12, 0.008, sz > 0 ? 0.24 : 0.28, 0.008, C(0x6a6a6a));
  // striped canopy sloping to the front
  const ns = 6;
  for (let i = 0; i < ns; i++) put(UNIT_BOX, -W / 2 - 0.02 + ((W + 0.04) * (i + 0.5)) / ns, 0.265, 0, (W + 0.04) / ns, 0.008, 0.3, i % 2 ? white : cc, 0.16);
  // the sign: a quad on the canopy's front edge, cut from the atlas
  const s = Math.floor(h(3) * SIGNS.length);
  const u0 = (s % SIGN_COLS) / SIGN_COLS;
  const v1 = 1 - Math.floor(s / SIGN_COLS) / SIGN_ROWS;
  const v0 = v1 - 1 / SIGN_ROWS;
  const u1 = u0 + 1 / SIGN_COLS;
  const nrm = V(0, 0, 1).transformDirection(M);
  const p = (x: number, y: number) => V(x, y, 0.152).applyMatrix4(M);
  const sw = W * 0.86;
  const a = signs.vert(p(-sw / 2, 0.29), nrm, u0, v1, 1);
  const bb = signs.vert(p(sw / 2, 0.29), nrm, u1, v1, 1);
  const c = signs.vert(p(-sw / 2, 0.235), nrm, u0, v0, 1);
  const d = signs.vert(p(sw / 2, 0.235), nrm, u1, v0, 1);
  signs.quad(a, bb, c, d);
}

/** Cafe set: a round table and three chairs (merged, instanced). */
function cafeSet(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const metal = C(0x3a3a3a);
  g.add(new THREE.CylinderGeometry(0.045, 0.045, 0.008, 10), new THREE.Matrix4().makeTranslation(0, 0.075, 0), null, C(0xf0ece4));
  g.add(new THREE.CylinderGeometry(0.005, 0.005, 0.075, 5), new THREE.Matrix4().makeTranslation(0, 0.037, 0), null, metal);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    const m4 = new THREE.Matrix4().compose(V(Math.cos(a) * 0.08, 0, Math.sin(a) * 0.08), new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), -a + Math.PI / 2), V(1, 1, 1));
    const chair = C(i % 2 ? 0xc8a878 : 0x9a5a3a);
    g.add(new THREE.BoxGeometry(0.04, 0.006, 0.04).translate(0, 0.045, 0), m4, null, chair);
    g.add(new THREE.BoxGeometry(0.04, 0.04, 0.006).translate(0, 0.068, 0.02), m4, null, chair);
    for (const [lx, lz] of [
      [-0.016, -0.016],
      [0.016, -0.016],
      [-0.016, 0.016],
      [0.016, 0.016],
    ])
      g.add(new THREE.BoxGeometry(0.004, 0.045, 0.004).translate(lx, 0.022, lz), m4, null, metal);
  }
  return g.build();
}

/** Parasol: pole and an eight-panel canopy (white vertex colour: tinted per instance). */
function parasol(r: number, hgt: number): THREE.BufferGeometry {
  const g = new GeoBuilder();
  g.add(new THREE.CylinderGeometry(0.005, 0.005, hgt, 5).translate(0, hgt / 2, 0), new THREE.Matrix4(), null, C(0x5a5a5a));
  const cone = new THREE.ConeGeometry(r, r * 0.35, 8, 1, true).translate(0, hgt, 0);
  g.add(cone, new THREE.Matrix4(), null, (p) => (Math.floor(((Math.atan2(p.z, p.x) / (Math.PI * 2) + 1) * 8 + 0.5)) % 2 ? 1 : 0.86));
  return g.build();
}

export function buildStreetLife(m: GameMap, layout: Layout, fog: FogOfWar, quality: 'low' | 'medium' | 'high', lod?: SceneryLod): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  if (m.biome !== 'urban') return out;
  const W = m.w;
  const H = m.h;
  const tileOk = (x: number, z: number) => {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 0 || tz < 0 || tx >= W || tz >= H) return false;
    const t = m.tiles[tz * W + tx];
    return t !== Tile.Water && t !== Tile.Bridge;
  };

  // ---- kerbs along the painted streets (broken at the crossings and the canal)
  const crossings = layout.fields.filter((f) => f.type === FieldType.Crossing);
  const inCrossing = (x: number, z: number) => crossings.some((f) => Math.abs(x - f.cx) < f.hl + 0.05 && Math.abs(z - f.cy) < f.hw + 0.05);
  const kb = new GeoBuilder();
  const stone = C(0xbab6ae);
  const red = C(0xc0392b);
  const blue = C(0x2e5f9e);
  const white = C(0xf0eee8);
  let run = 0;
  for (const f of layout.fields) {
    if (f.type !== FieldType.Avenue && f.type !== FieldType.Street) continue;
    const ca = Math.cos(f.angle);
    const sa = Math.sin(f.angle);
    for (const side of [-1, 1]) {
      const off = side * 1.27;
      let prev: number[] | null = null;
      run++;
      // a painted run here and there (red / white: no stopping; blue / white: paid parking)
      const paint = hash2(run, Math.floor(f.cx), 5201);
      const pcol = paint < 0.15 ? red : paint < 0.28 ? blue : null;
      const step = 0.25;
      for (let a = -f.hl; a <= f.hl + 1e-6; a += step) {
        const x = f.cx + ca * a - sa * off;
        const z = f.cy + sa * a + ca * off;
        if (!tileOk(x, z) || inCrossing(x, z) || m.starts.some((s) => Math.hypot(s.x + 0.5 - x, s.y + 0.5 - z) < 3)) {
          prev = null;
          continue;
        }
        const gy = surfaceHeight(m, x, z);
        const k = Math.round((a + f.hl) / step);
        const col = pcol && k % 2 ? pcol : pcol ? white : stone.clone().multiplyScalar(0.92 + hash2(k, run, 5202) * 0.12);
        // across: road side (lower, the face) .. pavement side
        const nx = -sa * side;
        const nz = ca * side;
        const pts = [
          [-0.03, 0.0],
          [-0.03, 0.03],
          [0.03, 0.03],
        ];
        const ids = pts.map(([o, y], i) => kb.vert(V(x + nx * o, gy + y, z + nz * o), i === 0 ? V(-nx, 0.2, -nz).normalize() : V(0, 1, 0), 0, 0, col));
        if (prev) {
          kb.quad(prev[1], ids[1], prev[0], ids[0]);
          kb.quad(prev[2], ids[2], prev[1], ids[1]);
        }
        prev = ids;
      }
    }
  }
  if (kb.count) {
    const mesh = new THREE.Mesh(kb.build(), fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide })));
    mesh.receiveShadow = true;
    mesh.name = 'city-kerbs';
    out.push(mesh);
    if (lod) lod.add([mesh], mesh.geometry, null, Infinity, quality === 'high' ? 40 : 30);
  }

  // ---- market and cafes on the city squares (not the bases' plazas)
  if (quality === 'low') return out;
  const sb = new GeoBuilder();
  const signB = new GeoBuilder();
  const umbrellas: Inst[] = [];
  const cafes: Inst[] = [];
  const parasols: Inst[] = [];
  const free = (x: number, z: number) => {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (!tileOk(x, z)) return false;
    const i = tz * W + tx;
    return !m.blocked[i] && !m.trees[i] && !m.ore[i] && !m.oreKind[i];
  };
  (m.deco?.plazas ?? []).forEach((p, pi) => {
    const cx = (p.x0 + p.x1) / 2;
    const cy = (p.y0 + p.y1) / 2;
    if (m.starts.some((s) => Math.hypot(s.x + 0.5 - cx, s.y + 0.5 - cy) < 16)) return;
    // two rows of stalls facing each other across the square, a gap in the middle
    for (const sz of [-1, 1]) {
      const z = sz > 0 ? p.y1 - 0.85 : p.y0 + 0.85;
      let k = 0;
      for (let x = p.x0 + 1.1; x <= p.x1 - 1.1; x += 0.62) {
        k++;
        if (Math.abs(x - cx) < 0.7 || !free(x, z) || !free(x, z - sz * 0.3)) continue;
        const seed = pi * 131 + k * 7 + (sz > 0 ? 1 : 0);
        const gy = surfaceHeight(m, x, z);
        // the stall faces the middle of the square
        const M = new THREE.Matrix4().compose(V(x, gy, z), new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), sz > 0 ? Math.PI : 0), V(1, 1, 1));
        const canopy = hash2(seed, 1, 5103) < 0.6;
        stall(sb, signB, M, seed, canopy);
        if (!canopy) umbrellas.push({ x, y: gy, z, rotY: hash2(seed, 2, 5103) * 6, sx: 1, sy: 1, sz: 1, color: C(CANOPY[Math.floor(hash2(seed, 3, 5103) * CANOPY.length)]) });
      }
    }
    // cafe tables down the other two sides
    for (const sx of [-1, 1]) {
      const x = sx > 0 ? p.x1 - 0.75 : p.x0 + 0.75;
      let k = 0;
      for (let z = p.y0 + 1.7; z <= p.y1 - 1.7; z += 0.42) {
        k++;
        if (Math.abs(z - cy) < 0.6) continue;
        for (const dx of [0, -sx * 0.32]) {
          const xx = x + dx;
          const zz = z + (dx ? 0.2 : 0);
          if (!free(xx, zz)) continue;
          const seed = pi * 71 + k * 5 + (dx ? 3 : 0) + (sx > 0 ? 1 : 0);
          const gy = surfaceHeight(m, xx, zz);
          cafes.push({ x: xx, y: gy, z: zz, rotY: hash2(seed, 1, 5104) * 6.28, sx: 1, sy: 1, sz: 1 });
          if (hash2(seed, 2, 5104) < 0.55) parasols.push({ x: xx, y: gy, z: zz, rotY: 0, sx: 1, sy: 1, sz: 1, color: C(hash2(pi, sx, 5105) < 0.5 ? 0xf2efe6 : CANOPY[Math.floor(hash2(pi, sx, 5106) * CANOPY.length)]) });
        }
      }
    }
  });
  const hideAt = quality === 'high' ? 34 : 26;
  const reg = (o: THREE.Mesh) => {
    out.push(o);
    if (lod) lod.add([o], o.geometry, null, Infinity, hideAt);
  };
  if (sb.count) {
    const mesh = new THREE.Mesh(sb.build(), fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 })));
    mesh.castShadow = quality === 'high';
    mesh.receiveShadow = true;
    mesh.name = 'city-market';
    reg(mesh);
  }
  if (signB.count) {
    const mat = fog.apply(new THREE.MeshStandardMaterial({ map: signAtlas(), roughness: 0.7, side: THREE.DoubleSide }));
    const mesh = new THREE.Mesh(signB.build(), mat);
    mesh.name = 'city-market';
    reg(mesh);
  }
  const instMat = fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, side: THREE.DoubleSide }));
  if (umbrellas.length) for (const im of chunkedInstances(parasol(0.28, 0.3), instMat, umbrellas, 96, { castShadow: quality === 'high', name: 'city-market' })) reg(im);
  if (parasols.length) for (const im of chunkedInstances(parasol(0.13, 0.17), instMat, parasols, 96, { castShadow: quality === 'high', name: 'city-cafes' })) reg(im);
  if (cafes.length) for (const im of chunkedInstances(cafeSet(), fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.2 })), cafes, 96, { name: 'city-cafes' })) reg(im);
  return out;
}
