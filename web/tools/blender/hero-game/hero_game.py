# Blender 5.2.2 (LTS) - Iron Front: the BI2 hero IDF soldier converted into the game's Israeli rifleman skin.
#
#   nice blender -b --factory-startup -P tools/blender/hero-game/hero_game.py -- <stage>   (from web/)
#   (tools/blender/hero-game/make.sh runs the whole chain)
#
# Inputs
#   $HERO_WORK/stage2.blend, stage2_posed.blend  the hero built by the BI2 scripts (tools/blender/hero/build.sh
#                                                stages 1, 2, 2b; make.sh rebuilds them), Blender world:
#                                                metres, Z up, facing -Y, his left = +X
#   build/idf-rifleman-proc.json                 the game skeleton at rest (export-procedural.ts)
# Stages
#   prep   the dressed A-pose hero (stage2) + the gloved fists and the Tavor from the posed hero (stage2b),
#          cut per game bone and moved rigidly into the game skeleton's rest pose and proportions (arms and
#          legs straightened onto the game's joints, the fists on the forearms the way they grip in the hero
#          pose, the rifle on the weapon bone fitted butt-to-muzzle) -> build/hero-game-high.blend
#          (per bone "HP_<bone>": the full-detail hero surfaces with their procedural materials)
#   lods   per bone low polys: voxel remesh + collapse decimation of the high poly, smart-project UV atlases;
#          two tiers: "play" (game LOD0, LOD1 / LOD2 are meshoptimizer subsets in pack.mjs) and "hero"
#          (close-up / portrait mesh) -> build/hero-game-lods.blend
#   bake   per tier: Cycles bakes high -> low (tangent normal, diffuse colour of the procedural materials,
#          roughness, material masks, soft AO) + low-poly position / normal / bone-id passes, numpy composite
#          (albedo with a light AO, orm = player-colour mask / roughness / metal) -> build/<id>[-hero]-*.png,
#          build/<id>[-hero]-raw.glb (one mesh per bone, in the bone's modelling frame)
#   render studio renders of both tiers with the final maps (build/<id>-studio*.png)
#   all    prep, lods, bake, render
import bpy
import bmesh
import json
import math
import os
import sys
import time

import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import common as C  # noqa: E402

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
STAGE = ARGS[0] if ARGS else 'all'
NAME = 'idf-rifleman'
WORK = os.environ.get('HERO_WORK', '/tmp/claude-0/BI3/work/hero')
HIGH = os.path.join(C.BUILD, 'hero-game-high.blend')
LODS = os.path.join(C.BUILD, 'hero-game-lods.blend')
T0 = time.time()


def log(*a):
    print('[hero-game %5.0fs]' % (time.time() - T0), *a, flush=True)


meta = json.load(open(os.path.join(C.BUILD, NAME + '-proc.json')))
REST = {k: Vector(v['rest'][12:15]) for k, v in meta['bones'].items()}
FRAME = {k: Vector(v['frameRest'][12:15]) for k, v in meta['bones'].items()}
for k, v in meta['bones'].items():
    r = v['frameRest']
    assert abs(r[0] - 1) < 1e-6 and abs(r[5] - 1) < 1e-6 and abs(r[10] - 1) < 1e-6, 'rest frames are axis aligned'

# ------------------------------------------------------------------ tiers and budgets
# triangles per bone (the play tier is the game's LOD0; pack.mjs derives LOD1 / LOD2), voxel sizes (m)
BONES = ['ahips', 'achest', 'aneck', 'ahead', 'auaR', 'auaL', 'afaR', 'afaL', 'ahdR', 'ahdL', 'athR', 'athL', 'ashR', 'ashL', 'aftR', 'aftL', 'awpn']
PLAY = {'ahips': 200, 'achest': 700, 'aneck': 40, 'ahead': 400, 'auaR': 100, 'auaL': 100, 'afaR': 80, 'afaL': 80, 'ahdR': 100, 'ahdL': 100,
        'athR': 120, 'athL': 120, 'ashR': 95, 'ashL': 95, 'aftR': 100, 'aftL': 100, 'awpn': 330}
HERO_K = 4.6  # hero tier = play budget x this (~13k triangles)
TIERS = {
    # name: (asset id, budget scale, voxel, atlas size, uv margin)
    'play': (NAME, 1.0, 0.008, 1024, 0.006),
    'hero': (NAME + '-hero', HERO_K, 0.0045, 2048, 0.003),
}
# closing radius per bone (x the tier's): wide enough that the air under loose cloth closes into one solid,
# finer on the small hard parts
VOX_K = {'ahead': 0.6, 'ahd': 0.5, 'awpn': 0.4, 'aft': 0.7, 'aneck': 0.8}
ERODE = 0.75  # share of the closing radius pulled back in
FIST_GRIP = 0.06  # grip centre below the wrist after the fit (the game's hand centre is 0.04 below it)
RELAX = int(os.environ.get('HG_RELAX', '12'))
DROP = 0.04  # remeshed islands under this share of the bone's biggest one are dropped (baked only)
XS = 1.06  # limb cross-section scale (the game's figures are a touch heroic, so they read at RTS zoom)
RIFLE_K = (1.0, 1.12, 1.3)  # infantry.ts RIFLE_K: the rifle's cross-section, chunkier than life

# ------------------------------------------------------------------ hero -> game coordinates
# hero world (x left, -y forward, z up) -> game body space (x forward, y up, z right)
H2G = Matrix(((0, -1, 0, 0), (0, 0, 1, 0), (-1, 0, 0, 0), (0, 0, 0, 1)))


def h2g(p):
    return Vector((-p.y, p.z, -p.x))


# arm joints of the hero rig at rest (A-pose), hero world, left side (+x); the right side mirrors x
ARM_S = Vector((0.185, -0.005, 1.425))
ARM_E = Vector((0.306, 0.0, 1.175))
ARM_W = Vector((0.396, -0.063, 0.958))
ARM_D = Vector((0.389, 0.0, -0.921)).normalized()


