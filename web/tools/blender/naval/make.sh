#!/bin/bash
# Blender 5.2.2 (LTS) - NV1: rebuild the naval kit (Shipyard + every nation's boats) from its script.
#
#   tools/blender/naval/make.sh [all|kit|sheet|cameos|carrier|pack]  (from web/; default all)
#
#   kit     models, AO bake, LODs, tiled hall maps          -> tools/blender/build/naval/naval-raw.glb, naval.json, *.png
#   sheet   the contact sheet (Cycles)                       -> tools/blender/build/naval/naval-sheet.png
#   cameos  the build-menu pictures (Cycles, on the water)   -> tools/blender/build/naval/cameo-*.png
#   carrier NV2: carrierkit.py, the aircraft carriers and their deck jets (kit, contact sheet, cameos; after `kit`:
#           it adds to naval.json)                     -> naval-cv<nation>-raw.glb, carrier-sheet.png, cameo-*.png
#   diver   NV3: diverkit.py, the Combat Diver (kit, contact sheet, cameo; after `kit`) -> naval-diver-raw.glb, diver-sheet.png, cameo-diver.png
#   sub     NV4: subkit.py, the submarines (kit, contact sheet, cameos; after `kit`) -> naval-sub-raw.glb, sub-sheet.png, cameo-sub_*.png
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
if [ "$step" = all ] || [ "$step" = carrier ]; then
  for s in kit sheet cameos; do
    nice -n 15 "$BLENDER" -b --factory-startup -P tools/blender/naval/carrierkit.py -- "$OUT" "$s" > "$OUT/carrier-$s.log" 2>&1 || {
      tail -30 "$OUT/carrier-$s.log"
      exit 1
    }
    grep "^\[carrier\]" "$OUT/carrier-$s.log" | tail -20
  done
fi
if [ "$step" = all ] || [ "$step" = diver ]; then
  for s in kit sheet cameos; do
    nice -n 15 "$BLENDER" -b --factory-startup -P tools/blender/naval/diverkit.py -- "$OUT" "$s" > "$OUT/diver-$s.log" 2>&1 || {
      tail -30 "$OUT/diver-$s.log"
      exit 1
    }
    grep "^\[diver\]" "$OUT/diver-$s.log" | tail -20
  done
fi
if [ "$step" = all ] || [ "$step" = sub ]; then
  for s in kit sheet cameos; do
    nice -n 15 "$BLENDER" -b --factory-startup -P tools/blender/naval/subkit.py -- "$OUT" "$s" > "$OUT/sub-$s.log" 2>&1 || {
      tail -30 "$OUT/sub-$s.log"
      exit 1
    }
    grep "^\[sub\]" "$OUT/sub-$s.log" | tail -20
  done
fi
if [ "$step" = all ] || [ "$step" = pack ]; then node tools/blender/naval/pack.mjs; fi
