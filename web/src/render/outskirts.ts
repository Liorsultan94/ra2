import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { groundHeight, type GameMap } from '../sim/map';
import { fbm, hash2, valueNoise } from '../sim/rng';
import { FOG_GLSL, type FogOfWar } from './fog';

/** How far the countryside continues past each map edge (world units). */
const MARGIN = 84;
/** Grid spacing of the outskirts mesh. */
const CELL = 2;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Countryside beyond the playable map: a ring of rolling ground, farm fields
 * and woods that continues the map edge and fades into haze, so the world
 * no longer ends in a black void. Purely cosmetic (no picking, no sim).
 */
export class Outskirts {
  readonly group = new THREE.Group();
  private edge: { data: Uint8ClampedArray; size: number } | null = null;

  constructor(
    private map: GameMap,
    fog: FogOfWar,
    quality: 'low' | 'medium' | 'high',
    terrainGroup?: THREE.Object3D,
    terrainWater?: THREE.Mesh,
  ) {
    this.group.name = 'outskirts';
    this.edge = this.grabTerrainTexture(terrainGroup);
    const ground = this.buildGround(fog);
    this.group.add(ground);
    this.buildTrees(fog, quality);
    this.buildWater(fog, terrainWater);
  }

  /**
   * Rivers that reach the map edge keep flowing: a ring of water around the
   * map using the terrain's water shader (its height lookup clamps at the
   * edge, so it continues exactly where the edge is wet). The shroud part is
   * swapped for the shared fog/haze function when the source allows it.
   */
  private buildWater(fog: FogOfWar, terrainWater?: THREE.Mesh) {
    const src = terrainWater?.material as THREE.ShaderMaterial | undefined;
    if (!src || !(src as THREE.ShaderMaterial).isShaderMaterial) return;
    const { w, h } = this.map;
    const M = MARGIN;
    const rect = (x0: number, y0: number, x1: number, y1: number) =>
      new THREE.PlaneGeometry(x1 - x0, y1 - y0).rotateX(-Math.PI / 2).translate((x0 + x1) / 2, 0, (y0 + y1) / 2);
    const geo = mergeGeometries([rect(-M, -M, w + M, 0), rect(-M, h, w + M, h + M), rect(-M, 0, 0, h), rect(w, 0, w + M, h)])!;
    let mat: THREE.Material = src;
    const fsrc = src.fragmentShader;
    const fogBlock = /float fogV = texture2D\(fogTex[^;]*;\s*float fogK[^;]*;\s*col \*= mix\(1\.0, fogK, fogEnabled\);/;
    if (fogBlock.test(fsrc) && fsrc.includes('varying vec3 vWorld;')) {
      const fs = fsrc
        .replace(/uniform sampler2D fogTex;\s*/, '')
        .replace(/uniform vec2 fogSize;\s*/, '')
        .replace(/uniform float fogEnabled;\s*/, '')
        .replace('varying vec3 vWorld;', `varying vec3 vWorld;\n${FOG_GLSL}`)
        .replace(fogBlock, 'col = fogShade(col, vWorld);');
      mat = new THREE.ShaderMaterial({
        uniforms: { ...src.uniforms, ...fog.uniforms },
        vertexShader: src.vertexShader,
        fragmentShader: fs,
        transparent: src.transparent,
        depthWrite: src.depthWrite,
      });
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = terrainWater!.position.y;
    mesh.renderOrder = terrainWater!.renderOrder;
    mesh.name = 'outskirts-water';
    this.group.add(mesh);
  }

  /** Read the terrain's painted ground texture (if any) so the seam continues its colours. */
  private grabTerrainTexture(terrainGroup?: THREE.Object3D) {
    try {
      const g = terrainGroup?.getObjectByName('ground') as THREE.Mesh | undefined;
      const mat = g?.material as THREE.MeshStandardMaterial | undefined;
      const img = mat?.map?.image as CanvasImageSource | undefined;
      if (!img || !(img instanceof HTMLCanvasElement || img instanceof HTMLImageElement || (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap))) return null;
      const size = 256;
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, size, size);
      return { data: ctx.getImageData(0, 0, size, size).data, size };
    } catch {
      return null;
    }
  }

  /** Terrain colour (0-1 sRGB) at map position, mirrored back inside the map (or clamped to the edge). */
  private terrainColor(x: number, y: number, out: number[], clamp = false) {
    const { w, h } = this.map;
    const mx = clamp ? Math.max(0, Math.min(w, x)) : x < 0 ? -x : x > w ? 2 * w - x : x;
    const my = clamp ? Math.max(0, Math.min(h, y)) : y < 0 ? -y : y > h ? 2 * h - y : y;
    const e = this.edge;
    if (!e) {
      out[0] = 0.4;
      out[1] = 0.47;
      out[2] = 0.25;
      return;
    }
    // the ground texture has v flipped (uv.y = 1 - y / h) but canvas rows run top-down, so row = y / h
    const px = Math.max(0, Math.min(e.size - 1, Math.floor((mx / w) * e.size)));
    const py = Math.max(0, Math.min(e.size - 1, Math.floor((my / h) * e.size)));
    const i = (py * e.size + px) * 4;
    out[0] = e.data[i] / 255;
    out[1] = e.data[i + 1] / 255;
    out[2] = e.data[i + 2] / 255;
  }

  private outside(x: number, y: number) {
    const { w, h } = this.map;
    const dx = Math.max(0, -x, x - w);
    const dy = Math.max(0, -y, y - h);
    return Math.hypot(dx, dy);
  }

  private edgeHeight(x: number, y: number) {
    const { w, h } = this.map;
    return groundHeight(this.map, Math.max(0, Math.min(w - 0.001, x)), Math.max(0, Math.min(h - 0.001, y)));
  }

  /** 1 where the map edge next to this point is under water (rivers flow on past the edge). */
  private wetNear(x: number, y: number) {
    const { w, h } = this.map;
    const ox = x < 0 || x > w;
    const oy = y < 0 || y > h;
    if (ox === oy) return 0; // inside, or in a corner quadrant
    let m = 0;
    for (let k = -4; k <= 4; k++) {
      const hh = ox && !oy ? this.edgeHeight(x, y + k) : !ox && oy ? this.edgeHeight(x + k, y) : this.edgeHeight(x, y);
      m = Math.max(m, smoothstep(0.05, -0.3, hh) * (1 - Math.abs(k) / 5));
    }
    return m;
  }

  private height(x: number, y: number) {
    const d = this.outside(x, y);
    const base = this.edgeHeight(x, y);
    if (d <= 0) return base - 0.14;
    // flatten towards a gentle plain, then rolling hills further out
    const plain = Math.max(base, 0) * (1 - smoothstep(0, 10, d));
    const hills = (fbm(x * 0.035, y * 0.035, 909, 3) - 0.38) * 5.5;
    const near = this.wetNear(x, y);
    const dry = plain + Math.max(-0.2, hills) * smoothstep(6, 46, d) * (1 - near) - 0.14 * (1 - smoothstep(0, 3, d));
    // river beds continue straight out at the edge's depth
    const corner = (x < 0 || x > this.map.w) && (y < 0 || y > this.map.h);
    const wet = corner ? 0 : smoothstep(0.0, -0.3, base);
    return dry * (1 - wet) + base * wet;
  }

  /** Fields, meadows and woodland floor colour (linear-ish sRGB 0-1). */
  private fieldColor(x: number, y: number, out: number[]) {
    // patchwork of farm fields on a rotated grid
    const a = 0.33;
    const u = x * Math.cos(a) - y * Math.sin(a);
    const v = x * Math.sin(a) + y * Math.cos(a);
    const fu = Math.floor(u / 11);
    const fv = Math.floor(v / 8);
    const r = hash2(fu, fv, 7);
    const meadow = fbm(x * 0.05, y * 0.05, 404, 3);
    const lu = u / 11 - fu;
    const lv = v / 8 - fv;
    const border = Math.min(lu, 1 - lu, lv * 1.4, (1 - lv) * 1.4);
    if (meadow > 0.55 || r < 0.28) {
      // meadow / pasture
      const k = 0.85 + valueNoise(x * 0.4, y * 0.4, 3) * 0.25;
      out[0] = 0.36 * k;
      out[1] = 0.46 * k;
      out[2] = 0.22 * k;
      return;
    }
    let c: [number, number, number];
    if (r < 0.48) c = [0.72, 0.6, 0.32]; // ripe wheat
    else if (r < 0.62) c = [0.5, 0.38, 0.25]; // ploughed
    else if (r < 0.8) c = [0.42, 0.52, 0.2]; // young crop
    else c = [0.6, 0.55, 0.3]; // stubble
    const rows = 0.92 + 0.08 * Math.sin((r < 0.62 && r >= 0.48 ? v : u) * 5.5);
    const k = rows * (0.9 + valueNoise(x * 0.3, y * 0.3, 5) * 0.2);
    // hedgerow edge
    const hedge = 1 - smoothstep(0.02, 0.06, border);
    out[0] = c[0] * k * (1 - hedge) + 0.18 * hedge;
    out[1] = c[1] * k * (1 - hedge) + 0.26 * hedge;
    out[2] = c[2] * k * (1 - hedge) + 0.12 * hedge;
  }

  private woods(x: number, y: number) {
    return fbm(x * 0.045 + 13, y * 0.045, 515, 3);
  }

  private paint(size: number, ext: number): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(size, size);
    const d = img.data;
    const t = [0, 0, 0];
    const f = [0, 0, 0];
    const ppu = size / ext;
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const x = px / ppu - MARGIN;
        const y = py / ppu - MARGIN;
        const o = this.outside(x, y);
        let r: number, g: number, b: number;
        const jitter = o <= 0 ? 0 : (valueNoise(x * 0.25, y * 0.25, 77) - 0.5) * 6;
        const near = o <= 0 ? 0 : this.wetNear(x, y);
        let blend = o <= 0 ? 0 : smoothstep(4, 18, o + jitter) * (1 - near);
        if (o > 0 && near <= 0 && this.edgeHeight(x < 0 ? -x : x > this.map.w ? 2 * this.map.w - x : x, y < 0 ? -y : y > this.map.h ? 2 * this.map.h - y : y) < -0.05) blend = 1;
        if (blend < 1) this.terrainColor(x, y, t, near > 0);
        if (blend > 0) this.fieldColor(x, y, f);
        r = t[0] * (1 - blend) + f[0] * blend;
        g = t[1] * (1 - blend) + f[1] * blend;
        b = t[2] * (1 - blend) + f[2] * blend;
        // darker forest floor under woods
        const wd = o < 5 ? 0 : smoothstep(0.55, 0.65, this.woods(x, y)) * smoothstep(5, 12, o);
        r *= 1 - wd * 0.45;
        g *= 1 - wd * 0.35;
        b *= 1 - wd * 0.45;
        const grain = 0.92 + hash2(px, py, 9) * 0.16;
        const i = (py * size + px) * 4;
        d[i] = Math.min(255, r * grain * 255);
        d[i + 1] = Math.min(255, g * grain * 255);
        d[i + 2] = Math.min(255, b * grain * 255);
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  private buildGround(fog: FogOfWar): THREE.Mesh {
    const { w, h } = this.map;
    const x0 = -MARGIN;
    const y0 = -MARGIN;
    const ext = Math.max(w, h) + MARGIN * 2;
    const n = Math.round(ext / CELL);
    const pos: number[] = [];
    const uv: number[] = [];
    const vid = new Int32Array((n + 1) * (n + 1)).fill(-1);
    const vert = (i: number, j: number) => {
      const k = j * (n + 1) + i;
      if (vid[k] >= 0) return vid[k];
      const x = x0 + i * CELL;
      const y = y0 + j * CELL;
      pos.push(x, this.height(x, y), y);
      uv.push(i / n, 1 - j / n);
      vid[k] = pos.length / 3 - 1;
      return vid[k];
    };
    const idx: number[] = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const cx0 = x0 + i * CELL;
        const cy0 = y0 + j * CELL;
        // skip cells well inside the map (the terrain covers them); keep a 2 unit overlap
        if (cx0 >= 2 && cx0 + CELL <= w - 2 && cy0 >= 2 && cy0 + CELL <= h - 2) continue;
        const a = vert(i, j);
        const b = vert(i + 1, j);
        const c = vert(i, j + 1);
        const d = vert(i + 1, j + 1);
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const tex = new THREE.CanvasTexture(this.paint(512, ext));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = fog.apply(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.97, metalness: 0 }));
    // fine grain so the low-res colour texture doesn't look smeared up close
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, r) => {
      prev.call(mat, shader, r);
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          vec4 gn = texture2D( fogNoise, vFogP.xz * 0.37 );
          vec4 gn2 = texture2D( fogNoise, vFogP.xz * 1.9 );
          diffuseColor.rgb *= 0.86 + gn.r * 0.18 + gn2.g * 0.12;
        }`,
      );
    };
    mat.customProgramCacheKey = () => 'outskirts-ground';
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'outskirts-ground';
    return mesh;
  }

  private buildTrees(fog: FogOfWar, quality: string) {
    const { w, h } = this.map;
    const colored = (g: THREE.BufferGeometry, hex: number) => {
      const g2 = g.index ? g.toNonIndexed() : g;
      const col = new THREE.Color(hex);
      const n = g2.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) col.toArray(arr, i * 3);
      g2.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      g2.deleteAttribute('uv');
      return g2;
    };
    const pineGeo = mergeGeometries([
      colored(new THREE.CylinderGeometry(0.035, 0.05, 0.3, 4).translate(0, 0.15, 0), 0x4a3424),
      colored(new THREE.ConeGeometry(0.34, 0.6, 6).translate(0, 0.5, 0), 0xffffff),
      colored(new THREE.ConeGeometry(0.24, 0.5, 6).translate(0, 0.85, 0), 0xffffff),
    ])!;
    const leafyGeo = mergeGeometries([
      colored(new THREE.CylinderGeometry(0.04, 0.06, 0.35, 4).translate(0, 0.17, 0), 0x4a3424),
      colored(new THREE.IcosahedronGeometry(0.36, 0).translate(0, 0.58, 0), 0xffffff),
      colored(new THREE.IcosahedronGeometry(0.26, 0).translate(0.17, 0.46, 0.1), 0xffffff),
    ])!;
    const pines: THREE.Matrix4[] = [];
    const leafy: THREE.Matrix4[] = [];
    const pc: THREE.Color[] = [];
    const lc: THREE.Color[] = [];
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const budget = quality === 'low' ? 900 : quality === 'medium' ? 1600 : 2400;
    const step = 1.3;
    let k = 0;
    for (let y = -MARGIN + 2; y < h + MARGIN - 2 && pines.length + leafy.length < budget; y += step) {
      for (let x = -MARGIN + 2; x < w + MARGIN - 2; x += step) {
        k++;
        const ox = x + (hash2(k, 1, 3) - 0.5) * step;
        const oy = y + (hash2(k, 2, 3) - 0.5) * step;
        const o = this.outside(ox, oy);
        if (o < 3) continue;
        // keep the near edges on the camera side clear so trees never hide units
        if ((ox > w || oy > h) && o < 9) continue;
        const wd = this.woods(ox, oy);
        const dense = smoothstep(0.56, 0.66, wd);
        // scattered trees along hedgerows / in meadows
        const p = dense * 0.85 + 0.035;
        if (hash2(k, 4, 5) > p) continue;
        if (o > MARGIN - 6) continue;
        const s = 0.85 + hash2(k, 5, 5) * 0.7 + dense * 0.3;
        const hy = this.height(ox, oy);
        q.setFromAxisAngle(up, hash2(k, 6, 5) * 6.28);
        const m = new THREE.Matrix4().compose(new THREE.Vector3(ox, hy - 0.05, oy), q, new THREE.Vector3(s, s * (0.9 + hash2(k, 7, 5) * 0.35), s));
        const c = new THREE.Color().setHSL(0.24 + hash2(k, 8, 5) * 0.08, 0.42, 0.17 + hash2(k, 9, 5) * 0.1);
        if (hash2(k, 10, 5) < 0.45 + (fbm(ox * 0.02, oy * 0.02, 66, 2) - 0.5)) {
          pines.push(m);
          pc.push(c);
        } else {
          leafy.push(m);
          lc.push(c.offsetHSL(-0.02, 0.06, 0.05));
        }
        if (pines.length + leafy.length >= budget) break;
      }
    }
    const mat = fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }));
    // one instanced mesh per type and sector so off-screen sectors are frustum culled
    const G = 5;
    const cell = (Math.max(w, h) + MARGIN * 2) / G;
    const sector = (m: THREE.Matrix4) => {
      const gx = Math.max(0, Math.min(G - 1, Math.floor((m.elements[12] + MARGIN) / cell)));
      const gy = Math.max(0, Math.min(G - 1, Math.floor((m.elements[14] + MARGIN) / cell)));
      return gy * G + gx;
    };
    for (const [geo, mats, cols] of [
      [pineGeo, pines, pc],
      [leafyGeo, leafy, lc],
    ] as const) {
      for (let sct = 0; sct < G * G; sct++) {
        const idx: number[] = [];
        mats.forEach((mm, i) => sector(mm) === sct && idx.push(i));
        if (!idx.length) continue;
        const im = new THREE.InstancedMesh(geo, mat, idx.length);
        idx.forEach((src, i) => {
          im.setMatrixAt(i, mats[src]);
          im.setColorAt(i, cols[src]);
        });
        im.castShadow = quality === 'high';
        im.receiveShadow = false;
        im.computeBoundingSphere();
        this.group.add(im);
      }
    }
  }
}
