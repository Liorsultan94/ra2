// SN1: the Sinai's fairness numbers (report): paths, ore, build space, houses, tech sites, corridors.
import { it } from 'vitest';
import { buildingDef } from '../src/sim/defs';
import { terrainBuildable } from '../src/sim/map';
import { Loco } from '../src/sim/slope';
import { World } from '../src/sim/world';

it('sinai fair numbers', () => {
  const w = new World({ seed: Number(process.env.SEED ?? 1), map: 'desert', players: [{ name: 'a', faction: 'usa', color: 0, isAI: true }, { name: 'b', faction: 'russia', color: 0, isAI: true }] });
  const m = w.map;
  const pf = w.pfs[Loco.Vehicle];
  const len = (sx: number, sy: number, gx: number, gy: number) => {
    pf.clearCache();
    const p = pf.find(sx, sy, gx, gy, 400000);
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
  const [s0, s1] = m.starts;
  const out: string[] = [];
  out.push(`start->enemy: P0 ${len(s0.x, s0.y, s1.x, s1.y).toFixed(1)} P1 ${len(s1.x, s1.y, s0.x, s0.y).toFixed(1)}`);
  const own = [0, 0];
  const each: string[] = [];
  for (const p of m.oreMines) {
    if (p.x >= p.y) continue;
    const a = len(s0.x, s0.y, p.x, p.y);
    const b = len(s1.x, s1.y, p.y, p.x);
    each.push(`${a.toFixed(1)}/${b.toFixed(1)}`);
    own[0] += a;
    own[1] += b;
  }
  out.push(`start->ore (each field, P0 / P1 to its mirror): ${each.join(' ')}; sum ${own[0].toFixed(1)} / ${own[1].toFixed(1)}`);
  let o0 = 0;
  let o1 = 0;
  for (let i = 0; i < m.w * m.h; i++) {
    const v = m.ore[i] * (m.oreKind[i] === 2 ? 2 : 1);
    if (i % m.w < Math.floor(i / m.w)) o0 += v;
    else if (i % m.w > Math.floor(i / m.w)) o1 += v;
  }
  out.push(`ore value by half ${o0} / ${o1}; oil ${m.oils.filter((o) => o.x < o.y).length} / ${m.oils.filter((o) => o.x > o.y).length}`);
  const room = (s: { x: number; y: number }) => {
    let n = 0;
    for (let y = s.y - 20; y <= s.y + 20; y++) for (let x = s.x - 20; x <= s.x + 20; x++) if (Math.hypot(x - s.x, y - s.y) <= 20 && x >= 0 && y >= 0 && x < m.w - 1 && y < m.h - 1 && terrainBuildable(m, x, y, 2, 2)) n++;
    return n;
  };
  out.push(`build space (open gentle 2x2 spots within 20): ${room(s0)} / ${room(s1)}`);
  const side = (pick: (d: ReturnType<typeof buildingDef>) => boolean) => {
    const r = [0, 0, 0];
    for (const e of w.list) {
      if (e.owner >= 0 || e.kind !== 'building' || !pick(buildingDef(e.def))) continue;
      const da = Math.hypot(e.x - s0.x, e.y - s0.y);
      const db = Math.hypot(e.x - s1.x, e.y - s1.y);
      r[Math.abs(da - db) < 1e-6 ? 2 : da < db ? 0 : 1]++;
    }
    return r;
  };
  const h = side((d) => !!d.garrison);
  const t = side((d) => !!d.techKind);
  out.push(`garrisonable houses P0 side ${h[0]} / P1 side ${h[1]} (on the axis ${h[2]}); tech sites ${t[0]} / ${t[1]}`);
  out.push(`map ${m.w}x${m.h}, structures ${m.structures.length}, bridges ${m.bridges.length}`);
  console.log(out.join('\n'));
});
