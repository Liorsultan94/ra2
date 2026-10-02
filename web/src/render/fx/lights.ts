import * as THREE from 'three';
import type { FogOfWar } from '../fog';

/*
 * Dynamic battlefield light.
 *
 * Every explosion, muzzle flash, rocket motor, flare and burning wreck
 * registers a light *source* (cheap plain data). Once per frame the sources
 * are scored by brightness and distance to the view centre and the best few
 * drive a small fixed pool of PointLights (the pool never changes size, so
 * no shader recompiles). Every source - including those that did not get a
 * real light, and on low quality where there are none - also gets an additive
 * "light pool" glow decal on the ground, which reads as light spilling onto
 * the terrain and nearby units for the cost of one instanced draw call.
 */

interface Src {
  x: number;
  y: number;
  z: number;
  r: number;
  g: number;
  b: number;
  power: number;
  life: number;
  max: number;
  flicker: number;
  /** current brightness and selection score (scratch) */
  i: number;
  s: number;
}

function makeSrc(): Src {
  return { x: 0, y: 0, z: 0, r: 1, g: 1, b: 1, power: 0, life: 0, max: 1, flicker: 0, i: 0, s: 0 };
}

function glowTexture(): THREE.Texture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.15)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}

const byScore = (a: Src, b: Src) => b.s - a.s;
const MAX_FLASH = 64;
const MAX_SUSTAIN = 96;

export class FxLights {
  readonly group = new THREE.Group();
  private lights: THREE.PointLight[] = [];
  private flashes: Src[] = [];
  private nFlash = 0;
  private sus: Src[] = [];
  private nSus = 0;
  private order: Src[] = [];
  private glow: THREE.InstancedMesh;
  private maxGlow: number;
  private m4 = new THREE.Matrix4();
  private col = new THREE.Color();
  private time = 0;
  /** View centre (the camera target); sources far from it lose priority. */
  view: THREE.Vector3 | null = null;
  heightAt: (x: number, z: number) => number = () => 0;