def arm_t(p):
    """Distance along the hero's A-pose arm axis from the shoulder joint, and radial distance."""
    sx = 1.0 if p.x >= 0 else -1.0
    q = Vector((abs(p.x) - ARM_S.x, p.z - ARM_S.z))
    t = q.x * ARM_D.x + q.y * ARM_D.z
    perp = (q.x - ARM_D.x * t, q.y - ARM_D.z * t)
    return t, math.hypot(math.hypot(*perp), p.y)


T_ELBOW = (ARM_E - ARM_S).length
T_WRIST = T_ELBOW + (ARM_W - ARM_E).length


def is_arm(p):
    # hero_lib.is_arm, the arm volume beside the torso in the A-pose
    return (abs(p.x) > 0.185 or (abs(p.x) > 0.16 and p.z > 1.33)) and p.z > 0.86 and arm_t(p)[0] > -0.02 and arm_t(p)[1] < 0.15


def body_visible(p):
    # stage2b's mask: only the head and the neck of the body show
    return p.z > 1.525 + 0.6 * max(0.0, abs(p.x) - 0.055) and abs(p.x) < 0.085


def side_of(z):
    return 'R' if z > 0 else 'L'


def limb_xf(a_h, b_h, a_g, b_g, xs=XS):
    """Rigid swing of a hero limb segment (game coords a_h -> b_h) onto the game's (a_g -> b_g): rotation
    taking one axis onto the other about a_h, scaled along the axis to the game length, the cross-section by
    xs, moved onto a_g."""
    dh = (b_h - a_h)
    dg = (b_g - a_g)
    rot = dh.normalized().rotation_difference(dg.normalized()).to_matrix().to_4x4()
    s = dg.length / dh.length
    ax = dg.normalized()
    # scale s along ax, xs across: xs * I + (s - xs) * ax ax^T
    S = Matrix.Identity(3) * xs
    for i in range(3):
        for j in range(3):
            S[i][j] += (s - xs) * ax[i] * ax[j]
    return Matrix.Translation(a_g) @ S.to_4x4() @ rot @ Matrix.Translation(-a_h)


# ------------------------------------------------------------------ helpers
def ev_bmesh(o, dg):
    """World-space bmesh of an object after its modifiers (meshes and curves)."""
    ev = o.evaluated_get(dg)
    me = ev.to_mesh()
    bm = bmesh.new()
    bm.from_mesh(me)
    ev.to_mesh_clear()
    bm.transform(o.matrix_world)
    return bm


