"""
Blender 5.2.2 LTS - 3D Model Converter & Mesh Optimizer
Converts OBJ/FBX/STL/GLTF/DAE to web-optimized GLB with optional decimation and pivot centering.
"""
import bpy
import sys
import os
import argparse
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

def import_file(filepath):
    ext = os.path.splitext(filepath)[1].lower()
    print(f"Importing format '{ext}' from {filepath}...")
    if ext == '.obj':
        bpy.ops.wm.obj_import(filepath=filepath)
    elif ext == '.fbx':
        bpy.ops.import_scene.fbx(filepath=filepath)
    elif ext == '.stl':
        bpy.ops.wm.stl_import(filepath=filepath)
    elif ext in ['.gltf', '.glb']:
        bpy.ops.import_scene.gltf(filepath=filepath)
    else:
        raise ValueError(f"Unsupported input format: {ext}")

def main():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []
        
    parser = argparse.ArgumentParser(description="Blender 5.2.2 Model Converter & Optimizer")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--decimate", type=float, default=1.0, help="Decimation ratio between 0.05 and 1.0")
    parser.add_argument("--center", action="store_true", default=True, help="Center pivot to bottom-center")
    args = parser.parse_args(argv)
    
    args.input = os.path.abspath(args.input)
    args.output = os.path.abspath(args.output)
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    
    clean_scene()
    import_file(args.input)
    
    mesh_objs = [o for o in bpy.data.objects if o.type == 'MESH']
    if not mesh_objs:
        raise RuntimeError("No mesh objects found after import!")
        
    initial_polys = sum(len(o.data.polygons) for o in mesh_objs)
    initial_verts = sum(len(o.data.vertices) for o in mesh_objs)
    
    # Optional decimation
    if 0.05 <= args.decimate < 0.999:
        print(f"Applying decimation modifier with ratio {args.decimate}...")
        for obj in mesh_objs:
            bpy.context.view_layer.objects.active = obj
            mod = obj.modifiers.new(name="WebDecimate", type='DECIMATE')
            mod.ratio = args.decimate
            bpy.ops.object.modifier_apply(modifier=mod.name)
            
    # Center bounds
    if args.center and mesh_objs:
        min_x = min_y = min_z = float('inf')
        max_x = max_y = max_z = float('-inf')
        for obj in mesh_objs:
            matrix = obj.matrix_world
            for v in obj.bound_box:
                world_v = matrix @ mathutils.Vector(v)
                min_x = min(min_x, world_v.x)
                max_x = max(max_x, world_v.x)
                min_y = min(min_y, world_v.y)
                max_y = max(max_y, world_v.y)
                min_z = min(min_z, world_v.z)
                max_z = max(max_z, world_v.z)
                
        center_x = (min_x + max_x) / 2.0
        center_y = (min_y + max_y) / 2.0
        shift = mathutils.Vector((-center_x, -center_y, -min_z))
        
        for obj in mesh_objs:
            obj.location += shift
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

    final_polys = sum(len(o.data.polygons) for o in mesh_objs)
    final_verts = sum(len(o.data.vertices) for o in mesh_objs)
    
    print(f"Exporting converted GLB to {args.output}...")
    bpy.ops.export_scene.gltf(
        filepath=args.output,
        export_format='GLB',
        export_apply=True,
        export_yup=True,
        export_materials='EXPORT'
    )
    
    print(f"CONVERT_SUCCESS: InPolys={initial_polys}, OutPolys={final_polys}, InVerts={initial_verts}, OutVerts={final_verts}, File={args.output}")

if __name__ == "__main__":
    main()
