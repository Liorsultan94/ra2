# Blender 5.2.2 LTS — Iron Front: disturbed-soil height maps for the ground round the base structures
# (render/basepads.ts). Reproducible: fixed seeds, no external assets.
#
#   nice -n 10 /opt/blender/blender -b --factory-startup -P web/tools/blender/gx4_basesoil.py -- <out dir> [scale]
#   (out dir: web/public/tex/basesoil; scale 0.25 for a quick small test render)
#
# Writes two greyscale height maps (0.5 = undisturbed ground; darker = pressed in, lighter = raised):
#   scuff.webp  512 x 512, tileable both ways, 2 x 2 map tiles: tyre and track scuffs turning on the
#               spot, skid smears, boot prints, pebbles and clods pressed up out of compacted soil
#   track.webp  256 x 512, tileable along v (2 map tiles): two lanes side by side, 0.5 tile each:
#               u 0 .. 0.5 a tank's two treads (grouser bars), u 0.5 .. 1 a wheeled vehicle's two tyres
#               (chevron lugs); ruts with the soil pushed up into berms along both sides
#
# Method: the features are modelled as meshes (pebbles / clods as displaced icospheres, ruts and prints as
# profiled ribbons, lugs and grousers as small boxes) in two layers - RAISED (pebbles, berms, lugs) and
# PRESSED (ruts, prints, smears, modelled upwards as a positive depth) - each rendered top down with an
# orthographic camera in Cycles (emission = height, 16 AA samples), every feature repeated at +-period so
# the maps tile. height = 0.5 + 0.5 * (raised - pressed) / 0.02 tiles.

import bpy
import bmesh
import math
import os
import random
import sys

import numpy as np

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'tex', 'basesoil')
SCALE = float(argv[1]) if len(argv) > 1 else 1.0
TMP = os.path.join(OUT, '_tmp')
os.makedirs(TMP, exist_ok=True)
ZR = 0.02  # height range (tiles) mapped to the full 0.5 swing

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
sc.cycles.samples = 16
sc.cycles.use_denoising = False
sc.cycles.max_bounces = 0
sc.render.film_transparent = False
sc.view_settings.view_transform = 'Standard'
sc.view_settings.look = 'None'
sc.render.filter_size = 1.2
w = bpy.data.worlds.new('w')
sc.world = w
w.use_nodes = True
w.node_tree.nodes['Background'].inputs[0].default_value = (0, 0, 0, 1)

# emission = clamp(z / ZR): one material for every object
mat = bpy.data.materials.new('height')
mat.use_nodes = True
nt = mat.node_tree
for n in list(nt.nodes):
    nt.nodes.remove(n)
geo = nt.nodes.new('ShaderNodeNewGeometry')
sep = nt.nodes.new('ShaderNodeSeparateXYZ')
mr = nt.nodes.new('ShaderNodeMapRange')
mr.inputs['From Min'].default_value = 0.0
mr.inputs['From Max'].default_value = ZR
mr.clamp = True
em = nt.nodes.new('ShaderNodeEmission')
outn = nt.nodes.new('ShaderNodeOutputMaterial')
nt.links.new(geo.outputs['Position'], sep.inputs[0])
nt.links.new(sep.outputs['Z'], mr.inputs['Value'])
nt.links.new(mr.outputs['Result'], em.inputs['Color'])
nt.links.new(em.outputs['Emission'], outn.inputs['Surface'])

cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
sc.collection.objects.link(cam)
cam.data.type = 'ORTHO'
cam.data.clip_start = 0.01
cam.data.clip_end = 10
sc.camera = cam

layers = {'raised': bpy.data.collections.new('raised'), 'pressed': bpy.data.collections.new('pressed')}
for c in layers.values():
    sc.collection.children.link(c)


def mesh_obj(name, bm, layer):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    ob.data.materials.append(mat)
    layers[layer].objects.link(ob)
    return ob


