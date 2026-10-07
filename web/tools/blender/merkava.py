# Blender 5.2.2 (LTS) - Iron Front: Merkava Mk4 (model key "mbt", faction israel) game asset.
#
#   nice -n 10 blender -b --factory-startup -P tools/blender/merkava.py [-- stage]
#   (from web/; run tools/blender/make.sh for the whole pipeline)
#
# Input : build/merkava-proc.glb (+ .json), the game's procedural Merkava dumped by export-procedural.ts,
#         so proportions, footprint, pivots (turret ring, gun trunnion, recoil slide) and the marking /
#         damage / muzzle anchors stay exactly the game's.
# Output: build/merkava-raw.glb (low poly, part-local: body / turret / recoil; pack.mjs adds the LODs)
#         build/merkava-{albedo,normal,orm}.png (2048 normal / 1024 others; make.sh -> WebP)
#         build/merkava-studio-*.png (Cycles studio renders)
#
# High poly = the procedural parts voxel-remeshed (1.4 mm: every edge rounded, no interior faces), plus bolt rows on
# the skirt panels / turret armour modules / deck lids, weld beads along the turret facet seams, the
# glacis break and the bow, louvre slats / diamond mesh on the engine grilles. Low poly = the same parts without the small fittings (baked into the
# normal / AO maps instead) and a one-segment chamfer on the big plates. One shared 1024 atlas for the
# three moving parts: albedo (paint, dust, mud, chips, streaks, grime, AO), orm (R = player colour mask,
# G = roughness, B = metalness) and a tangent-space normal map.
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
STAGE = ARGS[0] if ARGS else 'all'
NAME = 'merkava'
TEX = 1024
NTEX = 2048

meta = json.load(open(os.path.join(C.BUILD, NAME + '-proc.json')))
BAKES = os.path.join(C.BUILD, NAME + '-bakes.npz')
BB_MIN = Vector((-0.75, -0.4, 0.0))
BB_SIZE = Vector((1.6, 0.8, 0.6))

# ------------------------------------------------------------ part frames (Blender space)
T = meta['parts']['turret']['pos']
GP = meta['parts']['gunpiv']
PIV = {
    'body': Matrix.Identity(4),
    'turret': Matrix.Translation(C.g2b(*T)),
    'recoil': Matrix.Translation(C.g2b(*T)) @ Matrix.Translation(C.g2b(*GP['pos'])) @ Matrix.Rotation(-GP['rotZ'], 4, 'Y'),
}


