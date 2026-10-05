import * as THREE from 'three';
import { groundHeight } from '../sim/map';
import { FLARE_RADIUS, FLARE_TICKS } from '../sim/night';
import { TPS, type Flare, type SimEvent } from '../sim/types';
import type { World } from '../sim/world';
import { CONTACT_LAYER, ContactShadows } from './contactshadow';
import type { Effects } from './effects';
import type { NightLights } from './night';

/*
 * Night combat visuals (sim/night.ts holds the rules):
 *
 *  - UnitVeil: enemy units that come into view by night (a muzzle flash, a flare, sight) fade in out of the
 *    dark and fade out again when they drop out of view. The unit's own materials stay untouched (no shader
 *    variants, no quality change): a "veil" proxy over its solid meshes, drawn right on top of them in the
 *    night's darkness with the fade's opacity, takes the unit back into the dark. Only fading units carry one.
 *  - FlareFx: illumination rounds. The shell's arc with a spark and a smoke wisp, the pop, then a flare under a
 *    small parachute that sways down for 30 s: a white-yellow core and halo with a gentle flicker, a smoke
 *    trail, one dynamic light per flare (the shared battlefield light pool, fx/lights.ts: fixed size, no shader
 *    recompiles; capped to the flares nearest the view), its light pool on the ground (night.ts pools) and
 *    moving shadows of everything under it (soft shadow decals thrown away from the swaying flare; one
 *    instanced draw call). Cheap on phones: a flare costs a few sprites, two decals per unit near it, no
 *    shadow maps.
 */

// ------------------------------------------------------------ fading units

