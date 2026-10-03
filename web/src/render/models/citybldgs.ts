import * as THREE from 'three';
import { StructureKind, Tile, type GameMap, type Structure } from '../../sim/map';
import { hash2 } from '../../sim/rng';
import type { FogOfWar } from '../fog';
import { GeoBuilder, type SceneryLod } from '../geo';
import { surfaceHeight } from '../ground';
import type { HouseHandle } from '../scenery';
import type { Builder } from './registry';
import type { Model, ModelStyle } from './types';

/*
 * City blocks for the urban map: apartment blocks, tenements, office towers,
 * corner shops and townhouses (garrisonable civilian buildings, sim
 * StructureKind.Apartment .. Townhouse), plus the street furniture and ruins.
 *
 * Contract (same as the village houses in scenery.ts): the buildings are
 * static scenery merged per material and per map chunk, and each one hands
 * its vertex ranges to SceneryHandles.houses so envdamage.ts can scorch,
 * cave in and collapse it (following the sim entity's hp). The sim entity
 * itself renders only CITY_MODELS: the owner's flag on the roof and the
 * entrance lamps (Model.nightLights).
 *
 * Facades are boxes UV-mapped in bays x floors onto tiling facade textures
 * (concrete panels, brick, glass curtain wall, shop fronts) painted on a
 * canvas at load. Their window panes carry an emissive mask: after dark
 * (CITY_NIGHT, set by atmos.ts) a hashed ~40% of the windows light up, warm
 * or cool, and go out as the building is damaged (vertex colours darken).
 * Balconies, awnings, signs and roof clutter live in a separate detail mesh
 * hidden at far zoom (SceneryLod). Draw calls: ~7 materials x 4 chunks,
 * only the chunks on screen are drawn.
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const C = (h: number) => new THREE.Color(h);

/** 0 = day .. 1 = night: window lights (set per frame by the atmosphere). */
export const CITY_NIGHT = { value: 0 };

const CITY_KINDS = new Set<StructureKind>([StructureKind.Apartment, StructureKind.Block, StructureKind.Office, StructureKind.Shop, StructureKind.Townhouse]);
export function isCityKind(k: StructureKind) {
  return CITY_KINDS.has(k);
}

type Facade = 'panel' | 'brick' | 'glass' | 'shop';
interface Spec {
  /** Ground floor height and style; upper floors count, height and style. */
  groundH: number;
  ground: Facade;
  floors: number;
  floorH: number;
  upper: Facade;
  bay: number;
  inset: number;
  roof: 'flat' | 'mansard';
}

const SPECS: Partial<Record<StructureKind, Spec>> = {
  [StructureKind.Apartment]: { groundH: 0.36, ground: 'panel', floors: 5, floorH: 0.3, upper: 'panel', bay: 0.34, inset: 0.09, roof: 'flat' },
  [StructureKind.Block]: { groundH: 0.36, ground: 'shop', floors: 4, floorH: 0.3, upper: 'brick', bay: 0.3, inset: 0.08, roof: 'flat' },
  [StructureKind.Office]: { groundH: 0.4, ground: 'shop', floors: 8, floorH: 0.28, upper: 'glass', bay: 0.32, inset: 0.15, roof: 'flat' },
  [StructureKind.Shop]: { groundH: 0.36, ground: 'shop', floors: 1, floorH: 0.3, upper: 'panel', bay: 0.3, inset: 0.08, roof: 'flat' },
  [StructureKind.Townhouse]: { groundH: 0.34, ground: 'brick', floors: 2, floorH: 0.3, upper: 'brick', bay: 0.3, inset: 0.1, roof: 'mansard' },
};

/** Top of a city building's walls (the roof flag and health bar sit on it). */
export function cityHeight(kind: StructureKind): number {
  const s = SPECS[kind];
  if (!s) return 1;
  return s.groundH + s.floors * s.floorH + (s.roof === 'mansard' ? 0.3 : 0.06);
}

// ------------------------------------------------------------- textures

function canvas(n: number) {
  const c = document.createElement('canvas');
  c.width = c.height = n;
  return { c, g: c.getContext('2d')! };
}

