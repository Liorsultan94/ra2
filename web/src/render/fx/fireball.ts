import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { FogOfWar } from '../fog';
import type { ParticleUniforms } from './gpuparticles';
import type { FxLights } from './lights';

/*
 * Billowing 3D fireballs ("cauliflower" clusters), every quality tier.
 *
 * A blast is a cluster of overlapping, noise-displaced spheres ("puffs"): a
 * white-hot core, rolling outer billows thrown out and up, and on big blasts
 * a rising mushroom cap and a smoke stem. Each puff boils (animated value
 * noise displaces the surface and scrolls upwards, so the lumps roll over
 * the top) and runs down a temperature ramp - white core -> yellow -> peach /
 * orange -> deep red -> sooty smoke - cooling from the crevices and the rim
 * inwards. Hot gas is emissive (HDR, it blooms); cooled puffs turn into dark
 * smoke lit by the sun, the sky and by the fire still burning inside them,
 * then drift off with the wind. While a cluster is hot it also keeps a light
 * source alive (fx/lights.ts), so the fireball lights the ground and the
 * units around it for as long as it glows, not just for the first flash.
 *
 * Cost: ONE instanced draw call for every puff of every blast on screen.
 * The CPU integrates a few dozen puffs per frame and sorts them back to front.
 * Geometry detail and pool size follow the quality tier.
 */

export type FireballPalette = 'normal' | 'thermo' | 'white';
export type FxQuality = 'low' | 'medium' | 'high';

/** How big / hot / long a fireball cluster is (pure numbers: unit-testable). */
export interface BillowPlan {
  /** Puffs in the cluster (core + billows + cap + stem). */
  puffs: number;
  /** Mushroom cap puffs (subset of puffs). */
  cap: number;
  /** Smoke stem puffs (subset of puffs). */
  stem: number;
  /** Core radius (tiles). */
  r: number;
  /** Seconds until the gas has cooled to smoke. */
  hot: number;
  /** Seconds the smoke lingers after that. */
  smoke: number;
  /** Peak light power of the burning cluster. */
  light: number;
}

const QK: Record<FxQuality, number> = { low: 0.45, medium: 0.7, high: 1 };

/**
 * The cluster for a blast of size S (tiles) and fire amount `fire` (BlastProfile.fire).
 * Bigger weapons get more, larger, hotter and longer-lived puffs and (S >= 1.6) a mushroom cap.
 */
export function billowPlan(S: number, fire: number, q: FxQuality, airborne = false, pal: FireballPalette = 'normal'): BillowPlan {
  const f = Math.sqrt(Math.max(0.2, fire));
  const k = QK[q];
  const thermo = pal === 'thermo';
  const big = !airborne && S >= 1.6;
  const cap = big ? Math.max(2, Math.round((S >= 2.4 ? 5 : 3) * Math.min(1, k + 0.2))) : 0;
  const stem = big && q !== 'low' ? (S >= 2.4 ? 3 : 2) : 0;
  const billows = Math.max(2, Math.min(16, Math.round((2 + 2.6 * S * f) * k)));
  return {
    puffs: 1 + billows + cap + stem,
    cap,
    stem,
    r: 0.3 * S * Math.min(1.2, f) * (thermo ? 1.15 : 1),
    hot: (0.55 + 0.42 * S) * (thermo ? 1.6 : 1) * (airborne ? 0.8 : 1),
    smoke: (2.2 + 2.2 * S) * (airborne ? 1.3 : 1),
    light: 2.5 + 3.2 * S * f,
  };
}

const NOISE = /* glsl */ `
  float fbHash( vec3 p ) {
    p = fract( p * 0.3183099 + 0.1 );
    p *= 17.0;
    return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
  }
  float fbNoise( vec3 x ) {
    vec3 i = floor( x );
    vec3 f = fract( x );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( mix( fbHash( i ), fbHash( i + vec3( 1, 0, 0 ) ), f.x ), mix( fbHash( i + vec3( 0, 1, 0 ) ), fbHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
                mix( mix( fbHash( i + vec3( 0, 0, 1 ) ), fbHash( i + vec3( 1, 0, 1 ) ), f.x ), mix( fbHash( i + vec3( 0, 1, 1 ) ), fbHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
  }
  // billowy fbm: rounded lumps with sharp creases between them (cauliflower)
  // (two octaves: the vertex grid can carry them; finer detail is shaded per pixel)
  float billow( vec3 q ) {
    float a = 1.0 - abs( fbNoise( q ) * 2.0 - 1.0 );
    float b = 1.0 - abs( fbNoise( q * 2.13 + 7.1 ) * 2.0 - 1.0 );
    return a * 0.68 + b * 0.32;
  }
`;

