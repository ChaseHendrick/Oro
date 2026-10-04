# Oro

Oro is a wave-terrain synthesizer. A closed path crosses a mathematical landscape, and the height under that path is the sound. This plugin teaches Claude how to write a score for that instrument and how to play it.

Use it when someone asks for a beat, an orchestra, a piano part, a guitar line, or a short piece. Claude writes a text score, checks it against Oro's voice list, and plays it if an Oro page is open. It can also render a WAV from the site. The desks are colours of one land: terrain, physical, FM, additive, subtractive, wavetable, vector, and granular. Drums are synthesized, not sampled.

The skill does not need an account or an API key. It does not read names, emails, addresses, or other personal data. A score is note names, tempo, and key.

Where a score can be sent, and nowhere else:

- An Oro page the person already has open, through that page's own `oro.play`. The score stays in that browser tab.
- The origin of that same page, if Claude is asked to render over HTTP. On this site that origin is https://www.hendrickresearch.com, at `POST /api/oro`, `POST /api/oro/compose`, and `POST /api/oro/beat`. The request is rendered and returned. It is not stored.

Source and downloads: https://github.com/ChaseHendrick/Oro
Play in the browser: https://www.hendrickresearch.com/music/oro/
