/**
 * Radio chatter: unit acknowledgements as short, non-verbal radio
 * transmissions (squelch open, a garbled band-limited "voice", static, a
 * roger beep and the squelch tail), and the squelch / static framing around
 * the spoken announcer lines. Every nation has its own radio character:
 * band, distortion, static colour and level, mains hum, digital crunch and
 * roger-beep pattern.
 */
import { type Patch, glide, rng32 } from './core';

export interface RadioProfile {
  /** Pass band of the radio (high-pass / low-pass corners, Hz). */
  lo: number;
  hi: number;
  /** Saturation of the transmitter. */
  drive: number;
  /** Static level and colour (band-pass centre, Q). */
  staticLvl: number;
  staticF: number;
  staticQ: number;
  /** Mains hum level (0 = none) and frequency. */
  hum: number;
  humF: number;
  /** Digital radio: bit-crushed with a data-burst chirp instead of hiss. */
  digital: boolean;
  /** Roger beep tones (Hz), played in sequence, and each tone's length. */
  beep: number[];
  beepDur: number;
  /** Pitch of the garbled operator voice. */
  voice: number;
}

const P = (o: RadioProfile) => o;

/** Per-nation radio character. */
export const RADIO: Record<string, RadioProfile> = {
  // clean digital net: two-tone talk-permit chirp
  usa: P({ lo: 380, hi: 3400, drive: 2, staticLvl: 0.03, staticF: 3000, staticQ: 0.5, hum: 0, humF: 60, digital: true, beep: [1200, 1800], beepDur: 0.045, voice: 122 }),
  israel: P({ lo: 450, hi: 3600, drive: 2.6, staticLvl: 0.05, staticF: 2600, staticQ: 0.6, hum: 0, humF: 50, digital: false, beep: [2000], beepDur: 0.06, voice: 134 }),
  china: P({ lo: 350, hi: 3000, drive: 2, staticLvl: 0.025, staticF: 2200, staticQ: 0.7, hum: 0, humF: 50, digital: true, beep: [1500, 0, 1500], beepDur: 0.04, voice: 126 }),
  // old analog sets: narrow, crunchy, hissy, with hum and a long single roger tone
  russia: P({ lo: 300, hi: 2500, drive: 4, staticLvl: 0.12, staticF: 1800, staticQ: 0.4, hum: 0.05, humF: 50, digital: false, beep: [1000], beepDur: 0.17, voice: 104 }),
  germany: P({ lo: 400, hi: 3200, drive: 2, staticLvl: 0.04, staticF: 2800, staticQ: 0.6, hum: 0, humF: 50, digital: false, beep: [1400, 1050], beepDur: 0.06, voice: 114 }),
  korea: P({ lo: 420, hi: 3400, drive: 2.2, staticLvl: 0.03, staticF: 3200, staticQ: 0.6, hum: 0, humF: 60, digital: true, beep: [1600, 2100], beepDur: 0.04, voice: 128 }),
  ukraine: P({ lo: 350, hi: 3000, drive: 3, staticLvl: 0.08, staticF: 2100, staticQ: 0.5, hum: 0, humF: 50, digital: false, beep: [910, 1225, 1650], beepDur: 0.05, voice: 118 }),
  turkey: P({ lo: 380, hi: 3000, drive: 2.8, staticLvl: 0.07, staticF: 2300, staticQ: 0.5, hum: 0.02, humF: 50, digital: false, beep: [1300], beepDur: 0.09, voice: 121 }),
  iran: P({ lo: 500, hi: 2400, drive: 4.5, staticLvl: 0.14, staticF: 1600, staticQ: 0.4, hum: 0.06, humF: 100, digital: false, beep: [850], beepDur: 0.14, voice: 110 }),
};

export const DEFAULT_RADIO = RADIO.usa;

export function radioFor(nation: string | null | undefined): RadioProfile {
  return (nation && RADIO[nation]) || DEFAULT_RADIO;
}

