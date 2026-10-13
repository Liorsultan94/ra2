"""
Iron Front - BI2 hero soldier, stage 2: kit, gear and materials, A-pose (Blender 5.2.2 LTS).

  nice /opt/blender/blender -b --factory-startup -P web/tools/blender/hero/stage2_gear.py

Loads $HERO_WORK/stage1.blend (body + cloth-simulated uniform) and:
- roughens the face (wider jaw and chin, heavier brow, fuller neck) on the base cage,
- subdivides the shirt / trousers and sculpts folds where uniforms bunch (above the cuffs, elbow
  crook, blousing above the belt and above the boots, behind the knees, crotch drag lines), and
  writes a 'seam' attribute (side / under-arm / arm-hole / yoke / placket / out- and in-seams, fly,
  knee reinforcement, back pockets) that the shaders turn into stitched, faded seams,
- adds, ray-projected onto the dressed body: buttoned cuffs with tabs, IL flag patch, sleeve pocket,
  cargo pockets with flaps, knee pads, gloves, boots (hero_boots.py: lofted boot last with a firm toe box,
  heel counter, stitched welt, lugged outsole, eyelets, crossed laces and a bow; trousers bloused over the
  tops), neck gaiter, glasses,
  helmet shell + Mitznefet (hero_mitz.py: oversized floppy mesh-net cover, drawstring), headset,
  chinstrap, plate carrier (plates, cummerbund, shoulder pads, MOLLE, name-tape hook field, sewn
  magazine pouches with bungees and pull tabs, admin pouch with flap / hook panel / zip, radio with
  knobs, display and PTT, IFAK with flap and handle), belt + flapped pouches, and a zip-on pack
  with zips, pulls, compression straps and buckles.
The rifle is added in stage 2b (pose). Saves $HERO_WORK/stage2.blend.
Objects are grouped in collections per body part (head, torso, arms, legs, feet, helmet, vest, rifle).
"""
import sys, os, math, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy, bmesh
from mathutils import Vector, Matrix, noise
from mathutils.bvhtree import BVHTree
from hero_lib import *
import hero_mats
from hero_rifle import build_rifle, mag_profile
from hero_boots import build_boots
from hero_glasses import build_glasses
from hero_mitz import build_mitznefet

t0 = time.time()
bpy.ops.wm.open_mainfile(filepath=os.path.join(WORK, 'stage1.blend'))
M = hero_mats.build_all()
for _m in M.values():
    _m.use_fake_user = True  # keep rifle-only materials for stage 2b
body = bpy.data.objects['Body']
shirt = bpy.data.objects['Shirt']
pants = bpy.data.objects['Pants']
body.data.materials.clear()
body.data.materials.append(M['skin'])

# eyes: sclera + brown iris (object space: the eyeball looks down its local -Z before the 90 deg tilt)
em = hero_mats.T('eye')
oc = em.coords('Object')
sep = em.n('ShaderNodeSeparateXYZ')
em.l(oc, sep.inputs[0])
r = em.math('SQRT', em.math('ADD', em.math('MULTIPLY', sep.outputs['X'], sep.outputs['X']), em.math('MULTIPLY', sep.outputs['Y'], sep.outputs['Y'])))
front = em.maprange(sep.outputs['Z'], 0.0, -0.01)
iris = em.math('MULTIPLY', em.maprange(r, 0.0062, 0.0055), front)
pupil = em.math('MULTIPLY', em.maprange(r, 0.0026, 0.0022), front)
col = em.mix(iris, hero_mats.srgb(225, 220, 210), hero_mats.srgb(70, 45, 28))
col = em.mix(pupil, col, (0.005, 0.005, 0.005, 1))
em.bsdf(col, 0.08, spec=0.6, Coat_Weight=1.0, Coat_Roughness=0.02)
for n in ('Eye.L', 'Eye.R'):
    e = bpy.data.objects[n]
    e.data.materials.clear()
    e.data.materials.append(em.m)

def smoothstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def gaussf(x, w):
    return math.exp(-(x / w) ** 2)


# ---------------------------------------------------------------- a more rugged face (edits the base cage; the
# multires scan detail rides on top): wider jaw and chin, heavier brow ridge, fuller neck
bw = body.matrix_world
for v in body.data.vertices:
    p = bw @ v.co
    if p.z < 1.44 or abs(p.x) > 0.13:
        continue
    d = Vector((0, 0, 0))
    front = smoothstep(-0.02, -0.08, p.y)
    ax = abs(p.x)
    # wide, square jaw with a defined angle below the ears and a squarer, slightly longer chin
    jaw = gaussf(p.z - 1.59, 0.03) * front
    d.x += p.x * 0.13 * jaw
    gon = gaussf(p.z - 1.585, 0.014) * gaussf(ax - 0.06, 0.014) * smoothstep(-0.03, -0.07, p.y)
    d.x += math.copysign(0.004, p.x) * gon
    chin = gaussf(p.z - 1.565, 0.016) * front
    d.y -= 0.006 * gaussf(p.x, 0.028) * chin
    d.x += p.x * 0.10 * chin * gaussf(p.x, 0.035)
    d.z -= 0.003 * gaussf(p.x, 0.03) * gaussf(p.z - 1.555, 0.012) * front
    # heavier brow ridge, slightly hooded eyes (less wide-open, less baby-like)
    brow = gaussf(p.z - 1.705, 0.01) * smoothstep(-0.10, -0.125, p.y) * gaussf(ax - 0.035, 0.03)
    d.y -= 0.0055 * brow
    d.z -= 0.0018 * brow
    lid = gaussf(p.z - 1.69, 0.006) * gaussf(ax - 0.034, 0.014) * smoothstep(-0.11, -0.135, p.y)
    d.z -= 0.0015 * lid
    d.y -= 0.001 * lid
    # nose bridge
    d.y -= 0.0018 * gaussf(p.x, 0.008) * gaussf(p.z - 1.672, 0.012) * front
    # high cheekbones with a slight hollow below them
    cheek = gaussf(p.z - 1.663, 0.013) * gaussf(ax - 0.058, 0.015) * front
    d.x += math.copysign(0.0038, p.x) * cheek
    d.y -= 0.0018 * cheek
    hollow = gaussf(p.z - 1.625, 0.012) * gaussf(ax - 0.052, 0.012) * front
    d.x -= math.copysign(0.0016, p.x) * hollow
    neck = gaussf(p.z - 1.51, 0.035)
    d.x += p.x * 0.05 * neck
    d.y += (p.y + 0.03) * 0.04 * neck
    v.co += d / SCALE
