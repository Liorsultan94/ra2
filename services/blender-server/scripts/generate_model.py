"""
Blender 5.2.2 LTS - Procedural 3D Model Generator for RA2
Generates game-ready, optimized 3D assets and exports to .GLB
"""
import bpy
import sys
import os
import argparse
import math

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

def make_material(name, base_color, metallic=0.6, roughness=0.35, emission_color=(0,0,0,1), emission_strength=0.0):
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
            bsdf.inputs["Emission Color"].default_value = (*emission_color[:3], 1.0)
        if "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat

def hex_to_rgb(hex_str):
    hex_str = hex_str.lstrip('#')
    if len(hex_str) != 6:
        return (0.8, 0.2, 0.2)
    return tuple(int(hex_str[i:i+2], 16) / 255.0 for i in (0, 2, 4))

def apply_material(obj, mat):
    if not obj.data.materials:
        obj.data.materials.append(mat)
    else:
        obj.data.materials[0] = mat

def add_box(name, location, scale, material=None):
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if material:
        apply_material(obj, material)
    return obj

def add_cylinder(name, location, radius, depth, rotation=(0,0,0), vertices=16, material=None):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=depth,
        location=location,
        rotation=rotation
    )
    obj = bpy.context.active_object
    obj.name = name
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if material:
        apply_material(obj, material)
    return obj

def add_torus(name, location, major_r, minor_r, material=None):
    bpy.ops.mesh.primitive_torus_add(
        location=location,
        major_radius=major_r,
        minor_radius=minor_r,
        major_segments=24,
        minor_segments=12
    )
    obj = bpy.context.active_object
    obj.name = name
    if material:
        apply_material(obj, material)
    return obj

def add_sphere(name, location, radius, material=None):
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=16,
        ring_count=12,
        radius=radius,
        location=location
    )
    obj = bpy.context.active_object
    obj.name = name
    if material:
        apply_material(obj, material)
    return obj

