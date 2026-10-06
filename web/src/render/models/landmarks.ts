import * as THREE from 'three';

/*
 * Landmark models (render/landmarks): one-off set pieces built from boxes,
 * cylinders and cones into a vertex-coloured kit. Every model is written in
 * local coordinates (origin on the ground at its centre, front facing +X,
 * 1 unit = 1 tile) and appended to a shared Kit under a placement matrix, so
 * a whole map's landmarks merge into one mesh (one draw call).
 *
 * Per vertex `aGlow` codes the night look (see landmarks/index.ts):
 *   0 plain, 1 warm window glow at night, 2 office / tower facade with a
 *   procedural window grid (lit at random at night), 3 always lit (signs,
 *   floodlight heads), 4 red warning paint (brightens a little at night).
 *
 * Scale: the battlefield is drawn at roughly 1 tile = 9 m with vehicles
 * x1.25; a house is 1.45 x 1.05 with 0.6 high walls, the village water tower
 * 1.5 tall. Landmarks follow that and stay a little compressed in height so
 * they never dwarf the units.
 */

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();
const _y = new THREE.Vector3(0, 1, 0);
const _nm = new THREE.Matrix3();

/** Vertex-coloured geometry accumulator with a placement matrix. */
export class Kit {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  glow: number[] = [];
  /** Placement of the model being built (local -> world). */
  readonly base = new THREE.Matrix4();

  get count() {
    return this.pos.length / 3;
  }

  /** Place the next model: origin (x, y, z) in world space, heading yaw (tile-space angle), uniform scale. */
  at(x: number, y: number, z: number, yaw = 0, s = 1): this {
    _q.setFromAxisAngle(_y, -yaw);
    this.base.compose(_p.set(x, y, z), _q, _s.set(s, s, s));
    return this;
  }

  /** Append a geometry (local coordinates, optional extra local transform). */
  add(g: THREE.BufferGeometry, local: THREE.Matrix4 | null, color: number | THREE.Color, glow = 0): this {
    const ng = g.index ? g.toNonIndexed() : g;
    if (!ng.attributes.normal) ng.computeVertexNormals();
    const pa = ng.attributes.position;
    const na = ng.attributes.normal;
    const m = local ? _m.multiplyMatrices(this.base, local) : _m.copy(this.base);
    _nm.getNormalMatrix(m);
    if (typeof color === 'number') _c.setHex(color);
    else _c.copy(color);
    for (let i = 0; i < pa.count; i++) {
      _v.fromBufferAttribute(pa, i).applyMatrix4(m);
      _n.fromBufferAttribute(na, i).applyMatrix3(_nm).normalize();
      this.pos.push(_v.x, _v.y, _v.z);
      this.nor.push(_n.x, _n.y, _n.z);
      this.col.push(_c.r, _c.g, _c.b);
      this.glow.push(glow);
    }
    ng.dispose();
    if (ng !== g) g.dispose();
    return this;
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, col: number | THREE.Color, glow = 0, ry = 0, rx = 0, rz = 0): this {
    const g = new THREE.BoxGeometry(w, h, d);
    return this.add(g, local(x, y, z, ry, rx, rz), col, glow);
  }

  /** Cylinder standing on y (bottom radius r0, top radius r1). */
  cyl(r0: number, r1: number, h: number, x: number, y: number, z: number, col: number | THREE.Color, seg = 10, glow = 0, open = false): this {
    const g = new THREE.CylinderGeometry(r1, r0, h, seg, 1, open);
    return this.add(g, local(x, y + h / 2, z), col, glow);
  }

  cone(r: number, h: number, x: number, y: number, z: number, col: number | THREE.Color, seg = 10, glow = 0): this {
    return this.add(new THREE.ConeGeometry(r, h, seg), local(x, y + h / 2, z), col, glow);
  }

  /** Half sphere dome on y. */
  dome(r: number, x: number, y: number, z: number, col: number | THREE.Color, seg = 14, sy = 1): this {
    const g = new THREE.SphereGeometry(r, seg, Math.max(4, seg >> 1), 0, Math.PI * 2, 0, Math.PI / 2);
    g.scale(1, sy, 1);
    return this.add(g, local(x, y, z), col);
  }

  ball(r: number, x: number, y: number, z: number, col: number | THREE.Color, detail = 1, glow = 0): this {
    return this.add(new THREE.IcosahedronGeometry(r, detail), local(x, y, z), col, glow);
  }

  /** Thin square beam between two local points. */
  beam(ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number, col: number | THREE.Color, glow = 0): this {
    const a = new THREE.Vector3(ax, ay, az);
    const b = new THREE.Vector3(bx, by, bz);
    const len = a.distanceTo(b);
    if (len < 1e-4) return this;
    const g = new THREE.BoxGeometry(t, len, t);
    const q = new THREE.Quaternion().setFromUnitVectors(_y, b.clone().sub(a).normalize());
    const lm = new THREE.Matrix4().compose(a.add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    return this.add(g, lm, col, glow);
  }

  /** Flat quad on the ground plane (local y), w along x, d along z. */
  /** A sloped ring around an ellipse (rx, rz) at local y0, falling outwards by `drop` over `width` (shores, embankments). */
  shore(rx: number, rz: number, y0: number, drop: number, width: number, col: number | THREE.Color, seg = 32): this {
    const pos: number[] = [];
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const P = (a: number, o: number, y: number) => [Math.cos(a) * (rx + o), y, Math.sin(a) * (rz + o)];
      const A = P(a0, -0.04, y0 + 0.01);
      const B = P(a1, -0.04, y0 + 0.01);
      const C = P(a1, width, y0 - drop);
      const D = P(a0, width, y0 - drop);
      pos.push(...A, ...C, ...B, ...A, ...D, ...C);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    // make sure the faces look up
    const n = g.attributes.normal;
    if (n.getY(0) < 0) {
      const p = g.attributes.position.array as Float32Array;
      for (let i = 0; i < p.length; i += 9) for (let j = 0; j < 3; j++) [p[i + 3 + j], p[i + 6 + j]] = [p[i + 6 + j], p[i + 3 + j]];
      g.computeVertexNormals();
    }
    return this.add(g, null, col);
  }

  slab(w: number, d: number, x: number, y: number, z: number, col: number | THREE.Color, ry = 0): this {
    const g = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2);
    return this.add(g, local(x, y, z, ry), col);
  }

  /** Gable roof prism: length lx (along x), depth dz, ridge height rise, on y. */
  gable(lx: number, dz: number, rise: number, x: number, y: number, z: number, col: number | THREE.Color, ry = 0): this {
    const s = new THREE.Shape();
    s.moveTo(-dz / 2, 0);
    s.lineTo(dz / 2, 0);
    s.lineTo(0, rise);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: lx, bevelEnabled: false });
    g.translate(0, 0, -lx / 2).rotateY(Math.PI / 2);
    return this.add(g, local(x, y, z, ry), col);
  }

  /** Four-sided pyramid roof / spire. */
  spire(r: number, h: number, x: number, y: number, z: number, col: number | THREE.Color): this {
    const g = new THREE.ConeGeometry(r * Math.SQRT2, h, 4).rotateY(Math.PI / 4);
    return this.add(g, local(x, y + h / 2, z), col);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.glow, 1));
    g.computeBoundingSphere();
    return g;
  }
}

