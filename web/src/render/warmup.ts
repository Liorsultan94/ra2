import * as THREE from 'three';
import { DEF_LIST, WEAPONS } from '../sim/defs';
import { groundHeight } from '../sim/map';
import type { Faction } from '../sim/types';
import { createModel, createMunition, type AnimState, type MunitionKind } from './models';
import { styleFor, type GameRenderer } from './renderer';
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
 * it with compileAsync (parallel compile where the driver supports it) in
 * chunks to report progress, and finally render two real frames through the
 * full pipeline (shadows, AO, bloom, thermal / night-vision passes) so the
 * remaining variants and all geometry / texture uploads happen now.
 */

export interface WarmupResult {
  ms: number;
  models: number;
  programs: number;
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

const nextFrame = () => new Promise<void>((res) => requestAnimationFrame(() => res()));

function anim(built: number): AnimState {
  return { dt: 0.016, time: 0, moving: true, speed: 1, dist: 0.3, turn: 0, fired: 0.05, dead: 0, damage: 0.8, built, powered: true };
}

export async function warmUp(r: GameRenderer, factions: Faction[], modes: ViewModes | null, onProgress: (k: number) => void): Promise<WarmupResult> {
  const t0 = performance.now();
  const gl = r.renderer;
  const world = r.world;
  const group = new THREE.Group();
  group.name = 'warmup';
  const objs: THREE.Object3D[] = [];
  // one model of every type per side in this match
  const owners = new Map<Faction, number>();
  world.players.forEach((p, i) => owners.has(p.faction) || owners.set(p.faction, i));
  for (const f of factions) {
    const owner = owners.get(f) ?? 0;
    const style = styleFor(world, owner);
    for (const d of DEF_LIST) {
      if (d.faction !== f) continue;
      try {
        const reps = d.kind === 'building' ? [0.45, 1] : [1];
        for (const b of reps) {
          const m = createModel(d.model, style, r.fog);
          m.anim?.(anim(b));
          objs.push(m.root);
        }
      } catch {
        /* a broken builder must not block the battle */
      }
    }
  }
  try {
    const m = createModel('oil', styleFor(world, -1), r.fog);
    objs.push(m.root);
  } catch {
    /* ignore */
  }
  const kinds = new Set<MunitionKind>();
  for (const w of Object.values(WEAPONS)) {
    const k = (w.munition as MunitionKind | undefined) ?? (w.flight ? MUNITION_FALLBACK[w.flight] : undefined);
    if (k) kinds.add(k);
  }
  for (const k of kinds) {
    try {
      const m = createMunition(k, world.players[0]?.color ?? 0x2f8fff);
      if (m) objs.push(m.root);
    } catch {
      /* ignore */
    }
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
  r.scene.traverse((o) => {
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
  };
  const prevRT = gl.getRenderTarget();
  // the main pass renders into a (linear) render target when the post chain is on; the drone camera always does
  const rtTarget = new THREE.WebGLRenderTarget(4, 4);
  const targets: (THREE.WebGLRenderTarget | null)[] = r.postActive ? [rtTarget] : [null, rtTarget];
  try {
    // chunks: the scene itself (terrain, scenery, effect pools...), then the models in groups
    const chunks: (THREE.Object3D[] | null)[] = [null];
    const per = Math.max(4, Math.ceil(n / 12));
    for (let i = 0; i < n; i += per) chunks.push(objs.slice(i, i + per));
    let done = 0;
    for (const c of chunks) {
      for (const t of targets) {
        gl.setRenderTarget(t);
        if (!c) {
          await gl.compileAsync(r.scene, r.camera);
          continue;
        }
        // compile() walks an object tree; wrap the chunk without re-parenting it
        const holder = new THREE.Group();
        (holder as unknown as { children: THREE.Object3D[] }).children = c;
        await gl.compileAsync(holder, r.camera, r.scene);
      }
      gl.setRenderTarget(prevRT);
      if (!c) r.scene.add(group);
      done++;
      onProgress((done / (chunks.length + 2)) * 0.9);
      await nextFrame();
    }
    // real frames through the whole pipeline: shadow / AO / bloom variants, buffer and texture uploads
    r.render(1, 0);
    onProgress(0.93);
    await nextFrame();
    if (modes) {
      const nv = r.atmos.nightVision;
      modes.setThermal(true);
      r.atmos.setNightVision(true);
      r.render(1, 0);
      r.atmos.setNightVision(nv);
      modes.setThermal(false);
    }
    onProgress(1);
  } finally {
    gl.setRenderTarget(prevRT);
    restore();
    r.scene.remove(group);
    rtTarget.dispose();
  }
  return { ms: Math.round(performance.now() - t0), models: n, programs: gl.info.programs?.length ?? 0 };
}
