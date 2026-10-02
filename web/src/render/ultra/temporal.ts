import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { WX } from '../wxuniforms';

/*
 * Ultra quality: temporal anti-aliasing and the screen-space extras that
 * need the scene depth buffer.
 *
 *  - JitterRenderPass: the main scene render with a sub-pixel camera jitter
 *    (Halton 2/3, 8 phases). It renders into the composer's buffer, which on
 *    ultra carries a depth texture; the depth is handed on to GTAO (so AO
 *    needs no extra normal/depth scene render) and to TemporalPass.
 *  - TemporalPass:
 *      1. (rain only) half-resolution screen-space reflections on wet, flat
 *         ground: a depth-buffer ray march with normals rebuilt from depth;
 *      2. a full-resolution composite of those reflections plus screen-space
 *         contact shadows (a short march towards the sun through the depth
 *         buffer: the thin dark seam where tracks, feet and walls meet the
 *         ground, which biased shadow maps miss);
 *      3. the TAA resolve: history reprojected with the camera motion (static
 *         scene reprojection from depth), 5-tap Catmull-Rom history fetch,
 *         variance-clipped against the 3x3 neighbourhood in YCoCg (moving
 *         units and effects don't ghost), luminance-weighted blend. The
 *         FinalPass sharpens the result a touch.
 *  History is reset on resize and whenever the caller asks (view cuts).
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`;

/** Shared GLSL: view-space position from the depth buffer. */
const DEPTH_GLSL = /* glsl */ `
uniform sampler2D tDepth;
uniform mat4 projInv;
uniform mat4 proj;
vec3 viewAt( vec2 uv ) {
  float d = texture2D( tDepth, uv ).x;
  vec4 p = projInv * vec4( uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  return p.xyz / p.w;
}
vec2 toUv( vec3 p ) {
  vec4 c = proj * vec4( p, 1.0 );
  return c.xy / c.w * 0.5 + 0.5;
}
// normal from depth: of the two neighbours per axis, take the one on the same surface
vec3 normalAt( vec2 uv, vec3 P, vec2 px ) {
  vec3 pr = viewAt( uv + vec2( px.x, 0.0 ) );
  vec3 pl = viewAt( uv - vec2( px.x, 0.0 ) );
  vec3 pu = viewAt( uv + vec2( 0.0, px.y ) );
  vec3 pd = viewAt( uv - vec2( 0.0, px.y ) );
  vec3 dx = abs( pr.z - P.z ) < abs( P.z - pl.z ) ? pr - P : P - pl;
  vec3 dy = abs( pu.z - P.z ) < abs( P.z - pd.z ) ? pu - P : P - pd;
  vec3 n = normalize( cross( dx, dy ) );
  return dot( n, P ) > 0.0 ? -n : n;
}
float ign( vec2 p ) { return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) ); }
`;