def ground_plane(w_, h_):
    # the undisturbed ground (z = 0) under both layers, a margin past the frame
    for layer in layers:
        bm = bmesh.new()
        bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=1)
        for v in bm.verts:
            v.co.x = v.co.x * (w_ * 0.5 + 1) + w_ * 0.5
            v.co.y = v.co.y * (h_ * 0.5 + 1) + h_ * 0.5
        mesh_obj('ground_' + layer, bm, layer)


def wraps(per_x, per_y):
    xs = [-per_x, 0, per_x] if per_x else [0]
    ys = [-per_y, 0, per_y] if per_y else [0]
    return [(a, b) for a in xs for b in ys]


def blob(bm, x, y, r, zr, sub, rnd, squash=0.45, rough=0.25):
    """A pebble / clod: a jittered icosphere, flattened, half sunk into the ground."""
    ret = bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=r)
    vs = ret['verts']
    ax = rnd.uniform(0.7, 1.3)
    ay = rnd.uniform(0.7, 1.3)
    rot = rnd.uniform(0, math.pi)
    c, s = math.cos(rot), math.sin(rot)
    ph = [rnd.uniform(0, 6.28) for _ in range(3)]
    for v in vs:
        p = v.co
        n = 1 + rough * (math.sin(p.x * 61 + ph[0]) * math.sin(p.y * 57 + ph[1]) * math.sin(p.z * 53 + ph[2]))
        px, py, pz = p.x * ax * n, p.y * ay * n, p.z * squash * n
        v.co = (x + px * c - py * s, y + px * s + py * c, pz + zr)


def ribbon(bm, pts, half, depth, prof='round'):
    """A profiled strip along a polyline (positive z = depth): ruts, smears, berms."""
    n = len(pts)
    across = [-1, -0.7, -0.35, 0, 0.35, 0.7, 1]
    rows = []
    for i, (x, y, k) in enumerate(pts):
        x0, y0 = pts[max(0, i - 1)][:2]
        x1, y1 = pts[min(n - 1, i + 1)][:2]
        dx, dy = x1 - x0, y1 - y0
        L = math.hypot(dx, dy) or 1
        nx, ny = -dy / L, dx / L
        row = []
        for a in across:
            if prof == 'round':
                z = depth * k * max(0.0, 1 - a * a) ** 0.6
            else:  # flat bottomed rut with soft shoulders
                z = depth * k * (1 - max(0.0, abs(a) - 0.55) / 0.45) ** 1.5 if abs(a) > 0.55 else depth * k
            row.append(bm.verts.new((x + nx * a * half, y + ny * a * half, max(z, 0.0) - 0.0005)))
        rows.append(row)
    for i in range(n - 1):
        for j in range(len(across) - 1):
            bm.faces.new((rows[i][j], rows[i][j + 1], rows[i + 1][j + 1], rows[i + 1][j]))


def box(bm, x, y, ang, lx, ly, h):
    ret = bmesh.ops.create_cube(bm, size=1)
    c, s = math.cos(ang), math.sin(ang)
    for v in ret['verts']:
        px, py, pz = v.co.x * lx, v.co.y * ly, (v.co.z + 0.5) * h
        v.co = (x + px * c - py * s, y + px * s + py * c, pz - 0.0004)


def render(path, w_, h_, res_x, res_y, layer):
    for k, c in layers.items():
        c.hide_render = k != layer
    cam.location = (w_ * 0.5, h_ * 0.5, 5)
    cam.rotation_euler = (0, 0, 0)
    cam.data.ortho_scale = max(w_, h_)
    sc.render.resolution_x = res_x
    sc.render.resolution_y = res_y
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = 'OPEN_EXR'
    sc.render.image_settings.color_depth = '32'
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    a = np.array(img.pixels[:], np.float32).reshape(res_y, res_x, 4)[..., 0]
    bpy.data.images.remove(img)
    return a


def save(path, h):
    hh, ww = h.shape
    img = bpy.data.images.new(os.path.basename(path), ww, hh, alpha=False, float_buffer=True)
    img.colorspace_settings.name = 'Non-Color'
    px = np.empty((hh, ww, 4), np.float32)
    px[..., 0] = px[..., 1] = px[..., 2] = h
    px[..., 3] = 1
    img.pixels.foreach_set(px.ravel())
    s = sc.render.image_settings
    s.file_format = 'WEBP'
    s.color_mode = 'RGB'
    s.color_depth = '8'
    s.quality = 92
    img.save_render(path, scene=sc)
    bpy.data.images.remove(img)


