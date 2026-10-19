# Blender 5.2.2 (LTS) - NV1 naval kit: the Shipyard and every nation's patrol boat, missile boat / corvette and
# landing craft / hovercraft (render only; sim/naval.ts).
#
#   nice -n 15 /opt/blender/blender -b --factory-startup -P web/tools/blender/naval/navalkit.py -- <out_dir> [kit|preview|cameos|all]
#   (or web/tools/blender/naval/make.sh, which also packs public/models/naval/)
#
# Pieces (one root empty per model key, its meshes as children; "<mesh>_l1" is the far level of detail):
#   shipyard          a rust-red corrugated steel shipbuilding hall with a glazed monitor roof and solar panels, the slipway
#                     running down through it into the water, a yellow gantry crane over the water end on rails along two
#                     concrete piers, bollards, a container yard and a lean-to office; "shipyard_hull" is the hull on the
#                     slipway (shown while a boat is being built), "shipyard_trolley" the gantry's crab (it travels while
#                     building). The water side is +X (the slipway's mouth); the footprint is 4 x 4 tiles round the origin.
#   nv_<nation>_patrol / _corvette / _lander   the boats (bow = +X, waterline at z = 0); "<key>_turret" turns
#                     (its object origin is the turret ring), "<key>_spin" is a radar that spins, "<key>_fan0/1" hovercraft
#                     propellers (spin about X). Empties "muzzle*" mark the barrel tips.
# Materials (glTF material names; the game assigns its own shaders by name, src/render/naval/navalkit.ts):
#   paint (albedo in the vertex colour, baked AO multiplied in), team (vertex colour = AO only: tinted with the player
#   colour), glass, lamp (emissive: running / flood lights), rust / glaze / solar (the hall's tiled maps, UVs in tiles,
#   vertex colour = AO).
# No logos, names or hull numbers. Units: one game tile = 1; Blender X forward, Y left, Z up (glTF: game x, y up, z right).
import bpy
import bmesh
import json
import math
import os
import sys
import time

import numpy as np
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else '/tmp/navalkit'
STEP = argv[1] if len(argv) > 1 else 'all'
os.makedirs(OUT, exist_ok=True)


