import * as THREE from 'three';
import { FOG_GLSL, type FogOfWar } from '../fog';
import type { ChimneyTop, HouseHandle } from '../scenery';
import { CHIMNEY_TIER, type Tier } from './atmosrules';

/*
 * Chimney smoke over the villages and town houses (purely visual).
 *
 * One shared instanced draw call of soft camera-facing puffs, animated entirely in the vertex
 * shader: each puff's age is a fraction of the render clock (no CPU particles), it rises from the
 * chimney top, slows as it cools, is bent over by the wind more and more as it climbs and spreads
 * into a thin, ragged trail. The CPU only picks the chimneys nearest the view (distance cap per
 * tier, CHIMNEY_TIER) a couple of times a second and writes their positions.
 *
 * How much smoke follows the clock and the climate (atmosrules.ts chimneyAmount): a few stoves
 * all day, most of them at breakfast and in the evening, more in the cold. By night the bottom of
 * each plume catches the warm light of the windows below. A damaged / collapsed house
 * (envdamage.ts) stops smoking. Puffs fade over the shroud (fog of war).
 *
 * Quality: medium 7 puffs on the 18 nearest chimneys, high 10 on 40; low none (not created).
 */

const VERT = /* glsl */ `
attribute vec4 aSrc;   // chimney top x, y, z, seed 0..1
attribute float aPuff; // phase of this puff along the plume 0..1
uniform float uTime;
uniform float uAmount;
uniform vec2 uWind;
varying vec2 vUv;
varying float vA;
varying float vAge;
varying float vSeed;
varying vec3 vW;
void main() {
  float sd = aSrc.w;
  // the share of chimneys smoking grows with the amount (always a few)
  float on = step( fract( sd * 7.31 ), 0.12 + 0.95 * uAmount );
  float rate = 0.12 + 0.05 * fract( sd * 3.7 );
  float age = fract( uTime * rate + aPuff + sd );
  float wl = length( uWind );
  vec2 wd = wl > 1e-4 ? uWind / wl : vec2( 0.8, 0.6 );
  float ws = min( wl, 2.0 );
  // rises quickly out of the chimney, slows as it cools; the wind bends it over more and more with height
  float rise = ( 1.0 - exp( -age * 2.4 ) ) * ( 0.95 - 0.4 * min( ws, 1.0 ) ) + age * 0.22;
  float drift = age * age * ( 0.45 + 1.5 * ws ) + age * 0.12;
  vec3 p = aSrc.xyz + vec3( wd.x * drift, rise, wd.y * drift );
  // a lazy curl sideways
  float sw = sin( age * 5.0 + sd * 40.0 ) * 0.07 * age;
  p.x -= wd.y * sw;
  p.z += wd.x * sw;
  float size = 0.06 + age * 0.46;
  vA = on * smoothstep( 0.0, 0.07, age ) * ( 1.0 - smoothstep( 0.4, 1.0, age ) ) * ( 0.45 + 0.55 * uAmount );
  vAge = age;
  vSeed = sd;
  vW = p;
  vUv = position.xy;
  vec4 mv = viewMatrix * vec4( p, 1.0 );
  float ang = sd * 6.28 + age * 1.3;
  float c = cos( ang );
  float s = sin( ang );
  mv.xy += vec2( c * position.x - s * position.y, s * position.x + c * position.y ) * size;
  gl_Position = vA > 0.002 ? projectionMatrix * mv : vec4( 2.0, 2.0, 2.0, 1.0 );
}`;

const FRAG = /* glsl */ `
uniform vec3 uLight;
uniform vec3 uWarm;
uniform float uNight;
varying vec2 vUv;
varying float vA;
varying float vAge;
varying float vSeed;
varying vec3 vW;
${FOG_GLSL}
void main() {
  vec2 q = vUv * 2.0;
  float r = length( q );
  // ragged: the noise eats the edge of each puff
  float n = texture2D( fogNoise, vUv * 0.45 + vec2( vSeed * 3.1, vAge * 0.35 ) ).g;
  float a = ( 1.0 - smoothstep( 0.25, 1.0, r + ( n - 0.5 ) * 0.55 ) ) * vA * 0.5;
  if ( fogEnabled > 0.5 ) a *= smoothstep( 0.1, 0.45, fogSample( vW ) );
  if ( a < 0.003 ) discard;
  // wood smoke: a warm grey, paler as it thins out, lit by the scene (dimmer by night: only the sky lights it)
  vec3 col = mix( vec3( 0.62, 0.6, 0.58 ), vec3( 0.8, 0.8, 0.8 ), vAge ) * uLight * ( 1.0 - 0.45 * uNight );
  // by night the bottom of the plume catches the warm light of the windows below
  col += uWarm * uNight * ( 1.0 - smoothstep( 0.0, 0.4, vAge ) ) * ( 0.6 + 0.4 * n );
  gl_FragColor = vec4( col * a, a );
}`;

