import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { feedKindOf } from '../src/render/dronecam';
import {
  ALT_EXAG,
  FT_PER_M,
  M_PER_TILE,
  MIN_HOLD,
  PRIO,
  airframe,
  depressionDeg,
  facingHeading,
  feedTitle,
  groundSpeedKt,
  northInPicture,
  tapeLabel,
  fovFor,
  headingDeg,
  jetRunStarted,
  pickFeed,
  podPosition,
  projectBox,
  projectCorners,
  projectPx,
  readouts,
  slewAngle,
  type CurFeed,
  type FeedCand,
} from '../src/render/podmath';
import { isSortieJet } from '../src/sim/airbase';
import { unitDef } from '../src/sim/defs';

function camAt(pos: THREE.Vector3, look: THREE.Vector3, fov: number, aspect: number) {
  const c = new THREE.PerspectiveCamera(fov, aspect, 0.2, 100);
  c.position.copy(pos);
  c.lookAt(look);
  c.updateProjectionMatrix();
  c.updateMatrixWorld();
  return c;
}
const vpOf = (c: THREE.PerspectiveCamera) => new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse).elements;

describe('strike camera projection', () => {
  it('projectPx matches three.js Vector3.project, and the locked target sits on the crosshair', () => {
    const tgt = new THREE.Vector3(40, 0.6, 30);
    const cam = camAt(new THREE.Vector3(34, 6, 26), tgt, 14, 4 / 3);
    const W = 320;
    const H = 240;
    const c = projectPx(vpOf(cam), tgt, W, H)!;
    expect(c.x).toBeCloseTo(W / 2, 3);
    expect(c.y).toBeCloseTo(H / 2, 3);
    for (const p of [new THREE.Vector3(41, 0.2, 30.5), new THREE.Vector3(39.2, 1.1, 29), new THREE.Vector3(40.4, 0, 31)]) {
      const q = projectPx(vpOf(cam), p, W, H)!;
      const v = p.clone().project(cam);
      expect(q.x).toBeCloseTo(((v.x + 1) / 2) * W, 3);
      expect(q.y).toBeCloseTo(((1 - v.y) / 2) * H, 3);
    }
    // behind the camera: no projection
    expect(projectPx(vpOf(cam), new THREE.Vector3(28, 6, 22), W, H)).toBeNull();
  });

  it('the target box is the projected bounding box: centred on a locked target, sized by its distance and size', () => {
    const tgt = new THREE.Vector3(20, 0.3, 20);
    const box = (half: number, dist: number) => {
      const dir = new THREE.Vector3(-1, 1.2, -0.6).normalize();
      const cam = camAt(tgt.clone().addScaledVector(dir, dist), tgt, 12, 4 / 3);
      const min = { x: tgt.x - half, y: tgt.y - 0.3, z: tgt.z - half };
      const max = { x: tgt.x + half, y: tgt.y + 0.3, z: tgt.z + half };
      return projectBox(vpOf(cam), min, max, 480, 360)!;
    };
    const b = box(0.4, 8);
    expect((b.x0 + b.x1) / 2).toBeCloseTo(240, -1);
    expect((b.y0 + b.y1) / 2).toBeCloseTo(180, -1);
    const far = box(0.4, 16);
    const big = box(1.2, 8);
    // twice as far: about half the size; three times bigger: about three times the size
    expect((far.x1 - far.x0) / (b.x1 - b.x0)).toBeGreaterThan(0.42);
    expect((far.x1 - far.x0) / (b.x1 - b.x0)).toBeLessThan(0.58);
    expect((big.x1 - big.x0) / (b.x1 - b.x0)).toBeGreaterThan(2.6);
    expect((big.x1 - big.x0) / (b.x1 - b.x0)).toBeLessThan(3.4);
  });

  it('a turned target gets a tight box: its oriented box, not its world-axis bounds', () => {
    const tgt = new THREE.Vector3(20, 0.3, 20);
    // a pod looking down along the hull of a tank driving north-east (map axes at 45 degrees in the picture)
    const cam = camAt(new THREE.Vector3(20 - 4.24, 10, 20 + 4.24), tgt, 14, 4 / 3);
    const vp = vpOf(cam);
    // a 1.4 x 0.6 tile hull turned 45 degrees
    const m = new THREE.Matrix4().makeRotationY(Math.PI / 4).setPosition(tgt);
    const obb: THREE.Vector3[] = [];
    for (let i = 0; i < 8; i++) obb.push(new THREE.Vector3(i & 1 ? 0.7 : -0.7, i & 2 ? 0.3 : -0.3, i & 4 ? 0.3 : -0.3).applyMatrix4(m));
    const world = new THREE.Box3().setFromPoints(obb);
    const tight = projectCorners(vp, obb, 480, 360)!;
    const loose = projectBox(vp, world.min, world.max, 480, 360)!;
    expect((tight.x1 - tight.x0) * (tight.y1 - tight.y0)).toBeLessThan((loose.x1 - loose.x0) * (loose.y1 - loose.y0) * 0.75);
    // and it still holds every corner of the hull
    for (const p of obb) {
      const q = projectPx(vp, p, 480, 360)!;
      expect(q.x).toBeGreaterThanOrEqual(tight.x0 - 1e-6);
      expect(q.x).toBeLessThanOrEqual(tight.x1 + 1e-6);
    }
  });

  it('fovFor frames the asked ground width across the picture at any aspect', () => {
    for (const aspect of [4 / 3, 16 / 9, 1]) {
      for (const [dist, width] of [
        [8, 3],
        [14, 5],
        [5, 2.4],
      ]) {
        const fov = fovFor(dist, width, aspect);
        const cam = new THREE.PerspectiveCamera(fov, aspect, 0.1, 100);
        cam.position.set(0, 0, dist);
        cam.lookAt(0, 0, 0);
        cam.updateMatrixWorld();
        // a point half the width to the right, on the target plane: at the picture's right edge
        const v = new THREE.Vector3(width / 2, 0, 0).project(cam);
        expect(v.x).toBeCloseTo(1, 3);
      }
    }
  });
});

