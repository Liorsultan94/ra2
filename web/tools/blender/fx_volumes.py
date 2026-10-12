"""
Iron Front - volumetric explosion / smoke / fire / dust flipbook source renders.
Authored for Blender 5.2.2 LTS (headless, Cycles CPU, Mantaflow).

  nice -n 10 /opt/blender/blender -b --factory-startup -P web/tools/blender/fx_volumes.py -- <effect[,effect]|all> \
      --out <dir> [--res 128] [--samples N] [--simres N] [--only 0,8,16]

Gas effects are real Mantaflow simulations (fire + smoke: fuel burning into heat and soot,
buoyancy, vorticity, a lumpy source whose normals tear the blast into separate billows) at a modest
base resolution plus Mantaflow's wavelet-noise up-res (x2) for the fine rolling detail, rendered in
Cycles with multiple scattering and self-shadowing. Sparks are stretched emissive streaks on
deterministic ballistic arcs; the debris burst adds tumbling dirt clods (solid) to a dust sim.
(A purely procedural "noise-displaced puff" variant was also tried: ~10x slower to render on this
CPU because every overlapping puff evaluates 4D noise per ray step, and softer-looking.)

Each output frame is ONE render carrying, through Cycles light groups:
  L0..L5  the gas lit by a sun from +X (right), +Z (top), -X (left), -Z (bottom),
          -Y (the camera side) and +Y (behind)        -> "6-way lightmaps"
  E       the fire's own emission (self-occluded by the smoke in front, plus its glow on the smoke)
  alpha   film transparency (coverage)
written as one multilayer EXR per frame: <out>/<effect>/f###.exr; fx_pack.py builds the atlases.
At runtime (src/render/fx/flipbook.ts) the six lightmaps are re-weighted per pixel by the game's
sun, sky and fire-light directions (noon, dusk, night, storm), and the emission channel drives the
fire glow and the bloom.

Looping effects (flame, smokeloop) render N + K frames of a steady-state sim; fx_pack.py cross-fades
the last K into the first K, giving a seamless N-frame loop. Everything is deterministic (fixed sim settings,
fixed seeds, fixed Cycles seed).
"""
import bpy
import math
import os
import random
import shutil
import sys
import time
from mathutils import Quaternion, Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
if not argv:
    raise SystemExit('usage: ... -- <effect|all> --out DIR')


def arg(name, default):
    if name in argv:
        return type(default)(argv[argv.index(name) + 1])
    return default


OUT = os.path.abspath(arg('--out', '/tmp/fxrender'))
RES = arg('--res', 128)
SAMPLES = arg('--samples', 0)  # 0: per effect (cfg 'samples', default 32; the light is denoised in fx_pack)
ONLY = arg('--only', '')
SIMRES = arg('--simres', 0)
NFRAMES = 36  # frames per effect in the atlas (6 x 6)
LOOP_K = 12  # loops render N + K frames; fx_pack cross-fades the K extra ones over the first K

# ------------------------------------------------------------------------------------------------
# Effects. Units: Blender units, z up; the square orthographic frame is W wide.
# ground=True: the domain floor is the ground, 10% above the frame bottom (flipbook.ts pins that
# line to the spawn point). frames=(first sim frame, step): which sim frames become the atlas frames.
# ------------------------------------------------------------------------------------------------
GAS = dict(simres=56, upres=2, noise=1.0, dens=9.0, emis=6.0, albedo=0.82, aniso=0.25, vort=0.3, beta=1.0,
           alpha=0.0, burn=0.75, flame_smoke=1.0, flame_vort=0.6, ignition=1.25, max_temp=1.75,
           time_scale=1.0, flame_pow=1.8, fade=0.08, seed=1)


def G(**kw):
    d = dict(GAS)
    d.update(kw)
    return d


