import * as THREE from 'three';
import { groundHeight, type GameMap } from '../../sim/map';
import type { Effects } from '../effects';
import type { NightLights } from '../night';

/*
 * Victory fireworks (purely visual): rockets climb on a sparkling trail and
 * burst into peonies, gold willows, rings and crackling glitter over the
 * player's base, the nearest town and where the outro camera looks. One
 * instanced draw call of velocity-stretched additive sparks (budget-capped per
 * quality), a real light flash per burst (Effects.flashLight), a glow pool on
 * the ground at night (NightLights) and launch / boom / crackle sounds.
 *
 * Runs on real time (the outro slows the game down), about 16 s; no per-frame
 * allocations.
 */

export type FireworkSoundName = 'fwLaunch' | 'fwBoom' | 'fwCrackle';
/** Play a firework sound at a world position (sim tile x / y, height z). */
export type FireworkSound = (name: FireworkSoundName, volume: number, at: { x: number; y: number; z?: number }) => void;

const VERT = /* glsl */ `
attribute vec4 aP;  // x, y, z, size
attribute vec4 aV;  // velocity, streak time
attribute vec4 aC;  // rgb, alpha
varying vec2 vUv;
varying vec4 vC;
void main() {
  vec4 mv = viewMatrix * vec4( aP.xyz, 1.0 );
  vec3 vv = ( viewMatrix * vec4( aV.xyz, 0.0 ) ).xyz;
  vec2 ax = vv.xy;
  float sl = length( ax );
  ax = sl > 1e-4 ? ax / sl : vec2( 0.0, 1.0 );
  vec2 side = vec2( -ax.y, ax.x );
  float len = aP.w + sl * aV.w;
  // the streak trails behind the spark
  mv.xy += ax * ( position.y - 0.5 ) * len + side * position.x * aP.w;
  vUv = position.xy * vec2( 2.0, 1.0 );
  vC = aC;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
varying vec2 vUv;
varying vec4 vC;
void main() {
  float a = ( 1.0 - smoothstep( 0.2, 1.0, abs( vUv.x ) ) ) * smoothstep( -0.5, 0.35, vUv.y );
  a *= vC.a;
  if ( a < 0.003 ) discard;
  gl_FragColor = vec4( vC.rgb * a, 1.0 );
}`;

const PALETTE = [
  [1, 0.22, 0.15],
  [0.3, 1, 0.35],
  [0.35, 0.5, 1],
  [1, 0.8, 0.3],
  [1, 0.3, 0.9],
  [0.3, 0.95, 1],
  [1, 1, 1],
  [1, 0.55, 0.15],
] as const;

const ROCKET = 0;
const STAR = 1;
const EMBER = 2;
const GLITTER = 3;

const DURATION = 16;
const MAX_PENDING = 24;

export class Fireworks {
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
  private col: Float32Array;
  private size: Float32Array;
  private drag: Float32Array;
  private grav: Float32Array;
  private kind: Uint8Array;
  /** Rockets: burst type; stars: colour change seed. */
  private aux: Float32Array;
  private aP: THREE.InstancedBufferAttribute;
  private aV: THREE.InstancedBufferAttribute;
  private aC: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private qk: number;
  private sites: { x: number; y: number; w: number; g: number }[] = [];
  private map: GameMap | null = null;
  private sound: FireworkSound | null = null;
  private t = -1;
  private wall = 0;
  private nextShell = 0;
  /** Recent bursts for the ground glow: x, g, z, r, g, b, age. */
  private flashes = new Float32Array(8 * 7);
  private nFlash = 0;
  /** Delayed crackles: time, x, y, z. */
  private pending = new Float32Array(MAX_PENDING * 4);
  private nPend = 0;

