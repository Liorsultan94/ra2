# Iron Front — browser RTS

A modern-warfare real-time strategy game in the spirit of *Red Alert 2*, running entirely in the browser
(TypeScript + Three.js/WebGL). All 3D models, textures, music and sound effects are generated procedurally —
there are no copyrighted game assets.

## Features

- **9 playable nations** (United States, Israel, China, Russia, Germany, South Korea, Ukraine, Turkey, Iran),
  each with its own doctrine bonus and signature units — e.g. Trophy-style active protection, TOS thermobaric
  launchers, Krasukha EW jamming, FPV drone teams, Shahed container launchers, K9 auto-loading howitzers.
- Classic base building: power, ore refineries & harvesters, barracks, war factory, radar, drone hub, battle lab,
  defenses (MG bunker, SAM site, ATGM tower), repair / sell, capturable oil derricks.
- Ground, artillery and **air units** (strike UAVs, jets, kamikaze drones) with anti-air counters.
- Skirmish vs. a doctrine AI — every nation fights its own way (scouting, flanks, harvester raids, focus fire,
  retreat-to-repair, artillery standoff, missile salvos) on easy / normal / hard; fog of war, minimap.
- A live day / night clock (1 real minute = 1 game hour) that changes the fighting: by night units see half as
  far and the fog of war only shows what your forces see right now; snipers, tanks, attack helicopters, drones
  and jets carry night vision; muzzle flashes give shooters away for 5 s (hold fire to stay hidden); artillery
  and mortars fire illumination flares (L); powered bases light floodlights.
- RTS controls: control groups (Ctrl/Shift + 1-9, phone group strip), stances (Alt+A/S/D/F: aggressive, guard,
  hold position, hold fire), patrol (P), escort (G), Shift-queued waypoints, attack-move, repeat build.
- Isometric 3D graphics with shadows, bloom, animated water, particles and dynamic explosion lights.
- Desktop (mouse + keyboard) and touch (phones / tablets) controls.
- Deterministic, command-driven simulation, ready for lockstep online multiplayer (next step).

## Development

```bash
cd web
npm install
npm run dev      # http://localhost:5173
npm test         # simulation tests (AI vs AI games for all nations)
npm run build    # production build in web/dist
```

`?play=usa,russia,hard` in the URL skips the menu and starts a battle directly.

## Code layout

| Path | What |
| --- | --- |
| `src/sim/` | Deterministic game simulation: map, units, combat, economy, pathfinding, AI |
| `src/render/` | Three.js renderer: terrain, procedural models, effects, fog of war, cameos |
| `src/ui/` | HUD sidebar, minimap, menus, cursors, CSS |
| `src/game/` | Game loop and input (mouse, keyboard, touch) |
| `src/audio/` | Procedural Web Audio sound effects, music and announcer |

## Deployment

`.github/workflows/pages.yml` builds and publishes the game to GitHub Pages on every push to `master`
(enable *Settings → Pages → Source: GitHub Actions* once).
