#!/bin/sh
# Blender 5.2.2 - rebuild the desert's rock set (GD4): public/tex/terrain/{512,1024}/{dgranite,dsandst}_{a,n}.webp,
# public/tex/rocks/rockkit.glb and src/render/rockset.ts.
#   sh tools/blender/bake-rocks.sh            (from web/; ~20 min of CPU)
# Needs /opt/blender/blender (or $BLENDER) and ImageMagick `convert` (PNG -> WebP).
set -e
cd "$(dirname "$0")/../.."
BLENDER=${BLENDER:-/opt/blender/blender}
TMP=$(mktemp -d)
"$BLENDER" -b --factory-startup -P tools/blender/rockface.py -- "$TMP" 2048 | grep -E "range|pass |mean|done|Error|OK_DONE"
"$BLENDER" -b --factory-startup -P tools/blender/rockkit.py -- "$TMP" 1 | grep -E "TRIS|Error|OK_DONE"
node tools/blender/rocks-pack.mjs "$TMP"
echo "bake folder (previews): $TMP"
