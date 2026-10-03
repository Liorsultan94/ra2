import * as THREE from 'three';
import { Kit } from './landmarks';

/*
 * Civilian transport models for the render-only set pieces: trains (an
 * electric locomotive, coaches, box and tank wagons, a metro car), a car
 * ferry, canal barges and tour boats, moored boats, an airliner, a news /
 * ambulance helicopter (body and rotor separate) and a light plane.
 *
 * Origins: rail vehicles at the centre of the car on top of the rails, front
 * +X; boats at the waterline centre, bow +X; aircraft at the centre of mass,
 * nose +X. Sizes follow the battlefield scale (1 tile ~ 9 m, vehicles x1.25):
 * a coach is 1.7 long and 0.36 wide, an airliner 2.4 long.
 * Glow codes as in models/landmarks.ts (1 = windows lit at night, 3 = lamps).
 */

/** Rail gauge (rail centres, tiles). */
export const GAUGE = 0.17;

function bogies(k: Kit, len: number, col = 0x2a2a2c) {
  for (const s of [-1, 1]) {
    const x = s * len * 0.34;
    k.box(0.36, 0.06, GAUGE + 0.06, x, 0.055, 0, col);
    for (const w of [-0.1, 0.1]) for (const z of [-GAUGE / 2, GAUGE / 2]) k.add(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 8).rotateX(Math.PI / 2), mt(x + w, 0.045, z), 0x1a1a1a);
  }
}

function mt(x: number, y: number, z: number): THREE.Matrix4 {
  return new THREE.Matrix4().makeTranslation(x, y, z);
}

/** Electric locomotive (red, white stripe, pantograph), length LOCO_LEN. */
export const LOCO_LEN = 1.55;
export function locomotive(): THREE.BufferGeometry {
  const k = new Kit();
  const L = LOCO_LEN;
  const W = 0.34;
  bogies(k, L);
  k.box(L, 0.04, W, 0, 0.1, 0, 0x2a2a2c);
  k.box(L - 0.16, 0.3, W, 0, 0.27, 0, 0xb82a26);
  // slanted cab noses
  for (const s of [-1, 1]) {
    k.add(new THREE.BoxGeometry(0.14, 0.3, W).translate(0, 0, 0), new THREE.Matrix4().compose(new THREE.Vector3(s * (L / 2 - 0.06), 0.27, 0), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -s * 0.18), new THREE.Vector3(1, 1, 1)), 0xb82a26);
    k.box(0.02, 0.09, W * 0.8, s * (L / 2 - 0.035), 0.34, 0, 0x22303a);
    k.box(0.02, 0.03, 0.05, s * (L / 2 - 0.01), 0.18, 0.11, 0xfff4d0, 3);
    k.box(0.02, 0.03, 0.05, s * (L / 2 - 0.01), 0.18, -0.11, 0xfff4d0, 3);
  }
  k.box(L - 0.2, 0.035, W + 0.004, 0, 0.21, 0, 0xf0f0f0);
  k.box(L - 0.3, 0.03, W - 0.06, 0, 0.435, 0, 0x8a8e94);
  for (let i = 0; i < 5; i++) k.box(0.12, 0.08, 0.004, -0.4 + i * 0.2, 0.32, W / 2 + 0.002, 0x5a5e64);
  // pantograph
  k.box(0.2, 0.02, 0.2, -0.3, 0.46, 0, 0x3a3a3a);
  k.beam(-0.38, 0.47, 0, -0.22, 0.62, 0, 0.012, 0x3a3a3a);
  k.beam(-0.22, 0.62, 0, -0.3, 0.75, 0, 0.012, 0x3a3a3a);
  k.box(0.04, 0.012, 0.26, -0.3, 0.755, 0, 0x3a3a3a);
  return k.build();
}

