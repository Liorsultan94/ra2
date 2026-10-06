# Blender 5.2.2 (LTS) - resource crystals and ore for Iron Front.
#
#   /opt/blender/blender -b --factory-startup -P web/tools/blender/crystals.py -- <out_dir> [render.png] [file.blend]
#   (or web/tools/blender/bake-crystals.sh, which also converts the maps to WebP)
#
# Models the harvestable resources of src/render/resources.ts and bakes them
# onto small game meshes:
#   gem_big_a, gem_big_b  faceted crystal clusters (hexagonal prisms with
#                         pyramidal or chisel terminations) on a host rock
#   gem_small             a two-crystal sprout
#   ore_rock_a, ore_rock_b  gold-veined rock rubble
#   ore_nugget            three gold nuggets
# Each has a low-poly game mesh (flat facets, <= ~110 triangles) and a
# high-poly source (bevelled, chipped edges, displaced lumps) that the maps are
# baked from, into one shared UV atlas:
#   crystals_n.png  tangent-space normal map (OpenGL, +Y up) - bevels, chips
#   crystals_m.png  R = ambient occlusion (with a ground plane under the base)
#                   G = detail: inclusions / veils in the crystals, gold veins
#                       in the ore rock
#                   B = material: 1 = crystal glass / native gold, 0 = rock
#   crystals.glb    the low-poly meshes only (positions, flat normals, UVs),
#                   base on the ground at y = 0, up = +Y, ~1 unit tall (the
#                   game scales every instance itself)
# plus, optionally, a Cycles beauty render of the variants and the .blend.
import bpy, bmesh, math, random, sys, os
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else '/tmp/crystals'
RENDER = argv[1] if len(argv) > 1 else ''
BLEND = argv[2] if len(argv) > 2 else ''
os.makedirs(OUT, exist_ok=True)
SIZE = 512
SPACING = 1.6

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
col = sc.collection


def link(name, me):
    o = bpy.data.objects.new(name, me)
    col.objects.link(o)
    return o


# ------------------------------------------------------------ geometry

def crystal(bm, rnd, base, tilt, az, L, r, h, cut=False):
    """Hexagonal prism (slightly irregular, tapering) with a pyramidal or chisel-cut termination."""
    n = 6
    rot = rnd.random() * math.pi
    radii = [r * (0.85 + 0.3 * rnd.random()) for _ in range(n)]
    M = Matrix.Translation(base) @ Matrix.Rotation(az, 4, 'Z') @ Matrix.Rotation(tilt, 4, 'Y')
    def v(p):
        return bm.verts.new(M @ Vector(p))
    ring0 = []
    ring1 = []
    for i in range(n):
        a = rot + i * 2 * math.pi / n
        ring0.append(v((math.cos(a) * radii[i], math.sin(a) * radii[i], -0.12)))
        ring1.append(v((math.cos(a) * radii[i] * 0.9, math.sin(a) * radii[i] * 0.9, L)))
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((ring0[i], ring0[j], ring1[j], ring1[i]))
    off = ((rnd.random() - 0.5) * r * 0.6, (rnd.random() - 0.5) * r * 0.6)
    if cut:
        ring2 = []
        for i in range(n):
            a = rot + i * 2 * math.pi / n
            ring2.append(v((off[0] + math.cos(a) * radii[i] * 0.38, off[1] + math.sin(a) * radii[i] * 0.38, L + h * 0.62)))
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((ring1[i], ring1[j], ring2[j], ring2[i]))
        bm.faces.new(ring2)
    else:
        apex = v((off[0], off[1], L + h))
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((ring1[i], ring1[j], apex))


def rock(bm, rnd, base, s, flat=0.6):
    """Broken rock: a jittered icosahedron (20 facets), flattened, sunk a little."""
    res = bmesh.ops.create_icosphere(bm, subdivisions=1, radius=1.0)
    vs = res['verts']
    for vv in vs:
        k = 0.75 + 0.5 * rnd.random()
        vv.co = Vector((vv.co.x * k * s, vv.co.y * k * s * (0.8 + 0.4 * rnd.random()), max(-0.35, vv.co.z) * k * s * flat))
    M = Matrix.Translation(base) @ Matrix.Rotation(rnd.random() * 6.28, 4, 'Z')
    bmesh.ops.transform(bm, matrix=M, verts=vs)


