import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

/**
 * Final full-screen pass: optional FXAA, filmic tone mapping (ACES fit),
 * a gentle colour grade (warm highlights / cool shadows, contrast and
 * saturation), vignette and a little dither against banding. Replaces
 * three's OutputPass + a separate vignette pass, so post costs one pass.
 */
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
    exposure: { value: 1.0 },
    fxaa: { value: 1 },
    /** Ultra (TAA): light unsharp mask instead of FXAA, 0 = off. */
    sharpen: { value: 0 },
    contrast: { value: 1.08 },
    saturation: { value: 1.06 },
    shadowTint: { value: new THREE.Vector3(-0.012, 0.0, 0.022) },
    highTint: { value: new THREE.Vector3(0.03, 0.012, -0.03) },
    vignette: { value: 0.3 },
    tDistort: { value: null as THREE.Texture | null },
    distortOn: { value: 0 },
    tRays: { value: null as THREE.Texture | null },
    raysOn: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 resolution;
    uniform float exposure;
    uniform float fxaa;
    uniform float sharpen;
    uniform float contrast;
    uniform float saturation;
    uniform vec3 shadowTint;
    uniform vec3 highTint;
    uniform float vignette;
    uniform sampler2D tDistort;
    uniform float distortOn;
    uniform sampler2D tRays;
    uniform float raysOn;
    varying vec2 vUv;

    float lumaOf( vec3 c ) { c = c / ( 1.0 + c ); return dot( c, vec3( 0.299, 0.587, 0.114 ) ); }

    // FXAA (Lottes, "PC console" flavour): 9 taps, cheap and good enough at phone densities
    vec3 sampleAA( vec2 uv ) {
      vec2 px = 1.0 / resolution;
      vec3 rgbM = texture2D( tDiffuse, uv ).rgb;
      if ( sharpen > 0.0 ) {
        // after TAA: 5-tap unsharp mask, clamped to the neighbourhood (no halos)
        vec3 n = texture2D( tDiffuse, uv + vec2( 0.0, px.y ) ).rgb;
        vec3 s = texture2D( tDiffuse, uv - vec2( 0.0, px.y ) ).rgb;
        vec3 e = texture2D( tDiffuse, uv + vec2( px.x, 0.0 ) ).rgb;
        vec3 w = texture2D( tDiffuse, uv - vec2( px.x, 0.0 ) ).rgb;
        vec3 mn = min( rgbM, min( min( n, s ), min( e, w ) ) );
        vec3 mx = max( rgbM, max( max( n, s ), max( e, w ) ) );
        return clamp( rgbM + ( 4.0 * rgbM - n - s - e - w ) * sharpen, mn, mx );
      }
      if ( fxaa < 0.5 ) return rgbM;
      vec3 rgbNW = texture2D( tDiffuse, uv + vec2( -1.0, -1.0 ) * px ).rgb;
      vec3 rgbNE = texture2D( tDiffuse, uv + vec2( 1.0, -1.0 ) * px ).rgb;
      vec3 rgbSW = texture2D( tDiffuse, uv + vec2( -1.0, 1.0 ) * px ).rgb;
      vec3 rgbSE = texture2D( tDiffuse, uv + vec2( 1.0, 1.0 ) * px ).rgb;
      float lNW = lumaOf( rgbNW ), lNE = lumaOf( rgbNE ), lSW = lumaOf( rgbSW ), lSE = lumaOf( rgbSE ), lM = lumaOf( rgbM );
      float lMin = min( lM, min( min( lNW, lNE ), min( lSW, lSE ) ) );
      float lMax = max( lM, max( max( lNW, lNE ), max( lSW, lSE ) ) );
      if ( lMax - lMin < max( 0.0312, lMax * 0.125 ) ) return rgbM;
      vec2 dir = vec2( -( ( lNW + lNE ) - ( lSW + lSE ) ), ( lNW + lSW ) - ( lNE + lSE ) );
      float dirReduce = max( ( lNW + lNE + lSW + lSE ) * 0.03125, 1.0 / 128.0 );
      float rcpDirMin = 1.0 / ( min( abs( dir.x ), abs( dir.y ) ) + dirReduce );
      dir = clamp( dir * rcpDirMin, vec2( -8.0 ), vec2( 8.0 ) ) * px;
      vec3 rgbA = 0.5 * ( texture2D( tDiffuse, uv + dir * ( 1.0 / 3.0 - 0.5 ) ).rgb + texture2D( tDiffuse, uv + dir * ( 2.0 / 3.0 - 0.5 ) ).rgb );
      vec3 rgbB = rgbA * 0.5 + 0.25 * ( texture2D( tDiffuse, uv - dir * 0.5 ).rgb + texture2D( tDiffuse, uv + dir * 0.5 ).rgb );
      float lB = lumaOf( rgbB );
      return ( lB < lMin || lB > lMax ) ? rgbA : rgbB;
    }

    // ACES fit (Stephen Hill), same curve three.js uses
    vec3 RRTAndODTFit( vec3 v ) {
      vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
      vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
      return a / b;
    }
    vec3 aces( vec3 color ) {
      const mat3 ACESInputMat = mat3( vec3( 0.59719, 0.07600, 0.02840 ), vec3( 0.35458, 0.90834, 0.13383 ), vec3( 0.04823, 0.01566, 0.83777 ) );
      const mat3 ACESOutputMat = mat3( vec3( 1.60475, -0.10208, -0.00327 ), vec3( -0.53108, 1.10813, -0.07276 ), vec3( -0.07367, -0.00605, 1.07602 ) );
      color *= exposure / 0.6;
      color = ACESInputMat * color;
      color = RRTAndODTFit( color );
      color = ACESOutputMat * color;
      return clamp( color, 0.0, 1.0 );
    }
    vec3 toSRGB( vec3 c ) {
      return mix( c * 12.92, 1.055 * pow( c, vec3( 0.41666 ) ) - 0.055, step( 0.0031308, c ) );
    }

    void main() {
      // heat haze / shockwave refraction (UV offsets from a low-res distortion buffer)
      vec2 uv = vUv;
      if ( distortOn > 0.5 ) uv = clamp( uv + texture2D( tDistort, vUv ).rg, vec2( 0.001 ), vec2( 0.999 ) );
      vec3 c = sampleAA( uv );
      // crepuscular light / shadow shafts through smoke (signed, linear HDR; see fx/godrays.ts)
      if ( raysOn > 0.5 ) c = max( c + texture2D( tRays, uv ).rgb * ( 0.35 + 0.65 * min( vec3( 1.0 ), c * 4.0 ) ), vec3( 0.0 ) );
      c = toSRGB( aces( c ) );
      float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
      // split toning: cool shadows, warm highlights
      c += shadowTint * ( 1.0 - smoothstep( 0.0, 0.5, l ) ) + highTint * smoothstep( 0.45, 1.0, l );
      // saturation and a soft S-curve contrast around mid grey
      c = mix( vec3( l ), c, saturation );
      c = clamp( c, 0.0, 1.0 );
      c = mix( c, c * c * ( 3.0 - 2.0 * c ), contrast - 1.0 );
      vec2 d = vUv - 0.5;
      c *= 1.0 - dot( d, d ) * vignette * 1.6;
      // dither
      c += ( fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) - 0.5 ) / 255.0;
      gl_FragColor = vec4( c, 1.0 );
    }`,
};

/** Source of the screen-space distortion buffer (see fx/haze.ts). */
export interface DistortionSource {
  render(renderer: THREE.WebGLRenderer): THREE.Texture | null;
  setSize(w: number, h: number): void;
}

export class FinalPass extends Pass {
  readonly uniforms: typeof FinalShader.uniforms;
  /** Optional heat haze / shockwave distortion, rendered right before the final quad. */
  haze: DistortionSource | null = null;
  /** Optional god-ray buffer (fx/godrays.ts), rendered right before the final quad. */
  rays: DistortionSource | null = null;
  private material: THREE.ShaderMaterial;
  private quad: FullScreenQuad;

  constructor() {
    super();
    this.uniforms = THREE.UniformsUtils.clone(FinalShader.uniforms) as typeof FinalShader.uniforms;
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: FinalShader.vertexShader,
      fragmentShader: FinalShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setSize(width: number, height: number) {
    this.uniforms.resolution.value.set(width, height);
    this.haze?.setSize(width, height);
    this.rays?.setSize(width, height);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    const d = this.haze ? this.haze.render(renderer) : null;
    this.uniforms.tDistort.value = d;
    this.uniforms.distortOn.value = d ? 1 : 0;
    const r = this.rays ? this.rays.render(renderer) : null;
    this.uniforms.tRays.value = r;
    this.uniforms.raysOn.value = r ? 1 : 0;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}

/**
 * Load a real CC0 HDRI (Poly Haven via @pmndrs/assets) for image based
 * lighting. Imported lazily so it is code-split and never blocks first paint.
 * The sun hot-spot is clamped away (the scene has its own sun light) so the
 * map only contributes soft sky/ground fill.
 */
export async function loadSkyEnvironment(renderer: THREE.WebGLRenderer): Promise<THREE.Texture | null> {
  try {
    const [{ default: url }, { EXRLoader }] = await Promise.all([import('@pmndrs/assets/hdri/sunrise.exr.js'), import('three/addons/loaders/EXRLoader.js')]);
    const loader = new EXRLoader();
    loader.setDataType(THREE.HalfFloatType);
    const tex = await loader.loadAsync(url);
    const img = tex.image as { data: Uint16Array; width: number; height: number };
    const d = img.data;
    const toH = THREE.DataUtils.toHalfFloat;
    const fromH = THREE.DataUtils.fromHalfFloat;
    const cap = 6;
    for (let i = 0; i < d.length; i += 4) {
      const r = fromH(d[i]);
      const g = fromH(d[i + 1]);
      const b = fromH(d[i + 2]);
      const m = Math.max(r, g, b);
      if (m > cap) {
        const k = cap / m;
        d[i] = toH(r * k);
        d[i + 1] = toH(g * k);
        d[i + 2] = toH(b * k);
      }
    }
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.needsUpdate = true;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromEquirectangular(tex).texture;
    pmrem.dispose();
    tex.dispose();
    return env;
  } catch (e) {
    console.warn('HDRI environment unavailable, keeping fallback', e);
    return null;
  }
}
