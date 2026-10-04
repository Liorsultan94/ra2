import * as THREE from 'three';
import { hash2 } from '../sim/rng';
import { CLOUD, CLOUD_LIGHT_GLSL, CLOUD_SHADOW_GLSL } from './cloudshadow';
import { MIST_GLSL, WX, WX_PARS, WX_SURFACE, WXM } from './wxuniforms';

/** Tileable 4-channel value-noise fbm texture (each channel an independent field). */
function makeNoiseTexture(size = 128): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const noise = (x: number, y: number, period: number, seed: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = smooth(x - xi);
    const yf = smooth(y - yi);
    const p = (v: number) => ((v % period) + period) % period;
    const a = hash2(p(xi), p(yi), seed);
    const b = hash2(p(xi + 1), p(yi), seed);
    const c = hash2(p(xi), p(yi + 1), seed);
    const d = hash2(p(xi + 1), p(yi + 1), seed);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      for (let ch = 0; ch < 4; ch++) {
        let sum = 0;
        let amp = 0.5;
        let norm = 0;
        let period = 4 + ch * 2;
        for (let o = 0; o < 4; o++) {
          sum += noise((x / size) * period, (y / size) * period, period, 101 + ch * 31 + o * 7) * amp;
          norm += amp;
          amp *= 0.5;
          period *= 2;
        }
        data[(y * size + x) * 4 + ch] = Math.round((sum / norm) * 255);
      }
    }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

let sharedNoise: THREE.DataTexture | null = null;
export function noiseTexture(): THREE.DataTexture {
  return (sharedNoise ??= makeNoiseTexture());
}

/**
 * GLSL shared by every fog-patched material. Expects the uniforms of
 * `FogOfWar.uniforms` and a world-space position. Other shaders (water,
 * decals) can include it to get the same shroud look:
 *   col = fogShade(col, worldPos);
 */
