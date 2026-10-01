import * as THREE from 'three';
import { Tile, standHeight, type GameMap } from '../sim/map';
import type { AnimState, Model } from './models';

/*
 * Unit pose: purely visual attitude of unit roots on the terrain.
 *
 *  - Ground vehicles: the root (running gear) is aligned to the terrain under
 *    the footprint from 4 height samples (front / back along the heading,
 *    left / right at the track gauge), smoothed over time. The hull's own
 *    suspension (pitch under acceleration / braking, roll in turns, rough
 *    ground bounce, firing rock) is driven by the vehicle model's anim()
 *    from AnimState, using `AnimState.rough` computed here.
 *  - Infantry: a slight lean into turns and up slopes.
 *  - Aircraft: a soft ground-hugging shadow decal (AirShadows), one instanced
 *    draw call for every aircraft on screen.
 *
 * Nothing here allocates per frame.
 */

interface GroundPose {
  pitch: number;
  roll: number;
  tp: number; // last target pitch / roll (roughness from their change)
  tr: number;
  rough: number;
  init: boolean;
}
const poses = new WeakMap<Model, GroundPose>();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

function hAt(m: GameMap, x: number, z: number) {
  return standHeight(m, clamp(x, 0, m.w - 0.01), clamp(z, 0, m.h - 0.01));
}

/** Tile roughness for the suspension bounce (bridges / sand smooth, dirt and ore fields bumpy). */
function tileRough(m: GameMap, x: number, z: number): number {
  const tx = Math.floor(x);
  const tz = Math.floor(z);
  if (tx < 0 || tz < 0 || tx >= m.w || tz >= m.h) return 0.3;
  const i = tz * m.w + tx;
  if (m.ore[i] > 0) return 0.75;
  switch (m.tiles[i] as Tile) {
    case Tile.Bridge:
      return 0.08;
    case Tile.Sand:
      return 0.25;
    case Tile.Dirt:
      return 0.55;
    case Tile.Water:
      return 0.15;
    default:
      return 0.35;
  }
}

/**
 * Ground vehicle root: terrain-aligned pitch / roll (smoothed) and a hull
 * height that keeps the footprint ends out of dips. Writes `a.rough`.
 * `p` is the unit's interpolated ground position (y = stand height at its centre).
 */
export function poseGroundVehicle(model: Model, a: AnimState, map: GameMap, p: THREE.Vector3, yaw: number, dt: number, visible: boolean) {
  const root = model.root;
  let s = poses.get(model);
  if (!s) {
    s = { pitch: 0, roll: 0, tp: 0, tr: 0, rough: 0, init: false };
    poses.set(model, s);
  }
  // hidden units keep their last attitude (no sampling)
  if (!visible && s.init) {
    root.position.y = p.y;
    _e.set(s.roll, yaw, s.pitch);
    root.quaternion.setFromEuler(_e);
    return;
  }
  const size = model.size;
  const hl = clamp((size ? size.x : 0.8) * 0.42, 0.14, 0.6);
  const hw = clamp(model.trackGauge ?? (size ? size.z * 0.4 : 0.25), 0.1, 0.4);
  // local +X (forward) = (cos f, sin f) in map x / z with f = -yaw; local +Z (right) = (-sin f, cos f)
  const fx = Math.cos(yaw);
  const fz = -Math.sin(yaw);
  const hF = hAt(map, p.x + fx * hl, p.z + fz * hl);
  const hB = hAt(map, p.x - fx * hl, p.z - fz * hl);
  const hR = hAt(map, p.x - fz * hw, p.z + fx * hw);
  const hL = hAt(map, p.x + fz * hw, p.z - fx * hw);
  // nose up = +rotation.z; right side down = +rotation.x
  const tp = Math.atan2(hF - hB, 2 * hl);
  const tr = Math.atan2(hL - hR, 2 * hw);
  if (!s.init) {
    s.pitch = tp;
    s.roll = tr;
    s.tp = tp;
    s.tr = tr;
    s.init = true;
  } else if (dt > 0) {
    // heavier hulls settle a little slower than light trucks
    const k = Math.min(1, dt * (model.wheeled ? 11 : 8));
    s.pitch += (tp - s.pitch) * k;
    s.roll += (tr - s.roll) * k;
    // roughness: how fast the ground attitude changes under the moving hull, plus the surface itself
    const bump = Math.abs(tp - s.tp) + Math.abs(tr - s.tr);
    const moved = a.speed * dt;
    const curv = moved > 1e-4 ? clamp((bump / moved) * 0.35, 0, 1) : 0;
    const tgt = clamp(tileRough(map, p.x, p.z) + curv, 0, 1);
    s.rough += (tgt - s.rough) * Math.min(1, dt * 3);
  }
  s.tp = tp;
  s.tr = tr;
  a.rough = s.rough;
  // in a dip the hull rides on its ends; on a crest it rests on its middle
  root.position.y = Math.max(p.y, (hF + hB) * 0.5, (hL + hR) * 0.5);
  _e.set(s.roll, yaw, s.pitch);
  root.quaternion.setFromEuler(_e);
}

