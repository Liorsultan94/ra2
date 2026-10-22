import * as THREE from 'three';
import type { FogOfWar } from '../fog';
import type { AnimState, Model, ModelStyle } from '../models/types';
import type { CarrierKit } from './carriers';

/*
 * NV4 submarines (render only), from the Blender sub kit (tools/blender/naval/subkit.py -> public/models/naval/
 * naval-sub.glb): the nuclear boat (USA, Russia, China) and the conventional one (Israel, Germany, Korea, Turkey), a
 * hull tone per nation, the player's colour on the sail and the tail fin.
 *
 * AnimState.surf (0 submerged .. 1 surfaced) is the sim's phase eased by the renderer: the whole boat rises from under
 * the water to its waterline in 5 s (the bow lifting a touch on the way) and sinks again in 5 s. Submerged it lies
 * wholly below the surface, so the water's own shading turns it into a faint dark shape for its owner (an enemy does
 * not see it at all: World.sees). Surfaced: the swell, and the missile bay's two hatch doors open while a missile is
 * being fired (AnimState.fired), closing again after about 3 s. Dying: it goes down by the bow, listing.
 */

function fallbackSub(key: string, style: ModelStyle, fog: FogOfWar | null): Model {
  const L = key === 'sm_usa' || key === 'sm_russia' || key === 'sm_china' ? 2.3 : 1.5;
  const root = new THREE.Group();
  const bob = new THREE.Group();
  root.add(bob);
  const mk = (c: number) => {
    const m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.7, metalness: 0.2 });
    return fog ? fog.apply(m) : m;
  };
  const hull = new THREE.Mesh(new THREE.CapsuleGeometry(L * 0.07, L * 0.8, 4, 10).rotateZ(Math.PI / 2), mk(0x2a3238));
  const sail = new THREE.Mesh(new THREE.BoxGeometry(L * 0.18, L * 0.08, L * 0.05), mk(style.team));
  sail.position.set(L * 0.02, L * 0.11, 0);
  bob.add(hull, sail);
  return { root, muzzles: [], height: 0.4, size: { x: L, y: 0.4, z: L * 0.15 }, glow: [], emitters: [], anim: (s) => { bob.position.y = -0.5 * (1 - (s.surf ?? 1)); } };
}

const ease = (k: number) => k * k * (3 - 2 * k);

/** A submarine's model from the kit (or the plain fallback). */
export function subModel(key: string, style: ModelStyle, fog: FogOfWar | null, kit: CarrierKit | null): Model {
  const inst = kit?.instance(key, style, fog);
  if (!inst) return fallbackSub(key, style, fog);
  const info = (kit!.info(key) ?? {}) as { len?: number; beam?: number; h?: number; bay?: number[] };
  const L = info.len ?? 2;
  const B = info.beam ?? 0.3;
  const H = info.h ?? 0.4;
  const root = new THREE.Group();
  const bob = new THREE.Group();
  root.add(bob);
  bob.add(inst);
  const hl = inst.getObjectByName(`${key}_hatchL`);
  const hr = inst.getObjectByName(`${key}_hatchR`);
  const muzzle = inst.getObjectByName(`muzzle_${key}`);
  let open = 0;
  let sinkSide = 0;
  const anim = (s: AnimState) => {
    const t = s.time;
    const ph = (s.seed ?? 0) * 1.618;
    if (s.dead > 0) {
      // going down by the bow, listing, the hatches shut
      if (!sinkSide) sinkSide = ((s.seed ?? 1) % 2 ? 1 : -1) * 0.5;
      const k = Math.min(1, s.dead / 6);
      bob.position.y = -k * k * (H + 0.3);
      bob.rotation.z = -k * 0.5;
      bob.rotation.x = sinkSide * k * 0.5;
      return;
    }
    const surf = s.surf ?? 1;
    const e = ease(Math.max(0, Math.min(1, surf)));
    // below the surface (sail and masts included) when down; on its waterline when up
    bob.position.y = -(H + 0.05) * (1 - e) + (e > 0.95 ? Math.sin(t * 1.1 + ph) * 0.004 : 0);
    // (the bow lifts a little as it comes up and goes down again, a gentle roll on the swell once it is up)
    bob.rotation.z = Math.sin(Math.PI * e) * 0.06 + (e > 0.95 ? Math.sin(t * 0.8 + ph * 1.3) * 0.006 : 0);
    bob.rotation.x = e > 0.95 ? Math.sin(t * 0.7 + ph) * 0.012 : 0;
    // the missile bay: the hatch doors up while a missile leaves (about 0.3 s to open, shut again by 3 s)
    const f = Number.isFinite(s.fired) ? s.fired : 99;
    const want = e > 0.9 && f < 3 ? (f < 0.3 ? f / 0.3 : f < 2.2 ? 1 : 1 - (f - 2.2) / 0.8) : 0;
    open += (want - open) * Math.min(1, s.dt * 10);
    if (hl) hl.rotation.x = open * 1.2;
    if (hr) hr.rotation.x = -open * 1.2;
  };
  return {
    root,
    muzzles: muzzle ? [muzzle] : [],
    height: H,
    size: { x: L, y: H, z: B },
    glow: [],
    emitters: [],
    damageFx: [
      { pos: new THREE.Vector3(-L * 0.1, H * 0.5, 0), kind: 'smoke', at: 0.4 },
      { pos: new THREE.Vector3(-L * 0.25, H * 0.3, 0), kind: 'fire', at: 0.75 },
    ],
    anim,
  };
}