const SSR_FRAG = /* glsl */ `
${DEPTH_GLSL}
uniform sampler2D tColor;
uniform sampler2D fogNoise;
uniform mat4 camWorld;
uniform vec2 res;
uniform float wet;
uniform float frame;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4( 0.0 );
  float d = texture2D( tDepth, vUv ).x;
  if ( d >= 0.99999 ) return;
  vec2 px = 1.0 / res;
  vec3 P = viewAt( vUv );
  vec3 N = normalAt( vUv, P, px );
  vec3 Nw = ( camWorld * vec4( N, 0.0 ) ).xyz;
  vec3 W = ( camWorld * vec4( P, 1.0 ) ).xyz;
  // wet film on flat ground, mirror-like in the puddle spots (same noise the ground shader pools water with)
  float flat = smoothstep( 0.86, 0.97, Nw.y );
  float n1 = texture2D( fogNoise, W.xz * 0.085 + 0.13 ).g;
  float n2 = texture2D( fogNoise, W.xz * 0.33 + 0.57 ).r;
  float pud = smoothstep( 0.6, 0.67, n1 * 0.78 + n2 * 0.22 );
  float mask = flat * wet * ( 0.3 + 0.7 * pud );
  if ( mask < 0.01 ) return;
  vec3 V = normalize( P );
  vec3 R = normalize( reflect( V, N ) );
  float jit = ign( gl_FragCoord.xy + frame * 5.588238 );
  float t = 0.12 + 0.18 * jit;
  float stepLen = 0.22;
  vec2 hitUv = vec2( -1.0 );
  float prevT = 0.0;
  for ( int i = 0; i < 28; i++ ) {
    vec3 Q = P + R * t;
    vec2 uv = toUv( Q );
    if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) break;
    float sz = viewAt( uv ).z;
    float diff = sz - Q.z;
    if ( diff > 0.0 && diff < 0.6 + t * 0.08 ) {
      // binary refinement between the last miss and this hit
      float a = prevT, b = t;
      for ( int k = 0; k < 4; k++ ) {
        float m = 0.5 * ( a + b );
        vec3 M = P + R * m;
        if ( viewAt( toUv( M ) ).z - M.z > 0.0 ) b = m; else a = m;
      }
      hitUv = toUv( P + R * b );
      break;
    }
    prevT = t;
    t += stepLen;
    stepLen *= 1.12;
  }
  if ( hitUv.x < 0.0 ) return;
  vec2 e = smoothstep( vec2( 0.0 ), vec2( 0.08 ), hitUv ) * smoothstep( vec2( 0.0 ), vec2( 0.08 ), 1.0 - hitUv );
  float fres = 0.04 + 0.96 * pow( 1.0 - clamp( dot( -V, N ), 0.0, 1.0 ), 5.0 );
  float k = mask * e.x * e.y * mix( 0.35, 1.0, pud ) * ( 0.55 + 0.45 * fres ) * smoothstep( 14.0, 6.0, t );
  gl_FragColor = vec4( texture2D( tColor, hitUv ).rgb, k );
}`;

const COMPOSITE_FRAG = /* glsl */ `
${DEPTH_GLSL}
uniform sampler2D tColor;
uniform sampler2D tSSR;
uniform float ssrOn;
uniform float contact;
uniform vec3 sunView;
uniform vec2 res;
uniform float frame;
varying vec2 vUv;
void main() {
  vec3 c = texture2D( tColor, vUv ).rgb;
  float d = texture2D( tDepth, vUv ).x;
  if ( d < 0.99999 ) {
    if ( ssrOn > 0.5 ) {
      vec4 s = texture2D( tSSR, vUv );
      c = mix( c, s.rgb, clamp( s.a, 0.0, 0.85 ) );
    }
    if ( contact > 0.0 ) {
      vec3 P = viewAt( vUv );
      vec3 N = normalAt( vUv, P, 1.0 / res );
      float facing = smoothstep( 0.0, 0.25, dot( N, sunView ) );
      if ( facing > 0.0 ) {
        float jit = ign( gl_FragCoord.xy + frame * 5.588238 );
        float occ = 0.0;
        // ~0.45 world units towards the sun, 10 steps; thickness rejects distant occluders (no halos)
        for ( int i = 0; i < 10; i++ ) {
          float t = ( float( i ) + jit ) * 0.045 + 0.02;
          vec3 Q = P + sunView * t;
          vec2 uv = toUv( Q );
          if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) break;
          float dz = viewAt( uv ).z - Q.z;
          if ( dz > 0.012 && dz < 0.3 ) { occ = 1.0 - float( i ) / 12.0; break; }
        }
        c *= 1.0 - contact * occ * facing;
      }
    }
  }
  gl_FragColor = vec4( c, 1.0 );
}`;

const TAA_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tHistory;
uniform vec2 res;
uniform mat4 projInv;
uniform mat4 camWorld;
uniform mat4 prevViewProj;
uniform float histValid;
varying vec2 vUv;

vec3 tm( vec3 c ) { return c / ( 1.0 + max( max( c.r, c.g ), c.b ) ); }
vec3 itm( vec3 c ) { return c / max( 1e-4, 1.0 - max( max( c.r, c.g ), c.b ) ); }
vec3 toYC( vec3 c ) { return vec3( dot( c, vec3( 0.25, 0.5, 0.25 ) ), dot( c, vec3( 0.5, 0.0, -0.5 ) ), dot( c, vec3( -0.25, 0.5, -0.25 ) ) ); }
vec3 fromYC( vec3 c ) { return vec3( c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z ); }
vec3 fetch( vec2 uv ) { return toYC( tm( max( texture2D( tColor, uv ).rgb, vec3( 0.0 ) ) ) ); }

