"""
Iron Front - BI2 hero soldier: procedural Cycles materials (Blender 5.2.2 LTS).
Everything fine (weave, stitching, lugs, grime, edge wear) lives in shader nodes so phase 2 can bake
it into normal/colour maps instead of carrying it as geometry.
"""
import bpy, math
import numpy as np


def srgb(r, g, b, a=1.0):
    def c(x):
        x = x / 255.0
        return x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4
    return (c(r), c(g), c(b), a)


class T:
    """tiny node-tree builder."""

    def __init__(self, name):
        self.m = bpy.data.materials.new(name)
        self.m.use_nodes = True
        self.nt = self.m.node_tree
        self.nt.nodes.clear()
        self.out = self.n('ShaderNodeOutputMaterial')
        self.x = 0

    def n(self, kind, **props):
        nd = self.nt.nodes.new(kind)
        for k, v in props.items():
            if k.startswith('i_'):
                key = k[2:].replace('__', ' ')
                nd.inputs[key].default_value = v
            else:
                setattr(nd, k, v)
        return nd

    def l(self, a, b):
        self.nt.links.new(a, b)
        return b

    def math(self, op, a, b=None, clamp=False):
        nd = self.n('ShaderNodeMath', operation=op, use_clamp=clamp)
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                nd.inputs[i].default_value = v
            else:
                self.l(v, nd.inputs[i])
        return nd.outputs[0]

    def mix(self, fac, a, b, blend='MIX'):
        nd = self.n('ShaderNodeMix', data_type='RGBA', blend_type=blend)
        for sock, v in ((nd.inputs['Factor'], fac), (nd.inputs['A'], a), (nd.inputs['B'], b)):
            if isinstance(v, (int, float)):
                sock.default_value = v
            elif isinstance(v, tuple):
                sock.default_value = v
            else:
                self.l(v, sock)
        return nd.outputs['Result']

    def maprange(self, v, a, b, c=0.0, d=1.0, clamp=True, smooth=False):
        nd = self.n('ShaderNodeMapRange', clamp=clamp, interpolation_type='SMOOTHSTEP' if smooth else 'LINEAR')
        self.l(v, nd.inputs['Value'])
        nd.inputs['From Min'].default_value = a
        nd.inputs['From Max'].default_value = b
        nd.inputs['To Min'].default_value = c
        nd.inputs['To Max'].default_value = d
        return nd.outputs['Result']

    def noise(self, vec, scale, detail=4.0, rough=0.55, distortion=0.0, dim='3D', w=0.0):
        nd = self.n('ShaderNodeTexNoise', noise_dimensions=dim)
        if vec is not None:
            self.l(vec, nd.inputs['Vector'])
        nd.inputs['Scale'].default_value = scale
        nd.inputs['Detail'].default_value = detail
        nd.inputs['Roughness'].default_value = rough
        nd.inputs['Distortion'].default_value = distortion
        return nd

    def wave(self, vec, scale, axis='X', kind='BANDS', profile='SIN', distortion=0.0):
        nd = self.n('ShaderNodeTexWave', wave_type=kind, bands_direction=axis, wave_profile=profile)
        if vec is not None:
            self.l(vec, nd.inputs['Vector'])
        nd.inputs['Scale'].default_value = scale
        nd.inputs['Distortion'].default_value = distortion
        return nd.outputs['Fac']

    def coords(self, kind='Object'):
        return self.n('ShaderNodeTexCoord').outputs[kind]

    def geo(self, out):
        return self.n('ShaderNodeNewGeometry').outputs[out]

    def ao(self, dist=0.05):
        nd = self.n('ShaderNodeAmbientOcclusion', samples=8)
        nd.inputs['Distance'].default_value = dist
        return nd.outputs['AO']

    def bump(self, h, strength, dist=0.001, normal=None):
        nd = self.n('ShaderNodeBump')
        self.l(h, nd.inputs['Height'])
        nd.inputs['Strength'].default_value = strength
        nd.inputs['Distance'].default_value = dist
        if normal is not None:
            self.l(normal, nd.inputs['Normal'])
        return nd.outputs['Normal']

    def bsdf(self, color, rough=0.8, metal=0.0, normal=None, spec=0.35, sheen=0.0, **extra):
        b = self.n('ShaderNodeBsdfPrincipled')
        for key, v in (('Base Color', color), ('Roughness', rough), ('Metallic', metal)):
            if isinstance(v, (int, float, tuple)):
                b.inputs[key].default_value = v
            else:
                self.l(v, b.inputs[key])
        b.inputs['Specular IOR Level'].default_value = spec
        if sheen:
            # subtle, colour-tinted fibre sheen (a white sheen washes the olive out to sage)
            b.inputs['Sheen Weight'].default_value = sheen * 0.35
            b.inputs['Sheen Roughness'].default_value = 0.5
            if isinstance(color, tuple):
                b.inputs['Sheen Tint'].default_value = color
            else:
                self.l(color, b.inputs['Sheen Tint'])
        for k, v in extra.items():
            k = k.replace('_', ' ')
            if isinstance(v, (int, float, tuple)):
                b.inputs[k].default_value = v
            else:
                self.l(v, b.inputs[k])
        if normal is not None:
            self.l(normal, b.inputs['Normal'])
        self.l(b.outputs[0], self.out.inputs['Surface'])
        return b

    def colramp(self, fac, stops, interp='LINEAR'):
        nd = self.n('ShaderNodeValToRGB')
        cr = nd.color_ramp
        cr.interpolation = interp
        while len(cr.elements) > len(stops):
            cr.elements.remove(cr.elements[-1])
        while len(cr.elements) < len(stops):
            cr.elements.new(0.5)
        for e, (p, c) in zip(cr.elements, stops):
            e.position = p
            e.color = c
        self.l(fac, nd.inputs['Fac'])
        return nd.outputs['Color']


