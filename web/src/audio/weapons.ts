/**
 * Baked combat sounds.
 *
 * Every weapon, explosion, aircraft engine and ambience loop is synthesised
 * once at load into a few AudioBuffer variants by rendering a Web Audio graph
 * in an OfflineAudioContext (see bake.ts). Playing one is then a single
 * AudioBufferSourceNode into a pooled voice, so a big battle costs almost
 * nothing on a phone, and the offline graphs can afford to be rich:
 *
 *  - N-wave shock cracks (supersonic bullets, muzzle blast, detonations),
 *  - waveshaped (saturated) blast noise with fast filter sweeps,
 *  - pitch-dropping sine "booms" and sub thumps,
 *  - rolling low tails amplitude-modulated by very slow noise (terrain echo),
 *  - debris rattle: dirt, gravel and metal pings with thinning density,
 *  - mechanical detail: bolt clacks, belt links, breech clanks, casings,
 *  - rocket-motor roar with crackle, doppler'd jet flybys with a
 *    ground-reflection comb (the "flanging" of a real low pass).
 *
 * Each variant draws its parameters from a seeded RNG, and the player adds a
 * small random pitch / level change per shot, so repeats never sound
 * identical.
 */
import { type Bank, Patch, glide, rng32, spikes } from './core';

export interface BakeCtx {
  p: Patch;
  /** Mono (or stereo for ambience) output of this variant. */
  o: AudioNode;
  /** Start time of this variant inside the offline render. */
  t: number;
  /** Seeded random 0..1. */
  R: () => number;
  /** Per-variant pitch / size factor around 1. */
  r: number;
  /** Variant index. */
  i: number;
}

export type BakeBuild = (b: BakeCtx) => void;

export interface BakeDef {
  /** Length of one variant, seconds (trailing silence is trimmed after rendering). */
  dur: number;
  variants: number;
  /** Render sample rate: lower for rumbles to keep memory small. */
  sr: number;
  /** Seamless loop: crossfade length in seconds (the variant is `dur` long after looping). */
  loop?: number;
  stereo?: boolean;
  /** Pitch spread between variants (r = 1 +- spread / 2). */
  spread?: number;
  build: BakeBuild;
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const nwaveCache = new WeakMap<BaseAudioContext, Map<number, AudioBuffer>>();

/**
 * An N-wave: the pressure signature of a shock (supersonic bullet, muzzle
 * blast, detonation front). Instant over-pressure, a linear fall through
 * under-pressure and a sharp return: heard as a "crack".
 */
function nwave(ctx: BaseAudioContext, ms: number): AudioBuffer {
  let m = nwaveCache.get(ctx);
  if (!m) nwaveCache.set(ctx, (m = new Map()));
  const key = Math.round(ms * 10);
  let b = m.get(key);
  if (b) return b;
  const sr = ctx.sampleRate;
  const n = Math.max(4, Math.round((ms / 1000) * sr));
  b = ctx.createBuffer(1, n + 8, sr);
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = 1 - (2 * i) / (n - 1);
  m.set(key, b);
  return b;
}

/** Shock crack (N-wave) of `ms` milliseconds, high-passed so it reads as a crack, not a thump. */
function crack(p: Patch, o: AudioNode, t: number, ms: number, peak: number, hp = 250, lp = 16000): void {
  const s = p.sample(nwave(p.ctx, ms), t, t + ms / 1000 + 0.01);
  const h = p.filter('highpass', hp, 0.7);
  const l = p.filter('lowpass', Math.min(lp, p.ctx.sampleRate * 0.45), 0.7);
  const g = p.gain(peak);
  s.connect(h);
  h.connect(l);
  l.connect(g);
  g.connect(o);
}

/** Rolling low tail: lowpassed brown noise, slowly amplitude-modulated (echoes off terrain). */
function tail(p: Patch, o: AudioNode, t: number, f: number, a: number, d: number, peak: number, roll = 0.6, rollRate = 0.006): void {
  const end = t + a + d + 0.05;
  const src = p.noise('brown', t, end);
  const lp = p.filter('lowpass', f, 0.7);
  glide(lp.frequency, t, f, Math.max(60, f * 0.45), a + d);
  const am = p.gain(1 - roll * 0.5);
  const mod = p.noise('brown', t, end, rollRate);
  const depth = p.gain(roll * 1.4);
  mod.connect(depth);
  depth.connect(am.gain);
  const e = p.gain(0);
  e.gain.setValueAtTime(0, t);
  e.gain.linearRampToValueAtTime(peak, t + a);
  e.gain.setTargetAtTime(0, t + a, d / 4.5);
  src.connect(lp);
  lp.connect(am);
  am.connect(e);
  e.connect(o);
}

/** Metallic click: high-Q noise tick plus two inharmonic partials (bolt, link, breech). */
function mech(p: Patch, o: AudioNode, t: number, f: number, peak: number): void {
  p.nh(o, t, { type: 'bandpass', f, q: 7, a: 0.0005, d: 0.008, peak: peak * 2.2 });
  p.th(o, t, { f: f * 0.53, a: 0.0005, d: 0.028, peak: peak * 0.5 });
  p.th(o, t, { f: f * 0.53 * 2.76, a: 0.0005, d: 0.016, peak: peak * 0.35 });
}

/** A ringing metal ping (shrapnel on steel, a shell casing). */
function ping(p: Patch, o: AudioNode, t: number, f: number, d: number, peak: number): void {
  p.th(o, t, { f, a: 0.0005, d, peak });
  p.th(o, t, { f: f * 2.71, a: 0.0005, d: d * 0.55, peak: peak * 0.45 });
  p.th(o, t, { f: f * 5.18, a: 0.0005, d: d * 0.3, peak: peak * 0.25 });
}

/** Debris rattle: spikes on one band of noise, dense at first and thinning out (falling dirt / stones). */
function rattle(p: Patch, o: AudioNode, t: number, dur: number, n: number, f: number, q: number, peak: number, tau: number, R: () => number): void {
  const src = p.noise('white', t, t + dur + 0.15);
  const bp = p.filter('bandpass', f, q);
  const g = p.gain(0);
  const times: number[] = [];
  const peaks: number[] = [];
  for (let i = 0; i < n; i++) times.push(t + dur * Math.pow(R(), 1.7));
  times.sort((a, b) => a - b);
  for (let i = 0; i < n; i++) {
    const k = (times[i] - t) / dur;
    peaks.push(peak * (1 - 0.65 * k) * (0.25 + 0.75 * R()));
  }
  spikes(g.gain, times, peaks, tau);
  src.connect(bp);
  bp.connect(g);
  g.connect(o);
}

/** Dirt, gravel and a few metal pings falling back after a blast. */
function debris(p: Patch, o: AudioNode, t: number, dur: number, n: number, peak: number, R: () => number, metal = 0): void {
  rattle(p, o, t, dur, Math.round(n * 0.6), 900 + R() * 400, 0.9, peak, 0.012, R);
  rattle(p, o, t + 0.04, dur * 0.85, n, 2600 + R() * 1500, 2.2, peak * 0.8, 0.005, R);
  for (let i = 0; i < metal; i++) {
    const ti = t + 0.05 + dur * 0.8 * Math.pow(R(), 1.4);
    ping(p, o, ti, 1900 + R() * 3200, 0.05 + R() * 0.12, peak * (0.12 + 0.2 * R()));
  }
}

/** Rocket motor: saturated pink roar plus motor crackle. */
function roar(p: Patch, o: AudioNode, t: number, a: number, hold: number, d: number, f0: number, f1: number, peak: number, crackles: number, R: () => number): void {
  const end = t + a + hold + d + 0.05;
  const src = p.noise('pink', t, end);
  const sh = p.shaper(3.5);
  const lp = p.filter('lowpass', f0, 0.8);
  glide(lp.frequency, t, f0, f1, a + hold + d);
  const g = p.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + a);
  g.gain.setValueAtTime(peak, t + a + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + d);
  src.connect(sh);
  sh.connect(lp);
  lp.connect(g);
  g.connect(o);
  if (crackles > 0) {
    const cs = p.noise('white', t, end);
    const bp = p.filter('bandpass', 1800 + R() * 600, 1.2);
    const cg = p.gain(0);
    const times: number[] = [];
    const pk: number[] = [];
    for (let i = 0; i < crackles; i++) times.push(t + a * 0.5 + (hold + d * 0.6) * R());
    times.sort((x, y) => x - y);
    for (const ti of times) {
      const k = (ti - t) / (a + hold + d);
      pk.push(peak * 0.7 * (1 - 0.7 * k) * (0.3 + 0.7 * R()));
    }
    spikes(cg.gain, times, pk, 0.004);
    cs.connect(bp);
    bp.connect(cg);
    cg.connect(o);
  }
}