def build_tank(faction, primary_mat, dark_mat, metal_mat, emissive_mat):
    parts = []
    
    # 1. Main Hull
    hull = add_box("Hull_Main", (0, 0, 0.7), (1.4, 2.2, 0.5), primary_mat)
    parts.append(hull)
    
    # Sloped front armor
    front_armor = add_box("Hull_Front_Glacis", (0, 1.8, 0.55), (1.3, 0.6, 0.35), primary_mat)
    front_armor.rotation_euler = (math.radians(-30), 0, 0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    parts.append(front_armor)
    
    # 2. Treads (Left & Right)
    tread_left = add_box("Tread_L", (-1.55, 0, 0.45), (0.35, 2.3, 0.45), dark_mat)
    tread_right = add_box("Tread_R", (1.55, 0, 0.45), (0.35, 2.3, 0.45), dark_mat)
    parts.extend([tread_left, tread_right])
    
    # Road wheels
    for y in [-1.5, -0.75, 0.0, 0.75, 1.5]:
        wl = add_cylinder("Wheel_L", (-1.55, y, 0.45), radius=0.35, depth=0.38, rotation=(0, math.radians(90), 0), material=metal_mat)
        wr = add_cylinder("Wheel_R", (1.55, y, 0.45), radius=0.35, depth=0.38, rotation=(0, math.radians(90), 0), material=metal_mat)
        parts.extend([wl, wr])
        
    # Tread guards / Mudguards
    guard_l = add_box("Guard_L", (-1.55, 0, 0.95), (0.4, 2.4, 0.08), primary_mat)
    guard_r = add_box("Guard_R", (1.55, 0, 0.95), (0.4, 2.4, 0.08), primary_mat)
    parts.extend([guard_l, guard_r])
    
    # 3. Turret Assembly
    turret = add_box("Turret_Base", (0, -0.1, 1.35), (1.05, 1.3, 0.4), primary_mat)
    parts.append(turret)
    
    cupola = add_cylinder("Cupola", (0.4, -0.4, 1.8), radius=0.3, depth=0.2, material=dark_mat)
    parts.append(cupola)
    
    # Cannons
    if faction.lower() == "soviet":
        # Dual Heavy Cannons (Apocalypse style)
        b1 = add_cylinder("Barrel_1", (-0.35, 1.8, 1.4), radius=0.1, depth=2.4, rotation=(math.radians(90), 0, 0), material=dark_mat)
        b2 = add_cylinder("Barrel_2", (0.35, 1.8, 1.4), radius=0.1, depth=2.4, rotation=(math.radians(90), 0, 0), material=dark_mat)
        m1 = add_box("Muzzle_1", (-0.35, 3.0, 1.4), (0.16, 0.25, 0.16), metal_mat)
        m2 = add_box("Muzzle_2", (0.35, 3.0, 1.4), (0.16, 0.25, 0.16), metal_mat)
        parts.extend([b1, b2, m1, m2])
        # Dual missile pods
        pod1 = add_box("Missile_Pod_L", (-0.95, -0.3, 1.6), (0.25, 0.5, 0.25), dark_mat)
        pod2 = add_box("Missile_Pod_R", (0.95, -0.3, 1.6), (0.25, 0.5, 0.25), dark_mat)
        parts.extend([pod1, pod2])
    else:
        # Allies Heavy Laser/Railgun Cannon (Grizzly / Prism style)
        b = add_cylinder("Barrel_Main", (0, 2.0, 1.4), radius=0.12, depth=2.8, rotation=(math.radians(90), 0, 0), material=metal_mat)
        m = add_cylinder("Muzzle_Brake", (0, 3.4, 1.4), radius=0.18, depth=0.35, rotation=(math.radians(90), 0, 0), material=dark_mat)
        sensor = add_box("Optics_Pod", (-0.55, 0.6, 1.55), (0.2, 0.3, 0.2), emissive_mat)
        parts.extend([b, m, sensor])

    # Rear fuel tanks
    ft1 = add_cylinder("Fuel_Tank_L", (-0.75, -2.1, 0.8), radius=0.25, depth=0.8, rotation=(0, math.radians(90), 0), material=dark_mat)
    ft2 = add_cylinder("Fuel_Tank_R", (0.75, -2.1, 0.8), radius=0.25, depth=0.8, rotation=(0, math.radians(90), 0), material=dark_mat)
    parts.extend([ft1, ft2])
    
    # Headlights
    hl_l = add_cylinder("Headlight_L", (-1.0, 2.1, 0.75), radius=0.12, depth=0.1, rotation=(math.radians(90), 0, 0), material=emissive_mat)
    hl_r = add_cylinder("Headlight_R", (1.0, 2.1, 0.75), radius=0.12, depth=0.1, rotation=(math.radians(90), 0, 0), material=emissive_mat)
    parts.extend([hl_l, hl_r])

    return parts

def build_tesla_coil(primary_mat, dark_mat, metal_mat, emissive_mat):
    parts = []
    # Concrete bunker pedestal
    base1 = add_cylinder("Base_Concrete", (0, 0, 0.4), radius=2.2, depth=0.8, vertices=8, material=dark_mat)
    base2 = add_cylinder("Base_Ring", (0, 0, 0.9), radius=1.6, depth=0.3, vertices=12, material=metal_mat)
    parts.extend([base1, base2])
    
    # Main Tower Column
    column = add_cylinder("Center_Spire", (0, 0, 2.5), radius=0.5, depth=3.0, vertices=16, material=primary_mat)
    parts.append(column)
    
    # 4 Quad Support Pylons
    for i in range(4):
        ang = i * (math.pi / 2)
        px = math.cos(ang) * 1.2
        py = math.sin(ang) * 1.2
        pylon = add_cylinder(f"Support_{i}", (px, py, 2.2), radius=0.12, depth=2.8, material=metal_mat)
        parts.append(pylon)
    
    # Tesla Coils (stacked glowing toruses)
    for i, z in enumerate([1.8, 2.6, 3.4, 4.2]):
        ring_r = 1.1 - (i * 0.12)
        coil = add_torus(f"Tesla_Ring_{i}", (0, 0, z), major_r=ring_r, minor_r=0.12, material=emissive_mat)
        parts.append(coil)
        
    # Top Capacitor Dome & Lightning Rod
    dome = add_sphere("Capacitor_Sphere", (0, 0, 4.8), radius=0.7, material=emissive_mat)
    rod = add_cylinder("Lightning_Spike", (0, 0, 5.7), radius=0.08, depth=1.2, material=metal_mat)
    parts.extend([dome, rod])
    
    return parts

def build_prism_tower(primary_mat, dark_mat, metal_mat, emissive_mat):
    parts = []
    # High-tech Allied crystalline base
    base = add_cylinder("Base_Pedestal", (0, 0, 0.5), radius=2.0, depth=1.0, vertices=6, material=primary_mat)
    accent = add_cylinder("Base_Trim", (0, 0, 1.1), radius=1.7, depth=0.2, vertices=6, material=metal_mat)
    parts.extend([base, accent])
    
    # Tapered tower shaft
    spire = add_cylinder("Prism_Spire", (0, 0, 2.8), radius=0.6, depth=3.4, vertices=6, material=dark_mat)
    parts.append(spire)
    
    # Floating focusing mirrors / rings
    ring1 = add_cylinder("Mirror_Ring_1", (0, 0, 3.5), radius=1.1, depth=0.15, vertices=6, material=primary_mat)
    ring2 = add_cylinder("Mirror_Ring_2", (0, 0, 4.4), radius=0.85, depth=0.15, vertices=6, material=primary_mat)
    parts.extend([ring1, ring2])
    
    # Diamond Focusing Prism (Octahedron)
    prism = add_cylinder("Prism_Crystal", (0, 0, 5.2), radius=0.65, depth=1.2, vertices=4, material=emissive_mat)
    prism.rotation_euler = (0, 0, math.radians(45))
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    parts.append(prism)
    
    # Focusing emitter needles
    for i in range(3):
        ang = i * (2 * math.pi / 3)
        nx = math.cos(ang) * 0.9
        ny = math.sin(ang) * 0.9
        needle = add_cylinder(f"Emitter_{i}", (nx, ny, 4.9), radius=0.06, depth=0.8, material=metal_mat)
        parts.append(needle)
        
    return parts

def build_harvester(faction, primary_mat, dark_mat, metal_mat, ore_mat):
    parts = []
    # Chassis
    chassis = add_box("Chassis", (0, 0, 0.75), (1.6, 2.4, 0.4), dark_mat)
    parts.append(chassis)
    
    # Heavy Tracks
    t1 = add_box("Tread_L", (-1.7, 0, 0.6), (0.45, 2.6, 0.6), dark_mat)
    t2 = add_box("Tread_R", (1.7, 0, 0.6), (0.45, 2.6, 0.6), dark_mat)
    parts.extend([t1, t2])
    
    # Driver Cab (Front-Left)
    cab = add_box("Cab", (-0.7, 1.4, 1.5), (0.7, 0.8, 0.65), primary_mat)
    windshield = add_box("Glass", (-0.7, 1.85, 1.6), (0.6, 0.1, 0.35), dark_mat)
    parts.extend([cab, windshield])
    
    # Large Ore Hopper Bay (Rear)
    hopper = add_box("Ore_Container", (0, -0.6, 1.45), (1.4, 1.5, 0.8), primary_mat)
    parts.append(hopper)
    
    # Glowing Tiberium/Ore Crystals in hopper
    for i, (ox, oy, oz) in enumerate([(-0.4, -0.5, 2.0), (0.3, -0.8, 2.05), (0.0, -0.3, 2.1), (0.4, -0.4, 1.95)]):
        ore = add_cylinder(f"Ore_Chunk_{i}", (ox, oy, oz), radius=0.25, depth=0.5, vertices=5, material=ore_mat)
        ore.rotation_euler = (math.radians(15 * (i % 3)), math.radians(20 * (i % 2)), math.radians(45 * i))
        parts.append(ore)
        
    # Front Gathering Rotary Arms / Drills
    scoop_l = add_cylinder("Drill_L", (-1.0, 2.5, 0.6), radius=0.45, depth=0.8, rotation=(0, math.radians(90), 0), material=metal_mat)
    scoop_r = add_cylinder("Drill_R", (1.0, 2.5, 0.6), radius=0.45, depth=0.8, rotation=(0, math.radians(90), 0), material=metal_mat)
    parts.extend([scoop_l, scoop_r])
    
    return parts

def build_drone(primary_mat, dark_mat, metal_mat, emissive_mat):
    parts = []
    # Central fuselage
    fuselage = add_box("Fuselage", (0, 0, 0.4), (0.5, 1.8, 0.3), primary_mat)
    parts.append(fuselage)
    
    # Swept Delta Wings
    wing_l = add_box("Wing_L", (-1.4, -0.3, 0.4), (1.5, 0.9, 0.06), primary_mat)
    wing_r = add_box("Wing_R", (1.4, -0.3, 0.4), (1.5, 0.9, 0.06), primary_mat)
    parts.extend([wing_l, wing_r])
    
    # Winglets
    wlet_l = add_box("Winglet_L", (-2.8, -0.4, 0.65), (0.06, 0.5, 0.35), dark_mat)
    wlet_r = add_box("Winglet_R", (2.8, -0.4, 0.65), (0.06, 0.5, 0.35), dark_mat)
    parts.extend([wlet_l, wlet_r])
    
    # Twin Jet Nacelles / Engines
    eng_l = add_cylinder("Engine_L", (-0.75, -0.8, 0.4), radius=0.22, depth=1.6, rotation=(math.radians(90), 0, 0), material=metal_mat)
    eng_r = add_cylinder("Engine_R", (0.75, -0.8, 0.4), radius=0.22, depth=1.6, rotation=(math.radians(90), 0, 0), material=metal_mat)
    
    # Afterburner Glow
    glow_l = add_cylinder("Afterburner_L", (-0.75, -1.65, 0.4), radius=0.18, depth=0.1, rotation=(math.radians(90), 0, 0), material=emissive_mat)
    glow_r = add_cylinder("Afterburner_R", (0.75, -1.65, 0.4), radius=0.18, depth=0.1, rotation=(math.radians(90), 0, 0), material=emissive_mat)
    parts.extend([eng_l, eng_r, glow_l, glow_r])
    
    # Sensor dome underneath
    sensor = add_sphere("Camera_Gimbal", (0, 1.1, 0.2), radius=0.22, material=dark_mat)
    parts.append(sensor)
    
    return parts

def build_bunker(primary_mat, dark_mat, metal_mat, emissive_mat):
    parts = []
    # Octagonal reinforced bunker base
    bunker_body = add_cylinder("Bunker_Body", (0, 0, 0.9), radius=2.4, depth=1.8, vertices=8, material=primary_mat)
    bunker_roof = add_cylinder("Bunker_Roof", (0, 0, 1.9), radius=2.1, depth=0.4, vertices=8, material=dark_mat)
    parts.extend([bunker_body, bunker_roof])
    
    # Heavy Blast Doors
    door = add_box("Blast_Door", (0, 2.1, 0.7), (0.7, 0.15, 0.9), material=metal_mat)
    parts.append(door)
    
    # Gun embrasures / slits with dual machine gun barrels
    slits = [(-1.5, 1.2), (1.5, 1.2), (-1.8, -0.8), (1.8, -0.8)]
    for i, (sx, sy) in enumerate(slits):
        angle = math.atan2(sy, sx)
        embr = add_box(f"Embr_Armor_{i}", (sx, sy, 1.1), (0.35, 0.35, 0.25), dark_mat)
        gun = add_cylinder(f"Gun_Barrel_{i}", (sx * 1.2, sy * 1.2, 1.1), radius=0.06, depth=0.8, rotation=(math.radians(90), 0, angle), material=metal_mat)
        parts.extend([embr, gun])
        
    # Top rotating radar / comms dish
    mount = add_cylinder("Radar_Pedestal", (0, 0, 2.3), radius=0.3, depth=0.4, material=metal_mat)
    dish = add_cylinder("Radar_Dish", (0, 0, 2.7), radius=0.7, depth=0.15, material=primary_mat)
    dish.rotation_euler = (math.radians(30), 0, 0)
    parts.extend([mount, dish])
    
    return parts

def join_all_objects(parts, root_name="Model"):
    bpy.ops.object.select_all(action='DESELECT')
    valid_parts = [p for p in parts if p and p.name in bpy.data.objects]
    for p in valid_parts:
        p.select_set(True)
    if valid_parts:
        bpy.context.view_layer.objects.active = valid_parts[0]
        bpy.ops.object.join()
        combined = bpy.context.active_object
        combined.name = root_name
        return combined
    return None

def main():
    # Pass arguments after --
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    else:
        argv = []
        
    parser = argparse.ArgumentParser(description="RA2 Procedural 3D Model Generator")
    parser.add_argument("--type", default="tank", choices=["tank", "tesla_coil", "prism_tower", "harvester", "drone", "bunker"])
    parser.add_argument("--faction", default="soviet", choices=["soviet", "allies"])
    parser.add_argument("--color", default="")
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    
    args.output = os.path.abspath(args.output)
    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    
    clean_scene()
    
    # Palette configuration
    if args.color:
        team_rgb = hex_to_rgb(args.color)
    elif args.faction == "soviet":
        team_rgb = (0.82, 0.15, 0.12) # Soviet Red
    else:
        team_rgb = (0.12, 0.42, 0.88) # Allied Blue
        
    mat_primary = make_material("Primary_Faction", team_rgb, metallic=0.75, roughness=0.32)
    mat_dark = make_material("Dark_Armor", (0.18, 0.20, 0.22), metallic=0.6, roughness=0.6)
    mat_metal = make_material("Industrial_Steel", (0.65, 0.67, 0.70), metallic=0.9, roughness=0.25)
    
    # Emissive colors
    if args.type == "prism_tower":
        emiss_color = (0.2, 0.8, 1.0) # Prism Cyan
    elif args.type == "tesla_coil":
        emiss_color = (0.3, 0.6, 1.0) if args.faction == "allies" else (1.0, 0.85, 0.2) # High energy electric yellow/blue
    elif args.type == "harvester":
        emiss_color = (0.1, 0.95, 0.3) # Tiberium/ore green
    else:
        emiss_color = (1.0, 0.9, 0.6) # Standard halogen/sensor
        
    mat_emissive = make_material("Emissive_Core", emiss_color, metallic=0.1, roughness=0.1, emission_color=emiss_color, emission_strength=4.0)
    
    # Build chosen model
    model_type = args.type.lower()
    if model_type == "tank":
        parts = build_tank(args.faction, mat_primary, mat_dark, mat_metal, mat_emissive)
    elif model_type == "tesla_coil":
        parts = build_tesla_coil(mat_primary, mat_dark, mat_metal, mat_emissive)
    elif model_type == "prism_tower":
        parts = build_prism_tower(mat_primary, mat_dark, mat_metal, mat_emissive)
    elif model_type == "harvester":
        parts = build_harvester(args.faction, mat_primary, mat_dark, mat_metal, mat_emissive)
    elif model_type == "drone":
        parts = build_drone(mat_primary, mat_dark, mat_metal, mat_emissive)
    elif model_type == "bunker":
        parts = build_bunker(mat_primary, mat_dark, mat_metal, mat_emissive)
    else:
        parts = build_tank(args.faction, mat_primary, mat_dark, mat_metal, mat_emissive)
        
    combined = join_all_objects(parts, f"{args.faction.capitalize()}_{args.type.capitalize()}")
    
    # Export to GLB
    print(f"Exporting procedural model to {args.output}...")
    bpy.ops.export_scene.gltf(
        filepath=args.output,
        export_format='GLB',
        export_apply=True,
        export_yup=True,
        export_materials='EXPORT'
    )
    
    poly_count = len(combined.data.polygons) if combined else 0
    vertex_count = len(combined.data.vertices) if combined else 0
    print(f"GENERATE_SUCCESS: Polys={poly_count}, Verts={vertex_count}, File={args.output}")

if __name__ == "__main__":
    main()
