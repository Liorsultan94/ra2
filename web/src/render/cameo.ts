import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { DEFS } from '../sim/defs';
import { createModel, type ModelStyle } from './models';

/** Cameo output size (CSS shows it at ~90-130 px; 2x for high-DPR screens). */
const CW = 192;
const CH = 144;
/** Supersampling factor: rendered at SS x the output size (on top of MSAA), then filtered down. */
const SS = 2;

/**
 * Studio light rig shared by the sidebar cameos and the live portrait
 * (ui/portrait3d.ts): a warm key from the front left, a cool fill from the
 * right, a rim from behind and a sky / ground hemisphere, plus a neutral room
 * environment for the metal and glass. Both scenes use the same layout so the
 * shader programs compiled for one are reused by the other.
 */
export interface StudioRig {
  hemi: THREE.HemisphereLight;
  key: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
  rim: THREE.DirectionalLight;
}
export function studioRig(scene: THREE.Scene): StudioRig {
  const hemi = new THREE.HemisphereLight(0xd6e2f2, 0x4a3c2c, 0.9);
  const key = new THREE.DirectionalLight(0xfff0dc, 2.7);
  key.position.set(-2.6, 5, 4.2);
  const fill = new THREE.DirectionalLight(0xb8ccec, 0.75);
  fill.position.set(4.5, 1.6, 2.5);
  const rim = new THREE.DirectionalLight(0x9fc0ff, 1.6);
  rim.position.set(2.5, 3, -5);
  scene.add(hemi, key, fill, rim);
  return { hemi, key, fill, rim };
}

/** Transparent 1x1 placeholder shown until a cameo has been rendered. */
export const CAMEO_BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** Offscreen canvas edge (px): big enough for a supersampled cameo and the largest live portrait frame. */
const CANVAS_PX = 512;

/** Yield to the event loop (input, rAF) between two steps of a cameo render. */
const idle = () =>
  new Promise<void>((res) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(() => res(), { timeout: 250 });
    else setTimeout(res, 16);
  });

/**
 * Renders unit/building portraits ("cameos") for the build sidebar from the 3D models.
 *
 * One factory (one offscreen GL context) serves the whole session: the menu's
 * hero tank, every battle's sidebar and the live selection portrait
 * (sharedCameos()). Cameos render in the background, one per idle slice: each
 * one builds a model, compiles its shaders on this context and reads the
 * frame back, which for the ~40 sidebar entries at once froze the battle
 * start (and the menu, for the demo battle's hidden sidebar) for seconds on
 * phones. `get()` returns the cached PNG or a transparent placeholder and
 * queues the render; the finished image is patched into every
 * `<img data-cameo>` showing it (see `img()` / `attr()`).
 * The canvas has a fixed size: cameos and the live portrait render into a
 * viewport at its top-left corner (resizing a GL canvas stalls on the GPU).
 */
export class CameoFactory {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(26, 4 / 3, 0.1, 100);
  private cache = new Map<string, string>();
  private queue = new Map<string, { defId: string; style: ModelStyle }>();
  private running = false;
  /** While true (a battle is compiling its shaders under the loading screen) the background queue waits. */
  paused = false;
  private env: THREE.Texture | null = null;
  /** 2D canvas the supersampled frame is filtered down into (CPU backed: the PNG encode reads it back). */
  private out: HTMLCanvasElement | null = null;
  /** Full-size frame rebuilt from the asynchronous readback (CPU backed). */
  private big: HTMLCanvasElement | null = null;

