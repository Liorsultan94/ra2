import * as THREE from 'three';
import { Tile, type GameMap } from '../sim/map';
import { hash2 } from '../sim/rng';
import type { FogOfWar } from './fog';
import { GeoBuilder, chunkedInstances, type Inst, type SceneryLod } from './geo';
import { surfaceHeight } from './ground';
import { FieldType, type Field, type Layout } from './layout';
import { windTime } from './treekinds';

/*
 * Countryside crops on the farm fields (render only; the sim never sees
 * them): standing wheat in rows that sway in the wind, orchards, vineyards,
 * plastic greenhouse tunnels, desert farm estates (long fields, vineyards,
 * groves and a windbreak), and a tractor or two working a field.
 *
 * The ground shader already paints every field (soil, rows, tramlines);
 * this adds the third dimension on top. Cost: crops are merged per 32-tile
 * chunk into one mesh per material (crops, greenhouses), the orchard trees
 * are chunked instances, each pivot arm / tractor is one small mesh. The
 * wind sway is a vertex shader on a per-vertex `flex` weight (0 at the foot,
 * 1 at the ear), driven by the shared foliage wind clock. Standing crops drop
 * out when zoomed far out (the painted fields carry the look there).
 */

export type Crop = 'plain' | 'wheat' | 'stubble' | 'orchard' | 'vineyard' | 'greenhouse';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const C = (h: number) => new THREE.Color(h);

/**
 * What grows on field #k of the layout (deterministic). Grazing animals use the
 * green / fallow fields (ambient/animals.ts): greenhouses and vineyards only go
 * on ploughed land; orchards are grazed under, which is fine. Harvested wheat
 * (stubble) is where scenery.ts drops the hay bales.
 */
export function cropOf(m: GameMap, f: Field, k: number): Crop {
  if (f.type >= FieldType.Plaza) return 'plain';
  const biome = m.biome;
  const r = hash2(k, Math.floor(f.cx * 4), 4401);
  if (biome === 'winter') {
    // under snow: a few polytunnels by the farms, stubble elsewhere
    if (f.type === FieldType.Plowed && r < 0.18) return 'greenhouse';
    return f.type === FieldType.Wheat ? 'stubble' : 'plain';
  }
  if (f.type === FieldType.Wheat) return hash2(k, 0, 44) < 0.3 ? 'stubble' : 'wheat';
  if (f.type === FieldType.Plowed) {
    if (biome === 'desert') return r < (f.plot ? 0.75 : 0.6) ? 'greenhouse' : r < 0.85 ? 'vineyard' : 'plain';
    return f.plot ? (r < 0.5 ? 'greenhouse' : 'vineyard') : r < 0.3 ? 'vineyard' : r < 0.5 ? 'greenhouse' : 'plain';
  }
  if (f.type === FieldType.Green) return r < (f.plot ? 0.6 : biome === 'desert' ? 0.45 : 0.35) ? 'orchard' : 'plain';
  return 'plain';
}

// ------------------------------------------------------------------ materials

const SWAY_VERT = /* glsl */ `
#include <begin_vertex>
{
  // travelling gust waves over the crop (down-wind), plus a fast flutter
  vec2 wdir = vec2( 0.8, 0.6 );
  float along = dot( position.xz, wdir );
  float gust = sin( windTime * 0.9 - along * 0.55 ) * 0.5 + 0.5;
  gust *= gust;
  float flutter = sin( windTime * 3.1 + position.x * 4.7 + position.z * 3.9 ) * 0.25;
  float sw = flex * ( 0.25 + gust * 0.9 + flutter ) * cropSway;
  transformed.xz += wdir * sw;
  transformed.y -= abs( sw ) * 0.35;
  vSway = flex * gust;
}
`;

/** Crop material: vertex colours, wind sway on `flex`, a sheen on the gust crests. */
function cropMaterial(fog: FogOfWar, sway: number, rough = 0.92): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: rough, metalness: 0, side: THREE.DoubleSide });
  const swayU = { value: sway };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.windTime = windTime;
    sh.uniforms.cropSway = swayU;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float flex;\nuniform float windTime;\nuniform float cropSway;\nvarying float vSway;')
      .replace('#include <begin_vertex>', SWAY_VERT);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vSway;')
      // the bent-over ears catch the light: the rolling sheen over a wheat field
      // (plus a fine grain of ears / leaves so the rows do not read as smooth plastic ridges)
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\ndiffuseColor.rgb *= ( 1.0 + vSway * 0.22 ) * ( 0.8 + 0.36 * ( texture2D( fogNoise, vFogP.xz * 3.1 ).r * 0.55 + texture2D( fogNoise, vFogP.xz * 11.0 ).g * 0.45 ) );',
      );
  };
  fog.apply(mat);
  mat.customProgramCacheKey = () => 'fog2-cropsway2';
  return mat;
}

// ------------------------------------------------------------------ geometry helpers

/** Local field frame: (a along the rows, b across) to world x / z. */
function frame(f: Field) {
  const ca = Math.cos(f.angle);
  const sa = Math.sin(f.angle);
  return (a: number, b: number) => ({ x: f.cx + ca * a - sa * b, z: f.cy + sa * a + ca * b });
}

/** Is the field point plantable (not water / rock / a structure / a tree tile)? */
function plantable(m: GameMap, x: number, z: number) {
  const tx = Math.floor(x);
  const tz = Math.floor(z);
  if (tx < 0 || tz < 0 || tx >= m.w || tz >= m.h) return false;
  const i = tz * m.w + tx;
  const t = m.tiles[i];
  return t !== Tile.Water && t !== Tile.Bridge && t !== Tile.Rock && !m.blocked[i] && !m.trees[i];
}

/**
 * Crop rows along the field: A-shaped ridges (`h` tall, `w` half-width at the foot) every `gap`
 * across, following the ground in 0.5-tile steps. Ear vertices get flex 1 (they sway), feet 0.
 * `box`: flat-topped hedges lifted by `lift` (vine canopies on their trellis).
 */