def weave_height(t, vec, scale):
    a = t.wave(vec, scale, 'X')
    b = t.wave(vec, scale, 'Y')
    c = t.wave(vec, scale, 'Z')
    s = t.math('ADD', t.math('ADD', a, b), c)
    return t.math('MULTIPLY', s, 0.333)


SEAM_W = 0.012


def gauss(t, x, c, w):
    q = t.math('DIVIDE', t.math('SUBTRACT', x, c), w)
    return t.math('EXPONENT', t.math('MULTIPLY', t.math('MULTIPLY', q, q), -1.0))


def seams(t, col, nrm, thread=None, strength=0.5, fade=0.05, rows=(0.0045, 0.0085)):
    """seam groove + two rows of dashed top-stitching + faded fabric along the 'seam' attribute
    (closeness 1 on the seam -> 0 at 12 mm; absent attribute = no seam)."""
    at = t.n('ShaderNodeAttribute', attribute_type='GEOMETRY', attribute_name='seam')
    d = t.math('MULTIPLY', t.math('SUBTRACT', 1.0, at.outputs['Fac']), SEAM_W)
    groove = gauss(t, d, 0.0, 0.0017)
    oc = t.coords('Object')
    sep = t.n('ShaderNodeSeparateXYZ')
    t.l(oc, sep.inputs[0])
    sm = t.math('ADD', t.math('ADD', sep.outputs['X'], sep.outputs['Y']), sep.outputs['Z'])
    dash = t.maprange(t.math('SINE', t.math('MULTIPLY', sm, 2 * math.pi / 0.0034)), 0.1, 0.5)
    row = None
    for r in rows:
        g = gauss(t, d, r, 0.0007)
        row = g if row is None else t.math('ADD', row, g)
    stitch = t.math('MULTIPLY', row, dash)
    h = t.math('SUBTRACT', t.math('MULTIPLY', stitch, 0.7), groove)
    nrm = t.bump(h, strength, 0.0015, nrm)
    col = t.mix(t.math('MULTIPLY', gauss(t, d, 0.0, 0.006), fade), col, (0.62, 0.6, 0.5, 1), 'SCREEN')
    col = t.mix(t.math('MULTIPLY', groove, 0.35), col, (0, 0, 0, 1))
    if thread is not None:
        col = t.mix(t.math('MULTIPLY', stitch, 0.35), col, thread)
    return col, nrm


