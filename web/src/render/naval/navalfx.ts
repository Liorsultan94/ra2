import * as THREE from 'three';
import { WATER_LEVEL } from '../../sim/map';
import type { Effects } from '../effects';
import type { FogOfWar } from '../fog';
import { waterRings } from '../water';

/*
 * NV1 naval effects (render only): white wakes behind moving boats, bow spray and bow / stern waves, and the oily,
 * burning slick a sinking boat leaves.
 *
 * The wake is a trail of soft foam patches laid on the water behind the stern: each one spreads and fades over a
 * few seconds (one instanced mesh for every boat on the map: one draw call). Fast boats also throw spray off the
 * bow and send ring waves through the water shader (water.ts waterRings: the same rings the shell splashes and
 * the river boats use). Everything here is cosmetic and uses Math.random freely (never the sim).
 */

const MAX = 720;
const LIFE = 3.4;

function foamTexture(): THREE.Texture {
  const N = 64;
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const dx = (x + 0.5) / N - 0.5;
      const dy = (y + 0.5) / N - 0.5;
      const r = Math.hypot(dx, dy) * 2;
      // a soft disc with a frothy rim
      const n = Math.sin(x * 1.7 + y * 0.6) * 0.5 + Math.sin(x * 0.4 - y * 1.9) * 0.5;
      const a = Math.max(0, 1 - r) ** 1.5 * (0.75 + 0.25 * n);
      const i = (y * N + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
    }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.needsUpdate = true;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  return t;
}

interface Patch {
  x: number;
  z: number;
  yaw: number;
  t: number;
  w0: number;
  len: number;
  a: number;
  /** Drift (tiles / s): the side patches spread outward, so the wake opens into a V. */
  vx: number;
  vz: number;
}

export class NavalFx {
  readonly group = new THREE.Group();
  private mesh: THREE.InstancedMesh;
  private patches: Patch[] = [];
  private next = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();
  private c = new THREE.Color();
  private up = new THREE.Vector3(0, 1, 0);
  /** Per boat (visual id): distance travelled since the last foam patch, spray timer. */
  private acc = new Map<number, { d: number; spray: number; ring: number }>();

