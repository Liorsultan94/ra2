import * as THREE from 'three';
import { GeoBuilder } from '../geo';

/*
 * Low-poly civilian vehicles, livestock and birds for the ambient life.
 * All models face +X with their origin on the ground under the centre and
 * carry a per-vertex part code in the `flex` attribute (see ambientMaterial).
 * Painted parts are built in white so the per-instance paint shows true.
 */

const C = (r: number, g: number, b: number) => new THREE.Color(r, g, b);
const GLASS = C(0.07, 0.09, 0.11);
const TYRE = C(0.06, 0.06, 0.06);
const RIM = C(0.55, 0.55, 0.56);
const CHROME = C(0.6, 0.6, 0.62);
const HEAD = C(1.0, 0.96, 0.82);
const TAIL = C(0.75, 0.06, 0.04);
const WHITE = C(1, 1, 1);
const DARK = C(0.12, 0.12, 0.13);

function trs(x: number, y: number, z: number, ry = 0, rx = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(sx, sy, sz));
}

function box(b: GeoBuilder, w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color, part = 0, ry = 0, rz = 0) {
  b.add(new THREE.BoxGeometry(w, h, d).toNonIndexed(), trs(x, y, z, ry, 0, rz), null, c, { flexFn: () => part });
}

/** Sloped cabin: a box whose top face is narrowed towards front and back (windscreen rake). */
function cabin(b: GeoBuilder, len: number, h: number, wid: number, x: number, y0: number, rakeF: number, rakeR: number, c: THREE.Color, part = 0) {
  const g = new THREE.BoxGeometry(len, h, wid).toNonIndexed();
  const P = g.attributes.position;
  for (let i = 0; i < P.count; i++) {
    if (P.getY(i) > 0) {
      const px = P.getX(i);
      P.setX(i, px > 0 ? px - rakeF : px + rakeR);
      P.setZ(i, P.getZ(i) * 0.9);
    }
  }
  g.computeVertexNormals();
  b.add(g, trs(x, y0 + h / 2, 0), null, c, { flexFn: () => part });
}

function wheel(b: GeoBuilder, r: number, w: number, x: number, z: number) {
  b.add(new THREE.CylinderGeometry(r, r, w, 10).rotateX(Math.PI / 2).toNonIndexed(), trs(x, r, z), null, TYRE, { flexFn: () => 0 });
  b.add(new THREE.CylinderGeometry(r * 0.5, r * 0.5, w + 0.004, 8).rotateX(Math.PI / 2).toNonIndexed(), trs(x, r, z), null, RIM, { flexFn: () => 0 });
}

export interface CarModel {
  geo: THREE.BufferGeometry;
  /** Door hinge (x, half width) for the door rig. */
  rig: THREE.Vector4;
  len: number;
  wid: number;
  /** Headlight / tail light anchor heights. */
  lightY: number;
}

/**
 * Civilian vehicles are built at the old half scale below and enlarged by this: next to the
 * people (an adult is 0.46 tiles tall) a sedan's roof comes up to about the shoulder, in line
 * with the military vehicles' enlargement. A sedan is ~0.9 tiles long, 0.38 wide.
 */
export const CAR_SCALE = 1.8;

/** Enlarge a model built at the old scale (geometry, door rig, sizes). */
export function scaleCar(m: CarModel, k = CAR_SCALE): CarModel {
  m.geo.scale(k, k, k);
  m.geo.computeBoundingSphere();
  m.rig.x *= k;
  m.rig.y *= k;
  return { ...m, len: m.len * k, wid: m.wid * k, lightY: m.lightY * k };
}

/** 0 sedan, 1 van, 2 pickup, 3 tractor */
export function carModel(kind: number): CarModel {
  return scaleCar(baseCarModel(kind));
}

