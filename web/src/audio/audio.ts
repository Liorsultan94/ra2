/**
 * Procedural sound system: every effect, the announcer radio chatter and the
 * background music are synthesized at runtime with the Web Audio API.
 * There are no audio asset files.
 *
 * Graph:
 *   voice -> [panner] -> sfxBus -> sfxGain ----------------\
 *                     \-> wetSend -> sfxWetBus -> sfxWetGain -> reverb -\
 *   music (music.ts) -> musicPlay -> musicDuck -> musicGain -------------+-> compressor -> master -> destination
 *                                                          \-> musicWet -> reverb
 *
 * The battle score adapts to a combat intensity inferred from the effects and
 * announcer lines that pass through here (see intensity.ts).
 */
import { Bank, Patch, clamp, env, glide, makeImpulse, spikes } from './core';
import { CombatHeat } from './intensity';
import { MUSIC_LEVEL, MusicEngine, type MusicMode, type StingerKind } from './music';

export type Sfx =
  | 'rifle' | 'mg' | 'cannon' | 'cannonHeavy' | 'rocket' | 'missileLaunch' | 'flak' | 'laser'
  | 'artillery' | 'thermo' | 'explosionSmall' | 'explosionMedium' | 'explosionLarge' | 'buildingCollapse'
  | 'intercept' | 'droneLaunch' | 'droneBuzz' | 'click' | 'tab' | 'build' | 'place' | 'sell' | 'error'
  | 'select' | 'ack' | 'alarm' | 'money' | 'deploy' | 'repair' | 'jam';

const MAX_VOICES = 24;

/** Maps a screen x coordinate to a stereo pan in -0.8..0.8. */
export function panFor(screenX: number, screenWidth: number): number {
  if (!(screenWidth > 0) || !Number.isFinite(screenX)) return 0;
  const x = clamp(screenX / screenWidth, 0, 1);
  return (x * 2 - 1) * 0.8;
}

// ---------------------------------------------------------------------------
// Sound effects
// ---------------------------------------------------------------------------

type Build = (p: Patch, o: AudioNode, t: number, r: number) => void;

interface SfxDef {
  /** base level */
  lvl: number;
  /** reverb send */
  wet: number;
  /** minimum interval between identical sounds, seconds */
  gap: number;
  build: Build;
}

function bigBoom(p: Patch, o: AudioNode, t: number, r: number): void {
  p.nh(o, t, { kind: 'pink', type: 'lowpass', f: 2100 * r, f2: 120, sweep: 1.2, q: 0.9, d: 1.35, peak: 1, drive: 2.5 });
  p.nh(o, t, { kind: 'brown', type: 'lowpass', f: 450, f2: 150, sweep: 1.3, a: 0.02, d: 1.4, peak: 0.9 });
  p.th(o, t, { f: 70 * r, f2: 25, glide: 0.9, d: 1.1, peak: 1, drive: 2 });
  p.nh(o, t, { type: 'bandpass', f: 1600, q: 1, d: 0.05, peak: 0.5 });
  p.crackle(o, t + 0.08, 0.9, 7, 2500, 0.25);
}

