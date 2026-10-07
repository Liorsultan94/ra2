# Bug sweep findings: frontline (grass) + desert (base e3897cf)
Owner's order (translated from Hebrew): "Fix all the bugs you found."

**Reference material**
- Screenshots: `/tmp/claude-0/BH/{frontline,desert}/{desk-grid,desk-spots,phone-phone}/`
- Scripts:
  - `/tmp/claude-0/BH/bh-shots.mjs`: freeze-and-render camera spots; reuse it for before/after at the same spots.
  - `/tmp/claude-0/BH/probe/`: headless probe tests.
- Notes: `/tmp/claude-0/BH/notes.md`
- The desert map is seeded per match. The browser shots used seed 437163864; check how bh-shots.mjs forced it.

## Top 10 issues
1. **HIGH: river and oasis turn blown-out white from sun glare.**
   - Zoomed out, the whole Frontline river and the desert central oasis read as snow or ice. It also shows at play zoom, and even under full overcast rain.
   - Screenshots:
     - `frontline/desk-grid/zo_c.png`
     - `desert/desk-spots/ui_minimap.png`
     - `frontline/desk-spots/z_roadend1_24x30.png`
     - `frontline/desk-spots/wx_rain_wide.png`
   - Likely cause: the spec/spark terms in the `render/water.ts` shader (~lines 1555–1561) have no cap and no overcast damping.
2. **HIGH (gameplay): tank groups jam forever on Frontline.**
   - Moving 16 tanks together from a base to the centre, the enemy base or a bridge, 1–4 tanks never arrive. They oscillate in place around (22–25, 67–69) and (62–63, 19–20).
   - A single tank from the same spot gets through in 15 s.
   - Screenshot: `frontline/desk-spots/c_x_jam_a_24x68.png`
   - Likely cause: `sim/world.ts` `followPath`'s stuck check (moved < 0.2 per 20 ticks) never fires while `separate()` shoves the units around a shared waypoint.
3. **HIGH: hard straight map-edge seam on every edge.**
   - Detailed in-map grass and sand change to a flat blur in a darker colour.
   - Rivers kink 90° where they leave the map, with a seam across the water.
   - Screenshots:
     - `frontline/desk-grid/g77_93x93.png`
     - `frontline/desk-grid/zo_nw.png`
     - `desert/desk-grid/g72_93x28.png`
     - `desert/desk-grid/zo_c.png`
   - Code: `render/outskirts.ts` and `horizonworld.ts`; river exits run straight out, perpendicular to the edge.
4. **MED-HIGH: desert waterfalls pour off dry mesas into both side oases.**
   - Screenshots: `desert/desk-spots/c_steep1_73x72.png`, `c_steep0_25x25.png`
   - Cause: `findFalls` in `render/relieffx.ts` adds a fall wherever water meets a relief cliff, with no check for a river or the biome.
5. **MED: power pylons stand in the river.**
   - Frontline (27.8, 35.2) and its mirror (68.2, 60.8), the second one in the rapids.
   - Screenshots: `frontline/desk-spots/z_x_pylonrapids_67x61.png`, `desk-grid/g23_28x41.png`
   - Cause: `valid()` in `render/layout.ts` (~line 377) tests only the pylon's centre tile, not its legs.
6. **MED: neutral sites sit on roads, hedges and fences.**
   - Comms tower at 58,12 and its mirror at 36,82 straddle paved roads; cars drive through them.
   - Hospital at 72,28 clips a road.
   - Oil derrick at 6,50 sits on a road; derrick at 38,74 on a dirt track.
   - A hedge runs through the derrick at 57,21 and through the airport at 6,30; a fence runs through the airport at 87,63.
   - Screenshots:
     - `frontline/desk-grid/g41_54x15.png`
     - `frontline/desk-spots/c_oil1_7x51.png`
     - `frontline/desk-spots/z_oil2_58x22.png`
   - Cause: the road, track, field and hedge layout in `render/layout.ts` doesn't avoid oil or tech sites, and the default tech-site spots in `sim/capture.ts` don't know about roads.
7. **MED: "marbled" swirl patterns on the water** downstream of every bridge's piers and over the whole rapids. Visible on phone medium too.
   - Screenshots:
     - `frontline/desk-spots/c_bridge0_48x48.png`
     - `frontline/desk-spots/c_falls_64x59.png`
     - `frontline/phone-phone/p_bridge0_48x48.png`
   - Code: eddy/whitewater foam in `render/water.ts`, eddy data in `waterData2`.
