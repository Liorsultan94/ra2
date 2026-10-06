import { WEAPONS, unitDef } from './defs';
import { standHeight } from './map';
import { DECOY_AGE, DECOY_RANGE, evasionChance, releaseDecoy, stepDecoy } from './stealth';
import { INTERCEPTABLE, TPS, type Entity, type Flight, type Projectile, type WeaponDef } from './types';
import type { World } from './world';
import { bigBlast } from './medic';

/*
 * Deterministic 3D projectile physics.
 *
 * Unguided flights (shell, artillery, mortar, rocket salvos, ballistic and
 * hypersonic missiles) follow analytic trajectories from launch to the aim
 * point, so they always land where they were aimed and every client computes
 * the same positions. Cruise missiles fly a curved dog-leg ground track at a
 * fixed pace and follow the terrain below them, then pop up and dive.
 * Guided flights (ATGM, top-attack, SAM, interceptor, air-launched missiles)
 * are integrated each tick with a turn-rate-limited pursuit / proportional
 * navigation law. All projectiles have real 3D positions, which is what lets
 * air defences intercept them mid-flight.
 *
 * Missile toughness: every interceptable round has `hp` (the weapon's
 * interceptHp, default 1). A successful intercept removes one point; at 0 the
 * round is destroyed, otherwise it flies on damaged (`hits`), knocked off its
 * aim point by a seeded random drift and with a weaker warhead.
 */

const DT = 1 / TPS;
/** Shoulder-launched missiles (MANPADS): launch height above the gunner's feet (tiles) and the superelevation of the tube. */
const SHOULDER_Z = 0.2;
const SHOULDER_LOFT = 0.45;
const TAU = Math.PI * 2;

// cruise missile profile (heights above the terrain, distances in tiles)
const CRUISE_ALT = 0.45;
const CRUISE_BOOST_TICKS = 14;
const CRUISE_POPUP = 2.8; // remaining track length where the pop-up starts
const CRUISE_DIVE = 1.2; // ... and where the terminal dive starts

