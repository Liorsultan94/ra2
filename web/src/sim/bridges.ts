import { WEAPONS, unitDef } from './defs';
import { Tile, terrainBuildable, terrainPassable } from './map';
import { TPS, type Entity, type Warhead } from './types';
import type { World } from './world';

/*
 * Collapsible bridges (RA2 style).
 *
 * Every river bridge is a neutral, indestructible-by-small-arms structure with
 * a large HP pool. Only heavy warheads hurt it (artillery, missiles,
 * thermobaric rockets, kamikaze drones; tank guns and RPGs barely scratch it,
 * small arms / flak / lasers not at all) - both direct hits on the bridge and
 * splash from shells landing near the deck. At 0 HP the bridge collapses: its
 * deck tiles turn into water, every ground unit on it falls and dies, cached
 * paths across it are dropped and units re-path.
 *
 * A small repair hut stands at each end of every bridge (on both banks, so a
 * split map can always be reconnected from either side). An Engineer entering
 * a hut of a destroyed bridge starts a rebuild that restores the deck after
 * BRIDGE_REPAIR_TICKS; entering the hut of a damaged (standing) bridge
 * restores it to full health.
 *
 * Sim state lives in `World.bridges`; the renderer (render/bridgefx.ts) reads
 * it every frame and animates damage, collapse and rebuilds from it.
 * Everything is deterministic (no RNG, no wall clock).
 */

export const BRIDGE_DEF = 'bridge';
export const BRIDGE_HUT_DEF = 'bridgehut';
export const BRIDGE_HP = 2400;
/** Rebuild time once an engineer enters a hut of a destroyed bridge. */
export const BRIDGE_REPAIR_TICKS = TPS * 8;
/** Half width of the deck (tiles) for impact tests. */
export const BRIDGE_HALF_WIDTH = 1.05;

/** Damage multiplier per warhead: heavy ordnance only. */
export const BRIDGE_VERSUS: Record<Warhead, number> = {
  mg: 0,
  flak: 0,
  laser: 0,
  cannon: 0.1,
  rocket: 0.25,
  artillery: 1,
  missile: 1,
  thermo: 0.7,
};

export type BridgeStatus = 'intact' | 'down' | 'repairing';

export interface BridgeState {
  idx: number;
  /** Deck centre and geometry (copied from GameMap.bridges). */
  x: number;
  y: number;
  length: number;
  /** Deck ends: [0] on player 0's bank (y > x), [1] on the other bank. */
  ends: [{ x: number; y: number }, { x: number; y: number }];
  /** Deck tile indices (Tile.Bridge while standing, Tile.Water while down). */
  tiles: number[];
  hp: number;
  maxHp: number;
  status: BridgeStatus;
  /** Targetable bridge entity (centre deck tile), -1 while down. */
  entity: number;
  /** Repair hut entity ids, one per end (same order as `ends`). */
  huts: number[];
  /** Tick of the last status change (collapse / repair start / reopened). */
  changedAt: number;
  /** Ticks of rebuild done while repairing. */
  repairT: number;
  /** Damaging hits taken (render: crater / scorch decals). */
  hits: number;
  /** Last damaging impact point (render), tile space. */
  hitX: number;
  hitY: number;
  hitAt: number;
}

const D = Math.SQRT1_2;

/** Can this weapon hurt a bridge at all? */
export function canHurtBridge(weaponId: string | undefined): boolean {
  const wpn = weaponId ? WEAPONS[weaponId] : undefined;
  return !!wpn && wpn.air !== 'only' && wpn.damage > 0 && BRIDGE_VERSUS[wpn.warhead] >= 0.25;
}

export const isBridge = (e: Entity) => e.def === BRIDGE_DEF;
/** Bridges and their huts ignore ordinary damage (bridges take theirs through impacts, huts are indestructible). */
export const bridgeProof = (e: Entity) => e.def === BRIDGE_DEF || e.def === BRIDGE_HUT_DEF;

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

/** Distance from a tile-space point to the deck centreline. */
export function deckDist(b: BridgeState, x: number, y: number) {
  return segDist(x, y, b.ends[0].x, b.ends[0].y, b.ends[1].x, b.ends[1].y);
}

/** Which bank of bridge `b` a point lies on (0 = ends[0] side). */
export function bankOf(b: BridgeState, x: number, y: number): 0 | 1 {
  return (x - b.x) * D - (y - b.y) * D < 0 ? 0 : 1;
}