def fabric(name, base, var, weave=900.0, bump=0.18, dust=0.25, low_dust=0.0, sheen=0.35, rough=0.86,
           ao_dark=0.45, camo=None, stitch=None, wear=0.25, fold_bump=0.0):
    """woven cloth: colour variation, weave bump, AO crease darkening, dust, worn edges.
    camo = list of (threshold, colour) blotch layers; stitch = (axis, spacing) bar-tack stitch lines."""
    t = T(name)
    oc = t.coords('Object')
    pos = t.geo('Position')
    nz = t.noise(oc, 4.0, 6.0, 0.6)
    col = t.mix(t.maprange(nz.outputs['Fac'], 0.3, 0.7), base, var)
    if camo:
        dn = t.noise(oc, 2.2, 3.0, 0.5, distortion=0.0)
        for i, (thr, c, sc) in enumerate(camo):
            n2 = t.noise(dn.outputs['Color'] if i else oc, sc, 3.0, 0.45, distortion=0.4)
            m = t.maprange(n2.outputs['Fac'], thr, thr + 0.015)
            col = t.mix(m, col, c)
        col = t.mix(t.maprange(nz.outputs['Fac'], 0.2, 0.8), col, t.mix(0.5, col, (0.5, 0.5, 0.5, 1), 'MULTIPLY'))
    # fine fibre noise
    fib = t.noise(oc, 260.0, 2.0, 0.5)
    col = t.mix(t.maprange(fib.outputs['Fac'], 0.35, 0.65, 0.0, 0.12), col, (0.0, 0.0, 0.0, 1))
    # crease darkening
    aov = t.ao(0.05)
    col = t.mix(t.maprange(aov, 0.0, 1.0, ao_dark, 0.0), col, (0.0, 0.0, 0.0, 1))
    # worn / frayed edges
    if wear:
        pt = t.geo('Pointiness')
        we = t.math('MULTIPLY', t.maprange(pt, 0.52, 0.62), t.maprange(t.noise(oc, 40.0, 3).outputs['Fac'], 0.4, 0.6))
        col = t.mix(t.math('MULTIPLY', we, wear), col, (0.55, 0.52, 0.42, 1))
    # dust: patchy everywhere + heavier near the ground
    if dust or low_dust:
        dn2 = t.noise(pos, 7.0, 6.0, 0.65)
        m = t.maprange(dn2.outputs['Fac'], 0.55, 0.75, 0.0, dust)
        if low_dust:
            sep = t.n('ShaderNodeSeparateXYZ')
            t.l(pos, sep.inputs[0])
            low = t.maprange(sep.outputs['Z'], 0.05, 0.55, low_dust, 0.0)
            m = t.math('ADD', m, t.math('MULTIPLY', low, t.maprange(dn2.outputs['Fac'], 0.35, 0.6)))
        col = t.mix(t.math('MINIMUM', m, 0.8), col, srgb(150, 135, 108))
    h = weave_height(t, oc, weave)
    h = t.math('ADD', t.math('MULTIPLY', h, 0.7), t.math('MULTIPLY', fib.outputs['Fac'], 0.5))
    if stitch:
        axis, spacing = stitch
        st = t.wave(oc, 1.0 / spacing, axis, profile='SAW')
        h = t.math('ADD', h, t.maprange(st, 0.9, 1.0, 0.0, 0.6))
    nrm = t.bump(h, bump, 0.0008)
    if fold_bump:
        fb = t.noise(oc, 9.0, 3.0, 0.5, distortion=0.6)
        nrm = t.bump(fb.outputs['Fac'], fold_bump, 0.01, nrm)
    col, nrm = seams(t, col, nrm, thread=t.mix(0.25, base, (0.6, 0.58, 0.48, 1)))
    t.bsdf(col, rough, normal=nrm, spec=0.3, sheen=sheen)
    return t.m


def webbing(name, base):
    """nylon webbing: ribbed along its length + darker MOLLE bar tacks."""
    t = T(name)
    oc = t.coords('Object')
    rib = t.wave(oc, 1400.0, 'Z')
    nz = t.noise(oc, 30.0, 3.0)
    col = t.mix(t.maprange(nz.outputs['Fac'], 0.3, 0.7, 0.0, 0.25), base, (0, 0, 0, 1))
    aov = t.ao(0.03)
    col = t.mix(t.maprange(aov, 0.0, 1.0, 0.5, 0.0), col, (0, 0, 0, 1))
    col, nrm = seams(t, col, t.bump(rib, 0.25, 0.0005), strength=0.4, fade=0.03, rows=(0.0025,))
    t.bsdf(col, 0.7, normal=nrm, spec=0.35, sheen=0.2)
    return t.m


