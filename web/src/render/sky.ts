import * as THREE from 'three';
import type { FogOfWar } from './fog';
import { HDRI_APPLY, HDRI_PARS, SkyHdri } from './skyhdri';
import { HORIZON } from './horizon';

/*
 * Physical sky (seen in photo mode, the intro flyover, cinematic and low
 * camera angles, and in the water's planar reflection).
 *
 * - Atmosphere: single-scattering Rayleigh + Mie ray-march (16 x 8 steps)
 *   rendered into a small equirectangular lookup texture (128 x 64, half
 *   float) only when the sun / moon or the weather has moved noticeably. The
 *   dome samples it per pixel, so the per-frame cost is a texture fetch plus
 *   the clouds. Sunset colours, the blue hour and moonlit night skies come out
 *   of the model by themselves (night = the moon as a faint light source).
 * - Clouds: a procedural, wind-driven 2.5D layer (fbm of the shared noise
 *   texture projected on a cloud deck) with self-shadowing taps towards the
 *   sun and a forward-scattering silver lining (3 taps + an extra octave on
 *   high, 1 tap on medium). Cover and darkness follow the weather (storm =
 *   low, dark overcast). Stars twinkle at night, the sun and moon are drawn
 *   as limb-darkened discs bright enough to bloom.
 * - Horizon: below / at the horizon the dome fades into the same horizon
 *   colour the outskirts' far ground is blended to (fog.ts skyHor*), so the
 *   countryside melts into the sky without a seam.
 * - Environment lighting (high quality): the sky (without the sun disc) is
 *   re-captured into a PMREM environment every few seconds when it changed,
 *   with the structure of three photographed HDRIs blended in (skyhdri.ts).
 *
 * No program is ever recompiled: quality picks the defines once at creation.
 */

export interface SkyState {
  /** Direction towards the sun (world, normalised). May be below the horizon. */
  sun: THREE.Vector3;
  /** Direction towards the moon, or null by day. */
  moon: THREE.Vector3 | null;
  /** 0 = day .. 1 = night (scales the moonlit sky / stars). */
  night: number;
  /** Cloud cover 0..1. */
  cover: number;
  /** Storm darkness 0..1. */
  storm: number;
  /** Dust in the air (sandstorm) 0..1. */
  dust: number;
}

const ATMO_GLSL = /* glsl */ `
  #define PI 3.141592
  vec2 rsi( vec3 r0, vec3 rd, float sr ) {
    float a = dot( rd, rd );
    float b = 2.0 * dot( rd, r0 );
    float c = dot( r0, r0 ) - sr * sr;
    float d = b * b - 4.0 * a * c;
    if ( d < 0.0 ) return vec2( 1e5, -1e5 );
    return vec2( ( -b - sqrt( d ) ) / ( 2.0 * a ), ( -b + sqrt( d ) ) / ( 2.0 * a ) );
  }
  // Rayleigh + Mie single scattering (after wwwtyro/glsl-atmosphere, MIT)
  vec3 atmosphere( vec3 r, vec3 pSun ) {
    const float rPlanet = 6371e3;
    const float rAtmos = 6471e3;
    const vec3 kRlh = vec3( 5.5e-6, 13.0e-6, 22.4e-6 );
    const float kMie = 21e-6;
    const float shRlh = 8e3;
    const float shMie = 1.2e3;
    const float g = 0.76;
    vec3 r0 = vec3( 0.0, 6372e3, 0.0 );
    vec2 p = rsi( r0, r, rAtmos );
    if ( p.x > p.y ) return vec3( 0.0 );
    p.y = min( p.y, rsi( r0, r, rPlanet ).x );
    float iStepSize = ( p.y - p.x ) / 16.0;
    float iTime = 0.0;
    vec3 totalRlh = vec3( 0.0 );
    vec3 totalMie = vec3( 0.0 );
    float iOdRlh = 0.0;
    float iOdMie = 0.0;
    float mu = dot( r, pSun );
    float mumu = mu * mu;
    float gg = g * g;
    float pRlh = 3.0 / ( 16.0 * PI ) * ( 1.0 + mumu );
    float pMie = 3.0 / ( 8.0 * PI ) * ( ( 1.0 - gg ) * ( mumu + 1.0 ) ) / ( pow( 1.0 + gg - 2.0 * mu * g, 1.5 ) * ( 2.0 + gg ) );
    for ( int i = 0; i < 16; i++ ) {
      vec3 iPos = r0 + r * ( iTime + iStepSize * 0.5 );
      float iHeight = length( iPos ) - rPlanet;
      float odStepRlh = exp( -iHeight / shRlh ) * iStepSize;
      float odStepMie = exp( -iHeight / shMie ) * iStepSize;
      iOdRlh += odStepRlh;
      iOdMie += odStepMie;
      float jStepSize = rsi( iPos, pSun, rAtmos ).y / 8.0;
      float jTime = 0.0;
      float jOdRlh = 0.0;
      float jOdMie = 0.0;
      for ( int j = 0; j < 8; j++ ) {
        vec3 jPos = iPos + pSun * ( jTime + jStepSize * 0.5 );
        float jHeight = length( jPos ) - rPlanet;
        jOdRlh += exp( -jHeight / shRlh ) * jStepSize;
        jOdMie += exp( -jHeight / shMie ) * jStepSize;
        jTime += jStepSize;
      }
      vec3 attn = exp( -( kMie * ( iOdMie + jOdMie ) + kRlh * ( iOdRlh + jOdRlh ) ) );
      totalRlh += odStepRlh * attn;
      totalMie += odStepMie * attn;
      iTime += iStepSize;
    }
    return 22.0 * ( pRlh * kRlh * totalRlh + pMie * kMie * totalMie );
  }
`;

