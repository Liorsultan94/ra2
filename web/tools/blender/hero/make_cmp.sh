#!/bin/sh
# Iron Front - BI2 hero soldier: side-by-side of the reference images and the studio renders.
#   sh web/tools/blender/hero/make_cmp.sh [render dir] [refs dir]
# Writes <render dir>/cmp-refs<V>.png (top row: references, bottom row: our renders) and, when the v1
# renders (render-<view>.png) exist, cmp-v1-v2.png (top: v1, bottom: v2). Needs ImageMagick.
#   sh make_cmp.sh [render dir] [refs dir] [suffix, default -v2]
R=${1:-/tmp/claude-0/BI2}
F=${2:-/tmp/claude-0/BI2/refs}
V=${3:--v2}
H=720
lab() { convert "$1" -resize x$H -gravity north -background '#202020' -fill white -pointsize 24 -splice 0x34 -annotate +0+4 "$2" "$3"; }
T=$(mktemp -d)
lab "$F/ref1-closeup.webp" 'ref 1 (AAA bust)' $T/a1.png
lab "$F/ref2-turnaround.jpg" 'ref 2 (AAA turnaround)' $T/a2.png
lab "$F/ref3-front.jpg" 'ref 3 (AAA front)' $T/a3.png
lab "$F/owner-idf-soldier.jpg" 'owner: IDF soldier' $T/a4.png
lab "$R/render-bust$V.png" "ours$V: bust" $T/b1.png
lab "$R/render-q34$V.png" "ours$V: 3/4" $T/b2.png
lab "$R/render-front$V.png" "ours$V: front" $T/b3.png
lab "$R/render-back$V.png" "ours$V: back 3/4" $T/b4.png
convert $T/a1.png $T/a2.png $T/a3.png $T/a4.png +append $T/top.png
convert $T/b1.png $T/b2.png $T/b3.png $T/b4.png +append $T/bot.png
convert $T/top.png $T/bot.png -background '#202020' -gravity west -append "$R/cmp-refs$V.png"
echo "$R/cmp-refs$V.png"
if [ -n "$V" ] && [ -f "$R/render-front.png" ]; then
  i=0
  for v in bust q34 front back; do
    i=$((i+1))
    lab "$R/render-$v.png" "v1: $v" $T/c$i.png
    lab "$R/render-$v$V.png" "v2: $v" $T/d$i.png
  done
  convert $T/c1.png $T/c2.png $T/c3.png $T/c4.png +append $T/v1.png
  convert $T/d1.png $T/d2.png $T/d3.png $T/d4.png +append $T/v2.png
  convert $T/v1.png $T/v2.png -append "$R/cmp-v1-v2.png"
  echo "$R/cmp-v1-v2.png"
fi
rm -rf $T
