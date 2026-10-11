# Blender 5.2.2 LTS Server for RA2 / Iron Front

Server-side 3D microservice powered directly by **Blender 5.2.2 LTS** for automated model generation, format conversion & optimization, and background high-quality rendering (Cycles / Eevee).

---

## 🚀 Features

1. **Procedural 3D Model Generation (GLB)**
   - Headless generation of Red Alert tactical units & structures (Tanks, Tesla Coils, Prism Towers, Harvesters, Recon Drones, Bunkers).
   - Dynamic faction camo / team color palettes (Soviet Red, Allied Blue, custom hex).
   - High-performance PBR material assignment and direct `.glb` export.

2. **3D Model Converter & Decimator**
   - Headless conversion of `.obj`, `.fbx`, `.stl`, `.glb`, `.gltf` into web-optimized `.glb`.
   - Polygon decimation (LOD optimization) with custom reduction ratios.
   - Automatic pivot centering.

3. **Background Studio Renderer (Cycles & Eevee)**
   - Automated 3-point studio lighting + rim highlights.
   - Multiple camera perspectives: Classic RA2 Isometric (45°), Hero Low-Angle, Front Orthographic, Top-Down Tactical.
   - Transparent alpha background rendering to PNG.

4. **360° Turntable Sequence Generator**
   - Automated 360-degree rotation frame captures (8, 16, 24, 32 frames) for unit showcases or sprite generation.

5. **Interactive Web Dashboard**
   - Real-time Three.js 3D inspection viewport, live health badge, model converter, and turntable scrubber available at `http://localhost:4000`.

---

## ⚙️ Requirements & Configuration

- **Blender Version**: Strictly locked to **Blender 5.2.2 LTS**.
- Default Executable Path: `C:\Program Files\Blender Foundation\Blender 5.2\blender.exe`
- Environment Override (optional): `BLENDER_PATH`

---

## 📦 Quick Start

```powershell
cd services/blender-server
npm install
npm start
```

Access the Web Control Hub in your browser:
👉 **[http://localhost:4000](http://localhost:4000)**

---

## 📡 REST API Reference

### 1. Health Check
```bash
GET /api/health
```
Returns service status, executable verification, and confirms Blender `5.2.2 LTS`.

### 2. Generate 3D Model
```bash
POST /api/model/generate
Content-Type: application/json

{
  "type": "tank",         # "tank", "tesla_coil", "prism_tower", "harvester", "drone", "bunker"
  "faction": "soviet",    # "soviet" or "allies"
  "color": "#d32f2f"      # Optional hex color
}
```

### 3. Convert & Decimate Mesh
```bash
POST /api/model/convert
Content-Type: multipart/form-data

file: <binary 3d mesh>
decimate: 0.5            # 50% polygon count
center: true
```

### 4. Studio Background Render
```bash
POST /api/render/image
Content-Type: application/json

{
  "modelUrl": "/output/models/soviet_tank.glb",
  "engine": "BLENDER_EEVEE",   # "BLENDER_EEVEE" or "CYCLES"
  "angle": "isometric",       # "isometric", "hero", "front", "top"
  "width": 800,
  "height": 800,
  "samples": 32
}
```

### 5. 360° Turntable Sequence
```bash
POST /api/render/turntable
Content-Type: application/json

{
  "modelUrl": "/output/models/soviet_tank.glb",
  "engine": "BLENDER_EEVEE",
  "frames": 16,
  "angle": "hero"
}
```