def composite(px):
    """Final albedo / orm maps from the baked inputs (px: name -> (h, w, 4) float arrays)."""
    base = px['base'][..., :3]
    idm = px['id']
    metal = idm[..., 0]
    camo = idm[..., 1]
    ao = np.clip(px['ao'][..., 0], 0, 1)
    edge = px['edge'][..., 0]
    point = px['edge'][..., 1]
    P = px['pos'][..., :3] * np.array(BB_SIZE) + np.array(BB_MIN)
    Nw = px['nrm'][..., :3] * 2 - 1
    fine, mid, streak = px['noise'][..., 0], px['noise'][..., 1], px['noise'][..., 2]
    cells, splat, large = px['noise2'][..., 0], px['noise2'][..., 1], px['noise2'][..., 2]
    z = P[..., 2]
    up = Nw[..., 2]

    # player colour panels (vertex paint = team colour) -> mask, painted a neutral light grey here
    team = C.sstep(0.35, 0.55, base[..., 2]) * (base[..., 0] < 0.12)
    # Sinai grey with large-scale mottling (four shades of the in-game scheme), sun-faded on top
    cols = [C.hexlin(h) for h in (0x9a967a, 0x8b866a, 0x7a7660, 0xa8a488)]
    t = np.clip(large * 1.6 - 0.3, 0, 0.999) * 3
    i0 = np.floor(t).astype(int)
    f = (t - i0)[..., None]
    pal = np.stack(cols)
    mott = pal[i0] * (1 - f) + pal[np.minimum(i0 + 1, 3)] * f
    paint = np.where(camo[..., None] > 0.5, mott * 0.85 + base * 0.15, base)
    paint = paint * (1 + 0.06 * np.clip(up, 0, 1)[..., None])
    lum = (paint * np.array([0.3, 0.59, 0.11])).sum(-1, keepdims=True)
    paint = paint * 0.85 + lum * 0.15  # a touch greyer than the raw scheme (Sinai grey)
    paint = np.where(team[..., None] > 0.5, 0.62, paint)

    convex = C.sstep(0.5, 0.56, point)
    wearE = np.clip(edge * convex * 1.6, 0, 1)
    chips = C.sstep(0.2, 0.5, wearE * (0.55 + 0.9 * fine)) * (cells > 0.3)
    bare = chips * C.sstep(0.55, 0.9, wearE)
    cavity = np.clip((1 - ao) * 1.3, 0, 1)
    dust = np.clip(np.clip(up, 0, 1) ** 2 * (0.35 + 0.5 * mid) + C.sstep(0.24, 0.1, z) * (0.55 + 0.45 * mid), 0, 1)
    mud = C.sstep(0.19, 0.11, z + (mid - 0.5) * 0.06) * (0.6 + 0.4 * fine)
    spl = C.sstep(0.6, 0.68, splat) * C.sstep(0.27, 0.14, z) * (np.abs(up) < 0.7)
    runs = (1 - np.abs(up)) * C.sstep(0.52, 0.72, streak) * (0.5 + 0.5 * mid)

    DUST, MUD, GRIME = C.hexlin(0x9c917a), C.hexlin(0x4b3d2c), C.hexlin(0x37312a)
    PRIMER, STEEL = C.hexlin(0x3e3d34), C.hexlin(0x777772)
    alb = paint.copy()
    alb = alb * (1 + 0.35 * wearE * (1 - metal))[..., None]  # worn, lighter paint on the edges
    alb = alb + (PRIMER - alb) * (chips * 0.9 * (1 - metal))[..., None]
    alb = alb + (STEEL - alb) * (bare * (1 - metal))[..., None]
    alb = alb + (alb * 0.55 + GRIME * 0.15 - alb) * (runs * 0.7)[..., None]
    alb = alb + (DUST - alb) * (dust * 0.5)[..., None]
    alb = alb + (MUD - alb) * np.clip(mud * 0.85 + spl * 0.8, 0, 1)[..., None]
    alb = alb + (GRIME - alb) * (cavity * 0.25)[..., None]
    alb = alb * (0.72 + 0.28 * C.sstep(0.07, 0.27, z))[..., None]  # road film darkening toward the tracks
    alb = alb * (0.35 + 0.65 * ao)[..., None]  # baked ambient occlusion
    alb = alb * (0.9 + 0.12 * np.clip(up, 0, 1))[..., None]  # soft sky light from above
    alb = alb * (0.97 + 0.06 * fine)[..., None]
    rough = np.clip(0.66 + 0.06 * fine + 0.22 * dust + 0.18 * mud - 0.3 * bare - 0.36 * metal + 0.1 * runs, 0.2, 1)
    metl = np.clip(metal * 0.72 + bare * 0.55, 0, 1)
    teamm = np.clip(team * (1 - mud) * (1 - chips * 0.8), 0, 1)

    C.save_rgb(os.path.join(C.BUILD, NAME + '-albedo.png'), C.lin2srgb(alb), TEX)
    C.save_rgb(os.path.join(C.BUILD, NAME + '-orm.png'), np.stack([teamm, rough, metl], -1), TEX)


