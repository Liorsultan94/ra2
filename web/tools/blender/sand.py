# Blender 5.2.2 (LTS) - the desert's sand ground layers (GD1: Wadi Al-Rimal).
#
#   /opt/blender/blender -b --factory-startup -P web/tools/blender/sand.py -- <out_dir> [size=2048] [keys=dsand,dreg]
#   (or web/tools/blender/bake-sand.sh, which also packs the WebPs into public/tex/terrain and writes
#   src/render/sandset.ts)
#
# Two tileable ground materials for the photo ground's texture arrays (src/render/photoground.ts), in the
# same packing as the photoscans of tools/bake-terrain.mjs:
#   dsand  soft desert sand: grain, a little grit, faint lumps (the wind ripples are procedural in the
#          ground shader, so they keep one wind direction through the anti-tiling's random rotations)
#   dreg   reg / desert pavement: a dense gravel of varnished, granite, quartz and sandstone pebbles
#          half sunk into coarse sand (the ground shader blends it into the sand as gravel patches)
# The relief is real geometry: a periodic height-field mesh (numpy noise) plus a few thousand pebbles
# (displaced, flattened icospheres, linked duplicates, wrapped around the tile edges), rendered top-down
# by an orthographic Cycles camera in five emission passes - pebble mask, pebble colour, height, world
# normal and ambient occlusion - so the maps tile exactly and the pebbles carry true normals and contact
# occlusion. numpy then composites the sand's own colour (grain, mineral specks, mottling) and the fine
# grain relief, and box-downscales to the game sizes:
#   <key>_a_<px>.png  albedo, sRGB, half of the AO folded in
#   <key>_n_<px>.png  R/G normal X/Y (OpenGL, +Y = image up), B height
#   <key>.json        mean albedo (linear), roughness
#   <key>_preview.png a sun-lit preview of the maps (for checking only)
import bpy
import json
import math
import os
import sys
import time

import numpy as np

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = argv[0] if argv else '/tmp/sand'
S = int(argv[1]) if len(argv) > 1 else 2048
KEYS = argv[2].split(',') if len(argv) > 2 else ['dsand', 'dreg']
os.makedirs(OUT, exist_ok=True)
# apron of periodic copies round the unit tile (so the occlusion rays see the neighbours across the wrap)
PAD = 0.05


