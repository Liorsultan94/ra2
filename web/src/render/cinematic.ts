/**
 * Cinematic moments: a short slow-motion beat with a gentle camera push-in
 * towards a big event (heavy ballistic launch, ballistic interception,
 * superweapon-scale blast), then an ease back to where the player was.
 *
 * Determinism: only the number of simulation ticks run per real second is
 * scaled (Game multiplies its tick accumulator by timeScale); the simulation
 * itself is untouched. Everything here runs on real time.
 */

export interface CineCamera {
  target: { x: number; z: number };
  zoom: number;
  setZoom(z: number): void;
  centerOn(x: number, y: number): void;
}

export interface CineShot {
  /** Ground point to look at (already corrected so the event sits in the screen centre). */
  focus: () => { x: number; y: number } | null;
  /** Extra zoom factor for the push-in. */
  push: number;
  /** Real seconds. */
  duration: number;
  label: string;
}

const SLOW = 0.55;
const COOLDOWN = 25;
const EASE_IN = 0.45;
const EASE_OUT = 0.6;

const smooth = (t: number) => t * t * (3 - 2 * t);

export class CinematicDirector {
  enabled = true;
  private shot: CineShot | null = null;
  private t = 0;
  private home = { x: 0, y: 0, zoom: 1 };
  private lastFocus = { x: 0, y: 0 };
  private lastAt = -1e9;
  /** Set when the player skipped: time (in shot seconds) the fast return started. */
  private skipAt = -1;
  private skipDur = 0.35;

  get active(): boolean {
    return !!this.shot;
  }

  /** Simulation speed multiplier (1 = normal). */
  get timeScale(): number {
    const s = this.shot;
    if (!s) return 1;
    const end = this.skipAt >= 0 ? this.skipAt + this.skipDur : s.duration;
    const fadeIn = smooth(Math.min(1, this.t / EASE_IN));
    const fadeOut = smooth(Math.max(0, Math.min(1, (end - this.t) / (this.skipAt >= 0 ? this.skipDur : EASE_OUT))));
    return 1 - (1 - SLOW) * Math.min(fadeIn, fadeOut);
  }

  /** Start a shot if allowed (enabled, cooled down, not already playing). Returns true when it starts. */
  trigger(shot: CineShot, cam: CineCamera, now: number): boolean {
    if (!this.enabled || this.shot || now - this.lastAt < COOLDOWN) return false;
    const f = shot.focus();
    if (!f) return false;
    this.shot = shot;
    this.t = 0;
    this.skipAt = -1;
    this.lastAt = now;
    this.home = { x: cam.target.x, y: cam.target.z, zoom: cam.zoom };
    this.lastFocus = f;
    return true;
  }

  /** Any tap / click / key: ease back quickly. */
  skip() {
    if (!this.shot || this.skipAt >= 0) return;
    this.skipAt = this.t;
  }

  /** Drop the shot immediately and give the camera back (e.g. when the game ends). */
  cancel(cam: CineCamera) {
    if (!this.shot) return;
    cam.centerOn(this.home.x, this.home.y);
    cam.setZoom(this.home.zoom);
    this.shot = null;
  }

  /** Advance on real time and drive the camera. */
  update(realDt: number, cam: CineCamera) {
    const s = this.shot;
    if (!s) return;
    this.t += realDt;
    const f = s.focus();
    if (f) {
      // follow a moving subject softly with framerate-independent exponential damping
      const followAlpha = 1 - Math.exp(-realDt * 5);
      this.lastFocus.x += (f.x - this.lastFocus.x) * followAlpha;
      this.lastFocus.y += (f.y - this.lastFocus.y) * followAlpha;
    }
    let k: number; // 0 = player's view, 1 = full push-in on the event
    if (this.skipAt >= 0) {
      const back = Math.min(1, (this.t - this.skipAt) / this.skipDur);
      const from = this.skipAt < EASE_IN ? smooth(this.skipAt / EASE_IN) : 1;
      k = from * (1 - smooth(back));
      if (back >= 1) k = -1;
    } else if (this.t < EASE_IN) k = smooth(this.t / EASE_IN);
    else if (this.t < s.duration - EASE_OUT) k = 1;
    else if (this.t < s.duration) k = 1 - smooth((this.t - (s.duration - EASE_OUT)) / EASE_OUT);
    else k = -1;
    if (k < 0) {
      cam.centerOn(this.home.x, this.home.y);
      cam.setZoom(this.home.zoom);
      this.shot = null;
      return;
    }
    // the push-in only moves part of the way so the player keeps their bearings
    const kk = k * 0.75;
    cam.centerOn(this.home.x + (this.lastFocus.x - this.home.x) * kk, this.home.y + (this.lastFocus.y - this.home.y) * kk);
    cam.setZoom(this.home.zoom * (1 + (s.push - 1) * k));
  }
}
