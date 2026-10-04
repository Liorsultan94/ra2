// Battlefield conditions: the time of day and the weather as simulation state.
//
// The live day (1 real minute = 1 game hour at 1x, from 05:30) and the dynamic
// weather timeline used to be render-only (render/atmos.ts, render/weathercycle.ts).
// Here they are a pure function of (configuration, map, seed, tick), evaluated
// once per game second, so every client in a lockstep match agrees on them, and
// they feed the rules:
//
//   night   sight shrinks with the darkness (up to -35% at full dark, ramping in at
//           dusk and out at dawn); night-vision units (drones and aircraft, UGVs,
//           drone teams, EW troopers, thermal-sight tanks, the thermal sentry) are
//           not affected. Firing reveals the shooter for 2 s, burning things and lit
//           buildings light up a small area for everybody.
//   fog     ground fog (dawn mist, the misty morning, mist after rain) and dust
//           storms cut sight for everyone (up to -30%); heavy rain / snowfall a bit (-10%).
//   mud     wet ground slows wheeled and tracked vehicles off-road (up to -20%,
//           ramping in and out with the ground wetness); roads and bridges are not affected.
//   snow    snow cover slows vehicles (-10%) and infantry (-5%) off-road.
//   cover   infantry in craters / ruins or next to rubble take 30% less damage.
//
// The weather timeline is the renderer's own (render/weathercycle.ts: a pure,
// dependency-free module) with the same seed, so the sky the player sees and the
// rules the sim applies are the same function (tests/conditions.test.ts checks it).
// The clock helpers below mirror render/atmos.ts (hourToU, clockHours) and are
// tested against it. Never uses Math.random or the wall clock.

import { WeatherCycle, type WxClimate, type WxState } from '../render/weathercycle';
import { DEFS } from './defs';
import { Tile, distToSegment } from './map';
import { TPS, type BuildingDef, type Def, type Entity, type UnitDef } from './types';
import type { World } from './world';

// ------------------------------------------------------------------ rules (numbers)

/** Sight lost at full dark (night-vision units ignore it). */
export const NIGHT_SIGHT = 0.35;
/** Sight lost in thick fog / a dust storm (everybody). */
export const FOG_SIGHT = 0.3;
/** Sight lost in heavy rain / snowfall (everybody). */
export const PRECIP_SIGHT = 0.1;
/** Sight never drops below this fraction (and 2 tiles). */
export const SIGHT_FLOOR = 0.45;
/** Off-road speed lost by vehicles on fully soaked ground. */
export const MUD_SLOW = 0.2;
/** Off-road speed lost on snow cover: vehicles, infantry. */
export const SNOW_SLOW_VEH = 0.1;
export const SNOW_SLOW_INF = 0.05;
/** Damage taken by infantry in cover (craters, ruins, next to rubble). */
export const COVER_MUL = 0.7;
/** A shot reveals the shooter (radius 1.5) for this long while sight is reduced. */
export const MUZZLE_REVEAL_TICKS = TPS * 2;
/** Lit buildings (night) and burning things (< 30% hp) light up this far around them. */
export const LIGHT_RADIUS = 2;
/** Big explosions leave a crater: splash radius / damage thresholds. */
export const CRATER_SPLASH = 1.2;
export const CRATER_DAMAGE = 80;

// ------------------------------------------------------------------ clock (mirrors render/atmos.ts)

export type CondTod = 'day' | 'dusk' | 'night' | 'cycle' | 'mist';
export type CondWeather = 'clear' | 'rain' | 'snow' | 'sandstorm' | 'dynamic';

export const GAME_HOUR_TICKS = TPS * 60;
export const START_HOUR = 5.5;
/** Clock hour of the fixed times of day (render/atmos.ts FIXED_HOUR). */
export const FIXED_HOUR: Record<Exclude<CondTod, 'cycle'>, number> = { day: 15, dusk: 19.25, night: 23, mist: 7.25 };

const HOUR_U: readonly (readonly [number, number])[] = [
  [12, 0],
  [15, 0.2],
  [17.5, 0.31],
  [18.5, 0.375],
  [19.25, 0.425],
  [19.75, 0.46],
  [21, 0.51],
  [28.5, 0.72],
  [29.25, 0.77],
  [30, 0.81],
  [32, 0.88],
  [36, 1],
];

