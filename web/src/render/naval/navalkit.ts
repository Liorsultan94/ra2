import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { FogOfWar } from '../fog';
import { BuildFx, FxTpl, newRec } from '../models/buildfx';
import type { AnimState, Model, ModelStyle } from '../models/types';
import { registerLods } from '../perf/lod';
import { assetBase } from '../photoground';
import { Tile, WATER_LEVEL, type GameMap } from '../../sim/map';
import { carrierJet, carrierShip, type CarrierKit } from './carriers';
import { diverModel } from './diver';
import { subModel } from './subs';

/*
 * NV1 naval kit (render only): the Shipyard and every nation's boats, built in Blender (tools/blender/naval/navalkit.py
 * -> public/models/naval/naval.glb + the hall's tiled maps).
 *
 * Per vertex: the albedo with baked ambient occlusion (team-coloured / textured parts: the occlusion only). Materials go
 * by the glTF material name: paint, team (the player colour), glass, lamp (running / flood lights), rust / glaze / solar
 * (the hall's corrugated rust, roof glazing and solar panels, tiled maps). Every mesh "<name>" has a far level of detail
 * "<name>_l1" (perf/lod.ts swaps them by on-screen size).
 *
 * Boats float: an inner group bobs, rolls and pitches with the sea, the speed (bow up on the plane) and the turns
 * (heel), and sinks when the boat dies (AnimState.dead: down by the bow or the stern, listing, under in ~9 s). The
 * Shipyard reuses the buildings' construction / damage system (buildfx.ts): it rises from its foundations behind
 * scaffolding, takes roof holes and soot, and shows a hull on its slipway (and its gantry's crab travelling) while it
 * builds a boat (AnimState.busy).
 *
 * The kit loads in the background when a match on a map with sea starts (renderer.ts): the Shipyard and the two
 * nations' boats only (a small file each). A model asked for before it arrives falls back to a plain procedural
 * boat / yard so nothing is ever missing.
 */

interface Kit {
  /** Loaded files: 'shipyard' and the nations' boats. */
  scenes: THREE.Group[];
  tex: Record<'rust' | 'rustN' | 'glaze' | 'solar', THREE.Texture | null>;
  info: Record<string, { tris: number; len?: number; beam?: number; h?: number; turret?: boolean; fans?: number; spin?: boolean }> & { yard_lamps?: number[][] };
}

let kit: Kit | null = null;
const files = new Map<string, Promise<boolean>>();
let common: Promise<boolean> | null = null;

async function texture(url: string, srgb: boolean): Promise<THREE.Texture | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const t = new THREE.Texture(bmp);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4;
    t.flipY = false;
    t.needsUpdate = true;
    return t;
  } catch {
    return null;
  }
}

/** UV scale (repeats per tile) of the hall's tiled maps, as the Blender preview maps them. */
const UVK: Record<string, number> = { rust: 2, glaze: 6, solar: 4 };

/** Planar UVs by each vertex's dominant normal axis (in tiles x UVK): the hall's tiled maps. */
function planarUV(g: THREE.BufferGeometry, k: number) {
  const P = g.attributes.position;
  const N = g.attributes.normal;
  const uv = new Float32Array(P.count * 2);
  for (let i = 0; i < P.count; i++) {
    const nx = Math.abs(N.getX(i));
    const ny = Math.abs(N.getY(i));
    const nz = Math.abs(N.getZ(i));
    const x = P.getX(i);
    const y = P.getY(i);
    const z = P.getZ(i);
    // (game axes, y up: walls facing +-z show x / y, walls facing +-x show z / y, roofs x / z)
    const [u, v] = ny >= nx && ny >= nz ? [x, z] : nz >= nx ? [x, y] : [z, y];
    uv[i * 2] = u * k;
    uv[i * 2 + 1] = v * k;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Prepare a loaded file: UVs for the tiled maps, LOD pairs registered ("<name>" / "<name>_l1", matched by material). */
function prepare(scene: THREE.Group) {
  scene.updateMatrixWorld(true);
  const byName = new Map<string, THREE.Object3D>();
  scene.traverse((o) => byName.set(o.name, o));
  const prims = (n: THREE.Object3D) => {
    const out: THREE.Mesh[] = [];
    if ((n as THREE.Mesh).isMesh) out.push(n as THREE.Mesh);
    for (const c of n.children) if ((c as THREE.Mesh).isMesh) out.push(c as THREE.Mesh);
    return out;
  };
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mn = (m.material as THREE.Material).name.replace(/\.\d+$/, '');
    if (UVK[mn] && !m.geometry.attributes.uv) planarUV(m.geometry, UVK[mn]);
  });
  for (const [name, o] of byName) {
    if (name.endsWith('_l1')) continue;
    const l1 = byName.get(name + '_l1');
    if (!l1) continue;
    const lo = prims(l1);
    for (const m of prims(o)) {
      const mn = (m.material as THREE.Material).name;
      const f = lo.find((x) => (x.material as THREE.Material).name === mn);
      if (f) registerLods(m.geometry, [f.geometry, f.geometry]);
    }
  }
}

