# Orograph architecture and module contracts

Orograph is an original, clean-room wave terrain synthesizer. A closed **path**
(orbit) is traced across a 2D height map (**terrain**) once per oscillator cycle;
the height under the moving point is the audio sample. Pitch = how fast the path
is traced. Timbre = the shape of the land the path crosses. The user places the
**dot** (the orbit centre) anywhere on a 3D map.

This document is the contract between modules. Everything here is binding for
implementers; anything not specified is the implementer's choice.

## Stack

* Vite 8, plain ES modules (no framework, no TypeScript), `three@0.186`, `@dimforge/rapier3d-compat@0.21` (lazy-loaded), Web Audio AudioWorklet, Web MIDI.
* Output targets: `dist/` (normal web build, relative `base: './'`, deployable under any sub-path such as `/music/orograph/`), `dist-single/index.html` (one offline HTML file, `npm run build:single`), Electron desktop app (`electron/`, `npm run dist`).
* Tests: `vitest` (Node) in `tests/**/*.test.js`; browser end-to-end checks in `tests/e2e/*.cjs` driven by the globally installed Playwright (`/opt/node22/lib/node_modules/playwright`, Chromium at `/opt/pw-browsers`). Launch Chromium with `--autoplay-policy=no-user-gesture-required` and for WebGL in headless use `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`.

## Directory ownership

| Path | Owner | Contents |
|---|---|---|
| `src/core/params.js`, `src/core/store.js`, `src/dsp/catalog.js` | architect (frozen contract; extend only by appending) | parameter registry, store, terrain/path catalog |
| `src/dsp/` (except catalog) | DSP | `terrains.js`, `paths.js`, `terrain-math.js`, `dsp-core.js`, `worklet.js` |
| `src/audio/` | Audio host | `engine.js`, `fx.js`, `terrain-manager.js`, `importers.js`, `recorder.js`, `wav.js` |
| `src/visual/` | Visuals | `visuals.js` + helpers (scene, terrain mesh, path line, dot, physics, sky, post) |
| `src/ui/`, `src/styles/`, `index.html` | UI | layout, knobs, panels, keyboard, sequencer grid, dialogs, theme |
| `src/music/`, `src/midi/`, `src/presets/` | Music | router/arp, sequencer/transport, MIDI, factory patches & scenes, preset storage |
| `electron/`, `.github/`, `vite.config.js`, `public/`, `README.md` | Packaging | desktop app, CI, icons, PWA manifest |
| `src/main.js` | architect / integrator | bootstraps everything |

Never edit another owner's files; if you need something from another module, code against the API below and note the requirement in your final report.

## Coordinates (shared by audio and visuals)

* Terrain space is the unit torus: `u, v ∈ [0, 1)`, wrapping at the edges. Every terrain table tiles seamlessly.
* World space (three.js): the terrain is a square of side `W = 10` centred on the origin, `x = (u - 0.5) * W`, `z = (v - 0.5) * W`, height `y = h * H` with `H = 1.6` at Lift = 1. Top view: `u` grows to the right, `v` grows towards the viewer (down the screen).
* Terrain value `h ∈ [-1, 1]`; tables are normalised so `max|h| = 1` and the mean is 0.

### Path transform (identical in audio and visuals)

`pathPoint(shape, t, order, param, out)` (in `src/dsp/paths.js`) writes a unit-scale point `out.x, out.y ∈ [-1, 1]` for `t ∈ [0, 1)`; every path is closed (`t = 0` and `t = 1` coincide) and continuous. Then:

```
ax = 2^(stretch * 1.5),  ay = 2^(-stretch * 1.5)
px = out.x * ax * size,  py = out.y * ay * size
θ  = radians(rotate + 360 * spinPhase)          // spinPhase advances at `spin` Hz, part-global
u  = centerX + px cosθ − py sinθ
v  = centerY + px sinθ + py cosθ                  // wrap u, v mod 1 for lookups
```

### Warp (identical in audio and the terrain shader)

```
w  = warp * 0.06
u' = u + w * ( sin(2π·2v) + 0.5 sin(2π(3v + 2u)) )
v' = v + w * ( sin(2π·2u) + 0.5 sin(2π(3u − 2v)) )
```

### Morph

`h(u, v) = (1 − morph) · A(u', v') + morph · B(u', v')`, bilinear lookups with wrap.