EFFECTS = {
    # a: the big impact fireball (aircraft / missile / bomb): white-orange core -> dark rolling smoke
    'fireball': G(W=3.2, ground=True, frames=(2, 2), samples=64,
                  emit=dict(shape='sphere', r=0.42, at=(0, 0, 0.34), until=5, type='BOTH', fuel=3.0, temp=3.0,
                            dens=1.0, vel=3.5, surf=0.6, lumpy=0.6),
                  vort=0.3, beta=0.6, burn=0.3, flame_smoke=1.2, flame_vort=0.8, flame_pow=2.0),
    # mid-air variant (aircraft kills, flak, air bursts)
    'airburst': G(W=3.2, ground=False, frames=(2, 2),
                  emit=dict(shape='sphere', r=0.4, at=(0, 0, -0.25), until=4, type='BOTH', fuel=2.8, temp=3.0,
                            dens=1.0, vel=3.6, surf=0.6, lumpy=0.6),
                  vort=0.35, beta=0.6, burn=0.5, flame_smoke=1.2, flame_vort=0.8, flame_pow=2.0),
    # b: medium vehicle / shell explosion: a fast, punchy burst
    'burst': G(W=2.4, ground=True, simres=48, frames=(1, 1), time_scale=1.6, samples=64,
               emit=dict(shape='sphere', r=0.28, at=(0, 0, 0.22), until=3, type='BOTH', fuel=2.2, temp=3.0,
                         dens=0.9, vel=3.0, surf=0.5, lumpy=0.7),
               vort=0.35, burn=0.9, flame_smoke=1.0, flame_pow=2.0),
    # thermobaric / fuel-air: a wide, long-burning, sooty fireball
    'fuel': G(W=3.6, ground=True, frames=(2, 2), dens=10.0, samples=64,
              emit=dict(shape='sphere', r=0.55, at=(0, 0, 0.3), until=7, type='BOTH', fuel=3.5, temp=2.8,
                        dens=1.3, vel=2.4, surf=0.7, lumpy=0.6),
              vort=0.3, burn=0.35, flame_smoke=2.0, flame_vort=1.0, flame_pow=2.0),
    # b: ground-hit dirt plume (smoke only, heavy: falls back)
    'dust': G(W=2.6, ground=True, simres=48, frames=(1, 2), dens=12.0, albedo=0.75, emis=0.0,
              emit=dict(shape='cone', r=0.2, at=(0, 0, 0.12), until=3, type='SMOKE', dens=1.6, temp=0.0,
                        coord=(0, 0, 5.0), surf=0.4, lumpy=0.0),
              vort=0.3, beta=0.0, alpha=0.6),
    # lingering, rolling smoke billow (left behind by a fireball)
    'smoke': G(W=3.0, ground=False, simres=48, frames=(4, 3), dens=8.0, emis=0.0,
               emit=dict(shape='sphere', r=0.45, at=(0, 0, -0.75), until=6, type='SMOKE', dens=1.0, temp=1.0,
                         vel=0.8, surf=0.6, lumpy=0.5),
               vort=0.3, beta=0.6, alpha=0.0),
    # d: looping fire (+ its smoke) for burning buildings / wrecks
    'flame': G(W=1.8, ground=True, simres=48, frames=(40, 1), loop=True, dens=7.0, emis=7.0,
               emit=dict(shape='disc', r=0.3, at=(0, 0, 0.05), until=10 ** 6, type='BOTH', fuel=1.2, temp=2.0,
                         dens=0.5, vel=0.4, surf=0.3, noise=True),
               vort=0.3, burn=0.9, flame_smoke=0.6, flame_vort=0.9, beta=1.6),
    # d: looping dark smoke column with a glowing base, for burning buildings / wrecks
    'smokeloop': G(W=2.4, ground=True, simres=48, frames=(50, 1), loop=True, dens=6.0, emis=5.0,
                   emit=dict(shape='disc', r=0.28, at=(0, 0, 0.05), until=10 ** 6, type='BOTH', fuel=0.5, temp=1.6,
                             dens=1.2, vel=0.5, surf=0.3, noise=True),
                   vort=0.25, burn=0.9, flame_smoke=2.0, flame_vort=0.6, beta=1.4),
    # c: building collapse: a wide, low rolling wall of dust
    'collapse': G(W=4.0, ground=True, simres=56, frames=(1, 3), dens=8.0, albedo=0.85, emis=0.0,
                  emit=dict(shape='box', size=(1.3, 1.3, 1.1), at=(0, 0, 0.55), until=8, type='SMOKE', dens=1.2,
                            temp=0.0, coord=(0, 0, -2.5), surf=0.4),
                  vort=0.35, beta=0.15, alpha=0.25),
    # e: small impact puff (bullets, small shells, debris landing)
    'puff': G(W=1.4, ground=True, simres=40, frames=(1, 1), dens=10.0, albedo=0.85, emis=0.0,
              emit=dict(shape='sphere', r=0.11, at=(0, 0, 0.08), until=2, type='SMOKE', dens=1.4, temp=0.3,
                        vel=1.8, surf=0.3, lumpy=0.6),
              vort=0.3, beta=0.2, alpha=0.1),
    # hot sparks / fragments: stretched emissive streaks on ballistic arcs (no gas)
    'sparks': dict(W=3.0, ground=False, kind='sparks', dur=1.0, n=46, speed=(2.5, 6.5), drag=0.9, grav=5.0,
                   size=(0.012, 0.02), stretch=0.05, at=(0, 0, -0.3)),
    # b: dirt / debris burst for ground hits: tumbling clods over a low dust burst
    'debris': G(W=2.6, ground=True, simres=48, frames=(1, 1), dens=11.0, albedo=0.78, emis=0.0,
                emit=dict(shape='sphere', r=0.12, at=(0, 0, 0.06), until=2, type='SMOKE', dens=1.4, temp=0.2,
                          vel=2.2, surf=0.3, lumpy=0.7),
                vort=0.3, beta=0.1, alpha=0.3,
                clods=dict(n=16, cone=0.75, speed=(2.6, 5.0), grav=8.0, size=(0.03, 0.055))),
}

