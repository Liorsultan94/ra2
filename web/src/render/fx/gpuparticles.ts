import * as THREE from 'three';
import type { FogOfWar } from '../fog';

/*
 * GPU particles.
 *
 * Every particle is written ONCE, at spawn, into a ring buffer of
 * interleaved attributes (start position, velocity, birth time, life, size,
 * colour and alpha curves, drag / gravity / wind response). The vertex shader
 * integrates the motion analytically from (time - birth): exponential drag,
 * gravity / buoyancy and the global wind as a constant acceleration, so the
 * CPU never touches a live particle again. Per frame the CPU only uploads the
 * slots written that frame (one or two contiguous ranges) and sets a few
 * uniforms, however many particles are alive.
 *
 * Smoke is shaded: each sprite gets a spherical pseudo-normal, lit by the
 * sun (wrap lighting, so dense smoke has a bright and a shadowed side) plus
 * the sky ambient, warmed from below by the strongest nearby fire lights and
 * by its own young "glow" (smoke rising off a fireball). Sun / ambient follow
 * the scene lights, so dusk smoke is warm and night smoke dark and cool.
 *
 * Soft particles: the terrain height under the particle comes from a small
 * height texture, and each fragment's world height is reconstructed from the
 * sprite coordinate, so sprites fade out as they reach the ground instead of
 * being cut by a hard line.
 */

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
  /** Smoke only: warm self-glow while young (smoke boiling off a fireball), 0..1. */
  glow?: number;
}

/** Uniforms shared by both particle systems (and the god-ray density pass). */
export function particleUniforms() {
  return {
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector2() },
    heightTex: { value: null as THREE.Texture | null },
    heightSize: { value: new THREE.Vector2(1, 1) },
    heightOn: { value: 0 },
    uSunDir: { value: new THREE.Vector3(-0.7, 0.6, 0.15).normalize() },
    uSunCol: { value: new THREE.Vector3(1, 0.85, 0.7) },
    uAmbCol: { value: new THREE.Vector3(0.3, 0.34, 0.4) },
    uCamRight: { value: new THREE.Vector3(1, 0, 0) },
    uCamUp: { value: new THREE.Vector3(0, 1, 0) },
    uCamBack: { value: new THREE.Vector3(0, 0, 1) },
    /** xyz + intensity of the strongest fire / explosion lights. */
    uFireP: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) },
    uFireC: { value: [0, 1, 2, 3].map(() => new THREE.Vector3()) },
  };
}
export type ParticleUniforms = ReturnType<typeof particleUniforms>;

/**
 * True per-particle point size for both camera kinds: world size -> pixels via
 * the projection matrix and the height of the target being drawn (uViewH, set
 * per draw by bindViewHeight). Perspective divides by the particle's own view
 * depth, so sprites shrink towards the horizon exactly like geometry.
 */
export const POINT_SIZE_GLSL = /* glsl */ `
  uniform float uViewH;
  float pointPx( float worldSize, vec4 mv ) {
    float k = uViewH * 0.5 * projectionMatrix[1][1];
    return worldSize * ( projectionMatrix[3][3] < 0.5 ? k / max( 0.05, -mv.z ) : k );
  }
`;

const VH = new THREE.Vector2();
/** Keep a points material's uViewH equal to the height (px) of whatever it is being drawn into. */
export function bindViewHeight(points: THREE.Points, mat: THREE.ShaderMaterial) {
  mat.uniforms.uViewH = { value: 600 };
  points.onBeforeRender = (renderer) => {
    const rt = renderer.getRenderTarget();
    mat.uniforms.uViewH.value = rt ? rt.height : renderer.getDrawingBufferSize(VH).y;
  };
}

/** Floats per particle in the interleaved buffer. */
const STRIDE = 24;