def plastic(name, base, rough=0.5, wear=0.35, bump=0.06, metal=0.0, wear_col=None, scale=180.0):
    """polymer / painted metal with edge wear (pointiness), grime in cavities, micro texture."""
    t = T(name)
    oc = t.coords('Object')
    nz = t.noise(oc, scale, 4.0, 0.6)
    col = base
    pt = t.geo('Pointiness')
    edge = t.math('MULTIPLY', t.maprange(pt, 0.53, 0.66), t.maprange(t.noise(oc, 60.0, 4).outputs['Fac'], 0.42, 0.58))
    col = t.mix(t.math('MULTIPLY', edge, wear), col, wear_col or (0.25, 0.24, 0.22, 1))
    aov = t.ao(0.03)
    col = t.mix(t.maprange(aov, 0.0, 1.0, 0.5, 0.0), col, (0, 0, 0, 1))
    grime = t.noise(oc, 12.0, 5.0, 0.6)
    col = t.mix(t.maprange(grime.outputs['Fac'], 0.55, 0.8, 0.0, 0.25), col, srgb(120, 108, 88))
    r = t.math('ADD', rough, t.maprange(nz.outputs['Fac'], 0.3, 0.7, -0.08, 0.08))
    r = t.math('ADD', r, t.math('MULTIPLY', edge, -0.15))
    m = metal if isinstance(metal, (int, float)) else metal
    t.bsdf(col, r, metal=m, normal=t.bump(nz.outputs['Fac'], bump, 0.0005), spec=0.45)
    return t.m


