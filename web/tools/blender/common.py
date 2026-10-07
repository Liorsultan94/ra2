# Blender 5.2.2 (LTS) - shared helpers for the Iron Front asset pipeline (web/tools/blender).
#
# Imported by merkava.py / factory.py (run headless: blender -b --factory-startup -P <script>.py).
# Conventions: the game is Y-up with forward = +X and right = +Z (1 unit = 1 map tile); Blender is Z-up,
# the glTF importer / exporter maps game (x, y, z) <-> Blender (x, -z, y).
#
# Texture authoring is bake + numpy: Cycles bakes the inputs (high -> low normal, AO, base paint, ids,
# edge mask, world position / normal, world-space noise) into the low poly's UV atlas, then numpy
# composites the final albedo / roughness-metal-mask maps (dust, mud, chips, streaks, grime, baked AO and
# a soft top light), so the look is plain arithmetic that is easy to tune and fully reproducible.
import bpy
import bmesh
import math
import os

import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, 'build')
WEB = os.path.normpath(os.path.join(HERE, '..', '..'))
os.makedirs(BUILD, exist_ok=True)


def g2b(x, y, z):
    """Game (x, y up, z right) -> Blender (x, y, z up)."""
    return Vector((x, -z, y))


def reset(threads=3):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.render.threads_mode = 'FIXED'
    sc.render.threads = threads
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    return sc


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path, merge_vertices=False)
    objs = [o for o in bpy.data.objects if o not in before]
    for o in objs:
        if o.type == 'MESH' and 'custom_normal' in o.data.attributes:
            o.data.attributes.remove(o.data.attributes['custom_normal'])
    return objs


def select(objs, active=None):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.hide_set(False)
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or objs[0]


def join(objs, name):
    objs = [o for o in objs if o]
    select(objs)
    if len(objs) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    o.data.name = name
    return o


def dup(o, name):
    c = o.copy()
    c.data = o.data.copy()
    c.name = name
    c.data.name = name
    bpy.context.scene.collection.objects.link(c)
    return c


def weld(o, dist=2e-5):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=dist)
    bm.to_mesh(o.data)
    bm.free()


def components(bm):
    """Connected face islands of a bmesh: list of face lists."""
    bm.faces.ensure_lookup_table()
    seen = set()
    out = []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack = [f]
        seen.add(f.index)
        comp = []
        while stack:
            g = stack.pop()
            comp.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        stack.append(h)
        out.append(comp)
    return out


def comp_diag(comp):
    xs = [v.co for f in comp for v in f.verts]
    mn = Vector((min(p.x for p in xs), min(p.y for p in xs), min(p.z for p in xs)))
    mx = Vector((max(p.x for p in xs), max(p.y for p in xs), max(p.z for p in xs)))
    return (mx - mn).length


def drop_contact_faces(bm):
    """Remove coincident faces (two solids touching face to face, or duplicates): they are never seen,
    waste atlas space and make bake rays ambiguous."""
    groups = {}
    for f in bm.faces:
        c = f.calc_center_median()
        k = (round(c.x, 4), round(c.y, 4), round(c.z, 4), round(f.calc_area(), 7))
        groups.setdefault(k, []).append(f)
    kill = []
    for fs in groups.values():
        if len(fs) < 2:
            continue
        opp = any(fs[i].normal.dot(fs[j].normal) < -0.9 for i in range(len(fs)) for j in range(i + 1, len(fs)))
        kill.extend(fs if opp else fs[1:])
    bmesh.ops.delete(bm, geom=list(set(kill)), context='FACES')
    return len(kill)


