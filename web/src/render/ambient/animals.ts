import * as THREE from 'three';
import { StructureKind, type GameMap } from '../../sim/map';
import type { FogOfWar } from '../fog';
import { FieldType, type Field, type Layout, type V2 } from '../layout';
import { camelModel, catModel, chickenModel, deerModel, dogModel, goatModel, hareModel, horseModel } from '../models/animals';
import { Opt, Pose } from '../models/civilians';
import { cowModel, sheepModel, type AnimalModel } from './models';
import type { Figure } from './people';
import { AnimInstances, ambientMaterial, groundAt, walkable, wrapAngle, type AmbientFrame, type FogProbe, type Quality } from './shared';

/*
 * Livestock and wildlife.
 *
 *  - Farmland (temperate): herds of cows and sheep in the pastures (fallow /
 *    green fields), sheep with a shepherd and his dog circling the flock,
 *    horses in a paddock, chickens pecking in the yards, stray dogs about
 *    the villages.
 *  - Desert: a camel caravan plodding along a track behind its leader, goats
 *    by the mud houses, a few chickens and dogs.
 *  - Winter: deer browsing in the forests, hares at the wood edges, a flock
 *    of sheep on the snowy fields.
 *  - City: cats on the pavements and in the parks, stray dogs (pigeons: birds.ts).
 *
 * They graze / peck with their heads down, wander a few steps at a time and
 * keep loosely together. Explosions, gunfire and military units send the
 * whole herd running away (each species its own gait: cows lumber, horses
 * and deer gallop, hares zig-zag); after a while they calm down and amble
 * back. Animals caught in a blast fall over dead (render only, no gore).
 *
 * Legs, head and body bob are animated in the vertex shader: one instanced
 * draw call per species present; shepherds and the caravan leader are drawn
 * with the civilians (people.ts `figures`). Visible animals are capped.
 */

const enum A {
  Graze = 0,
  Walk = 1,
  Panic = 2,
  Alert = 3,
  Return = 4,
  Dead = 5,
}

export const enum Sp {
  Cow = 0,
  Sheep = 1,
  Horse = 2,
  Dog = 3,
  Chicken = 4,
  Camel = 5,
  Goat = 6,
  Deer = 7,
  Hare = 8,
  Cat = 9,
}

interface SpDef {
  name: string;
  model: () => AnimalModel;
  walk: number;
  run: number;
  /** Phase advance per tile: stride length. */
  stride: number;
  bodyY: number;
  halfW: number;
  /** Draw scale (the original cows / sheep up to the civilians' scale). */
  scale: number;
  coats: number[];
  /** Wander radius factor and time between wanders. */
  rest: number;
}

const SPECIES: SpDef[] = [
  { name: 'cows', model: cowModel, walk: 0.13, run: 0.95, stride: 0.12, bodyY: 0.165, halfW: 0.065, scale: 1.45, coats: [0x2a2522, 0x6b4a32, 0x8a5a36, 0xe8e2d8, 0x3a2e28, 0xb08860, 0x5a3a28], rest: 8 },
  { name: 'sheep', model: sheepModel, walk: 0.16, run: 1.15, stride: 0.09, bodyY: 0.13, halfW: 0.07, scale: 1.25, coats: [0xe8e2d2, 0xdcd4c0, 0xf0ebe0, 0xcfc6b2, 0x8a8278], rest: 8 },
  { name: 'horses', model: horseModel, walk: 0.2, run: 1.5, stride: 0.22, bodyY: 0.34, halfW: 0.075, scale: 1, coats: [0x5a3a22, 0x3a2416, 0x8a5a32, 0x1c1814, 0xd8d0c4, 0x9a7a5a], rest: 9 },
  { name: 'dogs', model: dogModel, walk: 0.3, run: 1.5, stride: 0.1, bodyY: 0.115, halfW: 0.035, scale: 1.1, coats: [0x3a2a1c, 0xc8a070, 0x1c1a18, 0x8a6a4a, 0xe0d8c8, 0x6a5a4a], rest: 6 },
  { name: 'chickens', model: chickenModel, walk: 0.1, run: 0.6, stride: 0.035, bodyY: 0.065, halfW: 0.03, scale: 1.35, coats: [0xf0ece2, 0xa05a2a, 0x7a3a1c, 0x2a2420, 0xd8b890], rest: 2.5 },
  { name: 'camels', model: camelModel, walk: 0.2, run: 0.9, stride: 0.25, bodyY: 0.42, halfW: 0.075, scale: 1, coats: [0xc8a070, 0xb8905a, 0xd8b888, 0xa07a50], rest: 9 },
  { name: 'goats', model: goatModel, walk: 0.15, run: 1.2, stride: 0.09, bodyY: 0.15, halfW: 0.045, scale: 1.1, coats: [0x2a2420, 0x6a4a2a, 0xe8e2d8, 0x8a6a4a, 0xb89a7a], rest: 5 },
  { name: 'deer', model: deerModel, walk: 0.15, run: 1.7, stride: 0.18, bodyY: 0.25, halfW: 0.05, scale: 1, coats: [0x8a5a32, 0x7a4e2a, 0x9a6a3a, 0x6a4422], rest: 7 },
  { name: 'hares', model: hareModel, walk: 0.1, run: 1.6, stride: 0.09, bodyY: 0.055, halfW: 0.03, scale: 1.35, coats: [0x8a7a62, 0x7a6a52, 0xe8e6e0, 0x9a8a72], rest: 4 },
  { name: 'cats', model: catModel, walk: 0.1, run: 1.3, stride: 0.06, bodyY: 0.058, halfW: 0.022, scale: 1.45, coats: [0x2a2420, 0xd08a40, 0x8a8278, 0xe8e2d8, 0x5a4a3a, 0x1c1a18], rest: 10 },
].map((d) => ({ ...d }));

