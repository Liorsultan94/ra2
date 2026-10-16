# Blender 5.2.2 (LTS) - GD3: desert vegetation for Wadi Al-Rimal (date palms, coconut palms, acacias, shrubs).
#
#   blender -b --factory-startup -P tools/blender/desertveg/desert_veg.py -- [atlas|models|preview|all]   (from web/; make.sh)
#
# atlas    the high poly parts are modelled leaflet by leaflet and rendered top down (Cycles, orthographic) into ONE
#          shared atlas: albedo + alpha cutout, tangent normals, baked AO:
#            - frond cards: fresh and older date fronds (stiff glaucous leaflets in a V, spines at the base), a dead
#              hanging frond, a coconut frond (long soft drooping leaflets);
#            - foliage cards: umbrella acacia sprays (bipinnate leaflets, white thorns), a desert shrub, a dry
#              thorn bush; a hanging bunch of dates, a cluster of coconuts;
#            - tiling barks (periodic by construction, with a wrap-around gutter): the date palm's diamond
#              pattern of cut leaf bases with fibre between them, the ringed coconut trunk, furrowed acacia bark.
#          -> build/desertveg/atlas-{albedo,normal}.png + cards.json (card frames, frond envelopes)
# models   the game meshes (LOD0, LOD1 and a far impostor each): date palms (tall, short, leaning, a clump with
#          offshoots), a leaning coconut palm, a flat-topped acacia and a young one, a shrub and a thorn bush;
#          bent V-folded frond strips trimmed to each card's leaflet envelope (less alpha overdraw), bark tubes,
#          crossed date bunches; canopy-shaped normals; per vertex wind weight (_flex), leaf amount (_leaf), AO (_ao).
#          The impostors (crossed side cards + a top card) are rendered from the LOD0 models into the atlas.
#          -> build/desertveg/desert-veg-raw.glb + desert-veg.json
# preview  a lit contact sheet of the LOD0 models (Cycles) -> build/desertveg/preview.png
# Then tools/blender/desertveg/pack.mjs compresses everything into public/models/desertveg/.
#
# Conventions: Blender Z up (glTF / game Y up), 1 unit = 1 map tile (~10 m), origin at the plant's foot.
# Atlas pixels: top-left origin (glTF uv, v down); in Blender the uv v is 1 - y / ATLAS. Normal maps are
# OpenGL style (green = up in the image), the game reads them with normalScale (1, -1) as the Sinai kit does.
import bpy
import json
import math
import os
import sys
import time

import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import common as C  # noqa: E402

OUT = os.path.join(C.BUILD, 'desertveg')
os.makedirs(OUT, exist_ok=True)
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
STAGE = ARGS[0] if ARGS else 'all'
A = 1024
GUT = 8  # wrap-around gutter of the tiling barks (px)
Z = Vector((0, 0, 1))

# atlas rects (px: x, y, w, h from the top left)
RECTS = {
    'frond_date': (0, 0, 512, 128),
    'frond_date2': (0, 128, 512, 128),
    'frond_dry': (0, 256, 512, 128),
    'frond_coco': (512, 0, 512, 160),
    'acacia': (512, 160, 256, 256),
    'acacia2': (768, 160, 256, 256),
    'shrub': (512, 416, 256, 256),
    'thorn': (768, 416, 256, 256),
    'bark_date': (0, 384, 256, 512),
    'bark_coco': (256, 384, 128, 512),
    'bark_acacia': (384, 384, 128, 256),
    'dates': (384, 640, 128, 256),
    'imp_date': (512, 672, 192, 256),
    'imp_coco': (704, 672, 192, 256),
    'imp_date_top': (896, 672, 128, 128),
    'imp_coco_top': (896, 800, 128, 128),
    'imp_acacia': (0, 896, 256, 128),
    'imp_acacia_top': (256, 896, 128, 128),
    'coconuts': (384, 896, 128, 128),
}
BARKS = ('bark_date', 'bark_coco', 'bark_acacia')


def log(*a):
    print('[veg]', *a, flush=True)


def lin(h):
    return tuple(float(x) for x in C.hexlin(h))