def bm_object(name, bm, mats, coll=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    for m in mats:
        me.materials.append(m)
    o = bpy.data.objects.new(name, me)
    (coll or bpy.context.scene.collection).objects.link(o)
    return o


def sub_bmesh(bm, faces):
    """New bmesh with the given faces of bm (attributes, uvs and material indices kept)."""
    bm.faces.index_update()
    keep = {f.index for f in faces}
    out = bm.copy()
    out.faces.index_update()
    kill = [f for f in out.faces if f.index not in keep]
    bmesh.ops.delete(out, geom=kill, context='FACES')
    return out


def visible_objects():
    return [o for o in bpy.context.scene.objects if o.type in ('MESH', 'CURVE') and not o.hide_render and o.visible_get() is not None]


# ================================================================== stage: prep
def stage_prep():
    # ---- 1. the posed hero: gloved fists (hand frame relative to the posed forearm) and the Tavor
    bpy.ops.wm.open_mainfile(filepath=os.path.join(WORK, 'stage2_posed.blend'))
    dg = bpy.context.evaluated_depsgraph_get()
    rig = bpy.data.objects['Rig']
    pose = {}
    for pb in rig.pose.bones:
        pose[pb.name] = (rig.matrix_world @ pb.head, rig.matrix_world @ pb.tail)
    rifle = bpy.data.objects['Rifle']
    rinv = rifle.matrix_world.inverted()
    glove_names = [o.name for o in bpy.data.collections['arms'].objects if o.name.startswith('Glove')]
    rifle_names = [o.name for o in bpy.data.collections['rifle'].all_objects if o.type in ('MESH', 'CURVE') and o.name != 'Rifle_Sling']
    posed = {}
    for nm in glove_names + rifle_names:
        o = bpy.data.objects[nm]
        if o.hide_render:
            continue
        posed[nm] = (ev_bmesh(o, dg), list(o.data.materials))
    # the posed body's fists (masked under the gloves in the hero): volume filler for the remesh only
    body = bpy.data.objects['Body']
    for md in body.modifiers:
        if md.type == 'MASK':
            md.show_viewport = md.show_render = False
    dg.update()
    bm = ev_bmesh(body, bpy.context.evaluated_depsgraph_get())
    for s in ('L', 'R'):
        segs = [(rig.matrix_world @ pb.head, rig.matrix_world @ pb.tail) for pb in rig.pose.bones if pb.name.endswith('.' + s) and pb.name.startswith(('hand', 'fingers', 'thumb'))]

        def near(p):
            for a, b in segs:
                ab = b - a
                t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-9)))
                if (a + ab * t - p).length < 0.045:
                    return True
            return False
        fs = [f for f in bm.faces if near(f.calc_center_median())]
        posed['VolHand_' + s] = (sub_bmesh(bm, fs), [])
    bm.free()
    # grip points (rifle space, from stage2b's hand targets): right fist round the pistol grip, left on the guard
    grip_rs = {'R': Vector((0.02, 0.0, -0.09)), 'L': Vector((0.118, 0.035, -0.06))}
    grip_w = {s: rifle.matrix_world @ v for s, v in grip_rs.items()}
    # keep the posed pieces as plain objects across the file switch
    stash = {}
    for nm, (bm, mats) in posed.items():
        o = bm_object('POSED_' + nm, bm, mats)
        o.use_fake_user = True
        stash[nm] = o
        bm.free()
    lib = os.path.join(C.BUILD, 'hero-game-posed.blend')
    bpy.data.libraries.write(lib, set(stash.values()), fake_user=True)
    rifle_m = rifle.matrix_world.copy()

    # ---- 2. the dressed A-pose hero
    bpy.ops.wm.open_mainfile(filepath=os.path.join(WORK, 'stage2.blend'))
    with bpy.data.libraries.load(lib, link=False) as (src, dst):
        dst.objects = [n for n in src.objects if n.startswith('POSED_')]
    for o in dst.objects:
        bpy.context.scene.collection.objects.link(o)
    dg = bpy.context.evaluated_depsgraph_get()

    # leg landmarks from the trouser / boot cross-sections (hero world)
    def ring_centre(objs, z, sx, band=0.012):
        acc, n = Vector(), 0
        for o in objs:
            bm = ev_bmesh(o, dg)
            for v in bm.verts:
                if abs(v.co.z - z) < band and v.co.x * sx > 0.03:
                    acc += v.co
                    n += 1
            bm.free()
        return acc / max(n, 1)

    legs = {}
    for s, sx in (('L', 1.0), ('R', -1.0)):
        pants = [bpy.data.objects['Pants']]
        th = ring_centre(pants, 0.80, sx)
        kn = ring_centre(pants, 0.50, sx)
        sh = ring_centre(pants, 0.30, sx)
        bt = ring_centre([bpy.data.objects['Boot_' + s]], 0.16, sx)
        hip = kn + (th - kn) * ((0.94 - kn.z) / (th.z - kn.z))
        ank = bt + (sh - bt) * ((0.07 - bt.z) / (sh.z - bt.z))
        legs[s] = (hip, kn, ank)
        log('leg', s, 'hip', tuple(round(x, 3) for x in hip), 'knee', tuple(round(x, 3) for x in kn), 'ankle', tuple(round(x, 3) for x in ank))

    # ---- per-bone transforms (game coords -> game coords)
    XF = {}
    for s, sx in (('L', 1.0), ('R', -1.0)):
        gs = 'R' if sx < 0 else 'L'  # hero right (-x) = game right (+z)
        m = Vector((sx, 1, 1))
        S_h, E_h, W_h = (h2g(Vector((p.x * m.x, p.y, p.z))) for p in (ARM_S, ARM_E, ARM_W))
        XF['aua' + gs] = limb_xf(S_h, E_h, REST['aua' + gs], REST['afa' + gs])
        XF['afa' + gs] = limb_xf(E_h, W_h, REST['afa' + gs], REST['ahd' + gs])
        hip, kn, ank = (h2g(p) for p in legs[s])
        XF['ath' + gs] = limb_xf(hip, kn, REST['ath' + gs], REST['ash' + gs])
        XF['ash' + gs] = limb_xf(kn, ank, REST['ash' + gs], REST['aft' + gs])
        XF['aft' + gs] = Matrix.Translation(REST['aft' + gs] - ank)
        # fist: the posed hand in the posed forearm's hinge frame -> the game forearm at rest (same hinge
        # convention as infantry.ts ik(): y = -forearm, z = upper x forearm), anchored at the wrist
        sh_, el_ = pose['upper_arm.' + s]
        el2, wr = pose['forearm.' + s]
        u = (h2g(el_) - h2g(sh_)).normalized()
        v = (h2g(wr) - h2g(el2)).normalized()
        z = u.cross(v).normalized()
        y = -v
        x = y.cross(z)
        F = Matrix((x, y, z)).to_4x4()  # rows: world -> forearm-local rotation
        wrist_g = REST['ahd' + gs]
        g_local = F.to_3x3() @ (h2g(grip_w[s]) - h2g(wr))
        # straighten the wrist so the grip lies on the forearm axis (where the game's IK puts the hand centre),
        # and slide the fist up the axis so the grip sits FIST_GRIP below the wrist (the glove runs into the cuff)
        Q = g_local.normalized().rotation_difference(Vector((0, -1, 0))).to_matrix().to_4x4()
        d = Vector((0, g_local.length - FIST_GRIP, 0))
        XF['ahd' + gs] = Matrix.Translation(wrist_g + d) @ Q @ F @ Matrix.Translation(-h2g(wr))
        log('fist', gs, 'grip point in the posed forearm frame', tuple(round(c, 3) for c in g_local), '-> on the axis', -FIST_GRIP)
    # rifle: rifle space (x muzzle, z top, y left) -> weapon bone local, butt pad -> pivot, muzzle -> muzzle point
    BUTT, MUZ = -0.348, 0.3675
    w_pivot = meta['weapon']['pivot']['x']
    w_muz = meta['points']['muzzle'][0] - REST['awpn'].x
    sxr = (w_muz - w_pivot) / (MUZ - BUTT)
    txr = w_pivot - BUTT * sxr
    by = meta['points']['muzzle'][1] - REST['awpn'].y  # bore height (scaled) on the weapon bone
    R2W = Matrix(((sxr, 0, 0, txr), (0, 0, RIFLE_K[1], by), (0, -RIFLE_K[2], 0, 0), (0, 0, 0, 1)))
    XF['awpn'] = Matrix.Translation(REST['awpn']) @ R2W @ rifle_m.inverted() @ H2G.inverted()
    for k in ('ahips', 'achest', 'aneck', 'ahead'):
        XF[k] = Matrix.Identity(4)

    # ---- classify every surface of the hero (hero world) into game bones
    OV = 0.025  # overlap across the limb joints: both pieces cover the crease when the joint bends

    def leg_bone(q):
        y, z = q.y, q.z
        s = side_of(z)
        if y > 0.94 - 0.12 * max(0.0, 1 - abs(z) / 0.06):
            return None
        if y > REST['ash' + s].y:
            return 'ath' + s
        return 'ash' + s

    def trunk_bone(q, coll, nm):
        if nm.startswith(('Belt', 'Pants_Waistband')):
            return 'ahips'
        if coll in ('helmet',):
            return 'ahead'
        if coll == 'feet':
            return 'aft' + side_of(q.z)
        if coll == 'vest' or nm == 'Collar_Stand':
            return 'achest'
        lb = leg_bone(q)
        if lb:
            return lb
        if q.y < 1.04:
            return 'ahips'
        if q.y < 1.50 or (nm == 'Shirt'):
            return 'achest'
        if q.y < 1.585 and nm != 'Body' or (nm == 'Body' and q.y < 1.60 and q.x < 0.04):
            return 'aneck'
        return 'ahead'

    def arm_bone(p):
        t, _ = arm_t(p)
        s = 'R' if p.x < 0 else 'L'
        if t > T_WRIST - 0.005:
            return 'drop'  # the A-pose hand (the fists come from the posed hero)
        return ('aua' if t < T_ELBOW else 'afa') + s

    def bones_of(p, coll, nm):
        out = set()
        offs = [Vector((0, 0, 0)), Vector((0, 0, OV)), Vector((0, 0, -OV))]
        sx = 1.0 if p.x >= 0 else -1.0
        ad = Vector((ARM_D.x * sx, 0, ARM_D.z))
        offs += [ad * OV, -ad * OV]
        for i, d in enumerate(offs):
            pp = p + d
            if coll == 'arms' or (nm in ('Shirt', 'Body') and is_arm(pp)):
                b = arm_bone(pp) if (coll == 'arms' or is_arm(pp)) else trunk_bone(h2g(pp), coll, nm)
            else:
                b = trunk_bone(h2g(pp), coll, nm)
            if i == 0 and b == 'drop':
                return set()
            out.add(b)
        out.discard('drop')
        if coll in ('helmet', 'feet', 'vest'):
            return {b for b in out if b in ('ahead', 'achest', 'ahips') or b.startswith('aft')} or out
        return out

    pieces = {b: [] for b in BONES}
    vols = {b: [] for b in BONES}
    skip_colls = {'studio', 'rifle'}
    for o in visible_objects():
        coll = o.users_collection[0].name if o.users_collection else ''
        nm = o.name
        if coll in skip_colls or nm.startswith('Glove') or nm.startswith('Eye'):
            continue
        if nm.startswith('POSED_'):
            continue
        bm = ev_bmesh(o, dg)
        groups = {}
        hidden = {}
        for f in bm.faces:
            c = f.calc_center_median()
            # the body under the clothes is not baked, but fills the limbs for the remesh (a cut, single
            # layer sleeve alone remeshes into shreds)
            if nm == 'Body' and abs(c.x) > 0.25 and 0.6 < c.z < 1.1 and arm_t(c)[0] > T_WRIST - 0.01:
                continue  # the A-pose hands (the fists come from the posed hero)
            dst_ = hidden if nm == 'Body' and not body_visible(c) else groups
            for b in bones_of(c, coll, nm):
                dst_.setdefault(b, []).append(f)
        for b, fs in groups.items():
            sb = sub_bmesh(bm, fs)
            sb.transform(XF[b] @ H2G)
            pieces[b].append((nm, sb, list(o.data.materials)))
        for b, fs in hidden.items():
            sb = sub_bmesh(bm, fs)
            sb.transform(XF[b] @ H2G)
            vols[b].append((nm, sb, []))
        bm.free()
    # eyes: on the head (the hero's eyes are separate objects)
    for nm in ('Eye.L', 'Eye.R'):
        o = bpy.data.objects.get(nm)
        if o:
            bm = ev_bmesh(o, dg)
            bm.transform(H2G)
            pieces['ahead'].append((nm, bm, list(o.data.materials)))
    # posed fists and rifle
    hand_bones = {}
    for s in ('L', 'R'):
        hs = [pose[n] for n in pose if n.endswith('.' + s) and (n.startswith(('hand', 'fingers', 'thumb')))]
        hand_bones[s] = hs

    def seg_d(p, a, b):
        ab = b - a
        t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-9)))
        return (a + ab * t - p).length

    for o in dst.objects:
        nm = o.name[len('POSED_'):]
        bm = bmesh.new()
        bm.from_mesh(o.data)
        if nm in rifle_names:
            bm.transform(XF['awpn'] @ H2G)
            pieces['awpn'].append((nm, bm, list(o.data.materials)))
            continue
        if nm.startswith('VolHand_'):
            b = 'ahd' + nm[-1]
            bm.transform(XF[b] @ H2G)
            vols[b].append((nm, bm, []))
            continue
        groups = {'L': [], 'R': []}
        for f in bm.faces:
            c = f.calc_center_median()
            dl = min(seg_d(c, a, b) for a, b in hand_bones['L'])
            dr = min(seg_d(c, a, b) for a, b in hand_bones['R'])
            groups['L' if dl < dr else 'R'].append(f)
        for s, fs in groups.items():
            if not fs:
                continue
            gs = s  # hero L / R = game L / R
            sb = sub_bmesh(bm, fs)
            sb.transform(XF['ahd' + gs] @ H2G)
            pieces['ahd' + gs].append((nm, sb, list(o.data.materials)))
        bm.free()

    # ---- one high-poly object per bone (game coords in the data, G2B world like common.py)
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o)
    coll = bpy.data.collections.new('high')
    bpy.context.scene.collection.children.link(coll)
    for c in list(bpy.data.collections):
        if c is not coll:
            bpy.data.collections.remove(c)
    for pre, dct in (('HP_', pieces), ('VOL_', vols)):
        for b, lst in dct.items():
            objs = []
            for i, (nm, sb, mats) in enumerate(lst):
                o = bm_object('%s_%s' % (b, nm), sb, mats, coll)
                o.matrix_world = C.G2B
                sb.free()
                objs.append(o)
            if not objs:
                if pre == 'HP_':
                    log('WARNING: no geometry for', b)
                continue
            h = C.join(objs, pre + b)
            log(pre, b, len(h.data.polygons), 'faces')
    bpy.ops.outliner.orphans_purge(do_recursive=True)
    bpy.ops.wm.save_as_mainfile(filepath=HIGH)
    log('prep OK ->', HIGH)


