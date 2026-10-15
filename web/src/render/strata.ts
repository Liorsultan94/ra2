import * as THREE from 'three';

/*
 * Wadi Al-Rimal's coloured canyon sandstone (render only): one palette for the cliff shader's strata
 * (relief.ts, also on canyon.ts' ledges and boulders) and the ground's talus tint (ground.ts).
 *
 * Like Sinai's Coloured Canyon: mostly warm tan, sand and honey, with layers of rust red, burnt orange,
 * ochre, cream and pale pink and the odd faint, dusty mauve. All muted, so the canyon sits in the desert
 * round it. The bands are picked per layer by a hash (no repeating cycle) and the list is weighted
 * towards the tans.
 */
export const STRATA_RGB = [
  0xb99b78, // tan
  0x9f6b52, // rust
  0xc4a378, // honey
  0xb59672, // sand
  0xd3c3a6, // cream
  0xb07a56, // burnt orange
  0xbb9a7a, // tan
  0xbf9f8e, // pale pink
  0xaf9068, // ochre
  0xc0a27e, // sand
  0x9e8a86, // dusty mauve
  0xa27a62, // rust brown
  0xb89874, // tan
  0xc6ac88, // pale honey
];

/** The palette in linear RGB. */
export function strataLinear(): THREE.Color[] {
  return STRATA_RGB.map((h) => new THREE.Color().setHex(h));
}

/** Mean of the palette (linear), the neutral the ground's tint multipliers are taken against. */
export function strataMean(): THREE.Color {
  const c = new THREE.Color(0, 0, 0);
  const l = strataLinear();
  for (const x of l) c.add(x);
  return c.multiplyScalar(1 / l.length);
}

/**
 * GLSL (fragment, after fogNoise is declared): `vec3 cyStrata( vec3 p, vec3 n, out float shade, out float rough )`
 * gives the sandstone colour (linear) at world position p on a face with normal n,
 * plus a shade multiplier (recessed soft layers, grooves at the contacts, joints, streaks, polish) and a
 * roughness offset. The layers wander, swell and pinch, fold into swirls in places and carry slanting
 * cross-bedded laminae; vertical joints and runnels break them up.
 */
export function strataGlsl(): string {
  const l = strataLinear();
  const arr = l.map((c) => `vec3( ${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)} )`).join(', ');
  const N = l.length;
  const m = strataMean();
  return /* glsl */ `
  const vec3 CY_PAL[${N}] = vec3[${N}]( ${arr} );
  const vec3 CY_MEAN = vec3( ${m.r.toFixed(4)}, ${m.g.toFixed(4)}, ${m.b.toFixed(4)} );
  float cyHash( float i ) { return fract( sin( i * 91.173 + 7.31 ) * 43758.5453 ); }
  vec3 cyBand( float i ) { return CY_PAL[ int( min( cyHash( i ) * ${N}.0, ${N - 1}.0 ) ) ]; }
  vec3 cyStrata( vec3 p, vec3 n, out float shade, out float rough ) {
    // (everything here is a function of the position alone, never of the face's orientation, so it runs on
    // continuously over the facets of the cliffs, the ledges and the boulders)
    vec4 nA = texture2D( fogNoise, p.xz * 0.037 + 0.31 );
    vec4 nB = texture2D( fogNoise, p.xz * 0.13 + p.y * 0.045 );
    float sw = texture2D( fogNoise, p.xz * 0.08 + vec2( p.y * 0.09, -p.y * 0.05 ) + nA.xy ).b;
    // layers by height: dipping and swelling along the walls, folded into swirls here and there
    float h = p.y * 2.3 + ( nA.r - 0.5 ) * 3.4 + ( sw - 0.5 ) * 2.6 + sin( dot( p.xz, vec2( 0.33, 0.31 ) ) + nA.g * 5.0 ) * 0.3;
    // ...thick and thin (still monotonic in height)
    h += 0.36 * sin( h * 2.15 + nA.b * 4.0 );
    float i = floor( h );
    float f = fract( h );
    float r0 = cyHash( i + 3.7 );
    // soft contacts, ragged by the noise
    float e = smoothstep( 0.74, 1.0, f + ( nB.r - 0.5 ) * 0.3 );
    vec3 col = mix( cyBand( i ), cyBand( i + 1.0 ), e );
    // cross-bedding: fine laminae dipping in their own direction in about half the layers
    float da = cyHash( i + 23.0 ) * 6.2832;
    float slant = 0.15 + cyHash( i + 17.0 ) * 0.4;
    float lam = sin( ( p.y + dot( p.xz, vec2( cos( da ), sin( da ) ) ) * slant + ( nB.g - 0.5 ) * 0.4 ) * 46.0 );
    col *= 1.0 + lam * 0.04 * step( 0.5, cyHash( i + 5.0 ) );
    // the layers show on the faces; where the rock lies back (tops, benches) height contours would spread
    // into broad painted stripes, so there it weathers to one sandy tone
    col = mix( col, CY_MEAN, smoothstep( 0.35, 0.8, n.y ) * 0.85 );
    // a gentle hue drift inside a layer (iron staining, bleaching)
    col *= mix( vec3( 1.05, 0.98, 0.93 ), vec3( 0.96, 1.0, 1.05 ), nB.b );
    // soft layers weather back into shaded grooves; a thin dark line under each harder one
    float soft = step( 0.6, r0 );
    shade = 1.0 - soft * 0.1 - ( 1.0 - smoothstep( 0.0, 0.06, f ) ) * 0.16;
    // vertical joints: the rock's joint planes (contours of a broad noise in plan, so they cut any wall as
    // near-vertical cracks about every 0.7 units), broken off here and there
    float jk = ( texture2D( fogNoise, p.xz * 0.045 + vec2( p.y * 0.012, 0.13 ) ).r - 0.5 ) * 6.0;
    float jd = abs( fract( jk ) - 0.5 );
    float jl = texture2D( fogNoise, p.xz * 0.05 + vec2( 0.5, p.y * 0.06 ) ).g;
    float crack = ( 1.0 - smoothstep( 0.012, 0.035, jd ) ) * smoothstep( 0.46, 0.56, jl );
    // runnels and desert varnish streaking down from the rims (broad and soft)
    float st = texture2D( fogNoise, p.xz * 0.1 + vec2( 0.0, p.y * 0.008 ) ).a;
    float steep = 1.0 - smoothstep( 0.45, 0.85, n.y );
    shade *= 1.0 - steep * ( crack * 0.45 + smoothstep( 0.52, 0.7, st ) * 0.1 );
    // wind-polished faces (towards the prevailing north-west wind): paler and a touch smoother
    float pol = smoothstep( 0.5, 0.85, nB.a + dot( n.xz, vec2( -0.7, -0.7 ) ) * 0.3 );
    shade *= 1.0 + pol * 0.09;
    rough = soft * 0.04 - pol * 0.1;
    // dusty: a little greyer, like the desert round it
    return mix( vec3( dot( col, vec3( 0.2126, 0.7152, 0.0722 ) ) ), col, 0.88 );
  }
`;
}
