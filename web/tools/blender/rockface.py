# Blender 5.2.2 (LTS) - the desert's rock-face detail set (GD4: Wadi Al-Rimal's granite and sandstone).
#
#   /opt/blender/blender -b --factory-startup -P web/tools/blender/rockface.py -- <out_dir> [size=2048] [keys=dgranite,dsandst]
#   (or web/tools/blender/bake-rocks.sh, which also packs the WebPs into public/tex/terrain and writes
#   src/render/rockset.ts)
#
# Two tileable rock-face materials, in the same packing as the ground photoscans (tools/bake-terrain.mjs), used by
# the cliff relief's triplanar shader (src/render/relief.ts, rockdetail.ts), the rock kit (rockkit.ts) and, for the
# granite, the desert ground's bare-rock layer (photoground.ts):
#   dgranite  South Sinai granite: blocks between orthogonal joint sets, rounded by weathering, exfoliation sheets
#             peeling off the faces (stepped sheet edges, fresh pink scars), a fine crack network, the coarse
#             crystal grain (pink feldspar, grey quartz, black biotite) and desert varnish streaking down the faces
#   dsandst   the coloured canyon's sandstone: beds of harder and softer rock weathered back into ledges and
#             grooves, cross-bedded laminae, honeycomb (tafoni) pitting in the soft beds, vertical joints
# The relief is real geometry: a periodic height-field mesh (numpy) rendered top-down by an orthographic Cycles camera
# in emission passes - world normal and ambient occlusion (so the crevices carry true contact occlusion and the maps
# tile exactly) - then numpy composites the albedo (mineral grain, weathering, varnish, AO folded in) and the fine
# grain relief, and box-downscales to the game sizes:
#   <key>_a_<px>.png  albedo, sRGB, part of the AO folded in
#   <key>_n_<px>.png  R/G normal X/Y (OpenGL, +Y = image up = down the rock face in the game's side projections),
#                     B height (blending)
#   <key>.json        mean albedo (linear), roughness
#   <key>_preview.png a sun-lit preview (for checking only)
import bpy
import json
import math
import os
import sys
import time

import numpy as np

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else '/tmp/rockface'
S = int(argv[1]) if len(argv) > 1 else 2048
KEYS = argv[2].split(',') if len(argv) > 2 else ['dgranite', 'dsandst']
os.makedirs(OUT, exist_ok=True)
PAD = 0.06


