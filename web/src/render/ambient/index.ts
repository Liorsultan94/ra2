import * as THREE from 'three';
import { WEAPONS, buildingDef, unitDef } from '../../sim/defs';
import type { SimEvent } from '../../sim/types';
import type { World } from '../../sim/world';
import type { Atmosphere } from '../atmos';
import type { Effects } from '../effects';
import type { FogOfWar } from '../fog';
import type { Terrain } from '../terrain';
import { Animals } from './animals';
import { Birds } from './birds';
import { RiverLife } from './river';
import { WX } from '../wxuniforms';
import { FogProbe, LightSprites, setBusy, type AmbientFrame, type Danger, type Quality } from './shared';
import { Traffic } from './traffic';

/*
 * "Life on the map": civilian traffic, grazing livestock and bird flocks.
 * Purely visual (never touches the simulation, free to use Math.random).
 *
 * The renderer owns one AmbientLife: it forwards sim events (onEvent) and
 * calls update() once per frame. Things are hidden wherever the viewer
 * doesn't currently see (fog of war), react to blasts / gunfire / units, and
 * read the time of day and weather from the atmosphere. Thermal view sees
 * cars and animals warm (HEAT_LAYER). Draw calls: 4 vehicle types, 2 animal
 * species, 1 for all birds, plus 2 light-sprite calls only while lit
 * (night / hazard blinkers). Types with nothing visible are skipped.
 *
 * ?ambient=0 switches it off (A/B perf checks).
 */

export interface AmbientHost {
  world: World;
  fog: FogOfWar;
  terrain: Terrain;
  effects: Effects;
  atmos: Atmosphere;
  quality: Quality;
  viewCorners(): { x: number; y: number }[];
}

export function ambientEnabled(): boolean {
  try {
    return new URLSearchParams(location.search).get('ambient') !== '0';
  } catch {
    return true;
  }
}

export class AmbientLife {
  readonly group = new THREE.Group();
  readonly traffic: Traffic;
  readonly animals: Animals;
  readonly birds: Birds;
  /** Ducks, jumping fish, dragonflies and fishing boats (river.ts). */
  readonly river: RiverLife;
  private lights = new LightSprites();
  private dangers: Danger[] = [];
  private units = new Float32Array(512);
  private air = new Float32Array(128);
  private nUnits = 0;
  private nAir = 0;
  private scanT = 0;
  private time = 0;
  private frame: AmbientFrame;
  private busy: Uint8Array;
  private busyT = 0;

  private readonly dynamicWx: boolean;
  constructor(private host: AmbientHost) {
    const { world, fog, terrain, effects, quality } = host;
    const map = world.map;
    this.busy = new Uint8Array(map.w * map.h);
    this.scanBuildings();
    setBusy(this.busy);
    const phone = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
    const probe = new FogProbe(fog, map.w, map.h);
    // dynamic weather starts clear; foulness is then followed per frame from the live rain/dust level
    this.dynamicWx = host.atmos.cfg.weather === 'dynamic';
    const foul = !this.dynamicWx && host.atmos.cfg.weather !== 'clear';
    this.traffic = new Traffic(map, terrain.layout, world.bridges, fog, effects, probe, this.lights, quality, phone);
    this.animals = new Animals(map, terrain.layout, fog, probe, quality, phone);
    this.birds = new Birds(map, terrain.layout, fog, probe, quality, phone, foul);
    this.group.name = 'ambient-life';
    this.river = new RiverLife(map, terrain.river, fog, probe, this.lights, quality, phone);
    this.group.add(this.traffic.group, this.animals.group, this.birds.group, this.river.group, this.lights.group);
    this.frame = { dt: 0, time: 0, dangers: this.dangers, units: this.units, nUnits: 0, air: this.air, nAir: 0, dark: 0, foul, vx0: 0, vy0: 0, vx1: map.w, vy1: map.h };
  }

  private danger(x: number, y: number, r: number, kill: number, power: number) {
    if (this.dangers.length < 64) this.dangers.push({ x, y, r, kill, power });
  }

