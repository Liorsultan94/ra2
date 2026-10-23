import { Tile, WATER_LEVEL } from '../../../sim/map';
import { hash2 } from '../../../sim/rng';
import { MAX_STREAKS, RIVER } from '../../water';
import type { AtmosHost, Atmosphere } from '../../atmos';
import { CITY_NIGHT } from '../../models/citybldgs';
import { CITY_LATE } from '../nightlife';
import { LighthouseBeams } from './beam';
import { DesertLights } from './lights';
import { emptyPlan, isDesertLayout, planTown, standY, type DesertPlan, type NightLamp } from './places';
import { planBoats, planHarbours, planOil, planResorts } from './sea';
import { SignBoards, planSigns } from './signs';

/*
 * The desert's living night (NT1, render only; sim/night.ts and the night-combat reveal rules are untouched).
 *
 *  - villages and towns: lit windows (about half the houses asleep, one window in ten a TV), porch lamps, street
 *    lamps along the roads, the mosque's lights, cooking fires in some yards (places.ts / lights.ts);
 *  - ... (more parts are added below as they land)
 *
 * Everything here is decoration: it is drawn as additive sprites and quads that nothing in the game reads, never
 * feeds the real point-light pool (so no unit is lit up by a lamp), and is hidden under the fog of war's shroud.
 * Maps without the desert layout build nothing.
 */

export class DesertNight {
  readonly plan: DesertPlan;
  private lights: DesertLights | null = null;
  private signs: SignBoards | null = null;
  private beams: LighthouseBeams | null = null;
  private damageT = 0;
  private dead = new Set<number>();
  readonly active: boolean;
  /** Warm lights near the water that the sea reflects as streaks (water.ts NIGHT_STREAKS): x, y, z, strength, r, g, b. */
  private reflect: { x: number; y: number; z: number; i: number; r: number; g: number; b: number }[] = [];
  private streakT = 0;

  constructor(
    host: AtmosHost,
    q: 'low' | 'medium' | 'high',
    enabled: boolean,
  ) {
    const map = host.world.map;
    this.active = enabled && isDesertLayout(map);
    const seed = host.world.seed;
    this.plan = this.active ? planTown(map, seed) : emptyPlan();
    if (!this.active) return;
    void q;
    // the resorts' and the boats' lights come from the spots the seaside recorded while it was built
    const sea = host.terrain.seaside;
    if (sea) {
      this.plan.lamps.push(...planResorts(sea.nightSpots), ...planBoats(sea.boatSpots()));
    }
    // the lighthouses' lamps: a small bright point (the beam is beam.ts)
    for (const L of sea?.lanternSpots() ?? []) this.plan.lamps.push({ x: L.x, y: L.y, z: L.z, size: 0.13, r: 1.0, g: 0.9, b: 0.66, mode: 0, phase: 0, pool: 0, kind: 'lighthouse', house: -1 });
    // harbour lights at the heads of the gulfs
    const harbour = planHarbours(map, (x, z) => standY(map, x, z));
    this.plan.lamps.push(...harbour.lamps);
    this.plan.posts.push(...harbour.posts);
    const oil = planOil(map.oils, (x, z) => standY(map, x, z), (x, z) => standY(map, x, z) > WATER_LEVEL + 0.06 && map.tiles[Math.floor(z) * map.w + Math.floor(x)] !== Tile.Water);
    this.plan.lamps.push(...oil.lamps);
    this.plan.stacks.push(...oil.stacks);
    this.reflect = reflectables(this.plan.lamps, sea?.lampSpots() ?? [], sea?.lanternSpots() ?? []);
    this.lights = new DesertLights(host.fog, this.plan, (a) => hash2(a, 5, 9100 + (seed | 0)));
    host.scene.add(this.lights.group);
    if (sea) {
      this.signs = new SignBoards(host.fog, planSigns(sea.nightSpots), this.lights.uniforms);
      host.scene.add(this.signs.group);
      this.beams = new LighthouseBeams(host.fog, sea.lanternSpots(), this.lights.uniforms);
      host.scene.add(this.beams.group);
    }
  }

  update(dt: number, time: number, atmos: Atmosphere, target?: { x: number; z: number }) {
    if (!this.lights) return;
    const night = CITY_NIGHT.value;
    this.lights.update(night, time, CITY_LATE.value);
    this.signs?.update(night);
    this.beams?.update(night, time);
    this.streakT -= dt;
    if (this.streakT <= 0) {
      this.streakT = 0.2;
      this.pickStreaks(night, target);
    }
    this.damageT -= dt;
    if (this.damageT <= 0) {
      this.damageT = 2;
      this.houseDamage(atmos);
    }
  }

