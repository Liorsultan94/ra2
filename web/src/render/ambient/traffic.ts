import * as THREE from 'three';
import { Tile, WATER_LEVEL, type GameMap } from '../../sim/map';
import type { BridgeState } from '../../sim/bridges';
import type { Effects } from '../effects';
import type { FogOfWar } from '../fog';
import type { Layout } from '../layout';
import { Driver, newDriveCar, type DriveCar, type HoldPoint, type OtherCar } from './driver';
import { emergencyNear } from './emergency';
import { crossingBusy } from './people';
import { levelCrossingClosed, levelCrossings } from './rail';
import { zebraBands } from './walkgrid';
import { CAR_SCALE, carModel, type CarModel } from './models';
import { RoadFurniture } from './roadfurniture';
import { roadNetFor } from './clearance';
import { SigMode, nearestArc, pointAt, type RoadNet } from './roadnet';
import { deckSurface } from '../deckramp';
import { AnimInstances, ambientMaterial, groundAt, walkable, wrapAngle, type AmbientFrame, type FogProbe, type LightSprites, type Quality } from './shared';

/*
 * Civilian traffic: cars, vans, pickups and tractors driving the paved roads
 * and dirt tracks of the scenery layout, by the rules (driver.ts on the lane
 * graph of roadnet.ts): keeping right at the zone's speed limit, indicating,
 * stopping at red lights and give-way lines, queueing, giving way to traffic
 * on roundabouts, turning round on the turning circles at dead ends (or with
 * a 3-point turn on the road), leaving / entering at the map edges.
 * Collapsed bridges are not crossed.
 *
 * Combat overrides the rules: nearby fighting makes them flee (speed up and
 * turn away, lights ignored), some swerve off the road and are abandoned with
 * doors open and hazard lights blinking; blasts wreck them (burnt, sometimes
 * flipped, burning for a while). Destroyed buildings knock the traffic lights
 * close by out (blinking amber or dark).
 *
 * One instanced draw call per vehicle type (4); lights (head / tail / brake /
 * indicators / reversing) share LightSprites; road furniture: roadfurniture.ts.
 */

const enum S {
  Drive = 0,
  Offroad = 1,
  Abandoned = 2,
  Rejoin = 3,
  Wreck = 4,
  Sinking = 5,
}

interface Car extends DriveCar {
  model: CarModel;
  s: S;
  paint: THREE.Color;
  calm: number;
  door: number;
  burnt: number;
  roll: number;
  rollTarget: number;
  lift: number;
  liftV: number;
  fire: number;
  blocked: number;
  tx: number;
  ty: number;
  hgt: number;
  pitch: number;
  bank: number;
  seen: boolean;
  sink: number;
  /** U-turn cooldown (s): a car mid-turn must not flip back. */
  cd: number;
  /** Still driving (for the rules of the others). */
  driving: boolean;
}

const PAINTS = [0xe8e8e6, 0xb8bcc0, 0x24272b, 0x9e1c1c, 0x1f3f7a, 0x2c4a32, 0xc9b48a, 0xd7a92a, 0x5a6b7a, 0x6e2a3a, 0x3d8fb0, 0xece5d0].map((c) => new THREE.Color(c));
const VAN_PAINTS = [0xf0f0ee, 0xf0f0ee, 0xd8d8d4, 0x2a4f8a, 0xb02020, 0xe0c040].map((c) => new THREE.Color(c));
const TRACTOR_PAINTS = [0x2f7a2e, 0x2f7a2e, 0xb0201a, 0x1f4fa0, 0xd8b020].map((c) => new THREE.Color(c));
const CRUISE = [1.25, 1.05, 1.1, 0.5];

const _m = new THREE.Matrix4();
const _r = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

export class Traffic {
  readonly group = new THREE.Group();
  readonly net: RoadNet;
  readonly furniture: RoadFurniture;
  private driver: Driver;
  private cars: Car[] = [];
  private inst: AnimInstances[] = [];
  private models: CarModel[] = [];
  private target: number;
  private spawnT = 3;
  private portals: { line: number; end: number }[] = [];
  /** The cars plus the emergency vehicles, as the rules see them (rebuilt every update). */
  private others: OtherCar[] = [];
  private crossings: { x: number; y: number }[] = [];
  /**
   * Night headlight beams on the road (index.ts wires NightLights.carLight): front bumper, road height, world yaw, 0..1,
   * and the car's body length (tiles, CAR_SCALE included) that sizes the beam and its pool.
   */
  headlight: ((x: number, y: number, z: number, yaw: number, k: number, len: number) => void) | null = null;

