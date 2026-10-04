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
 * plastic greenhouse tunnels, desert centre-pivot circles with a slowly
 * turning sprinkler arm, and a tractor or two working a field.
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
    if (biome === 'desert') return r < 0.6 ? 'greenhouse' : r < 0.8 ? 'vineyard' : 'plain';
    return r < 0.3 ? 'vineyard' : r < 0.5 ? 'greenhouse' : 'plain';
  }
  if (f.type === FieldType.Green) return r < (biome === 'desert' ? 0.45 : 0.35) ? 'orchard' : 'plain';
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
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= 1.0 + vSway * 0.22;');
  };
  fog.apply(mat);
  mat.customProgramCacheKey = () => 'fog2-cropsway';
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
      if (prev) for (let q = 0; q < ids.length - 1; q++) b.quad(prev[q + 1], ids[q + 1], prev[q], ids[q]);
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

// ------------------------------------------------------------------ centre pivots

/** Desert centre-pivot circles (layout.pivots): a green disc with wheel rings, a turning truss arm. */
function buildPivots(m: GameMap, layout: Layout, fog: FogOfWar, quality: 'low' | 'medium' | 'high', crops: (x: number, z: number) => GeoBuilder, out: THREE.Object3D[]) {
  const pivots = layout.pivots ?? [];
  if (!pivots.length) return;
  const armMat = fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.7 }));
  pivots.forEach((pv, k) => {
    const b = crops(pv.x, pv.y);
    const rings = Math.max(4, Math.round(pv.r / 0.35));
    const segs = quality === 'low' ? 28 : 40;
    const g0 = surfaceHeight(m, pv.x, pv.y);
    // a pie slice is harvested / freshly sown (bare soil)
    const cut0 = hash2(k, 1, 4431) * Math.PI * 2;
    const cutW = 0.6 + hash2(k, 2, 4431) * 1.2;
    const green = C(hash2(k, 3, 4431) < 0.5 ? 0x5a8a2a : 0x6a9a34);
    const soil = C(0x9a7a50);
    const ids: number[][] = [];
    for (let i = 0; i <= rings; i++) {
      const rr = (i / rings) * pv.r;
      const row: number[] = [];
      for (let s = 0; s <= segs; s++) {
        const th = (s / segs) * Math.PI * 2;
        const x = pv.x + Math.cos(th) * rr;
        const z = pv.y + Math.sin(th) * rr;
        const y = surfaceHeight(m, x, z) + 0.02;
        let d = th - cut0;
        d -= Math.floor(d / (Math.PI * 2)) * Math.PI * 2;
        const bare = d < cutW;
        // the towers' wheel tracks: darker rings
        const track = i > 0 && i % 3 === 0;
        const tone = 0.86 + hash2(i, s, 4432 + k) * 0.22;
        const c = (bare ? soil : green).clone().multiplyScalar(tone * (track ? 0.72 : 1) * (1 - (i / rings) * 0.08));
        row.push(b.vert(V(x, y, z), V(0, 1, 0), 0, 0, c, bare ? 0 : 0.15));
      }
      ids.push(row);
    }
    for (let i = 0; i < rings; i++) for (let s = 0; s < segs; s++) b.quad(ids[i + 1][s], ids[i + 1][s + 1], ids[i][s], ids[i][s + 1]);
    // the arm: centre tower, a pipe out to the rim on A-frame towers with wheels
    const ab = new GeoBuilder();
    const steel = C(0xb8bcc0);
    const dark = C(0x2a2a2a);
    const H = 0.17;
    const add = (geo: THREE.BufferGeometry, x: number, y: number, z: number, c: THREE.Color, rx = 0, rz = 0) =>
      ab.add(geo, new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, 0, rz)), V(1, 1, 1)), null, c);
    add(new THREE.CylinderGeometry(0.03, 0.05, H + 0.06, 6), 0, (H + 0.06) / 2, 0, steel);
    add(new THREE.BoxGeometry(0.08, 0.06, 0.08), 0, 0.03, 0, C(0x8a8a84));
    add(new THREE.BoxGeometry(pv.r, 0.014, 0.014), pv.r / 2, H, 0, steel);
    const nT = Math.max(2, Math.round(pv.r / 1.1));
    for (let t = 1; t <= nT; t++) {
      const x = (t / nT) * pv.r - 0.04;
      for (const s of [-1, 1]) {
        add(new THREE.BoxGeometry(0.01, H + 0.02, 0.01), x, H / 2, s * 0.035, steel, s * 0.25);
        add(new THREE.CylinderGeometry(0.03, 0.03, 0.02, 8).rotateX(Math.PI / 2), x, 0.03, s * 0.07, dark);
      }
      // the truss under the pipe: lower chord and diagonals
      const x0 = ((t - 1) / nT) * pv.r;
      const mid = (x0 + x) / 2;
      add(new THREE.BoxGeometry(x - x0, 0.006, 0.006), mid, H - 0.06, 0, steel);
      for (const dx of [-0.25, 0.25]) add(new THREE.BoxGeometry(0.006, 0.075, 0.006), mid + dx * (x - x0), H - 0.03, 0, steel, 0, dx * 2.2);
      // sprinkler drops
      for (let q = 1; q < 4; q++) add(new THREE.BoxGeometry(0.004, 0.08, 0.004), x0 + ((x - x0) * q) / 4, H - 0.04, 0, dark);
    }
    add(new THREE.BoxGeometry(0.22, 0.008, 0.008), pv.r + 0.08, H - 0.01, 0, steel); // end gun
    const arm = new THREE.Mesh(ab.build(), armMat);
    arm.position.set(pv.x, g0 + 0.01, pv.y);
    arm.castShadow = quality === 'high';
    arm.receiveShadow = true;
    arm.name = 'farm-pivot';
    const phase = hash2(k, 4, 4431) * Math.PI * 2;
    // one turn every 6 minutes; the culling sphere covers the whole circle
    arm.geometry.boundingSphere = new THREE.Sphere(V(0, 0.1, 0), pv.r + 0.4);
    arm.onBeforeRender = () => {
      arm.rotation.y = phase + (performance.now() / 1000) * ((Math.PI * 2) / 360);
      arm.updateMatrixWorld();
    };
    out.push(arm);
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
      const leaf = C(biome === 'desert' ? 0x6a8434 : 0x587a2a);
      ridges(crops(f.cx, f.cy), m, f, 0.34, 0.07, 0.035, leaf.clone().multiplyScalar(0.55), leaf, k * 31, 0.05, true);
      // trellis posts every ~1 tile
      const P = frame(f);
      const nRows = Math.max(1, Math.floor((f.hw * 2 - 0.2) / 0.34));
      const b0 = -((nRows - 1) * 0.34) / 2;
      const len = f.hl * 2 - 0.24;
      const nP = Math.max(1, Math.ceil(len / 1.0));
      const pb = crops(f.cx, f.cy);
      for (let r = 0; r < nRows; r++)
        for (let i = 0; i <= nP; i++) {
          const c = P(-len / 2 + (i / nP) * len, b0 + r * 0.34);
          if (!plantable(m, c.x, c.z)) continue;
          pb.add(new THREE.BoxGeometry(0.012, 0.14, 0.012), new THREE.Matrix4().makeTranslation(c.x, surfaceHeight(m, c.x, c.z) + 0.06, c.z), null, C(0x6a5a46));
        }
    } else if (crop === 'greenhouse') {
      tunnels(houses(f.cx, f.cy), m, f, k);
    } else if (crop === 'orchard') {
      const kind: TreeKind = biome === 'desert' ? (hash2(k, 8, 4441) < 0.5 ? 'olive' : 'citrus') : 'apple';
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
    } else if (crop === 'plain' && (f.type === FieldType.Plowed || f.type === FieldType.Fallow) && biome !== 'winter' && f.hl > 2.2 && f.hw > 0.9 && far(f.cx, f.cy, 14)) {
      tractorFields.push({ f, k });
    }
  });

  // the pivots draw their discs into the crop builders, the arms are their own meshes
  buildPivots(m, layout, fog, quality, crops, out);

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
