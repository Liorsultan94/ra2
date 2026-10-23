import * as THREE from 'three';
import { noiseTexture } from './fog';

/*
 * The desert's night sky (Wadi Al-Rimal: no light pollution out there): a rich star field, the Milky Way,
 * airglow and a faint horizon glow, drawn by the physical sky dome (sky.ts) and, on medium, the water's
 * sky reflection (water.ts; high reflects the dome itself through the planar reflection).
 *
 * - Stars: three layers (two below high quality) on a cube-face grid of the celestial sphere, at most one
 *   star per cell, kept away from the cell's edges so one cell lookup per pixel and layer is enough. Cells
 *   are thinned by their solid angle (no denser corners). Brightness follows a power law (many faint, few
 *   bright), colours run from blue-white to a few orange, the point spread is one pixel wide (fwidth), and
 *   a layer whose cells get too small on screen fades out instead of shimmering. Twinkle grows towards the
 *   horizon; extinction (airmass, reddened) and the haze fade them out there.
 * - The Milky Way: a band around the galactic plane, wider at the bulge, with a warm brighter core, star
 *   clouds mottled by the shared noise texture and dark dust lanes (the Great Rift side of the centre).
 * - Sidereal motion: the celestial sphere turns with the game clock (Red Sea latitude, a summer sky: the
 *   galactic centre crosses the meridian low in the south at 20:15 and sets after midnight).
 * - The moon: a lunar phase per night (render only, seeded from the match): its glow washes the faint
 *   stars and the Milky Way out (the whole sky, most round the moon), a thin crescent hardly at all.
 *   The key light by night is unchanged (gameplay darkness stays as it is).
 * - Clouds, overcast and blowing sand hide all of it (the dome draws the cloud deck over it).
 *
 * Everything here is render only and deterministic (seeded hashes, no Math.random).
 */

export const NSKY = {
  /** World direction -> celestial frame (rows: RA 0h, RA 6h, the celestial pole). */
  nsRot: { value: new THREE.Matrix3() },
  /** Galactic north pole, galactic centre and longitude 90 deg (world directions). */
  nsGalN: { value: new THREE.Vector3(0, 1, 0) },
  nsGalC: { value: new THREE.Vector3(1, 0, 0) },
  nsGalY: { value: new THREE.Vector3(0, 0, 1) },
  /** xyz: towards the moon, w: how much its glow washes the faint sky out (0 none .. 1 full moon). */
  nsMoon: { value: new THREE.Vector4(0, 1, 0, 0) },
  /** x: visibility (night x clear sky; 0 skips everything), y: haze (dust), z: twinkle clock (s), w: Milky Way gain. */
  nsK: { value: new THREE.Vector4() },
  /** xy: horizontal direction (world x, z) from the camera to the town, z: its glow. */
  nsTown: { value: new THREE.Vector3(1, 0, 0) },
  nsNoise: { value: null as THREE.Texture | null },
};

