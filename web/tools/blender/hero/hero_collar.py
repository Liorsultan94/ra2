"""
Iron Front - BI2 hero soldier: fold-down field-shirt collar and the open throat (Blender 5.2.2 LTS), called
from stage2_gear.py.

One continuous collar surface per angle round the neck: a collar band rising from the shirt neckline, the
roll (fold) at its top and the collar leaf coming back down outside it, lying on the shoulders and upper
chest (pushed out of the shirt so it never sinks in), with pointed collar tips on the chest either side of
the throat. The shirt front is opened into a small V below the undone top button.
"""
import math
import bpy, bmesh
from mathutils import Vector
from hero_lib import *

A0 = 0.30            # half opening angle at the throat (0 = straight ahead, -Y)
CN = Vector((0.0, -0.005, 0.0))


def sst(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def build_collar(M, body_bvh, dressed_bvh, na=72, nb=4, nl=10):
    bm = bmesh.new()
    rows = []
    for i in range(na + 1):
        a = A0 + (2 * math.pi - 2 * A0) * i / na
        d = Vector((math.sin(a), -math.cos(a), 0))
        edge = min(a - A0, 2 * math.pi - A0 - a)            # angular distance to the front opening
        front = math.exp(-((math.pi - abs(a - math.pi)) / 0.9) ** 2)
        y_guess = CN.y + d.y * 0.068
        zb = neck_cut(Vector((0, y_guess, 0))) - 0.006      # band starts just inside the shirt neckline
        hit, n, _, _ = body_bvh.ray_cast(Vector((CN.x, CN.y, zb + 0.01)) + d * 0.3, -d, 0.3)
        if hit is None:
            hit, n = CN + d * 0.068 + Vector((0, 0, zb + 0.01)), d
        nh = Vector((n.x, n.y, 0)).normalized()
        base = Vector((hit.x, hit.y, zb)) + nh * 0.0045
        hband = 0.022 + 0.005 * (1 - front)
        col = []
        for k in range(nb + 1):  # band: up the neck, leaning out a touch
            t = k / nb
            col.append(base + Vector((0, 0, hband * t)) + nh * (0.002 * t))
        fold = base + Vector((0, 0, hband + 0.003)) + nh * 0.0065
        col.append(fold)
        # leaf: back down outside the band, then out over the shoulders / chest
        w = 0.04 + 0.006 * sst(0.5, 1.3, abs(a - math.pi) if abs(a - math.pi) < 1.6 else 1.6) \
            + 0.034 * sst(0.75, 0.0, edge)                  # long pointed collar tips at the front
        beta = math.radians(38 + 30 * front)                 # steeper over the chest
        for k in range(1, nl + 1):
            s = k / nl
            r_out = 0.0095 + w * s * math.cos(beta) * sst(0.0, 0.35, s) + 0.004 * s
            dz = -(0.006 + w * s * math.sin(beta)) if s > 0.05 else -0.004
            p = base + Vector((0, 0, hband + 0.001 + dz)) + nh * r_out
            hit2, n2, _, _ = dressed_bvh.find_nearest(p)
            if hit2 is not None:
                off = (p - hit2).dot(n2)
                if off < 0.0042:
                    p = p + n2 * (0.0042 - off)
            col.append(p)
        rows.append(col)
    grid = [[bm.verts.new(p) for p in col] for col in rows]
    for i in range(na):
        for k in range(len(grid[i]) - 1):
            bm.faces.new([grid[i][k], grid[i][k + 1], grid[i + 1][k + 1], grid[i + 1][k]])
    bm.normal_update()
    o = obj_from_bm('Collar', bm, 'torso', M['uniform'])
    bm.free()
    # stitched edges: top-stitch along the leaf edge and the band seam
    nrow = nb + 2 + nl
    set_seam(o, [(0.0 if (vi % nrow) in (0, nrow - 1) else 0.006) for vi in range(len(o.data.vertices))])
    add_mod(o, 'SOLIDIFY', thickness=0.0028, offset=0.0)
    add_mod(o, 'SUBSURF', levels=1, render_levels=1)
    shade_smooth(o)
    return o


def open_throat(shirt):
    """cut a small V into the shirt front below the collar (top button undone)."""
    bm = bmesh.new()
    bm.from_mesh(shirt.data)
    mw = shirt.matrix_world
    kill = []
    for f in bm.faces:
        c = mw @ f.calc_center_median()
        if c.y < -0.03 and c.z > 1.425:
            hw = 0.025 * sst(1.425, 1.495, c.z) ** 0.8
            if abs(c.x) < hw:
                kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(shirt.data)
    bm.free()