function local(x: number, y: number, z: number, ry = 0, rx = 0, rz = 0): THREE.Matrix4 {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(1, 1, 1));
}

/** Deterministic 0..1 from integers. */
export function h3(a: number, b: number, c = 0): number {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ------------------------------------------------------------------ palette

export const PAL = {
  stone: 0xa9a196,
  stoneDark: 0x7d766c,
  ruin: 0x8c8478,
  plaster: 0xe4dccb,
  white: 0xf0eee8,
  roofRed: 0x9a4a32,
  roofDark: 0x4a4a50,
  slate: 0x56595e,
  wood: 0x6a4a30,
  steel: 0x8a8e94,
  steelDark: 0x4a4e54,
  concrete: 0xb4b0a8,
  glass: 0x3e5562,
  sand: 0xd8c09a,
  mud: 0xc9a476,
  green: 0x3f6a2c,
  palmLeaf: 0x4a7a28,
  trunk: 0x7a5c3c,
  red: 0xb8282a,
  ice: 0xcfe2ec,
  snow: 0xeef3f8,
};

// ------------------------------------------------------------------ frontline / temperate

/** Wind turbine tower and nacelle (hub at y = HUB, rotor separate: turbineRotor). Facing +X. */
export const TURBINE_HUB = 5.2;
export function turbineTower(k: Kit) {
  k.cyl(0.42, 0.42, 0.12, 0, -0.05, 0, PAL.concrete, 12);
  k.cyl(0.17, 0.09, TURBINE_HUB, 0, 0, 0, 0xeef0f0, 12);
  k.box(0.62, 0.2, 0.2, -0.12, TURBINE_HUB, 0, 0xeef0f0);
  k.box(0.04, 0.04, 0.04, -0.4, TURBINE_HUB + 0.12, 0, 0xd02020, 3);
}

/** Three-blade rotor in the YZ plane, hub at the origin (spins about +X). */
export function turbineRotor(): THREE.BufferGeometry {
  const k = new Kit();
  k.add(new THREE.SphereGeometry(0.12, 10, 6).scale(1.4, 1, 1), local(0.2, 0, 0), 0xeef0f0);
  for (let b = 0; b < 3; b++) {
    const a = (b / 3) * Math.PI * 2;
    // a tapered blade: wide near the root, slim at the tip
    const g = new THREE.BoxGeometry(0.035, 3.1, 0.18, 1, 4, 1);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i) + 1.55;
      p.setZ(i, p.getZ(i) * (1 - (y / 3.1) * 0.7));
      p.setY(i, y + 0.08);
    }
    g.computeVertexNormals();
    k.add(g, local(0.2, 0, 0, 0, a, 0), 0xf2f3f3);
  }
  return k.build();
}

/** Ruined castle keep with curtain walls and a broken tower (about 3 x 2.2). */
export function castleRuin(k: Kit, seed: number) {
  const st = PAL.ruin;
  const dk = PAL.stoneDark;
  const tones = [0x8c8478, 0x978e80, 0x81796d, 0x9e9586, 0x7a7468];
  const tone = (a: number, b: number) => tones[Math.floor(h3(seed, a, b) * tones.length)];
  // foundations reach down into the rock (rough blocks, rock coloured)
  for (let i = 0; i < 6; i++) k.box(0.95 + h3(seed, 60, i) * 0.2, 1.9, 0.75 + h3(seed, 61, i) * 0.2, -1.0 + (i % 3) * 1.0, -1.0, i < 3 ? -0.45 : 0.45, i % 2 ? 0x5e574e : 0x67605a, 0, (h3(seed, 62, i) - 0.5) * 0.2);
  // curtain walls with gaps and ragged tops
  const wall = (x0: number, z0: number, x1: number, z1: number, h: number, salt: number) => {
    const L = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(2, Math.round(L / 0.32));
    const ang = Math.atan2(z1 - z0, x1 - x0);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const r = h3(seed, salt, i);
      if (r < 0.14) continue; // a breach
      const hh = h * (0.45 + 0.55 * h3(seed, salt + 9, i));
      k.box(L / n + 0.01, hh, 0.18, x0 + (x1 - x0) * t, hh / 2, z0 + (z1 - z0) * t, i % 5 === 4 ? dk : tone(salt, i), 0, -ang);
      // crenellations on the tall bits
      if (hh > h * 0.85 && i % 2 === 0) k.box(L / n * 0.5, 0.1, 0.2, x0 + (x1 - x0) * t, hh + 0.05, z0 + (z1 - z0) * t, st, 0, -ang);
    }
  };
  wall(-1.5, -1.05, 1.5, -1.05, 0.75, 1);
  wall(1.5, -1.05, 1.5, 1.05, 0.7, 2);
  wall(1.5, 1.05, -1.5, 1.05, 0.65, 3);
  wall(-1.5, 1.05, -1.5, -1.05, 0.8, 4);
  // the keep: a tall square tower, one corner fallen
  for (let y = 0; y < 5; y++) k.box(1.0 - (y % 2) * 0.02, 0.34, 0.95 - (y % 2) * 0.02, -0.6, 0.17 + y * 0.34, -0.3, tone(70, y));
  k.box(0.5, 0.55, 0.95, -0.85, 1.95, -0.3, tone(71, 0));
  k.box(1.0, 0.3, 0.45, -0.6, 1.85, -0.55, dk);
  for (const [x, z] of [[-1.05, -0.75], [-0.15, -0.75], [-1.05, 0.15]] as const) k.box(0.16, 0.14, 0.16, x, 2.25 - (x > -0.5 ? 0.4 : 0), z, st);
  // dark window slits
  for (const y of [0.7, 1.25]) {
    k.box(0.02, 0.2, 0.06, -0.09, y, -0.3, 0x2a2622);
    k.box(0.06, 0.2, 0.02, -0.6, y, 0.18, 0x2a2622);
  }
  // round corner tower, broken
  k.cyl(0.36, 0.34, 1.25, 1.4, 0, 0.95, st, 12);
  k.cyl(0.36, 0.34, 0.3, 1.4, 1.25, 0.95, dk, 12, 0, true);
  k.cyl(0.32, 0.3, 0.75, 1.4, 0, -0.95, st, 12);
  // rubble, ivy
  for (let i = 0; i < 9; i++) k.ball(0.09 + h3(seed, 30, i) * 0.12, (h3(seed, 31, i) - 0.5) * 2.8, 0.05, (h3(seed, 32, i) - 0.5) * 1.9, i % 2 ? st : dk, 0);
  for (let i = 0; i < 5; i++) k.ball(0.18, -1.52 + (i % 2) * 0.05, 0.3 + h3(seed, 40, i) * 0.4, -0.8 + i * 0.4, 0x3f5a2a, 0);
  // a flag on the keep
  k.beam(-0.85, 2.2, -0.3, -0.85, 2.75, -0.3, 0.025, PAL.steelDark);
  k.box(0.02, 0.18, 0.3, -0.85, 2.64, -0.14, 0xb0302a);
}