/** Darkness of the lighting stops (render/atmos.ts presets' `dark`) at their clock hours (12 .. 36). */
const HOUR_DARK: readonly (readonly [number, number])[] = [
  [12, 0],
  [15, 0],
  [17.5, 0.1],
  [18.5, 0.38],
  [19.25, 0.55],
  [19.75, 0.88],
  [21, 1],
  [28.5, 1],
  [29.25, 0.88],
  [30, 0.42],
  [32, 0.04],
  [36, 0],
];

function piecewise(tab: readonly (readonly [number, number])[], hours: number): number {
  let x = ((hours % 24) + 24) % 24;
  if (x < 12) x += 24;
  let i = 1;
  while (i < tab.length - 1 && x > tab[i][0]) i++;
  const [h0, v0] = tab[i - 1];
  const [h1, v1] = tab[i];
  return v0 + ((v1 - v0) * (x - h0)) / (h1 - h0);
}

/** Cycle phase u (0 = midday) of a clock hour (same as render/atmos.ts hourToU). */
export function hourToU(hours: number): number {
  return piecewise(HOUR_U, hours);
}

/** Hours since midnight of day 1 at a sim tick (same as render/atmos.ts clockHours). */
export function clockHours(tick: number, start = START_HOUR): number {
  return start + tick / GAME_HOUR_TICKS;
}

/** Darkness 0 (day) .. 1 (night) at a clock hour: dusk 17:30 .. 21:00, dawn 04:30 .. 08:00. */
export function darkAt(hours: number): number {
  return piecewise(HOUR_DARK, hours);
}

const sstep = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Ground fog over the cycle phase (render/atmos.ts dawnMist). */
export function dawnMist(u: number) {
  return Math.min(1, 0.22 * sstep(0.55, 0.7, u) * (1 - sstep(0.8, 0.84, u)) + sstep(0.72, 0.8, u) * (1 - sstep(0.85, 0.93, u)));
}

/** 'Misty morning' fixed time of day (render/atmos.ts morningMist), t in game seconds. */
export function morningMist(t: number) {
  return 0.9 - 0.5 * sstep(200, 620, t);
}

// ------------------------------------------------------------------ night vision

/**
 * Night vision / thermal sights: every aircraft and drone (FLIR), unmanned ground vehicles, drone teams and
 * EW troopers (sensor kit), the thermal-sight tanks (Abrams, Merkava, Leopard 2A8, K2) and the thermal-tracking
 * sentry gun. (The roster has no snipers or special forces; they would go here.)
 */
const NV_KEYS = new Set(['robot', 'ugv', 'fpvteam', 'ewinf', 'swarm']);
const NV_IDS = new Set(['usa_mbt', 'israel_mbt', 'germany_mbt', 'korea_mbt', 'korea_def_gun']);

const nvCache = new Map<string, boolean>();
export function hasNightVision(defId: string): boolean {
  let v = nvCache.get(defId);
  if (v !== undefined) return v;
  const d = DEFS[defId] as Def | undefined;
  const key = defId.slice(defId.indexOf('_') + 1);
  v = !!d && (NV_IDS.has(defId) || (d.kind === 'unit' && (!!(d as UnitDef).air || NV_KEYS.has(key))));
  nvCache.set(defId, v);
  return v;
}

// ------------------------------------------------------------------ state

export interface CondConfig {
  tod: CondTod;
  weather: CondWeather;
  /** Clock hour at tick 0 (the live day). */
  startHour?: number;
  /** Weather timeline seed (default: derived from the world seed and the map, see Conditions.seedFor). */
  seed?: number;
}

/** What the battle conditions are this game second. */
export interface CondState {
  /** Clock hour (0..24). */
  hour: number;
  /** Darkness 0..1. */
  dark: number;
  /** Fog / dust density for sight 0..1. */
  fog: number;
  /** Falling rain / snow 0..1 (sight) and the dust storm 0..1. */
  precip: number;
  dust: number;
  /** Ground wetness 0..1 and the mud factor 0..1 derived from it. */
  wet: number;
  mud: number;
  /** Snow cover 0..1. */
  snow: number;
  /** Sight multipliers: everybody / night-vision units. */
  sight: number;
  sightNV: number;
  /** Off-road speed multipliers: vehicles / infantry. */
  vehOff: number;
  infOff: number;
  /** The raw weather state (dynamic weather), null otherwise. */
  wx: WxState | null;
}

export function neutralState(): CondState {
  return { hour: 15, dark: 0, fog: 0, precip: 0, dust: 0, wet: 0, mud: 0, snow: 0, sight: 1, sightNV: 1, vehOff: 1, infOff: 1, wx: null };
}

