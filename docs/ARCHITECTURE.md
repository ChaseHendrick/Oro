# Oro architecture and module contracts

Oro is an original, clean-room wave terrain synthesizer. A closed **path**
(orbit) is traced across a 2D height map (**terrain**) once per oscillator cycle;
the height under the moving point is the audio sample. Pitch = how fast the path
is traced. Timbre = the shape of the land the path crosses. The user places the
**dot** (the orbit centre) anywhere on a 3D map.

This document is the contract between modules. Everything here is binding for
implementers; anything not specified is the implementer's choice.

## Stack

* Vite 8, plain ES modules (no framework, no TypeScript), `three@0.186`, `@dimforge/rapier3d-compat@0.21` (lazy-loaded), Web Audio AudioWorklet, Web MIDI.
* Output targets: `dist/` (normal web build, relative `base: './'`, deployable under any sub-path such as `/music/oro/`), `dist-single/index.html` (one offline HTML file, `npm run build:single`), Electron desktop app (`electron/`, `npm run dist`).
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
| `src/agent/`, `scripts/oro-score.mjs`, `scripts/oro-mcp.mjs` | Agent API (2.17) | `window.oro`, the `postMessage` bridge, the score command line and MCP server |
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
{ version, global: {paramId: number}, parts: [ { id, name, color, patchName,
    params: {paramId: number},                 // plain units, enums are integer indices
    mods:   {paramId: {...MOD_DEFAULT, steps: [32 values]}},
    seqOn: 0|1, activePattern: index,
    patterns: [ {id, name, rate, length, baseOctave, lockGlide, steps: [{on, degree, octave, vel, gate, slide, accent, lock, lx, ly}]} ],
    arp:    {mode, rate, octaves, gate, hold, rhythm},
    dot:    {mode: 0 Pin | 1 Roll | 2 Drift, gravity, friction, driftSpeed},
    userTerrain: {A: UserTerrain|null, B: UserTerrain|null},
    trackFx: {routing, sidechain, slots: [four FX slots]}, noiseRecording: PCM16Recording|null } x 1..MAX_PARTS ] }