const VERT = /* glsl */ `
  ${NOISE}
  attribute vec4 iA; // centre xyz, radius
  attribute vec4 iB; // temperature, seed, alpha, vertical squash
  attribute vec4 iC; // age, smoke albedo, heat shift, ground flatten
  uniform sampler2D fogTex;
  uniform vec2 fogSize;
  uniform float fogEnabled;
  varying vec3 vN;
  varying vec3 vObj;
  varying vec3 vWorld;
  varying vec4 vB;
  varying vec4 vC;
  varying float vLump;
  varying vec3 vSph;
  void main() {
    vec3 p = position;
    float age = iC.x;
    // the noise field scrolls down through the puff: lumps roll up and over the top
    vec3 off = vec3( iB.y, iB.y * 0.71 - age * 0.55, iB.y * 1.37 );
    float fr = 1.85;
    float n = billow( p * fr + off );
    // finite-difference gradient for a lumpy normal
    float e = 0.12;
    float nx = billow( ( p + vec3( e, 0.0, 0.0 ) ) * fr + off );
    float ny = billow( ( p + vec3( 0.0, e, 0.0 ) ) * fr + off );
    float nz = billow( ( p + vec3( 0.0, 0.0, e ) ) * fr + off );
    vec3 g = ( vec3( nx, ny, nz ) - n ) / e;
    float amp = 0.5;
    vLump = n;
    vec3 dp = p * ( 1.0 + ( n - 0.55 ) * amp );
    // flattened underside on the ground, squashed / stretched puffs (cap, stem)
    if ( dp.y < 0.0 ) dp.y *= 1.0 - 0.45 * iC.w;
    dp.y *= iB.w;
    // lumpy normal (tilt limited: a soft, rounded cauliflower rather than a crumpled one)
    vec3 gt = g - dot( g, p ) * p;
    float gl = length( gt );
    gt *= min( 1.0, 1.2 / max( gl, 1e-4 ) );
    vec3 nrm = normalize( p - amp * 0.75 * gt );
    nrm.y /= max( 0.3, iB.w );
    vN = normalize( nrm );
    vec3 sph = p;
    sph.y /= max( 0.3, iB.w );
    vSph = normalize( sph );
    vObj = p;
    vec3 wp = iA.xyz + dp * iA.w;
    vWorld = wp;
    float fogV = texture2D( fogTex, iA.xz / fogSize ).r;
    vB = vec4( iB.x, iB.y, iB.z * mix( 1.0, smoothstep( 0.55, 0.85, fogV ), fogEnabled ), iB.w );
    vC = iC;
    gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
  }
`;

