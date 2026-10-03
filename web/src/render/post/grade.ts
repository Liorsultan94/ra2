import * as THREE from 'three';
import { Blitter, fsMaterial } from './util';

/*
 * Colour grading: a procedurally generated 3D LUT (32^3, stored as a 1024x32
 * strip) driven by the time of day and the weather.
 *
 * A handful of "looks" (classic afternoon, neutral cool noon, warm golden
 * hour, blue-teal night, grey-green rain / storm, ochre sandstorm, clean cold
 * snow) are parameter sets: white balance (temperature / tint), lift / gamma /
 * gain, an S-curve contrast, split toning and a saturation that spares
 * already-saturated colours (team colours, selection rings, muzzle flashes stay
 * vivid when a look desaturates the landscape). Every frame the CPU blends the
 * looks by weights read from the atmosphere (daylight, sun height and colour,
 * rain / storm / dust / snow) into one parameter vector (no allocations);
 * only when that vector moved does a tiny GPU pass re-bake the LUT (32k
 * pixels, a few microseconds). The final pass then grades with two bilinear
 * fetches per pixel, whatever the look.
 *
 * LUT domain: the tone mapper's display-encoded output (gamma 2.2 encoding,
 * 0..1); the LUT also performs the final encode to sRGB.
 */

export const LUT_N = 32;

/** One look (see LOOKS); all values are gentle display-space adjustments. */
interface Look {
  /** White balance: + warmer / - cooler. */
  temp: number;
  /** + magenta / - green. */
  tint: number;
  lift: [number, number, number];
  gamma: [number, number, number];
  gain: [number, number, number];
  sat: number;
  /** 0..1: how much a desaturating look spares strongly saturated colours. */
  protect: number;
  /** 1 = neutral; S-curve strength above 1. */
  contrast: number;
  shadowTint: [number, number, number];
  highTint: [number, number, number];
}

const L = (o: Partial<Look>): Look => ({ temp: 0, tint: 0, lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1], sat: 1, protect: 0.7, contrast: 1.05, shadowTint: [0, 0, 0], highTint: [0, 0, 0], ...o });

const LOOKS = {
  /** The classic late-afternoon battlefield (fixed 'day'): warm light already comes from the sun. */
  // (the tone mapper's punchy AgX look already adds saturation: the daylight looks take some of it back so the
  // grass reads as a natural mid-green, like a good photo, not a neon yellow-green)
  day: L({ temp: 0.01, tint: -0.05, sat: 0.88, contrast: 1.06, shadowTint: [-0.008, 0.0, 0.016], highTint: [0.012, 0.005, -0.01] }),
  /** Midday: neutral, a touch cool and crisp. */
  noon: L({ temp: -0.035, tint: -0.05, sat: 0.85, contrast: 1.05, shadowTint: [-0.008, 0.002, 0.018], highTint: [0.0, 0.002, 0.006] }),
  /**
   * Golden hour / sunrise / sunset: the warmth lives in the key light (atmos.ts), so the look only warms the
   * highlights a little and cools the shadows; no global orange white balance.
   */
  golden: L({ temp: 0.03, sat: 0.9, contrast: 1.06, gain: [1.01, 1.0, 0.985], lift: [0.002, 0.004, 0.01], shadowTint: [-0.016, 0.002, 0.03], highTint: [0.03, 0.012, -0.022] }),
  /** Night: blue-teal, lifted toe so units stay readable, lights left warm so they pop. */
  night: L({ temp: -0.19, tint: 0.012, sat: 0.88, protect: 0.85, contrast: 1.02, lift: [0.002, 0.012, 0.026], gamma: [0.97, 1.02, 1.08], shadowTint: [-0.012, 0.008, 0.034], highTint: [0.022, 0.008, -0.008] }),
  /** Rain: desaturated grey-green, soft contrast, a little haze in the blacks. */
  rain: L({ temp: -0.05, tint: -0.045, sat: 0.7, protect: 0.75, contrast: 1.0, lift: [0.014, 0.019, 0.017], gain: [0.97, 1.0, 0.98], shadowTint: [-0.008, 0.008, 0.006], highTint: [-0.008, 0.008, 0.0] }),
  /** Thunderstorm (on top of rain): darker, flatter, greener. */
  storm: L({ temp: -0.06, tint: -0.04, sat: 0.68, protect: 0.8, contrast: 1.05, lift: [0.008, 0.013, 0.014], gain: [0.93, 0.95, 0.95], shadowTint: [-0.008, 0.008, 0.01], highTint: [-0.006, 0.006, 0.004] }),
  /** Sandstorm: ochre haze, compressed contrast. */
  sand: L({ temp: 0.07, tint: 0.006, sat: 0.84, protect: 0.85, contrast: 0.96, lift: [0.022, 0.016, 0.006], gain: [1.02, 0.99, 0.93], shadowTint: [0.01, 0.004, -0.01], highTint: [0.025, 0.012, -0.025] }),
  /** Snow: clean, cold and bright. */
  snow: L({ temp: -0.07, sat: 0.92, contrast: 1.04, lift: [0.0, 0.004, 0.012], shadowTint: [-0.01, 0.0, 0.026], highTint: [-0.006, 0.0, 0.01] }),
};
type LookKey = keyof typeof LOOKS;
const KEYS = Object.keys(LOOKS) as LookKey[];

