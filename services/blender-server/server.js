import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execFile, execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Explicitly lock to Blender 5.2.2 LTS as required
const BLENDER_PATH = process.env.BLENDER_PATH || 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';

const PORT = process.env.PORT || 4000;
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Output & Upload Directories
const DIRS = {
  models: path.join(__dirname, 'output', 'models'),
  renders: path.join(__dirname, 'output', 'renders'),
  turntables: path.join(__dirname, 'output', 'turntables'),
  uploads: path.join(__dirname, 'uploads'),
  scripts: path.join(__dirname, 'scripts'),
};

for (const dir of Object.values(DIRS)) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Static File Hosting
app.use('/output', express.static(path.join(__dirname, 'output')));
app.use(express.static(path.join(__dirname, 'public')));

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DIRS.uploads),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const unique = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    cb(null, `upload_${unique}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
  fileFilter: (req, file, cb) => {
    const allowed = ['.obj', '.fbx', '.stl', '.glb', '.gltf', '.dae'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported 3D file format: ${ext}. Supported: ${allowed.join(', ')}`));
    }
  }
});

// Verify Blender 5.2.2 on startup
let verifiedBlenderVersion = 'Unknown';
function verifyBlenderInstallation() {
  try {
    if (!fs.existsSync(BLENDER_PATH)) {
      throw new Error(`Blender executable not found at: ${BLENDER_PATH}`);
    }
    const versionOutput = execFileSync(BLENDER_PATH, ['--version'], { encoding: 'utf-8' });
    const firstLine = versionOutput.split('\n')[0].trim();
    verifiedBlenderVersion = firstLine;
    console.log(`====================================================`);
    console.log(`[Blender Server] Connected to: ${verifiedBlenderVersion}`);
    console.log(`[Blender Server] Path: ${BLENDER_PATH}`);
    console.log(`====================================================`);
    return true;
  } catch (err) {
    console.error(`[Blender Server Error] Could not verify Blender:`, err.message);
    return false;
  }
}
verifyBlenderInstallation();