function ridges(b: GeoBuilder, m: GameMap, f: Field, gap: number, h: number, w: number, lo: THREE.Color, hi: THREE.Color, seed: number, lift = 0, box = false) {
  const P = frame(f);
  const ca = Math.cos(f.angle);
  const sa = Math.sin(f.angle);
  const nRows = Math.max(1, Math.floor((f.hw * 2 - 0.2) / gap));
  const b0 = -((nRows - 1) * gap) / 2;
  const hl = f.hl - 0.12;
  const nSeg = Math.max(1, Math.ceil((hl * 2) / 0.5));
  const tmp = new THREE.Color();
  const nx = -sa;
  const nz = ca;
  for (let r = 0; r < nRows; r++) {
    const bb = b0 + r * gap;
    let prev: number[] | null = null;
    for (let s = 0; s <= nSeg; s++) {
      const a = -hl + (s / nSeg) * hl * 2;
      const c = P(a, bb);
      if (!plantable(m, c.x, c.z)) {
        prev = null;
        continue;
      }
      const g = surfaceHeight(m, c.x, c.z);
      const hv = h * (0.82 + hash2(seed + r, s, 4411) * 0.36);
      const tone = 0.9 + hash2(seed + r, s, 4412) * 0.2;
      tmp.copy(hi).multiplyScalar(tone);
      const ids: number[] = [];
      if (box) {
        const y0 = g + lift;
        ids.push(b.vert(V(c.x - nx * w, y0, c.z - nz * w), V(-nx * 0.7, 0.7, -nz * 0.7), 0, 0, lo, 0.2));
        ids.push(b.vert(V(c.x - nx * w * 0.8, y0 + hv, c.z - nz * w * 0.8), V(-nx * 0.4, 0.9, -nz * 0.4), 0, 1, tmp, 0.6));
        ids.push(b.vert(V(c.x + nx * w * 0.8, y0 + hv, c.z + nz * w * 0.8), V(nx * 0.4, 0.9, nz * 0.4), 0, 1, tmp, 0.6));
        ids.push(b.vert(V(c.x + nx * w, y0, c.z + nz * w), V(nx * 0.7, 0.7, nz * 0.7), 0, 0, lo, 0.2));
      } else {
        ids.push(b.vert(V(c.x - nx * w, g + lift, c.z - nz * w), V(-nx * 0.45, 0.9, -nz * 0.45), 0, 0, lo, 0));
        ids.push(b.vert(V(c.x, g + lift + hv, c.z), V(0, 1, 0), 0, 1, tmp, 1));
        ids.push(b.vert(V(c.x + nx * w, g + lift, c.z + nz * w), V(nx * 0.45, 0.9, nz * 0.45), 0, 0, lo, 0));
      }
      if (prev) for (let q = 0; q < ids.length - 1; q++) b.quad(prev[q], ids[q], prev[q + 1], ids[q + 1]);
      prev = ids;
    }
  }
}

/** Plastic tunnels along the field: half-round hoops, ends closed, a door at one end. */
function tunnels(b: GeoBuilder, m: GameMap, f: Field, seed: number) {
  const P = frame(f);
  const ca = Math.cos(f.angle);
  const sa = Math.sin(f.angle);
  const span = 0.46;
  const r = 0.2;
  const hgt = 0.2;
  const n = Math.max(1, Math.floor((f.hw * 2 - 0.1) / span));
  const b0 = -((n - 1) * span) / 2;
  const seg = 8;
  const hl = f.hl - 0.15;
  const nS = Math.max(1, Math.ceil((hl * 2) / 0.45));
  const at = (s: number) => -hl + (s / nS) * hl * 2;
  for (let t = 0; t < n; t++) {
    // some tunnels are older (milky yellow / greenish film)
    const age = hash2(seed, t, 4421);
    const film = age < 0.2 ? C(0xd8d4b8) : age < 0.35 ? C(0xc8dcd8) : C(0xeef2f2);
    const bb = b0 + t * span;
    // tunnels split where something is in the way (a tree tile, a structure)
    const ok: boolean[] = [];
    for (let s = 0; s <= nS; s++) {
      const c = P(at(s), bb);
      ok.push(plantable(m, c.x, c.z) && plantable(m, c.x - sa * r, c.z + ca * r) && plantable(m, c.x + sa * r, c.z - ca * r));
    }
    const runs: [number, number][] = [];
    let start = 0;
    for (let s = 0; s <= nS + 1; s++) {
      if (s <= nS && ok[s]) continue;
      if (s - 1 > start) runs.push([start, s - 1]);
      start = s + 1;
    }
    for (const [s0, s1] of runs) {
      // one base height per run (built on levelled ground)
      let gy = 1e9;
      for (let s = s0; s <= s1; s++) {
        const c = P(at(s), bb);
        gy = Math.min(gy, surfaceHeight(m, c.x, c.z));
      }
      gy -= 0.01;
      const rings: number[][] = [];
      for (let s = s0; s <= s1; s++) {
        const rib = s % 2 === 0 ? 0.86 : 1;
        const ring: number[] = [];
        for (let k = 0; k <= seg; k++) {
          const th = (k / seg) * Math.PI;
          const cb = Math.cos(th);
          const sy = Math.sin(th);
          const c = P(at(s), bb + cb * r);
          const col = film.clone().multiplyScalar(rib * (0.94 + sy * 0.06));
          ring.push(b.vert(V(c.x, gy + sy * hgt, c.z), V(-sa * cb, sy, ca * cb).normalize(), 0, 0, col, 0));
        }
        rings.push(ring);
      }
      for (let i = 0; i < rings.length - 1; i++) for (let k = 0; k < seg; k++) b.quad(rings[i][k], rings[i][k + 1], rings[i + 1][k], rings[i + 1][k + 1]);
      // end walls, a door on the far end
      for (const [s, dir] of [
        [s0, -1],
        [s1, 1],
      ] as const) {
        const a = at(s);
        const c0 = P(a, bb);
        const nrm = V(ca * dir, 0, sa * dir);
        const endC = film.clone().multiplyScalar(0.8);
        const centre = b.vert(V(c0.x, gy, c0.z), nrm, 0, 0, endC, 0);
        const ids: number[] = [];
        for (let k = 0; k <= seg; k++) {
          const th = (k / seg) * Math.PI;
          const c = P(a, bb + Math.cos(th) * r);
          ids.push(b.vert(V(c.x, gy + Math.sin(th) * hgt, c.z), nrm, 0, 0, endC, 0));
        }
        for (let k = 0; k < seg; k++) b.tri(centre, ids[k], ids[k + 1]);
        if (dir > 0) {
          const q = [
            [-0.05, 0],
            [0.05, 0],
            [-0.05, 0.12],
            [0.05, 0.12],
          ].map(([db, y]) => {
            const w = P(a + 0.005, bb + db);
            return b.vert(V(w.x, gy + y, w.z), nrm, 0, 0, C(0x3a3c36), 0);
          });
          b.quad(q[2], q[3], q[0], q[1]);
        }
      }
    }
  }
}

