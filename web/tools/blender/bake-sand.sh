#!/bin/sh
# Blender 5.2.2 - rebuild the desert's sand ground layers (GD1): public/tex/terrain/{512,1024}/{dsand,dreg}_{a,n}.webp
# and src/render/sandset.ts.
#   sh tools/blender/bake-sand.sh            (from web/; ~10 min of CPU)
# Needs /opt/blender/blender (or $BLENDER) and ImageMagick `convert` (PNG -> WebP).
set -e
cd "$(dirname "$0")/../.."
BLENDER=${BLENDER:-/opt/blender/blender}
TMP=$(mktemp -d)
"$BLENDER" -b --factory-startup -P tools/blender/sand.py -- "$TMP" 2048 | grep -E "pebbles|pass |mean|done|Error|OK_DONE"
node tools/blender/sand-pack.mjs "$TMP"
echo "bake folder (previews): $TMP"
