---
name: oro-music
description: Write, play and render music on Oro, Chase Hendrick's wave-terrain synthesizer. Use when the user asks to compose, score, arrange, make a beat or a drum piece, write for orchestra, piano, guitar, synth, drums or ambience, render a WAV, or drive the Oro app or website.
---

# Oro music

Oro is one instrument. A closed path crosses a mathematical landscape and the height under the path is the waveform. You do not pick a sample library. You write a score, and Oro plays it on its own voices: the orchestra, the drum kits and the ambience are all patches of that one synth.

## Where to play it

1. **No page, a WAV file** (needs this repository and Node 22): `node scripts/oro-score.mjs render score.txt --out piece.wav` runs the real Oro DSP offline at Pristine quality with the app's reverb and delay, measures loudness to -14 LUFS and limits peaks at -1 dBFS. `--bits 32` writes 32-bit float. `--prompt "..."` composes and renders in one go. `midi` writes a .mid, `link` prints a link that opens Oro with the score ready to play, `check` and `compose` print receipts.
2. **As MCP tools**: `node scripts/oro-mcp.mjs` (for example `claude mcp add oro -- node /path/to/Oro/scripts/oro-mcp.mjs`) gives oro_schema, oro_compose, oro_check, oro_render, oro_midi and oro_link. Files go to ./oro-renders.
3. **An open Oro page** (the website, the offline HTML or the desktop app): `oro.play(scoreText)` plays now and returns a receipt; `oro.compose({ prompt, style, bpm, key, mode, bars, seed })` writes a score; `oro.render(score, { bits: 32, download: true })` renders a WAV in the page; `oro.help()` lists every call, `oro.describe()` says what is loaded. Over `postMessage`: `{ source: 'oro-agent', id, type: 'play', args: [scoreText] }`, answered with `{ source: 'oro', id, ok, result }`. Calls that change the session (set, loadPatch, pattern, dot...) need the page opened with `?agent=1`.
4. There is no server route. `GET /api/oro` and `POST /api/oro` are not served on hendrickresearch.com. Do not invent a host that renders audio.