def studio_renders(lows):
    """Cycles studio renders of the assembled low poly with the final maps (+ the procedural running gear)."""
    pm = C.pbr_material('merkava_pbr', os.path.join(C.BUILD, NAME + '-albedo.png'), os.path.join(C.BUILD, NAME + '-normal.png'), os.path.join(C.BUILD, NAME + '-orm.png'))
    rub = bpy.data.materials.new('running')
    rub.use_nodes = True
    bs = rub.node_tree.nodes['Principled BSDF']
    bs.inputs['Base Color'].default_value = (0.05, 0.05, 0.045, 1)
    bs.inputs['Roughness'].default_value = 0.75
    bs.inputs['Metallic'].default_value = 0.4
    for o in list(bpy.data.objects):
        if o.type != 'MESH':
            continue
        if o in lows:
            o.data.materials.clear()
            o.data.materials.append(pm)
            o.hide_render = False
        elif o.name.startswith('ref|'):
            o.data.materials.clear()
            o.data.materials.append(rub)
            o.hide_render = False
        else:
            o.hide_render = True
    C.studio((1.55, -1.75, 1.05), (0.02, 0, 0.2), lens=55, sun=(math.radians(50), 0, math.radians(-35)), path=os.path.join(C.BUILD, NAME + '-studio-q.png'))
    C.studio((0.02, 3.2, 0.32), (0.02, 0, 0.22), lens=60, sun=(math.radians(55), 0, math.radians(150)), path=os.path.join(C.BUILD, NAME + '-studio-side.png'), size=(1280, 560))
    print('[merkava] studio renders written')


if STAGE == 'composite':
    # re-run only the texture composite + studio renders from the saved bakes (fast look iteration)
    C.reset()
    composite({k: v.astype(np.float32) for k, v in np.load(BAKES).items()})
    for o in C.import_glb(os.path.join(C.BUILD, NAME + '-proc.glb')):
        if not o.name.startswith('ref|'):
            bpy.data.objects.remove(o)
    lows = [o for o in C.import_glb(os.path.join(C.BUILD, NAME + '-raw.glb')) if o.type == 'MESH']
    for o in lows:
        o.matrix_world = PIV[o.name]
    studio_renders(lows)
    print('[merkava] OK_DONE')
    sys.exit(0)


sc = C.reset()
objs = C.import_glb(os.path.join(C.BUILD, NAME + '-proc.glb'))
byname = {o.name: o for o in objs if o.type == 'MESH'}

# ------------------------------------------------------------ source materials (bake passes rewire them)
SINAI = 0x938f74


def src_mat(name):
    m = bpy.data.materials.new('src_' + name)
    m.use_nodes = True
    return m


SRC = {k: src_mat(k) for k in ('camo', 'paint', 'metal', 'bolt', 'weld')}


def hp_pass(kind):
    """Rewire every high-poly source material to emit the data of one bake pass."""
    for k, m in SRC.items():
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        em = nt.nodes.new('ShaderNodeEmission')
        nt.links.new(em.outputs[0], out.inputs[0])
        if kind == 'base':
            if k in ('paint', 'metal'):
                ca = nt.nodes.new('ShaderNodeVertexColor')
                ca.layer_name = 'Color'
                nt.links.new(ca.outputs[0], em.inputs[0])
            else:
                c = C.hexlin(SINAI)
                em.inputs[0].default_value = (float(c[0]), float(c[1]), float(c[2]), 1)
        elif kind == 'id':
            # R = bare metal part, G = camo paint (mottled), B = 0
            em.inputs[0].default_value = (1.0 if k == 'metal' else 0.0, 1.0 if k in ('camo', 'bolt', 'weld') else 0.0, 0.0, 1)
        elif kind == 'edge':
            C.edge_emission(nt, em, 0.0025)


hp_pass('base')

# ------------------------------------------------------------ assemble parts: source, high poly, low poly
PARTS = ('body', 'turret', 'recoil')
# low-poly triangle budget per part: the procedural meshes these replace are 3.6k / 5.9k / 0.7k (LOD0)
BUDGET = {'body': 4700, 'turret': 6300, 'recoil': 900}
src, hp, lp, col = {}, {}, {}, {}
for p in PARTS:
    pieces = []
    for b in ('camo', 'paint', 'metal'):
        o = byname.get(f'{p}|{b}')
        if not o:
            continue
        o.data.materials.clear()
        o.data.materials.append(SRC[b])
        if 'material_index' in o.data.attributes:
            o.data.attributes.remove(o.data.attributes['material_index'])
        pieces.append(o)
    src[p] = C.join(pieces, p + '_src')
    src[p].matrix_world = PIV[p]
    hp[p] = C.hp_remesh(C.dup(src[p], p + '_hp'), 0.0014)
    lp[p] = C.lowpoly(C.dup(src[p], p), BUDGET[p], small=0.008 if p == 'recoil' else 0.02, bevel_from=0.15 if p != 'recoil' else 0.05)
    C.smooth_by_angle(lp[p], 35)
    # colour source for the paint / id bakes: the voxel remesh drops vertex paint and material slots, so
    # those passes read the procedural pieces themselves (welded, touching faces removed)
    col[p] = C.dup(src[p], p + '_col')
    C.weld(col[p])
    import bmesh as _bm
    _b = _bm.new()
    _b.from_mesh(col[p].data)
    C.drop_contact_faces(_b)
    _b.to_mesh(col[p].data)
    _b.free()
    for o in (src[p], col[p]):
        o.hide_render = True
        o.hide_set(True)
