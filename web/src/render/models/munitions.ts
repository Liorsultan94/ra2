import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { MunitionModel } from './types';

/*
 * Additional strike-missile visuals (forward = +X, origin at the centre),
 * built in the same style as the munitions in aircraft.ts: lathed bodies
 * with painted bands, plate fins / wings, merged into one vertex-coloured
 * mesh per kind and team, plus a glowing motor throat at the nozzle.
 *
 * Geometry is authored in normalised units (body length 1, nose at x = +0.5)
 * and scaled by the munition length.
 */

export type ExtraMunitionKind =
  | 'heavyBallistic' // Khorramshahr-class MRBM: fat finless body, blunt tri-conic re-entry vehicle
  | 'quasiBallistic' // Iskander / LORA / PrSM / Hyunmoo / Tayfun: slender ogive body, grid-like tail fins
  | 'cruiseMissile' // Tomahawk / Neptune: tube body, straight pop-out wings, cruciform tail, ventral intake
  | 'stealthCruise' // Taurus KEPD 350: faceted flat body, swept wings, chisel nose
  | 'bomb'; // jet-dropped 2,000 lb bomb (Mk 84 body with a JDAM tail kit): no motor

export const EXTRA_MUNITIONS: ReadonlySet<string> = new Set<ExtraMunitionKind>(['heavyBallistic', 'quasiBallistic', 'cruiseMissile', 'stealthCruise', 'bomb']);

type P2 = [number, number];
type V3 = [number, number, number];
const PI = Math.PI;
const TAU = PI * 2;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Color();

/** Non-indexed, position + normal (+ colour) only, so everything merges. */
function prep(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const o = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(o.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color') o.deleteAttribute(k);
  if (!o.attributes.normal) o.computeVertexNormals();
  return o;
}

function tf<T extends THREE.BufferGeometry>(g: T, p: V3 = [0, 0, 0], r: V3 = [0, 0, 0], s: V3 = [1, 1, 1]): T {
  _m.compose(_p.set(p[0], p[1], p[2]), _q.setFromEuler(_e.set(r[0], r[1], r[2])), _s.set(s[0], s[1], s[2]));
  g.applyMatrix4(_m);
  return g;
}

function colorize(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  _c.setHex(hex);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = _c.r;
    a[i * 3 + 1] = _c.g;
    a[i * 3 + 2] = _c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

function flipWinding(g: THREE.BufferGeometry) {
  for (const name of Object.keys(g.attributes)) {
    const a = g.attributes[name] as THREE.BufferAttribute;
    const arr = a.array as Float32Array;
    const n = a.itemSize;
    for (let t = 0; t < a.count; t += 3) {
      for (let c = 0; c < n; c++) {
        const i1 = (t + 1) * n + c;
        const i2 = (t + 2) * n + c;
        const tmp = arr[i1];
        arr[i1] = arr[i2];
        arr[i2] = tmp;
      }
    }
    a.needsUpdate = true;
  }
}

/** Make a closed, centred-ish solid wind outward (signed volume about `centre`). */
function outward(g: THREE.BufferGeometry, centre: V3 = [0, 0, 0]) {
  const pos = g.attributes.position;
  let vol = 0;
  for (let t = 0; t < pos.count; t += 3) {
    const ax = pos.getX(t) - centre[0], ay = pos.getY(t) - centre[1], az = pos.getZ(t) - centre[2];
    const bx = pos.getX(t + 1) - centre[0], by = pos.getY(t + 1) - centre[1], bz = pos.getZ(t + 1) - centre[2];
    const cx = pos.getX(t + 2) - centre[0], cy = pos.getY(t + 2) - centre[1], cz = pos.getZ(t + 2) - centre[2];
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  if (vol < 0) {
    flipWinding(g);
    g.computeVertexNormals();
  }
  return g;
}

/**
 * Body of revolution about X; profile = (d from the nose 0..1, radius). The nose sits at x = +0.5.
 * fn(d) paints bands; extra rings are inserted at every colour change so bands have crisp edges.
 */
function body(prof: P2[], seg: number, fn: (d: number) => number): THREE.BufferGeometry {
  const pts: P2[] = [prof[0]];
  for (let i = 1; i < prof.length; i++) {
    const [d0, r0] = prof[i - 1];
    const [d1, r1] = prof[i];
    if (d1 > d0) {
      let prev = fn(d0 + 1e-4);
      for (let d = d0 + 0.004; d < d1; d += 0.004) {
        const c = fn(d);
        if (c !== prev) {
          pts.push([d, r0 + ((r1 - r0) * (d - d0)) / (d1 - d0)]);
          prev = c;
        }
      }
    }
    pts.push(prof[i]);
  }
  const g = new THREE.LatheGeometry(
    pts.map(([d, r]) => new THREE.Vector2(Math.max(0.0005, r), -d)),
    seg,
  );
  g.rotateZ(-PI / 2); // lathe axis -> X, nose at x = 0, tail at x = -1
  g.translate(0.5, 0, 0);
  const o = outward(prep(g));
  // paint per triangle by its centroid's distance from the nose
  const pos = o.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let t = 0; t < pos.count; t += 3) {
    const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
    _c.setHex(fn(Math.max(0, Math.min(1, 0.5 - cx))));
    for (let k = 0; k < 3; k++) {
      col[(t + k) * 3] = _c.r;
      col[(t + k) * 3 + 1] = _c.g;
      col[(t + k) * 3 + 2] = _c.b;
    }
  }
  o.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return o;
}

/** Thin plate in the XY plane from an (x, y) outline, `th` thick along Z, centred on z = 0. */
function plate(pts: P2[], th: number): THREE.BufferGeometry {
  const sh = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: th, bevelEnabled: false, steps: 1, curveSegments: 2 });
  g.translate(0, 0, -th / 2);
  return prep(g);
}