/** Parameter vector layout. */
const P_TEMP = 0;
const P_TINT = 1;
const P_LIFT = 2;
const P_GAMMA = 5;
const P_GAIN = 8;
const P_SAT = 11;
const P_PROT = 12;
const P_CON = 13;
const P_SH = 14;
const P_HI = 17;
const P_LEN = 20;

function toVec(l: Look): Float32Array {
  const v = new Float32Array(P_LEN);
  v[P_TEMP] = l.temp;
  v[P_TINT] = l.tint;
  v.set(l.lift, P_LIFT);
  v.set(l.gamma, P_GAMMA);
  v.set(l.gain, P_GAIN);
  v[P_SAT] = l.sat;
  v[P_PROT] = l.protect;
  v[P_CON] = l.contrast;
  v.set(l.shadowTint, P_SH);
  v.set(l.highTint, P_HI);
  return v;
}
const VEC: Record<LookKey, Float32Array> = Object.fromEntries(KEYS.map((k) => [k, toVec(LOOKS[k])])) as Record<LookKey, Float32Array>;

/** What the grade follows (filled by the renderer every frame from the atmosphere). */
export interface GradeInput {
  /** Overall daylight 0 (night) .. 1 (day). */
  daylight: number;
  /** Sine of the key light's elevation (sun by day, moon by night). */
  sunY: number;
  /** Warmth of the key light colour: (r - b) / r of its linear colour (~0.3 noon, ~0.9 sunset, < 0 moonlight). */
  warmth: number;
  /** Rain falling / overcast 0..1, thunderstorm 0..1, dust 0..1, snow 0..1. */
  rain: number;
  storm: number;
  sand: number;
  snow: number;
}

