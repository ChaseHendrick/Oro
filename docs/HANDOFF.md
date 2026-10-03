# Orograph handoff

Updated 2026-10-03 for Orograph 2.0.0. Read this and `docs/ARCHITECTURE.md`
before continuing. The owner requested the complete expansion in
`docs/FEATURE-PARITY.md`, followed by desktop update controls. The measured checks and
limitations are in `docs/EXPANSION-VALIDATION.md`. Arrangement and Sound Match remain
separate future features; they are outside the 2.0 expansion.

---

## 1. What this project is

**Orograph** is a free, original wave terrain synthesizer by Chase Hendrick (GitHub
`ChaseHendrick`). A closed loop (the "path") is traced over a 2D height map (the "terrain")
once per oscillator cycle; the height under the moving point is the audio. The player sees
the land as a 3D map and drags a dot to move the loop. It was inspired by the Conductive
Labs Terrain Synth hardware, but it is a **clean-room** design: no code, art, text or sound
from that product (or any other) was copied. See section 9.

It ships as:

* a web app: https://hendrickresearch.com/music/orograph/ (served by the owner's website);
* desktop apps for Mac, Windows and Linux, plus a single offline HTML file, attached to
  GitHub Releases: https://github.com/ChaseHendrick/synth/releases/latest

Tech: plain JavaScript ES modules (no framework, no TypeScript), Vite 8, three.js for the
3D view, Rapier (physics, lazy loaded) for the rolling-marble mode, Web Audio
AudioWorklet for the synth engine, Web MIDI, Electron for the desktop apps, Vitest for
tests, Playwright (Chromium) for browser checks. Node 22.

## 2. Repositories

| Repo | What | Default branch | Deploys |
|---|---|---|---|
| `ChaseHendrick/synth` | the synth (this repo) | `main` | every push to `main` builds the desktop apps and publishes a GitHub Release for the version in `package.json` (`.github/workflows/desktop.yml`) |
| `ChaseHendrick/hendrickresearch.com` | the owner's website (Vite + TypeScript) | `main` | Vercel deploys `main` to hendrickresearch.com; every PR gets a Vercel preview |
| `ChaseHendrick/music-field-manual` | the owner's notes, **PolyForm licensed** | | use facts from it only, never copy code |

Work happens on a branch and goes in through a pull request. The owner wants PRs merged
(squash) once CI is green, then the website updated (section 6). Keep releases coherent; the owner requested the
full set of 2.0 capabilities together.

## 3. State checked during this continuation

The earlier release blocker is resolved. Checked on 2026-10-02:

* Synth PR #9 is merged as `e47e6b4`; main's CI and Desktop apps workflows passed.
* GitHub Release **v1.4.0** has Mac ARM64 and x64 DMG/ZIP, Windows installer and
  portable EXE, Linux AppImage/tar.gz, web ZIP and the offline HTML file.
* Website PR #14 is merged. Its source declares Orograph **1.4.0**.
* Synth PR #10 is merged as `058e03f`; main's CI and Desktop apps workflows passed.
  GitHub Release **v1.5.0** has all ten platform, web and offline assets uploaded.
  Website PR #15 is merged as `4ca638f`; the public app passed the generated-chord
  input and note cleanup checks after deployment.
* **1.5.0: experimental guitar chords** is published. The implementation
  replaces the unreliable draft with a conservative spectral detector, adds Single /
  Chords selection and per-note routing, and fixes stale source routes after Panic.
  Chords may miss quiet and octave-doubled strings. Physical guitar and pedal tests
  remain outstanding.
* The follow-up **1.5.1** patch adds the owner's brief pedal profile explanation to
  Settings > Pedals, the user guide and pedal notes: **Why these pedals?** These are
  the ones I have. Synth PR #11 and website PR #16 were merged; both builds, all ten release assets and
  the exact production copy were verified.

Follow the release routine in section 6: test both web builds, check browser input
paths, merge the feature PR only once CI is green, verify all download assets, then
sync the website. Check the current GitHub release and PR state before repeating a
step from this snapshot.

The macOS runner problem described in the original handoff was temporary. The
1.4.0 desktop workflow passed without changing runner labels or release behavior.

## 4. How to work on it

