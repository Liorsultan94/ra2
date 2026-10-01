import { WEAPONS, unitDef } from './defs';
import { standHeight } from './map';
import { INTERCEPTABLE, TPS, type Entity, type Flight, type Projectile, type WeaponDef } from './types';
import type { World } from './world';

/*
 * Deterministic 3D projectile physics.
 *
 * Unguided flights (shell, artillery, mortar, rocket salvos, ballistic and
 * hypersonic missiles) follow analytic trajectories from launch to the aim
 * point, so they always land where they were aimed and every client computes
 * the same positions. Guided flights (ATGM, top-attack, SAM, interceptor,
 * air-launched missiles) are integrated each tick with a turn-rate-limited
 * pursuit / proportional navigation law. All projectiles have real 3D
 * positions, which is what lets air defences intercept them mid-flight.
 */

const DT = 1 / TPS;

/** Height of an entity's centre (absolute world height). */
export function entityZ(w: World, e: Entity): number {
  const g = standHeight(w.map, e.x, e.y);
  if (e.kind === 'building') return g + 0.45;
  const d = unitDef(e.def);
  if (d.air) return Math.max(g, 0) + e.z;
  return g + (d.category === 'infantry' ? 0.15 : 0.3);
}

function groundZ(w: World, x: number, y: number) {
  const { map } = w;
  if (x < 0 || y < 0 || x >= map.w || y >= map.h) return -0.5;
  return standHeight(map, x, y);
}

interface FlightSpec {
  time: (dist: number) => number; // seconds (analytic)
  arc: (dist: number) => number; // apex height above the chord
  guided?: boolean;
  maxSpeed?: number; // tiles/s (guided)
  accel?: number; // tiles/s^2
  turn?: number; // rad/s
  hit?: number; // proximity radius
  life?: number; // seconds before self-destruct
}

const SPEC: Record<Flight, FlightSpec> = {
  shell: { time: (d) => Math.max(0.12, d / 26), arc: (d) => d * 0.015 },
  artillery: { time: (d) => 1.4 + d * 0.13, arc: (d) => 1.2 + d * 0.42 },
  mortar: { time: (d) => 1.8 + d * 0.12, arc: (d) => 2.0 + d * 0.7 },
  rocketSalvo: { time: (d) => 0.9 + d * 0.11, arc: (d) => 0.6 + d * 0.22 },
  ballistic: { time: (d) => 3.2 + d * 0.14, arc: (d) => 6 + d * 0.55 },
  hypersonic: { time: (d) => 2.4 + d * 0.07, arc: (d) => 4.5 + d * 0.3 },
  atgm: { time: () => 0, arc: () => 0, guided: true, maxSpeed: 9, accel: 30, turn: 4.5, hit: 0.35, life: 6 },
  topAttack: { time: () => 0, arc: () => 0, guided: true, maxSpeed: 8, accel: 22, turn: 5, hit: 0.35, life: 8 },
  airMissile: { time: () => 0, arc: () => 0, guided: true, maxSpeed: 12, accel: 35, turn: 5, hit: 0.4, life: 6 },
  sam: { time: () => 0, arc: () => 0, guided: true, maxSpeed: 16, accel: 40, turn: 6, hit: 0.6, life: 6 },
  interceptor: { time: () => 0, arc: () => 0, guided: true, maxSpeed: 18, accel: 55, turn: 8, hit: 0.55, life: 5 },
};

function blank(w: World, src: Entity, weapon: WeaponDef, flight: Flight): Projectile {
  const sz = entityZ(w, src) + (src.kind === 'building' ? 0.35 : 0.1);
  return {
    id: w.allocId(),
    owner: src.owner,
    weapon: weapon.id,
    flight,
    sourceId: src.id,
    targetId: -1,
    targetProj: -1,
    x: src.x,
    y: src.y,
    z: sz,
    px: src.x,
    py: src.y,
    pz: sz,
    vx: 0,
    vy: 0,
    vz: 0,
    sx: src.x,
    sy: src.y,
    sz,
    tx: src.x,
    ty: src.y,
    tz: sz,
    age: 0,
    T: 1,
    arc: 0,
    speed: 0,
    maxSpeed: 0,
    turn: 0,
    phase: 0,
    engaged: 0,
    dead: false,
  };
}