/** The rules from the raw conditions (pure; exported for the tests and the HUD). */
export function deriveRules(s: CondState): CondState {
  const common = (1 - FOG_SIGHT * s.fog) * (1 - PRECIP_SIGHT * s.precip);
  s.sight = Math.max(SIGHT_FLOOR, (1 - NIGHT_SIGHT * s.dark) * common);
  s.sightNV = Math.max(SIGHT_FLOOR, common);
  s.vehOff = (1 - MUD_SLOW * s.mud) * (1 - SNOW_SLOW_VEH * s.snow);
  s.infOff = 1 - SNOW_SLOW_INF * s.snow;
  return s;
}

/** Ground wetness -> mud: firm until ~15% wet, full mud from ~75%. */
export function mudOf(wet: number) {
  return sstep(0.15, 0.75, wet);
}

export class Conditions {
  /** Off until the match configures it (tests and old replays keep the plain day). */
  enabled = false;
  cfg: CondConfig = { tod: 'day', weather: 'clear' };
  startHour = START_HOUR;
  /** Weather timeline seed (dynamic weather). */
  wxSeed = 0;
  cycle: WeatherCycle | null = null;
  state: CondState = neutralState();
  /** 1 on roads, bridges and paved squares (mud / snow do not slow there). */
  road: Uint8Array;
  /** Cover for infantry: 1 crater, 2 ruins / rubble. */
  cover: Uint8Array;
  /** Path cost per tile for ground vehicles while off-road is slow (null = uniform). */
  cost: Float32Array | null = null;
  private costK = 1;
  private biome: string;
  /** Lit / burning spots revealed to everyone this visibility pass (debug / HUD). */
  lights: { x: number; y: number; r: number }[] = [];

  constructor(private w: World) {
    const m = w.map;
    this.biome = m.biome;
    this.road = roadMask(w);
    this.cover = new Uint8Array(m.w * m.h);
    // rubble lots of the hand-designed maps are cover from the start
    for (const l of m.deco?.lots ?? []) {
      for (let y = Math.max(0, Math.floor(l.y0)); y < Math.min(m.h, Math.ceil(l.y1)); y++) for (let x = Math.max(0, Math.floor(l.x0)); x < Math.min(m.w, Math.ceil(l.x1)); x++) this.cover[y * m.w + x] = 2;
    }
  }

