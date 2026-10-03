/**
 * Ambience bed (wind, rain, sand grit, river, night insects) and the
 * continuous aircraft-engine voices. Both play baked seamless loops (see
 * weapons.ts) whose levels, filters, pans and playback rates are steered a
 * few times per second from the battle state; nothing here allocates per
 * update.
 */
import { gust } from './spatial';

export interface AmbienceState {
  /** Ambience on at all (battle running). */
  on: boolean;
  /** Wind strength 0..1. */
  wind: number;
  /** Rain falling 0..1, thunderstorm 0..1. */
  rain: number;
  storm: number;
  /** Sandstorm dust 0..1, snow 0..1. */
  dust: number;
  snow: number;
  /** Night 0..1 (crickets). */
  night: number;
  /** River close to the view centre 0..1 and its pan. */
  river: number;
  riverPan: number;
  /** Renderer zoom (closer = more of the small, near sounds). */
  zoom: number;
}

export function defaultAmbience(): AmbienceState {
  return { on: false, wind: 0.2, rain: 0, storm: 0, dust: 0, snow: 0, night: 0, river: 0, riverPan: 0, zoom: 1.8 };
}

/** Target levels of the beds for a state (pure; unit-tested). */
export function ambienceLevels(s: AmbienceState, time: number): { wind: number; windLp: number; rain: number; grit: number; river: number; crickets: number } {
  if (!s.on) return { wind: 0, windLp: 800, rain: 0, grit: 0, river: 0, crickets: 0 };
  const near = Math.max(0.35, Math.min(1, s.zoom / 1.6));
  const g = gust(time * 0.17, 3) * 0.7 + gust(time * 0.53, 9) * 0.3;
  const w = Math.max(0, Math.min(1, s.wind));
  const windLvl = (0.05 + 0.42 * Math.pow(w, 1.3) + 0.12 * s.storm + 0.25 * s.dust) * (0.55 + 0.9 * g * (0.3 + 0.7 * w)) * (s.snow > 0.3 ? 0.75 : 1);
  const windLp = 380 + 2300 * w * (0.6 + 0.6 * g) + 1500 * s.dust - 200 * s.snow;
  const rain = Math.min(1, s.rain) * (0.5 + 0.25 * s.storm) * (0.75 + 0.25 * near);
  const grit = Math.min(1, s.dust) * 0.35;
  const river = Math.min(1, s.river) * 0.42 * near * (1 - 0.5 * Math.min(1, s.rain));
  const quiet = (1 - Math.min(1, s.rain * 1.5)) * (1 - Math.min(1, w * 1.1)) * (1 - Math.min(1, s.snow * 2)) * (1 - Math.min(1, s.dust * 2));
  const crickets = Math.min(1, s.night) * quiet * 0.3 * near;
  return { wind: windLvl, windLp: Math.max(200, windLp), rain, grit, river, crickets };
}

interface Bed {
  src: AudioBufferSourceNode | null;
  gain: GainNode;
  filter: BiquadFilterNode | null;
  pan: StereoPannerNode | null;
  buf: AudioBuffer | null;
  rate: number;
}

export type BedName = 'wind' | 'rain' | 'grit' | 'river' | 'crickets';

export class Ambience {
  private beds: Record<BedName, Bed>;
  private lastSet: Record<BedName, number> = { wind: -1, rain: -1, grit: -1, river: -1, crickets: -1 };

  constructor(
    private ctx: BaseAudioContext,
    dest: AudioNode,
  ) {
    const mk = (filter: BiquadFilterType | null, f: number, pan: boolean, rate = 1): Bed => {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      let node: AudioNode = gain;
      let fl: BiquadFilterNode | null = null;
      if (filter) {
        fl = ctx.createBiquadFilter();
        fl.type = filter;
        fl.frequency.value = f;
        gain.connect(fl);
        node = fl;
      }
      let pn: StereoPannerNode | null = null;
      if (pan && typeof ctx.createStereoPanner === 'function') {
        pn = ctx.createStereoPanner();
        node.connect(pn);
        node = pn;
      }
      node.connect(dest);
      return { src: null, gain, filter: fl, pan: pn, buf: null, rate };
    };
    this.beds = {
      wind: mk('lowpass', 900, false),
      rain: mk(null, 0, false),
      grit: mk('bandpass', 2400, false, 0.62),
      river: mk(null, 0, true),
      crickets: mk(null, 0, false),
    };
  }

  setBuffer(name: BedName, buf: AudioBuffer): void {
    this.beds[name].buf = buf;
  }

  private ensure(b: Bed, now: number): void {
    if (b.src || !b.buf) return;
    const s = this.ctx.createBufferSource();
    s.buffer = b.buf;
    s.loop = true;
    s.playbackRate.value = b.rate;
    s.connect(b.gain);
    s.start(now, Math.random() * b.buf.duration);
    b.src = s;
  }

  private level(name: BedName, v: number, now: number, tau: number): void {
    const b = this.beds[name];
    if (v > 0.001) this.ensure(b, now);
    if (!b.src) return;
    if (Math.abs(v - this.lastSet[name]) < 0.002) return;
    this.lastSet[name] = v;
    b.gain.gain.setTargetAtTime(v, now, tau);
  }