/** Fire a travelling projectile from src at entity t (aim point ax, ay). */
export function launch(w: World, src: Entity, t: Entity, weapon: WeaponDef, ax: number, ay: number) {
  const flight = weapon.flight ?? 'shell';
  const spec = SPEC[flight];
  const p = blank(w, src, weapon, flight);
  p.targetId = t.id;
  p.tx = ax;
  p.ty = ay;
  p.tz = t.kind === 'unit' && unitDef(t.def).air ? entityZ(w, t) : groundZ(w, ax, ay) + (t.kind === 'building' ? 0.25 : 0.12);
  const dx = ax - p.x;
  const dy = ay - p.y;
  const dist = Math.hypot(dx, dy);
  // start the round slightly ahead of the launcher, at the muzzle
  if (dist > 0.01 && flight !== 'sam' && flight !== 'interceptor') {
    const off = src.kind === 'unit' && unitDef(src.def).category === 'infantry' ? 0.12 : 0.45;
    p.x = p.sx = p.px = src.x + (dx / dist) * Math.min(off, dist * 0.5);
    p.y = p.sy = p.py = src.y + (dy / dist) * Math.min(off, dist * 0.5);
  }
  if (!spec.guided) {
    p.T = Math.max(2, Math.round(spec.time(dist) * TPS));
    p.arc = spec.arc(dist);
  } else {
    p.maxSpeed = spec.maxSpeed!;
    p.turn = spec.turn! * DT;
    const h = Math.max(0.01, dist);
    let dirx = dx / h;
    let diry = dy / h;
    let dirz = 0.15;
    let speed = p.maxSpeed * 0.35;
    if (flight === 'topAttack') dirz = 0.9;
    if (flight === 'airMissile') {
      // dropped from the rail, initially along the launcher's heading
      dirx = Math.cos(src.facing) * 0.7 + dirx * 0.3;
      diry = Math.sin(src.facing) * 0.7 + diry * 0.3;
      dirz = -0.25;
      speed = unitDef(src.def).speed + 2;
    }
    if (flight === 'sam' || flight === 'interceptor') {
      dirx *= 0.25;
      diry *= 0.25;
      dirz = 1;
      speed = p.maxSpeed * 0.25;
    }
    const n = Math.hypot(dirx, diry, dirz);
    p.vx = (dirx / n) * speed;
    p.vy = (diry / n) * speed;
    p.vz = (dirz / n) * speed;
    p.speed = speed;
  }
  w.projectiles.push(p);
  w.events.push({ t: 'launch', id: p.id, flight, weapon: weapon.id, x: p.x, y: p.y, z: p.z, owner: p.owner, sourceId: src.id });
  return p;
}

/** Launch an interceptor from an air-defence battery at an incoming projectile. */
export function launchInterceptor(w: World, src: Entity, threat: Projectile, weapon: WeaponDef) {
  const flight: Flight = weapon.flight === 'interceptor' ? 'interceptor' : 'sam';
  const spec = SPEC[flight];
  const p = blank(w, src, weapon, flight);
  p.targetProj = threat.id;
  p.maxSpeed = spec.maxSpeed!;
  p.turn = spec.turn! * DT;
  const dx = threat.x - p.x;
  const dy = threat.y - p.y;
  const h = Math.max(0.01, Math.hypot(dx, dy));
  const n = Math.hypot(0.3, 1);
  p.speed = p.maxSpeed * 0.3;
  p.vx = ((dx / h) * 0.3 * p.speed) / n;
  p.vy = ((dy / h) * 0.3 * p.speed) / n;
  p.vz = p.speed / n;
  threat.engaged++;
  w.projectiles.push(p);
  w.events.push({ t: 'launch', id: p.id, flight, weapon: weapon.id, x: p.x, y: p.y, z: p.z, owner: p.owner, sourceId: src.id });
}

// ------------------------------------------------------------------ update

