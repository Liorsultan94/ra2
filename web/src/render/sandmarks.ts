import * as THREE from 'three';
import { standHeight, type GameMap } from '../sim/map';
import type { FogOfWar } from './fog';
import { WXS } from './wxuniforms';

/*
 * Persistent tracks in the desert sand (GD1, render only, fed from unit movement by GroundMarks):
 * tank tracks with their grouser bars and pushed-up berms, tyre tracks with a chevron tread, harvester
 * ruts (wide, deep) and infantry boot-print trails.
 *
 * One instanced draw call for all of them, a finite ring pool of quads tilted to the terrain. The shapes
 * are procedural height fields (no textures): a track's cross-section in world units across it, its tread
 * pattern in world distance along its heading (so consecutive pieces join without a seam), the boot's sole
 * and heel. The fragment shader takes the relief's normal by finite differences and outputs only a shading
 * factor, blended as a 2x multiply over the ground (dst * 2 * src: 0.5 = no change). So the marks take the
 * colour of whatever sand they are pressed into - the desert's gold, the beach's white, the town's packed
 * earth - and are lit by the sun: grooves shaded on their sun-facing walls, berms catching the light
 * (gently, capped), fresh churned sand a little darker until it dries out.
 *
 * Wind erodes them on a clock that runs ~15x faster in a sandstorm: the darker fresh sand dries within
 * seconds, the tread pattern fills in first, then the groove shallows and is gone, unevenly, in streaks
 * along the wind (minutes). Track pieces are laid every ~0.3 tiles (more often in turns) with
 * complementary linear ramps where they overlap; a coarse grid skips a piece where another vehicle laid
 * one along the same line moments ago (a column, a harvester route: no compounding). When the pool
 * cycles faster than the erosion, every mark's life shortens to the pool's span, so the oldest are already
 * gone when their slot is reused.
 */

/** Mark kinds (aInfo.z). */
const enum Kind {
  Tread = 0,
  Tyre = 1,
  Boot = 2,
}

/** Erosion clock seconds until a track is gone (calm wind); boot prints last 0.6 of it. */
const LIFE = 240;
/** Track pieces: emitted every STEP tiles of travel, or sooner when the heading turns by TURN radians. */
const STEP = 0.3;
const TURN = 0.2;
/** Overlap (tiles) of consecutive track pieces: complementary linear ramps. */
const OVL = 0.08;
/** Dedupe grid (cells per tile) and how long (clock s) a laid piece blocks another along the same line. */
const CELLS = 4;
const BLOCK = 25;

