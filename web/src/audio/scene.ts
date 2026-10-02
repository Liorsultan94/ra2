/**
 * The battle's sound scene: per frame it reports the camera to the
 * AudioSystem as the listener, and a few times per second it reads (never
 * writes) the world and the renderer's weather state to drive
 *  - continuous aircraft engines (nearest four, with doppler) and jet flybys,
 *  - the ambience bed: wind following the weather, rain hiss, sandstorm grit,
 *    the river near the camera and night insects.
 * Nothing here touches the simulation; it only reads entity positions.
 */
import type { World } from '../sim/world';
import type { GameRenderer } from '../render/renderer';
import { BASE_VIEW } from '../render/renderer';
import { WX } from '../render/wxuniforms';
import { TICK_MS } from '../sim/types';
import { unitDef } from '../sim/defs';
import type { AudioSystem } from './audio';
import type { EngineKind } from './ambience';
import { ENGINE_SLOTS, engineKindFor } from './ambience';
import { doppler, nightAmount } from './spatial';

/** Map tile value of open water (sim/map.ts Tile.Water; const enums don't cross isolated modules). */
const TILE_WATER = 3;
const TICKS_PER_SEC = 1000 / TICK_MS;

interface Cand {
  id: number;
  kind: EngineKind;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  score: number;
}

export class AudioScene {
  private w = 1;
  private h = 1;
  private airT = 0;
  private ambT = 0;
  private riverT = 0;
  private river = 0;
  private riverPan = 0;
  private cands: Cand[] = [];
  private slotId: number[] = new Array(ENGINE_SLOTS).fill(-1);
  private taken: boolean[] = new Array(ENGINE_SLOTS).fill(false);
  private placed: boolean[] = new Array(ENGINE_SLOTS).fill(false);
  private flybyAt = new Map<number, number>();
  private time = 0;
  private halfW = 9;
  private halfD = 7;

  constructor(
    private audio: AudioSystem,
    private world: World,
    private r: GameRenderer,
    private visible: (x: number, y: number) => boolean,
    /** ambience and engines (off for the attract demo behind the menu) */
    private full: boolean,
  ) {
    for (let i = 0; i < ENGINE_SLOTS; i++) this.cands.push({ id: -1, kind: 'prop', x: 0, y: 0, z: 0, vx: 0, vy: 0, score: 0 });
  }