function analyticPos(p: Projectile, k: number, out: { x: number; y: number; z: number }) {
  let e = k;
  let lift = 4 * k * (1 - k);
  let side = 0;
  if (p.flight === 'ballistic') {
    // slow vertical boost, then fast descent: skew the parabola
    e = k * k * (3 - 2 * k) * 0.35 + k * 0.65;
    lift = Math.sin(Math.PI * Math.pow(k, 0.8));
  } else if (p.flight === 'hypersonic') {
    // boost to apex, then a long flat glide with S-turns and a final plunge
    lift = k < 0.3 ? Math.sin((k / 0.3) * (Math.PI / 2)) : 1 - Math.pow((k - 0.3) / 0.7, 2.6);
    side = k > 0.3 ? Math.sin((k - 0.3) * Math.PI * 4) * 1.1 * (1 - k) : 0;
  }
  const dx = p.tx - p.sx;
  const dy = p.ty - p.sy;
  const len = Math.hypot(dx, dy) || 1;
  out.x = p.sx + dx * e + (-dy / len) * side;
  out.y = p.sy + dy * e + (dx / len) * side;
  out.z = p.sz + (p.tz - p.sz) * k + p.arc * lift;
}

const tmp = { x: 0, y: 0, z: 0 };

export function stepProjectiles(w: World) {
  const byId = new Map<number, Projectile>();
  for (const p of w.projectiles) byId.set(p.id, p);
  for (const p of w.projectiles) {
    if (p.dead) continue;
    p.px = p.x;
    p.py = p.y;
    p.pz = p.z;
    p.age++;
    const spec = SPEC[p.flight];
    if (!spec.guided) {
      const k = Math.min(1, p.age / p.T);
      analyticPos(p, k, tmp);
      p.x = tmp.x;
      p.y = tmp.y;
      p.z = tmp.z;
      p.vx = (p.x - p.px) * TPS;
      p.vy = (p.y - p.py) * TPS;
      p.vz = (p.z - p.pz) * TPS;
      if (k >= 1) detonate(w, p, true);
      continue;
    }
    stepGuided(w, p, spec, byId);
  }
  w.projectiles = w.projectiles.filter((p) => !p.dead);
}

