"""
Iron Front - BI2 hero soldier: helmet chinstrap (Blender 5.2.2 LTS), called from stage2_gear.py.

On each side a Y of flat olive webbing around the ear: one strap from the shell in front of the ear, one
from the shell behind it, joining at a small junction buckle below the ear lobe (the ear stays free), then
one strap along the jaw line to a small padded chin cup centred on the front-lower chin. Straps are
snapped onto the skin (a few mm off it) below the helmet rim and run up under the cover to the shell
anchors; small plastic adjusters on the straps.
"""
import math
import bpy
from mathutils import Vector
from hero_lib import *

W = 0.018      # webbing width
T = 0.0022     # webbing thickness
LIFT = 0.0028  # strap centre off the skin


def snap_path(head_bvh, guide, z_free):
    """resample the guide, snap the points below z_free onto the skin; above it blend to the anchors."""
    pts = smooth_curve([Vector(p) for p in guide], 4)
    out, nrm = [], []
    for p in pts:
        hit, n, _, _ = head_bvh.find_nearest(p)
        n = n.normalized()
        q = hit + n * LIFT
        k = max(0.0, min(1.0, (p.z - (z_free - 0.012)) / 0.012))  # 0: on the skin, 1: free (up to the shell)
        out.append(q.lerp(p, k))
        nrm.append(n)
    for _ in range(3):  # even out the snapped path, then put it back on the skin
        sm = [out[0]] + [(out[i - 1] + out[i] * 2 + out[i + 1]) * 0.25 for i in range(1, len(out) - 1)] + [out[-1]]
        for i, p in enumerate(sm):
            if p.z < z_free - 0.012 and 0 < i < len(sm) - 1:
                hit, n, _, _ = head_bvh.find_nearest(p)
                sm[i] = hit + n.normalized() * LIFT
                nrm[i] = n.normalized()
        out = sm
    return out, nrm


def build_chinstrap(M, head_bvh, sides=(1.0, -1.0)):
    # ---- chin cup: small padded cup over the front-lower chin, centred
    ray = Vector((0, 0.86, 0.5)).normalized()           # from the front, a little below the chin
    u = Vector((1, 0, 0))
    v = ray.cross(u).normalized()
    cc = Vector((0.0, -0.158, 1.559))
    project_sheet(head_bvh, 'Helmet_ChinCup', cc, u, v, ray, 0.027, 0.019, 12, 8, 0.0045, 'helmet', M['gear_pad'],
                  thick=0.006, round_n=3.0, bevel=0.0018)
    for sx in sides:
        s = 'L' if sx > 0 else 'R'
        J = Vector((sx * 0.075, -0.047, 1.597))          # junction below the ear lobe
        front = [(sx * 0.11, -0.08, 1.706), (sx * 0.09, -0.078, 1.68), (sx * 0.08, -0.077, 1.652), (sx * 0.078, -0.071, 1.625),
                 (J.x, J.y - 0.004, J.z + 0.006)]
        back = [(sx * 0.1, 0.008, 1.677), (sx * 0.085, 0.006, 1.656), (sx * 0.075, -0.008, 1.63), (sx * 0.073, -0.03, 1.608),
                (J.x, J.y + 0.004, J.z + 0.004)]
        # cup side attachment
        hit, n, _, _ = head_bvh.ray_cast(cc + u * sx * 0.026 - ray * 0.3, ray, 0.6)
        cup_side = (hit + n * 0.006) if hit is not None else cc + u * sx * 0.026
        lower = [(J.x, J.y, J.z), (sx * 0.068, -0.075, 1.576), (sx * 0.055, -0.104, 1.559), (sx * 0.038, -0.128, 1.551),
                 tuple(cup_side)]
        for nm, guide, zf in (('F', front, 1.668), ('B', back, 1.66), ('J', lower, 9.0)):
            pts, nrm = snap_path(head_bvh, guide, zf)
            strap_along('Helmet_Chinstrap%s_%s' % (nm, s), pts, nrm, W if nm != 'J' else W * 0.95, T, 'helmet',
                        M['webbing'])
            if nm == 'F':  # slide adjuster on the cheek strap
                i = len(pts) // 2
                adj = rbox('Helmet_StrapAdjuster_' + s, (W * 1.25, 0.0035, 0.009), cname='helmet', mat=M['polymer'],
                           bevel=0.0012)
                orient(adj, pts[i] + nrm[i] * 0.0025, nrm[i], up=(pts[i + 1] - pts[i - 1]).normalized())
            if nm == 'J':  # side-release buckle half way along the jaw strap
                i = len(pts) // 2
                bk = rbox('Helmet_JawBuckle_' + s, (0.013, 0.005, W * 1.2), cname='helmet', mat=M['polymer'], bevel=0.0015)
                tdir = (pts[i + 1] - pts[i - 1]).normalized()
                orient(bk, pts[i] + nrm[i] * 0.003, nrm[i], up=tdir.cross(nrm[i]))
        # junction buckle where the two ear straps meet
        hit, n, _, _ = head_bvh.find_nearest(J)
        jb = rbox('Helmet_YJunction_' + s, (0.02, 0.005, 0.016), cname='helmet', mat=M['polymer'], bevel=0.002)
        orient(jb, hit + n.normalized() * (LIFT + 0.003), n.normalized(), up=(0, 0, 1))