def srgb(h):
    """Hex sRGB -> linear RGB tuple (vertex colours are linear in glTF)."""
    c = [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.render.threads_mode = 'FIXED'
    sc.render.threads = 3
    sc.view_settings.view_transform = 'Standard'
    return sc


MATS = ['paint', 'team', 'glass', 'lamp', 'rust', 'glaze', 'solar']
_mats = {}


def mat(name):
    if name not in _mats:
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        _mats[name] = m
    return _mats[name]


# ------------------------------------------------------------------ primitives
# Every part is its own object carrying its albedo ('col'), material name ('mat') and UV scale ('uvk', textured parts).

PARTS = []


def link(name, bm):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def tag(o, col, m='paint', uvk=0.0):
    o['col'] = list(srgb(col)) if isinstance(col, int) else list(col)
    o['mat'] = m
    o['uvk'] = uvk
    PARTS.append(o)
    return o


def cuts_for(L, cell):
    return max(0, int(math.ceil(L / cell)) - 1)


def box(x0, x1, y0, y1, z0, z1, col, m='paint', cell=0.06, uvk=0.0, name='box'):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        x, y, z = v.co
        v.co = Vector((x0 + (x + 0.5) * (x1 - x0), y0 + (y + 0.5) * (y1 - y0), z0 + (z + 0.5) * (z1 - z0)))
    if cell:
        # grid each face so the AO bake has vertices to land on
        for ax, L in ((0, x1 - x0), (1, y1 - y0), (2, z1 - z0)):
            n = cuts_for(abs(L), cell)
            if n <= 0:
                continue
            edges = [e for e in bm.edges if abs((e.verts[0].co - e.verts[1].co)[ax]) > 1e-6 and abs((e.verts[0].co - e.verts[1].co).length - abs((e.verts[0].co - e.verts[1].co)[ax])) < 1e-6]
            bmesh.ops.subdivide_edges(bm, edges=edges, cuts=n, use_grid_fill=True)
    return tag(link(name, bm), col, m, uvk)


def taper_top(o, kx=1.0, ky=1.0, dx=0.0):
    """Shrink the top of a part towards its centre line (sloped superstructure walls)."""
    zs = [v.co.z for v in o.data.vertices]
    z0, z1 = min(zs), max(zs)
    cx = sum(v.co.x for v in o.data.vertices) / len(zs)
    cy = sum(v.co.y for v in o.data.vertices) / len(zs)
    for v in o.data.vertices:
        t = (v.co.z - z0) / max(1e-6, z1 - z0)
        v.co.x = cx + (v.co.x - cx) * (1 + (kx - 1) * t) + dx * t
        v.co.y = cy + (v.co.y - cy) * (1 + (ky - 1) * t)
    return o


def cyl(c, r, h, col, axis='Z', verts=12, m='paint', r2=None, cell=0.06, cap=True, name='cyl'):
    bm = bmesh.new()
    r2 = r if r2 is None else r2
    rings = max(1, cuts_for(h, cell) + 1)
    segs = []
    for i in range(rings + 1):
        t = i / rings
        rr = r + (r2 - r) * t
        segs.append([bm.verts.new((math.cos(a) * rr, math.sin(a) * rr, -h / 2 + h * t)) for a in [2 * math.pi * k / verts for k in range(verts)]])
    for i in range(rings):
        for k in range(verts):
            bm.faces.new((segs[i][k], segs[i][(k + 1) % verts], segs[i + 1][(k + 1) % verts], segs[i + 1][k]))
    if cap:
        bm.faces.new(list(reversed(segs[0])))
        if r2 > 1e-4:
            bm.faces.new(segs[-1])
    rot = {'Z': Matrix(), 'X': Matrix.Rotation(math.pi / 2, 4, 'Y'), 'Y': Matrix.Rotation(math.pi / 2, 4, 'X')}[axis]
    bmesh.ops.transform(bm, matrix=Matrix.Translation(c) @ rot, verts=bm.verts)
    return tag(link(name, bm), col, m)


def bar(a, b, r, col, verts=6, m='paint'):
    """A round bar from a to b."""
    a = Vector(a)
    b = Vector(b)
    d = b - a
    o = cyl((0, 0, 0), r, d.length, col, 'Z', verts, m, cell=0.2)
    q = Vector((0, 0, 1)).rotation_difference(d.normalized())
    o.data.transform(Matrix.Translation((a + b) / 2) @ q.to_matrix().to_4x4())
    return o


def prism(pts, z0, z1, col, m='paint', cell=0.06, name='prism', top_scale=1.0):
    """A polygon (x, y list, counter-clockwise) extruded from z0 to z1 (top optionally scaled about its centroid)."""
    bm = bmesh.new()
    bot = [bm.verts.new((x, y, z0)) for x, y in pts]
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    top = [bm.verts.new((cx + (x - cx) * top_scale, cy + (y - cy) * top_scale, z1)) for x, y in pts]
    n = len(pts)
    bm.faces.new(list(reversed(bot)))
    bm.faces.new(top)
    for i in range(n):
        bm.faces.new((bot[i], bot[(i + 1) % n], top[(i + 1) % n], top[i]))
    if cell:
        bmesh.ops.subdivide_edges(bm, edges=[e for e in bm.edges if e.calc_length() > cell * 1.5], cuts=1, use_grid_fill=True)
    return tag(link(name, bm), col, m)


def loft(sections, col, m='paint', close_ends=True, name='loft'):
    """Quad strips through cross-sections (each a list of (x, y, z) with the same count); end caps as fans."""
    bm = bmesh.new()
    rows = [[bm.verts.new(p) for p in s] for s in sections]
    n = len(sections[0])
    for i in range(len(rows) - 1):
        for k in range(n - 1):
            a, b, c, d = rows[i][k], rows[i][k + 1], rows[i + 1][k + 1], rows[i + 1][k]
            if len({a.co.to_tuple(5), b.co.to_tuple(5), c.co.to_tuple(5), d.co.to_tuple(5)}) >= 3:
                try:
                    bm.faces.new((a, b, c, d))
                except ValueError:
                    pass
    if close_ends:
        for r in (rows[0], rows[-1]):
            uniq = []
            for v in r:
                if not uniq or (v.co - uniq[-1].co).length > 1e-5:
                    uniq.append(v)
            if len(uniq) >= 3:
                try:
                    bm.faces.new(uniq)
                except ValueError:
                    pass
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return tag(link(name, bm), col, m)


def mirror_y(sec):
    """A half section (from the keel up the port side: y >= 0) -> full section port..keel..starboard."""
    left = list(reversed(sec))
    right = [(x, -y, z) for (x, y, z) in sec[1:]]
    return left + right


def hull(L, B, D, T, col, deck_col, bow=0.3, transom=0.82, deadrise=0.35, sheer=0.04, flare=0.06, n=16, x0=None, name='hull'):
    """Planing / displacement monohull: stern at -L/2, bow at +L/2, waterline z = 0, deck at D (+ sheer at the bow),
    keel T below. Returns (hull, deck) objects."""
    x0 = -L / 2 if x0 is None else x0
    secs = []
    deck = []
    for i in range(n + 1):
        t = i / n
        x = x0 + L * t
        # half breadth: full aft, a fine entry over the forward `bow` share
        f = 1.0
        if t > 1 - bow:
            u = (t - (1 - bow)) / bow
            f = math.cos(u * math.pi / 2) ** 1.15
        f = max(f, 0.0) * (transom + (1 - transom) * min(1, t * 6))
        b = B / 2 * f
        dz = D + sheer * max(0, (t - 0.5) * 2) ** 2
        kz = -T * (1 - max(0, (t - 0.72) / 0.28) ** 1.6 * 0.8)
        sec = [
            (x, 0.0, kz),
            (x, b * 0.55, kz + (b * 0.55) * deadrise),
            (x, b * 0.92, -T * 0.15),
            (x, b + flare * f * 0.4, dz * 0.55),
            (x, b + flare * f, dz),
        ]
        secs.append(mirror_y(sec))
        deck.append((x, b + flare * f, dz))
    h = loft(secs, col, name=name)
    # deck: a strip over the sheer line
    dsecs = [[(x, y - 0.003, z + 0.002), (x, 0, z + 0.004 + y * 0.03), (x, -y + 0.003, z + 0.002)] for (x, y, z) in deck]
    d = loft(dsecs, deck_col, close_ends=False, name=name + '_deck')
    return h, d


# ------------------------------------------------------------------ assembly, AO bake, LOD

def assemble(key, parts=None):
    """Join the tagged parts into one mesh with a vertex colour (albedo) and a material slot per material."""
    parts = parts if parts is not None else list(PARTS)
    PARTS.clear()
    for pi, o in enumerate(parts):
        me = o.data
        n = len(me.vertices)
        # (the source part of every vertex: split_parts() separates turret / radar / fans again after the bake)
        sa = me.attributes.new('src', 'INT', 'POINT')
        sa.data.foreach_set('value', np.full(n, pi, dtype=np.int32))
        attr = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
        c = o['col']
        attr.data.foreach_set('color', np.tile(np.array([c[0], c[1], c[2], 1.0], dtype=np.float32), n))
        me.materials.clear()
        me.materials.append(mat(o['mat']))
        if o['uvk']:
            uv_project(o, o['uvk'])
    bpy.ops.object.select_all(action='DESELECT')
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    if len(parts) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = key
    o.data.name = key
    return o


def uv_project(o, k):
    """Planar UVs in tiles x k by each face's dominant axis (the hall's tiled maps)."""
    me = o.data
    if not me.uv_layers:
        me.uv_layers.new(name='UVMap')
    uv = me.uv_layers.active.data
    for p in me.polygons:
        n = p.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for li in p.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            if ax == 2:
                u, v = co.x, co.y
            elif ax == 1:
                u, v = co.x, co.z
            else:
                u, v = co.y, co.z
            uv[li].uv = (u * k, v * k)


def bake_ao(o, ground=None, samples=32):
    """Cycles AO into a temporary vertex colour; multiply it into 'Col' (team / textured parts: Col = AO)."""
    me = o.data
    col = me.color_attributes['Col']
    aoattr = me.color_attributes.new('AO', 'FLOAT_COLOR', 'POINT')
    me.color_attributes.active_color = aoattr
    sc = bpy.context.scene
    sc.cycles.samples = samples
    sc.render.bake.target = 'VERTEX_COLORS'
    sc.render.bake.margin = 0
    pl = None
    if ground is not None:
        bpy.ops.mesh.primitive_plane_add(size=12, location=(0, 0, ground))
        pl = bpy.context.active_object
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')
    if pl:
        bpy.data.objects.remove(pl)
    n = len(me.vertices)
    a = np.zeros(n * 4, dtype=np.float32)
    aoattr.data.foreach_get('color', a)
    ao = a.reshape(-1, 4)[:, 0]
    c = np.zeros(n * 4, dtype=np.float32)
    col.data.foreach_get('color', c)
    c = c.reshape(-1, 4)
    # per-vertex material: team / textured parts carry AO only
    plain = np.ones(n, dtype=bool)
    for p in me.polygons:
        mname = me.materials[p.material_index].name
        if mname in ('team', 'rust', 'glaze', 'solar'):
            for vi in p.vertices:
                plain[vi] = False
    k = 0.45 + 0.55 * np.clip(ao, 0, 1) ** 0.8
    c[:, 0:3] = np.where(plain[:, None], c[:, 0:3] * k[:, None], np.repeat(k[:, None], 3, 1))
    col.data.foreach_set('color', c.ravel())
    me.color_attributes.remove(aoattr)
    me.color_attributes.active_color = me.color_attributes['Col']
    return float(ao.mean())


def decimated(o, tris, name):
    c = o.copy()
    c.data = o.data.copy()
    c.name = name
    c.data.name = name
    bpy.context.scene.collection.objects.link(c)
    cur = sum(len(p.vertices) - 2 for p in c.data.polygons)
    if cur > tris:
        m = c.modifiers.new('d', 'DECIMATE')
        m.decimate_type = 'COLLAPSE'
        m.ratio = tris / cur
        m.use_collapse_triangulate = True
        bpy.ops.object.select_all(action='DESELECT')
        c.select_set(True)
        bpy.context.view_layer.objects.active = c
        bpy.ops.object.modifier_apply(modifier='d')
    return c


def ntris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


# ------------------------------------------------------------------ boat equipment

def gun_turret(x, y, z, col, s=1.0, barrel=0.16, twin=False, dome=False):
    """A stabilised autocannon / naval gun mount (parts of the turret group, ring at (x, y, z))."""
    out = []
    if dome:
        out.append(cyl((x, y, z + 0.035 * s), 0.05 * s, 0.07 * s, col, verts=14, r2=0.03 * s, cell=0.03))
    else:
        b = box(x - 0.05 * s, x + 0.05 * s, y - 0.04 * s, y + 0.04 * s, z, z + 0.05 * s, col, cell=0.03)
        taper_top(b, 0.8, 0.8, 0.01 * s)
        out.append(b)
    for dy in ((-0.012 * s, 0.012 * s) if twin else (0,)):
        out.append(cyl((x + 0.04 * s + barrel / 2, y + dy, z + 0.03 * s), 0.008 * s, barrel, 0x2e3134, 'X', 8, cell=0.08))
    return out


def missile_rack(x, y, z, n, col, ang=0.35, L=0.16, r=0.018, across=True):
    """Canted anti-ship missile canisters (a row across the deck, pointing outboard)."""
    out = []
    for i in range(n):
        yy = y + (i - (n - 1) / 2) * r * 2.3
        o = cyl((0, 0, 0), r, L, col, 'X', 8, cell=0.1)
        o.data.transform(Matrix.Translation((x, yy, z + r)) @ Matrix.Rotation(-ang, 4, 'Y'))
        out.append(o)
    return out


def mast(x, y, z, h, col, yard=0.08, radar=None):
    out = [bar((x, y, z), (x, y, z + h), 0.008, col)]
    out.append(bar((x, y - yard, z + h * 0.75), (x, y + yard, z + h * 0.75), 0.005, col))
    return out


def radar_bar(x, y, z, w, col):
    """A spinning radar antenna (its own object: '<key>_spin')."""
    o = box(x - 0.008, x + 0.008, y - w / 2, y + w / 2, z, z + 0.018, col, cell=0.04)
    return o


def lamp(x, y, z, colr, r=0.009):
    return cyl((x, y, z), r, r * 1.6, colr, verts=6, m='lamp', cell=0.2)


def running_lights(L, B, D, h):
    """Port red, starboard green, white masthead (gentle at night: the game keeps them small)."""
    return [lamp(-0.0, B / 2, D + 0.04, 0xff3a2a), lamp(-0.0, -B / 2, D + 0.04, 0x3aff6a), lamp(0.0, 0, h, 0xfff4e0)]


# ------------------------------------------------------------------ boat designs
# Per nation: (paint, deck, superstructure, accent) colours and a design per type. Navy greys differ by nation.

NATIONS = {
    'usa': dict(hull=0x7f878e, deck=0x5c6166, sup=0x8e969c, dark=0x3b4045),
    'israel': dict(hull=0x8d9396, deck=0x5f6264, sup=0x9aa0a3, dark=0x3e4244),
    'china': dict(hull=0x7a868f, deck=0x5a6066, sup=0x88939b, dark=0x3a4046),
    'russia': dict(hull=0x6f7b84, deck=0x55504a, sup=0x7d8891, dark=0x353b40),
    'germany': dict(hull=0x858b8f, deck=0x5d6063, sup=0x93999d, dark=0x3d4043),
    'korea': dict(hull=0x8a9196, deck=0x5c6165, sup=0x979ea2, dark=0x3d4245),
    'ukraine': dict(hull=0x6e767b, deck=0x4f5457, sup=0x7d858a, dark=0x34383b),
    'turkey': dict(hull=0x80888d, deck=0x5b5f62, sup=0x8f969b, dark=0x3b3f42),
    'iran': dict(hull=0x87897f, deck=0x5c5d56, sup=0x95978c, dark=0x3d3e38),
}
BOOT = 0x2a2c2e
RED_BOTTOM = 0x6a2a24


def boat_patrol(P, v):
    """Fast patrol boat. v: variant dict (L, B, cabin shape, weapons)."""
    L, B, D = v.get('L', 0.9), v.get('B', 0.22), v.get('D', 0.07)
    h, dk = hull(L, B, D, 0.05, P['hull'], P['deck'], bow=0.38, transom=0.9, deadrise=0.5, sheer=0.03)
    st = []
    # wheelhouse: sloped front, dark windows band, team stripe on the roof edge
    cx, cl, cw, ch = v.get('cab', (-0.05, 0.3, 0.15, 0.09))
    c = box(cx - cl / 2, cx + cl / 2, -cw / 2, cw / 2, D, D + ch, P['sup'], cell=0.035)
    taper_top(c, 0.82, 0.85, -0.03)
    win = box(cx + cl / 2 - 0.07, cx + cl / 2 - 0.02, -cw / 2 * 0.93, cw / 2 * 0.93, D + ch * 0.55, D + ch * 0.85, 0x1b2630, 'glass', cell=0.04)
    taper_top(win, 0.9, 0.85, -0.03)
    roof = box(cx - cl * 0.42, cx + cl * 0.3, -cw * 0.42, cw * 0.42, D + ch, D + ch + 0.012, 0xffffff, 'team', cell=0.04)
    st += [c, win, roof]
    st += mast(cx - 0.02, 0, D + ch + 0.012, v.get('mast', 0.13), P['dark'])
    spin = radar_bar(cx - 0.02, 0, D + ch + 0.012 + v.get('mast', 0.13) * 0.82, 0.08, 0x2a2d30)
    st += running_lights(L, B, D, D + ch + v.get('mast', 0.13) + 0.012)
    # aft: an MG mount and a small RHIB
    st += [cyl((-L / 2 + 0.12, 0, D + 0.03), 0.022, 0.06, P['dark'], verts=8, cell=0.05)]
    st += [cyl((-L / 2 + 0.09, 0.0, D + 0.035), 0.012, 0.12, 0x26292c, 'Y', 8, cell=0.1)]
    tx = v.get('gx', L * 0.3)
    tur = gun_turret(tx, 0, D, P['sup'], s=v.get('gs', 1.0), barrel=v.get('gb', 0.15), twin=v.get('twin', False), dome=v.get('dome', False))
    return dict(body=[h, dk] + st, turret=tur, tpos=(tx, 0, D), spin=[spin], muzzle=(tx + 0.05 + v.get('gb', 0.15), 0, D + 0.03 * v.get('gs', 1.0)), len=L, beam=B, h=D + ch)


def boat_usv(P, v):
    """Unmanned surface vessel: a low wedge with a sensor mast and a remote weapon station."""
    L, B, D = v.get('L', 0.6), v.get('B', 0.15), v.get('D', 0.04)
    h, dk = hull(L, B, D, 0.035, P['hull'], P['deck'], bow=0.5, transom=0.92, deadrise=0.6, sheer=0.015, flare=0.02)
    st = []
    # a flat sensor hump and the antenna mast
    hump = box(-0.12, 0.05, -0.05, 0.05, D, D + 0.035, P['sup'], cell=0.03)
    taper_top(hump, 0.7, 0.7, 0.0)
    st += [hump, box(-0.09, 0.02, -0.035, 0.035, D + 0.035, D + 0.04, 0xffffff, 'team', cell=0.03)]
    st += [bar((-0.06, 0, D + 0.035), (-0.06, 0, D + 0.1), 0.005, P['dark']), cyl((-0.06, 0, D + 0.11), 0.012, 0.02, 0xd8dadc, verts=8, cell=0.05)]
    st += [lamp(-0.06, 0, D + 0.125, 0xfff4e0, 0.006)]
    # waterjet housings
    for s in (-1, 1):
        st.append(cyl((-L / 2 + 0.01, s * 0.035, -0.005), 0.016, 0.04, 0x2a2c2e, 'X', 8, cell=0.05))
    tx = v.get('gx', 0.12)
    if v.get('pod'):
        # a stabilised mount with a four-round guided rocket pod and a sensor ball (ULAQ style)
        tur = [cyl((tx, 0, D + 0.02), 0.02, 0.03, P['dark'], verts=10, cell=0.05), box(tx - 0.035, tx + 0.06, -0.03, 0.03, D + 0.03, D + 0.065, 0x4b5154, cell=0.03), cyl((tx - 0.02, 0.04, D + 0.05), 0.014, 0.02, 0xd0d2d4, 'Y', 10, cell=0.05)]
        for dy in (-0.012, 0.012):
            for dz in (0.04, 0.056):
                tur.append(cyl((tx + 0.062, dy, D + dz), 0.007, 0.006, 0x1a1c1e, 'X', 8, cell=0.1))
        mz = (tx + 0.07, 0, D + 0.048)
    else:
        tur = gun_turret(tx, 0, D + 0.005, P['dark'], s=0.75, barrel=0.1)
        mz = (tx + 0.14, 0, D + 0.03)
    if v.get('cabin'):
        # a low enclosed sensor / electronics housing with dark windows (the bigger USVs)
        cb = box(-0.2, -0.02, -0.06, 0.06, D, D + 0.05, P['sup'], cell=0.03)
        taper_top(cb, 0.85, 0.8, -0.01)
        st += [cb, box(-0.035, -0.022, -0.05, 0.05, D + 0.022, D + 0.042, 0x1b2630, 'glass', cell=0.03)]
    return dict(body=[h, dk] + st, turret=tur, tpos=(tx, 0, D + 0.005), spin=[], muzzle=mz, len=L, beam=B, h=D + 0.12)


def boat_fac(P, v):
    """Small swarm fast attack craft: an open boat with a console, a bow gun and a rocket launcher aft."""
    L, B, D = v.get('L', 0.62), v.get('B', 0.17), v.get('D', 0.05)
    h, dk = hull(L, B, D, 0.035, P['hull'], P['deck'], bow=0.42, transom=0.9, deadrise=0.55, sheer=0.03, flare=0.03)
    st = [box(-0.06, 0.04, -0.05, 0.05, D, D + 0.05, P['sup'], cell=0.03)]
    st += [box(0.025, 0.04, -0.045, 0.045, D + 0.03, D + 0.065, 0x1b2630, 'glass', cell=0.03)]
    st += [box(-0.07, 0.04, -0.058, 0.058, D + 0.07, D + 0.078, 0xffffff, 'team', cell=0.03)]
    for s in (-1, 1):
        st.append(bar((-0.06, s * 0.05, D + 0.05), (-0.06, s * 0.055, D + 0.075), 0.004, P['dark']))
        st.append(bar((0.035, s * 0.05, D + 0.065), (0.035, s * 0.055, D + 0.075), 0.004, P['dark']))
    # rocket launcher (107 mm tubes) aft
    rk = box(-0.22, -0.12, -0.04, 0.04, D + 0.02, D + 0.06, 0x4e5348, cell=0.03)
    rk.data.transform(Matrix.Translation((-0.17, 0, D + 0.02)) @ Matrix.Rotation(-0.25, 4, 'Y') @ Matrix.Translation((0.17, 0, -D - 0.02)))
    st += [rk, bar((-0.17, 0, D), (-0.17, 0, D + 0.03), 0.01, P['dark'])]
    st += [lamp(-0.02, 0, D + 0.1, 0xfff4e0, 0.006), bar((-0.02, 0, D + 0.078), (-0.02, 0, D + 0.095), 0.003, P['dark'])]
    tx = 0.17
    tur = gun_turret(tx, 0, D, P['dark'], s=0.7, barrel=0.11)
    return dict(body=[h, dk] + st, turret=tur, tpos=(tx, 0, D), spin=[], muzzle=(tx + 0.145, 0, D + 0.02), len=L, beam=B, h=D + 0.1)


def boat_corvette(P, v):
    """Missile corvette / fast missile craft: bow gun, block superstructure with an integrated mast, canted missile
    canisters amidships, a close-in weapon aft and (bigger ships) a flight deck."""
    L, B, D = v.get('L', 1.45), v.get('B', 0.27), v.get('D', 0.09)
    h, dk = hull(L, B, D, 0.07, P['hull'], P['deck'], bow=0.4, transom=0.86, deadrise=0.25, sheer=0.045, flare=0.05, n=20)
    st = []
    sx0, sx1 = v.get('sup', (-0.2, 0.25))
    sh = v.get('sh', 0.12)
    s = box(sx0, sx1, -B * 0.4, B * 0.4, D, D + sh, P['sup'], cell=0.04)
    taper_top(s, 0.9, 0.86)
    st.append(s)
    # bridge windows, a team band round the superstructure top
    st.append(box(sx1 - 0.035, sx1 - 0.012, -B * 0.33, B * 0.33, D + sh * 0.62, D + sh * 0.85, 0x1b2630, 'glass', cell=0.04))
    st.append(box(sx0 + 0.02, sx1 - 0.02, -B * 0.37, B * 0.37, D + sh, D + sh + 0.012, 0xffffff, 'team', cell=0.05))
    # integrated mast block (stealthy pyramid) or a lattice
    mx = sx0 + (sx1 - sx0) * 0.55
    if v.get('stealth', True):
        m = box(mx - 0.06, mx + 0.06, -0.06, 0.06, D + sh, D + sh + v.get('mh', 0.16), P['sup'], cell=0.04)
        taper_top(m, 0.45, 0.45)
        st.append(m)
        # flat-panel radar faces
        for sy in (-1, 1):
            st.append(box(mx - 0.035, mx + 0.035, sy * 0.042 - 0.004, sy * 0.042 + 0.004, D + sh + 0.05, D + sh + 0.09, 0x3a4248, cell=0.03))
    else:
        st += mast(mx, 0, D + sh, v.get('mh', 0.18), P['dark'], 0.1)
    top = D + sh + v.get('mh', 0.16)
    spin = radar_bar(mx, 0, top + 0.005, 0.1, 0x2a2d30)
    st.append(bar((mx, 0, top - 0.02), (mx, 0, top + 0.006), 0.007, P['dark']))
    st += running_lights(L, B, D, top + 0.03)
    # funnel aft of the superstructure
    st.append(taper_top(box(sx0 - 0.08, sx0 + 0.02, -0.045, 0.045, D, D + sh * 0.85, P['sup'], cell=0.04), 0.8, 0.8, -0.01))
    st.append(box(sx0 - 0.07, sx0 + 0.01, -0.035, 0.035, D + sh * 0.85, D + sh * 0.87, 0x1e2022, cell=0.04))
    # missile canisters amidships (or aft)
    rx = v.get('rx', sx0 - 0.17)
    for sy in (-1, 1):
        st += missile_rack(rx, sy * B * 0.2, D, v.get('nm', 2), P['dark'], L=0.17, r=0.02)
    # close-in weapon aft (a dome) on a deckhouse; a flight deck at the stern
    ax = v.get('ax', -L / 2 + 0.24)
    st.append(box(ax - 0.06, ax + 0.06, -0.06, 0.06, D, D + 0.05, P['sup'], cell=0.04))
    st.append(cyl((ax, 0, D + 0.08), 0.032, 0.06, 0xd8dadc, verts=12, r2=0.022, cell=0.03))
    if v.get('heli', True):
        st.append(box(-L / 2 + 0.02, ax - 0.07, -B * 0.42, B * 0.42, D + 0.001, D + 0.004, 0x4a4f53, cell=0.05))
        st.append(box(-L / 2 + 0.06, ax - 0.11, -0.004, 0.004, D + 0.004, D + 0.006, 0xe8e6da, cell=0.1))
    tx = v.get('gx', L * 0.3)
    tur = gun_turret(tx, 0, D, P['sup'], s=1.25, barrel=0.18, dome=v.get('gdome', True))
    return dict(body=[h, dk] + st, turret=tur, tpos=(tx, 0, D), spin=[spin], muzzle=(tx + 0.2 + 0.06, 0, D + 0.04), len=L, beam=B, h=top + 0.03)


def boat_catamaran(P, v):
    """Wave-piercing catamaran missile boat (Type 022 style): twin slender hulls, an angular faceted superstructure,
    missile tubes aft."""
    L, B, D = v.get('L', 1.15), v.get('B', 0.3), 0.07
    parts = []
    for sy in (-1, 1):
        hh, dd = hull(L, 0.09, D, 0.06, P['hull'], P['deck'], bow=0.55, transom=0.9, deadrise=0.6, sheer=0.0, flare=0.0, n=16)
        for o in (hh, dd):
            o.data.transform(Matrix.Translation((0, sy * B * 0.36, 0)))
        parts += [hh, dd]
    # the bridging deck and the faceted superstructure over both hulls
    deck = box(-L / 2 + 0.02, L / 2 - 0.12, -B * 0.42, B * 0.42, D - 0.02, D + 0.01, P['hull'], cell=0.05)
    parts.append(deck)
    sup = box(-0.25, 0.22, -B * 0.4, B * 0.4, D + 0.01, D + 0.11, P['sup'], cell=0.04)
    taper_top(sup, 0.82, 0.62, -0.02)
    parts.append(sup)
    parts.append(box(0.12, 0.16, -B * 0.24, B * 0.24, D + 0.07, D + 0.095, 0x1b2630, 'glass', cell=0.03))
    parts.append(box(-0.2, 0.12, -B * 0.22, B * 0.22, D + 0.11, D + 0.12, 0xffffff, 'team', cell=0.04))
    m = box(-0.05, 0.05, -0.04, 0.04, D + 0.11, D + 0.24, P['sup'], cell=0.04)
    taper_top(m, 0.45, 0.45)
    parts.append(m)
    spin = radar_bar(0.0, 0, D + 0.245, 0.08, 0x2a2d30)
    parts += running_lights(L, B, D, D + 0.27)
    # missile tubes aft (two banks of four), the 30 mm gun on the foredeck
    for sy in (-1, 1):
        parts += missile_rack(-0.38, sy * B * 0.22, D + 0.01, 2, P['dark'], ang=0.25, L=0.17, r=0.018)
    tx = 0.33
    tur = gun_turret(tx, 0, D + 0.01, P['sup'], s=1.0, barrel=0.14, dome=True)
    return dict(body=parts, turret=tur, tpos=(tx, 0, D + 0.01), spin=[spin], muzzle=(tx + 0.19, 0, D + 0.04), len=L, beam=B, h=D + 0.27)


def boat_lander(P, v):
    """Landing craft (LCM / LCT style): a flat box hull, an open well deck with a bow ramp, the wheelhouse aft."""
    L, B, D = v.get('L', 1.1), v.get('B', 0.36), v.get('D', 0.08)
    out = []
    # flat-bottomed hull with slab sides, a raked bow under the ramp
    secs = []
    for i in range(13):
        t = i / 12
        x = -L / 2 + L * t
        k = 1.0 if t < 0.88 else 1.0 - (t - 0.88) / 0.12 * 0.06
        bz = -0.045 + max(0, (t - 0.86) / 0.14) * 0.06
        b = B / 2 * k
        secs.append(mirror_y([(x, 0, bz), (x, b * 0.96, bz), (x, b, bz + 0.015), (x, b, D)]))
    out.append(loft(secs, P['hull']))
    # well deck floor and the side wing walls
    out.append(box(-L / 2 + 0.24, L / 2 - 0.03, -B * 0.4, B * 0.4, 0.0, 0.006, P['deck'], cell=0.06))
    for sy in (-1, 1):
        out.append(box(-L / 2 + 0.22, L / 2 - 0.02, sy * B * 0.44 - 0.02, sy * B * 0.44 + 0.02, 0.0, D + 0.04, P['sup'], cell=0.05))
        out.append(box(-L / 2 + 0.24, L / 2 - 0.05, sy * B * 0.44 - 0.022, sy * B * 0.44 + 0.022, D + 0.04, D + 0.048, 0xffffff, 'team', cell=0.06))
    # the bow ramp, raised
    ramp = box(L / 2 - 0.035, L / 2 - 0.01, -B * 0.42, B * 0.42, 0.0, D + 0.05, P['sup'], cell=0.04)
    taper_top(ramp, 1.0, 1.0, 0.018)
    out.append(ramp)
    for sy in (-1, 1):
        out.append(bar((L / 2 - 0.1, sy * B * 0.4, D + 0.04), (L / 2 - 0.02, sy * B * 0.4, D + 0.07), 0.004, P['dark']))
    # wheelhouse aft
    wx = -L / 2 + 0.12
    wh = box(wx - 0.1, wx + 0.08, -B * 0.4, B * 0.4, D, D + 0.12, P['sup'], cell=0.04)
    taper_top(wh, 0.9, 0.9, -0.01)
    out.append(wh)
    out.append(box(wx + 0.06, wx + 0.075, -B * 0.32, B * 0.32, D + 0.07, D + 0.105, 0x1b2630, 'glass', cell=0.03))
    out.append(box(wx - 0.05, wx + 0.02, -0.05, 0.05, D + 0.12, D + 0.17, P['sup'], cell=0.03))
    out += mast(wx - 0.02, 0, D + 0.17, 0.1, P['dark'])
    spin = radar_bar(wx - 0.02, 0, D + 0.25, 0.06, 0x2a2d30)
    out += running_lights(L, B, D, D + 0.28)
    tur = []
    if v.get('gun'):
        tur = gun_turret(wx + 0.03, 0, D + 0.17, P['dark'], s=0.6, barrel=0.08)
    return dict(body=out, turret=tur, tpos=(wx + 0.03, 0, D + 0.17), spin=[spin], muzzle=(wx + 0.03 + 0.12, 0, D + 0.19), len=L, beam=B, h=D + 0.28)


def boat_hover(P, v):
    """Hovercraft (LCAC style, or a BH.7 style with a cabin and one propeller on a pylon): black skirt, deck,
    side structures, ducted propellers aft (spinning fans)."""
    L, B = v.get('L', 1.12), v.get('B', 0.5)
    out = []
    # the skirt: a fat rounded ring round the hull, black rubber
    sk = []
    hz = 0.06
    for i in range(17):
        t = i / 16
        x = -L / 2 + L * t
        r = 1.0 if 0.08 < t < 0.92 else math.sqrt(max(0.0, 1 - ((abs(t - 0.5) - 0.42) / 0.08) ** 2)) * 0.55 + 0.45
        b = B / 2 * r
        sk.append(mirror_y([(x, 0, -0.01), (x, b * 0.9, -0.01), (x, b, 0.02), (x, b * 0.98, hz), (x, b * 0.9, hz + 0.01)]))
    out.append(loft(sk, 0x1d1e1f))
    out.append(box(-L / 2 + 0.05, L / 2 - 0.05, -B * 0.42, B * 0.42, hz - 0.005, hz + 0.02, P['hull'], cell=0.06))
    lc = v.get('look', 'lcac')
    fans = []
    if lc == 'lcac':
        # open cargo deck with two side structures, bow and stern ramps, two big ducted fans aft
        out.append(box(-L / 2 + 0.1, L / 2 - 0.08, -B * 0.24, B * 0.24, hz + 0.02, hz + 0.024, P['deck'], cell=0.06))
        for sy in (-1, 1):
            sx = box(-L / 2 + 0.1, L / 2 - 0.12, sy * B * 0.32 - 0.055, sy * B * 0.32 + 0.055, hz + 0.02, hz + 0.1, P['sup'], cell=0.04)
            out.append(sx)
            out.append(box(-L / 2 + 0.14, L / 2 - 0.2, sy * B * 0.32 - 0.04, sy * B * 0.32 + 0.04, hz + 0.1, hz + 0.106, 0xffffff, 'team', cell=0.05))
        # the bridge on the starboard structure, forward
        out.append(box(L / 2 - 0.3, L / 2 - 0.16, -B * 0.32 - 0.05, -B * 0.32 + 0.05, hz + 0.1, hz + 0.17, P['sup'], cell=0.03))
        out.append(box(L / 2 - 0.175, L / 2 - 0.16, -B * 0.32 - 0.045, -B * 0.32 + 0.045, hz + 0.13, hz + 0.16, 0x1b2630, 'glass', cell=0.03))
        for sy in (-1, 1):
            fx, fy, fz = -L / 2 + 0.1, sy * B * 0.3, hz + 0.14
            out.append(cyl((fx, fy, fz), 0.105, 0.05, P['sup'], 'X', 18, cell=0.05, cap=False))
            out.append(cyl((fx, fy, fz), 0.098, 0.052, P['dark'], 'X', 18, cell=0.05, cap=False))
            out.append(box(fx - 0.03, fx + 0.03, fy - 0.012, fy + 0.012, hz + 0.02, fz - 0.09, P['sup'], cell=0.04))
            fans.append(((fx, fy, fz), 0.095))
            # rudders behind the duct
            for dy in (-0.05, 0.05):
                out.append(box(fx - 0.06, fx - 0.035, fy + dy - 0.003, fy + dy + 0.003, fz - 0.07, fz + 0.07, P['dark'], cell=0.05))
        top = hz + 0.25
        lift = [(L / 2 - 0.35, sy * B * 0.32, hz + 0.1) for sy in (-1, 1)]
        for (x, y, z) in lift:
            out.append(cyl((x, y, z + 0.01), 0.03, 0.02, 0x2a2c2e, verts=12, cell=0.05))
        out += [lamp(L / 2 - 0.2, B * 0.32 + 0.06, hz + 0.12, 0xff3a2a), lamp(L / 2 - 0.2, -B * 0.32 - 0.06, hz + 0.18, 0x3aff6a), lamp(L / 2 - 0.23, -B * 0.32, hz + 0.2, 0xfff4e0)]
        out += [bar((L / 2 - 0.23, -B * 0.32, hz + 0.17), (L / 2 - 0.23, -B * 0.32, hz + 0.24), 0.004, P['dark'])]
        spin = radar_bar(L / 2 - 0.23, -B * 0.32, hz + 0.24, 0.05, 0x2a2d30)
        tpos = (L / 2 - 0.26, B * 0.32, hz + 0.1)
    else:
        # BH.7 / Solgae style: an enclosed cabin forward, a fin and propeller(s) on pylons aft
        cab = box(-L / 2 + 0.2, L / 2 - 0.12, -B * 0.34, B * 0.34, hz + 0.02, hz + 0.13, P['sup'], cell=0.04)
        taper_top(cab, 0.9, 0.85, -0.02)
        out.append(cab)
        out.append(box(L / 2 - 0.16, L / 2 - 0.13, -B * 0.28, B * 0.28, hz + 0.07, hz + 0.115, 0x1b2630, 'glass', cell=0.03))
        out.append(box(-L / 2 + 0.24, L / 2 - 0.18, -B * 0.3, B * 0.3, hz + 0.13, hz + 0.14, 0xffffff, 'team', cell=0.05))
        n = v.get('props', 1)
        for k in range(n):
            fy = 0 if n == 1 else (k - 0.5) * B * 0.42
            fx, fz = -L / 2 + 0.12, hz + 0.24
            out.append(box(fx - 0.035, fx + 0.035, fy - 0.012, fy + 0.012, hz + 0.13, fz - 0.03, P['sup'], cell=0.04))
            out.append(cyl((fx + 0.03, fy, fz), 0.02, 0.06, P['dark'], 'X', 10, cell=0.05))
            fans.append(((fx - 0.005, fy, fz), 0.11 if n == 1 else 0.085))
        fin = box(-L / 2 + 0.03, -L / 2 + 0.1, -0.006, 0.006, hz + 0.14, hz + 0.33, P['sup'], cell=0.04)
        taper_top(fin, 0.5, 1.0, -0.02)
        out.append(fin)
        top = hz + 0.33
        out += [bar((0.1, 0, hz + 0.14), (0.1, 0, hz + 0.22), 0.004, P['dark']), lamp(0.1, 0, hz + 0.23, 0xfff4e0)]
        out += [lamp(0.2, B * 0.34, hz + 0.1, 0xff3a2a), lamp(0.2, -B * 0.34, hz + 0.1, 0x3aff6a)]
        spin = radar_bar(0.1, 0, hz + 0.2, 0.05, 0x2a2d30)
        tpos = (L / 2 - 0.2, 0, hz + 0.14)
    tur = []
    if v.get('gun'):
        tur = gun_turret(tpos[0], tpos[1], tpos[2], P['dark'], s=0.6, barrel=0.08)
    return dict(body=out, turret=tur, tpos=tpos, spin=[spin], fans=fans, muzzle=(tpos[0] + 0.12, tpos[1], tpos[2] + 0.02), len=L, beam=B, h=top)


def fan_mesh(r, col):
    """A propeller (blades round a hub at the origin) spinning about X."""
    parts = [cyl((0, 0, 0), r * 0.18, 0.03, 0x26282a, 'X', 10, cell=0.05)]
    for k in range(5):
        a = 2 * math.pi * k / 5
        b = box(-0.006, 0.006, -0.012, 0.012, r * 0.15, r * 0.95, col, cell=0.05)
        b.data.transform(Matrix.Rotation(a, 4, 'X') @ Matrix.Rotation(0.4, 4, 'Z'))
        parts.append(b)
    return parts


DESIGNS = {
    'usa': {
        'patrol': (boat_patrol, dict(L=0.95, B=0.2, cab=(-0.04, 0.32, 0.15, 0.09), gx=0.3, gs=0.9, gb=0.14, mast=0.15)),
        'corvette': (boat_corvette, dict(L=1.6, B=0.3, sup=(-0.15, 0.32), sh=0.13, mh=0.2, nm=2, rx=-0.36, gx=0.55)),
        'lander': (boat_hover, dict(look='lcac', L=1.15, B=0.52, gun=True)),
    },
    'israel': {
        'patrol': (boat_patrol, dict(L=0.85, B=0.19, cab=(-0.02, 0.26, 0.14, 0.08), gx=0.26, gs=0.85, gb=0.13, dome=True, mast=0.12)),
        'corvette': (boat_corvette, dict(L=1.45, B=0.29, sup=(-0.12, 0.3), sh=0.14, mh=0.2, nm=2, rx=-0.32, gx=0.5, gdome=True)),
        'lander': (boat_lander, dict(L=1.12, B=0.36)),
    },
    'china': {
        'patrol': (boat_patrol, dict(L=0.98, B=0.21, cab=(0.0, 0.3, 0.16, 0.1), gx=0.33, gs=1.0, gb=0.14, twin=True, mast=0.16)),
        'corvette': (boat_catamaran, dict(L=1.2, B=0.31)),
        'lander': (boat_hover, dict(look='lcac', L=1.1, B=0.5, gun=True)),
    },
    'russia': {
        'patrol': (boat_patrol, dict(L=0.88, B=0.2, cab=(-0.06, 0.24, 0.15, 0.085), gx=0.25, gs=0.85, gb=0.13, mast=0.12)),
        'corvette': (boat_corvette, dict(L=1.5, B=0.3, sup=(-0.2, 0.3), sh=0.13, mh=0.22, nm=4, rx=-0.36, gx=0.52, stealth=False, gdome=False)),
        'lander': (boat_lander, dict(L=1.05, B=0.34, gun=True)),
    },
    'germany': {
        'patrol': (boat_patrol, dict(L=0.92, B=0.21, cab=(-0.03, 0.3, 0.16, 0.09), gx=0.3, gs=0.9, gb=0.15, mast=0.14)),
        'corvette': (boat_corvette, dict(L=1.55, B=0.29, sup=(-0.18, 0.3), sh=0.14, mh=0.19, nm=2, rx=-0.34, gx=0.52, gdome=True)),
        'lander': (boat_lander, dict(L=1.08, B=0.35)),
    },
    'korea': {
        'patrol': (boat_patrol, dict(L=0.9, B=0.2, cab=(-0.02, 0.28, 0.15, 0.1), gx=0.28, gs=0.95, gb=0.15, twin=True, mast=0.14)),
        'corvette': (boat_corvette, dict(L=1.3, B=0.26, sup=(-0.12, 0.24), sh=0.12, mh=0.17, nm=2, rx=-0.3, gx=0.42, heli=False, gdome=True)),
        'lander': (boat_hover, dict(look='bh7', L=1.12, B=0.5, props=2)),
    },
    'ukraine': {
        'patrol': (boat_usv, dict(L=0.6, B=0.15, gx=0.1)),
        'corvette': (boat_corvette, dict(L=1.5, B=0.3, sup=(-0.14, 0.3), sh=0.13, mh=0.19, nm=2, rx=-0.34, gx=0.5, gdome=True)),
        'lander': (boat_lander, dict(L=0.98, B=0.3, gun=True)),
    },
    'turkey': {
        'patrol': (boat_usv, dict(L=0.74, B=0.18, D=0.05, gx=0.16, pod=True, cabin=True)),
        'corvette': (boat_corvette, dict(L=1.25, B=0.25, sup=(-0.1, 0.24), sh=0.12, mh=0.17, nm=2, rx=-0.28, gx=0.42, heli=False, stealth=False)),
        'lander': (boat_lander, dict(L=1.1, B=0.36)),
    },
    'iran': {
        'patrol': (boat_fac, dict(L=0.62, B=0.17)),
        'corvette': (boat_corvette, dict(L=1.25, B=0.25, sup=(-0.12, 0.22), sh=0.11, mh=0.16, nm=2, rx=-0.3, gx=0.4, heli=False, stealth=False, gdome=False)),
        'lander': (boat_hover, dict(look='bh7', L=1.1, B=0.48, props=1, gun=True)),
    },
}

BUDGET = {'patrol': (1300, 360), 'corvette': (2100, 560), 'lander': (1500, 420)}


def build_boat(nation, kind, info, objs):
    fn, v = DESIGNS[nation][kind]
    P = NATIONS[nation]
    key = f'nv_{nation}_{kind}'
    d = fn(P, v)
    root = bpy.data.objects.new(key, None)
    bpy.context.scene.collection.objects.link(root)
    b0, b1 = BUDGET[kind]
    # (the whole boat is baked together so turret, radar and fans shade the deck and each other, then split again)
    groups = [('_body', d['body'], (0, 0, 0), b0, b1)]
    if d['spin']:
        groups.append(('_spin', d['spin'], None, 60, 24))
    if d['turret']:
        groups.append(('_turret', d['turret'], tuple(d['tpos']), 320, 90))
    for i, (c, r) in enumerate(d.get('fans', [])):
        fp = fan_mesh(r, P['dark'])
        for o in fp:
            o.data.transform(Matrix.Translation(c))
        groups.append((f'_fan{i}', fp, tuple(c), 160, 50))
    PARTS.clear()
    body = assemble(key + '_src', [o for g in groups for o in g[1]])
    bake_ao(body, ground=-0.04, samples=24)
    tris = 0
    for name, ob, pivot, g0, g1 in split_parts(body, groups):
        lo = decimated(ob, g0, f'{key}{name}_lo')
        lo1 = decimated(ob, g1, f'{key}{name}_l1')
        bpy.data.objects.remove(ob)
        lo.name = f'{key}{name}'
        lo.data.name = lo.name
        for o in (lo, lo1):
            o.data.transform(Matrix.Translation(-Vector(pivot)))
            o.location = pivot
            o.parent = root
            smooth(o)
        tris += ntris(lo)
        objs += [lo, lo1]
    # muzzle empty (on the turret if there is one)
    mz = bpy.data.objects.new(f'muzzle_{key}', None)
    bpy.context.scene.collection.objects.link(mz)
    tur = bpy.data.objects.get(f'{key}_turret')
    if tur is not None:
        mz.parent = tur
        mz.location = Vector(d['muzzle']) - Vector(d['tpos'])
    else:
        mz.parent = root
        mz.location = d['muzzle']
    objs += [mz, root]
    info[key] = {'tris': tris, 'len': d['len'], 'beam': d['beam'], 'h': d['h'], 'turret': bool(d['turret']), 'fans': len(d.get('fans', [])), 'spin': bool(d['spin'])}
    return root


def smooth(ob):
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))


