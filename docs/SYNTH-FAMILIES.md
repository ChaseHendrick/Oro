# What is actually out there, and what Oro already is

Checked 4 October 2026. This is a map of the field, not a claim that Oro copies any of it.

## Wave terrain

Wave terrain synthesis is a path across a height field. The height is the sample. The name is late-1980s (Roads, *Computer Music Tutorial* lineage; Gold, 1979, is the earlier traversal idea). It is still a small field next to wavetable and FM.

| Instrument | What it is | What it is not |
|---|---|---|
| [Aaron Anderson — Terrain](https://github.com/aaronaanderson/Terrain) | Free open-source VST3/AU/CLAP. Trajectory and terrain recomputed per sample. Presets, microtonality (MTS-ESP). | Not a score language, not an orchestra. |
| Dawesome KONTRAST / Abyss / Novum | Commercial trajectory instruments. KONTRAST is the one people mean when they say a modern terrain synth. | Closed, not a browser instrument. |
| Steven Barile, ADC 2025 | A clear public walk through terrains, image terrains, wavetable import, path continuity, aliasing. | A talk, not a product. |
| Oro | 19 mathematical terrains plus import, 21 closed paths, the dot on a 3D map. Browser file and desktop app. | Not a sample library of those other instruments. |

## The rest of "all the synth types"

No serious all-in-one is one oscillator. The 2026 catalogues (Vital, Surge XT, Arturia V Collection, u-he, VCV Rack, Csound, SuperCollider, Dexed, Pianoteq, BBC Symphony) split into families. Oro's desktop engine already keeps an *element* of each, on purpose, instead of shipping twelve products:

| Family | Where people usually go | Element already in Oro |
|---|---|---|
| Subtractive | Vital, Surge, Diva, Hive | Ladder, SEM-inspired, diode-inspired filters; sub waves with PolyBLEP |
| FM | Dexed, Operator | Bessel terrain, phase and ring modulation |
| Wavetable | Vital, Serum, Pigments, Waldorf Wave (and the 2026 Wave Emulation) | Spectra terrain, audio and wavetable import, scan / raster paths |
| Additive | Razor, some organs | 11 inharmonic partial profiles, organ-like sub wave |
| Granular | Granulator, Portal, Pigments | Overlapping pitch grains in the effect rack |
| Physical | Pianoteq, Aalto, Karplus–Strong literature (Jaffe & Smith, CMJ 1983) | Karplus–Strong pluck with dispersion |
| Sampler | Kontakt, BBCSO | Recording import as a terrain or a sampler source, not an orchestra library |
| Vector | Prophet VS lineage | Four-corner vector mix |
| Drums | 808-style kits, Drumazon | Synthesized kit, not a sample pack |
| Noise | analogue noise | White, pink, blue, brown, plus loop textures |

Defaults for the new amounts stay at zero so old patches do not change. A filter colour here is a digital colour, not a cloned ladder.

## The score desk

The website that agents write to is a second face of the same idea: one land, many desks. Piano, guitar and marimba are waveguide strikes. Rhodes and bell are FM. Organ is additive. Lead and clav are filtered. Sub scans a wavetable row. Pad crossfades two terrains. Cloud is granular. The orchestra stays on the terrain oscillator. Kick, snare, hat, clap, tom, ride, crash, shaker and rim are synthesized. The grammar is in `skills/oro-music/` and `oro.schema()` on an open page. `node scripts/oro-score.mjs` checks a score and writes one. It does not render audio. `GET /api/oro` is not a route on the site.

## What not to chase

- A sampled BBC-style orchestra. That is a library, and it is not this instrument.
- Bit-exact clones of KONTRAST, Vital, or the Waldorf Wave. Wave Emulation (September 2026) already does the Wave, on Mac, as its own project.
- Signing certificates. The desktop builds stay ad-hoc signed. First launch still needs the extra click described in the README.
