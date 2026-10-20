#!/bin/bash
# Blender 5.2.2 (LTS) - NV1: rebuild the naval kit (Shipyard + every nation's boats) from its script.
#
#   tools/blender/naval/make.sh [all|kit|sheet|cameos|pack]        (from web/; default all)
#
#   kit     models, AO bake, LODs, tiled hall maps          -> tools/blender/build/naval/naval-raw.glb, naval.json, *.png
#   sheet   the contact sheet (Cycles)                       -> tools/blender/build/naval/naval-sheet.png
#   cameos  the build-menu pictures (Cycles, on the water)   -> tools/blender/build/naval/cameo-*.png
#   pack    pack.mjs: meshopt GLB, WebP maps and cameos      -> public/models/naval/, public/ui/cameos/
#
# Blender runs niced, one process at a time (the kit takes a few minutes on 3 shared CPU cores).
set -eo pipefail
cd "$(dirname "$0")/../../.."
BLENDER=${BLENDER:-/opt/blender/blender}
step=${1:-all}
OUT=tools/blender/build/naval
mkdir -p $OUT
run() {
  local lg="$OUT/$1.log"
  nice -n 15 "$BLENDER" -b --factory-startup -P tools/blender/naval/navalkit.py -- "$OUT" "$1" > "$lg" 2>&1 || {
    tail -30 "$lg"
    exit 1
  }
  grep "^\[naval\]" "$lg" | tail -40
}
if [ "$step" = all ] || [ "$step" = kit ]; then run kit; fi
if [ "$step" = all ] || [ "$step" = sheet ]; then run sheet; fi
if [ "$step" = all ] || [ "$step" = cameos ]; then run cameos; fi
if [ "$step" = all ] || [ "$step" = pack ]; then node tools/blender/naval/pack.mjs; fi
