import * as THREE from 'three';
import type { Biome } from '../sim/map';
import { PHOTO_MATERIALS, PHOTO_STACKS, type PhotoSlot, type PhotoStack } from './terrainset';

/*
 * Photoscanned ground materials (CC0 scans baked by tools/bake-terrain.mjs
 * into public/tex/terrain/<size>/<key>_{a,n}.webp).
 *
 * Every map loads only its biome's stack (7 - 9 materials): the WebPs are
 * fetched and decoded off the main thread (createImageBitmap) while the
 * battle is being built, then copied layer by layer straight into two
 * texture arrays on the GPU (no CPU pixel readback):
 *   albedo  RGB albedo (sRGB)
 *   normal  RG normal XY (OpenGL), B height
 * Until they arrive the arrays are 1 x 1 placeholders holding each layer's
 * mean colour, flat normal and mid height, so the ground shader never
 * recompiles: the swap is a uniform change. Low quality never loads them.
 */

export type PhotoTier = 0 | 512 | 1024;

/** Texture size the photoscans load at for a quality level (0 = procedural ground). ?photo=0|512|1024 overrides. */
export function photoTier(quality: 'low' | 'medium' | 'high'): PhotoTier {
  const m = typeof location !== 'undefined' ? /[?&]photo=(\d+)/.exec(location.search) : null;
  if (m) return m[1] === '1024' ? 1024 : m[1] === '512' ? 512 : 0;
  if (typeof createImageBitmap === 'undefined') return 0;
  return quality === 'low' ? 0 : quality === 'medium' ? 512 : 1024;
}

/** Public asset base (relative: works from any GitHub Pages sub-path). */
export function assetBase(): string {
  try {
    return import.meta.env?.BASE_URL ?? './';
  } catch {
    return './';
  }
}

export function photoStack(biome: Biome | undefined): PhotoStack {
  return PHOTO_STACKS[biome ?? 'temperate'] ?? PHOTO_STACKS.temperate;
}

/** Fetch + decode one image without premultiplying or colour-converting it (the data is not always colour). */
export async function fetchBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
}

interface Decoded {
  albedo: ImageBitmap[];
  normal: ImageBitmap[];
  bytes: number;
  ms: number;
}

const loads = new Map<string, Promise<Decoded | null>>();

/** Start (or join) the download of a biome's stack at a texture size. Resolves null on any failure. */
export function loadPhotoStack(biome: Biome | undefined, size: PhotoTier): Promise<Decoded | null> {
  const key = `${biome}:${size}`;
  let p = loads.get(key);
  if (!p) {
    const stack = photoStack(biome);
    const t0 = performance.now();
    const dir = `${assetBase()}tex/terrain/${size}/`;
    let bytes = 0;
    const one = async (url: string) => {
      const b = await fetchBitmap(url);
      return b;
    };
    p = Promise.all([Promise.all(stack.layers.map((k) => one(`${dir}${k}_a.webp`))), Promise.all(stack.layers.map((k) => one(`${dir}${k}_n.webp`)))])
      .then(([albedo, normal]) => {
        bytes = stack.bytes[size] ?? 0;
        const ms = Math.round(performance.now() - t0);
        console.info(`[photo] ${biome} ground: ${stack.layers.length} layers @ ${size} px, ${(bytes / 1048576).toFixed(2)} MB in ${ms} ms`);
        return { albedo, normal, bytes, ms };
      })
      .catch((e) => {
        console.warn('[photo] ground scans unavailable, keeping the procedural ground', e);
        loads.delete(key);
        return null;
      });
    loads.set(key, p);
  }
  return p;
}

const srgbByte = (v: number) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));

function arrayTexture(data: Uint8Array | null, size: number, layers: number, srgb: boolean, aniso: number): THREE.DataArrayTexture {
  const t = new THREE.DataArrayTexture(data, size, size, layers);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.flipY = false;
  t.premultiplyAlpha = false;
  t.unpackAlignment = 4;
  if (size > 1) {
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = aniso;
  } else {
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
  }
  t.needsUpdate = true;
  return t;
}

/**
 * The two texture arrays of a map's ground (and of everything that samples
 * the ground: grass blades, outskirts). `albedo` / `normal` uniform objects
 * are shared by reference; their values switch from the placeholders to the
 * real arrays once `upload()` has copied every layer.
 */
export class PhotoGround {
  readonly stack: PhotoStack;
  readonly albedo: { value: THREE.DataArrayTexture };
  readonly normal: { value: THREE.DataArrayTexture };
  /** Per layer: x = 1 / repeat (tiles), y = regular pattern, z = roughness, w = normal strength. */
  readonly params: { value: THREE.Vector4[] };
  /** Per layer: photo mean albedo (linear). */
  readonly means: { value: THREE.Vector3[] };
  /** Per layer: colour factor = biome look colour / photo mean (linear), damped. */
  readonly tints: { value: THREE.Vector3[] };
  ready = false;
  failed = false;
  private pending: Decoded | null = null;
  private next = 0;
  private realA: THREE.DataArrayTexture | null = null;
  private realN: THREE.DataArrayTexture | null = null;
  private onReady: (() => void)[] = [];

