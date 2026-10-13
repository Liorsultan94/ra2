#!/bin/bash
# Blender 5.2.2 (LTS) - Iron Front: re-export the BI2 hero IDF soldier as the game's Israeli rifleman skin.
# One command, after any change to the hero model scripts (tools/blender/hero/):
#
#   tools/blender/hero-game/make.sh [full|hero|convert|pack]        (from web/; default full)
#
#   hero     rebuild the hero blends from the hero scripts (stages 1, 2, 2b of tools/blender/hero/build.sh,
#            no studio renders) into $HERO_WORK
#   convert  export-procedural.ts (the game skeleton at rest) + hero_game.py prep / lods / bake / render:
#            per-bone play mesh (game LOD0) + hero (close-up) mesh, bakes, composite, raw GLBs
#   pack     pack.mjs: LOD1 / LOD2, meshopt, WebP -> public/models/blender/idf-rifleman{,-hero}*
#   full     all three
#
# Env: HERO_SRC (hero scripts dir) or HERO_REF (git ref holding web/tools/blender/hero/), HERO_WORK (scratch for the hero blends, default
# tools/blender/build/hero-work), HERO_BODY_BLEND (the CC0 Human Base Meshes bundle .blend; downloaded into
# tools/blender/build/dl when missing), BLENDER (default /opt/blender/blender).
# Needs node + the web devDependencies and ImageMagick `convert` with WebP. Blender runs niced, one process
# at a time; the whole chain takes ~1 h on 4 shared CPU cores (run it detached: nohup ... &).
set -eo pipefail
cd "$(dirname "$0")/../../.."
WEB=$(pwd)
BLENDER=${BLENDER:-/opt/blender/blender}
step=${1:-full}
# hero scripts: tools/blender/hero/ once the BI2 hero is merged; until then (or with HERO_REF=<git ref>) a
# read-only copy of tools/blender/hero/ from that ref (default origin/wip/bi2-hero-soldier, fetched first)
if [ -z "$HERO_SRC" ]; then
  if [ -z "$HERO_REF" ] && [ -f tools/blender/hero/stage2b_pose.py ]; then
    HERO_SRC=$WEB/tools/blender/hero
  else
    ref=${HERO_REF:-origin/wip/bi2-hero-soldier}
    git fetch -q origin 2>/dev/null || true
    rm -rf tools/blender/build/hero-src && mkdir -p tools/blender/build/hero-src
    git archive "$ref" tools/blender/hero | tar -x -C tools/blender/build/hero-src --strip-components=3
    HERO_SRC=$WEB/tools/blender/build/hero-src
    echo "[make] hero scripts from $ref ($(git rev-parse --short "$ref"))"
  fi
fi
export HERO_SRC
export HERO_WORK=${HERO_WORK:-$WEB/tools/blender/build/hero-work}
mkdir -p tools/blender/build "$HERO_WORK"
# run <script.py> <log tag> [script args]
run() {
  local py=$1 tag=$2
  shift 2
  local lg="tools/blender/build/$(basename "$py" .py)-$tag.log"
  nice -n 15 "$BLENDER" -b --factory-startup -P "$py" -- "$@" > "$lg" 2>&1 || {
    tail -30 "$lg"
    exit 1
  }
}
if [ "$step" = full ] || [ "$step" = hero ]; then
  if [ ! -f "$HERO_SRC/stage2b_pose.py" ]; then
    echo "hero scripts not found in $HERO_SRC (tools/blender/hero/ from the BI2 hero soldier); set HERO_SRC" >&2
    exit 1
  fi
  if [ -z "$HERO_BODY_BLEND" ]; then
    for f in /tmp/claude-0/BI2/dl/human-base-meshes-bundle-v1.4.1/human_base_meshes_bundle.blend tools/blender/build/dl/human-base-meshes-bundle-v1.4.1/human_base_meshes_bundle.blend; do
      [ -f "$f" ] && export HERO_BODY_BLEND=$(realpath "$f") && break
    done
  fi
  if [ -z "$HERO_BODY_BLEND" ]; then
    mkdir -p tools/blender/build/dl
    curl -sS -o tools/blender/build/dl/hbm.zip https://download.blender.org/demo/asset-bundles/human-base-meshes/human-base-meshes-bundle-v1.4.1.zip
    (cd tools/blender/build/dl && unzip -q -o hbm.zip)
    export HERO_BODY_BLEND=$WEB/tools/blender/build/dl/human-base-meshes-bundle-v1.4.1/human_base_meshes_bundle.blend
  fi
  for s in stage1_body_cloth stage2_gear stage2b_pose; do
    echo "[make] hero $s"
    run "$HERO_SRC/$s.py" hero
  done
fi
if [ "$step" = full ] || [ "$step" = convert ]; then
  echo "[make] export the game skeleton"
  npx vitest run --config tools/blender/vitest.config.ts > tools/blender/build/export-procedural.log 2>&1 || {
    tail -20 tools/blender/build/export-procedural.log
    exit 1
  }
  for st in prep lods bake render; do
    echo "[make] convert $st"
    run tools/blender/hero-game/hero_game.py "$st" "$st"
    grep "^\[hero-game" "tools/blender/build/hero_game-$st.log" | grep -v "stalled" | tail -4
  done
fi
if [ "$step" = full ] || [ "$step" = pack ]; then
  node tools/blender/pack.mjs idf-rifleman
  node tools/blender/pack.mjs idf-rifleman-hero
fi