def split_parts(o, groups):
    """Separate the joined, baked mesh back into its groups by the source part index of every vertex.
    Yields (suffix, object, pivot, lod0 budget, lod1 budget); pivot None = the group's own bounding-box centre."""
    me = o.data
    start = 0
    out = []
    for name, lst, pivot, g0, g1 in groups:
        ids = set(range(start, start + len(lst)))
        start += len(lst)
        bm = bmesh.new()
        bm.from_mesh(me)
        lay = bm.verts.layers.int.get('src')
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if v[lay] not in ids], context='VERTS')
        m2 = bpy.data.meshes.new(o.name + name)
        bm.to_mesh(m2)
        bm.free()
        for mt in me.materials:
            m2.materials.append(mt)
        if 'src' in m2.attributes:
            m2.attributes.remove(m2.attributes['src'])
        ob = bpy.data.objects.new(o.name + name, m2)
        bpy.context.scene.collection.objects.link(ob)
        if pivot is None:
            vs = np.zeros(len(m2.vertices) * 3)
            m2.vertices.foreach_get('co', vs)
            vs = vs.reshape(-1, 3)
            pivot = tuple(((vs.min(0) + vs.max(0)) / 2).tolist())
        out.append((name, ob, pivot, g0, g1))
    bpy.data.objects.remove(o)
    return out


