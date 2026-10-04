import * as THREE from 'three';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { Blitter, colorTarget, fsMaterial } from './util';

/*
 * Physically based bloom (the Call of Duty: Advanced Warfare / Unity HDRP
 * mip-chain flavour), replacing UnrealBloomPass:
 *
 *  - prefilter: soft-knee threshold in exposed units (only light brighter than
 *    the scene's white starts to bloom, with a smooth knee instead of a hard
 *    cut) and a Karis (1 / (1 + luma)) average against fireflies, so a single
 *    hot pixel of a muzzle flash doesn't flicker;
 *  - downsample chain from half resolution: 13-tap filter (full quality) or a
 *    4-tap box (cheap rung);
 *  - upsample chain with a 3x3 tent (full) or 4-tap (cheap) filter, each level
 *    mixed with the next as lerp(sharp, wide, scatter): the weights of all
 *    levels sum to one, so the result is a normalised blur of the extracted
 *    energy. The final pass adds it back scaled by `strength`: no energy is
 *    invented by the chain itself, bright sources spread their own light.
 *
 * The pass doesn't touch the colour buffer (needsSwap = false): FinalPass
 * reads `texture` (and `wide` for the lens dirt, `streak` for the flare).
 */

const DOWN13 = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 texel;
uniform float prefilter;
uniform vec4 thr; // threshold, threshold - knee, 2 knee, 0.25 / knee
varying vec2 vUv;
float lum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
// (NaN / Inf from a broken pixel is dropped here: the mip chain would otherwise smear it over the whole frame)
vec3 tap( vec2 o ) { vec3 c = texture2D( tSrc, vUv + o * texel ).rgb; return any( isnan( c ) ) ? vec3( 0.0 ) : min( c, vec3( 256.0 ) ); }
vec3 soft( vec3 c ) {
  float br = max( c.r, max( c.g, c.b ) );
  float s = clamp( br - thr.y, 0.0, thr.z );
  s = s * s * thr.w;
  return c * ( max( s, br - thr.x ) / max( br, 1e-4 ) );
}
void main() {
  vec3 a = tap( vec2( -2.0, 2.0 ) ), b = tap( vec2( 0.0, 2.0 ) ), c = tap( vec2( 2.0, 2.0 ) );
  vec3 d = tap( vec2( -2.0, 0.0 ) ), e = tap( vec2( 0.0 ) ), f = tap( vec2( 2.0, 0.0 ) );
  vec3 g = tap( vec2( -2.0, -2.0 ) ), h = tap( vec2( 0.0, -2.0 ) ), i = tap( vec2( 2.0, -2.0 ) );
  vec3 j = tap( vec2( -1.0, 1.0 ) ), k = tap( vec2( 1.0, 1.0 ) ), l = tap( vec2( -1.0, -1.0 ) ), m = tap( vec2( 1.0, -1.0 ) );
  vec3 o;
  if ( prefilter > 0.5 ) {
    // Karis average of the five 2x2 boxes, then the soft threshold
    vec3 b0 = ( j + k + l + m ) * 0.25;
    vec3 b1 = ( a + b + d + e ) * 0.25;
    vec3 b2 = ( b + c + e + f ) * 0.25;
    vec3 b3 = ( d + e + g + h ) * 0.25;
    vec3 b4 = ( e + f + h + i ) * 0.25;
    float w0 = 0.5 / ( 1.0 + lum( b0 ) ), w1 = 0.125 / ( 1.0 + lum( b1 ) ), w2 = 0.125 / ( 1.0 + lum( b2 ) ), w3 = 0.125 / ( 1.0 + lum( b3 ) ), w4 = 0.125 / ( 1.0 + lum( b4 ) );
    o = soft( ( b0 * w0 + b1 * w1 + b2 * w2 + b3 * w3 + b4 * w4 ) / ( w0 + w1 + w2 + w3 + w4 ) );
  } else {
    o = e * 0.125 + ( a + c + g + i ) * 0.03125 + ( b + d + f + h ) * 0.0625 + ( j + k + l + m ) * 0.125;
  }
  gl_FragColor = vec4( o, 1.0 );
}`;

const DOWN4 = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 texel;
uniform float prefilter;
uniform vec4 thr;
varying vec2 vUv;
float lum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
vec3 soft( vec3 c ) {
  float br = max( c.r, max( c.g, c.b ) );
  float s = clamp( br - thr.y, 0.0, thr.z );
  s = s * s * thr.w;
  return c * ( max( s, br - thr.x ) / max( br, 1e-4 ) );
}
vec3 tap( vec2 o ) { vec3 c = texture2D( tSrc, vUv + o * texel ).rgb; return any( isnan( c ) ) ? vec3( 0.0 ) : min( c, vec3( 256.0 ) ); }
void main() {
  vec3 a = tap( vec2( -1.0, -1.0 ) );
  vec3 b = tap( vec2( 1.0, -1.0 ) );
  vec3 c = tap( vec2( -1.0, 1.0 ) );
  vec3 d = tap( vec2( 1.0, 1.0 ) );
  vec3 o;
  if ( prefilter > 0.5 ) {
    float wa = 1.0 / ( 1.0 + lum( a ) ), wb = 1.0 / ( 1.0 + lum( b ) ), wc = 1.0 / ( 1.0 + lum( c ) ), wd = 1.0 / ( 1.0 + lum( d ) );
    o = soft( ( a * wa + b * wb + c * wc + d * wd ) / ( wa + wb + wc + wd ) );
  } else o = ( a + b + c + d ) * 0.25;
  gl_FragColor = vec4( o, 1.0 );
}`;

