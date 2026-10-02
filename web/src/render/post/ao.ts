import * as THREE from 'three';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { Blitter, PACK_GLSL, VIEWPOS_GLSL, colorTarget, fsMaterial } from './util';

/*
 * Ground-truth ambient occlusion (GTAO, after Jimenez et al. / Intel's
 * XeGTAO), lean and depth-only, at half resolution:
 *
 *  1. half-res AO: view position and normal rebuilt from the scene depth
 *     buffer (no normal pass, no second scene render), 2 (3 on ultra) slice
 *     directions x 2 sides x 4 steps, cosine-weighted horizon integral with
 *     a distance falloff; directions rotate on a 4x4 Bayer pattern, steps
 *     jitter on interleaved gradient noise;
 *  2. half-res 4x4 depth-aware denoise (exactly one period of the rotation
 *     pattern, so it resolves the noise without smearing across edges);
 *  3. the FinalPass upsamples it with a bilateral (depth-weighted bilinear)
 *     filter and multiplies it onto the HDR colour, sparing emissive light.
 *
 * Output: RGBA8, r = AO, g/b = 16-bit linear depth (0..far) for the
 * bilateral steps. Contact darkening where units, buildings and trees meet
 * the ground and in building crevices; the ContactShadows footprints are
 * weakened while AO runs so the two don't double up (renderer applyLevel).
 */

/** Pass that only remembers the scene depth texture of this frame (kept right after the scene render). */
export class DepthTap extends Pass {
  texture: THREE.DepthTexture | null = null;
  constructor() {
    super();
    this.needsSwap = false;
  }
  render(_r: THREE.WebGLRenderer, _w: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    this.texture = readBuffer.depthTexture;
  }
}

const AO_FRAG = /* glsl */ `
${VIEWPOS_GLSL}
${PACK_GLSL}
uniform vec2 fullTexel;
uniform ivec2 fullSize;
uniform float radius;
uniform float projScale;
uniform float ortho;
uniform float far;
uniform float power;
uniform float maxPx;
varying vec2 vUv;
const float PI = 3.14159265;
const float HALF_PI = 1.5707963;
float fastAcos( float x ) {
  float ax = abs( x );
  float r = ( -0.156583 * ax + HALF_PI ) * sqrt( 1.0 - ax );
  return x >= 0.0 ? r : PI - r;
}
void main() {
  ivec2 hp = ivec2( gl_FragCoord.xy );
  ivec2 fp = min( hp * 2, fullSize - 1 );
  vec2 uv = ( vec2( fp ) + 0.5 ) * fullTexel;
  float d = texelFetch( tDepth, fp, 0 ).x;
  if ( d >= 0.99999 ) { gl_FragColor = vec4( 1.0, packDepth16( 1.0 ), 1.0 ); return; }
  vec3 P = viewPosAt( uv, d );
  // normal from depth: per axis, the neighbour on the same surface
  vec3 pr = viewPos( uv + vec2( fullTexel.x, 0.0 ) );
  vec3 pl = viewPos( uv - vec2( fullTexel.x, 0.0 ) );
  vec3 pu = viewPos( uv + vec2( 0.0, fullTexel.y ) );
  vec3 pd = viewPos( uv - vec2( 0.0, fullTexel.y ) );
  vec3 dx = abs( pr.z - P.z ) < abs( P.z - pl.z ) ? pr - P : P - pl;
  vec3 dy = abs( pu.z - P.z ) < abs( P.z - pd.z ) ? pu - P : P - pd;
  vec3 N = normalize( cross( dx, dy ) );
  vec3 V = ortho > 0.5 ? vec3( 0.0, 0.0, 1.0 ) : normalize( -P );
  if ( dot( N, V ) < 0.0 ) N = -N;
  float zLin = -P.z;
  float rpx = ortho > 0.5 ? radius * projScale : radius * projScale / max( zLin, 1e-3 );
  vec2 dp = packDepth16( zLin / far );
  if ( rpx < 1.5 ) { gl_FragColor = vec4( 1.0, dp, 1.0 ); return; }
  rpx = min( rpx, maxPx );
  // 4x4 Bayer rotation + interleaved gradient noise step jitter
  int bi = ( hp.y & 3 ) * 4 + ( hp.x & 3 );
  const float B[ 16 ] = float[]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );
  float n1 = ( B[ bi ] + 0.5 ) / 16.0;
  float n2 = fract( 52.9829189 * fract( dot( vec2( hp ), vec2( 0.06711056, 0.00583715 ) ) ) );
  float falloffRange = 0.62 * radius;
  float falloffMul = -1.0 / falloffRange;
  float falloffAdd = ( radius - falloffRange ) / falloffRange + 1.0;
  float vis = 0.0;
  for ( int i = 0; i < DIRS; i++ ) {
    float phi = ( float( i ) + n1 ) * PI / float( DIRS );
    vec2 omega = vec2( cos( phi ), sin( phi ) );
    vec3 dirV = vec3( omega, 0.0 );
    vec3 orthoDir = dirV - dot( dirV, V ) * V;
    vec3 axis = normalize( cross( orthoDir, V ) );
    vec3 projN = N - axis * dot( N, axis );
    float projLen = length( projN );
    float sgn = sign( dot( orthoDir, projN ) );
    float cosN = clamp( dot( projN, V ) / max( projLen, 1e-4 ), 0.0, 1.0 );
    float n = sgn * fastAcos( cosN );
    float low0 = cos( n + HALF_PI );
    float low1 = cos( n - HALF_PI );
    float h0c = low0;
    float h1c = low1;
    for ( int s = 0; s < STEPS; s++ ) {
      float t = ( float( s ) + n2 ) / float( STEPS );
      float o = max( t * t * rpx, float( s ) + 1.0 );
      vec2 off = omega * o * fullTexel;
      vec3 d0 = viewPos( uv + off ) - P;
      vec3 d1 = viewPos( uv - off ) - P;
      float l0 = length( d0 );
      float l1 = length( d1 );
      // thin-occluder compensation (XeGTAO): what sticks out towards the camera (grass blades seen from
      // above) counts as further away, so it fades out instead of speckling the ground
      float f0 = length( vec3( d0.xy, d0.z * ( 1.0 + THIN ) ) );
      float f1 = length( vec3( d1.xy, d1.z * ( 1.0 + THIN ) ) );
      float c0 = mix( low0, dot( d0, V ) / max( l0, 1e-4 ), clamp( f0 * falloffMul + falloffAdd, 0.0, 1.0 ) );
      float c1 = mix( low1, dot( d1, V ) / max( l1, 1e-4 ), clamp( f1 * falloffMul + falloffAdd, 0.0, 1.0 ) );
      h0c = max( h0c, c0 );
      h1c = max( h1c, c1 );
    }
    projLen = mix( projLen, 1.0, 0.05 );
    float h0 = -fastAcos( h1c );
    float h1 = fastAcos( h0c );
    h0 = n + clamp( h0 - n, -HALF_PI, HALF_PI );
    h1 = n + clamp( h1 - n, -HALF_PI, HALF_PI );
    float sn = sin( n );
    float a0 = ( cosN + 2.0 * h0 * sn - cos( 2.0 * h0 - n ) ) * 0.25;
    float a1 = ( cosN + 2.0 * h1 * sn - cos( 2.0 * h1 - n ) ) * 0.25;
    vis += projLen * ( a0 + a1 );
  }
  vis = clamp( vis / float( DIRS ), 0.0, 1.0 );
  // fade out far away (wide zoom-outs: sub-pixel detail only adds noise)
  float ao = mix( pow( vis, power ), 1.0, smoothstep( far * 0.45, far * 0.7, zLin ) );
  gl_FragColor = vec4( ao, dp, 1.0 );
}`;