  /** Sim events: blasts, gunfire and deaths frighten (and sometimes kill) the locals. */
  onEvent(ev: SimEvent) {
    switch (ev.t) {
      case 'fire': {
        const w = WEAPONS[ev.weapon];
        if (!w) break;
        const loud = w.projectile === 'shell' || w.projectile === 'artillery';
        this.danger(ev.x, ev.y, loud ? 6 : 4, 0, loud ? 0.6 : 0.3);
        break;
      }
      case 'impact': {
        if (ev.air) {
          this.danger(ev.x, ev.y, 5, 0, 0.5);
          break;
        }
        const w = WEAPONS[ev.weapon];
        const small = !w || w.projectile === 'instant' || w.projectile === 'beam';
        if (small) {
          this.danger(ev.x, ev.y, 4, w && w.warhead === 'flak' ? 0.35 : 0, 0.3);
          break;
        }
        const kill = Math.max(0.45, Math.min(3, (w.splash ?? 0.4) * 0.9 + 0.3 + (w.damage >= 300 ? 0.8 : 0)));
        this.danger(ev.x, ev.y, 6 + kill * 2.5, kill, Math.min(1, 0.5 + kill * 0.25));
        break;
      }
      case 'airburst':
        this.danger(ev.x, ev.y, 6, 0, 0.6);
        break;
      case 'death': {
        if (ev.kind === 'building') this.danger(ev.x, ev.y, 10, 1.6, 1);
        else {
          const u = unitDef(ev.def);
          if (u.category === 'vehicle' || u.air) this.danger(ev.x, ev.y, 8, 0.9, 0.9);
          else this.danger(ev.x, ev.y, 3, 0, 0.3);
        }
        break;
      }
    }
  }

  /** Building footprints (+1 tile apron): livestock, birds and swerving cars keep off them. */
  private scanBuildings() {
    const m = this.host.world.map;
    const b = this.busy;
    b.fill(0);
    for (const e of this.host.world.entities.values()) {
      if (e.kind !== 'building' || e.dead) continue;
      const d = buildingDef(e.def);
      if (!d) continue;
      for (let y = Math.max(0, e.ty - 1); y < Math.min(m.h, e.ty + d.h + 1); y++) for (let x = Math.max(0, e.tx - 1); x < Math.min(m.w, e.tx + d.w + 1); x++) b[y * m.w + x] = 1;
    }
  }

  private scanUnits() {
    let n = 0;
    let na = 0;
    for (const e of this.host.world.entities.values()) {
      if (e.kind !== 'unit' || e.dead || e.owner < 0 || e.inside >= 0) continue;
      const u = unitDef(e.def);
      if (u.air) {
        if (na < this.air.length / 2) {
          this.air[na * 2] = e.x;
          this.air[na * 2 + 1] = e.y;
          na++;
        }
      } else if (n < this.units.length / 2) {
        this.units[n * 2] = e.x;
        this.units[n * 2 + 1] = e.y;
        n++;
      }
    }
    this.nUnits = n;
    this.nAir = na;
  }

  update(dt: number) {
    this.time += dt;
    const f = this.frame;
    if (this.dynamicWx) f.foul = WX.wxRain.value > 0.3 || WX.wxDust.value > 0.3;
    this.scanT -= dt;
    if (this.scanT <= 0) {
      this.scanT = 0.25;
      this.scanUnits();
    }
    this.busyT -= dt;
    if (this.busyT <= 0) {
      this.busyT = 2;
      this.scanBuildings();
      setBusy(this.busy);
    }
    f.dt = dt;
    f.time = this.time;
    f.nUnits = this.nUnits;
    f.nAir = this.nAir;
    const night = this.host.atmos.night as unknown as { dark?: number } | null;
    f.dark = night && typeof night.dark === 'number' ? night.dark : 0;
    // view rectangle (tile space), generous margin
    let x0 = 1e9;
    let y0 = 1e9;
    let x1 = -1e9;
    let y1 = -1e9;
    for (const c of this.host.viewCorners()) {
      if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
      x0 = Math.min(x0, c.x);
      y0 = Math.min(y0, c.y);
      x1 = Math.max(x1, c.x);
      y1 = Math.max(y1, c.y);
    }
    if (x0 > x1) {
      x0 = y0 = -1e9;
      x1 = y1 = 1e9;
    }
    f.vx0 = x0 - 3;
    f.vy0 = y0 - 3;
    f.vx1 = x1 + 3;
    f.vy1 = y1 + 3;
    this.traffic.update(f);
    this.animals.update(f);
    this.birds.update(f);
    this.river.update(f);
    this.dangers.length = 0;
    this.lights.begin();
    this.traffic.draw(f, this.time);
    this.animals.draw();
    this.birds.draw();
    this.river.draw(f);
    this.lights.commit();
  }

  /** Debug / tests: counts and car states. */
  stats() {
    return { cars: this.traffic.count, animals: this.animals.count, birds: this.birds.count, river: this.river.count, traffic: this.traffic.debug() };
  }
}