def cluster(name, seed, spec):
    rnd = random.Random(seed)
    bm = bmesh.new()
    rocks = bmesh.new()
    for c in spec.get('crystals', []):
        crystal(bm, rnd, Vector(c[0]), c[1], c[2], c[3], c[4], c[5], c[6] if len(c) > 6 else False)
    for rk in spec.get('rocks', []):
        rock(rocks if spec.get('split') else bm, rnd, Vector(rk[0]), rk[1], rk[2] if len(rk) > 2 else 0.6)
    me = bpy.data.meshes.new(name)
    bm.normal_update()
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    parts = [link(name, me)]
    if spec.get('split'):
        me2 = bpy.data.meshes.new(name + '_rock')
        bmesh.ops.recalc_face_normals(rocks, faces=rocks.faces)
        rocks.to_mesh(me2)
        parts.append(link(name + '_rock', me2))
    rocks.free()
    return parts


def ring(n, r0, r1, seed, z=0.0):
    rnd = random.Random(seed)
    out = []
    for i in range(n):
        a = i * 2 * math.pi / n + rnd.random() * 0.6
        rr = r0 + (r1 - r0) * rnd.random()
        out.append((math.cos(a) * rr, math.sin(a) * rr, z, a))
    return out


# variants: crystals = (base, tilt, azimuth, length, radius, tip, chisel)
VAR = {}
side = ring(4, 0.09, 0.16, 11)
VAR['gem_big_a'] = {
    'crystals': [((0, 0, 0), 0.08, 0.3, 0.78, 0.13, 0.22)]
    + [((x, y, 0), 0.38 + 0.12 * k, a, 0.32 + 0.09 * k, 0.075 + 0.01 * k, 0.13, k == 2) for k, (x, y, _, a) in enumerate(side)],
    'rocks': [((0.03, -0.05, 0.0), 0.2, 0.45)],
    'split': True,
}
side = ring(3, 0.1, 0.17, 23)
VAR['gem_big_b'] = {
    'crystals': [((-0.05, 0.02, 0), 0.22, 2.9, 0.7, 0.115, 0.2), ((0.06, -0.03, 0), 0.3, -0.2, 0.6, 0.105, 0.17, True)]
    + [((x, y, 0), 0.5 + 0.1 * k, a, 0.28 + 0.06 * k, 0.07, 0.11) for k, (x, y, _, a) in enumerate(side)],
    'rocks': [((0.0, 0.04, 0.0), 0.2, 0.45)],
    'split': True,
}
VAR['gem_small'] = {
    'crystals': [((0, 0, 0), 0.15, 1.0, 0.42, 0.09, 0.14), ((0.07, 0.05, 0), 0.55, 0.8, 0.24, 0.065, 0.1)],
}
VAR['ore_rock_a'] = {'rocks': [((0, 0, 0), 0.42, 0.62), ((0.36, 0.18, 0), 0.27, 0.6), ((-0.25, 0.3, 0), 0.22, 0.7)]}
VAR['ore_rock_b'] = {'rocks': [((0, 0, 0), 0.45, 0.55), ((-0.34, -0.2, 0), 0.26, 0.65)]}
VAR['ore_nugget'] = {'rocks': [((0, 0, 0.05), 0.2, 0.85), ((0.24, 0.1, 0.03), 0.15, 0.9), ((-0.12, 0.22, 0.03), 0.13, 0.9)]}

KIND = {'gem_big_a': 'gem', 'gem_big_b': 'gem', 'gem_small': 'gem', 'ore_rock_a': 'rock', 'ore_rock_b': 'rock', 'ore_nugget': 'gold'}

# ------------------------------------------------------------ materials

def node_mat(name):
    m = bpy.data.materials.new(name)
    if m.node_tree is None:  # Blender 5 creates the node tree itself
        m.use_nodes = True
    return m, m.node_tree.nodes, m.node_tree.links


