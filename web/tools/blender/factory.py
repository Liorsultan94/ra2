# Blender 5.2.2 (LTS) - Iron Front: War Factory (model key "factory", faction israel) game asset.
#
#   nice -n 10 blender -b --factory-startup -P tools/blender/factory.py [-- stage]
#   (from web/; run tools/blender/make.sh for the whole pipeline)
#
# Input : build/factory-proc.glb (+ .json), the game's procedural War Factory (export-procedural.ts): the
#         root-level static structure and its small-detail group, in building space (footprint 3 x 3
#         centred on the origin, doors facing +Z). Animated nodes (roller door, beacons, roof ventilators),
#         lamps / windows glow, signs and flags stay procedural in the game and are not part of the asset.
# Output: build/factory-raw.glb ("root"; pack.mjs adds the LODs), build/factory-{albedo,normal,orm}.png,
#         build/factory-studio.png
#
# Owner rule: no concrete pad markings under buildings. The procedural foundation slab, the painted lane,
#   the hazard-edged lift deck and its stripes are removed; the structures' plinths are sunk into the
#   ground instead, so the building stands on the map's own terrain.
# High poly = the low poly with 2-segment rounded bevels (3 mm) on every hard edge, shaded with the
#   building atlas' photoscanned normal tiles. Base colour = the game's own atlas tiles x vertex paint,
#   then numpy weathering: rain streaks, a grime band at the foot of the walls, roof dust, edge wear,
#   baked AO and soft top light.
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

NAME = 'factory'
TEX = 2048
BUDGET = 9000  # the procedural meshes this replaces: 4.4k (structure) + 3.0k (detail group)
TEAM = 0x2a6cff
Y0 = 0.04

BB_MIN = Vector((-1.6, -1.6, -0.1))
BB_SIZE = Vector((3.2, 3.2, 1.6))
BAKES = os.path.join(C.BUILD, NAME + '-bakes.npz')
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
STAGE = ARGS[0] if ARGS else 'all'
man = json.load(open(os.path.join(C.WEB, 'public', 'tex', 'buildings', 'manifest.json')))
SCALE = [1.0] * (man['cols'] * man['rows'])
for t in man['tiles']:
    SCALE[t['tile']] = t.get('scale', 1)
PHOTO = {t['tile'] for t in man['tiles']}


