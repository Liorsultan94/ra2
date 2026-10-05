import * as THREE from 'three';
import { Tile, standHeight, type Biome, type GameMap } from '../sim/map';
import type { Effects } from './effects';
import type { FogOfWar } from './fog';
import { ScarDecals, ScarKind } from './scarsdecal';
import { Piece, ScarHulks, ScarPieces, type Hulk } from './scarsmesh';

/*
 * The battlefield remembers the battle (render only, not deterministic).
 *
 *  - Craters (scarsdecal.ts) persist: scorched centre, raised rim, ejecta
 *    rays and 3D clods / rocks thrown onto the apron. Puddles of muddy water
 *    stand in them when the ground is wet; in winter snow drifts back into
 *    them over a couple of minutes. On a paved road a shell leaves a pothole
 *    in a web of cracks (some sealed with tar), sometimes next to an old tar
 *    patch.
 *  - Scorched earth around big blasts and fires, with smoke wisps that thin
 *    out over a minute or two.
 *  - Ruins: a destroyed building (military or village) leaves a rubble heap
 *    with broken wall stubs, floor slabs, exposed rebar or charred beams on a
 *    dusty footprint, smoke and now and then a small fire that smoulders for
 *    minutes (bright at night).
 *  - Hulks: burnt-out vehicles stay where they died, charred black and
 *    rusting over the next minutes, smoking for a while.
 *
 * Budget: decals live in a ring buffer that bakes the evicted ones into a
 * persistent map-wide layer; pieces and hulks have instance / vertex caps
 * and leave a baked ground splat when evicted. Everything is drawn with 4
 * draw calls (+2 shadow casters): live decals, baked layer, pieces, hulks.
 */

interface Emitter {
  x: number;
  y: number;
  z: number;
  t: number;
  dur: number;
  rate: number;
  size: number;
  /** 0 smoke wisps, 1 dark wreck smoke, 2 small lingering fire. */
  kind: number;
}

export interface RuinOpts {
  /** Village / civilian house: timber beams instead of rebar and slabs. */
  civil?: boolean;
  /** Building model to take the wall colours from. */
  root?: THREE.Object3D;
  colors?: number[];
  /** Pieces rise out of the ground over this many seconds (the collapse rubble sinks into them). */
  rise?: number;
  /** A flat structure (the airbase's runway and stands): a cratered, scorched slab with scattered debris, no walls. */
  flat?: boolean;
}

const CLOD: Record<Biome, number[]> = {
  temperate: [0x4a3a2a, 0x5a4632, 0x3a2e22, 0x6a6258],
  desert: [0x9a7a52, 0xb08a5c, 0x7a6244, 0x8a8478],
  winter: [0x3e352c, 0x4a4036, 0x2e2822, 0x6a6a6a],
  urban: [0x5a5048, 0x6a6258, 0x46403a, 0x7a766e],
};
const CONCRETE = [0x8e8a82, 0x7a766e, 0x67635c, 0x9a958a];
const BRICK = [0x8a5a44, 0x7a4c3a, 0x9a6a50];
const BURNT = [0x2a2522, 0x1e1a17, 0x3a332c];
const REBAR = [0x6a3a22, 0x55301c, 0x7a4a2a];
const BEAM = [0x1d1814, 0x2a221b, 0x16120f];

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _c = new THREE.Color();
const _c2 = new THREE.Color();

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

export interface ScarsHost {
  map: GameMap;
  fog: FogOfWar;
  effects: Effects;
  quality: 'low' | 'medium' | 'high';
  /** Fog-of-war visibility for the local player (emitters only run where they can be seen). */
  visibleAt: (x: number, z: number) => boolean;
  /** Paved road under (x, z) (potholes instead of craters). */
  isPaved?: (x: number, z: number) => boolean;
  /** A standing building covers (x, z): it takes the hit itself, the ground under it keeps no crater / clods. */
  occupied?: (x: number, z: number) => boolean;
}

export class BattleScars {
  readonly group = new THREE.Group();
  readonly decals: ScarDecals;
  readonly pieces: ScarPieces;
  readonly hulks: ScarHulks;
  private emitters: Emitter[] = [];
  private maxEmitters: number;
  private maxFires: number;
  private map: GameMap;
  private effects: Effects;
  private clod: number[];
  time = 0;
  /** Seconds for a hulk to rust over completely. */
  rustTime = 240;

