#!/bin/bash
# usage: run.sh <tag> [maps] [srcdir]  -> one niced vitest per map, results in scratchpad/bal/<tag>-<map>.txt
# env passes through (FULL, GRACE, SEEDS, MSEEDS, PAIRS, MIRRORS, CAP)
D=/tmp/claude-0/-home-user-ra2/44ece053-d4d3-5128-ba4e-051cd1175fe3/scratchpad/bal
SRC=${3:-/home/user/ra2/.claude/worktrees/agent-aab059781cd4a4c33/web}
cd "$SRC" || exit 1
TAG=$1
MAPLIST=${2:-frontline,desert,winter,urban}
for m in ${MAPLIST//,/ }; do
  rm -f $D/$TAG-$m.txt
  MAPS=$m OUT=$D/$TAG-$m.txt nice -n 10 timeout 7000 npx vitest run bench/bal-bench.test.ts --silent=false > $D/$TAG-$m.log 2>&1 &
done
wait
echo done $TAG
