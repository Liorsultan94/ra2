import * as THREE from "three";
import {
  StructureKind,
  Tile,
  type GameMap,
  type Structure,
} from "../../sim/map";
import { hash2 } from "../../sim/rng";
import type { FogOfWar } from "../fog";
import { GeoBuilder, type SceneryLod } from "../geo";
import { surfaceHeight } from "../ground";
import type { HouseHandle } from "../scenery";
import { onBuildingPhotos, photoTileCanvas, Tile as BTile } from "./bldtex";
import type { Builder } from "./registry";
import type { Model, ModelStyle } from "./types";

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

const CITY_KINDS = new Set<StructureKind>([
  StructureKind.Apartment,
  StructureKind.Block,
  StructureKind.Office,
  StructureKind.Shop,
  StructureKind.Townhouse,
]);
export function isCityKind(k: StructureKind) {
  return CITY_KINDS.has(k);
}

type Facade = "panel" | "brick" | "glass" | "shop" | "stone";
interface Spec {
  /** Ground floor height and style; upper floors count, height and style. */
  groundH: number;
  ground: Facade;
  floors: number;
  floorH: number;
  upper: Facade;
  bay: number;
  inset: number;
  roof: "flat" | "mansard";
}

const SPECS: Partial<Record<StructureKind, Spec>> = {
  [StructureKind.Apartment]: {
    groundH: 0.36,
    ground: "panel",
    floors: 5,
    floorH: 0.3,
    upper: "panel",
    bay: 0.34,
    inset: 0.09,
    roof: "flat",
  },
  [StructureKind.Block]: {
    groundH: 0.36,
    ground: "shop",
    floors: 4,
    floorH: 0.3,
    upper: "brick",
    bay: 0.3,
    inset: 0.08,
    roof: "flat",
  },
  [StructureKind.Office]: {
    groundH: 0.4,
    ground: "shop",
    floors: 8,
    floorH: 0.28,
    upper: "glass",
    bay: 0.32,
    inset: 0.15,
    roof: "flat",
  },
  [StructureKind.Shop]: {
    groundH: 0.36,
    ground: "shop",
    floors: 1,
    floorH: 0.3,
    upper: "panel",
    bay: 0.3,
    inset: 0.08,
    roof: "flat",
  },
  [StructureKind.Townhouse]: {
    groundH: 0.34,
    ground: "brick",
    floors: 2,
    floorH: 0.3,
    upper: "brick",
    bay: 0.3,
    inset: 0.1,
    roof: "mansard",
  },
};

/** Top of a city building's walls (the roof flag and health bar sit on it). */
export function cityHeight(kind: StructureKind): number {
  const s = SPECS[kind];
  if (!s) return 1;
  return s.groundH + s.floors * s.floorH + (s.roof === "mansard" ? 0.3 : 0.06);
}

// ------------------------------------------------------------- textures

function canvas(n: number) {
  const c = document.createElement("canvas");
  c.width = c.height = n;
  return { c, g: c.getContext("2d")! };
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

/**
 * Photoscanned wall background for a facade cell (CC0 scans shared with the base buildings, see bldtex.ts):
 * the part of the scan one bay x one floor (~0.3 tiles) covers. Null until the scans are loaded.
 */
const FACADE_SCAN: Partial<Record<Facade, { tile: BTile; frac: number }>> = {
  panel: { tile: BTile.Panel, frac: 0.42 },
  brick: { tile: BTile.Brick, frac: 0.34 },
  shop: { tile: BTile.Cast, frac: 0.45 },
  stone: { tile: BTile.Stone, frac: 0.4 },
};
function scanCell(style: Facade, N: number): HTMLCanvasElement | null {
  const f = FACADE_SCAN[style];
  if (!f) return null;
  const src = photoTileCanvas(f.tile, Math.round(N / f.frac));
  if (!src) return null;
  const { c, g } = canvas(N);
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, N, N, 0, 0, N, N);
  return c;
}