// 5-tap Catmull-Rom history fetch (sharper than bilinear under motion)
vec3 history( vec2 uv ) {
  vec2 sp = uv * res;
  vec2 tp = floor( sp - 0.5 ) + 0.5;
  vec2 f = sp - tp;
  vec2 w0 = f * ( -0.5 + f * ( 1.0 - 0.5 * f ) );
  vec2 w1 = 1.0 + f * f * ( -2.5 + 1.5 * f );
  vec2 w2 = f * ( 0.5 + f * ( 2.0 - 1.5 * f ) );
  vec2 w3 = f * f * ( -0.5 + 0.5 * f );
  vec2 w12 = w1 + w2;
  vec2 tc0 = ( tp - 1.0 ) / res;
  vec2 tc3 = ( tp + 2.0 ) / res;
  vec2 tc12 = ( tp + w2 / w12 ) / res;
  vec3 r = texture2D( tHistory, vec2( tc12.x, tc0.y ) ).rgb * ( w12.x * w0.y )
    + texture2D( tHistory, vec2( tc0.x, tc12.y ) ).rgb * ( w0.x * w12.y )
    + texture2D( tHistory, tc12 ).rgb * ( w12.x * w12.y )
    + texture2D( tHistory, vec2( tc3.x, tc12.y ) ).rgb * ( w3.x * w12.y )
    + texture2D( tHistory, vec2( tc12.x, tc3.y ) ).rgb * ( w12.x * w3.y );
  float ws = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max( r / ws, vec3( 0.0 ) );
}

void main() {
  vec2 px = 1.0 / res;
  // neighbourhood statistics (YCoCg of the tonemapped colour)
  vec3 cur = fetch( vUv );
  vec3 m1 = cur, m2 = cur * cur, mn = cur, mx = cur;
  float dmin = texture2D( tDepth, vUv ).x;
  vec2 duv = vUv;
  for ( int j = -1; j <= 1; j++ )
    for ( int i = -1; i <= 1; i++ ) {
      if ( i == 0 && j == 0 ) continue;
      vec2 o = vec2( float( i ), float( j ) ) * px;
      vec3 s = fetch( vUv + o );
      m1 += s; m2 += s * s; mn = min( mn, s ); mx = max( mx, s );
      float dd = texture2D( tDepth, vUv + o ).x;
      if ( dd < dmin ) { dmin = dd; duv = vUv + o; }
    }
  m1 /= 9.0;
  vec3 sig = sqrt( max( m2 / 9.0 - m1 * m1, vec3( 0.0 ) ) );
  vec3 bmin = max( mn, m1 - sig * 1.25 );
  vec3 bmax = min( mx, m1 + sig * 1.25 );
  // reproject the nearest surface of the neighbourhood (edges of moving silhouettes follow the front object)
  vec4 vp = projInv * vec4( duv * 2.0 - 1.0, dmin * 2.0 - 1.0, 1.0 );
  vec4 wp = camWorld * vec4( vp.xyz / vp.w, 1.0 );
  vec4 pc = prevViewProj * wp;
  vec2 prevUv = pc.xy / pc.w * 0.5 + 0.5 + ( vUv - duv );
  float vel = length( ( prevUv - vUv ) * res );
  bool off = prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0;
  vec3 res3;
  if ( histValid < 0.5 || off ) {
    res3 = cur;
  } else {
    vec3 h = toYC( tm( history( prevUv ) ) );
    // clip towards the box centre (not a plain clamp: keeps hue)
    vec3 c = 0.5 * ( bmax + bmin );
    vec3 e = 0.5 * ( bmax - bmin ) + 1e-5;
    vec3 v = h - c;
    vec3 a = abs( v / e );
    float ma = max( a.x, max( a.y, a.z ) );
    if ( ma > 1.0 ) h = c + v / ma;
    float alpha = mix( 0.08, 0.22, clamp( vel / 6.0, 0.0, 1.0 ) );
    // luminance weighting against flicker of small bright details
    float wc = alpha / ( 1.0 + cur.x );
    float wh = ( 1.0 - alpha ) / ( 1.0 + h.x );
    res3 = ( cur * wc + h * wh ) / ( wc + wh );
  }
  gl_FragColor = vec4( max( itm( fromYC( res3 ) ), vec3( 0.0 ) ), 1.0 );
}`;

const COPY_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main() { gl_FragColor = texture2D( tDiffuse, vUv ); }`;

