import * as THREE from 'three';
import type { GameMap } from '../../sim/map';
import type { FogOfWar } from '../fog';
import { GeoBuilder } from '../geo';
import type { V2 } from '../layout';
import { Opt, Pose } from '../models/civilians';
import { CAR_SCALE } from './models';
import { planRoute, reverseSegs, routePolyline, type RouteSeg } from './emroute';
import type { Figure } from './people';
import type { RoadNet } from './roadnet';
import { AnimInstances, ambientMaterial, groundAt, wrapAngle, type AmbientFrame, type FogProbe, type LightSprites, type Quality } from './shared';
import { dryAt } from './walkgrid';

/*
 * Emergency services: when a civilian building is destroyed, once the
 * shooting there has died down a police car (and usually an ambulance) comes
 * in from the map edge along the roads (the lane graph, read only), lights
 * flashing and siren going, pulls over at the kerb nearest the ruin, and the
 * crew get out: officers stand by the car, paramedics go over to the ruin.
 * After a while they get back in and drive off the way they came.
 *
 * Vehicles share the ambient car material (doors open on the rig); lights go
 * into the shared LightSprites; the siren is a baked sound (audio/weapons.ts
 * `siren` / `sirenHiLo`) played through the host's positional sound hook.
 */

type SoundFn = (name: 'siren' | 'sirenHiLo', vol: number, x: number, y: number) => void;

const enum V {
  In = 0,
  Parked = 1,
  Out = 2,
  Done = 3,
}

interface Unit {
  kind: 0 | 1;
  s: V;
  poly: V2[];
  cum: Float32Array;
  arc: number;
  v: number;
  x: number;
  y: number;
  yaw: number;
  hgt: number;
  door: number;
  t: number;
  siren: number;
  /** Accumulated siren audio time (s): capped at 10 seconds. */
  sirenT: number;
  segs: RouteSeg[];
  portal: boolean;
  crew: Figure[];
  /** Where the crew go (the ruin). */
  tx: number;
  ty: number;
  seen: boolean;
  /** Crew destinations (x, y pairs; -1 = not chosen yet). */
  goal: Float32Array;
}

interface Incident {
  x: number;
  y: number;
  t: number;
  /** Seconds left to wait for calm before going in anyway. */
  wait: number;
  police: boolean;
  ambulance: boolean;
}

const C = (r: number, g: number, b: number) => new THREE.Color(r, g, b);
const WHITE = C(0.95, 0.95, 0.94);
const GLASS = C(0.07, 0.09, 0.11);
const TYRE = C(0.06, 0.06, 0.06);
const DARK = C(0.12, 0.12, 0.13);

function bx(b: GeoBuilder, w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color, part = 0) {
  b.add(new THREE.BoxGeometry(w, h, d), new THREE.Matrix4().makeTranslation(x, y, z), null, c, { flexFn: () => part });
}

function wheels(b: GeoBuilder, r: number, w: number, xs: number[], hz: number) {
  for (const x of xs)
    for (const s of [-1, 1]) b.add(new THREE.CylinderGeometry(r, r, w, 10).rotateX(Math.PI / 2), new THREE.Matrix4().makeTranslation(x, r, s * hz), null, TYRE, { flexFn: () => 0 });
}

