import * as THREE from 'three';
import type { FogOfWar } from '../fog';
import type { AnimState, Model, ModelStyle } from '../models/types';
import type { CarrierKit } from './carriers';

/*
 * NV3 Combat Diver (render only), from the Blender diver kit (tools/blender/naval/diverkit.py ->
 * public/models/naval/naval-diver.glb): a black wetsuit, fins, mask, a twin air tank with the player's colour on a
 * band and on the shoulders, a rifle. Five rigid parts: the body, an arm either side (the right one holds the rifle),
 * a leg either side (boot and fin), all animated here.
 *
 * Three poses, blended by the renderer's state (AnimState.swim, set from the sim's Entity.dive):
 *   on land / in the shallows: stands and walks like a rifleman, the fins slapping the sand (a slower, rolling step
 *     with the water round the legs in the shallows: the renderer sets the height);
 *   submerged (swim 1): the body pitches over onto its front about the hips, the arms reach forward holding the rifle
 *     out ahead, the legs kick the fins in turn; the renderer sinks it just under the surface so the water's own
 *     shading darkens it to a shape (water.ts is a translucent sheet), with a bubble trail on top (navalfx.ts);
 *   dead: on land it falls back; in the water it goes limp, face down, and slips under.
 */

const HIP = 0.1738; // the kit's hip height (naval.json: hip), tiles before the unit scale
const SWIM_PITCH = 1.36; // radians the body lies over when swimming (head to +X)

/** A muzzle point at the rifle's tip, in the right arm's frame (the kit's rifle: x 0.86, y -0.042, z 1.155 m, arm pivot (0, -0.215, 1.43) m). */
const MUZZLE = new THREE.Vector3(0.1625, -0.052, -0.0327);

function std(color: number, fog: FogOfWar | null): THREE.Material {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.1 });
  return fog ? fog.apply(m) : m;
}

/** A plain diver until the kit has loaded: a dark capsule with a team patch. */
function fallbackDiver(style: ModelStyle, fog: FogOfWar | null): Model {
  const root = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.2, 3, 8), std(0x1b1d20, fog));
  body.position.y = 0.17;
  const patch = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.12), std(style.team, fog));
  patch.position.set(-0.05, 0.22, 0);
  root.add(body, patch);
  return { root, muzzles: [], height: 0.34, size: { x: 0.3, y: 0.34, z: 0.2 }, glow: [], emitters: [] };
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** The diver's model from the kit (or the plain fallback). */
export function diverModel(style: ModelStyle, fog: FogOfWar | null, kit: CarrierKit | null): Model {
  const inst = kit?.instance('dv_diver', style, fog);
  if (!inst) return fallbackDiver(style, fog);
  const root = new THREE.Group();
  // (lean pivots about the hips: standing it sits at hip height over a counter-offset, so the stance is the kit's)
  const lean = new THREE.Group();
  lean.position.y = HIP;
  inst.position.y = -HIP;
  lean.add(inst);
  root.add(lean);
  const armL = inst.getObjectByName('dv_diver_armL');
  const armR = inst.getObjectByName('dv_diver_armR');
  const legL = inst.getObjectByName('dv_diver_legL');
  const legR = inst.getObjectByName('dv_diver_legR');
  const muzzle = new THREE.Object3D();
  muzzle.position.copy(MUZZLE);
  (armR ?? inst).add(muzzle);
  let swim = 0; // 0 land .. 1 submerged
  let wade = 0;
  let ph = 0;
  let fall = 0; // death: how far over (0..1)
  let kick = 0;
  const anim = (s: AnimState) => {
    const dt = s.dt;
    const seed = (s.seed ?? 0) * 1.618;
    const k0 = Math.min(1, dt * 4);
    swim += ((s.swim ?? 0) - swim) * k0;
    wade += ((s.wade ?? 0) - wade) * k0;
    if (s.dead > 0) {
      // on land: falls over backwards; in the water: limp and face down, sinking away
      fall = Math.min(1, s.dead / 0.7);
      const e = fall * fall * (3 - 2 * fall);
      const w = swim > 0.5 ? 1 : 0;
      lean.rotation.z = w ? -SWIM_PITCH * Math.max(swim, e) + Math.sin(s.dead * 0.9 + seed) * 0.05 : e * 1.45;
      lean.position.y = w ? 0.03 - Math.min(0.1, s.dead * 0.03) : HIP * (1 - 0.55 * e);
      if (armL && armR && legL && legR) {
        const fl = w ? 0.6 + Math.sin(s.dead * 1.3) * 0.2 : e * 0.9;
        armL.rotation.z = fl * 0.9;
        armR.rotation.z = fl * 1.1;
        legL.rotation.z = -fl * 0.25;
        legR.rotation.z = fl * 0.3;
      }
      return;
    }
    fall = 0;
    const spd = clamp(s.speed / 1.1, 0, 1.4);
    const mv = s.moving ? Math.max(0.25, spd) : 0;
    if (!armL || !armR || !legL || !legR) return;
    if (swim > 0.02) {
      // swimming: a kick phase driven by the time, faster the faster it goes (a gentle flutter when it hovers)
      kick += dt * (3.2 + 4.5 * mv);
      const a = Math.sin(kick) * (0.28 + 0.3 * mv);
      const b = Math.sin(kick + Math.PI) * (0.28 + 0.3 * mv);
      lean.rotation.z = -SWIM_PITCH * swim;
      // (the pivot drops to the water: the body lies along the surface instead of hanging from its hips)
      lean.position.y = HIP + (0.035 - HIP) * swim;
      armR.rotation.z = (1.3 + Math.sin(kick * 0.5) * 0.04) * swim;
      armL.rotation.z = (1.18 + Math.sin(kick * 0.5 + 1.1) * 0.06) * swim;
      legL.rotation.z = a * swim + 0.1 * swim;
      legR.rotation.z = b * swim + 0.1 * swim;
      // a slow roll with each kick
      lean.rotation.x = Math.sin(kick * 0.5 + seed) * 0.06 * swim;
      return;
    }
    // land / shallows
    ph = s.dist * (wade > 0.5 ? 7.5 : 9.5);
    const sw = Math.sin(ph) * 0.42 * mv * (wade > 0.5 ? 0.85 : 1);
    legL.rotation.z = sw;
    legR.rotation.z = -sw;
    // the left hand stays on the rifle's fore end, the right on the grip: a slight sway, and the recoil kick
    const rec = Number.isFinite(s.fired) ? Math.exp(-s.fired * 9) : 0;
    armL.rotation.z = Math.sin(ph + 0.4) * 0.05 * mv - rec * 0.05;
    armR.rotation.z = Math.sin(ph) * 0.05 * mv + rec * 0.12;
    const breath = Math.sin(s.time * 1.7 + seed) * 0.012 * (1 - mv);
    lean.rotation.z = -0.05 * mv - rec * 0.02 + breath;
    lean.rotation.x = Math.sin(ph) * 0.03 * mv;
    // (a wader crouches a touch: the water drags at the legs)
    lean.position.y = HIP - 0.012 * wade - Math.abs(Math.cos(ph)) * 0.008 * mv;
  };
  return {
    root,
    muzzles: [muzzle],
    height: 0.34,
    size: { x: 0.3, y: 0.34, z: 0.2 },
    glow: [],
    emitters: [],
    anim,
  };
}