  constructor(
    private map: GameMap,
    layout: Layout,
    private bridges: readonly BridgeState[],
    fog: FogOfWar,
    private effects: Effects,
    private probe: FogProbe,
    private lights: LightSprites,
    quality: Quality,
    phone: boolean,
    /** The players' nations (the local player first): flags and billboard languages. */
    nations: string[] = [],
  ) {
    this.net = roadNetFor(map, layout, bridges);
    this.driver = new Driver(this.net, (li) => this.usableLine(li));
    this.net.lines.forEach((L, li) => {
      if (L.bridge >= 0) return;
      for (let e = 0; e < 2; e++) if (L.portal[e]) this.portals.push({ line: li, end: e });
    });
    // zebra crossings (people on them) and level crossings (barriers down): the cars stop before them
    {
      const holds: HoldPoint[] = [];
      const onto = (kind: number, x: number, y: number, wx: number, wy: number, gap: number) => {
        this.net.lines.forEach((Ln, li) => {
          if (Ln.bridge >= 0 || Ln.lot >= 0) return;
          const { arc, d } = nearestArc(Ln, x, y);
          if (d > Ln.half + 0.2 || arc < 0.05 || arc > Ln.len - 0.05) return;
          // the crossing runs across this road (not along it)
          const p = pointAt(Ln, arc);
          if (wx || wy) if (Math.abs(p.tx * wx + p.ty * wy) > 0.55) return;
          holds.push({ kind, line: li, arc, gap, x, y });
        });
      };
      for (const z of zebraBands(map, layout, this.net)) onto(0, z.x, z.y, z.dx, z.dy, z.hw + 0.12);
      for (const lc of levelCrossings(map)) {
        if (!lc.traffic) continue;
        this.crossings.push({ x: lc.x, y: lc.y });
        const n0 = holds.length;
        onto(1, lc.x, lc.y, 0, 0, 0.95);
        if (holds.length > n0) continue;
        // just past a map-edge end of a road (the line stops at the edge): hold the cars heading out
        // short of the edge (where they would leave the map) while it is closed
        this.net.lines.forEach((Ln, li) => {
          if (Ln.bridge >= 0) return;
          for (let e = 0; e < 2; e++) {
            if (!Ln.portal[e]) continue;
            const p = pointAt(Ln, e ? Ln.len : 0);
            const ox = e ? p.tx : -p.tx;
            const oy = e ? p.ty : -p.ty;
            const t = (lc.x - p.x) * ox + (lc.y - p.y) * oy;
            const side = Math.abs((lc.x - p.x) * -oy + (lc.y - p.y) * ox);
            if (t < -0.5 || t > 3 || side > 1.8) continue;
            holds.push({ kind: 1, line: li, arc: e ? Ln.len + t : -t, gap: Math.max(0.95, t + 0.1), x: lc.x, y: lc.y });
          }
        });
      }
      this.driver.setHolds(holds, (h) => (h.kind === 1 ? levelCrossingClosed(h.x, h.y) : crossingBusy(h.x, h.y, 1.0)));
    }
    this.furniture = new RoadFurniture(map, this.net, fog, probe, lights, quality, nations);
    this.group.add(this.furniture.group);
    const base = quality === 'high' ? 13 : quality === 'medium' ? 10 : 7;
    // the city's grid carries more traffic
    const city = map.biome === 'urban' ? 1.5 : 1;
    this.target = this.net.lines.length ? Math.max(4, Math.round(base * city * (phone ? 0.75 : 1))) : 0;
    for (let k = 0; k < 4; k++) {
      const m = carModel(k);
      this.models.push(m);
      const mat = ambientMaterial(fog, 'car', m.rig, k === 3 ? 0.7 : 0.45, k === 3 ? 0.1 : 0.35);
      const inst = new AnimInstances(m.geo, mat, 80, `ambient-cars-${k}`, { shadow: quality === 'high', heat: true });
      this.inst.push(inst);
      this.group.add(inst.mesh);
    }
    for (let i = 0; i < this.target; i++) this.spawn(true);
    // the parking lots start part full (they come and go later)
    this.net.lots.forEach((lot, li) => {
      if (lot.line < 0) return;
      lot.bays.forEach((_, k) => {
        if (Math.random() > (lot.city ? 0.6 : 0.45)) return;
        const r = Math.random();
        const c = this.makeCar(r < 0.6 ? 0 : r < 0.8 ? 1 : 2, lot.line, this.net.lines[lot.line].len, 1);
        this.driver.parkAt(c, li, k, 10 + Math.random() * 220);
        this.cars.push(c);
      });
    });
  }

  // ------------------------------------------------------------------ network

