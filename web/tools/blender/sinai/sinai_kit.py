# Blender 5.2.2 (LTS) - GD2: the South Sinai (Sharm) building kit for Wadi Al-Rimal's town and resort.
#
#   blender -b --factory-startup -P tools/blender/sinai/sinai_kit.py -- [plaster|kit|all]     (from web/; make.sh)
#
# plaster  a tileable rendered-plaster texture (numpy, periodic by construction: FFT-filtered noise, wrapped
#          Voronoi cracks): roughcast grain, trowel patches, hairline cracks, water stains and streaks, repaired
#          patches -> build/sinai/plaster-{albedo,normal,orm}.png (512 px; 1 repeat = PLASTER_TILE tiles)
# kit      the modular pieces, modelled high poly (bevels, louvres, grilles, ribs, muqarnas) and low poly
#          (LOD0 + a lighter LOD1), unwrapped into ONE shared atlas, Cycles-baked high -> low (tangent normals,
#          AO, albedo, roughness / tint class / glass masks):
#            - wall cards: recessed windows (plain, open or closed louvred shutters, iron grille, arched,
#              small vent), doors (panelled, arched double, yard gate), a shop front with a half-rolled
#              shutter, an open arch for arcades, hotel windows and balcony doors, a mosque lattice window;
#              flat quads that sit on the plaster walls (the depth comes from the bake);
#            - 3D pieces: split AC unit, water tank on its stand, satellite dish, solar water heater,
#              railing segment, striped awning, plaster dome, the mosque's drum + ribbed dome, the minaret,
#              merlon, cafe table set, promenade kiosk;
#            - swatches: flat patches (paint, wood, metal, stone, glass, iron...) for code-built trim.
#          -> build/sinai/sinai-kit-raw.glb + atlas-{albedo,normal,orm}.png + sinai-kit.json (card rects / sizes)
# Then tools/blender/sinai/pack.mjs compresses everything into public/models/sinai/.
#
# The glass is the only material with a roughness under 0.15: the game lights it at night from the ORM's G.
# Conventions: Blender Z up, a piece's front faces -Y (glTF / game +Z), 1 unit = 1 map tile, origin at the
# piece's foot (cards: the card's centre). Atlas ORM: R = AO, G = roughness, B = tint class (0 untinted,
# 0.5 wall plaster - the game samples its world-mapped plaster there, 1 accent paint).
import bpy
import bmesh
import json
import math
import os
import sys
import time

import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import common as C  # noqa: E402

OUT = os.path.join(C.BUILD, 'sinai')
os.makedirs(OUT, exist_ok=True)
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
STAGE = ARGS[0] if ARGS else 'all'
ATLAS = 1024
PLASTER = 512
PLASTER_TILE = 1.25  # tiles per plaster texture repeat (the game's world-space mapping uses the same)


def log(*a):
    print('[sinai]', *a, flush=True)


# ====================================================================== plaster (numpy)

def fft_noise(n, rng, lo, hi, aniso=(1.0, 1.0)):
    """Periodic band-limited noise (n x n), zero mean, unit std: white noise filtered to wavelengths lo..hi px."""
    w = rng.standard_normal((n, n))
    fx = np.fft.fftfreq(n)[None, :] * aniso[0]
    fy = np.fft.fftfreq(n)[:, None] * aniso[1]
    f = np.sqrt(fx * fx + fy * fy) + 1e-9
    band = np.exp(-((np.log(f) - np.log(2.0 / (lo + hi))) ** 2) / (2 * 0.55 ** 2))
    band[(f < 1.0 / hi * 0.5)] *= 0.2
    out = np.real(np.fft.ifft2(np.fft.fft2(w) * band))
    return (out - out.mean()) / (out.std() + 1e-9)


def wrap_voronoi(n, pts):
    """F1, F2 distances (px) to periodic feature points pts (k, 2) in px."""
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    f1 = np.full((n, n), 1e9, np.float32)
    f2 = np.full((n, n), 1e9, np.float32)
    for px, py in pts:
        dx = np.abs(xx - px)
        dx = np.minimum(dx, n - dx)
        dy = np.abs(yy - py)
        dy = np.minimum(dy, n - dy)
        d = np.sqrt(dx * dx + dy * dy)
        f2 = np.where(d < f1, f1, np.minimum(f2, d))
        f1 = np.minimum(f1, d)
    return f1, f2


def warp(a, dx, dy):
    """Sample a (periodic) at (x + dx, y + dy), bilinear."""
    n = a.shape[0]
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
    x = (xx + dx) % n
    y = (yy + dy) % n
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    fx = x - x0
    fy = y - y0
    x1 = (x0 + 1) % n
    y1 = (y0 + 1) % n
    return (a[y0, x0] * (1 - fx) + a[y0, x1] * fx) * (1 - fy) + (a[y1, x0] * (1 - fx) + a[y1, x1] * fx) * fy


def normal_from_height(hgt, strength):
    gx = (np.roll(hgt, -1, 1) - np.roll(hgt, 1, 1)) * 0.5 * strength
    gy = (np.roll(hgt, -1, 0) - np.roll(hgt, 1, 0)) * 0.5 * strength
    n = np.stack([-gx, gy, np.ones_like(hgt)], -1)  # image rows run down: +v is -row (Blender bottom-up rows)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return n * 0.5 + 0.5


def build_plaster():
    n = PLASTER
    rng = np.random.default_rng(1405)
    px_per_tile = n / PLASTER_TILE
    # roughcast grain (fine), trowel swirls (medium, stretched), sagging coats (coarse)
    grain = fft_noise(n, rng, 1.5, 4)
    grain2 = fft_noise(n, rng, 3, 8)
    trowel = fft_noise(n, rng, 20, 60, aniso=(1.0, 2.2))
    coat = fft_noise(n, rng, 60, 200)
    hgt = 0.35 * grain + 0.3 * grain2 + 0.55 * trowel + 0.4 * coat
    # repaired patches: smoother, slightly lighter / creamier render in blobs
    patch_n = fft_noise(n, rng, 70, 180)
    patch = C.sstep(1.1, 1.5, patch_n)
    hgt = hgt * (1 - 0.55 * patch) + patch * 0.8
    # hairline cracks: wrapped Voronoi cell edges, domain-warped, only where a mask allows (a few runs per tile)
    k = 22
    pts = rng.random((k, 2)) * n
    wx = fft_noise(n, rng, 10, 30) * 4.5
    wy = fft_noise(n, rng, 10, 30) * 4.5
    f1, f2 = wrap_voronoi(n, pts)
    edge = warp(f2 - f1, wx, wy)
    crack_mask = C.sstep(0.35, 0.9, fft_noise(n, rng, 50, 140))
    crack = (1 - C.sstep(0.4, 1.6, edge)) * crack_mask
    # finer hairlines: zero crossings of a warped noise (distance to the crossing ~ |n| / |grad n|, in px)
    fn = warp(fft_noise(n, rng, 40, 110), wx * 0.6, wy * 0.6)
    gx = (np.roll(fn, -1, 1) - np.roll(fn, 1, 1)) * 0.5
    gy = (np.roll(fn, -1, 0) - np.roll(fn, 1, 0)) * 0.5
    dist = np.abs(fn) / (np.sqrt(gx * gx + gy * gy) + 1e-4)
    fine = (1 - C.sstep(0.3, 1.1, dist)) * C.sstep(1.0, 1.5, fft_noise(n, rng, 60, 160)) * 0.55
    crack = np.maximum(crack, fine)
    hgt = hgt - crack * 2.2
    # stains: water marks running down (vertically stretched), dust blotches, ochre tide lines
    streak = fft_noise(n, rng, 6, 40, aniso=(1.0, 0.12))
    blotch = fft_noise(n, rng, 40, 160)
    tide = C.sstep(0.9, 1.2, fft_noise(n, rng, 30, 90)) - C.sstep(1.25, 1.6, fft_noise(n, rng, 30, 90))
    stain = np.clip(0.5 * C.sstep(0.4, 1.8, streak) * C.sstep(-0.2, 0.8, blotch) + 0.35 * C.sstep(0.6, 1.8, blotch), 0, 1)
    # albedo: off-white render (the game tints it with the wall colour), low-saturation variation
    base = np.array([0.80, 0.785, 0.755], np.float32)
    lum = 1 + 0.02 * grain + 0.014 * trowel + 0.012 * coat
    alb = base[None, None, :] * lum[..., None]
    alb = alb * (1 - patch[..., None] * 0.0) + patch[..., None] * (np.array([0.84, 0.82, 0.775]) - base) * 0.6
    dirt = np.array([0.56, 0.5, 0.42], np.float32)
    alb = alb * (1 - stain[..., None] * 0.07) + dirt * stain[..., None] * 0.07
    alb = alb * (1 - np.clip(tide, 0, 1)[..., None] * 0.05)
    alb = alb * (1 - crack[..., None] * 0.28)
    # cavity AO from the height field
    hb = C.blur(hgt, 3)
    cav = np.clip(1 + (hgt - hb) * 0.18, 0.55, 1.0)
    ao = np.clip(cav * (1 - crack * 0.5), 0, 1)
    rough = np.clip(0.9 + 0.04 * grain - 0.08 * patch + 0.04 * stain, 0.6, 1.0)
    nrm = normal_from_height(hgt, 0.5)
    C.save_rgb(os.path.join(OUT, 'plaster-albedo.png'), C.lin2srgb(alb), n)
    C.save_rgb(os.path.join(OUT, 'plaster-normal.png'), nrm, n)
    C.save_rgb(os.path.join(OUT, 'plaster-orm.png'), np.stack([ao, rough, np.zeros_like(ao)], -1), n)
    log('plaster', n, 'mean albedo', alb.reshape(-1, 3).mean(0).round(3).tolist())
    return alb.reshape(-1, 3).mean(0)


