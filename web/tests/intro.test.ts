import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createMap } from '../src/sim/maps';
import { BattleIntro } from '../src/render/intro';
import type { GameRenderer } from '../src/render/renderer';

/** The smallest stand-in for the renderer the flyover drives (camera hook, target, zoom, view rotation, fog). */
function fakeRenderer(w: number, h: number) {
  const r = {
    camera: new THREE.PerspectiveCamera(38, 16 / 9, 0.1, 1000),
    target: new THREE.Vector3(),
    zoom: 1.6,
    yaw: 0,
    photoCam: null as null | { pos: THREE.Vector3; look: THREE.Vector3 },
    fog: { revealAll() {} },
    centerOn(x: number, y: number) {
      r.target.set(Math.max(2, Math.min(w - 2, x)), 0, Math.max(2, Math.min(h - 2, y)));
    },
    setZoom(z: number) {
      r.zoom = Math.max(0.5, Math.min(4, z));
    },
    elevation() {
      return THREE.MathUtils.degToRad(50);
    },
  };
  return r;
}

describe('battle intro flyover', () => {
  it('moves the camera in even steps even when frame times hitch, and lasts about 5 s', () => {
    const map = createMap('desert', 1);
    const r = fakeRenderer(map.w, map.h);
    const intro = new BattleIntro(r as unknown as GameRenderer, map, { x: map.w - 20, y: map.h - 20 }, { x: map.w / 2, y: map.h / 2 }, { x: 20, y: 20 }, 1.6);
    expect(intro.duration).toBeGreaterThanOrEqual(5);
    const steps: number[] = [];
    const prev = new THREE.Vector3();
    let frames = 0;
    let first = true;
    // 60 fps with a hitch every 17 frames (a slow shader compile or a GC pause)
    while (!intro.update(frames % 17 === 5 ? 0.25 : 1 / 60) && frames < 2000) {
      const cam = r.photoCam!;
      if (!first) steps.push(cam.pos.distanceTo(prev));
      prev.copy(cam.pos);
      first = false;
      frames++;
    }
    expect(intro.done).toBe(true);
    // no frame jumps much more than its neighbours: the hitches were smoothed out
    let worst = 0;
    for (let i = 2; i < steps.length - 2; i++) {
      const around = (steps[i - 1] + steps[i + 1]) / 2;
      if (around > 0.05) worst = Math.max(worst, steps[i] / around);
    }
    expect(worst).toBeLessThan(1.6);
  });
});