function rnd(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One bay x one floor facade cell (colour + emissive window mask). */
function facadeTextures(style: Facade, N: number): { map: THREE.Texture; glow: THREE.Texture } {
  const { c, g } = canvas(N);
  const { c: ce, g: ge } = canvas(N);
  const r = rnd(style.length * 977 + N);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, N, N);
  const grain = (a: number) => {
    for (let i = 0; i < N * 6; i++) {
      g.fillStyle = `rgba(${r() < 0.5 ? '0,0,0' : '255,255,255'},${(r() * a).toFixed(3)})`;
      g.fillRect(r() * N, r() * N, 1 + r() * 2, 1 + r() * 2);
    }
  };
  // y measured from the top of the canvas (v = 1 at the top: the floor's ceiling)
  const glass = (x0: number, y0: number, x1: number, y1: number, tint: [number, number, number]) => {
    const grd = g.createLinearGradient(0, y0 * N, 0, y1 * N);
    grd.addColorStop(0, `rgb(${tint[0] + 40},${tint[1] + 46},${tint[2] + 52})`);
    grd.addColorStop(0.55, `rgb(${tint[0]},${tint[1]},${tint[2]})`);
    grd.addColorStop(1, `rgb(${tint[0] - 10},${tint[1] - 8},${tint[2] - 4})`);
    g.fillStyle = grd;
    g.fillRect(x0 * N, y0 * N, (x1 - x0) * N, (y1 - y0) * N);
    // a diagonal sky glint
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.beginPath();
    g.moveTo(x0 * N, y1 * N);
    g.lineTo((x0 + (x1 - x0) * 0.45) * N, y0 * N);
    g.lineTo((x0 + (x1 - x0) * 0.7) * N, y0 * N);
    g.lineTo((x0 + (x1 - x0) * 0.25) * N, y1 * N);
    g.fill();
    // lit interior: a warm pane with a curtain / blind edge
    const lg = ge.createLinearGradient(x0 * N, 0, x1 * N, 0);
    lg.addColorStop(0, '#9a9a9a');
    lg.addColorStop(0.3, '#fff');
    lg.addColorStop(0.8, '#e8e8e8');
    lg.addColorStop(1, '#888');
    ge.fillStyle = lg;
    ge.fillRect(x0 * N, y0 * N, (x1 - x0) * N, (y1 - y0) * N);
  };
  const frame = (x0: number, y0: number, x1: number, y1: number, col: string, w: number) => {
    g.strokeStyle = col;
    g.lineWidth = w * N;
    g.strokeRect(x0 * N, y0 * N, (x1 - x0) * N, (y1 - y0) * N);
    ge.strokeStyle = '#000';
    ge.lineWidth = w * N;
    ge.strokeRect(x0 * N, y0 * N, (x1 - x0) * N, (y1 - y0) * N);
  };
  if (style === 'panel') {
    g.fillStyle = '#cfcac0';
    g.fillRect(0, 0, N, N);
    grain(0.05);
    // precast panel joints: the floor line and the bay edge
    g.fillStyle = 'rgba(40,36,30,0.45)';
    g.fillRect(0, N - N * 0.03, N, N * 0.03);
    g.fillRect(0, 0, N * 0.02, N);
    // a rain streak under the window
    g.fillStyle = 'rgba(60,55,48,0.12)';
    g.fillRect(N * 0.3, N * 0.78, N * 0.4, N * 0.2);
    glass(0.2, 0.22, 0.8, 0.74, [52, 62, 72]);
    frame(0.2, 0.22, 0.8, 0.74, '#e8e6e0', 0.035);
    g.fillStyle = '#e8e6e0';
    g.fillRect(N * 0.49, N * 0.22, N * 0.025, N * 0.52);
    ge.fillStyle = '#000';
    ge.fillRect(N * 0.49, N * 0.22, N * 0.025, N * 0.52);
    g.fillStyle = '#b0aaa0';
    g.fillRect(N * 0.17, N * 0.74, N * 0.66, N * 0.04);
  } else if (style === 'brick') {
    g.fillStyle = '#8a8076';
    g.fillRect(0, 0, N, N);
    const rows = 10;
    for (let y = 0; y < rows; y++) {
      const off = (y % 2) * 0.5;
      for (let x = -1; x < 4; x++) {
        const t = r();
        const rr = 150 + t * 40;
        g.fillStyle = `rgb(${rr | 0},${(rr * 0.52) | 0},${(rr * 0.4) | 0})`;
        g.fillRect(((x + off) / 3.5) * N + 1, (y / rows) * N + 1, N / 3.5 - 2, N / rows - 2);
      }
    }
    grain(0.06);
    glass(0.28, 0.2, 0.72, 0.78, [48, 56, 64]);
    frame(0.28, 0.2, 0.72, 0.78, '#ecebe4', 0.04);
    g.fillStyle = '#ecebe4';
    g.fillRect(N * 0.49, N * 0.2, N * 0.025, N * 0.58);
    g.fillRect(N * 0.28, N * 0.47, N * 0.44, N * 0.02);
    ge.fillStyle = '#000';
    ge.fillRect(N * 0.49, N * 0.2, N * 0.025, N * 0.58);
    // stone lintel and sill
    g.fillStyle = '#d8d0c0';
    g.fillRect(N * 0.25, N * 0.13, N * 0.5, N * 0.06);
    g.fillRect(N * 0.25, N * 0.79, N * 0.5, N * 0.04);
  } else if (style === 'glass') {
    glass(0, 0, 1, 0.8, [78, 104, 124]);
    // spandrel band at the floor slab, mullions at the bay edges
    g.fillStyle = '#3a4048';
    g.fillRect(0, N * 0.8, N, N * 0.2);
    ge.fillStyle = '#000';
    ge.fillRect(0, N * 0.8, N, N * 0.2);
    g.fillStyle = '#9aa2aa';
    g.fillRect(0, 0, N * 0.04, N);
    g.fillRect(N * 0.96, 0, N * 0.04, N);
    g.fillRect(0, N * 0.78, N, N * 0.025);
    ge.fillRect(0, 0, N * 0.04, N);
    ge.fillRect(N * 0.96, 0, N * 0.04, N);
  } else {
    // shop front: stone base and pillars, a big display window, a sign band
    g.fillStyle = '#9a948a';
    g.fillRect(0, 0, N, N);
    grain(0.05);
    g.fillStyle = '#3e3c3a';
    g.fillRect(0, N * 0.06, N, N * 0.16);
    g.fillStyle = '#d6d2c8';
    g.fillRect(0, N * 0.09, N, N * 0.1);
    glass(0.08, 0.3, 0.92, 0.92, [44, 50, 54]);
    frame(0.08, 0.3, 0.92, 0.92, '#2c2c2e', 0.04);
    g.fillStyle = '#2c2c2e';
    g.fillRect(N * 0.08, N * 0.9, N * 0.84, N * 0.1);
  }
  const mk = (cv: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(cv);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  };
  return { map: mk(c, true), glow: mk(ce, false) };
}

