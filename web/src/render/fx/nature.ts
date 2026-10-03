import * as THREE from 'three';
import { Tile, groundHeight, type GameMap } from '../../sim/map';
import { TPS } from '../../sim/types';
import type { AtmosHost, Atmosphere } from '../atmos';
import { FogProbe } from '../ambient/shared';
import type { NightLights } from '../night';
import { Species, treeSpots, type TreeSpot } from '../vegetation';
import { WX } from '../wxuniforms';
import { Fireworks, type FireworkSound } from './fireworks';
import { NightLife } from './nightlife';

/*
 * Living nature (purely visual; never touches the simulation).
 *
 * NatureFx: one budget-capped particle pool, CPU-simulated and drawn as one
 * instanced draw call of camera-facing quads. Premultiplied blending lets the
 * same program draw alpha-blended (leaves, seeds, snow, dust) and additive
 * (fireflies, sparks) particles. Emitters, all near the view only:
 *   - falling leaves in autumn tones from the broadleaf trees, more in wind
 *   - pollen / dandelion seeds drifting on sunny days (temperate)
 *   - clumps of snow sliding off the branches (winter / snow cover)
 *   - fireflies blinking near water and forest edges on warm nights
 *   - dust devils wandering across the desert by day
 *   - sparks of the campfires (nightlife.ts)
 *   - heat shimmer over the desert in the afternoon (high quality: the
 *     existing screen-space haze field, no new pass)
 *
 * Rainbow: one arc mesh, faded in opposite the sun when a shower clears and
 * the sun is low. Free cameras (photo mode, intro / outro) see it where it
 * physically is (42 degrees around the antisolar point); the RTS camera looks
 * down at the ground, so there it stands over the far side of the view.
 *
 * Snow accumulation: while snow falls, WX.wxSnow (the shared snow cover of
 * roofs, tree tops, vehicles, props and ground) grows; afterwards it melts.
 *
 * LivingWorld ties it together with the night life (nightlife.ts) and the
 * victory fireworks (fireworks.ts); the Atmosphere owns one and calls it.
 *
 * Quality: low = no particles, no rainbow (night lights only); medium / high
 * add at most 4 draw calls (particles, rainbow while visible, neon signs in
 * a city at night, fireworks during the victory outro). No per-frame
 * allocations. Debug: ?nature=0 off, ?rainbow=1 forces the rainbow,
 * ?snowacc=<0..1> pins the snow cover, ?devil=1 forces dust devils,
 * ?fireflies=1 forces fireflies, ?leaves=<k> multiplies the leaf rate.
 */

type Q = 'low' | 'medium' | 'high';

const LEAF = 0;
const SEED = 1;
const SNOW = 2;
const FLY = 3;
const DUST = 4;
/** Campfire sparks (nightlife.ts spawns them). */
export const SPARK = 5;

const VERT = /* glsl */ `
attribute vec4 aP;   // x, y, z, size
attribute vec4 aK;   // kind, rotation, alpha, flip (leaf tumble)
attribute vec3 aC;   // colour
varying vec2 vUv;
varying float vKind;
varying float vA;
varying vec3 vCol;
void main() {
  vec4 mv = viewMatrix * vec4( aP.xyz, 1.0 );
  vec2 q = position.xy;
  q.x *= aK.w;
  float c = cos( aK.y );
  float s = sin( aK.y );
  mv.xy += vec2( c * q.x - s * q.y, s * q.x + c * q.y ) * aP.w;
  vUv = position.xy * 2.0;
  vKind = aK.x;
  vA = aK.z;
  vCol = aC;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform vec3 uLight;
varying vec2 vUv;
varying float vKind;
varying float vA;
varying vec3 vCol;
void main() {
  vec2 q = vUv;
  float r2 = dot( q, q );
  vec3 col;
  float a;
  float add = 0.0;
  if ( vKind < 0.5 ) {
    // leaf: pointed oval with a darker midrib, lit by the scene
    float e = length( vec2( q.x * 1.9, q.y ) );
    a = 1.0 - smoothstep( 0.78, 0.98, e + abs( q.y ) * 0.12 );
    col = vCol * ( 1.0 - 0.35 * ( 1.0 - smoothstep( 0.0, 0.1, abs( q.x ) ) ) * step( abs( q.y ), 0.85 ) ) * uLight;
  } else if ( vKind < 1.5 ) {
    // dandelion seed / pollen: a fuzzy pale tuft with a bright core
    a = exp( -r2 * 4.0 ) * 0.55 + exp( -r2 * 30.0 ) * 0.45;
    col = vCol * uLight * 1.3;
  } else if ( vKind < 2.5 ) {
    a = 1.0 - smoothstep( 0.2, 1.0, sqrt( r2 ) );
    col = vCol * uLight;
  } else if ( vKind < 3.5 ) {
    // firefly: a tiny hot core in a soft green-yellow glow (additive)
    a = exp( -r2 * 40.0 ) * 2.2 + exp( -r2 * 5.0 ) * 0.35;
    col = vCol;
    add = 1.0;
  } else if ( vKind < 4.5 ) {
    a = pow( max( 0.0, 1.0 - sqrt( r2 ) ), 1.6 );
    col = vCol * uLight;
  } else {
    a = exp( -r2 * 14.0 ) * 1.6;
    col = vCol;
    add = 1.0;
  }
  a *= vA;
  if ( a < 0.003 ) discard;
  // premultiplied: alpha-blended kinds write their coverage, additive kinds none
  gl_FragColor = vec4( col * a, a * ( 1.0 - add ) );
}`;

