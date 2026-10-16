#!/bin/sh
# Blender 5.2.2 - rebuild the burnt-out vehicle hulks (CF1): public/models/hulks.glb and src/render/hulkset.ts.
#   sh tools/blender/bake-hulks.sh            (from web/; about a minute of CPU plus the contact sheet render)
# Needs /opt/blender/blender (or $BLENDER).
set -e
cd "$(dirname "$0")/../.."
BLENDER=${BLENDER:-/opt/blender/blender}
TMP=$(mktemp -d)
nice -n 10 "$BLENDER" -b --factory-startup -P tools/blender/hulkkit.py -- "$TMP" 1 | grep -E "TRIS|Error|OK_DONE"
node tools/blender/hulks-pack.mjs "$TMP"
echo "bake folder (contact sheet hulks_preview.png): $TMP"
