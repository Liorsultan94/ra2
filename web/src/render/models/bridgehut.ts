import * as THREE from 'three';
import type { FogOfWar } from '../fog';
import type { Builder } from './registry';
import type { Model } from './types';

/*
 * Models for the collapsible-bridge entities (sim/bridges.ts):
 *  - 'bridge': the targetable deck anchor. The bridge itself is drawn and
 *    animated by render/bridgefx.ts, so this model is empty (it only carries
 *    the health bar / selection height). A never-firing damage point keeps
 *    the renderer's generic building smoke off the river bed.
 *  - 'bridgehut': the small engineer repair hut at each bridge end
 *    (RA2 style): concrete block house, flat roof, door, vent and antenna.
 */

const mats = new Map<string, THREE.Material>();
function mat(key: string, fog: FogOfWar | null, make: () => THREE.MeshStandardMaterial) {
  let m = mats.get(key);
  if (!m) {
    m = fog ? fog.apply(make()) : make();
    mats.set(key, m);
  }
  return m;
}

function box(parent: THREE.Object3D, m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, ry = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.rotation.y = ry;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

const bridgeAnchor: Builder = () => {
  const root = new THREE.Group();
  root.name = 'bridgeAnchor';
  return {
    root,
    muzzles: [],
    height: 1.25,
    size: { x: 0.01, y: 0.01, z: 0.01 },
    glow: [],
    emitters: [],
    damageFx: [{ pos: new THREE.Vector3(), kind: 'smoke', at: 9 }],
  } satisfies Model;
};

const bridgeHut: Builder = (_style, fog) => {
  const root = new THREE.Group();
  root.name = 'bridgeHut';
  const concrete = mat('conc', fog, () => new THREE.MeshStandardMaterial({ color: 0xb8b2a4, roughness: 0.92 }));
  const dark = mat('dark', fog, () => new THREE.MeshStandardMaterial({ color: 0x4a4c4e, roughness: 0.7, metalness: 0.3 }));
  const roof = mat('roof', fog, () => new THREE.MeshStandardMaterial({ color: 0x5c5a56, roughness: 0.85 }));
  const door = mat('door', fog, () => new THREE.MeshStandardMaterial({ color: 0x3f5a46, roughness: 0.6, metalness: 0.4 }));
  const sign = mat('sign', fog, () => new THREE.MeshStandardMaterial({ color: 0xe0b020, roughness: 0.5, emissive: 0x281c00 }));
  const lamp = mat('lamp', fog, () => new THREE.MeshStandardMaterial({ color: 0xffd080, emissive: 0xffa030, emissiveIntensity: 1.2 }));
  // plinth, walls, roof slab with a lip
  box(root, concrete, 0.74, 0.06, 0.62, 0, 0.03, 0);
  box(root, concrete, 0.62, 0.42, 0.5, 0, 0.27, 0);
  box(root, roof, 0.7, 0.06, 0.58, 0, 0.51, 0);
  box(root, dark, 0.66, 0.03, 0.54, 0, 0.555, 0);
  // door on the front (+Z), small window on the side, hazard sign
  box(root, door, 0.2, 0.3, 0.02, -0.12, 0.21, 0.251);
  box(root, dark, 0.03, 0.03, 0.03, -0.04, 0.2, 0.265);
  box(root, dark, 0.02, 0.1, 0.18, 0.311, 0.32, 0);
  box(root, sign, 0.16, 0.12, 0.012, 0.14, 0.3, 0.256);
  // roof vent, antenna mast and a small work lamp over the door
  box(root, dark, 0.14, 0.1, 0.14, 0.16, 0.62, -0.1);
  const mast = box(root, dark, 0.02, 0.5, 0.02, -0.22, 0.8, -0.18);
  mast.castShadow = false;
  box(root, dark, 0.12, 0.012, 0.012, -0.22, 0.98, -0.18);
  box(root, lamp, 0.06, 0.03, 0.04, -0.12, 0.4, 0.27);
  // cable reel and sand bags by the wall
  const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.08, 10), dark);
  reel.rotation.x = Math.PI / 2;
  reel.position.set(0.26, 0.09, 0.3);
  root.add(reel);
  for (let i = 0; i < 3; i++) box(root, mat('bag', fog, () => new THREE.MeshStandardMaterial({ color: 0x8a7a58, roughness: 1 })), 0.12, 0.05, 0.07, -0.3 + i * 0.11, 0.035, -0.31, i * 0.2);
  return {
    root,
    muzzles: [],
    height: 0.75,
    size: { x: 0.74, y: 0.6, z: 0.62 },
    glow: [lamp],
    emitters: [],
    damageFx: [{ pos: new THREE.Vector3(), kind: 'smoke', at: 9 }],
  } satisfies Model;
};

export const BRIDGE_MODELS: Record<string, Builder> = {
  bridge: bridgeAnchor,
  bridgehut: bridgeHut,
};