const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const BAKE_FRAG = /* glsl */ `
uniform vec3 wb;
uniform vec3 lift;
uniform vec3 gammaInv;
uniform vec3 gain;
uniform float sat;
uniform float protect;
uniform float contrast;
uniform vec3 shadowTint;
uniform vec3 highTint;
varying vec2 vUv;
const float N = ${LUT_N.toFixed(1)};
const vec3 LUMA = vec3( 0.2126, 0.7152, 0.0722 );
vec3 toSRGB( vec3 c ) { return mix( c * 12.92, 1.055 * pow( c, vec3( 0.41666 ) ) - 0.055, step( 0.0031308, c ) ); }
void main() {
  vec2 px = floor( gl_FragCoord.xy );
  vec3 v = vec3( mod( px.x, N ), px.y, floor( px.x / N ) ) / ( N - 1.0 );
  // white balance in linear light
  vec3 lin = pow( v, vec3( 2.2 ) ) * wb;
  vec3 e = pow( max( lin, 0.0 ), vec3( 1.0 / 2.2 ) );
  // lift / gamma / gain
  e = e * gain + lift * ( 1.0 - e );
  e = pow( max( e, 0.0 ), gammaInv );
  // S-curve contrast (smoothstep blend keeps 0 and 1 fixed: no crushed blacks, no clipped whites)
  e = clamp( e, 0.0, 1.0 );
  e = mix( e, e * e * ( 3.0 - 2.0 * e ), clamp( contrast - 1.0, -0.5, 0.5 ) );
  // split toning
  float l = dot( e, LUMA );
  e += shadowTint * ( 1.0 - smoothstep( 0.0, 0.5, l ) ) + highTint * smoothstep( 0.45, 1.0, l );
  // saturation that spares saturated colours (team colours stay readable in desaturated looks)
  l = dot( e, LUMA );
  float chroma = max( e.r, max( e.g, e.b ) ) - min( e.r, min( e.g, e.b ) );
  // (the band starts above the landscape's chroma: grass and earth follow the look, team colours do not)
  float s = mix( sat, max( sat, 1.0 ), protect * smoothstep( 0.4, 0.8, chroma ) );
  e = clamp( mix( vec3( l ), e, s ), 0.0, 1.0 );
  gl_FragColor = vec4( toSRGB( pow( e, vec3( 2.2 ) ) ), 1.0 );
}`;

/** GLSL for the final pass: the LUT lookup (strip layout, blue = slice). */
export const LUT_GLSL = /* glsl */ `
uniform sampler2D tLut;
vec3 applyLut( vec3 c ) {
  const float N = ${LUT_N.toFixed(1)};
  c = clamp( c, 0.0, 1.0 ) * ( N - 1.0 );
  float b0 = floor( c.b );
  float b1 = min( b0 + 1.0, N - 1.0 );
  vec2 uv = vec2( ( c.r + 0.5 ) / ( N * N ), ( c.g + 0.5 ) / N );
  vec3 a = texture2D( tLut, uv + vec2( b0 / N, 0.0 ) ).rgb;
  vec3 b = texture2D( tLut, uv + vec2( b1 / N, 0.0 ) ).rgb;
  return mix( a, b, c.b - b0 );
}
`;

export class GradeLut {
  readonly target: THREE.WebGLRenderTarget;
  private mat: THREE.ShaderMaterial;
  private cur = new Float32Array(P_LEN);
  private baked = new Float32Array(P_LEN).fill(-99);
  private w: Record<LookKey, number> = Object.fromEntries(KEYS.map((k) => [k, 0])) as Record<LookKey, number>;
  /** Debug: force one look (e.g. 'night'); null = follow the atmosphere. */
  force: LookKey | null = null;
  /** Debug / photo: 0 = identity LUT (no grade), 1 = full grade. */
  amount = 1;
  private bakedAmount = -1;
  bakes = 0;

