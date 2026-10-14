import * as THREE from 'three';
import { Tile, WATER_LEVEL, coastV, seaFrame, seaPointAt, type GameMap, type SeaDeco } from '../sim/map';
import { hash2 } from '../sim/rng';
import type { FogOfWar } from './fog';
import { surfaceHeight } from './ground';
import { landmarkMaterial } from './landmarks/material';
import { CIV_SCALE, CivilianInstances, Opt, Pose } from './models/civilians';
import { Kit, datePalm } from './models/landmarks';
import { ReefLife, buildWreck, type Wreck } from './reeflife';
import { RIVER } from './water';

/*
 * The Red Sea coast of Wadi Al-Rimal (render only; the sim's coast is sim/maps.ts DESERT_SEA, mirrored
 * into the north-west and south-east corners). In each corner:
 *  - a seaside resort on its impassable compound: white hotel blocks stepping down towards the beach,
 *    balconies, roof terraces and awnings, a long curved free-form pool with a bridge across it, the
 *    pool deck with loungers and parasols, a restaurant terrace round a thatched gazebo, palms;
 *  - the bathing beach: rows of thatched parasols with loungers, a curved promenade with a railing,
 *    a lifeguard tower, flags, a beach bar, a jetty out over the reef to a floating pontoon, buoys;
 *  - boats bobbing off the reef (a white yacht, speedboats, a dinghy), one more far out;
 *  - people: sunbathers, swimmers in the shallows and the pool, strollers on the promenade, diners.
 *  - a rusty cargo ship aground on the Blue Hole's rim (reeflife.ts builds it; its dry part merges in here);
 *  - leaning coconut palms along the waterline;
 *  - the life in the clear shallows and the Blue Hole's lagoon (reeflife.ts: corals, fish, starfish, jellyfish).
 * Draw calls: one merged static mesh per corner (the landmarks' shared program: night windows and
 * lamps glow), one instanced mesh each for the parasols, the loungers and the boats, one instanced
 * civilian mesh per corner (the ambient people's program). Nothing new to compile.
 */

/** Corner frame: continuous map point of (u, v) and the coast's heading there. */
interface Frame {
  b: number;
  P(u: number, v: number): THREE.Vector2;
  /** Tile-space heading of +u at (u, v) (a model's local +X; local +Z then points inland). */
  yaw(u: number, v: number): number;
}

const C = (hex: number) => new THREE.Color(hex);
const WHITE = 0xf3f1ec;
const CREAM = 0xeee3cc;
const THATCH = 0xa98454;
const THATCH_DK = 0x7e6038;
const WOOD = 0x8a6440;
const STONE = 0xd9ceb4;
const POOL = 0x23a6dc;
const POOL_LT = 0x6fd4f2;

interface Lounger {
  x: number;
  z: number;
  y: number;
  yaw: number;
}

interface Walker {
  b: number;
  u: number;
  v: number;
  dir: number;
  speed: number;
  ph: number;
  skin: THREE.Color;
  top: THREE.Color;
  bot: THREE.Color;
  hat: THREE.Color;
  mask: number;
  size: number;
}

interface Static {
  m: THREE.Matrix4;
  pose: number;
  mask: number;
  skin: THREE.Color;
  top: THREE.Color;
  bot: THREE.Color;
  hat: THREE.Color;
  phase: number;
  lean: number;
  /** Bobbing swimmer (in the sea): base y. */
  swim?: number;
}

interface Boat {
  x: number;
  z: number;
  yaw: number;
  ph: number;
  kind: number;
}

const SKINS = [0xe8c4a0, 0xd9a77e, 0xc08a62, 0x9a6844, 0xf0d2b8, 0x7a4e30].map(C);
const SWIM = [0x2a62b8, 0xd8342c, 0x1a1a1e, 0xf2c230, 0x2fa07a, 0xe86aa0, 0xf4f4f0, 0x3a9ad8].map(C);

export class Seaside {
  readonly group = new THREE.Group();
  private sea: SeaDeco;
  private people: CivilianInstances[] = [];
  private statics: Static[][] = [[], []];
  private walkers: Walker[] = [];
  private boatList: Boat[] = [];
  private frameNo = 0;
  /** The view's zoom (renderer.ts): zoomed out, the figures are left out (sub-pixel crowds cost triangles). */
  zoom = 2;
  /** Share of the beach life drawn (phone quality draws fewer figures). */
  private crowd: number;
  private _m = new THREE.Matrix4();
  private _q = new THREE.Quaternion();
  private _e = new THREE.Euler();
  private _v = new THREE.Vector3();
  private _s = new THREE.Vector3();
  /** The corals, fish and the wreck's sunken part (reeflife.ts). */
  reef: ReefLife | null = null;

  constructor(
    private map: GameMap,
    private fog: FogOfWar,
    private quality: 'low' | 'medium' | 'high',
    wxLight?: { value: THREE.Vector3 },
  ) {
    this.sea = map.deco!.sea!;
    this.crowd = quality === 'high' ? 1 : 0.55;
    this.group.name = 'seaside';
    this.group.userData.perfCat = 'seaside';
    const parasols: { m: THREE.Matrix4; c: THREE.Color; k: number }[] = [];
    const loungers: { m: THREE.Matrix4; c: THREE.Color }[] = [];
    const wrecks: Wreck[] = [];
    for (const b of [0, 1]) {
      const F = this.frame(b);
      const k = new Kit();
      const beds: Lounger[] = [];
      this.buildResort(k, F, parasols, loungers, beds);
      this.buildBeach(k, F, parasols, loungers, beds);
      // the wreck on the Blue Hole's rim: the whole hull here (the water hides what is under it; reeflife.ts
      // draws the sunken part again through the water)
      const wr = buildWreck(F.P);
      wrecks.push(wr);
      k.pos.push(...wr.kit.pos);
      k.nor.push(...wr.kit.nor);
      k.col.push(...wr.kit.col);
      k.glow.push(...wr.kit.glow);
      const geo = k.build();
      const mesh = new THREE.Mesh(geo, landmarkMaterial(fog));
      mesh.name = 'seaside-static';
      mesh.castShadow = quality === 'high';
      mesh.receiveShadow = quality !== 'low';
      this.group.add(mesh);
      if (quality !== 'low') this.populate(F, beds);
    }
    this.group.add(...this.instanced(parasolGeometry(), parasols, 'seaside-parasols'));
    this.group.add(...this.instanced(loungerGeometry(), loungers, 'seaside-loungers'));
    this.buildBoats();
    if (wxLight) {
      this.reef = new ReefLife(map, fog, quality, wxLight, [this.frame(0).P, this.frame(1).P], wrecks);
      this.group.add(this.reef.group);
    }
    if (quality !== 'low') {
      for (const b of [0, 1]) {
        const n = this.statics[b].length + this.walkers.filter((w) => w.b === b).length;
        const ci = new CivilianInstances(fog, Math.max(1, n));
        ci.mesh.name = 'seaside-people';
        this.people.push(ci);
        this.group.add(ci.mesh);
      }
      this.drawPeople(0);
      for (const ci of this.people) {
        ci.mesh.computeBoundingSphere();
        if (ci.mesh.boundingSphere) ci.mesh.boundingSphere.radius += 2;
        ci.mesh.frustumCulled = true;
      }
    }
  }

