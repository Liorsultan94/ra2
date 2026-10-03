import { it } from 'vitest';
import { createMap } from '../src/sim/maps';
it('probe', () => {
  for (const id of ['urban', 'frontline'] as const) {
    const m = createMap(id, 1);
    const rows: string[] = [];
    for (const y0 of [0, 84]) for (let y = y0; y < y0 + 12; y++) {
      let s = String(y).padStart(2) + ' ';
      for (let x = (y0 ? 84 : 0); x < (y0 ? 96 : 12); x++) {
        const t = m.tiles[y * m.w + x];
        s += t === 3 ? '~' : t === 5 ? 'B' : m.blocked[y * m.w + x] ? '#' : '.';
      }
      rows.push(s);
    }
    console.log(id + '\n' + rows.join('\n'));
  }
});
