import * as THREE from 'three';
import { FOG_GLSL, type FogOfWar } from './fog';
import { SAND_FRONT_GLSL } from './wxuniforms';

/*
 * The haboob (DP1): the dust wall at the head of a desert sandstorm (render only). As the storm arrives
 * (sandstorm.ts: the front's leading edge on the seeded weather timeline) a huge rolling wall of dust advances
 * across the map from upwind: a tall, billowing, cauliflower-topped front, its billow tops lit by the sun (amber
 * at the golden hour), its base dark and dense, boiling as it rolls on. As the head passes over the view it
 * thins away into the sandstorm look behind it (the grade, the haze, the blowing sand: atmos.ts / sandstorm.ts),
 * which dissipates with the storm.
 *
 * Volumetric-looking layered cards: rows of big camera-facing billow puffs strung along the front, layer behind
 * layer (a low nose in front rising to the towering head behind), one instanced draw. Each puff's silhouette,
 * density and light come from world-space billow noise (stable as the rows wrap round the view along the front),
 * lit as a volume: the light falls off into the wall and downwards, the tops and the sun's side are bright, the
 * base dark and dense. Phones (medium) draw 4 rows and two noise octaves instead of 6 and three: the same look at
 * play zoom. Nothing here touches the shared particle system; the sim is untouched.
 */

const VERT = /* glsl */ `
attribute vec4 aP; // along the front 0..1, depth behind the leading edge, width, height
attribute vec4 aQ; // row 0 (front) .. 1 (back), seed, centre height above the ground, opacity
uniform vec3 uCenter;
uniform float uLen;
uniform float uSpace;
uniform sampler2D uHeight;
uniform vec2 uHSize;
${SAND_FRONT_GLSL}
varying vec2 vUv;
varying vec3 vW;
varying vec4 vQ;
varying float vEdge;
varying float vG;
float gnd( vec2 xz ) { return texture2D( uHeight, ( xz + 0.5 ) / uHSize ).r * 8.0 - 1.5; }
void main() {
  vec2 d = sandWind.xy;
  vec2 sd = vec2( -d.y, d.x );
  // strung along the front round the view, each puff fixed in the world (wrapping every uLen)
  float c0 = dot( uCenter.xz, sd );
  float rel = mod( aP.x * uLen - c0 + 0.5 * uLen, uLen ) - 0.5 * uLen;
  float along = c0 + rel;
  // a lobed gust front, not a ruler line
  float lobe = 3.2 * sin( along * 0.043 + 1.3 ) + 1.6 * sin( along * 0.117 + aQ.y * 2.0 );
  vec2 xz = d * ( sandFront.x + 2.0 - aP.y + lobe ) + sd * along;
  float g = gnd( xz );
  // camera-facing puffs (the view looks down on the wall: the tops face it)
  vec3 camR = vec3( viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0] );
  vec3 camU = vec3( viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1] );
  vec3 wp = vec3( xz.x, g + aQ.z, xz.y ) + camR * position.x * max( aP.z, uSpace ) + camU * position.y * aP.w;
  vUv = position.xy + 0.5;
  vW = wp;
  vQ = aQ;
  vG = g;
  vEdge = 1.0 - smoothstep( 0.36, 0.5, abs( rel ) / uLen );
  gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
}`;