bpy.context.view_layer.update()

skin_bm = evaluated_mesh_world(body)
skin_bvh = BVHTree.FromBMesh(skin_bm)

# ---------------------------------------------------------------- uniform: sculpted folds + seams
# The cloth sim gives the drape; on top, sculpt-style fold displacement at the places real uniforms
# bunch (sleeve above the cuff, elbow crook, blousing above the belt, behind / around the knees,
# trouser blousing above the boots, crotch drag lines), with irregular, noise-driven phase and
# amplitude. Garments are subdivided once first so folds have the resolution to be rounded.


def ridge(ph):
    s = math.sin(ph)
    return s if s > 0 else 0.55 * s  # rounded ridges, shallower valleys


def arm_frame(p):
    side = 1.0 if p.x >= 0 else -1.0
    t, _ = arm_t(p)
    a = arm_point(t, side)
    a.y = -0.005
    q = p - a
    ax = Vector((side * ARM_DIR.x, 0, ARM_DIR.y))
    q -= ax * q.dot(ax)
    return side, t, q, ax


def shirt_fold(p, nrm):
    n1 = noise.noise(p * 18.0)
    n2 = noise.noise(p * 7.0 + Vector((5, 1, 3)))
    amp = 0.0
    if abs(p.x) > 0.16 and p.z > 0.85 and arm_t(p)[0] > 0.0:
        side, t, q, ax = arm_frame(p)
        qn = q.normalized() if q.length > 1e-6 else Vector((0, -1, 0))
        # bunching above the cuff
        m = smoothstep(WRIST_T - 0.17, WRIST_T - 0.07, t) * (1 - smoothstep(WRIST_T - 0.045, WRIST_T - 0.03, t))
        tilt = 0.012 * math.sin(math.atan2(qn.z, qn.y) * 2 + n2 * 2)
        amp += 0.0055 * m * (0.6 + 0.4 * n2) * ridge(2 * math.pi * (t + tilt) / 0.027 + 2.2 * n1)
        # elbow crook (front / inner side)
        inner = Vector((-side * 0.6, -0.8, 0.0))
        inner -= ax * inner.dot(ax)
        inner.normalize()
        m = gaussf(t - 0.27, 0.06) * max(0.0, qn.dot(inner)) ** 0.7
        amp += 0.006 * m * ridge(2 * math.pi * (t + 0.02 * qn.dot(Vector((0, 0, 1)))) / 0.034 + 2.0 * n1)
        # soft diagonal drag folds on the upper sleeve
        m = smoothstep(0.03, 0.08, t) * (1 - smoothstep(0.17, 0.24, t))
        amp += 0.0025 * m * ridge(2 * math.pi * (t * 0.8 + 0.5 * qn.y) / 0.05 + 1.5 * n1)
    else:
        # blousing above the belt
        m = smoothstep(1.0, 1.045, p.z) * (1 - smoothstep(1.09, 1.14, p.z))
        ang = math.atan2(p.x, -(p.y + 0.01))
        amp += 0.006 * m * (0.5 + 0.5 * n2) * ridge(2 * math.pi * ang * 0.16 / 0.033 + 3.0 * n1)
    return amp


def pants_fold(p, nrm):
    n1 = noise.noise(p * 16.0)
    n2 = noise.noise(p * 6.0 + Vector((2, 7, 1)))
    side = 1.0 if p.x >= 0 else -1.0
    ang = math.atan2(p.x - side * 0.13, -p.y)
    amp = 0.0
    # blousing above the boots: a few irregular, partly diagonal bunches (not a regular accordion)
    n3 = noise.noise(Vector((ang * 1.3, p.z * 4.0, side * 3.0)))
    m = smoothstep(0.27, 0.29, p.z) * (1 - smoothstep(0.33, 0.39, p.z)) * max(0.0, 0.35 + 0.65 * n3)
    amp += 0.006 * m * ridge(2 * math.pi * (p.z + 0.02 * math.sin(ang * 2 + n2 * 4)) / 0.03 + 3.5 * n1)
    # knee: mostly behind the knee (the pad covers the front)
    back = max(0.0, math.cos(ang - math.pi)) ** 1.5
    m = gaussf(p.z - 0.5, 0.06) * (0.3 + 0.7 * back) * max(0.0, 0.4 + 0.6 * n2)
    amp += 0.006 * m * ridge(2 * math.pi * (p.z + 0.03 * math.sin(ang * 1.5 + n2 * 2)) / 0.04 + 2.5 * n1)
    # drag lines from the crotch down the inner thigh (front)
    if p.y < 0.0 and 0.6 < p.z < 0.88:
        m = smoothstep(0.6, 0.7, p.z) * (1 - smoothstep(0.8, 0.88, p.z)) * smoothstep(0.17, 0.08, abs(p.x))
        amp += 0.004 * m * ridge(2 * math.pi * (p.z * 0.75 - abs(p.x) * 0.66) / 0.045 + 1.5 * n1)
    # gathering under the belt
    m = smoothstep(0.94, 0.98, p.z) * (1 - smoothstep(1.0, 1.03, p.z))
    ang2 = math.atan2(p.x, -p.y)
    amp += 0.003 * m * ridge(2 * math.pi * ang2 * 0.17 / 0.03 + 2.0 * n1)
    return amp


def shirt_seam(p):
    d = 1.0
    if abs(p.x) > 0.16 and p.z > 0.85 and arm_t(p)[0] > -0.03:
        side, t, q, ax = arm_frame(p)
        under = Vector((-side * 0.921, 0, -0.389))
        r = q.length
        if r > 1e-6:
            d = min(d, r * math.acos(max(-1.0, min(1.0, q.normalized().dot(under)))))
        d = min(d, abs(t - 0.015), abs(t - (WRIST_T - 0.06)))
    else:
        if abs(p.x) > 0.11:
            d = min(d, abs(p.y + 0.005))
        if p.y > 0.04:
            d = min(d, abs(p.z - 1.37))
        if p.y < -0.05 and p.z > 1.0:
            d = min(d, abs(abs(p.x) - 0.017))
    return d


