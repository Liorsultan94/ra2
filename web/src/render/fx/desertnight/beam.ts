import * as THREE from 'three';
import type { FogOfWar } from '../../fog';
import { FOG_GLSL } from '../../fog';
import type { LightUniforms } from './lights';

/*
 * The lighthouse beam (NT1): a long soft cone turning round the lantern once every ~13 s, visible in the night's
 * light haze, brighter when it swings towards the camera (forward scattering), a second faint wide cone round it
 * and a very faint halo at the lamp; the lamp itself is a small bright point (lights.ts sprite). Two thin meshes
 * per lighthouse; nothing per frame but their yaw. Gentle: the beam never glares.
 */

const VERT = /* glsl */ `
uniform vec3 uLamp;
uniform vec3 uDir;
varying float vT;
varying float vFace;
varying float vFwd;
varying vec3 vW;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  // the cone's surface faces outwards from its axis (local x): its radial direction, turned by the mesh's rotation only
  mat3 R = mat3( normalize( modelMatrix[0].xyz ), normalize( modelMatrix[1].xyz ), normalize( modelMatrix[2].xyz ) );
  vec3 n = normalize( R * vec3( 0.0, position.y, position.z ) );
  vec3 v = normalize( cameraPosition - wp.xyz );
  vFace = abs( dot( n, v ) );
  vT = position.x;
  vW = wp.xyz;
  // towards the viewer along the beam: the haze scatters most of the light forwards
  vFwd = max( dot( uDir, normalize( cameraPosition - uLamp ) ), 0.0 );
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FRAG = /* glsl */ `
uniform float uNight;
uniform float uStrength;
uniform vec3 uColor;
varying float vT;
varying float vFace;
varying float vFwd;
varying vec3 vW;
${FOG_GLSL}
void main() {
  float a = pow( 1.0 - clamp( vT, 0.0, 1.0 ), 1.5 ) * smoothstep( 0.0, 0.05, vT ) * pow( vFace, 2.2 );
  a *= 0.55 + 1.1 * pow( vFwd, 3.0 );
  float vis = 1.0;
  if ( fogEnabled > 0.5 ) vis = smoothstep( 0.1, 0.45, fogSample( vW ) );
  gl_FragColor = vec4( uColor * a * uStrength * uNight * vis, 1.0 );
}`;

export interface Lantern {
  x: number;
  y: number;
  z: number;
  ph: number;
}

interface One {
  pivot: THREE.Group;
  lamp: THREE.Vector3;
  ph: number;
  mats: THREE.ShaderMaterial[];
}

export class LighthouseBeams {
  readonly group = new THREE.Group();
  private list: One[] = [];

  constructor(fog: FogOfWar, lanterns: readonly Lantern[], uniforms: LightUniforms) {
    this.group.name = 'desert-lighthouse-beams';
    const fu = fog.uniforms as unknown as Record<string, THREE.IUniform>;
    const geo = new THREE.CylinderGeometry(1, 0.03, 1, 18, 1, true).translate(0, 0.5, 0).rotateZ(-Math.PI / 2);
    for (const L of lanterns) {
      const pivot = new THREE.Group();
      pivot.position.set(L.x, L.y, L.z);
      const lamp = new THREE.Vector3(L.x, L.y, L.z);
      const mats: THREE.ShaderMaterial[] = [];
      // (length, end radius, strength): the wide veil, the beam, its bright core
      for (const [len, rad, k] of [[17, 1.3, 0.1], [15, 0.55, 0.16], [10, 0.2, 0.2]] as const) {
        const mat = new THREE.ShaderMaterial({
          uniforms: { ...fu, uNight: uniforms.uNight, uStrength: { value: k }, uColor: { value: new THREE.Color(1.0, 0.9, 0.66) }, uLamp: { value: lamp }, uDir: { value: new THREE.Vector3(1, 0, 0) } },
          vertexShader: VERT,
          fragmentShader: FRAG,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
          toneMapped: false,
        });
        mats.push(mat);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.scale.set(len, rad, rad);
        mesh.frustumCulled = false;
        mesh.renderOrder = 6;
        pivot.add(mesh);
      }
      this.group.add(pivot);
      this.list.push({ pivot, lamp, ph: L.ph, mats });
    }
  }

  update(night: number, time: number) {
    this.group.visible = night > 0.01 && this.list.length > 0;
    if (!this.group.visible) return;
    for (const o of this.list) {
      // one turn every 13 s; the beam lies a hair above the sea
      const yaw = -(time * 0.48 + o.ph);
      o.pivot.rotation.set(0, yaw, 0.0);
      for (const m of o.mats) (m.uniforms.uDir.value as THREE.Vector3).set(Math.cos(yaw), 0, -Math.sin(yaw));
    }
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) (mesh.material as THREE.Material).dispose();
    });
  }
}
