import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { AO_UPSAMPLE_GLSL, type AOPass, type DepthTap } from './post/ao';
import type { BloomPass } from './post/bloom';
import type { DofPass } from './post/dof';
import { LUT_GLSL, type GradeLut } from './post/grade';
import { PACK_GLSL, VIEWPOS_GLSL } from './post/util';

/**
 * Final full-screen pass (the end of the HDR chain, see post/chain.ts):
 *
 *   heat haze / shockwave refraction -> anti-aliasing (FXAA, or a clamped
 *   sharpen after ultra's TAA) -> lateral chromatic aberration at the screen
 *   edges -> ambient occlusion (bilateral upsample of post/ao.ts) -> god rays
 *   -> bloom (+ lens dirt and anamorphic streak for very bright sources)
 *   -> exposure + filmic tone mapping (AgX with a gentle "punchy" look, or
 *   the ACES fit) -> 3D LUT colour grade (post/grade.ts, time of day and
 *   weather) -> vignette -> temporal film grain -> dither.
 *
 * Everything is one pass whatever the quality: optional parts are uniform
 * branches (coherent across the screen, so nearly free when off). Low quality
 * runs only the tone map + grade (+ FXAA). The legacy grade uniforms
 * (contrast, saturation, shadow / highlight tints) are still written by
 * atmos.ts and the photo-mode snapshot; the LUT looks supersede them.
 */
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    resolution: { value: new THREE.Vector2(1, 1) },
    exposure: { value: 1.0 },
    fxaa: { value: 1 },
    /** Ultra (TAA): light unsharp mask instead of FXAA, 0 = off. */
    sharpen: { value: 0 },
    /** Legacy grade (atmos.ts writes them; superseded by the LUT). */
    contrast: { value: 1.08 },
    saturation: { value: 1.06 },
    shadowTint: { value: new THREE.Vector3(-0.012, 0.0, 0.022) },
    highTint: { value: new THREE.Vector3(0.03, 0.012, -0.03) },
    vignette: { value: 0.3 },
    tDistort: { value: null as THREE.Texture | null },
    distortOn: { value: 0 },
    tRays: { value: null as THREE.Texture | null },
    raysOn: { value: 0 },
    /** 1 = AgX (default), 0 = ACES fit. */
    tonemap: { value: 1 },
    /** Exposure trim of the AgX curve (matches the ACES fit's brightness). */
    agxExposure: { value: 1.25 },
    /** AgX look: power (contrast) and saturation in the encoded domain. */
    agxLook: { value: new THREE.Vector2(1.35, 1.2) },
    tLut: { value: null as THREE.Texture | null },
    lutOn: { value: 0 },
    tBloom: { value: null as THREE.Texture | null },
    bloomOn: { value: 0 },
    bloomStrength: { value: 0.5 },
    tBloomWide: { value: null as THREE.Texture | null },
    tDirt: { value: null as THREE.Texture | null },
    dirtAmt: { value: 0 },
    tStreak: { value: null as THREE.Texture | null },
    streakAmt: { value: 0 },
    tDepth: { value: null as THREE.Texture | null },
    projInv: { value: new THREE.Matrix4() },
    tAO: { value: null as THREE.Texture | null },
    aoSize: { value: new THREE.Vector2(1, 1) },
    aoFar: { value: 400 },
    aoOn: { value: 0 },
    aoStrength: { value: 0.85 },
    dofOn: { value: 0 },
    caAmt: { value: 0 },
    grain: { value: 0 },
    frame: { value: 0 },
    /** Debug view: 0 = off, 1 = ambient occlusion only, 2 = bloom only. */
    debugView: { value: 0 },
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
    uniform float vignette;
    uniform sampler2D tDistort;
    uniform float distortOn;
    uniform sampler2D tRays;
    uniform float raysOn;
    uniform float tonemap;
    uniform float agxExposure;
    uniform vec2 agxLook;
    uniform float lutOn;
    uniform sampler2D tBloom;
    uniform float bloomOn;
    uniform float bloomStrength;
    uniform sampler2D tBloomWide;
    uniform sampler2D tDirt;
    uniform float dirtAmt;
    uniform sampler2D tStreak;
    uniform float streakAmt;
    uniform float aoOn;
    uniform float aoStrength;
    uniform float dofOn;
    uniform float caAmt;
    uniform float grain;
    uniform float frame;
    uniform float debugView;
    varying vec2 vUv;
    ${VIEWPOS_GLSL}
    ${PACK_GLSL}
    ${AO_UPSAMPLE_GLSL}
    ${LUT_GLSL}

    const vec3 LUMA = vec3( 0.2126, 0.7152, 0.0722 );
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

    // ---- tone mapping: both return display-encoded values (gamma 2.2) for the LUT
    vec3 RRTAndODTFit( vec3 v ) {
      vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
      vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
      return a / b;
    }
    vec3 acesEnc( vec3 color ) {
      const mat3 ACESInputMat = mat3( vec3( 0.59719, 0.07600, 0.02840 ), vec3( 0.35458, 0.90834, 0.13383 ), vec3( 0.04823, 0.01566, 0.83777 ) );
      const mat3 ACESOutputMat = mat3( vec3( 1.60475, -0.10208, -0.00327 ), vec3( -0.53108, 1.10813, -0.07276 ), vec3( -0.07367, -0.00605, 1.07602 ) );
      color = ACESOutputMat * RRTAndODTFit( ACESInputMat * ( color / 0.6 ) );
      return pow( clamp( color, 0.0, 1.0 ), vec3( 1.0 / 2.2 ) );
    }
    // AgX (Sobotka; Filament / three.js constants) with a mild punchy look
    const mat3 PP_SRGB_TO_REC2020 = mat3( vec3( 0.6274, 0.0691, 0.0164 ), vec3( 0.3293, 0.9195, 0.0880 ), vec3( 0.0433, 0.0113, 0.8956 ) );
    const mat3 PP_REC2020_TO_SRGB = mat3( vec3( 1.6605, -0.1246, -0.0182 ), vec3( -0.5876, 1.1329, -0.1006 ), vec3( -0.0728, -0.0083, 1.1187 ) );
    vec3 agxContrast( vec3 x ) {
      vec3 x2 = x * x;
      vec3 x4 = x2 * x2;
      return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
    }
    vec3 agxEnc( vec3 color ) {
      const mat3 AgXInset = mat3( vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ), vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ), vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 ) );
      const mat3 AgXOutset = mat3( vec3( 1.1271005818144368, -0.1413297634984383, -0.14132976349843826 ), vec3( -0.11060664309660323, 1.157823702216272, -0.11060664309660294 ), vec3( -0.016493938717834573, -0.016493938717834257, 1.2519364065950405 ) );
      const float AgxMinEv = -12.47393;
      const float AgxMaxEv = 4.026069;
      color = AgXInset * ( PP_SRGB_TO_REC2020 * ( color * agxExposure ) );
      color = clamp( ( log2( max( color, 1e-10 ) ) - AgxMinEv ) / ( AgxMaxEv - AgxMinEv ), 0.0, 1.0 );
      color = agxContrast( color );
      // look (encoded domain): power = contrast, then saturation around luma
      color = pow( max( color, 0.0 ), vec3( agxLook.x ) );
      float l = dot( color, LUMA );
      color = l + agxLook.y * ( color - l );
      color = AgXOutset * color;
      color = PP_REC2020_TO_SRGB * pow( max( color, 0.0 ), vec3( 2.2 ) );
      return pow( clamp( color, 0.0, 1.0 ), vec3( 1.0 / 2.2 ) );
    }
    vec3 toSRGB( vec3 c ) {
      return mix( c * 12.92, 1.055 * pow( c, vec3( 0.41666 ) ) - 0.055, step( 0.0031308, c ) );
    }
    uvec3 pcg3d( uvec3 v ) {
      v = v * 1664525u + 1013904223u;
      v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
      v ^= v >> 16u;
      v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
      return v;
    }

    void main() {
      // heat haze / shockwave refraction (UV offsets from a low-res distortion buffer)
      vec2 uv = vUv;
      if ( distortOn > 0.5 ) {
        // (a NaN / Inf offset would send every pixel's lookup to one corner: a uniformly dark frame)
        vec2 off = texture2D( tDistort, vUv ).rg;
        if ( !any( isnan( off ) ) && !any( isinf( off ) ) ) uv = clamp( uv + clamp( off, vec2( -0.08 ), vec2( 0.08 ) ), vec2( 0.001 ), vec2( 0.999 ) );
      }
      vec3 c = sampleAA( uv );
      // lateral chromatic aberration: the outer edge of the frame only
      if ( caAmt > 0.0 ) {
        vec2 d = uv - 0.5;
        float e = smoothstep( 0.1, 0.5, dot( d, d ) );
        if ( e > 0.0 ) {
          vec2 o = d * ( caAmt * e );
          c.r = texture2D( tDiffuse, uv + o ).r;
          c.b = texture2D( tDiffuse, uv - o ).b;
        }
      }
      // ambient occlusion (emissive light and lamps are spared; faded where the depth of field blurs)
      if ( aoOn > 0.5 ) {
        float k = aoStrength * ( 1.0 - smoothstep( 1.2, 4.0, max( c.r, max( c.g, c.b ) ) * exposure ) );
        if ( dofOn > 0.5 ) k *= 1.0 - texture2D( tDiffuse, uv ).a;
        float ao = aoAt( gl_FragCoord.xy, vUv );
        if ( isnan( ao ) || isinf( ao ) ) ao = 1.0;
        if ( debugView == 1.0 ) { gl_FragColor = vec4( vec3( ao ), 1.0 ); return; }
        c *= mix( 1.0, ao, k );
      }
      // crepuscular light / shadow shafts through smoke (signed, linear HDR; see fx/godrays.ts)
      if ( raysOn > 0.5 ) {
        vec3 ry = texture2D( tRays, uv ).rgb;
        if ( !any( isnan( ry ) ) && !any( isinf( ry ) ) ) c = max( c + ry * ( 0.35 + 0.65 * min( vec3( 1.0 ), c * 4.0 ) ), vec3( 0.0 ) );
      }
      // bloom (normalised mip chain, post/bloom.ts) + lens extras
      // hard guard: a NaN / Inf pixel stays one pixel (it never spreads through the bloom / AO into a black frame)
      if ( any( isnan( c ) ) ) c = vec3( 0.0 );
      vec3 sc = c;
      if ( bloomOn > 0.5 ) {
        vec3 bl = texture2D( tBloom, uv ).rgb;
        if ( !any( isnan( bl ) ) && !any( isinf( bl ) ) ) c += bl * bloomStrength;
        if ( debugView == 2.0 ) c = texture2D( tBloom, uv ).rgb * bloomStrength;
        if ( dirtAmt > 0.0 ) c += texture2D( tBloomWide, uv ).rgb * texture2D( tDirt, vUv ).rgb * dirtAmt;
        if ( streakAmt > 0.0 ) c += texture2D( tStreak, uv ).rgb * ( streakAmt * vec3( 0.8, 0.92, 1.15 ) );
        if ( any( isnan( c ) ) ) c = sc;
      }
      c *= clamp( exposure, 0.25, 4.0 );
      c = tonemap > 0.5 ? agxEnc( c ) : acesEnc( c );
      c = lutOn > 0.5 ? applyLut( c ) : toSRGB( pow( c, vec3( 2.2 ) ) );
      // vignette: soft, keeps the middle of the battlefield untouched
      vec2 q = vUv - 0.5;
      c *= 1.0 - vignette * 0.62 * smoothstep( 0.06, 0.5, dot( q, q ) );
      // temporal film grain (integer hash: stable on mobile GPUs), strongest in the mid-tones + triangular dither
      vec3 h = vec3( pcg3d( uvec3( uvec2( gl_FragCoord.xy ), uint( frame ) ) ) ) * ( 1.0 / 4294967295.0 );
      float l = dot( c, LUMA );
      c += ( h.x - 0.5 ) * grain * ( 0.3 + 2.8 * l * ( 1.0 - l ) );
      c += ( h.y + h.z - 1.0 ) / 255.0;
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
  /** Chain inputs (post/chain.ts); each is read only while its pass ran this frame. */
  bloom: BloomPass | null = null;
  ao: AOPass | null = null;
  depth: DepthTap | null = null;
  dof: DofPass | null = null;
  lut: GradeLut | null = null;
  /** Scene camera (AO upsample depth reconstruction). */
  camera: THREE.Camera | null = null;
  /** Lens extras (chromatic aberration, dirt, streak) and grain levels. */
  ca = 0;
  dirt = 0;
  streak = 0;
  grainAmt = 0;
  private material: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  private frameNo = 0;

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
    const u = this.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    // hard guard: a NaN exposure would black out the whole frame
    if (!Number.isFinite(u.exposure.value)) u.exposure.value = 1.2;
    const d = this.haze ? this.haze.render(renderer) : null;
    u.tDistort.value = d;
    u.distortOn.value = d ? 1 : 0;
    const r = this.rays ? this.rays.render(renderer) : null;
    u.tRays.value = r;
    u.raysOn.value = r ? 1 : 0;
    // bloom + lens extras
    const b = this.bloom;
    const bloomOn = !!b && b.enabled && !!b.texture;
    u.bloomOn.value = bloomOn ? 1 : 0;
    if (bloomOn) {
      u.tBloom.value = b.texture;
      // UnrealBloomPass-scale strength (atmos.ts presets) -> share of the normalised blur added back
      u.bloomStrength.value = Number.isFinite(b.strength) ? Math.min(3, Math.max(0, b.strength)) * 1.15 : 0.5;
      u.tBloomWide.value = b.wide;
      u.dirtAmt.value = b.wide ? this.dirt * b.strength : 0;
      u.tStreak.value = b.streak;
      u.streakAmt.value = b.streak ? this.streak : 0;
      b.exposure = u.exposure.value;
    }
    // ambient occlusion (bilateral upsample needs this frame's scene depth)
    const ao = this.ao;
    const depth = this.depth?.texture ?? null;
    const aoOn = !!ao && ao.enabled && !!ao.texture && !!depth;
    u.aoOn.value = aoOn ? 1 : 0;
    if (aoOn) {
      u.tAO.value = ao.texture;
      ao.sizeInto(u.aoSize.value);
      u.aoFar.value = ao.far;
      u.aoStrength.value = ao.intensity;
      u.tDepth.value = depth;
      if (this.camera) u.projInv.value.copy(this.camera.projectionMatrixInverse);
    }
    u.dofOn.value = this.dof && this.dof.enabled ? 1 : 0;
    // grade
    u.tLut.value = this.lut ? this.lut.texture : null;
    u.lutOn.value = this.lut ? 1 : 0;
    u.caAmt.value = this.ca;
    u.grain.value = this.grainAmt;
    this.frameNo = (this.frameNo + 1) % 65536;
    u.frame.value = this.frameNo;
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