function baseCarModel(kind: number): CarModel {
  const b = new GeoBuilder();
  if (kind === 0) {
    // sedan: 0.5 long
    const L = 0.5;
    const W = 0.21;
    box(b, L, 0.075, W, 0, 0.082, 0, WHITE, 1);
    box(b, 0.12, 0.012, W * 0.96, 0.17, 0.124, 0, WHITE, 1); // bonnet
    cabin(b, 0.27, 0.07, W * 0.98, -0.03, 0.118, 0.06, 0.05, WHITE, 1);
    cabin(b, 0.255, 0.058, W * 1.0, -0.03, 0.121, 0.056, 0.046, GLASS);
    box(b, 0.012, 0.03, W * 0.99, L / 2 + 0.002, 0.07, 0, CHROME); // bumper
    box(b, 0.012, 0.03, W * 0.99, -L / 2 - 0.002, 0.07, 0, CHROME);
    for (const s of [-1, 1]) {
      box(b, 0.008, 0.018, 0.04, L / 2 + 0.006, 0.098, s * 0.07, HEAD);
      box(b, 0.008, 0.018, 0.045, -L / 2 - 0.006, 0.1, s * 0.07, TAIL);
      // doors (front pair), hinge at the front edge
      box(b, 0.12, 0.06, 0.008, 0.0, 0.1, s * (W / 2 + 0.003), WHITE, s > 0 ? 2 : 3);
      wheel(b, 0.044, 0.035, 0.155, s * (W / 2 - 0.012));
      wheel(b, 0.044, 0.035, -0.155, s * (W / 2 - 0.012));
    }
    return { geo: b.build(true), rig: new THREE.Vector4(0.06, W / 2 + 0.003, 0, 0), len: L, wid: W, lightY: 0.1 };
  }
  if (kind === 1) {
    // delivery van: tall box body, short nose
    const L = 0.54;
    const W = 0.23;
    box(b, 0.42, 0.2, W, -0.06, 0.155, 0, WHITE, 1);
    box(b, 0.12, 0.09, W, 0.21, 0.1, 0, WHITE, 1);
    cabin(b, 0.1, 0.09, W * 0.97, 0.13, 0.145, 0.05, 0, GLASS);
    box(b, 0.01, 0.03, W * 0.99, L / 2 + 0.002, 0.072, 0, DARK);
    box(b, 0.01, 0.03, W * 0.99, -L / 2 + 0.005, 0.072, 0, DARK);
    for (const s of [-1, 1]) {
      box(b, 0.008, 0.02, 0.04, L / 2 + 0.004, 0.11, s * 0.075, HEAD);
      box(b, 0.008, 0.03, 0.03, -0.27 - 0.006, 0.12, s * 0.095, TAIL);
      box(b, 0.07, 0.07, 0.006, 0.13, 0.205, s * (W / 2 + 0.002), GLASS); // side window
      box(b, 0.1, 0.12, 0.008, 0.11, 0.14, s * (W / 2 + 0.004), WHITE, s > 0 ? 2 : 3);
      wheel(b, 0.046, 0.038, 0.17, s * (W / 2 - 0.014));
      wheel(b, 0.046, 0.038, -0.17, s * (W / 2 - 0.014));
    }
    return { geo: b.build(true), rig: new THREE.Vector4(0.16, W / 2 + 0.004, 0, 0), len: L, wid: W, lightY: 0.11 };
  }
  if (kind === 2) {
    // pickup / small lorry: cab + open bed with a load
    const L = 0.56;
    const W = 0.22;
    box(b, L, 0.06, W, 0, 0.08, 0, DARK);
    box(b, 0.2, 0.08, W, 0.17, 0.14, 0, WHITE, 1);
    cabin(b, 0.13, 0.085, W * 0.98, 0.12, 0.178, 0.05, 0.0, WHITE, 1);
    cabin(b, 0.125, 0.07, W * 1.0, 0.12, 0.183, 0.045, -0.002, GLASS);
    // bed sides
    box(b, 0.32, 0.06, 0.012, -0.11, 0.14, W / 2 - 0.006, WHITE, 1);
    box(b, 0.32, 0.06, 0.012, -0.11, 0.14, -W / 2 + 0.006, WHITE, 1);
    box(b, 0.012, 0.06, W, -0.27, 0.14, 0, WHITE, 1);
    box(b, 0.3, 0.012, W - 0.02, -0.11, 0.115, 0, C(0.25, 0.22, 0.18));
    // load: crates / hay
    box(b, 0.12, 0.07, 0.15, -0.06, 0.155, 0, C(0.62, 0.52, 0.3));
    box(b, 0.1, 0.05, 0.12, -0.19, 0.145, 0.02, C(0.45, 0.33, 0.2));
    for (const s of [-1, 1]) {
      box(b, 0.008, 0.02, 0.04, L / 2 - 0.0, 0.13, s * 0.07, HEAD);
      box(b, 0.008, 0.02, 0.03, -0.28, 0.1, s * 0.085, TAIL);
      box(b, 0.1, 0.07, 0.008, 0.14, 0.15, s * (W / 2 + 0.004), WHITE, s > 0 ? 2 : 3);
      wheel(b, 0.05, 0.04, 0.18, s * (W / 2 - 0.016));
      wheel(b, 0.05, 0.04, -0.17, s * (W / 2 - 0.016));
    }
    return { geo: b.build(true), rig: new THREE.Vector4(0.19, W / 2 + 0.004, 0, 0), len: L, wid: W, lightY: 0.13 };
  }
  // tractor: big rear wheels, narrow bonnet, glass cab
  const W = 0.2;
  box(b, 0.22, 0.07, 0.09, 0.08, 0.1, 0, WHITE, 1); // bonnet
  box(b, 0.04, 0.05, 0.1, 0.2, 0.09, 0, DARK); // grille
  box(b, 0.12, 0.05, 0.14, -0.08, 0.12, 0, WHITE, 1); // fenders base
  box(b, 0.1, 0.11, 0.12, -0.08, 0.2, 0, GLASS); // cab
  box(b, 0.12, 0.012, 0.14, -0.08, 0.26, 0, WHITE, 1); // roof
  box(b, 0.012, 0.06, 0.012, 0.13, 0.16, 0.03, DARK); // exhaust stack
  for (const s of [-1, 1]) {
    box(b, 0.006, 0.014, 0.02, 0.215, 0.11, s * 0.035, HEAD);
    box(b, 0.006, 0.014, 0.02, -0.15, 0.14, s * 0.07, TAIL);
    box(b, 0.11, 0.03, 0.04, -0.09, 0.15, s * 0.08, WHITE, 1); // mudguards
    box(b, 0.006, 0.09, 0.07, -0.08, 0.2, s * 0.062, WHITE, s > 0 ? 2 : 3);
    wheel(b, 0.085, 0.05, -0.09, s * (W / 2 - 0.01));
    wheel(b, 0.045, 0.03, 0.14, s * 0.06);
  }
  return { geo: b.build(true), rig: new THREE.Vector4(-0.045, 0.062, 0, 0), len: 0.42, wid: W, lightY: 0.11 };
}

