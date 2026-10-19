// SN1 design aid: the massif's tracks (vehicle and foot routes from a foot point to the summit) and the AI's posts.
import { it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { groundHeight } from '../src/sim/map';
import { Loco, MAX_GRADE } from '../src/sim/slope';
import { World } from '../src/sim/world';

it('sinai slope', () => {
  const w = new World({ seed: Number(process.env.SEED ?? 1), map: 'desert', players: [{ name: 'a', faction: 'usa', color: 0, isAI: true }, { name: 'b', faction: 'russia', color: 0, isAI: true }] });
  const m = w.map;
  const at = (e: number, s: number) => [Math.floor((s + e) / Math.SQRT2), Math.floor((s - e) / Math.SQRT2)];
  const [fe, fs, te, ts] = (process.env.PTS ?? '-14,135,-12.5,147.5').split(',').map(Number);
  const [sx, sy] = at(fe, fs);
  const [gx, gy] = at(te, ts);
  const walk = (p: number[]) => {
    let x = sx;
    let y = sy;
    let len = 0;
    let steep = 0;
    for (const t of p) {
      const tx = t % m.w;
      const ty = Math.floor(t / m.w);
      const n = Math.max(1, Math.ceil(Math.hypot(tx - x, ty - y) * 3));
      for (let k = 1; k <= n; k++) {
        const ax = x + ((tx - x) * (k - 1)) / n + 0.5;
        const ay = y + ((ty - y) * (k - 1)) / n + 0.5;
        const bx = x + ((tx - x) * k) / n + 0.5;
        const by = y + ((ty - y) * k) / n + 0.5;
        const d = Math.hypot(bx - ax, by - ay);
        if (d > 0) steep = Math.max(steep, Math.abs(groundHeight(m, bx, by) - groundHeight(m, ax, ay)) / d);
      }
      len += Math.hypot(tx - x, ty - y);
      x = tx;
      y = ty;
    }
    return { len, steep, end: p[p.length - 1] === gy * m.w + gx };
  };
  const veh = walk(w.pfs[Loco.Vehicle].find(sx, sy, gx, gy, 100000));
  const ft = walk(w.pfs[Loco.Foot].find(sx, sy, gx, gy, 100000));
  console.log(`foot ${sx},${sy} h${groundHeight(m, sx + 0.5, sy + 0.5).toFixed(2)} -> top ${gx},${gy} h${groundHeight(m, gx + 0.5, gy + 0.5).toFixed(2)} straight ${Math.hypot(gx - sx, gy - sy).toFixed(1)}`);
  console.log(`vehicle ${JSON.stringify(veh)} lineOk ${w.lineOk(sx + 0.5, sy + 0.5, gx + 0.5, gy + 0.5, Loco.Vehicle)} limit ${MAX_GRADE[1]}`);
  console.log(`foot ${JSON.stringify(ft)} limit ${MAX_GRADE[0]}`);
  for (const pid of [0, 1]) {
    const ai = new AIController(w, pid, 'hard') as any;
    const posts = ai.findPosts();
    console.log(`AI ${pid}: ${posts.map((p: any) => `${p.key}@${p.x},${p.y} E${((p.x - p.y) / Math.SQRT2).toFixed(1)} S${((p.x + p.y) / Math.SQRT2).toFixed(1)} h${groundHeight(m, p.x, p.y).toFixed(2)}`).join(' ')}`);
  }
});