/** One gunshot report: shock crack, saturated muzzle blast, body thump. */
function report(p: Patch, o: AudioNode, t: number, r: number, R: () => number, s: { crackMs: number; f: number; q?: number; d: number; peak: number; thump: number; drive?: number }): void {
  const v = 0.85 + 0.15 * R();
  crack(p, o, t, s.crackMs * (0.9 + 0.2 * R()), 0.75 * s.peak * v, 400);
  p.nh(o, t, { type: 'bandpass', f: s.f * r * (0.93 + 0.14 * R()), q: s.q ?? 0.8, a: 0.0008, d: s.d, peak: s.peak * v, drive: s.drive ?? 3 });
  p.nh(o, t, { kind: 'pink', type: 'lowpass', f: s.f * 0.6, a: 0.001, d: s.d * 1.8, peak: s.peak * 0.5 * v });
  p.th(o, t, { f: s.thump * r, f2: s.thump * 0.42, glide: s.d * 1.2, d: s.d * 1.4, peak: s.peak * 0.55 * v });
}

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

function cannonShot(b: BakeCtx, heavy: boolean): void {
  const { p, o, t, r, R } = b;
  const k = heavy ? 1.25 : 1;
  crack(p, o, t, 2.4 * k * (0.9 + 0.2 * R()), 1, 180);
  // muzzle blast: saturated noise with a very fast downward sweep
  p.nh(o, t, { type: 'lowpass', f: 7000, f2: 700, sweep: 0.09, a: 0.0008, d: 0.14 * k, peak: 1, drive: 4 });
  p.nh(o, t, { kind: 'pink', type: 'bandpass', f: 420 * r, q: 0.55, a: 0.002, d: 0.38 * k, peak: 0.85, drive: 2 });
  // the boom: pitch-dropping sine with a little saturation, and a sub
  p.th(o, t, { f: (heavy ? 82 : 98) * r, f2: heavy ? 28 : 34, glide: 0.32 * k, d: 0.65 * k, peak: 1, drive: 2 });
  p.th(o, t, { type: 'triangle', f: heavy ? 44 : 50, f2: 26, glide: 0.8, a: 0.004, d: 0.95 * k, peak: 0.45 });
  // rolling echo off the terrain
  tail(p, o, t + 0.03, heavy ? 320 : 380, 0.09, 1.5 * k, 0.5, 0.65);
  p.nh(o, t + 0.06, { kind: 'pink', type: 'bandpass', f: 900, q: 0.6, a: 0.04, d: 0.6, peak: 0.12 });
  // mechanical: breech block and the spent casing
  const tm = t + 0.42 + R() * 0.12;
  mech(p, o, tm, 1700 * r, 0.06);
  ping(p, o, tm + 0.12 + R() * 0.05, 2900 + R() * 600, 0.18, 0.025);
}

function artilleryShot(b: BakeCtx): void {
  const { p, o, t, r, R } = b;
  crack(p, o, t, 3.8 * (0.9 + 0.2 * R()), 0.75, 150, 3500);
  p.nh(o, t, { kind: 'pink', type: 'lowpass', f: 1100, f2: 220, sweep: 0.3, a: 0.002, d: 0.5, peak: 1, drive: 3 });
  p.th(o, t, { f: 62 * r, f2: 24, glide: 0.8, d: 1.4, peak: 1, drive: 2.5 });
  p.th(o, t, { type: 'triangle', f: 38, f2: 22, glide: 1, a: 0.01, d: 1.6, peak: 0.55 });
  tail(p, o, t + 0.05, 260, 0.12, 2.6, 0.6, 0.85, 0.005);
  // the echo coming back off a distant ridge
  p.nh(o, t + 0.55 + R() * 0.3, { kind: 'brown', type: 'lowpass', f: 300, a: 0.08, d: 0.9, peak: 0.25 });
}

