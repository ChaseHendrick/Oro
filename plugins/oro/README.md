# Oro

Oro is a wave-terrain synthesizer. A closed path crosses a mathematical landscape, and the height under that path is the sound. This plugin teaches Claude how to write a score for that instrument and how to play it.

Use it when someone asks for a beat, an orchestra, a piano part, a guitar line, or a short piece. Claude writes a text score, checks it against Oro's voice list, and plays it if an Oro page is open. It does not render a WAV on a server. The desks are colours of one land: terrain, physical, FM, additive, subtractive, wavetable, vector, and granular. Drums are synthesized, not sampled.

The skill does not need an account or an API key. It does not read names, emails, addresses, or other personal data. A score is note names, tempo, and key.

Where a score can be sent, and nowhere else:

- An Oro page the person already has open, through that page's own `oro.play`. The score stays in that browser tab. The page puts the tracks back when the score stops.
- This repo on the person's own computer: `node scripts/oro-score.mjs check score.txt` prints a receipt (length, cue times, the fix for a bad line), and `render` writes a WAV next to it with Oro's own DSP. Nothing leaves the computer.
- The Oro MCP server from this repo (`node scripts/oro-mcp.mjs`), which runs the same checks and renders locally.

There is no `POST /api/oro` and no server WAV. Do not send a score to hendrickresearch.com for rendering.

Source and downloads: https://github.com/ChaseHendrick/Oro
Play in the browser: https://www.hendrickresearch.com/music/oro/
