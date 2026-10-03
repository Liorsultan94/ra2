#!/bin/bash
# Packs three CC0 ambientCG masks into public/tex/units/grunge.webp (R streaks, G smudges, B specks),
# the weathering detail sampled by the baked vehicle materials (src/render/models/wear.ts).
# Needs curl, unzip and ImageMagick 6+ with WebP. Usage: tools/bake-units-grunge.sh
set -e
OUT="$(cd "$(dirname "$0")/.." && pwd)/public/tex/units/grunge.webp"
T=$(mktemp -d)
cd "$T"
for a in Leaking001 Smear008 SurfaceImperfections013; do
  curl -sSL -o $a.zip "https://ambientcg.com/get?file=${a}_1K-JPG.zip"
  unzip -o -q $a.zip -d $a
done
convert Leaking001/Leaking001_1K-JPG_Opacity.jpg -colorspace Gray -resize 512x256! -normalize r1.png
convert r1.png r1.png -append r.png
convert Smear008/Smear008_1K-JPG_Displacement.jpg -colorspace Gray -resize 512x512! -normalize g.png
convert SurfaceImperfections013/SurfaceImperfections013_1K-JPG_Opacity.jpg -colorspace Gray -resize 512x512! -normalize b.png
convert r.png g.png b.png -set colorspace sRGB -combine -quality 88 "$OUT"
rm -rf "$T"
echo "wrote $OUT"
