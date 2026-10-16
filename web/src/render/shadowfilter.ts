import * as THREE from 'three';

/*
 * Sun shadow filtering (GD5): three's PCF shadow (5 hardware-filtered Vogel
 * disk taps) turns its disk by interleaved gradient noise of the SCREEN pixel.
 * That noise stays put on the screen while the world moves under it, so
 * when the camera pans the dithered penumbra crawls along every shadow edge
 * (the shadow map itself is texel-snapped and steady: renderer fitShadow).
 *
 *  - The disk now turns by the noise of the SHADOW MAP cell under the pixel
 *    (world-anchored: it moves with the shadow, no crawl while panning). The
 *    cell is half a shadow texel where texels are big on screen (phones,
 *    medium: 1024 map) and one texel on high.
 *  - High (desk) takes 12 taps instead of 5 over a slightly wider disk: a
 *    smoother, softer penumbra with no visible dither.
 *
 * The chunk is global (one quality per page); it is patched before the first
 * program compiles. Low has no shadows.
 */

let original: string | null = null;

const ROT_SRC = 'float phi = interleavedGradientNoise( gl_FragCoord.xy ) * PI2;';
const TAPS_SRC = `shadow = (
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 0, 5, phi ) * radius, shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 1, 5, phi ) * radius, shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 2, 5, phi ) * radius, shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 3, 5, phi ) * radius, shadowCoord.z ) ) +
					texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( 4, 5, phi ) * radius, shadowCoord.z ) )
				) * 0.2;`;

/** Taps / disk scale / noise cells per shadow texel of a quality level. */
export function shadowFilter(quality: 'low' | 'medium' | 'high'): { taps: number; radiusK: number; cells: number } {
  return quality === 'high' ? { taps: 12, radiusK: 1.25, cells: 1 } : { taps: 5, radiusK: 1, cells: 2 };
}

/** Patch three's PCF shadow chunk for this page's quality (idempotent; false = the chunk did not match). */
export function installShadowFilter(quality: 'low' | 'medium' | 'high'): boolean {
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  original ??= C.shadowmap_pars_fragment;
  const src = original;
  if (!src.includes(ROT_SRC) || !src.includes(TAPS_SRC)) return false;
  const f = shadowFilter(quality);
  let taps = 'shadow = 0.0;\n';
  for (let i = 0; i < f.taps; i++) taps += `\t\t\t\tshadow += texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( ${i}, ${f.taps}, phi ) * radius, shadowCoord.z ) );\n`;
  taps += `\t\t\t\tshadow *= ${(1 / f.taps).toFixed(6)};`;
  C.shadowmap_pars_fragment = src
    .replace(ROT_SRC, `float phi = interleavedGradientNoise( floor( shadowCoord.xy * shadowMapSize * ${f.cells.toFixed(1)} ) ) * PI2;\n\t\t\t\tradius *= ${f.radiusK.toFixed(3)};`)
    .replace(TAPS_SRC, taps);
  return true;
}