const SFX: Record<Sfx, SfxDef> = {
  rifle: {
    lvl: 0.55, wet: 0.1, gap: 0.045,
    build(p, o, t, r) {
      p.nh(o, t, { type: 'bandpass', f: 2600 * r, q: 0.9, d: 0.055, peak: 0.9 });
      p.nh(o, t, { type: 'highpass', f: 5000, d: 0.018, peak: 0.22 });
      p.th(o, t, { f: 170 * r, f2: 60, glide: 0.05, d: 0.06, peak: 0.55 });
    },
  },
  mg: {
    lvl: 0.47, wet: 0.08, gap: 0.04,
    build(p, o, t, r) {
      p.nh(o, t, { type: 'bandpass', f: 1800 * r, q: 1, d: 0.04, peak: 0.85 });
      p.nh(o, t, { type: 'highpass', f: 4000, d: 0.012, peak: 0.18 });
      p.th(o, t, { f: 140 * r, f2: 55, glide: 0.04, d: 0.045, peak: 0.5 });
    },
  },
  flak: {
    lvl: 0.5, wet: 0.12, gap: 0.045,
    build(p, o, t, r) {
      p.th(o, t, { f: 240 * r, f2: 75, glide: 0.08, d: 0.13, peak: 0.9, drive: 2 });
      p.nh(o, t, { type: 'bandpass', f: 1300 * r, q: 1.2, d: 0.06, peak: 0.6 });
      p.nh(o, t, { kind: 'pink', type: 'lowpass', f: 700, d: 0.16, peak: 0.45 });
    },
  },
  cannon: {
    lvl: 0.7, wet: 0.18, gap: 0.05,
    build(p, o, t, r) {
      p.th(o, t, { f: 120 * r, f2: 40, glide: 0.25, d: 0.5, peak: 1, drive: 1.5 });
      p.nh(o, t, { kind: 'pink', type: 'lowpass', f: 1200 * r, f2: 180, sweep: 0.4, d: 0.55, peak: 0.9 });
      p.nh(o, t, { type: 'bandpass', f: 1600, q: 1, d: 0.03, peak: 0.5 });
    },
  },
  cannonHeavy: {
    lvl: 0.8, wet: 0.2, gap: 0.06,
    build(p, o, t, r) {
      p.th(o, t, { f: 100 * r, f2: 30, glide: 0.45, d: 0.9, peak: 1, drive: 2.5 });
      p.th(o, t, { type: 'triangle', f: 55, f2: 28, glide: 0.6, d: 0.9, peak: 0.5 });
      p.nh(o, t, { kind: 'brown', type: 'lowpass', f: 900 * r, f2: 120, sweep: 0.8, d: 1.0, peak: 1, drive: 1.5 });
      p.nh(o, t, { kind: 'pink', type: 'lowpass', f: 2500, f2: 400, sweep: 0.25, d: 0.25, peak: 0.6 });
      p.nh(o, t, { type: 'bandpass', f: 1400, q: 1, d: 0.04, peak: 0.55 });
    },
  },
  rocket: {
    lvl: 0.65, wet: 0.15, gap: 0.05,
    build(p, o, t, r) {
      p.nh(o, t, { type: 'bandpass', f: 1100, q: 1, d: 0.04, peak: 0.6 });
      p.th(o, t, { f: 220 * r, f2: 80, glide: 0.06, d: 0.07, peak: 0.5 });
      p.nh(o, t, { type: 'bandpass', f: 600 * r, f2: 2600 * r, sweep: 0.45, q: 2.2, a: 0.04, d: 0.5, peak: 0.55 });
    },
  },
  missileLaunch: {
    lvl: 0.65, wet: 0.2, gap: 0.08,
    build(p, o, t, r) {
      p.nh(o, t, { type: 'bandpass', f: 1000, q: 1, d: 0.05, peak: 0.7 });
      p.th(o, t, { f: 200 * r, f2: 70, glide: 0.08, d: 0.1, peak: 0.6 });
      p.nh(o, t, { kind: 'pink', type: 'lowpass', f: 350, f2: 1800 * r, sweep: 1.0, q: 1.5, a: 0.1, d: 1.1, peak: 0.9, drive: 2 });
      p.nh(o, t, { type: 'bandpass', f: 500, f2: 3200 * r, sweep: 1.1, q: 2.5, a: 0.15, d: 1.0, peak: 0.4 });
      p.th(o, t, { type: 'triangle', f: 55, f2: 85, glide: 1.0, a: 0.1, d: 1.0, peak: 0.3 });
    },
  },
  laser: {
    lvl: 0.45, wet: 0.22, gap: 0.05,
    build(p, o, t, r) {
      const lp = p.filter('lowpass', 3200, 1.2);
      lp.connect(o);
      p.th(lp, t, { type: 'sawtooth', f: 2500 * r, f2: 280, glide: 0.2, a: 0.003, d: 0.28, peak: 0.2 });
      p.th(lp, t, { type: 'sine', f: 2500 * r, f2: 280, glide: 0.2, a: 0.003, d: 0.3, peak: 0.32, detune: 14 });
      p.th(lp, t, { type: 'sine', f: 1250 * r, f2: 140, glide: 0.22, a: 0.003, d: 0.25, peak: 0.18, detune: -9 });
    },
  },
  artillery: {
    lvl: 0.75, wet: 0.3, gap: 0.06,
    build(p, o, t, r) {
      const lp = p.filter('lowpass', 420 * r, 0.7);
      lp.connect(o);
      p.th(lp, t, { f: 75 * r, f2: 30, glide: 0.6, d: 1.0, peak: 1, drive: 1.5 });
      p.nh(lp, t, { kind: 'brown', type: 'lowpass', f: 600, f2: 120, sweep: 0.9, a: 0.01, d: 1.1, peak: 1 });
      p.nh(lp, t, { kind: 'pink', type: 'lowpass', f: 1500, f2: 300, sweep: 0.3, d: 0.3, peak: 0.45 });
    },
  },
  thermo: {
    lvl: 0.6, wet: 0.2, gap: 0.08,
    build(p, o, t, r) {
      for (let i = 0; i < 4; i++) {
        const ti = t + i * 0.075 + Math.random() * 0.015;
        p.th(o, ti, { f: 160 * r, f2: 50, glide: 0.09, d: 0.12, peak: 0.8 });
        p.nh(o, ti, { type: 'bandpass', f: 900 + i * 60, q: 1, d: 0.05, peak: 0.5 });
      }
      p.nh(o, t, { type: 'bandpass', f: 700, f2: 2400, sweep: 0.5, q: 1.8, a: 0.05, d: 0.55, peak: 0.35 });
    },
  },
  explosionSmall: {
    lvl: 0.6, wet: 0.18, gap: 0.045,
    build(p, o, t, r) {
      p.nh(o, t, { kind: 'pink', type: 'lowpass', f: 2600 * r, f2: 280, sweep: 0.35, d: 0.4, peak: 0.9 });
      p.th(o, t, { f: 95 * r, f2: 35, glide: 0.25, d: 0.3, peak: 0.7 });
      p.nh(o, t, { type: 'bandpass', f: 1900, q: 1, d: 0.035, peak: 0.4 });
    },
  },
  explosionMedium: {
    lvl: 0.75, wet: 0.22, gap: 0.05,
    build(p, o, t, r) {
      p.nh(o, t, { kind: 'pink', type: 'lowpass', f: 2300 * r, f2: 190, sweep: 0.7, d: 0.8, peak: 1, drive: 1.5 });
      p.nh(o, t, { kind: 'brown', type: 'lowpass', f: 500, a: 0.01, d: 1.0, peak: 0.7 });
      p.th(o, t, { f: 80 * r, f2: 30, glide: 0.5, d: 0.65, peak: 0.9, drive: 1.5 });
      p.nh(o, t, { type: 'bandpass', f: 1700, q: 1, d: 0.04, peak: 0.45 });
    },
  },
  explosionLarge: {
    lvl: 0.9, wet: 0.28, gap: 0.06,
    build: bigBoom,
  },
  buildingCollapse: {
    lvl: 0.95, wet: 0.3, gap: 0.2,
    build(p, o, t, r) {
      bigBoom(p, o, t, r);
      // rumbling debris
      const src = p.noise('brown', t, t + 2.6);
      const lp = p.filter('lowpass', 260, 1);
      glide(lp.frequency, t, 300, 140, 2.4);
      const g = p.gain(0);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.85, t + 0.35);
      g.gain.setValueAtTime(0.85, t + 1.3);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.5);
      src.connect(lp);
      lp.connect(g);
      g.connect(o);
      p.crackle(o, t + 0.3, 2.0, 14, 3000, 0.2);
      for (let i = 0; i < 4; i++) {
        const ti = t + 0.4 + Math.random() * 1.6;
        p.th(o, ti, { f: 75 + Math.random() * 20, f2: 35, glide: 0.12, d: 0.15, peak: 0.4 + Math.random() * 0.2 });
      }
    },
  },
  intercept: {
    lvl: 0.6, wet: 0.15, gap: 0.05,
    build(p, o, t, r) {
      p.th(o, t, { f: 3150 * r, a: 0.001, d: 0.11, peak: 0.2 });
      p.th(o, t, { f: 4630 * r, a: 0.001, d: 0.08, peak: 0.1 });
      p.th(o, t, { type: 'triangle', f: 2120 * r, a: 0.001, d: 0.14, peak: 0.15 });
      p.nh(o, t + 0.015, { type: 'bandpass', f: 1400, q: 1, d: 0.05, peak: 0.5 });
      p.th(o, t + 0.015, { f: 300, f2: 110, glide: 0.05, d: 0.07, peak: 0.45 });
    },
  },
  droneLaunch: {
    lvl: 0.5, wet: 0.15, gap: 0.1,
    build(p, o, t, r) {
      const end = t + 1.05;
      const bp = p.filter('bandpass', 700, 1.4);
      glide(bp.frequency, t, 700, 1500, 0.8);
      const trem = p.gain(0.65);
      const lfo = p.osc('sine', 26, t, end);
      const depth = p.gain(0.3);
      lfo.connect(depth);
      depth.connect(trem.gain);
      const e = p.gain(0);
      e.gain.setValueAtTime(0, t);
      e.gain.linearRampToValueAtTime(0.5, t + 0.12);
      e.gain.linearRampToValueAtTime(0.45, t + 0.75);
      e.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
      for (const det of [0, 12]) {
        const s = p.osc('sawtooth', 180 * r, t, end);
        s.detune.value = det;
        glide(s.frequency, t, 180 * r, 420 * r, 0.8);
        s.connect(bp);
      }
      bp.connect(trem);
      trem.connect(e);
      e.connect(o);
      p.nh(o, t, { type: 'bandpass', f: 1500, f2: 3000, q: 1.5, a: 0.1, d: 0.6, peak: 0.12 });
    },
  },
  droneBuzz: {
    lvl: 0.35, wet: 0.08, gap: 0.08,
    build(p, o, t, r) {
      const end = t + 0.3;
      const bp = p.filter('bandpass', 1100, 1.2);
      const trem = p.gain(0.65);
      const lfo = p.osc('sine', 32, t, end);
      const depth = p.gain(0.35);
      lfo.connect(depth);
      depth.connect(trem.gain);
      const e = p.gain(0);
      env(e.gain, t, 0.45, 0.03, 0.05, 0.17);
      p.osc('sawtooth', 250 * r, t, end).connect(bp);
      p.osc('sawtooth', 253 * r, t, end).connect(bp);
      bp.connect(trem);
      trem.connect(e);
      e.connect(o);
    },
  },
  jam: {
    lvl: 0.4, wet: 0.08, gap: 0.08,
    build(p, o, t) {
      const dur = 0.4;
      const end = t + dur + 0.05;
      const sq = p.osc('square', 600, t, end);
      const sg = p.gain(0);
      const noise = p.noise('white', t, end);
      const nbp = p.filter('bandpass', 2800, 0.6);
      const ng = p.gain(0);
      const steps = 18;
      for (let i = 0; i < steps; i++) {
        const ti = t + i * (dur / steps);
        sq.frequency.setValueAtTime(200 + Math.random() * 1800, ti);
        sg.gain.setValueAtTime(Math.random() < 0.7 ? 0.25 + Math.random() * 0.25 : 0, ti);
        ng.gain.setValueAtTime(Math.random() < 0.6 ? 0.4 + Math.random() * 0.6 : 0.05, ti);
      }
      sg.gain.setValueAtTime(0, t + dur);
      ng.gain.setValueAtTime(0, t + dur);
      sq.connect(sg);
      noise.connect(nbp);
      nbp.connect(ng);
      const crush = p.crusher();
      const hp = p.filter('highpass', 350, 0.7);
      const lp = p.filter('lowpass', 4500, 0.7);
      const e = p.gain(0);
      env(e.gain, t, 0.45, 0.005, dur - 0.06, 0.05);
      sg.connect(crush);
      ng.connect(crush);
      crush.connect(hp);
      hp.connect(lp);
      lp.connect(e);
      e.connect(o);
    },
  },
  click: {
    lvl: 0.55, wet: 0, gap: 0.03,
    build(p, o, t, r) {
      p.th(o, t, { type: 'triangle', f: 1500 * r, f2: 1100, glide: 0.012, a: 0.001, d: 0.025, peak: 0.35 });
      p.nh(o, t, { type: 'highpass', f: 4000, d: 0.008, peak: 0.12 });
    },
  },
  tab: {
    lvl: 0.55, wet: 0, gap: 0.03,
    build(p, o, t, r) {
      p.th(o, t, { type: 'triangle', f: 950 * r, f2: 750, glide: 0.02, a: 0.001, d: 0.04, peak: 0.35 });
      p.nh(o, t, { type: 'bandpass', f: 2400, q: 2, d: 0.01, peak: 0.15 });
    },
  },
  build: {
    lvl: 0.6, wet: 0.05, gap: 0.05,
    build(p, o, t) {
      [660, 990].forEach((f, i) => {
        const ti = t + i * 0.085;
        p.th(o, ti, { type: 'square', f, lp: 2400, a: 0.004, hold: 0.03, d: 0.1, peak: 0.13 });
        p.th(o, ti, { type: 'triangle', f, a: 0.004, hold: 0.03, d: 0.12, peak: 0.22 });
      });
    },
  },
  place: {
    lvl: 0.6, wet: 0.08, gap: 0.06,
    build(p, o, t, r) {
      p.th(o, t, { f: 120 * r, f2: 45, glide: 0.12, d: 0.18, peak: 0.9 });
      p.nh(o, t, { kind: 'pink', type: 'lowpass', f: 500, d: 0.1, peak: 0.5 });
      const tc = t + 0.055;
      p.nh(o, tc, { type: 'bandpass', f: 2300 * r, q: 7, d: 0.07, peak: 0.6 });
      p.th(o, tc, { type: 'square', f: 330 * r, lp: 1500, d: 0.06, peak: 0.12 });
      p.th(o, tc, { type: 'square', f: 517 * r, lp: 1800, d: 0.05, peak: 0.09 });
    },
  },
  sell: {
    lvl: 0.6, wet: 0.05, gap: 0.08,
    build(p, o, t) {
      [1318, 1046, 880, 659].forEach((f, i) => {
        const ti = t + i * 0.06;
        p.th(o, ti, { type: 'square', f, lp: 3000, a: 0.002, hold: 0.015, d: 0.04, peak: 0.12 });
        p.th(o, ti, { type: 'triangle', f, a: 0.002, hold: 0.015, d: 0.06, peak: 0.18 });
      });
      p.nh(o, t + 0.25, { type: 'bandpass', f: 5000, q: 3, d: 0.08, peak: 0.15 });
      p.th(o, t + 0.25, { f: 2637, d: 0.25, peak: 0.07 });
    },
  },
  error: {
    lvl: 0.5, wet: 0, gap: 0.12,
    build(p, o, t) {
      for (let i = 0; i < 2; i++) {
        const ti = t + i * 0.15;
        p.th(o, ti, { type: 'square', f: 170, lp: 1100, a: 0.005, hold: 0.09, d: 0.025, peak: 0.25 });
        p.th(o, ti, { type: 'sawtooth', f: 171.5, lp: 900, a: 0.005, hold: 0.09, d: 0.025, peak: 0.12 });
      }
    },
  },
  select: {
    lvl: 0.6, wet: 0, gap: 0.04,
    build(p, o, t, r) {
      p.th(o, t, { f: 950 * r, f2: 1500 * r, glide: 0.045, a: 0.004, d: 0.06, peak: 0.3 });
      p.th(o, t, { type: 'triangle', f: 475 * r, f2: 750 * r, glide: 0.045, a: 0.004, d: 0.05, peak: 0.1 });
    },
  },
  ack: {
    lvl: 0.6, wet: 0.03, gap: 0.06,
    build(p, o, t, r) {
      const hp = p.filter('highpass', 450, 0.7);
      const sh = p.shaper(3);
      const lp = p.filter('lowpass', 3200, 0.7);
      const pre = p.gain(0.6);
      pre.connect(hp);
      hp.connect(sh);
      sh.connect(lp);
      lp.connect(o);
      p.nh(pre, t, { type: 'bandpass', f: 2200, q: 0.7, d: 0.05, peak: 0.35 });
      p.th(pre, t, { type: 'square', f: 1250 * r, f2: 1700 * r, glide: 0.04, a: 0.003, hold: 0.03, d: 0.02, peak: 0.12 });
      p.th(pre, t + 0.075, { type: 'square', f: 1550 * r, f2: 2050 * r, glide: 0.04, a: 0.003, hold: 0.03, d: 0.02, peak: 0.12 });
      p.nh(pre, t + 0.13, { type: 'bandpass', f: 2000, q: 0.7, d: 0.06, peak: 0.25 });
    },
  },
  alarm: {
    lvl: 0.5, wet: 0.08, gap: 0.9,
    build(p, o, t) {
      const end = t + 1.1;
      const lp = p.filter('lowpass', 2000, 1);
      const sh = p.shaper(1.5);
      const e = p.gain(0);
      e.gain.setValueAtTime(0, t);
      e.gain.linearRampToValueAtTime(0.3, t + 0.02);
      e.gain.setValueAtTime(0.3, t + 0.95);
      e.gain.exponentialRampToValueAtTime(0.0001, t + 1.05);
      const lfo = p.osc('sine', 7, t, end);
      const vib = p.gain(15);
      lfo.connect(vib);
      const freqs = [620, 465, 620, 465];
      for (const [type, mul, lvl] of [['sawtooth', 1, 1], ['square', 0.5, 0.5]] as const) {
        const s = p.osc(type, freqs[0] * mul, t, end);
        freqs.forEach((f, i) => {
          const ti = t + i * 0.25;
          s.frequency.setValueAtTime((i === 0 ? f : freqs[i - 1]) * mul, ti);
          s.frequency.linearRampToValueAtTime(f * mul, ti + 0.02);
        });
        vib.connect(s.detune);
        const g = p.gain(lvl);
        s.connect(g);
        g.connect(sh);
      }
      sh.connect(lp);
      lp.connect(e);
      e.connect(o);
    },
  },
  money: {
    lvl: 0.6, wet: 0.04, gap: 0.05,
    build(p, o, t) {
      p.th(o, t, { type: 'square', f: 988, lp: 4000, a: 0.002, hold: 0.05, d: 0.02, peak: 0.13 });
      p.th(o, t, { type: 'triangle', f: 988, a: 0.002, hold: 0.05, d: 0.02, peak: 0.15 });
      p.th(o, t + 0.06, { type: 'square', f: 1319, lp: 4000, a: 0.002, d: 0.2, peak: 0.13 });
      p.th(o, t + 0.06, { type: 'triangle', f: 1319, a: 0.002, d: 0.22, peak: 0.15 });
    },
  },
  deploy: {
    lvl: 0.5, wet: 0.1, gap: 0.1,
    build(p, o, t, r) {
      p.nh(o, t, { type: 'bandpass', f: 3500 * r, f2: 2000, sweep: 0.45, q: 0.8, a: 0.04, hold: 0.25, d: 0.2, peak: 0.3 });
      p.th(o, t, { type: 'sawtooth', f: 90, f2: 70, glide: 0.4, lp: 400, a: 0.05, hold: 0.3, d: 0.1, peak: 0.15 });
      const tc = t + 0.5;
      p.th(o, tc, { f: 150 * r, f2: 55, glide: 0.1, d: 0.14, peak: 0.9 });
      p.nh(o, tc, { type: 'bandpass', f: 1000, q: 3, d: 0.06, peak: 0.45 });
      p.th(o, tc, { type: 'square', f: 280 * r, lp: 1400, d: 0.05, peak: 0.1 });
    },
  },
  repair: {
    lvl: 0.65, wet: 0.05, gap: 0.1,
    build(p, o, t, r) {
      const n = 7;
      const times: number[] = [];
      const pk: number[] = [];
      const pk2: number[] = [];
      for (let i = 0; i < n; i++) {
        times.push(t + i * 0.045);
        pk.push(i % 2 ? 0.5 : 0.8);
        pk2.push(i % 2 ? 0.06 : 0.12);
      }
      const end = t + n * 0.045 + 0.1;
      const src = p.noise('white', t, end);
      const bp = p.filter('bandpass', 3600 * r, 4);
      const g = p.gain(0);
      spikes(g.gain, times, pk, 0.006);
      src.connect(bp);
      bp.connect(g);
      g.connect(o);
      const tri = p.osc('triangle', 2700 * r, t, end);
      const g2 = p.gain(0);
      spikes(g2.gain, times, pk2, 0.01);
      tri.connect(g2);
      g2.connect(o);
      const tc = t + 0.34;
      p.th(o, tc, { type: 'square', f: 600 * r, lp: 2000, d: 0.06, peak: 0.08 });
      p.nh(o, tc, { type: 'bandpass', f: 2000, q: 5, d: 0.05, peak: 0.4 });
    },
  },
};

