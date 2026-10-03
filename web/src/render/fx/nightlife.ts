import * as THREE from 'three';
import { buildingDef } from '../../sim/defs';
import { StructureKind, Tile, groundHeight, type GameMap, type Structure } from '../../sim/map';
import type { AtmosHost, Atmosphere } from '../atmos';
import type { FogProbe } from '../ambient/shared';
import { FOG_GLSL } from '../fog';
import { CITY_NIGHT } from '../models/citybldgs';
import type { NightLights } from '../night';
import type { NatureFx } from './nature';

/** NatureFx particle kind of a spark (kept literal: no import cycle with nature.ts). */
const SPARK = 5;

/*
 * The vivid night (purely visual).
 *
 *  - City windows: the facade shader (models/citybldgs.ts) is extended from
 *    here (onBeforeCompile wrapper, one extra program variant at load): over
 *    the night residents go to bed and windows go dark, a few switch on for a
 *    while in the small hours, the odd one flickers like a TV / dying tube;
 *    early risers light up before dawn. Driven by the cycle phase.
 *  - Neon signs on the shop fronts (one instanced draw call, only at night):
 *    procedural tube lettering in a frame, a soft halo, a coloured spill on the
 *    pavement; some signs are broken and stutter.
 *  - Street lamps: ground pools under the city lamps; shelling nearby makes
 *    them stutter and knocks some out for a while (the lamp head goes dark),
 *    then they flicker back on. A few are just faulty and buzz.
 *  - Searchlights at the bases sweep the night sky (cones in NightLights).
 *  - Campfires in the village yards and at the outposts on cold nights:
 *    flickering light and pool, flames, sparks and a thin smoke.
 *
 * Lamps, beams and fires draw into NightLights' instanced pools (no extra
 * draw calls) through its hook.
 */

type Q = 'low' | 'medium' | 'high';

const sstep = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// ------------------------------------------------------------ city windows

/** Night progress for the windows: 0 evening .. 1 the small hours (residents asleep). */
export const CITY_LATE = { value: 0 };
/** Clock for the window toggles (game seconds). */
export const CITY_CLOCK = { value: 0 };

const WIN_OLD = 'float lit = step( hs, 0.42 ) * cityNight;';
const WIN_NEW = /* glsl */ `
  float hs2 = fract( hs * 13.7 + 0.31 );
  float hs3 = fract( hs * 71.3 + 0.17 );
  float lit = step( hs, 0.42 );
  // bedtime: over half of the lit windows go dark between ~22:00 and ~02:00
  lit *= 1.0 - step( 0.42, hs2 ) * step( 0.18 + hs3 * 0.7, cityLate );
  // someone up at night: a few dark windows switch on for a while, now and then
  float wslot = floor( cityClock / ( 30.0 + hs3 * 50.0 ) + hs2 * 7.0 );
  float wup = step( 0.42, hs ) * step( hs, 0.7 ) * step( 0.86, fract( sin( wslot * 12.9898 + hs * 78.233 ) * 43758.5453 ) );
  lit = max( lit, wup * step( 0.08, cityLate ) );
  // a TV's blue flicker / a dying tube in a few
  float wfl = 0.6 + 0.4 * sin( cityClock * 7.0 + hs * 50.0 ) * sin( cityClock * 2.3 + hs2 * 20.0 );
  lit *= mix( 1.0, wfl, step( 0.965, hs3 ) );
  lit *= cityNight;`;

/** Extend the city facade materials' lit-window hash with the night schedule. */
function patchWindows(scene: THREE.Object3D): number {
  const mats = new Set<THREE.Material>();
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.name === 'city-facade') {
      const m = (o as THREE.Mesh).material;
      if (!Array.isArray(m)) mats.add(m);
    }
  });
  for (const m of mats) {
    if (m.userData.nightlife) continue;
    m.userData.nightlife = true;
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => {
      prev.call(m, sh, r);
      if (!sh.fragmentShader.includes(WIN_OLD)) return;
      sh.uniforms.cityLate = CITY_LATE;
      sh.uniforms.cityClock = CITY_CLOCK;
      sh.fragmentShader = sh.fragmentShader.replace('uniform float cityNight;', 'uniform float cityNight;\nuniform float cityLate;\nuniform float cityClock;').replace(WIN_OLD, WIN_NEW);
    };
    const key = m.customProgramCacheKey.bind(m);
    m.customProgramCacheKey = () => key() + '-late';
    m.needsUpdate = true;
  }
  return mats.size;
}

