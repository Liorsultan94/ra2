"""
Iron Front - BI2 hero soldier: Tavor X95 / TAR-21 style bullpup with a closed red-dot sight
(generic shapes, no markings). Blender 5.2.2 LTS. Built in rifle space: +X = muzzle, +Z = top,
+Y = the rifle's left side; the bore axis is the X axis, the pistol grip sits near x = 0.
"""
import math
import bpy, bmesh
from mathutils import Vector, Matrix
from hero_lib import *


def mag_profile(top=0.0):
    """STANAG-style curved magazine outline, feed lips at z = top, curving forward as it goes down."""
    return [(-0.098, top), (-0.097, top - 0.07), (-0.091, top - 0.14), (-0.078, top - 0.205),
            (-0.074, top - 0.212), (-0.142, top - 0.226), (-0.147, top - 0.218), (-0.158, top - 0.15),
            (-0.165, top - 0.08), (-0.167, top)]


def build_rifle(M):
    parts = []
    C = 'rifle'
    # receiver + stock shell
    body = [(-0.335, -0.090), (-0.335, 0.030), (-0.326, 0.042), (-0.29, 0.046), (-0.12, 0.046), (-0.10, 0.050),
            (0.10, 0.050), (0.13, 0.046), (0.215, 0.040), (0.226, 0.030), (0.226, -0.022), (0.215, -0.033),
            (0.11, -0.038), (0.06, -0.044), (0.02, -0.047), (-0.03, -0.049), (-0.08, -0.053), (-0.175, -0.056),
            (-0.20, -0.062), (-0.30, -0.086), (-0.322, -0.092)]
    parts.append(extrude_profile('Rifle_Body', body, 0.058, C, M['polymer'], bevel=0.006, segs=3))
    # cheek riser / ejection cover panels (both sides)
    for sy in (1, -1):
        parts.append(rbox('Rifle_Cheek_%d' % sy, (0.14, 0.006, 0.05), (-0.20, sy * 0.030, 0.012), cname=C, mat=M['polymer'], bevel=0.0025))
        parts.append(rbox('Rifle_GripPanel_%d' % sy, (0.12, 0.005, 0.03), (0.15, sy * 0.030, 0.0), cname=C, mat=M['polymer'], bevel=0.002))
        # side accessory rails on the hand guard
        r = rbox('Rifle_SideRail_%d' % sy, (0.075, 0.006, 0.014), (0.165, sy * 0.033, 0.006), cname=C, mat=M['metal'], bevel=0.001)
        parts.append(r)
        parts.append(cyl('Rifle_Selector_%d' % sy, 0.008, 0.006, (0.0, sy * 0.031, -0.03), (math.pi / 2, 0, 0), C, M['metal'], 16, 0.001))
    # butt pad
    parts.append(rbox('Rifle_ButtPad', (0.014, 0.06, 0.128), (-0.341, 0, -0.03), cname=C, mat=M['rubber'], bevel=0.004))
    # pistol grip (slanted back) with finger grooves
    grip = [(0.056, -0.038), (0.034, -0.15), (0.027, -0.163), (-0.004, -0.162), (-0.01, -0.15), (0.0, -0.11),
            (0.004, -0.09), (0.0, -0.07), (0.01, -0.04)]
    parts.append(extrude_profile('Rifle_Grip', grip, 0.032, C, M['polymer'], bevel=0.005, segs=3))
    # big X95 style trigger guard (bar sweeping from the hand guard to the grip bottom)
    gpts = [(0.112, -0.034), (0.112, -0.09), (0.104, -0.122), (0.085, -0.142), (0.06, -0.152), (0.034, -0.156)]
    pts3 = [Vector((x, 0, z)) for x, z in gpts]
    nrms = []
    for i in range(len(pts3)):
        t = (pts3[min(i + 1, len(pts3) - 1)] - pts3[max(i - 1, 0)]).normalized()
        nrms.append(Vector((t.z, 0, -t.x)))
    g = strap_along('Rifle_Guard', pts3, nrms, 0.026, 0.011, C, M['polymer'])
    parts.append(g)
    parts.append(tube_along('Rifle_Trigger', [(0.066, 0, -0.046), (0.067, 0, -0.062), (0.062, 0, -0.078)], 0.003, C, M['metal']))
    # magazine behind the grip + floor plate
    parts.append(extrude_profile('Rifle_Mag', mag_profile(-0.05), 0.024, C, M['mag'], bevel=0.003, segs=2))
    parts.append(rbox('Rifle_MagBase', (0.075, 0.03, 0.012), (-0.111, 0, -0.272), (0, math.radians(-12), 0), cname=C, mat=M['mag'], bevel=0.003))
    parts.append(rbox('Rifle_MagRelease', (0.012, 0.064, 0.012), (-0.06, 0, -0.06), cname=C, mat=M['polymer'], bevel=0.002))
    # barrel, gas block, flash hider
    parts.append(cyl('Rifle_Barrel', 0.0095, 0.09, (0.27, 0, 0.004), (0, math.pi / 2, 0), C, M['metal'], 24))
    parts.append(cyl('Rifle_FlashHider', 0.0115, 0.055, (0.338, 0, 0.004), (0, math.pi / 2, 0), C, M['metal'], 24, 0.001))
    for k in range(6):
        a = k * math.pi / 3
        parts.append(rbox('Rifle_FHslot%d' % k, (0.03, 0.004, 0.004), (0.348, math.cos(a) * 0.0112, 0.004 + math.sin(a) * 0.0112),
                          (a, 0, 0), cname=C, mat=M['rubber'], bevel=0.0))
    parts.append(cyl('Rifle_Muzzle', 0.006, 0.002, (0.3665, 0, 0.004), (0, math.pi / 2, 0), C, M['rubber'], 20))
    # top Picatinny rail: base + teeth (array)
    parts.append(rbox('Rifle_Rail', (0.30, 0.022, 0.008), (0.0, 0, 0.054), cname=C, mat=M['metal'], bevel=0.0015))
    tooth = rbox('Rifle_RailTeeth', (0.0052, 0.024, 0.005), (-0.145, 0, 0.0605), cname=C, mat=M['metal'], bevel=0.0008)
    arr = tooth.modifiers.new('arr', 'ARRAY')
    arr.count = 30
    arr.use_relative_offset = False
    arr.use_constant_offset = True
    arr.constant_offset_displace = (0.01, 0, 0)
    tooth.modifiers.move(len(tooth.modifiers) - 1, 0)
    parts.append(tooth)
    # brass deflector on the right cheek, folded back-up sight at the rear of the rail
    parts.append(rbox('Rifle_Deflector', (0.034, 0.012, 0.03), (-0.215, -0.034, 0.02), cname=C, mat=M['polymer'], bevel=0.003))
    parts.append(rbox('Rifle_RearSight', (0.022, 0.02, 0.011), (-0.125, 0, 0.071), cname=C, mat=M['metal'], bevel=0.002))
    parts.append(rbox('Rifle_FrontSight', (0.018, 0.02, 0.01), (0.135, 0, 0.071), cname=C, mat=M['metal'], bevel=0.002))
    # charging handle (front left) and sling points
    parts.append(cyl('Rifle_Charging', 0.006, 0.026, (0.175, 0.04, 0.026), (math.pi / 2, 0, 0), C, M['polymer'], 16, 0.001))
    parts.append(cyl('Rifle_SlingRear', 0.009, 0.004, (-0.305, 0.031, 0.025), (math.pi / 2, 0, 0), C, M['metal'], 20))
    parts.append(cyl('Rifle_SlingFront', 0.008, 0.004, (0.19, 0.031, -0.025), (math.pi / 2, 0, 0), C, M['metal'], 20))
    # red-dot: mount, closed tube housing, lenses, turrets, the dot itself
    parts.append(rbox('RD_Mount', (0.05, 0.03, 0.016), (0.02, 0, 0.071), cname=C, mat=M['polymer'], bevel=0.002))
    parts.append(rbox('RD_MountKnob', (0.012, 0.012, 0.012), (0.02, -0.02, 0.07), cname=C, mat=M['metal'], bevel=0.002))
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=False, segments=32, radius1=0.0215, radius2=0.0215, depth=0.072)
    hous = obj_from_bm('RD_Housing', bm, C, M['polymer'])
    bm.free()
    hous.location = (0.02, 0, 0.1)
    hous.rotation_euler = (0, math.pi / 2, 0)
    add_mod(hous, 'SOLIDIFY', thickness=0.0035, offset=1.0)
    add_mod(hous, 'BEVEL', width=0.0012, segments=2, limit_method='ANGLE')
    parts.append(hous)
    parts.append(rbox('RD_Hood', (0.072, 0.03, 0.01), (0.02, 0, 0.122), cname=C, mat=M['polymer'], bevel=0.003))
    parts.append(cyl('RD_LensF', 0.0205, 0.002, (0.052, 0, 0.1), (0, math.pi / 2, 0), C, M['reddot_lens'], 32))
    parts.append(cyl('RD_LensB', 0.0205, 0.002, (-0.012, 0, 0.1), (0, math.pi / 2, 0), C, M['clear_lens'], 32))
    parts.append(cyl('RD_TurretTop', 0.008, 0.012, (0.02, 0, 0.129), (0, 0, 0), C, M['polymer'], 20, 0.001))
    parts.append(cyl('RD_TurretSide', 0.008, 0.012, (0.02, -0.027, 0.1), (math.pi / 2, 0, 0), C, M['polymer'], 20, 0.001))
    dot = cyl('RD_Dot', 0.0012, 0.0005, (0.049, 0, 0.1), (0, math.pi / 2, 0), C, M['reddot_emit'], 12)
    parts.append(dot)

    root = bpy.data.objects.new('Rifle', None)
    coll(C).objects.link(root)
    for p in parts:
        p.parent = root
    return root