/** Passenger coach (green / cream, lit windows), length COACH_LEN. */
export const COACH_LEN = 1.7;
export function coach(): THREE.BufferGeometry {
  const k = new Kit();
  const L = COACH_LEN;
  const W = 0.34;
  bogies(k, L);
  k.box(L, 0.04, W, 0, 0.1, 0, 0x2a2a2c);
  k.box(L - 0.04, 0.3, W, 0, 0.27, 0, 0x2e6a4a);
  k.box(L - 0.04, 0.1, W + 0.004, 0, 0.33, 0, 0xe8e0c8);
  for (const s of [-1, 1]) for (let i = 0; i < 9; i++) k.box(0.12, 0.07, 0.004, -0.66 + i * 0.165, 0.335, s * (W / 2 + 0.003), 0xffe6a8, 1);
  k.add(new THREE.CylinderGeometry(W / 2, W / 2, L - 0.04, 12, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateX(Math.PI / 2).scale(1, 0.32, 1), mt(0, 0.42, 0), 0x6a6e74);
  for (const s of [-1, 1]) k.box(0.03, 0.22, 0.2, s * (L / 2 - 0.005), 0.26, 0, 0x1a1a1a);
  return k.build();
}

/** Box wagon (brown), length WAGON_LEN. */
export const WAGON_LEN = 1.35;
export function boxWagon(): THREE.BufferGeometry {
  const k = new Kit();
  const L = WAGON_LEN;
  const W = 0.34;
  bogies(k, L);
  k.box(L, 0.04, W, 0, 0.1, 0, 0x2a2a2c);
  k.box(L - 0.05, 0.3, W, 0, 0.27, 0, 0x7a3e26);
  for (let i = 0; i < 7; i++) k.box(0.012, 0.3, W + 0.006, -0.6 + i * 0.2, 0.27, 0, 0x5a2e1c);
  k.box(0.3, 0.24, W + 0.01, 0, 0.26, 0, 0x6a3420);
  k.add(new THREE.CylinderGeometry(W / 2, W / 2, L - 0.05, 10, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateX(Math.PI / 2).scale(1, 0.25, 1), mt(0, 0.42, 0), 0x6a6a6a);
  return k.build();
}

/** Tank wagon (black cylinder with walkway), length TANK_LEN. */
export const TANK_LEN = 1.2;
export function tankWagon(): THREE.BufferGeometry {
  const k = new Kit();
  const L = TANK_LEN;
  bogies(k, L);
  k.box(L, 0.04, 0.32, 0, 0.1, 0, 0x2a2a2c);
  k.add(new THREE.CylinderGeometry(0.15, 0.15, L - 0.1, 14).rotateZ(Math.PI / 2), mt(0, 0.27, 0), 0x1e2022);
  for (const s of [-1, 1]) k.add(new THREE.SphereGeometry(0.15, 10, 6).scale(0.35, 1, 1), mt(s * (L / 2 - 0.05), 0.27, 0), 0x1e2022);
  k.cyl(0.05, 0.05, 0.06, 0, 0.41, 0, 0x2a2a2a, 8);
  k.box(0.6, 0.02, 0.12, 0, 0.43, 0, 0x8a8a8a);
  k.box(L - 0.1, 0.04, 0.304, 0, 0.27, 0, 0xd8a020);
  return k.build();
}

/** Metro / commuter car (white, blue band, wide windows, lit), length METRO_LEN; cab windows at both ends. */
export const METRO_LEN = 1.45;
export function metroCar(): THREE.BufferGeometry {
  const k = new Kit();
  const L = METRO_LEN;
  const W = 0.34;
  bogies(k, L, 0x3a3a3c);
  k.box(L, 0.05, W, 0, 0.11, 0, 0x3a3a3c);
  k.box(L - 0.04, 0.32, W, 0, 0.29, 0, 0xeeeeea);
  k.box(L - 0.04, 0.05, W + 0.004, 0, 0.17, 0, 0x2a5ab0);
  for (const s of [-1, 1]) {
    for (let i = 0; i < 6; i++) k.box(0.17, 0.11, 0.004, -0.55 + i * 0.22, 0.32, s * (W / 2 + 0.003), 0xd8eaff, 1);
    for (const d of [-0.36, 0.36]) k.box(0.1, 0.22, 0.005, d, 0.25, s * (W / 2 + 0.004), 0x5a6a7a);
    k.box(0.02, 0.12, W * 0.8, s * (L / 2 - 0.015), 0.33, 0, 0x22303a);
    k.box(0.02, 0.03, 0.05, s * (L / 2 - 0.008), 0.19, 0.1, 0xfff4d0, 3);
    k.box(0.02, 0.03, 0.05, s * (L / 2 - 0.008), 0.19, -0.1, 0xfff4d0, 3);
  }
  k.box(L - 0.1, 0.03, W - 0.04, 0, 0.465, 0, 0x9a9ea4);
  return k.build();
}

// ------------------------------------------------------------------ boats

/** Car ferry: flat deck with ramps at both ends, a side wheelhouse and two cars (length 1.9). */
export function ferry(): THREE.BufferGeometry {
  const k = new Kit();
  k.box(1.7, 0.16, 0.72, 0, -0.02, 0, 0x2a3a5a);
  k.box(1.72, 0.03, 0.74, 0, 0.075, 0, 0xc0392b);
  k.box(1.6, 0.02, 0.62, 0, 0.09, 0, 0x5a5e64);
  for (const s of [-1, 1]) {
    k.add(new THREE.BoxGeometry(0.22, 0.02, 0.56), new THREE.Matrix4().compose(new THREE.Vector3(s * 0.94, 0.11, 0), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), s * 0.35), new THREE.Vector3(1, 1, 1)), 0x6a6e74);
    k.box(1.5, 0.08, 0.025, 0, 0.13, s * 0.35, 0xe8e8e8);
  }
  // wheelhouse on a gantry over one side
  k.box(0.3, 0.2, 0.18, 0, 0.3, -0.26, 0xf0f0f0);
  k.box(0.31, 0.06, 0.19, 0, 0.36, -0.26, 0x22303a);
  k.box(0.34, 0.02, 0.22, 0, 0.41, -0.26, 0xc0392b);
  k.box(0.02, 0.18, 0.02, 0, 0.5, -0.26, 0x3a3a3a);
  k.box(0.03, 0.03, 0.03, 0, 0.6, -0.26, 0xfff0c0, 3);
  // two cars and a van
  const car = (x: number, z: number, c: number, l = 0.42) => {
    k.box(l, 0.07, 0.18, x, 0.14, z, c);
    k.box(l * 0.55, 0.06, 0.17, x - 0.02, 0.2, z, 0x9ab0c0);
  };
  car(-0.45, 0.13, 0x2a6ab0);
  car(0.15, 0.13, 0xe0e0e0);
  k.box(0.5, 0.18, 0.2, -0.3, 0.19, -0.02 - 0.0, 0xe8c040);
  return k.build();
}

