# Blender 5.2.2 — rock surface materials for the relief cliffs (src/render/relief.ts).
#
#   /opt/blender/blender -b --factory-startup -P web/tools/blender/rock_surfaces.py -- <out_dir> [size] [swatch.png]
#     out_dir   where the WebPs go (web/public/tex/rock)
#     size      texture size (default 512)
#     swatch    optional path of a Cycles render of the material swatches
#
# Two tileable materials, authored as height + albedo fields (numpy, periodic noise, so they
# wrap by construction), modelled as a displaced high-poly sheet in Blender and baked
# high-to-low with Cycles onto a flat plane:
#   - sandstone (desert mesas): layered strata in cream, buff, ochre and rust; hard beds
#     stand out as ledges, soft beds weather back into recessed notches; cross-bedded
#     laminae inside the thick beds, vertical joints, desert-varnish streaks running down
#     from the ledges. The texture's V axis is world height (the shader maps v = y), one
#     repeat = 2.5 world units, about the full mesa wall, so the bands sit at the same
#     height everywhere.
#   - granite (temperate crags): grey granite blocks split by joints, rounded block edges,
#     feldspar / biotite speckle and crustose lichen rosettes. Moss is not baked: the
#     shader grows it by slope, shade side and crevice (the AO channel). Repeat = 2 units.
# Bakes: tangent-space normal (selected-to-active from the displaced sheet) and ambient
# occlusion (the sheet surrounded by its 8 wrapped neighbours, so the AO tiles too).
# Packed like the ground photoscans (no WebP alpha):
#   <key>_a.webp  albedo (sRGB), a little of the AO folded in
#   <key>_n.webp  R/G normal X/Y (OpenGL, +G = up the image = up the wall), B = AO
import bpy
import math
import os
import subprocess
import sys

import numpy as np

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else 'public/tex/rock')
N = int(argv[1]) if len(argv) > 1 else 512
SWATCH = argv[2] if len(argv) > 2 else ''
TMP = os.path.join(OUT, '_tmp')
os.makedirs(TMP, exist_ok=True)

# ------------------------------------------------------------------ periodic noise


def vnoise(rng, gx, gy=None):
    """Tileable value noise on an N x N grid (row = v from the bottom, col = u), gx x gy lattice cells."""
    gy = gy or gx
    L = rng.random((gy, gx))
    def axis(g):
        t = np.arange(N) * g / N
        i0 = np.floor(t).astype(int)
        f = t - i0
        return i0 % g, (i0 + 1) % g, f * f * (3 - 2 * f)
    x0, x1, sx = axis(gx)
    y0, y1, sy = axis(gy)
    a = L[np.ix_(y0, x0)]
    b = L[np.ix_(y0, x1)]
    c = L[np.ix_(y1, x0)]
    d = L[np.ix_(y1, x1)]
    sx = sx[None, :]
    sy = sy[:, None]
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy


def fbm(rng, gx, octaves, gy=None):
    gy = gy or gx
    s = np.zeros((N, N))
    w = 0.0
    a = 1.0
    for k in range(octaves):
        s += vnoise(rng, gx << k, gy << k) * a
        w += a
        a *= 0.5
    return s / w


def noise1(rng, g):
    """Tileable 1D value noise over N samples (g cells)."""
    L = rng.random(g)
    t = np.arange(N) * g / N
    i0 = np.floor(t).astype(int)
    f = t - i0
    f = f * f * (3 - 2 * f)
    return L[i0 % g] * (1 - f) + L[(i0 + 1) % g] * f


def sstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def roll_sample(a, du, dv):
    """a shifted by fractional (du, dv) pixels with wrap (bilinear)."""
    iu = int(np.floor(du))
    iv = int(np.floor(dv))
    fu = du - iu
    fv = dv - iv
    r = lambda x, y: np.roll(np.roll(a, y, axis=0), x, axis=1)
    return (r(iu, iv) * (1 - fu) + r(iu + 1, iv) * fu) * (1 - fv) + (r(iu, iv + 1) * (1 - fu) + r(iu + 1, iv + 1) * fu) * fv


U = (np.arange(N) + 0.5) / N
UU, VV = np.meshgrid(U, U)  # VV: rows (v, from the bottom), UU: cols

# ------------------------------------------------------------------ sandstone