/**
 * Load the naval kit for a match on a map with sea: the Shipyard, the hall's maps and the boats of the nations
 * playing (one small file each). Resolves true once all have arrived (false if any failed: plain models).
 */
export function loadNavalKit(nations: string[] = []): Promise<boolean> {
  const base = `${assetBase()}models/naval/`;
  common ??= (async () => {
    try {
      const [info, rust, rustN, glaze, solar] = await Promise.all([
        fetch(`${base}naval.json`).then((r) => (r.ok ? r.json() : {})),
        texture(`${base}naval-rust.webp`, true),
        texture(`${base}naval-rust-n.webp`, false),
        texture(`${base}naval-glaze.webp`, true),
        texture(`${base}naval-solar.webp`, true),
      ]);
      kit = { scenes: [], tex: { rust, rustN, glaze, solar }, info: info as Kit['info'] };
      return true;
    } catch (e) {
      console.warn('[naval] naval kit unavailable, plain models', e);
      return false;
    }
  })();
  const one = (g: string) => {
    let p = files.get(g);
    if (!p) {
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      p = loader
        .loadAsync(`${base}naval-${g}.glb`)
        .then(async (gltf) => {
          await common;
          if (!kit) return false;
          prepare(gltf.scene);
          kit.scenes.push(gltf.scene);
          return true;
        })
        .catch((e) => {
          console.warn('[naval] kit file unavailable, plain models', g, e);
          return false;
        });
      files.set(g, p);
    }
    return p;
  };
  // (and the aircraft carrier and its deck jet of the nations that have one: naval-cv<nation>.glb, carriers.ts)
  const cv = [...new Set(nations)].filter((n) => CARRIER_NATIONS.has(n)).map((n) => `cv${n}`);
  return Promise.all(['shipyard', 'diver', 'sub', ...new Set(nations), ...cv].map(one)).then((r) => r.every(Boolean));
}

function findTemplate(name: string): THREE.Object3D | null {
  for (const sc of kit?.scenes ?? []) {
    const o = sc.getObjectByName(name);
    if (o) return o;
  }
  return null;
}

export function navalKitReady(): boolean {
  return !!kit;
}

/** The nations with an aircraft carrier (NV2). */
const CARRIER_NATIONS = new Set(['usa', 'russia', 'china']);

/** The kit as carriers.ts uses it. */
const carrierKit: CarrierKit = {
  instance: (name, style, fog) => instance(name, style, fog),
  info: (name) => (kit?.info as Record<string, Record<string, unknown>> | undefined)?.[name],
};

// ------------------------------------------------------------------ materials

const matCache = new Map<string, Record<string, THREE.Material>>();

function materials(style: ModelStyle, fog: FogOfWar | null): Record<string, THREE.Material> {
  const key = `${style.team}|${fog ? 'f' : 'n'}`;
  let m = matCache.get(key);
  if (m) return m;
  const t = kit?.tex;
  const std = (o: THREE.MeshStandardMaterialParameters, name: string) => {
    const mm = new THREE.MeshStandardMaterial({ vertexColors: true, ...o });
    mm.name = name;
    return fog ? fog.apply(mm) : mm;
  };
  const lamp = new THREE.MeshBasicMaterial({ vertexColors: true });
  lamp.name = 'lamp';
  m = {
    paint: std({ roughness: 0.66, metalness: 0.22 }, 'paint'),
    team: std({ color: style.team, roughness: 0.5, metalness: 0.25 }, 'team'),
    glass: std({ roughness: 0.12, metalness: 0.55 }, 'glass'),
    lamp: fog ? fog.apply(lamp) : lamp,
    rust: std({ map: t?.rust ?? null, normalMap: t?.rustN ?? null, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.82, metalness: 0.3 }, 'rust'),
    glaze: std({ map: t?.glaze ?? null, roughness: 0.18, metalness: 0.5 }, 'glaze'),
    solar: std({ map: t?.solar ?? null, roughness: 0.22, metalness: 0.45 }, 'solar'),
  };
  matCache.set(key, m);
  return m;
}

