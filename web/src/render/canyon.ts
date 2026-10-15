import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GameMap } from '../sim/map';
import { hash2, valueNoise } from '../sim/rng';
import type { FogOfWar } from './fog';
import { surfaceHeight } from './ground';
import { reliefHeight, reliefMaterial } from './relief';

/*
 * Wadi Al-Rimal's coloured canyons (render only; the sim carves them: sim/maps.ts DESERT_CANYON, mirrored). The
 * cliff relief and the ground carry the sandstone's colours (strata.ts); here the walls get their relief:
 *  - ledges: the harder layers stand out of the walls as ragged slabs, in runs with gaps, at levels that wander
 *    along the canyon; the thicker caps overhang and shade the softer rock under them;
 *  - boulders and blocks fallen from them lie at the foot of the walls (off the middle of the passable floor);
 *  - here and there a hoodoo: stacked, weathered blocks under a cap rock.
 * One merged mesh per canyon on the cliffs' own material (relief.ts: the same triplanar rock, sandstone layers
 * and crevice shading, so the slabs and blocks match the walls they came from); one draw call each, culled on
 * its own; nothing glows.
 */

/** Ledge levels: average spacing (world units of height). */
const LEDGE_STEP = 0.42;

class Builder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  private readonly v = new THREE.Vector3();
  private readonly n = new THREE.Vector3();
  private readonly nm = new THREE.Matrix3();

  get tris(): number {
    return this.pos.length / 9;
  }

  /** Append a non-indexed geometry with normals under a transform; ao(local y 0..1, normal y) shades it. */
  add(g: THREE.BufferGeometry, m: THREE.Matrix4, ao: (ly: number, ny: number) => number): void {
    const P = g.attributes.position;
    const N = g.attributes.normal;
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    const hy = Math.max(1e-4, bb.max.y - bb.min.y);
    this.nm.getNormalMatrix(m);
    for (let i = 0; i < P.count; i++) {
      const ly = (P.getY(i) - bb.min.y) / hy;
      this.v.fromBufferAttribute(P, i).applyMatrix4(m);
      this.n.fromBufferAttribute(N, i).applyMatrix3(this.nm).normalize();
      this.pos.push(this.v.x, this.v.y, this.v.z);
      this.nor.push(this.n.x, this.n.y, this.n.z);
      const c = ao(ly, this.n.y);
      this.col.push(c, c, c);
    }
  }

  /** One flat triangle facing (roughly) along `face`, shaded ao. */
  tri(a: number[], b: number[], c: number[], face: number[], ao: number): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    nx /= l;
    ny /= l;
    nz /= l;
    if (nx * face[0] + ny * face[1] + nz * face[2] < 0) {
      [b, c] = [c, b];
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx, ny, nz);
      this.col.push(ao, ao, ao);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aCanyon', new THREE.Float32BufferAttribute(new Float32Array(this.pos.length / 3).fill(2), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** A ragged slab of sandstone (length x along the wall, thickness y, depth z into it), faceted. */
function slabGeo(L: number, T: number, D: number, seed: number): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.BoxGeometry(L, T, D, 2, 1, 1);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const P = g.attributes.position;
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i);
    const y = P.getY(i);
    const z = P.getZ(i);
    const k = Math.round((x / L) * 4) * 7 + Math.round((y / T) * 2) * 3 + Math.round((z / D) * 2);
    // a ragged front edge, a tilted, bumpy top, the ends broken off
    const front = z < 0 ? 1 : 0.3;
    P.setXYZ(
      i,
      x + (hash2(k, seed, 1) - 0.5) * L * 0.18,
      y + (hash2(k, seed, 2) - 0.5) * T * 0.7 * front,
      z + (hash2(k, seed, 3) - 0.5) * D * 0.35 * front,
    );
  }
  g = g.toNonIndexed();
  g.computeVertexNormals();
  return g;
}