/** Canal barge: long low hull, aft wheelhouse, cargo of sand / gravel (length 2.2). */
export function barge(): THREE.BufferGeometry {
  const k = new Kit();
  const L = 2.2;
  k.box(L, 0.14, 0.44, 0, 0.0, 0, 0x2a2a2e);
  k.box(L + 0.01, 0.03, 0.45, 0, 0.06, 0, 0x8a2a20);
  k.box(0.1, 0.1, 0.44, L / 2 - 0.05, 0.05, 0, 0x2a2a2e);
  k.box(1.4, 0.06, 0.38, 0.15, 0.1, 0, 0x4a4a4e);
  // cargo heaps
  for (let i = 0; i < 3; i++) k.add(new THREE.ConeGeometry(0.2, 0.14, 8).scale(1.6, 1, 0.9), mt(-0.35 + i * 0.45, 0.2, 0), i === 1 ? 0xa89878 : 0xb8a888);
  // wheelhouse + living quarters aft
  k.box(0.42, 0.14, 0.38, -0.85, 0.15, 0, 0xe8e4dc);
  k.box(0.2, 0.14, 0.3, -0.92, 0.29, 0, 0xe8e4dc);
  k.box(0.21, 0.05, 0.31, -0.92, 0.32, 0, 0x22303a);
  for (const s of [-1, 1]) k.box(0.3, 0.05, 0.004, -0.85, 0.17, s * 0.192, 0xffe0a0, 1);
  k.box(0.04, 0.12, 0.04, -1.0, 0.42, 0.1, 0x1a1a1a);
  k.box(0.012, 0.16, 0.012, -1.06, 0.42, -0.1, 0x6a6a6a);
  k.box(0.08, 0.05, 0.004, -1.06, 0.48, -0.1, 0x2a6ab0);
  return k.build();
}