  constructor(
    private effects: Effects,
    fog: FogOfWar,
    quality: 'low' | 'medium' | 'high',
  ) {
    // (additive: a patch fades out by its instance colour going to black)
    const mat = new THREE.MeshBasicMaterial({ map: foamTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffffff });
    fog.apply(mat);
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(geo, mat, quality === 'low' ? MAX / 2 : MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'naval-wakes';
    this.group.add(this.mesh);
    this.group.name = 'naval';
  }

  /**
   * A boat this frame (visible, on the water): lay its wake, throw spray. (x, z) its position, yaw the renderer's
   * model yaw, speed in tiles / s, len / beam its size, hover: a hovercraft (a spray skirt all round, no bow wave).
   */
  boat(id: number, x: number, z: number, yaw: number, speed: number, moved: number, len: number, beam: number, dt: number, hover: boolean, onWater: boolean) {
    let a = this.acc.get(id);
    if (!a) this.acc.set(id, (a = { d: 0, spray: 0, ring: 0 }));
    if (!onWater || speed < 0.15) return;
    const fx = Math.cos(-yaw);
    const fz = Math.sin(-yaw);
    a.d += moved;
    const step = 0.09 + len * 0.05;
    const v = Math.min(1, speed / 3.5);
    while (a.d >= step) {
      a.d -= step;
      // two foam patches either side of the stern, and the churned centre (the screws / waterjets)
      const sx = x - fx * len * 0.48;
      const sz = z - fz * len * 0.48;
      // (additive patches overlap two or three deep along the trail: each stays faint, so the wake reads as foam, not paint)
      this.add(sx, sz, yaw, beam * (hover ? 1.1 : 0.6), len * 0.28, 0.2 + 0.18 * v);
      if (!hover) {
        const px = -fz;
        const pz = fx;
        const out = 0.18 + 0.3 * v;
        for (const s of [-1, 1]) this.add(sx + px * s * beam * 0.45, sz + pz * s * beam * 0.45, yaw + s * 0.35, beam * 0.4, len * 0.22, 0.15 + 0.15 * v, px * s * out, pz * s * out);
      }
    }
    // spray off the bow at speed, bow / stern waves as rings through the water
    a.spray -= dt;
    if (a.spray <= 0 && v > 0.35) {
      a.spray = 0.07 + (1 - v) * 0.12;
      const bx = x + fx * len * (hover ? 0.3 : 0.42);
      const bz = z + fz * len * (hover ? 0.3 : 0.42);
      const px = -fz;
      const pz = fx;
      for (const s of hover ? [-1, 1, 0] : [-1, 1]) {
        const ox = hover && s === 0 ? -fx * len * 0.4 : px * s * beam * 0.5;
        const oz = hover && s === 0 ? -fz * len * 0.4 : pz * s * beam * 0.5;
        this.effects.spray(bx + ox, WATER_LEVEL + 0.03, bz + oz, px * s * 0.8 + fx * speed * 0.3, pz * s * 0.8 + fz * speed * 0.3, 0.35 + 0.4 * v * Math.min(1.4, len));
      }
    }
    a.ring -= dt;
    if (a.ring <= 0) {
      a.ring = 0.9 - v * 0.4;
      waterRings.add(x + fx * len * 0.4, z + fz * len * 0.4, 0.18 + 0.3 * v * Math.min(1.5, len));
    }
  }

  /**
   * A Combat Diver this frame (visible): submerged it leaves a trail of bubbles breaking the surface behind it (a few
   * small pale discs, gentle) and, moving, a faint fading wisp of foam; wading in the shallows it leaves a small
   * ripple and a short wake. On land: nothing.
   */
  diver(id: number, x: number, z: number, yaw: number, speed: number, moved: number, dive: boolean, wade: boolean, dt: number) {
    if (!dive && !wade) return;
    let a = this.acc.get(id);
    if (!a) this.acc.set(id, (a = { d: 0, spray: 0, ring: 0 }));
    const fx = Math.cos(-yaw);
    const fz = Math.sin(-yaw);
    const moving = speed > 0.15;
    a.spray -= dt;
    if (dive) {
      // (bubbles rise from the tank behind it: more while it kicks along, a few while it hangs still)
      if (a.spray <= 0) {
        a.spray = moving ? 0.1 : 0.45;
        const j = (Math.random() - 0.5) * 0.06;
        this.effects.bubble(x - fx * 0.12 - fz * j, WATER_LEVEL + 0.005, z - fz * 0.12 + fx * j);
      }
      if (moving) {
        a.d += moved;
        if (a.d >= 0.16) {
          a.d = 0;
          this.add(x - fx * 0.1, z - fz * 0.1, yaw, 0.1, 0.22, 0.13);
        }
      }
    } else if (moving) {
      // wading: a short wake round the knees and a small ring now and then
      a.d += moved;
      if (a.d >= 0.14) {
        a.d = 0;
        this.add(x - fx * 0.06, z - fz * 0.06, yaw, 0.12, 0.2, 0.2);
      }
      a.ring -= dt;
      if (a.ring <= 0) {
        a.ring = 0.7;
        waterRings.add(x, z, 0.1);
      }
    }
  }

  /** A boat went down at (x, z): the water closes over it in a ring and a spreading boil of foam. */
  sunk(x: number, z: number, len: number) {
    waterRings.add(x, z, Math.min(2, 0.6 + len * 0.6));
    for (let i = 0; i < 6; i++) this.add(x + (Math.random() - 0.5) * len * 0.6, z + (Math.random() - 0.5) * len * 0.6, Math.random() * 6.28, len * 0.6, len * 0.6, 0.6);
  }

  /** The boat's visual is gone: forget its wake state. */
  forget(id: number) {
    this.acc.delete(id);
  }

  private add(x: number, z: number, yaw: number, w: number, len: number, a: number, vx = 0, vz = 0) {
    const cap = this.mesh.instanceMatrix.count;
    const p = { x, z, yaw, t: 0, w0: w, len, a, vx, vz };
    if (this.patches.length < cap) this.patches.push(p);
    else {
      this.patches[this.next] = p;
      this.next = (this.next + 1) % cap;
    }
  }

  update(dt: number, dark: number) {
    const ps = this.patches;
    let n = 0;
    // (night: the foam keeps a faint moonlit grey instead of daylight white)
    const lum = 1 - dark * 0.65;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      p.t += dt;
      const k = p.t / LIFE;
      if (k >= 1) continue;
      const grow = 1 + k * 1.6;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      this.q.setFromAxisAngle(this.up, p.yaw);
      this.s.set(p.len * (1 + k * 0.8), 1, p.w0 * grow);
      this.p.set(p.x, WATER_LEVEL + 0.012, p.z);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(n, this.m);
      const f = p.a * (1 - k) * (1 - k) * Math.min(1, p.t * 6) * lum;
      this.mesh.setColorAt(n, this.c.setRGB(f, f, f));
      n++;
    }
    // compact the dead patches away now and then
    if (ps.length > 64 && n < ps.length * 0.6) {
      this.patches = ps.filter((p) => p.t < LIFE);
      this.next = 0;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.MeshBasicMaterial).map?.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
