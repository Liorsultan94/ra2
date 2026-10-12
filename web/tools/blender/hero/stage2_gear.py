"""
Iron Front - BI2 hero soldier, stage 2: kit, gear, rifle and materials (Blender 5.2.2 LTS).

  nice /opt/blender/blender -b --factory-startup -P web/tools/blender/hero/stage2_gear.py

Loads $HERO_WORK/stage1.blend (body + simulated uniform) and adds, all ray-projected onto the
dressed body so everything sits on the cloth: collar, cuffs, IL flag patch, cargo pockets, knee pads,
gloves, boots (laces, lugged soles), neck gaiter, ballistic glasses, helmet shell + cloth-simulated
Mitznefet cover, headset, chinstrap, plate carrier (plates, cummerbund, shoulder pads, MOLLE, mag
pouches with magazines, admin pouch, radio + antenna + PTT cable, IFAK), battle belt + pouches, a
zip-on back pack and the Tavor-style rifle on a sling. Saves $HERO_WORK/stage2.blend.
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

t0 = time.time()
bpy.ops.wm.open_mainfile(filepath=os.path.join(WORK, 'stage1.blend'))
M = hero_mats.build_all()
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

skin_bm = evaluated_mesh_world(body)
skin_bvh = BVHTree.FromBMesh(skin_bm)

# ---------------------------------------------------------------- uniform finishing
for g, m in ((shirt, M['uniform']), (pants, M['uniform'])):
    g.data.materials.clear()
    g.data.materials.append(m)
    add_mod(g, 'SMOOTH', factor=0.3, iterations=1)
    add_mod(g, 'SUBSURF', levels=1, render_levels=2)
    add_mod(g, 'SOLIDIFY', thickness=0.0025, offset=-1.0, use_even_offset=True)
shade_smooth(shirt)
shade_smooth(pants)

dressed = bvh_of([shirt, pants, body])
SIDES = (1.0, -1.0)  # +X = soldier's left

# ---------------------------------------------------------------- gaiter (neck + lower face)
def gaiter_pred(p):
    top = 1.622 if p.y < -0.085 else 1.60 + 0.022 * max(0.0, min(1.0, (-p.y - 0.02) / 0.065))
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
    ring_band(dressed, 'Cuff_%s' % ('L' if sx > 0 else 'R'), c, ax, WRIST_T - 0.045, WRIST_T - 0.012, 28, 2, 0.003,
              'arms', M['uniform_dark'], thick=0.003, bevel=0.0008, R=0.12)
    # sleeve hem roll (thicker seam just above the cuff)
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

# ---------------------------------------------------------------- boots
def boot_pred(p):
    return p.z < 0.135 and abs(p.x) < 0.32


bb = extract(skin_bm, boot_pred)
relax(bb, 0.011, skin_bvh, rounds=4, iters=6, fac=0.6)
boots = obj_from_bm('Boots', bb, 'feet', M['boot'])
add_mod(boots, 'SUBSURF', levels=1, render_levels=2)
add_mod(boots, 'SOLIDIFY', thickness=0.004, offset=-1.0)
# tall shaft wrapped around the trouser hem (trousers tucked into the boots)
hem_bvh = bvh_of([pants, body])
shafts = []
for sx in SIDES:
    shafts.append(ring_band(hem_bvh, 'BootShaft_%s' % ('L' if sx > 0 else 'R'), (sx * 0.165, 0.012, 0.0), (0, 0, 1), 0.075,
                            0.255, 40, 12, 0.005, 'feet', M['boot'], thick=0.005, bevel=0.002, R=0.2))
for o in shafts:
    add_mod(o, 'SUBSURF', levels=1, render_levels=1)
boot_bvh = bvh_of([boots] + shafts)


def hull2d(pts):
    pts = sorted(set(pts))
    if len(pts) < 3:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0:
            up.pop()
        up.append(p)
    return lo[:-1] + up[:-1]


for sx in SIDES:
    foot = [v.co for v in bb.verts if v.co.z < 0.045 and v.co.x * sx > 0]
    h = hull2d([(round(p.x, 4), round(p.y, 4)) for p in foot])
    cx = sum(p[0] for p in h) / len(h); cy = sum(p[1] for p in h) / len(h)
    sm = bmesh.new()
    ring0 = []; ring1 = []
    for x, y in h:
        d = Vector((x - cx, y - cy, 0))
        q = Vector((x, y, 0)) + d.normalized() * 0.008
        ring0.append(sm.verts.new((q.x, q.y, 0.0)))
        ring1.append(sm.verts.new((q.x, q.y, 0.034 + 0.008 * max(0.0, (q.y - cy) / 0.12))))
    sm.faces.new(ring0[::-1])
    sm.faces.new(ring1)
    n = len(ring0)
    for i in range(n):
        sm.faces.new([ring0[i], ring0[(i + 1) % n], ring1[(i + 1) % n], ring1[i]])
    sole = obj_from_bm('Sole_%s' % ('L' if sx > 0 else 'R'), sm, 'feet', M['sole'])
    sm.free()
    add_mod(sole, 'BEVEL', width=0.004, segments=3, limit_method='ANGLE', angle_limit=math.radians(35))
    add_mod(sole, 'WEIGHTED_NORMAL', keep_sharp=True)
    # laces: crisscross over the instep between eyelet pairs
    lines = []
    eyes = []
    fx = cx
    for k in range(10):
        z = 0.08 + k * 0.0175
        rd = Vector((0, 1, max(0.0, -0.3 + k * 0.05))).normalized()
        hit, nrm, _, _ = boot_bvh.ray_cast(Vector((fx + sx * 0.004, -0.35, z)) - rd * 0.3, rd, 1.0)
        if hit is None:
            continue
        tng = Vector((1, 0, 0))
        eyes.append((hit + nrm * 0.004 - tng * 0.015, hit + nrm * 0.004 + tng * 0.015, nrm))
    for k in range(len(eyes) - 1):
        a, b, n0 = eyes[k]
        c2, d2, n1 = eyes[k + 1]
        lift = (n0 + n1).normalized() * 0.0025
        lines.append([a, (a + d2) * 0.5 + lift, d2])
        lines.append([b, (b + c2) * 0.5 + lift * 1.6, c2])
    a, b, n0 = eyes[-1]
    lines.append([a, (a + b) * 0.5 + n0 * 0.004, b])
    lines.append([(a + b) * 0.5 + n0 * 0.004, (a + b) * 0.5 + n0 * 0.006 + Vector((0.01 * sx, -0.012, -0.03)),
                  (a + b) * 0.5 + n0 * 0.004 + Vector((0.016 * sx, -0.01, -0.055))])
    tubes('Laces_%s' % ('L' if sx > 0 else 'R'), lines, 0.0018, 'feet', M['lace'])
    tubes('Eyelets_%s' % ('L' if sx > 0 else 'R'), [[e[0] - e[2] * 0.002, e[0] + e[2] * 0.001] for e in eyes] +
          [[e[1] - e[2] * 0.002, e[1] + e[2] * 0.001] for e in eyes], 0.0032, 'feet', M['metal'])
    # padded boot collar
    ring_band(boot_bvh, 'BootCollar_%s' % ('L' if sx > 0 else 'R'), (sx * 0.165, 0.012, 0.0),
              (0, 0, 1), 0.24, 0.262, 32, 2, 0.003, 'feet', M['boot'], thick=0.009, bevel=0.003, R=0.12)
bb.free()

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


def side_item(name, ang, z, size, mat, bvh, lift=0.0, cname='vest', bev=0.008, subd=1, R=0.27):
    d = Vector((math.sin(ang), -math.cos(ang), 0))
    hit, n, _, _ = bvh.ray_cast(Vector((0, 0.0, z)) + d * R, -d, R)
    if hit is None:
        hit, n = Vector((0, 0, z)) + d * 0.18, d
    o = rbox(name, size, cname=cname, mat=mat, bevel=bev, segs=3, subd=subd)
    orient(o, hit + n * (size[1] / 2 + lift), n)
    return o, hit, n


side_item('Belt_PouchUtil', -2.0, 0.955, (0.11, 0.055, 0.12), M['gear'], belt_bvh)
side_item('Belt_PouchCanteen', 2.15, 0.95, (0.09, 0.07, 0.15), M['gear'], belt_bvh)
side_item('Belt_PouchSmall', 1.15, 0.965, (0.07, 0.04, 0.09), M['gear'], belt_bvh)

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
    c = Vector((sx * 0.105, -0.01, 1.33))
    pts, nrm = [], []
    for k in range(25):
        b = -0.05 + (math.pi + 0.1) * k / 24
        d = Vector((0, -math.cos(b), math.sin(b)))
        hit, n = surface_frame(vest_bvh, c + d * 0.5, -d)
        pts.append(hit + d * 0.008)
        nrm.append(d)
    for _ in range(4):  # relax the path so the pad bridges small bumps instead of following them
        pts = [pts[0]] + [max(((pts[i - 1] + pts[i + 1]) * 0.5, pts[i]), key=lambda q: (q - c).length) for i in range(1, len(pts) - 1)] + [pts[-1]]
    strap_along('Vest_ShoulderPad_' + s, pts, nrm, 0.068, 0.014, 'vest', M['gear_pad'])
    strap_along('Vest_ShoulderStrap_' + s, [p + n * 0.014 for p, n in zip(pts, nrm)], nrm, 0.03, 0.003, 'vest', M['webbing'])
vest_bvh = bvh_of([FP, BP, shirt, pants, body] + [o for o in bpy.data.collections['vest'].objects if o.name.startswith('Vest_Shoulder')])
# MOLLE rows on the back plate
for k in range(6):
    zz = 1.13 + k * 0.038
    project_sheet(vest_bvh, 'Vest_MolleB%d' % k, (0, 0.4, zz), (-1, 0, 0), (0, 0, 1), (0, -1, 0), 0.118, 0.0125, 16, 1,
                  0.002, 'vest', M['webbing'], thick=0.0022, round_n=30)
# drag handle
hit, n = surface_frame(vest_bvh, (0, 0.4, 1.405), (0, -1, 0))
tube_along('Vest_DragHandle', [hit + Vector((-0.04, 0, 0)), hit + n * 0.02 + Vector((-0.03, 0, 0.01)),
                               hit + n * 0.025 + Vector((0.03, 0, 0.01)), hit + Vector((0.04, 0, 0))], 0.006, 'vest', M['webbing'])

# front: triple mag pouch with magazines, bungees and pull tabs
for i, x in enumerate((-0.078, 0.0, 0.078)):
    hit, n = surface_frame(vest_bvh, (x, -0.4, 1.135), (0, 1, 0))
    p = rbox('Vest_MagPouch%d' % i, (0.072, 0.04, 0.15), cname='vest', mat=M['gear'], bevel=0.009, segs=3, subd=1)
    orient(p, hit + n * 0.022, n)
    # magazine stored floor-plate up, the top 3 cm showing
    mg = extrude_profile('Vest_Mag%d' % i, [(0.75 * (x2 + 0.12), -0.8 * z) for x2, z in mag_profile(0.0)], 0.024, 'vest',
                         M['mag'], bevel=0.0025, segs=2)
    mg.parent = p
    mg.location = (0, 0, -0.083)
    base = rbox('Vest_MagBase%d' % i, (0.058, 0.03, 0.01), (0.0, 0, 0.0), cname='vest', mat=M['mag'], bevel=0.003)
    base.parent = p
    base.location = (0.004, 0, 0.1)
    bung = tube_along('Vest_Bungee%d' % i, [(-0.03, -0.021, 0.05), (-0.026, -0.019, 0.095), (0.0, -0.006, 0.106),
                                             (0.026, -0.019, 0.095), (0.03, -0.021, 0.05)], 0.0035, 'vest', M['rubber'])
    bung.parent = p
    tab = rbox('Vest_PullTab%d' % i, (0.016, 0.006, 0.026), (0, -0.004, 0.118), cname='vest', mat=M['webbing'], bevel=0.0015)
    tab.parent = p
    # pouch MOLLE strap
    st = rbox('Vest_PouchStrap%d' % i, (0.075, 0.004, 0.025), (0, -0.0205, -0.02), cname='vest', mat=M['webbing'], bevel=0.001)
    st.parent = p
# admin pouch (velcro ID panel, no insignia) above the mags
hit, n = surface_frame(vest_bvh, (0, -0.4, 1.285), (0, 1, 0))
ad = rbox('Vest_AdminPouch', (0.18, 0.028, 0.105), cname='vest', mat=M['gear'], bevel=0.008, segs=3, subd=1)
orient(ad, hit + n * 0.016, n)
for nm, sz, loc, mat in (('Vest_AdminFlap', (0.172, 0.01, 0.04), (0, -0.016, 0.035), M['gear']),
                         ('Vest_AdminVelcro', (0.11, 0.004, 0.05), (0, -0.016, -0.018), M['velcro'])):
    o = rbox(nm, sz, loc, cname='vest', mat=mat, bevel=0.003)
    o.parent = ad
# radio pouch + radio + antenna on the left side, IFAK on the right
rp, rhit, rn = side_item('Vest_RadioPouch', 1.62, 1.13, (0.075, 0.045, 0.12), M['gear'], vest_bvh, lift=0.014)
radio = rbox('Vest_Radio', (0.062, 0.036, 0.13), (0, 0, 0.035), cname='vest', mat=M['polymer'], bevel=0.005)
radio.parent = rp
knob = cyl('Vest_RadioKnob', 0.008, 0.014, (0.015, 0, 0.107), (0, 0, 0), 'vest', M['polymer'], 16, 0.001)
knob.parent = rp
bpy.context.view_layer.update()
atop = rp.matrix_world @ Vector((-0.015, 0, 0.105))
tube_along('Vest_Antenna', smooth_curve([atop, atop + Vector((0.005, 0.02, 0.08)), Vector((0.2, 0.09, 1.42)),
                                          Vector((0.205, 0.11, 1.56)), Vector((0.2, 0.125, 1.66))], 4), 0.0035, 'vest', M['rubber'])
tube_along('Vest_PTTCable', smooth_curve([rp.matrix_world @ Vector((0.0, 0, 0.1)), Vector((0.19, -0.05, 1.33)),
                                           Vector((0.135, -0.165, 1.39)), Vector((0.12, -0.19, 1.30)),
                                           Vector((0.105, -0.205, 1.33))], 4), 0.0028, 'vest', M['rubber'])
ptt = rbox('Vest_PTT', (0.04, 0.02, 0.05), cname='vest', mat=M['polymer'], bevel=0.004)
hit, n = surface_frame(vest_bvh, (0.1, -0.4, 1.33), (0, 1, 0))
orient(ptt, hit + n * 0.012, n)
side_item('Vest_IFAK', -1.6, 1.13, (0.11, 0.06, 0.12), M['gear'], vest_bvh, lift=0.014)
# tourniquet on the right shoulder pad
hit, n = surface_frame(vest_bvh, (-0.105, -0.4, 1.4), (0, 1, 0))
tq = rbox('Vest_Tourniquet', (0.03, 0.025, 0.09), cname='vest', mat=M['polymer'], bevel=0.006)
orient(tq, hit + n * 0.014, n)

# zip-on back pack
hit, n = surface_frame(vest_bvh, (0, 0.5, 1.22), (0, -1, 0))
pack = rbox('Pack', (0.27, 0.11, 0.36), cname='vest', mat=M['gear'], bevel=0.03, segs=4, subd=1)
orient(pack, hit + n * 0.06, n)
for nm, sz, loc in (('Pack_Pocket', (0.2, 0.05, 0.16), (0, -0.065, -0.07)),
                    ('Pack_TopPocket', (0.18, 0.04, 0.06), (0, -0.05, 0.13))):
    o = rbox(nm, sz, loc, cname='vest', mat=M['gear'], bevel=0.015, segs=3, subd=1)
    o.parent = pack
for k in range(3):
    o = rbox('Pack_Molle%d' % k, (0.18, 0.004, 0.025), (0, -0.091, -0.04 - k * 0.038), cname='vest', mat=M['webbing'], bevel=0.0008)
    o.parent = pack
for sx in SIDES:
    o = rbox('Pack_Compress_%d' % sx, (0.022, 0.12, 0.004), (sx * 0.136, 0.0, 0.06), cname='vest', mat=M['webbing'], bevel=0.0008)
    o.rotation_euler = (0, math.pi / 2, 0)
    o.parent = pack
    o = rbox('Pack_Compress2_%d' % sx, (0.022, 0.12, 0.004), (sx * 0.136, 0.0, -0.08), cname='vest', mat=M['webbing'], bevel=0.0008)
    o.rotation_euler = (0, math.pi / 2, 0)
    o.parent = pack
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
# cover: bigger, lumpier rest shape, elastic band pinned near the rim, skirt falls over the edge
cover = helmet_shell('Helmet_Mitznefet', RX + 0.006, RY + 0.006, RZ + 0.006, 0.034, 'helmet', M['camo'], segs=96, rings=48)
# puffy lumps + creases on the dome, a flared ruffled skirt below the elastic band
for v in cover.data.vertices:
    p = v.co.copy()
    d = p - HC
    dn = d.normalized()
    h = p.z - rim_z(p)
    ang = math.atan2(d.x, -d.y)
    lump = 0.5 + 0.3 * noise.noise(p * 11.0) + 0.25 * noise.noise(p * 24.0 + Vector((7, 2, 5)))
    crease = (1.0 - abs(noise.noise(p * 30.0 + Vector((3, 1, 2))))) ** 3 + 0.6 * (1.0 - abs(noise.noise(p * 52.0))) ** 3
    out = 0.004 + 0.016 * max(0.0, lump) ** 2 + 0.007 * crease
    out *= min(1.0, max(0.0, (h - 0.012) / 0.03)) * 0.85 + 0.15
    if h < 0.004:  # skirt: flare out and ruffle
        s = (0.004 - h) / 0.038
        rad = Vector((d.x, d.y, 0)).normalized()
        v.co = p + rad * (s * 0.018 + 0.008 * math.sin(ang * 15 + 3 * noise.noise(p * 20)) * s) + Vector((0, 0, -0.008 * s))
    else:
        v.co = p + dn * out
# (a cloth pass over these lumps blew up under self-collision; the displaced shape is kept as is)
add_mod(cover, 'SUBSURF', levels=1, render_levels=2)
add_mod(cover, 'SOLIDIFY', thickness=0.0025, offset=-1.0)
shade_smooth(cover)
helm_bvh = bvh_of([cover, shell])
# elastic band around the cover
band = []
for k in range(72):
    a = 2 * math.pi * k / 72
    dd = Vector((math.sin(a), -math.cos(a), 0))
    q0 = HC + Vector((RX * dd.x, RY * dd.y, 0))
    z = rim_z(q0) + 0.009
    hit, n, _, _ = helm_bvh.ray_cast(Vector((HC.x, HC.y, z)) + dd * 0.3, -dd, 0.3)
    if hit is not None:
        band.append(hit + n * 0.0015)
band.append(band[0])
tubes('Helmet_Band', [band], 0.0032, 'helmet', M['webbing'])
# NVG shroud poking through the cover at the front
hit, n = surface_frame(helm_bvh, (0, -0.4, 1.745), (0, 1, 0))
nvg = rbox('Helmet_NVGShroud', (0.055, 0.016, 0.042), cname='helmet', mat=M['metal'], bevel=0.004)
orient(nvg, hit + n * 0.004, n)
mnt = rbox('Helmet_NVGMount', (0.03, 0.022, 0.03), (0, -0.016, -0.004), cname='helmet', mat=M['polymer'], bevel=0.004)
mnt.parent = nvg
# headset ear cups + arms + mic boom
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

# ballistic glasses: smooth wrap lens bridged over the face, frame on top, temples to the cups
face_bvh = bvh_of([body, gaiter])
lens = project_sheet(face_bvh, 'Glasses_Lens', (0, -0.3, 1.682), (1, 0, 0), (0, 0, 1), (0, 1, 0), 0.072, 0.0215, 24, 6,
                     0.016, 'head', M['lens'], thick=0.0018, round_n=3.2, smooth_iter=14)
frame = project_sheet(face_bvh, 'Glasses_Frame', (0, -0.3, 1.7035), (1, 0, 0), (0, 0, 1), (0, 1, 0), 0.074, 0.004, 24, 1,
                      0.0185, 'head', M['polymer'], thick=0.005, round_n=8, smooth_iter=14)
for sx in SIDES:
    tube_along('Glasses_Temple_%d' % sx, [(sx * 0.073, -0.12, 1.69), (sx * 0.095, -0.085, 1.69), (sx * 0.1, -0.06, 1.685)],
               0.0022, 'head', M['polymer'])

# ---------------------------------------------------------------- rifle on a sling (hangs in front of the right thigh)
rifle = build_rifle(M)
mz = Vector((0.16, -0.08, -0.98)).normalized()
yt = Vector((0, -1, 0))
ry = (yt - mz * yt.dot(mz)).normalized()
rz = mz.cross(ry)
m = Matrix((mz, ry, rz)).transposed().to_4x4()
m.translation = Vector((-0.235, -0.19, 0.87))
rifle.matrix_world = m
bpy.context.view_layer.update()
rear = rifle.matrix_world @ Vector((-0.305, 0.035, 0.025))
frontp = rifle.matrix_world @ Vector((0.19, 0.035, -0.025))
sling_bvh = bvh_of([o for o in bpy.data.collections['vest'].objects if o.type == 'MESH'] + [shirt, pants, body])
# front run: rear sling point -> across the chest -> over the left shoulder; back run: down to the right hip
path = []
for k in range(12):
    t = k / 11
    q = rear.lerp(Vector((-0.125, -0.2, 1.44)), t)
    path.append((q, (0, 1, 0)))
for k in range(9):
    b = 0.2 + (math.pi - 0.4) * k / 8
    d = Vector((0, -math.cos(b), math.sin(b)))
    path.append((Vector((-0.125, -0.01, 1.33)) + d * 0.5, -d))
for k in range(10):
    t = (k + 1) / 10
    q = Vector((-0.125, 0.2, 1.42)).lerp(Vector((-0.2, 0.17, 1.0)), t)
    path.append((q, (0, -1, 0)))
for k in range(8):
    a = -2.4 + (2.4 - 1.25) * (k + 1) / 8
    d = Vector((math.sin(a), -math.cos(a), 0))
    path.append((Vector((0, 0, 0.99 - 0.06 * k / 7)) + d * -0.3, -d))
pts, outs = [], []
for q, dr in path:
    dr = Vector(dr).normalized()
    hit, n = surface_frame(sling_bvh, q, dr)
    pts.append(hit - dr * 0.01)
    outs.append(-dr)
pts[0] = rear
pts.append(frontp + Vector((-0.02, -0.01, 0.06)))
outs.append(outs[-1])
pts.append(frontp)
outs.append(outs[-1])
# a taut strap: straighten wherever that lifts it off the gear, never push it into it
for _ in range(40):
    for i in range(1, len(pts) - 1):
        cand = (pts[i - 1] + pts[i + 1]) * 0.5
        if cand.dot(outs[i]) > pts[i].dot(outs[i]):
            pts[i] = cand
pts = smooth_curve(pts, 2)
nrm2 = []
for p in pts:
    hit, n, _, _ = sling_bvh.find_nearest(p)
    nrm2.append((p - hit).normalized() if hit is not None and (p - hit).length > 1e-4 else Vector((0, -1, 0)))
strap_along('Rifle_Sling', pts, nrm2, 0.032, 0.0028, 'rifle', M['sling'])

skin_bm.free()
for o in bpy.data.objects:
    if o.type == 'MESH':
        for p in o.data.polygons:
            p.use_smooth = True
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(WORK, 'stage2.blend'))
print('STAGE2_OK', round(time.time() - t0, 1), 's')