const AUTUMN = [0xd9822b, 0xc1440e, 0xe8b13a, 0x9b3d12, 0xb5651d, 0xd4a017, 0x8f9a2b, 0x7a4a22, 0xe0a030, 0xa83010].map((h) => new THREE.Color(h));
const BROADLEAF = new Set<Species>([Species.Oak, Species.Birch, Species.Young, Species.Poplar, Species.Willow, Species.Fruit]);
/** Rough crown height / radius of a species (fraction of the tree scale). */
const CROWN_Y = [0.95, 0.9, 0.7, 0.76, 0.5, 0.74, 0.62, 0.47, 1.0, 0.82];
const CROWN_R = [0.3, 0.28, 0.46, 0.26, 0.27, 0.17, 0.46, 0.36, 0.4, 0.5];

const sstep = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Points bucketed in a coarse grid (cheap "something near the view" picks). */
class Buckets {
  readonly start: Int32Array;
  readonly items: Int32Array;
  readonly gw: number;
  readonly gh: number;
  constructor(
    w: number,
    h: number,
    readonly cell: number,
    xs: ArrayLike<number>,
    ys: ArrayLike<number>,
    n: number,
  ) {
    const gw = (this.gw = Math.ceil(w / cell));
    const gh = (this.gh = Math.ceil(h / cell));
    const cnt = new Int32Array(gw * gh + 1);
    const cellOf = (i: number) => Math.min(gh - 1, Math.max(0, Math.floor(ys[i] / cell))) * gw + Math.min(gw - 1, Math.max(0, Math.floor(xs[i] / cell)));
    for (let i = 0; i < n; i++) cnt[cellOf(i) + 1]++;
    for (let i = 0; i < gw * gh; i++) cnt[i + 1] += cnt[i];
    this.start = cnt;
    this.items = new Int32Array(n);
    const fill = cnt.slice(0, gw * gh);
    for (let i = 0; i < n; i++) this.items[fill[cellOf(i)]++] = i;
  }

  /** A random item in a random non-empty cell of the rectangle (-1 if none found in a few tries). */
  pick(x0: number, y0: number, x1: number, y1: number): number {
    const c0 = Math.max(0, Math.floor(x0 / this.cell));
    const c1 = Math.min(this.gw - 1, Math.floor(x1 / this.cell));
    const r0 = Math.max(0, Math.floor(y0 / this.cell));
    const r1 = Math.min(this.gh - 1, Math.floor(y1 / this.cell));
    if (c1 < c0 || r1 < r0) return -1;
    for (let k = 0; k < 6; k++) {
      const cx = c0 + Math.floor(Math.random() * (c1 - c0 + 1));
      const cy = r0 + Math.floor(Math.random() * (r1 - r0 + 1));
      const ci = cy * this.gw + cx;
      const a = this.start[ci];
      const b = this.start[ci + 1];
      if (b > a) return this.items[a + Math.floor(Math.random() * (b - a))];
    }
    return -1;
  }
}

interface Devil {
  x: number;
  z: number;
  vx: number;
  vz: number;
  age: number;
  life: number;
  acc: number;
}

/** The particle pool. */
export class NatureFx {
  readonly mesh: THREE.Mesh;
  private max: number;
  private n = 0;
  private x: Float32Array;
  private y: Float32Array;
  private z: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  private age: Float32Array;
  private life: Float32Array;
  private size: Float32Array;
  private rot: Float32Array;
  private rotV: Float32Array;
  private seed: Float32Array;
  private gnd: Float32Array;
  private kind: Uint8Array;
  private col: Float32Array;
  private a0: Float32Array;
  private aP: THREE.InstancedBufferAttribute;
  private aK: THREE.InstancedBufferAttribute;
  private aC: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  /** Live particles per kind (budget shares). */
  readonly count = new Int32Array(6);