/** Radio blip + squelch played before announcer lines. */
const radioBlip: Build = (p, o, t) => {
  const hp = p.filter('highpass', 500, 0.7);
  const lp = p.filter('lowpass', 3000, 0.7);
  const sh = p.shaper(2.5);
  hp.connect(sh);
  sh.connect(lp);
  lp.connect(o);
  p.th(hp, t, { f: 1350, a: 0.002, hold: 0.035, d: 0.02, peak: 0.25 });
  p.nh(hp, t + 0.06, { type: 'bandpass', f: 1800, q: 0.6, a: 0.005, d: 0.11, peak: 0.12 });
};

// ---------------------------------------------------------------------------
// AudioSystem
// ---------------------------------------------------------------------------

interface VoiceRec {
  patch: Patch;
  out: GainNode;
  level: number;
  start: number;
  end: number;
}

/** The mixing graph, independent of the context type so it can be rendered offline. */
export interface MixGraph {
  bank: Bank;
  sfxBus: GainNode;
  sfxGain: GainNode;
  sfxWetBus: GainNode;
  sfxWetGain: GainNode;
  /** start/stop fades of the music (0 or MUSIC_LEVEL) */
  musicPlay: GainNode;
  /** dips the music under announcer lines */
  musicDuck: GainNode;
  /** user music volume */
  musicGain: GainNode;
  master: GainNode;
  music: MusicEngine;
}

