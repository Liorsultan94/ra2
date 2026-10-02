import * as THREE from 'three';
import { DEFS, unitDef } from '../../sim/defs';
import { WATER_LEVEL } from '../../sim/map';
import type { SimEvent } from '../../sim/types';
import type { World } from '../../sim/world';
import type { Atmosphere } from '../atmos';
import type { Effects } from '../effects';
import type { FogOfWar } from '../fog';
import type { Terrain } from '../terrain';
import { MAX_SLICKS, MAX_WLIGHTS, RIVER, waterRings, type RiverInfo } from '../water';
import { WX, WXM } from '../wxuniforms';

/*
 * The river's live state and combat on the water (visual only):
 *  - weather: glassy calm (still air, morning mist), wind chop and whitecaps
 *    (dynamic weather wind / storms), a muddy tint that builds up in heavy
 *    rain and clears over minutes, ice when it snows; the key light (sun or
 *    moon) and the night: the closest lamps / fires near the water are handed
 *    to the shader as reflected lights,
 *  - impacts: every splash (Effects.onSplash) starts a ring wave; heavy
 *    shells add a taller jet,
 *  - wrecks: vehicles destroyed at the water's edge leak burning fuel slicks
 *    that spread and drift downstream with fire and black smoke, and throw
 *    floating debris that drifts with the current before sinking,
 *  - collapsed bridges: their slabs churn foam and eddies (read from the
 *    sim's bridge table; the data map is restored when the bridge is rebuilt),
 *  - spray and mist over the weir and the rapids while they are in view.
 * Write-only towards the shader uniforms in water.ts; never touches the sim.
 */

export interface WaterFxHost {
  world: World;
  terrain: Terrain;
  effects: Effects;
  atmos: Atmosphere;
  fog: FogOfWar;
  scene: THREE.Scene;
  quality: 'low' | 'medium' | 'high';
  /** The view centre (camera target, world x / z). */
  target: THREE.Vector3;
  visibleAt(x: number, y: number): boolean;
}

interface Slick {
  x: number;
  y: number;
  r: number;
  rMax: number;
  age: number;
  life: number;
  burn: number;
  burnFor: number;
  emit: number;
}

interface Piece {
  x: number;
  y: number;
  z: number;
  vy: number;
  rx: number;
  ry: number;
  rz: number;
  spin: number;
  age: number;
  life: number;
  sx: number;
  sy: number;
  sz: number;
  c: THREE.Color;
  float: number;
}

