import * as THREE from 'three';
import { DEFS } from '../sim/defs';
import { createModel, type ModelStyle } from './models';

/** Renders unit/building portraits ("cameos") for the build sidebar from the 3D models. */
export class CameoFactory {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(26, 4 / 3, 0.1, 100);
  private cache = new Map<string, string>();
  private w = 192;
  private h = 144;

  constructor() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 192;
      canvas.height = 144;
      this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(192, 144, false);
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    } catch {
      this.renderer = null;
    }
    this.scene.add(new THREE.HemisphereLight(0xdde8ff, 0x50402c, 1.6));
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.8);
    sun.position.set(-3, 6, 4);
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight(0x9fc0ff, 1.2);
    rim.position.set(4, 3, -4);
    this.scene.add(rim);
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
      // units face the viewer three-quarter, like classic cameos
      if (d.kind === 'unit') root.rotation.y = Math.PI * 0.18;
      this.resize(192, 144);
      this.scene.add(root);
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(size.x, size.y * 1.2, size.z) * 0.62 + 0.05;
      const dist = radius / Math.tan((this.camera.fov * Math.PI) / 360);
      const dir = new THREE.Vector3(1, 0.85, 1.25).normalize();
      this.camera.position.copy(center).addScaledVector(dir, dist);
      this.camera.lookAt(center);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.render(this.scene, this.camera);
      url = this.renderer.domElement.toDataURL('image/png');
      this.scene.remove(root);
    }
    this.cache.set(key, url);
    return url;
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
   * offscreen canvas and return it for the caller to blit. Sharing the cameo
   * GL context means the model shader programs already compiled for the
   * sidebar cameos are reused (the portrait scene keeps the same light rig
   * layout: one hemisphere + two directional lights) and no extra context is
   * opened on phones.
   */
  renderLive(scene: THREE.Scene, camera: THREE.Camera, w: number, h: number): HTMLCanvasElement | null {
    if (!this.renderer) return null;
    this.resize(w, h);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.render(scene, camera);
    return this.renderer.domElement;
  }

  dispose() {
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer = null;
  }
}