const DENOISE_FRAG = /* glsl */ `
${PACK_GLSL}
uniform sampler2D tAO;
uniform ivec2 size;
varying vec2 vUv;
void main() {
  ivec2 p = ivec2( gl_FragCoord.xy );
  vec4 c = texelFetch( tAO, p, 0 );
  float z = unpackDepth16( c.gb );
  float tol = z * 0.05 + 2e-4;
  float sum = 0.0;
  float ws = 0.0;
  for ( int y = -2; y <= 1; y++ )
    for ( int x = -2; x <= 1; x++ ) {
      vec4 s = texelFetch( tAO, clamp( p + ivec2( x, y ), ivec2( 0 ), size - 1 ), 0 );
      float dz = ( unpackDepth16( s.gb ) - z ) / tol;
      float w = 1.0 / ( 1.0 + dz * dz );
      sum += s.r * w;
      ws += w;
    }
  gl_FragColor = vec4( sum / ws, c.gb, 1.0 );
}`;

/** GLSL for the final pass: bilateral upsample of the half-res AO (needs VIEWPOS_GLSL + PACK_GLSL). */
export const AO_UPSAMPLE_GLSL = /* glsl */ `
uniform sampler2D tAO;
uniform ivec2 aoSize;
uniform float aoFar;
float aoAt( vec2 fc, vec2 uv ) {
  float z = -viewPosAt( uv, texelFetch( tDepth, ivec2( fc ), 0 ).x ).z / aoFar;
  vec2 h = ( fc - 0.5 ) * 0.5;
  vec2 f = fract( h );
  ivec2 b = ivec2( floor( h ) );
  ivec2 mx = aoSize - 1;
  vec4 s00 = texelFetch( tAO, clamp( b, ivec2( 0 ), mx ), 0 );
  vec4 s10 = texelFetch( tAO, clamp( b + ivec2( 1, 0 ), ivec2( 0 ), mx ), 0 );
  vec4 s01 = texelFetch( tAO, clamp( b + ivec2( 0, 1 ), ivec2( 0 ), mx ), 0 );
  vec4 s11 = texelFetch( tAO, clamp( b + ivec2( 1, 1 ), ivec2( 0 ), mx ), 0 );
  float tol = z * 0.03 + 2e-4;
  vec4 dz = ( vec4( unpackDepth16( s00.gb ), unpackDepth16( s10.gb ), unpackDepth16( s01.gb ), unpackDepth16( s11.gb ) ) - z ) / tol;
  vec4 w = vec4( ( 1.0 - f.x ) * ( 1.0 - f.y ), f.x * ( 1.0 - f.y ), ( 1.0 - f.x ) * f.y, f.x * f.y ) / ( 1.0 + dz * dz ) + 1e-5;
  return dot( vec4( s00.r, s10.r, s01.r, s11.r ), w ) / ( w.x + w.y + w.z + w.w );
}
`;