```

### Tracks: MAX_PARTS vs the live list (introduced in v1.3; current STATE_VERSION 5)

`state.parts` is a variable-length list of 1..`MAX_PARTS` (16) tracks, each with a stable
string `id` (t1, t2, ...; never reused within a list). It is the only source of truth for
which tracks exist and in which order. `NUM_PARTS` is gone; the rule for every per-track
array is:

* **Allocation, sized `MAX_PARTS`, mapped by index**: the DSP's parts, the router's held
  notes and arps, the transport's step state, dot-lock glides, the terrain manager's slots,
  the engine's controllers and marble readings, the visuals' height fields and terrain cache,
  the dot simulation, MIDI channel maps (`multiChannels` / `outChannels`, one per track
  position, track i on channel i), telemetry, the tab elements in the top bar.
* **Active, the live list (`partCount(store)` / `parts.length`)**: everything shown, played,
  scheduled or sent: tabs and mixer strips, sequencer and arp scheduling, Layer key mode,
  MIDI routing, bounce stems, terrain generation, the sync's params, snapshot and flushes.

When the list changes shape (add, remove, duplicate, move, scene load), `src/core/tracks.js`
`trackPerm(oldIds, newIds)` gives a permutation of all `MAX_PARTS` slots (`perm[new] = old`):
kept tracks keep their slot contents, new tracks get the slot that has been unused longest
(listed in `fresh`), removed tracks go to the back. Every module computes the same
permutation from the same ids through `watchTracks(store, fn)` and moves its per-slot state
with `permute()`. `src/audio/sync.js` posts `{t:'tracks', count, perm, fresh}` to the DSP at
once, ahead of anything else about the new list; the DSP moves its Part objects (voices,
envelopes, LFO phases and terrain tables move with them, so a reorder is sample-identical),
resets fresh parts, releases parts that left the list and fades them out over 80 ms, after
which they are dormant and skipped before any work. A scene load passes
`{ replaceTracks: true }` in the store meta, so all its tracks start in fresh slots while the
old ones fade. The store ignores writes below `parts.N` for N >= `parts.length`.

Patterns: a track plays `patterns[activePattern]` while `seqOn` is set; `activeSeq(part)`
gives that pattern with `enabled` = seqOn, `patternPath(store, p)` its store path. Older
saves are migrated: four parts become tracks t1..t4 and each `seq` becomes pattern p1.

Non-persisted `ui` branch: see `DEFAULT_UI` in `src/core/store.js`.

`UserTerrain = { name, kind: 'image'|'wavetable'|'audio', w, h, mirror: 0|1, data: base64 Uint8Array (w*h, row-major, 0..255) }`.
For `kind: 'wavetable'` each row is one single-cycle frame resampled to `w` samples (periodic in x); `mirror` reflects the non-periodic axis (or both axes for images) so the table tiles.

Modulation is evaluated in **normalised** space: `n = clamp(toNorm(def, base) + lfo·lfoDepth + envelope·envDepth + four controller slots (+ modwheel on morph), 0, 1)`, then `fromNorm(def, n)`. LFO output is bipolar −1..1 (S&H / Drift too). `rotate` wraps instead of clamping. `centerX/centerY` wrap instead of clamping. Mod wheel adds `+wheel · 1.0` normalised to `morph`. Pitch bend: ±`bendRange` semitones.

## Audio worklet protocol

Processor name: `'orograph'`. Constructed with `numberOfInputs: 0, numberOfOutputs: 4, outputChannelCount: [2, 2, 2, 2]` (dry, delay send, reverb send and pedal send; per-part level/pan/sends/mute/solo are applied inside the worklet), `processorOptions: { sampleRate, measureLoad: true }` for real-time audio. Offline constructors omit load measurement.

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
| `{t:'trackFx', part, fx}` | four-slot rack, routing and stable sidechain ID |
| `{t:'noiseRecording', part, data: Float32Array|null}` | mono recording resampled to the worklet rate |
| `{t:'expression', part, v}` / `{t:'sustainLevel', part, v}` / `{t:'breath', part, v}` | normalized MIDI CC11/64/2 controller sources |
| `{t:'watch', part}` | which part to report telemetry for |
| `{t:'transport', playing, beatTime, beat}` | optional: anchors synced LFO phase to the sequencer |

Worklet → main, about 60 times per second:

```
{ t:'tele', part, n: {modParamId: normalisedValue, ...},   // modulated values of the watched part's most recent active voice (LFO-only when idle)
  spinPhase, voices: [{id, note, amp}], peak: [L, R], activeVoices: [count per part] }
