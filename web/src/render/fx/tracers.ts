import * as THREE from 'three';

/*
 * Pooled tracer bolts: short glowing streaks that actually travel from the
 * muzzle to the target (machine guns, autocannons), one instanced draw call
 * for all of them. Replaces creating a mesh + material per shot.
 */

interface Bolt {
  ax: number;
  ay: number;
  az: number;
  bx: number;
  by: number;
  bz: number;
  delay: number;
  t: number;
  dur: number;
  len: number;
  width: number;
  r: number;
  g: number;
  b: number;
}

export class Tracers {
  readonly mesh: THREE.InstancedMesh;
  private bolts: Bolt[] = [];
  private n = 0;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();
  private d = new THREE.Vector3();
  private z = new THREE.Vector3(0, 0, 1);
  private col = new THREE.Color();
  /** Called once when a bolt arrives (impact sparks), with the bolt's end point. */
  onArrive: ((x: number, y: number, z: number) => void) | null = null;

  constructor(private max: number) {
    // unit streak along +Z from 0 to 1, tapered towards the tail
    const geo = new THREE.CylinderGeometry(1, 0.35, 1, 5, 1, true).translate(0, 0.5, 0).rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    for (let i = 0; i < max; i++) this.bolts.push({ ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, delay: 0, t: 0, dur: 0, len: 0, width: 0, r: 0, g: 0, b: 0 });
  }

  get active() {
    return this.n;
  }

  /** speed in tiles/s; len = visible streak length. */
  fire(a: THREE.Vector3, b: THREE.Vector3, color = 0xffc860, width = 0.02, speed = 40, len = 0.7, delay = 0) {
    if (this.n >= this.max) return;
    const o = this.bolts[this.n++];
    o.ax = a.x;
    o.ay = a.y;
    o.az = a.z;
    o.bx = b.x;
    o.by = b.y;
    o.bz = b.z;
    const dist = Math.max(0.05, a.distanceTo(b));
    o.dur = dist / speed;
    o.len = Math.min(len, dist);
    o.t = 0;
    o.delay = delay;
    o.width = width;
    o.r = ((color >> 16) & 255) / 255;
    o.g = ((color >> 8) & 255) / 255;
    o.b = (color & 255) / 255;
  }

  update(dt: number) {
    let w = 0;
    let shown = 0;
    for (let i = 0; i < this.n; i++) {
      const o = this.bolts[i];
      if (o.delay > 0) {
        o.delay -= dt;
      } else {
        o.t += dt;
        if (o.t >= o.dur) {
          this.onArrive?.(o.bx, o.by, o.bz);
          continue;
        }
        // head position along the path; tail trails behind by len
        const k = o.t / o.dur;
        this.d.set(o.bx - o.ax, o.by - o.ay, o.bz - o.az);
        const dist = this.d.length();
        this.d.divideScalar(dist);
        const head = k * dist;
        const tail = Math.max(0, head - o.len);
        this.p.set(o.ax + this.d.x * head, o.ay + this.d.y * head, o.az + this.d.z * head);
        // streak points from the head backwards (+Z of the geometry = towards the tail)
        this.q.setFromUnitVectors(this.z, this.d.negate());
        this.s.set(o.width, o.width, Math.max(0.01, head - tail));
        this.m4.compose(this.p, this.q, this.s);
        this.mesh.setMatrixAt(shown, this.m4);
        this.col.setRGB(o.r * 2, o.g * 2, o.b * 2);
        this.mesh.setColorAt(shown, this.col);
        shown++;
      }
      if (w !== i) {
        this.bolts[i] = this.bolts[w];
        this.bolts[w] = o;
      }
      w++;
    }
    this.n = w;
    this.mesh.count = shown;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