// ------------------------------------------------------------------ orchard trees

type TreeKind = 'apple' | 'olive' | 'citrus';

function orchardTree(kind: TreeKind): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const trunk = C(kind === 'olive' ? 0x5a5048 : 0x4a3a2c);
  g.add(new THREE.CylinderGeometry(0.012, 0.018, 0.12, 5).translate(0, 0.06, 0), new THREE.Matrix4(), null, trunk);
  const leaf = C(kind === 'olive' ? 0x8c9a78 : kind === 'citrus' ? 0x4a7a3a : 0x6a9a48);
  const cy = kind === 'olive' ? 0.15 : 0.17;
  const sx = kind === 'olive' ? 0.15 : 0.12;
  const sy = kind === 'olive' ? 0.085 : 0.1;
  const c0 = V(0, cy, 0);
  g.add(new THREE.IcosahedronGeometry(1, 1), new THREE.Matrix4().compose(c0, new THREE.Quaternion(), V(sx, sy, sx)), null, (p) => leaf.clone().multiplyScalar(0.8 + Math.max(0, p.y - cy) * 3), {
    normalFn: (p) => p.clone().sub(c0).normalize(),
    flexFn: (p) => Math.max(0, (p.y - 0.08) * 3),
  });
  if (kind !== 'olive') {
    // fruit: a few dots on the crown
    const fruit = C(kind === 'citrus' ? 0xf09020 : 0xc02a1a);
    for (let i = 0; i < 6; i++) {
      const a = i * 2.4;
      const y = cy + Math.cos(i * 1.7) * sy * 0.5;
      const rr = sx * Math.sqrt(1 - ((y - cy) / sy) ** 2) * 0.96;
      g.add(new THREE.OctahedronGeometry(0.016, 0), new THREE.Matrix4().makeTranslation(Math.cos(a) * rr, y, Math.sin(a) * rr), null, fruit);
    }
  }
  return g.build(true);
}

// ------------------------------------------------------------------ tractors

function tractorGeometry(paint: THREE.Color): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color) => g.add(new THREE.BoxGeometry(w, h, d), new THREE.Matrix4().makeTranslation(x, y, z), null, c);
  const dark = C(0x26262a);
  const tyre = C(0x1c1c1e);
  const hub = C(0xd8c040);
  // bonnet / engine (front = +x), chassis, cab
  box(0.17, 0.07, 0.085, 0.07, 0.1, 0, paint);
  box(0.03, 0.05, 0.08, 0.16, 0.09, 0, dark); // grille
  box(0.26, 0.03, 0.07, 0.03, 0.06, 0, dark);
  box(0.11, 0.012, 0.125, -0.075, 0.235, 0, C(0xe8e8e4)); // cab roof
  box(0.1, 0.1, 0.11, -0.075, 0.175, 0, C(0x5a7080)); // cab glass
  for (const [x, z] of [
    [-0.125, -0.055],
    [-0.125, 0.055],
    [-0.025, -0.055],
    [-0.025, 0.055],
  ])
    box(0.012, 0.12, 0.012, x, 0.175, z, paint);
  box(0.09, 0.04, 0.12, -0.075, 0.11, 0, paint); // cab floor / fenders
  for (const s of [-1, 1]) box(0.11, 0.012, 0.05, -0.075, 0.15, s * 0.075, paint); // rear mudguards
  g.add(new THREE.CylinderGeometry(0.006, 0.006, 0.09, 5), new THREE.Matrix4().makeTranslation(0.09, 0.18, 0.03), null, dark); // exhaust
  const wheel = (r: number, w: number, x: number, z: number) => {
    g.add(new THREE.CylinderGeometry(r, r, w, 12).rotateX(Math.PI / 2), new THREE.Matrix4().makeTranslation(x, r, z), null, tyre);
    g.add(new THREE.CylinderGeometry(r * 0.5, r * 0.5, w + 0.004, 8).rotateX(Math.PI / 2), new THREE.Matrix4().makeTranslation(x, r, z), null, hub);
  };
  for (const s of [-1, 1]) {
    wheel(0.072, 0.04, -0.075, s * 0.075);
    wheel(0.042, 0.026, 0.1, s * 0.058);
  }
  // implement on the three-point hitch: a harrow
  box(0.03, 0.02, 0.03, -0.16, 0.07, 0, dark);
  box(0.06, 0.03, 0.28, -0.2, 0.04, 0, C(0xc86a20));
  for (let i = -3; i <= 3; i++) box(0.012, 0.04, 0.012, -0.21, 0.02, i * 0.04, dark);
  return g.build();
}

interface TractorRoute {
  pts: { x: number; z: number }[];
  cum: number[];
  len: number;
}