// Helper to run Blender Python script asynchronously
function runBlenderScript(scriptName, scriptArgs = []) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(DIRS.scripts, scriptName);
    if (!fs.existsSync(scriptPath)) {
      return reject(new Error(`Blender script not found: ${scriptPath}`));
    }

    const args = ['-b', '-P', scriptPath, '--', ...scriptArgs];
    const startTime = Date.now();

    execFile(BLENDER_PATH, args, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const durationMs = Date.now() - startTime;
      if (error) {
        console.error(`[Blender Exec Error]:`, stderr || stdout);
        return reject(new Error(stderr || stdout || error.message));
      }
      if (stdout.includes('Traceback (most recent call last):') || stderr.includes('Traceback (most recent call last):')) {
        const errorMsg = (stderr + '\n' + stdout).match(/Traceback[\s\S]+/)?.[0] || 'Python execution error';
        console.error(`[Blender Python Error]:`, errorMsg);
        return reject(new Error(errorMsg));
      }
      resolve({ stdout, stderr, durationMs });
    });
  });
}

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// 1. Health check & Blender verification
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Blender 3D Microservice',
    blender: {
      version: verifiedBlenderVersion,
      path: BLENDER_PATH,
      installed: fs.existsSync(BLENDER_PATH),
      targetVersion: '5.2.2 LTS',
      isTargetVersion: verifiedBlenderVersion.includes('5.2.2')
    },
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// 2. Procedural 3D Model Generator (GLB)
app.post('/api/model/generate', async (req, res) => {
  try {
    const {
      type = 'tank',
      faction = 'soviet',
      color = '',
      detail = 'medium'
    } = req.body;

    const timestamp = Date.now();
    const filename = `${faction}_${type}_${timestamp}.glb`;
    const outputPath = path.join(DIRS.models, filename);

    const scriptArgs = [
      '--type', type,
      '--faction', faction,
      '--output', outputPath
    ];
    if (color) {
      scriptArgs.push('--color', color);
    }

    const { stdout, durationMs } = await runBlenderScript('generate_model.py', scriptArgs);

    // Parse stats
    let polyCount = 0;
    let vertexCount = 0;
    const match = stdout.match(/GENERATE_SUCCESS: Polys=(\d+), Verts=(\d+)/);
    if (match) {
      polyCount = parseInt(match[1], 10);
      vertexCount = parseInt(match[2], 10);
    }

    const stats = fs.statSync(outputPath);

    res.json({
      success: true,
      modelId: `${type}_${timestamp}`,
      type,
      faction,
      color: color || (faction === 'soviet' ? '#d32f2f' : '#1976d2'),
      polyCount,
      vertexCount,
      fileSizeKb: (stats.size / 1024).toFixed(1),
      glbUrl: `/output/models/${filename}`,
      durationMs,
      blenderVersion: verifiedBlenderVersion
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. 3D Model Conversion & Decimation Optimization
app.post('/api/model/convert', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No 3D file uploaded' });
    }

    const inputPath = req.file.path;
    const decimate = parseFloat(req.body.decimate || 1.0);
    const center = req.body.center !== 'false';

    const baseName = path.parse(req.file.originalname).name;
    const timestamp = Date.now();
    const outputFilename = `converted_${baseName}_${timestamp}.glb`;
    const outputPath = path.join(DIRS.models, outputFilename);

    const scriptArgs = [
      '--input', inputPath,
      '--output', outputPath,
      '--decimate', decimate.toString()
    ];
    if (center) {
      scriptArgs.push('--center');
    }

    const { stdout, durationMs } = await runBlenderScript('convert_model.py', scriptArgs);

    let statsParsed = { inPolys: 0, outPolys: 0, inVerts: 0, outVerts: 0 };
    const match = stdout.match(/CONVERT_SUCCESS: InPolys=(\d+), OutPolys=(\d+), InVerts=(\d+), OutVerts=(\d+)/);
    if (match) {
      statsParsed = {
        inPolys: parseInt(match[1], 10),
        outPolys: parseInt(match[2], 10),
        inVerts: parseInt(match[3], 10),
        outVerts: parseInt(match[4], 10)
      };
    }

    const stats = fs.statSync(outputPath);

    res.json({
      success: true,
      originalFilename: req.file.originalname,
      glbUrl: `/output/models/${outputFilename}`,
      fileSizeKb: (stats.size / 1024).toFixed(1),
      decimateRatio: decimate,
      stats: statsParsed,
      durationMs,
      blenderVersion: verifiedBlenderVersion
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Background Image Rendering (Cycles / Eevee)
app.post('/api/render/image', async (req, res) => {
  try {
    let {
      modelUrl = '',
      engine = 'BLENDER_EEVEE',
      samples = 32,
      width = 800,
      height = 800,
      angle = 'isometric'
    } = req.body;

    let inputPath = '';
    if (modelUrl) {
      // Resolve path
      const cleanPath = modelUrl.replace(/^\/output\//, '');
      inputPath = path.join(__dirname, 'output', cleanPath);
    } else {
      // Use fallback default tank if no model specified
      const files = fs.readdirSync(DIRS.models).filter(f => f.endsWith('.glb'));
      if (files.length > 0) {
        inputPath = path.join(DIRS.models, files[0]);
      } else {
        return res.status(400).json({ success: false, error: 'No model provided and no existing models found' });
      }
    }

    if (!fs.existsSync(inputPath)) {
      return res.status(404).json({ success: false, error: `Model file not found at: ${inputPath}` });
    }

    const timestamp = Date.now();
    const outputFilename = `render_${engine.toLowerCase()}_${timestamp}.png`;
    const outputPath = path.join(DIRS.renders, outputFilename);

    const scriptArgs = [
      '--input', inputPath,
      '--output', outputPath,
      '--engine', engine,
      '--samples', samples.toString(),
      '--width', width.toString(),
      '--height', height.toString(),
      '--angle', angle
    ];

    const { durationMs } = await runBlenderScript('render_scene.py', scriptArgs);

    const stats = fs.statSync(outputPath);

    res.json({
      success: true,
      renderUrl: `/output/renders/${outputFilename}`,
      engine,
      resolution: `${width}x${height}`,
      samples,
      angle,
      fileSizeKb: (stats.size / 1024).toFixed(1),
      durationMs,
      blenderVersion: verifiedBlenderVersion
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. 360 Turntable Sequence Rendering
app.post('/api/render/turntable', async (req, res) => {
  try {
    let {
      modelUrl = '',
      engine = 'BLENDER_EEVEE',
      samples = 16,
      width = 400,
      height = 400,
      angle = 'hero',
      frames = 16
    } = req.body;

    let inputPath = '';
    if (modelUrl) {
      const cleanPath = modelUrl.replace(/^\/output\//, '');
      inputPath = path.join(__dirname, 'output', cleanPath);
    } else {
      const files = fs.readdirSync(DIRS.models).filter(f => f.endsWith('.glb'));
      if (files.length > 0) {
        inputPath = path.join(DIRS.models, files[0]);
      } else {
        return res.status(400).json({ success: false, error: 'No model specified' });
      }
    }

    const timestamp = Date.now();
    const outputFilename = `turntable_${timestamp}.png`;
    const outputPath = path.join(DIRS.turntables, outputFilename);

    const scriptArgs = [
      '--input', inputPath,
      '--output', outputPath,
      '--engine', engine,
      '--samples', samples.toString(),
      '--width', width.toString(),
      '--height', height.toString(),
      '--angle', angle,
      '--turntable_frames', frames.toString()
    ];

    const { durationMs } = await runBlenderScript('render_scene.py', scriptArgs);

    const framesDirName = `turntable_${timestamp}_frames`;
    const framesFolder = path.join(DIRS.turntables, framesDirName);
    const frameFiles = fs.existsSync(framesFolder)
      ? fs.readdirSync(framesFolder).filter(f => f.endsWith('.png')).sort().map(f => `/output/turntables/${framesDirName}/${f}`)
      : [];

    res.json({
      success: true,
      previewUrl: `/output/turntables/${outputFilename}`,
      frames: frameFiles,
      frameCount: frameFiles.length,
      engine,
      durationMs,
      blenderVersion: verifiedBlenderVersion
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. List Generated Models
app.get('/api/models', (req, res) => {
  try {
    const files = fs.readdirSync(DIRS.models)
      .filter(f => f.endsWith('.glb'))
      .map(filename => {
        const filePath = path.join(DIRS.models, filename);
        const stats = fs.statSync(filePath);
        return {
          filename,
          url: `/output/models/${filename}`,
          sizeKb: (stats.size / 1024).toFixed(1),
          createdAt: stats.mtime
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json({ success: true, count: files.length, models: files });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. List Renders
app.get('/api/renders', (req, res) => {
  try {
    const files = fs.readdirSync(DIRS.renders)
      .filter(f => f.endsWith('.png') || f.endsWith('.jpg'))
      .map(filename => {
        const filePath = path.join(DIRS.renders, filename);
        const stats = fs.statSync(filePath);
        return {
          filename,
          url: `/output/renders/${filename}`,
          sizeKb: (stats.size / 1024).toFixed(1),
          createdAt: stats.mtime
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json({ success: true, count: files.length, renders: files });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[Blender Server] Running on http://localhost:${PORT}`);
});