export class AOPass extends Pass {
  /** World-space radius (map tiles). */
  radius = 1.0;
  /** Output strength 0..1 (applied by the final pass). */
  intensity = 0.9;
  power = 1.6;
  private raw: THREE.WebGLRenderTarget;
  private clean: THREE.WebGLRenderTarget;
  private aoMat: THREE.ShaderMaterial;
  private denoiseMat: THREE.ShaderMaterial;
  private blit = new Blitter();
  private fullW = 1;
  private fullH = 1;
  /** Denoised half-res AO (r) + packed depth (gb); null while off. */
  texture: THREE.Texture | null = null;
  /** Far plane used for the packed depth. */
  far = 400;

  constructor(
    private camera: THREE.Camera,
    private depth: DepthTap,
    dirs = 2,
  ) {
    super();
    this.needsSwap = false;
    this.raw = colorTarget(1, 1, THREE.UnsignedByteType, THREE.NearestFilter);
    this.clean = colorTarget(1, 1, THREE.UnsignedByteType, THREE.NearestFilter);
    this.aoMat = fsMaterial(
      AO_FRAG,
      {
        tDepth: { value: null },
        projInv: { value: new THREE.Matrix4() },
        fullTexel: { value: new THREE.Vector2() },
        fullSize: { value: new THREE.Vector2() },
        radius: { value: 1 },
        projScale: { value: 1 },
        ortho: { value: 0 },
        far: { value: 400 },
        power: { value: 1.35 },
        maxPx: { value: 64 },
      },
      { DIRS: dirs, STEPS: 4, THIN: '0.7' },
    );
    this.denoiseMat = fsMaterial(DENOISE_FRAG, { tAO: { value: null }, size: { value: new THREE.Vector2() } });
  }

  setSize(width: number, height: number) {
    this.fullW = width;
    this.fullH = height;
    const hw = Math.max(1, Math.ceil(width / 2));
    const hh = Math.max(1, Math.ceil(height / 2));
    this.raw.setSize(hw, hh);
    this.clean.setSize(hw, hh);
  }

  render(renderer: THREE.WebGLRenderer, _w: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const depth = this.depth.texture;
    if (!depth) {
      this.texture = null;
      return;
    }
    if (readBuffer.width !== this.fullW || readBuffer.height !== this.fullH) this.setSize(readBuffer.width, readBuffer.height);
    const cam = this.camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    const u = this.aoMat.uniforms;
    u.tDepth.value = depth;
    u.projInv.value.copy(cam.projectionMatrixInverse);
    u.fullTexel.value.set(1 / this.fullW, 1 / this.fullH);
    (u.fullSize.value as THREE.Vector2).set(this.fullW, this.fullH);
    u.radius.value = this.radius;
    // pixels per world unit at view distance 1 (perspective) or everywhere (orthographic)
    u.projScale.value = 0.5 * this.fullH * cam.projectionMatrix.elements[5];
    u.ortho.value = (cam as THREE.OrthographicCamera).isOrthographicCamera ? 1 : 0;
    this.far = (cam as THREE.PerspectiveCamera).far;
    u.far.value = this.far;
    u.power.value = this.power;
    u.maxPx.value = 0.09 * this.fullH;
    const prev = renderer.getRenderTarget();
    this.blit.draw(renderer, this.aoMat, this.raw);
    const d = this.denoiseMat.uniforms;
    d.tAO.value = this.raw.texture;
    (d.size.value as THREE.Vector2).set(this.raw.width, this.raw.height);
    this.blit.draw(renderer, this.denoiseMat, this.clean);
    renderer.setRenderTarget(prev);
    this.texture = this.clean.texture;
  }

  /** Half-resolution size of the AO buffer (final pass upsample). */
  sizeInto(v: THREE.Vector2) {
    return v.set(this.clean.width, this.clean.height);
  }

  dispose() {
    this.raw.dispose();
    this.clean.dispose();
    this.aoMat.dispose();
    this.denoiseMat.dispose();
    this.blit.dispose();
  }
}