```

Two protocol extras: a single port message may be an **array** of messages (applied in order), and `processorOptions.init` may carry an array of messages applied in the constructor (needed for OfflineAudioContext renders, which start before port messages arrive).

`dsp-core.js` exports `class OroDSP { constructor(sampleRate); handleMessage(msg); process(outL, outR, dlyL, dlyR, revL, revR, frames, currentTime); }` plus a `postMessage` hook, so the same engine runs inside the AudioWorklet, inside a ScriptProcessorNode fallback, and in Node tests.

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

## Round D additions (research-brief features)

All new parameters and state fields are defined in `src/core/params.js` / `migrate.js` / `store.js`. Summary:

| Area | Contract |
|---|---|
| Path | `traverse` (Natural / Even: Even = constant arc-length speed using cached arc-length tables), `direction` (Forward / Ping-pong: t goes 0→1→0 within each cycle, applied after Pace and Laps), `noteSize` (−1..1: size × 2^(noteSize · (note − 60) / 24), clamped to 0..0.5) |
| Voice | `air` (noise layer after the DC blocker, follows the amp envelope), `airTone` (−1 dark … +1 bright, a tilt filter on the noise) |
| Filter | `filterType` adds 5 = Comb (cutoff = comb frequency, resonance = feedback, `formant` = positive/negative comb blend) and 6 = Vowel (formant filter morphing A–E–I–O–U with `formant`, resonance sharpens, cutoff shifts the formants ±1 octave around 1 kHz). `formant` is modulatable. |
| LFO | shape 6 = `Steps`: 16 values in `mods[id].steps` (−1..1), held per step, 2 ms slew |
| Links | `parts.N.links = [{src, dst, amt, curve}]` (≤ 8). `src` indexes `LINK_SOURCES`, `dst` is any modulatable param id, `amt` −1..1, `curve` indexes `LINK_CURVES`. Contribution `amt · curve(srcValue)` is added in normalised space, per voice, after LFO/Env. The default link (Mod Wheel → Morph, +1) replaces the old hard-wired wheel→morph. |
| Macros | `global.macro1..4` (0..1) are Link sources |
| Ceiling | `global.ceiling` (−6..0 dB) sets the master limiter ceiling |
| Quality | `ui.audioQuality`: `eco` (1× oversampling, mip bias +1), `standard` (2×, current), `high` (4×, two half-band stages), `pristine` (2× plus per-voice band-limited single-cycle tables refreshed every ~256 samples with crossfade when the orbit is not audio-rate modulated; falls back to standard per voice otherwise), `raw` (2×, mips off: deliberate aliasing). Device setting, persisted in `orograph.settings`. |
| Dot | `dot.mode` adds 3 = Explore, 4 = Tour. `dot.gravity` 0..1 → 0..2 g, `bounce`, `tiltX/tiltY` (lean the world), `flick` (throw strength), `exploreRate/exploreRange/exploreNotes`, `waypoints [{x, y, beats}]` (≤ 8), `tourMode` (Loop / Ping-pong / Once). |

### Worklet protocol additions

| message | meaning |
|---|---|
| `{t:'links', part, links:[...]}` | replace the part's links |
| `{t:'pressure', part, v, note?}` | channel pressure (all voices) or per-note pressure when `note` given (poly AT / MPE) |
| `{t:'slide', part, v, note?}` | MPE slide (CC74) 0..1 |
| `{t:'marble', part, speed, height}` | from the visuals' physics, ~30 Hz (speed 0..1, height −1..1) |
| `{t:'quality', mode}` | `'eco' \| 'standard' \| 'high' \| 'pristine' \| 'raw'` |
| `{t:'params', part, p, time?, ramp?}` | when `time` is given the change is applied sample-accurately at that AudioContext time; `ramp` (s) glides to the new values (wrap-aware for rotate/centerX/centerY). Used by dot locks and offline bounces. |

Telemetry `tele.n` includes Links contributions. `tele.terrainHeight` = height under the watched part's modulated dot.

### Engine API additions

```js
engine.pressure(part, v, note?); engine.slide(part, v, note?); engine.marble(part, speed, height)
engine.setQuality(mode)                                   // also follows store ui.audioQuality
engine.bounce({ bars = 4, stems = false, fx = true, tailSeconds = 2, events }) -> Promise<{ mix: Blob, stems: Blob[] }>
  // OfflineAudioContext render of `events` (from music.renderEvents) through the worklet + FX graph;
  // stems renders each part solo (with its own sends through the FX). 24-bit WAV blobs. Progress via engine 'bounce' events {done, total}.
engine.importTerrainFile(part, slot, file, { channel = 'luma' | 'r' | 'g' | 'b', smooth = 0.3, tile = 'mirror' | 'wrap' })
  // 16-bit grayscale PNG heightmaps (DEMs) are decoded at full precision (own PNG parser + DecompressionStream)
