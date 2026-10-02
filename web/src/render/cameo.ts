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

/** Renders unit/building portraits ("cameos") for the build sidebar from the 3D models. */
export class CameoFactory {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(26, 4 / 3, 0.1, 100);
  private cache = new Map<string, string>();
  private w = CW * SS;
  private h = CH * SS;
  private env: THREE.Texture | null = null;
  /** 2D canvas the supersampled frame is filtered down into (cameo PNGs). */
  private out: HTMLCanvasElement | null = null;

  constructor() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = this.w;
      canvas.height = this.h;
      this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(this.w, this.h, false);
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

  get(defId: string, style: ModelStyle): string {
    const key = `${defId}:${style.team}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    let url = '';
    if (this.renderer) {
      const d = DEFS[defId];
      const model = createModel(d.model, style, null);
      const root = model.root;
      model.anim?.({ dt: 0, time: 0, moving: false, speed: 0, dist: 0, turn: 0, fired: Infinity, dead: 0, damage: 0, built: 1, powered: true });
      this.resize(CW * SS, CH * SS);
      this.scene.add(root);
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
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.render(this.scene, this.camera);
      url = this.downsample(this.renderer.domElement, CW, CH).toDataURL('image/png');
      this.scene.remove(root);
    }
    this.cache.set(key, url);
    return url;
  }

  /** Filter a supersampled frame down to w x h (box-filter quality via the 2D canvas' high-quality smoothing). */
  private downsample(src: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
    if (!this.out) this.out = document.createElement('canvas');
    const c = this.out;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const g = c.getContext('2d');
    if (!g) return src;
    g.clearRect(0, 0, w, h);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, src.width, src.height, 0, 0, w, h);
    return c;
  }

  /** True while the offscreen GL context is alive (the live portrait falls back to the static cameo otherwise). */
  get available(): boolean {
    return !!this.renderer;
  }

  private resize(w: number, h: number) {
    if (!this.renderer || (w === this.w && h === this.h)) return;
    this.w = w;
    this.h = h;
    this.renderer.setSize(w, h, false);
  }

  /**
   * Live 3D portrait (ui/portrait3d.ts): render a scene into this factory's
   * offscreen canvas and return it for the caller to filter down and blit.
   * Sharing the cameo GL context means the model shader programs already
   * compiled for the sidebar cameos are reused (the portrait scene uses the
   * same studioRig() + environment) and no extra context is opened on phones.
   */
  renderLive(scene: THREE.Scene, camera: THREE.Camera, w: number, h: number): HTMLCanvasElement | null {
    if (!this.renderer) return null;
    this.resize(w, h);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.render(scene, camera);
    return this.renderer.domElement;
  }

  dispose() {
    this.env?.dispose();
    this.env = null;
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer = null;
  }
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