ORDER = ['fireball', 'burst', 'fuel', 'dust', 'smoke', 'flame', 'sparks', 'airburst', 'collapse',
         'smokeloop', 'puff', 'debris']


def log(*a):
    print('[fx]', *a, flush=True)


def U(rnd, lohi):
    return rnd.uniform(lohi[0], lohi[1])


# ------------------------------------------------------------------------------------------------
# scene
# ------------------------------------------------------------------------------------------------

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return bpy.context.scene


def setup_render(sc, cfg):
    sc.render.engine = 'CYCLES'
    cy = sc.cycles
    cy.device = 'CPU'
    cy.samples = SAMPLES or cfg.get('samples', 32)
    cy.use_adaptive_sampling = False
    cy.use_denoising = False
    cy.max_bounces = 6
    cy.volume_bounces = 3
    cy.diffuse_bounces = 2
    cy.glossy_bounces = 0
    cy.transmission_bounces = 0
    cy.transparent_max_bounces = 8
    cy.volume_step_rate = 1.0
    cy.volume_max_steps = 512
    cy.volume_biased = True  # ray-marched volumes: far less noise per sample than null scattering
    cy.seed = 7
    cy.sample_clamp_indirect = 8.0
    sc.render.threads_mode = 'FIXED'
    sc.render.threads = 3
    sc.render.film_transparent = True
    sc.render.resolution_x = RES
    sc.render.resolution_y = RES
    sc.render.resolution_percentage = 100
    sc.render.use_compositing = False
    sc.render.fps = 24
    sc.view_settings.view_transform = 'Standard'
    im = sc.render.image_settings
    im.media_type = 'MULTI_LAYER_IMAGE'
    im.file_format = 'OPEN_EXR_MULTILAYER'
    im.color_depth = '16'
    im.exr_codec = 'ZIP'
    w = bpy.data.worlds.new('W')
    sc.world = w
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.0
    vl = sc.view_layers[0]
    for g in ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'E']:
        vl.lightgroups.add(name=g)


# light travel directions as Euler rotations of a sun (which shines along its local -Z):
# L0 from +X, L1 from top, L2 from -X, L3 from bottom, L4 from the camera (-Y), L5 from behind (+Y)
SUNS = [(0, math.pi / 2, 0), (0, 0, 0), (0, -math.pi / 2, 0), (math.pi, 0, 0), (math.pi / 2, 0, 0), (-math.pi / 2, 0, 0)]


def setup_lights_camera(sc, cfg):
    for i, rot in enumerate(SUNS):
        ld = bpy.data.lights.new(f'sun{i}', 'SUN')
        ld.energy = 1.0
        ld.angle = math.radians(4)
        o = bpy.data.objects.new(f'sun{i}', ld)
        o.rotation_euler = rot
        o.lightgroup = f'L{i}'
        sc.collection.objects.link(o)
    W = cfg['W']
    cd = bpy.data.cameras.new('cam')
    cd.type = 'ORTHO'
    cd.ortho_scale = W
    cd.clip_start = 0.1
    cd.clip_end = 100
    cam = bpy.data.objects.new('cam', cd)
    cam.location = (0, -20, 0.4 * W if cfg['ground'] else 0.0)
    cam.rotation_euler = (math.pi / 2, 0, 0)
    sc.collection.objects.link(cam)
    sc.camera = cam