/** Canal tour boat: long, low, glass roof, lit cabin (length 1.6). */
export function tourBoat(): THREE.BufferGeometry {
  const k = new Kit();
  const L = 1.6;
  const hull = new THREE.BoxGeometry(L, 0.12, 0.42, 6, 1, 1);
  const p = hull.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) / L + 0.5;
    const t = Math.max(0, x - 0.75) / 0.25;
    p.setZ(i, p.getZ(i) * (1 - t * t * 0.7));
  }
  hull.computeVertexNormals();
  k.add(hull, mt(0, 0.0, 0), 0x1e3a5a);
  k.box(L * 0.98, 0.02, 0.4, 0, 0.07, 0, 0xe8e4dc);
  k.box(1.1, 0.12, 0.36, -0.05, 0.14, 0, 0xe8e4dc);
  k.box(1.1, 0.09, 0.365, -0.05, 0.21, 0, 0x9ac0d8, 1);
  k.box(1.12, 0.02, 0.37, -0.05, 0.26, 0, 0x6a8aa0);
  for (const s of [-1, 1]) for (let i = 0; i < 6; i++) k.box(0.1, 0.05, 0.004, -0.5 + i * 0.18, 0.15, s * 0.183, 0xffe0a0, 1);
  k.box(0.02, 0.04, 0.04, L / 2 - 0.02, 0.08, 0, 0xfff0c0, 3);
  return k.build();
}

/** Small motor boat / yacht for the marina (length ~0.8). */
export function motorBoat(k: Kit, v: number) {
  const c = v > 0.5 ? 0xf0f0f0 : 0x2a4a7a;
  const hull = new THREE.BoxGeometry(0.8, 0.1, 0.26, 4, 1, 1);
  const p = hull.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const t = Math.max(0, p.getX(i) / 0.8 + 0.5 - 0.6) / 0.4;
    p.setZ(i, p.getZ(i) * (1 - t * 0.85));
  }
  hull.computeVertexNormals();
  k.add(hull, mt(0, 0.02, 0), c);
  k.box(0.3, 0.08, 0.18, -0.08, 0.11, 0, 0xe8e8e8);
  k.box(0.2, 0.05, 0.19, -0.04, 0.14, 0, 0x22303a);
  if (v > 0.7) {
    k.beam(0.05, 0.07, 0, 0.05, 0.95, 0, 0.015, 0xd8d8d8);
    k.add(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0.07, 0.15, 0), new THREE.Vector3(0.07, 0.9, 0), new THREE.Vector3(0.4, 0.15, 0)]), null, 0xf4f4f0);
  }
}

// ------------------------------------------------------------------ aircraft

/** Airliner (white, coloured tail and cheat line), nose +X, length 2.4, span 2.2. */
export function airliner(): THREE.BufferGeometry {
  const k = new Kit();
  const body = new THREE.CylinderGeometry(0.12, 0.12, 2.0, 12).rotateZ(Math.PI / 2);
  k.add(body, mt(0, 0, 0), 0xf4f4f2);
  k.add(new THREE.SphereGeometry(0.12, 12, 8).scale(1.8, 1, 1), mt(1.0, 0, 0), 0xf4f4f2);
  k.add(new THREE.ConeGeometry(0.12, 0.45, 12).rotateZ(Math.PI / 2), mt(-1.2, 0.03, 0), 0xf4f4f2);
  k.box(1.9, 0.03, 0.245, 0.05, 0.02, 0, 0x2a5ab0);
  // swept wings and tailplane
  const wing = (span: number, chord: number, sweep: number, x: number, y: number, t: number, col: number) => {
    for (const s of [-1, 1]) {
      const g = new THREE.BufferGeometry();
      const v = [
        [0, 0, 0],
        [-chord, 0, 0],
        [-chord * 0.4 - sweep, 0, s * span],
        [-sweep, 0, s * span],
      ];
      const pos: number[] = [];
      const tri = (a: number[], b: number[], c: number[]) => pos.push(...a, ...b, ...c);
      const top = v.map((p) => [p[0], p[1] + t / 2, p[2]]);
      const bot = v.map((p) => [p[0], p[1] - t / 2, p[2]]);
      tri(top[0], top[2], top[1]);
      tri(top[0], top[3], top[2]);
      tri(bot[0], bot[1], bot[2]);
      tri(bot[0], bot[2], bot[3]);
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      k.add(g, mt(x, y, 0), col);
    }
  };
  wing(1.05, 0.42, 0.42, 0.2, -0.04, 0.03, 0xd8dadc);
  wing(0.38, 0.2, 0.18, -0.95, 0.04, 0.02, 0xd8dadc);
  // fin
  const fin = new THREE.BufferGeometry();
  fin.setAttribute('position', new THREE.Float32BufferAttribute([-0.85, 0.08, 0, -1.25, 0.08, 0, -1.3, 0.5, 0, -0.85, 0.08, 0, -1.3, 0.5, 0, -1.12, 0.5, 0], 3));
  fin.computeVertexNormals();
  k.add(fin.clone(), mt(0, 0, 0.012), 0x2a5ab0);
  const back = fin.clone();
  back.scale(1, 1, -1);
  k.add(back, mt(0, 0, -0.012), 0x2a5ab0);
  // engines under the wings
  for (const s of [-1, 1]) k.add(new THREE.CylinderGeometry(0.05, 0.055, 0.26, 10).rotateZ(Math.PI / 2), mt(0.05, -0.1, s * 0.42), 0xb8bcc0);
  return k.build();
}

