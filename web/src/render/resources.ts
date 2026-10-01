import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ORE_MAX, Tile, type GameMap } from '../sim/map';
import { hash2, valueNoise } from '../sim/rng';
import type { FogOfWar } from './fog';
import { GeoBuilder } from './geo';
import { surfaceHeight } from './ground';

/*
 * Harvestable resources, modern style: ore (oreKind 1) is a rare-earth / metal
 * ore deposit - dark rust-brown rubble with metallic nuggets; "gems" (oreKind
 * 2) are a high-grade lithium deposit - pale blue-white mineral rubble with
 * glinting crystals. Rubble pieces disappear and shrink as tiles are mined.
 * Each regrowth point (map.oreMines) gets a small drilling rig.
 */

const PER = 5; // pieces per tile: 0..2 rubble piles, 3..4 nuggets/crystals

function chunkGeo(seed: number, detail: number, sharp: number): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const P = g.attributes.position;
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i);
    const y = P.getY(i);
    const z = P.getZ(i);
    const r = 1 + (valueNoise(x * 2 + z, y * 2 + 3, seed) - 0.5) * sharp + (valueNoise(z * 3, x * 3 + y, seed + 1) - 0.5) * sharp * 0.5;
    P.setXYZ(i, x * r, Math.max(-0.3, y * r), z * r);
  }
  g = g.toNonIndexed(); // faceted, catches light like broken rock
  g.computeVertexNormals();
  return g;
}

/** Several chunks merged into one "pile" geometry with per-vertex colour. */
function pileGeo(seed: number, n: number, col: (k: number, y: number) => THREE.Color): THREE.BufferGeometry {
  const b = new GeoBuilder();
  for (let k = 0; k < n; k++) {
    const c = chunkGeo(seed + k * 7, 0, 0.7);
    const a = hash2(k, seed, 1) * Math.PI * 2;
    const rr = k === 0 ? 0 : 0.35 + hash2(k, seed, 2) * 0.35;
    const s = k === 0 ? 0.5 : 0.25 + hash2(k, seed, 3) * 0.22;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(Math.cos(a) * rr, s * 0.35, Math.sin(a) * rr),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(hash2(k, seed, 4) * 3, hash2(k, seed, 5) * 3, hash2(k, seed, 6) * 3)),
      new THREE.Vector3(s, s * 0.7, s),
    );
    const cc = col(k, 0);
    b.add(c, m, null, (p) => {
      const sh = 0.75 + Math.min(0.35, p.y * 0.6) + (hash2(Math.floor(p.x * 50), Math.floor(p.z * 50), k) - 0.5) * 0.2;
      return cc.clone().multiplyScalar(sh);
    });
  }
  return b.build();
}

interface Slot {
  tile: number;
  k: number;
  mesh: THREE.InstancedMesh;
  index: number;
  base: THREE.Matrix4;
}

export class Resources {
  readonly group = new THREE.Group();
  private slots: Slot[] = [];
  private meshes: THREE.InstancedMesh[] = [];
  private cache: Uint8Array;
  private beacon: THREE.MeshStandardMaterial;

