import * as THREE from 'three';
import { DEFS, buildingDef } from '../../sim/defs';
import { standHeight } from '../../sim/map';
import { IRON_BEAM_RADIUS, SW_INFO, type SwKind } from '../../sim/specialdefs';
import type { Entity, SimEvent } from '../../sim/types';
import type { World } from '../../sim/world';
import { BLASTS, type Effects } from '../effects';
import type { EnvDamage } from '../envdamage';

/*
 * Render side of garrisons, tech structures and superweapons (visual only,
 * not deterministic):
 *  - garrisoned infantry: muzzle flashes + tracers from the window facing the target;
 *  - village houses: the scenery damage stages follow the sim house hp
 *    (scorched, roof holes, collapse when the entity dies);
 *  - superweapons: target warning ring for everybody, oversized impact
 *    blasts (Hyunmoo-5 mushroom, Dark Eagle flashes), launch flares at the
 *    structure, the Iron Beam dome and its laser engagements.
 * Phone friendly: a handful of meshes, the heavy lifting is the shared
 * particle / light / shake systems of Effects.
 */

interface Ring {
  mesh: THREE.Mesh;
  x: number;
  y: number;
  r: number;
  t: number;
  max: number;
  color: number;
}

interface Dome {
  owner: number;
  x: number;
  y: number;
  group: THREE.Group;
  shell: THREE.Mesh;
  grid: THREE.LineSegments;
  emitter: THREE.Mesh;
  t: number;
  fade: number; // -1 while active, else seconds left of the fade-out
}

export interface SuperFxHost {
  world: World;
  effects: Effects;
  scene: THREE.Scene;
  env: EnvDamage | null;
  visibleAt(x: number, y: number): boolean;
  shake(amount: number, x?: number, y?: number): void;
}

const SW_WEAPON_BLAST: Record<string, { extra: number; ring: number; flash: number; mushroom?: boolean; color: number }> = {
  sw_darkEagle: { extra: 2, ring: 4.5, flash: 30, color: 0xfff2d0 },
  sw_hyunmoo5: { extra: 7, ring: 9, flash: 70, mushroom: true, color: 0xffe0a0 },
  sw_kheibar: { extra: 2, ring: 4.5, flash: 28, color: 0xffd090 },
  sw_fattah: { extra: 2, ring: 4, flash: 26, color: 0xfff0d0 },
  sw_taurus: { extra: 1, ring: 3, flash: 20, color: 0xffd8a0 },
  sw_neptune: { extra: 1, ring: 3, flash: 18, color: 0xffd8a0 },
  sw_tos2: { extra: 0, ring: 2.6, flash: 10, color: 0xffa040 },
};

