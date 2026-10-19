# Blender 5.2.2 (LTS) - burnt-out vehicle hulks (CF1: combat effects; render only).
#
#   nice -n 10 /opt/blender/blender -b --factory-startup -P web/tools/blender/hulkkit.py -- <out_dir> [preview=1]
#   (or web/tools/blender/bake-hulks.sh, which also packs the GLB into public/models/hulks.glb)
#
# Faction-neutral, burnt, twisted wrecks per vehicle class, modelled as dense meshes, crumpled (numpy dents, buckled
# panels, a penetration crater where the killing round hit, a drooping gun), baked and reduced to one level of
# detail each (src/render/hulkkit.ts swaps them in for the dead vehicle's model, scars.ts keeps them):
#   mbt        main battle tank: turret knocked askew on its ring, gun drooping, one track thrown off, skirts torn
#   mbt_open   the same hull with the turret blown off (an open, glowing turret ring)
#   mbt_turret the blown-off turret on its own (thrown by the ammunition cook-off, lies where it lands)
#   ifv        infantry fighting vehicle: small turret, rear ramp dropped open, a track thrown
#   ifv_open   the same with the turret gone
#   ifv_turret its turret
#   truck      wheeled truck: burnt-out cab (no glass, roof caved in), tyres burnt off to the rims, a wheel gone, the
#              bed's side boards bent or missing, the frame sagging on the broken corner
#   harv       harvester: the hopper caved in, the boom fallen, tracks
# No UVs or textures: the game's hulk shader (scarsmesh.ts) draws charred steel, rust, grey ash and the embers of a
# smouldering wreck from the per-vertex colour (baked on the dense mesh before the reduction):
#   R  ambient occlusion (Cycles bake, with a ground plane for the contact shadow)
#   G  rust / ash mask (top faces, convex edges, broken metal)
#   B  ember mask (where the fire keeps glowing as the wreck smoulders: engine deck, open hatches, the turret ring,
#      the penetration crater, the cab, the bed)
# Units: one game tile; Blender X = forward, -Y = right, Z = up (the glTF export maps it to the game's +X forward, +Y
# up, +Z right). Every piece sits on the ground (z = 0) around its own origin; the game fits it to the dead model's
# footprint. Output: <out>/hulks-raw.glb, <out>/hulks.json (triangles) and with preview=1 a Cycles contact sheet.
import bpy
import bmesh
import json
import math
import os
import sys
import time

import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import fbm, vnoise  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else '/tmp/hulkkit'
PREVIEW = len(argv) > 1 and argv[1] == '1'
os.makedirs(OUT, exist_ok=True)

# key: triangle budget of the reduced mesh
KIT = {
    'mbt': 1700,
    'mbt_open': 1400,
    'mbt_turret': 420,
    'ifv': 1500,
    'ifv_open': 1300,
    'ifv_turret': 260,
    'truck': 1500,
    'harv': 1700,
}


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.render.threads_mode = 'FIXED'
    sc.render.threads = 3
    sc.view_settings.view_transform = 'Standard'
    return sc


def get_co(o):
    a = np.zeros(len(o.data.vertices) * 3)
    o.data.vertices.foreach_get('co', a)
    return a.reshape(-1, 3)


def set_co(o, co):
    o.data.vertices.foreach_set('co', co.ravel())
    o.data.update()


def vnormals(o):
    o.data.update()
    a = np.zeros(len(o.data.vertices) * 3)
    o.data.vertices.foreach_get('normal', a)
    return a.reshape(-1, 3)


def apply_mod(o, kind, **kw):
    m = o.modifiers.new('m', kind)
    for k, v in kw.items():
        setattr(m, k, v)
    bpy.context.view_layer.objects.active = o
    for ob in bpy.context.selected_objects:
        ob.select_set(False)
    o.select_set(True)
    bpy.ops.object.modifier_apply(modifier=m.name)