interface Graph extends MixGraph {
  ctx: AudioContext;
}

/** Builds buses, reverb, compressor and the music engine on any (also offline) context. */
export function buildAudioGraph(ctx: BaseAudioContext, sfxVol: number, musicVol: number): MixGraph {
  const bank = new Bank(ctx);

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 12;
  comp.ratio.value = 4;
  comp.attack.value = 0.004;
  comp.release.value = 0.2;
  const master = ctx.createGain();
  master.gain.value = 0.9;
  comp.connect(master);
  master.connect(ctx.destination);

  const reverb = ctx.createConvolver();
  reverb.buffer = makeImpulse(ctx, 1.4);
  const revOut = ctx.createGain();
  revOut.gain.value = 0.55;
  reverb.connect(revOut);
  revOut.connect(comp);

  const sfxBus = ctx.createGain();
  const sfxGain = ctx.createGain();
  sfxGain.gain.value = sfxVol;
  sfxBus.connect(sfxGain);
  sfxGain.connect(comp);
  const sfxWetBus = ctx.createGain();
  const sfxWetGain = ctx.createGain();
  sfxWetGain.gain.value = sfxVol;
  sfxWetBus.connect(sfxWetGain);
  sfxWetGain.connect(reverb);

  const musicGain = ctx.createGain();
  musicGain.gain.value = musicVol;
  musicGain.connect(comp);
  const musicWet = ctx.createGain();
  musicWet.gain.value = 0.26;
  musicGain.connect(musicWet);
  musicWet.connect(reverb);
  const musicDuck = ctx.createGain();
  musicDuck.connect(musicGain);
  const musicPlay = ctx.createGain();
  musicPlay.gain.value = 0;
  musicPlay.connect(musicDuck);

  const music = new MusicEngine(ctx, bank, musicPlay);
  return { bank, sfxBus, sfxGain, sfxWetBus, sfxWetGain, musicPlay, musicDuck, musicGain, master, music };
}

