#!/bin/bash
# Blender 5.2.2 (LTS) - GD2: rebuild the Sinai building kit (desert town + resort) from its script.
#
#   tools/blender/sinai/make.sh [all|plaster|kit|preview|pack]        (from web/; default all)
#
#   plaster  the tileable rendered-plaster texture (numpy)                    -> build/sinai/plaster-*.png
#   kit      cards + pieces, high / low poly, atlas UVs, Cycles bakes, GLB      -> build/sinai/atlas-*.png, sinai-kit-raw.glb, .json
#   preview  a contact sheet of the high poly models (no bake)                  -> build/sinai/preview-hi.png
#   pack     pack.mjs: meshopt GLB + WebP maps                                  -> public/models/sinai/
#   all      plaster + kit + pack
#
# Blender runs niced, one process at a time; the kit bake takes ~20-40 min on 3 shared CPU cores.
set -eo pipefail
cd "$(dirname "$0")/../../.."
BLENDER=${BLENDER:-/opt/blender/blender}
step=${1:-all}
mkdir -p tools/blender/build/sinai
run() {
  local lg="tools/blender/build/sinai/$1.log"
  nice -n 15 "$BLENDER" -b --factory-startup -P tools/blender/sinai/sinai_kit.py -- "$1" > "$lg" 2>&1 || {
    tail -30 "$lg"
    exit 1
  }
  grep "^\[sinai\]" "$lg" | grep -v unwrap | tail -8
}
if [ "$step" = all ] || [ "$step" = plaster ]; then run plaster; fi
if [ "$step" = all ] || [ "$step" = kit ]; then run kit; fi
if [ "$step" = preview ]; then run preview; fi
if [ "$step" = all ] || [ "$step" = pack ]; then node tools/blender/sinai/pack.mjs; fi