# ================================================================== stage: lods
def lowpoly(h, target, voxel):
    """Watertight low poly of one bone's high poly: voxel remesh, then collapse decimation to the budget.
    A fine remesh can keep thin double shells (sleeve over arm) that the collapse cannot reduce without
    flipping faces: then the remesh is redone coarser until the budget is met."""
    for k in range(4):
        lo = lowpoly1(h, target, voxel * (1.4 ** k))
        if C.tris(lo) <= target * 1.15:
            return lo
        log('  ', h.name, 'voxel', round(voxel * (1.4 ** k), 4), 'stalled at', C.tris(lo), '/', target, ': coarser')
        bpy.data.objects.remove(lo)
    return lowpoly1(h, target, voxel * (1.4 ** 4))


def envelope_group(r):
    """Geometry nodes: surface points (spacing ~0.6 r) -> Points to Volume (radius r) -> Volume to Mesh."""
    key = 'envelope_%.5f' % r
    ng = bpy.data.node_groups.get(key)
    if ng:
        return ng
    ng = bpy.data.node_groups.new(key, 'GeometryNodeTree')
    ng.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    ng.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    n = ng.nodes
    gi = n.new('NodeGroupInput')
    go = n.new('NodeGroupOutput')
    dp = n.new('GeometryNodeDistributePointsOnFaces')
    dp.distribute_method = 'RANDOM'
    dp.inputs['Density'].default_value = 1.0 / (r * 0.6) ** 2
    dp.inputs['Seed'].default_value = 7
    pv = n.new('GeometryNodePointsToVolume')
    pv.inputs['Radius'].default_value = r
    pv.inputs['Resolution Mode'].default_value = 'Size'
    pv.inputs['Voxel Size'].default_value = r * 0.45
    vm = n.new('GeometryNodeVolumeToMesh')
    vm.inputs['Resolution Mode'].default_value = 'Grid'
    ln = ng.links
    ln.new(gi.outputs[0], dp.inputs['Mesh'])
    ln.new(dp.outputs['Points'], pv.inputs['Points'])
    ln.new(pv.outputs[0], vm.inputs[0])
    ln.new(vm.outputs[0], go.inputs[0])
    return ng


