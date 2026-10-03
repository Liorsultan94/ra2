import * as THREE from 'three';
import { Tile, WATER_LEVEL, type GameMap } from '../../sim/map';
import type { FogOfWar } from '../fog';
import { groundY } from '../landmarks/ground';
import { roadClear } from './clearance';
import { landmarkMaterial } from '../landmarks/material';
import { civSound } from '../landmarks/sound';
import { Kit } from '../models/landmarks';
import { barge, ferry, motorBoat, tourBoat } from '../models/landmarks-vehicles';
import type { RiverInfo } from '../water';
import type { AmbientFrame, FogProbe, LightSprites, Quality } from './shared';

/*
 * Water transport (render only, next to ambient/river.ts's ducks and fishing
 * boats, which it leaves alone):
 *
 *  - Frontline Crossing: a double-ended car ferry shuttling across the river
 *    between two concrete slipways, far from the bridges; it waits at each
 *    landing, then crosses (horn on departure, lit at night);
 *  - Canal City: barges and tour boats working up and down the canal (they
 *    keep right and pass under the bridges), and a marina where the canal
 *    runs out of town: pontoons with moored motor boats and yachts (the
 *    quay cranes are landmarks).
 *
 * Draw calls: the slipways / pontoons / moored boats are one static mesh; the
 * ferry, the barges and the tour boats one instanced mesh each, drawn only
 * while one is on screen. Low quality: the static mesh only.
 */

interface Boat {
  kind: 0 | 1;
  /** Along the canal (sample space), direction, speed (tiles / s). */
  s: number;
  dir: number;
  v: number;
  lane: number;
  x: number;
  y: number;
  yaw: number;
  bob: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

export class WaterTransport {
  readonly group = new THREE.Group();
  private ferryIm: THREE.InstancedMesh | null = null;
  private bargeIm: THREE.InstancedMesh | null = null;
  private tourIm: THREE.InstancedMesh | null = null;
  private ferryRun: { ax: number; ay: number; bx: number; by: number; t: number; state: number; wait: number; x: number; y: number; yaw: number } | null = null;
  private boats: Boat[] = [];
  private animate: boolean;
  private time = 0;

