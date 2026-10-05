import { describe, expect, it } from 'vitest';
import { Tile, type GameMap } from '../src/sim/map';
import { createMap } from '../src/sim/maps';
import { FogOfWar } from '../src/render/fog';
import { BattleScars } from '../src/render/scars';
import type { Effects } from '../src/render/effects';

/*
 * Battle scars (render/scars.ts) placement rules: no crater floating over a river, none on a standing
 * building's tiles, and a building going up clears the old battle off its footprint.
 */
const fx = { rate: 1, dust() {}, smoke() {}, flame() {}, burnGlow() {} } as unknown as Effects;

function scarsFor(m: GameMap, occupied: (x: number, z: number) => boolean = () => false) {
  return new BattleScars({ map: m, fog: new FogOfWar(m.w, m.h), effects: fx, quality: 'medium', visibleAt: () => true, isPaved: () => false, occupied });
}

/** A land tile centre next to water (or far from it: `far`). */
function landTile(m: GameMap, nearWater: boolean): { x: number; z: number } {
  for (let y = 4; y < m.h - 4; y++)
    for (let x = 4; x < m.w - 4; x++) {
      const t = m.tiles[y * m.w + x];
      if (t === Tile.Water || t === Tile.Bridge || t === Tile.Rock) continue;
      let wet = false;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (m.tiles[(y + dy) * m.w + x + dx] === Tile.Water) wet = true;
      if (wet === nearWater && (!nearWater || m.tiles[y * m.w + x + 1] === Tile.Water || m.tiles[y * m.w + x - 1] === Tile.Water)) return { x: x + 0.5, z: y + 0.5 };
    }
  throw new Error('no tile');
}

describe('battle scar rules', () => {
  const m = createMap('frontline', 1);

  it('craters on open ground are kept; next to the river they shrink or are skipped', () => {
    const s = scarsFor(m);
    const dry = landTile(m, false);
    s.craterAt(dry.x, dry.z, 0.6);
    expect(s.stats().decalsAdded).toBe(1);
    const bank = landTile(m, true);
    // a full-size crater (0.9 * 3.2 + 0.2 wide) would reach over the water: it is shrunk to the dry ground or skipped
    const fit = (s as unknown as { fit(x: number, z: number, w: number): number }).fit.bind(s);
    expect(fit(dry.x, dry.z, 3.08)).toBe(3.08);
    expect(fit(bank.x, bank.z, 3.08)).toBeLessThan(1.2);
    s.dispose();
  });

  it('no crater or scorch on a standing building; a new building clears the scars under it', () => {
    const dry = landTile(m, false);
    let built = true;
    const s = scarsFor(m, (x, z) => built && Math.floor(x) === Math.floor(dry.x) && Math.floor(z) === Math.floor(dry.z));
    s.craterAt(dry.x, dry.z, 0.6);
    s.scorchAt(dry.x, dry.z, 0.6);
    expect(s.stats().decalsAdded).toBe(0);
    built = false;
    s.craterAt(dry.x, dry.z, 0.6);
    s.ruin(dry.x, dry.z, 2, 2);
    expect(s.stats().pieces).toBeGreaterThan(0);
    s.clearArea(dry.x - 1.5, dry.z - 1.5, dry.x + 1.5, dry.z + 1.5);
    expect(s.stats().pieces).toBe(0);
    s.dispose();
  });

  it('the airbase leaves a flat slab: low debris, no wall stubs', () => {
    const dry = landTile(m, false);
    const s = scarsFor(m);
    s.ruin(dry.x, dry.z, 7, 4, { flat: true });
    const n = s.stats().pieces;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(40);
    s.dispose();
  });
});
