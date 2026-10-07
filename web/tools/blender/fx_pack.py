"""
Iron Front - pack the Cycles flipbook renders (fx_volumes.py) into the game's atlases.
Authored for Blender 5.2.2 LTS: runs inside Blender's Python (numpy + OpenImageIO are bundled).

  /opt/blender/blender -b --factory-startup -P web/tools/blender/fx_pack.py -- --src <render dir> \
      --dst web/public/fx [--sheet contact.png] [--preview <effect>]

Reads <src>/<effect>/f###.exr (multilayer, light groups L0..L5 + E + alpha) and writes:

  fx-a.webp   R = lit from +X (right), G = from top, B = from -X (left), A = opacity
  fx-b.webp   R = lit from bottom, G = from the camera side, B = from behind, A = emission
  fx-m.webp   R, G = screen-space motion (optical flow frame -> next frame), B = unused
  (+ "-half" variants for phones) and fx.json (layout, per-effect length / loop / emission scale).

Lightmaps are stored "straight" (divided by the opacity, so bilinear filtering of thin edges keeps
their light level) and sqrt-encoded; emission is premultiplied and sqrt-encoded. Looping effects are
cross-faded over their second half into a seamless loop. Motion vectors come from a small
coarse-to-fine Horn-Schunck optical flow over the opacity + emission of consecutive frames;
flipbook.ts uses them to morph between frames instead of a ghosting cross-fade.
"""
import json
import os
import subprocess
import sys

import numpy as np
import OpenImageIO as oiio

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def arg(name, default):
    if name in argv:
        return type(default)(argv[argv.index(name) + 1])
    return default


SRC = arg('--src', '/tmp/fxrender')
DST = arg('--dst', '')
SHEET = arg('--sheet', '')
PREVIEW = arg('--preview', '')

FRAME = 128
GRID = 6
NF = GRID * GRID
BLOCKS = (4, 3)
# atlas block order, runtime length (s), loop. Must match FlipKind in src/render/fx/flipbook.ts.
ORDER = [
    ('fireball', 3.2, False), ('burst', 0.9, False), ('fuel', 3.8, False), ('dust', 2.6, False),
    ('smoke', 6.0, False), ('flame', 1.8, True), ('sparks', 1.0, False), ('airburst', 3.0, False),
    ('collapse', 4.5, False), ('smokeloop', 2.6, True), ('puff', 1.1, False), ('debris', 1.8, False),
]
LOOPS = {k for k, _, l in ORDER if l}
# rendered frames to drop at the start (the collapse's first frames still show its box-shaped source)
TRIM = {'collapse': 3}
# loops: fade the gas out over the top of the frame (it would otherwise pile up under the domain lid)
TOPFADE = {'flame': 0.4, 'smokeloop': 0.35}


def read_exr(path):
    inp = oiio.ImageInput.open(path)
    if not inp:
        raise RuntimeError(path)
    out = {}
    i = 0
    while inp.seek_subimage(i, 0):
        spec = inp.spec()
        px = inp.read_image(i, 0, 0, spec.nchannels, 'float')
        names = spec.channelnames
        layer = names[0].rsplit('.', 1)[0].split('.', 1)[-1]
        if layer == 'Combined':
            out['A'] = px[..., names.index('ViewLayer.Combined.A')]
        elif layer.startswith('Combined_'):
            out[layer[9:]] = px[..., :3].mean(axis=-1)
        i += 1
    inp.close()
    return out


def load_effect(name):
    d = os.path.join(SRC, name)
    files = sorted(f for f in os.listdir(d) if f.endswith('.exr'))
    frames = [read_exr(os.path.join(d, f)) for f in files]
    n = len(frames)
    H, W = frames[0]['A'].shape
    L = np.zeros((n, 6, H, W), np.float32)
    A = np.zeros((n, H, W), np.float32)
    E = np.zeros((n, H, W), np.float32)
    for i, fr in enumerate(frames):
        A[i] = fr['A']
        for k in range(6):
            L[i, k] = fr.get(f'L{k}', 0)
        E[i] = fr.get('E', 0)
    # Cycles images are bottom-up in OIIO? (OIIO returns top-down scanlines: row 0 = top.)
    return L, A, E