/** Flood-fill count of walkable tiles reachable from player 0's start (terrain and structures, World.pass). */
function reachCount(w: World): number {
  const m = w.map;
  const W = m.w;
  const seen = new Uint8Array(W * m.h);
  const s = m.starts[0];
  const q = [s.y * W + s.x];
  seen[q[0]] = 1;
  let n = 0;
  while (q.length) {
    const t = q.pop()!;
    n++;
    const x = t % W;
    const y = (t / W) | 0;
    const nb = [x > 0 ? t - 1 : -1, x < W - 1 ? t + 1 : -1, y > 0 ? t - W : -1, y < m.h - 1 ? t + W : -1];
    for (const u of nb) {
      if (u < 0 || seen[u] || !w.pass[u]) continue;
      seen[u] = 1;
      q.push(u);
    }
  }
  return n;
}

/** Find a tile for a repair hut near a deck end: open, off the approach road, never cutting the map. */
function hutTile(w: World, ex: number, ey: number, out: number, reach: number): number {
  const m = w.map;
  // outward direction along the deck (away from the river), and across it
  const ox = D * out;
  const oy = -D * out;
  let best = -1;
  let bestScore = Infinity;
  for (const side of [1, -1]) {
    const cx = ex + ox * 1.2 + D * 1.7 * side;
    const cy = ey + oy * 1.2 + D * 1.7 * side;
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        const tx = Math.floor(cx) + dx;
        const ty = Math.floor(cy) + dy;
        if (!terrainBuildable(m, tx, ty) || w.occ[ty * m.w + tx] !== 0) continue;
        const px = tx + 0.5;
        const py = ty + 0.5;
        // keep the approach road (deck end and 4 tiles beyond) and the bank next to the deck clear
        if (segDist(px, py, ex - ox * 0.5, ey - oy * 0.5, ex + ox * 5, ey + oy * 5) < 1.25) continue;
        // ...and stay on this bank
        if ((px - ex) * ox + (py - ey) * oy < -0.2) continue;
        // never next to water (the shore stays walkable around the hut)
        let wet = false;
        for (let k = -1; k <= 1 && !wet; k++) for (let l = -1; l <= 1 && !wet; l++) if (m.tiles[(ty + k) * m.w + tx + l] === Tile.Water || m.tiles[(ty + k) * m.w + tx + l] === Tile.Bridge) wet = true;
        if (wet) continue;
        const score = Math.hypot(px - cx, py - cy) + (side < 0 ? 0.01 : 0);
        if (score >= bestScore) continue;
        // must not cut off any walkable tile
        const i = ty * m.w + tx;
        w.pass[i] = 0;
        const ok = reachCount(w) === reach - 1;
        w.pass[i] = 1;
        if (!ok) continue;
        best = i;
        bestScore = score;
      }
  }
  return best;
}

/** Build the bridge table and spawn the bridge / repair hut entities (World constructor). */
export function initBridges(w: World): BridgeState[] {
  const m = w.map;
  const out: BridgeState[] = m.bridges.map((br, idx) => {
    const h = br.length / 2;
    return {
      idx,
      x: br.x,
      y: br.y,
      length: br.length,
      ends: [
        { x: br.x - h * D, y: br.y + h * D },
        { x: br.x + h * D, y: br.y - h * D },
      ],
      tiles: [],
      hp: BRIDGE_HP,
      maxHp: BRIDGE_HP,
      status: 'intact',
      entity: -1,
      huts: [],
      changedAt: 0,
      repairT: 0,
      hits: 0,
      hitX: br.x,
      hitY: br.y,
      hitAt: -1,
    };
  });
  if (!out.length) return out;
  // deck tiles belong to the nearest bridge
  for (let i = 0; i < m.w * m.h; i++) {
    if (m.tiles[i] !== Tile.Bridge) continue;
    const x = (i % m.w) + 0.5;
    const y = Math.floor(i / m.w) + 0.5;
    let bi = 0;
    let bd = Infinity;
    for (const b of out) {
      const d = Math.hypot(x - b.x, y - b.y);
      if (d < bd) {
        bd = d;
        bi = b.idx;
      }
    }
    out[bi].tiles.push(i);
  }
  let reach = reachCount(w);
  for (const b of out) {
    // the targetable bridge entity sits on the deck tile nearest the centre
    let c = b.tiles[0] ?? Math.floor(b.y) * m.w + Math.floor(b.x);
    let cd = Infinity;
    for (const t of b.tiles) {
      const d = Math.hypot((t % m.w) + 0.5 - b.x, Math.floor(t / m.w) + 0.5 - b.y);
      if (d < cd) {
        cd = d;
        c = t;
      }
    }
    const e = w.spawnBuilding(BRIDGE_DEF, -1, c % m.w, Math.floor(c / m.w), true);
    e.hp = e.maxHp = BRIDGE_HP;
    b.entity = e.id;
    // repair huts, one on each bank
    for (let k = 0; k < 2; k++) {
      const end = b.ends[k];
      const t = hutTile(w, end.x, end.y, k === 0 ? -1 : 1, reach);
      if (t < 0) {
        b.huts.push(-1);
        continue;
      }
      m.blocked[t] = 1; // keeps scenery clutter and roads off the hut tile
      reach--;
      const hut = w.spawnBuilding(BRIDGE_HUT_DEF, -1, t % m.w, Math.floor(t / m.w), true);
      hut.facing = Math.atan2(end.y - hut.y, end.x - hut.x);
      b.huts.push(hut.id);
    }
  }
  return out;
}