# ------------------------------------------------------------------ shipyard

def build_shipyard(info, objs):
    """The Shipyard (4 x 4 tiles, water side +X)."""
    RUST = 0xffffff
    CONC = 0xbab5aa
    CONC_D = 0xa39e93
    YEL = 0xd8a520
    STEEL = 0x6c7074
    DARK = 0x3a3c3e
    body = []
    team = []
    # land apron (with a skirt down the bank) and the two piers over the water
    body.append(box(-2.0, 0.0, -2.0, 2.0, -0.55, 0.0, CONC, cell=0.25))
    for sy in (-1, 1):
        body.append(box(0.0, 1.98, min(sy * 0.95, sy * 1.6), max(sy * 0.95, sy * 1.6), -1.8, 0.0, CONC_D, cell=0.25))
        # pier deck edge (a lighter capping beam) and bollards
        for i in range(6):
            x = 0.2 + i * 0.33
            body.append(cyl((x, sy * 1.53, 0.025), 0.022, 0.05, 0x2d2f31, verts=8, cell=0.05))
        # crane rails along the piers
        for dy in (-0.18, 0.18):
            body.append(box(-0.2, 1.95, sy * 1.25 + dy - 0.012, sy * 1.25 + dy + 0.012, 0.0, 0.014, STEEL, cell=0.3))
        # fenders on the basin side
        for i in range(5):
            x = 0.25 + i * 0.4
            body.append(cyl((x, sy * 0.94, -0.05), 0.03, 0.12, 0x1c1c1c, 'Y', 8, cell=0.1))
    # the slipway: a concrete ramp from the hall down into the water, rails on it
    sl = box(-1.6, 2.0, -0.55, 0.55, -0.05, 0.0, CONC_D, cell=0.25)
    for v in sl.data.vertices:
        if v.co.x > -0.2:
            v.co.z -= (v.co.x + 0.2) * 0.32
    body.append(sl)
    for dy in (-0.22, 0.22):
        r = box(-1.6, 2.0, dy - 0.015, dy + 0.015, 0.0, 0.015, STEEL, cell=0.3)
        for v in r.data.vertices:
            if v.co.x > -0.2:
                v.co.z -= (v.co.x + 0.2) * 0.32
        body.append(r)
    # quay wall at the head of the basin
    # the hall: corrugated rust walls, a lower concrete band, the land-end wall with big doors; open to the water
    HX0, HX1, HW, HH = -1.95, 0.7, 0.9, 0.78
    for sy in (-1, 1):
        body.append(box(HX0, HX1, sy * HW - 0.03, sy * HW + 0.03, 0.0, HH, RUST, 'rust', cell=0.18, uvk=2.0))
        body.append(box(HX0, HX1, sy * HW - 0.036, sy * HW + 0.036, 0.0, 0.14, CONC, cell=0.2))
        # window band (high strip of glazing along each side)
        body.append(box(HX0 + 0.1, HX1 - 0.1, sy * HW - 0.037, sy * HW + 0.037, HH - 0.2, HH - 0.12, 0xffffff, 'glaze', cell=0.2, uvk=6.0))
        # columns
        for i in range(9):
            x = HX0 + 0.05 + i * (HX1 - HX0 - 0.1) / 8
            body.append(box(x - 0.025, x + 0.025, sy * HW - 0.05, sy * HW + 0.05, 0.0, HH + 0.02, 0x7d4230, cell=0.2))
    body.append(box(HX0 - 0.03, HX0 + 0.03, -HW, HW, 0.0, HH, RUST, 'rust', cell=0.18, uvk=2.0))
    body.append(box(HX0 - 0.04, HX0 + 0.02, -0.4, 0.4, 0.0, 0.5, 0x5a5e62, cell=0.12))
    # the sea end: a header over the opening
    body.append(box(HX1 - 0.04, HX1 + 0.03, -HW, HW, HH - 0.16, HH, RUST, 'rust', cell=0.2, uvk=2.0))
    team.append(box(HX1 + 0.03, HX1 + 0.045, -HW * 0.8, HW * 0.8, HH - 0.12, HH - 0.04, 0xffffff, 'team', cell=0.2))
    # gable roof: two slopes, a glazed monitor along the ridge, solar panels on the south slope
    RISE = 0.28
    for sy in (-1, 1):
        r = box(HX0 - 0.05, HX1 + 0.05, 0.0 if sy > 0 else -HW - 0.08, HW + 0.08 if sy > 0 else 0.0, HH, HH + 0.02, 0x8f9091, cell=0.2)
        for v in r.data.vertices:
            v.co.z += RISE * (1 - abs(v.co.y) / (HW + 0.08))
        body.append(r)
        # glazed strips down the slope
        for i in range(3):
            x0 = HX0 + 0.25 + i * 0.85
            g = box(x0, x0 + 0.42, 0.12 if sy > 0 else -HW + 0.05, HW - 0.05 if sy > 0 else -0.12, HH + 0.02, HH + 0.03, 0xffffff, 'glaze', cell=0.2, uvk=6.0)
            for v in g.data.vertices:
                v.co.z += RISE * (1 - abs(v.co.y) / (HW + 0.08))
            body.append(g)
        # team-coloured eaves trim
        team.append(box(HX0 - 0.05, HX1 + 0.05, sy * (HW + 0.07) - 0.012, sy * (HW + 0.07) + 0.012, HH - 0.02, HH + 0.015, 0xffffff, 'team', cell=0.25))
    mon = box(HX0 + 0.05, HX1 - 0.05, -0.16, 0.16, HH + RISE - 0.02, HH + RISE + 0.1, 0xffffff, 'glaze', cell=0.2, uvk=6.0)
    body.append(mon)
    body.append(box(HX0 + 0.03, HX1 - 0.03, -0.19, 0.19, HH + RISE + 0.1, HH + RISE + 0.12, 0x7f8182, cell=0.25))
    # solar panels on the -Y slope, tilted south
    for i in range(4):
        x0 = HX0 + 0.12 + i * 0.64
        sp = box(x0, x0 + 0.5, -HW + 0.08, -0.25, HH + 0.05, HH + 0.065, 0xffffff, 'solar', cell=0.25, uvk=4.0)
        for v in sp.data.vertices:
            v.co.z += RISE * (1 - abs(v.co.y) / (HW + 0.08)) + 0.05 * (v.co.y + 0.25) / -0.6
        body.append(sp)
    # the lean-to office along the -Y side (windows, concrete), a flat roof with plant
    body.append(box(-1.9, -0.35, -1.48, -0.93, 0.0, 0.42, 0x9b9387, cell=0.15))
    body.append(box(-1.9, -0.35, -1.485, -1.475, 0.22, 0.32, 0xffffff, 'glaze', cell=0.2, uvk=6.0))
    body.append(box(-1.92, -0.33, -1.5, -0.91, 0.42, 0.45, 0x6d6f70, cell=0.2))
    body.append(box(-1.6, -1.35, -1.35, -1.1, 0.45, 0.55, 0x9a9da0, cell=0.1))
    team.append(box(-1.92, -0.33, -1.505, -1.495, 0.38, 0.42, 0xffffff, 'team', cell=0.2))
    # container yard on the +Y land corner (stacked, weathered colours)
    cols = [0x8a3326, 0x2d5a7a, 0x5f7a3a, 0xa87a2a, 0x7a7d80, 0x3d6b66, 0x91512e]
    k = 0
    for row in range(2):
        for i in range(4):
            x0 = -1.9 + i * 0.38
            y0 = 1.05 + row * 0.26
            levels = 1 + ((i + row * 3) % 3 == 0)
            for lv in range(levels):
                body.append(box(x0, x0 + 0.34, y0, y0 + 0.2, 0.0 + lv * 0.18, 0.17 + lv * 0.18, cols[k % len(cols)], cell=0.12))
                k += 1
    # a jib crane at the quay head (+Y)
    body.append(bar((-0.15, 1.55, 0.0), (-0.15, 1.55, 0.95), 0.03, YEL))
    body.append(bar((-0.15, 1.55, 0.9), (0.45, 1.25, 1.02), 0.02, YEL))
    body.append(bar((0.45, 1.25, 1.02), (0.45, 1.25, 0.6), 0.004, DARK))
    # floodlight poles (lamps are their heads)
    lamps = []
    for (x, y) in ((1.9, 1.55), (1.9, -1.55), (-0.1, -1.6), (0.75, 1.0), (0.75, -1.0)):
        body.append(bar((x, y, 0.0), (x, y, 0.75), 0.012, STEEL))
        lamps.append(lamp(x - 0.03, y, 0.76, 0xfff0d0, 0.02))
        info.setdefault('yard_lamps', []).append([x - 0.03, 0.76, -y])
    # bow-rails / fence along the land edge
    # the gantry crane over the water end: two yellow legs per side on the rails, a box girder with a team band
    GX = 1.3
    gant = []
    for sy in (-1, 1):
        for dx in (-0.16, 0.16):
            gant.append(bar((GX + dx, sy * 1.25, 0.0), (GX + dx * 0.4, sy * 1.25, 1.12), 0.03, YEL))
        gant.append(box(GX - 0.22, GX + 0.22, sy * 1.25 - 0.06, sy * 1.25 + 0.06, 0.0, 0.06, YEL, cell=0.1))
    gant.append(box(GX - 0.09, GX + 0.09, -1.35, 1.35, 1.1, 1.24, YEL, cell=0.15))
    team.append(box(GX + 0.09, GX + 0.095, -1.0, 1.0, 1.13, 1.21, 0xffffff, 'team', cell=0.2))
    # the crab (trolley) on the girder: its own object, travels while a hull is being built
    trol = [box(GX - 0.11, GX + 0.11, -0.13, 0.13, 1.24, 1.33, 0xc85a1e, cell=0.08), bar((GX, 0, 1.1), (GX, 0, 0.62), 0.005, DARK), box(GX - 0.06, GX + 0.06, -0.04, 0.04, 0.56, 0.62, 0xc85a1e, cell=0.05)]
    # hull on the slipway: a part-built ship (grey primer, red bottom) under scaffolding
    hb = []
    hh, hd = hull(2.0, 0.6, 0.22, 0.12, srgb(0x7d8287), 0x5a5d60, bow=0.35, transom=0.85, deadrise=0.3, sheer=0.05, flare=0.04, n=18)
    for o in (hh, hd):
        o.data.transform(Matrix.Translation((0.05, 0, 0.12)) @ Matrix.Rotation(-math.atan(0.12), 4, 'Y'))
    hb += [hh, hd]
    sup = box(-0.55, 0.0, -0.18, 0.18, 0.3, 0.42, 0x6d7276, cell=0.08)
    sup.data.transform(Matrix.Rotation(-math.atan(0.12), 4, 'Y'))
    hb.append(sup)
    for x in (-0.8, -0.3, 0.2, 0.7):
        for sy in (-1, 1):
            hb.append(bar((x, sy * 0.36, 0.0), (x, sy * 0.36, 0.55 - x * 0.12), 0.008, 0xb08a30))
    # assemble the pieces
    PARTS.clear()
    yard = assemble('shipyard_body', body + team + lamps)
    bake_ao(yard, ground=None, samples=24)
    lo, l1 = decimated(yard, 7000, 'shipyard_lo'), decimated(yard, 2200, 'shipyard_body_l1')
    bpy.data.objects.remove(yard)
    lo.name = 'shipyard_body'
    lo.data.name = 'shipyard_body'
    root = bpy.data.objects.new('shipyard', None)
    bpy.context.scene.collection.objects.link(root)
    out = [root]
    for ob in (lo, l1):
        ob.parent = root
        smooth(ob)
        out.append(ob)
    tris = ntris(lo)
    for nm, plist, budget in (('shipyard_gantry', gant, 1400), ('shipyard_trolley', trol, 300), ('shipyard_hull', hb, 1600)):
        PARTS.clear()
        g = assemble(nm + '_src', plist)
        bake_ao(g, ground=0.0, samples=16)
        a = decimated(g, budget, nm + '_lo')
        b = decimated(g, budget // 3, nm + '_l1')
        bpy.data.objects.remove(g)
        a.name = nm
        a.data.name = nm
        for ob in (a, b):
            ob.parent = root
            smooth(ob)
            out.append(ob)
        tris += ntris(a)
    info['shipyard'] = {'tris': tris}
    objs += out
    return root


# ------------------------------------------------------------------ textures (numpy, tileable)

def tex_rust(N=256):
    rng = np.random.default_rng(7)
    u = np.arange(N)[None, :] / N
    v = np.arange(N)[:, None] / N
    # corrugation: vertical ribs (16 per repeat)
    rib = 0.5 + 0.5 * np.cos(u * 2 * np.pi * 16)
    base = np.array(srgb(0xb04a22))
    dark = np.array(srgb(0x5e2612))
    light = np.array(srgb(0xd0804a))

    def tile_noise(cells, seed):
        g = np.random.default_rng(seed).random((cells, cells))
        xs = np.arange(N) / N * cells
        i0 = np.floor(xs).astype(int)
        f = xs - i0
        f = f * f * (3 - 2 * f)
        a = g[np.ix_(i0 % cells, i0 % cells)]
        b = g[np.ix_(i0 % cells, (i0 + 1) % cells)]
        c = g[np.ix_((i0 + 1) % cells, i0 % cells)]
        d = g[np.ix_((i0 + 1) % cells, (i0 + 1) % cells)]
        fy = f[:, None]
        fx = f[None, :]
        return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy

    n1 = tile_noise(8, 1) * 0.6 + tile_noise(32, 2) * 0.4
    # rust streaks running down from the panel tops, darker runs, a few faded patches of the old paint
    streak = tile_noise(64, 3)[:1, :].repeat(N, 0) * (0.5 + 0.5 * v)
    runs = np.clip(tile_noise(128, 4)[:1, :].repeat(N, 0) * 2.2 - 1.3, 0, 1) * (0.3 + 0.7 * v)
    k = np.clip((n1 - 0.5) * 2.2 + streak * 0.6, 0, 1)
    col = base[None, None, :] * (1 - k[..., None]) + light[None, None, :] * k[..., None]
    col = col * (1 - runs[..., None] * 0.55) + dark[None, None, :] * runs[..., None] * 0.55
    faded = np.clip((tile_noise(4, 5) - 0.62) * 5, 0, 1)[..., None]
    col = col * (1 - faded * 0.45) + np.array(srgb(0x9a6a52))[None, None, :] * faded * 0.45
    col *= (0.8 + 0.2 * rib)[..., None]
    # panel seams every quarter
    seam = (np.abs((v * 4) % 1 - 0.5) > 0.485)[..., None]
    col = np.where(seam, col * 0.55, col)
    # normal map: the ribs
    du = -np.sin(u * 2 * np.pi * 16) * 0.55
    nrm = np.stack([np.broadcast_to(du, (N, N)), np.zeros((N, N)), np.ones((N, N))], -1)
    nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
    return col, nrm * 0.5 + 0.5


def tex_glaze(N=128):
    u = np.arange(N)[None, :] / N
    v = np.arange(N)[:, None] / N
    frame = ((np.abs((u * 4) % 1 - 0.5) > 0.44) | (np.abs((v * 2) % 1 - 0.5) > 0.44))
    sky = np.array(srgb(0x5d7a90)) * (0.7 + 0.5 * (1 - v))[..., None]
    glass = sky * (0.75 + 0.25 * np.sin(u * 9 + v * 4)[..., None])
    col = np.where(frame[..., None], np.array(srgb(0xb8bcbf))[None, None, :], glass)
    return col, None


def tex_solar(N=128):
    u = np.arange(N)[None, :] / N
    v = np.arange(N)[:, None] / N
    grid = ((np.abs((u * 8) % 1 - 0.5) > 0.46) | (np.abs((v * 4) % 1 - 0.5) > 0.46))
    cell = np.array(srgb(0x1c2a4a)) * (0.85 + 0.3 * v)[..., None]
    col = np.where(grid[..., None], np.array(srgb(0x9aa0a8))[None, None, :], cell)
    return col, None


def save_png(path, rgb, linear=True):
    N = rgb.shape[0]
    img = bpy.data.images.new(os.path.basename(path), N, rgb.shape[1], alpha=False, float_buffer=False)
    if not linear:
        img.colorspace_settings.name = 'Non-Color'
    c = np.ones((rgb.shape[0], rgb.shape[1], 4), dtype=np.float32)
    x = np.clip(rgb, 0, 1)
    if linear:
        x = np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)
        img.colorspace_settings.name = 'Non-Color'
    c[..., :3] = x
    img.pixels.foreach_set(np.flipud(c).ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()


def textures():
    r, n = tex_rust()
    save_png(os.path.join(OUT, 'naval-rust.png'), r)
    save_png(os.path.join(OUT, 'naval-rust-n.png'), n, linear=False)
    save_png(os.path.join(OUT, 'naval-glaze.png'), tex_glaze()[0])
    save_png(os.path.join(OUT, 'naval-solar.png'), tex_solar()[0])


# ------------------------------------------------------------------ main

def build_kit():
    reset()
    w = bpy.data.worlds.new('w')
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (1, 1, 1, 1)
    bpy.context.scene.world = w
    info = {}
    objs = []
    t = time.time()
    build_shipyard(info, objs)
    print(f'[naval] shipyard {info["shipyard"]["tris"]} tris ({time.time() - t:.0f} s)', flush=True)
    for nation in DESIGNS:
        for kind in ('patrol', 'corvette', 'lander'):
            t = time.time()
            build_boat(nation, kind, info, objs)
            print(f'[naval] nv_{nation}_{kind} {info[f"nv_{nation}_{kind}"]["tris"]} tris ({time.time() - t:.0f} s)', flush=True)
    # (the vertex colour the exporter takes: 'Col' on every mesh)
    for o in objs:
        if o.type == 'MESH' and 'Col' in o.data.color_attributes:
            ca = o.data.color_attributes
            ca.active_color = ca['Col']
            ca.render_color_index = ca.active_color_index
    # one file for the Shipyard, one per nation (a match loads the yard and its two nations' boats only)
    groups = {'shipyard': []}
    for o in objs:
        top = o
        while top.parent is not None:
            top = top.parent
        g = 'shipyard' if top.name == 'shipyard' else top.name.split('_')[1]
        groups.setdefault(g, []).append(o)
    for g, lst in groups.items():
        bpy.ops.object.select_all(action='DESELECT')
        for o in lst:
            o.select_set(True)
        bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, f'naval-{g}-raw.glb'), export_format='GLB', use_selection=True, export_apply=True, export_yup=True, export_normals=True, export_texcoords=False, export_materials='EXPORT', export_vertex_color='ACTIVE', export_all_vertex_colors=False, export_image_format='NONE')
    with open(os.path.join(OUT, 'naval.json'), 'w') as f:
        json.dump(info, f, indent=1)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'naval.blend'))
    print('[naval] OK_DONE', flush=True)