def loopify(L, A, E, n=36):
    """N + K rendered frames -> N frames whose end flows into the start: the first K frames are
    cross-faded from the frames one loop later (frame i + N), so frame N-1 -> 0 is continuous."""
    k = A.shape[0] - n
    w = (np.arange(k, dtype=np.float32) / k)[:, None, None]
    A2, E2, L2 = A[:n].copy(), E[:n].copy(), L[:n].copy()
    A2[:k] = (1 - w) * A[n:] + w * A[:k]
    E2[:k] = (1 - w) * E[n:] + w * E[:k]
    L2[:k] = (1 - w[:, None]) * L[n:] + w[:, None] * L[:k]
    return L2, A2, E2


def resample(arr, n):
    """Pick n frames evenly (linear blend) from the rendered sequence."""
    m = arr.shape[0]
    if m == n:
        return arr
    t = np.linspace(0, m - 1, n)
    i0 = np.floor(t).astype(int)
    i1 = np.minimum(i0 + 1, m - 1)
    f = (t - i0).reshape((-1,) + (1,) * (arr.ndim - 1)).astype(np.float32)
    return arr[i0] * (1 - f) + arr[i1] * f


def blur(img, r=2):
    """Separable box blur (repeated) over the last two axes."""
    out = img
    for _ in range(2):
        for ax in (-1, -2):
            acc = np.zeros_like(out)
            for s in range(-r, r + 1):
                acc += np.roll(out, s, axis=ax)
            out = acc / (2 * r + 1)
    return out


def gblur(img, sigma):
    """Separable Gaussian over the last two axes."""
    r = max(1, int(round(sigma * 2.5)))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    out = img
    for ax in (-1, -2):
        acc = np.zeros_like(out)
        for i, s in enumerate(range(-r, r + 1)):
            acc += k[i] * np.roll(out, s, axis=ax)
        out = acc
    return out


def straighten(L, A, sigma=1.1):
    """Premultiplied light -> straight light (light per unit coverage).

    Light transport inside gas is smooth while the Monte Carlo estimate is not, so the light is
    denoised by normalised convolution (Gaussian of the premultiplied light / Gaussian of the
    coverage); the coverage itself (deterministic in Cycles) keeps all the silhouette detail. Thin /
    empty texels take a wide average of their neighbours' light so bilinear filtering never pulls
    black into the edges."""
    a = A[:, None]
    near = gblur(L, sigma) / np.maximum(gblur(np.repeat(a, 6, axis=1), sigma), 1e-4)
    wide = blur(L, 4) / np.maximum(blur(np.repeat(a, 6, axis=1), 4), 1e-4)
    k = np.clip(gblur(a, sigma) / 0.05, 0, 1)
    return near * k + wide * (1 - k)