def math_node(nt, op, a=None, b=None, va=0.0, vb=0.0, clamp=False):
    n = nt.nodes.new('ShaderNodeMath')
    n.operation = op
    n.use_clamp = clamp
    n.inputs[0].default_value = va
    n.inputs[1].default_value = vb
    if a is not None:
        nt.links.new(a, n.inputs[0])
    if b is not None:
        nt.links.new(b, n.inputs[1])
    return n


def gas_material(cfg):
    """Principled volume on the Mantaflow grids; densities fade out softly at the open domain sides."""
    mat = bpy.data.materials.new('gas')
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    pv = nt.nodes.new('ShaderNodeVolumePrincipled')
    a = cfg['albedo']
    pv.inputs['Color'].default_value = (a, a, a, 1)
    pv.inputs['Density Attribute'].default_value = ''
    pv.inputs['Temperature Attribute'].default_value = ''
    pv.inputs['Anisotropy'].default_value = cfg['aniso']
    pv.inputs['Absorption Color'].default_value = (0, 0, 0, 1)
    pv.inputs['Emission Color'].default_value = (1, 1, 1, 1)
    pv.inputs['Blackbody Intensity'].default_value = 0.0
    nt.links.new(pv.outputs[0], out.inputs['Volume'])
    dens = nt.nodes.new('ShaderNodeAttribute')
    dens.attribute_name = 'density'
    flame = nt.nodes.new('ShaderNodeAttribute')
    flame.attribute_name = 'flame'
    # soft fade towards the open domain walls (generated coords are 0..1 over the domain box)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(tc.outputs['Generated'], sep.inputs[0])
    f = cfg['fade']
    sides = [('X', True), ('X', False), ('Y', True), ('Y', False), ('Z', False)]
    if not cfg['ground']:
        sides.append(('Z', True))  # the floor of a ground effect is the ground: no fade there
    edges = []
    for comp, lo in sides:
        s = sep.outputs[comp]
        if lo:
            e = math_node(nt, 'DIVIDE', s, None, vb=f)
        else:
            inv = math_node(nt, 'SUBTRACT', None, s, va=1.0)
            e = math_node(nt, 'DIVIDE', inv.outputs[0], None, vb=f)
        edges.append(e.outputs[0])
    m = edges[0]
    for e in edges[1:]:
        m = math_node(nt, 'MINIMUM', m, e).outputs[0]
    fade = math_node(nt, 'MINIMUM', m, None, vb=1.0, clamp=True)
    fade2 = math_node(nt, 'MULTIPLY', fade.outputs[0], fade.outputs[0])
    d = math_node(nt, 'MULTIPLY', dens.outputs['Fac'], fade2.outputs[0])
    d2 = math_node(nt, 'MULTIPLY', d.outputs[0], None, vb=cfg['dens'])
    nt.links.new(d2.outputs[0], pv.inputs['Density'])
    if cfg['emis'] > 0:
        fl = math_node(nt, 'MULTIPLY', flame.outputs['Fac'], fade2.outputs[0])
        flc = math_node(nt, 'MAXIMUM', fl.outputs[0], None, vb=0.0)
        fp = math_node(nt, 'POWER', flc.outputs[0], None, vb=cfg['flame_pow'])
        fe = math_node(nt, 'MULTIPLY', fp.outputs[0], None, vb=cfg['emis'])
        nt.links.new(fe.outputs[0], pv.inputs['Emission Strength'])
    return mat


