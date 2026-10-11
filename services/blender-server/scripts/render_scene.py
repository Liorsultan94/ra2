"""
Blender 5.2.2 LTS - Studio Renderer & Turntable Generator
Renders high-quality still images and turntable sequences using Cycles or Eevee.
"""
import bpy
import sys
import os
import argparse
import math
import mathutils

def clean_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for col in bpy.data.collections:
        bpy.data.collections.remove(col)
    for obj in bpy.data.objects:
        bpy.data.objects.remove(obj)
    for mesh in bpy.data.meshes:
        bpy.data.meshes.remove(mesh)
    for mat in bpy.data.materials:
        bpy.data.materials.remove(mat)

def setup_lighting(center, radius):
    col = bpy.context.scene.collection
    
    # Key Light (Warm, high angle, front-right)
    key_data = bpy.data.lights.new(name="Key_Light", type='AREA')
    key_data.energy = 800.0 * (radius / 2.0)**2
    key_data.size = radius * 2.0
    key_data.color = (1.0, 0.95, 0.9)
    key_obj = bpy.data.objects.new("Key_Light", key_data)
    key_obj.location = (center.x + radius * 3.0, center.y - radius * 2.5, center.z + radius * 3.5)
    col.objects.link(key_obj)
    
    # Fill Light (Cool, soft, front-left)
    fill_data = bpy.data.lights.new(name="Fill_Light", type='AREA')
    fill_data.energy = 350.0 * (radius / 2.0)**2
    fill_data.size = radius * 3.0
    fill_data.color = (0.75, 0.85, 1.0)
    fill_obj = bpy.data.objects.new("Fill_Light", fill_data)
    fill_obj.location = (center.x - radius * 3.0, center.y - radius * 2.0, center.z + radius * 2.0)
    col.objects.link(fill_obj)
    
    # Rim / Back Light (Sharp, accentuating contours)
    rim_data = bpy.data.lights.new(name="Rim_Light", type='SPOT')
    rim_data.energy = 1000.0 * (radius / 2.0)**2
    rim_data.spot_size = math.radians(60)
    rim_data.color = (1.0, 1.0, 1.0)
    rim_obj = bpy.data.objects.new("Rim_Light", rim_data)
    rim_obj.location = (center.x, center.y + radius * 3.5, center.z + radius * 3.0)
    col.objects.link(rim_obj)

def setup_camera(center, radius, angle_mode="isometric"):
    cam_data = bpy.data.cameras.new("Studio_Cam")
    cam_obj = bpy.data.objects.new("Studio_Cam", cam_data)
    bpy.context.scene.collection.objects.link(cam_obj)
    bpy.context.scene.camera = cam_obj
    
    if angle_mode == "isometric":
        # Classic RA2 / RTS 45-degree angle
        dist = radius * 3.2
        cam_obj.location = (center.x + dist, center.y - dist, center.z + dist * 0.9)
    elif angle_mode == "hero":
        # Dramatic low-angle hero view
        dist = radius * 2.5
        cam_obj.location = (center.x + dist * 0.7, center.y - dist, center.z + radius * 0.6)
    elif angle_mode == "front":
        cam_obj.location = (center.x, center.y - radius * 3.0, center.z + radius * 0.8)
    elif angle_mode == "top":
        cam_obj.location = (center.x, center.y, center.z + radius * 3.5)
    else:
        dist = radius * 3.0
        cam_obj.location = (center.x + dist, center.y - dist, center.z + dist * 0.8)
        
    # Track to center constraint
    track = cam_obj.constraints.new(type='TRACK_TO')
    
    # Create empty target at center
    target = bpy.data.objects.new("Cam_Target", None)
    target.location = center
    bpy.context.scene.collection.objects.link(target)
    
    track.target = target
    track.track_axis = 'TRACK_NEGATIVE_Z'
    track.up_axis = 'UP_Y'
    
    return cam_obj, target

