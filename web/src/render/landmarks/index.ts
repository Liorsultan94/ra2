import * as THREE from 'three';
import { BRIDGE_HEIGHT, type GameMap } from '../../sim/map';
import type { Effects } from '../effects';
import type { FogOfWar } from '../fog';
import type { AmbientFrame, FogProbe, LightSprites, Quality } from '../ambient/shared';
import {
  CHIMNEYS,
  CHURCH_BELL,
  FLARE,
  HELIPAD,
  Kit,
  LIFT_GAUGE,
  MAST_H,
  MINARET,
  STADIUM_LIGHTS,
  STADIUM_MAST_H,
  TURBINE_HUB,
  castleRuin,
  church,
  containers,
  cottage,
  datePalm,
  factory,
  fortRuin,
  frozenLake,
  fuelStation,
  gondola,
  harbourCrane,
  hospital,
  iceHut,
  liftPylon,
  liftStation,
  mosque,
  mudHouse,
  radioMast,
  refinery,
  skiMountain,
  skyscraper,
  soukStall,
  stadium,
  stationHouse,
  turbineRotor,
  turbineTower,
  waterTower,
} from '../models/landmarks';
import { groundRange, groundY } from './ground';
import { landmarkPlan, type Spot } from './plan';
import { civSound } from './sound';
import { LM_NIGHT, landmarkMaterial } from './material';

/*
 * The maps' unique set pieces (plan.ts says where): a wind farm, a castle
 * ruin and a station village with its church (Frontline Crossing); a mosque,
 * the souk, a palm grove and a ruined fort, the refinery skyline with its gas
 * flare (Wadi Al-Rimal); a radio mast, a ski mountain with a gondola lift, a
 * smoking factory and a frozen lake (Frozen Pass); a stadium, glass towers,
 * a hospital, a fuel station, a marina and a suspension bridge (Canal City).
 *
 * Draw calls: every static piece of the map merges into one vertex-coloured
 * mesh (night windows, tower facades and warning paint come from a per vertex
 * glow code in the shader); turbine rotors and gondola cabins are one
 * instanced mesh each; warning lights, floodlights and the flare glow go
 * through the ambient light sprites. Low quality: the static mesh only.
 *
 * Inside the playable area the pieces stand on impassable ground only and are
 * render-side destructible: blasts batter them and they collapse into rubble
 * with smoke and dust (envdamage-style vertex animation of their slice of the
 * merged mesh). The suspension cables come down with their bridge.
 */

interface Range {
  spot: Spot;
  start: number;
  end: number;
  /** Original positions / colours of the slice. */
  pos: Float32Array;
  col: Float32Array;
  px: number;
  py: number;
  pz: number;
  height: number;
  hp: number;
  /** 0 standing, 1 collapsing, 2 down. */
  stage: number;
  t: number;
  /** Fall direction (unit, tile space). */
  dx: number;
  dz: number;
  smokeT: number;
  /** Toggle-only slice (suspension cables): shown with its bridge. */
  toggle?: number;
  hidden?: boolean;
}

interface Light {
  x: number;
  y: number;
  z: number;
  kind: 0 | 1 | 2 | 3;
  size: number;
  phase: number;
  /** Destructible range it belongs to (lights go out when it falls). */
  range: Range | null;
}

const FAR = 70;
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _ax = new THREE.Vector3();
const _v = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _xa = new THREE.Vector3(1, 0, 0);

export class MapLandmarks {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private ranges: Range[] = [];
  private lights: Light[] = [];
  private rotors: THREE.InstancedMesh | null = null;
  private rotorSpots: { x: number; y: number; z: number; yaw: number; speed: number; ang: number }[] = [];
  private cabins: THREE.InstancedMesh | null = null;
  private lift: { pts: THREE.Vector3[]; cum: number[]; len: number; n: number; u: number } | null = null;
  private smokers: { x: number; y: number; z: number; size: number; t: number; dark: boolean }[] = [];
  private flare: { x: number; y: number; z: number } | null = null;
  private bells: { x: number; y: number; z: number }[] = [];
  private lastHour = -1;
  private toll = { n: 0, t: 0 };
  private time = 0;
  private animate: boolean;

  constructor(
    private map: GameMap,
    fog: FogOfWar,
    private probe: FogProbe,
    private lightsOut: LightSprites,
    private effects: Effects,
    quality: Quality,
    private bridges: readonly { status: string }[] = [],
  ) {
    this.group.name = 'landmarks';
    this.animate = quality !== 'low';
    const plan = landmarkPlan(map);
    if (!plan.spots.length && !plan.lanes.length) return;
    const k = new Kit();
    for (const s of plan.spots) this.place(k, s);
    for (const l of plan.lanes) this.lane(k, l.pts, l.width);
    if (!k.count) return;
    const geo = k.build();
    const mat = landmarkMaterial(fog);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'landmarks-static';
    mesh.castShadow = quality === 'high';
    mesh.receiveShadow = quality !== 'low';
    mesh.frustumCulled = false;
    this.mesh = mesh;
    this.group.add(mesh);
    // keep the original slices of the destructible pieces
    const pa = geo.attributes.position.array as Float32Array;
    const ca = geo.attributes.color.array as Float32Array;
    for (const r of this.ranges) {
      r.pos = pa.slice(r.start * 3, r.end * 3);
      r.col = ca.slice(r.start * 3, r.end * 3);
    }
    if (this.rotorSpots.length) {
      const im = new THREE.InstancedMesh(turbineRotor(), mat, this.rotorSpots.length);
      im.name = 'landmarks-rotors';
      im.castShadow = quality === 'high';
      im.frustumCulled = false;
      this.rotors = im;
      this.group.add(im);
      this.updateRotors(0);
    }
    if (this.lift && this.animate) {
      const im = new THREE.InstancedMesh(gondola(), mat, this.lift.n);
      im.name = 'landmarks-gondolas';
      im.frustumCulled = false;
      this.cabins = im;
      this.group.add(im);
    }
  }