  constructor(quality: 'low' | 'medium' | 'high', fog: FogOfWar) {
    const n = quality === 'high' ? 6 : quality === 'medium' ? 3 : 0;
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight(0xffa040, 0, 9, 1.4);
      this.lights.push(l);
      this.group.add(l);
    }
    for (let i = 0; i < MAX_FLASH; i++) this.flashes.push(makeSrc());
    for (let i = 0; i < MAX_SUSTAIN; i++) this.sus.push(makeSrc());
    this.maxGlow = quality === 'low' ? 24 : 48;
    const mat = fog.apply(
      new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, toneMapped: false }),
    );
    this.glow = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), mat, this.maxGlow);
    this.glow.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.maxGlow * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.glow.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.glow.count = 0;
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 1;
    this.group.add(this.glow);
  }

  /**
   * The strongest current sources (after update(): last frame's ranking) as
   * position + intensity and colour, for shaders that want a cheap fire glow
   * (smoke lit from below). Unused entries get intensity 0.
   */
  strongest(pos: THREE.Vector4[], col: THREE.Vector3[]) {
    for (let i = 0; i < pos.length; i++) {
      const s = this.top[i];
      if (s && i < this.nTop) {
        pos[i].set(s.x, s.y, s.z, s.i);
        col[i].set(s.r, s.g, s.b);
      } else pos[i].w = 0;
    }
  }
  private top: Src[] = [];
  private nTop = 0;

  get lightCount() {
    return this.lights.length;
  }

  /** A short flash of light (explosion, muzzle flash). power ~ 1 (small) .. 16 (ballistic warhead). */
  flash(x: number, y: number, z: number, power: number, color: number, life: number, flicker = 0) {
    let s: Src;
    if (this.nFlash < MAX_FLASH) s = this.flashes[this.nFlash++];
    else {
      // replace the weakest remaining flash
      s = this.flashes[0];
      let best = Infinity;
      for (let i = 0; i < MAX_FLASH; i++) {
        const f = this.flashes[i];
        const rem = f.power * (1 - f.life / f.max);
        if (rem < best) {
          best = rem;
          s = f;
        }
      }
    }
    this.set(s, x, y, z, power, color, flicker);
    s.life = 0;
    s.max = Math.max(0.03, life);
  }

  /** A light that exists for this frame only (motors, fires, flares): call every frame while it burns. */
  sustain(x: number, y: number, z: number, power: number, color: number, flicker = 0.25) {
    if (this.nSus >= MAX_SUSTAIN) return;
    const s = this.sus[this.nSus++];
    this.set(s, x, y, z, power, color, flicker);
    s.life = 0;
    s.max = 1e9;
  }

  private set(s: Src, x: number, y: number, z: number, power: number, color: number, flicker: number) {
    s.x = x;
    s.y = y;
    s.z = z;
    s.r = ((color >> 16) & 255) / 255;
    s.g = ((color >> 8) & 255) / 255;
    s.b = (color & 255) / 255;
    s.power = power;
    s.flicker = flicker;
  }

  private vx = 0;
  private vz = 0;
  private score(s: Src) {
    const dx = s.x - this.vx;
    const dz = s.z - this.vz;
    s.s = s.i / (1 + (dx * dx + dz * dz) / 100);
    if (s.s > 0.05) this.order.push(s);
  }

  update(dt: number) {
    this.time += dt;
    const t = this.time;
    const order = this.order;
    order.length = 0;
    this.vx = this.view?.x ?? 0;
    this.vz = this.view?.z ?? 0;
    // age flashes, compact the live ones
    let w = 0;
    for (let i = 0; i < this.nFlash; i++) {
      const s = this.flashes[i];
      s.life += dt;
      if (s.life >= s.max) continue;
      const k = 1 - s.life / s.max;
      s.i = s.power * k * k * (1 - s.flicker * 0.5 * (1 + Math.sin(t * 37 + s.x * 13)));
      this.score(s);
      if (w !== i) {
        this.flashes[i] = this.flashes[w];
        this.flashes[w] = s;
      }
      w++;
    }
    this.nFlash = w;
    for (let i = 0; i < this.nSus; i++) {
      const s = this.sus[i];
      s.i = s.power * (1 - s.flicker * (0.5 + 0.3 * Math.sin(t * 23 + s.x * 7) + 0.2 * Math.sin(t * 41 + s.z * 5)));
      this.score(s);
    }
    this.nSus = 0;
    order.sort(byScore);
    // keep copies of the best few (the Src objects are recycled next frame)
    this.nTop = Math.min(4, order.length);
    for (let i = 0; i < this.nTop; i++) {
      const s = (this.top[i] ??= makeSrc());
      const o = order[i];
      s.x = o.x;
      s.y = o.y;
      s.z = o.z;
      s.i = o.i;
      s.r = o.r;
      s.g = o.g;
      s.b = o.b;
    }
    // real lights for the strongest sources
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const s = order[i];
      if (!s) {
        l.intensity = 0;
        continue;
      }
      l.position.set(s.x, s.y + 0.5, s.z);
      l.color.setRGB(s.r, s.g, s.b);
      l.distance = 4 + s.i * 0.8;
      l.intensity = s.i * 1.6;
    }
    // ground light pools for everything
    let n = 0;
    for (let i = 0; i < order.length && n < this.maxGlow; i++) {
      const s = order[i];
      const g = this.heightAt(s.x, s.z);
      const hk = Math.max(0, 1 - (s.y - g) / 6);
      if (hk <= 0.02) continue;
      const k = Math.min(1.2, s.i * 0.09) * hk;
      if (k < 0.02) continue;
      const r = (0.5 + Math.sqrt(s.power) * 0.75) * (0.85 + 0.15 * hk);
      this.m4.makeScale(r, 1, r);
      this.m4.setPosition(s.x, g + 0.06, s.z);
      this.glow.setMatrixAt(n, this.m4);
      this.col.setRGB(s.r * k * 0.9, s.g * k * 0.75, s.b * k * 0.6);
      this.glow.setColorAt(n, this.col);
      n++;
    }
    this.glow.count = n;
    this.glow.instanceMatrix.needsUpdate = true;
    if (this.glow.instanceColor) this.glow.instanceColor.needsUpdate = true;
  }
}