for o in list(bpy.data.objects):
    if o.type == 'MESH' and (o.name.startswith('body|glow')):
        o.hide_render = True
        o.hide_set(True)

print('[merkava] low poly tris', {p: C.tris(lp[p]) for p in PARTS}, 'total', sum(C.tris(lp[p]) for p in PARTS))

# ------------------------------------------------------------ high-poly fittings: bolts and weld beads
def L(x, y, z):  # game part-local -> Blender object-local
    return C.g2b(x, y, z)


def side_cast(o, x, y, s):
    return C.cast(o, L(x, y, s * 0.7), L(0, 0, -s))


def top_cast(o, x, z):
    return C.cast(o, L(x, 1.0, z), L(0, -1, 0))


def front_cast(o, y, z, x0=1.0):
    return C.cast(o, L(x0, y, z), L(-1, 0, 0))


def lift(hit, d=0.0):
    return (hit[0] + hit[1] * d, hit[1]) if hit else None


def frange(a, b, step):
    n = max(1, int(round((b - a) / step)))
    return [a + (b - a) * i / n for i in range(n + 1)]


details = {p: [] for p in PARTS}
hb = hp['body']
bolts = []
# skirt panels (mbtMerkava: xs, yb, top(x)): bolt rows along the edges of each sub-panel
xs = [-0.47, -0.31, -0.15, 0.01, 0.17, 0.37]
top = lambda x: 0.27 - (x + 0.47) * 0.011  # noqa: E731
yb = 0.147
for s in (-1, 1):
    for i in range(len(xs) - 1):
        x0, x1 = xs[i] + 0.009, xs[i + 1] - 0.009
        mid = (yb + top((x0 + x1) / 2)) / 2
        rows = [yb + 0.007, top(x0) - 0.008] if i == 4 else [yb + 0.007, mid - 0.007, mid + 0.007, top(x0) - 0.008]
        for y in rows:
            for x in frange(x0, x1, 0.021):
                h = side_cast(hb, x, y, s)
                if h:
                    bolts.append(h)
        for x in (x0, x1):
            for y in frange(yb + 0.02, top(x) - 0.02, 0.024):
                h = side_cast(hb, x, y, s)
                if h:
                    bolts.append(h)
# glacis lids / grille frames and the rear deck edges (from above)
gy = lambda x: 0.272 - (x - 0.08) * 0.1057  # noqa: E731
for (cx, cz, w, d) in ((0.16, 0.12, 0.12, 0.1), (0.49, 0.12, 0.08, 0.08), (0.31, 0.1, 0.17, 0.14), (0.4, -0.07, 0.12, 0.1)):
    for x in frange(cx - w / 2 + 0.006, cx + w / 2 - 0.006, 0.018):
        for z in (cz - d / 2 + 0.006, cz + d / 2 - 0.006):
            h = top_cast(hb, x, z)
            if h:
                bolts.append(h)
    for z in frange(cz - d / 2 + 0.006, cz + d / 2 - 0.006, 0.018):
        for x in (cx - w / 2 + 0.006, cx + w / 2 - 0.006):
            h = top_cast(hb, x, z)
            if h:
                bolts.append(h)
for z in (-0.238, 0.238):
    for x in frange(-0.53, 0.04, 0.03):
        h = top_cast(hb, x, z)
        if h:
            bolts.append(h)
