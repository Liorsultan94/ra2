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
  /** Rain wetness: darker albedo, glossier surfaces, puddles on the ground, 0..1. */
  wxWet: { value: 0 },
  /** Sandstorm dust settling on upward-facing surfaces, 0..1. */
  wxDust: { value: 0 },
  /** Clock for rain ripples (seconds). */
  wxTime: { value: 0 },
};

/** GLSL declarations for the uniforms above. */
export const WX_PARS = /* glsl */ `
uniform float wxSnow;
uniform float wxWet;
uniform float wxDust;
uniform float wxTime;
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
    float cover = smoothstep( 0.42, 0.78, wxUp + ( wxNz.r - 0.5 ) * 0.5 ) * wxSnow;
    cover = max( cover, smoothstep( 0.1, 0.5, wxUp ) * wxSnow * 0.22 );
    #if defined( STANDARD )
      // painted metal (vehicles, plant) sheds most of it: keeps units readable
      cover *= 1.0 - 0.7 * smoothstep( 0.2, 0.5, metalnessFactor );
    #endif
    vec3 snowC = vec3( 0.82, 0.86, 0.92 ) * ( 0.92 + wxNz.g * 0.16 );
    diffuseColor.rgb = mix( diffuseColor.rgb, snowC, cover );
    #if defined( STANDARD )
      roughnessFactor = mix( roughnessFactor, 0.62, cover );
      metalnessFactor = mix( metalnessFactor, 0.0, cover );
    #endif
  }
  if ( wxWet > 0.001 ) {
    float wet = wxWet * ( 0.55 + 0.45 * wxUp );
    diffuseColor.rgb *= 1.0 - 0.38 * wet;
    #if defined( STANDARD )
      roughnessFactor = mix( roughnessFactor, roughnessFactor * 0.45, wet * smoothstep( 0.3, 0.8, wxUp ) );
    #endif
  }
  if ( wxDust > 0.001 ) {
    float dust = smoothstep( 0.3, 0.9, wxUp + ( wxNz.b - 0.5 ) * 0.4 ) * wxDust * 0.5;
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.62, 0.48, 0.3 ), dust );
  }
}
`;