/** announcer lines that tell the score something about the battle */
const SAY_CUES: Record<string, { floor: number; hold: number; sting?: StingerKind }> = {
  'Our base is under attack': { floor: 0.55, hold: 12, sting: 'dread' },
  'Unit under attack': { floor: 0.35, hold: 8 },
  'Structure lost': { floor: 0.6, hold: 12, sting: 'dread' },
  'Ore harvester lost': { floor: 0.4, hold: 8 },
  'Mission failed': { floor: 0, hold: 0, sting: 'dread' },
};

export class AudioSystem {
  private g: Graph | null = null;
  private failed = false;
  private gestured = false;
  private voices: VoiceRec[] = [];
  private lastPlay = new Map<Sfx, number>();
  private sfxVol = 0.8;
  private musicVol = 0.35;
  private voiceOn = true;
  private musicWanted = false;
  private musicMode: MusicMode = 'battle';
  private heat = new CombatHeat();
  private intensityOverride: number | null = null;

  // speech
  private speechQueue: string[] = [];
  private speaking = false;
  private lastSaid = new Map<string, number>();
  private voice: SpeechSynthesisVoice | null = null;
  private voicesHooked = false;

  constructor() {
    // Intentionally does nothing that touches browser globals.
  }

  get unlocked(): boolean {
    return this.g !== null && this.g.ctx.state === 'running';
  }

