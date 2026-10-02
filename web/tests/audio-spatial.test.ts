import { describe, expect, it } from 'vitest';
import { MAX_DELAY, chooseSlot, defaultListener, doppler, gust, makeSpatial, nightAmount, spatialize, voiceScore, type Listener, type VoiceInfo } from '../src/audio/spatial';
import { ambienceLevels, defaultAmbience, engineKindFor } from '../src/audio/ambience';
import { finishVariant, loopify } from '../src/audio/bake';
import { outdoorChannel } from '../src/audio/reverb';
import { RADIO, radioFor } from '../src/audio/radio';
import { BAKED, BAKE_ORDER } from '../src/audio/weapons';
import { FACTIONS } from '../src/sim/defs';

/** Classic view: camera from +x/+z looking at (20, 20); screen right is (+x, -y) on the ground. */
function listener(zoom = 2): Listener {
  const l = defaultListener();
  l.cx = 20;
  l.cy = 20;
  l.rx = Math.SQRT1_2;
  l.ry = -Math.SQRT1_2;
  const halfH = 22 / zoom / 2;
  l.halfW = halfH * 1.8;
  l.halfD = halfH / 0.6;
  l.zoom = zoom;
  return l;
}

const at = (l: Listener, sx: number, sy: number, z = 0) => {
  // screen-relative offsets (in world units) to a world position
  const x = l.cx + sx * l.rx + sy * l.ry;
  const y = l.cy + sx * l.ry - sy * l.rx;
  return spatialize(l, x, y, z, makeSpatial());
};