# ====================================================================== kit: materials

# name: (sRGB hex, roughness, tint class, glass)
MATS = {
    'plaster': (0xd6d1c6, 0.92, 0.5, 0),
    'frame': (0xefece4, 0.5, 0, 0),
    'glass': (0x1c2329, 0.1, 0, 1),
    'paint': (0xe2e2e0, 0.55, 1, 0),
    'iron': (0x26262a, 0.55, 0, 0),
    'wood': (0x6c4a2e, 0.8, 0, 0),
    'wood_lt': (0x9a7350, 0.78, 0, 0),
    'stone': (0xd5c8ab, 0.86, 0, 0),
    'metal': (0xa3a7a9, 0.42, 0, 0),
    'steel': (0x5f6366, 0.5, 0, 0),
    'plastic': (0xe4e4e0, 0.45, 1, 0),
    'dark': (0x17140f, 0.95, 0, 0),
    'interior': (0x3a3128, 0.95, 0, 0),
    'fabric': (0xf1eee6, 0.85, 0, 0),
    'fabric_acc': (0xe6e6e4, 0.85, 1, 0),
    'gold': (0xc6a04a, 0.35, 0, 0),
    'solar': (0x1a2a40, 0.18, 0, 0),
    'rubber': (0x2b2b2b, 0.8, 0, 0),
    'shutter': (0xb8bcbd, 0.5, 0, 0),
    'tile_g': (0x2f7a68, 0.4, 0, 0),
    'aluminium': (0xd6d8d8, 0.4, 0, 0),
    'thatch': (0xa98454, 0.95, 0, 0),
}


def mat(name):
    m = bpy.data.materials.get('k_' + name)
    if m:
        return m
    m = bpy.data.materials.new('k_' + name)
    m.use_nodes = True
    m['kit'] = name
    return m


def set_emit(mode):
    """Rewire every kit material to emit its linear albedo ('albedo') or (roughness, class, glass) ('mask')."""
    for m in bpy.data.materials:
        k = m.get('kit')
        if not k:
            continue
        hexv, rough, cls, glass = MATS[k]
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        em = nt.nodes.new('ShaderNodeEmission')
        if mode == 'albedo':
            c = C.hexlin(hexv)
            em.inputs['Color'].default_value = (float(c[0]), float(c[1]), float(c[2]), 1)
        else:
            em.inputs['Color'].default_value = (rough, cls, glass, 1)
        em.inputs['Strength'].default_value = 1.0
        nt.links.new(em.outputs[0], out.inputs[0])


# ====================================================================== kit: geometry helpers

SC = None
PIECE_OFF = Vector((0, 0, 0))
HIGHS = []  # high poly objects of the piece / card being built


def link(o):
    SC.collection.objects.link(o)
    return o


def from_bm(name, bm, m):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = link(bpy.data.objects.new(name, me))
    me.materials.append(mat(m))
    return o


def place(o, loc=(0, 0, 0), rot=(0, 0, 0), hi=True):
    o.rotation_euler = rot
    o.location = Vector(loc) + PIECE_OFF
    if hi:
        HIGHS.append(o)
    return o


def bevel(o, w, segs=2, angle=35):
    if w <= 0:
        return o
    md = o.modifiers.new('bevel', 'BEVEL')
    md.width = w
    md.segments = segs
    md.limit_method = 'ANGLE'
    md.angle_limit = math.radians(angle)
    md.harden_normals = False
    return o


def box(sx, sy, sz, loc, m, rot=(0, 0, 0), bv=0.0, segs=2, hi=True, name='b'):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=(sx, sy, sz), verts=bm.verts)
    o = place(from_bm(name, bm, m), loc, rot, hi)
    return bevel(o, bv, segs)


