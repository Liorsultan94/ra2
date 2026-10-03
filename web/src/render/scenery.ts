import * as THREE from 'three';
import { BRIDGE_HEIGHT, StructureKind, Tile, type GameMap, type Structure } from '../sim/map';
import { hash2 } from '../sim/rng';
import type { FogOfWar } from './fog';
import { GeoBuilder, chunkedInstances, type Inst, type SceneryLod } from './geo';
import { surfaceHeight } from './ground';
import { FieldType, type Layout } from './layout';
import { buildingTextures, roadTexture } from './terraintex';
import { biomeLook } from './biome';
import { buildCity, isCityKind } from './models/citybldgs';
import { appendLoopRibbons } from './ambient/roadfurniture';
import { snowLine } from './props';

/*
 * Man-made scenery: paved roads (terrain-hugging ribbons), bridges, village
 * houses and farm buildings, fences, power lines and wrecked cars. Static
 * geometry is merged per material so the whole countryside costs a handful
 * of draw calls.
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Overwrite UVs with a box projection of world positions (1 repeat per `1/scale`). */
function boxUV(b: GeoBuilder, from: number, scale: number) {
  for (let i = from; i < b.count; i++) {
    const x = b.pos[i * 3];
    const y = b.pos[i * 3 + 1];
    const z = b.pos[i * 3 + 2];
    const nx = Math.abs(b.nor[i * 3]);
    const ny = Math.abs(b.nor[i * 3 + 1]);
    const nz = Math.abs(b.nor[i * 3 + 2]);
    const [u, v] = ny >= nx && ny >= nz ? [x, z] : nx >= nz ? [z, y] : [x, y];
    b.uv[i * 2] = u * scale;
    b.uv[i * 2 + 1] = v * scale;
  }
}

function boxAt(b: GeoBuilder, w: number, h: number, d: number, m: THREE.Matrix4, c: THREE.Color | number) {
  b.add(new THREE.BoxGeometry(w, h, d).toNonIndexed(), m, null, c);
}

function trs(x: number, y: number, z: number, ry = 0, rx = 0, rz = 0) {
  return new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), V(1, 1, 1));
}

/** Thin beam between two points. */
function beam(b: GeoBuilder, a: THREE.Vector3, c: THREE.Vector3, t: number, col: THREE.Color | number) {
  const len = a.distanceTo(c);
  const g = new THREE.BoxGeometry(t, len, t).toNonIndexed();
  const mid = a.clone().add(c).multiplyScalar(0.5);
  const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), c.clone().sub(a).normalize());
  b.add(g, new THREE.Matrix4().compose(mid, q, V(1, 1, 1)), null, col);
}

/** One civilian structure's slice of the merged scenery meshes (vertex ranges per mesh). */
export interface HouseHandle {
  st: Structure;
  cx: number;
  cz: number;
  /** Ground height under the footprint (the structure's base). */
  gy: number;
  ranges: { mesh: THREE.Mesh; start: number; end: number }[];
}

/** Handles for render-side environment damage (src/render/envdamage.ts). */
export interface SceneryHandles {
  houses: HouseHandle[];
  /** Fence posts / rails (origin of a post at its foot, of a rail at its centre). */
  posts: THREE.InstancedMesh[];
  rails: THREE.InstancedMesh[];
}