  /** The lights the sea reflects this moment: the strongest few near the view (water.ts reads RIVER.wStreakP / wStreakC). */
  private pickStreaks(night: number, target?: { x: number; z: number }) {
    const P = RIVER.wStreakP.value;
    const C = RIVER.wStreakC.value;
    const list = this.reflect;
    const tx = target?.x ?? 0;
    const tz = target?.z ?? 0;
    const used: number[] = [];
    if (night > 0.02 && list.length) {
      const score = new Float32Array(list.length);
      for (let i = 0; i < list.length; i++) {
        const l = list[i];
        const d2 = (l.x - tx) * (l.x - tx) + (l.z - tz) * (l.z - tz);
        score[i] = d2 > 900 ? 0 : l.i / (1 + d2 / 120);
      }
      for (let k = 0; k < MAX_STREAKS; k++) {
        let bi = -1;
        let bs = 0.002;
        for (let i = 0; i < list.length; i++) if (score[i] > bs) (bs = score[i]), (bi = i);
        if (bi < 0) break;
        score[bi] = 0;
        used.push(bi);
      }
    }
    for (let k = 0; k < MAX_STREAKS; k++) {
      if (k < used.length) {
        const l = list[used[k]];
        P[k].set(l.x, l.y, l.z, l.i * night);
        C[k].set(l.r, l.g, l.b);
      } else P[k].w = 0;
    }
    RIVER.wStreakN.value = used.length;
  }

  /** A house whose roof is damaged loses its lights (envdamage.ts house stages, read-only). */
  private houseDamage(atmos: Atmosphere) {
    const houses = (atmos.env as unknown as { houses?: { h: { st: unknown }; stage: number }[] }).houses;
    if (!houses || !this.lights) return;
    for (const H of houses) {
      if (H.stage < 1) continue;
      const i = this.plan.houses.findIndex((p) => p.st === H.h.st);
      if (i < 0 || this.dead.has(i)) continue;
      this.dead.add(i);
      this.lights.setHouseAlive(i, false);
    }
  }

  /** The lit places the horizon glows over (a mosque marks each village / town; the resorts): tile coordinates. */
  glowPlaces(): { x: number; y: number }[] {
    if (!this.active) return [];
    const out: { x: number; y: number }[] = this.plan.houses.filter((h) => h.st.look === 'mosque' && h.awake).map((h) => ({ x: h.cx, y: h.cz }));
    for (const l of this.plan.lamps) if (l.kind === 'bar' || l.kind === 'restaurant') out.push({ x: l.x, y: l.z });
    return out;
  }

  stats() {
    return { active: this.active, ...(this.lights?.stats() ?? { windows: 0, lamps: 0, pools: 0, posts: 0, stacks: 0, markers: 0, draws: 0 }), ...(this.signs?.stats() ?? { signs: 0 }), asleep: this.plan.houses.filter((h) => !h.awake).length, houses: this.plan.houses.length };
  }

  dispose() {
    for (const p of RIVER.wStreakP.value) p.w = 0;
    RIVER.wStreakN.value = 0;
    this.lights?.dispose();
    this.lights = null;
    this.signs?.dispose();
    this.signs = null;
    this.beams?.dispose();
    this.beams = null;
  }
}


/** Lights close to the sea that it reflects: boats, buoys, jetty and pontoon lamps, the bar, the promenade's lamps, the lantern. */
export function reflectables(lamps: readonly NightLamp[], promenade: readonly { x: number; y: number; z: number }[], lanterns: readonly { x: number; y: number; z: number }[]) {
  const out: { x: number; y: number; z: number; i: number; r: number; g: number; b: number }[] = [];
  const KIND: Record<string, number> = { harbour: 0.5, boat: 0.7, buoy: 0.5, jetty: 0.5, pontoon: 0.7, bar: 0.9, restaurant: 0.7, string: 0.35, palm: 0 };
  for (const l of lamps) {
    const k = KIND[l.kind];
    if (!k) continue;
    out.push({ x: l.x, y: l.y, z: l.z, i: k, r: l.r * 0.55, g: l.g * 0.55, b: l.b * 0.55 });
  }
  for (const p of promenade) out.push({ x: p.x, y: p.y, z: p.z, i: 0.8, r: 0.55, g: 0.38, b: 0.18 });
  for (const p of lanterns) out.push({ x: p.x, y: p.y, z: p.z, i: 1.2, r: 0.6, g: 0.52, b: 0.36 });
  return out;
}