/** Equirect LUT addressing: more rows near the horizon. */
const LUT_GLSL = /* glsl */ `
  vec2 skyUv( vec3 d ) {
    // (atan(0, 0) is undefined: at the zenith / nadir it returns NaN on some GPUs, which the water and bloom then smear)
    float az = atan( d.z, abs( d.x ) < 1e-5 ? 1e-5 : d.x );
    float el = asin( clamp( d.y, -1.0, 1.0 ) );
    float v = 0.5 + 0.5 * sign( el ) * sqrt( abs( el ) / 1.5707963 );
    return vec2( az / 6.2831853 + 0.5, v );
  }
  vec3 skyDir( vec2 uv ) {
    float az = ( uv.x - 0.5 ) * 6.2831853;
    float s = uv.y * 2.0 - 1.0;
    float el = sign( s ) * s * s * 1.5707963;
    return vec3( cos( el ) * cos( az ), sin( el ), cos( el ) * sin( az ) );
  }
`;

const LUT_FRAG = /* glsl */ `
  ${ATMO_GLSL}
  ${LUT_GLSL}
  uniform vec3 uLight;
  uniform float uScale;
  varying vec2 vUv;
  void main() {
    vec3 d = skyDir( vUv );
    // under the horizon: keep the horizon colour (the dome blends to the far haze there anyway)
    d.y = max( d.y, 0.002 );
    vec3 c = atmosphere( normalize( d ), uLight ) * uScale;
    // soft knee: the bright band around a low sun stays under the bloom threshold (the sun disc blooms)
    c /= 1.0 + max( c.r, max( c.g, c.b ) ) * 0.45;
    if ( any( isnan( c ) ) || any( isinf( c ) ) ) c = vec3( 0.0 );
    gl_FragColor = vec4( c, 1.0 );
  }
`;

const DOME_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    gl_Position = vec4( p.xy, p.w * 0.99999, p.w ); // on the far plane
  }
