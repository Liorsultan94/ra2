import * as THREE from 'three';
import { BRIDGE_HEIGHT, ORE_MAX, Tile, WATER_LEVEL, groundHeight, type GameMap } from '../sim/map';
import { fbm, hash2, valueNoise } from '../sim/rng';
import type { FogOfWar } from './fog';

const SUB = 2; // terrain mesh subdivisions per tile

const COLORS: Record<number, [number, number, number]> = {
  [Tile.Grass]: [0.36, 0.47, 0.2],
  [Tile.Dirt]: [0.5, 0.4, 0.27],
  [Tile.Sand]: [0.72, 0.64, 0.46],
  [Tile.Water]: [0.34, 0.33, 0.25],
  [Tile.Rock]: [0.45, 0.42, 0.38],
  [Tile.Bridge]: [0.34, 0.33, 0.25],
};

function tileColor(m: GameMap, x: number, y: number): [number, number, number] {
  const tx = Math.max(0, Math.min(m.w - 1, x));
  const ty = Math.max(0, Math.min(m.h - 1, y));
  const i = ty * m.w + tx;
  const c = COLORS[m.tiles[i]];
  if (m.oreKind[i] === 1) return [c[0] * 0.8 + 0.12, c[1] * 0.8 + 0.08, c[2] * 0.7];
  if (m.oreKind[i] === 2) return [c[0] * 0.75 + 0.1, c[1] * 0.7 + 0.04, c[2] * 0.75 + 0.12];
  return c;
}

export class Terrain {
  group = new THREE.Group();
  water!: THREE.Mesh;
  private waterMat!: THREE.ShaderMaterial;
  private oreMesh!: THREE.InstancedMesh;
  private gemMesh!: THREE.InstancedMesh;
  private oreSlots: { tile: number; k: number; mesh: THREE.InstancedMesh; index: number; base: THREE.Matrix4 }[] = [];
  private oreCache: Uint8Array;
  readonly minimapImage: HTMLCanvasElement;

  constructor(
    private map: GameMap,
    private fog: FogOfWar,
    quality: 'low' | 'medium' | 'high',
  ) {
    this.oreCache = new Uint8Array(map.w * map.h).fill(255);
    this.buildGround(quality);
    this.buildWater();
    this.buildTrees();
    this.buildRocks();
    this.buildOre();
    this.buildBridges();
    this.buildOreMines();
    if (quality !== 'low') this.buildClutter(quality === 'high' ? 1 : 0.5);
    this.minimapImage = this.buildMinimap();
  }