// ------------------------------------------------------------ neon signs

const NEON_VERT = /* glsl */ `
attribute vec4 aPos;  // x, y, z, yaw (the wall's facing)
attribute vec4 aSig;  // width, height, colour (-1 = off), seed
uniform float uNight;
varying vec2 vUv;
varying vec4 vSig;
varying vec3 vW;
void main() {
  float c = cos( aPos.w );
  float s = sin( aPos.w );
  vec2 q = position.xy * aSig.xy * 1.6;
  vec3 w = aPos.xyz + vec3( c, 0.0, -s ) * q.x + vec3( 0.0, q.y, 0.0 );
  vUv = position.xy * 1.6;
  vSig = aSig;
  vW = w;
  gl_Position = projectionMatrix * viewMatrix * vec4( w, 1.0 );
  if ( uNight < 0.01 || aSig.z < -0.5 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
}`;

const NEON_FRAG = /* glsl */ `
uniform float uNight;
uniform float uTime;
varying vec2 vUv;
varying vec4 vSig;
varying vec3 vW;
${FOG_GLSL}
float nh( float n ) { return fract( sin( n ) * 43758.5453 ); }
float seg( vec2 p, vec2 a, vec2 b ) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  return length( pa - ba * clamp( dot( pa, ba ) / dot( ba, ba ), 0.0, 1.0 ) );
}
vec3 neonCol( float i ) {
  if ( i < 0.5 ) return vec3( 1.0, 0.18, 0.62 );
  if ( i < 1.5 ) return vec3( 0.15, 0.85, 1.0 );
  if ( i < 2.5 ) return vec3( 0.35, 1.0, 0.35 );
  if ( i < 3.5 ) return vec3( 1.0, 0.5, 0.12 );
  if ( i < 4.5 ) return vec3( 1.0, 0.12, 0.1 );
  return vec3( 0.62, 0.32, 1.0 );
}
void main() {
  vec2 sz = vSig.xy;
  vec2 P = vUv * sz;
  // the frame: a rounded tube rectangle
  vec2 hb = sz * 0.5 - 0.016;
  vec2 dq = abs( P ) - hb + 0.02;
  float d = abs( length( max( dq, 0.0 ) ) + min( max( dq.x, dq.y ), 0.0 ) - 0.02 );
  // lettering: a row of glyphs along the long side, each a few strokes picked by a hash
  bool vert = sz.y > sz.x;
  vec2 g = vert ? vec2( -P.y, P.x ) : P;
  float L = ( vert ? sz.y : sz.x ) - 0.07;
  float S = ( vert ? sz.x : sz.y ) - 0.06;
  float n = max( 1.0, floor( L / ( S * 0.7 ) ) );
  float cw = L / n;
  float gx = ( g.x + L * 0.5 ) / cw;
  float gi = floor( gx );
  float dead = 0.0;
  float broken = step( vSig.w, 0.22 );
  if ( gi >= 0.0 && gi < n && abs( g.y ) < S * 0.5 ) {
    vec2 lc = vec2( ( fract( gx ) - 0.5 ) * cw, g.y );
    float hx = cw * 0.28;
    float hy = S * 0.36;
    float h = nh( gi * 7.13 + vSig.w * 91.0 );
    float h2 = nh( gi * 3.71 + vSig.w * 17.0 );
    float k = 1e3;
    if ( h > 0.25 ) k = min( k, seg( lc, vec2( -hx, -hy ), vec2( -hx, hy ) ) );
    if ( h2 > 0.4 ) k = min( k, seg( lc, vec2( hx, -hy ), vec2( hx, hy ) ) );
    if ( fract( h * 5.0 ) > 0.35 ) k = min( k, seg( lc, vec2( -hx, hy ), vec2( hx, hy ) ) );
    if ( fract( h2 * 7.0 ) > 0.45 ) k = min( k, seg( lc, vec2( -hx, 0.0 ), vec2( hx, 0.0 ) ) );
    if ( fract( h * 11.0 ) > 0.4 ) k = min( k, seg( lc, vec2( -hx, -hy ), vec2( hx, -hy ) ) );
    if ( fract( h2 * 13.0 ) > 0.8 ) k = min( k, seg( lc, vec2( -hx, -hy ), vec2( hx, hy ) ) );
    // a broken sign has a dead letter
    dead = broken * step( abs( gi - floor( vSig.w * 37.0 ) + floor( floor( vSig.w * 37.0 ) / n ) * n ), 0.5 );
    if ( dead < 0.5 ) d = min( d, k );
  }
  vec3 nc = neonCol( vSig.z );
  float core = 1.0 - smoothstep( 0.008, 0.016, d );
  float halo = exp( -d * 30.0 ) * 0.8 + exp( -d * 8.0 ) * 0.2;
  // the halo fades out towards the card's edge
  halo *= 1.0 - smoothstep( 0.6, 0.8, max( abs( vUv.x ), abs( vUv.y ) ) );
  vec3 col = nc * halo + mix( nc, vec3( 1.0 ), 0.55 ) * core * 1.6;
  // buzz, and a broken sign's stutter
  float on = 0.94 + 0.06 * sin( uTime * 50.0 + vSig.w * 20.0 );
  on *= mix( 1.0, step( 0.3, nh( floor( uTime * 8.0 + vSig.w * 40.0 ) ) ) * 0.85 + 0.15 * step( 0.6, nh( floor( uTime * 3.0 + vSig.w * 9.0 ) ) ), broken );
  float vis = 1.0;
  if ( fogEnabled > 0.5 ) vis = smoothstep( 0.1, 0.45, fogSample( vW ) );
  gl_FragColor = vec4( col * on * uNight * vis * 2.0, 1.0 );
}`;