interface Animal {
  sp: Sp;
  x: number;
  y: number;
  yaw: number;
  v: number;
  s: A;
  t: number;
  tx: number;
  ty: number;
  head: number;
  phase: number;
  gait: number;
  roll: number;
  hgt: number;
  hop: number;
  paint: THREE.Color;
  fx: number;
  fy: number;
  size: number;
}

const enum H {
  Graze = 0,
  Shepherded = 1,
  Caravan = 2,
  Loner = 3,
}

interface Herd {
  sp: Sp;
  kind: H;
  f: Field;
  animals: Animal[];
  /** Shepherd / caravan leader (drawn by people.ts). */
  man: Figure | null;
  dog: Animal | null;
  dogA: number;
  /** Caravan: route (there and back, offset to the right), arc lengths, leader arc, spacing. */
  route: V2[] | null;
  cum: Float32Array | null;
  arc: number;
  pause: number;
  scattered: number;
  mx: number;
  my: number;
  mv: number;
}

const _m = new THREE.Matrix4();
const _r = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _pt = { x: 0, y: 0, tx: 1, ty: 0 };

const zone = (cx: number, cy: number, hl: number, hw: number, angle = 0): Field => ({ cx, cy, hl, hw, angle, type: FieldType.Fallow });

export class Animals {
  readonly group = new THREE.Group();
  private herds: Herd[] = [];
  private inst: (AnimInstances | null)[] = [];
  private cap: number;
  private time = 0;

