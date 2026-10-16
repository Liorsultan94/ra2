import * as THREE from 'three';
import { StructureKind, type GameMap, type Structure } from '../sim/map';
import { hash2 } from '../sim/rng';
import type { FogOfWar } from './fog';
import type { SceneryLod } from './geo';
import { surfaceHeight } from './ground';
import type { HouseHandle } from './scenery';
import { SinaiBuilder, scaleM, sinaiKitMaterial, sinaiPlasterMaterial, type KitOpts, type Lod, type SinaiKit } from './sinaikit';

/*
 * Wadi Al-Rimal's town (desert map) built from the Sinai building kit (sinaikit.ts, GD2): the same houses as
 * the procedural town of DS1 / DS3 (scenery.ts: every footprint, height, wing, terrace, dome and colour comes
 * from the same per-structure hash, so each house keeps its own look) with real detail - rendered plaster with
 * cracks and stains, recessed windows with frames, sills, louvred shutters and grilles, panelled doors under
 * striped awnings, iron railings, split AC units, water tanks on stands, satellite dishes, solar heaters,
 * coping on the parapets; the mosque gets its ribbed dome on a windowed drum, a corbelled minaret with a
 * balustrade and a crescent, lattice windows and stepped merlons.
 *
 * Merged per 32-tile chunk into three meshes: the walls (plaster), the kit at play zoom (LOD0: cards + full
 * pieces + small clutter) and the kit zoomed out (LOD1: cards + light pieces, no clutter); SceneryLod swaps the
 * two kit meshes on the view span. Each house hands its vertex ranges in all three to envdamage.ts (scorch,
 * cave in, collapse), as the procedural houses did.
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const C = (r: number, g: number, b: number) => new THREE.Color(r, g, b);

function trs(x: number, y: number, z: number, ry = 0, rx = 0, rz = 0) {
  return new THREE.Matrix4().compose(V(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), V(1, 1, 1));
}

/** The desert wall colours (scenery.ts, same order: the hash picks the same one). */
const WALLS = [0xf3efe6, 0xeee2c8, 0xe9d4ac, 0xf2e0c8, 0xe4d2ae, 0xf7f3ea, 0xdcc8a0, 0xeadfd0, 0xdfb57e, 0xe6c28e];
const ACCENTS = [C(0.18, 0.4, 0.66), C(0.16, 0.56, 0.56), C(0.24, 0.46, 0.3), C(0.7, 0.36, 0.22), C(0.85, 0.66, 0.28)];
const WHITE = C(1, 1, 1);
/** The baked plaster (mean ~0.78 linear) is lighter than the old canvas plaster (0.64): scale the wall colours to keep the town's brightness. */
const WALL_LIFT = 0.86;

export function isSinaiKind(k: StructureKind) {
  return k === StructureKind.House || k === StructureKind.Cottage || k === StructureKind.MudHouse || k === StructureKind.Courtyard;
}

interface CardReq {
  name: string;
  m: THREE.Matrix4;
  o: KitOpts;
  sx: number;
  sy: number;
  prio: number;
  lod: Lod;
  c: THREE.Vector3;
  n: THREE.Vector3;
  w: number;
  h: number;
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
  for (const st of m.structures) {
    if (!isSinaiKind(st.kind)) continue;
    const cx = st.x + st.w / 2;
    const cz = st.y + st.h / 2;
    const key = `${Math.floor(cx / 32)},${Math.floor(cz / 32)}`;
    let ch = chunks.get(key);
    if (!ch) chunks.set(key, (ch = { b: new SinaiBuilder(kit), spans: [] }));
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
    buildHouse(ch.b, st, gy);
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
      mesh.castShadow = shadows;
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
        sink.houses.push({ st, cx: st.x + st.w / 2, cz: st.y + st.h / 2, gy: sp.gy, ranges });
      }
  }
  return out;
}

// ------------------------------------------------------------------ one structure