export const NSKY_GLSL = /* glsl */ `
  uniform mat3 nsRot;
  uniform vec3 nsGalN;
  uniform vec3 nsGalC;
  uniform vec3 nsGalY;
  uniform vec4 nsMoon;
  uniform vec4 nsK;
  uniform vec3 nsTown;
  uniform sampler2D nsNoise;
  vec3 nsHash3( vec3 p ) {
    p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
    p += dot( p, p.yxz + 33.33 );
    return fract( ( p.xxy + p.yxx ) * p.zyx );
  }
  // one star layer: N cells per half face edge, dens = stars per cell (face centre), b = brightest star,
  // pix = pixel size (rad), tw = twinkle amplitude
  vec3 nsLayer( vec3 c, float N, float dens, float b, float pix, float tw, float seed ) {
    vec3 a = abs( c );
    float m = max( a.x, max( a.y, a.z ) );
    vec3 fa = a.x >= m ? vec3( 1.0, 0.0, 0.0 ) : a.y >= m ? vec3( 0.0, 1.0, 0.0 ) : vec3( 0.0, 0.0, 1.0 );
    vec3 n = fa * ( dot( c, fa ) < 0.0 ? -1.0 : 1.0 );
    vec3 t = fa.x > 0.5 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
    vec3 bt = cross( fa, t );
    vec2 cell = floor( vec2( dot( c, t ), dot( c, bt ) ) / m * N );
    vec3 h = nsHash3( vec3( cell, dot( n, vec3( 1.0, 2.0, 4.0 ) ) * 3.17 + seed ) );
    vec2 cc = ( cell + 0.5 ) / N;
    float sa = 1.0 + dot( cc, cc );
    // cells shrink towards the face corners: thin them by their solid angle
    float u = h.z * sa * sqrt( sa ) / dens;
    if ( u >= 1.0 ) return vec3( 0.0 );
    vec2 su = ( cell + 0.25 + 0.5 * h.xy ) / N;
    vec3 s = normalize( n + t * su.x + bt * su.y );
    vec3 dv = c - s;
    float r2 = dot( dv, dv );
    // one pixel wide, never wider than the cell's margin allows; too small cells fade instead of aliasing
    float lim = 0.125 / ( N * sa );
    float sig = min( pix * 0.7, lim );
    float fit = sig / ( pix * 0.7 );
    float k = exp( -0.5 * r2 / ( sig * sig ) ) * fit * fit;
    // power-law brightness (many faint, few bright) and a colour (blue-white .. a few orange)
    float f = b / ( 1.0 + u * 24.0 );
    float hc = fract( h.x * 31.7 + h.y * 17.3 );
    vec3 col = mix( vec3( 0.8, 0.88, 1.0 ), vec3( 1.0, 0.97, 0.94 ), smoothstep( 0.2, 0.4, hc ) );
    col = mix( col, vec3( 1.0, 0.92, 0.76 ), smoothstep( 0.68, 0.74, hc ) );
    col = mix( col, vec3( 1.0, 0.76, 0.52 ), smoothstep( 0.92, 0.95, hc ) );
    float ph = hc * 44.0;
    float tk = 1.0 + tw * ( 0.6 * sin( nsK.z * ( 2.3 + 3.1 * h.y ) + ph ) + 0.4 * sin( nsK.z * ( 6.1 + 4.3 * h.x ) + ph * 1.7 ) );
    return col * ( f * k * tk );
  }
  // the Milky Way's glow (before extinction); I = its brightness (also thickens the faint star layers)
  vec3 nsMilkyWay( vec3 d, float hq, out float I ) {
    float sb = dot( d, nsGalN );
    float gx = dot( d, nsGalC );
    float gy = dot( d, nsGalY );
    float l = atan( gy, gx );
    float cl = 0.5 + 0.5 * gx / max( 1e-4, length( vec2( gx, gy ) ) );
    float core = exp( -l * l * 3.0 );
    // noise in (l, b) at the same scale on both axes (round clumps, not streaks along the band: near the plane
    // l and b are both angles); one tap holds four fields (periods 4 / 6 / 8 / 10 per 30 degree tile). The
    // explicit gradients keep the mip level across the longitude seam (l = +-pi: a jump of 12 per unit scale)
    vec2 uv = vec2( l, asin( clamp( sb, -1.0, 1.0 ) ) ) * 1.909859;
    vec2 gdx = dFdx( uv );
    vec2 gdy = dFdy( uv );
    gdx.x -= 12.0 * floor( gdx.x / 12.0 + 0.5 );
    gdy.x -= 12.0 * floor( gdy.x / 12.0 + 0.5 );
    vec4 t1 = textureGrad( nsNoise, uv, gdx, gdy );
    // high: a finer octave for the star clouds' grain and the dust filaments
    vec4 t2 = hq > 0.5 ? textureGrad( nsNoise, uv * 2.5 + vec2( 0.37, 0.11 ), gdx * 2.5, gdy * 2.5 ) : t1.argb;
    float w = 0.09 + 0.05 * cl + 0.07 * core;
    float band = exp( -sb * sb / ( w * w ) );
    float thin = exp( -sb * sb / ( w * w * 0.15 ) );
    // clumpy star clouds (Sagittarius / Scutum-like), with a finer grain
    float clouds = smoothstep( 0.3, 0.64, t1.r * 0.6 + t1.g * 0.4 + ( t2.a - 0.5 ) * 0.25 );
    // the bulge: a brighter oval glow round the centre
    float bulge = exp( -l * l * 7.0 - sb * sb / 0.016 );
    I = band * ( 0.22 + 0.45 * cl ) * ( 0.55 + 0.75 * clouds ) + thin * clouds * 0.5 * cl + core * band * ( 0.4 + 0.6 * clouds ) + bulge * ( 0.85 + 0.6 * clouds );
    // dust: branching filaments (the noise's contour lines), the Great Rift splitting the band from the centre
    // towards l ~ 90 deg with ragged edges, and dark nebula blobs round the core
    float fn = mix( t1.b, t2.g, 0.6 * hq );
    // (only in patches: a second field gates them, so they branch and thin out instead of netting the band)
    float fil = smoothstep( 0.86, 0.97, 1.0 - abs( 2.0 * fn - 1.0 ) ) * smoothstep( 0.5, 0.68, t1.g ) * exp( -sb * sb / 0.016 ) * ( 0.3 + 0.7 * cl );
    float rb = sb - 0.012 - 0.05 * ( t1.g - 0.5 );
    float rw = 0.02 + 0.025 * t1.r + 0.012 * core;
    float rift = exp( -rb * rb / ( rw * rw ) ) * smoothstep( -0.5, 0.05, l ) * ( 1.0 - smoothstep( 1.2, 1.9, l ) ) * smoothstep( 0.3, 0.55, t1.b + 0.15 );
    float blob = smoothstep( 0.64, 0.78, t1.a ) * band * ( 0.3 + 0.7 * core );
    I *= 1.0 - 0.85 * max( max( fil * 0.7, rift ), blob * 0.7 );
    vec3 mc = mix( vec3( 0.76, 0.84, 1.0 ), vec3( 1.0, 0.89, 0.72 ), min( 1.0, core * 1.1 + 0.05 ) );
    return mc * I;
  }
  // stars + Milky Way towards d (world, normalised; up = d.y), pix = pixel size (rad),
  // hq: 1 = the full sky (high), 0 = the cheaper one (medium; the same look at a distance)
  vec3 nightSky( vec3 d, float pix, float hq ) {
    float up = max( d.y, 0.0 );
    // extinction towards the horizon (airmass, reddened; more with blowing sand) and the low haze
    float X = 1.0 / ( up + 0.03 ) - 0.97;
    vec3 ext = exp( -X * vec3( 0.16, 0.22, 0.32 ) * ( 1.0 + 3.0 * nsK.y ) ) * smoothstep( 0.0, 0.08, up );
    // the moon's glow washes the faint sky out (everywhere, most round the moon)
    float wash = clamp( nsMoon.w * ( 0.55 + 0.45 * exp( ( dot( d, nsMoon.xyz ) - 1.0 ) * 2.5 ) ), 0.0, 1.0 );
    float I;
    vec3 mw = nsMilkyWay( d, hq, I ) * nsK.w * ( 1.0 - wash ) * ( 1.0 - wash );
    vec3 c = nsRot * d;
    float tw = mix( 0.45, 0.1, smoothstep( 0.0, 0.5, up ) );
    // (the faint layers crowd into the Milky Way: its glow is unresolved stars)
    float crowd = 1.0 + 2.5 * min( I, 1.5 );
    vec3 s = nsLayer( c, 40.0, 0.11, 0.7, pix, tw, 0.0 ) * ( 1.0 - 0.6 * wash );
    s += nsLayer( c, 110.0, 0.13 * crowd, 0.42, pix, tw, 7.0 ) * ( 1.0 - 0.9 * wash );
    if ( hq > 0.5 ) s += nsLayer( c, 200.0, 0.12 * crowd, 0.2, pix, tw * 0.5, 13.0 ) * ( 1.0 - wash );
    return ( s + mw ) * ext * nsK.x;
  }
  // airglow and the faint horizon glow (warmer over the town's gentle lights): added above the horizon
  vec3 nightGlow( vec3 d ) {
    float up = d.y;
    float u = max( up, 0.0 );
    float ag = exp( -( u - 0.16 ) * ( u - 0.16 ) / 0.012 );
    float hz = smoothstep( -0.01, 0.02, up ) * exp( -u / 0.07 );
    // (|nsTown.xy| = how directional: all round inside the town, a patch over it from afar)
    float tw = mix( 1.0, pow( max( 0.0, dot( normalize( d.xz + 1e-5 ), normalize( nsTown.xy + 1e-5 ) ) ), 3.0 ), min( 1.0, length( nsTown.xy ) ) ) * nsTown.z;
    vec3 g = vec3( 0.42, 0.62, 0.36 ) * ag * 0.0035 + vec3( 0.5, 0.56, 0.68 ) * hz * 0.004 + vec3( 1.0, 0.66, 0.36 ) * hz * tw * 0.006;
    return g * nsK.x;
  }
`;