# ------------------------------------------------------------------ contact sheet and cameos (Cycles)

def preview_setup(team=(0.12, 0.35, 0.95)):
    """Viewport-free materials for the renders: vertex colours, the team colour, the hall's tiled maps."""
    imgs = {}
    for k in ('rust', 'glaze', 'solar'):
        imgs[k] = bpy.data.images.load(os.path.join(OUT, f'naval-{k}.png'))
    for name in MATS:
        m = bpy.data.materials.get(name)
        if m is None:
            continue
        nt = m.node_tree
        for n in list(nt.nodes):
            nt.nodes.remove(n)
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
        nt.links.new(bsdf.outputs[0], out.inputs[0])
        col = nt.nodes.new('ShaderNodeVertexColor')
        col.layer_name = 'Col'
        base = col.outputs['Color']
        if name == 'team':
            mul = nt.nodes.new('ShaderNodeMix')
            mul.data_type = 'RGBA'
            mul.blend_type = 'MULTIPLY'
            mul.inputs['Factor'].default_value = 1
            mul.inputs['A'].default_value = (*team, 1)
            nt.links.new(base, mul.inputs['B'])
            base = mul.outputs['Result']
        if name in imgs:
            uv = nt.nodes.new('ShaderNodeUVMap')
            tx = nt.nodes.new('ShaderNodeTexImage')
            tx.image = imgs[name]
            nt.links.new(uv.outputs[0], tx.inputs[0])
            mul = nt.nodes.new('ShaderNodeMix')
            mul.data_type = 'RGBA'
            mul.blend_type = 'MULTIPLY'
            mul.inputs['Factor'].default_value = 1
            nt.links.new(tx.outputs['Color'], mul.inputs['A'])
            nt.links.new(base, mul.inputs['B'])
            base = mul.outputs['Result']
        nt.links.new(base, bsdf.inputs['Base Color'])
        bsdf.inputs['Roughness'].default_value = {'glass': 0.1, 'solar': 0.25, 'glaze': 0.15}.get(name, 0.62)
        bsdf.inputs['Metallic'].default_value = {'glass': 0.4, 'glaze': 0.3, 'solar': 0.2}.get(name, 0.15)
        if name == 'lamp':
            nt.links.new(col.outputs['Color'], bsdf.inputs['Emission Color'])
            bsdf.inputs['Emission Strength'].default_value = 2.0


