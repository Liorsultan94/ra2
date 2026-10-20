import * as THREE from 'three';
import type { FogOfWar } from '../fog';
import type { AnimState, Model, ModelStyle } from '../models/types';

/*
 * NV2 aircraft carriers and their deck jets (render only), from the Blender carrier kit
 * (tools/blender/naval/carrierkit.py -> public/models/naval/naval-cv<nation>.glb), built to the sim's flight deck
 * layout (sim/airbase.ts DECK): the deck jets the sim parks, launches and lands on the deck stand on it here.
 *
 * The carrier: barely any swell (a big ship; the jets on its deck must not float off it), the radar turning, the jet
 * blast deflector behind the launch position rising while a jet launches (AnimState.busy), gentle deck-edge and
 * island lights by night, and the long slow sinking when it is lost. The deck jet: its gear, the outer wing panels
 * folding up while it stands parked on the deck (and spreading again before it taxis), a bank into turns.
 */

/** The flight deck's height above the waterline (tiles; the kit's DECK_Z). */
export const DECK_Z = 0.28;

export interface CarrierKit {
  instance(name: string, style: ModelStyle, fog: FogOfWar | null): THREE.Object3D | null;
  info(name: string): Record<string, unknown> | undefined;
}

function std(color: number, fog: FogOfWar | null): THREE.Material {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.2 });
  return fog ? fog.apply(m) : m;
}

/** A plain carrier until the kit has loaded: a hull, a flight deck, an island. */
function fallbackCarrier(style: ModelStyle, fog: FogOfWar | null): Model {
  const root = new THREE.Group();
  const bob = new THREE.Group();
  root.add(bob);
  const hull = new THREE.Mesh(new THREE.BoxGeometry(4.9, 0.24, 0.86), std(0x7d858b, fog));
  hull.position.y = 0.12;
  const deck = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.03, 1.25), std(0x3c3f42, fog));
  deck.position.y = DECK_Z - 0.015;
  const isl = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.42, 0.18), std(0x8e959a, fog));
  isl.position.set(-0.7, DECK_Z + 0.21, 0.6);
  const band = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.04, 0.19), std(style.team, fog));
  band.position.set(-0.7, DECK_Z + 0.38, 0.6);
  bob.add(hull, deck, isl, band);
  return { root, muzzles: [], height: 0.7, size: { x: 5.2, y: 0.7, z: 1.3 }, glow: [], emitters: [], anim: carrierAnim(bob, null, null) };
}

function carrierAnim(bob: THREE.Group, spin: THREE.Object3D | null, jbd: THREE.Object3D | null) {
  let raise = 0;
  let sinkSide = 0;
  return (s: AnimState) => {
    const t = s.time;
    const ph = (s.seed ?? 0) * 1.618;
    if (s.dead > 0) {
      // going down slowly by the bow, listing; under in ~9 s (the renderer's sinking wreck)
      if (!sinkSide) sinkSide = (s.seed ?? 1) % 2 ? 1 : -1;
      const k = Math.min(1, s.dead / 9);
      bob.position.y = -k * k * 0.75;
      bob.rotation.x = sinkSide * k * 0.22;
      bob.rotation.z = -k * 0.12;
      return;
    }
    // (a big ship: the swell barely moves it, and the deck jets stand on the deck as the sim has them)
    bob.position.y = Math.sin(t * 0.7 + ph) * 0.003;
    bob.rotation.x = Math.sin(t * 0.5 + ph) * 0.004;
    if (spin) spin.rotation.y += s.dt * 1.8;
    // the jet blast deflector: up while a jet launches, down again after
    raise += ((s.busy ?? 0) - raise) * Math.min(1, s.dt * 2.5);
    if (jbd) jbd.rotation.z = -0.95 * raise;
  };
}

