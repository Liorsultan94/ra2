#!/bin/sh
# Blender 5.2.2 - rebuild web/public/tex/crystals/ (resource crystals and gold ore, src/render/resources.ts).
#   sh tools/blender/bake-crystals.sh [render.png]
# Needs /opt/blender/blender (or $BLENDER) and ImageMagick `convert` (PNG -> WebP).
set -e
cd "$(dirname "$0")/../.."
BLENDER=${BLENDER:-/opt/blender/blender}
TMP=$(mktemp -d)
"$BLENDER" -b --factory-startup -P tools/blender/crystals.py -- "$TMP" "${1:-}" "$TMP/crystals.blend" | grep -E "TRIS|OK_DONE|Error"
OUT=public/tex/crystals
mkdir -p "$OUT"
cp "$TMP/crystals.glb" "$OUT/crystals.glb"
convert "$TMP/crystals_n.png" -define webp:lossless=false -quality 92 -define webp:method=6 "$OUT/crystals_n.webp"
convert "$TMP/crystals_m.png" -define webp:lossless=false -quality 90 -define webp:method=6 "$OUT/crystals_m.webp"
ls -l "$OUT"
echo "blend file: $TMP/crystals.blend"
