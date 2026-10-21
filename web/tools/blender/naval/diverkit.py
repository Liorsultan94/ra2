# Blender 5.2.2 (LTS) - NV3 diver kit: the Combat Diver (render only; sim/diver.ts).
#   nice -n 15 /opt/blender/blender -b --factory-startup -P web/tools/blender/naval/diverkit.py -- <out_dir> [kit|sheet|cameos|all]
#   (or web/tools/blender/naval/make.sh diver)
#
# Uses the NV1 naval kit's primitives, AO bake and LODs (navalkit.py) and writes next to its output:
#   naval-diver-raw.glb (pack.mjs -> public/models/naval/naval-diver.glb) and the diver's entry in naval.json
#   (run after the naval kit: it adds to that file), cameo-diver.png (the build menu's picture, every nation's diver).
# One model for every nation: a black wetsuit, black fins, a mask, an air tank and a rifle; the player's colour on a
# small patch (the tank's band and both shoulders: the 'team' material), no logos.
# Pieces (one root empty "dv_diver", its meshes as children, feet on z = 0, facing +X; "<mesh>_l1" the far LOD):
#   dv_diver_body            torso, head and hood, mask, air tank and hoses, the rifle (held across the chest)
#   dv_diver_armL / _armR    pivot at the shoulder: swing / stroke while walking and swimming
#   dv_diver_legL / _legR    pivot at the hip, the fin at the foot: kick (fins flat, long: waddling on land)
# The game poses them (src/render/naval/diver.ts): upright on land, the whole figure pitched prone at the hip to swim.
# Units: one game tile = 1; a 1.8 m diver is 0.34 tiles tall, as the infantry kit. Blender X forward, Y left, Z up.
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
M = 0.34 / 1.8  # tiles per metre

SUIT, SUIT2, FIN, FINEDGE, GLOVE, BOOT = 0x1b1e21, 0x2b3035, 0x0f1011, 0x30363b, 0x131516, 0x0e0f10
TANK, TANKCAP, RIFLE, RIFLE2, GLASS, HOSE, HOSE2 = 0x34393e, 0x6a7076, 0x2a2c2e, 0x1c1d1f, 0x2a3f4c, 0x16181a, 0x4a4f54


def bx(x0, x1, y0, y1, z0, z1, col, m='paint', cell=0.03, name='box'):
    return nk.box(x0 * M, x1 * M, y0 * M, y1 * M, z0 * M, z1 * M, col, m, cell=cell, name=name)


def cy(c, r, h, col, axis='Z', verts=10, m='paint', r2=None, name='cyl'):
    return nk.cyl((c[0] * M, c[1] * M, c[2] * M), r * M, h * M, col, axis, verts, m, r2=None if r2 is None else r2 * M, cell=1.0, name=name)


def br(a, b, r, col, verts=6):
    return nk.bar((a[0] * M, a[1] * M, a[2] * M), (b[0] * M, b[1] * M, b[2] * M), r * M, col, verts)


def blade(pts, z0, z1, col, name='blade'):
    return nk.prism([(x * M, y * M) for x, y in pts], z0 * M, z1 * M, col, cell=0.0, name=name)


# the figure, in metres: x forward, y left, z up
HIP = 0.92
SH = 1.43


def arm(side):
    """side +1 = left (Blender +Y). The arms hold the rifle: the right hand at the grip, the left under the fore-end."""
    s = side
    sh = (0.0, s * 0.215, SH)
    if s < 0:
        el, hd = (0.02, s * 0.29, 1.18), (0.30, -0.075, 1.13)
    else:
        el, hd = (0.10, s * 0.29, 1.21), (0.62, 0.03, 1.15)
    p = [
        br(sh, el, 0.052, SUIT),
        br(el, hd, 0.043, SUIT),
        nk.box((hd[0] - 0.045) * M, (hd[0] + 0.05) * M, (hd[1] - 0.04) * M, (hd[1] + 0.04) * M, (hd[2] - 0.04) * M, (hd[2] + 0.04) * M, GLOVE, 'paint', cell=0.03),
        # the sleeve's seam stripe and the player's colour on the shoulder
        br((sh[0], sh[1], sh[2] + 0.002), (el[0], el[1] + s * 0.004, el[2] + 0.06), 0.012, SUIT2),
        bx(-0.055, 0.055, s * 0.215 - 0.05, s * 0.215 + 0.05, SH + 0.04, SH + 0.06, 0xffffff, 'team'),
    ]
    return p


