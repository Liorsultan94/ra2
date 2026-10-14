"""
Iron Front - BI2 hero soldier: small details (Blender 5.2.2 LTS), called from stage2_gear.py.

Dog tags on a ball chain resting in the open collar V, yellow foam earplugs on a cord clipped to the right
chinstrap, a black wristwatch on the left glove cuff, a hydration tube from the back over the left shoulder
strap with a bite valve clipped on the chest, a generic unit patch under the flag on the left sleeve and a
generic rank tab on the right sleeve. No real unit insignia.
"""
import math
import bpy
from mathutils import Vector, Matrix
from hero_lib import *


def dog_tags(M, body_bvh):
    # chain: round the neck just inside the collar band, down both sides of the V to the tags
    ring = []
    for k in range(36):
        a = 0.42 + (2 * math.pi - 0.84) * k / 35
        d = Vector((math.sin(a), -math.cos(a), 0))
        z = 1.497 + 0.012 * (1 - math.cos(a)) * 0.5
        hit, n, _, _ = body_bvh.ray_cast(Vector((0, -0.005, z)) + d * 0.3, -d, 0.3)
        if hit is not None:
            ring.append(hit + n * 0.0022)
    tag_c = Vector((0.0, 0.0, 1.448))
    hit, n, _, _ = body_bvh.ray_cast(tag_c + Vector((0, -0.3, 0)), Vector((0, 1, 0)), 0.4)
    tag_c, tag_n = hit + n * 0.003, n
    left = [ring[-1], ring[-1].lerp(tag_c, 0.5) + tag_n * 0.002, tag_c + Vector((0.004, 0, 0.022))]
    right = [tag_c + Vector((-0.004, 0, 0.022)), ring[0].lerp(tag_c, 0.5) + tag_n * 0.002, ring[0]]
    chain = right + ring[1:-1] + left
    chain = [p for p in smooth_curve(chain, 2)]
    tubes('DogTag_Chain', [chain], 0.0009, 'torso', M['metal'])
    for k, (dx, rot) in enumerate(((-0.004, -0.12), (0.005, 0.18))):
        t = rbox('DogTag_%d' % k, (0.028, 0.0012, 0.05), cname='torso', mat=M['metal'], bevel=0.0018)
        orient(t, tag_c + Vector((dx, 0, -0.004 - 0.003 * k)) + tag_n * (0.0012 * k), tag_n, roll=rot)


def earplugs(M, strap_obj, head_bvh):
    """yellow foam plugs on a thin cord clipped to the (right) front chinstrap, hanging by the cheek."""
    sbvh = bvh_of([strap_obj])
    hit, n, _, _ = sbvh.find_nearest(Vector((-0.08, -0.074, 1.628)))
    clip = rbox('Earplug_Clip', (0.008, 0.004, 0.012), cname='helmet', mat=M['polymer'], bevel=0.0015)
    orient(clip, hit + n * 0.004, n)
    top = hit + n * 0.006
    pts = [top]
    for k, (dy, dz) in enumerate(((-0.004, -0.014), (-0.008, -0.03), (-0.01, -0.045))):
        q = top + Vector((0, dy, dz))
        h2, n2, _, _ = head_bvh.find_nearest(q)
        if h2 is not None and (q - h2).length < 0.006:
            q = h2 + n2 * 0.006
        pts.append(q)
    fork = pts[-1]
    plug_mat = M['earplug']
    for k, off in enumerate((Vector((-0.004, -0.006, -0.016)), Vector((0.002, -0.014, -0.012)))):
        end = fork + off
        h2, n2, _, _ = head_bvh.find_nearest(end)
        if h2 is not None and (end - h2).length < 0.009:
            end = h2 + n2 * 0.009
        tubes('Earplug_Cord%d' % k, [smooth_curve(pts + [fork.lerp(end, 0.5), end], 2)] if k == 0 else
              [[fork, fork.lerp(end, 0.5), end]], 0.0006, 'helmet', M['webbing'])
        plug = cyl('Earplug_%d' % k, 0.0055, 0.016, end + Vector((0, 0, -0.008)), (0.25 * (1 - 2 * k), 0.2, 0), 'helmet',
                   plug_mat, 16, 0.003)


