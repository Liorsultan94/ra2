/*
 * Dynamic weather timeline ('dynamic' weather setting, ?weather=dynamic).
 *
 * The whole match's weather is a pure function of (seed, game time): a seeded
 * PRNG lays out a sequence of weather events (a passing shower, a long rain, a
 * thunderstorm, a grey overcast spell, now and then a dust front or, on a cold
 * night, snow flurries) separated by clear spells, and `at(t)` evaluates the
 * smooth envelopes of the event that covers game time t. Ground wetness, dust
 * and snow dusting accumulate and dry / settle by integrating that function
 * in fixed one-second steps from the start of the match, so every client that
 * knows the seed and the sim tick sees exactly the same sky (multiplayer
 * safe, independent of the frame rate). Purely visual: nothing here touches
 * the simulation.
 *
 * Event shape (seconds of game time, local to the event):
 *   build   clouds gather, the wind picks up ahead of the front
 *   ramp    the rain (snow, dust) begins lightly and intensifies
 *   hold    peak (a storm event builds to lightning in here)
 *   ease    the rain eases and stops
 *   clear   the clouds break up and drift off; the ground dries afterwards
 */

export type WxKind = 'rain' | 'snow' | 'sandstorm';
export type WxEventKind = 'overcast' | 'showers' | 'rain' | 'storm' | 'dust' | 'flurries';

export interface WxEvent {
  kind: WxEventKind;
  /** Falling particle kind. */
  fall: WxKind;
  start: number;
  build: number;
  ramp: number;
  hold: number;
  ease: number;
  clear: number;
  /** Peak cloud cover / precipitation / thunderstorm / wind, 0..1. */
  cover: number;
  precip: number;
  storm: number;
  wind: number;
  /** Wind direction of the front (radians, world x / z). */
  dir: number;
}

export interface WxState {
  /** Overcast 0..1 (darker light, softer shadows). */
  cover: number;
  /** Intensity of the falling particles 0..1. */
  precip: number;
  /** Particle kind of the current (or last) event. */
  fall: WxKind;
  /** Thunderstorm 0..1 (lightning rate, extra darkness). */
  storm: number;
  /** Wind strength 0..1 and direction (radians, world x / z). */
  wind: number;
  windDir: number;
  /** Ground wetness 0..1 (accumulates in rain, dries afterwards). */
  wet: number;
  /** Dust settled on surfaces 0..1 and snow dusting 0..1. */
  dust: number;
  snow: number;
  /** Mist rising off wet ground after the rain, 0..1. */
  mist: number;
  /** Current event (null in a clear spell) and the local phase name. */
  event: WxEvent | null;
  stage: 'clear' | 'build' | 'ramp' | 'hold' | 'ease' | 'clearing';
}

export interface WxOptions {
  /** Allow (rare) dust fronts. */
  dust?: boolean;
  /** Cold conditions: some showers fall as snow flurries. */
  cold?: boolean;
}

