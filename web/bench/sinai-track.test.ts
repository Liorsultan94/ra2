// SN1 design aid: walk a polyline (screen positions) tile by tile: heights, tiles, vehicle region, blocked steps.
import { it } from 'vitest';
import { World } from '../src/sim/world';
import { stepGrade, dirOf } from '../src/sim/slope';

it('sinai track', () => {
  const w = new World({ seed: Number(process.env.SEED ?? 1), map: 'desert', players: [{ name: 'a', faction: 'usa', color: 0, isAI: true }, { name: 'b', faction: 'russia', color: 0, isAI: true }] });
  const m = w.map;
  const pts = (process.env.LINE ?? '-22.5,136;-21.5,139.4;-19.6,141.8;-17.4,143.4;-15.6,145.6;-13.4,146.2').split(';').map((p) => p.split(',').map(Number));
  const tiles: [number, number][] = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const [e0, s0] = pts[k];
    const [e1, s1] = pts[k + 1];
    const n = Math.ceil(Math.hypot(e1 - e0, s1 - s0) * 4);
    for (let j = 0; j <= n; j++) {
      const e = e0 + ((e1 - e0) * j) / n;
      const s = s0 + ((s1 - s0) * j) / n;
      const t: [number, number] = [Math.floor((s + e) / Math.SQRT2), Math.floor((s - e) / Math.SQRT2)];
      const l = tiles[tiles.length - 1];
      if (!l || l[0] !== t[0] || l[1] !== t[1]) tiles.push(t);
    }
  }
  const out: string[] = [];
  for (let k = 0; k < tiles.length; k++) {
    const [x, y] = tiles[k];
    const i = y * m.w + x;
    let step = '';
    if (k + 1 < tiles.length) {
      const d = dirOf(tiles[k + 1][0] - x, tiles[k + 1][1] - y);
      if (d >= 0) step = `g${stepGrade(m, x, y, d).toFixed(2)}${(w.slope.block[1][i] >> d) & 1 ? 'X' : ''}`;
    }
    const h = (m.heights[y * (m.w + 1) + x] + m.heights[y * (m.w + 1) + x + 1] + m.heights[(y + 1) * (m.w + 1) + x] + m.heights[(y + 1) * (m.w + 1) + x + 1]) / 4;
    out.push(`${x},${y} t${m.tiles[i]} p${w.pass[i]} r${w.regions[1][i] === w.mainlands[1] ? 'M' : w.regions[1][i]} h${h.toFixed(2)} ${step}`);
  }
  console.log(out.join('\n'));
});