def sea_and_shore(size=60, shore=None):
    """A sea plane at z = 0 (and, for the shipyard, sand from x < shore)."""
    w = bpy.data.materials.new('sea')
    w.use_nodes = True
    b = w.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (0.02, 0.12, 0.14, 1)
    b.inputs['Roughness'].default_value = 0.08
    b.inputs['Metallic'].default_value = 0.0
    bpy.ops.mesh.primitive_plane_add(size=size, location=(0, 0, -0.012))
    sea = bpy.context.active_object
    sea.data.materials.append(w)
    out = [sea]
    if shore is not None:
        s = bpy.data.materials.new('sand')
        s.use_nodes = True
        s.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.55, 0.42, 0.26, 1)
        s.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.95
        bpy.ops.mesh.primitive_plane_add(size=1, location=(shore - 15, 0, 0.0))
        sd = bpy.context.active_object
        sd.scale = (30, 60, 1)
        sd.data.materials.append(s)
        out.append(sd)
    return out


def camera_sun(cam_loc, look, lens, size, samples, path):
    sc = bpy.context.scene
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    sc.collection.objects.link(cam)
    cam.location = cam_loc
    cam.rotation_euler = (Vector(look) - Vector(cam_loc)).to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = lens
    sc.camera = cam
    sl = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sc.collection.objects.link(sl)
    sl.rotation_euler = (0.8, 0.15, 2.3)
    sl.data.energy = 4.2
    sl.data.angle = math.radians(2)
    w = bpy.data.worlds.new('sky')
    sc.world = w
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs[0].default_value = (0.5, 0.62, 0.78, 1)
    w.node_tree.nodes['Background'].inputs[1].default_value = 1.0
    sc.render.resolution_x, sc.render.resolution_y = size
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.render.film_transparent = False
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)
    bpy.data.objects.remove(sl)