  private buildGround(quality: string) {
    const m = this.map;
    const nx = m.w * SUB + 1;
    const ny = m.h * SUB + 1;
    const pos = new Float32Array(nx * ny * 3);
    const uv = new Float32Array(nx * ny * 2);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = i / SUB;
        const y = j / SUB;
        let h = groundHeight(m, x, y);
        h += (valueNoise(x * 1.7, y * 1.7, 5) - 0.5) * 0.08;
        const k = (j * nx + i) * 3;
        pos[k] = x;
        pos[k + 1] = h;
        pos[k + 2] = y;
        uv[(j * nx + i) * 2] = x / m.w;
        uv[(j * nx + i) * 2 + 1] = 1 - y / m.h;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        const b = a + 1;
        const c = a + nx;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const size = quality === 'low' ? 1024 : quality === 'medium' ? 1536 : 2048;
    const tex = new THREE.CanvasTexture(this.paintGround(size));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const mat = this.fog.apply(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 }));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'ground';
    this.group.add(mesh);

    // dark skirt far below so the map edge doesn't show the void
    const skirt = new THREE.Mesh(new THREE.PlaneGeometry(m.w * 6, m.h * 6), new THREE.MeshBasicMaterial({ color: 0x050607 }));
    skirt.rotation.x = -Math.PI / 2;
    skirt.position.set(m.w / 2, -2, m.h / 2);
    this.group.add(skirt);
  }

  private paintGround(size: number): HTMLCanvasElement {
    const m = this.map;
    // expensive terrain colouring is done at 8 px/tile, then upscaled with grain added
    const lo = m.w * 8;
    const loCanvas = document.createElement('canvas');
    loCanvas.width = loCanvas.height = lo;
    const lctx = loCanvas.getContext('2d')!;
    const limg = lctx.createImageData(lo, lo);
    const d = limg.data;
    const lppt = lo / m.w;
    for (let py = 0; py < lo; py++) {
      for (let px = 0; px < lo; px++) {
        const x = (px + 0.5) / lppt;
        const y = (py + 0.5) / lppt;
        // jittered blending between neighbouring tiles gives organic edges
        const jx = x - 0.5 + (fbm(x * 0.9, y * 0.9, 3, 2) - 0.5) * 0.9;
        const jy = y - 0.5 + (fbm(x * 0.9 + 40, y * 0.9, 3, 2) - 0.5) * 0.9;
        const x0 = Math.floor(jx);
        const y0 = Math.floor(jy);
        const fx = jx - x0;
        const fy = jy - y0;
        const c00 = tileColor(m, x0, y0);
        const c10 = tileColor(m, x0 + 1, y0);
        const c01 = tileColor(m, x0, y0 + 1);
        const c11 = tileColor(m, x0 + 1, y0 + 1);
        const sx = fx * fx * (3 - 2 * fx);
        const sy = fy * fy * (3 - 2 * fy);
        let r = (c00[0] * (1 - sx) + c10[0] * sx) * (1 - sy) + (c01[0] * (1 - sx) + c11[0] * sx) * sy;
        let g = (c00[1] * (1 - sx) + c10[1] * sx) * (1 - sy) + (c01[1] * (1 - sx) + c11[1] * sx) * sy;
        let b = (c00[2] * (1 - sx) + c10[2] * sx) * (1 - sy) + (c01[2] * (1 - sx) + c11[2] * sx) * sy;
        const macro = fbm(x * 0.12, y * 0.12, 21, 3);
        const blotch = fbm(x * 0.6, y * 0.6, 33, 2);
        const k = 0.82 + macro * 0.3 + (blotch - 0.5) * 0.2;
        r *= k;
        g *= k * (0.97 + macro * 0.06);
        b *= k;
        // slope shading: steep ground turns rocky
        const h0 = groundHeight(m, x, y);
        const slope = Math.abs(groundHeight(m, x + 0.3, y) - h0) + Math.abs(groundHeight(m, x, y + 0.3) - h0);
        const rock = Math.min(1, Math.max(0, (slope - 0.18) * 3));
        r = r * (1 - rock) + 0.46 * k * rock;
        g = g * (1 - rock) + 0.43 * k * rock;
        b = b * (1 - rock) + 0.39 * k * rock;
        if (h0 < WATER_LEVEL + 0.25) {
          const wet = Math.min(1, (WATER_LEVEL + 0.25 - h0) * 2.5);
          r *= 1 - wet * 0.35;
          g *= 1 - wet * 0.3;
          b *= 1 - wet * 0.25;
        }
        const o = (py * lo + px) * 4;
        d[o] = Math.min(255, r * 255);
        d[o + 1] = Math.min(255, g * 255);
        d[o + 2] = Math.min(255, b * 255);
        d[o + 3] = 255;
      }
    }
    lctx.putImageData(limg, 0, 0);

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(loCanvas, 0, 0, size, size);
    const img = ctx.getImageData(0, 0, size, size);
    const px = img.data;
    for (let i = 0, n = size * size; i < n; i++) {
      const gr = 1 + (hash2(i % size, (i / size) | 0, 9) - 0.5) * 0.14;
      px[i * 4] *= gr;
      px[i * 4 + 1] *= gr;
      px[i * 4 + 2] *= gr;
    }
    ctx.putImageData(img, 0, 0);
    const ppt = size / m.w;
    // tufts of grass and small stones
    for (let n = 0; n < m.w * m.h * 1.5; n++) {
      const x = hash2(n, 1, 77) * m.w;
      const y = hash2(n, 2, 77) * m.h;
      const t = m.tiles[Math.floor(y) * m.w + Math.floor(x)];
      if (t !== Tile.Grass) continue;
      ctx.fillStyle = hash2(n, 3, 77) < 0.5 ? 'rgba(40,60,20,0.35)' : 'rgba(120,140,70,0.25)';
      ctx.beginPath();
      ctx.arc(x * ppt, y * ppt, ppt * (0.06 + hash2(n, 4, 77) * 0.1), 0, Math.PI * 2);
      ctx.fill();
    }
    return canvas;
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
          vec3 deep = vec3(0.03, 0.14, 0.2);
          vec3 shallow = vec3(0.12, 0.38, 0.4);
          vec3 col = mix(shallow, deep, depth);
          col = mix(col, vec3(0.45, 0.6, 0.7), fres * 0.6);
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
    this.water = new THREE.Mesh(geo, this.waterMat);
    this.water.position.set(m.w / 2, WATER_LEVEL, m.h / 2);
    this.water.renderOrder = 1;
    this.group.add(this.water);
  }

  private buildTrees() {
    const m = this.map;
    const pines: THREE.Matrix4[] = [];
    const leafy: THREE.Matrix4[] = [];
    const pineColors: THREE.Color[] = [];
    const leafyColors: THREE.Color[] = [];
    const q = new THREE.Quaternion();
    const mat4 = (x: number, y: number, z: number, s: number, sy: number, rot: number) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
      return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s, sy, s));
    };
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        const t = m.trees[y * m.w + x];
        if (!t) continue;
        const count = 1 + (hash2(x, y, 41) < 0.45 ? 1 : 0);
        for (let k = 0; k < count; k++) {
          const ox = x + 0.25 + hash2(x, y, 50 + k) * 0.5;
          const oy = y + 0.25 + hash2(x, y, 60 + k) * 0.5;
          const s = 0.75 + hash2(x, y, 70 + k) * 0.55;
          const h = groundHeight(m, ox, oy);
          const c = new THREE.Color().setHSL(0.25 + hash2(x, y, 80 + k) * 0.08, 0.45, 0.2 + hash2(x, y, 90 + k) * 0.1);
          if (t === 1) {
            pines.push(mat4(ox, h, oy, s, s * (0.9 + hash2(x, y, 3) * 0.4), hash2(x, y, 4) * 6));
            pineColors.push(c);
          } else {
            leafy.push(mat4(ox, h, oy, s, s, hash2(x, y, 4) * 6));
            leafyColors.push(c.offsetHSL(-0.02, 0.05, 0.04));
          }
        }
      }
    }
    // pine: trunk + 3 stacked cones
    const pineGeo = mergeGeos([
      colored(new THREE.CylinderGeometry(0.035, 0.05, 0.3, 5).translate(0, 0.15, 0), 0x4a3424),
      colored(new THREE.ConeGeometry(0.32, 0.5, 7).translate(0, 0.45, 0), 0xffffff),
      colored(new THREE.ConeGeometry(0.25, 0.45, 7).translate(0, 0.7, 0), 0xffffff),
      colored(new THREE.ConeGeometry(0.16, 0.38, 7).translate(0, 0.95, 0), 0xffffff),
    ]);
    const leafyGeo = mergeGeos([
      colored(new THREE.CylinderGeometry(0.04, 0.06, 0.35, 5).translate(0, 0.17, 0), 0x4a3424),
      colored(new THREE.IcosahedronGeometry(0.3, 1).translate(0, 0.55, 0), 0xffffff),
      colored(new THREE.IcosahedronGeometry(0.22, 1).translate(0.15, 0.45, 0.08), 0xffffff),
      colored(new THREE.IcosahedronGeometry(0.2, 1).translate(-0.12, 0.48, -0.1), 0xffffff),
    ]);
    const treeMat = this.fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }));
    for (const [geo, mats, cols] of [
      [pineGeo, pines, pineColors],
      [leafyGeo, leafy, leafyColors],
    ] as const) {
      const im = new THREE.InstancedMesh(geo, treeMat, mats.length);
      mats.forEach((mm, i) => {
        im.setMatrixAt(i, mm);
        im.setColorAt(i, cols[i]);
      });
      im.castShadow = true;
      im.receiveShadow = true;
      this.group.add(im);
    }
  }

  private buildRocks() {
    const m = this.map;
    const mats: THREE.Matrix4[] = [];
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        if (m.tiles[y * m.w + x] !== Tile.Rock) continue;
        for (let k = 0; k < 2; k++) {
          const ox = x + 0.2 + hash2(x, y, 11 + k) * 0.6;
          const oy = y + 0.2 + hash2(x, y, 21 + k) * 0.6;
          const s = 0.35 + hash2(x, y, 31 + k) * 0.35;
          const e = new THREE.Euler(hash2(x, y, 1) * 3, hash2(x, y, 2) * 3, hash2(x, y, 3) * 3);
          mats.push(new THREE.Matrix4().compose(new THREE.Vector3(ox, groundHeight(m, ox, oy) + s * 0.25, oy), new THREE.Quaternion().setFromEuler(e), new THREE.Vector3(s, s * 0.8, s)));
        }
      }
    }
    const geo = new THREE.DodecahedronGeometry(0.6, 0);
    const mat = this.fog.apply(new THREE.MeshStandardMaterial({ color: 0x7d766b, roughness: 0.95, flatShading: true }));
    const im = new THREE.InstancedMesh(geo, mat, mats.length);
    mats.forEach((mm, i) => im.setMatrixAt(i, mm));
    im.castShadow = true;
    im.receiveShadow = true;
    this.group.add(im);
  }

  private buildOre() {
    const m = this.map;
    const crystal = new THREE.OctahedronGeometry(0.12, 0);
    crystal.scale(0.8, 1.9, 0.8);
    crystal.translate(0, 0.12, 0);
    const oreMat = this.fog.apply(new THREE.MeshStandardMaterial({ color: 0xe0b23c, emissive: 0x6a4a00, emissiveIntensity: 0.6, roughness: 0.3, metalness: 0.5, flatShading: true }));
    const gemMat = this.fog.apply(new THREE.MeshStandardMaterial({ color: 0xc35cff, emissive: 0x5a1a90, emissiveIntensity: 0.9, roughness: 0.2, metalness: 0.3, flatShading: true }));
    let nOre = 0;
    let nGem = 0;
    // every tile that can ever hold ore gets instance slots (ore regrows near mines)
    const candidate = (i: number) => m.oreKind[i] > 0 || m.oreMines.some((mm) => Math.abs((i % m.w) - mm.x) <= 3 && Math.abs(Math.floor(i / m.w) - mm.y) <= 3);
    const tiles: number[] = [];
    for (let i = 0; i < m.w * m.h; i++) if (candidate(i) && m.tiles[i] !== Tile.Water && m.tiles[i] !== Tile.Rock) tiles.push(i);
    const kindOf = (i: number) => {
      if (m.oreKind[i]) return m.oreKind[i];
      let best = 1;
      let bd = 1e9;
      for (const mm of m.oreMines) {
        const dd = Math.abs((i % m.w) - mm.x) + Math.abs(Math.floor(i / m.w) - mm.y);
        if (dd < bd) {
          bd = dd;
          best = m.oreKind[mm.y * m.w + mm.x] || 1;
        }
      }
      return best;
    };
    const PER = 4;
    for (const i of tiles) (kindOf(i) === 2 ? nGem++ : nOre++);
    this.oreMesh = new THREE.InstancedMesh(crystal, oreMat, Math.max(1, nOre * PER));
    this.gemMesh = new THREE.InstancedMesh(crystal, gemMat, Math.max(1, nGem * PER));
    let io = 0;
    let ig = 0;
    for (const i of tiles) {
      const x = i % m.w;
      const y = Math.floor(i / m.w);
      const gem = kindOf(i) === 2;
      for (let k = 0; k < PER; k++) {
        const ox = x + 0.2 + hash2(x, y, 100 + k) * 0.6;
        const oy = y + 0.2 + hash2(x, y, 200 + k) * 0.6;
        const tilt = new THREE.Euler((hash2(x, y, 300 + k) - 0.5) * 0.7, hash2(x, y, 400 + k) * 6, (hash2(x, y, 500 + k) - 0.5) * 0.7);
        const s = 0.7 + hash2(x, y, 600 + k) * 0.6;
        const base = new THREE.Matrix4().compose(new THREE.Vector3(ox, groundHeight(m, ox, oy), oy), new THREE.Quaternion().setFromEuler(tilt), new THREE.Vector3(s, s, s));
        const mesh = gem ? this.gemMesh : this.oreMesh;
        const index = gem ? ig++ : io++;
        this.oreSlots.push({ tile: i, k, mesh, index, base });
      }
    }
    for (const im of [this.oreMesh, this.gemMesh]) {
      im.castShadow = true;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(im);
    }
    this.updateOre(true);
  }

  private zero = new THREE.Matrix4().makeScale(0, 0, 0);
  private tmp = new THREE.Matrix4();

  /** Sync crystal sizes with the simulation's ore amounts. */
  updateOre(force = false) {
    const m = this.map;
    let dirty = false;
    for (const s of this.oreSlots) {
      const amt = m.ore[s.tile];
      if (!force && this.oreCache[s.tile] === amt) continue;
      const visible = amt > s.k * (ORE_MAX / 4) * 0.6;
      if (visible) {
        const f = 0.45 + 0.55 * Math.min(1, amt / ORE_MAX);
        this.tmp.copy(s.base).multiply(new THREE.Matrix4().makeScale(f, f, f));
        s.mesh.setMatrixAt(s.index, this.tmp);
      } else s.mesh.setMatrixAt(s.index, this.zero);
      dirty = true;
    }
    for (const s of this.oreSlots) this.oreCache[s.tile] = m.ore[s.tile];
    if (dirty) {
      this.oreMesh.instanceMatrix.needsUpdate = true;
      this.gemMesh.instanceMatrix.needsUpdate = true;
    }
  }

  private buildBridges() {
    const deckMat = this.fog.apply(new THREE.MeshStandardMaterial({ color: 0x7a7266, roughness: 0.85 }));
    const railMat = this.fog.apply(new THREE.MeshStandardMaterial({ color: 0x4b4a48, roughness: 0.6, metalness: 0.5 }));
    const stoneMat = this.fog.apply(new THREE.MeshStandardMaterial({ color: 0x8b8478, roughness: 0.95 }));
    const lineMat = this.fog.apply(new THREE.MeshStandardMaterial({ color: 0xd8d0b0, roughness: 0.8 }));
    for (const b of this.map.bridges) {
      const g = new THREE.Group();
      const L = b.length;
      const W = 2.1;
      const deck = new THREE.Mesh(new THREE.BoxGeometry(L, 0.16, W), deckMat);
      deck.position.y = BRIDGE_HEIGHT - 0.08;
      deck.castShadow = deck.receiveShadow = true;
      g.add(deck);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(L * 0.95, 0.01, 0.06), lineMat);
      stripe.position.y = BRIDGE_HEIGHT + 0.005;
      g.add(stripe);
      for (const side of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(L, 0.08, 0.06), railMat);
        rail.position.set(0, BRIDGE_HEIGHT + 0.18, (side * W) / 2);
        rail.castShadow = true;
        g.add(rail);
        for (let k = -L / 2 + 0.3; k <= L / 2; k += 0.6) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.2, 0.05), railMat);
          post.position.set(k, BRIDGE_HEIGHT + 0.08, (side * W) / 2);
          g.add(post);
        }
      }
      for (const k of [-L / 2 + 1.4, 0, L / 2 - 1.4]) {
        const pier = new THREE.Mesh(new THREE.BoxGeometry(0.45, 1.4, W * 0.8), stoneMat);
        pier.position.set(k, BRIDGE_HEIGHT - 0.85, 0);
        pier.castShadow = true;
        g.add(pier);
      }
      g.position.set(b.x, 0, b.y);
      // deck runs across the river, along tile direction (1,-1)
      g.rotation.y = Math.PI / 4;
      this.group.add(g);
    }
  }

  /** Grass tufts, bushes and pebbles scattered on open ground for detail. */
  private buildClutter(density: number) {
    const m = this.map;
    // grass tuft texture: blades drawn on a canvas, used on crossed alpha-tested quads
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    for (let i = 0; i < 26; i++) {
      const x = 8 + Math.random() * 48;
      const h = 28 + Math.random() * 34;
      const lean = (Math.random() - 0.5) * 18;
      ctx.strokeStyle = `rgb(${95 + Math.random() * 40},${125 + Math.random() * 45},${45 + Math.random() * 20})`;
      ctx.lineWidth = 1.5 + Math.random() * 1.5;
      ctx.beginPath();
      ctx.moveTo(x, 64);
      ctx.quadraticCurveTo(x + lean * 0.3, 64 - h * 0.6, x + lean, 64 - h);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const tuftGeo = mergeGeos([
      colored(new THREE.PlaneGeometry(0.22, 0.12).translate(0, 0.06, 0), 0xffffff),
      colored(new THREE.PlaneGeometry(0.22, 0.12).translate(0, 0.06, 0).rotateY(Math.PI / 2), 0xffffff),
    ]);
    // keep UVs for the planes (mergeGeos drops them): rebuild with uv
    const p1 = new THREE.PlaneGeometry(0.22, 0.12).translate(0, 0.06, 0);
    const p2 = p1.clone().rotateY(Math.PI / 2);
    const uv = new Float32Array([...(p1.toNonIndexed().attributes.uv.array as Float32Array), ...(p2.toNonIndexed().attributes.uv.array as Float32Array)]);
    tuftGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const tuftMat = this.fog.apply(new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.9 }));
    const bushGeo = new THREE.IcosahedronGeometry(0.11, 1);
    bushGeo.scale(1, 0.7, 1).translate(0, 0.05, 0);
    const bushMat = this.fog.apply(new THREE.MeshStandardMaterial({ color: 0x4f6e2c, roughness: 0.95, flatShading: true }));
    const stoneGeo = new THREE.DodecahedronGeometry(0.05, 0);
    const stoneMat = this.fog.apply(new THREE.MeshStandardMaterial({ color: 0x86807a, roughness: 0.95, flatShading: true }));
    const tufts: THREE.Matrix4[] = [];
    const bushes: THREE.Matrix4[] = [];
    const stones: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const nearStart = (x: number, y: number) => m.starts.some((st) => Math.hypot(x - st.x, y - st.y) < 9);
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        const i = y * m.w + x;
        const t = m.tiles[i];
        if (m.trees[i] || m.ore[i] || t === Tile.Water || t === Tile.Bridge) continue;
        const base = nearStart(x, y) ? 0.25 : 1;
        const n = Math.floor((t === Tile.Grass ? 1.6 : t === Tile.Rock ? 0 : 0.5) * density * base + hash2(x, y, 801));
        for (let k = 0; k < n; k++) {
          const px = x + hash2(x, y, 810 + k);
          const pz = y + hash2(x, y, 830 + k);
          const s = 0.7 + hash2(x, y, 850 + k) * 0.8;
          q.setFromAxisAngle(up, hash2(x, y, 870 + k) * 6.28);
          const mat4 = new THREE.Matrix4().compose(new THREE.Vector3(px, groundHeight(m, px, pz), pz), q, new THREE.Vector3(s, s, s));
          const r = hash2(x, y, 890 + k);
          if (t === Tile.Grass && r < 0.82) tufts.push(mat4);
          else if (t === Tile.Grass && r < 0.9) bushes.push(mat4);
          else stones.push(mat4);
        }
        if (t === Tile.Rock) {
          for (let k = 0; k < 3; k++) {
            const px = x + hash2(x, y, 910 + k);
            const pz = y + hash2(x, y, 930 + k);
            q.setFromAxisAngle(up, hash2(x, y, 950 + k) * 6.28);
            stones.push(new THREE.Matrix4().compose(new THREE.Vector3(px, groundHeight(m, px, pz), pz), q, new THREE.Vector3(1.4, 1, 1.4)));
          }
        }
      }
    }
    for (const [geo, mat, list, shadow] of [
      [tuftGeo, tuftMat, tufts, false],
      [bushGeo, bushMat, bushes, true],
      [stoneGeo, stoneMat, stones, true],
    ] as const) {
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((mm, i) => im.setMatrixAt(i, mm));
      im.castShadow = shadow;
      im.receiveShadow = true;
      this.group.add(im);
    }
  }

  private buildOreMines() {
    const mat = this.fog.apply(new THREE.MeshStandardMaterial({ color: 0x6f6658, roughness: 0.9, flatShading: true }));
    const glow = this.fog.apply(new THREE.MeshStandardMaterial({ color: 0xffd25a, emissive: 0xffc030, emissiveIntensity: 2.5, toneMapped: false }));
    for (const mm of this.map.oreMines) {
      const g = new THREE.Group();
      const mound = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.35, 7), mat);
      mound.position.y = 0.17;
      mound.castShadow = true;
      g.add(mound);
      const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.12, 0), glow);
      core.position.y = 0.38;
      g.add(core);
      g.position.set(mm.x + 0.5, groundHeight(this.map, mm.x + 0.5, mm.y + 0.5), mm.y + 0.5);
      this.group.add(g);
    }
  }

  private buildMinimap(): HTMLCanvasElement {
    const m = this.map;
    const c = document.createElement('canvas');
    c.width = m.w;
    c.height = m.h;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(m.w, m.h);
    for (let y = 0; y < m.h; y++) {
      for (let x = 0; x < m.w; x++) {
        const i = y * m.w + x;
        let col: [number, number, number];
        const t = m.tiles[i];
        if (t === Tile.Water) col = [40, 80, 100];
        else if (t === Tile.Bridge) col = [120, 115, 105];
        else if (t === Tile.Rock) col = [110, 104, 96];
        else if (m.trees[i]) col = [38, 62, 28];
        else {
          const c0 = COLORS[t];
          const hgt = groundHeight(m, x + 0.5, y + 0.5);
          const k = 0.85 + hgt * 0.15;
          col = [c0[0] * 255 * k, c0[1] * 255 * k, c0[2] * 255 * k];
        }
        img.data.set([col[0], col[1], col[2], 255], i * 4);
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  update(time: number) {
    this.waterMat.uniforms.time.value = time;
  }
}

function colored(geo: THREE.BufferGeometry, color: number) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const n = g.attributes.position.count;
  const c = new THREE.Color(color);
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function mergeGeos(geos: THREE.BufferGeometry[]) {
  let total = 0;
  for (const g of geos) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const g of geos) {
    g.computeVertexNormals();
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    nor.set(g.attributes.normal.array as Float32Array, o * 3);
    col.set(g.attributes.color.array as Float32Array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}
