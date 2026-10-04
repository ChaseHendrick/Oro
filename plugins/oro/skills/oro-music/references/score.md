# Oro score reference

Fetch `GET /api/oro` on the user's Oro origin before writing. That response is the contract: voices, aliases, families, limits, and examples. This file is the backup when the network is down.

## Limits

- bpm 40 to 220
- bars 1 to 32 (prefer 4 or 8)
- notes up to 2000
- velocity 0 to 1
- pan -1 to 1

## Styles the composer knows

| style | tempo if you omit bpm | what it writes |
|---|---|---|
| orchestra-type | 156 | Strings in 8ths, brass stabs, choir pad, hats on 16ths, kick and bass |
| strings | 112 | Strings, optional bass |
| brass-choir | 96 | Horns, trumpets, trombones, choir |
| sparse | 84 | Long tones, little rhythm |
| atlas | 108 | Four bars using every synthesis family |

Prompt words that select atlas: "all instruments", "every voice", "all desks", "atlas".

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

If a line is wrong, the error from `POST /api/oro` says which voice or field to change. Fix that line only.