function stepGuided(w: World, p: Projectile, spec: FlightSpec, byId: Map<number, Projectile>) {
  // ----- where are we going?
  let ax: number;
  let ay: number;
  let az: number;
  let tvx = 0;
  let tvy = 0;
  let tvz = 0;
  if (p.targetProj >= 0) {
    const t = byId.get(p.targetProj);
    if (!t || t.dead) {
      airburst(w, p, 'expire');
      return;
    }
    ax = t.x;
    ay = t.y;
    az = t.z;
    tvx = t.vx;
    tvy = t.vy;
    tvz = t.vz;
  } else {
    const t = w.get(p.targetId);
    if (t) {
      ax = t.x;
      ay = t.y;
      az = entityZ(w, t);
      if (t.kind === 'unit') {
        tvx = (t.x - t.px) * TPS;
        tvy = (t.y - t.py) * TPS;
        tvz = (t.z - t.pz) * TPS;
      }
      p.tx = ax;
      p.ty = ay;
      p.tz = az;
    } else {
      // target gone: keep flying at the last known point
      ax = p.tx;
      ay = p.ty;
      az = p.tz;
    }
  }
  const rx = ax - p.x;
  const ry = ay - p.y;
  const rz = az - p.z;
  const range = Math.hypot(rx, ry, rz);
  // lead the target (time-to-go estimate)
  const tgo = range / Math.max(1, p.speed);
  let gx = ax + tvx * tgo * 0.9;
  let gy = ay + tvy * tgo * 0.9;
  let gz = az + tvz * tgo * 0.9;
  if (p.flight === 'topAttack' && p.phase === 0) {
    // loft: climb towards a point high above the target, then dive onto the roof
    const hd = Math.hypot(rx, ry);
    gz = az + Math.min(2.2, 0.6 + hd * 0.45);
    if (hd < 1.6) p.phase = 1;
  }
  if ((p.flight === 'sam' || p.flight === 'interceptor') && p.age < 6) {
    // vertical boost off the rail before guidance kicks in
    gx = p.x + p.vx;
    gy = p.y + p.vy;
    gz = p.z + 10;
  }
  if (p.flight === 'atgm' && p.age < 4) gz += 0.4;

  // ----- steer: rotate velocity towards the desired direction, limited turn rate
  let dx = gx - p.x;
  let dy = gy - p.y;
  let dz = gz - p.z;
  const dl = Math.hypot(dx, dy, dz) || 1;
  dx /= dl;
  dy /= dl;
  dz /= dl;
  const sp = Math.hypot(p.vx, p.vy, p.vz) || 1;
  let cx = p.vx / sp;
  let cy = p.vy / sp;
  let cz = p.vz / sp;
  const dot = Math.max(-1, Math.min(1, cx * dx + cy * dy + cz * dz));
  const ang = Math.acos(dot);
  if (ang <= p.turn) {
    cx = dx;
    cy = dy;
    cz = dz;
  } else {
    const k = p.turn / ang;
    cx += (dx - cx) * k;
    cy += (dy - cy) * k;
    cz += (dz - cz) * k;
    const n = Math.hypot(cx, cy, cz) || 1;
    cx /= n;
    cy /= n;
    cz /= n;
  }
  p.speed = Math.min(p.maxSpeed, p.speed + (spec.accel ?? 20) * DT);
  p.vx = cx * p.speed;
  p.vy = cy * p.speed;
  p.vz = cz * p.speed;
  p.x += p.vx * DT;
  p.y += p.vy * DT;
  p.z += p.vz * DT;

  // ----- fuzing
  const hit = spec.hit ?? 0.4;
  // segment-point distance so fast missiles don't tunnel through the target
  const sx = p.x - p.px;
  const sy = p.y - p.py;
  const sz = p.z - p.pz;
  const sl2 = sx * sx + sy * sy + sz * sz || 1;
  const tt = Math.max(0, Math.min(1, ((ax - p.px) * sx + (ay - p.py) * sy + (az - p.pz) * sz) / sl2));
  const md = Math.hypot(p.px + sx * tt - ax, p.py + sy * tt - ay, p.pz + sz * tt - az);
  if (md <= hit) {
    p.x = p.px + sx * tt;
    p.y = p.py + sy * tt;
    p.z = p.pz + sz * tt;
    if (p.targetProj >= 0) interceptResolve(w, p, byId.get(p.targetProj)!);
    else detonate(w, p, true);
    return;
  }
  // guided missiles fly nap-of-the-earth: never dip below the terrain while still away from the target
  const gnd = groundZ(w, p.x, p.y);
  if (p.targetProj < 0 && Math.hypot(ax - p.x, ay - p.y) > 0.7 && p.z < gnd + 0.25) {
    p.z = gnd + 0.25;
    if (p.vz < 0) p.vz = 0;
  }
  if (p.z <= gnd - 0.02) {
    p.z = groundZ(w, p.x, p.y);
    detonate(w, p, false);
    return;
  }
  if (p.age > (spec.life ?? 6) * TPS || p.x < -2 || p.y < -2 || p.x > w.map.w + 2 || p.y > w.map.h + 2) airburst(w, p, 'expire');
}

function airburst(w: World, p: Projectile, kind: 'kill' | 'miss' | 'expire', victim?: Projectile) {
  p.dead = true;
  w.events.push({ t: 'airburst', x: p.x, y: p.y, z: p.z, kind, weapon: p.weapon, victim: victim?.flight });
}

function interceptResolve(w: World, p: Projectile, threat: Projectile) {
  const wpn = WEAPONS[p.weapon];
  const pk = threat.flight === 'hypersonic' ? (wpn.intercept?.pkHypersonic ?? 0.3) : (wpn.intercept?.pk ?? 0.7);
  threat.engaged = Math.max(0, threat.engaged - 1);
  if (w.rng.next() < pk) {
    threat.dead = true;
    airburst(w, p, 'kill', threat);
  } else airburst(w, p, 'miss');
}