const NEON_RGB: [number, number, number][] = [
  [1.0, 0.18, 0.62],
  [0.15, 0.85, 1.0],
  [0.35, 1.0, 0.35],
  [1.0, 0.5, 0.12],
  [1.0, 0.12, 0.1],
  [0.62, 0.32, 1.0],
];

const SHOP_KINDS = new Set<StructureKind>([StructureKind.Shop, StructureKind.Block, StructureKind.Office]);
const VILLAGE_KINDS = new Set<StructureKind>([StructureKind.House, StructureKind.Cottage, StructureKind.Barn, StructureKind.MudHouse, StructureKind.Courtyard]);

function h3(a: number, b: number, c: number) {
  const h = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

interface Lamp {
  x: number;
  y: number;
  z: number;
  /** Instance index in the head mesh. */
  i: number;
  /** Ground height under the lamp. */
  g: number;
  deadUntil: number;
  flickUntil: number;
  faulty: boolean;
  off: boolean;
}

interface Fire {
  x: number;
  z: number;
  g: number;
  /** Lit on this night (temperate villages light some of them). */
  share: number;
  smokeT: number;
  flameT: number;
  sparkT: number;
}

interface Beam {
  x: number;
  z: number;
  g: number;
  ph: number;
  owner: number;
}

export class NightLife {
  private map: GameMap;
  private neon: THREE.Mesh | null = null;
  private neonU = { uNight: { value: 0 }, uTime: { value: 0 } } as Record<string, THREE.IUniform>;
  private signs: { x: number; y: number; z: number; yaw: number; c: number; seed: number; st: Structure; i: number }[] = [];
  private sigAttr: THREE.InstancedBufferAttribute | null = null;
  private lamps: Lamp[] = [];
  private lampHeads: THREE.InstancedMesh | null = null;
  private headM: Float32Array | null = null;
  private fires: Fire[] = [];
  private beams: Beam[] = [];
  private beamScan = 0;
  private dmgScan = 1;
  private windowsPatched = 0;
  private fireK = 0;
  /** Share of the campfires lit (cold climates all of them). */
  private cold = 1;
  private _m = new THREE.Matrix4();
  private _v = new THREE.Vector3();

  constructor(
    private host: AtmosHost,
    private biome: string,
    private q: Q,
    private probe: FogProbe,
    private nature: NatureFx | null,
    enabled: boolean,
  ) {
    this.map = host.world.map;
    if (!enabled) return;
    this.windowsPatched = patchWindows(host.scene);
    this.findLamps();
    if (q !== 'low') this.buildNeon();
    this.placeFires();
  }

  // ---------------------------------------------------------- setup

  /** The city's street lamps (instanced heads from models/citybldgs.ts, read-only but for blackouts). */
  private findLamps() {
    let heads: THREE.InstancedMesh | null = null;
    this.host.scene.traverse((o) => {
      const im = o as THREE.InstancedMesh;
      if (!heads && im.isInstancedMesh && o.name === 'city-lamps') {
        const m = im.material as THREE.MeshStandardMaterial;
        if (!Array.isArray(m) && m.emissive && m.emissive.r > 0.5) heads = im;
      }
    });
    if (!heads) return;
    const hm = heads as THREE.InstancedMesh;
    this.lampHeads = hm;
    this.headM = (hm.instanceMatrix.array as Float32Array).slice();
    for (let i = 0; i < hm.count; i++) {
      hm.getMatrixAt(i, this._m);
      const p = this._v.set(0, 0.675, 0.14).applyMatrix4(this._m);
      const g = groundHeight(this.map, Math.max(0, Math.min(this.map.w - 0.01, p.x)), Math.max(0, Math.min(this.map.h - 0.01, p.z)));
      this.lamps.push({ x: p.x, y: p.y, z: p.z, i, g, deadUntil: 0, flickUntil: 0, faulty: h3(p.x, p.z, 3) < 0.03, off: false });
    }
  }

  /** Neon signs on the shop fronts (ground floor) and a few vertical blade signs. */
  private buildNeon() {
    const m = this.map;
    const pos: number[] = [];
    const sig: number[] = [];
    for (const st of m.structures) {
      if (!SHOP_KINDS.has(st.kind)) continue;
      const h = (k: number) => h3(st.x * 7 + k, st.y * 13, 1931);
      if (h(1) < 0.25) continue;
      const cx = st.x + st.w / 2;
      const cz = st.y + st.h / 2;
      let gy = 99;
      for (const [x, z] of [
        [st.x, st.y],
        [st.x + st.w, st.y],
        [st.x, st.y + st.h],
        [st.x + st.w, st.y + st.h],
        [cx, cz],
      ])
        gy = Math.min(gy, groundHeight(m, x, z));
      const inset = st.kind === StructureKind.Office ? 0.15 : 0.08;
      const odd = st.rot % 2 === 1;
      const W = (odd ? st.h : st.w) - inset * 2;
      const D = (odd ? st.w : st.h) - inset * 2;
      const yaw = (st.rot * Math.PI) / 2;
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const rx = Math.cos(yaw);
      const rz = -Math.sin(yaw);
      const add = (lx: number, ly: number, lz: number, ya: number, w: number, hh: number) => {
        const c = Math.floor(h(5 + pos.length) * NEON_RGB.length);
        const seed = h(9 + pos.length);
        this.signs.push({ x: cx + rx * lx + fx * lz, y: gy + ly, z: cz + rz * lx + fz * lz, yaw: ya, c, seed, st, i: this.signs.length });
        pos.push(cx + rx * lx + fx * lz, gy + ly, cz + rz * lx + fz * lz, ya);
        sig.push(w, hh, c, seed);
      };
      // over the shop window, a little proud of the wall
      const sw = Math.min(W * 0.7, 0.42 + h(2) * 0.3);
      add((h(3) - 0.5) * (W - sw) * 0.6, 0.36 + h(4) * 0.04, D / 2 + 0.035, yaw, sw, 0.11 + h(6) * 0.05);
      // a vertical blade sign at the corner, sticking out of the wall
      if (h(7) < 0.4) {
        const side = h(8) < 0.5 ? -1 : 1;
        add(side * (W / 2 - 0.02), 0.62 + h(10) * 0.25, D / 2 + 0.06, yaw + Math.PI / 2, 0.1, 0.32 + h(11) * 0.16);
      }
      if (pos.length / 4 >= 160) break;
    }
    if (!pos.length) return;
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(new Float32Array(pos), 4));
    const sa = (this.sigAttr = new THREE.InstancedBufferAttribute(new Float32Array(sig), 4));
    geo.setAttribute('aSig', sa);
    geo.instanceCount = pos.length / 4;
    const fu = this.host.fog.uniforms as unknown as Record<string, THREE.IUniform>;
    this.neonU = { ...fu, uNight: { value: 0 }, uTime: { value: 0 } };
    const mat = new THREE.ShaderMaterial({ uniforms: this.neonU, vertexShader: NEON_VERT, fragmentShader: NEON_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false });
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -2;
    const mesh = (this.neon = new THREE.Mesh(geo, mat));
    mesh.frustumCulled = false;
    mesh.renderOrder = 7;
    mesh.name = 'neon-signs';
    mesh.visible = false;
    this.host.scene.add(mesh);
  }

  /** Campfire spots: one per village (in a yard by a house) and by the outposts (tech sites). */
  private placeFires() {
    if (this.biome === 'urban') return;
    const m = this.map;
    const cap = this.q === 'high' ? 12 : this.q === 'medium' ? 8 : 4;
    const ok = (x: number, z: number) => {
      const tx = Math.floor(x);
      const tz = Math.floor(z);
      if (tx < 1 || tz < 1 || tx >= m.w - 1 || tz >= m.h - 1) return false;
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const i = (tz + dz) * m.w + tx + dx;
          if ((dx === 0 && dz === 0 && (m.trees[i] || m.blocked[i])) || m.tiles[i] === Tile.Water || m.tiles[i] === Tile.Bridge || m.tiles[i] === Tile.Rock) return false;
        }
      // off the roads (sim road polylines, tile centres)
      for (const r of m.roads)
        for (let i = 0; i + 1 < r.length; i++) {
          const ax = r[i].x + 0.5;
          const az = r[i].y + 0.5;
          const bx = r[i + 1].x + 0.5 - ax;
          const bz = r[i + 1].y + 0.5 - az;
          const t = Math.max(0, Math.min(1, ((x - ax) * bx + (z - az) * bz) / Math.max(1e-6, bx * bx + bz * bz)));
          if (Math.hypot(ax + bx * t - x, az + bz * t - z) < 1.6) return false;
        }
      for (const s of m.starts) if (Math.hypot(s.x - x, s.y - z) < 14) return false;
      return !this.fires.some((f) => Math.hypot(f.x - x, f.z - z) < 9);
    };
    const add = (x: number, z: number, k: number) => {
      this.fires.push({ x, z, g: groundHeight(m, x, z), share: h3(x, z, 5) * k, smokeT: 0, flameT: 0, sparkT: 0 });
    };
    const tryAround = (cx: number, cz: number, r: number, k: number) => {
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2 + h3(cx, cz, 2) * 6;
        const x = cx + Math.cos(ang) * r;
        const z = cz + Math.sin(ang) * r;
        if (ok(x, z)) {
          add(x, z, k);
          return;
        }
      }
    };
    for (const st of m.structures) {
      if (this.fires.length >= cap) break;
      if (!VILLAGE_KINDS.has(st.kind)) continue;
      tryAround(st.x + st.w / 2, st.y + st.h / 2, Math.max(st.w, st.h) / 2 + 1.3, 1);
    }
    for (const t of m.techSites ?? [])
      for (const [ax, ay] of t.at)
        for (const [px, py] of [
          [ax, ay],
          [m.w - ax - 3, m.h - ay - 3],
        ]) {
          if (this.fires.length >= cap) break;
          tryAround(px + 1.5, py + 1.5, 3.2, 0.7);
        }
  }

  // ---------------------------------------------------------- per frame

  update(dt: number, time: number, gt: number, dark: number, atmos: Atmosphere, x0: number, z0: number, x1: number, z1: number) {
    // windows: the night's progress from the cycle (fixed night: a slow drift)
    const u = atmos.phase;
    let late = 0;
    if (u >= 0) late = u < 0.4 ? 0 : u < 0.74 ? sstep(0.47, 0.74, u) : 1 - 0.75 * sstep(0.75, 0.81, u);
    else if (atmos.cfg.tod === 'night') late = 0.2 + 0.55 * (0.5 - 0.5 * Math.cos((gt * Math.PI * 2) / 1440));
    CITY_LATE.value = late;
    CITY_CLOCK.value = gt;
    // neon: on with the city lights
    if (this.neon) {
      const k = CITY_NIGHT.value;
      this.neonU.uNight.value = k;
      this.neonU.uTime.value = time;
      this.neon.visible = k > 0.01;
      this.dmgScan -= dt;
      if (this.dmgScan <= 0) {
        this.dmgScan = 2;
        this.signDamage(atmos);
      }
    }
    // lamp blackouts end (the head comes back)
    if (this.lampHeads) {
      let dirty = false;
      const arr = this.lampHeads.instanceMatrix.array as Float32Array;
      for (const L of this.lamps) {
        const off = time < L.deadUntil;
        if (off === L.off) continue;
        L.off = off;
        dirty = true;
        const o = L.i * 16;
        if (off) for (let k = 0; k < 16; k++) arr[o + k] = k === 15 ? 1 : 0;
        else for (let k = 0; k < 16; k++) arr[o + k] = this.headM![o + k];
      }
      if (dirty) this.lampHeads.instanceMatrix.needsUpdate = true;
    }
    // searchlight bases (re-scanned now and then)
    this.beamScan -= dt;
    if (this.beamScan <= 0) {
      this.beamScan = 2.5;
      this.scanBases();
    }
    // campfires: on cold, dry nights (winter / snow / desert all of them, temperate villages some)
    const rain = atmos.wx ? atmos.wx.precip * (atmos.wx.fall === 'rain' ? 1 : 0) : atmos.cfg.weather === 'rain' ? 1 : 0;
    const cold = (this.cold = this.biome === 'winter' || this.biome === 'desert' || atmos.cfg.weather === 'snow' ? 1 : 0.6);
    this.fireK = sstep(0.5, 0.8, dark) * (1 - sstep(0.15, 0.4, rain)) * (atmos.wx?.fall === 'sandstorm' ? 1 - atmos.wx.precip : 1);
    if (this.fireK > 0.02 && this.q !== 'low') {
      const fx = this.host.effects;
      for (const f of this.fires) {
        if (f.share > cold || f.x < x0 - 1 || f.x > x1 + 1 || f.z < z0 - 1 || f.z > z1 + 1 || !this.probe.visible(f.x, f.z)) continue;
        f.flameT -= dt;
        if (f.flameT <= 0) {
          f.flameT = this.q === 'high' ? 0.09 : 0.16;
          fx.flame(f.x, f.g + 0.04, f.z, 0.3 * this.fireK);
        }
        f.smokeT -= dt;
        if (f.smokeT <= 0) {
          f.smokeT = 0.7 + Math.random() * 0.6;
          fx.smoke(f.x, f.g + 0.45, f.z, 0.45, false);
        }
        f.sparkT -= dt;
        if (f.sparkT <= 0 && this.nature) {
          f.sparkT = 0.15 + Math.random() * 0.35;
          const c = this._c.setRGB(1.0, 0.55, 0.16).multiplyScalar(1.6);
          this.nature.spawn(SPARK, f.x + (Math.random() - 0.5) * 0.1, f.g + 0.2, f.z + (Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.4, 0.9 + Math.random() * 0.9, (Math.random() - 0.5) * 0.4, 0.8 + Math.random() * 0.9, 0.05, c, 1, f.g);
        }
        if (this.q === 'high') fx.burnGlow(f.x, f.g + 0.3, f.z, 0.9 * this.fireK);
      }
    }
  }

  private _c = new THREE.Color();

  /** Signs on wrecked buildings go out (envdamage.ts house stages, read-only). */
  private signDamage(atmos: Atmosphere) {
    const sa = this.sigAttr;
    if (!sa) return;
    const houses = (atmos.env as unknown as { houses?: { h: { st: Structure }; stage: number }[] }).houses;
    if (!houses) return;
    let dirty = false;
    for (const H of houses) {
      if (H.stage < 1) continue;
      for (const s of this.signs) {
        if (s.st !== H.h.st || sa.getZ(s.i) < 0) continue;
        sa.setZ(s.i, -1);
        dirty = true;
      }
    }
    if (dirty) sa.needsUpdate = true;
  }

  private scanBases() {
    const w = this.host.world;
    const fog = this.host.fog.texture.image.data as Uint8Array;
    this.beams.length = 0;
    for (const e of w.entities.values()) {
      if (e.kind !== 'building' || e.dead || e.owner < 0) continue;
      if (buildingDef(e.def)?.role !== 'conyard') continue;
      const cx = e.tx + 1.5;
      const cz = e.ty + 1.5;
      // known ground only (an unexplored base gives nothing away)
      const fi = Math.min(this.map.h - 1, Math.max(0, cz | 0)) * this.map.w + Math.min(this.map.w - 1, Math.max(0, cx | 0));
      if (this.host.fog.uniforms.fogEnabled.value > 0.5 && fog[fi] < 60) continue;
      for (const [ox, oz, ph] of [
        [-2.2, 1.9, 0],
        [2.1, -2.0, 2.6],
      ] as const) {
        if (this.beams.length >= 8) break;
        const x = cx + ox;
        const z = cz + oz;
        this.beams.push({ x, z, g: groundHeight(this.map, Math.max(0, Math.min(this.map.w - 0.01, x)), Math.max(0, Math.min(this.map.h - 0.01, z))), ph: ph + e.id * 0.7, owner: e.owner });
      }
    }
  }

  /** Shelling: lamps nearby stutter, some die for a while; building lamps too (NightLights). */
  impact(x: number, y: number, size: number, time: number, night: NightLights | null) {
    const r = 3 + size * 2.2;
    night?.outage(x, y, r, time, 18 + Math.random() * 30);
    for (const L of this.lamps) {
      const d = Math.hypot(L.x - x, L.z - y);
      if (d > r) continue;
      L.flickUntil = Math.max(L.flickUntil, time + 0.6 + Math.random() * 2.2);
      if (Math.random() < 0.55 * (1 - d / r) + 0.15) L.deadUntil = Math.max(L.deadUntil, time + 15 + Math.random() * 45);
    }
  }

  /** NightLights hook: lamp pools, sign spill, searchlights, campfires. */
  draw(n: NightLights, dk: number, time: number, x0: number, z0: number, x1: number, z1: number) {
    const k = CITY_NIGHT.value;
    // street lamps
    if (k > 0.01 && this.lamps.length) {
      let budget = this.q === 'high' ? 90 : this.q === 'medium' ? 60 : 0;
      for (const L of this.lamps) {
        if (budget <= 0) break;
        if (L.x < x0 || L.x > x1 || L.z < z0 || L.z > z1) continue;
        let f = 1;
        if (time < L.deadUntil) {
          // just died: a last stutter, otherwise dark; it stutters back on at the end
          if (time > L.deadUntil - 1.2 || time < L.flickUntil) f = Math.sin(time * 41 + L.x * 7) > 0.3 ? 0.8 : 0;
          else continue;
        } else if (time < L.flickUntil || time < L.deadUntil + 1.5) f = Math.sin(time * 37 + L.z * 9) * Math.sin(time * 13 + L.x) > 0.05 ? 1 : 0.1;
        else if (L.faulty) f = Math.sin(time * 23 + L.x * 5) > -0.6 || Math.sin(time * 2.1 + L.z) > 0.7 ? 1 : 0.15;
        if (f <= 0) continue;
        budget--;
        const kk = k * f;
        n.flare(L.x, L.y - 0.02, L.z, 0.22, 2.1 * kk, 1.55 * kk, 0.85 * kk);
        n.pool(L.x, L.g, L.z, 0, 2.2, 2.2, 0.22 * kk, 0.16 * kk, 0.085 * kk);
      }
    }
    // neon spill on the pavement
    if (this.neon && k > 0.01) {
      let budget = this.q === 'high' ? 40 : 24;
      const sa = this.sigAttr!;
      for (const s of this.signs) {
        if (budget <= 0) break;
        if (s.x < x0 || s.x > x1 || s.z < z0 || s.z > z1 || sa.getZ(s.i) < 0) continue;
        budget--;
        const c = NEON_RGB[s.c];
        const on = s.seed < 0.22 ? (Math.sin(time * 23 + s.seed * 99) > -0.2 ? 0.8 : 0.1) : 1;
        const kk = k * on * 0.2;
        const fx = Math.sin(s.yaw);
        const fz = Math.cos(s.yaw);
        n.pool(s.x + fx * 0.35, s.y - Math.max(0, s.y - groundHeight(this.map, s.x, s.z)), s.z + fz * 0.35, -s.yaw, 1.0, 0.8, c[0] * kk, c[1] * kk, c[2] * kk);
      }
    }
    // searchlights sweeping the night sky over the bases
    const sk = sstep(0.5, 0.85, dk);
    if (sk > 0.01)
      for (const b of this.beams) {
        const t = time * 0.23 + b.ph;
        const yaw = b.ph * 1.7 + Math.sin(t) * 1.3 + Math.sin(t * 0.37) * 0.6;
        const pitch = 0.95 + 0.28 * Math.sin(t * 0.71 + 1.3);
        const kk = sk * 0.95;
        n.cone(b.x, b.g + 0.45, b.z, yaw, pitch, 30, 1.9, 0.62 * kk, 0.68 * kk, 0.8 * kk);
        n.flare(b.x, b.g + 0.45, b.z, 0.5, 2.6 * kk, 2.7 * kk, 3.0 * kk);
        // a second, fainter cone inside: a brighter core of the beam
        n.cone(b.x, b.g + 0.45, b.z, yaw, pitch, 22, 0.7, 0.5 * kk, 0.55 * kk, 0.62 * kk);
      }
    // campfires: a flickering glow and pool (low quality: only these)
    const fk = this.fireK;
    if (fk > 0.02) {
      for (const f of this.fires) {
        if (f.share > this.cold || f.x < x0 - 2 || f.x > x1 + 2 || f.z < z0 - 2 || f.z > z1 + 2 || !this.probe.visible(f.x, f.z)) continue;
        const fl = (0.72 + 0.16 * Math.sin(time * 13 + f.x) + 0.12 * Math.sin(time * 29 + f.z * 3)) * fk;
        n.flare(f.x, f.g + 0.18, f.z, 0.42, 2.4 * fl, 1.2 * fl, 0.35 * fl);
        n.pool(f.x, f.g, f.z, 0, 3.2, 3.2, 0.42 * fl, 0.2 * fl, 0.06 * fl);
      }
    }
  }

  stats() {
    return { windows: this.windowsPatched, lamps: this.lamps.length, dead: this.lamps.filter((l) => l.off).length, signs: this.signs.length, fires: this.fires.length, beams: this.beams.length, late: +CITY_LATE.value.toFixed(2) };
  }

  dispose() {
    if (this.neon) {
      this.neon.removeFromParent();
      this.neon.geometry.dispose();
      (this.neon.material as THREE.Material).dispose();
    }
    // put the lamp heads back
    if (this.lampHeads && this.headM) {
      (this.lampHeads.instanceMatrix.array as Float32Array).set(this.headM);
      this.lampHeads.instanceMatrix.needsUpdate = true;
    }
    CITY_LATE.value = 0;
  }
}