def lowpoly(o, budget, small=0.012, bevel_from=0.15, bevel=0.0015):
    """Game low poly from the procedural mesh: drop hidden contact faces and islands smaller than `small`
    (their detail is baked into the maps), chamfer the hard edges of the big islands (one segment, angle
    limited) so silhouettes and highlights read as bevelled armour, then drop the smallest remaining
    islands until the triangle budget is met."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=2e-5)
    drop_contact_faces(bm)
    kill = []
    big_edges = set()
    for c in components(bm):
        d = comp_diag(c)
        if d < small:
            kill.extend(c)
        elif d >= bevel_from:
            for f in c:
                for e in f.edges:
                    if len(e.link_faces) == 2 and e.calc_face_angle(0) > math.radians(40):
                        big_edges.add(e)
    bmesh.ops.delete(bm, geom=list(set(kill)), context='FACES')
    big_edges = [e for e in big_edges if e.is_valid]
    if bevel > 0 and big_edges:
        bmesh.ops.bevel(bm, geom=big_edges, offset=bevel, offset_type='OFFSET', segments=1, profile=0.5, affect='EDGES', clamp_overlap=True)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    comps = sorted(((comp_diag(c), c) for c in components(bm)), key=lambda x: -x[0])
    total = 0
    kill = []
    for d, c in comps:
        if total + len(c) <= budget:
            total += len(c)
        else:
            kill.extend(c)
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(o.data)
    bm.free()
    return o


def hp_remesh(o, voxel=0.0015):
    """High poly: voxel remesh of the welded parts -> one watertight skin, every edge rounded at the
    voxel scale (the bevel), no interior / coincident faces to confuse the bake rays."""
    weld(o)
    m = o.modifiers.new('remesh', 'REMESH')
    m.mode = 'VOXEL'
    m.voxel_size = voxel
    m.adaptivity = 0.0
    m.use_smooth_shade = True
    select([o])
    bpy.ops.object.modifier_apply(modifier=m.name)
    return o


def tris(o):
    return sum(len(p.vertices) - 2 for p in o.data.polygons)


def smooth_by_angle(o, deg=35):
    select([o])
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(deg), keep_sharp_edges=True)


def hp_bevel(o, width=0.0011, segs=2, deg=30):
    """High poly: rounded edges on everything (welded first so boxes bevel as solids)."""
    weld(o)
    m = o.modifiers.new('bevel', 'BEVEL')
    m.width = width
    m.segments = segs
    m.limit_method = 'ANGLE'
    m.angle_limit = math.radians(deg)
    m.use_clamp_overlap = True
    m.harden_normals = True
    select([o])
    bpy.ops.object.shade_smooth()
    bpy.ops.object.modifier_apply(modifier=m.name)
    return o


def bolt_mesh(name, items, r=0.0019, h=0.0011):
    """items: (location, normal) in object space -> one mesh of hex-head bolts with washers."""
    bm = bmesh.new()
    for loc, nrm in items:
        q = Vector((0, 0, 1)).rotation_difference(nrm)
        for rr, hh, z0, seg in ((r * 1.35, h * 0.35, 0.0, 10), (r, h, h * 0.3, 6)):
            res = bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg, radius1=rr, radius2=rr * 0.92, depth=hh)
            vs = res['verts']
            for v in vs:
                p = Vector(v.co)
                p.z += hh / 2 + z0 - h * 0.15
                v.co = q @ p + loc
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def weld_mesh(name, paths, r=0.0016, step=0.0011):
    """paths: lists of (location, normal) along a seam -> a bead of overlapping flattened blobs."""
    bm = bmesh.new()
    for pts in paths:
        for i in range(len(pts) - 1):
            a, na = pts[i]
            b, nb = pts[i + 1]
            seg = (b - a)
            L = seg.length
            if L < 1e-6 or L > 0.05:
                continue
            t = seg.normalized()
            n = int(max(1, L / step))
            for k in range(n):
                u = k / n
                p = a.lerp(b, u)
                nn = na.lerp(nb, u).normalized()
                side = t.cross(nn).normalized()
                res = bmesh.ops.create_icosphere(bm, subdivisions=1, radius=1.0)
                jit = 0.85 + 0.3 * (((k * 7919 + i * 104729) % 97) / 97.0)
                for v in res['verts']:
                    q = v.co
                    v.co = p + t * (q.x * r * 0.75) + side * (q.y * r * jit) + nn * (q.z * r * 0.3)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def cast(ob, origin, direction, dist=2.0):
    """Ray cast against a mesh object (object space). Returns (location, normal) or None."""
    ok, loc, nrm, _ = ob.ray_cast(origin, direction.normalized(), distance=dist)
    return (loc, nrm) if ok else None


# ------------------------------------------------------------------ UVs

def shrink_small_islands(o, below, k):
    """Texel budget: scale the UVs of small mesh islands (fittings, chains) by k about their centre, so the
    big plates get the atlas space."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    uv = bm.loops.layers.uv.active
    for comp in components(bm):
        if comp_diag(comp) >= below:
            continue
        loops = [l for f in comp for l in f.loops]
        cx = sum(l[uv].uv.x for l in loops) / len(loops)
        cy = sum(l[uv].uv.y for l in loops) / len(loops)
        for l in loops:
            l[uv].uv.x = cx + (l[uv].uv.x - cx) * k
            l[uv].uv.y = cy + (l[uv].uv.y - cy) * k
    bm.to_mesh(o.data)
    bm.free()


