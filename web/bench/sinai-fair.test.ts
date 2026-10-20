// SN1: the Sinai's fairness numbers (report). The map is not mirrored (its coasts are traced from the owner's
// picture): everything neutral is counted for the base nearer to it by road (vehicle path).
// BENCH=1 npx vitest run bench/sinai-fair.test.ts --silent=false
import { it } from 'vitest';
import { buildingDef } from '../src/sim/defs';
import { Tile, terrainBuildable } from '../src/sim/map';
import { Loco } from '../src/sim/slope';
import { World } from '../src/sim/world';
import { sinaiPixel } from '../src/sim/maps';

it('sinai fair numbers', () => {
  const w = new World({ seed: Number(process.env.SEED ?? 1), map: 'desert', players: [{ name: 'a', faction: 'usa', color: 0, isAI: true }, { name: 'b', faction: 'russia', color: 0, isAI: true }] });
  const m = w.map;
  const pf = w.pfs[Loco.Vehicle];
  const len = (sx: number, sy: number, gx: number, gy: number) => {
    pf.clearCache();
    const p = pf.find(sx, sy, gx, gy, 2000000);
    let L = 0;
    let x = sx;
    let y = sy;
    for (const t of p) {
      L += Math.hypot((t % m.w) - x, Math.floor(t / m.w) - y);
      x = t % m.w;
      y = Math.floor(t / m.w);
    }
    return L;
  };
  const S = m.starts;
  const dists = (x: number, y: number) => S.map((s) => len(s.x, s.y, Math.floor(x), Math.floor(y)));
  const sideOf = (d: number[]) => (d[0] <= d[1] ? 0 : 1);
  const out: string[] = [];
  out.push(`start->enemy: ${len(S[0].x, S[0].y, S[1].x, S[1].y).toFixed(1)} / ${len(S[1].x, S[1].y, S[0].x, S[0].y).toFixed(1)}`);
  // the crossings: each start to both (its own first)
  const lanes = m.lanes ?? [];
  out.push(`start->crossings (own, far): P0 ${lanes.map((l) => len(S[0].x, S[0].y, Math.round(l.x), Math.round(l.y)).toFixed(1)).join(', ')} | P1 ${[...lanes].reverse().map((l) => len(S[1].x, S[1].y, Math.round(l.x), Math.round(l.y)).toFixed(1)).join(', ')}`);
  // ore: each field to the nearer base by road; its value (ore tiles nearest to it)
  const fields = m.oreMines.map((f) => ({ ...f, d: dists(f.x, f.y), value: 0 }));
  for (let i = 0; i < m.w * m.h; i++) {
    if (!m.ore[i]) continue;
    const x = i % m.w;
    const y = Math.floor(i / m.w);
    let best = fields[0];
    for (const f of fields) if (Math.hypot(f.x - x, f.y - y) < Math.hypot(best.x - x, best.y - y)) best = f;
    best.value += m.ore[i] * (m.oreKind[i] === 2 ? 2 : 1);
  }
  const per = [0, 1].map((side) => fields.filter((f) => sideOf(f.d) === side));
  out.push(`ore fields ${per[0].length} / ${per[1].length}; value ${per[0].reduce((a, f) => a + f.value, 0)} / ${per[1].reduce((a, f) => a + f.value, 0)}; road to them (sum) ${per[0].reduce((a, f) => a + f.d[0], 0).toFixed(1)} / ${per[1].reduce((a, f) => a + f.d[1], 0).toFixed(1)}`);
  // (picture pixel of a tile, for the layout tables in sim/maps.ts)
  const px = (x: number, y: number) => {
    const p = sinaiPixel(x + 0.5, y + 0.5);
    return `(${p.u.toFixed(0)},${p.v.toFixed(0)})`;
  };
  out.push(`  P0 fields (value@road px): ${per[0].map((f) => `${f.value}@${f.d[0].toFixed(0)}${px(f.x, f.y)}`).join(' ')}`);
  out.push(`  P1 fields (value@road px): ${per[1].map((f) => `${f.value}@${f.d[1].toFixed(0)}${px(f.x, f.y)}`).join(' ')}`);
  const oil = [0, 0];
  const oilD = [0, 0];
  for (const o of m.oils) {
    const d = dists(o.x + 1, o.y + 1);
    oil[sideOf(d)]++;
    oilD[sideOf(d)] += d[sideOf(d)];
  }
  out.push(`oil ${oil[0]} / ${oil[1]} (road sum ${oilD[0].toFixed(0)} / ${oilD[1].toFixed(0)})`);
  const room = (s: { x: number; y: number }) => {
    let n = 0;
    for (let y = s.y - 20; y <= s.y + 20; y++) for (let x = s.x - 20; x <= s.x + 20; x++) if (Math.hypot(x - s.x, y - s.y) <= 20 && x >= 0 && y >= 0 && x < m.w - 1 && y < m.h - 1 && terrainBuildable(m, x, y, 2, 2)) n++;
    return n;
  };
  const around = (s: { x: number; y: number }) => {
    const c = [0, 0, 0];
    for (let y = s.y - 20; y <= s.y + 20; y++)
      for (let x = s.x - 20; x <= s.x + 20; x++) {
        if (Math.hypot(x - s.x, y - s.y) > 20 || x < 0 || y < 0 || x >= m.w || y >= m.h) continue;
        const t = m.tiles[y * m.w + x];
        c[t === Tile.Water ? 0 : terrainBuildable(m, x, y, 1, 1) ? 2 : 1]++;
      }
    return `water ${c[0]} land unbuildable ${c[1]} buildable ${c[2]}`;
  };
  out.push(`build space (open gentle 2x2 spots within 20): ${room(S[0])} / ${room(S[1])} (${around(S[0])} | ${around(S[1])})`);
  const side = (pick: (d: ReturnType<typeof buildingDef>) => boolean) => {
    const r = [0, 0];
    const rd = [0, 0];
    for (const e of w.list) {
      if (e.owner >= 0 || e.kind !== 'building' || !pick(buildingDef(e.def))) continue;
      const d = dists(e.x, e.y);
      r[sideOf(d)]++;
      rd[sideOf(d)] += d[sideOf(d)];
    }
    return `${r[0]} / ${r[1]} (road sum ${rd[0].toFixed(0)} / ${rd[1].toFixed(0)})`;
  };
  out.push(`garrisonable houses ${side((d) => !!d.garrison)}; tech sites ${side((d) => !!d.techKind)}`);
  // the crossings' width: open ground across each, at right angles to the road through it
  let land = 0;
  let water = 0;
  for (let i = 0; i < m.w * m.h; i++) {
    if (m.tiles[i] === Tile.Water) water++;
    else if (pf.passable(i % m.w, Math.floor(i / m.w))) land++;
  }
  out.push(`map ${m.w}x${m.h}, vehicle-passable land ${land} tiles, water ${water}, structures ${m.structures.length}, bridges ${m.bridges.length}`);
  console.log(out.join('\n'));
});
