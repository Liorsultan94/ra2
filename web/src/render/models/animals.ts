import * as THREE from 'three';
import { GeoBuilder } from '../geo';
import type { AnimalModel } from '../ambient/models';

/*
 * More livestock and wildlife for the ambient life (ambient/animals.ts), at the
 * civilians' scale (a man is 0.46 tiles tall): horse, dog, chicken, camel,
 * goat, deer, hare, cat. Same conventions as ambient/models.ts: face +X,
 * origin on the ground, per-vertex `flex` part codes for the animal rig in
 * ambientMaterial: 1 coat (painted), 4 head + neck (pitches down about the
 * neck pivot), 5 / 6 the two diagonal leg pairs. Painted parts are white.
 */

const C = (r: number, g: number, b: number) => new THREE.Color(r, g, b);
const WHITE = C(1, 1, 1);
const DARK = C(0.1, 0.09, 0.08);
const HOOF = C(0.16, 0.13, 0.11);

function trs(x: number, y: number, z: number, rz = 0, ry = 0, sx = 1, sy = 1, sz = 1) {
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, rz, 'YXZ')), new THREE.Vector3(sx, sy, sz));
}

function box(b: GeoBuilder, w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color, part = 0, rz = 0) {
  b.add(new THREE.BoxGeometry(w, h, d), trs(x, y, z, rz), null, c, { flexFn: () => part });
}

function ell(b: GeoBuilder, rx: number, ry: number, rz: number, x: number, y: number, z: number, c: THREE.Color, part = 0, tilt = 0) {
  b.add(new THREE.SphereGeometry(1, 8, 5), trs(x, y, z, tilt, 0, rx, ry, rz), null, c, { flexFn: () => part });
}

/** Four legs from legTop down, pairs 5 / 6 diagonal; optional hooves. */
function legs(b: GeoBuilder, fx: number, rx: number, hz: number, legTop: number, w: number, c: THREE.Color, hoof: THREE.Color | null) {
  for (const [x, z, p] of [
    [fx, hz, 5],
    [fx, -hz, 6],
    [rx, hz, 6],
    [rx, -hz, 5],
  ]) {
    box(b, w, legTop, w, x, legTop / 2, z, c, p);
    if (hoof) box(b, w * 1.1, Math.min(0.02, legTop * 0.15), w * 1.1, x, Math.min(0.01, legTop * 0.075), z, hoof, p);
  }
}

export function horseModel(): AnimalModel {
  const b = new GeoBuilder();
  const legTop = 0.26;
  ell(b, 0.21, 0.085, 0.075, 0, 0.34, 0, WHITE, 1);
  box(b, 0.1, 0.17, 0.06, 0.2, 0.43, 0, WHITE, 4, -0.6); // neck
  box(b, 0.15, 0.055, 0.055, 0.29, 0.48, 0, WHITE, 4, 0.55); // head
  box(b, 0.05, 0.04, 0.045, 0.34, 0.425, 0, C(0.2, 0.17, 0.15), 4, 0.55); // muzzle
  box(b, 0.02, 0.04, 0.012, 0.24, 0.55, 0.02, WHITE, 4); // ears
  box(b, 0.02, 0.04, 0.012, 0.24, 0.55, -0.02, WHITE, 4);
  box(b, 0.12, 0.03, 0.02, 0.17, 0.49, 0, DARK, 4, -0.6); // mane
  box(b, 0.025, 0.16, 0.025, -0.22, 0.3, 0, DARK, 0, -0.35); // tail
  legs(b, 0.14, -0.15, 0.045, legTop, 0.034, WHITE, HOOF);
  return { geo: b.build(true), rig: new THREE.Vector4(0.15, 0.4, 1.15, legTop) };
}

