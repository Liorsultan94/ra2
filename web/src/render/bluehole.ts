/*
 * The Blue Hole off Dahab, on the Sinai's Gulf of Aqaba shore north of Sharm (render only; the sim's sea there
 * is plain gulf water, so nothing here touches pathing or the start areas). In its own frame (sim/map.ts
 * SeaDeco.hole, frameUV: u along the shore, v seaward) a shallow reef lagoon bulges out from the shore reef
 * into the narrow gulf; in it a near-circular, deep hole ringed by an awash reef-flat rim with gaps (a C /
 * horseshoe open to the sea), a bright turquoise halo at its drop-off, small reef islets and patchy coral
 * heads round it.
 *
 * The same analytic shape is used by the water shader (water.ts: the virtual depth that colours the water)
 * and on the CPU (reeflife.ts / seaside.ts: where corals, fish, starfish and the wreck go). Keep the two
 * versions below in step.
 */

export const LAGOON = {
  /** The hole: centre (u, v) and the radius of its drop-off. */
  hu: -0.3,
  hv: 4.7,
  R: 1.55,
  /** Width of the reef-flat rim round it. */
  rimW: 0.85,
  /** The wide gap in the rim (direction in the frame, radians from +u towards +v) and its half width. */
  gapA: 1.95,
  gapW: 0.42,
  /** The lagoon platform: an ellipse (centre, radii) joining the shore reef (most of the gulf's width). */
  pu: -0.7,
  pv: 4.1,
  pru: 5.0,
  prv: 4.0,
  /** Reef islets: (u, v, radius). */
  islets: [
    [-3.5, 5.4, 0.55],
    [2.6, 6.3, 0.42],
    [-2.3, 7.2, 0.45],
    [-4.6, 3.4, 0.38],
    [1.6, 2.5, 0.34],
    [-1.2, 7.4, 0.32],
  ] as [number, number, number][],
  /** The wreck on the rim: direction from the hole centre (radians), bow / stern offsets from the drop-off. */
  wreckA: -0.3,
  wreckBow: 0.85,
  wreckStern: -1.2,
};

const ss = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface LagoonAt {
  /** Inside the lagoon platform 0..1. */
  plat: number;
  /** The platform's water depth (rim and islets awash). */
  virt: number;
  /** The hole's depth (0 outside it). */
  wall: number;
  /** The awash reef: the rim or an islet 0..1. */
  reef: number;
  /** Signed distance to the hole's drop-off (< 0 inside). */
  t: number;
}

/** The lagoon at frame point (u, v) (CPU twin of LAGOON_GLSL). */
export function lagoonAt(u: number, v: number): LagoonAt {
  const L = LAGOON;
  const dx = u - L.hu;
  const dy = v - L.hv;
  const r = Math.hypot(dx, dy);
  const th = Math.atan2(dy, dx);
  const Rw = L.R * (1 + 0.06 * Math.sin(3 * th + 0.7) + 0.035 * Math.sin(5 * th + 2.1));
  const t = r - Rw;
  let da = th - L.gapA;
  da = Math.atan2(Math.sin(da), Math.cos(da));
  const open = 1 - ss(L.gapW * 0.6, L.gapW, Math.abs(da));
  const small = ss(0.93, 0.985, Math.sin(2 * th + 1.3) * 0.5 + 0.5);
  const rw = L.rimW * (1 + 0.25 * Math.sin(4 * th + 0.4));
  const rim = ss(0.0, 0.2, t) * (1 - ss(rw * 0.7, rw, t)) * (1 - open) * (1 - small);
  const e = Math.hypot((u - L.pu) / L.pru, (v - L.pv) / L.prv) + 0.04 * Math.sin(u * 0.9 + v * 0.4) + 0.03 * Math.sin(v * 1.3 - u * 0.5);
  const plat = 1 - ss(0.8, 1.0, e);
  const pdp = 0.2 + 0.05 * Math.sin(u * 1.1 + 0.3) * Math.sin(v * 0.9 + 1.1) + 0.04 * Math.sin(u * 2.3 - v * 1.7);
  let isl = 0;
  for (const [iu, iv, ir] of L.islets) {
    const d = Math.hypot(u - iu, v - iv) + 0.08 * Math.sin((u - iu) * 5.0 + (v - iv) * 3.0);
    isl = Math.max(isl, 1 - ss(ir * 0.55, ir, d));
  }
  const reef = Math.max(rim, isl);
  const virt = pdp + (0.025 - pdp) * reef;
  const wall = 4.5 * Math.pow(ss(0.1, -1.1, t), 1.8);
  return { plat, virt, wall, reef, t };
}