/** Concrete / roof grain (tinted by vertex colours). */
function plainTexture(N: number, seed: number, tiles = false): THREE.Texture {
  const { c, g } = canvas(N);
  const r = rnd(seed);
  g.fillStyle = '#d0d0d0';
  g.fillRect(0, 0, N, N);
  for (let i = 0; i < N * 8; i++) {
    const v = (r() * 80 + 150) | 0;
    g.fillStyle = `rgba(${v},${v},${v},0.35)`;
    g.fillRect(r() * N, r() * N, 1 + r() * 2, 1 + r() * 2);
  }
  if (tiles) {
    // slate rows for the mansard roofs
    for (let y = 0; y < 8; y++) {
      g.fillStyle = 'rgba(30,30,34,0.45)';
      g.fillRect(0, (y / 8) * N, N, 2);
      for (let x = 0; x < 6; x++) {
        g.fillStyle = 'rgba(30,30,34,0.3)';
        g.fillRect(((x + (y % 2) * 0.5) / 6) * N, (y / 8) * N, 1, N / 8);
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// ------------------------------------------------------------ materials

const NIGHT_GLSL = /* glsl */ `
#include <emissivemap_fragment>
{
  // hashed lit windows: one decision per bay / floor (the UVs count bays and floors; each building's u is offset)
  vec2 cell = floor( vMapUv + 0.0001 );
  float hs = fract( sin( dot( cell, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
  float lit = step( hs, 0.42 ) * cityNight;
  vec3 warm = mix( vec3( 1.0, 0.7, 0.4 ), vec3( 0.72, 0.84, 1.0 ), step( 0.8, fract( hs * 7.31 ) ) );
  // a damaged / burnt building goes dark (envdamage darkens the vertex colours)
  float intact = clamp( ( dot( vColor.rgb, vec3( 0.333 ) ) - 0.3 ) * 2.0, 0.0, 1.0 );
  totalEmissiveRadiance *= warm * lit * intact * 1.6;
}
`;

interface CityMats {
  facade: Record<Facade, THREE.MeshStandardMaterial>;
  trim: THREE.MeshStandardMaterial;
  slate: THREE.MeshStandardMaterial;
  detail: THREE.MeshStandardMaterial;
}

function cityMaterials(fog: FogOfWar, quality: 'low' | 'medium' | 'high'): CityMats {
  const N = quality === 'low' ? 64 : 128;
  const facade = {} as Record<Facade, THREE.MeshStandardMaterial>;
  for (const st of ['panel', 'brick', 'glass', 'shop'] as Facade[]) {
    const t = facadeTextures(st, N);
    const glassy = st === 'glass';
    const m = new THREE.MeshStandardMaterial({
      map: t.map,
      emissiveMap: t.glow,
      emissive: 0xffffff,
      emissiveIntensity: 1,
      vertexColors: true,
      roughness: glassy ? 0.25 : 0.85,
      metalness: glassy ? 0.55 : 0.04,
    });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.cityNight = CITY_NIGHT;
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float cityNight;').replace('#include <emissivemap_fragment>', NIGHT_GLSL);
    };
    fog.apply(m);
    m.customProgramCacheKey = () => 'fog2-cityfacade';
    facade[st] = m;
  }
  const trim = fog.apply(new THREE.MeshStandardMaterial({ map: plainTexture(64, 11), vertexColors: true, roughness: 0.9, metalness: 0.02 }));
  const slate = fog.apply(new THREE.MeshStandardMaterial({ map: plainTexture(64, 13, true), vertexColors: true, roughness: 0.7, metalness: 0.1 }));
  const detail = fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.25 }));
  return { facade, trim, slate, detail };
}

// ------------------------------------------------------------ geometry

/** Builders of one map chunk. */
interface Chunk {
  facade: Record<Facade, GeoBuilder>;
  trim: GeoBuilder;
  slate: GeoBuilder;
  detail: GeoBuilder;
}
const newChunk = (): Chunk => ({ facade: { panel: new GeoBuilder(), brick: new GeoBuilder(), glass: new GeoBuilder(), shop: new GeoBuilder() }, trim: new GeoBuilder(), slate: new GeoBuilder(), detail: new GeoBuilder() });
const chunkBuilders = (c: Chunk) => [c.facade.panel, c.facade.brick, c.facade.glass, c.facade.shop, c.trim, c.slate, c.detail];

/** Placement of one building: local (front = +z) to world. */
class Place {
  readonly m = new THREE.Matrix4();
  readonly r = new THREE.Matrix4();
  constructor(x: number, y: number, z: number, rot: number) {
    this.r.makeRotationY((rot * Math.PI) / 2);
    this.m.copy(this.r).setPosition(x, y, z);
  }
  p(x: number, y: number, z: number) {
    return V(x, y, z).applyMatrix4(this.m);
  }
  n(x: number, y: number, z: number) {
    return V(x, y, z).applyMatrix4(this.r).normalize();
  }
}

/** Axis-aligned box (local), 5 or 6 faces, UVs scaled by world size. */
function box(b: GeoBuilder, P: Place, cx: number, y0: number, cz: number, w: number, h: number, d: number, col: THREE.Color, uvK = 1, bottom = false) {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;
  const y1 = y0 + h;
  const quad = (a: number[], bb: number[], c: number[], dd: number[], n: number[], uw: number, vh: number) => {
    const N = P.n(n[0], n[1], n[2]);
    const ia = b.vert(P.p(a[0], a[1], a[2]), N, 0, vh * uvK, col);
    const ib = b.vert(P.p(bb[0], bb[1], bb[2]), N, uw * uvK, vh * uvK, col);
    const ic = b.vert(P.p(c[0], c[1], c[2]), N, 0, 0, col);
    const id = b.vert(P.p(dd[0], dd[1], dd[2]), N, uw * uvK, 0, col);
    b.quad(ia, ib, ic, id);
  };
  quad([x0, y1, z1], [x1, y1, z1], [x0, y0, z1], [x1, y0, z1], [0, 0, 1], w, h);
  quad([x1, y1, z1], [x1, y1, z0], [x1, y0, z1], [x1, y0, z0], [1, 0, 0], d, h);
  quad([x1, y1, z0], [x0, y1, z0], [x1, y0, z0], [x0, y0, z0], [0, 0, -1], w, h);
  quad([x0, y1, z0], [x0, y1, z1], [x0, y0, z0], [x0, y0, z1], [-1, 0, 0], d, h);
  quad([x0, y1, z0], [x1, y1, z0], [x0, y1, z1], [x1, y1, z1], [0, 1, 0], w, d);
  if (bottom) quad([x0, y0, z1], [x1, y0, z1], [x0, y0, z0], [x1, y0, z0], [0, -1, 0], w, d);
}

/**
 * Facade band: the four walls of a box from y0, `floors` floors of `fh` each, UVs in whole bays
 * (`bay` wide) x floors, offset by `uOff` bays (per building: the lit-window hash differs).
 */
