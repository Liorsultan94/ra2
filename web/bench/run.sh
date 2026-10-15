#!/bin/bash
# usage: run.sh <tag> [maps] [srcdir]  -> one niced vitest per map, results in scratchpad/bal/<tag>-<map>.txt
# env passes through (FULL, GRACE, SEEDS, MSEEDS, PAIRS, MIRRORS, CAP)
D=${BAL_OUT:-$(dirname "$0")/results}
SRC=${3:-$(cd "$(dirname "$0")/.." && pwd)}
cd "$SRC" || exit 1
TAG=$1
MAPLIST=${2:-frontline,desert,winter,urban}
for m in ${MAPLIST//,/ }; do
  rm -f $D/$TAG-$m.txt
  BENCH=1 MAPS=$m OUT=$D/$TAG-$m.txt nice -n 10 timeout 7000 npx vitest run bench/bal-bench.test.ts --silent=false > $D/$TAG-$m.log 2>&1 &
done
wait
echo done $TAG