const FRAG = /* glsl */ `
  ${NOISE}
  uniform vec3 uSunDir;
  uniform vec3 uSunCol;
  uniform vec3 uAmbCol;
  uniform vec4 uFireP[4];
  uniform vec3 uFireC[4];
  uniform sampler2D heightTex;
  uniform vec2 heightSize;
  uniform float heightOn;
  varying vec3 vN;
  varying vec3 vObj;
  varying vec3 vWorld;
  varying vec4 vB;
  varying vec4 vC;
  varying float vLump;
  varying vec3 vSph;
  // white-hot -> yellow -> peach -> orange -> deep red (linear HDR, blooms)
  vec3 ramp( float t ) {
    vec3 c = vec3( 0.3, 0.03, 0.005 ) * smoothstep( 0.08, 0.3, t );
    c = mix( c, vec3( 1.0, 0.26, 0.04 ) * 1.5, smoothstep( 0.25, 0.5, t ) );
    c = mix( c, vec3( 1.0, 0.46, 0.26 ) * 2.1, smoothstep( 0.45, 0.72, t ) );
    c = mix( c, vec3( 1.0, 0.72, 0.36 ) * 2.9, smoothstep( 0.7, 0.95, t ) );
    c = mix( c, vec3( 1.0, 0.93, 0.8 ) * 4.5, smoothstep( 0.98, 1.35, t ) );
    return c;
  }
  void main() {
    vec3 V = normalize( cameraPosition - vWorld );
    vec3 N = normalize( vN );
    // fine per-pixel lumps on top of the vertex billows
    float fine = fbNoise( vObj * 5.3 + vec3( vB.y, -vC.x * 1.4, vB.y ) );
    float fine2 = fbNoise( vObj * 11.0 + vec3( vB.y * 1.3, -vC.x * 2.0, 0.0 ) );
    N = normalize( N + ( vObj * ( fine - 0.5 ) + vec3( fine2 - 0.5, 0.0, 0.5 - fine2 ) ) * 0.35 );
    // silhouette / optical depth from the smooth puff shape, lighting from the lumpy one
    float facing = clamp( dot( normalize( vSph ), V ), 0.0, 1.0 );
    float temp0 = vB.x;
    // optically thick: we see hot gas through the middle of the disc, cooler gas at the rim and in the creases
    float depth = 0.3 + 0.85 * facing * sqrt( facing );
    float crease = smoothstep( 0.25, 0.75, vLump );
    float t = temp0 * depth * ( 0.55 + 0.45 * crease ) * ( 0.8 + 0.4 * fine ) * ( 1.0 + vC.z );
    vec3 emit = ramp( t );
    float hotMask = smoothstep( 0.18, 0.45, t );
    // smoke: dark sooty albedo lit by sun (wrapped), sky and the fire still glowing inside / below
    float wrap = clamp( dot( N, uSunDir ) * 0.5 + 0.5, 0.0, 1.0 );
    float ambL = dot( uAmbCol, vec3( 0.3, 0.59, 0.11 ) );
    vec3 light = uSunCol * wrap * wrap * 1.25 + mix( vec3( ambL ), uAmbCol, 0.35 ) * ( 0.6 + 0.35 * N.y );
    vec3 warm = vec3( 0.0 );
    for ( int i = 0; i < 4; i++ ) {
      vec3 d = vWorld - uFireP[i].xyz;
      float k = uFireP[i].w / ( 1.0 + dot( d, d ) * 1.4 );
      warm += uFireC[i] * k * clamp( 0.35 - dot( N, normalize( d + vec3( 0.0, 1e-3, 0.0 ) ) ) * 0.65, 0.0, 1.0 );
    }
    light += min( warm * 0.18, vec3( 2.0 ) );
    // inner glow bleeding through thin smoke (peach-lit billows)
    vec3 inner = ramp( temp0 * 0.62 ) * 0.22 * ( 1.0 - facing * 0.5 );
    vec3 albedo = vec3( vC.y ) * mix( 0.7, 1.2, fine ) * vec3( 1.0, 0.9, 0.8 );
    vec3 col = mix( albedo * light + inner, emit, hotMask );
    float a = smoothstep( 0.0, 0.32, facing ) * vB.z;
    // cool smoke thins out unevenly
    float cold = smoothstep( 0.3, 0.0, temp0 );
    a *= mix( 1.0, smoothstep( 0.15, 0.75, fine + facing * 0.35 ), cold * 0.85 );
    if ( heightOn > 0.5 ) {
      float gh = texture2D( heightTex, ( vWorld.xz + 0.5 ) / heightSize ).r;
      a *= smoothstep( -0.05, 0.25, vWorld.y - gh );
    }
    if ( a < 0.004 ) discard;
    gl_FragColor = vec4( col * a, a );
  }
`;

interface Puff {
  cl: Cluster;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** final radius, birth radius fraction */
  r: number;
  r0: number;
  age: number;
  delay: number;
  /** temperature at birth (1 = white-hot) and cooling time */
  hot: number;
  cool: number;
  life: number;
  seed: number;
  squash: number;
  /** flatten the underside (sits on the ground) */
  flat: number;
  rise: number;
  drag: number;
  wind: number;
  /** horizontal spread of a cap puff (tiles / s, decays) */
  albedo: number;
  heat: number;
  depth: number;
}