export const FOG_GLSL = /* glsl */ `
uniform sampler2D fogTex;
uniform sampler2D fogNoise;
uniform vec2 fogSize;
uniform float fogEnabled;
uniform float fogTime;
uniform vec3 fogTarget;
uniform vec3 fogView;
uniform vec3 hazeColor;
uniform vec4 hazeParams;
// unexplored cloud sea: lit tops / deep gaps (follow the key and sky light), sun direction on the ground
uniform vec3 shroudLit;
uniform vec3 shroudShade;
uniform vec2 shroudSun;
// physical sky horizon (sky.ts): rgb towards / away from the sun, skyHorA.a = how much the far
// outskirts melt into it (free cameras that see the horizon; 0 = the classic dark surround)
uniform vec4 skyHorA;
uniform vec4 skyHorB;
uniform vec2 skySunXZ;
${MIST_GLSL}
${CLOUD_SHADOW_GLSL}

// fog texture through a cubic B-spline (4 bilinear taps): smooth round contours, no tile diamonds
float fogTexSmooth( vec2 q ) {
  vec2 st = q - 0.5;
  vec2 i = floor( st );
  vec2 f = st - i;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = ( 1.0 - 3.0 * f + 3.0 * f2 - f3 ) / 6.0;
  vec2 w1 = ( 4.0 - 6.0 * f2 + 3.0 * f3 ) / 6.0;
  vec2 w2 = ( 1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3 ) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;
  vec2 p0 = ( i - 0.5 + w1 / g0 ) / fogSize;
  vec2 p1 = ( i + 1.5 + w3 / g1 ) / fogSize;
  return g0.y * ( g0.x * texture2D( fogTex, p0 ).r + g1.x * texture2D( fogTex, vec2( p1.x, p0.y ) ).r )
       + g1.y * ( g0.x * texture2D( fogTex, vec2( p0.x, p1.y ) ).r + g1.x * texture2D( fogTex, p1 ).r );
}

// 0 = unexplored, 0.5 = explored, 1 = visible; edges are wobbled by slowly drifting noise
float fogSample( vec3 p ) {
  vec4 n = texture2D( fogNoise, p.xz * 0.045 + vec2( fogTime * 0.006, fogTime * 0.004 ) );
  vec2 q = p.xz + ( n.rg - 0.5 ) * 2.2;
  return fogTexSmooth( q );
}

// unexplored: a slowly drifting, self-shadowed cloud sea. s = ground-plane coordinates along the
// view ray (screen-stable: tall things in the shroud show the same cloud as the ground behind them)
vec3 shroudCloud( vec2 s, out float n ) {
  vec2 w1 = vec2( fogTime * 0.0042, -fogTime * 0.0027 );
  vec2 w2 = vec2( -fogTime * 0.0061, fogTime * 0.0036 );
  vec4 a = texture2D( fogNoise, s * 0.017 + w1 );
  // domain warp by the big layer: curling, organic billows instead of plain value noise
  vec2 sw = s + ( a.rg - 0.5 ) * 9.0;
  float b = texture2D( fogNoise, sw * 0.046 + w2 ).b;
  float c = texture2D( fogNoise, sw * 0.125 - w1 * 2.0 ).g;
  n = a.a * 0.5 + b * 0.34 + c * 0.16;
  // self-shadowing: the puffs a little further towards the sun (lit on the sun side, shaded behind)
  float bs = texture2D( fogNoise, ( sw + shroudSun * 2.4 ) * 0.046 + w2 ).b;
  float h = smoothstep( 0.3, 0.74, n );
  float lit = clamp( 0.5 + ( b - bs ) * 3.4 + ( h - 0.5 ) * 0.55, 0.0, 1.0 );
  return mix( shroudShade, shroudLit, lit * ( 0.3 + 0.7 * h ) ) * ( 0.82 + 0.3 * c );
}

vec3 fogShade( vec3 col, vec3 p ) {
  // aerial perspective: things further from the camera fade into the haze
  float depth = dot( p - fogTarget, fogView );
  vec2 o = max( -p.xz, p.xz - fogSize );
  float outside = length( max( o, 0.0 ) );
  float haze = clamp( ( depth - hazeParams.x ) / ( hazeParams.y - hazeParams.x ), 0.0, 1.0 ) * hazeParams.z;
  haze = max( haze, smoothstep( 6.0, hazeParams.w, outside ) * 0.7 );
  col = mix( col, hazeColor, haze );
  // low ground fog / valley mist (wxuniforms.ts; zero = skipped)
  col = mistShade( col, p );
  col *= 1.0 - smoothstep( hazeParams.w * 0.6, hazeParams.w * 1.6, outside ) * 0.55 * ( 1.0 - skyHorA.a );
  if ( skyHorA.a > 0.0 ) {
    vec2 vd = normalize( p.xz - cameraPosition.xz + 1e-4 );
    vec3 hz = mix( skyHorB.rgb, skyHorA.rgb, dot( vd, skySunXZ ) * 0.5 + 0.5 );
    col = mix( col, hz, skyHorA.a * smoothstep( 4.0, hazeParams.w * 1.5, outside ) * 0.92 );
  }
  if ( fogEnabled > 0.5 ) {
    float v = fogSample( p );
    float vis = smoothstep( 0.56, 0.92, v );
    // explored but not seen right now: a desaturated, cool "recon map" print of the land
    if ( vis < 0.999 ) {
      float l = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
      vec3 recon = mix( vec3( l ), col, 0.22 ) * vec3( 0.74, 0.82, 0.94 ) * 0.78 + vec3( 0.004, 0.006, 0.011 );
      col = mix( recon, col, vis );
    }
    float e = clamp( v * 2.04, 0.0, 1.0 );
    if ( e < 0.985 ) {
      vec2 s = p.xz - p.y * fogView.xz / fogView.y;
      float n;
      vec3 cloud = shroudCloud( s, n );
      // the cloud front: thin parts of the billows open first as land is explored, the thick ones last
      float x = ( 1.0 - e ) * ( 0.7 + 0.6 * n );
      float cov = smoothstep( 0.3, 0.62, x );
      float halo = smoothstep( 0.05, 0.42, x );
      // the bank darkens the land just outside it (shadow / occlusion) and its thin edge catches the light
      col *= 1.0 - 0.42 * halo * ( 1.0 - cov );
      cloud += shroudLit * 0.5 * cov * ( 1.0 - cov ) * smoothstep( 0.4, 0.75, n );
      col = mix( col, cloud, cov );
    }
  }
  return col;
}
`;

