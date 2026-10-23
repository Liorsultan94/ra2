import * as THREE from 'three';
import { StructureKind, type GameMap, type Structure } from '../sim/map';
import { hash2 } from '../sim/rng';
import type { FogOfWar } from './fog';
import type { SceneryLod } from './geo';
import { surfaceHeight } from './ground';
import type { HouseHandle } from './scenery';
import { SinaiBuilder, scaleM, sinaiKitMaterial, sinaiPlasterMaterial, type SinaiKit } from './sinaikit';
import { buildVegInstances, desertVeg, vegTint, type VegKind } from './desertveg';
import type { Inst } from './geo';
import type { Acc, BuildingPlan, ColKey } from './buildingplan';
import { planOf } from './buildingslots';

/*
 * Wadi Al-Rimal's town (desert map) built from the Sinai building kit (sinaikit.ts, GD2): the same houses as
 * the procedural town of DS1 / DS3 (scenery.ts: every footprint, height, wing, terrace, dome and colour comes
 * from the same per-structure hash, so each house keeps its own look) with real detail - rendered plaster with
 * cracks and stains, recessed windows with frames, sills, louvred shutters and grilles, panelled doors under
 * striped awnings, iron railings, split AC units, water tanks on stands, satellite dishes, solar heaters,
 * coping on the parapets; the mosque gets its ribbed dome on a windowed drum, a corbelled minaret with a
 * balustrade and a crescent, lattice windows and stepped merlons.
 *
 * Merged per 48-tile chunk into three meshes: the walls (plaster), the kit at play zoom (LOD0: cards + full
 * pieces + small clutter) and the kit zoomed out (LOD1: cards + light pieces, no clutter); SceneryLod swaps the
 * two kit meshes on the view span. Each house hands its vertex ranges in all three to envdamage.ts (scorch,
 * cave in, collapse), as the procedural houses did.
 * The yard trees are the desert vegetation kit's young palms and acacias (desertveg.ts, GD3) when it loaded.
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
function trs(x: number, y: number, z: number, ry = 0, rx = 0, rz = 0) {
  return new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), V(1, 1, 1));
}

const C = (r: number, g: number, b: number) => new THREE.Color(r, g, b);
/** The baked plaster (mean ~0.78 linear) is lighter than the old canvas plaster (0.64): scale the wall colours to keep the town's brightness. */
const WALL_LIFT = 0.92;

/** Chunk size (tiles) of the merged town meshes: the quarters on each side fall into a few chunks. */
const CHUNK = 48;
/** Below high quality the play-zoom mesh takes these pieces' LOD1 (railings: most of the kit's triangles). */
const LITE = new Set(['rail']);

export function isSinaiKind(k: StructureKind) {
  return k === StructureKind.House || k === StructureKind.Cottage || k === StructureKind.MudHouse || k === StructureKind.Courtyard;
}

interface Chunk {
  b: SinaiBuilder;
  spans: { st: Structure; gy: number; from: [number, number, number]; to: [number, number, number] }[];
}

/**
 * Build the town's houses (desert map, the kit loaded): meshes to add to the scene; the house handles go to
 * `sink` (envdamage.ts). Only structures with isSinaiKind() are built here (scenery.ts skips them then).
 */
