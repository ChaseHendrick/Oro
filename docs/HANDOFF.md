# Handoff notes (2026-10-02)

## State

* Orograph 1.1.0 is on `main` (merged from PR #1). Pushing to `main` builds the desktop apps and
  publishes the GitHub Release (`releases/latest`) with Mac, Windows, Linux and offline HTML downloads.
* The website (ChaseHendrick/hendrickresearch.com) serves the web app at `/music/orograph/`;
  refresh it with `node scripts/sync-orograph.mjs ../synth` from the website repo.
* 1.1.0 includes guitar pedals (send/return, Ping and latency compensation, sample-rate choice,
  pedal MIDI with LFOs and preset recall, guitar plays notes, Capture) and a phone-sized sequencer.
  Nothing pedal or MPC related has been tried on real hardware; the docs say so.
* Known issues and their fixes: `docs/BUGS.md`.

## Next (1.2)

* Chord tracking for the guitar input (polyphonic pitch detection, Klapuri-style iterative
  estimation and cancellation), as a "Chords" mode next to single-note tracking.

## Checks before a release

`npm ci && npx vitest run && npm run build && npm run build:single`, then
`npx vite --port 5190 --strictPort &` and `node tests/e2e/app-smoke.cjs http://127.0.0.1:5190/`
on an idle machine (software GL renders below 1 fps, so browser tests time out under load).

## Owner preferences

Clean-room only (never copy Conductive Labs or XLN code, text or sounds). No em dashes in
user-facing text. Accurate claims only; hardware features are marked untested.
