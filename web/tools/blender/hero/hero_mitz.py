"""
Iron Front - BI2 hero soldier: the IDF Mitznefet (helmet cover), called from stage2_gear.py.

An oversized, floppy, beret-like cover of open mesh netting: much wider than the helmet, it bulges out over
the brim all round (front, back and sides) with sagging, irregular edges, then rolls under and is gathered
by an elastic drawstring just under the helmet rim (bunched fabric). Lumps and soft wrinkles on top; a
cut-out lets the NVG mount poke through at the front. The holes are in the shader (alpha), so the dark
helmet shell shows through.
"""
import math
import bpy, bmesh
from mathutils import Vector, noise
from hero_lib import *


def sst(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def build_mitznefet(M, HC, RX, RY, RZ, rim_z, nvg_at, segs=180, rings=64):
    """HC / RX, RY, RZ / rim_z: helmet shell centre, radii and rim height function; nvg_at: point on the
    shell where the NVG mount sits (the cover gets a cut-out there). Returns (cover, drawstring points)."""
    top = HC.z + RZ + 0.012
    bm = bmesh.new()
    uvl = bm.loops.layers.uv.new('UVMap')
    crown = bm.verts.new((HC.x, HC.y, top))
    grid = []
    draw = []
    for i in range(segs):
        a = 2 * math.pi * i / segs
        ca, sa = math.cos(a), math.sin(a)
        dirv = Vector((sa, -ca, 0))
        # helmet rim radius in this direction (ellipse) and rim height
        rr = 1.0 / math.sqrt((sa / RX) ** 2 + (ca / RY) ** 2)
        q = HC + dirv * rr
        zr = rim_z(q)
        n1 = noise.noise(Vector((ca * 1.3, sa * 1.3, 0.7)))
        n2 = noise.noise(Vector((ca * 3.1, sa * 3.1, 2.1)))
        front = math.exp(-(a / 0.75) ** 2) + math.exp(-((a - 2 * math.pi) / 0.75) ** 2)
        # widest bulge: well outside the brim all round, a little less at the front (keeps the eyes clear)
        rmax = rr + 0.042 + 0.012 * n1 + 0.006 * n2 - 0.012 * front
        zw = zr + 0.026 - 0.018 * max(0.0, n2 + 0.2) - 0.012 * (1 - front) * max(0.0, n1)   # sagging edge
        zw = max(zw, zr + 0.006)
        rg = rr - 0.008                       # drawstring tucked just under the rim (hides the shell edge)
        zg = zr - 0.011
        draw.append(HC + dirv * (rg + 0.001) + Vector((0, 0, zg - HC.z - 0.001)))
        row = []
        for j in range(1, rings + 1):
            t = j / rings
            if t <= 0.78:
                ph = (t / 0.78) * math.pi / 2
                r = rmax * math.sin(ph)
                # dome that sits on the crown, then flattens out into a pancake
                z = zw + (top - zw) * math.cos(ph) ** 1.35
            else:
                ps = (t - 0.78) / 0.22
                r = rg + (rmax - rg) * math.cos(ps * math.pi / 2)
                z = zw - (zw - zg) * math.sin(ps * math.pi / 2)
                # bunched fabric gathered by the elastic
                g = sst(0.4, 1.0, ps)
                r += 0.004 * g * math.sin(a * 46 + 3 * noise.noise(Vector((ca * 4, sa * 4, 0.3))))
                z += 0.002 * g * math.sin(a * 23 + 1.7)
            p = HC + dirv * r + Vector((0, 0, z - HC.z))
            row.append(bm.verts.new(p))
        grid.append(row)
    nr = rings
    for i in range(segs):
        i2 = (i + 1) % segs
        f = bm.faces.new([crown, grid[i][0], grid[i2][0]])
        for lp in f.loops:
            lp[uvl].uv = (i / segs, 0.0)
        for j in range(nr - 1):
            f = bm.faces.new([grid[i][j], grid[i][j + 1], grid[i2][j + 1], grid[i2][j]])
            for lp, uv in zip(f.loops, ((i / segs, j / nr), (i / segs, (j + 1) / nr), ((i + 1) / segs, (j + 1) / nr),
                                        ((i + 1) / segs, j / nr))):
                lp[uvl].uv = uv
    bm.normal_update()
    # lumps, soft wrinkles and creases (stronger on the floppy outer part)
    for v in bm.verts:
        p = v.co.copy()
        d = p - HC
        out = sst(0.03, 0.12, Vector((d.x, d.y, 0)).length)
        lump = noise.noise(p * 16.0 + Vector((3, 1, 2)))
        wr = (1.0 - abs(noise.noise(p * 30.0 + Vector((5, 5, 1))))) ** 4
        v.co += v.normal * ((0.005 + 0.009 * out) * lump + 0.0035 * wr * (0.4 + 0.6 * out))
    # NVG cut-out at the front
    nvg_dir = (nvg_at - HC).normalized()
    kill = []
    for f in bm.faces:
        c = f.calc_center_median() - HC
        if c.normalized().dot(nvg_dir) > math.cos(0.15) and c.length > (nvg_at - HC).length - 0.01:
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    cover = obj_from_bm('Helmet_Mitznefet', bm, 'helmet', M['mitz_net'])
    bm.free()
    add_mod(cover, 'SUBSURF', levels=1, render_levels=1)
    add_mod(cover, 'SOLIDIFY', thickness=0.0016, offset=-1.0)
    shade_smooth(cover)
    draw.append(draw[0])
    return cover, draw