export interface AnimalModel {
  geo: THREE.BufferGeometry;
  /** neck pivot x, y, max head-down angle, leg top y */
  rig: THREE.Vector4;
}

export function cowModel(): AnimalModel {
  const b = new GeoBuilder();
  const legTop = 0.1;
  box(b, 0.26, 0.12, 0.12, 0, 0.165, 0, WHITE, 1); // body
  box(b, 0.1, 0.1, 0.125, 0.03, 0.17, 0, C(0.92, 0.9, 0.86)); // pale saddle patch (blends with the coat)
  box(b, 0.05, 0.04, 0.06, 0.14, 0.2, 0, WHITE, 1); // neck
  box(b, 0.08, 0.065, 0.065, 0.19, 0.2, 0, WHITE, 4); // head
  box(b, 0.035, 0.04, 0.055, 0.235, 0.185, 0, C(0.85, 0.62, 0.58), 4); // muzzle
  box(b, 0.012, 0.012, 0.11, 0.165, 0.235, 0, C(0.85, 0.82, 0.72), 4); // horns
  box(b, 0.03, 0.025, 0.04, -0.06, 0.1, 0, C(0.9, 0.62, 0.6)); // udder
  box(b, 0.012, 0.09, 0.012, -0.135, 0.15, 0, WHITE, 1); // tail
  for (const [x, z, p] of [
    [0.09, 0.04, 5],
    [0.09, -0.04, 6],
    [-0.09, 0.04, 6],
    [-0.09, -0.04, 5],
  ]) {
    box(b, 0.03, legTop, 0.03, x, legTop / 2, z, C(0.8, 0.78, 0.75), p);
    box(b, 0.032, 0.02, 0.032, x, 0.01, z, DARK, p); // hooves
  }
  return { geo: b.build(true), rig: new THREE.Vector4(0.13, 0.2, 0.85, legTop) };
}

export function sheepModel(): AnimalModel {
  const b = new GeoBuilder();
  const legTop = 0.07;
  const wool = new THREE.IcosahedronGeometry(0.1, 1);
  b.add(wool, trs(0, 0.13, 0, 0, 0, 0, 1.0, 0.62, 0.66), null, WHITE, { flexFn: () => 1 });
  box(b, 0.06, 0.05, 0.045, 0.12, 0.15, 0, C(0.16, 0.14, 0.13), 4); // head (dark face)
  box(b, 0.015, 0.02, 0.07, 0.11, 0.17, 0, C(0.16, 0.14, 0.13), 4); // ears
  for (const [x, z, p] of [
    [0.055, 0.03, 5],
    [0.055, -0.03, 6],
    [-0.055, 0.03, 6],
    [-0.055, -0.03, 5],
  ])
    box(b, 0.018, legTop + 0.01, 0.018, x, legTop / 2, z, C(0.15, 0.13, 0.12), p);
  return { geo: b.build(true), rig: new THREE.Vector4(0.1, 0.15, 0.95, legTop) };
}

export function birdModel(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  box(b, 0.06, 0.018, 0.02, 0, 0, 0, WHITE, 0);
  box(b, 0.02, 0.016, 0.016, 0.035, 0.004, 0, WHITE, 0); // head
  // tail
  const tail = new THREE.BufferGeometry();
  tail.setAttribute('position', new THREE.Float32BufferAttribute([-0.03, 0, -0.012, -0.055, 0, 0.014, -0.03, 0, 0.012, -0.03, 0, -0.012, -0.055, 0, -0.014, -0.055, 0, 0.014], 3));
  tail.computeVertexNormals();
  b.add(tail, new THREE.Matrix4(), null, WHITE, { flexFn: () => 0 });
  // wings: swept triangles, part 1 (flap / fold in the shader)
  for (const s of [-1, 1]) {
    const w = new THREE.BufferGeometry();
    w.setAttribute('position', new THREE.Float32BufferAttribute([0.018, 0, s * 0.008, -0.022, 0, s * 0.008, -0.012, 0, s * 0.085, 0.018, 0, s * 0.008, -0.012, 0, s * 0.085, 0.006, 0, s * 0.07], 3));
    w.computeVertexNormals();
    b.add(w, new THREE.Matrix4(), null, WHITE, { flexFn: (p) => (Math.abs(p.z) > 0.01 ? 1 : 0) });
  }
  return b.build(true);
}
