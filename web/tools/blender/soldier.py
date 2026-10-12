# Blender 5.2.2 (LTS) - Iron Front: IDF rifleman (infantry model key "rifle", faction israel) game asset.
#
#   nice -n 10 blender -b --factory-startup -P tools/blender/soldier.py [-- all|composite]
#   (from web/; run tools/blender/make.sh soldier for the whole pipeline)
#
# Input : build/idf-rifleman-proc.glb + .json, the game's procedural soldier dumped per bone by
#         export-procedural.ts (body space at rest, bone / modelling-frame matrices, poses, budgets), so the
#         parts sit exactly where the game's skeleton, IK grips and muzzle expect them.
# Output: build/idf-rifleman-raw.glb  one low-poly mesh per bone, named after the bone, positions in the
#                                     bone's modelling frame (pack.mjs adds LOD1 / LOD2)
#         build/idf-rifleman-{albedo,normal,orm}.png (1024 bakes; pack.mjs -> 512 / 256 px WebP)
#         build/idf-rifleman-studio*.png (Cycles renders of the low poly with the final maps, aim pose)
#
# Look (owner's reference photo): olive IDF uniform with sleeve / trouser folds and a collar, Mitznefet
# helmet cover (lumpy draped cloth, elastic band, ragged rim), chinstrap, olive plate carrier with three
# rifle-magazine pouches, admin pouch, radio and a dark sling across the chest, Israeli flag patch on the left
# shoulder, bare hands, a face with brow, nose, ears and jaw (and a little stubble), dark leather boots,
# a Tavor-style bullpup with a red-dot optic. The game's team colour stays where the procedural soldier has
# it: arm bands, helmet band and crown patch, chest ID panel, pack lid (orm R mask).
#
# High poly = the low-poly volumes subdivided and displaced (cloth folds, cover lumps, face detail) plus
# detail pieces that only exist in the bake (straps, buckles, MOLLE webbing, laces, stitching, rail slots).
# Texture authoring is bake + numpy like common.py describes; the baked AO is applied softly (the game's
# own infantry fill / wrap lighting must not be stacked with a dark AO).
import json
import math
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
STAGE = ARGS[0] if ARGS else 'all'
NAME = 'idf-rifleman'
TEX = 1024
meta = json.load(open(os.path.join(C.BUILD, NAME + '-proc.json')))
BAKES = os.path.join(C.BUILD, NAME + '-bakes.npz')


def mat16(a):
    """three.js column-major 16 array -> mathutils Matrix."""
    return Matrix([[a[0], a[4], a[8], a[12]], [a[1], a[5], a[9], a[13]], [a[2], a[6], a[10], a[14]], [a[3], a[7], a[11], a[15]]])


BONES = {k: v for k, v in meta['bones'].items()}
REST = {k: mat16(v['rest']) for k, v in BONES.items()}
FRAME = {k: mat16(v['frameRest']) for k, v in BONES.items()}


def bp(name):
    """Bone rest position (body space)."""
    return REST[name].to_translation()


# ------------------------------------------------------------------ surface kinds
# base colour (sRGB hex), roughness, metalness, team mask, flag mask, skin mask, cloth mask
KINDS = {
    'cloth': (0x666743, 0.93, 0.0, 0, 0, 0, 1),  # uniform olive (procedural: 0x5c5d3d twill x 1.14)
    'cover': (0x6b6c45, 0.95, 0.0, 0, 0, 0, 1),  # Mitznefet cloth
    'gear': (0x5b5e3c, 0.9, 0.0, 0, 0, 0, 1),  # plate carrier nylon
    'strap': (0x464a32, 0.88, 0.0, 0, 0, 0, 1),  # webbing
    'sling': (0x2f302a, 0.85, 0.0, 0, 0, 0, 0),
    'skin': (0xb58c69, 0.62, 0.0, 0, 0, 1, 0),
    'eye': (0x2a221c, 0.4, 0.0, 0, 0, 1, 0),
    'boot': (0x3b3027, 0.72, 0.0, 0, 0, 0, 0),
    'sole': (0x262422, 0.92, 0.0, 0, 0, 0, 0),
    'gun': (0x2f302d, 0.62, 0.12, 0, 0, 0, 0),  # polymer
    'steel': (0x3a3b3a, 0.48, 0.55, 0, 0, 0, 0),
    'glass': (0x1a2430, 0.18, 0.0, 0, 0, 0, 0),
    'red': (0xb02a20, 0.3, 0.0, 0, 0, 0, 0),  # red-dot lens tint
    'radio': (0x30322b, 0.7, 0.05, 0, 0, 0, 0),
    'buckle': (0x2b2b28, 0.6, 0.1, 0, 0, 0, 0),
    'team': (0x9e9e9e, 0.6, 0.0, 1, 0, 0, 0),
    'flag': (0xf2f2ee, 0.8, 0.0, 0, 1, 0, 0),
}
KIND_LIST = list(KINDS)
KI = {k: i for i, k in enumerate(KIND_LIST)}

# ------------------------------------------------------------------ bmesh primitives (game space)


def TRS(p=(0, 0, 0), r=(0, 0, 0), s=1.0):
    """three.js xf(): T * R(euler XYZ) * S."""
    if isinstance(s, (int, float)):
        s = (s, s, s)
    return Matrix.Translation(Vector(p)) @ Euler(r, 'XYZ').to_matrix().to_4x4() @ Matrix.Diagonal((s[0], s[1], s[2], 1.0))


Y_UP = Matrix.Rotation(-math.pi / 2, 4, 'X')  # bmesh primitives are Z-axis: turn their axis onto +Y


def xform(bm, M):
    bmesh.ops.transform(bm, matrix=M, verts=bm.verts)
    return bm


def kind(bm, k):
    for f in bm.faces:
        f.material_index = KI[k]
    return bm


def sphere(seg=12, rings=8):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=1.0)
    return xform(bm, Y_UP)


