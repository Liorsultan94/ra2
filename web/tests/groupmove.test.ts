import { describe, expect, it } from 'vitest';
import type { MapId } from '../src/sim/map';
import { TPS, type Entity } from '../src/sim/types';
import { World } from '../src/sim/world';

// Group moves: every unit of a big group reaches its formation slot (no endless jostling round a shared
// waypoint, no head-on deadlock on a bridge).

function world(map: MapId) {
  const w = new World({ seed: 1, map, players: [{ name: 'A', faction: 'usa', color: 0, isAI: false }, { name: 'B', faction: 'russia', color: 0, isAI: false }] });
  for (const e of w.list) if (e.owner >= 0 && e.kind === 'unit') e.dead = true;
  w.list = w.list.filter((e) => !e.dead);
  for (const pl of [0, 1]) {
    const st = w.map.starts[pl];
    const id = `${pl ? 'russia' : 'usa'}_conyard`;
    let ok = false;
    for (let r = 0; r < 12 && !ok; r++)
      for (let dy = -r; dy <= r && !ok; dy++)
        for (let dx = -r; dx <= r && !ok; dx++)
          if (w.canPlace(pl, id, Math.round(st.x) + dx - 1, Math.round(st.y) + dy - 1, -1, false)) {
            w.spawnBuilding(id, pl, Math.round(st.x) + dx - 1, Math.round(st.y) + dy - 1, true);
            ok = true;
          }
  }
  return w;
}

function freeTiles(w: World, x: number, y: number, n: number, taken: Set<number>) {
  const W = w.map.w;
  const out: { x: number; y: number }[] = [];
  for (let r = 0; r < 30 && out.length < n; r++)
    for (let dy = -r; dy <= r && out.length < n; dy++)
      for (let dx = -r; dx <= r && out.length < n; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const xx = Math.round(x) + dx;
        const yy = Math.round(y) + dy;
        if (xx < 1 || yy < 1 || xx >= W - 1 || yy >= w.map.h - 1) continue;
        const i = yy * W + xx;
        if (w.pass[i] && !w.occ[i] && !taken.has(i)) {
          taken.add(i);
          out.push({ x: xx, y: yy });
        }
      }
  return out;
}

const MIX: Record<string, string[]> = { tank: ['mbt'], mixed: ['mbt', 'apc', 'rifle', 'robot', 'at', 'mbt', 'rifle'], inf: ['rifle', 'at', 'rifle', 'engineer'] };

/** Moves n units from player pl's base to (gx, gy); returns the units that never settled or settled off their slot. */
function groupMove(map: MapId, pl: number, kind: string, n: number, gx: number, gy: number) {
  const w = world(map);
  const st = w.map.starts[pl];
  const spots = freeTiles(w, st.x + Math.sign(48 - st.x) * 5, st.y + Math.sign(48 - st.y) * 5, n, new Set());
  const f = pl ? 'russia' : 'usa';
  const units: Entity[] = spots.map((p, k) => w.spawnUnit(`${f}_${MIX[kind][k % MIX[kind].length]}`, pl, p.x + 0.5, p.y + 0.5));
  const tgt = freeTiles(w, gx, gy, 1, new Set())[0];
  w.issue(pl, { type: 'move', ids: units.map((e) => e.id), x: tgt.x + 0.5, y: tgt.y + 0.5 });
  const slots = units.map((e) => ({ ...(e.order as { x: number; y: number }) }));
  for (let t = 0; t < TPS * 120 && units.some((e) => e.order.type !== 'idle'); t++) {
    w.step();
    w.drainEvents();
  }
  return units.filter((e, k) => e.order.type !== 'idle' || Math.hypot(e.x - slots[k].x, e.y - slots[k].y) > 1.5).map((e) => `${e.def}@${e.x.toFixed(1)},${e.y.toFixed(1)}`);
}

describe('group moves', () => {
  for (const map of ['frontline', 'desert', 'winter', 'urban'] as MapId[]) {
    it(`every unit of a group arrives on ${map}`, () => {
      const w0 = world(map);
      const en = w0.map.starts[1];
      const goals: [number, number][] = [
        [47.5, 47.5],
        [en.x + Math.sign(48 - en.x) * 7, en.y + Math.sign(48 - en.y) * 7],
      ];
      w0.map.bridges.forEach((b) => goals.push([b.x + Math.cos(b.angle) * 6, b.y + Math.sin(b.angle) * 6]));
      const bad: string[] = [];
      for (const [gx, gy] of goals)
        for (const [kind, n] of [['tank', 16], ['mixed', 24], ['inf', 24]] as [string, number][]) {
          const left = groupMove(map, 0, kind, n, gx, gy);
          if (left.length) bad.push(`${kind}x${n} -> ${gx.toFixed(0)},${gy.toFixed(0)}: ${left.join(' ')}`);
        }
      expect(bad).toEqual([]);
    }, 300_000);
  }

  it('two groups swapping banks across a bridge both get through', () => {
    const w0 = world('urban');
    const bad: string[] = [];
    w0.map.bridges.forEach((b, bi) => {
      const c = Math.cos(b.angle);
      const s = Math.sin(b.angle);
      const L = b.length / 2 + 5;
      for (const kind of ['tank', 'inf']) {
        const w = world('urban');
        const taken = new Set<number>();
        const mk = (x: number, y: number) => freeTiles(w, x, y, 12, taken).map((p, k) => w.spawnUnit(`usa_${MIX[kind][k % MIX[kind].length]}`, 0, p.x + 0.5, p.y + 0.5));
        const A = mk(b.x + c * L, b.y + s * L);
        const B = mk(b.x - c * L, b.y - s * L);
        w.issue(0, { type: 'move', ids: A.map((e) => e.id), x: b.x - c * L, y: b.y - s * L });
        w.issue(0, { type: 'move', ids: B.map((e) => e.id), x: b.x + c * L, y: b.y + s * L });
        const all = [...A, ...B];
        const slots = all.map((e) => ({ ...(e.order as { x: number; y: number }) }));
        for (let t = 0; t < TPS * 120 && all.some((e) => e.order.type !== 'idle'); t++) {
          w.step();
          w.drainEvents();
        }
        all.forEach((e, k) => {
          if (e.order.type !== 'idle' || Math.hypot(e.x - slots[k].x, e.y - slots[k].y) > 1.5) bad.push(`bridge${bi} ${kind} ${e.def}@${e.x.toFixed(1)},${e.y.toFixed(1)}`);
        });
      }
    });
    expect(bad).toEqual([]);
  }, 300_000);
});
