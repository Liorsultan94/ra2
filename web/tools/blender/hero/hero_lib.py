"""
Iron Front - BI2 hero soldier: shared helpers (Blender 5.2.2 LTS, imported by the stage scripts).

World conventions: metres, Z up, the soldier stands at the origin facing -Y, so his left side is +X.
The body is the CC0 "Body Male - Realistic" base mesh from Blender Studio's Human Base Meshes
bundle (download.blender.org/demo/asset-bundles/human-base-meshes/, licence CC0 1.0), scaled to 1.80 m.
"""
import bpy, bmesh, math, os, random
from mathutils import Vector, Matrix, noise
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.environ.get('HERO_WORK', '/tmp/claude-0/BI2/work')
BUNDLE = os.environ.get('HERO_BODY_BLEND', '/tmp/claude-0/BI2/dl/human-base-meshes-bundle-v1.4.1/human_base_meshes_bundle.blend')
BODY_SRC_HEIGHT = 1.6899610757827759
SCALE = 1.80 / BODY_SRC_HEIGHT
BODY_SRC_OFFSET_X = 2.2643022537231445

# collections used by phase 2 (retopo / bake per bone)
PARTS = ['head', 'torso', 'arms', 'legs', 'feet', 'helmet', 'vest', 'rifle', 'studio']

# ---------------------------------------------------------------- landmarks (world, after scaling)
SHOULDER = 0.19, 1.42   # |x|, z of the shoulder joint (A-pose)
ARM_DIR = Vector((0.389, -0.921)).normalized()  # shoulder -> wrist direction in the xz plane for +x
WRIST_T = 0.505          # distance along ARM_DIR from SHOULDER to the wrist crease
HEAD_C = Vector((0.0, -0.055, 1.69))


def arm_t(p):
    """distance of p along the arm axis (both sides) from the shoulder joint, and radial distance."""
    sx = 1.0 if p.x >= 0 else -1.0
    q = Vector((abs(p.x) - SHOULDER[0], p.z - SHOULDER[1]))
    t = q.dot(ARM_DIR)
    perp = q - ARM_DIR * t
    return t, math.hypot(perp.length, p.y)


def arm_point(t, side):
    return Vector((side * (SHOULDER[0] + ARM_DIR.x * t), 0.0, SHOULDER[1] + ARM_DIR.y * t))


def is_hand(p):
    return abs(p.x) > 0.25 and 0.6 < p.z < 1.1 and arm_t(p)[0] > WRIST_T


def is_arm(p):
    return (abs(p.x) > 0.185 or (abs(p.x) > 0.16 and p.z > 1.33)) and p.z > 0.86 and not is_hand(p) and arm_t(p)[0] > -0.02


def neck_cut(p):
    return 1.505 + 0.2 * p.y


# ---------------------------------------------------------------- scene helpers
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    random.seed(7)


def coll(name):
    c = bpy.data.collections.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(c)
    return c


def put(obj, cname):
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    coll(cname).objects.link(obj)
    return obj


def obj_from_bm(name, bm, cname, mat=None, smooth=True):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    me.update()
    o = bpy.data.objects.new(name, me)
    coll(cname).objects.link(o)
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    if mat is not None:
        me.materials.append(mat)
    return o


def evaluated_mesh_world(obj):
    """bmesh of obj after modifiers, in world space."""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    bm = bmesh.new()
    bm.from_mesh(ev.to_mesh())
    ev.to_mesh_clear()
    bm.transform(obj.matrix_world)
    return bm


def freeze(obj, name=None):
    """replace obj by a plain mesh object holding its evaluated geometry (world space)."""
    bm = evaluated_mesh_world(obj)
    cname = obj.users_collection[0].name
    mats = list(obj.data.materials)
    nm = name or obj.name
    bpy.data.objects.remove(obj)
    o = obj_from_bm(nm, bm, cname)
    for m in mats:
        o.data.materials.append(m)
    bm.free()
    return o


