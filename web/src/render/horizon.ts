import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { type GameMap, WATER_LEVEL } from '../sim/map';
import { fbm, hash2 } from '../sim/rng';
import { FOG_GLSL, type FogOfWar } from './fog';
import { CITY_NIGHT } from './models/citybldgs';
import { RIVER } from './water';
import { HZ_CELL, HZ_MARGIN, HZ_RADIUS, horizonWorld, type HorizonWorld } from './horizonworld';

/*
 * The world past the map edge, out to the horizon (render only; see horizonworld.ts for the
 * terrain itself). Everything here is a handful of merged / instanced draws:
 *
 *  - far terrain ring: one mesh from the outskirts' outer edge (84 units past the map) out to
 *    HZ_RADIUS, square at the inside (it shares the outskirts' boundary vertices, so no seam)
 *    turning into a circle outside; the biome's relief, painted per vertex (fields, forest, rock,
 *    snow) with the outskirts' field patchwork near by;
 *  - aerial perspective: every outskirts / horizon material swaps the battlefield's fog block for
 *    `hzShade` - the map edge keeps the fog of war (fading out over ~16 units), further out the
 *    ground melts by distance into the sky's horizon colour (sky.ts), thicker in bad weather, so the
 *    far ring ends seamlessly in the sky dome;
 *  - far water: one opaque sheet (meandering rivers, Canal City's bay, Frontline's lake) with a
 *    cheap version of the river shader (same tints, sky / sun / ice), breaking waves on the beach
 *    and around the breakwater;
 *  - forests as billboard cards (one instanced draw), towns and villages as instanced houses /
 *    blocks with windows that light up at dusk, and a point-sprite layer of distant lights at night;
 *  - roads and railways leaving the map continue as ribbons;
 *  - Canal City's harbour: quays, container cranes, stacked containers, moored and anchored ships,
 *    a breakwater with a lighthouse (its beam sweeps at night).
 *
 * Phone (medium): ring 264 x ~34 quads, ~2400 cards, no extra shadow casters.
 */

/** Shared horizon uniforms (sky.ts drives the density and tells whether a sky dome is up). */
export const HORIZON = {
  /** Aerial perspective density (1 / units). */
  hzDens: { value: 1 / 520 },
  /** 1 when the physical sky dome is drawn (its horizon colour is valid). */
  hzSky: { value: 0 },
  hzCentre: { value: new THREE.Vector2(48, 48) },
  hzOuter: { value: HZ_RADIUS },
  hzMargin: { value: HZ_MARGIN },
};

/**
 * Aerial perspective for everything past the map edge (needs FOG_GLSL before it). The map edge keeps
 * the battlefield's look (fog of war, haze, mist); beyond ~16 units the land is no longer shrouded nor
 * darkened, it fades by distance into the horizon colour.
 */
export const HZ_GLSL = /* glsl */ `
uniform float hzDens;
uniform float hzSky;
uniform vec2 hzCentre;
uniform float hzOuter;
uniform float hzMargin;
vec3 hzHorizonCol( vec3 p ) {
  vec2 vd = normalize( p.xz - cameraPosition.xz + 1e-4 );
  vec3 hz = mix( skyHorB.rgb, skyHorA.rgb, dot( vd, skySunXZ ) * 0.5 + 0.5 );
  return hzSky > 0.5 ? hz : hazeColor;
}
float hzAmount( vec3 p ) {
  float dist = length( p - cameraPosition );
  float a = 1.0 - exp( -max( dist - 30.0, 0.0 ) * hzDens );
  return max( a, smoothstep( hzOuter * 0.8, hzOuter * 0.97, length( p.xz - hzCentre ) ) );
}
vec3 hzShade( vec3 col, vec3 p ) {
  vec2 o = max( -p.xz, p.xz - fogSize );
  float outside = length( max( o, 0.0 ) );
  vec3 inner = fogShade( col, p );
  float w = smoothstep( 2.0, 16.0, outside );
  if ( w <= 0.0 ) return inner;
  float depth = dot( p - fogTarget, fogView );
  float haze = clamp( ( depth - hazeParams.x ) / ( hazeParams.y - hazeParams.x ), 0.0, 1.0 ) * hazeParams.z;
  vec3 c = mix( col, hazeColor, haze * ( 1.0 - skyHorA.a ) );
  c = mistShade( c, p );
  c = mix( c, hzHorizonCol( p ), hzAmount( p ) );
  return mix( inner, c, w );
}
`;

/** Swap the battlefield fog block of a `fog.apply`-patched material for the horizon one (call inside onBeforeCompile, after the fog patch). */
export function hzFragment(frag: string): string {
  return frag
    .replace('#include <map_pars_fragment>', `#include <map_pars_fragment>\n${HZ_GLSL}`)
    .replace('outgoingLight = fogShade( outgoingLight, vFogP );', 'outgoingLight = hzShade( outgoingLight, vFogP );');
}

/** fog.apply + the horizon fog block. */
export function hzApply<T extends THREE.Material>(fog: FogOfWar, mat: T, key: string, extra?: (shader: THREE.WebGLProgramParametersWithUniforms) => void): T {
  fog.apply(mat);
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    prev.call(mat, shader, r);
    Object.assign(shader.uniforms, HORIZON);
    shader.fragmentShader = hzFragment(shader.fragmentShader);
    extra?.(shader);
  };
  mat.customProgramCacheKey = () => 'hz1-' + key;
  return mat;
}

/** A copy of an already fog-patched material (shared with the battlefield) that uses the horizon fog block. */
export function hzClone<T extends THREE.Material>(src: T, key: string): T {
  const m = src.clone() as T;
  const ob = src.onBeforeCompile;
  m.onBeforeCompile = (shader, r) => {
    ob.call(src, shader, r);
    Object.assign(shader.uniforms, HORIZON);
    shader.fragmentShader = hzFragment(shader.fragmentShader);
  };
  const ck = src.customProgramCacheKey();
  m.customProgramCacheKey = () => ck + '-hz-' + key;
  return m;
}

/** A copy of the battlefield's water ShaderMaterial (same uniforms, live) with the horizon fog block. */
export function hzWaterClone(src: THREE.ShaderMaterial): THREE.ShaderMaterial | null {
  if (!src.fragmentShader.includes('col = fogShade(col, vWorld);')) return null;
  const m = src.clone();
  m.uniforms = { ...src.uniforms, ...HORIZON };
  m.fragmentShader = src.fragmentShader.replace('col = fogShade(col, vWorld);', 'col = hzShade(col, vWorld);').replace(/void main\(\)\s*\{/, `${HZ_GLSL}\nvoid main() {`);
  m.userData = src.userData;
  return m;
}

const ss = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

type Q = 'low' | 'medium' | 'high';

/** Coloured, uv-less indexed geometry helpers (harbour, ships, cranes). */
function paint(g: THREE.BufferGeometry, col: THREE.Color): THREE.BufferGeometry {
  g.deleteAttribute('uv');
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = col.r;
    a[i * 3 + 1] = col.g;
    a[i * 3 + 2] = col.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
const C = (hex: number, k = 1) => new THREE.Color(hex).multiplyScalar(k);
function box(w: number, h: number, d: number, x: number, y: number, z: number, col: THREE.Color, ry = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return paint(g, col);
}
function cyl(rt: number, rb: number, h: number, x: number, y: number, z: number, col: THREE.Color, seg = 10) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, false);
  g.translate(x, y, z);
  return paint(g, col);
}
const UP = new THREE.Vector3(0, 1, 0);
const SIDE = new THREE.Vector3(1, 0, 0);
function beam(a: THREE.Vector3, b: THREE.Vector3, t: number, col: THREE.Color) {
  const len = a.distanceTo(b);
  const g = new THREE.BoxGeometry(t, t, len);
  const m = new THREE.Matrix4().lookAt(a, b, Math.abs(b.clone().sub(a).normalize().y) > 0.95 ? SIDE : UP);
  m.setPosition(a.clone().add(b).multiplyScalar(0.5));
  g.applyMatrix4(m);
  return paint(g, col);
}

const CONTAINER_COLS = [0x9a3324, 0x2d5a8a, 0x3f7a3a, 0xc7782b, 0x7d7f82, 0xd6c9a3, 0x6b2f5c, 0x1f6f78, 0xb8b2a1, 0x8a2a20];

export class Horizon {
  readonly group = new THREE.Group();
  private world: HorizonWorld;
  private lights: { pos: number[]; col: number[]; size: number[] } = { pos: [], col: [], size: [] };
  private beamMesh: THREE.Mesh | null = null;
  private lampPos: THREE.Vector3 | null = null;

  constructor(
    private map: GameMap,
    private fog: FogOfWar,
    private quality: Q,
    private terrainWater?: THREE.Mesh,
    deferred = false,
  ) {
    this.group.name = 'horizon';
    this.world = horizonWorld(map);
    HORIZON.hzCentre.value.set(map.w / 2, map.h / 2);
    if (!deferred) for (const _ of this.steps()) void _;
  }

