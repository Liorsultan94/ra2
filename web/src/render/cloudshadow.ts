import * as THREE from 'three';
import type { GameMap } from '../sim/map';
import type { WxState } from './weathercycle';

/*
 * Cloud shadows: big soft shadows of the cloud deck sweeping across the map with the wind.
 *
 * One shared uniform set (CLOUD) drives a light-modulation term that every lit material picks
 * up through the fog patch (fog.ts FogOfWar.apply multiplies the direct sun light by
 * cloudShadow(p) in lights_fragment_end; the chunk lives in FOG_GLSL). The god rays pass
 * (fx/godrays.ts) samples the same field to march light shafts through the gaps.
 *
 * The field is the clouds' footprint on the ground plane: a point in the air at height y is lit
 * when the ground point the sun ray would reach (P - sunDir * y / sunDir.y) is, so the shafts
 * line up with the shadows on the ground and nothing jumps when the view (and the sun) turns.
 *
 * Driven once per frame from the atmosphere (read only): cloud cover of the dynamic weather
 * (the timeline atmos.forecast() reads) or the fixed weather, the wind, and the daylight (the
 * shadows fade out at dusk; none at night). Also: sun flecks under tree canopies (high quality).
 */

export const CLOUD = {
  /** Shadow darkness 0..1 (0 = the term is skipped). */
  csAmount: { value: 0 },
  /** Fraction of the sky covered 0..1 (more, larger shadows). */
  csCover: { value: 0.3 },
  /** Accumulated wind drift of the cloud field (world units). */
  csDrift: { value: new THREE.Vector2() },
  /** Sun direction xz / y (clamped): ground offset of the field per unit height. */
  csSunXZ: { value: new THREE.Vector2(0.5, 0.5) },
  /** God rays: strength of the shafts through the gaps 0..1 (high quality). */
  csShafts: { value: 0 },
  /** Ground height at the view centre (the shaft slab sits on it). */
  csGround: { value: 0 },
  /** Sun flecks under tree canopies 0..1 (high quality, daylight). */
  csDapple: { value: 0 },
  /** Canopy density (tree tiles) and its size. */
  csCanopy: { value: null as THREE.Texture | null },
  csMap: { value: new THREE.Vector2(1, 1) },
};

/** The cloud footprint field (needs `fogNoise` declared before it). 0 = sun, 1 = full cloud. */
export const CLOUD_COVER_GLSL = /* glsl */ `
uniform float csAmount;
uniform float csCover;
uniform vec2 csDrift;
uniform vec2 csSunXZ;
float cloudCover( vec2 xz ) {
  vec2 q = xz - csDrift;
  // big rounded banks + a rotated mid layer that slowly drifts against them + a little detail
  float a = texture2D( fogNoise, q * 0.0072 + vec2( 0.13, 0.71 ) ).b;
  float b = texture2D( fogNoise, mat2( 0.8, -0.6, 0.6, 0.8 ) * q * 0.0183 + vec2( 0.41, 0.07 ) + csDrift * 0.0011 ).a;
  float c = texture2D( fogNoise, q * 0.051 + vec2( 0.77, 0.29 ) ).g;
  float n = a * 0.6 + b * 0.3 + c * 0.1;
  // cover -> threshold (value-noise fbm is concentrated around 0.5: the band keeps the fraction honest)
  float th = mix( 0.66, 0.36, csCover );
  return smoothstep( th - 0.075, th + 0.085, n );
}
`;

/** Shadow term on lit materials (inside FOG_GLSL: fogNoise and the cover field are declared). */
export const CLOUD_SHADOW_GLSL = /* glsl */ `
${CLOUD_COVER_GLSL}
uniform float csDapple;
uniform sampler2D csCanopy;
uniform vec2 csMap;
float cloudShadow( vec3 p ) {
  if ( csAmount < 0.002 ) return 1.0;
  return 1.0 - csAmount * cloudCover( p.xz - csSunXZ * p.y );
}
// sun flecks: light through the gaps of the canopy the sun ray crosses on its way down (0..1)
float sunDapple( vec3 p ) {
  if ( csDapple < 0.002 ) return 0.0;
  vec2 cq = p.xz + csSunXZ * max( 0.0, 1.9 - p.y );
  float cv = texture2D( csCanopy, cq / csMap ).r;
  if ( cv < 0.05 ) return 0.0;
  // pinhole images of the sun: round flecks, shimmering with the leaves
  vec2 dq = cq * 1.35 + vec2( sin( fogTime * 0.9 + cq.y ) , cos( fogTime * 0.7 + cq.x ) ) * 0.05;
  float f = texture2D( fogNoise, dq ).g * 0.7 + texture2D( fogNoise, dq * 2.3 + 0.5 ).r * 0.3;
  return smoothstep( 0.6, 0.68, f ) * smoothstep( 0.05, 0.5, cv ) * csDapple;
}
`;

/**
 * Lit-material hook, inserted after `lights_fragment_end` (fog.ts): sun flecks in the canopy
 * shadows, then the cloud shadow on the direct light. `vFogP` is the world position.
 */
