// The Sinai's Mediterranean coast as the map's owner drew it (sim/map.ts SeaDeco.north, topCoast), for the shaders
// that draw the sea past the map's edge (the horizon's far sheet, the battlefield water's outskirts belt).

import * as THREE from 'three';
import type { SeaDeco } from '../sim/map';

/** Samples the shaders take (the map's own are fewer; the last one carries on). */
export const NORTH_K = 48;

/** Uniforms: on, (e0, step), the samples. */
export function northUniforms(north: SeaDeco['north'] | undefined) {
  return {
    seaNorthOn: { value: north ? 1 : 0 },
    seaNorthE: { value: new THREE.Vector2(north?.e0 ?? 0, north?.step ?? 1) },
    seaNorth: { value: Array.from({ length: NORTH_K }, (_, i) => north?.off[Math.min(i, north.off.length - 1)] ?? 0) },
  };
}

/** GLSL: the uniforms and northAt(e), the coast's offset from the map centre at screen east e (as topCoast). */
export const NORTH_GLSL = /* glsl */ `
  uniform float seaNorthOn;
  uniform vec2 seaNorthE;
  uniform float seaNorth[ ${NORTH_K} ];
  float northAt( float u ) {
    float f = clamp( ( u - seaNorthE.x ) / seaNorthE.y, 0.0, float( ${NORTH_K} - 1 ) - 0.0001 );
    int i = int( floor( f ) );
    float t = f - float( i );
    return mix( seaNorth[ i ], seaNorth[ i + 1 ], t ) - ( 0.9 * sin( u * 0.23 + 0.4 ) + 0.55 * sin( u * 0.57 + 1.9 ) + 0.3 * sin( u * 1.31 ) );
  }
`;