  // ---------------------------------------------------------------- building

  /** Begin a destructible slice of the merged mesh. */
  private beginRange(k: Kit, s: Spot, px: number, py: number, pz: number, height: number, hp = 1, toggle?: number): Range {
    const r: Range = { spot: s, start: k.count, end: k.count, pos: new Float32Array(0), col: new Float32Array(0), px, py, pz, height, hp, stage: 0, t: 0, dx: 1, dz: 0, smokeT: 0, toggle };
    this.ranges.push(r);
    return r;
  }

  private light(x: number, y: number, z: number, kind: Light['kind'], size: number, range: Range | null = null) {
    this.lights.push({ x, y, z, kind, size, phase: Math.random() * 6, range });
  }

  /** A plinth under a building on uneven ground: from below the lowest point up to its floor. */
  private plinth(k: Kit, x: number, y: number, lo: number, base: number, w: number, d: number, yaw: number, col = 0x8a8478) {
    if (base - lo < 0.04) return;
    const h = base - lo + 0.25;
    k.at(x, base - h / 2, y, yaw).box(w, h, d, 0, 0, 0, col);
  }

  private place(k: Kit, s: Spot) {
    const m = this.map;
    const { x, y, yaw } = s;
    switch (s.kind) {
      case 'turbine': {
        const g = groundY(m, x, y) - 0.04;
        k.at(x, g, y, yaw, 1 + (s.v - 0.5) * 0.12);
        turbineTower(k);
        const sc = 1 + (s.v - 0.5) * 0.12;
        const hy = g + TURBINE_HUB * sc;
        const hx = x + Math.cos(yaw) * 0.08 * sc;
        const hz = y + Math.sin(yaw) * 0.08 * sc;
        this.rotorSpots.push({ x: hx, y: hy, z: hz, yaw, speed: 0.9 + s.v * 0.5, ang: s.v * 6 });
        this.light(x - Math.cos(yaw) * 0.4 * sc, hy + 0.14 * sc, y - Math.sin(yaw) * 0.4 * sc, 0, 0.32);
        break;
      }
      case 'castle': {
        const { hi } = groundRange(m, x, y, 1.1);
        const base = hi - 0.2;
        const r = this.beginRange(k, s, x, base, y, 2.3, 1);
        k.at(x, base, y, yaw);
        castleRuin(k, 7);
        r.end = k.count;
        break;
      }
      case 'fort': {
        const base = groundY(m, x, y) - 0.04;
        const r = this.beginRange(k, s, x, base, y, 1.3, 1);
        k.at(x, base, y, yaw);
        fortRuin(k, 11);
        r.end = k.count;
        break;
      }
      case 'mast': {
        const base = groundY(m, x, y) - 0.03;
        const r = this.beginRange(k, s, x, base, y, MAST_H, 0.7);
        k.at(x, base, y, yaw);
        radioMast(k);
        r.end = k.count;
        for (const f of [0.33, 0.66, 1.0]) this.light(x, base + MAST_H * f + (f === 1 ? 0.95 : 0), y, 0, f === 1 ? 0.36 : 0.26, r);
        break;
      }
      case 'church': {
        const { lo, hi } = groundRange(m, x, y, 1.4);
        this.plinth(k, x, y, lo, hi, 3.2, 1.5, yaw);
        k.at(x, hi, y, yaw);
        church(k);
        this.bells.push({ x: x + Math.cos(yaw) * CHURCH_BELL.x, y: hi + CHURCH_BELL.y, z: y + Math.sin(yaw) * CHURCH_BELL.x });
        break;
      }
      case 'watertower': {
        const g = groundY(m, x, y);
        k.at(x, g - 0.03, y, yaw);
        waterTower(k);
        break;
      }
      case 'cottage': {
        const { lo, hi } = groundRange(m, x, y, 0.75);
        this.plinth(k, x, y, lo, hi, 1.32, 0.97, yaw);
        k.at(x, hi, y, yaw);
        cottage(k, s.v);
        // winter: snow on the roofs
        if (m.biome === 'winter') k.at(x, hi, y, yaw).gable(1.42, 1.12, 0.52, 0, 0.56, 0, 0xeef3f8);
        break;
      }
      case 'station': {
        const { lo, hi } = groundRange(m, x, y, 1.2);
        const base = Math.max(hi, groundY(m, x + 1.1, y) + 0.05);
        this.plinth(k, x, y, lo, base, 1.2, 2.6, yaw);
        k.at(x, base, y, yaw);
        stationHouse(k);
        break;
      }
      case 'mosque': {
        const { lo, hi } = groundRange(m, x + 0.8, y, 1.8);
        this.plinth(k, x + 0.8, y, lo, hi, 4.4, 2.0, yaw, 0xc8b490);
        k.at(x, hi, y, yaw);
        mosque(k);
        const mx = x + Math.cos(yaw) * MINARET.x - Math.sin(yaw) * MINARET.z;
        const mz = y + Math.sin(yaw) * MINARET.x + Math.cos(yaw) * MINARET.z;
        this.light(mx, hi + MINARET.h + 0.85, mz, 3, 0.18);
        break;
      }
      case 'souk': {
        const g = groundY(m, x, y);
        k.at(x, g - 0.02, y, yaw);
        soukStall(k, s.v);
        break;
      }
      case 'mudhouse': {
        const { lo, hi } = groundRange(m, x, y, 0.7);
        this.plinth(k, x, y, lo, hi, 1.12, 0.92, yaw, 0xb89870);
        k.at(x, hi, y, yaw);
        mudHouse(k, s.v);
        break;
      }
      case 'palm': {
        k.at(x, groundY(m, x, y) - 0.03, y, yaw);
        datePalm(k, s.v, 1.15 + s.v * 0.35);
        break;
      }
      case 'pond': {
        const ra = s.a ?? 3;
        const rb = s.b ?? 2;
        const g = groundRange(m, x, y, Math.max(ra, rb));
        k.at(x, g.lo + 0.04, y, yaw);
        k.add(new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2).scale(ra, 1, rb), null, 0x3e7c82);
        k.add(new THREE.RingGeometry(0.92, 1.08, 28).rotateX(-Math.PI / 2).scale(ra, 1, rb), null, 0x8a7a50);
        // reeds around the water
        for (let i = 0; i < 22; i++) {
          const a = (i / 22) * Math.PI * 2 + s.v;
          k.cone(0.07, 0.3 + (i % 3) * 0.08, Math.cos(a) * ra * 1.02, 0, Math.sin(a) * rb * 1.02, i % 2 ? 0x5a7a2a : 0x6a8a32, 5);
        }
        // a sand bank around it hides where the ground rises above the water
        this.bank(k, x, y, ra, rb, g.lo, 0xd2b88a);
        break;
      }
      case 'refinery': {
        const { lo, hi } = groundRange(m, x, y, 5);
        k.at(x, (lo + hi) / 2, y, yaw);
        refinery(k);
        this.plinth(k, x, y, lo - 0.3, (lo + hi) / 2, 11, 7, yaw, 0x6a665e);
        const fx = x + Math.cos(yaw) * FLARE.x - Math.sin(yaw) * FLARE.z;
        const fz = y + Math.sin(yaw) * FLARE.x + Math.cos(yaw) * FLARE.z;
        this.flare = { x: fx, y: (lo + hi) / 2 + FLARE.h + 0.25, z: fz };
        this.light(fx, (lo + hi) / 2 + FLARE.h * 0.5, fz, 0, 0.3);
        for (const [cx, cz, h] of [[-0.8, -1.0, 5.8], [-2.5, -1.2, 5.2]] as const) this.light(x + cx, (lo + hi) / 2 + h + 0.32, y + cz, 0, 0.26);
        break;
      }
      case 'factory': {
        const { lo, hi } = groundRange(m, x, y, 2.2);
        this.plinth(k, x, y, lo, hi, 4.6, 2.6, yaw);
        k.at(x, hi, y, yaw);
        factory(k);
        for (const c of CHIMNEYS) {
          const cx = x + Math.cos(yaw) * c.x - Math.sin(yaw) * c.z;
          const cz = y + Math.sin(yaw) * c.x + Math.cos(yaw) * c.z;
          this.smokers.push({ x: cx, y: hi + c.h + 0.1, z: cz, size: 1.4, t: Math.random(), dark: false });
          this.light(cx, hi + c.h + 0.05, cz, 0, 0.22);
        }
        break;
      }
      case 'lake': {
        const g = groundRange(m, x, y, Math.max(s.a ?? 4, s.b ?? 3));
        k.at(x, g.lo + 0.03, y, yaw);
        frozenLake(k, s.a ?? 4, s.b ?? 3);
        this.bank(k, x, y, s.a ?? 4, s.b ?? 3, g.lo, 0xe4ecf2);
        break;
      }
      case 'icehut': {
        const lake = landmarkPlan(m).spots.find((o) => o.kind === 'lake');
        const g = lake ? groundRange(m, lake.x, lake.y, Math.max(lake.a ?? 4, lake.b ?? 3)).lo + 0.03 : groundY(m, x, y);
        k.at(x, g, y, yaw);
        iceHut(k);
        if (s.v < 0.6) this.smokers.push({ x: x - Math.cos(yaw) * 0.12, y: g + 0.75, z: y - Math.sin(yaw) * 0.12, size: 0.35, t: Math.random(), dark: false });
        break;
      }
      case 'skimountain': {
        const r = s.a ?? 18;
        const h = s.b ?? 9;
        const g = groundRange(m, x, y, r * 0.8);
        const base = g.lo * 0.4 + g.hi * 0.6;
        k.at(x, base, y, 0);
        skiMountain(k, r, h, 5);
        this.mountain = { x, y, r, h, base };
        this.light(x, base + h + 0.6, y, 0, 0.4);
        k.at(x, base + h, y).cyl(0.06, 0.04, 0.6, 0, 0, 0, 0xd02a2a, 6, 4);
        break;
      }
      case 'liftstation': {
        const g = this.mountainY(x, y);
        k.at(x, g - 0.02, y, yaw);
        liftStation(k, (s.a ?? 0) > 0);
        if ((s.a ?? 0) > 0) this.buildLift(k);
        break;
      }
      case 'stadium': {
        const { lo, hi } = groundRange(m, x, y, 5.5);
        k.at(x, hi, y, yaw);
        stadium(k);
        this.plinth(k, x, y, lo - 0.2, hi, 12.6, 9.2, yaw, 0x9a968e);
        for (const L of STADIUM_LIGHTS) {
          const lx = x + Math.cos(yaw) * L.x * 1.1 - Math.sin(yaw) * L.z * 1.1;
          const lz = y + Math.sin(yaw) * L.x * 1.1 + Math.cos(yaw) * L.z * 1.1;
          this.light(lx, hi + STADIUM_MAST_H + 0.12, lz, 1, 1.3);
          this.light(lx, hi + STADIUM_MAST_H + 0.75, lz, 0, 0.24);
        }
        break;
      }
      case 'tower': {
        const w = s.b ?? 2;
        const d = s.c ?? 2;
        const { lo, hi } = groundRange(m, x, y, Math.max(w, d) * 0.6);
        k.at(x, lo - 0.1, y, yaw);
        const top = skyscraper(k, w, d, (s.a ?? 8) + (hi - lo), s.v);
        this.light(x, lo - 0.1 + top + 0.08, y, 0, top > 10 ? 0.42 : 0.32);
        break;
      }
      case 'fuel': {
        const { lo, hi } = groundRange(m, x, y, 1.6);
        this.plinth(k, x, y, lo, hi, 3.4, 2.4, yaw, 0x6a6a6a);
        k.at(x, hi, y, yaw);
        fuelStation(k);
        break;
      }
      case 'hospital': {
        const { lo, hi } = groundRange(m, x, y, 2);
        this.plinth(k, x, y, lo, hi, 4.2, 2.6, yaw, 0x9a9a96);
        k.at(x, hi, y, yaw);
        hospital(k);
        const px = x + Math.cos(yaw) * HELIPAD.x - Math.sin(yaw) * HELIPAD.z;
        const pz = y + Math.sin(yaw) * HELIPAD.x + Math.cos(yaw) * HELIPAD.z;
        this.helipad = { x: px, y: hi + HELIPAD.y, z: pz };
        for (const [a, b] of [[0.6, 0.6], [-0.6, 0.6], [0.6, -0.6], [-0.6, -0.6]] as const) this.light(px + a, hi + HELIPAD.y + 0.05, pz + b, 2, 0.14);
        break;
      }
      case 'crane': {
        k.at(x, groundY(m, x, y) - 0.02, y, yaw);
        harbourCrane(k, s.v);
        this.light(x + Math.cos(yaw) * 2.6, groundY(m, x, y) + 3.7, y + Math.sin(yaw) * 2.6, 0, 0.22);
        break;
      }
      case 'containers': {
        k.at(x - Math.cos(yaw) * 1.6, groundY(m, x, y) - 0.01, y - Math.sin(yaw) * 1.6, yaw);
        containers(k, 3);
        break;
      }
      case 'suspension':
        this.suspension(k, s);
        break;
    }
  }

  private mountain: { x: number; y: number; r: number; h: number; base: number } | null = null;
  /** Hospital helipad (world position; air.ts sends a helicopter). */
  helipad: { x: number; y: number; z: number } | null = null;

  /** Ground height including the ski mountain. */
  private mountainY(x: number, y: number): number {
    const g = groundY(this.map, x, y);
    const M = this.mountain;
    if (!M) return g;
    const t = Math.hypot(x - M.x, y - M.y) / M.r;
    if (t >= 1) return g;
    return Math.max(g, M.base + M.h * Math.pow(1 - t, 1.35));
  }

  /** A low bank ringing an ellipse (pond / lake), up to the surrounding ground. */
  private bank(k: Kit, x: number, y: number, ra: number, rb: number, lo: number, col: number) {
    const n = 26;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const px = x + Math.cos(a) * ra * 1.07;
      const pz = y + Math.sin(a) * rb * 1.07;
      const H = Math.max(0.12, groundY(this.map, px, pz) - lo + 0.1);
      const w = (Math.PI * 2 * Math.max(ra, rb) * 1.07) / n + 0.2;
      k.at(px, lo, pz, a + Math.PI / 2).box(w, H, 0.5, 0, H / 2 - 0.04, 0, col);
    }
  }

  /** The gondola lift: pylons up the slope and the looping cabins. */
  private buildLift(k: Kit) {
    const plan = landmarkPlan(this.map);
    const st = plan.spots.filter((s) => s.kind === 'liftstation');
    const a = st.find((s) => !(s.a ?? 0));
    const b = st.find((s) => (s.a ?? 0) > 0);
    if (!a || !b) return;
    const pts: THREE.Vector3[] = [];
    const n = 6;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      const g = this.mountainY(x, y);
      const ph = i === 0 || i === n ? 0.62 : 1.25;
      if (i > 0 && i < n) {
        k.at(x, g - 0.03, y, Math.atan2(b.y - a.y, b.x - a.x));
        liftPylon(k, ph);
      }
      pts.push(new THREE.Vector3(x, g + ph - 0.04, y));
    }
    // the cables (both lines), slightly sagging between the pylons
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const ox = -Math.sin(ang) * LIFT_GAUGE;
    const oz = Math.cos(ang) * LIFT_GAUGE;
    k.at(0, 0, 0, 0);
    for (const sg of [-1, 1])
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i];
        const q = pts[i + 1];
        const steps = 4;
        for (let j = 0; j < steps; j++) {
          const t0 = j / steps;
          const t1 = (j + 1) / steps;
          const sag = (t: number) => -Math.sin(t * Math.PI) * 0.12;
          k.beam(p.x + (q.x - p.x) * t0 + ox * sg, p.y + (q.y - p.y) * t0 + sag(t0), p.z + (q.z - p.z) * t0 + oz * sg, p.x + (q.x - p.x) * t1 + ox * sg, p.y + (q.y - p.y) * t1 + sag(t1), p.z + (q.z - p.z) * t1 + oz * sg, 0.012, 0x2a2a2a);
        }
      }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
    this.lift = { pts, cum, len: cum[cum.length - 1], n: 10, u: 0 };
    this.liftOff = { x: ox, z: oz };
  }
  private liftOff = { x: 0, z: 0 };

  /** Suspension towers in the canal beside a bridge deck, the main cables and hangers (toggle with the bridge). */
  private suspension(k: Kit, s: Spot) {
    const bi = s.a ?? 0;
    const br = this.map.bridges[bi];
    if (!br) return;
    const ux = Math.SQRT1_2;
    const uy = -Math.SQRT1_2;
    const nx = -uy;
    const ny = ux;
    const deck = BRIDGE_HEIGHT + 0.06;
    const TH = 2.4;
    const along = 2.05;
    const across = 1.12;
    const tops: THREE.Vector3[] = [];
    for (const a of [-along, along])
      for (const c of [-across, across]) {
        const x = br.x + ux * a + nx * c;
        const y = br.y + uy * a + ny * c;
        k.at(x, -1.0, y, Math.atan2(uy, ux));
        k.box(0.32, 1.0 + deck, 0.32, 0, (1.0 + deck) / 2, 0, 0x9a968e);
        k.box(0.18, TH, 0.18, 0, 1.0 + deck + TH / 2, 0, 0xc8c4bc);
        k.box(0.22, 0.12, 0.22, 0, 1.0 + deck + TH, 0, 0xb0aca4);
        tops.push(new THREE.Vector3(x, deck + TH, y));
      }
    // portal beams between the tower pairs
    k.at(0, 0, 0, 0);
    for (const [i, j] of [[0, 1], [2, 3]] as const) {
      const p = tops[i];
      const q = tops[j];
      k.beam(p.x, p.y - 0.3, p.z, q.x, q.y - 0.3, q.z, 0.12, 0xb0aca4);
      k.beam(p.x, p.y - 1.2, p.z, q.x, q.y - 1.2, q.z, 0.1, 0xb0aca4);
    }
    for (let i = 0; i < 4; i++) this.light(tops[i].x, tops[i].y + 0.12, tops[i].z, 0, 0.18);
    // the cables (toggled with the bridge)
    const r = this.beginRange(k, s, br.x, deck, br.y, TH, 1, bi);
    const half = br.length / 2;
    const col = 0xd8d4cc;
    for (const c of [-across, across]) {
      const T0 = tops[c < 0 ? 0 : 1];
      const T1 = tops[c < 0 ? 2 : 3];
      // backstays to the deck ends
      for (const [T, e] of [[T0, -half], [T1, half]] as const) {
        const ex = br.x + ux * e + nx * c * 0.92;
        const ey = br.y + uy * e + ny * c * 0.92;
        k.beam(T.x, T.y, T.z, ex, deck + 0.05, ey, 0.04, col);
      }
      // main span: a parabola between the towers, hangers down to the deck edge
      const N = 12;
      let prev = T0;
      for (let i = 1; i <= N; i++) {
        const t = i / N;
        const sag = 4 * t * (1 - t) * (TH - 0.35);
        const p = new THREE.Vector3(T0.x + (T1.x - T0.x) * t, T0.y - sag, T0.z + (T1.z - T0.z) * t);
        k.beam(prev.x, prev.y, prev.z, p.x, p.y, p.z, 0.04, col);
        if (i < N) k.beam(p.x, p.y, p.z, p.x, deck + 0.05, p.z, 0.012, col);
        prev = p;
      }
    }
    r.end = k.count;
  }

  /** A road ribbon in the outskirts (asphalt, edge lines, dashed centre line). */
  private lane(k: Kit, pts: { x: number; y: number }[], width: number) {
    const m = this.map;
    k.at(0, 0, 0, 0);
    const hw = width / 2;
    let dash = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 1e-3) continue;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      // ribbon slab, following the ground across
      const g = Math.max(groundY(m, mx, my), groundY(m, mx - Math.sin(ang) * hw, my + Math.cos(ang) * hw), groundY(m, mx + Math.sin(ang) * hw, my - Math.cos(ang) * hw));
      k.at(mx, g + 0.035, my, ang);
      k.box(L + 0.06, 0.04, width, 0, -0.02, 0, 0x3c3c3e);
      if (width > 0.8) {
        for (const sg of [-1, 1]) k.box(L + 0.06, 0.004, 0.035, 0, 0.002, sg * (hw - 0.07), 0xd8d8d0);
        dash += L;
        if (dash % 1.0 < 0.5) k.box(L * 0.9, 0.004, 0.035, 0, 0.002, 0, 0xe0d8a0);
      }
    }
  }

  // ---------------------------------------------------------------- damage

  /** A ground blast at (x, y) with lethal radius `kill` (ambient danger scale). */
  blast(x: number, y: number, kill: number) {
    for (const r of this.ranges) {
      if (r.stage !== 0 || r.toggle !== undefined) continue;
      const reach = 1.4 + kill;
      const d = Math.hypot(r.px - x, r.pz - y) - (r.spot.kind === 'mast' ? 0.4 : 1.2);
      if (d > reach) continue;
      const dmg = kill * 0.16 * (1 - Math.max(0, d) / reach);
      r.hp -= dmg;
      // battered: darker, a puff of dust
      this.scorch(r, Math.min(0.35, dmg));
      this.effects.dust(x, groundY(this.map, x, y), y, 1.4);
      if (r.hp <= 0) this.collapse(r, x, y);
    }
  }

  private scorch(r: Range, k: number) {
    const mesh = this.mesh;
    if (!mesh) return;
    const ca = mesh.geometry.attributes.color as THREE.BufferAttribute;
    const arr = ca.array as Float32Array;
    for (let i = r.start * 3; i < r.end * 3; i++) arr[i] *= 1 - k * (0.6 + Math.random() * 0.4);
    ca.clearUpdateRanges();
    ca.addUpdateRange(r.start * 3, (r.end - r.start) * 3);
    ca.needsUpdate = true;
  }

  private collapse(r: Range, bx: number, by: number) {
    r.stage = 1;
    r.t = 0;
    let dx = r.px - bx;
    let dz = r.pz - by;
    const l = Math.hypot(dx, dz);
    if (l < 0.05) {
      dx = Math.random() - 0.5;
      dz = Math.random() - 0.5;
    }
    const ll = Math.hypot(dx, dz) || 1;
    r.dx = dx / ll;
    r.dz = dz / ll;
    r.smokeT = 40;
    const g = r.py;
    for (let i = 0; i < 6; i++) this.effects.after(i * 0.12, () => this.effects.dust(r.px + (Math.random() - 0.5) * 2, g + 0.2, r.pz + (Math.random() - 0.5) * 2, 2.5));
    this.effects.explosion(r.px, g + 0.4, r.pz, 'small', 'dust');
    if (this.probe.visible(r.px, r.pz)) civSound('collapse', 0.9, r.px, r.pz, 0.5);
    this.effects.addShake(0.12, r.px, r.pz);
  }

  private animateCollapse(r: Range, dt: number) {
    const mesh = this.mesh;
    if (!mesh) return;
    r.t += dt;
    const kind = r.spot.kind;
    const dur = kind === 'mast' ? 2.6 : 3.2;
    const k = Math.min(1, r.t / dur);
    const e = k * k;
    const maxA = kind === 'mast' ? 1.5 : kind === 'castle' ? 0.22 : 0.16;
    const sink = kind === 'mast' ? 0 : r.height * (kind === 'castle' ? 0.55 : 0.5);
    const squash = kind === 'mast' ? 0 : 0.55;
    _ax.set(r.dz, 0, -r.dx).normalize();
    _q.setFromAxisAngle(_ax, maxA * e);
    const pa = mesh.geometry.attributes.position as THREE.BufferAttribute;
    const ca = mesh.geometry.attributes.color as THREE.BufferAttribute;
    const P = pa.array as Float32Array;
    const C = ca.array as Float32Array;
    const n = r.end - r.start;
    const dark = 1 - 0.55 * k;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      _v.set(r.pos[o] - r.px, r.pos[o + 1] - r.py, r.pos[o + 2] - r.pz);
      if (squash) _v.y *= 1 - squash * e * Math.min(1, Math.max(0, _v.y / Math.max(0.3, r.height)) + 0.3);
      _v.applyQuaternion(_q);
      const j = (r.start + i) * 3;
      P[j] = r.px + _v.x;
      P[j + 1] = Math.max(r.py - 1.2, r.py + _v.y - sink * e * Math.min(1, Math.max(0.2, (r.pos[o + 1] - r.py) / Math.max(0.3, r.height))));
      P[j + 2] = r.pz + _v.z;
      C[j] = r.col[o] * dark;
      C[j + 1] = r.col[o + 1] * dark;
      C[j + 2] = r.col[o + 2] * dark;
    }
    pa.clearUpdateRanges();
    pa.addUpdateRange(r.start * 3, n * 3);
    pa.needsUpdate = true;
    ca.clearUpdateRanges();
    ca.addUpdateRange(r.start * 3, n * 3);
    ca.needsUpdate = true;
    if (Math.random() < dt * 14) this.effects.dust(r.px + (Math.random() - 0.5) * 2.2, r.py + 0.2, r.pz + (Math.random() - 0.5) * 2.2, 2.2);
    if (k >= 1) {
      r.stage = 2;
      if (kind === 'mast') {
        // the mast lies across the ridge: dust where it hit
        const tx = r.px + r.dx * r.height * 0.6;
        const tz = r.pz + r.dz * r.height * 0.6;
        for (let i = 0; i < 5; i++) this.effects.dust(tx + (Math.random() - 0.5) * 3, r.py, tz + (Math.random() - 0.5) * 3, 3);
        this.effects.addShake(0.1, tx, tz);
      }
    }
  }

  /** Show / hide a toggled slice (the suspension cables follow their bridge). */
  private setHidden(r: Range, hidden: boolean) {
    const mesh = this.mesh;
    if (!mesh || r.hidden === hidden) return;
    r.hidden = hidden;
    const pa = mesh.geometry.attributes.position as THREE.BufferAttribute;
    const P = pa.array as Float32Array;
    const n = r.end - r.start;
    for (let i = 0; i < n; i++) {
      const j = (r.start + i) * 3;
      if (hidden) {
        P[j] = r.px;
        P[j + 1] = -5;
        P[j + 2] = r.pz;
      } else {
        P[j] = r.pos[i * 3];
        P[j + 1] = r.pos[i * 3 + 1];
        P[j + 2] = r.pos[i * 3 + 2];
      }
    }
    pa.clearUpdateRanges();
    pa.addUpdateRange(r.start * 3, n * 3);
    pa.needsUpdate = true;
    if (hidden) for (let i = 0; i < 8; i++) this.effects.after(i * 0.08, () => this.effects.splash(r.px + (Math.random() - 0.5) * 4, -0.25, r.pz + (Math.random() - 0.5) * 4, 0.8));
  }

  // ---------------------------------------------------------------- frame

  private updateRotors(dt: number) {
    const im = this.rotors;
    if (!im) return;
    this.rotorSpots.forEach((r, i) => {
      r.ang += dt * r.speed;
      _q.setFromAxisAngle(_up, -r.yaw);
      _q2.setFromAxisAngle(_xa, r.ang);
      _q.multiply(_q2);
      _m.compose(_p.set(r.x, r.y, r.z), _q, _s.set(1, 1, 1));
      im.setMatrixAt(i, _m);
    });
    im.instanceMatrix.needsUpdate = true;
  }

  private updateLift(dt: number) {
    const L = this.lift;
    const im = this.cabins;
    if (!L || !im) return;
    L.u = (L.u + dt * 0.035) % 1;
    const half = L.n / 2;
    for (let i = 0; i < L.n; i++) {
      const up = i < half;
      let u = (L.u + (i % half) / half) % 1;
      if (!up) u = 1 - u;
      const s = u * L.len;
      let j = 0;
      while (j < L.cum.length - 2 && L.cum[j + 1] < s) j++;
      const t = (s - L.cum[j]) / Math.max(1e-6, L.cum[j + 1] - L.cum[j]);
      const a = L.pts[j];
      const b = L.pts[j + 1];
      const sg = up ? 1 : -1;
      const sag = -Math.sin(t * Math.PI) * 0.12;
      _p.set(a.x + (b.x - a.x) * t + this.liftOff.x * sg, a.y + (b.y - a.y) * t + sag, a.z + (b.z - a.z) * t + this.liftOff.z * sg);
      _q.setFromAxisAngle(_up, -Math.atan2(b.z - a.z, b.x - a.x));
      _m.compose(_p, _q, _s.set(1, 1, 1));
      im.setMatrixAt(i, _m);
    }
    im.count = L.n;
    im.instanceMatrix.needsUpdate = true;
  }

  /** The church bells strike the hour (clock: hours 0..23, live = the day cycle runs). */
  private bellsFor(hours: number, dt: number) {
    if (!this.bells.length) return;
    if (this.lastHour >= 0 && hours !== this.lastHour) {
      this.toll.n = Math.min(6, ((hours + 11) % 12) + 1);
      this.toll.t = 0;
    }
    this.lastHour = hours;
    if (this.toll.n > 0) {
      this.toll.t -= dt;
      if (this.toll.t <= 0) {
        this.toll.n--;
        this.toll.t = 1.7;
        for (const b of this.bells) if (this.probe.visible(b.x, b.z)) civSound('churchBell', 0.9, b.x, b.z, b.y);
      }
    }
  }

  update(f: AmbientFrame, clockHours: number) {
    if (!this.mesh) return;
    const dt = f.dt;
    this.time += dt;
    LM_NIGHT.value = f.dark;
    // destruction
    for (const r of this.ranges) {
      if (r.toggle !== undefined) {
        const b = this.bridges[r.toggle];
        if (b) this.setHidden(r, b.status === 'down');
        continue;
      }
      if (r.stage === 1) this.animateCollapse(r, dt);
      if (r.stage >= 1 && r.smokeT > 0) {
        r.smokeT -= dt;
        if (this.probe.visible(r.px, r.pz) && Math.random() < dt * (r.smokeT > 25 ? 5 : 2)) this.effects.column(r.px + (Math.random() - 0.5), r.py + 0.4, r.pz + (Math.random() - 0.5), 0.9, true);
      }
      if (r.stage === 0 && r.hp < 0.6 && this.probe.visible(r.px, r.pz) && Math.random() < dt * 0.6) this.effects.smoke(r.px + (Math.random() - 0.5) * 1.6, r.py + r.height * 0.5, r.pz + (Math.random() - 0.5) * 1.6, 0.8, true);
    }
    if (!this.animate) return;
    const far = f.vx1 - f.vx0 > FAR;
    if (this.rotors) this.updateRotors(dt);
    if (this.cabins) {
      this.cabins.visible = !far;
      if (!far) this.updateLift(dt);
    }
    this.bellsFor(clockHours, dt);
    // chimneys, the stove pipe, the gas flare
    const near = (x: number, z: number, m: number) => x > f.vx0 - m && x < f.vx1 + m && z > f.vy0 - m && z < f.vy1 + m;
    for (const s of this.smokers) {
      if (!near(s.x, s.z, 6) || !this.probe.visible(s.x, s.z)) continue;
      s.t -= dt;
      if (s.t > 0) continue;
      s.t = s.size > 1 ? 0.22 : 0.6;
      if (s.size > 1) this.effects.column(s.x, s.y, s.z, s.size, false);
      else this.effects.smoke(s.x, s.y, s.z, s.size, false);
    }
    const fl = this.flare;
    if (fl && near(fl.x, fl.z, 10) && this.probe.visible(fl.x, fl.z)) {
      if (Math.random() < dt * 16) this.effects.flame(fl.x, fl.y, fl.z, 0.9);
      if (Math.random() < dt * 3) this.effects.smoke(fl.x, fl.y + 0.6, fl.z, 1.2, true);
    }
    this.drawLights(f, near);
  }

  private drawLights(f: AmbientFrame, near: (x: number, z: number, m: number) => boolean) {
    const L = this.lightsOut;
    const dk = f.dark;
    const t = this.time;
    for (const l of this.lights) {
      if (l.range && l.range.stage > 0) continue;
      if (!near(l.x, l.z, l.y + 4) || !this.probe.visible(l.x, l.z)) continue;
      switch (l.kind) {
        case 0: {
          // aircraft warning light: red, slow blink (dim by day)
          const on = Math.sin(t * 2.6 + l.phase) > 0.1;
          if (!on) break;
          const k = 0.35 + dk * 1.6;
          L.flare(l.x, l.y, l.z, l.size * (0.7 + dk * 0.5), 1.9 * k, 0.12 * k, 0.08 * k);
          break;
        }
        case 1: {
          // floodlights (night only)
          if (dk < 0.15) break;
          L.flare(l.x, l.y, l.z, l.size, 2.2 * dk, 2.1 * dk, 1.8 * dk);
          break;
        }
        case 2: {
          // helipad perimeter lights: green, steady at night
          if (dk < 0.2) break;
          L.flare(l.x, l.y, l.z, l.size, 0.3 * dk, 1.6 * dk, 0.5 * dk);
          break;
        }
        case 3: {
          // minaret lamps: warm, night
          if (dk < 0.2) break;
          L.flare(l.x, l.y, l.z, l.size, 1.8 * dk, 1.5 * dk, 0.8 * dk);
          break;
        }
      }
    }
    // the gas flare's glow
    const fl = this.flare;
    if (fl && near(fl.x, fl.z, 10) && this.probe.visible(fl.x, fl.z)) {
      const fk = 0.8 + Math.sin(t * 17) * 0.15 + Math.sin(t * 7.3) * 0.1;
      L.flare(fl.x, fl.y + 0.2, fl.z, 1.1 * fk, 2.4 * fk, 1.1 * fk, 0.25 * fk);
    }
  }

  /** Debug / tests. */
  stats() {
    return { verts: this.mesh ? this.mesh.geometry.attributes.position.count : 0, ranges: this.ranges.map((r) => ({ kind: r.spot.kind, hp: +r.hp.toFixed(2), stage: r.stage })), lights: this.lights.length, rotors: this.rotorSpots.length };
  }
}
