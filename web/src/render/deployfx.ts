import * as THREE from 'three';
import type { AnimState, Model } from './models';
import type { Effects } from './effects';

/**
 * MCV -> Construction Yard deploy, visual only.
 *
 * The simulation swaps the MCV for the yard instantly (the yard then runs its
 * normal 1.5 s build-up). The renderer hands the MCV's model to this overlay
 * instead of deleting it: the truck creeps to the yard centre and squares up,
 * outriggers slide out and their jacks lift it level, the module walls fold
 * down into floor wings, wall panels and roof panels swing up, the crane rises
 * and slews (the model's own AnimState.deploy animation, models/vehicles.ts),
 * with hydraulic hiss and dust. The yard model stays hidden until the module
 * has opened, then rises through its construction slices (remapped built
 * progress) while the truck settles into it under a burst of dust.
 * Gameplay timing is untouched.
 */

/** Overlay length (s). */
const DUR = 4.0;
/** Yard construction (visual) starts / ends at these overlay times. */
const BUILD0 = 2.3;
const BUILD1 = 3.9;

interface Job {
  id: number;
  model: Model;
  anim: AnimState;
  t: number;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  gy: number;
  yaw0: number;
  yaw1: number;
  puffs: number;
}

const _v = new THREE.Vector3();
const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class DeployFx {
  private jobs: Job[] = [];

  constructor(
    private scene: THREE.Scene,
    private fx: Effects,
    /** Is the yard still standing? */
    private alive: (id: number) => boolean,
  ) {}

  get active() {
    return this.jobs.length > 0;
  }

  /** Take over the (already detached) MCV model for yard `id` centred at (x, gy, z). */
  start(id: number, model: Model, anim: AnimState, x: number, gy: number, z: number) {
    const r = model.root;
    if (!r.parent) this.scene.add(r);
    const yaw0 = r.rotation.y;
    // square up with the yard: nearest quarter turn
    const yaw1 = Math.round(yaw0 / (Math.PI / 2)) * (Math.PI / 2);
    anim.moving = true;
    anim.fired = Infinity;
    this.jobs.push({ id, model, anim, t: 0, x0: r.position.x, z0: r.position.z, x1: x, z1: z, gy, yaw0, yaw1, puffs: 0 });
  }

  /**
   * Visual construction progress of yard `id` while its MCV unfolds (0 = not shown yet), or -1 when
   * no deploy overlay runs for it.
   */
  built(id: number): number {
    for (const j of this.jobs) if (j.id === id) return Math.min(1, Math.max(0, (j.t - BUILD0) / (BUILD1 - BUILD0)));
    return -1;
  }

  update(dt: number, time: number) {
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      const j = this.jobs[i];
      j.t += dt;
      const t = j.t;
      const r = j.model.root;
      if (t >= DUR || !this.alive(j.id)) {
        this.scene.remove(r);
        this.jobs.splice(i, 1);
        continue;
      }
      // creep to the centre and square up (first 0.7 s)
      const m = sstep(0, 0.7, t);
      const yaw = j.yaw0 + (j.yaw1 - j.yaw0) * m;
      // settle into the yard at the end: sink and shrink a little under the dust
      const sink = sstep(3.15, DUR, t);
      r.position.set(j.x0 + (j.x1 - j.x0) * m, j.gy - sink * 0.45, j.z0 + (j.z1 - j.z0) * m);
      r.rotation.set(0, yaw, 0);
      const a = j.anim;
      const sp = t < 0.7 ? Math.hypot(j.x1 - j.x0, j.z1 - j.z0) / 0.7 + Math.abs(j.yaw1 - j.yaw0) * 0.4 : 0;
      a.dt = dt;
      a.time = time;
      a.moving = sp > 0.02;
      a.speed = sp;
      a.dist += sp * dt;
      a.turn = 0;
      a.deploy = Math.min(1, t / DUR);
      j.model.anim?.(a);
      if (dt <= 0) continue;
      // effects keyed to the unfold phases
      const c = Math.cos(yaw);
      const s = -Math.sin(yaw);
      const at = (lx: number, lz: number, y: number) => _v.set(j.x1 + lx * c - lz * s, j.gy + y, j.z1 + lx * s + lz * c);
      const k = r.scale.x;
      // jacks hit the ground: dust at the four pads, hydraulic hiss
      if (j.puffs === 0 && t > 1.1) {
        j.puffs = 1;
        for (const lx of [-0.56, 0.28])
          for (const lz of [-0.48, 0.48]) {
            const p = at(lx * k, lz * k, 0.02);
            this.fx.dust(p.x, p.y, p.z, 0.7);
            this.fx.smoke(p.x, p.y + 0.15, p.z, 0.35, false);
          }
      }
      // walls fold down: hiss along the module sides
      if (j.puffs === 1 && t > 1.35) {
        j.puffs = 2;
        for (const lz of [-0.36, 0.36]) {
          const p = at(-0.2 * k, lz * k, 0.3);
          this.fx.smoke(p.x, p.y, p.z, 0.4, false);
        }
      }
      // panels up / roof over: thump of dust off the wings
      if (j.puffs === 2 && t > 2.2) {
        j.puffs = 3;
        for (const lz of [-0.6, 0.6]) {
          const p = at(-0.2 * k, lz * k, 0.05);
          this.fx.dust(p.x, p.y, p.z, 1.1);
        }
      }
      // the yard rises: dust rolling out from the footprint
      if (j.puffs === 3 && t > BUILD0) {
        j.puffs = 4;
        this.fx.ring(j.x1, j.gy + 0.05, j.z1, 0.5, 3.2, 0.8, 0xd8c8a0, false, 0.45);
        for (let n = 0; n < 10; n++) this.fx.dust(j.x1 + (Math.random() - 0.5) * 2.6, j.gy, j.z1 + (Math.random() - 0.5) * 2.6, 2);
      }
      if (j.puffs === 4 && t > 3.3) {
        j.puffs = 5;
        for (let n = 0; n < 8; n++) this.fx.dust(j.x1 + (Math.random() - 0.5) * 1.4, j.gy + 0.1, j.z1 + (Math.random() - 0.5) * 1.4, 1.8);
      }
      // small steady hiss while things move
      if (t > 0.7 && t < 2.8 && Math.random() < dt * 3) {
        const p = at((Math.random() - 0.5) * 0.9 * k, (Math.random() < 0.5 ? -0.42 : 0.42) * k, 0.2);
        this.fx.smoke(p.x, p.y, p.z, 0.22, false);
      }
    }
  }

  dispose() {
    for (const j of this.jobs) this.scene.remove(j.model.root);
    this.jobs.length = 0;
  }
}
