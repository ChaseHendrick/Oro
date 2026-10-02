# Handoff notes (2026-10-02, about 07:55 UTC)

Status of the Orograph build when the owner paused for a usage limit. Read this first when resuming.

## Where everything is

| Thing | Location | State |
|---|---|---|
| Synth app | `ChaseHendrick/synth`, branch `claude/magical-tesla-q993l8`, draft PR #1 | pushed; last commit is a WIP snapshot (`2af6643`) |
| Website | `ChaseHendrick/hendrickresearch.com`, branch `claude/orograph-music` | pushed (commits `b7dc88f`, `89c4ca9`), **no PR yet** |
| Blender scripts | `dev/blender/export.mjs`, `dev/blender/render.py` | committed; need the bpy venv (see below) |
| Research | `docs/RESEARCH.md`, `docs/MPC-XL.md`, `docs/PEDALS.md` | done |
| Contract | `docs/ARCHITECTURE.md` (incl. "Round D additions") | done |
| User docs | `README.md`, `docs/USER-GUIDE.md`, `CHANGELOG.md` | done |

## Done and verified

* Core app: DSP engine, audio host, 3D visuals (Rapier marble), UI with dark and light themes, sequencer/arp, 53 patches and 7 scenes, MIDI with MPC XL detection, Q-Link learn, clock in/out.
* Laps, Pace (3 curves), Sub, harmonic bars, dot locks with lock recording.
* Full-app smoke test passed in dark/light at 1440x900 and 390x844 (`tests/e2e/app-smoke.cjs`); UI suite 144/144; audio host, visuals, DSP worklet suites pass.
* CI green on every pushed commit up to `9d49fcb` on macOS, Windows and Linux desktop builds plus web/offline builds.
* Finished agents (work committed): docs, guitar pedal modules (`src/pedals/`, 141 tests, not wired into the app yet), Round D audio host (bounce/stems, quality, links/macros/steps forwarding, ceiling, import options, 16-bit PNG), website section.

## In flight when paused (work is in the WIP snapshot, possibly unfinished)

| Agent | Workflow run | What it was doing |
|---|---|---|
| Round D DSP | `wf_c33c1bf6-8cd` | features implemented; was running the final app smoke test |
| Round D music | `wf_c33c1bf6-8cd` | preview, explore notes, renderEvents, MPE; final bug hunt (locks while rolling) |
| Round D visuals | `wf_593f9e84-de3` | explore, tour waypoints, lock markers, overlays, gestures; final smoke test |
| UI polish and wiring | `wf_2beb3d78-192` | wiring every Round D control, layout and a11y fixes; final UI test run |
| Bug-test hardening | `wf_8003ac5f-01d` | `tests/e2e/app-deep.cjs`, `tests/integration/`, writing `docs/BUGS.md` |
| Blender finals | `wf_4b20defc-adf` | better camera/contours; renders in the session scratchpad (`.../scratchpad/hero/`), which may be gone after a restart |

Transcripts and journals: `/root/.claude/projects/-home-user-synth/<session>/subagents/workflows/<run>/journal.jsonl` (only if the same container is still alive).

## Next steps, in order

1. `git status`; if agents finished after the snapshot, commit their changes.
2. `npm ci && npx vitest run` (known flaky only under heavy CPU load: `tests/audio/terrain-manager.test.js` timing budget and `tests/integration/scene-schedule.test.js`; both pass alone).
3. `npm run build && npm run build:single`, then `npx vite --port 5190 --strictPort &` and `node tests/e2e/app-smoke.cjs http://127.0.0.1:5190/`; also run `tests/e2e/ui.cjs`, `visual.cjs`, `audio-host.cjs`, `music.cjs`, and `app-deep.cjs` if present.
4. Read `docs/BUGS.md` (if written) and fix every high/medium bug.
5. Check for agent-run git stashes: `git stash list` should be empty (one agent ran `git stash` / `pop` mid-run; the docs agent reported its files came back intact).
6. Push, get CI green on PR #1, mark it ready, **merge** (owner asked to merge). The push to `main` publishes the GitHub Release (`releases/latest`) with Mac, Windows, Linux and offline HTML downloads.
7. Website: if Blender finals exist, convert to JPEG into `public/music/orograph-hero-{dark,light}.jpg`; refresh the app with `node scripts/sync-orograph.mjs ../synth` (from the website repo); `npm ci && npm run build`; open the PR from `claude/orograph-music`, get its CI green, merge. Vercel deploys `main`; the page is `/music/orograph/`.
8. v1.1: wire `src/pedals/` into the engine and UI (pedal send per part, 4-channel output map, return via getUserMedia, Ping, pedal MIDI profiles in Settings, guitar envelope as a Links source, pitch tracking, Capture), and add Electron audio-capture permission plus `NSMicrophoneUsageDescription` (`docs/PEDALS.md`).

## Blender setup (if the scratchpad venv is gone)

`python3 -m venv bvenv && bvenv/bin/pip install bpy==4.5.0` (about 370 MB, Python 3.11), then
`node dev/blender/export.mjs data.json` and
`bvenv/bin/python dev/blender/render.py -- dark out.png 1920 1080 96 data.json` (and `light`).

## Owner preferences to keep

Clean-room only (never copy Conductive Labs code or text; their page is Cloudflare-protected and must not be bypassed). No em dashes in user-facing text. Accurate claims only; MPC and pedal features are untested on real hardware and the docs say so. The owner asked to merge both PRs and to put Orograph on hendrickresearch.com under Music.
