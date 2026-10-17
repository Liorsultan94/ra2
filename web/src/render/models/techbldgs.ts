import * as THREE from 'three';
import type { FogOfWar } from '../fog';
import { onFogRelease, purgeKeys } from '../fogcache';
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
// a finished match: drop the materials bound to its fog (fogcache.ts); the next match binds its own
onFogRelease(() => purgeKeys(matCache, (k) => k.endsWith(':f')));
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

function makeCivGarrison(wTiles: number, dTiles: number): Builder {
  return (style, fog) => {
    const k = new Kit(style, fog);
    const hw = wTiles * 0.43;
    const hd = dTiles * 0.43;
    if (style.faction === 'neutral') return k.finish(1.1, { x: 0.01, y: 1.1, z: 0.01 });

    const hostile = !!style.hostile;
    const bagA = hostile ? 0x625a4c : 0x9e9068;
    const bagB = hostile ? 0x524b3f : 0xada076;
    const bagTop = hostile ? 0x706656 : 0xb8ab82;
    const steel = 0x2b3036;
    const gunMetal = 0x1e2226;
    const trimCol = hostile ? 0xd82218 : style.team;
    const beaconCol = hostile ? 0xff2418 : 0x38f0ff;
    const slitCol = hostile ? 0xff3c18 : 0x58e8ff;

    // Helper: stacked 3-tier sandbag wall segment along local X, centered at (cx, 0, cz) rotated by rotY
    const sandbagWall = (cx: number, cz: number, count: number, rotY: number) => {
      const cos = Math.cos(rotY);
      const sin = Math.sin(rotY);
      const span = count * 0.145;
      for (let row = 0; row < 3; row++) {
        const n = row === 2 ? Math.max(1, count - 1) : count;
        const y = row * 0.058;
        const col = row === 2 ? bagTop : row === 1 ? bagB : bagA;
        for (let i = 0; i < n; i++) {
          const lx = -span * 0.5 + (i + 0.5 + (row === 1 ? 0.15 : 0)) * (span / n);
          const lz = ((i + row) % 2) * 0.016 - 0.008;
          const wx = cx + lx * cos + lz * sin;
          const wz = cz - lx * sin + lz * cos;
          k.box(0.135, 0.056, 0.088, wx, y, wz, col, rotY + ((i % 2) - 0.5) * 0.12);
        }
      }
    };

    // 1. 360-degree perimeter sandbag emplacements around all 4 sides + angled corner bunkers
    const nxSide = wTiles >= 3 ? 4 : 3;
    // Front (+hd): two flanking sandbag bunkers leaving a fortified entrance chicane
    sandbagWall(-hw * 0.55, hd, nxSide, 0);
    sandbagWall(hw * 0.55, hd, nxSide, 0);
    // Back (-hd)
    sandbagWall(-hw * 0.52, -hd, nxSide, 0);
    sandbagWall(hw * 0.52, -hd, nxSide, 0);
    // Left (-hw) & Right (+hw)
    sandbagWall(-hw, 0, 4, Math.PI / 2);
    sandbagWall(hw, 0, 4, Math.PI / 2);
    // 4 angled corner bastions
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      const ca = Math.atan2(sx, sz);
      sandbagWall(sx * (hw - 0.06), sz * (hd - 0.06), 3, ca);
      // Heavy gun barrel poking over each corner sandbag nest
      k.tube(0.014, 0.26, sx * (hw + 0.02), 0.19, sz * (hd + 0.02), gunMetal, ca + Math.PI / 2, Math.PI / 2, 6);
    }

    // 2. Armored steel window shutters with glowing tactical firing slits & rifle barrels on all 4 walls
    const wxWall = hw - 0.16;
    const wzWall = hd - 0.16;
    const winXs = wTiles >= 3 ? [-0.52, 0, 0.52] : [-0.32, 0.32];
    for (const x of winXs) {
      for (const sz of [-1, 1]) {
        const z = sz * wzWall;
        // Steel blast shutter + team/threat header bar + glowing firing slit + protruding barrel
        k.box(0.24, 0.18, 0.03, x, 0.34, z, steel);
        k.box(0.25, 0.03, 0.036, x, 0.49, z, trimCol);
        k.box(0.18, 0.028, 0.038, x, 0.41, z, slitCol, 0, true);
        k.tube(0.012, 0.22, x, 0.41, z + sz * 0.09, gunMetal, Math.PI / 2, Math.PI / 2, 6);
      }
    }
    for (const z of [-0.28, 0.28]) {
      for (const sx of [-1, 1]) {
        const x = sx * wxWall;
        k.box(0.03, 0.18, 0.24, x, 0.34, z, steel);
        k.box(0.036, 0.03, 0.25, x, 0.49, z, trimCol);
        k.box(0.038, 0.028, 0.18, x, 0.41, z, slitCol, 0, true);
        k.tube(0.012, 0.22, x + sx * 0.09, 0.41, z, gunMetal, 0, Math.PI / 2, 6);
      }
    }

    // 3. Rooftop command frame, IFF/Threat light strips, corner beacons, flag & rotating comms dish
    const rw = (hw - 0.1) * 2;
    const rd = (hd - 0.1) * 2;
    const ry = 0.68;
    // Bold roof perimeter armor band + glowing IFF/Hostile neon strip
    k.box(rw, 0.055, 0.045, 0, ry, hd - 0.1, trimCol);
    k.box(rw, 0.055, 0.045, 0, ry, -(hd - 0.1), trimCol);
    k.box(0.045, 0.055, rd, hw - 0.1, ry, 0, trimCol);
    k.box(0.045, 0.055, rd, -(hw - 0.1), ry, 0, trimCol);
    k.box(rw + 0.01, 0.018, 0.05, 0, ry + 0.055, hd - 0.1, beaconCol, 0, true);
    k.box(rw + 0.01, 0.018, 0.05, 0, ry + 0.055, -(hd - 0.1), beaconCol, 0, true);
    k.box(0.05, 0.018, rd + 0.01, hw - 0.1, ry + 0.055, 0, beaconCol, 0, true);
    k.box(0.05, 0.018, rd + 0.01, -(hw - 0.1), ry + 0.055, 0, beaconCol, 0, true);

    // 4 Corner tactical strobe masts
    for (const [sx, sz] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      const bx = sx * (hw - 0.1);
      const bz = sz * (hd - 0.1);
      k.cyl(0.016, 0.014, 0.22, bx, ry + 0.05, bz, steel, 6);
      k.sph(0.036, bx, ry + 0.28, bz, beaconCol, true);
    }

    // Rooftop sandbag nest + waving nation flag
    sandbagWall(0, 0.18, 3, 0);
    const cloth = k.flag(0.22, 0.92, 0.06, 0.85);
    // Extra team banner board on the roof
    k.box(0.32, 0.12, 0.025, -0.22, 0.74, hd - 0.1, trimCol);

    // Rotating rooftop tactical radar / comms dish
    const dish = new THREE.Group();
    dish.position.set(-0.24, 0.92, -0.15);
    const db = new GeoBuilder();
    const dm = new THREE.Matrix4();
    db.add(new THREE.BoxGeometry(0.18, 0.04, 0.035).translate(0, 0.08, 0), dm, null, C(trimCol));
    db.add(new THREE.BoxGeometry(0.04, 0.045, 0.045).translate(0.09, 0.08, 0), dm, null, C(beaconCol));
    const dishMesh = new THREE.Mesh(db.build(), vcMat(fog));
    dishMesh.castShadow = true;
    dish.add(dishMesh);
    k.cyl(0.03, 0.02, 0.1, -0.24, 0.84, -0.15, steel, 6);
    k.root.add(dish);

    // 4. Distinct Friendly vs Enemy ground & roof fortifications
    if (!hostile) {
      // OUR FORCE: Camo tactical tarp over front entrance bunker + friendly supply/medical crates + warm floodlight
      const cw = 0.56;
      const cd = 0.32;
      const cz = hd - 0.04;
      k.cyl(0.014, 0.014, 0.38, -cw * 0.46, 0, cz + cd * 0.4, steel, 6);
      k.cyl(0.014, 0.014, 0.38, cw * 0.46, 0, cz + cd * 0.4, steel, 6);
      k.tbox(cw, 0.022, cd, 0, 0.39, cz, style.hull, 0, 0.12);
      k.box(cw * 0.92, 0.024, 0.04, 0, 0.37, cz + cd * 0.46, style.team);
      // Warm entrance floodlight + friendly blue/white supply crates
      k.box(0.12, 0.035, 0.04, 0, 0.35, cz + cd * 0.44, 0x38f0ff, 0, true);
      k.box(0.16, 0.11, 0.12, -hw + 0.12, 0, hd - 0.22, 0x2878c8, 0.2);
      k.box(0.12, 0.02, 0.08, -hw + 0.12, 0.11, hd - 0.22, 0xf0f6ff, 0.2);
      k.box(0.15, 0.1, 0.11, hw - 0.12, 0, hd - 0.22, 0x4a5d3c, -0.15);
    } else {
      // ENEMY FORCE: Steel Czech hedgehogs (anti-tank X-beams), razor-wire coils & red/black hazard barricades
      const hedgehog = (hx: number, hz: number) => {
        k.tbox(0.026, 0.28, 0.026, hx, 0.11, hz, gunMetal, 0.3, 0.65, 0);
        k.tbox(0.026, 0.28, 0.026, hx, 0.11, hz, gunMetal, 1.35, -0.65, 0);
        k.tbox(0.026, 0.28, 0.026, hx, 0.11, hz, gunMetal, 2.4, 0, 0.65);
        k.sph(0.02, hx, 0.22, hz, 0xff2418, true);
      };
      hedgehog(-hw - 0.06, hd + 0.06);
      hedgehog(hw + 0.06, hd + 0.06);
      hedgehog(-hw - 0.06, -hd - 0.06);
      hedgehog(hw + 0.06, -hd - 0.06);
      // Red/black hazard barricade boards + razor-wire coils across front & back
      for (const sz of [-1, 1]) {
        for (const sx of [-1, 1]) {
          const bx = sx * hw * 0.55;
          const bz = sz * (hd + 0.07);
          k.box(0.32, 0.045, 0.022, bx, 0.12, bz, 0xd82218);
          k.box(0.12, 0.048, 0.025, bx, 0.12, bz, 0x181a1c);
          // Razor-wire coils
          for (let c = -1; c <= 1; c++) {
            k.cyl(0.055, 0.055, 0.018, bx + c * 0.09, 0.16, bz + sz * 0.03, 0x585c60, 8);
          }
        }
      }
    }

    return k.finish(1.15, { x: wTiles, y: 1.15, z: dTiles }, (s) => {
      waveFlag(cloth, s.time);
      dish.rotation.y = s.time * (hostile ? -2.4 : 1.6);
    });
  };
}

export const TECH_MODELS: Record<string, Builder> = {
  civ_garrison: makeCivGarrison(2, 2),
  civ_garrison_wide: makeCivGarrison(3, 2),
};
