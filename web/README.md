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
- Skirmish vs. AI (easy / normal / hard), fog of war, minimap, control groups, attack-move.
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