const UP9 = /* glsl */ `
uniform sampler2D tLow;
uniform sampler2D tHigh;
uniform vec2 texel;
uniform float scatter;
varying vec2 vUv;
void main() {
  vec3 s = texture2D( tLow, vUv ).rgb * 4.0;
  s += ( texture2D( tLow, vUv + vec2( texel.x, 0.0 ) ).rgb + texture2D( tLow, vUv - vec2( texel.x, 0.0 ) ).rgb + texture2D( tLow, vUv + vec2( 0.0, texel.y ) ).rgb + texture2D( tLow, vUv - vec2( 0.0, texel.y ) ).rgb ) * 2.0;
  s += texture2D( tLow, vUv + texel ).rgb + texture2D( tLow, vUv - texel ).rgb + texture2D( tLow, vUv + vec2( texel.x, -texel.y ) ).rgb + texture2D( tLow, vUv + vec2( -texel.x, texel.y ) ).rgb;
  gl_FragColor = vec4( mix( texture2D( tHigh, vUv ).rgb, s / 16.0, scatter ), 1.0 );
}`;

const UP4 = /* glsl */ `
uniform sampler2D tLow;
uniform sampler2D tHigh;
uniform vec2 texel;
uniform float scatter;
varying vec2 vUv;
void main() {
  vec2 o = texel * 0.5;
  vec3 s = texture2D( tLow, vUv + vec2( -o.x, -o.y ) ).rgb + texture2D( tLow, vUv + vec2( o.x, -o.y ) ).rgb + texture2D( tLow, vUv + vec2( -o.x, o.y ) ).rgb + texture2D( tLow, vUv + o ).rgb;
  gl_FragColor = vec4( mix( texture2D( tHigh, vUv ).rgb, s * 0.25, scatter ), 1.0 );
}`;

/** Anamorphic streak: a wide horizontal gather of the brightest part of a low mip. */
const STREAK = /* glsl */ `
uniform sampler2D tSrc;
uniform float threshold;
varying vec2 vUv;
void main() {
  vec3 acc = vec3( 0.0 );
  float ws = 0.0;
  for ( int i = -12; i <= 12; i++ ) {
    float x = float( i ) / 12.0;
    float w = exp( -abs( x ) * 3.2 );
    vec3 s = texture2D( tSrc, vUv + vec2( x * 0.25, 0.0 ) ).rgb;
    acc += max( s - threshold, vec3( 0.0 ) ) * w;
    ws += w;
  }
  gl_FragColor = vec4( acc / ws, 1.0 );
}`;

const MAX_LEVELS = 6;

export class BloomPass extends Pass {
  /** Bloom strength (set per time of day / weather by atmos.ts, same scale UnrealBloomPass used). */
  strength = 0.42;
  /** 2 = full (13-tap down, tent up, 6 levels), 1 = cheap (4-tap, 4 levels). */
  quality: 1 | 2 = 2;
  /** Soft threshold (exposed linear units) and knee. */
  threshold = 0.85;
  knee = 0.6;
  /** Upsample mix towards the wider level (0..1). */
  scatter = 0.7;
  /** Exposure the final pass applies (the threshold is in exposed units). */
  exposure = 1.2;
  /** Anamorphic flare streak buffer for very bright sources (lens extras, high quality). */
  streakOn = false;
  /** Result: normalised bloom (half resolution); null until the first render. */
  texture: THREE.Texture | null = null;
  /** A wide, low-resolution level (lens dirt). */
  wide: THREE.Texture | null = null;
  /** Flare streak (when streakOn). */
  streak: THREE.Texture | null = null;
  private type: THREE.TextureDataType;
  private down: THREE.WebGLRenderTarget[] = [];
  private up: THREE.WebGLRenderTarget[] = [];
  private streakRT: THREE.WebGLRenderTarget | null = null;
  private down13: THREE.ShaderMaterial;
  private down4: THREE.ShaderMaterial;
  private up9: THREE.ShaderMaterial;
  private up4: THREE.ShaderMaterial;
  private streakMat: THREE.ShaderMaterial;
  private blit = new Blitter();
  private w = 0;
  private h = 0;
  /** Draws of the last frame (stats). */
  draws = 0;
  /** Render every variant once (shader warm-up on the first frame). */
  warm = true;

