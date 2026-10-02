import type { BlastProfile, Effects } from '../effects';

/*
 * Secondary explosions (visual only - the sim never hears about them).
 *
 * Ammunition, fuel and missiles stored in a destroyed structure or vehicle
 * cook off for a few seconds after it dies: crackling ammo pops with tracer
 * sparks, fuel fireballs rolling upwards under a black mushroom, missiles
 * skittering away on smoke trails, burning debris thrown on arcs. A tank's
 * ready rack may vent as a roaring flame fountain out of the turret ring.
 */

export interface CookOff {
  /** Small ammunition pops. */
  ammo: number;
  /** Fuel fireballs. */
  fuel: number;
  /** Missiles / rockets cooking off and flying away. */
  missiles: number;
  /** Electrical arcing (power plants). */
  arcs?: number;
  /** Overall scale of the fireballs. */
  size: number;
  /** Seconds over which the events are spread (after an initial 0.3 s). */
  span: number;
}

/** What each building role keeps inside. */
const BUILDING_COOKOFF: Record<string, CookOff> = {
  factory: { ammo: 10, fuel: 2, missiles: 2, size: 1.2, span: 3.6 },
  airfield: { ammo: 5, fuel: 3, missiles: 2, size: 1.3, span: 3.6 },
  def_aa: { ammo: 2, fuel: 1, missiles: 6, size: 0.8, span: 3 },
  def_at: { ammo: 3, fuel: 0, missiles: 4, size: 0.7, span: 2.6 },
  def_gun: { ammo: 5, fuel: 0, missiles: 0, size: 0.6, span: 2.2 },
  refinery: { ammo: 2, fuel: 3, missiles: 0, size: 1.5, span: 3.8 },
  oil: { ammo: 0, fuel: 2, missiles: 0, size: 1.7, span: 2.5 },
  conyard: { ammo: 4, fuel: 1, missiles: 0, size: 1.1, span: 3 },
  superweapon: { ammo: 8, fuel: 3, missiles: 6, size: 1.5, span: 4 },
  power: { ammo: 0, fuel: 1, missiles: 0, arcs: 6, size: 1.0, span: 2.6 },
  tech_airport: { ammo: 1, fuel: 3, missiles: 0, size: 1.4, span: 3.5 },
  barracks: { ammo: 3, fuel: 0, missiles: 0, size: 0.7, span: 2.4 },
  tech: { ammo: 2, fuel: 1, missiles: 0, arcs: 3, size: 0.9, span: 2.8 },
};

const POP: BlastProfile = { size: 0.42, fire: 0.5, sparks: 14, smoke: 0.4, dirt: 0, ring: 0, crater: 0, scorch: 0, light: 2.2, shake: 0.012 };

interface Fountain {
  x: number;
  y: number;
  z: number;
  t: number;
  max: number;
  acc: number;
}

export class Secondaries {
  private fountains: Fountain[] = [];

  constructor(private fx: Effects) {}

  static forBuilding(role: string): CookOff | null {
    return BUILDING_COOKOFF[role] ?? null;
  }

  private r(a: number, b: number) {
    return a + Math.random() * (b - a);
  }

  /** Schedule a whole cook-off sequence over a footprint (w x d tiles centred on x,z; gy = ground). */
  cookOff(c: CookOff, x: number, gy: number, z: number, w: number, d: number, hgt = 0.6) {
    const at = () => [x + this.r(-0.4, 0.4) * w, z + this.r(-0.4, 0.4) * d] as const;
    const when = () => 0.3 + Math.pow(Math.random(), 1.4) * c.span;
    for (let i = 0; i < c.ammo; i++) {
      const [px, pz] = at();
      this.fx.after(when(), () => this.pop(px, gy + this.r(0.15, hgt), pz, gy));
    }
    for (let i = 0; i < c.fuel; i++) {
      const [px, pz] = at();
      // the first fireball comes early (tanks / fuel lines rupture), the rest follow
      this.fx.after(i === 0 ? this.r(0.5, 1.1) : when(), () => this.fuelball(px, gy, pz, c.size * this.r(0.8, 1.15)));
    }
    for (let i = 0; i < c.missiles; i++) {
      const [px, pz] = at();
      this.fx.after(when(), () => this.missile(px, gy + this.r(0.2, hgt + 0.2), pz));
    }
    for (let i = 0; i < (c.arcs ?? 0); i++) {
      const [px, pz] = at();
      this.fx.after(this.r(0.2, c.span), () => this.arc(px, gy + this.r(0.3, hgt + 0.3), pz));
    }
  }