def mesh_obj(name, bm):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def box(name, x0, x1, y0, y1, z0, z1, cuts=10, taper=None):
    """A box subdivided into a grid (dense enough to dent). taper(co) may reshape the vertices (n, 3) in place."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=cuts, use_grid_fill=True)
    for v in bm.verts:
        x, y, z = v.co
        v.co = Vector((x0 + (x + 0.5) * (x1 - x0), y0 + (y + 0.5) * (y1 - y0), z0 + (z + 0.5) * (z1 - z0)))
    o = mesh_obj(name, bm)
    if taper:
        co = get_co(o)
        taper(co)
        set_co(o, co)
    return o


def cyl(name, r, depth, at, axis='Y', verts=14, cuts=2, rot=None):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=verts, radius1=r, radius2=r, depth=depth)
    if cuts:
        side = [e for e in bm.edges if abs(e.verts[0].co.z - e.verts[1].co.z) > depth * 0.5]
        bmesh.ops.subdivide_edges(bm, edges=side, cuts=cuts)
    o = mesh_obj(name, bm)
    m = Matrix.Identity(4)
    if axis == 'Y':
        m = Matrix.Rotation(math.pi / 2, 4, 'X')
    elif axis == 'X':
        m = Matrix.Rotation(math.pi / 2, 4, 'Y')
    if rot:
        m = rot @ m
    o.data.transform(m)
    o.data.transform(Matrix.Translation(Vector(at)))
    return o


def join(objs, name):
    objs = [o for o in objs if o]
    for ob in bpy.context.selected_objects:
        ob.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    o.data.name = name
    return o


def xform(o, m):
    o.data.transform(m)
    o.data.update()
    return o


def about(m, pivot):
    p = Vector(pivot)
    return Matrix.Translation(p) @ m @ Matrix.Translation(-p)


# ------------------------------------------------------------------ damage

def crumple(o, rng, amp=0.008, freq=9.0, dents=6, dent_r=(0.05, 0.12), dent_d=(0.01, 0.03), hit=None, seed=0, keep_bottom=0.0):
    """Buckle the panels: fbm ripples along the normals, round dents punched in, and the penetration crater (hit = (point, r))."""
    co = get_co(o)
    nr = vnormals(o)
    ripple = (fbm(co * freq, 3, seed) - 0.5) * 2 * amp
    co += nr * ripple[:, None]
    lo, hi = co.min(0), co.max(0)
    for _ in range(dents):
        c = lo + rng.random(3) * (hi - lo)
        c[2] = lo[2] + (0.55 + 0.45 * rng.random()) * (hi[2] - lo[2])
        r = rng.uniform(*dent_r)
        d = rng.uniform(*dent_d)
        dist = np.linalg.norm(co - c, axis=1)
        k = np.clip(1 - (dist / r) ** 2, 0, 1) ** 2
        co -= nr * (k * d)[:, None]
    if hit is not None:
        c, r = np.array(hit[0]), hit[1]
        dist = np.linalg.norm(co - c, axis=1)
        k = np.clip(1 - (dist / r) ** 2, 0, 1)
        # a crater with a curled, petalled lip
        petal = 0.5 + 0.5 * np.sin(np.arctan2(co[:, 2] - c[2], co[:, 0] - c[0]) * 5)
        co -= nr * (k ** 2 * r * 0.55)[:, None]
        rim = np.exp(-(((dist - r) / (r * 0.25)) ** 2)) * petal
        co += nr * (rim * r * 0.18)[:, None]
    if keep_bottom > 0:
        # tracks / wheels keep touching the ground
        co[:, 2] = np.where(co[:, 2] < keep_bottom, np.maximum(co[:, 2], 0.0), co[:, 2])
    set_co(o, co)


def twist(o, rng, L, amt=0.05, sag=0.015):
    """The burnt hull warped by the heat: a slight twist along its length and a sag in the middle."""
    co = get_co(o)
    t = co[:, 0] / (L * 0.5)
    a = t * amt * rng.choice([-1, 1])
    y, z = co[:, 1].copy(), co[:, 2] - 0.15
    co[:, 1] = y * np.cos(a) - z * np.sin(a)
    co[:, 2] = y * np.sin(a) + z * np.cos(a) + 0.15
    co[:, 2] -= sag * np.clip(1 - t * t, 0, 1) * np.clip(co[:, 2] / 0.2, 0, 1)
    set_co(o, co)


def bend(o, pivot, axis_dir, droop, length):
    """Bend a barrel (along +axis_dir from pivot) down by droop radians over its length (quadratic curve)."""
    co = get_co(o)
    p = np.array(pivot)
    a = np.array(axis_dir) / np.linalg.norm(axis_dir)
    t = np.clip(((co - p) @ a) / length, 0, 1)
    co[:, 2] -= (t ** 2) * math.tan(droop) * length
    set_co(o, co)


# ------------------------------------------------------------------ running gear

def track_band(name, x0, x1, yc, w, r, z_axle, thick=0.022, segs=48, broken=None):
    """A track loop (stadium path around sprocket / idler) with grouser ridges. broken = (a, b): the arc fraction left out."""
    pts = []
    L = x1 - x0
    perim = 2 * L + 2 * math.pi * r
    for i in range(segs):
        s = i / segs * perim
        if s < L:
            p, n = (x1 - s, z_axle - r), (0, -1)
        elif s < L + math.pi * r:
            a = (s - L) / r
            p, n = (x0 - r * math.sin(a), z_axle - r * math.cos(a)), (-math.sin(a), -math.cos(a))
        elif s < 2 * L + math.pi * r:
            p, n = (x0 + (s - L - math.pi * r), z_axle + r), (0, 1)
        else:
            a = (s - 2 * L - math.pi * r) / r
            p, n = (x1 + r * math.sin(a), z_axle + r * math.cos(a)), (math.sin(a), math.cos(a))
        pts.append((p, n, i / segs))
    bm = bmesh.new()
    rings = []
    for (p, n, f) in pts:
        g = thick * (1.35 if (len(rings) % 2 == 0) else 1.0)
        ring = []
        for (dy, dn) in ((-w / 2, 0), (w / 2, 0), (w / 2, g), (-w / 2, g)):
            ring.append(bm.verts.new((p[0] + n[0] * (dn - thick * 0.5), yc + dy, p[1] + n[1] * (dn - thick * 0.5))))
        rings.append((ring, f))
    for i in range(len(rings)):
        (ra, fa), (rb, fb) = rings[i], rings[(i + 1) % len(rings)]
        if broken and broken[0] <= fa <= broken[1]:
            continue
        for k in range(4):
            bm.faces.new((ra[k], ra[(k + 1) % 4], rb[(k + 1) % 4], rb[k]))
    return mesh_obj(name, bm)


def thrown_strip(name, path, w, thick=0.02, rng=None):
    """A track that came off: links lying on the ground along path [(x, y)] (a little lifted where it piles up)."""
    bm = bmesh.new()
    rings = []
    for i, (x, y) in enumerate(path):
        if i + 1 < len(path):
            dx, dy = path[i + 1][0] - x, path[i + 1][1] - y
        else:
            dx, dy = x - path[i - 1][0], y - path[i - 1][1]
        L = math.hypot(dx, dy) or 1
        nx, ny = -dy / L, dx / L
        z = 0.002 + (0.012 * rng.random() if rng is not None else 0)
        g = thick * (1.4 if i % 2 == 0 else 1.0)
        ring = [bm.verts.new((x + nx * w / 2, y + ny * w / 2, z)), bm.verts.new((x - nx * w / 2, y - ny * w / 2, z)), bm.verts.new((x - nx * w / 2, y - ny * w / 2, z + g)), bm.verts.new((x + nx * w / 2, y + ny * w / 2, z + g))]
        rings.append(ring)
    for i in range(len(rings) - 1):
        ra, rb = rings[i], rings[i + 1]
        for k in range(4):
            bm.faces.new((ra[k], ra[(k + 1) % 4], rb[(k + 1) % 4], rb[k]))
    bm.faces.new(rings[0][::-1])
    bm.faces.new(rings[-1])
    return mesh_obj(name, bm)


def running_gear(tag, rng, x0, x1, yc, w, r_wheel, n_wheels, z_axle, side_sign, thrown):
    """Road wheels + track on one side. thrown: the track lies on the ground beside the hull, some wheels missing."""
    parts = []
    xs = np.linspace(x0 + r_wheel * 0.6, x1 - r_wheel * 0.6, n_wheels)
    for i, x in enumerate(xs):
        if thrown and rng.random() < 0.3:
            continue
        tilt = Matrix.Rotation(rng.uniform(-0.25, 0.25) if thrown else 0, 4, 'X')
        parts.append(cyl(f'{tag}_w{i}', r_wheel, w * 0.75, (x, yc, r_wheel + 0.004), axis='Y', verts=12, cuts=1, rot=tilt))
    # sprocket / idler
    parts.append(cyl(f'{tag}_sp', r_wheel * 0.85, w * 0.7, (x1 + 0.01, yc, z_axle + r_wheel * 0.35), axis='Y', verts=12, cuts=1))
    parts.append(cyl(f'{tag}_id', r_wheel * 0.8, w * 0.7, (x0 - 0.01, yc, z_axle + r_wheel * 0.3), axis='Y', verts=12, cuts=1))
    R = (r_wheel + 0.02)
    if thrown:
        # only a short piece still hangs over the front sprocket; the rest is unrolled on the ground behind / beside
        parts.append(track_band(f'{tag}_tb', x0, x1, yc, w, R, R, broken=(0.08, 0.95)))
        out = side_sign * 1.0
        path = []
        n = 26
        for i in range(n):
            t = i / (n - 1)
            x = x0 - 0.02 - t * 0.55 + 0.05 * math.sin(t * 5)
            y = yc + out * (0.06 + 0.32 * t * t + 0.03 * math.sin(t * 9))
            path.append((x, y))
        parts.append(thrown_strip(f'{tag}_ts', path, w * 0.95, rng=rng))
    else:
        parts.append(track_band(f'{tag}_tb', x0, x1, yc, w, R, R))
    return parts


# ------------------------------------------------------------------ hulls

def tank_hull(tag, rng, L=1.0, W=0.58, deck=0.27, skirts=True, ramp=False):
    hx0, hx1 = -L / 2, L / 2
    tw = 0.1
    yt = W / 2 - tw / 2

    def glacis(co):
        # sloped front plate and a lower nose
        f = np.clip((co[:, 0] - (hx1 - 0.18)) / 0.18, 0, 1)
        co[:, 2] = np.where(co[:, 2] > 0.15, co[:, 2] - f * (co[:, 2] - 0.15) * 0.75, co[:, 2])

    lower = box(f'{tag}_lower', hx0 + 0.02, hx1 - 0.02, -W / 2 + tw + 0.01, W / 2 - tw - 0.01, 0.05, 0.19, cuts=10)
    upper = box(f'{tag}_upper', hx0, hx1, -W / 2, W / 2, 0.17, deck, cuts=16, taper=glacis)
    parts = [lower, upper]
    # engine deck grille (raised) and hatches (opened, tilted up)
    parts.append(box(f'{tag}_eng', hx0 + 0.05, hx0 + 0.3, -W / 2 + 0.12, W / 2 - 0.12, deck - 0.01, deck + 0.018, cuts=6))
    hatch = box(f'{tag}_hatch', 0.18, 0.28, 0.05, 0.15, deck, deck + 0.012, cuts=3)
    xform(hatch, about(Matrix.Rotation(-1.1, 4, 'X'), (0.23, 0.05, deck)))
    parts.append(hatch)
    # fenders over the tracks (bent up / torn at the ends)
    for s_ in (1, -1):
        fd = box(f'{tag}_fd{s_}', hx0 - 0.02, hx1 + 0.02, s_ * W / 2 - tw, s_ * W / 2, deck - 0.012, deck, cuts=14)
        co = get_co(fd)
        e = np.clip((co[:, 0] - (hx1 - 0.15)) / 0.15, 0, 1) if rng.random() < 0.5 else np.clip(((hx0 + 0.15) - co[:, 0]) / 0.15, 0, 1)
        co[:, 2] += e * e * rng.uniform(0.04, 0.09)
        set_co(fd, co)
        parts.append(fd)
        # stowage bins along the fender, one burst open
        for i in range(3):
            if rng.random() < 0.3:
                continue
            bx = hx0 + 0.12 + i * 0.25
            bin_ = box(f'{tag}_bin{s_}{i}', bx, bx + 0.16, s_ * (W / 2 - tw * 0.85) - 0.03, s_ * (W / 2 - tw * 0.85) + 0.03, deck, deck + 0.05, cuts=4)
            if rng.random() < 0.4:
                xform(bin_, about(Matrix.Rotation(s_ * rng.uniform(0.3, 0.9), 4, 'X'), (0, s_ * (W / 2 - tw * 0.85), deck)))
            parts.append(bin_)
    # exhaust louvres on the rear plate
    for i in range(4):
        parts.append(box(f'{tag}_ex{i}', hx0 - 0.012, hx0 + 0.004, -0.16 + i * 0.085, -0.1 + i * 0.085, 0.14, deck - 0.03, cuts=2))
    if skirts:
        # side skirts: panels, some torn off, others bent out
        for s in (1, -1):
            for i in range(5):
                if rng.random() < 0.35:
                    continue
                x0 = hx0 + 0.05 + i * (L - 0.1) / 5
                pnl = box(f'{tag}_sk{s}{i}', x0, x0 + (L - 0.1) / 5 - 0.01, s * W / 2 - 0.006, s * W / 2 + 0.006, 0.07, 0.18, cuts=4)
                ang = rng.uniform(0.05, 0.6) * s
                xform(pnl, about(Matrix.Rotation(ang, 4, 'X'), (0, s * W / 2, 0.18)))
                parts.append(pnl)
    if ramp:
        # the rear ramp dropped open onto the ground
        rp = box(f'{tag}_ramp', hx0 - 0.012, hx0 + 0.006, -0.13, 0.13, 0.05, 0.25, cuts=5)
        xform(rp, about(Matrix.Rotation(-1.25, 4, 'Y'), (hx0, 0, 0.05)))
        parts.append(rp)
    return parts, yt, tw


def turret(tag, rng, x0, x1, hw, z0, h, gun_len, gun_r, droop, mantlet=True):
    def wedge(co):
        f = np.clip((co[:, 0] - (x1 - 0.12)) / 0.12, 0, 1)
        co[:, 1] *= 1 - 0.35 * f
        co[:, 2] = np.where(co[:, 2] > z0 + h * 0.5, co[:, 2] - f * h * 0.3, co[:, 2])

    t = box(f'{tag}_tur', x0, x1, -hw, hw, z0, z0 + h, cuts=12, taper=wedge)
    parts = [t]
    # bustle rack and a hatch blown open
    parts.append(box(f'{tag}_bus', x0 - 0.07, x0 + 0.02, -hw * 0.8, hw * 0.8, z0 + 0.012, z0 + h * 0.7, cuts=4))
    hc = box(f'{tag}_cup', x0 + 0.06, x0 + 0.14, hw * 0.15, hw * 0.65, z0 + h, z0 + h + 0.03, cuts=3)
    xform(hc, about(Matrix.Rotation(-0.9, 4, 'X'), (0, hw * 0.15, z0 + h)))
    parts.append(hc)
    for s_ in (1, -1):
        parts.append(box(f'{tag}_tb{s_}', x0 + 0.02, x0 + (x1 - x0) * 0.55, s_ * hw, s_ * (hw + 0.025), z0 + h * 0.15, z0 + h * 0.8, cuts=3))
        parts.append(cyl(f'{tag}_sd{s_}', 0.012, 0.05, (x1 - 0.1, s_ * (hw * 0.75), z0 + h + 0.008), axis='X', verts=8, cuts=0))
    if mantlet:
        parts.append(box(f'{tag}_mant', x1 - 0.02, x1 + 0.04, -hw * 0.35, hw * 0.35, z0 + h * 0.2, z0 + h * 0.8, cuts=3))
    gz = z0 + h * 0.5
    g = cyl(f'{tag}_gun', gun_r, gun_len, (x1 + gun_len / 2, 0, gz), axis='X', verts=10, cuts=10)
    bend(g, (x1, 0, gz), (1, 0, 0), droop, gun_len)
    parts.append(g)
    return parts


def ember_mask(co, nr, spots, seed):
    """Glowing embers: near the given spots ((point, r) list), on upward faces, broken up by noise."""
    e = np.zeros(len(co))
    for (p, r) in spots:
        d = np.linalg.norm(co - np.array(p), axis=1)
        e = np.maximum(e, np.clip(1 - d / r, 0, 1))
    n = fbm(co * 16.0, 4, seed + 40)
    cracks = np.clip((n - 0.47) / 0.16, 0, 1)
    return np.clip(e * e * (0.15 + 1.2 * cracks) * (0.5 + 0.5 * np.clip(nr[:, 2], 0, 1)), 0, 1)


def rust_mask(co, nr, seed):
    n = fbm(co * 7.0, 4, seed + 10)
    top = np.clip(nr[:, 2], 0, 1)
    return np.clip(0.15 + 0.55 * top + (n - 0.5) * 1.1, 0, 1)


def build_mbt(rng, variant):
    parts, yt, tw = tank_hull('mbt', rng, L=1.0, W=0.58, deck=0.27)
    for s, thrown in ((1, True), (-1, False)):
        parts += running_gear(f'mbt_rg{s}', rng, -0.47, 0.44, s * yt, tw, 0.052, 6, 0.06, s, thrown)
    hull = join(parts, 'mbt_hull')
    twist(hull, rng, 1.0)
    crumple(hull, rng, amp=0.012, freq=13.0, dents=14, dent_r=(0.05, 0.13), dent_d=(0.015, 0.045), hit=((0.18, -0.29, 0.21), 0.08), seed=3, keep_bottom=0.02)
    embers = [((-0.32, 0, 0.29), 0.2), ((0.23, 0.1, 0.27), 0.08), ((0.18, -0.29, 0.21), 0.08)]
    if variant == 'open':
        ring = cyl('mbt_ring', 0.17, 0.03, (0.02, 0, 0.278), axis='Z', verts=20, cuts=0)
        hull = join([hull, ring], 'mbt_open')
        embers.append(((0.02, 0, 0.3), 0.2))
        return hull, embers
    tp = turret('mbt_t', rng, -0.18, 0.2, 0.2, 0.0, 0.1, 0.55, 0.018, 0.0)
    tur = join(tp, 'mbt_turret')
    crumple(tur, rng, amp=0.008, freq=16.0, dents=6, dent_r=(0.03, 0.08), dent_d=(0.01, 0.03), seed=5)
    if variant == 'turret':
        bend(tur, (0.2, 0, 0.05), (1, 0, 0), 0.32, 0.55)
        return tur, [((-0.1, 0, 0.1), 0.18)]
    # knocked askew on its ring: turned, tipped onto one side, the gun drooping onto the deck
    bend(tur, (0.2, 0, 0.05), (1, 0, 0), 0.4, 0.55)
    m = Matrix.Translation((0.03, 0.06, 0.26)) @ Matrix.Rotation(0.24, 4, 'X') @ Matrix.Rotation(-0.1, 4, 'Y') @ Matrix.Rotation(0.6, 4, 'Z')
    xform(tur, m)
    hull = join([hull, tur], 'mbt')
    embers.append(((0.0, 0.05, 0.3), 0.15))
    return hull, embers


def build_ifv(rng, variant):
    parts, yt, tw = tank_hull('ifv', rng, L=1.0, W=0.56, deck=0.34, skirts=True, ramp=True)
    for s, thrown in ((1, False), (-1, True)):
        parts += running_gear(f'ifv_rg{s}', rng, -0.46, 0.44, s * yt, tw, 0.045, 6, 0.055, s, thrown)
    hull = join(parts, 'ifv_hull')
    twist(hull, rng, 1.0, amt=0.06, sag=0.02)
    crumple(hull, rng, amp=0.013, freq=13.0, dents=14, dent_r=(0.05, 0.13), dent_d=(0.015, 0.045), hit=((-0.05, 0.28, 0.25), 0.09), seed=11, keep_bottom=0.02)
    embers = [((-0.42, 0, 0.2), 0.22), ((0.25, -0.08, 0.34), 0.12), ((-0.05, 0.28, 0.25), 0.09)]
    if variant == 'open':
        ring = cyl('ifv_ring', 0.11, 0.03, (0.02, 0, 0.348), axis='Z', verts=16, cuts=0)
        hull = join([hull, ring], 'ifv_open')
        embers.append(((0.02, 0, 0.36), 0.14))
        return hull, embers
    tp = turret('ifv_t', rng, -0.08, 0.13, 0.12, 0.0, 0.075, 0.32, 0.01, 0.0, mantlet=False)
    tur = join(tp, 'ifv_turret')
    crumple(tur, rng, amp=0.006, freq=18.0, dents=4, dent_r=(0.02, 0.06), dent_d=(0.008, 0.02), seed=13)
    if variant == 'turret':
        bend(tur, (0.13, 0, 0.04), (1, 0, 0), 0.25, 0.32)
        return tur, [((0.0, 0, 0.08), 0.12)]
    bend(tur, (0.13, 0, 0.04), (1, 0, 0), 0.22, 0.32)
    xform(tur, Matrix.Translation((0.03, -0.02, 0.34)) @ Matrix.Rotation(-0.1, 4, 'X') @ Matrix.Rotation(-0.7, 4, 'Z'))
    hull = join([hull, tur], 'ifv')
    return hull, embers


def build_truck(rng):
    parts = []
    # frame rails, sagging towards the broken front-left corner
    for s in (1, -1):
        parts.append(box(f'tr_rail{s}', -0.55, 0.5, s * 0.1 - 0.02, s * 0.1 + 0.02, 0.1, 0.15, cuts=14))
    # cab: an empty burnt shell, windows gone, roof caved in
    cab = box('tr_cab', 0.22, 0.5, -0.24, 0.24, 0.13, 0.42, cuts=12)
    bm = bmesh.new()
    bm.from_mesh(cab.data)
    bm.faces.ensure_lookup_table()
    kill = []
    for f in bm.faces:
        c = f.calc_center_median()
        n = f.normal
        win_front = n.x > 0.9 and 0.27 < c.z < 0.39 and abs(c.y) < 0.2
        win_side = abs(n.y) > 0.9 and 0.27 < c.z < 0.39 and 0.27 < c.x < 0.45
        if win_front or win_side:
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(cab.data)
    bm.free()
    co = get_co(cab)
    sag = np.exp(-((co[:, 0] - 0.36) ** 2 + co[:, 1] ** 2) / 0.02)
    co[:, 2] = np.where(co[:, 2] > 0.41, co[:, 2] - 0.07 * sag, co[:, 2])
    set_co(cab, co)
    # (a solidified inner skin so the window holes show a burnt interior instead of the ground)
    apply_mod(cab, 'SOLIDIFY', thickness=0.012, offset=-1)
    parts.append(cab)
    parts.append(box('tr_hood', 0.46, 0.6, -0.2, 0.2, 0.12, 0.3, cuts=6))
    # bed: floor and side boards (one bent out, the tailgate down)
    parts.append(box('tr_bed', -0.56, 0.2, -0.26, 0.26, 0.15, 0.18, cuts=12))
    for s in (1, -1):
        for i in range(3):
            if rng.random() < 0.25:
                continue
            x0 = -0.55 + i * 0.25
            b = box(f'tr_side{s}{i}', x0, x0 + 0.24, s * 0.26 - 0.006, s * 0.26 + 0.006, 0.18, 0.3, cuts=4)
            xform(b, about(Matrix.Rotation(s * rng.uniform(0.05, 0.7), 4, 'X'), (0, s * 0.26, 0.18)))
            parts.append(b)
    tg = box('tr_gate', -0.566, -0.554, -0.25, 0.25, 0.18, 0.3, cuts=4)
    xform(tg, about(Matrix.Rotation(-1.4, 4, 'Y'), (-0.56, 0, 0.18)))
    parts.append(tg)
    # wheels burnt down to the rims (one front wheel gone)
    for (x, s) in ((0.38, -1), (-0.2, 1), (-0.2, -1), (-0.4, 1), (-0.4, -1)):
        parts.append(cyl(f'tr_rim{x}{s}', 0.06, 0.05, (x, s * 0.24, 0.06), axis='Y', verts=14, cuts=1))
        parts.append(cyl(f'tr_hub{x}{s}', 0.035, 0.07, (x, s * 0.24, 0.06), axis='Y', verts=10, cuts=0))
    t = join(parts, 'truck')
    # the missing wheel drops the front-left corner
    co = get_co(t)
    drop = np.clip((co[:, 0] - 0.0) / 0.6, 0, 1) * np.clip((co[:, 1] - 0.0) / 0.25, 0, 1)
    co[:, 2] -= drop * 0.05
    set_co(t, co)
    crumple(t, rng, amp=0.011, freq=14.0, dents=14, dent_r=(0.04, 0.11), dent_d=(0.012, 0.04), seed=21, keep_bottom=0.01)
    embers = [((0.36, 0, 0.2), 0.2), ((-0.2, 0, 0.18), 0.3), ((0.55, 0, 0.25), 0.1)]
    return t, embers


def build_harv(rng):
    parts, yt, tw = tank_hull('hv', rng, L=1.2, W=0.7, deck=0.3, skirts=False)
    for s, thrown in ((1, False), (-1, True)):
        parts += running_gear(f'hv_rg{s}', rng, -0.56, 0.54, s * (0.35 - 0.06), 0.12, 0.055, 7, 0.06, s, thrown)
    # the hopper: a big box whose top caved in, its walls bulged out
    hop = box('hv_hop', -0.5, 0.25, -0.3, 0.3, 0.3, 0.6, cuts=16)
    co = get_co(hop)
    cx = np.clip(1 - (np.abs(co[:, 0] + 0.12) / 0.38) ** 2, 0, 1) * np.clip(1 - (np.abs(co[:, 1]) / 0.3) ** 2, 0, 1)
    co[:, 2] = np.where(co[:, 2] > 0.59, co[:, 2] - 0.2 * cx, co[:, 2])
    bul = np.clip((co[:, 2] - 0.3) / 0.3, 0, 1) * np.sin(np.clip((co[:, 2] - 0.3) / 0.3, 0, 1) * math.pi)
    co[:, 1] += np.sign(co[:, 1]) * 0.03 * bul
    set_co(hop, co)
    parts.append(hop)
    # the cab at the front corner, the boom fallen across the nose
    parts.append(box('hv_cab', 0.3, 0.56, 0.08, 0.32, 0.3, 0.52, cuts=8))
    boom = box('hv_boom', 0.1, 0.75, -0.04, 0.04, 0.0, 0.07, cuts=12)
    xform(boom, Matrix.Translation((0, -0.18, 0.28)) @ Matrix.Rotation(-0.35, 4, 'Y') @ Matrix.Rotation(-0.4, 4, 'Z'))
    parts.append(boom)
    h = join(parts, 'harv')
    twist(h, rng, 1.2, amt=0.04, sag=0.02)
    crumple(h, rng, amp=0.013, freq=12.0, dents=16, dent_r=(0.06, 0.15), dent_d=(0.015, 0.05), hit=((0.0, -0.36, 0.28), 0.1), seed=31, keep_bottom=0.02)
    embers = [((-0.12, 0, 0.45), 0.35), ((0.43, 0.2, 0.4), 0.14), ((0.0, -0.36, 0.28), 0.1)]
    return h, embers


# ------------------------------------------------------------------ bake + reduce

def bake_ao(o):
    me = o.data
    attr = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    me.color_attributes.active_color = attr
    mat = bpy.data.materials.new('bake')
    mat.use_nodes = True
    me.materials.clear()
    me.materials.append(mat)
    sc = bpy.context.scene
    sc.cycles.samples = 48
    sc.render.bake.target = 'VERTEX_COLORS'
    sc.render.bake.margin = 0
    bpy.ops.mesh.primitive_plane_add(size=8, location=(0, 0, 0.0))
    plane = bpy.context.active_object
    for ob in bpy.context.selected_objects:
        ob.select_set(False)
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')
    bpy.data.objects.remove(plane)
    a = np.zeros(len(me.vertices) * 4, dtype=np.float32)
    attr.data.foreach_get('color', a)
    return a.reshape(-1, 4)[:, 0].astype(np.float64)


def write_colors(o, ao, rust, ember):
    me = o.data
    attr = me.color_attributes.get('Col') or me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    c = np.stack([ao, rust, ember, np.ones_like(ao)], 1).astype(np.float32)
    attr.data.foreach_set('color', c.ravel())
    me.color_attributes.active_color = attr


def reduce(o, tris, name):
    old = bpy.data.objects.get(name)
    if old is not None and old is not o:
        old.name = name + '_old'
    cur = sum(len(p.vertices) - 2 for p in o.data.polygons)
    apply_mod(o, 'DECIMATE', decimate_type='COLLAPSE', ratio=min(1.0, tris / max(1, cur)), use_collapse_triangulate=True)
    o.name = name
    o.data.name = name
    o.data.polygons.foreach_set('use_smooth', np.ones(len(o.data.polygons), dtype=bool))
    for ob in bpy.context.selected_objects:
        ob.select_set(False)
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(40))
    return o


def build_all():
    sc = reset()
    w = bpy.data.worlds.new('w')
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (1, 1, 1, 1)
    sc.world = w
    makers = {
        'mbt': lambda r: build_mbt(r, 'a'),
        'mbt_open': lambda r: build_mbt(r, 'open'),
        'mbt_turret': lambda r: build_mbt(r, 'turret'),
        'ifv': lambda r: build_ifv(r, 'a'),
        'ifv_open': lambda r: build_ifv(r, 'open'),
        'ifv_turret': lambda r: build_ifv(r, 'turret'),
        'truck': build_truck,
        'harv': build_harv,
    }
    out = []
    info = {}
    for k, budget in KIT.items():
        t = time.time()
        # (the same seed per class: the open / turret variants are the same hull as the full one)
        rng = np.random.default_rng(sum(map(ord, k.split('_')[0])))
        o, embers = makers[k](rng)
        o.name = k + '_src'
        # (a turret on its own: base at the ground)
        co = get_co(o)
        co[:, 2] -= max(0.0, co[:, 2].min()) if k.endswith('_turret') else 0.0
        set_co(o, co)
        nr = vnormals(o)
        ao = bake_ao(o)
        write_colors(o, ao, rust_mask(co, nr, len(k)), ember_mask(co, nr, embers, len(k)))
        lo = reduce(o, budget, k)
        tri = sum(len(p.vertices) - 2 for p in lo.data.polygons)
        bb = get_co(lo)
        info[k] = {'tris': tri, 'min': [round(float(v), 3) for v in bb.min(0)], 'max': [round(float(v), 3) for v in bb.max(0)], 'ao': round(float(ao.mean()), 3)}
        print(f'TRIS {k}: {tri}  ao {ao.mean():.3f}  ({time.time() - t:.0f} s)')
        out.append(lo)
        lo.location.x += 20 * len(out)
    for ob in out:
        ob.location = (0, 0, 0)
    for ob in bpy.context.selected_objects:
        ob.select_set(False)
    for ob in out:
        ob.select_set(True)
        ob.data.materials.clear()
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'hulks-raw.glb'), export_format='GLB', use_selection=True, export_apply=True, export_yup=True, export_normals=True, export_texcoords=False, export_materials='NONE', export_vertex_color='ACTIVE', export_all_vertex_colors=False)
    with open(os.path.join(OUT, 'hulks.json'), 'w') as f:
        json.dump(info, f, indent=1)
    if PREVIEW:
        preview(out)
    print('OK_DONE')


def preview(objs):
    """Contact sheet: the hulks in a row, charred steel / rust / embers from the vertex colours (Cycles)."""
    sc = bpy.context.scene
    mat = bpy.data.materials.new('hulk')
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes['Principled BSDF']
    attr = nt.nodes.new('ShaderNodeVertexColor')
    attr.layer_name = 'Col'
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(attr.outputs['Color'], sep.inputs['Color'])
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.inputs['A'].default_value = (0.03, 0.028, 0.026, 1)
    mix.inputs['B'].default_value = (0.16, 0.06, 0.02, 1)
    nt.links.new(sep.outputs['Green'], mix.inputs['Factor'])
    mul = nt.nodes.new('ShaderNodeMix')
    mul.data_type = 'RGBA'
    mul.blend_type = 'MULTIPLY'
    mul.inputs['Factor'].default_value = 1.0
    nt.links.new(mix.outputs['Result'], mul.inputs['A'])
    nt.links.new(sep.outputs['Red'], mul.inputs['B'])
    nt.links.new(mul.outputs['Result'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.8
    bsdf.inputs['Emission Color'].default_value = (1.0, 0.35, 0.08, 1)
    em = nt.nodes.new('ShaderNodeMath')
    em.operation = 'MULTIPLY'
    em.inputs[1].default_value = 3.0
    nt.links.new(sep.outputs['Blue'], em.inputs[0])
    nt.links.new(em.outputs[0], bsdf.inputs['Emission Strength'])
    for i, o in enumerate(objs):
        o.data.materials.append(mat)
        o.data.polygons.foreach_set('material_index', np.zeros(len(o.data.polygons), dtype=np.int32))
        o.location = ((i % 4) * 1.6 - 2.4, -(i // 4) * 1.3 + 0.65, 0)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from common import studio
    studio((4.2, -5.2, 4.4), (0, 0, 0.1), lens=42, sun=(0.95, 0.15, 2.4), size=(1400, 760), samples=48, path=os.path.join(OUT, 'hulks_preview.png'), ground=0.0)


build_all()
