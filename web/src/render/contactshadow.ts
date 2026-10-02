import * as THREE from 'three';
import { standHeight, type GameMap } from '../sim/map';

/*
 * Contact shadows: a soft darkening right where units and buildings meet the
 * ground (sky occlusion under hulls, between tracks, along wall bases), so
 * nothing looks like it floats. One instanced draw call for everything on
 * screen; each instance is a rounded-rectangle footprint (sized from the
 * model's bounding size / building footprint, turned with the unit and
 * tilted to the terrain under it) that fades out over a short soft rim.
 *
 * It lives on its own camera layer, enabled on the main view only: the drone
 * feed, the thermal heat mask and other secondary cameras don't draw it.
 * Aircraft are not covered (AirShadows in unitpose.ts draws theirs).
 */

export const CONTACT_LAYER = 22;
const MAX = 4096;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qy = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class ContactShadows {
  readonly mesh: THREE.InstancedMesh;
  private box: THREE.InstancedBufferAttribute;
  private n = 0;
  /** Overall strength (quality / time of day). */
  strength = 1;

  constructor() {
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.box = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
    this.box.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aBox', this.box);
    const mat = new THREE.ShaderMaterial({
      uniforms: { strength: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute vec4 aBox; // half length, half width, soft rim, opacity (world units)
        varying vec2 vP;
        varying vec4 vBox;
        void main() {
          vBox = aBox;
          // local plane coordinates in world units (the instance matrix scales the unit quad)
          vP = vec2( position.x * 2.0 * ( aBox.x + aBox.z ), position.z * 2.0 * ( aBox.y + aBox.z ) );
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: /* glsl */ `
        uniform float strength;
        varying vec2 vP;
        varying vec4 vBox;
        void main() {
          vec2 h = vBox.xy;
          float r = min( min( h.x, h.y ) * 0.6, 0.35 );
          vec2 q = abs( vP ) - h + r;
          float d = length( max( q, 0.0 ) ) + min( max( q.x, q.y ), 0.0 ) - r;
          // darkest just inside the footprint edge, gone a soft rim outside it
          float a = 1.0 - smoothstep( -vBox.z * 0.6, vBox.z, d );
          a = a * a * vBox.w * strength;
          if ( a < 0.004 ) discard;
          gl_FragColor = vec4( 0.0, 0.0, 0.0, a );
        }`,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 1;
    this.mesh.count = 0;
    this.mesh.layers.set(CONTACT_LAYER);
    this.mesh.name = 'contact-shadows';
  }

  begin() {
    this.n = 0;
  }

  /**
   * One footprint. (x, z) centre, yaw of the unit root (radians, three.js
   * rotation.y), hl / hw = half length / half width (local x / z), soft = rim
   * width, alpha = opacity at the edge. The plane follows the terrain slope
   * under the footprint; `tilt` (optional) gives the root's own attitude.
   */
  add(map: GameMap, x: number, z: number, yaw: number, hl: number, hw: number, soft: number, alpha: number, tilt?: THREE.Quaternion) {
    if (this.n >= MAX || alpha <= 0.004) return;
    const y = standHeight(map, Math.min(map.w - 0.01, Math.max(0, x)), Math.min(map.h - 0.01, Math.max(0, z)));
    if (tilt) _q.copy(tilt);
    else {
      // slope from four samples across the footprint
      const e = Math.max(0.2, Math.min(1.2, Math.max(hl, hw)));
      const hx0 = this.h(map, x - e, z);
      const hx1 = this.h(map, x + e, z);
      const hz0 = this.h(map, x, z - e);
      const hz1 = this.h(map, x, z + e);
      _n.set(hx0 - hx1, 2 * e, hz0 - hz1).normalize();
      _q.setFromUnitVectors(UP, _n);
      _qy.setFromAxisAngle(UP, yaw);
      _q.multiply(_qy);
    }
    _p.set(x, y + 0.025, z);
    _s.set(2 * (hl + soft), 1, 2 * (hw + soft));
    _m.compose(_p, _q, _s);
    this.mesh.setMatrixAt(this.n, _m);
    this.box.setXYZW(this.n, hl, hw, soft, alpha);
    this.n++;
  }

  private h(map: GameMap, x: number, z: number) {
    return standHeight(map, Math.min(map.w - 0.01, Math.max(0, x)), Math.min(map.h - 0.01, Math.max(0, z)));
  }

  end() {
    this.mesh.count = this.n;
    (this.mesh.material as THREE.ShaderMaterial).uniforms.strength.value = this.strength;
    if (this.n) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.box.needsUpdate = true;
      this.mesh.instanceMatrix.addUpdateRange(0, this.n * 16);
      this.box.addUpdateRange(0, this.n * 4);
    }
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