interface FootPose {
  lean: number;
  slope: number;
}
const feet = new WeakMap<Model, FootPose>();

/** Infantry root: lean into turns while moving and forward up slopes. */
export function poseInfantry(model: Model, a: AnimState, map: GameMap, p: THREE.Vector3, yaw: number, dt: number) {
  let s = feet.get(model);
  if (!s) {
    s = { lean: 0, slope: 0 };
    feet.set(model, s);
  }
  if (dt > 0 && a.dead <= 0) {
    const run = clamp(a.speed / 1.2, 0, 1);
    // turning left (+turn) leans the body left: top toward -Z = -rotation.x
    const lt = clamp(-a.turn * a.speed * 0.08, -0.14, 0.14);
    let st = 0;
    if (run > 0.05) {
      const fx = Math.cos(yaw) * 0.2;
      const fz = -Math.sin(yaw) * 0.2;
      // uphill: lean forward (nose down = -rotation.z); downhill: lean back a touch
      st = clamp(-Math.atan2(hAt(map, p.x + fx, p.z + fz) - hAt(map, p.x - fx, p.z - fz), 0.4) * 0.45, -0.12, 0.08) * run;
    }
    const k = Math.min(1, dt * 6);
    s.lean += (lt - s.lean) * k;
    s.slope += (st - s.slope) * k;
  }
  _e.set(s.lean, yaw, s.slope);
  model.root.quaternion.setFromEuler(_e);
}

// ------------------------------------------------------------- aircraft shadows

const SHADOW_MAX = 96;
let shadowTex: THREE.Texture | null = null;

