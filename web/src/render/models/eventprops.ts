import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Builder } from './registry';
import type { Model } from './types';

/*
 * Side-event props (sim/sideevents.ts): the crashed aircraft with intel aboard.
 * A twin-engine transport broken behind the wing: scorched fuselage halves, one
 * wing torn off and lying apart, the tail fin, a furrow of churned earth and
 * scattered panels. The renderer adds smoke and flames (the wreck's low hp).
 * Origin on the ground at the crash centre; forward = +X. One merged mesh.
 */

const _c = new THREE.Color();
function tint(g: THREE.BufferGeometry, hex: number) {
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  _c.setHex(hex);
  for (let i = 0; i < n; i++) a.set([_c.r, _c.g, _c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  g.deleteAttribute('uv');
  return g;
}

function place(g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
  g.applyMatrix4(m);
  g.translate(x, y, z);
  return g;
}

let geo: THREE.BufferGeometry | null = null;

function wreckGeo() {
  if (geo) return geo;
  const P: THREE.BufferGeometry[] = [];
  const HULL = 0x55594e;
  const SCORCH = 0x24221f;
  const DIRT = 0x4a3c2c;
  // furrow of churned earth behind the wreck
  P.push(tint(place(new THREE.BoxGeometry(1.5, 0.04, 0.34).toNonIndexed(), -0.95, 0.02, 0.05, 0, 0.08), DIRT));
  P.push(tint(place(new THREE.BoxGeometry(0.5, 0.07, 0.42).toNonIndexed(), -0.2, 0.035, 0.02, 0, 0.1), DIRT));
  // front fuselage: nose down, rolled a little
  const f1 = new THREE.CylinderGeometry(0.12, 0.13, 0.62, 10, 1, true).toNonIndexed();
  P.push(tint(place(f1, 0.3, 0.12, 0, 0.12, 0, Math.PI / 2 + 0.12), HULL));
  const nose = new THREE.ConeGeometry(0.12, 0.2, 10).toNonIndexed();
  P.push(tint(place(nose, 0.69, 0.07, 0, 0, 0, -Math.PI / 2 + 0.12), HULL));
  // broken rear fuselage, twisted away
  const f2 = new THREE.CylinderGeometry(0.11, 0.07, 0.55, 10, 1, true).toNonIndexed();
  P.push(tint(place(f2, -0.38, 0.1, 0.12, 0, 0.45, Math.PI / 2 - 0.05), SCORCH));
  // tail fin
  P.push(tint(place(new THREE.BoxGeometry(0.2, 0.24, 0.025).toNonIndexed(), -0.6, 0.24, 0.23, 0.2, 0.45, 0.25), HULL));
  P.push(tint(place(new THREE.BoxGeometry(0.16, 0.02, 0.32).toNonIndexed(), -0.6, 0.12, 0.23, 0, 0.45, 0), HULL));
  // the wing still attached (one side, drooping) and the other one torn off
  P.push(tint(place(new THREE.BoxGeometry(0.26, 0.025, 0.72).toNonIndexed(), 0.18, 0.13, -0.42, 0.12, 0, 0), HULL));
  P.push(tint(place(new THREE.BoxGeometry(0.24, 0.025, 0.6).toNonIndexed(), 0.05, 0.03, 0.75, -0.06, -0.5, 0.05), SCORCH));
  // engine nacelles
  P.push(tint(place(new THREE.CylinderGeometry(0.05, 0.055, 0.22, 8).toNonIndexed(), 0.28, 0.1, -0.3, 0, 0, Math.PI / 2), SCORCH));
  P.push(tint(place(new THREE.CylinderGeometry(0.05, 0.055, 0.2, 8).toNonIndexed(), 0.4, 0.04, 0.48, 0.3, 0.6, Math.PI / 2), SCORCH));
  // scattered panels
  const bits: [number, number, number, number][] = [
    [-0.15, 0.5, 0.9, 0.12],
    [0.9, -0.4, 0.4, 0.1],
    [-1.1, -0.35, 1.7, 0.09],
    [0.55, 0.62, 2.4, 0.08],
    [-0.75, 0.55, 0.3, 0.07],
  ];
  for (const [x, z, r, s] of bits) P.push(tint(place(new THREE.BoxGeometry(s * 1.4, 0.02, s).toNonIndexed(), x, 0.015, z, 0, r, 0.1), r > 1 ? SCORCH : HULL));
  geo = mergeGeometries(P, false)!;
  geo.computeVertexNormals();
  return geo;
}

let mat: THREE.MeshStandardMaterial | null = null;

function wreck(): Model {
  mat ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.2, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(wreckGeo(), mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const root = new THREE.Group();
  root.add(mesh);
  return {
    root,
    muzzles: [],
    height: 0.35,
    size: { x: 1.6, y: 0.35, z: 1.4 },
    glow: [],
    emitters: [
      { pos: new THREE.Vector3(0.05, 0.2, -0.1), kind: 'fire' },
      { pos: new THREE.Vector3(-0.35, 0.18, 0.1), kind: 'smoke' },
    ],
  };
}

/** Model builders keyed by model key (sim/sideevents.ts defs). */
export const EVENT_PROPS: Record<string, Builder> = {
  ev_wreck: () => wreck(),
};