const FRAG = /* glsl */ `
uniform float uWall;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunC;
uniform vec3 uAmb;
varying vec2 vUv;
varying vec3 vW;
varying vec4 vQ;
varying float vEdge;
varying float vG;
${FOG_GLSL}
void main() {
  vec2 d = sandWind.xy;
  // the head thins away as it passes over the camera: behind it is the sandstorm itself
  float over = smoothstep( 3.0, 11.0, sandFront.x - dot( cameraPosition.xz, d ) );
  float a0 = uWall * vEdge * vQ.w * ( 1.0 - over );
  if ( a0 < 0.003 ) discard;
  float ac = dot( vW.xz, vec2( -d.y, d.x ) );
  float t = uTime;
  float sy = vQ.y * 3.7;
  // billows boiling up as the head rolls on (world space: stable as the rows wrap)
  float n1 = texture2D( fogNoise, vec2( ac * 0.075 + sy, vW.y * 0.1 - t * 0.03 ) ).g;
  float n2 = texture2D( fogNoise, vec2( ac * 0.19 - t * 0.012 + sy, vW.y * 0.24 - t * 0.07 ) ).r;
#ifdef HQ
  float n3 = texture2D( fogNoise, vec2( ac * 0.43 + t * 0.02, vW.y * 0.55 - t * 0.12 + sy ) ).b;
#else
  float n3 = 0.5 + ( n2 - 0.5 ) * 0.4;
#endif
  float n = n1 * 0.55 + n2 * 0.3 + n3 * 0.15;
  vec2 q = vUv - 0.5;
  // a billowing puff: round, its rim eaten by the noise (never a card edge); flatter at the bottom
  float r = length( vec2( q.x * 1.05, q.y * ( q.y < 0.0 ? 1.25 : 1.0 ) ) );
  float a = 1.0 - smoothstep( 0.27, 0.48, r + ( n1 - 0.5 ) * 0.34 + ( n2 - 0.5 ) * 0.18 + ( n3 - 0.5 ) * 0.08 );
  a *= 0.72 + 0.28 * smoothstep( 0.3, 0.65, n );
  // soft where it meets the ground
  a *= smoothstep( -0.4, 1.2, vW.y - vG );
  // light, as a mass of round billows: each puff shaded as a sphere bulging towards the camera (its noise as
  // bumps), lit by the sun with a soft wrap; the light falls off into the wall (rows further back, lower down),
  // the base sits in the wall's own shade, dark and dense; the sky lights the tops
  float r2 = dot( q, q ) * 4.0;
  vec3 N = normalize( vec3( q.x * 2.0 + ( n2 - 0.5 ) * 0.9, q.y * 2.0 + ( n3 - 0.5 ) * 0.9 + ( n1 - 0.5 ) * 0.5, sqrt( max( 0.06, 1.0 - r2 ) ) ) );
  vec3 L = normalize( ( viewMatrix * vec4( uSunDir, 0.0 ) ).xyz );
  vec3 Uv = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  float hgt = clamp( ( vW.y - vG ) / 10.0, 0.0, 1.0 );
  float diff = clamp( dot( N, L ) * 0.62 + 0.38, 0.0, 1.0 );
  float sunUp = clamp( uSunDir.y * 1.6 + 0.15, 0.0, 1.0 );
  float lit = ( 0.3 + 0.7 * diff * diff ) * ( 0.4 + 0.6 * sunUp ) * ( 0.22 + 0.78 * smoothstep( 0.04, 0.55, hgt ) ) * ( 1.0 - 0.3 * vQ.x );
  float sky = clamp( dot( N, Uv ) * 0.5 + 0.5, 0.0, 1.0 );
  vec3 alb = vec3( 0.84, 0.63, 0.42 );
  vec3 col = alb * ( uAmb * ( 0.35 + 0.45 * hgt ) * ( 0.55 + 0.45 * sky ) + uSunC * lit * 1.25 );
  // the billow tops catch the sun whichever side it is on
  col += alb * uSunC * 0.6 * pow( sky, 3.0 ) * smoothstep( 0.2, 0.75, hgt ) * sunUp;
  // dust scatters forwards: against the sun the billows' rims and tops glow (a silver, here golden, lining)
  vec3 Vd = normalize( vW - cameraPosition );
  float fwd = pow( clamp( dot( Vd, normalize( uSunDir ) ), 0.0, 1.0 ), 3.0 );
  float rim = pow( 1.0 - N.z, 2.0 ) * smoothstep( -0.2, 0.5, dot( N.xy, L.xy ) );
  col += alb * uSunC * rim * ( 0.25 + 0.9 * fwd ) * sunUp * smoothstep( 0.1, 0.5, hgt );
  // the dark, dense base (a touch of red-brown dust)
  col *= mix( vec3( 0.6, 0.5, 0.42 ), vec3( 1.0 ), smoothstep( 0.0, 0.35, hgt ) );
  a = mix( a, min( 1.0, a * 1.25 ), 1.0 - smoothstep( 0.1, 0.4, hgt ) );
  a *= a0 * smoothstep( 1.5, 4.5, distance( cameraPosition, vW ) );
  // (seen from the shroud too: weather is not hidden by the fog of war, only dimmed a little)
  if ( fogEnabled > 0.5 ) a *= 0.6 + 0.4 * smoothstep( 0.1, 0.45, fogSample( vW ) );
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( col, min( a, 0.95 ) );
}`;