def s2l(c):
    c = np.asarray(c, dtype=np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def l2s(v):
    v = np.clip(v, 0.0, 1.0)
    return np.where(v <= 0.0031308, v * 12.92, 1.055 * np.power(v, 1 / 2.4) - 0.055)


def field(n, lo, hi, seed, slope=1.0):
    """Periodic band-limited noise on an n x n grid (unit tile): frequencies lo..hi cycles per tile, std 1."""
    rng = np.random.default_rng(seed)
    w = rng.standard_normal((n, n))
    f = np.fft.fftfreq(n) * n
    fx, fy = np.meshgrid(f, f)
    k = np.hypot(fx, fy)
    band = np.exp(-np.square(np.maximum(0, lo - k) / max(1e-6, lo * 0.35))) * np.exp(-np.square(np.maximum(0, k - hi) / max(1e-6, hi * 0.35)))
    band *= np.power(np.maximum(k, 1.0), -slope)
    band[0, 0] = 0
    out = np.real(np.fft.ifft2(np.fft.fft2(w) * band))
    return out / (out.std() + 1e-12)


def down2(a):
    return 0.25 * (a[0::2, 0::2] + a[1::2, 0::2] + a[0::2, 1::2] + a[1::2, 1::2])


# ------------------------------------------------------------------ scene

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.render.threads_mode = 'FIXED'
    sc.render.threads = 4
    sc.cycles.use_denoising = False
    sc.cycles.max_bounces = 0
    sc.cycles.use_adaptive_sampling = False
    sc.cycles.pixel_filter_type = 'BOX'
    sc.cycles.filter_width = 1.0
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    sc.render.resolution_x = S
    sc.render.resolution_y = S
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = 'OPEN_EXR'
    sc.render.image_settings.color_depth = '32'
    w = bpy.data.worlds.new('w')
    w.use_nodes = True
    bg = w.node_tree.nodes.get('Background')
    if bg:
        bg.inputs['Strength'].default_value = 0.0
    sc.world = w
    cam = bpy.data.cameras.new('cam')
    cam.type = 'ORTHO'
    cam.ortho_scale = 1.0
    cam.clip_start = 0.01
    cam.clip_end = 10
    co = bpy.data.objects.new('cam', cam)
    co.location = (0.5, 0.5, 2.0)
    sc.collection.objects.link(co)
    sc.camera = co
    return sc


def grid_mesh(name, H, z0=0.0):
    """Height-field mesh over [-PAD, 1 + PAD]^2 from the periodic height array H (n x n per unit tile)."""
    n = H.shape[0]
    pad = int(math.ceil(PAD * n))
    idx = np.arange(-pad, n + pad + 1)
    G = len(idx)
    xs = idx / n
    X, Y = np.meshgrid(xs, xs)
    Z = H[np.mod(idx, n)][:, np.mod(idx, n)] + z0
    co = np.stack([X.ravel(), Y.ravel(), Z.ravel()], 1).astype(np.float32)
    i = np.arange(G - 1)
    I, J = np.meshgrid(i, i)
    a = (J * G + I).ravel()
    quads = np.stack([a, a + 1, a + G + 1, a + G], 1).astype(np.int32)
    me = bpy.data.meshes.new(name)
    me.vertices.add(G * G)
    me.vertices.foreach_set('co', co.ravel())
    me.loops.add(quads.size)
    me.loops.foreach_set('vertex_index', quads.ravel())
    me.polygons.add(len(quads))
    me.polygons.foreach_set('loop_start', np.arange(0, quads.size, 4, dtype=np.int32))
    me.update(calc_edges=True)
    me.polygons.foreach_set('use_smooth', np.ones(len(quads), dtype=bool))
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


def pebble_meshes(count, rng):
    """Pebble shapes: icospheres with low-order lumps and a little surface roughness (unit radius)."""
    out = []
    for v in range(count):
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=1.0)
        o = bpy.context.active_object
        me = o.data
        co = np.zeros(len(me.vertices) * 3, dtype=np.float32)
        me.vertices.foreach_get('co', co)
        co = co.reshape(-1, 3).astype(np.float64)
        d = np.zeros(len(co))
        for j in range(7):
            k = rng.normal(size=3)
            k *= rng.uniform(1.2, 3.2) / np.linalg.norm(k)
            d += rng.uniform(0.03, 0.09) * np.cos(co @ k + rng.uniform(0, 6.28))
        for j in range(10):
            k = rng.normal(size=3)
            k *= rng.uniform(6, 11) / np.linalg.norm(k)
            d += rng.uniform(0.004, 0.012) * np.cos(co @ k + rng.uniform(0, 6.28))
        co *= (1 + d)[:, None]
        # a facet or two: chipped, broken pebbles (desert gravel is angular as often as rounded)
        if rng.random() < 0.55:
            for j in range(rng.integers(1, 4)):
                nrm = rng.normal(size=3)
                nrm /= np.linalg.norm(nrm)
                cut = rng.uniform(0.55, 0.85)
                dist = co @ nrm
                over = dist > cut
                co[over] -= np.outer(dist[over] - cut, nrm)
        me.vertices.foreach_set('co', co.astype(np.float32).ravel())
        me.polygons.foreach_set('use_smooth', np.ones(len(me.polygons), dtype=bool))
        me.update()
        bpy.data.objects.remove(o)
        out.append(me)
    return out


