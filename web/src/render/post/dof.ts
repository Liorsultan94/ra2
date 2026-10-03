import * as THREE from 'three';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import type { DepthTap } from './ao';
import { Blitter, VIEWPOS_GLSL, colorTarget, fsMaterial } from './util';

/*
 * Bokeh depth of field on the HDR colour (before bloom and tone mapping, so
 * bright highlights open into proper discs). Photo mode drives it with a
 * focus distance and an aperture; the battle intro / outro flyovers use a
 * gentle, tilt-shift-like setting focused on the look point.
 *
 *  1. half-res prefilter: colour + signed circle of confusion from depth
 *     (thin-lens shape: coc = aperture * (1 - focus / z), negative in front);
 *  2. half-res gather: 48-tap golden-angle disc, scatter-as-gather (a sample
 *     contributes where its own CoC reaches the pixel; things behind the
 *     pixel can't bleed over a sharper foreground);
 *  3. full-res composite: sharp where the CoC is under a pixel, blurred
 *     beyond; alpha = blur amount (the final pass fades the AO with it).
 *
 * Zero cost while off (the pass is disabled).
 */

const PRE_FRAG = /* glsl */ `
${VIEWPOS_GLSL}
uniform sampler2D tColor;
uniform vec2 texel;
uniform float focus;
uniform float aperture;
uniform float maxCoc;
varying vec2 vUv;
void main() {
  vec3 c = texture2D( tColor, vUv ).rgb;
  float z = -viewPos( vUv ).z;
  // circle of confusion in half-res pixels
  float coc = clamp( aperture * ( 1.0 - focus / max( z, 1e-3 ) ), -maxCoc, maxCoc );
  gl_FragColor = vec4( min( c, vec3( 64.0 ) ), coc );
}`;

const GATHER_FRAG = /* glsl */ `
uniform sampler2D tHalf;
uniform vec2 texel;
uniform float maxCoc;
varying vec2 vUv;
const float GOLDEN = 2.39996323;
void main() {
  vec4 c0 = texture2D( tHalf, vUv );
  float cs = abs( c0.a );
  vec3 col = c0.rgb;
  float tot = 1.0;
  for ( int i = 0; i < TAPS; i++ ) {
    float fi = float( i );
    float r = maxCoc * sqrt( ( fi + 0.5 ) / float( TAPS ) );
    float a = fi * GOLDEN;
    vec4 s = texture2D( tHalf, vUv + vec2( cos( a ), sin( a ) ) * texel * r );
    float ss = abs( s.a );
    // a sample behind the centre can't cover more than twice the centre's blur
    if ( s.a > c0.a ) ss = min( ss, cs * 2.0 );
    float m = smoothstep( r - 1.0, r + 1.0, ss );
    col += mix( col / tot, s.rgb, m );
    tot += 1.0;
  }
  gl_FragColor = vec4( col / tot, cs );
}`;

const COMP_FRAG = /* glsl */ `
${VIEWPOS_GLSL}
uniform sampler2D tColor;
uniform sampler2D tBlur;
uniform float focus;
uniform float aperture;
uniform float maxCoc;
varying vec2 vUv;
void main() {
  vec4 sharp = texture2D( tColor, vUv );
  vec4 b = texture2D( tBlur, vUv );
  float z = -viewPos( vUv ).z;
  float coc = abs( clamp( aperture * ( 1.0 - focus / max( z, 1e-3 ) ), -maxCoc, maxCoc ) );
  // half-res pixels: blend in from half a pixel of blur, plus foreground blur spilling over (b.a)
  float k = smoothstep( 0.35, 1.4, max( coc, b.a * 0.6 ) );
  gl_FragColor = vec4( mix( sharp.rgb, b.rgb, k ), k );
}`;

export class DofPass extends Pass {
  /** Focus distance along the view axis (world units). */
  focus = 20;
  /** Blur amount 0..1 (0 = off). */
  amount = 0;
  private half: THREE.WebGLRenderTarget;
  private blur: THREE.WebGLRenderTarget;
  private pre: THREE.ShaderMaterial;
  private gather: THREE.ShaderMaterial;
  private comp: THREE.ShaderMaterial;
  private blit = new Blitter();
  private w = 1;
  private h = 1;

  constructor(
    private camera: THREE.Camera,
    private depth: DepthTap,
    type: THREE.TextureDataType,
    taps = 48,
  ) {
    super();
    this.enabled = false;
    this.half = colorTarget(1, 1, type);
    this.blur = colorTarget(1, 1, type);
    const dof = () => ({ focus: { value: 20 }, aperture: { value: 0 }, maxCoc: { value: 8 } });
    this.pre = fsMaterial(PRE_FRAG, { tDepth: { value: null }, projInv: { value: new THREE.Matrix4() }, tColor: { value: null }, texel: { value: new THREE.Vector2() }, ...dof() });
    this.gather = fsMaterial(GATHER_FRAG, { tHalf: { value: null }, texel: { value: new THREE.Vector2() }, maxCoc: { value: 8 } }, { TAPS: taps });
    this.comp = fsMaterial(COMP_FRAG, { tDepth: { value: null }, projInv: { value: new THREE.Matrix4() }, tColor: { value: null }, tBlur: { value: null }, ...dof() });
  }

  setSize(width: number, height: number) {
    this.w = width;
    this.h = height;
    this.half.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1));
    this.blur.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1));
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const depth = this.depth.texture;
    if (readBuffer.width !== this.w || readBuffer.height !== this.h) this.setSize(readBuffer.width, readBuffer.height);
    const cam = this.camera;
    // aperture in half-res pixels at infinity; capped disc size
    const hh = this.half.height;
    const maxCoc = Math.max(1, hh * 0.028);
    const ap = this.amount * hh * 0.045;
    for (let i = 0; i < 2; i++) {
      const u = (i ? this.comp : this.pre).uniforms;
      u.tDepth.value = depth;
      u.projInv.value.copy(cam.projectionMatrixInverse);
      u.focus.value = this.focus;
      u.aperture.value = ap;
      u.maxCoc.value = maxCoc;
      u.tColor.value = readBuffer.texture;
    }
    this.pre.uniforms.texel.value.set(1 / this.w, 1 / this.h);
    this.blit.draw(renderer, this.pre, this.half);
    const g = this.gather.uniforms;
    g.tHalf.value = this.half.texture;
    g.texel.value.set(1 / this.half.width, 1 / this.half.height);
    g.maxCoc.value = maxCoc;
    this.blit.draw(renderer, this.gather, this.blur);
    this.comp.uniforms.tBlur.value = this.blur.texture;
    this.blit.draw(renderer, this.comp, this.renderToScreen ? null : writeBuffer);
  }

  dispose() {
    this.half.dispose();
    this.blur.dispose();
    for (const m of [this.pre, this.gather, this.comp]) m.dispose();
    this.blit.dispose();
  }
}