function halton(i: number, b: number) {
  let f = 1;
  let r = 0;
  while (i > 0) {
    f /= b;
    r += f * (i % b);
    i = Math.floor(i / b);
  }
  return r;
}

/** Scene render with sub-pixel projection jitter; remembers the depth texture it drew into. */
export class JitterRenderPass extends RenderPass {
  jitter = true;
  depthTexture: THREE.DepthTexture | null = null;
  private phase = 0;
  private saved = new THREE.Matrix4();
  private savedInv = new THREE.Matrix4();
  /** Called right after the scene render (hands the depth on to GTAO). */
  onDepth: ((d: THREE.DepthTexture) => void) | null = null;

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget, deltaTime: number, maskActive: boolean) {
    const cam = this.camera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    const on = this.jitter;
    if (on) {
      this.phase = (this.phase % 8) + 1;
      const jx = (halton(this.phase, 2) - 0.5) * 2;
      const jy = (halton(this.phase, 3) - 0.5) * 2;
      this.saved.copy(cam.projectionMatrix);
      this.savedInv.copy(cam.projectionMatrixInverse);
      const e = cam.projectionMatrix.elements;
      const w = Math.max(1, readBuffer.width);
      const h = Math.max(1, readBuffer.height);
      if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera) {
        e[8] += jx / w;
        e[9] += jy / h;
      } else {
        e[12] += jx / w;
        e[13] += jy / h;
      }
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    }
    super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
    if (on) {
      cam.projectionMatrix.copy(this.saved);
      cam.projectionMatrixInverse.copy(this.savedInv);
    }
    this.depthTexture = readBuffer.depthTexture as THREE.DepthTexture | null;
    if (this.depthTexture) this.onDepth?.(this.depthTexture);
  }
}

function rt(w: number, h: number) {
  return new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
}

export class TemporalPass extends Pass {
  /** Temporal resolve on/off (off = pass-through of the composite). */
  taa = true;
  /** Screen-space contact shadow strength (0 = off). */
  contact = 0.32;
  /** Screen-space reflections on wet ground (only runs while it rains). */
  ssr = true;
  /** Direction towards the sun (world space). */
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  private histA = rt(1, 1);
  private histB = rt(1, 1);
  private comp = rt(1, 1);
  private ssrRT = rt(1, 1);
  private valid = false;
  private prevViewProj = new THREE.Matrix4();
  private frame = 0;
  private w = 1;
  private h = 1;
  private taaMat: THREE.ShaderMaterial;
  private compMat: THREE.ShaderMaterial;
  private ssrMat: THREE.ShaderMaterial;
  private copyMat: THREE.ShaderMaterial;
  private quad = new FullScreenQuad();
  private sunView = new THREE.Vector3();