/** Back-and-forth passes along the field rows with U-turns on the headlands. */
function tractorRoute(f: Field): TractorRoute {
  const P = frame(f);
  const pts: { x: number; z: number }[] = [];
  const passGap = 0.4;
  const hl = f.hl - 0.45;
  const n = Math.max(2, Math.floor((f.hw * 2 - 0.5) / passGap) + 1);
  const b0 = -((n - 1) * passGap) / 2;
  for (let i = 0; i < n; i++) {
    const dir = i % 2 === 0 ? 1 : -1;
    const bb = b0 + i * passGap;
    for (let s = 0; s <= 8; s++) pts.push(P(dir * (-hl + (s / 8) * hl * 2), bb));
    if (i < n - 1)
      for (let k = 1; k < 6; k++) {
        const th = (k / 6) * Math.PI;
        pts.push(P(dir * (hl + Math.sin(th) * passGap * 0.5), bb + (1 - Math.cos(th)) * passGap * 0.5));
      }
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return { pts, cum, len: cum[cum.length - 1] };
}

// ------------------------------------------------------------------ desert estates

/** Vine rows on trellis posts (a vineyard field). */
function vineyard(b: GeoBuilder, m: GameMap, f: Field, k: number, desert: boolean) {
  const leaf = C(desert ? 0x6a8434 : 0x587a2a);
  ridges(b, m, f, 0.34, 0.07, 0.035, leaf.clone().multiplyScalar(0.55), leaf, k * 31, 0.05, true);
  // trellis posts every ~1 tile
  const P = frame(f);
  const nRows = Math.max(1, Math.floor((f.hw * 2 - 0.2) / 0.34));
  const b0 = -((nRows - 1) * 0.34) / 2;
  const len = f.hl * 2 - 0.24;
  const nP = Math.max(1, Math.ceil(len / 1.0));
  for (let r = 0; r < nRows; r++)
    for (let i = 0; i <= nP; i++) {
      const c = P(-len / 2 + (i / nP) * len, b0 + r * 0.34);
      if (!plantable(m, c.x, c.z)) continue;
      b.add(new THREE.BoxGeometry(0.012, 0.14, 0.012), new THREE.Matrix4().makeTranslation(c.x, surfaceHeight(m, c.x, c.z) + 0.06, c.z), null, C(0x6a5a46));
    }
}

/** Orchard trees on a grid over the field. */
function orchard(m: GameMap, f: Field, k: number, kind: TreeKind, trees: Record<TreeKind, Inst[]>) {
  const P = frame(f);
  const sp = kind === 'olive' ? 0.62 : 0.52;
  const nA = Math.max(1, Math.floor((f.hl * 2 - 0.3) / sp) + 1);
  const nB = Math.max(1, Math.floor((f.hw * 2 - 0.3) / sp) + 1);
  for (let i = 0; i < nA; i++)
    for (let j = 0; j < nB; j++) {
      const c = P(-((nA - 1) * sp) / 2 + i * sp, -((nB - 1) * sp) / 2 + j * sp);
      if (!plantable(m, c.x, c.z) || hash2(k * 97 + i, j, 4442) < 0.04) continue;
      const s = 0.85 + hash2(k * 97 + i, j, 4443) * 0.3;
      const tone = 0.88 + hash2(k * 97 + i, j, 4444) * 0.24;
      trees[kind].push({ x: c.x, y: surfaceHeight(m, c.x, c.z) - 0.01, z: c.z, rotY: hash2(i, j, 4445 + k) * 6.28, sx: s, sy: s * (0.9 + hash2(i, j, 4446) * 0.2), sz: s, color: new THREE.Color(tone, tone, tone) });
    }
}

/** A flat bed of soil under a field (the open desert ground is not painted as farmland), following the ground. */
function soilBed(b: GeoBuilder, m: GameMap, f: Field, col: THREE.Color, seed: number) {
  const P = frame(f);
  const nA = Math.max(1, Math.ceil((f.hl * 2) / 0.5));
  const nB = Math.max(1, Math.ceil((f.hw * 2) / 0.5));
  const ids: number[][] = [];
  for (let i = 0; i <= nA; i++) {
    const row: number[] = [];
    for (let j = 0; j <= nB; j++) {
      const c = P(-f.hl + (i / nA) * f.hl * 2, -f.hw + (j / nB) * f.hw * 2);
      const tone = 0.9 + hash2(seed + i, j, 4451) * 0.18;
      row.push(b.vert(V(c.x, surfaceHeight(m, c.x, c.z) + 0.012, c.z), V(0, 1, 0), 0, 0, col.clone().multiplyScalar(tone), 0));
    }
    ids.push(row);
  }
  for (let i = 0; i < nA; i++) for (let j = 0; j < nB; j++) b.quad(ids[i + 1][j + 1], ids[i][j + 1], ids[i + 1][j], ids[i][j]);
}

/** Low-frequency 0..1 noise over the map (ripeness patches, soil moisture). */
function patchNoise(x: number, z: number, seed: number) {
  const fx = Math.floor(x * 0.8);
  const fz = Math.floor(z * 0.8);
  const tx = x * 0.8 - fx;
  const tz = z * 0.8 - fz;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const a = hash2(fx, fz, seed);
  const b = hash2(fx + 1, fz, seed);
  const c = hash2(fx, fz + 1, seed);
  const d = hash2(fx + 1, fz + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/**
 * Crop rows with the look of a real field: the colour drifts in patches (ripeness, moisture), a pair of tractor
 * tramlines left bare every few rows, row ends ragged at the headlands, plants of different heights.
 */
function cropRows(b: GeoBuilder, m: GameMap, f: Field, o: { gap: number; h: number; w: number; lo: THREE.Color; hi: THREE.Color; alt: THREE.Color; sway: number; tram: number; seed: number }) {
  const P = frame(f);
  const ca = Math.cos(f.angle);
  const sa = Math.sin(f.angle);
  const nx = -sa;
  const nz = ca;
  const nRows = Math.max(1, Math.floor((f.hw * 2 - 0.12) / o.gap));
  const b0 = -((nRows - 1) * o.gap) / 2;
  const tmp = new THREE.Color();
  for (let r = 0; r < nRows; r++) {
    if (o.tram && r % o.tram === Math.floor(o.tram / 2)) continue;
    const bb = b0 + r * o.gap;
    // ragged headlands: each row stops a little short at either end
    const e0 = -f.hl + 0.08 + hash2(o.seed + r, 1, 4471) * 0.14;
    const e1 = f.hl - 0.08 - hash2(o.seed + r, 2, 4471) * 0.14;
    const nSeg = Math.max(1, Math.ceil((e1 - e0) / 0.22));
    let prev: number[] | null = null;
    for (let s = 0; s <= nSeg; s++) {
      const a = e0 + (s / nSeg) * (e1 - e0);
      const c = P(a, bb);
      if (!plantable(m, c.x, c.z)) {
        prev = null;
        continue;
      }
      const g = surfaceHeight(m, c.x, c.z) + 0.012;
      const pn = patchNoise(c.x, c.z, o.seed);
      const fine = hash2(o.seed + r, s, 4472);
      // the odd gap in a row (a missed seed, a trodden patch)
      const hv = o.h * (0.7 + pn * 0.45) * (0.8 + fine * 0.4) * (fine < 0.025 ? 0.25 : 1);
      tmp.copy(o.hi).lerp(o.alt, Math.max(0, Math.min(1, pn * 1.4 - 0.25))).multiplyScalar(0.9 + hash2(o.seed + r, s, 4473) * 0.2);
      const ids = [
        b.vert(V(c.x - nx * o.w, g, c.z - nz * o.w), V(-nx * 0.45, 0.9, -nz * 0.45), 0, 0, o.lo, 0),
        b.vert(V(c.x, g + hv, c.z), V(0, 1, 0), 0, 1, tmp.clone(), o.sway),
        b.vert(V(c.x + nx * o.w, g, c.z + nz * o.w), V(nx * 0.45, 0.9, nz * 0.45), 0, 0, o.lo, 0),
      ];
      if (prev) for (let q = 0; q < 2; q++) b.quad(prev[q], ids[q], prev[q + 1], ids[q + 1]);
      prev = ids;
    }
  }
}

const _bm = new THREE.Matrix4();
const _bq = new THREE.Quaternion();
const _by = new THREE.Vector3(0, 1, 0);
/** A box standing on the ground at (x, z): `w` along the heading `ang`, `d` across, `h` tall, its foot at `y0`. */
function box(b: GeoBuilder, x: number, y0: number, z: number, w: number, d: number, h: number, ang: number, col: number | THREE.Color) {
  _bq.setFromAxisAngle(_by, -ang);
  _bm.compose(V(x, y0 + h / 2, z), _bq, V(1, 1, 1));
  b.add(new THREE.BoxGeometry(w, h, d), _bm, null, typeof col === 'number' ? C(col) : col);
}

/** A farmstead: whitewashed farmhouse with a tiled hip roof, a tin shed, a water tank on legs, stacked hay bales. */
function farmstead(b: GeoBuilder, m: GameMap, at: (u: number, v: number) => { x: number; y: number }, u0: number, ang: number, k: number, sideW: number) {
  const h = (q: number) => hash2(k, q, 4481);
  const gy = (p: { x: number; y: number }) => surfaceHeight(m, p.x, p.y);
  // the yard: packed earth
  const yard: Field = { ...(() => { const c = at(u0, 0); return { cx: c.x, cy: c.y }; })(), hl: 0.5, hw: sideW, angle: ang, type: FieldType.Plowed };
  soilBed(b, m, yard, C(0xc4ac80), k * 7 + 3);
  // the house: walls, a darker plinth, windows and a door, the hip roof
  const hv = h(1) < 0.5 ? 1 : -1;
  const hp = at(u0, hv * sideW * 0.45);
  const y = gy(hp) + 0.005;
  const HW = 0.5;
  const HD = 0.36;
  const HH = 0.24;
  box(b, hp.x, y, hp.y, HW + 0.02, HD + 0.02, 0.035, ang, 0xa89a84);
  box(b, hp.x, y, hp.y, HW, HD, HH, ang, 0xeee6d6);
  const roof = new THREE.ConeGeometry(Math.hypot(HW, HD) * 0.56, 0.16, 4, 1);
  roof.rotateY(Math.PI / 4);
  roof.scale(HW / HD, 1, 1);
  _bq.setFromAxisAngle(_by, -ang);
  _bm.compose(V(hp.x, y + HH + 0.08, hp.y), _bq, V(1, 1, 1));
  b.add(roof, _bm, null, C(0xb4583a));
  // windows and a door on the long sides
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  for (const side of [-1, 1])
    for (const wx of [-0.15, 0, 0.15]) {
      const door = side === 1 && wx === 0;
      const px = hp.x + ca * wx - sa * side * (HD / 2 + 0.004);
      const pz = hp.y + sa * wx + ca * side * (HD / 2 + 0.004);
      box(b, px, y + (door ? 0.01 : 0.1), pz, door ? 0.07 : 0.06, 0.01, door ? 0.15 : 0.07, ang, door ? 0x5a3a22 : 0x2a3036);
    }
  // the tin shed (open-sided: posts under a sloping roof), a tractor-trailer's worth of bales under it
  const sp = at(u0 + (h(2) - 0.5) * 0.2, -hv * sideW * 0.5);
  const sy = gy(sp);
  const SW = 0.62;
  const SD = 0.34;
  for (const cx of [-1, 1]) for (const cz of [-1, 1]) box(b, sp.x + ca * cx * SW * 0.45 - sa * cz * SD * 0.45, sy, sp.y + sa * cx * SW * 0.45 + ca * cz * SD * 0.45, 0.025, 0.025, 0.2, ang, 0x6a6a68);
  _bq.setFromAxisAngle(_by, -ang).multiply(new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), 0.12));
  _bm.compose(V(sp.x, sy + 0.215, sp.y), _bq, V(1, 1, 1));
  b.add(new THREE.BoxGeometry(SW + 0.06, 0.012, SD + 0.08), _bm, null, C(0x9aa0a6));
  for (let i = 0; i < 6; i++) {
    const bx = (i % 3) * 0.13 - 0.13;
    const by = Math.floor(i / 3) * 0.07;
    box(b, sp.x + ca * bx, sy + by, sp.y + sa * bx, 0.12, 0.09, 0.065, ang, i % 2 ? 0xd8bc72 : 0xc8ac64);
  }
  // the water tank on four legs, by the house
  const tp = at(u0 + 0.3 * (h(3) < 0.5 ? 1 : -1), hv * sideW * 0.05);
  const ty = gy(tp);
  for (const cx of [-1, 1]) for (const cz of [-1, 1]) box(b, tp.x + cx * 0.06, ty, tp.y + cz * 0.06, 0.016, 0.016, 0.24, 0, 0x707274);
  _bm.makeTranslation(tp.x, ty + 0.24 + 0.08, tp.y);
  b.add(new THREE.CylinderGeometry(0.1, 0.1, 0.16, 12), _bm, null, C(0xd8dcdc));
}

/**
 * Desert farm estates (layout.pivots: flat open ground set aside for one): a block of long rectangular fields
 * side by side - golden wheat with tramlines and ripeness patches, vineyards on trellises, olive / citrus groves,
 * green fodder with sprinklers - each on its own soil bed inside a low earth bank with weeds on the margins,
 * dirt tracks with wheel ruts between them, an irrigation main along the headland, a farmstead at one end and a
 * windbreak of tall narrow trees along one long edge.
 */
function buildEstates(m: GameMap, layout: Layout, crops: (x: number, z: number) => GeoBuilder, trees: Record<TreeKind, Inst[]>) {
  const pivots = layout.pivots ?? [];
  pivots.forEach((pv, k) => {
    const b = crops(pv.x, pv.y);
    const h = (q: number) => hash2(k, q, 4461);
    // the block: its rows along one side (a little off the grid), fitting the cleared disc (clear to r + 0.4)
    const ang = (h(1) < 0.5 ? 0 : Math.PI / 2) + (h(2) - 0.5) * 0.3;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const Rc = pv.r + 0.35;
    const L = Rc * 0.8;
    const W = Math.sqrt(Rc * Rc - L * L) - 0.38;
    const at = (u: number, v: number) => ({ x: pv.x + ca * u - sa * v, y: pv.y + sa * u + ca * v });
    // the farmstead takes one end, the fields the rest
    const fe = h(4) < 0.5 ? 1 : -1;
    const FS = 1.15;
    const uc = -fe * (FS / 2);
    const Lf = L - FS / 2;
    farmstead(b, m, at, fe * (L - FS / 2 + 0.08), ang, k, W);
    // 3-4 long fields across the block, dirt tracks between
    const n = 3 + Math.floor(h(3) * 2);
    const track = 0.26;
    const ws = Array.from({ length: n }, (_, q) => 0.7 + h(10 + q) * 0.6);
    const sum = ws.reduce((p, q) => p + q, 0);
    const usable = W * 2 - track * (n - 1);
    let v0 = -W;
    let prev = '';
    for (let q = 0; q < n; q++) {
      const w = (ws[q] / sum) * usable;
      const vc = v0 + w / 2;
      v0 += w + track;
      const c = at(uc, vc);
      const f: Field = { cx: c.x, cy: c.y, hl: Lf - 0.06, hw: w / 2 - 0.05, angle: ang, type: FieldType.Wheat };
      const r = h(50 + q);
      let crop = r < 0.42 ? 'wheat' : r < 0.6 ? 'vineyard' : r < 0.76 ? 'grove' : r < 0.9 ? 'fodder' : 'stubble';
      if (crop === prev) crop = crop === 'wheat' ? 'fodder' : 'wheat';
      // (vines and groves need a few rows' width)
      if (w < 1.05 && (crop === 'vineyard' || crop === 'grove')) crop = prev === 'wheat' ? 'fodder' : 'wheat';
      prev = crop;
      const seed = k * 131 + q * 17;
      if (crop === 'wheat') {
        const young = h(60 + q) < 0.2;
        soilBed(b, m, f, C(0x9c7e52), seed);
        cropRows(b, m, f, { gap: 0.1, h: 0.09, w: 0.06, lo: C(young ? 0x6e7a3a : 0x9a7c44), hi: C(young ? 0xb8c068 : 0xeac87a), alt: C(young ? 0x8ea04c : 0xc8a456), sway: 1, tram: 9, seed });
      } else if (crop === 'stubble') {
        // harvested: short pale stubble, round bales left lying in lines
        soilBed(b, m, f, C(0xb09468), seed);
        cropRows(b, m, f, { gap: 0.1, h: 0.018, w: 0.05, lo: C(0xa08a5c), hi: C(0xe0cc94), alt: C(0xc8b07a), sway: 0, tram: 0, seed });
        const P = frame(f);
        for (let i = 0; i < 9; i++) {
          const p = P((hash2(seed, i, 4474) - 0.5) * f.hl * 1.7, (hash2(seed, i, 4475) - 0.5) * f.hw * 1.6);
          if (!plantable(m, p.x, p.z)) continue;
          _bm.makeRotationZ(Math.PI / 2).premultiply(new THREE.Matrix4().makeRotationY(hash2(seed, i, 4476) * 3)).setPosition(p.x, surfaceHeight(m, p.x, p.z) + 0.045, p.z);
          b.add(new THREE.CylinderGeometry(0.045, 0.045, 0.07, 10), _bm, null, C(0xd0b46c));
        }
      } else if (crop === 'vineyard') {
        soilBed(b, m, f, C(0x94744c), seed);
        vineyard(b, m, f, seed, true);
      } else if (crop === 'grove') {
        soilBed(b, m, f, C(0xa08660), seed);
        // the grass between the trees
        cropRows(b, m, f, { gap: 0.31, h: 0.02, w: 0.08, lo: C(0x8a8a50), hi: C(0x9aa858), alt: C(0xb0a868), sway: 0.2, tram: 0, seed });
        orchard(m, f, seed, h(80 + q) < 0.6 ? 'olive' : 'citrus', trees);
      } else {
        // green fodder (alfalfa): low, dense, bright, the sprinkler risers standing in it
        soilBed(b, m, f, C(0x7a6a46), seed);
        cropRows(b, m, f, { gap: 0.08, h: 0.045, w: 0.05, lo: C(0x3e6e24), hi: C(0x7cbc40), alt: C(0x5a9a30), sway: 0.5, tram: 0, seed });
        const P = frame(f);
        for (let i = -2; i <= 2; i++)
          for (const j of [-0.5, 0.5]) {
            const p = P(i * f.hl * 0.4, j * f.hw);
            box(b, p.x, surfaceHeight(m, p.x, p.z), p.z, 0.008, 0.008, 0.11, 0, 0x5a5e62);
          }
      }
      // the earth bank round the field, weeds along it
      const P = frame(f);
      const bank = C(0x8a6e48);
      for (const sv of [-1, 1]) {
        const e = P(0, sv * (f.hw + 0.03));
        box(b, e.x, surfaceHeight(m, e.x, e.z), e.z, f.hl * 2 + 0.06, 0.05, 0.022, ang, bank);
        const e2 = P(sv * (f.hl + 0.03), 0);
        box(b, e2.x, surfaceHeight(m, e2.x, e2.z), e2.z, 0.05, f.hw * 2 + 0.06, 0.022, ang, bank);
      }
      const per = (f.hl + f.hw) * 4;
      const nWeed = Math.floor(per / 0.16);
      for (let i = 0; i < nWeed; i++) {
        if (hash2(seed, i, 4477) < 0.35) continue;
        let t = (i / nWeed) * per;
        let p: { x: number; z: number };
        const out = 0.07 + hash2(seed, i, 4478) * 0.05;
        if (t < f.hl * 2) p = P(-f.hl + t, -(f.hw + out));
        else if ((t -= f.hl * 2) < f.hw * 2) p = P(f.hl + out, -f.hw + t);
        else if ((t -= f.hw * 2) < f.hl * 2) p = P(f.hl - t, f.hw + out);
        else p = P(-(f.hl + out), f.hw - (t - f.hl * 2));
        if (!plantable(m, p.x, p.z)) continue;
        const sz = 0.6 + hash2(seed, i, 4479) * 0.8;
        _bm.compose(V(p.x, surfaceHeight(m, p.x, p.z) + 0.02 * sz, p.z), _bq.setFromAxisAngle(_by, i), V(sz, sz, sz));
        b.add(new THREE.ConeGeometry(0.035, 0.05, 5), _bm, null, C(hash2(seed, i, 4480) < 0.5 ? 0x6a7a3a : 0x8a8448));
      }
    }
    // the dirt tracks: packed earth, two darker wheel ruts
    v0 = -W;
    for (let q = 0; q < n - 1; q++) {
      v0 += (ws[q] / sum) * usable;
      const c = at(uc, v0 + track / 2);
      soilBed(b, m, { cx: c.x, cy: c.y, hl: Lf, hw: track / 2 - 0.02, angle: ang, type: FieldType.Plowed }, C(0xc8b08a), k * 53 + q);
      for (const rv of [-0.055, 0.055]) {
        const rp = at(uc, v0 + track / 2 + rv);
        box(b, rp.x, surfaceHeight(m, rp.x, rp.y) + 0.013, rp.y, Lf * 2, 0.03, 0.002, ang, 0x9a8462);
      }
      v0 += track;
    }
    // the irrigation main along the headland by the farmstead, a riser into each field
    const hu = uc + fe * (Lf + 0.02);
    const mp = at(hu, 0);
    _bq.setFromAxisAngle(V(-sa, 0, ca).normalize(), Math.PI / 2);
    _bm.compose(V(mp.x, surfaceHeight(m, mp.x, mp.y) + 0.03, mp.y), new THREE.Quaternion().setFromAxisAngle(_by, -ang).multiply(new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), Math.PI / 2)), V(1, 1, 1));
    b.add(new THREE.CylinderGeometry(0.014, 0.014, W * 2, 6), _bm, null, C(0x2a2e30));
    // the windbreak: a row of tall narrow trees along one long edge (cypress-like), staggered
    const side = h(5) < 0.5 ? -1 : 1;
    const nT = Math.max(6, Math.floor((L * 2) / 0.26));
    for (let i = 0; i <= nT; i++) {
      const p = at(-L + (i / nT) * L * 2, side * (W + 0.2 + (i % 2) * 0.08));
      if (!plantable(m, p.x, p.y) || hash2(k, i, 4462) < 0.06) continue;
      const s = 0.75 + hash2(k, i, 4463) * 0.35;
      const tone = 0.62 + hash2(k, i, 4464) * 0.2;
      trees.olive.push({ x: p.x, y: surfaceHeight(m, p.x, p.y) - 0.01, z: p.y, rotY: hash2(i, k, 4465) * 6.28, sx: s * 0.7, sy: s * (2.3 + hash2(i, k, 4466) * 0.7), sz: s * 0.7, color: new THREE.Color(tone * 0.78, tone, tone * 0.76) });
    }
    // shade trees round the farmstead
    for (let i = 0; i < 3; i++) {
      const p = at(fe * (L - 0.15 - hash2(k, i, 4467) * 0.8), (hash2(k, i, 4468) - 0.5) * W * 1.9);
      if (!plantable(m, p.x, p.y)) continue;
      const s = 1.1 + hash2(k, i, 4469) * 0.3;
      trees.olive.push({ x: p.x, y: surfaceHeight(m, p.x, p.y) - 0.01, z: p.y, rotY: i * 2.1, sx: s, sy: s, sz: s, color: new THREE.Color(0.9, 0.95, 0.88) });
    }
  });
}