def skin(name):
    """weathered skin of a man in his twenties: tan with blotchy redness, pores (voronoi pits), roughness
    variation (oilier T-zone), stubble speckle on jaw / upper lip / cheeks, eyebrows, darker eye sockets,
    short dark hair at the temples and nape under the helmet. Position masks are in world space
    (the face looks to -Y)."""
    t = T(name)
    pos = t.geo('Position')
    oc = t.coords('Object')
    # face masks in un-scaled head space (the head is scaled by HEAD_S about HEAD_PIVOT at the end of stage 2)
    from hero_lib import HEAD_S, HEAD_PIVOT
    hp = t.n('ShaderNodeVectorMath', operation='SUBTRACT')
    t.l(pos, hp.inputs[0])
    hp.inputs[1].default_value = tuple(HEAD_PIVOT)
    hs = t.n('ShaderNodeVectorMath', operation='MULTIPLY_ADD')
    t.l(hp.outputs[0], hs.inputs[0])
    hs.inputs[1].default_value = (1.0 / HEAD_S,) * 3
    hs.inputs[2].default_value = tuple(HEAD_PIVOT)
    sep = t.n('ShaderNodeSeparateXYZ')
    t.l(hs.outputs[0], sep.inputs[0])
    X, Y, Z = sep.outputs['X'], sep.outputs['Y'], sep.outputs['Z']
    ax = t.math('ABSOLUTE', X)
    base = srgb(160, 116, 92)
    nz = t.noise(oc, 30.0, 6.0, 0.6)
    col = t.mix(t.maprange(nz.outputs['Fac'], 0.3, 0.7), base, srgb(142, 100, 80))
    blot = t.noise(oc, 9.0, 4.0, 0.55)
    col = t.mix(t.maprange(blot.outputs['Fac'], 0.5, 0.72, 0.0, 0.35), col, srgb(165, 88, 72))
    freck = t.noise(oc, 160.0, 2.0, 0.5)
    col = t.mix(t.maprange(freck.outputs['Fac'], 0.6, 0.75, 0.0, 0.25), col, srgb(120, 78, 56))
    # redness on the nose and cheeks (sun)
    nose = t.math('MULTIPLY', t.maprange(ax, 0.025, 0.0), t.maprange(Y, -0.145, -0.17))
    cheek = t.math('MULTIPLY', gauss(t, ax, 0.05, 0.018), gauss(t, Z, 1.655, 0.015))
    cheek = t.math('MULTIPLY', cheek, t.maprange(Y, -0.09, -0.13))
    col = t.mix(t.math('MINIMUM', t.math('ADD', nose, cheek), 0.3), col, srgb(168, 90, 78))
    # darker eye sockets
    eyes = t.math('MULTIPLY', gauss(t, ax, 0.034, 0.016), gauss(t, Z, 1.675, 0.01))
    col = t.mix(t.math('MULTIPLY', eyes, 0.35), col, srgb(96, 62, 58))
    # eyebrows: thick, slightly straight
    dx = t.math('SUBTRACT', ax, 0.036)
    arch = t.math('ADD', 1.7065, t.math('MULTIPLY', t.math('MULTIPLY', dx, dx), -4.0))
    dz = t.math('ABSOLUTE', t.math('SUBTRACT', Z, arch))
    brow = t.math('MULTIPLY', t.maprange(dz, 0.0055, 0.002), t.maprange(t.math('ABSOLUTE', dx), 0.032, 0.024))
    brow = t.math('MULTIPLY', brow, t.maprange(Y, -0.10, -0.125))
    hairn = t.noise(oc, 700.0, 2.0)
    brow = t.math('MULTIPLY', brow, t.maprange(hairn.outputs['Fac'], 0.3, 0.6, 0.55, 1.0))
    col = t.mix(brow, col, srgb(34, 25, 20))
    # lips: natural, slightly darker / redder, a soft mouth line, drier (rougher) than the skin around
    lipz = t.math('MULTIPLY', gauss(t, Z, 1.6055, 0.0085), t.maprange(ax, 0.026, 0.017))
    lipz = t.math('MULTIPLY', lipz, t.maprange(Y, -0.145, -0.155))
    col = t.mix(t.math('MULTIPLY', lipz, 0.6), col, srgb(150, 82, 74))
    mline = t.math('MULTIPLY', gauss(t, Z, 1.6045, 0.0012), t.maprange(ax, 0.024, 0.015))
    col = t.mix(t.math('MULTIPLY', mline, 0.55), col, srgb(70, 40, 36))
    # stubble (a few days' growth): bluish-grey beard shadow + dark hair dots on jaw, chin, upper lip,
    # lower cheeks and under the chin; the cheek line rises towards the ears; lips stay clear
    cheekline = t.math('ADD', 1.622, t.math('MULTIPLY', t.maprange(ax, 0.025, 0.06), 0.03))
    beard = t.maprange(t.math('SUBTRACT', cheekline, Z), -0.002, 0.006)
    beard = t.math('MULTIPLY', beard, t.maprange(Y, -0.035, -0.06))
    beard = t.math('MULTIPLY', beard, t.math('SUBTRACT', 1.0, t.math('MULTIPLY', lipz, 1.4)))
    beard = t.math('MULTIPLY', beard, t.maprange(Z, 1.52, 1.545))   # fades out down the neck
    beard = t.math('MAXIMUM', beard, 0.0)
    bn = t.noise(oc, 25.0, 3.0)
    beard = t.math('MULTIPLY', beard, t.maprange(bn.outputs['Fac'], 0.3, 0.6, 0.75, 1.0))
    vor = t.n('ShaderNodeTexVoronoi', feature='F1')
    t.l(oc, vor.inputs['Vector'])
    vor.inputs['Scale'].default_value = 1100.0
    vor.inputs['Randomness'].default_value = 1.0
    dots = t.maprange(vor.outputs['Distance'], 0.32, 0.12)
    col = t.mix(t.math('MULTIPLY', beard, 0.6), col, srgb(88, 82, 82))
    col = t.mix(t.math('MULTIPLY', beard, t.math('MULTIPLY', dots, 0.95)), col, srgb(22, 18, 16))
    # short hair at the temples / sideburns / nape (under the helmet rim)
    hair = t.math('MULTIPLY', t.maprange(Z, 1.635, 1.65), t.maprange(Y, -0.085, -0.06))
    hair = t.math('MAXIMUM', hair, t.math('MULTIPLY', t.maprange(Z, 1.6, 1.625), t.maprange(Y, 0.0, 0.03)))
    hair = t.math('MULTIPLY', hair, t.maprange(t.noise(oc, 300.0, 3.0).outputs['Fac'], 0.3, 0.55, 0.6, 1.0))
    col = t.mix(hair, col, srgb(28, 22, 18))
    # mottled redness / sallow variation over the whole face (sun, shaving)
    mot = t.noise(oc, 45.0, 4.0, 0.6)
    col = t.mix(t.maprange(mot.outputs['Fac'], 0.45, 0.7, 0.0, 0.3), col, srgb(170, 92, 78))
    col = t.mix(t.maprange(mot.outputs['Fac'], 0.25, 0.4, 0.2, 0.0), col, srgb(150, 118, 86))
    # pores (pits), fine wrinkles, crow's feet / forehead lines, stubble bumps
    pv = t.n('ShaderNodeTexVoronoi', feature='F1')
    t.l(oc, pv.inputs['Vector'])
    pv.inputs['Scale'].default_value = 1300.0
    pores = t.maprange(pv.outputs['Distance'], 0.0, 0.3, -1.0, 0.0)
    fine = t.noise(oc, 400.0, 4.0, 0.6)
    h = t.math('ADD', pores, t.math('MULTIPLY', fine.outputs['Fac'], 0.7))
    lines = t.wave(oc, 1.0 / 0.006, 'Z')
    fore = t.math('MULTIPLY', t.maprange(Z, 1.715, 1.725), t.maprange(Y, -0.11, -0.13))
    h = t.math('ADD', h, t.math('MULTIPLY', t.math('MULTIPLY', lines, fore), 0.5))
    h = t.math('ADD', h, t.math('MULTIPLY', t.math('MULTIPLY', beard, dots), 0.9))
    nrm = t.bump(h, 0.45, 0.0005)
    # roughness: gentle sweat sheen on forehead / nose / upper lip, drier cheeks, matte stubble
    tz = t.math('MAXIMUM', nose, t.math('MULTIPLY', t.maprange(Z, 1.69, 1.70), t.maprange(ax, 0.05, 0.03)))
    rough = t.math('SUBTRACT', t.maprange(t.noise(oc, 60.0, 4.0).outputs['Fac'], 0.3, 0.7, 0.46, 0.62), t.math('MULTIPLY', tz, 0.12))
    rough = t.math('ADD', rough, t.math('MULTIPLY', t.math('MAXIMUM', beard, hair), 0.22))
    rough = t.math('ADD', rough, t.math('MULTIPLY', lipz, 0.08))
    t.bsdf(col, rough, normal=nrm, spec=0.42,
           Subsurface_Weight=0.12, Subsurface_Radius=(1.0, 0.35, 0.2), Subsurface_Scale=0.004)
    return t.m