export function dogModel(): AnimalModel {
  const b = new GeoBuilder();
  const legTop = 0.085;
  ell(b, 0.1, 0.038, 0.034, 0, 0.115, 0, WHITE, 1);
  ell(b, 0.045, 0.04, 0.035, 0.1, 0.16, 0, WHITE, 4);
  box(b, 0.045, 0.025, 0.025, 0.14, 0.15, 0, WHITE, 4); // snout
  box(b, 0.012, 0.012, 0.014, 0.165, 0.155, 0, DARK, 4); // nose
  box(b, 0.015, 0.03, 0.012, 0.09, 0.2, 0.022, WHITE, 4); // ears
  box(b, 0.015, 0.03, 0.012, 0.09, 0.2, -0.022, WHITE, 4);
  box(b, 0.012, 0.07, 0.012, -0.11, 0.15, 0, WHITE, 0, -0.8); // tail
  legs(b, 0.065, -0.065, 0.022, legTop, 0.018, WHITE, null);
  return { geo: b.build(true), rig: new THREE.Vector4(0.07, 0.14, 0.75, legTop) };
}

export function chickenModel(): AnimalModel {
  const b = new GeoBuilder();
  const legTop = 0.035;
  ell(b, 0.042, 0.032, 0.028, 0, 0.065, 0, WHITE, 1);
  box(b, 0.03, 0.04, 0.03, -0.04, 0.085, 0, WHITE, 1, -0.5); // tail feathers
  ell(b, 0.018, 0.02, 0.017, 0.038, 0.1, 0, WHITE, 4);
  box(b, 0.014, 0.008, 0.008, 0.058, 0.098, 0, C(0.95, 0.7, 0.1), 4); // beak
  box(b, 0.02, 0.014, 0.005, 0.038, 0.122, 0, C(0.85, 0.08, 0.06), 4); // comb
  for (const [z, p] of [
    [0.012, 5],
    [-0.012, 6],
  ])
    box(b, 0.006, legTop, 0.006, 0, legTop / 2, z, C(0.9, 0.65, 0.15), p);
  return { geo: b.build(true), rig: new THREE.Vector4(0.025, 0.085, 1.1, legTop) };
}

export function camelModel(): AnimalModel {
  const b = new GeoBuilder();
  const legTop = 0.34;
  ell(b, 0.22, 0.08, 0.075, 0, 0.42, 0, WHITE, 1);
  ell(b, 0.1, 0.085, 0.06, -0.01, 0.49, 0, WHITE, 1); // hump
  box(b, 0.17, 0.05, 0.05, 0.24, 0.42, 0, WHITE, 4, 0.35); // neck, low then up
  box(b, 0.05, 0.14, 0.045, 0.32, 0.5, 0, WHITE, 4);
  box(b, 0.12, 0.05, 0.045, 0.35, 0.57, 0, WHITE, 4); // head
  box(b, 0.02, 0.02, 0.01, 0.31, 0.6, 0.015, WHITE, 4);
  box(b, 0.02, 0.02, 0.01, 0.31, 0.6, -0.015, WHITE, 4);
  // saddle blanket
  box(b, 0.14, 0.03, 0.16, 0.06, 0.47, 0, C(0.65, 0.15, 0.12));
  box(b, 0.015, 0.11, 0.015, -0.22, 0.38, 0, WHITE, 0, -0.2); // tail
  legs(b, 0.15, -0.14, 0.045, legTop, 0.028, WHITE, HOOF);
  return { geo: b.build(true), rig: new THREE.Vector4(0.2, 0.43, 0.9, legTop) };
}