def bvh_of(objs):
    bm = bmesh.new()
    for o in objs:
        b = evaluated_mesh_world(o)
        me = bpy.data.meshes.new('_tmp')
        b.to_mesh(me)
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
        b.free()
    bm.normal_update()
    t = BVHTree.FromBMesh(bm)
    bm.free()
    return t


def extract(bm_src, vpred, fpred=None):
    """new bmesh with the faces of bm_src whose vertices all satisfy vpred(co)."""
    keep = set(f for f in bm_src.faces if all(vpred(v.co) for v in f.verts) and (fpred is None or fpred(f)))
    out = bmesh.new()
    vmap = {}
    for f in keep:
        vs = []
        for v in f.verts:
            nv = vmap.get(v.index)
            if nv is None:
                nv = out.verts.new(v.co)
                vmap[v.index] = nv
            vs.append(nv)
        out.faces.new(vs)
    out.normal_update()
    return out


def largest_island(bm):
    bm.verts.ensure_lookup_table()
    seen = set(); islands = []
    for v in bm.verts:
        if v in seen:
            continue
        st = [v]; isl = []
        seen.add(v)
        while st:
            a = st.pop(); isl.append(a)
            for e in a.link_edges:
                b = e.other_vert(a)
                if b not in seen:
                    seen.add(b); st.append(b)
        islands.append(isl)
    islands.sort(key=len)
    for isl in islands[:-1]:
        bmesh.ops.delete(bm, geom=isl, context='VERTS')


def push_normals(bm, d, fn=None):
    bm.normal_update()
    for v in bm.verts:
        k = d if fn is None else fn(v.co, d)
        v.co += v.normal * k


def smooth_bm(bm, iters=3, f=0.5, fixed_boundary=False):
    for _ in range(iters):
        bmesh.ops.smooth_vert(bm, verts=[v for v in bm.verts if not (fixed_boundary and v.is_boundary)], factor=f,
                              use_axis_x=True, use_axis_y=True, use_axis_z=True)


def add_mod(o, kind, name=None, **kw):
    m = o.modifiers.new(name or kind.lower(), kind)
    for k, v in kw.items():
        setattr(m, k, v)
    return m


def shade_smooth(o, angle=None):
    for p in o.data.polygons:
        p.use_smooth = True
    if angle is not None:
        add_mod(o, 'WEIGHTED_NORMAL', keep_sharp=True)


# ---------------------------------------------------------------- seams
SEAM_W = 0.012  # metres: seam closeness attribute goes 1 (on the seam) -> 0 (12 mm away)


def set_seam(o, dists):
    """store per-vertex seam closeness (1 - d / SEAM_W) as the 'seam' point attribute; shaders turn it
    into a seam groove, two rows of top-stitching and seam fading (missing attribute = no seam)."""
    me = o.data
    a = me.attributes.get('seam') or me.attributes.new('seam', 'FLOAT', 'POINT')
    a.data.foreach_set('value', [max(0.0, 1.0 - d / SEAM_W) for d in dists])