def roots():
    return sorted([o for o in bpy.data.objects if o.type == 'EMPTY' and o.parent is None and (o.name == 'shipyard' or o.name.startswith('nv_'))], key=lambda o: o.name)


def show_only(keep):
    """Hide every model but `keep`, and their far LODs."""
    for o in bpy.data.objects:
        if o.type in ('MESH', 'EMPTY') and not o.name.startswith(('sea', 'Plane', 'sand')):
            top = o
            while top.parent is not None:
                top = top.parent
            hide = top.name not in keep or o.name.endswith('_l1')
            o.hide_render = hide


def sheet():
    bpy.ops.wm.open_mainfile(filepath=os.path.join(OUT, 'naval.blend'))
    preview_setup()
    rs = roots()
    boats = [r for r in rs if r.name != 'shipyard']
    yard = bpy.data.objects['shipyard']
    yard.location = (0, 0, 0.25)
    # the boats in rows by nation (patrol, corvette, lander), the yard alongside
    nations = list(DESIGNS)
    for r in boats:
        _, n, k = r.name.split('_')
        # rows by type (patrol, corvette, landing craft) across the sea, a column per nation
        r.location = (3.0 + ['patrol', 'corvette', 'lander'].index(k) * 2.1, (nations.index(n) - 4) * 0.72, 0)
    show_only({r.name for r in rs})
    sea_and_shore(80, shore=0.1)
    sc = bpy.context.scene
    camera_sun((11.0, -9.0, 8.0), (3.2, 0.0, 0.1), 34, (2000, 1200), 48, os.path.join(OUT, 'naval-sheet.png'))
    print('[naval] sheet', flush=True)