describe('spatialize', () => {
  it('pans by screen x and is centred in the middle', () => {
    const l = listener();
    expect(at(l, 0, 0).pan).toBeCloseTo(0, 5);
    expect(at(l, l.halfW * 0.5, 0).pan).toBeGreaterThan(0.3);
    expect(at(l, -l.halfW * 0.5, 0).pan).toBeLessThan(-0.3);
    // up / down the screen does not pan
    expect(Math.abs(at(l, 0, l.halfD * 0.8).pan)).toBeLessThan(1e-9);
    // off-screen pan saturates below full hard-left/right
    const far = at(l, l.halfW * 6, 0).pan;
    expect(far).toBeGreaterThan(0.85);
    expect(far).toBeLessThan(0.95);
  });

  it('attenuates, darkens and delays with distance', () => {
    const l = listener();
    const near = at(l, 0, 0);
    const edge = at(l, l.halfW, 0);
    const off = at(l, l.halfW * 3, 0);
    expect(near.gain).toBeGreaterThan(0.9);
    expect(edge.gain).toBeLessThan(near.gain);
    expect(off.gain).toBeLessThan(edge.gain);
    expect(off.gain).toBeGreaterThan(0.05); // off-screen combat stays audible
    expect(near.lp).toBeGreaterThan(12000);
    expect(off.lp).toBeLessThan(2500); // ... but muffled
    expect(off.off).toBeGreaterThan(1.5);
    expect(near.delay).toBe(0);
    expect(edge.delay).toBeGreaterThan(0);
    expect(edge.delay).toBeLessThan(0.15);
    expect(at(l, l.halfW * 20, 0).delay).toBe(MAX_DELAY);
    expect(off.wet).toBeGreaterThan(near.wet);
  });

  it('zooming out makes the battle quieter overall', () => {
    expect(at(listener(0.5), 0, 0).gain).toBeLessThan(at(listener(2), 0, 0).gain * 0.7);
    expect(at(listener(3.5), 0, 0).gain).toBe(1);
  });

  it('keeps the old on-screen music heat fall-off', () => {
    const l = listener(1);
    expect(at(l, 0, 0).heat).toBe(1);
    expect(at(l, l.halfW * 0.99, 0).heat).toBe(1);
    expect(at(l, l.halfW * 2.3, 0).heat).toBeLessThan(0.1);
    expect(listener(0.5) && at(listener(0.5), 0, 0).heat).toBeCloseTo(0.75);
  });

  it('never produces NaN', () => {
    const l = listener();
    const s = spatialize(l, NaN, 5, Infinity, makeSpatial());
    for (const v of [s.pan, s.lp, s.delay]) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('voice priority', () => {
  const v = (name: string, level: number, weight = 1, start = 0, end = 1): VoiceInfo => ({ name, level, weight, start, end });

  it('uses a free slot while under the limit', () => {
    expect(chooseSlot([v('rifle', 0.5)], 24, v('cannon', 0.5), 4, 0.1)).toBe(-1);
  });

  it('steals the weakest voice when full, and drops a weaker newcomer', () => {
    const vs = [v('cannon', 0.8, 1.5), v('rifle', 0.05, 0.8), v('explosionLarge', 0.9, 2.6)];
    expect(chooseSlot(vs, 3, v('cannon', 0.6, 1.5, 0.1, 1.1), 5, 0.1)).toBe(1);
    // a distant rifle shot is less important than everything playing: dropped
    expect(chooseSlot(vs, 3, v('rifle', 0.01, 0.8, 0.1, 0.4), 5, 0.1)).toBe(-2);
  });

  it('prefers stealing voices that are nearly finished', () => {
    const now = 0.95;
    const old = v('mg', 0.5, 1, 0, 1); // 5% left
    const fresh = v('mg', 0.4, 1, 0.9, 1.9); // just started
    expect(voiceScore(old, now)).toBeLessThan(voiceScore(fresh, now));
    expect(chooseSlot([old, fresh], 2, v('cannon', 0.4, 1.5, now, now + 1), 9, now)).toBe(0);
  });

  it('caps one sound so a firefight does not drown everything', () => {
    const vs = [v('rifle', 0.5), v('rifle', 0.3), v('rifle', 0.6)];
    // at the cap the weakest rifle is replaced by a louder one ...
    expect(chooseSlot(vs, 24, v('rifle', 0.5, 1, 0.1, 1.1), 3, 0.1)).toBe(1);
    // ... and a quieter one is dropped, even with free slots
    expect(chooseSlot(vs, 24, v('rifle', 0.05, 1, 0.1, 1.1), 3, 0.1)).toBe(-2);
  });

  it('a 200-shot battle never exceeds the voice budget', () => {
    const playing: VoiceInfo[] = [];
    const names = ['rifle', 'mg', 'cannon', 'explosionSmall', 'explosionMedium', 'explosionLarge'];
    let dropped = 0;
    for (let i = 0; i < 200; i++) {
      const now = i * 0.02;
      for (let k = playing.length - 1; k >= 0; k--) if (playing[k].end < now) playing.splice(k, 1);
      const name = names[i % names.length];
      const nv = v(name, 0.1 + ((i * 37) % 10) / 10, 1 + (i % 3), now, now + 1 + (i % 4) * 0.5);
      const slot = chooseSlot(playing, 24, nv, 5, now);
      if (slot === -2) dropped++;
      else {
        if (slot >= 0) playing.splice(slot, 1);
        playing.push(nv);
      }
      expect(playing.length).toBeLessThanOrEqual(24);
      expect(playing.filter((p) => p.name === name).length).toBeLessThanOrEqual(5);
    }
    expect(dropped).toBeGreaterThan(0);
  });
});

describe('environment helpers', () => {
  it('doppler raises approaching and lowers receding sources', () => {
    expect(doppler(0)).toBe(1);
    expect(doppler(-10)).toBeGreaterThan(1);
    expect(doppler(10)).toBeLessThan(1);
    expect(doppler(1e9)).toBeGreaterThanOrEqual(0.75);
    expect(doppler(NaN)).toBe(1);
  });

  it('night chorus follows the time of day and the cycle', () => {
    expect(nightAmount('day', -1)).toBe(0);
    expect(nightAmount('night', -1)).toBe(1);
    expect(nightAmount('cycle', 0)).toBe(0);
    expect(nightAmount('cycle', 0.6)).toBe(1);
    expect(nightAmount('cycle', 0.95)).toBe(0);
    expect(nightAmount('dusk', -1)).toBeGreaterThan(0);
  });

  it('gust noise is smooth and bounded', () => {
    let prev = gust(0);
    for (let t = 0.01; t < 20; t += 0.01) {
      const g = gust(t);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
      expect(Math.abs(g - prev)).toBeLessThan(0.05);
      prev = g;
    }
  });

  it('ambience levels follow the weather', () => {
    const s = defaultAmbience();
    expect(ambienceLevels(s, 0).wind).toBe(0); // off in the menu
    s.on = true;
    const calm = ambienceLevels(s, 3);
    expect(calm.rain).toBe(0);
    expect(calm.crickets).toBe(0);
    s.night = 1;
    expect(ambienceLevels(s, 3).crickets).toBeGreaterThan(0);
    s.rain = 1;
    s.wind = 0.6;
    const wet = ambienceLevels(s, 3);
    expect(wet.rain).toBeGreaterThan(0.3);
    expect(wet.crickets).toBe(0); // insects hide in the rain
    s.wind = 1;
    expect(ambienceLevels({ ...s, wind: 1 }, 3).wind).toBeGreaterThan(ambienceLevels({ ...s, wind: 0.1 }, 3).wind);
    s.river = 1;
    expect(ambienceLevels(s, 3).river).toBeGreaterThan(0);
  });

  it('maps aircraft to engine sounds', () => {
    expect(engineKindFor('fighter', true, false)).toBe('jet');
    expect(engineKindFor('tr_c130j', true, true)).toBe('turboprop');
    expect(engineKindFor('heli', false, false)).toBe('rotor');
    expect(engineKindFor('fpv', false, false)).toBe('fpv');
    expect(engineKindFor('shahed', false, false)).toBe('prop');
  });
});

describe('baking helpers', () => {
  it('normalises, trims and fades a variant', () => {
    const d = new Float32Array(48000);
    for (let i = 0; i < 4800; i++) d[i] = Math.sin(i * 0.1) * 3 * (1 - i / 4800);
    const { data, peak } = finishVariant([d], 0.89);
    expect(peak).toBeGreaterThan(2.5);
    const out = data[0];
    expect(out.length).toBeLessThan(6000); // trailing silence trimmed
    let m = 0;
    for (const x of out) m = Math.max(m, Math.abs(x));
    expect(m).toBeLessThanOrEqual(0.8901);
    expect(out[out.length - 1]).toBe(0);
  });

  it('crossfades a loop so the end flows into the start', () => {
    const sr = 1000;
    const L = 1000;
    const X = 100;
    const d = new Float32Array(L + X);
    for (let i = 0; i < d.length; i++) d[i] = Math.sin((2 * Math.PI * 5 * i) / sr); // whole periods
    const o = loopify(d, L, X);
    expect(o.length).toBe(L);
    // the wrap step is as small as an ordinary step
    expect(Math.abs(o[0] - o[L - 1])).toBeLessThan(0.05);
  });

  it('synthesises a finite outdoor impulse response with slap-back echoes', () => {
    const sr = 8000;
    const d = new Float32Array(sr);
    outdoorChannel(d, sr, { seconds: 1, t60: 1, taps: 7, seed: 3 }, 0);
    let e = 0;
    for (const x of d) {
      expect(Number.isFinite(x)).toBe(true);
      e += x * x;
    }
    expect(e).toBeGreaterThan(0.1);
    // more energy in the first 300 ms (slap) than in the last 300 ms
    let a = 0;
    let b = 0;
    for (let i = 0; i < 0.3 * sr; i++) a += d[i] * d[i];
    for (let i = d.length - 0.3 * sr; i < d.length; i++) b += d[i] * d[i];
    expect(a).toBeGreaterThan(b * 4);
  });

  it('bakes every table entry in order and keeps memory in budget', () => {
    expect(new Set(BAKE_ORDER).size).toBe(Object.keys(BAKED).length);
    let bytes = 0;
    for (const n of BAKE_ORDER) {
      const d = BAKED[n];
      bytes += (d.dur + (d.loop ?? 0)) * d.sr * d.variants * (d.stereo ? 2 : 1) * 4;
    }
    // upper bound before trimming: well under what a phone can spare
    expect(bytes / 1e6).toBeLessThan(24);
  });
});

describe('radio', () => {
  it('has a distinct radio for every nation', () => {
    const seen = new Set<string>();
    for (const f of FACTIONS) {
      const r = RADIO[f.id];
      expect(r, f.id).toBeTruthy();
      const key = `${r.lo}/${r.hi}/${r.staticLvl}/${r.beep.join(',')}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(radioFor('nowhere')).toBe(RADIO.usa);
  });
});