def pants_seam(p):
    d = 1.0
    if p.z < 0.78:
        side = 1.0 if p.x >= 0 else -1.0
        d = min(d, abs(p.y - 0.005))  # out- and in-seam
        d = min(d, abs(p.z - 0.62) if p.y < 0 else 1.0)  # top of the knee reinforcement
        d = min(d, abs(p.z - 0.40) if p.y < 0 else 1.0)
    else:
        d = min(d, abs(p.x))  # fly / centre back
        if abs(p.x) > 0.12:
            d = min(d, abs(p.y - 0.005))
    if p.y > 0.03 and 0.86 < p.z < 0.99:  # back pockets
        d = min(d, abs(max(abs(abs(p.x) - 0.09) - 0.06, abs(p.z - 0.925) - 0.065)))
    return d


for g, mat, fold_fn, seam_fn in ((shirt, M['uniform'], shirt_fold, shirt_seam), (pants, M['uniform_pants'], pants_fold, pants_seam)):
    bm = bmesh.new()
    bm.from_mesh(g.data)
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=1, use_grid_fill=True, smooth=0.6)
    bm.normal_update()
    disp = [fold_fn(v.co, v.normal) for v in bm.verts]
    for v, a in zip(bm.verts, disp):
        v.co += v.normal * a
    bm.to_mesh(g.data)
    bm.free()
    set_seam(g, [seam_fn(v.co) for v in g.data.vertices])
    g.data.materials.clear()
    g.data.materials.append(mat)
    add_mod(g, 'SUBSURF', levels=1, render_levels=1)
    add_mod(g, 'SOLIDIFY', thickness=0.0025, offset=-1.0)
    shade_smooth(g)

dressed = bvh_of([shirt, pants, body])
SIDES = (1.0, -1.0)  # +X = soldier's left

# ---------------------------------------------------------------- gaiter (neck + lower face)
def gaiter_pred(p):
    top = 1.572 + 0.03 * max(0.0, min(1.0, (p.y + 0.07) / 0.1))  # below the chin: jaw and stubble show
    return abs(p.x) < 0.13 and 1.455 < p.z < top


gb = extract(skin_bm, gaiter_pred)
largest_island(gb)
relax(gb, 0.006, skin_bvh, rounds=5, iters=8, fac=0.7)
for v in gb.verts:  # soft horizontal sag folds
    n = noise.noise(v.co * 40.0)
    v.co += v.normal * (0.0022 * math.sin(v.co.z * 2 * math.pi / 0.022 + n * 2.5) + 0.0015 * n)
gaiter = obj_from_bm('Gaiter', gb, 'head', M['gaiter'])
gb.free()
add_mod(gaiter, 'SUBSURF', levels=1, render_levels=2)
add_mod(gaiter, 'SOLIDIFY', thickness=0.003, offset=-1.0)

# ---------------------------------------------------------------- collar, cuffs, flag patch
neck_bvh = bvh_of([shirt, gaiter, body])
ring_band(neck_bvh, 'Collar_Stand', (0, -0.035, 1.47), (0, -0.15, 1), 0.0, 0.05, 40, 3, 0.004, 'torso', M['uniform'],
          thick=0.0025, bevel=0.0008, a0=0.42, a1=2 * math.pi - 0.42, R=0.1)
for sx in SIDES:
    ax = Vector((sx * ARM_DIR.x, 0, ARM_DIR.y))
    c = arm_point(0.0, sx)
    c.y = -0.005
    s_ = 'L' if sx > 0 else 'R'
    # buttoned cuff: a doubled band with a tab and a button
    ring_band(dressed, 'Cuff_' + s_, c, ax, WRIST_T - 0.058, WRIST_T - 0.014, 32, 3, 0.0035,
              'arms', M['uniform'], thick=0.0045, bevel=0.0012, R=0.12)
    cuff_bvh = bvh_of([bpy.data.objects['Cuff_' + s_]])
    tc = arm_point(WRIST_T - 0.036, sx)
    tc.y = -0.005
    outc = Vector((sx * 0.25, -0.95, 0.0)).normalized()
    project_sheet(cuff_bvh, 'Cuff_Tab_' + s_, tc + outc * 0.03, ax.cross(outc).normalized(), ax, -outc, 0.02, 0.011, 8, 4,
                  0.0012, 'arms', M['uniform'], thick=0.003, round_n=4, bevel=0.0008)
# sleeve pocket with flap on the right upper sleeve (soldier's right = -X)
outr = Vector((-0.921 * 0.78, -0.62, 0.389 * 0.78)).normalized()
pr = arm_point(0.15, -1.0)
v_r = Vector((ARM_DIR.x, 0, -ARM_DIR.y)).normalized()
u_r = v_r.cross(outr).normalized()
project_sheet(dressed, 'Sleeve_Pocket', pr, u_r, v_r, -outr, 0.042, 0.052, 10, 12, 0.003, 'arms', M['uniform'],
              thick=0.0025, round_n=10, bevel=0.0008, lift=lambda a, b: 0.007 * (1 - a * a) * (1 - b * b) ** 0.5)
project_sheet(dressed, 'Sleeve_PocketFlap', pr + v_r * 0.047, u_r, v_r, -outr, 0.045, 0.016, 10, 4, 0.008, 'arms',
              M['uniform'], thick=0.003, round_n=10, bevel=0.0008, lift=lambda a, b: 0.003 * (1 - a * a))
# IL flag patch on the left upper sleeve (soldier's left = +X)
outw = Vector((0.921 * 0.78, -0.62, 0.389 * 0.78)).normalized()
pc = arm_point(0.12, 1.0)
v_ax = Vector((-ARM_DIR.x, 0, -ARM_DIR.y)).normalized()
u_ax = v_ax.cross(outw).normalized()
flag = project_sheet(dressed, 'Patch_Flag_IL', pc, -u_ax, v_ax, -outw, 0.040, 0.029, 8, 6, 0.0035, 'arms', M['flag'],
                     thick=0.0015, round_n=12, bevel=0.0006)