  constructor(
    private map: GameMap,
    private river: RiverInfo | null,
    fog: FogOfWar,
    private probe: FogProbe,
    private lights: LightSprites,
    quality: Quality,
  ) {
    this.group.name = 'water-transport';
    this.animate = quality !== 'low';
    const mat = landmarkMaterial(fog);
    const k = new Kit();
    if (map.id === 'frontline' && river) this.planFerry(k);
    if (map.id === 'urban') {
      this.marina(k);
      if (river) this.planCanal();
    }
    if (k.count) {
      const mesh = new THREE.Mesh(k.build(), mat);
      mesh.name = 'water-transport-static';
      mesh.receiveShadow = quality !== 'low';
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
    if (!this.animate) return;
    const mk = (geo: THREE.BufferGeometry, n: number, name: string) => {
      const im = new THREE.InstancedMesh(geo, mat, n);
      im.name = name;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      im.count = 0;
      im.visible = false;
      im.castShadow = quality === 'high';
      this.group.add(im);
      return im;
    };
    if (this.ferryRun) this.ferryIm = mk(ferry(), 1, 'ferry');
    if (this.boats.length) {
      this.bargeIm = mk(barge(), 4, 'barges');
      this.tourIm = mk(tourBoat(), 4, 'tour-boats');
    }
  }

  // ---------------------------------------------------------------- setup

  private wet(x: number, y: number) {
    const m = this.map;
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return false;
    return m.tiles[ty * m.w + tx] === Tile.Water;
  }

  /** Dry land (above the waterline, not a water tile). */
  private dry(x: number, y: number) {
    return !this.wet(x, y) && groundY(this.map, x, y) > WATER_LEVEL + 0.08;
  }

  /** The ferry: a straight crossing well away from the bridges, the jetty and the weir, near the south-east corner. */
  private planFerry(k: Kit) {
    const R = this.river!;
    const S = R.samples;
    if (S.length < 10) return;
    const avoid = [...R.bridgeS, R.features.jetty?.s ?? -1e9, R.features.weir?.s ?? -1e9, R.features.rapids ? (R.features.rapids.s0 + R.features.rapids.s1) / 2 : -1e9];
    let best = -1;
    let bestScore = -1e9;
    for (let i = 4; i < S.length - 4; i++) {
      const sp = S[i];
      const d = Math.min(...avoid.map((a) => Math.abs(a - sp.s)));
      if (d < 9) continue;
      // inside the map, not too close to its edge, towards the south-east (player 0's flank)
      if (sp.x < 6 || sp.y < 6 || sp.x > this.map.w - 6 || sp.y > this.map.h - 6) continue;
      const score = sp.x + sp.y - Math.abs(sp.width - 4.4) * 4;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) return;
    const sp = S[best];
    const nx = -sp.ty;
    const ny = sp.tx;
    // walk out to the banks
    const bank = (sg: number) => {
      let t = 0;
      while (t < 6 && this.wet(sp.x + nx * sg * t, sp.y + ny * sg * t)) t += 0.1;
      return t;
    };
    const ta = bank(-1);
    const tb = bank(1);
    if (ta < 0.8 || tb < 0.8) return;
    const ax = sp.x - nx * (ta - 0.75);
    const ay = sp.y - ny * (ta - 0.75);
    const bx = sp.x + nx * (tb - 0.75);
    const by = sp.y + ny * (tb - 0.75);
    this.ferryRun = { ax, ay, bx, by, t: 0, state: 0, wait: 6, x: ax, y: ay, yaw: Math.atan2(by - ay, bx - ax) };
    // slipways: a concrete ramp from the bank down into the water, bollards, a waiting lane
    for (const [sx, sy, dx, dy, edge] of [
      [sp.x - nx * ta, sp.y - ny * ta, -nx, -ny, ta],
      [sp.x + nx * tb, sp.y + ny * tb, nx, ny, tb],
    ] as const) {
      void edge;
      const yaw = Math.atan2(dy, dx);
      const top = Math.max(groundY(this.map, sx + dx * 1.4, sy + dy * 1.4), WATER_LEVEL + 0.1);
      // ramp: from 1.6 inland down to 0.7 into the water, in two pieces following the bank
      const pts = [1.6, 0.35, -0.7].map((t) => ({ t, h: t > 0 ? Math.max(groundY(this.map, sx + dx * t, sy + dy * t), WATER_LEVEL) + 0.03 : WATER_LEVEL - 0.08 }));
      for (let i = 0; i < 2; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const len = a.t - b.t;
        const mx = sx + dx * (a.t + b.t) / 2;
        const my = sy + dy * (a.t + b.t) / 2;
        const tilt = Math.atan2(a.h - b.h, len);
        k.at(mx, (a.h + b.h) / 2, my, yaw).box(len + 0.04, 0.08, 0.86, 0, 0, 0, 0x9a968e, 0, 0, 0, tilt);
        k.at(mx, (a.h + b.h) / 2 - 0.3, my, yaw).box(len + 0.04, 0.5, 0.8, 0, 0, 0, 0x7a766e, 0, 0, 0, tilt);
      }
      void top;
      for (const sg of [-1, 1]) {
        const px = sx + dx * 0.7 - dy * sg * 0.58;
        const py = sy + dy * 0.7 + dx * sg * 0.58;
        if (!this.dry(px, py)) continue;
        k.at(px, groundY(this.map, px, py) - 0.02, py, yaw).cyl(0.05, 0.045, 0.16, 0, 0, 0, 0x2a2a2a, 6).box(0.04, 0.3, 0.04, 0.3, 0.15, 0, 0xe8e8e8);
      }
      // a ticket hut and a sign
      const hx = sx + dx * 1.9 - dy * 0.75;
      const hy = sy + dy * 1.9 + dx * 0.75;
      if (this.dry(hx, hy) && roadClear(this.map, hx, hy, 0.3)) k.at(hx, groundY(this.map, hx, hy) - 0.02, hy, yaw).box(0.36, 0.3, 0.3, 0, 0.15, 0, 0xe8e0d0).box(0.42, 0.04, 0.36, 0, 0.32, 0, 0x2a5ab0).box(0.02, 0.12, 0.2, -0.19, 0.16, 0, 0xffd590, 1);
    }
  }

  /** Canal boats: barges and tour boats spread along the canal, keeping right. */
  private planCanal() {
    const S = this.river!.samples;
    if (S.length < 20) return;
    const s0 = S[0].s;
    const s1 = S[S.length - 1].s;
    for (let i = 0; i < 4; i++) {
      const dir = i % 2 ? 1 : -1;
      this.boats.push({ kind: i < 2 ? 0 : 1, s: s0 + ((i + 0.3) / 4) * (s1 - s0), dir, v: i < 2 ? 0.32 : 0.48, lane: 0.55, x: 0, y: 0, yaw: 0, bob: Math.random() * 6 });
    }
  }

  /** The marina where the canal leaves town (north-west): pontoons along the channel and moored boats. */
  private marina(k: Kit) {
    const m = this.map;
    // the channel runs on north past the edge for x ~ 0 .. 4.5 (outskirts water continues the canal)
    const x0 = 4.2;
    for (let i = 0; i < 4; i++) {
      const y = -4.5 - i * 2.6;
      // a finger pontoon out from the east quay, two boats moored along it
      k.at(x0 - 0.75, WATER_LEVEL + 0.05, y, 0).box(1.5, 0.06, 0.22, 0, 0, 0, 0x8a6a4a);
      for (const sg of [-1, 1]) {
        const v = ((i * 7 + (sg > 0 ? 3 : 0)) % 10) / 10;
        k.at(x0 - 0.85, WATER_LEVEL, y + sg * 0.32, Math.PI);
        motorBoat(k, v);
      }
    }
    // the quay walk along the channel
    k.at(x0 + 0.25, WATER_LEVEL + 0.1, -9.5, Math.PI / 2).box(12, 0.12, 0.5, 0, 0, 0, 0x8a6a4a);
    for (let i = 0; i < 6; i++) if (this.dry(x0 + 0.5, -4 - i * 2)) k.at(x0 + 0.5, groundY(m, x0 + 0.5, -4 - i * 2) - 0.02, -4 - i * 2, 0).cyl(0.04, 0.03, 0.6, 0, 0, 0, 0x3a3a3a, 6).box(0.12, 0.04, 0.04, 0, 0.58, 0, 0x3a3a3a);
  }

  // ---------------------------------------------------------------- frame

  update(f: AmbientFrame) {
    if (!this.animate) return;
    this.time += f.dt;
    this.updateFerry(f);
    this.updateBoats(f);
  }

  private visible(f: AmbientFrame, x: number, y: number) {
    return x > f.vx0 - 2 && x < f.vx1 + 2 && y > f.vy0 - 2 && y < f.vy1 + 2 && this.probe.visible(x, y);
  }

  private updateFerry(f: AmbientFrame) {
    const F = this.ferryRun;
    const im = this.ferryIm;
    if (!F || !im) return;
    const dt = f.dt;
    const dist = Math.hypot(F.bx - F.ax, F.by - F.ay);
    // calm down when there is shooting nearby: stay at the landing
    let danger = false;
    for (const d of f.dangers) if (Math.hypot(d.x - F.x, d.y - F.y) < d.r + 4) danger = true;
    if (F.state === 0 || F.state === 2) {
      F.wait -= dt;
      if (F.wait <= 0 && !danger) {
        F.state = F.state === 0 ? 1 : 3;
        if (this.visible(f, F.x, F.y)) civSound('shipHorn', 0.6, F.x, F.y, 0.4);
      }
    } else {
      F.t += (dt * 0.42) / dist;
      if (F.t >= 1) {
        F.t = 0;
        F.state = F.state === 1 ? 2 : 0;
        F.wait = 10 + Math.random() * 6;
      }
    }
    const going = F.state === 1;
    const back = F.state === 3;
    const k = going || back ? F.t : 0;
    const e = k * k * (3 - 2 * k);
    const u = F.state === 0 ? 0 : F.state === 2 ? 1 : going ? e : 1 - e;
    F.x = F.ax + (F.bx - F.ax) * u;
    F.y = F.ay + (F.by - F.ay) * u;
    if (!this.visible(f, F.x, F.y)) {
      im.visible = false;
      return;
    }
    const bob = Math.sin(this.time * 1.3) * 0.006;
    _q.setFromEuler(_e.set(Math.sin(this.time * 0.9) * 0.012, -F.yaw, 0, 'YXZ'));
    _m.compose(_p.set(F.x, WATER_LEVEL + 0.02 + bob, F.y), _q, _s);
    im.setMatrixAt(0, _m);
    im.count = 1;
    im.visible = true;
    im.instanceMatrix.needsUpdate = true;
    const dk = f.dark;
    if (dk > 0.1) {
      // navigation lights and the wheelhouse lamp
      const cx = Math.cos(F.yaw);
      const cy = Math.sin(F.yaw);
      this.lights.flare(F.x - cy * 0.26 * -1, WATER_LEVEL + 0.62, F.y + cx * 0.26 * -1, 0.12, 1.6 * dk, 1.4 * dk, 1.0 * dk);
      this.lights.flare(F.x + cx * 0.85, WATER_LEVEL + 0.2, F.y + cy * 0.85, 0.08, 0.2 * dk, 1.5 * dk, 0.4 * dk);
      this.lights.flare(F.x - cx * 0.85, WATER_LEVEL + 0.2, F.y - cy * 0.85, 0.08, 1.6 * dk, 0.15 * dk, 0.1 * dk);
    }
  }

  private updateBoats(f: AmbientFrame) {
    if (!this.boats.length || !this.bargeIm || !this.tourIm) return;
    const R = this.river!;
    const S = R.samples;
    const s0 = S[0].s;
    const s1 = S[S.length - 1].s;
    const step = S.length > 1 ? S[1].s - S[0].s : 0.5;
    let nb = 0;
    let nt = 0;
    for (const b of this.boats) {
      // slow down when there is shooting nearby (they keep going: nowhere to hide on a canal)
      let v = b.v;
      for (const d of f.dangers) if (Math.hypot(d.x - b.x, d.y - b.y) < d.r) v *= 0.6;
      b.s += b.dir * v * f.dt;
      if (b.s > s1 - 2 || b.s < s0 + 2) {
        b.dir = -b.dir;
        b.s = Math.max(s0 + 2, Math.min(s1 - 2, b.s));
      }
      const fi = (b.s - s0) / step;
      const i = Math.max(0, Math.min(S.length - 2, Math.floor(fi)));
      const t = fi - i;
      const a = S[i];
      const c = S[i + 1];
      const tx = a.tx + (c.tx - a.tx) * t;
      const ty = a.ty + (c.ty - a.ty) * t;
      const L = Math.hypot(tx, ty) || 1;
      // keep right of the travel direction
      const nx = (-ty / L) * b.dir;
      const ny = (tx / L) * b.dir;
      const half = Math.min(a.width, c.width) / 2;
      const off = Math.min(b.lane, Math.max(0, half - 0.45));
      b.x = a.x + (c.x - a.x) * t - nx * off;
      b.y = a.y + (c.y - a.y) * t - ny * off;
      const want = Math.atan2(ty * b.dir, tx * b.dir);
      let d = want - b.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      b.yaw += d * Math.min(1, f.dt * 1.5);
      if (!this.visible(f, b.x, b.y)) continue;
      _q.setFromEuler(_e.set(Math.sin(this.time * 1.1 + b.bob) * 0.01, -b.yaw, 0, 'YXZ'));
      _m.compose(_p.set(b.x, WATER_LEVEL + 0.03 + Math.sin(this.time * 1.4 + b.bob) * 0.005, b.y), _q, _s);
      if (b.kind === 0) this.bargeIm.setMatrixAt(nb++, _m);
      else this.tourIm.setMatrixAt(nt++, _m);
      const dk = f.dark;
      if (dk > 0.1) {
        const cx = Math.cos(b.yaw);
        const cy = Math.sin(b.yaw);
        const len = b.kind === 0 ? 1.1 : 0.8;
        this.lights.flare(b.x + cx * len, WATER_LEVEL + 0.15, b.y + cy * len, 0.08, 1.4 * dk, 1.3 * dk, 1.1 * dk);
        if (b.kind === 1) this.lights.pool(b.x, WATER_LEVEL + 0.01, b.y, -b.yaw, 1.6, 0.7, 0.25 * dk, 0.2 * dk, 0.12 * dk);
      }
    }
    for (const [im, n] of [
      [this.bargeIm, nb],
      [this.tourIm, nt],
    ] as const) {
      im.count = n;
      im.visible = n > 0;
      if (n) im.instanceMatrix.needsUpdate = true;
    }
  }

  /** Debug / tests. */
  stats() {
    const F = this.ferryRun;
    return { ferry: F ? { x: +F.x.toFixed(2), y: +F.y.toFixed(2), state: F.state, ax: +F.ax.toFixed(1), ay: +F.ay.toFixed(1), bx: +F.bx.toFixed(1), by: +F.by.toFixed(1) } : null, boats: this.boats.map((b) => ({ kind: b.kind, x: +b.x.toFixed(1), y: +b.y.toFixed(1) })) };
  }
}