/** Two soft silhouettes side by side: [rotorcraft | fixed wing], nose toward +u. */
function shadowTexture(): THREE.Texture {
  if (shadowTex) return shadowTex;
  const W = 256;
  const H = 128;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  const blob = (cx: number, cy: number, rx: number, ry: number, a: number) => {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(rx, ry);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(0.55, `rgba(255,255,255,${a * 0.75})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };
  ctx.globalCompositeOperation = 'lighter';
  // rotorcraft: faint rotor disc + fuselage + tail boom
  blob(64, 64, 58, 58, 0.22);
  blob(74, 64, 34, 13, 0.6);
  blob(30, 64, 30, 5, 0.45);
  // fixed wing (nose at the right): softened polygon via shadowBlur (works on iOS Safari, unlike ctx.filter)
  ctx.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.shadowColor = 'rgba(255,255,255,0.95)';
  ctx.shadowBlur = 7;
  ctx.shadowOffsetX = 1000; // draw off-canvas, keep only the blurred shadow
  ctx.fillStyle = '#fff';
  const ox = 128 - 1000;
  const P = (pts: number[][]) => {
    ctx.beginPath();
    ctx.moveTo(ox + pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(ox + pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fill();
  };
  // fuselage
  P([[124, 64], [112, 58], [60, 57], [10, 59], [10, 69], [60, 71], [112, 70]]);
  // swept wings
  P([[86, 60], [38, 12], [26, 12], [40, 60], [40, 68], [26, 116], [38, 116], [86, 68]]);
  // tailplanes
  P([[28, 60], [8, 38], [2, 38], [10, 60], [10, 68], [2, 90], [8, 90], [28, 68]]);
  ctx.restore();
  // keep the texture borders clear (no bleeding at quad edges)
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, 2);
  ctx.fillRect(0, H - 2, W, 2);
  ctx.fillRect(0, 0, 2, H);
  ctx.fillRect(W - 2, 0, 2, H);
  ctx.fillRect(127, 0, 2, H);
  shadowTex = new THREE.CanvasTexture(cv);
  shadowTex.colorSpace = THREE.NoColorSpace;
  return shadowTex;
}

/** Soft ground shadows under aircraft: one InstancedMesh, filled each frame between begin() and end(). */
export class AirShadows {
  private mesh: THREE.InstancedMesh | null = null;
  private alpha: THREE.InstancedBufferAttribute | null = null;
  private cell: THREE.InstancedBufferAttribute | null = null;
  private n = 0;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private nrm = new THREE.Vector3();
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  begin(scene: THREE.Scene) {
    if (!this.mesh) {
      const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
      this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(SHADOW_MAX), 1);
      this.cell = new THREE.InstancedBufferAttribute(new Float32Array(SHADOW_MAX), 1);
      this.alpha.setUsage(THREE.DynamicDrawUsage);
      this.cell.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aAlpha', this.alpha);
      geo.setAttribute('aCell', this.cell);
      const mat = new THREE.ShaderMaterial({
        uniforms: { map: { value: shadowTexture() } },
        vertexShader: /* glsl */ `
          attribute float aAlpha;
          attribute float aCell;
          varying vec2 vUv;
          varying float vA;
          void main() {
            vUv = vec2((uv.x + aCell) * 0.5, uv.y);
            vA = aAlpha;
            gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D map;
          varying vec2 vUv;
          varying float vA;
          void main() {
            float a = texture2D(map, vUv).g * vA;
            if (a < 0.004) discard;
            gl_FragColor = vec4(0.02, 0.02, 0.035, a);
          }`,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      this.mesh = new THREE.InstancedMesh(geo, mat, SHADOW_MAX);
      this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.mesh.frustumCulled = false;
      this.mesh.renderOrder = 1;
      this.mesh.count = 0;
      scene.add(this.mesh);
    }
    this.n = 0;
  }

  /**
   * One aircraft: (x, z) ground position, yaw of the root, alt = height above the ground,
   * len / wid = airframe size, rotor = rotorcraft silhouette.
   */
  add(map: GameMap, x: number, z: number, yaw: number, alt: number, len: number, wid: number, rotor: boolean) {
    if (!this.mesh || this.n >= SHADOW_MAX) return;
    const i = this.n++;
    const r = Math.max(0.2, len * 0.5);
    const h0 = hAt(map, x, z);
    const hx = hAt(map, x + r, z) - hAt(map, x - r, z);
    const hz = hAt(map, x, z + r) - hAt(map, x, z - r);
    this.nrm.set(-hx / (2 * r), 1, -hz / (2 * r)).normalize();
    this.q.setFromUnitVectors(AirShadows.UP, this.nrm);
    this.q2.setFromAxisAngle(AirShadows.UP, yaw);
    this.q.multiply(this.q2);
    // higher = larger, softer, fainter (fades in as it lifts off so it doesn't double the shadow map at rest)
    const spread = 1 + Math.min(alt, 6) * 0.07;
    this.s.set(len * 1.1 * spread, 1, (rotor ? len : wid) * 1.1 * spread);
    this.v.set(x, h0 + 0.05, z);
    this.m4.compose(this.v, this.q, this.s);
    this.mesh.setMatrixAt(i, this.m4);
    const lift = clamp((alt - 0.15) / 0.5, 0, 1);
    this.alpha!.setX(i, 0.55 * lift * clamp(1.15 - alt / 7, 0.3, 1));
    this.cell!.setX(i, rotor ? 0 : 1);
  }

  end() {
    if (!this.mesh) return;
    this.mesh.count = this.n;
    if (this.n) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.alpha!.needsUpdate = true;
      this.cell!.needsUpdate = true;
    }
  }
}
