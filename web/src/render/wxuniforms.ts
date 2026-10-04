import * as THREE from 'three';

/*
 * Global weather / time-of-day shader uniforms. They are shared by every
 * fog-patched material (see FogOfWar.apply) and by the ground and water
 * shaders, so one write per frame drives snow cover, wet surfaces, dust and
 * rain ripples everywhere. All zero = the plain day/clear look (the shader
 * branches skip the work entirely).
 */
export const WX = {
  /** Snow cover on upward-facing surfaces, 0..1. */
  wxSnow: { value: 0 },
  /**
   * How far a snowfall still is from full cover, 0..1 (0 = full, the default).
   * A snow battle starts patchy (~60% of the ground white) and the effects
   * ease it to 0 over a few minutes (fx/groundfx.ts).
   */
  wxSnowThin: { value: 0 },
  /** Rain wetness: darker albedo, glossier surfaces, puddles on the ground, 0..1. */
  wxWet: { value: 0 },
  /** Sandstorm dust settling on upward-facing surfaces, 0..1. */
  wxDust: { value: 0 },
  /** Clock for rain ripples (seconds). */
  wxTime: { value: 0 },
  /**
   * Rain falling right now, 0..1 (ripple rings on puddles and the river). Separate from
   * wxWet so puddles can stay (and shrink) while the ground dries after the rain.
   */
  wxRain: { value: 0 },
  /**
   * Wet-surface tier, set by the ground for the battle's quality: 0 (low) = rain only darkens
   * surfaces; 1 = also glossier, puddles with sky reflections and drop ripples.
   */
  wxGloss: { value: 1 },
};

/**
 * Debug / screenshot pins: ?wet=<0..1>, ?rain=<0..1>, ?snow=<0..1> hold the shared surface uniforms
 * at that value whatever the weather does (writes are ignored), e.g. `&weather=rain&wet=0.4`.
 * The ?wx=<preset> URL (weathercycle.ts) drives the whole weather state instead.
 */
export function wxPins(search: string): Partial<Record<'wxWet' | 'wxRain' | 'wxSnow', number>> {
  const q = new URLSearchParams(search);
  const out: Partial<Record<'wxWet' | 'wxRain' | 'wxSnow', number>> = {};
  for (const [k, u] of [['wet', 'wxWet'], ['rain', 'wxRain'], ['snow', 'wxSnow']] as const) {
    const v = q.get(k);
    if (v !== null && v !== '' && Number.isFinite(+v)) out[u] = Math.max(0, Math.min(1, +v));
  }
  return out;
}
if (typeof location !== 'undefined') {
  for (const [k, v] of Object.entries(wxPins(location.search)) as ['wxWet' | 'wxRain' | 'wxSnow', number][]) {
    Object.defineProperty(WX[k], 'value', { configurable: true, enumerable: true, get: () => v, set: () => {} });
  }
}

/** GLSL declarations for the uniforms above. */
export const WX_PARS = /* glsl */ `
uniform float wxSnow;
uniform float wxSnowThin;
uniform float wxWet;
uniform float wxDust;
uniform float wxTime;
uniform float wxRain;
uniform float wxGloss;
`;

/**
 * Low ground fog / valley mist (dawn, the 'mist' time of day, after rain). These live in
 * the fog-of-war uniform set (FogOfWar.uniforms spreads them) and MIST_GLSL is part of
 * FOG_GLSL, so every fog-shaded material gets the height fog for free. mistAmount 0 =
 * the branch is skipped; the shader never changes, only these values.
 */
export const WXM = {
  /** Overall mist density 0..1. */
  mistAmount: { value: 0 },
  /** Lit colour of the mist (follows the sky / sun). */
  mistColor: { value: new THREE.Color(0.75, 0.77, 0.8) },
  /** x: height of full density, y: top of the layer (world y), z: clear radius around the view centre, w: max opacity. */
  mistParams: { value: new THREE.Vector4(-0.1, 0.95, 8, 0.6) },
  /** Accumulated wind drift of the mist noise (world units). */
  mistDrift: { value: new THREE.Vector2() },
};

/**
 * Height fog, inserted into FOG_GLSL (needs fogNoise and fogTarget declared before it).
 * Dense in the river valley and hollows, thin on the plateaus, gone on the ridges; it
 * thins out around the view centre (where the player is looking / their units are)
 * so the battle stays readable, and drifts with the wind.
 */
export const MIST_GLSL = /* glsl */ `
uniform float mistAmount;
uniform vec3 mistColor;
uniform vec4 mistParams;
uniform vec2 mistDrift;
vec3 mistShade( vec3 col, vec3 p ) {
  if ( mistAmount < 0.002 ) return col;
  float mh = 1.0 - smoothstep( mistParams.x, mistParams.y, p.y );
  if ( mh <= 0.0 ) return col;
  vec2 mq = p.xz + mistDrift;
  float mn = texture2D( fogNoise, mq * 0.031 ).g * 0.62 + texture2D( fogNoise, mq * 0.083 + vec2( 0.31, 0.57 ) - mistDrift * 0.004 ).a * 0.38;
  // patchy banks: the noise eats the thin upper part of the layer first
  float md = mh * smoothstep( 0.18, 0.72, mn + mh * 0.32 + mistAmount * 0.18 - 0.2 );
  float mr = length( p.xz - fogTarget.xz );
  md *= mix( 0.3, 1.0, smoothstep( mistParams.z * 0.45, mistParams.z * 1.5, mr ) );
  return mix( col, mistColor, clamp( md * mistAmount, 0.0, 1.0 ) * mistParams.w );
}
`;