Lift and Fold are audio waveshaping after the lookup (DSP's choice of curve); visuals scale the displayed height by `min(lift, 2.5)` and may hint fold with colour.

## Parameters and state

See `src/core/params.js`. State shape (persisted):

```
{ version, global: {paramId: number}, parts: [ { name, color, patchName,
    params: {paramId: number},                 // plain units, enums are integer indices
    mods:   {paramId: {lfoShape, lfoRate, lfoSync, lfoDiv, lfoDepth, envDepth, retrig}},
    seq:    {enabled, rate, length, baseOctave, steps: [{on, degree, octave, vel, gate, slide, accent}]},
    arp:    {mode, rate, octaves, gate, hold},
    dot:    {mode: 0 Pin | 1 Roll | 2 Drift, gravity, friction, driftSpeed},
    userTerrain: {A: UserTerrain|null, B: UserTerrain|null} } x4 ] }
```

Non-persisted `ui` branch: see `DEFAULT_UI` in `src/core/store.js`.

`UserTerrain = { name, kind: 'image'|'wavetable', w, h, mirror: 0|1, data: base64 Uint8Array (w*h, row-major, 0..255) }`.
For `kind: 'wavetable'` each row is one single-cycle frame resampled to `w` samples (periodic in x); `mirror` reflects the non-periodic axis (or both axes for images) so the table tiles.

Modulation is evaluated in **normalised** space: `n = clamp(toNorm(def, base) + lfo·lfoDepth + env2·envDepth (+ modwheel on morph), 0, 1)`, then `fromNorm(def, n)`. LFO output is bipolar −1..1 (S&H / Drift too). `rotate` wraps instead of clamping. `centerX/centerY` wrap instead of clamping. Mod wheel adds `+wheel · 1.0` normalised to `morph`. Pitch bend: ±`bendRange` semitones.

## Audio worklet protocol

Processor name: `'orograph'`. Constructed with `numberOfInputs: 0, numberOfOutputs: 3, outputChannelCount: [2, 2, 2]` (dry, delay send, reverb send — per-part level/pan/sends/mute/solo applied inside the worklet), `processorOptions: { sampleRate }`.

Main → worklet (`node.port.postMessage`):

| message | meaning |
|---|---|
| `{t:'params', part, p:{id: value, ...}}` | plain values, any subset of `PART_PARAMS` |
| `{t:'mods', part, m:{paramId: {...MOD fields}}}` | any subset |
| `{t:'global', p:{tempo, ...}}` | any subset of `GLOBAL_PARAMS` the worklet needs (tempo for synced LFOs) |
| `{t:'terrain', part, slot: 0 (A) \| 1 (B), levels: [{size, data: Float32Array}]}` | mip chain, level 0 = full res (512), each next level half size; buffers transferred |
| `{t:'noteOn', part, note, vel, time}` | `time` in AudioContext seconds; `<= currentTime` means now. `note` may be fractional |
| `{t:'noteOff', part, note, time}` | |
| `{t:'allOff', part?}` | release all (part omitted = every part); `{t:'panic'}` hard-silences |
| `{t:'bend', part, v}` / `{t:'wheel', part, v}` | −1..1 / 0..1 |
| `{t:'watch', part}` | which part to report telemetry for |
| `{t:'transport', playing, beatTime, beat}` | optional: anchors synced LFO phase to the sequencer |

Worklet → main, about 60 times per second:

```
{ t:'tele', part, n: {modParamId: normalisedValue, ...},   // modulated values of the watched part's most recent active voice (LFO-only when idle)
  spinPhase, voices: [{id, note, amp}], peak: [L, R], activeVoices: [count per part] }
```

Two protocol extras: a single port message may be an **array** of messages (applied in order), and `processorOptions.init` may carry an array of messages applied in the constructor (needed for OfflineAudioContext renders, which start before port messages arrive).

`dsp-core.js` exports `class OrographDSP { constructor(sampleRate); handleMessage(msg); process(outL, outR, dlyL, dlyR, revL, revR, frames, currentTime); }` plus a `postMessage` hook, so the same engine runs inside the AudioWorklet, inside a ScriptProcessorNode fallback, and in Node tests.

## Audio host API (`src/audio/engine.js`)

```js
const engine = await createEngine({ store });     // builds context + graph, does NOT need a gesture
await engine.start();                               // resume() on user gesture
engine.context; engine.analyser; engine.mode         // mode: 'worklet' | 'script'
engine.noteOn(part, note, vel = 0.8, time = 0); engine.noteOff(part, note, time = 0)
engine.allNotesOff(part?); engine.panic(); engine.bend(part, v); engine.wheel(part, v)
engine.on('terrain', ({part, slot, size, data}) => {})  // slot 'A' | 'B', data = Float32Array level 0
engine.on('tele', tele => {})
engine.getTerrain(part, slot) -> {size, data} | null
engine.importTerrainFile(part, slot, File) -> Promise   // image or .wav; sets userTerrain + terrain enum 'user'
engine.startRecording(); engine.stopRecording() -> Promise<Blob>  // 24-bit stereo WAV
engine.level() -> 0..1 smoothed output level (for visuals)
```

The engine subscribes to the store and forwards every change itself (params, mods, global, terrain regeneration with debounce, watched part = `ui.selectedPart`). Effects: stereo ping-pong delay (tempo-synced `delayDiv`, feedback, tone, return), algorithmic-IR convolution reverb (size, damp, return), master chorus, warmth (saturation), limiter, master volume, analyser.

## Features added after v0.1 of this contract

* **Laps** (`laps`, 1..8, modulatable): the path is traced `laps` times per oscillator cycle and restarted at every cycle boundary (hard sync; fractional values give sync sweeps). The restart is band-limited with a polyBLEP correction.
* **Pace** (`pace`, −1..1, modulatable) with **Curve** (`paceShape`: Bend, Skew, Pinch): monotonic phase distortion of the cycle phase before Laps: `t = frac(laps · g(φ))`. Helpers `paceWarp`, `paceSpeed`, `syncPhase` are exported from `src/dsp/` for the visuals.
* **Sub** (`sub`, 0..1): one sine an octave below each voice, before the filter.
* **Dot locks**: sequencer steps carry `lock`, `lx`, `ly`; `seq.lockGlide` sets the glide time as a fraction of a step. The music transport glides the dot (wrap-aware) when a locked step plays, writing `centerX/centerY` with `{source: 'lock'}`; any other source cancels the glide. `ui.lockRecord` records dot moves into the sounding step while playing.
* **Harmonic bars**: the UI shows the magnitudes of the first harmonics of the exact single cycle (terrain sampled along the current path), next to the cycle view.

## Visuals API (`src/visual/visuals.js`)

```js
const visuals = await createVisuals(containerEl, { store, engine });
visuals.resize(); visuals.setQuality('high'|'medium'|'low'); visuals.dispose();
```

Renders the selected part's terrain (morph/warp/lift driven by telemetry), its path (live, modulated) and the dot. Pointer: click/tap the terrain to move the dot, drag the dot, orbit-drag the empty space to rotate the camera, wheel to zoom. Writes `parts.N.params.centerX/centerY` with `{source:'visual'}`. Roll mode: Rapier marble on a heightfield (fallback: built-in integrator), flick to throw, wraps at edges. Drift mode: smooth wander. Theme aware (see below). Must keep 60 fps on integrated GPUs at `quality: 'medium'`.

## Music API

```js
const music = createMusic({ store, engine });
music.router.noteOn(part, note, vel); music.router.noteOff(part, note); music.router.allNotesOff(part?)
music.transport.play(); stop(); toggle(); isPlaying(); onStep((part, stepIndex, time) => {})
music.randomizePattern(part); music.clearPattern(part); music.shiftPattern(part, ±1)
const presets = createPresets({ store });   // src/presets/presets.js
presets.patches(); presets.scenes(); presets.loadPatch(part, idOrObj); presets.savePatch(part, name)
presets.loadScene(idOrObj); presets.saveScene(name); presets.deleteUser(kind, name)
presets.exportJSON() -> Blob; presets.importJSON(File); presets.randomizePatch(part)
const midi = await createMidi({ store, router: music.router, engine });
midi.supported; midi.inputs(); midi.setInput(id | 'all'); midi.setChannelMode('omni' | 'multi'); midi.learn(paramPath)
```

## UI API

```js
createUI(rootEl, { store, engine, visuals, music, presets, midi });
```

## Theme contract

* `document.documentElement.dataset.theme` is always the resolved theme, `'dark'` or `'light'`. `ui.theme` holds the preference (`'system' | 'dark' | 'light'`), persisted in `localStorage['orograph.theme']`.
* Whenever the resolved theme changes the UI dispatches `window.dispatchEvent(new CustomEvent('orograph:theme', { detail: { theme } }))`.
* CSS tokens live on `:root[data-theme=dark]` / `:root[data-theme=light]` in `src/styles/theme.css`. Part colours are set as `--part` on the part's container.
* Visuals read `dataset.theme` at start and listen for `orograph:theme` to restyle sky, fog, terrain palette, bloom strength.

## Quality bar

* No NaN/Inf/denormal output, hard limit at the master, no clicks on note on/off or parameter jumps (smooth everything).
* Band-limited: oversampled oscillator and mip-mapped terrain so high notes do not alias badly.
* 16 simultaneous voices with unison 2 must run in under 35% of one core.
* Every control reachable by mouse, touch and keyboard; visible focus; respects `prefers-reduced-motion`.