def sandstone():
    rng = np.random.default_rng(1971)
    # beds bottom to top: thickness (fraction of the 2.5 unit repeat), hard (cemented sandstone) or soft (silt / mudstone)
    th = []
    hard = []
    while sum(th) < 1:
        h = rng.random() < (0.55 if not hard or not hard[-1] else 0.35)
        th.append(rng.uniform(0.045, 0.12) if h else rng.uniform(0.02, 0.07))
        hard.append(h)
    th = np.array(th) / sum(th)
    edges = np.concatenate([[0], np.cumsum(th)])
    nb = len(th)
    # colours (sRGB): hard beds cream / buff / yellow ochre, soft beds rust / red-brown / pink
    HARD = [(0.84, 0.72, 0.55), (0.84, 0.68, 0.48), (0.84, 0.62, 0.38), (0.78, 0.58, 0.38), (0.86, 0.75, 0.58)]
    SOFT = [(0.68, 0.38, 0.22), (0.60, 0.33, 0.20), (0.74, 0.48, 0.32), (0.66, 0.42, 0.26), (0.72, 0.46, 0.28)]
    cols = np.array([np.array((HARD if hard[i] else SOFT)[rng.integers(5)]) * rng.uniform(0.93, 1.05) for i in range(nb)])
    # bed boundaries wander a little along the wall (periodic in u)
    wob = (noise1(rng, 4) - 0.5) * 0.02 + (noise1(rng, 11) - 0.5) * 0.008 + (noise1(rng, 37) - 0.5) * 0.003
    # beds thicken and pinch out along the wall: the wobble grows with height inside each repeat
    pinch = (fbm(rng, 5, 2, 3) - 0.5) * 0.03
    vb = VV + wob[None, :] + pinch + (fbm(rng, 16, 3) - 0.5) * 0.006
    vb = vb % 1.0
    bi = np.clip(np.searchsorted(edges, vb, side='right') - 1, 0, nb - 1)
    t = (vb - edges[bi]) / th[bi]  # 0 at the bed's base, 1 at its top
    isH = np.array(hard)[bi]
    # ledges: a hard bed stands proud with a rounded, chipped lip; soft beds weather back into a notch
    chip = fbm(rng, 24, 3, 6)
    lipT = 0.08 + chip * 0.18
    lipB = 0.06 + fbm(rng, 30, 3, 8) * 0.14
    hH = 0.62 + 0.38 * sstep(0, 1, np.minimum(t / lipB, 1)) * sstep(0, 1, np.minimum((1 - t) / lipT, 1))
    hS = 0.28 - 0.2 * np.sin(np.pi * t) ** 0.7
    h = np.where(isH, hH, hS)
    # cross-bedding: inclined laminae in the thick hard beds, sets alternating direction
    lam = np.zeros((N, N))
    setv = vnoise(rng, 5, 1)
    for i in range(nb):
        if not hard[i] or th[i] < 0.06:
            continue
        m = int(rng.integers(18, 34)) * (1 if rng.random() < 0.5 else -1)
        n = int(rng.integers(45, 60))
        sel = bi == i
        dirn = np.where(setv > 0.5, 1, -1)
        ph = 2 * np.pi * (n * vb - m * dirn * UU)
        lam[sel] = np.sin(ph[sel]) * (0.6 + 0.4 * np.sin(ph[sel] * 0.5) ** 2)
    # fine horizontal laminations in the soft beds
    lamS = np.sin(2 * np.pi * 140 * vb + fbm(rng, 12, 2) * 3) * (~isH)
    h += lam * 0.05 + lamS * 0.02
    # vertical joints: a few meandering cracks through several beds, a weathered seam round each
    joint = np.zeros((N, N))
    for k in range(6):
        u0 = rng.random()
        mean = (noise1(rng, 8) - 0.5) * 0.02 + (noise1(rng, 40) - 0.5) * 0.004
        v0 = rng.random()
        ln = rng.uniform(0.3, 1.0)
        du = (UU - u0 - mean[:, None] + 0.5) % 1.0 - 0.5
        dv = (VV - v0) % 1.0
        span = sstep(0, 0.04, dv) * sstep(0, 0.06, ln - dv) if ln < 1 else 1.0
        w = rng.uniform(1.0, 1.8) / 512
        joint = np.maximum(joint, np.exp(-(du / w) ** 2) * span * np.where(isH, 1.0, 0.7))
        joint = np.maximum(joint, np.exp(-(du / (w * 5)) ** 2) * span * 0.25)
    h -= joint * 0.45
    # grain
    h += (fbm(rng, 96, 2) - 0.5) * 0.05
    # albedo: bed colour, laminae, grain, joint shadows
    alb = cols[bi]
    # mottling within the beds (iron staining, bleached patches), stretched along the bedding
    alb = alb * (0.9 + 0.2 * fbm(rng, 6, 3, 2))[..., None]
    alb = alb * (1 + lam[..., None] * 0.08 + lamS[..., None] * 0.04)
    alb = alb * (0.92 + 0.16 * fbm(rng, 48, 3))[..., None]
    alb = alb * (1 - 0.35 * joint)[..., None]
    # desert varnish: dark streaks from the ledges and joints down the face
    var = np.zeros((N, N))
    for k in range(40):
        us = rng.random()
        if rng.random() < 0.35:
            # under a joint top or anywhere on a hard bed's underside
            us = (us + 0.0) % 1.0
        hb = [i for i in range(nb) if hard[i]]
        top = edges[hb[int(rng.integers(len(hb)))]] + rng.uniform(-0.01, 0.01)
        ln = rng.uniform(0.08, 0.6)
        w = rng.uniform(3, 14) / 512
        wig = (noise1(rng, 10) - 0.5) * 0.01
        du = (UU - us - wig[:, None] + 0.5) % 1.0 - 0.5
        dv = (top - VV) % 1.0  # distance below the source
        fall = sstep(0, 0.006, dv) * (1 - sstep(ln * 0.3, ln, dv))
        # a drip curtain: wide under the ledge, narrowing down the face, a firm edge
        ww = w * (1.0 - 0.6 * np.clip(dv / ln, 0, 1)) * (0.6 + 0.8 * noise1(rng, 24))[:, None]
        var = np.maximum(var, sstep(1.0, 0.55, np.abs(du) / ww) * fall * rng.uniform(0.55, 1.0))
    var *= 0.55 + 0.45 * fbm(rng, 40, 3, 10)
    VARN = np.array((0.22, 0.13, 0.08))
    var = np.clip(var, 0, 1) * 0.7
    alb = alb * (1 - var[..., None]) + VARN * var[..., None]
    return np.clip(alb, 0, 1), h, 2.5