  private bridgeUp(bi: number): boolean {
    const b = this.bridges[bi];
    if (!b) return false;
    for (const t of b.tiles) if (this.map.tiles[t] !== Tile.Bridge) return false;
    return true;
  }

  private usableLine(li: number): boolean {
    const B = this.net.lines[li];
    return B.bridge < 0 || this.bridgeUp(B.bridge);
  }

  /** A building died at (x, y): traffic lights close by fail (blinking amber or dark); power plants reach further. */
  outage(x: number, y: number, power: boolean) {
    const r = power ? 14 : 8;
    for (const sg of this.net.signals) {
      if (sg.mode !== SigMode.Normal) continue;
      if (Math.hypot(sg.x - x, sg.y - y) < r) sg.mode = Math.random() < 0.6 ? SigMode.Flash : SigMode.Dark;
    }
  }

  // ------------------------------------------------------------------ spawning

  private pickKind(paved: boolean): number {
    const r = Math.random();
    if (paved) return r < 0.5 ? 0 : r < 0.72 ? 1 : r < 0.92 ? 2 : 3;
    return r < 0.2 ? 0 : r < 0.55 ? 2 : 3;
  }

  private spawn(initial: boolean, units?: Float32Array, nUnits = 0, view?: AmbientFrame) {
    const net = this.net;
    const L = net.lines;
    let line = -1;
    let arc = 0;
    let dir = 1;
    for (let tries = 0; tries < 16 && line < 0; tries++) {
      if (initial || !this.portals.length) {
        // anywhere on the network, weighted by length (bridges excluded)
        let tot = 0;
        for (const l of L) if (l.bridge < 0) tot += Math.max(0, l.a1 - l.a0);
        let r = Math.random() * tot;
        let li = 0;
        for (; li < L.length; li++) {
          if (L[li].bridge >= 0) continue;
          r -= Math.max(0, L[li].a1 - L[li].a0);
          if (r <= 0) break;
        }
        li = Math.min(li, L.length - 1);
        const Ln = L[li];
        if (Ln.bridge >= 0 || Ln.a1 - Ln.a0 < 1.2) continue;
        line = li;
        arc = Ln.a0 + 0.5 + Math.random() * (Ln.a1 - Ln.a0 - 1);
        dir = Math.random() < 0.5 ? 1 : -1;
      } else {
        const p = this.portals[(Math.random() * this.portals.length) | 0];
        line = p.line;
        arc = p.end ? L[line].len - 0.3 : 0.3;
        dir = p.end ? -1 : 1;
        // a level crossing right by the entry with its barriers down: they wait outside the map
        const q = pointAt(L[line], arc);
        if (this.crossings.some((lc) => Math.hypot(lc.x - q.x, lc.y - q.y) < 3.2 && levelCrossingClosed(lc.x, lc.y))) {
          line = -1;
          continue;
        }
      }
      const pt = pointAt(L[line], arc);
      const px = pt.x;
      const py = pt.y;
      let bad = false;
      if (units) for (let i = 0; i < nUnits && !bad; i++) if (Math.hypot(units[i * 2] - px, units[i * 2 + 1] - py) < 7) bad = true;
      for (const c of this.cars) if (Math.hypot(c.x - px, c.y - py) < 1.2) bad = true;
      // not inside a junction or on a turning circle
      for (const lp of net.loops) if (Math.hypot(lp.x - px, lp.y - py) < lp.R + 0.4) bad = true;
      for (const nd of net.nodes) if (nd.arms.length > 2 && Math.hypot(nd.x - px, nd.y - py) < 2.2) bad = true;
      // don't pop into view mid-road (map-edge entries are fine: they drive in)
      if (!initial && view && !this.portals.length && px > view.vx0 && px < view.vx1 && py > view.vy0 && py < view.vy1) bad = true;
      if (bad) line = -1;
    }
    if (line < 0) return;
    const c = this.makeCar(this.pickKind(L[line].paved), line, arc, dir);
    c.v = initial ? c.cruise * 0.8 : c.cruise * 0.6;
    this.cars.push(c);
  }

