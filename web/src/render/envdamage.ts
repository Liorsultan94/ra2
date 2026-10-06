import * as THREE from 'three';
import { DEFS, unitDef } from '../sim/defs';
import { standHeight, type GameMap } from '../sim/map';
import type { VisualLike } from './atmos';
import type { Effects } from './effects';
import type { FogOfWar } from './fog';
import type { CulledInstances } from './geo';
import type { Props } from './props';
import type { BattleScars } from './scars';
import type { HouseHandle } from './scenery';
import type { Terrain } from './terrain';

/*
 * Render-side environment destruction (visual only, not deterministic):
 *  - heavy vehicles driving through trees knock them over (they topple with
 *    gravity), any vehicle flattens bushes and fence segments;
 *  - blasts knock trees over / char them (and set some burning), scatter
 *    fences and wreck the village houses in stages (scorched, roof caved in,
 *    collapsed into a rubble heap). Houses stay blocked for pathing in the sim;
 *  - fires leave long-lasting burnt ground patches.
 * Plants and fences live in a static spatial hash (1-tile cells) built once;
 * per frame only moving ground vehicles query it.
 */

const enum Kind {
  Tree = 0,
  Bush = 1,
  Post = 2,
  Rail = 3,
}

interface Faller {
  item: number;
  t: number;
  base: THREE.Matrix4;
  px: number;
  py: number;
  pz: number;
  dx: number;
  dz: number;
  maxA: number;
  rate: number;
}

interface HouseState {
  h: HouseHandle;
  hp: number;
  stage: number; // 0 intact, 1 damaged, 2 collapsing / collapsed
  pos: Float32Array[] | null;
  col: Float32Array[] | null;
  top: number;
  collapseT: number;
  burnT: number;
  lean: number;
  /** Backed by a sim entity (garrisonable house): damage stages follow its hp, blasts only scorch. */
  sim: boolean;
}

const _m = new THREE.Matrix4();
const _r = new THREE.Matrix4();
const _t = new THREE.Matrix4();
const _ax = new THREE.Vector3();
const _f = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

export class EnvDamage {
  readonly group = new THREE.Group();
  private cis: CulledInstances[] = [];
  private ims: THREE.InstancedMesh[] = [];
  // items (structure of arrays)
  private n = 0;
  private kind: Uint8Array;
  private src: Uint16Array;
  private idx: Int32Array;
  private ix: Float32Array;
  private iz: Float32Array;
  private down: Uint8Array;
  // spatial hash (CSR, 1-tile cells)
  private cellStart: Int32Array;
  private cellItems: Int32Array;
  private fallers: Faller[] = [];
  private burning: { x: number; y: number; z: number; t: number; size: number }[] = [];
  private houses: HouseState[];
  private scorch: THREE.InstancedMesh;
  private scorchN = 0;
  private rubble: THREE.InstancedMesh;
  private rubbleN = 0;
  private time = 0;
  private dirtyIms = new Set<THREE.InstancedMesh>();
  /** Photoscanned props (crushed by vehicles, thrown about by blasts). */
  private props: Props;
  /** Persistent battle scars (scars.ts): when set, burnt ground and house ruins go there. */
  scars: BattleScars | null = null;