function facade(b: GeoBuilder, P: Place, w: number, d: number, y0: number, floors: number, fh: number, bay: number, uOff: number, col: THREE.Color, sides = [true, true, true, true]) {
  const y1 = y0 + floors * fh;
  const faces = [
    { bl: [-w / 2, d / 2], r: [1, 0], n: [0, 0, 1], len: w },
    { bl: [w / 2, d / 2], r: [0, -1], n: [1, 0, 0], len: d },
    { bl: [w / 2, -d / 2], r: [-1, 0], n: [0, 0, -1], len: w },
    { bl: [-w / 2, -d / 2], r: [0, 1], n: [-1, 0, 0], len: d },
  ];
  faces.forEach((f, k) => {
    if (!sides[k]) return;
    const nb = Math.max(1, Math.round(f.len / bay));
    const N = P.n(f.n[0], f.n[1], f.n[2]);
    const ex = f.bl[0] + f.r[0] * f.len;
    const ez = f.bl[1] + f.r[1] * f.len;
    const u0 = uOff + k * 7;
    const ia = b.vert(P.p(f.bl[0], y1, f.bl[1]), N, u0, floors, col);
    const ib = b.vert(P.p(ex, y1, ez), N, u0 + nb, floors, col);
    const ic = b.vert(P.p(f.bl[0], y0, f.bl[1]), N, u0, 0, col);
    const id = b.vert(P.p(ex, y0, ez), N, u0 + nb, 0, col);
    b.quad(ia, ib, ic, id);
  });
}

/** Flat roof: slab, parapet ring and a cornice line. */
function flatRoof(c: Chunk, P: Place, w: number, d: number, top: number, roofC: THREE.Color, edgeC: THREE.Color) {
  box(c.trim, P, 0, top - 0.02, 0, w - 0.04, 0.03, d - 0.04, roofC, 1.4);
  const t = 0.045;
  const ph = 0.07;
  box(c.trim, P, 0, top, d / 2 - t / 2, w, ph, t, edgeC, 2);
  box(c.trim, P, 0, top, -d / 2 + t / 2, w, ph, t, edgeC, 2);
  box(c.trim, P, w / 2 - t / 2, top, 0, t, ph, d - 2 * t, edgeC, 2);
  box(c.trim, P, -w / 2 + t / 2, top, 0, t, ph, d - 2 * t, edgeC, 2);
}

function roofClutter(c: Chunk, P: Place, w: number, d: number, top: number, h: (k: number) => number, big: boolean) {
  const grey = C(0x8a8a86);
  // stair / lift head
  box(c.trim, P, (h(30) - 0.5) * w * 0.4, top, (h(31) - 0.5) * d * 0.3, 0.32, 0.18, 0.26, C(0xb4b0a8), 2);
  // AC units and a water tank
  const n = big ? 4 : 2;
  for (let i = 0; i < n; i++) box(c.detail, P, (h(40 + i) - 0.5) * w * 0.7, top, (h(50 + i) - 0.5) * d * 0.7, 0.1, 0.06, 0.12, grey);
  if (h(32) < 0.6) {
    c.detail.add(new THREE.CylinderGeometry(0.07, 0.07, 0.16, 10), P.m.clone().multiply(new THREE.Matrix4().makeTranslation((h(33) - 0.5) * w * 0.5, top + 0.08, (h(34) - 0.5) * d * 0.5)), null, C(0x6a6c70));
  }
  // antenna mast
  if (h(35) < 0.7) box(c.detail, P, (h(36) - 0.5) * w * 0.6, top, (h(37) - 0.5) * d * 0.6, 0.015, 0.4 + h(38) * 0.3, 0.015, C(0x505458));
}

const APT_TINTS = [0xffffff, 0xf3e8d4, 0xe2eaf0, 0xf2dcd0, 0xe8ecd8];
const BRICK_TINTS = [0xffffff, 0xe8d0c0, 0xd8c8b8, 0xf0e0d0];
const PLASTER_TINTS = [0xf4e6c8, 0xe6d0a8, 0xd8e0e4, 0xf0d4c4, 0xe4e8d0];
const AWNINGS = [0xb83a2a, 0x2a6aa8, 0x2f8a5a, 0xd8a030, 0x6a3a8a, 0x404448];

