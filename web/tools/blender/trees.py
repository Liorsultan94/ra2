# Blender 5.2.2
"""
Iron Front: tree and shrub species for the battlefield (web/src/render/treeassets.ts).

  nice -n 10 /opt/blender/blender -b --factory-startup -P web/tools/blender/trees.py -- \
      --out /tmp/treebake [--only oak,birch] [--stages imp,cards,hero,sheet] [--fpx 96] [--spp 16]
  node web/tools/bake-trees.mjs /tmp/treebake      # WebP + meshopt GLB -> web/public/tex/trees/

Every species is grown procedurally (seeded, so the output is reproducible):
  - real branching (trunk, limbs, branches, twigs: tapered tubes with a root
    flare, phyllotaxis, gravity / light bending), leaves modelled one by one
    (lobed oak, triangular birch, lanceolate willow, needles, pinnate palm
    fronds, acacia leaflets), fruit, snow caps and snow lines on the winter
    species; bark from the CC0 photoscans in public/tex/bark (birch painted here);
  - impostor atlas (multi-angle: 12 azimuths x 3 elevations, a 6 x 6 grid),
    rendered with Cycles in one pass per channel: every frame is a linked
    duplicate of the tree turned so that the one orthographic camera sees it
    from that frame's direction. Channels: albedo (AO folded in) + coverage,
    and octahedral object-space normal + depth + leaf translucency;
  - leaf-card atlas: a typical cluster of each species (a branch with its
    twigs and leaves, a spruce spray, a pine tuft, a willow strand, a palm
    frond, bare birch twigs, ...) rendered flat, plus the four barks;
  - hero mesh: the same tree's trunk and limbs as low-poly tubes and its
    foliage as cards (k-means leaf groups, PCA oriented), vertex AO ray-cast
    against the full model, wind weights (flex) and a leaf flag;
  - a contact sheet of all species (Cycles, sun + sky).
"""
import bpy, bmesh, math, random, sys, os, json, struct, zlib, time
import numpy as np
from mathutils import Vector, Matrix, noise
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.normpath(os.path.join(HERE, '..', '..'))
BARK_DIR = os.path.join(WEB, 'public', 'tex', 'bark')

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def arg(name, default):
    return argv[argv.index(name) + 1] if name in argv else default
OUT = arg('--out', '/tmp/treebake')
ONLY = [s for s in arg('--only', '').split(',') if s]
STAGES = arg('--stages', 'imp,cards,hero,sheet').split(',')
FPX = int(arg('--fpx', '96'))          # impostor frame size (px) of the main atlas
SPP = int(arg('--spp', '16'))
CELL = int(arg('--cell', '256'))       # leaf-card atlas cell (px)
SHEET_W = int(arg('--sheetw', '1800'))
os.makedirs(OUT, exist_ok=True)

V = Vector
UPZ = V((0, 0, 1))

def srgb(*c):
    """sRGB 0..1 components -> linear."""
    if len(c) == 1:
        c = c[0]
    return tuple((x / 12.92) if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)

