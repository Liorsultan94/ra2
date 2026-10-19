// SN1 design aid: where the Sinai map's halves differ (transposed), and the start-to-start routes.
import { it } from 'vitest';
import { Tile } from '../src/sim/map';
import { World } from '../src/sim/world';

it('sinai sym', () => {
  const w = new World({ seed: Number(process.env.SEED ?? 1), map: 'desert', players: [{ name: 'a', faction: 'usa', color: 0, isAI: true }, { name: 'b', faction: 'russia', color: 0, isAI: true }] });
  const m = w.map;
  const N = m.w;
  const out: string[] = [];
  for (let y = 0; y < N; y++)
    for (let x = y + 1; x < N; x++) {
      const i = y * N + x;
      const j = x * N + y;
      if (m.offshore?.[i] || m.offshore?.[j]) continue;
      const bar = (m.tiles[i] === Tile.Water && m.tiles[j] === Tile.Rock) || (m.tiles[i] === Tile.Rock && m.tiles[j] === Tile.Water);
      if (bar) continue;
      const why: string[] = [];
      if (m.tiles[i] !== m.tiles[j]) why.push(`tile ${m.tiles[i]}/${m.tiles[j]}`);
      if (m.ore[i] !== m.ore[j]) why.push(`ore ${m.ore[i]}/${m.ore[j]}`);
      if (!!m.trees[i] !== !!m.trees[j]) why.push(`tree ${m.trees[i]}/${m.trees[j]}`);
      if (m.blocked[i] !== m.blocked[j]) why.push(`blocked ${m.blocked[i]}/${m.blocked[j]}`);
      if (w.pass[i] !== w.pass[j]) why.push(`pass ${w.pass[i]}/${w.pass[j]}`);
      for (let c = 0; c < 2; c++) if ((w.regions[c][i] === w.mainlands[c]) !== (w.regions[c][j] === w.mainlands[c])) why.push(`region${c}`);
      if (w.pass[i])
        for (let k = 0; k < 4; k++) {
          const km = [2, 3, 0, 1][k];
          for (let c = 0; c < 2; c++) if (((w.slope.block[c][i] >> k) & 1) !== ((w.slope.block[c][j] >> km) & 1)) why.push(`slope${c}.${k}`);
        }
      if (why.length) out.push(`(${x},${y}) E${((x - y) / Math.SQRT2).toFixed(1)} S${((x + y) / Math.SQRT2).toFixed(1)}: ${why.join(' ')}`);
    }
  console.log(out.length + ' diffs\n' + out.slice(0, 60).join('\n'));
  const [s0, s1] = m.starts;
  const a = w.pf.find(s0.x, s0.y, s1.x, s1.y, 400000);
  w.pf.clearCache();
  const b = w.pf.find(s1.x, s1.y, s0.x, s0.y, 400000);
  console.log(`paths ${a.length} ${b.length} ends ${a[a.length - 1]} ${b[b.length - 1]} goals ${s1.y * N + s1.x} ${s0.y * N + s0.x}`);
});