def cyl(rt, rb, h, seg=8, caps=True):
    """Cylinder along +Y centred on the origin (rt at +Y)."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=seg, radius1=rb, radius2=rt, depth=h)
    return xform(bm, Y_UP)


def box(w, h, d, bevel=0.0, segs=1):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    xform(bm, Matrix.Diagonal((w, h, d, 1.0)))
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=min(bevel, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4), offset_type='OFFSET', segments=segs, profile=0.5, affect='EDGES', clamp_overlap=True)
    return bm


def lathe(prof, seg=12, cap_top=True, cap_bot=True):
    """Surface of revolution about +Y: prof = [(r, y), ...] bottom -> top. r ~ 0 ends become poles."""
    bm = bmesh.new()
    rings = []
    for r, y in prof:
        if r < 1e-4:
            rings.append([bm.verts.new((0, y, 0))])
            continue
        rings.append([bm.verts.new((r * math.cos(2 * math.pi * i / seg), y, r * math.sin(2 * math.pi * i / seg))) for i in range(seg)])
    for a, b in zip(rings, rings[1:]):
        if len(a) == 1 and len(b) == 1:
            continue
        if len(a) == 1:
            for i in range(seg):
                bm.faces.new((a[0], b[(i + 1) % seg], b[i]))
        elif len(b) == 1:
            for i in range(seg):
                bm.faces.new((a[i], a[(i + 1) % seg], b[0]))
        else:
            for i in range(seg):
                bm.faces.new((a[i], a[(i + 1) % seg], b[(i + 1) % seg], b[i]))
    if cap_bot and len(rings[0]) > 1:
        bm.faces.new(list(reversed(rings[0])))
    if cap_top and len(rings[-1]) > 1:
        bm.faces.new(rings[-1])
    orient_out(bm)
    return bm


def limb(r0, r1, length, seg=8, rings=4, cap=True):
    """Tapered limb hanging down from the origin along -Y, rounded both ends."""
    prof = []
    if cap:
        for i in range(3):
            a = -math.pi / 2 + i * math.pi / 4
            prof.append((max(1e-5, r1 * math.cos(a)), -length + r1 * math.sin(a)))
    for i in range(1, rings):
        t = i / rings
        prof.append((r1 + (r0 - r1) * t, -length + (length) * t))
    if cap:
        for i in range(0, 3):
            a = i * math.pi / 4
            prof.append((max(1e-5, r0 * math.cos(a)), r0 * math.sin(a)))
    return lathe(prof, seg, cap_top=not cap, cap_bot=not cap)


def extrude(pts, depth, bevel=0.0):
    """Polygon pts [(x, y)] (counter-clockwise) in the XY plane extruded along Z, centred."""
    bm = bmesh.new()
    vs = [bm.verts.new((x, y, -depth / 2)) for x, y in pts]
    f = bm.faces.new(vs)
    res = bmesh.ops.extrude_face_region(bm, geom=[f])
    nv = [e for e in res['geom'] if isinstance(e, bmesh.types.BMVert)]
    for v in nv:
        v.co.z += depth
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, offset_type='OFFSET', segments=1, profile=0.5, affect='EDGES', clamp_overlap=True)
    return bm


def ribbon(pts, normals, w, t):
    """Strap: rectangular cross-section (w wide, t thick) swept along pts, flat side facing normals."""
    bm = bmesh.new()
    secs = []
    n = len(pts)
    for i in range(n):
        p = Vector(pts[i])
        tang = (Vector(pts[min(i + 1, n - 1)]) - Vector(pts[max(i - 1, 0)])).normalized()
        nn = Vector(normals[i]).normalized()
        b = tang.cross(nn).normalized()
        nn = b.cross(tang).normalized()
        secs.append([bm.verts.new(p + b * sx * w / 2 + nn * sy * t / 2) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
    for a, b in zip(secs, secs[1:]):
        for k in range(4):
            bm.faces.new((a[k], a[(k + 1) % 4], b[(k + 1) % 4], b[k]))
    bm.faces.new(list(reversed(secs[0])))
    bm.faces.new(secs[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def orient_out(bm):
    """Face every face away from the piece's centroid (lathes, domes, open rings: recalc_face_normals
    guesses wrong on open pieces, and a face turned inwards would be culled in the game)."""
    c = sum((v.co for v in bm.verts), Vector()) / max(1, len(bm.verts))
    for f in bm.faces:
        f.normal_update()
        if f.normal.dot(f.calc_center_median() - c) < 0:
            f.normal_flip()
    return bm


def merge(dst, src):
    me = bpy.data.meshes.new('tmp')
    src.to_mesh(me)
    dst.from_mesh(me)
    bpy.data.meshes.remove(me)
    src.free()


def delete_faces(bm, pred):
    kill = [f for f in bm.faces if pred(f.calc_center_median())]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    return len(kill)


def sstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def nsstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# ------------------------------------------------------------------ parts registry

class Part:
    """Geometry of one bone: low-poly pieces (the game mesh) and high-poly pieces (bake source)."""

    def __init__(self, bone):
        self.bone = bone
        self.low = bmesh.new()
        self.high = []  # (bm, recipe dict)

    def add(self, bm, k, hi='soft', lo=True, **rec):
        """lo: goes into the game mesh; hi: high-poly recipe ('soft' subdivided + displaced, 'hard'
        bevelled, 'raw' as is, None: not in the bake)."""
        kind(bm, k)
        if hi:
            c = bm.copy()
            self.high.append((c, dict(rec, hi=hi)))
        if lo:
            merge(self.low, bm)
        else:
            bm.free()


PARTS = {}


def part(bone):
    if bone not in PARTS:
        PARTS[bone] = Part(bone)
    return PARTS[bone]


# ------------------------------------------------------------------ displacement (high poly)

def d_cloth(P, N, amp=1.0, seed=1, rings=None, long=0.0):
    """Woven cloth: soft wrinkles, ridged creases across (rings: (y0, y1) window of compression folds)
    and along a limb (long)."""
    d = 0.0016 * (C.fbm(P * 55, 3, seed) - 0.5)
    d += 0.0022 * (C.fbm(P * np.array([16, 22, 16]), 3, seed + 3) - 0.5)
    if rings is not None:
        y0, y1 = rings
        w = nsstep(y0 - 0.05, y0, P[:, 1]) * (1 - nsstep(y1, y1 + 0.05, P[:, 1]))
        warp = C.vnoise(P * np.array([14, 3, 14]), seed + 5) * 0.6
        fold = C.ridge(np.stack([P[:, 0] * 6, P[:, 1] * 38 + warp * 3, P[:, 2] * 6], -1), seed + 9)
        d += 0.0042 * w * (fold ** 2 - 0.3)
    if long:
        crease = C.ridge(np.stack([P[:, 0] * 30, P[:, 1] * 4, P[:, 2] * 30], -1), seed + 11)
        d += 0.0026 * long * (crease ** 3 - 0.25)
    return d * amp


def d_cover(P, N, seed=4):
    """Mitznefet: big soft lumps of bunched cloth, puffs, and creases running down to the rim."""
    d = 0.012 * (C.fbm(P * 11, 3, seed) - 0.5) * 2
    d += 0.005 * (C.ridge(P * 26, seed + 2) - 0.4)
    d += 0.0025 * (C.ridge(np.stack([P[:, 0] * 40, P[:, 1] * 9, P[:, 2] * 40], -1), seed + 6) - 0.4)
    d += 0.001 * (C.fbm(P * 160, 2, seed + 9) - 0.5)
    return d


def d_nylon(P, N, seed=2):
    return 0.0008 * (C.fbm(P * 90, 2, seed) - 0.5) + 0.0012 * (C.fbm(P * 25, 2, seed + 1) - 0.5)


def d_leather(P, N, seed=3):
    crease = C.ridge(np.stack([P[:, 0] * 25, P[:, 1] * 60, P[:, 2] * 25], -1), seed)
    return 0.0006 * (C.fbm(P * 140, 2, seed) - 0.5) + 0.001 * (crease ** 4)


def d_skin(P, N, seed=5):
    return 0.00025 * (C.fbm(P * 400, 2, seed) - 0.5)


DISP = {'cloth': d_cloth, 'cover': d_cover, 'nylon': d_nylon, 'leather': d_leather, 'skin': d_skin}

# ================================================================== modelling (body space, metres)
HIPS = bp('ahips')
SPINE = bp('aspine')
NECK = bp('aneck')
WPN = bp('awpn')
# procedural head transform (infantry.ts body(): parts in the neck frame, scaled 1.06 about y = 0.12)
HC = NECK + Vector((0.005, 0.12 + 0.01 * 1.06, 0.0))  # skull centre
TILT = 0.1  # helmet tilt (front up)


def V(x, y, z):
    return Vector((x, y, z))


# ---------------------------------------------------------------- head and face
def head_shape(D, hi):
    """Unit directions D (n, 3) -> head-centre-relative positions: skull ellipsoid with jaw, chin, brow,
    eye sockets, nose, cheekbones, mouth (finer detail only in the high poly)."""
    dx, dy, dz = D[:, 0], D[:, 1], D[:, 2]
    a, b, c = 0.104, 0.124, 0.09
    x, y, z = dx * a, dy * b, dz * c
    front = nsstep(0.35, 0.8, dx)
    # jaw: narrower towards the chin, chin a little forward / down, the nape tucked in towards the neck
    low = nsstep(-0.05, -0.75, dy)
    z = z * (1 - 0.22 * low * nsstep(-0.2, 0.5, dx))
    y = y - 0.01 * low * front
    x = x + 0.012 * nsstep(-0.45, -0.85, dy) * front
    x = x * (1 - 0.18 * nsstep(-0.25, -0.75, dy) * nsstep(0.0, -0.6, dx))
    # face plane: flatten the front a little (the skull is rounder than the face)
    x = x - 0.006 * front * (1 - np.abs(dz) * 2).clip(0, 1)
    # brow ridge
    x = x + 0.008 * np.exp(-((dy - 0.27) / 0.08) ** 2) * front * np.exp(-(dz / 0.55) ** 2)
    # eye sockets
    for s in (-1, 1):
        x = x - 0.008 * np.exp(-(((dy - 0.15) / 0.08) ** 2 + ((dz - s * 0.33) / 0.13) ** 2)) * front
    # nose: bridge -> tip -> under the tip
    nose = np.exp(-(dz / (0.07 + 0.04 * nsstep(0.1, -0.2, dy))) ** 2) * front
    prof = 0.024 * nsstep(0.24, -0.12, dy) * (1 - nsstep(-0.12, -0.24, dy))
    x = x + prof * nose
    # cheekbones
    for s in (-1, 1):
        x = x + 0.004 * np.exp(-(((dy - 0.0) / 0.12) ** 2 + ((dz - s * 0.58) / 0.16) ** 2)) * nsstep(0.1, 0.5, dx)
    # chin
    x = x + 0.005 * np.exp(-(((dy + 0.7) / 0.12) ** 2 + (dz / 0.3) ** 2)) * front
    if hi:
        for s in (-1, 1):
            # nostril wings, eyelids, the nasolabial fold
            x = x + 0.004 * np.exp(-(((dy + 0.16) / 0.05) ** 2 + ((dz - s * 0.1) / 0.05) ** 2)) * front
            x = x + 0.002 * np.exp(-(((dy - 0.19) / 0.03) ** 2 + ((dz - s * 0.33) / 0.1) ** 2)) * front
            x = x - 0.002 * np.exp(-(((dy + 0.3) / 0.12) ** 2 + ((dz - s * (0.2 - 0.1 * dy)) / 0.04) ** 2)) * front
        # mouth: lips and the line between them
        mz = np.exp(-(dz / 0.24) ** 4)
        x = x + 0.0026 * np.exp(-((dy + 0.37) / 0.035) ** 2) * mz * front + 0.0022 * np.exp(-((dy + 0.47) / 0.04) ** 2) * mz * front
        x = x - 0.0028 * np.exp(-((dy + 0.415) / 0.012) ** 2) * mz * front
    return np.stack([x, y, z], -1)


def head_mesh(seg, rings, hi):
    bm = sphere(seg, rings)
    vs = list(bm.verts)
    D = np.array([v.co.normalized()[:] for v in vs])
    P = head_shape(D, hi)
    for v, p in zip(vs, P):
        v.co = HC + Vector(p)
    return bm


def build_head():
    h = part('ahead')
    lo = head_mesh(14, 10, False)
    # the top of the skull is under the helmet: not in the game mesh
    delete_faces(lo, lambda c: (c.y > HC.y + 0.05 and c.x < HC.x + 0.07) or c.y > HC.y + 0.075)
    h.add(lo, 'skin', hi=None)
    hi = head_mesh(112, 80, True)
    h.high.append((kind(hi, 'skin'), {'hi': 'raw', 'disp': 'skin'}))
    # ears
    for s in (-1, 1):
        e = xform(sphere(6, 4), TRS(HC + V(-0.008, -0.012, s * 0.088), (0, 0, 0), (0.019, 0.03, 0.013)))
        h.add(e, 'skin', hi='soft', sub=2, disp='skin')
        # inner ear hollow (high only, dark crease via AO)
        h.add(xform(sphere(10, 6), TRS(HC + V(-0.006, -0.012, s * 0.099), (0, 0, 0), (0.01, 0.019, 0.004))), 'skin', hi='raw', lo=False)
    # eyes (high only): dark irises in the sockets, eyebrows
    for s in (-1, 1):
        h.add(xform(sphere(12, 8), TRS(HC + V(0.083, 0.017, s * 0.03), (0, 0, 0), (0.008, 0.006, 0.011))), 'eye', hi='raw', lo=False)
        h.add(xform(box(0.012, 0.005, 0.036, 0.002), TRS(HC + V(0.094, 0.034, s * 0.032), (s * 0.12, 0, -0.25))), 'eye', hi='raw', lo=False)
    # Mitznefet cover over the helmet: a dome whose rim sits just above the brow in front and comes down
    # over the ear tops and the nape, flaring and drooping; lumpy bunched cloth. The team band and crown
    # patch are painted on it (composite).
    seg, rings = 12, 5
    cbm = bmesh.new()
    top = cbm.verts.new((0, 1, 0))
    grid = []
    for i in range(1, rings + 1):
        t = i / rings
        row = []
        for j in range(seg):
            phi = 2 * math.pi * j / seg
            amax = 1.45 + 0.45 * (1 - math.cos(phi)) / 2
            a = t * amax
            row.append(cbm.verts.new((math.sin(a) * math.cos(phi), math.cos(a), math.sin(a) * math.sin(phi))))
        grid.append(row)
    for j in range(seg):
        cbm.faces.new((top, grid[0][(j + 1) % seg], grid[0][j]))
    for a_, b_ in zip(grid, grid[1:]):
        for j in range(seg):
            cbm.faces.new((a_[j], a_[(j + 1) % seg], b_[(j + 1) % seg], b_[j]))
    orient_out(cbm)
    for v in cbm.verts:
        v.co = cover_point(Vector(v.co))
    h.add(cbm, 'cover', hi='soft', sub=4, disp='cover', simple=True)
    # chinstrap: from the rim in front of the ears, down the cheeks, under the chin (high only)
    for s in (-1, 1):
        pts, nrm = [], []
        for i in range(9):
            t = i / 8
            pts.append(HC + V(0.03 + 0.03 * t, 0.02 - 0.15 * t, s * (0.094 - 0.03 * t * t)))
            nrm.append(V(0.1, 0, s))
        h.add(ribbon(pts, nrm, 0.012, 0.003), 'strap', hi='raw', lo=False)
        h.add(xform(box(0.016, 0.02, 0.006, 0.001), TRS(HC + V(0.046, -0.06, s * 0.086))), 'buckle', hi='raw', lo=False)
    h.add(ribbon([HC + V(0.06 - 0.012 * math.cos(a), -0.135, 0.064 * math.sin(a) / math.sin(1.2)) for a in np.linspace(-1.2, 1.2, 9)], [V(0.3, -1, 0)] * 9, 0.012, 0.003), 'strap', hi='raw', lo=False)
    # neck (own bone): an open tube, its ends are inside the head and the collar
    n = part('aneck')
    n.add(xform(cyl(0.057, 0.062, 0.15, 8, caps=False), TRS(NECK + V(0.004, 0.065, 0))), 'skin', hi='soft', sub=2, disp='skin', simple=True)


COVER_CEN = HC + Vector((-0.004, 0.013, 0.0))


def cover_point(d):
    """Unit direction on the cover dome -> body-space point (lumpy, tilted, drooping rim)."""
    rad = (0.152, 0.142, 0.143)
    lump = float(C.fbm(np.array([d[:]]) * 3.2 + 3.0, 3, 21)[0]) - 0.5
    wave = math.sin(5 * math.atan2(d.z, d.x) + 4 * lump)
    rim = sstep(0.25, -0.3, d.y)
    k = 1 + 0.5 * lump + 0.05 * rim
    p = V(d.x * rad[0] * k, d.y * rad[1] * k, d.z * rad[2] * k)
    p = Euler((0, 0, TILT), 'XYZ').to_matrix() @ p
    p.y -= (0.012 + 0.006 * wave) * rim * (1 - 0.6 * max(0.0, d.x))
    return COVER_CEN + p


# ---------------------------------------------------------------- torso, plate carrier, pack
PACK = (-0.225, 0.25, 0.16, 0.33, 0.28)  # x, y (spine frame), w, h, d


def build_chest():
    ch = part('achest')
    S0 = SPINE  # parts are modelled in the spine frame (the chest blends spine <-> chest at the waist)
    tp = [(0.13, -0.06), (0.143, 0.04), (0.16, 0.14), (0.176, 0.24), (0.183, 0.32), (0.172, 0.38), (0.13, 0.43), (0.075, 0.47), (0.06, 0.49)]
    torso = lathe(tp, 10, cap_top=True, cap_bot=True)
    xform(torso, TRS(S0, (0, 0, 0), (0.78, 1, 1.1)))

    # hidden under the plate carrier / cummerbund: drop those faces
    def under_vest(c):
        y = c.y - S0.y
        return (0.12 < y < 0.40 and abs(c.z) < 0.15) or 0.11 < y < 0.28

    delete_faces(torso, under_vest)
    ch.add(torso, 'cloth', hi='soft', sub=4, disp='cloth', long=0.6)
    # shirt collar round the neck
    col = lathe([(0.072, 0.0), (0.079, 0.03), (0.07, 0.05)], 10, cap_top=False, cap_bot=False)
    xform(col, TRS(S0 + V(0.0, 0.455, 0), (0, 0, -0.12), (1, 1, 1.05)))
    ch.add(col, 'cloth', hi='soft', sub=4, disp='cloth', simple=True)
    # plate carrier: front plate bag (chamfered), cummerbund, shoulder straps and pads
    ch.add(xform(box(0.06, 0.31, 0.31, 0.02), TRS(S0 + V(0.13, 0.26, 0), (0, 0, -0.06))), 'gear', hi='hard', bev=0.006, disp='nylon')
    cb = lathe([(1.0, -0.1), (1.0, 0.1)], 12, cap_top=False, cap_bot=False)
    xform(cb, TRS(S0 + V(0, 0.2, 0), (0, 0, 0), (0.15, 1, 0.198)))
    ch.add(cb, 'gear', hi='soft', sub=2, disp='nylon', simple=True)
    for s in (-1, 1):
        ch.add(xform(box(0.27, 0.032, 0.08), TRS(S0 + V(0.0, 0.432, s * 0.11))), 'gear', hi='hard', bev=0.008, disp='nylon')
        ch.add(xform(box(0.14, 0.036, 0.095), TRS(S0 + V(0, 0.42, s * 0.16), (s * 0.4, 0, 0))), 'gear', hi='hard', bev=0.01, disp='nylon')
    # three rifle-magazine pouches (flaps in the bake), admin pouch above
    for z in (-0.092, 0.0, 0.092):
        ch.add(xform(box(0.058, 0.13, 0.084), TRS(S0 + V(0.18, 0.158, z))), 'gear', hi='hard', bev=0.009, disp='nylon')
        ch.add(xform(box(0.064, 0.03, 0.088, 0.008), TRS(S0 + V(0.183, 0.213, z))), 'gear', hi='hard', bev=0.006, disp='nylon', lo=False)
        ch.add(xform(box(0.006, 0.016, 0.02, 0.002), TRS(S0 + V(0.217, 0.206, z))), 'buckle', hi='raw', lo=False)
    ch.add(xform(box(0.05, 0.085, 0.16), TRS(S0 + V(0.17, 0.285, 0))), 'gear', hi='hard', bev=0.01, disp='nylon')
    # side pouches (IFAK right, grenade left), radio on the left with its antenna
    ch.add(xform(box(0.085, 0.1, 0.05), TRS(S0 + V(0.03, 0.16, 0.205))), 'gear', hi='hard', bev=0.01, disp='nylon')
    ch.add(xform(box(0.06, 0.085, 0.05), TRS(S0 + V(0.07, 0.16, -0.205))), 'gear', hi='hard', bev=0.01, disp='nylon')
    ch.add(xform(box(0.065, 0.14, 0.05), TRS(S0 + V(-0.05, 0.27, -0.215))), 'radio', hi='hard', bev=0.007)
    ch.add(xform(cyl(0.004, 0.007, 0.36, 4, caps=False), TRS(S0 + V(-0.065, 0.51, -0.215), (0.08, 0, 0.05))), 'radio', hi='hard', bev=0.001)
    # assault pack on the back (its back plate is hidden by it), team-colour lid (the marker is painted)
    px, py, pw, ph, pd = PACK
    ch.add(xform(box(pw, ph, pd, 0.035), TRS(S0 + V(px, py, 0))), 'gear', hi='hard', bev=0.01, disp='nylon')
    ch.add(xform(box(0.05, ph * 0.45, pd * 0.75), TRS(S0 + V(px - pw / 2 - 0.02, py - ph * 0.18, 0))), 'gear', hi='hard', bev=0.01, disp='nylon')
    ch.add(xform(box(pw * 0.95, 0.03, pd * 0.95), TRS(S0 + V(px - 0.005, py + ph / 2 + 0.005, 0))), 'team', hi='hard', bev=0.008, disp='nylon')
    # ---- high-only detail: MOLLE rows on the plate bag / cummerbund / pack, webbing, buckles, sling
    for y in np.arange(0.11, 0.4, 0.025):
        ch.add(xform(box(0.004, 0.012, 0.28, 0.001), TRS(S0 + V(0.163, y, 0), (0, 0, -0.06))), 'strap', hi='raw', lo=False)
    for y in np.arange(0.12, 0.27, 0.025):
        for s in (-1, 1):
            ch.add(xform(box(0.12, 0.012, 0.004, 0.001), TRS(S0 + V(0.0, y, s * 0.2))), 'strap', hi='raw', lo=False)
    for y in np.arange(0.12, 0.38, 0.028):
        ch.add(xform(box(0.004, 0.012, pd * 0.9, 0.001), TRS(S0 + V(px - pw / 2 - 0.047, y, 0))), 'strap', hi='raw', lo=False)
    for s in (-1, 1):
        ch.add(xform(box(0.006, ph * 0.92, 0.025, 0.002), TRS(S0 + V(px - pw / 2 - 0.002, py, s * pd * 0.3))), 'strap', hi='raw', lo=False)
        ch.add(xform(box(0.008, 0.03, 0.03, 0.002), TRS(S0 + V(px - pw / 2 - 0.006, py - 0.02, s * pd * 0.3))), 'buckle', hi='raw', lo=False)
        ch.add(xform(box(0.03, 0.006, 0.05, 0.001), TRS(S0 + V(0.06, 0.45, s * 0.11))), 'buckle', hi='raw', lo=False)
    # rifle sling: from the left shoulder across the chest to the right hip (dark webbing over the vest)
    tmp = bmesh.new()
    for b_, r_ in ch.high:
        merge(tmp, b_.copy())
    bvh = BVHTree.FromBMesh(tmp)
    pts, nrm = [], []
    for t in np.linspace(0, 1, 16):
        q = S0 + V(0.1, 0.47, -0.12).lerp(V(0.12, 0.06, 0.17), t)
        hit = bvh.ray_cast(q + V(0.3, 0.05, 0), V(-1, -0.1, 0).normalized(), 1.0)
        if hit[0] is not None:
            pts.append(hit[0] + hit[1] * 0.006)
            nrm.append(hit[1])
    tmp.free()
    if len(pts) > 3:
        ch.add(ribbon(pts, nrm, 0.032, 0.004), 'sling', hi='raw', lo=False)


def build_hips():
    hp = part('ahips')
    H0 = HIPS
    hp.add(xform(sphere(10, 6), TRS(H0 + V(0, -0.05, 0), (0, 0, 0), (0.14, 0.135, 0.19))), 'cloth', hi='soft', sub=4, disp='cloth')
    belt = lathe([(1.0, -0.03), (1.0, 0.03)], 12, cap_top=False, cap_bot=False)
    xform(belt, TRS(H0 + V(0, 0.03, 0), (0, 0, 0), (0.153, 1, 0.2)))
    hp.add(belt, 'strap', hi='soft', sub=2, disp='nylon', simple=True)
    for p, s in ((V(-0.075, -0.005, 0.165), (0.065, 0.09, 0.07)), (V(-0.15, -0.015, 0), (0.08, 0.08, 0.13)), (V(-0.07, -0.005, -0.172), (0.065, 0.085, 0.06)), (V(0.07, 0.0, 0.17), (0.05, 0.08, 0.05)), (V(0.07, 0.0, -0.17), (0.05, 0.08, 0.05))):
        hp.add(xform(box(*s), TRS(H0 + p)), 'gear', hi='hard', bev=0.01, disp='nylon')
    hp.add(xform(box(0.03, 0.04, 0.012, 0.002), TRS(H0 + V(0.155, 0.03, 0))), 'buckle', hi='raw', lo=False)


def build_legs():
    for s, nm in ((1, 'R'), (-1, 'L')):
        th, sh, ft = 'ath' + nm, 'ash' + nm, 'aft' + nm
        T0, K0, A0 = bp(th), bp(sh), bp(ft)
        p = part(th)
        p.add(xform(limb(0.118, 0.086, 0.44, 7, 3), TRS(T0, (0, 0, 0), (1.1, 1, 1.02))), 'cloth', hi='soft', sub=4, disp='cloth', rings=(T0.y - 0.45, T0.y - 0.36), long=1.0)
        # cargo pocket on the outer thigh; its flap only in the bake
        p.add(xform(box(0.12, 0.13, 0.04), TRS(T0 + V(0.0, -0.22, s * 0.083))), 'cloth', hi='hard', bev=0.012, disp='cloth')
        p.add(xform(box(0.124, 0.03, 0.044, 0.006), TRS(T0 + V(0.0, -0.145, s * 0.085))), 'cloth', hi='raw', lo=False)
        q = part(sh)
        q.add(xform(limb(0.088, 0.07, 0.36, 7, 3), TRS(K0)), 'cloth', hi='soft', sub=4, disp='cloth', rings=(K0.y - 0.36, K0.y - 0.22))
        # trousers bloused over the boot top (bake only)
        q.add(xform(lathe([(0.07, -0.02), (0.08, 0.0), (0.076, 0.025)], 12, False, False), TRS(K0 + V(-0.004, -0.31, 0))), 'cloth', hi='soft', sub=4, disp='cloth', simple=True, lo=False)
        f = part(ft)
        f.add(xform(cyl(0.064, 0.068, 0.15, 7, caps=False), TRS(A0 + V(-0.006, 0.05, 0))), 'boot', hi='soft', sub=2, disp='leather', simple=True)
        f.add(xform(box(0.275, 0.085, 0.118, 0.03), TRS(A0 + V(0.05, -0.027, 0))), 'boot', hi='hard', bev=0.012, disp='leather')
        f.add(xform(sphere(10, 6), TRS(A0 + V(0.15, -0.03, 0), (0, 0, 0), (0.058, 0.04, 0.057))), 'boot', hi='soft', sub=2, disp='leather', lo=False)
        f.add(xform(box(0.29, 0.024, 0.126), TRS(A0 + V(0.05, -0.062, 0))), 'sole', hi='hard', bev=0.004)
        # laces (high only), sole tread
        for i in range(6):
            f.add(xform(box(0.006, 0.004, 0.05, 0.001), TRS(A0 + V(0.075 - min(i, 2) * 0.012, 0.0 + i * 0.022, 0), (0, 0.5 if i % 2 else -0.5, 0))), 'sole', hi='raw', lo=False)
        for x in np.arange(-0.07, 0.18, 0.02):
            f.add(xform(box(0.008, 0.006, 0.12, 0.001), TRS(A0 + V(x, -0.075, 0))), 'sole', hi='raw', lo=False)


def build_arms():
    for s, nm in ((1, 'R'), (-1, 'L')):
        ua, fa, hd = 'aua' + nm, 'afa' + nm, 'ahd' + nm
        U0, E0 = bp(ua), bp(fa)
        u = part(ua)
        u.add(xform(sphere(7, 5), TRS(U0 + V(0, -0.02, 0), (0, 0, 0), (0.086, 0.084, 0.082))), 'cloth', hi='soft', sub=4, disp='cloth')
        u.add(xform(limb(0.078, 0.063, 0.27, 7, 3), TRS(U0)), 'cloth', hi='soft', sub=4, disp='cloth', long=0.8, rings=(U0.y - 0.3, U0.y - 0.22))
        if s < 0:
            # Israeli flag patch on the left shoulder: a curved strip following the sleeve (painted in the composite)
            fb = bmesh.new()
            cols = []
            for i in range(4):
                a = (i / 3 - 0.5) * 0.95  # angle around the arm (0 = outer side)
                x, z = 0.0815 * math.sin(a), -0.0815 * math.cos(a)
                cols.append([fb.verts.new(U0 + V(x, -0.06 + dy, z)) for dy in (-0.026, 0.026)])
            for a_, b_ in zip(cols, cols[1:]):
                fb.faces.new((a_[0], b_[0], b_[1], a_[1]))
            bmesh.ops.recalc_face_normals(fb, faces=fb.faces)
            for f_ in fb.faces:
                f_.normal_update()
                if f_.normal.z > 0:
                    f_.normal_flip()
            u.add(fb, 'flag', hi='raw')
        else:
            u.add(xform(box(0.07, 0.07, 0.012, 0.004), TRS(U0 + V(0.0, -0.07, s * 0.081), (s * -0.1, 0, 0))), 'cloth', hi='raw', lo=False)
        f = part(fa)
        f.add(xform(limb(0.064, 0.048, 0.235, 7, 3), TRS(E0)), 'cloth', hi='soft', sub=4, disp='cloth', rings=(E0.y - 0.08, E0.y + 0.04), long=0.5)
        # cuff, a little bunched at the wrist (bake only)
        f.add(xform(lathe([(0.048, -0.02), (0.054, 0.0), (0.05, 0.02)], 12, False, False), TRS(E0 + V(0, -0.215, 0))), 'cloth', hi='soft', sub=4, disp='cloth', simple=True, lo=False)
        # bare hand (modelled in the forearm frame like the game): palm, fingers curled forward, thumb
        h = part(hd)
        Hc = E0 + V(0, -0.29, 0)
        h.add(xform(sphere(6, 4), TRS(Hc + V(0.0, 0.01, 0), (0, 0, 0), (0.04, 0.054, 0.03))), 'skin', hi='soft', sub=2, disp='skin')
        h.add(xform(box(0.034, 0.055, 0.03), TRS(Hc + V(0.022, -0.03, 0), (0, 0, 0.35))), 'skin', hi='soft', sub=2, disp='skin')
        h.add(xform(limb(0.011, 0.009, 0.045, 5, 2), TRS(Hc + V(0.03, 0.02, -s * 0.022), (s * 0.5, 0, -0.6))), 'skin', hi='soft', sub=2, disp='skin')
        for k in range(4):
            h.add(xform(sphere(6, 4), TRS(Hc + V(0.036, -0.008, (k - 1.5) * 0.009), (0, 0, 0), (0.008, 0.008, 0.005))), 'skin', hi='raw', lo=False)


def build_rifle():
    w = part('awpn')
    W0 = WPN
    K = (1.0, 1.12, 1.3)

    def at(x, y, z=0.0):
        return W0 + V(x, y * K[1], z * K[2])

    # Tavor body: stock, receiver, the handguard nose; side profile extruded (chamfered in the bake)
    prof = [(-0.38, 0.004), (-0.235, 0.0), (-0.215, -0.012), (-0.105, -0.012), (-0.09, 0.0), (0.02, 0.006), (0.11, 0.012), (0.142, 0.03), (0.148, 0.055), (0.135, 0.08), (0.105, 0.09), (-0.115, 0.09), (-0.14, 0.096), (-0.36, 0.096), (-0.383, 0.088)]
    body = extrude([(x, y * K[1]) for x, y in prof], 0.045 * K[2])
    xform(body, Matrix.Translation(W0))
    w.add(body, 'gun', hi='hard', bev=0.006)
    # long trigger guard to the handguard, pistol grip, magazine behind the grip
    tg = [(-0.008, -0.008), (-0.004, -0.045), (0.03, -0.056), (0.1, -0.052), (0.124, -0.028), (0.127, 0.012), (0.111, 0.012), (0.107, -0.022), (0.092, -0.038), (0.032, -0.04), (0.01, -0.034), (0.008, -0.008)]
    g = extrude([(x, y * K[1]) for x, y in tg], 0.02 * K[2])
    xform(g, Matrix.Translation(W0))
    w.add(g, 'gun', hi='hard', bev=0.003)
    w.add(xform(box(0.036, 0.092, 0.027 * K[2]), TRS(at(-0.006, -0.03), (0, 0, -0.25))), 'gun', hi='hard', bev=0.008)
    w.add(xform(box(0.042, 0.148, 0.024 * K[2]), TRS(at(-0.163, -0.06), (0, 0, -0.12))), 'gun', hi='hard', bev=0.004)
    # barrel + flash hider
    w.add(xform(cyl(0.0115, 0.0115, 0.14, 6, caps=False), TRS(at(0.215, 0.055), (0, 0, -math.pi / 2))), 'steel', hi='hard', bev=0.001)
    w.add(xform(cyl(0.0145, 0.0145, 0.045, 6), TRS(at(0.29, 0.055), (0, 0, -math.pi / 2))), 'steel', hi='hard', bev=0.002)
    # top rail + red-dot optic (housing, front lens; the red-tinted rear lens and the hood in the bake)
    w.add(xform(box(0.29, 0.014, 0.024 * K[2]), TRS(at(-0.02, 0.097))), 'steel', hi='hard', bev=0.0015)
    w.add(xform(box(0.07, 0.05, 0.036 * K[2]), TRS(at(0.0, 0.128))), 'gun', hi='hard', bev=0.008)
    w.add(xform(box(0.006, 0.03, 0.026 * K[2], 0.002), TRS(at(0.037, 0.13))), 'glass', hi='raw', lo=False)
    w.add(xform(box(0.006, 0.03, 0.026 * K[2], 0.002), TRS(at(-0.037, 0.13))), 'red', hi='raw', lo=False)
    w.add(xform(box(0.02, 0.02, 0.04 * K[2], 0.003), TRS(at(-0.005, 0.163))), 'gun', hi='raw', lo=False)
    # high-only detail: rail slots, ejection port, cheek rest seam, sling swivel, flash-hider slots
    for x in np.arange(-0.15, 0.12, 0.012):
        w.add(xform(box(0.005, 0.006, 0.028 * K[2], 0.0005), TRS(at(x, 0.104))), 'steel', hi='raw', lo=False)
    for s in (-1, 1):
        w.add(xform(box(0.06, 0.022, 0.004, 0.001), TRS(at(-0.24, 0.07, s * 0.0235))), 'steel', hi='raw', lo=False)
        w.add(xform(box(0.2, 0.004, 0.003, 0.001), TRS(at(-0.24, 0.045, s * 0.0235))), 'gun', hi='raw', lo=False)
        w.add(xform(box(0.07, 0.03, 0.004, 0.002), TRS(at(0.06, 0.06, s * 0.0235))), 'gun', hi='raw', lo=False)
    for a in range(4):
        w.add(xform(box(0.03, 0.004, 0.004), TRS(at(0.3, 0.055 + 0.0125 * math.cos(a * math.pi / 2), 0.0125 * math.sin(a * math.pi / 2) / K[2]))), 'glass', hi='raw', lo=False)
    w.add(xform(box(0.012, 0.012, 0.03 * K[2], 0.002), TRS(at(-0.37, 0.05))), 'buckle', hi='raw', lo=False)

# ------------------------------------------------------------------ build all
def build_all():
    build_head()
    build_chest()
    build_hips()
    build_legs()
    build_arms()
    build_rifle()


def mats():
    out = []
    for k in KIND_LIST:
        m = bpy.data.materials.get('k_' + k) or bpy.data.materials.new('k_' + k)
        out.append(m)
    return out


MATS = []


def make_obj(name, bm):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    for m in MATS:
        me.materials.append(m)
    ob.matrix_world = C.G2B
    return ob


def apply_mods(ob):
    C.select([ob])
    for m in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def displace(ob, fn, **kw):
    me = ob.data
    n = len(me.vertices)
    P = np.empty(n * 3)
    N = np.empty(n * 3)
    me.vertices.foreach_get('co', P)
    me.vertices.foreach_get('normal', N)
    P = P.reshape(-1, 3)
    N = N.reshape(-1, 3)
    args = {k: v for k, v in kw.items() if k in fn.__code__.co_varnames}
    d = fn(P, N, **args)
    P = P + N * np.asarray(d)[:, None]
    me.vertices.foreach_set('co', P.ravel())
    me.update()


def high_obj(bone, i, bm, rec):
    ob = make_obj(f'{bone}_hp{i}', bm)
    hi = rec['hi']
    if hi == 'soft':
        # (open rings / tubes: plain subdivision, Catmull-Clark would shrink their open edges away)
        m = ob.modifiers.new('sub', 'SUBSURF')
        m.levels = m.render_levels = rec.get('sub', 2)
        if rec.get('simple'):
            m.subdivision_type = 'SIMPLE'
        apply_mods(ob)
    elif hi == 'hard':
        C.weld(ob)
        m = ob.modifiers.new('bev', 'BEVEL')
        m.width = rec.get('bev', 0.004)
        m.segments = 3
        m.limit_method = 'ANGLE'
        m.angle_limit = math.radians(30)
        m.use_clamp_overlap = True
        if rec.get('disp'):
            s = ob.modifiers.new('sub', 'SUBSURF')
            s.subdivision_type = 'SIMPLE'
            s.levels = s.render_levels = 2
        apply_mods(ob)
    if rec.get('disp'):
        displace(ob, DISP[rec['disp']], **{k: v for k, v in rec.items() if k in ('rings', 'long', 'seed')})
    C.select([ob])
    bpy.ops.object.shade_smooth()
    return ob


# ------------------------------------------------------------------ composite (numpy)
# bounding box of the man (Blender world) for the position pass
BB_MIN = Vector((-0.5, -0.5, -0.05))
BB_SIZE = Vector((1.3, 1.0, 2.1))
SIDE = {}  # flag patch centre and the bone order of the low-poly objects (bone-id pass), saved for 'composite'
TEAM_LIN = 0.62  # albedo under the player-colour mask (linear): the game multiplies it by team / 0.62


def composite(px):
    base = px['base'][..., :3]
    idm = px['id'][..., :3]
    id2 = px['id2'][..., :3]
    team, rough, metal = idm[..., 0], idm[..., 1], idm[..., 2]
    flag, skinm, clothm = id2[..., 0], id2[..., 1], id2[..., 2]
    ao = np.clip(px['ao'][..., 0], 0, 1)
    bone = np.floor(px['bone'][..., 0] * 32).astype(int)
    order = SIDE['bones']

    def isb(*names):
        return np.isin(bone, [order.index(n) for n in names])

    Pb = px['pos'][..., :3] * np.array(BB_SIZE) + np.array(BB_MIN)  # Blender world
    P = np.stack([Pb[..., 0], Pb[..., 2], -Pb[..., 1]], -1)  # game body space (rest pose)
    Nb = px['nrm'][..., :3] * 2 - 1
    Ng = np.stack([Nb[..., 0], Nb[..., 2], -Nb[..., 1]], -1)
    up = Ng[..., 1]
    fine, mid = px['noise'][..., 0], px['noise'][..., 1]
    y = P[..., 1]
    # cloth: faint mottling / sun fading on the uniform and gear (no pattern: IDF olive)
    alb = base * (1 + 0.07 * (mid - 0.5) * clothm)[..., None] * (1 + 0.05 * (fine - 0.5) * clothm)[..., None]
    alb = alb * (1 + 0.05 * np.clip(up, 0, 1) * clothm)[..., None]
    # face: stubble on the jaw / upper lip, ruddier lips
    hrel = P - np.array(HC[:])
    face = skinm * isb('ahead') * (hrel[..., 0] > 0.0)
    jaw = face * nsstep(-0.025, -0.065, hrel[..., 1])
    lips = face * np.exp(-((hrel[..., 1] + 0.053) / 0.009) ** 2) * (np.abs(hrel[..., 2]) < 0.024)
    STUB, LIP = C.hexlin(0x6b5545), C.hexlin(0xa86a58)
    alb = alb + (STUB - alb) * (jaw * 0.4 * (0.75 + 0.5 * fine))[..., None] * (1 - lips)[..., None]
    alb = alb + (LIP - alb) * (lips * 0.45)[..., None]
    # Israeli flag patch: white, two blue stripes, Star of David (from the patch coordinates)
    u0 = np.array(SIDE['flag'])
    fu = (P[..., 0] - u0[0]) / 0.0745 + 0.5  # 0 rear .. 1 front edge
    fv = (P[..., 1] - u0[1]) / 0.052 + 0.5  # 0 bottom .. 1 top
    BLUE = C.hexlin(0x1d3fa8)
    stripe = (np.abs(fv - 0.825) < 0.075) | (np.abs(fv - 0.175) < 0.075)
    cx, cy = (fu - 0.5) * 0.0745 / 0.052, fv - 0.5
    r = np.hypot(cx, cy)
    ang = np.arctan2(cy, cx)

    def tri(rot):
        # projection on the nearest edge normal of an equilateral triangle (edge normals at rot + k 120 deg)
        a = (ang - rot) % (2 * np.pi / 3) - np.pi / 3
        return r * np.cos(a) - 0.105

    star = ((np.abs(tri(np.pi / 2)) < 0.024) | (np.abs(tri(-np.pi / 2)) < 0.024)) & (r < 0.26)
    flagc = np.where((stripe | star)[..., None], BLUE, C.hexlin(0xf0efe8))
    alb = np.where(flag[..., None] > 0.5, flagc, alb)
    # player colour (orm R): the procedural soldier's team marks, painted on the baked surfaces
    q = P - np.array(COVER_CEN[:])
    ct, st = math.cos(TILT), math.sin(TILT)
    qy = -q[..., 0] * st + q[..., 1] * ct  # undo the helmet tilt
    el = np.arcsin(np.clip(qy / np.maximum(np.linalg.norm(q, axis=-1), 1e-6), -1, 1))
    cover = isb('ahead') * (clothm > 0.5)
    t_helmet = cover * ((np.abs(el - 0.31) < 0.075) | (el > 1.2))
    S0 = np.array(SPINE[:])
    c = P - S0
    t_chest = isb('achest') * (clothm > 0.5) * (Ng[..., 0] > 0.6) * (c[..., 0] > 0.14) * (np.abs(c[..., 1] - 0.37) < 0.032) * (np.abs(c[..., 2]) < 0.08)
    px_, py_, pw_, ph_, pd_ = PACK
    t_pack = isb('achest') * (clothm > 0.5) * (Ng[..., 0] < -0.6) * (c[..., 0] < px_ - pw_ / 2 + 0.01) * (np.abs(c[..., 1] - 0.335) < 0.03) * (np.abs(c[..., 2]) < 0.085)
    arm = np.zeros_like(y)
    for nm in ('auaR', 'auaL'):
        a0 = np.array(bp(nm)[:])
        arm = np.maximum(arm, isb(nm) * (clothm > 0.5) * (np.abs(P[..., 1] - (a0[1] - 0.15)) < 0.042) * (flag < 0.5))
    teamm = np.clip(team + t_helmet + t_chest + t_pack + arm, 0, 1)
    alb = np.where(teamm[..., None] > 0.5, TEAM_LIN, alb)
    rough = np.where(teamm > 0.5, 0.62, rough)
    # dust / dirt: boots and trouser hems
    dust = np.clip(nsstep(0.35, 0.05, y) * (0.5 + 0.5 * mid), 0, 1) * (1 - skinm) * (1 - teamm)
    alb = alb + (C.hexlin(0x8d8068) - alb) * (dust * 0.3)[..., None]
    # soft ambient occlusion only (the game lights infantry with its own fill / wrap)
    alb = alb * (AO_FLOOR + (1 - AO_FLOOR) * ao)[..., None]
    rough_o = np.clip(rough + 0.04 * (fine - 0.5) + 0.08 * dust, 0.15, 1)
    C.save_rgb(os.path.join(C.BUILD, NAME + '-albedo.png'), C.lin2srgb(alb), TEX)
    C.save_rgb(os.path.join(C.BUILD, NAME + '-orm.png'), np.stack([teamm, rough_o, np.clip(metal, 0, 1)], -1), TEX)
    used = px['bone'][..., 0] > 0
    print('[soldier] composite: mean albedo of the used texels (srgb)', [round(float(x), 3) for x in C.lin2srgb(alb)[used].mean(0)])


AO_FLOOR = 0.62


def pose_mesh(o, pose):
    """Move a low poly (data in its modelling frame) into the posed body space, the way the game skins it:
    rigid per bone, the chest blended into the spine below the chest joint (Rig.soft)."""
    P = meta['poses'][pose]
    M = mat16(P[o.name]) @ FRAME[o.name]
    if o.name != 'achest':
        o.data.transform(M)
        return
    Ms = mat16(P['aspine']) @ FRAME[o.name]
    for v in o.data.vertices:
        k = sstep(0.06, 0.3, v.co.y)
        v.co = (M @ v.co) * k + (Ms @ v.co) * (1 - k)
    o.data.update()


def studio_renders(lows, pose='aim'):
    pm = C.pbr_material('soldier_pbr', os.path.join(C.BUILD, NAME + '-albedo.png'), os.path.join(C.BUILD, NAME + '-normal.png'), os.path.join(C.BUILD, NAME + '-orm.png'), team=(0.16, 0.42, 1.0))
    for o in list(bpy.data.objects):
        if o.type != 'MESH':
            continue
        if o in lows:
            o.data.materials.clear()
            o.data.materials.append(pm)
            o.hide_render = False
            pose_mesh(o, pose)
            o.matrix_world = C.G2B
        else:
            o.hide_render = True
    # camera in front of the aiming man (as in the reference photo), eye height, a little to his right
    C.studio((2.6, -0.45, 1.5), (0.0, 0.05, 1.33), lens=95, sun=(math.radians(55), 0, math.radians(-30)), size=(768, 576), samples=64, path=os.path.join(C.BUILD, NAME + '-studio.png'))
    C.studio((1.9, -2.2, 1.35), (0.05, 0.0, 0.95), lens=60, sun=(math.radians(50), 0, math.radians(-35)), size=(576, 768), samples=64, path=os.path.join(C.BUILD, NAME + '-studio-q.png'))
    print('[soldier] studio renders written')

# ================================================================== main
if STAGE == 'composite':
    # re-run only the texture composite + studio renders from the saved bakes (fast look iteration)
    C.reset()
    MATS = mats()
    SIDE.update(json.load(open(os.path.join(C.BUILD, NAME + '-side.json'))))
    composite({k: v.astype(np.float32) for k, v in np.load(BAKES).items()})
    lows = [o for o in C.import_glb(os.path.join(C.BUILD, NAME + '-raw.glb')) if o.type == 'MESH']
    for o in lows:
        o.name = o.name.split('.')[0]
        o.data.transform(C.G2B.inverted())  # the importer turned the +Y-up data to +Z-up
        o.matrix_world = Matrix.Identity(4)
    studio_renders(lows)
    print('[soldier] OK_DONE')
    sys.exit(0)

sc = C.reset(threads=4)
MATS = mats()
build_all()

LOWS = []
HIGHS = {}
SMOOTH = ('ahead', 'aneck', 'ahdR', 'ahdL')  # organic parts: smooth shading over the low poly's facets
for bone, p in PARTS.items():
    bmesh.ops.remove_doubles(p.low, verts=p.low.verts, dist=1e-5)
    pass  # (every primitive is built facing outwards: no global recalc, it can flip open pieces inwards)
    bmesh.ops.triangulate(p.low, faces=p.low.faces)
    lo = make_obj(bone, p.low)
    C.smooth_by_angle(lo, 75 if bone in SMOOTH else 40)
    LOWS.append(lo)
    hs = [high_obj(bone, i, b, r) for i, (b, r) in enumerate(p.high)]
    HIGHS[bone] = C.join(hs, bone + '_hp') if hs else None
tri = {o.name: C.tris(o) for o in LOWS}
print('[soldier] low poly tris', tri, 'total', sum(tri.values()))
print('[soldier] high poly faces', {k: len(v.data.polygons) for k, v in HIGHS.items() if v})
SIDE.update({'flag': list(bp('auaL') + V(0.0, -0.06, -0.08)), 'bones': [o.name for o in LOWS]})
json.dump(SIDE, open(os.path.join(C.BUILD, NAME + '-side.json'), 'w'))


def face_factor(o, f):
    """Texel priority per UV island."""
    k = KIND_LIST[f.material_index]
    if o.name == 'ahead' and k == 'skin':
        return 1.8
    if k == 'flag':
        return 3.0
    if k == 'sole':
        return 0.5
    if o.name == 'awpn':
        return 1.25
    if o.name in ('ahdR', 'ahdL'):
        return 1.2
    return 1.0


C.unwrap_pack(LOWS, margin=0.006, angle=70, factor_of_face=face_factor)
bake_mat = C.bake_material('lp_bake')
for o in LOWS:
    # the bake material replaces every slot (the kinds live on in the high poly)
    o.data.materials.clear()
    o.data.materials.append(bake_mat)
    for poly in o.data.polygons:
        poly.material_index = 0


def highs(lo):
    h = HIGHS.get(lo.name)
    return [h] if h else []


def nohighs(lo):
    return []


def hp_pass(kind_):
    for k, m in zip(KIND_LIST, MATS):
        if m.node_tree is None:
            m.use_nodes = True
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        em = nt.nodes.new('ShaderNodeEmission')
        nt.links.new(em.outputs[0], out.inputs[0])
        hexc, ro, me_, tm, fl_, sk, cl = KINDS[k]
        if kind_ == 'base':
            c_ = C.hexlin(hexc)
            em.inputs[0].default_value = (float(c_[0]), float(c_[1]), float(c_[2]), 1)
        elif kind_ == 'id':
            em.inputs[0].default_value = (float(tm), ro, me_, 1)
        elif kind_ == 'id2':
            em.inputs[0].default_value = (float(fl_), float(sk), float(cl), 1)


for m in MATS:
    if m.node_tree is None:
        m.use_nodes = True
IMG = {}
IMG['normal'] = C.new_image(NAME + '_normal', TEX)
C.bake('NORMAL', LOWS, highs, IMG['normal'], samples=2, extrusion=0.012, ray=0.03, margin=8)
print('[soldier] baked normal')
sc.world = bpy.data.worlds.new('bakeworld')
sc.world.light_settings.distance = 0.06
IMG['ao'] = C.new_image(NAME + '_ao', TEX)
C.bake('AO', LOWS, highs, IMG['ao'], samples=48, extrusion=0.012, ray=0.03, margin=8)
print('[soldier] baked ao')
for k in ('base', 'id', 'id2'):
    hp_pass(k)
    IMG[k] = C.new_image(NAME + '_' + k, TEX)
    C.bake('EMIT', LOWS, highs, IMG[k], samples=4, extrusion=0.012, ray=0.03, margin=8)
    print('[soldier] baked', k)
for k in ('pos', 'nrm', 'noise'):
    C.lp_pass(bake_mat, k, BB_MIN, BB_SIZE, IMG['normal'], scale=1.0)
    IMG[k] = C.new_image(NAME + '_' + k, TEX)
    C.bake('EMIT', LOWS, nohighs, IMG[k], samples=1, margin=8)
    print('[soldier] baked', k)
# bone id per texel ((index + 0.5) / 32): each low poly emits its own constant
for i, o in enumerate(LOWS):
    m = C.bake_material(f'bone_{i}')
    em = [n for n in m.node_tree.nodes if n.type == 'EMISSION'][0]
    v = (i + 0.5) / 32
    em.inputs[0].default_value = (v, v, v, 1)
    o.data.materials.clear()
    o.data.materials.append(m)
IMG['bone'] = C.new_image(NAME + '_bone', TEX)
C.bake('EMIT', LOWS, nohighs, IMG['bone'], samples=1, margin=2)
for o in LOWS:
    o.data.materials.clear()
    o.data.materials.append(bake_mat)
print('[soldier] baked bone ids')

px = {k: C.pixels(v) for k, v in IMG.items() if k != 'normal'}
np.savez_compressed(BAKES, **{k: v.astype(np.float16) for k, v in px.items()})
composite(px)
nimg = IMG['normal']
nimg.filepath_raw = os.path.join(C.BUILD, NAME + '-normal.png')
nimg.file_format = 'PNG'
nimg.save()
print('[soldier] textures written')

# hide the high poly for the renders / export
for h in HIGHS.values():
    if h:
        h.hide_render = True
        h.hide_set(True)

# ------------------------------------------------------------------ export: part-local (bone modelling frame)
for o in LOWS:
    o.data.transform(FRAME[o.name].inverted())
    o.matrix_world = C.G2B
C.select(LOWS)
bpy.ops.export_scene.gltf(
    filepath=os.path.join(C.BUILD, NAME + '-raw.glb'),
    export_format='GLB',
    use_selection=True,
    export_materials='NONE',
    export_vertex_color='NONE',
    export_normals=True,
    export_texcoords=True,
    export_apply=True,
    export_yup=True,
)
print('[soldier] export tris', {o.name: C.tris(o) for o in LOWS})
studio_renders(LOWS)
print('[soldier] OK_DONE')