def cyl(r1, r2, h, loc, m, seg=16, rot=(0, 0, 0), bv=0.0, hi=True, caps=True, name='c'):
    """Cylinder / cone frustum standing on loc (bottom radius r1, top r2), axis +Z (before rot)."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=seg, radius1=r1, radius2=r2, depth=h)
    bmesh.ops.translate(bm, vec=(0, 0, h / 2), verts=bm.verts)
    o = place(from_bm(name, bm, m), loc, rot, hi)
    return bevel(o, bv, 1)


def sphere(r, loc, m, seg=24, rings=12, scale=(1, 1, 1), hemi=False, hi=True, name='s'):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=r)
    if hemi:
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < -1e-5], context='VERTS')
        # close the bottom
        edges = [e for e in bm.edges if e.is_boundary]
        if edges:
            bmesh.ops.edgeloop_fill(bm, edges=edges)
    bmesh.ops.scale(bm, vec=scale, verts=bm.verts)
    return place(from_bm(name, bm, m), loc, (0, 0, 0), hi)


def torus(R, r, loc, m, seg=24, cseg=6, rot=(0, 0, 0), arc=2 * math.pi, hi=True):
    bm = bmesh.new()
    verts = []
    closed = arc >= 2 * math.pi - 1e-6
    n = seg if closed else seg + 1
    for i in range(n):
        a = arc * i / seg
        ring = []
        for j in range(cseg):
            b = 2 * math.pi * j / cseg
            x = (R + r * math.cos(b)) * math.cos(a)
            y = (R + r * math.cos(b)) * math.sin(a)
            z = r * math.sin(b)
            ring.append(bm.verts.new((x, y, z)))
        verts.append(ring)
    for i in range(seg):
        a = verts[i]
        b = verts[(i + 1) % n]
        for j in range(cseg):
            bm.faces.new((a[j], b[j], b[(j + 1) % cseg], a[(j + 1) % cseg]))
    return place(from_bm('t', bm, m), loc, rot, hi)


def smooth(o, deg=40):
    """Smooth shading with sharp edges above deg (mesh API: no operator, no selection)."""
    o.data.shade_smooth()
    o.data.set_sharp_from_angle(angle=math.radians(deg))


def apply_mods(o):
    """Bake modifiers + transform into the mesh (for booleans on further objects)."""
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    old = o.data
    o.modifiers.clear()
    o.data = me
    bpy.data.meshes.remove(old)
    return o


def cut(o, cutter):
    md = o.modifiers.new('bool', 'BOOLEAN')
    md.operation = 'DIFFERENCE'
    md.solver = 'EXACT'
    md.object = cutter
    apply_mods(o)
    bpy.data.objects.remove(cutter)
    return o


def drop(o):
    if o in HIGHS:
        HIGHS.remove(o)
    bpy.data.objects.remove(o)


# ----------------------------------------------------------------- openings (wall cards, local: wall face y = 0,
# the wall body behind it towards +y, front -y, z up, card centred on x = 0, its bottom at z = -h / 2)

WALL_D = 0.06


def opening_cutters(ow, oh, oz, arch, depth=WALL_D + 0.04):
    """Cutter objects for an opening ow x oh whose sill is at z = oz; arch: round top (semicircle)."""
    cs = []
    rect_h = oh - (ow / 2 if arch else 0)
    cs.append(box(ow, depth, rect_h + (0.002 if arch else 0), (0, depth / 2 - 0.02, oz + rect_h / 2), 'plaster', hi=False))
    if arch:
        cs.append(cyl(ow / 2, ow / 2, depth, (0, -0.02, oz + rect_h), 'plaster', seg=32, rot=(-math.pi / 2, 0, 0), hi=False))
    return cs


def wall_with_opening(w, h, ow, oh, oz, arch=False, depth=WALL_D):
    wall = box(w, depth, h, (0, depth / 2, 0), 'plaster')
    for c in opening_cutters(ow, oh, oz, arch):
        cut(wall, c)
    return wall


def arc_pts(cx, cz, r, a0, a1, n):
    return [(cx + r * math.cos(a0 + (a1 - a0) * i / n), cz + r * math.sin(a0 + (a1 - a0) * i / n)) for i in range(n + 1)]


def bar(p, q, y, t, d, m, hi=True):
    """A bar of width t, depth d from 2D point p to q in the card plane (x, z) at depth y."""
    dx, dz = q[0] - p[0], q[1] - p[1]
    L = math.hypot(dx, dz)
    ang = math.atan2(dz, dx)
    return box(L + t * 0.5, d, t, ((p[0] + q[0]) / 2, y, (p[1] + q[1]) / 2), m, rot=(0, -ang, 0), hi=hi)


def outline(ow, oh, oz, arch, inset=0.0):
    """Polyline round an opening (clockwise from the bottom left), inset inwards."""
    x0, x1 = -ow / 2 + inset, ow / 2 - inset
    rect_h = oh - (ow / 2 if arch else 0)
    pts = [(x0, oz + inset), (x0, oz + rect_h)]
    if arch:
        pts += arc_pts(0, oz + rect_h, ow / 2 - inset, math.pi, 0, 12)[1:-1]
        pts += [(x1, oz + rect_h)]
    else:
        pts += [(x0, oz + oh - inset), (x1, oz + oh - inset)]
    pts += [(x1, oz + inset)]
    return pts


def frame_ring(ow, oh, oz, arch, y, t, d, m):
    pts = outline(ow, oh, oz, arch, t / 2)
    for i in range(len(pts)):
        bar(pts[i], pts[(i + 1) % len(pts)], y, t, d, m)


def glass_pane(ow, oh, oz, arch, y):
    rect_h = oh - (ow / 2 if arch else 0)
    box(ow, 0.004, rect_h, (0, y, oz + rect_h / 2), 'glass')
    if arch:
        cyl(ow / 2, ow / 2, 0.004, (0, y - 0.002, oz + rect_h), 'glass', seg=24, rot=(-math.pi / 2, 0, 0))


def louvres(x0, x1, z0, z1, y, m, pitch=0.009, tilt=0.6, frame=0.008):
    w = x1 - x0
    for x in (x0 + frame / 2, x1 - frame / 2):
        box(frame, 0.008, z1 - z0, (x, y, (z0 + z1) / 2), m, bv=0.0015)
    for z in (z0 + frame / 2, z1 - frame / 2, (z0 + z1) / 2):
        box(w, 0.008, frame, ((x0 + x1) / 2, y, z), m, bv=0.0015)
    z = z0 + frame
    while z < z1 - frame - pitch * 0.5:
        box(w - 2 * frame + 0.002, 0.002, pitch * 1.25, ((x0 + x1) / 2, y, z + pitch / 2), m, rot=(tilt, 0, 0))
        z += pitch


def sill(ow, oz, proud=0.016, thick=0.012, m='stone'):
    box(ow + 0.03, WALL_D * 0.6 + proud, thick, (0, (WALL_D * 0.6 - proud) / 2, oz - thick / 2 + 0.001), m, bv=0.002)


# ====================================================================== kit: cards

CARDS = {}  # name -> dict(size=(w, h), lo=obj, hi=[...], off=Vector)


SLOT = [0]


def next_slot():
    """Spread every card / piece out on a grid so no bake ray reaches a neighbour."""
    global PIECE_OFF
    PIECE_OFF = Vector(((SLOT[0] % 8) * 3.0, (SLOT[0] // 8) * 3.0, 0))
    SLOT[0] += 1


def card(name, w, h):
    """Start a card: the low poly is a w x h quad on the wall plane facing -y."""
    global HIGHS
    next_slot()
    HIGHS = []
    bm = bmesh.new()
    vs = [bm.verts.new((x, 0, z)) for x, z in ((-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2))]
    f = bm.faces.new(vs)
    f.normal_update()
    if f.normal.y > 0:
        f.normal_flip()
    lo = place(from_bm('card_' + name, bm, 'plaster'), (0, 0, 0), hi=False)
    CARDS[name] = dict(size=(w, h), lo=lo, hi=HIGHS)
    return -h / 2  # the card's bottom (z)


def card_window(name, w, h, ow, oh, oz, arch=False, kind='plain', depth=0.032):
    """A window: the opening in the plaster, a reveal, a frame with glazing bars, glass, a stone sill, a
    plaster lintel band; kind adds open / closed louvred shutters, an iron grille or a lattice."""
    card(name, w, h)
    wall_with_opening(w, h, ow, oh, oz, arch)
    fy = depth
    frame_ring(ow, oh, oz, arch, fy, 0.011, 0.012, 'frame')
    glass_pane(ow - 0.01, oh - 0.01, oz + 0.005, arch, fy + 0.004)
    rect_h = oh - (ow / 2 if arch else 0)
    # glazing bars: a mullion and a transom
    if kind in ('plain', 'shutter', 'grille', 'hotel'):
        box(0.006, 0.008, rect_h - 0.01, (0, fy - 0.001, oz + rect_h / 2), 'frame')
        box(ow - 0.01, 0.008, 0.006, (0, fy - 0.001, oz + rect_h * 0.68), 'frame')
    sill(ow, oz)
    # lintel band (a slightly proud plaster moulding)
    if not arch:
        box(ow + 0.03, 0.006, 0.014, (0, -0.003, oz + oh + 0.007), 'plaster', bv=0.002)
    else:
        for p, q in zip(outline(ow + 0.024, oh + 0.012, oz, True)[1:-2], outline(ow + 0.024, oh + 0.012, oz, True)[2:-1]):
            bar(p, q, -0.003, 0.012, 0.006, 'plaster')
    if kind == 'shutter':
        # louvred shutters folded back flat against the wall either side
        for s in (-1, 1):
            x0 = s * (ow / 2 + 0.004)
            x1 = s * (ow / 2 + 0.004 + ow / 2)
            louvres(min(x0, x1), max(x0, x1), oz - 0.002, oz + rect_h + 0.002, -0.005, 'paint')
            for hz in (oz + 0.02, oz + rect_h - 0.02):
                box(0.012, 0.004, 0.004, (s * (ow / 2 + 0.002), -0.008, hz), 'iron')
    elif kind == 'closed':
        louvres(-ow / 2 + 0.002, -0.001, oz, oz + rect_h, fy - 0.014, 'paint')
        louvres(0.001, ow / 2 - 0.002, oz, oz + rect_h, fy - 0.014, 'paint')
    elif kind == 'grille':
        # an iron grille in front of the glass: bars, two rails, a row of scrolls on top
        for i in range(7):
            x = -ow / 2 + 0.008 + (ow - 0.016) * i / 6
            box(0.0035, 0.0035, rect_h - 0.004, (x, 0.006, oz + rect_h / 2), 'iron')
        for z in (oz + 0.012, oz + rect_h - 0.012, oz + rect_h * 0.78):
            box(ow - 0.004, 0.004, 0.004, (0, 0.006, z), 'iron')
        for i in range(3):
            x = -ow / 3 + ow / 3 * i
            torus(0.011, 0.0018, (x, 0.006, oz + rect_h * 0.89), 'iron', seg=16, cseg=4, rot=(math.pi / 2, 0, 0))
    elif kind == 'lattice':
        # a mashrabiya-style diagonal lattice over the glass (the bars run on into the wall body, where the
        # plaster face in front hides them)
        step = 0.016
        span = ow + 0.06
        for i in range(-14, 15):
            c = oz + i * step
            bar((-span / 2, c), (span / 2, c + span), fy - 0.006, 0.0028, 0.004, 'wood')
            bar((-span / 2, c + span), (span / 2, c), fy - 0.006, 0.0028, 0.004, 'wood')


def card_door(name, w, h, ow, oh, arch=False, kind='panel'):
    """A door: recessed opening down to the ground, panelled leaves (accent paint), a stone step."""
    bottom = card(name, w, h)
    oz = bottom + 0.012
    wall_with_opening(w, h, ow, oh, oz, arch)
    fy = 0.026
    frame_ring(ow, oh, oz, arch, fy, 0.012, 0.014, 'frame')
    rect_h = oh - (ow / 2 if arch else 0)
    leaves = 2 if kind in ('double', 'gate') else 1
    lw = (ow - 0.016) / leaves
    for i in range(leaves):
        x = -ow / 2 + 0.008 + lw * (i + 0.5)
        box(lw - 0.002, 0.012, rect_h - 0.006, (x, fy + 0.006, oz + rect_h / 2), 'paint', bv=0.001)
        # raised panels
        for pz in (0.28, 0.72) if kind != 'gate' else (0.5,):
            ph = (rect_h - 0.03) * (0.38 if kind != 'gate' else 0.85)
            box(lw * 0.62, 0.004, ph, (x, fy - 0.002, oz + rect_h * pz), 'paint', bv=0.0018, segs=1)
        if kind == 'gate':
            # studs in rows
            for sx in (-0.3, 0, 0.3):
                for sz in np.linspace(0.12, 0.88, 6):
                    sphere(0.0022, (x + sx * lw, fy - 0.003, oz + rect_h * sz), 'iron', seg=6, rings=4)
        # handle
        hx = x + (lw * 0.36 if i == 0 and leaves == 2 else -lw * 0.36 if leaves == 2 else lw * 0.36)
        box(0.004, 0.006, 0.022, (hx, fy - 0.004, oz + rect_h * 0.47), 'gold', bv=0.001)
    if arch:
        # fanlight: glass with a radial iron grille
        cy = oz + rect_h
        cyl(ow / 2 - 0.008, ow / 2 - 0.008, 0.004, (0, fy, cy), 'glass', seg=24, rot=(-math.pi / 2, 0, 0))
        for k in range(5):
            a = math.pi * (k + 0.5) / 5
            bar((0, cy), (math.cos(a) * (ow / 2 - 0.01), cy + math.sin(a) * (ow / 2 - 0.01)), fy - 0.003, 0.003, 0.003, 'iron')
        box(ow - 0.01, 0.006, 0.008, (0, fy - 0.002, cy), 'frame')
    # the step
    box(ow + 0.05, 0.03, 0.014, (0, -0.01, bottom + 0.007), 'stone', bv=0.002)
    # a lamp bracket beside the door on panelled doors
    if kind == 'panel':
        box(0.012, 0.016, 0.02, (ow / 2 + 0.022, -0.008, oz + oh * 0.82), 'iron', bv=0.002)


def card_shop(name, w, h):
    """A shop front: a wide opening, a half-rolled corrugated shutter, glazing with a door, a sign band."""
    bottom = card(name, w, h)
    ow, oh = w - 0.06, h - 0.07
    oz = bottom + 0.008
    wall_with_opening(w, h, ow, oh, oz)
    fy = 0.022
    # shutter box + the rolled-down part (corrugated)
    box(ow, 0.03, 0.03, (0, 0.004, oz + oh - 0.015), 'shutter', bv=0.003)
    roll = oh * 0.36
    z = oz + oh - 0.03
    while z > oz + oh - 0.03 - roll:
        box(ow - 0.006, 0.006, 0.006, (0, 0.012, z - 0.003), 'shutter', bv=0.0025)
        z -= 0.0062
    box(ow - 0.006, 0.01, 0.006, (0, 0.012, z), 'steel')
    # glazing below, a door off centre, a stall-riser
    gz = oz + 0.03
    gh = z - gz - 0.004
    box(ow - 0.01, 0.004, gh, (0, fy + 0.012, gz + gh / 2), 'glass')
    for x in (-ow / 2 + 0.006, -ow / 6, ow / 6, ow / 2 - 0.006):
        box(0.008, 0.01, gh, (x, fy + 0.006, gz + gh / 2), 'aluminium')
    box(ow - 0.006, 0.012, 0.03, (0, fy + 0.004, oz + 0.015), 'stone')
    # goods silhouettes inside (shelves)
    for i, zz in enumerate((0.25, 0.55)):
        box(ow * 0.8, 0.02, 0.004, (0, fy + 0.03, gz + gh * zz), 'wood_lt')
        for k in range(9):
            box(0.012, 0.012, 0.018 + (k % 3) * 0.006, (-ow * 0.38 + k * ow * 0.095, fy + 0.03, gz + gh * zz + 0.012), ('paint', 'stone', 'frame')[k % 3])
    # sign band (plain, no letters)
    box(ow + 0.02, 0.008, 0.03, (0, -0.004, oz + oh + 0.022), 'paint', bv=0.002)


def card_arch_open(name, w, h, depth=0.12):
    """An open arch (arcade / loggia bay): a deep dark passage, voussoir joints, a keystone."""
    bottom = card(name, w, h)
    ow, oh = w * 0.72, h * 0.86
    oz = bottom
    wall = box(w, depth + 0.02, h, (0, (depth + 0.02) / 2, 0), 'plaster')
    for c in opening_cutters(ow, oh, oz - 0.01, True, depth=depth + 0.2):
        cut(wall, c)
    box(w, 0.01, h, (0, depth + 0.05, 0), 'interior')
    box(w, depth + 0.1, 0.004, (0, depth / 2, bottom + 0.002), 'stone')
    # keystone + impost blocks
    box(0.02, 0.008, 0.026, (0, -0.004, oz + oh - 0.004), 'plaster', bv=0.002)
    for s in (-1, 1):
        box(0.03, 0.006, 0.01, (s * ow / 2, -0.003, oz + oh - ow / 2 - 0.005), 'plaster', bv=0.002)


def card_vent(name, w):
    card(name, w, w)
    ow = w * 0.6
    wall_with_opening(w, w, ow, ow, -ow / 2)
    box(ow, 0.004, ow, (0, 0.03, 0), 'dark')
    louvres(-ow / 2, ow / 2, -ow / 2, ow / 2, 0.012, 'frame', pitch=0.007, tilt=0.7, frame=0.004)


def build_cards():
    # (the card sizes are what the game places, in tiles; the opening sits in a thin plaster margin)
    card_window('win', 0.17, 0.24, 0.11, 0.15, -0.075)
    card_window('win_shut', 0.25, 0.24, 0.11, 0.15, -0.075, kind='shutter')
    card_window('win_closed', 0.17, 0.24, 0.11, 0.15, -0.075, kind='closed')
    card_window('win_grille', 0.17, 0.24, 0.11, 0.15, -0.075, kind='grille')
    card_window('win_arch', 0.17, 0.28, 0.11, 0.19, -0.095, arch=True)
    card_window('win_tall', 0.15, 0.36, 0.1, 0.27, -0.14, arch=True, kind='lattice')
    card_window('win_hotel', 0.2, 0.2, 0.15, 0.15, -0.075, kind='hotel', depth=0.024)
    card_window('door_hotel', 0.24, 0.26, 0.2, 0.22, -0.125, kind='hotel', depth=0.022)
    card_vent('vent', 0.08)
    card_door('door', 0.2, 0.32, 0.14, 0.27)
    card_door('door_arch', 0.28, 0.4, 0.2, 0.34, arch=True, kind='double')
    card_door('gate', 0.32, 0.26, 0.27, 0.235, kind='gate')
    card_shop('shop', 0.5, 0.3)
    card_arch_open('arch', 0.3, 0.3)


# ====================================================================== kit: 3D pieces

PIECES = {}  # name -> dict(lo=[lod0, lod1|None], hi=[...])


def piece(name):
    global HIGHS
    next_slot()
    HIGHS = []
    PIECES[name] = dict(hi=HIGHS, lo=[None, None])
    return PIECES[name]


def lowpoly(name, lod, objs):
    """Join low poly parts (built with hi=False) into the piece's LOD mesh."""
    o = C.join(objs, f'{name}' + ('' if lod == 0 else '_l1'))
    o.data.transform(o.matrix_world)
    o.data.transform(Matrix.Translation(-PIECE_OFF))
    o.matrix_world = Matrix.Translation(PIECE_OFF)
    smooth(o)
    PIECES[name]['lo'][lod] = o
    return o


