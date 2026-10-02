/**
 * Adaptive horror / tension score, synthesized note by note with the
 * lookahead scheduler pattern (a 25 ms timer schedules every event that falls
 * inside the next 120 ms of audio time).
 *
 * MENU  - free-floating dread at 50-66 BPM (the "heartbeat" tempo creeps up
 *         phrase by phrase, then drops out): D pedal drones with a slowly
 *         sliding dissonant upper voice, wind, an accelerating heartbeat,
 *         detuned piano / funeral-bell notes on minor 2nds and tritones, bowed
 *         metal scrapes, reversed swells, radio static with morse blips and
 *         clusters that crescendo and are cut off without resolving.
 *
 * BATTLE - 112 BPM in D phrygian / diminished colours, four layers whose gains
 *         crossfade on bar boundaries according to a combat intensity 0..1:
 *           bed    (always)   drone + dark cluster pad following the harmony
 *           calm   (0..0.3)   ticking clock, heartbeat thumps, sparse stabs,
 *                             creeping unresolved crescendos
 *           alert  (0.3..0.7) 3+3+3+3+4 low string ostinato, taiko, endless
 *                             Shepard-tone riser, dissonant brass swells
 *           combat (0.7..1)   full percussion, distorted sub pulses, high
 *                             string tremolo, alarm-like tritone horn calls
 *         plus stingers (rate limited) for big moments.
 *
 * Pitch reference (MIDI): D1 = 26, D2 = 38, D3 = 50, D4 = 62, D5 = 74.
 */
import { Bank, Patch, clamp, env, glide, midiHz, rng32 } from './core';
import { makeDrumKit, makeShepard, type DrumKit } from './samples';

export type MusicMode = 'menu' | 'battle';
export type StingerKind = 'heavy' | 'dread';

const LOOKAHEAD = 0.12;
const TICK_MS = 25;
/** internal music mix level (before the user music volume) */
export const MUSIC_LEVEL = 0.5;

const BATTLE_BPM = 112;
/** menu tempo per 4-bar phrase: the heartbeat slowly speeds up, then resets */
const MENU_BPM = [50, 52, 55, 58, 62, 66];
/** menu drone upper voice per phrase, [from, to] semitones above D2 (slides) */
const MENU_UPPER: [number, number][] = [[1, 0], [6, 6], [1, 1], [-2, -1], [6, 5], [13, 12]];

/** battle chord roots per bar (semitones above D), two alternating 8-bar phrases */
const ROOTS: number[][] = [
  [0, 0, 1, 1, 0, 0, -4, 6], // Dm  Dm  Eb  Eb  Dm  Dm  Bb  G#
  [0, 0, 3, 1, 0, 0, 6, 1], //  Dm  Dm  F   Eb  Dm  Dm  G#  Eb
];
/** dark cluster voicing above the root (minor third + minor ninth) */
const PAD_VOICING = [0, 3, 13];

type Pattern = (number | null)[];
/** low ostinato, semitones above the chord root, one entry per 16th */
const OST_A: Pattern = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0];
const OST_B: Pattern = [0, 0, 12, 0, 0, 0, 12, 0, 0, 0, 12, 0, 1, 0, 13, 1];
const OST_C: Pattern = [0, 0, 1, 0, 0, 6, 0, 0, 1, 0, 0, 6, 0, 1, 0, 12];
/** 3+3+3+3+4 accent grouping against the 4/4 drums */
const ACCENT = [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0];
const TAIKO_ALERT = [1, 0, 0, 0.5, 0, 0, 0.6, 0, 0.9, 0, 0, 0.5, 0, 0, 0.35, 0];
const TAIKO_COMBAT = [1, 0, 0.4, 0.6, 0, 0.4, 0.7, 0, 1, 0, 0.45, 0.6, 0, 0.5, 0.6, 0.4];

/** menu piano: single notes and dyads built from minor 2nds and tritones around D */
const PIANO_NOTES = [62, 63, 68, 69, 74, 75, 56, 50, 80];
const PIANO_DYADS: [number, number][] = [[62, 63], [62, 68], [74, 75], [69, 75], [56, 62], [63, 69]];

const enum L {
  Bed = 0,
  Calm = 1,
  Alert = 2,
  Combat = 3,
}
/** layer gains per level (0 calm, 1 alert, 2 combat) */
const LAYER_MIX: number[][] = [
  [1, 1, 0, 0],
  [1, 0.5, 1, 0],
  [1, 0, 1, 1],
];

/** Shepard riser: SHEP_OCT octave-spaced voices, each rising one octave per loop of 2 bars */
const SHEP_OCT = 4;
const SHEP_BASE = 110;
const SHEP_LOOP = (60 / BATTLE_BPM) * 8;

interface Live {
  p: Patch;
  end: number;
  mode: MusicMode;
  layer: number;
}

export class MusicEngine {
  private timer: number | null = null;
  private started = false;
  private mode: MusicMode = 'battle';
  private pending: MusicMode = 'battle';
  private step = 0;
  private bar = 0;
  private next = 0;
  private sd = 60 / BATTLE_BPM / 4;
  private rnd = rng32(0x5eed1);
  private live: Live[] = [];
  private intensity: () => number = () => 0;

  // battle state
  private level = 0;
  private planned = 0;
  private levelBar = 0;
  private fadeEnd = 0;
  private lastI = 0;
  private readonly layerTarget = [1, 1, 0, 0];
  private shepEnd = 0;
  private stabStep = -1;
  private stingAt = -1e9;
  private readonly stingKindAt: Record<StingerKind, number> = { heavy: -1e9, dread: -1e9 };

  // menu state
  private heart = 0;
  private pianoStep = -1;
  private piano2Step = -1;
  private scrapeStep = -1;
  private radioStep = -1;

