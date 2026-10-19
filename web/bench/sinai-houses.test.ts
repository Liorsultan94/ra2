// SN1 design aid: which village / Sharm houses were placed and why the others were not.
import { it } from 'vitest';
import { Tile, distToSegment } from '../src/sim/map';
import { createMap, sinaiVillage } from '../src/sim/maps';

it('sinai houses', () => {
  const m = createMap('desert', Number(process.env.SEED ?? 1));
  const placed = new Set(m.structures.map((s) => `${s.x},${s.y}`));
  const vh = (x: number, y: number) => m.heights[y * (m.w + 1) + x];
  const out: string[] = [];
  for (const st of sinaiVillage()) {
    const why: string[] = [];
    if (!placed.has(`${st.x},${st.y}`)) {
      for (let y = st.y; y < st.y + st.h; y++)
        for (let x = st.x; x < st.x + st.w; x++) {
          const i = y * m.w + x;
          const t = m.tiles[i];
          if (t === Tile.Water || t === Tile.Rock) why.push(`t${t}@${x},${y}`);
          if (m.trees[i]) why.push(`tree@${x},${y}`);
          if (m.ore[i]) why.push('ore');
          let rd = 1e9;
          for (const r of m.roads) for (let k = 0; k < r.length - 1; k++) rd = Math.min(rd, distToSegment(x + 0.5, y + 0.5, r[k].x + 0.5, r[k].y + 0.5, r[k + 1].x + 0.5, r[k + 1].y + 0.5));
          if (rd < 1.6) why.push(`road${rd.toFixed(1)}`);
          const hs = [vh(x, y), vh(x + 1, y), vh(x, y + 1), vh(x + 1, y + 1)];
          if (Math.max(...hs) - Math.min(...hs) > 0.45) why.push('steep');
        }
      let lo = 9;
      let hi = -9;
      for (let y = st.y; y <= st.y + st.h; y++) for (let x = st.x; x <= st.x + st.w; x++) (lo = Math.min(lo, vh(x, y))), (hi = Math.max(hi, vh(x, y)));
      if (hi - lo > 0.4) why.push(`rise${(hi - lo).toFixed(2)}`);
      for (const s of m.starts) if (Math.hypot(st.x - s.x, st.y - s.y) < 15) why.push('start');
    }
    out.push(`${st.kind}${st.look ?? ''} ${st.x},${st.y} E${((st.x - st.y) / Math.SQRT2).toFixed(1)} S${((st.x + st.y + 2) / Math.SQRT2).toFixed(1)}: ${placed.has(`${st.x},${st.y}`) ? 'OK' : 'NO ' + [...new Set(why)].join(' ')}`);
  }
  console.log(out.join('\n'));
});