def add_emitter(cfg):
    e = cfg['emit']
    shape, at, r = e['shape'], e['at'], e.get('r', 0.2)
    if shape == 'sphere':
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=4, radius=r, location=at)
    elif shape == 'cone':
        bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=r, radius2=r * 0.4, depth=r * 1.2, location=at)
    elif shape == 'disc':
        bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=r, depth=0.08, location=at)
    elif shape == 'box':
        bpy.ops.mesh.primitive_cube_add(size=1, location=at)
        bpy.context.object.scale = e['size']
        bpy.ops.object.transform_apply(scale=True)
    o = bpy.context.object
    o.name = 'emitter'
    o.hide_render = True
    if e.get('lumpy'):
        # a lumpy source: its normals (the initial push) scatter, so the blast tears into separate
        # billows instead of an even dome (several overlapping flow objects made Mantaflow unstable)
        tex = bpy.data.textures.new('lumps', 'CLOUDS')
        tex.noise_scale = r * 0.7
        tex.noise_depth = 1
        dm = o.modifiers.new('lumps', 'DISPLACE')
        dm.texture = tex
        dm.strength = r * e['lumpy']
        dm.mid_level = 0.5
        dm.texture_coords = 'LOCAL'
    md = o.modifiers.new('flow', 'FLUID')
    md.fluid_type = 'FLOW'
    fs = md.flow_settings
    fs.flow_type = e['type']
    fs.flow_behavior = 'INFLOW'
    fs.flow_source = 'MESH'
    fs.surface_distance = e.get('surf', 0.5)
    fs.volume_density = 1.0
    fs.density = e.get('dens', 1.0)
    fs.temperature = e.get('temp', 1.0)
    if e['type'] != 'SMOKE':
        fs.fuel_amount = e.get('fuel', 1.0)
    fs.smoke_color = (1, 1, 1)
    fs.subframes = 2
    if e.get('vel') or e.get('coord'):
        fs.use_initial_velocity = True
        fs.velocity_normal = e.get('vel', 0.0)
        fs.velocity_random = 0.0  # per-cell random push only makes hairy streaks at this resolution
        fs.velocity_factor = 1.0
        fs.velocity_coord = e.get('coord', (0, 0, 0))
    if e.get('noise'):
        # flickering, breaking-up source for the looping fires: a scrolling cloud texture modulates the inflow
        tex = bpy.data.textures.new('flowNoise', 'CLOUDS')
        tex.noise_scale = 0.35
        tex.noise_depth = 2
        fs.use_texture = True
        fs.noise_texture = tex
        fs.texture_map_type = 'AUTO'
        fs.texture_size = 1.0
        fs.texture_offset = 0.0
        fs.keyframe_insert('texture_offset', frame=1)
        fs.texture_offset = 40.0
        fs.keyframe_insert('texture_offset', frame=401)
        for fc in iter_fcurves(o.animation_data):
            for k in fc.keyframe_points:
                k.interpolation = 'LINEAR'
    if e['until'] < 10 ** 5:
        fs.use_inflow = True
        fs.keyframe_insert('use_inflow', frame=1)
        fs.keyframe_insert('use_inflow', frame=e['until'])
        fs.use_inflow = False
        fs.keyframe_insert('use_inflow', frame=e['until'] + 1)
    return o


def iter_fcurves(ad):
    if not ad or not ad.action:
        return []
    act = ad.action
    try:
        return list(act.fcurves)
    except AttributeError:
        out = []  # Blender 5.x layered actions
        for layer in act.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    out.extend(bag.fcurves)
        return out


def frame_list(cfg):
    f0, step = cfg['frames']
    count = NFRAMES + (LOOP_K if cfg.get('loop') else 0)
    fl = [f0 + i * step for i in range(count)]
    if ONLY:
        return [(i, fl[i]) for i in (int(x) for x in ONLY.split(',')) if i < len(fl)]
    return list(enumerate(fl))