  constructor(private host: ScarsHost) {
    this.map = host.map;
    this.effects = host.effects;
    const q = host.quality;
    this.decals = new ScarDecals(host.map, host.fog, q);
    this.pieces = new ScarPieces(host.fog, q);
    this.hulks = new ScarHulks(host.fog, q);
    this.maxEmitters = q === 'low' ? 8 : q === 'medium' ? 16 : 28;
    this.maxFires = q === 'low' ? 2 : q === 'medium' ? 4 : 7;
    this.clod = CLOD[host.map.biome] ?? CLOD.temperate;
    this.group.name = 'scars';
    this.group.add(this.decals.group, this.pieces.mesh, this.hulks.mesh);
  }

  private ground(x: number, z: number) {
    const m = this.map;
    return standHeight(m, Math.max(0, Math.min(m.w - 0.01, x)), Math.max(0, Math.min(m.h - 0.01, z)));
  }

  private tile(x: number, z: number) {
    const m = this.map;
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 0 || tz < 0 || tx >= m.w || tz >= m.h) return Tile.Rock;
    return m.tiles[tz * m.w + tx];
  }

  // ------------------------------------------------------------ ground scars

  /** A blast crater of radius ~r (same signature as GroundMarks.craterAt). */
  craterAt(x: number, z: number, r: number) {
    const t = this.tile(x, z);
    if (t === Tile.Water || t === Tile.Bridge || this.host.occupied?.(x, z)) return;
    const ang = Math.random() * Math.PI * 2;
    if (this.host.isPaved?.(x, z)) {
      // a pothole in a web of cracks; now and then next to an older tar patch
      const s = r * 2.6 + 0.25;
      this.decals.add(ScarKind.Pothole, x, z, ang, s, s, 0.06 + r * 0.08, 0.6);
      if (Math.random() < 0.35) {
        const a = Math.random() * Math.PI * 2;
        this.decals.add(ScarKind.Patch, x + Math.cos(a) * s * 0.45, z + Math.sin(a) * s * 0.45, ang + rnd(-0.3, 0.3), s * rnd(0.7, 1.1), s * rnd(0.5, 0.8), 0.03);
      }
      this.throwClods(x, z, r * 0.7, Math.round(2 + r * 5), [0x3a3a3a, 0x2c2c2c, 0x6a665e]);
      return;
    }
    const s = r * 3.2 + 0.2;
    this.decals.add(Math.random() < 0.5 ? ScarKind.CraterA : ScarKind.CraterB, x, z, ang, s, s * rnd(0.9, 1.1), 0.08 + r * 0.16, r >= 0.45 ? 1 : 0.5);
    if (r >= 0.4) this.throwClods(x, z, r, Math.min(18, Math.round(3 + r * 11)), this.clod);
  }

  /** Burnt ground of radius ~r (same signature as GroundMarks.scorchAt): big ones smoke for a while. */
  scorchAt(x: number, z: number, r: number) {
    const t = this.tile(x, z);
    if (t === Tile.Water || this.host.occupied?.(x, z)) return;
    const s = r * 2.5;
    this.decals.add(Math.random() < 0.5 ? ScarKind.ScorchA : ScarKind.ScorchB, x, z, Math.random() * Math.PI * 2, s, s * rnd(0.85, 1.15), 0, 0.7);
    if (r >= 0.45) this.emit({ x, y: this.ground(x, z) + 0.05, z, t: 0, dur: 30 + r * 40, rate: 0.5 + r * 0.6, size: Math.min(1.2, 0.4 + r * 0.4), kind: 0 });
  }

  private throwClods(x: number, z: number, r: number, n: number, pal: number[]) {
    const g = this.pieces.begin(n, x, z, r * 1.6, () => this.decals.bake(ScarKind.Clods, x, z, Math.random() * 6.28, r * 3, r * 3, 0.8));
    if (!g) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = r * (0.7 + Math.pow(Math.random(), 1.5) * 1.1);
      const px = x + Math.cos(a) * d;
      const pz = z + Math.sin(a) * d;
      if (this.tile(px, pz) === Tile.Water || this.host.occupied?.(px, pz)) continue;
      const sz = rnd(0.035, 0.085) * (0.8 + r * 0.6);
      _e.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      _q.setFromEuler(_e);
      _m.compose(_p.set(px, this.ground(px, pz) + sz * 0.12, pz), _q, _s.set(sz * rnd(0.8, 1.4), sz * rnd(0.6, 1.1), sz * rnd(0.8, 1.4)));
      this.pieces.add(g, i % 3 ? Piece.Rock : Piece.Rock2, _m, pick(pal));
    }
  }

  // ------------------------------------------------------------------ ruins

  /** The ruin of a destroyed building centred at (x, z) with a w x d tile footprint. */
  ruin(x: number, z: number, w: number, d: number, opts: RuinOpts = {}) {
    if (opts.flat) return this.flatRuin(x, z, w, d, opts.rise);
    const civil = !!opts.civil;
    const gy = this.ground(x, z);
    const pal = opts.colors?.length ? opts.colors : opts.root ? sampleColors(opts.root) : [];
    const walls = pal.length ? pal : civil ? BRICK : CONCRETE;
    // footprint: dust, soil and char, plus a wider scorch
    this.decals.add(ScarKind.RuinPad, x, z, 0, w + 0.9, d + 0.9, 0.1);
    this.decals.add(ScarKind.ScorchA, x, z, Math.random() * 6.28, Math.max(w, d) * 1.9, Math.max(w, d) * 1.9, 0, 0.3);
    const area = w * d;
    const nRub = Math.max(12, Math.min(44, Math.round(area * 9)));
    const nWall = 2 + Math.round(Math.random() * 2) + (area >= 6 ? 1 : 0);
    const n = nRub + nWall * (civil ? 1 : 4) + 10;
    const g = this.pieces.begin(n, x, z, Math.max(w, d), () => {
      this.decals.bake(ScarKind.RuinPad, x, z, 0, w + 0.9, d + 0.9);
      this.decals.bake(ScarKind.Clods, x, z, Math.random() * 6.28, w * 1.1, d * 1.1);
    });
    if (!g) return;
    const drops: number[] = [];
    const hmax = 0.1 + 0.09 * Math.min(w, d) + (civil ? 0 : 0.05);
    const heap = (px: number, pz: number) => {
      const u = Math.abs(px - x) / (w * 0.5);
      const v = Math.abs(pz - z) / (d * 0.5);
      return Math.max(0, 1 - Math.pow(Math.max(u, v), 2)) * hmax;
    };
    // rubble heap
    for (let i = 0; i < nRub; i++) {
      const px = x + (Math.random() - 0.5) * (w - 0.15);
      const pz = z + (Math.random() - 0.5) * (d - 0.15);
      const sz = rnd(0.08, 0.27) * (civil ? 0.85 : 1);
      const h = heap(px, pz);
      _e.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      _q.setFromEuler(_e);
      _m.compose(_p.set(px, this.ground(px, pz) + h * rnd(0.5, 1) + sz * 0.15, pz), _q, _s.set(sz * rnd(0.8, 1.5), sz * rnd(0.5, 0.9), sz * rnd(0.8, 1.5)));
      const c = Math.random();
      const col = c < 0.22 ? pick(BURNT) : c < 0.55 ? pick(walls) : pick(civil ? BRICK : CONCRETE);
      this.pieces.add(g, i % 2 ? Piece.Rock : Piece.Rock2, _m, col);
      drops.push(sz + h + 0.05);
    }
    // broken wall stubs along the footprint edges, exposed rebar on top (military) / charred beams (village)
    for (let k = 0; k < nWall; k++) {
      const edge = Math.floor(Math.random() * 4);
      const alongX = edge < 2;
      const len = (alongX ? w : d) * rnd(0.25, 0.6);
      const tpos = rnd(-0.32, 0.32) * (alongX ? w : d);
      const off = ((alongX ? d : w) * 0.5 - 0.12) * (edge % 2 ? 1 : -1);
      const px = alongX ? x + tpos : x + off;
      const pz = alongX ? z + off : z + tpos;
      const H = civil ? rnd(0.18, 0.5) : rnd(0.25, 0.75);
      const yaw = (alongX ? 0 : Math.PI / 2) + rnd(-0.12, 0.12);
      _e.set(rnd(-0.12, 0.12), yaw, rnd(-0.06, 0.06), 'YXZ');
      _q.setFromEuler(_e);
      const wy = this.ground(px, pz) - 0.02;
      _m.compose(_p.set(px, wy, pz), _q, _s.set(len, H, civil ? 1.3 : 1));
      _c.setHex(pick(walls)).multiplyScalar(rnd(0.45, 0.9));
      this.pieces.add(g, Piece.Wall, _m, _c);
      drops.push(H + 0.05);
      if (!civil) {
        const nb = 2 + Math.floor(Math.random() * 3);
        for (let b = 0; b < nb; b++) {
          const lx = rnd(-0.4, 0.4) * len;
          _p.set(lx, H * rnd(0.45, 0.85), 0).applyEuler(_e).add(_s.set(px, wy, pz));
          _e.set(rnd(-0.5, 0.5), Math.random() * 6.28, rnd(-0.5, 0.5));
          _q.setFromEuler(_e);
          _m.compose(_p, _q, _s.set(1, rnd(0.22, 0.42), 1));
          this.pieces.add(g, Piece.Rebar, _m, pick(REBAR));
          drops.push(H + 0.4);
          _e.set(rnd(-0.12, 0.12), yaw, rnd(-0.06, 0.06), 'YXZ');
        }
      }
    }
    // floor slabs leaning on the heap (military) / charred roof beams across it (village)
    const nExtra = civil ? 3 + Math.floor(Math.random() * 4) : 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < nExtra; i++) {
      const px = x + (Math.random() - 0.5) * w * 0.6;
      const pz = z + (Math.random() - 0.5) * d * 0.6;
      const h = heap(px, pz);
      if (civil) {
        _e.set(rnd(-0.15, 0.15), Math.random() * 6.28, rnd(-0.45, 0.45));
        _q.setFromEuler(_e);
        _m.compose(_p.set(px, this.ground(px, pz) + h * 0.8 + 0.05, pz), _q, _s.set(rnd(0.5, 1.2) * Math.min(w, d), 1, 1));
        this.pieces.add(g, Piece.Beam, _m, pick(BEAM));
        drops.push(h + 0.3);
      } else {
        const sz = rnd(0.35, 0.7) * Math.min(w, d) * 0.6;
        _e.set(rnd(-0.6, 0.6), Math.random() * 6.28, rnd(-0.5, 0.5));
        _q.setFromEuler(_e);
        _m.compose(_p.set(px, this.ground(px, pz) + h + 0.04, pz), _q, _s.set(sz, 1, sz * rnd(0.6, 1)));
        _c.setHex(pick(CONCRETE)).multiplyScalar(rnd(0.6, 0.95));
        this.pieces.add(g, Piece.Slab, _m, _c);
        drops.push(h + 0.4);
        // rebar sticking out of the broken slab
        for (let b = 0; b < 2; b++) {
          _e.set(rnd(-0.7, 0.7), Math.random() * 6.28, rnd(-0.7, 0.7));
          _q.setFromEuler(_e);
          _m.compose(_s.set(px + rnd(-0.2, 0.2) * sz, this.ground(px, pz) + h + 0.06, pz + rnd(-0.2, 0.2) * sz), _q, _p.set(1, rnd(0.18, 0.32), 1));
          this.pieces.add(g, Piece.Rebar, _m, pick(REBAR));
          drops.push(0.4 + h);
        }
      }
    }
    if (opts.rise) this.pieces.rise(g, opts.rise, (i) => drops[i] ?? 0.3);
    // dust settling, smoke wisps, maybe a small fire that smoulders on
    const fx = this.effects;
    for (let i = 0; i < 6; i++) fx.dust(x + (Math.random() - 0.5) * w, gy + 0.05, z + (Math.random() - 0.5) * d, 1.6 + Math.random());
    this.emit({ x, y: gy + hmax, z, t: 0, dur: 90 + area * 10, rate: 1 + area * 0.15, size: 0.9, kind: 0 });
    const fires = Math.random() < (civil ? 0.75 : 0.6) ? (area >= 6 && Math.random() < 0.5 ? 2 : 1) : 0;
    for (let i = 0; i < fires; i++) {
      const px = x + (Math.random() - 0.5) * w * 0.6;
      const pz = z + (Math.random() - 0.5) * d * 0.6;
      this.emit({ x: px, y: this.ground(px, pz) + heap(px, pz) * 0.8, z: pz, t: 0, dur: rnd(150, 420), rate: 1, size: rnd(0.55, 0.85), kind: 2 });
    }
  }

  /**
   * A building goes up on the tiles x0..x1, z0..z1: ruins, hulks and fresh craters there make way (pieces
   * bake their ground splat, hulks sink away), so nothing of an old battle pokes through the new building.
   */
  clearArea(x0: number, z0: number, x1: number, z1: number) {
    this.pieces.clearArea(x0, z0, x1, z1);
    this.hulks.clearArea(x0, z0, x1, z1);
    this.decals.clearArea(x0, z0, x1, z1);
    this.emitters = this.emitters.filter((e) => e.x < x0 || e.x > x1 || e.z < z0 || e.z > z1);
  }

  /** A flat structure's remains: the slab stays, cratered and burnt, with concrete chunks and twisted bits scattered over it. */
  private flatRuin(x: number, z: number, w: number, d: number, rise?: number) {
    const gy = this.ground(x, z);
    this.decals.add(ScarKind.ScorchA, x, z, Math.random() * 6.28, Math.max(w, d) * 1.1, Math.min(w, d) * 1.4, 0, 0.4);
    const holes = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < holes; i++) {
      const px = x + (Math.random() - 0.5) * (w - 1);
      const pz = z + (Math.random() - 0.5) * (d - 1);
      const s = rnd(0.9, 1.6);
      this.decals.add(ScarKind.Pothole, px, pz, Math.random() * 6.28, s, s, 0.1, 0.8);
    }
    const n = Math.min(40, Math.round(w * d * 1.2));
    const g = this.pieces.begin(n, x, z, Math.max(w, d), () => this.decals.bake(ScarKind.Clods, x, z, Math.random() * 6.28, w * 0.9, d * 0.9, 0.6));
    if (!g) return;
    const drops: number[] = [];
    for (let i = 0; i < n; i++) {
      const px = x + (Math.random() - 0.5) * w * 0.95;
      const pz = z + (Math.random() - 0.5) * d * 0.95;
      const sz = rnd(0.05, 0.16);
      _e.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      _q.setFromEuler(_e);
      const slab = i % 5 === 0;
      _m.compose(_p.set(px, this.ground(px, pz) + sz * 0.1, pz), _q, slab ? _s.set(sz * 1.6, 1, sz * 1.2) : _s.set(sz * rnd(0.8, 1.5), sz * rnd(0.4, 0.8), sz * rnd(0.8, 1.5)));
      this.pieces.add(g, slab ? Piece.Slab : i % 2 ? Piece.Rock : Piece.Rock2, _m, Math.random() < 0.3 ? pick(BURNT) : pick(CONCRETE));
      drops.push(sz + 0.05);
    }
    if (rise) this.pieces.rise(g, rise, (i) => drops[i] ?? 0.2);
    this.emit({ x, y: gy + 0.1, z, t: 0, dur: 80, rate: 1.2, size: 0.9, kind: 0 });
    if (Math.random() < 0.6) this.emit({ x: x + rnd(-1, 1), y: gy + 0.1, z: z + rnd(-0.5, 0.5), t: 0, dur: rnd(120, 300), rate: 1, size: 0.7, kind: 2 });
  }

  // ------------------------------------------------------------------ hulks

  /**
   * Keep a burnt-out vehicle (its model root plus a turret blown off it) as a permanent hulk.
   * Returns false when it does not fit the budget: the caller lets it sink away as before.
   */
  adoptHulk(roots: THREE.Object3D[], x: number, y: number, z: number, size: number, heavy: boolean): boolean {
    const h = this.hulks.adopt(roots, x, y, z, size, this.time, (o) => this.hulkGone(o));
    if (!h) return false;
    this.emit({ x, y: y + 0.3 * size, z, t: 0, dur: rnd(60, 110), rate: 1.6, size: 0.65 * size, kind: 1 });
    if (heavy && Math.random() < 0.45) this.emit({ x, y: y + 0.25, z, t: 0, dur: rnd(25, 60), rate: 1, size: 0.45 * size, kind: 2 });
    return true;
  }

  private hulkGone(h: Hulk) {
    // the ground keeps the burnt patch and some scattered bits
    this.decals.bake(ScarKind.ScorchB, h.x, h.z, Math.random() * 6.28, h.size * 1.6, h.size * 1.6);
    this.decals.bake(ScarKind.Clods, h.x, h.z, Math.random() * 6.28, h.size * 1.2, h.size * 1.2, 0.7);
  }

  // ---------------------------------------------------------------- emitters

  private emit(e: Emitter) {
    if (e.kind === 2) {
      const fires = this.emitters.filter((o) => o.kind === 2);
      if (fires.length >= this.maxFires) this.emitters.splice(this.emitters.indexOf(fires[0]), 1);
    }
    if (this.emitters.length >= this.maxEmitters) {
      // drop the weakest (oldest relative to its life)
      let wi = 0;
      let wk = -1;
      this.emitters.forEach((o, i) => {
        const k = o.t / o.dur;
        if (k > wk) {
          wk = k;
          wi = i;
        }
      });
      this.emitters.splice(wi, 1);
    }
    this.emitters.push(e);
  }

  update(dt: number, renderer: THREE.WebGLRenderer) {
    this.time += dt;
    this.decals.update(dt);
    this.decals.flush(renderer);
    if (dt <= 0) return;
    this.pieces.update(dt);
    this.hulks.update(this.time, dt, this.rustTime, (h) => this.hulkGone(h));
    const fx = this.effects;
    const rate = fx.rate;
    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const E = this.emitters[i];
      E.t += dt;
      if (E.t >= E.dur) {
        this.emitters.splice(i, 1);
        continue;
      }
      if (!this.host.visibleAt(E.x, E.z)) continue;
      const k = 1 - E.t / E.dur;
      const j = () => (Math.random() - 0.5) * 0.3 * E.size;
      if (E.kind === 0) {
        // thin wisps, fading with time
        if (Math.random() < dt * E.rate * k * rate) fx.smoke(E.x + j(), E.y, E.z + j(), E.size * (0.35 + 0.35 * k), Math.random() < 0.35);
      } else if (E.kind === 1) {
        if (Math.random() < dt * E.rate * (0.3 + 0.7 * k) * rate) fx.smoke(E.x + j(), E.y, E.z + j(), E.size * (0.5 + 0.5 * k), true);
      } else {
        // small lingering fire: flickering flames, a little smoke, a warm light (bright at night)
        const kk = Math.min(1, k * 4);
        if (Math.random() < dt * 5 * rate * kk) fx.flame(E.x + j(), E.y, E.z + j(), E.size * (0.6 + 0.4 * kk));
        if (Math.random() < dt * 0.9 * rate) fx.smoke(E.x, E.y + 0.25, E.z, E.size * 0.8, true);
        fx.burnGlow(E.x, E.y + 0.2, E.z, 1.1 * E.size * kk);
      }
    }
  }

  /** Counters for the HUD / benchmarks. */
  stats() {
    return {
      liveDecals: this.decals.liveCount,
      decalsAdded: this.decals.added,
      baked: this.decals.baked,
      bakedCells: this.decals.cells,
      pieces: this.pieces.count,
      hulks: this.hulks.hulks.length,
      hulkVerts: this.hulks.vertsUsed,
      emitters: this.emitters.length,
      fires: this.emitters.filter((e) => e.kind === 2).length,
    };
  }

  dispose() {
    this.decals.dispose();
    this.pieces.mesh.dispose();
    this.hulks.mesh.dispose();
  }
}

/** The two or three dominant wall colours of a building model (by vertex count), darkened for the ruin. */
function sampleColors(root: THREE.Object3D): number[] {
  const acc = new Map<number, number>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = m.material as THREE.MeshStandardMaterial;
    if (!mat || Array.isArray(mat) || !mat.color || mat.transparent) return;
    const c = mat.color;
    const l = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
    if (l < 0.05 || l > 0.95) return;
    const hex = c.getHex();
    acc.set(hex, (acc.get(hex) ?? 0) + (m.geometry?.getAttribute('position')?.count ?? 0));
  });
  const top = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  return top.map(([h]) => _c2.setHex(h).lerp(_c.setHex(0x8e8a82), 0.35).getHex());
}