  private makeCar(kind: number, line: number, arc: number, dir: number): Car {
    const Ln = this.net.lines[line];
    const pal = kind === 1 ? VAN_PAINTS : kind === 3 ? TRACTOR_PAINTS : PAINTS;
    const pt = pointAt(Ln, arc);
    const yaw = Math.atan2(pt.ty * dir, pt.tx * dir);
    const x = pt.x - pt.ty * dir * Ln.lane;
    const y = pt.y + pt.tx * dir * Ln.lane;
    const cruise = CRUISE[kind] * (Ln.paved ? 1 : 0.62) * (0.85 + Math.random() * 0.3);
    const model = this.models[kind];
    const d = newDriveCar(kind, model.len, line, arc, dir, x, y, yaw, cruise, model.wid);
    return Object.assign(d, {
      model,
      s: S.Drive,
      paint: pal[(Math.random() * pal.length) | 0].clone().multiplyScalar(0.9 + Math.random() * 0.15),
      calm: 0,
      door: 0,
      burnt: 0,
      roll: 0,
      rollTarget: 0,
      lift: 0,
      liftV: 0,
      fire: 0,
      blocked: 0,
      tx: 0,
      ty: 0,
      hgt: groundAt(this.map, x, y),
      pitch: 0,
      bank: 0,
      seen: false,
      sink: 0,
      cd: 0,
      driving: true,
    });
  }

  // ------------------------------------------------------------------ reactions

  private react(c: Car, f: AmbientFrame) {
    for (const d of f.dangers) {
      const dx = c.x - d.x;
      const dy = c.y - d.y;
      const dist = Math.hypot(dx, dy);
      if (dist > d.r) continue;
      if (c.s === S.Wreck || c.s === S.Sinking) continue;
      if (d.kill > 0 && dist < d.kill + 0.2) {
        this.wreck(c, dx, dy, dist, d);
        continue;
      }
      c.calm = 0;
      if (c.s === S.Abandoned) continue;
      c.panic = Math.max(c.panic, 7 + Math.random() * 5);
      if (c.s !== S.Drive || c.pk) continue; // (parked / parking: they sit it out)
      const hx = Math.cos(c.yaw);
      const hy = Math.sin(c.yaw);
      const ahead = (-dx * hx - dy * hy) / (dist || 1);
      // some bail out off the road (more likely when it's loud and close)
      const bail = (d.power > 0.5 ? 0.35 : 0.15) * (dist < d.r * 0.6 ? 1.4 : 1);
      if (c.kind !== 3 && Math.random() < bail && this.trySwerve(c, d.x, d.y)) continue;
      if (ahead > 0.25) this.turnRound(c); // danger in front: turn round
    }
  }

  /**
   * Turn round: fleeing cars swing round on the spot (combat: anything goes);
   * otherwise a 3-point turn on the road (roundabout cars just keep circulating).
   */
  private turnRound(c: Car) {
    if (c.cd > 0 || c.pk) return;
    if (c.panic > 0) {
      c.kt = 0;
      if (c.loop >= 0) return;
      c.dir = -c.dir;
      c.planNode = -1;
      c.passed = -1;
      c.cd = 3;
      return;
    }
    if (c.kt || c.loop >= 0) return;
    this.driver.startTurn(c);
    c.cd = 6;
  }

  /** Swerve off the road away from (sx, sy): picks a free spot to the side. */
  private trySwerve(c: Car, sx: number, sy: number): boolean {
    const hx = Math.cos(c.yaw);
    const hy = Math.sin(c.yaw);
    const rx = -hy;
    const ry = hx;
    const side = (c.x - sx) * rx + (c.y - sy) * ry >= 0 ? 1 : -1;
    for (const sgn of [side, -side]) {
      const off = 0.9 + Math.random() * 0.9;
      const tx = c.x + rx * sgn * off + hx * (0.6 + c.v * 0.5);
      const ty = c.y + ry * sgn * off + hy * (0.6 + c.v * 0.5);
      let ok = true;
      for (let k = 1; k <= 4 && ok; k++) ok = walkable(this.map, c.x + ((tx - c.x) * k) / 4, c.y + ((ty - c.y) * k) / 4) && !this.map.trees[((c.y + ((ty - c.y) * k) / 4) | 0) * this.map.w + ((c.x + ((tx - c.x) * k) / 4) | 0)];
      if (!ok) continue;
      c.s = S.Offroad;
      c.tx = tx;
      c.ty = ty;
      c.loop = -1;
      c.kt = 0;
      c.ind = 0;
      return true;
    }
    return false;
  }

  private wreck(c: Car, dx: number, dy: number, dist: number, d: { kill: number; power: number }) {
    c.s = S.Wreck;
    c.fire = 10 + Math.random() * 16;
    c.panic = 0;
    c.loop = -1;
    c.kt = 0;
    c.ind = 0;
    const k = 1 - dist / (d.kill + 0.2);
    // blown over when close to a heavy blast
    if (d.power > 0.55 && k > 0.35 && Math.random() < 0.75) {
      c.rollTarget = (Math.random() < 0.5 ? 1 : -1) * (Math.random() < 0.6 ? Math.PI : Math.PI / 2);
      c.liftV = 1.2 + k * 1.6;
    } else c.liftV = 0.4 + k * 0.6;
    const l = dist || 1;
    c.tx = (dx / l) * (0.2 + k * 0.5);
    c.ty = (dy / l) * (0.2 + k * 0.5);
    c.v = 0;
    if (this.probe.visible(c.x, c.y)) {
      const g = groundAt(this.map, c.x, c.y);
      this.effects.explosion(c.x, g + 0.15, c.y, 'small', 'fire');
    }
  }

