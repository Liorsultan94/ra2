# BAL1 start-position balance

## Bench
- `bench/bal-bench.test.ts`: AI vs AI Hard, 30 min cap, grace on (3 min, as in real games) or off.
- `bench/run.sh <tag> [maps] [srcdir]` runs one niced vitest per map (BENCH=1; bench/ is left out of the normal
  `vitest run`). `an.py <tag> [-v]` summarises slot wins, `plans.py <tag>...` win rates by opening plan,
  `econ.py <tag> [min]` compares harvest by slot. Raw rows are in `bench/results/`.
- FULL=1 swaps the whole AI personality (seeded plan, build order, rng stream) together with the nation, so the
  two orientations of a pairing differ only in the start slot. Each map and grace setting gets 26 games:
  3 nation pairs (israel-iran, usa-russia, china-ukraine) x 3 seeds x 2 orientations, plus usa-usa and
  russia-russia x 2 seeds x 2.
- Checks: `sym.test.ts` (tiles, heights, trees, ore, passability, neutral entities), `pathsym.test.ts` (A* lengths
  from both starts, 300 mirrored random pairs), `dock.test.ts` (one refinery per side at mirrored spots, harvest
  over 8 min), `he16.test.ts` (hard vs easy on the desert, 16 games, both slot orders).

## Results: slot 0 / slot 1 wins (decided games; capped games left out)

| map | grace on, before (master ca8fd51) | grace on, after | grace off, before | grace off, after |
|---|---|---|---|---|
| frontline | 6 / 18 | 11 / 9 | 6 / 17 * | 12 / 8 |
| desert (seeds 1-3) | 5 / 13 | 14 / 7 | 4 / 12 | 10 / 10 |
| desert (seeds 4-6) | 11 / 11 | 11 / 11 | | |
| winter | 8 / 16 | 11 / 11 | 7 / 18 * | 13 / 13 |
| urban | 12 / 10 | 13 / 11 | 16 / 10 * | 12 / 9 |
| all | 42 / 68 (slot 1 62%) | 60 / 49 (slot 1 45%) | 33 / 57 (63%) | 47 / 40 (46%) |

\* grace-off "before" for frontline, winter and urban is master 1cb6e32 (`fullbase-*`); only the desert changed in
between (DS2/DS3). Rows: `m53*`, `fullbase*` (before), `fix2*` (after).

Hard vs easy on the desert (16 games, seeds 1-4 x usa / russia mirrors x both slot orders):
- master: hard in slot 1 won 7 (1 draw); hard in slot 0 won 4, easy 3, 1 draw;
- after: hard in slot 1 won 7 (1 draw); hard in slot 0 won 5 (3 draws); easy won none.

Opening plan win rates (all games of the runs): before boom 66%, rush 40%, balanced 35%, harass 30%, air 27%,
siege 12%; after boom 63%, balanced 45%, siege 44%, harass 40%, air 38%, rush 30%.

## Causes found and fixed
1. **Exits and docks all faced south (the main cause, all maps).** Every building's exit, refinery dock and
   drive-through tiles were on its south side. For the north base (slot 1) units rolled out towards the enemy,
   and its second refinery, by the field south of it, docked facing the ore. The south base's refinery by the
   field north of it docked facing away. In economy-only runs slot 1 harvested 9% more on Frontline and 3% more on
   the desert by minute 12. In the controlled dock test, a field's dock direction alone was worth about 10%.
   Fix (sim/turn.ts): a refinery, war factory or barracks built by a player whose start is in the north half is
   turned half a circle (`Entity.flip`, set at spawn and kept on capture). Its drive-through tiles, dock, exit,
   default rally and harvester unloading heading mirror in the sim (world.ts occupy / spawn, harvest.ts lane,
   dock and queue spots, ai.ts dock-lane rule). The renderer turns the model (root.rotation.y = PI). The airbase
   (runway / pads) and the buildings without an exit keep their facing. The human is always slot 0 (south), so
   their base looks the same as before.
2. **Frontline Crossing was not point-symmetric** (map.ts). Tile noise used the vertex mirror, ridges were
   mirrored as tile indices but tested at tile centres and vertices, the ridge relief, edge forest and tree kinds
   were hashed per tile, and the oil derricks (2 x 2) were mirrored as 1 x 1. 483 tiles, 876 trees, 259 height
   vertices and 4 derrick footprints differed. Player 0's half is unchanged; player 1's half is now its exact
   mirror (a one-tile shift of the smooth noise fields there).
3. **Bridge repair huts** (bridges.ts) were placed per end by a scan with tie-breaks (Winter, Urban, Frontline):
   a point-mirrored twin bridge now takes the mirror image of the first one's huts.