export class SuperFx {
  readonly group = new THREE.Group();
  private rings: Ring[] = [];
  private domes: Dome[] = [];
  private ringGeo = new THREE.RingGeometry(0.92, 1, 64).rotateX(-Math.PI / 2);
  private discGeo = new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2);
  private houseSync = 0;
  private houseHp = new Map<number, number>();

  constructor(private host: SuperFxHost) {
    this.group.name = 'superfx';
    host.scene.add(this.group);
  }

  // ---------------------------------------------------------------- events

  /** Returns true when it fully handled the event (the renderer skips its default handling). */
  onEvent(ev: SimEvent): boolean {
    const h = this.host;
    const w = h.world;
    switch (ev.t) {
      case 'fire': {
        const src = w.get(ev.id);
        if (!src || src.inside < 0) return false;
        const house = w.get(src.inside);
        if (!house || house.kind !== 'building' || !buildingDef(house.def).garrison) return false;
        if (h.visibleAt(house.x, house.y) || h.visibleAt(ev.tx, ev.ty)) this.windowFire(house, ev.tx, ev.ty, ev.targetId);
        return true;
      }
      case 'superweapon':
        this.onSuperweapon(ev);
        return false;
      case 'impact': {
        const p = SW_WEAPON_BLAST[ev.weapon];
        if (p && !ev.air) this.bigImpact(ev.x, ev.y, ev.weapon, p);
        return false;
      }
      case 'launch': {
        if (!ev.weapon.startsWith('sw_') || !h.visibleAt(ev.x, ev.y)) return false;
        // a towering launch flare and smoke cloud at the structure
        const fx = h.effects;
        const g = standHeight(w.map, ev.x, ev.y);
        fx.flashLight(ev.x, g + 1, ev.y, 12, 0xffc070, 0.5);
        for (let i = 0; i < 6; i++) fx.smoke(ev.x + (Math.random() - 0.5) * 1.6, g + 0.2, ev.y + (Math.random() - 0.5) * 1.6, 2.2, false);
        if (ev.flight === 'ballistic' || ev.flight === 'hypersonic') h.shake(0.12, ev.x, ev.y);
        return false;
      }
      case 'death': {
        const d = DEFS[ev.def];
        if (d && d.kind === 'building' && buildingDef(ev.def).garrison) {
          this.houseHp.delete(ev.id);
          h.env?.syncSimHouse(ev.x - d.w / 2, ev.y - d.h / 2, 0);
        }
        return false;
      }
    }
    return false;
  }

  private windowFire(house: Entity, tx: number, ty: number, targetId: number) {
    const w = this.host.world;
    const fx = this.host.effects;
    const d = buildingDef(house.def);
    const dx = tx - house.x;
    const dy = ty - house.y;
    const l = Math.hypot(dx, dy) || 1;
    const nx = dx / l;
    const ny = dy / l;
    // the wall facing the target: exit point on the footprint box, a little jitter along the wall
    const k = Math.min(d.w / 2 / Math.max(1e-3, Math.abs(nx)), d.h / 2 / Math.max(1e-3, Math.abs(ny))) * 0.86;
    const side = (Math.random() - 0.5) * 0.7;
    const px = house.x + nx * k - ny * side;
    const pz = house.y + ny * k + nx * side;
    const g = standHeight(w.map, house.x, house.y);
    const pos = new THREE.Vector3(px, g + 0.32 + (Math.random() < 0.3 ? 0.25 : 0), pz);
    const dir = new THREE.Vector3(nx, 0, ny);
    fx.muzzle(pos, dir, 0.45);
    const t = w.get(targetId);
    const tz = t ? standHeight(w.map, t.x, t.y) + (t.kind === 'unit' ? 0.15 + (t.z ?? 0) : 0.4) : standHeight(w.map, tx, ty) + 0.2;
    fx.tracer(pos, new THREE.Vector3(tx, tz, ty), true, 1, false);
  }

  private onSuperweapon(ev: Extract<SimEvent, { t: 'superweapon' }>) {
    const h = this.host;
    const w = h.world;
    switch (ev.phase) {
      case 'launch': {
        const kind = ev.sw as SwKind;
        const info = SW_INFO[kind];
        if (kind === 'ironBeam') this.addDome(ev.owner, ev.x, ev.y);
        else this.addRing(ev.x, ev.y, info.radius + 0.5, 14, 0xff3020);
        break;
      }
      case 'beam': {
        if (!h.visibleAt(ev.x, ev.y) && !h.visibleAt(ev.tx ?? ev.x, ev.ty ?? ev.y)) break;
        const a = new THREE.Vector3(ev.x, ev.z ?? standHeight(w.map, ev.x, ev.y) + 0.7, ev.y);
        const b = new THREE.Vector3(ev.tx ?? ev.x, ev.tz ?? 2, ev.ty ?? ev.y);
        const fx = h.effects;
        fx.beam(a, b, 0x40e0ff, 0.12, 0.28);
        fx.beam(a, b, 0xe8ffff, 0.035, 0.22);
        for (let i = 0; i < 3; i++) fx.spark(b.x, b.y, b.z, 0x9ff4ff);
        fx.flashLight(b.x, b.y, b.z, 4, 0x60e8ff, 0.18);
        fx.flashLight(a.x, a.y + 0.3, a.z, 3, 0x60e8ff, 0.12);
        const d = this.domes.find((o) => o.owner === ev.owner && Math.hypot(o.x - ev.x, o.y - ev.y) < 0.1);
        if (d) (d.shell.material as THREE.ShaderMaterial).uniforms.uPulse.value = 1; // the dome flickers with each shot
        break;
      }
      case 'end': {
        for (const d of this.domes) if (d.owner === ev.owner && d.fade < 0 && Math.hypot(d.x - ev.x, d.y - ev.y) < 0.1) d.fade = 1.2;
        break;
      }
    }
  }

  private bigImpact(x: number, y: number, weapon: string, p: { extra: number; ring: number; flash: number; mushroom?: boolean; color: number }) {
    const h = this.host;
    const fx = h.effects;
    const g = Math.max(standHeight(h.world.map, x, y), 0);
    this.addRing(x, y, p.ring, 1.4, 0xffd0a0, true);
    h.env?.scorchAt(x, y, p.ring * 0.5);
    if (!h.visibleAt(x, y)) return;
    fx.flashLight(x, g + 2, y, p.flash, p.color, p.mushroom ? 1.4 : 0.6);
    for (let i = 0; i < p.extra; i++) {
      const a = (i / Math.max(1, p.extra)) * Math.PI * 2 + Math.random();
      const r = p.ring * 0.35 * Math.random();
      fx.after(0.08 + i * 0.09, () => fx.blast(i % 2 ? BLASTS.building : BLASTS.ballistic, x + Math.cos(a) * r, g + 0.3, y + Math.sin(a) * r, g));
    }
    fx.ring(x, g + 0.08, y, 0.4, p.ring * 1.6, 0.9, 0xfff0d0, true, 0.6);
    if (p.mushroom) {
      // Hyunmoo-5: a rising mushroom of fire and dust, a second shock ring, a long shake
      fx.ring(x, g + 0.1, y, 1, p.ring * 2.4, 1.6, 0xd8c8a8, false, 0.5);
      for (let i = 0; i < 14; i++) fx.after(0.15 + i * 0.07, () => fx.column(x + (Math.random() - 0.5) * 1.2, g + 0.5 + i * 0.28, y + (Math.random() - 0.5) * 1.2, 2.6, i > 6));
      for (let i = 0; i < 10; i++) fx.after(0.9 + i * 0.05, () => fx.smoke(x + (Math.random() - 0.5) * 3, g + 4.2 + Math.random(), y + (Math.random() - 0.5) * 3, 3.2, true));
      h.shake(0.9, x, y);
      fx.after(0.4, () => h.shake(0.5, x, y));
    } else h.shake(0.3, x, y);
    if (weapon === 'sw_tos2') fx.flame(x, g + 0.2, y, 1.6);
  }

  // ----------------------------------------------------------------- rings

  private addRing(x: number, y: number, r: number, life: number, color: number, flash = false) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(flash ? this.discGeo : this.ringGeo, mat);
    mesh.renderOrder = 3;
    this.group.add(mesh);
    this.rings.push({ mesh, x, y, r, t: 0, max: life, color });
  }

  // ------------------------------------------------------------------ dome

  private addDome(owner: number, x: number, y: number) {
    const R = IRON_BEAM_RADIUS;
    const group = new THREE.Group();
    const shellMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uAlpha: { value: 0 }, uPulse: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vV; varying float vH;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vN = normalize(mat3(modelMatrix) * normal);
          vV = normalize(cameraPosition - wp.xyz);
          vH = position.y;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uAlpha; uniform float uPulse;
        varying vec3 vN; varying vec3 vV; varying float vH;
        void main() {
          float rim = pow(1.0 - abs(dot(vN, vV)), 2.5);
          float bands = 0.5 + 0.5 * sin(vH * 9.0 - uTime * 3.0);
          float a = (0.025 + rim * (0.5 + uPulse * 0.25) + bands * 0.035 + uPulse * 0.03) * uAlpha;
          gl_FragColor = vec4(vec3(0.35, 0.9, 1.0) * (1.0 + uPulse * 0.4), a);
        }`,
    });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 14, 0, Math.PI * 2, 0, Math.PI / 2), shellMat);
    shell.scale.set(R, R * 0.55, R);
    shell.renderOrder = 5;
    const gridMat = new THREE.LineBasicMaterial({ color: 0x60e8ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const grid = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.SphereGeometry(1, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2)), gridMat);
    grid.scale.copy(shell.scale);
    const emMat = new THREE.MeshBasicMaterial({ color: 0x9ff8ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const emitter = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 8), emMat);
    const g = Math.max(standHeight(this.host.world.map, x, y), 0);
    group.position.set(x, g, y);
    emitter.position.set(0, 0.7, 0);
    group.add(shell, grid, emitter);
    this.group.add(group);
    this.domes.push({ owner, x, y, group, shell, grid, emitter, t: 0, fade: -1 });
    this.addRing(x, y, R, 1.6, 0x60e8ff, false);
    this.host.effects.flashLight(x, g + 1.5, y, 14, 0x60e8ff, 0.8);
  }

  // ---------------------------------------------------------------- update

  update(dt: number, time: number) {
    const w = this.host.world;
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      const k = r.t / r.max;
      if (k >= 1) {
        this.group.remove(r.mesh);
        (r.mesh.material as THREE.Material).dispose();
        this.rings.splice(i, 1);
        continue;
      }
      const g = Math.max(standHeight(w.map, r.x, r.y), 0) + 0.12;
      const flash = r.mesh.geometry === this.discGeo;
      const s = flash ? r.r * (0.3 + 0.7 * Math.sqrt(k)) : r.r * (1 + 0.05 * Math.sin(time * 8));
      r.mesh.position.set(r.x, g, r.y);
      r.mesh.scale.set(s, 1, s);
      const m = r.mesh.material as THREE.MeshBasicMaterial;
      m.opacity = flash ? 0.7 * (1 - k) * (1 - k) : (0.45 + 0.35 * Math.abs(Math.sin(time * 5))) * Math.min(1, (1 - k) * 4);
      m.visible = this.host.visibleAt(r.x, r.y) || !flash;
    }
    for (let i = this.domes.length - 1; i >= 0; i--) {
      const d = this.domes[i];
      d.t += dt;
      const mat = d.shell.material as THREE.ShaderMaterial;
      let a = Math.min(1, d.t / 0.8);
      if (d.fade >= 0) {
        d.fade -= dt;
        a = Math.max(0, d.fade / 1.2);
        if (d.fade <= 0) {
          this.group.remove(d.group);
          d.shell.geometry.dispose();
          mat.dispose();
          d.grid.geometry.dispose();
          (d.grid.material as THREE.Material).dispose();
          (d.emitter.material as THREE.Material).dispose();
          this.domes.splice(i, 1);
          continue;
        }
      }
      mat.uniforms.uTime.value = time;
      mat.uniforms.uAlpha.value = a;
      mat.uniforms.uPulse.value = Math.max(0, mat.uniforms.uPulse.value - dt * 3);
      if (d.t > 0.2 && d.t < 0.6) mat.uniforms.uPulse.value = 0.6;
      (d.grid.material as THREE.LineBasicMaterial).opacity = 0.16 * a;
      d.grid.rotation.y = time * 0.05;
      d.emitter.scale.setScalar(0.8 + 0.25 * Math.sin(time * 9));
      (d.emitter.material as THREE.MeshBasicMaterial).opacity = 0.9 * a;
    }
    // village house damage follows the sim hp (scenery stages)
    this.houseSync -= dt;
    if (this.houseSync <= 0 && this.host.env) {
      this.houseSync = 0.3;
      for (const e of w.list) {
        if (e.dead || e.kind !== 'building') continue;
        const bd = buildingDef(e.def);
        if (!bd.garrison) continue;
        const f = e.hp / e.maxHp;
        if (this.houseHp.get(e.id) === f) continue;
        this.houseHp.set(e.id, f);
        this.host.env.syncSimHouse(e.tx, e.ty, f);
      }
    }
  }

  dispose() {
    this.host.scene.remove(this.group);
  }
}