```bash
npm ci
npx vitest run            # all tests must pass; use --maxWorkers=4 on a busy local machine
npm run build             # web build into dist/
npm run build:single      # one offline HTML file into dist-single/
npx vite --port 5190 --strictPort &              # dev server
node tests/e2e/app-smoke.cjs http://127.0.0.1:5190/   # browser smoke test
```

* The browser tests use a globally installed Playwright at
  `/opt/node22/lib/node_modules/playwright` with Chromium in `/opt/pw-browsers` (that is
  how the original environment was set up; adjust the `require` path elsewhere). Launch
  Chromium with `--autoplay-policy=no-user-gesture-required --use-angle=swiftshader
  --enable-unsafe-swiftshader --ignore-gpu-blocklist` for audio and WebGL in headless mode.
  To test the microphone, add `--use-fake-device-for-media-stream
  --use-fake-ui-for-media-stream` (Chromium's fake microphone is a short full-scale beep
  about once a second, so a meter sampled every 250 ms can look silent).
* Run browser tests on an idle machine: software WebGL is slow and they time out under load.
  `tests/audio/terrain-manager.test.js` has a timing budget that can fail on a busy machine.
* In the running app, `window.orograph` exposes `store`, `engine`, `visuals`, `music`,
  `midi`, `presets`, `tracks` and `ui` (for example `window.orograph.ui.openSettings('voice')`).
  The tests and the smoke script use these.
* The synth engine (`src/dsp/dsp-core.js`, class `OrographDSP`) is pure JavaScript with no
  Web Audio dependency, so it can render offline in Node or a Worker.
  `tests/dsp/helpers.js` (`makeDSP`, `render`, `spectrum`) shows how.

## 5. Map of the code

`docs/ARCHITECTURE.md` is the contract between modules (coordinates, messages, parameter
registry). The short version:

| Path | What |
|---|---|
| `src/main.js` | boots everything |
| `src/core/params.js` | the parameter registry (`PART_PARAMS` with ids, ranges, defaults), `MAX_PARTS = 16`, `LINK_SOURCES`, state version. **Extend by appending only**: saved sessions depend on order |
| `src/core/store.js`, `src/core/migrate.js`, `src/core/tracks.js` | state store, migration of old saves, track list helpers (`partCount`, `watchTracks`, `permute`) |
| `src/dsp/` | the engine: `dsp-core.js` (voices, oversampling, filters, links), `terrains.js` (terrain generation, mip chains), `paths.js`, `catalog.js` (terrain and path names), `worklet.js` |
| `src/audio/` | Web Audio host: `engine.js` (creates the worklet, routing, bounce), `fx.js` (master effects), looper, recorder, importers, `resample.js`, `voice-host.js` / `voice-core.js` (microphone, 1.4) |
| `src/visual/` | three.js scene: terrain mesh, path, dot, physics, minimap (`hud.js`), post-processing |
| `src/ui/` | all panels and dialogs (no framework; `dom.js` has the `h()` helper) |
| `src/music/`, `src/midi/` | note router and arpeggiator, sequencer and transport, MIDI and the Akai MPC XL |
| `src/pedals/` | guitar pedal loop (1.1): pedal host, latency compensation, pitch tracker (`pitch.js`), guitar-to-notes |
| `electron/` | desktop wrapper |
| `tests/` | Vitest tests by area, plus `tests/e2e/*.cjs` browser scripts |
| `docs/USER-GUIDE.md` | the full user manual (keep it accurate when behaviour changes) |
| `docs/RESEARCH.md` | research brief: facts about the Terrain Synth (with sources), wave terrain theory, the original feature spec |
| `docs/BUGS.md`, `docs/PEDALS.md`, `docs/MPC-XL.md` | bug log, pedal design, MPC notes |
| `CHANGELOG.md` | one section per release |
| `src/pedals/chords.js`, `src/pedals/guitar-chord-worker.js` | experimental multi-pitch detector and background analysis |

## 6. Release and website routine

**Version bump checklist** (every release):

1. `package.json` `version`
2. `src/ui/settings.js` `VERSION`
3. `CHANGELOG.md`: new section at the top, `## X.Y.Z (Month YYYY): Title`
4. `docs/USER-GUIDE.md` line 5 ("It describes version X.Y.Z")
5. `README.md` if the feature list changes
6. this file