def inside(p, bvh):
    """Is p inside the closed surface in bvh (ray parity along a skew direction)?"""
    d = Vector((0.577, 0.611, 0.541)).normalized()
    o = p.copy()
    n = 0
    for _ in range(64):
        hit, _nrm, _i, dist = bvh.ray_cast(o, d)
        if hit is None:
            break
        n += 1
        o = hit + d * 1e-5
    return n % 2 == 1


def lowpoly1(h, target, voxel):
    lo = C.dup(h, h.name.replace('HP_', 'LP_'))
    v = bpy.data.objects.get(h.name.replace('HP_', 'VOL_'))
    if v:
        lo = C.join([lo, C.dup(v, 'tmp_vol')], lo.name)
    lo.data.materials.clear()
    # closing (dilate + erode) of the surfaces as a solid: dense surface points -> a fog volume of radius r
    # -> mesh, then pulled back in by most of r. Unlike a voxel remesh of the mesh itself this cannot leak
    # through the open cut ends of the cloth (a signed level set of the per-bone pieces came out holed), and
    # the air under loose cloth closes up.
    # (the rifle is closed hard-surface solids: a plain voxel remesh keeps its edges crisper)
    hard = h.name == 'HP_awpn'
    if hard:
        m = lo.modifiers.new('remesh', 'REMESH')
        m.mode = 'VOXEL'
        m.voxel_size = voxel * 1.6
        m.adaptivity = 0.0
    else:
        m = lo.modifiers.new('env', 'NODES')
        m.node_group = envelope_group(voxel)
    C.select([lo], lo)
    bpy.ops.object.modifier_apply(modifier=m.name)
    # keep the outer skin only: drop the cavities the remesh leaves inside (the air between a loose sleeve
    # and the arm comes out as a closed inner surface, which the collapse then crushes into the outer one)
    # and the tiny loose islands (thread ends, lace tips)
    bm = bmesh.new()
    bm.from_mesh(lo.data)
    comps = sorted(C.components(bm), key=len, reverse=True)
    if len(comps) > 1:
        big = len(comps[0])
        kill = []
        shells = []
        for c in comps:
            if len(c) < max(40, big * DROP):
                kill.extend(c)
                continue
            p = c[0].verts[0].co
            if any(inside(p, t) for t in shells):
                kill.extend(c)
                continue
            vs = {v for f in c for v in f.verts}
            vi = {v: i for i, v in enumerate(vs)}
            shells.append(BVHTree.FromPolygons([v.co.copy() for v in vs], [[vi[v] for v in f.verts] for f in c]))
        bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(lo.data)
    bm.free()
    # relax the cloth folds and voxel steps before the collapse (it keeps every fold crest and crumples the
    # surface otherwise); the folds come back through the normal map
    sm = lo.modifiers.new('relax', 'LAPLACIANSMOOTH')
    sm.iterations = 2 if hard else RELAX
    sm.lambda_factor = 1.0
    sm.use_volume_preserve = True
    C.select([lo], lo)
    bpy.ops.object.modifier_apply(modifier=sm.name)
    if not hard:
        dp = lo.modifiers.new('erode', 'DISPLACE')
        dp.strength = -voxel * ERODE
        dp.mid_level = 0.0
        bpy.ops.object.modifier_apply(modifier=dp.name)
    n = len(lo.data.polygons) * 2
    if n > target:
        d = lo.modifiers.new('dec', 'DECIMATE')
        d.decimate_type = 'COLLAPSE'
        d.ratio = target / n
        d.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=d.name)
    bm = bmesh.new()
    bm.from_mesh(lo.data)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    # specks the collapse left (a handful of triangles: their detail is in the bake anyway)
    kill = [f for c in C.components(bm) if len(c) < 8 for f in c]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(lo.data)
    bm.free()
    # back onto the hero's actual surface (the coarse remesh rounds it off)
    if not os.environ.get('HG_WRAP'):
        C.smooth_by_angle(lo, 80)
        return lo
    sw = lo.modifiers.new('wrap', 'SHRINKWRAP')
    sw.target = h
    sw.wrap_method = 'NEAREST_SURFACEPOINT'
    sw.wrap_mode = 'ON_SURFACE'
    C.select([lo], lo)
    bpy.ops.object.modifier_apply(modifier=sw.name)
    C.smooth_by_angle(lo, 80)  # (the normal map carries the creases; every split doubles vertices)
    return lo


MERGE_DEV = 88.0


