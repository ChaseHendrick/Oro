# Handoff notes (2026-10-02, for the next assistant)

Written so another AI assistant (for example ChatGPT) or a person can pick up Orograph without
the original chat. Read this file, then `docs/ARCHITECTURE.md`, then the code you need.

## What Orograph is

A clean-room wave terrain synthesizer: a sound is made by tracing a closed path (the "orbit")
across a 3D height map and reading the heights as the waveform. You place the dot anywhere on the
map and the sound follows. It runs in the browser and as an Electron desktop app.

* Repo: `ChaseHendrick/synth` (MIT). Default branch `main`.
* Released: **v1.1.1**, https://github.com/ChaseHendrick/synth/releases/latest
  (Mac arm64/x64 dmg+zip, Windows setup and portable exe, Linux AppImage and tar.gz, web zip,
  single-file `Orograph.html`). Pushing to `main` rebuilds and republishes the release for the
  version in `package.json` (`.github/workflows/desktop.yml`).
* Website: `ChaseHendrick/hendrickresearch.com` serves the web app at `/music/orograph/` (Vercel
  deploys `main`). To update it after a synth release: in the website repo run
  `node scripts/sync-orograph.mjs ../synth`, bump `softwareVersion` for Orograph in
  `src/music.ts`, `npm ci && npm run build`, open a PR, merge.

## Status

Everything in 1.1.0 is merged and released: DSP engine, 3D map with physics marble, 4 parts,
sequencer/arp, 53 patches, 7 scenes, dark/light themes, phone layout, MPC XL MIDI (clock in/out,
Q-Link learn), and guitar pedals (send/return, Ping and latency compensation, sample-rate choice,
pedal MIDI with LFOs and preset recall, guitar plays single notes, Capture). Known bugs and their
fixes: `docs/BUGS.md` (all found ones fixed). CI is green on `main`.

**Nothing MPC or pedal related has been tested on real hardware.** Keep saying so in docs.

## Next task: 1.2.0, chord tracking for the guitar input

Goal: a "Chords" mode next to the existing single-note "Guitar plays notes", so strummed chords
play the synth polyphonically.

Started, not finished:

* `wip/chords/chords.js`: a draft multi-pitch tracker (onset detection, whitened spectrum,
  Klapuri-style iterative estimation and cancellation, up to 6 notes). Read its header comment.
  Its last measured result on synthetic chords was: pitch-class recall 100%, precision 97.6%,
  exact-note recall 72% (octave doublings get merged into one note). The author was tuning the
  octave handling when work stopped.
* `wip/chords/signals-test-helper.patch`: additions to `tests/pedals/signals.js` (synthetic
  guitar-like chord signals) that the tests used. Apply with `git apply`.
* It is not wired in and not imported anywhere, so it does not affect the app or the tests.

Steps to finish:

1. Move `wip/chords/chords.js` to `src/pedals/chords.js`, apply the test helper patch, and write
   `tests/pedals/chords.test.js`: synthetic chords (open E major, C major, A minor, power chord,
   single note, octaves) at 44.1 and 48 kHz with an accuracy floor (for example 90% of notes
   correct, few false positives); onset, release and hysteresis; no octave ghosts on single
   notes; cost per analysis frame.
2. Fix octave doublings (exact-note recall 72% now): keep a note and its octave only when the
   octave's even partials have clearly independent energy.
3. Wire it: `guitarMode` ('single' | 'chords', default 'single') in `src/pedals/rig-settings.js`
   with migration of saved rig settings; `src/audio/pedal-host.js` feeds sample blocks from the
   guitar tap to the tracker in chords mode; `src/pedals/guitar-notes.js` sends one router
   noteOn/noteOff per note (source `'guitar'`, no pitch bend in chords mode); switching modes
   releases held notes; Capture still pauses notes while recording.
4. UI in `src/ui/settings-pedals.js` (Guitar group): Single note / Chords switch, a readout like
   "Hearing C E G", and an honest hint about the extra delay (about 100 to 170 ms, from the long
   analysis window needed to separate low E from F) and that a clean DI works best.
5. Docs: `docs/PEDALS.md` (row with measured accuracy and latency, cite Klapuri 2006),
   `CHANGELOG.md` (1.2.0), `docs/USER-GUIDE.md` (guitar section).
6. Bump the version to 1.2.0: `npm version 1.2.0 --no-git-tag-version` and `VERSION` in
   `src/ui/settings.js`. Merge to `main` to publish the release, then refresh the website.

## How to work on it

```
npm ci
npx vitest run            # about 890 tests; all pass on main
npm run build && npm run build:single
npx vite --port 5190 --strictPort &
node tests/e2e/app-smoke.cjs http://127.0.0.1:5190/   # browser smoke test (Playwright + Chromium)
```

Browser tests use software rendering in containers and need an idle machine; under CPU load they
time out (that is not an app bug). `tests/audio/terrain-manager.test.js` has a timing budget that
can fail under heavy load and passes alone.

Map of the code: `src/dsp` (AudioWorklet synth core), `src/audio` (engine host, FX, pedal host,
bounce), `src/visual` (three.js map and Rapier marble), `src/music` (router, transport,
sequencer, locks), `src/midi` (Web MIDI, MPC XL, clock), `src/pedals` (guitar and pedal logic),
`src/presets`, `src/ui`, `src/core` (params, store, migration), `electron/`.

## Rules the owner set (keep them)

* Clean-room only: never copy code, artwork, text or sounds from Conductive Labs (TerrainSynth)
  or XLN Audio (XO, Life). The owner's `ChaseHendrick/music-field-manual` repo is PolyForm
  licensed: use facts from it only, never code.
* No em dashes in user-facing text.
* Accurate claims only; mark hardware features as untested until the owner tries them.
* Develop on a branch, open a PR, keep CI green, then merge.

## Ideas the owner mentioned but parked

* Working with XLN Audio XO and Life (owned by the owner, on the Mac): parked. Options discussed
  were connecting them over a virtual MIDI cable (macOS IAC Driver) plus audio loopback, hosting
  their AU plugins in the desktop app, or making Orograph a plugin. Original features inspired by
  them (a sound-similarity drum map, slicing a recording into a beat) would also be fine if built
  from scratch.
