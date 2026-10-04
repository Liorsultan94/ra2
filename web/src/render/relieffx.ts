import * as THREE from 'three';
import { Tile, WATER_LEVEL, groundHeight, type GameMap } from '../sim/map';
import { hash2 } from '../sim/rng';
import type { FogOfWar } from './fog';
import { surfaceHeight } from './ground';
import { OCC_BUILT, OCC_ROAD, OCC_TRACK, occAt, type Layout } from './layout';
import { reliefField, reliefHeight } from './relief';
import { RIVER } from './water';

/*
 * Moving water on the relief (render only, built once by waterside.ts):
 *  - waterfalls where the map's water meets a cliff of the relief (relief.ts):
 *    a spring leaves the cap rock lip, falls free in a curtain clear of the
 *    face, then runs down the talus as a thin cascade into the pool. The
 *    stream is a ribbon flush with the ground (a few cm above it) so nothing
 *    standing on the slope clips it; the falling part hangs over rock tiles
 *    only. Foam pads at the plunge and where it enters the pool;
 *  - spray: GPU-animated billboards (one draw call for every emitter on the
 *    map) over the plunge pools and the rapids' rocks.
 * Both shaders run on the river clock (RIVER.time) and take the water's
 * wxLight tint, so day / night / weather light them like the river.
 */

export interface SprayEmitter {
  x: number;
  y: number;
  z: number;
  /** Spread radius (tiles), rise height, particle size, count. */
  r: number;
  h: number;
  size: number;
  n: number;
  /** Drift over a particle's life (downstream / wind), tiles. */
  dx?: number;
  dz?: number;
}

