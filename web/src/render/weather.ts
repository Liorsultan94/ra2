import * as THREE from 'three';
import { groundHeight, type GameMap } from '../sim/map';
import { WetGlints } from './wetglints';

/*
 * Falling weather particles (rain streaks, snow flakes, blowing sand) in a
 * box that follows the view. Everything moves on the GPU: each particle is a
 * seed; its position is seed * box + velocity * time, wrapped into the box
 * around the view centre in world space, so panning never pops. One
 * instanced draw call; the count scales with quality.
 *
 * Dynamic weather (weathercycle.ts) keeps one instance of this alive for the
 * whole battle: setKind / setIntensity / setWind only change uniforms and the
 * drawn instance count, so nothing recompiles while the weather turns. The
 * travelled distance is integrated on the CPU (uOff) so wind shifts don't
 * make the particles jump.
 */

const KIND = { rain: 0, snow: 1, sandstorm: 2 } as const;
export type FallKind = keyof typeof KIND;

/** Per-kind look: fall velocity (calm air), particle size, sway, colour, opacity, count at high quality. */
const LOOK: Record<FallKind, { vel: [number, number, number]; size: [number, number]; sway: number; color: [number, number, number]; alpha: number; n: number }> = {
  rain: { vel: [1.4, -15, 0.7], size: [0.022, 0.5], sway: 0.6, color: [0.55, 0.6, 0.68], alpha: 0.2, n: 6500 },
  snow: { vel: [0.35, -1.0, 0.18], size: [0.075, 0], sway: 0.45, color: [0.95, 0.97, 1], alpha: 0.85, n: 4500 },
  sandstorm: { vel: [9, -0.35, 3.2], size: [0.03, 0.9], sway: 0.6, color: [0.78, 0.56, 0.32], alpha: 0.15, n: 4200 },
};

const VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform vec3 uCenter;
uniform vec3 uBox;
uniform vec3 uVel;
uniform vec3 uOff;
uniform vec2 uSize;
uniform float uKind;
uniform float uSway;
varying vec2 vUv;
varying float vA;
void main() {
  float spd = 0.75 + 0.5 * aSeed.w;
  vec3 p = aSeed.xyz * uBox + uOff * spd;
  if (uKind > 0.5) {
    float ph = uTime * (0.5 + aSeed.w) + aSeed.x * 40.0;
    p.x += sin(ph) * uSway;
    p.z += cos(ph * 0.8 + aSeed.z * 20.0) * uSway;
    p.y += sin(ph * 1.3 + aSeed.y * 9.0) * uSway * 0.4;
  }
  vec3 rel = mod(p - uCenter + 0.5 * uBox, uBox) - 0.5 * uBox;
  vec3 wp = uCenter + rel;
  vec3 e = abs(rel) / (0.5 * uBox);
  vA = (1.0 - smoothstep(0.65, 1.0, max(e.x, e.z))) * (1.0 - smoothstep(0.7, 1.0, e.y));
  vUv = position.xy + 0.5;
  if (abs(uKind - 1.0) > 0.5) {
    // streak along the velocity, turned to face the camera
    vec3 axis = normalize(uVel);
    vec3 toCam = normalize(cameraPosition - wp);
    vec3 side = normalize(cross(axis, toCam));
    wp += side * position.x * uSize.x + axis * position.y * uSize.y * spd;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  } else {
    vec4 mv = viewMatrix * vec4(wp, 1.0);
    mv.xy += position.xy * uSize.x * (0.6 + 0.8 * aSeed.w);
    gl_Position = projectionMatrix * mv;
  }
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uKind;
uniform float uFlash;
varying vec2 vUv;
varying float vA;
void main() {
  float a;
  if (uKind < 0.5) a = (1.0 - abs(vUv.x * 2.0 - 1.0)) * smoothstep(0.0, 0.6, vUv.y);
  else if (uKind < 1.5) a = smoothstep(0.5, 0.15, length(vUv - 0.5));
  else a = (1.0 - abs(vUv.x * 2.0 - 1.0)) * sin(vUv.y * 3.14159);
  a *= uAlpha * vA;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor * (1.0 + uFlash * 2.5), a);
}`;

export class WeatherFx {
  readonly mesh: THREE.Mesh;
  /** Set when lightning strikes this frame (the atmosphere schedules the thunder). */
  struck = false;
  /** Random lightning while it rains (static rain); dynamic weather calls strike() itself. */
  autoBolts: boolean;
  kind: FallKind;
  private mat: THREE.ShaderMaterial;
  private geo: THREE.InstancedBufferGeometry;
  private u: Record<string, THREE.IUniform>;
  private boxStep = -1;
  private nextBolt: number;
  private boltT = -1;
  private n: number;
  private qk: number;
  private intensity = 1;
  private lightK: number;
  private baseColor = new THREE.Color();
  /** Calm-air fall velocity of the kind and the current wind (world units / s). */
  private vel0 = new THREE.Vector3();
  private wind = new THREE.Vector3();
  private lastT = -1;
  private dynamic: boolean;
  private quality: 'low' | 'medium' | 'high';
  /** Light reflections in the wet ground (medium / high; wetglints.ts), added next to the particles. */
  glints: WetGlints | null = null;

  constructor(
    kind: FallKind,
    quality: 'low' | 'medium' | 'high',
    tod: 'day' | 'dusk' | 'night',
    /** Dynamic weather: size the pool for the densest kind and start with nothing falling. */
    dynamic = false,
  ) {
    this.kind = kind;
    this.dynamic = dynamic;
    this.quality = quality;
    const qk = (this.qk = quality === 'high' ? 1 : quality === 'medium' ? 0.6 : 0.3);
    const n = (this.n = Math.round((dynamic ? LOOK.rain.n : LOOK[kind].n) * qk));
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = (this.geo = new THREE.InstancedBufferGeometry());
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    const seeds = new Float32Array(n * 4);
    let s = 1234567;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < n * 4; i++) seeds[i] = rnd();
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = n;
    this.lightK = tod === 'night' ? 0.32 : tod === 'dusk' ? 0.7 : 1;
    this.u = {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(30, 15, 30) },
      uVel: { value: new THREE.Vector3() },
      uOff: { value: new THREE.Vector3() },
      uSize: { value: new THREE.Vector2() },
      uKind: { value: 0 },
      uSway: { value: 0 },
      uColor: { value: new THREE.Color() },
      uAlpha: { value: 0 },
      uFlash: { value: 0 },
    };
    this.setKind(kind);
    this.mat = new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, toneMapped: false });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.name = 'weather';
    this.autoBolts = !dynamic && kind === 'rain';
    this.nextBolt = this.autoBolts ? 4 + Math.random() * 6 : Infinity;
    if (dynamic) this.setIntensity(0);
  }

  /** Switch what falls (uniforms only: same program). */
  setKind(kind: FallKind) {
    this.kind = kind;
    const L = LOOK[kind];
    const u = this.u;
    u.uKind.value = KIND[kind];
    this.vel0.set(...L.vel);
    (u.uSize.value as THREE.Vector2).set(...L.size);
    u.uSway.value = L.sway;
    this.baseColor.setRGB(...L.color);
    (u.uColor.value as THREE.Color).copy(this.baseColor).multiplyScalar(this.lightK);
    this.setIntensity(this.intensity);
    this.applyVel();
  }

  /**
   * How hard it falls, 0..1: the number of drawn particles ramps (cheap when light)
   * and the streaks get a little more opaque in a downpour.
   */
  setIntensity(k: number) {
    k = Math.max(0, Math.min(1, k));
    this.intensity = k;
    const full = Math.round(LOOK[this.kind].n * this.qk);
    const cnt = Math.min(this.n, Math.round(full * Math.min(1, k * 1.15)));
    this.geo.instanceCount = Math.max(1, cnt);
    if (this.mesh) this.mesh.visible = cnt > 0;
    this.u.uAlpha.value = LOOK[this.kind].alpha * (0.55 + 0.45 * k);
  }

  /** Horizontal wind (world units / s): leans the rain, blows the snow and drives the sand. */
  setWind(x: number, z: number) {
    this.wind.set(x, 0, z);
    this.applyVel();
  }

  private applyVel() {
    const v = this.u.uVel.value as THREE.Vector3;
    // rain leans with the wind; snow and sand are carried by it
    const carry = this.kind === 'rain' ? 1 : this.kind === 'snow' ? 1.3 : 1.6;
    v.copy(this.vel0);
    // dynamic weather: blowing sand goes wherever the wind does (static sandstorm keeps its fixed drift)
    if (this.dynamic && this.kind === 'sandstorm') v.set(0, v.y, 0);
    v.addScaledVector(this.wind, carry);
    // streak axis needs a direction even in dead calm
    if (v.lengthSq() < 1e-4) v.y = -0.3;
  }

  /** Lightning now (dynamic weather drives the timing deterministically). */
  strike(time: number) {
    this.boltT = time;
    this.struck = true;
  }

  /** Dynamic day / night cycle: scale the particle colour by the daylight (1 = day, ~0.32 = night). */
  setLight(k: number) {
    this.lightK = k;
    (this.u.uColor.value as THREE.Color).copy(this.baseColor).multiplyScalar(k);
  }

  /** Move the particle box with the view; returns the lightning flash level 0..1. */
  update(dt: number, time: number, target: THREE.Vector3, zoom: number, camera: THREE.Camera, map: GameMap): number {
    const u = this.u;
    u.uTime.value = time;
    // travelled distance (wrapped now and then: a reshuffle of the random drops is invisible)
    const step = this.lastT < 0 ? time : Math.max(0, Math.min(0.25, dt));
    this.lastT = time;
    const off = u.uOff.value as THREE.Vector3;
    off.addScaledVector(u.uVel.value as THREE.Vector3, step);
    if (Math.abs(off.x) > 4000 || Math.abs(off.y) > 4000 || Math.abs(off.z) > 4000) off.set(0, 0, 0);
    // visible world height at the view centre; the box is resized in coarse steps (a resize re-wraps the particles)
    const vh = 22 / Math.max(0.3, zoom);
    const bstep = Math.round(Math.log2(vh) * 2);
    if (bstep !== this.boxStep) {
      this.boxStep = bstep;
      const q = Math.pow(2, bstep / 2);
      const bx = Math.min(80, Math.max(14, q * 1.9));
      (u.uBox.value as THREE.Vector3).set(bx, Math.min(40, Math.max(7, q * 0.85)), bx);
    }
    const box = u.uBox.value as THREE.Vector3;
    const gx = Math.max(0, Math.min(map.w - 0.01, target.x));
    const gz = Math.max(0, Math.min(map.h - 0.01, target.z));
    // centre a little towards the camera so the near side of the view is covered too
    const cp = camera.position;
    const dx = cp.x - target.x;
    const dz = cp.z - target.z;
    const dl = Math.hypot(dx, dz) || 1;
    const bo = box.x * 0.12;
    (u.uCenter.value as THREE.Vector3).set(target.x + (dx / dl) * bo, groundHeight(map, gx, gz) + box.y * 0.5 - 0.6, target.z + (dz / dl) * bo);
    // lightning: a few quick flickers
    let flash = 0;
    if (this.autoBolts && time >= this.nextBolt) {
      this.nextBolt = time + 7 + Math.random() * 12;
      this.strike(time);
    }
    if (this.boltT >= 0) {
      const t = time - this.boltT;
      if (t > 0.9) this.boltT = -1;
      else flash = Math.max(0, 1 - t / 0.09) + Math.max(0, 0.7 - Math.abs(t - 0.22) / 0.06) + Math.max(0, 0.45 - Math.abs(t - 0.42) / 0.1) * 0.8;
    }
    flash = Math.min(1, flash);
    u.uFlash.value = flash;
    // wet ground mirrors the lamps and headlights
    const scene = this.mesh.parent;
    if (scene && this.quality !== 'low') {
      const g = (this.glints ??= new WetGlints(map, this.quality));
      if (g.mesh.parent !== scene) scene.add(g.mesh);
      g.update(scene, camera, time);
    }
    return flash;
  }
}
