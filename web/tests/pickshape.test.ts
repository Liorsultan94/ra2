import { describe, expect, it } from 'vitest';
import { convexHull, hullCentre, hullHit, touchScore, type Pt } from '../src/game/pickshape';

// a 2x2 tile house seen from an oblique camera: the roof is drawn up and behind the footprint
const foot: Pt[] = [
  [100, 200],
  [160, 200],
  [100, 240],
  [160, 240],
];
const roof: Pt[] = foot.map(([x, y]) => [x, y - 70] as Pt);

describe('pickshape', () => {
  it('the hull of a box covers its roof, not only its footprint', () => {
    const hull = convexHull([...foot, ...roof]);
    expect(hull.length).toBe(4);
    expect(hullHit(hull, [130, 225], 0)).toBe(true); // footprint
    expect(hullHit(hull, [130, 150], 0)).toBe(true); // the roof, which sits on the ground behind
    expect(hullHit(hull, [130, 110], 0)).toBe(false); // above the roof
    expect(hullHit(hull, [60, 200], 0)).toBe(false);
  });

  it('a fingertip margin catches a tap just outside the outline', () => {
    const hull = convexHull([...foot, ...roof]);
    expect(hullHit(hull, [92, 190], 0)).toBe(false);
    expect(hullHit(hull, [92, 190], 10)).toBe(true);
    expect(hullHit(hull, [60, 190], 10)).toBe(false);
  });

  it('degenerate shapes do not throw', () => {
    expect(hullHit([], [0, 0], 5)).toBe(false);
    expect(hullHit(convexHull([[10, 10]]), [12, 10], 5)).toBe(true);
    expect(hullHit(convexHull([[0, 0], [10, 0]]), [5, 3], 5)).toBe(true);
    expect(hullCentre(convexHull([...foot, ...roof]))[0]).toBeCloseTo(130);
  });

  it('a soldier beside a harvester wins the tap meant for him', () => {
    // harvester (body 40 px) and a soldier (body 10 px) 28 px apart; the finger is 14 px off the soldier, towards the truck
    const soldier = touchScore(14, 10);
    const harvester = touchScore(14, 40);
    expect(soldier).toBeLessThan(harvester);
    // tapping the truck's own centre still picks the truck
    expect(touchScore(0, 40)).toBeLessThan(touchScore(28, 10));
  });
});