interface Cluster {
  x: number;
  y: number;
  z: number;
  age: number;
  hot: number;
  light: number;
  color: number;
  puffs: number;
}

const STRIDE = 12;

export class Fireballs {
  readonly mesh: THREE.Mesh;
  private puffs: Puff[] = [];
  private clusters: Cluster[] = [];
  private data: Float32Array;
  private attr: THREE.InstancedInterleavedBuffer;
  private geo: THREE.InstancedBufferGeometry;
  private v = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  /** Global wind (tiles / s), shared with the particles. */
  wind = { x: 0, z: 0 };
  lights: FxLights | null = null;

  constructor(
    group: THREE.Group,
    fog: FogOfWar,
    private max: number,
    pu?: ParticleUniforms,
    readonly quality: FxQuality = 'high',
  ) {
    const detail = quality === 'high' ? 3 : quality === 'medium' ? 2 : 1;
    const ico = new THREE.IcosahedronGeometry(1, detail);
    ico.deleteAttribute('normal');
    ico.deleteAttribute('uv');
    // indexed: every vertex (and its noise) is shaded once instead of once per triangle
    const src = mergeVertices(ico);
    const geo = (this.geo = new THREE.InstancedBufferGeometry());
    geo.setAttribute('position', src.getAttribute('position'));
    if (src.index) geo.index = src.index;
    this.data = new Float32Array(max * STRIDE);
    this.attr = new THREE.InstancedInterleavedBuffer(this.data, STRIDE).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iA', new THREE.InterleavedBufferAttribute(this.attr, 4, 0));
    geo.setAttribute('iB', new THREE.InterleavedBufferAttribute(this.attr, 4, 4));
    geo.setAttribute('iC', new THREE.InterleavedBufferAttribute(this.attr, 4, 8));
    geo.instanceCount = 0;
    const p = pu;
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      uniforms: {
        uSunDir: p?.uSunDir ?? { value: new THREE.Vector3(-0.6, 0.7, 0.2).normalize() },
        uSunCol: p?.uSunCol ?? { value: new THREE.Vector3(1, 0.9, 0.8) },
        uAmbCol: p?.uAmbCol ?? { value: new THREE.Vector3(0.3, 0.33, 0.38) },
        uFireP: p?.uFireP ?? { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) },
        uFireC: p?.uFireC ?? { value: [0, 1, 2, 3].map(() => new THREE.Vector3()) },
        heightTex: p?.heightTex ?? { value: null },
        heightSize: p?.heightSize ?? { value: new THREE.Vector2(1, 1) },
        heightOn: p?.heightOn ?? { value: 0 },
        ...fog.uniforms,
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    // after the lit smoke and the flipbooks, before the additive fire (the flash glares over the young fireball)
    this.mesh.renderOrder = 3.2;
    this.mesh.name = 'fireballs';
    group.add(this.mesh);
  }

  get active() {
    return this.puffs.length;
  }

  private r(a: number, b: number) {
    return a + Math.random() * (b - a);
  }

  private add(cl: Cluster, o: Partial<Puff> & { x: number; y: number; z: number; r: number }) {
    let p: Puff;
    if (this.puffs.length >= this.max) {
      // full: recycle the puff furthest through its life
      let bi = 0;
      let bk = -1;
      for (let i = 0; i < this.puffs.length; i++) {
        const q = this.puffs[i];
        const k = q.age / q.life;
        if (k > bk) {
          bk = k;
          bi = i;
        }
      }
      p = this.puffs[bi];
      p.cl.puffs--;
    } else {
      p = {} as Puff;
      this.puffs.push(p);
    }
    cl.puffs++;
    Object.assign(p, {
      cl,
      vx: 0,
      vy: 0,
      vz: 0,
      r0: 0.25,
      age: 0,
      delay: 0,
      hot: 1,
      cool: 1,
      life: 6,
      seed: Math.random() * 60,
      squash: 1,
      flat: 0,
      rise: 0.4,
      drag: 2.2,
      wind: 0.6,
      albedo: 0.09,
      heat: 0,
      depth: 0,
      ...o,
    } satisfies Puff);
    p.age = -p.delay;
  }