# ---------------------------------------------------------------- primitive builders
def rbox(name, size, loc=(0, 0, 0), rot=(0, 0, 0), cname='vest', mat=None, bevel=0.004, segs=3, subd=0, cuts=0,
         bulge=0.0, taper=0.0):
    """rounded box (bevel modifier + weighted normals): crisp hard-surface or padded gear.
    cuts > 0 makes a subdivided 'sewn' box: seam attribute along every edge (stitched edges), an
    optional bulge of the front (-Y) face and a taper towards the top (+Z)."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    if cuts:
        bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=cuts, use_grid_fill=True)
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    seams = []
    for v in bm.verts:
        x, y, z = v.co.x * 2, v.co.y * 2, v.co.z * 2  # -1..1
        q = Vector((x * hx, y * hy, z * hz))
        if cuts:
            r = sorted([(abs(x), hx, 0), (abs(y), hy, 1), (abs(z), hz, 2)], reverse=True)
            # distance to the nearest edge of the face this vertex lies on
            seams.append(min(r[1][1] * (1 - r[1][0]), r[2][1] * (1 - r[2][0])))
            if bulge and y < 0:
                q.y -= bulge * (1 - x * x) * (1 - z * z) * (-y)
            if taper:
                q.x *= 1 - taper * (z + 1) / 2
                q.y *= 1 - taper * 0.6 * (z + 1) / 2
        v.co = q
    o = obj_from_bm(name, bm, cname, mat)
    bm.free()
    if cuts:
        set_seam(o, seams)
    o.location = loc
    o.rotation_euler = rot
    if bevel > 0:
        if cuts:
            add_mod(o, 'BEVEL', width=bevel, segments=segs, limit_method='ANGLE', angle_limit=math.radians(40))
        else:
            add_mod(o, 'BEVEL', width=bevel, segments=segs, limit_method='NONE', harden_normals=False)
    if subd:
        add_mod(o, 'SUBSURF', levels=subd, render_levels=subd)
    add_mod(o, 'WEIGHTED_NORMAL', keep_sharp=True)
    return o


def cyl(name, r, depth, loc=(0, 0, 0), rot=(0, 0, 0), cname='rifle', mat=None, verts=24, bevel=0.0, r2=None):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=verts, radius1=r, radius2=r if r2 is None else r2, depth=depth)
    o = obj_from_bm(name, bm, cname, mat)
    bm.free()
    o.location = loc
    o.rotation_euler = rot
    if bevel > 0:
        add_mod(o, 'BEVEL', width=bevel, segments=2, limit_method='ANGLE', angle_limit=math.radians(40))
    add_mod(o, 'WEIGHTED_NORMAL', keep_sharp=True)
    return o


def extrude_profile(name, pts, width, cname='rifle', mat=None, bevel=0.003, segs=3, axis='Y', loc=(0, 0, 0), rot=(0, 0, 0)):
    """closed 2D outline pts [(u,v)...] in the XZ plane extruded symmetrically along Y by width."""
    bm = bmesh.new()
    vs = [bm.verts.new((u, -width / 2, v)) for u, v in pts]
    f = bm.faces.new(vs)
    r = bmesh.ops.extrude_face_region(bm, geom=[f])
    nv = [g for g in r['geom'] if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=nv, vec=(0, width, 0))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = obj_from_bm(name, bm, cname, mat, smooth=True)
    bm.free()
    o.location = loc
    o.rotation_euler = rot
    if bevel > 0:
        add_mod(o, 'BEVEL', width=bevel, segments=segs, limit_method='ANGLE', angle_limit=math.radians(30))
    add_mod(o, 'WEIGHTED_NORMAL', keep_sharp=True)
    return o


def tube_along(name, pts, radius, cname, mat=None, ring=10, closed=False):
    """round tube through 3D points (cables, laces, bungees, antenna)."""
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    sp = cu.splines.new('POLY')
    sp.points.add(len(pts) - 1)
    for i, p in enumerate(pts):
        sp.points[i].co = (p[0], p[1], p[2], 1)
    sp.use_cyclic_u = closed
    cu.bevel_depth = radius
    cu.bevel_resolution = max(1, ring // 4)
    cu.use_fill_caps = True
    o = bpy.data.objects.new(name, cu)
    coll(cname).objects.link(o)
    if mat:
        cu.materials.append(mat)
    return o


def strap_along(name, pts, normals, width, thick, cname, mat=None):
    """flat strap (webbing) following points with given outward normals."""
    bm = bmesh.new()
    rows = []
    n = len(pts)
    # consistent, smoothed normals so the strap never twists
    nl = [Vector(x).normalized() for x in normals]
    for i in range(1, n):
        if nl[i].dot(nl[i - 1]) < 0:
            nl[i] = -nl[i]
    for _ in range(3):
        nl = [(nl[max(i - 1, 0)] + nl[i] * 2 + nl[min(i + 1, n - 1)]).normalized() for i in range(n)]
    normals = nl
    for i in range(n):
        p = Vector(pts[i]); nn = Vector(normals[i]).normalized()
        t = (Vector(pts[min(i + 1, n - 1)]) - Vector(pts[max(i - 1, 0)])).normalized()
        b = t.cross(nn).normalized()
        rows.append([bm.verts.new(p + b * (width / 2)), bm.verts.new(p), bm.verts.new(p - b * (width / 2))])
    for i in range(n - 1):
        for k in range(2):
            bm.faces.new([rows[i][k], rows[i][k + 1], rows[i + 1][k + 1], rows[i + 1][k]])
    bm.normal_update()
    o = obj_from_bm(name, bm, cname, mat)
    bm.free()
    set_seam(o, [(0.0 if i % 3 != 1 else width / 2) for i in range(len(o.data.vertices))])
    add_mod(o, 'SOLIDIFY', thickness=thick, offset=1.0)
    add_mod(o, 'BEVEL', width=min(thick * 0.4, 0.0012), segments=2, limit_method='ANGLE')
    return o


def squircle(s, t, n=6.0):
    """map the square [-1,1]^2 onto a superellipse (rounded rectangle) of exponent n."""
    if s == 0 and t == 0:
        return 0.0, 0.0
    inf = max(abs(s), abs(t))
    nn = (abs(s) ** n + abs(t) ** n) ** (1.0 / n)
    k = inf / nn
    return s * k, t * k


def project_sheet(bvh, name, center, u_axis, v_axis, ray_dir, half_u, half_v, nu, nv, offset, cname, mat=None,
                  thick=0.0, round_n=6.0, bevel=0.0, smooth_iter=0, lift=None):
    """grid shaped like a rounded rectangle, ray-projected along ray_dir onto bvh, then pushed out by
    offset along -ray_dir blended with the surface normal. Good for panels, pads, pockets, patches."""
    center = Vector(center); u_axis = Vector(u_axis).normalized(); v_axis = Vector(v_axis).normalized()
    ray_dir = Vector(ray_dir).normalized()
    bm = bmesh.new()
    grid = []
    uvs = {}
    sdist = {}
    for j in range(nv + 1):
        row = []
        for i in range(nu + 1):
            s = -1 + 2 * i / nu; t = -1 + 2 * j / nv
            s, t = squircle(s, t, round_n)
            p = center + u_axis * (s * half_u) + v_axis * (t * half_v)
            o0 = p - ray_dir * 0.6
            hit, nrm, _, _ = bvh.ray_cast(o0, ray_dir, 1.5)
            if hit is None:  # ray slipped past the silhouette: snap to the nearest surface point
                hit, nrm, _, _ = bvh.find_nearest(p)
                if hit is None:
                    hit = p; nrm = -ray_dir
            off = offset if lift is None else offset + lift(s, t)
            q = hit + (nrm * 0.5 - ray_dir * 0.5).normalized() * off
            nvx = bm.verts.new(q)
            uvs[nvx] = (i / nu, j / nv)
            s0 = -1 + 2 * i / nu; t0 = -1 + 2 * j / nv
            sdist[nvx] = min((1 - abs(s0)) * half_u, (1 - abs(t0)) * half_v)
            row.append(nvx)
        grid.append(row)
    for j in range(nv):
        for i in range(nu):
            bm.faces.new([grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]])
    uvl = bm.loops.layers.uv.new('UVMap')
    for f in bm.faces:
        for lp in f.loops:
            lp[uvl].uv = uvs[lp.vert]
    seam_vals = [sdist[v] for v in bm.verts]
    if smooth_iter:
        # flatten along the projection direction only, so the outline keeps its size
        for _ in range(smooth_iter):
            new = {}
            for v in bm.verts:
                nb = [e.other_vert(v).co for e in v.link_edges]
                avg = sum(nb, Vector()) / len(nb)
                dd = (avg - v.co).dot(ray_dir)
                new[v] = v.co + ray_dir * (dd * 0.5)
            for v, c in new.items():
                v.co = c
    bm.normal_update()
    # make normals face away from the ray (outwards)
    bm.faces.ensure_lookup_table()
    f0 = bm.faces[len(bm.faces) // 2] if len(bm.faces) else None
    if f0 is not None and f0.normal.dot(ray_dir) > 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    o = obj_from_bm(name, bm, cname, mat)
    bm.free()
    set_seam(o, seam_vals)
    if thick:
        add_mod(o, 'SOLIDIFY', thickness=thick, offset=-1.0)
    if bevel:
        add_mod(o, 'BEVEL', width=bevel, segments=3, limit_method='ANGLE', angle_limit=math.radians(50))
    add_mod(o, 'WEIGHTED_NORMAL', keep_sharp=True)
    return o


def wrap_band(bvh, name, axis_c, z0, z1, a0, a1, nu, nv, offset, cname, mat=None, thick=0.0, bevel=0.0, rx=0.6):
    """band wrapped around a vertical axis through axis_c (x,y), from angle a0..a1 (radians, 0 = -Y front,
    increasing towards +X), heights z0..z1; rays shot inwards from outside onto bvh."""
    bm = bmesh.new()
    grid = []
    for j in range(nv + 1):
        z = z0 + (z1 - z0) * j / nv
        row = []
        for i in range(nu + 1):
            a = a0 + (a1 - a0) * i / nu
            d = Vector((math.sin(a), -math.cos(a), 0.0))
            o0 = Vector((axis_c[0], axis_c[1], z)) + d * rx
            hit, nrm, _, _ = bvh.ray_cast(o0, -d, rx * 2)
            if hit is None:
                hit = Vector((axis_c[0], axis_c[1], z)) + d * 0.15
            row.append(bm.verts.new(hit + d * offset))
        grid.append(row)
    for j in range(nv):
        for i in range(nu):
            bm.faces.new([grid[j][i], grid[j + 1][i], grid[j + 1][i + 1], grid[j][i + 1]])
    bm.normal_update()
    o = obj_from_bm(name, bm, cname, mat)
    bm.free()
    if thick:
        add_mod(o, 'SOLIDIFY', thickness=thick, offset=-1.0)
    if bevel:
        add_mod(o, 'BEVEL', width=bevel, segments=2, limit_method='ANGLE', angle_limit=math.radians(50))
    add_mod(o, 'WEIGHTED_NORMAL', keep_sharp=True)
    return o, grid


def surface_frame(bvh, p, ray_dir):
    """hit point + normal on bvh along ray_dir aimed at p."""
    ray_dir = Vector(ray_dir).normalized()
    hit, nrm, _, _ = bvh.ray_cast(Vector(p) - ray_dir * 0.6, ray_dir, 1.5)
    if hit is None:
        return Vector(p), -ray_dir
    return hit, nrm


def orient(o, loc, normal, up=(0, 0, 1), roll=0.0):
    """place o at loc with its local -Y facing along normal (outwards), local Z towards up."""
    n = Vector(normal).normalized()
    upv = Vector(up)
    x = upv.cross(n)
    if x.length < 1e-4:
        x = Vector((1, 0, 0))
    x.normalize()
    z = n.cross(x).normalized()
    m = Matrix((x, -n, z)).transposed().to_4x4()
    m = m @ Matrix.Rotation(roll, 4, 'Y')
    m.translation = Vector(loc)
    o.matrix_world = m
    return o


def ring_band(bvh, name, c, axis, h0, h1, nu, nv, offset, cname, mat=None, thick=0.0, bevel=0.0, a0=0.0,
              a1=2 * math.pi, R=0.5, ref=None):
    """band around an arbitrary axis (point c, direction axis) between heights h0..h1 along it and angles
    a0..a1 (0 = towards ref, default -Y projected); rays shot inwards onto bvh, pushed out by offset."""
    c = Vector(c); ax = Vector(axis).normalized()
    e1 = Vector(ref) if ref is not None else Vector((0, -1, 0))
    e1 = (e1 - ax * e1.dot(ax))
    if e1.length < 1e-4:
        e1 = Vector((1, 0, 0)) - ax * ax.x
    e1.normalize()
    e2 = ax.cross(e1).normalized()
    full = abs((a1 - a0) - 2 * math.pi) < 1e-6
    nU = nu if full else nu + 1
    bm = bmesh.new()
    grid = []
    rseam = []
    for j in range(nv + 1):
        h = h0 + (h1 - h0) * j / nv
        row = []
        for i in range(nU):
            a = a0 + (a1 - a0) * i / nu
            d = e1 * math.cos(a) + e2 * math.sin(a)
            p0 = c + ax * h
            hit, nrm, _, _ = bvh.ray_cast(p0 + d * R, -d, R * 1.5)
            if hit is None:
                hit = p0 + d * 0.05
            row.append(bm.verts.new(hit + d * offset))
            dd = min(abs(h - h0), abs(h1 - h))
            if not full:
                rr = (hit - p0).length
                dd = min(dd, rr * (a - a0), rr * (a1 - a))
            rseam.append(dd)
        grid.append(row)
    for j in range(nv):
        for i in range(nu):
            i2 = (i + 1) % nU if full else i + 1
            bm.faces.new([grid[j][i], grid[j][i2], grid[j + 1][i2], grid[j + 1][i]])
    bm.normal_update()
    bm.faces.ensure_lookup_table()
    f = bm.faces[0]
    cen = f.calc_center_median()
    radial = (cen - c) - ax * (cen - c).dot(ax)
    if f.normal.dot(radial) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    o = obj_from_bm(name, bm, cname, mat)
    bm.free()
    set_seam(o, rseam)
    if thick:
        add_mod(o, 'SOLIDIFY', thickness=thick, offset=-1.0)
    if bevel:
        add_mod(o, 'BEVEL', width=bevel, segments=2, limit_method='ANGLE', angle_limit=math.radians(50))
    add_mod(o, 'WEIGHTED_NORMAL', keep_sharp=True)
    return o


def relax(bm, offset, skin_bvh, rounds=4, iters=6, fac=0.6):
    """turn a skin patch into an envelope: smooth away anatomy (cloth bridges hollows), keep it at least
    `offset` off the skin, and clean the cut edges."""
    for r in range(rounds):
        smooth_bm(bm, iters, fac)
        bnd = [v for v in bm.verts if v.is_boundary]
        for _ in range(3):
            for v in bnd:
                nb = [e.other_vert(v) for e in v.link_edges if e.is_boundary]
                if len(nb) == 2:
                    v.co = v.co * 0.5 + (nb[0].co + nb[1].co) * 0.25
        for v in bm.verts:
            hit, nrm, _, _ = skin_bvh.find_nearest(v.co)
            if hit is None:
                continue
            d = (v.co - hit).dot(nrm)
            if d < offset:
                v.co = hit + nrm * offset
    bm.normal_update()


def tubes(name, polylines, radius, cname, mat=None, res=2):
    """several round tubes (one curve object, one spline per polyline)."""
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    for pts in polylines:
        sp = cu.splines.new('POLY')
        sp.points.add(len(pts) - 1)
        for i, p in enumerate(pts):
            sp.points[i].co = (p[0], p[1], p[2], 1)
    cu.bevel_depth = radius
    cu.bevel_resolution = res
    cu.use_fill_caps = True
    o = bpy.data.objects.new(name, cu)
    coll(cname).objects.link(o)
    if mat:
        cu.materials.append(mat)
    return o


def smooth_curve(pts, n=4):
    """Catmull-Rom resample of a polyline (n sub-steps per segment)."""
    P = [Vector(p) for p in pts]
    out = []
    for i in range(len(P) - 1):
        p0 = P[max(i - 1, 0)]; p1 = P[i]; p2 = P[i + 1]; p3 = P[min(i + 2, len(P) - 1)]
        for k in range(n):
            t = k / n
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(P[-1])
    return out