export class ChimneySmoke {
  readonly mesh: THREE.Mesh;
  private tops: ChimneyTop[];
  private houses: (HouseHandle | null)[];
  private seeds: Float32Array;
  private puffs: number;
  private max: number;
  private aSrc: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;
  private u: Record<string, THREE.IUniform>;
  /** Chimneys picked for the view (indices into tops), their distances (scratch). */
  private pick: Int32Array;
  private dist: Float32Array;
  private active = 0;
  private lastX = -1e9;
  private lastZ = -1e9;
  private wait = 0;

  constructor(tops: ChimneyTop[], houses: HouseHandle[], fog: FogOfWar, q: Tier) {
    this.tops = tops;
    const byStruct = new Map(houses.map((h) => [h.st, h]));
    this.houses = tops.map((t) => byStruct.get(t.st) ?? null);
    this.seeds = Float32Array.from(tops, (t) => {
      // stable per chimney: a hash of its position
      const v = Math.sin(t.x * 12.9898 + t.z * 78.233 + t.y * 37.719) * 43758.5453;
      return v - Math.floor(v);
    });
    const tier = CHIMNEY_TIER[q];
    this.puffs = tier.puffs;
    this.max = Math.min(tier.max, tops.length);
    this.pick = new Int32Array(tops.length);
    this.dist = new Float32Array(tops.length);
    const n = Math.max(1, this.max * this.puffs);
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = (this.geo = new THREE.InstancedBufferGeometry());
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    this.aSrc = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.aSrc.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aSrc', this.aSrc);
    const ph = new Float32Array(n);
    for (let i = 0; i < n; i++) ph[i] = (i % this.puffs) / this.puffs;
    geo.setAttribute('aPuff', new THREE.InstancedBufferAttribute(ph, 1));
    geo.instanceCount = 0;
    this.u = {
      ...fog.uniforms,
      uTime: { value: 0 },
      uAmount: { value: 0 },
      uWind: { value: new THREE.Vector2() },
      uLight: { value: new THREE.Color(1, 1, 1) },
      uWarm: { value: new THREE.Color(0.75, 0.38, 0.12) },
      uNight: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.name = 'chimney-smoke';
    this.mesh.visible = false;
  }

  /**
   * Per frame. time = render clock (s); amount 0..1 (atmosrules.ts chimneyAmount); wind (world units / s);
   * light = the scene light on the smoke; night 0..1 (window glow); (cx, cz) the view centre and r the
   * radius around it that counts as "in view".
   */
  update(dt: number, time: number, amount: number, windX: number, windZ: number, light: THREE.Color, night: number, cx: number, cz: number, r: number) {
    const u = this.u;
    u.uTime.value = time;
    u.uAmount.value = amount;
    (u.uWind.value as THREE.Vector2).set(windX, windZ);
    (u.uLight.value as THREE.Color).copy(light);
    u.uNight.value = night;
    // re-pick the chimneys near the view when it moved or every half second (houses get wrecked)
    this.wait -= dt;
    if (this.wait <= 0 || Math.abs(cx - this.lastX) + Math.abs(cz - this.lastZ) > 1.5) this.repick(cx, cz, r);
    this.mesh.visible = amount > 0.01 && this.active > 0;
  }

  private repick(cx: number, cz: number, r: number) {
    this.wait = 0.5;
    this.lastX = cx;
    this.lastZ = cz;
    let n = 0;
    const r2 = r * r;
    for (let i = 0; i < this.tops.length; i++) {
      const t = this.tops[i];
      const h = this.houses[i];
      if (h && (h.stage ?? 0) > 0) continue;
      const d = (t.x - cx) * (t.x - cx) + (t.z - cz) * (t.z - cz);
      if (d > r2) continue;
      this.pick[n] = i;
      this.dist[i] = d;
      n++;
    }
    // the nearest first (insertion sort: a few dozen candidates at most)
    const P = this.pick;
    const D = this.dist;
    for (let i = 1; i < n; i++) {
      const v = P[i];
      const dv = D[v];
      let j = i - 1;
      while (j >= 0 && D[P[j]] > dv) {
        P[j + 1] = P[j];
        j--;
      }
      P[j + 1] = v;
    }
    n = Math.min(n, this.max);
    const A = this.aSrc.array as Float32Array;
    const K = this.puffs;
    for (let s = 0; s < n; s++) {
      const t = this.tops[P[s]];
      const sd = this.seeds[P[s]];
      for (let k = 0; k < K; k++) {
        const o = (s * K + k) * 4;
        A[o] = t.x;
        A[o + 1] = t.y;
        A[o + 2] = t.z;
        A[o + 3] = sd;
      }
    }
    this.active = n;
    this.geo.instanceCount = n * K;
    if (n) {
      this.aSrc.clearUpdateRanges();
      this.aSrc.addUpdateRange(0, n * K * 4);
      this.aSrc.needsUpdate = true;
    }
  }

  /** Debug / screenshots. */
  stats() {
    return { chimneys: this.tops.length, smoking: this.active, puffs: this.geo.instanceCount, amount: +(this.u.uAmount.value as number).toFixed(2) };
  }

  dispose() {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
