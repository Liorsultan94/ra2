import * as THREE from 'three';
import { DEF_LIST, WEAPONS } from '../sim/defs';
import { groundHeight } from '../sim/map';
import type { Faction } from '../sim/types';
import { createModel, createMunition, type AnimState, type MunitionKind } from './models';
import { styleFor, type GameRenderer } from './renderer';
import { Slicer, nextFrame, settlePrograms } from './slice';
import type { ViewModes } from './viewmodes';

/*
 * Shader / material warm-up before the first battle frame.
 *
 * WebGL compiles a program the first time a material variant is drawn, which
 * shows up as a hitch exactly when it hurts (first building deploy, first
 * explosion, first missile). Under the loading overlay we instantiate one model
 * of every unit / building / munition type of the factions in this match
 * (buildings both mid-construction and finished), make every hidden pooled
 * object (effects, night lights, weather) visible for a moment, compile all of
 * it, and finally render real frames through the full pipeline (shadows, AO,
 * bloom, thermal / night-vision passes) so the remaining variants and all
 * geometry / texture uploads happen now.
 *
 * Everything is time sliced (slice.ts): a phone used to spend many seconds in
 * one task here (model builds + vehicle bakes, then every program linked in
 * the first full frame), long enough for the browser's "Page unresponsive"
 * dialog. Now models are built a few per slice, programs are compiled one
 * model at a time and settled (parallel compile where available, otherwise
 * one blocking link per step), the post chain's own programs are compiled the
 * same way, and the real frames show the warm-up models in small groups.
 */

export interface WarmupResult {
  ms: number;
  models: number;
  programs: number;
  /** Longest slice (ms) the warm-up ran without yielding. */
  worst: number;
}

const MUNITION_FALLBACK: Record<string, MunitionKind> = {
  shell: 'tankShell',
  artillery: 'artilleryShell',
  mortar: 'mortarBomb',
  rocketSalvo: 'rocket',
  atgm: 'atgm',
  topAttack: 'atgm',
  sam: 'sam',
  interceptor: 'interceptor',
  airMissile: 'airMissile',
  ballistic: 'ballistic',
  hypersonic: 'hypersonic',
  cruise: 'airMissile',
};

function anim(built: number): AnimState {
  return { dt: 0.016, time: 0, moving: true, speed: 1, dist: 0.3, turn: 0, fired: 0.05, dead: 0, damage: 0.8, built, powered: true };
}

/** compile() walks an object tree: wrap a list of objects without re-parenting them. */
function holder(objs: THREE.Object3D[]): THREE.Group {
  const h = new THREE.Group();
  (h as unknown as { children: THREE.Object3D[] }).children = objs;
  return h;
}