def leg(side):
    """The leg and its fin: the fin a long flat blade at the foot, pointing forward."""
    s = side
    hip = (0.0, s * 0.10, HIP)
    knee = (0.02, s * 0.105, 0.50)
    ank = (0.0, s * 0.11, 0.10)
    p = [
        br(hip, knee, 0.075, SUIT, 7),
        br(knee, ank, 0.055, SUIT, 7),
        br((hip[0] + 0.0, hip[1] + s * 0.07, hip[2] - 0.05), (knee[0], knee[1] + s * 0.07, knee[2] + 0.02), 0.01, SUIT2),
        bx(-0.07, 0.15, s * 0.11 - 0.055, s * 0.11 + 0.055, 0.0, 0.11, BOOT),
        # the fin: from the boot out along the floor, a gentle rise at the tip
        blade([(0.12, -0.07), (0.50, -0.115), (0.60, -0.10), (0.62, 0.0), (0.60, 0.10), (0.50, 0.115), (0.12, 0.07)], 0.0, 0.022, FIN, 'fin'),
        blade([(0.15, -0.04), (0.50, -0.07), (0.50, -0.055), (0.15, -0.025)], 0.022, 0.03, FINEDGE, 'fe1'),
        blade([(0.15, 0.025), (0.50, 0.055), (0.50, 0.07), (0.15, 0.04)], 0.022, 0.03, FINEDGE, 'fe2'),
    ]
    for q in p[-3:]:
        q.data.transform(Matrix.Translation((0, s * (0.11 * M), 0)))
    return p


def body():
    p = []
    # torso: a tapered box, the wetsuit; the pelvis; the neck
    t = bx(-0.13, 0.13, -0.2, 0.2, 0.92, 1.46, SUIT, name='torso')
    nk.taper_top(t, 0.86, 0.8)
    p.append(t)
    p.append(bx(-0.12, 0.12, -0.17, 0.17, 0.86, 0.96, SUIT))
    # a chest strap and the weight belt
    p.append(bx(-0.135, 0.135, -0.205, 0.205, 0.98, 1.04, SUIT2))
    p.append(cy((0, 0, 1.49), 0.05, 0.1, SUIT, verts=8))
    # the head in its hood, the mask
    p.append(cy((0.01, 0, 1.64), 0.095, 0.2, SUIT, verts=10, r2=0.082))
    p.append(cy((0.01, 0, 1.76), 0.07, 0.04, SUIT, verts=10, r2=0.03))
    p.append(bx(0.075, 0.115, -0.075, 0.075, 1.6, 1.69, HOSE))
    p.append(bx(0.105, 0.12, -0.062, 0.062, 1.615, 1.675, GLASS, 'glass', cell=0.0))
    # the air tank on the back: twin cylinders, the valve cap and the player's colour band
    for yy in (-0.065, 0.065):
        p.append(cy((-0.2, yy, 1.17), 0.062, 0.5, TANK, verts=10))
        p.append(cy((-0.2, yy, 1.43), 0.05, 0.045, TANKCAP, verts=8, r2=0.03))
    p.append(bx(-0.275, -0.14, -0.12, 0.12, 1.28, 1.36, 0xffffff, 'team'))
    p.append(bx(-0.215, -0.185, -0.1, 0.1, 1.2, 1.43, HOSE2))
    # the regulator hose from the valve to the mouth
    p.append(br((-0.2, 0.0, 1.45), (-0.05, 0.1, 1.66), 0.012, HOSE))
    p.append(br((-0.05, 0.1, 1.66), (0.09, 0.03, 1.62), 0.012, HOSE))
    # a dive knife on the calf side of the hip (a small dark blade), the rifle held across the chest
    p.append(bx(0.0, 0.05, 0.19, 0.21, 0.78, 0.92, 0x4a4f54))
    return p


def build_diver(info, objs):
    root = bpy.data.objects.new('dv_diver', None)
    bpy.context.scene.collection.objects.link(root)
    nk.PARTS.clear()
    arms = {1: arm(1), -1: arm(-1)}
    legs = {1: leg(1), -1: leg(-1)}
    bod = body()
    gun = [bx(0.1, 0.62, -0.075, -0.015, 1.12, 1.2, RIFLE), bx(0.0, 0.14, -0.07, -0.02, 1.09, 1.19, RIFLE2), bx(0.62, 0.86, -0.05, -0.035, 1.14, 1.17, RIFLE2), bx(0.3, 0.36, -0.07, -0.02, 0.98, 1.12, RIFLE2), bx(0.45, 0.58, -0.06, -0.03, 1.2, 1.235, RIFLE2)]
    groups = [
        ('_body', bod, (0, 0, 0), 620, 230),
        ('_armL', arms[1], (0.0, 0.215 * M, SH * M), 150, 60),
        ('_armR', arms[-1] + gun, (0.0, -0.215 * M, SH * M), 230, 90),
        ('_legL', legs[1], (0.0, 0.10 * M, HIP * M), 220, 90),
        ('_legR', legs[-1], (0.0, -0.10 * M, HIP * M), 220, 90),
    ]
    src = nk.assemble('dv_diver_src', [o for g in groups for o in g[1]])
    nk.bake_ao(src, ground=-0.002, samples=24)
    tris = 0
    for name, ob, pivot, g0, g1 in nk.split_parts(src, groups):
        lo = nk.decimated(ob, g0, f'dv_diver{name}_lo')
        lo1 = nk.decimated(ob, g1, f'dv_diver{name}_l1')
        bpy.data.objects.remove(ob)
        lo.name = f'dv_diver{name}'
        lo.data.name = lo.name
        for o in (lo, lo1):
            o.data.transform(Matrix.Translation(-Vector(pivot)))
            o.location = pivot
            o.parent = root
            nk.smooth(o)
        tris += nk.ntris(lo)
        objs += [lo, lo1]
    objs.append(root)
    info['dv_diver'] = {'tris': tris, 'len': 0.34 * 0.9, 'h': 0.34, 'hip': HIP * M, 'shoulder': SH * M}
    return root