export const CLOUD_LIGHT_GLSL = /* glsl */ `
{
  #if NUM_DIR_LIGHTS > 0
  if ( csDapple > 0.001 ) {
    float dap = sunDapple( vFogP );
    if ( dap > 0.0 ) {
      // only inside real shadows (the tree's own shadow map): add back part of the blocked sun
      vec3 full = directionalLights[ 0 ].color * saturate( dot( normal, directionalLights[ 0 ].direction ) ) * BRDF_Lambert( diffuseColor.rgb );
      float have = dot( reflectedLight.directDiffuse, vec3( 0.3, 0.59, 0.11 ) ) / max( 1e-4, dot( full, vec3( 0.3, 0.59, 0.11 ) ) );
      reflectedLight.directDiffuse += full * dap * 0.85 * ( 1.0 - smoothstep( 0.25, 0.75, have ) );
    }
  }
  #endif
  float cloudK = cloudShadow( vFogP );
  reflectedLight.directDiffuse *= cloudK;
  reflectedLight.directSpecular *= cloudK;
}
`;

interface AtmosLike {
  wx: WxState | null;
  readonly daylight: number;
  readonly cfg: { weather: string };
}

const sstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

let canopyFor: GameMap | null = null;
/** Smoothed cloud cover / wind (the weather timeline can step). */
let coverS = -1;
let windXS = 0.92;
let windZS = 0.38;
let windKS = 0.2;

function buildCanopy(map: GameMap) {
  canopyFor = map;
  const data = new Uint8Array(map.w * map.h);
  for (let i = 0; i < data.length; i++) data[i] = map.trees[i] > 0 ? 255 : 0;
  const t = new THREE.DataTexture(data, map.w, map.h, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  CLOUD.csCanopy.value?.dispose();
  CLOUD.csCanopy.value = t;
  CLOUD.csMap.value.set(map.w, map.h);
}

/** Debug / screenshots: ?cshadow=0 turns the cloud shadows off, ?shafts=0 the cloud god rays. */
const PARAMS = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const OFF = PARAMS.get('cshadow') === '0';
const NO_SHAFTS = PARAMS.get('shafts') === '0';

/**
 * Per frame (after the atmosphere and the camera): cloud cover, darkness, wind drift, sun angle.
 * `cloudAmount` is the atmosphere's preset value (fog uniform), `sunDir` the key light direction
 * (towards the light, world space), `groundY` the ground height at the view centre.
 */
export function updateCloudShadows(dt: number, atmos: AtmosLike, cloudAmount: number, sunDir: THREE.Vector3, groundY: number, map: GameMap, quality: string) {
  if (canopyFor !== map) buildCanopy(map);
  const wx = atmos.wx;
  let cover: number;
  let windX = 0.92;
  let windZ = 0.38;
  let wind = 0.2;
  if (wx) {
    cover = Math.max(wx.cover, wx.precip * 0.95);
    windX = Math.cos(wx.windDir);
    windZ = Math.sin(wx.windDir);
    wind = wx.wind;
  } else {
    const w = atmos.cfg.weather;
    cover = w === 'rain' ? 0.95 : w === 'snow' ? 0.88 : w === 'sandstorm' ? 0.6 : Math.min(0.6, cloudAmount * 0.9);
    wind = w === 'clear' ? 0.2 : 0.45;
  }
  // ease towards the weather (a front steps the cover: the sky should not snap)
  const k = coverS < 0 ? 1 : Math.min(1, dt * 0.8);
  coverS = coverS < 0 ? cover : coverS + (cover - coverS) * k;
  const kw = Math.min(1, dt * 0.5);
  windXS += (windX - windXS) * kw;
  windZS += (windZ - windZS) * kw;
  windKS += (wind - windKS) * kw;
  const c = coverS;
  const day = sstep(0.3, 0.78, atmos.daylight);
  // more and darker shadows as it clouds over; under a full overcast the sun is already gone (flat light)
  const dark = (0.3 + 0.32 * sstep(0, 0.6, c)) * (1 - 0.8 * sstep(0.72, 1, c));
  CLOUD.csAmount.value = OFF ? 0 : dark * day;
  CLOUD.csCover.value = Math.min(0.97, 0.12 + 0.86 * c);
  // the deck sails faster than the mist creeps (world units / s)
  const v = 0.7 + 2.6 * windKS;
  const d = CLOUD.csDrift.value;
  d.x = (d.x + windXS * v * dt) % 13889;
  d.y = (d.y + windZS * v * dt) % 13889;
  const sy = Math.max(0.2, sunDir.y);
  CLOUD.csSunXZ.value.set(sunDir.x / sy, sunDir.z / sy);
  CLOUD.csGround.value = groundY;
  // shafts: broken cloud (not clear, not a lid), strongest with a low sun
  const broken = sstep(0.12, 0.4, c) * (1 - sstep(0.78, 0.98, c));
  const low = 1 - sstep(0.35, 0.85, sunDir.y);
  CLOUD.csShafts.value = NO_SHAFTS || quality !== 'high' ? 0 : broken * (0.55 + 0.45 * low) * day;
  CLOUD.csDapple.value = quality === 'high' ? day * (1 - 0.85 * sstep(0.55, 0.9, c)) : 0;
}