  /** The weather seed of a match: the world's PRNG state at the start and the map name (as render/atmos.ts derives it). */
  static seedFor(w: World): number {
    const rs = (w as unknown as { rng?: { s?: number } }).rng?.s ?? 0;
    let seed = (rs ^ 0x9e3779b9) >>> 0;
    for (const ch of w.map.name) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) >>> 0;
    return seed;
  }

  /** Switch the conditions on (the match setup: menu settings / URL; the same on every client). */
  configure(cfg: CondConfig) {
    this.enabled = true;
    this.cfg = { ...cfg };
    this.startHour = cfg.startHour ?? START_HOUR;
    this.wxSeed = cfg.seed ?? Conditions.seedFor(this.w);
    this.cycle = cfg.weather === 'dynamic' ? new WeatherCycle(this.wxSeed, { climate: this.biome as WxClimate, cold: cfg.tod === 'night' || this.biome === 'winter' }) : null;
    this.evaluate(this.w.tick);
    // what holds at the start is in the briefing: only changes are announced
    this.shown = new Set(this.summary().map((l) => l.kind));
  }

  /** Condition kinds in force (for the change announcements) and when each last flipped. */
  private shown = new Set<CondLine['kind']>();
  private flipped = new Map<CondLine['kind'], number>();

  /** Once per game second (and at configure time). Announces changes as 'conditions' sim events. */
  update(tick: number) {
    if (!this.enabled || tick % TPS !== 0) return;
    this.evaluate(tick);
    const now = new Set(this.summary().map((l) => l.kind));
    for (const k of new Set([...now, ...this.shown])) {
      const on = now.has(k);
      if (on === this.shown.has(k)) continue;
      // no flapping: a condition stays announced for at least 30 s
      if (tick - (this.flipped.get(k) ?? -1e9) < TPS * 30) continue;
      this.flipped.set(k, tick);
      if (on) this.shown.add(k);
      else this.shown.delete(k);
      if (tick > 0) this.w.events.push({ t: 'conditions', kind: k, on });
    }
  }

  /** Conditions announced as in force (with the 30 s hold). */
  get inForce(): ReadonlySet<CondLine['kind']> {
    return this.shown;
  }

  /** The conditions at a tick (pure in (cfg, seed, map, tick); the cycle caches its integration). */
  evaluate(tick: number): CondState {
    const s = this.state;
    const cfg = this.cfg;
    const t = tick / TPS;
    const live = cfg.tod === 'cycle';
    s.hour = live ? (((clockHours(tick, this.startHour) % 24) + 24) % 24) : FIXED_HOUR[cfg.tod as Exclude<CondTod, 'cycle'>];
    s.dark = darkAt(s.hour);
    const st = this.cycle ? this.cycle.at(Math.floor(t)) : null;
    s.wx = st;
    // ground fog exactly as the renderer shows it (render/atmos.ts update(), without the camera-zoom thinning)
    let mist = 0;
    if (cfg.tod === 'mist') mist = morningMist(t);
    if (live) mist = Math.max(mist, dawnMist(hourToU(s.hour)) * (st ? 0.55 + 0.45 * sstep(0.08, 0.45, st.wet) : 1));
    if (st) mist = Math.max(mist, st.mist) * (1 - 0.65 * sstep(0.35, 0.9, st.wind));
    let precip = 0;
    let dust = 0;
    let wet = 0;
    let snow = this.biome === 'winter' ? 1 : 0;
    if (st) {
      if (st.fall === 'sandstorm') dust = st.precip;
      else precip = st.precip;
      wet = st.wet;
      snow = Math.max(snow, Math.min(1, st.snow / 0.28));
      s.dark = Math.min(1, s.dark + 0.15 * st.storm);
    } else if (cfg.weather === 'rain') {
      precip = 0.8;
      wet = 1;
    } else if (cfg.weather === 'snow') {
      precip = 0.6;
      snow = 1;
    } else if (cfg.weather === 'sandstorm') dust = 1;
    s.precip = precip;
    s.dust = dust;
    s.wet = wet;
    s.mud = mudOf(wet);
    s.snow = snow;
    s.fog = Math.min(1, Math.max(mist, 0.9 * dust));
    deriveRules(s);
    this.updateCost();
    return s;
  }

  /** Vehicle path costs: off-road tiles cost 1 / speed there (re-built when the factor moves by 5%). */
  private updateCost() {
    const k = this.state.vehOff;
    if (k > 0.97) {
      this.cost = null;
      this.costK = 1;
      return;
    }
    if (this.cost && Math.abs(k - this.costK) < 0.05) return;
    this.costK = k;
    const n = this.road.length;
    const c = (this.cost ??= new Float32Array(n));
    const off = 1 / k;
    for (let i = 0; i < n; i++) c[i] = this.road[i] ? 1 : off;
  }

  // ------------------------------------------------------------ rules

  /** Sight radius of an entity right now (tiles). */
  sightOf(e: Entity, base: number): number {
    if (!this.enabled || base <= 0) return base;
    const k = hasNightVision(e.def) ? this.state.sightNV : this.state.sight;
    if (k >= 0.999) return base;
    return Math.max(Math.min(base, 2), base * k);
  }

  /** Speed multiplier of a ground unit on a tile. */
  moveMul(d: UnitDef, tile: number): number {
    if (!this.enabled || d.air || this.road[tile]) return 1;
    return d.category === 'vehicle' ? this.state.vehOff : d.category === 'infantry' ? this.state.infOff : 1;
  }

  /** Is sight reduced (night, fog, rain)? Muzzle flashes and lights only matter then. */
  get dim(): boolean {
    return this.enabled && this.state.sight < 0.95;
  }

  /** Damage multiplier for a target (infantry in cover). */
  coverMul(t: Entity): number {
    if (t.kind !== 'unit' || t.inside >= 0 || t.z > 0.3) return 1;
    const d = DEFS[t.def] as UnitDef;
    if (d.category !== 'infantry') return 1;
    return this.inCover(t.x, t.y) ? COVER_MUL : 1;
  }

  /** Crater / ruin on the tile, or rubble right next to it. */
  inCover(x: number, y: number): boolean {
    const m = this.w.map;
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return false;
    const i = ty * m.w + tx;
    if (this.cover[i]) return true;
    // next to rubble (ruins only: a crater only shelters whoever is in it)
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++) {
        const nx = tx + ox;
        const ny = ty + oy;
        if (nx >= 0 && ny >= 0 && nx < m.w && ny < m.h && this.cover[ny * m.w + nx] === 2) return true;
      }
    return false;
  }

  /** A big explosion leaves a crater (always tracked: cheap, and the scars outlive the conditions). */
  crater(x: number, y: number, r: number, dmg: number) {
    if (r < CRATER_SPLASH || dmg < CRATER_DAMAGE) return;
    const m = this.w.map;
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return;
    const i = ty * m.w + tx;
    const t = m.tiles[i];
    if (t === Tile.Water || t === Tile.Bridge || this.road[i]) return; // (paved roads and bridges don't crater)
    if (!this.cover[i]) this.cover[i] = 1;
  }

  /** A destroyed building leaves ruins on its footprint. */
  ruin(b: Entity) {
    const d = DEFS[b.def] as BuildingDef;
    if (d.kind !== 'building' || d.role === 'bridge' || d.role === 'bridgehut') return;
    const m = this.w.map;
    for (let y = b.ty; y < b.ty + d.h; y++) for (let x = b.tx; x < b.tx + d.w; x++) if (x >= 0 && y >= 0 && x < m.w && y < m.h) this.cover[y * m.w + x] = 2;
  }

  /** HUD lines: the conditions that change the battle right now (most important first). */
  summary(): CondLine[] {
    return conditionLines(this.enabled ? this.state : null);
  }
}

