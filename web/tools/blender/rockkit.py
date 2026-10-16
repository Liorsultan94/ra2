# Blender 5.2.2 (LTS) - the desert's rock kit (GD4: Wadi Al-Rimal's granite boulders, rockfall talus and scree).
#
#   /opt/blender/blender -b --factory-startup -P web/tools/blender/rockkit.py -- <out_dir> [preview=1]
#   (or web/tools/blender/bake-rocks.sh, which also packs the GLB into public/tex/rocks/rockkit.glb)
#
# Sculpted high-poly rocks (numpy displacement of dense meshes: superellipsoid blocks, plane-cut polyhedra), each baked and reduced
# to two levels of detail for instancing (src/render/rockkit.ts, placed by rocks.ts and canyon.ts):
#   tor       a granite tor: rounded joint blocks stacked on each other (the mesa rims, the Jebel's crests)
#   corestone a weathered granite corestone, an exfoliation flake spalled off and a crack splitting it
#   boulder   a rounded boulder with a sheet-joint bench
#   slab      a flat, broken stone (scree on the slopes)
#   talus1/2  angular blocks fallen from the cliffs: fresh fracture faces, chipped edges
#   chip      a small angular fragment (scree, rockfall at the cliff feet)
# The game draws them with the cliffs' triplanar granite / sandstone (rockdetail.ts): no UVs, no textures of their
# own. Per vertex colour (baked from the high-poly before the reduction):
#   R  ambient occlusion (Cycles bake)
#   G  fresh fracture (the faces broken off recently: paler, not yet varnished)
#   B  convexity (worn, dusty edges)
# Every rock is normalised like the scanned rocks of rocks.ts: horizontal radius 1, base at y = -0.4 (glTF, +Y up).
# Output: <out>/rockkit-raw.glb (meshes <key>_hi / <key>_lo), <out>/rockkit.json (triangles), and with preview=1 a
# Cycles render of the set (<out>/rockkit_preview.png).
import bpy
import bmesh
import json
import math
import os
import sys
import time

import numpy as np
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else '/tmp/rockkit'
PREVIEW = len(argv) > 1 and argv[1] == '1'
os.makedirs(OUT, exist_ok=True)

# key: (near triangles, far triangles)
KIT = {
    'tor': (1400, 300),
    'corestone': (1100, 240),
    'boulder': (900, 200),
    'slab': (320, 80),
    'talus1': (560, 130),
    'talus2': (560, 130),
    'chip': (140, 44),
}


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.render.threads_mode = 'FIXED'
    sc.render.threads = 3
    sc.cycles.use_denoising = False
    return sc


# ------------------------------------------------------------------ deterministic noise (numpy)

def _hash3(ix, iy, iz, seed):
    h = (ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 144665) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFFFF) / float(0xFFFFFF)


def vnoise(P, seed=0):
    """Value noise in 3D (P: N x 3), -0.5..0.5, smooth."""
    Pf = np.floor(P)
    f = P - Pf
    f = f * f * (3 - 2 * f)
    i = Pf.astype(np.int64)
    out = np.zeros(len(P))
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
                out += w * _hash3(i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz, seed)
    return out - 0.5


def fbm(P, octaves=4, seed=0, lac=2.03, gain=0.5):
    out = np.zeros(len(P))
    a = 1.0
    for o in range(octaves):
        out += a * vnoise(P, seed + o * 17)
        P = P * lac + 3.17
        a *= gain
    return out


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# ------------------------------------------------------------------ meshes

def mesh_from(name, co, faces):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in co], [], [tuple(f) for f in faces])
    me.update()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def ico(name, sub):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def get_co(o):
    a = np.zeros(len(o.data.vertices) * 3)
    o.data.vertices.foreach_get('co', a)
    return a.reshape(-1, 3)


def set_co(o, co):
    o.data.vertices.foreach_set('co', co.astype(np.float32).ravel())
    o.data.update()


