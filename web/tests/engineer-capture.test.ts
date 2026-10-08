import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { TPS } from '../src/sim/types';

describe('engineer capture behavior', () => {
  it('when 2 engineers are sent to capture an enemy building, only 1 enters and the second remains outside alive', () => {
    const w = new World({
      seed: 123,
      players: [
        { name: 'Player', faction: 'usa', color: 0x2f7dff, isAI: false },
        { name: 'Enemy', faction: 'russia', color: 0xe0322b, isAI: false },
      ],
    });

    // Spawn an enemy building
    const bld = w.spawnBuilding('russia_power', 1, 30, 30);
    expect(bld.owner).toBe(1);

    // Spawn 2 engineers close to the building
    const eng1 = w.spawnUnit('usa_engineer', 0, 30, 27);
    const eng2 = w.spawnUnit('usa_engineer', 0, 30, 26);

    // Issue capture command with both engineers
    w.issue(0, { type: 'capture', ids: [eng1.id, eng2.id], target: bld.id });

    // Step simulation until the first engineer captures it
    for (let i = 0; i < TPS * 10; i++) {
      w.step();
      if (bld.owner === 0) break;
    }

    // Verify building is captured
    expect(bld.owner).toBe(0);

    // Step more ticks so the second engineer arrives / checks order
    for (let i = 0; i < TPS * 5; i++) {
      w.step();
    }

    // Verify exactly ONE engineer entered (died/consumed) and ONE remained alive outside
    const eng1Alive = !eng1.dead && w.list.includes(eng1);
    const eng2Alive = !eng2.dead && w.list.includes(eng2);

    expect(eng1Alive !== eng2Alive).toBe(true); // exactly one alive
    const surviving = eng1Alive ? eng1 : eng2;
    expect(surviving.order.type).toBe('idle');
  });

  it('when 2 engineers are sent to capture a neutral building, only 1 enters and the second remains outside alive', () => {
    const w = new World({
      seed: 456,
      players: [
        { name: 'Player', faction: 'usa', color: 0x2f7dff, isAI: false },
      ],
    });

    // Find a neutral oil derrick or spawn a capturable tech building
    const bld = w.spawnBuilding('tech_hospital', -1, 40, 40);
    expect(bld.owner).toBe(-1);

    const eng1 = w.spawnUnit('usa_engineer', 0, 40, 37);
    const eng2 = w.spawnUnit('usa_engineer', 0, 40, 36);

    w.issue(0, { type: 'capture', ids: [eng1.id, eng2.id], target: bld.id });

    for (let i = 0; i < TPS * 10; i++) {
      w.step();
      if (bld.owner === 0) break;
    }

    expect(bld.owner).toBe(0);

    for (let i = 0; i < TPS * 5; i++) {
      w.step();
    }

    const eng1Alive = !eng1.dead && w.list.includes(eng1);
    const eng2Alive = !eng2.dead && w.list.includes(eng2);

    expect(eng1Alive !== eng2Alive).toBe(true);
    const surviving = eng1Alive ? eng1 : eng2;
    expect(surviving.order.type).toBe('idle');
  });

  it('when 2 engineers are sent to repair a damaged friendly building, only 1 enters and repairs it', () => {
    const w = new World({
      seed: 789,
      players: [
        { name: 'Player', faction: 'usa', color: 0x2f7dff, isAI: false },
      ],
    });

    const bld = w.spawnBuilding('usa_refinery', 0, 25, 25);
    bld.hp = Math.floor(bld.maxHp * 0.4); // heavily damaged
    expect(bld.hp).toBeLessThan(bld.maxHp);

    const eng1 = w.spawnUnit('usa_engineer', 0, 25, 22);
    const eng2 = w.spawnUnit('usa_engineer', 0, 25, 21);

    w.issue(0, { type: 'capture', ids: [eng1.id, eng2.id], target: bld.id });

    for (let i = 0; i < TPS * 10; i++) {
      w.step();
      if (bld.hp === bld.maxHp) break;
    }

    expect(bld.hp).toBe(bld.maxHp);

    for (let i = 0; i < TPS * 5; i++) {
      w.step();
    }

    const eng1Alive = !eng1.dead && w.list.includes(eng1);
    const eng2Alive = !eng2.dead && w.list.includes(eng2);

    expect(eng1Alive !== eng2Alive).toBe(true);
    const surviving = eng1Alive ? eng1 : eng2;
    expect(surviving.order.type).toBe('idle');
  });
});