def composite(px):
    """Final albedo / orm maps from the baked inputs (px(name) -> (h, w, 4) float array at 1024; 'base2' at 2048)."""
    base = px('base')[..., :3]
    idm = px('id')
    metal, rgh, tile = idm[..., 0], idm[..., 1], np.round(idm[..., 2] * 32)
    ao = np.clip(px('ao')[..., 0], 0, 1)
    edge, point = px('edge')[..., 0], px('edge')[..., 1]
    P = px('pos')[..., :3] * np.array(BB_SIZE) + np.array(BB_MIN)
    Nw = px('nrm')[..., :3] * 2 - 1
    fine, mid, streak = px('noise')[..., 0], px('noise')[..., 1], px('noise')[..., 2]
    cells, splat, large = px('noise2')[..., 0], px('noise2')[..., 1], px('noise2')[..., 2]
    z = P[..., 2]
    up = Nw[..., 2]

    team = C.sstep(0.35, 0.55, base[..., 2]) * (base[..., 0] < 0.12) * (base[..., 1] < 0.3)
    paint = np.where(team[..., None] > 0.5, 0.62, base)
    convex = C.sstep(0.5, 0.56, point)
    wearE = np.clip(edge * convex * 1.4, 0, 1)
    side = 1 - np.abs(up)
    # rain streaks running down the walls (stronger under ledges: low sky AO above), rust on metal
    runs = side * C.sstep(0.5, 0.7, streak) * (0.45 + 0.55 * mid)
    foot = C.sstep(0.3, 0.0, z) * (0.6 + 0.4 * mid)  # splash grime at the foot of the walls
    dust = np.clip(np.clip(up, 0, 1) ** 2 * (0.2 + 0.5 * mid) * C.sstep(0.1, 0.3, z), 0, 1)
    cavity = np.clip((1 - ao) * 1.2, 0, 1)
    GRIME, DUST, RUST, SOOT = C.hexlin(0x3a342c), C.hexlin(0xb8a582), C.hexlin(0x6a4128), C.hexlin(0x2a2826)
    alb = paint.copy()
    alb = alb * (1 + 0.25 * wearE)[..., None]
    alb = alb + (alb * 0.6 + GRIME * 0.12 - alb) * (runs * 0.75)[..., None]
    alb = alb + (RUST - alb) * (runs * metal * 0.4)[..., None]
    alb = alb + (GRIME - alb) * (foot * 0.6)[..., None]
    alb = alb + (DUST - alb) * (dust * 0.45)[..., None]
    alb = alb + (SOOT - alb) * (cavity * 0.15)[..., None]
    # AO kept softer than on the vehicles: the game's building shader already shades the walls
    alb = alb * (0.55 + 0.45 * ao)[..., None] * 1.1
    alb = alb * (0.92 + 0.1 * np.clip(up, 0, 1))[..., None]
    alb = alb * (0.96 + 0.08 * fine)[..., None]
    rough = np.clip(np.where(rgh > 0.02, rgh, 0.85) + 0.15 * dust + 0.1 * foot - 0.15 * wearE * metal, 0.15, 1)
    metl = np.clip(metal * (1 - dust) * (1 - runs * 0.5), 0, 1)
    teamm = np.clip(team * (1 - foot * 0.5), 0, 1)

    # full-resolution albedo: the 2048 base keeps the tile detail, the 1024 weathering is upsampled
    base2 = px('base2')[..., :3]
    up2 = lambda a: np.repeat(np.repeat(a, 2, axis=0), 2, axis=1)  # noqa: E731
    ratio = alb / np.maximum(paint, 1e-3)
    team2 = up2(team)
    paint2 = np.where(team2[..., None] > 0.5, 0.62, base2)
    alb2 = np.clip(paint2 * up2(ratio), 0, 1)
    C.save_rgb(os.path.join(C.BUILD, NAME + '-albedo.png'), C.lin2srgb(alb2), TEX)
    C.save_rgb(os.path.join(C.BUILD, NAME + '-orm.png'), np.stack([teamm, rough, metl], -1), TEX // 2)


def studio_render(lo):
    pm = C.pbr_material('factory_pbr', os.path.join(C.BUILD, NAME + '-albedo.png'), os.path.join(C.BUILD, NAME + '-normal.png'), os.path.join(C.BUILD, NAME + '-orm.png'))
    lo.data.materials.clear()
    lo.data.materials.append(pm)
    C.studio((3.6, -4.4, 3.3), (0.0, 0.0, 0.35), lens=50, sun=(math.radians(50), 0, math.radians(-35)), path=os.path.join(C.BUILD, NAME + '-studio.png'), ground=-0.005, samples=64)
    print('[factory] studio render written')


if STAGE == 'composite':
    # re-run only the texture composite + studio render from the saved bakes (fast look iteration)
    C.reset()
    data = {k: v.astype(np.float32) for k, v in np.load(BAKES).items()}
    composite(lambda k: data[k])
    studio_render([o for o in C.import_glb(os.path.join(C.BUILD, NAME + '-raw.glb')) if o.type == 'MESH'][0])
    print('[factory] OK_DONE')
    sys.exit(0)


sc = C.reset()
objs = C.import_glb(os.path.join(C.BUILD, NAME + '-proc.glb'))

src = [o for o in objs if o.type == 'MESH' and (o.name.startswith('root|solid') or o.name.startswith('detail|solid')) and 'UVMap.001' in o.data.uv_layers]
for o in objs:
    if o.type == 'MESH' and o not in src:
        o.hide_render = True
        o.hide_set(True)
for o in src:
    if 'material_index' in o.data.attributes:
        o.data.attributes.remove(o.data.attributes['material_index'])
lo = C.join(src, 'root')

# ------------------------------------------------------------ low poly: no pad, plinths sunk, budget
import bmesh  # noqa: E402

bm = bmesh.new()
bm.from_mesh(lo.data)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=2e-5)
C.drop_contact_faces(bm)
pad = []
for comp in C.components(bm):
    zs = [v.co.z for f in comp for v in f.verts]
    if max(zs) < Y0 + 0.006:
        pad.extend(comp)
bmesh.ops.delete(bm, geom=pad, context='FACES')
for v in bm.verts:
    if abs(v.co.z - Y0) < 0.003:
        v.co.z = -0.03
bm.to_mesh(lo.data)
bm.free()
hp = C.dup(lo, 'root_hp')
C.lowpoly(lo, BUDGET, small=0.02, bevel_from=0.4, bevel=0.004)
C.smooth_by_angle(lo, 35)
print('[factory] low poly tris', C.tris(lo))
hp.data.materials.clear()
m = hp.modifiers.new('bevel', 'BEVEL')
m.width = 0.003
m.segments = 2
m.limit_method = 'ANGLE'
m.angle_limit = math.radians(30)
m.use_clamp_overlap = True
m.harden_normals = True
C.select([hp])
bpy.ops.object.shade_smooth()
bpy.ops.object.modifier_apply(modifier='bevel')