  // ------------------------------------------------------------------ update

  update(f: AmbientFrame) {
    const dt = Math.min(0.1, f.dt);
    if (!this.net.lines.length) return;
    // heavy blasts right by a traffic light knock it out
    for (const d of f.dangers) {
      if (d.kill < 0.9) continue;
      for (const sg of this.net.signals) if (sg.mode !== SigMode.Dark && Math.hypot(sg.x - d.x, sg.y - d.y) < d.kill + 1.6) sg.mode = Math.random() < 0.5 ? SigMode.Flash : SigMode.Dark;
    }
    // keep the density up: new cars come in from the map edges
    let alive = 0;
    for (const c of this.cars) {
      c.driving = c.s === S.Drive;
      if ((c.s === S.Drive && c.pk !== 3) || c.s === S.Rejoin || c.s === S.Offroad) alive++;
    }
    this.spawnT -= dt;
    if (alive < this.target && this.spawnT <= 0) {
      this.spawnT = 4 + Math.random() * 6;
      this.spawn(false, f.units, f.nUnits, f);
    }
    // too many wrecks / abandoned cars: clear the oldest one out of sight
    let parked = 0;
    for (const c of this.cars) if (c.s === S.Wreck || c.s === S.Abandoned || c.s === S.Sinking) parked++;
    for (let i = 0; i < this.cars.length && parked > 7; i++) {
      const c = this.cars[i];
      if ((c.s === S.Wreck && c.fire <= 0) || c.s === S.Abandoned) {
        if (c.x > f.vx0 && c.x < f.vx1 && c.y > f.vy0 && c.y < f.vy1) continue;
        this.cars.splice(i--, 1);
        parked--;
      }
    }

    // the emergency vehicles take part in the rules: sirens (everyone pulls over), parked at the kerb (drive round)
    this.others.length = 0;
    for (const c of this.cars) this.others.push(c);
    for (const e of emergencyNear(this.map.w / 2, this.map.h / 2, 1e5))
      this.others.push({ id: -1, x: e.x, y: e.y, yaw: e.yaw, v: e.v, loop: -1, ang: 0, left: 0, line: -1, dir: 1, driving: !e.parked, len: e.len, wid: e.len * 0.42, siren: e.siren, kerb: e.parked });
    for (let ci = this.cars.length - 1; ci >= 0; ci--) {
      const c = this.cars[ci];
      this.react(c, f);
      const inView = c.x > f.vx0 && c.x < f.vx1 && c.y > f.vy0 && c.y < f.vy1;
      if (c.s === S.Wreck || c.s === S.Sinking) {
        this.updateWreck(c, dt, inView);
        if (c.s === S.Sinking && c.sink > 3) this.cars.splice(ci, 1);
        continue;
      }
      // military units close by: unease (they turn round when units block the road ahead)
      let near = 1e9;
      let nx = 0;
      let ny = 0;
      for (let i = 0; i < f.nUnits; i++) {
        const d = Math.hypot(f.units[i * 2] - c.x, f.units[i * 2 + 1] - c.y);
        if (d < near) {
          near = d;
          nx = f.units[i * 2];
          ny = f.units[i * 2 + 1];
        }
      }
      if (near < 5 && c.s === S.Drive) {
        if (c.panic <= 0) {
          const ahead = ((nx - c.x) * Math.cos(c.yaw) + (ny - c.y) * Math.sin(c.yaw)) / (near || 1);
          if (ahead > 0.3) this.turnRound(c);
        }
        c.panic = Math.max(c.panic, 3);
      }
      c.panic = Math.max(0, c.panic - dt);
      c.cd = Math.max(0, c.cd - dt);
      c.calm += dt;
      if (c.s === S.Abandoned) {
        c.door = Math.min(1, c.door + dt * 1.6);
        c.v = 0;
        if (c.calm > 35 && near > 8) {
          // the driver comes back: doors shut, back onto the road
          c.s = S.Rejoin;
          c.arc = nearestArc(this.net.lines[c.line], c.x, c.y).arc;
        }
      } else c.door = Math.max(0, c.door - dt * 1.4);
      if (c.s === S.Abandoned) {
        this.place(c, dt);
        continue;
      }
      if (!inView && (ci + Math.floor(f.time * 10)) % 3 !== 0) {
        // off-screen: coarse steps are fine
        this.drive(c, dt * 3, near, false, f.time);
      } else this.drive(c, dt, near, inView, f.time);
      if (c.s === S.Drive && this.atPortalExit(c)) {
        this.cars.splice(ci, 1);
        continue;
      }
      this.place(c, dt);
    }
  }