function buildHouse(B: SinaiBuilder, st: Structure, gy: number) {
  const cx = st.x + st.w / 2;
  const cz = st.y + st.h / 2;
  const base = new THREE.Matrix4().compose(V(cx, gy, cz), new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), (st.rot * Math.PI) / 2), V(1, 1, 1));
  const L = (lm: THREE.Matrix4) => base.clone().multiply(lm);
  const h = (k: number) => hash2(st.x * 7 + k, st.y * 13, 911);
  const lift = (c: THREE.Color) => c.clone().multiplyScalar(WALL_LIFT);
  const wallC = lift(new THREE.Color(WALLS[Math.floor(h(1) * WALLS.length)]));
  const acc = ACCENTS[Math.floor(h(51) * ACCENTS.length)];
  const acc2 = ACCENTS[Math.floor(h(52) * ACCENTS.length)];
  const wc2 = lift(new THREE.Color(WALLS[Math.floor(h(53) * WALLS.length)]));
  const ironC = C(0.2, 0.21, 0.22);
  const cards: CardReq[] = [];
  // window style of this house (new hashes: the old choices above are untouched)
  const style = ['win', 'win_shut', 'win_closed', 'win_grille', 'win_arch', 'win_shut'][Math.floor(h(201) * 6)];

  const card = (name: string, lm: THREE.Matrix4, o: KitOpts, prio = 1, sx = 1, sy = 1, lod: Lod = 'both') => {
    const mm = L(lm);
    const [w, hh] = B.cardSize(name);
    const c = V(0, 0, 0).applyMatrix4(mm);
    const n = V(0, 0, 1).transformDirection(mm);
    cards.push({ name, m: mm, o, sx, sy, prio, lod, c, n, w: w * sx, h: hh * sy });
  };
  const emitCards = () => {
    // a later, more important card (a door, shutters asked for by the house type) wins over a plain window
    const keep = cards.filter((a) =>
      !cards.some((b) => {
        if (b === a || b.prio <= a.prio || a.n.dot(b.n) < 0.9) return false;
        const d = b.c.clone().sub(a.c);
        if (Math.abs(d.dot(a.n)) > 0.04) return false;
        const t = V(0, 1, 0).cross(a.n).normalize();
        return Math.abs(d.dot(t)) < (a.w + b.w) * 0.38 && Math.abs(d.y) < (a.h + b.h) * 0.38;
      }),
    );
    for (const r of keep) B.card(r.name, r.m, r.o, r.sx, r.sy, r.lod);
  };
  const box = (lm: THREE.Matrix4, w: number, hh: number, d: number, c: THREE.Color, bottom = false) => B.box(L(lm), w, hh, d, c, gy, bottom);
  const sw = (lm: THREE.Matrix4, w: number, hh: number, d: number, s: string, o: KitOpts = {}, lod: Lod = 'both') => B.swatch(L(lm), w, hh, d, s, o, lod);
  const piece = (name: string, lm: THREE.Matrix4, o: KitOpts = {}, lod: Lod = 'both') => B.piece(name, L(lm), o, lod);


  /** Desert flat-roofed house: plaster box, parapet with a coping, recessed windows, a door, roof clutter. */
  const flatHouse = (lx: number, dz: number, hw: number, ox: number, oz: number, door: boolean, oy = 0, wc = wallC) => {
    const Lo = (lm: THREE.Matrix4) => new THREE.Matrix4().makeTranslation(0, oy, 0).multiply(lm);
    box(Lo(trs(ox, hw / 2, oz)), lx, hw, dz, wc);
    const pt = 0.05;
    const ph = 0.08;
    box(Lo(trs(ox, hw + ph / 2, oz + dz / 2 - pt / 2)), lx, ph, pt, wc);
    box(Lo(trs(ox, hw + ph / 2, oz - dz / 2 + pt / 2)), lx, ph, pt, wc);
    box(Lo(trs(ox + lx / 2 - pt / 2, hw + ph / 2, oz)), pt, ph, dz - 2 * pt, wc);
    box(Lo(trs(ox - lx / 2 + pt / 2, hw + ph / 2, oz)), pt, ph, dz - 2 * pt, wc);
    // the coping (a slightly wider cap, a shade lighter) and the roof slab
    const cap = wc.clone().multiplyScalar(1.04);
    box(Lo(trs(ox, hw + ph + 0.006, oz + dz / 2 - pt / 2)), lx + 0.012, 0.012, pt + 0.012, cap);
    box(Lo(trs(ox, hw + ph + 0.006, oz - dz / 2 + pt / 2)), lx + 0.012, 0.012, pt + 0.012, cap);
    box(Lo(trs(ox + lx / 2 - pt / 2, hw + ph + 0.006, oz)), pt + 0.012, 0.012, dz - 2 * pt - 0.012, cap);
    box(Lo(trs(ox - lx / 2 + pt / 2, hw + ph + 0.006, oz)), pt + 0.012, 0.012, dz - 2 * pt - 0.012, cap);
    box(Lo(trs(ox, hw + 0.006, oz)), lx - 0.1, 0.012, dz - 0.1, wc.clone().multiplyScalar(0.72));
    // windows: front and back, one or two floors (the old positions)
    const nx = Math.max(1, Math.floor(lx / 0.38));
    const floors = hw > 0.55 ? 2 : 1;
    for (let f = 0; f < floors; f++) {
      const wy = floors === 1 ? hw * 0.6 : hw * (0.3 + f * 0.42);
      for (let i = 0; i < nx; i++) {
        const x = ox - lx / 2 + (lx / nx) * (i + 0.5);
        for (const sz of [-1, 1]) {
          if (door && sz > 0 && f === 0 && i === Math.floor(nx / 2)) continue;
          const z = oz + sz * (dz / 2 + 0.003);
          let name = sz > 0 ? style : style === 'win_arch' ? 'win_arch' : h(20 + i + f) < 0.5 ? 'win' : 'win_grille';
          if (name === 'win_shut' && h(20 + i + f) < 0.45) name = 'win_closed';
          if (name === 'win' && h(20 + i + f) < 0.45) name = 'win_grille';
          if (wy + 0.12 > hw + 0.02 && name === 'win_arch') name = 'win';
          card(name, Lo(trs(x, wy, z, sz > 0 ? 0 : Math.PI)), { tint: wc, accent: acc }, 1);
        }
      }
    }
    // a small window or vent on deep side walls
    if (dz > 0.85 && h(202) < 0.6) {
      const sx = h(203) < 0.5 ? -1 : 1;
      card(h(204) < 0.5 ? 'vent' : 'win', Lo(trs(ox + sx * (lx / 2 + 0.003), floors === 2 ? hw * 0.72 : hw * 0.6, oz + (h(205) - 0.5) * dz * 0.3, (sx * Math.PI) / 2)), { tint: wc, accent: acc }, 1);
    }
    if (door) {
      const dc = [C(0.24, 0.36, 0.5), C(0.42, 0.28, 0.16), C(0.2, 0.42, 0.36)][Math.floor(h(7) * 3)];
      card('door', Lo(trs(ox, 0.16, oz + dz / 2 + 0.004)), { tint: wc, accent: dc }, 3);
      // a striped cloth awning over the door
      const aw = [C(0.7, 0.22, 0.16), C(0.2, 0.36, 0.58), C(0.75, 0.62, 0.3)][Math.floor(h(8) * 3)];
      if (h(9) < 0.6) piece('awning', Lo(trs(ox, 0.335, oz + dz / 2 + 0.006)).multiply(scaleM(0.34 / 0.6, 1, 0.8)), { accent: aw });
    }
    // split AC units on the back wall (most houses), one on the roof now and then
    if (h(206) < 0.75) {
      const n = hw > 0.55 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const x = ox + (k === 0 ? -0.25 : 0.25) * lx + (h(207 + k) - 0.5) * 0.08;
        piece('ac', Lo(trs(x, k === 0 ? Math.min(hw - 0.16, 0.2) : hw * 0.62, oz - dz / 2 - 0.03, Math.PI)));
      }
    }
    // roof clutter: a water tank, a satellite dish, a stair head, a solar heater, washing, a roof AC unit
    if (h(10) < 0.75) piece('tank', Lo(trs(ox + lx * 0.25, hw, oz - dz * 0.2)), { accent: h(11) < 0.5 ? C(0.86, 0.86, 0.83) : C(0.1, 0.1, 0.11) });
    if (h(12) < 0.5) piece('dish', Lo(trs(ox - lx * 0.3, hw, oz + dz * 0.25, (-st.rot * Math.PI) / 2 + (h(208) - 0.5) * 0.6)), {}, 0);
    if (h(13) < 0.4) {
      box(Lo(trs(ox - lx * 0.28, hw + 0.08, oz - dz * 0.22)), 0.2, 0.16, 0.2, wc.clone().multiplyScalar(0.95));
      card('door', Lo(trs(ox - lx * 0.28, hw + 0.075, oz - dz * 0.22 + 0.103)).multiply(scaleM(0.5, 0.45, 1)), { tint: wc.clone().multiplyScalar(0.95), accent: acc }, 2);
    }
    if (lx > 1 && h(16) < 0.65) piece('solar', Lo(trs(ox + lx * 0.05, hw, oz + dz * 0.12, (-st.rot * Math.PI) / 2)));
    else if (h(209) < 0.35) piece('ac', Lo(trs(ox + lx * 0.3, hw + 0.002, oz + dz * 0.28, h(210) < 0.5 ? 0 : Math.PI / 2)));
    if (h(17) < 0.45) {
      // washing drying on the roof
      const lm = Lo(trs(ox - lx * 0.1, hw, oz - dz * 0.3));
      for (const sx of [-0.22, 0.22]) sw(lm.clone().multiply(trs(sx, 0.07, 0)), 0.01, 0.14, 0.01, 'wood', {}, 0);
      sw(lm.clone().multiply(trs(0, 0.13, 0)), 0.44, 0.004, 0.004, 'frame', {}, 0);
      const cl = [C(0.9, 0.9, 0.88), C(0.75, 0.2, 0.18), C(0.2, 0.35, 0.65), C(0.85, 0.7, 0.25), C(0.3, 0.55, 0.35)];
      for (let i = 0; i < 4; i++) sw(lm.clone().multiply(trs(-0.15 + i * 0.1, 0.1 - h(30 + i) * 0.02, 0)), 0.06, 0.06 + h(30 + i) * 0.04, 0.004, 'fabric_acc', { accent: cl[Math.floor(h(40 + i) * cl.length)] }, 0);
    }
  };

  const dome = (r: number, x: number, y: number, z: number, c: THREE.Color, sy = 1) => piece('dome', trs(x, y, z).multiply(scaleM(r / 0.25, (r / 0.25) * sy, r / 0.25)), { tint: c });
  /** A row of open round arches on the front (+z) face of a box at (ox, oz), its front at oz + dz / 2. */
  const arcade = (ox: number, oz: number, lx: number, dz: number, y0: number, n: number, ah = 0.22, tint = wallC) => {
    const [cw, chh] = B.cardSize('arch');
    for (let i = 0; i < n; i++) {
      const x = ox - lx / 2 + (lx * (i + 0.5)) / n;
      const aw = (lx / n) * 0.62;
      const sx = aw / (cw * 0.72);
      const sy = (ah + aw / 2) / (chh * 0.86);
      card('arch', trs(x, y0 + (chh * sy) / 2, oz + dz / 2 + 0.004), { tint }, 2, sx, sy);
    }
  };
  /** Iron railing along a line (local, from a to b at height y): 0.5-tile segments stretched to fit. */
  const rail = (ax: number, az: number, bx: number, bz: number, y: number, hk = 1) => {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.05) return;
    const n = Math.max(1, Math.round(len / 0.5));
    const ang = Math.atan2(-(bz - az), bx - ax);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      piece('rail', trs(ax + (bx - ax) * t, y, az + (bz - az) * t, ang).multiply(scaleM(len / n / 0.5, hk, 1)), { color: ironC.clone().multiplyScalar(4) });
    }
  };
  const balcony = (ox: number, oz: number, lx: number, y: number) => {
    box(trs(ox, y, oz + 0.06), lx, 0.025, 0.12, wallC, true);
    sw(trs(ox, y - 0.016, oz + 0.06), lx - 0.02, 0.008, 0.1, 'stone', { color: wallC.clone().multiplyScalar(0.9) }, 0);
    rail(ox - lx / 2 + 0.01, oz + 0.115, ox + lx / 2 - 0.01, oz + 0.115, y + 0.012, 0.8);
    for (const s of [-1, 1]) rail(ox + s * (lx / 2 - 0.01), oz + 0.005, ox + s * (lx / 2 - 0.01), oz + 0.115, y + 0.012, 0.8);
  };
  const post = C(0.42, 0.3, 0.2);
  const pergola = (ox: number, oz: number, lx: number, dz: number, y: number) => {
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) sw(trs(ox + (sx * lx) / 2, y + 0.1, oz + (sz * dz) / 2), 0.025, 0.2, 0.025, 'wood', { color: post.clone().multiplyScalar(2.4) });
    for (const sz of [-1, 1]) sw(trs(ox, y + 0.19, oz + (sz * dz) / 2), lx + 0.05, 0.02, 0.025, 'wood', {});
    for (let i = 0; i < 6; i++) sw(trs(ox - lx / 2 + (lx * i) / 5, y + 0.205, oz), 0.02, 0.015, dz + 0.06, 'wood_lt', {}, 0);
    if (h(54) < 0.5) sw(trs(ox, y + 0.216, oz), lx + 0.04, 0.008, dz + 0.04, 'fabric_acc', { accent: acc2.clone().lerp(WHITE, 0.35) });
  };
  const awning = (ox: number, oz: number, w: number, y: number, c: THREE.Color) => piece('awning', trs(ox, y + 0.03, oz + 0.004).multiply(scaleM(w / 0.6, 1, 1)), { accent: c });
  /** Shuttered windows asked for by the house type (win over the generic windows there). */
  const shutters = (ox: number, oz: number, lx: number, y: number, n: number) => {
    for (let i = 0; i < n; i++) {
      const x = ox - lx / 2 + (lx * (i + 0.5)) / n;
      card(h(220 + i) < 0.3 ? 'win_closed' : 'win_shut', trs(x, y, oz + 0.004), { tint: wallC, accent: acc }, 2);
    }
  };
  const railing = (ox: number, oz: number, lx: number, dz: number, y: number) => {
    rail(ox - lx / 2, oz + dz / 2, ox + lx / 2, oz + dz / 2, y);
    rail(ox - lx / 2, oz - dz / 2, ox + lx / 2, oz - dz / 2, y);
    rail(ox - lx / 2, oz - dz / 2, ox - lx / 2, oz + dz / 2, y);
    rail(ox + lx / 2, oz - dz / 2, ox + lx / 2, oz + dz / 2, y);
  };
  const tanks = (ox: number, oz: number, y: number, n: number) => {
    for (let i = 0; i < n; i++) piece('tank', trs(ox + (i - (n - 1) / 2) * 0.17, y, oz, h(230 + i) * 6), { accent: h(70 + i) < 0.7 ? C(0.1, 0.1, 0.11) : C(0.86, 0.86, 0.83) });
  };
  const cafeTable = (x: number, z: number, c: THREE.Color) => piece('table', trs(x, 0, z, h(240 + Math.round(x * 10)) * 6), { accent: c });
  const tree = (x: number, z: number, r: number, hgt: number) => {
    sw(trs(x, hgt / 2, z), 0.035, hgt, 0.035, 'wood', {});
    const g = new THREE.IcosahedronGeometry(r, 1);
    B.swatchGeo(g, L(trs(x, hgt + r * 0.6, z).multiply(scaleM(1, 0.85, 1))), 'paint', { accent: C(0.24, 0.36, 0.16) });
    B.swatchGeo(g, L(trs(x + r * 0.45, hgt + r * 0.2, z - r * 0.3).multiply(scaleM(0.6))), 'paint', { accent: C(0.28, 0.4, 0.18) }, 0);
  };
  /** A card on both faces of a wall `half` deep (0: a gate standing in a gap), seen from both sides. */
  const card2 = (name: string, lm: THREE.Matrix4, o: KitOpts, sx: number, sy: number, half = 0) => {
    card(name, lm.clone().multiply(trs(0, 0, half + 0.004)), o, 3, sx, sy);
    card(name, lm.clone().multiply(trs(0, 0, -half - 0.004, Math.PI)), o, 3, sx, sy);
  };

  if (st.kind === StructureKind.Courtyard) {
    const t = h(55);
    if (st.look === 'mosque') {
      buildMosque();
      emitCards();
      return;
    }
    if (st.look === 'shops' || t < 0.3) {
      // a row of arcaded shops under flat roofs of different heights, coloured awnings
      for (let i = 0; i < 3; i++) {
        const ox = -0.82 + i * 0.82;
        const hw = 0.38 + h(60 + i) * 0.36;
        flatHouse(0.8, 1.2, hw, ox, -0.05, false, 0, i === 1 ? wc2 : wallC);
        card('shop', trs(ox, 0.135, 0.56), { tint: i === 1 ? wc2 : wallC, accent: ACCENTS[Math.floor(h(63 + i) * ACCENTS.length)] }, 3, 0.62 / 0.5, 0.27 / 0.3);
        awning(ox, 0.56, 0.62, 0.27, ACCENTS[Math.floor(h(63 + i) * ACCENTS.length)]);
        // goods out front: crates of fruit, or a rack of rugs
        const g = h(66 + i);
        if (g < 0.35)
          for (const sx of [-0.15, 0.05]) {
            sw(trs(ox + sx, 0.04, 0.68), 0.14, 0.08, 0.1, 'wood_lt', {});
            sw(trs(ox + sx, 0.083, 0.68), 0.12, 0.012, 0.08, 'paint', { accent: C(0.85, Math.min(1, 0.5 + g), 0.15) }, 0);
          }
        else if (g < 0.7) {
          sw(trs(ox, 0.1, 0.66), 0.36, 0.16, 0.02, 'fabric_acc', { accent: ACCENTS[Math.floor(g * 10) % ACCENTS.length].clone().lerp(C(0.7, 0.2, 0.15), 0.4) });
          for (const sx of [-0.19, 0.19]) sw(trs(ox + sx, 0.1, 0.66), 0.01, 0.2, 0.01, 'steel', {}, 0);
        }
        if (hw > 0.6) railing(ox, -0.05, 0.8, 1.2, hw + 0.08);
      }
      emitCards();
      return;
    }
    if (t < 0.65) {
      // a courtyard house: a two-storey back wing and two low side wings round a shaded court (a pergola
      // with a shade cloth, a small tree, a bench), a street wall with an arched gate
      flatHouse(2.6, 0.7, 0.6, 0, -0.62, false);
      railing(0, -0.62, 2.6, 0.7, 0.68);
      tanks(0.7, -0.7, 0.68, 2);
      for (const sx of [-1, 1]) flatHouse(0.62, 0.72, 0.36, sx * 1.0, 0.2, false, 0, sx > 0 ? wc2 : wallC);
      shutters(0, -0.27, 2.2, 0.44, 4);
      box(trs(0, 0.13, 0.86), 1.38, 0.26, 0.06, wallC);
      box(trs(0, 0.266, 0.86), 1.39, 0.012, 0.075, wallC.clone().multiplyScalar(1.04));
      card2('gate', trs(0.3, 0.13, 0.86), { tint: wallC, accent: acc }, 0.95, 1.0, 0.03);
      sw(trs(0, 0.004, 0.3), 1.36, 0.008, 1.0, 'stone', { color: C(0.8, 0.74, 0.62).multiplyScalar(1.15) });
      pergola(-0.25, 0.3, 0.9, 0.7, 0.0);
      tree(0.42, 0.32, 0.17, 0.3);
      sw(trs(-0.3, 0.06, 0.55), 0.3, 0.05, 0.09, 'wood', {});
      emitCards();
      return;
    }
    // a walled villa: two storeys at the back with a balcony and a dome, a garden wall with an arched gate
    flatHouse(2.2, 0.66, 0.6, 0, -0.4, false);
    balcony(0, -0.07, 1.6, 0.3);
    shutters(0, -0.07, 2.0, 0.44, 5);
    if (h(56) < 0.6) dome(0.2, 0.7, 0.68, -0.45, h(57) < 0.5 ? wallC : acc2.clone().lerp(WHITE, 0.2));
    else pergola(-0.5, -0.4, 0.7, 0.45, 0.66);
    flatHouse(0.55, 0.7, 0.36, -0.86, 0.32, true, 0, wc2);
    box(trs(0.25, 0.13, 0.72), 1.65, 0.26, 0.06, wallC);
    box(trs(1.1, 0.13, 0.33), 0.06, 0.26, 0.8, wallC);
    box(trs(0.25, 0.266, 0.72), 1.66, 0.012, 0.075, wallC.clone().multiplyScalar(1.04));
    box(trs(1.1, 0.266, 0.33), 0.075, 0.012, 0.81, wallC.clone().multiplyScalar(1.04));
    card2('gate', trs(0.35, 0.13, 0.72), { tint: wallC, accent: acc }, 0.95, 1.0, 0.03);
    sw(trs(0.2, 0.005, 0.32), 1.6, 0.01, 0.7, 'stone', { color: C(0.78, 0.72, 0.6).multiplyScalar(1.15) });
    if (h(250) < 0.6) tree(0.85, 0.35, 0.15, 0.28);
    emitCards();
    return;
  }

  // many town houses stand in a walled yard (the plot's edge, a gate on the street side, a tree inside)
  if (st.look !== 'shop' && h(90) < 0.6) {
    const yc = wallC.clone().multiplyScalar(0.96);
    const yh = 0.16 + h(91) * 0.08;
    box(trs(0, yh / 2, -0.93), 1.86, yh, 0.05, yc);
    for (const sx of [-1, 1]) box(trs(sx * 0.93, yh / 2, 0), 0.05, yh, 1.86, yc);
    for (const sx of [-1, 1]) box(trs(sx * 0.62, yh / 2, 0.93), 0.62, yh, 0.05, yc);
    // gate posts with caps, the gate in the gap
    for (const sx of [-1, 1]) {
      box(trs(sx * 0.3, yh / 2 + 0.02, 0.93), 0.08, yh + 0.04, 0.08, yc.clone().multiplyScalar(1.02));
      box(trs(sx * 0.3, yh + 0.048, 0.93), 0.1, 0.016, 0.1, yc.clone().multiplyScalar(1.06));
    }
    card2('gate', trs(0, yh * 0.47, 0.93), { tint: yc, accent: acc }, 0.52 / 0.32, (yh * 0.94) / 0.26);
    if (h(92) < 0.5) {
      const tx = h(93) < 0.5 ? -0.68 : 0.68;
      tree(tx, 0.76, 0.15, 0.26);
    }
  }
  // shop-houses face the streets; elsewhere the houses take any of the other looks
  const HOUSES = [0, 1, 2, 3, 4, 7, 8, 9];
  const type = st.look === 'shop' ? (h(58) < 0.55 ? 5 : 6) : HOUSES[Math.floor(h(58) * HOUSES.length)];
  if (type === 6) {
    // a corner cafe: a glazed shop front under a wide awning, tables with parasols on the pavement, rooms above
    flatHouse(1.3, 0.95, 0.66, 0, -0.12, false);
    for (const s of [-1, 1]) card('shop', trs(s * 0.275, 0.135, 0.36), { tint: wallC, accent: acc2.clone().lerp(WHITE, 0.5) }, 3, 1.1, 0.27 / 0.3);
    awning(0, 0.36, 1.24, 0.3, acc);
    shutters(0, 0.36, 1.3, 0.5, 3);
    for (const x of [-0.42, 0.0, 0.42]) cafeTable(x, 0.72, ACCENTS[Math.floor(h(80 + Math.round(x * 10)) * ACCENTS.length)].clone().lerp(WHITE, 0.35));
    tanks(-0.3, -0.35, 0.66, 2);
    emitCards();
    return;
  }
  if (type === 7) {
    // a narrow three-storey house: balconies on the upper floors, a railed roof terrace with water tanks
    flatHouse(0.95, 1.0, 0.95, -0.25, -0.05, true);
    for (const y of [0.34, 0.66]) balcony(-0.25, 0.45, 0.75, y);
    shutters(-0.25, 0.45, 0.95, 0.5, 2);
    railing(-0.25, -0.05, 0.95, 1.0, 1.0);
    tanks(-0.25, -0.3, 1.0, 3);
    flatHouse(0.55, 0.75, 0.32, 0.55, 0.12, false, 0, wc2);
    emitCards();
    return;
  }
  if (type === 8) {
    // an arched loggia house: an arcade below, an open loggia on the upper floor, a little dome on the roof
    flatHouse(1.35, 1.05, 0.64, 0, -0.05, false);
    arcade(0, -0.05, 1.35, 1.05, 0, 3, 0.24);
    arcade(0, -0.05, 0.9, 1.05, 0.39, 3, 0.1);
    dome(0.17, 0.42, 0.64, -0.3, h(59) < 0.5 ? wallC : acc2.clone().lerp(WHITE, 0.25));
    railing(-0.2, -0.05, 0.9, 1.0, 0.72);
    emitCards();
    return;
  }
  if (type === 9) {
    // an ochre two-storey house with an outside stair to the roof and a shade sail over the terrace
    const oc = C(0.86, 0.68, 0.45).multiplyScalar(WALL_LIFT);
    flatHouse(1.2, 1.0, 0.58, -0.1, -0.05, true, 0, oc);
    for (let i = 0; i < 5; i++) box(trs(0.6, 0.06 + i * 0.12, 0.3 - i * 0.12), 0.18, 0.04, 0.1, oc, true);
    // the stair's side wall and an iron handrail
    for (let i = 0; i < 5; i++) box(trs(0.68, 0.03 + i * 0.06, 0.3 - i * 0.12), 0.02, 0.06 + i * 0.12, 0.1, oc);
    {
      const a = V(0.69, 0.16, 0.35);
      const b2 = V(0.69, 0.64, -0.17);
      const len = a.distanceTo(b2);
      const mid = a.clone().add(b2).multiplyScalar(0.5);
      const pitch = Math.atan2(b2.y - a.y, -(b2.z - a.z));
      piece('rail', trs(mid.x, mid.y - 0.05, mid.z, Math.PI / 2, 0, 0).multiply(new THREE.Matrix4().makeRotationZ(pitch)).multiply(scaleM(len / 0.5, 0.9, 1)), { color: ironC.clone().multiplyScalar(4) }, 0);
    }
    sw(trs(-0.2, 0.86, -0.05, 0, 0.12), 0.8, 0.008, 0.6, 'fabric_acc', { accent: acc2.clone().lerp(WHITE, 0.5) });
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) sw(trs(-0.2 + sx * 0.4, 0.71, -0.05 + sz * 0.3), 0.01, 0.26, 0.01, 'steel', {});
    tanks(0.3, -0.35, 0.58, 2);
    emitCards();
    return;
  }
  if (type === 0) {
    // a cube on two floors: an arcade below, a roof terrace with a pergola
    flatHouse(1.3, 1.05, 0.62, 0, 0, false);
    arcade(0, 0, 1.3, 1.05, 0, 3);
    pergola(-0.2, -0.1, 0.7, 0.5, 0.62);
    shutters(0, 0.525, 1.3, 0.47, 3);
  } else if (type === 1) {
    // a domed house with a side room
    flatHouse(1.0, 1.0, 0.42, -0.15, 0, true);
    dome(0.34, -0.15, 0.42, 0, h(59) < 0.6 ? wallC : acc2.clone().lerp(WHITE, 0.25), 0.9);
    flatHouse(0.48, 0.62, 0.3, 0.55, 0.2, false, 0, wc2);
  } else if (type === 2) {
    // L-shaped: a three-storey wing with balconies and a low wing beside it
    flatHouse(0.72, 1.15, 0.9, -0.32, 0, true);
    balcony(-0.32, 0.575, 0.6, 0.3);
    balcony(-0.32, 0.575, 0.6, 0.6);
    flatHouse(0.68, 0.72, 0.36, 0.38, 0.22, false, 0, wc2);
    awning(0.38, 0.58, 0.5, 0.3, acc2);
    if (h(61) < 0.6) railing(-0.32, 0, 0.72, 1.15, 0.98);
  } else if (type === 3) {
    // stepped: a wide ground floor, the upper floor set back behind a terrace with an awning
    flatHouse(1.42, 1.15, 0.36, 0, 0, true);
    flatHouse(0.82, 0.62, 0.3, -0.25, -0.25, false, 0.36, wc2);
    sw(trs(-0.25, 0.64, 0.25, 0, 0.12), 0.7, 0.012, 0.36, 'fabric_acc', { accent: acc.clone().lerp(WHITE, 0.3) });
    for (const sx of [-0.55, 0.05]) sw(trs(sx, 0.49, 0.42), 0.02, 0.26, 0.02, 'wood', {});
    rail(-0.7, 0.57, 0.7, 0.57, 0.44);
  } else if (type === 4) {
    // a small apartment block: three floors of balconies, a stair head on the roof
    flatHouse(1.36, 1.0, 0.86, 0, 0, true);
    for (const y of [0.29, 0.57]) balcony(0, 0.5, 1.2, y);
    shutters(0, 0.5, 1.36, 0.72, 3);
    if (h(60) < 0.5) dome(0.14, 0.4, 0.86, -0.25, acc2);
    else {
      railing(0, 0, 1.36, 1.0, 0.94);
      tanks(-0.3, -0.25, 0.94, 3);
    }
  } else {
    // a shop-house: the shop below behind a deep awning, two floors above
    flatHouse(1.3, 1.08, 0.7, 0, 0, false);
    for (const s of [-1, 1]) card('shop', trs(s * 0.25, 0.13, 0.545), { tint: wallC, accent: acc2 }, 3, 1.0, 0.26 / 0.3);
    awning(0, 0.545, 1.14, 0.29, acc);
    shutters(0, 0.54, 1.3, 0.52, 3);
  }
  emitCards();

  /**
   * The town mosque (generic): a white prayer hall with lattice windows and a crown of stepped merlons, an
   * arcaded portico, the big ribbed dome on its windowed drum with a crescent finial, two small domes, a walled
   * forecourt with an arched gate and an ablution fountain, and the minaret: a square base, an octagonal
   * shaft with arched panels, a corbelled balcony with a balustrade, the upper shaft, a green cap, a crescent.
   */
  function buildMosque() {
    const mw = wallC.clone().lerp(WHITE, 0.6);
    const hx = -0.42;
    const hz = -0.28;
    const LX = 1.85;
    const DZ = 1.3;
    const HW = 0.52;
    // the hall: body, parapet with coping, roof
    box(trs(hx, HW / 2, hz), LX, HW, DZ, mw);
    box(trs(hx, HW + 0.03, hz + DZ / 2 - 0.025), LX, 0.06, 0.05, mw);
    box(trs(hx, HW + 0.03, hz - DZ / 2 + 0.025), LX, 0.06, 0.05, mw);
    for (const s of [-1, 1]) box(trs(hx + s * (LX / 2 - 0.025), HW + 0.03, hz), 0.05, 0.06, DZ - 0.1, mw);
    box(trs(hx, HW + 0.006, hz), LX - 0.1, 0.012, DZ - 0.1, mw.clone().multiplyScalar(0.8));
    // a moulded band under the parapet
    box(trs(hx, HW - 0.02, hz), LX + 0.02, 0.018, DZ + 0.02, mw.clone().multiplyScalar(1.03));
    // merlons along the parapet
    for (const s of [-1, 1]) {
      const n = Math.round(LX / 0.1);
      for (let i = 0; i < n; i++) piece('merlon', trs(hx - LX / 2 + (LX * (i + 0.5)) / n, HW + 0.06, hz + s * (DZ / 2 - 0.025)), { tint: mw }, 0);
      const k = Math.round(DZ / 0.1);
      for (let i = 1; i < k - 1; i++) piece('merlon', trs(hx + s * (LX / 2 - 0.025), HW + 0.06, hz - DZ / 2 + (DZ * (i + 0.5)) / k, Math.PI / 2), { tint: mw }, 0);
    }
    // the drum + dome, the small domes over the portico ends
    piece('mdome', trs(hx, HW + 0.012, hz).multiply(scaleM(0.42 / 0.44)), { tint: C(0.93, 0.95, 0.96) });
    for (const sx of [-1, 1]) {
      box(trs(hx + sx * 0.72, HW + 0.03, 0.22), 0.3, 0.06, 0.3, mw);
      dome(0.13, hx + sx * 0.72, HW + 0.06, 0.22, mw, 1.1);
    }
    // the portico: an arcade on the front, a door inside
    arcade(hx, hz, LX, DZ, 0.0, 5, 0.27, mw);
    // lattice windows down the sides and on the back
    for (const sx of [-1, 1])
      for (const z of [-0.6, -0.15]) card('win_tall', trs(hx + sx * (LX / 2 + 0.003), 0.28, z, (sx * Math.PI) / 2), { tint: mw }, 1);
    for (const x of [-0.6, -0.2, 0.2, 0.6]) card('win_tall', trs(hx + x, 0.28, hz - DZ / 2 - 0.003, Math.PI), { tint: mw }, 1);
    // the forecourt wall with merlons and its gate, the court paved in pale stone, a fountain
    box(trs(-0.15, 0.1, 0.92), 2.3, 0.2, 0.05, mw);
    box(trs(-1.38, 0.1, 0.66), 0.05, 0.2, 0.55, mw);
    for (let i = 0; i < 20; i++) if (Math.abs(-1.27 + i * 0.115 - hx) > 0.2) piece('merlon', trs(-1.27 + i * 0.115, 0.2, 0.92).multiply(scaleM(0.8)), { tint: mw }, 0);
    for (const sx of [-1, 1]) box(trs(hx + sx * 0.17, 0.15, 0.92), 0.07, 0.3, 0.08, mw.clone().multiplyScalar(1.02));
    card2('gate', trs(hx, 0.13, 0.92), { tint: mw, accent: C(0.32, 0.22, 0.14) }, 1, 1, 0.025);
    sw(trs(hx, 0.004, 0.64), 1.95, 0.008, 0.55, 'stone', { color: C(0.86, 0.82, 0.74).multiplyScalar(1.12) });
    B.plaster(new THREE.CylinderGeometry(0.13, 0.14, 0.06, 8).translate(0, 0.03, 0), L(trs(hx + 0.5, 0, 0.64)), mw, gy);
    sw(trs(hx + 0.5, 0.055, 0.64), 0.2, 0.004, 0.2, 'glass', { color: C(0.5, 0.75, 0.85) }, 0);
    // the minaret
    piece('minaret', trs(1.08, 0, 0.42), { tint: mw });
  }
}

