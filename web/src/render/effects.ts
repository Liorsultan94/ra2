import * as THREE from 'three';
import { Tile, standHeight } from '../sim/map';
import type { Debris, DebrisKind } from './debris';
import type { FogOfWar } from './fog';
import { GrassFires } from './fx/fires';
import { Flyers } from './fx/flyers';
import { HazeField } from './fx/haze';
import { FxLights } from './fx/lights';
import { CameraShake } from './fx/shake';
import { Tracers } from './fx/tracers';
import type { GroundMarks } from './marks';

const TMP_C = new THREE.Color();

function makeSpriteTexture(kind: 'glow' | 'smoke'): THREE.Texture {
  const s = kind === 'smoke' ? 128 : 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  if (kind === 'glow') {
    // hot core with a turbulent, flame-like edge
    const img = ctx.createImageData(s, s);
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++) {
        const nx = x / s - 0.5;
        const ny = y / s - 0.5;
        const r = Math.hypot(nx, ny) * 2;
        const a = Math.atan2(ny, nx);
        const turb = 0.75 + 0.25 * Math.sin(a * 5 + Math.sin(a * 3) * 2) * Math.sin(r * 9);
        const core = Math.max(0, 1 - r / turb);
        const v = Math.pow(core, 1.8);
        const o = (y * s + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
        img.data[o + 3] = Math.min(255, v * 255);
      }
    ctx.putImageData(img, 0, 0);
  } else {
    // soft billowy smoke: radial falloff modulated by multi-octave noise
    const img = ctx.createImageData(s, s);
    const rnd = (x: number, y: number, k: number) => {
      const h = Math.sin(x * 127.1 + y * 311.7 + k * 74.7) * 43758.5453;
      return h - Math.floor(h);
    };
    const noise = (x: number, y: number, f: number, k: number) => {
      const xi = Math.floor(x * f);
      const yi = Math.floor(y * f);
      const xf = x * f - xi;
      const yf = y * f - yi;
      const u = xf * xf * (3 - 2 * xf);
      const v = yf * yf * (3 - 2 * yf);
      const a = rnd(xi, yi, k);
      const b = rnd(xi + 1, yi, k);
      const c2 = rnd(xi, yi + 1, k);
      const d = rnd(xi + 1, yi + 1, k);
      return a + (b - a) * u + (c2 - a) * v + (a - b - c2 + d) * u * v;
    };
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++) {
        const nx = x / s;
        const ny = y / s;
        const r = Math.hypot(nx - 0.5, ny - 0.5) * 2;
        const n = noise(nx, ny, 4, 1) * 0.5 + noise(nx, ny, 8, 2) * 0.3 + noise(nx, ny, 16, 3) * 0.2;
        const fall = Math.max(0, 1 - r * (0.85 + (1 - n) * 0.5));
        const a = Math.pow(fall, 1.6) * (0.55 + n * 0.6);
        const shade = 0.78 + n * 0.22;
        const o = (y * s + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = shade * 255;
        img.data[o + 3] = Math.min(255, a * 255);
      }
    ctx.putImageData(img, 0, 0);
  }
  const t = new THREE.CanvasTexture(c);
  return t;
}

export interface ParticleOpts {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  life: number;
  size: number;
  sizeEnd?: number;
  color: number;
  colorEnd?: number;
  alpha?: number;
  drag?: number;
  gravity?: number;
  /** How strongly the global wind pushes the particle (acceleration factor, 0 = none). */
  wind?: number;
}

class ParticleSystem {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  private rot: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private s0: Float32Array;
  private s1: Float32Array;
  private c0: Float32Array;
  private c1: Float32Array;
  private a0: Float32Array;
  private drag: Float32Array;
  private grav: Float32Array;
  private wind: Float32Array;
  private count = 0;
  private geo: THREE.BufferGeometry;
  readonly material: THREE.ShaderMaterial;

  constructor(
    private max: number,
    additive: boolean,
    fog: FogOfWar,
  ) {
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.rot = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.c0 = new Float32Array(max * 3);
    this.c1 = new Float32Array(max * 3);
    this.a0 = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.wind = new Float32Array(max);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('rot', new THREE.BufferAttribute(this.rot, 1).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: {
        tex: { value: makeSpriteTexture(additive ? 'glow' : 'smoke') },
        scale: { value: 30 },
        refDist: { value: 0 },
        ...fog.uniforms,
      },
      vertexShader: /* glsl */ `
        attribute float size;
        attribute float alpha;
        attribute float rot;
        attribute vec3 color;
        varying float vRot;
        uniform float scale;
        uniform float refDist; // perspective camera: distance at which scale applies (0 = orthographic)
        uniform sampler2D fogTex;
        uniform vec2 fogSize;
        uniform float fogEnabled;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = color;
          vRot = rot;
          float fogV = texture2D(fogTex, position.xz / fogSize).r;
          vAlpha = alpha * mix(1.0, smoothstep(0.55, 0.85, fogV), fogEnabled);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * scale * ( refDist > 0.0 ? refDist / max( 0.1, -mv.z ) : 1.0 );
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tex;
        varying vec3 vColor;
        varying float vAlpha;
        varying float vRot;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float cs = cos(vRot);
          float sn = sin(vRot);
          vec2 uv = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) + 0.5;
          vec4 t = texture2D(tex, uv);
          gl_FragColor = vec4(vColor * t.rgb, t.a * vAlpha);
        }`,
    });
    this.points = new THREE.Points(this.geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
  }

  spawn(o: ParticleOpts) {
    if (this.count >= this.max) return;
    const i = this.count++;
    const i3 = i * 3;
    this.pos[i3] = o.x;
    this.pos[i3 + 1] = o.y;
    this.pos[i3 + 2] = o.z;
    this.vel[i3] = o.vx ?? 0;
    this.vel[i3 + 1] = o.vy ?? 0;
    this.vel[i3 + 2] = o.vz ?? 0;
    this.life[i] = 0;
    this.maxLife[i] = o.life;
    this.s0[i] = o.size;
    this.s1[i] = o.sizeEnd ?? o.size;
    this.size[i] = 0;
    this.alpha[i] = 0;
    TMP_C.setHex(o.color);
    this.c0[i3] = TMP_C.r;
    this.c0[i3 + 1] = TMP_C.g;
    this.c0[i3 + 2] = TMP_C.b;
    if (o.colorEnd !== undefined) TMP_C.setHex(o.colorEnd);
    this.c1[i3] = TMP_C.r;
    this.c1[i3 + 1] = TMP_C.g;
    this.c1[i3 + 2] = TMP_C.b;
    this.a0[i] = o.alpha ?? 1;
    this.rot[i] = Math.random() * 6.283;
    this.drag[i] = o.drag ?? 0;
    this.grav[i] = o.gravity ?? 0;
    this.wind[i] = o.wind ?? 0;
  }

  update(dt: number, wx = 0, wz = 0) {
    let i = 0;
    while (i < this.count) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) {
        this.kill(i);
        continue;
      }
      const t = this.life[i] / this.maxLife[i];
      const k = Math.max(0, 1 - this.drag[i] * dt);
      const wk = this.wind[i] * dt;
      this.vel[i * 3] = this.vel[i * 3] * k + wx * wk;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.grav[i] * dt;
      this.vel[i * 3 + 2] = this.vel[i * 3 + 2] * k + wz * wk;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      for (let c = 0; c < 3; c++) this.col[i * 3 + c] = this.c0[i * 3 + c] + (this.c1[i * 3 + c] - this.c0[i * 3 + c]) * t;
      this.alpha[i] = this.a0[i] * (t < 0.1 ? t * 10 : 1 - (t - 0.1) / 0.9);
      i++;
    }
    this.geo.setDrawRange(0, this.count);
    for (const a of ATTRS) (this.geo.attributes[a] as THREE.BufferAttribute).needsUpdate = true;
  }

  private ones: Float32Array[] | null = null;
  private threes: Float32Array[] | null = null;
  private kill(i: number) {
    const j = --this.count;
    if (i === j) return;
    const threes = (this.threes ??= [this.pos, this.vel, this.col, this.c0, this.c1]);
    const ones = (this.ones ??= [this.size, this.alpha, this.rot, this.life, this.maxLife, this.s0, this.s1, this.a0, this.drag, this.grav, this.wind]);
    for (const a of threes) a.copyWithin(i * 3, j * 3, j * 3 + 3);
    for (const a of ones) a[i] = a[j];
  }

  get capacity() {
    return this.max;
  }

  get active() {
    return this.count;
  }
}

const ATTRS = ['position', 'color', 'size', 'alpha', 'rot'];

interface Timed {
  obj: THREE.Object3D;
  mat: THREE.Material & { opacity: number };
  life: number;
  max: number;
  grow?: number;
  base?: number;
  alpha0?: number;
}