function rocketLaunch(b: BakeCtx): void {
  const { p, o, t, r, R } = b;
  crack(p, o, t, 1.1, 0.55, 500);
  p.nh(o, t, { type: 'bandpass', f: 900 * r, q: 0.8, a: 0.001, d: 0.05, peak: 0.8, drive: 2.5 });
  p.th(o, t, { f: 160 * r, f2: 60, glide: 0.07, d: 0.09, peak: 0.6 });
  // whoosh: the motor accelerating away
  p.nh(o, t + 0.01, { type: 'bandpass', f: 500 * r, f2: 2900 * r, sweep: 0.45, q: 1.7, a: 0.03, d: 0.75, peak: 0.6 });
  roar(p, o, t + 0.01, 0.04, 0.22, 0.75, 4200, 900, 0.45, 18, R);
  p.nh(o, t + 0.02, { type: 'highpass', f: 3200, a: 0.02, hold: 0.15, d: 0.5, peak: 0.16 });
  tail(p, o, t + 0.05, 500, 0.1, 0.8, 0.14, 0.4);
}

function missileLaunch(b: BakeCtx): void {
  const { p, o, t, r, R } = b;
  // ignition: crack, blast and a deep thud from the launch tube / pad
  crack(p, o, t, 2, 0.7, 250);
  p.nh(o, t, { kind: 'pink', type: 'lowpass', f: 2200, f2: 400, sweep: 0.25, a: 0.002, d: 0.32, peak: 0.85, drive: 2.5 });
  p.th(o, t, { f: 72 * r, f2: 34, glide: 0.4, d: 0.55, peak: 0.9, drive: 2 });
  // motor roar climbing away, with crackle and a rising whoosh
  roar(p, o, t + 0.04, 0.12, 0.7, 1.7, 2600 * r, 520, 0.95, 70, R);
  p.nh(o, t + 0.06, { type: 'bandpass', f: 380, f2: 2600 * r, sweep: 1.3, q: 2.2, a: 0.15, d: 1.2, peak: 0.35 });
  p.th(o, t + 0.05, { type: 'triangle', f: 46, f2: 70, glide: 1.1, a: 0.12, d: 1.4, peak: 0.32 });
  p.nh(o, t + 0.05, { type: 'highpass', f: 4000, a: 0.06, hold: 0.4, d: 0.9, peak: 0.1 });
  tail(p, o, t + 0.1, 300, 0.25, 2.1, 0.35, 0.7);
}

function interceptorLaunch(b: BakeCtx): void {
  const { p, o, t, r, R } = b;
  // a hard, fast "ffft-bang": small, very energetic motor
  crack(p, o, t, 1.4, 0.85, 400);
  p.nh(o, t, { type: 'bandpass', f: 1300 * r, q: 0.7, a: 0.0008, d: 0.07, peak: 0.85, drive: 3.5 });
  p.th(o, t, { f: 130 * r, f2: 52, glide: 0.12, d: 0.2, peak: 0.6 });
  p.nh(o, t + 0.005, { type: 'bandpass', f: 900 * r, f2: 4600 * r, sweep: 0.3, q: 2.4, a: 0.012, d: 0.42, peak: 0.75 });
  // motor hiss dropping in pitch as it leaves at Mach 2 (doppler away)
  p.nh(o, t + 0.05, { type: 'bandpass', f: 3800 * r, f2: 1500, sweep: 1.1, q: 1.3, a: 0.04, hold: 0.15, d: 1.0, peak: 0.42 });
  roar(p, o, t + 0.02, 0.03, 0.25, 0.9, 5000, 1400, 0.4, 25, R);
  tail(p, o, t + 0.05, 420, 0.15, 1.1, 0.2, 0.5);
}

function autocannonBurst(b: BakeCtx): void {
  const { p, o, t, r, R } = b;
  const n = 3 + (R() < 0.35 ? 1 : 0);
  const gap = 0.15 + R() * 0.03;
  for (let i = 0; i < n; i++) {
    const ti = t + i * (gap + (R() - 0.5) * 0.012);
    const v = 0.85 + 0.15 * R();
    crack(p, o, ti, 1.6, 0.85 * v, 300);
    p.nh(o, ti, { type: 'bandpass', f: 700 * r * (0.95 + 0.1 * R()), q: 0.6, a: 0.0008, d: 0.08, peak: v, drive: 3.2 });
    p.th(o, ti, { f: 118 * r, f2: 44, glide: 0.14, d: 0.2, peak: 0.75 * v, drive: 1.6 });
    p.nh(o, ti, { kind: 'pink', type: 'lowpass', f: 900, a: 0.002, d: 0.22, peak: 0.4 * v });
    // feed mechanism clank between rounds
    mech(p, o, ti + 0.055 + R() * 0.01, 2300 * r, 0.09);
  }
  tail(p, o, t + 0.03, 520, 0.08, 0.6 + n * gap, 0.32, 0.5);
}

function flakBurst(b: BakeCtx): void {
  const { p, o, t, r, R } = b;
  const gap = 0.085 + R() * 0.02;
  for (let i = 0; i < 2; i++) {
    const ti = t + i * gap;
    report(p, o, ti, r, R, { crackMs: 1.3, f: 1050, q: 0.7, d: 0.07, peak: 0.95, thump: 210 });
    mech(p, o, ti + 0.04, 3100 * r, 0.06);
  }
  tail(p, o, t + 0.02, 650, 0.05, 0.55, 0.22, 0.4);
}

function rifleShot(b: BakeCtx): void {
  const { p, o, t, r, R } = b;
  report(p, o, t, r, R, { crackMs: 0.7, f: 1700, q: 0.75, d: 0.05, peak: 1, thump: 170 });
  // supersonic bullet crack ahead of the muzzle report, very bright
  p.nh(o, t, { type: 'highpass', f: 5200, a: 0.0004, d: 0.012, peak: 0.25 });
  mech(p, o, t + 0.04 + R() * 0.02, 3900 * r, 0.05);
  if (R() < 0.35) {
    // double tap
    const t2 = t + 0.1 + R() * 0.04;
    report(p, o, t2, r * 1.01, R, { crackMs: 0.7, f: 1700, q: 0.75, d: 0.05, peak: 0.85, thump: 170 });
    mech(p, o, t2 + 0.045, 3900 * r, 0.04);
  }
  // slap-back off nearby cover
  p.nh(o, t + 0.01, { kind: 'pink', type: 'bandpass', f: 800, q: 0.5, a: 0.02, d: 0.32, peak: 0.12 });
}