flag_bg = project_sheet(dressed, 'Patch_Velcro', pc, -u_ax, v_ax, -outw, 0.046, 0.034, 8, 6, 0.0018, 'arms', M['velcro'],
                        thick=0.0012, round_n=10)

# ---------------------------------------------------------------- gloves
def glove_pred(p):
    return abs(p.x) > 0.25 and 0.6 < p.z < 1.1 and arm_t(p)[0] > WRIST_T - 0.035


gl = extract(skin_bm, glove_pred)
push_normals(gl, 0.0028)
gloves = obj_from_bm('Gloves', gl, 'arms', M['glove'])
gl.free()
add_mod(gloves, 'SUBSURF', levels=1, render_levels=1)
add_mod(gloves, 'SOLIDIFY', thickness=0.0015, offset=-1.0)
glove_bvh = bvh_of([gloves])
for sx in SIDES:
    ax = Vector((sx * ARM_DIR.x, 0, ARM_DIR.y))
    c = arm_point(0.0, sx)
    c.y = -0.005
    ring_band(glove_bvh, 'Glove_Strap_%s' % ('L' if sx > 0 else 'R'), c, ax, WRIST_T + 0.0, WRIST_T + 0.03, 28, 2,
              0.0025, 'arms', M['glove_pad'], thick=0.0025, bevel=0.0008, R=0.2)
    # knuckle guard on the back of the hand (back faces outwards/forwards in the relaxed A-pose)
    kc = arm_point(WRIST_T + 0.085, sx)
    kc.y = -0.01
    out = Vector((sx * 0.92, -0.25, 0.39 * 1.0)).normalized()
    va = Vector((sx * ARM_DIR.x, 0, ARM_DIR.y)).normalized()
    ua = va.cross(out).normalized()
    project_sheet(glove_bvh, 'Glove_Knuckle_%s' % ('L' if sx > 0 else 'R'), kc, ua, va, -out, 0.033, 0.016, 10, 4, 0.004,
                  'arms', M['glove_pad'], thick=0.004, round_n=4, bevel=0.0012)

# ---------------------------------------------------------------- boots (built from a boot last, see hero_boots.py)
build_boots(M, skin_bm, pants, SIDES)

# ---------------------------------------------------------------- trousers details
ring_band(dressed, 'Pants_Waistband', (0, 0.0, 0.0), (0, 0, 1), 1.03, 1.066, 64, 2, 0.003, 'legs', M['uniform_dark'],
          thick=0.003, bevel=0.0008, R=0.25)
project_sheet(dressed, 'Pants_Fly', (0.012, -0.3, 0.92), (1, 0, 0), (0, 0, 1), (0, 1, 0), 0.016, 0.075, 4, 12, 0.003, 'legs',
              M['uniform'], thick=0.0025, round_n=8, bevel=0.0008)
for sx in SIDES:
    s = 'L' if sx > 0 else 'R'
    d = Vector((sx * 0.86, -0.5, 0)).normalized()
    c = Vector((sx * 0.15, -0.02, 0.60))
    u = Vector((0, 0, 1)).cross(d).normalized()
    project_sheet(dressed, 'CargoPocket_' + s, c, u, (0, 0, 1), -d, 0.068, 0.085, 12, 14, 0.004, 'legs', M['uniform'],
                  thick=0.003, round_n=10, bevel=0.001, lift=lambda a, b: 0.012 * (1 - a * a) * (1 - b * b) ** 0.5)
    project_sheet(dressed, 'CargoFlap_' + s, c + Vector((0, 0, 0.083)), u, (0, 0, 1), -d, 0.072, 0.022, 12, 4, 0.010,
                  'legs', M['uniform'], thick=0.0035, round_n=10, bevel=0.001, lift=lambda a, b: 0.006 * (1 - a * a))
    # knee pad: hard shell + soft backing + two straps
    kc = Vector((sx * 0.118, -0.3, 0.50))
    ray = Vector((0, 1, 0))
    project_sheet(dressed, 'KneePadBack_' + s, kc, (1, 0, 0), (0, 0, 1), ray, 0.056, 0.084, 12, 14, 0.010, 'legs',
                  M['gear_pad'], thick=0.008, round_n=4, bevel=0.003, smooth_iter=4)
    project_sheet(dressed, 'KneePad_' + s, kc, (1, 0, 0), (0, 0, 1), ray, 0.049, 0.074, 12, 14, 0.019, 'legs',
                  M['polymer_olive'], thick=0.009, round_n=3.5, bevel=0.004, smooth_iter=6,
                  lift=lambda a, b: 0.007 * max(0.0, 1 - a * a - b * b))
    for zz in (0.44, 0.565):
        ring_band(dressed, 'KneeStrap_%s_%d' % (s, int(zz * 100)), (sx * 0.118, 0.0, zz), (0, 0, 1), -0.0095, 0.0095, 36, 1,
                  0.006, 'legs', M['webbing'], thick=0.003, bevel=0.0008, R=0.12)

# ---------------------------------------------------------------- belt + pouches
belt = ring_band(dressed, 'Belt', (0, 0.0, 0.0), (0, 0, 1), 0.988, 1.036, 64, 2, 0.008, 'vest', M['webbing'],
                 thick=0.008, bevel=0.0015, R=0.25)
belt_bvh = bvh_of([belt, shirt, pants, body])
hit, n = surface_frame(belt_bvh, (0, -0.4, 1.012), (0, 1, 0))
bk = rbox('Belt_Buckle', (0.058, 0.012, 0.046), cname='vest', mat=M['metal'], bevel=0.003)
orient(bk, hit + n * 0.005, n)
bk2 = rbox('Belt_BuckleFace', (0.04, 0.006, 0.03), cname='vest', mat=M['polymer'], bevel=0.002)
orient(bk2, hit + n * 0.012, n)


# ---------------------------------------------------------------- pouches: sewn boxes (stitched edges, padded bulge,
# slight taper), flaps with pull tabs and hook panels, bungees, MOLLE straps