// ------------------------------------------------------------------ main

export function buildFarm(m: GameMap, layout: Layout, fog: FogOfWar, quality: 'low' | 'medium' | 'high', lod?: SceneryLod): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const biome = m.biome;
  if (biome === 'urban') return out;
  const CH = 32;
  const cropB = new Map<string, GeoBuilder>();
  const houseB = new Map<string, GeoBuilder>();
  const get = (map: Map<string, GeoBuilder>) => (x: number, z: number) => {
    const key = `${Math.floor(x / CH)},${Math.floor(z / CH)}`;
    let b = map.get(key);
    if (!b) map.set(key, (b = new GeoBuilder()));
    return b;
  };
  const crops = get(cropB);
  const houses = get(houseB);
  const gap = quality === 'high' ? 0.15 : quality === 'medium' ? 0.19 : 0.28;
  const trees: Record<TreeKind, Inst[]> = { apple: [], olive: [], citrus: [] };
  const tractorFields: { f: Field; k: number }[] = [];
  const far = (x: number, z: number, r: number) => m.starts.every((s) => Math.hypot(s.x + 0.5 - x, s.y + 0.5 - z) > r);

  layout.fields.forEach((f, k) => {
    const crop = cropOf(m, f, k);
    if (crop === 'wheat') {
      // ripe gold or still green-gold; desert wheat is paler
      const young = hash2(k, 7, 4441) < 0.25;
      const hi = C(biome === 'desert' ? 0xe0c27a : young ? 0xb4b25a : 0xd8b05a);
      const lo = C(biome === 'desert' ? 0x8a7040 : young ? 0x5e6a2c : 0x7a6232);
      ridges(crops(f.cx, f.cy), m, f, gap, 0.085, gap * 0.62, lo, hi, k * 31);
    } else if (crop === 'stubble') {
      if (biome !== 'winter') ridges(crops(f.cx, f.cy), m, f, gap * 1.4, 0.016, gap * 0.5, C(0x8a7448), C(0xc8b078), k * 31);
    } else if (crop === 'vineyard') {
      vineyard(crops(f.cx, f.cy), m, f, k, biome === 'desert');
    } else if (crop === 'greenhouse') {
      tunnels(houses(f.cx, f.cy), m, f, k);
    } else if (crop === 'orchard') {
      orchard(m, f, k, biome === 'desert' ? (hash2(k, 8, 4441) < 0.5 ? 'olive' : 'citrus') : 'apple', trees);
    } else if (crop === 'plain' && (f.type === FieldType.Plowed || f.type === FieldType.Fallow) && biome !== 'winter' && f.hl > 2.2 && f.hw > 0.9 && far(f.cx, f.cy, 14)) {
      tractorFields.push({ f, k });
    }
  });

  // the desert estates draw into the crop builders and the orchard trees
  buildEstates(m, layout, crops, trees);

  const cropMat = cropMaterial(fog, quality === 'low' ? 0 : 0.022);
  for (const b of cropB.values()) {
    if (!b.count) continue;
    const mesh = new THREE.Mesh(b.build(true), cropMat);
    mesh.receiveShadow = true;
    mesh.name = 'farm-crops';
    out.push(mesh);
    // far zoom: the painted fields carry it
    if (lod) lod.add([mesh], mesh.geometry, null, Infinity, quality === 'high' ? 60 : 44);
  }

  // glossy polythene tunnels
  const filmMat = fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.22, metalness: 0.0, envMapIntensity: 1.4, side: THREE.DoubleSide }));
  for (const b of houseB.values()) {
    if (!b.count) continue;
    const mesh = new THREE.Mesh(b.build(), filmMat);
    mesh.receiveShadow = true;
    mesh.castShadow = quality !== 'low';
    mesh.name = 'farm-greenhouses';
    out.push(mesh);
  }

  // orchard trees (instanced, one draw per chunk and kind)
  const treeMat = cropMaterial(fog, quality === 'low' ? 0 : 0.008, 0.85);
  treeMat.side = THREE.FrontSide;
  for (const kind of ['apple', 'olive', 'citrus'] as const) {
    if (!trees[kind].length) continue;
    const ims = chunkedInstances(orchardTree(kind), treeMat, trees[kind], CH, { castShadow: quality !== 'low', name: 'farm-orchard' });
    out.push(...ims);
    if (lod) for (const im of ims) lod.add([im], im.geometry, null, Infinity, quality === 'high' ? 70 : 52);
  }

  // a tractor or two harrowing a field (render-only ambient: not in the sim)
  const nTr = quality === 'low' ? 0 : biome === 'desert' ? 1 : 2;
  tractorFields.sort((a, b) => b.f.hl * b.f.hw - a.f.hl * a.f.hw);
  const paints = [0xb8281e, 0x2f6b2a, 0x2a5aa8, 0xd87a1a];
  const trMat = fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.25 }));
  for (let i = 0; i < Math.min(nTr, tractorFields.length); i++) {
    const { f, k } = tractorFields[i * 2 < tractorFields.length ? i * 2 : i];
    const route = tractorRoute(f);
    const mesh = new THREE.Mesh(tractorGeometry(C(paints[(k + i) % paints.length])), trMat);
    mesh.name = 'farm-tractor';
    mesh.castShadow = quality === 'high';
    mesh.receiveShadow = true;
    // it moves: never culled (one small draw), placed every frame from the wall clock
    mesh.frustumCulled = false;
    const speed = 0.11;
    const t0 = hash2(k, 9, 4441) * route.len;
    let seg = 0;
    mesh.onBeforeRender = () => {
      const t = performance.now() / 1000;
      let s = (t0 + t * speed) % (route.len * 2);
      const back = s > route.len;
      if (back) s = route.len * 2 - s;
      if (s < route.cum[seg] || s > route.cum[seg + 1]) {
        seg = 0;
        while (seg < route.cum.length - 2 && route.cum[seg + 1] < s) seg++;
      }
      const a = route.pts[seg];
      const b = route.pts[seg + 1];
      const u = (s - route.cum[seg]) / Math.max(1e-6, route.cum[seg + 1] - route.cum[seg]);
      const x = a.x + (b.x - a.x) * u;
      const z = a.z + (b.z - a.z) * u;
      const dx = (b.x - a.x) * (back ? -1 : 1);
      const dz = (b.z - a.z) * (back ? -1 : 1);
      mesh.position.set(x, surfaceHeight(m, x, z) - 0.005, z);
      mesh.rotation.y = -Math.atan2(dz, dx);
      mesh.rotation.z = Math.sin(t * 23) * 0.006; // engine judder
      mesh.updateMatrixWorld();
    };
    out.push(mesh);
  }
  return out;
}
