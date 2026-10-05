---
name: oro-music
description: Write and render music on Oro, Chase Hendrick's wave-terrain synthesizer. Use when the user asks to compose, score, arrange, make a beat, write for orchestra, piano, guitar, synth or drums, or to drive the Oro website.
---

# Oro music

Oro is one instrument. A closed path crosses a mathematical landscape and the height under the path is the waveform. You do not pick a sample library. You write a score. An open Oro page plays it.

Every pitched note is still that land. The desks are colours of it:

| Family | What you hear | Voices |
|---|---|---|
| terrain | The native oscillator | violin, viola, cello, bass, flute, oboe, clarinet, bassoon, horn, trumpet, trombone, choir, harp |
| physical | A short strike into a waveguide | piano, guitar, marimba |
| fm | Terrain as the modulator | rhodes, bell |
| additive | Six partials read off the map | organ |
| subtractive | Resonant lowpass on the terrain | lead, clav |
| wavetable | One row of the map, scanned | sub |
| vector | Two terrains crossfade | pad |
| granular | Overlapping grains of the orbit | cloud |

Drums are synthesized, not sampled: kick, snare, hat, clap, tom, rim. `tom` uses the low or high tom from the pitch. ride, crash, shaker and timpani are accepted, and the receipt says which pad they actually play. There is no ride, crash, shaker or tuned timpani.

## Where to play it

1. If Oro is open, call it there. `oro.play(scoreText)` plays now and returns a receipt. `oro.play()` plays the score already on the desk. `oro.compose({ prompt, style, bpm, key, mode, bars })` writes a score and does not play it. `oro.stop()`, `oro.schema()`, `oro.getScore()`. You can also `postMessage({ source: "oro-agent", type: "play", score: scoreText }, "*")`. The page answers `{ source: "oro", type, receipt }`.
2. If you have this repo, check without a page: `node scripts/oro-score.mjs check score.txt` and `node scripts/oro-score.mjs compose --prompt "opening at 180 bpm"`. The command prints the receipt and exits 1 when the score is wrong.
3. There is no server audio route. `GET /api/oro` on hendrickresearch.com is not served. Do not POST a score there, and do not invent a host that renders a WAV. The receipt's `durationSeconds` is how long the piece is. `http` in `oro.schema()` is null until a route exists.

The downloadable app is the same instrument: [latest release](https://github.com/ChaseHendrick/Oro/releases/latest). `oro.play` is on that page too, desktop and browser.

## How to make a piece

1. Pick a style, or describe it. `orchestra-type` is the default: 156 BPM, 16th-note hats, 8th-note strings. `strings`, `brass-choir`, `sparse`. `atlas` puts every family on one short desk. `opening` is 180 BPM: a cold flash, three name-card stabs, eight hits, then a title hold, with cues named `cold`, `card-1`, `card-2`, `card-3`, `hits`, `title`.
2. Words in a prompt are enough. "anime opening at 180 bpm in D minor, 8 bars" selects `opening`. "faster" and "slower" nudge the tempo. "no drums" drops the kit. "N bars" and "N bpm" are read as written.
3. Read `errors`. Each one has `line`, `field`, `message` and `fix`. Change that line. Check again until `ok` is true.
4. Read the receipt before you trust a picture lock. `cues[].seconds` is when that hit is heard. `durationSeconds` is the length. `voices[].part` is which track plays that desk. `warnings` means the sound is not what the voice name suggests, usually too few tracks or a drum that has no pad of its own. `hash` is the normalised score, so you can tell two renders apart.
5. Hand the text to `oro.play`. Tracks are recoloured for the score and put back when it stops. A score does not start the step sequencer.
6. Stay inside 16 bars and 2000 notes unless asked. The hard ceiling is 32 bars. A default session has four tracks: more pitched desks than free tracks share a colour, and the receipt says so.

## Score

Headers, one per line: `title`, `bpm`, `bars`, `beats`, `key`, `mode`, `style`, `swing` (0 to 0.6).

Cues, one per line: `cue name beat`. The name is a word. The beat is in quarter notes. Use these to lock a hit to a cut.

Notes, one per line: `voice pitch beat length velocity` and an optional pan from -1 to 1.

A chord is a pitch with a type and no space: `Cmaj`, `Cm`, `C7`, `Cmaj7`, `Cmin7`, `Cdim`, `Caug`, `Csus2`, `Csus4`, `C5th`, plus an optional octave (`Cmaj4`). `C5` is the note C in octave 5, not a power chord. A bare `C` is an error.

```
title Paced
bpm 156
bars 4
beats 4
key A
mode minor

cue title 12

violin A4 0 0.5 0.8
piano Cmaj3 0 2 0.7
kick x 0 0.2 1
hat x 0.5 0.08 0.4
```

Time is in quarter notes, not seconds. A beat may be a number, a fraction (`1/3`), or `2t` / `2tt` (one or two triplet eighths after beat 2). Swing, when set, moves 16ths and does not move quarters or eighths, so a cue on a quarter is the second in the receipt. Unpitched drums use pitch `x`. Hat length of 0.2 or more is an open hat. Aliases: `hh` hat, `bd` kick, `sd` snare, `vln` violin, `vc` cello, `tpt` trumpet, `pno` piano, `ep` rhodes, `gtr` guitar.

JSON is the same fields: `{ "bpm": 156, "key": "A", "mode": "minor", "cues": [{ "name": "title", "beat": 12 }], "notes": [{ "voice": "violin", "pitch": "A4", "beat": 0, "len": 0.5, "vel": 0.8 }] }`.

The full grammar is in `references/score.md` and in `oro.schema()`. Prefer the live list. Do not invent a voice that is not there.

## Do not

- Do not describe Oro as a sampled orchestra, a Kontakt library, or a DAW.
- Do not say a voice is a real piano or Rhodes. Say which family it is.
- Do not paste a score with an unknown voice. Validate first.
- Do not call `/api/oro` or `/api/oro/beat`. Those routes are not served. Check with the script or with `oro.play`, and use `durationSeconds` instead of assuming a WAV came back.