/** A copy of a kit model with the style's materials; its far LOD siblings dropped (perf/lod.ts swaps geometry). */
function instance(name: string, style: ModelStyle, fog: FogOfWar | null): THREE.Object3D | null {
  const src = kit ? findTemplate(name) : null;
  if (!src) return null;
  const c = src.clone(true);
  const drop: THREE.Object3D[] = [];
  const M = materials(style, fog);
  c.traverse((o) => {
    if (o.name.endsWith('_l1')) drop.push(o);
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mn = (mesh.material as THREE.Material).name.replace(/\.\d+$/, '');
    mesh.material = M[mn] ?? M.paint;
    mesh.castShadow = mn !== 'lamp' && mn !== 'glass';
    mesh.receiveShadow = true;
  });
  for (const o of drop) o.removeFromParent();
  return c;
}

// ------------------------------------------------------------------ boats

/** Local running lights of a boat for the night pools (night.ts): position and colour. */
export interface RunLight {
  pos: THREE.Vector3;
  color: number;
}

/** Plain boat until the kit has loaded (a hull, a deckhouse, a team stripe). */
function fallbackBoat(key: string, style: ModelStyle, fog: FogOfWar | null): Model {
  const L = key.endsWith('corvette') ? 1.45 : key.endsWith('lander') ? 1.1 : 0.85;
  const B = L * 0.22;
  const root = new THREE.Group();
  const bob = new THREE.Group();
  root.add(bob);
  const mk = (c: number) => {
    const m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.7, metalness: 0.2 });
    return fog ? fog.apply(m) : m;
  };
  const hull = new THREE.Mesh(new THREE.BoxGeometry(L, 0.1, B), mk(0x7d858b));
  hull.position.y = 0.02;
  const house = new THREE.Mesh(new THREE.BoxGeometry(L * 0.3, 0.08, B * 0.7), mk(0x8e959a));
  house.position.set(-L * 0.05, 0.11, 0);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(L * 0.26, 0.012, B * 0.72), mk(style.team));
  stripe.position.set(-L * 0.05, 0.155, 0);
  bob.add(hull, house, stripe);
  return { root, muzzles: [], height: 0.2, size: { x: L, y: 0.2, z: B }, glow: [], emitters: [], anim: boatAnim(bob, L, null, [], null) };
}

/**
 * Sea motion and the sinking (dead > 0). `spin`: the radar to turn; `fans`: hovercraft propellers (about local X).
 */
function boatAnim(bob: THREE.Group, L: number, spin: THREE.Object3D | null, fans: THREE.Object3D[], turret: THREE.Object3D | null) {
  let roll = 0;
  let pitch = 0;
  let sinkSide = 0;
  return (s: AnimState) => {
    const t = s.time;
    const ph = (s.seed ?? 0) * 1.618;
    const v = Math.min(1, s.speed / 3);
    if (s.dead > 0) {
      // going down: the burning hull settles by the stern (or the bow), lists over and slips under in ~9 s
      if (!sinkSide) sinkSide = ((s.seed ?? 1) % 2 ? 1 : -1) * (0.7 + ((s.seed ?? 0) % 5) * 0.08);
      const k = Math.min(1, s.dead / 9);
      bob.position.y = -k * k * 0.6 - k * 0.05;
      bob.rotation.z = sinkSide * (0.05 + k * 0.42);
      bob.rotation.x = sinkSide * k * 0.35 + Math.sin(t * 0.9 + ph) * 0.015;
      return;
    }
    // the swell, the bow lifting onto the plane with speed, a heel into turns
    const swell = Math.sin(t * 1.25 + ph) * 0.006 + Math.sin(t * 2.1 + ph * 0.7) * 0.003;
    roll += (Math.sin(t * 0.85 + ph) * 0.022 - Math.max(-0.12, Math.min(0.12, s.turn * 0.09)) - roll) * Math.min(1, s.dt * 3);
    pitch += (Math.sin(t * 1.1 + ph * 1.3) * 0.014 + v * (0.05 + 0.02 / Math.max(0.6, L)) - pitch) * Math.min(1, s.dt * 2.5);
    bob.position.y = swell + v * 0.012;
    bob.rotation.x = roll;
    bob.rotation.z = pitch;
    if (spin) spin.rotation.y += s.dt * 2.6;
    for (const f of fans) f.rotation.x += s.dt * (8 + 26 * v);
    void turret;
  };
}