def vein_mask(N, Lk, tc):
    """Gold veins: thin, strongly distorted bands, broken up by a coarse noise (fragmentary, not stripes)."""
    wv = N.new('ShaderNodeTexWave')
    wv.wave_type = 'BANDS'
    wv.bands_direction = 'DIAGONAL'
    wv.inputs['Scale'].default_value = 2.6
    wv.inputs['Distortion'].default_value = 16.0
    wv.inputs['Detail'].default_value = 4.0
    wv.inputs['Detail Scale'].default_value = 2.5
    rp = N.new('ShaderNodeValToRGB')
    rp.color_ramp.elements[0].position = 0.88
    rp.color_ramp.elements[1].position = 0.96
    nz = N.new('ShaderNodeTexNoise')
    nz.inputs['Scale'].default_value = 3.2
    rn = N.new('ShaderNodeValToRGB')
    rn.color_ramp.elements[0].position = 0.42
    rn.color_ramp.elements[1].position = 0.58
    mul = N.new('ShaderNodeMath')
    mul.operation = 'MULTIPLY'
    Lk.new(tc.outputs['Object'], wv.inputs['Vector'])
    Lk.new(tc.outputs['Object'], nz.inputs['Vector'])
    Lk.new(wv.outputs['Fac'], rp.inputs['Fac'])
    Lk.new(nz.outputs['Fac'], rn.inputs['Fac'])
    Lk.new(rp.outputs['Color'], mul.inputs[0])
    Lk.new(rn.outputs['Color'], mul.inputs[1])
    return mul.outputs['Value']


def emit_mat(name, kind):
    """Bake material: emission = (0, detail, material flag)."""
    m, N, Lk = node_mat(name)
    for nd in list(N):
        N.remove(nd)
    out = N.new('ShaderNodeOutputMaterial')
    em = N.new('ShaderNodeEmission')
    comb = N.new('ShaderNodeCombineColor')
    tc = N.new('ShaderNodeTexCoord')
    if kind == 'crystal':
        # inclusions: cloudy veils and a few bright specks inside the glass
        nz = N.new('ShaderNodeTexNoise')
        nz.inputs['Scale'].default_value = 7.0
        nz.inputs['Detail'].default_value = 6.0
        rp = N.new('ShaderNodeValToRGB')
        rp.color_ramp.elements[0].position = 0.5
        rp.color_ramp.elements[1].position = 0.72
        Lk.new(tc.outputs['Object'], nz.inputs['Vector'])
        Lk.new(nz.outputs['Fac'], rp.inputs['Fac'])
        Lk.new(rp.outputs['Color'], comb.inputs['Green'])
        comb.inputs['Blue'].default_value = 1.0
    elif kind == 'gold':
        nz = N.new('ShaderNodeTexNoise')
        nz.inputs['Scale'].default_value = 14.0
        Lk.new(tc.outputs['Object'], nz.inputs['Vector'])
        Lk.new(nz.outputs['Fac'], comb.inputs['Green'])
        comb.inputs['Blue'].default_value = 1.0
    else:
        # gold veins through the rock: thin distorted bands
        Lk.new(vein_mask(N, Lk, tc), comb.inputs['Green'])
        comb.inputs['Blue'].default_value = 0.0
    Lk.new(comb.outputs['Color'], em.inputs['Color'])
    Lk.new(em.outputs['Emission'], out.inputs['Surface'])
    return m


MAT_CRYSTAL = emit_mat('bake_crystal', 'crystal')
MAT_HOST = emit_mat('bake_host', 'host')
MAT_ROCK = emit_mat('bake_rock', 'rock')
MAT_GOLD = emit_mat('bake_gold', 'gold')
# the host rock under a gem cluster: no veins, no flag
for nd in MAT_HOST.node_tree.nodes:
    if nd.type == 'COMBINE_COLOR':
        nd.inputs['Blue'].default_value = 0.0
        for l in list(nd.inputs['Green'].links):
            MAT_HOST.node_tree.links.remove(l)
        nd.inputs['Green'].default_value = 0.15

# ------------------------------------------------------------ build lows and highs