/** Apply `dmg` (already scaled by the warhead multiplier) to a standing bridge. */
export function hurtBridge(w: World, b: BridgeState, dmg: number, x = b.x, y = b.y) {
  if (b.status !== 'intact' || dmg <= 0) return;
  b.hp = Math.max(0, b.hp - dmg);
  b.hits++;
  b.hitX = x;
  b.hitY = y;
  b.hitAt = w.tick;
  const e = w.entities.get(b.entity);
  if (e && !e.dead) {
    e.hp = Math.max(1, b.hp);
    e.lastHurt = w.tick;
  }
  if (b.hp <= 0) collapseBridge(w, b);
}

/** Damage bridges from an explosion at (x, y): full damage on the deck, splash falloff beside it. */
export function bridgeImpact(w: World, x: number, y: number, weaponId: string) {
  const wpn = WEAPONS[weaponId];
  if (!wpn) return;
  const mult = BRIDGE_VERSUS[wpn.warhead] ?? 0;
  if (mult <= 0 || wpn.damage <= 0) return;
  for (const b of w.bridges) {
    if (b.status !== 'intact') continue;
    const d = deckDist(b, x, y) - BRIDGE_HALF_WIDTH;
    let dmg = 0;
    if (d <= 0.25) dmg = wpn.damage * mult;
    else if (wpn.splash && d < wpn.splash) dmg = wpn.damage * 0.7 * mult * (1 - d / wpn.splash);
    if (dmg > 0) hurtBridge(w, b, dmg, x, y);
  }
}

/** Bring a bridge down: deck tiles become water, units on it fall, paths across it re-plan. */
export function collapseBridge(w: World, b: BridgeState) {
  if (b.status === 'down') return;
  const m = w.map;
  b.status = 'down';
  b.hp = 0;
  b.changedAt = w.tick;
  b.repairT = 0;
  const e = w.entities.get(b.entity);
  if (e && !e.dead) {
    e.hp = 0;
    e.dead = true;
    const i = e.ty * m.w + e.tx;
    if (w.occ[i] === e.id) w.occ[i] = 0;
  }
  b.entity = -1;
  const deck = new Set(b.tiles);
  for (const t of b.tiles) {
    m.tiles[t] = Tile.Water;
    w.pass[t] = 0;
  }
  for (const u of w.list) {
    if (u.dead || u.kind !== 'unit' || u.inside >= 0 || u.para || w.isAir(u)) continue;
    const t = w.tileOf(u.x, u.y);
    if (deck.has(t)) {
      w.kill(u, -1);
      continue;
    }
    // re-plan any path that runs over the fallen deck
    if (pathCrosses(w, u, deck)) w.pathTo(u, u.slotX, u.slotY);
  }
}

/** Does the unit's (line-of-sight smoothed) path run over any of these tiles? */
export function pathCrosses(w: World, u: Entity, tiles: Set<number>): boolean {
  if (!u.path || u.pathIdx >= u.path.length) return false;
  const W = w.map.w;
  let ax = u.x;
  let ay = u.y;
  for (let k = u.pathIdx; k < u.path.length; k++) {
    const bx = (u.path[k] % W) + 0.5;
    const by = Math.floor(u.path[k] / W) + 0.5;
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / 0.35);
    for (let j = 1; j <= n; j++) if (tiles.has(w.tileOf(ax + ((bx - ax) * j) / n, ay + ((by - ay) * j) / n))) return true;
    ax = bx;
    ay = by;
  }
  return false;
}

/** Finish a rebuild: the deck tiles reopen and a fresh, full-health bridge entity stands. */
export function restoreBridge(w: World, b: BridgeState) {
  const m = w.map;
  for (const t of b.tiles) {
    m.tiles[t] = Tile.Bridge;
    w.pass[t] = w.occ[t] === 0 && terrainPassable(m, t % m.w, Math.floor(t / m.w)) ? 1 : 0;
  }
  let c = b.tiles[0];
  let cd = Infinity;
  for (const t of b.tiles) {
    const d = Math.hypot((t % m.w) + 0.5 - b.x, Math.floor(t / m.w) + 0.5 - b.y);
    if (d < cd) {
      cd = d;
      c = t;
    }
  }
  if (c !== undefined) {
    const e = w.spawnBuilding(BRIDGE_DEF, -1, c % m.w, Math.floor(c / m.w), true);
    e.hp = e.maxHp = BRIDGE_HP;
    b.entity = e.id;
  }
  b.status = 'intact';
  b.hp = b.maxHp;
  b.hits = 0;
  b.changedAt = w.tick;
  b.repairT = 0;
}