/** The radio's signal chain: band-pass, transmitter saturation, (digital crunch). Returns its input. */
function chain(p: Patch, o: AudioNode, rp: RadioProfile): AudioNode {
  const hp = p.filter('highpass', rp.lo, 0.8);
  const sh = p.shaper(rp.drive);
  const lp = p.filter('lowpass', rp.hi, 0.9);
  // a presence peak, the "telephone" honk of small speakers
  const pk = p.filter('peaking', Math.sqrt(rp.lo * rp.hi) * 1.3, 1.2);
  pk.gain.value = 5;
  hp.connect(sh);
  sh.connect(lp);
  lp.connect(pk);
  if (rp.digital) {
    const cr = p.crusher();
    const dry = p.gain(0.75);
    const wet = p.gain(0.25);
    pk.connect(dry);
    pk.connect(cr);
    cr.connect(wet);
    dry.connect(o);
    wet.connect(o);
  } else {
    pk.connect(o);
  }
  return hp;
}

/** Squelch opening: a click and a short burst of carrier noise. */
export function squelchOpen(p: Patch, o: AudioNode, t: number, rp: RadioProfile): void {
  p.nh(o, t, { type: 'highpass', f: 1500, a: 0.0005, d: 0.006, peak: 0.6 });
  p.nh(o, t + 0.004, { type: 'bandpass', f: rp.staticF, q: 0.5, a: 0.002, hold: 0.02, d: 0.03, peak: rp.digital ? 0.12 : 0.3 });
  if (rp.digital) {
    // data burst
    for (let k = 0; k < 4; k++) p.th(o, t + 0.01 + k * 0.012, { type: 'square', f: 1800 + ((k * 557) % 900), a: 0.001, hold: 0.008, d: 0.002, peak: 0.05 });
  }
}

/** End of transmission: roger beep(s) and the squelch tail. */
export function squelchClose(p: Patch, o: AudioNode, t: number, rp: RadioProfile): number {
  let tt = t;
  for (const f of rp.beep) {
    if (f > 0) p.th(o, tt, { type: 'sine', f, a: 0.003, hold: rp.beepDur - 0.008, d: 0.006, peak: 0.22 });
    tt += rp.beepDur + 0.01;
  }
  p.nh(o, tt, { type: 'bandpass', f: rp.staticF * 1.2, q: 0.5, a: 0.003, hold: 0.03, d: 0.05, peak: rp.digital ? 0.1 : 0.35 });
  p.nh(o, tt + 0.07, { type: 'highpass', f: 1500, a: 0.0005, d: 0.005, peak: 0.4 });
  return tt + 0.1;
}

/** Static / hum bed for a transmission of `dur` seconds. */
function staticBed(p: Patch, o: AudioNode, t: number, dur: number, rp: RadioProfile): void {
  p.nh(o, t, { type: 'bandpass', f: rp.staticF, q: rp.staticQ, a: 0.01, hold: dur, d: 0.03, peak: rp.staticLvl });
  if (rp.hum > 0) p.th(o, t, { type: 'sawtooth', f: rp.humF, a: 0.01, hold: dur, d: 0.03, peak: rp.hum, lp: 600 });
}

/** Vowel formants (F1, F2) the garbled voice moves between. */
const VOWELS: [number, number][] = [
  [730, 1090], [530, 1840], [270, 2290], [570, 840], [300, 870], [660, 1720], [490, 1350],
];

/**
 * A short garbled operator "voice": a glottal buzz through two moving formant
 * filters, chopped into syllables, with consonant noise. Through the radio
 * chain it reads as an acknowledgement without saying words.
 */