lows = {}
highs = {}
clouds = bpy.data.textures.new('chips', 'CLOUDS')
clouds.noise_scale = 0.05
lumps = bpy.data.textures.new('lumps', 'CLOUDS')
lumps.noise_scale = 0.18
for vi, (name, spec) in enumerate(VAR.items()):
    parts = cluster(name, 100 + vi * 17, spec)
    off = Vector(((vi - 2.5) * SPACING, 0, 0))
    lo = parts[0]
    if len(parts) > 1:
        # one low mesh per variant (crystals + host rock); the high keeps them apart for the materials
        lo_j = link(name + '_lo', parts[0].data.copy())
        tmp = link(name + '_tmpr', parts[1].data.copy())
        with bpy.context.temp_override(active_object=lo_j, selected_editable_objects=[lo_j, tmp]):
            bpy.ops.object.join()
        lo = lo_j
    else:
        lo = link(name + '_lo', parts[0].data.copy())
    lo.location = off
    for p in lo.data.polygons:
        p.use_smooth = False
    lows[name] = lo
    hs = []
    for k, p in enumerate(parts):
        p.name = name + ('_hi' if k == 0 else '_hi_rock')
        p.location = off
        is_host = k == 1
        kind = KIND[name]
        if kind == 'gem' and not is_host:
            p.data.materials.append(MAT_CRYSTAL)
            bv = p.modifiers.new('bevel', 'BEVEL')
            bv.width = 0.012
            bv.segments = 2
            bv.limit_method = 'ANGLE'
            ss = p.modifiers.new('sub', 'SUBSURF')
            ss.subdivision_type = 'SIMPLE'
            ss.levels = ss.render_levels = 3
            dp = p.modifiers.new('chips', 'DISPLACE')
            dp.texture = clouds
            dp.strength = 0.012
            dp.mid_level = 0.5
        else:
            p.data.materials.append(MAT_HOST if is_host else (MAT_GOLD if kind == 'gold' else MAT_ROCK))
            ss = p.modifiers.new('sub', 'SUBSURF')
            ss.levels = ss.render_levels = 3
            dp = p.modifiers.new('lumps', 'DISPLACE')
            dp.texture = lumps
            dp.strength = 0.05 if kind != 'gold' else 0.03
            dp.mid_level = 0.5
            for poly in p.data.polygons:
                poly.use_smooth = True
        hs.append(p)
    highs[name] = hs

# ------------------------------------------------------------ UV atlas (all lows packed together)

bpy.ops.object.select_all(action='DESELECT')
lo_list = list(lows.values())
for o in lo_list:
    o.select_set(True)
bpy.context.view_layer.objects.active = lo_list[0]
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(50), island_margin=0.015, scale_to_bounds=False)
bpy.ops.uv.pack_islands(margin=0.012, rotate=True)
bpy.ops.object.mode_set(mode='OBJECT')

# ------------------------------------------------------------ bake

def image(name, fill):
    im = bpy.data.images.new(name, SIZE, SIZE, alpha=False, float_buffer=False)
    im.colorspace_settings.name = 'Non-Color'
    im.generated_color = fill
    return im

IMG = {'nrm': image('nrm', (0.5, 0.5, 1.0, 1.0)), 'emit': image('emit', (0, 0, 0, 1)), 'ao': image('ao', (1, 1, 1, 1))}
bake_mat, BN, _ = node_mat('bake_target')
tex_node = BN.new('ShaderNodeTexImage')
BN.active = tex_node
for o in lo_list:
    o.data.materials.clear()
    o.data.materials.append(bake_mat)
    # the cage must not shadow its own high-poly source
    o.visible_diffuse = o.visible_glossy = o.visible_transmission = o.visible_shadow = o.visible_volume_scatter = False

bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, -0.01))
ground = bpy.context.object
ground.name = 'ground'

sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
bk = sc.render.bake
bk.use_selected_to_active = True
bk.cage_extrusion = 0.02
bk.max_ray_distance = 0.04
bk.margin = 4
bk.use_clear = False

for key, btype, samples in (('nrm', 'NORMAL', 4), ('emit', 'EMIT', 4), ('ao', 'AO', 48)):
    tex_node.image = IMG[key]
    sc.cycles.samples = samples
    for name, lo in lows.items():
        for o in sc.objects:
            o.hide_render = not (o is lo or o in highs[name] or (o is ground and key == 'ao'))
        bpy.ops.object.select_all(action='DESELECT')
        for h in highs[name]:
            h.select_set(True)
        lo.select_set(True)
        bpy.context.view_layer.objects.active = lo
        bpy.ops.object.bake(type=btype, normal_space='TANGENT', use_selected_to_active=True, use_clear=False, margin=4, cage_extrusion=0.02, max_ray_distance=0.04)
        print('baked', key, name, flush=True)
for o in sc.objects:
    o.hide_render = False

# pack: mask = (AO, detail, flag)
n = SIZE * SIZE * 4
ao = list(IMG['ao'].pixels)
em = list(IMG['emit'].pixels)
mask = image('mask', (0, 0, 0, 1))
px = [0.0] * n
for i in range(0, n, 4):
    px[i] = ao[i]
    px[i + 1] = em[i + 1]
    px[i + 2] = em[i + 2]
    px[i + 3] = 1.0