/** One bay x one floor facade cell (colour + emissive window mask); `scan` = photoscanned wall background. */
function facadeTextures(
  style: Facade,
  N: number,
  scan: HTMLCanvasElement | null = null,
): { map: THREE.Texture; glow: THREE.Texture } {
  const { c, g } = canvas(N);
  const { c: ce, g: ge } = canvas(N);
  const r = rnd(style.length * 977 + N);
  ge.fillStyle = "#000";
  ge.fillRect(0, 0, N, N);
  const grain = (a: number) => {
    for (let i = 0; i < N * 6; i++) {
      g.fillStyle = `rgba(${r() < 0.5 ? "0,0,0" : "255,255,255"},${(r() * a).toFixed(3)})`;
      g.fillRect(r() * N, r() * N, 1 + r() * 2, 1 + r() * 2);
    }
  };
  // y measured from the top of the canvas (v = 1 at the top: the floor's ceiling)
  const glass = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    tint: [number, number, number],
  ) => {
    const grd = g.createLinearGradient(0, y0 * N, 0, y1 * N);
    grd.addColorStop(0, `rgb(${tint[0] + 40},${tint[1] + 46},${tint[2] + 52})`);
    grd.addColorStop(0.55, `rgb(${tint[0]},${tint[1]},${tint[2]})`);
    grd.addColorStop(1, `rgb(${tint[0] - 10},${tint[1] - 8},${tint[2] - 4})`);
    g.fillStyle = grd;
    g.fillRect(x0 * N, y0 * N, (x1 - x0) * N, (y1 - y0) * N);
    // a diagonal sky glint
    g.fillStyle = "rgba(255,255,255,0.08)";
    g.beginPath();
    g.moveTo(x0 * N, y1 * N);
    g.lineTo((x0 + (x1 - x0) * 0.45) * N, y0 * N);
    g.lineTo((x0 + (x1 - x0) * 0.7) * N, y0 * N);
    g.lineTo((x0 + (x1 - x0) * 0.25) * N, y1 * N);
    g.fill();
    // lit interior: a warm pane with a curtain / blind edge
    const lg = ge.createLinearGradient(x0 * N, 0, x1 * N, 0);
    lg.addColorStop(0, "#9a9a9a");
    lg.addColorStop(0.3, "#fff");
    lg.addColorStop(0.8, "#e8e8e8");
    lg.addColorStop(1, "#888");
    ge.fillStyle = lg;
    ge.fillRect(x0 * N, y0 * N, (x1 - x0) * N, (y1 - y0) * N);
  };
  const frame = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    col: string,
    w: number,
  ) => {
    g.strokeStyle = col;
    g.lineWidth = w * N;
    g.strokeRect(x0 * N, y0 * N, (x1 - x0) * N, (y1 - y0) * N);
    ge.strokeStyle = "#000";
    ge.lineWidth = w * N;
    ge.strokeRect(x0 * N, y0 * N, (x1 - x0) * N, (y1 - y0) * N);
  };
  if (style === "panel") {
    g.fillStyle = "#cfcac0";
    g.fillRect(0, 0, N, N);
    if (scan) g.drawImage(scan, 0, 0);
    else grain(0.05);
    // precast panel joints: the floor line and the bay edge
    g.fillStyle = "rgba(40,36,30,0.45)";
    g.fillRect(0, N - N * 0.03, N, N * 0.03);
    g.fillRect(0, 0, N * 0.02, N);
    // a rain streak under the window
    g.fillStyle = "rgba(60,55,48,0.12)";
    g.fillRect(N * 0.3, N * 0.78, N * 0.4, N * 0.2);
    glass(0.2, 0.22, 0.8, 0.74, [52, 62, 72]);
    frame(0.2, 0.22, 0.8, 0.74, "#e8e6e0", 0.035);
    g.fillStyle = "#e8e6e0";
    g.fillRect(N * 0.49, N * 0.22, N * 0.025, N * 0.52);
    ge.fillStyle = "#000";
    ge.fillRect(N * 0.49, N * 0.22, N * 0.025, N * 0.52);
    g.fillStyle = "#b0aaa0";
    g.fillRect(N * 0.17, N * 0.74, N * 0.66, N * 0.04);
  } else if (style === "brick") {
    g.fillStyle = "#8a8076";
    g.fillRect(0, 0, N, N);
    const rows = scan ? 0 : 10;
    if (scan) g.drawImage(scan, 0, 0);
    for (let y = 0; y < rows; y++) {
      const off = (y % 2) * 0.5;
      for (let x = -1; x < 4; x++) {
        const t = r();
        const rr = 150 + t * 40;
        g.fillStyle = `rgb(${rr | 0},${(rr * 0.52) | 0},${(rr * 0.4) | 0})`;
        g.fillRect(
          ((x + off) / 3.5) * N + 1,
          (y / rows) * N + 1,
          N / 3.5 - 2,
          N / rows - 2,
        );
      }
    }
    if (!scan) grain(0.06);
    glass(0.28, 0.2, 0.72, 0.78, [48, 56, 64]);
    frame(0.28, 0.2, 0.72, 0.78, "#ecebe4", 0.04);
    g.fillStyle = "#ecebe4";
    g.fillRect(N * 0.49, N * 0.2, N * 0.025, N * 0.58);
    g.fillRect(N * 0.28, N * 0.47, N * 0.44, N * 0.02);
    ge.fillStyle = "#000";
    ge.fillRect(N * 0.49, N * 0.2, N * 0.025, N * 0.58);
    // stone lintel and sill
    g.fillStyle = "#d8d0c0";
    g.fillRect(N * 0.25, N * 0.13, N * 0.5, N * 0.06);
    g.fillRect(N * 0.25, N * 0.79, N * 0.5, N * 0.04);
  } else if (style === "glass") {
    glass(0, 0, 1, 0.8, [78, 104, 124]);
    // spandrel band at the floor slab, mullions at the bay edges
    g.fillStyle = "#3a4048";
    g.fillRect(0, N * 0.8, N, N * 0.2);
    ge.fillStyle = "#000";
    ge.fillRect(0, N * 0.8, N, N * 0.2);
    g.fillStyle = "#9aa2aa";
    g.fillRect(0, 0, N * 0.04, N);
    g.fillRect(N * 0.96, 0, N * 0.04, N);
    g.fillRect(0, N * 0.78, N, N * 0.025);
    ge.fillRect(0, 0, N * 0.04, N);
    ge.fillRect(N * 0.96, 0, N * 0.04, N);
  } else if (style === "stone") {
    // Mediterranean limestone ashlar ("Jerusalem stone"): coursed blocks, a deep-set window, stone sill and lintel
    g.fillStyle = "#dccbaa";
    g.fillRect(0, 0, N, N);
    if (scan) {
      g.globalAlpha = 0.75;
      g.drawImage(scan, 0, 0);
      g.globalAlpha = 1;
    }
    const rows = 5;
    for (let y = 0; y < rows; y++) {
      let x = -(y % 2) * 0.27;
      while (x < 1) {
        const bw = 0.32 + r() * 0.26;
        const t = r();
        g.fillStyle = `rgba(${(226 + t * 22) | 0},${(208 + t * 20) | 0},${(170 + t * 22) | 0},${scan ? 0.35 : 0.9})`;
        g.fillRect(x * N + 1, (y / rows) * N + 1, bw * N - 2, N / rows - 2);
        // chiselled face: a few darker pits
        for (let k = 0; k < 6; k++) {
          g.fillStyle = `rgba(120,96,64,${(r() * 0.18).toFixed(3)})`;
          g.fillRect(
            (x + r() * bw) * N,
            ((y + r()) / rows) * N,
            1 + r() * 2,
            1 + r() * 2,
          );
        }
        x += bw;
      }
      g.fillStyle = "rgba(150,128,96,0.45)";
      g.fillRect(0, (y / rows) * N, N, Math.max(1, N * 0.012));
    }
    if (!scan) grain(0.05);
    // deep reveal, glass, frame, mullion
    g.fillStyle = "rgba(70,56,40,0.55)";
    g.fillRect(N * 0.27, N * 0.2, N * 0.46, N * 0.58);
    glass(0.31, 0.25, 0.69, 0.76, [46, 54, 60]);
    frame(0.31, 0.25, 0.69, 0.76, "#f2ede2", 0.03);
    g.fillStyle = "#f2ede2";
    g.fillRect(N * 0.49, N * 0.25, N * 0.022, N * 0.51);
    ge.fillStyle = "#000";
    ge.fillRect(N * 0.49, N * 0.25, N * 0.022, N * 0.51);
    // a half-lowered roller shutter box over the top of the pane
    g.fillStyle = "#c8c2b4";
    g.fillRect(N * 0.31, N * 0.25, N * 0.38, N * 0.07);
    ge.fillRect(N * 0.31, N * 0.25, N * 0.38, N * 0.07);
    g.fillStyle = "rgba(80,72,60,0.35)";
    for (let k = 0; k < 4; k++)
      g.fillRect(N * 0.31, N * (0.265 + k * 0.015), N * 0.38, 1);
    g.fillStyle = "#efe4c8";
    g.fillRect(N * 0.25, N * 0.14, N * 0.5, N * 0.06);
    g.fillRect(N * 0.25, N * 0.78, N * 0.5, N * 0.045);
  } else {
    // shop front: stone base and pillars, a big display window, a sign band
    g.fillStyle = "#9a948a";
    g.fillRect(0, 0, N, N);
    if (scan) {
      g.globalAlpha = 0.85;
      g.drawImage(scan, 0, 0);
      g.globalAlpha = 1;
    } else grain(0.05);
    g.fillStyle = "#3e3c3a";
    g.fillRect(0, N * 0.06, N, N * 0.16);
    g.fillStyle = "#d6d2c8";
    g.fillRect(0, N * 0.09, N, N * 0.1);
    glass(0.08, 0.3, 0.92, 0.92, [44, 50, 54]);
    frame(0.08, 0.3, 0.92, 0.92, "#2c2c2e", 0.04);
    g.fillStyle = "#2c2c2e";
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
  g.fillStyle = "#d0d0d0";
  g.fillRect(0, 0, N, N);
  for (let i = 0; i < N * 8; i++) {
    const v = (r() * 80 + 150) | 0;
    g.fillStyle = `rgba(${v},${v},${v},0.35)`;
    g.fillRect(r() * N, r() * N, 1 + r() * 2, 1 + r() * 2);
  }
  if (tiles) {
    // slate rows for the mansard roofs
    for (let y = 0; y < 8; y++) {
      g.fillStyle = "rgba(30,30,34,0.45)";
      g.fillRect(0, (y / 8) * N, N, 2);
      for (let x = 0; x < 6; x++) {
        g.fillStyle = "rgba(30,30,34,0.3)";
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

function cityMaterials(
  fog: FogOfWar,
  quality: "low" | "medium" | "high",
): CityMats {
  const N = quality === "low" ? 64 : 128;
  const facade = {} as Record<Facade, THREE.MeshStandardMaterial>;
  for (const st of ["panel", "brick", "glass", "shop", "stone"] as Facade[]) {
    const t = facadeTextures(st, N);
    const glassy = st === "glass";
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
      sh.fragmentShader = sh.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nuniform float cityNight;",
        )
        .replace("#include <emissivemap_fragment>", NIGHT_GLSL);
    };
    fog.apply(m);
    m.customProgramCacheKey = () => "fog2-cityfacade";
    facade[st] = m;
  }
  // repaint the wall backgrounds with the photoscans once they are loaded (medium / high)
  onBuildingPhotos(() => {
    for (const st of ["panel", "brick", "shop", "stone"] as Facade[]) {
      const scan = scanCell(st, N);
      if (!scan) continue;
      const t = facadeTextures(st, N, scan);
      const map = facade[st].map!;
      map.image = t.map.image;
      map.needsUpdate = true;
      t.map.dispose();
      t.glow.dispose();
    }
  });
  const trim = fog.apply(
    new THREE.MeshStandardMaterial({
      map: plainTexture(64, 11),
      vertexColors: true,
      roughness: 0.9,
      metalness: 0.02,
    }),
  );
  const slate = fog.apply(
    new THREE.MeshStandardMaterial({
      map: plainTexture(64, 13, true),
      vertexColors: true,
      roughness: 0.7,
      metalness: 0.1,
    }),
  );
  const detail = fog.apply(
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.6,
      metalness: 0.25,
    }),
  );
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
const newChunk = (): Chunk => ({
  facade: {
    panel: new GeoBuilder(),
    brick: new GeoBuilder(),
    glass: new GeoBuilder(),
    shop: new GeoBuilder(),
    stone: new GeoBuilder(),
  },
  trim: new GeoBuilder(),
  slate: new GeoBuilder(),
  detail: new GeoBuilder(),
});
const chunkBuilders = (c: Chunk) => [
  c.facade.panel,
  c.facade.brick,
  c.facade.glass,
  c.facade.shop,
  c.facade.stone,
  c.trim,
  c.slate,
  c.detail,
];

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
function box(
  b: GeoBuilder,
  P: Place,
  cx: number,
  y0: number,
  cz: number,
  w: number,
  h: number,
  d: number,
  col: THREE.Color,
  uvK = 1,
  bottom = false,
) {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;
  const y1 = y0 + h;
  const quad = (
    a: number[],
    bb: number[],
    c: number[],
    dd: number[],
    n: number[],
    uw: number,
    vh: number,
  ) => {
    const N = P.n(n[0], n[1], n[2]);
    const ia = b.vert(P.p(a[0], a[1], a[2]), N, 0, vh * uvK, col);
    const ib = b.vert(P.p(bb[0], bb[1], bb[2]), N, uw * uvK, vh * uvK, col);
    const ic = b.vert(P.p(c[0], c[1], c[2]), N, 0, 0, col);
    const id = b.vert(P.p(dd[0], dd[1], dd[2]), N, uw * uvK, 0, col);
    b.quad(ia, ib, ic, id);
  };
  quad([x0, y1, z1], [x1, y1, z1], [x0, y0, z1], [x1, y0, z1], [0, 0, 1], w, h);
  quad([x1, y1, z1], [x1, y1, z0], [x1, y0, z1], [x1, y0, z0], [1, 0, 0], d, h);
  quad(
    [x1, y1, z0],
    [x0, y1, z0],
    [x1, y0, z0],
    [x0, y0, z0],
    [0, 0, -1],
    w,
    h,
  );
  quad(
    [x0, y1, z0],
    [x0, y1, z1],
    [x0, y0, z0],
    [x0, y0, z1],
    [-1, 0, 0],
    d,
    h,
  );
  quad([x0, y1, z0], [x1, y1, z0], [x0, y1, z1], [x1, y1, z1], [0, 1, 0], w, d);
  if (bottom)
    quad(
      [x0, y0, z1],
      [x1, y0, z1],
      [x0, y0, z0],
      [x1, y0, z0],
      [0, -1, 0],
      w,
      d,
    );
}

/**
 * Facade band: the four walls of a box from y0, `floors` floors of `fh` each, UVs in whole bays
 * (`bay` wide) x floors, offset by `uOff` bays (per building: the lit-window hash differs).
 */
function facade(
  b: GeoBuilder,
  P: Place,
  w: number,
  d: number,
  y0: number,
  floors: number,
  fh: number,
  bay: number,
  uOff: number,
  col: THREE.Color,
  sides = [true, true, true, true],
) {
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
function flatRoof(
  c: Chunk,
  P: Place,
  w: number,
  d: number,
  top: number,
  roofC: THREE.Color,
  edgeC: THREE.Color,
) {
  box(c.trim, P, 0, top - 0.02, 0, w - 0.04, 0.03, d - 0.04, roofC, 1.4);
  const t = 0.045;
  const ph = 0.07;
  box(c.trim, P, 0, top, d / 2 - t / 2, w, ph, t, edgeC, 2);
  box(c.trim, P, 0, top, -d / 2 + t / 2, w, ph, t, edgeC, 2);
  box(c.trim, P, w / 2 - t / 2, top, 0, t, ph, d - 2 * t, edgeC, 2);
  box(c.trim, P, -w / 2 + t / 2, top, 0, t, ph, d - 2 * t, edgeC, 2);
}

// ------------------------------------------------- roof and facade dressing (detail mesh: hidden at far zoom)

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const UNIT_CYL = new THREE.CylinderGeometry(1, 1, 1, 8);
const UNIT_BALL = new THREE.IcosahedronGeometry(1, 0);
const DISH = new THREE.SphereGeometry(
  1,
  8,
  3,
  0,
  Math.PI * 2,
  0,
  Math.PI / 2.8,
);
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/** Add a unit geometry into the building's local frame: at (x, y, z), turned (ry, then rx, rz), scaled. */
function put(
  b: GeoBuilder,
  P: Place,
  g: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  col: THREE.Color,
  ry = 0,
  rx = 0,
  rz = 0,
) {
  _q.setFromEuler(_e.set(rx, ry, rz, "YXZ"));
  b.add(
    g,
    P.m
      .clone()
      .multiply(new THREE.Matrix4().compose(V(x, y, z), _q, V(sx, sy, sz))),
    null,
    col,
  );
}

/** Same, but in a sub-frame (x0, y0, z0, yaw ry0) of the building: for items that face a fixed way. */
function putIn(
  b: GeoBuilder,
  P: Place,
  x0: number,
  y0: number,
  z0: number,
  ry0: number,
  g: THREE.BufferGeometry,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  col: THREE.Color,
  rx = 0,
  rz = 0,
) {
  const c = Math.cos(ry0);
  const s = Math.sin(ry0);
  put(
    b,
    P,
    g,
    x0 + x * c + z * s,
    y0 + y,
    z0 - x * s + z * c,
    sx,
    sy,
    sz,
    col,
    ry0,
    rx,
    rz,
  );
}

const PANEL_C = C(0x1c2a44);
const BOILER_C = C(0xe8e8e2);
const ALU_C = C(0xa8acae);
const DARK_C = C(0x26282a);

/** Israeli-style solar water heater: a tilted collector panel facing local +z (yaw ry), the white boiler behind it on a frame. */
function solarHeater(
  b: GeoBuilder,
  P: Place,
  x: number,
  y: number,
  z: number,
  ry: number,
) {
  putIn(
    b,
    P,
    x,
    y,
    z,
    ry,
    UNIT_BOX,
    0,
    0.05,
    0.03,
    0.15,
    0.008,
    0.115,
    PANEL_C,
    0.7,
  );
  putIn(
    b,
    P,
    x,
    y,
    z,
    ry,
    UNIT_BOX,
    0,
    0.05,
    0.03,
    0.155,
    0.004,
    0.12,
    ALU_C,
    0.7,
  ); // frame edge peeks out
  putIn(
    b,
    P,
    x,
    y,
    z,
    ry,
    UNIT_CYL,
    0,
    0.105,
    -0.04,
    0.03,
    0.17,
    0.03,
    BOILER_C,
    0,
    Math.PI / 2,
  );
  for (const sx of [-0.065, 0.065])
    putIn(
      b,
      P,
      x,
      y,
      z,
      ry,
      UNIT_BOX,
      sx,
      0.045,
      -0.04,
      0.008,
      0.09,
      0.008,
      ALU_C,
    );
}

function acUnit(
  b: GeoBuilder,
  P: Place,
  x: number,
  y: number,
  z: number,
  ry: number,
) {
  putIn(
    b,
    P,
    x,
    y,
    z,
    ry,
    UNIT_BOX,
    0,
    0.033,
    0,
    0.09,
    0.066,
    0.055,
    C(0xd4d4cc),
  );
  putIn(
    b,
    P,
    x,
    y,
    z,
    ry,
    UNIT_CYL,
    0.012,
    0.035,
    0.028,
    0.022,
    0.004,
    0.022,
    DARK_C,
    Math.PI / 2,
  );
}

function antenna(
  b: GeoBuilder,
  P: Place,
  x: number,
  y: number,
  z: number,
  H: number,
  ry: number,
) {
  put(b, P, UNIT_BOX, x, y + H / 2, z, 0.008, H, 0.008, C(0x5a5e62));
  for (let k = 0; k < 3; k++)
    putIn(
      b,
      P,
      x,
      y,
      z,
      ry,
      UNIT_BOX,
      0,
      H - 0.02 - k * 0.045,
      0,
      0.13 - k * 0.025,
      0.005,
      0.005,
      C(0x6a6e72),
    );
}

function dish(
  b: GeoBuilder,
  P: Place,
  x: number,
  y: number,
  z: number,
  ry: number,
) {
  putIn(b, P, x, y, z, ry, UNIT_BOX, 0, 0.025, 0, 0.01, 0.05, 0.01, ALU_C);
  putIn(
    b,
    P,
    x,
    y,
    z,
    ry,
    DISH,
    0,
    0.06,
    0,
    0.05,
    0.05,
    0.05,
    C(0xe4e4e0),
    -1.1,
  );
}

/** Rooftop garden: planters with shrubs and a pergola. */
function roofGarden(
  b: GeoBuilder,
  P: Place,
  x: number,
  y: number,
  z: number,
  w: number,
  d: number,
  h: (k: number) => number,
) {
  const pot = C([0xa0583a, 0x8a7a68, 0xb8a888][Math.floor(h(70) * 3)]);
  const leaf = C(0x4a7a34);
  for (const sz of [-1, 1]) {
    put(
      b,
      P,
      UNIT_BOX,
      x,
      y + 0.025,
      z + sz * (d / 2 - 0.04),
      w,
      0.05,
      0.06,
      pot,
    );
    for (let i = 0; i < 3; i++)
      put(
        b,
        P,
        UNIT_BALL,
        x - w / 2 + (w * (i + 0.5)) / 3,
        y + 0.07,
        z + sz * (d / 2 - 0.04),
        0.045,
        0.04,
        0.035,
        leaf.clone().multiplyScalar(0.85 + h(71 + i) * 0.3),
      );
  }
  // pergola: four posts and slats
  const wood = C(0x8a6a4a);
  for (const [px, pz] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ])
    put(
      b,
      P,
      UNIT_BOX,
      x + px * (w / 2 - 0.03),
      y + 0.07,
      z + pz * (d / 2 - 0.12),
      0.012,
      0.14,
      0.012,
      wood,
    );
  for (let i = 0; i < 4; i++)
    put(
      b,
      P,
      UNIT_BOX,
      x - w / 2 + 0.03 + ((w - 0.06) * i) / 3,
      y + 0.145,
      z,
      0.012,
      0.01,
      d - 0.2,
      wood,
    );
  // a table under it
  put(b, P, UNIT_CYL, x, y + 0.03, z, 0.04, 0.06, 0.04, C(0xe8e4dc));
}

interface RoofOpts {
  heaters: number;
  tanks: number;
  ac: number;
  dish: boolean;
  antenna: boolean;
  garden: boolean;
  /** The building's rot (heaters all face the same way in the world). */
  rot: number;
  /** Keep this local x range clear (a penthouse). */
  clear?: [number, number];
}

function roofClutter(
  c: Chunk,
  P: Place,
  w: number,
  d: number,
  top: number,
  h: (k: number) => number,
  o: RoofOpts,
) {
  const b = c.detail;
  // stair / lift head
  const sx = (h(30) - 0.5) * w * 0.4;
  const sz = (h(31) - 0.5) * d * 0.3;
  box(c.trim, P, sx, top, sz, 0.32, 0.18, 0.26, C(0xb4b0a8), 2);
  const taken: [number, number, number][] = [
    [sx, sz, 0.24],
    [0, 0, 0.12],
  ];
  const free = (x: number, z: number, r: number) => {
    if (Math.abs(x) > w / 2 - r - 0.04 || Math.abs(z) > d / 2 - r - 0.04)
      return false;
    if (o.clear && x > o.clear[0] - r && x < o.clear[1] + r) return false;
    if (taken.some(([tx, tz, tr]) => Math.hypot(tx - x, tz - z) < tr + r))
      return false;
    taken.push([x, z, r]);
    return true;
  };
  // the solar heaters face one way in the world (towards +z)
  const face = (-o.rot * Math.PI) / 2;
  let n = 0;
  for (let row = 0; row < 3 && n < o.heaters; row++)
    for (let i = 0; n < o.heaters && i < 12; i++) {
      const x = -w / 2 + 0.13 + i * 0.19;
      const z = -d / 2 + 0.16 + row * 0.24;
      if (x > w / 2 - 0.1) break;
      if (!free(x, z, 0.09)) continue;
      solarHeater(b, P, x, top, z, face);
      n++;
    }
  // water tanks: black plastic or galvanised
  for (let i = 0, k = 0; i < o.tanks && k < 10; k++) {
    const x = (h(80 + k) - 0.5) * w * 0.8;
    const z = (h(90 + k) - 0.5) * d * 0.8;
    if (!free(x, z, 0.06)) continue;
    const r = 0.04 + h(100 + k) * 0.015;
    put(
      b,
      P,
      UNIT_CYL,
      x,
      top + 0.05,
      z,
      r,
      0.1,
      r,
      h(110 + k) < 0.7 ? C(0x1e1e20) : C(0x9a9c9e),
    );
    i++;
  }
  for (let i = 0, k = 0; i < o.ac && k < 12; k++) {
    const x = (h(40 + k) - 0.5) * w * 0.8;
    const z = (h(50 + k) - 0.5) * d * 0.8;
    if (!free(x, z, 0.06)) continue;
    acUnit(b, P, x, top, z, Math.floor(h(60 + k) * 4) * (Math.PI / 2));
    i++;
  }
  if (o.dish) {
    const x = w / 2 - 0.1;
    const z = (h(37) - 0.5) * d * 0.6;
    if (free(x, z, 0.06)) dish(b, P, x, top, z, face + 0.6);
  }
  if (o.antenna) {
    const x = (h(36) - 0.5) * w * 0.6;
    const z = (h(38) - 0.5) * d * 0.6;
    if (free(x, z, 0.04))
      antenna(b, P, x, top, z, 0.32 + h(39) * 0.25, h(35) * 3);
  }
  if (o.garden) {
    const gw = Math.min(0.6, w * 0.4);
    const gx = o.clear
      ? -w / 2 + gw / 2 + 0.08
      : (h(72) < 0.5 ? -1 : 1) * (w / 2 - gw / 2 - 0.08);
    const gz = d / 2 - 0.3;
    if (free(gx, gz, 0.2)) roofGarden(b, P, gx, top, gz, gw, 0.42, h);
  }
}

/** Balcony on the front (sz = 1) or back (-1) wall: slab and either a solid parapet or a railing. */
function balcony(
  b: GeoBuilder,
  P: Place,
  x: number,
  y: number,
  D: number,
  sz: number,
  w: number,
  col: THREE.Color,
  rail: boolean,
  railC: THREE.Color,
) {
  const z = sz * (D / 2 + 0.05);
  put(b, P, UNIT_BOX, x, y + 0.008, z, w, 0.016, 0.1, col);
  if (!rail) {
    put(b, P, UNIT_BOX, x, y + 0.045, sz * (D / 2 + 0.095), w, 0.06, 0.01, col);
    for (const s of [-1, 1])
      put(b, P, UNIT_BOX, x + (s * w) / 2, y + 0.045, z, 0.01, 0.06, 0.09, col);
    return;
  }
  // railing: top and mid rails and a few balusters (cheap at this size)
  const zo = sz * (D / 2 + 0.096);
  put(b, P, UNIT_BOX, x, y + 0.085, zo, w, 0.008, 0.008, railC);
  put(b, P, UNIT_BOX, x, y + 0.045, zo, w, 0.005, 0.005, railC);
  for (let i = 0; i <= 4; i++)
    put(
      b,
      P,
      UNIT_BOX,
      x - w / 2 + (w * i) / 4,
      y + 0.05,
      zo,
      0.006,
      0.07,
      0.006,
      railC,
    );
  for (const s of [-1, 1])
    put(
      b,
      P,
      UNIT_BOX,
      x + (s * w) / 2,
      y + 0.085,
      z,
      0.008,
      0.008,
      0.09,
      railC,
    );
}

const CLOTHES = [
  0xe8e8e8, 0xc83a32, 0x3a64b0, 0xf0d040, 0x6aa060, 0xe08aa8, 0x404040,
  0xf4f0e0,
];

/** Laundry rack outside a window (face k: 0 front +z, 1 +x, 2 back -z, 3 -x): brackets, three lines, a few clothes. */
function laundry(
  b: GeoBuilder,
  P: Place,
  k: number,
  along: number,
  y: number,
  W: number,
  D: number,
  h: (k: number) => number,
  seed: number,
) {
  const ry = [0, Math.PI / 2, Math.PI, -Math.PI / 2][k];
  const off = k % 2 === 0 ? D / 2 : W / 2;
  const x0 = Math.sin(ry) * off + Math.cos(ry) * along;
  const z0 = Math.cos(ry) * off - Math.sin(ry) * along;
  const ln = 0.2;
  for (const s of [-1, 1])
    putIn(
      b,
      P,
      x0,
      y,
      z0,
      ry,
      UNIT_BOX,
      (s * ln) / 2,
      0,
      0.045,
      0.006,
      0.006,
      0.09,
      ALU_C,
    );
  for (let i = 0; i < 3; i++)
    putIn(
      b,
      P,
      x0,
      y,
      z0,
      ry,
      UNIT_BOX,
      0,
      0.002,
      0.02 + i * 0.03,
      ln,
      0.003,
      0.003,
      C(0xd8d8d8),
    );
  const n = 2 + Math.floor(h(seed) * 3);
  for (let i = 0; i < n; i++) {
    const cw = 0.035 + h(seed + 1 + i) * 0.04;
    const ch = 0.04 + h(seed + 5 + i) * 0.05;
    putIn(
      b,
      P,
      x0,
      y,
      z0,
      ry,
      UNIT_BOX,
      -ln / 2 + 0.03 + (i / n) * (ln - 0.05) + cw / 2,
      -ch / 2,
      0.02 + (i % 3) * 0.03,
      cw,
      ch,
      0.003,
      C(CLOTHES[Math.floor(h(seed + 9 + i) * CLOTHES.length)]),
    );
  }
}

/** Wall-mounted AC compressors on a face (k as laundry), on random bays / floors. */
function wallAc(
  b: GeoBuilder,
  P: Place,
  k: number,
  W: number,
  D: number,
  y0: number,
  floors: number,
  fh: number,
  n: number,
  h: (k: number) => number,
  seed: number,
) {
  const ry = [0, Math.PI / 2, Math.PI, -Math.PI / 2][k];
  const off = (k % 2 === 0 ? D / 2 : W / 2) + 0.028;
  const len = k % 2 === 0 ? W : D;
  for (let i = 0; i < n; i++) {
    const along = (h(seed + i) - 0.5) * (len - 0.2);
    const f = Math.floor(h(seed + 20 + i) * floors);
    const x = Math.sin(ry) * off + Math.cos(ry) * along;
    const z = Math.cos(ry) * off - Math.sin(ry) * along;
    put(
      b,
      P,
      UNIT_BOX,
      x,
      y0 + f * fh + 0.02,
      z,
      k % 2 === 0 ? 0.075 : 0.05,
      0.055,
      k % 2 === 0 ? 0.05 : 0.075,
      C(0xd8d8d0),
      0,
    );
  }
}

/** Shutters beside the windows of the front and back walls (window half-width `win` of a bay). */
function shutters(
  b: GeoBuilder,
  P: Place,
  W: number,
  D: number,
  y0: number,
  floors: number,
  fh: number,
  bay: number,
  win: number,
  col: THREE.Color,
  h: (k: number) => number,
  skipDoor: boolean,
) {
  const nb = Math.max(1, Math.round(W / bay));
  const bw = W / nb;
  const sw = bw * 0.2;
  for (let f = 0; f < floors; f++)
    for (let i = 0; i < nb; i++)
      for (const sz of [1, -1]) {
        if (skipDoor && f === 0 && sz > 0 && i === Math.floor(nb / 2)) continue;
        if (h(200 + f * 17 + i * 3 + (sz > 0 ? 0 : 1)) < 0.2) continue; // a few lost / closed ones
        const x = -W / 2 + bw * (i + 0.5);
        const z = sz * (D / 2 + 0.004);
        const y = y0 + f * fh + fh * 0.22;
        const tone = col
          .clone()
          .multiplyScalar(0.85 + h(300 + f * 13 + i) * 0.3);
        for (const s of [-1, 1])
          put(
            b,
            P,
            UNIT_BOX,
            x + s * (win * bw + sw / 2),
            y + fh * 0.29,
            z,
            sw,
            fh * 0.58,
            0.006,
            tone,
          );
      }
}

/** Striped cloth awning (local frame), tilted down to the front, with a valance. */
function awning(
  b: GeoBuilder,
  P: Place,
  x: number,
  y: number,
  z: number,
  ry: number,
  w: number,
  col: THREE.Color,
) {
  const n = Math.max(3, Math.round(w / 0.07));
  const white = C(0xf2efe6);
  for (let i = 0; i < n; i++) {
    const c = i % 2 === 0 ? col : white;
    const lx = -w / 2 + (w * (i + 0.5)) / n;
    putIn(
      b,
      P,
      x,
      y,
      z,
      ry,
      UNIT_BOX,
      lx,
      0,
      0.09,
      w / n,
      0.012,
      0.18,
      c,
      0.35,
    );
    putIn(
      b,
      P,
      x,
      y,
      z,
      ry,
      UNIT_BOX,
      lx,
      -0.055,
      0.172,
      w / n,
      0.035,
      0.004,
      c,
    );
  }
}

const APT_TINTS = [0xffffff, 0xf3e8d4, 0xe2eaf0, 0xf2dcd0, 0xe8ecd8];
const BRICK_TINTS = [0xffffff, 0xe8d0c0, 0xd8c8b8, 0xf0e0d0];
const PLASTER_TINTS = [0xf4e6c8, 0xe6d0a8, 0xd8e0e4, 0xf0d4c4, 0xe4e8d0];
/** Limestone: cream to honey. */
const STONE_TINTS = [0xffffff, 0xfff2dc, 0xf6e6c8, 0xfaeee0, 0xece0c8];
const AWNINGS = [0xb83a2a, 0x2a6aa8, 0x2f8a5a, 0xd8a030, 0x6a3a8a, 0x404448];
const SHUTTERS = [0x3a6a4a, 0x2e5a8a, 0x6a4a32, 0x4a7a8a, 0x8a3a2a];
const RAILS = [0x2a2c30, 0xd8d8d4, 0x4a5a4a];

/** One city building into the chunk builders. */
function buildOne(
  m: GameMap,
  st: Structure,
  c: Chunk,
  uOff: number,
  rich: boolean,
) {
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
  const dt = c.detail;
  let upperTint: THREE.Color;
  let top: number;
  switch (st.kind) {
    case StructureKind.Apartment: {
      // concrete panel blocks, or the same clad in limestone
      const stone = h(60) < 0.5;
      const fb = stone ? c.facade.stone : c.facade.panel;
      upperTint = C(
        stone
          ? STONE_TINTS[Math.floor(v * STONE_TINTS.length)]
          : APT_TINTS[Math.floor(v * APT_TINTS.length)],
      );
      facade(
        fb,
        P,
        W,
        D,
        0,
        1,
        gH,
        spec.bay,
        uOff,
        upperTint.clone().multiplyScalar(0.92),
      );
      facade(
        fb,
        P,
        W,
        D,
        gH,
        spec.floors,
        spec.floorH,
        spec.bay,
        uOff + 3,
        upperTint,
      );
      top = gH + spec.floors * spec.floorH;
      flatRoof(
        c,
        P,
        W + 0.04,
        D + 0.04,
        top,
        C(0x5c5a56),
        upperTint.clone().multiplyScalar(0.86),
      );
      // balconies on the front and back, every other bay: solid parapets or railings, some with laundry
      const nb = Math.max(1, Math.round(W / spec.bay));
      const bw = W / nb;
      const balC = upperTint.clone().multiplyScalar(0.8);
      const rail = h(62) < 0.55;
      const railC = C(RAILS[Math.floor(h(63) * RAILS.length)]);
      for (let f = 0; f < spec.floors; f++)
        for (let i = (f + Math.floor(v * 2)) % 2; i < nb; i += 2)
          for (const sz of [1, -1]) {
            const y = gH + f * spec.floorH + 0.01;
            if (rich)
              balcony(
                dt,
                P,
                -W / 2 + bw * (i + 0.5),
                y,
                D,
                sz,
                bw * 0.82,
                balC,
                rail,
                railC,
              );
            else
              box(
                dt,
                P,
                -W / 2 + bw * (i + 0.5),
                y,
                sz * (D / 2 + 0.05),
                bw * 0.82,
                0.1,
                0.1,
                balC,
              );
          }
      // entrance canopy
      box(
        dt,
        P,
        0,
        spec.groundH * 0.85,
        D / 2 + 0.09,
        0.42,
        0.03,
        0.18,
        C(0x6a6c70),
      );
      // a set-back roof apartment on some (kept off the roof centre: the owner's flag stands there)
      let clear: [number, number] | undefined;
      if (h(61) < 0.4) {
        const pw = W * 0.38;
        const pd = D * 0.62;
        const ox = W * 0.27;
        const PP = new Place(0, 0, 0, st.rot);
        PP.m
          .copy(P.m)
          .multiply(new THREE.Matrix4().makeTranslation(ox, top, -D * 0.12));
        facade(
          fb,
          PP,
          pw,
          pd,
          0,
          1,
          spec.floorH,
          spec.bay,
          uOff + 11,
          upperTint,
        );
        flatRoof(
          c,
          PP,
          pw + 0.03,
          pd + 0.03,
          spec.floorH,
          C(0x5c5a56),
          upperTint.clone().multiplyScalar(0.86),
        );
        if (rich) {
          // its terrace: a pergola and a parasol
          put(
            dt,
            P,
            UNIT_CYL,
            ox,
            top + 0.09,
            D * 0.3,
            0.006,
            0.18,
            0.006,
            ALU_C,
          );
          put(
            dt,
            P,
            new THREE.ConeGeometry(1, 1, 8),
            ox,
            top + 0.2,
            D * 0.3,
            0.12,
            0.04,
            0.12,
            C(AWNINGS[Math.floor(h(64) * AWNINGS.length)]),
          );
        }
        clear = [ox - pw / 2 - 0.02, ox + pw / 2 + 0.02];
      }
      if (rich) {
        roofClutter(c, P, W, D, top, h, {
          heaters: 3 + Math.floor(h(65) * 6),
          tanks: 1 + Math.floor(h(66) * 3),
          ac: 2 + Math.floor(h(67) * 3),
          dish: h(68) < 0.6,
          antenna: h(69) < 0.7,
          garden: false,
          rot: st.rot,
          clear,
        });
        for (const k of [1, 3])
          wallAc(
            dt,
            P,
            k,
            W,
            D,
            gH,
            spec.floors,
            spec.floorH,
            2 + Math.floor(h(120 + k) * 3),
            h,
            130 + k * 10,
          );
        for (let i = 0; i < 3; i++)
          if (h(150 + i) < 0.6)
            laundry(
              dt,
              P,
              2,
              (h(160 + i) - 0.5) * (W - 0.4),
              gH +
                (1 + Math.floor(h(170 + i) * (spec.floors - 1))) * spec.floorH +
                0.04,
              W,
              D,
              h,
              180 + i * 12,
            );
      } else
        box(
          c.trim,
          P,
          (h(30) - 0.5) * W * 0.4,
          top,
          (h(31) - 0.5) * D * 0.3,
          0.32,
          0.18,
          0.26,
          C(0xb4b0a8),
          2,
        );
      break;
    }
    case StructureKind.Block: {
      const stone = h(60) < 0.35;
      upperTint = C(
        stone
          ? STONE_TINTS[Math.floor(v * STONE_TINTS.length)]
          : BRICK_TINTS[Math.floor(v * BRICK_TINTS.length)],
      );
      const fb = stone ? c.facade.stone : c.facade.brick;
      facade(c.facade.shop, P, W, D, 0, 1, gH, spec.bay * 2, uOff, groundTint, [
        true,
        false,
        true,
        false,
      ]);
      facade(
        fb,
        P,
        W,
        D,
        0,
        1,
        gH,
        spec.bay,
        uOff,
        upperTint.clone().multiplyScalar(0.85),
        [false, true, false, true],
      );
      facade(
        fb,
        P,
        W,
        D,
        gH,
        spec.floors,
        spec.floorH,
        spec.bay,
        uOff + 5,
        upperTint,
      );
      top = gH + spec.floors * spec.floorH;
      flatRoof(c, P, W + 0.06, D + 0.06, top, C(0x55524e), C(0xd2c8b8));
      // cornice and a string course over the shops
      box(c.trim, P, 0, top - 0.04, 0, W + 0.1, 0.04, D + 0.1, C(0xd8d0c0), 2);
      box(c.trim, P, 0, gH - 0.02, 0, W + 0.04, 0.03, D + 0.04, C(0xd8d0c0), 2);
      // striped shop awnings
      const aw = C(AWNINGS[Math.floor(h(3) * AWNINGS.length)]);
      for (const sz of [1, -1]) {
        if (rich)
          awning(
            dt,
            P,
            0,
            spec.groundH * 0.9,
            sz * (D / 2),
            sz > 0 ? 0 : Math.PI,
            W * 0.85,
            aw,
          );
        else {
          const am = P.m
            .clone()
            .multiply(
              new THREE.Matrix4().makeTranslation(
                0,
                spec.groundH * 0.9,
                sz * (D / 2 + 0.09),
              ),
            )
            .multiply(new THREE.Matrix4().makeRotationX(sz * 0.35));
          dt.add(new THREE.BoxGeometry(W * 0.85, 0.015, 0.18), am, null, aw);
        }
      }
      if (rich) {
        // shuttered windows (brick: Mediterranean green / blue), small railed balconies on the top floor
        shutters(
          dt,
          P,
          W,
          D,
          gH,
          spec.floors,
          spec.floorH,
          spec.bay,
          stone ? 0.19 : 0.22,
          C(SHUTTERS[Math.floor(h(4) * SHUTTERS.length)]),
          h,
          false,
        );
        const nb = Math.max(1, Math.round(W / spec.bay));
        const bw = W / nb;
        for (let i = 0; i < nb; i++)
          if (h(90 + i) < 0.5)
            balcony(
              dt,
              P,
              -W / 2 + bw * (i + 0.5),
              gH + (spec.floors - 1) * spec.floorH + 0.01,
              D,
              1,
              bw * 0.8,
              upperTint.clone().multiplyScalar(0.8),
              true,
              DARK_C,
            );
        roofClutter(c, P, W, D, top, h, {
          heaters: 2 + Math.floor(h(65) * 4),
          tanks: Math.floor(h(66) * 3),
          ac: 1 + Math.floor(h(67) * 3),
          dish: h(68) < 0.5,
          antenna: h(69) < 0.5,
          garden: h(70) < 0.4,
          rot: st.rot,
        });
        for (const k of [1, 3])
          wallAc(
            dt,
            P,
            k,
            W,
            D,
            gH,
            spec.floors,
            spec.floorH,
            1 + Math.floor(h(120 + k) * 3),
            h,
            130 + k * 10,
          );
        if (h(150) < 0.7)
          laundry(
            dt,
            P,
            1,
            (h(160) - 0.5) * (D - 0.4),
            gH +
              (1 + Math.floor(h(170) * (spec.floors - 1))) * spec.floorH +
              0.04,
            W,
            D,
            h,
            180,
          );
      } else box(c.trim, P, 0, top, 0, 0.3, 0.16, 0.24, C(0xb4b0a8), 2);
      break;
    }
    case StructureKind.Office: {
      upperTint = C(
        [0xffffff, 0xd8e8f0, 0xe8e4d8, 0xc8d8d0][Math.floor(v * 4)],
      );
      // podium and tower
      facade(
        c.facade.shop,
        P,
        W + 0.16,
        D + 0.16,
        0,
        1,
        gH,
        spec.bay * 2,
        uOff,
        groundTint,
      );
      box(c.trim, P, 0, gH - 0.01, 0, W + 0.22, 0.04, D + 0.22, C(0xb8bcc0), 2);
      facade(
        c.facade.glass,
        P,
        W,
        D,
        gH,
        spec.floors,
        spec.floorH,
        spec.bay,
        uOff + 2,
        upperTint,
      );
      top = gH + spec.floors * spec.floorH;
      flatRoof(c, P, W + 0.02, D + 0.02, top, C(0x6a6e72), C(0x9aa0a6));
      // corner fins
      for (const [sx, sz] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ])
        box(
          c.trim,
          P,
          (sx * W) / 2,
          gH,
          (sz * D) / 2,
          0.05,
          top - gH + 0.05,
          0.05,
          C(0xa8aeb4),
          3,
        );
      // rooftop plant room, a mast and a row of chiller units
      box(c.trim, P, 0, top, -D * 0.18, W * 0.5, 0.16, D * 0.4, C(0x9a9ea2), 2);
      box(dt, P, W * 0.15, top + 0.16, -D * 0.18, 0.02, 0.6, 0.02, C(0xc8ccd0));
      if (rich) {
        for (let i = 0; i < 3; i++)
          acUnit(dt, P, -W * 0.3 + i * 0.13, top, D * 0.3, 0);
        dish(dt, P, -W * 0.38, top, -D * 0.38, 0.8);
      }
      break;
    }
    case StructureKind.Shop: {
      const stone = h(60) < 0.4;
      upperTint = C(
        stone
          ? STONE_TINTS[Math.floor(v * STONE_TINTS.length)]
          : PLASTER_TINTS[Math.floor(v * PLASTER_TINTS.length)],
      );
      const fb = stone ? c.facade.stone : c.facade.panel;
      facade(c.facade.shop, P, W, D, 0, 1, gH, spec.bay * 2, uOff, groundTint, [
        true,
        true,
        false,
        false,
      ]);
      facade(
        fb,
        P,
        W,
        D,
        0,
        1,
        gH,
        spec.bay,
        uOff,
        upperTint.clone().multiplyScalar(0.85),
        [false, false, true, true],
      );
      facade(
        fb,
        P,
        W,
        D,
        gH,
        spec.floors,
        spec.floorH,
        spec.bay,
        uOff + 3,
        upperTint,
      );
      top = gH + spec.floors * spec.floorH;
      flatRoof(
        c,
        P,
        W + 0.04,
        D + 0.04,
        top,
        C(0x5c5a56),
        upperTint.clone().multiplyScalar(0.8),
      );
      // awnings on the two shop fronts and a sign
      const aw = C(AWNINGS[Math.floor(h(4) * AWNINGS.length)]);
      if (rich) {
        awning(dt, P, 0, spec.groundH * 0.9, D / 2, 0, W * 0.9, aw);
        awning(dt, P, W / 2, spec.groundH * 0.9, 0, Math.PI / 2, D * 0.9, aw);
      } else {
        const am1 = P.m
          .clone()
          .multiply(
            new THREE.Matrix4().makeTranslation(
              0,
              spec.groundH * 0.9,
              D / 2 + 0.09,
            ),
          )
          .multiply(new THREE.Matrix4().makeRotationX(0.35));
        dt.add(new THREE.BoxGeometry(W * 0.9, 0.015, 0.18), am1, null, aw);
        const am2 = P.m
          .clone()
          .multiply(
            new THREE.Matrix4().makeTranslation(
              W / 2 + 0.09,
              spec.groundH * 0.9,
              0,
            ),
          )
          .multiply(new THREE.Matrix4().makeRotationZ(-0.35));
        dt.add(new THREE.BoxGeometry(0.18, 0.015, D * 0.9), am2, null, aw);
      }
      box(
        dt,
        P,
        -W * 0.15,
        gH + 0.04,
        D / 2 + 0.02,
        W * 0.45,
        0.09,
        0.03,
        C([0xe8e0c8, 0xd84030, 0x2a5a9a, 0xf0c040][Math.floor(h(5) * 4)]),
      );
      if (rich) {
        shutters(
          dt,
          P,
          W,
          D,
          gH,
          spec.floors,
          spec.floorH,
          spec.bay,
          stone ? 0.19 : 0.3,
          C(SHUTTERS[Math.floor(h(6) * SHUTTERS.length)]),
          h,
          false,
        );
        roofClutter(c, P, W, D, top, h, {
          heaters: 1 + Math.floor(h(65) * 3),
          tanks: Math.floor(h(66) * 2),
          ac: 1 + Math.floor(h(67) * 2),
          dish: h(68) < 0.5,
          antenna: false,
          garden: h(70) < 0.5,
          rot: st.rot,
        });
        wallAc(
          dt,
          P,
          3,
          W,
          D,
          gH,
          spec.floors,
          spec.floorH,
          1 + Math.floor(h(121) * 2),
          h,
          140,
        );
      } else
        box(
          c.trim,
          P,
          (h(30) - 0.5) * W * 0.4,
          top,
          (h(31) - 0.5) * D * 0.3,
          0.3,
          0.16,
          0.24,
          C(0xb4b0a8),
          2,
        );
      break;
    }
    default: {
      // townhouse: pastel plaster or brick, slate mansard roof, chimneys
      const brick = v < 0.5;
      upperTint = C(
        brick
          ? BRICK_TINTS[Math.floor(h(6) * BRICK_TINTS.length)]
          : PLASTER_TINTS[Math.floor(h(6) * PLASTER_TINTS.length)],
      );
      const fb = brick ? c.facade.brick : c.facade.panel;
      facade(
        fb,
        P,
        W,
        D,
        0,
        1,
        gH,
        spec.bay,
        uOff,
        upperTint.clone().multiplyScalar(0.9),
      );
      facade(
        fb,
        P,
        W,
        D,
        gH,
        spec.floors,
        spec.floorH,
        spec.bay,
        uOff + 4,
        upperTint,
      );
      top = gH + spec.floors * spec.floorH;
      box(
        c.trim,
        P,
        0,
        top - 0.03,
        0,
        W + 0.08,
        0.04,
        D + 0.08,
        C(0xe0dace),
        2,
      );
      // mansard: four steep slopes to a small flat top
      const rh = 0.3;
      const k = 0.16;
      const slate = C([0x4a4c52, 0x5a4a44, 0x3e4a4e][Math.floor(h(7) * 3)]);
      const corners = (y: number, e: number) => [
        V(-W / 2 + e, y, D / 2 - e),
        V(W / 2 - e, y, D / 2 - e),
        V(W / 2 - e, y, -D / 2 + e),
        V(-W / 2 + e, y, -D / 2 + e),
      ];
      const lo = corners(top + 0.01, -0.02);
      const hi = corners(top + rh, k);
      for (let s = 0; s < 4; s++) {
        const a = hi[s];
        const b = hi[(s + 1) % 4];
        const cc = lo[s];
        const d = lo[(s + 1) % 4];
        const n = new THREE.Vector3()
          .subVectors(b, a)
          .cross(new THREE.Vector3().subVectors(cc, a))
          .normalize()
          .negate();
        const N = P.n(n.x, n.y, n.z);
        const len = a.distanceTo(b) * 3;
        const ia = c.slate.vert(P.p(a.x, a.y, a.z), N, 0, 1.4, slate);
        const ib = c.slate.vert(P.p(b.x, b.y, b.z), N, len, 1.4, slate);
        const ic = c.slate.vert(P.p(cc.x, cc.y, cc.z), N, 0, 0, slate);
        const id = c.slate.vert(P.p(d.x, d.y, d.z), N, len, 0, slate);
        c.slate.quad(ia, ib, ic, id);
      }
      box(
        c.slate,
        P,
        0,
        top + rh - 0.01,
        0,
        W - 2 * k,
        0.02,
        D - 2 * k,
        slate.clone().multiplyScalar(0.8),
        2,
      );
      // dormers on the front slope
      for (const sx of [-0.3, 0.3])
        box(
          c.slate,
          P,
          sx * W,
          top + 0.05,
          D / 2 - 0.12,
          0.16,
          0.16,
          0.12,
          upperTint.clone().multiplyScalar(0.9),
          2,
        );
      for (const sx of [-1, 1])
        box(
          c.trim,
          P,
          sx * (W / 2 - 0.12),
          top + rh - 0.05,
          0,
          0.1,
          0.22,
          0.14,
          C(0x9a6a58),
          2,
        );
      // door and steps
      box(
        dt,
        P,
        0,
        0.04,
        D / 2 + 0.005,
        0.14,
        0.26,
        0.02,
        C([0x2a3a5a, 0x5a2a2a, 0x2a4a3a, 0x222222][Math.floor(h(8) * 4)]),
      );
      box(c.trim, P, 0, 0.0, D / 2 + 0.06, 0.24, 0.07, 0.12, C(0xc8c0b0), 2);
      if (rich) {
        // painted shutters, French balconies on the first floor, window boxes with flowers
        const shC = C(SHUTTERS[Math.floor(h(9) * SHUTTERS.length)]);
        shutters(dt, P, W, D, 0, 1, gH, spec.bay, 0.22, shC, h, true);
        shutters(
          dt,
          P,
          W,
          D,
          gH,
          spec.floors,
          spec.floorH,
          spec.bay,
          0.22,
          shC,
          h,
          false,
        );
        const nb = Math.max(1, Math.round(W / spec.bay));
        const bw = W / nb;
        for (let i = 0; i < nb; i++) {
          const x = -W / 2 + bw * (i + 0.5);
          if (h(220 + i) < 0.5)
            put(
              dt,
              P,
              UNIT_BOX,
              x,
              gH + 0.09,
              D / 2 + 0.03,
              bw * 0.5,
              0.05,
              0.004,
              DARK_C,
            );
          else if (h(230 + i) < 0.6) {
            put(
              dt,
              P,
              UNIT_BOX,
              x,
              gH + spec.floorH + 0.07,
              D / 2 + 0.025,
              bw * 0.48,
              0.03,
              0.04,
              C(0x8a5a3a),
            );
            put(
              dt,
              P,
              UNIT_BALL,
              x,
              gH + spec.floorH + 0.095,
              D / 2 + 0.03,
              bw * 0.24,
              0.025,
              0.025,
              C([0xd83a4a, 0xe8c040, 0xc85aa8][Math.floor(h(240 + i) * 3)]),
            );
          }
        }
        if (h(150) < 0.6)
          laundry(
            dt,
            P,
            2,
            (h(160) - 0.5) * (W - 0.4),
            gH + 0.04,
            W,
            D,
            h,
            180,
          );
      }
      top += rh;
      break;
    }
  }
  void top;
}

