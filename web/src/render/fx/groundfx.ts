import { Tile, type GameMap } from '../../sim/map';
import { WX } from '../wxuniforms';
import type { ParticleOpts } from './gpuparticles';

/*
 * Surface-aware ground effects: what vehicles, muzzle blasts and rotor wash
 * kick up depends on the ground under them and on the weather.
 *  - dry dirt / ore / sand: billowing tan / brown dust that lingers and drifts
 *    downwind (heavier and faster vehicles raise more, wheels more than tracks);
 *  - paved roads / rock: next to nothing (a light haze at speed; road spray in rain);
 *  - grass: bits of turf and a faint dust;
 *  - rain on soft ground: mud clods flung off the tracks and dark wet spray;
 *  - snow: powdery plumes.
 * Continuous emitters draw from a per-second token bucket (scaled by quality
 * and the adaptive effects budget) so a big armoured push can never flood the
 * particle buffers or the phone's fill rate.
 */

export const enum Surf {
  Dirt = 0,
  Sand = 1,
  Ore = 2,
  Grass = 3,
  Paved = 4,
  Rock = 5,
  Water = 6,
  Mud = 7,
  Snow = 8,
}

/** Dust colours (start, end) per dry surface. */
const DUST: Record<number, [number, number]> = {
  [Surf.Dirt]: [0x8e7656, 0xb4a07e],
  [Surf.Sand]: [0xc0a170, 0xd8c49a],
  [Surf.Ore]: [0x8a6448, 0xae8c6a],
  [Surf.Grass]: [0x8a8060, 0xa8a084],
  [Surf.Paved]: [0x8c8880, 0xaaa69e],
  [Surf.Rock]: [0x8c8880, 0xaaa69e],
};

/** Snow cover reaches full this many seconds into a snow battle (see WX.wxSnowThin). */
const SNOW_ACCUM_S = 240;

export interface GroundFxSink {
  smoke(o: ParticleOpts): void;
  map(): GameMap | null;
  paved(x: number, z: number): boolean;
  groundAt(x: number, z: number): number;
  /** Quality x adaptive budget (0.25 .. 1). */
  rate(): number;
}

export class GroundFx {
  private tokens = 0;
  private perSec: number;
  /** Reused spawn record: GpuParticles.spawn copies it into its buffer. */
  private o: ParticleOpts = { x: 0, y: 0, z: 0, life: 1, size: 0.1, color: 0 };
  /** Particles spawned by this module since the last stats() read (perf checks). */
  spawned = 0;

  constructor(
    private sink: GroundFxSink,
    quality: 'low' | 'medium' | 'high',
  ) {
    this.perSec = quality === 'low' ? 140 : quality === 'medium' ? 340 : 560;
    // a new battle in the snow starts patchy and fills in
    WX.wxSnowThin.value = 1;
  }