def add_domain(cfg, cache, last_frame):
    W = cfg['W']
    zmin, zmax = (0.0, 0.9 * W) if cfg['ground'] else (-0.5 * W, 0.5 * W)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, (zmin + zmax) / 2))
    o = bpy.context.object
    o.name = 'domain'
    o.scale = (W, W, zmax - zmin)
    bpy.ops.object.transform_apply(scale=True)
    md = o.modifiers.new('fluid', 'FLUID')
    md.fluid_type = 'DOMAIN'
    ds = md.domain_settings
    ds.domain_type = 'GAS'
    ds.resolution_max = SIMRES or cfg['simres']
    ds.use_adaptive_timesteps = True
    ds.cfl_condition = 4.0
    ds.timesteps_max = 6
    ds.timesteps_min = 1
    ds.time_scale = cfg['time_scale']
    ds.vorticity = cfg['vort']
    ds.alpha = cfg['alpha']
    ds.beta = cfg['beta']
    ds.burning_rate = cfg['burn']
    ds.flame_smoke = cfg['flame_smoke']
    ds.flame_vorticity = cfg['flame_vort']
    ds.flame_ignition = cfg['ignition']
    ds.flame_max_temp = cfg['max_temp']
    ds.flame_smoke_color = (0.5, 0.5, 0.5)
    ds.use_collision_border_bottom = cfg['ground']
    for side in ('top', 'front', 'back', 'left', 'right'):
        setattr(ds, f'use_collision_border_{side}', False)
    # wavelet-noise up-res: the base sim gives the motion, the noise the fine rolling detail
    ds.use_noise = cfg['upres'] > 1
    if ds.use_noise:
        ds.noise_scale = cfg['upres']
        ds.noise_strength = cfg['noise']
        ds.noise_pos_scale = 2.0
        ds.noise_time_anim = 0.1
    ds.cache_type = 'ALL'
    ds.cache_data_format = 'OPENVDB'
    ds.cache_directory = cache
    ds.cache_frame_start = 1
    ds.cache_frame_end = last_frame + 1
    o.data.materials.append(gas_material(cfg))
    o.lightgroup = 'E'
    return o


# ------------------------------------------------------------------------------------------------
# sparks and clods (deterministic ballistic arcs, cheap surface objects)
# ------------------------------------------------------------------------------------------------

def spark_material():
    mat = bpy.data.materials.new('spark')
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Strength'].default_value = 40.0
    tr = nt.nodes.new('ShaderNodeBsdfTransparent')
    mix = nt.nodes.new('ShaderNodeMixShader')
    mix.inputs['Fac'].default_value = 0.3  # mostly transparent: sparks are light, not matter
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs['Surface'])
    return mat


def clod_material():
    mat = bpy.data.materials.new('clod')
    mat.use_nodes = True
    bs = mat.node_tree.nodes.get('Principled BSDF')
    bs.inputs['Base Color'].default_value = (0.32, 0.3, 0.28, 1)
    bs.inputs['Roughness'].default_value = 0.95
    return mat


def ballistic(v0, t, grav, drag, p0):
    """Position / velocity with linear drag and gravity (closed form)."""
    if drag > 1e-6:
        e = math.exp(-drag * t)
        vt = Vector((0, 0, -grav / drag))
        p = p0 + (v0 - vt) * ((1 - e) / drag) + vt * t
        v = (v0 - vt) * e + vt
    else:
        p = p0 + v0 * t + Vector((0, 0, -0.5 * grav * t * t))
        v = v0 + Vector((0, 0, -grav * t))
    return p, v


def render_sparks(sc, cfg, outdir):
    rnd = random.Random(31337)
    mat = spark_material()
    bpy.ops.mesh.primitive_uv_sphere_add(segments=8, ring_count=6, radius=1.0)
    proto = bpy.context.object
    mesh = proto.data
    mesh.materials.append(mat)
    bpy.data.objects.remove(proto, do_unlink=True)
    sparks = []
    for i in range(cfg['n']):
        o = bpy.data.objects.new(f'spark{i}', mesh)
        o.rotation_mode = 'QUATERNION'
        o.lightgroup = 'E'
        sc.collection.objects.link(o)
        a = rnd.uniform(0, 2 * math.pi)
        el = math.asin(rnd.uniform(-0.45, 1.0))
        v0 = Vector((math.cos(a) * math.cos(el), math.sin(a) * math.cos(el), math.sin(el))) * U(rnd, cfg['speed'])
        sparks.append(dict(o=o, v0=v0, size=U(rnd, cfg['size']), life=rnd.uniform(0.45, 1.0)))
    frames = range(NFRAMES) if not ONLY else [int(x) for x in ONLY.split(',')]
    for fi in frames:
        t = (fi + 0.5) / NFRAMES * cfg['dur']
        for s in sparks:
            o = s['o']
            k = t / s['life']
            if k >= 1:
                o.hide_render = True
                continue
            o.hide_render = False
            p, v = ballistic(s['v0'], t, cfg['grav'], cfg['drag'], Vector(cfg['at']))
            o.location = p
            o.rotation_quaternion = v.to_track_quat('Z', 'Y')
            sz = s['size'] * (1 - 0.6 * k)
            o.scale = (sz, sz, sz + cfg['stretch'] * v.length)  # streak length ~ motion over the exposure
        sc.render.filepath = os.path.join(outdir, f'f{fi:03d}.exr')
        bpy.ops.render.render(write_still=True)