/**
 * Fog of war is a small W x H texture (0 = unexplored, ~0.5 = explored,
 * 1 = visible) sampled in world space by every lit material via a shader
 * patch. The same patch adds drifting cloud shadows, aerial haze and the
 * fade-out of the outskirts beyond the map edge.
 */
export class FogOfWar {
  readonly texture: THREE.DataTexture;
  readonly uniforms: {
    fogTex: { value: THREE.Texture };
    fogNoise: { value: THREE.Texture };
    fogSize: { value: THREE.Vector2 };
    fogEnabled: { value: number };
    fogTime: { value: number };
    fogTarget: { value: THREE.Vector3 };
    fogView: { value: THREE.Vector3 };
    hazeColor: { value: THREE.Color };
    hazeParams: { value: THREE.Vector4 };
    cloudAmount: { value: number };
    skyHorA: { value: THREE.Vector4 };
    skyHorB: { value: THREE.Vector4 };
    skySunXZ: { value: THREE.Vector2 };
    shroudLit: { value: THREE.Color };
    shroudShade: { value: THREE.Color };
    shroudSun: { value: THREE.Vector2 };
  } & typeof WXM &
    typeof CLOUD;
  private data: Uint8Array;
  private cur: Float32Array;

  constructor(
    private w: number,
    private h: number,
  ) {
    this.data = new Uint8Array(w * h);
    this.cur = new Float32Array(w * h);
    this.texture = new THREE.DataTexture(this.data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.needsUpdate = true;
    this.uniforms = {
      fogTex: { value: this.texture },
      fogNoise: { value: noiseTexture() },
      fogSize: { value: new THREE.Vector2(w, h) },
      fogEnabled: { value: 1 },
      fogTime: { value: 0 },
      fogTarget: { value: new THREE.Vector3(w / 2, 0, h / 2) },
      fogView: { value: new THREE.Vector3(-1, -1, -1).normalize() },
      hazeColor: { value: new THREE.Color(0.3, 0.29, 0.27) },
      // depth haze start/end (world units past the view centre), max amount, outskirts fade distance
      hazeParams: { value: new THREE.Vector4(4, 80, 0.38, 52) },
      cloudAmount: { value: 0.32 },
      skyHorA: { value: new THREE.Vector4(0, 0, 0, 0) },
      skyHorB: { value: new THREE.Vector4(0, 0, 0, 0) },
      skySunXZ: { value: new THREE.Vector2(1, 0) },
      shroudLit: { value: new THREE.Color(0.27, 0.28, 0.3) },
      shroudShade: { value: new THREE.Color(0.045, 0.05, 0.058) },
      shroudSun: { value: new THREE.Vector2(-0.7, -0.7) },
      // cloud shadows (shared objects: cloudshadow.ts drives them)
      ...CLOUD,
      // ground fog / mist (shared objects: the atmosphere drives them)
      ...WXM,
    };
  }

  update(explored: Uint8Array, visible: Uint8Array, dt: number, snap = false) {
    const k = snap ? 1 : Math.min(1, dt * 5);
    // the cloud over newly explored land rolls back over ~0.8 s (render only: the sim's visibility is instant)
    const open = snap ? 1 : dt * 0.62;
    const n = this.w * this.h;
    for (let i = 0; i < n; i++) {
      const target = visible[i] ? 1 : explored[i] ? 0.5 : 0;
      let c = this.cur[i];
      if (c < 0.5 && target > c) c = Math.min(target, c + open);
      else c += (target - c) * k;
      this.cur[i] = c;
      this.data[i] = (c * 255) | 0;
    }
    this.texture.needsUpdate = true;
  }

  private lum = (c: THREE.Color) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
  /**
   * Per frame: light the unexplored cloud sea with the scene's key and sky light (time of day,
   * weather), lit from `sunDir` (towards the light, world space).
   */
  setLight(sun: THREE.DirectionalLight, hemi: THREE.HemisphereLight, sunDir: THREE.Vector3) {
    const u = this.uniforms;
    const si = sun.intensity;
    const hi = hemi.intensity;
    // keep it a mid-dark grey-blue sea: never brighter than the battlefield, never a black hole
    u.shroudLit.value.copy(sun.color).multiplyScalar(si * 0.072).add(this.tmpC.copy(hemi.color).multiplyScalar(hi * 0.13));
    const l = this.lum(u.shroudLit.value);
    if (l > 0.3) u.shroudLit.value.multiplyScalar(0.3 / l);
    u.shroudShade.value.copy(hemi.color).multiplyScalar(hi * 0.06).lerp(this.tmpC.copy(hemi.groundColor).multiplyScalar(hi * 0.1), 0.35);
    u.shroudShade.value.r += 0.008;
    u.shroudShade.value.g += 0.009;
    u.shroudShade.value.b += 0.012;
    const h = Math.hypot(sunDir.x, sunDir.z) || 1;
    u.shroudSun.value.set(sunDir.x / h, sunDir.z / h);
  }
  private tmpC = new THREE.Color();

  revealAll() {
    this.cur.fill(1);
    this.data.fill(255);
    this.texture.needsUpdate = true;
  }

  /** Patch a built-in material so it darkens under the shroud. */
  /**
   * Upgrade a custom ShaderMaterial that still uses the old flat-darkening
   * fog block (`float fogV = ...; float fogK = ...; col *= mix(...)`) to the
   * shared smoky shroud / haze look, in place. Returns false if the shader
   * doesn't have the expected shape (it is then left untouched).
   */
  upgradeShader(mat: THREE.ShaderMaterial): boolean {
    if (mat.userData.fogUpgraded) return true;
    const fsrc = mat.fragmentShader;
    const block = /float fogV = texture2D\(fogTex[^;]*;\s*float fogK[^;]*;\s*col \*= mix\(1\.0, fogK, fogEnabled\);/;
    if (!block.test(fsrc) || !fsrc.includes('varying vec3 vWorld;')) return false;
    mat.fragmentShader = fsrc
      .replace(/uniform sampler2D fogTex;\s*/, '')
      .replace(/uniform vec2 fogSize;\s*/, '')
      .replace(/uniform float fogEnabled;\s*/, '')
      .replace('varying vec3 vWorld;', `varying vec3 vWorld;\n${FOG_GLSL}`)
      .replace(block, 'col = fogShade(col, vWorld);');
    Object.assign(mat.uniforms, this.uniforms);
    mat.userData.fogUpgraded = true;
    mat.needsUpdate = true;
    return true;
  }

  apply<T extends THREE.Material>(mat: T): T {
    const uniforms = this.uniforms;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
      prev.call(mat, shader, renderer);
      Object.assign(shader.uniforms, uniforms, WX);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFogP;')
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
          vec4 fogWp = vec4( transformed, 1.0 );
          #ifdef USE_INSTANCING
            fogWp = instanceMatrix * fogWp;
          #endif
          fogWp = modelMatrix * fogWp;
          vFogP = fogWp.xyz;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vFogP;\n${FOG_GLSL}\n${WX_PARS}`)
        // weather: snow cover / wet / dust on upward-facing surfaces (all zero = untouched)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${WX_SURFACE}`)
        // cloud shadows (+ canopy sun flecks) on the direct light: cloudshadow.ts
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${CLOUD_LIGHT_GLSL}`)
        .replace(
          '#include <opaque_fragment>',
          `outgoingLight = fogShade( outgoingLight, vFogP );
          #include <opaque_fragment>`,
        );
    };
    mat.customProgramCacheKey = () => 'fog2';
    return mat;
  }
}
