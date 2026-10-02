import * as THREE from 'three';

/**
 * Expanding ground rings (blast shockwaves, water splashes, order markers,
 * placement rings) as two instanced draws (additive / normal blending)
 * instead of one mesh + one freshly compiled material per ring. Busy battles
 * near water kept ~300 rings alive at once (= 300 draw calls and as many
 * material set-ups per frame).
 */

const VERT = /* glsl */ `
attribute vec4 aCol;
varying vec4 vCol;
void main() {
  vCol = aCol;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const FRAG = /* glsl */ `
varying vec4 vCol;
void main() {
  gl_FragColor = vCol;
  #include <colorspace_fragment>
}`;

interface Ring {
  x: number;
  y: number;
  z: number;
  r0: number;
  r1: number;
  life: number;
  max: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

class Pool {
  readonly mesh: THREE.InstancedMesh;
  private col: THREE.InstancedBufferAttribute;
  items: Ring[] = [];
  private m = new THREE.Matrix4();

  constructor(
    geo: THREE.BufferGeometry,
    additive: boolean,
    private cap: number,
  ) {
    const g = geo.clone();
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.col.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aCol', this.col);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.InstancedMesh(g, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.name = additive ? 'rings+' : 'rings';
  }

  add(r: Ring) {
    if (this.items.length >= this.cap) this.items.shift();
    this.items.push(r);
  }

  update(dt: number) {
    const it = this.items;
    let n = 0;
    const c = this.col.array as Float32Array;
    for (let i = 0; i < it.length; i++) {
      const r = it[i];
      r.life += dt;
      const k = r.life / r.max;
      if (k >= 1) continue;
      it[n] = r;
      const s = r.r0 + (r.r1 - r.r0) * Math.sqrt(k);
      this.m.makeScale(s, s, s).setPosition(r.x, r.y, r.z);
      this.mesh.setMatrixAt(n, this.m);
      c[n * 4] = r.r;
      c[n * 4 + 1] = r.g;
      c[n * 4 + 2] = r.b;
      c[n * 4 + 3] = r.a * (1 - k);
      n++;
    }
    it.length = n;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n) {
      this.mesh.instanceMatrix.clearUpdateRanges();
      this.mesh.instanceMatrix.addUpdateRange(0, n * 16);
      this.mesh.instanceMatrix.needsUpdate = true;
      this.col.clearUpdateRanges();
      this.col.addUpdateRange(0, n * 4);
      this.col.needsUpdate = true;
    }
  }
}

export class RingPool {
  readonly group = new THREE.Group();
  private add: Pool;
  private norm: Pool;
  private c = new THREE.Color();

  constructor(geo: THREE.BufferGeometry, cap = 384) {
    this.add = new Pool(geo, true, cap);
    this.norm = new Pool(geo, false, cap);
    this.group.add(this.add.mesh, this.norm.mesh);
  }

  /** Same arguments as Effects.ring(). */
  ring(x: number, y: number, z: number, r0: number, r1: number, life: number, color: number, additive: boolean, opacity: number) {
    const c = this.c.setHex(color);
    (additive ? this.add : this.norm).add({ x, y, z, r0, r1, life: 0, max: Math.max(0.01, life), r: c.r, g: c.g, b: c.b, a: opacity });
  }

  update(dt: number) {
    this.add.update(dt);
    this.norm.update(dt);
  }
}
