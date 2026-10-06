# Oro score reference

Call `oro.schema()` on an open Oro page, or run `node scripts/oro-score.mjs schema`, before writing. That response is the contract: voices, aliases, families, limits, and styles. This file is the backup when you are not in the repo.

`GET /api/oro` is not served. Do not POST a score to a host to get a WAV.

## Limits

- bpm 40 to 240
- bars 1 to 128 (prefer 4 to 36)
- beats per bar 1 to 16, usually 4 (`time 3/4` sets it)
- notes up to 8000 (`every` repeats count)
- velocity 0 to 1
- pan -1 to 1
- swing 0 to 0.6

## Styles the composer knows

| style | tempo if you omit bpm | what it writes |
|---|---|---|
| orchestra-type | 156 | Strings in 8ths, brass stabs, choir pad, hats on 16ths, kick and bass |
| strings | 112 | Strings, optional bass, no drums |
| brass-choir | 96 | Horns, trumpets, trombones, choir |
| sparse | 84 | Long tones, little rhythm |
| atlas | 108 | Four bars using every synthesis family |
| opening | 180 | Cold flash, three name-card stabs, eight hits, title hold. Cues: cold, card-1, card-2, card-3, hits, title |
| anime-song | 176 | A TV-size anime opening (8, 16, 24, 36 or 53 bars): intro hook, verse, pre-chorus, royal-road chorus, kime break, last chorus a semitone up |
| epic | 132 | Taiko and spiccato ostinato, low brass, choir, risers and impacts |
| symphonic | 104 | Violins and flute on the tune, winds and horns inside, low strings, timpani, harp |
| lullaby | 72 | Celesta, harp and soft strings in 3/4 |
| drums | per groove | A drum piece in one of 20 grooves with fills, a break and an ending |
| ambient | 70 | Rain, ocean, wind, city, fire or vinyl with a drone, pads and sparse notes |
| lofi | 82 | Vinyl, swung boom-bap, Rhodes sevenths and bass |

Prompt words that select atlas: "all instruments", "every voice", "all desks", "atlas".
Prompt words that select opening: "opening", "anime", "shonen", "name card", "title card".

## Cues

`cue name beat` marks a picture hit. The receipt returns `seconds` for that beat (`beat * 60 / bpm`). Quarters and eighths do not move when swing is set.

## Chords

`piano Cmaj3 0 2 0.7` is C major rooted on C3; `Am7@3` and `Am73` are A minor seventh from A3. Types: maj, min, m, dim, aug, sus2, sus4, 5th, 7, maj7, min7, m7, m7b5, dim7, 7sus4, add9, maj9, m9. `C5` is a note. A bare `C` is an error.

## Repeats

`hat x 0 0.08 0.4 every 0.5` plays every eighth to the end. `every 1 until 16` stops before beat 16, `every 2 times 4` plays four.

## A small atlas, written by hand

```
title Atlas
bpm 108
bars 4
beats 4
key D
mode minor
style atlas

piano D3 0 3.5 0.75
guitar A2 0 1.2 0.7
rhodes F4 4 3 0.65
organ D4 4 3.5 0.5
marimba A4 8 0.4 0.7
lead F4 8 1.5 0.65
sub D2 8 3 0.8
pad D4 8 3.5 0.45
cloud F4 8 3 0.4
bell A5 10 1 0.5
violin F5 12 1.2 0.55
kick x 12 0.2 1
snare x 13 0.2 0.85
hat x 12.5 0.08 0.35
tom D3 14.5 0.35 0.7
```

If a line is wrong, the error from `check` says which voice or field to change, and `fix` says what to write. Fix that line only.

With `voicing patch` (or the default `tracks: 'add'` on a page) every voice gets its own track and patch, up to 16 tracks. Drum pieces beyond the classic kit get kit tracks of their own. With `tracks: 'share'` voices share the tracks there are and drum pieces borrow classic pads; the receipt's `warnings` says so. Timpani is pitched now: write `timpani D2`, not `x`.