def lo_box(sx, sy, sz, loc, rot=(0, 0, 0), bv=0.0):
    o = box(sx, sy, sz, loc, 'plaster', rot=rot, hi=False)
    if bv:
        bevel(o, bv, 1)
        apply_mods(o)
    return o


def lo_cyl(r1, r2, h, loc, seg, rot=(0, 0, 0), caps=True):
    return cyl(r1, r2, h, loc, 'plaster', seg=seg, rot=rot, hi=False, caps=caps)


def p_ac():
    piece('ac')
    W, D, H = 0.13, 0.05, 0.09
    box(W, D, H, (0, 0, H / 2 + 0.01), 'frame', bv=0.005)
    # fan opening: dark disc + grille rings + spokes, on the front (-y)
    fx = -0.022
    cyl(0.033, 0.033, 0.004, (fx, -D / 2 + 0.003, 0.01 + H / 2), 'dark', seg=32, rot=(math.pi / 2, 0, 0))
    for r in (0.008, 0.016, 0.024, 0.032):
        torus(r, 0.0013, (fx, -D / 2 - 0.0015, 0.01 + H / 2), 'steel', seg=24, cseg=4, rot=(math.pi / 2, 0, 0))
    for k in range(4):
        a = k * math.pi / 4
        box(0.066, 0.002, 0.002, (fx, -D / 2 - 0.0015, 0.01 + H / 2), 'steel', rot=(0, a, 0))
    # side fins (right), service cover, a pipe
    for i in range(9):
        box(0.004, 0.0015, H * 0.7, (0.022 + i * 0.0045, -D / 2 - 0.0008, 0.01 + H / 2), 'metal')
    box(0.02, 0.004, 0.03, (W / 2 - 0.012, -D / 2 - 0.001, 0.01 + H * 0.3), 'metal', bv=0.001)
    cyl(0.004, 0.004, 0.04, (W / 2 - 0.01, 0, 0.0), 'iron', seg=8, rot=(0, 0, 0))
    # wall brackets under it
    for s in (-1, 1):
        box(0.008, D + 0.01, 0.006, (s * W * 0.35, 0.004, 0.007), 'steel')
        box(0.008, 0.006, 0.03, (s * W * 0.35, D / 2 + 0.006, 0.0), 'steel')
    lowpoly('ac', 0, [lo_box(W, D, H, (0, 0, H / 2 + 0.01), bv=0.004)] + [lo_box(0.008, D + 0.01, 0.006, (s * W * 0.35, 0.004, 0.007)) for s in (-1, 1)])
    lowpoly('ac', 1, [lo_box(W, D, H, (0, 0, H / 2 + 0.01))])


def p_tank():
    piece('tank')
    R, H = 0.065, 0.13
    st = 0.04
    # the steel stand
    for sx in (-1, 1):
        for sy in (-1, 1):
            box(0.008, 0.008, st, (sx * 0.055, sy * 0.055, st / 2), 'steel')
    for s in (-1, 1):
        box(0.12, 0.008, 0.006, (0, s * 0.055, st - 0.003), 'steel')
        box(0.008, 0.12, 0.006, (s * 0.055, 0, st - 0.003), 'steel')
    # the ribbed plastic tank, a domed lid, a cap, the inlet pipe
    cyl(R, R, H, (0, 0, st), 'plastic', seg=32, bv=0.006)
    for z in np.linspace(st + 0.02, st + H - 0.025, 5):
        torus(R + 0.0008, 0.003, (0, 0, z), 'plastic', seg=32, cseg=6)
    sphere(R * 0.98, (0, 0, st + H - 0.001), 'plastic', seg=32, rings=12, scale=(1, 1, 0.32), hemi=True)
    cyl(0.022, 0.02, 0.012, (0, 0, st + H + R * 0.3 - 0.004), 'plastic', seg=16, bv=0.002)
    cyl(0.005, 0.005, 0.06, (R - 0.004, 0, st + H - 0.05), 'iron', seg=8, rot=(0, math.pi / 2, 0))
    lowpoly('tank', 0, [lo_cyl(R, R, H, (0, 0, st), 12), lo_cyl(R, R * 0.35, R * 0.34, (0, 0, st + H), 12)] + [lo_box(0.009, 0.009, st, (sx * 0.055, sy * 0.055, st / 2)) for sx in (-1, 1) for sy in (-1, 1)])
    lowpoly('tank', 1, [lo_cyl(R, R, H, (0, 0, st * 0.5), 6), lo_box(0.12, 0.12, st * 0.5, (0, 0, st * 0.25))])


def p_dish():
    piece('dish')
    # wall / roof mount pole, arm, LNB; the dish faces -y, tilted up
    cyl(0.005, 0.005, 0.07, (0, 0.01, 0), 'steel', seg=8)
    dish_r = 0.055
    d = sphere(dish_r * 2.2, (0, 0, 0), 'frame', seg=32, rings=16, scale=(1, 1, 1), hemi=False)
    d.location = Vector((0, 0, 0)) + PIECE_OFF
    # carve a shallow cap: keep only the part near the bottom pole of a large sphere
    bm = bmesh.new()
    bm.from_mesh(d.data)
    rr = dish_r * 2.2
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z > -rr + 0.012], context='VERTS')
    bmesh.ops.translate(bm, vec=(0, 0, rr), verts=bm.verts)
    bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=0.0025)
    bm.to_mesh(d.data)
    bm.free()
    d.rotation_euler = (math.radians(50), 0, 0)
    d.location = Vector((0, -0.006, 0.075)) + PIECE_OFF
    box(0.004, 0.06, 0.004, (0, -0.035, 0.07), 'steel', rot=(math.radians(-20), 0, 0))
    box(0.012, 0.014, 0.012, (0, -0.062, 0.062), 'iron', bv=0.002)
    lowpoly('dish', 0, [lo_cyl(dish_r, dish_r * 0.5, 0.012, (0, -0.006, 0.075), 10, rot=(math.radians(-130), 0, 0)), lo_box(0.006, 0.006, 0.07, (0, 0.01, 0.035)), lo_box(0.004, 0.06, 0.004, (0, -0.035, 0.07))])


