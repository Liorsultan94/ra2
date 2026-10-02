import * as THREE from 'three';
import type { FogOfWar } from '../fog';
import { GeoBuilder } from '../geo';
import type { Builder } from './registry';
import type { AnimState, Model, ModelStyle } from './types';

/*
 * Models for the special map objects:
 *  - civ_garrison: the flag a garrisoned civilian house flies (the house itself
 *    is scenery: render/scenery.ts + envdamage.ts);
 *  - tech_hospital / tech_airport / tech_comms: neutral civilian tech structures
 *    (owner flag once captured);
 *  (the nations' superweapon complexes sw_* live in buildings.ts with the
 *    other base structures).
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

/** Concrete pad for a w x d footprint with a kerb. */
function pad(k: Kit, w: number, d: number, col = 0x8c8a84) {
  k.box(w - 0.04, 0.04, d - 0.04, 0, 0, 0, col);
  k.box(w - 0.04, 0.05, 0.04, 0, 0, d / 2 - 0.04, 0x6e6c66);
  k.box(w - 0.04, 0.05, 0.04, 0, 0, -d / 2 + 0.04, 0x6e6c66);
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

// ------------------------------------------------------------ tech: hospital

const techHospital: Builder = (style, fog) => {
  const k = new Kit(style, fog);
  pad(k, 2, 2, 0x9a978e);
  // main prefab ward
  k.box(1.25, 0.42, 0.7, -0.25, 0.04, -0.35, 0xe8e6e0);
  k.box(1.29, 0.04, 0.74, -0.25, 0.46, -0.35, 0xb8b6b0);
  for (let i = 0; i < 4; i++) k.box(0.16, 0.1, 0.01, -0.7 + i * 0.3, 0.24, 0.005, 0x5a7a96);
  k.box(0.22, 0.3, 0.02, 0.18, 0.04, 0.005, 0x6a6a6a);
  // red cross on the roof and the wall
  k.box(0.42, 0.012, 0.12, -0.25, 0.5, -0.35, 0xd0201a);
  k.box(0.12, 0.012, 0.42, -0.25, 0.5, -0.35, 0xd0201a);
  k.box(0.18, 0.05, 0.012, -0.65, 0.28, 0.01, 0xd0201a);
  k.box(0.05, 0.18, 0.012, -0.65, 0.215, 0.01, 0xd0201a);
  // field tent annex
  k.box(0.6, 0.26, 0.5, 0.62, 0.04, -0.4, 0x8a8a5a);
  k.tbox(0.64, 0.02, 0.34, 0.62, 0.38, -0.52, 0x7a7a4c, 0, 0.55);
  k.tbox(0.64, 0.02, 0.34, 0.62, 0.38, -0.28, 0x7a7a4c, 0, -0.55);
  // helipad
  k.cyl(0.42, 0.42, 0.012, 0.4, 0.04, 0.5, 0x4a4a48, 24);
  k.box(0.04, 0.014, 0.24, 0.31, 0.045, 0.5, 0xf0f0e8);
  k.box(0.04, 0.014, 0.24, 0.49, 0.045, 0.5, 0xf0f0e8);
  k.box(0.18, 0.014, 0.04, 0.4, 0.045, 0.5, 0xf0f0e8);
  // ambulance
  k.box(0.36, 0.16, 0.18, -0.55, 0.04, 0.5, 0xf2f2ec);
  k.box(0.12, 0.012, 0.04, -0.55, 0.2, 0.5, 0xd0201a);
  k.box(0.04, 0.03, 0.06, -0.55, 0.205, 0.5, 0x3070ff, 0, true);
  k.box(0.06, 0.04, 0.04, -0.3, 0.46, -0.1, 0xff5040, 0, true);
  const cloth = k.flag(0.85, 0.04, -0.85, 0.9);
  return k.finish(0.9, { x: 2, y: 0.9, z: 2 }, (s) => waveFlag(cloth, s.time), {
    nightLights: [{ pos: V(0.18, 0.4, 0.06), color: 0xfff0d0, intensity: 1 }],
  });
};

// ------------------------------------------------------------- tech: airport

const techAirport: Builder = (style, fog) => {
  const k = new Kit(style, fog);
  pad(k, 3, 3, 0x8f8c84);
  // runway strip with centre-line dashes
  k.box(2.9, 0.012, 0.62, 0, 0.04, 0.95, 0x3c3c3c);
  for (let i = 0; i < 7; i++) k.box(0.2, 0.014, 0.03, -1.2 + i * 0.4, 0.05, 0.95, 0xf0f0e0);
  for (const sx of [-1.38, 1.38]) for (let j = 0; j < 4; j++) k.box(0.04, 0.014, 0.08, sx, 0.05, 0.75 + j * 0.13, 0xf0f0e0);
  // terminal with glass front
  k.box(1.3, 0.38, 0.6, -0.55, 0.04, -0.7, 0xc8c4b8);
  k.box(1.26, 0.2, 0.01, -0.55, 0.12, -0.395, 0x406a8c);
  k.box(1.34, 0.03, 0.64, -0.55, 0.42, -0.7, 0x9a968c);
  // control tower
  k.cyl(0.11, 0.09, 0.9, 0.35, 0.04, -0.9, 0xd0ccc0, 10);
  k.cyl(0.2, 0.17, 0.14, 0.35, 0.94, -0.9, 0x3a5a78, 10);
  k.cyl(0.21, 0.21, 0.03, 0.35, 1.08, -0.9, 0x5a5a5a, 10);
  k.cyl(0.012, 0.012, 0.16, 0.35, 1.11, -0.9, 0x8a8a8a, 4);
  k.sph(0.03, 0.35, 1.28, -0.9, 0xff3020, true);
  // hangar (half cylinder)
  const hg = new THREE.CylinderGeometry(0.38, 0.38, 0.8, 14, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateY(Math.PI / 2);
  k.b.add(hg, new THREE.Matrix4().makeTranslation(0.95, 0.04, -0.1), null, C(0x8a8e90));
  // parked airliner
  k.tube(0.07, 0.95, -0.35, 0.16, 0.25, 0xeef0f2, 0, Math.PI / 2);
  k.box(0.28, 0.012, 0.9, -0.38, 0.12, 0.25, 0xd0d4d8);
  k.box(0.1, 0.012, 0.34, 0.03, 0.18, 0.25, 0xd0d4d8);
  k.box(0.12, 0.18, 0.012, 0.03, 0.18, 0.25, style.faction === 'neutral' ? 0x2a6ac0 : style.team);
  k.box(0.9, 0.02, 0.012, -0.35, 0.17, 0.32, 0x2a6ac0);
  const cloth = k.flag(-1.35, 0.04, -1.3, 1.0);
  return k.finish(1.3, { x: 3, y: 1.3, z: 3 }, (s) => waveFlag(cloth, s.time), {
    nightLights: [
      { pos: V(0.35, 1.0, -0.9), color: 0xb0e0ff, intensity: 1.2 },
      { pos: V(-0.55, 0.3, -0.38), color: 0xfff0d0, intensity: 1 },
    ],
  });
};

// --------------------------------------------------------------- tech: comms

const techComms: Builder = (style, fog) => {
  const k = new Kit(style, fog);
  pad(k, 2, 2, 0x8e8b82);
  // lattice mast
  const H = 2.5;
  const r0 = 0.32;
  const r1 = 0.06;
  const cx = 0.2;
  const cz = -0.2;
  const legs = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const red = 0xc03020;
  const wht = 0xe8e8e0;
  for (const [sx, sz] of legs) k.bar(V(cx + sx * r0, 0.04, cz + sz * r0), V(cx + sx * r1, H, cz + sz * r1), 0.03, 0xb0b0a8);
  for (let i = 0; i < 6; i++) {
    const y0 = 0.04 + (i / 6) * H;
    const y1 = 0.04 + ((i + 1) / 6) * H;
    const ra = r0 + (r1 - r0) * (i / 6);
    const rb = r0 + (r1 - r0) * ((i + 1) / 6);
    const col = i % 2 ? red : wht;
    for (let s = 0; s < 4; s++) {
      const [ax, az] = legs[s];
      const [bx, bz] = legs[(s + 1) % 4];
      k.bar(V(cx + ax * ra, y0, cz + az * ra), V(cx + bx * rb, y1, cz + bz * rb), 0.012, col);
      k.bar(V(cx + ax * rb, y1, cz + az * rb), V(cx + bx * rb, y1, cz + bz * rb), 0.014, col);
    }
  }
  // dishes and panel antennas
  for (const [y, a] of [
    [1.5, 0.6],
    [1.9, 2.4],
    [1.2, 4.1],
  ] as [number, number][]) {
    const dish = new THREE.SphereGeometry(0.16, 12, 6, 0, Math.PI * 2, 0, Math.PI / 3).rotateZ(-Math.PI / 2);
    const x = cx + Math.cos(a) * 0.14;
    const z = cz + Math.sin(a) * 0.14;
    k.b.add(dish, new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -a, 0)), V(1, 1, 1)), null, C(0xdcdcd4));
  }
  for (let i = 0; i < 3; i++) k.box(0.05, 0.22, 0.02, cx + Math.cos(i * 2.1) * 0.09, 2.15, cz + Math.sin(i * 2.1) * 0.09, 0xd8d8d0, i * 2.1);
  k.sph(0.035, cx, H + 0.02, cz, 0xff2010, true);
  k.sph(0.025, cx + r0 * 0.6, 1.3, cz + r0 * 0.6, 0xff2010, true);
  // equipment shelter + generator
  k.box(0.6, 0.3, 0.4, -0.45, 0.04, 0.45, 0xd2d0c4);
  k.box(0.64, 0.03, 0.44, -0.45, 0.34, 0.45, 0x8a8880);
  k.box(0.3, 0.16, 0.2, 0.5, 0.04, 0.55, 0x5a6a4a);
  k.tube(0.02, 0.6, 0.0, 0.3, 0.2, 0x404040, Math.PI / 4, Math.PI / 2, 6);
  // fence posts
  for (let i = 0; i < 8; i++) {
    const t = (i / 8) * Math.PI * 2;
    k.cyl(0.012, 0.012, 0.22, Math.cos(t) * 0.9, 0.04, Math.sin(t) * 0.9, 0x7a7a72, 4);
  }
  const cloth = k.flag(-0.85, 0.04, -0.85, 0.8);
  return k.finish(H, { x: 2, y: H, z: 2 }, (s) => waveFlag(cloth, s.time), {
    nightLights: [{ pos: V(cx, H + 0.02, cz), color: 0xff3020, intensity: 1.4 }],
  });
};

export const TECH_MODELS: Record<string, Builder> = {
  civ_garrison: civGarrison,
  tech_hospital: techHospital,
  tech_airport: techAirport,
  tech_comms: techComms,
};