  /** The construction, one yield per part (outskirts.ts runs them in time slices). */
  *steps(): Generator<void> {
    // debug: ?hzskip=ring,water,paths,towns,forest,harbour,lights (or all)
    const skip = (typeof location !== 'undefined' && new URLSearchParams(location.search).get('hzskip')) || '';
    const on = (k: string) => !skip.includes(k) && !skip.includes('all');
    if (on('ring')) yield* this.buildRing();
    yield;
    if (on('water')) this.buildWater(this.terrainWater);
    yield;
    if (on('paths')) this.buildPaths();
    yield;
    const towns = on('towns') ? this.buildTowns() : [];
    yield;
    if (on('forest')) this.buildForest(towns);
    yield;
    if (this.world.sea && on('harbour')) this.buildHarbour();
    yield;
    if (on('lights')) this.buildLights();
  }

  // ------------------------------------------------------------------ terrain ring

  /** sRGB albedo + field-pattern weight of the far ground at (x, y). */
  private albedo(x: number, y: number, h: number, sl: number, d: number, out: number[]): number {
    const W = this.world;
    const code = W.code;
    const forest = ss(0.52, 0.6, fbm(x * 0.018, y * 0.018, 707, 3));
    const n = fbm(x * 0.05, y * 0.05, 709, 2) - 0.5;
    let r: number, g: number, b: number, fk: number;
    const set = (c: number[]) => ((r = c[0]), (g = c[1]), (b = c[2]));
    const mix = (c: number[], k: number) => {
      r += (c[0] - r) * k;
      g += (c[1] - g) * k;
      b += (c[2] - b) * k;
    };
    r = g = b = 0;
    if (code === 1) {
      set([0.8, 0.64, 0.43]);
      mix([0.86, 0.72, 0.5], ss(0.0, 0.5, n + 0.2));
      mix([0.64, 0.4, 0.27], ss(0.35, 0.8, sl));
      mix([0.72, 0.54, 0.36], ss(9, 14, h) * (1 - ss(0.5, 0.9, sl)));
      mix([0.62, 0.47, 0.35], ss(30, 60, h));
      fk = (1 - ss(0.2, 0.5, sl)) * (1 - ss(3, 8, h));
    } else if (code === 2) {
      set([0.84, 0.87, 0.93]);
      const woods = Math.max(forest, ss(0.15, 0.4, sl) * 0.8) * (1 - ss(40, 60, h));
      mix([0.17, 0.21, 0.18], woods * 0.85);
      mix([0.38, 0.38, 0.41], ss(0.75, 1.2, sl) * 0.85);
      mix([0.9, 0.92, 0.97], ss(70, 110, h) * (1 - ss(1.1, 1.6, sl)));
      fk = (1 - woods) * (1 - ss(0.12, 0.3, sl)) * (1 - ss(8, 20, h));
    } else if (code === 3) {
      set([0.37, 0.43, 0.26]);
      const sub = (1 - ss(120, 200, d)) * (1 - ss(0.1, 0.25, sl));
      mix([0.47, 0.45, 0.42], sub * 0.7);
      mix([0.2, 0.27, 0.15], forest * (1 - sub) * 0.85);
      mix([0.45, 0.43, 0.4], ss(0.6, 1.0, sl));
      fk = sub * (1 - ss(150, 190, d));
    } else {
      set([0.41, 0.42, 0.24]);
      const woods = Math.max(forest, ss(0.22, 0.5, sl) * 0.7);
      mix([0.36, 0.45, 0.22], ss(6, 18, h) * 0.6);
      mix([0.17, 0.24, 0.12], woods * 0.9);
      mix([0.46, 0.44, 0.4], Math.max(ss(0.7, 1.1, sl), ss(55, 80, h)) * 0.8);
      fk = (1 - woods) * (1 - ss(0.15, 0.35, sl)) * (1 - ss(10, 26, h));
    }
    // shores, beds, the beach and the container yard
    if (h < WATER_LEVEL + 0.3) {
      mix(code === 2 ? [0.7, 0.72, 0.76] : [0.5, 0.46, 0.36], 1 - ss(WATER_LEVEL + 0.1, WATER_LEVEL + 0.3, h));
      fk *= ss(WATER_LEVEL + 0.1, WATER_LEVEL + 0.3, h);
    }
    if (W.sea) {
      const { u, v } = W.seaV(x, y);
      const hb = u > W.sea.harbour[0] && u < W.sea.harbour[1];
      const k = ss(hb ? -46 : -12, hb ? -40 : -4, v);
      mix(hb ? [0.5, 0.5, 0.48] : [0.84, 0.76, 0.58], k);
      fk *= 1 - k;
    }
    out[0] = r * (1 + n * 0.12);
    out[1] = g * (1 + n * 0.12);
    out[2] = b * (1 + n * 0.12);
    return fk;
  }

  private *buildRing(): Generator<void> {
    const W = this.world;
    const { w } = this.map;
    const M = HZ_MARGIN;
    const s0 = w / 2 + M;
    const n0 = Math.round((w + 2 * M) / HZ_CELL);
    const N0 = n0 * 4;
    const f = this.quality === 'high' ? 1 : this.quality === 'medium' ? 2 : 4;
    const N1 = N0 / f;
    const loops: number[] = [s0];
    let s = s0;
    let step = HZ_CELL;
    while (s < HZ_RADIUS) {
      step *= this.quality === 'low' ? 1.16 : 1.1;
      s = Math.min(HZ_RADIUS, s + step);
      loops.push(s);
    }
    const pos: number[] = [];
    const col: number[] = [];
    const fks: number[] = [];
    const cx = this.map.w / 2;
    const cy = this.map.h / 2;
    const c3 = [0, 0, 0];
    const loopStart: number[] = [];
    // positions and heights first, then slopes from the neighbours (one height evaluation per vertex)
    const hs: number[] = [];
    for (let k = 0; k < loops.length; k++) {
      const sk = loops[k];
      const N = k === 0 ? N0 : N1;
      loopStart.push(pos.length / 3);
      const wk = ss(0, 1, (sk - s0) / 260);
      for (let i = 0; i < N; i++) {
        const t = (i / N) * 4;
        const side = Math.floor(t);
        const fr = t - side;
        const qx = side === 0 ? -1 + 2 * fr : side === 1 ? 1 : side === 2 ? 1 - 2 * fr : -1;
        const qy = side === 0 ? -1 : side === 1 ? -1 + 2 * fr : side === 2 ? 1 : 1 - 2 * fr;
        const ql = Math.hypot(qx, qy);
        const rad = sk * (1 - wk + wk / ql);
        const x = k === 0 ? cx + qx * sk : cx + qx * rad;
        const y = k === 0 ? cy + qy * sk : cy + qy * rad;
        const h = W.height(x, y);
        pos.push(x, h, y);
        hs.push(h);
      }
      if ((k & 3) === 3) yield;
    }
    const vAt = (k: number, i: number) => {
      const N = k === 0 ? N0 : N1;
      return loopStart[k] + (((i % N) + N) % N);
    };
    for (let k = 0; k < loops.length; k++) {
      const N = k === 0 ? N0 : N1;
      for (let i = 0; i < N; i++) {
        const a = vAt(k, i);
        const x = pos[a * 3];
        const y = pos[a * 3 + 2];
        const h = hs[a];
        const l0 = vAt(k, i - 1);
        const l1 = vAt(k, i + 1);
        const lat = Math.abs(hs[l1] - hs[l0]) / Math.max(0.5, Math.hypot(pos[l1 * 3] - pos[l0 * 3], pos[l1 * 3 + 2] - pos[l0 * 3 + 2]));
        let rad = 0;
        if (k > 0 && k < loops.length - 1) {
          const r0 = vAt(k - 1, k === 1 ? i * f : i);
          const r1 = vAt(k + 1, i);
          rad = Math.abs(hs[r1] - hs[r0]) / Math.max(0.5, Math.hypot(pos[r1 * 3] - pos[r0 * 3], pos[r1 * 3 + 2] - pos[r0 * 3 + 2]));
        }
        const sl = Math.hypot(lat, rad);
        const fk = this.albedo(x, y, h, sl, W.outside(x, y), c3);
        col.push(c3[0], c3[1], c3[2]);
        fks.push(fk);
      }
      if ((k & 3) === 3) yield;
    }
    const idx: number[] = [];
    // loop 0 (outskirts resolution) stitched to loop 1 (counter-clockwise from above = front faces up)
    const a0 = loopStart[0];
    const b0 = loopStart[1];
    for (let j = 0; j < N1; j++) {
      const c0 = b0 + j;
      const c1 = b0 + ((j + 1) % N1);
      const fine = (i: number) => a0 + ((j * f + i) % N0);
      const half = f === 1 ? 1 : f / 2;
      for (let i = 0; i < f; i++) idx.push(fine(i), fine(i + 1), i < half ? c0 : c1);
      idx.push(fine(half), c1, c0);
    }
    for (let k = 1; k < loops.length - 1; k++) {
      const a = loopStart[k];
      const b = loopStart[k + 1];
      for (let i = 0; i < N1; i++) {
        const i1 = (i + 1) % N1;
        idx.push(a + i, a + i1, b + i, a + i1, b + i1, b + i);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('fk', new THREE.Float32BufferAttribute(fks, 1));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0 });
    hzApply(this.fog, mat, 'ring-' + W.code, (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float fk;\nvarying float vFk;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFk = fk;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying float vFk;`)
        .replace('#include <map_pars_fragment>', `#include <map_pars_fragment>\n${OSK_FIELDS_GLSL}`)
        .replace(
          '#include <color_fragment>',
          `{
            vec3 c = vColor.rgb;
            float camD = length( vFogP - cameraPosition );
            float fk = vFk * ( 1.0 - smoothstep( 170.0, 380.0, camD ) );
            if ( fk > 0.01 ) c = mix( c, oskFields( vFogP.xz ), fk );
            vec4 gn = texture2D( fogNoise, vFogP.xz * 0.37 );
            vec4 gn2 = texture2D( fogNoise, vFogP.xz * 1.9 );
            vec4 gf = texture2D( fogNoise, vFogP.xz * 0.023 + 0.31 );
            float fine = 0.86 + gn.r * 0.18 + gn2.g * 0.12;
            float coarse = 0.8 + gf.r * 0.3;
            c *= mix( fine, coarse, smoothstep( 60.0, 160.0, camD ) );
            diffuseColor.rgb *= pow( max( c, vec3( 0.0 ) ), vec3( 2.2 ) );
          }`,
        );
    });
    mat.defines = { ...(mat.defines ?? {}), OSK_BIOME: W.code };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'horizon-ring';
    // night lights / lighthouse beam switch (the ring is always in view of any camera that sees the outskirts)
    mesh.onBeforeRender = () => this.update();
    mesh.receiveShadow = false;
    this.group.add(mesh);
  }