function mgBurst(b: BakeCtx): void {
  const { p, o, t, r, R } = b;
  const n = 3 + Math.floor(R() * 2.2);
  const gap = 0.072 + R() * 0.015;
  for (let i = 0; i < n; i++) {
    const ti = t + i * (gap + (R() - 0.5) * 0.008);
    report(p, o, ti, r * (0.98 + 0.04 * R()), R, { crackMs: 0.9, f: 1250, q: 0.8, d: 0.045, peak: 0.95, thump: 135 });
    // belt links and bolt cycling
    mech(p, o, ti + 0.025 + R() * 0.012, 5200 * r, 0.035);
  }
  p.nh(o, t, { kind: 'pink', type: 'bandpass', f: 700, q: 0.5, a: 0.03, d: 0.3 + n * gap, peak: 0.14 });
}

// ---------------------------------------------------------------------------
// Explosions
// ---------------------------------------------------------------------------

function explosion(b: BakeCtx, size: 0 | 1 | 2): void {
  const { p, o, t, r, R } = b;
  const k = [0.6, 1, 1.5][size];
  crack(p, o, t, [1.6, 2.6, 3.6][size] * (0.85 + 0.3 * R()), 0.95, 200);
  // detonation: saturated broadband blast collapsing to a low roar
  p.nh(o, t, { type: 'lowpass', f: 6500, f2: 600, sweep: 0.12 * k, a: 0.0008, d: 0.18 * k, peak: 1, drive: 4 });
  p.nh(o, t, { kind: 'pink', type: 'lowpass', f: 2000 * r, f2: 200, sweep: 0.6 * k, a: 0.002, d: 0.75 * k, peak: 0.9, drive: 2.2 });
  if (size > 0) p.nh(o, t, { kind: 'brown', type: 'lowpass', f: 900, f2: 140, sweep: 1.2 * k, a: 0.01, d: 1.3 * k, peak: 0.85, drive: 2 });
  p.th(o, t, { f: [100, 78, 62][size] * r, f2: [38, 30, 24][size], glide: 0.4 * k, d: 0.55 * k, peak: 1, drive: 2 });
  if (size > 0) p.th(o, t, { type: 'triangle', f: 44, f2: 24, glide: 1.2, a: 0.006, d: 1.2 * k, peak: 0.5 });
  // debris raining down
  debris(p, o, t + 0.06, [0.6, 1.3, 2.1][size], [14, 32, 56][size], [0.22, 0.28, 0.3][size], R, [0, 3, 6][size]);
  // secondary pops on the big ones (ammunition cooking off)
  if (size === 2) {
    const n = 2 + Math.floor(R() * 2);
    for (let i = 0; i < n; i++) {
      const ti = t + 0.35 + R() * 1.4;
      crack(p, o, ti, 0.9, 0.25 + 0.2 * R(), 600);
      p.nh(o, ti, { type: 'bandpass', f: 1200 + R() * 900, q: 0.9, a: 0.001, d: 0.06, peak: 0.25, drive: 2.5 });
      p.th(o, ti, { f: 140, f2: 60, glide: 0.08, d: 0.1, peak: 0.2 });
    }
  }
  tail(p, o, t + 0.04, [500, 380, 300][size], 0.08 * k, [0.8, 1.7, 2.8][size], [0.25, 0.42, 0.55][size], 0.7);
}

function collapse(b: BakeCtx): void {
  const { p, o, t, R } = b;
  explosion({ ...b }, 1);
  // structural steel groaning as the frame gives way
  const end = t + 2.6;
  const groan = p.osc('sawtooth', 58 + R() * 10, t + 0.2, end);
  glide(groan.frequency, t + 0.2, 58 + R() * 10, 36, 2.2);
  const wob = p.osc('sine', 3 + R() * 2, t + 0.2, end);
  const wd = p.gain(6);
  wob.connect(wd);
  wd.connect(groan.frequency);
  const gbp = p.filter('bandpass', 320 + R() * 120, 5);
  const gg = p.gain(0);
  gg.gain.setValueAtTime(0, t + 0.2);
  gg.gain.linearRampToValueAtTime(0.32, t + 0.6);
  gg.gain.setTargetAtTime(0, t + 1.3, 0.4);
  groan.connect(gbp);
  gbp.connect(gg);
  gg.connect(o);
  // masonry crumbling: brown noise gated into grains
  const cs = p.noise('brown', t + 0.25, t + 4);
  const clp = p.filter('lowpass', 420, 0.8);
  const cg = p.gain(0);
  const times: number[] = [];
  const pk: number[] = [];
  for (let i = 0; i < 90; i++) times.push(t + 0.25 + 3.2 * Math.pow(R(), 1.3));
  times.sort((x, y) => x - y);
  for (const ti of times) pk.push((1 - (ti - t) / 4) * (0.4 + 0.6 * R()) * 1.6);
  spikes(cg.gain, times, pk, 0.035);
  cs.connect(clp);
  clp.connect(cg);
  cg.connect(o);
  // heavy chunks landing
  for (let i = 0; i < 7; i++) {
    const ti = t + 0.4 + R() * 2.4;
    p.th(o, ti, { f: 70 + R() * 25, f2: 34, glide: 0.12, d: 0.2, peak: 0.35 + R() * 0.25 });
    p.nh(o, ti, { kind: 'pink', type: 'lowpass', f: 700, a: 0.002, d: 0.14, peak: 0.3 });
  }
  // glass and tiles
  rattle(p, o, t + 0.15, 1.1, 30, 5200, 2.5, 0.22, 0.004, R);
  debris(p, o, t + 0.3, 2.6, 40, 0.18, R, 4);
  tail(p, o, t + 0.3, 260, 0.4, 3.6, 0.6, 0.8, 0.004);
}