  // graph
  private readonly bus: Record<MusicMode, GainNode>;
  private readonly echo: Record<MusicMode, GainNode>;
  private readonly layer: GainNode[] = [];
  private readonly menuL: AudioNode;
  private readonly menuR: AudioNode;
  private readonly calmL: AudioNode;
  private readonly calmR: AudioNode;
  private readonly combatL: AudioNode;
  private readonly combatR: AudioNode;
  private readonly ostLp: BiquadFilterNode;
  private readonly droneLp: Record<MusicMode, BiquadFilterNode>;
  private readonly shep: GainNode;
  private readonly sting: GainNode;
  private readonly kit: DrumKit;
  private shepBuf: AudioBuffer | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly bank: Bank,
    out: AudioNode,
  ) {
    this.kit = makeDrumKit(ctx);
    // Rumble filter: nothing below ~28 Hz leaves the music (saves headroom).
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 28;
    hp.Q.value = 0.6;
    hp.connect(out);
    this.bus = { battle: ctx.createGain(), menu: ctx.createGain() };
    for (const m of ['battle', 'menu'] as const) {
      this.bus[m].gain.value = 0;
      this.bus[m].connect(hp);
    }
    // Feedback echoes (lowpassed, so they darken as they repeat).
    this.echo = {
      menu: this.makeEcho(this.bus.menu, 0.62, 0.42, 1700, 0.5),
      battle: this.makeEcho(this.bus.battle, (60 / BATTLE_BPM) * 0.75, 0.3, 1500, 0.35),
    };
    for (let i = 0; i < 4; i++) {
      const g = ctx.createGain();
      g.gain.value = this.layerTarget[i];
      g.connect(this.bus.battle);
      this.layer.push(g);
    }
    this.sting = ctx.createGain();
    this.sting.connect(this.bus.battle);
    this.menuL = this.pan(this.bus.menu, -0.6);
    this.menuR = this.pan(this.bus.menu, 0.6);
    this.calmL = this.pan(this.layer[L.Calm], -0.45);
    this.calmR = this.pan(this.layer[L.Calm], 0.45);
    this.combatL = this.pan(this.layer[L.Combat], -0.5);
    this.combatR = this.pan(this.layer[L.Combat], 0.5);
    // Shared tone shaping for the drones and the ostinato: one filter per bus
    // instead of one per note.
    this.droneLp = { battle: this.lp(this.layer[L.Bed], 400, 1.7), menu: this.lp(this.bus.menu, 300, 1.8) };
    const ostDrive = ctx.createWaveShaper();
    ostDrive.curve = bank.curve(1.6);
    ostDrive.connect(this.layer[L.Alert]);
    this.ostLp = this.lp(ostDrive, 700, 1.6);
    this.shep = ctx.createGain();
    this.shep.gain.value = 0.05;
    this.shep.connect(this.layer[L.Alert]);
  }

  get running(): boolean {
    return this.started;
  }

  /** current battle level: 0 calm, 1 alert, 2 combat */
  get currentLevel(): number {
    return this.level;
  }

  get currentMode(): MusicMode {
    return this.mode;
  }

  setIntensitySource(fn: () => number): void {
    this.intensity = fn;
  }

  setMode(m: MusicMode): void {
    this.pending = m;
    if (!this.started) this.mode = m;
  }

  /**
   * Start scheduling. `manual` skips the timer: the caller then drives the
   * scheduler with pump() (offline rendering, tests).
   */
  start(manual = false): void {
    if (this.started) return;
    this.started = true;
    const now = this.ctx.currentTime;
    this.mode = this.pending;
    this.step = 0;
    this.bar = 0;
    this.next = now + 0.08;
    this.resetLevel(now);
    for (const m of ['battle', 'menu'] as const) {
      const g = this.bus[m].gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(m === this.mode ? 1 : 0, now);
    }
    if (!manual && typeof window !== 'undefined') {
      this.timer = window.setInterval(() => this.tick(), TICK_MS);
      this.tick();
    }
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.started) return;
    this.started = false;
    // the caller fades the output; long notes are cut once it is silent
    this.killWhere(() => true, this.ctx.currentTime + 0.6);
  }

  /** Schedule every event that starts before `until` (audio time). */
  pump(until: number): void {
    while (this.next < until) {
      const t = this.next;
      if (this.step === 0) this.barStart(t);
      if (this.mode === 'battle') this.battleStep(this.step, t, this.sd);
      else this.menuStep(this.step, t, this.sd);
      if (this.step === 12) this.plan(t, this.sd);
      this.next += this.sd;
      this.step++;
      if (this.step >= 16) {
        this.step = 0;
        this.bar++;
      }
    }
  }

  private tick(): void {
    const ctx = this.ctx;
    if (ctx.state !== 'running' || !this.started) return;
    const now = ctx.currentTime;
    // Background tabs throttle timers: resync instead of bursting stale notes.
    if (this.next < now - 0.05) {
      this.next = now + 0.05;
      this.step = 0;
      this.bar++;
    }
    this.pump(now + LOOKAHEAD);
  }

  // ------------------------------------------------------------------ plumbing

  private patch(): Patch {
    return new Patch(this.ctx, this.bank);
  }

  private makeEcho(ret: AudioNode, time: number, fb: number, cutoff: number, level: number): GainNode {
    const ctx = this.ctx;
    const input = ctx.createGain();
    const dly = ctx.createDelay(1.5);
    dly.delayTime.value = time;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.value = fb;
    const o = ctx.createGain();
    o.gain.value = level;
    input.connect(dly);
    dly.connect(lp);
    lp.connect(g);
    g.connect(dly);
    lp.connect(o);
    o.connect(ret);
    return input;
  }

  private pan(dest: AudioNode, x: number): AudioNode {
    if (typeof this.ctx.createStereoPanner !== 'function') return dest;
    const p = this.ctx.createStereoPanner();
    p.pan.value = x;
    p.connect(dest);
    return p;
  }

  private lp(dest: AudioNode, f: number, q: number): BiquadFilterNode {
    const n = this.ctx.createBiquadFilter();
    n.type = 'lowpass';
    n.frequency.value = f;
    n.Q.value = q;
    n.connect(dest);
    return n;
  }

  /** Remember a long-running patch so it can be cut when its layer/mode goes silent. */
  private track(p: Patch, layer = -1): void {
    p.finish();
    this.live.push({ p, end: p.end, mode: this.mode, layer });
  }

  private prune(t: number): void {
    let j = 0;
    for (let i = 0; i < this.live.length; i++) {
      const l = this.live[i];
      if (l.end > t) this.live[j++] = l;
    }
    this.live.length = j;
  }

  private killWhere(pred: (l: Live) => boolean, at: number): void {
    let j = 0;
    for (let i = 0; i < this.live.length; i++) {
      const l = this.live[i];
      if (pred(l)) {
        if (l.end > at) l.p.kill(at);
      } else {
        this.live[j++] = l;
      }
    }
    this.live.length = j;
  }

  // ------------------------------------------------------------- bar control

  private barStart(t: number): void {
    this.prune(t);
    if (this.pending !== this.mode) this.switchMode(t);
    if (this.mode === 'battle') this.battleBar(t);
    else this.menuBar(t);
  }

  private switchMode(t: number): void {
    const from = this.mode;
    const to = this.pending;
    this.mode = to;
    this.bar = 0;
    const gNew = this.bus[to].gain;
    const gOld = this.bus[from].gain;
    gNew.cancelScheduledValues(t);
    gNew.setValueAtTime(gNew.value, t);
    gNew.setTargetAtTime(1, t, 0.15);
    gOld.cancelScheduledValues(t);
    gOld.setValueAtTime(gOld.value, t);
    gOld.setTargetAtTime(0, t, 0.6);
    this.killWhere((l) => l.mode === from, t + 3.5);
    if (to === 'battle') this.resetLevel(t);
    // transition hit, straight onto the new bus
    this.boom(t, this.bus[to], to === 'battle' ? 0.9 : 0.6);
  }

  private resetLevel(t: number): void {
    this.level = 0;
    this.planned = 0;
    this.levelBar = this.bar;
    this.fadeEnd = t;
    this.shepEnd = 0;
    const mix = LAYER_MIX[0];
    for (let i = 0; i < 4; i++) {
      const g = this.layer[i].gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(mix[i], t);
      this.layerTarget[i] = mix[i];
    }
  }

  /** At the last beat of a bar: decide the next bar's level / prepare transitions. */
  private plan(t: number, sd: number): void {
    if (this.pending !== this.mode) {
      // pull the listener into the other mode with a reversed swell
      this.reverseSwell(t + sd * 4, sd * 4, this.bus[this.mode], 50, 0.7);
      return;
    }
    if (this.mode !== 'battle') return;
    const I = clamp(Number(this.intensity()) || 0, 0, 1);
    this.lastI = I;
    const lv = this.level;
    let want = I >= 0.7 ? 2 : I >= 0.3 ? 1 : 0;
    if (want < lv) {
      // hysteresis + hold: calm down only after 4 bars, on even bars, clearly below the threshold
      if (lv === 2 && I > 0.58) want = 2;
      else if (lv >= 1 && want === 0 && I > 0.2) want = 1;
      if (this.bar - this.levelBar < 3 || this.bar % 2 === 0) want = lv;
    }
    if (t + sd * 4 < this.fadeEnd - 1e-3) want = lv; // previous crossfade still running
    this.planned = want;
    if (want > lv) {
      // pickup into the louder layer
      const r = this.root(this.bar + 1);
      this.reverseSwell(t + sd * 4, sd * 4, this.layer[L.Bed], 50 + r, want === 2 ? 0.9 : 0.6);
      if (want === 2) for (let k = 0; k < 4; k++) this.taiko(t + k * sd, this.layer[L.Bed], 0.45 + k * 0.15, k < 2 ? 1.1 : 0.9);
    }
  }

  private root(bar: number): number {
    return ROOTS[Math.floor(bar / 8) % 2][bar % 8];
  }

  private setLevel(t: number, lv: number): void {
    const up = lv > this.level;
    const dur = this.sd * 16 * (up ? 1 : 2);
    const mix = LAYER_MIX[lv];
    for (let i = 0; i < 4; i++) {
      if (mix[i] === this.layerTarget[i]) continue;
      const g = this.layer[i].gain;
      g.setTargetAtTime(mix[i], t, dur / 3.5);
      if (mix[i] === 0) this.killWhere((l) => l.layer === i, t + dur * 1.2);
      if (mix[i] === 0 && i === L.Alert) this.shepEnd = 0;
      this.layerTarget[i] = mix[i];
    }
    this.level = lv;
    this.levelBar = this.bar;
    this.fadeEnd = t + dur;
  }

  private on(layer: number): boolean {
    return this.layerTarget[layer] > 0;
  }

  // ------------------------------------------------------------------ battle

  private battleBar(t: number): void {
    const sd = this.sd;
    const barLen = sd * 16;
    if (this.planned !== this.level) this.setLevel(t, this.planned);
    const b = this.bar;
    const pb = b % 8;
    const r = this.root(b);
    const I = this.lastI;
    const rnd = this.rnd;

    // shared filters follow the intensity
    this.droneLp.battle.frequency.setTargetAtTime(380 + 700 * I, t, barLen / 2);
    this.ostLp.frequency.setTargetAtTime(450 + 1500 * I, t, barLen / 3);

    // bed: an 8-bar D pedal plus a cluster pad that follows the harmony
    if (pb === 0) this.drone(t, barLen * 8, 'battle', 26, 1, 1, 0.9);
    if (pb === 0 || this.root(b - 1) !== r) {
      let n = 1;
      while (pb + n < 8 && this.root(b + n) === r) n++;
      this.pad(t, barLen * n, this.layer[L.Bed], 50 + r, 0.55 + 0.45 * I);
    }

    // calm: sparse stab somewhere in this bar, creeping crescendo across the second half-phrase
    this.stabStep = -1;
    if (this.on(L.Calm)) {
      if (rnd() < 0.4) this.stabStep = [0, 6, 10][Math.floor(rnd() * 3)];
      if (pb === 4 && this.level === 0) this.creep(t, barLen * 4, this.layer[L.Calm], 74 + (r === 6 ? 0 : r), 0.05, L.Calm);
    }

    // alert: Shepard riser births and dissonant brass swells
    if (this.on(L.Alert)) {
      if (this.shepEnd < t + barLen) this.shepard(t);
      const brassBar = this.level === 2 ? pb % 2 === 0 : pb === 2 || pb === 6;
      if (brassBar) this.brass(t, barLen * 1.5, this.layer[L.Alert], 38 + r, 0.7 + 0.3 * I);
    }

    // combat: high tremolo cluster
    if (this.on(L.Combat)) {
      this.tremolo(t, barLen, 74 + (r > 3 ? r - 12 : r), sd);
    }
  }

  private battleStep(s: number, t: number, sd: number): void {
    const b = this.bar;
    const pb = b % 8;
    const r = this.root(b);
    const I = this.lastI;
    const rnd = this.rnd;

    if (this.on(L.Calm)) {
      const calm = this.layer[L.Calm];
      if (s % 2 === 0) this.tickTock(t, s % 4 === 0 ? this.calmL : this.calmR, s % 4 === 0, s === 0 ? 1 : 0.75);
      if (s === 0 || s === 8) this.thump(t, calm, 0.9);
      if (s === 2 || s === 10) this.thump(t, calm, 0.55);
      if (s === this.stabStep) this.stab(t, calm, r, rnd() < 0.5);
    }

    if (this.on(L.Alert)) {
      const combat = this.level === 2;
      const pat = combat ? (pb % 2 === 1 ? OST_C : OST_B) : I > 0.5 ? (pb % 2 === 1 ? OST_B : OST_A) : OST_A;
      const n = pat[s];
      // sparser (8ths) at the bottom of the alert range
      if (n !== null && (s % 2 === 0 || I > 0.42 || combat)) {
        const v = (ACCENT[s] ? 1 : 0.6) * (0.75 + 0.25 * I);
        this.ostNote(t, 38 + r + n, sd * (ACCENT[s] ? 1.4 : 0.9), v);
      }
      const tk = (combat ? TAIKO_COMBAT : TAIKO_ALERT)[s];
      if (tk > 0) this.taiko(t, this.layer[L.Alert], tk, tk >= 0.9 ? 1 : 1.25);
      // phrase-end roll
      if (pb === 7 && s >= (combat ? 8 : 12)) this.taiko(t, this.layer[L.Alert], 0.35 + (s - 8) * 0.07, 1.4);
    }

    if (this.on(L.Combat)) {
      const combat = this.layer[L.Combat];
      if (s === 4 || s === 12) this.anvil(t, combat, 1);
      if (s % 2 === 1 || rnd() < 0.5) this.shaker(t, s % 4 === 2 ? this.combatR : this.combatL, s % 4 === 2 ? 0.9 : 0.5);
      if (s === 0 || s === 8 || (s === 11 && pb % 2 === 1)) this.lowPulse(t, combat, 26 + r, s === 11 ? 0.7 : 1);
      // alarm-like tritone horn calls every 4 bars
      if ((pb === 1 || pb === 5) && s % 4 === 0) this.horn(t, sd * 3.2, combat, s % 8 === 0 ? 62 : 56, 0.9);
    }
  }

  // -------------------------------------------------------------------- menu

  private menuBar(t: number): void {
    const rnd = this.rnd;
    const pb = this.bar % 4;
    const phrase = Math.floor(this.bar / 4);
    if (pb === 0) this.sd = 60 / MENU_BPM[phrase % MENU_BPM.length] / 4;
    const sd = this.sd;
    const barLen = sd * 16;
    const bus = this.bus.menu;

    if (pb === 0) {
      const ph = phrase % MENU_BPM.length;
      const up = MENU_UPPER[phrase % MENU_UPPER.length];
      this.drone(t, barLen * 4, 'menu', 26, up[0], up[1], 1);
      this.wind(t, barLen * 4, rnd() < 0.5 ? this.menuL : this.menuR);
      // heartbeat appears in the 2nd phrase, grows with the tempo, drops out on the last
      this.heart = ph === 0 ? 0 : ph === MENU_BPM.length - 1 ? 0 : 0.45 + ph * 0.12;
      if (phrase > 0 && rnd() < 0.5) this.boom(t, bus, 0.5);
      this.radioStep = -1;
    }
    // creeping cluster on odd phrases (bars 2-4), cut dead at the next downbeat
    if (pb === 1 && phrase % 2 === 1) this.creep(t, barLen * 3, bus, rnd() < 0.5 ? 74 : 68, 0.045, -1);
    // reversed swell sucking into the next phrase on even phrases
    if (pb === 3 && phrase % 2 === 0 && rnd() < 0.75) this.reverseSwell(t + barLen, barLen * 0.85, bus, rnd() < 0.5 ? 50 : 62, 0.55);

    this.pianoStep = rnd() < 0.65 ? Math.floor(rnd() * 16) : -1;
    this.piano2Step = rnd() < 0.25 ? Math.floor(rnd() * 16) : -1;
    this.scrapeStep = rnd() < 0.3 ? Math.floor(rnd() * 12) : -1;
    if (pb === 2 && rnd() < 0.45) this.radioStep = Math.floor(rnd() * 12);
  }

  private menuStep(s: number, t: number, sd: number): void {
    const rnd = this.rnd;
    const bus = this.bus.menu;
    if (this.heart > 0 && s % 4 < 2) {
      // lub-dub on every beat
      const lub = s % 4 === 0;
      this.thump(t, bus, this.heart * (lub ? 1 : 0.6));
    }
    if (s === this.pianoStep || s === this.piano2Step) {
      const out = rnd() < 0.5 ? this.menuL : this.menuR;
      if (rnd() < 0.35) {
        const d = PIANO_DYADS[Math.floor(rnd() * PIANO_DYADS.length)];
        this.piano(t, out, d[0], 0.8);
        this.piano(t + 0.012, out, d[1], 0.7);
      } else if (rnd() < 0.3) {
        this.bell(t, out, PIANO_NOTES[Math.floor(rnd() * PIANO_NOTES.length)] - 12, 0.9);
      } else {
        this.piano(t, out, PIANO_NOTES[Math.floor(rnd() * PIANO_NOTES.length)], 0.6 + rnd() * 0.4);
      }
    }
    if (s === this.scrapeStep) this.scrape(t, sd * (10 + rnd() * 10), rnd() < 0.5 ? this.menuL : this.menuR, 0.8);
    if (s === this.radioStep) this.radio(t, rnd() < 0.5 ? this.menuL : this.menuR, 0.8);
  }

  // ---------------------------------------------------------------- stingers

  /** A scary hit for a big moment (only in battle; rate limited). Returns true if played. */
  stinger(kind: StingerKind, at?: number): boolean {
    if (!this.started || this.mode !== 'battle' || this.pending !== 'battle') return false;
    const t = at ?? this.ctx.currentTime + 0.02;
    if (t - this.stingAt < 5 || t - this.stingKindAt[kind] < 12) return false;
    this.stingAt = t;
    this.stingKindAt[kind] = t;
    const r = this.root(this.bar);
    if (kind === 'heavy') this.stingHeavy(t, r);
    else this.stingDread(t, r);
    return true;
  }

  private stingHeavy(t: number, r: number): void {
    const p = this.patch();
    const dest = this.sting;
    const end = t + 2.2;
    // low brass blast: D1 / D2 / G#2 saws through a fast-opening filter
    const lp = p.filter('lowpass', 180, 2);
    lp.frequency.setValueAtTime(180, t);
    lp.frequency.linearRampToValueAtTime(1900, t + 0.06);
    lp.frequency.exponentialRampToValueAtTime(220, t + 1.6);
    const sh = p.shaper(2.2);
    const g = p.gain(0);
    env(g.gain, t, 0.13, 0.025, 0.35, 1.5);
    for (const [m, det] of [[26 + r, -8], [38 + r, 6], [44 + r, -5], [50 + r, 9]] as const) {
      const o = p.osc('sawtooth', midiHz(m), t, end);
      o.detune.value = det;
      glide(o.frequency, t + 0.4, midiHz(m), midiHz(m) * 0.94, 1.6);
      o.connect(lp);
    }
    lp.connect(sh);
    sh.connect(g);
    g.connect(dest);
    g.connect(this.echo.battle);
    // sub boom
    p.th(dest, t, { f: 62, f2: 26, glide: 1.3, a: 0.004, d: 1.9, peak: 0.55, drive: 1.4 });
    p.nh(dest, t, { kind: 'brown', type: 'lowpass', f: 420, f2: 120, sweep: 1.4, a: 0.01, d: 1.6, peak: 0.35 });
    p.finish();
  }

  private stingDread(t: number, r: number): void {
    const p = this.patch();
    const dest = this.sting;
    const end = t + 2.6;
    // high string cluster sforzando: root, b2, tritone, 5th one octave up
    const lp = p.filter('lowpass', 4200, 0.8);
    const g = p.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.06, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.018, t + 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
    for (const iv of [0, 1, 6, 7]) {
      const o = p.osc('sawtooth', midiHz(74 + r + iv), t, end);
      o.detune.value = (iv % 2 ? 1 : -1) * 7;
      o.connect(lp);
    }
    lp.connect(g);
    g.connect(dest);
    g.connect(this.echo.battle);
    // metallic clang (inharmonic partials) and a low hit
    const f = midiHz(57 + r);
    p.th(dest, t, { f, a: 0.002, d: 2.2, peak: 0.07 });
    p.th(dest, t, { f: f * 2.76, a: 0.002, d: 1.2, peak: 0.045 });
    p.th(dest, t, { f: f * 5.4, a: 0.001, d: 0.5, peak: 0.03 });
    p.th(dest, t, { f: 55, f2: 30, glide: 0.6, d: 1.0, peak: 0.45, drive: 1.5 });
    p.nh(dest, t, { kind: 'pink', type: 'lowpass', f: 1600, f2: 200, sweep: 0.5, d: 0.6, peak: 0.25 });
    p.finish();
  }

  // ------------------------------------------------------------- instruments

  /** D pedal: sub sine + two beating saws through the bus's shared lowpass, with a sliding upper voice. */
  private drone(t: number, dur: number, mode: MusicMode, midi: number, up0: number, up1: number, v: number): void {
    const p = this.patch();
    const fade = Math.min(3, dur * 0.2);
    const end = t + dur + fade + 0.05;
    const g = p.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + fade);
    g.gain.setValueAtTime(v, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + fade);
    const sub = p.osc('sine', midiHz(midi), t, end);
    const sg = p.gain(0.05);
    sub.connect(sg);
    sg.connect(g);
    const sawG = p.gain(0.055);
    for (const det of [-9, 8]) {
      const o = p.osc('sawtooth', midiHz(midi + 12), t, end);
      o.detune.value = det;
      o.connect(sawG);
    }
    // octave above for small speakers
    const oct = p.osc('sawtooth', midiHz(midi + 24), t, end);
    oct.detune.value = 3;
    const og = p.gain(1.25);
    oct.connect(og);
    og.connect(sawG);
    sawG.connect(g);
    // dissonant upper voice one octave higher, outside the shared filter so it stays audible
    const um = midi + 24;
    const upper = p.osc('sawtooth', midiHz(um + up0), t, end);
    if (up1 !== up0) {
      upper.frequency.setValueAtTime(midiHz(um + up0), t + dur * 0.3);
      upper.frequency.exponentialRampToValueAtTime(midiHz(um + up1), t + dur);
    }
    const ulp = p.filter('lowpass', 900, 0.8);
    const ug = p.gain(0);
    ug.gain.setValueAtTime(0, t);
    ug.gain.linearRampToValueAtTime(0.035, t + dur * 0.5);
    ug.gain.linearRampToValueAtTime(0.02, t + dur + fade);
    upper.connect(ulp);
    ulp.connect(ug);
    ug.connect(g);
    g.connect(this.droneLp[mode]);
    this.track(p, mode === 'battle' ? L.Bed : -1);
    // slow cutoff wander for the menu drone (battle follows the intensity instead)
    if (mode === 'menu') {
      const f = this.droneLp.menu.frequency;
      f.setTargetAtTime(260 + this.rnd() * 80, t, dur * 0.1);
      f.setTargetAtTime(520 + this.rnd() * 300, t + dur * 0.35, dur * 0.15);
      f.setTargetAtTime(280 + this.rnd() * 80, t + dur * 0.75, dur * 0.1);
    }
  }

  /** Dark string-like cluster (root, minor third, minor ninth) held for the chord's length. */
  private pad(t: number, dur: number, dest: AudioNode, root: number, v: number): void {
    const p = this.patch();
    const rel = 0.9;
    const end = t + dur + rel + 0.05;
    const lp = p.filter('lowpass', 700, 0.9);
    lp.frequency.setValueAtTime(500, t);
    lp.frequency.linearRampToValueAtTime(1100, t + dur * 0.7);
    lp.frequency.linearRampToValueAtTime(600, t + dur + rel);
    const g = p.gain(0);
    const pk = 0.06 * v;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(pk, t + 0.7);
    g.gain.setValueAtTime(pk, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + rel);
    for (let i = 0; i < PAD_VOICING.length; i++) {
      const o = p.osc('sawtooth', midiHz(root + PAD_VOICING[i]), t, end);
      o.detune.value = (i - 1) * 7;
      o.connect(lp);
    }
    lp.connect(g);
    g.connect(dest);
    this.track(p, L.Bed);
  }

  /** Play a pre-rendered one-shot. */
  private hit(buf: AudioBuffer, t: number, dest: AudioNode, v: number, rate = 1): void {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = v;
    s.connect(g);
    g.connect(dest);
    s.onended = () => {
      s.disconnect();
      g.disconnect();
    };
    s.start(t);
  }

  /** Clock tick (hi) / tock (lo). */
  private tickTock(t: number, dest: AudioNode, hi: boolean, v: number): void {
    this.hit(this.kit.tick, t, dest, 0.16 * v, hi ? 1 : 0.72);
  }

  /** Muffled low thump (heartbeat). */
  private thump(t: number, dest: AudioNode, v: number): void {
    this.hit(this.kit.thump, t, dest, 0.36 * v);
  }

  /** Dissonant stab: low pizzicato minor 2nd, or a high tritone piano dyad. */
  private stab(t: number, dest: AudioNode, r: number, low: boolean): void {
    if (!low) {
      this.piano(t, dest, 74 + r, 0.8);
      this.piano(t + 0.01, dest, 80 + r, 0.7);
      return;
    }
    const p = this.patch();
    const end = t + 1.1;
    const lp = p.filter('lowpass', 2200, 1.5);
    glide(lp.frequency, t, 2200, 260, 0.5);
    const g = p.gain(0);
    env(g.gain, t, 0.07, 0.004, 0.02, 0.9);
    for (const iv of [0, 1, 12]) {
      const o = p.osc('sawtooth', midiHz(38 + r + iv), t, end);
      o.detune.value = iv === 1 ? 6 : -4;
      o.connect(lp);
    }
    lp.connect(g);
    g.connect(dest);
    g.connect(this.echo.battle);
    p.finish();
  }

  /** Slowly swelling high cluster that is cut off instead of resolving. */
  private creep(t: number, dur: number, dest: AudioNode, top: number, v: number, layer: number): void {
    const p = this.patch();
    const end = t + dur + 0.1;
    const lfo = p.osc('sine', 4.6, t, end);
    const depth = p.gain(0);
    depth.gain.setValueAtTime(0, t);
    depth.gain.linearRampToValueAtTime(18, t + dur);
    lfo.connect(depth);
    const lp = p.filter('lowpass', 1800, 0.7);
    glide(lp.frequency, t, 1200, 4200, dur);
    for (const [iv, type] of [[0, 'triangle'], [1, 'triangle'], [6, 'sine']] as const) {
      const o = p.osc(type, midiHz(top + iv), t, end);
      o.detune.value = iv * 2 - 5;
      depth.connect(o.detune);
      o.connect(lp);
    }
    const g = p.gain(0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + dur - 0.05);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.04);
    lp.connect(g);
    g.connect(dest);
    this.track(p, layer);
  }

  /** Reversed swell (noise + cluster) that ends abruptly at tEnd. */
  private reverseSwell(tEnd: number, dur: number, dest: AudioNode, midi: number, v: number): void {
    const p = this.patch();
    const t = tEnd - dur;
    const end = tEnd + 0.06;
    const g = p.gain(0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, tEnd - 0.01);
    g.gain.linearRampToValueAtTime(0, tEnd + 0.03);
    const n = p.noise('pink', t, end);
    const bp = p.filter('bandpass', 900, 0.8);
    glide(bp.frequency, t, 500, 3200, dur);
    const ng = p.gain(0.13);
    n.connect(bp);
    bp.connect(ng);
    ng.connect(g);
    const lp = p.filter('lowpass', 900, 0.8);
    glide(lp.frequency, t, 400, 2600, dur);
    for (const iv of [0, 1]) {
      const o = p.osc('sawtooth', midiHz(midi + iv), t, end);
      o.connect(lp);
    }
    const tg = p.gain(0.05);
    lp.connect(tg);
    tg.connect(g);
    g.connect(dest);
    p.finish();
  }

  /** Endless Shepard-tone riser (a pre-rendered seamless loop), runs until its layer is cut. */
  private shepard(t: number): void {
    if (!this.shepBuf) this.shepBuf = makeShepard(this.ctx, SHEP_LOOP, SHEP_BASE, SHEP_OCT);
    const p = this.patch();
    const g = p.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + 1.5);
    p.sample(this.shepBuf, t, t + 1800, true).connect(g);
    g.connect(this.shep);
    this.shepEnd = t + 1800;
    this.track(p, L.Alert);
  }

  /** Low string ostinato note (into the shared drive + lowpass). */
  private ostNote(t: number, midi: number, dur: number, v: number): void {
    const p = this.patch();
    const end = t + dur + 0.08;
    const f = midiHz(midi);
    const g = p.gain(0);
    env(g.gain, t, 0.085 * v, 0.004, dur * 0.35, dur * 0.6);
    const a = p.osc('sawtooth', f, t, end);
    a.detune.value = -6;
    const b = p.osc('sawtooth', f * 2, t, end);
    b.detune.value = 5;
    const bg = p.gain(0.35);
    a.connect(g);
    b.connect(bg);
    bg.connect(g);
    g.connect(this.ostLp);
    p.finish();
  }

  /** War drum. `size` > 1 is a smaller, higher drum. */
  private taiko(t: number, dest: AudioNode, v: number, size: number): void {
    this.hit(this.kit.taiko, t, dest, 0.5 * v, size);
  }

  /** Dissonant brass-like swell (root, tritone, octave) that blooms and is clipped short. */
  private brass(t: number, dur: number, dest: AudioNode, root: number, v: number): void {
    const p = this.patch();
    const end = t + dur + 0.25;
    const lp = p.filter('lowpass', 200, 1.4);
    lp.frequency.setValueAtTime(200, t);
    lp.frequency.exponentialRampToValueAtTime(1500, t + dur * 0.9);
    lp.frequency.exponentialRampToValueAtTime(300, t + dur + 0.2);
    const sh = p.shaper(1.8);
    const g = p.gain(0);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.075 * v, t + dur * 0.92);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.18);
    for (const [iv, det] of [[0, -6], [6, 5], [12, 3]] as const) {
      const o = p.osc('sawtooth', midiHz(root + iv), t, end);
      o.detune.value = det;
      o.connect(lp);
    }
    lp.connect(sh);
    sh.connect(g);
    g.connect(dest);
    g.connect(this.echo.battle);
    this.track(p, L.Alert);
  }

  /** High measured string tremolo on a minor 2nd, split left/right. */
  private tremolo(t: number, dur: number, midi: number, sd: number): void {
    const p = this.patch();
    const end = t + dur + 0.15;
    const lfo = p.osc('sine', 1 / sd, t, end);
    const depth = p.gain(0.5);
    lfo.connect(depth);
    for (const [iv, out] of [[0, this.combatL], [1, this.combatR]] as const) {
      const o = p.osc('sawtooth', midiHz(midi + iv), t, end);
      o.detune.value = iv ? 4 : -4;
      const lp = p.filter('lowpass', 3000, 0.7);
      const trem = p.gain(0.5);
      depth.connect(trem.gain);
      const g = p.gain(0);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.022, t + 0.08);
      g.gain.setValueAtTime(0.022, t + dur);
      g.gain.linearRampToValueAtTime(0, t + dur + 0.12);
      o.connect(lp);
      lp.connect(trem);
      trem.connect(g);
      g.connect(out);
    }
    this.track(p, L.Combat);
  }

  /** Metal anvil / snare-like backbeat. */
  private anvil(t: number, dest: AudioNode, v: number): void {
    this.hit(this.kit.anvil, t, dest, 0.12 * v);
  }

  private shaker(t: number, dest: AudioNode, v: number): void {
    this.hit(this.kit.shaker, t, dest, 0.06 * v, 0.9 + this.rnd() * 0.2);
  }

  /** Distorted low pulse with a sub drop (transposed with the harmony). */
  private lowPulse(t: number, dest: AudioNode, midi: number, v: number): void {
    this.hit(this.kit.pulse, t, dest, 0.33 * v, Math.pow(2, (midi - 26) / 12));
  }

  /** Alarm-like horn call note with a drooping tail. */
  private horn(t: number, dur: number, dest: AudioNode, midi: number, v: number): void {
    const p = this.patch();
    const f = midiHz(midi);
    const end = t + dur + 0.1;
    const lp = p.filter('lowpass', 1600, 1.2);
    const g = p.gain(0);
    env(g.gain, t, 0.04 * v, 0.03, dur * 0.6, dur * 0.4);
    for (const det of [-5, 5]) {
      const o = p.osc(det < 0 ? 'sawtooth' : 'square', f, t, end);
      o.detune.value = det;
      o.frequency.setValueAtTime(f, t + dur * 0.55);
      o.frequency.exponentialRampToValueAtTime(f * 0.93, t + dur);
      o.connect(lp);
    }
    lp.connect(g);
    g.connect(dest);
    p.finish();
  }

  /** Out-of-tune piano note (dry + echo send). */
  private piano(t: number, dest: AudioNode, midi: number, v: number): void {
    const p = this.patch();
    const f = midiHz(midi);
    const det = (this.rnd() - 0.5) * 24;
    const out = p.gain(1);
    out.connect(dest);
    const send = p.gain(0.6);
    out.connect(send);
    send.connect(this.mode === 'menu' ? this.echo.menu : this.echo.battle);
    p.th(out, t, { type: 'triangle', f, a: 0.002, d: 2.4, peak: 0.11 * v, detune: det });
    p.th(out, t, { f: f * 2.006, a: 0.002, d: 1.1, peak: 0.045 * v, detune: det });
    p.th(out, t, { f: f * 3.013, a: 0.002, d: 0.45, peak: 0.016 * v });
    p.nh(out, t, { type: 'bandpass', f: Math.min(6000, f * 5), q: 2, a: 0.001, d: 0.02, peak: 0.05 * v });
    p.finish();
  }

  /** Funeral bell: inharmonic partials, long decay, into the echo. */
  private bell(t: number, dest: AudioNode, midi: number, v: number): void {
    const p = this.patch();
    const f = midiHz(midi);
    const out = p.gain(1);
    out.connect(dest);
    out.connect(this.echo.menu);
    p.th(out, t, { f, a: 0.002, d: 3.2, peak: 0.06 * v });
    p.th(out, t, { f: f * 2.76, a: 0.002, d: 1.6, peak: 0.03 * v });
    p.th(out, t, { f: f * 5.4, a: 0.001, d: 0.7, peak: 0.018 * v });
    p.th(out, t, { f: f * 0.5, a: 0.004, d: 3.5, peak: 0.035 * v });
    p.finish();
  }

  /** Bowed / scraped metal: drifting inharmonic sines + resonant noise grain. */
  private scrape(t: number, dur: number, dest: AudioNode, v: number): void {
    const p = this.patch();
    const end = t + dur + 0.1;
    const base = 260 + this.rnd() * 420;
    const drift = 0.94 + this.rnd() * 0.1;
    const g = p.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(v, t + dur * 0.65);
    g.gain.linearRampToValueAtTime(0, t + dur);
    const hp = p.filter('highpass', 220, 0.7);
    hp.connect(g);
    g.connect(dest);
    g.connect(this.echo.menu);
    const lfo = p.osc('sine', 5 + this.rnd() * 3, t, end);
    const vib = p.gain(22);
    lfo.connect(vib);
    for (const [ratio, lvl] of [[1, 0.022], [1.47, 0.016], [2.31, 0.012]] as const) {
      const o = p.osc('sine', base * ratio, t, end);
      o.frequency.setValueAtTime(base * ratio, t);
      o.frequency.linearRampToValueAtTime(base * ratio * drift, t + dur);
      vib.connect(o.detune);
      const og = p.gain(lvl);
      o.connect(og);
      og.connect(hp);
    }
    // grainy bow noise
    const n = p.noise('white', t, end);
    const bp = p.filter('bandpass', base * 3, 14);
    bp.frequency.setValueAtTime(base * 3, t);
    bp.frequency.linearRampToValueAtTime(base * 2.4, t + dur);
    const ng = p.gain(0.5);
    const grain = p.gain(0.5);
    const glfo = p.osc('square', 11 + this.rnd() * 6, t, end);
    const gd = p.gain(0.4);
    glfo.connect(gd);
    gd.connect(grain.gain);
    n.connect(bp);
    bp.connect(grain);
    grain.connect(ng);
    ng.connect(hp);
    this.track(p, -1);
  }

  /** Radio static burst with morse-like blips. */
  private radio(t: number, dest: AudioNode, v: number): void {
    const p = this.patch();
    const out = p.gain(v);
    const hp = p.filter('highpass', 450, 0.7);
    const lp = p.filter('lowpass', 3200, 0.7);
    hp.connect(lp);
    lp.connect(out);
    out.connect(dest);
    out.connect(this.echo.menu);
    // morse
    let x = t + 0.35;
    const o = p.osc('sine', 760 + this.rnd() * 80, t, t + 4);
    const mg = p.gain(0);
    const n = 6 + Math.floor(this.rnd() * 6);
    for (let i = 0; i < n; i++) {
      const len = this.rnd() < 0.4 ? 0.21 : 0.07;
      mg.gain.setValueAtTime(0, x);
      mg.gain.linearRampToValueAtTime(0.035, x + 0.005);
      mg.gain.setValueAtTime(0.035, x + len - 0.005);
      mg.gain.linearRampToValueAtTime(0, x + len);
      x += len + (this.rnd() < 0.2 ? 0.21 : 0.07);
    }
    o.connect(mg);
    mg.connect(hp);
    // static: crushed band-limited noise with crackles, around the code
    const crush = p.crusher();
    crush.connect(hp);
    p.nh(crush, t, { type: 'bandpass', f: 1800, q: 0.7, a: 0.03, hold: 0.25, d: 0.25, peak: 0.12 });
    p.nh(crush, x, { type: 'bandpass', f: 1500, q: 0.7, a: 0.01, hold: 0.1, d: 0.2, peak: 0.1 });
    p.crackle(hp, t, x - t + 0.3, 10, 2600, 0.08);
    p.finish();
  }

  /** Wind: band-passed pink noise whose centre and level wander over the phrase. */
  private wind(t: number, dur: number, dest: AudioNode): void {
    const p = this.patch();
    const fade = Math.min(3, dur * 0.2);
    const end = t + dur + fade + 0.05;
    const n = p.noise('pink', t, end, 0.5);
    const bp = p.filter('bandpass', 400, 1.6);
    const f = bp.frequency;
    f.setValueAtTime(320, t);
    f.linearRampToValueAtTime(650 + this.rnd() * 400, t + dur * 0.4);
    f.linearRampToValueAtTime(380, t + dur * 0.75);
    f.linearRampToValueAtTime(520, t + dur + fade);
    const g = p.gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12, t + fade);
    g.gain.linearRampToValueAtTime(0.28, t + dur * 0.4);
    g.gain.linearRampToValueAtTime(0.12, t + dur * 0.75);
    g.gain.linearRampToValueAtTime(0, t + dur + fade);
    n.connect(bp);
    bp.connect(g);
    g.connect(dest);
    this.track(p, -1);
  }

  /** Distant deep impact. */
  private boom(t: number, dest: AudioNode, v: number): void {
    const p = this.patch();
    p.th(dest, t, { f: 64, f2: 28, glide: 1.0, d: 1.6, peak: 0.5 * v, drive: 1.3 });
    p.nh(dest, t, { kind: 'brown', type: 'lowpass', f: 320, f2: 90, sweep: 1.4, a: 0.01, d: 1.5, peak: 0.4 * v });
    p.finish();
  }
}