def clear():
    for c in layers.values():
        for ob in list(c.objects):
            bpy.data.objects.remove(ob, do_unlink=True)


def compose(name, w_, h_, rx, ry):
    r = render(os.path.join(TMP, name + '_r.exr'), w_, h_, rx, ry, 'raised')
    p = render(os.path.join(TMP, name + '_p.exr'), w_, h_, rx, ry, 'pressed')
    h = np.clip(0.5 + 0.5 * (r - p), 0, 1)
    # (Blender's pixel rows run bottom up; the game samples v = map y, top down)
    return h[::-1]


# ------------------------------------------------------------------ scuff (2 x 2 tiles, tiles both ways)
def arc_pts(cx, cy, rad, a0, a1, step=0.012):
    n = max(3, int(abs(a1 - a0) * rad / step))
    out = []
    for i in range(n + 1):
        t = i / n
        a = a0 + (a1 - a0) * t
        k = math.sin(math.pi * t) ** 0.5  # pressed in deepest mid way, fading at the ends
        out.append((cx + math.cos(a) * rad, cy + math.sin(a) * rad, k))
    return out


def build_scuff(P=2.0):
    rnd = random.Random(4242)
    ground_plane(P, P)
    bmR = bmesh.new()
    bmP = bmesh.new()
    for ox, oy in wraps(P, P):
        rr = random.Random(77)
        # tyre / track scuffs where vehicles turned: pairs of parallel arcs
        for i in range(22):
            cx, cy = rr.uniform(0, P), rr.uniform(0, P)
            rad = rr.uniform(0.25, 0.9)
            a0 = rr.uniform(0, 6.28)
            a1 = a0 + rr.uniform(0.5, 1.4) * rr.choice([-1, 1])
            gap = rr.uniform(0.26, 0.32)
            half = rr.uniform(0.018, 0.03)
            dep = rr.uniform(0.004, 0.009)
            for side in (0, 1):
                pts = arc_pts(cx + ox, cy + oy, rad + side * gap, a0, a1)
                ribbon(bmP, pts, half, dep, 'flat')
                # soil squeezed out to both sides of the rut
                for sgn in (-1, 1):
                    ribbon(bmR, arc_pts(cx + ox, cy + oy, rad + side * gap + sgn * (half + 0.008), a0, a1), 0.009, dep * 0.45)
                # lugs left standing in the rut
                L = abs(a1 - a0) * (rad + side * gap)
                nl = int(L / 0.03)
                for j in range(1, nl):
                    a = a0 + (a1 - a0) * j / nl
                    rr_ = rad + side * gap
                    k = math.sin(math.pi * j / nl) ** 0.5
                    box(bmR, cx + ox + math.cos(a) * rr_, cy + oy + math.sin(a) * rr_, a, half * 1.6, 0.007, dep * 0.6 * k)
        # skid smears: wide, shallow
        for i in range(8):
            cx, cy = rr.uniform(0, P), rr.uniform(0, P)
            a0 = rr.uniform(0, 6.28)
            pts = arc_pts(cx + ox, cy + oy, rr.uniform(0.6, 1.5), a0, a0 + rr.uniform(0.2, 0.5))
            ribbon(bmP, pts, rr.uniform(0.04, 0.07), rr.uniform(0.0015, 0.003))
        # boot prints along a few walking lines
        for i in range(7):
            x, y = rr.uniform(0, P), rr.uniform(0, P)
            hd = rr.uniform(0, 6.28)
            for st in range(rr.randint(6, 12)):
                hd += rr.uniform(-0.25, 0.25)
                x += math.cos(hd) * 0.045
                y += math.sin(hd) * 0.045
                sd = 0.012 * (1 if st % 2 else -1)
                fx, fy = x - math.sin(hd) * sd, y + math.cos(hd) * sd
                ribbon(bmP, [(ox + fx - math.cos(hd) * 0.012, oy + fy - math.sin(hd) * 0.012, 0.8), (ox + fx, oy + fy, 1), (ox + fx + math.cos(hd) * 0.014, oy + fy + math.sin(hd) * 0.014, 0.9)], 0.006, 0.003)
        # pebbles and clods pressed up through the compacted soil
        for i in range(650):
            x, y = rr.uniform(0, P), rr.uniform(0, P)
            r = rr.uniform(0.003, 0.009) if rr.random() < 0.85 else rr.uniform(0.01, 0.02)
            blob(bmR, x + ox, y + oy, r, -r * 0.15, 1, random.Random(i * 7 + 1))
        for i in range(70):
            x, y = rr.uniform(0, P), rr.uniform(0, P)
            r = rr.uniform(0.014, 0.03)
            blob(bmR, x + ox, y + oy, r, -r * 0.2, 2, random.Random(i * 13 + 5), squash=0.3, rough=0.4)
    mesh_obj('scuff_r', bmR, 'raised')
    mesh_obj('scuff_p', bmP, 'pressed')


