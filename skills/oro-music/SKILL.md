---
name: oro-music
description: Write and render music on Oro, Chase Hendrick's wave-terrain synthesizer. Use when the user asks to compose, score, arrange, make a beat, write for orchestra, piano, guitar, synth or drums, or to drive the Oro website.
---

# Oro music

Oro is one instrument. A closed path crosses a mathematical landscape and the height under the path is the waveform. You do not pick a sample library. You write a score. The site plays it.

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

Drums are synthesized, not sampled: kick, snare, hat, clap, tom (pitched), ride, crash, shaker, rim, timpani (pitched).

## Where to play it

1. If Oro is open in the browser, call it there. `oro.play(scoreText)` plays now. `oro.play()` plays the score on the desk. `oro.compose({ style, bpm, key, mode, bars })` writes a score onto the desk. `oro.stop()`, `oro.schema()`, `oro.getScore()`. You can also `postMessage({ source: "oro-agent", type: "play", score: scoreText }, "*")`.
2. If you have the site's origin, use HTTP. Do not invent a hostname. Ask, or use the origin of the Oro page the user already has. The contract is `GET /api/oro`. Composing is `POST /api/oro/compose`. Validating a score is `POST /api/oro`. Audio is `POST /api/oro/beat` (WAV) or `GET /api/oro/beat` for the default paced orchestra. CORS is open. No key.
3. The downloadable Oro (Mac, Windows, Linux, and a single offline `Oro.html`) is the same instrument as a desktop app: [latest release](https://github.com/ChaseHendrick/Oro/releases/latest). The score API is the website, not the desktop file.

## How to make a piece

1. Pick a style. `orchestra-type` is the default: 156 BPM, 16th-note hats, 8th-note strings. `strings`, `brass-choir`, `sparse`. `atlas` puts every family on one 4-bar desk.
2. A prompt is enough. `POST /api/oro/compose` with `{ "prompt": "faster orchestra in D minor, 8 bars" }` or `{ "style": "atlas", "key": "D", "mode": "minor" }`.
3. Read `errors`. They name the fix. Edit the text score and `POST /api/oro` until `ok` is true.
4. Hand the text to `oro.play`, or `POST` it to `/api/oro/beat` and keep the WAV.
5. Stay inside 16 bars and 2000 notes unless asked. The hard ceiling is 32 bars.

## Score

Headers, one per line: `title`, `bpm`, `bars`, `beats`, `key`, `mode`, `style`.

Notes, one per line: `voice pitch beat length velocity` and an optional pan from -1 to 1.

```
title Paced
bpm 156
bars 4
beats 4
key A
mode minor

violin A4 0 0.5 0.8
piano C3 0 2 0.7
kick x 0 0.2 1
hat x 0.5 0.08 0.4
```

Time is in quarter notes, not seconds. Unpitched drums use pitch `x`. Hat length of 0.2 or more is an open hat. Aliases: `hh` hat, `bd` kick, `sd` snare, `vln` violin, `vc` cello, `tpt` trumpet, `pno` piano, `ep` rhodes, `gtr` guitar.

JSON is the same fields: `{ "bpm": 156, "key": "A", "mode": "minor", "notes": [{ "voice": "violin", "pitch": "A4", "beat": 0, "len": 0.5, "vel": 0.8 }] }`.

The full grammar and the live voice list are in `references/score.md` and in `GET /api/oro`. Prefer the live list. Do not invent a voice that is not there.

## Do not

- Do not describe Oro as a sampled orchestra, a Kontakt library, or a DAW.
- Do not say a voice is a real piano or Rhodes. Say which family it is.
- Do not paste a score with an unknown voice. Validate first.
