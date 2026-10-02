/**
 * Positional audio maths and voice priority, kept free of Web Audio so it can
 * be unit-tested.
 *
 * The listener is the camera: it hovers above the view centre (cx, cy) at a
 * height that grows as the player zooms out. A sound at world position
 * (x, y, z) gets
 *  - a stereo pan from its horizontal screen position,
 *  - a distance gain (soft inverse-distance law from the camera),
 *  - an air-absorption low-pass (plus extra muffling when it is off-screen),
 *  - a propagation delay (light beats sound; capped so it still feels snappy),
 *  - a larger reverb send the farther away it is.
 */

export interface Listener {
  /** View centre on the ground (sim x / y). */
  cx: number;
  cy: number;
  /** Screen-right unit vector on the ground plane (sim x / y). */
  rx: number;
  ry: number;
  /** Half the visible width / depth of the view on the ground, world units. */
  halfW: number;
  halfD: number;
  /** Renderer zoom (MIN 0.5 .. MAX 3.6, larger = closer). */
  zoom: number;
}

export interface Spatial {
  /** Distance gain 0..1. */
  gain: number;
  /** Stereo pan -1..1. */
  pan: number;
  /** Low-pass cut-off, Hz. */
  lp: number;
  /** Propagation delay, seconds (0..MAX_DELAY). */
  delay: number;
  /** Extra reverb send 0..1 (distant sounds are more reverberant). */
  wet: number;
  /** How far outside the screen, in half-screens (0 = on screen). */
  off: number;
  /** Screen position, -1..1 = on screen (x right, y up). */
  ndcX: number;
  ndcY: number;
  /** The old (pre-positional) on-screen fall-off * zoom factor: what the battle music listens to. */
  heat: number;
}

/** Light beats sound, but a long wait after the flash feels laggy. */
export const MAX_DELAY = 0.3;
/** Seconds of delay per world unit beyond the camera's own height (about 5.5 m per tile). */
const DELAY_PER_UNIT = 0.016;
/** Camera height above the view centre relative to the visible view height. */
const CAM_HEIGHT = 0.62;
/** Reference distance: full level within this many world units of the camera. */
const REF_DIST = 9.5;
/** Distance law exponent (1 = physical inverse distance; softer keeps a battle readable). */
const ROLLOFF = 0.62;
/** Air absorption: cut-off = AIR_F * exp(-r / AIR_R). */
const AIR_F = 20000;
const AIR_R = 30;
/** Off-screen pan saturates at this value so off-screen sounds never collapse to one ear. */
const PAN_MAX = 0.92;

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** A default listener (used before the game reports the camera). */
export function defaultListener(): Listener {
  return { cx: 0, cy: 0, rx: 1, ry: 0, halfW: 9, halfD: 7, zoom: 1.8 };
}

/**
 * Spatial parameters of a sound at (x, y) with altitude z for this listener.
 * Writes into `out` (no allocation) and returns it.
 */
export function spatialize(l: Listener, x: number, y: number, z: number, out: Spatial): Spatial {
  const dx = x - l.cx;
  const dy = y - l.cy;
  // screen axes on the ground: right and "up the screen" (away from the camera)
  const sx = dx * l.rx + dy * l.ry;
  const sy = dx * l.ry - dy * l.rx;
  const halfW = Math.max(0.5, l.halfW);
  const halfD = Math.max(0.5, l.halfD);
  const ndcX = sx / halfW;
  const ndcY = sy / halfD;
  out.ndcX = ndcX;
  out.ndcY = ndcY;
  const offX = Math.max(0, Math.abs(ndcX) - 1);
  const offY = Math.max(0, Math.abs(ndcY) - 1);
  const off = Math.max(offX, offY);
  out.off = off;

  // pan: linear across the screen, saturating smoothly beyond its edges
  const px = Math.abs(ndcX) <= 1 ? ndcX * 0.8 : Math.sign(ndcX) * (0.8 + (PAN_MAX - 0.8) * (1 - Math.exp(-(Math.abs(ndcX) - 1) * 2)));
  out.pan = Number.isFinite(px) ? px : 0;

  // distance from the camera (which hovers above the view centre)
  const h = Math.max(1, CAM_HEIGHT * 2 * Math.min(halfD, halfW));
  const zz = Number.isFinite(z) ? Math.max(0, z) : 0;
  const ground = Math.hypot(dx, dy);
  const r = Math.hypot(ground, h - Math.min(zz, h * 0.8));
  let g = Math.min(1, Math.pow(REF_DIST / Math.max(0.001, r), ROLLOFF));
  // off-screen: still audible, but behind a wall of air
  g *= 1 / (1 + 0.55 * off);
  out.gain = Number.isFinite(g) ? g : 0;

  let lp = AIR_F * Math.exp(-r / AIR_R);
  lp /= 1 + 3 * off;
  out.lp = lp < 220 ? 220 : lp > 20000 ? 20000 : lp;

  const d = (r - h) * DELAY_PER_UNIT;
  out.delay = d <= 0 || !Number.isFinite(d) ? 0 : d > MAX_DELAY ? MAX_DELAY : d;

  out.wet = clamp01(0.55 * (1 - out.gain) + 0.25 * Math.min(1, off));

  // music heat: the old screen-pixel fall-off (0.6 screen widths) and zoom factor
  const aspect = halfW / halfD;
  const fall = Math.max(0, 1 - Math.max(offX / 1.2, offY / (1.2 * Math.max(0.2, aspect))));
  out.heat = fall * (0.5 + 0.5 * Math.min(1, l.zoom));
  return out;
}

