# Blender 5.2.2 (LTS) - NV4 submarine kit: the nuclear boat (USA, Russia, China) and the conventional one (Israel,
# Germany, Korea, Turkey). Render only (sim/sub.ts; src/render/naval/subs.ts).
#   nice -n 15 /opt/blender/blender -b --factory-startup -P web/tools/blender/naval/subkit.py -- <out_dir> [kit|sheet|cameos|all]
#   (or web/tools/blender/naval/make.sh sub)
#
# Uses the NV1 naval kit's primitives, AO bake and LODs (navalkit.py). Writes next to its output:
#   naval-sub-raw.glb (pack.mjs -> public/models/naval/naval-sub.glb), the entries in naval.json, diver-style
#   sub-sheet.png (contact sheet) and cameo-sub_nuc.png / cameo-sub_con.png (the build menu's pictures).
# Seven models "sm_<nation>" (a hull tone and a deck tone per nation, no markings; the player's colour on a patch on
# the sail and on the tail fin tips: the 'team' material). Nuclear: a long, blunt-nosed hull, a tall sail with its
# planes, a cruciform tail with a shrouded propeller, a missile bay (two hatch doors). Conventional: a smaller teardrop
# hull, a low sail, an X-less cruciform tail, a small missile hatch.
# Pieces per model (root empty "sm_<nation>", facing +X, waterline z = 0, surfaced; the game lowers it to dive):
#   sm_<n>_body               hull, sail and masts, fins, the tail
#   sm_<n>_hatchL / _hatchR   the missile hatch doors, pivot at their outer hinge edge: open about the boat's X axis
#   muzzle_sm_<n>             the missile launch point (over the bay)
import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import navalkit as nk  # noqa: E402

OUT = nk.OUT
STEP = nk.STEP

# nation: (hull, casing, kind)
NATIONS = {
    'usa': (0x2b3239, 0x1e2327, 'nuc'),
    'russia': (0x23292d, 0x181c1f, 'nuc'),
    'china': (0x2c3331, 0x1e2422, 'nuc'),
    'israel': (0x2e353b, 0x20262a, 'con'),
    'germany': (0x283038, 0x1b2126, 'con'),
    'korea': (0x2d3439, 0x1f2428, 'con'),
    'turkey': (0x2a3135, 0x1d2225, 'con'),
}
SAIL, MAST, FIN, PROP = 0x30383e, 0x1a1d20, 0x262c31, 0x3b3f42
BAY = 0x0f1113

SPEC = {
    # L length, R radius, sail x/height, bay x0..x1, bay half width, budget
    'nuc': dict(L=2.3, R=0.17, sx=0.05, sh=0.2, sl=0.42, sw=0.1, bay=(-0.95, -0.35), bw=0.09, tail=0.17, planes=True, b0=760, b1=280),
    'con': dict(L=1.5, R=0.11, sx=0.06, sh=0.15, sl=0.28, sw=0.07, bay=(-0.5, -0.22), bw=0.055, tail=0.12, planes=False, b0=600, b1=220),
}


def circle(x, r, ry, n=14, z0=0.0):
    return [(x, math.sin(2 * math.pi * k / n) * r, z0 + math.cos(2 * math.pi * k / n) * ry) for k in range(n)]


def hull_secs(kind, L, R):
    secs = []
    N = 26
    for i in range(N + 1):
        t = i / N
        if kind == 'nuc':
            if t < 0.1:
                f = math.sqrt(max(0.0, 1 - ((0.1 - t) / 0.1) ** 2))
            elif t < 0.72:
                f = 1.0
            else:
                f = 1 - 0.86 * ((t - 0.72) / 0.28) ** 1.4
        else:
            if t < 0.2:
                f = math.sqrt(max(0.0, 1 - ((0.2 - t) / 0.2) ** 2))
            elif t < 0.4:
                f = 1.0
            else:
                f = 1 - 0.84 * ((t - 0.4) / 0.6) ** 1.5
        r = max(0.004, R * f)
        pts = circle(L / 2 - L * t, r, r * 0.95)
        pts.append(pts[0])
        secs.append(pts)
    return secs