def emission_material(name, pebble, zlo, zhi):
    """One material, five emission outputs (one per pass); set_pass() links the wanted one."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for nd in list(nt.nodes):
        nt.nodes.remove(nd)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    geo = nt.nodes.new('ShaderNodeNewGeometry')
    em = {}
    for p in ('mask', 'albedo', 'height', 'normal', 'ao'):
        e = nt.nodes.new('ShaderNodeEmission')
        e.inputs['Strength'].default_value = 1.0
        em[p] = e
    em['mask'].inputs['Color'].default_value = (1, 1, 1, 1) if pebble else (0, 0, 0, 1)
    if pebble:
        oi = nt.nodes.new('ShaderNodeObjectInfo')
        nt.links.new(oi.outputs['Color'], em['albedo'].inputs['Color'])
    else:
        em['albedo'].inputs['Color'].default_value = (0, 0, 0, 1)
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(geo.outputs['Position'], sep.inputs[0])
    mr = nt.nodes.new('ShaderNodeMapRange')
    mr.inputs['From Min'].default_value = zlo
    mr.inputs['From Max'].default_value = zhi
    mr.clamp = True
    nt.links.new(sep.outputs['Z'], mr.inputs['Value'])
    nt.links.new(mr.outputs['Result'], em['height'].inputs['Color'])
    vm = nt.nodes.new('ShaderNodeVectorMath')
    vm.operation = 'MULTIPLY_ADD'
    vm.inputs[1].default_value = (0.5, 0.5, 0.5)
    vm.inputs[2].default_value = (0.5, 0.5, 0.5)
    nt.links.new(geo.outputs['Normal'], vm.inputs[0])
    nt.links.new(vm.outputs['Vector'], em['normal'].inputs['Color'])
    ao = nt.nodes.new('ShaderNodeAmbientOcclusion')
    ao.samples = 16
    ao.inputs['Distance'].default_value = 0.012
    nt.links.new(ao.outputs['AO'], em['ao'].inputs['Color'])
    m['em'] = name
    m['out'] = out.name
    EMS[name] = (m, out, em)
    return m


EMS = {}


def set_pass(p):
    for m, out, em in EMS.values():
        m.node_tree.links.new(em[p].outputs['Emission'], out.inputs['Surface'])


def render(p, samples):
    sc = bpy.context.scene
    set_pass(p)
    sc.cycles.samples = samples
    path = os.path.join(OUT, f'_pass_{p}.exr')
    sc.render.filepath = path
    t = time.time()
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    a = np.zeros(S * S * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    os.remove(path)
    print(f'  pass {p}: {time.time() - t:.1f} s')
    return a.reshape(S, S, 4)[:, :, :3].astype(np.float64)


# ------------------------------------------------------------------ materials

# pebble palette (sRGB, weight): desert-varnished dark stone, red and grey granite, white quartz,
# tan sandstone, brown flint, dark basalt
PALETTE = [
    ((62, 46, 36), 0.24),
    ((132, 92, 74), 0.15),
    ((124, 118, 110), 0.11),
    ((206, 196, 180), 0.06),
    ((186, 150, 110), 0.2),
    ((106, 82, 64), 0.16),
    ((78, 76, 70), 0.08),
]


def pick_colour(rng, light=False):
    cols = [c for c, _ in PALETTE]
    w = np.array([wt for _, wt in PALETTE])
    if light:
        # grit in the sand: mostly the sand's own minerals
        w = w * np.array([0.5, 0.8, 1.0, 1.6, 2.2, 1.0, 0.4])
    c = cols[rng.choice(len(cols), p=w / w.sum())]
    return s2l(np.array(c) * rng.uniform(0.86, 1.12))


def place(rng, n, rmin, rmax, power, sand_h, existing=None):
    """Dart throwing on the periodic tile: n pebbles, radius rmin..rmax (power-law, small ones commoner)."""
    peb = existing if existing is not None else []
    cell = 0.02
    nc = int(1 / cell)
    grid = {}
    for k, p in enumerate(peb):
        grid.setdefault((int(p['x'] / cell) % nc, int(p['y'] / cell) % nc), []).append(k)
    hn = sand_h.shape[0]
    tries = 0
    added = 0
    while added < n and tries < n * 40:
        tries += 1
        r = rmin * (rmax / rmin) ** (rng.random() ** power)
        x, y = rng.random(), rng.random()
        ok = True
        cx, cy = int(x / cell), int(y / cell)
        reach = int(math.ceil((r + rmax) / cell))
        for dx in range(-reach, reach + 1):
            for dy in range(-reach, reach + 1):
                for k in grid.get(((cx + dx) % nc, (cy + dy) % nc), ()):
                    q = peb[k]
                    ddx = (x - q['x'] + 0.5) % 1 - 0.5
                    ddy = (y - q['y'] + 0.5) % 1 - 0.5
                    if ddx * ddx + ddy * ddy < ((r + q['r']) * 0.82) ** 2:
                        ok = False
                        break
                if not ok:
                    break
            if not ok:
                break
        if not ok:
            continue
        sy = rng.uniform(0.6, 1.0)
        sz = rng.uniform(0.38, 0.68)
        h = sand_h[int(y * hn) % hn, int(x * hn) % hn]
        peb.append({'x': x, 'y': y, 'r': r, 'sy': sy, 'sz': sz, 'rot': rng.uniform(0, math.tau), 'tilt': (rng.normal() * 0.18, rng.normal() * 0.18), 'z': h + r * sz * rng.uniform(-0.15, 0.35), 'v': int(rng.integers(0, 1 << 30))})
        grid.setdefault((cx % nc, cy % nc), []).append(len(peb) - 1)
        added += 1
    return peb


def build(key):
    rng = np.random.default_rng({'dsand': 11, 'dreg': 23}[key])
    sc = reset()
    n = S // 2
    reg = key == 'dreg'
    # the sand surface (tile units): broad lumps, smaller clumps, a fine grain on top (geometry)
    H = 0.0026 * field(n, 2, 7, 1 + reg) + 0.0011 * field(n, 9, 26, 2 + reg) + 0.0003 * field(n, 30, 110, 3 + reg)
    if reg:
        # deflated reg: flatter, the fines blown out between the stones
        H *= 0.6
    zlo, zhi = -0.03, 0.03
    ground = grid_mesh('sand', H)
    ground.data.materials.append(emission_material('m_sand', False, zlo, zhi))
    peb_mat = emission_material('m_peb', True, zlo, zhi)
    # pebbles
    if reg:
        peb = place(rng, 140, 0.011, 0.024, 1.6, H)
        peb = place(rng, 1300, 0.0055, 0.011, 1.4, H, peb)
        peb = place(rng, 5200, 0.002, 0.0055, 1.2, H, peb)
    else:
        peb = place(rng, 14, 0.004, 0.0075, 1.5, H)
        peb = place(rng, 260, 0.0014, 0.004, 1.6, H, peb)
    shapes = pebble_meshes(18, rng)
    for me in shapes:
        me.materials.append(peb_mat)
    col = sc.collection
    count = 0
    for k, p in enumerate(peb):
        prng = np.random.default_rng(p['v'])
        colr = pick_colour(prng, light=not reg)
        me = shapes[p['v'] % len(shapes)]
        for ox in (-1, 0, 1):
            for oy in (-1, 0, 1):
                x = p['x'] + ox
                y = p['y'] + oy
                if x < -PAD - p['r'] or x > 1 + PAD + p['r'] or y < -PAD - p['r'] or y > 1 + PAD + p['r']:
                    continue
                o = bpy.data.objects.new(f'p{k}_{ox}{oy}', me)
                o.location = (x, y, p['z'])
                o.rotation_euler = (p['tilt'][0], p['tilt'][1], p['rot'])
                o.scale = (p['r'], p['r'] * p['sy'], p['r'] * p['sz'])
                o.color = (float(colr[0]), float(colr[1]), float(colr[2]), 1.0)
                col.objects.link(o)
                count += 1
    print(f'{key}: {len(peb)} pebbles, {count} objects')
    mask = render('mask', 8)[:, :, 0]
    palb = render('albedo', 8)
    hgt = render('height', 8)[:, :, 0]
    nor = render('normal', 8) * 2 - 1
    ao = render('ao', 8)[:, :, 0]
    # flat ground must read (0, 0, 1): the passes are linear
    print('  check normal at the flattest pixel:', nor.reshape(-1, 3)[np.argmax(nor[:, :, 2])], 'mask mean', mask.mean())

    # ---- composite (numpy; rows bottom-up as Blender stores them, which saving keeps)
    m = np.clip(mask, 0, 1)
    grain = field(S, 260, 900, 41 + reg, 0.0)
    fine = field(S, 90, 260, 42 + reg, 0.5)
    mott = field(S, 3, 10, 43 + reg)
    mott2 = field(S, 14, 50, 44 + reg)
    hueN = field(S, 2, 6, 45 + reg)
    specks = field(S, 500, 1000, 46 + reg, 0.0)
    base = s2l(np.array([198, 160, 110]) if reg else np.array([214, 177, 124]))
    lum = 1 + 0.045 * mott + 0.03 * mott2 + (0.075 if reg else 0.06) * grain + 0.03 * fine
    sand = base[None, None, :] * lum[:, :, None]
    sand[:, :, 0] *= 1 + 0.025 * hueN
    sand[:, :, 2] *= 1 - 0.04 * hueN
    # mineral specks: dark magnetite / hornblende, bright quartz
    dark = np.clip((specks - 2.5) * 2, 0, 1)
    light = np.clip((-specks - 2.7) * 2, 0, 1)
    sand *= (1 - 0.5 * dark)[:, :, None]
    sand *= (1 + 0.18 * light)[:, :, None]
    peb_alb = palb * (1 + 0.1 * grain + 0.06 * fine)[:, :, None]
    alb = sand * (1 - m)[:, :, None] + peb_alb * m[:, :, None]
    alb *= (0.5 + 0.5 * np.clip(ao, 0, 1))[:, :, None]
    # fine grain relief (sand only): height and a normal bump from it
    z = zlo + hgt * (zhi - zlo)
    gz = (0.00003 * grain + 0.00008 * fine) * (1 - m)
    zt = z + gz
    px = 1.0 / S
    gx = (np.roll(gz, -1, 1) - np.roll(gz, 1, 1)) / (2 * px)
    gy = (np.roll(gz, -1, 0) - np.roll(gz, 1, 0)) / (2 * px)
    nn = nor + np.stack([-gx, -gy, np.zeros_like(gx)], 2)
    nn /= np.linalg.norm(nn, axis=2, keepdims=True)
    # height: the sand surface's 1..99% range to 0.25..0.6, the stones above it up to 1
    sz = zt[m < 0.5] if (m < 0.5).any() else zt.ravel()
    s1, s99 = np.percentile(sz, 1), np.percentile(sz, 99)
    hb = 0.25 + (zt - s1) / max(1e-9, s99 - s1) * 0.35
    top = np.percentile(zt, 99.8)
    hb = np.where(zt > s99, 0.6 + (zt - s99) / max(1e-9, top - s99) * 0.4, hb)
    hb = np.clip(hb, 0, 1)
    meanc = alb.reshape(-1, 3).mean(0)
    print(f'  mean albedo (linear) {meanc.round(4).tolist()}  pebble cover {m.mean():.2f}')

    def save(name, rgb):
        h, w = rgb.shape[:2]
        img = bpy.data.images.new(name, w, h, alpha=False, float_buffer=False)
        img.colorspace_settings.name = 'Non-Color'
        px4 = np.concatenate([np.clip(rgb, 0, 1), np.ones((h, w, 1))], 2).astype(np.float32)
        img.pixels.foreach_set(px4.ravel())
        img.filepath_raw = os.path.join(OUT, name + '.png')
        img.file_format = 'PNG'
        img.save()
        bpy.data.images.remove(img)

    a, nm, hh = alb, nn, hb
    for size in (2048, 1024, 512):
        while a.shape[0] > size:
            a, nm, hh = down2(a), down2(nm), down2(hh)
        if a.shape[0] != size:
            continue
        nrm = nm / np.linalg.norm(nm, axis=2, keepdims=True)
        save(f'{key}_a_{size}', l2s(a))
        save(f'{key}_n_{size}', np.stack([nrm[:, :, 0] * 0.5 + 0.5, nrm[:, :, 1] * 0.5 + 0.5, hh], 2))
    # sun-lit preview (sun from the upper left, 40 degrees up)
    L = np.array([-0.55, 0.45, 0.7])
    L /= np.linalg.norm(L)
    sh = np.clip((nn @ L), 0, 1) * 0.85 + 0.25
    prev = l2s(alb * sh[:, :, None] * 1.1)
    save(f'{key}_preview', prev[: S // 2, : S // 2])
    with open(os.path.join(OUT, key + '.json'), 'w') as f:
        json.dump({'key': key, 'mean': [round(float(v), 4) for v in meanc], 'rough': 0.93 if not reg else 0.86, 'cover': round(float(m.mean()), 3), 'pebbles': len(peb)}, f)


for key in KEYS:
    t0 = time.time()
    build(key)
    print(f'{key} done in {time.time() - t0:.0f} s')
print('OK_DONE')
