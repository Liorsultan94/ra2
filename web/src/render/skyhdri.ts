import * as THREE from 'three';
import { assetBase, fetchBitmap } from './photoground';
import { PHOTO_HDRIS } from './terrainset';

/*
 * Photographed sky HDRIs for the high quality environment capture (sky.ts).
 *
 * Three small CC0 HDRIs from Poly Haven (clear midday, overcast, low sun;
 * 512 x 256 RGBE in lossless WebP, baked by tools/bake-terrain.mjs with the
 * sun clamped out - the directional light is the sun) are blended by the
 * time of day and the cloud cover and turned so their sun sits at the game's
 * sun azimuth. They never replace the physical sky: the capture keeps its
 * colour and brightness, and the photographs only add their structure - the
 * cloud detail, the brighter band around the sun, real horizon silhouettes
 * and the texture of the ground bounce - to the specular reflections and the
 * ambient light. The visible sky dome stays sky.ts.
 */

const KEYS = ['clear', 'overcast', 'sunset'] as const;

export class SkyHdri {
  readonly uniforms = {
    uHdri0: { value: null as THREE.Texture | null },
    uHdri1: { value: null as THREE.Texture | null },
    uHdri2: { value: null as THREE.Texture | null },
    /** Blend weights of the three. */
    uHdriW: { value: new THREE.Vector3(1, 0, 0) },
    /** Equirect u offsets that put each HDRI's sun at the game's sun azimuth. */
    uHdriRot: { value: new THREE.Vector3() },
    /** Mean of the blended HDRIs over the sky / the ground hemisphere (linear). */
    uHdriSkyM: { value: new THREE.Vector3(1, 1, 1) },
    uHdriGndM: { value: new THREE.Vector3(1, 1, 1) },
    /** Strength (0 until loaded). */
    uHdriK: { value: 0 },
  };
  ready = false;
  private key = '';

  constructor(onReady: () => void) {
    const dir = `${assetBase()}tex/hdri/`;
    void Promise.all(KEYS.map((k) => fetchBitmap(`${dir}${k}.webp`)))
      .then((bmps) => {
        bmps.forEach((b, i) => {
          const t = new THREE.Texture(b as unknown as HTMLImageElement);
          t.flipY = false;
          t.premultiplyAlpha = false;
          t.colorSpace = THREE.NoColorSpace;
          // RGBE must not be filtered across texels with different exponents
          t.magFilter = t.minFilter = THREE.NearestFilter;
          t.generateMipmaps = false;
          t.wrapS = THREE.RepeatWrapping;
          t.needsUpdate = true;
          (this.uniforms[`uHdri${i}` as 'uHdri0'].value as THREE.Texture | null) = t;
        });
        this.ready = true;
        console.info('[photo] sky HDRIs loaded');
        onReady();
      })
      .catch((e) => console.warn('[photo] sky HDRIs unavailable', e));
  }

  /** Blend weights / rotation for the current sun and weather; returns true when they changed noticeably. */
  update(sun: THREE.Vector3, cover: number, night: number): boolean {
    if (!this.ready) return false;
    const sy = sun.y;
    const low = 1 - smooth(0.1, 0.38, sy);
    const over = smooth(0.4, 0.85, cover) * (1 - low * 0.4);
    const w = [Math.max(0, 1 - low - over), over, low];
    const t = w[0] + w[1] + w[2] || 1;
    const u = this.uniforms;
    u.uHdriW.value.set(w[0] / t, w[1] / t, w[2] / t);
    const az = Math.atan2(sun.z, sun.x);
    const rot = KEYS.map((k) => ((PHOTO_HDRIS[k].sun.u - 0.5) * Math.PI * 2 - az) / (Math.PI * 2));
    u.uHdriRot.value.set(rot[0], rot[1], rot[2]);
    const sky = new THREE.Vector3();
    const gnd = new THREE.Vector3();
    KEYS.forEach((k, i) => {
      const h = PHOTO_HDRIS[k];
      const wi = u.uHdriW.value.getComponent(i);
      sky.add(new THREE.Vector3(...h.sky).multiplyScalar(wi));
      gnd.add(new THREE.Vector3(...h.ground).multiplyScalar(wi));
    });
    u.uHdriSkyM.value.copy(sky);
    u.uHdriGndM.value.copy(gnd);
    // by night the photographs (all daylight) fade out
    u.uHdriK.value = 0.75 * (1 - smooth(0.3, 0.8, night));
    const key = [w[0] / t, w[1] / t, w[2] / t, rot[0], u.uHdriK.value].map((v) => v.toFixed(2)).join();
    const changed = key !== this.key;
    this.key = key;
    return changed;
  }
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Dome shader part (environment capture only, HDRI defined): `col` = the
 * physical sky at direction `d`, `up` = d.y. The HDRIs' luminance pattern
 * relative to their own hemisphere mean modulates the sky's brightness; above
 * the horizon a little of their colour comes along (cloud whites, the warm
 * band around a low sun), below it only the pattern (the photos' green fields
 * would tint a desert or a snowfield).
 */
export const HDRI_PARS = /* glsl */ `
  uniform sampler2D uHdri0;
  uniform sampler2D uHdri1;
  uniform sampler2D uHdri2;
  uniform vec3 uHdriW;
  uniform vec3 uHdriRot;
  uniform vec3 uHdriSkyM;
  uniform vec3 uHdriGndM;
  uniform float uHdriK;
  vec3 hdriAt( sampler2D t, vec3 d, float rot ) {
    vec2 uv = vec2( atan( d.z, d.x ) * 0.15915494 + 0.5 + rot, 0.5 - asin( clamp( d.y, -1.0, 1.0 ) ) * 0.31830989 );
    vec4 e = texture2D( t, uv );
    return e.rgb * exp2( e.a * 255.0 - 136.0 );
  }
`;

export const HDRI_APPLY = /* glsl */ `
  if ( uEnv > 0.5 && uHdriK > 0.0 ) {
    vec3 hc = hdriAt( uHdri0, d, uHdriRot.x ) * uHdriW.x + hdriAt( uHdri1, d, uHdriRot.y ) * uHdriW.y + hdriAt( uHdri2, d, uHdriRot.z ) * uHdriW.z;
    vec3 hm = up >= 0.0 ? uHdriSkyM : uHdriGndM;
    float hl = dot( hc, vec3( 0.2126, 0.7152, 0.0722 ) ) / max( 1e-4, dot( hm, vec3( 0.2126, 0.7152, 0.0722 ) ) );
    vec3 hue = hc / max( 1e-4, dot( hc, vec3( 0.2126, 0.7152, 0.0722 ) ) );
    vec3 photo = col * clamp( hl, 0.0, 4.0 );
    photo = mix( photo, dot( photo, vec3( 0.2126, 0.7152, 0.0722 ) ) * hue, up >= 0.0 ? 0.35 : 0.0 );
    col = mix( col, photo, uHdriK );
  }
`;
