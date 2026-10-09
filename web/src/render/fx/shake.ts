/*
 * Trauma based camera shake: explosions add trauma (attenuated by distance
 * to the view centre), trauma decays over time and the camera offset is
 * trauma^1.5 times smooth multi-frequency noise - a jolt that settles,
 * instead of white-noise jitter.
 */
export class CameraShake {
  trauma = 0;
  /** Current camera offset (world units, ground plane). Read every frame by the camera. */
  readonly offset = { x: 0, z: 0 };
  /** View centre (camera target), for distance attenuation. */
  view: { x: number; z: number } | null = null;
  /** Global multiplier (settings / accessibility). */
  scale = 1;
  private t = 0;

  /** amount ~ 0.03 (tank shell) .. 0.45 (ballistic warhead). Optional world position (x, z) attenuates by distance to the view. */
  add(amount: number, x?: number, z?: number) {
    let k = 1;
    if (x !== undefined && z !== undefined && this.view) {
      const d = Math.hypot(x - this.view.x, z - this.view.z);
      k = Math.max(0, 1 - d / 24);
      k *= k;
    }
    this.trauma = Math.min(1, this.trauma + amount * 1.5 * k);
  }

  update(dt: number) {
    this.t += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.1);
    const a = Math.min(0.18, Math.pow(this.trauma, 1.5) * 0.22) * this.scale;
    const t = this.t;
    this.offset.x = a ? a * (Math.sin(t * 23.1) * 0.6 + Math.sin(t * 35.3 + 1.7) * 0.3 + Math.sin(t * 11.7 + 0.4) * 0.1) : 0;
    this.offset.z = a ? a * (Math.sin(t * 26.9 + 2.1) * 0.6 + Math.sin(t * 31.7 + 0.3) * 0.3 + Math.sin(t * 9.3 + 2.9) * 0.1) : 0;
  }
}