details['body'].append(C.bolt_mesh('body_bolts', bolts))
# welds: glacis break (x = 0.08), the bow lip, rear plate corners
welds = []
for x in (0.08, 0.455):
    pts = [lift(top_cast(hb, x, z)) for z in frange(-0.25, 0.25, 0.004)]
    welds.append([p for p in pts if p])
for y in (0.205, 0.188):
    pts = [lift(front_cast(hb, y, z)) for z in frange(-0.24, 0.24, 0.004)]
    welds.append([p for p in pts if p])
details['body'].append(C.weld_mesh('body_welds', welds))

# engine grilles: louvre slats on the left front skirt panel and the two glacis air grilles, a diamond
# mesh on the right front panel (the procedural model only paints them)
import bmesh  # noqa: E402

gb = bmesh.new()


def obox(center, ax, ay, az, size):
    res = bmesh.ops.create_cube(gb, size=1.0)
    for v in res['verts']:
        q = Vector(v.co)
        v.co = center + ax * (q.x * size[0]) + ay * (q.y * size[1]) + az * (q.z * size[2])


UP = Vector((0, 0, 1))
X = Vector((1, 0, 0))
gx0, gx1 = xs[4] + 0.0016 + 0.014, xs[5] - 0.0016 - 0.014
gy0, gy1 = yb + 0.014, top(xs[5]) - 0.014
gm = (gx0 + gx1) / 2
for (a, b) in ((gx0 + 0.002, gm - 0.005), (gm + 0.005, gx1 - 0.002)):
    for y in frange(gy0 + 0.004, gy1 - 0.004, 0.0075):
        h = side_cast(hb, (a + b) / 2, y, -1)
        if not h:
            continue
        n = h[1].normalized()
        t = (n * math.sin(math.radians(50)) + UP * math.cos(math.radians(50))).normalized()
        obox(h[0] + n * 0.0016, X, X.cross(t).normalized(), t, (b - a, 0.0062, 0.0011))
for iy, y in enumerate(frange(gy0 + 0.004, gy1 - 0.004, 0.0085)):
    for x in frange(gx0 + 0.004 + (0.00425 if iy % 2 else 0), gx1 - 0.004, 0.0085):
        h = side_cast(hb, x, y, 1)
        if not h:
            continue
        n = h[1].normalized()
        r1 = Vector((0.7071, 0, 0.7071))
        r2 = Vector((-0.7071, 0, 0.7071))
        obox(h[0] + n * 0.0008, r1, r2, n, (0.0052, 0.0052, 0.0014))
for (cx, cz, w, d) in ((0.31, 0.1, 0.16, 0.13), (0.4, -0.07, 0.11, 0.09)):
    for x in frange(cx - w / 2 + 0.005, cx + w / 2 - 0.005, 0.0075):
        h = top_cast(hb, x, cz)
        if not h:
            continue
        n = h[1].normalized()
        along = Vector((0, 1, 0))
        t = (n * math.cos(math.radians(45)) + X * math.sin(math.radians(45))).normalized()
        obox(h[0] + n * 0.0016, along, along.cross(t).normalized(), t, (d - 0.008, 0.0062, 0.0011))
gme = bpy.data.meshes.new('body_grilles')
gb.to_mesh(gme)
gb.free()
gob = bpy.data.objects.new('body_grilles', gme)
bpy.context.scene.collection.objects.link(gob)
details['body'].append(gob)

ht = hp['turret']
bolts = []
lean = math.atan2(0.226 * 0.13, 0.058)
for (mx, ml) in ((-0.245, 0.25), (-0.055, 0.118)):
    for s in (-1, 1):
        for y in (0.055 - 0.019, 0.055 + 0.019):
            for x in frange(mx - ml / 2 + 0.008, mx + ml / 2 - 0.008, 0.022):
                h = side_cast(ht, x, y, s)
                if h:
                    bolts.append(h)
for (cx, cz, w, d) in ((-0.25, 0.0, 0.15, 0.2), (0.13, 0.06, 0.09, 0.06), (0.13, -0.06, 0.09, 0.06)):
    for x in frange(cx - w / 2 + 0.006, cx + w / 2 - 0.006, 0.02):
        for z in (cz - d / 2 + 0.006, cz + d / 2 - 0.006):
            h = top_cast(ht, x, z)
            if h:
                bolts.append(h)