def unwrap_atlas(objs, margin=0.004, layer='UVMap', shrink=None):
    """Smart project every object, then pack all islands of all objects into ONE shared 0..1 atlas.
    layer 'UVMap' replaces the source UVs; any other name adds a layer (kept active for render / bake)."""
    for o in objs:
        me = o.data
        if layer == 'UVMap':
            while len(me.uv_layers):
                me.uv_layers.remove(me.uv_layers[0])
        uv = me.uv_layers.new(name=layer)
        me.uv_layers.active = uv
        uv.active_render = True
    select(objs)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=margin, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.average_islands_scale()
    if shrink:
        bpy.ops.object.mode_set(mode='OBJECT')
        for o in objs:
            shrink_small_islands(o, *shrink)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(udim_source='CLOSEST_UDIM', rotate=True, margin_method='FRACTION', margin=margin)
    bpy.ops.object.mode_set(mode='OBJECT')


# ------------------------------------------------------------------ baking

def new_image(name, size, data=True, float_buf=True):
    if name in bpy.data.images:
        bpy.data.images.remove(bpy.data.images[name])
    img = bpy.data.images.new(name, size, size, alpha=False, float_buffer=float_buf)
    img.colorspace_settings.name = 'Non-Color' if data else 'sRGB'
    img.generated_color = (0.5, 0.5, 1.0, 1.0) if name.endswith('normal') else (0, 0, 0, 1)
    return img


def bake_material(name, uv=None):
    """Material for the low poly: an Image Texture node (the bake target) + an emission output that
    the per-pass setup rewires."""
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(em.outputs[0], out.inputs[0])
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.name = 'target'
    nt.nodes.active = tex
    return m


def set_target(mat, img):
    t = mat.node_tree.nodes['target']
    t.image = img
    mat.node_tree.nodes.active = t


def bake(kind, lows, highs_of, img, samples=4, extrusion=0.004, ray=0.012, margin=4, emit_setup=None, hide=()):
    """Bake `kind` ('NORMAL' / 'AO' / 'EMIT') for each low poly in turn into the shared atlas image.
    highs_of(low) -> list of high poly objects (selected-to-active) or [] (bake the low poly itself)."""
    sc = bpy.context.scene
    sc.cycles.samples = samples
    sc.render.bake.margin = margin
    sc.render.bake.margin_type = 'EXTEND'
    sc.render.bake.normal_space = 'TANGENT'
    for i, lo in enumerate(lows):
        mat = lo.data.materials[0]
        set_target(mat, img)
        hs = highs_of(lo)
        everything = [o for o in sc.objects if o.type == 'MESH']
        for o in everything:
            o.hide_render = not (o is lo or o in hs)
        if emit_setup:
            emit_setup(lo, hs)
        select(hs + [lo], lo)
        sc.render.bake.use_selected_to_active = bool(hs)
        sc.render.bake.cage_extrusion = extrusion
        sc.render.bake.max_ray_distance = ray
        sc.render.bake.use_clear = i == 0
        bpy.ops.object.bake(type=kind, use_clear=(i == 0), margin=margin, margin_type='EXTEND', use_selected_to_active=bool(hs), cage_extrusion=extrusion, max_ray_distance=ray, normal_space='TANGENT', target='IMAGE_TEXTURES')
    for o in sc.objects:
        o.hide_render = False


def pixels(img):
    w, h = img.size
    a = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(h, w, 4)


