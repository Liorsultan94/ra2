import * as THREE from 'three';
import { Tile, WATER_LEVEL, groundHeight, type GameMap } from '../sim/map';
import type { FogOfWar } from './fog';
import { SceneryLod } from './geo';
import { Ground } from './ground';
import { buildLayout, type Layout } from './layout';
import { Resources } from './resources';
import { buildRocks } from './rocks';
import { buildScenery } from './scenery';
import { buildVegetation, canopyRadius, treeSpots, windTime } from './vegetation';

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
  private waterMat!: THREE.ShaderMaterial;
  private resources: Resources;
  readonly minimapImage: HTMLCanvasElement;

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
    // Zoom-based LOD: the ground chunks report the view span (orthographic
    // camera) every frame; the vegetation and rocks switch models from it.
    const lod = new SceneryLod();
    this.lod = lod;
    const onBefore = (_r: THREE.WebGLRenderer, _s: THREE.Scene, cam: THREE.Camera) => {
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
    this.buildWater();
    for (const o of buildVegetation(map, this.layout, trees, fog, quality, lod)) this.group.add(o);
    for (const o of buildRocks(map, this.layout, fog, quality, lod)) this.group.add(o);
    for (const o of buildScenery(map, this.layout, fog, quality)) this.group.add(o);
    this.resources = new Resources(map, fog, quality);
    this.group.add(this.resources.group);
    this.minimapImage = this.buildMinimap();
    console.info(`terrain built in ${Math.round(performance.now() - t0)} ms`);
  }

  private buildWater() {
    const m = this.map;
    // height texture so the shader knows the depth
    const hw = m.w + 1;
    const hh = m.h + 1;
    const data = new Uint8Array(hw * hh);
    for (let i = 0; i < hw * hh; i++) data[i] = Math.max(0, Math.min(255, ((m.heights[i] + 1.5) / 4.5) * 255));
    const htex = new THREE.DataTexture(data, hw, hh, THREE.RedFormat, THREE.UnsignedByteType);
    htex.magFilter = htex.minFilter = THREE.LinearFilter;
    htex.needsUpdate = true;
    this.waterMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        time: { value: 0 },
        heightTex: { value: htex },
        mapSize: { value: new THREE.Vector2(m.w, m.h) },
        sunDir: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
        waterLevel: { value: WATER_LEVEL },
        ...this.fog.uniforms,
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform float time;
        uniform sampler2D heightTex;
        uniform vec2 mapSize;
        uniform vec3 sunDir;
        uniform float waterLevel;
        uniform sampler2D fogTex;
        uniform vec2 fogSize;
        uniform float fogEnabled;
        varying vec3 vWorld;
        float wave(vec2 p, vec2 d, float f, float s) { return sin(dot(p, d) * f + time * s); }
        void main() {
          vec2 p = vWorld.xz;
          float ground = texture2D(heightTex, (p + 0.5) / (mapSize + 1.0)).r * 4.5 - 1.5;
          float depth = clamp((waterLevel - ground) / 0.7, 0.0, 1.0);
          if (depth <= 0.0) discard;
          // analytic wave normal from a few directional sines
          vec2 g = vec2(0.0);
          g += vec2(0.8, 0.6) * cos(dot(p, vec2(0.8, 0.6)) * 3.1 + time * 1.4) * 0.05;
          g += vec2(-0.4, 0.9) * cos(dot(p, vec2(-0.4, 0.9)) * 5.3 + time * 1.9) * 0.03;
          g += vec2(0.95, -0.3) * cos(dot(p, vec2(0.95, -0.3)) * 8.7 + time * 2.6) * 0.02;
          vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
          vec3 viewDir = normalize(cameraPosition - vWorld);
          float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
          // a lowland river: green-brown in the shallows, dark slate in the channel
          vec3 deep = vec3(0.035, 0.1, 0.12);
          vec3 shallow = vec3(0.16, 0.26, 0.2);
          vec3 col = mix(shallow, deep, smoothstep(0.0, 0.8, depth));
          col = mix(col, vec3(0.42, 0.52, 0.58), fres * 0.55);
          float spec = pow(max(dot(reflect(-sunDir, n), viewDir), 0.0), 80.0);
          col += vec3(1.0, 0.95, 0.85) * spec * 1.6;
          float foam = smoothstep(0.22, 0.0, depth) * (0.55 + 0.45 * sin(time * 2.0 + p.x * 4.0 + p.y * 3.0));
          col = mix(col, vec3(0.85, 0.9, 0.9), foam * 0.7);
          float fogV = texture2D(fogTex, p / fogSize).r;
          float fogK = fogV < 0.5 ? fogV * 0.9 : 0.45 + (fogV - 0.5) * 1.1;
          col *= mix(1.0, fogK, fogEnabled);
          gl_FragColor = vec4(col, mix(0.55, 0.9, depth) + foam * 0.2);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const geo = new THREE.PlaneGeometry(m.w, m.h, 1, 1);
    geo.rotateX(-Math.PI / 2);
    // shared smoky shroud / haze instead of the plain darkening above
    this.fog.upgradeShader(this.waterMat);
    this.water = new THREE.Mesh(geo, this.waterMat);
    this.water.position.set(m.w / 2, WATER_LEVEL, m.h / 2);
    this.water.renderOrder = 1;
    this.group.add(this.water);
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
    const lush = [86, 102, 47];
    const dryC = [143, 132, 82];
    const dirtC = [122, 100, 72];
    const rockC = [138, 132, 122];
    const sandC = [168, 154, 122];
    const mudC = [74, 62, 48];
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
        let col = [0, 1, 2].map((j) => (lush[j] * (1 - dr) + dryC[j] * dr) * wg + dirtC[j] * sp[0] + rockC[j] * sp[1] + sandC[j] * sp[2] + mudC[j] * sp[3]);
        col = col.map((v, j) => v * Math.pow((g.tint[k + j] / 255) * 2, 0.6));
        const t = m.tiles[i];
        if (t === Tile.Water) col = [38, 74, 88];
        else if (t === Tile.Bridge) col = [120, 116, 108];
        else if (m.trees[i]) col = [34, 54, 26];
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

  update(time: number) {
    // cull the scatter to last frame's view (the margin covers the lag)
    if (this.camera) this.lod.cull(this.camera);
    this.waterMat.uniforms.time.value = time;
    windTime.value = time;
    this.resources.animate(time);
  }

  /** Sync resource rubble with the simulation's ore amounts. */
  updateOre(force = false) {
    this.resources.update(force);
  }
}