describe('strike camera geometry and readouts', () => {
  it('the sensor rides above the aircraft at the scaled altitude; readouts agree with the picture geometry', () => {
    const ground = 0.2;
    const air = { x: 10, y: ground + 1.7, z: 14 };
    const tgt = { x: 15, y: ground + 0.25, z: 14 };
    const pod = podPosition(air, ground);
    expect(pod.x).toBe(air.x);
    expect(pod.z).toBe(air.z);
    expect(pod.y).toBeCloseTo(ground + 1.7 * ALT_EXAG, 6);
    const ro = readouts(pod, tgt, ground);
    expect(ro.altFt).toBeCloseTo(1.7 * ALT_EXAG * M_PER_TILE * FT_PER_M, 3);
    // slant range is never shorter than the altitude, and matches the depression angle seen in the picture
    const altM = ro.altFt / FT_PER_M;
    expect(ro.slantM).toBeGreaterThan(altM);
    const dep = depressionDeg(pod, tgt);
    expect(Math.sin((dep * Math.PI) / 180) * ro.slantM).toBeCloseTo((pod.y - tgt.y) * M_PER_TILE, 3);
    // looking east
    expect(ro.losHdg).toBeCloseTo(90, 6);
    // a jet runs in steeper than a hovering helicopter at its stand-off range
    const jet = depressionDeg(podPosition({ x: 0, y: ground + 2.6, z: 0 }, ground), { x: 3, y: ground, z: 0 });
    const heli = depressionDeg(podPosition({ x: 0, y: ground + 1.15, z: 0 }, ground), { x: 7, y: ground, z: 0 });
    expect(jet).toBeGreaterThan(60);
    expect(heli).toBeLessThan(35);
    expect(heli).toBeGreaterThan(20);
  });

  it('headings: north is up the map (-y), east +x; sim facings map the same way', () => {
    expect(headingDeg(0, -1)).toBeCloseTo(0);
    expect(headingDeg(1, 0)).toBeCloseTo(90);
    expect(headingDeg(0, 1)).toBeCloseTo(180);
    expect(headingDeg(-1, 0)).toBeCloseTo(270);
    expect(facingHeading(0)).toBeCloseTo(90);
    expect(facingHeading(Math.PI / 2)).toBeCloseTo(180);
    expect(facingHeading(-Math.PI / 2)).toBeCloseTo(0);
  });

  it('ground speed in knots from the sim step; compass tape labels', () => {
    // 6 tiles/s (a jet's run) at 35 m per tile = 210 m/s = 408 kt
    expect(groundSpeedKt(6 / 20, 0, 20)).toBeCloseTo((6 * M_PER_TILE) * 1.9438, 3);
    expect(groundSpeedKt(0.09, 0.12, 20)).toBeCloseTo(0.15 * 20 * M_PER_TILE * 1.9438, 3);
    expect(['N', 'E', 'S', 'W', '03', '33', '12'].join()).toBe([0, 90, 180, 270, 30, 330, 120].map(tapeLabel).join());
    expect(tapeLabel(-30)).toBe('33');
    expect(tapeLabel(390)).toBe('03');
  });

  it('the north arrow points where north is in the picture, also looking straight down', () => {
    const arrow = (pos: THREE.Vector3, look: THREE.Vector3, up = new THREE.Vector3(0, 1, 0)) => {
      const c = new THREE.PerspectiveCamera(20, 4 / 3, 0.1, 100);
      c.up.copy(up);
      c.position.copy(pos);
      c.lookAt(look);
      c.updateMatrixWorld();
      const r = new THREE.Vector3().setFromMatrixColumn(c.matrixWorld, 0);
      const u = new THREE.Vector3().setFromMatrixColumn(c.matrixWorld, 1);
      return northInPicture(r, u);
    };
    const t = new THREE.Vector3(10, 0, 10);
    // looking north (towards -z): north is up; looking east: north is to the left; south: down
    expect(arrow(new THREE.Vector3(10, 5, 16), t)).toBeCloseTo(0, 3);
    expect(arrow(new THREE.Vector3(4, 5, 10), t)).toBeCloseTo(-90, 3);
    expect(Math.abs(arrow(new THREE.Vector3(10, 5, 4), t))).toBeCloseTo(180, 3);
    // straight down with the picture's up towards the east: north is to the left
    expect(arrow(new THREE.Vector3(10, 8, 10), t, new THREE.Vector3(1, 0, 0))).toBeCloseTo(-90, 3);
  });

  it('slewAngle turns the short way and never overshoots', () => {
    expect(slewAngle(0, 1, 0.25)).toBeCloseTo(0.25);
    expect(slewAngle(0.9, 1, 0.25)).toBe(1);
    expect(slewAngle(3, -3, 0.1)).toBeCloseTo(3.1);
  });
});

