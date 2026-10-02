import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Builder } from './registry';
import type { Model, ModelStyle } from './types';

/*
 * Air-dropped supply pallet (airborne-drop support power): a type-V style
 * platform with honeycomb crush pads, an olive cargo bundle of ammunition and
 * medical boxes under a strapped cargo net, and a small team-colour marker
 * panel. Origin on the ground at the pallet centre; forward = +X.
 */

const _c = new THREE.Color();
function tint(g: THREE.BufferGeometry, hex: number) {
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  _c.setHex(hex);
  for (let i = 0; i < n; i++) a.set([_c.r, _c.g, _c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
function bx(w: number, h: number, d: number, x: number, y: number, z: number, hex: number, ry = 0) {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  g.deleteAttribute('uv');
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return tint(g, hex);
}

const cache = new Map<number, THREE.BufferGeometry>();

function crateGeo(team: number) {
  let g = cache.get(team);
  if (g) return g;
  const parts: THREE.BufferGeometry[] = [];
  // aluminium platform and honeycomb crush pads
  parts.push(bx(0.42, 0.025, 0.32, 0, 0.0125, 0, 0x7b7d78));
  for (const z of [-0.11, 0, 0.11]) parts.push(bx(0.4, 0.03, 0.07, 0, 0.04, z, 0xb59b62));
  // cargo bundle: ammunition boxes and a medical chest
  parts.push(bx(0.36, 0.13, 0.27, 0, 0.12, 0, 0x4d5536));
  parts.push(bx(0.17, 0.08, 0.12, -0.08, 0.225, -0.06, 0x56603c));
  parts.push(bx(0.15, 0.08, 0.12, 0.09, 0.225, 0.05, 0x4a5233, 0.1));
  parts.push(bx(0.12, 0.07, 0.1, 0.08, 0.22, -0.08, 0xd9d6c8));
  parts.push(bx(0.07, 0.072, 0.02, 0.08, 0.221, -0.08, 0x2f8a3a)); // green aid stripe
  // cargo straps / net
  for (const x of [-0.12, 0, 0.12]) parts.push(bx(0.018, 0.2, 0.285, x, 0.13, 0, 0x2c2a22));
  parts.push(bx(0.38, 0.2, 0.018, 0, 0.13, 0.0, 0x2c2a22));
  parts.push(bx(0.37, 0.012, 0.28, 0, 0.268, 0, 0x2c2a22));
  // clevis and suspension slings meeting above the load
  parts.push(bx(0.03, 0.03, 0.03, 0, 0.29, 0, 0x8a8a84));
  // team marker panel
  parts.push(bx(0.002, 0.05, 0.1, 0.182, 0.13, 0.06, team));
  parts.push(bx(0.002, 0.05, 0.1, -0.182, 0.13, -0.06, team));
  g = mergeGeometries(parts, false)!;
  g.computeVertexNormals();
  cache.set(team, g);
  return g;
}

let mat: THREE.MeshStandardMaterial | null = null;

function supplyCrate(style: ModelStyle): Model {
  mat ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.1 });
  const mesh = new THREE.Mesh(crateGeo(style.team), mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const root = new THREE.Group();
  root.add(mesh);
  return { root, muzzles: [], height: 0.3, size: { x: 0.42, y: 0.3, z: 0.32 }, glow: [], emitters: [] };
}

/** Model builders keyed by model key (see sim/defs.ts `model` fields). */
export const CARGO: Record<string, Builder> = {
  supplycrate: (style) => supplyCrate(style),
};