/** One city building into the chunk builders. */
function buildOne(m: GameMap, st: Structure, c: Chunk, uOff: number) {
  const spec = SPECS[st.kind]!;
  const cx = st.x + st.w / 2;
  const cz = st.y + st.h / 2;
  let gy = 99;
  for (const [x, zz] of [
    [st.x, st.y],
    [st.x + st.w, st.y],
    [st.x, st.y + st.h],
    [st.x + st.w, st.y + st.h],
    [cx, cz],
  ])
    gy = Math.min(gy, surfaceHeight(m, x, zz));
  const P = new Place(cx, gy - 0.06, cz, st.rot);
  const odd = st.rot % 2 === 1;
  const W = (odd ? st.h : st.w) - spec.inset * 2;
  const D = (odd ? st.w : st.h) - spec.inset * 2;
  const h = (k: number) => hash2(st.x * 7 + k, st.y * 13, 1931);
  const v = st.variant ?? h(0);
  const base = 0.06; // sunk below the ground
  const gH = spec.groundH + base;
  const groundTint = C(0xffffff);
  let upperTint: THREE.Color;
  let top: number;
  switch (st.kind) {
    case StructureKind.Apartment: {
      upperTint = C(APT_TINTS[Math.floor(v * APT_TINTS.length)]);
      facade(c.facade.panel, P, W, D, 0, 1, gH, spec.bay, uOff, upperTint.clone().multiplyScalar(0.92));
      facade(c.facade.panel, P, W, D, gH, spec.floors, spec.floorH, spec.bay, uOff + 3, upperTint);
      top = gH + spec.floors * spec.floorH;
      flatRoof(c, P, W + 0.04, D + 0.04, top, C(0x5c5a56), upperTint.clone().multiplyScalar(0.86));
      // balconies on the front and back, every other bay
      const nb = Math.max(1, Math.round(W / spec.bay));
      const bw = W / nb;
      const balC = upperTint.clone().multiplyScalar(0.8);
      for (let f = 0; f < spec.floors; f++)
        for (let i = (f + Math.floor(v * 2)) % 2; i < nb; i += 2)
          for (const sz of [1, -1]) box(c.detail, P, -W / 2 + bw * (i + 0.5), gH + f * spec.floorH + 0.01, sz * (D / 2 + 0.05), bw * 0.82, 0.1, 0.1, balC);
      // entrance canopy
      box(c.detail, P, 0, spec.groundH * 0.85, D / 2 + 0.09, 0.42, 0.03, 0.18, C(0x6a6c70));
      roofClutter(c, P, W, D, top, h, true);
      break;
    }
    case StructureKind.Block: {
      upperTint = C(BRICK_TINTS[Math.floor(v * BRICK_TINTS.length)]);
      facade(c.facade.shop, P, W, D, 0, 1, gH, spec.bay * 2, uOff, groundTint, [true, false, true, false]);
      facade(c.facade.brick, P, W, D, 0, 1, gH, spec.bay, uOff, upperTint.clone().multiplyScalar(0.85), [false, true, false, true]);
      facade(c.facade.brick, P, W, D, gH, spec.floors, spec.floorH, spec.bay, uOff + 5, upperTint);
      top = gH + spec.floors * spec.floorH;
      flatRoof(c, P, W + 0.06, D + 0.06, top, C(0x55524e), C(0xd2c8b8));
      // cornice and a string course over the shops
      box(c.trim, P, 0, top - 0.04, 0, W + 0.1, 0.04, D + 0.1, C(0xd8d0c0), 2);
      box(c.trim, P, 0, gH - 0.02, 0, W + 0.04, 0.03, D + 0.04, C(0xd8d0c0), 2);
      // shop awnings
      const aw = C(AWNINGS[Math.floor(h(3) * AWNINGS.length)]);
      for (const sz of [1, -1]) {
        const am = P.m.clone().multiply(new THREE.Matrix4().makeTranslation(0, spec.groundH * 0.9, sz * (D / 2 + 0.09))).multiply(new THREE.Matrix4().makeRotationX(sz * 0.35));
        c.detail.add(new THREE.BoxGeometry(W * 0.85, 0.015, 0.18), am, null, aw);
      }
      roofClutter(c, P, W, D, top, h, false);
      break;
    }
    case StructureKind.Office: {
      upperTint = C([0xffffff, 0xd8e8f0, 0xe8e4d8, 0xc8d8d0][Math.floor(v * 4)]);
      // podium and tower
      facade(c.facade.shop, P, W + 0.16, D + 0.16, 0, 1, gH, spec.bay * 2, uOff, groundTint);
      box(c.trim, P, 0, gH - 0.01, 0, W + 0.22, 0.04, D + 0.22, C(0xb8bcc0), 2);
      facade(c.facade.glass, P, W, D, gH, spec.floors, spec.floorH, spec.bay, uOff + 2, upperTint);
      top = gH + spec.floors * spec.floorH;
      flatRoof(c, P, W + 0.02, D + 0.02, top, C(0x6a6e72), C(0x9aa0a6));
      // corner fins
      for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) box(c.trim, P, (sx * W) / 2, gH, (sz * D) / 2, 0.05, top - gH + 0.05, 0.05, C(0xa8aeb4), 3);
      // rooftop plant and a mast
      box(c.trim, P, 0, top, 0, W * 0.5, 0.16, D * 0.45, C(0x9a9ea2), 2);
      box(c.detail, P, W * 0.15, top + 0.16, 0, 0.02, 0.6, 0.02, C(0xc8ccd0));
      roofClutter(c, P, W * 0.9, D * 0.9, top, h, true);
      break;
    }
    case StructureKind.Shop: {
      upperTint = C(PLASTER_TINTS[Math.floor(v * PLASTER_TINTS.length)]);
      facade(c.facade.shop, P, W, D, 0, 1, gH, spec.bay * 2, uOff, groundTint, [true, true, false, false]);
      facade(c.facade.panel, P, W, D, 0, 1, gH, spec.bay, uOff, upperTint.clone().multiplyScalar(0.85), [false, false, true, true]);
      facade(c.facade.panel, P, W, D, gH, spec.floors, spec.floorH, spec.bay, uOff + 3, upperTint);
      top = gH + spec.floors * spec.floorH;
      flatRoof(c, P, W + 0.04, D + 0.04, top, C(0x5c5a56), upperTint.clone().multiplyScalar(0.8));
      // awnings on the two shop fronts and a sign
      const aw = C(AWNINGS[Math.floor(h(4) * AWNINGS.length)]);
      const am1 = P.m.clone().multiply(new THREE.Matrix4().makeTranslation(0, spec.groundH * 0.9, D / 2 + 0.09)).multiply(new THREE.Matrix4().makeRotationX(0.35));
      c.detail.add(new THREE.BoxGeometry(W * 0.9, 0.015, 0.18), am1, null, aw);
      const am2 = P.m.clone().multiply(new THREE.Matrix4().makeTranslation(W / 2 + 0.09, spec.groundH * 0.9, 0)).multiply(new THREE.Matrix4().makeRotationZ(-0.35));
      c.detail.add(new THREE.BoxGeometry(0.18, 0.015, D * 0.9), am2, null, aw);
      box(c.detail, P, -W * 0.15, gH + 0.04, D / 2 + 0.02, W * 0.45, 0.09, 0.03, C([0xe8e0c8, 0xd84030, 0x2a5a9a, 0xf0c040][Math.floor(h(5) * 4)]));
      roofClutter(c, P, W, D, top, h, false);
      break;
    }
    default: {
      // townhouse: pastel plaster or brick, slate mansard roof, chimneys
      const brick = v < 0.5;
      upperTint = C(brick ? BRICK_TINTS[Math.floor(h(6) * BRICK_TINTS.length)] : PLASTER_TINTS[Math.floor(h(6) * PLASTER_TINTS.length)]);
      const fb = brick ? c.facade.brick : c.facade.panel;
      facade(fb, P, W, D, 0, 1, gH, spec.bay, uOff, upperTint.clone().multiplyScalar(0.9));
      facade(fb, P, W, D, gH, spec.floors, spec.floorH, spec.bay, uOff + 4, upperTint);
      top = gH + spec.floors * spec.floorH;
      box(c.trim, P, 0, top - 0.03, 0, W + 0.08, 0.04, D + 0.08, C(0xe0dace), 2);
      // mansard: four steep slopes to a small flat top
      const rh = 0.3;
      const k = 0.16;
      const slate = C([0x4a4c52, 0x5a4a44, 0x3e4a4e][Math.floor(h(7) * 3)]);
      const corners = (y: number, e: number) => [V(-W / 2 + e, y, D / 2 - e), V(W / 2 - e, y, D / 2 - e), V(W / 2 - e, y, -D / 2 + e), V(-W / 2 + e, y, -D / 2 + e)];
      const lo = corners(top + 0.01, -0.02);
      const hi = corners(top + rh, k);
      for (let s = 0; s < 4; s++) {
        const a = hi[s];
        const b = hi[(s + 1) % 4];
        const cc = lo[s];
        const d = lo[(s + 1) % 4];
        const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(cc, a)).normalize().negate();
        const N = P.n(n.x, n.y, n.z);
        const len = a.distanceTo(b) * 3;
        const ia = c.slate.vert(P.p(a.x, a.y, a.z), N, 0, 1.4, slate);
        const ib = c.slate.vert(P.p(b.x, b.y, b.z), N, len, 1.4, slate);
        const ic = c.slate.vert(P.p(cc.x, cc.y, cc.z), N, 0, 0, slate);
        const id = c.slate.vert(P.p(d.x, d.y, d.z), N, len, 0, slate);
        c.slate.quad(ia, ib, ic, id);
      }
      box(c.slate, P, 0, top + rh - 0.01, 0, W - 2 * k, 0.02, D - 2 * k, slate.clone().multiplyScalar(0.8), 2);
      // dormers on the front slope
      for (const sx of [-0.3, 0.3]) box(c.slate, P, sx * W, top + 0.05, D / 2 - 0.12, 0.16, 0.16, 0.12, upperTint.clone().multiplyScalar(0.9), 2);
      for (const sx of [-1, 1]) box(c.trim, P, sx * (W / 2 - 0.12), top + rh - 0.05, 0, 0.1, 0.22, 0.14, C(0x9a6a58), 2);
      // door and steps
      box(c.detail, P, 0, 0.04, D / 2 + 0.005, 0.14, 0.26, 0.02, C([0x2a3a5a, 0x5a2a2a, 0x2a4a3a, 0x222222][Math.floor(h(8) * 4)]));
      box(c.trim, P, 0, 0.0, D / 2 + 0.06, 0.24, 0.07, 0.12, C(0xc8c0b0), 2);
      top += rh;
      break;
    }
  }
  void top;
}