/** Warhead functions: direct hit + splash, active protection. */
function detonate(w: World, p: Projectile, onTarget: boolean) {
  p.dead = true;
  const wpn = WEAPONS[p.weapon];
  const src = w.get(p.sourceId) ?? ({ id: p.sourceId, owner: p.owner } as Entity);
  const t = w.get(p.targetId);
  let direct = false;
  if (t && onTarget) {
    // active protection systems defeat rockets and missiles before they hit
    if (t.kind === 'unit' && (p.flight === 'atgm' || p.flight === 'topAttack' || p.flight === 'airMissile' || p.flight === 'shell')) {
      const aps = unitDef(t.def).aps ?? 0;
      const chance = p.flight === 'shell' ? aps * 0.4 : p.flight === 'topAttack' ? aps * 0.6 : aps;
      if (chance > 0 && w.rng.next() < chance) {
        w.events.push({ t: 'intercept', x: t.x, y: t.y, id: t.id });
        return;
      }
    }
    const near = t.kind === 'building' ? w.distTo({ x: p.x, y: p.y } as Entity, t) < 0.6 : Math.hypot(t.x - p.x, t.y - p.y) < 0.75;
    if (near && (!unitDef(t.def)?.air || t.kind === 'building' || wpn.air !== 'no')) {
      w.damage(t, wpn.damage, wpn.warhead, src);
      direct = true;
    }
  }
  if (wpn.splash) w.splash(p.x, p.y, wpn.splash, wpn.damage * 0.7, wpn.warhead, src, direct ? (t?.id ?? -1) : -1);
  const air = p.z - groundZ(w, p.x, p.y) > 0.6;
  w.events.push({ t: 'impact', x: p.x, y: p.y, z: p.z, weapon: p.weapon, air, direct });
}

// --------------------------------------------------------------- defences

/**
 * Air-defence logic for a battery or vehicle with an `intercept` weapon:
 * pick the most urgent incoming projectile that threatens our side and
 * launch at it. Returns true when it fired.
 */
export function tryIntercept(w: World, e: Entity, wpn: WeaponDef): boolean {
  const ic = wpn.intercept;
  if (!ic || e.cooldown > 0) return false;
  const range = w.weaponRange(e, wpn);
  let best: Projectile | null = null;
  let bestScore = Infinity;
  for (const p of w.projectiles) {
    if (p.dead || !w.isEnemy(e.owner, p.owner) || !ic.kinds.includes(p.flight)) continue;
    if (p.engaged >= (p.flight === 'ballistic' || p.flight === 'hypersonic' ? 2 : 1)) continue;
    const d = Math.hypot(p.x - e.x, p.y - e.y);
    if (d > range) continue;
    // only engage threats that will land near us (impact point within defended radius)
    if (Math.hypot(p.tx - e.x, p.ty - e.y) > range + 4) continue;
    const remaining = p.T - p.age;
    if (remaining < 4) continue; // too late
    const score = remaining + d * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  if (!best) return false;
  e.cooldown = Math.max(8, Math.round(wpn.rof * 0.5));
  e.turret = Math.atan2(best.y - e.y, best.x - e.x);
  if (wpn.projectile === 'beam') {
    // directed energy: hit instantly, chance to burn it down
    w.events.push({ t: 'fire', id: e.id, weapon: wpn.id, x: e.x, y: e.y, tx: best.x, ty: best.y, targetId: -1, owner: e.owner });
    if (w.rng.next() < ic.pk) {
      best.dead = true;
      w.events.push({ t: 'airburst', x: best.x, y: best.y, z: best.z, kind: 'kill', weapon: wpn.id, victim: best.flight });
    }
    return true;
  }
  launchInterceptor(w, e, best, wpn);
  w.events.push({ t: 'fire', id: e.id, weapon: wpn.id, x: e.x, y: e.y, tx: best.x, ty: best.y, targetId: -1, owner: e.owner });
  return true;
}

export function isInterceptable(f: Flight) {
  return INTERCEPTABLE.includes(f);
}