  /** Smoothed combat intensity 0..1 currently driving the battle music. */
  get musicIntensity(): number {
    if (this.intensityOverride !== null) return this.intensityOverride;
    const g = this.g;
    return g ? this.heat.update(g.ctx.currentTime) : this.heat.value;
  }

  unlock(): void {
    if (typeof window === 'undefined') return;
    this.gestured = true;
    this.hookVoices();
    if (!this.g && !this.failed) {
      try {
        this.g = this.createGraph();
      } catch {
        this.failed = true;
        this.g = null;
      }
    }
    const g = this.g;
    if (!g) return;
    if (g.ctx.state !== 'running') {
      try {
        g.ctx
          .resume()
          .then(() => this.afterResume())
          .catch(() => undefined);
      } catch {
        /* ignore */
      }
    } else {
      this.afterResume();
    }
  }

  private afterResume(): void {
    const g = this.g;
    if (!g || g.ctx.state !== 'running') return;
    if (this.musicWanted && !g.music.running) this.musicOn(g);
  }

  private createGraph(): Graph | null {
    const w = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const AC = w.AudioContext ?? w.webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC({ latencyHint: 'interactive' });
    const mix = buildAudioGraph(ctx, this.sfxVol, this.musicVol);

    // iOS: play a silent buffer inside the gesture
    try {
      const s = ctx.createBufferSource();
      s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      s.connect(ctx.destination);
      s.start(0);
      s.onended = () => s.disconnect();
    } catch {
      /* ignore */
    }

    mix.music.setMode(this.musicMode);
    mix.music.setIntensitySource(() => this.musicIntensity);
    ctx.onstatechange = () => this.afterResume();
    return { ...mix, ctx };
  }

  setSfxVolume(v: number): void {
    this.sfxVol = clamp(Number.isFinite(v) ? v : 0, 0, 1);
    const g = this.g;
    if (!g) return;
    const now = g.ctx.currentTime;
    g.sfxGain.gain.setTargetAtTime(this.sfxVol, now, 0.03);
    g.sfxWetGain.gain.setTargetAtTime(this.sfxVol, now, 0.03);
  }

  setMusicVolume(v: number): void {
    this.musicVol = clamp(Number.isFinite(v) ? v : 0, 0, 1);
    const g = this.g;
    if (!g) return;
    g.musicGain.gain.setTargetAtTime(this.musicVol, g.ctx.currentTime, 0.05);
  }