def flap_on(parent, name, w, d, h, drop, mat, tab=True, hook=False):
    """flap folded over the top of a pouch (local frame: -Y out, +Z up), hanging `drop` down its front."""
    top = h / 2 + 0.003
    pts = [Vector((0, d / 2 - 0.004, top)), Vector((0, 0.0, top + 0.002)), Vector((0, -d / 2 + 0.004, top + 0.001)),
           Vector((0, -d / 2 - 0.004, top - 0.008)), Vector((0, -d / 2 - 0.0045, top - drop))]
    pts = smooth_curve(pts, 4)
    nr = []
    for i, p in enumerate(pts):
        q = pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]
        nr.append(Vector((0, -q.z, q.y)).normalized() * -1 if q.length > 1e-6 else Vector((0, 0, 1)))
    f = strap_along(name, pts, nr, w + 0.004, 0.004, 'vest', mat)
    f.parent = parent
    if tab:
        t = rbox(name + 'Tab', (0.018, 0.004, 0.022), (0, -d / 2 - 0.007, top - drop - 0.006), cname='vest', mat=M['webbing'],
                 bevel=0.0012)
        t.parent = parent
    if hook:
        hk = rbox(name + 'Hook', (w * 0.6, 0.002, drop * 0.5), (0, -d / 2 - 0.0075, top - drop * 0.55), cname='vest',
                  mat=M['velcro'], bevel=0.0008)
        hk.parent = parent
    return f


def pouch(name, size, hit, nrm, mat=None, flap=0.0, lift=0.0, bulge=0.004, taper=0.05, up=(0, 0, 1), hook=False,
          straps=True):
    w, d, h = size
    o = rbox(name, size, cname='vest', mat=mat or M['gear'], bevel=0.006, segs=3, subd=1, cuts=5, bulge=bulge, taper=taper)
    orient(o, hit + nrm * (d / 2 + lift), nrm, up)
    if flap:
        flap_on(o, name + '_Flap', w * (1 - taper), d * (1 - taper * 0.6), h, flap, mat or M['gear'], hook=hook)
    if straps:  # MOLLE straps on the back woven into the carrier webbing: their loops show at the sides
        for sxx in (-1, 1):
            st = rbox(name + '_Molle%d' % sxx, (0.006, d * 0.7, 0.025), (sxx * (w / 2 + 0.001), 0.004, -h * 0.18), cname='vest',
                      mat=M['webbing'], bevel=0.001)
            st.parent = o
    return o


def side_item(name, ang, z, size, mat, bvh, lift=0.0, flap=0.0, R=0.27, hook=False):
    d = Vector((math.sin(ang), -math.cos(ang), 0))
    hit, n, _, _ = bvh.ray_cast(Vector((0, 0.0, z)) + d * R, -d, R)
    if hit is None:
        hit, n = Vector((0, 0, z)) + d * 0.18, d
    n = Vector((n.x, n.y, 0)).normalized()
    o = pouch(name, size, hit, n, mat=mat, flap=flap, lift=lift, hook=hook)
    return o, hit, n


side_item('Belt_PouchUtil', -2.0, 0.955, (0.11, 0.055, 0.12), M['gear'], belt_bvh, flap=0.045, hook=True)
side_item('Belt_PouchCanteen', 2.15, 0.95, (0.09, 0.07, 0.15), M['gear'], belt_bvh, flap=0.05)
side_item('Belt_PouchSmall', 1.15, 0.965, (0.07, 0.04, 0.09), M['gear'], belt_bvh, flap=0.035)

# ---------------------------------------------------------------- plate carrier
FP = project_sheet(dressed, 'Vest_FrontPlate', (0, -0.3, 1.24), (1, 0, 0), (0, 0, 1), (0, 1, 0), 0.132, 0.165, 18, 22,
                   0.056, 'vest', M['gear'], thick=0.042, round_n=5, bevel=0.007, smooth_iter=40)
BP = project_sheet(dressed, 'Vest_BackPlate', (0, 0.3, 1.25), (-1, 0, 0), (0, 0, 1), (0, -1, 0), 0.138, 0.17, 18, 22,
                   0.05, 'vest', M['gear'], thick=0.038, round_n=5, bevel=0.007, smooth_iter=40)
for sx in SIDES:
    s = 'L' if sx > 0 else 'R'
    a0, a1 = (0.5, math.pi - 0.5) if sx > 0 else (-(math.pi - 0.5), -0.5)
    ring_band(dressed, 'Vest_Cummerbund_' + s, (0, -0.01, 0.0), (0, 0, 1), 1.05, 1.205, 22, 6, 0.016, 'vest',
              M['gear'], thick=0.012, bevel=0.003, a0=a0, a1=a1, R=0.22)
    for k, zz in enumerate((1.072, 1.112, 1.152, 1.19)):
        ring_band(dressed, 'Vest_MolleC_%s%d' % (s, k), (0, -0.01, 0.0), (0, 0, 1), zz - 0.0125, zz + 0.0125, 22, 1,
                  0.018, 'vest', M['webbing'], thick=0.0022, a0=a0, a1=a1, R=0.22)
vest_bvh = bvh_of([FP, BP, shirt, pants, body])
# shoulder pads: path over each shoulder from the front plate to the back plate
for sx in SIDES:
    s = 'L' if sx > 0 else 'R'
    # the pad lies on the trapezius: it follows the surface normal (tilted down the shoulder slope, so it
    # does not stand up as a flat ridge) and sits 4 mm off the shirt (compressed padding)
    c = Vector((sx * 0.112, -0.01, 1.33))
    pts, nrm = [], []
    for k in range(29):
        b = -0.05 + (math.pi + 0.1) * k / 28
        d = Vector((0, -math.cos(b), math.sin(b)))
        hit, n = surface_frame(vest_bvh, c + d * 0.5, -d)
        if n.dot(d) < 0.2:
            n = d
        pts.append(hit)
        nrm.append(n)
    for _ in range(4):
        nrm = [nrm[0]] + [(nrm[i - 1] + nrm[i] * 2 + nrm[i + 1]).normalized() for i in range(1, len(nrm) - 1)] + [nrm[-1]]
    pts = [p + n * 0.004 for p, n in zip(pts, nrm)]
    for _ in range(4):  # relax the path so the pad bridges small bumps instead of following them
        pts = [pts[0]] + [max(((pts[i - 1] + pts[i + 1]) * 0.5, pts[i]), key=lambda q: (q - c).length) for i in range(1, len(pts) - 1)] + [pts[-1]]
    strap_along('Vest_ShoulderPad_' + s, pts, nrm, 0.068, 0.014, 'vest', M['gear_pad'])
    strap_along('Vest_ShoulderStrap_' + s, [p + n * 0.014 for p, n in zip(pts, nrm)], nrm, 0.03, 0.003, 'vest', M['webbing'])