export function buildScenery(m: GameMap, layout: Layout, fog: FogOfWar, quality: 'low' | 'medium' | 'high', sink?: SceneryHandles, lod?: SceneryLod): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const shadows = quality !== 'low';
  const tex = buildingTextures(quality === 'low' ? 128 : 256);

  // ------------------------------------------------------------- roads
  const roadTex = roadTexture(quality === 'high' ? 256 : 128);
  const look = biomeLook(m);
  const bc = look.code;
  const roadBase = new THREE.MeshStandardMaterial({ map: roadTex, alphaTest: 0.5, roughness: 0.9, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  if (bc === 1 || bc === 2) {
    // desert: drifting sand over sun-bleached asphalt; winter: compacted snow with dark tyre ruts
    roadBase.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          float uL = fract( vMapUv.x * 2.0 );
          vec3 rwp = vFogP;
          float rn = texture2D( fogNoise, rwp.xz * 0.21 ).r * 0.6 + texture2D( fogNoise, rwp.xz * 0.9 ).g * 0.4;
          float edgeK = 1.0 - smoothstep( 0.08, 0.3, min( uL, 1.0 - uL ) );
          #if ROAD_BIOME == 1
            diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 1.25, 1.12, 0.95 ), 0.6 );
            float sandK = smoothstep( 0.5, 0.75, rn + edgeK * 0.45 );
            diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.66, 0.53, 0.36 ) * ( 0.88 + rn * 0.2 ), sandK * 0.9 );
          #else
            float rut = exp( -pow( ( abs( uL - 0.5 ) - 0.26 ) / 0.07, 2.0 ) );
            float snowK = clamp( 0.38 + edgeK * 0.8 - rut * ( 0.6 + rn * 0.3 ) + ( rn - 0.5 ) * 0.45, 0.0, 1.0 );
            vec3 slush = diffuseColor.rgb * vec3( 0.62, 0.65, 0.7 );
            diffuseColor.rgb = mix( slush, vec3( 0.78, 0.82, 0.88 ) * ( 0.92 + rn * 0.12 ), snowK );
          #endif
        }`,
      );
    };
    roadBase.defines = { ...roadBase.defines, ROAD_BIOME: bc, ...(bc === 2 ? { WX_SNOW_K: '0.12' } : {}) };
  }
  const roadMat = fog.apply(roadBase);
  if (bc === 1 || bc === 2) roadMat.customProgramCacheKey = () => 'fog2-road-b' + bc;
  const rb = new GeoBuilder();
  const bridgeEnds = m.bridges.flatMap((br) => {
    const h = br.length / 2;
    return [V(br.x - h * Math.SQRT1_2, 0, br.y + h * Math.SQRT1_2), V(br.x + h * Math.SQRT1_2, 0, br.y - h * Math.SQRT1_2)];
  });
  for (const r of layout.roads) {
    if (r.painted) continue; // city streets: drawn by the ground shader
    const n = r.pts.length;
    const across = [-1, -0.5, 0, 0.5, 1];
    const u0 = r.variant === 0 ? 0.005 : 0.505;
    let s = 0;
    const rows: number[][] = [];
    for (let i = 0; i < n; i++) {
      const p = r.pts[i];
      if (i > 0) s += Math.hypot(p.x - r.pts[i - 1].x, p.y - r.pts[i - 1].y);
      const a = r.pts[Math.max(0, i - 1)];
      const c = r.pts[Math.min(n - 1, i + 1)];
      const L = Math.hypot(c.x - a.x, c.y - a.y) || 1;
      const nx = -(c.y - a.y) / L;
      const ny = (c.x - a.x) / L;
      // ramp up onto bridge decks
      let lift = 0;
      for (const e of bridgeEnds) {
        const d = Math.hypot(p.x - e.x, p.y - e.z);
        if (d < 2.2) lift = Math.max(lift, 1 - d / 2.2);
      }
      const row: number[] = [];
      for (const o of across) {
        const x = p.x + nx * o * (r.width / 2);
        const z = p.y + ny * o * (r.width / 2);
        const g = surfaceHeight(m, x, z);
        const h = Math.max(g + 0.03, lift > 0 ? g + (BRIDGE_HEIGHT + 0.01 - g) * Math.min(1, lift * 1.15) : -9);
        row.push(rb.vert(V(x, h, z), V(0, 1, 0), u0 + 0.49 * ((o + 1) / 2), s / 6, 1));
      }
      rows.push(row);
    }
    for (let i = 0; i < rows.length - 1; i++) for (let k = 0; k < across.length - 1; k++) rb.quad(rows[i][k], rows[i + 1][k], rows[i][k + 1], rows[i + 1][k + 1]);
  }
  // roundabout / turning-circle rings: road pieces in the same mesh (ambient/roadfurniture.ts)
  appendLoopRibbons(rb, m, layout.roads);
  const roadGeo = rb.build();
  roadGeo.computeVertexNormals();
  const roads = new THREE.Mesh(roadGeo, roadMat);
  roads.receiveShadow = true;
  roads.name = 'roads';
  out.push(roads);

  // bridges: built and animated per span by render/bridgefx.ts (collapse / rebuild)

  // ------------------------------------------------------------ buildings
  const walls = new GeoBuilder();
  const roofs = new GeoBuilder();
  const trim = new GeoBuilder();
  const wood = new GeoBuilder();
  const metal = new GeoBuilder();
  // desert: sun-baked plaster and mudbrick; winter: painted log houses (falu red, ochre, tar brown) with dark roofs
  const wallColors = bc === 1 ? [0xd8b98c, 0xe2c9a0, 0xc9a378, 0xe8d6b4, 0xcfae84, 0xbf9a70] : bc === 2 ? [0x8a2e22, 0x9a3a28, 0xb08840, 0x5a3e2a, 0x6a7a84, 0x7a2a22] : [0xe8dcc0, 0xf0ece2, 0xe2c99a, 0xd8d2c4, 0xe6b89a, 0xc9c2a8, 0xf2e2b8];
  const roofColors = bc === 2 ? [0x3a3a3c, 0x2e3a30, 0x4a3a30, 0x34383e] : [0xa04a30, 0x8a3c28, 0xb0603a, 0x5a5652, 0x6e3a2c, 0x8f5a3a];
  const builders = [walls, roofs, trim, wood, metal];
  const spans: { st: Structure; from: number[]; to: number[] }[] = [];
  for (const st of m.structures) {
    if (isCityKind(st.kind)) continue; // city blocks: models/citybldgs.ts
    const from = builders.map((b) => b.count);
    buildStructure(st);
    spans.push({ st, from, to: builders.map((b) => b.count) });
  }

  function buildStructure(st: Structure) {
    const cx = st.x + st.w / 2;
    const cz = st.y + st.h / 2;
    let gmin = 99;
    for (const [x, z] of [
      [st.x, st.y],
      [st.x + st.w, st.y],
      [st.x, st.y + st.h],
      [st.x + st.w, st.y + st.h],
      [cx, cz],
    ])
      gmin = Math.min(gmin, surfaceHeight(m, x, z));
    const base = new THREE.Matrix4().compose(V(cx, gmin, cz), new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), (st.rot * Math.PI) / 2), V(1, 1, 1));
    const L = (lm: THREE.Matrix4) => base.clone().multiply(lm);
    const h = (k: number) => hash2(st.x * 7 + k, st.y * 13, 911);
    const wallC = new THREE.Color(wallColors[Math.floor(h(1) * wallColors.length)]);
    const roofC = new THREE.Color(roofColors[Math.floor(h(2) * roofColors.length)]);
    const glass = new THREE.Color(0.12, 0.15, 0.18);
    const frame = new THREE.Color(0.9, 0.9, 0.86);
    const shutter = [new THREE.Color(0.25, 0.38, 0.28), new THREE.Color(0.42, 0.27, 0.18), new THREE.Color(0.3, 0.36, 0.5)][Math.floor(h(3) * 3)];

    /** Gabled house body: length lx (local x), depth dz, wall height hw, roof pitch. */
    const house = (lx: number, dz: number, hw: number, pitch: number, wb: GeoBuilder, wcol: THREE.Color, rcol: THREE.Color, wallScale: number) => {
      const w0 = wb.count;
      boxAt(wb, lx, hw + 0.3, dz, L(trs(0, (hw - 0.3) / 2, 0)), wcol);
      // gable triangles
      const rise = (dz / 2) * Math.tan(pitch);
      for (const sx of [-1, 1]) {
        const n = V(sx, 0, 0).transformDirection(base);
        const pts = [V((sx * lx) / 2, hw, -dz / 2), V((sx * lx) / 2, hw, dz / 2), V((sx * lx) / 2, hw + rise, 0)].map((p) => p.applyMatrix4(base));
        const ids = pts.map((p) => wb.vert(p, n, 0, 0, wcol));
        if (sx > 0) wb.tri(ids[0], ids[2], ids[1]);
        else wb.tri(ids[0], ids[1], ids[2]);
      }
      boxUV(wb, w0, wallScale);
      // roof: two slopes with overhang, slight thickness
      const ov = 0.07;
      for (const sz of [-1, 1]) {
        const eaveY = hw - ov * Math.tan(pitch);
        const ez = sz * (dz / 2 + ov);
        const n = V(0, Math.cos(pitch), sz * Math.sin(pitch)).transformDirection(base);
        const p = [V(-lx / 2 - ov, eaveY, ez), V(lx / 2 + ov, eaveY, ez), V(-lx / 2 - ov, hw + rise + 0.01, 0), V(lx / 2 + ov, hw + rise + 0.01, 0)].map((q) => q.applyMatrix4(base));
        const slopeLen = Math.hypot(dz / 2 + ov, rise + ov * Math.tan(pitch));
        const ids = p.map((q, k) => roofs.vert(q, n, (k % 2 ? lx + 2 * ov : 0) * 1.6, k < 2 ? 0 : slopeLen * 1.6, rcol));
        if (sz > 0) roofs.quad(ids[2], ids[3], ids[0], ids[1]);
        else roofs.quad(ids[0], ids[1], ids[2], ids[3]);
        // fascia board
        boxAt(trim, lx + 2 * ov, 0.03, 0.02, L(trs(0, eaveY - 0.012, ez)), new THREE.Color(0.32, 0.26, 0.2));
      }
      return rise;
    };
    /** Windows on the long walls (front = +z) and a door. */
    const windows = (lx: number, dz: number, hw: number, floors: number, door: boolean) => {
      const nx = Math.max(1, Math.floor(lx / 0.32));
      for (let f = 0; f < floors; f++) {
        const wy = floors === 1 ? hw * 0.55 : hw * (0.3 + f * 0.42);
        for (let i = 0; i < nx; i++) {
          const x = -lx / 2 + (lx / nx) * (i + 0.5);
          for (const sz of [-1, 1]) {
            if (door && sz > 0 && f === 0 && i === Math.floor(nx / 2)) continue;
            const z = sz * (dz / 2 + 0.006);
            boxAt(trim, 0.15, 0.19, 0.02, L(trs(x, wy, z)), frame);
            boxAt(trim, 0.11, 0.15, 0.03, L(trs(x, wy, z)), glass);
            if (h(10 + i) < 0.5) for (const so of [-1, 1]) boxAt(wood, 0.05, 0.18, 0.02, L(trs(x + so * 0.11, wy, z + sz * 0.004)), shutter);
          }
        }
      }
      if (door) {
        boxAt(wood, 0.13, 0.26, 0.03, L(trs(0, 0.13, dz / 2 + 0.01)), new THREE.Color(0.38, 0.25, 0.16));
        boxAt(trim, 0.2, 0.02, 0.08, L(trs(0, 0.28, dz / 2 + 0.04)), frame);
      }
    };

    /** Desert flat-roofed house: plaster box, parapet, deep small windows, roof clutter. */
    const flatHouse = (lx: number, dz: number, hw: number, ox: number, oz: number, door: boolean) => {
      const w0 = walls.count;
      boxAt(walls, lx, hw, dz, L(trs(ox, hw / 2, oz)), wallC);
      const pt = 0.05;
      const ph = 0.08;
      boxAt(walls, lx, ph, pt, L(trs(ox, hw + ph / 2, oz + dz / 2 - pt / 2)), wallC);
      boxAt(walls, lx, ph, pt, L(trs(ox, hw + ph / 2, oz - dz / 2 + pt / 2)), wallC);
      boxAt(walls, pt, ph, dz, L(trs(ox + lx / 2 - pt / 2, hw + ph / 2, oz)), wallC);
      boxAt(walls, pt, ph, dz, L(trs(ox - lx / 2 + pt / 2, hw + ph / 2, oz)), wallC);
      boxUV(walls, w0, 1.1);
      boxAt(trim, lx - 0.1, 0.012, dz - 0.1, L(trs(ox, hw + 0.006, oz)), wallC.clone().multiplyScalar(0.72));
      const nx = Math.max(1, Math.floor(lx / 0.38));
      const floors = hw > 0.55 ? 2 : 1;
      for (let f = 0; f < floors; f++) {
        const wy = floors === 1 ? hw * 0.6 : hw * (0.3 + f * 0.42);
        for (let i = 0; i < nx; i++) {
          const x = ox - lx / 2 + (lx / nx) * (i + 0.5);
          for (const sz of [-1, 1]) {
            if (door && sz > 0 && f === 0 && i === Math.floor(nx / 2)) continue;
            const z = oz + sz * (dz / 2 + 0.004);
            boxAt(trim, 0.1, 0.13, 0.02, L(trs(x, wy, z)), new THREE.Color(0.08, 0.07, 0.06));
            if (h(20 + i + f) < 0.45) boxAt(wood, 0.12, 0.03, 0.03, L(trs(x, wy + 0.08, z + sz * 0.01)), new THREE.Color(0.36, 0.26, 0.17));
          }
        }
      }
      if (door) {
        boxAt(wood, 0.13, 0.25, 0.03, L(trs(ox, 0.125, oz + dz / 2 + 0.01)), [new THREE.Color(0.24, 0.36, 0.5), new THREE.Color(0.42, 0.28, 0.16), new THREE.Color(0.2, 0.42, 0.36)][Math.floor(h(7) * 3)]);
        // striped cloth awning over the door
        const aw = [new THREE.Color(0.7, 0.22, 0.16), new THREE.Color(0.2, 0.36, 0.58), new THREE.Color(0.75, 0.62, 0.3)][Math.floor(h(8) * 3)];
        if (h(9) < 0.6) boxAt(wood, 0.34, 0.015, 0.14, L(trs(ox, 0.31, oz + dz / 2 + 0.07).multiply(new THREE.Matrix4().makeRotationX(0.25))), aw);
      }
      // roof clutter: water tank, satellite dish, a stair head
      if (h(10) < 0.75) {
        metal.add(new THREE.CylinderGeometry(0.07, 0.07, 0.14, 10).toNonIndexed(), L(trs(ox + lx * 0.25, hw + 0.09, oz - dz * 0.2)), null, h(11) < 0.5 ? new THREE.Color(0.85, 0.85, 0.82) : new THREE.Color(0.12, 0.12, 0.13));
      }
      if (h(12) < 0.5) metal.add(new THREE.CylinderGeometry(0.06, 0.02, 0.025, 10).toNonIndexed(), L(trs(ox - lx * 0.3, hw + 0.08, oz + dz * 0.25, 0, 0.6)), null, new THREE.Color(0.86, 0.86, 0.84));
      if (h(13) < 0.4) boxAt(walls, 0.2, 0.16, 0.2, L(trs(ox - lx * 0.28, hw + 0.08, oz - dz * 0.22)), wallC.clone().multiplyScalar(0.95));
    };

    if (bc === 1 && (st.kind === StructureKind.House || st.kind === StructureKind.Cottage || st.kind === StructureKind.MudHouse)) {
      // desert village house: two storeys or one, flat roof
      const tall = st.kind !== StructureKind.Cottage && h(14) < 0.6;
      flatHouse(1.35, 1.1, tall ? 0.66 : 0.42, 0, 0, true);
      if (h(15) < 0.5) flatHouse(0.55, 0.62, 0.28, -0.42, -0.1, false);
      return;
    }
    if (st.kind === StructureKind.Courtyard) {
      // courtyard house: rooms along the back and one side, a walled yard with a gate in front
      flatHouse(2.4, 0.62, 0.5, 0, -0.42, false);
      flatHouse(0.62, 0.75, 0.4, 0.88, 0.3, true);
      const w0 = walls.count;
      boxAt(walls, 1.75, 0.22, 0.06, L(trs(-0.32, 0.11, 0.72)), wallC.clone().multiplyScalar(0.94));
      boxAt(walls, 0.06, 0.22, 0.8, L(trs(-1.17, 0.11, 0.33)), wallC.clone().multiplyScalar(0.94));
      boxUV(walls, w0, 1.1);
      boxAt(wood, 0.24, 0.2, 0.03, L(trs(-0.2, 0.1, 0.75)), new THREE.Color(0.3, 0.22, 0.14));
      boxAt(trim, 1.7, 0.01, 0.75, L(trs(-0.28, 0.005, 0.32)), new THREE.Color(0.62, 0.52, 0.4));
      return;
    }

    switch (st.kind) {
      case StructureKind.House:
      case StructureKind.Cottage: {
        if (bc === 2) {
          // winter: painted log house, steep dark roof (the snow lies on it), white window frames
          const big = st.kind === StructureKind.House;
          const lx = big ? 1.45 : 1.2;
          const dz = big ? 1.05 : 0.9;
          const hw = big ? 0.6 : 0.42;
          const rise = house(lx, dz, hw, (big ? 0.68 : 0.8) + 0.12, wood, wallC, roofC, 1.6);
          windows(lx, dz, hw, big ? 2 : 1, true);
          boxAt(walls, 0.13, 0.32, 0.13, L(trs((h(4) - 0.5) * lx * 0.6, hw + rise * 0.75, -dz * 0.18)), new THREE.Color(0.55, 0.53, 0.5));
          // corner posts
          for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) boxAt(wood, 0.05, hw, 0.05, L(trs((sx * lx) / 2, hw / 2, (sz * dz) / 2)), wallC.clone().multiplyScalar(0.7));
          if (h(5) < 0.6) house(0.5, 0.62, 0.3, 0.55, wood, new THREE.Color(0.38, 0.3, 0.24), roofC.clone().multiplyScalar(0.85), 1.5);
          break;
        }
        const big = st.kind === StructureKind.House;
        const lx = big ? 1.45 : 1.2;
        const dz = big ? 1.05 : 0.9;
        const hw = big ? 0.62 : 0.42;
        const pitch = big ? 0.68 : 0.8;
        const rise = house(lx, dz, hw, pitch, walls, wallC, roofC, 1.2);
        windows(lx, dz, hw, big ? 2 : 1, true);
        // chimney
        const cx2 = (h(4) - 0.5) * lx * 0.6;
        boxAt(walls, 0.12, 0.3, 0.12, L(trs(cx2, hw + rise * 0.75, -dz * 0.18)), wallC.clone().multiplyScalar(0.8));
        // a lean-to shed or garage on some houses
        if (h(5) < 0.5) {
          house(0.45, 0.6, 0.28, 0.4, wood, new THREE.Color(0.55, 0.45, 0.35), roofC.clone().multiplyScalar(0.8), 1.5);
        }
        break;
      }
      case StructureKind.Barn: {
        const barnC = [new THREE.Color(0.55, 0.2, 0.15), new THREE.Color(0.45, 0.36, 0.28), new THREE.Color(0.5, 0.5, 0.48)][Math.floor(h(6) * 3)];
        house(2.5, 1.5, 0.6, 0.62, wood, barnC, new THREE.Color(0.42, 0.42, 0.44), 1);
        boxAt(wood, 0.6, 0.48, 0.03, L(trs(0, 0.24, 0.76)), barnC.clone().multiplyScalar(0.6));
        boxAt(trim, 0.04, 0.5, 0.04, L(trs(-0.32, 0.25, 0.78)), frame);
        boxAt(trim, 0.04, 0.5, 0.04, L(trs(0.32, 0.25, 0.78)), frame);
        break;
      }
      case StructureKind.Silo: {
        const c0 = metal.count;
        metal.add(new THREE.CylinderGeometry(0.3, 0.3, 1.35, 16, 1, true).translate(0, 0.62, 0), base, null, new THREE.Color(0.7, 0.72, 0.72));
        metal.add(new THREE.ConeGeometry(0.33, 0.25, 16, 1, true).translate(0, 1.42, 0), base, null, new THREE.Color(0.6, 0.62, 0.62));
        boxUV(metal, c0, 4);
        break;
      }
      case StructureKind.WaterTower: {
        const legH = 1.05;
        for (const [sx, sz] of [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ])
          beam(metal, V(sx * 0.28, 0, sz * 0.28).applyMatrix4(base), V(sx * 0.17, legH, sz * 0.17).applyMatrix4(base), 0.04, new THREE.Color(0.5, 0.52, 0.5));
        for (const y of [0.35, 0.7]) {
          const k = 0.28 - (y / legH) * 0.11;
          for (const [a, b2] of [
            [V(-k, y, -k), V(k, y, -k)],
            [V(k, y, -k), V(k, y, k)],
            [V(k, y, k), V(-k, y, k)],
            [V(-k, y, k), V(-k, y, -k)],
          ])
            beam(metal, a.applyMatrix4(base), b2.applyMatrix4(base), 0.02, new THREE.Color(0.5, 0.52, 0.5));
        }
        const c0 = metal.count;
        metal.add(new THREE.CylinderGeometry(0.33, 0.3, 0.38, 16).translate(0, legH + 0.19, 0), base, null, new THREE.Color(0.78, 0.8, 0.78));
        metal.add(new THREE.ConeGeometry(0.36, 0.2, 16, 1, true).translate(0, legH + 0.48, 0), base, null, new THREE.Color(0.55, 0.58, 0.58));
        boxUV(metal, c0, 4);
        break;
      }
      case StructureKind.Tower: {
        // old stone bell / clock tower
        const w0 = walls.count;
        const stone = new THREE.Color(0.78, 0.72, 0.62);
        boxAt(walls, 0.62, 1.7, 0.62, L(trs(0, 0.7, 0)), stone);
        boxAt(walls, 0.7, 0.08, 0.7, L(trs(0, 1.55, 0)), stone.clone().multiplyScalar(0.9));
        boxUV(walls, w0, 2.5);
        for (let f = 0; f < 4; f++) {
          const a = (f * Math.PI) / 2;
          const d = 0.315;
          const m4 = (y: number, w: number, hh: number, dd: number) => L(trs(Math.sin(a) * d, y, Math.cos(a) * d, a)).multiply(new THREE.Matrix4().makeScale(w, hh, dd));
          boxAt(trim, 1, 1, 1, m4(1.38, 0.16, 0.24, 0.03), glass); // belfry opening
          boxAt(trim, 1, 1, 1, m4(1.08, 0.2, 0.2, 0.02), new THREE.Color(0.92, 0.9, 0.82)); // clock face
          boxAt(trim, 1, 1, 1, m4(0.6, 0.1, 0.16, 0.03), glass);
        }
        // pyramid roof
        const top = V(0, 2.15, 0).applyMatrix4(base);
        const e = 0.38;
        const cs = [V(-e, 1.59, -e), V(e, 1.59, -e), V(e, 1.59, e), V(-e, 1.59, e)].map((p) => p.applyMatrix4(base));
        for (let k = 0; k < 4; k++) {
          const a = cs[k];
          const b2 = cs[(k + 1) % 4];
          const n = b2.clone().sub(a).cross(top.clone().sub(a)).normalize().negate();
          const ids = [roofs.vert(a, n, 0, 0, new THREE.Color(0.35, 0.36, 0.4)), roofs.vert(b2, n, 1.2, 0, new THREE.Color(0.35, 0.36, 0.4)), roofs.vert(top, n, 0.6, 1.2, new THREE.Color(0.35, 0.36, 0.4))];
          roofs.tri(ids[0], ids[2], ids[1]);
        }
        break;
      }
    }
  }
  const built = new Map<GeoBuilder, THREE.Mesh>();
  const mkStatic = (b: GeoBuilder, mat: THREE.Material, cast: boolean) => {
    if (!b.count) return;
    const g = b.build();
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    out.push(mesh);
    built.set(b, mesh);
  };
  mkStatic(walls, fog.apply(new THREE.MeshStandardMaterial({ map: tex.plaster, vertexColors: true, roughness: 0.92 })), shadows);
  mkStatic(roofs, fog.apply(new THREE.MeshStandardMaterial({ map: tex.roof, vertexColors: true, roughness: 0.8, side: THREE.DoubleSide })), shadows);
  mkStatic(trim, fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.2 })), false);
  mkStatic(wood, fog.apply(new THREE.MeshStandardMaterial({ map: tex.planks, vertexColors: true, roughness: 0.9 })), shadows);
  mkStatic(metal, fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.6 })), shadows);
  if (sink)
    for (const sp of spans) {
      const st = sp.st;
      const cx = st.x + st.w / 2;
      const cz = st.y + st.h / 2;
      let gy = 99;
      for (const [x, z] of [[st.x, st.y], [st.x + st.w, st.y], [st.x, st.y + st.h], [st.x + st.w, st.y + st.h], [cx, cz]]) gy = Math.min(gy, surfaceHeight(m, x, z));
      const ranges: HouseHandle['ranges'] = [];
      builders.forEach((b, k) => {
        const mesh = built.get(b);
        if (mesh && sp.to[k] > sp.from[k]) ranges.push({ mesh, start: sp.from[k], end: sp.to[k] });
      });
      sink.houses.push({ st, cx, cz, gy, ranges });
    }

  // city blocks, street lamps, fountains and ruins (urban maps)
  out.push(...buildCity(m, fog, quality, sink, lod));

  // ------------------------------------------------------------- fences
  const posts: Inst[] = [];
  const rails: Inst[] = [];
  for (const e of layout.edges) {
    if (e.kind !== 'fence') continue;
    const L = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
    const n = Math.max(1, Math.round(L / 0.42));
    const ang = Math.atan2(e.b.y - e.a.y, e.b.x - e.a.x);
    let prev: THREE.Vector3 | null = null;
    for (let k = 0; k <= n; k++) {
      const x = e.a.x + ((e.b.x - e.a.x) * k) / n;
      const z = e.a.y + ((e.b.y - e.a.y) * k) / n;
      const tx = Math.floor(x);
      const tz = Math.floor(z);
      const okTile = tx >= 0 && tz >= 0 && tx < m.w && tz < m.h && m.tiles[tz * m.w + tx] !== Tile.Water && !m.trees[tz * m.w + tx];
      const broken = hash2(Math.floor(x * 10), Math.floor(z * 10), 5) < 0.06;
      if (!okTile || broken) {
        prev = null;
        continue;
      }
      const y = surfaceHeight(m, x, z);
      const lean = (hash2(Math.floor(x * 10), Math.floor(z * 10), 6) - 0.5) * 0.15;
      posts.push({ x, y, z, rotY: ang, sx: 1, sy: 0.9 + hash2(k, Math.floor(x), 7) * 0.2, sz: 1, tiltX: lean });
      const p = V(x, y, z);
      if (prev) {
        for (const hh of [0.07, 0.12]) {
          const mid = prev.clone().add(p).multiplyScalar(0.5);
          const len = prev.distanceTo(p);
          const pitch = Math.atan2(p.y - prev.y, Math.hypot(p.x - prev.x, p.z - prev.z));
          rails.push({ x: mid.x, y: mid.y + hh, z: mid.z, rotY: -ang, sx: len, sy: 1, sz: 1, tiltZ: pitch });
        }
      }
      prev = p;
    }
  }
  const fenceMat = fog.apply(new THREE.MeshStandardMaterial({ color: 0x8a7a64, roughness: 0.95, map: tex.planks }));
  if (posts.length) {
    const postGeo = new THREE.BoxGeometry(0.03, 0.16, 0.03).translate(0, 0.07, 0);
    // winter: the posts stand half buried in the snow (props.ts snow line)
    const postMat = bc === 2 ? snowLine(fog, new THREE.MeshStandardMaterial({ color: 0x8a7a64, roughness: 0.95, map: tex.planks }), 0.06) : fenceMat;
    const pm = chunkedInstances(postGeo, postMat, posts, 96, { castShadow: false });
    out.push(...pm);
    const railGeo = new THREE.BoxGeometry(1, 0.014, 0.012);
    const rm = chunkedInstances(railGeo, fenceMat, rails, 96, { castShadow: false });
    out.push(...rm);
    sink?.posts.push(...pm);
    sink?.rails.push(...rm);
  }

  // ------------------------------------------------------- power lines
  const pyl = new GeoBuilder();
  const steelC = new THREE.Color(0.55, 0.57, 0.58);
  const PH = 2.3;
  const pb0 = 0.26;
  const pb1 = 0.06;
  const pc = (sx: number, sz: number, t: number) => V(sx * (pb0 + (pb1 - pb0) * t), PH * t, sz * (pb0 + (pb1 - pb0) * t));
  const corners: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (const [sx, sz] of corners) beam(pyl, pc(sx, sz, 0), pc(sx, sz, 1), 0.035, steelC);
  for (let lv = 0; lv < 5; lv++) {
    const t0 = lv / 5;
    const t1 = (lv + 1) / 5;
    for (let k = 0; k < 4; k++) {
      const [ax, az] = corners[k];
      const [bx, bz] = corners[(k + 1) % 4];
      beam(pyl, pc(ax, az, t1), pc(bx, bz, t1), 0.015, steelC);
      beam(pyl, pc(ax, az, t0), pc(bx, bz, t1), 0.01, steelC);
      beam(pyl, pc(bx, bz, t0), pc(ax, az, t1), 0.01, steelC);
    }
  }
  // cross arms (along local x, the line runs along local z)
  const armY = [PH * 0.7, PH * 0.86];
  const armW = [0.62, 0.45];
  armY.forEach((y, k) => {
    beam(pyl, V(-armW[k], y, 0), V(armW[k], y, 0), 0.04, steelC);
    beam(pyl, V(-armW[k], y, 0), V(-0.1, y + 0.18, 0), 0.02, steelC);
    beam(pyl, V(armW[k], y, 0), V(0.1, y + 0.18, 0), 0.02, steelC);
    for (const s of [-1, 1]) boxAt(pyl, 0.03, 0.12, 0.03, trs(s * armW[k] * 0.92, y - 0.07, 0), new THREE.Color(0.35, 0.4, 0.45));
  });
  const attach = [V(-armW[0] * 0.92, armY[0] - 0.13, 0), V(armW[0] * 0.92, armY[0] - 0.13, 0), V(-armW[1] * 0.92, armY[1] - 0.13, 0), V(armW[1] * 0.92, armY[1] - 0.13, 0), V(0, PH, 0)];
  const pylInst: Inst[] = [];
  const cable: number[] = [];
  const catenary = (a: THREE.Vector3, b: THREE.Vector3, sag: number, segs: number) => {
    for (let k = 0; k < segs; k++) {
      const t0 = k / segs;
      const t1 = (k + 1) / segs;
      const p0 = a.clone().lerp(b, t0);
      const p1 = a.clone().lerp(b, t1);
      p0.y -= sag * 4 * t0 * (1 - t0);
      p1.y -= sag * 4 * t1 * (1 - t1);
      cable.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
    }
  };
  for (const line of layout.pylons.lines) {
    const tops: THREE.Vector3[][] = [];
    line.forEach((p, i) => {
      const a = line[Math.max(0, i - 1)];
      const c = line[Math.min(line.length - 1, i + 1)];
      const ang = Math.atan2(c.y - a.y, c.x - a.x);
      const y = surfaceHeight(m, p.x, p.y) - 0.03;
      // local z along the line
      const rotY = -ang + Math.PI / 2;
      pylInst.push({ x: p.x, y, z: p.y, rotY, sx: 1, sy: 1, sz: 1 });
      const mtx = trs(p.x, y, p.y, rotY);
      tops.push(attach.map((q) => q.clone().applyMatrix4(mtx)));
    });
    for (let i = 0; i < tops.length - 1; i++) {
      const span = Math.hypot(line[i + 1].x - line[i].x, line[i + 1].y - line[i].y);
      for (let k = 0; k < attach.length; k++) catenary(tops[i][k], tops[i + 1][k], 0.03 * span + (k === 4 ? -0.05 : 0), 10);
    }
  }
  if (pylInst.length) out.push(...chunkedInstances(pyl.build(), fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.6 })), pylInst, 48, { castShadow: shadows }));

  // wooden utility poles + wires
  const pole = new GeoBuilder();
  pole.add(new THREE.CylinderGeometry(0.018, 0.024, 1.0, 6).translate(0, 0.5, 0), new THREE.Matrix4(), null, new THREE.Color(0.42, 0.33, 0.24));
  boxAt(pole, 0.3, 0.025, 0.025, trs(0, 0.92, 0), new THREE.Color(0.4, 0.32, 0.24));
  const poleInst: Inst[] = [];
  for (const run of layout.poles) {
    const tops: THREE.Vector3[][] = [];
    run.forEach((p, i) => {
      const a = run[Math.max(0, i - 1)];
      const c = run[Math.min(run.length - 1, i + 1)];
      const ang = Math.atan2(c.y - a.y, c.x - a.x);
      const y = surfaceHeight(m, p.x, p.y) - 0.02;
      const rotY = -ang + Math.PI / 2;
      poleInst.push({ x: p.x, y, z: p.y, rotY, sx: 1, sy: 1, sz: 1, tiltX: (hash2(i, Math.floor(p.x), 4) - 0.5) * 0.06 });
      const mtx = trs(p.x, y, p.y, rotY);
      tops.push([V(-0.13, 0.94, 0), V(0.13, 0.94, 0)].map((q) => q.applyMatrix4(mtx)));
    });
    for (let i = 0; i < tops.length - 1; i++) for (let k = 0; k < 2; k++) catenary(tops[i][k], tops[i + 1][k], 0.06, 6);
  }
  if (poleInst.length) out.push(...chunkedInstances(pole.build(), fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 })), poleInst, 96, { castShadow: shadows }));
  if (cable.length) {
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(cable, 3));
    const lines = new THREE.LineSegments(cg, fog.apply(new THREE.LineBasicMaterial({ color: 0x2a2c2e, transparent: true, opacity: 0.6 })));
    lines.name = 'cables';
    out.push(lines);
  }

  // ------------------------------------------------------------- wrecks
  const car = new GeoBuilder();
  boxAt(car, 0.46, 0.08, 0.2, trs(0, 0.075, 0), 1);
  boxAt(car, 0.26, 0.07, 0.18, trs(-0.02, 0.15, 0), 0.9);
  boxAt(car, 0.22, 0.05, 0.185, trs(-0.02, 0.15, 0), new THREE.Color(0.08, 0.08, 0.09)); // empty window holes
  for (const [x, z] of [
    [-0.15, -0.1],
    [0.15, -0.1],
    [-0.15, 0.1],
    [0.15, 0.1],
  ])
    car.add(new THREE.CylinderGeometry(0.045, 0.045, 0.04, 8).rotateX(Math.PI / 2).toNonIndexed(), trs(x, 0.045, z), null, new THREE.Color(0.08, 0.07, 0.07));
  const wreckInst: Inst[] = layout.wrecks.map((w, k) => {
    const paint = [new THREE.Color(0.25, 0.12, 0.08), new THREE.Color(0.35, 0.38, 0.45), new THREE.Color(0.55, 0.5, 0.42), new THREE.Color(0.18, 0.17, 0.16), new THREE.Color(0.5, 0.22, 0.15)][
      Math.floor(hash2(k, 1, 33) * 5)
    ];
    const burnt = w.kind === 0;
    const over = w.kind === 2 && hash2(k, 2, 33) < 0.5;
    return {
      x: w.x,
      y: surfaceHeight(m, w.x, w.y) + (over ? 0.2 : -0.01),
      z: w.y,
      rotY: -w.rot,
      sx: 1.15,
      sy: 1.15,
      sz: 1.15,
      tiltX: over ? Math.PI : (hash2(k, 3, 33) - 0.5) * 0.15,
      tiltZ: (hash2(k, 4, 33) - 0.5) * 0.12,
      color: burnt ? new THREE.Color(0.14, 0.12, 0.11) : paint,
    };
  });
  if (wreckInst.length) out.push(...chunkedInstances(car.build(), fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.35 })), wreckInst, 96, { castShadow: shadows }));

  // ------------------------------------------------------- hay bales
  const bales: Inst[] = [];
  layout.fields.forEach((f, k) => {
    if (f.type !== FieldType.Fallow && !(f.type === FieldType.Wheat && hash2(k, 0, 44) < 0.3)) return;
    const n = 4 + Math.floor(hash2(k, 1, 44) * 7);
    const ca = Math.cos(f.angle);
    const sa = Math.sin(f.angle);
    for (let j = 0; j < n; j++) {
      const a = (hash2(k, j, 45) - 0.5) * 2 * (f.hl - 0.4);
      const b = (hash2(k, j, 46) - 0.5) * 2 * (f.hw - 0.3);
      const x = f.cx + ca * a - sa * b;
      const z = f.cy + sa * a + ca * b;
      bales.push({ x, y: surfaceHeight(m, x, z) + 0.055, z, rotY: hash2(k, j, 47) * 6.28, sx: 1, sy: 1, sz: 1 });
    }
  });
  if (bales.length) {
    const bale = new THREE.CylinderGeometry(0.065, 0.065, 0.1, 10).rotateZ(Math.PI / 2);
    out.push(...chunkedInstances(bale, fog.apply(new THREE.MeshStandardMaterial({ color: 0xb8a060, roughness: 0.95, map: tex.planks })), bales, 96, { castShadow: shadows }));
  }
  return out;
}