// Shared vertex code: analytic motion + curves. Defines `pWorld`, `age`, `t`, `alive`.
const MOTION = /* glsl */ `
  attribute vec3 aVel;
  attribute vec2 aTime;   // birth, life
  attribute vec4 aSize;   // size0, size1, alpha, glow
  attribute vec4 aC0;     // colour0, rotation seed
  attribute vec4 aC1;     // colour1, spin
  attribute vec3 aPhys;   // drag, gravity, wind
  uniform float uTime;
  uniform vec2 uWind;
  uniform sampler2D fogTex;
  uniform vec2 fogSize;
  uniform float fogEnabled;
  uniform sampler2D heightTex;
  uniform vec2 heightSize;
  uniform float heightOn;
  ${POINT_SIZE_GLSL}
  float motion1( float x0, float v0, float a, float k, float t ) {
    if ( k < 1e-3 ) return x0 + v0 * t + 0.5 * a * t * t;
    float e = ( 1.0 - exp( -k * t ) ) / k;
    return x0 + v0 * e + a * ( t - e ) / k;
  }
`;

const MOTION_MAIN = /* glsl */ `
  float age = uTime - aTime.x;
  float life = aTime.y;
  bool alive = age >= 0.0 && age < life;
  float t = clamp( age / max( life, 1e-3 ), 0.0, 1.0 );
  float k = aPhys.x;
  vec3 acc = vec3( uWind.x * aPhys.z, -aPhys.y, uWind.y * aPhys.z );
  vec3 pWorld = vec3(
    motion1( position.x, aVel.x, acc.x, k, age ),
    motion1( position.y, aVel.y, acc.y, k, age ),
    motion1( position.z, aVel.z, acc.z, k, age ) );
  // grow fast, then slow down (half linear, half ease-out)
  float sz = mix( aSize.x, aSize.y, mix( t, 1.0 - ( 1.0 - t ) * ( 1.0 - t ), 0.5 ) );
  float a = aSize.z * ( t < 0.1 ? t * 10.0 : 1.0 - ( t - 0.1 ) / 0.9 );
  float fogV = texture2D( fogTex, pWorld.xz / fogSize ).r;
  a *= mix( 1.0, smoothstep( 0.55, 0.85, fogV ), fogEnabled );
  float ground = heightOn > 0.5 ? texture2D( heightTex, ( pWorld.xz + 0.5 ) / heightSize ).r : -100.0;
  vec4 mv = modelViewMatrix * vec4( pWorld, 1.0 );
  gl_PointSize = alive ? pointPx( sz, mv ) : 0.0;
  gl_Position = alive ? projectionMatrix * mv : vec4( 2.0, 2.0, 2.0, 1.0 );
`;

const VERT = /* glsl */ `
  ${MOTION}
  uniform vec3 uCamUp;
  uniform vec4 uFireP[4];
  uniform vec3 uFireC[4];
  varying vec4 vColor;
  varying float vRot;
  varying vec3 vSoft;     // height of the sprite centre above ground, world-height per sprite unit, fade range
  varying vec4 vWarm;     // fire light from below (rgb), self-glow
  void main() {
    ${MOTION_MAIN}
    vColor = vec4( mix( aC0.rgb, aC1.rgb, t ), a );
    vRot = aC0.w + age * aC1.w;
    vSoft = vec3( pWorld.y - ground, sz * uCamUp.y, clamp( sz * 0.35, 0.08, 0.45 ) );
    vec3 warm = vec3( 0.0 );
    #ifdef LIT
    for ( int i = 0; i < 4; i++ ) {
      vec3 d = pWorld - uFireP[i].xyz;
      float above = smoothstep( -0.6, 0.6, d.y + 0.3 );
      warm += uFireC[i] * ( uFireP[i].w * above / ( 1.0 + dot( d, d ) * 1.6 ) );
    }
    vWarm = vec4( min( warm * 0.12, vec3( 1.6 ) ), aSize.w * exp( -age * 2.2 ) );
    #else
    vWarm = vec4( 0.0 );
    #endif
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D tex;
  uniform vec3 uSunDir;
  uniform vec3 uSunCol;
  uniform vec3 uAmbCol;
  uniform vec3 uCamRight;
  uniform vec3 uCamUp;
  uniform vec3 uCamBack;
  varying vec4 vColor;
  varying float vRot;
  varying vec3 vSoft;
  varying vec4 vWarm;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float cs = cos( vRot );
    float sn = sin( vRot );
    vec2 uv = vec2( c.x * cs - c.y * sn, c.x * sn + c.y * cs ) + 0.5;
    vec4 tx = texture2D( tex, uv );
    // soft contact with the ground: fragment height = centre height + sprite-up offset
    float h = vSoft.x + ( -c.y ) * vSoft.y;
    float soft = smoothstep( 0.0, vSoft.z, h );
    float alpha = tx.a * vColor.a * soft;
    if ( alpha < 0.003 ) discard;
    #ifdef LIT
    // spherical pseudo-normal of the puff, bent by the texture's billows
    vec2 q = c * 2.0;
    float r2 = min( 1.0, dot( q, q ) );
    vec3 n = normalize( uCamRight * q.x - uCamUp * q.y + uCamBack * ( sqrt( 1.0 - r2 ) + 0.25 ) );
    float ndl = dot( n, uSunDir );
    float lit = 0.22 + 0.78 * smoothstep( -0.35, 0.75, ndl );
    // thin smoke lets light through: less contrast where the sprite is faint
    lit = mix( 0.7, lit, smoothstep( 0.05, 0.45, tx.a * vColor.a ) );
    float below = clamp( 0.55 - n.y * 0.6, 0.0, 1.0 );
    vec3 light = uAmbCol * ( 0.75 + 0.25 * n.y ) + uSunCol * lit + vWarm.rgb * below;
    vec3 col = vColor.rgb * tx.rgb * light + vWarm.rgb * below * 0.07;
    // young smoke still glowing from the fireball it came off (hot core, cooling rim)
    float core = smoothstep( 0.15, 0.85, tx.a );
    col += vec3( 1.0, 0.42, 0.12 ) * vWarm.a * core * 1.8;
    gl_FragColor = vec4( col, alpha );
    #else
    gl_FragColor = vec4( vColor.rgb * tx.rgb, alpha );
    #endif
  }
`;