export function makeSpatial(): Spatial {
  return { gain: 1, pan: 0, lp: 20000, delay: 0, wet: 0, off: 0, ndcX: 0, ndcY: 0, heat: 1 };
}

/** Doppler playback-rate factor for a source moving at radial speed `vr` (world units / s, + = receding). */
export function doppler(vr: number, c = 40): number {
  if (!Number.isFinite(vr)) return 1;
  const k = c / (c + Math.max(-0.6 * c, Math.min(0.6 * c, vr)));
  return k < 0.75 ? 0.75 : k > 1.33 ? 1.33 : k;
}

// ---------------------------------------------------------------------------
// Voice priority
// ---------------------------------------------------------------------------

export interface VoiceInfo {
  /** Sound name (for per-name caps). */
  name: string;
  /** Audible level when started (level * distance gain). */
  level: number;
  /** Priority class weight (explosions > launches > small arms). */
  weight: number;
  start: number;
  end: number;
}

/** How much a voice is worth keeping right now. Fresh, loud, important voices score highest. */
export function voiceScore(v: VoiceInfo, now: number): number {
  const life = Math.max(0.001, v.end - v.start);
  const remaining = clamp01((v.end - now) / life);
  // a voice still waiting out its propagation delay has not been heard yet: full value
  const fresh = now < v.start ? 1 : remaining;
  return v.level * v.weight * (0.3 + 0.7 * fresh);
}

/**
 * Decide where a new voice goes. Returns
 *  - the index of a voice to steal,
 *  - -1 to start it in a free slot,
 *  - -2 to drop the newcomer (it would be the least important sound playing).
 * `cap` limits concurrent voices of the same name (rifles in a big firefight).
 */
export function chooseSlot(voices: readonly VoiceInfo[], max: number, nv: VoiceInfo, cap: number, now: number): number {
  const newScore = voiceScore(nv, now);
  let same = 0;
  let sameIdx = -1;
  let sameBest = Infinity;
  for (let i = 0; i < voices.length; i++) {
    const v = voices[i];
    if (v.name !== nv.name) continue;
    same++;
    const s = voiceScore(v, now);
    if (s < sameBest) {
      sameBest = s;
      sameIdx = i;
    }
  }
  if (same >= cap) {
    // replace the weakest voice of the same sound, unless the newcomer is weaker still
    return sameIdx >= 0 && newScore >= sameBest * 0.9 ? sameIdx : -2;
  }
  if (voices.length < max) return -1;
  let victim = -1;
  let best = Infinity;
  for (let i = 0; i < voices.length; i++) {
    const s = voiceScore(voices[i], now);
    if (s < best) {
      best = s;
      victim = i;
    }
  }
  // a newcomer quieter than everything already playing is dropped instead (hysteresis avoids churn)
  if (victim < 0 || newScore < best * 1.15) return -2;
  return victim;
}

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

function smooth(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/**
 * How much of the night chorus (crickets) to play, 0..1, for a fixed time of day
 * or the dynamic cycle phase (0 = midday, 0.5 = middle of the night).
 */
export function nightAmount(tod: string, phase: number): number {
  if (tod === 'cycle' && phase >= 0) {
    const u = phase - Math.floor(phase);
    // dusk 0.425 .. dark at 0.5 .. predawn 0.77 .. dawn 0.81
    return smooth(0.41, 0.5, u) * (1 - smooth(0.74, 0.82, u));
  }
  if (tod === 'night') return 1;
  if (tod === 'dusk') return 0.55;
  if (tod === 'mist') return 0.15;
  return 0;
}

/** Smooth value noise in 0..1 (gusts); deterministic, allocation-free. */
export function gust(t: number, seed = 0): number {
  const n = (k: number) => {
    const s = Math.sin(k * 127.1 + seed * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const a = Math.floor(t);
  const f = t - a;
  const u = f * f * (3 - 2 * f);
  return n(a) * (1 - u) + n(a + 1) * u;
}
