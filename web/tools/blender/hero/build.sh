#!/bin/sh
# Iron Front - BI2 hero soldier (Blender 5.2.2 LTS): full reproducible build of the studio renders.
#   sh web/tools/blender/hero/build.sh [--res 1600] [--samples 128]
# 1. downloads the CC0 Blender Studio "Human Base Meshes" bundle (v1.4.1) if missing,
# 2. stage 1: body + cloth-simulated uniform (~1.5 min), 3. stage 2: kit, gear, materials (A-pose),
# 4. stage 2b: arm rig, Tavor at low ready in both hands, cloth relax of the posed shirt (~2 min),
# 5. stage 3: Cycles studio renders (front, 3/4, back 3/4, bust) as render-<view>-v2.png, 6. comparisons.
# Env: HERO_WORK (scratch, default /tmp/claude-0/BI2/work), HERO_BODY_BLEND (bundle .blend path).
set -e
D=$(cd "$(dirname "$0")" && pwd)
B=${BLENDER:-/opt/blender/blender}
DL=/tmp/claude-0/BI2/dl
OUT=${HERO_OUT:-/tmp/claude-0/BI2}
if [ -z "$HERO_BODY_BLEND" ] && [ ! -f $DL/human-base-meshes-bundle-v1.4.1/human_base_meshes_bundle.blend ]; then
  mkdir -p $DL
  curl -sS -o $DL/hbm.zip https://download.blender.org/demo/asset-bundles/human-base-meshes/human-base-meshes-bundle-v1.4.1.zip
  (cd $DL && unzip -q -o hbm.zip)
fi
nice -n 19 $B -b --factory-startup -P "$D/stage1_body_cloth.py"
nice -n 19 $B -b --factory-startup -P "$D/stage2_gear.py"
nice -n 19 $B -b --factory-startup -P "$D/stage2b_pose.py"
nice -n 19 $B -b --factory-startup -P "$D/stage3_render.py" -- --out "$OUT" "$@"
sh "$D/make_cmp.sh" "$OUT"
