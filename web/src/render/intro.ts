import * as THREE from 'three';
import { groundHeight, type GameMap } from '../sim/map';
import { BASE_VIEW, type GameRenderer } from './renderer';

/*
 * Battle intro flyover and victory / defeat outro camera moves.
 *
 * Both drive the renderer's free camera hook (`photoCam`, also used by photo
 * mode) plus its target / zoom, on real time. The intro runs while the
 * simulation has not started yet; the outro runs after the game is decided.
 * The intro's last pose is exactly the normal RTS camera, so control is handed
 * back without a cut.
 */

interface Pose {
  x: number;
  y: number;
  /** Azimuth of the camera around the look point (renderer convention: PI/4 + yaw). */
  az: number;
  /** Elevation above the horizon, radians. */
  el: number;
  /** Visual zoom (may go below the renderer's minimum for wide shots). */
  zoom: number;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const bez = (a: number, b: number, c: number, u: number) => (1 - u) * (1 - u) * a + 2 * (1 - u) * u * b + u * u * c;
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

const SCRATCH_LOOK = new THREE.Vector3();
const SCRATCH_POS = new THREE.Vector3();
const SCRATCH_CAM = { pos: SCRATCH_POS, look: SCRATCH_LOOK };
const SCRATCH_POSE: Pose = { x: 0, y: 0, az: 0, el: 0, zoom: 0 };

/** Put the renderer's camera at a pose (free camera + matching target / zoom). */
function applyPose(r: GameRenderer, map: GameMap, p: Pose) {
  r.centerOn(p.x, p.y);
  r.setZoom(p.zoom);
  const tx = r.target.x;
  const tz = r.target.z;
  SCRATCH_LOOK.set(tx, groundHeight(map, tx, tz), tz);
  let dist = 80;
  const cam = r.camera;
  if (cam instanceof THREE.PerspectiveCamera) dist = BASE_VIEW / Math.max(0.05, p.zoom) / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)));
  const ce = Math.cos(p.el);
  SCRATCH_POS.set(Math.cos(p.az) * ce, Math.sin(p.el), Math.sin(p.az) * ce).multiplyScalar(dist).add(SCRATCH_LOOK);
  r.photoCam = SCRATCH_CAM;
}

/** Normal RTS camera pose for a ground point at a zoom (the current view rotation). */
function rtsPose(r: GameRenderer, x: number, y: number, zoom: number): Pose {
  const z0 = r.zoom;
  r.setZoom(zoom);
  const el = r.elevation();
  r.setZoom(z0);
  return { x, y, az: Math.PI / 4 + r.yaw, el, zoom };
}

export class BattleIntro {
  private t = 0;
  done = false;
  private from: Pose;
  private via: Pose;
  private to: Pose;

  /**
   * Sweep from behind the enemy base (`enemy`), high over the battlefield
   * (`via`, usually the centre crossing), down to the player's start (`home`)
   * at the normal starting zoom.
   */
  constructor(
    private r: GameRenderer,
    private map: GameMap,
    enemy: { x: number; y: number },
    via: { x: number; y: number },
    private home: { x: number; y: number },
    private endZoom: number,
    readonly duration = 3.8,
  ) {
    this.to = rtsPose(r, home.x, home.y, endZoom);
    // the camera starts on the enemy's side of the map looking back across the river
    const back = Math.atan2(enemy.y - home.y, enemy.x - home.x);
    let az0 = back;
    // turn the short way round to the final azimuth
    while (az0 - this.to.az > Math.PI) az0 -= Math.PI * 2;
    while (az0 - this.to.az < -Math.PI) az0 += Math.PI * 2;
    this.from = { x: enemy.x, y: enemy.y, az: az0, el: THREE.MathUtils.degToRad(24), zoom: 0.85 };
    // via.zoom: how far the mid-flight pull-back goes (fraction of the straight zoom path)
    this.via = { x: via.x, y: via.y, az: (az0 + this.to.az) / 2, el: THREE.MathUtils.degToRad(56), zoom: 0.35 };
    applyPose(r, map, this.from);
    // the briefing already showed the whole map: no shroud during the flyover (the fog eases back afterwards)
    r.fog.revealAll();
    (r.fog as unknown as { update: () => void }).update = () => {};
  }

  /** Seconds into the flyover. */
  get time() {
    return this.t;
  }

  /** Real seconds; returns true when the flyover has ended and the camera is handed back. */
  update(dt: number): boolean {
    if (this.done) return true;
    this.t += Math.min(dt, 0.1);
    const k = Math.min(1, this.t / this.duration);
    if (k >= 1) {
      this.finish();
      return true;
    }
    const u = smooth(k);
    const a = this.from;
    const b = this.via;
    const c = this.to;
    const turn = smooth(Math.min(1, k * 1.15));
    SCRATCH_POSE.x = bez(a.x, b.x, c.x, u);
    SCRATCH_POSE.y = bez(a.y, b.y, c.y, u);
    SCRATCH_POSE.az = lerp(a.az, c.az, turn);
    // rise high over the river mid-flight, settle into the RTS view at the end
    SCRATCH_POSE.el = lerp(a.el, c.el, u) + (b.el - (a.el + c.el) / 2) * Math.sin(Math.PI * u);
    SCRATCH_POSE.zoom = Math.exp(lerp(Math.log(a.zoom), Math.log(c.zoom), u)) * (1 - (1 - b.zoom) * Math.sin(Math.PI * u));
    applyPose(this.r, this.map, SCRATCH_POSE);
    return false;
  }

  /** Jump to the end (skip) and give the normal camera back. */
  finish() {
    if (this.done) return;
    this.done = true;
    delete (this.r.fog as unknown as { update?: unknown }).update;
    this.r.photoCam = null;
    this.r.centerOn(this.home.x, this.home.y);
    this.r.setZoom(this.endZoom);
  }
}

export class BattleOutro {
  private t = 0;
  done = false;
  private from: Pose;
  private to: Pose;

  constructor(
    private r: GameRenderer,
    private map: GameMap,
    focus: { x: number; y: number },
    readonly duration = 4.8,
  ) {
    this.from = rtsPose(r, r.target.x, r.target.z, r.zoom);
    this.to = {
      x: focus.x,
      y: focus.y,
      az: this.from.az + 0.55,
      // a slow pull-back over the aftermath (a push-in ends up inside the smoke of the collapse)
      el: Math.max(THREE.MathUtils.degToRad(32), this.from.el - 0.08),
      zoom: Math.max(0.7, this.from.zoom * 0.72),
    };
  }

  /** Simulation speed during the outro (slow motion). */
  get timeScale() {
    return this.done ? 1 : 0.55;
  }

  update(dt: number): boolean {
    if (this.done) return true;
    this.t += Math.min(dt, 0.1);
    const k = easeOut(Math.min(1, this.t / 2.6));
    // after the push-in keep a slow orbit going
    const drift = Math.max(0, this.t - 2.6) * 0.07;
    const a = this.from;
    const b = this.to;
    SCRATCH_POSE.x = lerp(a.x, b.x, k);
    SCRATCH_POSE.y = lerp(a.y, b.y, k);
    SCRATCH_POSE.az = lerp(a.az, b.az, k) + drift;
    SCRATCH_POSE.el = lerp(a.el, b.el, k);
    SCRATCH_POSE.zoom = lerp(a.zoom, b.zoom, k);
    applyPose(this.r, this.map, SCRATCH_POSE);
    if (this.t >= this.duration) {
      this.done = true;
      return true;
    }
    return false;
  }

  skip() {
    this.t = Math.max(this.t, this.duration);
  }
}
