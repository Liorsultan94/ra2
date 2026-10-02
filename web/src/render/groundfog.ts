import * as THREE from 'three';
import { groundHeight, WATER_LEVEL, type GameMap } from '../sim/map';
import { FOG_GLSL, type FogOfWar } from './fog';

/*
 * Drifting fog banks over the river valley and the hollows (dawn mist, the
 * 'mist' time of day, mist rising after rain). The height fog in the shared
 * fog shader (wxuniforms.ts MIST_GLSL) lays the low layer on everything; these
 * soft horizontal cards add depth on top of it: banks of mist floating a little
 * above the low ground and creeping along with the wind.
 *
 * One instanced draw call. Every card is anchored over low ground and wraps
 * within a box around its anchor as the wind drift accumulates (fading out at
 * the box edges, so cards come and go instead of popping). Where rising
 * ground meets a card, a small height map fades the card (no hard cut lines);
 * cards fade over the shroud, around the view centre (readability) and near
 * the camera. Strength follows WXM.mistAmount; the shader never changes.
 */

const VERT = /* glsl */ `
attribute vec4 aCard;   // anchor x, anchor z, size, height above the ground
attribute vec4 aCard2;  // drift phase x / z (0..1), rotation, opacity
uniform vec2 uDrift;
uniform float uWrap;
varying vec2 vUv;
varying vec3 vW;
varying float vA;
varying float vCardY;
void main() {
  vec2 rel = mod( uDrift + aCard2.xy * uWrap, uWrap ) - 0.5 * uWrap;
  vec2 e = abs( rel ) / ( 0.5 * uWrap );
  vA = aCard2.w * ( 1.0 - smoothstep( 0.55, 1.0, e.x ) ) * ( 1.0 - smoothstep( 0.55, 1.0, e.y ) );
  float c = cos( aCard2.z );
  float s = sin( aCard2.z );
  vec2 q = position.xy * aCard.z;
  vec2 xz = aCard.xy + rel + vec2( c * q.x - s * q.y, s * q.x + c * q.y );
  vW = vec3( xz.x, aCard.w, xz.y );
  vCardY = aCard.w;
  vUv = position.xy + 0.5;
  gl_Position = projectionMatrix * viewMatrix * vec4( vW, 1.0 );
}`;

const FRAG = /* glsl */ `
uniform sampler2D uHeight;
uniform vec2 uHSize;
uniform float uAmount;
uniform float uFocus;
uniform float uTimeF;
varying vec2 vUv;
varying vec3 vW;
varying float vA;
varying float vCardY;
${FOG_GLSL}
void main() {
  // soft round card, broken up by two drifting noise layers
  vec2 d = vUv - 0.5;
  float r = 1.0 - smoothstep( 0.18, 0.5, length( d ) );
  vec2 q = vW.xz + mistDrift;
  float n = texture2D( fogNoise, q * 0.045 + vec2( uTimeF * 0.004, 0.0 ) ).g * 0.6 + texture2D( fogNoise, q * 0.11 - vec2( 0.0, uTimeF * 0.006 ) ).a * 0.4;
  float a = r * smoothstep( 0.3, 0.75, n ) * vA * uAmount;
  // fade where the ground rises into the card (no hard cut line), thin out over hills
  float th = texture2D( uHeight, ( vW.xz + 0.5 ) / uHSize ).r * 6.0 - 1.5;
  a *= smoothstep( 0.0, 0.5, vCardY - th );
  // readability: thin around the view centre (where the player is looking) and near the camera
  float fr = length( vW.xz - fogTarget.xz );
  a *= mix( 0.22, 1.0, smoothstep( uFocus * 0.5, uFocus * 1.6, fr ) );
  a *= smoothstep( 4.0, 12.0, distance( cameraPosition, vW ) );
  // never over the shroud (unexplored land stays dark smoke)
  if ( fogEnabled > 0.5 ) a *= smoothstep( 0.1, 0.45, fogSample( vW ) );
  if ( a < 0.003 ) discard;
  gl_FragColor = vec4( mistColor * ( 0.93 + 0.14 * n ), a );
}`;

export class GroundFog {
  readonly mesh: THREE.Mesh;
  private u: Record<string, THREE.IUniform>;
  private drift = new THREE.Vector2();

  constructor(map: GameMap, fog: FogOfWar, quality: 'low' | 'medium' | 'high', seed: number) {
    // small height map (8-bit, -1.5..4.5) for the soft card / ground intersection
    const W = map.w + 1;
    const H = map.h + 1;
    const hd = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) hd[i] = Math.max(0, Math.min(255, Math.round(((Math.max(WATER_LEVEL, map.heights[i]) + 1.5) / 6) * 255)));
    const ht = new THREE.DataTexture(hd, W, H, THREE.RedFormat, THREE.UnsignedByteType);
    ht.magFilter = ht.minFilter = THREE.LinearFilter;
    ht.needsUpdate = true;
    // anchors over the low ground (river valley, hollows), spread out
    let s = (seed ^ 0x2f6b) >>> 0 || 1;
    const rnd = () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) / 4294967296;
    };
    const want = quality === 'high' ? 34 : quality === 'medium' ? 24 : 14;
    const cand: [number, number, number][] = [];
    for (let y = 2; y < map.h - 2; y += 2)
      for (let x = 2; x < map.w - 2; x += 2) {
        const h = groundHeight(map, x + 0.5, y + 0.5);
        if (h < 0.3) cand.push([x + 0.5, y + 0.5, h]);
      }
    for (let i = cand.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [cand[i], cand[j]] = [cand[j], cand[i]];
    }
    // the lowest ground first (the valley gets the banks), then anything low enough
    cand.sort((a, b) => a[2] - b[2] + (rnd() - 0.5) * 0.6);
    const picked: [number, number, number][] = [];
    for (const c of cand) {
      if (picked.length >= want) break;
      if (picked.some((p) => Math.hypot(p[0] - c[0], p[1] - c[1]) < 6.5)) continue;
      picked.push(c);
    }
    const n = Math.max(1, picked.length);
    const a1 = new Float32Array(n * 4);
    const a2 = new Float32Array(n * 4);
    picked.forEach(([x, z, h], i) => {
      a1.set([x, z, 8 + rnd() * 7, Math.max(h, WATER_LEVEL) + 0.35 + rnd() * 0.4], i * 4);
      a2.set([rnd(), rnd(), rnd() * Math.PI * 2, 0.32 + rnd() * 0.22], i * 4);
    });
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('aCard', new THREE.InstancedBufferAttribute(a1, 4));
    geo.setAttribute('aCard2', new THREE.InstancedBufferAttribute(a2, 4));
    geo.instanceCount = picked.length;
    this.u = {
      ...fog.uniforms,
      uDrift: { value: this.drift },
      uWrap: { value: 14 },
      uHeight: { value: ht },
      uHSize: { value: new THREE.Vector2(W, H) },
      uAmount: { value: 0 },
      uFocus: { value: 8 },
      uTimeF: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.name = 'ground-fog';
    this.mesh.visible = false;
  }

  /**
   * amount: card opacity 0..1; wind: world units / s; focus: clear radius around the view centre.
   */
  update(dt: number, time: number, amount: number, windX: number, windZ: number, focus: number) {
    const u = this.u;
    u.uAmount.value = amount;
    u.uTimeF.value = time;
    u.uFocus.value = focus;
    // mist creeps along slower than the wind itself
    this.drift.x = (this.drift.x + windX * dt * 0.35) % 1400;
    this.drift.y = (this.drift.y + windZ * dt * 0.35) % 1400;
    this.mesh.visible = amount > 0.004;
  }
}