/**
 * Engineer reaching a repair hut. Returns true when the engineer is used up:
 * a destroyed bridge starts its rebuild, a damaged one is restored to full.
 */
export function bridgeHutEnter(w: World, hut: Entity, _eng: Entity): boolean {
  const b = w.bridges.find((br) => br.huts.includes(hut.id));
  if (!b) return false;
  if (b.status === 'down') {
    b.status = 'repairing';
    b.repairT = 0;
    b.changedAt = w.tick;
    return true;
  }
  if (b.status === 'intact' && b.hp < b.maxHp) {
    b.hp = b.maxHp;
    b.hits = 0;
    const e = w.entities.get(b.entity);
    if (e && !e.dead) e.hp = e.maxHp;
    return true;
  }
  return false;
}

/** Per tick (World.step): impacts of this tick damage bridges, rebuilds progress. `ev0` = first event index of this tick. */
export function updateBridges(w: World, ev0: number) {
  if (!w.bridges.length) return;
  const ev = w.events;
  for (let i = ev0; i < ev.length; i++) {
    const e = ev[i];
    if (e.t === 'impact' && !e.air) bridgeImpact(w, e.x, e.y, e.weapon);
  }
  for (const b of w.bridges) {
    if (b.status !== 'repairing') continue;
    if (++b.repairT >= BRIDGE_REPAIR_TICKS) restoreBridge(w, b);
  }
}

// ------------------------------------------------------------------ AI

/**
 * AI bridge tactics (called from the AI controller's think step):
 *  - rebuild destroyed bridges with idle engineers (and train one when every
 *    crossing is down, so the map can never stay split);
 *  - when defending, drop a bridge near its base that a big enemy force is
 *    massing on, using long-range heavy units.
 */
export function bridgeTactics(w: World, pid: number, units: Entity[]) {
  if (!w.bridges.length) return;
  const p = w.players[pid];
  // ---- rebuild
  const down = w.bridges.filter((b) => b.status === 'down');
  if (down.length) {
    const engs = units.filter((u) => unitDef(u.def).engineer && !u.dead && u.inside < 0);
    const busy = new Set<number>();
    for (const u of engs) if (u.order.type === 'capture') busy.add(u.order.target);
    const sent = new Set<number>();
    for (const b of down) {
      if (b.huts.some((h) => busy.has(h))) continue;
      const eng = engs.find((u) => u.order.type === 'idle' && !sent.has(u.id));
      if (!eng) break;
      const hut = b.huts[bankOf(b, eng.x, eng.y)];
      if (hut === undefined || hut < 0) continue;
      w.issue(pid, { type: 'capture', ids: [eng.id], target: hut });
      sent.add(eng.id);
      busy.add(hut);
    }
    const def = `${p.faction}_engineer`;
    if (down.length === w.bridges.length && !engs.length && !p.queues.infantry.some((q) => q.def === def) && w.canBuild(pid, def)) w.issue(pid, { type: 'produce', def });
  }
  // ---- defensive demolition
  const sx = p.startX + 0.5;
  const sy = p.startY + 0.5;
  for (const b of w.bridges) {
    if (b.status !== 'intact') continue;
    const myBank = bankOf(b, sx, sy);
    const near = b.ends[myBank];
    if (Math.hypot(near.x - sx, near.y - sy) > 34) continue;
    const far = b.ends[1 - myBank];
    let massing = 0;
    w.queryRadius(far.x, far.y, 6, (o) => {
      if (o.kind === 'unit' && w.isEnemy(pid, o.owner) && !w.isAir(o) && !unitDef(o.def).temp && Math.hypot(o.x - far.x, o.y - far.y) < 6) massing++;
    });
    if (massing < 6) continue;
    const already = units.some((u) => u.order.type === 'attack' && u.order.target === b.entity);
    if (already) continue;
    const heavy = units.filter((u) => {
      const d = unitDef(u.def);
      if (!d.weapon || d.air || d.temp || !canHurtBridge(d.weapon)) return false;
      const wpn = WEAPONS[d.weapon];
      return wpn.range >= 8 && Math.hypot(u.x - b.x, u.y - b.y) < wpn.range + 10 && (u.order.type === 'idle' || u.order.type === 'attackMove');
    });
    if (!heavy.length) continue;
    w.issue(pid, { type: 'attack', ids: heavy.slice(0, 4).map((u) => u.id), target: b.entity });
  }
}
