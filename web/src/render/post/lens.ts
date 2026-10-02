import * as THREE from 'three';

/*
 * Procedural lens dirt (generated once, 256x256 RGBA8): soft smudges, a few
 * dust discs and faint rings, mostly towards the edges of the frame, so a very
 * bright source (explosion, the sun low in the sky) lights up a subtle
 * fingerprint of dirt on the "lens". Multiplied by a wide bloom level in the
 * final pass; never visible on its own.
 */
export function makeLensDirt(seed = 7): THREE.DataTexture {
  const N = 256;
  const acc = new Float32Array(N * N * 3);
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const splat = (cx: number, cy: number, r: number, a: number, ring: boolean, tint: [number, number, number]) => {
    const x0 = Math.max(0, Math.floor(cx - r - 1));
    const x1 = Math.min(N - 1, Math.ceil(cx + r + 1));
    const y0 = Math.max(0, Math.floor(cy - r - 1));
    const y1 = Math.min(N - 1, Math.ceil(cy + r + 1));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
        if (d >= 1) continue;
        const v = ring ? Math.exp(-((d - 0.82) * (d - 0.82)) / 0.006) * 0.6 + (1 - d) * 0.15 : Math.pow(1 - d * d, 2);
        const i = (y * N + x) * 3;
        acc[i] += v * a * tint[0];
        acc[i + 1] += v * a * tint[1];
        acc[i + 2] += v * a * tint[2];
      }
  };
  const edgeBias = () => {
    // more dirt towards the frame edges
    for (;;) {
      const x = rnd();
      const y = rnd();
      const e = Math.max(Math.abs(x - 0.5), Math.abs(y - 0.5)) * 2;
      if (rnd() < 0.25 + 0.75 * e * e) return [x * N, y * N];
    }
  };
  const warm: [number, number, number] = [1, 0.93, 0.82];
  const cool: [number, number, number] = [0.86, 0.94, 1];
  // broad smudges
  for (let i = 0; i < 14; i++) {
    const [x, y] = edgeBias();
    splat(x, y, 18 + rnd() * 38, 0.14 + rnd() * 0.16, false, rnd() < 0.5 ? warm : cool);
  }
  // dust discs and a few rings (out-of-focus specks on the front element)
  for (let i = 0; i < 70; i++) {
    const [x, y] = edgeBias();
    const ring = rnd() < 0.18;
    splat(x, y, 2 + rnd() * (ring ? 9 : 6), 0.25 + rnd() * 0.5, ring, rnd() < 0.5 ? warm : cool);
  }
  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = Math.min(255, Math.round(acc[i * 3] * 255));
    data[i * 4 + 1] = Math.min(255, Math.round(acc[i * 3 + 1] * 255));
    data[i * 4 + 2] = Math.min(255, Math.round(acc[i * 3 + 2] * 255));
    data[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}