  constructor() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = CANVAS_PX;
      canvas.height = CANVAS_PX;
      this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
      this.renderer.debug.checkShaderErrors = !!import.meta.env?.DEV;
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(CANVAS_PX, CANVAS_PX, false);
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.12;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    } catch {
      this.renderer = null;
    }
    studioRig(this.scene);
    this.scene.environment = this.environment();
    this.scene.environmentIntensity = 0.55;
  }

  /** Neutral studio environment (PMREM of three's RoomEnvironment), shared with the live portrait. */
  environment(): THREE.Texture | null {
    if (this.env || !this.renderer) return this.env;
    try {
      const pm = new THREE.PMREMGenerator(this.renderer);
      this.env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
      pm.dispose();
    } catch {
      this.env = null;
    }
    return this.env;
  }

  private static key(defId: string, style: ModelStyle) {
    return `${defId}:${style.team}`;
  }

  /** Cached PNG of a cameo, or the blank placeholder while it is queued (prefer `img()` / `attr()`, which get patched). */
  get(defId: string, style: ModelStyle): string {
    const key = CameoFactory.key(defId, style);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit || CAMEO_BLANK;
    if (!this.renderer) return CAMEO_BLANK;
    if (!this.queue.has(key)) this.queue.set(key, { defId, style });
    void this.pump();
    return CAMEO_BLANK;
  }

  /** Point an <img> at a cameo (now if it is cached, else as soon as it has been rendered). */
  img(img: HTMLImageElement, defId: string, style: ModelStyle) {
    img.dataset.cameo = CameoFactory.key(defId, style);
    img.src = this.get(defId, style);
  }

  /** `data-cameo` + `src` attributes for an <img> inside an HTML string. */
  attr(defId: string, style: ModelStyle): string {
    return `data-cameo="${CameoFactory.key(defId, style)}" src="${this.get(defId, style)}"`;
  }

  /** Render the queued cameos one at a time in idle slices. */
  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.size && this.renderer) {
        await idle();
        if (this.paused || document.hidden) {
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        const [key, job] = this.queue.entries().next().value as [string, { defId: string; style: ModelStyle }];
        this.queue.delete(key);
        if (this.cache.has(key)) continue;
        let url = '';
        try {
          url = await this.render(job.defId, job.style);
        } catch (e) {
          console.warn('[cameo] failed', job.defId, e);
        }
        this.cache.set(key, url);
        if (url) for (const im of document.querySelectorAll<HTMLImageElement>(`img[data-cameo="${key}"]`)) im.src = url;
      }
    } finally {
      this.running = false;
    }
  }

  private async render(defId: string, style: ModelStyle): Promise<string> {
    const r = this.renderer;
    const d = DEFS[defId];
    if (!r || !d) return '';
    const model = createModel(d.model, style, null);
    const root = model.root;
    model.anim?.({ dt: 0, time: 0, moving: false, speed: 0, dist: 0, turn: 0, fired: Infinity, dead: 0, damage: 0, built: 1, powered: true });
    this.scene.add(root);
    try {
      root.updateMatrixWorld(true);
      // frame without the whip antennas (they would shrink the model in the frame)
      const box = frameBox(root, true);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      // skinned meshes (infantry) measure in bind space before their first render: use the model's height
      if (d.kind === 'unit' && model.height > size.y * 1.4) {
        size.set(Math.max(size.x, model.height * 0.55), model.height, Math.max(size.z, model.height * 0.4));
        center.set(0, model.height / 2, 0);
      }
      if (d.kind === 'unit' && model.height > size.y * 1.4) box.setFromCenterAndSize(center, size);
      // units face the viewer three-quarter, like classic cameos (fit on the model-space box's corners)
      if (d.kind === 'unit') root.rotation.y = Math.PI * 0.18;
      root.updateMatrixWorld(true);
      fitCamera(this.camera, box, new THREE.Vector3(1, 0.8, 1.25), 0.86, root.matrixWorld);
      // compile this model's programs without blocking (parallel compile where the browser has it)
      await r.compileAsync(this.scene, this.camera);
      if (this.renderer !== r) return '';
      await idle();
      const w = CW * SS;
      const h = CH * SS;
      this.corner(w, h);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.render(this.scene, this.camera);
      // read the frame back without waiting on the GPU (a synchronous readback stalled the main thread
      // until the cameo context had compiled and drawn everything queued: seconds on slow phones)
      const px = await this.readback(r, w, h);
      if (this.renderer !== r) return '';
      if (px) return await this.encode(px, w, h);
      return this.downsample(r.domElement, w, h, CW, CH).toDataURL('image/png');
    } finally {
      this.scene.remove(root);
    }
  }

  /**
   * Asynchronous readback of the top-left w x h of the canvas: readPixels into a pixel buffer, a fence,
   * then poll the fence in idle slices; the pixels are copied out only once the GPU is done (WebGL 2).
   * Null where that is unavailable (the caller falls back to the synchronous path).
   */
  private async readback(r: THREE.WebGLRenderer, w: number, h: number): Promise<Uint8Array | null> {
    const gl = r.getContext();
    if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) return null;
    const size = w * h * 4;
    const buf = gl.createBuffer();
    if (!buf) return null;
    let sync: WebGLSync | null = null;
    try {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, size, gl.STREAM_READ);
      // (three leaves the canvas' own framebuffer bound after rendering to it)
      gl.readPixels(0, CANVAS_PX - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!sync) return null;
      gl.flush();
      const t0 = performance.now();
      for (;;) {
        await new Promise((res) => setTimeout(res, 20));
        if (this.renderer !== r || gl.isContextLost()) return null;
        const st = gl.clientWaitSync(sync, 0, 0);
        if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) break;
        // (a driver that never signals: copy anyway after a while; the data is complete by then)
        if (st === gl.WAIT_FAILED || performance.now() - t0 > 10000) break;
      }
      const out = new Uint8Array(size);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, out);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      return out;
    } catch {
      return null;
    } finally {
      if (sync) gl.deleteSync(sync);
      gl.deleteBuffer(buf);
    }
  }

  /** Bottom-up premultiplied RGBA (the GL frame) -> filtered down to the cameo size -> PNG (encoded off the main thread). */
  private async encode(px: Uint8Array, w: number, h: number): Promise<string> {
    if (!this.big) this.big = document.createElement('canvas');
    const big = this.big;
    if (big.width !== w || big.height !== h) {
      big.width = w;
      big.height = h;
    }
    const bg = big.getContext('2d', { willReadFrequently: true });
    if (!bg) return '';
    const img = bg.createImageData(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      let si = (h - 1 - y) * w * 4;
      let di = y * w * 4;
      for (let x = 0; x < w; x++, si += 4, di += 4) {
        const a = px[si + 3];
        if (a === 0) continue;
        if (a === 255) {
          d[di] = px[si];
          d[di + 1] = px[si + 1];
          d[di + 2] = px[si + 2];
        } else {
          const k = 255 / a;
          d[di] = Math.min(255, Math.round(px[si] * k));
          d[di + 1] = Math.min(255, Math.round(px[si + 1] * k));
          d[di + 2] = Math.min(255, Math.round(px[si + 2] * k));
        }
        d[di + 3] = a;
      }
    }
    bg.putImageData(img, 0, 0);
    const c = this.downsample(big, w, h, CW, CH);
    const blob = await new Promise<Blob | null>((res) => {
      try {
        c.toBlob(res, 'image/png');
      } catch {
        res(null);
      }
    });
    return blob ? URL.createObjectURL(blob) : c.toDataURL('image/png');
  }

  /** Filter the top-left sw x sh of a supersampled frame down to w x h (high-quality 2D canvas smoothing). */
  private downsample(src: HTMLCanvasElement, sw: number, sh: number, w: number, h: number): HTMLCanvasElement {
    if (!this.out) this.out = document.createElement('canvas');
    const c = this.out;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return src;
    g.clearRect(0, 0, w, h);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, sw, sh, 0, 0, w, h);
    return c;
  }

  /** True while the offscreen GL context is alive (the live portrait falls back to the static cameo otherwise). */
  get available(): boolean {
    return !!this.renderer;
  }

  /** Draw into the w x h top-left corner of the fixed-size canvas (the GL viewport origin is bottom-left). */
  private corner(w: number, h: number) {
    const r = this.renderer!;
    w = Math.min(CANVAS_PX, Math.round(w));
    h = Math.min(CANVAS_PX, Math.round(h));
    r.setScissorTest(true);
    r.setViewport(0, CANVAS_PX - h, w, h);
    r.setScissor(0, CANVAS_PX - h, w, h);
  }

  /**
   * Live 3D portrait (ui/portrait3d.ts): render a scene into the top-left w x h
   * of this factory's offscreen canvas and return the canvas for the caller to
   * filter down and blit (source rect 0, 0, w, h). Sharing the cameo GL context
   * means the model shader programs already compiled for the sidebar cameos
   * are reused (the portrait scene uses the same studioRig() + environment) and
   * no extra context is opened on phones.
   */
  /** Compile a live scene's programs on this context without blocking (parallel compile where available). */
  prepare(scene: THREE.Scene, camera: THREE.Camera): Promise<void> {
    if (!this.renderer) return Promise.resolve();
    return this.renderer.compileAsync(scene, camera).then(
      () => undefined,
      () => undefined,
    );
  }

  renderLive(scene: THREE.Scene, camera: THREE.Camera, w: number, h: number): HTMLCanvasElement | null {
    if (!this.renderer) return null;
    this.corner(w, h);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.render(scene, camera);
    return this.renderer.domElement;
  }

  dispose() {
    this.queue.clear();
    this.env?.dispose();
    this.env = null;
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer = null;
  }
}

