"""
Iron Front - BI2 hero soldier, stage 2b: low-ready pose with the rifle in both hands (Blender 5.2.2 LTS).

  nice /opt/blender/blender -b --factory-startup -P web/tools/blender/hero/stage2b_pose.py

Loads $HERO_WORK/stage2.blend (A-pose, fully dressed), adds a small arm rig (torso, upper arm,
forearm, hand, and a 3-bone chain for each finger and the thumb), binds the body with bone-heat weights and
copies those weights to everything that rides on the arms (sleeves, cuffs, patches, gloves).
The Tavor is placed at low ready (butt at the right shoulder pocket, muzzle down to the front-left);
IK (with a little stretch) puts the wrists on the grip and the hand guard, the hands are turned to
wrap the grip and the fingers are curled. The sling is re-routed from the rifle over the right
shoulder. Saves $HERO_WORK/stage2_posed.blend.
"""
import sys, os, math, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy, bmesh
from mathutils import Vector, Matrix, noise
from mathutils.kdtree import KDTree
from hero_lib import *
from hero_rifle import build_rifle

t0 = time.time()
bpy.ops.wm.open_mainfile(filepath=os.path.join(WORK, 'stage2.blend'))
M = {m.name: m for m in bpy.data.materials}
body = bpy.data.objects['Body']
SIDES = (1.0, -1.0)

# ---------------------------------------------------------------- finger chains from the A-pose hand skin
_bw = body.matrix_world
_hand_pts = [_bw @ v.co for v in body.data.vertices if is_hand(_bw @ v.co)]


def finger_chains(sx):
    W, fd, palm, lat = hand_frame(sx)
    pts = [p for p in _hand_pts if p.x * sx > 0]

    def slice_c(a, lo, hi, w=0.006):
        sel = [p for p in pts if abs((p - W).dot(fd) - a) < w and lo <= (p - W).dot(lat) < hi]
        if not sel:
            return W + fd * a + lat * ((lo + hi) / 2)
        return sum(sel, Vector()) / len(sel)
    out = {}
    for fname, ((lo, hi), mcp) in FINGERS.items():
        sel = [p for p in pts if lo <= (p - W).dot(lat) < hi and (p - W).dot(fd) > mcp]
        tip = max((p - W).dot(fd) for p in sel) - 0.004
        L = tip - mcp
        out[fname] = [slice_c(mcp, lo, hi), slice_c(mcp + 0.45 * L, lo, hi), slice_c(mcp + 0.76 * L, lo, hi),
                      slice_c(tip, lo, hi, 0.004)]
    # thumb: from its root at the base of the palm out to the tip
    th = [p for p in pts if (p - W).dot(lat) < -0.058 and (p - W).dot(fd) > 0.1]
    tip = max(th, key=lambda p: (p - W).dot(fd))
    base = W + Vector((0.0, -0.045, -0.03))
    chain = [base]
    for f in (0.42, 0.74):
        q = base.lerp(tip, f)
        near = [p for p in pts if (p - q).length < 0.013 and (p - W).dot(lat) < -0.04]
        chain.append(sum(near, Vector()) / len(near) if near else q)
    chain.append(tip.lerp(chain[-1], 0.08))
    out['thumb'] = chain
    return out


# ---------------------------------------------------------------- rig (rest = the A-pose of the base mesh)
arm_data = bpy.data.armatures.new('Rig')
rig = bpy.data.objects.new('Rig', arm_data)
coll('torso').objects.link(rig)
bpy.context.view_layer.objects.active = rig
for o in bpy.context.view_layer.objects:
    o.select_set(False)