  constructor(type: THREE.TextureDataType) {
    super();
    this.needsSwap = false;
    this.type = type;
    const du = () => ({ tSrc: { value: null as THREE.Texture | null }, texel: { value: new THREE.Vector2() }, prefilter: { value: 0 }, thr: { value: new THREE.Vector4() } });
    const uu = () => ({ tLow: { value: null as THREE.Texture | null }, tHigh: { value: null as THREE.Texture | null }, texel: { value: new THREE.Vector2() }, scatter: { value: 0.7 } });
    this.down13 = fsMaterial(DOWN13, du());
    this.down4 = fsMaterial(DOWN4, du());
    this.up9 = fsMaterial(UP9, uu());
    this.up4 = fsMaterial(UP4, uu());
    this.streakMat = fsMaterial(STREAK, { tSrc: { value: null }, threshold: { value: 0.5 } });
  }

  setSize(width: number, height: number) {
    const w = Math.max(1, Math.round(width / 2));
    const h = Math.max(1, Math.round(height / 2));
    if (w === this.w && h === this.h) return;
    this.w = w;
    this.h = h;
    let lw = w;
    let lh = h;
    for (let i = 0; i < MAX_LEVELS; i++) {
      if (!this.down[i]) this.down[i] = colorTarget(lw, lh, this.type);
      else this.down[i].setSize(lw, lh);
      if (i < MAX_LEVELS - 1) {
        if (!this.up[i]) this.up[i] = colorTarget(lw, lh, this.type);
        else this.up[i].setSize(lw, lh);
      }
      lw = Math.max(1, lw >> 1);
      lh = Math.max(1, lh >> 1);
    }
    const sw = Math.max(1, w >> 2);
    const sh = Math.max(1, h >> 3);
    if (!this.streakRT) this.streakRT = colorTarget(sw, sh, this.type);
    else this.streakRT.setSize(sw, sh);
  }

  /** Levels used at the current quality and size. */
  private levels(q: 1 | 2): number {
    let n = q === 2 ? MAX_LEVELS : 4;
    // stop before the levels get smaller than a few pixels
    while (n > 2 && Math.min(this.down[n - 1].width, this.down[n - 1].height) < 3) n--;
    return n;
  }

  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    if (!this.w) this.setSize(readBuffer.width, readBuffer.height);
    const prev = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    this.draws = 0;
    if (this.warm) {
      // first frame: compile the other quality's shaders and the streak too
      this.warm = false;
      this.chain(renderer, readBuffer.texture, this.quality === 2 ? 1 : 2);
      this.renderStreak(renderer);
    }
    this.chain(renderer, readBuffer.texture, this.quality);
    this.streak = this.streakOn ? this.renderStreak(renderer) : null;
    renderer.autoClear = autoClear;
    renderer.setRenderTarget(prev);
  }

  private chain(renderer: THREE.WebGLRenderer, src: THREE.Texture, q: 1 | 2) {
    const n = this.levels(q);
    const dm = q === 2 ? this.down13 : this.down4;
    const um = q === 2 ? this.up9 : this.up4;
    const du = dm.uniforms;
    // soft threshold in the units of the colour buffer (the final pass multiplies by the exposure)
    const t = this.threshold / Math.max(0.05, this.exposure);
    const k = Math.max(1e-3, t * this.knee);
    du.thr.value.set(t, t - k, 2 * k, 0.25 / k);
    let srcW = this.w * 2;
    let srcH = this.h * 2;
    for (let i = 0; i < n; i++) {
      du.tSrc.value = i === 0 ? src : this.down[i - 1].texture;
      du.texel.value.set(1 / srcW, 1 / srcH);
      du.prefilter.value = i === 0 ? 1 : 0;
      this.blit.draw(renderer, dm, this.down[i]);
      this.draws++;
      srcW = this.down[i].width;
      srcH = this.down[i].height;
    }
    const uu = um.uniforms;
    uu.scatter.value = this.scatter;
    let low = this.down[n - 1].texture;
    for (let i = n - 2; i >= 0; i--) {
      const lowRT = i === n - 2 ? this.down[n - 1] : this.up[i + 1];
      uu.tLow.value = low;
      uu.tHigh.value = this.down[i].texture;
      uu.texel.value.set(1 / lowRT.width, 1 / lowRT.height);
      this.blit.draw(renderer, um, this.up[i]);
      this.draws++;
      low = this.up[i].texture;
    }
    this.texture = this.up[0].texture;
    this.wide = this.up[Math.min(2, n - 2)].texture;
  }

  private renderStreak(renderer: THREE.WebGLRenderer): THREE.Texture {
    const rt = this.streakRT!;
    const u = this.streakMat.uniforms;
    u.tSrc.value = this.down[Math.min(3, this.down.length - 1)].texture;
    u.threshold.value = 0.35 / Math.max(0.05, this.exposure);
    this.blit.draw(renderer, this.streakMat, rt);
    this.draws++;
    return rt.texture;
  }

  dispose() {
    for (const r of [...this.down, ...this.up]) r.dispose();
    this.streakRT?.dispose();
    for (const m of [this.down13, this.down4, this.up9, this.up4, this.streakMat]) m.dispose();
    this.blit.dispose();
  }
}