function bridgeFall(b: BakeCtx): void {
  const { p, o, t, R } = b;
  explosion({ ...b }, 2);
  // steel screaming: two detuned saws through narrow resonances, bending down
  for (const [f, bpF] of [[92, 760], [137, 1150]] as const) {
    const s = p.osc('sawtooth', f, t + 0.3, t + 2.4);
    glide(s.frequency, t + 0.3, f * (1 + R() * 0.05), f * 0.7, 1.9);
    const bp = p.filter('bandpass', bpF, 9);
    const g = p.gain(0);
    g.gain.setValueAtTime(0, t + 0.3);
    g.gain.linearRampToValueAtTime(0.2, t + 0.7);
    g.gain.setTargetAtTime(0, t + 1.5, 0.3);
    s.connect(bp);
    bp.connect(g);
    g.connect(o);
  }
  // suspension cables snapping
  for (let i = 0; i < 3; i++) {
    const ti = t + 0.55 + i * 0.3 + R() * 0.2;
    crack(p, o, ti, 0.8, 0.4, 900);
    p.th(o, ti, { f: 950 + R() * 400, f2: 180, glide: 0.25, d: 0.32, peak: 0.22 });
  }
  // the deck hitting the river: splash, plunge and bubbling
  const ts = t + 1.9 + R() * 0.5;
  p.nh(o, ts, { type: 'lowpass', f: 7000, f2: 1000, sweep: 0.9, a: 0.03, d: 1.1, peak: 0.85 });
  p.nh(o, ts, { kind: 'pink', type: 'bandpass', f: 600, q: 0.6, a: 0.02, d: 1.3, peak: 0.5 });
  p.th(o, ts, { f: 62, f2: 28, glide: 0.5, d: 0.8, peak: 0.7 });
  rattle(p, o, ts + 0.2, 1.6, 50, 800, 3, 0.2, 0.01, R);
  // concrete and masonry
  debris(p, o, t + 0.4, 2.2, 40, 0.24, R, 5);
  tail(p, o, t + 0.3, 240, 0.5, 4.2, 0.55, 0.8, 0.004);
}

function thunder(b: BakeCtx): void {
  const { p, o, t, R, i } = b;
  // the near variant opens with a tearing crack
  if (i === 0) {
    crack(p, o, t, 6, 0.55, 300, 6000);
    p.nh(o, t, { type: 'lowpass', f: 5000, f2: 700, sweep: 0.5, a: 0.004, d: 0.7, peak: 0.6, drive: 2 });
  }
  // rolling: several overlapping swells of low noise
  const n = 3 + Math.floor(R() * 3);
  for (let k = 0; k < n; k++) {
    const ts = t + 0.05 + k * (0.5 + R() * 0.6);
    tail(p, o, ts, 180 + R() * 180, 0.15 + R() * 0.3, 1.6 + R() * 1.6, 0.4 + 0.5 * R() * (1 - k / n), 0.9, 0.01);
  }
  p.th(o, t + 0.1, { type: 'triangle', f: 40, f2: 26, glide: 2, a: 0.3, d: 2.5, peak: 0.35 });
}

function interceptPop(b: BakeCtx): void {
  const { p, o, t, r, R } = b;
  crack(p, o, t, 1.2, 0.8, 500);
  p.nh(o, t, { type: 'bandpass', f: 1600 * r, q: 0.8, a: 0.0008, d: 0.06, peak: 0.85, drive: 3 });
  p.th(o, t, { f: 260 * r, f2: 95, glide: 0.06, d: 0.09, peak: 0.5 });
  ping(p, o, t + 0.008, 3100 * r, 0.12, 0.12);
  rattle(p, o, t + 0.03, 0.35, 12, 3600, 2, 0.2, 0.004, R);
  tail(p, o, t + 0.02, 700, 0.04, 0.5, 0.15, 0.4);
}

function mortarShot(b: BakeCtx): void {
  const { p, o, t, r, R } = b;
  // the tube "thoonk": a pipe resonance plus the bomb's charge
  p.th(o, t, { f: 210 * r, f2: 150 * r, glide: 0.05, a: 0.001, d: 0.14, peak: 0.8 });
  p.th(o, t, { f: 95 * r, f2: 48, glide: 0.18, d: 0.28, peak: 0.85, drive: 1.5 });
  p.nh(o, t, { type: 'bandpass', f: 420 * r, q: 1.8, a: 0.001, d: 0.09, peak: 0.6, drive: 2 });
  crack(p, o, t, 1.4, 0.35, 300, 4000);
  p.nh(o, t + 0.02, { type: 'highpass', f: 2600, a: 0.01, d: 0.35, peak: 0.12 });
  tail(p, o, t + 0.03, 420, 0.06, 0.8, 0.22, 0.5 + 0.2 * R());
}

function thermoSalvo(b: BakeCtx): void {
  const { p, o, t, r, R } = b;
  const n = 6;
  for (let k = 0; k < n; k++) {
    const ti = t + k * (0.09 + R() * 0.04);
    crack(p, o, ti, 1.2, 0.4, 400);
    p.th(o, ti, { f: 150 * r, f2: 55, glide: 0.09, d: 0.12, peak: 0.6 });
    p.nh(o, ti, { type: 'bandpass', f: 800 + k * 70, q: 0.9, a: 0.001, d: 0.05, peak: 0.5, drive: 2 });
    p.nh(o, ti, { type: 'bandpass', f: 600, f2: 2600, sweep: 0.4, q: 1.8, a: 0.02, d: 0.4, peak: 0.22 });
  }
  roar(p, o, t, 0.08, 0.6, 1.1, 2600, 700, 0.6, 50, R);
  tail(p, o, t + 0.05, 340, 0.2, 1.6, 0.35, 0.7);
}

function laserZap(b: BakeCtx): void {
  const { p, o, t, r, R } = b;
  const lp = p.filter('lowpass', 3600, 1.2);
  lp.connect(o);
  p.th(lp, t, { type: 'sawtooth', f: 2400 * r, f2: 300, glide: 0.22, a: 0.003, d: 0.3, peak: 0.25 });
  p.th(lp, t, { f: 2400 * r, f2: 280, glide: 0.2, a: 0.003, d: 0.32, peak: 0.35, detune: 14 });
  p.th(lp, t, { f: 1200 * r, f2: 140, glide: 0.22, a: 0.003, d: 0.28, peak: 0.2, detune: -9 });
  // electrical crackle and a hum swell (high-energy laser)
  rattle(p, o, t, 0.3, 26, 4200, 1.5, 0.3, 0.003, R);
  p.th(o, t, { type: 'sawtooth', f: 100, a: 0.02, hold: 0.15, d: 0.15, peak: 0.08, lp: 900 });
}