/** A tiny tilted wall stub of a ruin (brick look). */
function ruinWall(c: Chunk, P: Place, len: number, hgt: number, seed: number) {
  const b = c.facade.brick;
  const n = 4;
  const col = C(0xc8b8a8).multiplyScalar(0.7);
  // jagged top: a strip of n segments with random heights
  for (let i = 0; i < n; i++) {
    const x0 = -len / 2 + (len * i) / n;
    const hh = hgt * (0.35 + hash2(seed, i, 71) * 0.65);
    box(b, P, x0 + len / n / 2, 0, 0, len / n, hh, 0.06, col, 3.3);
  }
}

/**
 * Build the city: buildings (merged per material and chunk, with damage handles), street lamps,
 * fountains on the squares and ruins on the rubble lots.
 */
export function buildCity(m: GameMap, fog: FogOfWar, quality: 'low' | 'medium' | 'high', sink?: { houses: HouseHandle[] }, lod?: SceneryLod): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const city = m.structures.filter((st) => isCityKind(st.kind));
  const deco = m.deco;
  if (!city.length && !deco?.lots.length) return out;
  const mats = cityMaterials(fog, quality);
  const CH = 48;
  const chunks = new Map<string, Chunk>();
  const chunkOf = (x: number, y: number) => {
    const key = `${Math.floor(x / CH)},${Math.floor(y / CH)}`;
    let c = chunks.get(key);
    if (!c) chunks.set(key, (c = newChunk()));
    return c;
  };
  const spans: { st: Structure; c: Chunk; from: number[]; to: number[] }[] = [];
  city.forEach((st, i) => {
    const c = chunkOf(st.x + st.w / 2, st.y + st.h / 2);
    const bs = chunkBuilders(c);
    const from = bs.map((b) => b.count);
    buildOne(m, st, c, i * 17);
    spans.push({ st, c, from, to: bs.map((b) => b.count) });
  });

  // ruins on the rubble lots: wall stubs and a burnt-out corner, kept off ore, oil and tech sites
  const avoid = (x: number, y: number) => {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return true;
    const i = ty * m.w + tx;
    if (m.ore[i] || m.oreKind[i] || m.blocked[i] || m.trees[i] || m.tiles[i] === Tile.Water || m.tiles[i] === Tile.Bridge) return true;
    for (const mm of m.oreMines) if (Math.hypot(x - mm.x - 0.5, y - mm.y - 0.5) < 5) return true;
    for (const o of m.oils) if (x > o.x - 1.5 && x < o.x + 3.5 && y > o.y - 1.5 && y < o.y + 3.5) return true;
    for (const t of m.techSites ?? [])
      for (const [ax, ay] of t.at)
        for (const [px, py] of [
          [ax, ay],
          [m.w - ax - 3, m.h - ay - 3],
        ])
          if (x > px - 1 && x < px + 4 && y > py - 1 && y < py + 4) return true;
    return false;
  };
  (deco?.lots ?? []).forEach((r, li) => {
    for (let k = 0; k < 4; k++) {
      const x = r.x0 + 0.8 + hash2(li, k, 81) * (r.x1 - r.x0 - 1.6);
      const y = r.y0 + 0.8 + hash2(li, k, 82) * (r.y1 - r.y0 - 1.6);
      if (avoid(x, y) || avoid(x + 0.6, y) || avoid(x - 0.6, y)) continue;
      const c = chunkOf(x, y);
      const P = new Place(x, surfaceHeight(m, x, y) - 0.03, y, Math.floor(hash2(li, k, 83) * 4));
      ruinWall(c, P, 0.9 + hash2(li, k, 84) * 0.6, 0.25 + hash2(li, k, 85) * 0.35, li * 31 + k);
    }
  });

  // meshes per chunk and material
  const built = new Map<GeoBuilder, THREE.Mesh>();
  const shadows = quality !== 'low';
  const detailMeshes: THREE.Mesh[] = [];
  for (const c of chunks.values()) {
    const pairs: [GeoBuilder, THREE.Material, boolean, string][] = [
      [c.facade.panel, mats.facade.panel, shadows, 'city-facade'],
      [c.facade.brick, mats.facade.brick, shadows, 'city-facade'],
      [c.facade.glass, mats.facade.glass, shadows, 'city-facade'],
      [c.facade.shop, mats.facade.shop, shadows, 'city-facade'],
      [c.trim, mats.trim, shadows, 'city-trim'],
      [c.slate, mats.slate, shadows, 'city-roof'],
      [c.detail, mats.detail, false, 'city-detail'],
    ];
    for (const [b, mat, cast, name] of pairs) {
      if (!b.count) continue;
      const g = b.build();
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      mesh.name = name;
      out.push(mesh);
      built.set(b, mesh);
      if (b === c.detail) detailMeshes.push(mesh);
    }
  }
  // far zoom: the balconies, awnings and roof clutter drop out
  if (lod && detailMeshes.length) for (const dm of detailMeshes) lod.add([dm], dm.geometry, null, Infinity, quality === 'high' ? 34 : quality === 'medium' ? 26 : 20);
  if (sink)
    for (const sp of spans) {
      const st = sp.st;
      const cx = st.x + st.w / 2;
      const cz = st.y + st.h / 2;
      let gy = 99;
      for (const [x, zz] of [[st.x, st.y], [st.x + st.w, st.y], [st.x, st.y + st.h], [st.x + st.w, st.y + st.h], [cx, cz]]) gy = Math.min(gy, surfaceHeight(m, x, zz));
      const ranges: HouseHandle['ranges'] = [];
      chunkBuilders(sp.c).forEach((b, k) => {
        const mesh = built.get(b);
        if (mesh && sp.to[k] > sp.from[k]) ranges.push({ mesh, start: sp.from[k], end: sp.to[k] });
      });
      sink.houses.push({ st, cx, cz, gy, ranges });
    }

  // ---- street lamps along the avenues (instanced; the heads glow after dark)
  const lampPts: { x: number; z: number; rot: number }[] = [];
  const gap = quality === 'low' ? 7 : 5;
  m.roads.forEach((pts, i) => {
    const st = deco?.roadStyles[i];
    if (!st?.straight || pts.length !== 2) return;
    const a = { x: pts[0].x + 0.5, y: pts[0].y + 0.5 };
    const b = { x: pts[1].x + 0.5, y: pts[1].y + 0.5 };
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const dx = (b.x - a.x) / L;
    const dy = (b.y - a.y) / L;
    for (let s = 2.5; s < L - 2; s += gap) {
      for (const side of [-1, 1]) {
        const off = side * 1.42;
        const x = a.x + dx * s - dy * off;
        const y = a.y + dy * s + dx * off;
        const tx = Math.floor(x);
        const ty = Math.floor(y);
        if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h || m.blocked[ty * m.w + tx] || m.trees[ty * m.w + tx]) continue;
        if (m.starts.some((p) => Math.hypot(p.x + 0.5 - x, p.y + 0.5 - y) < 12)) continue;
        if (m.tiles[ty * m.w + tx] === Tile.Water || m.tiles[ty * m.w + tx] === Tile.Bridge) continue;
        // not inside a crossing
        let crossing = false;
        m.roads.forEach((q, j) => {
          if (j === i || !deco?.roadStyles[j]?.straight || q.length !== 2) return;
          const vert = q[0].x === q[1].x;
          if (vert ? Math.abs(x - (q[0].x + 0.5)) < 2.2 && y > Math.min(q[0].y, q[1].y) && y < Math.max(q[0].y, q[1].y) + 1 : Math.abs(y - (q[0].y + 0.5)) < 2.2 && x > Math.min(q[0].x, q[1].x) && x < Math.max(q[0].x, q[1].x) + 1) crossing = true;
        });
        if (crossing) continue;
        lampPts.push({ x, z: y, rot: Math.atan2(-side * dx, -side * dy) });
      }
    }
  });
  if (lampPts.length) {
    const post = new GeoBuilder();
    post.add(new THREE.CylinderGeometry(0.012, 0.018, 0.7, 6).translate(0, 0.35, 0), new THREE.Matrix4(), null, C(0x3a3c40));
    post.add(new THREE.BoxGeometry(0.012, 0.012, 0.16).translate(0, 0.69, 0.07), new THREE.Matrix4(), null, C(0x3a3c40));
    const head = new THREE.BoxGeometry(0.06, 0.02, 0.09).translate(0, 0.675, 0.14);
    const postMat = fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.6 }));
    const headMat = fog.apply(new THREE.MeshStandardMaterial({ color: 0x5a5a58, emissive: 0xffc070, emissiveIntensity: 0, roughness: 0.4 }));
    const posts = new THREE.InstancedMesh(post.build(), postMat, lampPts.length);
    const heads = new THREE.InstancedMesh(head, headMat, lampPts.length);
    const mt = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    lampPts.forEach((p, i) => {
      q.setFromAxisAngle(V(0, 1, 0), p.rot);
      mt.compose(V(p.x, surfaceHeight(m, p.x, p.z) - 0.02, p.z), q, V(1, 1, 1));
      posts.setMatrixAt(i, mt);
      heads.setMatrixAt(i, mt);
    });
    posts.computeBoundingSphere();
    heads.computeBoundingSphere();
    posts.castShadow = quality === 'high';
    posts.name = heads.name = 'city-lamps';
    // the heads light up with the windows
    heads.onBeforeRender = () => {
      headMat.emissiveIntensity = CITY_NIGHT.value * 3;
    };
    out.push(posts, heads);
    if (lod) for (const im of [posts, heads]) lod.add([im], im.geometry, null, Infinity, quality === 'high' ? 40 : 30);
  }

  // ---- fountains on the city squares (not the base plazas)
  const fb = new GeoBuilder();
  for (const p of deco?.plazas ?? []) {
    const x = (p.x0 + p.x1) / 2;
    const y = (p.y0 + p.y1) / 2;
    if (m.starts.some((s) => Math.hypot(s.x + 0.5 - x, s.y + 0.5 - y) < 16)) continue;
    const gy = surfaceHeight(m, x, y);
    const mt = new THREE.Matrix4().makeTranslation(x, gy, y);
    fb.add(new THREE.CylinderGeometry(0.62, 0.66, 0.12, 20, 1, true).translate(0, 0.06, 0), mt, null, C(0xb8b0a0));
    fb.add(new THREE.RingGeometry(0.56, 0.66, 20).rotateX(-Math.PI / 2).translate(0, 0.12, 0), mt, null, C(0xc8c0b0));
    fb.add(new THREE.CircleGeometry(0.58, 20).rotateX(-Math.PI / 2).translate(0, 0.08, 0), mt, null, C(0x3a5a64));
    fb.add(new THREE.CylinderGeometry(0.06, 0.1, 0.42, 10).translate(0, 0.21, 0), mt, null, C(0xb8b0a0));
    fb.add(new THREE.CylinderGeometry(0.2, 0.12, 0.05, 14).translate(0, 0.42, 0), mt, null, C(0xc8c0b0));
  }
  if (fb.count) {
    const mesh = new THREE.Mesh(fb.build(), fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide })));
    mesh.receiveShadow = true;
    mesh.castShadow = shadows;
    mesh.name = 'city-fountains';
    out.push(mesh);
  }
  return out;
}