4. **Urban ore regrowth centres** (maps.ts) rounded x.5 apart on the two halves: they are now rounded on player
   0's half and mirrored.
5. **AI walled in its own refinery dock** (ai.ts findSpot): e.g. Frontline seed 3, an airbase on a refinery's
   apron left two full harvesters stuck for minutes (9.9k vs 22.5k harvested by 6 min). The AI now keeps every
   refinery apron clear, and builds a refinery only where its own apron is open.
6. **Plan per slot** (ai.ts aiSeed): the AI's random stream was seeded from (match seed, slot) only, so one seed
   handed the same opening plan to a slot whatever the nations (seed 1: boom for slot 1 every time). The nation
   is now mixed in.
7. **Boom** won ~70% of AI-vs-AI games. Modest trim (plans.ts): its third refinery comes after the radar instead
   of straight after the second, and defences x1.4 instead of x1.6. It still wins ~63%.

## Left / gaps
- Frontline and desert still show a slight slot-0 lean in single 26-game batches (11/9, 14/7). The extra desert
  seeds came out 11/11, and over all maps it is 60 / 49, within noise for this sample size.
- The controlled dock test still varies by +-1 load (5%) per field either way: ore regrowth draws from the shared
  rng, and harvest trips are counted in whole loads.
- Boom is still the strongest plan. Air and rush are weakest.
- The desert's sea floor carries < 0.03 of height noise that is not mirrored (render only, under water).

## CY1: the wider coloured canyon (desert, grace on)
The canyon floor went from 2 to about 4.5 tiles and its middle sank 0.3 deeper. Same bench (FULL=1, 26 games
per seed set), master bd1d84c re-run against the change. Rows: `cy1c` (seeds 1-3), `cy1d` (seeds 4-6).

| seeds | master bd1d84c | CY1 |
|---|---|---|
| 1-3 (MSEEDS 1,2) | 14 / 7 | 9 / 11 |
| 4-6 (MSEEDS 3,4) | 11 / 11 | 9 / 12 |
| both | 25 / 18 (slot 0 58%) | 18 / 23 (slot 0 44%) |

The games are chaotic: any change to the map reshuffles every outcome. One 26-game set on an intermediate
version (the wide floor without the deeper middle) gave 6 / 17 for seeds 1-3 and 13 / 9 for seeds 4-6.
No consistent lean either way; both totals are within noise (about 8% for ~40 decided games).

## SL1: slopes (steps too steep per locomotion class, graded mountain tracks)
Limits (sim/slope.ts, rise / run of the steeper half of a step, 1 height unit = 1 tile): vehicles 0.53 (28 deg),
infantry 0.83 (39.7 deg), aircraft none. Climbing costs CLIMB_COST 1.25 tiles per height unit in A*; units slow
to 1 / (1 + 0.45 x 2 x rise per half tile) uphill. Desert: the Jebel's flanks steepened (talus apron, rock band,
crest, lifted 25%) with graded tracks (sim/maps.ts DESERT_RAMPS); the canyon floor kept level to the walls' feet.

Same bench (FULL=1, grace on, seeds 1-3, MSEEDS 1,2; 26 games per map). Rows `sl1` (seeds 1-3), `sl1b` / `sl1c`
(Frontline seeds 4-6 / 7-9, MSEEDS 3,4 / 5,6); master re-run on Frontline: `sl1base` (= fix2, 11 / 9) and
`sl1baseb` (seeds 4-6).

| map | before | SL1 |
|---|---|---|
| frontline seeds 1-3 | 11 / 9 (fix2 = master re-run) | 7 / 13 |
| frontline seeds 4-6 | 10 / 12 (master re-run) | 9 / 10 |
| frontline seeds 7-9 | | 11 / 10 |
| desert | 9 / 11 (cy1c, master) | 11 / 10 |
| winter | 11 / 11 (fix2) | 14 / 10 |
| urban | 13 / 11 (fix2) | 13 / 10 |
| all, seeds 1-3 | 44 / 42 | 45 / 43 (slot 0 51%) |

Frontline over 9 seeds: 27 / 33 (slot 0 45%; master over 6 seeds 21 / 21); within noise (~6% for 60 games).
Path lengths (vehicles, seed 1, master -> SL1): start to start frontline 134.5 -> 133.9, desert 141.7 -> 143.4,
winter 94.6 -> 93.8, urban 102.6 -> 101.4; start 0 to its own ore fields (sum) frontline 277.9 -> 276.0, desert
262.2 -> 259.2, winter 139.6 -> 138.8, urban 146.0 -> 144.1. Pathsym: 0 of 300 mirrored pairs differ on any map.