/** n fins around the body axis; outline in (d from nose, radial) coordinates. */
function fins(n: number, outline: P2[], th: number, color: number, rot0 = PI / 4): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const g = plate(
      outline.map(([d, r]) => [0.5 - d, r] as P2),
      th,
    );
    out.push(colorize(tf(g, [0, 0, 0], [rot0 + (i * TAU) / n, 0, 0]), color));
  }
  return out;
}

/** Flat wing pair (planform in (d from nose, half-span) coordinates), lying in the XZ plane at height y. */
function wings(planform: P2[], th: number, y: number, color: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (const side of [1, -1]) {
    const g = plate(
      planform.map(([d, s]) => [0.5 - d, s] as P2),
      th,
    );
    // XY plate -> XZ plane: the outline's y becomes the span (z); mirrored for the port wing
    tf(g, [0, y, 0], [side * (PI / 2), 0, 0]);
    out.push(colorize(g, color));
  }
  return out;
}

const box = (w: number, h: number, d: number, p: V3, color: number) => colorize(tf(prep(new THREE.BoxGeometry(w, h, d)), p), color);
/** Flat disc facing -X (motor throat glow). */
const throat = (r: number) => tf(prep(new THREE.CircleGeometry(r, 10)), [-0.505, 0, 0], [0, -PI / 2, 0]);

interface Built {
  body: THREE.BufferGeometry;
  glow: THREE.BufferGeometry | null;
  len: number;
  nozzle: THREE.Vector3;
}