/** Rows of the head (front nose .. back): depth behind the leading edge, puff centre height, puff size. */
const ROWS_HQ: [number, number, number][] = [
  [0, 1.8, 5],
  [1.6, 3.0, 6.5],
  [3.4, 4.4, 7.5],
  [5.6, 5.6, 8.5],
  [8.2, 6.6, 9],
  [11.0, 7.0, 9],
];
const ROWS_PHONE: [number, number, number][] = [
  [0, 2.0, 5.5],
  [2.2, 3.6, 7.5],
  [4.8, 5.4, 9],
  [8.2, 6.6, 9.5],
];
/** Height the head towers to (world units, ~115 m: it rises past the top of the view at play zoom). */
export const HABOOB_H = 11.5;

export class Haboob {
  readonly mesh: THREE.Mesh;
  private u: Record<string, THREE.IUniform>;
  private time = 0;
  /** Puffs in the wall (stats / tests). */
  readonly cards: number;
  /** Puffs per row. */
  private M: number;

  constructor(fog: FogOfWar, heightTex: THREE.Texture, mapW: number, mapH: number, quality: 'low' | 'medium' | 'high') {
    const hq = quality === 'high';
    const rows = hq ? ROWS_HQ : ROWS_PHONE;
    const M = hq ? 14 : quality === 'medium' ? 12 : 9;
    const LEN = 72;
    this.M = M;
    const n = rows.length * M;
    this.cards = n;
    let s = 0x4ab00b >>> 0;
    const rnd = () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) / 4294967296;
    };
    const a1 = new Float32Array(n * 4);
    const a2 = new Float32Array(n * 4);
    let i = 0;
    for (const [R, [depth, ch, size]] of rows.entries()) {
      for (let j = 0; j < M; j++, i++) {
        // staggered along the front from row to row (no columns)
        const x = (j + 0.5 * (R & 1) + (rnd() - 0.5) * 0.45) / M;
        const sz = size * (0.85 + rnd() * 0.3);
        a1.set([x, depth + rnd() * 1.2, sz * (1.25 + rnd() * 0.25), sz], i * 4);
        a2.set([R / (rows.length - 1), rnd(), ch * (0.9 + rnd() * 0.2), R === 0 ? 0.85 : 0.92], i * 4);
      }
    }
    const plane = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = plane.index;
    geo.setAttribute('position', plane.getAttribute('position'));
    geo.setAttribute('aP', new THREE.InstancedBufferAttribute(a1, 4));
    geo.setAttribute('aQ', new THREE.InstancedBufferAttribute(a2, 4));
    geo.instanceCount = n;
    this.u = {
      ...fog.uniforms,
      uCenter: { value: new THREE.Vector3() },
      uLen: { value: LEN },
      uSpace: { value: (LEN / M) * 1.4 },
      uHeight: { value: heightTex },
      uHSize: { value: new THREE.Vector2(mapW + 1, mapH + 1) },
      uWall: { value: 0 },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.5, 0.7, 0.3) },
      uSunC: { value: new THREE.Vector3(1, 0.9, 0.8) },
      uAmb: { value: new THREE.Vector3(0.5, 0.5, 0.5) },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines: hq ? { HQ: 1 } : {},
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    // over the ground fog, under the storm's billows and grains
    this.mesh.renderOrder = 4;
    this.mesh.name = 'haboob';
    this.mesh.visible = false;
  }

  /**
   * Per frame: wall presence 0..1 (sandstorm.ts: the leading edge on its way across), the view centre, and the
   * light (key light direction towards it, its colour x intensity, the sky fill).
   */
  update(dt: number, wall: number, target: THREE.Vector3, span: number, sunDir: THREE.Vector3, sunC: THREE.Color, sunI: number, amb: THREE.Color, ambI: number) {
    const u = this.u;
    this.mesh.visible = wall > 0.004;
    u.uWall.value = wall;
    if (!this.mesh.visible) return;
    this.time = (this.time + dt) % 4000;
    u.uTime.value = this.time;
    (u.uCenter.value as THREE.Vector3).copy(target);
    // the rows wrap round the view along the front; zoomed far out they stretch (in steps: no sliding while zooming)
    u.uLen.value = Math.max(72, Math.ceil((span * 2.6) / 24) * 24);
    u.uSpace.value = (u.uLen.value / this.M) * 1.4;
    (u.uSunDir.value as THREE.Vector3).copy(sunDir).normalize();
    // (the scene's light units: the puffs are lit like the ground under them)
    (u.uSunC.value as THREE.Vector3).set(sunC.r, sunC.g, sunC.b).multiplyScalar(sunI * 0.27);
    (u.uAmb.value as THREE.Vector3).set(amb.r, amb.g, amb.b).multiplyScalar(ambI * 0.6);
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