/** A carrier's model from the kit (or the plain fallback). */
export function carrierShip(key: string, style: ModelStyle, fog: FogOfWar | null, kit: CarrierKit | null): Model {
  const inst = kit?.instance(key, style, fog);
  if (!inst) return fallbackCarrier(style, fog);
  const info = (kit!.info(key) ?? {}) as { h?: number };
  const root = new THREE.Group();
  const bob = new THREE.Group();
  root.add(bob);
  bob.add(inst);
  const spin = inst.getObjectByName(`${key}_spin`) ?? null;
  const jbd = inst.getObjectByName(`${key}_jbd`) ?? null;
  const H = info.h ?? 0.9;
  // night: gentle lights only (the deck's edge and the island; no glare: night.ts keeps these small)
  root.userData.runLights = [
    { pos: new THREE.Vector3(0, DECK_Z * 0.6, -0.55), color: 0xff3a2a },
    { pos: new THREE.Vector3(0, DECK_Z * 0.6, 0.62), color: 0x3aff6a },
    { pos: new THREE.Vector3(-0.6, H, 0.6), color: 0xfff2dc },
    { pos: new THREE.Vector3(2.4, DECK_Z + 0.01, 0), color: 0xc8d8ff },
    { pos: new THREE.Vector3(-2.4, DECK_Z + 0.01, 0), color: 0xc8d8ff },
  ];
  root.userData.naval = true;
  return {
    root,
    muzzles: [],
    height: H,
    size: { x: 5.2, y: H, z: 1.3 },
    glow: [],
    emitters: [],
    damageFx: [
      { pos: new THREE.Vector3(0.6, DECK_Z + 0.05, 0.1), kind: 'smoke', at: 0.3 },
      { pos: new THREE.Vector3(-1.4, DECK_Z + 0.05, -0.2), kind: 'smoke', at: 0.5 },
      { pos: new THREE.Vector3(1.6, DECK_Z, -0.1), kind: 'fire', at: 0.72 },
    ],
    anim: carrierAnim(bob, spin, jbd),
  };
}

/** A plain jet until the kit has loaded. */
function fallbackJet(style: ModelStyle, fog: FogOfWar | null): Model {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const fus = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.06, 0.1), std(0x9aa3ab, fog));
  fus.position.y = 0.06;
  const wing = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.01, 0.42), std(0x9aa3ab, fog));
  wing.position.set(-0.08, 0.06, 0);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.01), std(style.team, fog));
  fin.position.set(-0.25, 0.12, 0);
  body.add(fus, wing, fin);
  return { root, muzzles: [], height: 0.15, size: { x: 0.6, y: 0.15, z: 0.42 }, glow: [], emitters: [], gearDrop: 0, anim: jetAnim(body, null, null, null) };
}

function jetAnim(body: THREE.Group, foldL: THREE.Object3D | null, foldR: THREE.Object3D | null, gear: THREE.Object3D | null) {
  let fold = 0;
  let still = 0;
  let bank = 0;
  return (s: AnimState) => {
    // parked on the deck: after a moment the outer wings fold up; they spread again as soon as it moves
    const parked = (s.ground ?? 0) > 0.5 && !s.moving;
    still = parked ? still + s.dt : 0;
    const want = still > 1.2 ? 1 : 0;
    fold += (want - fold) * Math.min(1, s.dt * (want ? 1.4 : 3));
    if (foldL) foldL.rotation.x = 1.7 * fold;
    if (foldR) foldR.rotation.x = -1.7 * fold;
    if (gear) gear.visible = (s.gear ?? 1) > 0.5;
    // nose attitude (rotation, approach, flare) and a bank into turns in the air
    const air = (s.ground ?? 0) < 0.5;
    bank += ((air ? Math.max(-0.6, Math.min(0.6, -s.turn * 0.45)) : 0) - bank) * Math.min(1, s.dt * 4);
    body.rotation.set(bank, 0, s.pitch ?? 0, 'YXZ');
  };
}

/** A deck jet's model from the kit (or the plain fallback). */
export function carrierJet(key: string, style: ModelStyle, fog: FogOfWar | null, kit: CarrierKit | null): Model {
  const inst = kit?.instance(key, style, fog);
  if (!inst) return fallbackJet(style, fog);
  const info = (kit!.info(key) ?? {}) as { len?: number; span?: number; h?: number };
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  body.add(inst);
  const foldL = inst.getObjectByName(`${key}_foldL`) ?? null;
  const foldR = inst.getObjectByName(`${key}_foldR`) ?? null;
  const gear = inst.getObjectByName(`${key}_gear`) ?? null;
  const L = info.len ?? 0.6;
  return {
    root,
    muzzles: [],
    height: info.h ?? 0.18,
    size: { x: L, y: info.h ?? 0.18, z: info.span ?? 0.42 },
    glow: [],
    emitters: [],
    gearDrop: 0,
    damageFx: [{ pos: new THREE.Vector3(-L * 0.3, 0.08, 0), kind: 'smoke', at: 0.4 }],
    anim: jetAnim(body, foldL, foldR, gear),
  };
}