const D2R = Math.PI / 180;
/** Red Sea latitude. */
const LAT = 28 * D2R;
/** The galactic centre (RA 17.76 h) crosses the meridian at 20:15 (a late summer evening). */
const GC_RA = 17.76;
const GC_TRANSIT = 20.25;
/** South in the classic view frame: the azimuth of the sun's noon (atmos.ts SUN_PATH). */
const SOUTH_AZ = 222 * D2R;
const SYNODIC = 29.53;

function eq(raDeg: number, decDeg: number) {
  const a = raDeg * D2R;
  const d = decDeg * D2R;
  return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)] as const;
}
// J2000 galactic frame in equatorial coordinates
const GAL_C = eq(266.405, -28.936);
const GAL_N = eq(192.859, 27.128);
const GAL_Y = eq(318.004, 48.33);

/** Lunar age (days since new moon) on the evening of night n of a match (seeded, render only). */
export function moonAge(seed: number, night: number): number {
  let h = (seed ^ 0x6d2b79f5) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  // a crescent to a waxing gibbous on the first night (never a full moon washing the Milky Way out at
  // the start), one day older every night
  return 3 + (h / 4294967296) * 6.5 + night;
}

/** Illuminated fraction of the moon at a lunar age (days). */
export function moonIllum(age: number): number {
  return (1 - Math.cos((2 * Math.PI * age) / SYNODIC)) / 2;
}