def s2l(c):
    c = np.asarray(c, dtype=np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def l2s(v):
    v = np.clip(v, 0.0, 1.0)
    return np.where(v <= 0.0031308, v * 12.92, 1.055 * np.power(v, 1 / 2.4) - 0.055)


def field(n, lo, hi, seed, slope=1.0, ay=1.0):
    """Periodic band-limited noise on an n x n grid (unit tile): frequencies lo..hi cycles per tile, std 1.
    ay > 1 stretches it along y (streaks: the y frequencies count ay times more)."""
    rng = np.random.default_rng(seed)
    w = rng.standard_normal((n, n))
    f = np.fft.fftfreq(n) * n
    fx, fy = np.meshgrid(f, f)
    k = np.hypot(fx, fy * ay)
    band = np.exp(-np.square(np.maximum(0, lo - k) / max(1e-6, lo * 0.35))) * np.exp(-np.square(np.maximum(0, k - hi) / max(1e-6, hi * 0.35)))
    band *= np.power(np.maximum(k, 1.0), -slope)
    band[0, 0] = 0
    out = np.real(np.fft.ifft2(np.fft.fft2(w) * band))
    return out / (out.std() + 1e-12)


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def down2(a):
    return 0.25 * (a[0::2, 0::2] + a[1::2, 0::2] + a[0::2, 1::2] + a[1::2, 1::2])


def up2(a):
    """Periodic bilinear 2x upsample (a coarse field onto the render grid)."""
    b = np.repeat(np.repeat(a, 2, 0), 2, 1)
    return 0.25 * (b + np.roll(b, 1, 0) + np.roll(b, 1, 1) + np.roll(np.roll(b, 1, 0), 1, 1))


def grid_xy(n):
    xs = (np.arange(n) + 0.5) / n
    return np.meshgrid(xs, xs)


def worley(n, seeds, p=2.0, sy=1.0, warp=None):
    """Periodic Worley (Lp norm, y distances x sy): nearest / second distances and the nearest seed's index.
    warp: (dx, dy) offsets of the sample points (ragged joints)."""
    X, Y = grid_xy(n)
    if warp is not None:
        X = X + warp[0]
        Y = Y + warp[1]
    f1 = np.full((n, n), 9.0)
    f2 = np.full((n, n), 9.0)
    idx = np.zeros((n, n), dtype=np.int32)
    for k, (sx_, sy_) in enumerate(seeds):
        dx = np.abs((X - sx_ + 0.5) % 1.0 - 0.5)
        dy = np.abs((Y - sy_ + 0.5) % 1.0 - 0.5) * sy
        d = np.power(np.power(dx, p) + np.power(dy, p), 1.0 / p)
        closer = d < f1
        f2 = np.where(closer, f1, np.minimum(f2, d))
        idx = np.where(closer, k, idx)
        f1 = np.where(closer, d, f1)
    return f1, f2, idx


def jittered(rng, nx, ny, jit=0.8):
    pts = []
    for j in range(ny):
        for i in range(nx):
            pts.append(((i + 0.5 + (rng.random() - 0.5) * jit) / nx, (j + 0.5 + (rng.random() - 0.5) * jit) / ny))
    return pts


# ------------------------------------------------------------------ the two rocks (height in tile-repeat units)

def granite(n, rng):
    """Height (n x n), plus the layers the albedo needs (at n)."""
    X, Y = grid_xy(n)
    # two joint sets: near-vertical joints between columns (wavy, a little tilted) and sheeting joints across each
    # column at its own levels (they stop at the vertical joints, as in a jointed granite face)
    NC = 6
    cx = np.sort((np.arange(NC) + 0.5 + (rng.random(NC) - 0.5) * 0.7) / NC)
    xw = X + field(n, 2, 7, 101) * 0.012 + field(n, 8, 20, 102) * 0.0025 + (Y - 0.5) * 0.04
    dcol = np.full((n, n), 9.0)
    for k in range(NC):
        dcol = np.minimum(dcol, np.abs((xw - cx[k] + 0.5) % 1.0 - 0.5))
    # the column: the joint to its left
    rel = (xw[..., None] - cx[None, None, :]) % 1.0
    col = np.argmin(rel, axis=2).astype(np.int32)
    relc = np.min(rel, axis=2)
    NR = 4
    rows = np.sort((np.arange(NR)[None, :] + 0.5 + (rng.random((NC, NR)) - 0.5) * 0.8) / NR, axis=1)
    yw = Y + field(n, 2, 6, 103) * 0.01 + (X - 0.5) * 0.03
    relr = (yw[..., None] - rows[col]) % 1.0
    row = np.argmin(relr, axis=2).astype(np.int32)
    drow = np.min(np.minimum(relr, 1.0 - relr), axis=2)
    blk = col * NR + row
    nb = NC * NR
    edge = np.minimum(dcol, drow * 1.15)
    tilt = rng.normal(0, 0.045, (nb, 2))
    lift = rng.normal(0, 0.008, nb)
    H = lift[blk] + tilt[blk, 0] * (relc - 0.08) + tilt[blk, 1] * (np.min(relr, axis=2) - 0.12)
    # block edges rounded back by weathering, the joints open
    H -= 0.028 * np.power(1 - sstep(0.0, 0.05, edge), 1.7)
    H -= 0.008 * np.exp(-np.square(edge / 0.0035))
    # broad lumps
    H += 0.007 * field(n, 2, 5, 104)
    # exfoliation: a sheet or two peeling off each block parallel to the face; one side stands proud of the
    # other by the sheet's thickness, with a ragged edge
    sf = field(n, 3, 8, 105) + field(n, 10, 28, 106) * 0.22 + np.sin(blk * 2.3) * 0.9
    sheet = sstep(-0.06, 0.06, sf)
    sheet2 = sstep(-0.06, 0.06, sf - 1.3)
    H += 0.006 * sheet + 0.004 * sheet2
    edgeS = np.exp(-np.square(sf / 0.09)) + np.exp(-np.square((sf - 1.3) / 0.09)) * 0.7
    # fresh scar: just below a sheet's edge (recently peeled, pink, not yet varnished)
    scar = (1 - sheet) * sstep(-0.6, -0.08, sf) * 0.9
    # crack network: thin ridged-noise lines, broken up
    cr = 1 - np.abs(field(n, 5, 16, 107))
    crk = sstep(0.95, 0.99, cr) * sstep(-0.1, 0.6, field(n, 2, 6, 108))
    cr2 = 1 - np.abs(field(n, 14, 40, 109))
    crk2 = sstep(0.96, 0.995, cr2) * sstep(0.2, 0.9, field(n, 3, 9, 110))
    H -= 0.003 * crk + 0.0015 * crk2
    # surface: knobbly, grainy (grus) relief
    H += 0.0018 * field(n, 12, 40, 111) + 0.0007 * field(n, 50, 160, 112)
    return H, {'edge': edge, 'idx': blk, 'scar': scar, 'riser': edgeS, 'crack': np.maximum(crk, crk2 * 0.7), 'nb': nb}


def sandstone(n, rng):
    X, Y = grid_xy(n)
    # beds: horizontal (along x), warped, of varying thickness (a periodic sum of 11 beds per repeat)
    NB = 11
    warp = field(n, 1, 4, 201) * 0.012 + field(n, 5, 12, 202) * 0.003
    t = (Y + warp) * NB
    bed = np.floor(t)
    fb = t - bed
    hard = rng.random(NB)
    hb = hard[(bed.astype(int)) % NB]
    # soft beds weather back into grooves, hard ones stand out with rounded lips
    lip = sstep(0.0, 0.18, fb) * (1 - sstep(0.75, 1.0, fb))
    H = 0.018 * hb * lip + 0.006 * (1 - hb) * np.sin(fb * math.pi)
    H += 0.004 * (1 - sstep(0.0, 0.05, fb)) * -1
    # cross-bedding: fine slanted laminae in about half the beds
    slope = (rng.random(NB) - 0.5) * 0.8
    on = (rng.random(NB) < 0.55).astype(np.float64)
    bi = bed.astype(int) % NB
    lam = np.sin((Y + X * slope[bi]) * 2 * math.pi * 70 + field(n, 4, 10, 203) * 1.2)
    H += 0.0012 * lam * on[bi]
    # honeycomb (tafoni): small pits in clusters, in the soft beds
    pr = np.random.default_rng(204)
    pits = [(pr.random(), pr.random()) for _ in range(900)]
    f1, f2, pidx = worley(n, pits, p=2.0, sy=1.0)
    cell = 1 - sstep(0.0, 0.9, f1 / np.maximum(f2, 1e-6))
    zone = sstep(0.25, 0.75, field(n, 2, 6, 205)) * (1 - hb) ** 0.7
    H -= 0.012 * np.power(cell, 1.6) * zone
    # vertical joints: a few wandering lines
    jx = (X + field(n, 2, 6, 206) * 0.02) * 4
    jd = np.abs((jx % 1.0) - 0.5)
    joint = np.exp(-np.square(jd / 0.012)) * sstep(-0.3, 0.6, field(n, 2, 5, 207))
    H -= 0.014 * joint
    # broad swells and the grain
    H += 0.012 * field(n, 1, 4, 208) + 0.0016 * field(n, 20, 80, 209) + 0.0006 * field(n, 90, 250, 210)
    return H, {'bed': bi, 'hb': hb, 'fb': fb, 'tafoni': np.power(cell, 1.6) * zone, 'joint': joint, 'lam': lam * on[bi]}


# ------------------------------------------------------------------ scene

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.render.threads_mode = 'FIXED'
    sc.render.threads = 3
    sc.cycles.use_denoising = False
    sc.cycles.max_bounces = 0
    sc.cycles.use_adaptive_sampling = False
    sc.cycles.pixel_filter_type = 'BOX'
    sc.cycles.filter_width = 1.0
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    sc.render.resolution_x = S
    sc.render.resolution_y = S
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = 'OPEN_EXR'
    sc.render.image_settings.color_depth = '32'
    w = bpy.data.worlds.new('w')
    w.use_nodes = True
    bg = w.node_tree.nodes.get('Background')
    if bg:
        bg.inputs['Strength'].default_value = 0.0
    sc.world = w
    cam = bpy.data.cameras.new('cam')
    cam.type = 'ORTHO'
    cam.ortho_scale = 1.0
    cam.clip_start = 0.01
    cam.clip_end = 10
    co = bpy.data.objects.new('cam', cam)
    co.location = (0.5, 0.5, 2.0)
    sc.collection.objects.link(co)
    sc.camera = co
    return sc


def grid_mesh(name, H):
    """Height-field mesh over [-PAD, 1 + PAD]^2 from the periodic height array H (n x n per unit tile; rows = y)."""
    n = H.shape[0]
    pad = int(math.ceil(PAD * n))
    idx = np.arange(-pad, n + pad + 1)
    G = len(idx)
    xs = (idx + 0.5) / n
    X, Y = np.meshgrid(xs, xs)
    Z = H[np.mod(idx, n)][:, np.mod(idx, n)]
    co = np.stack([X.ravel(), Y.ravel(), Z.ravel()], 1).astype(np.float32)
    i = np.arange(G - 1)
    I, J = np.meshgrid(i, i)
    a = (J * G + I).ravel()
    quads = np.stack([a, a + 1, a + G + 1, a + G], 1).astype(np.int32)
    me = bpy.data.meshes.new(name)
    me.vertices.add(G * G)
    me.vertices.foreach_set('co', co.ravel())
    me.loops.add(quads.size)
    me.loops.foreach_set('vertex_index', quads.ravel())
    me.polygons.add(len(quads))
    me.polygons.foreach_set('loop_start', np.arange(0, quads.size, 4, dtype=np.int32))
    me.update(calc_edges=True)
    me.polygons.foreach_set('use_smooth', np.ones(len(quads), dtype=bool))
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def pass_material(ao_dist):
    m = bpy.data.materials.new('m_rock')
    m.use_nodes = True
    nt = m.node_tree
    for nd in list(nt.nodes):
        nt.nodes.remove(nd)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    em = {p: nt.nodes.new('ShaderNodeEmission') for p in ('normal', 'ao')}
    vm = nt.nodes.new('ShaderNodeVectorMath')
    vm.operation = 'MULTIPLY_ADD'
    vm.inputs[1].default_value = (0.5, 0.5, 0.5)
    vm.inputs[2].default_value = (0.5, 0.5, 0.5)
    nt.links.new(geo.outputs['Normal'], vm.inputs[0])
    nt.links.new(vm.outputs['Vector'], em['normal'].inputs['Color'])
    ao = nt.nodes.new('ShaderNodeAmbientOcclusion')
    ao.samples = 24
    ao.inputs['Distance'].default_value = ao_dist
    nt.links.new(ao.outputs['AO'], em['ao'].inputs['Color'])
    return m, out, em


def render(mat, p, samples):
    m, out, em = mat
    m.node_tree.links.new(em[p].outputs['Emission'], out.inputs['Surface'])
    sc = bpy.context.scene
    sc.cycles.samples = samples
    path = os.path.join(OUT, f'_pass_{p}.exr')
    sc.render.filepath = path
    t = time.time()
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    a = np.zeros(S * S * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    os.remove(path)
    print(f'  pass {p}: {time.time() - t:.1f} s')
    return a.reshape(S, S, 4)[:, :, :3].astype(np.float64)


def save(name, rgb):
    h, w = rgb.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=False, float_buffer=False)
    img.colorspace_settings.name = 'Non-Color'
    px4 = np.concatenate([np.clip(rgb, 0, 1), np.ones((h, w, 1))], 2).astype(np.float32)
    img.pixels.foreach_set(px4.ravel())
    img.filepath_raw = os.path.join(OUT, name + '.png')
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


# ------------------------------------------------------------------ albedo

def granite_albedo(L, ao, H):
    """L: the granite's layers upsampled to S; ao: Cycles AO (S); H: height at S."""
    # coarse crystal grain: pink / flesh feldspar, grey glassy quartz, black biotite flakes
    c1 = field(S, 180, 420, 301, 0.0)
    c2 = field(S, 160, 380, 302, 0.0)
    c3 = field(S, 220, 520, 303, 0.0)
    feld = s2l([178, 122, 100])
    feld2 = s2l([196, 150, 126])
    quartz = s2l([150, 146, 140])
    biot = s2l([46, 40, 38])
    a = feld[None, None, :] * np.ones((S, S, 1))
    a = a + (feld2 - feld)[None, None, :] * sstep(-0.4, 0.8, c2)[:, :, None]
    q = sstep(0.55, 0.95, c1)
    a = a * (1 - q[:, :, None]) + quartz[None, None, :] * q[:, :, None]
    b = sstep(1.35, 1.75, c3)
    a = a * (1 - b[:, :, None] * 0.9) + biot[None, None, :] * (b[:, :, None] * 0.9)
    # per block tone and hue (each block weathered its own way)
    nb = L['nb']
    rng = np.random.default_rng(304)
    tone = 1 + rng.normal(0, 0.07, nb)
    hue = rng.normal(0, 0.035, nb)
    idx = L['idx']
    a *= tone[idx][:, :, None]
    a[:, :, 0] *= 1 + hue[idx]
    a[:, :, 2] *= 1 - hue[idx]
    # weathering rind: the old, exposed surfaces brown and dull; fresh scars of peeled sheets pinker and paler
    mott = field(S, 3, 12, 305)
    rind = np.clip(0.55 + 0.25 * mott - 0.9 * L['scar'] - 0.5 * L['riser'], 0, 1)
    brown = s2l([132, 92, 70])
    a = a * (1 - 0.45 * rind[:, :, None]) + brown[None, None, :] * (0.45 * rind[:, :, None])
    a *= (1 + 0.12 * L['scar'])[:, :, None]
    # desert varnish: dark manganese streaks running down the faces (down = image up, +y, in the game's projection)
    st = field(S, 4, 30, 306, 0.6, ay=7.0)
    src = np.clip(field(S, 2, 6, 307) * 0.6 + 0.2, 0, 1)
    varnish = sstep(0.35, 1.4, st) * src * (1 - 0.8 * L['scar'])
    # ...and patina on the exposed bumps
    exposed = sstep(0.55, 0.95, ao)
    varnish = np.clip(varnish + 0.25 * exposed * sstep(0.0, 1.2, mott), 0, 1)
    vc = s2l([64, 44, 34])
    a = a * (1 - 0.62 * varnish[:, :, None]) + vc[None, None, :] * (0.62 * varnish[:, :, None])
    # cracks and joints dark (dust and shade in them), the AO folded in by half
    a *= (1 - 0.35 * L['crack'])[:, :, None]
    a *= (0.45 + 0.55 * np.clip(ao, 0, 1))[:, :, None]
    return a


def sandstone_albedo(L, ao, H):
    rng = np.random.default_rng(401)
    NB = 11
    # a near-neutral warm sand: the game's canyon shader brings the bands' colours (strata.ts), this the rock's
    # own grain, its beds (paler hard beds, iron lines), the laminae and the honeycomb's shade
    base = s2l([186, 152, 118])
    a = base[None, None, :] * np.ones((S, S, 1))
    bt = 1 + rng.normal(0, 0.06, NB)
    a *= bt[L['bed']][:, :, None]
    a *= (1 + 0.06 * L['hb'])[:, :, None]
    iron = (1 - sstep(0.0, 0.035, L['fb'])) * (rng.random(NB) < 0.5)[L['bed']]
    a = a * (1 - 0.35 * iron[:, :, None]) + s2l([128, 70, 48])[None, None, :] * (0.35 * iron[:, :, None])
    a *= (1 + 0.035 * L['lam'])[:, :, None]
    grain = field(S, 200, 600, 402, 0.0)
    a *= (1 + 0.05 * grain + 0.04 * field(S, 6, 20, 403))[:, :, None]
    a *= (1 - 0.18 * L['tafoni'] - 0.25 * L['joint'])[:, :, None]
    st = field(S, 4, 24, 404, 0.6, ay=6.0)
    a *= (1 - 0.12 * sstep(0.6, 1.6, st))[:, :, None]
    a *= (0.5 + 0.5 * np.clip(ao, 0, 1))[:, :, None]
    return a


# ------------------------------------------------------------------ build

def build(key):
    rng = np.random.default_rng({'dgranite': 7, 'dsandst': 19}[key])
    reset()
    n = S // 2
    gr = key == 'dgranite'
    H, L = granite(n, rng) if gr else sandstone(n, rng)
    print(f'{key}: height range {H.min():.4f} .. {H.max():.4f}')
    ground = grid_mesh('rock', H)
    mat = pass_material(0.06 if gr else 0.035)
    ground.data.materials.append(mat[0])
    nor = render(mat, 'normal', 6) * 2 - 1
    ao = render(mat, 'ao', 24)[:, :, 0]
    # (Blender stores rows bottom-up: row 0 = y 0, as the numpy grids; saving keeps that orientation)
    Hs = up2(H)
    Ls = {}
    for k, v in L.items():
        if isinstance(v, np.ndarray):
            Ls[k] = np.repeat(np.repeat(v, 2, 0), 2, 1) if v.dtype.kind in 'iu' else up2(v)
        else:
            Ls[k] = v
    alb = granite_albedo(Ls, ao, Hs) if gr else sandstone_albedo(Ls, ao, Hs)
    # fine grain relief on top of the rendered normals
    gz = (0.00004 if gr else 0.00003) * field(S, 160, 600, 501, 0.0)
    px = 1.0 / S
    gx = (np.roll(gz, -1, 1) - np.roll(gz, 1, 1)) / (2 * px)
    gy = (np.roll(gz, -1, 0) - np.roll(gz, 1, 0)) / (2 * px)
    nn = nor + np.stack([-gx, -gy, np.zeros_like(gx)], 2)
    nn /= np.linalg.norm(nn, axis=2, keepdims=True)
    h1, h99 = np.percentile(Hs, 1), np.percentile(Hs, 99)
    hb = np.clip((Hs - h1) / max(1e-9, h99 - h1), 0, 1)
    meanc = alb.reshape(-1, 3).mean(0)
    print(f'  mean albedo (linear) {meanc.round(4).tolist()}  ao mean {ao.mean():.3f}  normal z mean {nn[:, :, 2].mean():.3f}')
    a, nm, hh = alb, nn, hb
    for size in (2048, 1024, 512):
        while a.shape[0] > size:
            a, nm, hh = down2(a), down2(nm), down2(hh)
        if a.shape[0] != size:
            continue
        nrm = nm / np.linalg.norm(nm, axis=2, keepdims=True)
        save(f'{key}_a_{size}', l2s(a))
        save(f'{key}_n_{size}', np.stack([nrm[:, :, 0] * 0.5 + 0.5, nrm[:, :, 1] * 0.5 + 0.5, hh], 2))
    # sun-lit preview (sun from the upper left, 40 degrees up)
    Lv = np.array([-0.55, 0.45, 0.7])
    Lv /= np.linalg.norm(Lv)
    sh = np.clip((nn @ Lv), 0, 1) * 0.85 + 0.25
    save(f'{key}_preview', l2s(alb * sh[:, :, None] * 1.25)[: S // 2, : S // 2])
    with open(os.path.join(OUT, key + '.json'), 'w') as f:
        json.dump({'key': key, 'mean': [round(float(v), 4) for v in meanc], 'rough': 0.84 if gr else 0.9}, f)


for key in KEYS:
    t0 = time.time()
    build(key)
    print(f'{key} done in {time.time() - t0:.0f} s')
print('OK_DONE')