  constructor(
    private map: GameMap,
    layout: Layout,
    fog: FogOfWar,
    private probe: FogProbe,
    quality: Quality,
    phone: boolean,
    private figures: Figure[] = [],
  ) {
    const m = map;
    const biome = m.biome;
    const qk = quality === 'high' ? 1.4 : quality === 'medium' ? 1 : 0.6;
    const k = qk * (phone ? 0.75 : 1);
    this.cap = quality === 'high' ? 90 : quality === 'medium' ? 40 : 20;
    if (phone) this.cap = Math.min(this.cap, 40);
    const far = (x: number, y: number, r = 11) => m.starts.every((s) => Math.hypot(s.x - x, s.y - y) > r);
    const shuffle = <T>(a: T[]) => {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    // ---- pastures: cows / sheep / horses / goats
    const pastures = shuffle(layout.fields.filter((f) => (f.type === FieldType.Fallow || f.type === FieldType.Green) && f.hl > 1 && f.hw > 0.8).filter((f) => far(f.cx, f.cy) && this.clear(f)));
    const houses = m.structures.filter((s) => s.kind !== StructureKind.Tower && s.kind !== StructureKind.WaterTower && s.kind !== StructureKind.Silo && far(s.x, s.y, 12));
    const yard = (st: { x: number; y: number; w: number; h: number; rot: number }, back: boolean, r: number): Field | null => {
      const dirs = [
        [0, 1],
        [1, 0],
        [0, -1],
        [-1, 0],
      ];
      const [dx, dy] = dirs[(st.rot + (back ? 2 : 0)) & 3];
      const cx = st.x + st.w / 2 + dx * (st.w / 2 + 0.9);
      const cy = st.y + st.h / 2 + dy * (st.h / 2 + 0.9);
      const f = zone(cx, cy, r, r * 0.8);
      let ok = 0;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (walkable(m, cx + i * r * 0.7, cy + j * r * 0.6)) ok++;
      return ok >= 7 ? f : null;
    };
    const add = (sp: Sp, kind: H, f: Field, n: number, base?: THREE.Color) => {
      const def = SPECIES[sp];
      const herd: Herd = { sp, kind, f, animals: [], man: null, dog: null, dogA: 0, route: null, cum: null, arc: 0, pause: 0, scattered: 0, mx: f.cx, my: f.cy, mv: 0 };
      const coats = def.coats;
      const b0 = base ?? new THREE.Color(coats[(Math.random() * coats.length) | 0]);
      for (let i = 0; i < n; i++) {
        const p = this.fieldPoint(f, 0.6);
        const coat = (Math.random() < 0.7 ? b0.clone() : new THREE.Color(coats[(Math.random() * coats.length) | 0])).multiplyScalar(0.9 + Math.random() * 0.2);
        herd.animals.push(this.animal(sp, p.x, p.y, coat));
      }
      this.herds.push(herd);
      return herd;
    };
    if (biome === 'temperate' || biome === 'winter') {
      const nHerds = Math.max(1, Math.round((biome === 'winter' ? 2 : 5) * k));
      let shep = 0;
      for (const f of pastures.slice(0, nHerds)) {
        const sp = biome === 'winter' ? Sp.Sheep : Math.random() < 0.5 ? Sp.Cow : Sp.Sheep;
        const n = sp === Sp.Cow ? 3 + Math.floor(Math.random() * 4) : 5 + Math.floor(Math.random() * 5);
        const h = add(sp, H.Graze, f, n);
        if (sp === Sp.Sheep && shep < 2) {
          shep++;
          this.shepherd(h, biome);
        }
      }
      // horses in a paddock
      if (biome === 'temperate')
        for (const f of pastures.slice(nHerds, nHerds + Math.max(1, Math.round(1.5 * k)))) add(Sp.Horse, H.Graze, f, 2 + Math.floor(Math.random() * 3));
    }
    if (biome === 'desert') {
      // goats by the houses / on the irrigated plots
      const plots = shuffle([...pastures, ...layout.fields.filter((f) => f.type === FieldType.Wheat && far(f.cx, f.cy) && this.clear(f))]);
      const nG = Math.max(1, Math.round(3 * k));
      for (let i = 0; i < nG; i++) {
        const st = houses[(Math.random() * houses.length) | 0];
        const f = (Math.random() < 0.5 && st ? yard(st, true, 1.2) : null) ?? plots[i];
        if (!f) continue;
        const h = add(Sp.Goat, H.Graze, f, 4 + Math.floor(Math.random() * 4));
        if (i === 0) this.shepherd(h, biome);
      }
      // the caravan
      this.caravan(layout, Math.random() < 0.5 && k > 0.9 ? 6 : 4);
    }
    if (biome === 'winter') {
      // deer in the forests, hares at the edges
      const woods = this.woods(far);
      for (const w of woods.slice(0, Math.max(1, Math.round(3 * k)))) add(Sp.Deer, H.Graze, zone(w.x, w.y, 2.2, 1.8), 2 + Math.floor(Math.random() * 3));
      for (const w of woods.slice(0, Math.round(5 * k))) add(Sp.Hare, H.Loner, zone(w.x + 1.5, w.y, 2, 2), 1);
    }
    if (biome !== 'urban') {
      // chickens in the yards, stray dogs about the villages
      const nC = Math.round((biome === 'winter' ? 1 : 3) * k);
      for (const st of shuffle([...houses]).slice(0, nC * 3)) {
        if (this.herds.filter((h) => h.sp === Sp.Chicken).length >= nC) break;
        const f = yard(st, Math.random() < 0.5, 0.7);
        if (f) add(Sp.Chicken, H.Graze, f, 4 + Math.floor(Math.random() * 4));
      }
      const nD = Math.round(2.5 * k);
      for (const st of shuffle([...houses]).slice(0, nD)) {
        const f = zone(st.x + st.w / 2, st.y + st.h / 2, 3.5, 3.5);
        const p = this.fieldPoint(f, 1);
        if (p.x === f.cx && p.y === f.cy) continue;
        add(Sp.Dog, H.Loner, f, 1);
      }
    } else {
      // cats on the pavements and in the parks, a stray dog or two
      const nCat = Math.round(6 * k);
      const spots: V2[] = [];
      for (const p of m.deco?.parks ?? []) spots.push({ x: (p.x0 + p.x1) / 2, y: (p.y0 + p.y1) / 2 });
      for (const st of shuffle([...houses]).slice(0, 12)) spots.push({ x: st.x + st.w / 2, y: st.y + st.h + 0.4 });
      for (const s of shuffle(spots).slice(0, nCat)) {
        const f = zone(s.x, s.y, 1.6, 1.6);
        const p = this.fieldPoint(f, 1);
        if (!walkable(m, p.x, p.y)) continue;
        add(Sp.Cat, H.Loner, f, 1);
      }
      for (const s of spots.slice(nCat, nCat + Math.round(2 * k))) add(Sp.Dog, H.Loner, zone(s.x, s.y, 4, 4), 1);
    }
    // ---- one instanced mesh per species present
    const counts = new Array(SPECIES.length).fill(0);
    for (const h of this.herds) for (const a of h.animals) counts[a.sp]++;
    for (const h of this.herds) if (h.dog) counts[Sp.Dog]++;
    SPECIES.forEach((def, i) => {
      if (!counts[i]) {
        this.inst.push(null);
        return;
      }
      const mdl = def.model();
      const mat = ambientMaterial(fog, 'animal', mdl.rig, 0.95, 0);
      const inst = new AnimInstances(mdl.geo, mat, counts[i], `ambient-${def.name}`, { shadow: quality === 'high', heat: true });
      this.inst.push(inst);
      this.group.add(inst.mesh);
    });
  }

  private animal(sp: Sp, x: number, y: number, paint: THREE.Color): Animal {
    return { sp, x, y, yaw: Math.random() * 6.28, v: 0, s: A.Graze, t: Math.random() * 10, tx: x, ty: y, head: 1, phase: Math.random() * 6, gait: 0, roll: 0, hgt: groundAt(this.map, x, y), hop: 0, paint, fx: 0, fy: 0, size: 0.9 + Math.random() * 0.2 };
  }

  private man(biome: string): Figure {
    const desert = biome === 'desert';
    const winter = biome === 'winter';
    const C = (h: number) => new THREE.Color(h);
    const tops = desert ? [0xe8e2d4, 0xc8b898, 0x8a7a62] : winter ? [0x4a3a2a, 0x2a2e36, 0x5a4a32] : [0x5a4a32, 0x3a4a2a, 0x6a5a40];
    return {
      x: 0,
      y: 0,
      yaw: 0,
      hgt: 0,
      size: 1,
      phase: 0,
      stride: 0,
      pose: Pose.Walk,
      mask: desert ? Opt.Robe | Opt.Keffiyeh | Opt.Cane : winter ? Opt.Coat | Opt.Beanie | Opt.Cane : Opt.BrimHat | Opt.Cane,
      lean: 0.05,
      skin: C(desert ? 0xb08058 : 0xe0b898),
      top: C(tops[(Math.random() * tops.length) | 0]),
      bot: C(desert ? 0xc8bca0 : 0x3a3428),
      hat: C(desert ? 0xd04040 : winter ? 0x8a2a2a : 0x4a3a2a),
      show: true,
    };
  }

  /** A shepherd standing by the flock and his dog circling it. */
  private shepherd(h: Herd, biome: string) {
    const f = this.man(biome);
    const c = h.animals[0];
    f.x = c.x + 0.8;
    f.y = c.y;
    f.hgt = groundAt(this.map, f.x, f.y);
    h.man = f;
    h.kind = H.Shepherded;
    this.figures.push(f);
    const dog = this.animal(Sp.Dog, c.x - 0.8, c.y, new THREE.Color(Math.random() < 0.5 ? 0x1c1a18 : 0x3a2a1c));
    dog.s = A.Walk;
    h.dog = dog;
  }

  /** Forest clearings: open spots surrounded by trees. */
  private woods(far: (x: number, y: number, r?: number) => boolean): V2[] {
    const m = this.map;
    const out: V2[] = [];
    for (let k = 0; k < 900 && out.length < 12; k++) {
      const x = 2 + Math.random() * (m.w - 4);
      const y = 2 + Math.random() * (m.h - 4);
      if (!walkable(m, x, y) || m.trees[(y | 0) * m.w + (x | 0)] || !far(x, y, 13)) continue;
      let wood = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (m.trees[Math.max(0, Math.min(m.h - 1, (y | 0) + dy)) * m.w + Math.max(0, Math.min(m.w - 1, (x | 0) + dx))]) wood++;
      if (wood >= 6 && out.every((o) => Math.hypot(o.x - x, o.y - y) > 5)) out.push({ x, y });
    }
    return out;
  }

  /** Camel caravan on the longest desert track (or country road) away from the bases. */
  private caravan(layout: Layout, n: number) {
    const m = this.map;
    let best: V2[] | null = null;
    let bl = 10;
    const lines = [...layout.tracks.filter((t) => !t.ring).map((t) => t.pts), ...layout.roads.filter((r) => r.variant === 1 && !r.ring && !r.lot).map((r) => r.pts)];
    for (const pts of lines) {
      // the longest run that stays clear of the bases
      let run: V2[] = [];
      const flush = () => {
        let L = 0;
        for (let i = 1; i < run.length; i++) L += Math.hypot(run[i].x - run[i - 1].x, run[i].y - run[i - 1].y);
        if (L > bl) {
          bl = L;
          best = run;
        }
        run = [];
      };
      for (const p of pts) {
        if (m.starts.some((s) => Math.hypot(s.x - p.x, s.y - p.y) < 14) || !walkable(m, p.x, p.y)) flush();
        else run.push(p);
      }
      flush();
    }
    const route0 = best as V2[] | null;
    if (!route0) return;
    const pts = route0.length > 120 ? route0.slice(0, 120) : route0;
    // there on the right of the track, back on the other side
    const off = (p: V2[], s: number) =>
      p.map((q, i) => {
        const a = p[Math.max(0, i - 1)];
        const b = p[Math.min(p.length - 1, i + 1)];
        const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        return { x: q.x - ((b.y - a.y) / L) * s, y: q.y + ((b.x - a.x) / L) * s };
      });
    const there = off(pts, 0.5);
    const back = off([...pts].reverse(), 0.5);
    const route = [...there, ...back];
    const cum = new Float32Array(route.length + 1);
    for (let i = 1; i <= route.length; i++) cum[i] = cum[i - 1] + Math.hypot(route[i % route.length].x - route[i - 1].x, route[i % route.length].y - route[i - 1].y);
    const coats = SPECIES[Sp.Camel].coats;
    const f = zone(pts[0].x, pts[0].y, 3, 3);
    const h: Herd = { sp: Sp.Camel, kind: H.Caravan, f, animals: [], man: this.man('desert'), dog: null, dogA: 0, route, cum, arc: Math.random() * cum[route.length], pause: 0, scattered: 0, mx: 0, my: 0, mv: 0 };
    h.man!.mask = Opt.Robe | Opt.Keffiyeh;
    for (let i = 0; i < n; i++) {
      this.routeAt(h, h.arc - 0.5 - i * 0.75);
      h.animals.push(this.animal(Sp.Camel, _pt.x, _pt.y, new THREE.Color(coats[(Math.random() * coats.length) | 0]).multiplyScalar(0.92 + Math.random() * 0.16)));
    }
    this.routeAt(h, h.arc);
    h.man!.x = _pt.x;
    h.man!.y = _pt.y;
    this.figures.push(h.man!);
    this.herds.push(h);
  }

  /** Point / tangent at arc `a` along a caravan route (wraps), into _pt. */
  private routeAt(h: Herd, a: number) {
    const r = h.route!;
    const c = h.cum!;
    const L = c[r.length];
    let s = a % L;
    if (s < 0) s += L;
    let lo = 0;
    let hi = r.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (c[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    const p = r[lo];
    const q = r[(lo + 1) % r.length];
    const seg = c[lo + 1] - c[lo] || 1;
    const t = (s - c[lo]) / seg;
    _pt.x = p.x + (q.x - p.x) * t;
    _pt.y = p.y + (q.y - p.y) * t;
    _pt.tx = (q.x - p.x) / seg;
    _pt.ty = (q.y - p.y) / seg;
  }

  /** Most of the field is open ground (no tech building / base sprawl on it). */
  private clear(f: Field) {
    const ca = Math.cos(f.angle);
    const sa = Math.sin(f.angle);
    let ok = 0;
    for (let i = -2; i <= 2; i++)
      for (let j = -1; j <= 1; j++) {
        const a = (i / 2) * (f.hl - 0.3);
        const b = j * (f.hw - 0.3);
        if (walkable(this.map, f.cx + ca * a - sa * b, f.cy + sa * a + ca * b)) ok++;
      }
    return ok >= 14;
  }

  private fieldPoint(f: Field, spread: number) {
    const ca = Math.cos(f.angle);
    const sa = Math.sin(f.angle);
    for (let k = 0; k < 8; k++) {
      const a = (Math.random() - 0.5) * 2 * Math.max(0.2, f.hl - 0.4) * spread;
      const b = (Math.random() - 0.5) * 2 * Math.max(0.2, f.hw - 0.3) * spread;
      const x = f.cx + ca * a - sa * b;
      const y = f.cy + sa * a + ca * b;
      if (walkable(this.map, x, y)) return { x, y };
    }
    return { x: f.cx, y: f.cy };
  }

  private inField(f: Field, x: number, y: number) {
    const dx = x - f.cx;
    const dy = y - f.cy;
    const ca = Math.cos(f.angle);
    const sa = Math.sin(f.angle);
    return Math.abs(dx * ca + dy * sa) < f.hl && Math.abs(-dx * sa + dy * ca) < f.hw;
  }

  get count() {
    let n = 0;
    for (const h of this.herds) n += h.animals.length + (h.dog ? 1 : 0);
    return n;
  }

  /** Debug / tests: per species counts. */
  debug() {
    const out: Record<string, number> = {};
    for (const h of this.herds) {
      out[SPECIES[h.sp].name] = (out[SPECIES[h.sp].name] ?? 0) + h.animals.length;
      if (h.dog) out.dogs = (out.dogs ?? 0) + 1;
    }
    return out;
  }

  update(f: AmbientFrame) {
    const dt = Math.min(0.1, f.dt);
    this.time += dt;
    for (const h of this.herds) {
      // herd centre (cohesion)
      let hx = 0;
      let hy = 0;
      let live = 0;
      for (const a of h.animals)
        if (a.s !== A.Dead) {
          hx += a.x;
          hy += a.y;
          live++;
        }
      if (!live) {
        if (h.man) this.manIdle(h.man, dt, null);
        continue;
      }
      hx /= live;
      hy /= live;
      // scares: the whole herd bolts when any of them is close to the danger
      for (const d of f.dangers) {
        let hit = false;
        for (const a of h.animals) {
          if (a.s === A.Dead) continue;
          const dist = Math.hypot(a.x - d.x, a.y - d.y);
          if (d.kill > 0 && dist < d.kill * 0.9) {
            a.s = A.Dead;
            a.v = 0;
            continue;
          }
          if (dist < d.r * (h.sp === Sp.Deer || h.sp === Sp.Hare ? 1.5 : 1)) hit = true;
        }
        if (h.dog && h.dog.s !== A.Dead && d.kill > 0 && Math.hypot(h.dog.x - d.x, h.dog.y - d.y) < d.kill * 0.9) h.dog.s = A.Dead;
        if (hit) this.bolt(h, d.x, d.y, d.power);
      }
      // military units walking or driving close (wildlife and cats are shyer)
      const shy = h.sp === Sp.Deer || h.sp === Sp.Hare || h.sp === Sp.Cat ? 5 : 3.6;
      for (let i = 0; i < f.nUnits; i++) {
        const ux = f.units[i * 2];
        const uy = f.units[i * 2 + 1];
        if (Math.abs(ux - hx) < shy && Math.abs(uy - hy) < shy && Math.hypot(ux - hx, uy - hy) < shy) {
          this.bolt(h, ux, uy, 0.3);
          break;
        }
      }
      if (h.kind === H.Caravan) this.march(h, dt);
      for (const a of h.animals) this.step(h, a, dt, hx, hy);
      if (h.dog) this.stepDog(h, h.dog, dt, hx, hy);
      if (h.man && h.kind === H.Shepherded) this.stepShepherd(h, h.man, dt, hx, hy);
    }
  }

  private bolt(h: Herd, sx: number, sy: number, power: number) {
    const all = h.dog ? [...h.animals, h.dog] : h.animals;
    for (const a of all) {
      if (a.s === A.Dead) continue;
      let dx = a.x - sx;
      let dy = a.y - sy;
      const l = Math.hypot(dx, dy) || 1;
      dx /= l;
      dy /= l;
      a.fx = dx;
      a.fy = dy;
      if (a.s !== A.Panic) a.t = 0;
      a.s = A.Panic;
      // louder = longer run (keeps running while it keeps happening)
      a.t = Math.min(a.t, -(2.5 + power * 3 + Math.random() * 1.5));
    }
    if (h.man) {
      h.mx = sx;
      h.my = sy;
      h.mv = 4 + power * 4;
    }
    if (h.kind === H.Caravan) h.scattered = 1;
  }

  /** Caravan on the march: slots along the route behind the leader. */
  private march(h: Herd, dt: number) {
    const man = h.man!;
    if (h.scattered) {
      // gather again: all back near their slots before moving on
      let back = true;
      for (let i = 0; i < h.animals.length; i++) {
        const a = h.animals[i];
        if (a.s === A.Dead) continue;
        this.routeAt(h, h.arc - 0.5 - i * 0.75);
        if (a.s === A.Panic || a.s === A.Alert || Math.hypot(a.x - _pt.x, a.y - _pt.y) > 0.3) back = false;
        if (a.s === A.Graze || a.s === A.Walk || a.s === A.Return) {
          if (a.s !== A.Return || Math.hypot(a.tx - _pt.x, a.ty - _pt.y) > 0.05) a.t = 0;
          a.s = A.Return;
          a.tx = _pt.x;
          a.ty = _pt.y;
        }
      }
      this.manIdle(man, dt, h);
      if (back) h.scattered = 0;
      return;
    }
    // rest a while at the ends of the route
    h.pause -= dt;
    let v = 0;
    if (h.pause <= 0) {
      v = 0.17;
      const L = h.cum![h.route!.length];
      const half = L / 2;
      const before = h.arc % L;
      h.arc += v * dt;
      const after = h.arc % L;
      if ((before < half && after >= half) || after < before) h.pause = 12 + Math.random() * 10;
    }
    this.routeAt(h, h.arc);
    man.yaw = Math.atan2(_pt.ty, _pt.tx);
    man.x = _pt.x;
    man.y = _pt.y;
    man.hgt += (groundAt(this.map, man.x, man.y) - man.hgt) * Math.min(1, dt * 10);
    man.phase += ((v * dt) / (1.45 * 0.264)) * Math.PI * 2;
    man.stride += ((v > 0 ? 1 : 0) - man.stride) * Math.min(1, dt * 5);
    man.pose = v > 0 ? Pose.HoldHand : Pose.Walk;
    for (let i = 0; i < h.animals.length; i++) {
      const a = h.animals[i];
      if (a.s === A.Dead || a.s === A.Panic || a.s === A.Alert) continue;
      this.routeAt(h, h.arc - 0.5 - i * 0.75);
      a.s = A.Walk;
      a.tx = _pt.x;
      a.ty = _pt.y;
      a.t = 0;
    }
  }

  /** The shepherd strolls after the flock, leaning on his staff; runs off when it bolts. */
  private stepShepherd(h: Herd, f: Figure, dt: number, hx: number, hy: number) {
    let tx = hx + 0.9;
    let ty = hy + 0.4;
    let sp = 0;
    let run = false;
    if (h.mv > 0) {
      h.mv -= dt;
      const dx = f.x - h.mx;
      const dy = f.y - h.my;
      const l = Math.hypot(dx, dy) || 1;
      tx = f.x + (dx / l) * 2;
      ty = f.y + (dy / l) * 2;
      sp = 0.9;
      run = true;
    }
    const dx = tx - f.x;
    const dy = ty - f.y;
    const d = Math.hypot(dx, dy);
    if (!run) sp = d > 1.2 ? 0.3 : d > 0.4 ? 0.12 : 0;
    if (sp > 0) {
      f.yaw = wrapAngle(f.yaw + Math.max(-dt * 4, Math.min(dt * 4, wrapAngle(Math.atan2(dy, dx) - f.yaw))));
      const nx = f.x + Math.cos(f.yaw) * sp * dt;
      const ny = f.y + Math.sin(f.yaw) * sp * dt;
      if (walkable(this.map, nx, ny)) {
        f.x = nx;
        f.y = ny;
      }
    } else f.yaw = wrapAngle(f.yaw + Math.max(-dt, Math.min(dt, wrapAngle(Math.atan2(hy - f.y, hx - f.x) - f.yaw))));
    f.phase += ((sp * dt) / ((run ? 1.9 : 1.45) * 0.264)) * Math.PI * 2;
    f.stride += ((sp > 0 ? (run ? 1.6 : 1) : 0) - f.stride) * Math.min(1, dt * 6);
    f.pose = run ? Pose.Walk : sp > 0 ? Pose.Walk : Math.sin(this.time * 0.2) > 0.9 ? Pose.Wave : Pose.Walk;
    f.lean = run ? 0.2 : 0.06;
    f.hgt += (groundAt(this.map, f.x, f.y) - f.hgt) * Math.min(1, dt * 10);
  }

  /** The caravan leader waits (alarmed) while the camels scatter. */
  private manIdle(f: Figure, dt: number, h: Herd | null) {
    f.stride += (0 - f.stride) * Math.min(1, dt * 6);
    f.pose = h && h.mv > 0 ? Pose.Alarm : Pose.Walk;
    if (h && h.mv > 0) h.mv -= dt;
  }

  /** The sheepdog circles the flock, now and then dashing round to the far side. */
  private stepDog(h: Herd, a: Animal, dt: number, hx: number, hy: number) {
    if (a.s === A.Dead || a.s === A.Panic || a.s === A.Alert) {
      this.step(h, a, dt, hx, hy);
      return;
    }
    h.dogA += dt * (Math.sin(this.time * 0.13) > 0.6 ? 0.9 : 0.25);
    const r = 1.4;
    a.tx = hx + Math.cos(h.dogA) * r;
    a.ty = hy + Math.sin(h.dogA) * r;
    a.s = A.Walk;
    a.t = 0;
    this.step(h, a, dt, hx, hy);
  }

  private step(h: Herd, a: Animal, dt: number, hx: number, hy: number) {
    const m = this.map;
    const def = SPECIES[a.sp];
    a.t += dt;
    let vt = 0;
    let want = a.yaw;
    let headT = 0;
    const isDog = a === h.dog;
    switch (a.s) {
      case A.Dead:
        a.roll = Math.min(Math.PI / 2, a.roll + dt * 4);
        a.v = 0;
        a.gait = 0;
        a.hop = 0;
        a.head = Math.max(0.3, a.head - dt);
        return;
      case A.Graze: {
        // cats sit still (head up, the odd groom), the rest graze / peck with heads down
        const cat = a.sp === Sp.Cat;
        headT = cat ? ((a.t % 11) < 1.5 ? 0.6 : 0) : a.sp === Sp.Chicken ? (Math.sin(a.t * 5 + a.phase) > 0 ? 1 : 0.2) : (a.t % 9) < 7.5 ? 1 : 0.15;
        vt = !cat && Math.sin(a.t * 0.9 + a.phase) > 0.85 ? def.walk * 0.25 : 0;
        want = a.yaw + (cat ? 0 : Math.sin(a.t * 0.3 + a.phase) * 0.4);
        if (a.t > def.rest + (a.phase % 1) * def.rest * 1.5) {
          // wander a few steps, keeping near the herd and in its ground
          const p = this.fieldPoint(h.f, 1);
          const pull = h.animals.length > 1 ? 0.35 : 1;
          a.tx = hx + (p.x - hx) * pull + (Math.random() - 0.5) * 0.8 * pull;
          a.ty = hy + (p.y - hy) * pull + (Math.random() - 0.5) * 0.8 * pull;
          if (!this.inField(h.f, a.tx, a.ty) || !walkable(m, a.tx, a.ty)) {
            a.tx = p.x;
            a.ty = p.y;
          }
          a.s = A.Walk;
          a.t = 0;
        }
        break;
      }
      case A.Walk:
      case A.Return: {
        const dx = a.tx - a.x;
        const dy = a.ty - a.y;
        const d = Math.hypot(dx, dy);
        want = Math.atan2(dy, dx);
        const march = h.kind === H.Caravan && !h.scattered && a.s === A.Walk;
        vt = march ? Math.min(0.5, d * 1.6) : (isDog && d > 1.2 ? def.run * 0.6 : def.walk) * (a.s === A.Return ? 1.4 : 1) * Math.min(1, d * 3 + 0.2);
        headT = 0.1;
        if (!march && !isDog && (d < 0.08 || a.t > 30)) {
          a.s = A.Graze;
          a.t = 0;
        }
        break;
      }
      case A.Panic: {
        // run away (with a bit of herd pull and weaving; hares zig-zag), heads up
        const cx = hx - a.x;
        const cy = hy - a.y;
        const zig = a.sp === Sp.Hare ? 0.9 * Math.sign(Math.sin(a.t * 3 + a.phase)) : 0.25;
        const wx = a.fx * 1.0 + cx * 0.15 + Math.sin(a.t * 2.3 + a.phase) * zig;
        const wy = a.fy * 1.0 + cy * 0.15 + Math.cos(a.t * 2.1 + a.phase) * zig;
        want = Math.atan2(wy, wx);
        vt = def.run * Math.min(1, -a.t * 0.6 + 0.4);
        headT = 0;
        if (a.t >= 0) {
          a.s = A.Alert;
          a.t = -(2 + Math.random() * 4);
        }
        break;
      }
      case A.Alert:
        headT = 0;
        vt = 0;
        if (a.t >= 0) {
          a.s = A.Return;
          a.t = 0;
          const p = this.fieldPoint(h.f, 0.7);
          a.tx = p.x;
          a.ty = p.y;
        }
        break;
    }
    // turn, then move (blocked by water / buildings: slide round)
    const turn = (a.s === A.Panic ? 4 : 1.6) * (def.walk > 0.25 || a.sp === Sp.Hare || a.sp === Sp.Cat || a.sp === Sp.Chicken ? 2 : 1) * dt;
    a.yaw = wrapAngle(a.yaw + Math.max(-turn, Math.min(turn, wrapAngle(want - a.yaw))));
    a.v += (vt - a.v) * Math.min(1, dt * (a.s === A.Panic ? 4 : 2));
    if (a.v > 0.005) {
      const nx = a.x + Math.cos(a.yaw) * a.v * dt;
      const ny = a.y + Math.sin(a.yaw) * a.v * dt;
      if (walkable(m, nx, ny)) {
        a.x = nx;
        a.y = ny;
      } else {
        a.yaw += (a.phase > 3 ? 1 : -1) * 1.2 * dt * 4;
        a.fx = Math.cos(a.yaw);
        a.fy = Math.sin(a.yaw);
      }
    }
    a.head += (headT - a.head) * Math.min(1, dt * 2.5);
    const running = a.v > def.run * 0.45;
    a.gait += (Math.min(1, a.v / (def.walk * 1.2)) * (running ? 1.3 : 0.8) - a.gait) * Math.min(1, dt * 5);
    a.phase += dt * (a.v / def.stride) * Math.PI;
    // hares bound, deer leap when running
    a.hop = a.sp === Sp.Hare ? Math.abs(Math.sin(a.phase * 0.5)) * Math.min(1, a.v * 4) * 0.05 : a.sp === Sp.Deer && running ? Math.abs(Math.sin(a.phase * 0.5)) * 0.06 : 0;
    a.hgt += (groundAt(m, a.x, a.y) - a.hgt) * Math.min(1, dt * 12);
  }

  draw(f?: AmbientFrame) {
    for (const im of this.inst) im?.begin();
    let n = 0;
    const cap = this.cap;
    for (const h of this.herds) {
      for (let i = 0; i <= h.animals.length && n < cap; i++) {
        const a = i < h.animals.length ? h.animals[i] : h.dog;
        if (!a) continue;
        if (f && (a.x < f.vx0 || a.x > f.vx1 || a.y < f.vy0 || a.y > f.vy1)) continue;
        if (!this.probe.visible(a.x, a.y)) continue;
        const def = SPECIES[a.sp];
        const im = this.inst[a.sp];
        if (!im) continue;
        const k = a.roll / (Math.PI / 2);
        const sc = a.size * def.scale;
        _e.set(0, -a.yaw, 0, 'YXZ');
        _q.setFromEuler(_e);
        _m.compose(_p.set(a.x, a.hgt + a.hop + k * def.halfW * sc, a.y), _q, _s.set(sc, sc, sc));
        if (a.roll) {
          _r.makeRotationX(a.roll);
          _m.multiply(_r);
          _r.makeTranslation(0, -k * def.bodyY, 0);
          _m.multiply(_r);
        }
        if (im.push(_m, a.phase, a.head, a.gait, a.s === A.Dead ? 1 : 0, a.paint.r, a.paint.g, a.paint.b)) n++;
      }
      // the herd's man is hidden with it under the fog (people.ts checks the fog too)
      if (h.man) h.man.show = true;
    }
    for (const im of this.inst) im?.commit();
  }
}
