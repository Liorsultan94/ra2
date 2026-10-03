import * as THREE from 'three';
import type { FogOfWar } from '../fog';

/*
 * The shared material of the landmarks, trains, boats and civilian aircraft:
 * vertex colours plus a per vertex glow code (models/landmarks.ts) for lit
 * windows, procedural tower facades, lamps and warning paint at night.
 * One program for all of them.
 */

/** 0 = day .. 1 = night (set every frame by the landmarks). */
export const LM_NIGHT = { value: 0 };

const cache = new WeakMap<FogOfWar, THREE.MeshStandardMaterial>();

export function landmarkMaterial(fog: FogOfWar): THREE.MeshStandardMaterial {
  const cached = cache.get(fog);
  if (cached) return cached;
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.05 });
  const night = LM_NIGHT;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.lmNight = night;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vLmGlow;\nvarying vec3 vLmN;')
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
        vLmGlow = aGlow;
        vLmN = normalize( mat3( modelMatrix ) * objectNormal );`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float lmNight;\nvarying float vLmGlow;\nvarying vec3 vLmN;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float lmWin = 0.0;
        float lmLit = 0.0;
        if ( vLmGlow > 1.5 && vLmGlow < 2.5 ) {
          // glass / office facade: a grid of windows on the walls (world space, so it never stretches)
          vec2 q = abs( vLmN.x ) > 0.5 ? vec2( vFogP.z, vFogP.y ) : vec2( vFogP.x, vFogP.y );
          vec2 cell = q * vec2( 4.2, 5.2 );
          vec2 f = fract( cell );
          lmWin = step( 0.16, f.x ) * step( f.x, 0.84 ) * step( 0.22, f.y ) * step( f.y, 0.78 ) * ( 1.0 - step( 0.5, abs( vLmN.y ) ) );
          lmLit = step( 0.5, fract( sin( dot( floor( cell ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) );
          diffuseColor.rgb *= 1.0 - lmWin * 0.42;
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec3 lmC = vColor.rgb;
          if ( vLmGlow > 0.5 && vLmGlow < 1.5 ) totalEmissiveRadiance += lmC * lmNight * 1.5;
          else if ( vLmGlow > 1.5 && vLmGlow < 2.5 ) totalEmissiveRadiance += lmWin * lmLit * lmNight * vec3( 1.0, 0.78, 0.48 ) * 1.1;
          else if ( vLmGlow > 2.5 && vLmGlow < 3.5 ) totalEmissiveRadiance += lmC * ( 0.25 + lmNight * 1.2 );
          else if ( vLmGlow > 3.5 ) totalEmissiveRadiance += lmC * lmNight * 0.2;
        }`,
      );
  };
  fog.apply(mat);
  mat.customProgramCacheKey = () => 'fog2-landmarks';
  cache.set(fog, mat);
  return mat;
}