/** Height of an entity's centre (absolute world height). */
export function entityZ(w: World, e: Entity): number {
  const g = standHeight(w.map, e.x, e.y);
  if (e.kind === 'building') return g + 0.45;
  const d = unitDef(e.def);
  if (d.air) return Math.max(g, 0) + e.z;
  // under canopy (airborne drop)
  if (e.para) return Math.max(g, 0) + e.z + 0.15;
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
  // subsonic: ~2.9 tiles/s along a track ~10% longer than the chord (stepped by stepCruise, not analyticPos)
  cruise: { time: (d) => 0.8 + (d * 1.1) / 2.9, arc: () => 0 },
  // jet bomb: keeps most of the jet's forward speed while it falls (the arc is set from the drop height in launch)
  bomb: { time: (d) => 0.25 + d / 3.6, arc: () => 0 },
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
    hp: 1,
    maxHp: 1,
    hits: 0,
    dox: 0,
    doy: 0,
    dbx: 0,
    dby: 0,
    dk: 0,
    wx: 0,
    wy: 0,
    decoy: 0,
    dcx: 0,
    dcy: 0,
    dcz: 0,
    dcvx: 0,
    dcvy: 0,
    dcvz: 0,
    dcAt: 0,
    dcr: 1e9,
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
  if (weapon.shoulder && dist > 0.01) {
    // MANPADS: off the tube on the gunner's shoulder, a little ahead of him
    const off = Math.min(0.14, dist * 0.5);
    p.x = p.sx = p.px = src.x + (dx / dist) * off;
    p.y = p.sy = p.py = src.y + (dy / dist) * off;
    p.z = p.sz = p.pz = p.z + SHOULDER_Z;
  } else if (dist > 0.01 && flight !== 'sam' && flight !== 'interceptor') {
    const off = src.kind === 'unit' && unitDef(src.def).category === 'infantry' ? 0.12 : 0.45;
    p.x = p.sx = p.px = src.x + (dx / dist) * Math.min(off, dist * 0.5);
    p.y = p.sy = p.py = src.y + (dy / dist) * Math.min(off, dist * 0.5);
  }
  p.hp = p.maxHp = Math.max(1, weapon.interceptHp ?? 1);
  if (!spec.guided) {
    p.T = Math.max(2, Math.round(spec.time(dist) * (weapon.flightTime ?? 1) * TPS));
    p.arc = spec.arc(dist) * (weapon.apogee ?? 1);
    // released in level flight: z = sz - (sz - tz) k^2, a true free-fall curve (chord + 4k(1-k) lift)
    if (flight === 'bomb') {
      p.z = p.sz = p.pz = p.z - 0.2; // off the belly pylon
      p.arc = (p.z - p.tz) / 4;
    }
    if (flight === 'cruise') {
      // dog-leg route: the ground track bows out to one side (alternating per round) around a waypoint
      const h = Math.min(5, dist * 0.3) * (p.id % 2 ? 1 : -1);
      const l = Math.max(0.01, dist);
      p.wx = (p.sx + ax) / 2 + (-dy / l) * h;
      p.wy = (p.sy + ay) / 2 + (dx / l) * h;
    }
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
    if (weapon.shoulder) {
      // shoulder launch: ejected along the line of sight, superelevated, then a short kick-up as the motor lights
      dirz = Math.max(0.35, (p.tz - p.z) / h + SHOULDER_LOFT);
      speed = p.maxSpeed * 0.2;
      p.phase = 1;
    } else if (flight === 'sam' || flight === 'interceptor') {
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
    // a missile at an evasive aircraft (stealth.ts): the seeded roll says now whether its flares will fool it
    const ev = evasionChance(w, weapon, t);
    if (ev > 0) p.decoy = w.rng.next() < ev ? 1 : -1;
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
  // low, close threats (cruise missiles): a shallow launch with a short boost (phase 1) instead of a vertical one
  const low = threat.z - groundZ(w, threat.x, threat.y) < 2.2;
  if (low) p.phase = 1;
  const lat = low ? 1 : 0.3;
  const up = low ? 0.6 : 1;
  const n = Math.hypot(lat, up);
  p.speed = p.maxSpeed * 0.3;
  p.vx = ((dx / h) * lat * p.speed) / n;
  p.vy = ((dy / h) * lat * p.speed) / n;
  p.vz = (up * p.speed) / n;
  threat.engaged++;
  w.projectiles.push(p);
  w.events.push({ t: 'launch', id: p.id, flight, weapon: weapon.id, x: p.x, y: p.y, z: p.z, owner: p.owner, sourceId: src.id });
}

// ------------------------------------------------------------------ update

/** Flight progress 0..1 of an analytic / cruise round. */
export function threatProgress(p: Projectile) {
  return Math.min(1, p.age / Math.max(1, p.T));
}

/** Current aim error of a damaged round at progress k (eases from the last hit to the impact). */
function driftAt(p: Projectile, k: number, out: { x: number; y: number }) {
  const f = p.dk >= 1 ? 1 : Math.max(0, Math.min(1, (k - p.dk) / (1 - p.dk)));
  out.x = p.dbx + (p.dox - p.dbx) * f;
  out.y = p.dby + (p.doy - p.dby) * f;
}
const dtmp = { x: 0, y: 0 };

function analyticPos(p: Projectile, k: number, man: number, out: { x: number; y: number; z: number }) {
  let e = k;
  let lift = 4 * k * (1 - k);
  let side = 0;
  if (p.flight === 'ballistic') {
    // slow vertical boost, then fast descent: skew the parabola
    e = k * k * (3 - 2 * k) * 0.35 + k * 0.65;
    lift = Math.sin(Math.PI * Math.pow(k, 0.8));
    if (man > 0 && k > 0.6) {
      // manoeuvring re-entry vehicle (Iskander style): weaving pull-ups in the terminal phase
      const u = (k - 0.6) / 0.4;
      side = man * Math.sin(u * TAU * 1.5) * (1 - u);
    }
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
  if (p.hits) {
    driftAt(p, k, dtmp);
    out.x += dtmp.x;
    out.y += dtmp.y;
  }
}

/** Cruise missile: curved ground track at constant pace, terrain following, pop-up and terminal dive. */
function stepCruise(w: World, p: Projectile) {
  const k = threatProgress(p);
  const u = 1 - k;
  let x = u * u * p.sx + 2 * k * u * p.wx + k * k * p.tx;
  let y = u * u * p.sy + 2 * k * u * p.wy + k * k * p.ty;
  if (p.hits) {
    driftAt(p, k, dtmp);
    x += dtmp.x;
    y += dtmp.y;
  }
  // heading along the track, for the terrain look-ahead
  let hx = 2 * u * (p.wx - p.sx) + 2 * k * (p.tx - p.wx);
  let hy = 2 * u * (p.wy - p.sy) + 2 * k * (p.ty - p.wy);
  const hl = Math.hypot(hx, hy) || 1;
  hx /= hl;
  hy /= hl;
  const g = Math.max(groundZ(w, x, y), groundZ(w, x + hx * 0.5, y + hy * 0.5), groundZ(w, x + hx * 1.0, y + hy * 1.0));
  const cruiseZ = g + CRUISE_ALT;
  const rem = u * Math.hypot(p.tx - p.sx, p.ty - p.sy) * 1.1;
  let z: number;
  if (p.age <= CRUISE_BOOST_TICKS) {
    // booster: up out of the canister, then the turbofan takes over
    z = p.sz + (cruiseZ + 0.8 - p.sz) * Math.sin(((p.age / CRUISE_BOOST_TICKS) * Math.PI) / 2);
  } else if (rem > CRUISE_POPUP) {
    // hug the ground: climb at once over rising terrain, sink back gently
    z = Math.max(cruiseZ, p.pz - 0.05);
  } else if (rem > CRUISE_DIVE) {
    // pop-up to acquire the target
    const want = cruiseZ + 1.1 * Math.sin((((CRUISE_POPUP - rem) / (CRUISE_POPUP - CRUISE_DIVE)) * Math.PI) / 2);
    z = Math.max(want, p.pz - 0.05);
  } else {
    if (p.phase < 2) {
      p.phase = 2;
      p.arc = p.pz; // dive entry height
    }
    z = p.tz + (p.arc - p.tz) * Math.sin(((rem / CRUISE_DIVE) * Math.PI) / 2);
  }
  p.x = x;
  p.y = y;
  p.z = k >= 1 ? p.tz : z;
  p.vx = (p.x - p.px) * TPS;
  p.vy = (p.y - p.py) * TPS;
  p.vz = (p.z - p.pz) * TPS;
  if (k >= 1) detonate(w, p, true);
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
    if (p.flight === 'cruise') {
      stepCruise(w, p);
      continue;
    }
    if (!spec.guided) {
      const k = Math.min(1, p.age / p.T);
      analyticPos(p, k, p.flight === 'ballistic' ? (WEAPONS[p.weapon]?.maneuver ?? 0) : 0, tmp);
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
  // recount interceptors in flight per threat, so a lost or expired interceptor never blocks re-engagement
  for (const p of w.projectiles) p.engaged = 0;
  for (const p of w.projectiles) {
    if (p.targetProj < 0) continue;
    const t = byId.get(p.targetProj);
    if (t && !t.dead) t.engaged++;
  }
}

/** How many interceptors may be in the air against one threat at once: one per hit still needed (+1 spare vs missiles). */
export function maxEngage(p: Projectile) {
  return p.hp + (p.flight === 'ballistic' || p.flight === 'hypersonic' ? 1 : 0);
}

/** An interceptor whose target is gone looks for another threat close by instead of wasting itself. */
function retarget(w: World, p: Projectile): Projectile | null {
  const kinds = WEAPONS[p.weapon]?.intercept?.kinds;
  if (!kinds) return null;
  let best: Projectile | null = null;
  let bd = 4;
  for (const q of w.projectiles) {
    if (q.dead || q === p || !w.isEnemy(p.owner, q.owner) || !kinds.includes(q.flight) || q.engaged >= maxEngage(q)) continue;
    const d = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  return best;
}

function stepGuided(w: World, p: Projectile, spec: FlightSpec, byId: Map<number, Projectile>) {
  // ----- where are we going?
  let ax: number;
  let ay: number;
  let az: number;
  let tvx = 0;
  let tvy = 0;
  let tvz = 0;
  if (p.decoy === 2) {
    // fooled (stealth.ts): chase the decoy flare, give up once it burns out
    if (!stepDecoy(p, groundZ(w, p.dcx, p.dcy))) {
      airburst(w, p, 'expire');
      return;
    }
    ax = p.dcx;
    ay = p.dcy;
    az = p.dcz;
    tvx = p.dcvx;
    tvy = p.dcvy;
    tvz = p.dcvz;
  } else if (p.targetProj >= 0) {
    let t = byId.get(p.targetProj);
    if (!t || t.dead) {
      const nt = retarget(w, p);
      if (!nt) {
        airburst(w, p, 'expire');
        return;
      }
      t = nt;
      p.targetProj = nt.id;
      nt.engaged++;
      byId.set(nt.id, nt);
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
      // the jet's flare fools it: from here on it homes on the flare (stealth.ts)
      // (point-blank once it is homing: at once, so a fooled missile can never reach the jet)
      const rj = p.decoy === 1 ? Math.hypot(ax - p.x, ay - p.y, az - p.z) : Infinity;
      const boost = (p.flight === 'sam' || p.flight === 'interceptor') && p.age < (p.phase === 1 ? 2 : 6);
      if (p.decoy === 1 && (p.age >= DECOY_AGE || (rj < 2.5 && !boost)) && t.kind === 'unit' && w.isAir(t) && rj < DECOY_RANGE) {
        releaseDecoy(w, p, t, az);
        ax = p.dcx;
        ay = p.dcy;
        az = p.dcz;
        tvx = p.dcvx;
        tvy = p.dcvy;
        tvz = p.dcvz;
      }
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
  if ((p.flight === 'sam' || p.flight === 'interceptor') && p.age < (p.phase === 1 ? 2 : 6)) {
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
  const hit = (spec.hit ?? 0.4) * (p.decoy === 2 ? 1.5 : 1); // a blazing flare sets the proximity fuze off a little further out
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
    if (p.decoy === 2) {
      decoyBurst(w, p);
      return;
    } else if (p.targetProj >= 0) interceptResolve(w, p, byId.get(p.targetProj)!);
    else detonate(w, p, true);
    return;
  }
  if (p.decoy === 2) {
    // proximity fuze on the flare: past the closest approach, close enough -> burst
    const r = Math.hypot(ax - p.x, ay - p.y, az - p.z);
    if (r > p.dcr && p.dcr < 1.4) {
      decoyBurst(w, p);
      return;
    }
    p.dcr = r;
  }
  // guided missiles fly nap-of-the-earth: never dip below the terrain while still away from the target
  const gnd = groundZ(w, p.x, p.y);
  if (Math.hypot(ax - p.x, ay - p.y) > 0.7 && p.z < gnd + 0.25 && (p.targetProj < 0 || p.age > 3)) {
    p.z = gnd + 0.25;
    if (p.vz < 0) p.vz = 0;
  }
  if (p.z <= gnd - 0.02) {
    p.z = groundZ(w, p.x, p.y);
    if (p.decoy === 2) {
      airburst(w, p, 'expire');
      return;
    }
    detonate(w, p, false);
    return;
  }
  if (p.age > (spec.life ?? 6) * TPS || p.x < -2 || p.y < -2 || p.x > w.map.w + 2 || p.y > w.map.h + 2) airburst(w, p, 'expire');
}

/** A fooled missile bursts on the decoy flare (stealth.ts): no harm to the jet. */
function decoyBurst(w: World, p: Projectile) {
  p.dead = true;
  w.events.push({ t: 'airburst', x: p.x, y: p.y, z: p.z, kind: 'miss', weapon: p.weapon, decoy: true });
}

function airburst(w: World, p: Projectile, kind: 'kill' | 'miss' | 'expire', victim?: Projectile) {
  p.dead = true;
  w.events.push({ t: 'airburst', x: p.x, y: p.y, z: p.z, kind, weapon: p.weapon, victim: victim?.flight });
}

/** Probability that one engagement by an air-defence weapon hits this threat. */
export function interceptPk(wpn: WeaponDef, threat: Projectile): number {
  const ic = wpn.intercept;
  if (!ic) return 0.7;
  let pk = ic.pkBy?.[threat.flight] ?? (threat.flight === 'hypersonic' ? (ic.pkHypersonic ?? 0.3) : ic.pk);
  // manoeuvring re-entry vehicles are harder to hit once they are past apogee
  if (threat.flight === 'ballistic' && (WEAPONS[threat.weapon]?.maneuver ?? 0) > 0 && threatProgress(threat) > 0.4) pk *= 0.75;
  return pk;
}

/**
 * One successful intercept on a threat at (x, y, z). Removes one point of its interceptHp; at zero the
 * round is destroyed ('kill'), otherwise it flies on damaged with a seeded aim error ('hit').
 * Emits the airburst event; returns true when the threat was destroyed.
 */
export function hitThreat(w: World, threat: Projectile, weaponId: string, x: number, y: number, z: number): boolean {
  threat.hp = Math.max(0, threat.hp - 1);
  const info = { victim: threat.flight, victimId: threat.id, victimWeapon: threat.weapon, hpLeft: threat.hp, maxHp: threat.maxHp };
  if (threat.hp <= 0) {
    threat.dead = true;
    w.events.push({ t: 'airburst', x, y, z, kind: 'kill', weapon: weaponId, ...info });
    return true;
  }
  threat.hits++;
  // knocked off course: the impact point drifts by up to ~1.1 tiles, easing in from now to impact
  const k = threatProgress(threat);
  driftAt(threat, k, dtmp);
  threat.dbx = dtmp.x;
  threat.dby = dtmp.y;
  threat.dk = k;
  const a = w.rng.next() * TAU;
  const r = 0.45 + w.rng.next() * 0.65;
  threat.dox += Math.cos(a) * r;
  threat.doy += Math.sin(a) * r;
  w.events.push({ t: 'airburst', x, y, z, kind: 'hit', weapon: weaponId, ...info });
  return false;
}

function interceptResolve(w: World, p: Projectile, threat: Projectile) {
  if (w.rng.next() < interceptPk(WEAPONS[p.weapon], threat)) {
    p.dead = true;
    hitThreat(w, threat, p.weapon, p.x, p.y, p.z);
  } else airburst(w, p, 'miss');
}

/** Warhead functions: direct hit + splash, active protection. */
function detonate(w: World, p: Projectile, onTarget: boolean) {
  p.dead = true;
  const wpn = WEAPONS[p.weapon];
  const src = w.get(p.sourceId) ?? ({ id: p.sourceId, owner: p.owner } as Entity);
  const t = w.get(p.targetId);
  // an intercepted-but-surviving missile arrives with a damaged warhead
  const dmgMul = p.hits ? Math.max(0.5, 1 - 0.15 * p.hits) : 1;
  // artillery shells, missiles and bombs this heavy leave nobody wounded (medic.ts)
  const big = bigBlast(wpn);
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
    if (near && (!w.isAir(t) || wpn.air !== 'no')) {
      // small warheads against fast jets (MANPADS: WeaponDef.vsFixedWing)
      const jet = wpn.vsFixedWing !== undefined && t.kind === 'unit' && !!unitDef(t.def).fixedWing && w.isAir(t);
      w.damage(t, wpn.damage * dmgMul * (jet ? wpn.vsFixedWing! : 1), wpn.warhead, src, false, big);
      direct = true;
    }
  }
  if (wpn.splash) w.splash(p.x, p.y, wpn.splash, wpn.damage * 0.7 * dmgMul, wpn.warhead, src, direct ? (t?.id ?? -1) : -1, big);
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
  const radar = e.owner >= 0 && w.players[e.owner].radarOnline;
  const ez = entityZ(w, e);
  let best: Projectile | null = null;
  let bestScore = Infinity;
  for (const p of w.projectiles) {
    if (p.dead || !w.isEnemy(e.owner, p.owner) || !ic.kinds.includes(p.flight)) continue;
    // keep engaging a damaged threat, but never put more interceptors in the air than hits still needed (+1 spare)
    if (p.engaged >= maxEngage(p)) continue;
    const d = Math.hypot(p.x - e.x, p.y - e.y);
    if (d > detectionRange(range, WEAPONS[p.weapon], radar)) continue;
    // above the engagement ceiling (the layered interceptor's, if it would fire one): wait for the terminal dive
    const lw = ic.layer && ic.layer.kinds.includes(p.flight) ? WEAPONS[ic.layer.weapon] : wpn;
    if (p.z - ez > (lw.intercept?.ceiling ?? ic.ceiling ?? 9)) continue;
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
    e.flashAt = w.tick; // the shot gives the launcher away by night (night.ts)
    w.events.push({ t: 'fire', id: e.id, weapon: wpn.id, x: e.x, y: e.y, tx: best.x, ty: best.y, targetId: -1, owner: e.owner });
    if (w.rng.next() < interceptPk(wpn, best)) hitThreat(w, best, wpn.id, best.x, best.y, best.z);
    return true;
  }
  // layered defence: a heavier interceptor (own weapon def / pk / munition) for some threat kinds
  const layer = ic.layer && ic.layer.kinds.includes(best.flight) ? WEAPONS[ic.layer.weapon] : undefined;
  const iw = layer ?? wpn;
  launchInterceptor(w, e, best, iw);
  // shoot-shoot doctrine: ballistic, hypersonic and multi-hit threats get a pair, within the engagement cap
  if ((best.flight === 'ballistic' || best.flight === 'hypersonic' || best.hp >= 2) && best.engaged < maxEngage(best)) launchInterceptor(w, e, best, iw);
  e.flashAt = w.tick; // the launch gives the battery away by night (night.ts)
  w.events.push({ t: 'fire', id: e.id, weapon: wpn.id, x: e.x, y: e.y, tx: best.x, ty: best.y, targetId: -1, owner: e.owner });
  return true;
}

export function isInterceptable(f: Flight) {
  return INTERCEPTABLE.includes(f);
}

/**
 * Range at which a defence with weapon range `range` detects a threat fired by `threatWpn`: low-observable
 * cruise missiles are only seen at a fraction of it (+15% of the range while a Radar Center is online).
 */
export function detectionRange(range: number, threatWpn: WeaponDef | undefined, radar: boolean) {
  const lo = threatWpn?.lowObservable ?? 1;
  if (lo >= 1) return range;
  return range * Math.min(1, lo + (radar ? 0.15 : 0));
}