def build_model(nation, objs, info):
    hullc, casec, kind = NATIONS[nation]
    S = SPEC[kind]
    L, R = S['L'], S['R']
    nk.PARTS.clear()
    body = []
    body.append(nk.loft(hull_secs(kind, L, R), hullc, name='hull'))
    # the casing strip along the top and the dark missile bay pit
    x0, x1 = S['bay']
    body.append(nk.box(-L * 0.38, L * 0.34, -R * 0.32, R * 0.32, R * 0.84, R * 0.97, casec, 'paint', cell=0.08, name='casing'))
    body.append(nk.box(x0, x1, -S['bw'], S['bw'], R * 0.8, R * 0.9, BAY, 'paint', cell=0.08, name='pit'))
    # the sail: tapered, rounded cap, the player's colour on both sides, masts
    sx, sh, sl, sw = S['sx'], S['sh'], S['sl'], S['sw']
    sail = nk.box(sx - sl / 2, sx + sl / 2, -sw / 2, sw / 2, R * 0.7, R + sh, SAIL, 'paint', cell=0.08, name='sail')
    nk.taper_top(sail, 0.78, 0.7)
    body.append(sail)
    body.append(nk.box(sx - sl * 0.34, sx + sl * 0.3, sw * 0.28, sw * 0.5 + 0.004, R + sh * 0.35, R + sh * 0.62, 0xffffff, 'team', cell=0.08, name='patchL'))
    body.append(nk.box(sx - sl * 0.34, sx + sl * 0.3, -sw * 0.5 - 0.004, -sw * 0.28, R + sh * 0.35, R + sh * 0.62, 0xffffff, 'team', cell=0.08, name='patchR'))
    body.append(nk.bar((sx + 0.02, 0.0, R + sh), (sx + 0.02, 0.0, R + sh + 0.1 * (L / 2.3) + 0.04), 0.008, MAST, 6))
    body.append(nk.bar((sx - 0.07, 0.012, R + sh), (sx - 0.07, 0.012, R + sh + 0.07), 0.006, MAST, 6))
    # (sail planes on the nuclear boat, bow planes on the conventional one)
    if S['planes']:
        for s in (-1, 1):
            body.append(nk.box(sx + 0.02, sx + 0.17, s * (sw / 2), s * (sw / 2 + 0.11), R + sh * 0.45, R + sh * 0.5, FIN, 'paint', cell=0.08, name='plane'))
    else:
        for s in (-1, 1):
            body.append(nk.box(L * 0.3, L * 0.3 + 0.1, s * R * 0.9, s * (R * 0.9 + 0.1), -R * 0.1, -R * 0.06, FIN, 'paint', cell=0.08, name='plane'))
    # the tail: cruciform fins, the propeller shroud, a patch of the player's colour on the upper fin tip
    tx = -L / 2 + 0.08
    T = S['tail']
    body.append(nk.box(tx, tx + 0.2, -T, T, -0.012, 0.012, FIN, 'paint', cell=0.08, name='finH'))
    body.append(nk.box(tx, tx + 0.2, -0.012, 0.012, -T, T, FIN, 'paint', cell=0.08, name='finV'))
    body.append(nk.box(tx + 0.02, tx + 0.16, -0.012 - 0.003, 0.012 + 0.003, T * 0.72, T, 0xffffff, 'team', cell=0.08, name='patchT'))
    body.append(nk.cyl((-L / 2 + 0.03, 0, 0), R * 0.4, 0.08, PROP, 'X', 10, 'paint', cell=1.0, name='shroud'))
    # the hatch doors (two leaves hinged at their outer edges, flush on the bay)
    bw = S['bw']
    hl = [nk.box(x0, x1, 0.0, bw, R * 0.9, R * 0.9 + 0.012, casec, 'paint', cell=0.08, name='hatchL')]
    hr = [nk.box(x0, x1, -bw, 0.0, R * 0.9, R * 0.9 + 0.012, casec, 'paint', cell=0.08, name='hatchR')]
    groups = [('_body', body, (0, 0, 0), S['b0'], S['b1']), ('_hatchL', hl, (0.0, bw, R * 0.9), 30, 12), ('_hatchR', hr, (0.0, -bw, R * 0.9), 30, 12)]
    key = f'sm_{nation}'
    PARTS = [o for g in groups for o in g[1]]
    src = nk.assemble(key + '_src', PARTS)
    nk.bake_ao(src, ground=-R * 1.1, samples=24)
    root = bpy.data.objects.new(key, None)
    bpy.context.scene.collection.objects.link(root)
    tris = 0
    for name, ob, pivot, g0, g1 in nk.split_parts(src, groups):
        lo = nk.decimated(ob, g0, f'{key}{name}_lo')
        lo1 = nk.decimated(ob, g1, f'{key}{name}_l1')
        bpy.data.objects.remove(ob)
        lo.name = f'{key}{name}'
        lo.data.name = lo.name
        for o in (lo, lo1):
            o.data.transform(Matrix.Translation(-Vector(pivot)))
            o.location = pivot
            o.parent = root
            nk.smooth(o)
        tris += nk.ntris(lo)
        objs += [lo, lo1]
    mz = bpy.data.objects.new(f'muzzle_{key}', None)
    bpy.context.scene.collection.objects.link(mz)
    mz.parent = root
    mz.location = ((x0 + x1) / 2, 0, R * 0.95)
    objs += [mz, root]
    info[key] = {'tris': tris, 'len': L, 'beam': R * 2, 'h': R + sh + 0.1, 'kind': kind, 'bay': [(x0 + x1) / 2, R * 0.9], 'bw': bw, 'r': R}
    return root