def flow(I0, I1, iters=60, alpha=0.35):
    """Horn-Schunck optical flow I0 -> I1 (pixels), coarse to fine (3 levels)."""
    def down(x):
        return 0.25 * (x[0::2, 0::2] + x[1::2, 0::2] + x[0::2, 1::2] + x[1::2, 1::2])

    def up(x):
        return np.repeat(np.repeat(x, 2, 0), 2, 1) * 2

    def warp(img, u, v):
        H, W = img.shape
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        x = np.clip(xx + u, 0, W - 1.001)
        y = np.clip(yy + v, 0, H - 1.001)
        x0 = np.floor(x).astype(int)
        y0 = np.floor(y).astype(int)
        fx = x - x0
        fy = y - y0
        return ((img[y0, x0] * (1 - fx) + img[y0, x0 + 1] * fx) * (1 - fy) +
                (img[y0 + 1, x0] * (1 - fx) + img[y0 + 1, x0 + 1] * fx) * fy)

    pyr = [(I0, I1)]
    for _ in range(2):
        a, b = pyr[-1]
        pyr.append((down(a), down(b)))
    u = np.zeros_like(pyr[-1][0])
    v = np.zeros_like(u)
    for lvl in range(len(pyr) - 1, -1, -1):
        a, b = pyr[lvl]
        if u.shape != a.shape:
            u, v = up(u), up(v)
        for _ in range(iters):
            bw = warp(b, u, v)
            Ix = 0.5 * (np.roll(bw, -1, 1) - np.roll(bw, 1, 1))
            Iy = 0.5 * (np.roll(bw, -1, 0) - np.roll(bw, 1, 0))
            It = bw - a
            ub = 0.25 * (np.roll(u, 1, 0) + np.roll(u, -1, 0) + np.roll(u, 1, 1) + np.roll(u, -1, 1))
            vb = 0.25 * (np.roll(v, 1, 0) + np.roll(v, -1, 0) + np.roll(v, 1, 1) + np.roll(v, -1, 1))
            # linearised around the current estimate: residual It + Ix du + Iy dv
            du = ub - u
            dv = vb - v
            num = It + Ix * du + Iy * dv
            den = alpha * alpha + Ix * Ix + Iy * Iy
            u = ub - Ix * num / den
            v = vb - Iy * num / den
    return u, v


def motion(A, E, loop):
    n, H, W = A.shape
    sig = np.sqrt(np.clip(A, 0, 1)) + 0.5 * np.sqrt(np.clip(E, 0, 1))
    mv = np.zeros((n, 2, H, W), np.float32)
    for i in range(n):
        j = (i + 1) % n if loop else min(i + 1, n - 1)
        if j == i:
            mv[i] = mv[i - 1] if i else 0
            continue
        u, v = flow(blur(sig[i][None], 1)[0], blur(sig[j][None], 1)[0])
        mv[i, 0], mv[i, 1] = u, v
    return mv


def process(name, loop):
    L, A, E = load_effect(name)
    k = TRIM.get(name, 0)
    if k:
        L, A, E = L[k:], A[k:], E[k:]
    if loop:
        L, A, E = loopify(L, A, E, NF)
    if name in TOPFADE:
        H = A.shape[1]
        y = (np.arange(H, dtype=np.float32) + 0.5) / H  # 0 = top row
        f = np.clip(y / TOPFADE[name], 0, 1)
        f = (f * f * (3 - 2 * f))[None, :, None]
        A, E, L = A * f, E * f, L * f[:, None]
    L, A, E = resample(L, NF), resample(A, NF), resample(E, NF)
    E = gblur(E, 0.8)  # light Monte Carlo noise in the self-occluded emission
    S = straighten(L, A)
    # normalise: the brightest lit gas (99.5th percentile over the visible texels) -> 1
    vis = A > 0.25
    lmax = np.percentile(S.max(axis=1)[vis], 99.5) if vis.any() else 1.0
    S = S / max(lmax, 1e-6)
    em = float(np.percentile(E[E > 1e-4], 99.7)) if (E > 1e-4).sum() > 50 else 0.0
    En = E / em if em > 0 else E * 0
    mv = motion(A, En, loop)
    return dict(S=np.clip(S, 0, 1), A=np.clip(A, 0, 1), E=np.clip(En, 0, 1), M=mv, lnorm=float(lmax), enorm=em)


def to8(x):
    return np.clip(np.round(x * 255), 0, 255).astype(np.uint8)


def write_png(path, rgb):
    H, W, C = rgb.shape
    out = oiio.ImageOutput.create(path)
    out.open(path, oiio.ImageSpec(W, H, C, 'uint8'))
    out.write_image(rgb)
    out.close()