# ------------------------------------------------------------ atlas-sampling material for the high poly
ATL = {k: bpy.data.images.load(os.path.join(C.WEB, 'public', 'tex', 'buildings', f'bld-{k}-512.webp')) for k in ('albedo', 'normal')}
for k, im in ATL.items():
    im.colorspace_settings.name = 'sRGB' if k == 'albedo' else 'Non-Color'
    im.alpha_mode = 'CHANNEL_PACKED'


def atlas_uv(nt):
    """Shader nodes reproducing bldtex.atlasPatch: tile = round(uv1.x), uv * scale[tile] -> atlas cell."""
    uv0 = nt.nodes.new('ShaderNodeUVMap')
    uv0.uv_map = 'UVMap'
    uv1 = nt.nodes.new('ShaderNodeUVMap')
    uv1.uv_map = 'UVMap.001'
    s1 = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(uv1.outputs[0], s1.inputs[0])
    ti = nt.nodes.new('ShaderNodeMath')
    ti.operation = 'ROUND'
    nt.links.new(s1.outputs[0], ti.inputs[0])
    # scale lookup: sum over tiles of scale * (ti == tile)
    acc = None
    for t, sv in enumerate(SCALE):
        if sv == 1:
            continue
        cmpn = nt.nodes.new('ShaderNodeMath')
        cmpn.operation = 'COMPARE'
        cmpn.inputs[1].default_value = t
        cmpn.inputs[2].default_value = 0.1
        nt.links.new(ti.outputs[0], cmpn.inputs[0])
        mul = nt.nodes.new('ShaderNodeMath')
        mul.operation = 'MULTIPLY'
        mul.inputs[1].default_value = sv - 1
        nt.links.new(cmpn.outputs[0], mul.inputs[0])
        if acc is None:
            acc = mul
        else:
            add = nt.nodes.new('ShaderNodeMath')
            nt.links.new(acc.outputs[0], add.inputs[0])
            nt.links.new(mul.outputs[0], add.inputs[1])
            acc = add
    one = nt.nodes.new('ShaderNodeMath')
    one.inputs[1].default_value = 1.0
    nt.links.new(acc.outputs[0], one.inputs[0])
    sc_ = nt.nodes.new('ShaderNodeVectorMath')
    sc_.operation = 'SCALE'
    nt.links.new(uv0.outputs[0], sc_.inputs[0])
    nt.links.new(one.outputs[0], sc_.inputs['Scale'])
    fr = nt.nodes.new('ShaderNodeVectorMath')
    fr.operation = 'FRACTION'
    nt.links.new(sc_.outputs[0], fr.inputs[0])
    col = nt.nodes.new('ShaderNodeMath')
    col.operation = 'WRAP'
    col.inputs[1].default_value = man['cols']
    col.inputs[2].default_value = 0
    nt.links.new(ti.outputs[0], col.inputs[0])
    row = nt.nodes.new('ShaderNodeMath')
    row.operation = 'DIVIDE'
    row.inputs[1].default_value = man['cols']
    nt.links.new(ti.outputs[0], row.inputs[0])
    rowf = nt.nodes.new('ShaderNodeMath')
    rowf.operation = 'FLOOR'
    nt.links.new(row.outputs[0], rowf.inputs[0])
    sf = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(fr.outputs[0], sf.inputs[0])
    IN = 1.5 / 512 * man['cols']
    # u = (col + IN + fx (1 - 2 IN)) / cols ; v (Blender, up) = 1 - (row + IN + fy (1 - 2 IN)) / rows
    def lin(a_sock, b_sock, k, div, flip):
        m1 = nt.nodes.new('ShaderNodeMath')
        m1.operation = 'MULTIPLY_ADD'
        m1.inputs[1].default_value = 1 - 2 * IN
        m1.inputs[2].default_value = IN
        nt.links.new(b_sock, m1.inputs[0])
        a2 = nt.nodes.new('ShaderNodeMath')
        nt.links.new(a_sock, a2.inputs[0])
        nt.links.new(m1.outputs[0], a2.inputs[1])
        d = nt.nodes.new('ShaderNodeMath')
        d.operation = 'DIVIDE'
        d.inputs[1].default_value = div
        nt.links.new(a2.outputs[0], d.inputs[0])
        if not flip:
            return d.outputs[0]
        f = nt.nodes.new('ShaderNodeMath')
        f.operation = 'SUBTRACT'
        f.inputs[0].default_value = 1.0
        nt.links.new(d.outputs[0], f.inputs[1])
        return f.outputs[0]
    u = lin(col.outputs[0], sf.outputs[0], 0, man['cols'], False)
    v = lin(rowf.outputs[0], sf.outputs[1], 0, man['rows'], True)
    cmb = nt.nodes.new('ShaderNodeCombineXYZ')
    nt.links.new(u, cmb.inputs[0])
    nt.links.new(v, cmb.inputs[1])
    photo = nt.nodes.new('ShaderNodeMath')  # 1 if the tile has a photo in the atlas
    photo.inputs[0].default_value = 0
    photo.inputs[1].default_value = 0
    accp = None
    for t in PHOTO:
        cm = nt.nodes.new('ShaderNodeMath')
        cm.operation = 'COMPARE'
        cm.inputs[1].default_value = t
        cm.inputs[2].default_value = 0.1
        nt.links.new(ti.outputs[0], cm.inputs[0])
        if accp is None:
            accp = cm
        else:
            ad = nt.nodes.new('ShaderNodeMath')
            nt.links.new(accp.outputs[0], ad.inputs[0])
            nt.links.new(cm.outputs[0], ad.inputs[1])
            accp = ad
    return cmb.outputs[0], accp.outputs[0], ti.outputs[0]