Downloads: [latest release](https://github.com/ChaseHendrick/Oro/releases/latest). Play in the browser: https://www.hendrickresearch.com/music/oro/

## The voices

Call `oro.schema()` or `node scripts/oro-score.mjs schema` for the live list with ranges. Do not invent a voice.

| Section | Voices |
|---|---|
| strings | violin, viola, cello, contrabass, strings (section), spiccato, tremolo, pizz, harp |
| winds | piccolo, flute, oboe, cor (cor anglais), clarinet, bassoon |
| brass | horn, trumpet, trombone, tuba, brass (section) |
| choir | choir (ah), ooh |
| keys and mallets | piano, celesta, glock, xylo, marimba, vibes, chimes, bell |
| percussion, pitched | timpani (a struck skin on the Resonator, tuned to the note), gong |
| band and synths | guitar, bass, rhodes, organ, clav, lead, saw, arp, sub, pad, cloud |
| cinematic | riser, impact |
| ambience | rain, wind, ocean, vinyl, city, fire, thunder, drone, night, shimmer, swirl, chirp (birds) |
| kit (pitch x) | kick, snare, hat (0.2 or longer is open), openhat, clap, tom (x, or a note: below E3 low, else high), hitom, rim |
| drum pieces (pitch x) | crash, crash2, splash, china, ride, ridebell, kick2, subkick, snare2, rimshot, snap, pedalhat, floortom, midtom, shaker, tambourine, cowbell, agogo, conga, tumba, bongo, timbale, claves, block, triangle, taiko, bassdrum, zap, burst |

Aliases: vln, vla, vc, cb, picc, fl, ob, eh, cl, bsn, hn, tpt, tbn, tba, hp, pno, cel, glk, xyl, mba, vib, timp, gtr, ep, org, bd, sd, hh, oh, cp, cym, shk, tamb, tri. Plurals work (violins, horns).

Drum pieces beyond the classic kit get kit tracks of their own, eight pieces to a kit. A triangle is a pitched-up cymbal and the receipt says so.

## Voicing

* `voicing patch` (the styles below write it): every voice plays through its own instrument patch, on its own track. Oro adds tracks for the score (up to 16) and removes them when it ends.
* `voicing tint` (the 2.16 behaviour): voices play on the tracks there are, each keeping its land; only envelope and filter change.

## Styles the composer writes

`anime-song` (176 BPM, 36 bars: intro hook, verse, pre-chorus build with a riser and a snare roll, royal-road chorus, a kime break, the last chorus a semitone up, end hits; cues intro, verse, pre, chorus, break, hits, chorus-2, outro, end), `opening` (180 BPM picture-lock: cold, card-1..3, hits, title), `epic`, `symphonic`, `lullaby` (3/4), `orchestra-type` (the default), `strings`, `brass-choir`, `sparse`, `atlas`, `drums` (name a groove: rock, funk, hiphop, trap, house, techno, disco, dnb, breakbeat, halftime, metal, shuffle, jazz, bossa, samba, reggaeton, afrobeat, latin, march, taiko; "solo" adds a drum solo), `ambient` (rain, ocean, wind, city, fire or vinyl; "forest" adds birds, "storm" thunder), `lofi`.

Words in a prompt are enough: "anime opening song in E major", "trap beat", "epic trailer", "lofi with rain", "36 bars", "140 bpm", "no drums", "faster". The same prompt always writes the same score; pass `seed` for another.

## How to make a piece

1. Compose from a prompt, or write the text yourself.
2. Read `errors`: each has `line`, `field`, `message` and `fix`. Change that line and check again until `ok` is true. Read `warnings` too (range, shared tracks, approximated pieces).
3. Lock to a picture with `cue name beat`; the receipt gives `cues[].seconds`. `durationSeconds` is the length. `hash` tells two renders apart.
4. Render, play, or hand over a link.

## Score

Headers, one per line: `title`, `bpm` (or `tempo`), `bars`, `beats` or `time 3/4`, `key` (`key A`, `key Am`), `mode`, `style`, `swing` (0 to 0.6), `voicing`.

Notes: `voice pitch beat length velocity [pan] [every STEP [until BEAT | times N]]`. Time is in quarter notes from 0: a number, a fraction (`1/3`) or `2t` / `2tt` (triplet eighths after beat 2). A chord is a pitch with a type: `Cmaj`, `Cm`, `C7`, `Cmaj7`, `Am7`, `Bm7b5`, `Ddim7`, `G7sus4`, `Cadd9`, `Cmaj9`, `Am9`, `Csus2`, `C5th`, with an optional octave after the type (`Am74`) or after @ (`Am7@3`). `C5` is the note C in octave 5. A bare `C` is an error. `# comments` are fine.

```
title Paced
bpm 156
bars 4
key Am
voicing patch

cue title 12

violin A4 0 0.5 0.8
piano Am7@3 0 2 0.7
kick x 0 0.2 1 every 1
hat x 0.5 0.08 0.4 every 1
crash x 12 2 0.8
timpani A2 12 1 0.9
```

JSON is the same fields: `{ "bpm": 156, "key": "A", "mode": "minor", "voicing": "patch", "cues": [{ "name": "title", "beat": 12 }], "notes": [{ "voice": "violin", "pitch": "A4", "beat": 0, "len": 0.5, "vel": 0.8 }, { "voice": "hat", "pitch": "x", "beat": 0.5, "len": 0.08, "vel": 0.4, "every": 1 }] }`. `pitch` may be a MIDI number.

Limits: 128 bars, 8000 notes, 40 to 240 BPM. Renders up to 5 minutes.

## Do not

- Do not describe Oro as a sampled orchestra, a Kontakt library or a DAW. Every voice is the terrain synth.
- Do not say a voice is a real piano or Rhodes. Say it is Oro's piano voice.
- Do not paste a score with an unknown voice. Validate first.
- Do not call `/api/oro` or `/api/oro/beat`. Render with the script or the MCP tool, or play on an open page.