function build(kind: ExtraMunitionKind, team: number): Built {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry | THREE.BufferGeometry[]) => {
    for (const x of Array.isArray(g) ? g : [g]) parts.push(x);
  };
  let len = 0.5;
  let rr = 0.024; // motor throat radius (normalised)
  switch (kind) {
    case 'bomb': {
      // Mk 84 / GBU-31: 3.8 m, 0.46 m low-drag body, yellow nose band (live HE), JDAM strakes and tail kit.
      // Drawn larger than life (~1/3 of the jet) so the drop reads from the RTS camera.
      len = 0.5;
      const R = 0.064;
      add(
        body(
          [
            [0, 0],
            [0.04, R * 0.42],
            [0.12, R * 0.84],
            [0.22, R],
            [0.66, R],
            [0.8, R * 0.76],
            [0.88, R * 0.6],
            [1.0, R * 0.55],
            [1.0, 0],
          ],
          14,
          (d) => (d < 0.05 ? 0x3a3e36 : d > 0.12 && d < 0.17 ? 0xe8c030 : d > 0.5 && d < 0.55 ? team : d > 0.8 ? 0x9a9e96 : 0x8a907c),
        ),
      );
      add(
        fins(
          4,
          [
            [0.32, R],
            [0.37, R * 1.4],
            [0.5, R * 1.4],
            [0.53, R],
          ],
          0.006,
          0x8a907c,
        ),
      );
      add(
        fins(
          4,
          [
            [0.82, R * 0.6],
            [0.9, R * 2.3],
            [0.99, R * 2.3],
            [1.0, R * 0.55],
          ],
          0.01,
          0x9a9e96,
        ),
      );
      rr = 0;
      break;
    }
    case 'heavyBallistic': {
      // Khorramshahr: 13 m, 1.5 m diameter, finless liquid-fuel body with a separating tri-conic RV
      len = 0.86;
      const R = 0.058;
      add(
        body(
          [
            [0, 0],
            [0.015, R * 0.18],
            [0.08, R * 0.45],
            [0.17, R * 0.72],
            [0.24, R * 0.9],
            [0.27, R],
            [0.97, R],
            [0.985, R * 1.05],
            [1, R * 0.95],
            [1, 0],
          ],
          16,
          (d) =>
            d < 0.015 ? 0x8a8c88 // nose tip
            : d < 0.25 ? 0x2c2d2e // ablative RV
            : d < 0.275 ? 0x6a6c68 // separation ring
            : d > 0.31 && d < 0.345 ? team
            : d > 0.5 && d < 0.53 ? 0x1e1f1f // roll-pattern bands
            : d > 0.74 && d < 0.77 ? 0x1e1f1f
            : d > 0.955 ? 0x4a4c4a // engine skirt
            : 0xcdc6ae,
        ),
      );
      // cable raceway and umbilical fairing
      add(box(0.58, R * 0.35, R * 0.4, [0.5 - 0.62, R * 0.98, 0], 0xb9b29a));
      add(box(0.06, R * 0.5, R * 0.6, [0.5 - 0.9, -R * 0.96, 0], 0x5a5c58));
      rr = 0.045;
      break;
    }
    case 'quasiBallistic': {
      // Iskander-style: slender solid motor body, sharp ogive, cable fairings and small trapezoid tail fins
      len = 0.52;
      const R = 0.038;
      add(
        body(
          [
            [0, 0],
            [0.05, R * 0.32],
            [0.12, R * 0.64],
            [0.2, R * 0.9],
            [0.26, R],
            [0.98, R],
            [1, R * 0.86],
            [1, 0],
          ],
          14,
          (d) =>
            d < 0.04 ? 0x3a3c3a
            : d < 0.26 ? 0x8e9484 // warhead section
            : d > 0.27 && d < 0.29 ? 0x2a2c2a
            : d > 0.36 && d < 0.4 ? team
            : d > 0.62 && d < 0.645 ? 0x2a2c2a
            : 0xb4b8a6,
        ),
      );
      add(fins(4, [[0.8, R], [0.86, R * 2.3], [0.99, R * 2.3], [1.0, R]], 0.012, 0x7e8474));
      for (const s of [-1, 1]) add(box(0.6, R * 0.32, R * 0.32, [0.5 - 0.6, 0, s * R * 1.02], 0x8e9484));
      rr = 0.03;
      break;
    }
    case 'cruiseMissile': {
      // Tomahawk / Neptune: 6 m tube body, straight pop-out wings, cruciform tail, ventral intake
      len = 0.44;
      const R = 0.03;
      add(
        body(
          [
            [0, 0],
            [0.008, R * 0.55],
            [0.025, R * 0.82],
            [0.06, R],
            [0.95, R],
            [0.985, R * 0.72],
            [1, R * 0.55],
            [1, 0],
          ],
          14,
          (d) =>
            d < 0.03 ? 0x50524e // radome / sensor window
            : d > 0.16 && d < 0.2 ? team
            : d > 0.24 && d < 0.255 ? 0xd8b030 // live warhead band
            : d > 0.94 ? 0x3e403e
            : 0xd6d6cc,
        ),
      );
      add(
        wings(
          [
            [0.42, 0],
            [0.45, R * 6.6],
            [0.5, R * 6.6],
            [0.52, 0],
          ],
          0.008,
          R * 0.2,
          0xc8c8be,
        ),
      );
      add(fins(4, [[0.88, R], [0.93, R * 2.6], [0.99, R * 2.6], [1.0, R]], 0.008, 0xc0c0b6));
      // flush ventral air intake scoop
      add(box(0.09, R * 0.55, R * 0.9, [0.5 - 0.74, -R * 1.05, 0], 0x5a5c58));
      rr = 0.016;
      break;
    }
    case 'stealthCruise': {
      // Taurus KEPD 350: flat trapezoid-section stealth body with a chisel nose, swept wings, canted twin tails
      len = 0.48;
      const W = 0.06; // half-width at the belly
      const H = 0.042; // body height
      const sh = new THREE.Shape([new THREE.Vector2(-W, -H * 0.5), new THREE.Vector2(W, -H * 0.5), new THREE.Vector2(W * 0.62, H * 0.5), new THREE.Vector2(-W * 0.62, H * 0.5)]);
      const g = new THREE.ExtrudeGeometry(sh, { depth: 1, bevelEnabled: false, steps: 20, curveSegments: 1 });
      g.translate(0, 0, -0.5);
      g.rotateY(PI / 2); // extrusion along X (shape z = side, y = up)
      const b = prep(g);
      const pos = b.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        // chisel nose over the front 30%, slight boat-tail at the back
        const f = x > 0.2 ? Math.max(0.12, 1 - (x - 0.2) / 0.3) : x < -0.42 ? 1 - ((-0.42 - x) / 0.08) * 0.25 : 1;
        pos.setY(i, pos.getY(i) * (x > 0.2 ? 0.55 + 0.45 * f : f));
        pos.setZ(i, pos.getZ(i) * f);
      }
      b.computeVertexNormals();
      outward(b);
      // paint: dark grey with a team band
      const col = new Float32Array(pos.count * 3);
      for (let t = 0; t < pos.count; t += 3) {
        const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
        _c.setHex(cx > 0.08 && cx < 0.14 ? team : cx > 0.44 ? 0x2e3234 : 0x4b5154);
        for (let k = 0; k < 3; k++) {
          col[(t + k) * 3] = _c.r;
          col[(t + k) * 3 + 1] = _c.g;
          col[(t + k) * 3 + 2] = _c.b;
        }
      }
      b.setAttribute('color', new THREE.BufferAttribute(col, 3));
      add(b);
      add(
        wings(
          [
            [0.36, W * 0.9],
            [0.56, W * 3.6],
            [0.63, W * 3.6],
            [0.6, W * 0.9],
          ],
          0.008,
          -H * 0.3,
          0x454b4e,
        ),
      );
      // twin canted tails
      for (const s of [-1, 1]) {
        const fin = plate(
          [
            [0.5 - 0.84, 0],
            [0.5 - 0.95, H * 1.5],
            [0.5 - 1.0, H * 1.5],
            [0.5 - 0.98, 0],
          ],
          0.008,
        );
        add(colorize(tf(fin, [0, H * 0.4, s * W * 0.5], [s * 0.45, 0, 0]), 0x454b4e));
      }
      // belly intake
      add(box(0.12, H * 0.35, W * 0.8, [0.5 - 0.66, -H * 0.62, 0], 0x2a2d2f));
      rr = 0.018;
      break;
    }
  }
  const merged = mergeGeometries(parts, false)!;
  merged.scale(len, len, len);
  const glow = rr > 0 ? mergeGeometries([throat(rr), tf(prep(new THREE.ConeGeometry(rr * 0.8, rr * 4, 8, 1, true)), [-0.505 - rr * 2, 0, 0], [0, 0, PI / 2])], false) : null;
  glow?.scale(len, len, len);
  return { body: merged, glow, len, nozzle: new THREE.Vector3(-len / 2, 0, 0) };
}

const cache = new Map<string, Built>();
let mat: THREE.MeshStandardMaterial | null = null;
let glowMat: THREE.MeshBasicMaterial | null = null;

/** Projectile visual for the extra strike-missile kinds (forward = +X). Returns null on failure (renderer falls back). */
export function createExtraMunition(kind: ExtraMunitionKind, team: number): MunitionModel | null {
  try {
    const key = `${kind}|${team}`;
    let m = cache.get(key);
    if (!m) {
      m = build(kind, team);
      cache.set(key, m);
    }
    mat ??= new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.45 });
    glowMat ??= new THREE.MeshBasicMaterial({ color: 0xffa040, toneMapped: false, side: THREE.DoubleSide });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(m.body, mat));
    if (m.glow) root.add(new THREE.Mesh(m.glow, glowMat));
    return { root, nozzle: m.nozzle.clone(), length: m.len };
  } catch (e) {
    console.error('munition build failed', kind, e);
    return null;
  }
}