let shared: CameoFactory | null = null;

/**
 * The session's cameo factory: one offscreen GL context for the menu hero, the
 * sidebar cameos and the live portrait of every battle (never re-created, so
 * contexts never pile up, and cameos / programs carry over between battles).
 */
export function sharedCameos(): CameoFactory {
  shared ??= new CameoFactory();
  return shared;
}

/**
 * Place a perspective camera looking along -dir so the box's projection fills
 * `fill` of the frame (both axes) and is centred: a sphere estimate leaves long
 * vehicles small in a 4:3 frame.
 */
export function fitCamera(cam: THREE.PerspectiveCamera, box: THREE.Box3, dir: THREE.Vector3, fill: number, m?: THREE.Matrix4) {
  const d = dir.clone().normalize();
  const c = box.getCenter(new THREE.Vector3());
  if (m) c.applyMatrix4(m);
  const r = box.getSize(new THREE.Vector3()).length() * 0.5 || 1;
  let dist = r / Math.tan((cam.fov * Math.PI) / 360);
  const look = c.clone();
  const p = new THREE.Vector3();
  for (let it = 0; it < 4; it++) {
    cam.position.copy(look).addScaledVector(d, dist);
    cam.near = dist * 0.05;
    cam.far = dist * 6;
    cam.lookAt(look);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      if (m) p.applyMatrix4(m);
      p.project(cam);
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
    // re-centre (shift the look point in the camera plane), then scale the distance to the fill target
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const hx = Math.tan((cam.fov * Math.PI) / 360) * dist * cam.aspect;
    const hy = Math.tan((cam.fov * Math.PI) / 360) * dist;
    look.addScaledVector(right, ((x0 + x1) / 2) * hx).addScaledVector(up, ((y0 + y1) / 2) * hy);
    const ext = Math.max((x1 - x0) / 2, (y1 - y0) / 2);
    dist *= ext / fill;
  }
  cam.position.copy(look).addScaledVector(d, dist);
  cam.lookAt(look);
  cam.updateProjectionMatrix();
}

/** Bounding box of a model's meshes without whip antennas (and without recoiling barrels when `guns` is false); vehicles tag them. */
export function frameBox(root: THREE.Object3D, guns = true): THREE.Box3 {
  const box = new THREE.Box3();
  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return;
    for (let q: THREE.Object3D | null = o; q && q !== root.parent; q = q.parent) {
      const tg = q.userData.tag;
      if (typeof tg === 'string' && (tg.includes('whip') || (!guns && tg.includes('recoil')))) return;
    }
    box.expandByObject(o, false);
  });
  if (box.isEmpty()) box.setFromObject(root);
  return box;
}