def hexc(h):
    return srgb(((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255)

# ------------------------------------------------------------------ species
# Units are game units (a tile = 1), Blender Z up. H: total height; the game scales each instance
# by ~0.8 .. 1.6 on top. levels: per branching order below the trunk:
#   n: children (level 1: per trunk; deeper: per unit of parent length), t0/t1: where on the parent,
#   down: angle from the parent (deg) +- var, rot: phyllotaxis step, len: length (x parent length),
#   rad: radius (x parent radius there), seg: segments, grav: droop, up: bend towards the sky,
#   wig: wiggle, shape: crown envelope (level 1 only).
# leaf: shape, length, width, per unit of twig, start (fraction of the twig), angle, colours.

SPECIES = {
    'oak': dict(
        H=1.0, seed=3, stems=1, trunk=dict(len=0.46, r0=0.05, taper=0.55, lean=0.04, wig=0.05, seg=7, flare=1.5),
        crown=dict(c=(0, 0, 0.64), r=(0.48, 0.48, 0.33)),
        levels=[
            dict(n=13, t0=0.48, t1=0.98, down=(66, 12), rot=(137.5, 20), len=(1.2, 0.15), rad=0.62, seg=6, grav=0.22, up=0.22, wig=0.25, shape='spherical'),
            dict(n=14, t0=0.15, t1=1.0, down=(48, 15), rot=(150, 40), len=(0.42, 0.15), rad=0.6, seg=4, grav=0.1, up=0.3, wig=0.35),
            dict(n=30, t0=0.2, t1=1.0, down=(45, 15), rot=(140, 50), len=(0.33, 0.12), rad=0.6, seg=2, grav=0.05, up=0.25, wig=0.4),
        ],
        leaf=dict(shape='oak', len=0.03, wid=0.016, dens=170, start=0.2, ang=55, cols=[0x4e6b2a, 0x5a7a30, 0x3f5e24, 0x6b8536], face_up=0.55),
        bark='oak', bark_tint=(1.0, 1.0, 1.0), flexK=0.045, groups=dict(mode='kmeans', n=40, cross=0.55), cell='oak',
    ),
    'young': dict(
        H=0.74, seed=7, stems=1, trunk=dict(len=0.42, r0=0.026, taper=0.5, lean=0.04, wig=0.06, seg=5, flare=1.3),
        crown=dict(c=(0, 0, 0.5), r=(0.27, 0.27, 0.24)),
        levels=[
            dict(n=7, t0=0.45, t1=0.98, down=(48, 12), rot=(137.5, 20), len=(0.75, 0.2), rad=0.6, seg=4, grav=0.1, up=0.45, wig=0.25, shape='spherical'),
            dict(n=14, t0=0.2, t1=1.0, down=(45, 15), rot=(140, 40), len=(0.45, 0.15), rad=0.6, seg=3, grav=0.08, up=0.3, wig=0.35),
        ],
        leaf=dict(shape='maple', len=0.03, wid=0.026, dens=110, start=0.15, ang=55, cols=[0x5b7d2e, 0x6a8a34, 0x4d6e27], face_up=0.6),
        bark='oak', bark_tint=(0.9, 0.9, 0.85), flexK=0.05, groups=dict(mode='kmeans', n=22, cross=0.55), cell='young',
    ),
    'birch': dict(
        H=1.1, seed=5, stems=2, trunk=dict(len=0.92, r0=0.03, taper=0.25, lean=0.06, wig=0.05, seg=8, flare=1.25),
        crown=dict(c=(0, 0, 0.76), r=(0.27, 0.27, 0.34)),
        levels=[
            dict(n=20, t0=0.36, t1=0.98, down=(40, 10), rot=(137.5, 25), len=(0.6, 0.15), rad=0.5, seg=5, grav=0.25, up=0.2, wig=0.25, shape='tapcyl'),
            dict(n=18, t0=0.15, t1=1.0, down=(40, 15), rot=(140, 40), len=(0.5, 0.15), rad=0.55, seg=4, grav=0.7, up=0.0, wig=0.3),
        ],
        leaf=dict(shape='tri', len=0.022, wid=0.017, dens=210, start=0.2, ang=50, cols=[0x6d8a2c, 0x7a9634, 0x5f7e27, 0x87a03c], face_up=0.4),
        bark='birch', bark_tint=(1, 1, 1), flexK=0.06, groups=dict(mode='kmeans', n=30, cross=0.45), cell='birch',
    ),
    'birch_bare': dict(
        base='birch', leaf=None, snow='lines', twigs=dict(dens=60, len=0.06), cell='birch_bare',
        groups=dict(mode='kmeans', n=26, cross=0.5),
    ),
    'poplar': dict(
        H=1.26, seed=9, stems=1, trunk=dict(len=0.98, r0=0.036, taper=0.2, lean=0.01, wig=0.03, seg=9, flare=1.3),
        crown=dict(c=(0, 0, 0.74), r=(0.17, 0.17, 0.52)),
        levels=[
            dict(n=44, t0=0.12, t1=0.98, down=(22, 6), rot=(137.5, 25), len=(0.42, 0.12), rad=0.45, seg=4, grav=0.0, up=0.6, wig=0.2, shape='flame'),
            dict(n=30, t0=0.15, t1=1.0, down=(30, 10), rot=(140, 40), len=(0.5, 0.15), rad=0.55, seg=2, grav=0.0, up=0.5, wig=0.3),
        ],
        leaf=dict(shape='round', len=0.023, wid=0.022, dens=300, start=0.1, ang=40, cols=[0x5c7e2c, 0x688b33, 0x4f7026], face_up=0.35),
        bark='oak', bark_tint=(0.85, 0.85, 0.8), flexK=0.07, groups=dict(mode='kmeans', n=34, cross=0.6, upright=True), cell='poplar',
    ),
    'willow': dict(
        H=0.88, seed=13, stems=1, trunk=dict(len=0.4, r0=0.058, taper=0.6, lean=0.08, wig=0.08, seg=5, flare=1.5),
        crown=dict(c=(0, 0, 0.6), r=(0.46, 0.46, 0.26)),
        levels=[
            dict(n=7, t0=0.7, t1=1.0, down=(48, 12), rot=(137.5, 25), len=(1.05, 0.15), rad=0.62, seg=6, grav=0.35, up=0.55, wig=0.2, shape='hemi'),
            dict(n=9, t0=0.25, t1=1.0, down=(45, 12), rot=(140, 40), len=(0.4, 0.12), rad=0.55, seg=4, grav=0.9, up=0.1, wig=0.25),
            dict(n=7, t0=0.2, t1=1.0, down=(30, 12), rot=(140, 40), len=(0.0, 0.0), rad=0.5, seg=5, grav=0.0, up=0.0, wig=0.15, strand=(0.3, 0.14)),
        ],
        leaf=dict(shape='lance', len=0.03, wid=0.0065, dens=190, start=0.05, ang=35, cols=[0x7c9638, 0x6d8a32, 0x8aa244, 0x5f7d2c], face_up=0.15),
        bark='oak', bark_tint=(0.82, 0.8, 0.74), flexK=0.05, groups=dict(mode='strands', n=34, crown=18, cross=0.45), cell='willow',
    ),
    'fruit': dict(
        H=0.7, seed=17, stems=1, trunk=dict(len=0.3, r0=0.034, taper=0.6, lean=0.05, wig=0.08, seg=4, flare=1.3),
        crown=dict(c=(0, 0, 0.47), r=(0.36, 0.36, 0.22)),
        levels=[
            dict(n=5, t0=0.85, t1=1.0, down=(50, 10), rot=(137.5, 25), len=(1.3, 0.2), rad=0.7, seg=5, grav=0.2, up=0.35, wig=0.35, shape='hemi'),
            dict(n=12, t0=0.15, t1=1.0, down=(50, 15), rot=(140, 40), len=(0.45, 0.15), rad=0.6, seg=3, grav=0.15, up=0.3, wig=0.4),
        ],
        leaf=dict(shape='ovate', len=0.026, wid=0.014, dens=140, start=0.15, ang=55, cols=[0x5a7c2c, 0x678a32, 0x4f7027], face_up=0.6),
        fruit=dict(p=0.25, r=0.011, cols=[0xb32a1c, 0xc8471f, 0xd9a032]),
        bark='oak', bark_tint=(0.8, 0.76, 0.72), flexK=0.04, groups=dict(mode='kmeans', n=26, cross=0.55), cell='fruit',
    ),
    'acacia': dict(
        H=0.94, seed=19, stems=3, trunk=dict(len=0.62, r0=0.026, taper=0.45, lean=0.2, wig=0.12, seg=5, flare=1.4, fork=0.3),
        crown=dict(c=(0, 0, 0.84), r=(0.5, 0.5, 0.1)),
        levels=[
            dict(n=6, t0=0.55, t1=1.0, down=(58, 12), rot=(137.5, 30), len=(1.15, 0.2), rad=0.6, seg=5, grav=0.0, up=0.2, wig=0.3, shape='cyl', flat=0.8),
            dict(n=12, t0=0.2, t1=1.0, down=(65, 15), rot=(140, 40), len=(0.55, 0.15), rad=0.6, seg=3, grav=0.0, up=0.0, wig=0.4, flat=0.84),
        ],
        leaf=dict(shape='leaflets', len=0.05, wid=0.03, dens=45, start=0.3, ang=60, cols=[0x6b7a34, 0x7a8740, 0x5d6d2d], face_up=0.95),
        bark='oak', bark_tint=(0.62, 0.55, 0.5), flexK=0.035, groups=dict(mode='kmeans', n=30, cross=0.25, flat=True), cell='acacia',
    ),
    'spruce': dict(
        H=1.05, seed=11, stems=1, conifer=True, trunk=dict(len=1.0, r0=0.04, taper=0.12, lean=0.0, wig=0.015, seg=10, flare=1.35),
        crown=dict(c=(0, 0, 0.55), r=(0.36, 0.36, 0.5)),
        levels=[
            dict(n=64, t0=0.07, t1=0.97, down=(95, 8), rot=(137.5, 20), len=(0.78, 0.1), rad=0.45, seg=5, grav=0.38, up=0.3, wig=0.12, shape='conical'),
            dict(n=30, t0=0.05, t1=0.95, down=(55, 10), rot=(180, 15), len=(0.42, 0.12), rad=0.55, seg=3, grav=0.2, up=0.0, wig=0.2, plane=True),
        ],
        leaf=dict(shape='needles', len=0.022, wid=0.0022, dens=900, start=0.0, ang=60, cols=[0x23402a, 0x2a4a30, 0x1f3a26, 0x31533a], face_up=0.0),
        bark='pine', bark_tint=(0.7, 0.62, 0.58), flexK=0.03, groups=dict(mode='branch', level=1, cross=0.0), cell='spruce',
    ),
    'spruce_snow': dict(base='spruce', snow='caps', cell='spruce_snow'),
    'pine': dict(
        H=1.06, seed=23, stems=1, conifer=True, trunk=dict(len=0.88, r0=0.036, taper=0.32, lean=0.05, wig=0.05, seg=8, flare=1.3),
        crown=dict(c=(0.03, 0, 0.82), r=(0.32, 0.3, 0.19)),
        levels=[
            dict(n=16, t0=0.6, t1=0.98, down=(64, 15), rot=(137.5, 30), len=(0.75, 0.12), rad=0.45, seg=5, grav=0.08, up=0.4, wig=0.35, shape='hemi'),
            dict(n=22, t0=0.3, t1=1.0, down=(45, 15), rot=(140, 40), len=(0.45, 0.12), rad=0.55, seg=3, grav=0.05, up=0.35, wig=0.4),
            dict(n=20, t0=0.3, t1=1.0, down=(40, 15), rot=(140, 40), len=(0.4, 0.12), rad=0.55, seg=2, grav=0.0, up=0.3, wig=0.4),
        ],
        leaf=dict(shape='tufts', len=0.036, wid=0.002, dens=1100, start=0.35, ang=35, cols=[0x37542c, 0x40603a, 0x2f4a28], face_up=0.0),
        bark='pine', bark_tint=(1.0, 0.92, 0.85), bark_top=(1.25, 0.82, 0.55), flexK=0.034, groups=dict(mode='kmeans', n=24, cross=0.6), cell='pine',
    ),
    'pine_snow': dict(base='pine', snow='caps', cell='pine_snow'),
    'palm': dict(
        H=1.34, seed=29, palm=True, trunk=dict(len=0.8, r0=0.05, taper=0.62, lean=0.13, wig=0.02, seg=10, flare=1.35),
        crown=dict(c=(0.13, 0, 1.1), r=(0.62, 0.62, 0.28)),
        fronds=dict(n=18, dead=5, len=0.62, leaflets=34),
        leaf=dict(shape='lance', len=0.13, wid=0.012, cols=[0x5d7334, 0x6b8038, 0x52682c, 0x7a8a40]),
        bark='palm', bark_tint=(1, 1, 1), flexK=0.05, groups=dict(mode='fronds'), cell='palm',
    ),
    'bush': dict(
        H=0.34, seed=31, stems=6, shrub=True, trunk=dict(len=0.16, r0=0.011, taper=0.5, lean=0.5, wig=0.1, seg=3, flare=1.0),
        crown=dict(c=(0, 0, 0.18), r=(0.25, 0.25, 0.16)),
        levels=[
            dict(n=6, t0=0.3, t1=1.0, down=(40, 15), rot=(137.5, 30), len=(1.1, 0.2), rad=0.7, seg=3, grav=0.15, up=0.2, wig=0.4, shape='spherical'),
            dict(n=30, t0=0.2, t1=1.0, down=(45, 15), rot=(140, 40), len=(0.45, 0.15), rad=0.6, seg=2, grav=0.05, up=0.2, wig=0.4),
        ],
        leaf=dict(shape='ovate', len=0.018, wid=0.01, dens=260, start=0.1, ang=55, cols=[0x4f6e2a, 0x5b7a30, 0x46632a], face_up=0.5),
        bark='oak', bark_tint=(0.75, 0.7, 0.65), flexK=0.02, groups=dict(mode='kmeans', n=14, cross=0.6), cell='bush',
    ),
    'bush_bare': dict(base='bush', leaf=None, snow='lines', twigs=dict(dens=90, len=0.035), cell='bush_bare', groups=dict(mode='kmeans', n=12, cross=0.6)),
    'hedge': dict(
        H=0.34, seed=37, stems=8, shrub=True, trunk=dict(len=0.14, r0=0.009, taper=0.5, lean=0.25, wig=0.08, seg=3, flare=1.0),
        crown=dict(c=(0, 0, 0.18), r=(0.22, 0.22, 0.17)), clip=0.92,
        levels=[
            dict(n=6, t0=0.3, t1=1.0, down=(30, 12), rot=(137.5, 30), len=(1.2, 0.15), rad=0.7, seg=3, grav=0.0, up=0.4, wig=0.4, shape='cyl'),
            dict(n=26, t0=0.1, t1=1.0, down=(50, 15), rot=(140, 40), len=(0.4, 0.15), rad=0.6, seg=2, grav=0.0, up=0.2, wig=0.4),
        ],
        leaf=dict(shape='ovate', len=0.016, wid=0.008, dens=230, start=0.0, ang=55, cols=[0x3b5a24, 0x456629, 0x35511f], face_up=0.45),
        bark='oak', bark_tint=(0.7, 0.66, 0.6), flexK=0.015, groups=dict(mode='kmeans', n=16, cross=0.7), cell='hedge',
    ),
    'scrub': dict(
        H=0.2, seed=41, stems=7, shrub=True, trunk=dict(len=0.08, r0=0.008, taper=0.5, lean=0.8, wig=0.15, seg=3, flare=1.0),
        crown=dict(c=(0, 0, 0.1), r=(0.21, 0.21, 0.09)),
        levels=[
            dict(n=5, t0=0.3, t1=1.0, down=(45, 15), rot=(137.5, 30), len=(1.3, 0.25), rad=0.7, seg=3, grav=0.05, up=0.1, wig=0.5, shape='spherical'),
            dict(n=26, t0=0.2, t1=1.0, down=(50, 15), rot=(140, 40), len=(0.4, 0.15), rad=0.6, seg=2, grav=0.0, up=0.1, wig=0.5),
        ],
        leaf=dict(shape='ovate', len=0.011, wid=0.005, dens=170, start=0.25, ang=55, cols=[0x7a7d50, 0x6c7346, 0x878a5c], face_up=0.5),
        bark='oak', bark_tint=(0.75, 0.68, 0.6), flexK=0.02, groups=dict(mode='kmeans', n=12, cross=0.5), cell='scrub',
    ),
}
ORDER = ['oak', 'young', 'birch', 'poplar', 'willow', 'fruit', 'spruce', 'pine', 'palm', 'acacia',
         'spruce_snow', 'pine_snow', 'birch_bare', 'bush', 'hedge', 'scrub', 'bush_bare']
# leaf-card atlas cells (6 x 4): one cluster per species, extra strips, then the barks
CELLS = ['oak', 'young', 'birch', 'poplar', 'willow', 'fruit', 'spruce', 'pine', 'palm', 'acacia',
         'spruce_snow', 'pine_snow', 'birch_bare', 'bush', 'hedge', 'scrub', 'bush_bare', 'willow_strand',
         'palm_dead', 'bark_oak', 'bark_birch', 'bark_pine', 'bark_palm', 'bark_pine_top']
CGRID = (6, 4)

def spec(name):
    s = SPECIES[name]
    if 'base' not in s:
        return dict(s, name=name)
    b = dict(SPECIES[s['base']])
    b.update({k: v for k, v in s.items() if k != 'base'})
    b['name'] = name
    return b

# ------------------------------------------------------------------ growth

class Branch:
    __slots__ = ('pts', 'rad', 'level', 'kids', 'leaves', 'strand', 'cum', 'parent')
    def __init__(self, pts, rad, level):
        self.pts, self.rad, self.level = pts, rad, level
        self.kids, self.leaves, self.strand, self.parent = [], [], False, None
        self.cum = [0.0]
        for i in range(1, len(pts)):
            self.cum.append(self.cum[-1] + (pts[i] - pts[i - 1]).length)
    @property
    def length(self):
        return self.cum[-1]
    def at(self, t):
        """point, direction, radius at fraction t of the length."""
        L = t * self.length
        for i in range(1, len(self.pts)):
            if self.cum[i] >= L or i == len(self.pts) - 1:
                seg = max(1e-9, self.cum[i] - self.cum[i - 1])
                f = min(1.0, max(0.0, (L - self.cum[i - 1]) / seg))
                p = self.pts[i - 1].lerp(self.pts[i], f)
                d = (self.pts[i] - self.pts[i - 1]).normalized()
                r = self.rad[i - 1] + (self.rad[i] - self.rad[i - 1]) * f
                return p, d, r
        return self.pts[-1], V((0, 0, 1)), self.rad[-1]

def perp(d):
    a = V((0, 0, 1)) if abs(d.z) < 0.95 else V((1, 0, 0))
    return d.cross(a).normalized()

def rot_about(v, axis, ang):
    return (Matrix.Rotation(ang, 3, axis) @ v)

def shape_env(shape, r):
    r = min(1.0, max(0.0, r))
    if shape == 'conical':
        return 0.12 + 0.88 * (1 - r)
    if shape == 'spherical':
        return 0.25 + 0.75 * math.sin(math.pi * (0.1 + 0.85 * r))
    if shape == 'hemi':
        return 0.35 + 0.65 * math.sin(0.5 * math.pi * (1 - r * 0.7))
    if shape == 'flame':
        return (0.35 + 0.65 * r / 0.55) if r <= 0.55 else max(0.1, (1 - r) / 0.45)
    if shape == 'tapcyl':
        return 0.55 + 0.45 * (1 - r)
    return 1.0

def grow_curve(rng, p0, d0, L, r0, r1, seg, grav, up, wig, flat=None, droop_end=0.0):
    pts, rad = [p0.copy()], [r0]
    d = d0.normalized()
    step = L / seg
    p = p0.copy()
    for i in range(seg):
        t = (i + 1) / seg
        n = V((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1)))
        d = (d + V((0, 0, -grav * step * 4.0 * (0.5 + t))) + V((0, 0, up * step * 3.0)) + n * wig * step * 3.0).normalized()
        if flat is not None and p.z > flat:
            d.z *= 0.35
            d.normalize()
        p = p + d * step
        pts.append(p.copy())
        rad.append(r0 + (r1 - r0) * t)
    return Branch(pts, rad, 0)

def grow_tree(sp, rng):
    """Skeleton + leaves of one tree (Blender units, Z up)."""
    T = sp['trunk']
    H = sp['H']
    trunks = []
    stems = sp.get('stems', 1)
    for k in range(stems):
        a = rng.uniform(0, 2 * math.pi) + k * 2 * math.pi / max(1, stems)
        if sp.get('shrub'):
            d0 = V((math.cos(a) * T['lean'], math.sin(a) * T['lean'], 1.0))
            base = V((math.cos(a) * 0.02, math.sin(a) * 0.02, 0))
            L = T['len'] * H * rng.uniform(0.8, 1.15)
            r0 = T['r0']
        elif stems > 1:
            # forked: a short common bole, then the stems diverge
            fork = T.get('fork', 0.12)
            lean = T['lean'] * rng.uniform(0.8, 1.3)
            d0 = V((math.cos(a) * lean, math.sin(a) * lean, 1.0))
            base = V((math.cos(a) * T['r0'] * 0.5, math.sin(a) * T['r0'] * 0.5, 0))
            L = T['len'] * H * rng.uniform(0.85, 1.05) * (1 - fork * 0.3)
            r0 = T['r0'] * (0.8 if k else 0.9)
        else:
            d0 = V((math.cos(a) * T['lean'], math.sin(a) * T['lean'], 1.0))
            base = V((0, 0, 0))
            L = T['len'] * H
            r0 = T['r0']
        tr = grow_curve(rng, base, d0, L, r0, r0 * T['taper'], T['seg'], 0.0, 0.25, T['wig'])
        tr.level = 0
        tr.rad[0] *= T.get('flare', 1.0)
        trunks.append(tr)
    allb = list(trunks)
    levels = sp.get('levels', [])
    def spawn(parent, li):
        if li >= len(levels):
            return
        P = levels[li]
        if li == 0:
            count = P['n']
        else:
            count = max(1, int(round(P['n'] * parent.length / max(1e-3, H * 0.3))))
        phi = rng.uniform(0, 2 * math.pi)
        for i in range(count):
            t = P['t0'] + (P['t1'] - P['t0']) * (i + rng.uniform(0.2, 0.8)) / count
            p, d, r = parent.at(t)
            phi += math.radians(P['rot'][0] + rng.uniform(-1, 1) * P['rot'][1])
            down = math.radians(P['down'][0] + rng.uniform(-1, 1) * P['down'][1])
            ax = perp(d)
            ax = rot_about(ax, d, phi)
            if P.get('plane'):
                # flat sprays (spruce): side shoots stay in the branch's horizontal plane
                side = d.cross(UPZ)
                if side.length < 1e-4:
                    side = perp(d)
                side.normalize()
                cd = (d * math.cos(down) + side * math.sin(down) * (1 if i % 2 else -1)).normalized()
                cd.z += rng.uniform(-0.1, 0.1)
                cd.normalize()
            else:
                cd = rot_about(d, ax, down).normalized()
            if li == 0:
                rel = (p.z - 0.0) / max(1e-3, H)
                crown0 = P['t0'] * parent.length / max(1e-3, H)
                env = shape_env(P.get('shape', 'cyl'), (rel - crown0) / max(1e-3, 1 - crown0))
                L = P['len'][0] * H * 0.5 * env * (1 + rng.uniform(-1, 1) * P['len'][1])
            else:
                L = P['len'][0] * parent.length * (1 - 0.35 * t) * (1 + rng.uniform(-1, 1) * P['len'][1])
            if P.get('strand'):
                L = H * (P['strand'][0] + rng.uniform(-1, 1) * P['strand'][1])
                # willow strands: a short arch out, then straight down
                cd = (cd * 0.3 + V((0, 0, -1))).normalized()
            if L < 0.008:
                continue
            r0 = max(0.0012, min(r * 0.85, r * P['rad']))
            flat = P.get('flat')
            b = grow_curve(rng, p, cd, L, r0, max(0.0008, r0 * 0.3), P['seg'], P['grav'], P['up'], P['wig'], flat=(flat * H if flat else None))
            b.level = li + 1
            b.parent = parent
            b.strand = bool(P.get('strand'))
            parent.kids.append(b)
            allb.append(b)
            spawn(b, li + 1)
    for tr in trunks:
        spawn(tr, 0)
    return trunks, allb

def terminal(b):
    return not b.kids

# ------------------------------------------------------------------ leaves

def leaf_outline(shape, n=6):
    """Half-width profile y(x), x 0..1 (petiole to tip)."""
    xs = [i / n for i in range(n + 1)]
    ys = []
    for x in xs:
        s = math.sin(math.pi * x)
        if shape == 'oak':
            y = (0.55 + 0.45 * abs(math.sin(4.0 * math.pi * x + 0.3))) * s ** 0.6
        elif shape == 'maple':
            y = (0.6 + 0.4 * abs(math.sin(2.5 * math.pi * x))) * s ** 0.5
        elif shape == 'tri':
            y = (1 - x) ** 0.8 * min(1, x * 5)
        elif shape == 'round':
            y = s ** 0.55
        elif shape == 'lance':
            y = s ** 0.9
        else:  # ovate
            y = s ** 0.75 * (1 - 0.25 * x)
        ys.append(y)
    return xs, ys

class MeshAcc:
    """Accumulates triangles with per-corner attributes."""
    def __init__(self):
        self.v, self.f, self.uv, self.mat = [], [], [], []
        self.col, self.tr, self.cn = [], [], []   # per vertex: colour, translucency, crown normal
    def vert(self, p, col, tr, cn):
        self.v.append(tuple(p)); self.col.append(col); self.tr.append(tr); self.cn.append(tuple(cn))
        return len(self.v) - 1
    def tri(self, a, b, c, uva, uvb, uvc, m):
        self.f.append((a, b, c)); self.uv.append((uva, uvb, uvc)); self.mat.append(m)

M_BARK, M_LEAF, M_SNOW, M_FRUIT = 0, 1, 2, 3

def crown_normal(sp, p):
    C = V(sp['crown']['c']); R = V(sp['crown']['r'])
    q = V(((p.x - C.x) / R.x, (p.y - C.y) / R.y, (p.z - C.z) / R.z))
    if q.length < 1e-5:
        return V((0, 0, 1))
    return (q.normalized() + V((0, 0, 0.25))).normalized()

def add_leaf(acc, sp, rng, base, axis, normal, L, W, col, shape, fold=0.25, curl=0.15, tr=1.0, n=6):
    xs, ys = leaf_outline(shape, n)
    side = normal.cross(axis).normalized()
    cn = crown_normal(sp, base + axis * L * 0.5)
    ids = []
    for x, y in zip(xs, ys):
        bend = normal * (-curl * L * x * x)
        c0 = base + axis * (L * x) + bend
        top = c0 + side * (y * W) + normal * (fold * y * W)
        bot = c0 - side * (y * W) + normal * (fold * y * W)
        ids.append((acc.vert(top, col, tr, cn), acc.vert(bot, col, tr, cn), x, y))
    for i in range(len(ids) - 1):
        a0, b0, x0, _ = ids[i]
        a1, b1, x1, _ = ids[i + 1]
        acc.tri(a0, b0, a1, (x0, 1), (x0, 0), (x1, 1), M_LEAF)
        acc.tri(b0, b1, a1, (x0, 0), (x1, 0), (x1, 1), M_LEAF)

def jitter_col(rng, cols, k=0.12):
    c = hexc(rng.choice(cols))
    v = 1 + rng.uniform(-k, k)
    h = rng.uniform(-k, k) * 0.5
    return (max(0, c[0] * v * (1 + h)), max(0, c[1] * v), max(0, c[2] * v * (1 - h)), 1.0)

def leaf_dir(rng, d, ang, face_up, outward):
    ax = rot_about(perp(d), d, rng.uniform(0, 2 * math.pi))
    a = rot_about(d, ax, math.radians(ang * rng.uniform(0.7, 1.2))).normalized()
    a = (a + outward * 0.25).normalized()
    nrm = a.cross(perp(a)).normalized()
    nrm = rot_about(nrm, a, rng.uniform(0, 2 * math.pi))
    nrm = (nrm * (1 - face_up) + UPZ * face_up + outward * 0.2)
    nrm = (nrm - a * nrm.dot(a)).normalized() if nrm.length > 1e-5 else perp(a)
    return a, nrm

def add_needles(acc, sp, rng, b, lf, tuft=False):
    """Needles around a twig (spruce: all along it, pine: brushes at the tips)."""
    L = lf['len']; W = lf['wid']
    n = max(4, int(lf['dens'] * b.length * (0.45 if tuft else 1)))
    t0 = lf.get('start', 0.0)
    for i in range(n):
        t = t0 + (1 - t0) * (i + rng.random()) / n
        p, d, r = b.at(t)
        side = rot_about(perp(d), d, rng.uniform(0, 2 * math.pi))
        a = (d * math.cos(math.radians(lf['ang'])) + side * math.sin(math.radians(lf['ang']))).normalized()
        if not tuft:
            a = (a + V((0, 0, 0.35))).normalized()
        ll = L * rng.uniform(0.75, 1.2)
        col = jitter_col(rng, lf['cols'], 0.15)
        cn = crown_normal(sp, p)
        q0 = p + side * r
        q1 = q0 + a * ll
        w = side.cross(a).normalized() * W
        i0 = acc.vert(q0 - w, col, 0.55, cn); i1 = acc.vert(q0 + w, col, 0.55, cn); i2 = acc.vert(q1, col, 0.55, cn)
        acc.tri(i0, i1, i2, (0, 0), (0, 1), (1, 0.5), M_LEAF)

def add_leaflets(acc, sp, rng, b, lf):
    """Acacia: bipinnate sprays of tiny leaflets, lying flat (seen from above as a fine green lace)."""
    n = max(2, int(lf['dens'] * b.length))
    for i in range(n):
        t = lf['start'] + (1 - lf['start']) * (i + rng.random()) / n
        p, d, r = b.at(t)
        side = d.cross(UPZ)
        if side.length < 1e-4:
            side = perp(d)
        side.normalize()
        a = (d * 0.5 + side * (1 if i % 2 else -1)).normalized()
        a.z = 0.08
        a.normalize()
        L = lf['len'] * rng.uniform(0.7, 1.2)
        col = jitter_col(rng, lf['cols'], 0.1)
        # rachis with pairs of tiny leaflets
        nn = 9
        for k in range(nn):
            q = p + a * (L * (k + 0.5) / nn)
            for s in (-1, 1):
                ax = (a * 0.35 + a.cross(UPZ).normalized() * s).normalized()
                add_leaf(acc, sp, rng, q, ax, V((0, 0, 1)), lf['wid'] * 0.55, lf['wid'] * 0.16, col, 'ovate', fold=0.1, curl=0.0, n=2)

def add_snow_cap(acc, sp, rng, b, k=1.0):
    """Snow resting on a branch: a lumpy flattened ridge along its upper side."""
    n = max(2, int(b.length / 0.03))
    col = (0.86, 0.89, 0.93, 1)
    for i in range(n):
        t = (i + 0.5) / n
        p, d, r = b.at(t)
        if d.z < -0.6:
            continue
        w = (0.018 + r * 1.5) * k * (1.0 - 0.5 * t) * rng.uniform(0.7, 1.2)
        side = d.cross(UPZ)
        if side.length < 1e-4:
            continue
        side.normalize()
        c = p + V((0, 0, r + w * 0.25))
        seg = b.length / n * 0.65
        cn = V((0, 0, 1))
        # a low tent of 4 triangles
        a0 = acc.vert(c - d * seg + side * w, col, 0.0, cn)
        a1 = acc.vert(c - d * seg - side * w, col, 0.0, cn)
        a2 = acc.vert(c + d * seg + side * w * 0.8, col, 0.0, cn)
        a3 = acc.vert(c + d * seg - side * w * 0.8, col, 0.0, cn)
        m0 = acc.vert(c - d * seg + V((0, 0, w * 0.45)), col, 0.0, cn)
        m1 = acc.vert(c + d * seg + V((0, 0, w * 0.4)), col, 0.0, cn)
        for (x, y, z) in ((a0, m0, a2), (m0, m1, a2), (a1, a3, m0), (m0, a3, m1)):
            acc.tri(x, y, z, (0, 0), (0.5, 1), (1, 0), M_SNOW)

def dress(sp, rng, allb, acc):
    """Leaves, needles, fruit, twigs and snow on a grown skeleton."""
    lf = sp.get('leaf')
    C = V(sp['crown']['c'])
    clip = sp.get('clip')
    R = V(sp['crown']['r'])
    for b in allb:
        if not terminal(b) or b.level == 0:
            continue
        if lf is None:
            continue
        if lf['shape'] == 'needles':
            add_needles(acc, sp, rng, b, lf)
            continue
        if lf['shape'] == 'tufts':
            add_needles(acc, sp, rng, b, lf, tuft=True)
            continue
        if lf['shape'] == 'leaflets':
            add_leaflets(acc, sp, rng, b, lf)
            continue
        n = max(2, int(lf['dens'] * b.length))
        for i in range(n):
            t = lf['start'] + (1 - lf['start']) * (i + rng.random()) / n
            p, d, r = b.at(t)
            out = (p - C)
            out = out.normalized() if out.length > 1e-4 else UPZ.copy()
            if clip:
                q = V(((p.x - C.x) / R.x, (p.y - C.y) / R.y, (p.z - C.z) / R.z))
                if max(abs(q.x), abs(q.y)) ** 4 + abs(q.z) ** 4 > clip ** 4 * 1.6:
                    continue
            a, nrm = leaf_dir(rng, d, lf['ang'], lf.get('face_up', 0.5), out)
            if b.strand:
                a = (a * 0.4 + d * 0.8).normalized()
                nrm = (nrm - a * nrm.dot(a)).normalized()
            L = lf['len'] * rng.uniform(0.75, 1.25)
            W = lf['wid'] * rng.uniform(0.8, 1.2)
            col = jitter_col(rng, lf['cols'], 0.12)
            # now and then an older, yellower leaf
            if rng.random() < 0.06:
                col = (col[0] * 1.5, col[1] * 1.15, col[2] * 0.6, 1)
            add_leaf(acc, sp, rng, p + nrm * r * 0.5, a, nrm, L, W, col, lf['shape'])
        fr = sp.get('fruit')
        if fr and rng.random() < fr['p'] * b.length / 0.05:
            p, d, r = b.at(rng.uniform(0.5, 1.0))
            add_sphere(acc, p + V((0, 0, -fr['r'] * 1.2)), fr['r'] * rng.uniform(0.8, 1.2), jitter_col(rng, fr['cols'], 0.1), M_FRUIT, sp)
    tw = sp.get('twigs')
    if tw:
        add_twigs(sp, rng, allb, tw)
    snow = sp.get('snow')
    if snow:
        for b in allb:
            if snow == 'caps' and b.level >= 1:
                add_snow_cap(acc, sp, rng, b, 1.25 if b.level == 1 else 0.8)
            elif snow == 'lines' and b.level <= 2 and b.rad[0] > 0.004:
                add_snow_cap(acc, sp, rng, b, 0.45)

def add_twigs(sp, rng, allb, tw):
    """Bare winter crowns: a fine net of thin twigs on the terminal branches."""
    extra = []
    for b in list(allb):
        if b.level == 0 or not terminal(b):
            continue
        n = max(2, int(tw['dens'] * b.length))
        for i in range(n):
            t = 0.1 + 0.9 * (i + rng.random()) / n
            p, d, r = b.at(t)
            ax = rot_about(perp(d), d, rng.uniform(0, 2 * math.pi))
            cd = rot_about(d, ax, math.radians(rng.uniform(25, 55))).normalized()
            if sp['name'].startswith('birch'):
                cd = (cd + V((0, 0, -0.6))).normalized()
            L = tw['len'] * rng.uniform(0.6, 1.3)
            c = grow_curve(rng, p, cd, L, max(0.0009, r * 0.6), 0.0006, 2, 0.4 if sp['name'].startswith('birch') else 0.0, 0.1, 0.4)
            c.level = b.level + 1
            c.parent = b
            b.kids.append(c)
            extra.append(c)
    allb.extend(extra)

def add_sphere(acc, c, r, col, m, sp):
    ico = [V((0, 0, 1)), V((0, 0, -1))]
    ring = 6
    for k in range(ring):
        a = 2 * math.pi * k / ring
        ico.append(V((math.cos(a) * 0.8, math.sin(a) * 0.8, 0.45)))
        ico.append(V((math.cos(a + 0.5) * 0.8, math.sin(a + 0.5) * 0.8, -0.45)))
    ids = [acc.vert(c + q.normalized() * r, col, 0.1, crown_normal(sp, c)) for q in ico]
    for k in range(ring):
        u0, l0 = 2 + 2 * k, 3 + 2 * k
        u1, l1 = 2 + 2 * ((k + 1) % ring), 3 + 2 * ((k + 1) % ring)
        uv = ((0, 0), (1, 0), (0, 1))
        acc.tri(ids[0], ids[u0], ids[u1], *uv, m)
        acc.tri(ids[u0], ids[l0], ids[u1], *uv, m)
        acc.tri(ids[u1], ids[l0], ids[l1], *uv, m)
        acc.tri(ids[1], ids[l1], ids[l0], *uv, m)

# ------------------------------------------------------------------ palm

def grow_palm(sp, rng, acc):
    T = sp['trunk']
    H = sp['H']
    pts, rad = [], []
    for i in range(T['seg'] + 1):
        t = i / T['seg']
        pts.append(V((T['lean'] * t * t, 0.015 * math.sin(t * 3), T['len'] * H * t)))
        rad.append(T['r0'] * (1 - t * (1 - T['taper'])) * (1 + 0.35 * max(0, 1 - t * 8)) * (1 + 0.06 * math.sin(t * 40)))
    trunk = Branch(pts, rad, 0)
    top = pts[-1] + V((0, 0, 0.02))
    F = sp['fronds']
    lf = sp['leaf']
    fronds = []
    nF = F['n'] + F['dead']
    golden = math.pi * (3 - math.sqrt(5))
    for f in range(nF):
        dead = f >= F['n']
        a = f * golden * 2 + rng.uniform(-0.2, 0.2)
        if dead:
            e0 = math.radians(rng.uniform(-75, -55)); L = F['len'] * rng.uniform(0.55, 0.75); droop = 0.15
        else:
            k = f / F['n']
            e0 = math.radians(70 - 95 * k + rng.uniform(-8, 8)); L = F['len'] * rng.uniform(0.85, 1.12) * (0.75 + 0.35 * min(1, k * 3)); droop = 0.45 + 0.5 * k
        dirh = V((math.cos(a), math.sin(a), 0))
        seg = 10
        rp, rr = [], []
        for i in range(seg + 1):
            t = i / seg
            p = top + dirh * (math.cos(e0) * t * L) + V((0, 0, math.sin(e0) * t * L - droop * t * t * L))
            rp.append(p); rr.append(0.008 * (1 - t) + 0.0015)
        rach = Branch(rp, rr, 1)
        rach.parent = trunk
        trunk.kids.append(rach)
        fronds.append((rach, dead))
        col0 = (hexc(0x8a6a3a) + (1,)) if dead else None
        nl = F['leaflets']
        for i in range(nl):
            t = 0.12 + 0.86 * (i + 0.5) / nl
            p, d, r = rach.at(t)
            side = d.cross(UPZ)
            if side.length < 1e-4:
                side = perp(d)
            side.normalize()
            for s in (-1, 1):
                prof = math.sin(math.pi * min(1, 0.1 + t * 0.95))
                ll = lf['len'] * (0.35 + 0.75 * prof) * rng.uniform(0.85, 1.1) * (0.8 if dead else 1)
                ax = (d * 0.55 + side * s + V((0, 0, 0.35 if not dead else -0.2))).normalized()
                nrm = ax.cross(d).normalized() * s
                if nrm.z < 0:
                    nrm = -nrm
                col = col0 if dead else jitter_col(rng, lf['cols'], 0.1)
                if dead:
                    col = (col[0] * rng.uniform(0.8, 1.15), col[1] * rng.uniform(0.8, 1.1), col[2], 1)
                add_leaf(acc, sp, rng, p, ax, nrm, ll, lf['wid'], col, 'lance', fold=0.4, curl=0.25 if not dead else -0.4, tr=0.0 if dead else 1.0)
    # date clusters under the crown
    for k in range(4):
        a = k * 1.7 + 0.4
        c = top + V((math.cos(a) * 0.07, math.sin(a) * 0.07, -0.08))
        for j in range(14):
            add_sphere(acc, c + V((rng.uniform(-0.03, 0.03), rng.uniform(-0.03, 0.03), rng.uniform(-0.06, 0.0))), 0.008, (hexc(0xc77b22) + (1,)), M_FRUIT, sp)
    return [trunk], [trunk] + [f[0] for f in fronds], fronds

# ------------------------------------------------------------------ meshing

def bark_mesh(acc, sp, allb, hero=False, max_level=9, sides_by_level=(10, 6, 4, 3, 3), min_r=0.0):
    """Tapered tubes with bark UVs (u around, v along; tiled in Blender, 0..1 per branch in the hero atlas)."""
    tint = sp.get('bark_tint', (1, 1, 1))
    top = sp.get('bark_top')
    H = sp['H']
    for b in allb:
        if b.level > max_level or b.rad[0] < min_r:
            continue
        if b.level >= 1 and sp.get('palm'):
            continue
        sides = sides_by_level[min(b.level, len(sides_by_level) - 1)]
        pts = b.pts
        if hero and len(pts) > 3 and b.level >= 1:
            pts = [pts[0], pts[len(pts) // 2], pts[-1]]
            rads = [b.rad[0], b.rad[len(b.rad) // 2], b.rad[-1]]
        else:
            rads = b.rad
        rings = []
        circ = 2 * math.pi * rads[0]
        urep = max(1, round(circ / 0.09)) if not hero else 1
        Lt = 0.0
        e1p = None
        total = sum((pts[i] - pts[i - 1]).length for i in range(1, len(pts))) or 1
        for i, p in enumerate(pts):
            d = (pts[i + 1] - p) if i < len(pts) - 1 else (p - pts[i - 1])
            d.normalize()
            if e1p is None:
                e1 = perp(d)
            else:
                e1 = (e1p - d * e1p.dot(d)).normalized()
            e1p = e1
            e2 = d.cross(e1).normalized()
            if i:
                Lt += (pts[i] - pts[i - 1]).length
            ring = []
            k_t = (p.z / H)
            col = tuple(tint[c] * (1 + (top[c] - 1) * max(0, min(1, (k_t - 0.45) / 0.35)) if top else tint[c]) for c in range(3)) + (1,)
            for k in range(sides + 1):
                a = 2 * math.pi * k / sides
                n = e1 * math.cos(a) + e2 * math.sin(a)
                q = p + n * rads[i]
                vi = acc.vert(q, col, 0.0, n)
                ring.append((vi, k / sides * urep, (Lt / 0.09) if not hero else Lt / total))
            rings.append(ring)
        for i in range(len(rings) - 1):
            for k in range(sides):
                a0, b0, c0, d0 = rings[i][k], rings[i][k + 1], rings[i + 1][k], rings[i + 1][k + 1]
                acc.tri(a0[0], b0[0], d0[0], a0[1:], b0[1:], d0[1:], M_BARK)
                acc.tri(a0[0], d0[0], c0[0], a0[1:], d0[1:], c0[1:], M_BARK)

def acc_to_object(acc, name, mats):
    me = bpy.data.meshes.new(name)
    me.from_pydata(acc.v, [], acc.f)
    me.update()
    uvl = me.uv_layers.new(name='UVMap')
    uvd = []
    for tri in acc.uv:
        for u in tri:
            uvd.extend(u)
    uvl.data.foreach_set('uv', uvd)
    me.polygons.foreach_set('material_index', acc.mat)
    ca = me.color_attributes.new('base', 'FLOAT_COLOR', 'POINT')
    flat = []
    for c in acc.col:
        flat.extend(c)
    ca.data.foreach_set('color', flat)
    tr = me.attributes.new('transl', 'FLOAT', 'POINT')
    tr.data.foreach_set('value', acc.tr)
    cn = me.color_attributes.new('cnrm', 'FLOAT_COLOR', 'POINT')
    flat = []
    for n in acc.cn:
        flat.extend((n[0] * 0.5 + 0.5, n[1] * 0.5 + 0.5, n[2] * 0.5 + 0.5, 1))
    cn.data.foreach_set('color', flat)
    for m in mats:
        me.materials.append(m)
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    return ob

# ------------------------------------------------------------------ materials

def ch_group():
    g = bpy.data.node_groups.get('CH')
    if g:
        return g
    g = bpy.data.node_groups.new('CH', 'ShaderNodeTree')
    for nm in ('ch', 'invR', 'aod'):
        g.interface.new_socket(nm, in_out='OUTPUT', socket_type='NodeSocketFloat')
    out = g.nodes.new('NodeGroupOutput')
    for i, (nm, val) in enumerate((('ch', 0.0), ('invR', 1.0), ('aod', 0.2))):
        v = g.nodes.new('ShaderNodeValue'); v.name = nm; v.outputs[0].default_value = val
        g.links.new(v.outputs[0], out.inputs[i])
    return g

def set_ch(ch=None, invR=None, aod=None):
    g = ch_group()
    if ch is not None: g.nodes['ch'].outputs[0].default_value = ch
    if invR is not None: g.nodes['invR'].outputs[0].default_value = invR
    if aod is not None: g.nodes['aod'].outputs[0].default_value = aod

def birch_bark_image():
    path = os.path.join(OUT, 'bark_birch_src.png')
    if not os.path.exists(path):
        rng = np.random.default_rng(5)
        S = 256
        y, x = np.mgrid[0:S, 0:S] / S
        img = np.ones((S, S, 3)) * np.array([0.86, 0.85, 0.80])
        # horizontal lenticels and dark scars, tileable around (x) and along (y)
        def tnoise(fx, fy, seed):
            r = np.random.default_rng(seed)
            acc = np.zeros((S, S))
            for o in range(4):
                ph = r.uniform(0, 6.28, 4)
                acc += (np.sin(2 * np.pi * (x * fx * 2 ** o) + ph[0]) * np.sin(2 * np.pi * (y * fy * 2 ** o) + ph[1])) / 2 ** o
            return acc
        n1 = tnoise(1, 3, 1)
        img *= (1 - 0.08 * n1[..., None])
        for k in range(70):
            cx, cy = rng.uniform(0, 1), rng.uniform(0, 1)
            w, h = rng.uniform(0.04, 0.16), rng.uniform(0.004, 0.012)
            dx = np.minimum(abs(x - cx), 1 - abs(x - cx)) / w
            dy = np.minimum(abs(y - cy), 1 - abs(y - cy)) / h
            m = np.clip(1 - (dx ** 2 + dy ** 2), 0, 1) ** 0.5
            img *= (1 - 0.75 * m[..., None])
        for k in range(10):
            cx, cy = rng.uniform(0, 1), rng.uniform(0, 1)
            w, h = rng.uniform(0.05, 0.12), rng.uniform(0.03, 0.08)
            dx = np.minimum(abs(x - cx), 1 - abs(x - cx)) / w
            dy = np.minimum(abs(y - cy), 1 - abs(y - cy)) / h
            m = np.clip(1 - (dx ** 2 + dy ** 2), 0, 1)
            img = img * (1 - 0.6 * m[..., None]) + np.array([0.12, 0.11, 0.1]) * 0.6 * m[..., None]
        write_png(path, np.clip(img * 255, 0, 255).astype(np.uint8))
    return path

def bark_image(kind):
    path = birch_bark_image() if kind == 'birch' else os.path.join(BARK_DIR, f'{kind}.webp')
    im = bpy.data.images.get('bark_' + kind)
    if not im:
        im = bpy.data.images.load(path)
        im.name = 'bark_' + kind
    return im

def build_material(name, kind, bark=None):
    """kind: bark / leaf / snow / fruit. Output: ch 0 albedo, 1 normal, 2 data (depth, transl, AO), 3 beauty."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    N = nt.nodes.new
    L = nt.links.new
    out = N('ShaderNodeOutputMaterial')
    grp = N('ShaderNodeGroup'); grp.node_tree = ch_group()
    geo = N('ShaderNodeNewGeometry')
    attr = N('ShaderNodeAttribute'); attr.attribute_name = 'base'
    tr = N('ShaderNodeAttribute'); tr.attribute_name = 'transl'
    cnA = N('ShaderNodeAttribute'); cnA.attribute_name = 'cnrm'
    uv = N('ShaderNodeUVMap'); uv.uv_map = 'UVMap'
    if kind == 'bark':
        tex = N('ShaderNodeTexImage'); tex.image = bark_image(bark); tex.interpolation = 'Cubic'
        L(uv.outputs[0], tex.inputs[0])
        mul = N('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'; mul.inputs['Factor'].default_value = 1.0
        L(tex.outputs['Color'], mul.inputs['A']); L(attr.outputs['Color'], mul.inputs['B'])
        albedo = mul.outputs['Result']
        bw = N('ShaderNodeRGBToBW'); L(tex.outputs['Color'], bw.inputs[0])
        bump = N('ShaderNodeBump'); bump.inputs['Strength'].default_value = 0.8; bump.inputs['Distance'].default_value = 0.004
        L(bw.outputs[0], bump.inputs['Height'])
        nrm = bump.outputs['Normal']
        rough = 0.85
    else:
        if kind == 'leaf':
            # midrib and a darker rim from the leaf's own UVs
            sep = N('ShaderNodeSeparateXYZ'); L(uv.outputs[0], sep.inputs[0])
            m1 = N('ShaderNodeMath'); m1.operation = 'SUBTRACT'; m1.inputs[1].default_value = 0.5; L(sep.outputs['Y'], m1.inputs[0])
            m2 = N('ShaderNodeMath'); m2.operation = 'ABSOLUTE'; L(m1.outputs[0], m2.inputs[0])
            m3 = N('ShaderNodeMapRange'); m3.inputs['From Min'].default_value = 0.0; m3.inputs['From Max'].default_value = 0.5
            m3.inputs['To Min'].default_value = 1.12; m3.inputs['To Max'].default_value = 0.86
            L(m2.outputs[0], m3.inputs['Value'])
            mul = N('ShaderNodeMix'); mul.data_type = 'RGBA'; mul.blend_type = 'MULTIPLY'; mul.inputs['Factor'].default_value = 1.0
            L(attr.outputs['Color'], mul.inputs['A']); L(m3.outputs[0], mul.inputs['B'])
            albedo = mul.outputs['Result']
            rough = 0.55
        else:
            albedo = attr.outputs['Color']
            rough = 0.9 if kind == 'snow' else 0.4
        # canopy-shaped normals: the leaf's own normal bent towards the crown's (soft volumetric shading)
        cnv = N('ShaderNodeVectorMath'); cnv.operation = 'MULTIPLY_ADD'
        L(cnA.outputs['Color'], cnv.inputs[0]); cnv.inputs[1].default_value = (2, 2, 2); cnv.inputs[2].default_value = (-1, -1, -1)
        # (object space crown normal -> world)
        cnw = N('ShaderNodeVectorTransform'); cnw.vector_type = 'NORMAL'; cnw.convert_from = 'OBJECT'; cnw.convert_to = 'WORLD'
        L(cnv.outputs[0], cnw.inputs[0])
        mixn = N('ShaderNodeMix'); mixn.data_type = 'VECTOR'; mixn.inputs['Factor'].default_value = 0.0 if kind == 'snow' else 0.55
        L(geo.outputs['Normal'], mixn.inputs['A']); L(cnw.outputs[0], mixn.inputs['B'])
        nn = N('ShaderNodeVectorMath'); nn.operation = 'NORMALIZE'; L(mixn.outputs['Result'], nn.inputs[0])
        nrm = nn.outputs[0]
    # ch0: albedo
    e0 = N('ShaderNodeEmission'); L(albedo, e0.inputs['Color'])
    # ch1: object-space normal, 0..1
    vt = N('ShaderNodeVectorTransform'); vt.vector_type = 'NORMAL'; vt.convert_from = 'WORLD'; vt.convert_to = 'OBJECT'
    L(nrm, vt.inputs[0])
    vn = N('ShaderNodeVectorMath'); vn.operation = 'NORMALIZE'; L(vt.outputs[0], vn.inputs[0])
    enc = N('ShaderNodeVectorMath'); enc.operation = 'MULTIPLY_ADD'; L(vn.outputs[0], enc.inputs[0]); enc.inputs[1].default_value = (0.5, 0.5, 0.5); enc.inputs[2].default_value = (0.5, 0.5, 0.5)
    e1 = N('ShaderNodeEmission'); L(enc.outputs[0], e1.inputs['Color'])
    # ch2: depth towards the camera (world z, the frames are turned to face +Z), translucency, AO
    sz = N('ShaderNodeSeparateXYZ'); L(geo.outputs['Position'], sz.inputs[0])
    dz = N('ShaderNodeMath'); dz.operation = 'MULTIPLY'; L(sz.outputs['Z'], dz.inputs[0]); L(grp.outputs['invR'], dz.inputs[1])
    dz2 = N('ShaderNodeMath'); dz2.operation = 'MULTIPLY_ADD'; L(dz.outputs[0], dz2.inputs[0]); dz2.inputs[1].default_value = 0.5; dz2.inputs[2].default_value = 0.5
    ao = N('ShaderNodeAmbientOcclusion'); ao.only_local = True; ao.samples = 16
    L(grp.outputs['aod'], ao.inputs['Distance'])
    cmb = N('ShaderNodeCombineXYZ'); L(dz2.outputs[0], cmb.inputs[0]); L(tr.outputs['Fac'], cmb.inputs[1]); L(ao.outputs['AO'], cmb.inputs[2])
    e2 = N('ShaderNodeEmission'); L(cmb.outputs[0], e2.inputs['Color'])
    # ch3: beauty (contact sheet)
    bsdf = N('ShaderNodeBsdfPrincipled'); L(albedo, bsdf.inputs['Base Color']); bsdf.inputs['Roughness'].default_value = rough
    if kind != 'bark':
        bsdf.inputs['Specular IOR Level'].default_value = 0.0
        bsdf.inputs['Roughness'].default_value = max(rough, 0.68)
    if kind == 'bark':
        L(nrm, bsdf.inputs['Normal'])
    beauty = bsdf.outputs[0]
    if kind == 'leaf':
        tl = N('ShaderNodeBsdfTranslucent'); L(albedo, tl.inputs['Color'])
        mx = N('ShaderNodeMixShader'); mx.inputs['Fac'].default_value = 0.2
        L(bsdf.outputs[0], mx.inputs[1]); L(tl.outputs[0], mx.inputs[2])
        beauty = mx.outputs[0]
    # select by ch
    def gt(v):
        c = N('ShaderNodeMath'); c.operation = 'GREATER_THAN'; L(grp.outputs['ch'], c.inputs[0]); c.inputs[1].default_value = v
        return c.outputs[0]
    s1 = N('ShaderNodeMixShader'); L(gt(0.5), s1.inputs['Fac']); L(e0.outputs[0], s1.inputs[1]); L(e1.outputs[0], s1.inputs[2])
    s2 = N('ShaderNodeMixShader'); L(gt(1.5), s2.inputs['Fac']); L(s1.outputs[0], s2.inputs[1]); L(e2.outputs[0], s2.inputs[2])
    s3 = N('ShaderNodeMixShader'); L(gt(2.5), s3.inputs['Fac']); L(s2.outputs[0], s3.inputs[1]); L(beauty, s3.inputs[2])
    L(s3.outputs[0], out.inputs['Surface'])
    return m

MATS = {}
def mats_for(sp):
    bark = sp.get('bark', 'oak')
    key = bark
    if key not in MATS:
        MATS[key] = [build_material('bark_' + bark, 'bark', bark), MATS.get('leaf') or build_material('leaf', 'leaf'),
                     MATS.get('snow') or build_material('snow', 'snow'), MATS.get('fruit') or build_material('fruit', 'fruit')]
        MATS['leaf'], MATS['snow'], MATS['fruit'] = MATS[key][1], MATS[key][2], MATS[key][3]
    return MATS[key]

# ------------------------------------------------------------------ io helpers

def write_png(path, arr):
    """uint8 HxWx(3|4) -> PNG (row 0 = top)."""
    h, w = arr.shape[:2]
    ch = arr.shape[2] if arr.ndim == 3 else 1
    ct = {1: 0, 3: 2, 4: 6}[ch]
    raw = b''.join(b'\x00' + arr[y].tobytes() for y in range(h))
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, ct, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)

def read_exr(path):
    im = bpy.data.images.load(path)
    w, h = im.size
    px = np.empty(w * h * 4, dtype=np.float32)
    im.pixels.foreach_get(px)
    bpy.data.images.remove(im)
    return px.reshape(h, w, 4)[::-1].copy()   # row 0 = top

def to_srgb8(lin):
    lin = np.clip(lin, 0, 1)
    s = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * np.power(lin, 1 / 2.4) - 0.055)
    return np.clip(np.round(s * 255), 0, 255).astype(np.uint8)

def unpremul(px):
    a = px[..., 3:4]
    rgb = np.where(a > 1e-4, px[..., :3] / np.maximum(a, 1e-4), 0)
    return rgb, a[..., 0]

def down2(rgb, a):
    """2x2 box downsample, colour weighted by coverage."""
    h, w = a.shape
    A = a.reshape(h // 2, 2, w // 2, 2)
    R = (rgb * a[..., None]).reshape(h // 2, 2, w // 2, 2, rgb.shape[-1])
    asum = A.sum(axis=(1, 3))
    rs = R.sum(axis=(1, 3))
    out = np.where(asum[..., None] > 1e-5, rs / np.maximum(asum[..., None], 1e-5), 0)
    return out, asum / 4

def dilate(rgb, a, iters=12):
    """Bleed colour into the empty pixels (no dark fringes once mipmapped)."""
    rgb = rgb.copy()
    filled = a > 0.004
    for _ in range(iters):
        if filled.all():
            break
        acc = np.zeros_like(rgb); cnt = np.zeros(a.shape)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            sh = np.roll(np.roll(rgb, dy, 0), dx, 1); sf = np.roll(np.roll(filled, dy, 0), dx, 1)
            acc += sh * sf[..., None]; cnt += sf
        new = (~filled) & (cnt > 0)
        rgb[new] = acc[new] / cnt[new][..., None]
        filled = filled | new
    # whatever is left: the mean colour
    if (~filled).any() and filled.any():
        rgb[~filled] = rgb[filled].mean(axis=0)
    return rgb

def oct_encode(n):
    """unit vectors (..., 3) -> octahedral (..., 2) in 0..1."""
    s = np.abs(n).sum(axis=-1, keepdims=True) + 1e-8
    p = n[..., :2] / s
    neg = n[..., 2:3] < 0
    q = np.where(neg, (1 - np.abs(p[..., ::-1])) * np.where(p >= 0, 1, -1), p)
    return q * 0.5 + 0.5

def blender_to_game(n):
    """Blender (x, y, z) Z-up -> game / glTF (x, z, -y) Y-up."""
    return np.stack([n[..., 0], n[..., 2], -n[..., 1]], axis=-1)

# ------------------------------------------------------------------ scene setup

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    MATS.clear()
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.pixel_filter_type = 'BOX'
    sc.cycles.use_denoising = False
    sc.render.film_transparent = True
    sc.render.image_settings.file_format = 'OPEN_EXR'
    sc.render.image_settings.color_depth = '32'
    sc.render.use_persistent_data = True
    sc.cycles.max_bounces = 0
    sc.cycles.use_adaptive_sampling = False
    w = bpy.data.worlds.new('w'); sc.world = w
    return sc

def render_exr(sc, path, spp):
    sc.cycles.samples = spp
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return read_exr(path)

# ------------------------------------------------------------------ build one species

def build_tree(sp):
    rng = random.Random(sp['seed'] * 7919 + 13)
    acc = MeshAcc()
    if sp.get('palm'):
        trunks, allb, fronds = grow_palm(sp, rng, acc)
    else:
        trunks, allb = grow_tree(sp, rng)
        fronds = None
        dress(sp, rng, allb, acc)
    bark_mesh(acc, sp, allb)
    return trunks, allb, acc, fronds

def frame_dirs():
    """Impostor frames: 12 azimuths x 3 elevations; returns list of (az, el) radians in game space."""
    ELS = [12, 38, 64]
    out = []
    for ei, e in enumerate(ELS):
        for ai in range(12):
            out.append((ai * math.pi * 2 / 12, math.radians(e)))
    return out

def frame_basis(az, el):
    """Camera basis in Blender tree space for a frame seen from game direction (az, el)."""
    d = V((math.cos(el) * math.cos(az), -math.cos(el) * math.sin(az), math.sin(el)))   # towards the camera
    f = -d
    r = f.cross(UPZ).normalized()
    u = r.cross(f).normalized()
    return r, u, d

def measure(ob, C):
    """Max |projection| of the vertices around C over all frames (frame half-extent)."""
    me = ob.data
    co = np.empty(len(me.vertices) * 3); me.vertices.foreach_get('co', co); co = co.reshape(-1, 3) - np.array(C)
    ext = 0.0
    for az, el in frame_dirs():
        r, u, d = frame_basis(az, el)
        ext = max(ext, np.abs(co @ np.array(r)).max(), np.abs(co @ np.array(u)).max())
    rad = np.sqrt((co ** 2).sum(axis=1)).max()
    return ext, rad

def render_impostor(sc, sp, ob, meta):
    H = sp['H']
    C = V((0, 0, H * 0.5)) if not sp.get('palm') else V((0.06, 0, H * 0.52))
    ext, rad = measure(ob, C)
    Rf = ext * 1.04
    meta.update(Rf=Rf, Cy=C.z, Cx=C.x, Cz=-C.y, rad=rad)
    G = 6
    S = 2 * Rf
    gap = 0.0
    sup = 2
    res = G * FPX * sup
    dups = []
    for k, (az, el) in enumerate(frame_dirs()):
        col, row = k % G, k // G
        r, u, d = frame_basis(az, el)
        R = Matrix((r, u, d)).to_4x4()
        cell = V(((col - (G - 1) / 2) * S, ((G - 1) / 2 - row) * S, 0))
        o = bpy.data.objects.new(f'f{k}', ob.data)
        o.matrix_world = Matrix.Translation(cell) @ R @ Matrix.Translation(-C)
        sc.collection.objects.link(o)
        dups.append(o)
    cam = bpy.data.objects.new('impcam', bpy.data.cameras.new('impcam'))
    cam.data.type = 'ORTHO'; cam.data.ortho_scale = G * S; cam.data.clip_start = 0.01; cam.data.clip_end = 100
    cam.location = (0, 0, 20)
    sc.collection.objects.link(cam); sc.camera = cam
    sc.render.resolution_x = sc.render.resolution_y = res
    set_ch(invR=1.0 / Rf, aod=0.22 * H)
    t0 = time.time()
    set_ch(ch=0); alb = render_exr(sc, os.path.join(OUT, 'tmp_alb.exr'), SPP)
    set_ch(ch=1); nrm = render_exr(sc, os.path.join(OUT, 'tmp_nrm.exr'), SPP)
    set_ch(ch=2); dat = render_exr(sc, os.path.join(OUT, 'tmp_dat.exr'), SPP * 2)
    print(f'  impostor renders {time.time() - t0:.1f}s')
    for o in dups:
        bpy.data.objects.remove(o)
    bpy.data.objects.remove(cam)
    a_rgb, a = unpremul(alb)
    n_rgb, _ = unpremul(nrm)
    d_rgb, _ = unpremul(dat)
    for scale_px in (FPX, FPX // 2):
        k = (FPX * sup) // scale_px
        A, AA = a_rgb, a
        Nn, Dd = n_rgb, d_rgb
        while A.shape[0] > G * scale_px:
            A2, AA2 = down2(A, AA)
            Nn, _ = down2(Nn, AA)
            Dd, _ = down2(Dd, AA)
            A, AA = A2, AA2
        ao = Dd[..., 2]
        alb_f = A * (0.42 + 0.58 * ao[..., None])
        alb_f = dilate(alb_f, AA)
        nv = Nn * 2 - 1
        nv = nv / np.maximum(np.linalg.norm(nv, axis=-1, keepdims=True), 1e-6)
        oc = oct_encode(blender_to_game(nv))
        tr = Dd[..., 1] * (0.35 + 0.65 * ao)
        ndat = np.concatenate([oc, Dd[..., 0:1]], axis=-1)
        ndat = dilate(ndat, AA)
        img_a = np.concatenate([to_srgb8(alb_f), np.clip(np.round(AA * 255), 0, 255).astype(np.uint8)[..., None]], axis=-1)
        img_n = np.clip(np.round(np.concatenate([ndat, tr[..., None]], axis=-1) * 255), 0, 255).astype(np.uint8)
        write_png(os.path.join(OUT, f'imp_{sp["name"]}_{scale_px}_a.png'), img_a)
        write_png(os.path.join(OUT, f'imp_{sp["name"]}_{scale_px}_n.png'), img_n)

# ------------------------------------------------------------------ cluster sprites (leaf-card atlas)

def proto_cluster(sp, rng, kind):
    """A typical foliage cluster lying along +X (base at x=0), seen from +Z."""
    acc = MeshAcc()
    sp2 = dict(sp)
    sp2['crown'] = dict(c=(0.5, 0, -0.5), r=(1.0, 1.0, 1.0))   # crown normal ~ up for the sprite
    levels = sp.get('levels', [])
    if kind == 'willow_strand':
        allb = []
        for k in range(5):
            b = grow_curve(rng, V((0, (k - 2) * 0.012, 0)), V((1, rng.uniform(-0.15, 0.15), 0)), 0.28, 0.0015, 0.0008, 6, 0.0, 0.0, 0.12)
            b.level = 3; b.strand = True; allb.append(b)
        sp2['leaf'] = dict(sp['leaf'], face_up=0.6)
        for b in allb:
            n = int(sp['leaf']['dens'] * b.length)
            for i in range(n):
                t = (i + rng.random()) / n
                p, d, r = b.at(t)
                side = V((0, 1 if i % 2 else -1, 0))
                a = (d * 0.85 + side * 0.4 + V((0, 0, rng.uniform(-0.2, 0.2)))).normalized()
                nrm = V((0, 0, 1)); nrm = (nrm - a * nrm.dot(a)).normalized()
                add_leaf(acc, sp2, rng, p, a, nrm, sp['leaf']['len'] * rng.uniform(0.8, 1.2), sp['leaf']['wid'], jitter_col(rng, sp['leaf']['cols']), 'lance')
        bark_mesh(acc, sp2, allb)
        return acc, 0.3
    if kind in ('palm', 'palm_dead'):
        lf = sp['leaf']
        L = 0.62
        rach = Branch([V((x * L / 10, 0, -0.02 * (x / 10) ** 2)) for x in range(11)], [0.006 * (1 - x / 10) + 0.0015 for x in range(11)], 1)
        dead = kind == 'palm_dead'
        for i in range(34):
            t = 0.08 + 0.9 * (i + 0.5) / 34
            p, d, r = rach.at(t)
            for s in (-1, 1):
                prof = math.sin(math.pi * min(1, 0.1 + t * 0.95))
                ll = lf['len'] * (0.35 + 0.75 * prof) * rng.uniform(0.85, 1.1)
                ax = (d * 0.6 + V((0, s, 0))).normalized()
                col = (hexc(0x8a6a3a) + (1,)) if dead else jitter_col(rng, lf['cols'], 0.1)
                add_leaf(acc, sp2, rng, p, ax, V((0, 0, 1)), ll, lf['wid'], col, 'lance', fold=0.35, curl=0.0, tr=0.0 if dead else 1.0)
        bark_mesh(acc, dict(sp2, bark_tint=(0.75, 0.7, 0.5)), [rach])
        return acc, L
    if kind == 'birch_bare' or kind == 'bush_bare':
        # a fan of bare twigs
        root = grow_curve(rng, V((0, 0, 0)), V((1, 0, 0)), 0.22, 0.0035, 0.001, 4, 0.0, 0.0, 0.2)
        root.level = 1
        allb = [root]
        for i in range(9):
            p, d, r = root.at(0.1 + 0.85 * i / 9)
            cd = (d + V((0, 0.9 if i % 2 else -0.9, 0))).normalized()
            c = grow_curve(rng, p, cd, rng.uniform(0.06, 0.12), r * 0.7, 0.0008, 3, 0.0, 0.0, 0.5)
            c.level = 2; root.kids.append(c); allb.append(c)
            for j in range(3):
                q, e, rr = c.at(0.3 + 0.25 * j)
                cd2 = (e + V((0, rng.uniform(-0.8, 0.8), 0))).normalized()
                c2 = grow_curve(rng, q, cd2, rng.uniform(0.025, 0.05), max(0.0008, rr * 0.7), 0.0005, 2, 0.0, 0.0, 0.6)
                c2.level = 3; c.kids.append(c2); allb.append(c2)
        bark_mesh(acc, dict(sp2), allb)
        if sp.get('snow'):
            for b in allb[:10]:
                add_snow_cap(acc, sp2, rng, b, 0.35)
        return acc, 0.24
    # a branch of the deepest structural level with its twigs and leaves / needles
    if sp.get('conifer') and sp['name'].startswith('spruce'):
        li = 0
        L = 0.3
    else:
        li = max(0, len(levels) - 2)
        L = {'oak': 0.2, 'young': 0.16, 'birch': 0.17, 'poplar': 0.14, 'willow': 0.18, 'fruit': 0.16,
             'pine': 0.17, 'acacia': 0.22, 'bush': 0.12, 'hedge': 0.11, 'scrub': 0.1}.get(sp['name'].split('_')[0], 0.16)
    root = grow_curve(rng, V((0, 0, 0)), V((1, 0, 0.0)), L, 0.004, 0.0015, 4, 0.0, 0.0, 0.15)
    root.level = li + 1
    allb = [root]
    sub = levels[li + 1:] if li + 1 < len(levels) else []
    def spawn2(parent, k):
        if k >= len(sub):
            return
        P = sub[k]
        count = max(2, int(round(P['n'] * parent.length / 0.3)))
        phi = rng.uniform(0, 6.28)
        for i in range(count):
            t = P['t0'] + (P['t1'] - P['t0']) * (i + rng.uniform(0.2, 0.8)) / count
            p, d, r = parent.at(t)
            phi += math.radians(P['rot'][0])
            side = V((0, 1 if i % 2 else -1, 0)) if (P.get('plane') or True) else perp(d)
            down = math.radians(P['down'][0])
            cd = (d * math.cos(down) + side * math.sin(down) + V((0, 0, rng.uniform(-0.15, 0.15)))).normalized()
            Lc = max(0.02, P['len'][0] * parent.length * (1 - 0.4 * t)) * rng.uniform(0.8, 1.2)
            c = grow_curve(rng, p, cd, Lc, max(0.001, r * 0.7), 0.0008, max(2, P['seg'] - 1), 0.0, 0.0, P['wig'] * 0.5)
            c.level = parent.level + 1
            parent.kids.append(c); allb.append(c)
            spawn2(c, k + 1)
    spawn2(root, 0)
    sp3 = dict(sp2)
    if sp3.get('leaf'):
        sp3['leaf'] = dict(sp3['leaf'], face_up=max(0.5, sp3['leaf'].get('face_up', 0.5)))
    dress(sp3, rng, allb, acc)
    bark_mesh(acc, sp3, allb)
    return acc, L

def render_sprite(sc, acc, sp, L, name):
    """Ortho top view of a cluster, filling one atlas cell: albedo+alpha, tangent normal + translucency."""
    ob = acc_to_object(acc, 'spr_' + name, mats_for(sp))
    sc.collection.objects.link(ob)
    co = np.array([v for v in acc.v])
    x0, x1 = co[:, 0].min(), co[:, 0].max()
    y0, y1 = co[:, 1].min(), co[:, 1].max()
    span = max(x1 - x0, (y1 - y0)) * 1.04
    cam = bpy.data.objects.new('sprcam', bpy.data.cameras.new('sprcam'))
    cam.data.type = 'ORTHO'; cam.data.ortho_scale = span; cam.data.clip_start = 0.01; cam.data.clip_end = 100
    cam.location = ((x0 + x1) / 2, (y0 + y1) / 2, 10)
    sc.collection.objects.link(cam); sc.camera = cam
    sc.render.resolution_x = sc.render.resolution_y = CELL * 2
    set_ch(invR=1.0, aod=0.012)
    set_ch(ch=0); alb = render_exr(sc, os.path.join(OUT, 'tmp_salb.exr'), SPP)
    set_ch(ch=1); nrm = render_exr(sc, os.path.join(OUT, 'tmp_snrm.exr'), SPP)
    set_ch(ch=2); dat = render_exr(sc, os.path.join(OUT, 'tmp_sdat.exr'), SPP)
    bpy.data.objects.remove(cam); bpy.data.objects.remove(ob)
    a_rgb, a = unpremul(alb); n_rgb, _ = unpremul(nrm); d_rgb, _ = unpremul(dat)
    a_rgb2, a2 = down2(a_rgb, a); n2, _ = down2(n_rgb, a); d2, _ = down2(d_rgb, a)
    ao = d2[..., 2]
    albf = dilate(a_rgb2 * (0.6 + 0.4 * ao[..., None]), a2)
    nv = n2 * 2 - 1
    nv = nv / np.maximum(np.linalg.norm(nv, axis=-1, keepdims=True), 1e-6)
    nv[..., 2] = np.abs(nv[..., 2])
    nrgb = dilate(nv * 0.5 + 0.5, a2)
    tr = d2[..., 1] * (0.4 + 0.6 * ao)
    img_a = np.concatenate([to_srgb8(albf), np.clip(np.round(a2 * 255), 0, 255).astype(np.uint8)[..., None]], axis=-1)
    img_n = np.clip(np.round(np.concatenate([nrgb, tr[..., None]], axis=-1) * 255), 0, 255).astype(np.uint8)
    return img_a, img_n, dict(span=span, x0=float(x0), x1=float(x1), y0=float(y0), y1=float(y1))

def render_bark_cell(sc, bark, tint=(1, 1, 1)):
    acc = MeshAcc()
    col = tuple(tint) + (1,)
    q = [acc.vert(V(p), col, 0.0, (0, 0, 1)) for p in ((0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0))]
    acc.tri(q[0], q[1], q[2], (0, 0), (1, 0), (1, 1), M_BARK)
    acc.tri(q[0], q[2], q[3], (0, 0), (1, 1), (0, 1), M_BARK)
    sp = dict(bark=bark)
    ob = acc_to_object(acc, 'barkcell', mats_for(sp))
    sc.collection.objects.link(ob)
    cam = bpy.data.objects.new('bcam', bpy.data.cameras.new('bcam'))
    cam.data.type = 'ORTHO'; cam.data.ortho_scale = 1.0; cam.location = (0.5, 0.5, 5)
    sc.collection.objects.link(cam); sc.camera = cam
    sc.render.resolution_x = sc.render.resolution_y = CELL
    set_ch(ch=0); alb = render_exr(sc, os.path.join(OUT, 'tmp_balb.exr'), 4)
    set_ch(ch=1); nrm = render_exr(sc, os.path.join(OUT, 'tmp_bnrm.exr'), 4)
    bpy.data.objects.remove(cam); bpy.data.objects.remove(ob)
    a_rgb, a = unpremul(alb); n_rgb, _ = unpremul(nrm)
    img_a = np.concatenate([to_srgb8(a_rgb), np.full(a.shape + (1,), 255, np.uint8)], axis=-1)
    img_n = np.concatenate([np.clip(np.round(n_rgb * 255), 0, 255).astype(np.uint8), np.zeros(a.shape + (1,), np.uint8)], axis=-1)
    return img_a, img_n

# ------------------------------------------------------------------ hero mesh

def kmeans(P, k, rng, iters=12):
    n = len(P)
    k = min(k, n)
    idx = rng.sample(range(n), k)
    C = P[idx].copy()
    for _ in range(iters):
        d = ((P[:, None, :] - C[None, :, :]) ** 2).sum(-1)
        lab = d.argmin(1)
        for j in range(k):
            m = lab == j
            if m.any():
                C[j] = P[m].mean(0)
    return lab, C

class Hero:
    def __init__(self):
        self.p, self.n, self.uv, self.flex, self.leaf, self.idx, self.ao = [], [], [], [], [], [], []
    def vert(self, p, n, uv, leaf, flexmul=1.0):
        self.p.append(tuple(p)); self.n.append(tuple(n)); self.uv.append(uv); self.leaf.append(leaf); self.flex.append(flexmul)
        return len(self.p) - 1
    def quad(self, a, b, c, d):
        # a b / c d (a, b top)
        self.idx.extend((a, c, b, b, c, d))

def cell_uv(name):
    i = CELLS.index(name)
    cx, cy = i % CGRID[0], i // CGRID[0]
    e = 1.5 / (CELL * CGRID[0])
    u0, u1 = cx / CGRID[0] + e, (cx + 1) / CGRID[0] - e
    # v: 0 at the top of the image (textures are uploaded with flipY = false)
    v0, v1 = cy / CGRID[1] + e * CGRID[0] / CGRID[1], (cy + 1) / CGRID[1] - e * CGRID[0] / CGRID[1]
    return u0, v0, u1, v1

def hero_card(hero, c, eu, ev, w, h, cell, nfun, leaf=1.0, flexmul=1.0, sprite=None):
    """Card centred at c, u axis eu (sprite +x: branch base -> tip), v axis ev."""
    u0, v0, u1, v1 = cell_uv(cell)
    ids = []
    for (su, sv) in ((-1, 1), (1, 1), (-1, -1), (1, -1)):
        p = c + eu * (su * w / 2) + ev * (sv * h / 2)
        uu = u0 + (u1 - u0) * (su * 0.5 + 0.5)
        vv = v0 + (v1 - v0) * (0.5 - sv * 0.5)
        ids.append(hero.vert(p, nfun(p), (uu, vv), leaf, flexmul))
    hero.quad(*ids)

def hero_tubes(hero, sp, allb, max_level, min_r, cell):
    u0, v0, u1, v1 = cell_uv(cell)
    for b in allb:
        if b.level > max_level or b.rad[0] < min_r:
            continue
        if b.level >= 1 and sp.get('conifer'):
            continue   # the conifer limbs hide under their spray cards
        sides = (7, 4, 3, 3)[min(b.level, 3)]
        nseg = len(b.pts) - 1
        keep = sorted(set([0, nseg] + list(range(0, nseg + 1, 2)))) if b.level == 0 else [0, nseg // 2, nseg]
        pts = [b.pts[i] for i in keep]
        rads = [b.rad[i] for i in keep]
        if b.level >= 1 and b.parent is not None:
            # sink the limb's root into its parent so the joint closes
            pass
        total = sum((pts[i] - pts[i - 1]).length for i in range(1, len(pts))) or 1
        Lt = 0
        rings = []
        e1p = None
        for i, p in enumerate(pts):
            d = (pts[i + 1] - p) if i < len(pts) - 1 else (p - pts[i - 1])
            d.normalize()
            e1 = perp(d) if e1p is None else (e1p - d * e1p.dot(d)).normalized()
            e1p = e1
            e2 = d.cross(e1).normalized()
            if i:
                Lt += (pts[i] - pts[i - 1]).length
            ring = []
            for k in range(sides + 1):
                a = 2 * math.pi * k / sides
                n = e1 * math.cos(a) + e2 * math.sin(a)
                ring.append(hero.vert(p + n * rads[i], n, (u0 + (u1 - u0) * k / sides, v1 - (v1 - v0) * (Lt / total)), 0.0))
            rings.append(ring)
        for i in range(len(rings) - 1):
            for k in range(sides):
                hero.quad(rings[i + 1][k], rings[i + 1][k + 1], rings[i][k], rings[i][k + 1])

def build_hero(sp, allb, acc, fronds, bvh):
    rng = random.Random(sp['seed'] * 31 + 5)
    hero = Hero()
    H = sp['H']
    C = V(sp['crown']['c']); R = V(sp['crown']['r'])
    G = sp.get('groups', {})
    barkcell = 'bark_' + sp.get('bark', 'oak')
    if sp['name'].startswith('pine'):
        barkcell = 'bark_pine_top'
    def nfun_crown(lump=None, wl=0.3):
        def f(p):
            cn = crown_normal(sp, p)
            if lump is not None:
                ln = (p - lump)
                ln = ln.normalized() if ln.length > 1e-5 else cn
                cn = (cn * (1 - wl) + ln * wl).normalized()
            return (cn + UPZ * 0.15).normalized()
        return f
    # trunk and limbs
    max_level = 1 if not sp.get('shrub') else 0
    min_r = 0.008
    if sp['name'] in ('birch_bare',):
        max_level = 2
        min_r = 0.0045
    if sp.get('palm'):
        max_level = 0
    hero_tubes(hero, sp, allb, max_level, min_r, barkcell)
    # foliage cards
    co = np.array(acc.v) if acc.v else np.zeros((0, 3))
    mats = np.array(acc.mat)
    mode = G.get('mode', 'kmeans')
    cell = sp.get('cell', sp['name'])
    if mode == 'fronds':
        for rach, dead in fronds:
            steps = 4
            prev = None
            for k in range(steps + 1):
                t = k / steps
                p, d, r = rach.at(t)
                side = d.cross(UPZ)
                side = side.normalized() if side.length > 1e-4 else perp(d)
                prof = math.sin(math.pi * min(1, 0.1 + t * 0.95))
                w = (0.04 + 0.2 * prof) * (0.8 if dead else 1)
                u0, v0, u1, v1 = cell_uv('palm_dead' if dead else 'palm')
                uu = u0 + (u1 - u0) * t
                nrm = (UPZ + (p - V((0, 0, H * 0.9))).normalized() * 0.5).normalized()
                a = hero.vert(p + side * w, nrm, (uu, v0), 1.0 if not dead else 0.3)
                b2 = hero.vert(p - side * w, nrm, (uu, v1), 1.0 if not dead else 0.3)
                if prev:
                    hero.quad(prev[0], a, prev[1], b2)
                prev = (a, b2)
    elif mode == 'branch':
        # conifers: one card per level-1 branch along it (its spray), plus a tip spire
        for b in allb:
            if b.level != 1:
                continue
            p0 = b.pts[0]; p1 = b.pts[-1]
            pm = b.at(0.55)[0]
            d = (p1 - p0)
            L = d.length
            if L < 0.02:
                continue
            d.normalize()
            side = d.cross(UPZ)
            side = side.normalized() if side.length > 1e-4 else perp(d)
            tilt = (side + UPZ * rng.uniform(-0.25, 0.25)).normalized()
            w = max(0.05, L * 0.75)
            u0, v0, u1, v1 = cell_uv(cell)
            pts = [p0, pm, p1 + V((0, 0, -0.01))]
            ts = [0.0, 0.55, 1.0]
            prev = None
            for p, t in zip(pts, ts):
                ww = w * (0.5 + 0.6 * math.sin(math.pi * min(1, 0.2 + t * 0.8)))
                n = nfun_crown()(p)
                a = hero.vert(p + tilt * ww / 2, n, (u0 + (u1 - u0) * t, v0), 1.0)
                c2 = hero.vert(p - tilt * ww / 2, n, (u0 + (u1 - u0) * t, v1), 1.0)
                if prev:
                    hero.quad(prev[0], a, prev[1], c2)
                prev = (a, c2)
        # spire: two crossed vertical cards at the top
        top = allb[0].pts[-1]
        for k in range(2):
            ang = k * math.pi / 2 + 0.4
            side = V((math.cos(ang), math.sin(ang), 0))
            hero_card(hero, top - V((0, 0, 0.09)), V((0, 0, 1)), side, 0.2, 0.12, cell, nfun_crown())
    else:
        leafm = (mats == M_LEAF) | (mats == M_FRUIT) | (mats == M_SNOW) if len(mats) else np.zeros(0, bool)
        if sp.get('leaf') is None:
            # bare: the twig ends
            tips = [b for b in allb if b.level >= 2]
            P = np.array([list(b.at(0.6)[0]) for b in tips]) if tips else np.zeros((0, 3))
            dirs = [b.at(0.5)[1] for b in tips]
        else:
            fidx = np.nonzero(leafm)[0]
            tri = np.array(acc.f)[fidx]
            P = co[tri].mean(1)
            dirs = None
        if mode == 'strands':
            # willow: curtains of hanging strands (vertical strips) + crown cards
            strands = [b for b in allb if b.strand]
            groups = {}
            for b in strands:
                key = id(b.parent)
                groups.setdefault(key, []).append(b)
            chosen = []
            for key, bs in groups.items():
                chosen.extend(bs[::2])
            rng.shuffle(chosen)
            for b in chosen[:G.get('n', 34)]:
                top = b.pts[0]; bot = b.pts[-1]
                mid = b.at(0.5)[0]
                outv = V((top.x, top.y, 0))
                outv = outv.normalized() if outv.length > 1e-4 else V((1, 0, 0))
                side = outv.cross(UPZ).normalized()
                w = 0.075 * rng.uniform(0.85, 1.2)
                u0, v0, u1, v1 = cell_uv('willow_strand')
                prev = None
                for p, t in ((top, 0.0), (mid, 0.5), (bot, 1.0)):
                    n = (outv * 0.7 + UPZ * 0.3).normalized()
                    a = hero.vert(p + side * w / 2, n, (u0 + (u1 - u0) * t, v0), 1.4, 1.5)
                    c2 = hero.vert(p - side * w / 2, n, (u0 + (u1 - u0) * t, v1), 1.4, 1.5)
                    if prev:
                        hero.quad(prev[0], a, prev[1], c2)
                    prev = (a, c2)
            # the crown above the strands
            nonstr = np.array([p for p in P if p[2] > C.z - R.z * 0.2]) if len(P) else P
            P = nonstr
            k = G.get('crown', 18)
        else:
            k = G.get('n', 30)
        if len(P) >= 4:
            lab, cents = kmeans(P, k, rng)
            for j in range(len(cents)):
                pts = P[lab == j]
                if len(pts) < 3:
                    continue
                c = V(pts.mean(0))
                cov = np.cov((pts - pts.mean(0)).T)
                w_, e_ = np.linalg.eigh(cov)
                e1 = V(e_[:, 2]); e2 = V(e_[:, 1]); e3 = V(e_[:, 0])
                s1, s2, s3 = [math.sqrt(max(1e-8, x)) for x in (w_[2], w_[1], w_[0])]
                outw = (c - C)
                outw = outw.normalized() if outw.length > 1e-4 else UPZ.copy()
                if G.get('flat'):
                    e3 = V((0, 0, 1)); e1 = V((e1.x, e1.y, 0)).normalized() if V((e1.x, e1.y, 0)).length > 1e-4 else V((1, 0, 0)); e2 = e3.cross(e1)
                    s2 = max(s2, s1 * 0.6)
                if G.get('upright'):
                    # poplar: cards stand upright
                    e1 = V((0, 0, 1)); hz = V((outw.x, outw.y, 0))
                    e3 = hz.normalized() if hz.length > 1e-4 else V((1, 0, 0)); e2 = e3.cross(e1).normalized()
                    s1 = max(s1, s2)
                if e3.dot(outw) < 0:
                    e3 = -e3
                # the card's u axis runs from the inner end to the outer end (like the sprite's branch)
                if e1.dot(outw) < 0:
                    e1 = -e1
                e2 = e3.cross(e1).normalized()
                w = max(0.03, 4.0 * s1)
                h = max(0.03, 4.0 * s2)
                lumpc = c - outw * 0.02
                hero_card(hero, c, e1, e2, w, h, cell, nfun_crown(lumpc, 0.3))
                if s3 > G.get('cross', 0.5) * s2 or G.get('upright'):
                    hero_card(hero, c, e1, e3, w * 0.92, max(0.03, 4.0 * max(s3, s2 * 0.6)), cell, nfun_crown(lumpc, 0.3))
    # vertex AO: rays against the full model
    rays = []
    golden = math.pi * (3 - math.sqrt(5))
    for i in range(20):
        z = 1 - (i + 0.5) / 20
        r = math.sqrt(1 - z * z)
        rays.append(V((math.cos(i * golden) * r, math.sin(i * golden) * r, z)))
    dist = 0.22 * H
    for i, p in enumerate(hero.p):
        n = V(hero.n[i])
        # local frame around the normal
        t1 = perp(n); t2 = n.cross(t1)
        occ = 0.0; wsum = 0.0
        for d in rays:
            w = d.z
            dirw = (t1 * d.x + t2 * d.y + n * d.z).normalized()
            hit = bvh.ray_cast(V(p) + dirw * 0.004, dirw, dist)
            if hit[0] is not None:
                occ += w
            wsum += w
        ao = 1 - occ / wsum
        hero.ao.append(ao)
    return hero

def hero_object(hero, sp):
    me = bpy.data.meshes.new('hero_' + sp['name'])
    verts = hero.p
    faces = [tuple(hero.idx[i:i + 3]) for i in range(0, len(hero.idx), 3)]
    me.from_pydata(verts, [], faces)
    me.update()
    # per-corner UVs
    uvl = me.uv_layers.new(name='UVMap')
    uvd = []
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            u, v = hero.uv[vi]
            uvd.extend((u, 1.0 - v))   # glTF flips V on export; the game reads V top-down (flipY = false)
    uvl.data.foreach_set('uv', uvd)
    H = sp['H']
    flexK = sp['flexK']
    ao = np.array(hero.ao)
    col = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    flat = []
    for i, p in enumerate(verts):
        a = 0.42 + 0.58 * ao[i]
        flat.extend((a, a, a, 1))
    col.data.foreach_set('color', flat)
    fl = me.attributes.new('_FLEX', 'FLOAT', 'POINT')
    fl.data.foreach_set('value', [flexK * max(0.0, p[2] / H) ** 2 * hero.flex[i] for i, p in enumerate(verts)])
    lf = me.attributes.new('_LEAF', 'FLOAT', 'POINT')
    lf.data.foreach_set('value', hero.leaf)
    # custom split normals (the canopy normals)
    me.normals_split_custom_set_from_vertices([tuple(n) for n in hero.n])
    ob = bpy.data.objects.new(sp['name'], me)
    return ob

# ------------------------------------------------------------------ main

def main():
    names = [n for n in ORDER if not ONLY or n in ONLY]
    meta_path = os.path.join(OUT, 'meta.json')
    meta_all = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
    sc = reset_scene()
    hero_objs = []
    cells_a, cells_n = {}, {}
    for name in names:
        t0 = time.time()
        sp = spec(name)
        trunks, allb, acc, fronds = build_tree(sp)
        ob = acc_to_object(acc, name, mats_for(sp))
        meta = meta_all.get(name, {})
        meta.update(H=sp['H'], flexK=sp['flexK'], tris_full=len(acc.f), cell=sp.get('cell', name))
        print(f'{name}: {len(acc.f)} triangles, {len(allb)} branches')
        if 'imp' in STAGES:
            render_impostor(sc, sp, ob, meta)
        if 'cards' in STAGES:
            rng = random.Random(sp['seed'] * 101 + 7)
            kinds = [sp.get('cell', name)]
            if name == 'willow': kinds.append('willow_strand')
            if name == 'palm': kinds.append('palm_dead')
            for kd in kinds:
                pacc, L = proto_cluster(sp, rng, kd)
                ia, inn, info = render_sprite(sc, pacc, sp, L, kd)
                write_png(os.path.join(OUT, f'cell_{kd}_a.png'), ia)
                write_png(os.path.join(OUT, f'cell_{kd}_n.png'), inn)
        if 'hero' in STAGES:
            bm = bmesh.new(); bm.from_mesh(ob.data); bvh = BVHTree.FromBMesh(bm); bm.free()
            hero = build_hero(sp, allb, acc, fronds, bvh)
            ho = hero_object(hero, sp)
            hero_objs.append(ho)
            meta.update(hero_tris=len(hero.idx) // 3, hero_verts=len(hero.p))
            print(f'  hero {len(hero.idx) // 3} tris')
        if 'sheet' in STAGES:
            ob.name = 'full_' + name
            ob['sheet'] = True
            sc.collection.objects.link(ob)
            ob.hide_render = True
        meta_all[name] = meta
        print(f'  {name} done in {time.time() - t0:.1f}s')
        json.dump(meta_all, open(meta_path, 'w'), indent=1)
    if 'cards' in STAGES and (not ONLY or 'bark' in ONLY or len(names) == len(ORDER)):
        for bk, tint in (('oak', (1, 1, 1)), ('birch', (1, 1, 1)), ('pine', (1, 1, 1)), ('palm', (1, 1, 1)), ('pine_top', (1.25, 0.82, 0.55))):
            ia, inn = render_bark_cell(sc, 'pine' if bk == 'pine_top' else bk, tint)
            write_png(os.path.join(OUT, f'cell_bark_{bk}_a.png'), ia)
            write_png(os.path.join(OUT, f'cell_bark_{bk}_n.png'), inn)
    if 'hero' in STAGES and hero_objs:
        # export the hero meshes (geometry only) for tools/bake-trees.mjs
        for o in list(sc.collection.objects):
            o.select_set(False)
        coll = bpy.data.collections.new('hero'); sc.collection.children.link(coll)
        for ho in hero_objs:
            coll.objects.link(ho)
            ho.select_set(True)
        tag = '_'.join(names) if ONLY else 'all'
        bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, f'hero_{tag}.glb'), export_format='GLB', use_selection=True,
                                  export_attributes=True, export_materials='NONE', export_normals=True, export_texcoords=True,
                                  export_vertex_color='ACTIVE', export_all_vertex_colors=False, export_yup=True)
        for ho in hero_objs:
            coll.objects.unlink(ho)
    if 'sheet' in STAGES:
        contact_sheet(sc, names)
    print('OK_DONE')

def contact_sheet(sc, names):
    """All species in a row on a ground plane under a low sun, rendered with their full materials."""
    set_ch(ch=3)
    sc.cycles.max_bounces = 4
    sc.cycles.samples = int(arg('--sheetspp', '48'))
    sc.cycles.use_denoising = True
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_depth = '8'
    sc.view_settings.view_transform = 'AgX' if 'AgX' in [e.identifier for e in sc.view_settings.bl_rna.properties['view_transform'].enum_items] else sc.view_settings.view_transform
    w = sc.world
    w.use_nodes = True
    bg = w.node_tree.nodes.get('Background') or w.node_tree.nodes.new('ShaderNodeBackground')
    sky = w.node_tree.nodes.new('ShaderNodeTexSky')
    try:
        sky.sky_type = 'NISHITA'
        sky.sun_elevation = math.radians(35); sky.sun_rotation = math.radians(140)
    except Exception:
        pass
    w.node_tree.links.new(sky.outputs[0], bg.inputs[0]); bg.inputs[1].default_value = 0.3
    wo = w.node_tree.nodes.get('World Output') or w.node_tree.nodes.new('ShaderNodeOutputWorld')
    w.node_tree.links.new(bg.outputs[0], wo.inputs[0])
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 3.2; sun.data.angle = math.radians(1.5)
    sun.rotation_euler = (math.radians(55), 0, math.radians(140))
    sc.collection.objects.link(sun)
    # ground
    gm = bpy.data.materials.new('ground'); gm.use_nodes = True
    gb = gm.node_tree.nodes['Principled BSDF']; gb.inputs['Base Color'].default_value = (0.16, 0.15, 0.11, 1); gb.inputs['Roughness'].default_value = 1
    bpy.ops.mesh.primitive_plane_add(size=60)
    gp = bpy.context.object; gp.data.materials.append(gm)
    # rows: trees, then the shrubs (scaled up 2x so they read)
    xs = 0.0
    placed = []
    big = [n for n in names if not SPECIES.get(n, {}).get('shrub') and not SPECIES.get(SPECIES.get(n, {}).get('base', ''), {}).get('shrub')]
    small = [n for n in names if n not in big]
    for row, lst, sc_k, y in ((0, big, 1.0, 0.0), (1, small, 2.2, -1.6)):
        x = 0.0
        for n in lst:
            ob = bpy.data.objects.get('full_' + n)
            if not ob:
                continue
            sp = spec(n)
            r = max(SPECIES.get(n, {}).get('crown', spec(n)['crown'])['r'][0], 0.2) * sc_k
            x += r + 0.08
            ob.hide_render = False
            ob.location = (x, y, 0)
            ob.scale = (sc_k, sc_k, sc_k)
            placed.append((n, x, y))
            x += r + 0.08
        if row == 0:
            xs = x
    width = max(xs, 1.0)
    cam = bpy.data.objects.new('sheetcam', bpy.data.cameras.new('sheetcam'))
    cam.data.type = 'ORTHO'; cam.data.ortho_scale = width * 1.04
    vd = V((0, math.sin(math.radians(64)), -math.cos(math.radians(64))))
    cam.location = V((width / 2, -0.8, 0.5)) - vd * 12
    cam.rotation_euler = (math.radians(64), 0, 0)
    sc.collection.objects.link(cam); sc.camera = cam
    sc.render.resolution_x = SHEET_W
    sc.render.resolution_y = int(SHEET_W * 0.42)
    sc.render.filepath = os.path.join(OUT, 'contact_sheet.png')
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    print(f'contact sheet {time.time() - t0:.1f}s')

main()