  constructor(
    terrain: Terrain,
    private map: GameMap,
    fog: FogOfWar,
    private effects: Effects,
    quality: 'low' | 'medium' | 'high',
  ) {
    this.props = terrain.props;
    this.props.attach(effects);
    const veg = terrain.veg;
    const sc = terrain.scenery;
    let total = 0;
    for (const ci of veg.trees) total += ci.size;
    for (const ci of veg.bushes) total += ci.size;
    for (const im of sc.posts) total += im.count;
    for (const im of sc.rails) total += im.count;
    this.kind = new Uint8Array(total);
    this.src = new Uint16Array(total);
    this.idx = new Int32Array(total);
    this.ix = new Float32Array(total);
    this.iz = new Float32Array(total);
    this.down = new Uint8Array(total);
    const add = (k: Kind, s: number, j: number, x: number, z: number) => {
      const i = this.n++;
      this.kind[i] = k;
      this.src[i] = s;
      this.idx[i] = j;
      this.ix[i] = x;
      this.iz[i] = z;
    };
    const addCi = (list: CulledInstances[], k: Kind) => {
      for (const ci of list) {
        const s = this.cis.push(ci) - 1;
        for (let j = 0; j < ci.size; j++) add(k, s, j, ci.posX(j), ci.posZ(j));
      }
    };
    addCi(veg.trees, Kind.Tree);
    addCi(veg.bushes, Kind.Bush);
    const addIm = (list: THREE.InstancedMesh[], k: Kind) => {
      for (const im of list) {
        const s = this.ims.push(im) - 1;
        const a = im.instanceMatrix.array as Float32Array;
        for (let j = 0; j < im.count; j++) add(k, s, j, a[j * 16 + 12], a[j * 16 + 14]);
      }
    };
    addIm(sc.posts, Kind.Post);
    addIm(sc.rails, Kind.Rail);
    // CSR hash
    const W = map.w;
    const H = map.h;
    const cell = (i: number) => Math.max(0, Math.min(H - 1, Math.floor(this.iz[i]))) * W + Math.max(0, Math.min(W - 1, Math.floor(this.ix[i])));
    this.cellStart = new Int32Array(W * H + 1);
    for (let i = 0; i < this.n; i++) this.cellStart[cell(i) + 1]++;
    for (let c = 0; c < W * H; c++) this.cellStart[c + 1] += this.cellStart[c];
    const fill = this.cellStart.slice(0, W * H);
    this.cellItems = new Int32Array(this.n);
    for (let i = 0; i < this.n; i++) this.cellItems[fill[cell(i)]++] = i;

    this.houses = sc.houses.map((h) => ({ h, hp: 1, stage: 0, pos: null, col: null, top: 1, collapseT: -1, burnT: -1, lean: 0, sim: false }));

    // burnt ground patches: dark, ragged-edged blotches
    const sTex = scorchTexture();
    const sMat = fog.apply(new THREE.MeshBasicMaterial({ color: 0x0b0907, alphaMap: sTex, transparent: true, opacity: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }));
    const nS = quality === 'low' ? 60 : 140;
    this.scorch = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), sMat, nS);
    this.scorch.count = 0;
    this.scorch.frustumCulled = false;
    this.scorch.renderOrder = 1;
    this.scorch.name = 'env-scorch';
    this.scorch.visible = false;
    // collapsed house rubble
    const rMat = fog.apply(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: false, roughness: 0.95, flatShading: true }));
    const nR = quality === 'low' ? 160 : 420;
    this.rubble = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.5, 0), rMat, nR);
    this.rubble.count = 0;
    this.rubble.frustumCulled = false;
    this.rubble.castShadow = quality !== 'low';
    this.rubble.receiveShadow = true;
    this.rubble.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nR * 3), 3);
    this.rubble.name = 'env-rubble';
    this.rubble.visible = false;
    this.group.add(this.scorch, this.rubble);
  }

  // ------------------------------------------------------------ plants / fences

  private matrixOf(i: number, out: THREE.Matrix4) {
    const k = this.kind[i];
    if (k === Kind.Tree || k === Kind.Bush) return this.cis[this.src[i]].getMatrix(this.idx[i], out);
    const im = this.ims[this.src[i]];
    return out.fromArray(im.instanceMatrix.array as Float32Array, this.idx[i] * 16);
  }

  private setMatrix(i: number, m: THREE.Matrix4) {
    const k = this.kind[i];
    if (k === Kind.Tree || k === Kind.Bush) this.cis[this.src[i]].setMatrix(this.idx[i], m);
    else {
      const im = this.ims[this.src[i]];
      im.setMatrixAt(this.idx[i], m);
      this.dirtyIms.add(im);
    }
  }

  /** Knock item i over towards (dx, dz) (unit vector). */
  private topple(i: number, dx: number, dz: number, fast = false) {
    if (this.down[i]) return;
    this.down[i] = 1;
    const k = this.kind[i];
    const base = this.matrixOf(i, new THREE.Matrix4());
    const e = base.elements;
    if (k === Kind.Rail) {
      // a rail drops flat onto the ground
      _p.set(e[12], e[13], e[14]);
      const gy = standHeight(this.map, Math.max(0, Math.min(this.map.w - 0.01, _p.x)), Math.max(0, Math.min(this.map.h - 0.01, _p.z)));
      _r.makeRotationAxis(_ax.set(-dz, 0, dx).normalize(), 1.45);
      _m.makeTranslation(dx * 0.08, gy + 0.012 - _p.y, dz * 0.08).multiply(_t.makeTranslation(_p.x, _p.y, _p.z)).multiply(_r).multiply(_t.makeTranslation(-_p.x, -_p.y, -_p.z)).multiply(base);
      this.setMatrix(i, _m);
      return;
    }
    const maxA = k === Kind.Tree ? 1.32 + Math.random() * 0.2 : k === Kind.Bush ? 0.9 + Math.random() * 0.4 : 1.45;
    const rate = k === Kind.Tree ? 2.4 + Math.random() * 1.2 : 9;
    this.fallers.push({ item: i, t: fast ? 0.15 : 0, base, px: e[12], py: e[13], pz: e[14], dx, dz, maxA, rate });
  }

  private char(i: number) {
    const k = this.kind[i];
    if (k !== Kind.Tree && k !== Kind.Bush) return;
    this.cis[this.src[i]].tint(this.idx[i], 0.16, 0.13, 0.11);
  }

  // ------------------------------------------------------------------- update

  update(dt: number, visuals: Iterable<VisualLike>) {
    this.time += dt;
    if (dt <= 0) return;
    // moving ground vehicles push through the scenery
    for (const v of visuals) {
      if (v.speed < 0.15) continue;
      const d = DEFS[v.def];
      if (!d || d.kind !== 'unit') continue;
      const ud = unitDef(v.def);
      if (ud.air || ud.category !== 'vehicle') continue;
      const heavy = ud.armor === 'heavy' || (ud.radius ?? 0) >= 0.45;
      const root = v.model.root;
      const sz = v.model.size;
      const r = Math.max(0.3, (sz ? Math.max(sz.x, sz.z) : 0.8) * 0.5);
      _f.set(1, 0, 0).applyQuaternion(root.quaternion);
      const fl = Math.hypot(_f.x, _f.z) || 1;
      this.props.crush(root.position.x, root.position.z, r, _f.x / fl, _f.z / fl, heavy);
      const nq = this.query(root.position.x, root.position.z, r);
      for (let q = 0; q < nq; q++) {
        const i = this.qi[q];
        const dist = this.qd[q];
        const k = this.kind[i];
        if (k === Kind.Tree && (!heavy || dist > r)) continue;
        // fall ahead of the vehicle, a little to the side it was struck on
        const sx = this.ix[i] - root.position.x;
        const sz2 = this.iz[i] - root.position.z;
        const side = (sx * -_f.z + sz2 * _f.x) / fl;
        let dx = _f.x / fl - (_f.z / fl) * side * 0.6;
        let dz = _f.z / fl + (_f.x / fl) * side * 0.6;
        const l = Math.hypot(dx, dz) || 1;
        dx /= l;
        dz /= l;
        this.topple(i, dx, dz);
        if (k === Kind.Tree && Math.random() < 0.5) this.effects.dust(this.ix[i], root.position.y, this.iz[i], 1.2);
      }
    }
    // toppling trees: accelerate like a falling pole, settle with a small bounce
    for (let f = this.fallers.length - 1; f >= 0; f--) {
      const F = this.fallers[f];
      F.t += dt;
      let a = 0.5 * F.rate * F.t * F.t;
      let done = false;
      if (a >= F.maxA) {
        const tb = F.t - Math.sqrt((2 * F.maxA) / F.rate);
        a = F.maxA - Math.sin(Math.min(Math.PI, tb * 9)) * 0.08 * Math.exp(-tb * 3);
        if (tb > 0.4) {
          a = F.maxA;
          done = true;
          if (this.kind[F.item] === Kind.Tree) this.effects.dust(F.px + F.dx * 0.7, F.py + 0.05, F.pz + F.dz * 0.7, 1.6);
        }
      }
      _r.makeRotationAxis(_ax.set(F.dz, 0, -F.dx), a);
      _m.makeTranslation(F.px, F.py, F.pz).multiply(_r).multiply(_t.makeTranslation(-F.px, -F.py, -F.pz)).multiply(F.base);
      this.setMatrix(F.item, _m);
      if (done) this.fallers.splice(f, 1);
    }
    for (const im of this.dirtyIms) im.instanceMatrix.needsUpdate = true;
    this.dirtyIms.clear();
    // fires on charred trees / wrecked houses
    for (let b = this.burning.length - 1; b >= 0; b--) {
      const B = this.burning[b];
      B.t -= dt;
      if (B.t <= 0) {
        this.burning.splice(b, 1);
        continue;
      }
      if (Math.random() < dt * 5 * B.size) this.effects.flame(B.x + (Math.random() - 0.5) * 0.3 * B.size, B.y, B.z + (Math.random() - 0.5) * 0.3 * B.size, 0.7 * B.size);
      if (Math.random() < dt * 2.5) this.effects.column(B.x, B.y + 0.2, B.z, 0.7 * B.size);
      if (B.t > 2) this.effects.burnGlow(B.x, B.y + 0.3, B.z, 1.2 * B.size);
    }
    for (const H of this.houses) if (H.stage === 2 && H.collapseT >= 0) this.animateCollapse(H, dt);
  }

  private qi = new Int32Array(1024);
  private qd = new Float32Array(1024);

  /** Collect standing items within r of (x, z) into qi / qd; returns the count. */
  private query(x: number, z: number, r: number): number {
    let n = 0;
    const W = this.map.w;
    const x0 = Math.max(0, Math.floor(x - r));
    const x1 = Math.min(W - 1, Math.floor(x + r));
    const z0 = Math.max(0, Math.floor(z - r));
    const z1 = Math.min(this.map.h - 1, Math.floor(z + r));
    for (let cz = z0; cz <= z1; cz++)
      for (let cx = x0; cx <= x1; cx++) {
        const c = cz * W + cx;
        for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
          const i = this.cellItems[k];
          if (this.down[i]) continue;
          const d = Math.hypot(this.ix[i] - x, this.iz[i] - z);
          if (d <= r && n < 1024) {
            this.qi[n] = i;
            this.qd[n++] = d;
          }
        }
      }
    return n;
  }

  // -------------------------------------------------------------------- blasts

  /** A ground blast of profile size `size` at tile (x, y). */
  blast(x: number, y: number, size: number, _time: number) {
    this.props.blast(x, y, size);
    if (size < 0.5) return;
    const knock = 0.25 + size * 0.7;
    const burnR = size >= 0.9 ? knock * 1.35 : 0;
    const reach = Math.max(knock, burnR);
    let burnt = 0;
    const nq = this.query(x, y, reach);
    for (let q = 0; q < nq; q++) {
      const i = this.qi[q];
      const d = this.qd[q];
      const k = this.kind[i];
      let dx = this.ix[i] - x;
      let dz = this.iz[i] - y;
      const l = Math.hypot(dx, dz);
      if (l < 1e-3) {
        dx = Math.random() - 0.5;
        dz = Math.random() - 0.5;
      }
      const ll = Math.hypot(dx, dz) || 1;
      dx /= ll;
      dz /= ll;
      if (d <= knock) {
        if (k === Kind.Post || k === Kind.Rail) {
          // fence segments are thrown about
          const push = (1 - d / knock) * 0.5 * size;
          const m = this.matrixOf(i, _m);
          m.decompose(_p, _q, _s);
          _p.x += dx * push + (Math.random() - 0.5) * 0.15;
          _p.z += dz * push + (Math.random() - 0.5) * 0.15;
          _p.y = standHeight(this.map, Math.max(0, Math.min(this.map.w - 0.01, _p.x)), Math.max(0, Math.min(this.map.h - 0.01, _p.z))) + 0.015;
          _q.setFromEuler(new THREE.Euler(Math.PI / 2 + (Math.random() - 0.5) * 0.3, Math.random() * Math.PI * 2, 0, 'YXZ'));
          m.compose(_p, _q, _s);
          this.down[i] = 1;
          this.setMatrix(i, m);
          continue;
        }
        if (Math.random() < 0.85) this.topple(i, dx, dz, true);
      }
      if (burnR && d <= burnR && (k === Kind.Tree || k === Kind.Bush)) {
        this.char(i);
        if (k === Kind.Tree && burnt < 2 && Math.random() < 0.35) {
          burnt++;
          const gy = standHeight(this.map, Math.max(0, Math.min(this.map.w - 0.01, this.ix[i])), Math.max(0, Math.min(this.map.h - 0.01, this.iz[i])));
          this.burning.push({ x: this.ix[i], y: gy + 0.3, z: this.iz[i], t: 6 + Math.random() * 8, size: 0.8 });
          this.addScorch(this.ix[i], this.iz[i], 0.9 + Math.random() * 0.5);
        }
      }
    }
    for (const d of this.dirtyIms) d.instanceMatrix.needsUpdate = true;
    this.dirtyIms.clear();
    // village houses
    const R = 0.6 + size * 1.0;
    for (const H of this.houses) {
      if (H.stage === 2) continue;
      const st = H.h.st;
      const ddx = Math.max(st.x - x, 0, x - (st.x + st.w));
      const ddz = Math.max(st.y - y, 0, y - (st.y + st.h));
      const d = Math.hypot(ddx, ddz);
      if (d > R) continue;
      const dmg = size * (1 - d / R) * 0.42;
      if (!H.sim) H.hp -= dmg;
      this.damageHouse(H, x, y, size, d / R);
    }
  }

  private ensureHouseData(H: HouseState) {
    if (H.pos) return;
    H.pos = [];
    H.col = [];
    let top = H.h.gy;
    for (const r of H.h.ranges) {
      const pa = r.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const ca = r.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
      const p = (pa.array as Float32Array).slice(r.start * 3, r.end * 3);
      for (let i = 1; i < p.length; i += 3) top = Math.max(top, p[i]);
      H.pos.push(p);
      H.col.push(ca ? (ca.array as Float32Array).slice(r.start * 3, r.end * 3) : new Float32Array(0));
    }
    H.top = top;
  }

  /** Scorch / cave in the part of the house facing the blast; collapse it once it's had enough. */
  private damageHouse(H: HouseState, bx: number, bz: number, size: number, rel: number) {
    this.ensureHouseData(H);
    const gy = H.h.gy;
    const hgt = Math.max(0.3, H.top - gy);
    const hole = 0.35 + size * 0.35;
    for (const r of H.h.ranges) {
      const pa = r.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const ca = r.mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      const P = pa.array as Float32Array;
      const Cc = ca ? (ca.array as Float32Array) : null;
      for (let v = r.start; v < r.end; v++) {
        const x = P[v * 3];
        const y = P[v * 3 + 1];
        const z = P[v * 3 + 2];
        const d = Math.hypot(x - bx, z - bz);
        if (d > hole * 1.6) continue;
        const k = 1 - Math.min(1, d / (hole * 1.6));
        if (Cc) {
          const dark = 1 - k * (0.55 + 0.3 * (1 - rel));
          Cc[v * 3] *= dark;
          Cc[v * 3 + 1] *= dark;
          Cc[v * 3 + 2] *= dark;
        }
        // upper parts near the blast cave in (roof holes)
        const up = (y - gy) / hgt;
        if (up > 0.55 && d < hole) P[v * 3 + 1] -= (0.08 + size * 0.06) * k * up;
      }
      pa.addUpdateRange(r.start * 3, (r.end - r.start) * 3);
      pa.needsUpdate = true;
      if (ca) {
        ca.addUpdateRange(r.start * 3, (r.end - r.start) * 3);
        ca.needsUpdate = true;
      }
    }
    const cx = H.h.cx;
    const cz = H.h.cz;
    if (H.stage === 0) {
      H.stage = 1;
      H.h.stage = H.stage;
      this.burning.push({ x: cx + (bx - cx) * 0.3, y: H.top - 0.15, z: cz + (bz - cz) * 0.3, t: 5 + size * 3, size: 0.7 });
    }
    if (H.hp <= 0 || (size >= 2.2 && !H.sim)) {
      H.stage = 2;
      H.h.stage = H.stage;
      H.collapseT = 0;
      H.lean = (Math.random() - 0.5) * 0.25;
      const st = H.h.st;
      this.burning.push({ x: cx, y: gy + 0.2, z: cz, t: 14 + Math.random() * 8, size: 1.1 });
      this.addScorch(cx, cz, Math.max(st.w, st.h) * 0.8);
      if (this.scars) {
        // a lasting ruin: rubble heap, broken wall stubs, charred beams (scars.ts)
        this.scars.ruin(cx, cz, st.w, st.h, { civil: true, colors: houseColors(H), rise: 1.6 });
        return;
      }
      // a heap of rubble over the footprint
      const n = Math.min(26, 8 + st.w * st.h * 4);
      for (let i = 0; i < n; i++) {
        const rx = st.x + 0.15 + Math.random() * (st.w - 0.3);
        const rz = st.y + 0.15 + Math.random() * (st.h - 0.3);
        const ry = standHeight(this.map, Math.max(0, Math.min(this.map.w - 0.01, rx)), Math.max(0, Math.min(this.map.h - 0.01, rz)));
        const s = 0.12 + Math.random() * 0.2;
        const c = Math.random();
        this.addRubble(rx, ry + s * 0.25, rz, s, c < 0.45 ? 0x8a8070 : c < 0.75 ? 0x5a4a3c : 0x2a2420);
      }
    }
  }

  private animateCollapse(H: HouseState, dt: number) {
    this.ensureHouseData(H);
    H.collapseT += dt;
    const t = Math.min(1, H.collapseT / 1.7);
    const k = t * t;
    const gy = H.h.gy;
    const keep = 1 - k * 0.84;
    const st = H.h.st;
    if (t < 1 && Math.random() < dt * 25) this.effects.dust(st.x + Math.random() * st.w, gy + 0.1, st.y + Math.random() * st.h, 2.4);
    H.h.ranges.forEach((r, ri) => {
      const pa = r.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const ca = r.mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      const P = pa.array as Float32Array;
      const P0 = H.pos![ri];
      const C0 = H.col![ri];
      const Cc = ca ? (ca.array as Float32Array) : null;
      const dark = 1 - k * 0.6;
      for (let v = r.start, j = 0; v < r.end; v++, j += 3) {
        const y0 = P0[j + 1];
        P[v * 3 + 1] = gy + (y0 - gy) * keep;
        P[v * 3] = P0[j] + H.lean * (y0 - gy) * k;
        if (Cc && C0.length) {
          Cc[v * 3] = Math.min(Cc[v * 3], C0[j] * dark);
          Cc[v * 3 + 1] = Math.min(Cc[v * 3 + 1], C0[j + 1] * dark);
          Cc[v * 3 + 2] = Math.min(Cc[v * 3 + 2], C0[j + 2] * dark);
        }
      }
      pa.addUpdateRange(r.start * 3, (r.end - r.start) * 3);
      pa.needsUpdate = true;
      if (ca) {
        ca.addUpdateRange(r.start * 3, (r.end - r.start) * 3);
        ca.needsUpdate = true;
      }
    });
    if (t >= 1) H.collapseT = -1;
  }

  // ---------------------------------------------------------------- decals

  /**
   * Sim-backed village house at footprint (tx, ty) (garrison.ts): mark it, and bring its damage stages in line
   * with the entity's hp fraction (0 = destroyed: it collapses).
   */
  syncSimHouse(tx: number, ty: number, frac: number) {
    const H = this.houses.find((o) => Math.abs(o.h.st.x - tx) < 0.01 && Math.abs(o.h.st.y - ty) < 0.01);
    if (!H) return;
    H.sim = true;
    if (H.stage === 2) return;
    const was = H.hp;
    H.hp = Math.min(H.hp, frac);
    if (frac <= 0) {
      H.hp = 0;
      this.damageHouse(H, H.h.cx, H.h.cz, 1.2, 0);
      return;
    }
    // a fresh scar for every ~15% of hp lost, on a random side
    for (let lost = was - H.hp; lost >= 0.15 || (H.stage === 0 && frac < 0.85); lost -= 0.15) {
      const a = Math.random() * Math.PI * 2;
      const st = H.h.st;
      this.damageHouse(H, H.h.cx + Math.cos(a) * st.w * 0.45, H.h.cz + Math.sin(a) * st.h * 0.45, 1.0, 0.2);
      if (lost < 0.15) break;
    }
  }

  scorchAt(x: number, z: number, r: number) {
    this.addScorch(x, z, r);
  }

  private addScorch(x: number, z: number, r: number) {
    if (this.scars) return this.scars.scorchAt(x, z, r);
    const im = this.scorch;
    const max = im.instanceMatrix.count;
    const i = this.scorchN++ % max;
    const gy = standHeight(this.map, Math.max(0, Math.min(this.map.w - 0.01, x)), Math.max(0, Math.min(this.map.h - 0.01, z)));
    _q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, Math.random() * Math.PI * 2);
    _m.compose(_p.set(x, gy + 0.03, z), _q, _s.set(r * 2, 1, r * 2));
    im.setMatrixAt(i, _m);
    im.count = Math.min(max, this.scorchN);
    im.visible = true;
    im.instanceMatrix.needsUpdate = true;
  }

  private addRubble(x: number, y: number, z: number, s: number, col: number) {
    const im = this.rubble;
    const max = im.instanceMatrix.count;
    const i = this.rubbleN++ % max;
    _q.setFromEuler(new THREE.Euler(Math.random() * 3, Math.random() * 3, Math.random() * 3));
    _m.compose(_p.set(x, y, z), _q, _s.set(s * (0.8 + Math.random() * 0.6), s * (0.4 + Math.random() * 0.4), s * (0.8 + Math.random() * 0.6)));
    im.setMatrixAt(i, _m);
    im.setColorAt(i, _c.setHex(col));
    im.count = Math.min(max, this.rubbleN);
    im.visible = true;
    im.instanceMatrix.needsUpdate = true;
    im.instanceColor!.needsUpdate = true;
  }
}

/** Average wall colour of a village house (its vertex colours), plus a brick tone. */
function houseColors(H: HouseState): number[] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (const c of H.col ?? [])
    for (let i = 0; i < c.length; i += 9) {
      r += c[i];
      g += c[i + 1];
      b += c[i + 2];
      n++;
    }
  if (!n) return [0x8a7a68, 0x7a4c3a];
  return [_c.setRGB(r / n, g / n, b / n).getHex(), 0x7a4c3a, 0x8a8070];
}

function scorchTexture(): THREE.Texture {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const dx = (x + 0.5) / S - 0.5;
      const dy = (y + 0.5) / S - 0.5;
      const a = Math.atan2(dy, dx);
      const r = Math.hypot(dx, dy) * 2;
      const edge = 0.72 + 0.12 * Math.sin(a * 5 + 1.3) + 0.08 * Math.sin(a * 11 + 0.4) + (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453 - Math.floor(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453)) * 0.1;
      const v = Math.max(0, Math.min(1, (edge - r) / 0.3)) * 0.85;
      const o = (y * S + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = Math.round(v * 255);
      img.data[o + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  return t;
}