  setVoiceEnabled(on: boolean): void {
    this.voiceOn = on;
    if (!on) {
      this.speechQueue.length = 0;
      const synth = this.synth();
      if (synth && this.speaking) {
        try {
          synth.cancel();
        } catch {
          /* ignore */
        }
      }
      this.speaking = false;
    }
  }

  play(name: Sfx, volume = 1, pan = 0): void {
    const g = this.g;
    if (!g || g.ctx.state !== 'running') return;
    const def = SFX[name];
    if (!def) return;
    const vol = clamp(Number.isFinite(volume) ? volume : 0, 0, 1);
    const now = g.ctx.currentTime;
    // the score listens to the battle even when effects are muted
    this.feedMusic(g, name, vol, now);
    const level = vol * def.lvl;
    if (level < 0.005 || this.sfxVol <= 0) return;
    const last = this.lastPlay.get(name);
    if (last !== undefined && now - last < def.gap && now >= last) return;

    this.reap(now);
    if (this.voices.length >= MAX_VOICES) {
      let victim = -1;
      let best = Infinity;
      for (let i = 0; i < this.voices.length; i++) {
        const v = this.voices[i];
        const life = Math.max(0.001, v.end - v.start);
        const remaining = clamp((v.end - now) / life, 0, 1);
        const score = v.level * (0.25 + remaining);
        if (score < best) {
          best = score;
          victim = i;
        }
      }
      // A newcomer quieter than everything already playing is dropped instead.
      if (victim < 0 || level * 1.25 < best) return;
      this.steal(victim, now);
    }
    this.lastPlay.set(name, now);
    this.spawn(g, def.build, level, Number.isFinite(pan) ? pan : 0, def.wet);
  }

  private spawn(g: Graph, build: Build, level: number, pan: number, wet: number): void {
    const ctx = g.ctx;
    const t = ctx.currentTime + 0.005;
    const p = new Patch(ctx, g.bank);
    const out = p.gain(level);
    let tail: AudioNode = out;
    if (pan !== 0 && typeof ctx.createStereoPanner === 'function') {
      const sp = p.add(ctx.createStereoPanner());
      sp.pan.value = clamp(pan, -1, 1);
      out.connect(sp);
      tail = sp;
    }
    tail.connect(g.sfxBus);
    if (wet > 0) {
      const w = p.gain(wet);
      tail.connect(w);
      w.connect(g.sfxWetBus);
    }
    build(p, out, t, 1 + (Math.random() - 0.5) * 0.08);
    const rec: VoiceRec = { patch: p, out, level, start: t, end: p.end };
    p.onDone = () => {
      const i = this.voices.indexOf(rec);
      if (i >= 0) this.voices.splice(i, 1);
    };
    this.voices.push(rec);
    p.finish();
  }