/** Police car (0) / ambulance (1): ambient car scale, face +X, light bar on the roof. Door rig as carModel. */
export function emergencyModel(kind: 0 | 1): { geo: THREE.BufferGeometry; rig: THREE.Vector4; len: number; barY: number; barX: number } {
  const b = new GeoBuilder();
  if (kind === 0) {
    const L = 0.5;
    const W = 0.21;
    const blue = C(0.08, 0.16, 0.42);
    bx(b, L, 0.075, W, 0, 0.082, 0, WHITE);
    bx(b, 0.12, 0.012, W * 0.96, 0.17, 0.124, 0, blue);
    bx(b, 0.27, 0.07, W * 0.98, -0.03, 0.153, 0, WHITE);
    bx(b, 0.255, 0.05, W * 1.0, -0.03, 0.15, 0, GLASS);
    // livery stripe and the doors (blue)
    bx(b, L * 1.002, 0.02, W * 1.01, 0, 0.09, 0, blue);
    for (const s of [-1, 1]) bx(b, 0.12, 0.06, 0.008, 0.0, 0.1, s * (W / 2 + 0.004), blue, s > 0 ? 2 : 3);
    // light bar
    bx(b, 0.05, 0.022, W * 0.8, -0.03, 0.198, 0, DARK);
    bx(b, 0.012, 0.03, W * 0.99, L / 2 + 0.002, 0.07, 0, DARK);
    bx(b, 0.012, 0.03, W * 0.99, -L / 2 - 0.002, 0.07, 0, DARK);
    wheels(b, 0.044, 0.035, [0.155, -0.155], W / 2 - 0.012);
    return { geo: b.build(true), rig: new THREE.Vector4(0.06, W / 2 + 0.004, 0, 0), len: L, barY: 0.215, barX: -0.03 };
  }
  const L = 0.6;
  const W = 0.24;
  const red = C(0.85, 0.12, 0.08);
  const yel = C(0.95, 0.8, 0.1);
  bx(b, 0.42, 0.24, W, -0.08, 0.175, 0, WHITE);
  bx(b, 0.14, 0.11, W, 0.21, 0.11, 0, WHITE);
  bx(b, 0.08, 0.08, W * 0.97, 0.16, 0.2, 0, GLASS);
  // stripes (battenburg-ish band) and a red cross square each side
  bx(b, 0.43, 0.035, W * 1.01, -0.08, 0.13, 0, red);
  bx(b, 0.43, 0.025, W * 1.01, -0.08, 0.165, 0, yel);
  for (const s of [-1, 1]) {
    bx(b, 0.06, 0.016, 0.004, -0.12, 0.23, s * (W / 2 + 0.003), red);
    bx(b, 0.016, 0.06, 0.004, -0.12, 0.23, s * (W / 2 + 0.003), red);
    bx(b, 0.1, 0.12, 0.008, 0.12, 0.15, s * (W / 2 + 0.004), WHITE, s > 0 ? 2 : 3);
  }
  bx(b, 0.04, 0.025, W * 0.85, 0.08, 0.305, 0, DARK);
  bx(b, 0.01, 0.03, W * 0.99, L / 2 - 0.02, 0.07, 0, DARK);
  wheels(b, 0.048, 0.04, [0.19, -0.17], W / 2 - 0.014);
  return { geo: b.build(true), rig: new THREE.Vector4(0.17, W / 2 + 0.004, 0, 0), len: L, barY: 0.325, barX: 0.08 };
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _pt = { x: 0, y: 0 };

/** An emergency vehicle as the civilian traffic sees it (traffic.ts gives way / drives round). */
export interface EmVehicle {
  x: number;
  y: number;
  yaw: number;
  v: number;
  len: number;
  /** Blue lights and siren on (on the way in). */
  siren: boolean;
  /** Stopped at the kerb by the incident. */
  parked: boolean;
}

let activeEm: Emergency | null = null;

/** The emergency vehicles within `r` of (x, y) (empty when there are none). */
export function emergencyNear(x: number, y: number, r: number): EmVehicle[] {
  if (!activeEm) return [];
  return activeEm.vehicles.filter((e) => Math.abs(e.x - x) < r && Math.abs(e.y - y) < r && Math.hypot(e.x - x, e.y - y) < r);
}

export class Emergency {
  /** The vehicles on the road now (refreshed every update). */
  readonly vehicles: EmVehicle[] = [];
  /** Distance to the nearest car in the way ahead of a vehicle (traffic.ts), so it doesn't drive through. */
  ahead: ((x: number, y: number, yaw: number, halfW: number) => number) | null = null;
  readonly group = new THREE.Group();
  private units: Unit[] = [];
  private incidents: Incident[] = [];
  private inst: AnimInstances[] = [];
  // (built at the old half scale like the civilian cars: enlarged the same way, models.ts CAR_SCALE)
  private models = [emergencyModel(0), emergencyModel(1)].map((m) => {
    const k = CAR_SCALE;
    m.geo.scale(k, k, k);
    m.geo.computeBoundingSphere();
    m.rig.x *= k;
    m.rig.y *= k;
    return { ...m, len: m.len * k, barY: m.barY * k, barX: m.barX * k };
  });
  private time = 0;
  private lastDanger: { x: number; y: number; t: number }[] = [];
  private maxUnits: number;
  sound: SoundFn | null = null;
  /** Nearest pavement-like spot to (x, y) within r (people.ts), for the crew. */
  snap: ((x: number, y: number, r: number) => { x: number; y: number } | null) | null = null;
  readonly stat = { incidents: 0, dispatched: 0, noRoute: 0 };

  constructor(
    private map: GameMap,
    private net: RoadNet | null,
    fog: FogOfWar,
    private probe: FogProbe,
    private lights: LightSprites,
    private figures: Figure[],
    quality: Quality,
    phone: boolean,
  ) {
    this.maxUnits = quality === 'low' ? 0 : phone || quality === 'medium' ? 4 : 6;
    activeEm = this;
    this.models.forEach((mdl, i) => {
      const mat = ambientMaterial(fog, 'car', mdl.rig, 0.45, 0.15);
      const im = new AnimInstances(mdl.geo, mat, 4, i ? 'ambient-ambulance' : 'ambient-police', { shadow: quality === 'high', heat: true });
      this.inst.push(im);
      this.group.add(im.mesh);
    });
  }

  get count() {
    return this.units.length;
  }

  /** A civilian building came down at (x, y). */
  /** Match over: drop the module's pointer to this instance (it would keep the whole old scene alive). */
  dispose() {
    if (activeEm === this) activeEm = null;
  }

  incident(x: number, y: number) {
    if (!this.net || this.maxUnits <= 0) return;
    if (this.incidents.some((i) => Math.hypot(i.x - x, i.y - y) < 6) || this.units.some((u) => u.s !== V.Out && Math.hypot(u.tx - x, u.ty - y) < 6)) return;
    this.stat.incidents++;
    this.incidents.push({ x, y, t: 0, wait: 45, police: true, ambulance: Math.random() < 0.75 });
  }

  /** Remember fighting (dispatch waits until it is quiet near the incident). */
  danger(x: number, y: number) {
    if (this.lastDanger.length > 48) this.lastDanger.shift();
    this.lastDanger.push({ x, y, t: this.time });
  }

  private quiet(x: number, y: number, r: number, sec: number) {
    for (const d of this.lastDanger) if (this.time - d.t < sec && Math.hypot(d.x - x, d.y - y) < r) return false;
    return true;
  }

  private dispatch(inc: Incident, kind: 0 | 1): boolean {
    if (this.units.length >= this.maxUnits || !this.net) return false;
    const r = planRoute(this.net, inc.x, inc.y, 4.5, 12, 75);
    if (!r) {
      this.stat.noRoute++;
      return false;
    }
    // the second vehicle parks behind the first: stop a little short
    const segs = r.segs.map((s) => ({ ...s }));
    if (kind === 1) {
      const last = segs[segs.length - 1];
      const dir = last.a1 >= last.a0 ? 1 : -1;
      last.a1 -= dir * Math.min(1.05, Math.abs(last.a1 - last.a0) * 0.8);
    }
    const poly = routePolyline(this.net, segs, 0.25, 1.4, 0.4);
    if (poly.length < 3) return false;
    const cum = new Float32Array(poly.length);
    for (let i = 1; i < poly.length; i++) cum[i] = cum[i - 1] + Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
    const crew: Figure[] = [];
    const n = kind === 0 ? 2 : 2;
    for (let i = 0; i < n; i++) {
      const f: Figure = {
        x: poly[0].x,
        y: poly[0].y,
        yaw: 0,
        hgt: 0,
        size: 0.97 + Math.random() * 0.06,
        phase: Math.random() * 6,
        stride: 0,
        pose: Pose.Walk,
        mask: kind === 0 ? Opt.Peaked | Opt.HiVis : Opt.HiVis,
        lean: 0,
        skin: new THREE.Color([0xe8c4a8, 0xc08a68, 0x9a6a4a, 0xf0d0b8][(Math.random() * 4) | 0]),
        top: new THREE.Color(kind === 0 ? 0x1a2238 : 0x2a6a3a),
        bot: new THREE.Color(kind === 0 ? 0x161a26 : 0x1e3a26),
        hat: new THREE.Color(kind === 0 ? 0x161a26 : 0x2a1d14),
        show: false,
      };
      crew.push(f);
      this.figures.push(f);
    }
    this.units.push({ kind, s: V.In, poly, cum, arc: 0, v: 0.6, x: poly[0].x, y: poly[0].y, yaw: Math.atan2(poly[1].y - poly[0].y, poly[1].x - poly[0].x), hgt: groundAt(this.map, poly[0].x, poly[0].y), door: 0, t: 0, siren: Math.random() * 2, sirenT: 0, segs, portal: r.portal, crew, tx: inc.x, ty: inc.y, seen: false, goal: new Float32Array(4).fill(-1) });
    this.stat.dispatched++;
    return true;
  }

  private at(u: Unit, a: number, out: { x: number; y: number }) {
    const c = u.cum;
    const p = u.poly;
    const s = Math.max(0, Math.min(c[c.length - 1], a));
    let lo = 0;
    let hi = c.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (c[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    const seg = c[lo + 1] - c[lo] || 1;
    const t = (s - c[lo]) / seg;
    out.x = p[lo].x + (p[lo + 1].x - p[lo].x) * t;
    out.y = p[lo].y + (p[lo + 1].y - p[lo].y) * t;
  }

  update(f: AmbientFrame) {
    const dt = Math.min(0.1, f.dt);
    this.time += dt;
    for (const d of f.dangers) if (d.power >= 0.3) this.danger(d.x, d.y);
    // incidents wait for a lull, then the police (first) and the ambulance roll
    for (let i = this.incidents.length - 1; i >= 0; i--) {
      const inc = this.incidents[i];
      inc.t += dt;
      inc.wait -= dt;
      if (inc.t < 5 || (!this.quiet(inc.x, inc.y, 10, 6) && inc.wait > 0)) continue;
      if (inc.police && this.dispatch(inc, 0)) inc.police = false;
      else if (inc.police) inc.police = false;
      if (inc.ambulance && inc.t > 9 && this.dispatch(inc, 1)) inc.ambulance = false;
      if (!inc.police && (!inc.ambulance || inc.t > 60)) this.incidents.splice(i, 1);
    }
    const P = _pt;
    this.vehicles.length = 0;
    for (const u of this.units)
      if (u.s !== V.Done) this.vehicles.push({ x: u.x, y: u.y, yaw: u.yaw, v: u.v, len: this.models[u.kind].len, siren: u.s === V.In, parked: u.s === V.Parked });
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      u.t += dt;
      const total = u.cum[u.cum.length - 1];
      if (u.s === V.In || u.s === V.Out) {
        // fast on the straight, slow into the corners and to the stop
        this.at(u, u.arc + 1.2, P);
        const ax = P.x - u.x;
        const ay = P.y - u.y;
        const turn = Math.abs(wrapAngle(Math.atan2(ay, ax) - u.yaw));
        const left = total - u.arc;
        let vmax = Math.min(u.s === V.In ? 1.5 : 1.1, 0.45 + 1.4 * Math.max(0, 1 - turn * 1.3), u.s === V.In ? 0.25 + left * 0.45 : 9);
        // a car still in the way: close up behind it, it pulls over (traffic.ts)
        if (this.ahead) {
          const mdl = this.models[u.kind];
          const d = this.ahead(u.x, u.y, u.yaw, mdl.len * 0.21);
          vmax = Math.min(vmax, Math.max(0, (d - mdl.len * 0.95) * 1.5));
        }
        u.v += (vmax - u.v) * Math.min(1, dt * (vmax < u.v ? 3 : 1.2));
        u.arc = Math.min(total, u.arc + u.v * dt);
        this.at(u, u.arc, P);
        const nx = P.x;
        const ny = P.y;
        this.at(u, u.arc + 0.25, P);
        if (Math.hypot(P.x - nx, P.y - ny) > 1e-3) {
          const want = Math.atan2(P.y - ny, P.x - nx);
          u.yaw = wrapAngle(u.yaw + Math.max(-dt * 3, Math.min(dt * 3, wrapAngle(want - u.yaw))));
        }
        u.x = nx;
        u.y = ny;
        u.hgt += (groundAt(this.map, u.x, u.y) - u.hgt) * Math.min(1, dt * 10);
        if (u.s === V.In) {
          u.siren -= dt;
          // Sirens sound for at most 10 seconds per response so they don't loop endlessly or annoy the player
          if (u.sirenT < 10) {
            u.sirenT += dt;
            if (u.siren <= 0) {
              u.siren = 2.0;
              this.sound?.(u.kind ? 'sirenHiLo' : 'siren', 0.6, u.x, u.y);
            }
          }
        }
        if (u.arc >= total - 0.02) {
          if (u.s === V.In) {
            u.s = V.Parked;
            u.t = 0;
            u.v = 0;
            this.crewOut(u);
          } else {
            u.s = V.Done;
          }
        } else if ((u.s === V.In && u.t > 60 && u.v < 0.1) || (u.s === V.Out && u.t > 60)) {
          // Stuck vehicle watchdog: clear blocked vehicles so roads aren't obstructed forever
          u.s = V.Done;
        }
      } else if (u.s === V.Parked) {
        u.door = Math.min(1, u.door + dt * 2);
        this.stepCrew(u, dt, u.t < 40 + u.kind * 15);
        if (u.t > 90) {
          u.s = V.Done;
        } else if (u.t > 40 + u.kind * 15 && this.crewBack(u)) {
          u.door = Math.max(0, u.door - dt * 2);
          if (u.door <= 0) {
            for (const c of u.crew) c.show = false;
            // drive off the way they came
            if (!this.net) {
              u.s = V.Done;
              continue;
            }
            u.segs = reverseSegs(u.segs);
            u.poly = routePolyline(this.net, u.segs, 0.25, 0);
            u.cum = new Float32Array(u.poly.length);
            for (let k = 1; k < u.poly.length; k++) u.cum[k] = u.cum[k - 1] + Math.hypot(u.poly[k].x - u.poly[k - 1].x, u.poly[k].y - u.poly[k - 1].y);
            u.arc = 0;
            u.s = V.Out;
            u.v = 0.1;
          }
        }
      }
      if (u.s === V.Done) {
        for (const c of u.crew) {
          c.show = false;
          const k = this.figures.indexOf(c);
          if (k >= 0) this.figures.splice(k, 1);
        }
        this.units.splice(i, 1);
      }
    }
  }

  private crewOut(u: Unit) {
    const ca = Math.cos(u.yaw);
    const sa = Math.sin(u.yaw);
    u.crew.forEach((c, i) => {
      // out of the doors on either side
      const side = i ? -1 : 1;
      c.x = u.x + ca * 0.05 - sa * side * 0.2 * CAR_SCALE;
      c.y = u.y + sa * 0.05 + ca * side * 0.2 * CAR_SCALE;
      c.yaw = u.yaw + side * 1.4;
      c.hgt = groundAt(this.map, c.x, c.y);
      c.show = true;
    });
  }

  /** Crew at work: officers by the car (one waving traffic on), paramedics over at the ruin. */
  private stepCrew(u: Unit, dt: number, working: boolean) {
    const ca = Math.cos(u.yaw);
    const sa = Math.sin(u.yaw);
    u.crew.forEach((c, i) => {
      let gx: number;
      let gy: number;
      if (!working) {
        const side = i ? -1 : 1;
        gx = u.x - sa * side * 0.2 * CAR_SCALE;
        gy = u.y + ca * side * 0.2 * CAR_SCALE;
      } else if (u.kind === 1) {
        // over to the pavement in front of the ruin
        const dx = u.tx - u.x;
        const dy = u.ty - u.y;
        const d = Math.hypot(dx, dy) || 1;
        const k = Math.max(0, Math.min(d - 1.4, 2.2));
        gx = u.x + (dx / d) * k + (i ? 0.18 : -0.18) * (-dy / d);
        gy = u.y + (dy / d) * k + (i ? 0.18 : -0.18) * (dx / d);
        if (u.goal[i * 2] < 0 && this.snap) {
          const p = this.snap(gx, gy, 1.2);
          if (p) {
            u.goal[i * 2] = p.x;
            u.goal[i * 2 + 1] = p.y;
          }
        }
        if (u.goal[i * 2] >= 0) {
          gx = u.goal[i * 2];
          gy = u.goal[i * 2 + 1];
        }
      } else {
        gx = u.x + (i ? -ca * 0.45 : ca * 0.42) * CAR_SCALE - sa * 0.35 * CAR_SCALE;
        gy = u.y + (i ? -sa * 0.45 : sa * 0.42) * CAR_SCALE + ca * 0.35 * CAR_SCALE;
      }
      const dx = gx - c.x;
      const dy = gy - c.y;
      const d = Math.hypot(dx, dy);
      const sp = d > 0.05 ? 0.35 : 0;
      if (sp) {
        c.yaw = Math.atan2(dy, dx);
        const nx = c.x + (dx / d) * Math.min(d, sp * dt);
        const ny = c.y + (dy / d) * Math.min(d, sp * dt);
        if (dryAt(this.map, nx, ny, 0.2)) {
          c.x = nx;
          c.y = ny;
        }
      } else if (working) c.yaw = u.kind === 1 ? Math.atan2(u.ty - c.y, u.tx - c.x) : u.yaw + (i ? Math.PI : 0) + Math.sin(this.time * 0.3 + i) * 0.5;
      c.phase += sp ? ((sp * dt) / (1.45 * 0.264)) * Math.PI * 2 : dt * 2;
      c.stride += ((sp ? 1 : 0) - c.stride) * Math.min(1, dt * 6);
      c.pose = sp ? Pose.Walk : !working ? Pose.Walk : u.kind === 1 ? Pose.Vendor : i === 0 ? Pose.Wave : Pose.Chat;
      c.hgt += (groundAt(this.map, c.x, c.y) - c.hgt) * Math.min(1, dt * 10);
    });
  }

  private crewBack(u: Unit) {
    for (const c of u.crew) if (Math.hypot(c.x - u.x, c.y - u.y) > 0.25 * CAR_SCALE) return false;
    return true;
  }

  draw(f: AmbientFrame, time: number) {
    for (const im of this.inst) im.begin();
    const dk = f.dark;
    for (const u of this.units) {
      const vis = this.probe.visible(u.x, u.y) && u.x > f.vx0 && u.x < f.vx1 && u.y > f.vy0 && u.y < f.vy1;
      u.seen = vis;
      if (!vis) continue;
      const mdl = this.models[u.kind];
      _e.set(0, -u.yaw, 0, 'YXZ');
      _q.setFromEuler(_e);
      _m.compose(_p.set(u.x, u.hgt, u.y), _q, _s);
      this.inst[u.kind].push(_m, 0, u.door, 0, 0, 1, 1, 1);
      // flashing light bar: police blue / red, ambulance blue / white; both sides alternate
      const hx = Math.cos(u.yaw);
      const hy = Math.sin(u.yaw);
      const rx = -hy;
      const ry = hx;
      const ph = Math.floor(time * 6 + u.kind) % 2;
      const k = 1.2 + dk * 1.6;
      const bxp = u.x + hx * mdl.barX;
      const byp = u.y + hy * mdl.barX;
      const y = u.hgt + mdl.barY;
      for (const sd of [-1, 1]) {
        const on = (sd > 0) === (ph === 0);
        const blue = u.kind === 1 || sd > 0;
        if (!on) continue;
        const cr = blue ? 0.15 : 2.2;
        const cg = blue ? 0.35 : 0.1;
        const cb = blue ? 2.4 : 0.08;
        this.lights.flare(bxp + rx * sd * 0.07, y, byp + ry * sd * 0.07, 0.12 + dk * 0.08, cr * k, cg * k, cb * k);
        if (dk > 0.15) this.lights.pool(u.x + rx * sd * 0.3, groundAt(this.map, u.x, u.y), u.y + ry * sd * 0.3, -u.yaw, 0.9, 0.9, cr * 0.15 * dk, cg * 0.15 * dk, cb * 0.15 * dk);
      }
      if (u.kind === 1 && Math.floor(time * 3) % 2) this.lights.flare(u.x + hx * (mdl.len / 2), u.hgt + 0.12 * CAR_SCALE, u.y + hy * (mdl.len / 2), 0.07 + dk * 0.05, 1.8 * k, 1.8 * k, 1.7 * k);
    }
    for (const im of this.inst) im.commit();
  }

  /** Debug / screenshots. */
  debug() {
    return { ...this.stat, units: this.units.map((u) => ({ kind: u.kind, s: u.s, x: +u.x.toFixed(1), y: +u.y.toFixed(1), arc: +u.arc.toFixed(1), len: +u.cum[u.cum.length - 1].toFixed(1), seen: u.seen })), pending: this.incidents.length };
  }
}