def cluster_seams(o, max_dev=65.0, min_faces=12):
    """Seams for an LSCM unwrap of a decimated mesh: grow charts from the biggest faces while a neighbour's
    normal stays within max_dev of the chart's mean normal (smart project cuts these noisy surfaces into
    near per-triangle islands), seams on the chart borders."""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.faces.ensure_lookup_table()
    cos_l = math.cos(math.radians(max_dev))
    chart = {}
    cid = -1
    for seed in sorted(bm.faces, key=lambda f: -f.calc_area()):
        if seed.index in chart:
            continue
        cid += 1
        n = seed.normal * seed.calc_area()
        chart[seed.index] = cid
        front = [seed]
        while front:
            f = front.pop()
            for e in f.edges:
                for g in e.link_faces:
                    if g.index in chart:
                        continue
                    m = n.normalized()
                    if g.normal.dot(m) > cos_l:
                        chart[g.index] = cid
                        n = n + g.normal * g.calc_area()
                        front.append(g)
    # merge the specks (charts of a few faces) into the neighbour they share the most edges with, while the
    # merged normals stay within MERGE_DEV (a chart never wraps round a limb, so LSCM can flatten it)
    members = {}
    for fi, c in chart.items():
        members.setdefault(c, []).append(fi)
    normal = {c: sum((bm.faces[i].normal * bm.faces[i].calc_area() for i in fs), Vector()).normalized() for c, fs in members.items()}
    cos_m = math.cos(math.radians(MERGE_DEV))
    for c in sorted(members, key=lambda c: len(members[c])):
        fs = members.get(c)
        if not fs or len(fs) >= min_faces:
            continue
        shared = {}
        for i in fs:
            for e in bm.faces[i].edges:
                for g in e.link_faces:
                    d = chart[g.index]
                    if d != c:
                        shared[d] = shared.get(d, 0) + 1
        for d in sorted(shared, key=lambda d: -shared[d]):
            if all(bm.faces[i].normal.dot(normal[d]) > cos_m for i in fs):
                for i in fs:
                    chart[i] = d
                members[d].extend(fs)
                del members[c]
                break
    for e in bm.edges:
        fs = e.link_faces
        e.seam = len(fs) == 2 and chart[fs[0].index] != chart[fs[1].index]
    bm.to_mesh(o.data)
    bm.free()
    return len(members)


def unwrap_charts(objs, margin, factor_of_face):
    for o in objs:
        me = o.data
        while len(me.uv_layers):
            me.uv_layers.remove(me.uv_layers[0])
        me.uv_layers.new(name='UVMap')
        cluster_seams(o)
    C.select(objs)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.unwrap(method='CONFORMAL', fill_holes=True, margin=margin)
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.average_islands_scale()
    bpy.ops.object.mode_set(mode='OBJECT')
    C.scale_islands(objs, factor_of_face)
    C.select(objs)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.select_all(action='SELECT')
    bpy.ops.uv.pack_islands(udim_source='CLOSEST_UDIM', rotate=True, margin_method='FRACTION', margin=margin)
    bpy.ops.object.mode_set(mode='OBJECT')


def face_factor_for(tier):
    def ff(o, f):
        b = o.name.split('_')[-1]
        if b == 'ahead':
            return 1.7
        if b in ('ahdR', 'ahdL'):
            return 1.4
        if b == 'awpn':
            return 1.2
        if b.startswith('aft'):
            return 0.8
        return 1.0
    return ff


def stage_lods():
    bpy.ops.wm.open_mainfile(filepath=HIGH)
    highs = {o.name[3:]: o for o in bpy.data.objects if o.name.startswith('HP_')}
    for tier, (aid, k, voxel, tex, margin) in TIERS.items():
        coll = bpy.data.collections.new('low_' + tier)
        bpy.context.scene.collection.children.link(coll)
        lows = []
        for b in BONES:
            h = highs.get(b)
            if not h:
                continue
            lo = lowpoly(h, int(PLAY[b] * k), voxel * VOX_K.get(b[:3] if b[:3] in VOX_K else b, 1.0))
            lo.name = '%s_%s' % (tier, b)
            for c in list(lo.users_collection):
                c.objects.unlink(lo)
            coll.objects.link(lo)
            lows.append(lo)
        unwrap_charts(lows, margin, face_factor_for(tier))
        log('lods', tier, {o.name: C.tris(o) for o in lows}, 'total', sum(C.tris(o) for o in lows))
    bpy.ops.wm.save_as_mainfile(filepath=LODS)
    log('lods OK ->', LODS)


# ================================================================== stage: bake
CLOTH = ('uniform', 'uniform_pants', 'uniform_dark', 'gear', 'gear_pad', 'mitznefet', 'camo', 'gaiter')
METAL = {'metal': 0.85}


def mat_class(m):
    n = (m.name if m else '').split('.')[0]
    return (METAL.get(n, 0.0), 1.0 if n in CLOTH else 0.0, 1.0 if n == 'flag' else (0.5 if n in ('skin', 'eye') else 0.0))


def mask_materials(objs):
    """Swap every high-poly material for an emission of (metal, cloth, flag / skin) (restored by the caller)."""
    cache = {}
    saved = {}
    for o in objs:
        saved[o.name] = [s.material for s in o.material_slots]
        for s in o.material_slots:
            key = s.material.name if s.material else ''
            mm = cache.get(key)
            if mm is None:
                mm = bpy.data.materials.new('mask_' + key)
                mm.use_nodes = True
                nt = mm.node_tree
                nt.nodes.clear()
                out = nt.nodes.new('ShaderNodeOutputMaterial')
                em = nt.nodes.new('ShaderNodeEmission')
                em.inputs[0].default_value = (*mat_class(s.material), 1)
                nt.links.new(em.outputs[0], out.inputs[0])
                cache[key] = mm
            s.material = mm
    return saved


def restore_materials(objs, saved):
    for o in objs:
        for s, m in zip(o.material_slots, saved[o.name]):
            s.material = m


def bake_pass(kind, lows, highs_of, img, samples, extrusion=0.03, ray=0.08, margin=8, pass_filter=None):
    sc = bpy.context.scene
    sc.cycles.samples = samples
    sc.render.bake.margin = margin
    sc.render.bake.margin_type = 'EXTEND'
    sc.render.bake.normal_space = 'TANGENT'
    every = [o for o in sc.objects if o.type == 'MESH']
    for i, lo in enumerate(lows):
        C.set_target(lo.data.materials[0], img)
        hs = highs_of(lo)
        for o in every:
            o.hide_render = not (o is lo or o in hs)
        C.select(hs + [lo], lo)
        kw = dict(type=kind, use_clear=(i == 0), margin=margin, margin_type='EXTEND', use_selected_to_active=bool(hs), cage_extrusion=extrusion, max_ray_distance=ray, normal_space='TANGENT', target='IMAGE_TEXTURES')
        if pass_filter:
            kw['pass_filter'] = pass_filter
        bpy.ops.object.bake(**kw)
    for o in every:
        o.hide_render = False