def p_solar():
    piece('solar')
    # collector panel tilted towards the front (-y), white boiler cylinder at the top back, an A-frame
    pw, pl = 0.15, 0.12
    tilt = math.radians(38)
    pc = Vector((0, -0.01, 0.055))
    box(pw, pl, 0.008, pc, 'aluminium', rot=(tilt, 0, 0), bv=0.002)
    box(pw - 0.012, pl - 0.012, 0.002, pc + Vector((0, 0.0, 0.0)) + Vector((0, -math.sin(tilt) * 0.0045, math.cos(tilt) * 0.0045)), 'solar', rot=(tilt, 0, 0))
    for i in range(8):
        x = -pw / 2 + 0.012 + i * (pw - 0.024) / 7
        box(0.002, pl - 0.016, 0.002, (pc.x + x, pc.y - math.sin(tilt) * 0.006, pc.z + math.cos(tilt) * 0.006), 'aluminium', rot=(tilt, 0, 0))
    cyl(0.03, 0.03, 0.17, (-0.085, 0.045, 0.11), 'frame', seg=24, rot=(0, math.pi / 2, 0), bv=0.006)
    for s in (-1, 1):
        box(0.006, 0.006, 0.1, (s * 0.065, 0.045, 0.05), 'aluminium')
        box(0.006, 0.12, 0.006, (s * 0.065, 0.0, 0.004), 'aluminium')
        box(0.006, 0.006, 0.06, (s * 0.065, -0.04, 0.03), 'aluminium')
    lowpoly('solar', 0, [lo_box(pw, pl, 0.01, pc, rot=(tilt, 0, 0)), lo_cyl(0.03, 0.03, 0.17, (-0.085, 0.045, 0.11), 8, rot=(0, math.pi / 2, 0))] + [lo_box(0.006, 0.006, 0.1, (s * 0.065, 0.045, 0.05)) for s in (-1, 1)])
    lowpoly('solar', 1, [lo_box(pw, pl, 0.01, pc, rot=(tilt, 0, 0)), lo_cyl(0.03, 0.03, 0.17, (-0.085, 0.045, 0.11), 5, rot=(0, math.pi / 2, 0))])


def p_rail():
    piece('rail')
    L, H = 0.5, 0.1
    box(L, 0.012, 0.01, (0, 0, H - 0.005), 'iron', bv=0.003)
    box(L, 0.008, 0.006, (0, 0, 0.012), 'iron', bv=0.002)
    for i in range(10):
        x = -L / 2 + L * (i + 0.5) / 10
        box(0.005, 0.005, H - 0.02, (x, 0, H / 2), 'iron', bv=0.001)
        if i % 2 == 0:
            torus(0.012, 0.0016, (x + L / 20, 0, H * 0.55), 'iron', seg=12, cseg=4, rot=(math.pi / 2, 0, 0))
    box(0.012, 0.012, H, (-L / 2 + 0.006, 0, H / 2), 'iron', bv=0.002)
    lowpoly('rail', 0, [lo_box(L, 0.012, 0.01, (0, 0, H - 0.005)), lo_box(L, 0.008, 0.006, (0, 0, 0.012)), lo_box(0.012, 0.012, H, (-L / 2 + 0.006, 0, H / 2))] + [lo_box(0.005, 0.005, H - 0.02, (-L / 2 + L * (i + 0.5) / 10, 0, H / 2)) for i in range(1, 10, 2)])
    lowpoly('rail', 1, [lo_box(L, 0.012, 0.01, (0, 0, H - 0.005)), lo_box(0.012, 0.012, H, (-L / 2 + 0.006, 0, H / 2))])


def p_awning():
    piece('awning')
    W, D = 0.6, 0.18
    tilt = math.radians(20)
    # the fabric: alternating accent / white stripes, a scalloped valance, the steel arms
    n = 12
    for i in range(n):
        x = -W / 2 + W * (i + 0.5) / n
        m = 'fabric_acc' if i % 2 == 0 else 'fabric'
        box(W / n + 0.0005, D, 0.004, (x, -D / 2 * math.cos(tilt), -D / 2 * math.sin(tilt)), m, rot=(tilt, 0, 0))
        for k in range(2):
            xx = x - W / n / 4 + k * W / n / 2
            cyl(W / n / 4, W / n / 4, 0.003, (xx, -D * math.cos(tilt) - 0.001, -D * math.sin(tilt) - 0.024), m, seg=10, rot=(math.pi / 2, 0, 0))
        box(W / n + 0.0005, 0.003, 0.024, (x, -D * math.cos(tilt), -D * math.sin(tilt) - 0.012), m)
    for s in (-1, 1):
        box(0.006, D, 0.006, (s * (W / 2 - 0.02), -D / 2 * math.cos(tilt), -D / 2 * math.sin(tilt) - 0.005), 'steel', rot=(tilt, 0, 0))
    box(W, 0.012, 0.012, (0, 0, 0), 'steel', bv=0.003)
    lowpoly('awning', 0, [lo_box(W, D, 0.006, (0, -D / 2 * math.cos(tilt), -D / 2 * math.sin(tilt)), rot=(tilt, 0, 0)), lo_box(W, 0.004, 0.028, (0, -D * math.cos(tilt), -D * math.sin(tilt) - 0.014)), lo_box(W, 0.012, 0.012, (0, 0, 0))])
    lowpoly('awning', 1, [lo_box(W, D, 0.006, (0, -D / 2 * math.cos(tilt), -D / 2 * math.sin(tilt)), rot=(tilt, 0, 0))])


def p_dome():
    piece('dome')
    # a plaster dome (unit radius 0.25, the game scales it), a base lip, a small knob finial
    R = 0.25
    sphere(R, (0, 0, 0), 'plaster', seg=48, rings=24, hemi=True)
    torus(R + 0.004, 0.008, (0, 0, 0.006), 'plaster', seg=48, cseg=8)
    cyl(0.012, 0.004, 0.03, (0, 0, R - 0.002), 'gold', seg=12)
    sphere(0.009, (0, 0, R + 0.03), 'gold', seg=12, rings=8)
    def lo(seg, rings):
        o = sphere(R, (0, 0, 0), 'plaster', seg=seg, rings=rings, hemi=True, hi=False)
        return o
    lowpoly('dome', 0, [lo(16, 8), lo_cyl(R + 0.012, R + 0.012, 0.014, (0, 0, -0.001), 16, caps=False)])
    lowpoly('dome', 1, [lo(8, 4)])


def p_mosque_dome():
    piece('mdome')
    # the prayer hall's dome: an octagonal-to-round drum with 8 arched windows between pilasters, a moulded
    # cornice, the dome (slightly pointed, 24 ribs), a lantern finial with a crescent
    Rd, Hd = 0.44, 0.13
    cyl(Rd, Rd, Hd, (0, 0, 0), 'plaster', seg=64)
    cyl(Rd + 0.015, Rd + 0.015, 0.02, (0, 0, Hd - 0.005), 'plaster', seg=64, bv=0.004)
    cyl(Rd + 0.008, Rd + 0.008, 0.016, (0, 0, 0), 'plaster', seg=64)
    for k in range(8):
        a = (k + 0.5) * math.pi / 4
        # arched window: dark recess + frame, set into the drum
        c = Vector((math.cos(a) * (Rd - 0.004), math.sin(a) * (Rd - 0.004), 0))
        o = box(0.06, 0.01, 0.06, (c.x, c.y, 0.05), 'dark', rot=(0, 0, a + math.pi / 2))
        cyl(0.03, 0.03, 0.01, (c.x, c.y, 0.08), 'dark', seg=16, rot=(math.pi / 2, 0, a + math.pi / 2))
        # pilasters between windows
        b = k * math.pi / 4
        box(0.025, 0.012, Hd - 0.02, (math.cos(b) * (Rd + 0.004), math.sin(b) * (Rd + 0.004), Hd / 2), 'plaster', rot=(0, 0, b + math.pi / 2), bv=0.003)
        _ = o
    # the dome: a profile revolved (pointed at the top)
    prof = []
    N = 18
    for i in range(N + 1):
        t = i / N
        ang = t * math.pi / 2
        r = Rd * 0.97 * math.cos(ang) ** 0.92
        z = Rd * 1.08 * math.sin(ang) + (0.04 * t ** 6)
        prof.append((r, z))
    bm = bmesh.new()
    rings = []
    S = 64
    for (r, z) in prof:
        ring = []
        for j in range(S):
            a = 2 * math.pi * j / S
            rib = 1 + 0.012 * max(0, math.cos(a * 12)) ** 8 * (r / Rd)
            ring.append(bm.verts.new((r * rib * math.cos(a), r * rib * math.sin(a), z)))
        rings.append(ring)
    for i in range(N):
        for j in range(S):
            bm.faces.new((rings[i][j], rings[i][(j + 1) % S], rings[i + 1][(j + 1) % S], rings[i + 1][j]))
    place(from_bm('mdome_hi', bm, 'plaster'), (0, 0, Hd + 0.01))
    # finial: a lantern drum, a bulb, a pole and a crescent
    top = Hd + 0.01 + Rd * 1.08 + 0.04
    cyl(0.03, 0.026, 0.03, (0, 0, top - 0.02), 'plaster', seg=16)
    sphere(0.018, (0, 0, top + 0.03), 'gold', seg=16, rings=10)
    cyl(0.004, 0.003, 0.09, (0, 0, top + 0.04), 'gold', seg=8)
    torus(0.025, 0.004, (0, 0, top + 0.15), 'gold', seg=20, cseg=6, rot=(math.pi / 2, 0, math.pi / 2), arc=math.pi * 1.4)

    def lo_dome(seg, n):
        bm = bmesh.new()
        rr = []
        for i in range(n + 1):
            t = i / n
            ang = t * math.pi / 2
            r = Rd * 0.97 * math.cos(ang) ** 0.92
            z = Rd * 1.08 * math.sin(ang) + 0.04 * t ** 6
            rr.append([bm.verts.new((r * math.cos(2 * math.pi * j / seg), r * math.sin(2 * math.pi * j / seg), z)) for j in range(seg)] if i < n else [bm.verts.new((0, 0, z))])
        for i in range(n):
            for j in range(seg):
                if i < n - 1:
                    bm.faces.new((rr[i][j], rr[i][(j + 1) % seg], rr[i + 1][(j + 1) % seg], rr[i + 1][j]))
                else:
                    bm.faces.new((rr[i][j], rr[i][(j + 1) % seg], rr[i + 1][0]))
        return place(from_bm('mdl', bm, 'plaster'), (0, 0, Hd + 0.01), hi=False)
    lowpoly('mdome', 0, [lo_cyl(Rd + 0.01, Rd + 0.01, Hd + 0.012, (0, 0, 0), 24, caps=False), lo_dome(24, 6), lo_cyl(0.03, 0.026, 0.05, (0, 0, top - 0.02), 6), lo_box(0.006, 0.006, 0.16, (0, 0, top + 0.1)), lo_box(0.05, 0.004, 0.05, (0, 0, top + 0.15))])
    lowpoly('mdome', 1, [lo_cyl(Rd + 0.01, Rd + 0.01, Hd + 0.012, (0, 0, 0), 12, caps=False), lo_dome(12, 3), lo_box(0.006, 0.006, 0.2, (0, 0, top + 0.08))])