def apply_mod(o, kind, **kw):
    m = o.modifiers.new('m', kind)
    for k, v in kw.items():
        setattr(m, k, v)
    bpy.context.view_layer.objects.active = o
    for ob in bpy.context.selected_objects:
        ob.select_set(False)
    o.select_set(True)
    bpy.ops.object.modifier_apply(modifier=m.name)


def superellipsoid(name, sc, p, rot, at, sub=5):
    """A rounded box: |x|^p + |y|^p + |z|^p = 1 scaled by sc, rotated (z angle), moved to at."""
    o = ico(name, sub)
    d = get_co(o)
    r = np.power(np.sum(np.power(np.abs(d), p), 1), -1.0 / p)
    co = d * r[:, None] * np.array(sc)[None, :]
    c, s = math.cos(rot), math.sin(rot)
    co = co @ np.array([[c, s, 0], [-s, c, 0], [0, 0, 1]])
    set_co(o, co + np.array(at)[None, :])
    return o


def join(objs, name):
    for ob in bpy.context.selected_objects:
        ob.select_set(False)
    for ob in objs:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    return o


def vnormals(o):
    o.data.update()
    n = np.zeros(len(o.data.vertices) * 3)
    o.data.vertices.foreach_get('normal', n)
    return n.reshape(-1, 3)


def convexity(o):
    """Per vertex: how far it stands out of its ring of neighbours along the normal (+ convex, - concave)."""
    co = get_co(o)
    nrm = vnormals(o)
    ed = np.zeros(len(o.data.edges) * 2, dtype=np.int64)
    o.data.edges.foreach_get('vertices', ed)
    ed = ed.reshape(-1, 2)
    acc = np.zeros_like(co)
    cnt = np.zeros(len(co))
    np.add.at(acc, ed[:, 0], co[ed[:, 1]])
    np.add.at(acc, ed[:, 1], co[ed[:, 0]])
    np.add.at(cnt, ed[:, 0], 1)
    np.add.at(cnt, ed[:, 1], 1)
    avg = acc / np.maximum(cnt, 1)[:, None]
    return np.sum((co - avg) * nrm, 1)


def remesh(o, voxel):
    apply_mod(o, 'REMESH', mode='VOXEL', voxel_size=voxel, use_smooth_shade=True)


def grain(co, nrm, seed, amp=0.012, big=0.05):
    """Weathered granite surface: broad lumps, knobs and a grainy (grus) roughness, along the normals."""
    d = big * fbm(co * 1.6, 3, seed) + amp * fbm(co * 9.0, 3, seed + 50) + amp * 0.35 * vnoise(co * 34.0, seed + 90)
    return co + nrm * d[:, None]


# ------------------------------------------------------------------ the rocks (Blender Z up, sculpted at ~unit size)

def rock_tor(rng):
    blocks = []
    # a granite tor: joint blocks (squarish, rounded at the edges by weathering) stacked and slipped on each other -
    # a broad bed block, two on it, a cap stone, a block fallen against the side
    specs = [((1.05, 0.78, 0.36), 4.2, 0.15, (0, 0, 0.0)), ((0.6, 0.5, 0.3), 3.8, 0.55, (0.32, -0.08, 0.6)), ((0.42, 0.5, 0.28), 4.0, 0.25, (-0.45, 0.12, 0.58)), ((0.38, 0.32, 0.22), 3.4, -0.4, (0.2, 0.05, 1.05)), ((0.42, 0.36, 0.3), 3.6, 1.1, (-0.95, 0.42, -0.08))]
    for k, (sc, p, rot, at) in enumerate(specs):
        sc = tuple(v * rng.uniform(0.9, 1.1) for v in sc)
        b = superellipsoid(f'b{k}', sc, p, rot + rng.uniform(-0.2, 0.2), at, 5)
        co = get_co(b)
        nrm = (co - np.array(at)[None, :])
        nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
        set_co(b, grain(co, nrm, 11 + k, 0.01, 0.035))
        blocks.append(b)
    return join(blocks, 'tor'), None


