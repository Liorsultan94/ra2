import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS_KEY, loadSettings, saveSettings } from '../src/ui/settings';

/** Minimal in-memory localStorage. */
function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

const g = globalThis as unknown as { localStorage?: unknown };
let prev: unknown;

describe('settings', () => {
  beforeEach(() => {
    prev = g.localStorage;
    g.localStorage = fakeStorage();
  });
  afterEach(() => {
    g.localStorage = prev;
  });

  it('defaults: peace time by difficulty, normal game speed', () => {
    const s = loadSettings();
    expect(s.peace).toBe('auto');
    expect(s.gameSpeed).toBe('normal');
  });

  it('peace time and game speed round-trip with the other settings', () => {
    for (const [peace, gameSpeed] of [
      ['off', 'slow'],
      ['3', 'fast'],
      ['6', 'normal'],
      ['10', 'fast'],
      ['15', 'slow'],
      ['auto', 'normal'],
    ] as const) {
      const s = loadSettings();
      s.peace = peace;
      s.gameSpeed = gameSpeed;
      s.difficulty = 'hard';
      s.credits = 20000;
      saveSettings(s);
      const back = loadSettings();
      expect(back).toEqual(s);
      expect(back.peace).toBe(peace);
      expect(back.gameSpeed).toBe(gameSpeed);
    }
  });

  it('auto-defend defaults to on, round-trips and falls back; there is no fog of war setting any more', () => {
    const s = loadSettings();
    expect('fog' in s).toBe(false);
    expect(s.autoDefend).toBe(true);
    s.autoDefend = false;
    saveSettings(s);
    const back = loadSettings();
    expect(back.autoDefend).toBe(false);
    const ls = g.localStorage as ReturnType<typeof fakeStorage>;
    ls.setItem(SETTINGS_KEY, JSON.stringify({ autoDefend: 'yes' }));
    const bad = loadSettings();
    expect(bad.autoDefend).toBe(true);
  });

  it('old saved settings with a fog of war choice still load (the choice is dropped: the fog is automatic now)', () => {
    const ls = g.localStorage as ReturnType<typeof fakeStorage>;
    for (const fog of ['modern', 'classic', 'thick', 7, null]) {
      ls.setItem(SETTINGS_KEY, JSON.stringify({ fog, difficulty: 'hard', credits: 20000, autoDefend: false }));
      const s = loadSettings();
      expect('fog' in s).toBe(false);
      expect(s.difficulty).toBe('hard');
      expect(s.credits).toBe(20000);
      expect(s.autoDefend).toBe(false);
      // saving again writes no fog key
      saveSettings(s);
      expect(JSON.parse(ls.getItem(SETTINGS_KEY)!).fog).toBeUndefined();
    }
  });

  it('older saves and bad values fall back to the defaults', () => {
    const ls = g.localStorage as ReturnType<typeof fakeStorage>;
    ls.setItem(SETTINGS_KEY, JSON.stringify({ difficulty: 'easy', credits: 5000 }));
    let s = loadSettings();
    expect(s.difficulty).toBe('easy');
    expect(s.peace).toBe('auto');
    expect(s.gameSpeed).toBe('normal');
    ls.setItem(SETTINGS_KEY, JSON.stringify({ peace: '7', gameSpeed: 'turbo' }));
    s = loadSettings();
    expect(s.peace).toBe('auto');
    expect(s.gameSpeed).toBe('normal');
  });
});