// --------------------------------------------------- entity models (flag + lamps)

const flagMat = new Map<string, THREE.Material>();

function cityModel(kind: StructureKind): Builder {
  return (style: ModelStyle, fog: FogOfWar | null): Model => {
    const root = new THREE.Group();
    const H = cityHeight(kind);
    // the entrance lamps (both long sides: the model doesn't know which way the building faces) and a roof light
    const spec = SPECS[kind]!;
    const fw = kind === StructureKind.Shop || kind === StructureKind.Townhouse ? 2 : 3;
    const fd = kind === StructureKind.Apartment || kind === StructureKind.Office ? 3 : 2;
    const nightLights = [
      { pos: V(0, spec.groundH * 0.8, fd / 2 - spec.inset + 0.08), color: 0xffd090, intensity: 0.85 },
      { pos: V(0, spec.groundH * 0.8, -fd / 2 + spec.inset - 0.08), color: 0xffd090, intensity: 0.6 },
      { pos: V(fw / 2 - spec.inset - 0.1, H + 0.05, fd / 2 - spec.inset - 0.1), color: kind === StructureKind.Office ? 0xff3020 : 0xffe0b0, intensity: 0.5 },
    ];
    const extra: Partial<Model> = { nightLights };
    if (style.faction === 'neutral') return { root, muzzles: [], height: H + 0.15, size: { x: 0.01, y: H, z: 0.01 }, glow: [], emitters: [], ...extra };
    // owner flag on the roof
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.6, 6), new THREE.MeshStandardMaterial({ color: 0x9a9ea2, roughness: 0.5, metalness: 0.6 }));
    if (fog) fog.apply(pole.material as THREE.Material);
    pole.position.set(0, H + 0.3, 0);
    pole.castShadow = true;
    root.add(pole);
    const cloth = new THREE.PlaneGeometry(0.4, 0.24, 6, 1).translate(0.2, 0, 0);
    const cols: number[] = [];
    const pos = cloth.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const yy = pos.getY(i);
      const cc = C(yy > 0.04 ? style.flag[0] : yy < -0.04 ? style.flag[2] : style.flag[1]);
      cols.push(cc.r, cc.g, cc.b);
    }
    cloth.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    const key = fog ? 'f' : 'n';
    let fm = flagMat.get(key);
    if (!fm) {
      fm = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.9 });
      if (fog) fog.apply(fm);
      flagMat.set(key, fm);
    }
    const flag = new THREE.Mesh(cloth, fm);
    flag.position.set(0.012, H + 0.48, 0);
    flag.castShadow = true;
    const base = Float32Array.from(pos.array as Float32Array);
    root.add(flag);
    // team-coloured band around the roof edge marks who holds it
    // a team-coloured ring along the roof edge (four thin rails)
    const bw = fw - spec.inset * 2 + 0.07;
    const bd = fd - spec.inset * 2 + 0.07;
    const by = (kind === StructureKind.Townhouse ? H - 0.3 : H) + 0.03;
    const bandMat = new THREE.MeshStandardMaterial({ color: style.team, emissive: style.team, emissiveIntensity: 0.3, roughness: 0.6 });
    if (fog) fog.apply(bandMat);
    for (const [w, d, x, zz] of [[bw, 0.035, 0, bd / 2], [bw, 0.035, 0, -bd / 2], [0.035, bd, bw / 2, 0], [0.035, bd, -bw / 2, 0]]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, d), bandMat);
      rail.position.set(x, by, zz);
      root.add(rail);
    }
    const anim = (s: { time: number }) => {
      const a = cloth.attributes.position.array as Float32Array;
      for (let i = 0; i < pos.count; i++) a[i * 3 + 2] = Math.sin(s.time * 5 - base[i * 3] * 14) * 0.03 * (base[i * 3] / 0.4);
      cloth.attributes.position.needsUpdate = true;
    };
    return { root, muzzles: [], height: H + 0.15, size: { x: 0.01, y: H, z: 0.01 }, glow: [], emitters: [], anim, ...extra };
  };
}

export const CITY_MODELS: Record<string, Builder> = {
  civ_city_apartment: cityModel(StructureKind.Apartment),
  civ_city_block: cityModel(StructureKind.Block),
  civ_city_office: cityModel(StructureKind.Office),
  civ_city_shop: cityModel(StructureKind.Shop),
  civ_city_townhouse: cityModel(StructureKind.Townhouse),
};