vest_bvh = bvh_of([FP, BP, shirt, pants, body] + [o for o in bpy.data.collections['vest'].objects if o.name.startswith('Vest_Shoulder')])
# MOLLE rows on the back plate and on the lower front plate (behind the magazine pouches)
for k in range(6):
    zz = 1.13 + k * 0.038
    project_sheet(vest_bvh, 'Vest_MolleB%d' % k, (0, 0.4, zz), (-1, 0, 0), (0, 0, 1), (0, -1, 0), 0.118, 0.0125, 16, 1,
                  0.002, 'vest', M['webbing'], thick=0.0022, round_n=30)
for k in range(3):
    zz = 1.095 + k * 0.038
    project_sheet(vest_bvh, 'Vest_MolleF%d' % k, (0, -0.4, zz), (1, 0, 0), (0, 0, 1), (0, 1, 0), 0.118, 0.0125, 16, 1,
                  0.002, 'vest', M['webbing'], thick=0.0022, round_n=30)
# hook-and-loop name-tape field on the upper front plate (blank, no insignia)
project_sheet(vest_bvh, 'Vest_NameTape', (0, -0.4, 1.372), (1, 0, 0), (0, 0, 1), (0, 1, 0), 0.06, 0.017, 10, 3, 0.0015, 'vest',
              M['velcro'], thick=0.0015, round_n=8)
# drag handle
hit, n = surface_frame(vest_bvh, (0, 0.4, 1.405), (0, -1, 0))
tube_along('Vest_DragHandle', [hit + Vector((-0.04, 0, 0)), hit + n * 0.02 + Vector((-0.03, 0, 0.01)),
                               hit + n * 0.025 + Vector((0.03, 0, 0.01)), hit + Vector((0.04, 0, 0))], 0.006, 'vest', M['webbing'])

# front: triple open-top magazine pouch, magazines floor-plate up with bungee retention + pull tabs
for i, x in enumerate((-0.078, 0.0, 0.078)):
    hit, n = surface_frame(vest_bvh, (x, -0.4, 1.135), (0, 1, 0))
    p = pouch('Vest_MagPouch%d' % i, (0.072, 0.04, 0.15), hit, n, bulge=0.003, taper=0.03, straps=False)
    mg = extrude_profile('Vest_Mag%d' % i, [(0.75 * (x2 + 0.12), -0.8 * z) for x2, z in mag_profile(0.0)], 0.024, 'vest',
                         M['mag'], bevel=0.0025, segs=2)
    mg.parent = p
    mg.location = (0, 0, -0.083)
    base = rbox('Vest_MagBase%d' % i, (0.058, 0.03, 0.01), (0.004, 0, 0.1), cname='vest', mat=M['mag'], bevel=0.003)
    base.parent = p
    # bungee: from the pouch sides up over the floor plate, knotted to a webbing pull tab
    bung = tube_along('Vest_Bungee%d' % i, smooth_curve([(-0.034, -0.0, 0.045), (-0.03, -0.012, 0.09), (-0.012, -0.012, 0.108),
                                                          (0.012, -0.012, 0.108), (0.03, -0.012, 0.09), (0.034, 0.0, 0.045)], 3),
                      0.0028, 'vest', M['rubber'])
    bung.parent = p
    tab = rbox('Vest_PullTab%d' % i, (0.014, 0.005, 0.03), (0, -0.016, 0.118), (math.radians(-15), 0, 0), cname='vest',
               mat=M['webbing'], bevel=0.0015)
    tab.parent = p
    for zz in (-0.035, 0.003):  # MOLLE straps across the pouch front
        st = rbox('Vest_PouchStrap%d_%d' % (i, int(zz * 1000)), (0.07, 0.004, 0.025), (0, -0.0215, zz), cname='vest',
                  mat=M['webbing'], bevel=0.001)
        st.parent = p
# admin pouch with a flap, hook panel and a zip, above the magazines
hit, n = surface_frame(vest_bvh, (0, -0.4, 1.285), (0, 1, 0))
ad = pouch('Vest_AdminPouch', (0.18, 0.03, 0.105), hit, n, flap=0.04, bulge=0.004, taper=0.0, hook=True, straps=False)
o = rbox('Vest_AdminVelcro', (0.11, 0.004, 0.035), (0, -0.017, -0.03), cname='vest', mat=M['velcro'], bevel=0.0015)
o.parent = ad
zp = tube_along('Vest_AdminZip', [(-0.082, -0.0155, -0.012), (-0.082, -0.0155, -0.047), (0.082, -0.0155, -0.047),
                                   (0.082, -0.0155, -0.012)], 0.0016, 'vest', M['polymer'])
zp.parent = ad
# radio in an open pouch with a retention strap; detailed radio (knobs, antenna base, display, side PTT)
rp, rhit, rn = side_item('Vest_RadioPouch', 1.62, 1.13, (0.075, 0.045, 0.11), M['gear'], vest_bvh, lift=0.002)
radio = rbox('Vest_Radio', (0.062, 0.036, 0.13), (0, 0, 0.03), cname='vest', mat=M['polymer'], bevel=0.005, cuts=3)
radio.parent = rp
for nm, r_, h_, loc in (('Vest_RadioKnobVol', 0.0085, 0.016, (0.016, 0, 0.103)), ('Vest_RadioKnobCh', 0.007, 0.012, (0.0, 0, 0.101)),
                        ('Vest_RadioAntBase', 0.0075, 0.022, (-0.018, 0, 0.106))):
    k = cyl(nm, r_, h_, loc, (0, 0, 0), 'vest', M['rubber' if 'Ant' in nm else 'polymer'], 20, 0.0012)
    k.parent = rp