## SN1: the desert becomes the Sinai (160 x 160, screen left-right mirror)
The map is mirrored across the screen's vertical axis (GameMap.mirror 'transpose', tile (x, y) <-> (y, x)), so
both sides face the same way on screen. Blue starts on the Egyptian mainland west of the Gulf of Suez, red on the
Arabian mainland east of the Gulf of Aqaba at the mirrored spot. The only links between the three land masses are
the two land corridors at the gulf heads (no bridges, no ferry). Buildings only turn by 180 degrees, so the home ore
fields lie due screen-east / screen-west of each base and the refinery docks relate to them the same way.

Fairness numbers (`bench/sinai-fair.test.ts`, vehicles, seed 1): start to enemy 141.5 / 141.5; start to each ore
field identical for its mirror (sum 350.7 / 350.7); ore value 1736 / 1736; oil 4 / 4; open 2x2 build spots within
20 tiles 1163 / 1163; garrisonable houses 23 / 23; tech sites 4 / 4; bridges 0.

Bench (FULL=1, grace on, 26 games per row; before = master db1bef1 copy, rows `before*`; after = SN1, `after*`):

| seeds | before wins (lead incl. capped) | after wins (lead incl. capped) | capped before / after |
|---|---|---|---|
| 1-3 (MSEEDS 1,2) | 8 / 9 (9 / 15) | 5 / 8 (9 / 13) | 9 / 13 |
| 4-6 (MSEEDS 3,4) | 6 / 6 (12 / 11) | 10 / 2 (15 / 5) | 14 / 14 |
| both | 14 / 15 (21 / 26) | 15 / 10 (24 / 18) | 23 / 27 |

Games run longer (mean 25.4 / 26.5 min against 23.8 / 24.6) and more reach the 30 min cap, since every attack has
to come through one of the two corridors. The seeds 4-6 set leans to slot 0; over both sets it is within noise.
Hard vs hard (usa-russia, seeds 1-6, 60 min cap): seeds 2 / 4 / 5 / 6 end in 19-29 min, 1 and 3 never (both
sides' waves die at the corridors, one every five minutes or so).

Hard vs easy (usa mirrors, 25 min cap, `bench/sinai-deaths.test.ts`, 19 games over seeds 1-8 and both slot orders,
seeds 1-4 partly with the personalities swapped, SWAP=1): hard won 4 of 10 from slot 0 and 7 of 9 from slot 1, easy none; the games
that ran out the clock ended with hard well ahead. The per-seed results flip with the personalities (seeds 5 and
8 favour slot 0, 6 and 7 slot 1), so the lean is not clearly the map's: p ~ 0.17. `bench/sinai-econ.test.ts`
(easy vs easy, swapped personalities) shows the same economy from either base.

### SN1, owner update: the Sinai traced from the owner's picture (176 x 176, no mirror)
The coasts follow the reference picture's water mask (sim/sinaimask.ts) and the bases sit at the owner's marks, so
the sides differ: blue's crossing (the isthmus at the head of the Gulf of Suez) is 14 tiles from its base, red's
(between the Gulf of Aqaba's head and the granite ridge) 53. What each holds is kept equal by hand, counted for the
base nearer by road (`bench/sinai-fair.test.ts`, seed 1): start to enemy 161.8 / 162.1; ore 7 / 7 fields, value
1662 / 1662, roads to them 253.8 / 245.7; oil 4 / 4 (roads 118 / 107); build space 553 / 541 (a rocky headland by
blue's base makes up for the seas closer round red's); garrisonable houses 22 / 22 (roads 882 / 1475: red's are
farther); tech sites 4 / 4 (roads 155 / 166). The crossings about 10 tiles across at both heads.

Bench (FULL=1, grace on, 26 games per row; rows `geoF*`, the final map): seeds 1-3 1 / 5 (lead 5 / 19), seeds 4-6
4 / 5 (lead 9 / 14), seeds 7-9 11 / 4 (lead 13 / 11); all 78: wins 16 / 14, lead 27 / 44 (red 62%), 48 capped,
mean 26.7 min. Harvest by slot, all games: red 3% ahead at 4 min, 1-4% at 8 to 20 min, 9% at 28 (the front is at
blue's door: its crossing is 14 tiles from its base, red's 53). A slightly earlier version of the same layout
(before the distance grid went 16-bit and the headland grew) gave 13 / 10 wins, lead 24 / 23 over seeds 1-6: the
games are chaotic, the red lean in the leads is about two standard deviations.

Hard vs hard (usa-russia, 60 min cap, seeds 1-20): 16 end in 19-58 min, 4 hold out. Widening both crossings (the
head of the Gulf of Suez 6 px south, the ridge 6 px shorter) did not help: 8 of 20 held out. (On the mirrored
layout a modest corridor widening, 15.5 to 17 tiles, had not helped either: 4 of 6 held out against 2.)
