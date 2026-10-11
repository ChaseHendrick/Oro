# Agent and terrain validation for 2.17.2

Validated on the connected Mac on 2026-10-11, starting from 2.17.1 commit
`3b95281822c4807d1cde748687138ef9112f4ffe`.

* Vitest: 182 files, 2,070 tests pass. Coverage includes atomic agent validation,
  bridge permissions/errors, stable track routing, Strum retrigger timing, session
  replacement and score edits surviving restoration, history and version saves.
* `npm run build` and `npm run build:single` pass.
* The existing app smoke check passes at 1440 × 900 and 390 × 844 in both themes:
  startup, nonzero finite output, map placement, sequencer steps and no page or
  console errors. Eight screenshots were saved; desktop and phone layouts were inspected.
* The built-app terrain regression passes for two arbitrary drops with Rapier,
  Strum/FX pointer drags, mode/track changes, reorder/removal, blur, cancellation,
  covering the map, waypoint editing, loading during a held drag and disposal.
* The built-app agent regression passes real postMessage discovery, the opt-in
  gate, allowlisting, malformed arguments and atomic validation error receipts.
  Strum produces finite nonzero output; an FX sweep changes spectral centroid.
  Live name, cutoff and tempo edits survive score stop, real localStorage autosave,
  undo/redo and reload. During motion, autosave uses its existing two-second
  maximum wait; comparisons exclude only continuously moving centre coordinates.

Run against a local built app with Playwright available:

```sh
npx vitest run --maxWorkers=4
npm run build
npm run build:single
npm run preview -- --host 127.0.0.1 --port 5191 --strictPort
# In another terminal; use your installed Playwright module path:
PLAYWRIGHT_MODULE=/path/to/playwright node tests/e2e/app-smoke.cjs http://127.0.0.1:5191/
PLAYWRIGHT_MODULE=/path/to/playwright node tests/e2e/terrain-interaction.cjs http://127.0.0.1:5191/
PLAYWRIGHT_MODULE=/path/to/playwright ORO_EXPECTED_VERSION=2.17.2 node tests/e2e/agent-performance.cjs http://127.0.0.1:5191/
```

Output measurements do not establish listening quality or match the unavailable
reference clip. Physical touch, MIDI/pedals and packaged desktop launches were not
tested locally. The software-rendered smoke run displayed existing Pristine
96 kHz overload notices, so glitch-free real-time playback is not established by
these checks. Rapier free roll was exercised; Keep rolling is covered by the
existing fallback-simulation tests rather than a new physical-device check.

The release workflow packages all three desktop platforms and validates updater
metadata and package hashes. Release work is complete only after GitHub downloads
and the live website serve the same version; follow [HANDOFF.md](HANDOFF.md#6-release-and-website-routine).
