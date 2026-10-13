"""
Iron Front - BI2 hero soldier, stage 1: body + cloth-simulated uniform (Blender 5.2.2 LTS).

  nice /opt/blender/blender -b --factory-startup -P web/tools/blender/hero/stage1_body_cloth.py -- [--frames 40]

Appends the CC0 male base mesh, scales it to 1.80 m and builds the IDF uniform (shirt, trousers) as
garments cut from the body surface. Each garment is pushed off the skin and given a looser,
longer "Rest" shape key; a Cloth modifier (rest_shape_key = Rest, pinned collar/waist/cuffs/hems,
collision with the body) lets the extra fabric settle into real folds and bunching. The result is
frozen and saved to $HERO_WORK/stage1.blend for stage 2.
"""
import sys, os, math, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy, bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from hero_lib import *

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
FRAMES = int(argv[argv.index('--frames') + 1]) if '--frames' in argv else 50
SUBDIV = '--subdiv' in argv
os.makedirs(WORK, exist_ok=True)
t0 = time.time()


def smoothstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------- body
reset()
for c in PARTS:
    coll(c)
names = ['GEO-body_male_realistic', 'GEO-body_male_realistic.eye.L', 'GEO-body_male_realistic.eye.R']
with bpy.data.libraries.load(BUNDLE, link=False) as (df, dt):
    dt.objects = names
for o in dt.objects:
    coll('head').objects.link(o)
    o.location = (o.location + Vector((BODY_SRC_OFFSET_X, 0, 0))) * SCALE
    o.scale = o.scale * SCALE
body = bpy.data.objects['GEO-body_male_realistic']
body.name = 'Body'
bpy.data.objects['GEO-body_male_realistic.eye.L'].name = 'Eye.L'
bpy.data.objects['GEO-body_male_realistic.eye.R'].name = 'Eye.R'
mr = body.modifiers[0]
mr.levels = 1
mr.render_levels = 3
mr.sculpt_levels = 3
bpy.context.view_layer.update()


# ---------------------------------------------------------------- physique (r12): a fit adult soldier, not a doll
# Edits the base cage (the multires scan detail rides on top). Joint positions stay where the rig, the gear
# and the IK expect them; only girth and stance change: thicker neck, trapezius and deltoids, fuller chest,
# lats and upper back, muscular upper arms / forearms and thighs / calves, feet a little closer together and
# the free (left) leg relaxed slightly forward with a soft knee (weight on the right leg).
def gauss(x, w):
    return math.exp(-(x / w) ** 2)


def physique(o):
    mw = o.matrix_world
    mi = mw.inverted().to_3x3()
    for v in o.data.vertices:
        p = mw @ v.co
        sx = 1.0 if p.x >= 0 else -1.0
        ax = abs(p.x)
        d = Vector((0, 0, 0))
        if is_hand(p):
            continue
        if is_arm(p) or (ax > 0.17 and p.z > 1.3 and arm_t(p)[0] < 0.12):
            t, rad = arm_t(p)
            if rad < 0.11:
                a = arm_point(t, sx)
                a.y = -0.005
                k = 0.21 * smoothstep(0.02, 0.08, t) * (1 - smoothstep(0.22, 0.29, t))     # biceps / triceps
                k += 0.10 * smoothstep(0.29, 0.34, t) * (1 - smoothstep(0.42, WRIST_T - 0.01, t))  # forearm
                d += (p - a) * k * smoothstep(0.075, 0.058, rad)  # arm skin only, not the torso side beside it
                S = Vector((sx * 0.19, -0.005, 1.42))
                dd = p - S
                d += dd.normalized() * 0.016 * gauss(dd.length - 0.065, 0.035) * smoothstep(0.15, 0.19, ax)  # deltoid
        elif p.z > 0.93:
            # neck (round the neck axis), kept off the jaw and chin
            nk = smoothstep(1.43, 1.47, p.z) * (1 - smoothstep(1.53, 1.575, p.z))
            if p.y < -0.06:
                nk *= 1 - smoothstep(1.52, 1.545, p.z)
            if nk > 0 and ax < 0.1:
                c = Vector((0, -0.005, p.z))
                d += (p - c) * 0.14 * nk
            # trapezius: higher, thicker slope from the neck to the shoulders
            d.z += 0.012 * gauss(p.z - 1.47, 0.035) * gauss(ax - 0.11, 0.045) * smoothstep(-0.07, 0.0, p.y)
            # chest (pecs), lats, upper back
            d.y -= 0.015 * gauss(p.z - 1.32, 0.07) * gauss(ax - 0.075, 0.065) * smoothstep(-0.04, -0.09, p.y)
            d.x += sx * 0.015 * gauss(p.z - 1.24, 0.09) * smoothstep(0.09, 0.15, ax) * (1 - smoothstep(0.19, 0.23, ax))
            d.y += 0.010 * gauss(p.z - 1.3, 0.09) * gauss(ax - 0.08, 0.07) * smoothstep(0.02, 0.07, p.y)
        if p.z < 0.97 and ax < 0.27 and not is_arm(p):
            # thighs and calves round the leg axis (inner side pushed less, so the thighs do not merge)
            la = Vector((sx * (0.095 + 0.07 * (0.95 - p.z) / 0.83), 0.0, p.z))
            r = p - la
            k = 0.12 * smoothstep(0.52, 0.62, p.z) * (1 - smoothstep(0.86, 0.95, p.z))
            k += 0.08 * smoothstep(0.18, 0.26, p.z) * (1 - smoothstep(0.4, 0.47, p.z))
            if r.x * sx < 0:
                k *= 0.45
            d += Vector((r.x, r.y, 0)) * k
            # stance: feet a little closer; free left leg forward with a soft knee
            t = max(0.0, min(1.15, (0.95 - p.z) / 0.83))
            d.x -= sx * 0.024 * t
            if sx > 0:
                d.y -= 0.04 * t + 0.012 * gauss(p.z - 0.5, 0.12)
        if d.length_squared > 0:
            v.co += mi @ d