function mumble(p: Patch, o: AudioNode, t: number, rp: RadioProfile, R: () => number): number {
  const n = 2 + Math.floor(R() * 2.5);
  let tt = t;
  const f0 = rp.voice * (0.92 + 0.16 * R());
  const end = t + n * 0.16 + 0.1;
  const src = p.osc('sawtooth', f0, t, end);
  // speech-like pitch contour: up on the first syllable, falling at the end
  src.frequency.setValueAtTime(f0, t);
  src.frequency.linearRampToValueAtTime(f0 * 1.12, t + 0.08);
  src.frequency.linearRampToValueAtTime(f0 * 0.86, end);
  const f1 = p.filter('bandpass', 600, 6);
  const f2 = p.filter('bandpass', 1500, 9);
  const g1 = p.gain(1);
  const g2 = p.gain(0.6);
  const gate = p.gain(0);
  src.connect(f1);
  src.connect(f2);
  f1.connect(g1);
  f2.connect(g2);
  g1.connect(gate);
  g2.connect(gate);
  gate.connect(o);
  for (let k = 0; k < n; k++) {
    const dur = 0.07 + R() * 0.07;
    const v = VOWELS[Math.floor(R() * VOWELS.length)];
    const w = VOWELS[Math.floor(R() * VOWELS.length)];
    glide(f1.frequency, tt, v[0], w[0], dur);
    glide(f2.frequency, tt, v[1], w[1], dur);
    gate.gain.setValueAtTime(0, tt);
    gate.gain.linearRampToValueAtTime(0.9, tt + 0.012);
    gate.gain.setValueAtTime(0.9, tt + dur - 0.02);
    gate.gain.linearRampToValueAtTime(0, tt + dur);
    // consonant onset on some syllables
    if (R() < 0.6) p.nh(o, tt - 0.01, { type: 'highpass', f: 2500 + R() * 1500, a: 0.002, d: 0.025, peak: 0.12 });
    tt += dur + 0.02 + R() * 0.05;
  }
  return tt;
}

/**
 * One unit acknowledgement over the radio. Returns the end time. `seed` picks
 * the phrasing so successive acks differ.
 */
export function radioAck(p: Patch, out: AudioNode, t: number, rp: RadioProfile, seed: number): number {
  const R = rng32(seed);
  const pre = p.gain(0.8);
  const into = chain(p, pre, rp);
  pre.connect(out);
  squelchOpen(p, into, t, rp);
  const tv = t + 0.05;
  const te = mumble(p, into, tv, rp, R);
  const end = squelchClose(p, into, te + 0.02, rp);
  staticBed(p, into, t + 0.02, end - t - 0.05, rp);
  return end;
}

/** Short squelch open burst (before a spoken announcer line). */
export function radioOpen(p: Patch, out: AudioNode, t: number, rp: RadioProfile): void {
  const pre = p.gain(0.8);
  const into = chain(p, pre, rp);
  pre.connect(out);
  squelchOpen(p, into, t, rp);
}

/** Roger beep + squelch tail (after a spoken announcer line). */
export function radioClose(p: Patch, out: AudioNode, t: number, rp: RadioProfile): void {
  const pre = p.gain(0.8);
  const into = chain(p, pre, rp);
  pre.connect(out);
  squelchClose(p, into, t, rp);
}

/** Continuous static under a spoken line: returns its gain so the caller can fade it out. */
export function radioStatic(p: Patch, out: AudioNode, t: number, maxDur: number, rp: RadioProfile): GainNode {
  const g = p.gain(0);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(1, t + 0.05);
  const into = chain(p, g, rp);
  g.connect(out);
  // the bed itself (cut short by fading g when the line ends)
  const src = p.noise('pink', t, t + maxDur);
  const bp = p.filter('bandpass', rp.staticF, rp.staticQ);
  const lvl = p.gain(rp.staticLvl * 0.6);
  src.connect(bp);
  bp.connect(lvl);
  lvl.connect(into);
  if (rp.hum > 0) {
    const h = p.osc('sawtooth', rp.humF, t, t + maxDur);
    const hl = p.filter('lowpass', 600, 0.7);
    const hg = p.gain(rp.hum * 0.6);
    h.connect(hl);
    hl.connect(hg);
    hg.connect(into);
  }
  return g;
}