def mesh_net(name):
    """Mitznefet netting: woodland camo (khaki / green / brown / dark green blotches) printed on an open mesh
    whose round holes are cut with alpha, so the dark helmet shell shows through."""
    t = T(name)
    oc = t.coords('Object')
    nz = t.noise(oc, 9.0, 4.0, 0.6)
    col = t.mix(t.maprange(nz.outputs['Fac'], 0.3, 0.7), srgb(118, 112, 76), srgb(104, 100, 66))
    dn = t.noise(oc, 6.0, 3.0, 0.5)
    for i, (thr, c, sc) in enumerate(((0.5, srgb(70, 84, 46), 16.0), (0.56, srgb(100, 74, 46), 20.0),
                                      (0.6, srgb(42, 50, 32), 26.0))):
        n2 = t.noise(dn.outputs['Color'] if i else oc, sc, 3.0, 0.45, distortion=0.5)
        col = t.mix(t.maprange(n2.outputs['Fac'], thr, thr + 0.02), col, c)
    vor = t.n('ShaderNodeTexVoronoi', feature='F1')
    t.l(oc, vor.inputs['Vector'])
    vor.inputs['Scale'].default_value = 190.0
    vor.inputs['Randomness'].default_value = 0.2
    thread = t.maprange(vor.outputs['Distance'], 0.45, 0.50)       # 0 = hole, 1 = netting
    fib = t.noise(oc, 900.0, 2.0, 0.5)
    col = t.mix(t.maprange(fib.outputs['Fac'], 0.35, 0.65, 0.0, 0.15), col, (0.0, 0.0, 0.0, 1))
    aov = t.ao(0.04)
    col = t.mix(t.maprange(aov, 0.0, 1.0, 0.5, 0.0), col, (0.0, 0.0, 0.0, 1))
    h = t.math('ADD', thread, t.math('MULTIPLY', fib.outputs['Fac'], 0.3))
    t.bsdf(col, 0.86, normal=t.bump(h, 0.35, 0.0006), spec=0.3, sheen=0.3, Alpha=thread)
    return t.m


def glass(name, tint=(0.82, 0.84, 0.80, 1)):
    t = T(name)
    t.bsdf(tint, 0.03, spec=0.5, Transmission_Weight=1.0, IOR=1.5)
    return t.m


def rubber_sole(name):
    t = T(name)
    oc = t.coords('Object')
    pos = t.geo('Position')
    nz = t.noise(oc, 80.0, 3.0)
    lug = t.n('ShaderNodeTexVoronoi', feature='F1')
    t.l(oc, lug.inputs['Vector'])
    lug.inputs['Scale'].default_value = 90.0
    h = t.maprange(lug.outputs['Distance'], 0.2, 0.45)
    col = t.mix(t.maprange(nz.outputs['Fac'], 0.4, 0.7, 0.0, 0.3), srgb(48, 42, 36), srgb(130, 116, 92))
    t.bsdf(col, 0.8, normal=t.bump(h, 0.5, 0.002), spec=0.3)
    return t.m