export interface CondLine {
  kind: 'night' | 'fog' | 'dust' | 'mud' | 'rain' | 'snow';
  /** Short label for the HUD chip ("-35%") and the full line. */
  short: string;
  text: string;
}

const pct = (k: number) => `−${Math.round(k * 100)}%`;

/** What the battle conditions mean for the player (HUD indicator / tests). */
export function conditionLines(s: CondState | null): CondLine[] {
  if (!s) return [];
  const out: CondLine[] = [];
  const nightLoss = NIGHT_SIGHT * s.dark;
  if (s.dark > 0.3) out.push({ kind: 'night', short: pct(nightLoss), text: `Night: sight ${pct(nightLoss)} (night vision unaffected)` });
  if (s.dust > 0.3) out.push({ kind: 'dust', short: pct(FOG_SIGHT * s.fog), text: `Dust storm: sight ${pct(FOG_SIGHT * s.fog)}` });
  else if (s.fog > 0.25) out.push({ kind: 'fog', short: pct(FOG_SIGHT * s.fog), text: `Fog: sight ${pct(FOG_SIGHT * s.fog)} for everyone` });
  if (s.mud > 0.2) out.push({ kind: 'mud', short: pct(1 - s.vehOff), text: `Mud: vehicles ${pct(1 - s.vehOff)} off-road, roads clear` });
  else if (s.snow > 0.3) out.push({ kind: 'snow', short: pct(1 - s.vehOff), text: `Snow: off-road vehicles ${pct(1 - s.vehOff)}, infantry ${pct(1 - s.infOff)}` });
  if (s.precip > 0.35 && s.snow < 0.3 && s.mud <= 0.2) out.push({ kind: 'rain', short: pct(PRECIP_SIGHT * s.precip), text: `Heavy rain: sight ${pct(PRECIP_SIGHT * s.precip)}` });
  return out;
}

/** Roads (the map's road centrelines at their paved width), bridges and paved squares. */
function roadMask(w: World): Uint8Array {
  const m = w.map;
  const out = new Uint8Array(m.w * m.h);
  const styles = m.deco?.roadStyles;
  m.roads.forEach((road, ri) => {
    const half = Math.max(0.9, (styles?.[ri]?.width ?? 0) * 0.5 + 0.45);
    for (let k = 0; k < road.length - 1; k++) {
      const a = road[k];
      const b = road[k + 1];
      const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - half - 1));
      const x1 = Math.min(m.w - 1, Math.ceil(Math.max(a.x, b.x) + half + 1));
      const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - half - 1));
      const y1 = Math.min(m.h - 1, Math.ceil(Math.max(a.y, b.y) + half + 1));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const t = m.tiles[y * m.w + x];
          if (t === Tile.Water || t === Tile.Rock) continue;
          if (distToSegment(x + 0.5, y + 0.5, a.x + 0.5, a.y + 0.5, b.x + 0.5, b.y + 0.5) < half) out[y * m.w + x] = 1;
        }
    }
  });
  for (const p of m.deco?.plazas ?? []) {
    for (let y = Math.max(0, Math.floor(p.y0)); y < Math.min(m.h, Math.ceil(p.y1)); y++) for (let x = Math.max(0, Math.floor(p.x0)); x < Math.min(m.w, Math.ceil(p.x1)); x++) out[y * m.w + x] = 1;
  }
  for (let i = 0; i < out.length; i++) if (m.tiles[i] === Tile.Bridge) out[i] = 1;
  return out;
}