/**
 * Drives NSKY from the clock, the view rotation, the moon and the weather (CPU side, a few vectors per frame).
 */
export class NightSkyDriver {
  /** Lunar age override (days; debug / screenshots, ?moonage=). */
  ageOverride: number | null = null;
  /** Direction from the moon towards the sun, for the disc's phase (world). */
  readonly moonSun = new THREE.Vector3(0, 0, 1);
  /** Moon brightness 0..1 (its glow; 1 = full moon). */
  moonGlow = 0;
  private north = new THREE.Vector3();
  private west = new THREE.Vector3();
  private pole = new THREE.Vector3();
  private x0 = new THREE.Vector3();
  private A = new THREE.Vector3();
  private B = new THREE.Vector3();
  private t = new THREE.Vector3();
  private town: THREE.Vector2 | null;

  constructor(
    private seed: number,
    town: { x: number; z: number } | null,
  ) {
    this.town = town ? new THREE.Vector2(town.x, town.z) : null;
    NSKY.nsNoise.value = noiseTexture();
    NSKY.nsK.value.set(0, 0, 0, 0);
    const m = typeof location !== 'undefined' ? /[?&]moonage=([\d.]+)/.exec(location.search) : null;
    if (m) this.ageOverride = +m[1];
  }

  /** Galactic centre direction (world), e.g. to aim a camera at it. */
  get galCentre(): THREE.Vector3 {
    return NSKY.nsGalC.value;
  }