def build_kit():
    nk.reset()
    w = bpy.data.worlds.new('w')
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (1, 1, 1, 1)
    bpy.context.scene.world = w
    info = {}
    objs = []
    for n in NATIONS:
        build_model(n, objs, info)
        print(f'[sub] sm_{n} {info["sm_" + n]["tris"]} tris', flush=True)
    for o in objs:
        if o.type == 'MESH' and 'Col' in o.data.color_attributes:
            ca = o.data.color_attributes
            ca.active_color = ca['Col']
            ca.render_color_index = ca.active_color_index
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'naval-sub-raw.glb'), export_format='GLB', use_selection=True, export_apply=True, export_yup=True, export_normals=True, export_texcoords=False, export_materials='EXPORT', export_vertex_color='ACTIVE', export_all_vertex_colors=False, export_image_format='NONE')
    jpath = os.path.join(OUT, 'naval.json')
    base = json.load(open(jpath)) if os.path.exists(jpath) else {}
    base.update(info)
    with open(jpath, 'w') as f:
        json.dump(base, f, indent=1)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'sub.blend'))
    print('[sub] OK_DONE', flush=True)


def models():
    return sorted([o for o in bpy.data.objects if o.type == 'EMPTY' and o.parent is None and o.name.startswith('sm_')], key=lambda o: o.name)


def hide_others(keep):
    for o in bpy.data.objects:
        if o.type in ('MESH', 'EMPTY') and not o.name.startswith(('sea', 'Plane')):
            top = o
            while top.parent is not None:
                top = top.parent
            o.hide_render = top.name not in keep or o.name.endswith('_l1')


def sheet():
    bpy.ops.wm.open_mainfile(filepath=os.path.join(OUT, 'sub.blend'))
    nk.preview_setup()
    rs = models()
    order = list(NATIONS)
    for r in rs:
        i = order.index(r.name[3:])
        r.location = (0.0, (i - 3) * 0.62, -0.02)
    # (the first two with a hatch open, to show the bay)
    for r in rs[:1]:
        for c in r.children:
            if c.name.endswith('hatchL'):
                c.rotation_euler = (math.radians(70), 0, 0)
            if c.name.endswith('hatchR'):
                c.rotation_euler = (math.radians(-70), 0, 0)
    hide_others({r.name for r in rs})
    nk.sea_and_shore(40, shore=None)
    nk.camera_sun((4.2, -4.4, 2.6), (0.0, 0.0, 0.05), 38, (1800, 900), 48, os.path.join(OUT, 'sub-sheet.png'))
    print('[sub] sheet', flush=True)


def cameos():
    bpy.ops.wm.open_mainfile(filepath=os.path.join(OUT, 'sub.blend'))
    nk.preview_setup()
    nk.sea_and_shore(40, shore=None)
    for key, nation, dist in (('sub_nuc', 'usa', 2.9), ('sub_con', 'israel', 2.0)):
        rs = models()
        for r in rs:
            r.location = (0, 0, -0.02)
        hide_others({f'sm_{nation}'})
        nk.camera_sun((dist * 0.75, -dist * 0.78, dist * 0.34), (0.0, 0.0, 0.07), 40, (576, 432), 40, os.path.join(OUT, f'cameo-{key}.png'))
        print('[sub] cameo', key, flush=True)


if __name__ == '__main__':
    if STEP in ('kit', 'all'):
        build_kit()
    if STEP in ('sheet', 'all'):
        sheet()
    if STEP in ('cameos', 'all'):
        cameos()