def make_clods(sc, cfg):
    c = cfg['clods']
    rnd = random.Random(4242)
    mat = clod_material()
    out = []
    for i in range(c['n']):
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=1.0)
        o = bpy.context.object
        o.name = f'clod{i}'
        for v in o.data.vertices:
            v.co *= rnd.uniform(0.65, 1.25)
        o.data.materials.append(mat)
        o.rotation_mode = 'QUATERNION'
        a = rnd.uniform(0, 2 * math.pi)
        el = math.pi / 2 - rnd.uniform(0.1, c['cone'])
        v0 = Vector((math.cos(a) * math.cos(el), math.sin(a) * math.cos(el), math.sin(el))) * U(rnd, c['speed'])
        sz = U(rnd, c['size'])
        out.append(dict(o=o, v0=v0, scale=Vector((rnd.uniform(0.7, 1.3), rnd.uniform(0.7, 1.3), rnd.uniform(0.6, 1.0))) * sz,
                        axis=Vector((rnd.gauss(0, 1), rnd.gauss(0, 1), rnd.gauss(0, 1))).normalized(),
                        spin=rnd.uniform(6, 14)))
    return out


def place_clods(clods, cfg, t):
    g = cfg['clods']['grav']
    for c in clods:
        v0 = c['v0']
        tl = (v0.z + math.sqrt(v0.z * v0.z + 2 * g * 0.01)) / g  # lands (z = 0.02) after tl seconds
        tt = min(t, tl)
        c['o'].location = Vector((v0.x * tt, v0.y * tt, 0.03 + v0.z * tt - 0.5 * g * tt * tt))
        c['o'].scale = c['scale']
        c['o'].rotation_quaternion = Quaternion(c['axis'], c['spin'] * tt)


# ------------------------------------------------------------------------------------------------

def render_effect(name):
    cfg = EFFECTS[name]
    sc = reset_scene()
    setup_render(sc, cfg)
    setup_lights_camera(sc, cfg)
    outdir = os.path.join(OUT, name)
    os.makedirs(outdir, exist_ok=True)
    for f in os.listdir(outdir):
        if f.endswith('.exr'):
            os.remove(os.path.join(outdir, f))
    t0 = time.time()
    if cfg.get('kind') == 'sparks':
        render_sparks(sc, cfg, outdir)
        log(f'{name}: rendered in {time.time() - t0:.1f}s')
        return
    cache = os.path.join(OUT, '_cache', name)
    shutil.rmtree(cache, ignore_errors=True)  # stale frames of an older bake would be read back
    os.makedirs(cache, exist_ok=True)
    frames = frame_list(cfg)
    last = max(f for _, f in frames)
    sc.frame_start = 1
    sc.frame_end = last + 1
    add_emitter(cfg)
    dom = add_domain(cfg, cache, last)
    clods = make_clods(sc, cfg) if cfg.get('clods') else []
    with bpy.context.temp_override(scene=sc, active_object=dom, object=dom, selected_objects=[dom]):
        bpy.ops.fluid.bake_all()
    log(f'{name}: sim {SIMRES or cfg["simres"]}x{cfg["upres"]} baked in {time.time() - t0:.1f}s')
    t0 = time.time()
    for i, f in frames:
        sc.frame_set(f)
        if clods:
            place_clods(clods, cfg, (f - 1) / 24.0 * cfg['time_scale'])
        sc.render.filepath = os.path.join(outdir, f'f{i:03d}.exr')
        bpy.ops.render.render(write_still=True)
    log(f'{name}: {len(frames)} frames rendered in {time.time() - t0:.1f}s')
    shutil.rmtree(cache, ignore_errors=True)


def main():
    os.makedirs(OUT, exist_ok=True)
    os.chdir(OUT)  # Mantaflow writes its wavelet noise tile into the working directory
    names = ORDER if argv[0] == 'all' else argv[0].split(',')
    for nm in names:
        render_effect(nm)


main()