def rock_corestone(rng):
    o = superellipsoid('core', (1.0, 0.8, 0.6), 2.9, 0.3, (0, 0, 0), 6)
    co = get_co(o)
    nrm = co / np.linalg.norm(co, axis=1, keepdims=True)
    co = co + nrm * (0.14 * fbm(co * 1.3, 3, 21))[:, None]
    # an exfoliation flake spalled off one shoulder: a shallow step where the outer sheet broke away
    n1 = np.array([0.55, -0.45, 0.7])
    n1 /= np.linalg.norm(n1)
    e = co @ n1 - 0.48 + 0.04 * fbm(co * 4.0, 2, 22)
    co = co - n1[None, :] * (0.07 * sstep(-0.01, 0.03, e))[:, None]
    fresh = sstep(0.0, 0.05, e)
    # a crack splitting the stone (a V groove round a near-vertical plane)
    n2 = np.array([0.8, 0.45, -0.4])
    n2 /= np.linalg.norm(n2)
    dist = co @ n2 - 0.38 + 0.04 * fbm(co * 3.0, 2, 23)
    groove = np.exp(-np.square(dist / 0.022)) * sstep(-0.2, 0.5, co[:, 2] + 0.3 * fbm(co * 2.0, 2, 25))
    co = co - nrm * (0.045 * groove)[:, None]
    co = grain(co, nrm, 24, 0.011, 0.0)
    set_co(o, co)
    return o, fresh


def rock_boulder(rng):
    o = superellipsoid('bld', (1.0, 0.86, 0.62), 2.7, 0.0, (0, 0, 0), 6)
    co = get_co(o)
    nrm = co / np.linalg.norm(co, axis=1, keepdims=True)
    co = co + nrm * (0.16 * fbm(co * 1.1, 3, 31))[:, None]
    # a sheet-joint bench on one side
    z = co[:, 2] - 0.18 + 0.05 * fbm(co * 3.0, 2, 32)
    side = sstep(-0.2, 0.3, co[:, 0])
    co[:, 0] -= 0.08 * sstep(-0.02, 0.02, z) * side
    co = grain(co, nrm, 33, 0.012, 0.0)
    set_co(o, co)
    return o, None


def polyhedron(rng, n_planes, flat=1.0, seed=0, sub=6):
    """An angular block: the intersection of random half-spaces, sampled by a dense icosphere (fracture faces);
    returns the object and the index of the plane each vertex lies on."""
    o = ico('poly', sub)
    d = get_co(o)
    d /= np.linalg.norm(d, axis=1, keepdims=True)
    # fracture planes spread round the block (a jittered Fibonacci sphere: no open side), a little flattened
    k = np.arange(n_planes) + 0.5
    phi = np.arccos(1 - 2 * k / n_planes)
    th = math.pi * (1 + 5 ** 0.5) * k + rng.uniform(0, 6.28)
    ns = np.stack([np.sin(phi) * np.cos(th), np.sin(phi) * np.sin(th), np.cos(phi) * 0.7], 1) + rng.normal(0, 0.18, (n_planes, 3))
    ns /= np.linalg.norm(ns, axis=1, keepdims=True)
    # a flat bed underneath, a flatter top for slabs
    ns = np.vstack([ns, [[0, 0, -1], [0, 0, 1]]])
    off = np.concatenate([rng.uniform(0.62, 0.85, n_planes), [0.42 * flat + 0.2, 0.6 * flat + 0.15]])
    dn = d @ ns.T
    t = np.where(dn > 1e-4, off[None, :] / np.maximum(dn, 1e-4), 9.0)
    r = np.minimum(t.min(1), 1.25)
    face = t.argmin(1)
    co = d * r[:, None]
    return o, co, face, ns


