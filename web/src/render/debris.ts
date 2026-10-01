import * as THREE from 'three';
import { standHeight, type GameMap } from '../sim/map';
import type { Effects } from './effects';
import type { FogOfWar } from './fog';

/*
 * Physical debris: chunks of metal, concrete and earth thrown by explosions.
 * Each chunk has velocity, spin and gravity, bounces off the terrain with
 * friction, may trail smoke while burning, and fades out after landing.
 * Rendered as a few InstancedMeshes (one per material) for performance.
 */

export type DebrisKind = 'metal' | 'concrete' | 'dirt' | 'burnt' | 'glass';

interface Chunk {
  kind: DebrisKind;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rx: number;
  ry: number;
  rz: number;
  wx: number;
  wy: number;
  wz: number;
  sx: number;
  sy: number;
  sz: number;
  life: number;
  max: number;
  smoke: boolean;
  rest: boolean;
}

const MAX_PER_KIND = 900;

export class Debris {
  readonly group = new THREE.Group();
  private meshes = new Map<DebrisKind, THREE.InstancedMesh>();
  private chunks: Chunk[] = [];
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();

  constructor(
    private map: GameMap,
    private effects: Effects,
    fog: FogOfWar,
  ) {
    const geo = new THREE.DodecahedronGeometry(0.5, 0);
    // squash the dodecahedron into irregular shards
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const h = Math.sin(i * 12.9898) * 43758.5453;
      const k = 0.75 + (h - Math.floor(h)) * 0.5;
      pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k * 0.7, pos.getZ(i) * k);
    }
    geo.computeVertexNormals();
    const mats: Record<DebrisKind, THREE.MeshStandardMaterial> = {
      metal: new THREE.MeshStandardMaterial({ color: 0x4a4c4e, roughness: 0.55, metalness: 0.6, flatShading: true }),
      burnt: new THREE.MeshStandardMaterial({ color: 0x1e1a17, roughness: 0.9, metalness: 0.2, flatShading: true }),
      concrete: new THREE.MeshStandardMaterial({ color: 0x8e8a82, roughness: 0.95, flatShading: true }),
      dirt: new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1, flatShading: true }),
      glass: new THREE.MeshStandardMaterial({ color: 0x9fb6c4, roughness: 0.1, metalness: 0.3, flatShading: true }),
    };
    for (const k of Object.keys(mats) as DebrisKind[]) {
      fog.apply(mats[k]);
      const im = new THREE.InstancedMesh(geo, mats[k], MAX_PER_KIND);
      im.count = 0;
      im.castShadow = true;
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.meshes.set(k, im);
      this.group.add(im);
    }
  }

  private rnd(a: number, b: number) {
    return a + Math.random() * (b - a);
  }

  /** Throw n chunks from (x,z) at height y. power ~ initial speed (tiles/s), size ~ chunk size. */
  burst(kind: DebrisKind, x: number, y: number, z: number, n: number, power: number, size: number, opts: { up?: number; smoke?: number; spread?: number } = {}) {
    const up = opts.up ?? 1;
    for (let i = 0; i < n; i++) {
      if (this.chunks.length > MAX_PER_KIND * 4) break;
      const a = Math.random() * Math.PI * 2;
      const sp = power * this.rnd(0.35, 1);
      const sc = size * this.rnd(0.4, 1.2);
      this.chunks.push({
        kind,
        x: x + Math.cos(a) * (opts.spread ?? 0.1),
        y,
        z: z + Math.sin(a) * (opts.spread ?? 0.1),
        vx: Math.cos(a) * sp,
        vy: this.rnd(0.6, 1.4) * power * up,
        vz: Math.sin(a) * sp,
        rx: Math.random() * 6,
        ry: Math.random() * 6,
        rz: Math.random() * 6,
        wx: this.rnd(-12, 12),
        wy: this.rnd(-12, 12),
        wz: this.rnd(-12, 12),
        sx: sc * this.rnd(0.6, 1.4),
        sy: sc * this.rnd(0.4, 1),
        sz: sc * this.rnd(0.6, 1.4),
        life: 0,
        max: this.rnd(5, 9),
        smoke: Math.random() < (opts.smoke ?? 0),
        rest: false,
      });
    }
  }

  update(dt: number) {
    const G = 9.5;
    const counts = new Map<DebrisKind, number>();
    for (const k of this.meshes.keys()) counts.set(k, 0);
    let w = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      c.life += dt;
      if (c.life >= c.max) continue;
      if (!c.rest) {
        c.vy -= G * dt;
        c.x += c.vx * dt;
        c.y += c.vy * dt;
        c.z += c.vz * dt;
        c.rx += c.wx * dt;
        c.ry += c.wy * dt;
        c.rz += c.wz * dt;
        const gx = Math.max(0, Math.min(this.map.w - 0.01, c.x));
        const gz = Math.max(0, Math.min(this.map.h - 0.01, c.z));
        const ground = standHeight(this.map, gx, gz) + c.sy * 0.3;
        if (c.y <= ground) {
          c.y = ground;
          if (c.vy < -1.2) {
            // bounce with energy loss and friction
            c.vy = -c.vy * 0.32;
            c.vx *= 0.55;
            c.vz *= 0.55;
            c.wx *= 0.5;
            c.wy *= 0.5;
            c.wz *= 0.5;
          } else {
            c.rest = true;
            c.vx = c.vy = c.vz = 0;
          }
        }
        if (c.smoke && Math.random() < dt * 25) this.effects.smoke(c.x, c.y, c.z, 0.35, true);
      }
      // sink into the ground at the end of life
      const fade = c.life > c.max - 1.2 ? (c.max - c.life) / 1.2 : 1;
      const im = this.meshes.get(c.kind)!;
      const n = counts.get(c.kind)!;
      if (n >= MAX_PER_KIND) continue;
      this.e.set(c.rx, c.ry, c.rz);
      this.q.setFromEuler(this.e);
      this.p.set(c.x, c.y - (1 - fade) * c.sy * 0.6, c.z);
      this.s.set(c.sx * fade, c.sy * fade, c.sz * fade);
      this.m4.compose(this.p, this.q, this.s);
      im.setMatrixAt(n, this.m4);
      counts.set(c.kind, n + 1);
      this.chunks[w++] = c;
    }
    this.chunks.length = w;
    for (const [k, im] of this.meshes) {
      im.count = counts.get(k)!;
      im.instanceMatrix.needsUpdate = true;
    }
  }
}