  /**
   * A whole billowing fireball for a blast of size S at (x, y, z) (y = ground for ground bursts).
   * `heat` > 0 burns whiter (big warheads), < 0 deeper orange.
   */
  blast(x: number, y: number, z: number, S: number, fire: number, pal: FireballPalette, airborne: boolean, heat = 0, plan = billowPlan(S, fire, this.quality, airborne, pal)) {
    const cl: Cluster = { x, y, z, age: 0, hot: plan.hot, light: plan.light, color: pal === 'thermo' ? 0xff8a30 : 0xffa048, puffs: 0 };
    this.clusters.push(cl);
    const R = plan.r;
    const thermo = pal === 'thermo';
    const albedo = thermo ? 0.09 : airborne ? 0.16 : 0.13;
    const life = plan.hot + plan.smoke;
    const baseY = airborne ? y : y + R * 0.55;
    const h0 = 0.98 + (pal === 'white' ? 0.12 : 0) + heat;
    // white-hot core
    this.add(cl, { x, y: baseY, z, r: R * 0.95, r0: 0.3, hot: h0 + 0.1, cool: plan.hot * 0.9, life, vy: 0.5 * R, rise: 0.9 * Math.sqrt(S), drag: 1.2, flat: airborne ? 0 : 1, albedo, heat, wind: 0.5 });
    // rolling outer billows: thrown out and up, slightly later, a little cooler
    const nb = plan.puffs - 1 - plan.cap - plan.stem;
    for (let i = 0; i < nb; i++) {
      const a = (i / nb) * Math.PI * 2 + this.r(-0.4, 0.4);
      const el = airborne ? this.r(-1.2, 1.2) : this.r(0.05, 1.1);
      const sp = this.r(1.6, 3.2) * R;
      const rr = R * this.r(0.55, 0.85);
      this.add(cl, {
        x: x + Math.cos(a) * Math.cos(el) * R * 0.25,
        y: baseY + Math.sin(el) * R * 0.25,
        z: z + Math.sin(a) * Math.cos(el) * R * 0.25,
        vx: Math.cos(a) * Math.cos(el) * sp,
        vy: Math.sin(el) * sp * 0.8 + 0.3 * R,
        vz: Math.sin(a) * Math.cos(el) * sp,
        r: rr,
        r0: 0.2,
        delay: this.r(0, 0.09) + (i % 3) * 0.02,
        hot: h0 * this.r(0.75, 0.95),
        cool: plan.hot * this.r(0.6, 0.85),
        life: life * this.r(0.8, 1),
        rise: this.r(0.6, 1) * Math.sqrt(S),
        drag: 3,
        flat: airborne ? 0 : 0.5,
        albedo,
        heat,
        wind: 0.6,
      });
    }
    // mushroom cap: puffs that ride the hot core up and spread into a dark, flattened crown
    for (let i = 0; i < plan.cap; i++) {
      const a = (i / plan.cap) * Math.PI * 2 + this.r(-0.3, 0.3);
      this.add(cl, {
        x: x + Math.cos(a) * R * 0.2,
        y: baseY + R * 0.5,
        z: z + Math.sin(a) * R * 0.2,
        vx: Math.cos(a) * R * 0.9,
        vy: R * this.r(2.6, 3.2),
        vz: Math.sin(a) * R * 0.9,
        r: R * this.r(0.75, 0.95),
        r0: 0.25,
        delay: this.r(0.12, 0.25),
        hot: h0 * 0.7,
        cool: plan.hot * 0.75,
        life: life * this.r(1, 1.15),
        rise: 0.15,
        drag: 0.9,
        squash: 0.72,
        albedo: albedo * 0.8,
        heat,
        wind: 0.9,
      });
    }
    // stem: narrow, cooler puffs feeding the cap
    for (let i = 0; i < plan.stem; i++) {
      this.add(cl, {
        x: x + this.r(-0.1, 0.1) * R,
        y: y + R * (0.4 + 0.5 * i),
        z: z + this.r(-0.1, 0.1) * R,
        vy: R * (1 + 0.5 * i),
        r: R * 0.5,
        r0: 0.3,
        delay: 0.3 + i * 0.12,
        hot: 0.5,
        cool: plan.hot * 0.5,
        life: life * 0.9,
        rise: 0.2,
        drag: 1,
        squash: 1.5,
        albedo: albedo * 1.2,
        heat,
        wind: 0.8,
      });
    }
  }