# ------------------------------------------------------------------ granite


def voronoi(rng, cx, cy):
    """Tileable Voronoi (F1, F2, cell id) with cx x cy jittered points (anisotropic cells)."""
    pts = []
    for j in range(cy):
        for i in range(cx):
            pts.append(((i + 0.15 + 0.7 * rng.random()) / cx, (j + 0.15 + 0.7 * rng.random()) / cy))
    pts = np.array(pts)
    f1 = np.full((N, N), 9.0)
    f2 = np.full((N, N), 9.0)
    cid = np.zeros((N, N), dtype=int)
    for k, (px, py) in enumerate(pts):
        dx = (UU - px + 0.5) % 1.0 - 0.5
        dy = (VV - py + 0.5) % 1.0 - 0.5
        d = np.sqrt((dx * 1.0) ** 2 + (dy * 1.15) ** 2)
        lt = d < f1
        f2 = np.where(lt, f1, np.minimum(f2, d))
        cid = np.where(lt, k, cid)
        f1 = np.where(lt, d, f1)
    return f1, f2, cid, len(pts)


def granite():
    rng = np.random.default_rng(2024)
    # warped coordinates: joints are not straight lines
    wu = (fbm(rng, 6, 3) - 0.5) * 0.06
    wv = (fbm(rng, 6, 3) - 0.5) * 0.06
    global UU, VV
    U0, V0 = UU, VV
    UU = (U0 + wu) % 1.0
    VV = (V0 + wv) % 1.0
    f1, f2, cid, nc = voronoi(rng, 3, 3)
    UU, VV = U0, V0
    edge = f2 - f1
    crack = 1 - sstep(0.0, 0.008, edge)
    tone = rng.uniform(0.86, 1.1, nc)[cid]
    lift = rng.uniform(0.0, 0.35, nc)[cid]
    # rounded (pillowy) blocks, exfoliating at the corners
    h = np.sqrt(sstep(0.0, 0.1, edge)) * 0.5 + lift * 0.35 + (fbm(rng, 10, 5) - 0.5) * 0.45
    # a second, finer joint set (sheeting cracks) that dies out inside the blocks
    g1, g2, _, _ = voronoi(rng, 7, 6)
    crack2 = (1 - sstep(0.0, 0.005, g2 - g1)) * (fbm(rng, 8, 2) > 0.5)
    h -= crack2 * 0.12
    h -= crack * 0.25
    # crystal speckle: feldspar (pale, pink), quartz (grey glass), biotite (black)
    sp = vnoise(rng, 170) * 0.6 + vnoise(rng, 256) * 0.4
    sp2 = vnoise(rng, 210)
    base = np.array((0.56, 0.55, 0.53))
    alb = np.broadcast_to(base, (N, N, 3)).copy()
    alb *= (tone * (0.9 + 0.2 * fbm(rng, 20, 3)))[..., None]
    feld = sstep(0.62, 0.72, sp)
    alb = alb * (1 - 0.35 * feld[..., None]) + np.array((0.72, 0.68, 0.64)) * 0.35 * feld[..., None]
    bio = sstep(0.7, 0.8, sp2)
    alb = alb * (1 - 0.3 * bio[..., None]) + np.array((0.16, 0.16, 0.17)) * 0.3 * bio[..., None]
    h += (sp - 0.5) * 0.03
    # crustose lichen: rosettes of pale grey-green, the odd yellow-orange and dark patch, kept off the cracks
    ln = fbm(rng, 18, 4)
    l1 = sstep(0.66, 0.7, ln) * (1 - crack)
    ring = np.abs(ln - 0.7)
    l1 *= 0.75 + 0.25 * sstep(0.0, 0.03, ring)
    ln2 = fbm(rng, 26, 3)
    l2 = sstep(0.77, 0.8, ln2) * (1 - crack)
    ln3 = fbm(rng, 22, 3)
    l3 = sstep(0.7, 0.75, ln3) * (1 - crack)
    for m, c, a in ((l1, (0.64, 0.66, 0.58), 0.7), (l2, (0.74, 0.63, 0.40), 0.7), (l3, (0.22, 0.23, 0.20), 0.55)):
        alb = alb * (1 - a * m[..., None]) + np.array(c) * a * m[..., None]
    h += l1 * 0.02
    # stains down the joints (rain runs out of the cracks)
    stain = np.zeros((N, N))
    cr = crack * (fbm(rng, 30, 2) > 0.45)
    for k in range(1, 40):
        stain = np.maximum(stain, np.roll(cr, -k, axis=0) * (1 - k / 40))
    alb *= (1 - 0.18 * stain)[..., None]
    alb *= (1 - 0.35 * crack - 0.2 * crack2)[..., None]
    return np.clip(alb, 0, 1), h, 2.0


