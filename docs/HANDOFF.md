# Handoff notes (2026-10-02, about 13:55 UTC)

For the next assistant (for example ChatGPT) or a person. Read this, then `docs/ARCHITECTURE.md`.

## Where things are

* **Synth repo** `ChaseHendrick/synth`, default branch `main`. Released and live: **1.4.0** (voice input)
  (https://github.com/ChaseHendrick/synth/releases/latest). Merging to `main` rebuilds the
  desktop apps and republishes the release for the version in `package.json`.
* **Website** `ChaseHendrick/hendrickresearch.com`: serves the web app at `/music/orograph/`
  (update it to each new release). To update after a synth release: in the website repo run
  `node scripts/sync-orograph.mjs ../synth`, set Orograph's `softwareVersion` in
  `src/music.ts`, `npm ci && npm run build`, open a PR, merge (Vercel deploys `main`).

## Work in progress (unfinished, not merged)

Both were being built by agents when usage ran out. Their partial diffs are saved here; each
is a `git diff` against the `main` commit named, so apply with
`git checkout <commit> && git apply --3way <patch>` and then rebase onto current `main`.

1. **1.3.0 Tracks**: done and released (open-ended track list, 1 to 16 tracks, patterns per track; `activeSeq(part)` and `patternPath(store, p)` in `src/core/params.js` and `watchTracks`/`permute` in `src/core/tracks.js` are the hooks for the timeline).
2. **1.4.0 Voice input**: done (Settings > Voice; `src/audio/voice-host.js`, `voice-core.js`, `src/ui/voice-rig.js`, `settings-voice.js`). Not tested with a real microphone.
3. **Next after Tracks: arrangement timeline** (not started). A song view: each track's
   patterns placed as clips on bars; move, resize, copy, loop and mute clips; playhead, loop
   region, song export; looper recordings droppable as audio clips.
4. **Chord tracking for guitar** (draft in `wip/chords/`, see its notes in the earlier
   version of this file in git history): a polyphonic "Chords" mode next to single notes.

## Checks before any release

`npm ci && npx vitest run` (about 1000 tests) `&& npm run build && npm run build:single`, then
`npx vite --port 5190 --strictPort &` and `node tests/e2e/app-smoke.cjs http://127.0.0.1:5190/`
on an idle machine (software GL is slow; browser tests time out under CPU load).
`tests/audio/terrain-manager.test.js` has a timing budget that can fail under heavy load.

## Owner preferences

* Clean-room only: never copy Conductive Labs (TerrainSynth) or XLN Audio (XO, Life) code,
  text or sounds. `ChaseHendrick/music-field-manual` is PolyForm: facts only, no code.
* No em dashes in user-facing text. Accurate claims only; hardware features are untested.
* High sound quality matters (32-bit float paths, no clicks, dithered exports).
* Smooth visuals: no frame-rate caps.
* Ship each feature as its own small release: PR, CI green, merge, then update the website.