  /**
   * Distance to the nearest car in the way of a vehicle at (x, y) heading `yaw` with half width
   * `halfW` (emergency.ts closes up behind it; cars pulled over for it don't count).
   */
  blockerAhead(x: number, y: number, yaw: number, halfW: number): number {
    const hx = Math.cos(yaw);
    const hy = Math.sin(yaw);
    let best = 1e9;
    for (const c of this.cars) {
      const dx = c.x - x;
      const dy = c.y - y;
      const along = dx * hx + dy * hy;
      if (along <= 0 || along > 4 || along >= best) continue;
      const lat = Math.abs(dx * -hy + dy * hx);
      // (pulled over for it: a little overlap is let through, it squeezes by)
      const room = halfW + c.model.wid / 2 - (c.yieldT > 0 ? 0.12 : 0.02);
      if (lat < room) best = along;
    }
    return best;
  }

  private atPortalExit(c: Car): boolean {
    if (c.loop >= 0 || c.kt) return false;
    const Ln = this.net.lines[c.line];
    if (c.dir > 0 && Ln.portal[1] && c.arc > Ln.len - 0.3) return true;
    if (c.dir < 0 && Ln.portal[0] && c.arc < 0.3) return true;
    return false;
  }

  private drive(c: Car, dt: number, nearUnit: number, inView: boolean, time: number): void {
    const L = this.net.lines;
    if (c.s === S.Drive) {
      const Ln = L[c.line];
      if (Ln.bridge >= 0 && c.loop < 0 && !this.bridgeUp(Ln.bridge)) {
        // the deck went down under the car
        c.s = S.Sinking;
        c.burnt = 0.3;
        c.liftV = 0;
        return;
      }
      const r = this.driver.step(c, this.others, time, dt, nearUnit);
      c.blocked = r.blocked ? c.blocked + dt : 0;
      if (c.blocked > 3.5) {
        c.cd = 0;
        this.turnRound(c);
        c.blocked = 0;
      }
    } else this.offroad(c, dt);
    // tractors on dirt kick up a little dust
    if (inView && c.kind === 3 && !L[c.line].paved && Math.abs(c.v) > 0.2 && Math.random() < dt * 1.2 && this.probe.visible(c.x, c.y)) {
      this.effects.dust(c.x - Math.cos(c.yaw) * 0.2, c.hgt, c.y - Math.sin(c.yaw) * 0.2, 0.35);
    }
  }

  /** Off the road: swerving out to a spot (then abandoned), or getting back onto the lane. */
  private offroad(c: Car, dt: number) {
    let cx: number;
    let cy: number;
    let stopAt = -1;
    if (c.s === S.Rejoin) {
      const Lr = this.net.lines[c.line];
      const p = pointAt(Lr, c.arc + c.dir * 0.6);
      cx = p.x - p.ty * c.dir * Lr.lane;
      cy = p.y + p.tx * c.dir * Lr.lane;
      if (Math.hypot(cx - c.x, cy - c.y) < 0.35) {
        c.s = S.Drive;
        c.loop = -1;
        c.kt = 0;
        c.planNode = -1;
        c.passed = -1;
      }
    } else {
      cx = c.tx;
      cy = c.ty;
      const d = Math.hypot(cx - c.x, cy - c.y);
      stopAt = d;
      // arrived (or the spot ended up inside the turning circle / it's taking too long): stop here
      const behind = Math.abs(wrapAngle(Math.atan2(cy - c.y, cx - c.x) - c.yaw)) > 1.3;
      if (d < 0.12 || (c.v < 0.05 && d < 0.4) || (behind && d < 0.9) || c.calm > 6) {
        c.s = S.Abandoned;
        c.calm = 0;
        c.v = 0;
        return;
      }
    }
    const want = Math.atan2(cy - c.y, cx - c.x);
    const dyaw = wrapAngle(want - c.yaw);
    const maxTurn = (Math.max(0, c.v) / (c.kind === 3 ? 0.3 : 0.36) + 0.25) * dt;
    c.yaw = wrapAngle(c.yaw + Math.max(-maxTurn, Math.min(maxTurn, dyaw)));
    const fleeing = c.panic > 0;
    let vt = c.cruise * (fleeing ? (c.kind === 3 ? 1.5 : 1.9) : 0.8);
    vt *= 1 - Math.min(0.7, Math.abs(dyaw) * 0.6);
    if (stopAt >= 0) vt = Math.min(vt, stopAt * 1.6 + 0.05);
    const acc = fleeing ? 1.6 : 0.7;
    c.v = vt > c.v ? Math.min(vt, c.v + acc * dt) : Math.max(vt, c.v - 2.4 * dt);
    c.x += Math.cos(c.yaw) * c.v * dt;
    c.y += Math.sin(c.yaw) * c.v * dt;
  }

