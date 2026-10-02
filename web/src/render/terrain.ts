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
import { buildScenery, type SceneryHandles } from './scenery';
import { buildVegetation, canopyRadius, treeSpots, windTime, type VegetationHandles } from './vegetation';
import { RIVER, buildWater, type RiverInfo, type WaterReflection } from './water';
import { Waterside } from './waterside';

/*
 * The battlefield landscape: splat-shaded ground, river, vegetation, rocks,
 * resources and the countryside scenery (roads, farms, villages, power
 * lines). Only `group`, `water`, `minimapImage`, `update()` and
 * `updateOre()` are used by the renderer.
 */
export class Terrain {
  group = new THREE.Group();
  water!: THREE.Mesh;
  readonly layout: Layout;
  readonly ground: Ground;
  /** Zoom-driven level of detail for vegetation and rocks. */
  readonly lod: SceneryLod;
  private camera: THREE.Camera | null = null;
  /** River shader (weather / time of day tint its light via wxLight / wxSpec). */
  waterMat!: THREE.ShaderMaterial;
  /** Planar water reflection (high quality only). */
  reflection: WaterReflection | null = null;
  /** The river analysis (centreline, flow, feature spots) and its banks, reeds, jetty and weir. */
  river!: RiverInfo;
  waterside: Waterside | null = null;
  private resources: Resources;
  readonly minimapImage: HTMLCanvasElement;
  /** Instanced plants, fences and village houses, for render-side environment damage. */
  readonly veg: VegetationHandles = { trees: [], bushes: [] };
  readonly scenery: SceneryHandles = { houses: [], posts: [], rails: [] };

  constructor(
    private map: GameMap,
    private fog: FogOfWar,
    quality: 'low' | 'medium' | 'high',
  ) {
    const t0 = performance.now();
    this.layout = buildLayout(map);
    const trees = treeSpots(map, quality);
    this.ground = new Ground(map, this.layout, trees.map((t) => ({ x: t.x, y: t.y, r: canopyRadius(t) })), fog, quality);
    this.group.add(this.ground.mesh);
    // 3D grass blades near the camera (medium / high)
    if (quality !== 'low') {
      this.grass = new GrassBlades(map, this.ground, fog, quality);
      this.group.add(this.grass.mesh);
    }
    // Zoom-based LOD: the ground chunks report the view span (orthographic
    // camera) every frame; the vegetation and rocks switch models from it.
    const lod = new SceneryLod();
    this.lod = lod;
    const onBefore = (_r: THREE.WebGLRenderer, _s: THREE.Scene, cam: THREE.Camera) => {
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
    // names double as draw call breakdown categories (src/render/perf/probe.ts)
    for (const o of buildVegetation(map, this.layout, trees, fog, quality, lod, this.veg)) this.group.add(Object.assign(o, { name: o.name || 'vegetation' }));
    for (const o of buildRocks(map, this.layout, fog, quality, lod)) this.group.add(Object.assign(o, { name: o.name || 'rocks' }));
    for (const o of buildScenery(map, this.layout, fog, quality, this.scenery, lod)) this.group.add(Object.assign(o, { name: o.name || 'scenery' }));
    this.resources = new Resources(map, fog, quality);
    this.group.add(this.resources.group);
    this.ground.mesh.userData.perfCat = 'ground';
    this.resources.group.userData.perfCat = 'resources';
    this.group.name = 'terrain';
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
    // temperate keeps its original minimap tones
    const temperate = look.code === 0;
    const dirtC = temperate ? [122, 100, 72] : rgb(look.ground.dirt);
    const rockC = temperate ? [138, 132, 122] : rgb(look.ground.rock);
    const sandC = temperate ? [168, 154, 122] : rgb(look.ground.sand);
    const mudC = temperate ? [74, 62, 48] : rgb(look.ground.mud);
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
          col = col.map((v, j) => v + ([214, 222, 236][j] - v) * sn);
        }
        const t = m.tiles[i];
        if (t === Tile.Water) col = [...look.mini.water];
        else if (t === Tile.Bridge) col = [120, 116, 108];
        else if (m.trees[i]) col = [...look.mini.tree];
        if (m.blocked[i]) col = [150, 80, 60];
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
  readonly grass: GrassBlades | null = null;

  /** Per frame. `units` (the world's entity list) lets vehicles flatten the grass blades. */
  update(time: number, units?: readonly Entity[]) {
    this.grass?.update(time, this.camera, units ?? null);
    // cull the scatter to last frame's view (the margin covers the lag)
    if (this.camera) this.lod.cull(this.camera);
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