  /**
   * hours: the clock hour (absolute, days included), yaw: the view rotation (the sky turns with it, like the
   * sun), vis: night x clear sky (0 skips the shader work), moon / sun: world directions (moon null by day).
   */
  update(hours: number, yaw: number, vis: number, dust: number, time: number, moon: THREE.Vector3 | null, sun: THREE.Vector3) {
    const N = this.north.set(-Math.cos(SOUTH_AZ), 0, -Math.sin(SOUTH_AZ)).applyAxisAngle(THREE.Object3D.DEFAULT_UP, -yaw);
    // west: where the sun sets (the classic frame's compass is mirrored, so it is N x up)
    const W = this.west.crossVectors(N, THREE.Object3D.DEFAULT_UP).normalize();
    const P = this.pole.copy(N).multiplyScalar(Math.cos(LAT)).addScaledVector(THREE.Object3D.DEFAULT_UP, Math.sin(LAT));
    // the celestial equator on the meridian (above the south)
    const x0 = this.x0.copy(N).multiplyScalar(-Math.sin(LAT)).addScaledVector(THREE.Object3D.DEFAULT_UP, Math.cos(LAT));
    const hod = ((hours % 24) + 24) % 24;
    const lst = (GC_RA + (hod - GC_TRANSIT) * 1.0027379) * 15 * D2R;
    // RA 0h and 6h on the sky now (hour angle = LST - RA; it grows towards the west)
    const A = this.A.copy(x0).multiplyScalar(Math.cos(lst)).addScaledVector(W, Math.sin(lst));
    const B = this.B.copy(x0).multiplyScalar(Math.sin(lst)).addScaledVector(W, -Math.cos(lst));
    NSKY.nsRot.value.set(A.x, A.y, A.z, B.x, B.y, B.z, P.x, P.y, P.z);
    const toWorld = (v: readonly [number, number, number], out: THREE.Vector3) => out.copy(A).multiplyScalar(v[0]).addScaledVector(B, v[1]).addScaledVector(P, v[2]);
    toWorld(GAL_N, NSKY.nsGalN.value);
    toWorld(GAL_C, NSKY.nsGalC.value);
    const y = toWorld(GAL_Y, NSKY.nsGalY.value);
    // (exactly orthogonal to the pole and the centre)
    y.addScaledVector(NSKY.nsGalN.value, -y.dot(NSKY.nsGalN.value)).addScaledVector(NSKY.nsGalC.value, -y.dot(NSKY.nsGalC.value)).normalize();
    // the moon: phase of tonight (nights are counted from noon to noon)
    const night = Math.floor((hours - 12) / 24);
    const age = this.ageOverride ?? moonAge(this.seed, Math.max(0, night)) + (hours - 12 - night * 24) / 24;
    const illum = moonIllum(age);
    this.moonGlow = moon ? illum * illum : 0;
    if (moon) {
      NSKY.nsMoon.value.set(moon.x, moon.y, moon.z, this.moonGlow);
      // the lit limb faces the sun: phase angle from the illuminated fraction
      const th = Math.acos(Math.max(-1, Math.min(1, 2 * illum - 1)));
      const e = this.t.copy(sun).addScaledVector(moon, -sun.dot(moon));
      if (e.lengthSq() < 1e-6) e.set(0, -1, 0).addScaledVector(moon, moon.y);
      e.normalize();
      this.moonSun.copy(moon).multiplyScalar(-Math.cos(th)).addScaledVector(e, Math.sin(th));
    } else NSKY.nsMoon.value.w = 0;
    NSKY.nsK.value.set(vis, dust, time, 0.026);
  }

  /** More places whose gentle lights glow on the horizon (villages, resorts: fx/desertnight). */
  places: THREE.Vector2[] = [];

  /** Per camera (the main view and the water reflection): the direction to the nearest town's gentle lights. */
  camera(pos: THREE.Vector3) {
    const t = NSKY.nsTown.value;
    if (!this.town) {
      t.z = 0;
      return;
    }
    // (the nearest of the lit places: the oasis town and the villages / resorts the desert night lights name)
    let tx = this.town.x;
    let tz = this.town.y;
    let best = Math.hypot(tx - pos.x, tz - pos.z);
    for (const p of this.places) {
      const dd = Math.hypot(p.x - pos.x, p.y - pos.z);
      if (dd < best) {
        best = dd;
        tx = p.x;
        tz = p.y;
      }
    }
    const dx = tx - pos.x;
    const dz = tz - pos.z;
    const d = Math.hypot(dx, dz);
    // inside the town its lights are all round (a weaker glow), from afar a warm patch over it
    const k = Math.min(1, d / 14) / Math.max(1e-3, d);
    t.set(dx * k, dz * k, 0.6 + 0.4 * Math.min(1, d / 20));
  }
}