def rock_angular(rng, seed, n_planes, flat=1.0, weathered=0.4):
    o, co, face, ns = polyhedron(rng, n_planes, flat, seed)
    set_co(o, co)
    # round the edges a little (two smoothing passes keep the fracture faces flat)
    apply_mod(o, 'SMOOTH', factor=0.5, iterations=3)
    co = get_co(o)
    nrm = vnormals(o)
    # conchoidal fracture ripples on the faces, chipped edges
    co = co + nrm * (0.025 * fbm(co * 3.2, 3, seed) + 0.006 * vnoise(co * 22.0, seed + 5))[:, None]
    cvx = convexity(o)
    chip = sstep(0.004, 0.02, cvx) * sstep(0.1, 0.3, vnoise(co * 6.0, seed + 7) + 0.3)
    co = co - nrm * (0.03 * chip)[:, None]
    set_co(o, co)
    # which faces broke recently (fresh) and which weathered on the cliff before the fall
    fresh_plane = rng.random(len(ns)) > weathered
    fresh = fresh_plane[face].astype(np.float64)
    return o, fresh


# ------------------------------------------------------------------ bake + reduce

def bake_ao(o):
    """Cycles AO baked into the vertex colours (R); G fresh, B convexity are written alongside."""
    me = o.data
    attr = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    me.color_attributes.active_color = attr
    mat = bpy.data.materials.new('bake')
    mat.use_nodes = True
    me.materials.clear()
    me.materials.append(mat)
    sc = bpy.context.scene
    sc.cycles.samples = 64
    sc.render.bake.target = 'VERTEX_COLORS'
    sc.render.bake.margin = 0
    # a ground plane under it (contact occlusion at the foot)
    bpy.ops.mesh.primitive_plane_add(size=8, location=(0, 0, get_co(o)[:, 2].min() + 0.06))
    plane = bpy.context.active_object
    for ob in bpy.context.selected_objects:
        ob.select_set(False)
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    sc.world = sc.world or bpy.data.worlds.new('w')
    bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')
    bpy.data.objects.remove(plane)
    a = np.zeros(len(me.vertices) * 4, dtype=np.float32)
    attr.data.foreach_get('color', a)
    return a.reshape(-1, 4)[:, 0].astype(np.float64)


def write_colors(o, ao, fresh, cvx):
    me = o.data
    attr = me.color_attributes.get('Col') or me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    c = np.stack([ao, fresh, cvx, np.ones_like(ao)], 1).astype(np.float32)
    attr.data.foreach_set('color', c.ravel())
    me.color_attributes.active_color = attr


def normalise(o):
    co = get_co(o)
    co[:, :2] -= co[:, :2].mean(0)
    r = np.sqrt(np.square(co[:, 0]) + np.square(co[:, 1])).max()
    co /= r
    co[:, 2] += -0.4 - co[:, 2].min()
    set_co(o, co)


def reduce(o, tris, name, sharp_deg):
    lo = o.copy()
    lo.data = o.data.copy()
    lo.name = name
    bpy.context.scene.collection.objects.link(lo)
    cur = sum(len(p.vertices) - 2 for p in lo.data.polygons)
    apply_mod(lo, 'DECIMATE', decimate_type='COLLAPSE', ratio=min(1.0, tris / max(1, cur)), use_collapse_triangulate=True)
    lo.data.polygons.foreach_set('use_smooth', np.ones(len(lo.data.polygons), dtype=bool))
    if sharp_deg:
        bpy.context.view_layer.objects.active = lo
        for ob in bpy.context.selected_objects:
            ob.select_set(False)
        lo.select_set(True)
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(sharp_deg))
    return lo