rig.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
eb = arm_data.edit_bones
tor = eb.new('torso')
tor.head = (0, 0, 0.95)
tor.tail = (0, 0, 1.45)
J = {}
for sx in SIDES:
    s = 'L' if sx > 0 else 'R'
    S = Vector((sx * 0.185, -0.005, 1.425))
    E = Vector((sx * 0.306, 0.0, 1.175))
    W = Vector((sx * 0.396, -0.063, 0.958))
    hd = (W - E).normalized()
    K = W + Vector((sx * 0.02, -0.035, -0.088))
    palm = Vector((-sx, 0, 0))
    u = eb.new('upper_arm.' + s); u.head = S; u.tail = E; u.parent = tor
    f = eb.new('forearm.' + s); f.head = E; f.tail = W; f.parent = u; f.use_connect = True
    h = eb.new('hand.' + s); h.head = W; h.tail = K; h.parent = f; h.use_connect = True
    h.align_roll(palm)
    # separate fingers (r17): a 3-bone chain per finger and the thumb, joints at the centroids of the finger's
    # skin slices, so each chain runs down the middle of its finger
    for fname, chain in finger_chains(sx).items():
        prev = h
        for i in range(3):
            b = eb.new('%s%d.%s' % (fname, i + 1, s))
            b.head = chain[i]
            b.tail = chain[i + 1]
            b.parent = prev
            b.use_connect = i > 0
            b.align_roll(palm)
            prev = b
    for b in (u, f):
        b.align_roll(Vector((0, 1, 0)))
bpy.ops.object.mode_set(mode='OBJECT')

# bone-heat weights on the body
for o in bpy.context.view_layer.objects:
    o.select_set(False)
body.select_set(True)
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.parent_set(type='ARMATURE_AUTO')
for m_ in body.modifiers:
    if m_.type == 'ARMATURE':
        m_.use_deform_preserve_volume = False
# heat weights leak from the hands into the thighs they touch in the A-pose: only arm skin may follow arm bones
bw = body.matrix_world
tg = body.vertex_groups['torso']
armg = [g for g in body.vertex_groups if g.name != 'torso']
for v in body.data.vertices:
    p = bw @ v.co
    if not (is_hand(p) or (is_arm(p) and arm_t(p)[1] < 0.13)) and (p.z < 1.0 or abs(p.x) < 0.09):
        for g in armg:
            g.remove([v.index])
        tg.add([v.index], 1.0, 'REPLACE')
# shoulder-to-wrist skin: smooth geometric weights along the arm axis instead of bone heat (heat weights
# spread into the chest and trapezius, and those bulge when the arm swings forward); hands keep heat weights
def sstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


for v in body.data.vertices:
    p = bw @ v.co
    if p.z < 0.85 or abs(p.x) < 0.1:
        continue
    t, rad = arm_t(p)
    if t > WRIST_T + 0.01 or rad > 0.13:
        continue
    s_ = 'L' if p.x > 0 else 'R'
    a = sstep(-0.01, 0.07, t) * sstep(0.13, 0.19, abs(p.x))
    f = sstep(0.24, 0.30, t)
    hnd = sstep(WRIST_T - 0.02, WRIST_T + 0.01, t)
    for g in armg:
        g.remove([v.index])
    tg.add([v.index], 1.0 - a, 'REPLACE')
    for gname, w in (('upper_arm.', a * (1 - f)), ('forearm.', a * f * (1 - hnd)), ('hand.', a * f * hnd)):
        if w > 0.001:
            body.vertex_groups[gname + s_].add([v.index], w, 'REPLACE')
# arm skin the heat solver left (partly) unweighted: bind it rigidly to the nearest bone segment
segs = [(b.name, b.head_local.copy(), b.tail_local.copy()) for b in arm_data.bones if b.name != 'torso']