export function buildSinaiTown(m: GameMap, kit: SinaiKit, fog: FogOfWar, quality: 'low' | 'medium' | 'high', sink?: { houses: HouseHandle[] }, lod?: SceneryLod): THREE.Object3D[] {
  const chunks = new Map<string, Chunk>();
  // the yard trees: kit plants (instanced, zoom LOD) when the vegetation kit loaded
  const veg = lod ? desertVeg() : null;
  const plants = veg ? new Map<VegKind, Inst[]>() : null;
  for (const st of m.structures) {
    if (!isSinaiKind(st.kind)) continue;
    const cx = st.x + st.w / 2;
    const cz = st.y + st.h / 2;
    const key = `${Math.floor(cx / CHUNK)},${Math.floor(cz / CHUNK)}`;
    let ch = chunks.get(key);
    if (!ch) chunks.set(key, (ch = { b: new SinaiBuilder(kit, quality === 'high' ? undefined : LITE), spans: [] }));
    let gy = 99;
    for (const [x, z] of [
      [st.x, st.y],
      [st.x + st.w, st.y],
      [st.x, st.y + st.h],
      [st.x + st.w, st.y + st.h],
      [cx, cz],
    ])
      gy = Math.min(gy, surfaceHeight(m, x, z));
    const from = ch.b.counts();
    buildHouse(ch.b, st, gy, plants, planOf(m, st));
    ch.spans.push({ st, gy, from, to: ch.b.counts() });
  }
  const out: THREE.Object3D[] = [];
  const shadows = quality !== 'low';
  const plMat = sinaiPlasterMaterial(fog, kit);
  const kMat = sinaiKitMaterial(fog, kit);
  const loSpan = quality === 'high' ? 30 : 24;
  for (const ch of chunks.values()) {
    const gp = ch.b.pl.build();
    const g0 = ch.b.k0.build();
    const g1 = ch.b.k1.build();
    const mk = (g: THREE.BufferGeometry | null, mat: THREE.Material, name: string) => {
      if (!g) return null;
      const mesh = new THREE.Mesh(g, mat);
      // phone / medium: the walls cast the shadows, the kit's small parts only receive (draw calls, triangles)
      mesh.castShadow = shadows && (quality === 'high' || mat === plMat);
      mesh.receiveShadow = true;
      mesh.name = name;
      mesh.userData.perfCat = 'scenery';
      out.push(mesh);
      return mesh;
    };
    const mp = mk(gp, plMat, 'sinai-walls');
    const m0 = mk(g0, kMat, 'sinai-kit');
    const m1 = mk(g1, kMat, 'sinai-kit-far');
    if (lod) {
      if (m0) lod.add([m0], m0.geometry, null, Infinity, loSpan);
      if (m1) lod.add([m1], m1.geometry, null, Infinity, Infinity, loSpan);
    } else if (m1) m1.visible = false;
    if (sink)
      for (const sp of ch.spans) {
        const st = sp.st;
        const ranges: HouseHandle['ranges'] = [];
        [mp, m0, m1].forEach((mesh, k) => {
          if (mesh && sp.to[k] > sp.from[k]) ranges.push({ mesh, start: sp.from[k], end: sp.to[k] });
        });
        const pl = planOf(m, st);
        sink.houses.push({ st, cx: st.x + st.w / 2, cz: st.y + st.h / 2, gy: sp.gy, ranges, info: { variant: pl.variant, storeys: pl.storeys, height: pl.height } });
      }
  }
  if (veg && plants && lod)
    for (const [kind, list] of plants) out.push(buildVegInstances(veg, kind, list, fog, quality, lod, m.w, m.h, { castShadow: shadows, name: 'trees' }).mesh);
  return out;
}

// ------------------------------------------------------------------ one structure

const CYL: Record<number, THREE.BufferGeometry> = {};
let PYR: THREE.BufferGeometry | null = null;
let WEDGE: THREE.BufferGeometry | null = null;

/** Unit solids for the plan's 'geo' ops: a cylinder (diameter 1, height 1, centred), a square pyramid (base 1, height 1, centred), a wedge (x -0.5..0.5, tall edge at z 0 (y 1), falling to y 0 at z 1). */
function solid(g: 'cyl' | 'pyramid' | 'wedge' | 'cone' | 'vault' | 'prism', seg = 16): THREE.BufferGeometry {
  if (g === 'pyramid') return (PYR ??= new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4));
  if (g === 'wedge') {
    if (!WEDGE) {
      const pos = [-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0, -0.5, 0, 1, 0.5, 0, 1];
      // the back face (z 0, a quad up to y 1), the slope (top edge to the foot at z 1), the two end triangles
      const tris = [[0, 2, 1], [0, 3, 2], [3, 5, 2], [3, 4, 5], [0, 4, 3], [1, 2, 5]];
      const verts: number[] = [];
      const norms: number[] = [];
      const A = new THREE.Vector3();
      const B = new THREE.Vector3();
      const Cc = new THREE.Vector3();
      for (const [a, b, c] of tris) {
        A.fromArray(pos, a * 3);
        B.fromArray(pos, b * 3);
        Cc.fromArray(pos, c * 3);
        const n = B.clone().sub(A).cross(Cc.clone().sub(A)).normalize();
        for (const q of [A, B, Cc]) {
          verts.push(q.x, q.y, q.z);
          norms.push(n.x, n.y, n.z);
        }
      }
      const g2 = new THREE.BufferGeometry();
      g2.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
      g2.setAttribute('normal', new THREE.Float32BufferAttribute(norms, 3));
      g2.setAttribute('uv', new THREE.Float32BufferAttribute(new Array((verts.length / 3) * 2).fill(0), 2));
      WEDGE = g2;
    }
    return WEDGE;
  }
  return (CYL[seg] ??= new THREE.CylinderGeometry(0.5, g === 'cone' ? 0.05 : 0.5, 1, seg, 1));
}