/** Every material held by a post-processing pass (fields, full-screen quads, one level of nesting). */
function passMaterials(root: object): THREE.Material[] {
  const out = new Set<THREE.Material>();
  const seen = new Set<object>();
  const visit = (o: unknown, depth: number) => {
    if (!o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    const m = o as THREE.Material & { material?: unknown; _mesh?: unknown };
    if (m.isMaterial) {
      out.add(m);
      return;
    }
    if ((o as THREE.Texture).isTexture || (o as THREE.WebGLRenderTarget).isRenderTarget || (o as THREE.Object3D).isObject3D && !(o as THREE.Mesh).isMesh) return;
    if ((o as THREE.Mesh).isMesh) {
      visit((o as THREE.Mesh).material, depth);
      return;
    }
    if (depth <= 0) return;
    for (const v of Object.values(o)) visit(v, depth - 1);
  };
  visit(root, 3);
  return [...out];
}

export async function warmUp(r: GameRenderer, factions: Faction[], modes: ViewModes | null, onProgress: (k: number) => void, alive: () => boolean = () => true): Promise<WarmupResult> {
  const t0 = performance.now();
  const slicer = new Slicer(35, () => !alive());
  r.governorHold = true;
  const gl = r.renderer;
  const world = r.world;
  const group = new THREE.Group();
  group.name = 'warmup';
  const objs: THREE.Object3D[] = [];
  // one model of every type per side in this match (built a few per slice: vehicle bakes are heavy)
  const owners = new Map<Faction, number>();
  world.players.forEach((p, i) => owners.has(p.faction) || owners.set(p.faction, i));
  const builds: (() => THREE.Object3D | null)[] = [];
  for (const f of factions) {
    const owner = owners.get(f) ?? 0;
    const style = styleFor(world, owner);
    for (const d of DEF_LIST) {
      if (d.faction !== f) continue;
      const reps = d.kind === 'building' ? [0.45, 1] : [1];
      for (const b of reps)
        builds.push(() => {
          const m = createModel(d.model, style, r.fog);
          m.anim?.(anim(b));
          return m.root;
        });
    }
  }
  builds.push(() => createModel('oil', styleFor(world, -1), r.fog).root);
  const kinds = new Set<MunitionKind>();
  for (const w of Object.values(WEAPONS)) {
    const k = (w.munition as MunitionKind | undefined) ?? (w.flight ? MUNITION_FALLBACK[w.flight] : undefined);
    if (k) kinds.add(k);
  }
  for (const k of kinds) builds.push(() => createMunition(k, world.players[0]?.color ?? 0x2f8fff)?.root ?? null);
  // building the models: 0 .. 0.3 of the progress bar
  for (let i = 0; i < builds.length; i++) {
    try {
      const o = builds[i]();
      if (o) objs.push(o);
    } catch {
      /* a broken builder must not block the battle */
    }
    if (i % 4 === 3) onProgress(((i + 1) / builds.length) * 0.3);
    await slicer.tick();
  }
  // lay them out around the view centre (inside the frustum for the real frames)
  const n = objs.length;
  const cols = Math.ceil(Math.sqrt(n));
  const sp = 1.1;
  objs.forEach((o, i) => {
    const x = Math.max(1, Math.min(world.map.w - 1, r.target.x + ((i % cols) - cols / 2) * sp * 0.6));
    const z = Math.max(1, Math.min(world.map.h - 1, r.target.z + (Math.floor(i / cols) - cols / 2) * sp * 0.6));
    o.position.set(x, groundHeight(world.map, x, z) + 0.02, z);
    group.add(o);
  });
  // pooled / hidden objects: visible for the warm-up only (lights keep their state: the light count is part of every program)
  const hidden: THREE.Object3D[] = [];
  const zeroInstances: THREE.InstancedBufferGeometry[] = [];
  r.scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      const g = (o as THREE.Mesh).geometry as THREE.InstancedBufferGeometry;
      if (g && (g as unknown as { isInstancedBufferGeometry?: boolean }).isInstancedBufferGeometry && g.instanceCount === 0) {
        g.instanceCount = 1;
        zeroInstances.push(g);
      }
    }
    if (!o.visible && !(o as THREE.Light).isLight) {
      hidden.push(o);
      o.visible = true;
    }
  });
  group.traverse((o) => {
    if (!o.visible && !(o as THREE.Light).isLight) {
      hidden.push(o);
      o.visible = true;
    }
  });
  const restore = () => {
    for (const o of hidden) o.visible = false;
    for (const g of zeroInstances) g.instanceCount = 0;
  };
  const prevRT = gl.getRenderTarget();
  // the main pass renders into a (linear) render target when the post chain is on; the drone camera always does
  const rtTarget = new THREE.WebGLRenderTarget(4, 4);
  const targets: (THREE.WebGLRenderTarget | null)[] = r.postActive ? [rtTarget] : [null, rtTarget];
  const quad = new THREE.PlaneGeometry(1, 1);
  try {
    await slicer.yield();
    // the scene itself (terrain, scenery, effect pools...): its top-level groups one at a time
    const top = r.scene.children.filter((c) => c !== group);
    let step = 0;
    const steps = top.length + n + 1;
    const compileStep = async (objsToCompile: THREE.Object3D[]) => {
      for (const t of targets) {
        gl.setRenderTarget(t);
        gl.compile(holder(objsToCompile), r.camera, r.scene);
      }
      gl.setRenderTarget(prevRT);
      await settlePrograms(gl, slicer);
      onProgress(0.3 + (++step / steps) * 0.55);
      await slicer.tick();
    };
    for (const c of top) await compileStep([c]);
    r.scene.add(group);
    // the warm-up models, one at a time
    for (const o of objs) await compileStep([o]);
    // post-processing passes (full-screen quads into linear targets; the last passes also to the screen)
    const post = r.postComposer;
    if (post) {
      // (plus the grade LUT bake, which renders into its own target)
      const lutMat = r.postChain ? passMaterials(r.postChain.lut) : [];
      const passes = post.passes;
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const scene = new THREE.Scene();
      for (let pi = 0; pi < passes.length; pi++) {
        const mats = passMaterials(passes[pi]);
        if (pi === 0) mats.push(...lutMat);
        const last = pi >= passes.length - 2;
        for (const m of mats) {
          const mesh = new THREE.Mesh(quad, m);
          mesh.frustumCulled = false;
          for (const t of last ? [rtTarget, null] : [rtTarget]) {
            gl.setRenderTarget(t);
            gl.compile(mesh, cam, scene);
          }
          gl.setRenderTarget(prevRT);
          await settlePrograms(gl, slicer);
        }
      }
    }
    // the battle scars' bake pass (its own scene, rendered into the scar layer: scarsdecal.ts)
    try {
      r.scars.decals.warm(gl);
      await settlePrograms(gl, slicer);
    } catch {
      /* not fatal */
    }
    // the unit outlines' instanced mask (readability.ts)
    try {
      r.readability.outlines.warm(gl, r.camera);
      await settlePrograms(gl, slicer);
    } catch {
      /* not fatal */
    }
    onProgress(0.88);
    await nextFrame();
    slicer.reset();
    // real frames through the whole pipeline (shadow / AO / bloom variants, buffer and texture uploads):
    // the scene alone first, then the warm-up models in groups so no frame compiles too much at once
    const per = Math.max(4, Math.ceil(n / 10));
    for (const o of objs) o.visible = false;
    r.render(1, 0);
    await settlePrograms(gl, slicer);
    await nextFrame();
    for (let i = 0; i < n; i += per) {
      for (let k = 0; k < n; k++) objs[k].visible = k >= i && k < i + per;
      r.render(1, 0);
      await settlePrograms(gl, slicer);
      onProgress(0.88 + ((i + per) / n) * 0.08);
      await nextFrame();
      slicer.reset();
    }
    for (const o of objs) o.visible = true;
    if (modes) {
      const nv = r.atmos.nightVision;
      modes.setThermal(true);
      r.atmos.setNightVision(true);
      r.render(1, 0);
      r.atmos.setNightVision(nv);
      modes.setThermal(false);
      await settlePrograms(gl, slicer);
    }
    onProgress(1);
  } finally {
    gl.setRenderTarget(prevRT);
    restore();
    r.governorHold = false;
    r.scene.remove(group);
    rtTarget.dispose();
    quad.dispose();
  }
  return { ms: Math.round(performance.now() - t0), models: n, programs: gl.info.programs?.length ?? 0, worst: Math.round(slicer.worst) };
}