  /** Steer the beds (call a few times per second). */
  update(s: AmbienceState, now: number): void {
    const L = ambienceLevels(s, now);
    this.level('wind', L.wind, now, 0.8);
    const wf = this.beds.wind.filter;
    if (wf && this.beds.wind.src) wf.frequency.setTargetAtTime(L.windLp, now, 0.8);
    this.level('rain', L.rain, now, 1.2);
    this.level('grit', L.grit, now, 1.2);
    this.level('river', L.river, now, 0.6);
    const rp = this.beds.river.pan;
    if (rp && this.beds.river.src) rp.pan.setTargetAtTime(Math.max(-0.8, Math.min(0.8, s.riverPan)), now, 0.6);
    this.level('crickets', L.crickets, now, 1.5);
  }

  /** Fade everything out (back to the menu). */
  silence(now: number): void {
    for (const k of Object.keys(this.beds) as BedName[]) {
      const b = this.beds[k];
      this.lastSet[k] = 0;
      if (b.src) b.gain.gain.setTargetAtTime(0, now, 0.4);
    }
  }
}

// ---------------------------------------------------------------------------
// Aircraft engines
// ---------------------------------------------------------------------------

export type EngineKind = 'jet' | 'rotor' | 'prop' | 'fpv' | 'turboprop';

/** Which baked loop each engine kind plays, at what base rate and level. */
export const ENGINE_LOOP: Record<EngineKind, { loop: 'jetLoop' | 'rotorLoop' | 'propLoop' | 'fpvLoop'; rate: number; lvl: number }> = {
  jet: { loop: 'jetLoop', rate: 1, lvl: 0.55 },
  rotor: { loop: 'rotorLoop', rate: 1, lvl: 0.6 },
  prop: { loop: 'propLoop', rate: 1, lvl: 0.4 },
  fpv: { loop: 'fpvLoop', rate: 1, lvl: 0.3 },
  turboprop: { loop: 'propLoop', rate: 0.62, lvl: 0.5 },
};

/** Engine sound of an aircraft from its model / flags. */
export function engineKindFor(model: string | undefined, fixedWing: boolean | undefined, airlift: boolean | undefined): EngineKind {
  if (airlift || (model && model.startsWith('tr_'))) return 'turboprop';
  if (fixedWing || model === 'fighter') return 'jet';
  if (model === 'heli') return 'rotor';
  if (model === 'fpv' || model === 'micro') return 'fpv';
  return 'prop';
}

interface EngineSlot {
  kind: EngineKind | null;
  src: AudioBufferSourceNode | null;
  gain: GainNode;
  lp: BiquadFilterNode;
  pan: StereoPannerNode | null;
  id: number;
}

export const ENGINE_SLOTS = 4;

export class EngineVoices {
  private slots: EngineSlot[] = [];

  constructor(
    private ctx: BaseAudioContext,
    dest: AudioNode,
    private loops: (name: string) => AudioBuffer | null,
  ) {
    for (let i = 0; i < ENGINE_SLOTS; i++) {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 8000;
      gain.connect(lp);
      let pan: StereoPannerNode | null = null;
      if (typeof ctx.createStereoPanner === 'function') {
        pan = ctx.createStereoPanner();
        lp.connect(pan);
        pan.connect(dest);
      } else {
        lp.connect(dest);
      }
      this.slots.push({ kind: null, src: null, gain, lp, pan, id: -1 });
    }
  }

  /**
   * Drive slot i: the aircraft `id` of `kind` at level `vol` (0 = off), pan,
   * low-pass and doppler rate. Switching aircraft restarts the loop with a short fade.
   */
  set(i: number, id: number, kind: EngineKind | null, vol: number, pan: number, lp: number, rate: number, now: number): void {
    const s = this.slots[i];
    if (!s) return;
    if (!kind || vol <= 0.002) {
      if (s.src) {
        s.gain.gain.setTargetAtTime(0, now, 0.15);
        const src = s.src;
        s.src = null;
        try {
          src.stop(now + 0.8);
        } catch {
          /* ignore */
        }
        src.onended = () => src.disconnect();
      }
      s.kind = null;
      s.id = -1;
      return;
    }
    const def = ENGINE_LOOP[kind];
    let at = now;
    if (s.kind !== kind || s.id !== id || !s.src) {
      at = now + 0.07;
      const buf = this.loops(def.loop);
      if (!buf) return;
      if (s.src) {
        const old = s.src;
        s.gain.gain.cancelScheduledValues(now);
        s.gain.gain.setValueAtTime(s.gain.gain.value, now);
        s.gain.gain.linearRampToValueAtTime(0, now + 0.06);
        try {
          old.stop(now + 0.07);
        } catch {
          /* ignore */
        }
        old.onended = () => old.disconnect();
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.playbackRate.value = def.rate * rate;
      src.connect(s.gain);
      src.start(now + 0.07, Math.random() * buf.duration);
      s.src = src;
      s.kind = kind;
      s.id = id;
    }
    const v = vol * def.lvl;
    s.gain.gain.setTargetAtTime(v, at, 0.12);
    s.lp.frequency.setTargetAtTime(Math.max(200, Math.min(18000, lp)), now, 0.12);
    s.pan?.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), now, 0.08);
    s.src.playbackRate.setTargetAtTime(def.rate * rate, now, 0.15);
  }

  silence(now: number): void {
    for (let i = 0; i < this.slots.length; i++) this.set(i, -1, null, 0, 0, 0, 1, now);
  }
}