def cameos():
    bpy.ops.wm.open_mainfile(filepath=os.path.join(OUT, 'naval.blend'))
    preview_setup()
    sea = sea_and_shore(80, shore=None)
    sand = None
    for r in roots():
        show_only({r.name})
        r.location = (0, 0, 0)
        if r.name == 'shipyard':
            if sand is None:
                sand = sea_and_shore(80, shore=0.1)[1]
            sand.hide_render = False
            r.location = (0, 0, 0.25)
            camera_sun((5.6, -5.0, 4.0), (0.2, 0.0, 0.35), 34, (576, 432), 40, os.path.join(OUT, 'cameo-shipyard.png'))
            sand.hide_render = True
            continue
        L = 1.0
        for c in r.children:
            if c.type == 'MESH' and not c.name.endswith('_l1') and c.dimensions.x > L:
                L = c.dimensions.x
        k = max(0.8, L)
        key = r.name.split('_', 1)[1]  # (cameo file: <nation>_<kind>, the unit def id)
        camera_sun((1.25 * k, -1.05 * k, 0.65 * k), (0.0, 0.0, 0.08), 40, (576, 432), 40, os.path.join(OUT, f'cameo-{key}.png'))
        print(f'[naval] cameo {key}', flush=True)


if __name__ == '__main__':
    if STEP in ('kit', 'all'):
        textures()
        build_kit()
    if STEP in ('sheet', 'all'):
        sheet()
    if STEP in ('cameos', 'all'):
        cameos()