Then: run the tests and both builds, open a PR, wait for green, squash-merge. The push to
`main` publishes the release.

**Website update after a release** (in a clone of `hendrickresearch.com` next to `synth`):

```bash
git checkout -b claude/orograph-X.Y.Z origin/main
node scripts/sync-orograph.mjs ../synth   # builds the synth checkout (run npm ci there first) and copies it to public/music/orograph/
# edit src/music.ts: Orograph's softwareVersion (around line 16), and the feature text if needed
npm ci && npm run build
```

Open a PR, wait for the Vercel preview check, merge after the synth release is live.
Website SEO was set up on 2026-10-02: the site name shows as "Hendrick Research", the home
title is "Hendrick Research | Simulations & Scientific Research", and the WebSite
structured data has `alternateName: "HendrickResearch"`. Do not invent other names.

**Branches.** The previous assistant's tooling only allowed pushes to
`claude/magical-tesla-q993l8` in the synth repo, so that one branch was reset to
`origin/main` after each merge and reused. Website branches were named
`claude/orograph-X.Y.Z`. You can use any branch names you like.

## 7. Feature status

**Shipped** (see `CHANGELOG.md` for details):

* 1.0: the synth: 13 procedural terrains plus image/WAV/16-bit DEM import, 12 paths,
  oversampled engine with quality modes, filters, two envelopes, per-knob LFOs, Links
  (modulation routing) and macros, step sequencer, arpeggiator, effects, recording and
  bounce, MIDI with MPE and an Akai MPC XL guide, dark and light themes, phone layout,
  rolling marble physics.
* 1.1: guitar pedals: send a track out through real pedals and back, latency compensation,
  guitar plays notes (pitch tracking), Capture a guitar note as a terrain, pedal LFOs,
  pedal presets in scenes and patches, a 44.1 kHz option for the MPC. **Untested with
  real pedals or a real MPC.**
* 1.2: looper with overdub (32-bit float, 24-bit dithered or 32-bit float WAV export) and
  Resample (turn a loop into a new terrain). 1.2.1: smoother minimap and displays, no
  frame-rate caps. 1.2.2: the whole 3 x 3 map is playable, walls at the outer edge.
* 1.3: open-ended track list (1 to 16 tracks), several patterns per track.
* 1.4 (merged and published): voice and microphone input (Settings > Voice): input gain,
  meter and clip light, "Mic Cleanup" toggle, Monitor with a feedback guard, optional
  high-pass, compressor and de-esser, voice into the looper and Resample, "Voice plays
  notes", Capture a sung note, Voice Level as a Links source. Also fixes "Guitar plays
  notes" on tracks 5 to 16. **Untested with a real microphone.**

**Implemented in the 1.5.0 continuation:**

* **Experimental guitar chord tracking.** Single remains the default, Chords is an
  optional slower multi-pitch detector on a clean input, and Capture still requires
  one held note. Generated-signal tests establish the tested cases only, not real
  hardware accuracy. The superseded `wip/chords/` draft is removed.

**Requested by the owner, not started:**

1. **Arrangement timeline.** A song view: each track's patterns placed as clips on bars;
   move, resize, copy, loop and mute clips; playhead, loop region, song export; looper
   recordings droppable as audio clips. Hooks already exist: tracks and patterns have
   stable ids; `activeSeq(part)` and `patternPath(store, p)` in `src/core/params.js`.