  constructor(
    private map: GameMap,
    fog: FogOfWar,
    quality: 'low' | 'medium' | 'high',
  ) {
    const m = map;
    this.cache = new Uint8Array(m.w * m.h).fill(255);
    const shadows = quality !== 'low';

    // materials
    const oreRubbleMat = fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.15, flatShading: true }));
    const oreNuggetMat = fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.85, flatShading: true, emissive: 0x2a1404, emissiveIntensity: 0.6 }));
    const gemRubbleMat = fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.05, flatShading: true }));
    const gemCrystalMat = fog.apply(
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0.35, flatShading: true, emissive: 0x2a5a78, emissiveIntensity: 0.55 }),
    );

    // geometries: rubble piles (several chunks each) and single nuggets / crystals
    const rust = (k: number) => new THREE.Color().setRGB(0.3 + hash2(k, 1, 9) * 0.1, 0.17 + hash2(k, 2, 9) * 0.05, 0.11 + hash2(k, 3, 9) * 0.04);
    const pale = (k: number) => new THREE.Color().setRGB(0.66 + hash2(k, 1, 8) * 0.12, 0.72 + hash2(k, 2, 8) * 0.1, 0.8 + hash2(k, 3, 8) * 0.1);
    const orePile = pileGeo(3, 4, rust);
    const gemPile = pileGeo(17, 4, pale);
    const nugget = (() => {
      const b = new GeoBuilder();
      for (let k = 0; k < 2; k++) {
        const c = chunkGeo(40 + k, 0, 0.9);
        const m4 = new THREE.Matrix4().compose(
          new THREE.Vector3((k - 1) * 0.5, 0.2, (hash2(k, 4, 4) - 0.5) * 0.6),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(k, k * 2, k * 0.5)),
          new THREE.Vector3(0.45, 0.4, 0.45),
        );
        b.add(c, m4, null, new THREE.Color().setRGB(0.72, 0.45 + k * 0.05, 0.22));
      }
      return b.build();
    })();
    const crystal = (() => {
      const b = new GeoBuilder();
      for (let k = 0; k < 3; k++) {
        const c = new THREE.OctahedronGeometry(0.3, 0).scale(0.55, 1.6, 0.55);
        c.computeVertexNormals();
        const m4 = new THREE.Matrix4().compose(
          new THREE.Vector3((hash2(k, 1, 5) - 0.5) * 0.7, 0.25, (hash2(k, 2, 5) - 0.5) * 0.7),
          new THREE.Quaternion().setFromEuler(new THREE.Euler((hash2(k, 3, 5) - 0.5) * 1.2, hash2(k, 4, 5) * 3, (hash2(k, 5, 5) - 0.5) * 1.2)),
          new THREE.Vector3(0.6 + k * 0.1, 0.6 + k * 0.12, 0.6 + k * 0.1),
        );
        b.add(c, m4, null, new THREE.Color().setRGB(0.82, 0.93, 1.0));
      }
      return b.build();
    })();

    // every tile that can ever hold ore gets slots (ore regrows around the rigs)
    const candidate = (i: number) => m.oreKind[i] > 0 || m.oreMines.some((mm) => Math.abs((i % m.w) - mm.x) <= 3 && Math.abs(Math.floor(i / m.w) - mm.y) <= 3);
    const tiles: number[] = [];
    for (let i = 0; i < m.w * m.h; i++) if (candidate(i) && m.tiles[i] !== Tile.Water && m.tiles[i] !== Tile.Rock && !m.blocked[i]) tiles.push(i);
    const kindOf = (i: number) => {
      if (m.oreKind[i]) return m.oreKind[i];
      let best = 1;
      let bd = 1e9;
      for (const mm of m.oreMines) {
        const dd = Math.abs((i % m.w) - mm.x) + Math.abs(Math.floor(i / m.w) - mm.y);
        if (dd < bd) {
          bd = dd;
          best = m.oreKind[mm.y * m.w + mm.x] || 1;
        }
      }
      return best;
    };
    let nOre = 0;
    let nGem = 0;
    for (const i of tiles) (kindOf(i) === 2 ? nGem++ : nOre++);
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number, cast: boolean) => {
      const im = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
      im.castShadow = cast;
      im.receiveShadow = true;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      this.meshes.push(im);
      this.group.add(im);
      return im;
    };
    const oreR = mk(orePile, oreRubbleMat, nOre * 3, shadows);
    const oreN = mk(nugget, oreNuggetMat, nOre * 2, false);
    const gemR = mk(gemPile, gemRubbleMat, nGem * 3, shadows);
    const gemC = mk(crystal, gemCrystalMat, nGem * 2, false);
    const counters = new Map<THREE.InstancedMesh, number>();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    for (const i of tiles) {
      const x = i % m.w;
      const y = Math.floor(i / m.w);
      const gem = kindOf(i) === 2;
      for (let k = 0; k < PER; k++) {
        const nug = k >= 3;
        const ox = x + 0.15 + hash2(x, y, 100 + k) * 0.7;
        const oy = y + 0.15 + hash2(x, y, 200 + k) * 0.7;
        e.set((hash2(x, y, 300 + k) - 0.5) * 0.3, hash2(x, y, 400 + k) * 6.28, (hash2(x, y, 500 + k) - 0.5) * 0.3);
        q.setFromEuler(e);
        const s = nug ? 0.13 + hash2(x, y, 600 + k) * 0.08 : 0.22 + hash2(x, y, 600 + k) * 0.14;
        const base = new THREE.Matrix4().compose(new THREE.Vector3(ox, surfaceHeight(m, ox, oy) - 0.02, oy), q, new THREE.Vector3(s, s * (nug ? 1 : 0.8), s));
        const mesh = gem ? (nug ? gemC : gemR) : nug ? oreN : oreR;
        const index = counters.get(mesh) ?? 0;
        counters.set(mesh, index + 1);
        this.slots.push({ tile: i, k, mesh, index, base });
      }
    }

    // survey stakes around each deposit + drilling rigs
    this.beacon = new THREE.MeshStandardMaterial({ color: 0xff8a20, emissive: 0xff7010, emissiveIntensity: 2, toneMapped: false });
    fog.apply(this.beacon);
    this.buildRigs(fog, shadows);
    this.update(true);
  }

  private buildRigs(fog: FogOfWar, shadows: boolean) {
    const m = this.map;
    const steel = new GeoBuilder();
    const conc = new GeoBuilder();
    const light = new GeoBuilder();
    const box = (b: GeoBuilder, w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color | number, rot?: THREE.Euler) => {
      const mm = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(rot ?? new THREE.Euler()), new THREE.Vector3(1, 1, 1));
      b.add(new THREE.BoxGeometry(w, h, d).toNonIndexed(), mm, null, c);
    };
    /** Thin beam between two points. */
    const beam = (b: GeoBuilder, a: THREE.Vector3, c: THREE.Vector3, t: number, col: THREE.Color | number) => {
      const len = a.distanceTo(c);
      const g = new THREE.BoxGeometry(t, len, t).toNonIndexed();
      const mid = a.clone().add(c).multiplyScalar(0.5);
      const qq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), c.clone().sub(a).normalize());
      b.add(g, new THREE.Matrix4().compose(mid, qq, new THREE.Vector3(1, 1, 1)), null, col);
    };
    const yellow = new THREE.Color(0.85, 0.62, 0.12);
    const grey = new THREE.Color(0.5, 0.5, 0.5);
    const dark = new THREE.Color(0.18, 0.18, 0.19);
    // pad and spoil heap
    box(conc, 0.95, 0.06, 0.95, 0, 0.03, 0, new THREE.Color(0.6, 0.58, 0.54));
    // derrick: tapered lattice
    const H = 1.15;
    const b0 = 0.24;
    const b1 = 0.06;
    const corner = (sx: number, sz: number, t: number) => new THREE.Vector3(sx * (b0 + (b1 - b0) * t), 0.06 + H * t, sz * (b0 + (b1 - b0) * t));
    const cs: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    for (const [sx, sz] of cs) beam(steel, corner(sx, sz, 0), corner(sx, sz, 1), 0.03, yellow);
    for (let lv = 0; lv < 4; lv++) {
      const t0 = lv / 4;
      const t1 = (lv + 1) / 4;
      for (let k = 0; k < 4; k++) {
        const [ax, az] = cs[k];
        const [bx, bz] = cs[(k + 1) % 4];
        beam(steel, corner(ax, az, t1), corner(bx, bz, t1), 0.018, yellow);
        beam(steel, corner(ax, az, t0), corner(bx, bz, t1), 0.012, yellow);
      }
    }
    box(steel, 0.18, 0.08, 0.18, 0, 0.06 + H + 0.04, 0, dark);
    // drill string and rotary table
    beam(steel, new THREE.Vector3(0, 0.06, 0), new THREE.Vector3(0, H, 0), 0.025, grey);
    box(steel, 0.2, 0.06, 0.2, 0, 0.12, 0, dark);
    // engine / pump house with exhaust
    box(steel, 0.34, 0.22, 0.24, 0.3, 0.17, -0.28, yellow);
    box(steel, 0.36, 0.03, 0.26, 0.3, 0.295, -0.28, dark);
    beam(steel, new THREE.Vector3(0.4, 0.28, -0.22), new THREE.Vector3(0.4, 0.5, -0.22), 0.035, dark);
    // conveyor to a small ore heap
    beam(steel, new THREE.Vector3(-0.15, 0.2, 0.15), new THREE.Vector3(-0.55, 0.05, 0.5), 0.07, grey);
    // tanks
    const tank = new THREE.CylinderGeometry(0.08, 0.08, 0.3, 10).rotateZ(Math.PI / 2).toNonIndexed();
    steel.add(tank, new THREE.Matrix4().makeTranslation(-0.28, 0.14, -0.3), null, new THREE.Color(0.62, 0.64, 0.66));
    // beacons
    light.add(new THREE.SphereGeometry(0.035, 8, 6).toNonIndexed(), new THREE.Matrix4().makeTranslation(0, 0.06 + H + 0.11, 0), null, 1);
    light.add(new THREE.SphereGeometry(0.025, 8, 6).toNonIndexed(), new THREE.Matrix4().makeTranslation(0.4, 0.52, -0.22), null, 1);

    const steelMat = fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.55 }));
    const concMat = fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
    const n = m.oreMines.length;
    const parts: [THREE.BufferGeometry, THREE.Material, boolean][] = [
      [steel.build(), steelMat, shadows],
      [conc.build(), concMat, false],
      [light.build(), this.beacon, false],
    ];
    const stakes = new GeoBuilder();
    box(stakes, 0.025, 0.2, 0.025, 0, 0.1, 0, new THREE.Color(0.75, 0.7, 0.6));
    box(stakes, 0.03, 0.05, 0.03, 0, 0.19, 0, new THREE.Color(0.85, 0.12, 0.08));
    const stakeList: THREE.Matrix4[] = [];
    m.oreMines.forEach((mm, k) => {
      // radius of the deposit
      let r = 2;
      for (let y = mm.y - 6; y <= mm.y + 6; y++)
        for (let x = mm.x - 6; x <= mm.x + 6; x++) if (x >= 0 && y >= 0 && x < m.w && y < m.h && m.oreKind[y * m.w + x]) r = Math.max(r, Math.hypot(x - mm.x, y - mm.y));
      const cnt = Math.round(r * 2.2);
      for (let j = 0; j < cnt; j++) {
        const a = (j / cnt) * Math.PI * 2 + hash2(k, j, 3) * 0.4;
        const sx = mm.x + 0.5 + Math.cos(a) * (r + 1.1);
        const sz = mm.y + 0.5 + Math.sin(a) * (r + 1.1);
        const tx = Math.floor(sx);
        const tz = Math.floor(sz);
        if (tx < 0 || tz < 0 || tx >= m.w || tz >= m.h) continue;
        const t = m.tiles[tz * m.w + tx];
        if (t === Tile.Water || t === Tile.Rock || t === Tile.Bridge || m.trees[tz * m.w + tx]) continue;
        stakeList.push(new THREE.Matrix4().compose(new THREE.Vector3(sx, surfaceHeight(m, sx, sz), sz), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.08, a, 0)), new THREE.Vector3(1, 1, 1)));
      }
    });
    const st = new THREE.InstancedMesh(stakes.build(), concMat, Math.max(1, stakeList.length));
    stakeList.forEach((mm, i) => st.setMatrixAt(i, mm));
    st.count = stakeList.length;
    this.group.add(st);
    for (const [geo, mat, cast] of parts) {
      const im = new THREE.InstancedMesh(geo, mat, n);
      m.oreMines.forEach((mm, k) => {
        const x = mm.x + 0.5;
        const z = mm.y + 0.5;
        im.setMatrixAt(k, new THREE.Matrix4().compose(new THREE.Vector3(x, surfaceHeight(m, x, z) - 0.02, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash2(mm.x, mm.y, 5) * 6.28), new THREE.Vector3(1, 1, 1)));
      });
      im.castShadow = cast;
      im.receiveShadow = true;
      this.group.add(im);
    }
  }

  private zero = new THREE.Matrix4().makeScale(0, 0, 0);
  private tmp = new THREE.Matrix4();
  private sc = new THREE.Matrix4();

  /** Sync rubble with the simulation's ore amounts. */
  update(force = false) {
    const m = this.map;
    let dirty = false;
    for (const s of this.slots) {
      const amt = m.ore[s.tile];
      if (!force && this.cache[s.tile] === amt) continue;
      const visible = amt > s.k * (ORE_MAX / PER) * 0.75;
      if (visible) {
        const f = 0.5 + 0.5 * Math.min(1, amt / ORE_MAX);
        this.tmp.copy(s.base).multiply(this.sc.makeScale(f, f, f));
        s.mesh.setMatrixAt(s.index, this.tmp);
      } else s.mesh.setMatrixAt(s.index, this.zero);
      dirty = true;
    }
    for (const s of this.slots) this.cache[s.tile] = m.ore[s.tile];
    if (dirty) for (const im of this.meshes) im.instanceMatrix.needsUpdate = true;
  }

  animate(time: number) {
    this.beacon.emissiveIntensity = 1.2 + Math.max(0, Math.sin(time * 3.2)) * 2.2;
  }
}