function droneLaunchFx(b: BakeCtx): void {
  const { p, o, t, r, R } = b;
  // pneumatic catapult
  p.th(o, t, { f: 95 * r, f2: 45, glide: 0.1, d: 0.14, peak: 0.75 });
  p.nh(o, t, { type: 'bandpass', f: 650, q: 1, a: 0.001, d: 0.06, peak: 0.6, drive: 2 });
  p.nh(o, t, { type: 'highpass', f: 2800, a: 0.002, d: 0.3, peak: 0.25 });
  // little motor spinning up and flying off
  const end = t + 1.2;
  const bp = p.filter('bandpass', 700, 1.3);
  glide(bp.frequency, t, 700, 1600, 0.9);
  const trem = p.gain(0.6);
  const lfo = p.osc('sine', 24 + R() * 6, t, end);
  const depth = p.gain(0.32);
  lfo.connect(depth);
  depth.connect(trem.gain);
  const e = p.gain(0);
  e.gain.setValueAtTime(0, t + 0.05);
  e.gain.linearRampToValueAtTime(0.5, t + 0.18);
  e.gain.linearRampToValueAtTime(0.4, t + 0.7);
  e.gain.exponentialRampToValueAtTime(0.0001, t + 1.15);
  for (const det of [0, 14]) {
    const s = p.osc('sawtooth', 170 * r, t, end);
    s.detune.value = det;
    glide(s.frequency, t + 0.05, 170 * r, 430 * r, 0.75);
    s.connect(bp);
  }
  bp.connect(trem);
  trem.connect(e);
  e.connect(o);
}

function droneBuzzFx(b: BakeCtx): void {
  const { p, o, t, r } = b;
  const end = t + 0.35;
  const bp = p.filter('bandpass', 1100, 1.2);
  const trem = p.gain(0.65);
  const lfo = p.osc('sine', 32, t, end);
  const depth = p.gain(0.35);
  lfo.connect(depth);
  depth.connect(trem.gain);
  const e = p.gain(0);
  e.gain.setValueAtTime(0, t);
  e.gain.linearRampToValueAtTime(0.45, t + 0.03);
  e.gain.setValueAtTime(0.45, t + 0.08);
  e.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  p.osc('sawtooth', 250 * r, t, end).connect(bp);
  p.osc('sawtooth', 253 * r, t, end).connect(bp);
  bp.connect(trem);
  trem.connect(e);
  e.connect(o);
}

/**
 * Jet flyby: turbine roar and whine with the full doppler pitch fall, the
 * swelling level of the closest approach and the comb filter of the ground
 * reflection sweeping past (the "flanging" of a real low pass).
 */
function jetFlyby(b: BakeCtx): void {
  const { p, o, t, r, R } = b;
  const T = 3.6;
  const tc = t + 1.1 + R() * 0.2; // closest approach
  const end = t + T;
  // level: inverse distance around the closest approach
  const env = p.gain(0);
  const pts = 40;
  const curve = new Float32Array(pts);
  for (let k = 0; k < pts; k++) {
    const tt = (k / (pts - 1)) * T;
    const x = (t + tt - tc) * 3.2;
    curve[k] = 1 / (1 + x * x) * Math.min(1, tt / 0.15) * Math.min(1, (T - tt) / 0.4);
  }
  env.gain.setValueCurveAtTime(curve, t, T);
  // roar
  const n = p.noise('pink', t, end);
  const sh = p.shaper(2);
  const lp = p.filter('lowpass', 2600, 0.7);
  lp.frequency.setValueAtTime(5200, t);
  lp.frequency.linearRampToValueAtTime(6500, tc);
  lp.frequency.exponentialRampToValueAtTime(900, end);
  n.connect(sh);
  sh.connect(lp);
  // ground reflection: dry + delayed copy, delay shortest at the closest approach
  const dl = p.add(p.ctx.createDelay(0.05));
  dl.delayTime.setValueAtTime(0.009, t);
  dl.delayTime.linearRampToValueAtTime(0.0007, tc);
  dl.delayTime.linearRampToValueAtTime(0.012, end);
  const mix = p.gain(1);
  const refl = p.gain(0.75);
  lp.connect(mix);
  lp.connect(dl);
  dl.connect(refl);
  refl.connect(mix);
  // turbine whine with the doppler drop (approach high, recede low)
  const fw = 2300 * r;
  const wh = p.osc('sawtooth', fw * 1.18, t, end);
  wh.frequency.setValueAtTime(fw * 1.18, t);
  wh.frequency.setValueAtTime(fw * 1.16, tc - 0.25);
  wh.frequency.exponentialRampToValueAtTime(fw * 0.82, tc + 0.3);
  wh.frequency.linearRampToValueAtTime(fw * 0.8, end);
  const wbp = p.filter('bandpass', 2400, 3);
  const wg = p.gain(0.09);
  wh.connect(wbp);
  wbp.connect(wg);
  wg.connect(mix);
  // low rumble trailing behind (afterburner)
  const rb = p.noise('brown', t, end);
  const rlp = p.filter('lowpass', 220, 0.7);
  const rg = p.gain(0);
  rg.gain.setValueAtTime(0, t);
  rg.gain.linearRampToValueAtTime(0.25, tc);
  rg.gain.linearRampToValueAtTime(0.5, tc + 0.4);
  rg.gain.exponentialRampToValueAtTime(0.001, end);
  rb.connect(rlp);
  rlp.connect(rg);
  rg.connect(o);
  mix.connect(env);
  env.connect(o);
}

// ---------------------------------------------------------------------------
// Engine loops (aircraft) - each lasts a whole number of oscillator periods
// ---------------------------------------------------------------------------

function jetLoop(b: BakeCtx): void {
  const { p, o, t } = b;
  const end = t + 2.4;
  p.nh(o, t, { kind: 'pink', type: 'lowpass', f: 1300, a: 0.001, hold: 2.4, d: 0.01, peak: 0.9, drive: 1.5 });
  p.nh(o, t, { type: 'bandpass', f: 2600, q: 1.4, a: 0.001, hold: 2.4, d: 0.01, peak: 0.35 });
  p.nh(o, t, { kind: 'brown', type: 'lowpass', f: 160, a: 0.001, hold: 2.4, d: 0.01, peak: 0.6 });
  const w = p.osc('sine', 2250, t, end);
  const wg = p.gain(0.05);
  w.connect(wg);
  wg.connect(o);
}

function rotorLoop(b: BakeCtx): void {
  const { p, o, t, R } = b;
  // 5.25 blade slaps per second, 8 per loop
  const per = 1 / 5.25;
  for (let k = 0; k < 9; k++) {
    const ti = t + k * per;
    const v = 0.85 + 0.15 * R();
    p.nh(o, ti, { kind: 'pink', type: 'lowpass', f: 420, a: 0.004, d: 0.09, peak: 0.9 * v });
    p.th(o, ti, { f: 68, f2: 50, glide: 0.06, a: 0.003, d: 0.08, peak: 0.55 * v });
    p.nh(o, ti, { type: 'bandpass', f: 1500, q: 1.5, a: 0.002, d: 0.03, peak: 0.25 * v });
  }
  p.nh(o, t, { type: 'highpass', f: 2600, a: 0.001, hold: 1.8, d: 0.01, peak: 0.12 });
  const w = p.osc('sine', 3150, t, t + 1.8);
  const wg = p.gain(0.03);
  w.connect(wg);
  wg.connect(o);
}

