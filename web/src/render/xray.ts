import * as THREE from 'three';
import { HEAT_LAYER } from './thermal';

/** Camera layer of the silhouette proxies: only the main view camera enables it (not the drone feed / heat mask). */
export const XRAY_LAYER = 21;

/*
 * X-ray silhouettes and heat tagging for unit models.
 *
 * For every unit visual the few largest meshes (hull, turret, body...) get
 *  - HEAT_LAYER enabled, so the thermal heat-mask pass draws them, and
 *  - (own units, and enemy units the player can see) a child "proxy" mesh that
 *    shares the geometry and draws only where the unit is hidden: depth test
 *    GREATER against the scene depth, pulled a little towards the camera in the
 *    vertex shader so the unit's own surfaces never trigger it. Front faces only,
 *    no depth writes, rendered late. It is part of the normal scene render, so it
 *    works with every post chain, MSAA, the perspective camera and view rotation.
 * Only a handful of meshes per unit are used, which keeps the extra draw calls low.
 */

const XRAY_VERT = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
uniform float bias;
varying float vRim;
void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vec3 v = normalize(-mvPosition.xyz);
  vRim = 1.0 - abs(dot(normalize(transformedNormal), v));
  mvPosition.xyz += v * bias;
  gl_Position = projectionMatrix * mvPosition;
}`;

const XRAY_FRAG = /* glsl */ `
uniform vec3 color;
uniform float opacity;
uniform float time;
varying float vRim;
void main() {
  float r = pow(clamp(vRim, 0.0, 1.0), 1.6);
  float a = (0.16 + 0.84 * r) * opacity * (0.88 + 0.12 * sin(time * 4.0));
  gl_FragColor = vec4(color * (0.75 + 0.6 * r), a);
}`;

function xrayMaterial(color: THREE.Color, opacity: number, bias: number, time: { value: number }): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: color }, opacity: { value: opacity }, bias: { value: bias }, time },
    vertexShader: XRAY_VERT,
    fragmentShader: XRAY_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    depthFunc: THREE.GreaterDepth,
    side: THREE.FrontSide,
    toneMapped: false,
    fog: false,
  });
}

interface Tagged {
  root: THREE.Object3D;
  proxies: THREE.Mesh[];
  hot: THREE.Mesh[];
}

/** Solid meshes of a model, largest first (by bounding radius), skipping transparent / effect parts. */
function solidMeshes(root: THREE.Object3D): { m: THREE.Mesh; r: number }[] {
  const list: { m: THREE.Mesh; r: number }[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry || (m as unknown as { isXray?: boolean }).isXray) return;
    const mat = m.material as THREE.Material;
    if (Array.isArray(m.material) || !mat || mat.transparent || !mat.visible || (mat as THREE.ShaderMaterial).isShaderMaterial) return;
    if (!m.geometry.attributes.position || !m.geometry.attributes.normal) return;
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
    const s = m.getWorldScale(new THREE.Vector3());
    list.push({ m, r: (m.geometry.boundingSphere?.radius ?? 0) * Math.max(s.x, s.y, s.z) });
  });
  list.sort((a, b) => b.r - a.r);
  return list;
}
const box = new THREE.Box3();
const boxSize = new THREE.Vector3();

export class UnitTagger {
  /** X-ray silhouettes on / off (heat tagging always runs). */
  xray = true;
  private ownColor: THREE.Color;
  private enemyColor = new THREE.Color(0xff3a2a);
  private time = { value: 0 };
  /** Materials by side and depth bias step. */
  private mats = new Map<string, THREE.ShaderMaterial>();
  private tagged = new Map<number, Tagged>();
  private seen = new Set<number>();

  constructor(teamColor: number) {
    // brighten the team colour a little so it reads over dark roofs and canopies
    this.ownColor = new THREE.Color(teamColor).lerp(new THREE.Color(0xffffff), 0.25);
  }

  /**
   * The silhouette is pulled towards the camera by about the model's own size, so the model's
   * parts never x-ray through each other (a container on a truck bed, a turret over the hull).
   */
  private material(own: boolean, radius: number): THREE.ShaderMaterial {
    const step = Math.round(Math.max(0.3, Math.min(1.6, radius)) * 10);
    const key = `${own ? 'o' : 'e'}${step}`;
    let m = this.mats.get(key);
    if (!m) {
      m = own ? xrayMaterial(this.ownColor, 0.85, step / 10, this.time) : xrayMaterial(this.enemyColor, 0.55, step / 10, this.time);
      this.mats.set(key, m);
    }
    return m;
  }

  /** Called once per frame with the renderer's live visuals. */
  update(visuals: Iterable<{ id: number; owner: number; def: string; model: { root: THREE.Object3D }; visible: boolean }>, viewer: number, isUnit: (def: string) => boolean, time: number) {
    this.time.value = time;
    const seen = this.seen;
    seen.clear();
    for (const v of visuals) {
      if (!isUnit(v.def)) continue;
      seen.add(v.id);
      let t = this.tagged.get(v.id);
      if (t && t.root !== v.model.root) {
        this.untag(t, true);
        t = undefined;
      }
      if (!t) {
        t = this.tag(v.model.root, viewer >= 0 && v.owner >= 0 ? v.owner === viewer : null);
        this.tagged.set(v.id, t);
      }
      for (const p of t.proxies) p.visible = this.xray;
    }
    for (const [id, t] of this.tagged) {
      if (seen.has(id)) continue;
      // the model became a wreck (or vanished): no more silhouettes, but a burning wreck stays hot
      this.untag(t, false);
      this.tagged.delete(id);
    }
  }

  private tag(root: THREE.Object3D, own: boolean | null): Tagged {
    const solid = solidMeshes(root);
    const hot = solid.map((x) => x.m);
    for (const m of hot) m.layers.enable(HEAT_LAYER);
    const proxies: THREE.Mesh[] = [];
    if (own === null) return { root, proxies, hot };
    box.setFromObject(root);
    const radius = box.isEmpty() ? 0.4 : box.getSize(boxSize).length() * 0.5;
    const mat = this.material(own, radius * 0.95);
    let n = 0;
    for (const { m } of solid) {
      if ((m as THREE.InstancedMesh).isInstancedMesh || (m as THREE.SkinnedMesh).isSkinnedMesh) continue;
      if (++n > 4) break;
      const p = new THREE.Mesh(m.geometry, mat);
      (p as unknown as { isXray: boolean }).isXray = true;
      p.renderOrder = 30;
      p.layers.set(XRAY_LAYER);
      p.castShadow = false;
      p.receiveShadow = false;
      p.frustumCulled = m.frustumCulled;
      m.add(p);
      proxies.push(p);
    }
    return { root, proxies, hot };
  }

  private untag(t: Tagged, cool: boolean) {
    for (const p of t.proxies) p.removeFromParent();
    t.proxies.length = 0;
    if (cool) for (const m of t.hot) m.layers.disable(HEAT_LAYER);
  }

  dispose() {
    for (const t of this.tagged.values()) this.untag(t, true);
    this.tagged.clear();
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
  }
}