def leather_boot(name):
    """suede upper with smoother leather toe/heel caps (by position) and ground dust."""
    t = T(name)
    oc = t.coords('Object')
    pos = t.geo('Position')
    sep = t.n('ShaderNodeSeparateXYZ')
    t.l(pos, sep.inputs[0])
    suede = srgb(84, 64, 46)
    leather = srgb(62, 46, 33)
    nz = t.noise(oc, 60.0, 6.0, 0.7)
    col = t.mix(t.maprange(nz.outputs['Fac'], 0.3, 0.7), suede, srgb(96, 74, 52))
    cap = t.maprange(sep.outputs['Z'], 0.075, 0.06)
    col = t.mix(cap, col, leather)
    aov = t.ao(0.03)
    col = t.mix(t.maprange(aov, 0.0, 1.0, 0.55, 0.0), col, (0, 0, 0, 1))
    dn = t.noise(pos, 9.0, 5.0)
    col = t.mix(t.math('MULTIPLY', t.maprange(sep.outputs['Z'], 0.02, 0.09, 0.15, 0.0), t.maprange(dn.outputs['Fac'], 0.35, 0.6)),
                col, srgb(165, 148, 118))
    fib = t.noise(oc, 700.0, 2.0)
    stitch = t.wave(oc, 1.0 / 0.004, 'Z', profile='SAW')
    h = t.math('ADD', fib.outputs['Fac'], t.math('MULTIPLY', t.maprange(stitch, 0.92, 1.0), 0.0))
    col, nrm = seams(t, col, t.bump(h, 0.2, 0.0006), thread=srgb(130, 112, 86), fade=0.04)
    t.bsdf(col, 0.82, normal=nrm, spec=0.3, sheen=0.3)
    return t.m


def flag_image():
    """Israeli flag (white, two blue stripes, Star of David) generated with numpy; packed into the blend."""
    W, H = 440, 320
    img = np.ones((H, W, 4), dtype=np.float32)
    blue = np.array(srgb(0, 56, 184))
    ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
    v = (ys + 0.5) / H  # 0 bottom .. 1 top (blender images start at the bottom)
    u = (xs + 0.5) / W
    stripe = ((v > 15 / 220) & (v < 40 / 220)) | ((v > 180 / 220) & (v < 205 / 220))
    img[stripe] = blue
    cx, cy = 0.5 * W, 0.5 * H
    R = 0.24 * H
    lw = 0.035 * H
    px, py = xs - cx, ys - cy

    def tri(rot):
        # distance-like test for an equilateral triangle ring of circumradius R
        inside_outer = np.ones_like(px, dtype=bool)
        inside_inner = np.ones_like(px, dtype=bool)
        for k in range(3):
            a = rot + k * 2 * math.pi / 3
            nx, ny = math.cos(a), math.sin(a)
            d = px * nx + py * ny
            inside_outer &= d < R * 0.5 + lw * 0.5
            inside_inner &= d < R * 0.5 - lw * 0.5
        return inside_outer & ~inside_inner
    star = tri(math.pi / 2) | tri(-math.pi / 2)
    img[star] = blue
    # soft fabric darkening at the border (embroidered edge)
    border = (u < 0.03) | (u > 0.97) | (v < 0.04) | (v > 0.96)
    img[border] = np.array(srgb(90, 92, 64))
    im = bpy.data.images.new('IL_flag', W, H, alpha=False)
    im.pixels.foreach_set(img.ravel())
    im.pack()
    return im


def flag_patch(name):
    t = T(name)
    tex = t.n('ShaderNodeTexImage')
    tex.image = flag_image()
    tex.interpolation = 'Cubic'
    t.l(t.coords('UV'), tex.inputs['Vector'])
    oc = t.coords('Object')
    fib = t.noise(oc, 900.0, 2.0)
    h = t.math('ADD', weave_height(t, oc, 1500.0), fib.outputs['Fac'])
    col = t.mix(0.12, tex.outputs['Color'], srgb(150, 140, 110))
    t.bsdf(col, 0.85, normal=t.bump(h, 0.25, 0.0005), spec=0.3, sheen=0.3)
    return t.m


def velcro(name, base):
    t = T(name)
    oc = t.coords('Object')
    nz = t.noise(oc, 1500.0, 1.0)
    t.bsdf(base, 0.95, normal=t.bump(nz.outputs['Fac'], 0.4, 0.0004), spec=0.2, sheen=0.5)
    return t.m