/**
 * Surface weathering, injected after `emissivemap_fragment` (where the final
 * `normal`, `diffuseColor` and, for standard materials, `roughnessFactor`
 * exist). `p` is the world position.
 */
export const WX_SURFACE = /* glsl */ `
if ( wxSnow + wxWet + wxDust > 0.001 ) {
  vec3 wxN = inverseTransformDirection( normal, viewMatrix );
  float wxUp = clamp( wxN.y, 0.0, 1.0 );
  vec4 wxNz = texture2D( fogNoise, vFogP.xz * 0.21 );
  if ( wxSnow > 0.001 ) {
    // accumulation: a light fall lies in patches (drifts against the noise), which spread and join
    // as it builds (full cover from ~0.85) and shrink back the same way as it melts
    float wxBld = wxNz.r * 0.65 + texture2D( fogNoise, vFogP.xz * 0.61 + 0.37 ).b * 0.35;
    float wxThB = 1.15 - wxSnow * 1.35;
    float cover = smoothstep( 0.42, 0.78, wxUp + ( wxNz.r - 0.5 ) * 0.5 ) * min( 1.0, smoothstep( wxThB - 0.12, wxThB + 0.12, wxBld ) * ( 0.55 + 0.6 * wxSnow ) );
    cover = max( cover, smoothstep( 0.1, 0.5, wxUp ) * wxSnow * 0.22 );
    if ( wxSnowThin > 0.001 ) {
      // early in the snowfall it lies in drifts with thinly dusted ground between; the gaps fill in over the battle
      float wxPatch = wxNz.r * 0.6 + texture2D( fogNoise, vFogP.xz * 0.93 ).g * 0.4;
      float wxThr = mix( 1.3, 0.53, wxSnowThin );
      cover *= mix( 0.28, 1.0, 1.0 - smoothstep( wxThr - 0.07, wxThr + 0.07, wxPatch ) );
    }
    #if defined( STANDARD )
      // painted metal (vehicles, plant) sheds most of it: keeps units readable
      cover *= 1.0 - 0.7 * smoothstep( 0.2, 0.5, metalnessFactor );
    #endif
    #ifdef WX_SNOW_K
      // materials that paint their own snow (winter ground) or shed it (ploughed roads)
      cover *= WX_SNOW_K;
    #endif
    vec3 snowC = vec3( 0.82, 0.86, 0.92 ) * ( 0.92 + wxNz.g * 0.16 );
    diffuseColor.rgb = mix( diffuseColor.rgb, snowC, cover );
    #if defined( STANDARD )
      roughnessFactor = mix( roughnessFactor, 0.62, cover );
      metalnessFactor = mix( metalnessFactor, 0.0, cover );
    #endif
  }
  #ifndef WX_OWN_WET
  if ( wxWet > 0.001 ) {
    float wet = wxWet * ( 0.55 + 0.45 * wxUp );
    diffuseColor.rgb *= 1.0 - 0.38 * wet;
    #if defined( STANDARD )
    // (low quality: darkening only)
    if ( wxGloss > 0.5 ) {
      roughnessFactor = mix( roughnessFactor, roughnessFactor * 0.45, wet * smoothstep( 0.3, 0.8, wxUp ) );
      #ifndef WX_NO_PUDDLE
      {
        // standing water on flat, non-metal tops (country roads, flat roofs, plazas): mirror-like patches
        // that shrink into the dips as things dry (the terrain paints its own puddles: WX_NO_PUDDLE)
        float wxFlat = smoothstep( 0.975, 0.995, wxUp ) * ( 1.0 - smoothstep( 0.15, 0.4, metalnessFactor ) );
        if ( wxFlat > 0.01 ) {
          float wxPn = texture2D( fogNoise, vFogP.xz * 0.37 + 0.21 ).g * 0.7 + wxNz.a * 0.3;
          float wxPt = 0.66 - wxWet * 0.1;
          float wxPd = smoothstep( wxPt, wxPt + 0.04, wxPn ) * wxFlat * min( 1.0, wxWet * 2.0 );
          diffuseColor.rgb *= 1.0 - 0.32 * wxPd;
          roughnessFactor = mix( roughnessFactor, 0.04, wxPd );
          // the water mirrors the (cloudy) sky: without it the patches read as black paint at this view angle
          vec3 wxSky = dot( skyHorA.xyz, vec3( 1.0 ) ) > 0.01 ? skyHorA.xyz : hazeColor * 2.0;
          wxSky /= 1.0 + max( wxSky.r, max( wxSky.g, wxSky.b ) );
          totalEmissiveRadiance += wxSky * wxPd * ( 0.1 + 0.08 * wxNz.b );
        }
      }
      #endif
    }
    #endif
  }
  #endif
  if ( wxDust > 0.001 ) {
    float dust = smoothstep( 0.3, 0.9, wxUp + ( wxNz.b - 0.5 ) * 0.4 ) * wxDust * 0.5;
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.62, 0.48, 0.3 ), dust );
  }
}
`;