export function goatModel(): AnimalModel {
  const b = new GeoBuilder();
  const legTop = 0.1;
  ell(b, 0.1, 0.048, 0.042, 0, 0.15, 0, WHITE, 1);
  box(b, 0.04, 0.07, 0.035, 0.09, 0.19, 0, WHITE, 4, -0.4); // neck
  box(b, 0.07, 0.035, 0.035, 0.125, 0.22, 0, WHITE, 4, 0.5); // head
  box(b, 0.01, 0.035, 0.012, 0.115, 0.185, 0, DARK, 4); // beard
  box(b, 0.012, 0.05, 0.01, 0.1, 0.255, 0.012, C(0.35, 0.3, 0.25), 4, 0.6); // horns
  box(b, 0.012, 0.05, 0.01, 0.1, 0.255, -0.012, C(0.35, 0.3, 0.25), 4, 0.6);
  box(b, 0.012, 0.04, 0.012, -0.1, 0.18, 0, WHITE, 0, -0.9);
  legs(b, 0.06, -0.06, 0.024, legTop, 0.016, WHITE, HOOF);
  return { geo: b.build(true), rig: new THREE.Vector4(0.08, 0.18, 1.0, legTop) };
}

export function deerModel(): AnimalModel {
  const b = new GeoBuilder();
  const legTop = 0.19;
  ell(b, 0.16, 0.06, 0.05, 0, 0.25, 0, WHITE, 1);
  ell(b, 0.03, 0.035, 0.035, -0.15, 0.27, 0, C(0.95, 0.93, 0.88)); // white rump
  box(b, 0.05, 0.13, 0.04, 0.14, 0.32, 0, WHITE, 4, -0.35); // neck
  box(b, 0.09, 0.04, 0.035, 0.19, 0.38, 0, WHITE, 4, 0.45); // head
  box(b, 0.02, 0.035, 0.012, 0.15, 0.41, 0.025, WHITE, 4); // ears
  box(b, 0.02, 0.035, 0.012, 0.15, 0.41, -0.025, WHITE, 4);
  // antlers
  const ant = C(0.55, 0.45, 0.32);
  for (const s of [1, -1]) {
    box(b, 0.008, 0.08, 0.008, 0.16, 0.45, s * 0.02, ant, 4, 0.2);
    box(b, 0.04, 0.008, 0.008, 0.16, 0.48, s * 0.03, ant, 4, 0.5);
  }
  legs(b, 0.1, -0.1, 0.03, legTop, 0.018, WHITE, HOOF);
  return { geo: b.build(true), rig: new THREE.Vector4(0.12, 0.3, 1.0, legTop) };
}

export function hareModel(): AnimalModel {
  const b = new GeoBuilder();
  const legTop = 0.03;
  ell(b, 0.055, 0.035, 0.03, 0, 0.055, 0, WHITE, 1, 0.25);
  ell(b, 0.028, 0.025, 0.022, 0.05, 0.08, 0, WHITE, 4);
  box(b, 0.012, 0.06, 0.008, 0.04, 0.12, 0.01, WHITE, 4, -0.25); // ears
  box(b, 0.012, 0.06, 0.008, 0.04, 0.12, -0.01, WHITE, 4, -0.25);
  ell(b, 0.012, 0.012, 0.012, -0.055, 0.06, 0, C(0.95, 0.94, 0.9));
  legs(b, 0.03, -0.03, 0.016, legTop, 0.012, WHITE, null);
  return { geo: b.build(true), rig: new THREE.Vector4(0.03, 0.07, 0.6, legTop) };
}

export function catModel(): AnimalModel {
  const b = new GeoBuilder();
  const legTop = 0.04;
  ell(b, 0.055, 0.025, 0.022, 0, 0.058, 0, WHITE, 1);
  ell(b, 0.024, 0.022, 0.022, 0.055, 0.08, 0, WHITE, 4);
  box(b, 0.01, 0.018, 0.01, 0.05, 0.1, 0.012, WHITE, 4); // ears
  box(b, 0.01, 0.018, 0.01, 0.05, 0.1, -0.012, WHITE, 4);
  box(b, 0.008, 0.07, 0.008, -0.06, 0.09, 0, WHITE, 1, 0.35); // tail up
  legs(b, 0.035, -0.035, 0.012, legTop, 0.009, WHITE, null);
  return { geo: b.build(true), rig: new THREE.Vector4(0.04, 0.07, 0.6, legTop) };
}

void DARK;