/** Village church: nave with a pitched roof, west bell tower with a spire (tower at local -X). */
export const CHURCH_BELL = { x: -1.05, y: 1.95 };
export function church(k: Kit) {
  const wall = PAL.plaster;
  k.box(2.1, 0.75, 1.05, 0.25, 0.375, 0, wall);
  k.gable(2.25, 1.2, 0.55, 0.25, 0.75, 0, PAL.roofRed);
  // apse
  k.cyl(0.42, 0.42, 0.62, 1.3, 0, 0, wall, 12);
  k.cone(0.5, 0.36, 1.3, 0.62, 0, PAL.roofRed, 12);
  // tall arched windows (lit at night)
  for (const s of [-1, 1]) for (let i = 0; i < 4; i++) k.box(0.14, 0.38, 0.02, -0.45 + i * 0.45, 0.42, s * 0.53, 0xffd590, 1);
  // the tower
  k.box(0.72, 2.25, 0.72, -1.05, 1.12, 0, 0xd8d0be);
  k.box(0.76, 0.06, 0.76, -1.05, 1.62, 0, 0xc4bcaa);
  // belfry openings and the clock
  for (const s of [-1, 1]) {
    k.box(0.02, 0.32, 0.2, -1.05 + s * 0.37, 1.95, 0, 0x2a2420);
    k.box(0.2, 0.32, 0.02, -1.05, 1.95, s * 0.37, 0x2a2420);
  }
  k.add(new THREE.CircleGeometry(0.14, 16).rotateY(-Math.PI / 2), local(-1.42, 1.38, 0), 0xf4ecd8, 1);
  k.box(0.02, 0.1, 0.012, -1.43, 1.42, 0, 0x1a1a1a);
  k.spire(0.38, 1.25, -1.05, 2.25, 0, 0x3e5a52);
  k.beam(-1.05, 3.45, 0, -1.05, 3.8, 0, 0.03, 0xc8a040);
  k.box(0.16, 0.03, 0.03, -1.05, 3.7, 0, 0xc8a040);
  // door
  k.box(0.02, 0.4, 0.26, -1.42, 0.2, 0, 0x5a3a22);
}

/** Classic riveted water tower on four legs with a conical tank (taller than the village one). */
export function waterTower(k: Kit) {
  const leg = 0x6e7470;
  const H = 2.6;
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    k.beam(sx * 0.48, 0, sz * 0.48, sx * 0.3, H, sz * 0.3, 0.06, leg);
    k.box(0.16, 0.08, 0.16, sx * 0.48, 0.04, sz * 0.48, PAL.concrete);
  }
  for (const y of [0.7, 1.4, 2.1]) {
    const r = 0.48 - (y / H) * 0.18;
    k.beam(-r, y, -r, r, y, -r, 0.025, leg).beam(r, y, -r, r, y, r, 0.025, leg).beam(r, y, r, -r, y, r, 0.025, leg).beam(-r, y, r, -r, y, -r, 0.025, leg);
  }
  k.cyl(0.08, 0.08, H, 0, 0, 0, leg, 8);
  k.cyl(0.3, 0.62, 0.35, 0, H, 0, 0x8ca0a0, 16);
  k.cyl(0.62, 0.62, 0.65, 0, H + 0.35, 0, 0x9ab0ae, 16);
  k.cone(0.66, 0.35, 0, H + 1.0, 0, 0x6e8482, 16);
  k.ball(0.06, 0, H + 1.37, 0, 0x6e8482, 0);
  // the town's name band
  k.cyl(0.625, 0.625, 0.14, 0, H + 0.6, 0, 0xe8e4dc, 16, 0, true);
}

/** Village house (temperate): walls, gable roof, chimney; ~1.3 x 1.0. */
export function cottage(k: Kit, v: number) {
  const walls = [0xe4dccb, 0xd8c8a8, 0xe8e0d0, 0xc8b8a0][Math.floor(v * 4) % 4];
  const roof = v > 0.5 ? PAL.roofRed : 0x6a3a2a;
  k.box(1.3, 0.55, 0.95, 0, 0.275, 0, walls);
  k.gable(1.4, 1.1, 0.5, 0, 0.55, 0, roof);
  k.box(0.14, 0.35, 0.14, 0.35, 0.85, 0.2, 0x8a7a6a);
  for (const s of [-1, 1]) for (const x of [-0.35, 0.35]) k.box(0.18, 0.16, 0.02, x, 0.34, s * 0.485, 0xffd590, 1);
}

/** Railway station building with a platform canopy (front +X faces the track). */
export function stationHouse(k: Kit) {
  k.box(1.0, 0.7, 2.4, -0.2, 0.35, 0, 0xc8a07a);
  k.gable(2.5, 1.15, 0.45, -0.2, 0.7, 0, PAL.slate, Math.PI / 2);
  for (let i = 0; i < 5; i++) k.box(0.02, 0.3, 0.18, 0.31, 0.38, -0.9 + i * 0.45, i === 2 ? 0x5a3a22 : 0xffd590, i === 2 ? 0 : 1);
  // canopy on posts over the platform
  for (let i = 0; i < 4; i++) k.beam(0.75, 0, -1.05 + i * 0.7, 0.75, 0.62, -1.05 + i * 0.7, 0.04, 0x3a5a3a);
  k.box(0.9, 0.04, 2.6, 0.55, 0.64, 0, 0x3a5a3a);
  // the clock and the name board
  k.box(0.04, 0.16, 0.7, 0.33, 0.6, 0, 0xf4f0e8, 3);
  k.box(0.08, 0.14, 0.14, 0.95, 0.5, 0.9, 0xf4ecd8, 3);
}

/** Station platform: long concrete slab with a yellow edge line, along local z. */
export function platform(k: Kit, len: number) {
  k.box(0.7, 0.18, len, 0, 0.09, 0, PAL.concrete);
  k.box(0.06, 0.005, len, 0.3, 0.183, 0, 0xe8c020);
  for (let i = 0; i < 3; i++) k.box(0.3, 0.12, 0.1, -0.1, 0.24, -len / 3 + i * (len / 3), 0x5a4030);
  for (let i = 0; i < 2; i++) k.beam(-0.2, 0.18, -len / 4 + i * (len / 2), -0.2, 0.75, -len / 4 + i * (len / 2), 0.03, 0x2a2a2a);
}

// ------------------------------------------------------------------ desert