# ------------------------------------------------------------------ Blender: displaced sheet, bakes


def new_mat(name):
    m = bpy.data.materials.new(name)
    try:
        m.use_nodes = True  # (always on in 5.x; deprecated attribute)
    except Exception:
        pass
    return m


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    w = bpy.data.worlds.new('w')
    sc.world = w
    return sc


def sheet(name, h, S, amp, ox=0.0, oy=0.0):
    """The displaced high-poly sheet: one vertex per texel (+1 to close), z = height * amp."""
    n = N
    xs = np.arange(n + 1) / n * S
    X, Y = np.meshgrid(xs, xs)
    Z = h[np.arange(n + 1) % n][:, np.arange(n + 1) % n] * amp
    verts = np.stack([X.ravel() + ox, Y.ravel() + oy, Z.ravel()], 1)
    idx = np.arange((n + 1) * (n + 1)).reshape(n + 1, n + 1)
    faces = np.stack([idx[:-1, :-1].ravel(), idx[:-1, 1:].ravel(), idx[1:, 1:].ravel(), idx[1:, :-1].ravel()], 1)
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts.tolist(), [], faces.tolist())
    me.update()
    me.shade_smooth()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def low_plane(S):
    me = bpy.data.meshes.new('low')
    me.from_pydata([(0, 0, 0), (S, 0, 0), (S, S, 0), (0, S, 0)], [], [(0, 1, 2, 3)])
    uv = me.uv_layers.new(name='uv')
    for li, (u, v) in enumerate([(0, 0), (1, 0), (1, 1), (0, 1)]):
        uv.data[li].uv = (u, v)
    ob = bpy.data.objects.new('low', me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def bake(sc, low, high, kind, amp, S):
    img = bpy.data.images.new('bake_' + kind, N, N, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    mat = new_mat('lowmat_' + kind)
    nt = mat.node_tree
    tn = nt.nodes.new('ShaderNodeTexImage')
    tn.image = img
    nt.nodes.active = tn
    low.data.materials.clear()
    low.data.materials.append(mat)
    bpy.ops.object.select_all(action='DESELECT')
    for o in high:
        o.select_set(True)
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    rb = sc.render.bake
    rb.use_selected_to_active = True
    rb.cage_extrusion = amp * 1.3 + 0.01
    rb.max_ray_distance = amp * 3 + 0.02
    rb.margin = 0
    if kind == 'NORMAL':
        sc.cycles.samples = 1
        rb.normal_space = 'TANGENT'
        bpy.ops.object.bake(type='NORMAL')
    else:
        sc.cycles.samples = 48
        sc.world.light_settings.distance = S * 0.06
        bpy.ops.object.bake(type='AO')
    a = np.array(img.pixels[:], dtype=np.float32).reshape(N, N, 4)
    return a


def save_png(path, rgb, srgb=False):
    img = bpy.data.images.new(os.path.basename(path), N, N, alpha=False, float_buffer=False)
    img.colorspace_settings.name = 'Non-Color'
    px = np.ones((N, N, 4), dtype=np.float32)
    px[..., :3] = np.clip(rgb, 0, 1)
    img.pixels.foreach_set(px.ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    return path


def build(key, fn):
    sc = reset()
    alb, h, S = fn()
    h = (h - np.percentile(h, 1)) / (np.percentile(h, 99) - np.percentile(h, 1))
    h = np.clip(h, -0.1, 1.1)
    amp = S * (0.022 if key == 'sandstone' else 0.03)
    high = [sheet('hi_c', h, S, amp)]
    low = low_plane(S)
    nrm = bake(sc, low, high, 'NORMAL', amp, S)
    # neighbours (wrapped copies) only for the AO: occlusion across the tile edge
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            if dx or dy:
                high.append(sheet(f'hi_{dx}_{dy}', h, S, amp, dx * S, dy * S))
    ao = bake(sc, low, high[:1], 'AO', amp, S)[..., 0]
    ao = np.clip((ao - np.percentile(ao, 0.5)) / (np.percentile(ao, 99.5) - np.percentile(ao, 0.5)), 0, 1)
    ao = 0.25 + 0.75 * ao
    # albedo: a third of the AO folded in (the crevices read at RTS distance and on low quality)
    albAO = alb * (0.67 + 0.33 * ao)[..., None]
    pa = save_png(os.path.join(TMP, f'{key}_a.png'), albAO)
    nb = np.stack([nrm[..., 0], nrm[..., 1], ao], -1)
    pn = save_png(os.path.join(TMP, f'{key}_n.png'), nb)
    # the PNGs are written bottom row first by Blender's pixel order: the files are upright images
    for src, q in ((pa, 84), (pn, 90)):
        dst = os.path.join(OUT, os.path.basename(src).replace('.png', '.webp'))
        subprocess.run(['convert', src, '-quality', str(q), '-define', 'webp:method=6', dst], check=True)
        print('[rock] wrote', dst, os.path.getsize(dst) // 1024, 'KB')
    return S


def swatch(path):
    """Cycles render of the two materials on a mesa block and a crag, with the shader's moss rule approximated."""
    sc = reset()
    sc.cycles.samples = 48
    sc.render.resolution_x = 960
    sc.render.resolution_y = 480
    try:
        sc.world.use_nodes = True
    except Exception:
        pass
    bg = sc.world.node_tree.nodes['Background']
    bg.inputs[0].default_value = (0.5, 0.6, 0.75, 1)
    bg.inputs[1].default_value = 0.6

    def mat(key, S, moss):
        m = new_mat(key)
        nt = m.node_tree
        bsdf = nt.nodes['Principled BSDF']
        tc = nt.nodes.new('ShaderNodeTexCoord')
        mp = nt.nodes.new('ShaderNodeMapping')
        mp.inputs['Scale'].default_value = (1 / S, 1 / S, 1 / S)
        nt.links.new(tc.outputs['Object'], mp.inputs['Vector'])
        ia = nt.nodes.new('ShaderNodeTexImage')
        ia.image = bpy.data.images.load(os.path.join(OUT, key + '_a.webp'))
        ia.projection = 'BOX'
        ia.projection_blend = 0.25
        inn = nt.nodes.new('ShaderNodeTexImage')
        inn.image = bpy.data.images.load(os.path.join(OUT, key + '_n.webp'))
        inn.image.colorspace_settings.name = 'Non-Color'
        inn.projection = 'BOX'
        inn.projection_blend = 0.25
        for n in (ia, inn):
            nt.links.new(mp.outputs['Vector'], n.inputs['Vector'])
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(inn.outputs['Color'], sep.inputs['Color'])
        comb = nt.nodes.new('ShaderNodeCombineColor')
        nt.links.new(sep.outputs[0], comb.inputs[0])
        nt.links.new(sep.outputs[1], comb.inputs[1])
        comb.inputs[2].default_value = 1.0
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nm.inputs['Strength'].default_value = 1.0
        nt.links.new(comb.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
        col = ia.outputs['Color']
        if moss:
            # moss on the up-facing faces and in the crevices (AO), broken up by noise
            geo = nt.nodes.new('ShaderNodeNewGeometry')
            sz = nt.nodes.new('ShaderNodeSeparateXYZ')
            nt.links.new(geo.outputs['Normal'], sz.inputs['Vector'])
            nz = nt.nodes.new('ShaderNodeTexNoise')
            nz.inputs['Scale'].default_value = 3.0
            add = nt.nodes.new('ShaderNodeMath')
            add.operation = 'ADD'
            nt.links.new(sz.outputs['Z'], add.inputs[0])
            sub = nt.nodes.new('ShaderNodeMath')
            sub.operation = 'SUBTRACT'
            nt.links.new(nz.outputs['Fac'], sub.inputs[0])
            sub.inputs[1].default_value = 0.5
            nt.links.new(sub.outputs[0], add.inputs[1])
            ramp = nt.nodes.new('ShaderNodeMapRange')
            ramp.inputs['From Min'].default_value = 0.45
            ramp.inputs['From Max'].default_value = 0.85
            nt.links.new(add.outputs[0], ramp.inputs['Value'])
            mix = nt.nodes.new('ShaderNodeMix')
            mix.data_type = 'RGBA'
            nt.links.new(ramp.outputs['Result'], mix.inputs['Factor'])
            nt.links.new(col, mix.inputs['A'])
            mix.inputs['B'].default_value = (0.09, 0.14, 0.035, 1)
            col = mix.outputs['Result']
        nt.links.new(col, bsdf.inputs['Base Color'])
        bsdf.inputs['Roughness'].default_value = 0.9
        return m

    msand = mat('sandstone', 2.5, False)
    mgran = mat('granite', 2.0, True)
    # a mesa block (stepped) and a rounded crag, plus flat swatches
    bpy.ops.mesh.primitive_cube_add(size=1, location=(-2.2, 0, 1.2))
    o = bpy.context.object
    o.scale = (2.6, 2.0, 2.4)
    bpy.ops.object.transform_apply(scale=True)
    o.data.materials.append(msand)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(-2.2, 0, 2.75))
    o = bpy.context.object
    o.scale = (2.0, 1.5, 0.7)
    bpy.ops.object.transform_apply(scale=True)
    o.data.materials.append(msand)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=5, radius=1.5, location=(2.2, 0, 1.0))
    o = bpy.context.object
    o.scale = (1.3, 1.0, 0.9)
    bpy.ops.object.transform_apply(scale=True)
    tex = bpy.data.textures.new('crag', 'VORONOI')
    tex.noise_scale = 0.7
    md = o.modifiers.new('d', 'DISPLACE')
    md.texture = tex
    md.strength = 0.35
    bpy.ops.object.modifier_apply(modifier='d')
    bpy.ops.object.shade_smooth()
    o.data.materials.append(mgran)
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, 0))
    g = new_mat('ground')
    g.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.42, 0.36, 0.28, 1)
    bpy.context.object.data.materials.append(g)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    sc.collection.objects.link(cam)
    cam.location = (0, -9.5, 4.2)
    cam.rotation_euler = (math.radians(70), 0, 0)
    cam.data.lens = 30
    sc.camera = cam
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sc.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(52), math.radians(18), math.radians(-35))
    sun.data.energy = 3.5
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print('[rock] swatch', path)


build('sandstone', sandstone)
build('granite', granite)
if SWATCH:
    swatch(SWATCH)
print('ROCK_DONE')