/** mulberry32 */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    let t = (s = (s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash1(i: number, seed: number): number {
  let h = Math.imul(i | 0, 374761393) + Math.imul(seed | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const sstep = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export class WeatherCycle {
  readonly events: WxEvent[] = [];
  private rnd: () => number;
  private seed: number;
  /** Integration cache: state after `sec` whole seconds. */
  private sec = 0;
  private acc = { wet: 0, dust: 0, snow: 0 };
  private tmp: WxState = WeatherCycle.blank();

  constructor(
    seed: number,
    private opts: WxOptions = {},
  ) {
    this.seed = seed | 0;
    this.rnd = prng(seed ^ 0x5eed);
  }

  private static blank(): WxState {
    return { cover: 0, precip: 0, fall: 'rain', storm: 0, wind: 0, windDir: 0, wet: 0, dust: 0, snow: 0, mist: 0, event: null, stage: 'clear' };
  }

  /** Smooth 1D value noise in [0, 1] (period ~ 1 / freq seconds). */
  noise(t: number, ch: number): number {
    const i = Math.floor(t);
    const f = t - i;
    const s = f * f * (3 - 2 * f);
    const k = this.seed + ch * 7919;
    return hash1(i, k) + (hash1(i + 1, k) - hash1(i, k)) * s;
  }

  /** Lay out events until one covers time t. */
  private ensure(t: number) {
    const r = this.rnd;
    while (!this.events.length || this.end(this.events[this.events.length - 1]) < t + 1) {
      const last = this.events[this.events.length - 1];
      // the battle opens in clear weather; the first front shows up within a few minutes
      const start = last ? this.end(last) + 150 + r() * 270 : 70 + r() * 110;
      let pick = r();
      const dustW = this.opts.dust ? 0.08 : 0;
      let kind: WxEventKind;
      if ((pick -= 0.15) < 0) kind = 'overcast';
      else if ((pick -= 0.3) < 0) kind = 'showers';
      else if ((pick -= 0.25) < 0) kind = 'rain';
      else if ((pick -= dustW) < 0) kind = 'dust';
      else kind = 'storm';
      if (kind === 'showers' && this.opts.cold && r() < 0.5) kind = 'flurries';
      // never two dust fronts in a row, and the first front is always a wet one
      if (kind === 'dust' && (!last || last.kind === 'dust')) kind = 'rain';
      const e: WxEvent = {
        kind,
        fall: kind === 'dust' ? 'sandstorm' : kind === 'flurries' ? 'snow' : 'rain',
        start,
        build: 60 + r() * 50,
        ramp: 30 + r() * 60,
        hold: 0,
        ease: 30 + r() * 60,
        clear: 60 + r() * 60,
        cover: 0,
        precip: 0,
        storm: 0,
        wind: 0,
        dir: -0.55 + (r() - 0.5) * 1.6,
      };
      switch (kind) {
        case 'overcast':
          e.hold = 90 + r() * 120;
          e.cover = 0.55 + r() * 0.2;
          e.precip = 0;
          e.wind = 0.3 + r() * 0.15;
          break;
        case 'showers':
          e.hold = 60 + r() * 90;
          e.cover = 0.72 + r() * 0.15;
          e.precip = 0.35 + r() * 0.25;
          e.wind = 0.35 + r() * 0.2;
          break;
        case 'rain':
          e.hold = 150 + r() * 150;
          e.cover = 0.9 + r() * 0.1;
          e.precip = 0.65 + r() * 0.25;
          e.wind = 0.4 + r() * 0.2;
          break;
        case 'storm':
          e.ramp = 50 + r() * 40;
          e.hold = 150 + r() * 120;
          e.cover = 1;
          e.precip = 0.95 + r() * 0.05;
          e.storm = 0.8 + r() * 0.2;
          e.wind = 0.7 + r() * 0.3;
          break;
        case 'dust':
          e.build = 45 + r() * 30;
          e.hold = 70 + r() * 80;
          e.cover = 0.6;
          e.precip = 0.75 + r() * 0.25;
          e.wind = 0.85 + r() * 0.15;
          break;
        case 'flurries':
          e.hold = 80 + r() * 100;
          e.cover = 0.75 + r() * 0.15;
          e.precip = 0.45 + r() * 0.35;
          e.wind = 0.3 + r() * 0.2;
          break;
      }
      this.events.push(e);
    }
  }

  end(e: WxEvent) {
    return e.start + e.build + e.ramp + e.hold + e.ease + e.clear;
  }

  /** The event covering time t (or null in a clear spell). */
  eventAt(t: number): WxEvent | null {
    this.ensure(t);
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (t >= e.start) return t < this.end(e) ? e : null;
    }
    return null;
  }

  /** The last event that started at or before t (null before the first one). */
  private lastEvent(t: number): WxEvent | null {
    this.ensure(t);
    for (let i = this.events.length - 1; i >= 0; i--) if (t >= this.events[i].start) return this.events[i];
    return null;
  }

  /** Instantaneous (non-accumulating) part of the state at game time t (seconds). */
  private sample(t: number, out: WxState): WxState {
    // background breeze: a slow veer and gusts
    const g = this.noise(t / 23, 1);
    const veer = (this.noise(t / 140, 2) - 0.5) * 1.2;
    out.cover = 0;
    out.precip = 0;
    out.storm = 0;
    out.wind = 0.12 + 0.12 * g;
    out.windDir = -0.55 + veer;
    out.stage = 'clear';
    out.event = null;
    const last = this.lastEvent(t);
    out.fall = last ? last.fall : 'rain';
    const e = this.eventAt(t);
    if (!e) return out;
    out.event = e;
    const l = t - e.start;
    const b = e.build;
    const r = b + e.ramp;
    const h = r + e.hold;
    const ez = h + e.ease;
    const end = ez + e.clear;
    out.stage = l < b ? 'build' : l < r ? 'ramp' : l < h ? 'hold' : l < ez ? 'ease' : 'clearing';
    // clouds: gather over the build-up (and the first part of the rain), break up over the clearing
    const coverIn = sstep(0, b + e.ramp * 0.4, l);
    const coverOut = 1 - sstep(h + e.ease * 0.3, end, l);
    out.cover = e.cover * coverIn * coverOut;
    // the falling stuff: light at first, heavier into the hold, gusty variation, easing off
    const pIn = sstep(b, r, l);
    const pOut = 1 - sstep(h, ez, l);
    const swell = e.kind === 'storm' ? 0.55 + 0.45 * sstep(b, r + e.hold * 0.35, l) : 1;
    const vary = 0.78 + 0.22 * this.noise(t / 17, 3);
    out.precip = e.precip * pIn * pOut * swell * vary;
    // thunderstorm: builds through the first part of the hold, dies away with the rain
    if (e.storm > 0) out.storm = e.storm * sstep(r - e.ramp * 0.3, r + e.hold * 0.3, l) * (1 - sstep(h - e.hold * 0.1, h + e.ease * 0.5, l));
    // the wind picks up ahead of the front, peaks with the rain and drops as it passes
    const wIn = sstep(b * 0.25, r, l);
    const wOut = 1 - sstep(h, ez + e.clear * 0.4, l);
    const front = e.wind * wIn * wOut * (0.8 + 0.2 * g + (e.storm > 0 ? 0.15 * this.noise(t / 4, 4) : 0));
    out.wind = Math.min(1, Math.max(out.wind, front));
    // the front swings the wind round to its own direction
    const k = Math.min(1, wIn * wOut * 1.4);
    let d = e.dir - out.windDir;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    out.windDir += d * k;
    return out;
  }

  /** One second of accumulation (wetting / drying, dust settling, snow dusting / melting). */
  private step(s: WxState) {
    const a = this.acc;
    const rain = s.fall === 'rain' ? s.precip : 0;
    // full wet after ~45 s of heavy rain; dries in ~5 min (slower under cloud, faster in wind)
    a.wet = Math.min(1, a.wet + rain * (1 - a.wet * 0.6) / 40);
    if (rain < 0.05) a.wet = Math.max(0, a.wet - (1 / 320) * (1 - 0.55 * s.cover) * (0.8 + 0.6 * s.wind));
    const dust = s.fall === 'sandstorm' ? s.precip : 0;
    a.dust = Math.min(0.85, a.dust + dust / 90);
    if (dust < 0.05) a.dust = Math.max(0, a.dust - 1 / 400 - a.wet / 60);
    const snow = s.fall === 'snow' ? s.precip : 0;
    a.snow = Math.min(0.28, a.snow + snow / 300);
    if (snow < 0.05) a.snow = Math.max(0, a.snow - 1 / 240);
  }

  /** Full state at game time t (seconds). Accumulators are integrated in fixed 1 s steps (deterministic). */
  at(t: number, out: WxState = WeatherCycle.blank()): WxState {
    t = Math.max(0, t);
    const sec = Math.floor(t);
    if (sec < this.sec) {
      this.sec = 0;
      this.acc.wet = this.acc.dust = this.acc.snow = 0;
    }
    while (this.sec < sec) {
      this.step(this.sample(this.sec, this.tmp));
      this.sec++;
    }
    // interpolate the accumulators within the second
    const a0 = { ...this.acc };
    this.step(this.sample(sec, this.tmp));
    const f = t - sec;
    const wet = a0.wet + (this.acc.wet - a0.wet) * f;
    const dust = a0.dust + (this.acc.dust - a0.dust) * f;
    const snow = a0.snow + (this.acc.snow - a0.snow) * f;
    Object.assign(this.acc, a0);
    this.sample(t, out);
    out.wet = wet;
    out.dust = dust;
    out.snow = snow;
    // mist rises off the wet ground once the rain has stopped (calm air keeps it)
    out.mist = sstep(0.25, 0.9, wet) * (1 - sstep(0.05, 0.3, out.precip)) * (1 - 0.6 * out.wind) * 0.4;
    return out;
  }

  /** Deterministic lightning: does a bolt strike in game second `sec` (given the storm level then)? */
  strikes(sec: number, storm: number): boolean {
    return storm > 0.05 && hash1(sec, this.seed ^ 0x7ab) < storm * 0.16;
  }
}