def build_all():
    M = {}
    olive = srgb(76, 77, 44)
    M['uniform'] = fabric('uniform', olive, srgb(80, 83, 50), weave=1100, bump=0.2, dust=0.12, low_dust=0.4, sheen=0.25)
    M['uniform_pants'] = fabric('uniform_pants', srgb(80, 78, 47), srgb(88, 85, 54), weave=1100, bump=0.22, dust=0.14, low_dust=0.65, sheen=0.25)
    M['boot_leather'] = plastic('boot_leather', srgb(66, 48, 34), rough=0.62, wear=0.6, wear_col=srgb(120, 96, 72), bump=0.05, scale=300.0)
    M['uniform_dark'] = fabric('uniform_dark', srgb(62, 66, 44), srgb(68, 70, 48), weave=1100, bump=0.2, dust=0.1, low_dust=0.5)
    M['gear'] = fabric('gear', srgb(62, 67, 45), srgb(70, 73, 49), weave=700, bump=0.3, dust=0.07, sheen=0.25, rough=0.8, ao_dark=0.6, wear=0.45)
    M['gear_pad'] = fabric('gear_pad', srgb(60, 64, 43), srgb(68, 70, 47), weave=700, bump=0.3, dust=0.06, sheen=0.25, rough=0.8, ao_dark=0.6, wear=0.4)
    M['webbing'] = webbing('webbing', srgb(56, 60, 40))
    M['sling'] = webbing('sling', srgb(32, 33, 30))
    M['camo'] = fabric('mitznefet', srgb(112, 104, 72), srgb(120, 110, 78), weave=900, bump=0.25, dust=0.15, sheen=0.3,
                       camo=[(0.5, srgb(74, 80, 50), 5.0), (0.55, srgb(92, 72, 48), 6.5), (0.6, srgb(52, 56, 38), 9.0)])
    M['mitz_net'] = mesh_net('mitz_net')
    M['skin'] = skin('skin')
    M['gaiter'] = fabric('gaiter', srgb(88, 90, 64), srgb(96, 96, 70), weave=1500, bump=0.35, dust=0.1, sheen=0.4)
    M['glove'] = fabric('glove', srgb(46, 47, 40), srgb(52, 52, 44), weave=1400, bump=0.2, dust=0.15, rough=0.75, wear=0.5)
    M['glove_pad'] = plastic('glove_pad', srgb(38, 38, 34), rough=0.6, wear=0.3)
    M['boot'] = leather_boot('boot')
    M['sole'] = rubber_sole('sole')
    M['lace'] = webbing('lace', srgb(84, 70, 52))
    M['polymer'] = plastic('polymer', srgb(36, 36, 34), rough=0.55, wear=0.5, wear_col=srgb(95, 92, 86))
    M['polymer_olive'] = plastic('polymer_olive', srgb(70, 72, 52), rough=0.55, wear=0.4, wear_col=srgb(130, 126, 104))
    M['metal'] = plastic('metal', srgb(48, 48, 48), rough=0.4, wear=0.6, metal=0.85, wear_col=srgb(150, 148, 142), bump=0.03)
    M['mag'] = plastic('mag', srgb(28, 28, 27), rough=0.6, wear=0.35, wear_col=srgb(80, 78, 74))
    M['rubber'] = plastic('rubber', srgb(30, 30, 29), rough=0.85, wear=0.1)
    # rifle shells: finer moulded polymer texture and more edge wear; stippled pistol grip
    M['rifle_poly'] = plastic('rifle_poly', srgb(38, 38, 36), rough=0.58, wear=0.6, bump=0.12, scale=420.0, wear_col=srgb(98, 95, 88))
    M['grip_tex'] = plastic('grip_tex', srgb(36, 36, 34), rough=0.75, wear=0.4, bump=0.6, scale=1400.0, wear_col=srgb(90, 88, 82))
    M['lens'] = glass('lens', (0.32, 0.31, 0.27, 1))
    M['lens_smoke'] = glass('lens_smoke', (0.11, 0.11, 0.115, 1))  # ballistic glasses: dark smoke shield
    M['clear_lens'] = glass('clear_lens', (0.9, 0.9, 0.88, 1))
    M['reddot_lens'] = glass('reddot_lens', (0.8, 0.85, 0.95, 1))
    M['flag'] = flag_patch('flag')
    M['velcro'] = velcro('velcro', srgb(70, 74, 50))
    M['headset'] = plastic('headset', srgb(84, 82, 64), rough=0.55, wear=0.4, wear_col=srgb(140, 136, 112))
    M['helmet'] = plastic('helmet', srgb(74, 76, 56), rough=0.7, wear=0.3)
    em = T('reddot_emit')
    e = em.n('ShaderNodeEmission')
    e.inputs['Color'].default_value = (1.0, 0.05, 0.02, 1)
    e.inputs['Strength'].default_value = 40.0
    em.l(e.outputs[0], em.out.inputs['Surface'])
    M['reddot_emit'] = em.m
    return M