/** Water depth for colour at frame point (u, v) given the real depth there (the lagoon in). */
export function lagoonDepth(u: number, v: number, real: number) {
  const l = lagoonAt(u, v);
  return real + (Math.max(Math.min(real, l.virt), l.wall) - real) * l.plat;
}

const f = (x: number) => x.toFixed(3);

/** GLSL twin of lagoonAt: vec4(plat, depth for real depth `real`, reef, signed distance t). */
export const LAGOON_GLSL = /* glsl */ `
  vec4 lagoon( float u, float v, float real ) {
    float dx = u - ${f(LAGOON.hu)};
    float dy = v - ${f(LAGOON.hv)};
    float r = length( vec2( dx, dy ) );
    float th = atan( dy, dx );
    float Rw = ${f(LAGOON.R)} * ( 1.0 + 0.06 * sin( 3.0 * th + 0.7 ) + 0.035 * sin( 5.0 * th + 2.1 ) );
    float t = r - Rw;
    float da = th - ${f(LAGOON.gapA)};
    da = atan( sin( da ), cos( da ) );
    float open = 1.0 - smoothstep( ${f(LAGOON.gapW * 0.6)}, ${f(LAGOON.gapW)}, abs( da ) );
    float small = smoothstep( 0.93, 0.985, sin( 2.0 * th + 1.3 ) * 0.5 + 0.5 );
    float rw = ${f(LAGOON.rimW)} * ( 1.0 + 0.25 * sin( 4.0 * th + 0.4 ) );
    float rim = smoothstep( 0.0, 0.2, t ) * ( 1.0 - smoothstep( rw * 0.7, rw, t ) ) * ( 1.0 - open ) * ( 1.0 - small );
    float e = length( vec2( ( u - ${f(LAGOON.pu)} ) / ${f(LAGOON.pru)}, ( v - ${f(LAGOON.pv)} ) / ${f(LAGOON.prv)} ) ) + 0.04 * sin( u * 0.9 + v * 0.4 ) + 0.03 * sin( v * 1.3 - u * 0.5 );
    float plat = 1.0 - smoothstep( 0.8, 1.0, e );
    float pdp = 0.2 + 0.05 * sin( u * 1.1 + 0.3 ) * sin( v * 0.9 + 1.1 ) + 0.04 * sin( u * 2.3 - v * 1.7 );
    float isl = 0.0;
    ${LAGOON.islets
      .map(
        ([iu, iv, ir]) =>
          `{ vec2 q = vec2( u - ${f(iu)}, v - ${f(iv)} ); float d = length( q ) + 0.08 * sin( q.x * 5.0 + q.y * 3.0 ); isl = max( isl, 1.0 - smoothstep( ${f(ir * 0.55)}, ${f(ir)}, d ) ); }`,
      )
      .join('\n    ')}
    float reef = max( rim, isl );
    float virt = mix( pdp, 0.025, reef );
    float wall = 4.5 * pow( 1.0 - smoothstep( -1.1, 0.1, t ), 1.8 );
    return vec4( plat, mix( real, max( min( real, virt ), wall ), plat ), reef * plat, t );
  }
`;

/**
 * The Red Sea's in-scatter colour by optical depth (water.ts, and the horizon's sea past the map edge so the
 * two meet): light turquoise over the shallows, blue past the drop-off, the open sea's dark navy, and the
 * near black-navy of the Blue Hole.
 */
export const SEA_SCATTER_GLSL = /* glsl */ `
  vec3 seaScatter( float dO ) {
    vec3 c = mix( vec3( 0.035, 0.36, 0.38 ), vec3( 0.008, 0.085, 0.24 ), smoothstep( 0.12, 0.65, dO ) );
    c = mix( c, vec3( 0.003, 0.022, 0.11 ), smoothstep( 1.05, 1.9, dO ) );
    return mix( c, vec3( 0.001, 0.0035, 0.03 ), smoothstep( 2.0, 4.0, dO ) );
  }
`;