  constructor(
    quality: 'low' | 'medium' | 'high',
    private effects: Effects,
  ) {
    const max = (this.max = quality === 'high' ? 2400 : quality === 'medium' ? 1300 : 520);
    this.qk = Math.max(0.35, max / 2400);
    this.x = new Float32Array(max);
    this.y = new Float32Array(max);
    this.z = new Float32Array(max);
    this.vx = new Float32Array(max);
    this.vy = new Float32Array(max);
    this.vz = new Float32Array(max);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.kind = new Uint8Array(max);
    this.aux = new Float32Array(max);
    const base = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const geo = (this.geo = new THREE.InstancedBufferGeometry());
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    const mk = (n: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(max * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    geo.setAttribute('aP', (this.aP = mk(4)));
    geo.setAttribute('aV', (this.aV = mk(4)));
    geo.setAttribute('aC', (this.aC = mk(4)));
    geo.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.name = 'fireworks';
    this.mesh.visible = false;
  }

  /** Live sparks (debug). */
  get live() {
    return this.n;
  }

  /** Start the show over these sites (tile x / y, weight = share of the shells). */
  start(sites: { x: number; y: number; w: number }[], map: GameMap, sound: FireworkSound | null) {
    this.map = map;
    this.sound = sound;
    this.sites = sites.map((s) => {
      const x = Math.max(1, Math.min(map.w - 1, s.x));
      const y = Math.max(1, Math.min(map.h - 1, s.y));
      return { x, y, w: s.w, g: groundHeight(map, x, y) };
    });
    this.t = 0;
    this.wall = performance.now();
    this.nextShell = 0.3;
  }

  private spawn(kind: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, r: number, g: number, b: number, drag: number, grav: number, aux = 0) {
    if (this.n >= this.max) return;
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
    this.col[i * 3] = r;
    this.col[i * 3 + 1] = g;
    this.col[i * 3 + 2] = b;
    this.drag[i] = drag;
    this.grav[i] = grav;
    this.aux[i] = aux;
  }

  private kill(i: number) {
    const j = --this.n;
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
    this.col[i * 3] = this.col[j * 3];
    this.col[i * 3 + 1] = this.col[j * 3 + 1];
    this.col[i * 3 + 2] = this.col[j * 3 + 2];
    this.drag[i] = this.drag[j];
    this.grav[i] = this.grav[j];
    this.aux[i] = this.aux[j];
  }

  private launch() {
    const s = this.sites;
    if (!s.length) return;
    let tot = 0;
    for (const o of s) tot += o.w;
    let r = Math.random() * tot;
    let site = s[0];
    for (const o of s) if ((r -= o.w) <= 0) {
      site = o;
      break;
    }
    const x = site.x + (Math.random() - 0.5) * 6;
    const z = site.y + (Math.random() - 0.5) * 6;
    const g = this.map ? groundHeight(this.map, Math.max(0, Math.min(this.map.w - 0.01, x)), Math.max(0, Math.min(this.map.h - 0.01, z))) : site.g;
    const type = Math.floor(Math.random() * 5);
    // fuse = life: bursts near the top of the climb
    this.spawn(ROCKET, x, g + 0.1, z, (Math.random() - 0.5) * 1.2, 10.5 + Math.random() * 2.5, (Math.random() - 0.5) * 1.2, 1.0 + Math.random() * 0.35, 0.2, 1, 0.8, 0.5, 0.25, 6.5, type);
    this.sound?.('fwLaunch', 0.35 + Math.random() * 0.2, { x, y: z, z: 0 });
  }

  private burst(x: number, y: number, z: number, type: number) {
    const c1 = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    const c2 = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    const I = 3.2;
    const N = Math.round((type === 1 ? 70 : type === 2 ? 56 : 86) * this.qk);
    // ring: a random tilt of the plane
    const ta = Math.random() * Math.PI;
    const tb = Math.random() * 0.9;
    for (let k = 0; k < N; k++) {
      let dx: number;
      let dy: number;
      let dz: number;
      if (type === 2) {
        const a = (k / N) * Math.PI * 2;
        const cx = Math.cos(a);
        const cy = Math.sin(a);
        // rotate the circle (x / y plane) by tilt tb about x, then ta about y
        const yy = cy * Math.cos(tb);
        const zz = cy * Math.sin(tb);
        dx = cx * Math.cos(ta) + zz * Math.sin(ta);
        dy = yy;
        dz = -cx * Math.sin(ta) + zz * Math.cos(ta);
      } else {
        // uniform on the sphere
        dy = Math.random() * 2 - 1;
        const a = Math.random() * Math.PI * 2;
        const rr = Math.sqrt(1 - dy * dy);
        dx = Math.cos(a) * rr;
        dz = Math.sin(a) * rr;
      }
      const sp = (type === 1 ? 2.6 : 3.4) * (type === 2 ? 1 : 0.85 + Math.random() * 0.3);
      const c = type === 1 ? PALETTE[3] : type === 4 && k % 2 ? c2 : c1;
      if (type === 3) this.spawn(GLITTER, x, y, z, dx * sp, dy * sp, dz * sp, 1.3 + Math.random() * 0.6, 0.13, I * 1.2, I * 1.1, I * 0.9, 1.3, 1.6);
      else if (type === 1) this.spawn(STAR, x, y, z, dx * sp, dy * sp + 0.4, dz * sp, 2.6 + Math.random() * 0.8, 0.14, I * c[0], I * c[1] * 0.85, I * c[2] * 0.6, 1.7, 1.2, 1);
      else this.spawn(STAR, x, y, z, dx * sp, dy * sp, dz * sp, 1.5 + Math.random() * 0.5, 0.17, I * c[0], I * c[1], I * c[2], 1.25, 1.9);
    }
    // the flash: real light on the scene, a glow pool on the ground, the bang
    const lc = (Math.round(c1[0] * 255) << 16) | (Math.round(c1[1] * 255) << 8) | Math.round(c1[2] * 255);
    this.effects.flashLight(x, y, z, 5, lc, 0.6);
    const fi = this.nFlash < 8 ? this.nFlash++ : Math.floor(Math.random() * 8);
    const g = this.map ? groundHeight(this.map, Math.max(0, Math.min(this.map.w - 0.01, x)), Math.max(0, Math.min(this.map.h - 0.01, z))) : 0;
    const F = this.flashes;
    F[fi * 7] = x;
    F[fi * 7 + 1] = g;
    F[fi * 7 + 2] = z;
    F[fi * 7 + 3] = c1[0];
    F[fi * 7 + 4] = c1[1];
    F[fi * 7 + 5] = c1[2];
    F[fi * 7 + 6] = 0;
    this.sound?.('fwBoom', 0.6 + Math.random() * 0.3, { x, y: z, z: y - g });
    if (type === 3 && this.nPend < MAX_PENDING) {
      const o = this.nPend++ * 4;
      this.pending[o] = this.t + 0.5;
      this.pending[o + 1] = x;
      this.pending[o + 2] = z;
      this.pending[o + 3] = y - g;
    }
  }

  /** Per frame (real time). */
  update() {
    if (this.t < 0 && this.n === 0) return;
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - this.wall) / 1000));
    this.wall = now;
    if (this.t >= 0) {
      this.t += dt;
      this.nextShell -= dt;
      if (this.t < DURATION && this.nextShell <= 0) {
        // a steady show, a busy finale
        const finale = this.t > DURATION - 3.5;
        this.nextShell = finale ? 0.08 + Math.random() * 0.14 : 0.22 + Math.random() * 0.45;
        this.launch();
        if (Math.random() < 0.25) this.launch();
      }
      if (this.t >= DURATION + 4) this.t = -1;
    }
    for (let j = this.nPend - 1; j >= 0; j--) {
      const p = this.pending;
      if (this.t >= 0 && this.t < p[j * 4]) continue;
      this.sound?.('fwCrackle', 0.55, { x: p[j * 4 + 1], y: p[j * 4 + 2], z: p[j * 4 + 3] });
      p.copyWithin(j * 4, (this.nPend - 1) * 4, this.nPend * 4);
      this.nPend--;
    }
    for (let j = 0; j < this.nFlash; j++) this.flashes[j * 7 + 6] += dt;
    const P = this.aP.array as Float32Array;
    const V = this.aV.array as Float32Array;
    const C = this.aC.array as Float32Array;
    let i = 0;
    while (i < this.n) {
      const age = (this.age[i] += dt);
      const kd = this.kind[i];
      if (age >= this.life[i]) {
        if (kd === ROCKET) {
          const bx = this.x[i];
          const by = this.y[i];
          const bz = this.z[i];
          const type = this.aux[i];
          this.kill(i);
          this.burst(bx, by, bz, type);
        } else this.kill(i);
        continue;
      }
      const dk = Math.max(0, 1 - this.drag[i] * dt);
      this.vx[i] *= dk;
      this.vz[i] *= dk;
      this.vy[i] = this.vy[i] * dk - this.grav[i] * dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.z[i] += this.vz[i] * dt;
      const lk = age / this.life[i];
      let a: number;
      let streak = 0.05;
      if (kd === ROCKET) {
        a = 1;
        streak = 0.04;
        // the climbing trail
        if (Math.random() < 0.8) this.spawn(EMBER, this.x[i], this.y[i] - 0.1, this.z[i], (Math.random() - 0.5) * 0.3, -0.3, (Math.random() - 0.5) * 0.3, 0.4 + Math.random() * 0.3, 0.12, 1.8, 1.1, 0.45, 1.5, 1);
      } else if (kd === STAR) {
        a = lk < 0.7 ? 1 : 1 - (lk - 0.7) / 0.3;
        // gold willow streaks longer and droops; the rest twinkle out at the end
        streak = this.aux[i] > 0 ? 0.16 : 0.07;
        if (lk > 0.75 && this.aux[i] === 0) a *= Math.random() < 0.6 ? 1 : 0.2;
      } else if (kd === EMBER) {
        a = (1 - lk) * 0.8;
        streak = 0.02;
      } else {
        // glitter: crackling white flashes after a short dark spell
        a = lk < 0.35 ? 0.6 * (1 - lk / 0.35) : Math.random() < 0.3 ? 1.6 : 0;
        streak = 0.0;
      }
      P[i * 4] = this.x[i];
      P[i * 4 + 1] = this.y[i];
      P[i * 4 + 2] = this.z[i];
      P[i * 4 + 3] = this.size[i];
      V[i * 4] = this.vx[i];
      V[i * 4 + 1] = this.vy[i];
      V[i * 4 + 2] = this.vz[i];
      V[i * 4 + 3] = streak;
      C[i * 4] = this.col[i * 3];
      C[i * 4 + 1] = this.col[i * 3 + 1];
      C[i * 4 + 2] = this.col[i * 3 + 2];
      C[i * 4 + 3] = a;
      i++;
    }
    const n = this.n;
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    if (!n) return;
    for (const [at, w] of [
      [this.aP, 4],
      [this.aV, 4],
      [this.aC, 4],
    ] as const) {
      at.clearUpdateRanges();
      at.addUpdateRange(0, n * w);
      at.needsUpdate = true;
    }
  }

  /** Night: the bursts light up the ground below (NightLights hook). */
  drawLights(nl: NightLights) {
    const f = this.flashes;
    for (let j = 0; j < this.nFlash; j++) {
      const age = f[j * 7 + 6];
      if (age > 1.2) continue;
      const k = Math.max(0, 1 - age / 1.2) * 0.22;
      nl.pool(f[j * 7], f[j * 7 + 1], f[j * 7 + 2], 0, 7, 7, f[j * 7 + 3] * k, f[j * 7 + 4] * k, f[j * 7 + 5] * k);
    }
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geo.dispose();
    this.mat.dispose();
  }
}
