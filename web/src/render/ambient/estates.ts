import * as THREE from 'three';
import type { GameMap } from '../../sim/map';
import type { Effects } from '../effects';
import { estatePlans, tractorAt, tractorGeometry, tractorRoute, type TractorRoute } from '../farm';
import type { FogOfWar } from '../fog';
import { surfaceHeight } from '../ground';
import type { Layout } from '../layout';
import { walkable, wrapAngle, type AmbientFrame, type FogProbe, type Quality } from './shared';

/*
 * The tractors at work on the desert farm estates (render/farm.ts estatePlans): one per estate, driving up and
 * down one field (between the vine rows / tree lines with a sprayer, over the fodder or the stubble with a harrow,
 * along the tramlines in wheat), turning on the headland, a little dust kicked up behind it on the dry ground.
 *
 * Render-only life (never in the sim): the routes come from the estate hashes, the drive from the frame clock.
 * Like the rest of the ambient life it is hidden wherever the viewer does not see now (fog of war), and the
 * driver stops while military units are close or something stands in the way (a building on the field),
 * then carries on. One small mesh per tractor; medium and high (low: none, as the farm's own tractor).
 */

const SPEED = 0.11;
/** Military units this close stop the tractor (tiles). */
const WARY = 3;

interface Tractor {
  mesh: THREE.Mesh;
  route: TractorRoute;
  s: number;
  seg: number;
  yaw: number;
  v: number;
  /** Dust per second on this field's ground (0: none). */
  dust: number;
  x: number;
  z: number;
}

const _at = { x: 0, z: 0, yaw: 0 };

export class EstateTractors {
  readonly group = new THREE.Group();
  private tractors: Tractor[] = [];
  private mat: THREE.MeshStandardMaterial | null = null;

  constructor(
    private map: GameMap,
    layout: Layout,
    fog: FogOfWar,
    private probe: FogProbe,
    private effects: Effects,
    quality: Quality,
  ) {
    this.group.name = 'ambient-estate-tractors';
    if (quality === 'low' || map.biome !== 'desert') return;
    const plans = estatePlans(map, layout);
    if (!plans.some((p) => p.tractor)) return;
    const mat = (this.mat = fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.25 })));
    for (const p of plans) {
      const t = p.tractor;
      if (!t) continue;
      const e = p.fields[t.field];
      const route = tractorRoute(e.f, t.passes, t.reach);
      const mesh = new THREE.Mesh(tractorGeometry(new THREE.Color(t.paint), t.tool), mat);
      mesh.name = 'estate-tractor';
      mesh.castShadow = quality === 'high';
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      // (starts somewhere along its work: the estate's hash)
      const tr: Tractor = { mesh, route, s: ((p.k * 0.618034) % 1) * route.len * 2, seg: 0, yaw: 0, v: SPEED, dust: e.crop === 'fodder' ? 0.5 : e.crop === 'wheat' ? 0.35 : 1, x: 0, z: 0 };
      tr.seg = tractorAt(route, tr.s, 0, _at);
      tr.yaw = _at.yaw;
      tr.x = _at.x;
      tr.z = _at.z;
      this.tractors.push(tr);
      this.group.add(mesh);
    }
  }

  get count() {
    return this.tractors.length;
  }

  update(f: AmbientFrame) {
    const dt = Math.min(0.1, f.dt);
    for (const t of this.tractors) {
      // stop for troops close by, or anything standing on the way ahead; pull away gently again
      let wait = false;
      for (let i = 0; i < f.nUnits && !wait; i++) {
        const dx = f.units[i * 2] - t.x;
        const dy = f.units[i * 2 + 1] - t.z;
        if (Math.abs(dx) < WARY && Math.abs(dy) < WARY && dx * dx + dy * dy < WARY * WARY) wait = true;
      }
      if (!wait && !walkable(this.map, t.x + Math.cos(t.yaw) * 0.3, t.z + Math.sin(t.yaw) * 0.3)) wait = true;
      t.v += ((wait ? 0 : SPEED) - t.v) * Math.min(1, dt * 1.5);
      t.s += t.v * dt;
      t.seg = tractorAt(t.route, t.s, t.seg, _at);
      t.x = _at.x;
      t.z = _at.z;
      // (the route's corners are a few points round the headland turn: ease the heading round them)
      t.yaw += wrapAngle(_at.yaw - t.yaw) * Math.min(1, dt * 5);
      const inView = t.x > f.vx0 && t.x < f.vx1 && t.z > f.vy0 && t.z < f.vy1;
      const seen = inView && this.probe.visible(t.x, t.z);
      t.mesh.visible = seen;
      if (!seen) continue;
      const m = t.mesh;
      m.position.set(t.x, surfaceHeight(this.map, t.x, t.z) - 0.005, t.z);
      m.rotation.set(0, -t.yaw, t.v > 0.02 ? Math.sin(f.time * 23) * 0.006 : 0); // engine judder
      m.updateMatrix();
      // a little dust off the dry ground behind it (thin: a gentle haze, not a cloud)
      if (t.dust > 0 && t.v > 0.05 && Math.random() < dt * 0.9 * t.dust) {
        this.effects.dust(t.x - Math.cos(t.yaw) * 0.22, m.position.y, t.z - Math.sin(t.yaw) * 0.22, 0.28);
      }
    }
  }

  /** Debug / screenshots: where the tractors are. */
  debug() {
    return this.tractors.map((t) => ({ x: +t.x.toFixed(2), z: +t.z.toFixed(2), v: +t.v.toFixed(3), shown: t.mesh.visible }));
  }

  dispose() {
    for (const t of this.tractors) t.mesh.geometry.dispose();
    this.mat?.dispose();
    this.group.clear();
  }
}