8. **MED: buildings accepted on steep slopes, against cliffs and on a bridge head.**
   - The concrete apron floats on the downhill side and the back is buried in rock.
   - A factory on the NW bridge end overlaps the deck and can block the bridge for ground units.
   - A render-only bush grows through a factory roof.
   - Screenshots:
     - `frontline/desk-spots/steepbld0_55x32.png`
     - `frontline/desk-spots/steepbld2_21x19.png`
     - `frontline/desk-spots/steepbld1_36x8.png`
     - `desert/desk-spots/steepbld0_58x32.png`
   - Cause: `terrainBuildable` in `sim/map.ts` has no slope rule. 382 slots for a 3x3 building with more than 0.9 height difference are buildable on Frontline, 334 on desert.
9. **MED: airliner contrails drawn just above the ground.**
   - Zoomed out they are two thick white bars across the screen; in low views they look like a grey road ending in a point.
   - Screenshots: `frontline/desk-spots/ui_minimap.png`, `frontline/desk-grid/hz_ne.png`
   - Cause: in `render/ambient/air.ts` the jet altitude is 55% of the camera height, clamped to 5.5–13.5.
10. **MED (gameplay): desert AI-vs-AI games stall.**
    - All 8 hard-AI games on desert (4 seeds × 2 faction pairs) hit the 20-minute timeout.
    - A 45-minute run ended at 38.5 min after repeated failed attacks.
    - Frontline games finish in 16–19 min.

## Other bugs: Frontline
- **Bush in the water, LOW:** at the river edge, about 80,79.5. `frontline/desk-spots/c_x_treeinwater_80x80.png`
- **Bridge decks look warped, LOW.**
  - The NW and SE decks S-bend at both ends to meet higher banks (`render/deckramp.ts`).
  - The centre bridge has a guardrail gap and a protruding abutment at the east end.
  - `frontline/desk-spots/c_bridge1_20x23.png`
- **Rock ridge rims, LOW.**
  - Flat dark slabs stick out horizontally and look like floating plates.
  - The castle ruin's foundation blocks overhang the cliff.
  - `frontline/desk-spots/z_x_roadrock_a_55x33.png`, `c_steep0_41x66.png`
- **Night water shows a regular dotted grid, LOW.** `frontline/desk-spots/n_bridge0.png`
- **Wet glints too sparkly in rain, LOW:** very bright white blobs on puddles and the deck. `frontline/desk-spots/wx_rain.png`
- **Railway past the map ends abruptly, LOW:** it leaves as a flat grey ribbon that stops in the fields (photo/cinematic views only). `frontline/desk-grid/hz_nw.png`
- **Tree clump in a visible grey card at the NW corner, LOW:** about 3,2. `frontline/desk-spots/c_bank0_7x5.png`
- **Crowded harvesters drop the player's far-field order, LOW:** ordered to a far field in a crowd, they jam, then fall back to the nearest field. A single harvester obeys the order.
- **34 tiny unreachable passable pockets, LOW:** 60 tiles in total, all on the map border, walled off by trees or water. Make them impassable or reachable.
- **"Looks cheap":** trees just past the map edge render about twice the in-map size (this is a bug).

## Other bugs: desert
- **Sandstorm barely shows, MED.**
  - A forced sandstorm only adds a sepia grade and haze, with no blowing sand at play zoom.
  - Wind turns the oasis into scribbled whitecaps.
  - `desert/desk-spots/wx_sandstorm.png`, `wx_sandstorm_wide.png`
- **Mesa rims and cliffs, LOW-MED.**
  - Rim boulders are identical lumps evenly spaced, some hanging mid-cliff.
  - Fluted cliff columns cast finger shadows, so the mesas look like they stand on stilts.
  - `desert/desk-grid/g57_67x93.png`, `g13_15x41.png`
- **Power wires cross the N mesa top at rim height, LOW;** they probably clip into it. `desert/desk-spots/c_rock2_50x12.png`
- **The wadi stops dead at the map corner, LOW.** `desert/desk-grid/g77_93x93.png`
- **Placeholder-looking outskirts, LOW.**
  - A flat black segmented road strip that ends square.
  - An untextured turquoise pond ringed by identical palms.
  - Rows of identical stall boxes, red paint-spill blotches, and palms sprinkled evenly over open dunes.
  - `desert/desk-grid/g03_2x41.png`, `g06_2x80.png`, `zo_sw.png`
- **Two mud houses on 0.53-unit slopes, LOW:** seed 777 only, #8 at 34,46 and #9 at 60,48.
- **Bright foam arcs along still oasis shores.**

## Console warnings (both maps)
- `Oscillator.frequency.value 17362 outside nominal range [-12000,12000]`, repeated. Clamp the frequency to `ctx.sampleRate/2` in `audio/core.ts` `osc()`/`filter()`.
- `THREE.UniformsUtils: Textures of render targets cannot be cloned`, from `UniformsUtils.clone(FinalShader.uniforms)` in `render/post.ts:287` or the same call for GradeShader in `game/photomode.ts:389`.
- After the debug setup removed the MCV, the "MCV is selected" toast stayed (untested oddity).