2. **"Cutting edge" feature.** The owner asked for cutting-edge technology. The proposal
   (agreed in principle, not built) is **Sound Match**, automatic inverse synthesis: give it
   a sound (a file, a looper recording, or a sung note), and it searches Orograph's own
   parameters for a patch that reproduces that timbre, keeping the result a playable,
   morphable patch (unlike Resample, which copies the sound into a terrain). Design notes:
   * Analyse a steady stretch of the target: pitch with the existing tracker
     (`src/pedals/pitch.js`), then the magnitudes of the first 32 to 64 harmonics in dB.
   * Score a candidate by rendering a short note at that pitch with the real engine
     (`OrographDSP` in a Web Worker, as in `tests/dsp/helpers.js`), measuring the same
     harmonics, and taking a log-spectral distance. Estimated from the CPU benchmark in
     the 1.3.0 PR (about 0.7% of one core per sounding oscillator), rendering 0.1 s of one
     voice costs under a millisecond, so hundreds of candidates per second should be
     realistic. Measure before relying on it.
   * Terrain tables are slow to build (`generateTerrain` + `buildMipChain` in
     `src/dsp/terrains.js`), so build each built-in terrain once (13 of them, ids 0 to 12)
     and search the discrete choices (terrain, `pathShape` 0 to 11, `pathOrder` 1 to 8) by
     screening, then refine the continuous ones with a derivative-free optimiser such as
     CMA-ES: `pathParam`, `size` (0 to 0.5), `stretch`, `rotate`, `centerX`, `centerY`,
     `warp`, `lift` (0.25 to 4), `fold`, `laps`, `pace`, and optionally `cutoff` and
     `resonance`. Ranges are in `PART_PARAMS`.
   * UI idea: "Match a sound" in the import area or the Sound tab, with progress, a
     before/after A/B, the match score, and undo.
   * Be honest in the UI and docs about how close a match is; wave terrain cannot
     reproduce every sound.
3. The requested oscillator, terrain, modulation, effects, patch and display expansion
   is implemented in **2.0.0**. See `docs/FEATURE-PARITY.md` for every requested item and
   `docs/EXPANSION-VALIDATION.md` for evidence and performance bounds. A browser test is
   available at `tests/e2e/expansion.cjs`.

## 8. Things learned the hard way

* **Gray rectangle over the map (fixed in 1.1.x):** half-float overflow (Inf/NaN) in the
  render target spread by the bloom pass on Apple GPUs. Fixed by a sanitize shader pass
  after the render pass, and no MSAA on Apple GPUs (`src/visual/visuals.js`).
* **Dot jumping when grabbed (fixed 1.1.2):** the drawn dot included modulation; grabbing
  now starts from the drawn position and eases any offset away.
* **Feedback guard (fixed in 1.4):** a held sung vowel is as periodic as a feedback howl,
  so periodicity alone muted loud singing. The voice guard now also requires a steady
  pitch (within 10 cents) for a howl and an audible start for a runaway
  (`createFeedbackDetector` in `src/pedals/pedal-loop.js`, `VOICE_GUARD` in
  `src/audio/voice-core.js`). A very loud note held almost perfectly straight can still
  trip it; that is documented.
* **Track count:** since 1.3 there is no fixed `NUM_PARTS`. Use `MAX_PARTS` for array sizes
  and `partCount(store)` for the live count. Anything per track must follow reorders
  (`watchTracks` / `permute` in `src/core/tracks.js`).
* **Saved data compatibility:** append to `PART_PARAMS` and `LINK_SOURCES`, never reorder;
  bump the state version and add a migration in `src/core/migrate.js` when the saved shape
  changes.
* **Timing tests:** use the fake clock and timers the test helpers provide; real timers make
  scheduling tests flaky.
* **Agent worktrees:** if you use parallel agents with git worktrees, keep `.claude/worktrees/`
  out of commits (it is in `.gitignore`).

## 9. The owner's rules and preferences

* **Clean-room only.** Never copy Conductive Labs (Terrain Synth) or XLN Audio (XO, Life)
  code, art, text or sounds. `ChaseHendrick/music-field-manual` is PolyForm licensed: use
  facts from it, never code. Do not bypass Cloudflare or other protections when
  researching.
* **Writing style:** no em dashes in anything user-facing (app text, docs, changelog, PRs).
  Plain, accurate English.
* **Accuracy:** do not state anything you have not checked. Say clearly when something is
  untested; the hardware features (MPC XL, guitar pedals, microphone) have only been
  tested in software.
* **Quality:** high sound quality matters (32-bit float paths, no clicks, dithered
  exports). Smooth visuals: never cap the frame rate.
* **Process:** PR, CI green, squash merge, verify the release assets, then update and
  verify the website.
* **About the owner:** has a neuroscience degree and is in law school; technical
  explanations are welcome. Uses a Mac with Chrome, owns an Akai MPC XL and guitar pedals.
  Often asks for status and for a percentage of progress; give honest numbers.
