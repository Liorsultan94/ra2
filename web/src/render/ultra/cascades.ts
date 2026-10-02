import * as THREE from 'three';
import { SunLight } from 'three/addons/lights/SunLight.js';
import { SunLightShadow } from 'three/addons/lights/SunLightShadow.js';

/*
 * Ultra quality sun shadows: two cascades in one shadow atlas (three's native
 * SunLight, whose shader picks the cascade by view depth and blends the
 * seam). Three's own fit splits the whole view frustum, which suits a
 * first-person camera but wastes most of the near cascade on air for this
 * high RTS camera, so the fit is replaced: each cascade bounds the visible
 * ground slab (two height planes around the view target) within its depth
 * range, in sun space, with quantised extents and the centre snapped to
 * whole shadow texels (no shimmer while panning).
 *
 *   cascade 0: the bottom half of the screen (up to the view target), crisp;
 *   cascade 1: the rest of the view, pulled in at the far edge like the
 *              single-map fit of the other quality levels.
 *
 * The cascade depth ranges belong to the main camera; other cameras that
 * render the scene (drone feed, water reflection) get the far cascade only
 * (see `forCamera`).
 */

interface ShadowInternals {
  _cameras: THREE.OrthographicCamera[];
  _matrices: THREE.Matrix4[];
  _frustums: THREE.Frustum[];
  _viewports: THREE.Vector4[];
  _cascadeData: THREE.Vector4[];
  _updateMatrix(cam: THREE.Camera, m: THREE.Matrix4, f: THREE.Frustum, vp?: THREE.Vector4): void;
}

interface Fit {
  cx: number;
  cy: number;
  hx: number;
  hy: number;
}

const BIG = 1e10;

class RtsSunShadow extends SunLightShadow {
  readonly fits: Fit[] = [
    { cx: 0, cy: 0, hx: 8, hy: 8 },
    { cx: 0, cy: 0, hx: 16, hy: 16 },
  ];
  readonly right = new THREE.Vector3(1, 0, 0);
  readonly up = new THREE.Vector3(0, 1, 0);
  /** Towards the sun. */
  readonly dir = new THREE.Vector3(0, 0, 1);
  /** Sun-axis coordinate of the view target. */
  depth0 = 0;
  /** Main-camera view depth of the cascade seam and the width of its blend. */
  split = 20;
  fade = 3;
  private mainOnly = true;
  private basis = new THREE.Matrix4();
  private pos = new THREE.Vector3();

  private get ix(): ShadowInternals {
    return this as unknown as ShadowInternals;
  }

  /** Effective texels per cascade tile (after the filter inset). */
  tileRes(): { x: number; y: number; inset: { x: number; y: number } } {
    const ix = Math.min(0.25, (Math.ceil(this.radius) + 1) / this.mapSize.x);
    const iy = Math.min(0.25, (Math.ceil(this.radius) + 1) / this.mapSize.y);
    return { x: this.mapSize.x * (1 - 2 * ix), y: this.mapSize.y * (1 - 2 * iy), inset: { x: ix, y: iy } };
  }

  /** Cascade selection for the camera about to render: true = the main view, false = far cascade only. */
  setMain(main: boolean) {
    this.mainOnly = main;
    const cd = this.ix._cascadeData;
    if (main) {
      cd[0].set(-BIG, this.split, this.split - this.fade, 0);
      cd[1].set(this.split - this.fade, BIG, BIG * 0.9, 0);
    } else {
      cd[0].set(-BIG, -BIG * 0.99, -BIG * 0.995, 0);
      cd[1].set(-BIG, BIG, BIG * 0.9, 0);
    }
  }

  updateMatrices(): void {
    const ix = this.ix;
    const tr = this.tileRes();
    this.basis.makeBasis(this.right, this.up, this.dir);
    for (let i = 0; i < 2; i++) {
      ix._viewports[i].set(i + tr.inset.x, tr.inset.y, 1 - 2 * tr.inset.x, 1 - 2 * tr.inset.y);
      const f = this.fits[i];
      const cam = ix._cameras[i];
      this.pos
        .copy(this.right)
        .multiplyScalar(f.cx)
        .addScaledVector(this.up, f.cy)
        .addScaledVector(this.dir, this.depth0 + 70);
      cam.position.copy(this.pos);
      cam.quaternion.setFromRotationMatrix(this.basis);
      cam.left = -f.hx;
      cam.right = f.hx;
      cam.top = f.hy;
      cam.bottom = -f.hy;
      cam.near = 1;
      cam.far = 140;
      cam.coordinateSystem = this.camera.coordinateSystem;
      (cam as unknown as { _reversedDepth: boolean })._reversedDepth = this.camera.reversedDepth;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld(true);
      ix._updateMatrix(cam, ix._matrices[i], ix._frustums[i], ix._viewports[i]);
    }
    this.setMain(this.mainOnly);
  }
}

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _f = new THREE.Vector3();

export class CascadeSun {
  readonly light: SunLight;
  readonly shadow: RtsSunShadow;
  private depthStack: boolean[] = [];