def preview_rgb(p, sun=(0.55, 0.6, 0.58), tint=(0.62, 0.6, 0.57), bg=(0.42, 0.47, 0.52)):
    """CPU version of the runtime shading (flipbook.ts) for contact sheets."""
    S, A, E = p['S'], p['A'], p['E']
    l = np.array(sun, np.float32)
    l /= np.linalg.norm(l)
    w = np.array([max(l[0], 0) ** 2, max(l[1], 0) ** 2, max(-l[0], 0) ** 2, max(-l[1], 0) ** 2,
                  max(l[2], 0) ** 2, max(-l[2], 0) ** 2], np.float32)
    up = np.array([0, 1, 0, 0, 0, 0], np.float32)
    sun_l = np.tensordot(w, S, axes=([0], [1]))
    sky = np.tensordot(up, S, axes=([0], [1]))
    avg = S.mean(axis=1)
    light = 1.15 * sun_l + 0.5 * (0.55 * sky + 0.45 * avg + 0.12)
    col = np.stack([light * t for t in tint], -1) * A[..., None]
    e = E
    x = np.sqrt(e)[..., None]
    c0 = np.array([0.55, 0.06, 0.01])
    c1 = np.array([1.0, 0.32, 0.05])
    c2 = np.array([1.0, 0.66, 0.25])
    c3 = np.array([1.0, 0.93, 0.8])

    def sm(a, b, t):
        t = np.clip((t - a) / (b - a), 0, 1)
        return t * t * (3 - 2 * t)
    ramp = c0 + (c1 - c0) * sm(0, 0.3, x)
    ramp = ramp + (c2 - ramp) * sm(0.25, 0.65, x)
    ramp = ramp + (c3 - ramp) * sm(0.6, 1.2, x)
    col = col + ramp * e[..., None] * 1.6
    out = col + np.array(bg) * (1 - A[..., None])
    # simple filmic-ish rolloff
    out = out / (1 + 0.35 * out)
    return np.clip(out ** (1 / 1.0), 0, 1)


