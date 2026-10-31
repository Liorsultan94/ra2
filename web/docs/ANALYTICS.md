# Developer analytics (PostHog)

Anonymous gameplay and performance data for the developer only. Players never see it.
Code: `src/telemetry/`. Without a project key, or until the player taps **Allow**, it does
nothing at all: posthog-js is not downloaded and no request is made.

## Setup (one time)

1. Create a project at <https://posthog.com> (US or EU cloud).
2. In the project settings:
   - copy the **Project API key** (`phc_...`, public by design: it can only send events);
   - turn on **Discard client IP data** (the SDK's `ip` option no longer does anything);
   - optional: leave person profiles off (the game never identifies anyone).
3. Give the build the key, in one of two ways:
   - **GitHub repo variable (recommended).** Go to repo *Settings → Secrets and variables →
     Actions → Variables → New repository variable*:
     - add `POSTHOG_KEY` = `phc_...`;
     - add `POSTHOG_HOST` = `https://eu.i.posthog.com` only for an EU project (default `https://us.i.posthog.com`).

     `.github/workflows/pages.yml` passes them to `npm run build` as
     `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST`. Re-run the Pages workflow or push to deploy.
   - **In code.** Paste the key into `FALLBACK_POSTHOG_KEY` in `src/telemetry/config.ts`
     (and the host into `FALLBACK_POSTHOG_HOST` for EU).
   - Locally: `VITE_POSTHOG_KEY=phc_... npx vite build` (or put it in `web/.env.local`).

## Player consent and privacy

- On first launch, a small notice in the main menu asks: *Help improve Iron Front* with
  **Allow** / **No thanks**. Settings → Privacy changes the choice later. The choice is
  stored in localStorage (`ironfront.analytics.v1`).
- Nothing is loaded or sent before Allow. Do Not Track / Global Privacy Control means no,
  and the notice is not shown.
- The id is anonymous and random (`person_profiles: 'never'`, never `identify()`), with no
  name or email. persistence: localStorage only, no cookies.
- Autocapture records clicks on buttons, links and labels, never text inputs.
- No session recording (`RECORD_SESSIONS = false` in `config.ts`; if it is ever enabled,
  all inputs are masked). No surveys, feature flags or external scripts.
- Telemetry runs outside the deterministic simulation. It only reads game state and never
  writes it.

## Events

| Event | When | Fields |
|---|---|---|
| `app_loaded` | main menu up (once per page load; sent after Allow if given later) | `load_ms`, `device` (phone/tablet/desktop), `screen_w/h`, `viewport_w/h`, `dpr`, `quality_setting`, `quality`, `controls`, `gpu`, `mem_gb`, `cores` (+ PostHog's `$os`, `$browser`, `$device_type`) |
| `match_started` | first simulation tick of a battle | `map`, `faction`, `enemy[]`, `difficulty`, `game_speed`, `grace`, `grace_min`, `ai_count`, `quality`, `controls`, `credits`, `auto_defend` |
| `match_ended` | victory / defeat, quit (pause menu, restart, tab closed via sendBeacon), crash | the match_started fields, plus `result` (win/loss/quit/crash), `game_min`, `real_min`, `first_attack_min`, `units_built{infantry,vehicle,air,naval}`, `units_lost{...}`, `units_built_total`, `units_lost_total`, `units_killed`, `buildings_built/lost/destroyed`, `credits_earned/spent`, `top_units[]` + `top_units_n[]`, `enemy_top_units[]` + `enemy_top_units_n[]`, `enemy_units_built`, `superweapons_used`, `ai{waves,pincers,combined,marches,feints,retreats,counters,first_wave_min,react_*}` |
| `perf_sample` | 3 match minutes in, and at match end | `at` (mid/end), `match_min`, `avg_fps`, `min_fps`, `p5_fps`, `frame_ms_p95`, `frames`, `quality`, `quality_level`, `quality_changes`, `heap_mb`, `device` |
| `error` | `window.onerror`, `unhandledrejection`, WebGL context lost, battle stopped rendering | `kind`, `message`, `stack` (≤ 2 KB), `map`, `match_min`, `quality`. Deduplicated per message, max 20 per session |
| `ui_action` | build tab, superweapon, support power, control group set, pause/resume, game speed change, photo mode, thermal view | `action`, `detail`. The same action is sent at most once per 2 s, and at most 150 per session |
| `tutorial_step` | MCV deployed, first structure, first unit, first kill (per match); each distinct on-screen hint (once per session) | `step`, `match_min`, `unit`, `hint` |
| `$pageview`, `$autocapture` | PostHog built-ins | menu and button clicks |

## Suggested insights and dashboard

Build them in PostHog under *Product analytics → New insight*, and pin them to one
"Iron Front" dashboard.

- **Win rate by faction × difficulty × map.** Use a Trends insight on `match_ended`
  filtered to `result` in (win, loss), with the formula *wins / (wins + losses)*, broken
  down by `faction`, then `difficulty`, then `map`. (Or a SQL insight:
  `countIf(properties.result='win')/countIf(properties.result in ('win','loss'))`
  grouped by the three.)
  - Answers: which nations and maps are too easy or too hard; whether Hard is beatable.
- **Match length distribution.** Use a SQL / histogram insight of `properties.game_min` on
  `match_ended`, split by `result` and `difficulty`.
  - Answers: whether games end too fast (rush) or drag on.
- **Quit minute.** Make a histogram of `game_min` where `result = quit`, alongside
  `first_attack_min`.
  - Answers: when players give up, and whether it is right after the first attack.
- **FPS by device.** Use a Trends insight on `perf_sample` (`at = end`), showing the
  median and the p10 of `avg_fps` and `p5_fps`, broken down by `device`, `quality` and
  `$os`/`$browser`. Add a table of `gpu` from `app_loaded`.
  - Answers: which devices or quality tiers stutter, and whether the auto quality
    (`quality_changes`) is too aggressive.
- **Load time.** Show the median and p90 of `app_loaded.load_ms` by `device`.
  - Answers: whether phones wait too long before the menu.
- **Top errors.** Use a Trends insight on `error`, broken down by `message` (table, last
  7 days), with a second table by `kind` and `quality`.
  - Answers: what to fix first; whether context losses cluster on one GPU or tier.
- **Funnel.** Build a Funnel `app_loaded → match_started → match_ended` (conversion window
  1 day). Also make one with `match_ended` filtered to `result = win`.
  - Answers: how many visitors actually play, and how many finish a match.
- **Retention.** Use a Retention insight: first `app_loaded`, then returning
  `match_started`, weekly.
  - Answers: do players come back?
- **Onboarding.** Make a Funnel of `tutorial_step` steps `mcv_deployed → first_structure → first_unit →
  first_kill` on the first match, and a table of `hint` counts.
  - Answers: where new players get stuck.
- **Build choices.** Use a SQL insight that `arrayJoin(properties.top_units)` on
  `match_ended`, grouped by `faction`; also `ai.waves`, `ai.pincers` and
  `first_attack_min` by difficulty.
  - Answers: dominant units, and whether the AI tactics fire as intended.