const VEIL_VERT = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
void main() {
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
}`;
const VEIL_FRAG = /* glsl */ `
uniform vec3 color;
uniform float opacity;
void main() {
  gl_FragColor = vec4( color, opacity );
}`;

/** The night's darkness the veil takes a unit back into (linear, before the grade). */
const VEIL_COLOR = new THREE.Color(0.011, 0.013, 0.019);

interface Veiled {
  root: THREE.Object3D;
  mat: THREE.ShaderMaterial;
  proxies: THREE.Mesh[];
}

/** Solid meshes of a model (the parts that hide what is behind them). */
function solidParts(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry || (m as unknown as { isVeil?: boolean }).isVeil || (m as unknown as { isXray?: boolean }).isXray) return;
    const mat = m.material as THREE.Material;
    if (Array.isArray(m.material) || !mat || mat.transparent || !mat.visible || (mat as THREE.ShaderMaterial).isShaderMaterial) return;
    if (!m.geometry.attributes.position) return;
    out.push(m);
  });
  return out;
}

export class UnitVeil {
  private veiled = new Map<number, Veiled>();

  /** Is this visual wearing a veil (fading)? */
  has(id: number) {
    return this.veiled.has(id);
  }

  /** Fade k (0 = in the dark .. 1 = fully seen) of a unit model; 1 removes the veil. */
  set(id: number, root: THREE.Object3D, k: number) {
    let v = this.veiled.get(id);
    if (k >= 0.999) {
      if (v) this.drop(id, v);
      return;
    }
    if (v && v.root !== root) {
      this.drop(id, v);
      v = undefined;
    }
    if (!v) v = this.wear(id, root);
    v.mat.uniforms.opacity.value = 1 - Math.max(0, k);
  }

  private wear(id: number, root: THREE.Object3D): Veiled {
    const mat = new THREE.ShaderMaterial({
      uniforms: { color: { value: VEIL_COLOR }, opacity: { value: 1 } },
      vertexShader: VEIL_VERT,
      fragmentShader: VEIL_FRAG,
      transparent: true,
      depthWrite: false,
      depthFunc: THREE.LessEqualDepth,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
      toneMapped: false,
      fog: false,
    });
    const proxies: THREE.Mesh[] = [];
    for (const m of solidParts(root)) {
      let p: THREE.Mesh;
      const sk = m as THREE.SkinnedMesh;
      const im = m as THREE.InstancedMesh;
      if (sk.isSkinnedMesh) {
        const s = new THREE.SkinnedMesh(m.geometry, mat);
        s.bind(sk.skeleton, sk.bindMatrix);
        s.bindMode = sk.bindMode;
        p = s;
      } else if (im.isInstancedMesh) {
        const i = new THREE.InstancedMesh(m.geometry, mat, im.count);
        i.instanceMatrix = im.instanceMatrix;
        i.count = im.count;
        p = i;
      } else p = new THREE.Mesh(m.geometry, mat);
      (p as unknown as { isVeil: boolean }).isVeil = true;
      p.renderOrder = 8;
      p.castShadow = false;
      p.receiveShadow = false;
      p.frustumCulled = m.frustumCulled;
      p.layers.set(0); // (the main view; the auto-instancer may have moved the part itself off layer 0 this frame)
      m.add(p);
      proxies.push(p);
    }
    const v = { root, mat, proxies };
    this.veiled.set(id, v);
    return v;
  }

  private drop(id: number, v: Veiled) {
    for (const p of v.proxies) p.removeFromParent();
    v.mat.dispose();
    this.veiled.delete(id);
  }

  /** Forget visuals that are gone (call with the live ids once in a while). */
  prune(alive: (id: number) => boolean) {
    for (const [id, v] of this.veiled) if (!alive(id)) this.drop(id, v);
  }

  dispose() {
    for (const [id, v] of this.veiled) this.drop(id, v);
  }
}

// ------------------------------------------------------------ illumination flares

/** The flare pops this high above the ground (tiles) and sinks to the ground over its burn. */
export const FLARE_ALT = 6.2;
/** Flares drawn at once (nearest the view centre). */
const MAX_DRAWN = 10;
/** Flares that get a real dynamic light (quality caps; the shared light pool decides in the end). */
const LIT_CAP: Record<'low' | 'medium' | 'high', number> = { low: 1, medium: 2, high: 3 };
/** Flares throwing unit shadows at once. */
const SHADOW_CAP = 2;

interface Shell {
  flare: number;
  x0: number;
  y0: number;
  z0: number;
  t0: number;
}

interface Drawn {
  root: THREE.Group;
  chute: THREE.Mesh;
  lines: THREE.LineSegments;
  core: THREE.Sprite;
  halo: THREE.Sprite;
  chuteMat: THREE.MeshBasicMaterial;
}

function glowTexture(): THREE.Texture {
  const s = 64;
  const data = new Uint8Array(s * s * 4);
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++) {
      const dx = (x + 0.5) / s - 0.5;
      const dy = (y + 0.5) / s - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      const a = Math.max(0, Math.exp(-r * r * 5) * 0.75 + Math.exp(-r * r * 40) * 0.6 - 0.004);
      const i = (y * s + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.min(255, Math.round(a * 255));
    }
  const t = new THREE.DataTexture(data, s, s, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** One lit flare this frame. */
export interface FlareNow {
  id: number;
  x: number;
  y: number;
  z: number;
  /** Ground height under it. */
  g: number;
  /** Brightness 0..1 (pop, flicker, burnout). */
  k: number;
}

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();

export class FlareFx {
  readonly group = new THREE.Group();
  /** Lit flares this frame (prepare()), nearest the view first. */
  readonly now: FlareNow[] = [];
  private shells = new Map<number, Shell>();
  private pool: Drawn[] = [];
  private tex = glowTexture();
  private smokeAcc = new Map<number, number>();
  private shellPrev = new Map<number, THREE.Vector3>();
  /** Shadow decals thrown by the flares (main view only; null on low quality). */
  readonly shadows: ContactShadows | null;
  private time = 0;

  constructor(
    scene: THREE.Scene,
    private quality: 'low' | 'medium' | 'high',
    camera: THREE.Camera,
  ) {
    scene.add(this.group);
    if (quality !== 'low') {
      this.shadows = new ContactShadows();
      // after the light pools: a shadow takes the flare's light away under it
      this.shadows.mesh.renderOrder = 3;
      this.shadows.mesh.name = 'flare-shadows';
      scene.add(this.shadows.mesh);
      camera.layers.enable(CONTACT_LAYER);
    } else this.shadows = null;
  }

  /** An illumination round left the gun (sim event; p = its muzzle). */
  onIllum(ev: Extract<SimEvent, { t: 'illum' }>, p: THREE.Vector3, simT: number) {
    this.shells.set(ev.flare, { flare: ev.flare, x0: p.x, y0: p.y, z0: p.z, t0: simT });
  }

  /** Where the flare hangs at sim time t (seconds): sinking under its canopy, swaying. */
  static position(f: Flare, t: number, map: World['map'], out = _v): THREE.Vector3 {
    const age = Math.max(0, t - f.at / TPS);
    const life = FLARE_TICKS / TPS;
    const u = Math.min(1, age / life);
    const g = groundHeight(map, Math.max(0, Math.min(map.w - 0.01, f.x)), Math.max(0, Math.min(map.h - 0.01, f.y)));
    // a pendulum under the canopy plus a slow drift of the canopy itself
    const ph = f.id * 1.618;
    const sx = 0.3 * Math.sin(age * 1.25 + ph) + 0.12 * Math.sin(age * 0.37 + ph * 2.3);
    const sz = 0.26 * Math.sin(age * 1.05 + ph * 0.7 + 1.1) + 0.12 * Math.cos(age * 0.31 + ph);
    return out.set(f.x + sx, g + 0.35 + (FLARE_ALT - 0.35) * (1 - u), f.y + sz);
  }

  /** Brightness 0..1 at sim time t: a quick pop, a living flicker, the burnout. */
  static brightness(f: Flare, t: number): number {
    const age = t - f.at / TPS;
    const left = f.end / TPS - t;
    if (age < 0 || left <= 0) return 0;
    const pop = Math.min(1, age / 0.35);
    const out = Math.min(1, left / 1.6);
    const fl = 0.9 + 0.06 * Math.sin(t * 17.3 + f.id) + 0.04 * Math.sin(t * 43.1 + f.id * 3.1);
    return pop * out * out * fl;
  }

  /** Lit flares this frame (before the entity sync: their shadows go in with the units). */
  prepare(world: World, simT: number, view: THREE.Vector3) {
    const now = this.now;
    now.length = 0;
    for (const f of world.flares) {
      const k = FlareFx.brightness(f, simT);
      if (k <= 0) continue;
      const p = FlareFx.position(f, simT, world.map);
      now.push({ id: f.id, x: p.x, y: p.y, z: p.z, g: groundHeight(world.map, Math.max(0, Math.min(world.map.w - 0.01, f.x)), Math.max(0, Math.min(world.map.h - 0.01, f.y))), k });
    }
    if (now.length > 1) now.sort((a, b) => Math.hypot(a.x - view.x, a.z - view.z) - Math.hypot(b.x - view.x, b.z - view.z));
    if (now.length > MAX_DRAWN) now.length = MAX_DRAWN;
    this.shadows?.begin();
  }

  /**
   * Shadow of one shown object near the flares: a soft decal thrown away from each nearby flare, longer the
   * lower the flare hangs. (x, z) ground position, h its height, r its half width.
   */
  shadow(map: World['map'], x: number, z: number, h: number, r: number) {
    const s = this.shadows;
    if (!s) return;
    const n = Math.min(SHADOW_CAP, this.now.length);
    for (let i = 0; i < n; i++) {
      const f = this.now[i];
      const dx = x - f.x;
      const dz = z - f.z;
      const d = Math.hypot(dx, dz);
      if (d > FLARE_RADIUS + 1 || d < 0.25) continue;
      const above = Math.max(0.6, f.y - f.g - h * 0.5);
      const len = Math.min(5, (h * d) / above);
      if (len < 0.08) continue;
      const ux = dx / d;
      const uz = dz / d;
      const fall = 1 - Math.max(0, d - FLARE_RADIUS * 0.55) / (FLARE_RADIUS * 0.45 + 1);
      const a = 0.62 * f.k * Math.max(0, fall);
      s.add(map, x + ux * (len * 0.5 + r * 0.4), z + uz * (len * 0.5 + r * 0.4), Math.atan2(-uz, ux), len * 0.5 + r * 0.55, r * 0.85, 0.3, a);
    }
  }

  private drawn(i: number): Drawn {
    let d = this.pool[i];
    if (d) return d;
    const root = new THREE.Group();
    // a small round canopy (open side down), lit from below by its own flare
    const chuteMat = new THREE.MeshBasicMaterial({ color: 0xbdb8a8, side: THREE.DoubleSide, toneMapped: false });
    const chute = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 5, 0, Math.PI * 2, 0, Math.PI * 0.45).scale(1, 0.55, 1), chuteMat);
    chute.position.y = 0.42;
    const lp: number[] = [];
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      lp.push(Math.cos(a) * 0.18, 0.42 + 0.06, Math.sin(a) * 0.18, 0, 0.04, 0);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x8a8578, transparent: true, opacity: 0.7, toneMapped: false }));
    const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, color: 0xfff6dc, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    core.scale.setScalar(0.55);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, color: 0xffe2a0, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.5, toneMapped: false }));
    halo.scale.setScalar(2.4);
    core.renderOrder = halo.renderOrder = 9;
    root.add(chute, lines, halo, core);
    for (const o of [chute, lines, core, halo]) {
      o.castShadow = false;
      o.receiveShadow = false;
    }
    this.group.add(root);
    d = this.pool[i] = { root, chute, lines, core, halo, chuteMat };
    return d;
  }

  /** Per frame: shells in flight, the flares, their smoke, light and ground glow. */
  update(dt: number, world: World, simT: number, fx: Effects) {
    this.time += dt;
    this.shadows?.end();
    // shells on their way up: a spark on a ballistic arc with a thin smoke wisp
    for (const [id, s] of this.shells) {
      const f = world.flares.find((q) => q.id === id);
      if (!f || simT >= f.at / TPS) {
        if (f) {
          // the pop: the flare charge ejects with a puff and a flash
          const p = FlareFx.position(f, f.at / TPS, world.map, _a);
          fx.smoke(p.x, p.y + 0.15, p.z, 0.5, false);
          fx.flashLight(p.x, p.y, p.z, 4, 0xfff0c8, 0.25);
        }
        this.shells.delete(id);
        this.shellPrev.delete(id);
        continue;
      }
      const T = Math.max(0.05, f.at / TPS - s.t0);
      const u = Math.max(0, Math.min(1, (simT - s.t0) / T));
      const end = FlareFx.position(f, f.at / TPS, world.map, _a);
      const arc = Math.max(2, Math.hypot(end.x - s.x0, end.z - s.z0) * 0.35);
      const cur = new THREE.Vector3(s.x0 + (end.x - s.x0) * u, s.y0 + (end.y - s.y0) * u + arc * 4 * u * (1 - u), s.z0 + (end.z - s.z0) * u);
      const prev = this.shellPrev.get(id);
      if (prev) fx.trail(prev, cur, 'artillery', false);
      this.shellPrev.set(id, cur);
    }
    // the flares
    const lit = LIT_CAP[this.quality];
    let i = 0;
    for (const f of this.now) {
      const d = this.drawn(i);
      d.root.visible = true;
      d.root.position.set(f.x, f.y, f.z);
      // the canopy leans into the swing
      const sw = Math.sin(simT * 1.25 + f.id * 1.618);
      d.root.rotation.set(sw * 0.12, 0, -sw * 0.1);
      const k = f.k;
      d.core.material.opacity = Math.min(1, 0.4 + 0.6 * k);
      d.core.scale.setScalar(0.38 + 0.22 * k);
      d.halo.material.opacity = 0.42 * k;
      d.halo.scale.setScalar(1.7 + 1.2 * k);
      d.chuteMat.color.setRGB(0.25 + 0.55 * k, 0.24 + 0.52 * k, 0.21 + 0.45 * k);
      // one real light each, for the nearest few (the shared pool ranks them with the fires and blasts)
      if (i < lit) fx.lights.sustain(f.x, f.y - 0.5, f.z, 7.5 * k, 0xfff0cc, 0.08);
      // the smoke trail it leaves as it sinks and swings
      const acc = (this.smokeAcc.get(f.id) ?? 0) + dt * fx.rate * 9;
      let n = Math.floor(acc);
      this.smokeAcc.set(f.id, acc - n);
      while (n-- > 0) fx.smoke(f.x, f.y + 0.05, f.z, 0.32, false);
      i++;
    }
    for (; i < this.pool.length; i++) this.pool[i].root.visible = false;
    for (const id of this.smokeAcc.keys()) if (!this.now.some((f) => f.id === id)) this.smokeAcc.delete(id);
  }

  /** NightLights hook: the lit circle on the ground and a white sprite pair through the night's flare pool. */
  nightHook = (n: NightLights, dark: number) => {
    for (const f of this.now) {
      const h = Math.max(0.5, f.y - f.g);
      // the lit area widens as the flare sinks a little, then tightens near the ground
      const r = Math.min(FLARE_RADIUS + 0.5, 3 + h * 0.85);
      const k = f.k * (0.35 + 0.65 * dark) * Math.min(1, 2.2 / Math.sqrt(h));
      n.pool(f.x, f.g, f.z, 0, r * 2, r * 2, 0.36 * k, 0.33 * k, 0.26 * k);
      n.pool(f.x, f.g, f.z, 0, r * 1.1, r * 1.1, 0.22 * k, 0.2 * k, 0.15 * k);
    }
  };

  dispose() {
    this.group.removeFromParent();
    this.shadows?.mesh.removeFromParent();
    this.tex.dispose();
  }
}
