import { describe, expect, it } from 'vitest';
import { BLASTS } from '../src/render/effects';
import { billowPlan, type FxQuality } from '../src/render/fx/fireball';

// small missile < heavy missile < ballistic < heavy jet bomb < superweapon
const CHAIN = ['missile', 'heavyMissile', 'ballistic', 'bomb', 'superweapon'] as const;
const QS: FxQuality[] = ['low', 'medium', 'high'];

describe('explosion presets scale with the weapon', () => {
  it('size, light, shake, smoke, shock ring and crater grow along the chain', () => {
    for (let i = 1; i < CHAIN.length; i++) {
      const a = BLASTS[CHAIN[i - 1]];
      const b = BLASTS[CHAIN[i]];
      expect(b.size, CHAIN[i]).toBeGreaterThan(a.size);
      expect(b.light, CHAIN[i]).toBeGreaterThan(a.light);
      expect(b.shake, CHAIN[i]).toBeGreaterThan(a.shake);
      expect(b.smoke, CHAIN[i]).toBeGreaterThanOrEqual(a.smoke);
      expect(b.ring, CHAIN[i]).toBeGreaterThan(a.ring);
      expect(b.crater, CHAIN[i]).toBeGreaterThan(a.crater);
    }
  });

  it('the heavy bomb is the biggest non-superweapon preset', () => {
    for (const [k, p] of Object.entries(BLASTS)) if (k !== 'bomb' && k !== 'superweapon') expect(p.size, k).toBeLessThan(BLASTS.bomb.size);
  });

  it('fireball clusters get bigger, hotter and longer with the weapon on every tier', () => {
    for (const q of QS) {
      const plans = CHAIN.map((k) => billowPlan(BLASTS[k].size, BLASTS[k].fire, q));
      for (let i = 1; i < plans.length; i++) {
        expect(plans[i].r, `${CHAIN[i]} ${q}`).toBeGreaterThan(plans[i - 1].r);
        expect(plans[i].hot).toBeGreaterThan(plans[i - 1].hot);
        expect(plans[i].smoke).toBeGreaterThan(plans[i - 1].smoke);
        expect(plans[i].light).toBeGreaterThan(plans[i - 1].light);
        expect(plans[i].puffs).toBeGreaterThanOrEqual(plans[i - 1].puffs);
      }
      // only the big ground bursts grow a mushroom cap
      expect(plans[0].cap).toBe(0);
      expect(billowPlan(BLASTS.bomb.size, BLASTS.bomb.fire, q).cap).toBeGreaterThan(0);
      expect(billowPlan(BLASTS.bomb.size, BLASTS.bomb.fire, q, true).cap).toBe(0);
    }
  });

  it('phone tiers spend fewer puffs (all puffs share one instanced draw call)', () => {
    for (const k of CHAIN) {
      const p = BLASTS[k];
      const lo = billowPlan(p.size, p.fire, 'low').puffs;
      const md = billowPlan(p.size, p.fire, 'medium').puffs;
      const hi = billowPlan(p.size, p.fire, 'high').puffs;
      expect(lo).toBeLessThanOrEqual(md);
      expect(md).toBeLessThanOrEqual(hi);
    }
    // a heavy bomb on a phone fits the medium pool (64) three times over
    expect(billowPlan(BLASTS.bomb.size, BLASTS.bomb.fire, 'medium').puffs).toBeLessThanOrEqual(21);
  });
});
