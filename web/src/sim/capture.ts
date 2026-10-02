// Capturable neutral tech structures (Red Alert 2 style). An Engineer entering
// one is consumed and the building changes hands (World.engineerEnter); while a
// player holds it they get its bonus:
//  - Field Hospital: heals that player's infantry around it;
//  - Civilian Airport: the Airborne-drop support power recharges 50% faster;
//  - Comms Tower: wide sight (its def) and works as a radar;
//  - Oil Derricks (the map's existing pairs): steady income (BuildingDef.income).
// Sites are mirrored through the map centre (fair for both starts) and validated
// at world creation: open buildable ground, a walkable margin, and a flood fill
// proving no part of the map is cut off. Deterministic: no randomness at all.

import { buildingDef, unitDef } from './defs';
import { HOSPITAL_HEAL, HOSPITAL_RADIUS } from './specialdefs';
import { TPS } from './types';
import type { World } from './world';

/** Candidate top-left corners for player 0's half (mirrored for player 1); the first valid one is used. */
const SITES: { def: string; at: [number, number][] }[] = [
  { def: 'tech_hospital', at: [[18, 60], [14, 40], [22, 66], [12, 44], [28, 44]] },
  { def: 'tech_comms', at: [[54, 88], [36, 82], [22, 90], [40, 86], [52, 66]] },
  { def: 'tech_airport', at: [[6, 30], [8, 24], [4, 36], [10, 34], [12, 28]] },
];

function reachable(w: World): number {
  const { w: W, h: H } = w.map;
  const s = w.map.starts[0];
  const seen = new Uint8Array(W * H);
  const q = [s.y * W + s.x];
  seen[q[0]] = 1;
  let n = 0;
  while (q.length) {
    const t = q.pop()!;
    n++;
    const x = t % W;
    const y = (t / W) | 0;
    if (x > 0 && !seen[t - 1] && w.pass[t - 1]) (seen[t - 1] = 1), q.push(t - 1);
    if (x < W - 1 && !seen[t + 1] && w.pass[t + 1]) (seen[t + 1] = 1), q.push(t + 1);
    if (y > 0 && !seen[t - W] && w.pass[t - W]) (seen[t - W] = 1), q.push(t - W);
    if (y < H - 1 && !seen[t + W] && w.pass[t + W]) (seen[t + W] = 1), q.push(t + W);
  }
  return n;
}

function siteOk(w: World, defId: string, tx: number, ty: number): boolean {
  const d = buildingDef(defId);
  const { w: W, h: H } = w.map;
  if (tx < 2 || ty < 2 || tx + d.w > W - 2 || ty + d.h > H - 2 || !w.canPlace(-1, defId, tx, ty, -1, false)) return false;
  // a walkable ring all around
  for (let y = ty - 1; y <= ty + d.h; y++)
    for (let x = tx - 1; x <= tx + d.w; x++) {
      const inside = x >= tx && y >= ty && x < tx + d.w && y < ty + d.h;
      if (!inside && !w.pass[y * W + x]) return false;
    }
  // keep clear of the start areas
  for (const s of w.map.starts) if (Math.hypot(tx + d.w / 2 - s.x, ty + d.h / 2 - s.y) < 14) return false;
  return true;
}

/** Place the mirrored pairs of tech structures (neutral, capturable). */
export function spawnTechSites(w: World) {
  const { w: W, h: H } = w.map;
  let reach = reachable(w);
  for (const site of w.map.techSites ?? SITES) {
    const d = buildingDef(site.def);
    for (const [x, y] of site.at) {
      // mirror the footprint through the centre
      const mx = W - x - d.w;
      const my = H - y - d.h;
      if (!siteOk(w, site.def, x, y) || !siteOk(w, site.def, mx, my)) continue;
      const a = w.spawnBuilding(site.def, -1, x, y, true);
      const b = w.spawnBuilding(site.def, -1, mx, my, true);
      const now = reachable(w);
      if (now !== reach - 2 * d.w * d.h) {
        w.remove(a);
        w.remove(b);
        continue;
      }
      reach = now;
      break;
    }
  }
}

/** Effects of captured tech structures. Runs every tick right after the economy update. */
export function updateTechs(w: World) {
  for (const b of w.list) {
    if (b.dead || b.kind !== 'building' || b.owner < 0) continue;
    const kind = buildingDef(b.def).techKind;
    if (!kind) continue;
    const p = w.players[b.owner];
    switch (kind) {
      case 'comms':
        if (!w.isLowPower(p)) p.radarOnline = true;
        break;
      case 'airport':
        // half a tick of extra charge per tick: the drop arrives 50% sooner
        if (p.airdropAt > w.tick && w.tick % 2 === 0 && !w.isLowPower(p)) {
          p.airdropAt--;
          p.airdropFrom--;
        }
        break;
      case 'hospital':
        if ((w.tick + b.id) % TPS !== 0) break;
        w.queryRadius(b.x, b.y, HOSPITAL_RADIUS, (o) => {
          if (o.owner !== b.owner || o.kind !== 'unit' || o.hp >= o.maxHp || o.para) return;
          if (Math.hypot(o.x - b.x, o.y - b.y) > HOSPITAL_RADIUS) return;
          if (unitDef(o.def).category === 'infantry') o.hp = Math.min(o.maxHp, o.hp + o.maxHp * HOSPITAL_HEAL);
        });
        break;
    }
  }
}