/** A boat's model from the kit (or the plain fallback). */
export function navalBoat(key: string, style: ModelStyle, fog: FogOfWar | null): Model {
  const inst = instance(key, style, fog);
  if (!inst) return fallbackBoat(key, style, fog);
  const info = kit!.info[key] ?? { tris: 0 };
  const root = new THREE.Group();
  const bob = new THREE.Group();
  root.add(bob);
  bob.add(inst);
  inst.position.set(0, 0, 0);
  const turret = inst.getObjectByName(`${key}_turret`) ?? undefined;
  const spin = inst.getObjectByName(`${key}_spin`) ?? null;
  const fans: THREE.Object3D[] = [];
  for (let i = 0; i < 4; i++) {
    const f = inst.getObjectByName(`${key}_fan${i}`);
    if (f) fans.push(f);
  }
  const muzzle = inst.getObjectByName(`muzzle_${key}`);
  const L = info.len ?? 1;
  const B = info.beam ?? 0.25;
  const H = info.h ?? 0.25;
  // running lights for the night pools: port red, starboard green, a white masthead (local, game axes)
  const lights: RunLight[] = [
    { pos: new THREE.Vector3(0, H * 0.45, -B / 2), color: 0xff3a2a },
    { pos: new THREE.Vector3(0, H * 0.45, B / 2), color: 0x3aff6a },
    { pos: new THREE.Vector3(-L * 0.05, H, 0), color: 0xfff2dc },
  ];
  root.userData.runLights = lights;
  root.userData.naval = true;
  return {
    root,
    turret,
    muzzles: muzzle ? [muzzle] : [],
    height: H,
    size: { x: L, y: H, z: B },
    glow: [],
    emitters: [
      // engine exhaust aft (smoke only while moving)
      { pos: new THREE.Vector3(-L * 0.45, H * 0.35, 0), kind: 'smoke' },
    ],
    damageFx: [
      { pos: new THREE.Vector3(0, H * 0.6, 0), kind: 'smoke', at: 0.35 },
      { pos: new THREE.Vector3(-L * 0.2, H * 0.4, 0), kind: 'fire', at: 0.7 },
    ],
    anim: boatAnim(bob, L, spin, fans, turret ?? null),
  };
}

// ------------------------------------------------------------------ the Shipyard

const yardTpl = new Map<string, FxTpl>();

/** Shipyard model (4 x 4 tiles, slipway / water towards +X; the renderer turns it to the water: Entity.slip). */
export function navalShipyard(style: ModelStyle, fog: FogOfWar | null): Model {
  const inst = instance('shipyard', style, fog);
  const root = new THREE.Group();
  if (!inst) return fallbackYard(style, fog);
  root.add(inst);
  const hull = inst.getObjectByName('shipyard_hull');
  const trolley = inst.getObjectByName('shipyard_trolley');
  // construction / damage: the buildings' system, on a template analysed once per style (buildfx.ts)
  const tk = `${style.team}|${style.region}|${fog ? 1 : 0}`;
  let tpl = yardTpl.get(tk);
  if (!tpl) {
    const rec = newRec();
    // the hall's walls (x0, y0, z0, x1, y1, z1, game axes) for the damage bites, the floodlights
    rec.walls.push(-1.95, 0, -0.9, 0.7, 0.78, 0.9);
    rec.walls.push(-1.9, 0, 0.93, -0.35, 0.42, 1.48);
    for (const [x, y, z] of kit!.info.yard_lamps ?? []) rec.lamps.push(x, y, z, 1, 0.94, 0.82);
    const tr = (inst.clone(true) as THREE.Group);
    tr.getObjectByName('shipyard_hull')?.removeFromParent();
    tr.getObjectByName('shipyard_trolley')?.removeFromParent();
    tpl = new FxTpl(tr, rec, { key: 'shipyard', w: 4, d: 4, height: 1.35, region: style.region, fog, seed: 17 });
    yardTpl.set(tk, tpl);
  }
  const bfx = new BuildFx(tpl, root);
  let busyK = 0;
  const t0 = trolley ? trolley.position.z : 0;
  if (hull) {
    hull.visible = false;
    // (the kit puts the hull mostly inside the hall, under its roof: slide it down the slipway, out under the gantry
    // where it can be seen, lying along the ramp on its cradle, its far end just in the water)
    hull.position.x += 0.72;
    hull.position.y -= 0.2;
    hull.rotation.z -= 0.19;
  }
  const anim = (s: AnimState) => {
    bfx.update(s);
    if (s.built < 1) {
      if (hull) hull.visible = false;
      return;
    }
    busyK += ((s.busy ? 1 : 0) - busyK) * Math.min(1, s.dt * 0.8);
    if (hull) {
      // the hull on the slipway takes shape while a boat is being built (and is gone once she is launched)
      hull.visible = busyK > 0.02;
      hull.scale.set(1, Math.max(0.02, busyK), 1);
    }
    // the gantry's crab travels to and fro over the hull while it works
    if (trolley) trolley.position.z = t0 + Math.sin(s.time * 0.35) * 0.8 * busyK;
  };
  return {
    root,
    muzzles: [],
    height: 1.35,
    size: { x: 4, y: 1.35, z: 4 },
    glow: [],
    emitters: [],
    anim,
    damageFx: bfx.damageFx,
    nightLights: tpl.night,
  };
}