  /** Small ammunition pop: flash, sparks, tracer-like streaks and a puff; sometimes a burning fragment. */
  pop(x: number, y: number, z: number, gy: number, scale = 1) {
    const fx = this.fx;
    fx.blast(scale === 1 ? POP : { ...POP, size: POP.size * scale, light: POP.light * scale }, x, y, z, gy);
    const n = 6 + Math.floor(Math.random() * 6);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const el = this.r(0.1, 1.2);
      const sp = this.r(4, 9);
      fx.fire.spawn({ x, y, z, vx: Math.cos(a) * Math.cos(el) * sp, vy: Math.sin(el) * sp, vz: Math.sin(a) * Math.cos(el) * sp, life: this.r(0.25, 0.6), size: 0.05, color: 0xfff0b0, colorEnd: 0xff5000, gravity: 6, drag: 0.3 });
    }
    if (Math.random() < 0.45) {
      const a = Math.random() * Math.PI * 2;
      const sp = this.r(1.2, 2.6);
      fx.flyers.add('burning', x, y, z, Math.cos(a) * sp, this.r(3, 5.5), Math.sin(a) * sp, this.r(1.2, 2.2), this.r(0.6, 1));
    }
  }

  /** Fuel fireball: a rolling orange ball that rises under a black mushroom, with a long light. */
  fuelball(x: number, gy: number, z: number, S = 1) {
    const fx = this.fx;
    const n = Math.round(18 * Math.sqrt(S) * fx.rate);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = this.r(0, 0.35) * S;
      fx.fire.spawn({
        x: x + Math.cos(a) * r,
        y: gy + this.r(0.1, 0.5) * S,
        z: z + Math.sin(a) * r,
        vx: Math.cos(a) * this.r(0.2, 0.6) * S,
        vy: this.r(1.2, 2.6) * S,
        vz: Math.sin(a) * this.r(0.2, 0.6) * S,
        life: this.r(0.9, 1.6),
        size: this.r(0.45, 0.75) * S,
        sizeEnd: this.r(1.1, 1.6) * S,
        color: 0xffd890,
        colorEnd: 0x5a1400,
        alpha: 0.45,
        drag: 1.4,
        gravity: -1.6,
      });
    }
    // black mushroom cap and stem
    const m = Math.round(10 * S * fx.rate);
    for (let i = 0; i < m; i++) {
      const a = Math.random() * Math.PI * 2;
      fx.smokeSys.spawn({
        x: x + Math.cos(a) * 0.2 * S,
        y: gy + this.r(0.6, 1.4) * S,
        z: z + Math.sin(a) * 0.2 * S,
        vx: Math.cos(a) * this.r(0.2, 0.6) * S,
        vy: this.r(1.4, 2.4) * S,
        vz: Math.sin(a) * this.r(0.2, 0.6) * S,
        life: this.r(3.5, 5.5),
        size: 0.5 * S,
        sizeEnd: this.r(2, 2.8) * S,
        color: 0x14110f,
        colorEnd: 0x4a4440,
        alpha: 0.75,
        drag: 0.9,
        gravity: -0.1,
        wind: 0.8,
        glow: 0.55,
      });
    }
    fx.fireballs?.spawn(x, gy + 0.4 * S, z, 1.1 * S, 'normal', false);
    fx.flashLight(x, gy + 0.8 * S, z, 10 * S, 0xff9038, 0.9);
    fx.addShake(0.08 * S, x, z);
    if (fx.haze) fx.haze.heat(x, gy + 1.2 * S, z, 2.4 * S, 2, 0.005, 1);
    // burning droplets / debris thrown out
    const k = Math.round(3 * S);
    for (let i = 0; i < k; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = this.r(1, 2.6) * Math.sqrt(S);
      fx.flyers.add('burning', x, gy + 0.4, z, Math.cos(a) * sp, this.r(3, 6), Math.sin(a) * sp, this.r(1.2, 2.4), this.r(0.7, 1.2));
    }
    fx.scorch(x, gy, z, 0.8 * S);
  }

  /** A missile / rocket motor cooking off: it skitters away low and fast on a smoke trail. */
  missile(x: number, y: number, z: number) {
    const fx = this.fx;
    const a = Math.random() * Math.PI * 2;
    const el = this.r(0.25, 1.1);
    const sp = this.r(6, 10);
    fx.flyers.add('burning', x, y, z, Math.cos(a) * Math.cos(el) * sp, Math.sin(el) * sp, Math.sin(a) * Math.cos(el) * sp, this.r(1.2, 2), 1.5);
    fx.fire.spawn({ x, y, z, life: 0.15, size: 0.8, color: 0xfff2d0, colorEnd: 0xff8030, alpha: 0.6 });
    for (let i = 0; i < 6; i++) fx.smokeSys.spawn({ x, y, z, vx: this.r(-0.8, 0.8), vy: this.r(0.2, 0.9), vz: this.r(-0.8, 0.8), life: this.r(1.5, 2.5), size: 0.2, sizeEnd: 0.9, color: 0xd8d4ce, colorEnd: 0xeeeae6, alpha: 0.6, drag: 1.2, wind: 0.6 });
    fx.flashLight(x, y, z, 4, 0xffc070, 0.25);
  }

  /** Electrical arc: blue-white flash and a shower of sparks. */
  arc(x: number, y: number, z: number) {
    const fx = this.fx;
    fx.fire.spawn({ x, y, z, life: 0.1, size: 0.7, color: 0xd8ecff, colorEnd: 0x6aa8ff, alpha: 0.9 });
    for (let i = 0; i < 14; i++) fx.fire.spawn({ x, y, z, vx: this.r(-2.5, 2.5), vy: this.r(0, 3), vz: this.r(-2.5, 2.5), life: this.r(0.3, 0.7), size: 0.04, color: 0xe8f4ff, colorEnd: 0x4080ff, gravity: 8, drag: 0.4 });
    fx.flashLight(x, y, z, 5, 0x9ac8ff, 0.12);
  }

  /** Tank ammunition fire: a roaring flame jet out of the turret ring for a few seconds. */
  fountain(x: number, y: number, z: number, dur = 2.2) {
    this.fountains.push({ x, y, z, t: 0, max: dur, acc: 0 });
    this.fx.flashLight(x, y + 0.4, z, 6, 0xffa040, 0.3);
  }

  /** Truck fuel tank going up. */
  truckFuel(x: number, gy: number, z: number, S = 0.75) {
    this.fx.after(this.r(0.25, 0.6), () => this.fuelball(x, gy, z, S));
  }

  update(dt: number) {
    const fx = this.fx;
    for (let i = this.fountains.length - 1; i >= 0; i--) {
      const f = this.fountains[i];
      f.t += dt;
      const k = f.t / f.max;
      if (k >= 1) {
        this.fountains.splice(i, 1);
        continue;
      }
      // strongest at the start, then sputtering
      const pw = (1 - k) * (0.6 + 0.4 * Math.sin(f.t * 23) * Math.sin(f.t * 7.3));
      f.acc += dt * 90 * fx.rate;
      while (f.acc >= 1) {
        f.acc -= 1;
        fx.fire.spawn({ x: f.x + this.r(-0.06, 0.06), y: f.y, z: f.z + this.r(-0.06, 0.06), vx: this.r(-0.35, 0.35), vy: this.r(5, 9) * (0.4 + pw), vz: this.r(-0.35, 0.35), life: this.r(0.3, 0.55), size: this.r(0.2, 0.32), sizeEnd: this.r(0.5, 0.75), color: 0xfff2c8, colorEnd: 0xd03008, alpha: 0.7, drag: 1.1, gravity: -1 });
        if (Math.random() < 0.35) fx.fire.spawn({ x: f.x, y: f.y + 0.1, z: f.z, vx: this.r(-2, 2), vy: this.r(4, 8), vz: this.r(-2, 2), life: this.r(0.5, 1), size: 0.04, color: 0xfff0c0, colorEnd: 0xff4000, gravity: 8, drag: 0.3 });
      }
      if (Math.random() < dt * 8) fx.smoke(f.x, f.y + 1.2 * pw + 0.3, f.z, 0.9, true);
      fx.lights.sustain(f.x, f.y + 0.5, f.z, 5 * pw + 1, 0xff9030, 0.4);
    }
  }
}