for nm, sz, loc, mat in (('Vest_RadioDisplay', (0.034, 0.002, 0.016), (0, -0.0185, 0.075), M['lens']),
                         ('Vest_RadioPTTBtn', (0.006, 0.014, 0.03), (-0.0325, 0, 0.07), M['rubber']),
                         ('Vest_RadioStrap', (0.08, 0.05, 0.012), (0, 0, 0.058), M['webbing'])):
    k = rbox(nm, sz, loc, cname='vest', mat=mat, bevel=0.0015)
    k.parent = rp
bpy.context.view_layer.update()
atop = rp.matrix_world @ Vector((-0.018, 0, 0.115))
tube_along('Vest_Antenna', smooth_curve([atop, atop + Vector((0.005, 0.02, 0.08)), Vector((0.2, 0.09, 1.42)),
                                          Vector((0.205, 0.11, 1.56)), Vector((0.2, 0.125, 1.66))], 4), 0.0035, 'vest', M['rubber'])
tube_along('Vest_PTTCable', smooth_curve([rp.matrix_world @ Vector((0.016, 0, 0.11)), Vector((0.19, -0.05, 1.33)),
                                           Vector((0.135, -0.165, 1.39)), Vector((0.12, -0.19, 1.30)),
                                           Vector((0.105, -0.205, 1.33))], 4), 0.0028, 'vest', M['rubber'])
ptt = rbox('Vest_PTT', (0.04, 0.02, 0.05), cname='vest', mat=M['polymer'], bevel=0.004, cuts=2)
hit, n = surface_frame(vest_bvh, (0.1, -0.4, 1.33), (0, 1, 0))
orient(ptt, hit + n * 0.012, n)
o = cyl('Vest_PTTButton', 0.011, 0.006, (0, -0.012, 0.004), (math.pi / 2, 0, 0), 'vest', M['rubber'], 20, 0.001)
o.parent = ptt
ifak, _, _ = side_item('Vest_IFAK', -1.6, 1.13, (0.11, 0.06, 0.12), M['gear'], vest_bvh, lift=0.002, flap=0.05)
o = tube_along('Vest_IFAKHandle', [(-0.03, -0.031, 0.04), (-0.025, -0.045, 0.075), (0.025, -0.045, 0.075), (0.03, -0.031, 0.04)],
               0.004, 'vest', M['webbing'])
o.parent = ifak
# tourniquet on the right shoulder pad
hit, n = surface_frame(vest_bvh, (-0.105, -0.4, 1.4), (0, 1, 0))
tq = rbox('Vest_Tourniquet', (0.03, 0.025, 0.09), cname='vest', mat=M['polymer'], bevel=0.006, cuts=2)
orient(tq, hit + n * 0.014, n)

# zip-on back pack: padded body, front pocket and top pocket with zips and pulls, compression straps
# with side-release buckles, MOLLE, grab handle
hit, n = surface_frame(vest_bvh, (0, 0.5, 1.22), (0, -1, 0))
pack = rbox('Pack', (0.27, 0.11, 0.36), cname='vest', mat=M['gear'], bevel=0.025, segs=4, subd=1, cuts=6, bulge=0.012, taper=0.06)
orient(pack, hit + n * 0.06, n)
for nm, sz, loc in (('Pack_Pocket', (0.2, 0.05, 0.16), (0, -0.07, -0.07)),
                    ('Pack_TopPocket', (0.18, 0.04, 0.06), (0, -0.05, 0.13))):
    o = rbox(nm, sz, loc, cname='vest', mat=M['gear'], bevel=0.012, segs=3, subd=1, cuts=5, bulge=0.008)
    o.parent = pack
zips = [
    [(-0.088, -0.097, -0.03), (-0.088, -0.097, 0.0), (0.088, -0.097, 0.0), (0.088, -0.097, -0.03)],   # front pocket top zip
    [(-0.13, -0.035, 0.0), (-0.12, -0.045, 0.14), (-0.09, -0.05, 0.178), (0.09, -0.05, 0.178), (0.12, -0.045, 0.14),
     (0.13, -0.035, 0.0)],                                                                             # main zip
]
for k, zz in enumerate(zips):
    o = tube_along('Pack_Zip%d' % k, smooth_curve(zz, 3), 0.002, 'vest', M['polymer'])
    o.parent = pack
for k, (x, y, z) in enumerate([(-0.07, -0.1, -0.006), (0.07, -0.1, -0.006), (-0.1, -0.052, 0.168), (0.1, -0.052, 0.168)]):
    o = rbox('Pack_ZipPull%d' % k, (0.007, 0.003, 0.022), (x, y, z - 0.012), cname='vest', mat=M['metal'], bevel=0.001)
    o.parent = pack
    c = tube_along('Pack_ZipCord%d' % k, [(x, y - 0.001, z - 0.022), (x + 0.003, y - 0.004, z - 0.04)], 0.0018, 'vest', M['rubber'])
    c.parent = pack
for k in range(3):
    o = rbox('Pack_Molle%d' % k, (0.18, 0.004, 0.025), (0, -0.097, -0.065 - k * 0.038), cname='vest', mat=M['webbing'], bevel=0.0008)
    o.parent = pack
for sx in SIDES:
    for k, zz in enumerate((0.06, -0.08)):
        o = rbox('Pack_Compress_%d_%d' % (sx, k), (0.022, 0.12, 0.004), (sx * 0.133, 0.0, zz), (0, math.pi / 2, 0), cname='vest',
                 mat=M['webbing'], bevel=0.0008)
        o.parent = pack
        b = rbox('Pack_Buckle_%d_%d' % (sx, k), (0.012, 0.03, 0.024), (sx * 0.137, -0.035, zz), cname='vest', mat=M['polymer'],
                 bevel=0.002, cuts=2)
        b.parent = pack
o = tube_along('Pack_Handle', [(-0.04, 0.02, 0.18), (-0.03, 0.02, 0.2), (0.03, 0.02, 0.2), (0.04, 0.02, 0.18)], 0.005, 'vest', M['webbing'])
o.parent = pack