  /** Ground surface under (x, z), weather included. */
  surface(x: number, z: number): Surf {
    const m = this.sink.map();
    if (!m) return Surf.Dirt;
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 0 || tz < 0 || tx >= m.w || tz >= m.h) return Surf.Grass;
    const i = tz * m.w + tx;
    const t = m.tiles[i];
    if (t === Tile.Water) return Surf.Water;
    if (t === Tile.Bridge) return Surf.Paved;
    if (WX.wxSnow.value > 0.3) return Surf.Snow;
    if (this.sink.paved(x, z)) return Surf.Paved;
    if (t === Tile.Rock) return Surf.Rock;
    const wet = WX.wxWet.value > 0.3;
    if (m.ore[i] > 0) return wet ? Surf.Mud : Surf.Ore;
    if (t === Tile.Dirt || t === Tile.Sand) return wet ? Surf.Mud : t === Tile.Sand ? Surf.Sand : Surf.Dirt;
    return Surf.Grass;
  }

  private take(n: number) {
    const k = Math.min(n, Math.floor(this.tokens));
    this.tokens -= k;
    return k;
  }

  private emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, sizeEnd: number, color: number, colorEnd: number, alpha: number, drag: number, gravity: number, wind: number) {
    const o = this.o;
    o.x = x;
    o.y = y;
    o.z = z;
    o.vx = vx;
    o.vy = vy;
    o.vz = vz;
    o.life = life;
    o.size = size;
    o.sizeEnd = sizeEnd;
    o.color = color;
    o.colorEnd = colorEnd;
    o.alpha = alpha;
    o.drag = drag;
    o.gravity = gravity;
    o.wind = wind;
    o.glow = 0;
    this.sink.smoke(o);
    this.spawned++;
  }

  /**
   * One print segment of a moving ground vehicle (called every ~0.13 tiles
   * travelled): dust / mud / snow behind both tracks.
   * (x, z) hull centre, (fx, fz) forward, speed tiles/s, gauge half track
   * spacing, len / wid hull size (tiles).
   */
  vehicle(x: number, z: number, fx: number, fz: number, speed: number, gauge: number, wheeled: boolean, len: number, wid: number) {
    const s = this.surface(x, z);
    if (s === Surf.Water) return;
    const weight = Math.max(0.6, Math.min(1.7, Math.sqrt(len * wid) / 0.7));
    const sp = Math.max(0, Math.min(1.6, speed / 1.8));
    const rate = this.sink.rate();
    const rx = x - fx * len * 0.45;
    const rz = z - fz * len * 0.45;
    const px = -fz;
    const pz = fx;
    const g = this.sink.groundAt(rx, rz);
    const rnd = Math.random;
    const dusty = WX.wxDust.value > 0.3 ? 1.35 : 1;
    switch (s) {
      case Surf.Dirt:
      case Surf.Sand:
      case Surf.Ore: {
        // billowing cloud, both tracks; wheels on dirt roads throw more
        const k = (wheeled ? 1.35 : 1) * dusty;
        const want = (0.35 + 0.9 * sp) * weight * k * rate;
        const n = this.take(Math.floor(want + rnd()));
        const [c0, c1] = DUST[s];
        for (let i = 0; i < n; i++) {
          const side = i % 2 ? 1 : -1;
          const ox = rx + px * gauge * side + (rnd() - 0.5) * 0.1;
          const oz = rz + pz * gauge * side + (rnd() - 0.5) * 0.1;
          const big = (0.55 + 0.45 * sp) * weight * k;
          this.emit(ox, g + 0.06, oz, -fx * sp * 0.5 + px * side * 0.25 + (rnd() - 0.5) * 0.3, 0.2 + rnd() * 0.45 * (0.5 + sp), -fz * sp * 0.5 + pz * side * 0.25 + (rnd() - 0.5) * 0.3, 2.2 + rnd() * 1.8 * big, 0.14 * big, (0.75 + rnd() * 0.5) * big, c0, c1, 0.3 + 0.1 * Math.min(1, sp), 1.1, -0.04, 0.75);
        }
        break;
      }
      case Surf.Paved:
      case Surf.Rock: {
        if (WX.wxWet.value > 0.3) {
          // road spray off the tyres / tracks in the rain
          if (sp < 0.4) break;
          const n = this.take(Math.floor(0.5 * sp * weight * rate + rnd()));
          for (let i = 0; i < n; i++) {
            const side = i % 2 ? 1 : -1;
            this.emit(rx + px * gauge * side, g + 0.05, rz + pz * gauge * side, -fx * 0.4 + px * side * 0.35, 0.3 + rnd() * 0.3, -fz * 0.4 + pz * side * 0.35, 0.5 + rnd() * 0.4, 0.06, 0.35 * weight, 0x8c949c, 0xb4bcc4, 0.28, 2, 0.3, 0.3);
          }
          break;
        }
        // a light haze only at speed
        if (sp < 0.6 || rnd() > 0.35 * rate) break;
        if (this.take(1)) this.emit(rx + (rnd() - 0.5) * gauge, g + 0.05, rz + (rnd() - 0.5) * gauge, (rnd() - 0.5) * 0.2, 0.15, (rnd() - 0.5) * 0.2, 1.4, 0.12 * weight, 0.55 * weight, DUST[s][0], DUST[s][1], 0.1 * dusty, 1.4, -0.02, 0.6);
        break;
      }
      case Surf.Grass: {
        // torn turf bits flicked off the tracks, a faint dust
        const n = this.take(Math.floor((0.5 + 0.7 * sp) * weight * rate + rnd()));
        for (let i = 0; i < n; i++) {
          const side = rnd() < 0.5 ? 1 : -1;
          const up = 1.2 + rnd() * 1.4 * (0.5 + sp);
          this.emit(rx + px * gauge * side, g + 0.06, rz + pz * gauge * side, -fx * (0.4 + rnd() * 0.6) + (rnd() - 0.5) * 0.6, up, -fz * (0.4 + rnd() * 0.6) + (rnd() - 0.5) * 0.6, 0.45 + rnd() * 0.35, 0.035 + rnd() * 0.025, 0.03, rnd() < 0.6 ? 0x4c5a26 : 0x5a4a30, 0x46502a, 0.95, 0.5, 7, 0);
        }
        if (sp > 0.35 && rnd() < 0.5 * rate && this.take(1)) this.emit(rx, g + 0.05, rz, (rnd() - 0.5) * 0.3, 0.2, (rnd() - 0.5) * 0.3, 1.6, 0.14 * weight, 0.6 * weight, DUST[Surf.Grass][0], DUST[Surf.Grass][1], 0.12 * dusty, 1.3, -0.02, 0.6);
        break;
      }
      case Surf.Mud: {
        // clods flung up and back off the top run of the tracks, dark wet spray
        const n = this.take(Math.floor((0.5 + 1.1 * sp) * weight * (wheeled ? 1.2 : 1) * rate + rnd()));
        for (let i = 0; i < n; i++) {
          const side = rnd() < 0.5 ? 1 : -1;
          const back = 0.6 + rnd() * 1.2 * (0.4 + sp);
          this.emit(rx + px * gauge * side, g + 0.14, rz + pz * gauge * side, -fx * back + px * side * (rnd() - 0.3) * 0.5, 1 + rnd() * 1.8 * (0.5 + sp), -fz * back + pz * side * (rnd() - 0.3) * 0.5, 0.5 + rnd() * 0.4, 0.04 + rnd() * 0.035, 0.035, 0x2e2216, 0x3a2c1c, 0.95, 0.4, 8, 0);
        }
        if (sp > 0.3 && rnd() < 0.6 * rate && this.take(1)) {
          const side = rnd() < 0.5 ? 1 : -1;
          this.emit(rx + px * gauge * side, g + 0.06, rz + pz * gauge * side, -fx * 0.3, 0.35, -fz * 0.3, 0.7, 0.08 * weight, 0.4 * weight, 0x4a4036, 0x6a6258, 0.3, 2, 0.4, 0.2);
        }
        break;
      }
      case Surf.Snow: {
        // powdery rooster tail behind the tracks / tyres
        const want = (0.3 + 1.0 * sp) * weight * (wheeled ? 1.3 : 1) * rate;
        const n = this.take(Math.floor(want + rnd()));
        for (let i = 0; i < n; i++) {
          const side = i % 2 ? 1 : -1;
          const big = (0.5 + 0.5 * sp) * weight;
          this.emit(rx + px * gauge * side, g + 0.06, rz + pz * gauge * side, -fx * (0.3 + sp * 0.6) + (rnd() - 0.5) * 0.4, 0.4 + rnd() * 0.7 * (0.5 + sp), -fz * (0.3 + sp * 0.6) + (rnd() - 0.5) * 0.4, 1.3 + rnd() * 1.1, 0.12 * big, (0.6 + rnd() * 0.4) * big, 0xe6ecf4, 0xf4f7fb, 0.42, 1.6, 0.12, 0.8);
        }
        // a few heavier clumps
        if (sp > 0.4 && rnd() < 0.5 * rate && this.take(1)) this.emit(rx, g + 0.12, rz, -fx * 1.2 + (rnd() - 0.5) * 0.6, 1.4 + rnd(), -fz * 1.2 + (rnd() - 0.5) * 0.6, 0.6, 0.05, 0.04, 0xf4f8fc, 0xe8eef6, 0.95, 0.3, 7, 0);
        break;
      }
    }
  }

  /**
   * Muzzle blast on the ground under / in front of a gun at (x, y, z) firing
   * along (dx, dz). c: calibre scale (autocannon ~0.55, MBT 1.3, howitzer 1.7).
   */
  muzzleBlast(x: number, z: number, dx: number, dz: number, c: number, onBlast: (x: number, z: number, r: number) => void) {
    const s = this.surface(x, z);
    const g = this.sink.groundAt(x, z);
    const rate = this.sink.rate();
    const rnd = Math.random;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl;
    dz /= dl;
    const cx = x + dx * 0.35 * c;
    const cz = z + dz * 0.35 * c;
    // one-shot: not rationed by the bucket (it is bounded per shot), but it does refill it less
    const n = Math.max(3, Math.round(Math.pow(c, 1.4) * 9 * rate));
    this.tokens -= n * 0.5;
    let c0: number;
    let c1: number;
    let alpha = 0.5;
    if (s === Surf.Water) {
      c0 = 0xdfe8ee;
      c1 = 0xf0f4f6;
      alpha = 0.45;
    } else if (s === Surf.Snow) {
      c0 = 0xeef2f8;
      c1 = 0xf8fafc;
      alpha = 0.6;
    } else if (s === Surf.Mud) {
      c0 = 0x5a4e40;
      c1 = 0x7a7064;
      alpha = 0.4;
    } else [c0, c1] = DUST[s] ?? DUST[Surf.Dirt];
    if (s === Surf.Paved || s === Surf.Rock) alpha = 0.3;
    // ring of dust / snow / spray racing out, biased forward along the line of fire
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd() * 0.3;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const fwd = Math.max(0, ca * dx + sa * dz);
      const sp = c * (1.6 + rnd() * 1.4) * (1 + fwd * 0.9);
      this.emit(cx + ca * 0.1 * c, g + 0.06, cz + sa * 0.1 * c, ca * sp, 0.12 + rnd() * 0.25, sa * sp, (0.9 + rnd() * 0.9) * (0.7 + 0.3 * c), 0.14 * c, (0.55 + rnd() * 0.35) * c, c0, c1, alpha, 2.6, -0.03, 0.55);
    }
    // a forward plume of ground debris blown along the shot
    const nf = Math.max(1, Math.round(3 * c * rate));
    for (let i = 0; i < nf; i++) {
      const sp = c * (2 + rnd() * 2);
      this.emit(cx, g + 0.08, cz, dx * sp + (rnd() - 0.5) * 0.6, 0.3 + rnd() * 0.5, dz * sp + (rnd() - 0.5) * 0.6, 1.2 + rnd() * 0.8, 0.18 * c, 0.85 * c, c0, c1, alpha * 0.85, 2.2, -0.04, 0.6);
    }
    if (s === Surf.Snow) {
      // snow burst: powder thrown up plus heavier clumps falling back
      const nb = Math.max(2, Math.round(6 * c * rate));
      for (let i = 0; i < nb; i++) {
        const a = rnd() * Math.PI * 2;
        const sp = c * (0.8 + rnd() * 1.6);
        this.emit(cx, g + 0.08, cz, Math.cos(a) * sp + dx * c, 1.2 + rnd() * 1.6 * c, Math.sin(a) * sp + dz * c, 0.6 + rnd() * 0.4, 0.05 + rnd() * 0.03, 0.05, 0xf6f9fc, 0xe4eaf2, 0.95, 0.4, 6, 0);
      }
      for (let i = 0; i < Math.max(1, Math.round(3 * c * rate)); i++) this.emit(cx + (rnd() - 0.5) * 0.4 * c, g + 0.1, cz + (rnd() - 0.5) * 0.4 * c, (rnd() - 0.5) * 0.6, 0.8 + rnd() * 0.8, (rnd() - 0.5) * 0.6, 1.6 + rnd(), 0.2 * c, 1.1 * c, 0xf0f4fa, 0xfafcfe, 0.5, 1.4, 0.05, 0.7);
    } else if (s === Surf.Grass || (s === Surf.Mud && c > 1)) {
      // shredded grass / mud flicked out of the blast zone
      const nb = Math.max(1, Math.round(5 * c * rate));
      for (let i = 0; i < nb; i++) {
        const a = rnd() * Math.PI * 2;
        const sp = c * (1 + rnd() * 1.5);
        this.emit(cx, g + 0.06, cz, Math.cos(a) * sp + dx * c * 0.8, 1 + rnd() * 1.4, Math.sin(a) * sp + dz * c * 0.8, 0.5 + rnd() * 0.4, 0.035, 0.03, s === Surf.Grass ? 0x5a6a2a : 0x2e2216, 0x4a5228, 0.95, 0.6, 7, 0);
      }
    }
    if (s !== Surf.Water && c >= 0.5) onBlast(cx, cz, 0.45 * c + 0.15);
  }

  /** Rotor downwash under a low helicopter at (x, z); strength 0..1. Returns false on water (caller does the spray). */
  rotorWash(x: number, g: number, z: number, strength: number) {
    const s = this.surface(x, z);
    const rate = this.sink.rate();
    const rnd = Math.random;
    const n = this.take(Math.max(1, Math.round(3 * strength * rate)));
    let c0: number;
    let c1: number;
    let alpha = 0.4;
    let size = 1;
    switch (s) {
      case Surf.Water:
        c0 = 0xe4ecf0;
        c1 = 0xf2f6f8;
        alpha = 0.45;
        break;
      case Surf.Snow:
        c0 = 0xeef2f8;
        c1 = 0xf8fafc;
        alpha = 0.55;
        size = 1.3;
        break;
      case Surf.Mud:
        c0 = 0x6a6258;
        c1 = 0x8a847a;
        alpha = 0.25;
        size = 0.8;
        break;
      case Surf.Paved:
      case Surf.Rock:
        c0 = 0x9a968e;
        c1 = 0xb4b0a8;
        alpha = 0.18;
        break;
      case Surf.Grass:
        [c0, c1] = DUST[Surf.Grass];
        alpha = 0.22;
        break;
      default:
        [c0, c1] = DUST[s];
        alpha = 0.45;
        size = 1.35;
    }
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const sp = (1.4 + rnd()) * (0.5 + strength * 0.5);
      this.emit(x + Math.cos(a) * 0.3, g + 0.04, z + Math.sin(a) * 0.3, Math.cos(a) * sp, 0.05 + rnd() * 0.25 * size, Math.sin(a) * sp, (0.6 + rnd() * 0.5) * size, 0.12 * size, 0.55 * size, c0, c1, alpha * strength, 2.2, -0.02, 0.4);
    }
    // grass bits / water droplets / snow clumps whipped up
    if (rnd() < 0.5 * strength * rate && (s === Surf.Grass || s === Surf.Water || s === Surf.Snow) && this.take(1)) {
      const a = rnd() * Math.PI * 2;
      const sp = 1.5 + rnd() * 1.5;
      this.emit(x + Math.cos(a) * 0.4, g + 0.05, z + Math.sin(a) * 0.4, Math.cos(a) * sp, 0.8 + rnd(), Math.sin(a) * sp, 0.5, 0.03, 0.03, s === Surf.Grass ? 0x5a6a2a : s === Surf.Water ? 0xc8d4dc : 0xf6f9fc, s === Surf.Grass ? 0x4a5228 : 0xe0e8ee, 0.9, 0.6, 6, 0);
    }
  }

  /** Per frame: refill the spawn bucket, let the snow cover build up. */
  update(dt: number) {
    const per = this.perSec * this.sink.rate();
    this.tokens = Math.min(per * 0.25, this.tokens + per * dt);
    if (WX.wxSnow.value > 0 && WX.wxSnowThin.value > 0) WX.wxSnowThin.value = Math.max(0, WX.wxSnowThin.value - dt / SNOW_ACCUM_S);
  }
}
