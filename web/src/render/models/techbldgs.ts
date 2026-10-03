import * as THREE from 'three';
import type { FogOfWar } from '../fog';
import { GeoBuilder } from '../geo';
import type { Builder } from './registry';
import type { AnimState, Model, ModelStyle } from './types';

/*
 * Models for the special map objects:
 *  - civ_garrison: the flag a garrisoned civilian house flies (the house itself
 *    is scenery: render/scenery.ts + envdamage.ts).
 * The capturable tech structures (tech_*) and the nations' superweapon
 * complexes (sw_*) live in buildings.ts with the other base structures.
 * Geometry is merged per building into one vertex-coloured mesh plus an
 * emissive mesh for lamps / lenses, so each costs a couple of draw calls.
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const C = (hex: number) => new THREE.Color(hex);

const matCache = new Map<string, THREE.Material>();
function mat(key: string, fog: FogOfWar | null, make: () => THREE.Material): THREE.Material {
  const k = `${key}:${fog ? 'f' : 'n'}`;
  let m = matCache.get(k);
  if (!m) {
    m = make();
    if (fog) fog.apply(m);
    matCache.set(k, m);
  }
  return m;
}
const vcMat = (fog: FogOfWar | null) => mat('vc', fog, () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.08 }));
const glowMat = (fog: FogOfWar | null) => mat('glow', fog, () => new THREE.MeshStandardMaterial({ vertexColors: true, emissive: 0xffffff, emissiveIntensity: 1.6, roughness: 0.4, toneMapped: false }));

class Kit {
  readonly b = new GeoBuilder();
  readonly g = new GeoBuilder();
  readonly root = new THREE.Group();
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  constructor(
    readonly style: ModelStyle,
    readonly fog: FogOfWar | null,
  ) {}

  private put(geo: THREE.BufferGeometry, x: number, y: number, z: number, col: number | THREE.Color, rotY = 0, glow = false, rotX = 0, rotZ = 0) {
    this.q.setFromEuler(new THREE.Euler(rotX, rotY, rotZ, 'YXZ'));
    this.m4.compose(V(x, y, z), this.q, V(1, 1, 1));
    (glow ? this.g : this.b).add(geo, this.m4, null, typeof col === 'number' ? C(col) : col);
  }
  /** Box resting on y (bottom face at y). */
  box(w: number, h: number, d: number, x: number, y: number, z: number, col: number | THREE.Color, rotY = 0, glow = false) {
    this.put(new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0), x, y, z, col, rotY, glow);
  }
  /** Tilted box (centre at x,y,z). */
  tbox(w: number, h: number, d: number, x: number, y: number, z: number, col: number | THREE.Color, rotY: number, rotX: number, rotZ = 0) {
    this.put(new THREE.BoxGeometry(w, h, d), x, y, z, col, rotY, false, rotX, rotZ);
  }
  cyl(r0: number, r1: number, h: number, x: number, y: number, z: number, col: number | THREE.Color, seg = 12, glow = false) {
    this.put(new THREE.CylinderGeometry(r1, r0, h, seg).translate(0, h / 2, 0), x, y, z, col, 0, glow);
  }
  /** Cylinder lying along an axis (centre at x,y,z). */
  tube(r: number, len: number, x: number, y: number, z: number, col: number | THREE.Color, rotY: number, rotZ: number, seg = 10) {
    this.put(new THREE.CylinderGeometry(r, r, len, seg), x, y, z, col, rotY, false, 0, rotZ);
  }
  sph(r: number, x: number, y: number, z: number, col: number | THREE.Color, glow = false, half = false) {
    this.put(new THREE.SphereGeometry(r, 14, half ? 6 : 10, 0, Math.PI * 2, 0, half ? Math.PI / 2 : Math.PI), x, y, z, col, 0, glow);
  }
  /** Line beam between two points. */
  bar(a: THREE.Vector3, c: THREE.Vector3, t: number, col: number | THREE.Color) {
    const len = a.distanceTo(c);
    const geo = new THREE.BoxGeometry(t, len, t);
    const mid = a.clone().add(c).multiplyScalar(0.5);
    const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), c.clone().sub(a).normalize());
    this.b.add(geo, new THREE.Matrix4().compose(mid, q, V(1, 1, 1)), null, typeof col === 'number' ? C(col) : col);
  }

  /** Owner flag on a pole at (x, z), base height y; returns the cloth for the wave animation. */
  flag(x: number, y: number, z: number, h = 0.7): THREE.Mesh {
    this.cyl(0.012, 0.012, h, x, y, z, 0x9a9ea2, 6);
    this.sph(0.022, x, y + h, z, 0xd8c060);
    const neutral = this.style.faction === 'neutral';
    const cloth = new THREE.PlaneGeometry(0.34, 0.2, 6, 1).translate(0.17, 0, 0);
    const cols: number[] = [];
    const pos = cloth.attributes.position;
    const stripes = neutral ? [0xd8d8d0, 0xd8d8d0, 0xd8d8d0] : this.style.flag;
    for (let i = 0; i < pos.count; i++) {
      const v = pos.getY(i);
      const c = C(neutral ? 0xe0e0d8 : v > 0.03 ? stripes[0] : v < -0.03 ? stripes[2] : stripes[1]);
      cols.push(c.r, c.g, c.b);
    }
    cloth.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    const m = new THREE.Mesh(cloth, mat('flag', this.fog, () => new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9 })));
    m.position.set(x + 0.01, y + h - 0.12, z);
    m.castShadow = true;
    m.userData.base = Float32Array.from(pos.array as Float32Array);
    this.root.add(m);
    // team pennant stripe under the flag
    if (!neutral) this.box(0.02, 0.06, 0.02, x, y + h - 0.32, z, this.style.team);
    return m;
  }

  finish(height: number, size: { x: number; y: number; z: number }, anim?: (s: AnimState) => void, extra?: Partial<Model>): Model {
    if (this.b.count) {
      const mesh = new THREE.Mesh(this.b.build(), vcMat(this.fog));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);
    }
    if (this.g.count) {
      const mesh = new THREE.Mesh(this.g.build(), glowMat(this.fog));
      this.root.add(mesh);
    }
    return { root: this.root, muzzles: [], height, size, glow: [], emitters: [], anim, ...extra };
  }
}