  constructor() {
    this.target = new THREE.WebGLRenderTarget(LUT_N * LUT_N, LUT_N, { type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    this.target.texture.wrapS = this.target.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.mat = fsMaterial(BAKE_FRAG, {
      wb: { value: new THREE.Vector3(1, 1, 1) },
      lift: { value: new THREE.Vector3() },
      gammaInv: { value: new THREE.Vector3(1, 1, 1) },
      gain: { value: new THREE.Vector3(1, 1, 1) },
      sat: { value: 1 },
      protect: { value: 0.7 },
      contrast: { value: 1 },
      shadowTint: { value: new THREE.Vector3() },
      highTint: { value: new THREE.Vector3() },
    });
  }

  get texture(): THREE.Texture {
    return this.target.texture;
  }

  /** Look weights of the last update (debug / screenshots). */
  weights(): Readonly<Record<LookKey, number>> {
    return this.w;
  }

  /** Blend the looks for this frame; re-bake the LUT when the result moved. */
  update(r: THREE.WebGLRenderer, blit: Blitter, g: GradeInput) {
    const v = this.blend(g);
    let moved = Math.abs(this.amount - this.bakedAmount) > 1e-4;
    for (let i = 0; i < P_LEN && !moved; i++) if (Math.abs(v[i] - this.baked[i]) > 4e-4) moved = true;
    if (!moved) return;
    this.baked.set(v);
    this.bakedAmount = this.amount;
    this.bake(r, blit, v);
  }

  /** The look weights (see weights()) and blended parameter vector for an input (CPU only, no allocation). */
  blend(g: GradeInput): Float32Array {
    const w = this.w;
    for (const k of KEYS) w[k] = 0;
    if (this.force) w[this.force] = 1;
    else {
      // time of day: night by daylight, golden hour by a low or very warm sun, noon by a high sun
      const night = 1 - sstep(0.15, 0.6, g.daylight);
      const golden = Math.max(1 - sstep(0.28, 0.6, g.sunY), sstep(0.8, 0.92, g.warmth)) * (1 - night);
      const noon = sstep(0.62, 0.85, g.sunY) * (1 - golden) * (1 - night);
      w.night = night;
      w.golden = golden;
      w.noon = noon;
      w.day = Math.max(0, 1 - night - golden - noon);
    }
    const v = this.cur;
    v.fill(0);
    for (const k of KEYS) {
      const k1 = w[k];
      if (k1 <= 0) continue;
      const src = VEC[k];
      for (let i = 0; i < P_LEN; i++) v[i] += src[i] * k1;
    }
    if (!this.force) {
      // weather on top (a little of the time of day survives, more of it at night)
      const night = w.night;
      this.toward('rain', Math.min(1, g.rain) * (1 - 0.45 * night));
      this.toward('storm', Math.min(1, g.storm) * (1 - 0.4 * night));
      this.toward('sand', Math.min(1, g.sand) * (1 - 0.5 * night));
      this.toward('snow', Math.min(1, g.snow) * (1 - 0.5 * night));
    }
    return v;
  }

  /** Blended saturation of the last blend (tests / debug). */
  get saturation(): number {
    return this.cur[P_SAT];
  }

  /** Blended white-balance temperature of the last blend (tests / debug). */
  get temperature(): number {
    return this.cur[P_TEMP];
  }

  private toward(k: LookKey, t: number) {
    if (t <= 0.001) return;
    const v = this.cur;
    const src = VEC[k];
    for (let i = 0; i < P_LEN; i++) v[i] += (src[i] - v[i]) * t;
    this.w[k] = t;
  }

  private bake(r: THREE.WebGLRenderer, blit: Blitter, v: Float32Array) {
    const a = this.amount;
    const u = this.mat.uniforms;
    const m = (x: number, n: number) => n + (x - n) * a;
    // white balance gains (luminance kept)
    const t = m(v[P_TEMP], 0);
    const ti = m(v[P_TINT], 0);
    const wr = 1 + 0.55 * t;
    const wg = 1 - 0.5 * ti;
    const wb = 1 - 0.65 * t;
    const lum = 0.2126 * wr + 0.7152 * wg + 0.0722 * wb;
    u.wb.value.set(wr / lum, wg / lum, wb / lum);
    u.lift.value.set(m(v[P_LIFT], 0), m(v[P_LIFT + 1], 0), m(v[P_LIFT + 2], 0));
    u.gammaInv.value.set(1 / m(v[P_GAMMA], 1), 1 / m(v[P_GAMMA + 1], 1), 1 / m(v[P_GAMMA + 2], 1));
    u.gain.value.set(m(v[P_GAIN], 1), m(v[P_GAIN + 1], 1), m(v[P_GAIN + 2], 1));
    u.sat.value = m(v[P_SAT], 1);
    u.protect.value = v[P_PROT];
    u.contrast.value = m(v[P_CON], 1);
    u.shadowTint.value.set(m(v[P_SH], 0), m(v[P_SH + 1], 0), m(v[P_SH + 2], 0));
    u.highTint.value.set(m(v[P_HI], 0), m(v[P_HI + 1], 0), m(v[P_HI + 2], 0));
    const prev = r.getRenderTarget();
    blit.draw(r, this.mat, this.target);
    r.setRenderTarget(prev);
    this.bakes++;
  }

  dispose() {
    this.target.dispose();
    this.mat.dispose();
  }
}