/** Mosque: prayer hall with a big dome, small domes, an arcaded courtyard and a minaret at local (-1.1, -0.9). */
export const MINARET = { x: -1.15, z: -0.95, h: 3.6 };
export function mosque(k: Kit) {
  const w = 0xeee4d0;
  const trim = 0xd2c4a6;
  k.box(2.0, 0.8, 1.7, 0.4, 0.4, 0, w);
  k.box(2.06, 0.08, 1.76, 0.4, 0.82, 0, trim);
  // drum and the big dome
  k.cyl(0.62, 0.62, 0.32, 0.45, 0.82, 0, w, 20);
  k.dome(0.66, 0.45, 1.14, 0, 0x3a8a8a, 22, 1.15);
  k.cone(0.04, 0.3, 0.45, 1.88, 0, 0xd8b440, 6);
  k.ball(0.05, 0.45, 2.22, 0, 0xd8b440, 0);
  // corner domes
  for (const [x, z] of [[1.15, 0.6], [1.15, -0.6], [-0.3, 0.6], [-0.3, -0.6]] as const) {
    k.cyl(0.18, 0.18, 0.1, x, 0.82, z, w, 12);
    k.dome(0.2, x, 0.92, z, 0x3a8a8a, 12);
  }
  // arched windows / doors (lit at night)
  for (let i = 0; i < 4; i++) {
    k.box(0.16, 0.34, 0.02, -0.2 + i * 0.4, 0.38, 0.86, 0xffcf80, 1);
    k.box(0.16, 0.34, 0.02, -0.2 + i * 0.4, 0.38, -0.86, 0xffcf80, 1);
  }
  k.box(0.02, 0.5, 0.42, 1.41, 0.32, 0, 0x6a3a22);
  k.box(0.04, 0.62, 0.6, 1.42, 0.31, 0, trim);
  // courtyard arcade in front (+X)
  for (const s of [-1, 1]) {
    k.box(1.0, 0.45, 0.14, 1.95, 0.225, s * 0.8, w);
    for (let i = 0; i < 4; i++) k.box(0.14, 0.32, 0.02, 1.58 + i * 0.25, 0.16, s * 0.72, 0x6a5a48);
  }
  k.box(0.14, 0.45, 1.74, 2.45, 0.225, 0, w);
  k.slab(1.0, 1.5, 1.95, 0.02, 0, 0xe2d6bc);
  k.cyl(0.14, 0.14, 0.12, 1.95, 0, 0, 0x3a8aa0, 10);
  // minaret: tall slender tower with two balconies and a cap
  const { x, z, h } = MINARET;
  k.cyl(0.22, 0.2, 0.9, x, 0, z, w, 8);
  k.cyl(0.17, 0.15, h - 0.9, x, 0.9, z, w, 10);
  for (const y of [1.9, 2.9]) {
    k.cyl(0.24, 0.24, 0.06, x, y, z, trim, 12);
    k.cyl(0.24, 0.24, 0.1, x, y + 0.06, z, 0xefe6d4, 12, 0, true);
  }
  k.cyl(0.13, 0.13, 0.3, x, h, z, w, 10);
  k.cone(0.16, 0.45, x, h + 0.3, z, 0x3a8a8a, 10);
  k.ball(0.035, x, h + 0.8, z, 0xd8b440, 0);
  for (const y of [2.1, 3.1]) k.box(0.02, 0.12, 0.08, x + 0.16, y, z, 0xfff0c0, 3);
}

/** A market stall with a coloured awning (front +X), ~0.6 x 0.5. */
export function soukStall(k: Kit, v: number) {
  const cols = [0xc0392b, 0x2e86c1, 0xd68910, 0x7d3c98, 0x1e8449, 0xe6b0aa];
  const c = cols[Math.floor(v * cols.length) % cols.length];
  // the booth: each one its own size and plaster
  const bw = 0.42 + ((v * 13.7) % 1) * 0.22;
  const bh = 0.34 + ((v * 7.3) % 1) * 0.18;
  const walls = [0xd7bf96, 0xc9a97c, 0xe0cfae, 0xb89a72];
  k.box(0.55, bh, bw, -0.15, bh / 2, 0, walls[Math.floor(v * 29) % walls.length]);
  k.box(0.02, bh * 0.66, bw * 0.72, 0.13, bh * 0.48, 0, 0x3a2a1a);
  // the awning: a sloped striped canvas on poles
  for (let i = 0; i < 3; i++) k.box(0.36, 0.015, 0.17, 0.3, 0.43 - 0.05, -0.17 + i * 0.17, i % 2 ? c : 0xf2ead8, 0, 0, 0, -0.32);
  for (const s of [-1, 1]) k.beam(0.46, 0, s * 0.24, 0.46, 0.33, s * 0.24, 0.015, 0x5a4030);
  // goods: crates, sacks, rugs
  k.box(0.14, 0.08, 0.36, 0.28, 0.04, 0, 0x8a5a2a);
  for (let i = 0; i < 3; i++) k.ball(0.04, 0.27, 0.11, -0.12 + i * 0.12, [0xd04020, 0xe0a020, 0x60a030][(i + Math.floor(v * 7)) % 3], 0);
  k.box(0.02, 0.22, 0.3, 0.14, 0.32, 0, cols[(Math.floor(v * 11) + 2) % cols.length]);
}

/** Flat-roofed mud house (desert), ~1.1 x 0.9. */
export function mudHouse(k: Kit, v: number) {
  const c = v > 0.5 ? PAL.mud : 0xd4b48a;
  const h = 0.5 + v * 0.3;
  k.box(1.1, h, 0.9, 0, h / 2, 0, c);
  k.box(1.14, 0.06, 0.94, 0, h + 0.03, 0, 0xbfa070);
  if (v > 0.3) k.box(0.5, 0.3, 0.5, -0.2, h + 0.15, -0.1, c);
  k.box(0.02, 0.3, 0.2, 0.56, 0.15, 0, 0x5a3a22);
  k.box(0.02, 0.12, 0.14, 0.56, h * 0.7, 0.28, 0xffcf80, 1);
}

/** Date palm (desert grove), ~1.4 tall. */
export function datePalm(k: Kit, v: number, s = 1) {
  let x = 0;
  let y = 0;
  const lean = (v - 0.5) * 0.06;
  for (let i = 0; i < 6; i++) {
    k.cyl(0.07 * s, 0.06 * s, 0.25 * s, x, y, 0, i % 2 ? PAL.trunk : 0x6a4c30, 6);
    x += lean * s + 0.01;
    y += 0.24 * s;
  }
  for (let f = 0; f < 8; f++) {
    const a = (f / 8) * Math.PI * 2 + v * 3;
    for (let sg = 0; sg < 3; sg++) {
      const L = 0.26 * s;
      const g = new THREE.BoxGeometry(L, 0.01, (0.12 - sg * 0.03) * s);
      g.translate(L / 2, 0, 0).rotateZ(-0.15 - sg * 0.38).translate(sg * L * 0.92, -sg * sg * 0.035 * s, 0).rotateY(a).translate(x, y, 0);
      k.add(g, null, sg === 2 ? 0x5e8a2a : PAL.palmLeaf);
    }
  }
  k.ball(0.07 * s, x, y - 0.04, 0, 0x8a5a20, 0);
}