def build_all():
    sc = reset()
    w = bpy.data.worlds.new('w')
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (1, 1, 1, 1)
    sc.world = w
    makers = {
        'tor': lambda r: rock_tor(r),
        'corestone': lambda r: rock_corestone(r),
        'boulder': lambda r: rock_boulder(r),
        'slab': lambda r: rock_angular(r, 41, 7, flat=0.35, weathered=0.7),
        'talus1': lambda r: rock_angular(r, 51, 8, flat=0.9, weathered=0.35),
        'talus2': lambda r: rock_angular(r, 61, 6, flat=0.75, weathered=0.45),
        'chip': lambda r: rock_angular(r, 71, 6, flat=0.6, weathered=0.5),
    }
    out = []
    info = {}
    for k, (hi_t, lo_t) in KIT.items():
        t = time.time()
        rng = np.random.default_rng(sum(map(ord, k)))
        o, fresh = makers[k](rng)
        o.name = k + '_src'
        normalise(o)
        o.data.polygons.foreach_set('use_smooth', np.ones(len(o.data.polygons), dtype=bool))
        cvx = convexity(o)
        cvx = np.clip(0.5 + cvx * 25.0, 0, 1)
        if fresh is None:
            fresh = np.zeros(len(o.data.vertices))
        ao = bake_ao(o)
        write_colors(o, ao, fresh, cvx)
        angular = k in ('slab', 'talus1', 'talus2', 'chip')
        hi = reduce(o, hi_t, k + '_hi', 38 if angular else 0)
        lo = reduce(o, lo_t, k + '_lo', 38 if angular else 0)
        bpy.data.objects.remove(o)
        tri = lambda ob: sum(len(p.vertices) - 2 for p in ob.data.polygons)
        info[k] = {'hi': tri(hi), 'lo': tri(lo), 'ao': round(float(ao.mean()), 3)}
        print(f'TRIS {k}: hi {info[k]["hi"]} lo {info[k]["lo"]}  ao mean {ao.mean():.3f}  ({time.time() - t:.0f} s)')
        out += [hi, lo]
        # (out of the next bakes' way: their occlusion must not see this one)
        hi.location.x += 50 * len(out)
        lo.location.x += 50 * len(out)
    for ob in out:
        ob.location = (0, 0, 0)
    for ob in bpy.context.selected_objects:
        ob.select_set(False)
    for ob in out:
        ob.select_set(True)
        ob.data.materials.clear()
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'rockkit-raw.glb'), export_format='GLB', use_selection=True, export_apply=True, export_yup=True, export_normals=True, export_texcoords=False, export_materials='NONE', export_vertex_color='ACTIVE', export_all_vertex_colors=False)
    with open(os.path.join(OUT, 'rockkit.json'), 'w') as f:
        json.dump(info, f, indent=1)
    if PREVIEW:
        preview(out)


def preview(objs):
    sc = bpy.context.scene
    his = [o for o in objs if o.name.endswith('_hi')]
    for o in objs:
        o.hide_render = not o.name.endswith('_hi')
    m = bpy.data.materials.new('pv')
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    ca = nt.nodes.new('ShaderNodeVertexColor')
    ca.layer_name = 'Col'
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(ca.outputs['Color'], sep.inputs[0])
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.inputs[6].default_value = (0.32, 0.2, 0.14, 1)
    mix.inputs[7].default_value = (0.55, 0.38, 0.3, 1)
    nt.links.new(sep.outputs['Green'], mix.inputs[0])
    mul = nt.nodes.new('ShaderNodeMix')
    mul.data_type = 'RGBA'
    mul.blend_type = 'MULTIPLY'
    mul.inputs[0].default_value = 1.0
    nt.links.new(mix.outputs[2], mul.inputs[6])
    nt.links.new(sep.outputs['Red'], mul.inputs[7])
    nt.links.new(mul.outputs[2], bsdf.inputs['Base Color'])
    for i, o in enumerate(his):
        o.data.materials.append(m)
        o.location = ((i % 4) * 2.4 - 3.6, (i // 4) * 2.6, 0.4)
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, 0))
    cam = bpy.data.cameras.new('c')
    co = bpy.data.objects.new('c', cam)
    co.location = (0, -9.5, 6.5)
    co.rotation_euler = (math.radians(58), 0, 0)
    sc.collection.objects.link(co)
    sc.camera = co
    sun = bpy.data.lights.new('s', 'SUN')
    sun.energy = 3.5
    so = bpy.data.objects.new('s', sun)
    so.rotation_euler = (math.radians(40), math.radians(20), math.radians(30))
    sc.collection.objects.link(so)
    sc.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.4
    sc.cycles.samples = 24
    sc.render.resolution_x = 1100
    sc.render.resolution_y = 620
    sc.render.image_settings.file_format = 'PNG'
    sc.render.filepath = os.path.join(OUT, 'rockkit_preview.png')
    bpy.ops.render.render(write_still=True)


build_all()
print('OK_DONE')