```

### Music API additions

```js
music.preview(part = 'sel')                    // play a short tempo-synced phrase on the part (keyboard shortcut P)
music.exploreNote({ part, kind: 'peak'|'valley', height, x, y })  // Explore mode: in-key note from height, range dot.exploreRange octaves
music.renderEvents(bars, { parts }) -> [{ time, msg }]  // sequencer/arp notes + dot-lock param ramps for offline bounce, times from 0
music.on('preview', fn)
```

MIDI: channel pressure and poly aftertouch → `engine.pressure`; MPE mode (setting `mpe: true`, lower zone, member channels 2–16 → selected part or Layer): per-note pitch bend (±48 st), CC74 slide → `engine.slide`, pressure → `engine.pressure`. Macros and any global param are MIDI-learnable.

### Visuals API additions

```js
visuals.on('extremum', fn({ part, kind, height, x, y }))   // Explore mode: the marble passed a local peak or valley
visuals.setRenderStyle('relief'|'wire'|'contour'|'heat'|'points'|'normals'); visuals.setPalette(i); visuals.palettes() -> [{ name, dark, light }]
```

Visuals send `engine.marble(part, speed, height)` from the physics, draw dot-lock markers (numbered, flashing on 'step' events with a lock), Tour waypoints (editable when `ui.editWaypoints`: click adds, drag moves, right-click deletes), the base orbit (thin) and modulated orbit (bright), per-voice orbits when voices differ, and a comet trail whose density follows `paceSpeed`. Dot gestures: Shift-drag = Size, Alt-drag = Rotate, wheel over the dot = Size, `[` / `]` = Size when the map has focus.

## v1.2 looper and Resample

| Module | Contract |
|---|---|
| `src/audio/looper-core.js` | `LooperCore(sampleRate, { emit })`: pure looper logic (`handle(msg, frame)`, `process(inL, inR, outL, outR, n, frame0)`), shared by the worklet and Node tests. States `empty / armed / record / play / overdub / paused`. Float32 buffers at the context rate; seam, overdub, start/stop and undo fades of `FADE_SECONDS` (8 ms); `softLimit` on stored samples; undo snapshots per overdub layer (`MAX_LAYERS` 8, `UNDO_BUDGET_BYTES`). |
| `src/audio/looper-worklet.js` | Processor `'orograph-looper'`: 1 stereo input, 1 stereo output. |
| `src/audio/looper.js` | `createLooper(ctx, { input, output, worklet })`; `engine.looper` (see below). |
| `src/audio/resample.js` | `resampleToWavetable(L, R, sampleRate, { slice: 'auto'\|'tempo'\|'root', tempo, rootNote, name })` -> `{ ok, userTerrain, mode, detail }`; `nextResampleName(state)`. |
| `src/ui/looper-control.js`, `src/ui/looper-panel.js` | The shared UI control (`ctx.looper`), the LOOP dock tab and the top-bar loop button. Device settings in `localStorage['orograph.looper']`. |

Graph: `fx.masterTap` (master volume, after every effect) -> looper -> `fx.masterReturn`
(the 1/ceiling stage before the limiter). The return is downstream of the tap, so the loop
never reaches its own input; the recorder (post-limiter) records loop and live together.
Offline bounces do not include the looper.

Worklet messages: `{t:'main'|'stop'|'undo'|'clear'}`, `{t:'bars', v}`, `{t:'volume', v}`,
`{t:'mute', v}`, `{t:'feedback', v}`, `{t:'transport', playing, beatTime, beat, spb}` (forwarded
by `engine.setTransport`; bars are 4 beats and beat 0 is a bar line), `{t:'get', id}` ->
`{t:'loop', id, L, R, len}`, `{t:'capture', id, bars | frames}` -> `{t:'captured', id, L, R}`.
Out: `{t:'state', ...}` on changes, `{t:'pos', ...}` about 30 times a second.

```js
engine.looper.available; engine.looper.reason
engine.looper.main(); stop(); undo(); clear(); setBars(n); setVolume(v); setMute(on); setFeedback(v)
engine.looper.getLoop() -> Promise<{ L, R, len, sampleRate } | null>
engine.looper.capture({ bars }) -> Promise<{ L, R, len, sampleRate } | null>
engine.looper.exportWav({ format: 'pcm24' | 'float32' }) -> Promise<Blob | null>   // 24-bit uses TPDF dither
engine.looper.status(); engine.looper.on('change' | 'pos' | 'info' | 'error', fn)
```

MIDI learn accepts action targets `{ scope: 'action', id }` with ids from `LEARNABLE_ACTIONS`
(`looper.main`, `looper.stop`, `looper.undo`, `looper.clear`, `looper.mute`, `looper.resample`);
a mapped CC rising past 64 emits `midi.on('action', { id })`. Saved session state is unchanged
(resampled terrains are ordinary `userTerrain` wavetables with `lo` planes).


## Experimental guitar Chords (v1.5)

`guitarMode: 'single' | 'chords'` is a per-computer pedal rig preference. Single is
its default and remains mandatory for Voice plays notes. `createGuitarAnalysis`
shares detector selection, resets and releases. Single-note analysis stays in the
AudioWorklet; chord sample batches go to a dedicated Worker. The ScriptProcessor
fallback uses that same Worker when available. `src/pedals/chords.js` is a pure generated-signal-tested
spectral detector; no physical guitar accuracy has been established.

Chord pitch telemetry is `{mode:'chords', notes:[MIDI], heard:[MIDI], voiced,time}`;
Single keeps `{mode:'single',freq,midi,clarity,voiced,time}`. Chords emits individual
noteOn/noteOff events and no channel-wide bends. The driver keeps each held note's
source route, follows track reorders and removes entries on global or per-track
Panic. Mode changes release held notes through the router, respecting sustain.
Capture remains one held note, regardless of tracking mode.


## Oro 2.0 additions

The append-only parameter registry is now 88 part parameters with 40 modulation targets.
Mod records retain flat numeric fields, 32 steps, six-stage envelope settings and four
controller source/depth/curve groups. Migration doubles old 16-step cells. Five appended
filter types and oscillator helpers preserve the legacy fast paths at default amounts.

`src/dsp/oscillator-extras.js`, `analog-filters.js` and `modulation-extras.js` contain the
new pure DSP. `track-fx-config.js` owns the persistent four-slot rack schema, normalized
controls and catalogue; `track-effects.js` processes each part after decimation. Sidechain
sources resolve stable track IDs through store sync. Mix/named-track detectors read
preceding-block raw levels; self detection uses the current rack input.

`user-terrain.js` validates image/audio/wavetable sources and optional four-channel planes.
`terrain-library.js` generates the original image catalogue and PNGs. Worker cache keys
include channel blend and mapping. The visual normal shader is render-style index 5.

`noise-recording.js` packs imported mono loops as PCM16 base64 and resamples for realtime
and offline render rates. `durable-storage.js` keeps legacy small localStorage documents
and falls back to IndexedDB for larger JSON. Boot awaits session/preset readiness. JSON
exports carry all source planes, rack state and recordings. Favourite references are kept
in the library, with names remapped on portable import. Camera captures belong to device
preferences and are validated by `src/visual/camera-view.js`.


## Desktop update contract

`electron/updates.cjs` owns the update state machine with injected network, updater and
timer dependencies. All automatic preferences default to false. `electron/updates-host.cjs`
provides atomic preference storage and main-frame IPC validation. The sandboxed preload
exposes only `window.orographDesktop.updates`; the renderer receives no Node or generic IPC
access. `src/ui/updates-tab.js` awaits `ctx.prepareUpdate()` before requesting an explicit
restart. That callback flushes and awaits both session and preset storage.

NSIS installed copies and AppImage copies use electron-updater. Other current packages
use the fixed public GitHub release endpoint and manual download link. macOS lacks the
signing identity Squirrel.Mac requires, so by default it is a manual path. From 2.11 the
opt-in `autoInstall` preference uses `electron/mac-update.cjs` instead: it downloads the
release zip for `process.arch`, verifies its sha512 against `latest-mac.yml`, unpacks it
with `ditto`, checks `CFBundleShortVersionString`, and on quit or Restart now starts a
detached shell script that swaps the bundle after the app exits (restoring a backup on
failure, logging to `mac-update.log` in userData). It refuses translocated, read-only or
unwritable locations. The swap has not yet been exercised on every macOS version.
`electron/close-guard.cjs` adds the bounce reminder to the window close flow; the preload
exposes `orographDesktop.session` for it.
`.github/workflows/desktop.yml` validates and publishes the three platform update manifests
and relevant differential blockmaps beside the existing downloads. A new release is
assembled as a draft before its binary and metadata assets become visible to clients.


## Browser minimap sampling

`src/visual/minimap-sampling.js` caches four warped source grids with half-pixel centres.
`HeightField.tableVersion` changes only when a source is installed, including reinstall
of a modified array. Reference/size/version changes and warp invalidate the grids. Morph
and A/B fade weights are blended each frame; shading, palette, tint and lift stay in
`hud.js`. The shared sRGB lookup differs by at most one output byte. The cache holds
six fixed 112 by 112 Float64 grids and one 4097-entry lookup, without changing frame rate
or the 512 terrain/audio source resolution.


## 2.8 additions

* **Smart controls** (`src/core/smart.js`, UI `src/ui/smart-panel.js`): `parts.N.smart =
  { knobs: [8 x { name, value, maps: [<= 4 x { id, min, max, curve }] }] }`, absent unless a
  knob has a target or a name (`sanitizeSmart` returns null otherwise). `min`/`max` are
  normalised positions of a modulatable part parameter (min > max inverts). Smart knobs
  write the target params through the store (`applySmartKnob`, meta `{ source, smart: true }`),
  so sync sends ordinary `params` messages and there is no new worklet message. Patches carry
  `smart` when present; `partWithPatch` replaces the track's smart controls with the patch's.
  MIDI learn target `{ scope: 'smart', part, id: 'smart1'..'smart8' }`.
* **Time stretch** (`src/dsp/time-stretch.js`): offline WSOLA, `timeStretch(channels, ratio,
  { sampleRate, loop, length })`, `stretchToLength(L, R, length, opts)`. Used by the looper's
  Follow tempo / Fit to tempo (`src/ui/looper-control.js`) and the noise recording Stretch menu.
* **Looper protocol**: `{t:'replace', id, L, R, base, spb, bars}` swaps in new loop audio
  (only while playing or stopped, and only if `base` equals the core's `edit` counter),
  answering `{t:'replaced', id, ok, edit}`. `state` and `loop` replies now include `edit`
  (changes of the loop audio) and `loopSpb` (beat length the loop fits, 0 for free length).
  `engine.looper.replaceLoop({ L, R, base, spb, bars })` wraps it.
## Send effects, freeze and chord trigger (2.8)

* **Send effects** (`src/dsp/send-fx.js`): part parameters `sendA` / `sendB` (post-fader,
  default 0) and the globals `sendA*` (reverb: Size, Decay, Damping, Pre-delay, Return) and
  `sendB*` (delay: Sync, Time as a `DELAY_DIVS` index or ms, Feedback, Tone, Ping-pong,
  Return). `OroDSP` sums the sends of every part into two bus inputs and runs
  `SendReturns.process` once per render call, adding the returns to the dry output (so they
  pass the master chain and appear in bounces). The buses reuse the track rack's
  `EffectSlot` reverb and delay. A bus is built on the first send and sleeps after
  `SEND_IDLE_SECONDS` without input and with silent output; while every send is 0 nothing
  of it runs and the output is bit-identical.
* **Freeze** (`src/audio/freeze.js`): `{t:'capture', part}` makes a DSP render only that
  part's output after its track effects and before its fader; `renderFrozenLoop` uses it on
  the main thread (in slices) from `engine.renderFreeze`. `{t:'freeze', part, L, R, frames,
  beats}` makes the part play that loop at `(transport beat × frames/beats) mod frames`,
  gated by `transport.playing`, instead of its voices, rack and kit (note-ons for it are
  ignored); `{t:'freeze', part, L: null}` goes back with a 15 ms crossfade. The engine keeps
  the messages per track slot (permuted with the track list) and replays them into a
  rebuilt DSP; bounces leave them out. `createFreezeController` (in `ctx.freeze`) keeps the
  state per slot and unfreezes a track whose `freezeSignature` changes. Not persisted.
* **Chord trigger** (`src/music/chord-trigger.js`): `parts.N.chord = {on, preset, inKey,
  notes}` (absent = off, sanitized by `sanitizeChord`). The router expands key input before
  the arpeggiator's pool and sequencer notes (`_engineOn` / `_engineOff` with source
  `'seq'`), remembering per key or per sequenced note which chord notes it started.
  `router.rawHeld(part)` gives the physically held keys for Learn.

## Operator panel (2.9)

* **Session**: `operator` at the root of the state (absent while every setting is at its
  default), cleaned by `sanitizeOperator` in `src/dsp/damage.js` (called by `migrateState`).
  The store sync sends `{t:'operator', cfg}` only once a session changes it, and
  `{t:'operator', cfg: null}` when a loaded session has none.
* **DSP** (`MasterOperator` in `src/dsp/damage.js`): created by `OroDSP` on the first
  operator message and run on the dry mix after the internal send returns, before the
  output guard (not while a freeze is captured). The delay, reverb and pedal sends get the
  same cutouts. `process()` returns at once while nothing is on and every effect has
  settled, so the output is bit-identical without it. Actions arrive as
  `{t:'opAction', a: 'drop' | 'spill' | 'repair' | 'tone', v}`; telemetry carries
  `op: {dmg, wet, shock, cents, dir, tone}`. The engine keeps the latest reading and replays
  it as `{t:'opState', dmg, wet, dir}` into a rebuilt DSP and into bounces (test tones are
  never bounced). Randomness is a seeded xorshift, so renders repeat exactly.
* **UI** (`src/ui/operator.js`): `startOperatorHost` (in `ctx.operator`) runs Real drops
  (`devicemotion`), the static on-screen hint and Bookkeeping (`src/core/bookkeeping.js`,
  localStorage only); `createOperatorSettings` is Settings > Operator. The MIDI module emits
  `monitor` events (`{bytes, port, time}`) only while someone listens.

## Performance (2.11)

**Lazy-loading boundaries.** `src/ui/lazy.js` lists every chunk that loads on
first use (`chunks`): Settings (with its MIDI, Pedals, Voice, Updates and Tuning
tabs and the MPC guide), Help, Golf, the image library, Real
places / night sky, Data, Formula terrain, Imprint and the drum Sound map.
Call sites use `chunks.x.run(m => m.open...(...))`; Settings and Help go
through `deferredDialog`, which returns a modal-like handle at once (open
until closed, remembers `select(tab)`) and opens the real dialog when the
chunk arrives. `prefetchWhenIdle` warms all chunks a few seconds after
start-up, so later clicks open synchronously. Rapier (physics for Roll) was
already lazy: `loadRapier()` in `src/visual/physics.js` imports it when a
track first rolls, with the built-in marble running until it is ready. The
DSP's `dsp-core` chunk loads only for the ScriptProcessor fallback, offline
bounce and freeze. `postcard.js` reads `VERSION` from the Settings chunk with
a dynamic import inside its async functions, so it does not pin Settings in
the main chunk. The single-file build inlines every chunk.

**Start-up timing.** `src/main.js` sets `performance.mark('oro:boot')` when
the main chunk has run and `'oro:ui'` when the interface is built.

**Shaders.** Where `KHR_parallel_shader_compile` exists, `createVisuals`
compiles every scene shader in the background (`renderer.compileAsync`)
and frames skip the GPU work until it finishes (dots, physics and sound keep
running); without the extension nothing changes.

**Render budget.** `src/visual/resolution.js`. Settings > General > Map
resolution: Auto (default) caps the 3D canvas's drawing buffer at about
4.5 megapixels (`MAX_PIXELS`) and the browser scales it up with CSS; a
dynamic scale (0.5 to 1 of that ratio) steps down after slow frames and back
up after steady headroom, judged against the display frame or the frame-rate
cap. Full draws device pixels up to the quality preset's pixel-ratio cap, as
before. The pref is `ui.renderScale` ('auto' | 'full'). Only the 3D canvas is
scaled; the interface, minimap and 2D panels stay at native resolution.

## 2.17 additions

* **Score desk.** `src/music/orchestra.js` (57 pitched voices, the 8-pad kit and 29 drum
  pieces, each a factory patch plus offsets), `score-styles.js` (styles and 20 grooves),
  `score.js` (parse, check, compose; receipts with `errors[].fix`), `desk.js` (plays a score
  on borrowed or added tracks and restores them; emits `score` events `start`, `cue`, `end`
  through `music.on('score')`), `score-render.js` (offline render with `OroDSP` and a JS
  master chain: convolution reverb, delay, chorus, warmth, BS.1770 loudness, look-ahead
  limiter; 5 minute cap) and `score-export.js` (MIDI, `#score=` links). Autosave skips the
  borrowed tracks through `autosave.addFilter`.