def save_rgb(path, rgb, size):
    """Write an (h, w, 3) float array in 0..1 as an 8-bit PNG exactly as given (no colour transform)."""
    img = new_image('save_tmp', size, data=True, float_buf=False)
    a = np.ones((size, size, 4), dtype=np.float32)
    a[..., :3] = np.clip(rgb, 0, 1)
    img.pixels.foreach_set(a.ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


def lin2srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def srgb2lin(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.04045, x / 12.92, np.power((x + 0.055) / 1.055, 2.4))


def hexlin(h):
    return srgb2lin(np.array([((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255], dtype=np.float32))


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def blur(a, r=1):
    """Cheap box blur (separable) for soft masks."""
    out = a.copy()
    for ax in (0, 1):
        acc = out.copy()
        for k in range(1, r + 1):
            acc += np.roll(out, k, axis=ax) + np.roll(out, -k, axis=ax)
        out = acc / (2 * r + 1)
    return out


# ------------------------------------------------------------------ studio

def studio(cam_loc, look_at, lens=50, sun=(0.9, 0.2, 2.2), size=(1280, 720), samples=96, path=None, ground=0.0, ortho=None):
    sc = bpy.context.scene
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    sc.collection.objects.link(cam)
    cam.location = cam_loc
    d = Vector(look_at) - Vector(cam_loc)
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = lens
    if ortho:
        cam.data.type = 'ORTHO'
        cam.data.ortho_scale = ortho
    sc.camera = cam
    sl = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sc.collection.objects.link(sl)
    sl.rotation_euler = sun
    sl.data.energy = 4.0
    sl.data.angle = math.radians(3)
    w = bpy.data.worlds.new('w')
    sc.world = w
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs[0].default_value = (0.55, 0.62, 0.72, 1)
    w.node_tree.nodes['Background'].inputs[1].default_value = 0.9
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, ground))
    g = bpy.context.object
    gm = bpy.data.materials.new('ground')
    gm.use_nodes = True
    gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.42, 0.42, 0.42, 1)
    gm.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.9
    g.data.materials.append(gm)
    sc.render.resolution_x, sc.render.resolution_y = size
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.render.film_transparent = False
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for o in (cam, sl, g):
        bpy.data.objects.remove(o)