def seg_d(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return (a + ab * t - p).length


nfix = 0
for v in body.data.vertices:
    tot = sum(g.weight for g in v.groups if body.vertex_groups[g.group].name != 'visible')
    if tot < 0.5:
        p = bw @ v.co
        best = min(segs, key=lambda sg: seg_d(p, sg[1], sg[2]))
        body.vertex_groups[best[0]].add([v.index], 1.0, 'REPLACE')
        nfix += 1
print('unweighted body verts fixed', nfix)
# only the head and neck of the body are ever visible (everything else is clothed): mask the rest so
# no skin can poke through the posed sleeves
vis = body.vertex_groups.new(name='visible')
for v in body.data.vertices:
    p = bw @ v.co
    # no gaiter (r10): the neck inside the collar band and the small V of skin at the open throat show too
    throat = (abs(p.x) < 0.075 and neck_cut(p) - 0.012 < p.z < 1.53) or (p.y < -0.03 and abs(p.x) < 0.03 and 1.415 < p.z < 1.53)
    if (p.z > 1.52 and abs(p.x) < 0.085) or throat:
        # the neck flares into the trapezius right where the shoulder pads meet the collar: keep that
        # skin masked so it can never show between collar and pad
        if p.z > 1.525 + 0.6 * max(0.0, abs(p.x) - 0.055) or throat:
            vis.add([v.index], 1.0, 'REPLACE')
        for g in armg:  # the visible neck / head never follows the arms
            g.remove([v.index])
        tg.add([v.index], 1.0, 'REPLACE')
mk = body.modifiers.new('Mask', 'MASK')
mk.vertex_group = 'visible'

# copy the body weights to everything that rides on the arms (nearest body vertex)
# two trees, so a sleeve vertex never picks up the hip it hangs next to in the A-pose (and vice versa)
def limb(p):
    # near the arm axis only: hip / waist fabric beside the hanging A-pose forearm stays on the torso
    return is_hand(p) or (is_arm(p) and arm_t(p)[1] < 0.13)


lv = [v for v in body.data.vertices if limb(bw @ v.co)]
tv = [v for v in body.data.vertices if not limb(bw @ v.co)]
kds = []
for vs in (lv, tv):
    k = KDTree(len(vs))
    for v in vs:
        k.insert(bw @ v.co, v.index)
    k.balance()
    kds.append(k)
kd_all = KDTree(len(body.data.vertices))
for v in body.data.vertices:
    kd_all.insert(bw @ v.co, v.index)
kd_all.balance()
gnames = [g.name for g in body.vertex_groups if g.name != 'visible']
vw = [dict() for _ in body.data.vertices]
for v in body.data.vertices:
    for g in v.groups:
        if g.weight > 0.001:
            nm_ = body.vertex_groups[g.group].name
            if nm_ != 'visible':
                vw[v.index][nm_] = g.weight
riders = ['Shirt', 'Cuff_L', 'Cuff_R', 'Cuff_Tab_L', 'Cuff_Tab_R', 'Patch_Flag_IL', 'Patch_Velcro', 'Gloves', 'Glove_Strap_L', 'Glove_Strap_R',
          'Glove_Palm_L', 'Glove_Palm_R',
          'Glove_Knuckle_L', 'Glove_Knuckle_R', 'Sleeve_Pocket', 'Sleeve_PocketFlap', 'Sleeve_Roll_L', 'Sleeve_Roll_R']
riders += [o.name for o in bpy.data.objects if o.name.startswith(('Patch_', 'Glove_')) and o.name not in riders]
for nm in riders:
    o = bpy.data.objects.get(nm)
    if o is None:
        continue
    mw = o.matrix_world
    groups = {n: o.vertex_groups.new(name=n) for n in gnames}
    for v in o.data.vertices:
        acc = {}
        tot = 0.0
        pw = mw @ v.co
        # wrist riders (and the sleeve ends) take their weights from arm skin only: in the A-pose the hanging
        # wrist touches the hip, and torso weights left those vertices behind when the hand moved to the rifle
        wrist = nm.startswith(('Cuff', 'Glove')) or (nm == 'Shirt' and limb(pw) and arm_t(pw)[0] > WRIST_T - 0.12)
        for (co, idx, d) in (kds[0] if wrist else kd_all).find_n(pw, 3):
            w = 1.0 / (d + 1e-4)
            tot += w
            for n, x in vw[idx].items():
                acc[n] = acc.get(n, 0.0) + x * w
        if not nm.startswith('Glove'):  # sleeves and cuffs end at the wrist: hand / finger weights go to the forearm
            for n in list(acc.keys()):
                if n.startswith(('hand.',) + FINGER_NAMES):
                    fa = 'forearm.' + n.split('.')[-1]
                    acc[fa] = acc.get(fa, 0.0) + acc.pop(n)
        if nm.startswith('Glove_'):  # wrist strap / pads: rigid on the hand (a wrist blend crumples the thin band)
            acc = {'hand.' + nm[-1]: 1.0}
            tot = 1.0
        for n, x in acc.items():
            if x / tot > 0.002:
                groups[n].add([v.index], x / tot, 'REPLACE')
    if nm == 'Shirt':  # blur the weights over the garment so the shoulder bends instead of tearing
        me = o.data
        nb = [[] for _ in me.vertices]
        for e in me.edges:
            a, b = e.vertices
            nb[a].append(b)
            nb[b].append(a)
        W = {g.name: [0.0] * len(me.vertices) for g in o.vertex_groups}
        for v in me.vertices:
            for g in v.groups:
                W[o.vertex_groups[g.group].name][v.index] = g.weight
        for gname, w in W.items():
            if max(w) == 0.0:
                continue
            for _ in range(4):
                w = [0.5 * w[i] + 0.5 * (sum(w[j] for j in nb[i]) / len(nb[i]) if nb[i] else w[i]) for i in range(len(w))]
            grp = o.vertex_groups[gname]
            for i, x in enumerate(w):
                if x > 0.002:
                    grp.add([i], x, 'REPLACE')
                else:
                    grp.remove([i])
        # the forearm half of the sleeve is a tube on the forearm: fade out the torso weight that reached the
        # sleeve end (it dragged hem vertices back toward the hip in a long spike beside the support hand)
        tgo = o.vertex_groups['torso']
        for v in me.vertices:
            p = mw @ v.co
            if not (abs(p.x) > 0.25 and limb(p)):
                continue
            k = sstep(WRIST_T - 0.22, WRIST_T - 0.12, arm_t(p)[0])
            for g in v.groups:
                if g.group == tgo.index and k > 0:
                    x = g.weight * (1 - k)
                    if x > 0.002:
                        tgo.add([v.index], x, 'REPLACE')
                    else:
                        tgo.remove([v.index])
                    break
    md = o.modifiers.new('Armature', 'ARMATURE')
    md.object = rig
    md.use_deform_preserve_volume = nm.startswith('Glove')
    # deform first, then subdivide / thicken
    o.modifiers.move(len(o.modifiers) - 1, 0)
    o.parent = rig
    o.matrix_parent_inverse = rig.matrix_world.inverted()

# ---------------------------------------------------------------- rifle at low ready
rifle = build_rifle(M)
mz = Vector((0.45, -0.39, -0.8)).normalized()
rz = (Vector((0, 0, 1)) - mz * mz.z).normalized()
ry = rz.cross(mz)
butt = Vector((-0.15, -0.205, 1.34))
O = butt + mz * 0.335 + rz * 0.03
m = Matrix((mz, ry, rz)).transposed().to_4x4()
m.translation = O
rifle.matrix_world = m
R3 = m.to_3x3()


def rw(p):
    return O + R3 @ Vector(p)


def frame(dir_w, palm_w):
    y = dir_w.normalized()
    z = (palm_w - y * palm_w.dot(y)).normalized()
    x = y.cross(z)
    return Matrix((x, y, z)).transposed()


# hand targets in rifle space: right fist round the pistol grip; the support hand wraps the front of the big
# trigger guard like a vertical fore grip (palm on its left side, thumb up under the hand guard, fingers round
# the front). It used to sit inside the guard, on top of the right hand's fingers, bent ~75 degrees at the wrist.
grips = {
    # per-finger curl (MCP, PIP, DIP) in radians; the right index lies straight along the frame (trigger discipline)
    'R': dict(kn=(0.02, -0.03, -0.098), dir=(0.95, 0.25, -0.15), palm=(0.0, 1.0, 0.1),
              curl=dict(index=(0.1, 0.12, 0.08), middle=(1.35, 1.3, 0.95), ring=(1.4, 1.3, 1.0), pinky=(1.45, 1.3, 1.0),
                        thumb=(0.35, 0.45, 0.35)),
              pole=((-0.45, 0.2, 0.7), 90)),
    'L': dict(kn=(0.118, 0.035, -0.06), dir=(0.85, -0.45, 0.0), palm=(0.15, -1.0, 0.1),
              curl=dict(index=(1.25, 1.2, 0.9), middle=(1.3, 1.25, 0.95), ring=(1.35, 1.25, 0.95), pinky=(1.4, 1.25, 0.95),
                        thumb=(0.25, 0.3, 0.25)),
              pole=((0.55, 0.05, 1.0), 0)),
}
# poles: elbows down beside the ribs, with the forearm roll matching the grip so the wrist barely twists (the
# old shared pole flipped the right forearm ~157 degrees against the hand and candy-wrapped glove, strap,
# cuff and sleeve end)
pb = rig.pose.bones
for s, g in grips.items():
    dw = (R3 @ Vector(g['dir'])).normalized()
    pw = (R3 @ Vector(g['palm'])).normalized()
    hl = (arm_data.bones['hand.' + s].tail_local - arm_data.bones['hand.' + s].head_local).length
    wrist = rw(g['kn']) - dw * hl
    tgt = bpy.data.objects.new('IK_' + s, None)
    coll('torso').objects.link(tgt)
    tgt.location = wrist
    ori = bpy.data.objects.new('ORI_' + s, None)
    coll('torso').objects.link(ori)
    ori.matrix_world = frame(dw, pw).to_4x4()
    pole = bpy.data.objects.new('POLE_' + s, None)
    coll('torso').objects.link(pole)
    sx = 1 if s == 'L' else -1
    pole.location = g['pole'][0]
    ik = pb['forearm.' + s].constraints.new('IK')
    ik.target = tgt
    ik.pole_target = pole
    ik.pole_angle = math.radians(g['pole'][1])
    ik.chain_count = 2
    ik.use_stretch = True
    for bn in ('upper_arm.' + s, 'forearm.' + s):
        pb[bn].ik_stretch = 0.08
    cr = pb['hand.' + s].constraints.new('COPY_ROTATION')
    cr.target = ori
    for fname, curl in g['curl'].items():
        for i, a in enumerate(curl):
            b = pb['%s%d.%s' % (fname, i + 1, s)]
            b.rotation_mode = 'XYZ'
            b.rotation_euler = (a, 0, (0.3 * sx if (fname == 'thumb' and i == 0) else 0.0))
    print('target', s, tuple(round(c, 3) for c in wrist), 'dist', round((wrist - arm_data.bones['upper_arm.' + s].head_local).length, 3))
bpy.context.view_layer.update()
for s in ('L', 'R'):
    print('reached', s, tuple(round(c, 3) for c in (rig.matrix_world @ pb['hand.' + s].head)))

# ---------------------------------------------------------------- finger fit: wrap each finger round the rifle
# Forward kinematics of the finger chains from the posed hand (no depsgraph per try) and a small grid search
# per finger: no finger segment inside or within its radius of the rifle, middle / tip close to the surface
# (wrapped, in contact). The right index is laid straight along the frame above the trigger guard.
rifle_bvh = bvh_of([o for o in rifle.children_recursive if o.type == 'MESH' and not o.name.startswith('RD_')])
RW = rig.matrix_world
FR = 0.0085  # finger radius (glove)


def chain_points(s, fname, curls, spread=0.0):
    hp = pb['hand.' + s].matrix
    parent_rest = arm_data.bones['hand.' + s].matrix_local
    m = hp
    pts = []
    for i in range(3):
        bn = arm_data.bones['%s%d.%s' % (fname, i + 1, s)]
        rel = parent_rest.inverted() @ bn.matrix_local
        rot = Matrix.Rotation(curls[i], 4, 'X')
        if i == 0 and spread:
            rot = Matrix.Rotation(spread, 4, 'Z') @ rot
        m = m @ rel @ rot
        L = bn.length
        for k in range(4):
            pts.append(RW @ (m @ Vector((0, L * k / 4, 0))))
        parent_rest = bn.matrix_local
    pts.append(RW @ (m @ Vector((0, arm_data.bones['%s3.%s' % (fname, s)].length, 0))))
    return pts


def surf_d(p):
    hit, n, _, d = rifle_bvh.find_nearest(p)
    if hit is None:
        return 1.0
    return d if (p - hit).dot(n) >= 0 else -d


def score(pts, target=None, cc=None, c0=None):
    sc = 0.0
    for p in pts[2:]:
        d = surf_d(p)
        if d < FR:
            sc += (FR - d) ** 2 * 4e4 + (2.0 if d < 0 else 0.0)
    if target is not None:
        sc += (pts[-1] - target).length * 40
    else:
        for p in pts[5:]:  # wrapped: the middle and end segments rest on the rifle
            sc += abs(surf_d(p) - (FR + 0.002)) * 6
    if cc is not None and c0 is not None:  # stay close to a natural grip (no straight fingers lying on the side)
        sc += 0.4 * sum((a - b) ** 2 for a, b in zip(cc, c0))
    return sc


R3i = rifle.matrix_world
for s, g in grips.items():
    for fname, curl in g['curl'].items():
        sp0 = (0.3 if s == 'L' else -0.3) if fname == 'thumb' else 0.0
        best = (score(chain_points(s, fname, curl, sp0)), tuple(curl), sp0)
        if s == 'R' and fname == 'thumb':  # thumb along the right side above the grip (not through the receiver)
            target = R3i @ Vector((-0.012, -0.042, -0.03))
            best = (score(chain_points(s, fname, curl, sp0), target), tuple(curl), sp0)
            for c1 in (-0.4, -0.2, 0.0, 0.2, 0.4):
                for spv in [sp0 + d_ for d_ in (-0.9, -0.6, -0.3, 0.0, 0.3, 0.6, 0.9)]:
                    for c2 in (0.0, 0.2, 0.4):
                        cc = (c1, c2, c2 * 0.7)
                        sc = score(chain_points(s, fname, cc, spv), target)
                        if sc < best[0]:
                            best = (sc, cc, spv)
        elif s == 'R' and fname == 'index':
            target = R3i @ Vector((0.128, -0.036, -0.046))
            best = (score(chain_points(s, fname, curl), target), tuple(curl), 0.0)
            for c1 in (-0.3, -0.15, 0.0, 0.15, 0.3):
                for sp in (-0.5, -0.35, -0.2, 0.0, 0.2, 0.35, 0.5):
                    for c2 in (0.0, 0.12, 0.25):
                        cc = (c1, c2, c2 * 0.6)
                        sc = score(chain_points(s, fname, cc, sp), target)
                        if sc < best[0]:
                            best = (sc, cc, sp)
        else:
            best = (score(chain_points(s, fname, curl, sp0), cc=curl, c0=curl), tuple(curl), sp0)
            c1s = [x * 0.2 for x in range(0, 8)] if fname != 'thumb' else [x * 0.15 - 0.3 for x in range(0, 8)]
            sps = [sp0] if fname != 'thumb' else [sp0 + d_ for d_ in (-0.6, -0.4, -0.2, 0.0, 0.2, 0.4, 0.6)]
            for spv in sps:
                for c1 in c1s:
                    for c2 in (0.2, 0.5, 0.8, 1.1, 1.4):
                        for c3 in (0.2, 0.5, 0.8, 1.1):
                            cc = (c1, c2, c3)
                            sc = score(chain_points(s, fname, cc, spv), cc=cc, c0=curl)
                            if sc < best[0]:
                                best = (sc, cc, spv)
        for i, a in enumerate(best[1]):
            b = pb['%s%d.%s' % (fname, i + 1, s)]
            b.rotation_euler = (a, 0, best[2] if i == 0 else 0.0)
        print('finger', s, fname, 'curl', tuple(round(c, 2) for c in best[1]), 'spread', round(best[2], 2), 'score', round(best[0], 3))
bpy.context.view_layer.update()

# ---------------------------------------------------------------- relax the posed shirt with cloth
# Linear skinning crushes and stretches the sleeves at the shoulders; a short cloth pass that starts
# from the skinned shirt, with spring rest lengths taken from the A-pose garment, pulls the sleeves
# back to their real lengths (torso under the vest, collar and cuffs pinned). No body collider: the
# skinned shoulders of the scan body tear at this pose and would crumple the sleeve.
shirt = bpy.data.objects['Shirt']
shirt.shape_key_add(name='Basis')
rk = shirt.shape_key_add(name='Rest')
pin = shirt.vertex_groups.new(name='pin')
for v in shirt.data.vertices:
    p = v.co
    w = 0.0
    if abs(p.x) < 0.1 and p.z < 1.43:
        w = 1.0
    elif abs(p.x) > 0.25 and arm_t(p)[0] > WRIST_T - 0.22:
        # forearm half of the sleeve stays skinned (a rigid tube on the forearm); only the elbow and upper
        # arm relax. Pinning just the cuff let the sleeve end buckle into a loose flap beside the grip hand.
        w = sstep(WRIST_T - 0.22, WRIST_T - 0.12, arm_t(p)[0])
    elif p.z > neck_cut(p) - 0.03 and abs(p.x) < 0.12:
        w = 1.0
    if w:
        pin.add([v.index], w, 'REPLACE')
hidden = []
for m_ in shirt.modifiers:
    if m_.type in ('SUBSURF', 'SOLIDIFY'):
        m_.show_viewport = False
        hidden.append(m_.type)
shirt_rest = [shirt.matrix_world @ v.co for v in shirt.data.vertices]  # A-pose, for the compression folds
cl = shirt.modifiers.new('cloth', 'CLOTH')
shirt.modifiers.move(shirt.modifiers.find('cloth'), shirt.modifiers.find('Armature') + 1)
cs = cl.settings
cs.quality = 6
cs.mass = 0.25
cs.tension_stiffness = 25
cs.compression_stiffness = 6
cs.shear_stiffness = 5
cs.bending_stiffness = 2.0
cs.vertex_group_mass = 'pin'
cs.rest_shape_key = rk
cs.gravity = (0, 0, -1.5)
cl.collision_settings.distance_min = 0.004
cl.collision_settings.use_self_collision = False
cl.point_cache.frame_start = 1
cl.point_cache.frame_end = 36
scn = bpy.context.scene
scn.frame_start = 1
for f in range(1, 37):
    scn.frame_set(f)
    if f % 8 == 0:
        print('relax frame', f, round(time.time() - t0, 1), 's', flush=True)
shirt = freeze(shirt)


def tuck_under_pads(obj, margin=0.004):
    """the posed shoulders swell into the (static) plate-carrier shoulder pads: push every shirt vertex that
    pokes into or through a pad back under its inner face, with a soft ramp beside the pad edges."""
    dg = bpy.context.evaluated_depsgraph_get()
    rows = []
    for s_ in 'LR':
        pad = bpy.data.objects.get('Vest_ShoulderPad_' + s_)
        if pad is None:
            continue
        pmw = pad.matrix_world
        vs = [pmw @ v.co for v in pad.data.vertices]
        n = len(vs) // 3
        cen = [vs[3 * i + 1] for i in range(n)]
        c0 = Vector((cen[0].x, -0.01, 1.33))
        prow = []
        for i in range(n):
            t = (cen[min(i + 1, n - 1)] - cen[max(i - 1, 0)]).normalized()
            b = vs[3 * i] - vs[3 * i + 2]
            nn = t.cross(b).normalized()
            if nn.dot(cen[i] - c0) < 0:
                nn = -nn
            prow.append([cen[i], t, b.normalized(), nn, b.length / 2, 0.0])
        ev = pad.evaluated_get(dg)
        em = ev.to_mesh()
        kp = KDTree(n)
        for i, c in enumerate(cen):
            kp.insert(c, i)
        kp.balance()
        hin = min((pmw @ v.co - cen[kp.find(pmw @ v.co)[1]]).dot(prow[kp.find(pmw @ v.co)[1]][3]) for v in em.vertices)
        ev.to_mesh_clear()
        for r in prow:
            r[5] = hin
        rows += prow
    kd = KDTree(len(rows))
    for i, r in enumerate(rows):
        kd.insert(r[0], i)
    kd.balance()
    moved = 0
    for v in obj.data.vertices:
        p = obj.matrix_world @ v.co
        _, i, dist = kd.find(p)
        if dist > 0.09:
            continue
        c, t, b, n, hw, hin = rows[i]
        q = p - c
        if abs(q.dot(t)) > 0.02:
            continue
        bb = abs(q.dot(b))
        h = q.dot(n)
        if bb > hw + 0.04 or h < -0.06 or h > 0.05:
            continue
        hmax = hin - margin + max(0.0, bb - hw) * 0.8
        if h > hmax:
            v.co = obj.matrix_world.inverted() @ (p + n * (hmax - h))
            moved += 1
    print('shirt verts tucked under the shoulder pads', moved)


tuck_under_pads(shirt)


def compression_folds(obj, rest):
    """deep, rounded fold rings where the posed sleeve is compressed (inside of the bent elbow, crook of the
    arm): compression = posed / A-pose edge length; the ring phase runs along the A-pose arm axis."""
    me = obj.data
    if len(me.vertices) != len(rest):
        print('compression folds skipped (topology changed)')
        return
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    bm.normal_update()
    mw = obj.matrix_world
    moved = 0
    disp = []
    for v in bm.verts:
        r = rest[v.index]
        if abs(r.x) < 0.17 or r.z < 0.85:
            disp.append(0.0)
            continue
        t, rad = arm_t(r)
        if not (0.12 < t < WRIST_T - 0.07):
            disp.append(0.0)
            continue
        ratios = []
        for e in v.link_edges:
            o = e.other_vert(v)
            l0 = (rest[o.index] - r).length
            if l0 > 1e-6:
                ratios.append((o.co - v.co).length / l0)
        c = max(0.0, min(1.0, (0.97 - sum(ratios) / len(ratios)) / 0.12)) if ratios else 0.0
        if c <= 0:
            disp.append(0.0)
            continue
        n1 = noise.noise(r * 22.0)
        ph = 2 * math.pi * (t + 0.006 * math.sin(r.y * 90 + n1 * 3)) / 0.022 + 2.5 * n1
        sv = math.sin(ph)
        disp.append(0.0075 * c * (sv if sv > 0 else 0.5 * sv))
        moved += 1
    for v, d in zip(bm.verts, disp):
        if d:
            v.co += v.normal * d
    bm.to_mesh(me)
    bm.free()
    print('compression fold verts', moved)


compression_folds(shirt, shirt_rest)
add_mod(shirt, 'SMOOTH', factor=0.5, iterations=4)
add_mod(shirt, 'SUBSURF', levels=1, render_levels=1)
add_mod(shirt, 'SOLIDIFY', thickness=0.0025, offset=-1.0)
scn.frame_set(1)

# ---------------------------------------------------------------- sling: rear point -> over the right shoulder -> back -> front point
bpy.context.view_layer.update()
rear = rifle.matrix_world @ Vector((-0.305, 0.035, 0.025))
frontp = rifle.matrix_world @ Vector((0.19, 0.035, -0.025))
sling_bvh = bvh_of([o for o in bpy.data.collections['vest'].objects if o.type == 'MESH'] +
                   [bpy.data.objects['Shirt'], bpy.data.objects['Pants'], body])
path = []
for k in range(6):
    t = k / 5
    path.append((rear.lerp(Vector((-0.125, -0.2, 1.44)), t), (0, 1, 0)))
for k in range(9):
    b = 0.2 + (math.pi - 0.4) * k / 8
    d = Vector((0, -math.cos(b), math.sin(b)))
    path.append((Vector((-0.125, -0.01, 1.33)) + d * 0.5, -d))
for k in range(10):
    t = (k + 1) / 10
    path.append((Vector((-0.125, 0.2, 1.42)).lerp(Vector((0.1, 0.2, 1.02)), t), (0, -1, 0)))
for k in range(8):
    a = 2.6 - (2.6 - 1.2) * (k + 1) / 8
    d = Vector((math.sin(a), -math.cos(a), 0))
    path.append((Vector((0, 0, 1.0)) - d * 0.3, -d))
pts, outs = [], []
for q, dr in path:
    dr = Vector(dr).normalized()
    hit, n = surface_frame(sling_bvh, q, dr)
    pts.append(hit - dr * 0.01)
    outs.append(-dr)
pts[0] = rear
pts.append(frontp)
outs.append(outs[-1])
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

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(WORK, 'stage2_posed.blend'))
print('STAGE2B_OK', round(time.time() - t0, 1), 's')