/** How an explosion looks. Sizes are in tiles. */
export interface BlastProfile {
  size: number; // overall scale
  fire: number; // fireball particle count multiplier (0 = none)
  fireColor?: 'normal' | 'thermo' | 'laser' | 'white';
  sparks: number;
  smoke: number; // smoke cloud amount
  column?: boolean; // tall rising smoke column
  dirt: number; // earth thrown up (0 = none)
  ring: number; // ground shockwave dust ring radius (0 = none)
  debris?: { kind: DebrisKind; n: number; power: number; size: number }[];
  crater: number; // crater decal radius
  scorch: number;
  light: number;
  shake: number;
  afterburn?: number; // seconds of lingering flames (thermobaric)
}

export const BLASTS: Record<string, BlastProfile> = {
  bullet: { size: 0.15, fire: 0, sparks: 3, smoke: 0, dirt: 0.3, ring: 0, crater: 0, scorch: 0, light: 0, shake: 0 },
  flak: { size: 0.3, fire: 0.4, sparks: 6, smoke: 0.3, dirt: 0, ring: 0, crater: 0, scorch: 0, light: 0.6, shake: 0 },
  airSmall: { size: 0.5, fire: 0.6, sparks: 8, smoke: 0.6, dirt: 0, ring: 0, crater: 0, scorch: 0, light: 1.5, shake: 0 },
  shell: { size: 0.75, fire: 0.8, sparks: 10, smoke: 0.8, dirt: 1, ring: 0, debris: [{ kind: 'dirt', n: 6, power: 3, size: 0.06 }], crater: 0.35, scorch: 0, light: 3, shake: 0.03 },
  heat: { size: 0.7, fire: 0.7, sparks: 22, smoke: 0.7, dirt: 0.5, ring: 0, crater: 0.25, scorch: 0.35, light: 3, shake: 0.02 },
  artillery: { size: 1.3, fire: 1, sparks: 12, smoke: 1.2, column: true, dirt: 2.4, ring: 1.6, debris: [{ kind: 'dirt', n: 14, power: 5, size: 0.08 }], crater: 0.75, scorch: 0.6, light: 6, shake: 0.12 },
  mortar: { size: 1.0, fire: 0.8, sparks: 10, smoke: 1, dirt: 1.8, ring: 1.0, debris: [{ kind: 'dirt', n: 8, power: 4, size: 0.07 }], crater: 0.55, scorch: 0.4, light: 4, shake: 0.06 },
  rocket: { size: 1.0, fire: 1, sparks: 10, smoke: 1, dirt: 1.4, ring: 1.0, debris: [{ kind: 'dirt', n: 8, power: 4, size: 0.07 }], crater: 0.5, scorch: 0.5, light: 4, shake: 0.06 },
  thermo: { size: 1.7, fire: 2.6, fireColor: 'thermo', sparks: 10, smoke: 1.6, column: true, dirt: 1, ring: 2.6, crater: 0.6, scorch: 1.4, light: 10, shake: 0.2, afterburn: 2.5 },
  missile: { size: 1.4, fire: 1.3, sparks: 14, smoke: 1.4, column: true, dirt: 2, ring: 1.8, debris: [{ kind: 'dirt', n: 12, power: 5, size: 0.08 }], crater: 0.8, scorch: 0.8, light: 7, shake: 0.14 },
  ballistic: { size: 2.6, fire: 2.4, fireColor: 'white', sparks: 30, smoke: 2.6, column: true, dirt: 3.5, ring: 3.8, debris: [{ kind: 'dirt', n: 30, power: 8, size: 0.12 }, { kind: 'concrete', n: 10, power: 7, size: 0.1 }], crater: 1.6, scorch: 2, light: 16, shake: 0.45 },
  drone: { size: 0.75, fire: 0.9, sparks: 14, smoke: 0.8, dirt: 0.8, ring: 0.6, debris: [{ kind: 'metal', n: 5, power: 3, size: 0.04 }], crater: 0.3, scorch: 0.45, light: 3.5, shake: 0.04 },
  shahed: { size: 1.6, fire: 1.8, sparks: 20, smoke: 1.6, column: true, dirt: 2, ring: 2.2, debris: [{ kind: 'dirt', n: 14, power: 6, size: 0.09 }, { kind: 'metal', n: 6, power: 5, size: 0.05 }], crater: 0.9, scorch: 1.1, light: 9, shake: 0.2 },
  laser: { size: 0.4, fire: 0.5, fireColor: 'laser', sparks: 14, smoke: 0.3, dirt: 0, ring: 0, crater: 0, scorch: 0.2, light: 2, shake: 0 },
  vehicle: { size: 1.4, fire: 1.6, sparks: 26, smoke: 1.6, column: true, dirt: 0.8, ring: 1.4, debris: [{ kind: 'metal', n: 14, power: 6, size: 0.07 }, { kind: 'burnt', n: 8, power: 4, size: 0.09 }], crater: 0.5, scorch: 0.9, light: 9, shake: 0.18 },
  bigVehicle: { size: 2.0, fire: 2.2, sparks: 34, smoke: 2.2, column: true, dirt: 1, ring: 2.2, debris: [{ kind: 'metal', n: 22, power: 7, size: 0.08 }, { kind: 'burnt', n: 12, power: 5, size: 0.1 }], crater: 0.7, scorch: 1.3, light: 12, shake: 0.3 },
  aircraft: { size: 1.3, fire: 1.6, sparks: 24, smoke: 1.3, dirt: 0, ring: 0, debris: [{ kind: 'metal', n: 12, power: 4, size: 0.05 }], crater: 0, scorch: 0, light: 7, shake: 0.08 },
  building: { size: 2.0, fire: 2, sparks: 24, smoke: 2.4, column: true, dirt: 1.2, ring: 2.6, debris: [{ kind: 'concrete', n: 26, power: 6, size: 0.12 }, { kind: 'metal', n: 8, power: 5, size: 0.07 }, { kind: 'glass', n: 6, power: 5, size: 0.04 }], crater: 0, scorch: 1.6, light: 12, shake: 0.35 },
};