const VERT = /* glsl */ `
  attribute vec4 aInfo;
  uniform float uClock;
  varying vec4 vInfo;
  varying vec2 vUv;
  varying vec2 vSize;
  varying vec2 vW;
  varying vec3 vT;
  varying vec3 vB;
  varying vec3 vN;
  varying float vAge;
  void main() {
    vUv = uv;
    vInfo = aInfo;
    vAge = uClock - aInfo.x;
    mat3 m = mat3( modelMatrix * instanceMatrix );
    vec3 ax = m * vec3( 1.0, 0.0, 0.0 );
    vec3 az = m * vec3( 0.0, 0.0, 1.0 );
    vSize = vec2( length( ax ), length( az ) );
    vT = ax / vSize.x;
    // (across the track: +v = the quad's +z)
    vB = az / vSize.y;
    vN = normalize( m * vec3( 0.0, 1.0, 0.0 ) );
    vec4 wp = modelMatrix * instanceMatrix * vec4( position, 1.0 );
    vW = wp.xz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uSun;
  uniform float uSunK;
  uniform float uLife;
  uniform sampler2D fogTex;
  uniform vec2 fogSize;
  uniform float fogEnabled;
  uniform sampler2D fogNoise;
  varying vec4 vInfo;
  varying vec2 vUv;
  varying vec2 vSize;
  varying vec2 vW;
  varying vec3 vT;
  varying vec3 vB;
  varying vec3 vN;
  varying float vAge;
  // the prevailing wind (as the ground's ripples, ground.ts DS_WIND): erosion streaks run along it
  const vec2 WD = vec2( 0.814, 0.581 );
  float gs( float x, float w ) { return exp( -x * x / ( w * w ) ); }
  // relief height (tiles, negative = pressed in) at along a / across c (tiles from the centre line);
  // det = how much of the tread pattern is left, k = depth
  float hTrack( float a, float c, float wid, float det, float k, float tyre ) {
    // (a tyre's groove is narrower than a track's)
    float hw = wid * ( tyre > 0.5 ? 0.36 : 0.5 );
    float x = abs( c ) / hw;
    // groove: flat bottom, soft walls; berms of pushed-up sand either side
    float groove = 1.0 - smoothstep( 0.55, 0.95, x );
    float berm = gs( x - 1.05, 0.22 + 0.25 * ( 1.0 - det ) );
    float h = -groove + 0.42 * berm;
    if ( tyre > 0.5 ) {
      // tyre: a rounded groove and a chevron tread
      float ph = fract( ( a + abs( c ) * 0.9 ) / 0.045 );
      h += det * groove * 0.32 * smoothstep( 0.25, 0.45, ph ) * ( 1.0 - smoothstep( 0.55, 0.75, ph ) );
      h *= 0.75;
    } else {
      // grouser bars across the track every ~0.04 tiles, a centre guide groove
      float ph = fract( a / 0.042 );
      h += det * groove * 0.4 * ( smoothstep( 0.1, 0.22, ph ) - smoothstep( 0.42, 0.54, ph ) );
      h -= det * 0.15 * gs( x, 0.08 );
    }
    return h * k;
  }
  float hBoot( vec2 p, float det, float k ) {
    // p: along (toe at +x) / across, tiles from the print centre; sole + heel, sand kicked out at the toe
    float sole = 1.0 - smoothstep( 0.75, 1.0, length( ( p - vec2( 0.012, 0.0 ) ) / vec2( 0.03, 0.016 ) ) );
    float heel = 1.0 - smoothstep( 0.7, 1.0, length( ( p - vec2( -0.03, 0.0 ) ) / vec2( 0.014, 0.014 ) ) );
    float d = max( sole, heel );
    // tread lugs in the sole
    d *= 1.0 - det * 0.25 * step( 0.5, fract( p.x / 0.008 ) ) * sole;
    float rim = gs( length( ( p - vec2( 0.0, 0.0 ) ) / vec2( 0.052, 0.024 ) ) - 1.0, 0.25 );
    float kick = gs( length( ( p - vec2( 0.052, 0.0 ) ) / vec2( 0.016, 0.018 ) ), 0.8 );
    return ( -d + 0.35 * rim + 0.25 * kick ) * k;
  }
  void main() {
    float kind = vInfo.z;
    float life = uLife * ( kind > 1.5 ? 0.6 : 1.0 );
    float e = vAge / life;
    // erosion streaks along the wind
    vec2 q = vec2( dot( vW, WD ), dot( vW, vec2( -WD.y, WD.x ) ) );
    float sn = texture2D( fogNoise, vec2( q.x * 0.11, q.y * 0.9 ) + vInfo.w ).r;
    float es = clamp( e * ( 0.65 + 0.8 * sn ), 0.0, 1.0 );
    float keep = 1.0 - smoothstep( 0.45, 1.0, es );
    if ( keep <= 0.0 ) discard;
    float det = 1.0 - smoothstep( 0.04, 0.35, es );
    float dry = smoothstep( 0.0, 0.08, e );
    float fogV = texture2D( fogTex, vW / fogSize ).r;
    float vis = mix( 1.0, smoothstep( 0.2, 0.6, fogV ), fogEnabled );
    // local coordinates (tiles): along / across
    float a = ( vUv.x - 0.5 ) * vSize.x;
    float c = ( vUv.y - 0.5 ) * vSize.y;
    float k = vInfo.y;
    const float D = 0.004;
    float h0, ha, hc, w;
    float dark;
    float bermK = 0.0;
    if ( kind < 1.5 ) {
      // track piece: world phase along the heading so consecutive pieces line up
      float al = dot( vW, vT.xz );
      float wid = vSize.y * 0.62;
      h0 = hTrack( al, c, wid, det, k, kind );
      ha = hTrack( al + D, c, wid, det, k, kind );
      hc = hTrack( al, c + D, wid, det, k, kind );
      // complementary ramps where pieces overlap, faded off the quad's sides
      float s = vUv.x * vSize.x;
      float o = min( ${OVL.toFixed(3)}, vSize.x * 0.5 );
      w = clamp( s / o, 0.0, 1.0 ) * clamp( ( vSize.x - s ) / o, 0.0, 1.0 );
      w *= 1.0 - smoothstep( 0.4, 0.5, abs( vUv.y - 0.5 ) );
      float xg = abs( c ) / ( wid * ( kind > 0.5 ? 0.36 : 0.5 ) );
      dark = smoothstep( 0.95, 0.55, xg );
      // loose sand pushed up on the edges
      bermK = gs( xg - 1.15, 0.3 ) * k;
    } else {
      vec2 p = vec2( a, c );
      h0 = hBoot( p, det, k );
      ha = hBoot( p + vec2( D, 0.0 ), det, k );
      hc = hBoot( p + vec2( 0.0, D ), det, k );
      w = 1.0 - smoothstep( 0.42, 0.5, max( abs( vUv.x - 0.5 ), abs( vUv.y - 0.5 ) ) );
      // (boot prints stay subtler than the tracks)
      dark = clamp( -h0 / max( k, 1e-4 ), 0.0, 1.0 ) * 0.55;
    }
    // relief depth in tiles per unit of h: a tank groove ~1.3 cm of a 5.5 m tile... drawn deeper for the RTS view
    const float DEPTH = 0.018;
    vec3 n = normalize( vN - vT * ( ( ha - h0 ) / D ) * DEPTH - vB * ( ( hc - h0 ) / D ) * DEPTH );
    float lit = ( dot( n, uSun ) - dot( vN, uSun ) ) * 3.4;
    // gentle highlights, firmer shade (the wall facing away from the sun); the moon keeps only a hint of the relief
    lit = clamp( lit, -0.55, 0.25 ) * ( 0.25 + 0.75 * uSunK );
    // freshly turned sand in the groove: darker and a touch cooler until it dries; the pressed bed stays a
    // shade darker while it lasts; the loose berms a little paler
    float fresh = 1.0 - dry;
    // (and the groove's floor sits in its own shade: occlusion by its walls, as deep as the print)
    float ao = clamp( -h0 / max( k, 1e-4 ), 0.0, 1.0 ) * keep;
    vec3 shade = vec3( ( 1.0 + lit ) * ( 1.0 - 0.26 * dark * fresh - 0.14 * dark ) * ( 1.0 - 0.1 * ao ) * ( 1.0 + 0.07 * bermK * det ) );
    shade *= mix( vec3( 1.0 ), vec3( 0.95, 0.975, 1.02 ), dark * ( 0.4 + 0.6 * fresh ) );
    shade = mix( vec3( 1.0 ), max( shade, vec3( 0.42 ) ), keep * w * vis );
    if ( abs( shade.g - 1.0 ) < 0.003 ) discard;
    gl_FragColor = vec4( 0.5 * shade, 1.0 );
  }
`;