/** Helicopter body (news / ambulance livery), nose +X, rotor hub at HELI_HUB. */
export const HELI_HUB = { x: 0.02, y: 0.2 };
export function heliBody(ambulance: boolean): THREE.BufferGeometry {
  const k = new Kit();
  const c = ambulance ? 0xf0f0ec : 0x2a5ab0;
  k.add(new THREE.SphereGeometry(0.16, 12, 8).scale(1.6, 0.9, 0.9), mt(0.05, 0, 0), c);
  k.add(new THREE.SphereGeometry(0.12, 10, 6).scale(1.2, 0.8, 0.85), mt(0.16, 0.03, 0), 0x22303a);
  k.add(new THREE.CylinderGeometry(0.03, 0.05, 0.6, 8).rotateZ(Math.PI / 2), mt(-0.45, 0.04, 0), c);
  k.box(0.1, 0.16, 0.02, -0.74, 0.12, 0, ambulance ? 0xd02020 : 0xe8c020);
  k.box(0.02, 0.02, 0.2, -0.72, 0.04, 0, c);
  for (const s of [-1, 1]) {
    k.box(0.5, 0.02, 0.02, 0.05, -0.17, s * 0.12, 0x3a3a3a);
    k.beam(0.15, -0.16, s * 0.12, 0.12, -0.08, s * 0.08, 0.015, 0x3a3a3a);
    k.beam(-0.08, -0.16, s * 0.12, -0.06, -0.08, s * 0.08, 0.015, 0x3a3a3a);
  }
  k.box(0.08, 0.06, 0.08, HELI_HUB.x, HELI_HUB.y - 0.05, 0, 0x3a3a3a);
  if (ambulance) {
    k.box(0.1, 0.03, 0.005, -0.08, 0.02, 0.145, 0xd02020);
    k.box(0.03, 0.1, 0.005, -0.08, 0.02, 0.145, 0xd02020);
  } else k.box(0.22, 0.035, 0.005, -0.05, -0.02, 0.143, 0xf0f0f0);
  // camera ball under the nose
  if (!ambulance) k.ball(0.04, 0.25, -0.1, 0, 0x1a1a1a, 1);
  return k.build();
}

/** Two-blade main rotor (spins about +Y) and the tail rotor offset; centre at the hub. */
export function heliRotor(): THREE.BufferGeometry {
  const k = new Kit();
  k.box(1.2, 0.012, 0.05, 0, 0, 0, 0x2a2a2a);
  k.box(0.05, 0.012, 1.2, 0, 0, 0, 0x2a2a2a);
  return k.build();
}

/** Light high-wing plane (single prop), nose +X, length 0.75, span 1.0. */
export function lightPlane(): THREE.BufferGeometry {
  const k = new Kit();
  k.box(0.55, 0.1, 0.1, 0.05, 0, 0, 0xf0f0ec);
  k.add(new THREE.ConeGeometry(0.05, 0.3, 8).rotateZ(Math.PI / 2), mt(-0.35, 0.02, 0), 0xf0f0ec);
  k.box(0.18, 0.08, 0.104, 0.12, 0.05, 0, 0x22303a);
  k.box(0.2, 0.012, 1.0, 0.1, 0.09, 0, 0xd02a2a);
  k.box(0.1, 0.01, 0.34, -0.45, 0.03, 0, 0xd02a2a);
  k.box(0.1, 0.14, 0.01, -0.46, 0.09, 0, 0xd02a2a);
  k.box(0.012, 0.16, 0.16, 0.33, 0, 0, 0x6a6a6a);
  for (const s of [-1, 1]) k.beam(0.12, -0.05, s * 0.12, 0.12, -0.1, s * 0.15, 0.012, 0x3a3a3a);
  k.ball(0.025, 0.12, -0.11, 0.15, 0x1a1a1a, 0);
  k.ball(0.025, 0.12, -0.11, -0.15, 0x1a1a1a, 0);
  return k.build();
}
