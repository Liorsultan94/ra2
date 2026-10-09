import { describe, expect, it } from 'vitest';
import { World } from '../src/sim/world';
import { AIController } from '../src/sim/ai';
import { Tile, terrainPassable, unitPassable } from '../src/sim/map';
import { hurtBridge } from '../src/sim/bridges';
import { TPS } from '../src/sim/types';

describe('river crossing and bridge repair', () => {
  it('terrainPassable and unitPassable reject water for standard units but allow amphibious', () => {
    const w = new World({
      map: 'frontline',
      seed: 1,
      players: [
        { name: 'P1', faction: 'usa', color: 0, isAI: false },
        { name: 'P2', faction: 'russia', color: 0, isAI: true },
      ],
    });
    // Find a water tile on the river
    let waterTile = -1;
    for (let i = 0; i < w.map.w * w.map.h; i++) {
      if (w.map.tiles[i] === Tile.Water) {
        waterTile = i;
        break;
      }
    }
    expect(waterTile).toBeGreaterThanOrEqual(0);
    const wx = waterTile % w.map.w;
    const wy = Math.floor(waterTile / w.map.w);

    expect(terrainPassable(w.map, wx, wy)).toBe(false);
    expect(unitPassable(w.map, wx, wy, false)).toBe(false);
    expect(unitPassable(w.map, wx, wy, true)).toBe(true);
  });

  it('all river maps are impassable by land when all bridges are destroyed', () => {
    for (const mapId of ['frontline', 'winter', 'urban'] as const) {
      const w = new World({
        map: mapId,
        seed: 100,
        players: [
          { name: 'P1', faction: 'usa', color: 0, isAI: false },
          { name: 'P2', faction: 'russia', color: 0, isAI: true },
        ],
      });
      expect(w.bridges.length).toBeGreaterThan(0);
      for (const b of w.bridges) hurtBridge(w, b, 1e9);
      expect(w.bridges.every((b) => b.status === 'down')).toBe(true);

      const s0 = w.map.starts[0];
      const s1 = w.map.starts[1];
      const path = w.pf.find(s0.x, s0.y, s1.x, s1.y, 100000);
      const reached = path.length > 0 && path[path.length - 1] === (s1.y * w.map.w + s1.x);
      expect(reached, `${mapId} should not be crossable when all bridges are down`).toBe(false);
    }
  });

  it('AI trains engineer to repair destroyed bridge and restores crossing', () => {
    const w = new World({
      map: 'frontline',
      seed: 42,
      players: [
        { name: 'Human', faction: 'usa', color: 0x0000ff, isAI: false },
        { name: 'AI', faction: 'russia', color: 0xff0000, isAI: true },
      ],
    });
    const ai = new AIController(w, 1, 'hard');
    w.controllers.push(ai);

    // Run until AI has barracks / economy
    for (let i = 0; i < TPS * 100; i++) w.step();

    // Destroy centre bridge
    const b0 = w.bridges[0];
    hurtBridge(w, b0, 1e9);
    expect(b0.status).toBe('down');

    // Run AI steps: AI should train engineer and repair b0
    let repaired = false;
    for (let i = 0; i < TPS * 200; i++) {
      w.step();
      if (b0.status === 'intact') {
        repaired = true;
        break;
      }
    }
    expect(repaired).toBe(true);
  });

  it('air units fly over water while ground units stop at bank', () => {
    const w = new World({
      map: 'frontline',
      seed: 1,
      players: [
        { name: 'P1', faction: 'usa', color: 0, isAI: false },
        { name: 'P2', faction: 'russia', color: 0, isAI: true },
      ],
    });
    // Drop all bridges
    for (const b of w.bridges) hurtBridge(w, b, 1e9);

    const s0 = w.map.starts[0];
    const s1 = w.map.starts[1];

    // Spawn helicopter and tank for player 0
    const heli = w.spawnUnit('usa_heli', 0, s0.x, s0.y);
    const tank = w.spawnUnit('usa_mbt', 0, s0.x, s0.y);

    w.pathTo(heli, s1.x, s1.y);
    w.pathTo(tank, s1.x, s1.y);

    // Step simulation
    for (let i = 0; i < TPS * 30; i++) w.step();

    // Heli can fly across to s1
    expect(Math.hypot(heli.x - s1.x, heli.y - s1.y)).toBeLessThan(15);
    // Tank cannot cross river to s1 (stays on bank s0 side: y > x)
    expect(tank.y).toBeGreaterThan(tank.x);
    expect(Math.hypot(tank.x - s1.x, tank.y - s1.y)).toBeGreaterThan(40);
  });
});
