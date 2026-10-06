// Capturable neutral tech structures (Red Alert 2 style). An Engineer entering
// one is consumed and the building changes hands (World.engineerEnter); while a
// player holds it they get its bonus:
//  - Field Hospital: heals that player's infantry around it;
//  - Civilian Airport: the Airborne-drop support power recharges 50% faster;
//  - Comms Tower: wide sight (its def) and works as a radar;
//  - Oil Derricks (the map's existing pairs): steady income (BuildingDef.income).
// Sites are mirrored through the map centre (fair for both starts) and validated
// at world creation (neutralSites, a pure function of the map): open, gentle buildable ground off the
// roads, a walkable margin, and a flood fill proving no part of the map is cut off. Deterministic: no
// randomness at all.

import { buildingDef, unitDef } from './defs';
import { distToSegment, terrainBuildable, terrainPassable, type GameMap } from './map';
import { HOSPITAL_HEAL, HOSPITAL_RADIUS } from './specialdefs';
import { TPS } from './types';
import type { World } from './world';

/** Candidate top-left corners for player 0's half (mirrored for player 1); the first valid one is used. */
const SITES: { def: string; at: [number, number][] }[] = [
  { def: 'tech_hospital', at: [[18, 60], [14, 40], [22, 66], [12, 44], [28, 44]] },
  { def: 'tech_comms', at: [[54, 88], [36, 82], [22, 90], [40, 86], [52, 66]] },
  { def: 'tech_airport', at: [[6, 30], [8, 24], [4, 36], [10, 34], [12, 28]] },
];

/** A neutral structure placed at world creation: oil derricks and the capturable tech sites. */
export interface NeutralSite {
  def: string;
  /** Footprint: top-left tile and size. */
  x: number;
  y: number;
  w: number;
  h: number;
}

const plans = new WeakMap<GameMap, NeutralSite[]>();

/**
 * Where the oil derricks and the tech structures stand: a pure function of the map, so the world
 * (spawnTechSites) and the renderer's scenery layout (roads, tracks, fields and hedges keep off
 * these footprints) agree. Tech sites take the first candidate pair that is open, gentle ground
 * (terrainBuildable) with a walkable ring, away from the starts and off the map's roads, and cuts
 * nothing off (flood fill); if no candidate is off the roads, the first one that fits otherwise.
 */
export function neutralSites(m: GameMap): NeutralSite[] {
  let out = plans.get(m);
  if (out) return out;
  out = [];
  const { w: W, h: H } = m;
  const pass = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) pass[y * W + x] = terrainPassable(m, x, y) ? 1 : 0;
  const taken = new Uint8Array(W * H);
  const put = (s: NeutralSite, v: number) => {
    for (let y = s.y; y < s.y + s.h; y++)
      for (let x = s.x; x < s.x + s.w; x++) {
        const i = y * W + x;
        taken[i] = v;
        pass[i] = v ? 0 : terrainPassable(m, x, y) ? 1 : 0;
      }
  };
  for (const o of m.oils) {
    const s = { def: 'oil', x: Math.min(o.x, W - 2), y: Math.min(o.y, H - 2), w: 2, h: 2 };
    out.push(s);
    put(s, 1);
  }
  const reachable = () => {
    const st = m.starts[0];
    const seen = new Uint8Array(W * H);
    const q = [st.y * W + st.x];
    seen[q[0]] = 1;
    let n = 0;
    while (q.length) {
      const t = q.pop()!;
      n++;
      const x = t % W;
      const y = (t / W) | 0;
      if (x > 0 && !seen[t - 1] && pass[t - 1]) (seen[t - 1] = 1), q.push(t - 1);
      if (x < W - 1 && !seen[t + 1] && pass[t + 1]) (seen[t + 1] = 1), q.push(t + 1);
      if (y > 0 && !seen[t - W] && pass[t - W]) (seen[t - W] = 1), q.push(t - W);
      if (y < H - 1 && !seen[t + W] && pass[t + W]) (seen[t + W] = 1), q.push(t + W);
    }
    return n;
  };
  const roadDist = (px: number, py: number) => {
    let best = Infinity;
    for (const r of m.roads) for (let k = 0; k < r.length - 1; k++) best = Math.min(best, distToSegment(px, py, r[k].x + 0.5, r[k].y + 0.5, r[k + 1].x + 0.5, r[k + 1].y + 0.5));
    return best;
  };
  const siteOk = (tx: number, ty: number, dw: number, dh: number, offRoad: boolean) => {
    if (tx < 2 || ty < 2 || tx + dw > W - 2 || ty + dh > H - 2 || !terrainBuildable(m, tx, ty, dw, dh)) return false;
    // a walkable ring all around, nothing else on the footprint
    for (let y = ty - 1; y <= ty + dh; y++)
      for (let x = tx - 1; x <= tx + dw; x++) {
        const inside = x >= tx && y >= ty && x < tx + dw && y < ty + dh;
        if (inside ? taken[y * W + x] : !pass[y * W + x]) return false;
        // (a street is up to three tiles wide: the footprint keeps a tile clear of the paving)
        if (inside && offRoad && roadDist(x + 0.5, y + 0.5) < SITE_ROAD_CLEAR) return false;
      }
    // keep clear of the start areas
    for (const s of m.starts) if (Math.hypot(tx + dw / 2 - s.x, ty + dh / 2 - s.y) < 14) return false;
    return true;
  };
  let reach = reachable();
  for (const site of m.techSites ?? SITES) {
    const d = buildingDef(site.def);
    let done = false;
    for (const offRoad of [true, false]) {
      for (const [x, y] of site.at) {
        // mirror the footprint through the centre
        const a = { def: site.def, x, y, w: d.w, h: d.h };
        const b = { def: site.def, x: W - x - d.w, y: H - y - d.h, w: d.w, h: d.h };
        if (!siteOk(a.x, a.y, d.w, d.h, offRoad) || !siteOk(b.x, b.y, d.w, d.h, offRoad)) continue;
        put(a, 1);
        put(b, 1);
        const now = reachable();
        if (now !== reach - 2 * d.w * d.h) {
          put(a, 0);
          put(b, 0);
          continue;
        }
        reach = now;
        out.push(a, b);
        done = true;
        break;
      }
      if (done) break;
    }
  }
  plans.set(m, out);
  return out;
}

/** Tech sites keep their footprint tile centres this far from the map's road centre lines (when a candidate allows). */
const SITE_ROAD_CLEAR = 2;

/** Place the mirrored pairs of tech structures (neutral, capturable): neutralSites' plan. */
export function spawnTechSites(w: World) {
  for (const s of neutralSites(w.map)) if (s.def !== 'oil') w.spawnBuilding(s.def, -1, s.x, s.y, true);
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