def build_kit():
    nk.reset()
    w = bpy.data.worlds.new('w')
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Color'].default_value = (1, 1, 1, 1)
    bpy.context.scene.world = w
    info = {}
    objs = []
    build_diver(info, objs)
    print(f'[diver] dv_diver {info["dv_diver"]["tris"]} tris', flush=True)
    for o in objs:
        if o.type == 'MESH' and 'Col' in o.data.color_attributes:
            ca = o.data.color_attributes
            ca.active_color = ca['Col']
            ca.render_color_index = ca.active_color_index
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, 'naval-diver-raw.glb'), export_format='GLB', use_selection=True, export_apply=True, export_yup=True, export_normals=True, export_texcoords=False, export_materials='EXPORT', export_vertex_color='ACTIVE', export_all_vertex_colors=False, export_image_format='NONE')
    jpath = os.path.join(OUT, 'naval.json')
    base = json.load(open(jpath)) if os.path.exists(jpath) else {}
    base.update(info)
    with open(jpath, 'w') as f:
        json.dump(base, f, indent=1)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'diver.blend'))
    print('[diver] OK_DONE', flush=True)


# ------------------------------------------------------------------ contact sheet and cameo (Cycles)

def pose(root, x, y, prone=False, kick=0.0, team=None):
    """A copy of the diver at (x, y): standing (on sand), or prone as it swims (rotated about the hip, legs kicking)."""
    r = root.copy()
    bpy.context.scene.collection.objects.link(r)
    kids = {}
    for c in root.children:
        if c.name.endswith('_l1'):
            continue
        cc = c.copy()
        bpy.context.scene.collection.objects.link(cc)
        cc.parent = r
        kids[c.name.replace('dv_diver', '')] = cc
    r.location = (x, y, 0)
    if prone:
        # about the hip: the body lies face down along the surface, the arms trail, the legs kick
        r.location = (x, y, HIP * M * 0.55)
        r.rotation_euler = (0, math.radians(78), 0)
        r.location.x = x - 0.02
        for k in ('_armL', '_armR'):
            if k in kids:
                kids[k].rotation_euler = (0, -1.25, 0)  # trailing along the body
        if '_legL' in kids:
            kids['_legL'].rotation_euler = (0, kick, 0)
            kids['_legR'].rotation_euler = (0, -kick, 0)
    return r


def sheet():
    bpy.ops.wm.open_mainfile(filepath=os.path.join(OUT, 'diver.blend'))
    nk.preview_setup()
    root = bpy.data.objects['dv_diver']
    keep = {'dv_diver'}
    placed = [pose(root, 0.0, 0.0), pose(root, 0.0, 0.34, prone=True, kick=0.35), pose(root, 0.0, -0.34, prone=True, kick=-0.3)]
    for o in bpy.data.objects:
        if o.type in ('MESH', 'EMPTY'):
            top = o
            while top.parent is not None:
                top = top.parent
            o.hide_render = o.name.endswith('_l1') or top.name == 'dv_diver'
    for r in placed:
        r.hide_render = False
    nk.sea_and_shore(20, shore=None)
    nk.camera_sun((1.0, -0.85, 0.55), (0.0, 0.0, 0.14), 36, (1600, 900), 48, os.path.join(OUT, 'diver-sheet.png'))
    print('[diver] sheet', flush=True)


def cameos():
    bpy.ops.wm.open_mainfile(filepath=os.path.join(OUT, 'diver.blend'))
    nk.preview_setup()
    root = bpy.data.objects['dv_diver']
    for o in bpy.data.objects:
        if o.type in ('MESH', 'EMPTY'):
            top = o
            while top.parent is not None:
                top = top.parent
            o.hide_render = o.name.endswith('_l1') or top.name == 'dv_diver'
    sand = nk.sea_and_shore(20, shore=0.12)
    stand = pose(root, 0.0, 0.0)
    for c in stand.children:
        c.hide_render = False
    stand.hide_render = False
    # the cameo: the diver standing on the sand at the water's edge, the sea behind it
    nk.camera_sun((0.62, -0.5, 0.3), (0.0, 0.0, 0.15), 48, (576, 432), 40, os.path.join(OUT, 'cameo-diver.png'))
    print('[diver] cameo diver', flush=True)


if __name__ == '__main__':
    if STEP in ('kit', 'all'):
        build_kit()
    if STEP in ('sheet', 'all'):
        sheet()
    if STEP in ('cameos', 'all'):
        cameos()