TEAM_LIN = 0.62  # albedo under the player-colour mask (linear): the game multiplies it by team / 0.62
ALB_GAIN = float(os.environ.get('HG_GAIN', '1.9'))  # the hero's studio-lit olive is darker than the game's lit uniforms: matched to the procedural soldier on screen
AO_FLOOR = 0.86  # light AO only: the game's infantry fill / wrap light must not be stacked on a dark bake
BB_MIN = Vector((-0.6, -0.6, -0.05))
BB_SIZE = Vector((1.4, 1.2, 2.1))


def fill_misses(a, miss, steps=48):
    """Push-pull style fill: missed texels take the mean of their known 4-neighbours, repeated."""
    a = a.copy()
    known = ~miss
    for _ in range(steps):
        if known.all():
            break
        acc = np.zeros_like(a)
        n = np.zeros(miss.shape, np.float32)
        for ax, sh in ((0, 1), (0, -1), (1, 1), (1, -1)):
            k = np.roll(known, sh, axis=ax)
            acc += np.roll(a, sh, axis=ax) * k[..., None]
            n += k
        new = (~known) & (n > 0)
        a[new] = acc[new] / n[new][..., None]
        known = known | new
    return a


def composite(aid, px, order, tex):
    """albedo (sRGB) and orm (team mask, roughness, metal) from the bakes (numpy, see common.py)."""
    used = px['bone'][..., 0] > 0
    # texels whose bake rays found no hero surface (the remeshed low poly bulges past the cage there):
    # filled from their hit neighbours, so no black blotches
    miss = used & (px['diffuse'][..., :3].sum(-1) < 1e-4)
    log(aid, 'bake misses: %.2f %% of the used texels' % (100 * miss.sum() / max(1, used.sum())))
    for k in ('diffuse', 'rough', 'mask', 'ao'):
        px[k] = fill_misses(px[k], miss)
    base = px['diffuse'][..., :3]
    ao = np.clip(px['ao'][..., 0], 0, 1)
    rough = np.clip(px['rough'][..., 0], 0.05, 1)
    metal, cloth, fs = px['mask'][..., 0], px['mask'][..., 1], px['mask'][..., 2]
    flag = fs > 0.75
    bone = np.floor(px['bone'][..., 0] * 32).astype(int)

    def isb(*names):
        return np.isin(bone, [order.index(n) for n in names if n in order])

    Pb = px['pos'][..., :3] * np.array(BB_SIZE) + np.array(BB_MIN)
    P = np.stack([Pb[..., 0], Pb[..., 2], -Pb[..., 1]], -1)  # game body space (rest)
    Nb = px['nrm'][..., :3] * 2 - 1
    Ng = np.stack([Nb[..., 0], Nb[..., 2], -Nb[..., 1]], -1)
    clothm = cloth > 0.5
    # player colour (orm R) where the procedural soldier shows it: arm bands, helmet band + crown patch,
    # chest ID panel, pack lid
    arm = np.zeros(P.shape[:2], bool)
    for s in ('R', 'L'):
        y0 = REST['aua' + s].y - 0.135
        arm |= isb('aua' + s) & clothm & (np.abs(P[..., 1] - y0) < 0.055) & ~flag
    head = np.array(REST['ahead'][:])
    q = P - (head + np.array([-0.005, 0.12, 0.0]))
    r = np.linalg.norm(q, axis=-1)
    el = np.arcsin(np.clip(q[..., 1] / np.maximum(r, 1e-6), -1, 1))
    helm = isb('ahead') & clothm & (P[..., 1] > head[1] + 0.06)
    # (a wide crown patch: the RTS camera looks down on the helmets)
    t_helmet = helm & ((np.abs(el - 0.30) < 0.07) | (el > 0.85))
    sp = np.array(REST['aspine'][:])
    c = P - sp
    t_chest = isb('achest') & clothm & (Ng[..., 0] > 0.55) & (c[..., 0] > 0.08) & (np.abs(c[..., 1] - 0.36) < 0.03) & (np.abs(c[..., 2]) < 0.075)
    # the pack (top and back): the procedural soldier's big team-coloured pack lid reads from every side
    t_pack = isb('achest') & clothm & (c[..., 0] < -0.13) & (c[..., 1] > 0.02) & ((Ng[..., 1] > 0.3) | (Ng[..., 0] < -0.5))
    teamm = (arm | t_helmet | t_chest | t_pack).astype(np.float32)
    teamm = np.clip(C.blur(teamm, 1) * 1.6, 0, 1) * used
    alb = base * ALB_GAIN * (AO_FLOOR + (1 - AO_FLOOR) * ao)[..., None]
    alb = alb * (1 - teamm[..., None]) + TEAM_LIN * teamm[..., None]
    rough_o = np.where(teamm > 0.5, 0.62, rough)
    C.save_rgb(os.path.join(C.BUILD, aid + '-albedo.png'), C.lin2srgb(alb), tex)
    C.save_rgb(os.path.join(C.BUILD, aid + '-orm.png'), np.stack([teamm, rough_o, np.clip(metal, 0, 1)], -1), tex)
    m = C.lin2srgb(alb)[used].mean(0)
    log(aid, 'composite: mean albedo of the used texels (sRGB)', [round(float(x), 3) for x in m], 'team texels', int((teamm > 0.5).sum()))