const MAX_PIECES = 48;
const PIECE_COLS = [0x6a4c30, 0x5a4028, 0x2a2622, 0x3a3631, 0x7a6a50, 0x1c1a18].map((c) => new THREE.Color(c));

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export class WaterFx {
  private river: RiverInfo;
  private slicks: Slick[] = [];
  private pieces: Piece[] = [];
  private mesh: THREE.InstancedMesh;
  private time = 0;
  private mud = 0;
  private ice = 0;
  private chop = 0;
  private calm = 0.3;
  private frame = 0;
  private mistAcc = 0;
  private sprayAcc = 0;
  private bridgeDown: boolean[] = [];
  private bridgeOrig: (Uint8Array | null)[] = [];
  private v2 = { x: 0, y: 0 };
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private cand: { x: number; y: number; z: number; r: number; g: number; b: number; i: number; s: number }[] = Array.from({ length: 24 }, () => ({ x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, i: 0, s: 0 }));
  private nCand = 0;
  /** Coarse mask (per tile): within 3 tiles of open water. */
  private nearWater: Uint8Array;

  constructor(private host: WaterFxHost) {
    this.river = host.terrain.river;
    const mat = host.fog.apply(new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 }));
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, MAX_PIECES);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, PIECE_COLS[0]);
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'river-debris';
    this.mesh.userData.perfCat = 'waterfx';
    host.scene.add(this.mesh);
    const m = host.world.map;
    this.nearWater = new Uint8Array(m.w * m.h);
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < m.w; x++) {
        let near = 0;
        for (let j = -3; j <= 3 && !near; j++) for (let i = -3; i <= 3 && !near; i++) if (this.river.isWet(x + 0.5 + i, y + 0.5 + j)) near = 1;
        this.nearWater[y * m.w + x] = near;
      }
    host.effects.onSplash = (x, z, size) => this.splash(x, z, size);
    this.bridgeDown = host.world.bridges.map(() => false);
    this.bridgeOrig = host.world.bridges.map(() => null);
  }

  /** Debug / screenshots. */
  stats() {
    return { slicks: this.slicks.length, pieces: this.pieces.length, mud: +this.mud.toFixed(2), ice: +this.ice.toFixed(2), chop: +this.chop.toFixed(2), calm: +this.calm.toFixed(2), features: this.river.features };
  }

  // --------------------------------------------------------------- events

  private splash(x: number, z: number, size: number) {
    if (!this.river.isWet(x, z) && this.river.depthAt(x, z) < -0.05) return;
    waterRings.add(x, z, Math.min(2, 0.35 + size * 0.75));
    const fx = this.host.effects;
    if (size >= 1 && this.host.quality !== 'low') {
      // a taller, thinner jet in the middle of the column and a crown of spray
      const S = Math.sqrt(size);
      for (let i = 0; i < Math.round(6 * S * fx.rate); i++)
        fx.smokeSys.spawn({ x: x + (Math.random() - 0.5) * 0.06, y: WATER_LEVEL + 0.05, z: z + (Math.random() - 0.5) * 0.06, vy: (7 + Math.random() * 3.5) * S, life: 1.3 + Math.random() * 0.5, size: 0.1 * S, sizeEnd: 0.45 * S, color: 0xf6f9fa, colorEnd: 0xdfe7ea, alpha: 0.75, gravity: 8.5, drag: 0.4 });
      for (let i = 0; i < Math.round(10 * fx.rate); i++) {
        const a = (i / 10) * Math.PI * 2 + Math.random() * 0.3;
        fx.fire.spawn({ x: x + Math.cos(a) * 0.15 * S, y: WATER_LEVEL + 0.08, z: z + Math.sin(a) * 0.15 * S, vx: Math.cos(a) * 1.4 * S, vy: 2.6 * S + Math.random(), vz: Math.sin(a) * 1.4 * S, life: 0.7, size: 0.06, color: 0xb8c8d0, colorEnd: 0x5a6a70, alpha: 0.7, gravity: 9 });
      }
    }
  }

  /** Sim events: wrecks by the water leak burning fuel and throw floating debris. */
  onEvent(ev: SimEvent) {
    if (ev.t !== 'death') return;
    const d = DEFS[ev.def];
    if (!d) return;
    const m = this.host.world.map;
    const tx = Math.floor(ev.x);
    const ty = Math.floor(ev.y);
    if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h || !this.nearWater[ty * m.w + tx]) return;
    const veh = d.kind !== 'building' && unitDef(ev.def).category === 'vehicle';
    const air = d.kind !== 'building' && !!unitDef(ev.def).air;
    // nearest open water within reach
    const w = this.nearestWater(ev.x, ev.y, veh ? 2.6 : 1.8);
    if (!w) return;
    const dist = Math.hypot(w.x - ev.x, w.y - ev.y);
    if (veh || air) {
      if (dist < 2.4) this.addSlick(w.x, w.y, veh ? 1 : 0.7);
      this.debris(w.x, w.y, veh ? 7 : 4, 'metal');
    } else if (d.kind === 'building' && dist < 1.6) this.debris(w.x, w.y, 8, 'wood');
  }

  private nearestWater(x: number, y: number, R: number): { x: number; y: number } | null {
    const r = this.river;
    let best: { x: number; y: number } | null = null;
    let bd = Infinity;
    for (let j = -R; j <= R; j += 0.25)
      for (let i = -R; i <= R; i += 0.25) {
        const d = i * i + j * j;
        if (d > R * R || d >= bd) continue;
        // a little into the water, not on the wet sand
        if (r.shoreAt(x + i, y + j) < 0.35) continue;
        bd = d;
        best = { x: x + i, y: y + j };
      }
    return best;
  }

  private addSlick(x: number, y: number, k: number) {
    if (this.slicks.length >= MAX_SLICKS) this.slicks.shift();
    this.slicks.push({ x, y, r: 0.15, rMax: 0.75 + 0.45 * k + Math.random() * 0.25, age: 0, life: 70 + Math.random() * 30, burn: 1, burnFor: 22 + Math.random() * 14 * k, emit: 0 });
    waterRings.add(x, y, 0.7);
  }

  /** Floating wreckage: timber floats a long time, metal briefly before it sinks. */
  debris(x: number, y: number, n: number, kind: 'metal' | 'wood') {
    for (let i = 0; i < n; i++) {
      if (this.pieces.length >= MAX_PIECES) this.pieces.shift();
      const wood = kind === 'wood' || Math.random() < 0.3;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.6;
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      if (!this.river.isWet(px, py)) continue;
      const c = PIECE_COLS[wood ? Math.floor(Math.random() * 2) : 2 + Math.floor(Math.random() * 4)];
      this.pieces.push({
        x: px,
        y: WATER_LEVEL + 0.4 + Math.random() * 0.6,
        z: py,
        vy: 1 + Math.random() * 1.5,
        rx: Math.random() * 6,
        ry: Math.random() * 6,
        rz: Math.random() * 6,
        spin: (Math.random() - 0.5) * 1.2,
        age: 0,
        life: wood ? 25 + Math.random() * 20 : 8 + Math.random() * 10,
        sx: wood ? 0.16 + Math.random() * 0.14 : 0.06 + Math.random() * 0.08,
        sy: wood ? 0.022 : 0.03 + Math.random() * 0.03,
        sz: wood ? 0.04 + Math.random() * 0.03 : 0.05 + Math.random() * 0.06,
        c,
        float: 0,
      });
    }
  }

  // --------------------------------------------------------------- per frame

  update(dt: number) {
    if (dt <= 0) return;
    this.time += dt;
    this.frame++;
    this.weather(dt);
    if (this.frame % 3 === 0) this.gatherLights();
    this.updateSlicks(dt);
    this.updatePieces(dt);
    this.updateBridges();
    this.ambientSpray(dt);
  }

  private weather(dt: number) {
    const a = this.host.atmos;
    const st = a.wx;
    const cfg = a.cfg.weather;
    const rain = WX.wxRain.value;
    // wind chop
    let chop = 0;
    if (st) chop = Math.max(0, st.wind - 0.25) * 1.1 + st.storm * 0.45 + st.precip * 0.15;
    else if (cfg === 'rain') chop = 0.3;
    else if (cfg === 'sandstorm') chop = 0.55;
    else if (cfg === 'snow') chop = 0.12;
    chop = Math.min(1, chop);
    this.chop += (chop - this.chop) * Math.min(1, dt * 0.5);
    // glassy calm: still air, more so in the mist; rain drops break it
    const mist = Math.max(a.mist, WXM.mistAmount.value);
    const calm = Math.max(0, Math.min(1, (0.3 + mist * 0.75) * (1 - this.chop * 3) * (1 - rain)));
    this.calm += (calm - this.calm) * Math.min(1, dt * 0.4);
    // mud: heavy rain washes soil in; it settles over a few minutes
    if (rain > 0.25) this.mud = Math.min(cfg === 'rain' ? 0.6 : 1, this.mud + dt * 0.012 * rain * rain);
    else this.mud = Math.max(0, this.mud - dt * 0.0035);
    // ice follows the snow cover
    const iceT = smooth(0.25, 0.9, WX.wxSnow.value);
    this.ice += (iceT - this.ice) * Math.min(1, dt * 0.15);
    const ws = RIVER.wState.value;
    ws.set(this.chop, this.calm, this.mud, this.ice);
    // key light, night, wind direction, caustics
    const pu = this.host.effects.pu;
    RIVER.sunDir.value.copy(pu.uSunDir.value);
    const sc = pu.uSunCol.value;
    RIVER.sunCol.value.set(sc.x, sc.y, sc.z).multiplyScalar(0.95);
    const night = a.night as unknown as { dark?: number } | null;
    const dark = night && typeof night.dark === 'number' ? night.dark : 0;
    const wind = this.host.effects.wind;
    const wl = Math.hypot(wind.x, wind.z) || 1;
    const lum = sc.x * 0.3 + sc.y * 0.59 + sc.z * 0.11;
    const caus = smooth(0.35, 0.9, lum) * smooth(0.05, 0.3, pu.uSunDir.value.y) * (1 - (st ? st.cover : cfg === 'clear' ? 0 : 0.8) * 0.85) * (1 - dark);
    RIVER.wState2.value.set(dark, wind.x / wl, wind.z / wl, caus);
  }

  /** The lamps / fires nearest the view that stand close to the water: reflected by the shader. */
  private gatherLights() {
    const out = RIVER.wLightP.value;
    const outC = RIVER.wLightC.value;
    const m = this.host.world.map;
    const tgt = this.host.target;
    this.nCand = 0;
    const consider = (x: number, y: number, z: number, r: number, g: number, b: number, i: number) => {
      const tx = Math.floor(x);
      const tz = Math.floor(z);
      if (tx < 0 || tz < 0 || tx >= m.w || tz >= m.h || !this.nearWater[tz * m.w + tx]) return;
      const dx = x - tgt.x;
      const dz = z - tgt.z;
      const s = i / (1 + (dx * dx + dz * dz) / 60);
      if (s < 0.02) return;
      let k = this.nCand;
      if (k >= this.cand.length) {
        // replace the weakest
        k = 0;
        for (let j = 1; j < this.cand.length; j++) if (this.cand[j].s < this.cand[k].s) k = j;
        if (this.cand[k].s >= s) return;
      } else this.nCand++;
      const c = this.cand[k];
      c.x = x;
      c.y = y;
      c.z = z;
      c.r = r;
      c.g = g;
      c.b = b;
      c.i = i;
      c.s = s;
    };
    const night = this.host.atmos.night;
    const dark = RIVER.wState2.value.x;
    if (night && dark > 0.15) {
      const fl = night.group.getObjectByName('night-flares') as THREE.InstancedMesh | undefined;
      if (fl && fl.count > 0 && fl.instanceColor) {
        const ma = fl.instanceMatrix.array as Float32Array;
        const ca = fl.instanceColor.array as Float32Array;
        for (let i = 0; i < fl.count; i++) {
          const o = i * 16;
          const size = Math.hypot(ma[o], ma[o + 1], ma[o + 2]);
          consider(ma[o + 12], ma[o + 13], ma[o + 14], ca[i * 3], ca[i * 3 + 1], ca[i * 3 + 2], Math.min(2, size * 2.2) * dark);
        }
      }
    }
    const pu = this.host.effects.pu;
    for (let i = 0; i < pu.uFireP.value.length; i++) {
      const f = pu.uFireP.value[i];
      if (f.w <= 0) continue;
      const c = pu.uFireC.value[i];
      consider(f.x, f.y, f.z, c.x, c.y, c.z, Math.min(3, f.w * 0.25) * (0.4 + dark));
    }
    // the strongest few
    const n = Math.min(MAX_WLIGHTS, this.nCand);
    for (let k = 0; k < MAX_WLIGHTS; k++) {
      if (k >= n) {
        out[k].w = 0;
        continue;
      }
      let bi = k;
      for (let j = k + 1; j < this.nCand; j++) if (this.cand[j].s > this.cand[bi].s) bi = j;
      const t = this.cand[bi];
      this.cand[bi] = this.cand[k];
      this.cand[k] = t;
      out[k].set(t.x, t.y, t.z, t.i);
      outC[k].set(t.r, t.g, t.b);
    }
  }

  private updateSlicks(dt: number) {
    const out = RIVER.wSlicks.value;
    const fx = this.host.effects;
    const r = this.river;
    let lit = 0;
    for (let i = this.slicks.length - 1; i >= 0; i--) {
      const s = this.slicks[i];
      s.age += dt;
      if (s.age > s.life) {
        this.slicks.splice(i, 1);
        continue;
      }
      // spread, then thin out; drift downstream (a little slower than the surface)
      s.r += (s.rMax - s.r) * Math.min(1, dt * 0.12);
      r.velAt(s.x, s.y, this.v2);
      const nx = s.x + this.v2.x * dt * 0.75;
      const ny = s.y + this.v2.y * dt * 0.75;
      if (r.shoreAt(nx, ny) > 0.2) {
        s.x = nx;
        s.y = ny;
      }
      if (s.age > s.burnFor) s.burn = Math.max(0, s.burn - dt * 0.12);
      if (s.burn <= 0.01 || !this.host.visibleAt(s.x, s.y)) continue;
      // flames dancing over the film and a column of black smoke
      s.emit += dt * (8 + 10 * s.r) * s.burn * fx.rate;
      while (s.emit >= 1) {
        s.emit -= 1;
        const a = Math.random() * Math.PI * 2;
        const rr = Math.sqrt(Math.random()) * s.r * 0.7;
        const x = s.x + Math.cos(a) * rr;
        const z = s.y + Math.sin(a) * rr;
        fx.fire.spawn({ x, y: WATER_LEVEL + 0.03, z, vx: (Math.random() - 0.5) * 0.2, vy: 0.5 + Math.random() * 0.7, vz: (Math.random() - 0.5) * 0.2, life: 0.45 + Math.random() * 0.45, size: 0.14 + Math.random() * 0.14, sizeEnd: 0.05, color: 0xffc060, colorEnd: 0xa02008, alpha: 0.85, gravity: -0.6 });
        if (Math.random() < 0.3) fx.smokeSys.spawn({ x, y: WATER_LEVEL + 0.25, z, vx: 0, vy: 0.7 + Math.random() * 0.5, vz: 0, life: 3 + Math.random() * 2, size: 0.25, sizeEnd: 1.1 + s.r, color: 0x141210, colorEnd: 0x3a3632, alpha: 0.55 * s.burn, drag: 0.5, wind: 1 });
      }
      if (lit < 2) {
        lit++;
        fx.lights.sustain(s.x, WATER_LEVEL + 0.4, s.y, 2.2 * s.burn * (0.6 + s.r * 0.5), 0xff7a28, 0.35);
      }
    }
    for (let k = 0; k < MAX_SLICKS; k++) {
      const s = this.slicks[k];
      if (!s) out[k].set(0, 0, 0, 0);
      else out[k].set(s.x, s.y, s.r * (1 - smooth(s.life - 12, s.life, s.age)), s.burn);
    }
  }

  private updatePieces(dt: number) {
    const ps = this.pieces;
    const mesh = this.mesh;
    if (!ps.length) {
      if (mesh.visible) {
        mesh.visible = false;
        mesh.count = 0;
      }
      return;
    }
    const r = this.river;
    let n = 0;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.age += dt;
      if (p.age > p.life) {
        ps.splice(i, 1);
        continue;
      }
      const sinkK = smooth(p.life - 4, p.life, p.age);
      const surf = WATER_LEVEL - p.sy * 0.25 - sinkK * 0.3;
      if (p.y > surf + 0.001 && p.float < 0.5) {
        // falling in
        p.vy -= 9 * dt;
        p.y += p.vy * dt;
        p.rx += p.spin * 6 * dt;
        if (p.y <= surf) {
          p.y = surf;
          p.float = 1;
          if (p.sx > 0.08 && this.host.visibleAt(p.x, p.z)) waterRings.add(p.x, p.z, 0.25);
        }
      } else {
        // floating: carried by the current, bobbing and turning slowly
        r.velAt(p.x, p.z, this.v2);
        const nx = p.x + this.v2.x * dt * 0.9;
        const nz = p.z + this.v2.y * dt * 0.9;
        if (r.shoreAt(nx, nz) > 0.1) {
          p.x = nx;
          p.z = nz;
        }
        p.ry += p.spin * dt * 0.4;
        p.rx *= 1 - Math.min(1, dt * 2);
        p.rz *= 1 - Math.min(1, dt * 2);
        p.y = surf + Math.sin(this.time * 1.7 + p.ry * 3) * 0.006;
      }
      if (n >= MAX_PIECES) continue;
      this.e.set(p.rx, p.ry, p.rz);
      this.q.setFromEuler(this.e);
      this.m4.compose(this.p.set(p.x, p.y, p.z), this.q, this.s.set(p.sx, p.sy, p.sz));
      mesh.setMatrixAt(n, this.m4);
      mesh.setColorAt(n, p.c);
      n++;
    }
    mesh.count = n;
    mesh.visible = n > 0;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /** Collapsed bridges: their slabs churn foam and eddies in the data map until rebuilt. */
  private updateBridges() {
    const br = this.host.world.bridges;
    for (let i = 0; i < br.length; i++) {
      const down = br[i].status !== 'intact';
      if (down === this.bridgeDown[i]) continue;
      this.bridgeDown[i] = down;
      this.patchBridge(i, down);
      if (down) {
        const b = br[i];
        this.debris(b.x, b.y, 10, 'wood');
        for (let k = 0; k < 3; k++) waterRings.add(b.x + (Math.random() - 0.5) * 2, b.y + (Math.random() - 0.5) * 2, 1.2);
      }
    }
  }

  private patchBridge(i: number, down: boolean) {
    const tex = this.host.terrain.waterMat.uniforms.waterData2?.value as THREE.DataTexture | undefined;
    if (!tex) return;
    const data = tex.image.data as Uint8Array;
    const r = this.river;
    const N = r.N;
    const b = this.host.world.bridges[i];
    const R = b.length / 2 + 3;
    const i0 = Math.max(0, Math.floor((b.x - R) * r.res));
    const i1 = Math.min(N - 1, Math.ceil((b.x + R) * r.res));
    const j0 = Math.max(0, Math.floor((b.y - R) * r.res));
    const j1 = Math.min(r.NH - 1, Math.ceil((b.y + R) * r.res));
    const W = i1 - i0 + 1;
    if (down) {
      const orig = new Uint8Array(W * (j1 - j0 + 1) * 2);
      // deck line runs along the bridge ends
      const ex = b.ends[1].x - b.ends[0].x;
      const ey = b.ends[1].y - b.ends[0].y;
      const el = Math.hypot(ex, ey) || 1;
      const ux = ex / el;
      const uy = ey / el;
      for (let j = j0; j <= j1; j++)
        for (let ii = i0; ii <= i1; ii++) {
          const k = j * N + ii;
          const o = ((j - j0) * W + (ii - i0)) * 2;
          orig[o] = data[k * 4 + 2];
          orig[o + 1] = data[k * 4 + 3];
          if (!r.wetMask[k]) continue;
          const x = (ii + 0.5) / r.res;
          const y = (j + 0.5) / r.res;
          const dx = x - b.x;
          const dy = y - b.y;
          const along = dx * ux + dy * uy;
          if (Math.abs(along) > b.length / 2 + 0.3) continue;
          const c = r.sample(r.sAt(x, y));
          const tx = c ? c.tx : r.ax;
          const ty = c ? c.ty : r.ay;
          // distance downstream of the slab line
          const down2 = (dx - along * ux) * tx + (dy - along * uy) * ty;
          const slab = 1 - smooth(0.15, 0.55, Math.abs(down2));
          const trail = down2 > 0 ? (1 - smooth(0.3, 3.2, down2)) * (0.55 + 0.45 * Math.sin(along * 5.3 + down2 * 1.7)) : 0;
          const foam = Math.max(slab, trail * 0.8);
          data[k * 4 + 3] = Math.max(data[k * 4 + 3], Math.round(foam * 255));
          data[k * 4 + 2] = Math.max(data[k * 4 + 2], Math.round(trail * 200));
        }
      this.bridgeOrig[i] = orig;
    } else {
      const orig = this.bridgeOrig[i];
      if (!orig) return;
      for (let j = j0; j <= j1; j++)
        for (let ii = i0; ii <= i1; ii++) {
          const k = j * N + ii;
          const o = ((j - j0) * W + (ii - i0)) * 2;
          data[k * 4 + 2] = orig[o];
          data[k * 4 + 3] = orig[o + 1];
        }
      this.bridgeOrig[i] = null;
    }
    tex.needsUpdate = true;
  }

  /** Mist off the weir, spray on the rapids (only near the view, budgeted). */
  private ambientSpray(dt: number) {
    const f = this.river.features;
    const fx = this.host.effects;
    const t = this.host.target;
    const w = f.weir;
    if (w && Math.hypot(w.x - t.x, w.y - t.z) < 16 && this.host.visibleAt(w.x, w.y)) {
      this.mistAcc += dt * 7 * fx.rate * (1 - this.ice * 0.8);
      while (this.mistAcc >= 1) {
        this.mistAcc -= 1;
        const o = (Math.random() * 2 - 1) * (w.half - 0.15);
        const d = 0.15 + Math.random() * 0.35;
        fx.smokeSys.spawn({ x: w.x + w.ax * o + w.tx * d, y: WATER_LEVEL + 0.04, z: w.y + w.ay * o + w.ty * d, vx: w.tx * 0.12, vy: 0.12 + Math.random() * 0.12, vz: w.ty * 0.12, life: 2.2 + Math.random() * 1.5, size: 0.22, sizeEnd: 0.8, color: 0xe9eff1, colorEnd: 0xf2f5f6, alpha: 0.2, drag: 1.2, wind: 0.5 });
        if (Math.random() < 0.5) fx.fire.spawn({ x: w.x + w.ax * o + w.tx * 0.12, y: WATER_LEVEL + 0.04, z: w.y + w.ay * o + w.ty * 0.12, vx: w.tx * 0.6, vy: 0.6 + Math.random() * 0.6, vz: w.ty * 0.6, life: 0.4, size: 0.03, color: 0x9aa8b0, colorEnd: 0x4a5458, alpha: 0.6, gravity: 8 });
      }
    }
    const ra = f.rapids;
    if (ra && f.rocks.length && Math.hypot(ra.x - t.x, ra.y - t.z) < 16 && this.host.visibleAt(ra.x, ra.y)) {
      this.sprayAcc += dt * 9 * fx.rate;
      while (this.sprayAcc >= 1) {
        this.sprayAcc -= 1;
        const rk = f.rocks[Math.floor(Math.random() * f.rocks.length)];
        this.river.velAt(rk.x, rk.y, this.v2);
        const a = Math.random() * Math.PI * 2;
        fx.fire.spawn({ x: rk.x + Math.cos(a) * rk.r, y: WATER_LEVEL + 0.03, z: rk.y + Math.sin(a) * rk.r, vx: this.v2.x * 0.8 + Math.cos(a) * 0.2, vy: 0.7 + Math.random() * 0.8, vz: this.v2.y * 0.8 + Math.sin(a) * 0.2, life: 0.4, size: 0.035, color: 0xc8d4da, colorEnd: 0x6a7a80, alpha: 0.65, gravity: 8 });
      }
    }
  }

  dispose() {
    this.host.effects.onSplash = null;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
  }
}