def hp_material(kind):
    mat = bpy.data.materials.get('hp_' + kind) or bpy.data.materials.new('hp_' + kind)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    auv, photo, ti = atlas_uv(nt)
    if kind == 'normal':
        tn = nt.nodes.new('ShaderNodeTexImage')
        tn.image = ATL['normal']
        tn.interpolation = 'Cubic'
        nt.links.new(auv, tn.inputs[0])
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nm.uv_map = 'UVMap'
        # glTF / three convention normal tiles; the photo atlas only (procedural tiles: flat)
        mix = nt.nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        nt.links.new(photo, mix.inputs[0])
        mix.inputs[6].default_value = (0.5, 0.5, 1, 1)
        nt.links.new(tn.outputs[0], mix.inputs[7])
        nt.links.new(mix.outputs[2], nm.inputs['Color'])
        nm.inputs['Strength'].default_value = 0.8
        bs = nt.nodes.new('ShaderNodeBsdfPrincipled')
        nt.links.new(nm.outputs[0], bs.inputs['Normal'])
        nt.links.new(bs.outputs[0], out.inputs[0])
        return mat
    em = nt.nodes.new('ShaderNodeEmission')
    nt.links.new(em.outputs[0], out.inputs[0])
    if kind == 'base':
        ta = nt.nodes.new('ShaderNodeTexImage')
        ta.image = ATL['albedo']
        nt.links.new(auv, ta.inputs[0])
        vc = nt.nodes.new('ShaderNodeVertexColor')
        vc.layer_name = 'Color'
        g = nt.nodes.new('ShaderNodeMix')  # photo tiles: tint * tile * gain; others: tint * 0.85
        g.data_type = 'RGBA'
        nt.links.new(photo, g.inputs[0])
        g.inputs[6].default_value = (0.85, 0.85, 0.85, 1)
        gain = nt.nodes.new('ShaderNodeMix')
        gain.data_type = 'RGBA'
        gain.blend_type = 'MULTIPLY'
        gain.inputs[0].default_value = 1.0
        nt.links.new(ta.outputs[0], gain.inputs[6])
        gain.inputs[7].default_value = (1.28, 1.28, 1.28, 1)
        nt.links.new(gain.outputs[2], g.inputs[7])
        mul = nt.nodes.new('ShaderNodeMix')
        mul.data_type = 'RGBA'
        mul.blend_type = 'MULTIPLY'
        mul.inputs[0].default_value = 1.0
        nt.links.new(vc.outputs[0], mul.inputs[6])
        nt.links.new(g.outputs[2], mul.inputs[7])
        nt.links.new(mul.outputs[2], em.inputs[0])
    elif kind == 'id':
        # R = metalness (albedo alpha of photo tiles), G = roughness (normal alpha), B = tile id / 32
        ta = nt.nodes.new('ShaderNodeTexImage')
        ta.image = ATL['albedo']
        nt.links.new(auv, ta.inputs[0])
        tn = nt.nodes.new('ShaderNodeTexImage')
        tn.image = ATL['normal']
        nt.links.new(auv, tn.inputs[0])
        cmb = nt.nodes.new('ShaderNodeCombineColor')
        nt.links.new(ta.outputs['Alpha'], cmb.inputs[0])
        nt.links.new(tn.outputs['Alpha'], cmb.inputs[1])
        d = nt.nodes.new('ShaderNodeMath')
        d.operation = 'DIVIDE'
        d.inputs[1].default_value = 32
        nt.links.new(ti, d.inputs[0])
        nt.links.new(d.outputs[0], cmb.inputs[2])
        nt.links.new(cmb.outputs[0], em.inputs[0])
    elif kind == 'edge':
        C.edge_emission(nt, em, 0.006)
    return mat