/** Density-only pass of the smoke (god-ray occluders): same motion, writes alpha. */
const DENSITY_VERT = /* glsl */ `
  ${MOTION}
  varying float vA;
  varying float vRot;
  void main() {
    ${MOTION_MAIN}
    vA = a * smoothstep( 0.0, 0.3, pWorld.y - ground );
    vRot = aC0.w + age * aC1.w;
  }
`;
const DENSITY_FRAG = /* glsl */ `
  uniform sampler2D tex;
  varying float vA;
  varying float vRot;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float cs = cos( vRot );
    float sn = sin( vRot );
    vec4 tx = texture2D( tex, vec2( c.x * cs - c.y * sn, c.x * sn + c.y * cs ) + 0.5 );
    gl_FragColor = vec4( tx.a * vA );
  }
`;

const TMP_C = new THREE.Color();

export class GpuParticles {
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  readonly geo: THREE.BufferGeometry;
  private data: Float32Array;
  private buf: THREE.InterleavedBuffer;
  /** CPU copy of each slot's death time (slot reuse and stats only). */
  private death: Float32Array;
  private head = 0;
  private hi = 0;
  private frameStart = 0;
  private written = 0;
  private now = 0;
  private seed = 0;

  constructor(
    private max: number,
    readonly additive: boolean,
    fog: FogOfWar,
    tex: THREE.Texture,
    shared: ParticleUniforms,
  ) {
    this.data = new Float32Array(max * STRIDE);
    this.death = new Float32Array(max).fill(-1);
    // never-born slots: birth far in the future so they are culled
    for (let i = 0; i < max; i++) this.data[i * STRIDE + 6] = 1e9;
    this.buf = new THREE.InterleavedBuffer(this.data, STRIDE).setUsage(THREE.DynamicDrawUsage);
    const geo = (this.geo = new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.InterleavedBufferAttribute(this.buf, 3, 0));
    geo.setAttribute('aVel', new THREE.InterleavedBufferAttribute(this.buf, 3, 3));
    geo.setAttribute('aTime', new THREE.InterleavedBufferAttribute(this.buf, 2, 6));
    geo.setAttribute('aSize', new THREE.InterleavedBufferAttribute(this.buf, 4, 8));
    geo.setAttribute('aC0', new THREE.InterleavedBufferAttribute(this.buf, 4, 12));
    geo.setAttribute('aC1', new THREE.InterleavedBufferAttribute(this.buf, 4, 16));
    geo.setAttribute('aPhys', new THREE.InterleavedBufferAttribute(this.buf, 3, 20));
    geo.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      defines: additive ? {} : { LIT: 1 },
      uniforms: { tex: { value: tex }, ...shared, ...fog.uniforms },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    bindViewHeight(this.points, this.material);
    this.points.renderOrder = additive ? 3 : 2;
  }

