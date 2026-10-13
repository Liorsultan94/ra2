"""
Iron Front - BI2 hero soldier: Saber-style ballistic shield glasses (Blender 5.2.2 LTS), called from
stage2_gear.py.

One wide wraparound smoke lens built analytically (smooth curvature, so reflections stay soft and clean):
a quartic wrap in plan view that follows the face to the temples about 8-15 mm off the skin, a slight
pantoscopic tilt, a straight top edge at the brow line and two lobes with a nose notch at the bottom.
A thin frame bar runs along the top edge only; a small bridge piece with two rubber nose pads; thin temple
arms that run straight back along the head, under the headset cushions.
"""
import math
import bpy, bmesh
from mathutils import Vector, Matrix
from hero_lib import *

Y0 = -0.168        # lens front at the bridge
ZT = 1.7025        # top edge at the bridge (brow line, under the helmet brim)
HALF_W = 0.083     # half width of the shield


def sst(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def lens_y(x, z):
    """lens surface: quartic wrap around the face + pantoscopic tilt (bottom closer to the cheeks)."""
    return Y0 + 5.735 * x * x + 715.0 * x ** 4 + 0.12 * (ZT - z)


def z_top(x):
    return ZT - 0.0045 * (x / HALF_W) ** 2


def z_bot(x):
    ax = abs(x)
    z = 1.657 + 0.019 * math.exp(-(x / 0.0125) ** 2)       # nose notch
    z += 0.003 * math.exp(-((ax - 0.036) / 0.02) ** 2) * -1   # fuller lobe under each eye
    z += 0.03 * sst(0.058, HALF_W + 0.001, ax) ** 1.6        # rounded outer corners
    return min(z, z_top(x) - 0.006)


def lens_point(x, z):
    return Vector((x, lens_y(x, z), z))


def lens_normal(x, z):
    e = 1e-4
    dx = lens_point(x + e, z) - lens_point(x - e, z)
    dz = lens_point(x, z + e) - lens_point(x, z - e)
    n = dz.cross(dx).normalized()
    return n if n.y < 0 else -n


def build_glasses(M, head_bvh, sides=(1.0, -1.0)):
    # ---- lens: grid over (x, v) with v = 0 at the top edge, 1 at the bottom edge
    nu, nv = 72, 14
    bm = bmesh.new()
    grid = []
    for j in range(nv + 1):
        row = []
        for i in range(nu + 1):
            x = -HALF_W + 2 * HALF_W * i / nu
            v = j / nv
            z = z_top(x) + (z_bot(x) - z_top(x)) * v
            row.append(bm.verts.new(lens_point(x, z)))
        grid.append(row)
    for j in range(nv):
        for i in range(nu):
            bm.faces.new([grid[j][i], grid[j + 1][i], grid[j + 1][i + 1], grid[j][i + 1]])
    bm.normal_update()
    bm.faces.ensure_lookup_table()
    if bm.faces[len(bm.faces) // 2].normal.y > 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    lens = obj_from_bm('Glasses_Lens', bm, 'head', M['lens_smoke'])
    bm.free()
    add_mod(lens, 'SOLIDIFY', thickness=0.0016, offset=0.0)
    add_mod(lens, 'BEVEL', width=0.0005, segments=2, limit_method='ANGLE', angle_limit=math.radians(50))
    add_mod(lens, 'SUBSURF', levels=1, render_levels=1)
    # ---- thin frame bar along the top edge only
    pts = []
    for i in range(61):
        x = -HALF_W - 0.001 + (2 * HALF_W + 0.002) * i / 60
        z = z_top(x)
        n = lens_normal(x, z)
        pts.append(lens_point(x, z) + Vector((0, 0, 0.0016)) - n * 0.0005)
    # bar: a strap whose width runs front-back across the lens top, so it reads as a thin rim from the front
    up = [Vector((0, 0, 1)) for _ in pts]
    strap_along('Glasses_Frame', pts, up, 0.0062, 0.0034, 'head', M['polymer'])
    # ---- bridge piece and rubber nose pads
    nb = lens_point(0, ZT - 0.004)
    bridge = rbox('Glasses_Bridge', (0.011, 0.007, 0.018), (0, nb.y + 0.006, ZT - 0.012), cname='head',
                  mat=M['polymer'], bevel=0.0018)
    for sx in sides:
        # pad sits on the side of the nose bridge, angled to its flank
        p = Vector((sx * 0.0105, 0, 1.671))
        hit, nrm_, _, _ = head_bvh.ray_cast(p + Vector((sx * 0.05, -0.05, 0)), Vector((-sx, 1, 0)).normalized(), 0.2)
        if hit is None:
            hit, nrm_ = Vector((sx * 0.0105, -0.152, 1.671)), Vector((sx, -1, 0)).normalized()
        c = hit + nrm_ * 0.0022
        pad = rbox('Glasses_NosePad_%d' % sx, (0.0045, 0.0028, 0.011), (0, 0, 0), cname='head', mat=M['rubber'], bevel=0.0012)
        orient(pad, c, nrm_, up=(0, 0, 1))
        tube_along('Glasses_PadArm_%d' % sx, [nb + Vector((sx * 0.003, 0.006, -0.01)), c + Vector((0, -0.002, 0.004))],
                   0.0007, 'head', M['metal'])
    # ---- temple arms: straight back from the lens ends, hugging the head under the headset cushions
    for sx in sides:
        x0 = sx * (HALF_W + 0.0005)
        z0 = z_top(x0) - 0.002
        start = lens_point(x0, z0) + Vector((0, 0.002, 0))
        path = [start]
        for k in range(1, 8):
            y = start.y + (0.0 - start.y) * k / 7
            z = z0 - 0.006 * k / 7
            hit, nrm_, _, _ = head_bvh.ray_cast(Vector((sx * 0.3, y, z)), Vector((-sx, 0, 0)), 0.3)
            x = (hit.x + sx * 0.0035) if hit is not None else sx * 0.1
            if sx * x < sx * path[-1].x:
                x = path[-1].x  # never turn back in towards the face
            path.append(Vector((x, y, z)))
        path = smooth_curve(path, 3)
        tube_along('Glasses_Temple_%d' % (1 if sx > 0 else -1), path, 0.0019, 'head', M['polymer'], ring=8)
    return lens
