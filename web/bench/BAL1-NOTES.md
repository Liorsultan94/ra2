# BAL1 start-position balance (WIP, paused)

Bench: `bench/bal-bench.test.ts`, AI vs AI Hard, 30 min cap. `run.sh <tag> [maps] [srcdir]` runs one niced vitest
per map; `an.py <tag> [-v]` summarises; `econ.py <tag> [min]` does paired economy by slot.
FULL=1 swaps the whole AI personality (seeded plan, build order, rng) with the nation, so only the start slot
changes between orientations A and B. Without FULL the plan is seeded by (seed, pid), so it is tied to the slot.
Per map and grace setting: 3 nation pairs x 3 seeds x 2 orientations + usa/russia mirrors x 2 seeds x 2 = 26 games.
Raw rows in `bench/results/` (base = plain swap, fullbase = FULL on master 1cb6e32, fix1 = FULL on this branch).

## Slot wins (slot0 / slot1, decided games; capped games ignored)

| map | fullbase grace on | fullbase grace off | fix1 grace on | fix1 grace off |
|---|---|---|---|---|
| frontline | 6 / 18 | 6 / 17 | 6 / 16 | 7 / 14 |
| desert | 10 / 11 | 9 / 14 | 7 / 14 | 9 / 11 |
| winter | 8 / 16 | 7 / 18 | 11 / 10 | 10 / 13 |
| urban | 12 / 10 | 16 / 10 | 14 / 10 | 9 / 15 |

Plain swap (base, 20 games each, plan tied to slot): frontline 5/14, desert 5/14, winter 5/11, urban 9/9 (grace on).
The "boom" plan wins most AI-vs-AI games whatever the slot or nation (seed 1 gives slot 1 boom for every nation),
which explains much of the AI1 observation; that is an AI plan balance issue, not a map one.

## Found and fixed on this branch (uncommitted before this WIP)
- Frontline (map.ts) was not point-symmetric: tile noise used the vertex mirror (W - x), ridges mirrored with
  W - 1 - x while being tested at tile centres / vertices, ridge roughness and edge-forest hashes unmirrored,
  tree kind hash asymmetric, oil derricks (2x2) mirrored as 1x1. Fixed so player 0's half is unchanged and player
  1's half is its exact mirror (483 tiles, 876 trees, 259 height vertices, 4 oil footprints differed before).
- Bridge repair huts (bridges.ts) were placed per end by a scan with tie-breaks, not mirrored (winter, urban,
  frontline): now a twin bridge takes the mirror of the first one's huts.
- Urban ore regrowth centres (maps.ts) rounded x.5 apart on the two halves: now rounded on player 0's half, mirrored.
- AI bug: findSpot could wall in a refinery's dock lane (e.g. frontline seed 3 slot 0: airfield on the apron, two
  full harvesters stuck for minutes, harvest 9.9k vs 22.5k at 6 min). AI now keeps refinery aprons clear
  (harvest.ts inDockApron, ai.ts blocksDock).
- Symmetry checks: `bench/sym.test.ts` (tiles, heights, trees, ore, pass, neutral entities), `bench/pathsym.test.ts`
  (A* path lengths from both starts, 300 mirrored random pairs): all symmetric now except tiny (< 0.03) sea-floor
  height noise on the desert coast.

## Still open
- Frontline still ~70% slot 1 after the fixes (fix1), desert grace-on 2:1; winter now even.
- Suspected sim-level asymmetry: every building's exit / dock is on its south side. For slot 1 (north base) units
  leave towards the enemy and the dock of a refinery by its north-west field faces the ore; for slot 0 the
  north field's refinery docks away from it. Economy-only runs (econbase, no fighting) give slot 1 +9% harvest on
  frontline and +3% on desert at 12 min (slot 0 better in 5/28 and 7/28 pairs). A controlled dock test
  (`bench/dock.test.ts`) shows about +-10% per field depending on dock direction. Candidate fix: turn the north
  base's buildings half a circle (sim layout + renderer), or ore layouts whose fields lie east / west of the base.
- tests/ai-smart.test.ts "hard beats easy" (desert seed 1) now fails: hard 'air' loses to easy 'boom' after the
  AI / hut changes shifted the game (it was a close game on master too); not resolved yet.
- Not yet run: tsc / full vitest / vite build / V11-diag smoke on the final state.
