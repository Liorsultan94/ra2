import * as THREE from 'three';
import { Tile, groundHeight, type GameMap } from '../sim/map';
import type { Entity } from '../sim/types';
import type { FogOfWar } from './fog';
import { SceneryLod } from './geo';
import { grassRGB } from './grasstex';
import { GrassBlades } from './grass';
import { Ground } from './ground';
import { buildLayout, type Layout } from './layout';
import { Resources } from './resources';
import { buildRocks } from './rocks';
import { Props } from './props';
import { buildScenery, type SceneryHandles } from './scenery';
import { buildVegetation, canopyRadius, treeSpots, windTime, type VegetationHandles } from './vegetation';
import { RIVER, buildWater, type RiverInfo, type WaterReflection } from './water';
import { Waterside } from './waterside';
import type { Slicer } from './slice';

/*
 * The battlefield landscape: splat-shaded ground, river, vegetation, rocks,
 * resources and the countryside scenery (roads, farms, villages, power
 * lines). Only `group`, `water`, `minimapImage`, `update()` and
 * `updateOre()` are used by the renderer.
 */
export class Terrain {
  group = new THREE.Group();
  water!: THREE.Mesh;
  layout!: Layout;
  ground!: Ground;
  /** Zoom-driven level of detail for vegetation and rocks. */
  readonly lod = new SceneryLod();
  private camera: THREE.Camera | null = null;
  /** River shader (weather / time of day tint its light via wxLight / wxSpec). */
  waterMat!: THREE.ShaderMaterial;
  /** Planar water reflection (high quality only). */
  reflection: WaterReflection | null = null;
  /** The river analysis (centreline, flow, feature spots) and its banks, reeds, jetty and weir. */
  river!: RiverInfo;
  waterside: Waterside | null = null;
  private resources!: Resources;
  minimapImage!: HTMLCanvasElement;
  /** Instanced plants, fences and village houses, for render-side environment damage. */
  readonly veg: VegetationHandles = { trees: [], bushes: [] };
  readonly scenery: SceneryHandles = { houses: [], posts: [], rails: [] };
  /** Photoscanned props (barrels, crates, cars, barriers...); they stream in after the terrain is built. */
  props!: Props;

  /** Build synchronously (tests, tools); the game uses `Terrain.build()`, which yields between the steps. */
  constructor(
    private map: GameMap,
    private fog: FogOfWar,
    private quality: 'low' | 'medium' | 'high',
    deferred = false,
  ) {
    if (!deferred) for (const _ of this.steps()) void _;
  }

  /** Build in time slices (the main thread gets back to input / the loading screen between the steps). */
  static async build(map: GameMap, fog: FogOfWar, quality: 'low' | 'medium' | 'high', slicer: Slicer): Promise<Terrain> {
    const t = new Terrain(map, fog, quality, true);
    for (const _ of t.steps()) await slicer.tick();
    return t;
  }

