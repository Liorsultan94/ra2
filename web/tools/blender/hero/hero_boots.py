"""
Iron Front - BI2 hero soldier: military boots (Blender 5.2.2 LTS), called from stage2_gear.py.

Each boot is modelled from a boot last, not from the foot skin: a loft of rounded cross sections along the
foot axis (firm raised toe box, ball, waist, heel counter, toe spring, heel lift) unioned with an elliptical
ankle shaft by a voxel remesh, then smoothed. On top: smooth leather toe cap and heel counter (material
slots), stitch seams, a stitched welt, a lugged outsole with a heel block and breast, metal eyelets with
laces crossing neatly up the front and a small bow at the top (short tails that lie on the boot), a padded
collar and the trouser legs bloused over the boot tops.
"""
import math
import bpy, bmesh
from mathutils import Vector, Matrix, noise
from mathutils.bvhtree import BVHTree
from hero_lib import *

Z_TOP = 0.245      # shaft top (the trousers blouse over it)
SOLE_T = 0.026     # outsole + midsole height under the forefoot


def sst(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def foot_frame(skin_bm, sx):
    """heel point, forward / lateral unit vectors and length of the bare foot, and the ankle centre."""
    pts = [v.co.copy() for v in skin_bm.verts if v.co.z < 0.03 and 0.05 < v.co.x * sx < 0.33]
    n = len(pts)
    mx = sum(p.x for p in pts) / n
    my = sum(p.y for p in pts) / n
    cxx = sum((p.x - mx) ** 2 for p in pts) / n
    cyy = sum((p.y - my) ** 2 for p in pts) / n
    cxy = sum((p.x - mx) * (p.y - my) for p in pts) / n
    ang = 0.5 * math.atan2(2 * cxy, cxx - cyy)
    a = Vector((math.cos(ang), math.sin(ang), 0))
    if abs(a.x) > abs(a.y):
        a = Vector((-a.y, a.x, 0))
    if a.y > 0:
        a = -a                      # forward = towards -Y
    lat = Vector((-a.y, a.x, 0))
    if lat.x * sx < 0:
        lat = -lat                  # lateral = away from the other foot
    c = Vector((mx, my, 0))
    pr = [(p - c).dot(a) for p in pts]
    heel = c + a * min(pr)
    length = max(pr) - min(pr)
    ank = [v.co for v in skin_bm.verts if 0.17 < v.co.z < 0.21 and 0.05 < v.co.x * sx < 0.33]
    ac = Vector((sum(p.x for p in ank) / len(ank), sum(p.y for p in ank) / len(ank), 0))
    return heel, a, lat, length, ac


class Last:
    """boot last in foot space: s along the foot (0 = back of the heel), t lateral (+ = outside), z up."""

    def __init__(self, heel, fwd, lat, foot_len):
        self.L = foot_len + 0.034
        self.o = heel - fwd * 0.014
        self.f, self.l = fwd, lat

    def w(self, s):  # outline half width at the welt
        u = s / self.L
        if u < 0.1:
            return 0.036 * math.sqrt(max(0.0, 1 - ((0.1 - u) / 0.1) ** 2))
        if u > 0.74:
            return 0.049 * math.sqrt(max(0.0, 1 - ((u - 0.74) / 0.26) ** 2.2))
        return 0.036 + 0.0005 * sst(0.1, 0.4, u) + 0.0125 * sst(0.42, 0.74, u)

    def off(self, s):  # outline centre line: straight inner edge, fuller outer edge at the ball
        u = s / self.L
        return 0.004 * sst(0.45, 0.75, u) - 0.006 * sst(0.8, 1.0, u)

    def zb(self, s):  # bottom of the upper = top of the sole (heel lift, toe spring)
        u = s / self.L
        return SOLE_T + 0.011 * sst(0.38, 0.25, u) + 0.013 * sst(0.8, 1.0, u) ** 2

    def h(self, s):  # top of the upper (toe box, instep rising into the shaft)
        u = s / self.L
        top = 0.067 + 0.006 * sst(0.92, 0.72, u)                 # firm toe box / ball
        top += 0.07 * sst(0.7, 0.5, u) + 0.03 * sst(0.55, 0.45, u)  # instep rising into the shaft front
        top = min(top, 0.115 + 0.08 * sst(0.2, 0.45, u))          # heel counter (the shaft covers the rest)
        top -= 0.022 * sst(0.9, 1.0, u) ** 1.5                   # rounded toe front
        return top + 0.013 * sst(0.8, 1.0, u) ** 2

    def p(self, s, t, z):
        return self.o + self.f * s + self.l * t + Vector((0, 0, z))


def loft_upper(bm, last, ns=56, nk=40, ne=2.6):
    rings = []
    for i in range(ns + 1):
        s = last.L * (0.5 - 0.5 * math.cos(math.pi * i / ns))  # denser at both ends
        w, z0, z1, oc = last.w(s), last.zb(s) - 0.004, last.h(s), last.off(s)
        zm, hh = (z0 + z1) / 2, (z1 - z0) / 2
        ring = []
        for k in range(nk):
            ph = 2 * math.pi * k / nk
            c, sn = math.cos(ph), math.sin(ph)
            tt = oc + w * math.copysign(abs(c) ** (2 / ne), c)
            e = ne if sn > 0 else 5.0  # flat bottom
            zz = zm + hh * math.copysign(abs(sn) ** (2 / e), sn)
            ring.append(bm.verts.new(last.p(s, tt, zz)))
        rings.append(ring)
    for i in range(ns):
        for k in range(nk):
            bm.faces.new([rings[i][k], rings[i][(k + 1) % nk], rings[i + 1][(k + 1) % nk], rings[i + 1][k]])
    for ring, rev in ((rings[0], True), (rings[-1], False)):
        c = bm.verts.new(sum((v.co for v in ring), Vector()) / nk)
        for k in range(nk):
            f = [ring[k], ring[(k + 1) % nk], c]
            bm.faces.new(f[::-1] if rev else f)


def shaft(bm, last, ac, nz=24, nk=40):
    """elliptical ankle shaft: wide over heel + instep at the bottom, snug at the top."""
    sa = (ac - last.o).dot(last.f)
    rings = []
    for j in range(nz + 1):
        z = 0.045 + (Z_TOP - 0.045) * j / nz
        g = sst(0.06, 0.17, z)
        sc = sa + 0.012 * (1 - g) - 0.002 * g
        rs = 0.075 * (1 - g) + 0.051 * g      # along the foot
        rt = 0.041 * (1 - g) + 0.045 * g + 0.002 * sst(0.2, Z_TOP, z)
        rf = rs * (1.0 + 0.25 * (1 - g))      # front reaches further down the instep
        ring = []
        for k in range(nk):
            ph = 2 * math.pi * k / nk
            c, sn = math.cos(ph), math.sin(ph)
            ds = (rf if c > 0 else rs) * c
            ring.append(bm.verts.new(last.p(sc + ds, rt * sn, z)))
        rings.append(ring)
    for j in range(nz):
        for k in range(nk):
            bm.faces.new([rings[j][k], rings[j][(k + 1) % nk], rings[j + 1][(k + 1) % nk], rings[j + 1][k]])
    for ring, rev in ((rings[0], True), (rings[-1], False)):
        c = bm.verts.new(sum((v.co for v in ring), Vector()) / nk)
        for k in range(nk):
            f = [ring[k], ring[(k + 1) % nk], c]
            bm.faces.new(f[::-1] if rev else f)
    return sa


def outline(last, grow, n=36):
    """welt / sole outline (closed polygon in foot space as (s, t)), grown by `grow`."""
    pts = []
    us = [0.5 - 0.5 * math.cos(math.pi * i / n) for i in range(n + 1)]
    for u in us:
        s = last.L * u
        pts.append((s, last.off(s) + last.w(s) + grow))
    for u in reversed(us[1:-1]):
        s = last.L * u
        pts.append((s, last.off(s) - last.w(s) - grow))
    # push the end points outwards so the grown outline stays rounded at heel and toe
    out = []
    for s, t in pts:
        u = s / last.L
        s2 = s - grow * (1 - u) * sst(0.15, 0.0, u) * 1.0 + grow * sst(0.85, 1.0, u)
        out.append((s2, t))
    return out


def slab(name, last, ol, z0f, z1f, mat, bevel, cname='feet'):
    sm = bmesh.new()
    r0 = [sm.verts.new(last.p(s, t, z0f(s))) for s, t in ol]
    r1 = [sm.verts.new(last.p(s, t, z1f(s))) for s, t in ol]
    n = len(ol)
    for i in range(n):
        sm.faces.new([r0[i], r0[(i + 1) % n], r1[(i + 1) % n], r1[i]])
    sm.faces.new(r1)
    sm.faces.new(r0[::-1])
    bmesh.ops.recalc_face_normals(sm, faces=sm.faces[:])
    o = obj_from_bm(name, sm, cname, mat)
    sm.free()
    add_mod(o, 'BEVEL', width=bevel, segments=3, limit_method='ANGLE', angle_limit=math.radians(35))
    add_mod(o, 'WEIGHTED_NORMAL', keep_sharp=True)
    return o


def lugs(name, last, mat, z_lug=0.0065):
    """chevron lug tread under the outsole; the outer lugs reach the sole edge (toothed side profile)."""
    sm = bmesh.new()
    L = last.L
    s = 0.012
    while s < L - 0.01:
        u = s / L
        if 0.33 < u < 0.46:          # arch: no lugs between heel block and forefoot
            s += 0.0175
            continue
        w = last.w(s) + 0.008
        oc = last.off(s)
        zb = 0.013 * sst(0.8, 1.0, u) ** 2 * 0.6
        for side in (-1, 1):
            for k, (t0, ln) in enumerate(((0.012, 0.016), (w - 0.009, 0.018))):
                if t0 > w - 0.006 and k == 0:
                    continue
                c = last.p(s, oc + side * t0, zb + z_lug / 2)
                ang = side * math.radians(28 if k == 0 else 10)
                m = Matrix.Rotation(math.atan2(last.f.y, last.f.x) + ang, 4, 'Z')
                ret = bmesh.ops.create_cube(sm, size=1.0)
                vs = ret['verts']
                bmesh.ops.scale(sm, vec=(0.0095, ln, z_lug), verts=vs)
                bmesh.ops.transform(sm, matrix=m, verts=vs)
                bmesh.ops.translate(sm, vec=c, verts=vs)
        s += 0.0175
    o = obj_from_bm(name, sm, 'feet', mat)
    sm.free()
    add_mod(o, 'BEVEL', width=0.0016, segments=2)
    add_mod(o, 'WEIGHTED_NORMAL', keep_sharp=True)
    return o


def snap(bvh, p, lift):
    hit, nrm, _, _ = bvh.find_nearest(p)
    return hit + nrm * lift, nrm


def build_boots(M, skin_bm, pants, sides=(1.0, -1.0)):
    blouse = []
    for sx in sides:
        s_ = 'L' if sx > 0 else 'R'
        heel, fwd, lat, flen, ac = foot_frame(skin_bm, sx)
        last = Last(heel, fwd, lat, flen)
        # ---- upper: loft + shaft, voxel union, smoothed
        bm = bmesh.new()
        loft_upper(bm, last)
        sa = shaft(bm, last, ac)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        up = obj_from_bm('Boot_' + s_, bm, 'feet', M['boot'])
        bm.free()
        add_mod(up, 'REMESH', mode='VOXEL', voxel_size=0.0022)
        add_mod(up, 'SMOOTH', factor=0.6, iterations=6)
        up = freeze(up)
        # material slot 1: smooth leather toe cap + heel counter; stitch seams
        up.data.materials.append(M['boot_leather'])
        me = up.data
        seam = []
        for v in me.vertices:
            q = v.co - last.o
            s, t, z = q.dot(last.f), q.dot(last.l), v.co.z
            u = s / last.L
            capline = 0.78 * last.L + 0.025 * ((t - last.off(s)) / 0.05) ** 2
            d = min(abs(s - capline) if z < last.zb(s) + 0.06 else 1.0,
                    abs(z - (last.zb(s) + 0.006)),
                    abs(t) if u < 0.12 else 1.0,
                    abs(z - (Z_TOP - 0.01)))
            seam.append(d)
        set_seam(up, seam)
        for f in me.polygons:
            q = f.center - last.o
            s, t = q.dot(last.f), q.dot(last.l)
            capline = 0.78 * last.L + 0.025 * ((t - last.off(s)) / 0.05) ** 2
            heelline = 0.2 * last.L - 0.03 * ((f.center.z - 0.03) / 0.09) ** 2
            if (s > capline and f.center.z < last.zb(s) + 0.07) or (s < heelline and f.center.z < 0.14):
                f.material_index = 1
        add_mod(up, 'SOLIDIFY', thickness=0.003, offset=-1.0)
        ubvh = bvh_of([up])
        # ---- welt (stitched leather strip) and lugged outsole with heel block
        spring = lambda s: 0.013 * sst(0.8, 1.0, s / last.L) ** 2
        arch = lambda s: 0.006 * sst(0.3, 0.34, s / last.L) * sst(0.5, 0.46, s / last.L)
        ol_w = outline(last, 0.0055)
        ol_s = outline(last, 0.0075)
        w_ = slab('Welt_' + s_, last, ol_w, lambda s: last.zb(s) - 0.007, lambda s: last.zb(s) + 0.002, M['boot_leather'], 0.0015)
        set_seam(w_, [abs(v.co.z - (last.zb((v.co - last.o).dot(last.f)) - 0.0025)) * 3 for v in w_.data.vertices])
        slab('Sole_' + s_, last, ol_s, lambda s: 0.0065 * 0.999 + spring(s) * 0.6 + arch(s), lambda s: last.zb(s) - 0.006,
             M['sole'], 0.0025)
        lugs('SoleLugs_' + s_, last, M['sole'])
        # ---- eyelets up the front, laces crossing between them, a small bow at the top
        guide = []
        for k in range(9):
            g = k / 8
            s_k = last.L * (0.6 - 0.25 * sst(0.0, 0.55, g)) * 1.0
            z_k = 0.088 + (Z_TOP - 0.022 - 0.088) * g
            # start in front of the boot and snap to its surface
            p0 = last.p(s_k + 0.08, last.off(s_k) * 0.5, z_k)
            hit, nrm, _, _ = ubvh.ray_cast(p0, (last.p(sa, 0, z_k) - p0).normalized(), 0.3)
            if hit is None:
                hit, nrm = snap(ubvh, p0, 0.0)
            guide.append((hit, nrm))
        eyes = []
        for k, (c, nrm) in enumerate(guide):
            up_k = (guide[min(k + 1, 8)][0] - guide[max(k - 1, 0)][0]).normalized()
            side_ax = up_k.cross(nrm).normalized()
            hw = 0.0105 + 0.002 * (1 - k / 8)
            pair = []
            for sg in (-1, 1):
                e, en = snap(ubvh, c + side_ax * hw * sg, 0.0015)
                pair.append((e, en))
            eyes.append((pair, side_ax, up_k, nrm))
        lines = []
        rings = []
        for k, (pair, sax, upk, nrm) in enumerate(eyes):
            for e, en in pair:
                t1 = en.cross(sax).normalized()
                t2 = en.cross(t1).normalized()
                rings.append([e + (t1 * math.cos(a) + t2 * math.sin(a)) * 0.0028 for a in
                              [2 * math.pi * i / 10 for i in range(11)]])
        lift = 0.0032
        (a0, n0), (b0, m0) = eyes[0][0]
        lines.append([a0 + n0 * lift, (a0 + b0) * 0.5 + eyes[0][3] * (lift + 0.001), b0 + m0 * lift])
        for k in range(len(eyes) - 1):
            (a, na), (b, nb) = eyes[k][0]
            (c2, nc), (d2, nd) = eyes[k + 1][0]
            nm = (eyes[k][3] + eyes[k + 1][3]).normalized()
            lines.append([a + na * lift, (a + d2) * 0.5 + nm * (lift + 0.0015), d2 + nd * lift])
            lines.append([b + nb * lift, (b + c2) * 0.5 + nm * (lift + 0.0035), c2 + nc * lift])
        (a, na), (b, nb) = eyes[-1][0]
        _, sax, upk, nrm = eyes[-1]
        knot = (a + b) * 0.5 + nrm * 0.006 + upk * 0.002
        lines.append([a + na * lift, knot, b + nb * lift])
        # bow: two small loops lying on the boot front and two short tails resting on the laces
        for sg in (-1, 1):
            loop = [knot]
            for i in range(1, 12):
                a_ = math.pi * i / 12
                q = knot + sax * sg * (0.012 * math.sin(a_) * 1.0 + 0.0) + upk * (0.0055 * math.sin(2 * a_) * sg * 0.9) \
                    + sax * sg * 0.0025 * math.sin(a_) ** 4
                loop.append(snap(ubvh, q, 0.0055)[0])
            loop.append(knot)
            lines.append(loop)
            tail = [knot]
            for i in (1, 2, 3):
                q = knot - upk * 0.0045 * i + sax * sg * 0.0022 * i
                tail.append(snap(ubvh, q, 0.0048)[0])
            lines.append(tail)
        tubes('Laces_' + s_, lines, 0.0016, 'feet', M['lace'], res=3)
        tubes('Eyelets_' + s_, rings, 0.0008, 'feet', M['metal'])
        # padded collar (mostly under the bloused trousers)
        sc = last.p(sa - 0.002, 0, 0)
        ring_band(ubvh, 'BootCollar_' + s_, sc, (0, 0, 1), Z_TOP - 0.013, Z_TOP + 0.001, 40, 2, 0.002,
                  'feet', M['boot_leather'], thick=0.006, bevel=0.002, R=0.12)
        blouse.append((sx, sc, last))
    blouse_trousers(pants, blouse)


def blouse_trousers(pants, boots):
    """trouser legs (cloth-simmed down to the floor): tucked into the shaft below its top, bloused over the
    boot tops in irregular folds."""
    mw = pants.matrix_world
    mi = mw.inverted()
    for v in pants.data.vertices:
        p = mw @ v.co
        if p.z > Z_TOP + 0.11:
            continue
        for sx, sc, last in boots:
            if p.x * sx <= 0.02:
                continue
            c = Vector((sc.x, sc.y, 0))
            d = Vector((p.x - c.x, p.y - c.y, 0))
            if d.length < 1e-5:
                continue
            ds, dt = d.dot(last.f), d.dot(last.l)
            rs, rt = 0.051, 0.047 + 0.002
            rho = math.sqrt((ds / rs) ** 2 + (dt / rt) ** 2)
            ang = math.atan2(dt, ds)
            z = p.z - Z_TOP
            n1 = noise.noise(Vector((math.cos(ang) * 1.6, math.sin(ang) * 1.6, z * 30 + sx * 5)))
            n2 = noise.noise(Vector((ang * 2.2 + sx, z * 8, 1.3)))
            if z < -0.012:  # tucked in; the trouser hem reaches the floor, so pull it well inside the boot
                tgt = 0.5 + 0.36 * sst(-0.04, -0.012, z)
            elif z < 0.004:
                tgt = 0.86 + (1.16 - 0.86) * sst(-0.012, 0.004, z)
            else:
                bulge = math.exp(-((z - 0.022) / 0.02) ** 2)
                fold = 0.06 * (0.5 + 0.5 * math.sin(ang * 7 + 3 * n2 + z * 60)) * bulge
                tgt = 1.16 + 0.12 * bulge + fold + 0.04 * n1
            wgt = 1.0 - sst(0.045, 0.1, z)
            new_r = rho + (tgt - rho) * wgt
            q = c + d * (new_r / rho)
            q.z = p.z - 0.004 * wgt * sst(0.0, 0.03, z)  # the bloused fabric droops a little over the top
            v.co = mi @ q
            break
