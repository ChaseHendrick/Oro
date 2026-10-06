# Oro 2.0 feature checklist

This checklist implements the owner's requested expansion. The target column records
that request; it does not independently audit another product. Validation is recorded
in [EXPANSION-VALIDATION.md](EXPANSION-VALIDATION.md).

| Area | Requested target | Oro 2.0 implementation |
|---|---|---|
| Unison | At least 7 copies | Up to 8 per voice |
| Subs | Two subs, seven waveforms each | Independent one/two-octave subs, seven waves each |
| Noise | White/pink/blue/brown, loop textures and recordings | Four colours, synthesized vinyl/waves/city loops, imported mono recording loops up to 16 seconds |
| Partials | 11 morphable inharmonic profiles | 11 original frequency-ratio profiles, continuous interpolation |
| Oscillator modulation | Phase and ring modulation | Independent amounts and frequency ratios |
| Pluck | Karplus-Strong | Noise-excited tuned feedback loop, decay/tone/dispersion |
| Path shaping | Windowing, Mangle, mirroring | Hann window, smooth coordinate distortion, X/Y/both mirrors, existing alternate traversal |
| Filters | Three ladder colours, SEM, diode, formant | Three ladder colours, SEM and diode-inspired digital types; existing Vowel formants |
| Paths | At least 18; Line, Square, Raster | 20, including those three |
| Mathematical terrains | At least 17 | 19 original mathematical terrains plus import |
| Image library | More than 300 entries | 320 distinct original 512 RGBA images, generated locally, searchable thumbnails/categories |
| Image channels | Preserve red/green/blue/brightness, live morph | Four retained planes; continuous channel selector for A and B |
| Mapping | Polar images and wavetables | Cartesian and polar for imported image, wavetable and audio terrains |
| Audio terrain | Complete audio-file import | Full recording timeline mapping plus frame-based wavetable import |
| Resolution | 512 by 512 | Generated and imported audio/visual tables default to 512; smaller mip levels remain for antialiasing |
| Modulation targets | About 32 each with own LFO/envelope/4 controllers | 40 targets each with independent LFO, six-stage envelope and four source/depth/curve slots |
| LFO controls | Skew/delay/attack/phase/offset | All five, with tempo sync/retrigger retained |
| LFO repeats | 1 to 32 | 1 to 32, plus zero for continuous |
| Steps LFO | 32 values, glide and smooth | 32 drawable values, glide and smooth interpolation |
| Envelopes | Six stages, six modes | Delay/Attack/Hold/Decay/Sustain/Release; Gate, One-shot, Loop, Ping-pong, Trigger hold, Pluck |
| Effects scale | 22 effects, four slots/layer, nine layouts | 40 effects, four slots/track, ten layouts |
| Missing effects | Shimmer/flanger/phaser/overdrive/decimator | All five distinct algorithms |
| Additional effects | Granular shift, four-band EQ, ducking, OTT-style | Overlapping pitch grains, four-band EQ, raw-source sidechain ducking, three-band upward/downward compression |
| Vector mixing | Four-corner mix | Equal-power corners in selectable banks of four tracks |
| Arpeggiator | 36 scales, 23 rhythms | 40 distinct scales, 28 trigger masks |
| Patch manager | Categories/author/folders | Save metadata, search, category grouping, folder filtering |
| Favourites | 36 recalled by MIDI Program Change | 36 ordered slots, UI recall and MIDI values 0 to 35; library export/import |
| Display | 24 palettes, six views | 24 dark/light palettes, six camera presets and six render styles |
| Saved views | Camera save/recall | Named captures with restore/delete and per-computer persistence |
| Modulation display | Overview grid | All 40 targets with live bars and inline depth/rate controls |

The image library and noise textures are original procedural material. They are not a
copy of another instrument's asset library. Filters and partial profiles describe digital
colours rather than exact hardware or acoustic models. Importing recordings provides real
recorded sources. Browser codecs determine non-WAV format availability.

All new synthesis amounts default to zero and the track racks default to bypass. Saved
numeric parameter, terrain, path and source identifiers retain their meanings. Old 16-step
LFO cells are duplicated into 32 steps to preserve their timing. Large imported sessions
and preset libraries use IndexedDB when necessary; JSON exports remain portable backups.

A maximum-size session can still exceed one audio thread's budget. Per-track effects and
eight-copy unison are capabilities, not a guarantee that every voice, every track and every
expensive effect can run together on every computer. See the measured benchmark bounds.
