import { Tile, type GameMap } from '../../sim/map';
import type { FlyerSink } from './flyers';
import type { HazeField } from './haze';

/*
 * Grass fires (visual only): big explosions on grass can ignite a patch that
 * creeps outwards as a ring of flame, may jump to neighbouring grass, then
 * burns out and leaves a scorch mark. Also used for the lingering
 * thermobaric afterburn.
 */

interface Patch {
  x: number;
  z: number;
  y: number;
  r: number;
  rMax: number;
  t: number;
  max: number;
  acc: number;
  gen: number;
}

export interface FireSink extends FlyerSink {
  haze: HazeField | null;
  scorch(x: number, z: number, r: number): void;
}

export class GrassFires {
  private list: Patch[] = [];

  constructor(
    private sink: FireSink,
    private map: GameMap,
    private max: number,
  ) {}

  get active() {
    return this.list.length;
  }

  isGrass(x: number, z: number) {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 0 || tz < 0 || tx >= this.map.w || tz >= this.map.h) return false;
    return this.map.tiles[tz * this.map.w + tx] === Tile.Grass;
  }

  /** Try to ignite grass at (x, z). size ~ blast size. */
  ignite(x: number, z: number, size: number, gen = 0) {
    if (this.list.length >= this.max || !this.isGrass(x, z)) return;
    for (const p of this.list) if (Math.hypot(p.x - x, p.z - z) < p.r + 0.4) return;
    this.list.push({ x, z, y: this.sink.groundAt(x, z), r: 0.15, rMax: (0.5 + Math.random() * 0.6) * Math.min(1.6, size), t: 0, max: 7 + Math.random() * 6, acc: 0, gen });
  }

  update(dt: number) {
    const s = this.sink;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.t += dt;
      const life = p.t / p.max;
      if (life >= 1) {
        s.scorch(p.x, p.z, p.r * 1.15);
        this.list[i] = this.list[this.list.length - 1];
        this.list.pop();
        continue;
      }
      p.r = Math.min(p.rMax, p.r + dt * 0.18);
      const strength = life < 0.75 ? 1 : (1 - life) / 0.25;
      // flame front along the ring, a few flames inside
      p.acc += dt * (8 + p.r * 14) * strength;
      while (p.acc >= 1) {
        p.acc -= 1;
        const a = Math.random() * Math.PI * 2;
        const rr = p.r * (Math.random() < 0.75 ? 0.8 + Math.random() * 0.25 : Math.random() * 0.7);
        const fx = p.x + Math.cos(a) * rr;
        const fz = p.z + Math.sin(a) * rr * 1;
        const fy = s.groundAt(fx, fz) + 0.03;
        s.spawnFire({ x: fx, y: fy, z: fz, vx: (Math.random() - 0.5) * 0.1, vy: 0.5 + Math.random() * 0.6, vz: (Math.random() - 0.5) * 0.1, life: 0.3 + Math.random() * 0.4, size: 0.22 + Math.random() * 0.12, sizeEnd: 0.06, color: 0xffc050, colorEnd: 0x901800, gravity: -0.5, wind: 0.5 });
        if (Math.random() < 0.3)
          s.spawnSmoke({ x: fx, y: fy + 0.15, z: fz, vy: 0.5 + Math.random() * 0.3, life: 2.5 + Math.random() * 1.5, size: 0.2, sizeEnd: 0.9, color: 0x55504a, colorEnd: 0x8e8882, alpha: 0.4, drag: 0.4, gravity: -0.05, wind: 1 });
      }
      s.lights.sustain(p.x, p.y + 0.2, p.z, (1.5 + p.r * 2) * strength, 0xff8a30, 0.45);
      if (s.haze && Math.random() < dt * 3 * strength) s.haze.heat(p.x + (Math.random() - 0.5) * p.r, p.y + 0.5, p.z + (Math.random() - 0.5) * p.r, 0.8 + p.r, 1.2, 0.0028);
      // jump to neighbouring grass
      if (p.gen < 2 && life > 0.25 && life < 0.6 && Math.random() < dt * 0.25) {
        const a = Math.random() * Math.PI * 2;
        this.ignite(p.x + Math.cos(a) * (p.r + 0.6), p.z + Math.sin(a) * (p.r + 0.6), p.rMax, p.gen + 1);
      }
    }
  }
}