  constructor(quality: Q) {
    const max = (this.max = quality === 'high' ? 900 : 460);
    this.x = new Float32Array(max);
    this.y = new Float32Array(max);
    this.z = new Float32Array(max);
    this.vx = new Float32Array(max);
    this.vy = new Float32Array(max);
    this.vz = new Float32Array(max);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max);
    this.size = new Float32Array(max);
    this.rot = new Float32Array(max);
    this.rotV = new Float32Array(max);
    this.seed = new Float32Array(max);
    this.gnd = new Float32Array(max);
    this.kind = new Uint8Array(max);
    this.col = new Float32Array(max * 3);
    this.a0 = new Float32Array(max);
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = (this.geo = new THREE.InstancedBufferGeometry());
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    const mk = (n: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(max * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    geo.setAttribute('aP', (this.aP = mk(4)));
    geo.setAttribute('aK', (this.aK = mk(4)));
    geo.setAttribute('aC', (this.aC = mk(3)));
    geo.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uLight: { value: new THREE.Color(1, 1, 1) } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.name = 'nature-particles';
    this.mesh.visible = false;
  }

  get free() {
    return this.max - this.n;
  }

  /** Scene light on the lit (non-glowing) particles. */
  setLight(c: THREE.Color) {
    (this.mat.uniforms.uLight.value as THREE.Color).copy(c);
  }

  /** Add one particle; returns its index or -1 when the pool is full. */
  spawn(kind: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, c: THREE.Color, alpha: number, ground: number): number {
    if (this.n >= this.max) return -1;
    const i = this.n++;
    this.kind[i] = kind;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.size[i] = size;
    this.rot[i] = Math.random() * Math.PI * 2;
    this.rotV[i] = (Math.random() - 0.5) * 6;
    this.seed[i] = Math.random();
    this.gnd[i] = ground;
    this.col[i * 3] = c.r;
    this.col[i * 3 + 1] = c.g;
    this.col[i * 3 + 2] = c.b;
    this.a0[i] = alpha;
    this.count[kind]++;
    return i;
  }

  /** Per-particle extras set right after spawn (fireflies: blink period; dust: spin). */
  setSpin(i: number, rotV: number) {
    if (i >= 0) this.rotV[i] = rotV;
  }

  private kill(i: number) {
    const j = --this.n;
    this.count[this.kind[i]]--;
    if (i === j) return;
    this.kind[i] = this.kind[j];
    this.x[i] = this.x[j];
    this.y[i] = this.y[j];
    this.z[i] = this.z[j];
    this.vx[i] = this.vx[j];
    this.vy[i] = this.vy[j];
    this.vz[i] = this.vz[j];
    this.age[i] = this.age[j];
    this.life[i] = this.life[j];
    this.size[i] = this.size[j];
    this.rot[i] = this.rot[j];
    this.rotV[i] = this.rotV[j];
    this.seed[i] = this.seed[j];
    this.gnd[i] = this.gnd[j];
    this.col[i * 3] = this.col[j * 3];
    this.col[i * 3 + 1] = this.col[j * 3 + 1];
    this.col[i * 3 + 2] = this.col[j * 3 + 2];
    this.a0[i] = this.a0[j];
  }

  /**
   * Step and upload. wx / wz: wind (world units / s); night: firefly visibility 0..1;
   * (x0, z0, x1, z1): the view rectangle (fireflies leaving it are recycled).
   */
  update(dt: number, wx: number, wz: number, night: number, x0: number, z0: number, x1: number, z1: number) {
    const P = this.aP.array as Float32Array;
    const K = this.aK.array as Float32Array;
    const Cc = this.aC.array as Float32Array;
    let i = 0;
    while (i < this.n) {
      const age = (this.age[i] += dt);
      const life = this.life[i];
      if (age >= life) {
        this.kill(i);
        continue;
      }
      const sd = this.seed[i];
      const kd = this.kind[i];
      let rx = this.x[i];
      let ry = this.y[i];
      let rz = this.z[i];
      let size = this.size[i];
      let alpha = this.a0[i] * Math.min(1, age * 2.5) * Math.min(1, (life - age) * 0.8);
      let flip = 1;
      if (kd === LEAF) {
        if (this.vy[i] !== 0) {
          const k = Math.min(1, dt * 1.4);
          this.vx[i] += (wx * 1.1 - this.vx[i]) * k;
          this.vz[i] += (wz * 1.1 - this.vz[i]) * k;
          // flutter: side-slips and a tumbling spin
          const fl = Math.sin(age * 2.6 + sd * 40) * 0.45;
          rx = this.x[i] += (this.vx[i] + fl * 0.6) * dt;
          rz = this.z[i] += (this.vz[i] - fl * 0.4) * dt;
          ry = this.y[i] += this.vy[i] * (1 + 0.5 * Math.sin(age * 3.3 + sd * 17)) * dt;
          this.rot[i] += this.rotV[i] * dt;
          flip = Math.sin(age * 3.4 + sd * 9);
          flip = flip < 0 ? Math.min(-0.2, flip) : Math.max(0.2, flip);
          if (ry <= this.gnd[i] + 0.015) {
            // landed: lies still and fades
            this.y[i] = ry = this.gnd[i] + 0.015;
            this.vy[i] = 0;
            this.life[i] = Math.min(life, age + 4 + sd * 4);
          }
        } else flip = 0.35 + sd * 0.5;
      } else if (kd === SEED) {
        rx = this.x[i] += (wx * 0.75 + Math.sin(age * 0.7 + sd * 30) * 0.12) * dt;
        rz = this.z[i] += (wz * 0.75 + Math.cos(age * 0.6 + sd * 20) * 0.12) * dt;
        ry = this.y[i] += (0.03 + Math.sin(age * 0.9 + sd * 7) * 0.08) * dt;
        if (ry < this.gnd[i] + 0.08) this.y[i] = ry = this.gnd[i] + 0.08;
      } else if (kd === SNOW) {
        this.vy[i] -= 2.6 * dt;
        const k = Math.min(1, dt * 1.6);
        this.vx[i] += (wx - this.vx[i]) * k;
        this.vz[i] += (wz - this.vz[i]) * k;
        rx = this.x[i] += this.vx[i] * dt;
        ry = this.y[i] += this.vy[i] * dt;
        rz = this.z[i] += this.vz[i] * dt;
        size *= 1 + age * 0.6;
        if (ry <= this.gnd[i]) {
          this.kill(i);
          continue;
        }
      } else if (kd === FLY) {
        // vx / vz: home spot, vy: hover height, rotV: blink period
        rx = this.vx[i] + Math.sin(age * 0.37 + sd * 13) * 0.7 + Math.sin(age * 0.91 + sd * 5) * 0.25;
        rz = this.vz[i] + Math.cos(age * 0.33 + sd * 11) * 0.7 + Math.sin(age * 0.77 + sd * 3) * 0.25;
        ry = this.vy[i] + Math.sin(age * 0.6 + sd * 3) * 0.14;
        this.x[i] = rx;
        this.y[i] = ry;
        this.z[i] = rz;
        const ph = (age / this.rotV[i] + sd) % 1;
        const glow = sstep(0, 0.06, ph) * (1 - sstep(0.16, 0.4, ph));
        alpha *= (0.1 + glow) * night;
        size *= 0.75 + 0.6 * glow;
        if (rx < x0 - 4 || rx > x1 + 4 || rz < z0 - 4 || rz > z1 + 4 || night < 0.02) {
          this.kill(i);
          continue;
        }
      } else if (kd === DUST) {
        // (x, z): the whirl's axis, carried along; the puff circles it, rising and widening
        this.x[i] += this.vx[i] * dt;
        this.z[i] += this.vz[i] * dt;
        this.vy[i] *= 1 - dt * 0.35;
        ry = this.y[i] += this.vy[i] * dt;
        this.rot[i] += this.rotV[i] * dt;
        const h = ry - this.gnd[i];
        const rad = 0.08 + h * 0.3 + sd * 0.08;
        const a = this.rot[i];
        rx = this.x[i] + Math.cos(a) * rad;
        rz = this.z[i] + Math.sin(a) * rad;
        size *= 1 + age * 0.55;
      } else {
        // spark: buoyant, wind-blown, dimming
        this.vy[i] -= 0.6 * dt;
        rx = this.x[i] += (this.vx[i] + wx * 0.6) * dt;
        ry = this.y[i] += this.vy[i] * dt;
        rz = this.z[i] += (this.vz[i] + wz * 0.6) * dt;
        alpha *= (1 - age / life) * (0.7 + 0.3 * Math.sin(age * 30 + sd * 50));
      }
      P[i * 4] = rx;
      P[i * 4 + 1] = ry;
      P[i * 4 + 2] = rz;
      P[i * 4 + 3] = size;
      K[i * 4] = kd;
      K[i * 4 + 1] = this.rot[i];
      K[i * 4 + 2] = alpha;
      K[i * 4 + 3] = flip;
      Cc[i * 3] = this.col[i * 3];
      Cc[i * 3 + 1] = this.col[i * 3 + 1];
      Cc[i * 3 + 2] = this.col[i * 3 + 2];
      i++;
    }
    const n = this.n;
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    if (!n) return;
    for (const [a, w] of [
      [this.aP, 4],
      [this.aK, 4],
      [this.aC, 3],
    ] as const) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * w);
      a.needsUpdate = true;
    }
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ------------------------------------------------------------ rainbow

const BOW_VERT = /* glsl */ `
varying vec2 vQ;
void main() {
  vQ = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}`;

const BOW_FRAG = /* glsl */ `
uniform float uAmount;
uniform float uFeet;
varying vec2 vQ;
vec3 spectrum( float t ) {
  // t 0 = violet (inner) .. 1 = red (outer)
  return clamp( vec3( 1.6 * t - 0.45, 1.1 - abs( t - 0.55 ) * 2.6, 1.0 - t * 1.9 ), 0.0, 1.0 ) + vec3( 0.22, 0.0, 0.3 ) * ( 1.0 - smoothstep( 0.0, 0.2, t ) );
}
void main() {
  float r = length( vQ );
  // primary bow (radius 0.9 .. 1.0), the faint reversed secondary outside it, a brighter sky inside
  float p = ( r - 0.9 ) / 0.1;
  float s = ( 1.32 - r ) / 0.13;
  vec3 col = vec3( 0.0 );
  float band = smoothstep( 0.0, 0.3, p ) * ( 1.0 - smoothstep( 0.7, 1.0, p ) );
  col += spectrum( clamp( p, 0.0, 1.0 ) ) * band;
  float band2 = smoothstep( 0.0, 0.2, s ) * ( 1.0 - smoothstep( 0.8, 1.0, s ) );
  col += spectrum( clamp( s, 0.0, 1.0 ) ) * band2 * 0.28;
  col += vec3( 0.06 ) * ( 1.0 - smoothstep( 0.6, 0.9, r ) ) * smoothstep( 0.2, 0.8, r );
  // feet: fades where the arc meets the ground / the ends of the mesh
  float ang = vQ.y / max( r, 1e-3 );
  col *= smoothstep( uFeet, uFeet + 0.35, ang );
  gl_FragColor = vec4( col * uAmount, 1.0 );
}`;

export class Rainbow {
  readonly mesh: THREE.Mesh;
  private u = { uAmount: { value: 0 }, uFeet: { value: 0 } };
  private m = new THREE.Matrix4();
  private bx = new THREE.Vector3();
  private by = new THREE.Vector3();
  private bz = new THREE.Vector3();
  private c = new THREE.Vector3();

