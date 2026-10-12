#!/bin/bash
# Blender 5.2.2 (LTS) - Iron Front asset pipeline (reproducible end to end):
#   1. export-procedural.ts : dump the game's procedural model (per-bone geometry, frames, poses) -> build/*-proc.glb/.json
#   2. <script>.py (Blender) : high poly + game low poly, bakes, numpy texture composite, studio renders
#   3. pack.mjs              : weld + quantise + meshopt the GLB with LOD1 / LOD2, encode the maps to WebP
#                              (512 px + 256 px phone variants) -> public/models/blender/
#
# usage (from web/):  tools/blender/make.sh [soldier|all] [export|blender|composite|pack|full]
#   composite: re-run only the texture composite + studio renders from the saved bakes (look tuning)
# Needs /opt/blender/blender (or $BLENDER), node + the web devDependencies, ImageMagick `convert` with WebP.
# Blender runs niced, one process at a time.
set -e
cd "$(dirname "$0")/../.."
BLENDER=${BLENDER:-/opt/blender/blender}
what=${1:-all}
step=${2:-full}
mkdir -p tools/blender/build
if [ "$step" = full ] || [ "$step" = export ]; then
  npx vitest run --config tools/blender/vitest.config.ts
fi
# script name -> packed asset id
for pair in soldier:idf-rifleman; do
  a=${pair%%:*}
  id=${pair##*:}
  [ "$what" = all ] || [ "$what" = "$a" ] || continue
  if [ "$step" = full ] || [ "$step" = blender ] || [ "$step" = composite ]; then
    stage=all
    [ "$step" = composite ] && stage=composite
    nice -n 10 "$BLENDER" -b --factory-startup -P "tools/blender/$a.py" -- $stage 2>&1 | tee "tools/blender/build/$a-blender.log" | grep -E "^\[|Error|Traceback|OK_DONE" || true
    grep -q OK_DONE "tools/blender/build/$a-blender.log"
  fi
  if [ "$step" = full ] || [ "$step" = pack ] || [ "$step" = composite ]; then
    node tools/blender/pack.mjs "$id"
  fi
done
