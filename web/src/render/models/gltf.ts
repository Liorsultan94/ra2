import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { FogOfWar } from '../fog';
import type { Model, ModelStyle } from './types';

/*
 * Optional glTF overrides. Drop .glb files in web/public/models/ and list
 * them in web/public/models/manifest.json:
 *
 * [
 *   { "key": "mbt", "faction": "usa", "file": "abrams.glb", "length": 1.0 },
 *   { "key": "power", "file": "power_plant.glb" }
 * ]
 *
 *  key      model key from sim/defs.ts (mbt, apc, heli, fighter, power, ...)
 *  faction  optional: only for this nation (otherwise every nation)
 *  length   optional: target size along the longest horizontal axis in tiles
 *           (buildings default to their footprint, units to a sensible size)
 *  rotateY  optional: extra rotation in degrees so the model faces +X
 *
 * Node names: a node called "turret" rotates with the turret; nodes whose
 * names start with "muzzle" are used as muzzle points; materials whose name
 * contains "team" are tinted with the player colour.
 */

interface Entry {
  key: string;
  faction?: string;
  file: string;
  length?: number;
  rotateY?: number;
}

const loaded = new Map<string, { scene: THREE.Group; entry: Entry }>();

const DEFAULT_LENGTH: Record<string, number> = {
  rifle: 0.36, at: 0.36, engineer: 0.36, mortar: 0.4, fpvteam: 0.36, ewinf: 0.36, sniper: 0.36, medic: 0.36,
  mbt: 1.05, mbt_heavy: 1.1, apc: 0.95, aa: 0.95, laser: 0.95, arty: 1.1, tos: 1.05, ew: 1.1, berge: 1.05,
  ugv: 0.6, robodog: 0.45, swarm: 1.0, missile_truck: 1.25, container: 1.15, harvester: 1.15, mcv: 1.25,
  uav: 0.9, heavy_uav: 1.2, jet: 1.1, fighter: 1.1, heli: 1.0, fpv: 0.18, micro: 0.16, shahed: 0.5,
};

export async function loadModelOverrides(base: string): Promise<number> {
  let entries: Entry[] = [];
  try {
    const res = await fetch(`${base}models/manifest.json`, { cache: 'no-cache' });
    if (!res.ok) return 0;
    entries = await res.json();
  } catch {
    return 0;
  }
  const loader = new GLTFLoader();
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const gltf = await loader.loadAsync(`${base}models/${entry.file}`);
        loaded.set(entry.faction ? `${entry.faction}:${entry.key}` : entry.key, { scene: gltf.scene, entry });
      } catch (e) {
        console.warn('model override failed', entry.file, e);
      }
    }),
  );
  return loaded.size;
}

export function overrideModel(key: string, style: ModelStyle, fog: FogOfWar | null, footprint?: { w: number; h: number }): Model | null {
  const hit = loaded.get(`${style.faction}:${key}`) ?? loaded.get(key);
  if (!hit) return null;
  const inner = cloneSkinned(hit.scene) as THREE.Group;
  if (hit.entry.rotateY) inner.rotation.y = (hit.entry.rotateY * Math.PI) / 180;
  const holder = new THREE.Group();
  holder.add(inner);
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  const target = footprint ? Math.min(footprint.w, footprint.h) * 0.95 : hit.entry.length ?? DEFAULT_LENGTH[key] ?? 1;
  const s = target / Math.max(1e-6, footprint ? Math.max(size.x, size.z) : Math.max(size.x, size.z));
  inner.scale.multiplyScalar(s);
  holder.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(holder);
  const c = b2.getCenter(new THREE.Vector3());
  inner.position.x -= c.x;
  inner.position.z -= c.z;
  inner.position.y -= b2.min.y;
  const root = new THREE.Group();
  root.add(holder);
  let turret: THREE.Object3D | undefined;
  const muzzles: THREE.Object3D[] = [];
  const team = new THREE.Color(style.team);
  inner.traverse((o) => {
    const n = o.name.toLowerCase();
    if (!turret && n === 'turret') turret = o;
    if (n.startsWith('muzzle')) muzzles.push(o);
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = mesh.receiveShadow = true;
      const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) => {
        const mm = m.clone() as THREE.MeshStandardMaterial;
        if (mm.name.toLowerCase().includes('team') && mm.color) mm.color.copy(team);
        if (fog) fog.apply(mm);
        return mm;
      });
      mesh.material = Array.isArray(mesh.material) ? mats : mats[0];
    }
  });
  const sz = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  return { root, turret, muzzles, height: sz.y, size: { x: sz.x, y: sz.y, z: sz.z }, glow: [], emitters: [] };
}
