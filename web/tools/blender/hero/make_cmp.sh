#!/bin/sh
# Iron Front - BI2 hero soldier: side-by-side of the reference images and the studio renders.
#   sh web/tools/blender/hero/make_cmp.sh [render dir] [refs dir]
# Writes <render dir>/cmp-refs.png (top row: references, bottom row: our renders). Needs ImageMagick.
R=${1:-/tmp/claude-0/BI2}
F=${2:-/tmp/claude-0/BI2/refs}
H=720
lab() { convert "$1" -resize x$H -gravity north -background '#202020' -fill white -pointsize 24 -splice 0x34 -annotate +0+4 "$2" "$3"; }
T=$(mktemp -d)
lab "$F/ref1-closeup.webp" 'ref 1 (AAA bust)' $T/a1.png
lab "$F/ref2-turnaround.jpg" 'ref 2 (AAA turnaround)' $T/a2.png
lab "$F/ref3-front.jpg" 'ref 3 (AAA front)' $T/a3.png
lab "$F/owner-idf-soldier.jpg" 'owner: IDF soldier' $T/a4.png
lab "$R/render-bust.png" 'ours: bust' $T/b1.png
lab "$R/render-q34.png" 'ours: 3/4' $T/b2.png
lab "$R/render-front.png" 'ours: front' $T/b3.png
lab "$R/render-back.png" 'ours: back 3/4' $T/b4.png
convert $T/a1.png $T/a2.png $T/a3.png $T/a4.png +append $T/top.png
convert $T/b1.png $T/b2.png $T/b3.png $T/b4.png +append $T/bot.png
convert $T/top.png $T/bot.png -background '#202020' -gravity west -append "$R/cmp-refs.png"
rm -rf $T
echo "$R/cmp-refs.png"