function waveFlag(m: THREE.Mesh, t: number, k = 1) {
  const base = m.userData.base as Float32Array;
  const pos = m.geometry.attributes.position as THREE.BufferAttribute;
  const a = pos.array as Float32Array;
  for (let i = 0; i < pos.count; i++) {
    const x = base[i * 3];
    a[i * 3 + 2] = Math.sin(t * 5 - x * 14) * 0.03 * (x / 0.34) * k;
  }
  pos.needsUpdate = true;
}

// --------------------------------------------------------------- garrison

const civGarrison: Builder = (style, fog) => {
  const k = new Kit(style, fog);
  if (style.faction === 'neutral') return k.finish(1.1, { x: 0.01, y: 1.1, z: 0.01 });
  // owner flag over the roof ridge + sandbags at the door
  const cloth = k.flag(0.18, 0.95, 0.05, 0.75);
  for (let i = 0; i < 5; i++) k.box(0.13, 0.06, 0.08, -0.3 + i * 0.15, 0, 0.62 + (i % 2) * 0.02, 0x9a8a62, (i % 2) * 0.2);
  for (let i = 0; i < 4; i++) k.box(0.13, 0.06, 0.08, -0.22 + i * 0.15, 0.06, 0.62, 0xa8986c, 0.1);
  return k.finish(1.1, { x: 0.01, y: 1.1, z: 0.01 }, (s) => waveFlag(cloth, s.time));
};

export const TECH_MODELS: Record<string, Builder> = {
  civ_garrison: civGarrison,
};