/** Ruined desert fort (mud brick): square walls with round corner towers, ~3.4 x 2.4. */
export function fortRuin(k: Kit, seed: number) {
  const c = 0xb89466;
  const dk = 0x8e7048;
  k.box(3.6, 0.6, 2.6, 0, -0.32, 0, dk);
  const wall = (x0: number, z0: number, x1: number, z1: number, h: number, salt: number) => {
    const L = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(2, Math.round(L / 0.3));
    const ang = Math.atan2(z1 - z0, x1 - x0);
    for (let i = 0; i < n; i++) {
      if (h3(seed, salt, i) < 0.18) continue;
      const t = (i + 0.5) / n;
      const hh = h * (0.4 + 0.6 * h3(seed, salt + 5, i));
      k.box(L / n + 0.01, hh, 0.22, x0 + (x1 - x0) * t, hh / 2, z0 + (z1 - z0) * t, i % 4 ? [0xb89466, 0xae8a5c, 0xc29e70, 0xa88456][Math.floor(h3(seed, salt + 30, i) * 4)] : dk, 0, -ang);
      if (hh > h * 0.8) for (let m = 0; m < 2; m++) k.box(0.07, 0.1, 0.24, x0 + (x1 - x0) * (t - 0.25 / n + m * 0.5 / n), hh + 0.05, z0 + (z1 - z0) * (t - 0.25 / n + m * 0.5 / n), c, 0, -ang);
    }
  };
  wall(-1.6, -1.1, 1.6, -1.1, 0.8, 1);
  wall(1.6, -1.1, 1.6, 1.1, 0.75, 2);
  wall(1.6, 1.1, -1.6, 1.1, 0.7, 3);
  wall(-1.6, 1.1, -1.6, -1.1, 0.85, 4);
  for (const [x, z, h] of [[-1.6, -1.1, 1.3], [1.6, -1.1, 0.9], [1.6, 1.1, 1.15], [-1.6, 1.1, 0.6]] as const) {
    k.cyl(0.36, 0.3, h, x, 0, z, c, 10);
    if (h > 1) k.cyl(0.33, 0.33, 0.12, x, h, z, dk, 10, 0, true);
  }
  // the gate and an inner tower
  k.box(0.3, 1.0, 0.5, 1.6, 0.5, 0, dk);
  k.box(0.32, 0.5, 0.3, 1.6, 0.25, 0, 0x2a2018);
  k.box(0.8, 1.2, 0.8, -0.6, 0.6, 0.2, c);
  k.box(0.02, 0.18, 0.08, -0.19, 0.9, 0.2, 0x2a2018);
  for (let i = 0; i < 10; i++) k.ball(0.08 + h3(seed, 20, i) * 0.12, (h3(seed, 21, i) - 0.5) * 3, 0.04, (h3(seed, 22, i) - 0.5) * 2, i % 2 ? c : dk, 0);
}

/** Refinery: distillation columns, cracking tower, tank farm, pipe racks (~10 x 6). Flare stack at FLARE. */
export const FLARE = { x: 4.2, z: -2.2, h: 6.2 };
export function refinery(k: Kit) {
  const st = 0xb8bcc0;
  const dk = 0x5a5e64;
  k.slab(11, 7, 0, 0.02, 0, 0x6a665e);
  // columns (lit platforms at night)
  for (const [x, z, r, h] of [[-2.5, -1.2, 0.32, 5.2], [-1.6, -1.4, 0.25, 4.4], [-0.8, -1.0, 0.36, 5.8], [0.3, -1.6, 0.22, 3.6]] as const) {
    k.cyl(r, r * 0.9, h, x, 0, z, st, 12);
    for (let y = 1; y < h; y += 1.1) k.cyl(r + 0.08, r + 0.08, 0.04, x, y, z, dk, 12, 1, true);
    k.cone(r * 0.9, 0.3, x, h, z, st, 12);
  }
  // cracking unit: a boxy structure with scaffolding
  k.box(1.6, 3.0, 1.2, 1.5, 1.5, 0.2, 0x9a9890);
  for (let y = 0.6; y < 3; y += 0.6) k.box(1.7, 0.05, 1.3, 1.5, y, 0.2, dk, 1);
  k.box(0.5, 1.0, 0.5, 1.2, 3.5, 0.2, 0x9a9890);
  k.cyl(0.12, 0.1, 1.6, 2.1, 3.0, -0.1, dk, 8);
  // tank farm (white, low)
  for (let i = 0; i < 6; i++) {
    const x = -4.2 + (i % 3) * 1.45;
    const z = 1.4 + Math.floor(i / 3) * 1.45;
    k.cyl(0.62, 0.62, 0.7, x, 0, z, 0xe8e8e4, 18);
    k.cyl(0.64, 0.64, 0.04, x, 0.7, z, 0xc8c8c0, 18);
  }
  // pipe racks
  for (let i = 0; i < 6; i++) k.box(0.06, 0.6, 1.0, -3 + i * 1.1, 0.3, -0.2, dk);
  for (const y of [0.55, 0.62]) k.box(6.4, 0.05, 0.05, -0.3, y, -0.2, 0x8a6a40);
  // spherical gas tanks
  for (const x of [3.3, 4.3]) {
    k.ball(0.5, x, 0.85, 1.6, 0xe0e0dc, 2);
    for (const s of [-1, 1]) k.beam(x + s * 0.35, 0, 1.6, x + s * 0.3, 0.6, 1.6, 0.05, dk);
  }
  // the flare stack: tall thin lattice with a red-white top
  const { x, z, h } = FLARE;
  k.cyl(0.14, 0.09, h, x, 0, z, 0xd8d8d8, 8);
  for (let y = 0.8; y < h; y += 1.2) k.cyl(0.13, 0.13, 0.3, x, y, z, PAL.red, 8, 4);
  for (const [sx, sz] of [[-1, 0], [1, 0], [0, 1], [0, -1]] as const) k.beam(x + sx * 0.8, 0, z + sz * 0.8, x + sx * 0.08, h * 0.6, z + sz * 0.08, 0.02, dk);
}

// ------------------------------------------------------------------ winter