def pbr_material(name, albedo, normal, orm, team=(0.16, 0.42, 1.0)):
    """Preview material for studio renders (same maps as the game: orm = team mask / roughness / metal)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    ta = nt.nodes.new('ShaderNodeTexImage')
    ta.image = bpy.data.images.load(albedo)
    tn = nt.nodes.new('ShaderNodeTexImage')
    tn.image = bpy.data.images.load(normal)
    tn.image.colorspace_settings.name = 'Non-Color'
    to = nt.nodes.new('ShaderNodeTexImage')
    to.image = bpy.data.images.load(orm)
    to.image.colorspace_settings.name = 'Non-Color'
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    nt.links.new(to.outputs[0], sep.inputs[0])
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.blend_type = 'MULTIPLY'
    nt.links.new(sep.outputs[0], mix.inputs[0])
    nt.links.new(ta.outputs[0], mix.inputs[6])
    mix.inputs[7].default_value = (team[0] / 0.62, team[1] / 0.62, team[2] / 0.62, 1)
    nt.links.new(mix.outputs[2], b.inputs['Base Color'])
    nt.links.new(sep.outputs[1], b.inputs['Roughness'])
    nt.links.new(sep.outputs[2], b.inputs['Metallic'])
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nt.links.new(tn.outputs[0], nm.inputs['Color'])
    nt.links.new(nm.outputs[0], b.inputs['Normal'])
    return m


def edge_emission(nt, em, radius=0.0025):
    """Emission = (edge mask, pointiness, 0): edge = true normal vs a rounded (Bevel node) normal."""
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    bev = nt.nodes.new('ShaderNodeBevel')
    bev.samples = 8
    bev.inputs['Radius'].default_value = radius
    dot = nt.nodes.new('ShaderNodeVectorMath')
    dot.operation = 'DOT_PRODUCT'
    nt.links.new(geo.outputs['True Normal'], dot.inputs[0])
    nt.links.new(bev.outputs[0], dot.inputs[1])
    inv = nt.nodes.new('ShaderNodeMath')
    inv.operation = 'SUBTRACT'
    inv.inputs[0].default_value = 1.0
    nt.links.new(dot.outputs['Value'], inv.inputs[1])
    mul = nt.nodes.new('ShaderNodeMath')
    mul.operation = 'MULTIPLY'
    mul.use_clamp = True
    mul.inputs[1].default_value = 6.0
    nt.links.new(inv.outputs[0], mul.inputs[0])
    comb = nt.nodes.new('ShaderNodeCombineColor')
    nt.links.new(mul.outputs[0], comb.inputs[0])
    nt.links.new(geo.outputs['Pointiness'], comb.inputs[1])
    nt.links.new(comb.outputs[0], em.inputs[0])


def lp_pass(mat, kind, bb_min, bb_size, normal_img, scale=1.0):
    """Rewire the low poly's bake material for a self pass: 'pos' (world position in the bb box),
    'nrm' (world normal through the baked normal map), 'noise' (R fine, G medium, B vertical streaks),
    'noise2' (R voronoi cells, G splatter, B large mottling). `scale` < 1 = coarser noise (buildings)."""
    nt = mat.node_tree
    for n in [n for n in nt.nodes if n.name != 'target']:
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(em.outputs[0], out.inputs[0])
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    if kind == 'pos':
        sub = nt.nodes.new('ShaderNodeVectorMath')
        sub.operation = 'SUBTRACT'
        sub.inputs[1].default_value = bb_min
        div = nt.nodes.new('ShaderNodeVectorMath')
        div.operation = 'DIVIDE'
        div.inputs[1].default_value = bb_size
        nt.links.new(geo.outputs['Position'], sub.inputs[0])
        nt.links.new(sub.outputs[0], div.inputs[0])
        nt.links.new(div.outputs[0], em.inputs[0])
    elif kind == 'nrm':
        tn = nt.nodes.new('ShaderNodeTexImage')
        tn.image = normal_img
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nt.links.new(tn.outputs[0], nm.inputs['Color'])
        mad = nt.nodes.new('ShaderNodeVectorMath')
        mad.operation = 'MULTIPLY_ADD'
        mad.inputs[1].default_value = (0.5, 0.5, 0.5)
        mad.inputs[2].default_value = (0.5, 0.5, 0.5)
        nt.links.new(nm.outputs[0], mad.inputs[0])
        nt.links.new(mad.outputs[0], em.inputs[0])
    else:
        comb = nt.nodes.new('ShaderNodeCombineColor')
        specs = (('fine', 160.0, (1, 1, 1)), ('mid', 22.0, (1, 1, 1)), ('streak', 70.0, (1, 1, 0.08))) if kind == 'noise' else (('cells', 90.0, (1, 1, 1)), ('splat', 55.0, (1, 1, 1)), ('large', 5.0, (1, 1, 1)))
        for i, (nm_, sc_, sq) in enumerate(specs):
            mp = nt.nodes.new('ShaderNodeMapping')
            mp.inputs['Scale'].default_value = sq
            nt.links.new(geo.outputs['Position'], mp.inputs['Vector'])
            if nm_ == 'cells':
                tx = nt.nodes.new('ShaderNodeTexVoronoi')
                tx.feature = 'F1'
                tx.inputs['Scale'].default_value = sc_ * scale
                tx.inputs['Randomness'].default_value = 1.0
                nt.links.new(mp.outputs[0], tx.inputs['Vector'])
                nt.links.new(tx.outputs['Distance'], comb.inputs[i])
            else:
                tx = nt.nodes.new('ShaderNodeTexNoise')
                tx.inputs['Scale'].default_value = sc_ * scale
                tx.inputs['Detail'].default_value = 6.0
                tx.inputs['Roughness'].default_value = 0.6
                nt.links.new(mp.outputs[0], tx.inputs['Vector'])
                nt.links.new(tx.outputs['Fac'], comb.inputs[i])
        nt.links.new(comb.outputs[0], em.inputs[0])
    nt.nodes.active = nt.nodes['target']