  // ------------------------------------------------------------------ frame

  private frame(b: number): Frame {
    const { w, h } = this.map;
    const off = this.sea.off;
    const P = (u: number, v: number) => {
      const p = seaPointAt(w, h, off, u, v, b);
      return new THREE.Vector2(p.x, p.y);
    };
    return {
      b,
      P,
      yaw: (u, v) => {
        const a = P(u - 0.25, v);
        const c = P(u + 0.25, v);
        return Math.atan2(c.y - a.y, c.x - a.x);
      },
    };
  }

  private gh(x: number, z: number) {
    return surfaceHeight(this.map, Math.max(0, Math.min(this.map.w, x)), Math.max(0, Math.min(this.map.h, z)));
  }

  private inMap(x: number, z: number, margin = 0.3) {
    return x > margin && z > margin && x < this.map.w - margin && z < this.map.h - margin;
  }

  private tileAt(x: number, z: number) {
    const tx = Math.floor(x);
    const ty = Math.floor(z);
    if (tx < 0 || ty < 0 || tx >= this.map.w || ty >= this.map.h) return -1;
    return this.map.tiles[ty * this.map.w + tx];
  }

  /** Place the kit at frame point (u, v), height y (absolute), heading along the coast (+ extra yaw). */
  private at(k: Kit, F: Frame, u: number, v: number, y: number, dyaw = 0, s = 1) {
    const p = F.P(u, v);
    return k.at(p.x, y, p.y, F.yaw(u, v) + dyaw, s);
  }