physique(body)
bpy.context.view_layer.update()
skin = evaluated_mesh_world(body)

skin_bvh = BVHTree.FromBMesh(skin)
col = add_mod(body, 'COLLISION')
body.collision.thickness_outer = 0.004
body.collision.thickness_inner = 0.02
body.collision.cloth_friction = 3.0
body.collision.damping = 0.6


# ---------------------------------------------------------------- garments
def arm_rest(p, k_len, k_rad):
    side = 1.0 if p.x >= 0 else -1.0
    t, _ = arm_t(p)
    a = arm_point(t, side)
    a.y = -0.005
    b = arm_point(t * k_len, side)
    b.y = -0.005
    return b + (p - a) * k_rad


def shirt_pred(p):
    return 0.96 < p.z < neck_cut(p) and not is_hand(p) and abs(p.x) < 0.6


def shirt_rest(p):
    w = smoothstep(0.15, 0.22, abs(p.x)) if p.z > 0.9 else 0.0
    tor = Vector((p.x * 1.07, (p.y + 0.02) * 1.09 - 0.02, 1.0 + (p.z - 1.0) * 1.05))  # roomy, bulky field shirt
    arm = arm_rest(p, 1.16, 1.22)
    return tor.lerp(arm, w)


def shirt_pin(p):
    w = 0.0
    if p.z > neck_cut(p) - 0.03:
        w = 1.0
    if p.z < 1.02:
        w = 1.0
    if abs(p.x) > 0.25 and arm_t(p)[0] > WRIST_T - 0.035:
        w = max(w, 0.85)
    return w


def leg_axis(z, side):
    # hip (0.095, 0.95) -> ankle (0.165, 0.12)
    t = (0.95 - z) / 0.83
    return Vector((side * (0.095 + 0.07 * t), 0.0, z))


def pants_pred(p):
    return 0.115 < p.z < 1.075 and not is_hand(p) and abs(p.x) < 0.3 and not (abs(p.x) > 0.25 and p.z > 0.72)


def pants_rest(p):
    side = 1.0 if p.x >= 0 else -1.0
    zr = 1.07 - (1.07 - p.z) * 1.13
    a = leg_axis(p.z, side)
    a.y = 0.0
    leg = Vector((a.x + (p.x - a.x) * 1.26, p.y * 1.26, zr))  # loose trouser legs
    hip = Vector((p.x * 1.08, (p.y + 0.01) * 1.1 - 0.01, zr))
    w = smoothstep(0.72, 0.86, p.z)
    return leg.lerp(hip, w)


def pants_pin(p):
    if p.z > 1.035:
        return 1.0
    if p.z < 0.165:
        return 1.0
    return 0.0


def make_garment(name, vpred, offset, rest_fn, pin_fn, cname, mass=0.3, bend=0.25):
    bm = extract(skin, vpred)
    largest_island(bm)
    relax(bm, offset, skin_bvh)
    if SUBDIV:
        bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=1, use_grid_fill=True)
        relax(bm, offset, skin_bvh, rounds=1, iters=2)
    o = obj_from_bm(name, bm, cname)
    bm.free()
    o.shape_key_add(name='Basis')
    sk = o.shape_key_add(name='Rest')
    for i, v in enumerate(o.data.vertices):
        sk.data[i].co = rest_fn(v.co.copy())
    vg = o.vertex_groups.new(name='pin')
    for v in o.data.vertices:
        w = pin_fn(v.co)
        if w > 0:
            vg.add([v.index], w, 'REPLACE')
    cl = add_mod(o, 'CLOTH')
    s = cl.settings
    s.quality = 8
    s.mass = mass
    s.air_damping = 1.0
    s.tension_stiffness = 12
    s.compression_stiffness = 12
    s.shear_stiffness = 4
    s.bending_stiffness = bend
    s.tension_damping = 5
    s.compression_damping = 5
    s.bending_damping = 0.5
    s.vertex_group_mass = 'pin'
    s.pin_stiffness = 1.0
    s.rest_shape_key = sk
    cs = cl.collision_settings
    cs.distance_min = 0.004
    cs.collision_quality = 4
    cs.use_self_collision = True
    cs.self_distance_min = 0.003
    cl.point_cache.frame_start = 1
    cl.point_cache.frame_end = FRAMES
    print(name, 'verts', len(o.data.vertices))
    return o


shirt = make_garment('Shirt', shirt_pred, 0.01, shirt_rest, shirt_pin, 'torso', bend=3.5 if SUBDIV else 0.45)
pants = make_garment('Pants', pants_pred, 0.016, pants_rest, pants_pin, 'legs', bend=3.0 if SUBDIV else 0.55)

sc = bpy.context.scene
sc.frame_start = 1
sc.frame_end = FRAMES
for f in range(1, FRAMES + 1):
    sc.frame_set(f)
    if f % 10 == 0:
        print('sim frame', f, round(time.time() - t0, 1), 's', flush=True)

shirt = freeze(shirt)
pants = freeze(pants)
body.modifiers.remove(col)
skin.free()
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(WORK, 'stage1.blend'))
print('STAGE1_OK', round(time.time() - t0, 1), 's')