  /** The construction, one yield per step. */
  private *steps(): Generator<void> {
    const { map, fog, quality, lod } = this;
    const t0 = performance.now();
    this.layout = buildLayout(map);
    yield;
    const trees = treeSpots(map, quality);
    yield;
    // (painted in slices: seconds of work on a phone)
    const ground = new Ground(map, this.layout, trees.map((t) => ({ x: t.x, y: t.y, r: canopyRadius(t) })), fog, quality, true);
    yield* ground.steps();
    this.ground = ground;
    this.group.add(this.ground.mesh);
    yield;
    // 3D grass blades near the camera (medium / high)
    if (quality !== 'low') {
      this.grass = new GrassBlades(map, this.ground, fog, quality);
      this.group.add(this.grass.mesh);
      yield;
    }
    // Zoom-based LOD: the ground chunks report the view span (orthographic
    // camera) every frame; the vegetation and rocks switch models from it.
    const onBefore = (r: THREE.WebGLRenderer, _s: THREE.Scene, cam: THREE.Camera) => {
      // stream the photoscanned ground layers into their texture arrays (a few per frame)
      this.ground.prepare(r);
      // the mirrored water reflection camera must not drive LOD / culling
      if (cam.userData.waterReflection) return;
      this.camera = cam;
      const oc = cam as THREE.OrthographicCamera;
      if (oc.isOrthographicCamera) lod.update((oc.top - oc.bottom) / oc.zoom);
      else if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera) lod.update(cam.position.y * 0.9);
    };
    for (const c of this.ground.chunks) c.onBeforeRender = onBefore;
    // dark skirt far below so the map edge doesn't show the void
    const skirt = new THREE.Mesh(new THREE.PlaneGeometry(map.w * 6, map.h * 6), fog.apply(new THREE.MeshBasicMaterial({ color: 0x050607 })));
    skirt.rotation.x = -Math.PI / 2;
    skirt.position.set(map.w / 2, -2, map.h / 2);
    skirt.name = 'skirt';
    this.group.add(skirt);
    this.buildWater(quality);
    yield;
    // names double as draw call breakdown categories (src/render/perf/probe.ts)
    for (const o of buildVegetation(map, this.layout, trees, fog, quality, lod, this.veg)) this.group.add(Object.assign(o, { name: o.name || 'vegetation' }));
    yield;
    for (const o of buildRocks(map, this.layout, fog, quality, lod)) this.group.add(Object.assign(o, { name: o.name || 'rocks' }));
    yield;
    for (const o of buildScenery(map, this.layout, fog, quality, this.scenery, lod)) this.group.add(Object.assign(o, { name: o.name || 'scenery' }));
    yield;
    this.props = new Props(map, this.layout, fog, quality);
    this.group.add(this.props.group);
    void this.props.load();
    yield;
    this.resources = new Resources(map, fog, quality);
    this.group.add(this.resources.group);
    this.ground.mesh.userData.perfCat = 'ground';
    this.resources.group.userData.perfCat = 'resources';
    this.group.name = 'terrain';
    yield;
    this.minimapImage = this.buildMinimap();
    console.info(`terrain built in ${Math.round(performance.now() - t0)} ms`);
  }
  private buildWater(quality: 'low' | 'medium' | 'high') {
    const w = buildWater(this.map, this.fog, quality);
    this.water = w.mesh;
    this.waterMat = w.material;
    this.reflection = w.reflection;
    this.river = w.river;
    this.group.add(w.mesh);
    this.waterside = new Waterside(this.map, w.river, this.layout, this.fog, quality, w.material.uniforms.wxLight as { value: THREE.Vector3 }, w.material.uniforms.waveTex.value as THREE.Texture);
    this.group.add(this.waterside.group);
  }

  /**
   * Quality ladder hook (0 = best rung .. 1 = worst): the planar water
   * reflection (high only) switches off once the governor is half way down.
   */
  setLadder(f: number) {
    if (this.reflection) this.reflection.enabled = f < 0.5;
  }

  private buildMinimap(): HTMLCanvasElement {
    const m = this.map;
    const S = 2; // pixels per tile
    const c = document.createElement('canvas');
    c.width = m.w * S;
    c.height = m.h * S;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(c.width, c.height);
    const g = this.ground;
    const N = m.w * g.res;
    const gcol = [0, 0, 0];
    const look = g.look;
    const rgb = (v: number) => [(v >> 16) & 255, (v >> 8) & 255, v & 255];
    // the biome's ground colours: derived from the photoscanned materials' mean albedo (biome.ts),
    // i.e. what each layer averages to on screen; a little lift so the small map reads in daylight
    const lift = (c: number[]) => c.map((v) => Math.min(255, v * 1.12));
    const dirtC = lift(rgb(look.ground.dirt));
    const rockC = lift(rgb(look.ground.rock));
    const sandC = lift(rgb(look.ground.sand));
    const mudC = lift(rgb(look.ground.mud));
    for (let py = 0; py < c.height; py++) {
      for (let px = 0; px < c.width; px++) {
        const x = (px + 0.5) / S;
        const y = (py + 0.5) / S;
        const tx = Math.floor(x);
        const ty = Math.floor(y);
        const i = ty * m.w + tx;
        const k = (Math.min(N - 1, Math.floor(y * g.res)) * N + Math.min(N - 1, Math.floor(x * g.res))) * 4;
        const sp = [g.splat[k] / 255, g.splat[k + 1] / 255, g.splat[k + 2] / 255, g.splat[k + 3] / 255];
        const wg = Math.max(0, 1 - sp[0] - sp[1] - sp[2] - sp[3]);
        const dr = g.tint[k + 3] / 255;
        grassRGB(g.ctl[k] / 255, dr, gcol, look.grass);
        let col = [0, 1, 2].map((j) => gcol[j] * 255 * 1.08 * wg + dirtC[j] * sp[0] + rockC[j] * sp[1] + sandC[j] * sp[2] + mudC[j] * sp[3]);
        col = col.map((v, j) => v * Math.pow((g.tint[k + j] / 255) * 2, 0.6));
        // winter: the painted snow cover
        if (look.code === 2) {
          const sn = Math.max(0, Math.min(1, (g.ctl[k + 2] / 255 - 0.25) / 0.4));
          const snowC = lift(rgb(look.ground.snow ?? 0xd6deec));
          col = col.map((v, j) => v + (snowC[j] - v) * sn);
        }
        const t = m.tiles[i];
        if (t === Tile.Water) col = [...look.mini.water];
        else if (t === Tile.Bridge) col = [120, 116, 108];
        else if (m.trees[i]) col = [...look.mini.tree];
        if (m.blocked[i]) col = look.code === 3 ? [118, 112, 108] : [150, 80, 60];
        const hgt = groundHeight(m, x, y);
        const sh = 0.9 + Math.max(-0.2, Math.min(0.3, hgt * 0.12));
        img.data.set([col[0] * sh, col[1] * sh, col[2] * sh, 255], (py * c.width + px) * 4);
      }
    }
    ctx.putImageData(img, 0, 0);
    // roads on top
    ctx.lineCap = 'round';
    for (const r of this.layout.roads) {
      ctx.strokeStyle = 'rgba(70,70,72,0.9)';
      ctx.lineWidth = r.width * S;
      ctx.beginPath();
      r.pts.forEach((p, k) => (k ? ctx.lineTo(p.x * S, p.y * S) : ctx.moveTo(p.x * S, p.y * S)));
      ctx.stroke();
    }
    return c;
  }

  /** Instanced grass blades (null on low quality). */
  grass: GrassBlades | null = null;

  /** Per frame. `units` (the world's entity list) lets vehicles flatten the grass blades. */
  update(time: number, units?: readonly Entity[]) {
    this.grass?.update(time, this.camera, units ?? null);
    // cull the scatter to last frame's view (the margin covers the lag)
    if (this.camera) this.lod.cull(this.camera);
    this.props.frame(this.camera, time, units);
    RIVER.time.value = time;
    this.reflection?.tick();
    this.waterside?.update(time);
    windTime.value = time;
    this.resources.animate(time);
  }

  /** Sync resource rubble with the simulation's ore amounts. */
  updateOre(force = false) {
    this.resources.update(force);
  }
}