  constructor() {
    const g = new THREE.RingGeometry(0.86, 1.36, 72, 1, 0, Math.PI);
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: BOW_VERT, fragmentShader: BOW_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }));
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    this.mesh.name = 'rainbow';
    this.mesh.visible = false;
  }

  /**
   * amount 0..1; sun = direction towards the sun (world); free = free camera (physical placement),
   * otherwise it stands over the far side of the RTS view around `target` (vh = visible height).
   */
  place(amount: number, cam: THREE.Camera, sun: THREE.Vector3, free: boolean, target: THREE.Vector3, vh: number) {
    this.u.uAmount.value = amount * 0.3;
    this.mesh.visible = amount > 0.004;
    if (!this.mesh.visible) return;
    const cp = cam.position;
    if (free) {
      // 42 degrees around the antisolar point, far out (terrain in front hides the lower part)
      const D = 140;
      this.bz.copy(sun).multiplyScalar(1); // plane normal towards the sun = facing the camera
      this.c.copy(cp).addScaledVector(sun, -D);
      this.by.set(0, 1, 0).addScaledVector(this.bz, -this.bz.y).normalize();
      this.bx.crossVectors(this.by, this.bz).normalize();
      const R = D * Math.tan(THREE.MathUtils.degToRad(42)) / 0.95;
      this.m.makeBasis(this.bx.multiplyScalar(R), this.by.multiplyScalar(R), this.bz).setPosition(this.c);
    } else {
      // the RTS camera looks down at the ground: a camera-facing arc through the view centre, drawn over
      // the upper (far) half of the view like a bow standing over the far side; the feet fade out
      const cam = this.bz.copy(cp).sub(target).normalize();
      this.by.set(0, 1, 0).addScaledVector(cam, -cam.y).normalize();
      this.bx.crossVectors(this.by, cam).normalize();
      // the camera's up on screen (orthogonal to the view direction)
      this.by.crossVectors(cam, this.bx).normalize();
      const R = vh * 0.74;
      this.c.copy(target).addScaledVector(this.by, -vh * 0.3);
      this.m.makeBasis(this.bx.multiplyScalar(R), this.by.multiplyScalar(R), cam).setPosition(this.c);
    }
    const mat = this.mesh.material as THREE.ShaderMaterial;
    mat.depthTest = free;
    this.u.uFeet.value = free ? 0 : 0.42;
    this.mesh.matrix.copy(this.m);
    this.mesh.matrixWorld.copy(this.m);
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

// ------------------------------------------------------------ the orchestrator

const _c = new THREE.Color();
const _c2 = new THREE.Color();
const _sun = new THREE.Vector3();

/**
 * Living nature, the night life and the fireworks, driven by the atmosphere
 * (time of day, weather, wind). Created and updated by the Atmosphere.
 */
export class LivingWorld {
  readonly nature: NatureFx | null = null;
  readonly rainbow: Rainbow | null = null;
  readonly nightlife: NightLife;
  fireworks: Fireworks | null = null;
  /** Snow lying on things (WX.wxSnow is driven from this while snow can fall). */
  snow = 0;
  /** Rainbow strength 0..1 (fades in and out). */
  bow = 0;
  private map: GameMap;
  private probe: FogProbe;
  private q: Q;
  private biome: string;
  private trees: TreeSpot[] = [];
  private treeB: Buckets | null = null;
  private flyX: Float32Array = new Float32Array(0);
  private flyY: Float32Array = new Float32Array(0);
  private flyB: Buckets | null = null;
  private devils: Devil[] = [];
  private devilT = 4;
  private acc = { leaf: 0, seed: 0, snow: 0, fly: 0, heat: 0 };
  private lastTick = -1;
  private keyDir = new THREE.Vector3(-0.985, 0.8, 0.2).normalize();
  private freeView = false;
  private params: URLSearchParams;
  private forced = { rainbow: false, devil: false, fireflies: false, leaves: 1, snowAcc: -1 };
  private enabled: boolean;
  private x0 = 0;
  private z0 = 0;
  private x1 = 0;
  private z1 = 0;

  constructor(
    private atmos: Atmosphere,
    private host: AtmosHost,
  ) {
    const q = (this.q = host.quality);
    const map = (this.map = host.world.map);
    this.biome = atmos.look.biome;
    this.params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    const num = (k: string, d: number) => {
      const v = this.params.get(k);
      return v !== null && v !== '' && Number.isFinite(+v) ? +v : d;
    };
    this.forced.rainbow = this.params.get('rainbow') === '1';
    this.forced.devil = this.params.get('devil') === '1';
    this.forced.fireflies = this.params.get('fireflies') === '1';
    this.forced.leaves = num('leaves', 1);
    this.forced.snowAcc = num('snowacc', -1);
    this.enabled = this.params.get('nature') !== '0';
    this.probe = new FogProbe(host.fog, map.w, map.h);
    // a snow battle starts with a thin cover that builds up (the winter map's snow has lain for weeks)
    this.snow = atmos.cfg.weather === 'snow' ? 0.32 : 0;
    if (this.enabled && q !== 'low') {
      const nat = (this.nature = new NatureFx(q));
      host.scene.add(nat.mesh);
      const rb = (this.rainbow = new Rainbow());
      host.scene.add(rb.mesh);
      this.trees = treeSpots(map, q);
      const tx = new Float32Array(this.trees.length);
      const ty = new Float32Array(this.trees.length);
      this.trees.forEach((t, i) => {
        tx[i] = t.x;
        ty[i] = t.y;
      });
      this.treeB = new Buckets(map.w, map.h, 8, tx, ty, this.trees.length);
      this.fireflySpots();
    }
    this.nightlife = new NightLife(host, atmos.look.biome, q, this.probe, this.nature, this.enabled);
  }

  /** Firefly haunts: open ground by the water and along the forest edges. */
  private fireflySpots() {
    const m = this.map;
    if (this.biome === 'winter') return;
    const xs: number[] = [];
    const ys: number[] = [];
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= m.w || y >= m.h ? -1 : y * m.w + x);
    for (let y = 1; y < m.h - 1; y++)
      for (let x = 1; x < m.w - 1; x++) {
        const i = y * m.w + x;
        const t = m.tiles[i];
        if (t === Tile.Water || t === Tile.Rock || t === Tile.Bridge || m.trees[i] || m.blocked[i]) continue;
        if (this.biome === 'desert' && t === Tile.Sand) continue;
        let water = false;
        let wood = false;
        for (let dy = -2; dy <= 2 && !(water && wood); dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const j = at(x + dx, y + dy);
            if (j < 0) continue;
            if (m.tiles[j] === Tile.Water) water = true;
            if (m.trees[j] && Math.abs(dx) + Math.abs(dy) <= 2) wood = true;
          }
        if (!water && !wood) continue;
        xs.push(x + 0.5);
        ys.push(y + 0.5);
      }
    this.flyX = Float32Array.from(xs);
    this.flyY = Float32Array.from(ys);
    this.flyB = new Buckets(m.w, m.h, 8, this.flyX, this.flyY, xs.length);
  }

  /** The renderer's key light direction and whether a free camera is looking (driveSky). */
  sky(keyDir: THREE.Vector3, freeView: boolean) {
    this.keyDir.copy(keyDir);
    this.freeView = freeView;
  }

  /** A blast on the ground at tile (x, y): street lamps flicker / die nearby. */
  impact(x: number, y: number, size: number, time: number) {
    this.nightlife.impact(x, y, size, time, this.atmos.night);
  }

  /**
   * Victory: fireworks over the player's base, the nearest town and where the camera is looking.
   * `focus` = the outro's look-at point (tile x, y); `sound` plays the launch / boom / crackle.
   */
  celebrate(player: number, focus: { x: number; y: number } | null, sound: FireworkSound | null) {
    const w = this.host.world;
    const m = this.map;
    // the player's base: their buildings' centre (or their start)
    let bx = 0;
    let by = 0;
    let nb = 0;
    for (const e of w.entities.values()) {
      if (e.kind !== 'building' || e.dead || e.owner !== player) continue;
      bx += e.tx + 1;
      by += e.ty + 1;
      nb++;
    }
    const st = m.starts[Math.max(0, Math.min(m.starts.length - 1, player))];
    if (nb) {
      bx /= nb;
      by /= nb;
    } else if (st) {
      bx = st.x + 0.5;
      by = st.y + 0.5;
    } else {
      bx = m.w / 2;
      by = m.h / 2;
    }
    // the town nearest the base
    let cx = -1;
    let cy = -1;
    let best = 1e9;
    for (const s of m.structures) {
      const x = s.x + s.w / 2;
      const y = s.y + s.h / 2;
      const d = Math.hypot(x - bx, y - by);
      if (d > 6 && d < best) {
        best = d;
        cx = x;
        cy = y;
      }
    }
    const sites: { x: number; y: number; w: number }[] = [];
    if (focus) sites.push({ x: focus.x, y: focus.y, w: 0.5 });
    sites.push({ x: bx, y: by, w: focus ? 0.3 : 0.65 });
    if (cx >= 0) sites.push({ x: cx, y: cy, w: 0.25 });
    if (!this.fireworks) {
      this.fireworks = new Fireworks(this.q, this.host.effects);
      this.host.scene.add(this.fireworks.mesh);
    }
    this.fireworks.start(sites, m, sound);
  }

  /** Game seconds since the last frame (follows the game speed and pause). */
  private gameDt(): number {
    const tick = this.host.world.tick;
    const d = this.lastTick < 0 ? 0 : Math.max(0, Math.min(TPS, tick - this.lastTick)) / TPS;
    this.lastTick = tick;
    return d;
  }

  /** Snow accumulation: grows while it snows, melts afterwards (drives WX.wxSnow). */
  private snowCover(gdt: number) {
    const a = this.atmos;
    const st = a.wx;
    const falling = st ? (st.fall === 'snow' ? st.precip : 0) : a.cfg.weather === 'snow' ? 1 : 0;
    const cap = st ? 0.85 : 1;
    if (falling > 0.05) this.snow = Math.min(cap, this.snow + (falling * gdt * (1 - this.snow * 0.35)) / 150);
    else if (this.snow > 0) this.snow = Math.max(0, this.snow - (gdt / (a.daylight > 0.5 ? 320 : 900)) * (1 + 2 * WX.wxWet.value));
    if (this.forced.snowAcc >= 0) this.snow = this.forced.snowAcc;
    // static snow weather: the shared cover follows the accumulation (dynamic: atmos.ts reads `snow`)
    if (!st && (a.cfg.weather === 'snow' || this.forced.snowAcc >= 0)) WX.wxSnow.value = Math.max(a.look.snowFloor, this.snow);
  }

  /** Per frame (Atmosphere.update), time = render clock (s). */
  update(dt: number, time: number, target: THREE.Vector3, zoom: number, camera: THREE.Camera) {
    const a = this.atmos;
    const gdt = this.gameDt();
    this.snowCover(gdt);
    const dark = a.night ? a.night.darkness : 1 - a.daylight;
    const night = a.night;
    if (night && night.hook !== this.nightHook) night.hook = this.nightHook;
    // view rectangle (tile space)
    const vh = 22 / Math.max(0.3, zoom);
    const asp = (camera as THREE.PerspectiveCamera).aspect ?? 1.6;
    const R = vh * 0.5 * Math.max(1, asp) * 1.15 + 1.5;
    const Rz = vh * 0.85 + 1.5;
    this.x0 = target.x - R;
    this.x1 = target.x + R;
    this.z0 = target.z - Rz;
    this.z1 = target.z + Rz;
    const gt = this.host.world.tick / TPS;
    this.nightlife.update(dt, time, gt, dark, a, this.x0, this.z0, this.x1, this.z1);
    if (this.fireworks) {
      const tg = groundHeight(this.map, Math.max(0, Math.min(this.map.w - 0.01, target.x)), Math.max(0, Math.min(this.map.h - 0.01, target.z)));
      this.fireworks.update(camera.position.y - tg);
    }
    const nat = this.nature;
    if (!nat) return;
    // ---- weather state
    const st = a.wx;
    const rain = WX.wxRain.value;
    const precip = st ? st.precip : a.cfg.weather === 'clear' || a.cfg.weather === 'dynamic' ? 0 : 1;
    const cover = st ? st.cover : a.cfg.weather === 'clear' ? 0.2 : 0.9;
    const day = a.daylight;
    const w = this.host.effects.wind;
    const wx = w.x * 1.5;
    const wz = w.z * 1.5;
    const wk = Math.min(1, Math.hypot(w.x, w.z));
    // lit particles follow the scene light
    _c.copy(this.host.sun.color).lerp(_c2.setRGB(1, 1, 1), 0.5).multiplyScalar(0.18 + 0.95 * day);
    _c.lerp(this.host.hemi.color, 0.25);
    nat.setLight(_c);
    const fr = Math.min(0.1, dt);
    // ---- leaves (temperate / city parks; not under snow)
    const tb = this.treeB;
    if (tb && (this.biome === 'temperate' || this.biome === 'urban') && WX.wxSnow.value < 0.3) {
      this.acc.leaf += fr * (this.q === 'high' ? 1 : 0.6) * (2.6 + 14 * Math.pow(wk, 1.5)) * (1 - 0.5 * rain) * this.forced.leaves;
      let tries = 6;
      while (this.acc.leaf >= 1 && tries-- > 0 && nat.count[LEAF] < 260) {
        this.acc.leaf -= 1;
        const ti = tb.pick(this.x0, this.z0, this.x1, this.z1);
        if (ti < 0) break;
        const t = this.trees[ti];
        if (!BROADLEAF.has(t.species) || !this.probe.visible(t.x, t.y)) continue;
        const cr = CROWN_R[t.species] * t.s * 0.8;
        const ang = Math.random() * Math.PI * 2;
        const rr = (0.75 + Math.random() * 0.55) * cr;
        const g = groundHeight(this.map, t.x, t.y);
        const lc = AUTUMN[Math.floor(Math.random() * AUTUMN.length)];
        _c2.copy(lc).multiplyScalar(0.85 + Math.random() * 0.3);
        nat.spawn(LEAF, t.x + Math.cos(ang) * rr, g + (CROWN_Y[t.species] + (Math.random() - 0.3) * 0.25) * t.s, t.y + Math.sin(ang) * rr, wx, -(0.28 + Math.random() * 0.2), wz, 14, 0.12 + Math.random() * 0.06, _c2, 0.95, g);
      }
      if (this.acc.leaf > 3) this.acc.leaf = 3;
    }
    // ---- pollen / dandelion seeds on sunny, calm-ish days
    if (this.biome === 'temperate' && day > 0.7 && precip < 0.02 && cover < 0.5 && WX.wxWet.value < 0.35 && WX.wxSnow.value < 0.1) {
      this.acc.seed += fr * (this.q === 'high' ? 4 : 2.4) * sstep(0.7, 0.9, day);
      while (this.acc.seed >= 1 && nat.count[SEED] < 90) {
        this.acc.seed -= 1;
        const x = this.x0 + Math.random() * (this.x1 - this.x0);
        const z = this.z0 + Math.random() * (this.z1 - this.z0);
        if (x < 0 || z < 0 || x >= this.map.w || z >= this.map.h) continue;
        const ti = (z | 0) * this.map.w + (x | 0);
        if (this.map.tiles[ti] !== Tile.Grass || !this.probe.visible(x, z)) continue;
        const g = groundHeight(this.map, x, z);
        _c2.setRGB(0.96, 0.95, 0.86);
        if (Math.random() < 0.3) _c2.setRGB(1, 0.92, 0.55); // pollen
        nat.spawn(SEED, x, g + 0.25 + Math.random() * 1.1, z, 0, 0, 0, 7 + Math.random() * 5, 0.045 + Math.random() * 0.03, _c2, 0.85, g);
      }
      if (this.acc.seed > 3) this.acc.seed = 3;
    }
    // ---- snow sliding off the branches
    if (tb && (this.biome === 'winter' || WX.wxSnow.value > 0.35)) {
      this.acc.snow += fr * (this.q === 'high' ? 0.9 : 0.55) * (1 + 3 * wk);
      while (this.acc.snow >= 1 && nat.free > 20) {
        this.acc.snow -= 1;
        const ti = tb.pick(this.x0, this.z0, this.x1, this.z1);
        if (ti < 0) break;
        const t = this.trees[ti];
        if (!this.probe.visible(t.x, t.y)) continue;
        const g = groundHeight(this.map, t.x, t.y);
        const ang = Math.random() * Math.PI * 2;
        const cr = CROWN_R[t.species] * t.s * 0.7;
        const sx = t.x + Math.cos(ang) * cr;
        const sz = t.y + Math.sin(ang) * cr;
        const sy = g + (CROWN_Y[t.species] + 0.05 + Math.random() * 0.2) * t.s;
        const n = 7 + Math.floor(Math.random() * 7);
        _c2.setRGB(0.93, 0.95, 1);
        for (let k = 0; k < n; k++) nat.spawn(SNOW, sx + (Math.random() - 0.5) * 0.12, sy + Math.random() * 0.08, sz + (Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.25, -Math.random() * 0.3, (Math.random() - 0.5) * 0.25, 3, 0.035 + Math.random() * 0.035, _c2, 0.95, g);
        // the powder cloud
        nat.spawn(SNOW, sx, sy - 0.05, sz, 0, -0.1, 0, 3, 0.16, _c2, 0.3, g);
      }
      if (this.acc.snow > 2) this.acc.snow = 2;
    }
    // ---- fireflies on warm, dry nights near water and forest edges
    const fb = this.flyB;
    const flyK = this.forced.fireflies ? 1 : this.biome === 'winter' || WX.wxSnow.value > 0.1 || rain > 0.05 ? 0 : sstep(0.55, 0.85, dark) * (1 - sstep(0.3, 0.8, wk));
    if (fb && flyK > 0.02) {
      const want = Math.round((this.q === 'high' ? 110 : 64) * flyK);
      let tries = 8;
      while (nat.count[FLY] < want && tries-- > 0) {
        const si = fb.pick(this.x0, this.z0, this.x1, this.z1);
        if (si < 0) break;
        const x = this.flyX[si] + (Math.random() - 0.5);
        const z = this.flyY[si] + (Math.random() - 0.5);
        if (!this.probe.visible(x, z)) continue;
        const g = groundHeight(this.map, x, z);
        _c2.setRGB(0.75, 1.0, 0.32).multiplyScalar(1.4);
        const i = nat.spawn(FLY, x, g, z, x, g + 0.18 + Math.random() * 0.5, z, 25 + Math.random() * 20, 0.2, _c2, 1, g);
        nat.setSpin(i, 1.8 + Math.random() * 3.2);
      }
    }
    // ---- dust devils crossing the desert by day
    if (this.biome === 'desert' || this.forced.devil) this.dustDevils(dt, nat, day, precip, wx, wz);
    // ---- heat shimmer over the desert on hot afternoons (high: the existing haze field)
    const hz = this.host.effects.haze;
    if (hz && this.q === 'high' && this.biome === 'desert' && day > 0.8 && precip < 0.05) {
      const u = a.phase;
      const aft = u < 0 ? (a.cfg.tod === 'day' ? 1 : 0) : sstep(0.0, 0.08, u) * (1 - sstep(0.28, 0.36, u));
      this.acc.heat += fr * 6 * aft;
      while (this.acc.heat >= 1) {
        this.acc.heat -= 1;
        const x = this.x0 + Math.random() * (this.x1 - this.x0);
        const z = this.z0 + Math.random() * (this.z1 - this.z0);
        if (x < 0 || z < 0 || x >= this.map.w || z >= this.map.h) continue;
        hz.heat(x, groundHeight(this.map, x, z) + 0.2, z, 2.6, 2.4, 0.0011, 0.25);
      }
    }
    nat.update(Math.min(0.1, dt), wx, wz, flyK, this.x0, this.z0, this.x1, this.z1);
    // ---- rainbow after a shower: opposite a low sun, the sky clearing
    const rb = this.rainbow;
    if (rb) {
      const ev = st?.event;
      const clearing = !!st && !!ev && ev.precip > 0 && ev.fall === 'rain' && (st.stage === 'clearing' || (st.stage === 'ease' && st.precip < 0.12));
      _sun.copy(this.keyDir);
      const el = _sun.y;
      const lowSun = sstep(0.04, 0.12, el) * (1 - sstep(0.6, 0.75, el));
      const sunUp = a.phase < 0 || !(a.phase > 0.46 && a.phase < 0.77);
      let goal = clearing && sunUp ? lowSun * sstep(0.3, 0.65, 1 - cover) * (1 - sstep(0.05, 0.2, st!.precip)) * sstep(0.45, 0.7, day) : 0;
      if (this.forced.rainbow) goal = 1;
      this.bow += Math.sign(goal - this.bow) * Math.min(Math.abs(goal - this.bow), dt / 8);
      if (this.bow > 0.004) {
        rb.place(this.bow, camera, _sun, this.freeView, target, vh);
      } else rb.place(0, camera, _sun, this.freeView, target, vh);
    }
    // ---- dawn: the valley fog catches the low sun
    const gf = a.groundFog;
    if (gf) {
      const u = a.phase;
      const dawn = u >= 0 ? sstep(0.74, 0.8, u) * (1 - sstep(0.86, 0.92, u)) : a.cfg.tod === 'mist' ? 1 - sstep(200, 700, gt) * 0.6 : 0;
      gf.setDawn(dawn, this.host.sun.color, this.keyDir);
    }
  }

  private dustDevils(dt: number, nat: NatureFx, day: number, precip: number, wx: number, wz: number) {
    const on = (day > 0.55 && precip < 0.05) || this.forced.devil;
    const maxN = this.q === 'high' ? 2 : 1;
    this.devilT -= dt;
    if (on && this.devils.length < maxN && this.devilT <= 0) {
      this.devilT = 6 + Math.random() * 14;
      // start just outside / at the edge of the view, upwind, so it crosses it
      for (let k = 0; k < 6; k++) {
        const x = this.x0 + Math.random() * (this.x1 - this.x0);
        const z = this.z0 + Math.random() * (this.z1 - this.z0);
        if (x < 1 || z < 1 || x >= this.map.w - 1 || z >= this.map.h - 1) continue;
        const t = this.map.tiles[(z | 0) * this.map.w + (x | 0)];
        if (t === Tile.Water || t === Tile.Rock || this.map.blocked[(z | 0) * this.map.w + (x | 0)]) continue;
        const wl = Math.hypot(wx, wz) || 1;
        const sp = 0.7 + Math.random() * 0.5;
        this.devils.push({ x, z, vx: (wx / wl) * sp + (Math.random() - 0.5) * 0.4, vz: (wz / wl) * sp + (Math.random() - 0.5) * 0.4, age: 0, life: 22 + Math.random() * 20, acc: 0 });
        break;
      }
    }
    for (let i = this.devils.length - 1; i >= 0; i--) {
      const d = this.devils[i];
      d.age += dt;
      // wanders: the track meanders
      const wob = Math.sin(d.age * 0.45 + i * 3) * 0.35;
      d.x += (d.vx - d.vz * wob) * dt;
      d.z += (d.vz + d.vx * wob) * dt;
      const env = sstep(0, 4, d.age) * (1 - sstep(d.life - 5, d.life, d.age));
      if (d.age >= d.life || d.x < 0 || d.z < 0 || d.x >= this.map.w || d.z >= this.map.h) {
        this.devils.splice(i, 1);
        continue;
      }
      const vis = this.probe.visible(d.x, d.z);
      if (!vis) continue;
      d.acc += dt * (this.q === 'high' ? 55 : 36) * env;
      const g = groundHeight(this.map, d.x, d.z);
      while (d.acc >= 1) {
        d.acc -= 1;
        _c2.setRGB(0.72, 0.56, 0.38).multiplyScalar(0.8 + Math.random() * 0.3);
        const low = Math.random() < 0.3;
        const i2 = nat.spawn(DUST, d.x, g + (low ? 0.02 : 0.05 + Math.random() * 0.2), d.z, d.vx, low ? 0.15 + Math.random() * 0.2 : 0.9 + Math.random() * 1.1, d.vz, 1.8 + Math.random() * 1.6, low ? 0.45 : 0.2 + Math.random() * 0.16, _c2, (low ? 0.4 : 0.62) * (0.6 + 0.4 * env), g);
        nat.setSpin(i2, 5 + Math.random() * 4);
      }
    }
  }

  /** Night lights hook (NightLights.update): the night life's lamps, beams and fires. */
  private nightHook = (n: NightLights, dark: number, time: number) => {
    this.nightlife.draw(n, dark, time, this.x0, this.z0, this.x1, this.z1);
    this.fireworks?.drawLights(n);
  };

  /** Debug / screenshots. */
  stats() {
    const n = this.nature;
    return {
      particles: n ? Array.from(n.count) : null,
      devils: this.devils.length,
      snow: +this.snow.toFixed(3),
      bow: +this.bow.toFixed(3),
      fireworks: this.fireworks?.live ?? 0,
      night: this.nightlife.stats(),
    };
  }

  dispose() {
    this.nature?.mesh.removeFromParent();
    this.nature?.dispose();
    this.rainbow?.mesh.removeFromParent();
    this.rainbow?.dispose();
    this.nightlife.dispose();
    this.fireworks?.dispose();
    if (this.atmos.night) this.atmos.night.hook = null;
  }
}