  /** Back-compat: one round fireball of size S (secondary fuel fires). */
  spawn(x: number, y: number, z: number, S: number, pal: FireballPalette, airborne: boolean) {
    this.blast(x, y, z, S, 1, pal, airborne);
  }

  clear() {
    this.puffs.length = 0;
    this.clusters.length = 0;
    this.geo.instanceCount = 0;
  }

  update(dt: number, camera: THREE.Camera | null) {
    const list = this.puffs;
    const w = this.wind;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.age += dt;
      if (p.age >= p.life) {
        p.cl.puffs--;
        list[i] = list[list.length - 1];
        list.pop();
        continue;
      }
      if (p.age < 0) continue;
      const k = Math.exp(-p.drag * dt);
      // buoyancy grows as the core lifts off, fades once the smoke has cooled
      const buoy = p.rise * (p.age < p.cool * 2 ? 1 : 0.4);
      const wk = p.wind * Math.min(1, p.age / Math.max(0.2, p.cool));
      p.vx = p.vx * k + w.x * wk * dt * 1.4;
      p.vz = p.vz * k + w.z * wk * dt * 1.4;
      p.vy = p.vy * k + buoy * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
    }
    // clusters: light while they burn
    for (let i = this.clusters.length - 1; i >= 0; i--) {
      const c = this.clusters[i];
      c.age += dt;
      if (c.puffs <= 0 || c.age > c.hot * 2.5) {
        this.clusters.splice(i, 1);
        continue;
      }
      const g = Math.max(0, 1 - c.age / (c.hot * 1.6));
      if (g > 0.03) this.lights?.sustain(c.x, c.y + 0.6 + c.age * 0.4, c.z, c.light * g * g, c.color, 0.25);
    }
    if (!list.length || !camera) {
      this.geo.instanceCount = 0;
      return;
    }
    const cp = this.v.setFromMatrixPosition(camera.matrixWorld);
    const f = camera.getWorldDirection(this.fwd);
    for (const p of list) p.depth = (p.x - cp.x) * f.x + (p.y - cp.y) * f.y + (p.z - cp.z) * f.z + p.r * 0.5;
    list.sort((a, b) => b.depth - a.depth);
    const d = this.data;
    let n = 0;
    for (const p of list) {
      if (p.age < 0) continue;
      const t = p.age / p.life;
      // violent expansion (ease-out), then a slow swell as it cools
      const e = Math.min(1, p.age / Math.max(0.05, p.cool * 0.3));
      const grow = p.r0 + (1 - p.r0) * (1 - (1 - e) * (1 - e) * (1 - e));
      const swell = 1 + 0.6 * Math.min(1, p.age / (p.life * 0.6));
      const ck = p.age / p.cool;
      const temp = ck < 1 ? p.hot * (1 - ck * ck * (3 - 2 * ck) * 0.85) * Math.exp(-ck * 0.6) : Math.max(0, 0.0823 * p.hot * (2 - ck));
      // the smoke thins out as it spreads
      const alpha = Math.min(1, p.age / 0.04) * (1 - smooth(0.55, 1, t)) * (1 - 0.4 * smooth(0.2, 0.8, t));
      const o = n * STRIDE;
      d[o] = p.x;
      d[o + 1] = p.y;
      d[o + 2] = p.z;
      d[o + 3] = p.r * grow * swell;
      d[o + 4] = Math.max(0, temp);
      d[o + 5] = p.seed;
      d[o + 6] = alpha;
      d[o + 7] = p.squash;
      d[o + 8] = p.age;
      d[o + 9] = p.albedo * (1 + 1.1 * smooth(0.25, 1, t));
      d[o + 10] = p.heat;
      d[o + 11] = p.flat;
      n++;
    }
    this.geo.instanceCount = n;
    if (n) {
      this.attr.clearUpdateRanges();
      this.attr.addUpdateRange(0, n * STRIDE);
      this.attr.needsUpdate = true;
    }
  }
}

function smooth(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