  /** A strip of quads following the frame: from (u0, v) to (u1, v) at offsets va..vb, height fn. */
  private strip(k: Kit, F: Frame, u0: number, u1: number, va: (u: number) => number, vb: (u: number) => number, y: (x: number, z: number, u: number) => number, col: (u: number, i: number) => number, step = 0.3, glow = 0) {
    const pos: number[] = [];
    const cols: number[] = [];
    const n = Math.max(1, Math.ceil((u1 - u0) / step));
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const ua = u0 + ((u1 - u0) * i) / n;
      const ub = u0 + ((u1 - u0) * (i + 1)) / n;
      const A = F.P(ua, va(ua));
      const B = F.P(ub, va(ub));
      const Cc = F.P(ub, vb(ub));
      const D = F.P(ua, vb(ua));
      const q = [A, B, Cc, D].map((p, j) => [p.x, y(p.x, p.y, j === 0 || j === 3 ? ua : ub), p.y]);
      // up-facing whichever way the frame turns
      const cross = (q[1][0] - q[0][0]) * (q[3][2] - q[0][2]) - (q[1][2] - q[0][2]) * (q[3][0] - q[0][0]);
      const tri = cross > 0 ? [0, 3, 2, 0, 2, 1] : [0, 1, 2, 0, 2, 3];
      c.setHex(col((ua + ub) / 2, i));
      for (const t of tri) {
        pos.push(...q[t]);
        cols.push(c.r, c.g, c.b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    // vertex colours per quad: Kit takes one colour per add, so add quad by quad colour runs
    const per = 6;
    for (let i = 0; i < pos.length / 3; i += per) {
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.Float32BufferAttribute(pos.slice(i * 3, (i + per) * 3), 3));
      gg.setAttribute('normal', new THREE.Float32BufferAttribute(Array.from({ length: per }, () => [0, 1, 0]).flat(), 3));
      k.base.identity();
      k.add(gg, null, new THREE.Color(cols[i * 3], cols[i * 3 + 1], cols[i * 3 + 2]), glow);
    }
    g.dispose();
  }

  // ------------------------------------------------------------------ the resort

  private buildResort(k: Kit, F: Frame, parasols: { m: THREE.Matrix4; c: THREE.Color; k: number }[], loungers: { m: THREE.Matrix4; c: THREE.Color }[], beds: Lounger[]) {
    const r = this.sea.resort;
    const b = F.b;
    const h = (i: number, j: number) => hash2(i, j + b * 97, 4401);
    // the terrace: the compound's ground is flat (sim), the deck sits a hair above its highest point
    let top = -9;
    for (let u = r.u0; u <= r.u1; u += 0.5)
      for (let v = r.v0; v <= r.v1; v += 0.5) {
        const p = F.P(u, v);
        top = Math.max(top, this.gh(p.x, p.y));
      }
    const deckY = top + 0.035;
    // pool deck: pale stone paving, a slightly darker band every few slabs
    this.strip(k, F, r.u0 - 0.15, r.u1 + 0.15, () => r.v0 - 0.15, () => r.v1 + 0.15, () => deckY, (_u, i) => (i % 7 === 3 ? 0xcfc3a8 : STONE), 0.5);
    // the deck's edge: a low white kerb
    for (const v of [r.v0 - 0.15, r.v1 + 0.15]) this.strip(k, F, r.u0 - 0.15, r.u1 + 0.15, () => v - 0.04, () => v + 0.04, () => deckY + 0.04, () => WHITE, 0.6);
    // the pool: a long curved free-form basin along the coast, a round end by the restaurant
    const pu0 = r.u0 + 3.6;
    const pu1 = r.u1 - 0.9;
    const vC = (u: number) => -7.15 + 0.55 * Math.sin((u - pu0) * 0.62 + b * 1.4);
    const hw = (u: number) => (0.85 + 0.3 * Math.sin(u * 0.85 + b * 2.1)) * Math.min(1, 0.45 + (u - pu0) * 0.6, 0.45 + (pu1 - u) * 0.6);
    const poolY = deckY + 0.006;
    this.strip(k, F, pu0, pu1, (u) => vC(u) - hw(u), (u) => vC(u) + hw(u), () => poolY, (_u, i) => (i % 2 ? POOL : 0x2bb0e2), 0.25, 0);
    // lighter shallow margins and the white coping round it
    for (const s of [-1, 1]) {
      this.strip(k, F, pu0, pu1, (u) => vC(u) + s * (hw(u) - 0.16), (u) => vC(u) + s * hw(u), () => poolY + 0.003, () => POOL_LT, 0.25);
      this.strip(k, F, pu0, pu1, (u) => vC(u) + s * hw(u), (u) => vC(u) + s * (hw(u) + 0.09), () => deckY + 0.016, () => WHITE, 0.25);
    }
    // pool lights along the coping (a soft glow at night)
    for (let u = pu0 + 0.6; u < pu1 - 0.3; u += 1.7)
      for (const s of [-1, 1]) {
        this.at(k, F, u, vC(u) + s * (hw(u) + 0.05), deckY + 0.02);
        k.ball(0.025, 0, 0, 0, 0xbfe8ff, 0, 1);
      }
    // the bridge across the pool
    const ub = (pu0 + pu1) / 2 + (b ? 1.5 : -1.2);
    const span = hw(ub) * 2 + 0.4;
    this.at(k, F, ub, vC(ub), deckY);
    for (let i = 0; i < 6; i++) {
      const z0 = -span / 2 + (span * i) / 6;
      const z1 = -span / 2 + (span * (i + 1)) / 6;
      const arc = (z: number) => 0.05 + 0.1 * (1 - Math.pow((2 * z) / span, 2));
      const zm = (z0 + z1) / 2;
      k.box(0.46, 0.035, z1 - z0 + 0.01, 0, arc(zm), zm, CREAM, 0, 0, Math.atan2(arc(z1) - arc(z0), z1 - z0));
      for (const sx of [-0.21, 0.21]) k.box(0.025, 0.1, z1 - z0 + 0.01, sx, arc(zm) + 0.07, zm, WHITE, 0, 0, Math.atan2(arc(z1) - arc(z0), z1 - z0));
    }
    // the restaurant terrace at the round end: a raised round platform with a red-tiled rim, a thatched gazebo, tables
    const rU = r.u0 + 1.85;
    const rV = -8.1;
    this.at(k, F, rU, rV, deckY);
    k.cyl(1.32, 1.32, 0.06, 0, 0, 0, 0xd8cbb0, 28);
    k.cyl(1.4, 1.36, 0.09, 0, -0.02, 0, 0xa8503a, 28, 0, true);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.2;
      k.beam(Math.cos(a) * 0.42, 0.06, Math.sin(a) * 0.42, Math.cos(a) * 0.42, 0.46, Math.sin(a) * 0.42, 0.03, WOOD);
    }
    k.cone(0.6, 0.4, 0, 0.45, 0, THATCH, 16);
    k.cyl(0.62, 0.58, 0.05, 0, 0.42, 0, THATCH_DK, 16, 0, true);
    k.ball(0.04, 0, 0.84, 0, THATCH_DK, 0);
    // a warm lamp under the roof
    k.ball(0.04, 0, 0.36, 0, 0xffd590, 0, 1);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + 0.5;
      const rr = i % 3 === 0 ? 0.32 : 0.98;
      const tx = Math.cos(a) * rr;
      const tz = Math.sin(a) * rr;
      k.cyl(0.01, 0.01, 0.14, tx, 0.06, tz, 0x6a6a6a, 5);
      k.cyl(0.085, 0.085, 0.015, tx, 0.2, tz, WHITE, 10);
      for (let c = 0; c < 2; c++) {
        const ca = a + (c ? 1 : -1) * 1.35;
        k.box(0.06, 0.07, 0.06, tx + Math.cos(ca) * 0.13, 0.095, tz + Math.sin(ca) * 0.13, (i + c) % 3 === 0 ? 0xf0c030 : 0x2a5fb0);
      }
    }
    // hotel blocks along the back, stepping down towards the sea; no two alike
    const blocks = b ? [[r.u0 + 0.2, 3.0], [r.u0 + 3.6, 2.6], [r.u0 + 6.6, 2.4], [r.u0 + 9.4, 2.6]] : [[r.u0 + 0.3, 2.6], [r.u0 + 3.3, 3.2], [r.u0 + 7.0, 2.2], [r.u0 + 9.6, 2.4]];
    blocks.forEach(([u0, len], i) => this.hotelBlock(k, F, u0 + len / 2, r.v0 + 1.45, len, deckY, i));
    // loungers and parasols on the deck (both sides of the pool)
    for (let u = pu0 + 0.3; u < pu1 - 0.2; u += 0.62) {
      if (Math.abs(u - ub) < 0.6) continue;
      for (const s of [-1, 1]) {
        if (s < 0 && (h(Math.round(u * 10), 3) < 0.35)) continue;
        const v = vC(u) + s * (hw(u) + 0.42);
        if (v < r.v0 + 2.9 || v > r.v1 - 0.18) continue;
        const p = F.P(u, v);
        const yaw = F.yaw(u, v) + (s > 0 ? Math.PI / 2 : -Math.PI / 2);
        const m = new THREE.Matrix4().compose(new THREE.Vector3(p.x, deckY, p.y), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw), new THREE.Vector3(1, 1, 1));
        loungers.push({ m, c: C(h(Math.round(u * 10), 5) < 0.5 ? 0x2f6fc0 : WHITE) });
        beds.push({ x: p.x, z: p.y, y: deckY, yaw });
        if (Math.round(u / 0.62) % 2 === 0) {
          const q = F.P(u + 0.3, v + s * 0.05);
          parasols.push({ m: new THREE.Matrix4().makeTranslation(q.x, deckY, q.y), c: C(h(Math.round(u * 10), 7) < 0.5 ? 0xf2f0ea : 0xe8dcc2), k: 1 });
        }
      }
    }
    // palms round the deck and in planters by the pool
    for (let u = r.u0 + 0.6; u < r.u1; u += 2.3) {
      for (const v of [r.v1 - 0.25, vC(u) - hw(u) - 0.55]) {
        if (Math.abs(u - rU) < 1.6 && v < -6) continue;
        if (v < r.v0 + 2.95) continue;
        this.at(k, F, u + (h(Math.round(u * 10), Math.round(v)) - 0.5) * 0.4, v, deckY, h(Math.round(u), 9) * 6);
        k.cyl(0.11, 0.1, 0.06, 0, 0, 0, 0xc8b898, 8);
        datePalm(k, h(Math.round(u * 10), 11), 0.62 + h(Math.round(u * 10), 12) * 0.2);
      }
    }
    // lamp posts along the deck (gentle glow at night)
    for (let u = r.u0 + 1.2; u < r.u1; u += 2.6) {
      this.at(k, F, u, r.v1 - 0.08, deckY);
      k.cyl(0.012, 0.012, 0.32, 0, 0, 0, 0x404244, 5);
      k.ball(0.035, 0, 0.34, 0, 0xffe2a8, 0, 1);
    }
  }

  /**
   * A hotel block: white storeys stepping down to the sea (local -z), balconies with glass railings and
   * shades on the sea front, shuttered windows behind, roof terraces with pergolas, a dome or a round
   * stair tower on some; every block drawn from its own numbers (heights, tiers, colours, roof).
   */
  private hotelBlock(k: Kit, F: Frame, u: number, v: number, len: number, deckY: number, i: number) {
    const b = F.b;
    const h = (j: number) => hash2(i * 13 + j, b * 7 + 3, 4411);
    const S = 0.25; // storey height
    const tall = 3 + Math.floor(h(1) * 1.99);
    const tiers = [tall, Math.max(2, tall - 1 - Math.floor(h(2) * 1.5)), Math.max(1, tall - 2 - Math.floor(h(3) * 1.5))];
    const depths = [0.78 + h(6) * 0.15, 0.62, 0.55];
    const walls = [WHITE, CREAM, 0xf6efe2, 0xeadfc8][Math.floor(h(4) * 4)];
    const accent = [0xb5603a, 0x3a6fa8, 0x2f8f8a, 0xc89a3a, 0x8a4a6a][Math.floor(h(5) * 5)];
    const glassC = 0x4e6c7c;
    const frame = 0xfaf8f2;
    this.at(k, F, u, v, deckY);
    let z = 1.0;
    for (let t = 0; t < 3; t++) {
      const n = tiers[t];
      const d = depths[t];
      const hgt = n * S;
      const zc = z - d / 2;
      const xo = t === 0 ? 0 : (h(10 + t) - 0.5) * 0.3;
      const lenT = len - t * (0.15 + h(20 + t) * 0.3);
      k.box(lenT, hgt, d, xo, hgt / 2, zc, walls);
      // a slim cornice and the parapet
      k.box(lenT + 0.03, 0.025, d + 0.03, xo, hgt - 0.01, zc, frame);
      k.box(lenT + 0.02, 0.05, 0.035, xo, hgt + 0.025, zc - d / 2 + 0.018, walls);
      k.box(lenT + 0.02, 0.05, 0.035, xo, hgt + 0.025, zc + d / 2 - 0.018, walls);
      const bays = Math.max(2, Math.round(lenT / 0.36));
      const bx = (a: number) => xo - lenT / 2 + (lenT * (a + 0.5)) / bays;
      for (let f = 0; f < n; f++) {
        const y = f * S;
        if (f === 0 && t === 2) {
          // the ground floor on the deck: an arcade of round arches
          for (let a = 0; a < bays; a++) {
            const x = bx(a);
            k.box(0.2, 0.13, 0.02, x, 0.065, zc - d / 2 - 0.004, 0x3a3630);
            k.add(new THREE.CylinderGeometry(0.1, 0.1, 0.02, 10, 1, false, 0, Math.PI).rotateX(Math.PI / 2).rotateZ(Math.PI / 2), new THREE.Matrix4().makeTranslation(x, 0.13, zc - d / 2 - 0.004), 0x3a3630);
          }
        } else if (f > 0 || t < 2) {
          // the sea front: balconies (slab, glass railing), a shade over some
          if (f > 0) {
            k.box(lenT - 0.04, 0.022, 0.11, xo, y, zc - d / 2 - 0.055, frame);
            k.box(lenT - 0.04, 0.065, 0.008, xo, y + 0.044, zc - d / 2 - 0.108, 0xa8d0d8);
          }
          for (let a = 0; a < bays; a++) {
            const x = bx(a);
            k.box(0.2, 0.15, 0.01, x, y + 0.1, zc - d / 2 - 0.002, glassC, 2);
            if (f > 0 && h(30 + a + f * 7 + t * 31) < 0.22) k.box(0.22, 0.01, 0.12, x, y + 0.21, zc - d / 2 - 0.06, accent, 0, 0, -0.35);
          }
          if (f > 0) for (let a = 0; a <= bays; a++) k.box(0.014, S * 0.85, 0.11, xo - lenT / 2 + (lenT * a) / bays + (a === 0 ? 0.01 : a === bays ? -0.01 : 0), y + S * 0.42, zc - d / 2 - 0.055, walls);
        }
        // the back (inland: only the top tier's) and the ends: small windows with shutters
        if (t === 0) {
          for (let a = 0; a < bays; a++) {
            const x = bx(a);
            k.box(0.12, 0.13, 0.01, x, y + 0.11, zc + d / 2 + 0.004, glassC, 2);
            k.box(0.15, 0.015, 0.02, x, y + 0.04, zc + d / 2 + 0.008, frame);
            if (h(60 + a + f * 5) < 0.55) for (const sx of [-0.085, 0.085]) k.box(0.05, 0.13, 0.012, x + sx, y + 0.11, zc + d / 2 + 0.008, accent);
          }
        }
        for (const sx of [-1, 1]) {
          const cols = Math.max(1, Math.round(d / 0.36));
          for (let a = 0; a < cols; a++) k.box(0.01, 0.13, 0.12, xo + sx * (lenT / 2 + 0.003), y + 0.11, zc - d / 2 + (d * (a + 0.5)) / cols, glassC, 2);
        }
      }
      // roofs: terraces with pergolas or loungers on the lower tiers; the top: a dome, a round tower or plant
      if (t > 0) {
        if (h(40 + t) < 0.55) {
          for (let p = 0; p < 4; p++) k.box(0.018, 0.17, 0.018, xo - lenT / 2 + 0.2 + p * ((lenT - 0.4) / 3), hgt + 0.085, zc, WOOD);
          for (let sl = 0; sl < 7; sl++) k.box(0.025, 0.015, 0.34, xo - lenT / 2 + 0.2 + (sl * (lenT - 0.4)) / 6, hgt + 0.18, zc, WOOD);
        } else {
          for (let p = 0; p < 3; p++) k.box(0.1, 0.025, 0.2, xo - lenT / 3 + p * (lenT / 3), hgt + 0.03, zc, p % 2 ? 0x2f6fc0 : WHITE);
        }
      } else {
        const kind = (i + b * 2 + Math.floor(h(44) * 1.6)) % 3;
        if (kind === 0) {
          k.cyl(0.22, 0.22, 0.08, xo + lenT * 0.22, hgt, zc + 0.05, walls, 16);
          k.dome(0.22, xo + lenT * 0.22, hgt + 0.08, zc + 0.05, h(45) < 0.5 ? walls : 0x4c86b8, 14);
        } else if (kind === 1) {
          // a round stair tower at one end, taller than the block, with a little cupola
          const ex = xo + (h(46) < 0.5 ? -1 : 1) * (lenT / 2 - 0.05);
          k.cyl(0.24, 0.24, hgt + S, ex, 0, zc, walls, 18);
          for (let f = 1; f <= n; f++) k.box(0.1, 0.12, 0.01, ex, f * S - 0.12, zc - 0.245, glassC, 2);
          k.cyl(0.26, 0.26, 0.03, ex, hgt + S, zc, frame, 18);
          k.dome(0.16, ex, hgt + S + 0.03, zc, accent, 12);
        } else {
          k.box(0.42, 0.18, 0.34, xo - lenT * 0.25, hgt + 0.09, zc + 0.12, walls);
          k.cyl(0.06, 0.06, 0.13, xo + lenT * 0.28, hgt, zc + 0.18, 0xd8d8d4, 8);
          k.cyl(0.06, 0.06, 0.13, xo + lenT * 0.18, hgt, zc + 0.18, 0xd8d8d4, 8);
        }
        // a coloured band under the roof line (no names, no logos)
        k.box(lenT * 0.45, 0.04, 0.01, xo, hgt - 0.055, zc - d / 2 - 0.007, accent);
      }
      z -= d;
    }
  }

  // ------------------------------------------------------------------ the beach

  private buildBeach(k: Kit, F: Frame, parasols: { m: THREE.Matrix4; c: THREE.Color; k: number }[], loungers: { m: THREE.Matrix4; c: THREE.Color }[], beds: Lounger[]) {
    const sea = this.sea;
    const b = F.b;
    const [bu0, bu1] = sea.beach;
    const h = (i: number, j: number) => hash2(i, j + b * 131, 4421);
    const jU = -4.6 + b * 1.2;
    const towerU = -11.2 + b * 2.5;
    const barU = 0.6;
    const r = sea.resort;
    // the promenade: a paved path with a wooden railing between the beach and the resort / dunes
    const pv = (u: number) => -4.55 + 0.15 * Math.sin(u * 0.35 + b);
    const ok = (u: number, v: number) => {
      const p = F.P(u, v);
      return this.inMap(p.x, p.y, 0.05) && this.tileAt(p.x, p.y) !== Tile.Water && this.tileAt(p.x, p.y) !== Tile.Rock;
    };
    const runs: [number, number][] = [];
    let s0 = NaN;
    for (let u = bu0; u <= bu1 + 0.001; u += 0.3) {
      const good = ok(u, pv(u)) && ok(u, pv(u) + 0.3);
      if (good && Number.isNaN(s0)) s0 = u;
      if ((!good || u + 0.3 > bu1) && !Number.isNaN(s0)) {
        if (u - s0 > 1) runs.push([s0, u]);
        s0 = NaN;
      }
    }
    for (const [a, c] of runs) {
      this.strip(k, F, a, c, (u) => pv(u) - 0.24, (u) => pv(u) + 0.24, (x, z) => this.gh(x, z) + 0.03, (_u, i) => (i % 2 ? 0xd6c9aa : 0xcbbd9c), 0.3);
      for (let u = a + 0.1; u < c; u += 0.45) {
        const p = F.P(u, pv(u) + 0.24);
        const y = this.gh(p.x, p.y) + 0.03;
        k.at(p.x, y, p.y, F.yaw(u, pv(u)));
        k.box(0.025, 0.16, 0.025, 0, 0.08, 0, WOOD);
        // the top rail to the next post
        const q = F.P(u + 0.45, pv(u + 0.45) + 0.24);
        if (u + 0.45 < c) {
          const yq = this.gh(q.x, q.y) + 0.03;
          k.at(0, 0, 0);
          k.beam(p.x, y + 0.16, p.y, q.x, yq + 0.16, q.y, 0.02, WOOD);
          k.beam(p.x, y + 0.09, p.y, q.x, yq + 0.09, q.y, 0.012, WOOD);
        }
      }
      // lamps along the promenade
      for (let u = a + 0.8; u < c; u += 3.1) {
        const p = F.P(u, pv(u) - 0.26);
        k.at(p.x, this.gh(p.x, p.y), p.y);
        k.cyl(0.012, 0.012, 0.36, 0, 0, 0, 0x34363a, 5);
        k.ball(0.032, 0, 0.38, 0, 0xffe2a8, 0, 1);
      }
    }
    // the parasols: rows of thatched shades on the sand, two loungers under each
    const rows = [-3.55, -2.7, -1.85];
    rows.forEach((v0, ri) => {
      for (let u = bu0 + 0.4 + ri * 0.33; u < bu1; u += 0.98) {
        const j = h(Math.round(u * 10), ri);
        if (j < 0.12) continue;
        const v = v0 + (h(Math.round(u * 10), ri + 5) - 0.5) * 0.18;
        if (Math.abs(u - jU) < 0.9 || Math.abs(u - towerU) < 0.8 || Math.abs(u - barU) < 1.1) continue;
        const p = F.P(u, v);
        if (!this.inMap(p.x, p.y, 0.4) || this.tileAt(p.x, p.y) !== Tile.Sand) continue;
        const f = seaFrame(this.map.w, this.map.h, sea.off, p.x, p.y);
        if (coastV(sea, f.u, f.v) > -0.55) continue;
        const y = this.gh(p.x, p.y);
        parasols.push({ m: new THREE.Matrix4().makeTranslation(p.x, y, p.y).multiply(new THREE.Matrix4().makeRotationY(j * 6)), c: C(0xffffff).multiplyScalar(0.85 + j * 0.25), k: 0 });
        const yaw = F.yaw(u, v) + Math.PI / 2 + (j - 0.5) * 0.3;
        for (const s of [-1, 1]) {
          const q = F.P(u + s * 0.16, v + 0.12);
          const m = new THREE.Matrix4().compose(new THREE.Vector3(q.x, this.gh(q.x, q.y), q.y), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw), new THREE.Vector3(1, 1, 1));
          loungers.push({ m, c: C(h(Math.round(u * 10), 9) < 0.55 ? WHITE : 0x3a78c8) });
          beds.push({ x: q.x, z: q.y, y: this.gh(q.x, q.y), yaw });
        }
      }
    });
    // the lifeguard tower: a tall wooden chair with a shade roof and a red flag
    {
      const v = -1.3;
      const p = F.P(towerU, v);
      if (this.inMap(p.x, p.y, 0.5)) {
        this.at(k, F, towerU, v, this.gh(p.x, p.y), Math.PI);
        for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) k.beam(sx * 0.17, 0, sz * 0.17, sx * 0.12, 0.55, sz * 0.12, 0.03, 0xdcd6c8);
        k.box(0.34, 0.03, 0.34, 0, 0.56, 0, WOOD);
        k.box(0.3, 0.12, 0.02, 0, 0.62, 0.15, 0xc83a2a);
        k.box(0.36, 0.02, 0.36, 0, 0.86, 0, 0xc83a2a);
        for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) k.box(0.015, 0.28, 0.015, sx * 0.16, 0.72, sz * 0.16, 0xdcd6c8);
        for (let s = 0; s < 6; s++) k.box(0.2, 0.012, 0.03, 0, 0.08 + s * 0.09, 0.26 - s * 0.017, WOOD, 0, 0.5);
        k.cyl(0.008, 0.008, 0.5, 0.2, 0.86, -0.2, 0x8a8a8a, 4);
        k.box(0.16, 0.1, 0.006, 0.28, 1.28, -0.2, 0xd8302a);
      }
    }
    // flags on the beach (bathing flags: yellow and red)
    for (const [fu, col] of [[-20.5, 0xf2c52a], [-15.3, 0xd8302a], [-6.2, 0xf2c52a], [-1.6, 0xd8302a]] as const) {
      const p = F.P(fu, -0.9);
      if (!this.inMap(p.x, p.y, 0.5) || this.tileAt(p.x, p.y) !== Tile.Sand) continue;
      this.at(k, F, fu, -0.9, this.gh(p.x, p.y), 0.4);
      k.cyl(0.008, 0.008, 0.62, 0, 0, 0, 0x9a9a9a, 4);
      k.box(0.17, 0.1, 0.006, 0.09, 0.56, 0, col);
    }
    // the beach bar: a round thatched hut with a counter
    {
      const p = F.P(barU, -3.3);
      if (this.inMap(p.x, p.y, 0.6) && this.tileAt(p.x, p.y) !== Tile.Water) {
        this.at(k, F, barU, -3.3, this.gh(p.x, p.y));
        k.cyl(0.5, 0.5, 0.04, 0, 0, 0, 0xc9b48a, 16);
        k.cyl(0.36, 0.36, 0.2, 0, 0.02, 0, WOOD, 16, 0, true);
        k.cyl(0.38, 0.38, 0.025, 0, 0.22, 0, 0xd8c8a0, 16);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          k.beam(Math.cos(a) * 0.4, 0.02, Math.sin(a) * 0.4, Math.cos(a) * 0.4, 0.5, Math.sin(a) * 0.4, 0.03, WOOD);
          k.cyl(0.03, 0.03, 0.13, Math.cos(a + 0.5) * 0.48, 0.02, Math.sin(a + 0.5) * 0.48, 0x5a4030, 6);
        }
        k.cone(0.66, 0.36, 0, 0.48, 0, THATCH, 14);
        k.ball(0.04, 0, 0.42, 0, 0xffd590, 0, 1);
      }
    }
    // the jetty: out from the beach over the reef flat to a floating pontoon at the drop-off
    {
      const v0 = -0.9;
      const v1 = 4.5;
      const deck = WATER_LEVEL + 0.17;
      const p0 = F.P(jU, v0);
      if (this.inMap(p0.x, p0.y, 0.5)) {
        for (let v = v0; v < v1; v += 0.4) {
          const v2 = Math.min(v1, v + 0.4);
          const a = F.P(jU, v);
          const c = F.P(jU, v2);
          const ya = Math.max(deck, this.gh(a.x, a.y) + 0.06);
          const yc = Math.max(deck, this.gh(c.x, c.y) + 0.06);
          const yaw = Math.atan2(c.y - a.y, c.x - a.x);
          k.at((a.x + c.x) / 2, (ya + yc) / 2, (a.y + c.y) / 2, yaw);
          k.box(Math.hypot(c.x - a.x, c.y - a.y) + 0.01, 0.035, 0.42, 0, 0, 0, Math.round(v * 2.5) % 2 ? 0xc8c2b4 : 0xd6d0c2);
          // piles and the railings
          for (const s of [-0.19, 0.19]) {
            k.box(0.04, 0.5, 0.04, 0, -0.25, s, 0x8a8478);
            k.box(0.44, 0.02, 0.02, 0, 0.17, s, WHITE);
            k.box(0.02, 0.17, 0.02, -0.2, 0.085, s, WHITE);
          }
        }
        // the pontoon (white floats with blue edges), a ladder, kayaks and a pedalo moored to it
        const pp = F.P(jU, v1 + 0.45);
        this.at(k, F, jU, v1 + 0.45, WATER_LEVEL + 0.05);
        k.box(1.7, 0.06, 0.62, 0, 0, 0, WHITE);
        k.box(1.72, 0.03, 0.64, 0, -0.035, 0, 0x2a6fc0);
        k.box(0.05, 0.06, 0.04, 0.85, 0.02, 0, 0x2a6fc0);
        for (const sx of [-0.06, 0.06]) k.box(0.015, 0.3, 0.015, 0.3 + sx, 0.08, 0.32, 0xb8b8b8);
        for (let i = 0; i < 3; i++) k.box(0.42, 0.04, 0.09, -0.55 + i * 0.28, -0.02, 0.4, [0xf2c230, 0xf2c230, 0xe85030][i], 0.15);
        k.box(0.36, 0.08, 0.22, 0.62, -0.01, -0.44, 0xf2f2f0);
        k.box(0.1, 0.12, 0.1, 0.62, 0.09, -0.44, 0x2a6fc0);
        void pp;
      }
    }
    // a line of buoys round the swimming area
    for (let u = bu0 + 1.5; u < jU - 1.2; u += 0.75) {
      const p = F.P(u, 3.1);
      if (!this.inMap(p.x, p.y, 0.2)) continue;
      k.at(p.x, WATER_LEVEL, p.y);
      k.ball(0.04, 0, 0.015, 0, Math.round(u / 0.75) % 2 ? 0xf2f2ee : 0xf2c230, 0);
    }
    // coconut palms leaning out over the waterline, in twos and threes
    const keep = [jU, towerU, barU, -20.5, -15.3, -6.2, -1.6];
    for (let u = bu0 + 0.8; u < bu1 - 0.3; u += 1.35) {
      const j = h(Math.round(u * 10), 41);
      if (j < 0.4) continue;
      const uu = u + (h(Math.round(u * 10), 42) - 0.5) * 0.5;
      if (keep.some((x) => Math.abs(uu - x) < 0.85)) continue;
      const v = -1.05 - h(Math.round(u * 10), 43) * 0.45;
      const p = F.P(uu, v);
      if (!this.inMap(p.x, p.y, 0.5) || this.tileAt(p.x, p.y) !== Tile.Sand) continue;
      const y = this.gh(p.x, p.y);
      if (y < WATER_LEVEL + 0.02) continue;
      this.at(k, F, uu, v, y, (h(Math.round(u * 10), 44) - 0.5) * 0.9);
      coconutPalm(k, h(Math.round(u * 10), 45), 0.85 + h(Math.round(u * 10), 46) * 0.25);
    }
    void r;
    void parasols;
  }

  // ------------------------------------------------------------------ people

  private populate(F: Frame, beds: Lounger[]) {
    const b = F.b;
    const sea = this.sea;
    const out = this.statics[b];
    const h = (i: number, j: number) => hash2(i, j + b * 151, 4431);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const pick = <T>(arr: T[], x: number) => arr[Math.floor(x * arr.length) % arr.length];
    const look = (i: number, j: number) => {
      const female = h(i, j + 1) < 0.5;
      const mask = (female ? Opt.LongHair : 0) | (h(i, j + 2) < 0.2 ? Opt.BrimHat : h(i, j + 2) < 0.3 ? Opt.Cap : 0);
      const skin = pick(SKINS, h(i, j + 3));
      const top = female ? pick(SWIM, h(i, j + 4)) : h(i, j + 4) < 0.6 ? skin : pick(SWIM, h(i, j + 5));
      const bot = pick(SWIM, h(i, j + 6));
      return { mask, skin, top, bot, hat: C(h(i, j + 7) < 0.5 ? 0xf0ead8 : 0x2a4a80) };
    };
    // sunbathers on loungers: lying, a few sitting up
    beds.forEach((bd, i) => {
      const x = h(i, 11);
      if (x > 0.42 * this.crowd) return;
      const L = look(i, 20);
      const sit = x < 0.09;
      const sz = 0.82 + h(i, 12) * 0.12;
      const kk = CIV_SCALE * sz;
      e.set(0, -bd.yaw, 0, 'YXZ');
      q.setFromEuler(e);
      m.compose(new THREE.Vector3(bd.x, bd.y + (sit ? 0.08 - 0.9 * kk : 0.095), bd.z), q, new THREE.Vector3(kk, kk, kk));
      if (!sit) m.multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 2)).multiply(new THREE.Matrix4().makeTranslation(-0.95, 0, 0));
      out.push({ m: m.clone(), pose: sit ? Pose.Sit : Pose.Lying, mask: L.mask, skin: L.skin, top: L.top, bot: L.bot, hat: L.hat, phase: h(i, 13) * 6, lean: 0 });
    });
    // groups chatting on the sand and at the waterline
    for (let i = 0; i < Math.round(16 * this.crowd); i++) {
      const u = sea.beach[0] + 1 + h(i, 31) * (sea.beach[1] - sea.beach[0] - 2);
      const v = -0.9 - h(i, 32) * 2.6;
      const p = F.P(u, v);
      if (!this.inMap(p.x, p.y, 0.4) || this.tileAt(p.x, p.y) !== Tile.Sand) continue;
      const n = 1 + Math.floor(h(i, 33) * 3);
      for (let j = 0; j < n; j++) {
        const a = (j / n) * Math.PI * 2 + h(i, 34);
        const x = p.x + Math.cos(a) * 0.16 * (n > 1 ? 1 : 0);
        const z = p.y + Math.sin(a) * 0.16 * (n > 1 ? 1 : 0);
        const L = look(i * 7 + j, 40);
        const kk = CIV_SCALE * (0.85 + h(i * 7 + j, 41) * 0.15);
        e.set(0, -(a + Math.PI), 0, 'YXZ');
        q.setFromEuler(e);
        m.compose(new THREE.Vector3(x, this.gh(x, z), z), q, new THREE.Vector3(kk, kk, kk));
        out.push({ m: m.clone(), pose: n > 1 ? Pose.Chat : h(i, 35) < 0.5 ? Pose.Wave : Pose.Walk, mask: L.mask, skin: L.skin, top: L.top, bot: L.bot, hat: L.hat, phase: h(i * 7 + j, 42) * 6, lean: 0 });
      }
    }
    // swimmers in the shallows inside the buoys, bobbing; the pool too
    for (let i = 0; i < Math.round(18 * this.crowd); i++) {
      const u = sea.beach[0] + 1.5 + h(i, 51) * (sea.beach[1] - sea.beach[0] - 6);
      const v = 0.45 + h(i, 52) * 2.4;
      const p = F.P(u, v);
      if (!this.inMap(p.x, p.y, 0.3) || this.tileAt(p.x, p.y) !== Tile.Water) continue;
      const L = look(i, 60);
      const kk = CIV_SCALE * 0.88;
      e.set(0, -h(i, 53) * 6.28, 0, 'YXZ');
      q.setFromEuler(e);
      const y = WATER_LEVEL - 1.0 * kk;
      m.compose(new THREE.Vector3(p.x, y, p.y), q, new THREE.Vector3(kk, kk, kk));
      out.push({ m: m.clone(), pose: h(i, 54) < 0.3 ? Pose.Wave : Pose.Chat, mask: L.mask, skin: L.skin, top: L.top, bot: L.bot, hat: L.hat, phase: h(i, 55) * 6, lean: 0, swim: y });
    }
    // strollers on the promenade
    for (let i = 0; i < Math.round(9 * this.crowd); i++) {
      const L = look(i, 70);
      this.walkers.push({ b, u: sea.beach[0] + 1 + h(i, 71) * (sea.beach[1] - sea.beach[0] - 2), v: -4.55 + (h(i, 72) - 0.5) * 0.25, dir: h(i, 73) < 0.5 ? 1 : -1, speed: 0.22 + h(i, 74) * 0.12, ph: h(i, 75) * 6, skin: L.skin, top: h(i, 76) < 0.5 ? C(0xf0ece4) : L.top, bot: L.bot, hat: L.hat, mask: L.mask, size: 0.85 + h(i, 77) * 0.15 });
    }
  }

  private drawPeople(time: number) {
    const m = this._m;
    for (let b = 0; b < this.people.length; b++) {
      const ci = this.people[b];
      ci.begin();
      for (const s of this.statics[b]) {
        if (s.swim !== undefined) {
          m.copy(s.m);
          m.elements[13] = s.swim + Math.sin(time * 1.6 + s.phase) * 0.012;
          ci.push(m, s.phase + time * 1.5, 0, s.pose, s.mask, s.skin, s.lean, s.top, s.bot, s.hat);
        } else ci.push(s.m, s.phase + (s.pose === Pose.Chat || s.pose === Pose.Wave ? time : 0), 0, s.pose, s.mask, s.skin, s.lean, s.top, s.bot, s.hat);
      }
      const F = this.frame(b);
      for (const w of this.walkers) {
        if (w.b !== b) continue;
        const p = F.P(w.u, w.v);
        const yaw = F.yaw(w.u, w.v) + (w.dir < 0 ? Math.PI : 0);
        const kk = CIV_SCALE * w.size;
        this._e.set(0, -yaw, 0, 'YXZ');
        this._q.setFromEuler(this._e);
        m.compose(this._v.set(p.x, this.gh(p.x, p.y) + 0.03, p.y), this._q, this._s.set(kk, kk, kk));
        ci.push(m, w.ph, 0.9, Pose.Walk, w.mask, w.skin, 0.02, w.top, w.bot, w.hat);
      }
      ci.commit();
    }
  }

  // ------------------------------------------------------------------ boats

  private buildBoats() {
    const geos = [yachtGeometry(), speedboatGeometry(), dinghyGeometry()];
    const kinds: [number, number, number][] = [
      // (u, v, kind): the yacht off the reef, speedboats by the pontoon, a dinghy, a yacht far out
      [-9.5, 9.5, 0],
      [-3.2, 5.6, 1],
      [-6.4, 6.1, 1],
      [3.5, 6.8, 2],
      [-16, 14, 0],
      [8, 22, 0],
    ];
    for (const b of [0, 1])
      kinds.forEach(([u, v, kind], i) => {
        const F = this.frame(b);
        const p = F.P(u + b * 1.5, v);
        const f = seaFrame(this.map.w, this.map.h, this.sea.off, p.x, p.y);
        if (coastV(this.sea, f.u, f.v) < 3) return;
        this.boatList.push({ x: p.x, z: p.y, yaw: F.yaw(u, v) + (i % 2 ? 0.5 : -0.4) + b * 0.3, ph: i * 1.7 + b, kind });
      });
    // one instanced mesh per hull kind and corner (each corner culls on its own)
    const out: THREE.InstancedMesh[] = [];
    for (const corner of [0, 1]) {
      geos.forEach((g, kind) => {
        const list = this.boatList.filter((bt) => bt.kind === kind && (bt.x + bt.z > this.map.w ? 1 : 0) === corner);
        if (!list.length) return;
        const im = new THREE.InstancedMesh(g, landmarkMaterial(this.fog), list.length);
        // (instance colours: the same program as the parasols and loungers)
        for (let i = 0; i < list.length; i++) im.setColorAt(i, new THREE.Color(1, 1, 1));
        im.name = 'seaside-boats';
        im.castShadow = this.quality === 'high';
        im.userData.list = list;
        out.push(im);
        this.group.add(im);
      });
    }
    this.boatMeshes = out;
    this.updateBoats(0);
    for (const im of out) {
      im.computeBoundingSphere();
      if (im.boundingSphere) im.boundingSphere.radius += 1;
    }
  }
  private boatMeshes: THREE.InstancedMesh[] = [];

  private updateBoats(time: number) {
    const chop = RIVER.wState.value.x;
    for (const im of this.boatMeshes) {
      const list = im.userData.list as Boat[];
      list.forEach((o, i) => {
        const t = time + o.ph;
        const amp = 1 + chop * 2;
        this._e.set(Math.sin(t * 1.1) * 0.035 * amp, -o.yaw + Math.sin(t * 0.23) * 0.05, Math.sin(t * 0.8 + 1) * 0.025 * amp, 'YXZ');
        this._q.setFromEuler(this._e);
        this._m.compose(this._v.set(o.x, WATER_LEVEL + Math.sin(t * 0.9) * 0.012 * amp, o.z), this._q, this._s.set(1, 1, 1));
        im.setMatrixAt(i, this._m);
      });
      im.instanceMatrix.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------------ helpers

  private instanced(geo: THREE.BufferGeometry, list: { m: THREE.Matrix4; c: THREE.Color; k?: number }[], name: string): THREE.Object3D[] {
    if (!list.length) return [];
    // two variants share a mesh when the geometry has them (parasols: thatch on the beach, white on the deck)
    const out: THREE.Object3D[] = [];
    for (const b of [0, 1]) {
      const sub = list.filter((it) => {
        const x = it.m.elements[12];
        const z = it.m.elements[14];
        return (x + z > this.map.w ? 1 : 0) === b;
      });
      if (!sub.length) continue;
      const im = new THREE.InstancedMesh(geo, landmarkMaterial(this.fog), sub.length);
      sub.forEach((it, i) => {
        // the deck's parasols are white canvas (k = 1): a slimmer, paler shade (scaled variant)
        const mm = it.k === 1 ? it.m.clone().multiply(new THREE.Matrix4().makeScale(0.82, 0.95, 0.82)) : it.m;
        im.setMatrixAt(i, mm);
        im.setColorAt(i, it.k === 1 ? new THREE.Color(1.9, 1.9, 1.9).multiply(it.c) : it.c);
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      im.castShadow = this.quality === 'high';
      im.receiveShadow = false;
      im.name = name;
      out.push(im);
    }
    return out;
  }

  update(time: number) {
    this.frameNo++;
    if (this.reef) {
      this.reef.zoom = this.zoom;
      this.reef.update();
    }
    this.updateBoats(time);
    // the figures: left out zoomed out; every other frame is plenty (bobbing swimmers, strollers)
    const near = this.zoom >= 1.1;
    for (const ci of this.people) ci.mesh.visible = near && ci.n > 0;
    if (near && this.people.length && this.frameNo % 2 === 0) {
      const dt = 1 / 30;
      for (const w of this.walkers) {
        w.u += w.dir * w.speed * dt * 2;
        w.ph += dt * 2 * 6.5 * w.speed;
        if (w.u > this.sea.beach[1] - 0.5 || w.u < this.sea.beach[0] + 0.5) w.dir *= -1;
      }
      this.drawPeople(time);
    }
  }

  dispose() {
    this.reef?.dispose();
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
  }
}

// ------------------------------------------------------------------ models

/**
 * A coconut palm leaning out towards the sea (local -z), its slim ringed trunk curving up, drooping fronds and
 * a cluster of coconuts. Origin at the foot.
 */
function coconutPalm(k: Kit, v: number, s = 1) {
  const up = new THREE.Vector3(0, 1, 0);
  const lean = 0.35 + v * 0.3;
  const P = (t: number) => new THREE.Vector3(0, t * 1.15 * s, -lean * t * t * s);
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = P(i / n);
    const b = P((i + 1) / n);
    const d = b.clone().sub(a);
    const len = d.length();
    const g = new THREE.CylinderGeometry(0.045 * s * (1 - i * 0.05), 0.052 * s * (1 - i * 0.05), len + 0.01, 6);
    const m = new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(up, d.normalize()), new THREE.Vector3(1, 1, 1));
    k.add(g, m, i % 2 ? 0x8a7458 : 0x9c8664);
  }
  const top = P(1);
  for (let f = 0; f < 9; f++) {
    const a = (f / 9) * Math.PI * 2 + v * 4;
    for (let sg = 0; sg < 3; sg++) {
      const L = 0.27 * s;
      const g = new THREE.BoxGeometry(L, 0.01, (0.13 - sg * 0.035) * s);
      g.translate(L / 2, 0, 0).rotateZ(0.1 - sg * 0.42).translate(sg * L * 0.9, -sg * sg * 0.045 * s, 0).rotateY(a).translate(top.x, top.y, top.z);
      k.add(g, null, sg === 2 ? 0x5a8a2a : 0x4e8a34);
    }
  }
  for (let c = 0; c < 3; c++) {
    const a = c * 2.1 + v;
    k.ball(0.04 * s, top.x + Math.cos(a) * 0.05 * s, top.y - 0.05 * s, top.z + Math.sin(a) * 0.05 * s, 0x5a4a22, 0);
  }
}

/** A thatched beach parasol (origin at the foot of the pole). */
function parasolGeometry(): THREE.BufferGeometry {
  const k = new Kit();
  k.at(0, 0, 0);
  k.cyl(0.018, 0.016, 0.4, 0, 0, 0, 0x7a5a38, 4);
  // the straw cone in two layers with a ragged fringe
  k.cone(0.29, 0.13, 0, 0.36, 0, THATCH, 9);
  k.cone(0.2, 0.1, 0, 0.44, 0, 0xb89262, 7);
  k.cyl(0.3, 0.27, 0.05, 0, 0.33, 0, THATCH_DK, 9, 0, true);
  return k.build();
}

/** A sun lounger (local +x = its length; origin at the middle). */
function loungerGeometry(): THREE.BufferGeometry {
  const k = new Kit();
  k.at(0, 0, 0);
  k.box(0.3, 0.02, 0.13, -0.03, 0.07, 0, 0xffffff);
  k.box(0.13, 0.02, 0.13, 0.17, 0.11, 0, 0xffffff, 0, 0, 0.55);
  for (const sx of [-0.15, 0.1]) k.box(0.015, 0.06, 0.12, sx, 0.03, 0, 0xcfcfcf);
  return k.build();
}

function yachtGeometry(): THREE.BufferGeometry {
  const k = new Kit();
  k.at(0, 0, 0);
  // hull: a tapered white body with a navy stripe; decks and a dark-glazed superstructure
  k.box(1.5, 0.16, 0.42, 0, 0.05, 0, WHITE);
  k.add(new THREE.ConeGeometry(0.21, 0.42, 4).rotateZ(-Math.PI / 2).rotateX(Math.PI / 4).scale(1, 0.55, 1), new THREE.Matrix4().makeTranslation(0.95, 0.07, 0), WHITE);
  k.box(1.52, 0.03, 0.43, 0, 0.0, 0, 0x22345a);
  k.box(0.9, 0.12, 0.34, -0.12, 0.19, 0, WHITE);
  k.box(0.86, 0.06, 0.345, -0.12, 0.2, 0, 0x2a3a4a, 2);
  k.box(0.5, 0.1, 0.28, -0.2, 0.3, 0, WHITE);
  k.box(0.46, 0.05, 0.285, -0.2, 0.31, 0, 0x2a3a4a);
  k.cyl(0.01, 0.01, 0.2, -0.2, 0.35, 0, 0xd0d0d0, 4);
  k.ball(0.02, -0.2, 0.56, 0, 0xffffff, 0, 1);
  return k.build();
}

function speedboatGeometry(): THREE.BufferGeometry {
  const k = new Kit();
  k.at(0, 0, 0);
  k.box(0.62, 0.08, 0.22, 0, 0.03, 0, WHITE);
  k.add(new THREE.ConeGeometry(0.11, 0.22, 4).rotateZ(-Math.PI / 2).rotateX(Math.PI / 4).scale(1, 0.5, 1), new THREE.Matrix4().makeTranslation(0.42, 0.04, 0), WHITE);
  k.box(0.63, 0.02, 0.225, 0, -0.005, 0, 0x2a6fc0);
  k.box(0.08, 0.06, 0.18, 0.08, 0.1, 0, 0x6a8a9a, 0, 0, 0.5);
  k.box(0.2, 0.04, 0.16, -0.14, 0.08, 0, 0xd8d0c0);
  return k.build();
}

function dinghyGeometry(): THREE.BufferGeometry {
  const k = new Kit();
  k.at(0, 0, 0);
  // a glass-bottom boat: a long open hull with a canopy
  k.box(0.9, 0.08, 0.3, 0, 0.03, 0, 0xf0c040);
  k.box(0.92, 0.02, 0.31, 0, -0.005, 0, 0x2a6fc0);
  for (const sx of [-0.35, 0, 0.35]) for (const sz of [-0.13, 0.13]) k.box(0.012, 0.16, 0.012, sx, 0.15, sz, 0xd8d8d8);
  k.box(0.82, 0.015, 0.3, 0, 0.23, 0, 0x2f7ad0);
  return k.build();
}