// ------------------------------------------------------------ civilian headlights

/** The parts of an ambient car the headlight pools read (ambient/traffic.ts, read-only). */
interface CarLike {
  x: number;
  y: number;
  yaw: number;
  hgt: number;
  lift: number;
  s: number;
  seen: boolean;
  model: { len: number };
}

/**
 * Civilian headlights: queue a beam pool and a faint cone ahead of every lit car in view into the
 * night lights (called by AmbientLife after the traffic is drawn; reads the car list read-only).
 * Traffic could instead call `NightLights.carLight()` itself per car (then drop this bridge).
 */
export function queueHeadlights(traffic: unknown, night: NightLights | null, f: { vx0: number; vy0: number; vx1: number; vy1: number }) {
  if (!night || night.darkness < 0.08) return;
  const cars = (traffic as { cars?: CarLike[] }).cars;
  if (!Array.isArray(cars)) return;
  for (const c of cars) {
    // driving / off-road / rejoining only (not abandoned, wrecked or sinking: traffic.ts S)
    if (!c.seen || c.s === 2 || c.s >= 4) continue;
    if (c.x < f.vx0 || c.x > f.vx1 || c.y < f.vy0 || c.y > f.vy1) continue;
    const hx = Math.cos(c.yaw);
    const hy = Math.sin(c.yaw);
    const fl = (c.model?.len ?? 0.4) / 2;
    night.carLight(c.x + hx * fl, c.hgt + c.lift, c.y + hy * fl, -c.yaw, 1);
  }
}