  /** Drop bookkeeping for voices whose onended never fired. */
  private reap(now: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.end < now - 0.5) {
        this.voices.splice(i, 1);
        v.patch.onDone = null;
        v.patch.dispose();
      }
    }
  }

  private steal(i: number, now: number): void {
    const v = this.voices[i];
    this.voices.splice(i, 1);
    v.patch.onDone = null;
    const gp = v.out.gain;
    try {
      gp.cancelScheduledValues(now);
      gp.setValueAtTime(gp.value, now);
      gp.linearRampToValueAtTime(0, now + 0.03);
    } catch {
      /* ignore */
    }
    v.patch.kill(now + 0.04);
  }

  /** Combat intensity + stingers from the effects that are being played. */
  private feedMusic(g: Graph, name: Sfx, vol: number, now: number): void {
    if (this.musicMode !== 'battle') return;
    this.heat.hit(name, vol, now);
    if (name === 'alarm') this.heat.raiseFloor(0.45, 10, now);
    if (!g.music.running) return;
    // a ballistic / hypersonic launch on screen reaches volume 1, SAMs stay at 0.75
    if ((name === 'missileLaunch' && vol >= 0.85) || (name === 'explosionLarge' && vol >= 0.92)) g.music.stinger('heavy');
    else if (name === 'buildingCollapse' && vol >= 0.3) g.music.stinger('dread');
  }

  private cueMusic(text: string): void {
    const g = this.g;
    if (!g || this.musicMode !== 'battle') return;
    const now = g.ctx.currentTime;
    if (text === 'Mission accomplished') {
      this.heat.reset(now);
      return;
    }
    const cue = SAY_CUES[text];
    if (!cue) return;
    if (cue.floor > 0) this.heat.raiseFloor(cue.floor, cue.hold, now);
    if (cue.sting && g.music.running && g.ctx.state === 'running') g.music.stinger(cue.sting);
    if (text === 'Mission failed') this.heat.reset(now);
  }

  private duck(on: boolean): void {
    const g = this.g;
    if (!g) return;
    try {
      g.musicDuck.gain.setTargetAtTime(on ? 0.6 : 1, g.ctx.currentTime, on ? 0.08 : 0.5);
    } catch {
      /* ignore */
    }
  }

  // --- announcer ------------------------------------------------------------

  private synth(): SpeechSynthesis | null {
    if (typeof window === 'undefined') return null;
    try {
      if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') return null;
      return window.speechSynthesis ?? null;
    } catch {
      return null;
    }
  }

  private hookVoices(): void {
    if (this.voicesHooked) return;
    const synth = this.synth();
    if (!synth) return;
    this.voicesHooked = true;
    try {
      synth.addEventListener('voiceschanged', () => {
        this.voice = null;
      });
      synth.getVoices();
    } catch {
      /* ignore */
    }
  }

  private pickVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
    if (this.voice) return this.voice;
    let voices: SpeechSynthesisVoice[] = [];
    try {
      voices = synth.getVoices();
    } catch {
      return null;
    }
    if (!voices.length) return null;
    const en = voices.filter((v) => /^en([-_]|$)/i.test(v.lang));
    const prefs = [
      'samantha', 'google uk english female', 'zira', 'female', 'serena', 'karen', 'moira',
      'tessa', 'fiona', 'victoria', 'susan', 'hazel', 'libby', 'sonia', 'aria', 'jenny',
    ];
    let pick: SpeechSynthesisVoice | null = null;
    for (const pref of prefs) {
      const v = en.find((x) => x.name.toLowerCase().includes(pref));
      if (v) {
        pick = v;
        break;
      }
    }
    pick = pick ?? en.find((v) => /^en[-_]us/i.test(v.lang)) ?? en[0] ?? null;
    this.voice = pick;
    return pick;
  }

  say(text: string): void {
    if (typeof text === 'string') this.cueMusic(text);
    if (!this.voiceOn || !this.gestured || typeof text !== 'string' || !text.trim()) return;
    const now = Date.now();
    const last = this.lastSaid.get(text);
    if (last !== undefined && now - last < 4000) return;
    this.lastSaid.set(text, now);
    if (this.lastSaid.size > 64) {
      for (const [k, v] of this.lastSaid) if (now - v > 4000) this.lastSaid.delete(k);
    }
    if (!this.synth()) {
      this.blip();
      return;
    }
    if (this.speechQueue.includes(text)) return;
    this.speechQueue.push(text);
    while (this.speechQueue.length > 2) this.speechQueue.shift();
    if (!this.speaking) this.speakNext();
  }

  private blip(): void {
    const g = this.g;
    if (!g || g.ctx.state !== 'running' || this.sfxVol <= 0) return;
    this.spawn(g, radioBlip, 0.55, 0, 0.05);
  }

  private speakNext(): void {
    const synth = this.synth();
    const text = this.speechQueue.shift();
    if (!synth || text === undefined || !this.voiceOn) {
      this.speaking = false;
      this.duck(false);
      return;
    }
    this.speaking = true;
    this.duck(true);
    this.blip();
    let done = false;
    let watchdog = 0;
    const finish = (stuck: boolean) => {
      if (done) return;
      done = true;
      window.clearTimeout(watchdog);
      if (stuck) {
        try {
          synth.cancel();
        } catch {
          /* ignore */
        }
      }
      this.speaking = false;
      window.setTimeout(() => {
        if (!this.speaking) this.speakNext();
        if (!this.speaking) this.duck(false);
      }, 60);
    };
    try {
      const u = new SpeechSynthesisUtterance(text);
      const v = this.pickVoice(synth);
      if (v) u.voice = v;
      u.lang = v?.lang ?? 'en-US';
      u.rate = 1.0;
      u.pitch = 0.9;
      u.volume = clamp(this.sfxVol * 1.25, 0, 1);
      u.onend = () => finish(false);
      u.onerror = () => finish(false);
      watchdog = window.setTimeout(() => finish(true), 2500 + text.length * 110);
      window.setTimeout(() => {
        if (done) return;
        try {
          synth.speak(u);
        } catch {
          finish(false);
        }
      }, 120);
    } catch {
      finish(false);
    }
  }

  // --- music ----------------------------------------------------------------

  private musicOn(g: Graph): void {
    const now = g.ctx.currentTime;
    g.music.setMode(this.musicMode);
    g.music.start();
    const pg = g.musicPlay.gain;
    pg.cancelScheduledValues(now);
    pg.setValueAtTime(pg.value, now);
    pg.linearRampToValueAtTime(MUSIC_LEVEL, now + 0.05);
  }

  startMusic(): void {
    this.musicWanted = true;
    const g = this.g;
    if (this.musicMode === 'battle') this.heat.reset(g ? g.ctx.currentTime : undefined);
    if (!g || g.ctx.state !== 'running') return;
    this.musicOn(g);
  }

  stopMusic(): void {
    this.musicWanted = false;
    const g = this.g;
    if (!g) return;
    g.music.stop();
    const now = g.ctx.currentTime;
    const pg = g.musicPlay.gain;
    pg.cancelScheduledValues(now);
    pg.setValueAtTime(pg.value, now);
    pg.setTargetAtTime(0, now, 0.12);
  }

  setMusicMode(mode: 'menu' | 'battle'): void {
    if (mode !== 'menu' && mode !== 'battle') return;
    // every battle starts from calm
    if (mode === 'battle' && this.musicMode !== 'battle') this.heat.reset(this.g ? this.g.ctx.currentTime : undefined);
    this.musicMode = mode;
    if (this.g) this.g.music.setMode(mode);
  }

  /**
   * Optional: drive the battle music's combat intensity (0..1) directly.
   * Pass null to return to the automatic estimate derived from the effects.
   */
  setMusicIntensity(x: number | null): void {
    this.intensityOverride = x === null || !Number.isFinite(x) ? null : clamp(x, 0, 1);
  }
}