def watch(M, glove_bvh):
    """black watch over the left glove cuff (rides rigidly on the hand bone: names start with Glove_)."""
    sx = 1.0
    ax = Vector((sx * ARM_DIR.x, 0, ARM_DIR.y))
    c = arm_point(0.0, sx)
    c.y = -0.005
    ring_band(glove_bvh, 'Glove_WatchBand_L', c, ax, WRIST_T - 0.016, WRIST_T - 0.002, 28, 2, 0.003, 'arms',
              M['rubber'], thick=0.0025, bevel=0.0008, R=0.2)
    out = Vector((sx * 0.92, -0.25, 0.39)).normalized()
    wc = arm_point(WRIST_T - 0.009, sx)
    wc.y = -0.008
    hit, n, _, _ = glove_bvh.ray_cast(wc + out * 0.15, -out, 0.3)
    if hit is None:
        hit, n = wc + out * 0.03, out
    case = rbox('Glove_WatchCase_L', (0.036, 0.011, 0.032), cname='arms', mat=M['rubber'], bevel=0.005)
    orient(case, hit + n * 0.009, n, up=ax)
    face = rbox('Glove_WatchFace_L', (0.024, 0.002, 0.022), cname='arms', mat=M['lens'], bevel=0.002)
    orient(face, hit + n * 0.0147, n, up=ax)


def drink_tube(M, vest_bvh):
    """hydration tube: from the back over the left shoulder strap, down the front to a bite valve."""
    c = Vector((0.124, -0.01, 1.33))
    pts = []
    for k in range(20):
        b = math.pi - 0.5 - (math.pi - 0.5 - 0.18) * k / 19   # out of the pack top -> over the shoulder -> front
        d = Vector((0, -math.cos(b), math.sin(b)))
        hit, n = surface_frame(vest_bvh, c + d * 0.5, -d)
        pts.append(hit + n * 0.007)
    pts = smooth_curve(pts, 2)
    tubes('Hydration_Tube', [pts], 0.0042, 'vest', M['rubber'])
    end = pts[-1]
    d = (pts[-1] - pts[-3]).normalized()
    valve = cyl('Hydration_BiteValve', 0.0055, 0.024, end + d * 0.012, (0, 0, 0), 'vest', M['earplug_dark'], 16, 0.003)
    valve.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    hit, n = surface_frame(vest_bvh, end + Vector((0, -0.3, 0)), (0, 1, 0))
    clip = rbox('Hydration_Clip', (0.016, 0.005, 0.02), cname='vest', mat=M['polymer'], bevel=0.0015)
    orient(clip, end - d * 0.006 + n * 0.0, n)


def sleeve_patches(M, dressed):
    # unit patch (generic shield) under the flag on the left sleeve
    outw = Vector((0.921 * 0.78, -0.62, 0.389 * 0.78)).normalized()
    v_ax = Vector((-ARM_DIR.x, 0, -ARM_DIR.y)).normalized()
    u_ax = v_ax.cross(outw).normalized()
    pc = arm_point(0.172, 1.0)
    project_sheet(dressed, 'Patch_Unit', pc, -u_ax, v_ax, -outw, 0.03, 0.035, 8, 8, 0.0035, 'arms', M['uniform_dark'],
                  thick=0.0016, round_n=2.4, bevel=0.0006)
    project_sheet(dressed, 'Patch_UnitEmblem', pc + v_ax * 0.004, -u_ax, v_ax, -outw, 0.015, 0.018, 6, 6, 0.0053, 'arms',
                  M['polymer_olive'], thick=0.0008, round_n=2.0)
    # rank tab on the right sleeve: dark tab with two light chevrons
    outr = Vector((-0.921 * 0.78, -0.62, 0.389 * 0.78)).normalized()
    v_r = Vector((ARM_DIR.x, 0, -ARM_DIR.y)).normalized()
    u_r = v_r.cross(outr).normalized()
    pr = arm_point(0.13, -1.0)
    project_sheet(dressed, 'Patch_Rank', pr, -u_r, v_r, -outr, 0.024, 0.032, 6, 8, 0.0035, 'arms', M['uniform_dark'],
                  thick=0.0016, round_n=6, bevel=0.0006)
    for k, dv in enumerate((0.009, -0.006)):
        for side in (-1, 1):
            ua = (u_r * math.cos(0.6) + v_r * side * math.sin(0.6)).normalized()   # chevron arm
            va = outr.cross(ua).normalized()
            project_sheet(dressed, 'Patch_RankChevron%d%d' % (k, side + 1), pr + v_r * dv + u_r * side * 0.009 + v_r * 0.006,
                          ua, va, -outr, 0.012, 0.0022, 6, 1, 0.0052, 'arms', M['webbing_light'], thick=0.0008, round_n=8)