export class Effects {
  readonly group = new THREE.Group();
  readonly fire: ParticleSystem;
  readonly smokeSys: ParticleSystem;
  /** Dynamic light pool + ground light pools (see fx/lights.ts). */
  readonly lights: FxLights;
  /** Camera shake; the camera reads `shakeOffset()` every frame. */
  readonly shaker = new CameraShake();
  readonly tracers: Tracers;
  readonly flyers: Flyers;
  /** Screen-space heat haze / shockwaves (medium / high only, created by enableHaze). */
  haze: HazeField | null = null;
  private grass: GrassFires | null = null;
  private timed: Timed[] = [];
  private beamGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2);
  private ringGeo = new THREE.RingGeometry(0.92, 1, 48).rotateX(-Math.PI / 2);
  private sphereGeo = new THREE.SphereGeometry(1, 20, 12);
  private domeGeo = new THREE.SphereGeometry(1, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  debris: Debris | null = null;
  marks: GroundMarks | null = null;
  private burns: { x: number; y: number; z: number; t: number; size: number }[] = [];
  private later: { t: number; fn: () => void }[] = [];
  private threats = new Map<number, { seen: number; popped: number }>();
  private time = 0;
  /** Global wind (tiles / s^2 push on smoke); direction drifts slowly. */
  readonly wind = { x: 0.3, z: -0.18 };
  /** Particle budget multiplier (1 = quality default); lower it when the frame rate struggles. */
  budget = 1;
  private v1 = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    fog: FogOfWar,
    private quality: 'low' | 'medium' | 'high',
  ) {
    const mult = quality === 'low' ? 0.4 : quality === 'medium' ? 0.7 : 1;
    this.fire = new ParticleSystem(Math.floor(9000 * mult), true, fog);
    this.smokeSys = new ParticleSystem(Math.floor(12000 * mult), false, fog);
    this.lights = new FxLights(quality, fog);
    this.lights.heightAt = (x, z) => this.groundAt(x, z);
    this.tracers = new Tracers(quality === 'low' ? 64 : 160);
    this.tracers.onArrive = (x, y, z) => {
      if (Math.random() < 0.6) this.fire.spawn({ x, y, z, vx: this.rand(-1, 1), vy: this.rand(0.5, 1.5), vz: this.rand(-1, 1), life: 0.12, size: 0.05, color: 0xffe0a0, gravity: 6 });
    };
    const sink = {
      spawnFire: (o: ParticleOpts) => this.fire.spawn(o),
      spawnSmoke: (o: ParticleOpts) => this.smokeSys.spawn(o),
      lights: this.lights,
      groundAt: (x: number, z: number) => this.groundAt(x, z),
    };
    this.flyers = new Flyers(sink, quality === 'low' ? 40 : quality === 'medium' ? 80 : 140);
    this.group.add(this.fire.points, this.smokeSys.points, this.lights.group, this.tracers.mesh);
    scene.add(this.group);
  }

  /** Turn on screen-space heat haze (medium / high quality); hand the result to the final post pass. */
  enableHaze(camera: THREE.Camera): HazeField | null {
    if (this.quality === 'low') return null;
    this.haze ??= new HazeField(camera, this.quality);
    return this.haze;
  }

  /** Point the dynamic lights and the camera shake at the view centre (the camera target; kept by reference). */
  setView(v: THREE.Vector3, camera?: THREE.Camera) {
    this.lights.view = v;
    this.shaker.view = v;
    this.camera = camera ?? null;
  }
  private camera: THREE.Camera | null = null;

  /** Perspective cameras: point sprites are sized for the view-centre distance and scaled by depth. */
  private updatePerspective() {
    const c = this.camera as THREE.PerspectiveCamera | null;
    const v = this.lights.view;
    const ref = c && c.isPerspectiveCamera && v ? c.position.distanceTo(v) : 0;
    this.fire.material.uniforms.refDist.value = ref;
    this.smokeSys.material.uniforms.refDist.value = ref;
    this.haze?.setPerspective(ref, this.camera);
  }

  /** Add camera shake (0.03 small .. 0.45 huge), attenuated by distance to the view centre when a position is given. */
  addShake(amount: number, x?: number, z?: number) {
    this.shaker.add(amount, x, z);
  }

  /** Current camera shake offset in world units (x, z on the ground plane). */
  shakeOffset(): { x: number; z: number } {
    return this.shaker.offset;
  }

  /** Back-compat: current shake trauma. */
  get shake() {
    return this.shaker.trauma;
  }

  setPointScale(s: number) {
    this.fire.material.uniforms.scale.value = s;
    this.smokeSys.material.uniforms.scale.value = s;
    this.haze?.setScale(s);
  }

  private rand(a: number, b: number) {
    return a + Math.random() * (b - a);
  }

  private get map() {
    return this.debris?.map ?? null;
  }

  groundAt(x: number, z: number) {
    const m = this.map;
    if (!m) return 0;
    return standHeight(m, Math.max(0, Math.min(m.w - 0.01, x)), Math.max(0, Math.min(m.h - 0.01, z)));
  }

  isWater(x: number, z: number) {
    const m = this.map;
    if (!m) return false;
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 0 || tz < 0 || tx >= m.w || tz >= m.h) return false;
    return m.tiles[tz * m.w + tx] === Tile.Water;
  }

  private fires(): GrassFires | null {
    const m = this.map;
    if (!m) return null;
    if (!this.grass) {
      const sink = {
        spawnFire: (o: ParticleOpts) => this.fire.spawn(o),
        spawnSmoke: (o: ParticleOpts) => this.smokeSys.spawn(o),
        lights: this.lights,
        groundAt: (x: number, z: number) => this.groundAt(x, z),
        haze: this.haze,
        scorch: (x: number, z: number, r: number) => this.marks?.scorchAt(x, z, r),
      };
      this.grass = new GrassFires(sink, m, this.quality === 'low' ? 4 : this.quality === 'medium' ? 8 : 14);
    }
    return this.grass;
  }

  /** Run fn after a delay (seconds of effect time). */
  after(delay: number, fn: () => void) {
    this.later.push({ t: this.time + delay, fn });
  }

  flashLight(x: number, y: number, z: number, power: number, color: number, life: number) {
    this.lights.flash(x, y, z, power, color, life);
  }

  private q(n: number) {
    return Math.max(1, Math.round(n * (this.quality === 'low' ? 0.45 : this.quality === 'medium' ? 0.75 : 1) * this.budget));
  }

  // --------------------------------------------------------------- blasts

  /** Full explosion from a profile. ground = terrain height under the blast. */
  blast(p: BlastProfile, x: number, y: number, z: number, ground: number) {
    const S = p.size;
    const airborne = y - ground > 0.6;
    if (!airborne && this.isWater(x, z)) {
      this.splash(x, ground, z, S);
      if (p.light) this.flashLight(x, y, z, p.light * 0.6, 0xffc080, 0.2 + 0.05 * S);
      this.addShake(p.shake * 0.7, x, z);
      return;
    }
    const thermo = p.fireColor === 'thermo';
    const pal =
      thermo
        ? { hot: 0xffb860, mid: 0xff5a10, end: 0x4a1000 }
        : p.fireColor === 'laser'
          ? { hot: 0xffc0a8, mid: 0xff3a10, end: 0x400800 }
          : p.fireColor === 'white'
            ? { hot: 0xffffff, mid: 0xffb050, end: 0x4a1000 }
            : { hot: 0xffc070, mid: 0xff5a10, end: 0x3c0c00 };
    // 1. flash
    if (p.fire > 0) {
      this.fire.spawn({ x, y: y + 0.15 * S, z, life: 0.08 + 0.03 * S, size: 1.0 * S, sizeEnd: 1.6 * S, color: 0xfff2d8, colorEnd: pal.hot, alpha: 0.55 });
      this.fire.spawn({ x, y: y + 0.2 * S, z, life: 0.18 + 0.05 * S, size: 2.2 * S, sizeEnd: 2.6 * S, color: pal.mid, colorEnd: pal.end, alpha: 0.2 });
    }
    // 2. fireball: expanding, rising, cooling puffs
    const nFire = this.q(Math.round(12 * Math.sqrt(p.fire) * Math.sqrt(S)));
    for (let i = 0; i < nFire; i++) {
      const a = Math.random() * Math.PI * 2;
      const el = Math.random() * (airborne ? Math.PI : Math.PI / 2);
      const sp = this.rand(0.5, 2.2) * S;
      this.fire.spawn({
        x: x + Math.cos(a) * 0.08 * S,
        y: y + this.rand(0.05, 0.25) * S,
        z: z + Math.sin(a) * 0.08 * S,
        vx: Math.cos(a) * Math.cos(el) * sp,
        vy: Math.sin(el) * sp * (airborne ? 1 : 0.8) + 0.4 * S,
        vz: Math.sin(a) * Math.cos(el) * sp,
        life: this.rand(0.35, 0.8) * (thermo ? 1.8 : 1) * (0.8 + S * 0.2),
        size: this.rand(0.35, 0.7) * S,
        sizeEnd: this.rand(0.8, 1.35) * S,
        color: pal.hot,
        colorEnd: pal.end,
        alpha: 0.42,
        drag: 3,
        gravity: -0.8,
      });
    }
    // 3. sparks / fragments
    const nSp = this.q(p.sparks);
    for (let i = 0; i < nSp; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = this.rand(2, 7) * Math.sqrt(S);
      this.fire.spawn({ x, y: y + 0.1, z, vx: Math.cos(a) * sp, vy: this.rand(1, 6) * Math.sqrt(S), vz: Math.sin(a) * sp, life: this.rand(0.3, 0.9), size: this.rand(0.04, 0.08), color: 0xffe6a0, colorEnd: 0xff4000, gravity: 9, drag: 0.6 });
    }
    // 4. dirt column / spray (ground bursts only)
    if (!airborne && p.dirt > 0) {
      const n = this.q(Math.round(10 * p.dirt));
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = this.rand(0, 0.25) * S;
        const up = this.rand(2.5, 6) * Math.sqrt(p.dirt);
        this.smokeSys.spawn({ x: x + Math.cos(a) * r, y: ground + 0.05, z: z + Math.sin(a) * r, vx: Math.cos(a) * this.rand(0.3, 1.4), vy: up, vz: Math.sin(a) * this.rand(0.3, 1.4), life: this.rand(0.8, 1.6), size: this.rand(0.15, 0.3) * S, sizeEnd: this.rand(0.5, 0.9) * S, color: 0x4a3a28, colorEnd: 0x7a6a52, alpha: 0.85, gravity: 6, drag: 0.8 });
      }
    }
    // 5. smoke: billowing cloud + optional column (drifts with the wind)
    const nSmoke = this.q(Math.round(9 * p.smoke));
    for (let i = 0; i < nSmoke; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = this.rand(0, 0.35) * S;
      this.smokeSys.spawn({
        x: x + Math.cos(a) * r,
        y: y + this.rand(0.15, 0.5) * S,
        z: z + Math.sin(a) * r,
        vx: Math.cos(a) * this.rand(0.2, 0.7) * S,
        vy: this.rand(0.4, 1.1) * S,
        vz: Math.sin(a) * this.rand(0.2, 0.7) * S,
        life: this.rand(2, 4) * Math.sqrt(S),
        size: this.rand(0.45, 0.8) * S,
        sizeEnd: this.rand(1.6, 2.6) * S,
        color: 0x2c2824,
        colorEnd: 0x6e6862,
        alpha: 0.7,
        drag: 1.4,
        gravity: -0.15,
        wind: 0.5,
      });
    }
    if (p.column) {
      const n = this.q(Math.round(6 * S));
      for (let i = 0; i < n; i++)
        this.smokeSys.spawn({ x: x + this.rand(-0.15, 0.15) * S, y: y + 0.3 * S + i * 0.18 * S, z: z + this.rand(-0.15, 0.15) * S, vx: 0.05, vy: this.rand(1.2, 2.2) * S * 0.6, vz: -0.03, life: this.rand(4, 7), size: 0.5 * S, sizeEnd: 2.4 * S, color: 0x221e1b, colorEnd: 0x5e5852, alpha: 0.55, drag: 0.6, gravity: -0.05, wind: 0.9 });
    }
    // 6. ground shockwave: fast radial dust ring + visible ring
    if (!airborne && p.ring > 0) {
      const n = this.q(Math.round(26 * Math.sqrt(p.ring)));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.2;
        const sp = p.ring * this.rand(2.2, 3.2);
        this.smokeSys.spawn({ x: x + Math.cos(a) * 0.2, y: ground + 0.08, z: z + Math.sin(a) * 0.2, vx: Math.cos(a) * sp, vy: 0.15, vz: Math.sin(a) * sp, life: this.rand(0.9, 1.6), size: 0.2 * S, sizeEnd: 0.8 * S, color: 0x9a8a6c, colorEnd: 0xb4a688, alpha: 0.55, drag: 2.8 });
      }
      this.ring(x, ground + 0.06, z, 0.2 * S, p.ring * 1.3, 0.3, 0xffd8a0, true, 0.14);
      // refraction shockwave racing over the ground
      if (this.haze && S >= 0.9) this.haze.ring(x, ground + 0.1, z, p.ring * 1.6, 0.35 + 0.08 * S, 0.008 + 0.003 * S, true);
    }
    if (airborne && S >= 1) {
      // spherical pressure flash in the air
      const mat = new THREE.MeshBasicMaterial({ color: 0xffe2b0, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const m = new THREE.Mesh(this.sphereGeo, mat);
      m.position.set(x, y, z);
      m.scale.setScalar(0.2 * S);
      this.group.add(m);
      this.timed.push({ obj: m, mat, life: 0, max: 0.25, grow: 1.4 * S, base: 0.2 * S, alpha0: 0.35 });
      if (this.haze) this.haze.ring(x, y, z, 1.6 * S, 0.3, 0.01, false);
    }
    // heat shimmer over the fireball
    if (this.haze && p.fire > 0 && S >= 0.7) {
      this.haze.heat(x, y + 0.4 * S, z, 1.6 * S, 0.9 + 0.3 * S, 0.004);
      if (S >= 1.3) this.haze.heat(x, y + 1.1 * S, z, 2 * S, 1.6, 0.003, 1);
    }
    // 7. debris, crater, scorch
    if (this.debris && p.debris) for (const d of p.debris) this.debris.burst(d.kind, x, Math.max(y, ground + 0.1), z, this.q(d.n), d.power, d.size, { smoke: d.kind === 'burnt' || d.kind === 'metal' ? 0.35 : 0 });
    if (this.marks && !airborne) {
      if (p.scorch) this.marks.scorchAt(x, z, p.scorch * this.rand(0.85, 1.15));
      if (p.crater) this.marks.craterAt(x, z, p.crater * this.rand(0.85, 1.15));
    }
    // big blasts throw burning embers on arcs
    if (S >= 1.3 && p.fire >= 1) {
      const n = this.q(Math.round(3 * S));
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = this.rand(1.5, 3.5) * Math.sqrt(S);
        this.flyers.add('ember', x, y + 0.2, z, Math.cos(a) * sp, this.rand(3, 6) * Math.sqrt(S), Math.sin(a) * sp, this.rand(0.8, 1.6), 1);
      }
    }
    // 8. light and camera shake
    if (p.light) this.flashLight(x, y, z, p.light, p.fireColor === 'laser' ? 0xff5030 : thermo ? 0xff8a30 : 0xffa04a, 0.25 + 0.06 * S);
    this.addShake(p.shake, x, z);
    if (p.afterburn) this.burns.push({ x, y: ground, z, t: p.afterburn, size: S });
    if (thermo) this.thermobaric(x, y, z, ground, S, airborne);
    // big ground blasts on grass may start a creeping grass fire
    if (!airborne && S >= 1.2 && p.fire >= 1 && Math.random() < (thermo ? 0.85 : 0.35)) this.fires()?.ignite(x + this.rand(-0.4, 0.4), z + this.rand(-0.4, 0.4), S);
  }

  /**
   * Thermobaric extras: the fuel-air cloud's visible pressure wave (a fast
   * expanding translucent dome plus a ground dust wall), and a delayed
   * secondary fireball when the dispersed cloud ignites.
   */
  private thermobaric(x: number, y: number, z: number, ground: number, S: number, airborne: boolean) {
    const R = 2.4 * S;
    if (!airborne) {
      // pressure dome
      const mat = new THREE.MeshBasicMaterial({ color: 0xffd8a8, transparent: true, opacity: 0.09, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const m = new THREE.Mesh(this.domeGeo, mat);
      m.position.set(x, ground, z);
      m.scale.setScalar(0.3);
      m.renderOrder = 3;
      this.group.add(m);
      this.timed.push({ obj: m, mat, life: 0, max: 0.4, grow: R, base: 0.3, alpha0: 0.09 });
      // dust wall pushed out by the wave
      const n = this.q(36);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.15;
        const sp = R * this.rand(2.6, 3.4);
        this.smokeSys.spawn({ x: x + Math.cos(a) * 0.3, y: ground + 0.1, z: z + Math.sin(a) * 0.3, vx: Math.cos(a) * sp, vy: this.rand(0.3, 0.8), vz: Math.sin(a) * sp, life: this.rand(1.4, 2.4), size: 0.35 * S, sizeEnd: 1.3 * S, color: 0xa08c6a, colorEnd: 0xbcae90, alpha: 0.6, drag: 2.4, wind: 0.4 });
      }
      this.ring(x, ground + 0.07, z, 0.3, R * 1.2, 0.45, 0xffe0b0, true, 0.22);
      if (this.haze) this.haze.ring(x, ground + 0.2, z, R * 1.25, 0.5, 0.02, true);
    }
    // the cloud ignites a beat later: a second, wider and longer fireball
    this.after(0.16, () => {
      const n = this.q(16);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = this.rand(0.3, 1) * R * 0.6;
        this.fire.spawn({ x: x + Math.cos(a) * r, y: y + this.rand(0.1, 0.5) * S, z: z + Math.sin(a) * r, vx: Math.cos(a) * 0.4, vy: this.rand(0.6, 1.6) * S, vz: Math.sin(a) * 0.4, life: this.rand(0.8, 1.4), size: this.rand(0.6, 0.9) * S, sizeEnd: this.rand(1.2, 1.7) * S, color: 0xffd080, colorEnd: 0x501000, alpha: 0.4, drag: 2, gravity: -1.2 });
      }
      this.flashLight(x, y + 0.5, z, 9 * S, 0xff9a40, 0.6);
      this.addShake(0.12, x, z);
      if (this.haze) this.haze.heat(x, y + 0.8 * S, z, 2.6 * S, 1.8, 0.005, 0.8);
    });
  }

  /** Shell / missile / debris hitting water: tall white column, spray and a ring. */
  splash(x: number, y: number, z: number, size = 1) {
    const S = Math.max(0.3, size);
    const wy = y + 0.02;
    const n = this.q(Math.round(14 * Math.sqrt(S)));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = this.rand(0, 0.12) * S;
      this.smokeSys.spawn({ x: x + Math.cos(a) * r, y: wy, z: z + Math.sin(a) * r, vx: Math.cos(a) * this.rand(0.1, 0.5) * S, vy: this.rand(3, 6.5) * Math.sqrt(S), vz: Math.sin(a) * this.rand(0.1, 0.5) * S, life: this.rand(0.9, 1.5), size: this.rand(0.12, 0.25) * S, sizeEnd: this.rand(0.5, 0.8) * S, color: 0xf2f6f8, colorEnd: 0xd8e2e8, alpha: 0.85, gravity: 7, drag: 0.6 });
    }
    // droplets
    for (let i = 0; i < this.q(Math.round(10 * S)); i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = this.rand(1, 3) * Math.sqrt(S);
      this.fire.spawn({ x, y: wy + 0.1, z, vx: Math.cos(a) * sp, vy: this.rand(2, 5) * Math.sqrt(S), vz: Math.sin(a) * sp, life: this.rand(0.5, 0.9), size: 0.05, color: 0x8a9aa4, colorEnd: 0x404a50, alpha: 0.7, gravity: 9 });
    }
    // base surge mist
    for (let i = 0; i < this.q(8); i++) {
      const a = (i / 8) * Math.PI * 2;
      this.smokeSys.spawn({ x, y: wy + 0.05, z, vx: Math.cos(a) * 1.4 * S, vy: 0.1, vz: Math.sin(a) * 1.4 * S, life: this.rand(1.2, 2), size: 0.25 * S, sizeEnd: 0.9 * S, color: 0xe8eef2, colorEnd: 0xf4f6f8, alpha: 0.45, drag: 1.8, wind: 0.4 });
    }
    this.ring(x, wy + 0.01, z, 0.15 * S, 1.4 * S, 0.9, 0xe8f2f8, false, 0.55);
    this.ring(x, wy + 0.01, z, 0.1 * S, 0.8 * S, 0.6, 0xffffff, false, 0.4);
  }

  /** Back-compat helper used by older call sites. */
  explosion(x: number, y: number, z: number, size: 'tiny' | 'small' | 'medium' | 'large' | 'huge', kind: 'fire' | 'thermo' | 'dust' | 'laser' | 'air' = 'fire') {
    if (kind === 'dust') {
      for (let i = 0; i < this.q(6); i++)
        this.smokeSys.spawn({ x, y: y + 0.05, z, vx: this.rand(-0.5, 0.5), vy: this.rand(0.3, 0.8), vz: this.rand(-0.5, 0.5), life: this.rand(0.5, 0.9), size: 0.12, sizeEnd: 0.35, color: 0x9a8a70, alpha: 0.6, drag: 3 });
      return;
    }
    const base = { tiny: BLASTS.flak, small: BLASTS.shell, medium: BLASTS.rocket, large: BLASTS.vehicle, huge: BLASTS.bigVehicle }[size];
    const p = kind === 'thermo' ? BLASTS.thermo : kind === 'laser' ? BLASTS.laser : base;
    this.blast(p, x, y, z, kind === 'air' ? y - 2 : y);
  }

  // ---------------------------------------------------------- launch / fire

  muzzle(p: THREE.Vector3, dir: THREE.Vector3, scale = 1, color = 0xffe08a) {
    this.fire.spawn({ x: p.x, y: p.y, z: p.z, life: 0.06, size: 0.5 * scale, sizeEnd: 0.2 * scale, color: 0xffffff, colorEnd: color });
    for (let i = 1; i <= 3; i++) this.fire.spawn({ x: p.x + dir.x * 0.09 * i * scale, y: p.y + dir.y * 0.09 * i, z: p.z + dir.z * 0.09 * i * scale, life: 0.05, size: (0.38 - i * 0.07) * scale, color, colorEnd: 0xff5000 });
    if (scale > 0.8) {
      // muzzle blast: side-venting smoke from the brake, dust kicked off the ground
      for (let i = 0; i < this.q(6); i++) {
        const side = i % 2 ? 1 : -1;
        this.smokeSys.spawn({ x: p.x, y: p.y, z: p.z, vx: dir.x * 1.6 - dir.z * side * 1.4 + this.rand(-0.2, 0.2), vy: this.rand(0.1, 0.5), vz: dir.z * 1.6 + dir.x * side * 1.4 + this.rand(-0.2, 0.2), life: this.rand(0.7, 1.4), size: 0.18 * scale, sizeEnd: 0.75 * scale, color: 0x8c8780, colorEnd: 0xb8b2aa, alpha: 0.55, drag: 3, wind: 0.3 });
      }
      this.flashLight(p.x, p.y, p.z, 2.5 * scale, 0xffb060, 0.08);
      if (this.haze && scale > 1.2) this.haze.heat(p.x + dir.x * 0.3, p.y, p.z + dir.z * 0.3, 0.6 * scale, 0.35, 0.004, 0.3);
    } else this.flashLight(p.x, p.y, p.z, 1.6 * scale, 0xffc070, 0.05);
  }

  /** Launch signature for a missile / rocket at position p, flying along dir. */
  launch(kind: string, p: THREE.Vector3, dir: THREE.Vector3, ground: number) {
    const back = this.v1.copy(dir).multiplyScalar(-1);
    switch (kind) {
      case 'atgm':
        // backblast cone behind the shooter
        for (let i = 0; i < this.q(10); i++)
          this.smokeSys.spawn({ x: p.x, y: p.y, z: p.z, vx: back.x * this.rand(2, 4) + this.rand(-0.5, 0.5), vy: this.rand(0, 0.6), vz: back.z * this.rand(2, 4) + this.rand(-0.5, 0.5), life: this.rand(0.8, 1.5), size: 0.15, sizeEnd: 0.6, color: 0xb4ada2, colorEnd: 0xd0cbc2, alpha: 0.6, drag: 3 });
        this.fire.spawn({ x: p.x + back.x * 0.15, y: p.y, z: p.z + back.z * 0.15, life: 0.08, size: 0.45, color: 0xfff0c0, colorEnd: 0xff6000 });
        this.flashLight(p.x, p.y, p.z, 2, 0xffc070, 0.12);
        break;
      case 'sam':
      case 'interceptor':
      case 'ballistic':
      case 'hypersonic': {
        const big = kind === 'ballistic' || kind === 'hypersonic' ? 2.2 : 1;
        this.fire.spawn({ x: p.x, y: p.y, z: p.z, life: 0.2, size: 1.2 * big, color: 0xffffff, colorEnd: 0xffa040 });
        this.fire.spawn({ x: p.x, y: p.y + 0.1, z: p.z, life: 0.35, size: 0.8 * big, sizeEnd: 1.6 * big, color: 0xffe0a0, colorEnd: 0x802000, alpha: 0.5 });
        // exhaust hits the ground and billows out sideways
        const n = this.q(Math.round(22 * big));
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = this.rand(0.8, 2.6) * big;
          this.smokeSys.spawn({ x: p.x, y: ground + 0.1, z: p.z, vx: Math.cos(a) * sp, vy: this.rand(0.1, 0.7), vz: Math.sin(a) * sp, life: this.rand(2, 4) * big, size: 0.3 * big, sizeEnd: 1.4 * big, color: 0xe6e2dc, colorEnd: 0xf4f2ee, alpha: 0.6, drag: 1.2, gravity: -0.05, wind: 0.5 });
        }
        this.flashLight(p.x, p.y, p.z, 6 * big, 0xffc070, 0.5);
        this.addShake(0.05 * big, p.x, p.z);
        if (this.haze) this.haze.heat(p.x, ground + 0.4, p.z, 1.4 * big, 0.8, 0.005, 0.8);
        break;
      }
      case 'cruise': {
        // solid booster kicks the missile out of its canister: white puff + short flame
        this.fire.spawn({ x: p.x, y: p.y, z: p.z, life: 0.16, size: 0.9, color: 0xffffff, colorEnd: 0xffa040 });
        for (let i = 0; i < this.q(16); i++) {
          const a = Math.random() * Math.PI * 2;
          const sp = this.rand(0.4, 1.6);
          this.smokeSys.spawn({ x: p.x, y: Math.max(ground + 0.1, p.y - 0.1), z: p.z, vx: Math.cos(a) * sp + back.x * 0.8, vy: this.rand(0.2, 0.9), vz: Math.sin(a) * sp + back.z * 0.8, life: this.rand(1.8, 3.2), size: 0.25, sizeEnd: 1.1, color: 0xe2ded6, colorEnd: 0xf2f0ec, alpha: 0.6, drag: 1.3, wind: 0.5 });
        }
        this.flashLight(p.x, p.y, p.z, 4, 0xffc070, 0.35);
        this.addShake(0.04, p.x, p.z);
        break;
      }
      case 'rocketSalvo':
      case 'airMissile':
      case 'topAttack':
        this.fire.spawn({ x: p.x, y: p.y, z: p.z, life: 0.1, size: 0.55, color: 0xfff0c0, colorEnd: 0xff6000 });
        for (let i = 0; i < this.q(5); i++)
          this.smokeSys.spawn({ x: p.x, y: p.y, z: p.z, vx: back.x * this.rand(0.5, 1.5) + this.rand(-0.3, 0.3), vy: this.rand(0, 0.5), vz: back.z * this.rand(0.5, 1.5) + this.rand(-0.3, 0.3), life: this.rand(0.8, 1.6), size: 0.18, sizeEnd: 0.7, color: 0xc8c2b8, alpha: 0.55, drag: 2 });
        this.flashLight(p.x, p.y, p.z, 2.5, 0xffc070, 0.12);
        break;
    }
  }

  private td = new THREE.Vector3();
  private tu = new THREE.Vector3();
  private tv = new THREE.Vector3();

  /**
   * Continuous exhaust trail between two positions of a projectile.
   * kind: flight model; boost: is the motor burning; phase: per-projectile
   * phase (seconds of flight + id) for corkscrewing interceptor trails.
   */
  trail(a: THREE.Vector3, b: THREE.Vector3, kind: string, boost: boolean, phase = 0) {
    const d = this.td.copy(b).sub(a);
    const len = d.length();
    if (len < 1e-4) return;
    const dir = d.divideScalar(len);
    if (kind === 'artillery' || kind === 'mortar') {
      // shells: faint heat shimmer streak only
      this.fire.spawn({ x: b.x, y: b.y, z: b.z, life: 0.05, size: 0.12, color: 0xffc070 });
      return;
    }
    if (kind === 'shell') return;
    const cfg =
      kind === 'ballistic' || kind === 'hypersonic'
        ? TRAIL_BALLISTIC
        : kind === 'sam' || kind === 'interceptor'
          ? TRAIL_SAM
          : kind === 'rocketSalvo'
            ? TRAIL_ROCKET
            : kind === 'airMissile'
              ? TRAIL_AIR
              : kind === 'cruise'
                ? TRAIL_CRUISE
                : TRAIL_ATGM; // atgm / topAttack
    const sam = kind === 'sam' || kind === 'interceptor';
    if (boost) {
      const fl = cfg.flame * (sam ? 1.35 : 1);
      this.fire.spawn({ x: b.x - dir.x * 0.05, y: b.y - dir.y * 0.05, z: b.z - dir.z * 0.05, life: 0.05, size: fl * 1.4, color: 0xffffff, colorEnd: 0xffb050 });
      this.fire.spawn({ x: b.x - dir.x * 0.15, y: b.y - dir.y * 0.15, z: b.z - dir.z * 0.15, life: 0.08, size: fl, color: 0xffd080, colorEnd: 0xff4000 });
      if (sam || kind === 'ballistic' || kind === 'hypersonic') {
        // long bright motor plume
        this.fire.spawn({ x: b.x - dir.x * 0.3, y: b.y - dir.y * 0.3, z: b.z - dir.z * 0.3, life: 0.1, size: fl * 0.8, sizeEnd: fl * 0.3, color: 0xffc070, colorEnd: 0xff3000, alpha: 0.7 });
        this.lights.sustain(b.x, b.y, b.z, kind === 'ballistic' || kind === 'hypersonic' ? 5 : 2.6, 0xffb060, 0.3);
        if (this.haze && Math.random() < 0.35) this.haze.heat(b.x - dir.x * 0.4, b.y - dir.y * 0.4, b.z - dir.z * 0.4, 0.5 + cfg.flame, 0.35, 0.004, 0);
      } else if (kind !== 'cruise') this.lights.sustain(b.x, b.y, b.z, 1.1, 0xffb060, 0.3);
    } else if (kind === 'hypersonic' || kind === 'ballistic') {
      // re-entry: plasma glow around the warhead, faint trail
      this.fire.spawn({ x: b.x, y: b.y, z: b.z, life: 0.06, size: 0.5, color: kind === 'hypersonic' ? 0xffb0ff : 0xffc080, colorEnd: 0xff5020 });
      this.lights.sustain(b.x, b.y, b.z, 1.8, kind === 'hypersonic' ? 0xff90e0 : 0xffa060, 0.2);
    }
    // corkscrew: interceptors weave as they guide, so their smoke spirals around the path
    let ux = 0;
    let uy = 0;
    let uz = 0;
    let vx = 0;
    let vy = 0;
    let vz = 0;
    if (sam) {
      const u = this.tu.set(0, 1, 0).cross(dir);
      if (u.lengthSq() < 1e-4) u.set(1, 0, 0);
      u.normalize();
      const v = this.tv.copy(dir).cross(u);
      ux = u.x;
      uy = u.y;
      uz = u.z;
      vx = v.x;
      vy = v.y;
      vz = v.z;
    }
    const n = Math.min(40, Math.ceil(len / cfg.step));
    for (let i = 0; i < n; i++) {
      const t = (i + Math.random()) / n;
      const life = this.rand(0.7, 1.15) * cfg.life * (boost ? 1 : 0.35);
      let ox = 0;
      let oy = 0;
      let oz = 0;
      if (sam) {
        const ang = phase * 9 + t * len * 4.5;
        const r = 0.07;
        const c = Math.cos(ang) * r;
        const s2 = Math.sin(ang) * r;
        ox = ux * c + vx * s2;
        oy = uy * c + vy * s2;
        oz = uz * c + vz * s2;
      }
      this.smokeSys.spawn({
        x: a.x + d.x * len * t + ox + this.rand(-0.02, 0.02),
        y: a.y + d.y * len * t + oy + this.rand(-0.02, 0.02),
        z: a.z + d.z * len * t + oz + this.rand(-0.02, 0.02),
        vx: this.rand(-0.06, 0.06) + 0.05,
        vy: this.rand(0.02, 0.12),
        vz: this.rand(-0.06, 0.06) - 0.03,
        life,
        size: cfg.s0,
        sizeEnd: cfg.s1,
        color: cfg.col,
        colorEnd: 0xf6f4f0,
        alpha: (boost ? 0.55 : 0.25) * cfg.alpha,
        drag: 0.5,
        wind: 0.25,
      });
    }
  }

  /**
   * Extra trail of a missile that was hit and flies on damaged: dark smoke,
   * sparks and licks of flame. k = damage fraction (hits / maxHp).
   */
  damagedTrail(a: THREE.Vector3, b: THREE.Vector3, k: number) {
    const len = a.distanceTo(b);
    const n = Math.min(14, Math.ceil(len / 0.1));
    for (let i = 0; i < n; i++) {
      const t = (i + Math.random()) / n;
      this.smokeSys.spawn({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, vx: this.rand(-0.1, 0.1), vy: this.rand(0.05, 0.2), vz: this.rand(-0.1, 0.1), life: this.rand(2, 3.5), size: 0.1 + 0.08 * k, sizeEnd: 0.6 + 0.6 * k, color: 0x1e1b19, colorEnd: 0x56514c, alpha: 0.65, drag: 0.5, wind: 0.6 });
    }
    this.fire.spawn({ x: b.x, y: b.y, z: b.z, life: 0.1, size: 0.25 + 0.25 * k, sizeEnd: 0.1, color: 0xffc060, colorEnd: 0xff2a00, alpha: 0.9 });
    if (Math.random() < 0.5 + k) this.fire.spawn({ x: b.x, y: b.y, z: b.z, vx: this.rand(-2, 2), vy: this.rand(-0.5, 2), vz: this.rand(-2, 2), life: this.rand(0.3, 0.6), size: 0.05, color: 0xffe0a0, colorEnd: 0xff4000, gravity: 7 });
    this.lights.sustain(b.x, b.y, b.z, 1.2 + k, 0xff8030, 0.5);
  }

  /** Interceptor struck a threat that survives: medium flash, sparks and fragments. */
  airHit(x: number, y: number, z: number, k = 0.5) {
    this.fire.spawn({ x, y, z, life: 0.1, size: 1.1, sizeEnd: 1.5, color: 0xffffff, colorEnd: 0xffb050, alpha: 0.8 });
    for (let i = 0; i < this.q(6); i++) {
      const a = Math.random() * Math.PI * 2;
      const el = this.rand(-1, 1);
      const sp = this.rand(0.4, 1.2);
      this.fire.spawn({ x, y, z, vx: Math.cos(a) * sp, vy: el * sp, vz: Math.sin(a) * sp, life: this.rand(0.25, 0.5), size: this.rand(0.3, 0.5), sizeEnd: 0.7, color: 0xffd080, colorEnd: 0x401000, alpha: 0.5, drag: 3 });
    }
    for (let i = 0; i < this.q(18); i++) this.fire.spawn({ x, y, z, vx: this.rand(-4, 4), vy: this.rand(-1, 4), vz: this.rand(-4, 4), life: this.rand(0.4, 0.9), size: this.rand(0.04, 0.07), color: 0xffe6a0, colorEnd: 0xff4000, gravity: 8, drag: 0.5 });
    for (let i = 0; i < this.q(4); i++) this.smokeSys.spawn({ x: x + this.rand(-0.2, 0.2), y: y + this.rand(-0.15, 0.15), z: z + this.rand(-0.2, 0.2), vx: this.rand(-0.2, 0.2), vy: this.rand(0, 0.1), vz: this.rand(-0.2, 0.2), life: this.rand(3, 5), size: 0.3, sizeEnd: 1.1, color: 0x3c3834, colorEnd: 0x8a847c, alpha: 0.6, drag: 0.8, wind: 0.6 });
    for (let i = 0; i < this.q(2); i++) this.flyers.add('burning', x, y, z, this.rand(-2, 2), this.rand(0, 2.5), this.rand(-2, 2), this.rand(1.5, 3), 0.6);
    this.flashLight(x, y, z, 4 + 3 * k, 0xffd090, 0.18);
    if (this.haze) this.haze.ring(x, y, z, 0.9, 0.22, 0.008, false);
  }

  /** Interceptor hits (kill) or misses its target in the sky. big: heavy threat (ballistic / multi-hit). */
  airburst(x: number, y: number, z: number, kill: boolean, ground: number, big: boolean) {
    if (!kill) {
      this.fire.spawn({ x, y, z, life: 0.1, size: 0.6, color: 0xffffff, colorEnd: 0xff9040 });
      for (let i = 0; i < this.q(6); i++) this.fire.spawn({ x, y, z, vx: this.rand(-3, 3), vy: this.rand(-1, 3), vz: this.rand(-3, 3), life: 0.5, size: 0.05, color: 0xffe0a0, gravity: 6 });
      this.smokeSys.spawn({ x, y, z, vy: 0.1, life: 2.5, size: 0.3, sizeEnd: 1, color: 0x6a6662, alpha: 0.6, drag: 1, wind: 0.6 });
      this.flashLight(x, y, z, 2, 0xffd090, 0.1);
      return;
    }
    const S = big ? 1.8 : 1.1;
    this.blast({ ...BLASTS.airSmall, size: S, fire: big ? 2 : 1.2, sparks: big ? 40 : 22, smoke: 1.4, light: big ? 14 : 7, shake: big ? 0.12 : 0.03 }, x, y, z, ground);
    // falling debris: mesh chunks plus burning fragments that trail fire and smoke to the ground
    if (this.debris) this.debris.burst('burnt', x, y, z, this.q(big ? 10 : 5), big ? 4 : 2.5, 0.05, { up: 0.4, smoke: 0.8 });
    const nb = this.q(big ? 7 : 4);
    for (let i = 0; i < nb; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = this.rand(1, 3.2) * (big ? 1.3 : 1);
      this.flyers.add('burning', x, y, z, Math.cos(a) * sp, this.rand(0.5, 3), Math.sin(a) * sp, this.rand(2.5, 4.5), big ? 1.2 : 0.9);
    }
    // characteristic lingering, puffy interception cloud that slowly drifts with the wind
    const nc = this.q(big ? 16 : 10);
    for (let i = 0; i < nc; i++)
      this.smokeSys.spawn({ x: x + this.rand(-0.35, 0.35) * S, y: y + this.rand(-0.25, 0.25) * S, z: z + this.rand(-0.35, 0.35) * S, vx: this.rand(-0.25, 0.25), vy: this.rand(0, 0.15), vz: this.rand(-0.25, 0.25), life: this.rand(6, 10), size: 0.45 * S, sizeEnd: 1.8 * S, color: i % 3 ? 0x4a4642 : 0x2c2926, colorEnd: 0xa49e96, alpha: 0.55, drag: 0.8, wind: 0.35 });
    for (let i = 0; i < this.q(5); i++)
      this.smokeSys.spawn({ x, y, z, vx: this.rand(-0.5, 0.5), vy: this.rand(-0.1, 0.3), vz: this.rand(-0.5, 0.5), life: this.rand(4, 6), size: 0.3 * S, sizeEnd: 1.2 * S, color: 0xd8d4ce, colorEnd: 0xeeece8, alpha: 0.35, drag: 1, wind: 0.35 });
  }

  // -------------------------------------------------------------- aircraft

  /** Mark an aircraft as targeted by a missile this frame (flares). */
  threaten(id: number) {
    const t = this.threats.get(id);
    if (t) t.seen = this.time;
    else this.threats.set(id, { seen: this.time, popped: -1e9 });
  }

  /** True when the aircraft should pop a flare salvo now (threatened recently and the dispenser cooled down). */
  flaresDue(id: number): boolean {
    const t = this.threats.get(id);
    if (!t || this.time - t.seen > 0.5 || this.time - t.popped < 2.2) return false;
    t.popped = this.time + Math.random() * 0.8;
    return true;
  }

  /** Decoy flare salvo from a dispenser at p; (fx, fz) = aircraft forward. */
  flares(p: THREE.Vector3, fx: number, fz: number, n = 4) {
    const cnt = Math.max(2, Math.round(n * (this.quality === 'low' ? 0.6 : 1)));
    for (let i = 0; i < cnt; i++) {
      const side = i % 2 ? 1 : -1;
      const spread = this.rand(0.6, 1.6) * side;
      this.flyers.add('flare', p.x, p.y, p.z, -fx * this.rand(0.6, 1.4) - fz * spread, this.rand(0.4, 1.4), -fz * this.rand(0.6, 1.4) + fx * spread, this.rand(1.6, 2.4), 1);
    }
    this.fire.spawn({ x: p.x, y: p.y, z: p.z, life: 0.08, size: 0.6, color: 0xffffff, colorEnd: 0xfff0c0 });
    this.flashLight(p.x, p.y, p.z, 3, 0xfff0d0, 0.15);
  }

  /** Rotor downwash: a ring of dust blown outwards on the ground. strength 0..1 (lower = stronger). */
  rotorWash(x: number, g: number, z: number, strength: number) {
    const water = this.isWater(x, z);
    const n = Math.max(1, Math.round(3 * strength * this.budget));
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = this.rand(1.4, 2.4) * (0.5 + strength * 0.5);
      this.smokeSys.spawn({ x: x + Math.cos(a) * 0.3, y: g + 0.04, z: z + Math.sin(a) * 0.3, vx: Math.cos(a) * sp, vy: this.rand(0.05, 0.25), vz: Math.sin(a) * sp, life: this.rand(0.6, 1.1), size: 0.12, sizeEnd: 0.55, color: water ? 0xe4ecf0 : 0xa08e70, colorEnd: water ? 0xf2f6f8 : 0xbcae90, alpha: 0.4 * strength, drag: 2.2 });
    }
  }

  /** Ejected shell casing (brass) from (x,y,z), thrown towards (sx, sz). */
  casing(x: number, y: number, z: number, sx: number, sz: number, size = 1) {
    this.debris?.eject('brass', x, y, z, sx * this.rand(1, 1.8) + this.rand(-0.3, 0.3), this.rand(1.2, 2.2), sz * this.rand(1, 1.8) + this.rand(-0.3, 0.3), 0.035 * size);
  }

  // ---------------------------------------------------------------- misc

  /** A short glowing line (bullet tracer, laser beam). */
  beam(a: THREE.Vector3, b: THREE.Vector3, color: number, width: number, life: number) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const m = new THREE.Mesh(this.beamGeo, mat);
    const len = a.distanceTo(b);
    m.position.copy(a);
    m.lookAt(b);
    m.scale.set(width, width, len);
    m.renderOrder = 4;
    this.group.add(m);
    this.timed.push({ obj: m, mat, life: 0, max: life });
  }

  laser(a: THREE.Vector3, b: THREE.Vector3) {
    this.beam(a, b, 0xff3a1a, 0.08, 0.22);
    this.beam(a, b, 0xffe6d0, 0.025, 0.18);
    for (let i = 0; i < 6; i++) this.fire.spawn({ x: b.x, y: b.y, z: b.z, vx: this.rand(-1.5, 1.5), vy: this.rand(0.5, 2), vz: this.rand(-1.5, 1.5), life: 0.3, size: 0.07, color: 0xffb090, colorEnd: 0xff2000, gravity: 5 });
    this.fire.spawn({ x: b.x, y: b.y, z: b.z, life: 0.15, size: 0.6, color: 0xff6040 });
    this.flashLight(b.x, b.y, b.z, 2, 0xff4020, 0.15);
  }

  /** Machine-gun / autocannon fire: travelling tracer bolts (n per burst, staggered). */
  tracer(a: THREE.Vector3, b: THREE.Vector3, hitGround = true, n = 1, heavy = false) {
    for (let i = 0; i < n; i++) {
      const jx = (Math.random() - 0.5) * 0.12 * i;
      const jz = (Math.random() - 0.5) * 0.12 * i;
      this.v1.set(b.x + jx, b.y, b.z + jz);
      this.tracers.fire(a, this.v1, heavy ? 0xffb050 : 0xffd27a, heavy ? 0.03 : 0.016, heavy ? 30 : 38, heavy ? 0.8 : 0.6, i * 0.07);
    }
    if (hitGround && Math.random() < 0.5) {
      if (this.isWater(b.x, b.z)) this.smokeSys.spawn({ x: b.x, y: b.y, z: b.z, vy: 1.5, life: 0.45, size: 0.06, sizeEnd: 0.18, color: 0xeef4f8, alpha: 0.6, gravity: 5 });
      else this.smokeSys.spawn({ x: b.x, y: b.y, z: b.z, vy: 0.4, life: 0.5, size: 0.06, sizeEnd: 0.2, color: 0x8a7a60, alpha: 0.5, drag: 2 });
    }
  }

  ring(x: number, y: number, z: number, r0: number, r1: number, life: number, color: number, additive: boolean, opacity = 0.9) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    const m = new THREE.Mesh(this.ringGeo, mat);
    m.position.set(x, y, z);
    m.scale.setScalar(r0);
    m.renderOrder = 3;
    this.group.add(m);
    this.timed.push({ obj: m, mat, life: 0, max: life, grow: r1, base: r0, alpha0: opacity });
  }

  marker(x: number, y: number, z: number, attack: boolean) {
    this.ring(x, y + 0.04, z, 0.6, 0.1, 0.45, attack ? 0xff3030 : 0x40ff70, true);
    this.ring(x, y + 0.04, z, 0.35, 0.05, 0.35, attack ? 0xff8080 : 0xa0ffb0, true);
  }

  scorch(x: number, _y: number, z: number, r: number) {
    this.marks?.scorchAt(x, z, r);
  }

  smoke(x: number, y: number, z: number, size = 1, dark = true) {
    this.smokeSys.spawn({ x: x + this.rand(-0.1, 0.1), y, z: z + this.rand(-0.1, 0.1), vx: this.rand(-0.1, 0.1), vy: this.rand(0.5, 0.9), vz: this.rand(-0.1, 0.1), life: this.rand(1.8, 3.2), size: 0.25 * size, sizeEnd: 1.1 * size, color: dark ? 0x2a2725 : 0xd8d8d8, colorEnd: dark ? 0x5a5550 : 0xf0f0f0, alpha: dark ? 0.55 : 0.35, drag: 0.4, gravity: -0.1, wind: 0.6 });
  }

  /**
   * One puff of a tall smoke column (burning wrecks, damaged buildings):
   * rises fast, slows, then leans over and drifts downwind.
   */
  column(x: number, y: number, z: number, size = 1, dark = true) {
    this.smokeSys.spawn({
      x: x + this.rand(-0.08, 0.08) * size,
      y,
      z: z + this.rand(-0.08, 0.08) * size,
      vx: this.rand(-0.06, 0.06),
      vy: this.rand(1.3, 1.9) * Math.sqrt(size),
      vz: this.rand(-0.06, 0.06),
      life: this.rand(4.5, 6.5) * (0.8 + 0.2 * size),
      size: 0.28 * size,
      sizeEnd: 1.9 * size,
      color: dark ? 0x1c1a18 : 0x8a8682,
      colorEnd: dark ? 0x67615b : 0xcfcbc6,
      alpha: dark ? 0.62 : 0.4,
      drag: 0.35,
      gravity: -0.02,
      wind: 1,
    });
  }

  /** Light + heat shimmer for a sustained fire (call every frame while it burns). */
  burnGlow(x: number, y: number, z: number, power = 2) {
    this.lights.sustain(x, y, z, power, 0xff8a30, 0.45);
    if (this.haze && Math.random() < 0.06) this.haze.heat(x, y + 0.5, z, 0.7 + power * 0.25, 1.1, 0.003, 0.7);
  }

  exhaust(x: number, y: number, z: number) {
    this.smokeSys.spawn({ x, y, z, vx: this.rand(-0.1, 0.1), vy: this.rand(0.2, 0.4), vz: this.rand(-0.1, 0.1), life: this.rand(0.7, 1.2), size: 0.06, sizeEnd: 0.28, color: 0x3a3836, colorEnd: 0x8a8682, alpha: 0.35, drag: 1, wind: 0.4 });
  }

  dust(x: number, y: number, z: number, size = 1) {
    this.smokeSys.spawn({ x: x + this.rand(-0.15, 0.15), y: y + 0.03, z: z + this.rand(-0.15, 0.15), vx: this.rand(-0.2, 0.2), vy: this.rand(0.1, 0.3), vz: this.rand(-0.2, 0.2), life: this.rand(0.8, 1.4), size: 0.12 * size, sizeEnd: 0.5 * size, color: 0x9a8a6c, colorEnd: 0xb4a688, alpha: 0.35, drag: 1.5, wind: 0.3 });
  }

  flame(x: number, y: number, z: number, size = 1) {
    this.fire.spawn({ x: x + this.rand(-0.15, 0.15) * size, y, z: z + this.rand(-0.15, 0.15) * size, vx: this.rand(-0.1, 0.1), vy: this.rand(0.6, 1.3), vz: this.rand(-0.1, 0.1), life: this.rand(0.3, 0.7), size: 0.35 * size, sizeEnd: 0.1, color: 0xffc050, colorEnd: 0x901800, gravity: -0.5, wind: 0.4 });
    if (Math.random() < 0.3) this.fire.spawn({ x, y: y + 0.1, z, vx: this.rand(-0.3, 0.3), vy: this.rand(1, 2), vz: this.rand(-0.3, 0.3), life: this.rand(0.8, 1.5), size: 0.03, color: 0xffb060, colorEnd: 0xff3000, drag: 0.5, gravity: -0.2, wind: 0.6 });
  }

  spark(x: number, y: number, z: number, color = 0x80c0ff) {
    for (let i = 0; i < 3; i++) this.fire.spawn({ x, y, z, vx: this.rand(-1, 1), vy: this.rand(0, 1.5), vz: this.rand(-1, 1), life: 0.25, size: 0.06, color, gravity: 3 });
    this.fire.spawn({ x, y, z, life: 0.12, size: 0.3, color });
  }

  intercept(p: THREE.Vector3) {
    // active protection: explosively formed charge meets the incoming round a metre out
    for (let i = 0; i < this.q(14); i++) this.fire.spawn({ x: p.x, y: p.y, z: p.z, vx: this.rand(-3, 3), vy: this.rand(0, 3), vz: this.rand(-3, 3), life: 0.35, size: 0.07, color: 0xfff0c0, colorEnd: 0xff8000, gravity: 6 });
    this.fire.spawn({ x: p.x, y: p.y, z: p.z, life: 0.12, size: 0.9, color: 0xffffff, colorEnd: 0xffa040 });
    for (let i = 0; i < this.q(4); i++) this.smokeSys.spawn({ x: p.x, y: p.y, z: p.z, vx: this.rand(-0.5, 0.5), vy: 0.4, vz: this.rand(-0.5, 0.5), life: 1.4, size: 0.2, sizeEnd: 0.7, color: 0x7a7a7a, alpha: 0.6, drag: 1.5 });
    this.flashLight(p.x, p.y, p.z, 3, 0xfff0c0, 0.12);
  }

  jamPulse(x: number, y: number, z: number, r: number) {
    this.ring(x, y + 0.1, z, 0.2, r, 1.1, 0x50a0ff, true, 0.5);
  }

  update(dt: number) {
    this.time += dt;
    // slowly veering wind
    const wa = -0.55 + Math.sin(this.time * 0.031) * 0.5 + Math.sin(this.time * 0.013 + 1) * 0.3;
    const ws = 0.32 + 0.08 * Math.sin(this.time * 0.07);
    this.wind.x = Math.cos(wa) * ws;
    this.wind.z = Math.sin(wa) * ws;
    for (let i = this.later.length - 1; i >= 0; i--) {
      if (this.later[i].t > this.time) continue;
      const l = this.later[i];
      this.later[i] = this.later[this.later.length - 1];
      this.later.pop();
      l.fn();
    }
    for (let i = this.burns.length - 1; i >= 0; i--) {
      const b = this.burns[i];
      b.t -= dt;
      if (Math.random() < dt * 30) this.flame(b.x + this.rand(-0.6, 0.6) * b.size, b.y + 0.05, b.z + this.rand(-0.6, 0.6) * b.size, 1.2);
      this.lights.sustain(b.x, b.y + 0.3, b.z, 3 * b.size * Math.min(1, b.t), 0xff8a30, 0.5);
      if (b.t <= 0) this.burns.splice(i, 1);
    }
    this.flyers.update(dt);
    this.grass?.update(dt);
    this.fire.update(dt, this.wind.x, this.wind.z);
    this.smokeSys.update(dt, this.wind.x, this.wind.z);
    this.tracers.update(dt);
    this.haze?.update(dt);
    this.debris?.update(dt);
    this.marks?.update(dt);
    this.shaker.update(dt);
    this.lights.update(dt);
    this.updatePerspective();
    for (let i = this.timed.length - 1; i >= 0; i--) {
      const t = this.timed[i];
      t.life += dt;
      const k = t.life / t.max;
      if (k >= 1) {
        this.group.remove(t.obj);
        t.mat.dispose();
        this.timed.splice(i, 1);
        continue;
      }
      t.mat.opacity = (t.alpha0 ?? 1) * (1 - k);
      if (t.grow !== undefined && t.base !== undefined) t.obj.scale.setScalar(t.base + (t.grow - t.base) * Math.sqrt(k));
    }
  }

  get activeParticles() {
    return this.fire.active + this.smokeSys.active;
  }

  /** Debug / perf counters. */
  stats() {
    return {
      fire: this.fire.active,
      smoke: this.smokeSys.active,
      cap: this.fire.capacity + this.smokeSys.capacity,
      haze: this.haze?.active ?? -1,
      lights: this.lights.lightCount,
      tracers: this.tracers.active,
      flyers: this.flyers.active,
      grassFires: this.grass?.active ?? 0,
      trauma: Math.round(this.shaker.trauma * 100) / 100,
    };
  }
}

const TRAIL_BALLISTIC = { step: 0.12, life: 4.5, s0: 0.22, s1: 1.3, flame: 0.7, col: 0xe8e4de, alpha: 1 };
const TRAIL_SAM = { step: 0.07, life: 3.4, s0: 0.12, s1: 0.75, flame: 0.4, col: 0xf0eeea, alpha: 1 };
const TRAIL_ROCKET = { step: 0.1, life: 1.8, s0: 0.12, s1: 0.6, flame: 0.4, col: 0xb8b2a8, alpha: 1 };
const TRAIL_AIR = { step: 0.08, life: 1.6, s0: 0.08, s1: 0.45, flame: 0.32, col: 0xd8d4ce, alpha: 1 };
const TRAIL_CRUISE = { step: 0.12, life: 1.2, s0: 0.06, s1: 0.32, flame: 0.18, col: 0xd0ccc6, alpha: 0.45 };
const TRAIL_ATGM = { step: 0.08, life: 1.1, s0: 0.06, s1: 0.32, flame: 0.28, col: 0xcac4ba, alpha: 1 };