/**
 * Background model prefetch for the demo battle behind the menu (its boot
 * warm-up covers the scene only, to keep the boot short). Builds one model of
 * every unit / building type of the given factions in small idle slices and
 * compiles its programs off-screen (not added to the scene), so a type the
 * demo AI builds later appears without a template build / vehicle bake /
 * shader link in the middle of a frame. Stops when `alive()` turns false.
 */
export async function prefetchModels(r: GameRenderer, factions: Faction[], alive: () => boolean): Promise<number> {
  const slicer = new Slicer(12, () => !alive());
  const rt = new THREE.WebGLRenderTarget(4, 4);
  const gl = r.renderer;
  const world = r.world;
  const owners = new Map<Faction, number>();
  world.players.forEach((p, i) => owners.has(p.faction) || owners.set(p.faction, i));
  let n = 0;
  try {
    for (const f of factions) {
      const style = styleFor(world, owners.get(f) ?? 0);
      for (const d of DEF_LIST) {
        if (d.faction !== f) continue;
        await slicer.yield();
        let root: THREE.Object3D;
        try {
          root = createModel(d.model, style, r.fog).root;
        } catch {
          continue;
        }
        await slicer.yield();
        // (the scene renders into a linear target when the post chain is on: compile that variant)
        const prev = gl.getRenderTarget();
        gl.setRenderTarget(r.postActive ? rt : null);
        gl.compile(root, r.camera, r.scene);
        gl.setRenderTarget(prev);
        await settlePrograms(gl, slicer);
        n++;
      }
    }
  } catch {
    /* aborted: the demo battle was replaced */
  } finally {
    rt.dispose();
  }
  return n;
}