def hp_pass(kind):
    hp.data.materials.clear()
    hp.data.materials.append(hp_material(kind))


# ------------------------------------------------------------ atlas UVs + bakes (bake UV = new layer 'bake')
C.unwrap_atlas([lo], margin=0.002, layer='bake', shrink=(0.12, 0.5))
bmat = C.bake_material('lp_bake', uv='bake')
lo.data.materials.clear()
lo.data.materials.append(bmat)
IMG = {}
hs = lambda o: [hp]  # noqa: E731
hp_pass('normal')
IMG['normal'] = C.new_image(NAME + '_normal', TEX)
C.bake('NORMAL', [lo], hs, IMG['normal'], samples=2, extrusion=0.01, ray=0.03, margin=8)
print('[factory] baked normal')
sc.world = bpy.data.worlds.new('bakeworld')
sc.world.light_settings.distance = 0.35
IMG['ao'] = C.new_image(NAME + '_ao', TEX // 2)
C.bake('AO', [lo], hs, IMG['ao'], samples=48, extrusion=0.01, ray=0.03)
print('[factory] baked ao')
for kind in ('base', 'id', 'edge'):
    hp_pass(kind)
    IMG[kind] = C.new_image(NAME + '_' + kind, TEX if kind == 'base' else TEX // 2)
    C.bake('EMIT', [lo], hs, IMG[kind], samples=8 if kind == 'edge' else 4, extrusion=0.01, ray=0.03)
    print('[factory] baked', kind)
for kind in ('pos', 'nrm', 'noise', 'noise2'):
    C.lp_pass(bmat, kind, BB_MIN, BB_SIZE, IMG['normal'], scale=0.4)
    IMG[kind] = C.new_image(NAME + '_' + kind, TEX // 2)
    C.bake('EMIT', [lo], lambda o: [], IMG[kind], samples=1)
    print('[factory] baked', kind)

# ------------------------------------------------------------ numpy composite (1024 working size, base 2048)
def px_live(k, size=TEX // 2):
    a = C.pixels(IMG[k if k != 'base2' else 'base'])
    if k == 'base2':
        return a
    if a.shape[0] != size:
        f = a.shape[0] // size
        a = a.reshape(size, f, size, f, 4).mean(axis=(1, 3))
    return a


SAVED = {k: px_live(k) for k in ('base', 'base2', 'id', 'ao', 'edge', 'pos', 'nrm', 'noise', 'noise2')}
np.savez_compressed(BAKES, **{k: v.astype(np.float16) for k, v in SAVED.items()})
composite(lambda k: SAVED[k])
IMG['normal'].filepath_raw = os.path.join(C.BUILD, NAME + '-normal.png')
IMG['normal'].file_format = 'PNG'
IMG['normal'].save()
print('[factory] textures written')

# ------------------------------------------------------------ LODs, studio, export
export = [lo]  # LOD1 / LOD2: pack.mjs
print('[factory] export tris', {o.name: C.tris(o) for o in export})
for o in export:
    me = o.data
    for name in [u.name for u in me.uv_layers if u.name != 'bake']:
        me.uv_layers.remove(me.uv_layers[name])
    for a in [a.name for a in me.attributes if a.name in ('Color',)]:
        me.attributes.remove(me.attributes[a])
hp.hide_render = True
studio_render(lo)
C.select(export)
bpy.ops.export_scene.gltf(
    filepath=os.path.join(C.BUILD, NAME + '-raw.glb'),
    export_format='GLB',
    use_selection=True,
    export_materials='NONE',
    export_vertex_color='NONE',
    export_normals=True,
    export_texcoords=True,
    export_apply=True,
    export_yup=True,
)
print('[factory] OK_DONE')