mask.pixels = px
for im, fn in ((IMG['nrm'], 'crystals_n.png'), (mask, 'crystals_m.png')):
    im.filepath_raw = os.path.join(OUT, fn)
    im.file_format = 'PNG'
    im.save()

# ------------------------------------------------------------ GLB (lows at the origin)

for o in lo_list:
    o.location = (0, 0, 0)
    o.data.materials.clear()
    o.name = o.name[:-3]  # gem_big_a_lo -> gem_big_a
tris = {o.name: sum(len(p.vertices) - 2 for p in o.data.polygons) for o in lo_list}
print('TRIS', tris, flush=True)
bpy.ops.object.select_all(action='DESELECT')
for o in lo_list:
    o.select_set(True)
bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'crystals.glb'), export_format='GLB', use_selection=True, export_materials='NONE', export_normals=True, export_texcoords=True, export_yup=True, export_apply=True)

# ------------------------------------------------------------ beauty render for the owner

if RENDER:
    def look_crystal(colr):
        m, N, Lk = node_mat('look_crystal')
        b = N['Principled BSDF']
        b.inputs['Base Color'].default_value = colr
        b.inputs['Transmission Weight'].default_value = 0.85
        b.inputs['Roughness'].default_value = 0.04
        b.inputs['IOR'].default_value = 1.75
        b.inputs['Emission Color'].default_value = colr
        b.inputs['Emission Strength'].default_value = 0.35
        return m

    def look_rock(gold_veins):
        m, N, Lk = node_mat('look_rock')
        b = N['Principled BSDF']
        b.inputs['Base Color'].default_value = (0.09, 0.075, 0.065, 1)
        b.inputs['Roughness'].default_value = 0.85
        if gold_veins is None:
            return m
        g = N.new('ShaderNodeBsdfPrincipled')
        g.inputs['Base Color'].default_value = (1.0, 0.72, 0.3, 1)
        g.inputs['Metallic'].default_value = 1.0
        g.inputs['Roughness'].default_value = 0.22
        mix = N.new('ShaderNodeMixShader')
        tc = N.new('ShaderNodeTexCoord')
        Lk.new(vein_mask(N, Lk, tc), mix.inputs['Fac'])
        Lk.new(b.outputs['BSDF'], mix.inputs[1])
        Lk.new(g.outputs['BSDF'], mix.inputs[2])
        out = N['Material Output']
        Lk.new(mix.outputs['Shader'], out.inputs['Surface'])
        return m

    gold = node_mat('look_gold')[0]
    gb = gold.node_tree.nodes['Principled BSDF']
    gb.inputs['Base Color'].default_value = (1.0, 0.72, 0.3, 1)
    gb.inputs['Metallic'].default_value = 1.0
    gb.inputs['Roughness'].default_value = 0.25
    violet = (0.42, 0.12, 0.95, 1)
    for o in lo_list:
        o.hide_render = True
    # closer together for the picture
    for vi, hs in enumerate(highs.values()):
        for h in hs:
            h.location.x = (vi - 2.5) * 1.05
    for name, hs in highs.items():
        for k, h in enumerate(hs):
            h.data.materials.clear()
            kind = KIND[name]
            if kind == 'gem':
                h.data.materials.append(look_rock(None) if k == 1 else look_crystal(violet if name != 'gem_big_b' else (0.75, 0.15, 0.85, 1)))
            elif kind == 'gold':
                h.data.materials.append(gold)
            else:
                h.data.materials.append(look_rock(True))
    gm = node_mat('look_ground')[0]
    gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.16, 0.12, 0.09, 1)
    ground.data.materials.append(gm)
    cam = link('cam', bpy.data.cameras.new('cam'))
    cam.data.lens = 27
    cam.location = (0, -4.4, 2.2)
    cam.rotation_euler = (math.radians(66), 0, 0)
    sc.camera = cam
    sun = link('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-35))
    sun.data.energy = 4.0
    w = bpy.data.worlds.new('w')
    sc.world = w
    if w.node_tree is None:
        w.use_nodes = True
    w.node_tree.nodes['Background'].inputs[0].default_value = (0.35, 0.42, 0.55, 1)
    sc.cycles.samples = 64
    sc.render.resolution_x = 1280
    sc.render.resolution_y = 520
    sc.render.filepath = RENDER
    bpy.ops.render.render(write_still=True)

if BLEND:
    bpy.ops.wm.save_as_mainfile(filepath=BLEND)
print('OK_DONE', flush=True)