details['turret'].append(C.bolt_mesh('turret_bolts', bolts, r=0.0017))
welds = []
for s in (-1, 1):
    for y in (0.027, 0.083):
        pts = [lift(side_cast(ht, x, y, s)) for x in frange(-0.37, 0.43, 0.004)]
        cur = []
        for q in pts:
            if q is None or (cur and (q[0] - cur[-1][0]).length > 0.012):
                if len(cur) > 2:
                    welds.append(cur)
                cur = []
            if q:
                cur.append(q)
        if len(cur) > 2:
            welds.append(cur)
# roof centre seam
pts = [lift(top_cast(ht, x, 0.0)) for x in frange(-0.36, 0.3, 0.004)]
welds.append([p for p in pts if p])
details['turret'].append(C.weld_mesh('turret_welds', welds))

for p in PARTS:
    for d in details[p]:
        d.data.materials.append(SRC['weld' if 'weld' in d.name else 'bolt'])
        d.matrix_world = PIV[p]
    print('[merkava] details', p, [(d.name, len(d.data.polygons)) for d in details[p]])
for p in PARTS:
    hp[p].matrix_world = PIV[p]
    lp[p].matrix_world = PIV[p]

# ------------------------------------------------------------ UV atlas + bakes
LOWS = [lp[p] for p in PARTS]
C.unwrap_atlas(LOWS, margin=0.003, shrink=(0.06, 0.45))
bm = C.bake_material('lp_bake')
for o in LOWS:
    o.data.materials.clear()
    o.data.materials.append(bm)
part_of = {lp[p].name: p for p in PARTS}


def highs(lo):
    p = part_of[lo.name]
    return [hp[p]] + details[p]


def colours(lo):
    p = part_of[lo.name]
    return [col[p]] + details[p]


def nohighs(lo):
    return []


IMG = {}
IMG['normal'] = C.new_image(NAME + '_normal', NTEX)
C.bake('NORMAL', LOWS, highs, IMG['normal'], samples=2, extrusion=0.006, ray=0.016, margin=8)
print('[merkava] baked normal')
sc.world = bpy.data.worlds.new('bakeworld')
sc.world.light_settings.distance = 0.05
IMG['ao'] = C.new_image(NAME + '_ao', TEX)
C.bake('AO', LOWS, highs, IMG['ao'], samples=48, extrusion=0.006, ray=0.016)
print('[merkava] baked ao')
for kind in ('base', 'id', 'edge'):
    hp_pass(kind)
    IMG[kind] = C.new_image(NAME + '_' + kind, TEX)
    C.bake('EMIT', LOWS, highs if kind == 'edge' else colours, IMG[kind], samples=8 if kind == 'edge' else 4, extrusion=0.006, ray=0.016)
    print('[merkava] baked', kind)

# low-poly self passes: world position, world normal (through the baked normal map), world-space noise
for kind in ('pos', 'nrm', 'noise', 'noise2'):
    C.lp_pass(bm, kind, BB_MIN, BB_SIZE, IMG['normal'])
    IMG[kind] = C.new_image(NAME + '_' + kind, TEX)
    C.bake('EMIT', LOWS, nohighs, IMG[kind], samples=1)
    print('[merkava] baked', kind)

# ------------------------------------------------------------ numpy composite
px = {k: C.pixels(v) for k, v in IMG.items() if k != 'normal'}
np.savez_compressed(BAKES, **{k: v.astype(np.float16) for k, v in px.items()})
composite(px)
nimg = IMG['normal']
nimg.filepath_raw = os.path.join(C.BUILD, NAME + '-normal.png')
nimg.file_format = 'PNG'
nimg.save()
print('[merkava] textures written')

# ------------------------------------------------------------ export (part-local, no materials)
export = list(LOWS)  # LOD1 / LOD2: pack.mjs (meshoptimizer, index buffers over these vertices)
print('[merkava] export tris', {o.name: C.tris(o) for o in export})

studio_renders(LOWS)

for o in export:
    o.matrix_world = Matrix.Identity(4)
C.select(export)
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
print('[merkava] OK_DONE')