/** Per-track emission state (keyed by the caller: unit id x 2 + side). */
interface Trail {
  x: number;
  z: number;
  ang: number;
  t: number;
}

export class SandMarks {
  readonly mesh: THREE.InstancedMesh;
  private info: Float32Array;
  private infoAttr: THREE.InstancedBufferAttribute;
  private next = 0;
  private used = 0;
  private clock = 0;
  private trails = new Map<number, Trail>();
  private block: Float32Array;
  private blockAng: Uint8Array;
  private blockKey: Uint16Array;
  private gw: number;
  private gh: number;
  private seed = 1;
  private readonly uniforms: { uClock: { value: number }; uLife: { value: number }; uSun: { value: THREE.Vector3 }; uSunK: { value: number } };
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private q2 = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);
  private n = new THREE.Vector3();
  private p = new THREE.Vector3();
  private sc = new THREE.Vector3();
  /** Pieces skipped by the dedupe grid / laid (stats). */
  skipped = 0;
  laid = 0;

  constructor(
    private map: GameMap,
    fog: FogOfWar,
    private max: number,
    sun: { value: THREE.Vector3 },
    sunK: { value: number },
  ) {
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.info = new Float32Array(max * 4);
    for (let i = 0; i < max; i++) this.info[i * 4] = -1e6;
    this.infoAttr = new THREE.InstancedBufferAttribute(this.info, 4);
    this.infoAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aInfo', this.infoAttr);
    this.uniforms = { uClock: { value: 0 }, uLife: { value: LIFE }, uSun: sun, uSunK: sunK };
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      // 2x multiply: dst * src + src * dst
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.SrcColorFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      uniforms: { ...this.uniforms, fogTex: fog.uniforms.fogTex, fogSize: fog.uniforms.fogSize, fogEnabled: fog.uniforms.fogEnabled, fogNoise: fog.uniforms.fogNoise },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    // under the craters and burn marks
    this.mesh.renderOrder = 0.9;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.name = 'sandmarks';
    this.gw = map.w * CELLS;
    this.gh = map.h * CELLS;
    this.block = new Float32Array(this.gw * this.gh).fill(-1e6);
    this.blockAng = new Uint8Array(this.gw * this.gh);
    this.blockKey = new Uint16Array(this.gw * this.gh);
  }

  /**
   * A vehicle track moved to (x, z) heading `angle` (the ground marks' convention): lays a track piece
   * from the last one once it is STEP behind or the heading turned. `width` = the groove's footprint.
   */
  track(key: number, x: number, z: number, angle: number, width: number, wheeled: boolean, depth: number) {
    const tr = this.trails.get(key);
    if (!tr || this.clock - tr.t > 3 || Math.hypot(x - tr.x, z - tr.z) > 1.2) {
      this.trails.set(key, { x, z, ang: angle, t: this.clock });
      return;
    }
    const dx = x - tr.x;
    const dz = z - tr.z;
    const d = Math.hypot(dx, dz);
    let da = Math.abs(angle - tr.ang) % (Math.PI * 2);
    if (da > Math.PI) da = Math.PI * 2 - da;
    if (d < STEP && !(da > TURN && d > 0.06)) return;
    const mx = (x + tr.x) / 2;
    const mz = (z + tr.z) / 2;
    const ang = Math.atan2(dz, dx);
    tr.x = x;
    tr.z = z;
    tr.ang = angle;
    tr.t = this.clock;
    // a piece along the same line laid moments ago (column, harvester route): keep that one
    const gx = Math.floor(mx * CELLS);
    const gz = Math.floor(mz * CELLS);
    if (gx >= 0 && gz >= 0 && gx < this.gw && gz < this.gh) {
      const gi = gz * this.gw + gx;
      const ab = Math.round(((((ang % Math.PI) + Math.PI) % Math.PI) / Math.PI) * 32) % 32;
      const diff = Math.min(Math.abs(ab - this.blockAng[gi]), 32 - Math.abs(ab - this.blockAng[gi]));
      if (this.clock - this.block[gi] < BLOCK && diff <= 3 && this.blockKey[gi] !== ((key & 0xffff) || 1)) {
        this.skipped++;
        return;
      }
      this.block[gi] = this.clock;
      this.blockAng[gi] = ab;
      this.blockKey[gi] = (key & 0xffff) || 1;
    }
    this.add(mx, mz, ang, d + OVL, width, depth, wheeled ? Kind.Tyre : Kind.Tread);
  }

  /** One boot print (angle = the soldier's heading in the ground marks' convention), depth 0..1. */
  boot(x: number, z: number, angle: number, depth = 1) {
    this.add(x, z, angle, 0.13, 0.07, depth, Kind.Boot);
  }

  /** Forget a track's emission state (its unit is gone). */
  drop(key: number) {
    this.trails.delete(key);
  }

  private add(x: number, z: number, ang: number, length: number, width: number, depth: number, kind: Kind) {
    const map = this.map;
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.used = Math.min(this.max, this.used + 1);
    const cx = Math.max(0, Math.min(map.w - 0.01, x));
    const cz = Math.max(0, Math.min(map.h - 0.01, z));
    const e = 0.3;
    const hx = standHeight(map, Math.min(map.w - 0.01, cx + e), cz) - standHeight(map, Math.max(0, cx - e), cz);
    const hz = standHeight(map, cx, Math.min(map.h - 0.01, cz + e)) - standHeight(map, cx, Math.max(0, cz - e));
    this.n.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
    this.q.setFromUnitVectors(this.up, this.n);
    this.q2.setFromAxisAngle(this.up, -ang);
    this.q.multiply(this.q2);
    this.m4.compose(this.p.set(x, standHeight(map, cx, cz) + 0.012, z), this.q, this.sc.set(length, 1, width));
    this.mesh.setMatrixAt(i, this.m4);
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    this.info.set([this.clock, depth, kind, (this.seed >>> 8) / 16777216], i * 4);
    this.mesh.count = this.used;
    this.mesh.visible = true;
    this.mesh.instanceMatrix.addUpdateRange(i * 16, 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.infoAttr.addUpdateRange(i * 4, 4);
    this.infoAttr.needsUpdate = true;
    this.laid++;
  }

  update(dt: number) {
    // a sandstorm sweeps the marks away ~15x faster
    this.clock += dt * (1 + 14 * WXS.sandAmt.value);
    this.uniforms.uClock.value = this.clock;
    // the pool's span: once it cycles faster than the erosion, every mark's life shortens to it
    let life = LIFE;
    if (this.used >= this.max) {
      const oldest = this.info[this.next * 4];
      life = Math.max(12, Math.min(LIFE, (this.clock - oldest) * 0.97));
    }
    const u = this.uniforms.uLife;
    u.value += (life - u.value) * Math.min(1, dt * 2);
    if (this.trails.size > 256) for (const [k, t] of this.trails) if (this.clock - t.t > 5) this.trails.delete(k);
  }
}
