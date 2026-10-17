import bpy
import math
import os

def clean_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for col in list(bpy.data.collections):
        bpy.data.collections.remove(col)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    for mesh in list(bpy.data.meshes):
        bpy.data.meshes.remove(mesh)
    for mat in list(bpy.data.materials):
        bpy.data.materials.remove(mat)

def make_pbr_material(name, base_color, metallic=0.8, roughness=0.25, emissive_color=(0,0,0,1), emissive_strength=0.0):
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    if bsdf:
        if "Base Color" in bsdf.inputs:
            bsdf.inputs["Base Color"].default_value = (*base_color[:3], 1.0)
        if "Metallic" in bsdf.inputs:
            bsdf.inputs["Metallic"].default_value = metallic
        if "Roughness" in bsdf.inputs:
            bsdf.inputs["Roughness"].default_value = roughness
        if "Emission Color" in bsdf.inputs:
            bsdf.inputs["Emission Color"].default_value = (*emissive_color[:3], 1.0)
        if "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = emissive_strength
    return mat

def create_advanced_heavy_tank():
    clean_scene()
    
    # Materials
    mat_team = make_pbr_material("Team_Color", (0.9, 0.15, 0.1), metallic=0.4, roughness=0.3) # Marked 'Team' so game tints it
    mat_dark_armor = make_pbr_material("Dark_Heavy_Plate", (0.12, 0.13, 0.15), metallic=0.85, roughness=0.35)
    mat_chrome = make_pbr_material("Machined_Alloy", (0.75, 0.78, 0.82), metallic=0.95, roughness=0.15)
    mat_reactor_glow = make_pbr_material("Plasma_Cyan_Glow", (0.1, 0.85, 1.0), metallic=0.1, roughness=0.1, emissive_color=(0.1, 0.9, 1.0, 1.0), emissive_strength=8.0)
    
    parts = []
    
    # 1. Heavy Central Chassis
    bpy.ops.mesh.primitive_cube_add(location=(0, 0, 0.55), scale=(1.2, 1.8, 0.35))
    chassis = bpy.context.active_object
    chassis.name = "Chassis_Core"
    chassis.data.materials.append(mat_dark_armor)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    parts.append(chassis)
    
    # Sloped Upper Glacis Plate
    bpy.ops.mesh.primitive_cube_add(location=(0, 1.4, 0.65), scale=(1.1, 0.6, 0.2))
    glacis = bpy.context.active_object
    glacis.name = "Glacis_Plate"
    glacis.rotation_euler = (math.radians(-35), 0, 0)
    glacis.data.materials.append(mat_team)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    parts.append(glacis)
    
    # 2. Quad Heavy Treads (Front L/R, Rear L/R)
    for x_side in [-1.45, 1.45]:
        for y_side, y_offset in [("Front", 0.9), ("Rear", -0.9)]:
            # Tread pod
            bpy.ops.mesh.primitive_cube_add(location=(x_side, y_offset, 0.45), scale=(0.35, 0.85, 0.35))
            pod = bpy.context.active_object
            pod.name = f"Tread_{y_side}_{'L' if x_side < 0 else 'R'}"
            pod.data.materials.append(mat_dark_armor)
            bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
            parts.append(pod)
            
            # Heavy Road Wheel inside pod
            bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.32, depth=0.38, location=(x_side, y_offset, 0.45), rotation=(0, math.radians(90), 0))
            wheel = bpy.context.active_object
            wheel.name = f"Wheel_{y_side}_{'L' if x_side < 0 else 'R'}"
            wheel.data.materials.append(mat_chrome)
            bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
            parts.append(wheel)
            
            # Armor shield on tread
            bpy.ops.mesh.primitive_cube_add(location=(x_side * 1.08, y_offset, 0.6), scale=(0.08, 0.82, 0.22))
            shield = bpy.context.active_object
            shield.name = f"Shield_{y_side}"
            shield.data.materials.append(mat_team)
            bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
            parts.append(shield)

    # 3. Plasma Reactor Core (Glowing rear engine vents)
    bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.45, depth=0.5, location=(0, -1.5, 0.7), rotation=(math.radians(90), 0, 0))
    reactor = bpy.context.active_object
    reactor.name = "Reactor_Core"
    reactor.data.materials.append(mat_reactor_glow)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    parts.append(reactor)
    
    # 4. Turret Assembly (Must be named 'turret' so game rotates it!)
    bpy.ops.mesh.primitive_cube_add(location=(0, -0.1, 1.2), scale=(0.95, 1.15, 0.3))
    turret = bpy.context.active_object
    turret.name = "turret" # Key naming convention for engine
    turret.data.materials.append(mat_team)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    
    # Turret Angled Cheeks
    for cheek_side in [-0.85, 0.85]:
        bpy.ops.mesh.primitive_cube_add(location=(cheek_side, 0.1, 1.2), scale=(0.25, 0.75, 0.28))
        chk = bpy.context.active_object
        chk.name = f"Cheek_{'L' if cheek_side < 0 else 'R'}"
        chk.rotation_euler = (0, 0, math.radians(-15 if cheek_side < 0 else 15))
        chk.data.materials.append(mat_dark_armor)
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        # Parent cheek to turret
        chk.parent = turret
        
    # Commander Cupola & Sensor Dome
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=12, radius=0.28, location=(0.45, -0.4, 1.55))
    cupola = bpy.context.active_object
    cupola.name = "Cupola_Dome"
    cupola.data.materials.append(mat_reactor_glow)
    cupola.parent = turret
    
    # Heavy Dual Railgun / Cannons
    for barrel_x in [-0.38, 0.38]:
        # Armored Mantlet
        bpy.ops.mesh.primitive_cube_add(location=(barrel_x, 1.15, 1.2), scale=(0.2, 0.35, 0.2))
        mant = bpy.context.active_object
        mant.name = f"Mantlet_{'L' if barrel_x < 0 else 'R'}"
        mant.data.materials.append(mat_dark_armor)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        mant.parent = turret
        
        # Heavy Barrel (Hexagonal / Octagonal section)
        bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.11, depth=2.5, location=(barrel_x, 2.3, 1.2), rotation=(math.radians(90), 0, 0))
        bar = bpy.context.active_object
        bar.name = f"Barrel_{'L' if barrel_x < 0 else 'R'}"
        bar.data.materials.append(mat_chrome)
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        bar.parent = turret
        
        # Muzzle Brake / Energy Suppressor (Named 'muzzle' for engine effects!)
        bpy.ops.mesh.primitive_cube_add(location=(barrel_x, 3.5, 1.2), scale=(0.18, 0.25, 0.18))
        muz = bpy.context.active_object
        muz.name = f"muzzle_{'1' if barrel_x < 0 else '2'}"
        muz.data.materials.append(mat_dark_armor)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        muz.parent = turret

    # Export to GLB
    out_path = r"C:\Users\LIOR SULTAN\.gemini\antigravity\scratch\ra2\web\public\models\test_tank.glb"
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format='GLB',
        export_apply=False, # preserve hierarchy so turret and muzzle survive
        export_yup=True,
        export_materials='EXPORT'
    )
    print("SUCCESS: High detail futuristic heavy tank exported to", out_path)

if __name__ == "__main__":
    create_advanced_heavy_tank()