`;

const DOME_FRAG = /* glsl */ `
  ${LUT_GLSL}
  uniform sampler2D uLut;
  uniform sampler2D uNoise;
  uniform vec3 uSun;
  uniform vec3 uSunCol;
  uniform vec3 uMoon;
  uniform float uMoonOn;
  uniform float uNight;
  uniform float uCover;
  uniform float uStorm;
  uniform float uDust;
  uniform float uTime;
  uniform vec2 uWind;
  uniform vec3 uHorA;
  uniform vec3 uHorB;
  uniform vec2 uSunXZ;
  uniform float uEnv;
  uniform float uGray;
  uniform vec4 uMeteorA;
  uniform vec4 uMeteorB;
  varying vec3 vDir;
  #ifdef HDRI
  ${HDRI_PARS}
  #endif
  float h13( vec3 p ) {
    p = fract( p * 0.1031 );
    p += dot( p, p.zyx + 31.32 );
    return fract( ( p.x + p.y ) * p.z );
  }
  float cloudD( vec2 uv ) {
    float n = texture2D( uNoise, uv ).b * 0.55 + texture2D( uNoise, uv * 2.3 + 0.37 ).a * 0.3;
    #ifdef HQ
    n += texture2D( uNoise, uv * 5.7 + 0.71 ).g * 0.15;
    #else
    n += 0.07;
    #endif
    n = ( n - 0.5 ) * 2.2 + 0.5; // the summed octaves are low-contrast: stretch them
    float c = 1.0 - uCover;
    return smoothstep( c * 0.6 + 0.15, c * 0.6 + 0.45, n );
  }
  void main() {
    vec3 d = normalize( vDir );
    vec3 sky = texture2D( uLut, skyUv( d ) ).rgb;
    float l = dot( sky, vec3( 0.2126, 0.7152, 0.0722 ) );
    // overcast: the whole sky turns to a flat grey of the same brightness, storms darker
    float over = smoothstep( 0.45, 1.0, uCover );
    sky = mix( sky, vec3( l * 1.1 ) * vec3( 0.93, 0.97, 1.02 ), over * 0.85 );
    sky *= 1.0 - 0.6 * uStorm;
    sky = mix( sky, vec3( l ) * vec3( 1.25, 0.95, 0.62 ), uDust * 0.85 );
    vec3 col = sky;
    float up = d.y;
    // stars
    if ( uNight > 0.01 && up > 0.0 ) {
      vec3 sp = d * 220.0;
      vec3 cell = floor( sp );
      float h = h13( cell );
      if ( h > 0.985 ) {
        vec3 c = cell + vec3( h13( cell + 7.1 ), h13( cell + 3.3 ), h13( cell + 1.7 ) );
        float r = length( sp - c );
        float tw = 0.65 + 0.35 * sin( uTime * ( 1.5 + h * 7.0 ) + h * 40.0 );
        float b = ( 1.0 - smoothstep( 0.0, 0.42, r ) ) * ( h - 0.985 ) * 66.0 * tw;
        col += vec3( 0.85, 0.9, 1.0 ) * b * 0.5 * uNight * ( 1.0 - over ) * smoothstep( 0.0, 0.25, up );
      }
    }
    // shooting star: a short bright streak whose head runs from uMeteorA.xyz to uMeteorB.xyz (w: brightness, progress)
    if ( uMeteorA.w > 0.001 && up > 0.0 && uEnv < 0.5 ) {
      vec3 mh = normalize( mix( uMeteorA.xyz, uMeteorB.xyz, uMeteorB.w ) );
      vec3 mt = normalize( mix( uMeteorA.xyz, uMeteorB.xyz, max( 0.0, uMeteorB.w - 0.4 ) ) );
      vec3 ms = mh - mt;
      float mk = clamp( dot( d - mt, ms ) / max( 1e-7, dot( ms, ms ) ), 0.0, 1.0 );
      float md = length( d - mt - ms * mk );
      float mw = mix( 0.0006, 0.0016, mk );
      col += vec3( 0.85, 0.92, 1.0 ) * exp( -md * md / ( mw * mw ) ) * mk * mk * uMeteorA.w * 3.0 * ( 1.0 - over );
    }
    // sun / moon discs (not in the environment capture)
    float cs = dot( d, uSun );
    if ( uEnv < 0.5 ) {
      float disc = smoothstep( 0.99985, 0.99993, cs );
      float limb = 0.6 + 0.4 * sqrt( max( 0.0, 1.0 - ( 1.0 - cs ) / 0.00015 ) );
      col += uSunCol * disc * limb * 40.0 * ( 1.0 - over ) * smoothstep( -0.02, 0.02, uSun.y );
      if ( uMoonOn > 0.5 ) {
        float cm = dot( d, uMoon );
        col += vec3( 0.75, 0.8, 0.9 ) * smoothstep( 0.99975, 0.99982, cm ) * 2.2 * ( 1.0 - over );
        col += vec3( 0.06, 0.08, 0.12 ) * pow( max( cm, 0.0 ), 400.0 ) * ( 1.0 - over );
      }
    }
    // clouds: a deck projected over the sky, drifting with the wind
    if ( up > 0.0 ) {
      vec2 uv = d.xz / ( up + 0.12 ) * 0.09 + uWind * uTime;
      float dens = cloudD( uv );
      if ( dens > 0.001 ) {
        vec2 ts = uSunXZ * 0.035;
        float sh = cloudD( uv + ts );
        #ifdef HQ
        sh += cloudD( uv + ts * 2.0 ) * 0.7 + cloudD( uv + ts * 3.5 ) * 0.5;
        sh /= 2.2;
        #endif
        float lit = exp( -sh * 2.6 );
        float g = 0.6;
        float ph = ( 1.0 - g * g ) / pow( 1.0 + g * g - 2.0 * g * cs, 1.5 ) * 0.08;
        vec3 zen = texture2D( uLut, vec2( 0.25, 0.98 ) ).rgb;
        float day = smoothstep( -0.08, 0.15, uSun.y );
        vec3 sunC = uSunCol * day;
        vec3 cc = sunC * ( lit * 0.55 + ph * ( 1.0 - dens * 0.6 ) ) + ( zen * 0.9 + vec3( l * 0.6 ) ) * ( 0.7 - 0.3 * dens );
        cc = mix( cc, vec3( l * 0.9 + 0.003 ), over * 0.6 );
        cc *= 1.0 - 0.7 * uStorm * ( 0.4 + 0.6 * dens );
        cc = mix( cc, cc * vec3( 1.2, 0.95, 0.65 ), uDust );
        float a = dens * smoothstep( 0.0, 0.18, up );
        col = mix( col, cc, a );
      }
    }
    // horizon: fade into the far haze colour of the outskirts (no seam with the ground)
    vec2 vd = normalize( d.xz + 1e-5 );
    vec3 hz = mix( uHorB, uHorA, dot( vd, uSunXZ ) * 0.5 + 0.5 );
    col = mix( col, hz, 1.0 - smoothstep( -0.02, 0.09, up ) );
    if ( uEnv > 0.5 && up < 0.0 ) col = mix( hz, vec3( uGray ), ( 1.0 - smoothstep( -0.4, 0.0, up ) ) );
    #ifdef HDRI
    ${HDRI_APPLY}
    #endif
    if ( any( isnan( col ) ) ) col = vec3( 0.0 );
    gl_FragColor = vec4( col, 1.0 );
  }
