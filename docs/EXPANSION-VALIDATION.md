# Orograph 2.0 validation

Checked 2026-10-03. This report concerns Orograph's implementation of the owner's
feature request. It does not independently test or compare another instrument.

## Functional evidence

The final local suite passed **1,229 tests in 100 files**, including import identity,
minimap caching and desktop updater checks. Web and standalone HTML builds passed.
Focused tests cover the following contracts:

* Legacy parameter, terrain, path and MIDI source identifiers stay stable. Sixteen
  Steps LFO cells expand into paired values without changing their duration.
* Both subs retain their expected gain across unison 1, 7 and 8. Seven waveform
  choices remain distinct. White, pink, blue and brown noise have the expected
  measured spectral slopes in the tested 250 Hz to 8 kHz band.
* Eleven partial profiles are distinct and interpolate continuously. Pluck tuning
  stays within 3 cents for tested notes from 55 Hz to 1,760 Hz at 44.1/48/96 kHz.
  Added filters remain finite at tested parameter extremes and resonance settings.
* Forty target envelopes and controller banks persist through patches, scenes and
  sessions. MIDI expression, sustain level and breath reach modulation even when
  the corresponding CC is learned or mapped; note-sustain retains existing routing.
* Every track effect has a distinct tested response. Ten routing layouts pass
  dry identity, impulse, spectral and dynamics checks. Effects follow stable track
  identities, continue their tails after note release and clear on Panic.
* Favorite banks, factory-only banks, metadata, PCM loops and four-channel image
  planes round-trip. Persistence tests cover blocked/failed databases, transaction
  failure, queued writes, retries and edits before asynchronous library loading.
* Deferred terrain and noise imports follow the original track on reorder and
  reject a removed or replaced track, including batched reuse of its identifier.

The browser script is `tests/e2e/expansion.cjs`. It uses real PNG imports, terrain
regeneration and the AudioWorklet, with generated MIDI/audio fixtures. It also
forces localStorage quota failure and reloads the larger session from IndexedDB.
The dev browser passed all these stages with no console/page errors. Its real image
channel/polar regeneration took 141 ms. A 10.64 MB session containing three complete
RGBA terrains and a custom noise loop survived forced localStorage quota failure and
reload through IndexedDB. The 390-pixel phone layout had no horizontal overflow or
overlapping viewport controls. The final compiled standalone HTML also passed the full expansion script, with no
console/page errors and 216 ms measured channel/polar regeneration. The eight Settings
tabs and update download link fit the 390-pixel phone layout without overflow.

## Measured processing bounds

`node --expose-gc dev/dsp/bench-orograph2.mjs` renders warmed 128-sample blocks at
48 kHz. The deadline is **2.667 ms**. These Node measurements indicate cost on the
local machine; they are not a browser deadline or all-computer guarantee.

| Session | Mean block | 95th percentile |
|---|---:|---:|
| Legacy 16 voices, unison 2 | 0.599 ms | 0.735 ms |
| One complex voice, unison 8 | 0.349 ms | 0.400 ms |
| Eight complex voices, unison 8 | 2.638 ms | 2.777 ms |
| Eight complex voices plus all 40 own envelopes/controller banks | 3.515 ms | 3.874 ms |

`node dev/bench-track-fx.mjs` measured 63 to 128 ms of processing per second of
rendered audio for four tracks with four active effects each, and 305 to 514 ms
for sixteen tracks with four active effects. Some maximum-rack blocks exceeded
2.667 ms. Simultaneously maximizing voice count, unison, modulation and heavy
racks can exceed one audio thread's budget. Settings > Audio reports measured
worklet load; reduce simultaneous notes, unison, effects or quality when needed.

## Browser rendering performance

A fresh paired Chrome test substituted only the previous minimap module, keeping the
current engine, terrain sources, viewport and sustained three-note chord identical.
The six-second scene used a moving morph LFO, warped terrain, High visual quality,
a 1972 by 924 canvas and ANGLE Metal on an Apple M1 Pro.

| Render-loop measurement | Previous minimap | Optimized minimap |
|---|---:|---:|
| Main-thread work per frame | 3.510 ms | 1.391 ms |
| Rendered frames | 363 | 363 |
| Frame rate | About 60 fps | About 60 fps |
| Draw calls / triangles | 29 / 314,977 | 29 / 314,977 |

This is approximately **60% less JavaScript time per frame** in this scene, rather than
a frame-rate claim for every machine. Terrain tables remained 512 by 512, with finite
audible AudioWorklet output and no page errors. The sampled load report had zero
overruns; its millisecond clock is coarse, so this is not an endurance or dropout guarantee.

`dev/profile-browser.cjs` reproduces the fixture. The minimap caches warped A/B source
grids while blending morph and terrain fades live. Its colour lookup stays within one
8-bit channel unit of direct sRGB conversion. Source reinstall, channel/mapping changes
and warp invalidate the cache; palette, lighting and lift remain live. Cache memory is
bounded. The change adds no frame cap, resolution reduction or audio-setting adjustment.

## Scope and remaining limits

The 320 images and vinyl/waves/city loops are original procedural material, not
photographs or field recordings. Users can import recorded sources. Filters are
original digital colours, partial profiles are ratio banks, and pluck decay is
nominal. Nonlinear shaping and phase modulation are not universally alias-free.
The tests establish their cases rather than exact analog circuit behaviour.

Physical guitar, pedalboard, microphone and MPC hardware remain untested. Software
fixtures and package builds do not certify hardware accuracy or native execution
on every platform. Desktop update policy can be tested locally; a real upgrade
from 2.0 to a later published version requires that later release.

## Desktop updater checks

Fifty-one focused controller/UI/packaging checks passed. They cover opt-in timers,
manual formats, trusted main-frame IPC, corrupt preferences, concurrent requests,
download/hash/signature errors, progress, explicit installation and failed saves.

A native Mac Electron probe loaded the final web build through `app://orograph`,
verified the narrow preload bridge and Settings > Updates, and confirmed all automatic
preferences were off. Context isolation and the renderer sandbox were enabled, with
no Node globals. Its network log contained no default updater request. This was a
development-shell integration test; package builds and a later real update are separate
checks. CI validates generated platform manifests against exact package SHA512 hashes
and verifies each packaged public GitHub provider configuration before publishing.

Current Mac builds use manual downloads because automatic installation requires a
suitable signing identity. Windows NSIS and Linux AppImage support the updater; portable
Windows and Linux archives use notices/manual replacement. Older downloads need one
manual upgrade to obtain these controls. Checks and background downloads are optional;
restart/install stays explicit and waits for durable session/library saves.

Sources: [electron-builder updater documentation](https://www.electron.build/v26/docs/features/auto-update/)
and [Electron platform requirements](https://www.electronjs.org/docs/latest/api/auto-updater).