/** Guyed lattice radio / TV mast, height MAST_H (warning lights every ~1.8). */
export const MAST_H = 7.4;
export function radioMast(k: Kit, anchorY: (ax: number, az: number) => number = () => 0) {
  const H = MAST_H;
  k.box(0.6, 0.12, 0.6, 0, 0.06, 0, PAL.concrete);
  const r = 0.13;
  const n = 30;
  for (const [sx, sz] of [[-1, -1], [1, -1], [0, 1.2]] as const) k.beam(sx * r, 0, sz * r * 0.8, sx * r * 0.6, H, sz * r * 0.5, 0.025, PAL.red, 4);
  for (let i = 0; i < n; i++) {
    const y0 = (i / n) * H;
    const y1 = ((i + 1) / n) * H;
    const col = Math.floor(i / 5) % 2 ? PAL.red : 0xf0f0f0;
    k.beam(-r, y0, -r * 0.8, r, y1, -r * 0.8, 0.012, col, col === PAL.red ? 4 : 0);
    k.beam(r, y0, -r * 0.8, 0, y1, r, 0.012, col, col === PAL.red ? 4 : 0);
  }
  // antenna panels and the top whip
  for (let a = 0; a < 3; a++) k.box(0.05, 0.5, 0.18, Math.cos(a * 2.1) * 0.18, H * 0.82, Math.sin(a * 2.1) * 0.18, 0xe0e0e0, 0, -a * 2.1);
  k.beam(0, H, 0, 0, H + 0.9, 0, 0.03, 0xe0e0e0);
  // guy wires to three anchors
  for (let a = 0; a < 3; a++) {
    const ax = Math.cos(a * 2.094 + 0.5) * 2.4;
    const az = Math.sin(a * 2.094 + 0.5) * 2.4;
    const ay = anchorY(ax, az);
    for (const y of [H * 0.4, H * 0.75]) k.beam(ax, ay + 0.05, az, 0, y, 0, 0.008, 0x303030);
    k.box(0.16, 0.3, 0.16, ax, ay - 0.05, az, PAL.concrete);
  }
  // equipment hut
  k.box(0.6, 0.35, 0.45, 0.6, 0.175, -0.4, 0x8a8e8a);
}

/** Factory: long brick hall with a saw-tooth roof, offices, two tall chimneys at CHIMNEYS. */
export const CHIMNEYS = [
  { x: -1.2, z: -1.2, h: 5.4 },
  { x: 0.2, z: -1.3, h: 4.6 },
];
export function factory(k: Kit) {
  const brick = 0x8a4a38;
  const dk = 0x5a3428;
  k.box(4.4, 1.0, 2.0, 0, 0.5, 0.2, brick);
  for (let i = 0; i < 6; i++) {
    const x = -1.85 + i * 0.74;
    k.add(new THREE.BoxGeometry(0.72, 0.42, 2.0).translate(0, 0.21, 0), local(x, 1.0, 0.2, 0, 0, -0.45), 0x5a5e66);
    k.box(0.04, 0.38, 1.9, x + 0.33, 1.2, 0.2, 0xb8d0e0, 1);
  }
  for (let i = 0; i < 8; i++) k.box(0.22, 0.32, 0.02, -1.9 + i * 0.54, 0.55, 1.21, 0xffd590, 1);
  // office block and the gate
  k.box(1.2, 1.4, 0.9, 2.9, 0.7, 0.6, 0xa89a88);
  for (let y = 0; y < 3; y++) for (let i = 0; i < 3; i++) k.box(0.22, 0.18, 0.02, 2.55 + i * 0.35, 0.3 + y * 0.42, 1.06, 0xffd590, 1);
  // chimneys (brick, tapered, a dark band at the top)
  for (const c of CHIMNEYS) {
    k.cyl(0.3, 0.18, c.h, c.x, 0, c.z, brick, 12);
    k.cyl(0.2, 0.2, 0.25, c.x, c.h - 0.25, c.z, dk, 12);
    k.box(0.02, 0.06, 0.02, c.x + 0.2, c.h - 0.1, c.z, PAL.red, 3);
  }
  // water tank, a crane and coal heaps
  k.cyl(0.4, 0.4, 0.7, -2.6, 0, -0.9, 0x6a6e70, 12);
  for (let i = 0; i < 3; i++) k.cone(0.45, 0.3, -2.3 + i * 0.7, 0, 1.8, 0x1e1e20, 8);
  k.box(5.4, 0.28, 0.05, 0.3, 0.14, 2.2, 0x6a6a6a);
}

/** Frozen lake: an icy disc with cracks (local radius 1), drawn at the given scale. */
export function frozenLake(k: Kit, rx: number, rz: number) {
  const g = new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    const a = Math.atan2(z, x);
    const w = 1 + Math.sin(a * 3) * 0.08 + Math.sin(a * 5 + 1) * 0.05;
    p.setXYZ(i, x * rx * w, 0, z * rz * w);
  }
  g.computeVertexNormals();
  k.add(g, null, 0x86a8bc);
  // snow drifts on the ice, a ring of snow on the shore
  for (let i = 0; i < 7; i++) {
    const a = i * 0.9;
    k.slab(0.8 + (i % 3) * 0.4, 0.3, Math.cos(a) * rx * 0.5, 0.008, Math.sin(a) * rz * 0.5, i % 2 ? 0xdde6ee : 0x6f90a4, a);
  }
  // fishing holes
  for (let i = 0; i < 4; i++) k.add(new THREE.CircleGeometry(0.07, 10).rotateX(-Math.PI / 2), local(0.6 + i * 0.35, 0.012, -0.3 + (i % 2) * 0.4), 0x1a2a34);
}

/** Ice-fishing hut on runners (~0.5 x 0.4) with a stove pipe. */
export function iceHut(k: Kit) {
  k.box(0.5, 0.36, 0.4, 0, 0.2, 0, 0xa8402a);
  k.gable(0.56, 0.48, 0.16, 0, 0.38, 0, 0x3a3a3a);
  k.box(0.02, 0.24, 0.14, 0.26, 0.17, 0, 0x5a3a22);
  k.box(0.6, 0.03, 0.04, 0, 0.015, 0.16, 0x4a3a2a);
  k.box(0.6, 0.03, 0.04, 0, 0.015, -0.16, 0x4a3a2a);
  k.cyl(0.025, 0.025, 0.25, -0.12, 0.48, 0.08, 0x3a3a3a, 6);
  k.box(0.02, 0.08, 0.1, 0.0, 0.25, 0.205, 0xffd590, 1);
  // a sled and a tiny figure on a stool
  k.box(0.3, 0.03, 0.14, 0.55, 0.03, 0.2, 0x8a6a40);
  k.box(0.07, 0.1, 0.06, 0.62, 0.12, -0.25, 0x2a3a6a);
  k.ball(0.035, 0.62, 0.2, -0.25, 0xd8a888, 0);
}

/** Ski lift terminal (valley or mountain): bullwheel shelter (~0.9 x 0.7). */
export function liftStation(k: Kit, top: boolean) {
  k.box(0.9, 0.45, 0.8, 0, 0.225, 0, top ? 0x8a6a4a : 0x9a7a5a);
  k.gable(1.0, 0.9, 0.3, 0, 0.45, 0, 0x4a4a52);
  k.box(0.7, 0.3, 0.06, 0.55, 0.6, 0, 0xd02a2a);
  k.cyl(0.32, 0.32, 0.04, 0.55, 0.55, 0, 0x3a3a3a, 14, 0, true);
  k.box(0.02, 0.18, 0.2, 0.46, 0.2, 0.2, 0xffd590, 1);
}