  private updateWreck(c: Car, dt: number, inView: boolean) {
    const m = this.map;
    c.burnt = Math.min(1, c.burnt + dt * (c.s === S.Sinking ? 0.2 : 0.8));
    c.door = Math.max(0, c.door - dt);
    if (c.s === S.Sinking) {
      c.sink += dt;
      c.liftV -= 4 * dt;
      c.lift += c.liftV * dt;
      c.roll += dt * 0.6;
      this.place(c, dt, true);
      if (c.sink < 0.1 && this.probe.visible(c.x, c.y)) this.effects.splash(c.x, WATER_LEVEL, c.y, 0.6);
      return;
    }
    // thrown by the blast
    if (c.tx || c.ty) {
      const k = Math.min(1, dt * 6);
      const nx = c.x + c.tx * k;
      const ny = c.y + c.ty * k;
      if (walkable(m, nx, ny) || this.net.lines[c.line].paved) {
        c.x = nx;
        c.y = ny;
      }
      c.tx *= 1 - k;
      c.ty *= 1 - k;
      if (Math.abs(c.tx) + Math.abs(c.ty) < 0.01) c.tx = c.ty = 0;
    }
    c.liftV -= 6 * dt;
    c.lift = Math.max(0, c.lift + c.liftV * dt);
    if (c.lift <= 0) c.liftV = 0;
    c.roll += (c.rollTarget - c.roll) * Math.min(1, dt * 5);
    if (c.fire > 0) {
      c.fire -= dt;
      if (inView && this.probe.visible(c.x, c.y)) {
        const g = c.hgt + 0.15;
        if (Math.random() < dt * 9) this.effects.flame(c.x + (Math.random() - 0.5) * 0.2, g, c.y + (Math.random() - 0.5) * 0.15, 0.45);
        if (Math.random() < dt * 2.2) this.effects.column(c.x, g + 0.1, c.y, 0.5, true);
        this.effects.burnGlow(c.x, g + 0.1, c.y, 0.6);
      }
    }
    this.place(c, dt);
  }

  /** Ground following: height, pitch and bank from the terrain under the car. */
  private place(c: Car, dt: number, free = false) {
    const m = this.map;
    const half = c.model.len * 0.4;
    const hx = Math.cos(c.yaw);
    const hy = Math.sin(c.yaw);
    // on and near the bridges: the deck (with its end ramps) and the ramped approach roads
    const down = (i: number) => {
      const k = this.bridges.findIndex((b) => b.idx === i);
      return k >= 0 && !this.bridgeUp(k);
    };
    const at = (x: number, y: number) => deckSurface(m, x, y, down) ?? groundAt(m, x, y);
    const g = at(c.x, c.y);
    if (!free) {
      const gf = at(c.x + hx * half, c.y + hy * half);
      const gb = at(c.x - hx * half, c.y - hy * half);
      const gl = at(c.x - hy * 0.1, c.y + hx * 0.1);
      const gr = at(c.x + hy * 0.1, c.y - hx * 0.1);
      const k = Math.min(1, dt * 10);
      c.hgt += (Math.max(g, (gf + gb) / 2) - c.hgt) * Math.min(1, dt * 14);
      c.pitch += (Math.atan2(gf - gb, half * 2) - c.pitch) * k;
      c.bank += (Math.atan2(gr - gl, 0.2) - c.bank) * k;
    }
  }