describe('which strike the feed follows', () => {
  const cand = (id: number, kind: FeedCand['kind'], prio: number): FeedCand => ({ id, kind, prio });
  const cur = (id: number, prio: number, since: number, extra: Partial<CurFeed> = {}): CurFeed => ({ id, prio, since, ended: false, ...extra });

  it('priority: selected unit > jet run > helicopter > kamikaze > drone', () => {
    const all = [cand(1, 'uav', PRIO.uav), cand(2, 'kami', PRIO.kami), cand(3, 'heli', PRIO.heli), cand(4, 'jet', PRIO.jet)];
    expect(pickFeed(null, all, 0)!.id).toBe(4);
    expect(pickFeed(null, [...all, cand(5, 'uav', PRIO.selected)], 0)!.id).toBe(5);
    expect(pickFeed(null, all.slice(0, 3), 0)!.id).toBe(3);
    expect(pickFeed(null, all.slice(0, 2), 0)!.id).toBe(2);
    // same priority: the newest unit
    expect(pickFeed(null, [cand(7, 'kami', PRIO.kami), cand(9, 'kami', PRIO.kami)], 0)!.id).toBe(9);
  });

  it('no flicker: a feed stays MIN_HOLD seconds unless it ends or the player selects another unit', () => {
    const drone = cur(1, PRIO.uav, 10);
    const jet = cand(4, 'jet', PRIO.jet);
    const cands = [cand(1, 'uav', PRIO.uav), jet];
    expect(pickFeed(drone, cands, 10 + MIN_HOLD - 0.5)).toBeNull();
    expect(pickFeed(drone, cands, 10 + MIN_HOLD + 0.1)!.id).toBe(4);
    // ended: switch at once
    expect(pickFeed({ ...drone, ended: true }, cands, 10.5)!.id).toBe(4);
    // a fresh selection: at once
    expect(pickFeed(drone, [...cands, cand(8, 'heli', PRIO.selected)], 10.5)!.id).toBe(8);
    // equal or lower priority never takes over a running feed
    expect(pickFeed(cur(3, PRIO.heli, 0), [cand(3, 'heli', PRIO.heli), cand(6, 'heli', PRIO.heli), cand(1, 'uav', PRIO.uav)], 50)).toBeNull();
    // a diving munition is ridden down to the end, except for a selection
    const kami = cur(2, PRIO.kami, 0, { locked: true });
    expect(pickFeed(kami, [cand(2, 'kami', PRIO.kami), jet], 30)).toBeNull();
    expect(pickFeed(kami, [cand(2, 'kami', PRIO.kami), cand(5, 'uav', PRIO.selected)], 30)!.id).toBe(5);
    // nothing to show: keep (the feed ends on its own rules)
    expect(pickFeed(drone, [], 99)).toBeNull();
    expect(pickFeed(null, [], 99)).toBeNull();
  });

  it('a jet bombing run starts a few seconds before the release, with the bomb aboard, on a sortie', () => {
    const v = 6;
    expect(jetRunStarted('sortie', 1, true, 40, v)).toBe(false);
    expect(jetRunStarted('sortie', 1, true, 3 + v * 3, v)).toBe(true);
    expect(jetRunStarted('sortie', 1, true, 5, v)).toBe(true);
    expect(jetRunStarted('sortie', 0, true, 5, v)).toBe(false);
    expect(jetRunStarted('return', 1, true, 5, v)).toBe(false);
    expect(jetRunStarted('takeoff', 1, true, 5, v)).toBe(false);
    expect(jetRunStarted('sortie', 1, false, 5, v)).toBe(false);
  });

  it('feed kinds and titles: drones, munitions, every faction jet and attack helicopter', () => {
    expect(feedKindOf('usa_uav')).toBe('uav');
    expect(feedKindOf('turkey_akinci')).toBe('uav');
    expect(feedKindOf('usa_fpv')).toBe('kami');
    expect(feedKindOf('usa_shahed')).toBe('kami');
    expect(feedKindOf('usa_fighter')).toBe('jet');
    expect(feedKindOf('usa_heli')).toBe('heli');
    expect(feedKindOf('usa_transport')).toBeNull();
    expect(feedKindOf('usa_mbt')).toBeNull();
    expect(isSortieJet(unitDef('usa_fighter'))).toBe(true);
    expect(feedTitle('jet', unitDef('usa_fighter').name, 'X')).toBe('F-35A · TGT POD');
    expect(feedTitle('jet', unitDef('korea_fighter').name, 'X')).toBe('F-15K · TGT POD');
    expect(feedTitle('jet', unitDef('germany_fighter').name, 'X')).toBe('TYPHOON · TGT POD');
    expect(feedTitle('heli', unitDef('usa_heli').name, 'X')).toBe('AH-64E · TADS');
    expect(feedTitle('heli', unitDef('israel_heli').name, 'X')).toBe('AH-64D · TADS');
    expect(feedTitle('heli', unitDef('turkey_heli').name, 'X')).toBe('T129 · ASELFLIR');
    expect(feedTitle('heli', unitDef('russia_heli').name, 'X')).toBe('KA-52 · FLIR');
    expect(feedTitle('uav', unitDef('usa_uav').name, 'REAPER-07')).toBe('MQ-9 · REAPER-07');
    expect(feedTitle('kami', 'Loitering Munition', 'MUNITION-07')).toBe('MUNITION FEED · MUNITION-07');
    expect(airframe('Su-35')).toBe('SU-35');
  });
});