function propLoop(b: BakeCtx): void {
  const { p, o, t } = b;
  // a small piston engine (96 Hz firing) driving a pusher prop (blade pass 64 Hz)
  const end = t + 1.8;
  const eng = p.osc('sawtooth', 96, t, end);
  const lp = p.filter('lowpass', 1400, 0.9);
  const am = p.gain(0.7);
  const bl = p.osc('sine', 64, t, end);
  const bd = p.gain(0.3);
  bl.connect(bd);
  bd.connect(am.gain);
  const g = p.gain(0.5);
  eng.connect(lp);
  lp.connect(am);
  am.connect(g);
  g.connect(o);
  p.nh(o, t, { kind: 'pink', type: 'bandpass', f: 900, q: 0.8, a: 0.001, hold: 1.8, d: 0.01, peak: 0.25 });
}

function fpvLoop(b: BakeCtx): void {
  const { p, o, t } = b;
  // tiny brushless motors: a high whine with a fast prop tremolo
  const end = t + 1.4;
  const bp = p.filter('bandpass', 1900, 1.4);
  for (const f of [420, 425, 840]) p.osc('sawtooth', f, t, end).connect(bp);
  const trem = p.gain(0.65);
  const lfo = p.osc('sine', 70, t, end);
  const dp = p.gain(0.3);
  lfo.connect(dp);
  dp.connect(trem.gain);
  const g = p.gain(0.35);
  bp.connect(trem);
  trem.connect(g);
  g.connect(o);
  p.nh(o, t, { type: 'highpass', f: 3500, a: 0.001, hold: 1.4, d: 0.01, peak: 0.08 });
}

// ---------------------------------------------------------------------------
// Ambience beds (stereo, seamless loops)
// ---------------------------------------------------------------------------

/** Build each channel separately into a stereo merger. */
function stereo(b: BakeCtx, ch: (o: AudioNode, side: number) => void): void {
  const m = b.p.add(b.p.ctx.createChannelMerger(2));
  for (let s = 0; s < 2; s++) {
    const g = b.p.gain(1);
    ch(g, s);
    g.connect(m, 0, s);
  }
  m.connect(b.o);
}

function windBed(b: BakeCtx): void {
  const { p, t, R } = b;
  const T = 7;
  stereo(b, (o) => {
    const am = p.gain(0.6);
    const mod = p.noise('brown', t, t + T, 0.004);
    const md = p.gain(1.1);
    mod.connect(md);
    md.connect(am.gain);
    am.connect(o);
    p.nh(am, t, { kind: 'pink', type: 'bandpass', f: 380, q: 0.6, a: 0.001, hold: T, d: 0.01, peak: 0.8 });
    p.nh(am, t, { kind: 'brown', type: 'lowpass', f: 150, a: 0.001, hold: T, d: 0.01, peak: 0.7 });
    // a faint whistle through gaps, wandering in pitch
    const src = p.noise('white', t, t + T);
    const bp = p.filter('bandpass', 700, 9);
    let tt = t;
    bp.frequency.setValueAtTime(600 + R() * 400, t);
    while (tt < t + T) {
      tt += 0.8 + R() * 1.2;
      bp.frequency.linearRampToValueAtTime(520 + R() * 700, tt);
    }
    const wg = p.gain(0.22);
    src.connect(bp);
    bp.connect(wg);
    wg.connect(am);
  });
}

function rainBed(b: BakeCtx): void {
  const { p, t, R } = b;
  const T = 4.5;
  stereo(b, (o) => {
    const src = p.noise('white', t, t + T);
    const hp = p.filter('highpass', 1300, 0.6);
    const lp = p.filter('lowpass', 8500, 0.6);
    const g = p.gain(0.45);
    src.connect(hp);
    hp.connect(lp);
    lp.connect(g);
    g.connect(o);
    // drops on leaves, puddles and metal
    rattle(p, o, t, T, 900, 3600 + R() * 800, 1.4, 0.5, 0.0025, () => R());
    rattle(p, o, t, T, 260, 1400, 1.2, 0.35, 0.004, () => R());
    p.nh(o, t, { kind: 'pink', type: 'lowpass', f: 650, a: 0.001, hold: T, d: 0.01, peak: 0.3 });
  });
}

function riverBed(b: BakeCtx): void {
  const { p, t, R } = b;
  const T = 5;
  stereo(b, (o) => {
    const am = p.gain(0.7);
    const mod = p.noise('brown', t, t + T, 0.02);
    const md = p.gain(0.7);
    mod.connect(md);
    md.connect(am.gain);
    am.connect(o);
    p.nh(am, t, { kind: 'brown', type: 'bandpass', f: 420, q: 0.5, a: 0.001, hold: T, d: 0.01, peak: 0.9 });
    p.nh(am, t, { kind: 'pink', type: 'bandpass', f: 1300, q: 0.8, a: 0.001, hold: T, d: 0.01, peak: 0.3 });
    // bubbles and little gurgles: short rising sine blips
    for (let k = 0; k < 70; k++) {
      const ti = t + R() * (T - 0.06);
      const f = 380 + R() * 900;
      p.th(o, ti, { f, f2: f * (1.4 + R() * 0.5), glide: 0.035, a: 0.002, d: 0.035, peak: 0.05 + R() * 0.12 });
    }
  });
}