def mixc(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def jit(c, rng, k=0.12):
    f = 1 + (rng.random() - 0.5) * 2 * k
    return tuple(min(1.0, max(0.0, x * f * (1 + (rng.random() - 0.5) * k * 0.6))) for x in c)


def sst(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


# ================================================================== high poly

class HP:
    """High poly accumulator: vertices, faces and a per vertex colour (linear)."""

    def __init__(self):
        self.V, self.F, self.C = [], [], []

    def add(self, verts, faces, cols):
        b = len(self.V)
        self.V += [tuple(v) for v in verts]
        self.F += [[b + i for i in f] for f in faces]
        if isinstance(cols[0], (int, float)):
            cols = [cols] * len(verts)
        self.C += [tuple(c) for c in cols]

    def obj(self, name):
        me = bpy.data.meshes.new(name)
        me.from_pydata(self.V, [], self.F)
        me.validate()
        a = me.attributes.new('col', 'FLOAT_COLOR', 'POINT')
        a.data.foreach_set('color', np.array([(c[0], c[1], c[2], 1.0) for c in self.C], np.float32).ravel())
        me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
        o = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(o)
        return o


def frame_of(p0, p1):
    """Two unit vectors across a segment p0 -> p1."""
    d = (p1 - p0).normalized()
    e1 = d.cross(Z if abs(d.z) < 0.95 else Vector((1, 0, 0))).normalized()
    return d, e1, d.cross(e1).normalized()


def tube(hp, pts, radii, cols, sides=8):
    verts, faces, cc = [], [], []
    for i, p in enumerate(pts):
        j0, j1 = (i, i + 1) if i < len(pts) - 1 else (i - 1, i)
        _, e1, e2 = frame_of(pts[j0], pts[j1])
        for k in range(sides):
            a = k / sides * math.tau
            verts.append(p + (e1 * math.cos(a) + e2 * math.sin(a)) * radii[i])
            cc.append(cols[i] if isinstance(cols[0], tuple) else cols)
    for i in range(len(pts) - 1):
        for k in range(sides):
            a, b = i * sides + k, i * sides + (k + 1) % sides
            faces.append([a, b, b + sides, a + sides])
    hp.add(verts, faces, cc)


def blade(hp, base, d, side, up, l, w, col, segs=6, fold=0.35, droop=0.0, tipcol=None, midk=1.12, taper=0.6):
    """A leaflet / spine: a pointed strip folded along its midrib (a V), its tip drooping by `droop`."""
    verts, faces, cc = [], [], []
    for i in range(segs + 1):
        s = i / segs
        wd = w * min(1.0, s / 0.12) ** 0.5 * (1 - s) ** taper
        p = base + d * (l * s) - up * (droop * l * s * s)
        c = col if tipcol is None else mixc(col, tipcol, sst(0.55, 1.0, s))
        verts += [p - side * (wd / 2) + up * (fold * wd / 2), p, p + side * (wd / 2) + up * (fold * wd / 2)]
        cc += [c, tuple(min(1.0, x * midk) for x in c), c]
    for i in range(segs):
        a = i * 3
        faces += [[a, a + 1, a + 4, a + 3], [a + 1, a + 2, a + 5, a + 4]]
    hp.add(verts, faces, cc)


def blob(hp, c, rx, ry, rz, col, nu=8, nv=5, rot=0.0):
    """A small ellipsoid (dates, coconuts, fleshy leaves)."""
    verts, faces = [], []
    ca, sa = math.cos(rot), math.sin(rot)
    for j in range(nv + 1):
        v = j / nv * math.pi
        for i in range(nu):
            u = i / nu * math.tau
            x, y, z = math.sin(v) * math.cos(u) * rx, math.cos(v) * ry, math.sin(v) * math.sin(u) * rz
            verts.append(c + Vector((x * ca - y * sa, x * sa + y * ca, z)))
    for j in range(nv):
        for i in range(nu):
            a, b = j * nu + i, j * nu + (i + 1) % nu
            faces.append([a, b, b + nu, a + nu])
    hp.add(verts, faces, col)


def leaf_quad(hp, c, d, l, w, col, tilt=0.0):
    """A tiny flat leaflet (an elongated hexagon) centred at c along d, tilted about d."""
    s = Vector((-d.y, d.x, 0)).normalized()
    up = Vector((0, 0, 1))
    s = s * math.cos(tilt) + up * math.sin(tilt)
    pts = [c - d * (l / 2), c - d * (l * 0.2) + s * (w / 2), c + d * (l * 0.25) + s * (w / 2), c + d * (l / 2), c + d * (l * 0.25) - s * (w / 2), c - d * (l * 0.2) - s * (w / 2)]
    hp.add(pts, [[0, 1, 2, 3, 4, 5]], col)


# ------------------------------------------------------------------ cards

def frond_card(rng, kind):
    """A frond lying along +x from 0 (root) to 1 (tip), its upper face up (+z). kind: date, date2, dry, coco."""
    hp = HP()
    coco = kind == 'coco'
    dry = kind == 'dry'
    # the rachis: a flat petiole at the root, tapering to the tip
    n = 24
    pts = [Vector((t, 0, 0)) for t in (i / n for i in range(n + 1))]
    rad = [(0.011 if coco else 0.009) * (1 - 0.75 * t) + 0.0015 for t in (i / n for i in range(n + 1))]
    rcol = lin(0xb8b070) if coco else lin(0xa8a070) if not dry else lin(0x9a7a50)
    tube(hp, pts, rad, rcol, 7)
    if coco:
        lo, hi_, step, Lmax = 0.17, 0.985, 0.0105, 0.165
        base = lin(0x6a8c3c)
    elif dry:
        lo, hi_, step, Lmax = 0.27, 0.975, 0.0125, 0.125
        base = lin(0xa0805a)
    else:
        lo, hi_, step, Lmax = 0.25, 0.985, 0.011, 0.158
        base = lin(0x6a8a5c) if kind == 'date' else lin(0x7f8d5c)
    # spines on the date petiole
    if not coco:
        t = 0.11
        side = 1
        while t < lo:
            k = (t - 0.11) / (lo - 0.11)
            th = math.radians(48 + rng.random() * 10)
            el = math.radians(rng.random() * 35)
            d = Vector((math.cos(th), side * math.sin(th) * math.cos(el), math.sin(el))).normalized()
            sd = d.cross(Z).normalized()
            blade(hp, Vector((t, side * 0.004, 0.002)), d, sd, sd.cross(d), 0.018 + 0.045 * k, 0.0035, lin(0xc8b47a) if not dry else lin(0xa8906a), segs=3, fold=0.1, taper=1.0)
            t += 0.009 + rng.random() * 0.005
            side = -side
    t = lo
    side = 1
    g = 0
    while t < hi_:
        u = (t - lo) / (hi_ - lo)
        env = math.sin(math.pi * min(1.0, 0.12 + u * 0.95)) ** 0.55
        for _ in range(2):
            if dry and rng.random() < 0.3:
                side = -side
                continue
            if coco:
                th = math.radians(62 + rng.random() * 14)
                el = -math.radians(18 + rng.random() * 30)
                droop = 0.25 + rng.random() * 0.2
            else:
                # date leaflets in groups of three at different angles (the V of a date frond, seen from above)
                th = math.radians((22 if dry else 39) + rng.random() * 14 - (g % 3) * 3)
                el = math.radians((g % 3) * 14 + rng.random() * 12) if not dry else math.radians(rng.random() * 20 - 10)
                droop = 0.05 if not dry else 0.15
            l = Lmax * env * (0.85 + rng.random() * 0.3)
            if dry and rng.random() < 0.35:
                l *= 0.35 + rng.random() * 0.5
            l = min(l, (1.0 - t) / math.cos(th) + 0.012)
            d = Vector((math.cos(th), side * math.sin(th) * math.cos(el), math.sin(el))).normalized()
            sd = d.cross(Z).normalized()
            up = sd.cross(d).normalized()
            if up.z < 0:
                up = -up
            c = jit(base, rng, 0.14)
            tip = None
            if not coco and rng.random() < (0.18 if kind == 'date' else 0.5 if kind == 'date2' else 0.0):
                tip = lin(0x9a8050)
            if coco and rng.random() < 0.15:
                tip = lin(0xa89a50)
            if kind == 'date2' and rng.random() < 0.3:
                c = mixc(c, lin(0xa0a060), 0.5)
            w = (0.0115 if coco else 0.0085) * (0.85 + rng.random() * 0.3)
            blade(hp, Vector((t, side * 0.003, 0.003)), d, sd, up, l, w, c, segs=7 if coco else 6, fold=0.2 if coco else 0.45, droop=droop, tipcol=tip)
            side = -side
        g += 1
        t += step * (0.8 + rng.random() * 0.4)
    return hp


def spray_card(rng, kind):
    """Top view foliage clump centred at the origin (radius ~0.23): acacia, acacia2, shrub, thorn."""
    hp = HP()
    twigc = lin(0x5a4634)
    if kind in ('acacia', 'acacia2'):
        sparse = kind == 'acacia2'
        nt = 8 if sparse else 11
        for i in range(nt):
            a = i / nt * math.tau + rng.random() * 0.5
            L = 0.15 + rng.random() * 0.08
            pts, p, ang = [], Vector((rng.random() * 0.02, rng.random() * 0.02, 0.0)), a
            for k in range(7):
                pts.append(p.copy())
                ang += (rng.random() - 0.5) * 0.5
                p = p + Vector((math.cos(ang), math.sin(ang), 0.004)) * (L / 6)
            tube(hp, pts, [0.0042 * (1 - k / 8) + 0.001 for k in range(7)], twigc, 5)
            # paired white thorns at the nodes
            for k in range(1, 6):
                q = pts[k]
                dd = (pts[k + 1] - pts[k]).normalized()
                sd = Vector((-dd.y, dd.x, 0))
                for sg in (-1, 1):
                    dt = (sd * sg * 0.85 + dd * 0.5).normalized()
                    blade(hp, q, dt, dt.cross(Z).normalized(), Z, 0.013 + rng.random() * 0.005, 0.0016, lin(0xe6dfd0), segs=2, fold=0.0, taper=1.0)
            # pinnae (bipinnate sprays of tiny leaflets) along the twig and round its tip
            npin = 16 if sparse else 30
            for k in range(npin):
                f = min(0.999, 0.2 + 0.8 * (k / npin) ** 0.6)
                idx = min(5, int(f * 6))
                q = pts[idx].lerp(pts[idx + 1], f * 6 - idx)
                dd = (pts[idx + 1] - pts[idx]).normalized()
                ang2 = math.atan2(dd.y, dd.x) + (rng.random() - 0.5) * 2.2
                dpin = Vector((math.cos(ang2), math.sin(ang2), 0))
                Lp = 0.032 + rng.random() * 0.026
                c = jit(lin(0x6f7d40), rng, 0.16)
                if rng.random() < 0.12:
                    c = mixc(c, lin(0xa09a50), 0.6)
                npair = 9 + int(rng.random() * 5)
                for j in range(npair):
                    s = (j + 0.5) / npair
                    pc = q + dpin * (Lp * s) + Vector((0, 0, 0.004 + rng.random() * 0.012))
                    sd = Vector((-dpin.y, dpin.x, 0))
                    for sg in (-1, 1):
                        dl = (sd * sg + dpin * 0.25).normalized()
                        leaf_quad(hp, pc + dl * 0.0035, dl, 0.0075 * (1.05 - s * 0.3), 0.0032, c, tilt=sg * 0.35 + (rng.random() - 0.5) * 0.4)
    elif kind == 'shrub':
        for i in range(16):
            a = i / 16 * math.tau + rng.random() * 0.4
            L = 0.12 + rng.random() * 0.1
            pts, p, ang = [], Vector((0, 0, 0)), a
            for k in range(6):
                pts.append(p.copy())
                ang += (rng.random() - 0.5) * 0.6
                p = p + Vector((math.cos(ang), math.sin(ang), 0.012 - k * 0.002)) * (L / 5)
            tube(hp, pts, [0.003 * (1 - k / 7) + 0.0008 for k in range(6)], lin(0x7a6a58), 5)
            base = jit(lin(0x8a9670), rng, 0.1)
            for k in range(42):
                f = 0.25 + 0.75 * rng.random()
                idx = min(4, int(f * 5))
                q = pts[idx].lerp(pts[idx + 1], f * 5 - idx)
                off = Vector(((rng.random() - 0.5) * 0.03, (rng.random() - 0.5) * 0.03, rng.random() * 0.01))
                c = jit(base, rng, 0.12)
                if rng.random() < 0.1:
                    c = lin(0xa89a70)
                blob(hp, q + off, 0.008 + rng.random() * 0.003, 0.0048, 0.004, c, nu=6, nv=4, rot=rng.random() * math.tau)
    else:  # thorn: a dry tangle of zig-zag twigs, thorns at the nodes, a few tiny leaves
        def grow(p, ang, r, depth):
            if depth > 6 or p.length > 0.22:
                return
            L = 0.03 + rng.random() * 0.025
            q = p + Vector((math.cos(ang), math.sin(ang), 0.003)) * L
            tube(hp, [p, q], [r, r * 0.85], jit(lin(0x8e7c66), rng, 0.15), 4)
            dd = (q - p).normalized()
            sd = Vector((-dd.y, dd.x, 0))
            for sg in (-1, 1):
                if rng.random() < 0.75:
                    dt = (sd * sg + dd * 0.6).normalized()
                    blade(hp, q, dt, dt.cross(Z).normalized(), Z, 0.009 + rng.random() * 0.008, 0.0014, lin(0xd8cdb8), segs=2, fold=0.0, taper=1.0)
            if rng.random() < 0.18:
                blob(hp, q + Vector((0, 0, 0.003)), 0.005, 0.003, 0.002, jit(lin(0x8a9060), rng, 0.1), nu=5, nv=3, rot=ang)
            grow(q, ang + (rng.random() - 0.5) * 1.2, r * 0.85, depth + 1)
            if rng.random() < 0.38:
                grow(q, ang + (0.7 if rng.random() < 0.5 else -0.7) + (rng.random() - 0.5) * 0.4, r * 0.75, depth + 1)

        for i in range(12):
            grow(Vector((0, 0, 0)), i / 12 * math.tau + rng.random() * 0.4, 0.0042, 0)
    return hp


def dates_card(rng):
    """A bunch of dates hanging from its stalk (side view: +y up), frame 0.25 x 0.5."""
    hp = HP()
    stalk = [Vector((0.0, 0.24, 0)), Vector((0.012, 0.2, 0)), Vector((0.016, 0.16, 0)), Vector((0.012, 0.12, 0))]
    tube(hp, stalk, [0.009, 0.008, 0.0075, 0.007], lin(0xd0a040), 6)
    cols = [lin(0xb8641e), lin(0xa04818), lin(0xd08a2a), lin(0x7a3a18), lin(0xc87a24), lin(0xd8a83a)]
    for i in range(22):
        x1 = (rng.random() - 0.5) * 0.2
        y1 = -0.2 + rng.random() * 0.14
        p0 = Vector((0.012 + (rng.random() - 0.5) * 0.01, 0.12, 0))
        pts = [p0.lerp(Vector((x1, y1, 0)), s) + Vector((0, 0.02 * math.sin(math.pi * s), 0)) for s in (0, 0.33, 0.66, 1.0)]
        tube(hp, pts, [0.0022, 0.002, 0.0018, 0.0016], lin(0xc89a50), 4)
        cb = cols[int(rng.random() * len(cols))]
        for k in range(6):
            s = 0.3 + 0.7 * k / 5
            c = pts[0].lerp(pts[-1], s) + Vector(((rng.random() - 0.5) * 0.012, 0, 0.004))
            blob(hp, c, 0.0085, 0.013, 0.0085, jit(cb, rng, 0.12), nu=8, nv=6, rot=(rng.random() - 0.5) * 0.5)
    return hp


def coconuts_card(rng):
    hp = HP()
    tube(hp, [Vector((0, 0.11, 0)), Vector((0, 0.06, 0))], [0.008, 0.007], lin(0xb0a050), 6)
    cols = [lin(0x6a7a2a), lin(0x8a7a30), lin(0x7a5a28), lin(0x5f7026)]
    for i in range(5):
        a = i / 5 * math.tau + 0.3
        c = Vector((math.cos(a) * 0.045, 0.02 + math.sin(a) * 0.035, 0.01 * math.sin(a)))
        blob(hp, c, 0.042, 0.048, 0.042, jit(cols[i % 4], rng, 0.1), nu=14, nv=10, rot=a * 0.3)
    return hp


def fft_noise(n, m, rng, lo, hi, aniso=(1.0, 1.0)):
    """Periodic band-limited noise on an m (rows) x n (cols) grid, normalised to -1..1."""
    w = rng.standard_normal((m, n)) + 1j * rng.standard_normal((m, n))
    fy = np.fft.fftfreq(m)[:, None] * m * aniso[1]
    fx = np.fft.fftfreq(n)[None, :] * n * aniso[0]
    f = np.sqrt(fx * fx + fy * fy)
    amp = np.where((f >= lo) & (f <= hi), 1.0 / np.maximum(f, 1), 0.0)
    a = np.real(np.fft.ifft2(w * amp))
    return a / (np.abs(a).max() + 1e-9)


def grid_mesh(hp, W, H, nx, ny, hgt, col):
    """A periodic height field (W x H, nx x ny cells) with per vertex colour; extended one tile all round."""
    xs = (np.arange(-nx // 4, nx + nx // 4 + 1)) / nx
    ys = (np.arange(-ny // 4, ny + ny // 4 + 1)) / ny
    verts, cols = [], []
    for y in ys:
        for x in xs:
            i, j = int(round(x * nx)) % nx, int(round(y * ny)) % ny
            verts.append(Vector((x * W, y * H, float(hgt[j, i]))))
            cols.append(tuple(col[j, i]))
    cx, cy = len(xs), len(ys)
    faces = [[j * cx + i, j * cx + i + 1, (j + 1) * cx + i + 1, (j + 1) * cx + i] for j in range(cy - 1) for i in range(cx - 1)]
    hp.add(verts, faces, cols)


def bark_card(rng, kind):
    """A tiling bark (period W = 1 around the trunk x H along it, frame [0, W] x [0, H])."""
    x, y, w, h = RECTS[kind]
    W, H = 1.0, (h - 2 * GUT) / (w - 2 * GUT)
    hp = HP()
    if kind == 'bark_date':
        # dark fibrous core, a weave of fibres, and the cut leaf bases in a diamond lattice
        grid_mesh(hp, W, H, 32, 64, np.zeros((64, 32)), np.tile(np.array(lin(0x3c2c1e))[None, None, :], (64, 32, 1)))
        fibres = []
        for i in range(260):
            p = Vector((rng.random() * W, rng.random() * H, 0.006 + rng.random() * 0.02))
            a = (0.6 if rng.random() < 0.5 else -0.6) + (rng.random() - 0.5) * 0.5 + math.pi / 2
            L = 0.08 + rng.random() * 0.1
            fibres.append((p, Vector((math.cos(a), math.sin(a), 0)) * L, jit(lin(0x5e4630), rng, 0.25)))
        NC, NR = 6, 7
        stubs = []
        for k in range(NC):
            for j in range(NR):
                cx = (k + 0.5) / NC * W + (rng.random() - 0.5) * 0.015
                cy = (j + 0.5 * (k % 2)) / NR * H + (rng.random() - 0.5) * 0.02
                stubs.append((cx, cy, jit(lin(0x8a7660), rng, 0.15), rng.random()))
        for ox in (-W, 0, W):
            for oy in (-H, 0, H):
                for p, d, c in fibres:
                    q = p + Vector((ox, oy, 0))
                    tube(hp, [q, q + d * 0.5 + Vector((0, 0, 0.004)), q + d], [0.004, 0.004, 0.0035], c, 4)
                for cx, cy, c, r in stubs:
                    bx, by = cx + ox, cy + oy
                    if bx < -0.2 or bx > W + 0.2 or by < -0.3 or by > H + 0.3:
                        continue
                    # a boot: narrow and flush at the bottom, wide and standing out at the top, cut flat
                    hw0, hw1 = 0.03, 0.068 + r * 0.008
                    hh = H / NR * 0.52
                    zt = 0.055 + r * 0.02
                    v = [Vector((bx - hw0, by - hh, 0.0)), Vector((bx + hw0, by - hh, 0.0)), Vector((bx + hw1, by + hh * 0.7, zt * 0.75)), Vector((bx - hw1, by + hh * 0.7, zt * 0.75)),
                         Vector((bx - hw1 * 0.92, by + hh * 0.95, zt)), Vector((bx + hw1 * 0.92, by + hh * 0.95, zt)), Vector((bx + hw1 * 0.8, by + hh * 0.8, 0.0)), Vector((bx - hw1 * 0.8, by + hh * 0.8, 0.0))]
                    top = mixc(c, lin(0xb8a688), 0.55)
                    hp.add(v, [[0, 1, 2, 3], [3, 2, 5, 4], [4, 5, 6, 7], [0, 3, 7], [1, 6, 2]], [c, c, c, c, top, top, c, c])
                    # weathered vertical grain on the boot's face
                    for g in range(3):
                        gx = bx + (g - 1) * hw1 * 0.5
                        tube(hp, [Vector((gx * 0.9 + bx * 0.1, by - hh * 0.6, 0.004)), Vector((gx, by + hh * 0.6, zt * 0.7 + 0.002))], [0.0028, 0.0028], mixc(c, (0.0, 0.0, 0.0), 0.35), 3)
    elif kind == 'bark_coco':
        nx, ny = 48, 212
        crack = fft_noise(nx, ny, rng, 3, 14, aniso=(1.0, 0.18))
        fine = fft_noise(nx, ny, rng, 8, 40, aniso=(1.0, 0.5))
        yy = np.arange(ny)[:, None] / ny * H
        nring = 8
        ph = (yy / H * nring) % 1.0
        wav = 0.012 * np.sin(np.arange(nx)[None, :] / nx * math.tau * 2 + yy * 3)
        ring = np.exp(-(((ph + wav) - 0.5) / 0.045) ** 2)
        hgt = ring * 0.016 - np.maximum(0, crack) ** 2 * 0.012 + fine * 0.002
        base = np.array(lin(0x857a6a))
        col = base[None, None, :] * (0.92 + 0.1 * fine[..., None]) * (1 - 0.35 * np.maximum(0, crack[..., None]) ** 2)
        col = col * (1 - 0.32 * ring[..., None]) + np.array(lin(0x6e6050))[None, None, :] * 0.32 * ring[..., None]
        grid_mesh(hp, W, H, nx, ny, hgt, col)
    else:  # bark_acacia: deep vertical furrows, reddish in the cracks
        nx, ny = 56, 120
        ridges = fft_noise(nx, ny, rng, 2, 9, aniso=(1.0, 0.22))
        fine = fft_noise(nx, ny, rng, 10, 36, aniso=(1.0, 0.6))
        hgt = np.abs(ridges) * -0.035 + fine * 0.004
        k = np.clip(np.abs(ridges), 0, 1)[..., None]
        top = np.array(lin(0x7a6a5c))
        fur = np.array(lin(0x6a3e2a))
        col = top[None, None, :] * (1 - k * 0.7) + fur[None, None, :] * k * 0.7
        col *= (0.92 + 0.12 * fine[..., None])
        grid_mesh(hp, W, H, nx, ny, hgt, col)
    return hp, (0.0, 0.0, W, H)


# ------------------------------------------------------------------ rendering

SC = None


def scene_setup():
    global SC
    SC = C.reset(threads=3)
    SC.cycles.use_denoising = False
    SC.cycles.filter_width = 1.0
    SC.cycles.max_bounces = 0
    SC.cycles.transparent_max_bounces = 32
    w = bpy.data.worlds.new('w')
    SC.world = w
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs[1].default_value = 0.0
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    SC.collection.objects.link(cam)
    cam.data.type = 'ORTHO'
    SC.camera = cam
    SC.render.image_settings.file_format = 'OPEN_EXR'
    SC.render.image_settings.color_depth = '32'
    SC.render.film_transparent = False


def pass_material(mode, atlas=None):
    """Emission materials for the passes: colour attribute ('albedo'), white ('mask'), world normal ('normal'),
    AO ('ao'). With `atlas` (bpy images), the albedo / mask come from the atlas (alpha tested) and the AO attribute."""
    m = bpy.data.materials.new(f'pass_{mode}_{atlas is not None}')
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    L = nt.links.new
    if mode == 'albedo':
        if atlas:
            tx = nt.nodes.new('ShaderNodeTexImage')
            tx.image = atlas
            tx.interpolation = 'Closest'
            ao = nt.nodes.new('ShaderNodeAttribute')
            ao.attribute_name = '_ao'
            mul = nt.nodes.new('ShaderNodeMix')
            mul.data_type = 'RGBA'
            mul.blend_type = 'MULTIPLY'
            mul.inputs['Factor'].default_value = 1.0
            L(tx.outputs['Color'], mul.inputs[6])
            L(ao.outputs['Fac'], mul.inputs[7])
            L(mul.outputs[2], em.inputs['Color'])
        else:
            at = nt.nodes.new('ShaderNodeAttribute')
            at.attribute_name = 'col'
            L(at.outputs['Color'], em.inputs['Color'])
    elif mode == 'mask':
        em.inputs['Color'].default_value = (1, 1, 1, 1)
    elif mode == 'normal':
        g = nt.nodes.new('ShaderNodeNewGeometry')
        vm = nt.nodes.new('ShaderNodeVectorMath')
        vm.operation = 'MULTIPLY_ADD'
        vm.inputs[1].default_value = (0.5, 0.5, 0.5)
        vm.inputs[2].default_value = (0.5, 0.5, 0.5)
        L(g.outputs['Normal'], vm.inputs[0])
        L(vm.outputs[0], em.inputs['Color'])
    elif mode == 'ao':
        ao = nt.nodes.new('ShaderNodeAmbientOcclusion')
        ao.inputs['Distance'].default_value = 0.03
        ao.samples = 16
        L(ao.outputs['AO'], em.inputs['Color'])
    shader = em.outputs[0]
    if atlas:
        # alpha test like the game (0.42), hard edged
        tx2 = nt.nodes.new('ShaderNodeTexImage')
        tx2.image = atlas
        tx2.interpolation = 'Closest'
        gt = nt.nodes.new('ShaderNodeMath')
        gt.operation = 'GREATER_THAN'
        gt.inputs[1].default_value = 0.42
        L(tx2.outputs['Alpha'], gt.inputs[0])
        tr = nt.nodes.new('ShaderNodeBsdfTransparent')
        mx = nt.nodes.new('ShaderNodeMixShader')
        L(gt.outputs[0], mx.inputs[0])
        L(tr.outputs[0], mx.inputs[1])
        L(em.outputs[0], mx.inputs[2])
        shader = mx.outputs[0]
    L(shader, out.inputs[0])
    return m


def read_exr(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return a.reshape(h, w, 4)[::-1, :, :3].copy()


def render(objs, frame, size, modes, samples=24, view='top', ao_dist=0.03, atlas=None):
    """Orthographic render of objs over `frame` (x0, y0, w, h in world units) at `size` (px w, h) -> {mode: (h, w, 3)}."""
    x0, y0, fw, fh = frame
    cam = SC.camera
    if view == 'top':
        cam.location = (x0 + fw / 2, y0 + fh / 2, 20)
        cam.rotation_euler = (0, 0, 0)
    else:  # side: looking along +y, image right = +x, up = +z
        cam.location = (x0 + fw / 2, -20, y0 + fh / 2)
        cam.rotation_euler = (math.pi / 2, 0, 0)
    cam.data.ortho_scale = max(fw, fh)
    cam.data.clip_end = 60
    SC.render.resolution_x, SC.render.resolution_y = size
    SC.render.resolution_percentage = 100
    out = {}
    for mode in modes:
        m = pass_material(mode, atlas if mode in ('albedo', 'mask') else None)
        if mode == 'ao':
            m.node_tree.nodes['Ambient Occlusion'].inputs['Distance'].default_value = ao_dist
        for o in objs:
            o.data.materials.clear()
            o.data.materials.append(m)
        SC.cycles.samples = samples * (2 if mode == 'ao' else 1)
        path = os.path.join(OUT, f'_pass_{mode}.exr')
        SC.render.filepath = path
        bpy.ops.render.render(write_still=True)
        out[mode] = read_exr(path)
    return out


def dilate(rgb, cov, iters=24):
    """Bleed colour from covered pixels into the empty ones (mip / filtering fringes)."""
    ok = cov > 0.02
    col = np.where(ok[..., None], rgb, 0)
    wsum = ok.astype(np.float32)
    for _ in range(iters):
        if ok.all():
            break
        acc = np.zeros_like(col)
        cnt = np.zeros_like(wsum)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            acc += np.roll(np.roll(col * ok[..., None], dy, 0), dx, 1)
            cnt += np.roll(np.roll(ok.astype(np.float32), dy, 0), dx, 1)
        new = (~ok) & (cnt > 0)
        col[new] = acc[new] / cnt[new][:, None]
        ok = ok | new
    if not ok.all():
        col[~ok] = col[ok].mean(0) if ok.any() else 0.5
    return col


def compose_card(px, frame_px, alb, nrm, ao, cov, tile=False):
    """Write one rendered card into the atlas arrays (px: dict of atlas arrays)."""
    x, y, w, h = frame_px
    c = np.clip(cov, 0, 1)
    if tile:
        a = alb
        n = nrm
        k = ao
        c = np.ones_like(c)
    else:
        inv = 1.0 / np.maximum(c, 1e-4)
        a = alb * inv[..., None]
        n = nrm * inv[..., None]
        k = ao * inv[..., None]
    k = np.clip(k[..., 0], 0, 1)
    a = a * (0.55 + 0.45 * k[..., None])
    n = n * 2 - 1
    n /= np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-6)
    a = dilate(a, c)
    n = dilate(n, c)
    # thin leaflets keep their coverage a little better (the game alpha tests at 0.42)
    alpha = np.clip(c * 1.25, 0, 1)
    if tile:
        # the tile is (h - 2 GUT) x (w - 2 GUT); the gutter wraps round
        th, tw = h - 2 * GUT, w - 2 * GUT
        ys = (np.arange(h) - GUT) % th
        xs = (np.arange(w) - GUT) % tw
        a = a[ys][:, xs]
        n = n[ys][:, xs]
        alpha = np.ones((h, w), np.float32)
    px['alb'][y:y + h, x:x + w] = a
    px['nrm'][y:y + h, x:x + w] = n * 0.5 + 0.5
    px['alpha'][y:y + h, x:x + w] = alpha


CARD_FRAMES = {
    'frond_date': (-0.02, -0.13, 1.04, 0.26),
    'frond_date2': (-0.02, -0.13, 1.04, 0.26),
    'frond_dry': (-0.02, -0.13, 1.04, 0.26),
    'frond_coco': (-0.02, -0.1625, 1.04, 0.325),
    'acacia': (-0.25, -0.25, 0.5, 0.5),
    'acacia2': (-0.25, -0.25, 0.5, 0.5),
    'shrub': (-0.25, -0.25, 0.5, 0.5),
    'thorn': (-0.25, -0.25, 0.5, 0.5),
    'dates': (-0.125, -0.25, 0.25, 0.5),
    'coconuts': (-0.125, -0.125, 0.25, 0.25),
}


def envelope(hp, frame, bins=40):
    """Half width of a frond card's leaflets along the rachis (card units, root -> tip)."""
    V = np.array(hp.V)
    out = []
    for i in range(bins + 1):
        t = i / bins
        sel = np.abs(V[:, 0] - t) < 0.6 / bins + 0.004
        hw = float(np.abs(V[sel, 1]).max()) if sel.any() else 0.0
        out.append(hw)
    out = np.array(out)
    out = np.maximum(out, np.maximum(np.roll(out, 1), np.roll(out, -1)))
    return [round(min(frame[3] / 2, max(0.012, v + 0.007)), 4) for v in out]


def build_atlas():
    scene_setup()
    px = {'alb': np.zeros((A, A, 3), np.float32), 'nrm': np.tile(np.array([0.5, 0.5, 1.0], np.float32), (A, A, 1)), 'alpha': np.zeros((A, A), np.float32)}
    meta = {'frames': {}, 'env': {}}
    t0 = time.time()
    for name, seed in (('frond_date', 11), ('frond_date2', 12), ('frond_dry', 13), ('frond_coco', 14), ('acacia', 21), ('acacia2', 22), ('shrub', 31), ('thorn', 41), ('dates', 51), ('coconuts', 52)) + tuple((b, 60 + i) for i, b in enumerate(BARKS)):
        rng = np.random.default_rng(seed)
        if name.startswith('frond'):
            hp = frond_card(rng, name.split('_')[1].replace('date2', 'date2'))
            frame = CARD_FRAMES[name]
            meta['env'][name] = envelope(hp, frame)
        elif name in ('acacia', 'acacia2', 'shrub', 'thorn'):
            hp = spray_card(rng, name)
            frame = CARD_FRAMES[name]
        elif name == 'dates':
            hp, frame = dates_card(rng), CARD_FRAMES[name]
        elif name == 'coconuts':
            hp, frame = coconuts_card(rng), CARD_FRAMES[name]
        else:
            hp, frame = bark_card(rng, name)
        o = hp.obj('hp_' + name)
        x, y, w, h = RECTS[name]
        tile = name in BARKS
        size = (w - 2 * GUT, h - 2 * GUT) if tile else (w, h)
        ao_dist = 0.06 if tile else 0.025
        r = render([o], frame, size, ('albedo', 'mask', 'normal', 'ao'), samples=24, ao_dist=ao_dist)
        cov = r['mask'][..., 0]
        compose_card(px, (x, y, w, h), r['albedo'], r['normal'], r['ao'], cov, tile=tile)
        meta['frames'][name] = frame
        bpy.data.objects.remove(o)
        log(name, 'verts', len(hp.V), round(time.time() - t0, 1), 's')
    np.save(os.path.join(OUT, 'raw-alb.npy'), px['alb'])
    np.save(os.path.join(OUT, 'raw-nrm.npy'), px['nrm'])
    np.save(os.path.join(OUT, 'raw-alpha.npy'), px['alpha'])
    with open(os.path.join(OUT, 'cards.json'), 'w') as f:
        json.dump(meta, f)
    save_atlas(px)


def save_png(path, rgba, mode='RGBA'):
    h, w = rgba.shape[:2]
    img = bpy.data.images.new('save_tmp', w, h, alpha=True, float_buffer=False)
    img.colorspace_settings.name = 'Non-Color'
    a = np.ones((h, w, 4), np.float32)
    a[..., :rgba.shape[2]] = np.clip(rgba, 0, 1)
    img.pixels.foreach_set(a[::-1].ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


def save_atlas(px):
    alb = np.concatenate([C.lin2srgb(px['alb']), px['alpha'][..., None]], -1)
    save_png(os.path.join(OUT, 'atlas-albedo.png'), alb)
    save_png(os.path.join(OUT, 'atlas-normal.png'), px['nrm'])


def load_atlas():
    return {k: np.load(os.path.join(OUT, f'raw-{k}.npy')) for k in ('alb', 'nrm', 'alpha')}


# ================================================================== low poly

META = None


def uv_of(name, cx, cy):
    """Atlas uv (Blender, v up) of card-space point (cx, cy) of card `name`."""
    x, y, w, h = RECTS[name]
    fx, fy, fw, fh = META['frames'][name] if name in META['frames'] else IMP_FRAMES[name]
    px_x = x + (cx - fx) / fw * w
    px_y = y + (fy + fh - cy) / fh * h
    return (px_x / A, 1 - px_y / A)


def uv_bark(name, u, v):
    """Atlas uv of bark coordinates (u around 0..1, v along 0..1 of one period)."""
    x, y, w, h = RECTS[name]
    px_x = x + GUT + u * (w - 2 * GUT)
    px_y = y + h - GUT - v * (h - 2 * GUT)
    return (px_x / A, 1 - px_y / A)


class LP:
    """Low poly game mesh: per vertex position, (custom) normal, uv, wind weight, leaf amount, AO."""

    def __init__(self):
        self.P, self.N, self.UV, self.FL, self.LF, self.AO, self.F = [], [], [], [], [], [], []

    def v(self, p, n, uv, flex, leaf, ao):
        self.P.append(tuple(p))
        n = Vector(n).normalized()
        self.N.append(tuple(n))
        self.UV.append(uv)
        self.FL.append(flex)
        self.LF.append(leaf)
        self.AO.append(ao)
        return len(self.P) - 1

    def quad(self, a, b, c, d):
        """a b c d counter clockwise seen from the front."""
        self.F.append((a, b, c))
        self.F.append((a, c, d))

    def tri(self, a, b, c):
        self.F.append((a, b, c))

    def tris(self):
        return len(self.F)

    def obj(self, name):
        me = bpy.data.meshes.new(name)
        me.from_pydata(self.P, [], self.F)
        uv = me.uv_layers.new(name='UVMap')
        vi = np.empty(len(me.loops), np.int32)
        me.loops.foreach_get('vertex_index', vi)
        uvs = np.array(self.UV, np.float32)[vi]
        uv.data.foreach_set('uv', uvs.ravel())
        for nm, vals in (('_flex', self.FL), ('_leaf', self.LF), ('_ao', self.AO)):
            at = me.attributes.new(nm, 'FLOAT', 'POINT')
            at.data.foreach_set('value', np.array(vals, np.float32))
        me.polygons.foreach_set('use_smooth', [True] * len(me.polygons))
        me.normals_split_custom_set_from_vertices([tuple(n) for n in self.N])
        o = bpy.data.objects.new(name, me)
        SC.collection.objects.link(o)
        return o


def bark_tube(lp, pts, radii, name, sides, flex_of, ao_of, period):
    """Bark tube along pts (radii per point); uv bands of `period` world units along, duplicated at band ends."""
    L = [0.0]
    for i in range(1, len(pts)):
        L.append(L[-1] + (pts[i] - pts[i - 1]).length)
    # ring positions: the points plus every band boundary
    ss = sorted(set([round(x, 6) for x in L] + [k * period for k in range(1, int(L[-1] / period) + 1) if k * period < L[-1] - 1e-4]))

    def at(s):
        for i in range(1, len(L)):
            if s <= L[i] + 1e-9:
                t = (s - L[i - 1]) / max(1e-9, L[i] - L[i - 1])
                return pts[i - 1].lerp(pts[i], t), radii[i - 1] + (radii[i] - radii[i - 1]) * t, i
        return pts[-1], radii[-1], len(pts) - 1

    def ring(s, vv):
        p, r, i = at(s)
        j0, j1 = (max(0, i - 1), min(len(pts) - 1, i))
        if j0 == j1:
            j0 = j1 - 1
        _, e1, e2 = frame_of(pts[j0], pts[j1])
        out = []
        for k in range(sides + 1):
            a = k / sides * math.tau
            n = e1 * math.cos(a) + e2 * math.sin(a)
            q = p + n * r
            out.append(lp.v(q, n, uv_bark(name, k / sides, vv), flex_of(q), 0.0, ao_of(q)))
        return out

    for a, b in zip(ss[:-1], ss[1:]):
        band = math.floor(((a + b) / 2) / period)
        va = a / period - band
        vb = b / period - band
        r0 = ring(a, va)
        r1 = ring(b, vb)
        for k in range(sides):
            lp.quad(r0[k], r0[k + 1], r1[k + 1], r1[k])


def frond(lp, card, base, dirh, elev, L, droop, segs, center, flex0, fK, leaf=1.0, fold=0.35, twist=0.0, aoK=1.0):
    """A V-folded frond strip from `base`: horizontal direction dirh, elevation, length L, droop; trimmed to the
    card's leaflet envelope."""
    env = META['env'][card]
    side = Vector((-dirh.y, dirh.x, 0)).normalized()
    side = (side * math.cos(twist) + Z * math.sin(twist)).normalized()

    def P(s):
        return base + dirh * (math.cos(elev) * s * L) + Z * (math.sin(elev) * s * L - droop * s * s * L)

    def E(s):
        f = s * (len(env) - 1)
        i = min(len(env) - 2, int(f))
        return env[i] + (env[i + 1] - env[i]) * (f - i)

    rows = []
    for i in range(segs + 1):
        s = i / segs
        s = s ** 0.85
        p = P(s)
        tg = (P(min(1, s + 0.02)) - P(max(0, s - 0.02))).normalized()
        up = side.cross(tg).normalized()
        if up.z < 0 and fold > 0:
            up = -up
        hw = E(s) * L
        f = fold
        left = p + side * (hw * math.cos(f)) + up * (hw * math.sin(f))
        right = p - side * (hw * math.cos(f)) + up * (hw * math.sin(f))
        cn = (p - center).normalized() * 0.55 + up * 0.45 + Z * 0.35
        ao = (0.62 + 0.38 * sst(0.0, 0.55, s)) * aoK
        fl = flex0 + fK * s ** 1.5 * L
        lf = leaf * (0.7 + 0.3 * s)
        ids = [lp.v(left, cn + side * 0.15, uv_of(card, s, E(s)), fl, lf, ao),
               lp.v(p, cn, uv_of(card, s, 0.0), fl, lf, ao),
               lp.v(right, cn - side * 0.15, uv_of(card, s, -E(s)), fl, lf, ao)]
        rows.append(ids)
    for i in range(segs):
        a, b = rows[i], rows[i + 1]
        lp.quad(a[1], b[1], b[0], a[0])
        lp.quad(a[2], b[2], b[1], a[1])


def card_quad(lp, card, c, right, up, w, h, normal_of, flex, leaf, ao, frame=None):
    """A flat card centred at c spanning `right` (w) x `up` (h), the whole card frame mapped."""
    fx, fy, fw, fh = META['frames'][card] if frame is None else frame
    # the round sprays (acacia, shrub, thorn) are octagons: their corners hold no leaves (18% less overdraw)
    k = 0.6
    corners = ((-1, -1 + k), (-1 + k, -1), (1 - k, -1), (1, -1 + k), (1, 1 - k), (1 - k, 1), (-1 + k, 1), (-1, 1 - k)) if card in OCT else ((-1, -1), (1, -1), (1, 1), (-1, 1))
    ids = []
    for sx, sy in corners:
        p = c + right * (sx * w / 2) + up * (sy * h / 2)
        u, v = uv_of(card, fx + fw * (sx + 1) / 2, fy + fh * (sy + 1) / 2)
        ids.append(lp.v(p, normal_of(p), (u, v), flex(p) if callable(flex) else flex, leaf, ao(p) if callable(ao) else ao))
    for i in range(1, len(ids) - 1):
        lp.tri(ids[0], ids[i], ids[i + 1])


OCT = ('acacia', 'acacia2', 'shrub', 'thorn')


GOLD = math.radians(137.5)


def date_palm(lp, rng, base, H, lean, crown, nF, nDry, nDates, lod, r0=0.055):
    """A date palm: diamond-patterned trunk, crown base, nF green fronds in a spiral, dry fronds hanging, dates."""
    sides = 8 if lod == 0 else 5
    nseg = max(4, int(H / (0.11 if lod == 0 else 0.3)))
    wob = (rng.random() - 0.5) * 0.04
    pts = [base + Vector((lean[0] * t ** 1.6 + wob * math.sin(t * 5), lean[1] * t ** 1.6, H * t)) for t in (i / nseg for i in range(nseg + 1))]
    radii = [r0 * (1.28 - 0.28 * sst(0, 0.1, t)) * (1 - 0.1 * t) + 0.012 * sst(0.85, 1, t) for t in (i / nseg for i in range(nseg + 1))]
    top = pts[-1]
    Ht = top.z + 0.001
    fK0 = 0.05 * (Ht / 1.3)

    def tflex(q):
        return fK0 * max(0.0, (q.z - base.z) / max(0.3, Ht - base.z)) ** 2

    circ = math.tau * r0
    period = circ * (RECTS['bark_date'][3] - 2 * GUT) / (RECTS['bark_date'][2] - 2 * GUT)
    if H > 0.05:
        bark_tube(lp, pts, radii, 'bark_date', sides, tflex, lambda q: 0.7 + 0.3 * min(1, (q.z - base.z) / 0.3) - 0.25 * sst(Ht - 0.25, Ht, q.z), period)
    # the crown base: a fibrous knob of leaf bases
    knob = [top - Vector((0, 0, 0.03)), top + Vector((0, 0, 0.05)), top + Vector((0, 0, 0.11))]
    bark_tube(lp, knob, [r0 * 1.45, r0 * 1.2, 0.012], 'bark_date', 6 if lod == 0 else 4, tflex, lambda q: 0.55, period)
    center = top + Vector((0, 0, 0.05))
    a0 = rng.random() * math.tau
    tf = fK0 + 0.004
    for i in range(nF):
        k = i / max(1, nF - 1)
        a = a0 + i * GOLD + (rng.random() - 0.5) * 0.2
        dirh = Vector((math.cos(a), math.sin(a), 0))
        elev = math.radians(74 - 100 * k ** 0.75 + (rng.random() - 0.5) * 12)
        L = crown * (0.6 + 0.22 * math.sin(math.pi * min(1, 0.25 + k * 0.8))) * (0.9 + rng.random() * 0.2)
        droop = 0.1 + 0.5 * k
        b = top + dirh * (0.02 + 0.02 * k) + Vector((0, 0, 0.09 - 0.08 * k))
        card = 'frond_date' if (k < 0.55 or rng.random() < 0.3) else 'frond_date2'
        frond(lp, card, b, dirh, elev, L, droop, 5 if lod == 0 else 3, center, tf, 0.075, fold=0.42, twist=(rng.random() - 0.5) * 0.3)
    for i in range(nDry):
        a = a0 + 0.4 + i * (math.tau / max(1, nDry)) + (rng.random() - 0.5) * 0.5
        dirh = Vector((math.cos(a), math.sin(a), 0))
        elev = math.radians(-62 - rng.random() * 20)
        b = top + dirh * 0.035 + Vector((0, 0, -0.01))
        frond(lp, 'frond_dry', b, dirh, elev, crown * (0.4 + rng.random() * 0.1), 0.05, 3 if lod == 0 else 2, center, tf * 0.8, 0.02, leaf=0.22, fold=0.25, aoK=0.85)
    for i in range(nDates):
        a = a0 + 1.1 + i * (math.tau / max(1, nDates)) + (rng.random() - 0.5) * 0.4
        d = Vector((math.cos(a), math.sin(a), 0))
        s = crown * (0.85 + rng.random() * 0.3)
        c = top + d * (0.07 * s) + Vector((0, 0, -0.1 * s))
        down = (Vector((0, 0, 1)) + d * 0.35).normalized()
        for rr in (0.0, math.pi / 2):
            right = Vector((math.cos(a + rr + 0.6), math.sin(a + rr + 0.6), 0))
            card_quad(lp, 'dates', c, right, down, 0.11 * s, 0.22 * s, lambda p: (p - center).normalized() + Z * 0.2, tf, 0.12, 0.8)
    return top


def coconut_palm(lp, rng, base, H, lean, crown, nF, lod, r0=0.042):
    sides = 7 if lod == 0 else 5
    nseg = max(4, int(H / (0.1 if lod == 0 else 0.28)))
    pts = [base + Vector((0.02 * math.sin(t * 4), lean * H * (0.95 * t - 0.4 * t * t), H * t)) for t in (i / nseg for i in range(nseg + 1))]
    radii = [r0 * (1.5 - 0.5 * sst(0, 0.12, t)) * (1 - 0.18 * t) for t in (i / nseg for i in range(nseg + 1))]
    top = pts[-1]
    fK0 = 0.06 * (H / 1.3)

    def tflex(q):
        return fK0 * max(0.0, (q.z - base.z) / H) ** 2

    period = math.tau * r0 * (RECTS['bark_coco'][3] - 2 * GUT) / (RECTS['bark_coco'][2] - 2 * GUT)
    bark_tube(lp, pts, radii, 'bark_coco', sides, tflex, lambda q: 0.78 + 0.22 * min(1, (q.z - base.z) / 0.3) - 0.3 * sst(top.z - 0.2, top.z, q.z), period)
    knob = [top - Vector((0, 0, 0.02)), top + Vector((0, 0, 0.04)), top + Vector((0, 0, 0.08))]
    bark_tube(lp, knob, [r0 * 1.15, r0 * 1.05, 0.01], 'bark_coco', 5, tflex, lambda q: 0.5, period)
    center = top + Vector((0, 0, 0.03))
    a0 = rng.random() * math.tau
    tf = fK0 + 0.004
    for i in range(nF):
        k = i / max(1, nF - 1)
        a = a0 + i * GOLD + (rng.random() - 0.5) * 0.25
        dirh = Vector((math.cos(a), math.sin(a), 0))
        elev = math.radians(62 - 85 * k ** 0.8 + (rng.random() - 0.5) * 12)
        L = crown * (0.68 + 0.14 * math.sin(math.pi * k)) * (0.9 + rng.random() * 0.2)
        droop = 0.35 + 0.5 * k
        b = top + dirh * 0.02 + Vector((0, 0, 0.06 - 0.06 * k))
        frond(lp, 'frond_coco', b, dirh, elev, L, droop, 6 if lod == 0 else 3, center, tf, 0.1, fold=-0.3, twist=(rng.random() - 0.5) * 0.25)
    for i in range(2 if lod == 0 else 1):
        a = a0 + 2.0 + i * 2.6
        dirh = Vector((math.cos(a), math.sin(a), 0))
        frond(lp, 'frond_dry', top + dirh * 0.03, dirh, math.radians(-70), crown * 0.42, 0.05, 2, center, tf * 0.8, 0.02, leaf=0.22, fold=0.2, aoK=0.85)
    c = top + Vector((0.02, 0.02, -0.06))
    for rr in (0.0, math.pi / 2):
        right = Vector((math.cos(rr + 0.3), math.sin(rr + 0.3), 0))
        card_quad(lp, 'coconuts', c, right, Z, 0.15 * crown, 0.15 * crown, lambda p: (p - center).normalized() + Z * 0.3, tf, 0.1, 0.75)
    return top


def branch_path(p0, p1, bend, n):
    return [p0.lerp(p1, t) + Z * (bend * math.sin(math.pi * t)) for t in (i / n for i in range(n + 1))]


def acacia(lp, rng, H, R, lod, young=False):
    """Umbrella thorn: a short trunk forking into stems and branches that spread to a flat-topped crown of sprays."""
    period = math.tau * 0.03 * (RECTS['bark_acacia'][3] - 2 * GUT) / (RECTS['bark_acacia'][2] - 2 * GUT)
    ztop = H
    fK = 0.03 * H / 0.8

    def flex(q):
        return fK * max(0.0, q.z / H) ** 2

    def ao(q):
        return 0.55 + 0.4 * min(1.0, q.z / H)

    nS = 2 if young else 3
    fork = Vector(((rng.random() - 0.5) * 0.04, (rng.random() - 0.5) * 0.04, H * (0.2 if not young else 0.28)))
    bark_tube(lp, branch_path(Vector((0, 0, -0.02)), fork, 0.0, 2), [0.04 if not young else 0.028, 0.034 if not young else 0.024, 0.03 if not young else 0.02], 'bark_acacia', 6 if lod == 0 else 4, flex, ao, period)
    tips = []
    a0 = rng.random() * math.tau
    for s in range(nS):
        a = a0 + s / nS * math.tau + (rng.random() - 0.5) * 0.6
        d = Vector((math.cos(a), math.sin(a), 0))
        mid = fork + d * (R * (0.3 + rng.random() * 0.15)) + Z * (H * 0.3)
        bark_tube(lp, branch_path(fork, mid, 0.03, 2 if lod else 3), [0.026 if not young else 0.018, 0.021, 0.017 if not young else 0.012, 0.015][:(3 if lod else 4)], 'bark_acacia', 5 if lod == 0 else 4, flex, ao, period)
        nb = 3 if not young else 2
        for b in range(nb):
            ab = a + (b - (nb - 1) / 2) * (0.9 if not young else 1.1) + (rng.random() - 0.5) * 0.3
            db = Vector((math.cos(ab), math.sin(ab), 0))
            tip = mid + db * (R * (0.45 + rng.random() * 0.25)) + Z * (ztop - 0.08 - mid.z + (rng.random() - 0.5) * 0.04)
            tip.z = ztop - 0.07 - rng.random() * 0.03
            if lod == 0 or b == 0:
                bark_tube(lp, branch_path(mid, tip, 0.02, 2), [0.013 if not young else 0.01, 0.009, 0.006], 'bark_acacia', 4 if lod == 0 else 3, flex, ao, period)
            tips.append(tip)
    center = Vector((0, 0, ztop - R * 1.2))

    def nrm(p):
        return (p - center).normalized() + Z * 0.6

    # flat crown: clumps of horizontal sprays at the branch tips, a ring of tilted sprays round the rim, a few under
    per = 3 if lod == 0 else 1
    for tp in tips:
        for k in range(per):
            ang = rng.random() * math.tau
            c = tp + Vector((math.cos(ang), math.sin(ang), 0)) * (0.05 + rng.random() * 0.08) + Z * (0.045 + rng.random() * 0.02)
            sz = R * (0.62 + rng.random() * 0.22) * (1.15 if lod else 1.0)
            rr = rng.random() * math.tau
            right = Vector((math.cos(rr), math.sin(rr), (rng.random() - 0.5) * 0.15)).normalized()
            up = Z.cross(right).normalized()
            card_quad(lp, 'acacia' if (k + int(rng.random() * 2)) % 2 == 0 else 'acacia2', c, right, up, sz, sz, nrm, flex(c) + 0.012, 1.0, 1.0 if k else 0.92)
    nrim = (12 if not young else 8) if lod == 0 else 6
    for i in range(nrim):
        a = i / nrim * math.tau + rng.random() * 0.3
        d = Vector((math.cos(a), math.sin(a), 0))
        c = d * (R * (0.85 + rng.random() * 0.15)) + Z * (ztop - 0.02 + (rng.random() - 0.5) * 0.04)
        side = Vector((-d.y, d.x, 0))
        up = (d * math.cos(0.38) + Z * math.sin(0.38)).normalized()
        sz = R * 0.48
        card_quad(lp, 'acacia2', c, side, up, sz, sz * 0.8, nrm, flex(c) + 0.015, 1.0, 0.9)
    if lod == 0:
        for i in range(5 if not young else 3):
            a = rng.random() * math.tau
            c = Vector((math.cos(a), math.sin(a), 0)) * (R * rng.random() * 0.6) + Z * (ztop - 0.07)
            rr = rng.random() * math.tau
            right = Vector((math.cos(rr), math.sin(rr), 0))
            card_quad(lp, 'acacia', c, right, Z.cross(right), R * 0.7, R * 0.7, nrm, flex(c) + 0.01, 1.0, 0.6)


def bush(lp, rng, card, R, Hb, lod):
    """A shrub / thorn bush: crossed and tilted foliage cards round a dome."""
    center = Vector((0, 0, -Hb * 0.4))

    def nrm(p):
        return (p - center).normalized() + Z * 0.3

    n = 7 if lod == 0 else 4
    a0 = rng.random() * math.tau
    for i in range(n):
        a = a0 + i / n * math.pi + (rng.random() - 0.5) * 0.3
        right = Vector((math.cos(a), math.sin(a), 0))
        out = Z.cross(right)
        tilt = (0.25 + rng.random() * 0.5) * (1 if i % 2 else -1)
        up = (Z * math.cos(tilt) + out * math.sin(tilt)).normalized()
        c = Vector(((rng.random() - 0.5) * R * 0.3, (rng.random() - 0.5) * R * 0.3, Hb * 0.48))
        card_quad(lp, card, c, right, up, R * (1.7 + rng.random() * 0.3), Hb * 1.15, nrm, lambda p: 0.02 * max(0, p.z / Hb) ** 2, 1.0, lambda p: 0.55 + 0.45 * min(1, p.z / Hb))
    for i in range(3 if lod == 0 else 1):
        rr = rng.random() * math.tau
        right = Vector((math.cos(rr), math.sin(rr), 0))
        c = Vector(((rng.random() - 0.5) * R * 0.4, (rng.random() - 0.5) * R * 0.4, Hb * (0.75 + 0.15 * i)))
        card_quad(lp, card, c, right, Z.cross(right), R * (1.6 - i * 0.25), R * (1.6 - i * 0.25), nrm, 0.02, 1.0, 1.0)


# ------------------------------------------------------------------ impostors

IMP_FRAMES = {}
IMP_OF = {'date_tall': ('imp_date', 'imp_date_top'), 'coco': ('imp_coco', 'imp_coco_top'), 'acacia': ('imp_acacia', 'imp_acacia_top')}


def bbox(o):
    P = np.array([v.co[:] for v in o.data.vertices])
    return P.min(0), P.max(0)


def imp_frames(o, side, topn):
    lo, hi = bbox(o)
    _, _, w, h = RECTS[side]
    R = float(max(abs(lo[0]), abs(hi[0]), abs(lo[1]), abs(hi[1]))) * 1.03
    fh = max(float(hi[2]) * 1.03 + 0.01, 2 * R * h / w)
    fw = fh * w / h
    IMP_FRAMES[side] = (-fw / 2, -0.01, fw, fh)
    IMP_FRAMES[topn] = (-R, -R, 2 * R, 2 * R)
    return R


def render_impostors(px, objs):
    atlas = bpy.data.images.new('atlas_tex', A, A, alpha=True, float_buffer=True)
    atlas.colorspace_settings.name = 'Non-Color'
    rgba = np.concatenate([px['alb'], px['alpha'][..., None]], -1)
    atlas.pixels.foreach_set(rgba[::-1].ravel())
    atlas.alpha_mode = 'STRAIGHT'
    for model, (side, topn) in IMP_OF.items():
        o = objs[model]
        for p in objs.values():
            p.hide_render = p is not o
        imp_frames(o, side, topn)
        for name, view in ((side, 'side'), (topn, 'top')):
            x, y, w, h = RECTS[name]
            r = render([o], IMP_FRAMES[name], (w, h), ('albedo', 'mask'), samples=16, view=view, atlas=atlas)
            cov = r['mask'][..., 0]
            alb = r['albedo'] / np.maximum(cov, 1e-4)[..., None]
            # normals: a gentle bump from the albedo's luminance (the vertex normals give the volume)
            lum = C.blur((alb @ np.array([0.3, 0.6, 0.1])) * (cov > 0.5), 1)
            gx = np.roll(lum, -1, 1) - np.roll(lum, 1, 1)
            gy = np.roll(lum, 1, 0) - np.roll(lum, -1, 0)
            n = np.stack([-gx * 2.5, -gy * 2.5, np.ones_like(lum)], -1)
            n /= np.linalg.norm(n, axis=-1, keepdims=True)
            alb = dilate(alb, cov)
            n = dilate(n, cov)
            px['alb'][y:y + h, x:x + w] = alb
            px['nrm'][y:y + h, x:x + w] = n * 0.5 + 0.5
            px['alpha'][y:y + h, x:x + w] = np.clip(cov * 1.1, 0, 1)
        log('impostor', model, IMP_FRAMES[side])
    for p in objs.values():
        p.hide_render = False


def far_cross(lp, side, topn, base, top_z, lean=(0.0, 0.0), crown_r=None, crown_z=None, leafy_top=1.0):
    """Impostor: two crossed vertical cards (side sprite) and a horizontal crown card (top sprite)."""
    fx, fy, fw, fh = IMP_FRAMES[side]
    k = top_z / (fy + fh)
    w, h = fw * k, fh * k
    for a in (0.0, math.pi / 2):
        right = Vector((math.cos(a), math.sin(a), 0))
        ids = []
        for sx, sy in ((-1, 0), (1, 0), (1, 1), (-1, 1)):
            p = base + right * (sx * w / 2) + Vector((lean[0] * sy, lean[1] * sy, fy * k + sy * h))
            u, v = uv_of(side, fx + fw * (sx + 1) / 2, fy + fh * sy)
            n = right * sx * 0.5 + Z * 0.7 + Vector((-right.y, right.x, 0)) * 0.3
            ids.append(lp.v(p, n, (u, v), 0.02 * sy * top_z, leafy_top * sy, 0.75 + 0.25 * sy))
        lp.quad(*ids)
        # and its back (the cards face either way: same verts, the material is double sided)
    tx, ty, tw, th = IMP_FRAMES[topn]
    R = tw / 2 * k if crown_r is None else crown_r
    cz = crown_z if crown_z is not None else top_z * 0.86
    c = base + Vector((lean[0], lean[1], cz - base.z))
    ids = []
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        p = c + Vector((sx * R, sy * R, 0))
        u, v = uv_of(topn, tx + tw * (sx + 1) / 2, ty + th * (sy + 1) / 2)
        ids.append(lp.v(p, Vector((sx * 0.35, sy * 0.35, 1)), (u, v), 0.02 * top_z, leafy_top, 1.0))
    lp.quad(*ids)


# ------------------------------------------------------------------ models

def date_variant(name, lod):
    """(trunk list) per variant: each trunk (base xy, H, lean xy, crown, fronds, dry, dates)."""
    rng = np.random.default_rng({'date_tall': 101, 'date_short': 102, 'date_lean': 103, 'date_clump': 104}[name])
    lp = LP()
    q = 1.0 if lod == 0 else 0.55
    if name == 'date_tall':
        trunks = [((0, 0), 1.42, (0.05, 0.02), 1.0, 30, 7, 4)]
    elif name == 'date_short':
        trunks = [((0, 0), 0.5, (0.02, 0.0), 0.92, 28, 5, 3)]
    elif name == 'date_lean':
        trunks = [((0, 0), 1.12, (0.34, 0.08), 0.95, 28, 6, 3)]
    else:
        trunks = [((0.0, 0.0), 1.05, (0.1, 0.04), 0.9, 22, 5, 3), ((-0.17, 0.12), 0.72, (-0.22, 0.1), 0.82, 18, 4, 2), ((0.12, -0.16), 0.38, (0.12, -0.18), 0.75, 16, 3, 1),
                  ((-0.08, -0.12), 0.0, (0, 0), 0.5, 10, 0, 0)]
    tops = []
    for (bx, by), H, lean, crown, nF, nD, nDt in trunks:
        top = date_palm(lp, rng, Vector((bx, by, -0.02)), max(0.06, H), lean, crown, max(5, int(nF * q)), max(0 if nD == 0 else 1, int(nD * q)), nDt if lod == 0 else min(nDt, 2), lod, r0=0.055 if H > 0.3 else 0.045)
        tops.append(((bx, by), top, H, crown))
    return lp, tops


def build_models():
    global META
    with open(os.path.join(OUT, 'cards.json')) as f:
        META = json.load(f)
    scene_setup()
    models = {}
    info = {}
    for name in ('date_tall', 'date_short', 'date_lean', 'date_clump'):
        for lod in (0, 1):
            lp, tops = date_variant(name, lod)
            models[name + ('' if lod == 0 else '_l1')] = lp
            info[name] = tops
    for lod in (0, 1):
        rng = np.random.default_rng(201)
        lp = LP()
        coconut_palm(lp, rng, Vector((0, 0, -0.02)), 1.28, 0.38, 1.0, 22 if lod == 0 else 12, lod)
        models['coco' + ('' if lod == 0 else '_l1')] = lp
        for young in (False, True):
            rng = np.random.default_rng(301 + young)
            lp = LP()
            acacia(lp, rng, 0.52 if young else 0.78, 0.36 if young else 0.62, lod, young)
            models[('acacia_b' if young else 'acacia') + ('' if lod == 0 else '_l1')] = lp
        rng = np.random.default_rng(401)
        lp = LP()
        bush(lp, rng, 'shrub', 0.22, 0.2, lod)
        models['shrub' + ('' if lod == 0 else '_l1')] = lp
        rng = np.random.default_rng(402)
        lp = LP()
        bush(lp, rng, 'thorn', 0.25, 0.18, lod)
        models['thorn' + ('' if lod == 0 else '_l1')] = lp
    objs = {n: lp.obj(n) for n, lp in models.items()}
    # impostors: render the LOD0 date palm, coconut and acacia into the atlas, then build the far meshes
    px = load_atlas()
    imp_objs = {k: objs[k] for k in IMP_OF}
    for n, o in objs.items():
        if n not in imp_objs:
            o.hide_render = True
    render_impostors(px, imp_objs)
    for o in objs.values():
        o.hide_render = False
    save_atlas(px)
    far = {}
    R0 = IMP_FRAMES['imp_date_top'][2] / 2
    for name in ('date_tall', 'date_short', 'date_lean', 'date_clump'):
        lp = LP()
        for (bx, by), top, H, crown in info[name]:
            far_cross(lp, 'imp_date', 'imp_date_top', Vector((bx, by, -0.02)), top.z + 0.45 * crown, lean=(top.x - bx, top.y - by), crown_r=R0 * crown, crown_z=top.z + 0.08)
        far[name + '_far'] = lp
    hz = float(bbox(objs['coco'])[1][2])
    lp = LP()
    far_cross(lp, 'imp_coco', 'imp_coco_top', Vector((0, 0, -0.02)), hz, crown_z=hz * 0.82)
    far['coco_far'] = lp
    Ra = IMP_FRAMES['imp_acacia_top'][2] / 2
    for nm, k in (('acacia', 1.0), ('acacia_b', 0.36 / 0.62)):
        hz = float(bbox(objs[nm])[1][2])
        lp = LP()
        far_cross(lp, 'imp_acacia', 'imp_acacia_top', Vector((0, 0, -0.02)), hz, crown_r=Ra * k, crown_z=hz * 0.93)
        far[nm + '_far'] = lp
    for n, lp in far.items():
        objs[n] = lp.obj(n)
        models[n] = lp
    export(objs, models)


def export(objs, models):
    sel = list(objs.values())
    for o in sel:
        o.data.materials.clear()
    C.select(sel)
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'desert-veg-raw.glb'), export_format='GLB', use_selection=True, export_materials='NONE', export_vertex_color='NONE', export_normals=True,
                              export_texcoords=True, export_attributes=True, export_apply=True, export_yup=True)
    man = {'atlas': A, 'meshes': {}}
    for n, o in objs.items():
        lo, hi = bbox(o)
        man['meshes'][n] = {'tris': models[n].tris(), 'h': round(float(hi[2]), 3), 'r': round(float(max(-lo[0], hi[0], -lo[1], hi[1])), 3)}
    with open(os.path.join(OUT, 'desert-veg.json'), 'w') as f:
        json.dump(man, f, indent=1, sort_keys=True)
    log('meshes', {n: m['tris'] for n, m in man['meshes'].items()})


# ------------------------------------------------------------------ preview

def preview():
    """A lit contact sheet of the LOD0 (top row), LOD1 and far models: Cycles, the game's camera angle."""
    global META
    with open(os.path.join(OUT, 'cards.json')) as f:
        META = json.load(f)
    sc = C.reset(threads=3)
    objs = C.import_glb(os.path.join(OUT, 'desert-veg-raw.glb'))
    for o in objs:
        if o.type == 'MESH':
            for at in list(o.data.attributes):
                if at.name.lower() == '_ao' and at.name != '_ao':
                    at.name = '_ao'
    alb = bpy.data.images.load(os.path.join(OUT, 'atlas-albedo.png'))
    alb.colorspace_settings.name = 'sRGB'
    alb.alpha_mode = 'STRAIGHT'
    nrm = bpy.data.images.load(os.path.join(OUT, 'atlas-normal.png'))
    nrm.colorspace_settings.name = 'Non-Color'
    m = bpy.data.materials.new('veg')
    m.use_nodes = True
    nt = m.node_tree
    bs = nt.nodes['Principled BSDF']
    tx = nt.nodes.new('ShaderNodeTexImage')
    tx.image = alb
    tn = nt.nodes.new('ShaderNodeTexImage')
    tn.image = nrm
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
    nm.inputs['Strength'].default_value = 0.8
    nt.links.new(nm.outputs[0], bs.inputs['Normal'])
    ao = nt.nodes.new('ShaderNodeAttribute')
    ao.attribute_name = '_ao'
    mul = nt.nodes.new('ShaderNodeMix')
    mul.data_type = 'RGBA'
    mul.blend_type = 'MULTIPLY'
    mul.inputs['Factor'].default_value = 1.0
    nt.links.new(tx.outputs['Color'], mul.inputs[6])
    nt.links.new(ao.outputs['Fac'], mul.inputs[7])
    nt.links.new(mul.outputs[2], bs.inputs['Base Color'])
    gt = nt.nodes.new('ShaderNodeMath')
    gt.operation = 'GREATER_THAN'
    gt.inputs[1].default_value = 0.42
    nt.links.new(tx.outputs['Alpha'], gt.inputs[0])
    nt.links.new(gt.outputs[0], bs.inputs['Alpha'])
    bs.inputs['Roughness'].default_value = 0.8
    order = ['date_tall', 'date_short', 'date_lean', 'date_clump', 'coco', 'acacia', 'acacia_b', 'shrub', 'thorn']
    byname = {o.name: o for o in objs}
    for o in objs:
        o.hide_render = True
    for i, n in enumerate(order):
        for j, sfx in enumerate(('', '_l1', '_far')):
            o = byname.get(n + sfx)
            if o is None:
                continue
            o.hide_render = False
            o.data.materials.clear()
            o.data.materials.append(m)
            o.location = (i * 1.5, -j * 2.4, 0)
    sc.cycles.transparent_max_bounces = 48
    el = math.radians(48)
    cx, cy = 6.0, -2.4
    d = 30
    C.studio((cx, cy - d * math.cos(el), d * math.sin(el)), (cx, cy, 0.5), lens=50, sun=(math.radians(50), 0, math.radians(-35)), size=(1600, 900), samples=32,
             path=os.path.join(OUT, 'preview.png'), ortho=15.5)


if __name__ == '__main__':
    t0 = time.time()
    if STAGE in ('atlas', 'all'):
        build_atlas()
    if STAGE in ('models', 'all'):
        build_models()
    if STAGE in ('preview', 'all'):
        preview()
    log('done', STAGE, round(time.time() - t0, 1), 's')