  constructor(
    scene: THREE.Scene,
    private mainCamera: THREE.Camera,
    mapSize: number,
  ) {
    this.light = new SunLight(0xffffff, 1);
    this.shadow = new RtsSunShadow();
    this.light.shadow.dispose();
    this.light.shadow = this.shadow;
    this.light.castShadow = true;
    this.shadow.mapSize.set(mapSize, mapSize);
    scene.add(this.light);
    // other cameras (drone feed, planar water reflection) only get the far cascade
    const prevB = scene.onBeforeRender;
    const prevA = scene.onAfterRender;
    scene.onBeforeRender = (r, s, cam, geo, mat, grp) => {
      prevB.call(scene, r, s, cam, geo, mat, grp);
      this.depthStack.push(cam === this.mainCamera);
      this.shadow.setMain(cam === this.mainCamera);
    };
    scene.onAfterRender = (r, s, cam, geo, mat, grp) => {
      prevA.call(scene, r, s, cam, geo, mat, grp);
      this.depthStack.pop();
      this.shadow.setMain(this.depthStack.length ? this.depthStack[this.depthStack.length - 1] : true);
    };
  }

  /** Mirror the colour / intensity / shadow look of the controlling directional light. */
  sync(src: THREE.DirectionalLight) {
    this.light.color.copy(src.color);
    this.light.intensity = src.intensity;
    const s = this.shadow;
    s.bias = src.shadow.bias;
    s.normalBias = src.shadow.normalBias;
    s.radius = src.shadow.radius;
    s.intensity = src.shadow.intensity;
  }

  setMapSize(size: number) {
    if (this.shadow.mapSize.x === size && this.shadow.mapSize.y === size) return;
    this.shadow.mapSize.set(size, size);
    this.shadow.map?.dispose();
    this.shadow.map = null;
  }

  /**
   * Fit both cascades. `R`, `U` = sun-space axes, `S` = towards the sun,
   * `reach` = horizontal radius around the target beyond which the far fit is pulled in.
   */
  fit(cam: THREE.PerspectiveCamera | THREE.OrthographicCamera, target: THREE.Vector3, ty: number, S: THREE.Vector3, R: THREE.Vector3, U: THREE.Vector3, reach: number) {
    const sh = this.shadow;
    sh.right.copy(R);
    sh.up.copy(U);
    sh.dir.copy(S);
    this.light.position.copy(S);
    this.light.updateMatrixWorld();
    sh.depth0 = target.x * S.x + ty * S.y + target.z * S.z;
    cam.getWorldDirection(_f);
    const camPos = cam.position;
    const tgtDepth = (target.x - camPos.x) * _f.x + (ty - camPos.y) * _f.y + (target.z - camPos.z) * _f.z;
    sh.split = tgtDepth;
    sh.fade = Math.max(1, tgtDepth * 0.12);
    const ranges: [number, number][] = [
      [-BIG, sh.split + 0.5],
      [sh.split - sh.fade - 0.5, BIG],
    ];
    const tr = sh.tileRes();
    const y0 = ty - 1.5;
    const y1 = ty + 3.5;
    for (let c = 0; c < 2; c++) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      const add = (x: number, y: number, z: number) => {
        const dd = Math.hypot(x - target.x, z - target.z);
        if (dd > reach) {
          x = target.x + ((x - target.x) * reach) / dd;
          z = target.z + ((z - target.z) * reach) / dd;
        }
        const a = x * R.x + y * R.y + z * R.z;
        const b = x * U.x + y * U.y + z * U.z;
        if (a < minX) minX = a;
        if (a > maxX) maxX = a;
        if (b < minY) minY = b;
        if (b > maxY) maxY = b;
      };
      const [d0, d1] = ranges[c];
      // a 5 x 5 fan of view rays, clipped to the ground slab and the cascade's depth range
      for (let gy = 0; gy <= 4; gy++)
        for (let gx = 0; gx <= 4; gx++) {
          const nx = gx / 2 - 1;
          const ny = gy / 2 - 1;
          _o.set(nx, ny, -1).unproject(cam);
          _d.set(nx, ny, 1).unproject(cam).sub(_o).normalize();
          if (_d.y > -1e-4) continue;
          let ta = (y1 - _o.y) / _d.y;
          let tb = (y0 - _o.y) / _d.y;
          const k = _d.dot(_f);
          const od = (_o.x - camPos.x) * _f.x + (_o.y - camPos.y) * _f.y + (_o.z - camPos.z) * _f.z;
          if (k > 1e-5) {
            ta = Math.max(ta, (d0 - od) / k);
            tb = Math.min(tb, (d1 - od) / k);
          }
          ta = Math.max(ta, 0);
          if (ta > tb) continue;
          add(_o.x + _d.x * ta, _o.y + _d.y * ta, _o.z + _d.z * ta);
          add(_o.x + _d.x * tb, _o.y + _d.y * tb, _o.z + _d.z * tb);
        }
      const f = sh.fits[c];
      if (minX > maxX) {
        // nothing of the ground in this range: keep the last fit
        continue;
      }
      // quantise the extent (changes with zoom only), snap the centre to texels
      const q = c === 0 ? 1 : 2;
      const hx = Math.ceil(((maxX - minX) / 2 + 1) / q) * q;
      const hy = Math.ceil(((maxY - minY) / 2 + 1) / q) * q;
      const tx = (2 * hx) / tr.x;
      const tyx = (2 * hy) / tr.y;
      f.hx = hx;
      f.hy = hy;
      f.cx = Math.round((minX + maxX) / 2 / tx) * tx;
      f.cy = Math.round((minY + maxY) / 2 / tyx) * tyx;
    }
  }

  dispose() {
    this.light.removeFromParent();
    this.light.dispose();
  }
}