function cricketBed(b: BakeCtx): void {
  const { p, t, R } = b;
  const T = 6;
  // three crickets at different pitches and places, plus a faint night hush
  const crickets = [0, 1, 2].map(() => ({ f: 4200 + R() * 1000, side: R(), every: 0.55 + R() * 0.4, lvl: 0.25 + R() * 0.35 }));
  stereo(b, (o, side) => {
    p.nh(o, t, { kind: 'pink', type: 'lowpass', f: 700, a: 0.001, hold: T, d: 0.01, peak: 0.05 });
    for (const c of crickets) {
      const osc = p.osc('sine', c.f, t, t + T);
      const g = p.gain(0);
      const lvl = c.lvl * (side === 0 ? 1 - c.side * 0.8 : 0.2 + c.side * 0.8);
      let tt = t + R() * c.every;
      while (tt < t + T - 0.12) {
        for (let k = 0; k < 3; k++) {
          const ts = tt + k * 0.03;
          g.gain.setValueAtTime(0, ts);
          g.gain.linearRampToValueAtTime(lvl, ts + 0.004);
          g.gain.setValueAtTime(lvl, ts + 0.011);
          g.gain.linearRampToValueAtTime(0, ts + 0.015);
        }
        tt += c.every * (0.9 + 0.2 * R());
      }
      osc.connect(g);
      g.connect(o);
    }
  });
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export type BakedName =
  | 'rifle' | 'mg' | 'autocannon' | 'flak' | 'cannon' | 'cannonHeavy' | 'rocket' | 'missileLaunch' | 'interceptorLaunch'
  | 'laser' | 'artillery' | 'mortar' | 'thermo' | 'explosionSmall' | 'explosionMedium' | 'explosionLarge'
  | 'buildingCollapse' | 'bridgeCollapse' | 'intercept' | 'droneLaunch' | 'droneBuzz' | 'jetFlyby' | 'thunder'
  | 'jetLoop' | 'rotorLoop' | 'propLoop' | 'fpvLoop' | 'windBed' | 'rainBed' | 'riverBed' | 'cricketBed';

const SR_HI = 32000;
const SR_MID = 24000;
const SR_LO = 16000;

export const BAKED: Record<BakedName, BakeDef> = {
  rifle: { dur: 0.75, variants: 5, sr: SR_HI, build: rifleShot },
  mg: { dur: 0.95, variants: 4, sr: SR_HI, build: mgBurst },
  autocannon: { dur: 1.6, variants: 4, sr: SR_HI, build: autocannonBurst },
  flak: { dur: 1.0, variants: 3, sr: SR_HI, build: flakBurst },
  cannon: { dur: 2.2, variants: 4, sr: SR_HI, build: (b) => cannonShot(b, false) },
  cannonHeavy: { dur: 2.7, variants: 3, sr: SR_HI, build: (b) => cannonShot(b, true) },
  rocket: { dur: 1.6, variants: 4, sr: SR_HI, build: rocketLaunch },
  missileLaunch: { dur: 3.2, variants: 3, sr: SR_HI, build: missileLaunch },
  interceptorLaunch: { dur: 2.0, variants: 3, sr: SR_HI, build: interceptorLaunch },
  laser: { dur: 0.6, variants: 2, sr: SR_HI, build: laserZap },
  artillery: { dur: 3.4, variants: 3, sr: SR_MID, build: artilleryShot },
  mortar: { dur: 1.2, variants: 3, sr: SR_MID, build: mortarShot },
  thermo: { dur: 2.6, variants: 2, sr: SR_HI, build: thermoSalvo },
  explosionSmall: { dur: 1.5, variants: 5, sr: SR_HI, spread: 0.16, build: (b) => explosion(b, 0) },
  explosionMedium: { dur: 2.6, variants: 4, sr: SR_HI, spread: 0.14, build: (b) => explosion(b, 1) },
  explosionLarge: { dur: 3.8, variants: 3, sr: SR_MID, spread: 0.12, build: (b) => explosion(b, 2) },
  buildingCollapse: { dur: 5.0, variants: 2, sr: SR_MID, build: collapse },
  bridgeCollapse: { dur: 6.0, variants: 2, sr: SR_MID, build: bridgeFall },
  intercept: { dur: 0.9, variants: 3, sr: SR_HI, build: interceptPop },
  droneLaunch: { dur: 1.3, variants: 2, sr: SR_HI, build: droneLaunchFx },
  droneBuzz: { dur: 0.4, variants: 2, sr: SR_MID, build: droneBuzzFx },
  jetFlyby: { dur: 3.7, variants: 2, sr: SR_HI, spread: 0.08, build: jetFlyby },
  thunder: { dur: 6.5, variants: 3, sr: SR_LO, spread: 0.2, build: thunder },
  jetLoop: { dur: 2.0, variants: 1, sr: SR_MID, loop: 0.35, spread: 0, build: jetLoop },
  rotorLoop: { dur: 8 / 5.25, variants: 1, sr: SR_MID, loop: 1 / 5.25 - 0.02, spread: 0, build: rotorLoop },
  propLoop: { dur: 1.5, variants: 1, sr: SR_MID, loop: 0.25, spread: 0, build: propLoop },
  fpvLoop: { dur: 1.2, variants: 1, sr: SR_MID, loop: 0.2, spread: 0, build: fpvLoop },
  windBed: { dur: 6, variants: 1, sr: SR_LO, loop: 1, stereo: true, spread: 0, build: windBed },
  rainBed: { dur: 4, variants: 1, sr: 22050, loop: 0.5, stereo: true, spread: 0, build: rainBed },
  riverBed: { dur: 4.5, variants: 1, sr: SR_LO, loop: 0.5, stereo: true, spread: 0, build: riverBed },
  cricketBed: { dur: 5.6, variants: 1, sr: SR_LO, loop: 0.4, stereo: true, spread: 0, build: cricketBed },
};

/** Bake order: what a battle needs first comes first (ambience last, it fades in). */
export const BAKE_ORDER: BakedName[] = [
  'rifle', 'mg', 'cannon', 'explosionSmall', 'explosionMedium', 'explosionLarge', 'rocket', 'missileLaunch',
  'autocannon', 'cannonHeavy', 'artillery', 'interceptorLaunch', 'intercept', 'flak', 'buildingCollapse', 'mortar',
  'thermo', 'droneLaunch', 'laser', 'droneBuzz', 'bridgeCollapse', 'jetFlyby', 'thunder',
  'jetLoop', 'rotorLoop', 'propLoop', 'fpvLoop', 'windBed', 'rainBed', 'riverBed', 'cricketBed',
];

/** Length of the offline render for one definition (all variants back to back). */
export function slotLength(def: BakeDef): number {
  return def.dur + (def.loop ?? 0) + 0.05;
}

/**
 * Build all variants of `def` into an offline context. Variant i starts at
 * i * slotLength(def). Returns nothing: the caller renders and slices.
 */
export function buildVariants(ctx: BaseAudioContext, bank: Bank, def: BakeDef, seed: number): void {
  const slot = slotLength(def);
  const R = rng32(seed);
  const spread = def.spread ?? 0.1;
  for (let i = 0; i < def.variants; i++) {
    const p = new Patch(ctx, bank);
    const out = p.gain(1);
    out.connect(ctx.destination);
    const r = 1 + (R() - 0.5) * spread;
    def.build({ p, o: out, t: i * slot + 0.004, R, r, i });
  }
}