def p_minaret():
    piece('minaret')
    # a square base with arched blind panels; an octagonal shaft with tall arched panels and string courses;
    # a corbelled (muqarnas) balcony with a balustrade; a slimmer upper shaft with windows; a cornice, a
    # small ribbed dome and a crescent finial. Height to the crescent ~2.07 (the old procedural one's).
    B = 0.32
    box(B, B, 0.3, (0, 0, 0.15), 'plaster', bv=0.006)
    box(B + 0.02, B + 0.02, 0.02, (0, 0, 0.3), 'plaster', bv=0.004)
    for k in range(4):
        a = k * math.pi / 2
        n = Vector((math.cos(a), math.sin(a), 0))
        for s in (-1, 1):
            t = Vector((-n.y, n.x, 0)) * (s * 0.07)
            c = n * (B / 2 - 0.003) + t
            box(0.045, 0.008, 0.12, (c.x, c.y, 0.12), 'dark', rot=(0, 0, a + math.pi / 2))
            cyl(0.0225, 0.0225, 0.008, (c.x, c.y, 0.18), 'dark', seg=12, rot=(math.pi / 2, 0, a + math.pi / 2))
    # octagonal shaft (tapering), string courses, arched panels
    z0, z1 = 0.31, 1.43
    cyl(0.13, 0.115, z1 - z0, (0, 0, z0), 'plaster', seg=8)
    for z in (0.62, 1.02):
        f = (z - z0) / (z1 - z0)
        r = 0.13 + (0.115 - 0.13) * f
        cyl(r + 0.012, r + 0.012, 0.016, (0, 0, z), 'plaster', seg=8, bv=0.003)
    for k in range(8):
        a = (k + 0.5) * math.pi / 4
        for (za, zb) in ((0.36, 0.6), (0.66, 1.0), (1.06, 1.38)):
            zm = (za + zb) / 2
            f = (zm - z0) / (z1 - z0)
            r = (0.13 + (0.115 - 0.13) * f) * math.cos(math.pi / 8) - 0.003
            c = Vector((math.cos(a) * r, math.sin(a) * r, 0))
            wdt = 0.05
            box(wdt, 0.008, zb - za - wdt / 2, (c.x, c.y, za + (zb - za - wdt / 2) / 2), 'dark' if za > 1.0 else 'plaster', rot=(0, 0, a + math.pi / 2))
            cyl(wdt / 2, wdt / 2, 0.008, (c.x, c.y, zb - wdt / 2), 'dark' if za > 1.0 else 'plaster', seg=12, rot=(math.pi / 2, 0, a + math.pi / 2))
            if za < 1.0:
                # blind panel: a slightly recessed field with a frame
                box(wdt * 0.7, 0.01, zb - za - wdt, (c.x * 0.99, c.y * 0.99, za + (zb - za - wdt) / 2 + 0.01), 'plaster', rot=(0, 0, a + math.pi / 2))
    # the muqarnas corbel: stepped rings of little niches growing out to the balcony
    zc = 1.43
    for i, (r, h) in enumerate(((0.125, 0.025), (0.14, 0.025), (0.158, 0.025), (0.176, 0.02))):
        cyl(r, r, h, (0, 0, zc + i * 0.022), 'plaster', seg=16)
        segs = 16
        for k in range(segs):
            a = (k + (0.5 if i % 2 else 0)) * 2 * math.pi / segs
            c = Vector((math.cos(a) * (r + 0.002), math.sin(a) * (r + 0.002), 0))
            box(0.02, 0.006, h * 0.7, (c.x, c.y, zc + i * 0.022 + h * 0.4), 'dark', rot=(0, 0, a + math.pi / 2))
    zb = zc + 0.088
    cyl(0.19, 0.19, 0.016, (0, 0, zb), 'plaster', seg=24, bv=0.004)
    # balustrade
    for k in range(24):
        a = k * 2 * math.pi / 24
        box(0.008, 0.008, 0.06, (math.cos(a) * 0.182, math.sin(a) * 0.182, zb + 0.046), 'plaster', bv=0.002)
    torus(0.182, 0.007, (0, 0, zb + 0.078), 'plaster', seg=32, cseg=6)
    # upper shaft with small arched windows, cornice, dome, finial
    cyl(0.085, 0.078, 0.26, (0, 0, zb + 0.016), 'plaster', seg=16)
    for k in range(4):
        a = k * math.pi / 2 + math.pi / 4
        c = Vector((math.cos(a) * 0.08, math.sin(a) * 0.08, 0))
        box(0.03, 0.01, 0.07, (c.x, c.y, zb + 0.13), 'dark', rot=(0, 0, a + math.pi / 2))
        cyl(0.015, 0.015, 0.01, (c.x, c.y, zb + 0.165), 'dark', seg=10, rot=(math.pi / 2, 0, a + math.pi / 2))
    zt = zb + 0.276
    cyl(0.1, 0.1, 0.03, (0, 0, zt), 'plaster', seg=16, bv=0.005)
    for k in range(16):
        a = k * 2 * math.pi / 16
        box(0.01, 0.01, 0.012, (math.cos(a) * 0.098, math.sin(a) * 0.098, zt - 0.004), 'plaster')
    sphere(0.085, (0, 0, zt + 0.03), 'tile_g', seg=24, rings=12, scale=(1, 1, 1.5), hemi=True)
    cyl(0.005, 0.004, 0.1, (0, 0, zt + 0.15), 'gold', seg=8)
    sphere(0.014, (0, 0, zt + 0.17), 'gold', seg=12, rings=8)
    torus(0.022, 0.0035, (0, 0, zt + 0.23), 'gold', seg=20, cseg=6, rot=(math.pi / 2, 0, math.pi / 2), arc=math.pi * 1.4)

    def lo_parts(oseg, rseg):
        ps = [lo_box(B, B, 0.31, (0, 0, 0.155)), lo_cyl(0.13, 0.115, z1 - z0, (0, 0, z0), 8, caps=False),
              lo_cyl(0.125, 0.19, 0.09, (0, 0, zc), rseg), lo_cyl(0.19, 0.19, 0.016, (0, 0, zb), rseg)]
        if oseg:
            ps.append(lo_cyl(0.186, 0.186, 0.08, (0, 0, zb + 0.016), rseg, caps=False))
        ps += [lo_cyl(0.085, 0.078, 0.26, (0, 0, zb + 0.016), rseg, caps=False), lo_cyl(0.1, 0.1, 0.03, (0, 0, zt), rseg)]
        dome = sphere(0.085, (0, 0, zt + 0.03), 'plaster', seg=rseg, rings=max(3, rseg // 3), scale=(1, 1, 1.5), hemi=True, hi=False)
        ps += [dome, lo_box(0.006, 0.006, 0.26, (0, 0, zt + 0.16)), lo_box(0.05, 0.004, 0.05, (0, 0, zt + 0.23))]
        return ps
    lowpoly('minaret', 0, lo_parts(True, 16))
    lowpoly('minaret', 1, lo_parts(False, 8))


def p_merlon():
    piece('merlon')
    # a stepped (Mamluk-style) merlon on a parapet
    box(0.06, 0.03, 0.03, (0, 0, 0.015), 'plaster', bv=0.003)
    box(0.04, 0.026, 0.025, (0, 0, 0.042), 'plaster', bv=0.003)
    box(0.02, 0.022, 0.02, (0, 0, 0.064), 'plaster', bv=0.003)
    lowpoly('merlon', 0, [lo_box(0.06, 0.03, 0.03, (0, 0, 0.015)), lo_box(0.04, 0.026, 0.025, (0, 0, 0.0425)), lo_box(0.02, 0.022, 0.02, (0, 0, 0.065))])


def p_table():
    piece('table')
    # a cafe table, two chairs and a parasol (the canopy takes the accent colour)
    cyl(0.05, 0.05, 0.008, (0, 0, 0.105), 'frame', seg=24, bv=0.002)
    cyl(0.006, 0.006, 0.1, (0, 0, 0.005), 'steel', seg=8)
    cyl(0.025, 0.025, 0.006, (0, 0, 0), 'steel', seg=12)
    for s in (-1, 1):
        x = s * 0.085
        box(0.045, 0.045, 0.006, (x, 0, 0.055), 'wood_lt', bv=0.002)
        box(0.006, 0.045, 0.05, (x + s * 0.02, 0, 0.083), 'wood_lt', bv=0.002)
        for dx in (-0.018, 0.018):
            for dy in (-0.018, 0.018):
                box(0.004, 0.004, 0.055, (x + dx, dy, 0.027), 'steel')
    cyl(0.004, 0.004, 0.3, (0, 0, 0.11), 'wood', seg=8)
    cyl(0.17, 0.008, 0.07, (0, 0, 0.29), 'fabric_acc', seg=8, caps=False)
    for k in range(8):
        a = k * math.pi / 4
        box(0.004, 0.17, 0.003, (math.cos(a) * 0.085, math.sin(a) * 0.085, 0.322), 'wood', rot=(0, 0, a - math.pi / 2))
    lowpoly('table', 0, [lo_cyl(0.05, 0.05, 0.01, (0, 0, 0.104), 8), lo_box(0.008, 0.008, 0.11, (0, 0, 0.055)), lo_box(0.045, 0.045, 0.055, (-0.085, 0, 0.0275)), lo_box(0.045, 0.045, 0.055, (0.085, 0, 0.0275)),
                          lo_box(0.006, 0.006, 0.3, (0, 0, 0.26)), lo_cyl(0.17, 0.008, 0.07, (0, 0, 0.29), 8, caps=False)])
    lowpoly('table', 1, [lo_box(0.006, 0.006, 0.3, (0, 0, 0.15)), lo_cyl(0.17, 0.008, 0.07, (0, 0, 0.29), 6, caps=False)])


def p_kiosk():
    piece('kiosk')
    # a promenade kiosk: a white booth with a serving hatch (counter, half-rolled shutter), a striped awning,
    # a plain menu board (no lettering), a cooler and a roof sign box (plain)
    W, D, H = 0.5, 0.36, 0.32
    box(W, D, H, (0, 0, H / 2), 'frame', bv=0.008)
    box(W + 0.02, D + 0.02, 0.02, (0, 0, H + 0.005), 'aluminium', bv=0.004)
    # hatch: dark interior, counter, shutter
    box(W * 0.7, 0.01, 0.13, (0, -D / 2 - 0.0, 0.2), 'interior')
    box(W * 0.74, 0.06, 0.012, (0, -D / 2 - 0.02, 0.135), 'stone', bv=0.003)
    for i in range(6):
        box(W * 0.7, 0.006, 0.006, (0, -D / 2 - 0.004, 0.26 - i * 0.0065), 'shutter', bv=0.002)
    for k in range(5):
        box(0.025, 0.02, 0.03 + (k % 2) * 0.01, (-0.12 + k * 0.06, -D / 2 + 0.03, 0.16), ('paint', 'frame', 'gold')[k % 3])
    # menu board on the side, cooler
    box(0.01, 0.12, 0.09, (W / 2 + 0.006, -0.04, 0.2), 'dark', bv=0.002)
    box(0.012, 0.13, 0.1, (W / 2 + 0.004, -0.04, 0.2), 'wood', bv=0.002)
    box(0.12, 0.08, 0.1, (-W / 2 - 0.07, -0.05, 0.05), 'paint', bv=0.006)
    box(0.1, 0.004, 0.06, (-W / 2 - 0.07, -0.091, 0.06), 'glass')
    # awning over the hatch (stripes)
    n = 10
    for i in range(n):
        x = -W / 2 + W * (i + 0.5) / n
        box(W / n + 0.0005, 0.14, 0.004, (x, -D / 2 - 0.065, 0.3), 'fabric_acc' if i % 2 == 0 else 'fabric', rot=(math.radians(18), 0, 0))
    lowpoly('kiosk', 0, [lo_box(W, D, H, (0, 0, H / 2)), lo_box(W + 0.02, D + 0.02, 0.02, (0, 0, H + 0.005)), lo_box(W * 0.74, 0.06, 0.012, (0, -D / 2 - 0.02, 0.135)),
                          lo_box(W, 0.14, 0.004, (0, -D / 2 - 0.065, 0.3), rot=(math.radians(18), 0, 0)), lo_box(0.12, 0.08, 0.1, (-W / 2 - 0.07, -0.05, 0.05)), lo_box(0.012, 0.13, 0.1, (W / 2 + 0.004, -0.04, 0.2))])
    lowpoly('kiosk', 1, [lo_box(W, D, H, (0, 0, H / 2)), lo_box(W, 0.14, 0.004, (0, -D / 2 - 0.065, 0.3), rot=(math.radians(18), 0, 0))])


SWATCHES = ['frame', 'wood', 'wood_lt', 'metal', 'steel', 'iron', 'stone', 'glass', 'paint', 'plaster', 'dark', 'fabric', 'fabric_acc', 'aluminium', 'thatch', 'gold']


def build_swatches():
    for s in SWATCHES:
        card('sw_' + s, 0.05, 0.05)
        box(0.07, 0.01, 0.07, (0, 0.005, 0), s)


def build_pieces():
    for f in (p_ac, p_tank, p_dish, p_solar, p_rail, p_awning, p_dome, p_mosque_dome, p_minaret, p_merlon, p_table, p_kiosk):
        f()


# ====================================================================== kit: atlas layout + UVs

DENS_CARD = 520.0  # px per tile on the wall cards
DENS_PIECE = 300.0
DENS_L1 = 150.0
PAD = 6


def surface_area(o):
    return sum(p.area for p in o.data.polygons) * max(o.scale) ** 2


def layout_atlas():
    """Rects (px) for every card, swatch and piece LOD, shelf-packed into ATLAS; densities shrink until it fits."""
    k = 1.0
    while True:
        items = []
        for n, c in CARDS.items():
            w, h = c['size']
            d = (40.0 / 0.05) if n.startswith('sw_') else DENS_CARD * k
            if n.startswith('sw_'):
                items.append((n, 20, 20))
            else:
                items.append((n, max(8, int(w * d)), max(8, int(h * d))))
        for n, p in PIECES.items():
            for lod, o in enumerate(p['lo']):
                if o is None:
                    continue
                d = (DENS_PIECE if lod == 0 else DENS_L1) * k
                side = int(math.sqrt(surface_area(o) * 1.7) * d) + 4
                items.append((n + ('' if lod == 0 else '_l1'), max(12, side), max(12, side)))
        items.sort(key=lambda t: -t[2])
        rects = {}
        x = y = row = 0
        ok = True
        for n, w, h in items:
            if x + w + PAD > ATLAS:
                x = 0
                y += row + PAD
                row = 0
            if y + h + PAD > ATLAS:
                ok = False
                break
            rects[n] = (x + PAD // 2, y + PAD // 2, w, h)
            x += w + PAD
            row = max(row, h)
        if ok:
            log('atlas layout at density x', round(k, 3), 'rows to', y + row)
            return rects
        k *= 0.94


def set_card_uv(o, r):
    """Card quad corners -> its rect (Blender UV: v up)."""
    x, y, w, h = r
    me = o.data
    uv = me.uv_layers.new(name='UVMap')
    for poly in me.polygons:
        for li in poly.loop_indices:
            v = me.vertices[me.loops[li].vertex_index].co
            cw, ch = 1.0, 1.0
            _ = cw, ch
            # local x in -w/2..w/2, z in -h/2..h/2 (the object's own scale is 1)
            xs = [vv.co.x for vv in me.vertices]
            zs = [vv.co.z for vv in me.vertices]
            u = (v.x - min(xs)) / (max(xs) - min(xs))
            t = (v.z - min(zs)) / (max(zs) - min(zs))
            uv.data[li].uv = ((x + u * w) / ATLAS, 1 - (y + (1 - t) * h) / ATLAS)


def unwrap_into(o, r):
    """Smart-project one piece LOD and fit its islands into rect r."""
    me = o.data
    while len(me.uv_layers):
        me.uv_layers.remove(me.uv_layers[0])
    me.uv_layers.new(name='UVMap')
    C.select([o], o)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    t0 = time.time()
    bpy.ops.uv.smart_project(angle_limit=math.radians(55), island_margin=0.02, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    log('unwrap', o.name, len(me.polygons), 'faces', round(time.time() - t0, 2), 's')
    x, y, w, h = r
    uv = me.uv_layers[0]
    for d in uv.data:
        u, v = d.uv
        d.uv = ((x + u * w) / ATLAS, 1 - (y + (1 - v) * h) / ATLAS)


# ====================================================================== kit: bake

def bake_all(rects):
    sc = SC
    # a world for AO, short AO distance (tile units)
    w = bpy.data.worlds.new('w')
    sc.world = w
    w.light_settings.distance = 0.06
    imgs = {k: C.new_image('atlas_' + k, ATLAS, data=True, float_buf=True) for k in ('normal', 'ao', 'albedo', 'mask')}
    bm = C.bake_material('bake_target')
    cards = [c['lo'] for n, c in CARDS.items()]
    pieces = [o for p in PIECES.values() for o in p['lo'] if o is not None]
    for o in cards + pieces:
        o.data.materials.clear()
        o.data.materials.append(bm)
    hi_of = {}
    for c in CARDS.values():
        hi_of[c['lo'].name] = c['hi']
    for p in PIECES.values():
        for o in p['lo']:
            if o is not None:
                hi_of[o.name] = p['hi']
    # one bake per group: the lows joined into one object (copies; the pieces sit 3 tiles apart, far beyond the
    # ray distance, so no ray reaches a neighbour), all their highs selected
    def joined(objs, name):
        cs = []
        for o in objs:
            c = o.copy()
            c.data = o.data.copy()
            link(c)
            cs.append(c)
        return C.join(cs, name)
    jc = joined(cards, 'bake_cards')
    jp = joined(pieces, 'bake_pieces')
    groups = [(jc, [h for lo in cards for h in hi_of[lo.name]], 0.03, 0.12), (jp, list({id(h): h for lo in pieces for h in hi_of[lo.name]}.values()), 0.015, 0.05)]
    for kind, img_key, samples in (('NORMAL', 'normal', 4), ('AO', 'ao', 48), ('EMIT', 'albedo', 4), ('EMIT', 'mask', 4)):
        if kind == 'EMIT':
            set_emit('albedo' if img_key == 'albedo' else 'mask')
        C.set_target(bm, imgs[img_key])
        sc.cycles.samples = samples
        first = True
        t0 = time.time()
        for lo, hs, ext, ray in groups:
            keep = set(hs) | {lo}
            for o in sc.objects:
                if o.type == 'MESH':
                    o.hide_render = o not in keep
            # the low poly must not shadow its own high poly's AO
            for attr in ('visible_diffuse', 'visible_glossy', 'visible_transmission', 'visible_shadow', 'visible_volume_scatter'):
                setattr(lo, attr, False)
            C.select(hs + [lo], lo)
            bpy.ops.object.bake(type=kind, use_clear=first, margin=4, margin_type='EXTEND', use_selected_to_active=True, cage_extrusion=ext, max_ray_distance=ray, normal_space='TANGENT', target='IMAGE_TEXTURES')
            first = False
        log('baked', kind, img_key, round(time.time() - t0, 1), 's')
    for o in sc.objects:
        o.hide_render = False
    return {k: C.pixels(v)[..., :4] for k, v in imgs.items()}


def compose(px, rects):
    nrm = px['normal'][..., :3]
    ao = np.clip(px['ao'][..., 0], 0, 1)
    alb = px['albedo'][..., :3]
    msk = px['mask'][..., :3]
    # uncovered texels: flat normal, white AO
    cover = alb.sum(-1) > 1e-7
    nrm = np.where(cover[..., None], nrm, np.array([0.5, 0.5, 1.0]))
    ao = np.where(cover, ao, 1.0)
    # soften the AO a touch (48 samples), keep a floor; part of it goes into the albedo (the recesses must read
    # under direct sun too, the AO map only darkens the ambient light)
    ao_s = np.clip(C.blur(ao, 1) * 0.85 + ao * 0.15, 0, 1)
    ao_s = 0.12 + 0.88 * ao_s
    alb_ao = alb * (0.45 + 0.55 * ao_s[..., None])
    orm = np.stack([ao_s, msk[..., 0], msk[..., 1], msk[..., 2]], -1)
    C.save_rgb(os.path.join(OUT, 'atlas-albedo.png'), C.lin2srgb(alb_ao), ATLAS)
    C.save_rgb(os.path.join(OUT, 'atlas-normal.png'), nrm, ATLAS)
    C.save_rgb(os.path.join(OUT, 'atlas-orm.png'), orm[..., :3], ATLAS)


def export(rects):
    lows = []
    for n, p in PIECES.items():
        for lod, o in enumerate(p['lo']):
            if o is None:
                continue
            o.location = (0, 0, 0)
            o.data.materials.clear()
            lows.append(o)
    C.select(lows)
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'sinai-kit-raw.glb'), export_format='GLB', use_selection=True, export_materials='NONE', export_vertex_color='NONE', export_normals=True,
                              export_texcoords=True, export_apply=True, export_yup=True)
    man = {'atlas': ATLAS, 'plasterTile': PLASTER_TILE, 'cards': {}, 'swatches': {}, 'pieces': {}}
    for n, c in CARDS.items():
        x, y, w, h = rects[n]
        r = [round(x / ATLAS, 5), round(y / ATLAS, 5), round((x + w) / ATLAS, 5), round((y + h) / ATLAS, 5)]  # glTF uv: v down from the top
        if n.startswith('sw_'):
            man['swatches'][n[3:]] = [round((x + w / 2) / ATLAS, 5), round((y + h / 2) / ATLAS, 5)]
        else:
            man['cards'][n] = {'uv': r, 'size': [round(c['size'][0], 4), round(c['size'][1], 4)]}
    for n, p in PIECES.items():
        man['pieces'][n] = [C.tris(o) for o in p['lo'] if o is not None]
    with open(os.path.join(OUT, 'sinai-kit.json'), 'w') as f:
        json.dump(man, f, indent=1, sort_keys=True)
    log('pieces', man['pieces'])


def build_kit():
    global SC
    SC = C.reset(threads=3)
    t0 = time.time()
    build_cards()
    log('cards built', round(time.time() - t0, 1), 's')
    build_swatches()
    build_pieces()
    log('pieces built', round(time.time() - t0, 1), 's')
    # smooth shading by angle on the high polys (curved parts bake smooth normals)
    t0 = time.time()
    for o in [o for c in CARDS.values() for o in c['hi']] + [o for p in PIECES.values() for o in p['hi']]:
        smooth(o)
    log('smoothed', round(time.time() - t0, 1), 's')
    log('cards', len(CARDS), 'pieces', len(PIECES), 'high objects', sum(len(c['hi']) for c in CARDS.values()) + sum(len(p['hi']) for p in PIECES.values()))
    rects = layout_atlas()
    for n, c in CARDS.items():
        set_card_uv(c['lo'], rects[n])
    for n, p in PIECES.items():
        for lod, o in enumerate(p['lo']):
            if o is not None:
                unwrap_into(o, rects[n + ('' if lod == 0 else '_l1')])
    if os.environ.get('SINAI_NOBAKE'):
        return
    # the raw passes are kept (build/sinai/raw-*.npy): SINAI_REUSE=1 composes again without baking
    raw = {k: os.path.join(OUT, f'raw-{k}.npy') for k in ('normal', 'ao', 'albedo', 'mask')}
    if os.environ.get('SINAI_REUSE') and all(os.path.exists(f) for f in raw.values()):
        px = {k: np.load(f) for k, f in raw.items()}
    else:
        px = bake_all(rects)
        for k, f in raw.items():
            np.save(f, px[k].astype(np.float32))
    compose(px, rects)
    export(rects)


def preview(path, which='hi', cell=220):
    """Contact sheet: every card / piece rendered on its own (Cycles, low samples) - a check of the models."""
    sc = SC
    for m in bpy.data.materials:
        k = m.get('kit')
        if not k:
            continue
        hexv, rough, cls, glass = MATS[k]
        nt = m.node_tree
        bs = nt.nodes.get('Principled BSDF') or nt.nodes.new('ShaderNodeBsdfPrincipled')
        c = C.hexlin(hexv)
        if cls > 0.9:
            c = C.hexlin(0x3a6fa8)
        bs.inputs['Base Color'].default_value = (float(c[0]), float(c[1]), float(c[2]), 1)
        bs.inputs['Roughness'].default_value = rough
        out = [n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL']
        out = out[0] if out else nt.nodes.new('ShaderNodeOutputMaterial')
        nt.links.new(bs.outputs[0], out.inputs[0])
    w = bpy.data.worlds.new('pw')
    sc.world = w
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs[0].default_value = (0.55, 0.6, 0.7, 1)
    w.node_tree.nodes['Background'].inputs[1].default_value = 0.6
    sun = link(bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')))
    sun.data.energy = 4
    sun.rotation_euler = (math.radians(50), 0, math.radians(-35))
    cam = link(bpy.data.objects.new('cam', bpy.data.cameras.new('cam')))
    cam.data.type = 'ORTHO'
    sc.camera = cam
    sc.cycles.samples = 12
    sc.render.resolution_x = sc.render.resolution_y = cell
    sc.render.film_transparent = False
    groups = [(n, c['hi'] if which == 'hi' else [c['lo']]) for n, c in CARDS.items() if not n.startswith('sw_')]
    groups += [(n, p['hi'] if which == 'hi' else [o for o in p['lo'] if o]) for n, p in PIECES.items()]
    tiles = []
    for n, objs in groups:
        for o in sc.objects:
            if o.type == 'MESH':
                o.hide_render = o not in objs
        lo = Vector((1e9,) * 3)
        hi = Vector((-1e9,) * 3)
        for o in objs:
            for corner in o.bound_box:
                p = o.matrix_world @ Vector(corner)
                lo = Vector(map(min, lo, p))
                hi = Vector(map(max, hi, p))
        ctr = (lo + hi) / 2
        size = max(hi - lo)
        d = Vector((-0.45, -1.0, 0.55)).normalized()
        cam.location = ctr + d * (size * 3 + 1)
        cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
        cam.data.ortho_scale = size * 1.35
        f = os.path.join(OUT, f'pv_{n}.png')
        sc.render.filepath = f
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(f)
        tiles.append(C.pixels(img)[..., :3].copy())
        bpy.data.images.remove(img)
        os.remove(f)
    cols = 8
    rows = (len(tiles) + cols - 1) // cols
    sheet = np.ones((rows * cell, cols * cell, 3), np.float32)
    for i, t in enumerate(tiles):
        r, c = i // cols, i % cols
        sheet[(rows - 1 - r) * cell:(rows - r) * cell, c * cell:(c + 1) * cell] = t
    img = bpy.data.images.new('sheet', cols * cell, rows * cell, alpha=False)
    a = np.ones((rows * cell, cols * cell, 4), np.float32)
    a[..., :3] = sheet
    img.pixels.foreach_set(a.ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    log('preview', path, [n for n, _ in groups])


if STAGE in ('plaster', 'all'):
    C.reset()
    build_plaster()
if STAGE in ('kit', 'all'):
    build_kit()
if STAGE in ('preview', 'preview-lo'):
    os.environ['SINAI_NOBAKE'] = '1'
    build_kit()
    preview(os.path.join(OUT, 'preview-' + ('hi' if STAGE == 'preview' else 'lo') + '.png'), 'hi' if STAGE == 'preview' else 'lo')
log('done')
