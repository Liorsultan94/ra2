import * as THREE from 'three';
import { DEFS } from '../sim/defs';
import { createModel, type ModelStyle } from './models';

/** Renders unit/building portraits ("cameos") for the build sidebar from the 3D models. */
export class CameoFactory {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(26, 4 / 3, 0.1, 100);
  private cache = new Map<string, string>();

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

  dispose() {
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer = null;
  }
}