function fallbackYard(style: ModelStyle, fog: FogOfWar | null): Model {
  const root = new THREE.Group();
  const mk = (c: number) => {
    const m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 });
    return fog ? fog.apply(m) : m;
  };
  const hall = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.8, 1.8), mk(0x8c3a1c));
  hall.position.set(-0.6, 0.4, 0);
  const pier = new THREE.Mesh(new THREE.BoxGeometry(4, 0.3, 4), mk(0xa9a49a));
  pier.position.y = -0.15;
  const band = new THREE.Mesh(new THREE.BoxGeometry(2.62, 0.06, 1.82), mk(style.team));
  band.position.set(-0.6, 0.78, 0);
  root.add(hall, pier, band);
  return { root, muzzles: [], height: 1, size: { x: 4, y: 1, z: 4 }, glow: [], emitters: [] };
}

/** Builders by model key: 'shipyard' and every 'nv_*' boat. */
export function navalModel(key: string, style: ModelStyle, fog: FogOfWar | null): Model | null {
  if (key === 'shipyard') return navalShipyard(style, fog);
  if (key.startsWith('cv_')) {
    // an aircraft carrier or its deck jet (carriers.ts); its file on demand as for the boats
    if (common) void loadNavalKit([key.split('_')[1]]);
    return key.endsWith('_jet') ? carrierJet(key, style, fog, kit ? carrierKit : null) : carrierShip(key, style, fog, kit ? carrierKit : null);
  }
  if (key.startsWith('sm_')) {
    // a submarine (NV4, subs.ts); its file loads with the Shipyard's
    if (common) void loadNavalKit();
    return subModel(key, style, fog, kit ? carrierKit : null);
  }
  if (key === 'dv_diver') {
    // the Combat Diver (NV3, diver.ts); its file loads with the Shipyard's
    if (common) void loadNavalKit();
    return diverModel(style, fog, kit ? carrierKit : null);
  }
  if (key.startsWith('nv_')) {
    // (a match loads its players' nations; a boat of another nation, say one spawned in by a script, fetches its
    // file now: this one is the plain boat, the next ones the real model. Cached, so a no-op once loaded)
    if (common) void loadNavalKit([key.split('_')[1]]);
    return navalBoat(key, style, fog);
  }
  return null;
}

/**
 * Height of a Shipyard's quay deck (its model's ground plane): level with the highest land of its footprint, never
 * below the waterline (the piers and the slipway run on down into the sea).
 */
export function shipyardDeck(m: GameMap, tx: number, ty: number, w: number, h: number): number {
  let top = -Infinity;
  for (let y = ty; y < ty + h; y++)
    for (let x = tx; x < tx + w; x++) {
      if (m.tiles[y * m.w + x] === Tile.Water) continue;
      const W1 = m.w + 1;
      const H = m.heights;
      const i = y * W1 + x;
      top = Math.max(top, (H[i] + H[i + 1] + H[i + W1] + H[i + W1 + 1]) * 0.25);
    }
  return Math.max(Number.isFinite(top) ? top : WATER_LEVEL, WATER_LEVEL + 0.12);
}