  /** Write the instances (fog-culled), the lights and the road furniture. */
  draw(f: AmbientFrame, time: number) {
    for (const im of this.inst) im.begin();
    const dk = f.dark;
    const Lt = this.lights;
    for (const c of this.cars) {
      const vis = this.probe.visible(c.x, c.y);
      c.seen = vis;
      if (!vis) continue;
      const mdl = c.model;
      const h = 0.19 * CAR_SCALE;
      // root: position, yaw (tile y = world z, so yaw is negated about +Y), terrain pitch / bank, roll for flipped wrecks
      const y = c.hgt + c.lift;
      _e.set(c.bank, -c.yaw, c.pitch, 'YXZ');
      _q.setFromEuler(_e);
      _m.compose(_p.set(c.x, y + (c.roll ? h / 2 : 0), c.y), _q, _s);
      if (c.roll) {
        _r.makeRotationX(c.roll);
        _m.multiply(_r);
        _r.makeTranslation(0, -h / 2, 0);
        _m.multiply(_r);
      }
      this.inst[c.kind].push(_m, c.burnt, c.door, 0, 0, c.paint.r, c.paint.g, c.paint.b);
      // lights
      if (c.s === S.Wreck || c.s === S.Sinking) continue;
      const hx = Math.cos(c.yaw);
      const hy = Math.sin(c.yaw);
      const rx = -hy;
      const ry = hx;
      const fl = mdl.len / 2 + 0.01;
      const ly = y + mdl.lightY;
      const sw = mdl.wid * 0.33;
      const blink = Math.sin(time * 9 + c.id) > 0;
      if (c.s === S.Abandoned || (c.panic > 0 && c.s !== S.Drive)) {
        // hazard blinkers (day and night)
        if (blink) {
          const k = 0.8 + dk * 1.2;
          for (const sx of [fl, -fl])
            for (const sd of [-1, 1]) Lt.flare(c.x + hx * sx + rx * sd * sw * 1.2, ly, c.y + hy * sx + ry * sd * sw * 1.2, 0.09 + dk * 0.05, 1.9 * k, 0.9 * k, 0.15 * k);
        }
      } else if (c.ind && c.s === S.Drive && blink) {
        // indicators: front and rear corner on the side of the turn
        const k = 0.7 + dk * 1.1;
        const sd = c.ind > 0 ? 1 : -1;
        for (const sx of [fl, -fl]) Lt.flare(c.x + hx * sx + rx * sd * sw * 1.25, ly, c.y + hy * sx + ry * sd * sw * 1.25, 0.075 + dk * 0.04, 1.9 * k, 0.85 * k, 0.12 * k);
      }
      // the beam on the road ahead (night.ts; abandoned cars stand dark)
      if (dk > 0.08 && c.s !== S.Abandoned && this.headlight) this.headlight(c.x + hx * fl, c.hgt + c.lift, c.y + hy * fl, -c.yaw, 1, mdl.len);
      const braking = c.brake > 0 && c.s === S.Drive;
      if (dk > 0.08 && c.s !== S.Abandoned) {
        const k = dk;
        for (const sd of [-1, 1]) {
          Lt.flare(c.x + hx * fl + rx * sd * sw, ly, c.y + hy * fl + ry * sd * sw, 0.14, 2.0 * k, 1.85 * k, 1.5 * k);
          const b = braking ? 2.2 : 1;
          Lt.flare(c.x - hx * fl + rx * sd * sw, ly, c.y - hy * fl + ry * sd * sw, 0.06 * (braking ? 1.4 : 1), 1.3 * k * b, 0.06 * k * b, 0.03 * k * b);
        }
        const px = c.x + hx * (fl + 0.55);
        const pz = c.y + hy * (fl + 0.55);
        Lt.pool(px, groundAt(this.map, px, pz), pz, -c.yaw, 1.1, 0.55, 0.3 * k, 0.27 * k, 0.2 * k);
      } else if (braking && c.v < 0.05) {
        // stopped at a light / give-way line in daylight: brake lights on
        for (const sd of [-1, 1]) Lt.flare(c.x - hx * fl + rx * sd * sw, ly, c.y - hy * fl + ry * sd * sw, 0.055, 1.2, 0.05, 0.03);
      }
      if (c.v < -0.01) {
        // reversing (3-point turn): white reversing lights
        for (const sd of [-1, 1]) Lt.flare(c.x - hx * fl + rx * sd * sw * 0.6, ly, c.y - hy * fl + ry * sd * sw * 0.6, 0.06 + dk * 0.03, 1.4, 1.4, 1.3);
      }
    }
    for (const im of this.inst) im.commit();
    this.furniture.draw(f, time);
  }

  get count() {
    return this.cars.length;
  }

  /** Debug / screenshots: car positions and states. */
  debug() {
    return this.cars.map((c) => ({
      id: c.id,
      x: +c.x.toFixed(2),
      y: +c.y.toFixed(2),
      s: c.s,
      kind: c.kind,
      v: +c.v.toFixed(2),
      panic: +c.panic.toFixed(1),
      seen: c.seen,
      line: c.line,
      dir: c.dir,
      loop: c.loop,
      kt: c.kt,
      wait: c.waiting,
      ind: c.ind,
    }));
  }
}
