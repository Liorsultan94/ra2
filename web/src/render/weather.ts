import * as THREE from 'three';
import { groundHeight, type GameMap } from '../sim/map';

/*
 * Falling weather particles (rain streaks, snow flakes, blowing sand) in a
 * box that follows the view. Everything moves on the GPU: each particle is a
 * seed; its position is seed * box + velocity * time, wrapped into the box
 * around the view centre in world space, so panning never pops. One
 * instanced draw call; the count scales with quality.
 */

const KIND = { rain: 0, snow: 1, sandstorm: 2 } as const;

const VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime;
uniform vec3 uCenter;
uniform vec3 uBox;
uniform vec3 uVel;
uniform vec2 uSize;
uniform float uKind;
uniform float uSway;
varying vec2 vUv;
varying float vA;
void main() {
  float spd = 0.75 + 0.5 * aSeed.w;
  vec3 p = aSeed.xyz * uBox + uVel * spd * uTime;
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
  private mat: THREE.ShaderMaterial;
  private u: Record<string, THREE.IUniform>;
  private boxStep = -1;
  private nextBolt: number;
  private boltT = -1;

  constructor(
    readonly kind: 'rain' | 'snow' | 'sandstorm',
    quality: 'low' | 'medium' | 'high',
    tod: 'day' | 'dusk' | 'night',
  ) {
    const qk = quality === 'high' ? 1 : quality === 'medium' ? 0.6 : 0.3;
    const n = Math.round((kind === 'rain' ? 6500 : kind === 'snow' ? 4500 : 4200) * qk);
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    const seeds = new Float32Array(n * 4);
    let s = 1234567;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < n * 4; i++) seeds[i] = rnd();
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = n;
    const lightK = tod === 'night' ? 0.32 : tod === 'dusk' ? 0.7 : 1;
    const color = kind === 'rain' ? new THREE.Color(0.62, 0.68, 0.76) : kind === 'snow' ? new THREE.Color(0.95, 0.97, 1) : new THREE.Color(0.78, 0.56, 0.32);
    color.multiplyScalar(lightK);
    this.u = {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(30, 15, 30) },
      uVel: { value: kind === 'rain' ? new THREE.Vector3(1.4, -15, 0.7) : kind === 'snow' ? new THREE.Vector3(0.35, -1.0, 0.18) : new THREE.Vector3(9, -0.35, 3.2) },
      uSize: { value: kind === 'rain' ? new THREE.Vector2(0.03, 0.75) : kind === 'snow' ? new THREE.Vector2(0.075, 0) : new THREE.Vector2(0.035, 1.3) },
      uKind: { value: KIND[kind] },
      uSway: { value: kind === 'snow' ? 0.45 : 0.6 },
      uColor: { value: color },
      uAlpha: { value: kind === 'rain' ? 0.42 : kind === 'snow' ? 0.85 : 0.3 },
      uFlash: { value: 0 },
    };
    this.mat = new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, toneMapped: false });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.name = 'weather';
    this.nextBolt = kind === 'rain' ? 4 + Math.random() * 6 : Infinity;
  }

  /** Move the particle box with the view; returns the lightning flash level 0..1. */
  update(_dt: number, time: number, target: THREE.Vector3, zoom: number, camera: THREE.Camera, map: GameMap): number {
    const u = this.u;
    u.uTime.value = time;
    // visible world height at the view centre; the box is resized in coarse steps (a resize re-wraps the particles)
    const vh = 22 / Math.max(0.3, zoom);
    const step = Math.round(Math.log2(vh) * 2);
    if (step !== this.boxStep) {
      this.boxStep = step;
      const q = Math.pow(2, step / 2);
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
    const off = box.x * 0.12;
    (u.uCenter.value as THREE.Vector3).set(target.x + (dx / dl) * off, groundHeight(map, gx, gz) + box.y * 0.5 - 0.6, target.z + (dz / dl) * off);
    // lightning: a few quick flickers
    let flash = 0;
    if (time >= this.nextBolt) {
      this.nextBolt = time + 7 + Math.random() * 12;
      this.boltT = time;
      this.struck = true;
    }
    if (this.boltT >= 0) {
      const t = time - this.boltT;
      if (t > 0.9) this.boltT = -1;
      else flash = Math.max(0, 1 - t / 0.09) + Math.max(0, 0.7 - Math.abs(t - 0.22) / 0.06) + Math.max(0, 0.45 - Math.abs(t - 0.42) / 0.1) * 0.8;
    }
    flash = Math.min(1, flash);
    u.uFlash.value = flash;
    return flash;
  }
}
