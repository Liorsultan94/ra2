import * as THREE from 'three';
import { groundHeight, type GameMap } from '../sim/map';
import { FOG_GLSL, type FogOfWar } from './fog';
import { reliefHeight } from './relief';
import { SAND_FRONT_GLSL, WXS } from './wxuniforms';
import type { WxEvent } from './weathercycle';

/*
 * The sandstorm you can see at play zoom (render only). On top of the warm grade, the sandy sky and haze
 * (atmos.ts) and the blowing grains (weather.ts), this drives:
 *  - the shared blowing-sand uniforms (wxuniforms.ts WXS): the terrain streams sheets and snakes of sand
 *    downwind, everything fades into the airborne sand with distance (fog.ts fogShade);
 *  - billows: soft clouds of sand rolling low over the ground with the wind, wrapped in a box around the
 *    view (one instanced draw call with the wall);
 *  - the front: a dust wall (haboob) that rolls across the map as the storm arrives and the clear air
 *    behind its trailing edge as it leaves. Everything else is masked by the same front (sandK), so the
 *    sand sheets, billows and grains arrive with the wall;
 *  - grains hitting units: small sand puffs thrown off the windward side of whatever stands in the storm.
 * The front follows the seeded weather timeline (game time): every player sees the same storm.
 */

/** Height (ground + relief: mesa tops too) for the ground-hugging cards and grains, 8-bit over -1.5 .. 6.5. */
export function sandHeightTexture(m: GameMap): THREE.DataTexture {
  const W = m.w + 1;
  const H = m.h + 1;
  const d = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const h = Math.max(groundHeight(m, Math.min(x, m.w), Math.min(y, m.h)), reliefHeight(m, Math.min(x, m.w - 0.01), Math.min(y, m.h - 0.01)), -0.25);
      d[y * W + x] = Math.max(0, Math.min(255, Math.round(((h + 1.5) / 8) * 255)));
    }
  const t = new THREE.DataTexture(d, W, H, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const VERT = /* glsl */ `
attribute vec4 aA; // wrap phase x / z (0..1; wall: position along the front, depth behind it), width, height
attribute vec4 aB; // drift speed factor, lift above the ground, opacity, kind (0 billow, 1 wall)
uniform vec3 uCenter;
uniform float uBox;
uniform float uDrift;
uniform float uWall;
uniform float uWallLen;
uniform sampler2D uHeight;
uniform vec2 uHSize;
${SAND_FRONT_GLSL}
varying vec2 vUv;
varying vec3 vW;
varying float vA;
varying float vKind;
float gnd( vec2 xz ) { return texture2D( uHeight, ( xz + 0.5 ) / uHSize ).r * 8.0 - 1.5; }
void main() {
  vec2 d = sandWind.xy;
  vec2 sd = vec2( -d.y, d.x );
  vec2 xz;
  float a = aB.z;
  if ( aB.w < 0.5 ) {
    vec2 p = aA.xy * uBox + d * uDrift * aB.x;
    vec2 rel = mod( p - uCenter.xz + 0.5 * uBox, uBox ) - 0.5 * uBox;
    vec2 e = abs( rel ) / ( 0.5 * uBox );
    a *= ( 1.0 - smoothstep( 0.6, 1.0, e.x ) ) * ( 1.0 - smoothstep( 0.6, 1.0, e.y ) ) * sandAmt;
    xz = uCenter.xz + rel;
  } else {
    // the wall: cards strung along the leading edge, across the wind, centred on the view
    float c0 = dot( uCenter.xz, sd );
    xz = d * ( sandFront.x - aA.y * 9.0 + 2.0 ) + sd * ( c0 + ( aA.x - 0.5 ) * uWallLen );
    a *= uWall;
  }
  float g = gnd( xz );
  vec3 right = normalize( vec3( viewMatrix[0][0], 0.0, viewMatrix[2][0] ) + 1e-4 );
  vec3 base = vec3( xz.x, g + aB.y, xz.y );
  vec3 wp = base + right * position.x * aA.z + vec3( 0.0, ( position.y + 0.5 ) * aA.w, 0.0 );
  // billows only inside the storm (the wall is the storm's edge itself)
  if ( aB.w < 0.5 ) a *= sandK( base );
  vA = a;
  vKind = aB.w;
  vUv = position.xy + 0.5;
  vW = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
}`;

const FRAG = /* glsl */ `
uniform float uFocus;
varying vec2 vUv;
varying vec3 vW;
varying float vA;
varying float vKind;
${FOG_GLSL}
void main() {
  if ( vA < 0.003 ) discard;
  vec2 d = sandWind.xy;
  float al = dot( vW.xz, d ) - sandWind.z * ( vKind > 0.5 ? 0.25 : 1.0 );
  float ac = dot( vW.xz, vec2( -d.y, d.x ) );
  // streaky sand racing downwind, rolling billows on the wall
  float n = texture2D( fogNoise, vec2( al * 0.05, ac * 0.05 + vW.y * 0.07 ) ).g * 0.6 + texture2D( fogNoise, vec2( al * 0.13 + 0.3, ac * 0.11 + vW.y * 0.2 ) ).r * 0.4;
  vec2 q = vUv - 0.5;
  float a;
  vec3 col;
  if ( vKind < 0.5 ) {
    // a soft lens, densest low down, frayed by the noise
    float r = length( vec2( q.x * 1.9, q.y * 1.3 ) );
    a = ( 1.0 - smoothstep( 0.15, 0.62, r + ( n - 0.5 ) * 0.5 ) ) * ( 1.0 - 0.45 * vUv.y );
    col = sandCol * ( 0.82 + 0.3 * n + 0.15 * vUv.y );
    // readability: thinner round the view centre (the player's units) and near the camera
    a *= mix( 0.45, 1.0, smoothstep( uFocus * 0.35, uFocus * 1.3, length( vW.xz - fogTarget.xz ) ) );
  } else {
    // the wall: dense and dark at the foot, rolling billows eroding its top, soft ends (never a card edge)
    float n3 = texture2D( fogNoise, vec2( ac * 0.09 + 0.17, vW.y * 0.12 - sandWind.z * 0.01 ) ).b;
    float top = 0.5 + ( n - 0.5 ) * 0.55 + ( n3 - 0.5 ) * 0.3;
    a = ( 1.0 - smoothstep( top - 0.3, top + 0.08, vUv.y ) ) * ( 1.0 - smoothstep( 0.22, 0.5, abs( q.x ) + ( n3 - 0.5 ) * 0.12 ) );
    a *= ( 1.0 - smoothstep( 0.8, 0.98, vUv.y ) ) * smoothstep( 0.0, 0.2 + 0.15 * n3, vUv.y ) * ( 0.55 + 0.45 * smoothstep( 0.25, 0.75, n * 0.6 + n3 * 0.4 ) );
    col = sandCol * ( 0.5 + 0.45 * vUv.y + 0.3 * n ) * vec3( 1.0, 0.96, 0.9 );
  }
  a *= vA * smoothstep( 3.0, 9.0, distance( cameraPosition, vW ) );
  if ( fogEnabled > 0.5 ) a *= 0.35 + 0.65 * smoothstep( 0.1, 0.45, fogSample( vW ) );
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( col, min( a, 0.92 ) );
}`;

const sstep = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export interface SandHost {
  map: GameMap;
  /** Entities to throw grain puffs off (render only). */
  list: Iterable<{ x: number; y: number; dead: boolean; kind: string }>;
  groundAt(x: number, z: number): number;
  puff(x: number, y: number, z: number, vx: number, vz: number): void;
}

export class SandStorm {
  readonly mesh: THREE.Mesh;
  readonly heightTex: THREE.DataTexture;
  private u: Record<string, THREE.IUniform>;
  private drift = 0;
  private cardDrift = 0;
  private puffAcc = 0;
  /** Wall cards drawn last frame (stats / tests). */
  wall = 0;

  constructor(
    private host: SandHost,
    fog: FogOfWar,
    private quality: 'low' | 'medium' | 'high',
  ) {
    const m = host.map;
    this.heightTex = sandHeightTexture(m);
    // billows and wall cards (phones: fewer, same look)
    const nB = quality === 'high' ? 64 : quality === 'medium' ? 36 : 16;
    const nW = quality === 'high' ? 30 : quality === 'medium' ? 20 : 12;
    const n = nB + nW;
    let s = 0x5a17d0 >>> 0;
    const rnd = () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) / 4294967296;
    };
    const a1 = new Float32Array(n * 4);
    const a2 = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      if (i < nB) {
        a1.set([rnd(), rnd(), 2.6 + rnd() * 3.8, 0.7 + rnd() * 1.4], i * 4);
        a2.set([0.7 + rnd() * 0.6, -0.15 + rnd() * 0.35, 0.3 + rnd() * 0.3, 0], i * 4);
      } else {
        const k = (i - nB + rnd() * 0.8) / nW;
        a1.set([k, rnd(), 9 + rnd() * 7, 6 + rnd() * 6], i * 4);
        a2.set([1, -0.4, 0.6 + rnd() * 0.2, 1], i * 4);
      }
    }
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('aA', new THREE.InstancedBufferAttribute(a1, 4));
    geo.setAttribute('aB', new THREE.InstancedBufferAttribute(a2, 4));
    geo.instanceCount = n;
    this.u = {
      ...fog.uniforms,
      uCenter: { value: new THREE.Vector3() },
      uBox: { value: 40 },
      uDrift: { value: 0 },
      uWall: { value: 0 },
      uWallLen: { value: 120 },
      uHeight: { value: this.heightTex },
      uHSize: { value: new THREE.Vector2(m.w + 1, m.h + 1) },
      uFocus: { value: 8 },
    };
    const mat = new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    // over the ground fog, under the falling grains
    this.mesh.renderOrder = 5;
    this.mesh.name = 'sandstorm';
    this.mesh.visible = false;
  }

  /**
   * The storm front from the weather timeline (game seconds `t`, the dust event and its wind direction),
   * or a storm covering everything (static sandstorm, forced weather). Returns the sand amount behind it.
   */
  static front(map: GameMap, e: WxEvent | null, t: number, end: number, dirX: number, dirZ: number, out: THREE.Vector4): number {
    if (!e) {
      out.set(1e6, -1e6, 6, 0);
      return 1;
    }
    // the map's extent along the wind, plus room for the wall to come in from beyond the edge
    const c0 = (map.w / 2) * dirX + (map.h / 2) * dirZ;
    const R = (Math.abs(dirX) * map.w + Math.abs(dirZ) * map.h) / 2 + 30;
    const a0 = e.start + e.build * 0.3;
    const a1 = e.start + e.build + e.ramp + e.hold * 0.35;
    const d0 = e.start + e.build + e.ramp + e.hold * 0.65;
    const d1 = end - e.clear * 0.3;
    const lead = c0 - R + 2 * R * Math.max(0, Math.min(1, (t - a0) / (a1 - a0)));
    const tail = t < d0 ? -1e6 : c0 - R + 2 * R * Math.max(0, Math.min(1, (t - d0) / (d1 - d0)));
    out.set(lead, tail, 7, 0);
    return t >= a0 && t <= d1 ? e.precip : 0;
  }

  /**
   * Per frame. amount: blowing sand behind the front 0..1; wall: the dust wall's presence 0..1;
   * wind: direction (unit) and strength 0..1; light: daylight 0..1.
   */
  update(dt: number, amount: number, wall: number, dirX: number, dirZ: number, wind: number, light: number, target: THREE.Vector3, zoom: number) {
    const u = this.u;
    WXS.sandAmt.value = amount;
    const sw = WXS.sandWind.value;
    // the sand races along at gale speed (world units / s)
    const spd = 4 + 7 * wind;
    this.drift = (this.drift + spd * dt) % 4096;
    this.cardDrift = (this.cardDrift + spd * 0.8 * dt) % 4096;
    sw.set(dirX, dirZ, this.drift, 0);
    WXS.sandCol.value.setRGB(0.98, 0.76, 0.5).multiplyScalar(0.18 + 1.05 * light);
    const vh = 22 / Math.max(0.3, zoom);
    u.uBox.value = Math.min(90, Math.max(24, vh * 1.6));
    u.uDrift.value = this.cardDrift;
    u.uFocus.value = vh * 0.42;
    u.uWall.value = wall;
    u.uWallLen.value = Math.max(60, vh * 3);
    (u.uCenter.value as THREE.Vector3).copy(target);
    this.wall = wall > 0.01 ? 1 : 0;
    this.mesh.visible = amount > 0.004 || wall > 0.004;
    // grains hitting units: small puffs thrown off their windward side
    if (amount > 0.05 && this.quality !== 'low') {
      const fr = WXS.sandFront.value;
      const range = vh * 0.8;
      this.puffAcc += dt * amount * (this.quality === 'high' ? 1 : 0.6);
      let budget = Math.min(40, Math.floor(this.puffAcc * 60));
      if (budget > 0) this.puffAcc = 0;
      for (const e of this.host.list) {
        if (budget <= 0) break;
        if (e.dead || e.kind !== 'unit' || Math.abs(e.x - target.x) > range || Math.abs(e.y - target.z) > range) continue;
        const sAx = e.x * dirX + e.y * dirZ;
        const k = (1 - sstep(fr.x - fr.z, fr.x + fr.z, sAx)) * sstep(fr.y - fr.z, fr.y + fr.z, sAx);
        if (Math.random() > 0.35 * k) continue;
        budget--;
        const side = (Math.random() - 0.5) * 0.5;
        const x = e.x - dirX * 0.3 - dirZ * side;
        const z = e.y - dirZ * 0.3 + dirX * side;
        this.host.puff(x, this.host.groundAt(x, z) + 0.08 + Math.random() * 0.4, z, dirX * spd * 0.35, dirZ * spd * 0.35);
      }
    }
  }

  dispose() {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.heightTex.dispose();
    WXS.sandAmt.value = 0;
  }
}