/** A tiny tilted wall stub of a ruin (brick look). */
function ruinWall(c: Chunk, P: Place, len: number, hgt: number, seed: number) {
  // plain trim material: a ruin has no windows to light up at night
  const b = c.trim;
  const n = 4;
  const col = C(0x8a5e4c);
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
export function buildCity(
  m: GameMap,
  fog: FogOfWar,
  quality: "low" | "medium" | "high",
  sink?: { houses: HouseHandle[] },
  lod?: SceneryLod,
): THREE.Object3D[] {
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
  const avoidAlley = (x: number, y: number) => {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return true;
    const t = m.tiles[ty * m.w + tx];
    return t === Tile.Water || t === Tile.Bridge;
  };
  const spans: { st: Structure; c: Chunk; from: number[]; to: number[] }[] = [];
  // washing strung across the narrow alleys between neighbouring buildings (wall to wall)
  // (part of building i's vertex ranges, so the lines go down with it)
  const alleys = (i: number, det: GeoBuilder) => {
    if (quality === "low") return;
    for (let j = 0; j < city.length; j++) {
      if (i === j) continue;
      const p = city[i];
      const q = city[j];
      const ip = SPECS[p.kind]!.inset;
      const iq = SPECS[q.kind]!.inset;
      for (const axis of [0, 1]) {
        // q lies past p's far edge along the axis
        const pe = axis === 0 ? p.x + p.w : p.y + p.h;
        const qs = axis === 0 ? q.x : q.y;
        const gap = qs - pe;
        if (gap < 0 || gap > 2) continue;
        const o0 =
          Math.max(axis === 0 ? p.y : p.x, axis === 0 ? q.y : q.x) + 0.35;
        const o1 =
          Math.min(
            axis === 0 ? p.y + p.h : p.x + p.w,
            axis === 0 ? q.y + q.h : q.x + q.w,
          ) - 0.35;
        if (o1 - o0 < 0.3) continue;
        const a0 = pe - ip;
        const a1 = qs + iq;
        if (a1 - a0 < 0.25) continue;
        const nLines =
          hash2(i * 31 + j, axis, 1951) < 0.55
            ? 1 + Math.floor(hash2(i, j, 1952) * 2)
            : 0;
        for (let k = 0; k < nLines; k++) {
          const o =
            o0 +
            (o1 - o0) *
              (nLines === 1 ? hash2(i, j + k, 1953) : k / (nLines - 1));
          const mid = (a0 + a1) / 2;
          const wx = axis === 0 ? mid : o;
          const wz = axis === 0 ? o : mid;
          if (avoidAlley(wx, wz)) continue;
          const gy = surfaceHeight(m, wx, wz) - 0.06;
          const y =
            gy +
            Math.min(cityHeight(p.kind), cityHeight(q.kind)) *
              (0.35 + hash2(i, j + k, 1954) * 0.3);
          const len = a1 - a0;
          const ry = axis === 0 ? 0 : -Math.PI / 2;
          const M = new THREE.Matrix4().compose(
            V(wx, y, wz),
            new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), ry),
            V(1, 1, 1),
          );
          det.add(
            UNIT_BOX,
            M.clone().multiply(
              new THREE.Matrix4().makeScale(len, 0.004, 0.004),
            ),
            null,
            C(0xd8d8d0),
          );
          const n = Math.max(2, Math.floor(len / 0.12));
          for (let c2 = 0; c2 < n; c2++) {
            if (hash2(i * 7 + c2, j + k, 1955) < 0.25) continue;
            const cw = 0.04 + hash2(c2, i + k, 1956) * 0.04;
            const ch = 0.04 + hash2(c2, j + k, 1957) * 0.06;
            const lx = -len / 2 + (len * (c2 + 0.5)) / n;
            det.add(
              UNIT_BOX,
              M.clone().multiply(
                new THREE.Matrix4().compose(
                  V(
                    lx,
                    -ch / 2 -
                      0.004 -
                      Math.sin(((c2 + 0.5) / n) * Math.PI) * 0.02,
                    0,
                  ),
                  new THREE.Quaternion(),
                  V(cw, ch, 0.003),
                ),
              ),
              null,
              C(
                CLOTHES[
                  Math.floor(hash2(c2, i * 3 + j, 1958) * CLOTHES.length)
                ],
              ),
            );
          }
        }
      }
    }
  };
  city.forEach((st, i) => {
    const c = chunkOf(st.x + st.w / 2, st.y + st.h / 2);
    const bs = chunkBuilders(c);
    const from = bs.map((b) => b.count);
    buildOne(m, st, c, i * 17, quality !== "low");
    alleys(i, c.detail);
    spans.push({ st, c, from, to: bs.map((b) => b.count) });
  });

  // ruins on the rubble lots: wall stubs and a burnt-out corner, kept off ore, oil and tech sites
  const avoid = (x: number, y: number) => {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return true;
    const i = ty * m.w + tx;
    if (
      m.ore[i] ||
      m.oreKind[i] ||
      m.blocked[i] ||
      m.trees[i] ||
      m.tiles[i] === Tile.Water ||
      m.tiles[i] === Tile.Bridge
    )
      return true;
    for (const mm of m.oreMines)
      if (Math.hypot(x - mm.x - 0.5, y - mm.y - 0.5) < 5) return true;
    for (const o of m.oils)
      if (x > o.x - 1.5 && x < o.x + 3.5 && y > o.y - 1.5 && y < o.y + 3.5)
        return true;
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
      const P = new Place(
        x,
        surfaceHeight(m, x, y) - 0.03,
        y,
        Math.floor(hash2(li, k, 83) * 4),
      );
      ruinWall(
        c,
        P,
        0.9 + hash2(li, k, 84) * 0.6,
        0.25 + hash2(li, k, 85) * 0.35,
        li * 31 + k,
      );
    }
  });

  // meshes per chunk and material
  const built = new Map<GeoBuilder, THREE.Mesh>();
  const shadows = quality !== "low";
  const detailMeshes: THREE.Mesh[] = [];
  for (const c of chunks.values()) {
    const pairs: [GeoBuilder, THREE.Material, boolean, string][] = [
      [c.facade.panel, mats.facade.panel, shadows, "city-facade"],
      [c.facade.brick, mats.facade.brick, shadows, "city-facade"],
      [c.facade.glass, mats.facade.glass, shadows, "city-facade"],
      [c.facade.shop, mats.facade.shop, shadows, "city-facade"],
      [c.facade.stone, mats.facade.stone, shadows, "city-facade"],
      [c.trim, mats.trim, shadows, "city-trim"],
      [c.slate, mats.slate, shadows, "city-roof"],
      [c.detail, mats.detail, false, "city-detail"],
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
  if (lod && detailMeshes.length)
    for (const dm of detailMeshes)
      lod.add(
        [dm],
        dm.geometry,
        null,
        Infinity,
        quality === "high" ? 34 : quality === "medium" ? 26 : 20,
      );
  if (sink)
    for (const sp of spans) {
      const st = sp.st;
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
      const ranges: HouseHandle["ranges"] = [];
      chunkBuilders(sp.c).forEach((b, k) => {
        const mesh = built.get(b);
        if (mesh && sp.to[k] > sp.from[k])
          ranges.push({ mesh, start: sp.from[k], end: sp.to[k] });
      });
      sink.houses.push({ st, cx, cz, gy, ranges });
    }

  // ---- street lamps along the avenues (instanced; the heads glow after dark)
  const lampPts: { x: number; z: number; rot: number }[] = [];
  const gap = quality === "low" ? 7 : 5;
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
        if (
          tx < 0 ||
          ty < 0 ||
          tx >= m.w ||
          ty >= m.h ||
          m.blocked[ty * m.w + tx] ||
          m.trees[ty * m.w + tx]
        )
          continue;
        if (m.starts.some((p) => Math.hypot(p.x + 0.5 - x, p.y + 0.5 - y) < 12))
          continue;
        if (
          m.tiles[ty * m.w + tx] === Tile.Water ||
          m.tiles[ty * m.w + tx] === Tile.Bridge
        )
          continue;
        // not inside a crossing
        let crossing = false;
        m.roads.forEach((q, j) => {
          if (j === i || !deco?.roadStyles[j]?.straight || q.length !== 2)
            return;
          const vert = q[0].x === q[1].x;
          if (
            vert
              ? Math.abs(x - (q[0].x + 0.5)) < 2.2 &&
                y > Math.min(q[0].y, q[1].y) &&
                y < Math.max(q[0].y, q[1].y) + 1
              : Math.abs(y - (q[0].y + 0.5)) < 2.2 &&
                x > Math.min(q[0].x, q[1].x) &&
                x < Math.max(q[0].x, q[1].x) + 1
          )
            crossing = true;
        });
        if (crossing) continue;
        lampPts.push({ x, z: y, rot: Math.atan2(-side * dx, -side * dy) });
      }
    }
  });
  if (lampPts.length) {
    const post = new GeoBuilder();
    post.add(
      new THREE.CylinderGeometry(0.012, 0.018, 0.7, 6).translate(0, 0.35, 0),
      new THREE.Matrix4(),
      null,
      C(0x3a3c40),
    );
    post.add(
      new THREE.BoxGeometry(0.012, 0.012, 0.16).translate(0, 0.69, 0.07),
      new THREE.Matrix4(),
      null,
      C(0x3a3c40),
    );
    const head = new THREE.BoxGeometry(0.06, 0.02, 0.09).translate(
      0,
      0.675,
      0.14,
    );
    const postMat = fog.apply(
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.5,
        metalness: 0.6,
      }),
    );
    const headMat = fog.apply(
      new THREE.MeshStandardMaterial({
        color: 0x5a5a58,
        emissive: 0xffc070,
        emissiveIntensity: 0,
        roughness: 0.4,
      }),
    );
    const posts = new THREE.InstancedMesh(
      post.build(),
      postMat,
      lampPts.length,
    );
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
    posts.castShadow = quality === "high";
    posts.name = heads.name = "city-lamps";
    // the heads light up with the windows
    heads.onBeforeRender = () => {
      headMat.emissiveIntensity = CITY_NIGHT.value * 3;
    };
    out.push(posts, heads);
    if (lod)
      for (const im of [posts, heads])
        lod.add(
          [im],
          im.geometry,
          null,
          Infinity,
          quality === "high" ? 40 : 30,
        );
  }

  // ---- fountains on the city squares (not the base plazas)
  const fb = new GeoBuilder();
  for (const p of deco?.plazas ?? []) {
    const x = (p.x0 + p.x1) / 2;
    const y = (p.y0 + p.y1) / 2;
    if (m.starts.some((s) => Math.hypot(s.x + 0.5 - x, s.y + 0.5 - y) < 16))
      continue;
    const gy = surfaceHeight(m, x, y);
    const mt = new THREE.Matrix4().makeTranslation(x, gy, y);
    fb.add(
      new THREE.CylinderGeometry(0.62, 0.66, 0.12, 20, 1, true).translate(
        0,
        0.06,
        0,
      ),
      mt,
      null,
      C(0xb8b0a0),
    );
    fb.add(
      new THREE.RingGeometry(0.56, 0.66, 20)
        .rotateX(-Math.PI / 2)
        .translate(0, 0.12, 0),
      mt,
      null,
      C(0xc8c0b0),
    );
    fb.add(
      new THREE.CircleGeometry(0.58, 20)
        .rotateX(-Math.PI / 2)
        .translate(0, 0.08, 0),
      mt,
      null,
      C(0x3a5a64),
    );
    fb.add(
      new THREE.CylinderGeometry(0.06, 0.1, 0.42, 10).translate(0, 0.21, 0),
      mt,
      null,
      C(0xb8b0a0),
    );
    fb.add(
      new THREE.CylinderGeometry(0.2, 0.12, 0.05, 14).translate(0, 0.42, 0),
      mt,
      null,
      C(0xc8c0b0),
    );
  }
  if (fb.count) {
    const mesh = new THREE.Mesh(
      fb.build(),
      fog.apply(
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.55,
          metalness: 0.05,
          side: THREE.DoubleSide,
        }),
      ),
    );
    mesh.receiveShadow = true;
    mesh.castShadow = shadows;
    mesh.name = "city-fountains";
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
    const fw =
      kind === StructureKind.Shop || kind === StructureKind.Townhouse ? 2 : 3;
    const fd =
      kind === StructureKind.Apartment || kind === StructureKind.Office ? 3 : 2;
    const nightLights = [
      {
        pos: V(0, spec.groundH * 0.8, fd / 2 - spec.inset + 0.08),
        color: 0xffd090,
        intensity: 0.85,
      },
      {
        pos: V(0, spec.groundH * 0.8, -fd / 2 + spec.inset - 0.08),
        color: 0xffd090,
        intensity: 0.6,
      },
      {
        pos: V(fw / 2 - spec.inset - 0.1, H + 0.05, fd / 2 - spec.inset - 0.1),
        color: kind === StructureKind.Office ? 0xff3020 : 0xffe0b0,
        intensity: 0.5,
      },
    ];
    const extra: Partial<Model> = { nightLights };
    if (style.faction === "neutral")
      return {
        root,
        muzzles: [],
        height: H + 0.15,
        size: { x: 0.01, y: H, z: 0.01 },
        glow: [],
        emitters: [],
        ...extra,
      };
    // owner flag on the roof
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, 0.6, 6),
      new THREE.MeshStandardMaterial({
        color: 0x9a9ea2,
        roughness: 0.5,
        metalness: 0.6,
      }),
    );
    if (fog) fog.apply(pole.material as THREE.Material);
    pole.position.set(0, H + 0.3, 0);
    pole.castShadow = true;
    root.add(pole);
    const cloth = new THREE.PlaneGeometry(0.4, 0.24, 6, 1).translate(0.2, 0, 0);
    const cols: number[] = [];
    const pos = cloth.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const yy = pos.getY(i);
      const cc = C(
        yy > 0.04 ? style.flag[0] : yy < -0.04 ? style.flag[2] : style.flag[1],
      );
      cols.push(cc.r, cc.g, cc.b);
    }
    cloth.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    const key = fog ? "f" : "n";
    let fm = flagMat.get(key);
    if (!fm) {
      fm = new THREE.MeshStandardMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        roughness: 0.9,
      });
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
    const bandMat = new THREE.MeshStandardMaterial({
      color: style.team,
      emissive: style.team,
      emissiveIntensity: 0.3,
      roughness: 0.6,
    });
    if (fog) fog.apply(bandMat);
    for (const [w, d, x, zz] of [
      [bw, 0.035, 0, bd / 2],
      [bw, 0.035, 0, -bd / 2],
      [0.035, bd, bw / 2, 0],
      [0.035, bd, -bw / 2, 0],
    ]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, d), bandMat);
      rail.position.set(x, by, zz);
      root.add(rail);
    }
    const anim = (s: { time: number }) => {
      const a = cloth.attributes.position.array as Float32Array;
      for (let i = 0; i < pos.count; i++)
        a[i * 3 + 2] =
          Math.sin(s.time * 5 - base[i * 3] * 14) * 0.03 * (base[i * 3] / 0.4);
      cloth.attributes.position.needsUpdate = true;
    };
    return {
      root,
      muzzles: [],
      height: H + 0.15,
      size: { x: 0.01, y: H, z: 0.01 },
      glow: [],
      emitters: [],
      anim,
      ...extra,
    };
  };
}

export const CITY_MODELS: Record<string, Builder> = {
  civ_city_apartment: cityModel(StructureKind.Apartment),
  civ_city_block: cityModel(StructureKind.Block),
  civ_city_office: cityModel(StructureKind.Office),
  civ_city_shop: cityModel(StructureKind.Shop),
  civ_city_townhouse: cityModel(StructureKind.Townhouse),
};
