#!/bin/bash
# Blender 5.2.2 (LTS) - Iron Front asset pipeline (reproducible end to end):
#   1. export-procedural.ts : dump the game's procedural models (geometry, pivots, anchors) -> build/*-proc.glb
#   2. <asset>.py (Blender)  : high poly + game low poly + LODs, bakes, numpy texture composite, studio renders
#   3. pack.mjs              : weld + quantise + meshopt the GLB, encode the maps to WebP -> public/models/blender/
#
# usage (from web/):  tools/blender/make.sh [merkava|factory|all] [export|blender|pack|full]
# Needs /opt/blender/blender (or $BLENDER), node + the web devDependencies, ImageMagick `convert` with WebP.
# Blender runs niced, one process at a time.
set -e
cd "$(dirname "$0")/../.."
BLENDER=${BLENDER:-/opt/blender/blender}
what=${1:-all}
step=${2:-full}
if [ "$step" = full ] || [ "$step" = export ]; then
  npx vitest run --config tools/blender/vitest.config.ts
fi
for a in merkava factory; do
  [ "$what" = all ] || [ "$what" = "$a" ] || continue
  if [ "$step" = full ] || [ "$step" = blender ]; then
    nice -n 10 "$BLENDER" -b --factory-startup -P "tools/blender/$a.py" -- all 2>&1 | tee "tools/blender/build/$a-blender.log" | grep -E "^\[|Error|Traceback|OK_DONE" || true
    grep -q OK_DONE "tools/blender/build/$a-blender.log"
  fi
  if [ "$step" = full ] || [ "$step" = pack ]; then
    node tools/blender/pack.mjs "$a"
  fi
done