  constructor(
    private src: JitterRenderPass,
    private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    fogNoise: THREE.Texture | null,
  ) {
    super();
    const depthU = () => ({ tDepth: { value: null as THREE.Texture | null }, projInv: { value: new THREE.Matrix4() }, proj: { value: new THREE.Matrix4() } });
    const mk = (frag: string, uniforms: Record<string, THREE.IUniform>) => new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: frag, depthTest: false, depthWrite: false, toneMapped: false });
    this.taaMat = mk(TAA_FRAG, {
      tColor: { value: null },
      tDepth: { value: null },
      tHistory: { value: null },
      res: { value: new THREE.Vector2(1, 1) },
      projInv: { value: new THREE.Matrix4() },
      camWorld: { value: new THREE.Matrix4() },
      prevViewProj: { value: new THREE.Matrix4() },
      histValid: { value: 0 },
    });
    this.compMat = mk(COMPOSITE_FRAG, { ...depthU(), tColor: { value: null }, tSSR: { value: null }, ssrOn: { value: 0 }, contact: { value: 0 }, sunView: { value: this.sunView }, res: { value: new THREE.Vector2(1, 1) }, frame: { value: 0 } });
    this.ssrMat = mk(SSR_FRAG, { ...depthU(), tColor: { value: null }, fogNoise: { value: fogNoise }, camWorld: { value: new THREE.Matrix4() }, res: { value: new THREE.Vector2(1, 1) }, wet: { value: 0 }, frame: { value: 0 } });
    this.copyMat = mk(COPY_FRAG, { tDiffuse: { value: null } });
  }

  /** Drop the history (view cuts, mode switches). */
  reset() {
    this.valid = false;
  }

  setSize(width: number, height: number) {
    this.w = width;
    this.h = height;
    this.histA.setSize(width, height);
    this.histB.setSize(width, height);
    this.comp.setSize(width, height);
    this.ssrRT.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1));
    this.valid = false;
  }

  private draw(renderer: THREE.WebGLRenderer, mat: THREE.Material, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = mat;
    renderer.setRenderTarget(target);
    this.quad.render(renderer);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const cam = this.camera;
    const depth = this.src.depthTexture;
    const out = this.renderToScreen ? null : writeBuffer;
    if (!depth || readBuffer.width !== this.w || readBuffer.height !== this.h) {
      if (readBuffer.width !== this.w || readBuffer.height !== this.h) this.setSize(readBuffer.width, readBuffer.height);
      this.copyMat.uniforms.tDiffuse.value = readBuffer.texture;
      this.draw(renderer, this.copyMat, out);
      return;
    }
    this.frame = (this.frame + 1) % 64;
    const projInv = cam.projectionMatrixInverse;
    let color: THREE.Texture = readBuffer.texture;
    const wet = this.ssr ? WX.wxWet.value : 0;
    const ssrOn = wet > 0.01;
    if (ssrOn || this.contact > 0) {
      if (ssrOn) {
        const u = this.ssrMat.uniforms;
        u.tDepth.value = depth;
        u.projInv.value.copy(projInv);
        u.proj.value.copy(cam.projectionMatrix);
        u.tColor.value = color;
        u.camWorld.value.copy(cam.matrixWorld);
        u.res.value.set(this.w, this.h);
        u.wet.value = wet;
        u.frame.value = this.frame;
        this.draw(renderer, this.ssrMat, this.ssrRT);
      }
      const u = this.compMat.uniforms;
      u.tDepth.value = depth;
      u.projInv.value.copy(projInv);
      u.proj.value.copy(cam.projectionMatrix);
      u.tColor.value = color;
      u.tSSR.value = this.ssrRT.texture;
      u.ssrOn.value = ssrOn ? 1 : 0;
      u.contact.value = this.contact;
      this.sunView.copy(this.sunDir).transformDirection(cam.matrixWorldInverse);
      u.res.value.set(this.w, this.h);
      u.frame.value = this.frame;
      this.draw(renderer, this.compMat, this.comp);
      color = this.comp.texture;
    }
    if (!this.taa) {
      this.copyMat.uniforms.tDiffuse.value = color;
      this.draw(renderer, this.copyMat, out);
      this.valid = false;
      return;
    }
    const t = this.taaMat.uniforms;
    t.tColor.value = color;
    t.tDepth.value = depth;
    t.tHistory.value = this.histA.texture;
    t.res.value.set(this.w, this.h);
    // unjittered reconstruction: velocity excludes the jitter, so a still view re-reads history texel-exact
    t.projInv.value.copy(projInv);
    t.camWorld.value.copy(cam.matrixWorld);
    t.prevViewProj.value.copy(this.prevViewProj);
    t.histValid.value = this.valid ? 1 : 0;
    this.draw(renderer, this.taaMat, this.histB);
    const tmp = this.histA;
    this.histA = this.histB;
    this.histB = tmp;
    this.prevViewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.valid = true;
    this.copyMat.uniforms.tDiffuse.value = this.histA.texture;
    this.draw(renderer, this.copyMat, out);
  }

  dispose() {
    for (const r of [this.histA, this.histB, this.comp, this.ssrRT]) r.dispose();
    for (const m of [this.taaMat, this.compMat, this.ssrMat, this.copyMat]) m.dispose();
    this.quad.dispose();
  }
}
