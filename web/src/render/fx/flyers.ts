import type { ParticleOpts } from '../effects';
import type { FxLights } from './lights';

/*
 * Flyers: invisible point emitters on ballistic arcs that paint a trail of
 * particles as they fall - magnesium decoy flares, burning interceptor /
 * missile fragments, thermobaric embers. Each one is a few floats; all
 * drawing goes through the shared particle systems.
 */

export type FlyerKind = 'flare' | 'burning' | 'ember' | 'spark';

interface Flyer {
  kind: FlyerKind;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  acc: number;
  size: number;
  key: number; // sim-steered flyer (decoy flare: its projectile id), else -1
}

export interface FlyerSink {
  spawnFire(o: ParticleOpts): void;
  spawnSmoke(o: ParticleOpts): void;
  lights: FxLights;
  groundAt(x: number, z: number): number;
}

export class Flyers {
  private list: Flyer[] = [];
  private pool: Flyer[] = [];
  private keyed = new Map<number, Flyer>();

  constructor(
    private sink: FlyerSink,
    private max: number,
  ) {}

  get active() {
    return this.list.length;
  }

  /**
   * key >= 0: a sim-steered flyer (the decoy flare a fooled missile chases, sim/stealth.ts) that steer() keeps on
   * the sim's track; it is always admitted, even at the cap, since the missile visibly bursts on it.
   */
  add(kind: FlyerKind, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size = 1, key = -1) {
    if (this.list.length >= this.max && key < 0) return;
    const f = this.pool.pop() ?? { kind, x, y, z, vx, vy, vz, life: 0, max: life, acc: 0, size, key };
    f.kind = kind;
    f.x = x;
    f.y = y;
    f.z = z;
    f.vx = vx;
    f.vy = vy;
    f.vz = vz;
    f.life = 0;
    f.max = life;
    f.acc = Math.random();
    f.size = size;
    f.key = key;
    if (key >= 0) this.keyed.set(key, f);
    this.list.push(f);
  }

  /** Put a sim-steered flyer on the sim's position / velocity (render axes: y up). */
  steer(key: number, x: number, y: number, z: number, vx: number, vy: number, vz: number) {
    const f = this.keyed.get(key);
    if (!f) return;
    f.x = x;
    f.y = y;
    f.z = z;
    f.vx = vx;
    f.vy = vy;
    f.vz = vz;
  }

  update(dt: number) {
    const s = this.sink;
    let w = 0;
    for (let i = 0; i < this.list.length; i++) {
      const f = this.list[i];
      f.life += dt;
      const flare = f.kind === 'flare';
      // flares are light and draggy: they arc out and sink slowly; fragments fall like stones
      const spark = f.kind === 'spark';
      const drag = flare ? 1.6 : f.kind === 'ember' ? 1.0 : spark ? 0.9 : 0.25;
      const g = flare ? 2.2 : f.kind === 'ember' ? 3 : spark ? 9 : 8;
      const k = Math.max(0, 1 - drag * dt);
      f.vx *= k;
      f.vz *= k;
      f.vy = f.vy * k - g * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.z += f.vz * dt;
      const ground = s.groundAt(f.x, f.z);
      if (f.life >= f.max || f.y <= ground + 0.03) {
        if (f.kind === 'burning' && f.y <= ground + 0.03) {
          // smouldering where it lands
          s.spawnSmoke({ x: f.x, y: ground + 0.05, z: f.z, vy: 0.3, life: 2.5, size: 0.15 * f.size, sizeEnd: 0.7 * f.size, color: 0x2e2a26, colorEnd: 0x6a6460, alpha: 0.5, drag: 0.8, wind: 0.6 });
          s.spawnFire({ x: f.x, y: ground + 0.05, z: f.z, life: 0.25, size: 0.35 * f.size, color: 0xffc060, colorEnd: 0xff3000 });
        }
        if (f.key >= 0 && this.keyed.get(f.key) === f) this.keyed.delete(f.key);
        f.key = -1;
        this.pool.push(f);
        continue;
      }
      const fade = 1 - f.life / f.max;
      // emit at a steady rate, independent of frame rate
      f.acc += dt * (flare ? 40 : spark ? 70 : 30);
      while (f.acc >= 1) {
        f.acc -= 1;
        const j = Math.random();
        const px = f.x - f.vx * dt * j;
        const py = f.y - f.vy * dt * j;
        const pz = f.z - f.vz * dt * j;
        if (flare) {
          s.spawnFire({ x: px, y: py, z: pz, life: 0.12, size: 0.32 * f.size * (0.6 + 0.4 * fade), sizeEnd: 0.12, color: 0xffffff, colorEnd: 0xffd890, alpha: 1 });
          s.spawnSmoke({ x: px, y: py, z: pz, vx: (Math.random() - 0.5) * 0.1, vy: 0.05, vz: (Math.random() - 0.5) * 0.1, life: 1.8 + Math.random(), size: 0.08, sizeEnd: 0.5, color: 0xe8e6e2, colorEnd: 0xf4f2f0, alpha: 0.45 * fade, drag: 0.6, wind: 0.8 });
        } else if (spark) {
          // white-hot fragment: a thin streak that cools to orange as it slows
          s.spawnFire({ x: px, y: py, z: pz, life: 0.09 + 0.06 * fade, size: 0.07 * f.size, sizeEnd: 0.03, color: fade > 0.5 ? 0xfff4d8 : 0xffc070, colorEnd: 0xff5000, alpha: 0.95 });
        } else if (f.kind === 'burning') {
          s.spawnFire({ x: px, y: py, z: pz, life: 0.18, size: 0.22 * f.size * (0.5 + 0.5 * fade), sizeEnd: 0.08, color: 0xffd080, colorEnd: 0xff3a00, alpha: 0.9 });
          s.spawnSmoke({ x: px, y: py, z: pz, vy: 0.08, life: 1.6 + Math.random(), size: 0.07 * f.size, sizeEnd: 0.45 * f.size, color: 0x24201d, colorEnd: 0x6a6460, alpha: 0.55, drag: 0.6, wind: 0.8 });
        } else {
          s.spawnFire({ x: px, y: py, z: pz, life: 0.22, size: 0.12 * f.size, sizeEnd: 0.04, color: 0xffc070, colorEnd: 0xff3000, alpha: 0.9 });
        }
      }
      if (flare) s.lights.sustain(f.x, f.y, f.z, 3.2 * fade, 0xfff0d0, 0.3);
      else if (f.kind === 'burning' && f.size > 0.9) s.lights.sustain(f.x, f.y, f.z, 1.2 * fade, 0xff8030, 0.4);
      this.list[w++] = f;
    }
    this.list.length = w;
  }
}