/** Lay a building plan (buildingplan.ts) on its footprint: every op into the chunk's merged meshes. */
function buildHouse(B: SinaiBuilder, st: Structure, gy: number, plants: Map<VegKind, Inst[]> | null, plan: BuildingPlan) {
  const cx = st.x + st.w / 2;
  const cz = st.y + st.h / 2;
  const base = new THREE.Matrix4().compose(V(cx, gy, cz), new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), (st.rot * Math.PI) / 2), V(1, 1, 1));
  const L = (lm: THREE.Matrix4) => base.clone().multiply(lm);
  const seed = hash2(st.x * 3 + 1, st.y * 5 + 2, 91);
  const colCache = new Map<string, THREE.Color>();
  const plaster = (k: ColKey, mul = 1) => {
    const key = k + mul;
    let c = colCache.get(key);
    if (!c) colCache.set(key, (c = new THREE.Color(plan.col[k]).multiplyScalar(WALL_LIFT * mul)));
    return c;
  };
  const accOf = (a: Acc | undefined): THREE.Color | undefined => {
    if (!a) return undefined;
    const t = typeof a === 'string' ? plan.acc[a] : a;
    return C(t[0], t[1], t[2]);
  };
  const tintOf = (k: ColKey | undefined) => (k ? plaster(k) : undefined);

  for (const o of plan.ops) {
    switch (o.t) {
      case 'box':
        B.pl.wear = [plan.wear, o.mat ?? 0, seed];
        B.box(L(trs(o.x, o.y, o.z, o.ry ?? 0)), o.w, o.h, o.d, plaster(o.c, o.m ?? 1), gy, !!o.bottom);
        break;
      case 'card':
        B.card(o.n, L(trs(o.x, o.y, o.z, o.ry)), { tint: tintOf(o.tint), accent: accOf(o.a) }, o.sx, o.sy);
        break;
      case 'piece': {
        let m = L(trs(o.x, o.y, o.z, o.ry ?? 0, o.rx ?? 0, o.rz ?? 0));
        if (o.s) m = m.multiply(scaleM(o.s[0], o.s[1], o.s[2]));
        B.piece(o.n, m, { tint: tintOf(o.tint), accent: accOf(o.a), color: o.col ? C(o.col[0], o.col[1], o.col[2]) : undefined }, o.lod ?? 'both');
        break;
      }
      case 'sw':
        B.swatch(L(trs(o.x, o.y, o.z, o.ry ?? 0, o.rx ?? 0, o.rz ?? 0)), o.w, o.h, o.d, o.s, { accent: accOf(o.a), color: o.col ? C(o.col[0], o.col[1], o.col[2]) : undefined }, o.lod ?? 'both');
        break;
      case 'geo': {
        B.pl.wear = [plan.wear, o.mat ?? 0, seed];
        B.plaster(solid(o.g, o.seg), L(trs(o.x, o.y, o.z, o.ry ?? 0).multiply(scaleM(o.w, o.h, o.d))), plaster(o.c, o.m ?? 1), gy);
        break;
      }
      case 'sign':
        B.sign(L(trs(o.x, o.y, o.z, o.ry)), o.w, o.h, o.i, {});
        break;
      case 'tree': {
        if (plants) {
          // a young date palm or a small acacia in the yard (about the old tree's size)
          const p = V(o.x, 0, o.z).applyMatrix4(base);
          const r1 = hash2(Math.floor(p.x * 7), Math.floor(p.z * 7), 3);
          const r2 = hash2(Math.floor(p.x * 7), Math.floor(p.z * 7), 4);
          const kind: VegKind = r1 < 0.6 ? 'date_short' : 'acacia_b';
          const k = (kind === 'date_short' ? 0.52 : 0.62) * (o.r / 0.16) * (0.9 + r2 * 0.2);
          let l = plants.get(kind);
          if (!l) plants.set(kind, (l = []));
          l.push({ x: p.x, y: gy - 0.01, z: p.z, rotY: r2 * Math.PI * 2, sx: k, sy: k * (0.92 + r1 * 0.16), sz: k, color: vegTint(kind, r1, r2, hash2(Math.floor(p.x * 7), Math.floor(p.z * 7), 5)) });
          break;
        }
        B.swatch(L(trs(o.x, o.hgt / 2, o.z)), 0.035, o.hgt, 0.035, 'wood', {});
        B.swatchGeo(new THREE.IcosahedronGeometry(o.r, 1), L(trs(o.x, o.hgt + o.r * 0.6, o.z).multiply(scaleM(1, 0.85, 1))), 'paint', { accent: C(0.24, 0.36, 0.16) });
        break;
      }
    }
  }
}