def get_scene_bounds():
    mesh_objs = [o for o in bpy.data.objects if o.type == 'MESH']
    if not mesh_objs:
        return mathutils.Vector((0,0,0)), 2.0
    min_x = min_y = min_z = float('inf')
    max_x = max_y = max_z = float('-inf')
    for obj in mesh_objs:
        for v in obj.bound_box:
            world_v = obj.matrix_world @ mathutils.Vector(v)
            min_x = min(min_x, world_v.x)
            max_x = max(max_x, world_v.x)
            min_y = min(min_y, world_v.y)
            max_y = max(max_y, world_v.y)
            min_z = min(min_z, world_v.z)
            max_z = max(max_z, world_v.z)
    center = mathutils.Vector(((min_x + max_x) / 2.0, (min_y + max_y) / 2.0, (min_z + max_z) / 2.0))
    radius = max((max_x - min_x), (max_y - min_y), (max_z - min_z)) / 2.0
    return center, max(radius, 1.0)

def main():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []
        
    parser = argparse.ArgumentParser(description="Blender 5.2.2 Studio Renderer")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--engine", default="BLENDER_EEVEE", choices=["BLENDER_EEVEE", "CYCLES"])
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--width", type=int, default=800)
    parser.add_argument("--height", type=int, default=800)
    parser.add_argument("--angle", default="isometric", choices=["isometric", "hero", "front", "top"])
    parser.add_argument("--turntable_frames", type=int, default=0, help="If > 0, renders a turntable sequence")
    args = parser.parse_args(argv)
    
    args.input = os.path.abspath(args.input)
    args.output = os.path.abspath(args.output)
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    
    clean_scene()
    
    # Import Model
    ext = os.path.splitext(args.input)[1].lower()
    if ext in ['.glb', '.gltf']:
        bpy.ops.import_scene.gltf(filepath=args.input)
    elif ext == '.obj':
        bpy.ops.wm.obj_import(filepath=args.input)
    elif ext == '.fbx':
        bpy.ops.import_scene.fbx(filepath=args.input)
    elif ext == '.stl':
        bpy.ops.wm.stl_import(filepath=args.input)
    else:
        raise ValueError(f"Unsupported format: {ext}")
        
    center, radius = get_scene_bounds()
    setup_lighting(center, radius)
    cam_obj, target = setup_camera(center, radius, args.angle)
    
    # Render Settings
    scene = bpy.context.scene
    scene.render.engine = args.engine
    scene.render.resolution_x = args.width
    scene.render.resolution_y = args.height
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    
    if args.engine == "CYCLES":
        scene.cycles.samples = args.samples
        # Adaptive sampling for speed
        scene.cycles.use_adaptive_sampling = True
        
    if args.turntable_frames > 1:
        # Render Turntable Sequence
        out_dir = os.path.splitext(args.output)[0] + "_frames"
        os.makedirs(out_dir, exist_ok=True)
        dist = (cam_obj.location - center).length
        elevation = cam_obj.location.z - center.z
        horiz_dist = math.sqrt(max(0, dist**2 - elevation**2))
        
        frames = []
        for i in range(args.turntable_frames):
            theta = (2 * math.pi * i) / args.turntable_frames
            cam_obj.location.x = center.x + horiz_dist * math.cos(theta)
            cam_obj.location.y = center.y + horiz_dist * math.sin(theta)
            cam_obj.location.z = center.z + elevation
            
            frame_path = os.path.join(out_dir, f"frame_{i:03d}.png")
            scene.render.filepath = frame_path
            bpy.ops.render.render(write_still=True)
            frames.append(frame_path)
            
        # Copy middle frame to main output
        import shutil
        shutil.copy(frames[0], args.output)
        print(f"RENDER_TURNTABLE_SUCCESS: Frames={args.turntable_frames}, Dir={out_dir}, File={args.output}")
    else:
        scene.render.filepath = args.output
        bpy.ops.render.render(write_still=True)
        print(f"RENDER_SUCCESS: Engine={args.engine}, Res={args.width}x{args.height}, File={args.output}")

if __name__ == "__main__":
    main()
