"""
Iron Front - BI2 hero soldier, stage 3: Cycles studio renders (Blender 5.2.2 LTS).

  nice /opt/blender/blender -b --factory-startup -P web/tools/blender/hero/stage3_render.py -- \
      [--blend $HERO_WORK/stage2_posed.blend] [--out /tmp/claude-0/BI2] [--res 1600] [--samples 128] \
      [--views front,q34,back,bust,hands,boots,face,headside,midbody,rifle_r,rifle_l] [--only rifle] [--prefix render-] [--suffix -v2]

Light grey seamless cyclorama, soft 3-point area lighting (key, fill, rim) + dim ambient, 85 mm lens.
"""
import sys, os, math, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
from mathutils import Vector
from hero_lib import *

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []


def arg(k, d):
    return argv[argv.index(k) + 1] if k in argv else d


BLEND = arg('--blend', os.path.join(WORK, 'stage2_posed.blend'))
OUT = arg('--out', '/tmp/claude-0/BI2')
RES = int(arg('--res', '1600'))
SAMPLES = int(arg('--samples', '128'))
VIEWS = arg('--views', 'front,q34,back,bust').split(',')
ONLY = arg('--only', '')  # e.g. 'rifle': render only that collection (plus the studio)
PREFIX = arg('--prefix', 'render-')
SUFFIX = arg('--suffix', '-v2')

bpy.ops.wm.open_mainfile(filepath=BLEND)
sc = bpy.context.scene

# clay fallback for anything without a material (early previews)
clay = bpy.data.materials.new('clay')
clay.use_nodes = True
clay.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.32, 0.32, 0.3, 1)
clay.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.7
for o in sc.objects:
    if o.type in ('MESH', 'CURVE') and len(o.data.materials) == 0:
        o.data.materials.append(clay)

# ---------------------------------------------------------------- cyclorama
import bmesh
bm = bmesh.new()
prof = []
R = 1.6
for i in range(0, 13):
    a = math.radians(90 * i / 12)
    prof.append((2.4 + math.sin(a) * R, R - math.cos(a) * R))
prof = [(-6.0, 0.0)] + prof + [(2.4 + R, 6.0)]
rows = []
for x in (-7.0, 7.0):
    rows.append([bm.verts.new((x, y, z)) for y, z in prof])
for i in range(len(prof) - 1):
    bm.faces.new([rows[0][i], rows[0][i + 1], rows[1][i + 1], rows[1][i]])
cyc = obj_from_bm('Cyclorama', bm, 'studio')
m = bpy.data.materials.new('backdrop')
m.use_nodes = True
b = m.node_tree.nodes['Principled BSDF']
b.inputs['Base Color'].default_value = (0.42, 0.42, 0.42, 1)
b.inputs['Roughness'].default_value = 0.9
cyc.data.materials.append(m)


def area(name, loc, target, size, energy, color=(1, 1, 1)):
    ld = bpy.data.lights.new(name, 'AREA')
    ld.shape = 'RECTANGLE' if isinstance(size, tuple) else 'SQUARE'
    if isinstance(size, tuple):
        ld.size, ld.size_y = size
    else:
        ld.size = size
    ld.energy = energy
    ld.color = color
    o = bpy.data.objects.new(name, ld)
    coll('studio').objects.link(o)
    o.location = loc
    d = (Vector(target) - Vector(loc)).normalized()
    o.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    return o


w = bpy.data.worlds.new('studio')
sc.world = w
w.use_nodes = True
w.node_tree.nodes['Background'].inputs[0].default_value = (0.75, 0.76, 0.78, 1)
w.node_tree.nodes['Background'].inputs[1].default_value = 0.18

cam = bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera'))
coll('studio').objects.link(cam)
sc.camera = cam
cam.data.lens = 85
cam.data.sensor_width = 36

sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
sc.cycles.samples = SAMPLES
sc.cycles.use_adaptive_sampling = True
sc.cycles.adaptive_threshold = 0.02
sc.cycles.use_denoising = True
sc.cycles.max_bounces = 8
sc.cycles.diffuse_bounces = 3
sc.cycles.glossy_bounces = 3
sc.cycles.transmission_bounces = 6
sc.render.use_persistent_data = True
sc.render.resolution_x = RES
sc.render.resolution_y = RES
sc.render.film_transparent = False
sc.view_settings.view_transform = 'AgX'
sc.view_settings.look = 'AgX - Medium High Contrast'
sc.view_settings.exposure = 0.0

lights = []


def set_lights(yaw):
    """3-point rig defined relative to the camera direction (yaw: camera azimuth, 0 = front)."""
    for o in lights:
        bpy.data.objects.remove(o)
    lights.clear()

    def rot(x, y, z):
        c, s = math.cos(yaw), math.sin(yaw)
        return (x * c - y * s, x * s + y * c, z)
    lights.append(area('Key', rot(-3.3, -2.0, 3.0), (0, 0, 1.1), 1.6, 560, (1.0, 0.96, 0.9)))
    lights.append(area('Fill', rot(3.0, -3.0, 1.5), (0, 0, 1.0), 2.5, 120, (0.92, 0.96, 1.0)))
    lights.append(area('Rim2', rot(-2.4, 2.8, 2.6), (0, 0, 1.3), (0.8, 2.0), 320))
    lights.append(area('Rim', rot(1.6, 3.2, 3.2), (0, 0, 1.3), (0.8, 2.2), 650))
    lights.append(area('Top', (0, 0, 4.2), (0, 0, 1.0), 1.5, 60))


def shoot(name, yaw_deg, target, frame_h, height=None):
    yaw = math.radians(yaw_deg)
    d = frame_h * cam.data.lens / cam.data.sensor_width
    tz = target[2]
    cz = tz if height is None else height
    # camera on a circle around the target; yaw 0 = in front (-Y)
    pos = Vector((target[0] + math.sin(yaw) * d, target[1] - math.cos(yaw) * d, cz))
    cam.location = pos
    cam.rotation_euler = (Vector(target) - pos).to_track_quat('-Z', 'Y').to_euler()
    set_lights(yaw)
    cyc.rotation_euler = (0, 0, yaw)
    sc.render.filepath = os.path.join(OUT, PREFIX + name + SUFFIX + '.png')
    t = time.time()
    bpy.ops.render.render(write_still=True)
    print('RENDERED', sc.render.filepath, round(time.time() - t, 1), 's', flush=True)


if ONLY:
    keep = {o.name for o in bpy.data.collections[ONLY].all_objects}
    for o in sc.objects:
        if o.type in ('MESH', 'CURVE') and o.name not in keep and o.name != 'Cyclorama':
            o.hide_render = True
shots = {
    'front': (0, (0, 0, 0.93), 2.15, 1.0),
    'q34': (-38, (0, 0, 0.93), 2.15, 1.05),
    'back': (145, (0, 0, 0.93), 2.15, 1.05),
    'bust': (-28, (0.0, -0.04, 1.47), 0.78, 1.55),
    'hands': (-38, (-0.02, -0.28, 1.03), 0.46, 1.12),  # close-up of both hands on the rifle (not in the default set)
    'boots': (-38, (0.0, -0.02, 0.15), 0.62, 0.42),  # close-up of both boots (not in the default set)
    'face': (-24, (0.0, -0.07, 1.655), 0.26, 1.67),  # tight face close-up (not in the default set)
    'headside': (-90, (0.0, -0.04, 1.66), 0.42, 1.7),  # head + helmet from the right side (not in the default set)
    'midbody': (-38, (0.0, -0.05, 0.8), 1.08, 0.9),  # arms (elbows) down to the knees (not in the default set)
    'rifle_r': (-41, (0.0, -0.335, 1.125), 0.55, 1.2),  # rifle right side (use with --only rifle)
    'rifle_l': (139, (0.0, -0.335, 1.125), 0.55, 1.05),  # rifle left side (use with --only rifle)
}
for v in VIEWS:
    yaw, tgt, fh, hz = shots[v]
    shoot(v, yaw, tgt, fh, hz)
print('STAGE3_OK')