  /** A points object drawing this system's particles as plain density (alpha) - for occlusion buffers. */
  densityPoints(tex: THREE.Texture, shared: ParticleUniforms, fog: FogOfWar): THREE.Points {
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      uniforms: { tex: { value: tex }, ...shared, ...fog.uniforms },
      vertexShader: DENSITY_VERT,
      fragmentShader: DENSITY_FRAG,
    });
    const p = new THREE.Points(this.geo, mat);
    p.frustumCulled = false;
    bindViewHeight(p, mat);
    return p;
  }

  spawn(o: ParticleOpts) {
    const max = this.max;
    let i = this.head;
    // reuse a dead slot near the head; if they are all alive, replace the one closest to dying
    if (this.death[i] > this.now) {
      let best = i;
      for (let k = 1; k < 8; k++) {
        const j = (this.head + k) % max;
        if (this.death[j] <= this.now) {
          best = j;
          break;
        }
        if (this.death[j] < this.death[best]) best = j;
      }
      this.written += ((best - this.head + max) % max) + 1;
      i = best;
    } else this.written++;
    this.head = (i + 1) % max;
    if (i + 1 > this.hi) this.hi = i + 1;
    const d = this.data;
    const b = i * STRIDE;
    d[b] = o.x;
    d[b + 1] = o.y;
    d[b + 2] = o.z;
    d[b + 3] = o.vx ?? 0;
    d[b + 4] = o.vy ?? 0;
    d[b + 5] = o.vz ?? 0;
    d[b + 6] = this.now;
    d[b + 7] = o.life;
    d[b + 8] = o.size;
    d[b + 9] = o.sizeEnd ?? o.size;
    d[b + 10] = o.alpha ?? 1;
    d[b + 11] = o.glow ?? 0;
    TMP_C.setHex(o.color);
    d[b + 12] = TMP_C.r;
    d[b + 13] = TMP_C.g;
    d[b + 14] = TMP_C.b;
    // cheap per-particle random rotation and spin
    const s = (this.seed = (this.seed * 1664525 + 1013904223) >>> 0);
    d[b + 15] = (s & 0xffff) * (6.283 / 65536);
    if (o.colorEnd !== undefined) TMP_C.setHex(o.colorEnd);
    d[b + 16] = TMP_C.r;
    d[b + 17] = TMP_C.g;
    d[b + 18] = TMP_C.b;
    d[b + 19] = this.additive ? 0 : ((s >>> 16) / 65536 - 0.5) * 0.7;
    d[b + 20] = o.drag ?? 0;
    d[b + 21] = o.gravity ?? 0;
    d[b + 22] = o.wind ?? 0;
    this.death[i] = this.now + o.life;
  }

  /** Set the shared effect clock (seconds): particles spawned from now on are born at this time. */
  clock(now: number) {
    this.now = now;
  }

  /** Upload the slots written since the last flush (one or two contiguous ranges). */
  flush() {
    const n = this.written;
    if (n > 0) {
      const buf = this.buf;
      if (n >= this.max) buf.addUpdateRange(0, this.max * STRIDE);
      else {
        const s = this.frameStart;
        const e = s + n;
        if (e <= this.max) buf.addUpdateRange(s * STRIDE, n * STRIDE);
        else {
          buf.addUpdateRange(s * STRIDE, (this.max - s) * STRIDE);
          buf.addUpdateRange(0, (e - this.max) * STRIDE);
        }
      }
      buf.needsUpdate = true;
      this.geo.setDrawRange(0, this.hi);
    }
    this.written = 0;
    this.frameStart = this.head;
  }

  get capacity() {
    return this.max;
  }

  /** Live particles (scans the death times: debug / stats only). */
  get active() {
    let n = 0;
    const d = this.death;
    for (let i = 0; i < this.hi; i++) if (d[i] > this.now) n++;
    return n;
  }
}
