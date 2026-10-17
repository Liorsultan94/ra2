import bpy
import os
import math
import sys

def clean_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for obj in bpy.data.objects:
        bpy.data.objects.remove(obj)

def create_explosion_material():
    mat = bpy.data.materials.new(name="ExplosionMat")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    
    # Clear default
    for n in nodes:
        nodes.remove(n)
        
    out = nodes.new('ShaderNodeOutputMaterial')
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    
    # Keyframes for Emission Color (White -> Yellow -> Orange -> Dark Smoke)
    # Emission Strength (High -> Low)
    # Alpha (1.0 -> 0.0)
    
    bsdf.inputs['Base Color'].default_value = (0.1, 0.1, 0.1, 1.0)
    bsdf.inputs['Metallic'].default_value = 0.0
    bsdf.inputs['Roughness'].default_value = 1.0
    
    return mat, bsdf

def build_explosion():
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=1.0)
    sphere = bpy.context.active_object
    
    # Add displacement for cloud-like explosion
    tex = bpy.data.textures.new("Cloud", 'CLOUDS')
    tex.noise_scale = 0.5
    
    mod = sphere.modifiers.new("Displace", 'DISPLACE')
    mod.texture = tex
    mod.strength = 0.5
    
    # Material
    mat, bsdf = create_explosion_material()
    sphere.data.materials.append(mat)
    
    return sphere, bsdf, mod

def main():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []
        
    output_dir = argv[0] if len(argv) > 0 else "output"
    os.makedirs(output_dir, exist_ok=True)
    
    clean_scene()
    
    sphere, bsdf, mod = build_explosion()
    
    # Animate scale, emission, displacement strength
    frames = 16
    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = frames
    
    for f in range(1, frames + 1):
        progress = (f - 1) / (frames - 1)
        
        # Scale: explodes outward then slows down
        scale = 1.0 + (progress ** 0.5) * 3.0
        sphere.scale = (scale, scale, scale)
        sphere.keyframe_insert(data_path="scale", frame=f)
        
        # Displacement morphing
        mod.strength = 0.5 + progress * 1.5
        mod.keyframe_insert(data_path="strength", frame=f)
        
        # Color: White(0) -> Yellow/Orange(0.3) -> Dark Gray/Black(0.6+)
        if progress < 0.2:
            r, g, b = 1.0, 1.0, 0.8
            strength = 10.0
            alpha = 1.0
        elif progress < 0.5:
            fac = (progress - 0.2) / 0.3
            r = 1.0 - (fac * 0.2)
            g = 1.0 - (fac * 0.6)
            b = 0.8 - (fac * 0.8)
            strength = 5.0 * (1.0 - fac)
            alpha = 1.0
        else:
            fac = (progress - 0.5) / 0.5
            r, g, b = 0.8 * (1-fac), 0.4 * (1-fac), 0.0
            strength = 0.0
            alpha = 1.0 - fac
            
        bsdf.inputs['Emission Color'].default_value = (r, g, b, 1.0)
        bsdf.inputs['Emission Color'].keyframe_insert(data_path="default_value", frame=f)
        
        bsdf.inputs['Emission Strength'].default_value = strength
        bsdf.inputs['Emission Strength'].keyframe_insert(data_path="default_value", frame=f)
        
        bsdf.inputs['Alpha'].default_value = alpha
        bsdf.inputs['Alpha'].keyframe_insert(data_path="default_value", frame=f)
        
    # Setup Camera
    cam_data = bpy.data.cameras.new("Cam")
    cam_obj = bpy.data.objects.new("Cam", cam_data)
    bpy.context.scene.collection.objects.link(cam_obj)
    bpy.context.scene.camera = cam_obj
    cam_obj.location = (0, -8, 2)
    cam_obj.rotation_euler = (math.radians(75), 0, 0)
    
    # Lighting (ambient light for smoke)
    light_data = bpy.data.lights.new(name="Sun", type='SUN')
    light_data.energy = 2.0
    light_obj = bpy.data.objects.new("Sun", light_data)
    light_obj.rotation_euler = (math.radians(45), math.radians(45), 0)
    bpy.context.scene.collection.objects.link(light_obj)
    
    # Render Settings
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x = 256
    scene.render.resolution_y = 256
    scene.render.film_transparent = True
    scene.render.image_settings.color_mode = 'RGBA'
    
    for f in range(1, frames + 1):
        scene.frame_set(f)
        scene.render.filepath = os.path.join(output_dir, f"expl_{f:02d}.png")
        bpy.ops.render.render(write_still=True)
        
    print(f"RENDER_SUCCESS: Generated {frames} frames in {output_dir}")

if __name__ == "__main__":
    main()