* **Agent API.** `src/agent/api.js`: `createAgentApi(...)` is `window.oro`;
  `installBridge(win, api, { allowMutating })` answers `{ source: 'oro-agent', id, type, args }`
  with `{ source: 'oro', id, ok, result }`. Calls in `MUTATING` need `?agent=1`
  (`agentOptIn`). Agent edits use store meta source `'agent'`, so they are undoable.
* **Touch.** Worklet message `{ t: 'touch', v: [x, y, height, down], part, fx }`
  (`engine.touchMap`). `TouchBank` (`src/dsp/touch-sources.js`) smooths it into Link
  sources Touch X, Touch Y, Touch Height and Touch Down (appended to `LINK_SOURCES`) and,
  with `fx`, the rig on that track (cutoff, resonance, drive, fold, delay and reverb sends).
  `src/music/touch.js` turns map touches into strums or the FX rig.
* **Contracts appended:** `LINK_CURVES` gains S-curve, Steps, Invert, Rectify and Half;
  `PART_PARAMS` gains `pitchEnv` (semitones times envelope 2); `FX_TYPES` 32 to 40 are the
  nine new track effects; `parts.N.dot.cruise` (Roll: Keep rolling, kept only when above 0).
* **32-bit float WAV.** `wavBlobFromPieces({ format: 'float32' })` writes format 3;
  Bounce, Record and the score render take a `format`.


## 2.17.1 additions

* **Visualizers** (`src/ui/visualizer.js`). `ui.visualizer` (a device pref) picks what the
  viewport shows: `map` or one of five 2D visualizers on a canvas layer (`.viz-layer`) above
  the 3D canvas and below `.vp-overlay`. The layer taps `engine.analyser` (after the
  limiter, before the listening mode) with analysers of its own that feed nothing onward,
  so it cannot change the sound or a recording. `visuals.setCovered(true)` stops the 3D
  render loop and keeps the physics timer alive (rolling and drifting dots still write
  `centerX`/`centerY`). `.viewport[data-viz]` hides the map-only controls.
* **Worker renders** (`src/music/score-render-host.js`). Page renders post the score to
  `score-render-worker.js` (bundled with the `virtual:worklet:` plugin like the terrain
  worker) and get the stereo buffers back as transferables; without a worker the same
  `renderScore` runs on the page.