  // ------------------------------------------------------------------ water

  private buildWater(terrainWater?: THREE.Mesh) {
    const W = this.world;
    if (!W.rivers.length && !W.sea && !W.lakes.length) return;
    const src = terrainWater?.material as THREE.ShaderMaterial | undefined;
    const su = src?.uniforms;
    const { w, h } = this.map;
    const R = HZ_RADIUS;
    const cx = w / 2;
    const cy = h / 2;
    const rect = (x0: number, y0: number, x1: number, y1: number) =>
      new THREE.PlaneGeometry(x1 - x0, y1 - y0).rotateX(-Math.PI / 2).translate((x0 + x1) / 2, 0, (y0 + y1) / 2);
    const geo = mergeGeometries([rect(cx - R, cy - R, cx + R, 0), rect(cx - R, h, cx + R, cy + R), rect(cx - R, 0, 0, h), rect(w, 0, cx + R, h)])!;
    const sea = W.sea;
    const lake = W.lakes[0];
    const uni = {
      time: RIVER.time,
      sunDir: RIVER.sunDir,
      sunCol: RIVER.sunCol,
      wState: RIVER.wState,
      wState2: RIVER.wState2,
      wxLight: su?.wxLight ?? { value: new THREE.Vector3(1, 1, 1) },
      wxSpec: su?.wxSpec ?? { value: 1 },
      skyTop: su?.skyTop ?? { value: new THREE.Color(0x4a6488) },
      skyHorizon: su?.skyHorizon ?? { value: new THREE.Color(0x8a8678) },
      wTurq: su?.wTurq ?? { value: new THREE.Vector3(...W.look.water.turq) },
      wDeep: su?.wDeep ?? { value: new THREE.Vector3(...W.look.water.deep) },
      wIceK: su?.wIceK ?? { value: W.look.iceK },
      waveTex: su?.waveTex ?? { value: null },
      heightTex: su?.heightTex ?? { value: null },
      mapSize: { value: new THREE.Vector2(w, h) },
      waterLevel: { value: WATER_LEVEL },
      seaOn: { value: sea ? 1 : 0 },
      seaN: { value: new THREE.Vector4(sea?.nx ?? 0, sea?.ny ?? 0, sea?.ux ?? 0, sea?.uy ?? 0) },
      seaOff: { value: sea?.off ?? 0 },
      seaHarb: { value: new THREE.Vector2(...(sea?.harbour ?? [0, 0])) },
      seaMole: { value: new THREE.Vector4(...(sea ? [W.seaPoint(sea.mole[0], sea.mole[1]), W.seaPoint(sea.mole[2], sea.mole[3])].flatMap((p) => [p.x, p.y]) : [0, 0, 0, 0])) },
      lakeA: { value: new THREE.Vector4(lake?.x ?? 0, lake?.y ?? 0, lake?.rx ?? 1, lake?.ry ?? 1) },
      lakeB: { value: new THREE.Vector3(lake?.c ?? 1, lake?.s ?? 0, lake ? 1 : 0) },
      ...this.fog.uniforms,
      ...HORIZON,
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: uni,
      defines: { HAS_HT: su?.heightTex ? 1 : 0, HAS_WAVE: su?.waveTex ? 1 : 0, HQ: this.quality === 'high' ? 1 : 0 },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4( position, 1.0 );
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform float time;
        uniform vec3 sunDir;
        uniform vec3 sunCol;
        uniform vec4 wState;
        uniform vec4 wState2;
        uniform vec3 wxLight;
        uniform float wxSpec;
        uniform vec3 skyTop;
        uniform vec3 skyHorizon;
        uniform vec3 wTurq;
        uniform vec3 wDeep;
        uniform float wIceK;
        uniform sampler2D waveTex;
        uniform sampler2D heightTex;
        uniform vec2 mapSize;
        uniform float waterLevel;
        uniform float seaOn;
        uniform vec4 seaN;
        uniform float seaOff;
        uniform vec2 seaHarb;
        uniform vec4 seaMole;
        uniform vec4 lakeA;
        uniform vec3 lakeB;
        varying vec3 vWorld;
        ${FOG_GLSL}
        ${HZ_GLSL}
        float wig( float u ) { return 4.0 * sin( u * 0.045 ) + 2.5 * sin( u * 0.13 + 1.0 ); }
        void main() {
          vec2 p = vWorld.xz;
          vec2 o = max( max( -p, p - mapSize ), 0.0 );
          float cheb = max( o.x, o.y );
          #if HAS_HT
          // the battlefield's own water sheet still draws the rivers straight out of the edge in the near belt
          if ( cheb < hzMargin ) {
            vec2 q = clamp( p, vec2( 0.0 ), mapSize );
            float g = texture2D( heightTex, ( q + 0.5 ) / ( mapSize + 1.0 ) ).r * 4.5 - 1.5;
            if ( g < waterLevel ) discard;
          }
          #endif
          float dist = length( vWorld - cameraPosition );
          vec3 V = ( cameraPosition - vWorld ) / dist;
          // open water depth proxy (units from the shore) and the breaking-wave zone
          float sv = -1e3;
          float su = 0.0;
          if ( seaOn > 0.5 ) {
            vec2 pc = p - hzCentre;
            su = dot( pc, seaN.zw );
            sv = dot( pc, seaN.xy ) - seaOff + wig( su );
          }
          float lv = -1e3;
          if ( lakeB.z > 0.5 ) {
            vec2 d = p - lakeA.xy;
            vec2 r = vec2( dot( d, lakeB.xy ), dot( d, vec2( -lakeB.y, lakeB.x ) ) ) / lakeA.zw;
            lv = ( 1.0 - length( r ) ) * min( lakeA.z, lakeA.w );
          }
          float open = max( sv, lv );
          // in the near belt only the bay / lake is ours (the low hollows there are dry ground just above the water line)
          if ( cheb < hzMargin - 2.0 && open < -4.0 ) discard;
          float depthK = open > -100.0 ? smoothstep( 0.0, 40.0, open ) : 0.6;
          // ripples (fade with distance so the far sheet never shimmers)
          float fade = 1.0 - smoothstep( 60.0, 260.0, dist );
          vec3 n = vec3( 0.0, 1.0, 0.0 );
          #if HAS_WAVE
          vec2 w1 = texture2D( waveTex, p * 0.045 + vec2( time * 0.012, time * 0.007 ) ).rg * 2.0 - 1.0;
          vec2 w2 = texture2D( waveTex, p * 0.11 - vec2( time * 0.017, -time * 0.011 ) ).rg * 2.0 - 1.0;
          vec2 sl = ( w1 * 0.6 + w2 * 0.4 ) * ( 0.25 + 0.35 * wState.x ) * ( 0.25 + 0.75 * fade ) * ( 1.0 - 0.7 * wState.y );
          n = normalize( vec3( sl.x, 1.0, sl.y ) );
          #endif
          float fres = 0.02 + 0.98 * pow( 1.0 - max( dot( n, V ), 0.0 ), 5.0 );
          vec3 R = reflect( -V, n );
          R.y = abs( R.y );
          vec3 refl = mix( skyHorizon, skyTop, smoothstep( 0.05, 0.8, R.y ) ) * 0.55;
          if ( hzSky > 0.5 ) refl = mix( refl, hzHorizonCol( vWorld ), ( 1.0 - smoothstep( 0.0, 0.25, R.y ) ) * 0.8 );
          vec3 under = mix( wTurq * 0.8, wDeep, 0.55 + 0.45 * depthK );
          vec3 col = mix( under, refl, fres );
          col *= wxLight * ( 1.0 - 0.2 * wState.x );
          float sd = max( dot( R, sunDir ), 0.0 );
          col += sunCol * ( pow( sd, 220.0 ) * 2.2 + pow( sd, 24.0 ) * 0.08 * fade ) * wxSpec;
          // breaking waves on the beach and around the breakwater, swell lines further out
          float foam = 0.0;
          if ( seaOn > 0.5 && sv > -2.0 ) {
            bool quay = su > seaHarb.x && su < seaHarb.y;
            float ph = sv * 0.55 + time * 1.3 + sin( su * 0.08 ) * 1.5;
            float crest = smoothstep( 0.75, 0.98, sin( ph ) * 0.5 + 0.5 );
            float surf = ( 1.0 - smoothstep( 1.0, quay ? 2.0 : 13.0, sv ) ) * crest;
            float lap = 1.0 - smoothstep( 0.0, quay ? 0.4 : 1.4, sv );
            foam = max( surf * 0.85, lap * ( 0.6 + 0.4 * sin( time * 1.7 + su * 0.6 ) ) );
            // the breakwater
            vec2 ma = seaMole.xy;
            vec2 mb = seaMole.zw;
            vec2 ab = mb - ma;
            float t = clamp( dot( p - ma, ab ) / dot( ab, ab ), 0.0, 1.0 );
            float dm = length( p - ma - ab * t );
            float sw = 0.5 + 0.5 * sin( dm * 1.4 - time * 2.1 + t * 9.0 );
            foam = max( foam, ( 1.0 - smoothstep( 1.4, 3.8, dm ) ) * ( 0.45 + 0.55 * sw ) );
            foam *= fade * 0.85 + 0.15;
            foam *= 1.0 - wState.y * 0.6;
          }
          // ice (the winter river freezes over)
          float ice = clamp( wIceK - 1.0, 0.0, 1.0 ) * 0.85 + wState.w * 0.4;
          vec3 iceC = mix( vec3( 0.55, 0.62, 0.68 ), vec3( 0.82, 0.86, 0.9 ), texture2D( fogNoise, p * 0.05 ).r );
          col = mix( col, iceC * wxLight + sunCol * pow( sd, 40.0 ) * 0.3 * wxSpec, clamp( ice, 0.0, 0.95 ) );
          col = mix( col, vec3( 0.86, 0.9, 0.92 ) * wxLight, foam * ( 1.0 - ice ) );
          col = hzShade( col, vWorld );
          col = ( col.r >= 0.0 && col.g >= 0.0 && col.b >= 0.0 ) ? min( col, vec3( 32.0 ) ) : vec3( 0.0 );
          gl_FragColor = vec4( col, 1.0 );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = WATER_LEVEL;
    // after the ground: the hidden parts are rejected by the depth test
    mesh.renderOrder = 1;
    mesh.name = 'horizon-water';
    this.group.add(mesh);
  }

  // ------------------------------------------------------------------ roads / railways

  private buildPaths() {
    const W = this.world;
    const parts: THREE.BufferGeometry[] = [];
    const asphalt = C(0x3c3d40);
    const line = C(0x5a5b5c);
    const ballast = C(0x5e554b);
    const rail = C(0x2f2b28);
    const sand = C(0xa08a68);
    for (const p of W.paths) {
      const pos: number[] = [];
      const col: number[] = [];
      const idx: number[] = [];
      const pts = p.pts;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)];
        const b = pts[Math.min(pts.length - 1, i + 1)];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const l = Math.hypot(dx, dy) || 1;
        dx /= l;
        dy /= l;
        const d = W.outside(pts[i].x, pts[i].y);
        const hw = (p.width / 2) * (1 + d / 260) + (p.kind === 'rail' ? 0.15 : 0);
        const lift = 0.06 + d * 0.0025;
        // three across: edge, centre, edge
        for (const k of [-1, 0, 1]) {
          const x = pts[i].x - dy * hw * k;
          const y = pts[i].y + dx * hw * k;
          const h = Math.max(W.height(x, y), WATER_LEVEL + 0.25);
          pos.push(x, h + lift, y);
          const c = p.kind === 'rail' ? (k === 0 ? rail : ballast) : W.code === 1 && p.width < 0.9 ? sand : k === 0 ? line : asphalt;
          col.push(c.r, c.g, c.b);
        }
        if (i > 0) {
          const s = (i - 1) * 3;
          const e = i * 3;
          idx.push(s, e, s + 1, s + 1, e, e + 1, s + 1, e + 1, s + 2, s + 2, e + 1, e + 2);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      parts.push(g);
      // street lamps along the roads near the map (night)
      if (p.kind === 'road')
        for (let i = 4; i < pts.length; i += 6) {
          const d = W.outside(pts[i].x, pts[i].y);
          if (d > 160 || hash2(i, parts.length, 811) < 0.35) continue;
          this.addLight(pts[i].x, W.height(pts[i].x, pts[i].y) + 0.8, pts[i].y, [1.0, 0.62, 0.3], 0.5);
        }
    }
    if (!parts.length) return;
    const geo = mergeGeometries(parts)!;
    geo.computeVertexNormals();
    // roads lie flat: light them like the ground beneath
    const nrm = geo.attributes.normal as THREE.BufferAttribute;
    for (let i = 0; i < nrm.count; i++) nrm.setXYZ(i, 0, 1, 0);
    const mat = hzApply(this.fog, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }), 'paths');
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'horizon-roads';
    this.group.add(mesh);
  }

  // ------------------------------------------------------------------ towns and villages

  private windowTextures(): { map: THREE.CanvasTexture; em: THREE.CanvasTexture } {
    const N = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = N;
    const g = cv.getContext('2d')!;
    g.fillStyle = '#d8d2c6';
    g.fillRect(0, 0, N, N);
    const ce = document.createElement('canvas');
    ce.width = ce.height = N;
    const ge = ce.getContext('2d')!;
    ge.fillStyle = '#000';
    ge.fillRect(0, 0, N, N);
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) {
        g.fillStyle = '#4a4e56';
        g.fillRect(x * 16 + 4, y * 16 + 4, 8, 8);
        if (hash2(x, y, 177) < 0.5) {
          ge.fillStyle = hash2(x, y, 178) < 0.85 ? '#ffc070' : '#c0d4ff';
          ge.fillRect(x * 16 + 4, y * 16 + 4, 8, 8);
        }
      }
    // the bottom-left corner stays plain wall (roofs map there)
    g.fillStyle = '#d8d2c6';
    g.fillRect(0, 48, 16, 16);
    ge.fillStyle = '#000';
    ge.fillRect(0, 48, 16, 16);
    const map = new THREE.CanvasTexture(cv);
    map.colorSpace = THREE.SRGBColorSpace;
    const em = new THREE.CanvasTexture(ce);
    em.colorSpace = THREE.SRGBColorSpace;
    return { map, em };
  }

  /** Town sites along the far roads and scattered over the open country. */
  private townSites(): { x: number; y: number; r: number; n: number }[] {
    const W = this.world;
    const sites: { x: number; y: number; r: number; n: number }[] = [];
    const ok = (x: number, y: number, r: number) => {
      const d = W.outside(x, y);
      if (d < HZ_MARGIN + 12 || Math.hypot(x - W.cx, y - W.cy) > HZ_RADIUS * 0.82) return false;
      if (sites.some((s) => Math.hypot(s.x - x, s.y - y) < s.r + r + 30)) return false;
      if (W.slope(x, y, 6) > 0.18 || W.isWater(x, y)) return false;
      if (W.sea && W.seaV(x, y).v > -14) return false;
      return true;
    };
    W.paths.forEach((p, pi) => {
      if (p.kind !== 'road') return;
      for (let i = 10; i < p.pts.length; i += 9) {
        const a = p.pts[i];
        const r = 7 + hash2(i, pi, 901) * 9;
        if (hash2(i, pi, 902) < 0.45 || !ok(a.x, a.y, r)) continue;
        sites.push({ x: a.x, y: a.y, r, n: Math.round(r * 2.4) });
      }
    });
    for (let k = 0; k < 400 && sites.length < 16; k++) {
      const ang = hash2(k, 1, 903) * Math.PI * 2;
      const rr = HZ_MARGIN + W.w / 2 + 30 + Math.pow(hash2(k, 2, 903), 1.4) * (HZ_RADIUS * 0.75 - W.w / 2 - HZ_MARGIN - 30);
      const x = W.cx + Math.cos(ang) * rr;
      const y = W.cy + Math.sin(ang) * rr;
      const r = 5 + hash2(k, 3, 903) * 8;
      if (!ok(x, y, r)) continue;
      sites.push({ x, y, r, n: Math.round(r * 2) });
    }
    return sites;
  }

  private buildTowns(): { x: number; y: number; r: number }[] {
    const W = this.world;
    const code = W.code;
    const sites = this.townSites();
    if (!sites.length) return [];
    const houses: { m: THREE.Matrix4; c: THREE.Color }[] = [];
    const blocks: { m: THREE.Matrix4; c: THREE.Color }[] = [];
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const wallCols = code === 1 ? [0xc9a77c, 0xd8bc90, 0xb8916a, 0xe0cfa8] : code === 2 ? [0x8a5a3c, 0xa0703f, 0xc9b9a0, 0x6d4a35] : [0xe2dccf, 0xd8c9a8, 0xc9b49a, 0xbfc3c4, 0xe8e0c8];
    sites.forEach((s, si) => {
      const ang = hash2(si, 1, 920) * Math.PI;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      let placed = 0;
      for (let k = 0; k < s.n * 3 && placed < s.n; k++) {
        // a loose grid around the main street
        const gx = (hash2(k, si, 921) - 0.5) * 2 * s.r;
        const gy = (hash2(k, si, 922) - 0.5) * 2 * s.r * 0.75;
        if (Math.hypot(gx, gy / 0.75) > s.r) continue;
        const sx = Math.round(gx / 3.2) * 3.2 + (hash2(k, si, 923) - 0.5) * 0.6;
        const sy = Math.round(gy / 3.2) * 3.2 + 1.0 * Math.sign(gy || 1);
        const x = s.x + sx * ca - sy * sa;
        const y = s.y + sx * sa + sy * ca;
        if (W.nearPath(x, y, 0.6)) continue;
        const hgt = W.height(x, y);
        if (hgt < WATER_LEVEL + 0.15) continue;
        const centre = 1 - Math.hypot(gx, gy) / s.r;
        const big = code === 3 || (code === 1 && hash2(k, si, 924) < 0.7);
        const yaw = ang + (hash2(k, si, 925) < 0.5 ? 0 : Math.PI / 2);
        q.setFromAxisAngle(UP, yaw);
        const col = C(wallCols[Math.floor(hash2(k, si, 926) * wallCols.length)], 0.92 + hash2(k, si, 927) * 0.12);
        if (big) {
          const tall = code === 3 ? 2 + centre * 9 * hash2(k, si, 928) + hash2(k, si, 929) * 2 : 1.1 + hash2(k, si, 928) * 0.8;
          sc.set(2.2 + hash2(k, si, 930) * 1.4, tall, 2.2 + hash2(k, si, 931) * 1.4);
          blocks.push({ m: new THREE.Matrix4().compose(v.set(x, hgt - 0.1, y), q, sc), c: col });
        } else {
          sc.set(1.7 + hash2(k, si, 930) * 0.9, 1.0 + hash2(k, si, 931) * 0.5, 1.4 + hash2(k, si, 932) * 0.5);
          houses.push({ m: new THREE.Matrix4().compose(v.set(x, hgt - 0.05, y), q, sc), c: col });
        }
        if (hash2(k, si, 933) < 0.5) this.addLight(x, hgt + 1.0, y, hash2(k, si, 934) < 0.85 ? [1.0, 0.72, 0.4] : [0.75, 0.82, 1.0], 0.55);
        placed++;
      }
      // a church / mosque tower in the bigger places
      if (s.n > 18) {
        const hgt = W.height(s.x, s.y);
        if (hgt > WATER_LEVEL + 0.15 && !W.nearPath(s.x, s.y, 0.6)) {
          q.identity();
          blocks.push({ m: new THREE.Matrix4().compose(v.set(s.x, hgt - 0.1, s.y), q, sc.set(0.9, code === 3 ? 12 : 5.5, 0.9)), c: C(code === 1 ? 0xe6d6b0 : 0xbdb7aa) });
          this.addLight(s.x, hgt + (code === 3 ? 12.3 : 5.8), s.y, [1.0, 0.25, 0.15], 0.6);
        }
      }
    });
    const { map, em } = this.windowTextures();
    const roofCol = code === 2 ? [0.86, 0.88, 0.93] : code === 1 ? [0.75, 0.62, 0.45] : [0.52, 0.24, 0.17];
    const mkMat = (key: string) => {
      const mat = new THREE.MeshStandardMaterial({ map, emissiveMap: em, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.85, metalness: 0, vertexColors: true });
      return hzApply(this.fog, mat, key);
    };
    const add = (geo: THREE.BufferGeometry, list: typeof houses, name: string) => {
      if (!list.length) return;
      const mat = mkMat(name);
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((e, i) => {
        im.setMatrixAt(i, e.m);
        im.setColorAt(i, e.c);
      });
      im.computeBoundingSphere();
      im.name = name;
      im.onBeforeRender = () => {
        mat.emissiveIntensity = CITY_NIGHT.value * 1.5;
      };
      this.group.add(im);
    };
    // house: a box with a gable roof (roof faces map to the plain wall corner of the texture; vertex colour = roof tint)
    const body = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const bc = new Float32Array(body.attributes.position.count * 3).fill(1);
    body.setAttribute('color', new THREE.BufferAttribute(bc, 3));
    const roof = new THREE.CylinderGeometry(0.62, 0.62, 1.06, 3, 1).rotateZ(Math.PI / 2).scale(1, 0.75, 1).translate(0, 1.18, 0);
    const ruv = roof.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < ruv.count; i++) ruv.setXY(i, 0.1, 0.1);
    const rc = new Float32Array(roof.attributes.position.count * 3);
    for (let i = 0; i < roof.attributes.position.count; i++) rc.set(roofCol, i * 3);
    roof.setAttribute('color', new THREE.BufferAttribute(rc, 3));
    roof.deleteAttribute('normal');
    const roofN = roof.toNonIndexed();
    roofN.computeVertexNormals();
    const bodyN = body.toNonIndexed();
    const house = mergeGeometries([bodyN, roofN])!;
    add(house, houses, 'horizon-houses');
    const blk = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const kc = new Float32Array(blk.attributes.position.count * 3).fill(1);
    // flat roofs: plain
    const buv = blk.attributes.uv as THREE.BufferAttribute;
    for (let i = 8; i < 16; i++) buv.setXY(i, 0.1, 0.1);
    blk.setAttribute('color', new THREE.BufferAttribute(kc, 3));
    add(blk, blocks, 'horizon-blocks');
    return sites;
  }

  // ------------------------------------------------------------------ forests (billboard cards)

  private cardTexture(): THREE.CanvasTexture {
    const S = 128;
    const cv = document.createElement('canvas');
    cv.width = S * 2;
    cv.height = S;
    const g = cv.getContext('2d')!;
    g.clearRect(0, 0, S * 2, S);
    // conifer
    for (let i = 0; i < 6; i++) {
      const y0 = 8 + i * 17;
      const hw = 12 + i * 8;
      const sh = 40 + i * 9;
      g.fillStyle = `rgb(${sh},${sh + 30},${sh + 8})`;
      g.beginPath();
      g.moveTo(S / 2, y0);
      g.lineTo(S / 2 + hw, y0 + 30);
      g.lineTo(S / 2 - hw, y0 + 30);
      g.closePath();
      g.fill();
    }
    g.fillStyle = '#3b2a1c';
    g.fillRect(S / 2 - 4, S - 16, 8, 16);
    // broadleaf
    g.fillStyle = '#3b2a1c';
    g.fillRect(S + S / 2 - 5, S - 34, 10, 34);
    const blobs = [
      [0, 40, 34],
      [-22, 56, 26],
      [22, 56, 26],
      [-10, 28, 24],
      [12, 30, 24],
      [0, 70, 26],
    ];
    for (const [bx, by, br] of blobs) {
      const grd = g.createRadialGradient(S + S / 2 + bx - br * 0.3, by - br * 0.3, br * 0.2, S + S / 2 + bx, by, br);
      grd.addColorStop(0, '#8fae6a');
      grd.addColorStop(1, '#3e5a2c');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(S + S / 2 + bx, by, br, 0, Math.PI * 2);
      g.fill();
    }
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 2;
    return t;
  }

  private buildForest(towns: { x: number; y: number; r: number }[]) {
    const W = this.world;
    const code = W.code;
    if (code === 1) return;
    const budget = this.quality === 'high' ? 5200 : this.quality === 'medium' ? 2400 : 900;
    const list: { x: number; y: number; h: number; s: number; cell: number; c: THREE.Color }[] = [];
    const rMin = W.w / 2 + HZ_MARGIN;
    const rMax = HZ_RADIUS * 0.8;
    for (let k = 0; k < budget * 14 && list.length < budget; k++) {
      // denser near the map (uniform in log radius)
      const ang = hash2(k, 1, 940) * Math.PI * 2;
      const rr = rMin * Math.pow(rMax / rMin, hash2(k, 2, 940));
      const x = W.cx + Math.cos(ang) * rr;
      const y = W.cy + Math.sin(ang) * rr;
      const d = W.outside(x, y);
      if (d < HZ_MARGIN + 1) continue;
      const forest = fbm(x * 0.018, y * 0.018, 707, 3);
      const pre = code === 2 ? ss(0.4, 0.55, forest) + 0.6 : code === 3 ? ss(0.52, 0.62, forest) : ss(0.5, 0.6, forest) + 0.4;
      if (hash2(k, 3, 940) > pre) continue;
      const hgt = W.height(x, y);
      const sl = Math.hypot(W.height(x + 3, y) - hgt, W.height(x, y + 3) - hgt) / 3;
      const want = code === 2 ? ss(0.4, 0.55, forest) + ss(0.15, 0.4, sl) * 0.6 : code === 3 ? ss(0.52, 0.62, forest) : ss(0.5, 0.6, forest) + ss(0.22, 0.5, sl) * 0.4;
      if (hash2(k, 3, 940) > want) continue;
      if (hgt < WATER_LEVEL + 0.3 || sl > 1.1 || hgt > (code === 2 ? 55 : 70)) continue;
      if (W.sea && W.seaV(x, y).v > -10) continue;
      if (W.nearPath(x, y, 1)) continue;
      if (towns.some((t) => Math.hypot(t.x - x, t.y - y) < t.r + 2)) continue;
      const pine = code === 2 || (code === 0 && hash2(k, 4, 940) < 0.35 + ss(10, 40, hgt) * 0.5);
      const s = (pine ? 3.2 : 3.0) * (0.75 + hash2(k, 5, 940) * 0.6) * (1 + (d - HZ_MARGIN) / 500);
      const t = 0.85 + hash2(k, 6, 940) * 0.3;
      list.push({ x, y, h: hgt, s, cell: pine ? 0 : 1, c: new THREE.Color(t * (pine ? 0.8 : 0.9), t, t * 0.85) });
    }
    if (!list.length) return;
    const geo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const cells = new Float32Array(list.length);
    const mat = new THREE.MeshStandardMaterial({ map: this.cardTexture(), alphaTest: 0.4, roughness: 0.9, metalness: 0 });
    hzApply(this.fog, mat, 'cards', (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aCell;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv.x = ( vMapUv.x + aCell ) * 0.5;\n#endif')
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3( 0.0, 1.0, 0.0 );\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3( 1.0, 0.0, 0.0 );\n#endif')
        .replace(
          '#include <project_vertex>',
          `vec4 bbW = modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
          float bbSx = length( instanceMatrix[ 0 ].xyz );
          float bbSy = length( instanceMatrix[ 1 ].xyz );
          vec3 bbR = vec3( viewMatrix[ 0 ][ 0 ], 0.0, viewMatrix[ 2 ][ 0 ] );
          bbR = length( bbR ) > 1e-4 ? normalize( bbR ) : vec3( 1.0, 0.0, 0.0 );
          vec3 bbP = bbW.xyz + bbR * transformed.x * bbSx + vec3( 0.0, transformed.y * bbSy, 0.0 );
          vec4 mvPosition = viewMatrix * vec4( bbP, 1.0 );
          gl_Position = projectionMatrix * mvPosition;`,
        );
    });
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    const sc = new THREE.Vector3();
    list.forEach((e, i) => {
      im.setMatrixAt(i, new THREE.Matrix4().compose(v.set(e.x, e.h - 0.1, e.y), q, sc.set(e.s * (e.cell ? 0.95 : 0.6), e.s, 1)));
      im.setColorAt(i, e.c);
      cells[i] = e.cell;
    });
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 1));
    im.computeBoundingSphere();
    im.name = 'horizon-forest';
    this.group.add(im);
  }

  // ------------------------------------------------------------------ Canal City's harbour

  /** Geometry built in a local frame (x along the coast, +z out to sea, y up) placed at coast (u, v). */
  private atCoast(g: THREE.BufferGeometry, u: number, v: number, y: number, extraYaw = 0) {
    const W = this.world;
    const p = W.seaPoint(u, v);
    const p2 = W.seaPoint(u, v + 1);
    const nx = p2.x - p.x;
    const ny = p2.y - p.y;
    g.rotateY(Math.atan2(nx, ny) + extraYaw);
    g.translate(p.x, y, p.y);
    return g;
  }

  private crane(col: THREE.Color): THREE.BufferGeometry {
    const P: THREE.BufferGeometry[] = [];
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const legH = 6;
    for (const x of [-1.7, 1.7]) {
      for (const z of [-1.6, 1.6]) P.push(box(0.32, legH, 0.32, x, legH / 2, z, col));
      P.push(box(0.3, 0.3, 3.5, x, legH, 0, col));
      P.push(box(0.25, 0.25, 3.2, x, 1.2, 0, col));
      P.push(beam(V(x, 1.2, -1.6), V(x, legH, 1.6), 0.16, col));
    }
    P.push(box(3.7, 0.3, 0.3, 0, legH, -1.6, col), box(3.7, 0.3, 0.3, 0, legH, 1.6, col));
    // the boom: back-reach over the yard, out-reach over the ship
    P.push(box(0.5, 0.45, 20, 0, legH + 1.1, 3.5, col));
    P.push(box(1.6, 1.0, 2.2, 0, legH + 0.6, -0.2, C(0xd8d6d0)));
    for (const x of [-0.8, 0.8]) {
      P.push(beam(V(x, legH, 0.6), V(0, legH + 4.2, 0.2), 0.18, col));
      P.push(beam(V(x, legH, -1.4), V(0, legH + 4.2, 0.2), 0.18, col));
    }
    P.push(beam(V(0, legH + 4.2, 0.2), V(0, legH + 1.3, 13.2), 0.08, C(0x303030)));
    P.push(beam(V(0, legH + 4.2, 0.2), V(0, legH + 1.3, -6.2), 0.08, C(0x303030)));
    // trolley and a container on the spreader
    P.push(box(1.1, 0.4, 1.2, 0, legH + 0.75, 8, C(0x404040)), box(1.6, 0.5, 0.55, 0, legH - 1.5, 8, C(CONTAINER_COLS[2])));
    return mergeGeometries(P)!;
  }

  private ship(len: number, beamW: number, kind: 'box' | 'tanker', seed: number): THREE.BufferGeometry {
    const P: THREE.BufferGeometry[] = [];
    const hullCol = C([0x22303e, 0x2b2b2b, 0x3a2420, 0x1f3a32][seed % 4]);
    const hullH = 2.4;
    const yb = WATER_LEVEL - 0.9;
    P.push(box(len, hullH, beamW, 0, yb + hullH / 2, 0, hullCol));
    P.push(box(len + 0.04, 0.4, beamW + 0.04, 0, WATER_LEVEL + 0.1, 0, C(0x8a2a22)));
    // pointed bow, rounded stern
    const bow = new THREE.CylinderGeometry(beamW * 0.5, beamW * 0.5, hullH, 3, 1).scale(1.2, 1, 1).translate(0, 0, 0);
    bow.rotateY(Math.PI / 2);
    P.push(paint(bow.translate(len / 2, yb + hullH / 2, 0), hullCol));
    P.push(cyl(beamW * 0.5, beamW * 0.5, hullH, -len / 2, yb + hullH / 2, 0, hullCol, 10));
    const deck = yb + hullH;
    // bridge house aft
    const hx = -len / 2 + 2.6;
    P.push(box(3.0, 3.4, beamW * 0.86, hx, deck + 1.7, 0, C(0xe8e6e0)));
    P.push(box(3.04, 0.35, beamW * 0.88, hx, deck + 2.9, 0, C(0x30343a)));
    P.push(box(0.9, 0.3, beamW + 0.8, hx + 0.6, deck + 3.5, 0, C(0xe8e6e0)));
    P.push(box(1.1, 1.8, 1.1, hx - 1.0, deck + 4.2, 0, C([0xc23a2a, 0x2b5d8c, 0xe0b030, 0x2a2a2a][seed % 4])));
    if (kind === 'box') {
      for (let x = hx + 2.6; x < len / 2 - 2.2; x += 1.75)
        for (let z = -beamW / 2 + 0.5; z < beamW / 2 - 0.3; z += 0.62) {
          const n = 1 + Math.floor(hash2(Math.round(x * 10), Math.round(z * 10), 950 + seed) * 4);
          for (let k = 0; k < n; k++) P.push(box(1.65, 0.52, 0.58, x, deck + 0.28 + k * 0.54, z, C(CONTAINER_COLS[Math.floor(hash2(Math.round(x * 10) + k, Math.round(z * 10), 951 + seed) * CONTAINER_COLS.length)], 0.9)));
        }
    } else {
      P.push(box(len - 6, 0.06, beamW - 0.2, 1, deck + 0.03, 0, C(0x7a3a2c)));
      P.push(box(len - 8, 0.3, 0.3, 1.5, deck + 0.35, 0, C(0xb0aca0)));
      for (let x = hx + 4; x < len / 2 - 3; x += 5) P.push(box(0.3, 0.9, beamW * 0.7, x, deck + 0.45, 0, C(0xb0aca0)));
    }
    return mergeGeometries(P)!;
  }

  private buildHarbour() {
    const W = this.world;
    const sea = W.sea!;
    const P: THREE.BufferGeometry[] = [];
    const med = this.quality !== 'high';
    const [h0, h1] = sea.harbour;
    // quay deck and wall
    const concrete = C(0x8c8a84);
    for (let u = h0; u < h1; u += 6) {
      P.push(this.atCoast(box(6.1, 2.6, 46, 0, -0.9, -23, concrete), u + 3, 0.4, 0));
      P.push(this.atCoast(box(6.1, 0.12, 0.3, 0, 0.42, -0.2, C(0xd8c040)), u + 3, 0.4, 0));
      for (let k = 0; k < 2; k++) P.push(this.atCoast(box(0.5, 0.6, 0.25, 0, -0.1, 0.15, C(0x202020)), u + 1.5 + k * 3, 0.4, 0));
      if (hash2(Math.round(u), 1, 960) < 0.8) this.addLight(...this.xyz(u + 3, -3, 3.4), [1.0, 0.6, 0.25], 0.55);
    }
    // container cranes on the quay edge
    const craneCols = [C(0x2f5f8f), C(0xa8322a)];
    let ci = 0;
    for (let u = h0 + 12; u < h1 - 8; u += 18, ci++) {
      P.push(this.atCoast(this.crane(craneCols[ci % 2]), u, -2.4, 0.38));
      this.addLight(...this.xyz(u, 11, 7.6), [1.0, 0.18, 0.1], 0.5);
      this.addLight(...this.xyz(u, -2.4, 10.8), [1.0, 0.18, 0.1], 0.5);
      this.addLight(...this.xyz(u, 2, 6.2), [1.0, 0.85, 0.6], 0.8);
    }
    // stacked containers in the yard (rows of blocks with driving lanes between)
    for (let row = 0; row < 9; row++) {
      if (med && row % 3 === 2) continue;
      const v = -7 - row * 0.7 - Math.floor(row / 3) * 3.2;
      for (let u = h0 + 4; u < h1 - 6; u += 1.85) {
        if (Math.floor((u - h0) / 15) % 5 === 4) continue; // cross lanes
        const n = Math.floor(hash2(Math.round(u * 3), row, 961) * 4.6);
        for (let k = 0; k < n; k++) {
          const c = C(CONTAINER_COLS[Math.floor(hash2(Math.round(u * 3) + k * 7, row, 962) * CONTAINER_COLS.length)], 0.85 + hash2(k, row, 963) * 0.2);
          P.push(this.atCoast(box(1.75, 0.54, 0.62, 0, 0.38 + 0.27 + k * 0.56, 0, c), u, v, 0));
        }
      }
    }
    // yard gantries
    for (const u of [h0 + 30, h0 + 66]) {
      const g: THREE.BufferGeometry[] = [];
      const y = C(0xd8b020);
      for (const x of [-1.2, 1.2]) for (const z of [-4.2, 4.2]) g.push(box(0.25, 3.4, 0.25, x, 1.7, z, y));
      g.push(box(0.3, 0.4, 8.8, -1.2, 3.4, 0, y), box(0.3, 0.4, 8.8, 1.2, 3.4, 0, y), box(2.7, 0.5, 1.2, 0, 3.5, 1.5, y));
      P.push(this.atCoast(mergeGeometries(g)!, u, -10.4, 0.38));
    }
    // sheds at the back of the yard
    for (let u = h0 + 8; u < h1 - 10; u += 22) {
      P.push(this.atCoast(box(16, 3.2, 7, 0, 0.38 + 1.6, 0, C(0xa8aaa6)), u + 8, -38, 0));
      P.push(this.atCoast(box(16.2, 0.3, 7.2, 0, 0.38 + 3.3, 0, C(0x5d6a72)), u + 8, -38, 0));
    }
    // moored ships along the quay, and a few at anchor in the roads
    const moored: [number, number, 'box' | 'tanker'][] = [
      [h0 + 22, 28, 'box'],
      [h0 + 56, 24, 'box'],
      [h0 + 90, 26, 'tanker'],
    ];
    moored.forEach(([u, len, kind], i) => {
      P.push(this.atCoast(this.ship(len, 4.4, kind, i), u, 3.1, 0));
      this.addLight(...this.xyz(u + len / 2 - 2.6, 3.1, 4.6), [1, 0.95, 0.85], 0.6);
    });
    const anchored: [number, number, number, number][] = [
      [40, 70, 30, 0.4],
      [-60, 120, 34, 1.9],
      [130, 160, 22, -0.7],
      [-150, 60, 26, 2.6],
    ];
    anchored.forEach(([u, v, len, yaw], i) => {
      if (med && i > 2) return;
      P.push(this.atCoast(this.ship(len, 4.6, i % 2 ? 'tanker' : 'box', i + 3), u, v, 0, yaw));
      this.addLight(...this.xyz(u, v, 5.2), [1, 0.95, 0.85], 0.7);
    });
    // the breakwater and its lighthouse
    const [mu0, mv0, mu1, mv1] = sea.mole;
    const a = W.seaPoint(mu0, mv0);
    const b = W.seaPoint(mu1, mv1);
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const yaw = Math.atan2(-(b.y - a.y), b.x - a.x);
    const rock = C(0x77736c);
    for (let t = 0; t < L; t += 2.2) {
      const x = a.x + ((b.x - a.x) * t) / L;
      const y = a.y + ((b.y - a.y) * t) / L;
      const g = box(2.4, 1.6, 3.2, 0, WATER_LEVEL + 0.25, 0, C(0x77736c, 0.85 + hash2(Math.round(t), 2, 964) * 0.3), hash2(Math.round(t), 3, 964) * 0.5);
      g.rotateY(yaw);
      g.translate(x, 0, y);
      P.push(g);
      const cap = box(2.3, 0.3, 1.5, 0, WATER_LEVEL + 1.1, 0, C(0x9a978e));
      cap.rotateY(yaw);
      cap.translate(x, 0, y);
      P.push(cap);
    }
    const lx = b.x;
    const lz = b.y;
    const base = WATER_LEVEL + 1.2;
    P.push(cyl(2.0, 2.4, 1.2, lx, base - 0.4, lz, rock, 10));
    const white = C(0xeeeae2);
    const red = C(0xb02a22);
    for (let k = 0; k < 4; k++) {
      const r0 = 1.0 - k * 0.09;
      P.push(cyl(r0 - 0.09, r0, 2.2, lx, base + 0.2 + k * 2.2 + 1.1, lz, k % 2 ? red : white, 12));
    }
    const top = base + 0.2 + 8.8;
    P.push(cyl(1.15, 1.15, 0.25, lx, top + 0.12, lz, C(0x303030), 12));
    P.push(cyl(0.55, 0.55, 1.0, lx, top + 0.75, lz, C(0xfff2c0), 10));
    P.push(cyl(0.05, 0.72, 0.7, lx, top + 1.6, lz, red, 10));
    this.lampPos = new THREE.Vector3(lx, top + 0.75, lz);
    this.addLight(lx, top + 0.75, lz, [1.0, 0.92, 0.7], 2.2);
    // beach huts and a promenade on the beach stretch
    for (let u = sea.beach[0] + 20; u < sea.beach[1] - 10; u += 13) {
      if (hash2(Math.round(u), 4, 965) < 0.3) continue;
      P.push(this.atCoast(box(1.2, 1.0, 1.0, 0, 0.5, 0, C([0x3f78b0, 0xe0c040, 0xd85a4a, 0x5aa070][Math.floor(hash2(Math.round(u), 5, 965) * 4)])), u, -9, W.height(...this.xy(u, -9))));
      this.addLight(...this.xyz(u, -11, 1.4 + W.height(...this.xy(u, -11))), [1.0, 0.7, 0.35], 0.45);
    }
    const geo = mergeGeometries(P.map((g) => (g.index ? g.toNonIndexed() : g)))!;
    geo.computeBoundingSphere();
    const mat = hzApply(this.fog, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.05 }), 'harbour');
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'horizon-harbour';
    mesh.castShadow = this.quality === 'high';
    mesh.receiveShadow = this.quality === 'high';
    this.group.add(mesh);
    this.buildBeam();
  }

  private xy(u: number, v: number): [number, number] {
    const p = this.world.seaPoint(u, v);
    return [p.x, p.y];
  }
  private xyz(u: number, v: number, y: number): [number, number, number] {
    const p = this.world.seaPoint(u, v);
    return [p.x, y, p.y];
  }

  /** The lighthouse beam: a long soft cone sweeping round at night. */
  private buildBeam() {
    if (!this.lampPos) return;
    const geo = new THREE.ConeGeometry(5, 80, 16, 1, true).translate(0, -40, 0).rotateZ(Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uOn: { value: 0 } },
      vertexShader: /* glsl */ `
        varying float vT;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          vT = clamp( position.x / 80.0, 0.0, 1.0 );
          vec4 wp = modelMatrix * vec4( position, 1.0 );
          vN = normalize( mat3( modelMatrix ) * normal );
          vV = normalize( cameraPosition - wp.xyz );
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uOn;
        varying float vT;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          float edge = pow( abs( dot( normalize( vN ), vV ) ), 1.5 );
          float a = ( 1.0 - vT ) * ( 1.0 - vT ) * edge * 0.35 * uOn;
          gl_FragColor = vec4( vec3( 1.0, 0.93, 0.75 ) * a, 1.0 );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(this.lampPos);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    mesh.name = 'horizon-beam';
    mesh.visible = false;
    mesh.onBeforeRender = () => {
      mesh.rotation.y = RIVER.time.value * 0.9;
      mesh.rotation.z = -0.03;
      mesh.updateMatrixWorld();
    };
    this.beamMesh = mesh;
    this.group.add(mesh);
  }

  // ------------------------------------------------------------------ distant lights

  private addLight(x: number, y: number, z: number, c: number[], size: number) {
    this.lights.pos.push(x, y, z);
    this.lights.col.push(c[0], c[1], c[2]);
    this.lights.size.push(size);
  }

  private pointsMat: THREE.ShaderMaterial | null = null;
  private points: THREE.Points | null = null;

  private buildLights() {
    const L = this.lights;
    if (!L.size.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(L.pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(L.col, 3));
    geo.setAttribute('aSize', new THREE.Float32BufferAttribute(L.size, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uNight: { value: 0 }, uTime: RIVER.time, uScale: { value: 500 }, uPR: { value: 1 }, ...HORIZON, ...this.fog.uniforms },
      vertexShader: /* glsl */ `
        attribute float aSize;
        uniform float uScale;
        uniform float uPR;
        uniform float uTime;
        uniform float hzDens;
        varying vec3 vCol;
        varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4( position, 1.0 );
          float dist = -mv.z;
          gl_Position = projectionMatrix * mv;
          float px = aSize * uScale / max( dist, 1.0 );
          gl_PointSize = clamp( px, 1.6 * uPR, 9.0 * uPR );
          float seed = fract( sin( dot( position.xz, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
          float tw = 0.8 + 0.2 * sin( uTime * ( 0.7 + seed * 2.5 ) + seed * 40.0 );
          // lights cut through the haze better than the land does
          float hz = exp( -max( dist - 40.0, 0.0 ) * hzDens * 0.55 );
          vCol = color * tw;
          vA = hz * min( 1.0, px / ( 1.6 * uPR ) );
        }`,
      fragmentShader: /* glsl */ `
        uniform float uNight;
        varying vec3 vCol;
        varying float vA;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r2 = dot( d, d ) * 4.0;
          float a = exp( -r2 * 3.5 ) * vA * uNight;
          if ( a < 0.003 ) discard;
          gl_FragColor = vec4( vCol * a * 2.4, 1.0 );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.name = 'horizon-lights';
    pts.frustumCulled = false;
    pts.renderOrder = 4;
    pts.onBeforeRender = (r, _s, cam) => {
      const pc = cam as THREE.PerspectiveCamera;
      const h = r.getDrawingBufferSize(this.tmpV2).y;
      mat.uniforms.uScale.value = pc.isPerspectiveCamera ? h / (2 * Math.tan(THREE.MathUtils.degToRad(pc.fov / 2))) : h / 40;
      mat.uniforms.uPR.value = r.getPixelRatio();
    };
    this.pointsMat = mat;
    this.points = pts;
    this.group.add(pts);
  }
  private tmpV2 = new THREE.Vector2();

  /** Per frame (cheap): night lights on / off. */
  update() {
    const night = CITY_NIGHT.value;
    if (this.pointsMat && this.points) {
      this.pointsMat.uniforms.uNight.value = night;
      this.points.visible = night > 0.02;
    }
    if (this.beamMesh) {
      (this.beamMesh.material as THREE.ShaderMaterial).uniforms.uOn.value = night;
      this.beamMesh.visible = night > 0.05;
    }
  }
}

/** The outskirts' procedural field patchwork, without its control-map uniforms (shared with outskirts.ts). */
export const OSK_FIELDS_GLSL = /* glsl */ `
float oskHash( vec2 c ) { return fract( sin( dot( c, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
vec3 oskFields( vec2 p ) {
#if OSK_BIOME == 1
  {
    vec4 n = texture2D( fogNoise, p * 0.11 );
    float big = texture2D( fogNoise, p * 0.013 + 0.4 ).r;
    float u = dot( p, vec2( 0.29, 0.13 ) ) + big * 9.0;
    float dune = pow( 0.5 + 0.5 * cos( u * 2.1 ), 1.6 );
    vec3 c = mix( vec3( 0.7, 0.55, 0.36 ), vec3( 0.86, 0.7, 0.48 ), dune );
    c = mix( c, vec3( 0.58, 0.5, 0.4 ), smoothstep( 0.62, 0.7, big ) * 0.8 );
    c = mix( c, vec3( 0.62, 0.38, 0.25 ), smoothstep( 0.74, 0.78, texture2D( fogNoise, p * 0.021 + 0.7 ).g ) );
    return c * ( 0.9 + n.g * 0.16 ) * 0.86;
  }
#elif OSK_BIOME == 2
  {
    vec4 n = texture2D( fogNoise, p * 0.11 );
    float drift = texture2D( fogNoise, p * 0.031 + 0.2 ).r;
    vec3 c = vec3( 0.8, 0.84, 0.9 ) * ( 0.9 + drift * 0.12 + n.b * 0.05 );
    const float ca = 0.94604, sa = 0.32404;
    vec2 g = vec2( ( p.x * ca - p.y * sa ) / 13.0, ( p.x * sa + p.y * ca ) / 9.0 );
    vec2 l = fract( g );
    float border = min( min( l.x, 1.0 - l.x ), min( l.y, 1.0 - l.y ) * 1.4 );
    c = mix( c, vec3( 0.4, 0.38, 0.36 ), ( 1.0 - smoothstep( 0.008, 0.02, border ) ) * 0.6 );
    c = mix( c, vec3( 0.42, 0.4, 0.36 ), smoothstep( 0.7, 0.76, drift ) * 0.5 );
    return c * 0.86;
  }
#elif OSK_BIOME == 3
  {
    vec2 g = p / 12.0;
    vec2 l = fract( g );
    vec2 ci = floor( g );
    float st = 1.0 - smoothstep( 0.1, 0.13, min( min( l.x, 1.0 - l.x ), min( l.y, 1.0 - l.y ) ) );
    float r = oskHash( ci );
    vec2 lot = floor( l * vec2( 3.0, 2.0 ) );
    float rl = oskHash( ci * 7.1 + lot );
    vec3 roof = mix( vec3( 0.36, 0.35, 0.34 ), vec3( 0.55, 0.42, 0.36 ), step( 0.6, rl ) ) * ( 0.75 + rl * 0.4 );
    vec3 c = r < 0.15 ? vec3( 0.3, 0.42, 0.22 ) : roof;
    c = mix( c, vec3( 0.2, 0.2, 0.21 ), st );
    return c * ( 0.9 + texture2D( fogNoise, p * 0.11 ).g * 0.15 ) * 0.86;
  }
#endif
  const float ca = 0.94604, sa = 0.32404;
  float u = p.x * ca - p.y * sa;
  float v = p.x * sa + p.y * ca;
  vec2 g = vec2( u / 11.0, v / 8.0 );
  vec2 cell = floor( g );
  vec2 l = g - cell;
  float r = oskHash( cell );
  float border = min( min( l.x, 1.0 - l.x ), min( l.y, 1.0 - l.y ) * 1.4 );
  float meadow = texture2D( fogNoise, p * 0.011 + 0.21 ).r;
  vec4 n = texture2D( fogNoise, p * 0.11 );
  vec3 c;
  if ( meadow > 0.6 || r < 0.28 ) {
    c = vec3( 0.36, 0.46, 0.22 ) * ( 0.82 + n.g * 0.3 );
  } else {
    if ( r < 0.48 ) c = vec3( 0.72, 0.6, 0.32 );
    else if ( r < 0.62 ) c = vec3( 0.5, 0.38, 0.25 );
    else if ( r < 0.8 ) c = vec3( 0.42, 0.52, 0.2 );
    else c = vec3( 0.6, 0.55, 0.3 );
    float rows = 0.9 + 0.1 * sin( ( r >= 0.48 && r < 0.62 ? v : u ) * 5.5 );
    c *= rows * ( 0.88 + n.b * 0.24 );
    float hedge = 1.0 - smoothstep( 0.015, 0.05, border );
    c = mix( c, vec3( 0.16, 0.24, 0.11 ), hedge );
  }
  return c * 0.82;
}
`;