  constructor(
    biome: Biome | undefined,
    readonly size: PhotoTier,
    looks: Partial<Record<PhotoSlot, number>>,
    private aniso = 4,
  ) {
    const stack = photoStack(biome);
    this.stack = stack;
    const n = stack.layers.length;
    const mats = stack.layers.map((k) => PHOTO_MATERIALS[k]);
    // placeholders: each layer's mean colour, a flat normal, mid height
    const a = new Uint8Array(n * 4);
    const nn = new Uint8Array(n * 4);
    mats.forEach((m, i) => {
      a.set([srgbByte(m.mean[0]), srgbByte(m.mean[1]), srgbByte(m.mean[2]), 255], i * 4);
      nn.set([128, 128, 128, 255], i * 4);
    });
    this.albedo = { value: arrayTexture(a, 1, n, true, 1) };
    this.normal = { value: arrayTexture(nn, 1, n, false, 1) };
    this.params = { value: mats.map((m) => new THREE.Vector4(1 / m.tiles, m.regular ? 1 : 0, m.rough, 1)) };
    this.means = { value: mats.map((m) => new THREE.Vector3(...m.mean)) };
    // colour factor per layer: the slot's biome colour over the scan's mean (the look table derives its
    // colours from these means, so this is ~1 except where a biome deliberately recolours a scan)
    const tint = mats.map(() => new THREE.Vector3(1, 1, 1));
    const c = new THREE.Color();
    for (const [slot, hex] of Object.entries(looks) as [PhotoSlot, number][]) {
      const li = stack.slot[slot];
      if (li === undefined || hex === undefined || stack.layers[li] === undefined) continue;
      // the first slot that names a layer decides its tint
      if (tint[li].x !== 1 || tint[li].y !== 1 || tint[li].z !== 1) continue;
      c.setHex(hex); // linear (ColorManagement)
      const m = mats[li].mean;
      tint[li].set(c.r / Math.max(1e-3, m[0]), c.g / Math.max(1e-3, m[1]), c.b / Math.max(1e-3, m[2]));
    }
    this.tints = { value: tint };
    if (size > 0)
      void loadPhotoStack(biome, size).then((d) => {
        if (d) this.pending = d;
        else this.failed = true;
      });
  }

  /** Slot -> array layer (shader defines). */
  defines(): Record<string, string> {
    const d: Record<string, string> = { PH_N: String(this.stack.layers.length) };
    for (const [s, i] of Object.entries(this.stack.slot)) d['PH_' + s.toUpperCase()] = i.toFixed(1);
    return d;
  }

  /** Called when the real textures are in place (immediately if they already are). */
  whenReady(fn: () => void) {
    if (this.ready) fn();
    else this.onReady.push(fn);
  }

  /**
   * Per frame (from a render hook, which has the renderer): copies decoded
   * layers into the arrays, two images per frame, then swaps them in.
   */
  upload(renderer: THREE.WebGLRenderer) {
    const d = this.pending;
    if (!d || this.ready) return;
    const n = this.stack.layers.length;
    const S = d.albedo[0].width;
    if (!this.realA) {
      this.realA = arrayTexture(null, S, n, true, this.aniso);
      this.realN = arrayTexture(null, S, n, false, this.aniso);
      // allocate only: the layers are copied in below
      this.realA.source.dataReady = false;
      this.realN.source.dataReady = false;
    }
    const dst = new THREE.Vector3();
    for (let k = 0; k < 2 && this.next < n * 2; k++, this.next++) {
      const i = this.next >> 1;
      const isN = (this.next & 1) === 1;
      const bmp = isN ? d.normal[i] : d.albedo[i];
      const src = new THREE.Texture(bmp as unknown as HTMLImageElement);
      src.flipY = false;
      src.premultiplyAlpha = false;
      try {
        renderer.copyTextureToTexture(src, isN ? this.realN! : this.realA!, null, dst.set(0, 0, i));
      } catch (e) {
        console.warn('[photo] layer upload failed', e);
        this.failed = true;
        this.pending = null;
        return;
      }
      bmp.close?.();
    }
    if (this.next >= n * 2) {
      this.pending = null;
      this.albedo.value.dispose();
      this.normal.value.dispose();
      this.albedo.value = this.realA!;
      this.normal.value = this.realN!;
      this.ready = true;
      for (const f of this.onReady) f();
      this.onReady = [];
    }
  }

  /** Approximate GPU memory of the arrays (bytes, with mips). */
  gpuBytes(): number {
    const t = this.albedo.value;
    return Math.round(t.image.width * t.image.height * t.image.depth * 4 * (t.generateMipmaps ? 4 / 3 : 1) * 2);
  }

  dispose() {
    this.albedo.value.dispose();
    this.normal.value.dispose();
  }
}