/** Spray / mist billboards for all emitters in one instanced draw call. */
export function buildSpray(emitters: SprayEmitter[], fog: FogOfWar, wxLight: { value: THREE.Vector3 }, waveTex: THREE.Texture, opacity = 1): THREE.Mesh | null {
  const total = emitters.reduce((a, e) => a + e.n, 0);
  if (!total) return null;
  const base = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.setAttribute('position', base.getAttribute('position'));
  g.setAttribute('uv', base.getAttribute('uv'));
  const org = new Float32Array(total * 3);
  const rnd = new Float32Array(total * 4);
  const par = new Float32Array(total * 4);
  const dr = new Float32Array(total * 2);
  let k = 0;
  const box = new THREE.Box3();
  emitters.forEach((e, ei) => {
    for (let i = 0; i < e.n; i++, k++) {
      org.set([e.x, e.y, e.z], k * 3);
      rnd.set([hash2(ei, i, 1201), hash2(ei, i, 1202), 0.35 + hash2(ei, i, 1203) * 0.4, 0.6 + hash2(ei, i, 1204) * 0.8], k * 4);
      par.set([e.r, e.h * (0.6 + hash2(ei, i, 1205) * 0.6), e.size, hash2(ei, i, 1206)], k * 4);
      dr.set([e.dx ?? 0, e.dz ?? 0], k * 2);
    }
    box.expandByPoint(new THREE.Vector3(e.x - e.r - 1, e.y - 0.2, e.z - e.r - 1));
    box.expandByPoint(new THREE.Vector3(e.x + e.r + 1, e.y + e.h + 0.6, e.z + e.r + 1));
  });
  g.setAttribute('aOrg', new THREE.InstancedBufferAttribute(org, 3));
  g.setAttribute('aRnd', new THREE.InstancedBufferAttribute(rnd, 4));
  g.setAttribute('aPar', new THREE.InstancedBufferAttribute(par, 4));
  g.setAttribute('aDrift', new THREE.InstancedBufferAttribute(dr, 2));
  g.instanceCount = total;
  g.boundingBox = box;
  g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { time: RIVER.time, wxLight, wState: RIVER.wState, waveTex: { value: waveTex }, opacity: { value: opacity }, ...fog.uniforms },
    vertexShader: /* glsl */ `
      attribute vec3 aOrg;
      attribute vec4 aRnd;
      attribute vec4 aPar;
      attribute vec2 aDrift;
      uniform float time;
      uniform vec4 wState;
      varying vec3 vWorld;
      varying vec2 vUv;
      varying float vA;
      varying float vSeed;
      void main() {
        float t = fract( time * aRnd.z * 0.5 + aRnd.x );
        float ang = aRnd.y * 6.2832 + t * 0.8;
        vec3 c = aOrg + vec3( cos( ang ), 0.0, sin( ang ) ) * aPar.x * ( 0.25 + t * 0.9 );
        // wind carries the mist off
        c.xz += aDrift * t + vec2( 0.25, -0.18 ) * wState.x * t;
        c.y += aPar.y * ( 1.0 - ( 1.0 - t ) * ( 1.0 - t ) );
        float s = aPar.z * ( 0.45 + t * 1.3 ) * aRnd.w;
        vec3 right = vec3( viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0] );
        vec3 up = vec3( viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1] );
        vec3 wp = c + ( right * position.x + up * position.y ) * s;
        vA = smoothstep( 0.0, 0.12, t ) * ( 1.0 - t ) * ( 1.0 - t );
        vSeed = aPar.w;
        vUv = uv;
        vWorld = wp;
        gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D waveTex;
      uniform vec3 wxLight;
      uniform float opacity;
      uniform sampler2D fogTex;
      uniform vec2 fogSize;
      uniform float fogEnabled;
      varying vec3 vWorld;
      varying vec2 vUv;
      varying float vA;
      varying float vSeed;
      void main() {
        vec2 q = vUv - 0.5;
        float r = length( q ) * 2.0;
        float n = texture2D( waveTex, vUv * 0.5 + vSeed * 7.0 ).a;
        float a = ( 1.0 - smoothstep( 0.25, 1.0, r + ( n - 0.5 ) * 0.5 ) ) * vA * opacity * 0.55;
        if ( a < 0.01 ) discard;
        vec3 col = vec3( 0.86, 0.9, 0.93 ) * wxLight;
        float fogV = texture2D(fogTex, vWorld.xz / fogSize).r;
        float fogK = fogV < 0.5 ? fogV * 0.9 : 0.45 + (fogV - 0.5) * 1.1;
        col *= mix(1.0, fogK, fogEnabled);
        col = (col.r >= 0.0 && col.g >= 0.0 && col.b >= 0.0) ? min(col, vec3(32.0)) : vec3(0.0);
        gl_FragColor = vec4( col, a );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  fog.upgradeShader(mat);
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'spray';
  mesh.renderOrder = 3;
  mesh.userData.perfCat = 'waterside';
  return mesh;
}

// ------------------------------------------------------------------ waterfalls

interface Fall {
  /** Path points (x, y, z), cumulative length, steepness 0..1, half width. */
  pts: { x: number; y: number; z: number; s: number; steep: number; hw: number }[];
  plunge: THREE.Vector3;
  entry: THREE.Vector3;
  dir: { x: number; z: number };
}

/**
 * Find the waterfall spots: per body of water, the cliff of the relief whose
 * cap rock lies closest to its shore (at most ~3 tiles of slope between),
 * with a clear run down to the water (no road, track, building or bridge).
 */
function findFalls(m: GameMap, layout: Layout): Fall[] {
  const rf = reliefField(m);
  if (!rf.count) return [];
  const F = rf.F;
  // label the water bodies
  const lab = new Int32Array(m.w * m.h).fill(-1);
  const bodies: { x: number; y: number }[][] = [];
  for (let i = 0; i < m.w * m.h; i++) {
    if (m.tiles[i] !== Tile.Water || lab[i] >= 0) continue;
    const id = bodies.length;
    const shore: { x: number; y: number }[] = [];
    const st = [i];
    lab[i] = id;
    while (st.length) {
      const c = st.pop()!;
      const cx = c % m.w;
      const cy = (c - cx) / m.w;
      let edge = false;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= m.w || ny >= m.h) continue;
        const n = ny * m.w + nx;
        if (m.tiles[n] === Tile.Water) {
          if (lab[n] < 0) {
            lab[n] = id;
            st.push(n);
          }
        } else edge = true;
      }
      if (edge && groundHeight(m, cx + 0.5, cy + 0.5) < WATER_LEVEL - 0.05) shore.push({ x: cx + 0.5, y: cy + 0.5 });
    }
    bodies.push(shore);
  }
  const falls: Fall[] = [];
  const clear = (x: number, y: number) => {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return false;
    const i = ty * m.w + tx;
    if (m.tiles[i] === Tile.Bridge || m.blocked[i] || m.ore[i]) return false;
    for (const b of m.bridges) if (Math.hypot(x - b.x, y - b.y) < b.length / 2 + 1) return false;
    return !(occAt(layout, m, x, y) & (OCC_ROAD | OCC_TRACK | OCC_BUILT));
  };
  for (const shore of bodies) {
    let best: { d: number; vx: number; vy: number; wx: number; wy: number } | null = null;
    for (const w of shore) {
      const i0 = Math.max(0, Math.floor((w.x - 3.5) * F));
      const i1 = Math.min(rf.NW - 1, Math.ceil((w.x + 3.5) * F));
      const j0 = Math.max(0, Math.floor((w.y - 3.5) * F));
      const j1 = Math.min(rf.NH - 1, Math.ceil((w.y + 3.5) * F));
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const k = j * rf.NW + i;
          // the cap rock near its edge, well above the pool
          if (rf.p[k] < 0.92 || rf.d[k] > 0.95 || rf.H[k] - WATER_LEVEL < 1.1) continue;
          const vx = i / F;
          const vy = j / F;
          const d = Math.hypot(vx - w.x, vy - w.y);
          if (d > 3.6 || (best && d >= best.d)) continue;
          best = { d, vx, vy, wx: w.x, wy: w.y };
        }
    }
    if (!best) continue;
    const L = Math.hypot(best.wx - best.vx, best.wy - best.vy);
    const dx = (best.wx - best.vx) / L;
    const dz = (best.wy - best.vy) / L;
    // the lip: walk out from the cap rock to where the cliff drops away
    let lx = best.vx;
    let lz = best.vy;
    for (let t = 0; t < L; t += 0.05) {
      const x = best.vx + dx * t;
      const z = best.vy + dz * t;
      if (reliefHeight(m, x, z) < reliefHeight(m, best.vx, best.vy) - 0.12) break;
      lx = x;
      lz = z;
    }
    const pts: Fall['pts'] = [];
    const top = reliefHeight(m, lx, lz) + 0.03;
    // free fall: a parabola clear of the face, then the cascade on the slope
    let x = lx;
    let z = lz;
    let y = top;
    let vy = 0;
    const vh = 0.9; // horizontal speed (tiles / s)
    let s = 0;
    let ok = true;
    let plunge: THREE.Vector3 | null = null;
    let falling = true;
    const dt = 0.04;
    for (let n = 0; n < 400; n++) {
      const ground = Math.max(reliefHeight(m, x, z), surfaceHeight(m, x, z));
      const wet = ground < WATER_LEVEL;
      if (falling) {
        const floor = ground + 0.05;
        if (y <= floor && n > 0) {
          y = floor;
          falling = false;
          plunge = new THREE.Vector3(x, y, z);
        }
      } else y = Math.max(ground, WATER_LEVEL) + (wet ? 0.012 : 0.035);
      const prev = pts[pts.length - 1];
      if (prev) s += Math.hypot(x - prev.x, y - prev.y, z - prev.z);
      const steep = prev ? Math.min(1, Math.abs(prev.y - y) / Math.max(0.02, Math.hypot(x - prev.x, z - prev.z)) / 3) : 1;
      // off the rock the stream lies on ground units walk on: it must not cross a road, a bridge or a building
      if (rf.d[Math.round(z * F) * rf.NW + Math.round(x * F)] <= 0 && !clear(x, z)) {
        ok = false;
        break;
      }
      pts.push({ x, y, z, s, steep: falling ? 1 : steep, hw: falling ? 0.16 + Math.min(0.08, (top - y) * 0.05) : 0.2 });
      if (wet && !falling && WATER_LEVEL - ground > 0.12) break;
      if (falling) {
        vy -= 9.8 * 0.35 * dt;
        x += dx * vh * dt;
        z += dz * vh * dt;
        y += vy * dt * 3;
      } else {
        x += dx * 0.08;
        z += dz * 0.08;
      }
    }
    if (!ok || !plunge || pts.length < 4) continue;
    const e = pts[pts.length - 1];
    falls.push({ pts, plunge, entry: new THREE.Vector3(e.x, WATER_LEVEL + 0.01, e.z), dir: { x: dx, z: dz } });
    if (falls.length >= 4) break;
  }
  return falls;
}

function fallGeometry(f: Fall): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const st: number[] = [];
  const idx: number[] = [];
  const ax = -f.dir.z;
  const az = f.dir.x;
  const A = 4;
  f.pts.forEach((p, i) => {
    for (let a = 0; a <= A; a++) {
      const u = a / A;
      const o = (u - 0.5) * 2 * p.hw;
      pos.push(p.x + ax * o, p.y, p.z + az * o);
      uv.push(u, p.s);
      st.push(p.steep);
    }
    if (i > 0)
      for (let a = 0; a < A; a++) {
        const k = (i - 1) * (A + 1) + a;
        idx.push(k, k + A + 1, k + 1, k + 1, k + A + 1, k + A + 2);
      }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aSteep', new THREE.Float32BufferAttribute(st, 1));
  g.setIndex(idx);
  return g;
}

/** Flat foam pad (disc) at a point, on the ground / water. */
function padGeometry(c: THREE.Vector3, r: number, m: GameMap, onWater: boolean): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const st: number[] = [];
  const idx: number[] = [];
  const R = 3;
  const S = 12;
  pos.push(c.x, c.y, c.z);
  uv.push(0.5, -1);
  st.push(2);
  for (let j = 1; j <= R; j++)
    for (let i = 0; i < S; i++) {
      const a = (i / S) * Math.PI * 2;
      const rr = (j / R) * r * (0.85 + hash2(i, j, 1301) * 0.3);
      const x = c.x + Math.cos(a) * rr;
      const z = c.z + Math.sin(a) * rr;
      const y = onWater ? c.y : Math.max(surfaceHeight(m, x, z), reliefHeight(m, x, z), WATER_LEVEL) + 0.04;
      pos.push(x, y, z);
      uv.push(0.5 + Math.cos(a) * 0.5 * (j / R), -1 - j / R);
      st.push(2);
    }
  for (let j = 0; j < R; j++)
    for (let i = 0; i < S; i++) {
      const i2 = (i + 1) % S;
      if (j === 0) idx.push(0, 1 + i2, 1 + i);
      else {
        const a0 = 1 + (j - 1) * S;
        const a1 = 1 + j * S;
        idx.push(a0 + i, a0 + i2, a1 + i, a0 + i2, a1 + i2, a1 + i);
      }
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aSteep', new THREE.Float32BufferAttribute(st, 1));
  g.setIndex(idx);
  return g;
}

export interface FallsBuild {
  objects: THREE.Object3D[];
  spray: SprayEmitter[];
}

/** Waterfalls off the relief's cliffs into the map's pools (merged in one mesh, one draw call). */
export function buildFalls(
  m: GameMap,
  layout: Layout,
  fog: FogOfWar,
  wxLight: { value: THREE.Vector3 },
  waveTex: THREE.Texture,
  /** Extra foam collars on the water (riverbed boulders breaking the surface). */
  pads: { x: number; y: number; r: number }[] = [],
): FallsBuild {
  const falls = findFalls(m, layout);
  if (!falls.length && !pads.length) return { objects: [], spray: [] };
  const geos: THREE.BufferGeometry[] = [];
  const spray: SprayEmitter[] = [];
  for (const p of pads) geos.push(padGeometry(new THREE.Vector3(p.x, WATER_LEVEL + 0.012, p.y), p.r, m, true));
  for (const f of falls) {
    geos.push(fallGeometry(f));
    geos.push(padGeometry(f.plunge, 0.32, m, false));
    geos.push(padGeometry(f.entry, 0.45, m, true));
    const h = f.pts[0].y - f.plunge.y;
    spray.push({ x: f.plunge.x, y: f.plunge.y, z: f.plunge.z, r: 0.22, h: 0.35 + h * 0.25, size: 0.32, n: 22, dx: f.dir.x * 0.3, dz: f.dir.z * 0.3 });
    spray.push({ x: f.entry.x, y: f.entry.y, z: f.entry.z, r: 0.25, h: 0.15, size: 0.22, n: 8, dx: f.dir.x * 0.3, dz: f.dir.z * 0.3 });
  }
  // merge by hand (same attributes)
  let nv = 0;
  let ni = 0;
  for (const g of geos) {
    nv += g.getAttribute('position').count;
    ni += g.index!.count;
  }
  const pos = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const st = new Float32Array(nv);
  const idx = new Uint32Array(ni);
  let ov = 0;
  let oi = 0;
  for (const g of geos) {
    const c = g.getAttribute('position').count;
    pos.set(g.getAttribute('position').array as Float32Array, ov * 3);
    uv.set(g.getAttribute('uv').array as Float32Array, ov * 2);
    st.set(g.getAttribute('aSteep').array as Float32Array, ov);
    const ia = g.index!.array;
    for (let i = 0; i < ia.length; i++) idx[oi + i] = ia[i] + ov;
    ov += c;
    oi += ia.length;
    g.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aSteep', new THREE.BufferAttribute(st, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { time: RIVER.time, waveTex: { value: waveTex }, wxLight, wState: RIVER.wState, ...fog.uniforms },
    vertexShader: /* glsl */ `
      attribute float aSteep;
      varying vec3 vWorld;
      varying vec2 vUv;
      varying float vSteep;
      void main() {
        vUv = uv;
        vSteep = aSteep;
        vec4 wp = modelMatrix * vec4( position, 1.0 );
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform float time;
      uniform sampler2D waveTex;
      uniform vec3 wxLight;
      uniform vec4 wState;
      uniform sampler2D fogTex;
      uniform vec2 fogSize;
      uniform float fogEnabled;
      varying vec3 vWorld;
      varying vec2 vUv;
      varying float vSteep;
      void main() {
        vec3 col;
        float a;
        if ( vSteep > 1.5 ) {
          // foam pad: churning rings, ragged edge
          float r = clamp( -vUv.y - 1.0, 0.0, 1.0 );
          float n1 = texture2D( waveTex, vWorld.xz * 1.3 + vec2( time * 0.11, -time * 0.07 ) ).a;
          float n2 = texture2D( waveTex, vWorld.xz * 2.9 - vec2( time * 0.17, time * 0.05 ) ).a;
          float f = smoothstep( 0.35, 0.7, n1 * 0.55 + n2 * 0.45 + ( 1.0 - r ) * 0.35 );
          col = vec3( 0.86, 0.9, 0.91 );
          a = f * ( 1.0 - smoothstep( 0.55, 1.0, r ) ) * 0.9;
        } else {
          float u = vUv.x;
          float v = vUv.y;
          float sp = mix( 0.7, 2.4, vSteep );
          float n1 = texture2D( waveTex, vec2( u * 0.7, v * 0.55 - time * sp * 0.45 ) ).a;
          float n2 = texture2D( waveTex, vec2( u * 1.9 + 0.31, v * 1.4 - time * sp ) ).a;
          float streak = texture2D( waveTex, vec2( u * 3.3 + 0.7, v * 0.25 - time * sp * 0.6 ) ).a;
          float foam = smoothstep( 0.42, 0.78, n1 * 0.5 + n2 * 0.35 + streak * 0.25 + vSteep * 0.22 );
          vec3 water = vec3( 0.07, 0.11, 0.1 );
          col = mix( water, vec3( 0.86, 0.9, 0.92 ), clamp( foam * ( 0.45 + 0.55 * vSteep ) + vSteep * 0.3, 0.0, 1.0 ) );
          float edge = smoothstep( 0.0, 0.22 + ( n2 - 0.5 ) * 0.15, u ) * smoothstep( 0.0, 0.22 + ( n1 - 0.5 ) * 0.15, 1.0 - u );
          a = edge * mix( 0.72, 0.92, vSteep );
        }
        col *= wxLight;
        // frozen in the hard winter
        a *= 1.0 - wState.w * 0.6;
        float fogV = texture2D(fogTex, vWorld.xz / fogSize).r;
        float fogK = fogV < 0.5 ? fogV * 0.9 : 0.45 + (fogV - 0.5) * 1.1;
        col *= mix(1.0, fogK, fogEnabled);
        col = (col.r >= 0.0 && col.g >= 0.0 && col.b >= 0.0) ? min(col, vec3(32.0)) : vec3(0.0);
        gl_FragColor = vec4( col, a );
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  fog.upgradeShader(mat);
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'waterfalls';
  mesh.renderOrder = 2;
  mesh.userData.perfCat = 'waterside';
  console.info(`[relief] ${falls.length} waterfalls`);
  return { objects: [mesh], spray };
}