/** A broken boulder: a displaced icosahedron with fracture faces and a flat bed. */
function boulderGeo(detail: number, seed: number): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const P = g.attributes.position;
  const planes: [THREE.Vector3, number][] = [];
  for (let k = 0; k < 4; k++) planes.push([new THREE.Vector3(hash2(k, seed, 11) - 0.5, (hash2(k, seed, 12) - 0.2) * 1.1, hash2(k, seed, 13) - 0.5).normalize(), 0.6 + hash2(k, seed, 14) * 0.25]);
  const v = new THREE.Vector3();
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i);
    v.multiplyScalar(1 + (valueNoise(v.x * 1.7 + seed, v.y * 1.7 + v.z * 1.3, 4501) - 0.5) * 0.5);
    for (const [n, d] of planes) {
      const e = v.dot(n) - d;
      if (e > 0) v.addScaledVector(n, -e * 0.9);
    }
    if (v.y < -0.3) v.y = -0.3 + (v.y + 0.3) * 0.2;
    P.setXYZ(i, v.x, v.y, v.z);
  }
  g = g.toNonIndexed();
  g.computeVertexNormals();
  return g;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
function place(x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number, rx = 0, rz = 0): THREE.Matrix4 {
  _q.setFromEuler(_e.set(rx, yaw, rz, 'YXZ'));
  return _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

interface LedgePt {
  /** Front edge (x, z), back edge (x, z), the wall there (x, z), top, thickness, outward normal (x, z). */
  fx: number;
  fz: number;
  wx: number;
  wz: number;
  bx: number;
  bz: number;
  y: number;
  t: number;
  nx: number;
  nz: number;
}

/** A ledge: one continuous ragged strip along the wall (top, overhanging front, underside, end caps). */
function ledgeStrip(b: Builder, run: LedgePt[]): void {
  if (run.length < 2) return;
  // the ends taper back into the wall
  for (const e of [run[0], run[run.length - 1]]) {
    e.fx = e.wx + (e.fx - e.wx) * 0.3;
    e.fz = e.wz + (e.fz - e.wz) * 0.3;
    e.t *= 0.45;
  }
  const q = (x: number, y: number, z: number) => [x, y, z];
  for (let i = 0; i < run.length - 1; i++) {
    const a = run[i];
    const c = run[i + 1];
    const F0 = q(a.fx, a.y, a.fz);
    const F1 = q(c.fx, c.y, c.fz);
    const B0 = q(a.bx, a.y, a.bz);
    const B1 = q(c.bx, c.y, c.bz);
    // (the underside's front edge sits back: an undercut lip)
    const f0 = q(a.fx + a.nx * a.t * 0.8, a.y - a.t, a.fz + a.nz * a.t * 0.8);
    const f1 = q(c.fx + c.nx * c.t * 0.8, c.y - c.t, c.fz + c.nz * c.t * 0.8);
    const b0 = q(a.bx, a.y - a.t, a.bz);
    const b1 = q(c.bx, c.y - c.t, c.bz);
    const out = [-(a.nx + c.nx) / 2, 0, -(a.nz + c.nz) / 2];
    b.tri(F0, F1, B1, [0, 1, 0], 1.0);
    b.tri(F0, B1, B0, [0, 1, 0], 1.0);
    b.tri(F0, f0, f1, out, 0.8);
    b.tri(F0, f1, F1, out, 0.8);
    b.tri(f0, b1, f1, [0, -1, 0], 0.5);
    b.tri(f0, b0, b1, [0, -1, 0], 0.5);
  }
  for (const [e, o] of [[run[0], run[1]], [run[run.length - 1], run[run.length - 2]]]) {
    const face = [e.fx - o.fx, 0, e.fz - o.fz];
    const F = [e.fx, e.y, e.fz];
    const B = [e.bx, e.y, e.bz];
    const f = [e.fx + e.nx * e.t * 0.8, e.y - e.t, e.fz + e.nz * e.t * 0.8];
    const bb = [e.bx, e.y - e.t, e.bz];
    b.tri(F, f, bb, face, 0.75);
    b.tri(F, bb, B, face, 0.75);
  }
}

export function buildCanyons(map: GameMap, fog: FogOfWar, quality: 'low' | 'medium' | 'high' = 'high'): THREE.Group | null {
  const list = map.deco?.canyons;
  if (!list?.length) return null;
  const group = new THREE.Group();
  group.name = 'canyons';
  group.userData.perfCat = 'canyons';
  const cl = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
  /** Top of whatever stands there: the cliff relief or the ground mesh. */
  const top = (x: number, z: number) => Math.max(reliefHeight(map, cl(x, map.w), cl(z, map.h)), surfaceHeight(map, cl(x, map.w), cl(z, map.h)));
  // a few shapes, reused under different transforms
  const slabs = [0, 1, 2, 3, 4, 5].map((k) => slabGeo(1, 1, 1, 70 + k));
  const rocks = [0, 1, 2, 3].map((k) => boulderGeo(1, 90 + k));
  const pebbles = [0, 1, 2].map((k) => boulderGeo(0, 120 + k));
  const slabAo = (ly: number, ny: number) => (ny < -0.3 ? 0.55 : ny > 0.5 ? 1.0 : 0.78 + ly * 0.18);
  const rockAo = (ly: number, ny: number) => (0.68 + 0.32 * Math.min(1, ly * 1.4)) * (ny < -0.2 ? 0.85 : 1);
  let tris = 0;
  list.forEach((c, ci) => {
    const b = new Builder();
    const h = (i: number, j: number) => hash2(i, j + ci * 31, 4481);
    // the course, resampled evenly
    const STEP = 0.36;
    // the ledges being laid, per side and level
    const runs = [new Map<number, LedgePt[]>(), new Map<number, LedgePt[]>()];
    let n = 0;
    let along = 0;
    for (let s = 0; s < c.pts.length - 1; s++) {
      const ax = c.pts[s].x + 0.5;
      const az = c.pts[s].y + 0.5;
      const bx = c.pts[s + 1].x + 0.5;
      const bz = c.pts[s + 1].y + 0.5;
      const len = Math.hypot(bx - ax, bz - az);
      const tx = (bx - ax) / len;
      const tz = (bz - az) / len;
      for (let t = STEP / 2; t < len; t += STEP, n++, along += STEP) {
        const cx = ax + tx * t;
        const cz = az + tz * t;
        const floor = Math.min(top(cx, cz), top(cx - tz * c.hw * 0.4, cz + tx * c.hw * 0.4), top(cx + tz * c.hw * 0.4, cz - tx * c.hw * 0.4));
        for (const side of [-1, 1]) {
          const nx = -tz * side;
          const nz = tx * side;
          const sid = side < 0 ? 0 : 1;
          // the wall's profile outwards from the floor
          const R0 = c.hw * 0.55;
          const prof: number[] = [];
          for (let r = R0; r < c.hw + 3.2; r += 0.05) prof.push(top(cx + nx * r, cz + nz * r));
          const rAt = (y: number) => {
            for (let k = 0; k < prof.length; k++) if (prof[k] >= y) return R0 + k * 0.05;
            return -1;
          };
          const rim = Math.max(...prof);
          const rFoot = rAt(floor + 0.08);
          if (rFoot < 0 || rim - floor < 0.5) {
            for (const cur of runs[sid].values()) ledgeStrip(b, cur);
            runs[sid].clear();
            continue;
          }
          // ledges: the harder layers (the same levels the whole canyon long, wandering a little) stand out of the
          // walls in long runs with gaps; the thick caps overhang
          const live = runs[sid];
          const seen = new Set<number>();
          for (let j = Math.ceil((floor + 0.25) / LEDGE_STEP); j * LEDGE_STEP < rim - 0.3; j++) {
            const hard = hash2(j, 0, 4519);
            if (hard > 0.34) continue;
            const run = valueNoise(along * 0.55 + sid * 40 + j * 13, j * 7.3, 4511 + ci);
            if (run < 0.46) continue;
            const yL = j * LEDGE_STEP + (valueNoise(along * 0.22, j * 3.1 + sid * 9, 4513) - 0.5) * 0.2;
            if (yL < floor + 0.22) continue;
            const r = rAt(yL);
            if (r < 0) continue;
            const ex = cx + nx * r;
            const ez = cz + nz * r;
            // only on a steep wall (on a gentle slope a ledge would just lie on it)
            const steep = (top(ex + nx * 0.12, ez + nz * 0.12) - top(ex - nx * 0.12, ez - nz * 0.12)) / 0.24;
            if (steep < 1.4) continue;
            const cap = hard < 0.14;
            const fade = Math.min(1, (run - 0.46) * 7);
            const out = ((cap ? 0.16 : 0.09) + (valueNoise(along * 2.3, j + sid * 5, 4521) - 0.5) * 0.07) * fade;
            const T = ((cap ? 0.15 : 0.09) + hash2(j, 1, 4519) * 0.04 + (valueNoise(along * 3.1, j, 4523) - 0.5) * 0.05) * (0.5 + 0.5 * fade);
            const pt: LedgePt = { fx: ex - nx * out, fz: ez - nz * out, wx: ex, wz: ez, bx: ex + nx * 0.3, bz: ez + nz * 0.3, y: yL, t: T, nx, nz };
            let cur = live.get(j);
            if (!cur) live.set(j, (cur = []));
            cur.push(pt);
            seen.add(j);
          }
          for (const [j, cur] of live)
            if (!seen.has(j)) {
              ledgeStrip(b, cur);
              live.delete(j);
            }
          // boulders and blocks fallen at the foot of the wall
          if (h(n * 2 + sid, 1) < 0.32) {
            const big = h(n * 2 + sid, 2) < 0.45;
            const sz = big ? 0.16 + h(n * 2 + sid, 3) * 0.14 : 0.06 + h(n * 2 + sid, 3) * 0.08;
            const r = rFoot - sz * (0.2 + h(n * 2 + sid, 4) * 0.5);
            const x = cx + nx * r + tx * (h(n * 2 + sid, 5) - 0.5) * STEP;
            const z = cz + nz * r + tz * (h(n * 2 + sid, 5) - 0.5) * STEP;
            const g = big ? rocks[Math.floor(h(n * 2 + sid, 6) * rocks.length)] : pebbles[Math.floor(h(n * 2 + sid, 6) * pebbles.length)];
            b.add(g, place(x, top(x, z) - sz * 0.15, z, h(n * 2 + sid, 7) * 6.3, sz * (1 + h(n * 2 + sid, 8) * 0.5), sz * 0.75, sz, (h(n * 2 + sid, 9) - 0.5) * 0.3, 0), rockAo);
            // a few chips beside it
            for (let q = 0; q < (big ? 2 : 0); q++) {
              const ps = 0.025 + h(n * 2 + sid, 20 + q) * 0.035;
              const px = x - nx * (sz + 0.05 + h(n * 2 + sid, 30 + q) * 0.3) + tx * (h(n * 2 + sid, 40 + q) - 0.5) * 0.4;
              const pz = z - nz * (sz + 0.05 + h(n * 2 + sid, 30 + q) * 0.3) + tz * (h(n * 2 + sid, 40 + q) - 0.5) * 0.4;
              b.add(pebbles[q % pebbles.length], place(px, top(px, pz) - ps * 0.2, pz, h(n * 2 + sid, 50 + q) * 6.3, ps * 1.3, ps * 0.7, ps), rockAo);
            }
          }
          // a hoodoo: weathered blocks stacked under a cap rock, at the foot of a wall
          if (h(n * 2 + sid, 60) < 0.035) {
            const r = rFoot + 0.05;
            const x = cx + nx * r;
            const z = cz + nz * r;
            let y = top(x, z) - 0.04;
            let w = 0.13 + h(n * 2 + sid, 61) * 0.05;
            const stack = 3 + Math.floor(h(n * 2 + sid, 62) * 2);
            for (let i = 0; i < stack; i++) {
              const hh = 0.09 + h(n * 2 + sid, 63 + i) * 0.06;
              b.add(rocks[i % rocks.length], place(x, y + hh * 0.3, z, h(n * 2 + sid, 70 + i) * 6.3, w, hh * 0.75, w * 0.9), rockAo);
              y += hh * 0.85;
              w *= 0.8 + h(n * 2 + sid, 75 + i) * 0.1;
            }
            b.add(slabs[0], place(x, y + 0.02, z, h(n * 2 + sid, 80) * 6.3, w * 3.2, 0.06, w * 2.6), slabAo);
          }
        }
      }
    }
    for (const live of runs) for (const cur of live.values()) ledgeStrip(b, cur);
    if (!b.tris) return;
    tris += b.tris;
    const mesh = new THREE.Mesh(b.build(), reliefMaterial(map, fog, quality));
    mesh.name = 'canyon';
    mesh.castShadow = quality !== 'low';
    mesh.receiveShadow = true;
    mesh.userData.perfCat = 'canyons';
    group.add(mesh);
  });
  for (const g of [...slabs, ...rocks, ...pebbles]) g.dispose();
  console.info(`[canyon] ${group.children.length} canyons, ${tris} tris`);
  return group.children.length ? group : null;
}