`;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** CPU port of the atmosphere integral (horizon colours for the fog / outskirts; a handful of rays). */
function atmosphereJS(r: THREE.Vector3, sun: THREE.Vector3, out: THREE.Vector3) {
  const rP = 6371e3;
  const rA = 6471e3;
  const kR = [5.5e-6, 13.0e-6, 22.4e-6];
  const kM = 21e-6;
  const g = 0.76;
  const rsi = (o: number[], d: THREE.Vector3, sr: number) => {
    const b = 2 * (d.x * o[0] + d.y * o[1] + d.z * o[2]);
    const c = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - sr * sr;
    const disc = b * b - 4 * c;
    if (disc < 0) return [1e5, -1e5];
    const q = Math.sqrt(disc);
    return [(-b - q) / 2, (-b + q) / 2];
  };
  const r0 = [0, 6372e3, 0];
  const p = rsi(r0, r, rA);
  p[1] = Math.min(p[1], rsi(r0, r, rP)[0]);
  const st = (p[1] - p[0]) / 16;
  let t = 0;
  const tR = [0, 0, 0];
  let tM = 0;
  let oR = 0;
  let oM = 0;
  const mu = r.dot(sun);
  const pR = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const pM = ((3 / (8 * Math.PI)) * ((1 - g * g) * (mu * mu + 1))) / (Math.pow(1 + g * g - 2 * mu * g, 1.5) * (2 + g * g));
  for (let i = 0; i < 16; i++) {
    const ip = [r0[0] + r.x * (t + st / 2), r0[1] + r.y * (t + st / 2), r0[2] + r.z * (t + st / 2)];
    const h = Math.hypot(ip[0], ip[1], ip[2]) - rP;
    const dR = Math.exp(-h / 8e3) * st;
    const dM = Math.exp(-h / 1.2e3) * st;
    oR += dR;
    oM += dM;
    const js = rsi(ip, sun, rA)[1] / 8;
    let jt = 0;
    let jR = 0;
    let jM = 0;
    for (let j = 0; j < 8; j++) {
      const jx = ip[0] + sun.x * (jt + js / 2);
      const jy = ip[1] + sun.y * (jt + js / 2);
      const jz = ip[2] + sun.z * (jt + js / 2);
      const jh = Math.hypot(jx, jy, jz) - rP;
      jR += Math.exp(-jh / 8e3) * js;
      jM += Math.exp(-jh / 1.2e3) * js;
      jt += js;
    }
    for (let c = 0; c < 3; c++) tR[c] += dR * Math.exp(-(kM * (oM + jM) + kR[c] * (oR + jR)));
    tM += dM * Math.exp(-(kM * (oM + jM) + kR[1] * (oR + jR)));
    t += st;
  }
  return out.set(22 * (pR * kR[0] * tR[0] + pM * kM * tM), 22 * (pR * kR[1] * tR[1] + pM * kM * tM), 22 * (pR * kR[2] * tR[2] + pM * kM * tM));
}

export class Sky {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private lut: THREE.WebGLRenderTarget;
  private lutMat: THREE.ShaderMaterial;
  private lutScene = new THREE.Scene();
  private lutCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private lastLight = new THREE.Vector3(0, -2, 0);
  private lastScale = -1;
  private envScene: THREE.Scene | null = null;
  private envMat: THREE.ShaderMaterial | null = null;
  private pmrem: THREE.PMREMGenerator | null = null;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envKey = new THREE.Vector3(9, 9, 9);
  private envCover = -1;
  private envAt = -1e9;
  private time = 0;
  /** 0..1: how much the far ground blends into the sky's horizon colour (free cameras only). */
  private horizon = 0;
  private horA = new THREE.Vector3();
  private horB = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private lerpTmp = new THREE.Vector3();
  private sunXZ = new THREE.Vector2(1, 0);
  private lightN = new THREE.Vector3();
  /** The environment map captured from the sky (high quality); null until the first capture. */
  env: THREE.Texture | null = null;
  /** Photographed HDRIs blended into the capture (high quality; ?photo=0 turns them off). */
  private hdri: SkyHdri | null = null;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private fog: FogOfWar,
    private quality: 'medium' | 'high',
    readonly envCapture: boolean,
  ) {
    const half = renderer.capabilities.isWebGL2 && renderer.extensions.has('EXT_color_buffer_float');
    this.lut = new THREE.WebGLRenderTarget(128, 64, { type: half ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: false });
    this.lut.texture.wrapS = THREE.RepeatWrapping;
    this.lut.texture.minFilter = this.lut.texture.magFilter = THREE.LinearFilter;
    this.lutMat = new THREE.ShaderMaterial({
      uniforms: { uLight: { value: new THREE.Vector3(0, 1, 0) }, uScale: { value: 1 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }',
      fragmentShader: LUT_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.lutScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.lutMat));
    if (envCapture && !(typeof location !== 'undefined' && /[?&]photo=0\b/.test(location.search)))
      this.hdri = new SkyHdri(() => this.envKey.set(9, 9, 9));
    this.mat = this.domeMaterial(false);
    // a unit sphere drawn on the far plane around whichever camera renders it (main view, water reflection)
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.mat);
    this.mesh.name = 'sky';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.onBeforeRender = (_r, _s, cam) => {
      this.mesh.position.copy(cam.position);
      const far = (cam as THREE.PerspectiveCamera).far ?? 400;
      this.mesh.scale.setScalar(far * 0.5);
      this.mesh.updateMatrixWorld();
    };
  }

  private domeMaterial(env: boolean) {
    const fu = this.fog.uniforms;
    const hd = env ? this.hdri : null;
    return new THREE.ShaderMaterial({
      defines: { ...(this.quality === 'high' ? { HQ: 1 } : {}), ...(hd ? { HDRI: 1 } : {}) },
      uniforms: {
        uLut: { value: this.lut.texture },
        uNoise: fu.fogNoise,
        uSun: { value: new THREE.Vector3(0, 1, 0) },
        uSunCol: { value: new THREE.Color(1, 0.95, 0.9) },
        uMoon: { value: new THREE.Vector3(0, 1, 0) },
        uMoonOn: { value: 0 },
        uNight: { value: 0 },
        uCover: { value: 0.3 },
        uStorm: { value: 0 },
        uDust: { value: 0 },
        uTime: { value: 0 },
        uWind: { value: new THREE.Vector2(0.004, 0.0015) },
        uHorA: { value: new THREE.Vector3() },
        uHorB: { value: new THREE.Vector3() },
        uSunXZ: { value: new THREE.Vector2(1, 0) },
        uEnv: { value: env ? 1 : 0 },
        uGray: { value: 0.05 },
        uMeteorA: { value: new THREE.Vector4() },
        uMeteorB: { value: new THREE.Vector4() },
        ...(hd ? hd.uniforms : {}),
      },
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    });
  }

  /** Free (photo / intro / cinematic) cameras see the horizon: blend the far outskirts into the sky. */
  setFreeView(free: boolean, dt: number) {
    const goal = free ? 1 : 0;
    this.horizon += Math.sign(goal - this.horizon) * Math.min(Math.abs(goal - this.horizon), dt * 1.5);
  }

  /**
   * Per frame: follow the sun / moon / weather. Re-renders the scattering LUT only when the light moved
   * (> ~0.3 deg) or the brightness changed; the environment capture at most every 2 s (high quality).
   */
  update(dt: number, st: SkyState, sunCol: THREE.Color, ground: THREE.Color) {
    this.time += dt;
    this.meteors(dt, st.night * (1 - smooth(0.45, 1, st.cover)));
    const night = st.night;
    // by night the moon lights the (much fainter) sky: same scattering model, different source
    const src = st.moon && night > 0.5 ? st.moon : st.sun;
    // never feed a degenerate direction to the scattering integral (it would fill the LUT with NaN for good)
    if (!(src.lengthSq() > 0.25)) return;
    const light = this.lightN.copy(src).normalize();
    const scale = 0.62 * (st.moon && night > 0.5 ? 0.012 + 0.03 * (1 - night) : 1);
    if (!(light.dot(this.lastLight) >= 0.99998) || Math.abs(scale - this.lastScale) > this.lastScale * 0.02) {
      this.lastLight.copy(light);
      this.lastScale = scale;
      this.lutMat.uniforms.uLight.value.copy(light);
      this.lutMat.uniforms.uScale.value = scale;
      const prev = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(this.lut);
      this.renderer.render(this.lutScene, this.lutCam);
      this.renderer.setRenderTarget(prev);
      // horizon colours towards / away from the light (for the far ground and the dome's horizon band)
      this.sunXZ.set(light.x, light.z);
      if (this.sunXZ.lengthSq() < 1e-6) this.sunXZ.set(1, 0);
      this.sunXZ.normalize();
      for (const [v, k] of [[this.horA, 1], [this.horB, -1]] as const) {
        atmosphereJS(this.tmp.set(this.sunXZ.x * k, 0.02, this.sunXZ.y * k).normalize(), light, v).multiplyScalar(scale);
        v.divideScalar(1 + Math.max(v.x, v.y, v.z) * 0.45);
      }
    }
    // weather on the horizon colours (same as the dome shader)
    const over = smooth(0.45, 1, st.cover);
    const A = this.tmp.copy(this.horA);
    const B = this.tmp2.copy(this.horB);
    for (const v of [A, B]) {
      const l = v.x * 0.2126 + v.y * 0.7152 + v.z * 0.0722;
      this.lerpTmp.set(l * 1.1 * 0.93, l * 1.1 * 0.97, l * 1.1 * 1.02);
      v.lerp(this.lerpTmp, over * 0.85).multiplyScalar(1 - 0.6 * st.storm);
      this.lerpTmp.set(l * 1.25, l * 0.95, l * 0.62);
      v.lerp(this.lerpTmp, st.dust * 0.85);
      // a hazy horizon is a little paler / darker than the clear-sky band right above it
      v.multiplyScalar(0.85);
    }
    for (const m of this.envMat ? [this.mat, this.envMat] : [this.mat]) {
      const u = m.uniforms;
      u.uSun.value.copy(st.sun);
      u.uSunCol.value.copy(sunCol);
      u.uMoonOn.value = st.moon ? 1 : 0;
      if (st.moon) u.uMoon.value.copy(st.moon);
      u.uNight.value = night;
      u.uCover.value = st.cover;
      u.uStorm.value = st.storm;
      u.uDust.value = st.dust;
      u.uTime.value = this.time;
      u.uHorA.value.copy(A);
      u.uHorB.value.copy(B);
      u.uSunXZ.value.copy(this.sunXZ);
      u.uGray.value = ground.r * 0.2126 + ground.g * 0.7152 + ground.b * 0.0722;
    }
    const fu = this.fog.uniforms;
    fu.skyHorA.value.set(A.x, A.y, A.z, this.horizon);
    fu.skyHorB.value.set(B.x, B.y, B.z, 0);
    fu.skySunXZ.value.copy(this.sunXZ);
    // the far ring (horizon.ts) melts into this horizon colour; bad weather thickens the air
    HORIZON.hzSky.value = 1;
    HORIZON.hzDens.value = (1 / 520) * (1 + 2.2 * over + 2.5 * st.storm + 4 * st.dust);
    if (this.hdri?.update(st.sun, st.cover, night)) this.envKey.set(9, 9, 9);
    if (this.envCapture) this.captureEnv(light, st);
  }

  private meteorT = 0;
  private meteorNext = 4;
  private meteorDur = 0;

  /** Now and then a shooting star on a clear night (uniforms only; purely visual randomness). */
  private meteors(dt: number, clear: number) {
    const a = this.mat.uniforms.uMeteorA.value as THREE.Vector4;
    const b = this.mat.uniforms.uMeteorB.value as THREE.Vector4;
    if (this.meteorDur > 0) {
      this.meteorT += dt;
      const k = this.meteorT / this.meteorDur;
      if (k >= 1) {
        this.meteorDur = 0;
        a.w = 0;
        this.meteorNext = 2.5 + Math.random() * 9;
        return;
      }
      b.w = k;
      a.w = Math.sin(Math.PI * Math.min(1, k * 1.15)) * (0.6 + 0.4 * clear);
      return;
    }
    a.w = 0;
    if (clear < 0.4) return;
    this.meteorNext -= dt;
    if (this.meteorNext > 0) return;
    const az = Math.random() * Math.PI * 2;
    const el = 0.45 + Math.random() * 0.7;
    a.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az), 0);
    // a 15-30 degree run across the sky, mostly sideways and a little down
    const side = Math.random() < 0.5 ? 1 : -1;
    const run = 0.26 + Math.random() * 0.26;
    const tx = -Math.sin(az) * side;
    const tz = Math.cos(az) * side;
    const dn = 0.3 + Math.random() * 0.5;
    const ty = -dn * Math.cos(el);
    b.set(a.x + (tx - dn * Math.sin(el) * Math.cos(az)) * run, a.y + ty * run, a.z + (tz - dn * Math.sin(el) * Math.sin(az)) * run, 0);
    const L = Math.hypot(b.x, b.y, b.z) || 1;
    b.x /= L;
    b.y /= L;
    b.z /= L;
    this.meteorT = 0;
    this.meteorDur = 0.45 + Math.random() * 0.5;
  }

  /** The GPU contents are gone (WebGL context restored): re-render the scattering LUT and the environment. */
  invalidate() {
    this.lastScale = -1;
    this.lastLight.set(0, -2, 0);
    this.envKey.set(9, 9, 9);
    this.envAt = -1e9;
  }

  private captureEnv(light: THREE.Vector3, st: SkyState) {
    const changed = light.distanceTo(this.envKey) > 0.035 || Math.abs(st.cover - this.envCover) > 0.08;
    if (!changed || this.time - this.envAt < 2) return;
    this.envKey.copy(light);
    this.envCover = st.cover;
    this.envAt = this.time;
    if (!this.envScene) {
      this.envScene = new THREE.Scene();
      this.envMat = this.domeMaterial(true);
      this.envMat.uniforms.uSun.value.copy(this.mat.uniforms.uSun.value);
      const m = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), this.envMat);
      this.envScene.add(m);
      this.pmrem = new THREE.PMREMGenerator(this.renderer);
      for (const k of ['uSunCol', 'uMoonOn', 'uMoon', 'uNight', 'uCover', 'uStorm', 'uDust', 'uTime', 'uHorA', 'uHorB', 'uSunXZ', 'uGray'] as const) {
        const v = this.mat.uniforms[k].value;
        this.envMat.uniforms[k].value = typeof v === 'number' ? v : v.clone();
      }
    }
    const prev = this.renderer.getRenderTarget();
    const rt = this.pmrem!.fromScene(this.envScene, 0, 0.1, 100, { size: 128 });
    this.renderer.setRenderTarget(prev);
    this.envRT?.dispose();
    this.envRT = rt;
    this.env = rt.texture;
  }

  dispose() {
    this.lut.dispose();
    this.lutMat.dispose();
    this.mat.dispose();
    this.envMat?.dispose();
    this.envRT?.dispose();
    this.pmrem?.dispose();
    this.mesh.geometry.dispose();
  }
}
