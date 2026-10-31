import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetTelemetryForTests, capture, posthogConfig, setConsent, shouldAskConsent, startTelemetry, telemetryActive, type PostHogLike } from '../src/telemetry/client';
import { __resetEventsForTests, setErrorContext, trackAppLoaded, trackError, trackMatchStarted, trackTutorialStep, trackUiAction, type AppLoadedProps, type MatchStartedProps } from '../src/telemetry/events';
import { CONSENT_KEY } from '../src/telemetry/consent';
import { posthogKey, posthogHost } from '../src/telemetry/config';
import { MatchTelemetry } from '../src/telemetry/match';
import { FrameStats } from '../src/telemetry/perf';
import { TPS, type SimEvent } from '../src/sim/types';
import { DEFS } from '../src/sim/defs';

/*
 * Developer analytics (src/telemetry): consent gating, no-op without a key, payload shapes,
 * error dedupe / cap. posthog-js itself is mocked (the loader is swapped), so nothing here
 * touches the network.
 */

interface Call {
  fn: string;
  args: unknown[];
}

function mockPosthog() {
  const calls: Call[] = [];
  let optedOut = false;
  const ph: PostHogLike = {
    init: (...a) => void calls.push({ fn: 'init', args: a }),
    capture: (...a) => void calls.push({ fn: 'capture', args: a }),
    register: (...a) => void calls.push({ fn: 'register', args: a }),
    opt_in_capturing: () => {
      optedOut = false;
      calls.push({ fn: 'opt_in', args: [] });
    },
    opt_out_capturing: () => {
      optedOut = true;
      calls.push({ fn: 'opt_out', args: [] });
    },
    has_opted_out_capturing: () => optedOut,
  };
  const loader = vi.fn(async () => ph);
  const events = () => calls.filter((c) => c.fn === 'capture').map((c) => ({ name: c.args[0] as string, props: c.args[1] as Record<string, unknown>, opts: c.args[2] as Record<string, unknown> | undefined }));
  return { ph, calls, loader, events };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

const APP: AppLoadedProps = { load_ms: 4200, device: 'phone', screen_w: 860, screen_h: 400, viewport_w: 860, viewport_h: 400, dpr: 2.6, quality_setting: 'auto', quality: 'medium', controls: 'simple' };
const INFO: MatchStartedProps = { map: 'frontline', faction: 'usa', enemy: ['russia'], difficulty: 'normal', game_speed: 'normal', grace: 'auto', grace_min: 6, ai_count: 1, quality: 'medium', controls: 'simple', credits: 10000, auto_defend: true };

let mock: ReturnType<typeof mockPosthog>;

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', fakeStorage);
  vi.stubEnv('VITE_POSTHOG_KEY', 'phc_testkey123');
  vi.stubEnv('VITE_POSTHOG_HOST', 'https://eu.i.posthog.com/');
  mock = mockPosthog();
  __resetTelemetryForTests(mock.loader);
  __resetEventsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('telemetry config', () => {
  it('reads the key / host from the env; only phc_ keys count', () => {
    expect(posthogKey()).toBe('phc_testkey123');
    expect(posthogHost()).toBe('https://eu.i.posthog.com');
    vi.stubEnv('VITE_POSTHOG_KEY', 'not-a-key');
    expect(posthogKey()).toBe('');
    vi.stubEnv('VITE_POSTHOG_HOST', '');
    expect(posthogHost()).toBe('https://us.i.posthog.com');
  });

  it('privacy options: anonymous, no IP, no text inputs, no recording', () => {
    const c = posthogConfig() as Record<string, any>;
    expect(c.person_profiles).toBe('never');
    expect(c.ip).toBe(false);
    expect(c.respect_dnt).toBe(true);
    expect(c.disable_session_recording).toBe(true);
    expect(c.session_recording.maskAllInputs).toBe(true);
    expect(c.autocapture.css_selector_ignorelist).toContain('input');
    expect(c.autocapture.css_selector_ignorelist).toContain('textarea');
    expect(c.autocapture.element_allowlist).not.toContain('input');
    expect(c.autocapture.capture_copied_text).toBe(false);
    const ev = { properties: { $ip: '1.2.3.4', a: 1 } };
    expect(c.before_send(ev).properties).toEqual({ a: 1 });
  });
});

describe('telemetry consent gating', () => {
  it('no key: a complete no-op (never loads posthog), no consent notice', async () => {
    vi.stubEnv('VITE_POSTHOG_KEY', '');
    expect(shouldAskConsent()).toBe(false);
    setConsent('granted');
    capture('x');
    trackMatchStarted(INFO);
    trackError('error', 'boom');
    await startTelemetry();
    await flush();
    expect(mock.loader).not.toHaveBeenCalled();
    expect(mock.calls).toEqual([]);
  });

  it('nothing before Allow: no init, no events, no loading', async () => {
    expect(shouldAskConsent()).toBe(true);
    trackAppLoaded(APP);
    trackMatchStarted(INFO);
    trackUiAction('pause');
    trackError('error', 'early error');
    await startTelemetry();
    await flush();
    expect(mock.loader).not.toHaveBeenCalled();
    expect(mock.calls).toEqual([]);
    expect(telemetryActive()).toBe(false);
  });

  it('Allow: loads + inits posthog, then sends app_loaded (kept from before) and later events', async () => {
    trackAppLoaded(APP);
    setConsent('granted');
    expect(store.get(CONSENT_KEY)).toBe('granted');
    await flush();
    expect(mock.loader).toHaveBeenCalledTimes(1);
    const init = mock.calls.find((c) => c.fn === 'init')!;
    expect(init.args[0]).toBe('phc_testkey123');
    expect((init.args[1] as Record<string, unknown>).api_host).toBe('https://eu.i.posthog.com');
    expect(mock.events().map((e) => e.name)).toEqual(['app_loaded']);
    expect(mock.events()[0].props).toMatchObject({ load_ms: 4200, device: 'phone', dpr: 2.6, quality: 'medium', controls: 'simple' });
    trackMatchStarted(INFO);
    expect(mock.events()[1]).toMatchObject({ name: 'match_started', props: INFO });
    // app_loaded is once per page load
    trackAppLoaded(APP);
    expect(mock.events().filter((e) => e.name === 'app_loaded').length).toBe(1);
  });

  it('events captured while the chunk loads are queued, then sent in order', async () => {
    setConsent('granted');
    capture('a', { n: 1 });
    capture('b', { n: 2 });
    await flush();
    expect(mock.events().map((e) => e.name)).toEqual(['a', 'b']);
  });

  it('a saved Allow from an earlier session: active at once; No stops everything', async () => {
    store.set(CONSENT_KEY, 'granted');
    __resetTelemetryForTests(mock.loader);
    __resetEventsForTests();
    expect(shouldAskConsent()).toBe(false);
    await startTelemetry();
    capture('one');
    expect(mock.events().length).toBe(1);
    setConsent('denied');
    expect(mock.calls.some((c) => c.fn === 'opt_out')).toBe(true);
    capture('two');
    trackMatchStarted(INFO);
    expect(mock.events().length).toBe(1);
    // and back on: posthog's own opt-out is lifted
    setConsent('granted');
    expect(mock.calls.some((c) => c.fn === 'opt_in')).toBe(true);
    capture('three');
    expect(mock.events().map((e) => e.name)).toEqual(['one', 'three']);
  });

  it('No thanks: posthog is never loaded', async () => {
    setConsent('denied');
    capture('x');
    await flush();
    expect(mock.loader).not.toHaveBeenCalled();
    expect(shouldAskConsent()).toBe(false);
  });

  it('Do Not Track: never loads, never asks', async () => {
    vi.stubGlobal('navigator', { doNotTrack: '1' });
    expect(shouldAskConsent()).toBe(false);
    setConsent('granted');
    capture('x');
    await flush();
    expect(mock.loader).not.toHaveBeenCalled();
  });

  it('posthog blocked (ad blocker / offline): quiet, no throw', async () => {
    const failing = vi.fn(async () => {
      throw new Error('blocked');
    });
    __resetTelemetryForTests(failing);
    __resetEventsForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setConsent('granted');
    capture('x');
    await flush();
    expect(() => capture('y')).not.toThrow();
    expect(failing).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('telemetry events', () => {
  beforeEach(async () => {
    setConsent('granted');
    await startTelemetry();
  });

  it('errors: deduplicated by message, capped at 20 per session, stack truncated to 2 KB, with context', () => {
    setErrorContext(() => ({ map: 'desert', match_min: 4.5, quality: 'low' }));
    expect(trackError('error', 'same', 'x'.repeat(5000))).toBe(true);
    expect(trackError('error', 'same')).toBe(false);
    for (let i = 0; i < 30; i++) trackError('error', 'err ' + i);
    const errs = mock.events().filter((e) => e.name === 'error');
    expect(errs.length).toBe(20);
    expect((errs[0].props.stack as string).length).toBe(2048);
    expect(errs[0].props).toMatchObject({ kind: 'error', message: 'same', map: 'desert', match_min: 4.5, quality: 'low' });
  });

  it('ui_action: rate-limited per action', () => {
    expect(trackUiAction('pause', undefined, 1000)).toBe(true);
    expect(trackUiAction('pause', undefined, 1500)).toBe(false);
    expect(trackUiAction('build_tab', 'infantry', 1500)).toBe(true);
    expect(trackUiAction('build_tab', 'vehicle', 1600)).toBe(true);
    expect(trackUiAction('pause', undefined, 3500)).toBe(true);
    const ui = mock.events().filter((e) => e.name === 'ui_action');
    expect(ui.map((e) => e.props)).toEqual([{ action: 'pause' }, { action: 'build_tab', detail: 'infantry' }, { action: 'build_tab', detail: 'vehicle' }, { action: 'pause' }]);
  });

  it('hints: each text once per session; milestones every time', () => {
    trackTutorialStep('hint', { hint: 'Deploy your MCV' });
    trackTutorialStep('hint', { hint: 'Deploy your MCV' });
    trackTutorialStep('first_unit', { match_min: 1 });
    trackTutorialStep('first_unit', { match_min: 2 });
    expect(mock.events().filter((e) => e.name === 'tutorial_step').length).toBe(3);
  });
});

describe('match telemetry', () => {
  const unitOf = (cat: string) => Object.keys(DEFS).find((k) => DEFS[k].kind === 'unit' && (DEFS[k] as { category?: string }).category === cat && !(DEFS[k] as { temp?: boolean }).temp)!;

  beforeEach(async () => {
    setConsent('granted');
    await startTelemetry();
  });

  it('match_started on the first tick, match_ended with the full payload; finish only once', () => {
    let t = 0;
    const world = { tick: 0, players: [{ credits: 10000 }, { credits: 10000 }] };
    const ai = { stats: { waves: 3, pincers: 1, combined: 2, marches: 0, feints: 1, firstWave: TPS * 60 * 7, lanes: ['a'] }, react: { stats: { snipersPosted: 2, overwatch: 1 } } };
    const m = new MatchTelemetry({ world, local: 0, info: INFO, device: 'phone', ai, qualityLevel: () => 1, now: () => t });
    m.frame();
    expect(mock.events().length).toBe(0); // not started yet (briefing)
    const inf = unitOf('infantry');
    const veh = unitOf('vehicle');
    const air = unitOf('air');
    world.tick = 1;
    m.frame();
    expect(mock.events().map((e) => e.name)).toEqual(['match_started']);
    const ev = (e: SimEvent) => m.onEvent(e);
    for (let i = 0; i < 4; i++) ev({ t: 'unitReady', owner: 0, def: inf });
    for (let i = 0; i < 2; i++) ev({ t: 'unitReady', owner: 0, def: veh });
    ev({ t: 'unitReady', owner: 0, def: air });
    for (let i = 0; i < 3; i++) ev({ t: 'unitReady', owner: 1, def: veh });
    ev({ t: 'deployed', id: 1, owner: 0 });
    ev({ t: 'placed', id: 2, owner: 0 });
    ev({ t: 'death', id: 3, def: inf, x: 0, y: 0, owner: 0, kind: 'unit' });
    ev({ t: 'death', id: 4, def: veh, x: 0, y: 0, owner: 1, kind: 'unit' });
    ev({ t: 'death', id: 5, def: 'x', x: 0, y: 0, owner: 1, kind: 'building' });
    world.tick = TPS * 60 * 8;
    ev({ t: 'underAttack', owner: 0, x: 1, y: 1 });
    ev({ t: 'underAttack', owner: 0, x: 1, y: 1 });
    // credits: spend 3000, earn 1200
    for (const c of [9000, 7000, 8200]) {
      t += 16;
      world.players[0].credits = c;
      m.frame();
    }
    world.tick = TPS * 60 * 12;
    t = 6 * 60000;
    m.finish('win');
    m.finish('quit'); // (later quit / destroy: ignored)
    const names = mock.events().map((e) => e.name);
    expect(names.filter((n) => n === 'match_ended').length).toBe(1);
    expect(names).toContain('perf_sample');
    const end = mock.events().find((e) => e.name === 'match_ended')!.props;
    expect(end).toMatchObject({
      result: 'win',
      map: 'frontline',
      faction: 'usa',
      enemy: ['russia'],
      difficulty: 'normal',
      game_min: 12,
      first_attack_min: 8,
      units_built: { infantry: 4, vehicle: 2, air: 1, naval: 0 },
      units_lost: { infantry: 1, vehicle: 0, air: 0, naval: 0 },
      units_built_total: 7,
      units_lost_total: 1,
      units_killed: 1,
      buildings_built: 2,
      buildings_lost: 0,
      buildings_destroyed: 1,
      credits_earned: 1200,
      credits_spent: 3000,
      top_units: [inf, veh, air],
      top_units_n: [4, 2, 1],
      enemy_top_units: [veh],
      enemy_top_units_n: [3],
      enemy_units_built: 3,
      superweapons_used: 0,
    });
    expect(end.real_min).toBeCloseTo(6, 1);
    expect(end.ai).toMatchObject({ waves: 3, pincers: 1, combined: 2, first_wave_min: 7, react_snipersPosted: 2, react_overwatch: 1 });
    // first structure / first unit / first kill milestones
    const steps = mock.events().filter((e) => e.name === 'tutorial_step').map((e) => e.props.step);
    expect(steps).toEqual(expect.arrayContaining(['first_unit', 'mcv_deployed', 'first_structure', 'first_kill']));
  });

  it('perf_sample about 3 match minutes in, then at the end', () => {
    let t = 0;
    const world = { tick: 1, players: [{ credits: 0 }] };
    const m = new MatchTelemetry({ world, local: 0, info: INFO, device: 'desktop', now: () => t });
    for (let i = 0; i < 200; i++) {
      t += i % 50 === 0 ? 40 : 16;
      world.tick += 20;
      m.frame();
    }
    const perf = mock.events().filter((e) => e.name === 'perf_sample');
    expect(perf.length).toBe(1);
    expect(perf[0].props).toMatchObject({ at: 'mid', quality: 'medium', device: 'desktop' });
    expect(perf[0].props.avg_fps as number).toBeGreaterThan(50);
    expect(perf[0].props.frame_ms_p95 as number).toBeLessThanOrEqual(17);
    m.finish('quit', true);
    const end = mock.events().filter((e) => e.name === 'perf_sample' || e.name === 'match_ended');
    expect(end.slice(1).map((e) => [e.name, e.opts?.transport])).toEqual([
      ['match_ended', 'sendBeacon'],
      ['perf_sample', 'sendBeacon'],
    ]);
  });

  it('a match left before it started (briefing) sends nothing', () => {
    const m = new MatchTelemetry({ world: { tick: 0, players: [{ credits: 0 }] }, local: 0, info: INFO, device: 'phone' });
    m.frame();
    m.finish('quit');
    expect(mock.events()).toEqual([]);
  });
});

describe('frame stats', () => {
  it('avg / min / p5 fps and the p95 frame time', () => {
    const f = new FrameStats();
    let t = 0;
    // 10 s at 60 fps, then 2 s at 20 fps
    for (let i = 0; i < 600; i++) f.add(1000 / 60, (t += 1000 / 60));
    for (let i = 0; i < 40; i++) f.add(50, (t += 50));
    f.add(5000, t + 5000); // a hidden tab: ignored
    const s = f.summary();
    expect(s.frames).toBe(640);
    expect(s.min_fps).toBe(20);
    expect(s.frame_ms_p95).toBe(51);
    expect(s.avg_fps).toBeCloseTo(640 / 12, 0);
  });
});

describe('telemetry stays out of the simulation', () => {
  it('no sim module imports telemetry or posthog, and telemetry never mutates the world', async () => {
    const sim = import.meta.glob('../src/sim/**/*.ts', { query: '?raw', eager: true, import: 'default' }) as Record<string, string>;
    const files = Object.keys(sim);
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) expect(sim[f], f).not.toMatch(/telemetry|posthog/);
    // the tracker only ever reads: a frozen world view works
    const world = Object.freeze({ tick: 5, players: Object.freeze([Object.freeze({ credits: 100 })]) });
    const m = new MatchTelemetry({ world, local: 0, info: INFO, device: 'phone', now: () => 1 });
    expect(() => {
      m.frame();
      m.onEvent({ t: 'underAttack', owner: 0, x: 0, y: 0 });
      m.finish('loss');
    }).not.toThrow();
    const src = Object.values(import.meta.glob('../src/telemetry/match.ts', { query: '?raw', eager: true, import: 'default' }))[0] as string;
    expect(src).not.toMatch(/Math\.random|\.rng\b|world\.issue|\.step\(\)/);
  });
});