# ------------------------------------------------------------------ track lanes (1 x 2 tiles, tiles along v)
def build_track(V=2.0):
    ground_plane(1.0, V)
    bmR = bmesh.new()
    bmP = bmesh.new()
    for ox, oy in wraps(0, V):
        rr = random.Random(99)
        # a gentle sway that repeats every V tiles (so the strip tiles)
        sway = lambda v, ph, a: a * math.sin(2 * math.pi * v / V + ph)
        for lane in (0, 1):
            u0 = lane * 0.5
            ph = rr.uniform(0, 6.28)
            amp = 0.012
            if lane == 0:  # tracked: two 0.085-wide treads 0.3 apart, grouser bars every 0.03
                centres, half, dep, pitch = (0.1, 0.4), 0.042, 0.010, 0.03
            else:  # wheeled: two 0.06-wide tyres 0.28 apart, chevron lugs every 0.036
                centres, half, dep, pitch = (0.11, 0.39), 0.03, 0.007, 0.036
            for c in centres:
                pts = []
                n = int(V / 0.02)
                for i in range(n + 1):
                    v = i * V / n
                    pts.append((u0 + c + sway(v, ph, amp) + ox, v + oy, 1.0))
                ribbon(bmP, pts, half, dep, 'flat')
                for sgn in (-1, 1):
                    bp = [(x + sgn * (half + 0.01), y, 0.8 + 0.4 * rr.random()) for (x, y, _) in pts]
                    ribbon(bmR, bp, 0.012, dep * 0.5)
                nl = int(V / pitch)
                for j in range(nl):
                    v = j * pitch
                    x = u0 + c + sway(v, ph, amp) + ox
                    if lane == 0:
                        box(bmR, x, v + oy, 0, half * 1.8, 0.008, dep * 0.55)
                    else:
                        for sgn in (-1, 1):
                            box(bmR, x + sgn * half * 0.45, v + oy + 0.006, sgn * 0.55, half * 0.95, 0.0065, dep * 0.6)
            # crumbs of soil thrown out between and beside the lanes
            for i in range(90):
                x = u0 + rr.uniform(0.03, 0.47)
                y = rr.uniform(0, V)
                r = rr.uniform(0.003, 0.008)
                blob(bmR, x + ox, y + oy, r, -r * 0.1, 1, random.Random(i * 31 + lane), squash=0.35)
    mesh_obj('track_r', bmR, 'raised')
    mesh_obj('track_p', bmP, 'pressed')


res = lambda n: max(16, int(n * SCALE))
build_scuff()
h = compose('scuff', 2.0, 2.0, res(512), res(512))
save(os.path.join(OUT, 'scuff.webp'), h)
print('scuff', h.shape, float(h.min()), float(h.max()))
clear()
build_track()
h = compose('track', 1.0, 2.0, res(256), res(512))
save(os.path.join(OUT, 'track.webp'), h)
print('track', h.shape, float(h.min()), float(h.max()))
for f in os.listdir(TMP):
    os.remove(os.path.join(TMP, f))
os.rmdir(TMP)
print('OK_DONE')