def stage_bake():
    bpy.ops.wm.open_mainfile(filepath=LODS)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.render.threads_mode = 'FIXED'
    sc.render.threads = 4
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    highs = {o.name[3:]: o for o in bpy.data.objects if o.name.startswith('HP_')}
    hlist = list(highs.values())
    for tier, (aid, k, voxel, tex, margin) in TIERS.items():
        lows = [bpy.data.objects['%s_%s' % (tier, b)] for b in BONES if ('%s_%s' % (tier, b)) in bpy.data.objects]
        others = [o for o in bpy.data.objects if o.type == 'MESH' and o.name.startswith(tuple(t + '_' for t in TIERS)) and o not in lows]
        for o in others:
            o.hide_render = True
        bm_ = C.bake_material('lp_bake_' + tier)
        for o in lows:
            o.data.materials.clear()
            o.data.materials.append(bm_)

        def hs_of(lo):
            return [highs[lo.name.split('_', 1)[1]]]

        def none(lo):
            return []

        IMG = {}
        IMG['normal'] = C.new_image(aid + '_normal', tex)
        bake_pass('NORMAL', lows, hs_of, IMG['normal'], 2)
        log(tier, 'baked normal')
        IMG['diffuse'] = C.new_image(aid + '_diffuse', tex)
        bake_pass('DIFFUSE', lows, hs_of, IMG['diffuse'], 4, pass_filter={'COLOR'})
        log(tier, 'baked diffuse colour')
        IMG['rough'] = C.new_image(aid + '_rough', tex)
        bake_pass('ROUGHNESS', lows, hs_of, IMG['rough'], 2)
        log(tier, 'baked roughness')
        saved = mask_materials(hlist)
        IMG['mask'] = C.new_image(aid + '_mask', tex)
        bake_pass('EMIT', lows, hs_of, IMG['mask'], 2)
        restore_materials(hlist, saved)
        log(tier, 'baked material masks')
        sc.world = bpy.data.worlds.new('bakeworld')
        sc.world.light_settings.distance = 0.05
        IMG['ao'] = C.new_image(aid + '_ao', tex)
        bake_pass('AO', lows, hs_of, IMG['ao'], 32)
        log(tier, 'baked ao')
        for kk in ('pos', 'nrm'):
            C.lp_pass(bm_, kk, BB_MIN, BB_SIZE, IMG['normal'])
            IMG[kk] = C.new_image(aid + '_' + kk, tex)
            bake_pass('EMIT', lows, none, IMG[kk], 1)
        order = [o.name.split('_', 1)[1] for o in lows]
        for i, o in enumerate(lows):
            m = C.bake_material('bone_%s_%d' % (tier, i))
            em = [n for n in m.node_tree.nodes if n.type == 'EMISSION'][0]
            v = (i + 0.5) / 32
            em.inputs[0].default_value = (v, v, v, 1)
            o.data.materials.clear()
            o.data.materials.append(m)
        IMG['bone'] = C.new_image(aid + '_bone', tex)
        bake_pass('EMIT', lows, none, IMG['bone'], 1, margin=2)
        for o in lows:
            o.data.materials.clear()
            o.data.materials.append(bm_)
        log(tier, 'baked low-poly passes')
        px = {kk: C.pixels(v) for kk, v in IMG.items() if kk != 'normal'}
        np.savez_compressed(os.path.join(C.BUILD, aid + '-bakes.npz'), order=np.array(order), **{kk: v.astype(np.float16) for kk, v in px.items()})
        composite(aid, px, order, tex)
        n = IMG['normal']
        n.filepath_raw = os.path.join(C.BUILD, aid + '-normal.png')
        n.file_format = 'PNG'
        n.save()
        export_tier(tier, aid, lows)
        for o in others:
            o.hide_render = False
    bpy.ops.wm.save_as_mainfile(filepath=LODS.replace('.blend', '-baked.blend'))
    log('bake OK')


def export_tier(tier, aid, lows):
    """One mesh per bone, named after the bone, positions in the bone's modelling frame (game coords)."""
    outs = []
    for lo in lows:
        b = lo.name.split('_', 1)[1]
        o = C.dup(lo, b)
        o.data.transform(Matrix.Translation(-FRAME[b]))
        o.matrix_world = C.G2B
        outs.append(o)
    C.select(outs)
    bpy.ops.export_scene.gltf(filepath=os.path.join(C.BUILD, aid + '-raw.glb'), export_format='GLB', use_selection=True, export_materials='NONE',
                              export_vertex_color='NONE', export_normals=True, export_texcoords=True, export_apply=True, export_yup=True)
    log('export', aid, {o.name: C.tris(o) for o in outs}, 'total', sum(C.tris(o) for o in outs))
    for o in outs:
        bpy.data.objects.remove(o)


# ================================================================== stage: render
def stage_render():
    path = LODS.replace('.blend', '-baked.blend')
    bpy.ops.wm.open_mainfile(filepath=path)
    sc = bpy.context.scene
    sc.view_settings.view_transform = 'Standard'
    for tier, (aid, k, voxel, tex, margin) in TIERS.items():
        pm = C.pbr_material('pbr_' + tier, *(os.path.join(C.BUILD, '%s-%s.png' % (aid, x)) for x in ('albedo', 'normal', 'orm')), team=(0.16, 0.42, 1.0))
        for o in bpy.data.objects:
            if o.type != 'MESH':
                continue
            mine = o.name.startswith(tier + '_')
            o.hide_render = not mine
            if mine:
                o.data.materials.clear()
                o.data.materials.append(pm)
        sfx = '' if tier == 'play' else '-hero'
        C.studio((2.4, -1.5, 1.2), (0.0, 0.0, 0.95), lens=55, sun=(math.radians(50), 0, math.radians(-35)), size=(480, 640), samples=48, path=os.path.join(C.BUILD, NAME + '-studio%s-q.png' % sfx))
        C.studio((1.1, -0.35, 1.62), (0.0, 0.0, 1.55), lens=70, sun=(math.radians(50), 0, math.radians(-35)), size=(480, 480), samples=48, path=os.path.join(C.BUILD, NAME + '-studio%s-bust.png' % sfx))
    log('render OK')


if STAGE in ('prep', 'all'):
    stage_prep()
if STAGE in ('lods', 'all'):
    stage_lods()
if STAGE in ('bake', 'all'):
    stage_bake()
if STAGE == 'composite':
    # look tuning: re-run only the composite from the saved bakes (then `render` and pack.mjs)
    for tier, (aid, k, voxel, tex, margin) in TIERS.items():
        z = np.load(os.path.join(C.BUILD, aid + '-bakes.npz'))
        composite(aid, {kk: z[kk].astype(np.float32) for kk in z.files if kk != 'order'}, [str(x) for x in z['order']], tex)
if STAGE in ('render', 'all'):
    stage_render()
print('[hero-game] OK_DONE')
