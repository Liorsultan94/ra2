#!/bin/bash
# Blender 5.2.2 (LTS) - GD3: rebuild the desert vegetation (palms, acacias, shrubs) from its script.
#
#   tools/blender/desertveg/make.sh [all|atlas|models|preview|pack]        (from web/; default all)
#
#   atlas    high poly cards and tiling barks rendered into the shared atlas  -> build/desertveg/atlas-*.png, cards.json
#   models   LOD0 / LOD1 / far impostor meshes (+ the impostor sprites)     -> build/desertveg/desert-veg-raw.glb, .json
#   preview  a lit contact sheet of the models                               -> build/desertveg/preview.png
#   pack     pack.mjs: meshopt GLB + WebP maps                                -> public/models/desertveg/
#   all      atlas + models + pack
#
# Blender runs niced, one process at a time (~5-10 min in all on 3 shared CPU cores).
set -eo pipefail
cd "$(dirname "$0")/../../.."
BLENDER=${BLENDER:-/opt/blender/blender}
step=${1:-all}
mkdir -p tools/blender/build/desertveg
run() {
  local lg="tools/blender/build/desertveg/$1.log"
  nice -n 15 "$BLENDER" -b --factory-startup -P tools/blender/desertveg/desert_veg.py -- "$1" > "$lg" 2>&1 || {
    tail -30 "$lg"
    exit 1
  }
  grep "^\[veg\]" "$lg" | tail -14
}
if [ "$step" = all ] || [ "$step" = atlas ]; then run atlas; fi
if [ "$step" = all ] || [ "$step" = models ]; then run models; fi
if [ "$step" = preview ]; then run preview; fi
if [ "$step" = all ] || [ "$step" = pack ]; then node tools/blender/desertveg/pack.mjs; fi