def main():
    names = [PREVIEW] if PREVIEW else [k for k, _, _ in ORDER]
    res = {}
    for nm in names:
        if not os.path.isdir(os.path.join(SRC, nm)):
            print('[pack] missing', nm)
            continue
        loop = nm in LOOPS
        if PREVIEW:
            L, A, E = load_effect(nm)
            n = A.shape[0]
            S = straighten(L, A)
            vis = A > 0.25
            S = S / max(np.percentile(S.max(axis=1)[vis], 99.5) if vis.any() else 1, 1e-6)
            em = float(np.percentile(E[E > 1e-4], 99.7)) if (E > 1e-4).sum() > 50 else 1
            p = dict(S=np.clip(S, 0, 1), A=np.clip(A, 0, 1), E=np.clip(E / em, 0, 1))
            rgb = preview_rgb(p)
            per = 9
            rows = []
            for r0 in range(0, n, per):
                row = [rgb[i] if i < n else np.zeros_like(rgb[0]) for i in range(r0, r0 + per)]
                rows.append(np.concatenate(row, axis=1))
            write_png(os.path.join(SRC, f'preview-{nm}.png'), to8(np.concatenate(rows, 0)))
            print('[pack] preview', nm, n, 'frames')
            return
        print('[pack]', nm, flush=True)
        res[nm] = process(nm, loop)
    if not DST:
        return
    os.makedirs(DST, exist_ok=True)
    BX, BY = BLOCKS
    AW, AH = BX * GRID * FRAME, BY * GRID * FRAME
    atA = np.zeros((AH, AW, 4), np.uint8)
    atB = np.zeros((AH, AW, 4), np.uint8)
    atM = np.full((AH, AW, 3), 128, np.uint8)
    atM[..., 2] = 0
    man = dict(version=2, frame=FRAME, grid=GRID, blocks=[BX, BY], encoding='sqrt', motion=dict(scale=16), effects={})
    sheet_rows = []
    for bi, (nm, life, loop) in enumerate(ORDER):
        if nm not in res:
            continue
        p = res[nm]
        bx, by = bi % BX, bi // BX
        for f in range(NF):
            cx, cy = f % GRID, f // GRID
            x0 = (bx * GRID + cx) * FRAME
            y0 = (by * GRID + cy) * FRAME
            S = np.sqrt(p['S'][f])
            atA[y0:y0 + FRAME, x0:x0 + FRAME, 0] = to8(S[0])
            atA[y0:y0 + FRAME, x0:x0 + FRAME, 1] = to8(S[1])
            atA[y0:y0 + FRAME, x0:x0 + FRAME, 2] = to8(S[2])
            atA[y0:y0 + FRAME, x0:x0 + FRAME, 3] = to8(p['A'][f])
            atB[y0:y0 + FRAME, x0:x0 + FRAME, 0] = to8(S[3])
            atB[y0:y0 + FRAME, x0:x0 + FRAME, 1] = to8(S[4])
            atB[y0:y0 + FRAME, x0:x0 + FRAME, 2] = to8(S[5])
            atB[y0:y0 + FRAME, x0:x0 + FRAME, 3] = to8(np.sqrt(p['E'][f]))
            # motion in frame pixels, +-16 px range (image y down)
            atM[y0:y0 + FRAME, x0:x0 + FRAME, 0] = to8(0.5 + p['M'][f, 0] / 32)
            atM[y0:y0 + FRAME, x0:x0 + FRAME, 1] = to8(0.5 + p['M'][f, 1] / 32)
        man['effects'][nm] = dict(block=bi, life=life, loop=loop, emission=round(p['enorm'], 5),
                                  light=round(p['lnorm'], 5))
        if SHEET:
            rgb = preview_rgb(p)
            idx = list(range(0, NF, 3))
            sheet_rows.append(np.concatenate([rgb[i] for i in idx], axis=1))
    tmp = os.path.join(SRC, '_atlas')
    os.makedirs(tmp, exist_ok=True)
    # Split, lossy layout (WebP compresses an alpha plane losslessly, which made RGBA atlases heavy):
    #   fx-l0 / fx-l1  the six lightmaps at half resolution (light inside gas is smooth; the coverage
    #                  carries the detail) - shared by every quality tier
    #   fx-c / fx-e    coverage and emission, grey, full resolution (+ -half for phones)
    #   fx-m           motion vectors at half (-half: quarter) resolution
    # flipbook.ts re-assembles them into the two RGBA textures the shader samples.
    for f in os.listdir(DST):
        if f.startswith('fx-') and f.endswith('.webp'):
            os.remove(os.path.join(DST, f))
    lossy = ['-define', 'webp:method=6', '-define', 'webp:use-sharp-yuv=true']
    jobs = [
        ('fx-l0', atA[..., :3], [('', '50%', '82')]),
        ('fx-l1', atB[..., :3], [('', '50%', '82')]),
        ('fx-c', np.repeat(atA[..., 3:], 3, -1), [('', '100%', '85'), ('-half', '50%', '85')]),
        ('fx-e', np.repeat(atB[..., 3:], 3, -1), [('', '100%', '85'), ('-half', '50%', '85')]),
        ('fx-m', atM, [('', '50%', '75'), ('-half', '25%', '75')]),
    ]
    for nm, img, outs in jobs:
        png = os.path.join(tmp, nm + '.png')
        write_png(png, np.ascontiguousarray(img))
        for sfx, scale, q in outs:
            # box filter: 128 px cells stay aligned and never bleed into their neighbours
            subprocess.run(['convert', png, '-filter', 'Box', '-resize', scale] + lossy +
                           ['-quality', q, os.path.join(DST, nm + sfx + '.webp')], check=True)
    man['layout'] = dict(light=0.5)
    with open(os.path.join(DST, 'fx.json'), 'w') as f:
        json.dump(man, f, indent=1)
    if SHEET and sheet_rows:
        write_png(SHEET, to8(np.concatenate(sheet_rows, 0)))
    for f in sorted(os.listdir(DST)):
        print('[pack]', f, os.path.getsize(os.path.join(DST, f)))


main()