/** Lift pylon (height h), crossarm along z carrying the two cables at ±LIFT_GAUGE. */
export const LIFT_GAUGE = 0.32;
export function liftPylon(k: Kit, h: number) {
  k.box(0.18, 0.06, 0.18, 0, 0.03, 0, PAL.concrete);
  k.cyl(0.06, 0.05, h, 0, 0, 0, 0x6a7078, 8);
  k.box(0.08, 0.06, LIFT_GAUGE * 2 + 0.16, 0, h, 0, 0x6a7078);
  for (const s of [-1, 1]) k.box(0.12, 0.04, 0.06, 0, h - 0.04, s * LIFT_GAUGE, 0x2a2a2a);
}

/** Gondola cabin hanging from its hanger (origin at the cable grip). */
export function gondola(): THREE.BufferGeometry {
  const k = new Kit();
  k.box(0.02, 0.32, 0.02, 0, -0.16, 0, 0x3a3a3a);
  k.box(0.2, 0.18, 0.16, 0, -0.42, 0, 0xd02a2a);
  k.box(0.205, 0.07, 0.165, 0, -0.38, 0, 0x9ab8cc);
  k.box(0.22, 0.03, 0.18, 0, -0.32, 0, 0x5a5a5a);
  return k.build();
}

/** A snowy mountain with ski runs down the face towards +Z (radius r, height h), smooth shaded, at the origin. */
export function skiMountain(k: Kit, r: number, h: number, seed: number) {
  const seg = 56;
  const rings = 16;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  for (let ri = 0; ri <= rings; ri++)
    for (let si = 0; si < seg; si++) {
      const t = ri / rings;
      const a = (si / seg) * Math.PI * 2;
      // a lumpy massif: two summits, ridges, a skirt below the ground at the rim
      const lump = 1 + (h3(seed, ri, si) - 0.5) * 0.08 * t + Math.sin(a * 3 + 1) * 0.06 * t;
      const rr = r * t * lump;
      const shoulder = Math.pow(Math.cos(t * Math.PI * 0.5), 1.5);
      const ridge = 1 + 0.12 * Math.cos(a * 2 - 0.6) * (1 - t);
      const y = ri === rings ? -0.6 : h * shoulder * ridge;
      pos.push(Math.cos(a) * rr, y, Math.sin(a) * rr);
      // runs: bands down the side facing +Z; dark forest on the lower slopes elsewhere; rock bands
      const face = Math.sin(a);
      const run = face > 0.55 && Math.abs(Math.sin(a * 5 + 0.3)) < 0.35 && t > 0.08;
      const forest = !run && t > 0.55 && h3(seed, ri + 40, si) < 0.75;
      const rock = !run && t > 0.12 && t < 0.5 && h3(seed, ri + 80, si) < 0.18;
      const c = run ? [0.98, 0.99, 1] : forest ? [0.14, 0.2, 0.17] : rock ? [0.36, 0.36, 0.38] : [0.84, 0.88, 0.93];
      col.push(...c);
    }
  for (let ri = 0; ri < rings; ri++)
    for (let si = 0; si < seg; si++) {
      const a = ri * seg + si;
      const b = ri * seg + ((si + 1) % seg);
      const c = (ri + 1) * seg + si;
      const d = (ri + 1) * seg + ((si + 1) % seg);
      idx.push(a, c, b, b, c, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const ng = g.toNonIndexed();
  const start = k.count;
  k.add(ng.clone(), null, 0xffffff);
  const cc = ng.attributes.color.array as Float32Array;
  for (let i = 0; i < cc.length; i++) k.col[start * 3 + i] = cc[i];
}

// ------------------------------------------------------------------ urban

/** Stadium: an oval bowl with stands, roof edge, pitch, four floodlight masts at STADIUM_LIGHTS (local). */
export const STADIUM_LIGHTS = [
  { x: 5.6, z: 4.0 },
  { x: -5.6, z: 4.0 },
  { x: 5.6, z: -4.0 },
  { x: -5.6, z: -4.0 },
];
export const STADIUM_MAST_H = 4.2;
export function stadium(k: Kit) {
  const RX = 5.6;
  const RZ = 4.0;
  const seg = 40;
  // pitch with stripes and lines
  k.add(new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2).scale(RX - 1.4, 1, RZ - 1.3), local(0, 0.03, 0), 0x2e7a2e);
  for (let i = 0; i < 7; i++) k.slab(0.55, 3.2, -1.65 + i * 0.55, 0.035, 0, i % 2 ? 0x2a6e2a : 0x348434);
  k.slab(0.04, 3.2, 0, 0.04, 0, 0xf4f4f4);
  k.add(new THREE.RingGeometry(0.42, 0.46, 24).rotateX(-Math.PI / 2), local(0, 0.04, 0), 0xf4f4f4);
  for (const s of [-1, 1]) k.box(0.06, 0.25, 0.5, s * 2.05, 0.12, 0, 0xf4f4f4);
  // the bowl: continuous stepped tiers of seats (blocks of colour), a concourse wall, the roof ring
  const band = (f0: number, y0: number, f1: number, y1: number, col: (a: number) => number, glow = 0) => {
    const pos: number[] = [];
    const cols: number[] = [];
    const c = new THREE.Color();
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const P = (a: number, f: number, y: number) => [Math.cos(a) * RX * f, y, Math.sin(a) * RZ * f];
      const A = P(a0, f0, y0);
      const B = P(a1, f0, y0);
      const C2 = P(a1, f1, y1);
      const D = P(a0, f1, y1);
      // both windings: seen from the pitch and from outside
      pos.push(...A, ...C2, ...B, ...A, ...D, ...C2, ...A, ...B, ...C2, ...A, ...C2, ...D);
      c.setHex(col((a0 + a1) / 2));
      for (let v = 0; v < 12; v++) cols.push(c.r, c.g, c.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const start = k.count;
    k.add(g, null, 0xffffff, glow);
    for (let i = 0; i < cols.length; i++) k.col[start * 3 + i] = cols[i];
  };
  const seat = (a: number) => (Math.floor(((a / (Math.PI * 2)) * 16 + 0.5)) % 2 ? 0x2a4ab0 : 0xc02a2a);
  for (let r = 0; r < 5; r++) {
    const f0 = 0.74 + r * 0.06;
    const f1 = f0 + 0.06;
    const y = 0.15 + r * 0.32;
    band(f0, y, f0, y + 0.32, () => 0x8a8a88); // riser
    band(f0, y + 0.32, f1, y + 0.32, r === 4 ? () => 0x9a9a98 : seat); // tread (seats)
  }
  band(0.74, 0.0, 0.74, 0.15, () => 0x6a6a6a);
  band(1.04, 0, 1.04, 1.95, (a) => (Math.floor((a / (Math.PI * 2)) * 40) % 4 === 0 ? 0x9aa4ac : 0xd8d6d0));
  band(1.04, 1.25, 1.045, 1.4, () => 0x2a4ab0, 3);
  band(0.98, 1.95, 1.06, 1.95, () => 0x8a8a88);
  band(0.88, 2.15, 1.06, 2.0, () => 0xf0f0ee);
  // floodlight masts with lamp banks (lit heads)
  for (const L of STADIUM_LIGHTS) {
    const x = L.x * 1.1;
    const z = L.z * 1.1;
    k.cyl(0.08, 0.06, STADIUM_MAST_H, x, 0, z, 0x9a9ea4, 8);
    k.box(0.6, 0.4, 0.08, x, STADIUM_MAST_H + 0.1, z, 0xf8f4e0, 3, -Math.atan2(-z, -x) + Math.PI / 2);
  }
}

/** Skyscraper: glass tower (facade window grid), setbacks and a crown; height h. Returns the roof height. */
export function skyscraper(k: Kit, w: number, d: number, h: number, v: number): number {
  const tones = [0x5a6a78, 0x7a8288, 0x8a7a68, 0x4a5a6a, 0x9aa0a4];
  const c = tones[Math.floor(v * tones.length) % tones.length];
  k.box(w, h * 0.62, d, 0, h * 0.31, 0, c, 2);
  k.box(w * 0.8, h * 0.28, d * 0.8, 0, h * 0.62 + h * 0.14, 0, c, 2);
  k.box(w * 0.55, h * 0.1, d * 0.55, 0, h * 0.9 + h * 0.05, 0, c, 2);
  k.box(w * 1.02, 0.06, d * 1.02, 0, h * 0.62, 0, 0xc8ccd0);
  k.box(w * 0.82, 0.06, d * 0.82, 0, h * 0.9, 0, 0xc8ccd0);
  if (v > 0.5) k.beam(0, h, 0, 0, h + 1.2, 0, 0.05, 0xc8ccd0);
  return v > 0.5 ? h + 1.2 : h;
}

/** Fuel station: canopy on pillars over two pump islands, a shop, a price pylon (~3 x 2). */
export function fuelStation(k: Kit) {
  k.slab(3.4, 2.4, 0, 0.02, 0, 0x4a4a4c);
  for (const [x, z] of [[-0.8, -0.5], [0.8, -0.5], [-0.8, 0.5], [0.8, 0.5]] as const) k.box(0.1, 0.65, 0.1, x, 0.325, z, 0xe8e8e8);
  k.box(2.2, 0.12, 1.5, 0, 0.71, 0, 0xf4f4f4, 3);
  k.box(2.24, 0.05, 1.54, 0, 0.64, 0, 0x2a8a3a);
  for (const x of [-0.45, 0.45]) {
    k.box(0.5, 0.05, 0.14, x, 0.025, 0, 0x9a9a9a);
    for (const s of [-1, 1]) k.box(0.1, 0.24, 0.08, x + s * 0.14, 0.17, 0, 0xd0d0d0, 3);
  }
  k.box(1.4, 0.55, 0.7, 0.2, 0.275, -1.15, 0xe0dcd4);
  k.box(1.2, 0.3, 0.02, 0.2, 0.3, -0.79, 0x9ab8cc, 1);
  k.box(1.44, 0.06, 0.74, 0.2, 0.58, -1.15, 0x2a8a3a);
  k.box(0.06, 1.0, 0.06, 1.5, 0.5, 0.95, 0x8a8a8a);
  k.box(0.04, 0.5, 0.36, 1.5, 1.05, 0.95, 0x2a8a3a, 3);
}

/** Hospital: a slab with a lower wing, red-cross sign and a rooftop helipad (pad centre at HELIPAD). */
export const HELIPAD = { x: -0.6, z: 0, y: 2.62 };
export function hospital(k: Kit) {
  k.box(3.2, 2.5, 1.6, -0.6, 1.25, 0, 0xe8e8e4, 2);
  k.box(2.0, 1.1, 1.8, 1.8, 0.55, 0.5, 0xdcdcd8, 2);
  k.box(3.3, 0.1, 1.7, -0.6, 2.55, 0, 0xc8c8c4);
  // helipad: dark disc, white ring and H
  k.add(new THREE.CircleGeometry(0.7, 20).rotateX(-Math.PI / 2), local(HELIPAD.x, 2.61, 0), 0x3a3e44);
  k.add(new THREE.RingGeometry(0.58, 0.64, 24).rotateX(-Math.PI / 2), local(HELIPAD.x, 2.615, 0), 0xf4f4f4);
  for (const s of [-1, 1]) k.box(0.06, 0.008, 0.42, HELIPAD.x + s * 0.13, 2.618, 0, 0xf4f4f4);
  k.box(0.26, 0.008, 0.06, HELIPAD.x, 2.618, 0, 0xf4f4f4);
  // red cross signs (lit)
  for (const s of [-1, 1]) {
    k.box(0.36, 0.1, 0.02, 0.2, 2.1, s * 0.81, 0xd02020, 3);
    k.box(0.1, 0.36, 0.02, 0.2, 2.1, s * 0.81, 0xd02020, 3);
  }
  // entrance canopy
  k.box(0.6, 0.05, 0.5, 2.0, 0.45, 1.6, 0xd02020);
  for (const s of [-1, 1]) k.box(0.04, 0.45, 0.04, 2.0 + s * 0.25, 0.225, 1.75, 0x8a8a8a);
}

/** Harbour crane (luffing jib), facing +X, height ~4. */
export function harbourCrane(k: Kit, v: number) {
  const c = v > 0.5 ? 0xd8a020 : 0xc03a2a;
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) k.beam(sx * 0.45, 0, sz * 0.4, sx * 0.25, 1.4, sz * 0.25, 0.08, c);
  k.box(0.7, 0.5, 0.6, 0, 1.6, 0, c);
  k.box(0.32, 0.3, 0.3, 0.3, 1.95, 0.15, 0xe8e8e8);
  k.beam(0, 1.85, 0, 2.6, 3.6, 0, 0.1, c);
  k.beam(0, 1.85, 0, -0.9, 2.6, 0, 0.12, c);
  k.box(0.3, 0.3, 0.4, -0.9, 2.5, 0, 0x5a5a5a);
  k.beam(0, 3.0, 0, 2.6, 3.6, 0, 0.02, 0x2a2a2a);
  k.beam(0, 3.0, 0, 0, 1.85, 0, 0.08, c);
  k.beam(2.6, 3.6, 0, 2.6, 1.3, 0, 0.012, 0x2a2a2a);
  k.box(0.14, 0.08, 0.14, 2.6, 1.25, 0, 0x2a2a2a);
}

/** Shipping container stack (1 x 0.4 x 0.4 boxes). */
export function containers(k: Kit, seed: number) {
  const cols = [0xb03a2a, 0x2a5a9a, 0x2a8a5a, 0xd09a2a, 0x6a6a6a, 0xe0e0e0];
  for (let i = 0; i < 8; i++) {
    const x = (i % 4) * 1.05;
    const y = Math.floor(i / 4) * 0.4;
    if (h3(seed, i, 1) < 0.25 && y > 0) continue;
    k.box(1.0, 0.38, 0.4, x, y + 0.19, 0, cols[Math.floor(h3(seed, i, 2) * cols.length)]);
    k.box(1.0, 0.38, 0.4, x, y + 0.19, 0.42, cols[Math.floor(h3(seed, i, 3) * cols.length)]);
  }
}