  resize(w: number, h: number): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
  }

  update(dt: number): void {
    this.time += dt;
    const r = this.r;
    const cd = r.camDir;
    const hn = Math.hypot(cd.x, cd.z) || 1;
    // screen right on the ground: forward (-camDir) x up
    const rx = cd.z / hn;
    const ry = -cd.x / hn;
    const halfH = BASE_VIEW / Math.max(0.1, r.zoom) / 2;
    this.halfW = halfH * (this.w / this.h);
    this.halfD = halfH / Math.max(0.35, cd.y);
    this.audio.setListener(r.target.x, r.target.z, rx, ry, this.halfW, this.halfD, r.zoom);
    if (!this.full || !this.audio.unlocked) return;
    this.airT -= dt;
    if (this.airT <= 0) {
      this.airT = 0.1;
      this.aircraft();
    }
    this.riverT -= dt;
    if (this.riverT <= 0) {
      this.riverT = 0.5;
      this.scanRiver();
    }
    this.ambT -= dt;
    if (this.ambT <= 0) {
      this.ambT = 0.25;
      this.ambience();
    }
  }

  private aircraft(): void {
    const a = this.audio;
    const cx = this.r.target.x;
    const cy = this.r.target.z;
    const K = ENGINE_SLOTS;
    let n = 0;
    for (const e of this.world.list) {
      if (e.dead || e.kind !== 'unit') continue;
      const d = unitDef(e.def);
      if (!d.air) continue;
      const vx = (e.x - e.px) * TICKS_PER_SEC;
      const vy = (e.y - e.py) * TICKS_PER_SEC;
      const moving = vx * vx + vy * vy > 1e-4;
      if (!moving && e.z < 0.1) continue; // parked
      if (!this.visible(e.x, e.y)) continue;
      const kind = engineKindFor(d.model, d.fixedWing, d.airlift);
      const sp = a.spatial(e.x, e.y, e.z);
      const score = sp.gain * (kind === 'fpv' ? 0.6 : 1);
      if (score < 0.03) continue;
      // jets: a flyby whoosh as they pass close to the view centre
      if (kind === 'jet') this.flyby(e.id, e.x, e.y, e.z, vx, vy, cx, cy);
      // keep the loudest few, sorted (insertion into a fixed array)
      let k: number;
      if (n < K) k = n++;
      else if (score > this.cands[K - 1].score) k = K - 1;
      else continue;
      const c = this.cands[k];
      c.id = e.id;
      c.kind = kind;
      c.x = e.x;
      c.y = e.y;
      c.z = e.z;
      c.vx = vx;
      c.vy = vy;
      c.score = score;
      while (k > 0 && this.cands[k - 1].score < this.cands[k].score) {
        const t = this.cands[k];
        this.cands[k] = this.cands[k - 1];
        this.cands[k - 1] = t;
        k--;
      }
    }
    const m = n;
    // keep aircraft in the slot they already have (no loop restarts), then fill free slots
    const taken = this.taken.fill(false);
    const placed = this.placed.fill(false);
    for (let i = 0; i < m; i++) {
      const s = this.slotId.indexOf(this.cands[i].id);
      if (s >= 0 && !taken[s]) {
        taken[s] = true;
        placed[i] = true;
        this.drive(s, this.cands[i], cx, cy);
      }
    }
    for (let i = 0; i < m; i++) {
      if (placed[i]) continue;
      const s = taken.indexOf(false);
      if (s < 0) break;
      taken[s] = true;
      this.slotId[s] = this.cands[i].id;
      this.drive(s, this.cands[i], cx, cy);
    }
    for (let s = 0; s < ENGINE_SLOTS; s++) {
      if (taken[s]) continue;
      if (this.slotId[s] !== -1) a.setEngine(s, -1, null, 0, 0, 0, 0, 1);
      this.slotId[s] = -1;
    }
    for (let i = 0; i < n; i++) this.cands[i].score = 0;
    if (this.flybyAt.size > 32) {
      for (const [id, t] of this.flybyAt) if (this.time - t > 10) this.flybyAt.delete(id);
    }
  }

  private drive(slot: number, c: Cand, cx: number, cy: number): void {
    const dx = c.x - cx;
    const dy = c.y - cy;
    const d = Math.hypot(dx, dy, c.z) || 1;
    // radial speed away from the view centre (+ = receding) -> doppler
    const vr = (dx * c.vx + dy * c.vy) / d;
    this.audio.setEngine(slot, c.id, c.kind, c.x, c.y, c.z, 1, doppler(vr));
  }

  private flyby(id: number, x: number, y: number, z: number, vx: number, vy: number, cx: number, cy: number): void {
    const v2 = vx * vx + vy * vy;
    if (v2 < 1) return;
    const dx = x - cx;
    const dy = y - cy;
    const tca = -(dx * vx + dy * vy) / v2;
    if (tca < 0.4 || tca > 1.3) return;
    const mx = dx + vx * tca;
    const my = dy + vy * tca;
    if (Math.hypot(mx, my) > this.halfW * 0.7) return;
    const last = this.flybyAt.get(id);
    if (last !== undefined && this.time - last < 5) return;
    this.flybyAt.set(id, this.time);
    const after = this.audio.spatial(cx + mx + vx * 1.6, cy + my + vy * 1.6, z).pan;
    this.audio.play('jetFlyby', 0.9, { x: cx + mx, y: cy + my, z }, after);
  }

  private scanRiver(): void {
    const m = this.world.map;
    const cx = this.r.target.x;
    const cy = this.r.target.z;
    const R = Math.max(5, Math.min(18, this.halfW * 0.9));
    let best = Infinity;
    let bx = 0;
    let by = 0;
    const x0 = Math.max(0, Math.floor(cx - R));
    const x1 = Math.min(m.w - 1, Math.ceil(cx + R));
    const y0 = Math.max(0, Math.floor(cy - R));
    const y1 = Math.min(m.h - 1, Math.ceil(cy + R));
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (m.tiles[ty * m.w + tx] !== TILE_WATER) continue;
        const d = Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy);
        if (d < best) {
          best = d;
          bx = tx + 0.5;
          by = ty + 0.5;
        }
      }
    }
    if (best > R) {
      this.river = 0;
      return;
    }
    const k = 1 - best / R;
    this.river = k * k;
    this.riverPan = this.audio.spatial(bx, by, 0).pan * 0.8;
  }

  private ambience(): void {
    const atm = this.r.atmos;
    const cfg = atm.cfg;
    const wx = atm.wx;
    const weather = cfg.weather;
    const wind = wx ? wx.wind : weather === 'sandstorm' ? 0.85 : weather === 'rain' ? 0.45 : weather === 'snow' ? 0.35 : 0.2;
    const rain = Math.max(0, Math.min(1, WX.wxRain.value));
    const storm = wx ? wx.storm : weather === 'rain' ? 0.3 : 0;
    const dust = wx ? (wx.fall === 'sandstorm' ? wx.precip : 0) : weather === 'sandstorm' ? 1 : 0;
    const snow = wx ? (wx.fall === 'snow' ? wx.precip : 0) : weather === 'snow' ? 1 : 0;
    this.audio.setAmbience({
      on: true,
      wind,
      rain,
      storm,
      dust,
      snow,
      night: nightAmount(cfg.tod, atm.phase),
      river: this.river,
      riverPan: this.riverPan,
      zoom: this.r.zoom,
    });
  }

  dispose(): void {
    this.audio.quietScene();
  }
}