# ---------------------------------------------------------------- helmet + Mitznefet
HC = Vector((0.0, -0.052, 1.688))
RX, RY, RZ = 0.121, 0.139, 0.13


def rim_z(p):
    a = math.atan2(p.x, -(p.y - HC.y))
    return 1.6925 + 0.0425 * math.cos(a)


def helmet_shell(name, sx, sy, sz, cut_drop, cname, mat, segs=64, rings=32):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segs, v_segments=rings, radius=1.0)
    bm.transform(Matrix.Diagonal((sx, sy, sz, 1)))
    bm.transform(Matrix.Translation(HC))
    kill = [v for v in bm.verts if v.co.z < rim_z(v.co) - cut_drop]
    bmesh.ops.delete(bm, geom=kill, context='VERTS')
    # snap the cut edge onto the rim curve (clean edge instead of the sphere grid's stair steps)
    for v in bm.verts:
        if v.is_boundary:
            z = rim_z(v.co) - cut_drop
            d = v.co - HC
            dz = (z - HC.z) / sz
            r = math.sqrt(max(0.0, 1 - dz * dz))
            a = math.atan2(d.x / sx, -d.y / sy)
            v.co = Vector((HC.x + sx * r * math.sin(a), HC.y - sy * r * math.cos(a), z))
    o = obj_from_bm(name, bm, cname, mat)
    bm.free()
    return o


shell = helmet_shell('Helmet_Shell', RX, RY, RZ, 0.0, 'helmet', M['helmet'])
add_mod(shell, 'SOLIDIFY', thickness=0.008, offset=-1.0)
add_mod(shell, 'BEVEL', width=0.002, segments=2, limit_method='ANGLE')
add_mod(shell, 'SUBSURF', levels=1, render_levels=1)
# Mitznefet: oversized floppy mesh-net cover gathered under the rim by an elastic drawstring (hero_mitz.py);
# the NVG shroud sits on the shell and pokes through a cut-out in the netting
shell_bvh = bvh_of([shell])
hit, n = surface_frame(shell_bvh, (0, -0.4, 1.745), (0, 1, 0))
cover, draw = build_mitznefet(M, HC, RX, RY, RZ, rim_z, hit)
tubes('Helmet_Band', [draw], 0.0028, 'helmet', M['webbing'])
nvg = rbox('Helmet_NVGShroud', (0.055, 0.016, 0.042), cname='helmet', mat=M['metal'], bevel=0.004)
orient(nvg, hit + n * 0.004, n)
mnt = rbox('Helmet_NVGMount', (0.03, 0.022, 0.03), (0, -0.016, -0.004), cname='helmet', mat=M['polymer'], bevel=0.004)
mnt.parent = nvg
# headset ear cups + arms + mic boom: off by the owner's request (r8); HERO_HEADSET=1 brings it back
if os.environ.get('HERO_HEADSET') == '1':
    for sx in SIDES:
        s = 'L' if sx > 0 else 'R'
        cup = cyl('Headset_Cup_' + s, 0.037, 0.03, (sx * 0.112, -0.045, 1.652), (0, math.pi / 2, 0), 'helmet', M['headset'], 40, 0.006)
        add_mod(cup, 'SUBSURF', levels=1, render_levels=1)
        ring = cyl('Headset_Cushion_' + s, 0.035, 0.012, (sx * 0.096, -0.045, 1.652), (0, math.pi / 2, 0), 'helmet', M['rubber'], 40, 0.004)
        cap = cyl('Headset_Knob_' + s, 0.009, 0.01, (sx * 0.13, -0.035, 1.665), (0, math.pi / 2, 0), 'helmet', M['polymer'], 20, 0.001)
        arm = rbox('Headset_Arm_' + s, (0.012, 0.02, 0.05), (sx * 0.118, -0.045, 1.695), cname='helmet', mat=M['polymer'], bevel=0.003)
    tube_along('Headset_Mic', smooth_curve([(-0.125, -0.06, 1.64), (-0.105, -0.12, 1.615), (-0.06, -0.165, 1.6), (-0.022, -0.168, 1.6)], 5),
               0.0022, 'helmet', M['polymer'])
    mic = cyl('Headset_MicFoam', 0.008, 0.016, (-0.016, -0.168, 1.6), (0, math.pi / 2, 0), 'helmet', M['rubber'], 20, 0.004)
    add_mod(mic, 'SUBSURF', levels=2, render_levels=2)
# chinstrap (Y-straps in front of / behind the cups, buckle under the chin)
chin_bvh = bvh_of([gaiter, body])
for sx in SIDES:
    s = 'L' if sx > 0 else 'R'
    for nm, path in (('F', [(sx * 0.10, -0.095, 1.69), (sx * 0.095, -0.095, 1.63), (sx * 0.07, -0.1, 1.585), (sx * 0.035, -0.11, 1.56), (0, -0.115, 1.553)]),
                     ('B', [(sx * 0.10, 0.01, 1.66), (sx * 0.095, -0.02, 1.61), (sx * 0.075, -0.065, 1.585)])):
        pts, nrm = [], []
        for q in smooth_curve(path, 3):
            hit, n, _, _ = chin_bvh.find_nearest(q)
            n = n.normalized()
            pts.append(hit + n * 0.003)
            nrm.append(n)
        strap_along('Helmet_Chinstrap%s_%s' % (nm, s), pts, nrm, 0.016, 0.0022, 'helmet', M['webbing'])
cb = rbox('Helmet_ChinBuckle', (0.03, 0.01, 0.018), cname='helmet', mat=M['polymer'], bevel=0.003)
hit, n, _, _ = chin_bvh.find_nearest(Vector((0.0, -0.1, 1.54)))
orient(cb, hit + n * 0.006, n)

# ballistic glasses: Saber-style wraparound shield (see hero_glasses.py)
build_glasses(M, bvh_of([body]), SIDES)

skin_bm.free()
for o in bpy.data.objects:
    if o.type == 'MESH':
        for p in o.data.polygons:
            p.use_smooth = True
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(WORK, 'stage2.blend'))
print('STAGE2_OK', round(time.time() - t0, 1), 's')
