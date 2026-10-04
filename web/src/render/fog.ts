import * as THREE from 'three';
import { hash2 } from '../sim/rng';
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
uniform float cloudAmount;
// physical sky horizon (sky.ts): rgb towards / away from the sun, skyHorA.a = how much the far
// outskirts melt into it (free cameras that see the horizon; 0 = the classic dark surround)
uniform vec4 skyHorA;
uniform vec4 skyHorB;
uniform vec2 skySunXZ;
${MIST_GLSL}

// 0 = unexplored, 0.5 = explored, 1 = visible; edges are wobbled by noise
float fogSample( vec3 p ) {
  vec4 n = texture2D( fogNoise, p.xz * 0.045 + vec2( fogTime * 0.006, fogTime * 0.004 ) );
  vec2 q = p.xz + ( n.rg - 0.5 ) * 2.2;
  return texture2D( fogTex, q / fogSize ).r;
}

float cloudShadow( vec3 p ) {
  vec2 wind = vec2( 0.55, 0.22 ) * fogTime;
  float a = texture2D( fogNoise, ( p.xz + wind ) * 0.011 ).b;
  float b = texture2D( fogNoise, ( p.xz + wind * 1.4 ) * 0.027 + 0.37 ).a;
  float c = a * 0.7 + b * 0.3;
  return 1.0 - cloudAmount * smoothstep( 0.47, 0.68, c );
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
    float expl = smoothstep( 0.06, 0.4, v );
    // explored but not currently seen: desaturated, darker, slightly cool
    float l = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
    vec3 memo = mix( vec3( l ), col, 0.3 ) * vec3( 0.56, 0.59, 0.66 );
    col = mix( memo, col, vis );
    if ( expl < 0.999 ) {
      // unexplored: dark drifting smoke instead of a flat black hole
      // sample the smoke in screen-stable coordinates so trees/buildings don't show through
      vec2 s = p.xz - p.y * fogView.xz / fogView.y;
      float m1 = texture2D( fogNoise, s * 0.021 + vec2( fogTime * 0.0045, -fogTime * 0.003 ) ).a;
      float m2 = texture2D( fogNoise, s * 0.06 + vec2( -fogTime * 0.008, fogTime * 0.005 ) ).b;
      float smoke = m1 * 0.65 + m2 * 0.35;
      vec3 shroud = mix( vec3( 0.008, 0.009, 0.011 ), vec3( 0.05, 0.052, 0.058 ), smoothstep( 0.3, 0.75, smoke ) );
      // a faint warm rim where the smoke meets explored land
      shroud += vec3( 0.05, 0.035, 0.02 ) * smoothstep( 0.0, 0.5, expl ) * ( 1.0 - expl );
      col = mix( shroud, col, expl );
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
  } & typeof WXM;
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
      // ground fog / mist (shared objects: the atmosphere drives them)
      ...WXM,
    };
  }

  update(explored: Uint8Array, visible: Uint8Array, dt: number, snap = false) {
    const k = snap ? 1 : Math.min(1, dt * 5);
    const n = this.w * this.h;
    for (let i = 0; i < n; i++) {
      const target = visible[i] ? 1 : explored[i] ? 0.5 : 0;
      const c = this.cur[i] + (target - this.cur[i]) * k;
      this.cur[i] = c;
      this.data[i] = (c * 255) | 0;
    }
    this.texture.needsUpdate = true;
  }

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
        .replace(
          '#include <lights_fragment_end>',
          `#include <lights_fragment_end>
          {
            float cloudK = cloudShadow( vFogP );
            reflectedLight.directDiffuse *= cloudK;
            reflectedLight.directSpecular *= cloudK;
          }`,
        )
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
