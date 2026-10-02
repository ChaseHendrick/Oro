# Orograph research brief: wave-terrain synthesis and the Conductive Labs Terrain Synth

Consolidated from 8 research sweeps and their fact-check passes. Date: 2026-10-02. Target: Orograph, the original clean-room wave-terrain synth in `/home/user/synth` (`package.json` name `orograph`, productName `Orograph`). It uses three.js visuals, an AudioWorklet engine and an Electron desktop build.

**Evidence tags**
- **[C]** Confirmed by an independent fact-check, or verbatim in a source that was read directly.
- **[S]** Read directly from the cited source by one sweep, but not independently re-checked.
- **[O]** Official wording seen only in a search-engine snippet of a blocked page (the Kickstarter campaign page or the User Guide PDF). Treat as unconfirmed.
- **[E]** Result of an empirical test run during the research.
- **[I]** Inference, either by a sweep or by me.
- **[X]** Contradicted by a better source.
- **[U]** Could not be verified.
- **[R]** A fact about the Orograph repo, cited by file path.
- **[STD]** Standard mathematics, not taken from a sweep source.
- **[REC]** Our design recommendation. This is not a fact about the product.

**Access limits.** These all returned Cloudflare or 403 blocks, and none were bypassed:
- conductivelabs.com, including `/terrainsynth/`
- the User Guide PDF, https://conductivelabs.com/wp-content/uploads/2026/05/WTS_UserGuide-3.pdf
- the Manual PDF, https://conductivelabs.com/wp-content/uploads/2026/05/The-WTS-User-Manual-v0.13.pdf
- the Kickstarter campaign page, ModWiggler, Gearspace and Reddit

The best primary sources we did reach:
- Steve Barile's ADC 2025 deck: https://data.audio.dev/talks/2025/implementing-wave-terrain-synthesis.pptx (called "ADC slide N" below)
- the ADC talk video: https://www.youtube.com/watch?v=lCGDGtab6CE
- the public Kickstarter updates feed: https://www.kickstarter.com/projects/terrainsynth/terrainsynth/posts.atom
- Conductive Labs (CL) YouTube descriptions, frames and captions
- the 24-post Elektronauts thread

The WebSearch budget ran out partway through.

**Clean-room rules.** We collected facts and parameter names only. No CL code, artwork, palettes, help text, factory content or User Guide prose was copied. Open-source code was read only to learn algorithm facts; licences are listed in §4.3.

---

## 0. Key takeaways

1. **Hardware only, no web demo found.** The Terrain Synth is a hardware instrument. No readable source mentions an interactive browser demo on conductivelabs.com. The `?v=0b3b97fa6688` in the user's link appears on other conductivelabs.com pages too, so it is probably a site-wide cache-buster [I] (https://www.elektronauts.com/t/terrain-digital-synth-from-conductive-labs/237837).
   - The "dot on the 3D map" matches the hardware display: a path and a dot drawn over a 3D terrain.
   - The developer says the dot is a slowed-down visualisation [C] (https://www.youtube.com/watch?v=acCSNmM1VVg).
   - A mouse can be mapped to Path Position X/Y to "move the path around the terrain" [C] (https://www.kickstarter.com/projects/terrainsynth/terrainsynth/posts/4654562).
2. **CL's disclosed engine method** [C] (ADC slides 15–37; https://www.youtube.com/watch?v=lCGDGtab6CE):
   - procedural terrains are evaluated analytically;
   - image and wavetable terrains are resampled to 512×512;
   - samples are spaced by equal arc length along the path;
   - edges reflect;
   - sync is a phase multiplier, and phase distortion is uneven sample spacing;
   - anti-aliasing is a per-note FFT brick-wall filter recomputed on the fly, at 48 kHz.
3. **Orograph already takes a different route** [R] (`src/dsp/dsp-core.js`, `docs/ARCHITECTURE.md`):
   - the terrain wraps as a torus instead of reflecting;
   - mip-mapped tables are chosen by traversal speed;
   - the oscillator runs at 2× oversampling with a 63-tap half-band decimator;
   - a DC blocker runs per voice.

   This is an original, defensible design, and it has prior art in Plaits, the Aaron Anderson Terrain plugin and the tmhglnd Max package (§3.7).
4. **Pinned stack** [R] (`package.json`): three ^0.186.1, @dimforge/rapier3d-compat ^0.21.0, electron ^44.5.1, electron-builder ^26.15.3, vite ^8.3.2, vite-plugin-singlefile ^2.3.3, vitest ^5.0.3. All are current as of 2026-10 (§5).
5. **Biggest unknowns** (§7):
   - CL's full terrain and path name lists and exact parameter ranges. These live in the blocked Manual and are not needed for a clean-room build.
   - Whether the browser demo the user remembers actually exists.
   - The CPU cost of a "pristine" per-cycle FFT mode in JavaScript.

---

## 1. Product facts (Conductive Labs Terrain Synth)

### 1.1 Identity, company, status

| Fact | Tag | Source |
|---|---|---|
| Conductive Labs LLC, Beaverton, Oregon. MuseWire says "Established in 2017". Barile's slide says "Cofounder & CTO, Conductive Labs – since 2016". Earlier products are The NDLR and MRCC, both Kickstarter-launched. | C | https://musewire.com/conductive-labs-announces-new-hardware-synthesizer-based-on-first-ever-terrain-oscillators-for-music-creation/ ; ADC slide 2 ; https://www.kicktraq.com/projects/terrainsynth/terrainsynth/ |
| Team: Steve Barile (cofounder & CTO, BSEE analog, "26 years at Intel"; the ADC description says 25); Darryl McGee (cofounder & CEO); Justin Johnson ("Lead Software Dev, DSP, Synth Engine Design"); Jesse Johansen; Grayson Silaksi; Ben Fleskes; Shashi Jain. | C | ADC slides 2–3 ; https://www.youtube.com/watch?v=lCGDGtab6CE |
| Origin: "In 2020, I was imaging a wave table and puzzling out how the maths worked…". About 3–4 years of development as of Nov 2025. | C | ADC slide 4 ; https://www.youtube.com/watch?v=acCSNmM1VVg |
| First public showing: Knobcon 2025, Sept 5–7. | C | https://www.synthtopia.com/content/2025/09/09/conductive-labs-terrain-synth-explores-new-territory-for-sound-design/ |
| Kickstarter pid 963923579. Ran 2025-09-19 to 2025-10-19 (30 days) with a $35,000 goal. Funded the first night. Closed at $89,377 from 103 backers (average $868). | C | https://www.kickstarter.com/projects/terrainsynth/terrainsynth/widget/card.html?v=2 ; https://www.kicktraq.com/projects/terrainsynth/terrainsynth/ |
| Card widget now: `post_campaign`, late pledges enabled, 145 backers, $130,342 (372%), 21 updates. Tiers: "Terrain Synth Early Bird" $899 (limit 20, sold out); "The Terrain Synth" $949 (116 backers). VAT, tax and shipping are excluded. Estimated delivery 2026-05-01. | C | https://www.kickstarter.com/projects/terrainsynth/terrainsynth/widget/card.html?v=2 |
| Prices: $949 / 808 € plus VAT. Late pledge $999. Retail $1,199. | C | https://synthanatomy.com/2025/09/conductive-labs-terrain-a-multi-timbral-morphing-hardware-synthesizer-with-terrain-synthesis.html ; https://sonicstate.com/news/2026/09/17/knobcon-2026-conductive-labs-terrain-synth/ ; https://www.synthtopia.com/content/2025/09/22/conductive-labs-terrain-synth-now-available-to-pre-order/ |
| Status: "Production Started" (2026-05-22). "Assembly has begun … should be in the mail in ~6 weeks" (2026-09-06). Knobcon 2026: "Shipping is expected in about six weeks" (2026-09-17). No readable source reports units in backers' hands as of 2026-10-02 [I]. | C | https://www.kickstarter.com/projects/terrainsynth/terrainsynth/posts/4676962 ; …/posts/4790883 ; https://sonicstate.com/news/2026/09/17/knobcon-2026-conductive-labs-terrain-synth/ |
| First run: "enough to build about 250 units … only have to deliver 90" (Nov 2025). | C | https://www.youtube.com/watch?v=acCSNmM1VVg |
| Firmware 1.0 by Sep 2026. User Guide is "35 story like articles (101 pages)"; Manual is 61 pages; more than 240 factory patches. | C | https://www.kickstarter.com/projects/terrainsynth/terrainsynth/posts/4790883 |
| Patch developers announced Oct 6 2025: Paul Bergmann, Jexus, Oscillator Sync, Venus Theory, Richard Devine, Barilium8 (Steve). | C | https://www.kicktraq.com/projects/terrainsynth/terrainsynth/ |
| Sound designers Jexus, Barilium8, Richard Devine and Venus Theory. A page dated 2026-09-14 carries the heading "2026-12-12 OFFICIAL LAUNCH ANNOUNCEMENT". | C | https://sounds-for-synths.com/conductive-labs-terrain-synth/ |
| Support moved from a spam-hit forum to Discord in Oct 2025. The Discord invite shows about 658 members. | C | https://www.elektronauts.com/t/terrain-digital-synth-from-conductive-labs/237837 (post 16) ; https://discord.com/api/v9/invites/ddBZqqH2hG?with_counts=true |

### 1.2 Voice architecture

| Fact | Tag | Source |
|---|---|---|
| "32 note polyphony (8 per timbre) / Four timbres (layers) that can be split or stacked / Two morphable terrains per voice / Up to 7x unison for each voice / Two sub-oscillators (-1 & -2) oct for each voice / White, Pink, Blue and Brown noise / Oscillator sync, Phase distortion, Mirroring and Windowing" | C | https://www.matrixsynth.com/2025/09/conductive-labs-introduces-new-terrain.html |
| "four timbres, A, B, C, and D. These are completely separate terrain engines with eight stereo voices each." Unison does not reduce polyphony. Also: tuning, glide, pan spread, mono/poly. | C | https://www.youtube.com/watch?v=3OGiXCYrKNM ; https://www.youtube.com/watch?v=acCSNmM1VVg |
| Sub-oscillator waveforms (2026): Sine, Half Sine, Triangle, Parabola, Square, 25% Pulse, Saw. The update text says "six" but lists seven. Sub −1 and −2 levels can be modulated per voice. | C | https://www.kickstarter.com/projects/terrainsynth/terrainsynth/posts/4733059 ; …/posts/4790883 |
| Looped noise samples: haze, wash, drift, city outdoors, waves, airplane, vinyl, amp, static, drone, sharp. | C | https://www.kickstarter.com/projects/terrainsynth/terrainsynth/posts/4733059 |
| VOICE page slots: LEVEL, PAN (range −100%..100%), MODE (Poly), Uni VOCS (3 seen), Uni SPRD (50%), Uni DTUNE (10 ct). | C | https://i.ytimg.com/vi/V6Pd3VkgZco/maxres3.jpg |
| Engine sample rate is 48 kHz. The talk says "our choice of like … 48k sampling rate". The slides alone only use 48 kHz as a worked example. | C | https://www.youtube.com/watch?v=lCGDGtab6CE ; ADC slides 5, 27 |
| Four Input Groups. A part is assigned to a group, and a group listens on a MIDI channel, a CV/Gate pair ("CV/GATE 3+4", duophonic), an MPE zone (LOWER) or ALL (omni). High/low note range gives splits and layers. "Init+ ALL" puts all parts in Group 1 with parts B–D inactive at volume 0. | C | https://www.kickstarter.com/projects/terrainsynth/terrainsynth/posts/4663715 ; …/posts/4790883 ; https://www.youtube.com/watch?v=MVTKI98GqCk |

### 1.3 Terrain library

| Fact | Tag | Source |
|---|---|---|
| "17 math-based terrains with infinite resolution / Dozens of image-based terrains / User loadable image & wavetable terrains (.jpg and .png, .wav)" | C | https://www.synthtopia.com/content/2025/09/22/conductive-labs-terrain-synth-now-available-to-pre-order/ |
| Picker counters seen on screen: "Terrain A Shape - 90/159" (Sep 2025), "6/178" (Knobcon 2025), "Terrain B Shape - 292/312" (May 2026). The library is growing. | C | https://i.ytimg.com/vi/poKAbQjci5s/maxres3.jpg ; https://i.ytimg.com/vi/d4X8c4p0Kcg/maxresdefault.jpg ; https://i.ytimg.com/vi/WQ-q3-cksPA/maxres2.jpg |
| Three terrain types: Wavetable, Image, Math/Procedural. | C | ADC slide 14 |
| Procedural terrains: "z = T(x,y)", "Infinite Resolution - floating point maths not waveform samples", "There is an actual 18.77th value, no LERPs", "Different coordinate systems and symmetries". | C | ADC slide 15 ; https://www.youtube.com/watch?v=acCSNmM1VVg |
| Procedural names on the slide: "Egg Create [sic], Drip, Spines, Perlin Noise, Harmonic, Cris-Cross". Slide 18: "Harmonic – a 'polar' terrain". | C | ADC slides 15, 18 |
| Names seen in UI: Drip Drop, Catmull-Rom, Warp Check, Checkered, Harmonic, Wav Sweep, Step, WH_RGB_86, WH RGB 91, checkerboard_512. Per-terrain params seen: "Corners" (Catmull-Rom), "Ripple" (Step). | C | https://i.ytimg.com/vi/WQ-q3-cksPA/maxres1.jpg ; https://i.ytimg.com/vi/ym9RH-H6jMk/maxres3.jpg ; https://www.kickstarter.com/projects/terrainsynth/terrainsynth/posts/4758098 ; …/posts/4733059 |
| Egg-crate family: z = sin(x)·sin(y), generalised to z = aₓ·wav(fₓ·x+φₓ, m) · a_y·wav(f_y·y+φ_y, m). a = amplitudes, f = frequency multipliers, φ = phase offsets, m = a float morph through Sine, Saw, Square, Triangle. "Distortions: Odd/Even, Stretch". Every equation variable is a modulation target. | C | ADC slides 16–17 ; https://www.youtube.com/watch?v=lCGDGtab6CE |
| Richard Gold's 1979 16×16 terrain is included, both raw and smoothed. | C | https://www.youtube.com/watch?v=poKAbQjci5s |
| Terrain pages: "'A' SELECT, MORPH, 'B' SELECT, A MOD 2, B MOD 2" and "A SHAPE (SEL), MORPH, A MOD 1–4". MORPH −100% means all A. A frame showing "Range: −100% to 45%" (MORPH at −55% under LFO) implies a −100..+100 span; that +100% means all B is [I]. | C | https://i.ytimg.com/vi/WQ-q3-cksPA/maxres1.jpg ; https://i.ytimg.com/vi/iK1tHVoFQgo/maxres3.jpg ; https://i.ytimg.com/vi/ym9RH-H6jMk/maxres3.jpg |
| Image terrains: "4-in-1 Terrains – Red, Green, Blue & Luminance Color Channels! Morphable (R->G->B->L->R) manually or by modulation source." The luminance weights are "not equally scaled". Images can use Linear or Polar mapping. | C | ADC slides 19–20 ; https://www.youtube.com/watch?v=lCGDGtab6CE |
| Image lessons from Steve: photos sound noisy; gradients ("skateboard park … ramps and hills and inclines") sound best; blurring reduces harmonics; internal storage is 512×512; there is no on-device image processing yet (it is on the wish list). | C | https://www.youtube.com/watch?v=acCSNmM1VVg ; https://www.youtube.com/watch?v=lCGDGtab6CE |
| Factory images include heightmaps of the Mariana Trench, Everest and the Grand Canyon, plus planet photos, all from Discord users. Some images were made in a paint program and some with AI. | C | https://www.youtube.com/watch?v=acCSNmM1VVg ; https://www.youtube.com/watch?v=MVTKI98GqCk |
| User terrains are embedded in the patch as a pre-scaled copy. A multi-part patch can reference up to 8 terrains (4 parts × 2). | C | https://www.kickstarter.com/projects/terrainsynth/terrainsynth/posts/4616404 |
| At ADC 2025, terrains could not be used as modulation sources. This was a UI choice, and it is "on the long list". | C | https://www.youtube.com/watch?v=acCSNmM1VVg |

### 1.4 Path (orbit) library

| Fact | Tag | Source |
|---|---|---|
| "18 morphable paths with infinite resolution". The UI header reads "Path Shape - n/18". | C | https://www.synthtopia.com/content/2025/09/22/conductive-labs-terrain-synth-now-available-to-pre-order/ ; https://i.ytimg.com/vi/iK1tHVoFQgo/maxres1.jpg |
| Names read on screen: "Line" (1/18), "Ellipse" (2/18), "Rose 3 Petals" (16/18). | C | https://synthanatomy.com/wp-content/uploads/2025/09/Conductive-Labs-Terrain-Synthesizer.jpg ; https://i.ytimg.com/vi/ym9RH-H6jMk/maxresdefault.jpg ; https://i.ytimg.com/vi/V6Pd3VkgZco/maxresdefault.jpg |
| Also read: "Square", the U1 assignment "SHAPE Cardioid x2", and the recipe text "SHAPE: Star". | S | https://i.ytimg.com/vi/d4X8c4p0Kcg/maxresdefault.jpg ; https://www.kickstarter.com/projects/terrainsynth/terrainsynth/posts/4733059 |
| Press: "from simple ones like ellipse and square to complex shapes like Lissajous, flower petals, and cardioids". Kickstarter quote: "make the playhead follow a circle or triangle". | C | https://www.gearnews.com/conductive-labs-terrain-synth/ |
| Order of the icons in the 5-column picker, read from icon shapes: Line, Ellipse, Triangle, Square, bow-tie, pentagram, overlapping-triangle star, raster (stacked lines), 4 Lissajous variants, a loop-in-circle (limaçon/cardioid-like), 2 epicycle/spirograph curves, then roses with 3, 4 and 5 petals. | I | ADC slide 23 ; https://i.ytimg.com/vi/ym9RH-H6jMk/maxresdefault.jpg |
| Slide text: "Lissajous (3 lopes) / Polygonal (symbol) / Rose (3 Pedal) / Closed loops can be smooth or piecewise continuous. Can be Cartesian or polar in nature." "Scaling, eccentricity, rotation, position, and phase are possible." | C | ADC slides 25–26 |
| PATH page 1: SHAPE, SIZE, W:H, ROTATE, POS X, POS Y. Defaults Ellipse / 50.0% / 0.0% / 0° / 0.0% / 0.0%. SIZE values seen from 62% to 200%. | C | https://i.ytimg.com/vi/iK1tHVoFQgo/maxres1.jpg ; https://i.ytimg.com/vi/poKAbQjci5s/maxres1.jpg |
| SIZE at 100% with a full-depth LFO shows "Range: 2% to 199%", which implies roughly a 0–200% span [I]. Another frame shows "Range: 14.9% to 187.1%". | C | https://i.ytimg.com/vi/V6Pd3VkgZco/maxresdefault.jpg ; https://www.kickstarter.com/projects/terrainsynth/terrainsynth/posts/4676962 |
| ROTATE wraps: a saw LFO at max "will just keep spinning forever … 360 degrees". The full knob span is unknown. | C (wrap) / U (span) | https://www.youtube.com/watch?v=poKAbQjci5s |
| PATH page 2: SHAPE, MANGLE (0%), O SYNC ("1.0 cyc"), WIN & MIR ("Off / Off"), PD TYPE ("Skew Sig"), PD AMT (0%). | C | https://i.ytimg.com/vi/ym9RH-H6jMk/maxresdefault.jpg ; https://i.ytimg.com/vi/ym9RH-H6jMk/maxres2.jpg |
| An LFO on Lissajous phase makes the figure appear to rotate. On non-Lissajous shapes, phase "distorts the path". | C | https://www.youtube.com/watch?v=MVTKI98GqCk ; https://www.youtube.com/watch?v=poKAbQjci5s |
| Paths "can be moved and sized, squeezed and rotated, and even twisted". | C | https://www.youtube.com/watch?v=3OGiXCYrKNM |
| Edges: the slide asks "Limit, Wrap or Reflect?". In the talk: "we chose to reflect", because it is more continuous. Terrain space is bounded to [−1,1] on both axes. | C | ADC slide 31 ; https://www.youtube.com/watch?v=lCGDGtab6CE |

### 1.5 Oscillator modifiers and extra synthesis

| Fact | Tag | Source |
|---|---|---|
| Hard sync: "theta [0, 1] -> [0, oSync]  jmap(theta, 0.f, 1.f, 0.f, oSync)", with examples ×1.42 and ×2.54; "how many times we're going around that path". `jmap` suggests the JUCE framework [I]. That this equals the UI's "O SYNC" parameter is [I]. | C | ADC slides 35–36 ; https://www.youtube.com/watch?v=d4X8c4p0Kcg |
| Phase distortion: "The spacing between the sample locations." It is demonstrated driven by a per-key envelope. The UI offers PD TYPE (for example "Skew Sig") and PD AMT. | C | ADC slide 37 ; https://www.youtube.com/watch?v=d4X8c4p0Kcg |
| Mirroring and windowing exist. Their exact behaviour is not documented in any readable source. | C / U | https://www.youtube.com/watch?v=d4X8c4p0Kcg |
| "Inharmonic Synthetic Partials": 11 morphable profiles (Stretch, Piano, Tubular, Bell, Octave, Metallic, Cluster, Tuned, Formant, FM, Chaos), plus Amount, Harmonic EQ (Tilt) and Mangle, all modulatable. The display uses an x1/x2/x4/x8/x16 axis. | C | https://www.kickstarter.com/projects/terrainsynth/terrainsynth/posts/4733059 |
| VOICE page 4/5, "HARMONIC EQ (TILT)": SELECT Inharmonic, PROFILE 1.0, AMOUNT 41.0%, HARM EQ −23.0%, MANGLE 0.0%, MIX 50.0%. | C | https://i.ytimg.com/vi/6v6_MiuPqIs/maxresdefault.jpg |
| Phase Mod (Ratio & Fixed) and Ring Mod (Ratio & Fixed) were added in Apr 2026. Later "we flipped it and now the carrier is a sine wave and the modulator is the complex terrain waveform". All 4 parts can be stacked as carriers. UI: "Phase Mod (~Linear Thru-Zero FM): Amt/Index, Ratio, Fine". | C | https://www.kickstarter.com/projects/terrainsynth/terrainsynth/posts/4654562 ; …/posts/4676936 |
| Karplus-Strong filter ("slightly temperamental"). A guide chapter is titled "Karplus Filter to Get a Pluck". | C | https://www.elektronauts.com/t/terrain-digital-synth-from-conductive-labs/237837?page=2 ; https://www.kickstarter.com/projects/terrainsynth/terrainsynth/posts/4790883 |
| Classic recipes: "Terrain + Path = Any Waveform: Sine / Square / Saw / Multi-Sine (Organ) / Triangle-ish / Thingy". Incline plane + circle = sine. Stepped plane + circle = square, and moving in Y gives PWM. A "corkscrew" gives a saw. | C | ADC slide 32 ; https://www.youtube.com/watch?v=lCGDGtab6CE ; https://www.youtube.com/watch?v=MVTKI98GqCk |

### 1.6 Modulation

| Fact | Tag | Source |
|---|---|---|
| "a zillion LFOs and envelopes, nearly every parameter has its own … no need for a deep modulation matrix. Each parameter also has 4 assignable expressive modulator slots … 12 mappable CCs, 3 pedals, 6 CV/Gates" | C | https://www.synthtopia.com/content/2025/09/22/conductive-labs-terrain-synth-now-available-to-pre-order/ |
| "LFO, Envelope and Expressive-mapper per parameter (32 per layer)". In the video: "about 32 LFOs, because there's 32 modulatable parameters per synth layer … 128". | C | https://www.matrixsynth.com/2025/11/terrain-synth-parameter-sequencing.html ; https://www.youtube.com/watch?v=V6Pd3VkgZco |
| Workflow: select a parameter, press LFO, Env or Exp, then turn the amount. Hold Init and press LFO to reset. | C | https://www.youtube.com/watch?v=MVTKI98GqCk |
| LFO fields: SHAPE (Triangle, Saw, Sequence seen), SKEW, RETRIG (Free / Reset / First), RATE (0.07–23 Hz seen), AMT (JOG), PHASE, DC OFF., REPEAT, DELAY, ATTACK, ATK CRV. Sequence shape adds SEQ STEP / SEQ VAL / SEQ LEN (8, 15, 32 seen) / SEQ REP. | C | https://i.ytimg.com/vi/V6Pd3VkgZco/maxresdefault.jpg ; https://i.ytimg.com/vi/iK1tHVoFQgo/maxres3.jpg ; https://i.ytimg.com/vi/3OGiXCYrKNM/maxres2.jpg |
| "Looping (1-32) enabled for all waveforms" (so LFOs can act as multi-shot envelopes). Sequence shape has up to 32 steps, with step, glide and smooth variants. Skew adds randomness to sequenced shapes. There is a "32 step cubic spline generator". | C | https://www.kickstarter.com/projects/terrainsynth/terrainsynth/posts/4676962 ; https://www.youtube.com/watch?v=V6Pd3VkgZco ; …/posts/4790883 ; https://www.elektronauts.com/t/terrain-digital-synth-from-conductive-labs/237837?page=2 |
| The screen shows the modulated range, for example "TERRAIN - A MOD 3 52.0% Range: 34.0% to 70.0%". | C | https://i.ytimg.com/vi/iK1tHVoFQgo/maxres3.jpg |
| Envelope: DAHDSR with six modes (Normal, Trigger, One-Shot, Loop, Ping-Pong, Sus-Hold). Fields: ATTACK, DECAY, SUSTAIN, RELEASE, ATK/DEC/REL CURVE, AMT (JOG), SPEED, DELAY, HOLD. | C | https://www.kickstarter.com/projects/terrainsynth/terrainsynth/posts/4676962 ; https://i.ytimg.com/vi/3OGiXCYrKNM/maxres1.jpg |
| Expressive Mapper: 4 slots, with columns SOURCE / CRV / AMT / DEST / POLARITY. "If set to Unipolar the curve is Exp to Log. When set to Bipolar curve it uses a Sigmoid curve." | C | https://www.kickstarter.com/projects/terrainsynth/terrainsynth/posts/4654562 |
| Mapper sources: Mod Wheel, Breath, Foot Pedal, Expression, Sustain 64, Pitch Bend, Velocity Note On, Velocity Note Off, Aftertouch (channel and poly merged into one source in FW 1.0), MPE Pitch Bend / Pressure / Timbre, 12 CC slots, 6 CVs, 2 expression pedals, mouse (9 sources) and Macros. Pitch bend and sustain lose their normal function when assigned. | C | …/posts/4663715 ; …/posts/4758098 ; …/posts/4790883 ; …/posts/4654562 |
| "Mouse-to-MIDI … X,Y & Vert scroll … total of 9 expressive parameter sources. By assigning these to Path Position X & Y the mouse can move the path around the terrain." | C | https://www.kickstarter.com/projects/terrainsynth/terrainsynth/posts/4654562 |
| Four macros (M1–M4), each set to Part, Group or Global mode and saved with the patch. User knobs U1/U2 (for example U1: CUTOFF, U2: RES). | C | https://www.youtube.com/watch?v=MVTKI98GqCk ; …/posts/4758098 |
| CV inputs: four ranges (0..+5 V, −5..+5 V, 0..+10 V, −10..+10 V). A min/max calibration page with live meters covers CV-1..6 and Ped1/Ped2. | C | …/posts/4654562 ; …/posts/4733059 |
| MIDI: direct targets are Vol, Pan, Cutoff, Res, Port Time, Sustain, Legato, Mono, Poly, All Sound Off and Bank Select (bypassed if the CC is assigned to a mapper slot). CC 7 acts as a group fader. Program Change loads the 36 favourites. MIDI Learn, MIDI Thru on/off, and external clock with an auto mode. No CC number map was found. | C | …/posts/4663715 ; …/posts/4790883 ; …/posts/4758098 |

### 1.7 Filters

| Fact | Tag | Source |
|---|---|---|
| Ladder A (morphing/compensating), Ladder B (discrete modes/non-compensating), Ladder LP (variable slope/compensating), SEM (morphing), Diode (fixed), Comb (fixed), Formant (vowel A/E/I/O/U), Formant+ (vowel + all pass). | C | https://musewire.com/conductive-labs-announces-new-hardware-synthesizer-based-on-first-ever-terrain-oscillators-for-music-creation/ |
| Modifiers are "morph, slope, and vowel". "All with key tracking and some drive." | C | https://synthanatomy.com/2025/09/conductive-labs-terrain-a-multi-timbral-morphing-hardware-synthesizer-with-terrain-synthesis.html ; https://www.youtube.com/watch?v=3OGiXCYrKNM |
| Page slots TYPE, CUTOFF, RES, KEY TRACK (Diode, 164 Hz, 82%, 70% seen). DRIVE is modulatable. | C | https://cdn.gearnews.com/wp-content/uploads/2025/09/conductive_labs_terrain_synth_2-1536x848.jpg ; …/posts/4758098 |
| Steve: "I find myself never even touching the filter … by shrinking the path, it's basically reducing the amount of complexity". | C | https://www.youtube.com/watch?v=acCSNmM1VVg |

### 1.8 Effects

| Fact | Tag | Source |
|---|---|---|
| Launch list: Delay, Ping-Pong Delay, Reverb, Shimmer Reverb, Chorus, Flanger, Phaser, Stereo Phaser, Overdrive, Decimator. | C | https://www.synthtopia.com/content/2025/09/22/conductive-labs-terrain-synth-now-available-to-pre-order/ |
| Four FX slots per layer, originally serial only. Later 9 topologies: "Serial, Dual, Twin-In, Stack, Parallel, Funnel, Twin-Out, Fan, Sidecar", with per-slot volume and wet/dry, and Part A–D send/aux destinations. | C | https://www.youtube.com/watch?v=acCSNmM1VVg ; …/posts/4676962 ; https://sonicstate.com/news/2026/09/17/knobcon-2026-conductive-labs-terrain-synth/ |
| Guide chapter "Icing on the Top - 22 FX, 4 Slots, & 9 Topologies". Effects added in 2026: Inharmonic Dispersion, WSOLA and Dual Granular pitch shifters, Environs (ambience samples), Four Band EQ (±20 dB SVF bands), Nimbus (reverb), Duck (sidechain), OTT. | C | …/posts/4790883 ; …/posts/4676962 ; …/posts/4733059 ; …/posts/4758098 |
| Delay page: TYPE, TIME, FEEDBACK, LOW CUT, HIGH CUT, MIX (Delay, 330 ms, 65%, **20 Hz**, 8.0 kHz, 30%). Reverb page: TYPE, PREDELAY, TIME (11.0 s seen), HIGH CUT, DAMPING, MIX. There are live meters and a trim on every FX box. | C | https://i.ytimg.com/vi/3OGiXCYrKNM/maxres3.jpg ; https://i.ytimg.com/vi/iK1tHVoFQgo/maxres2.jpg ; …/posts/4790883 |

### 1.9 Performance, vector, arp, patches

| Fact | Tag | Source |
|---|---|---|
| Vector: "triggered by NoteOn and will traverse the 5 vector lines. The distance from the yellow ball to the A-D corners determines the volume of each of the synth Parts". Segment times are user-set (250 ms seen); one-shot or loop. Later, mapper sources can drive the X,Y vector position. | C | …/posts/4663715 ; …/posts/4758098 |
| ARP page: MODE (Down, Order, Up), OCTAVES (3), RATE in ms (110–240), GATE (82–200%), SWING. Later: "Scale Repeats" (up to 8×), 36 scales, 23 rhythm patterns, and Arp Group Sync. | C | https://i.ytimg.com/vi/N7xGsZBOZ0U/maxres2.jpg ; …/posts/4790883 ; …/posts/4654562 |
| Audition ("Aud"): 12 presets (NOTE F4, NOTE F2, CHORD F2, SEQ MEDIUM, SEQ SLOW, CHORD SEQ, SYNCOPATE, TRIPLETS, FAST 16THS, SWING DUO, POLY STAB, PROG), stored per part and following Master Tempo. | C | …/posts/4758098 |
| Patches: system/multi (4 parts), single part, and module patches (LFO, filter). 36 favourites (6×6). Patch Manager (renamed from Patch Lib) has columns Name / Cat.1 / Cat.2 / Folder / Author / Date. 44 categories. Auto "Features" tags. A star marks a modified patch. Init+, Rand+, Copy+/Paste+. | C | https://www.youtube.com/watch?v=acCSNmM1VVg ; …/posts/4758098 ; …/posts/4676962 |
| Sequencer buttons Seq, Rest, Tie, Rec, Step, Play/Pause are on the panel. The step count is unknown. | C / U | https://i.ytimg.com/vi/mPUeg0vpRjc/maxres2.jpg |

### 1.10 Display: the "3D map and dot"

| Fact | Tag | Source |
|---|---|---|
| "Terrain synthesis is highly visual in nature so we chose a large 7-inch IPS display … You can customize the color palette, the visualization perspective and the 3D angles. This enables you to easily inspect the modulations on the path and terrain and the resulting waveform." | C | https://www.synthtopia.com/content/2025/09/22/conductive-labs-terrain-synth-now-available-to-pre-order/ |
| "The ball is just for your visualization … If you're playing an A440, that ball would go around 440 times a second." In the talk, the dot moves slowly for low notes and "it's actually showing you the phase distortion as it accelerates". | C | https://www.youtube.com/watch?v=acCSNmM1VVg ; https://www.youtube.com/watch?v=lCGDGtab6CE |
| POV: "6 view types of the terrain: 3 top down and 3 3D … 6 user selectable POVs … Save+ POV … Terrain color palette, Terrain type (6 view types), Camera Pan, Tilt & Zoom, & Z scale." | C | …/posts/4654562 |
| 24 palettes (slide: "8 of 24 palettes"; the settings swatch grid is 6×4). Slide 13 styles: top-down contour, smooth heatmap and quantised bands; 3D lines, wireframe and shaded. The first POV mimics a 3/4 wavetable view. | C | ADC slides 12–13 ; https://i.ytimg.com/vi/43b9pll5i88/maxres3.jpg ; https://www.youtube.com/watch?v=acCSNmM1VVg |
| On-screen colours: green path with a bright green dot; yellow filled waveform under the terrain; magenta partial bars (2026 builds, "We added the display of the waveform partials"). The 2026 graphics also show "vector movement and harmonic behaviour". | C | https://i.ytimg.com/vi/iK1tHVoFQgo/maxres1.jpg ; …/posts/4663715 ; https://sonicstate.com/news/2026/09/17/knobcon-2026-conductive-labs-terrain-synth/ |
| Screen layout: status bar; 4 part strips, each with S/M flags and 8 voice circles in per-part colours (blue, green, magenta, yellow); patch name; last MIDI event; tempo Int/Sync/Ext. Left: terrain plus waveform. Right: a context pane headed VAL/LFO/ENV/EXP. Bottom: a help line over 6 parameter slots. | C | https://i.ytimg.com/vi/iK1tHVoFQgo/maxres1.jpg ; https://i.ytimg.com/vi/WQ-q3-cksPA/maxres1.jpg |
| Grid view shows "all modulated parameters for a quick At-a-Glance view". Help+ covers 323 parameters and buttons. The style is deliberately "a little retro". The display is described as "really fast". | C | …/posts/4733059 ; …/posts/4758098 ; https://www.youtube.com/watch?v=lCGDGtab6CE ; https://www.elektronauts.com/t/terrain-digital-synth-from-conductive-labs/237837 (post 10) |
| The screen is not a touch screen: "the screen is just for output". A USB mouse, trackball or trackpad can be plugged in, used as a MIDI controller, and used to type patch names. | C | https://www.youtube.com/watch?v=acCSNmM1VVg ; https://www.elektronauts.com/t/terrain-digital-synth-from-conductive-labs/237837?page=2 |

### 1.11 Hardware panel, I/O, platform

| Fact | Tag | Source |
|---|---|---|
| Panel labels: Main, M1–M4 (two buttons each), Vol/Pan/Macro; top row All A B C D Init+ Help+ Pov Grid; 7" screen; 6 numbered menu encoders; Val/Lfo/Env/Exp beside 4 encoders; Filter, Amp; Seq, Arp, Rest, Tie, Rec, Step, Play/Pause; jog wheel + Ok; U1, U2; module selectors Voice/Fx/Filter/Path/Terrain and Settings/Patch Lib/Mixer (two separate small knobs); Shift+, Learn+, Hold, Rand+, Aud, Init+, Favs, Load+, Save+, Undo+, Redo+, Copy+, Paste+. | C | https://i.ytimg.com/vi/mPUeg0vpRjc/maxres2.jpg ; https://synthanatomy.com/wp-content/uploads/2025/09/Conductive-Labs-Terrain.jpg |
| I/O: single balanced stereo out; headphones with a volume knob; 6 CV and 6 gate inputs; 2 expression pedal inputs plus 1 sustain (marketed as "3x expression pedals"); 5-pin DIN MIDI in/out; USB host and USB device MIDI; no audio input. | C | https://www.youtube.com/watch?v=acCSNmM1VVg ; https://synthanatomy.com/2025/09/conductive-labs-terrain-a-multi-timbral-morphing-hardware-synthesizer-with-terrain-synthesis.html |
| Main-board silkscreen: VOLUME, PHONES, RIGHT, LEFT/MONO, CV6..CV1, SUST, EXP2, EXP1, MIDI IN/OUT, DEV, HOST, HDMI, 12VDC. | C | …/posts/4790883 |
| Raspberry Pi CM5 running Linux, chosen after testing against other systems. NVMe SSD, active heatsink, RTC battery, and a separate display/graphics board on an internal HDMI-to-FFC link. A CM5 shortage pushed the price "from $45 to as high as $80". | C | https://www.elektronauts.com/t/terrain-digital-synth-from-conductive-labs/237837 ; …/posts/4663715 ; …/posts/4758098 |
| Enclosure: powder-coated aluminium; UV-printed faceplate with contour-line "terrain" artwork; custom knobs; rack ears for 4U rack mounting. **Do not imitate.** | S | …/posts/4733059 ; …/posts/4790883 |

### 1.12 Import formats

| Format | Behaviour | Tag | Source |
|---|---|---|---|
| .png / .jpg | Becomes a height map. Four channels (R/G/B/L) can be morphed. Stored at 512×512. | C | ADC slide 20 ; https://www.youtube.com/watch?v=lCGDGtab6CE |
| .wav wavetable | Serum convention: "2048 'stride'", "up to 256 'frames'", resampled to "512 x 512". Filename flags: `-WTP` polar, `-WTS` stepped (no smoothing between frames), `-WTSP` both. | C | ADC slide 22 ; …/posts/4733059 |
| audio files | "storing the audio as terrains permitting playback as terrains instead of regular playback". | C | https://www.elektronauts.com/t/terrain-digital-synth-from-conductive-labs/237837?page=2 |
| Loading | Via USB mass storage (drag and drop into the terrain folder), or a USB thumb drive. | C | https://www.youtube.com/watch?v=acCSNmM1VVg ; …/posts/4733059 |
| Session / recipes | Auto-saves to a "JSON envelope". "Save+ Grid -> Text File" exports a recipe as .md. Firmware update bundles are zips. | C | …/posts/4676962 ; …/posts/4733059 ; …/posts/4758098 |

### 1.13 The browser demo the user remembers

- No forum post, article or video description mentions an interactive web demo with a rotatable 3D terrain and a movable dot [I] (https://www.elektronauts.com/t/terrain-digital-synth-from-conductive-labs/237837).
- The product page could not be read (403). A demo there is possible but unverified [U].
- The interactions that were verified are all on the hardware:
  - the path and dot over the 3D terrain [C];
  - the mouse mapped to Path Position X/Y [C] (https://www.kickstarter.com/projects/terrainsynth/terrainsynth/posts/4654562);
  - POV camera presets [C].
- Third-party browser wave-terrain demos do exist (§4.1).

### 1.14 Contradicted or unverifiable claims (do not rely on these)

| Claim | Status | Detail / source |
|---|---|---|
| Pressure-sensitive touch grid with no knobs | X | Contradicted by every other source: https://homemademusic.com/conductive-labs-terrain-synthesizer/ |
| "large touch screen" (Elektronauts #20) | X | Corrected by #21 and by Steve, "not a touch screen": https://www.elektronauts.com/t/terrain-digital-synth-from-conductive-labs/237837 |
| Final pledge total "about $88,500" | X | That was a final-hours snapshot. The real final was $89,377: https://www.kicktraq.com/projects/terrainsynth/terrainsynth/ |
| Company planned "end of July 2026" shipping | X | This was a forum user's guess: https://www.elektronauts.com/t/terrain-digital-synth-from-conductive-labs/237837?page=2 |
| Ships "October 2026" | U | Sources only say "~6 weeks" from Sep 6 and Sep 17 2026. |
| KS update #20 said "no final ship date" | X | #20 says "~6 weeks". "No final ship date yet" is in #18 (…/posts/4733059). |
| CM5 shortage was "Update #17" | X | It is post 4663715 (2026-04-14), roughly #14 by feed order. |
| "23 FX types" | X | The guide chapter says 22: …/posts/4790883 |
| HARMONIC EQ SELECT = "Harmonic" | X | It reads "Inharmonic": https://i.ytimg.com/vi/6v6_MiuPqIs/maxresdefault.jpg |
| Delay LOW CUT 70 Hz | X | It reads 20 Hz: https://i.ytimg.com/vi/3OGiXCYrKNM/maxres3.jpg |
| The official playlist contains every video | X | 5 videos are only in the channel feed: https://www.youtube.com/feeds/videos.xml?channel_id=UCeJFJz0QdyaI6v4fU9GBHOg |
| "552 LFOs", "35 of each per voice (1,120 in all)" | O / U | Kickstarter snippet only. The counts are internally inconsistent. |
| LFO has "10 skewable waveforms"; envelope stages up to 30 s each | O / U | Kickstarter / User Guide snippets |
| "10 morphable filters: Ladder, Classic, Physical & Vocal"; slope 3–24 dB; cutoff 20 Hz–20 kHz log; Morph LP→BP→HP | O / U | Kickstarter snippet. Every readable source says 8 types (plus Karplus added later). |
| "Grand Canyon" pilot analogy | O / U | Kickstarter snippet |
| Terrain names Ramp, Spiral, Interference, Spectral; Mod4 "Tri→Sqr→Sine→Saw" wrap morph; image Mod1 percentage map | O / U | User Guide snippets. "Step" is confirmed on screen (…/posts/4758098). |
| Serum/Surge/Hive/WaveEdit/modwave compatibility list, 10 MiB cap, 4096 samples/frame; audio becomes 512×512 rows | O / U | User Guide snippets |
| PD has "6 algorithm types", "Inv Mirror", "6 traversal modes" | O / U | User Guide snippets |
| Render type names "Top Regular / Top Lines / … / 3D Mesh (default)" | O / U | User Guide snippets. Only the 3 top-down + 3 3D split is confirmed. |
| User Guide version "v0.2.0" | U | Only the filename WTS_UserGuide-3.pdf is confirmed. "Manual v0.13" is confirmed by its filename. |
| "17/239" terrain counter | U | Frame not legible |
| ModWiggler and Gearspace comment summaries | U | Pages returned 403 |
| Livestream guest "Benn" is Benn Jordan | I | …/posts/4815046 |

---

## 2. What users liked and wished for

**Praise**

| Item | Tag | Source |
|---|---|---|
| "Every parameter has an LFO, that's juicy, and I really applaud that they seem easy to assign (no mod matrix menu diving)" | C | https://www.elektronauts.com/t/terrain-digital-synth-from-conductive-labs/237837 (post 9) |
| Gaz (Sonic Talk): the display is "really fast"; "one of the most exciting things I've seen in a long time" | C | same thread (post 10) |
| "The display is fun to look at all by itself"; "a step on from wavetable and gives useable new timbres"; "unique approach and nice interface" | C | same thread ; https://www.synthtopia.com/content/2025/09/22/conductive-labs-terrain-synth-now-available-to-pre-order/ |
| Support became responsive after the move to Discord | C | same thread (posts 13, 16, 17) |
| A user-study result from another wave-terrain instrument: most participants "relied heavily on the graphic visualisation and claimed they would not have understood WTS without it" (SUS score 78.3) | S | https://vbn.aau.dk/ws/files/286179553/thesisReport.pdf |

**Wishes and complaints**

| Item | Tag | Source |
|---|---|---|
| Multi-outs, to process the timbres separately (the hardware has a single stereo out) | C | https://www.elektronauts.com/t/terrain-digital-synth-from-conductive-labs/237837 (post 9) |
| "Will it have Google Maps Terrain support? Imagine making a patch that used the terrain map of a hike you did" | C | https://www.synthtopia.com/content/2025/09/09/conductive-labs-terrain-synth-explores-new-territory-for-sound-design/ |
| Terrains applied to sequences and LFOs (generative, "NDLR sort of action"); terrain-quantised note sequencing | C | Elektronauts posts 4, 20 |
| A touchscreen would suit image work; one commenter prefers the UI of the VOSIS Pro app | C | https://synthanatomy.com/2025/09/conductive-labs-terrain-a-multi-timbral-morphing-hardware-synthesizer-with-terrain-synthesis.html |
| No audio input for audio-to-terrain (file import was added later) | C | same Synth Anatomy article |
| Scepticism: "sounds no different to any other synth" (compared with Z-plane); "VST in a box"; price; the "all-new" claim disputed because Plaits has wave terrain; Animoog raised as prior art | C | Synthtopia 9/22 and 9/09 ; Synth Anatomy ; https://www.gearnews.com/conductive-labs-terrain-synth/ |
| Developer wish list: terrains as modulation sources; on-device image blur/processing | C | https://www.youtube.com/watch?v=acCSNmM1VVg ; https://www.youtube.com/watch?v=lCGDGtab6CE |
| Hsu (2002): the relation between terrain and trajectory is hard to intuit, so detailed visual feedback is recommended | S | https://doi.org/10.26686/wgtn.22123283 |
| Carswell: heavy terrain modulation was "too complex and unrepeatable" and was removed for learnability | S | https://doi.org/10.26686/wgtn.22123283 |

**Design implication [I]:** the visualisation is the main draw, and so is easy per-control modulation. Desktop users also want touch or mouse directness, real-world maps, multi-out or stems, and generative movement.

---

## 3. Wave-terrain DSP theory

### 3.1 Core model

- **Output.** `s[n] = T(x(φₙ), y(φₙ))`, with `φₙ₊₁ = (φₙ + f₀/fs) mod 1`, where the orbit `(x(φ), y(φ))` is closed on φ ∈ [0,1) [STD]. Csound advances the orbit phase by `pitch·2π/sr` per sample [S] (https://raw.githubusercontent.com/csound/csound/master/Opcodes/wterrain2.c). CL frames the technique as a rotated, closed-loop wavetable playhead: "48,000 / 440 = 109.0909 samples/cycle" [C] (ADC slides 5–7).
- **Periodicity.** "if an orbit is periodic then the resulting waveform will be periodic too, and if an orbit is fixed then the resulting sound is a fixed waveform characterised by a static spectrum" [S] (https://vbn.aau.dk/ws/files/286179553/thesisReport.pdf, after Mitsuhashi). So a timbre that moves needs a moving orbit or a moving terrain [S].
- **Pitch threshold.** Completing the path faster than about 20 cycles/s gives a perceptible pitch. Slower than that, the output is a control signal [S] (https://ndownloader.figshare.com/files/12101831).
- **Roles.** James treats the trajectory as "the more significant structure" and the terrain as a timbral state space [S] (https://doi.org/10.26686/wgtn.22123283). Steve: "It's the changing of the waveform which is interesting to your ear" [C] (https://www.youtube.com/watch?v=lCGDGtab6CE).
- **Related techniques.** Results have been compared to analogue pitched sounds, FM, a more dynamic AM, and dynamic waveshaping [S] (https://vbn.aau.dk/ws/files/286179553/thesisReport.pdf). Polygonal synthesis outputs the orbit coordinates themselves, whereas wave terrain uses them to address a scalar field [S] (https://www.dafx.de/paper-archive/2026/papers/DAFx26_paper_32.pdf).

### 3.2 Lineage (for credits in about box and docs)

- **Gold.** Rich Gold's "terrain reader": Bischoff, Gold & Horton, *Computer Music Journal* 2(3):24–29, 1978, DOI 10.2307/3679453 [S] (https://ndownloader.figshare.com/files/12101831). "A Terrain Reader" appears in the BYTE Book of Computer Music (1979), using a 16×16×8-bit terrain in 1 KB [S] (https://doi.org/10.26686/wgtn.22123283). CL's slide says "Earliest Reference is 1979"; its campaign text says 1978 [C].
- **Mitsuhashi (1982).** "Audio Signal Synthesis by Functions of Two Variables", *JAES* 30(10):701–706, AES e-lib 3815 [S]. Zabetian's bibliography misattributes this paper to "L. Mion and G. D'Inc" [S].
- **Borgonovo & Haus.** ICMC 1984 proceedings pp. 35–42, then *CMJ* 10(3):57–71 (1986). Their terrains were 50×50×8 (DMX-1000) and 512×512×8 (Fairlight) [S] (https://api.core.ac.uk/v3/works/77629314 ; https://doi.org/10.26686/wgtn.22123283).
- **Later work.**
  - Roads, *Computer Music Tutorial* pp. 163–167.
  - Csound `wterrain`, from 4.19 (Gillard/ffitch).
  - Mikelson's chapter and Nelson's work in *The Csound Book* (2000).
  - Comajuncosas (1997).
  - Hsu (2002).
  - S. James (2005 MA thesis, ECU; ICMC/SMC 2014).
  - Aaron Anderson's Terrain plugin (2018); Carswell (2023); Zabetian (2018).
  - Plaits v1.2; Dawesome Kontrast (2025).

  All [S] (https://doi.org/10.26686/wgtn.22123283 ; http://speech.di.uoa.gr/ICMC-SMC-2014/images/VOL_2/1437.pdf ; ADC slide 8).

### 3.3 Terrain design rules

- **Mitsuhashi's conditions** on [−1,1]²: (1) the function and its first partial derivatives are continuous; (2) the function is zero on the boundaries; (3) the first partials are zero on the boundaries [S] (https://vbn.aau.dk/ws/files/286179553/thesisReport.pdf). Roads condenses these to continuity plus zero edges [S] (https://doi.org/10.26686/wgtn.22123283).
- **Why they matter.** Discontinuities "spray" harmonics across the spectrum and may be crossed several times per orbit. Zero edges make wrap-around seamless. These rules are easy with math terrains and hard with arbitrary tables, and continuity is not the same as interesting sound [S] (https://doi.org/10.26686/wgtn.22123283).
- **Torus alternative.** A terrain that is periodic in both axes and wraps with `x − floor(x)` is also seamless under wrap. Csound does this [S] (https://raw.githubusercontent.com/csound/csound/master/Opcodes/wterrain2.c), and so does SuperCollider's WaveTerrain (inputs wrapped into 0..1) [S] (https://doi.org/sccode/Classes/WaveTerrain.html — see https://doc.sccode.org/Classes/WaveTerrain.html). Orograph's contract: "Terrain space is the unit torus … Every terrain table tiles seamlessly"; images and wavetables are mirror-tiled on their non-periodic axis [R] (`docs/ARCHITECTURE.md`).

### 3.4 Terrain families (with formulas)

| Family | Formula / construction | Notes | Tag / source |
|---|---|---|---|
| Separable product ("egg crate") | `z = aₓ·wav(fₓx+φₓ, m) · a_y·wav(f_y y+φ_y, m)`; base `sin x·sin y` | m morphs sine→saw→square→triangle. Csound `wterrain` uses `tabx[x]·taby[y]`. Zabetian uses `sin(πx)sin(πy)`. Carswell's 2DSINE test terrain: a centred circle of half the table width approximates a sine. | C ADC slide 16 ; S https://csound.com/docs/manual/wterrain.html ; https://vbn.aau.dk/ws/files/286179553/thesisReport.pdf ; https://doi.org/10.26686/wgtn.22123283 |
| Roads polynomial | `z = (x−y)(x−1)(x+1)(y−1)(y+1)` | Zero on all four edges. Singer's Nord patch scans it with an enveloped circle→spiral→centre orbit; an offset centre "adds some asymmetry". | S https://cim.mcgill.ca/~clark/nordmodularbook/nm_oscillator.html |
| Chebyshev product | `z = T₄(x_T x)·T₄(y_T y)`, `T₄(u)=8u⁴−8u²+1`; `T_{n+1}=2xT_n−T_{n−1}`, `T_n(cos θ)=cos nθ` | x_T and y_T are "iteration" scalings (more iterations give a richer sound) | S https://vbn.aau.dk/ws/files/286179553/thesisReport.pdf ; https://en.wikipedia.org/wiki/Chebyshev_polynomials |
| **Band-limited polynomial theorem** | On any ellipse, x and y are degree-1 trig polynomials in θ, so a polynomial terrain of total degree D yields harmonics ≤ D. On a Lissajous a:b orbit, harmonics ≤ a·deg_x + b·deg_y. Example: `z = Σₖ aₖTₖ(x)` on the unit circle gives exactly `Σ aₖ cos kθ` (organ-style additive). | These terrains are alias-free whenever D·f₀ < fs/2. | I (derivation from https://en.wikipedia.org/wiki/Chebyshev_polynomials) |
| Incline → sine | `z = x` with circle `x = cₓ + r cos θ` gives `z = cₓ + r cos θ` | A pure sine plus DC. With equal-arc-length sampling on an eccentric ellipse it becomes phase-distorted. | C recipe (ADC slide 32) ; I formula |
| Step → square / PWM | `z = sgn(y − y₀)`; circle centre c_y, radius r gives duty `= ½ + asin((c_y − y₀)/r)/π` for `|c_y − y₀| < r` | Moving the dot in Y is PWM | C recipe (https://www.youtube.com/watch?v=MVTKI98GqCk) ; I formula |
| Corkscrew → saw | `z = atan2(y − y₀, x − x₀)/π`; a circle centred on the axis gives a linear ramp with one jump | An off-centre circle gives a bent (PD-like) saw | C recipe (https://www.youtube.com/watch?v=lCGDGtab6CE) ; I formula |
| Polar "harmonic" spokes | A saw in polar angle whose spoke count N rises with radius ρ, so a centred circle of radius ρ plays the N(ρ)-th harmonic saw | Read from slide images only | I (ADC slide 18 images) |
| James appendix | `z = cos(4·atan(y + 1/x) − 12·sin(√(x² − 2x + y² + 1)))` on [−1,1]² | Carswell calls James's appendix "the best resource for tested equations" | S https://raw.githubusercontent.com/samcar17/Wave-Terrain-Synthesizer/main/Terrain%20Generator/A_Terrain_Generator.pde |
| Other published | `z = sin(22x² + y³)` (Zabetian terrain9); SuperCollider help `z = 2((x/100)² + (|sin 10y|/50)^{1/3}) − 1` | | S https://vbn.aau.dk/ws/files/286179553/thesisReport.pdf ; https://doc.sccode.org/Classes/WaveTerrain.html |
| Plaits analytic | Sines of rational functions of x, y and xy, kept bounded by the sine; one uses the soft clip `x/(1+|x|)`; constant gains such as 0.57 | MIT; read for facts only | S https://raw.githubusercontent.com/pichenettes/eurorack/master/plaits/dsp/engine2/wave_terrain_engine.cc |
| Gradient noise / fBm | Perlin: a lattice of random gradients, dot products, smoothstep fade; octaves double frequency and halve amplitude | Tile by wrapping the lattice period. Cap the octave count, because each octave raises spatial bandwidth [I]. tmhglnd bases: perlin, simplex, cell, checker, fbm, multi, hetero, rigid, hybrid. | S https://en.wikipedia.org/wiki/Perlin_noise ; https://github.com/tmhglnd/wave-terrain-synthesis |
| Images | Luminance or channel value is the height | Raw video/photos sound "buzzy: full of high frequencies and lacking in low harmonics". Dannenberg subtracts a temporally low-passed mean (AGC/DC). Sedes uses "an interpolating filter in order to smooth the terrain". | S https://ndownloader.figshare.com/files/12101831 ; https://www.dafx.de/paper-archive/2004/P_390.PDF |
| Stacked wavetables | Rows are single cycles. A horizontal orbit gives classic wavetable playback; slow vertical motion scans frames; closed orbits read across frames. Plaits terrains 5–7 are 64 waves × 128 samples; Max `2d.wave~` splits a buffer into rows. | Rows should be phase-aligned (Carswell: non-aligned crossfades click) [I] | S https://docs.cycling74.com/reference/2d.wave~ ; Plaits source ; https://doi.org/10.26686/wgtn.22123283 |
| Post-lookup shaping | Terrain plugin saturation `tanh(s·k·1.313)`, k = 1–16 | Orograph uses Lift/Fold after the lookup [R] | S https://github.com/aaronaanderson/Terrain/blob/main/Source/DSP/Terrain.h ; R `docs/ARCHITECTURE.md` |

**Image pre-processing recipe [I]** (combines Dannenberg, Sedes, James and Carswell above):
1. Convert to luminance or the chosen channel.
2. Scale to [−1,1].
3. Subtract the mean.
4. Blur, or build a mip pyramid.
5. Make the edges continuous by mirror-tiling or tapering.
6. Crossfade between frames or terrains per sample. Never hard-swap.

### 3.5 Orbit families (exact parametric equations)

Use φ ∈ [0,1) per note period. Then apply the transform: rotate by α, scale by (rₓ, r_y), translate by (cₓ, c_y). Orograph's transform: `ax = 2^(1.5·stretch)`, `ay = 2^(−1.5·stretch)`, `u = cX + px·cosθ − py·sinθ`, `v = cY + px·sinθ + py·cosθ`, wrapped mod 1 [R] (`docs/ARCHITECTURE.md`).

| Orbit | Equation | Closure / notes | Tag / source |
|---|---|---|---|
| Ellipse | `x = a cos θ, y = b sin θ`, θ = 2πφ | Equal-angle steps of `2π/109 = 0.057 rad` at A440/48 kHz; "High eccentricity -> phase distortion" | C ADC slide 29 |
| Csound wterrain2 curve 0, ellipse with speed warp | `x = kx + krx·sin(t + p·sin t)`, `y = ky + kry·cos(t + p·sin t)` | p warps traversal speed (a built-in PD) | S https://raw.githubusercontent.com/csound/manual/master/opcodes/wterrain2.xml |
| 1 Lemniscate | `x = cos u, y = sin u·cos u`, `u = t + p sin t` | Figure 8 | S same |
| 2 Limaçon | `x = sin t (cos t + p), y = cos t (cos t + p)` | p = 1 is the cardioid case [I] | S same |
| 3 Cornoid | `x = cos t·cos 2t, y = sin t (p + cos 2t)` | | S same |
| 4 Trisectrix (Ceva) | `x = cos t (1 + p sin 2t), y = sin t (1 + p sin 2t)` | | S same |
| 5 Scarabeus | `x = cos t (p sin 2t + sin t), y = sin t (p sin 2t + sin t)` | The manual prints the trisectrix formula here by mistake; this is the form in the C source | S https://raw.githubusercontent.com/csound/csound/master/Opcodes/wterrain2.c |
| 6 Folium | `x = cos²t (sin²t − p), y = sin t cos t (sin²t − p)` | | S wterrain2.xml |
| 7 Talbot | `x = cos t (1 + p sin²t), y = sin t (1 − p − p cos²t)` | All curves are scaled by krx/kry, offset by kx/ky and rotated by krot | S wterrain2.xml |
| Lissajous | `x = A sin(a t + δ), y = B sin(b t)` | Closed if a/b is rational. With coprime integers and t = 2πφ, the fundamental is f₀ [I]. "tend to be more dense near the edges". | S https://en.wikipedia.org/wiki/Lissajous_curve ; https://zenodo.org/records/850856/files/smc_2014_203.pdf |
| Rose | `r = a cos kθ`, so `x = a cos kθ cos θ, y = a cos kθ sin θ` | Integer k: k petals if odd, 2k if even. **Odd k closes after π**, so one 2π sweep per period plays it twice and it sounds an octave up unless θ = πφ [I]. Rational k = n/d closes at π·d/gcd (n·d odd) or 2π·d/gcd. Two-phasor form: `x = cos(ω₁t+θ₁) + cos(ω₂t+θ₂)`, symmetry `|a − b|`. | S https://en.wikipedia.org/wiki/Rose_(mathematics) ; https://zenodo.org/records/850856/files/smc_2014_203.pdf |
| Hypotrochoid | `x = (R−r)cos θ + d cos(((R−r)/r)θ)`, `y = (R−r)sin θ − d sin(((R−r)/r)θ)` | Closes at θ_max = 2π·LCM(r,R)/R; use θ = θ_max·φ | S https://en.wikipedia.org/wiki/Hypotrochoid |
| Epitrochoid | `x = (R+r)cos θ − d cos(((R+r)/r)θ)`, `y = (R+r)sin θ − d sin(((R+r)/r)θ)` | Includes the epicycloid and cardioid (d = r) | STD (not from a sweep source) |
| Superformula | `r(φ) = (|cos(mφ/4)/a|^{n₂} + |sin(mφ/4)/b|^{n₃})^{−1/n₁}` | Closes in 2π only when m is even (period 4π/m), so odd m needs 4π [I]. Csound `sterrain` has `kperiod` because "some km1 and km2 ratios may cause pitch shifts". | S https://en.wikipedia.org/wiki/Superformula ; https://csound.com/docs/manual/sterrain.html |
| Superellipse | `x = a·sgn(cos t)|cos t|^{2/n}, y = b·sgn(sin t)|sin t|^{2/n}` | Circle-to-square morph | STD |
| Polygon / star by arc length | Vertices P₀..P_{N−1}, cumulative lengths L_k, `s = φ·L_total`; find segment k, then `x = LERP(frac, x_k, x_{k+1})`, likewise y | "No phase distortion even after polygon transformations" | C ADC slide 28 |
| Line / raster (open) | "If the line Path is rotated the first sample is very likely ≠ last sample … Discontinuity - sawtooth" | Ping-pong traversal closes it with no jump [I] | C ADC slide 24 |
| Mitsuhashi general | `x = 2fₓt + Φₓ + Iₓ(t) sin(2πFₓt + Ψₓ)`, likewise y | A wrapped linear sweep plus an FM-like index term; can be periodic or aperiodic | S https://vbn.aau.dk/ws/files/286179553/thesisReport.pdf |
| Spiral / attractors / stochastic | Archimedes `r = a + bθ` [STD]. James's classes: constant, periodic, quasi-periodic, chaotic, stochastic. Lorenz/Henon used as orbit modulation; "continuous random walks" are the only audio-rate stochastic case that is not just noise. | | S https://doi.org/10.26686/wgtn.22123283 ; http://speech.di.uoa.gr/ICMC-SMC-2014/images/VOL_2/1437.pdf |
| Hard sync | `φ_s = (k·φ) mod 1` with k = laps per master period. Fractional k gives a hard-sync discontinuity. | Same idea as CL's jmap form | C ADC slide 36 ; I |

**Equal-arc-length vs equal-angle traversal.**
- With "Allocating equal phase to each edge … periodic pitch fluctuation audible as timbral instability" [S] (https://www.dafx.de/paper-archive/2026/papers/DAFx26_paper_32.pdf). CL: "Equal spacing ensures no phase distortion" [C] (ADC slide 27).
- Ellipse perimeter [C] (ADC slide 27): `P ≈ π(a+b)[1 + 3h/(10+√(4−3h))]`, with `h = (a−b)²/(a+b)²` [STD].
- For arbitrary parametric curves, build a cumulative-length LUT per control block (M ≈ 256 points) and invert it by search or interpolation [I].
- Exposing "Even / Angle" as a switch turns phase distortion into a sound-design control [I].

### 3.6 Pitch mapping and keeping the orbit on the map

- Phase increment `Δφ = f₀/fs`. Samples per cycle `= fs/f₀`, which is 109.09 at A440/48 kHz [C] (ADC slides 5, 27).
- The perceived fundamental is the orbit's **closure period**, not its parameter period. See the rose, superformula and hypotrochoid rows in §3.5 [I].
- Boundary handling:
  - Reflect (CL) [C].
  - Wrap/torus: Csound, SuperCollider, Carswell, Orograph [S/R].
  - User choice of wrap or fold (Zabetian) [S].
  - Sigmoid / clip / wrap / fold ("Edges SIGM CLIP WRAP FOLD", Sente) [S] (https://github.com/ngc6720/sente).
  - Plaits keeps the circle inside the map by shrinking it as the offset grows: `x = pathₓ·(1−|o|) + o` [S] (Plaits source).
- Pitch-dependent brightness limit (Plaits): `radius = 0.1 + 0.9·timbre·a·(2−a)` with `a = max(1 − 8f₀, 0)`. f₀ is probably normalised (f/fs), so the radius falls to 0.1 by about fs/8 [S/I] (Plaits source).
- Image-In crossfades phases at 0.5×, 1× and 2× the note frequency by ellipse size L = R1 + R2: `ampHigh = max(0, 1−2L)`, `ampBase = 1 − |L−0.5|·2`, `ampLow = max(0, 2(L−0.5))`. The purpose is not stated in the source [I] (https://github.com/odoare/Image-In/blob/main/Source/EllipseReader.cpp).

### 3.7 Anti-aliasing strategy

**Why it aliases.** CL's slide is titled "terrain == Aliasing Machine" [C] (ADC slide 33). Aaron Anderson: "alias frequencies are nearly impossible to predict and therefore cannot be prevented at the source" [S] (https://github.com/aaronaanderson/Terrain/blob/main/README.md). James notes that aliasing is partly "part of the 'sound'", so anti-aliasing should be optional [S] (https://doi.org/10.26686/wgtn.22123283).

**Bandwidth rule [I]**, derived from the Jacobi–Anger expansion (https://en.wikipedia.org/wiki/Jacobi%E2%80%93Anger_expansion):
1. On a circle `u = cₓ + r cos θ`, a terrain component `cos(2πk·u)` expands as `e^{iz cos θ} = Σ iⁿ Jₙ(z) e^{inθ}` with `z = 2πkr`.
2. So harmonic n has amplitude proportional to `|Jₙ(2πkr)|`, which is significant up to about `n ≈ 2πkr + 1`. Radius times spatial frequency behaves like an FM index.
3. In general, the highest harmonic is about the spatial frequency (cycles per unit) times the path length per lap. Equivalently, the highest output frequency is about the spatial frequency times the traversal speed, where speed = f₀·L.
4. Alias-free condition: `f₀·(K·L + 1) < fs/2`. Orograph's `mipLevel()` implements this: "A table of side S holds up to S/2 cycles per unit; traversed at `speed` units/s that is S/2 * speed Hz" [R] (`src/dsp/dsp-core.js`).

**Strategies**

| # | Strategy | Who uses it | Pros | Cons | Source |
|---|---|---|---|---|---|
| A | Render one cycle → FFT → zero bins above `(fs/2)/f₀` → iFFT → play as a wavetable, recomputed on the fly | CL ("BW Limit for each note frequency / FFT / Brick-Wall Filter / iFFT … unless you want it!"; "you have to do it on the fly"; a switch turns aliasing off) | Exact band-limit. Terrain lookups are per table point, not per sample, so bicubic or analytic terrains become cheap [I]. | Audio-rate orbit modulation is quantised to the update rate. Fast changes can click from non-phase-aligned crossfades (Carswell's fix: circular cross-correlation alignment). Costs one FFT per voice per update. | C ADC slide 34 ; C https://www.youtube.com/watch?v=lCGDGtab6CE ; S https://doi.org/10.26686/wgtn.22123283 |
| B | Per-sample oversampling + decimation | Terrain plugin (1/2/4/8/16×, JUCE half-band polyphase IIR; in its worst case 8× removed audible aliasing, 2× was the recommendation); Plaits (2×, decimate by averaging); tmhglnd tiers (2× none → 8× linear); Orograph (2× + 63-tap Kaiser half-band, flat to 0.2·fs₂, < −70 dB above 0.29·fs₂) | Handles audio-rate modulation of everything | Cost scales with the factor; residual aliasing at high f₀ | S https://github.com/aaronaanderson/Terrain ; S Plaits source ; S https://github.com/tmhglnd/wave-terrain-synthesis ; R `src/dsp/dsp-core.js` |
| C | Terrain mip pyramid with the level chosen from traversal speed (trilinear) | Orograph | A 2D analogue of per-octave wavetables. Costs about 33% extra memory. | Blurs at high speed; needs a seam-aware build | S https://en.wikipedia.org/wiki/Mipmap ; R `src/dsp/dsp-core.js` |
| D | Pitch-dependent orbit shrink | Plaits | Free | Changes timbre with pitch | S Plaits source |
| E | Intrinsically band-limited terrains (polynomial/Chebyshev on ellipses) | none found in practice | Exactly alias-free | A limited timbre family | I (§3.4) |
| F | polyBLEP/BLAMP | Polygon oscillators | About 20 dB SNR gain at 25× lower cost than oversampling | Needs known discontinuity positions and sizes, so only for orbit corners or known seams | S https://www.dafx.de/paper-archive/2017/papers/DAFx17_paper_100.pdf |
| G | ADAA: `x₁(n) = (F(u(n))−F(u(n−1)))/(u(n)−u(n−1))`, else `½(f(u(n))+f(u(n−1)))` | 1D waveshapers; AA-IIR for wavetables (Gabrielli et al. 2022) | Cheap in 1D | No closed form for 2-input `f(x,y)` line integrals, so it applies only after rendering to 1D | S https://dafx.de/paper-archive/2022/papers/DAFx20in22_paper_7.pdf ; I |
| H | Adaptive oversampling `OS = clamp((44100/fs)(2 + 4·f_norm), 2, 6)`, with f_norm from `clamp(f₀−200,0,7800)/7800` (possibly square-rooted) | DAFx26 polygon oscillator | Spends CPU only where needed | Exact formula uncertain in extraction | S https://www.dafx.de/paper-archive/2026/papers/DAFx26_paper_32.pdf |
| I | None; user keeps orbits small | dbRackModules ("scale down the curves to cut down high frequencies") | Zero cost | Aliases | S https://github.com/docb/dbRackModules |

**Decimator phase.** Linear phase pre-rings. Minimum phase puts all ringing after the event, which forward masking hides better [S] (https://ccrma.stanford.edu/~jos/filters/Linear_Phase_Really_Ideal.html).

**Cost estimate for strategy A in JS [I, needs benchmark]:**
- One update per 128-sample block per voice is about 375 updates/s.
- 32 voices × 2 FFTs × 375 ≈ 24k FFTs/s of size up to 2048, which may be too heavy in plain JS.
- Mitigations:
  - adaptive N = next power of two ≥ 2·Kmax + 2, capped at 2048 (high notes are cheap);
  - re-render only when parameters change (track a "dirty" flag);
  - update every 2–4 blocks;
  - WASM.

### 3.8 DC and normalisation

- DC offset is common, for example when the orbit reads a region above zero. Carswell provides AC-coupled outputs (an RC high-pass at about 10 Hz) alongside DC-coupled ones [S] (https://doi.org/10.26686/wgtn.22123283). CL publishes no DC handling [U].
- DC blocker: `y[n] = x[n] − x[n−1] + R·y[n−1]`, `H(z) = (1−z⁻¹)/(1−Rz⁻¹)`; "R=0.995 is good" at 44.1 kHz [S] (https://ccrma.stanford.edu/~jos/filters/DC_Blocker.html).
  - −3 dB is at about `(1−R)·fs/2π`, roughly 35 Hz for R = 0.995 at 44.1 kHz.
  - For about 5 Hz at 48 kHz, use `R ≈ 1 − 2π·5/48000 ≈ 0.99935` [I].
  - Orograph primes the blocker per orbit ("Start the DC blocker as if it had always been running on this orbit") [R] (`src/dsp/dsp-core.js`).
- Level depends on how wide a range of terrain values is actually read. Roads suggests peak-normalising the output [S] (https://doi.org/10.26686/wgtn.22123283). Plaits applies constant gains and soft clipping [S].
- Orograph tables are normalised to `max|h| = 1` with mean 0 [R] (`docs/ARCHITECTURE.md`), and a full-scale voice sits at −6 dBFS [R] (`src/dsp/dsp-core.js`). An optional slow RMS compensation, local to the orbit, would even out loudness as the dot moves [I].

### 3.9 Interpolation

- **None (truncation).** Csound wterrain does this [S]. Truncating the index adds noise [S] (https://vbn.aau.dk/ws/files/286179553/thesisReport.pdf). Gold's 16×16 terrain gives the lo-fi flavour [S].
- **Bilinear.** `f ≈ f₀₀(1−x)(1−y) + f₁₀x(1−y) + f₀₁(1−x)y + f₁₁xy`. It is linear along the axes and quadratic along other lines [S] (https://en.wikipedia.org/wiki/Bilinear_interpolation). Users: SuperCollider WaveTerrain, Carswell, Plaits user terrain (64×64 int8), deermichel, Image-In, Orograph [S/R]. The slope breaks at cell edges add HF content on coarse tables [I].
- **Bicubic (C¹), Keys kernel.** `W(x) = (a+2)|x|³ − (a+3)|x|² + 1` for |x| ≤ 1, and `a|x|³ − 5a|x|² + 8a|x| − 4a` for 1 < |x| < 2, with a = −0.5 (Catmull-Rom) [S] (https://en.wikipedia.org/wiki/Bicubic_interpolation). Sente appears to use a 4×4 Hermite kernel [I].
- **Analytic, no table.** CL procedural terrains [C], the Terrain plugin, naogit and Zabetian gen~ [S].
- **Table sizes in the field:**
  - Gold: 16×16×8-bit.
  - Borgonovo & Haus: 50×50 and 512×512.
  - Plaits wavetable terrains: 64×128; user terrain 64×64.
  - CL: 512×512 [C].
  - Carswell: 1024×1024 int16 (2 MB).
  - tmhglnd: 128–1024, default 512.
  - Orograph: level 0 = 512 plus a mip chain [R].

  [S] https://doi.org/10.26686/wgtn.22123283 ; Plaits source ; https://github.com/tmhglnd/wave-terrain-synthesis.
- **Memory.** 512² × float32 = 1 MiB, plus about 33% for mips. Two slots × 4 parts is about 10.7 MiB [I].

### 3.10 Smoothing and dynamic terrains

- Smooth every orbit and terrain parameter per sample (Plaits ParameterInterpolator; exponential smoothing in the krj course) [S] (Plaits source ; https://mu.krj.st/assignments/osc_s.html). Orograph uses one-pole smoothing (4 ms) plus per-sample ramps, with wrap-aware smoothing for rotation and the dot [R] (`src/dsp/dsp-core.js`).
- Frame-by-frame terrain updates cause a "stepped-like artifact". The fix is to buffer and interpolate frames [S] (http://speech.di.uoa.gr/ICMC-SMC-2014/images/VOL_2/1437.pdf). Orograph crossfades a new terrain over 30 ms [R].
- Moving the terrain under a fixed orbit can be "perceptually equivalent to parallel dynamic waveshaping and amplitude/frequency modulation" [S] (https://vbn.aau.dk/ws/files/286179553/thesisReport.pdf).

### 3.11 Polyphony patterns

- The usual pattern is one shared terrain with one orbit per voice:
  - Terrain plugin: 24 voices.
  - dbRack: 16 SIMD channels.
  - Image-In: 3 readers × 4 voices.
  - Wavoria: 12 voices on a shared, deformable field (README only).

  [S] (https://github.com/aaronaanderson/Terrain ; https://github.com/docb/dbRackModules ; https://github.com/odoare/Image-In ; https://github.com/simonlatham155-tech/wavoria)
- Zabetian's MPE mapping: the note sets orbit frequency; pitch bend and slide move the orbit in x/y relative to "a random position on the terrain" chosen per note; touch force limits orbit size [S] (https://vbn.aau.dk/ws/files/286179553/thesisReport.pdf).

---

## 4. Prior art and UX patterns

### 4.1 Implementations

| Project | Type / licence | Ideas worth knowing | Source |
|---|---|---|---|
| Csound wterrain / wterrain2 / sterrain | Opcodes / LGPL-2.1 | Product of two 1D tables; ellipse orbit; 8 named curves with one shape parameter plus rotation; superformula orbit with a `kperiod` pitch fix; floor wrap; truncation | https://csound.com/docs/manual/wterrain2.html ; https://csound.com/docs/manual/sterrain.html |
| SuperCollider WaveTerrain (SLUGens, N. Collins) | UGen / GPL-2.0+ | Buffer surface; audio-rate x,y in 0..1 with wrap; bilinear | https://doc.sccode.org/Classes/WaveTerrain.html |
| Max `2d.wave~`, `jit.peek~`; tmhglnd package | Max / LGPL-3.0 (package) | 2D wavetable rows; Jitter matrices as terrains; noise and fractal bases; zoom gives more overtones; quality tiers | https://docs.cycling74.com/reference/2d.wave~ ; https://github.com/tmhglnd/wave-terrain-synthesis |
| Mutable Instruments Plaits v1.2 | Eurorack / MIT | HARMO = terrain (8, interpolated), TIMBRE = radius, MORPH = offset; AUX output = `sin(y+z)` phase-distortion reinterpretation; 2× oversampling; radius shrinks with pitch; wavetables reused as terrains | https://pichenettes.github.io/mutable-instruments-documentation/modules/plaits/firmware/ |
| Aaron Anderson "Terrain" | JUCE plugin / GPL-3.0 | 17 trajectories with Mod A–D; per-sample analytic terrains; "Meanderance" (Perlin drift of the orbit); orbit feedback with a "spatial compressor"; envelope→size ("ES"); tanh saturation; 1–16× oversampling; OpenGL history points; the shader uses the same terrain formulas as the audio | https://github.com/aaronaanderson/Terrain |
| deermichel/waveterrain | Web, three.js + AudioWorklet / MIT | XY pads for centre and radius; Lissajous ratios and phase; one-pole parameter smoothing; the worklet posts terrain and orbit arrays to the UI; a 3×-tiled plane | https://github.com/deermichel/waveterrain |
| bellacaprino/waveterrain-mountain | Web fork / MIT | PNG/JPG heightmaps and OBJ/GLTF/STL meshes resampled to 256² with a downward Raycaster; mountain presets | https://github.com/bellacaprino/waveterrain-mountain |
| naogitnaohub/WaveTerrainSynth | Web, WebGL2 / no licence file | One terrain function module shared by the worklet and the renderer; arrow keys move the centre; avoids unbounded division near the origin | https://github.com/naogitnaohub/WaveTerrainSynth |
| Sente (ngc6720) | Web, three.js / no licence file | Edge modes SIGM/CLIP/WRAP/FOLD; up to 8 unison voices; orbit/radius deviation LFOs; Perlin terrains; bicubic-like interpolation [I] | https://github.com/ngc6720/sente |
| Image-In (O. Doaré) | JUCE / LGPL-3.0 | Image brightness as terrain; 3 elliptical readers; drag handles for centre, radii and angle; draws base (white), modulated (yellow) and per-voice (coloured) paths | https://github.com/odoare/Image-In |
| dbRackModules GeneticTerrain | VCV Rack / GPL-3.0+ | 4 chained terrains from 27 bases, multiplied; 10–11 curves; drag the circle on the display; reverse-direction right channel; DC blocker on by default; no band-limiting | https://github.com/docb/dbRackModules |
| Carswell Eurorack (samcar17) | Teensy / MIT software, CC BY-NC-SA hardware | 1024² int16; renders the orbit to a 1024-point table per 128-sample block and crossfades; click problem on fast changes | https://github.com/samcar17/Wave-Terrain-Synthesizer ; https://doi.org/10.26686/wgtn.22123283 |
| Zabetian (AAU 2018) | Max gen~ + Jitter | 10 terrains × 10 orbits; wrap/fold option; Lorenz "chaotic vibrato"; MPE | https://vbn.aau.dk/ws/files/286179553/thesisReport.pdf |
| Others | various | PasqualeMainolfi/WT (MIT), graue/waveterrain (CC0, genetic-programming terrains), kitzeller/wavelength (MIT, mixed reality), riccardomonaco (no licence file; 2D minimap + scope), austinfranklin (chaotic systems), Olbos (gen~) | https://github.com/PasqualeMainolfi/WT ; https://github.com/graue/waveterrain |
| Products referenced by users and press | commercial | Dawesome Kontrast (2025), Beetlecrab Vector, Waldorf Iridium, VOSIS Pro, Animoog ("animating a path through a wavetable grid"), Tasty Chips GR-MEGA, E350 Morphing Terrarium and Braids (2D wavetable, linear scan) | https://www.elektronauts.com/t/terrain-digital-synth-from-conductive-labs/237837 ; https://www.synthtopia.com/content/2025/09/09/conductive-labs-terrain-synth-explores-new-territory-for-sound-design/ ; https://doi.org/10.26686/wgtn.22123283 |
| Checked, no wave terrain found | | Surge XT, Phase Plant, Pigments, Aalto, Kaivo, Vital, Dune 3 | https://surge-synthesizer.github.io/manual-xt/ ; https://vital.audio/ |

### 4.2 UX patterns (with prior art)

1. **3D mesh with the orbit draped on its surface.** Terrain plugin history points, deermichel spheres, naogit ring, CL path and dot [S/C].
2. **One source of truth for height.** The GPU shader evaluates the same terrain as the audio (Terrain plugin), or a shared JS module is used by both (naogit) [S]. Orograph shares the transform and warp formulas between audio and visuals [R] (`docs/ARCHITECTURE.md`).
3. **Direct placement.**
   - Raycast a click onto the terrain to set the centre (three.js `webgl_geometry_terrain_raycast` pattern) [S] (https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/webgl_geometry_terrain_raycast.html).
   - Drag handles for centre, radii and angle (Image-In); drag a circle (dbRack); XY pads (deermichel).
   - A mouse mapped to path position (CL) [C].
4. **Show base vs modulated vs per-voice paths** (Image-In) [S]. Show the live modulation range as text, e.g. "Range: a to b" (CL) [C].
5. **Autonomous motion.** "Meanderance" (Terrain plugin), Lorenz modulation (Zabetian), gravity-driven particles on DEM terrain (Thibault & Gresham-Lancaster 1997, Leonardo Music Journal 7:11–15) [S] (https://doi.org/10.26686/wgtn.22123283).
6. **A waveform and spectrum readout** next to the map (CL), and a 2D minimap plus scope (riccardomonaco, naogit) [C/S].
7. **Camera presets** (CL POV: palette, view, pan/tilt/zoom, Z scale) [C].
8. **Per-control modulation** without a matrix (CL); a "Grid" view of everything that is modulated (CL) [C].
9. **A random start position per note** (Zabetian MPE) [S].
10. **Visual feedback is essential** for learnability (Hsu, Zabetian user study) [S].

### 4.3 Licence cautions

| Licence | Projects | Rule |
|---|---|---|
| MIT / CC0 | Plaits, deermichel, waveterrain-mountain, samcar17 software, PasqualeMainolfi, kitzeller, graue | Reuse is allowed with a notice. The repo already has `THIRD_PARTY_NOTICES.md` [R]. |
| GPL / LGPL | Terrain plugin, dbRackModules, SLUGens, Csound, Image-In, tmhglnd | Do not copy code. Learn algorithms only. |
| No licence file (all rights reserved) | naogit, Sente, riccardomonaco, Olbos, austinfranklin, Wavoria | Do not copy code. |

Source: https://github.com/aaronaanderson/Terrain ; https://github.com/docb/dbRackModules ; the other repos listed in §4.1.

---

## 5. Build stack (versions verified 2026-10)

| Component | Version / date | Key facts for us | Source |
|---|---|---|---|
| three | 0.186.1 (r186, 2026-09-24); @types/three 0.186.0 | ESM-only (CommonJS is a deprecation shim; no minified builds). Exports `three`, `three/webgpu`, `three/tsl`, `three/addons/*`. `THREE.Clock` is deprecated; use `THREE.Timer`. | https://registry.npmjs.org/three ; https://cdn.jsdelivr.net/npm/three@0.186.1/package.json ; https://cdn.jsdelivr.net/npm/three@0.186.1/src/core/Clock.js |
| WebGPURenderer | in r186 | Falls back to WebGL2 automatically, including when there is no adapter. Async init: use `setAnimationLoop` or `await renderer.init()`. ShaderMaterial, RawShaderMaterial, `onBeforeCompile` and EffectComposer are not supported; use TSL and `RenderPipeline` (renamed from PostProcessing in r183) with `bloom()` from `three/addons/tsl/display/BloomNode.js`. Still "experimental". | https://raw.githubusercontent.com/mrdoob/three.js/dev/manual/pages/webgpurenderer.html ; https://cdn.jsdelivr.net/npm/three@0.186.1/src/renderers/common/PostProcessing.js |
| WebGLRenderer | in r186 | "still maintained and the recommended choice for pure WebGL 2 applications", but will get no large new features. `UnrealBloomPass` requires renderer tone mapping. | same manual ; https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/postprocessing/UnrealBloomPass.js |
| WebGPU support | MDN BCD 8.1.4 | Chrome/Edge 144+ on Linux only with Intel Gen12+. Firefox 141+ partial, no Linux. Safari 26. | https://cdn.jsdelivr.net/npm/@mdn/browser-compat-data/data.json |
| pmndrs postprocessing | 6.39.5 (peer three `>=0.168 <0.187`) | WebGL only. Breaks on three r187 until updated. v7 is still beta. | https://registry.npmjs.org/postprocessing |
| Raycasting | n/a | `Mesh.raycast` reads only CPU positions, so GPU displacement (TSL `positionNode`, displacementMap) is invisible to it. Keep a CPU heightfield or ray-march analytically [I]. three-mesh-bvh 0.9.15 speeds up dense meshes. | https://cdn.jsdelivr.net/npm/three@0.186.1/src/objects/Mesh.js ; https://cdn.jsdelivr.net/npm/three-mesh-bvh@0.9.15/README.md |
| OrbitControls | r186 defaults | dampingFactor 0.05 (enableDamping false); maxPolarAngle π (the terrain example uses π/2); screenSpacePanning true; LEFT rotate / MIDDLE dolly / RIGHT pan | https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/controls/OrbitControls.js |
| Physics: Rapier | @dimforge/rapier3d-compat 0.21.0 (2026-09-25) | The three.js manual calls it "Actively maintained". The `-compat` build embeds WASM as base64 (about 4.34 MB); call `await init()`. `ColliderDesc.heightfield(nrows, ncols, heights /* column-major */, scale)`. Not cross-platform deterministic by default. Do **not** use the three.js `RapierPhysics.js` addon: it loads from `cdn.skypack.dev` at runtime. | https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.21.0/README.md ; https://raw.githubusercontent.com/mrdoob/three.js/dev/manual/pages/physics.html ; https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/physics/RapierPhysics.js |
| Other physics | jolt-physics 1.1.0; cannon-es 0.20.0 (2022); ammo.js unmaintained | cannon-es: "Apparently no longer maintained". Jolt multithread builds need SharedArrayBuffer [I]. | https://registry.npmjs.org/jolt-physics ; physics manual |
| AudioWorklet | Chrome 66 / Firefox 76 / Safari 14.1 | 128-frame quanta. Parameters default to a-rate. Return `true` from `process()` (Chrome). `processorOptions` is structured-cloned. Use `port.postMessage` with transfer lists. About a 3 ms budget; avoid garbage. There is **no built-in oversampling** except WaveShaperNode's 2×/4× (1D only). | https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/api/web_audio_api/using_audioworklet/index.md ; https://developer.chrome.com/blog/audio-worklet-design-pattern ; https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/api/waveshapernode/oversample/index.md |
| SharedArrayBuffer | n/a | Needs a secure context and cross-origin isolation (COOP + COEP). Orograph's worklet protocol uses `postMessage` plus transfers, so it does not need SAB [R]. | https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/javascript/reference/global_objects/sharedarraybuffer/index.md ; R `docs/ARCHITECTURE.md` |
| Worklet from file:// | tested | **Chromium 153:** Blob URL and relative-path `addModule` FAIL; a `data:` URL WORKS; the context stays suspended until a gesture. **Firefox 155:** all three work. **Electron 44.5.1:** all three work, and the context auto-runs. Chromium will not run an external `<script type=module src>` from file://; inline module scripts do run. | [E] /tmp/claude-0/-home-user-synth/6c571a55-a472-58a0-beeb-17dd4aa9ae64/scratchpad/stack/wtest/ |
| Tone.js | stable 15.1.22 (2025-04-27); `next` 15.5.44 | Stable is about 18 months old and adds a dependency (standardized-audio-context). Only useful for transport; Orograph has its own (`src/music/transport.js`) [R]. | https://registry.npmjs.org/tone |
| Web MIDI | Chrome 43, Edge 79; Firefox 108+ via a site-permission add-on; **no Safari** | Electron permission strings are `'midi'` and `'midiSysex'`; Electron auto-approves permissions unless a handler is set. WEBMIDI.js 3.3.1. | BCD data.json ; https://raw.githubusercontent.com/electron/electron/main/docs/api/session.md ; https://registry.npmjs.org/webmidi |
| Vite | 8.3.2 (2026-10-01) | Rolldown + Oxc. Node `^20.19.0 \|\| >=22.12.0`. `base: './'` for file:// and sub-paths. `?raw`, `?url`, `?worker&inline`. Default target Chrome 111 / Firefox 114 / Safari 16.4. | https://registry.npmjs.org/vite ; https://raw.githubusercontent.com/vitejs/vite/main/docs/guide/migration.md |
| vite-plugin-singlefile | 2.3.3 | README: "Worklets … not currently supported". Workaround: import the worklet `?raw` and load it as `data:text/javascript;base64,…` (tested OK in Chromium 153 and Firefox 155 from file://) [E]. Files in `public/` are not inlined. | https://cdn.jsdelivr.net/npm/vite-plugin-singlefile@2.3.3/README.md |
| vite-plugin-pwa | 1.3.0 (workbox 7.4.1) | The default globs only cover js/css/html. `maximumFileSizeToCacheInBytes` defaults to 2 MiB, so the Rapier bundle is excluded unless that is raised [I]. coi-serviceworker cannot help on file:// and must be a separate, non-CDN file. | https://vite-pwa-org.netlify.app/guide/static-assets.html ; https://cdn.jsdelivr.net/npm/workbox-build@7.4.1/build/schema/GenerateSWOptions.json ; https://raw.githubusercontent.com/gzuidhof/coi-serviceworker/master/README.md |
| Electron | 44.5.1 (Chromium 152, Node 24.21.0) | Requires macOS 13+; no Windows ia32 or Linux armv7l builds. `autoplayPolicy` defaults to `no-user-gesture-required`. `backgroundThrottling` defaults to true. Security: serve from a custom protocol rather than file://. SAB works via `app://` with COOP/COEP headers [E]. | https://releases.electronjs.org/releases.json ; https://raw.githubusercontent.com/electron/electron/44-x-y/docs/breaking-changes.md ; https://raw.githubusercontent.com/electron/electron/main/docs/tutorial/security.md |
| electron-builder | npm `latest` 26.15.3; v26 line up to 26.17.0; v27 alpha | The docs root documents **v27**; v26 uses flat keys (`mac.identity`). Defaults: mac zip+dmg, Windows NSIS, Linux AppImage+Snap. **Set `toolsets.appimage: "1.0.3"`**, because the FUSE2 runtime fails on Ubuntu 24.04+. Unsigned mac builds: `CSC_IDENTITY_AUTO_DISCOVERY=false`. Pass `--publish never`, because v26 auto-publishes on a CI tag. | https://registry.npmjs.org/electron-builder ; https://raw.githubusercontent.com/electron-userland/electron-builder/release/v26/website/docs/appimage.md ; …/release/v26/website/docs/features/code-signing/code-signing-mac.md |
| Signing reality | n/a | Since macOS Sequoia, Control-click no longer bypasses Gatekeeper; users go to Settings → Privacy & Security → "Open Anyway". Windows: unsigned or OV builds hit SmartScreen; Azure Artifact Signing is the cheapest fix but is country-limited. | https://developer.apple.com/news/?id=saqachfa ; https://raw.githubusercontent.com/electron/electron/main/docs/tutorial/code-signing.md |
| Electron Forge | 8.0.1 | No first-party NSIS or AppImage maker, so electron-builder fits our targets better [I] | https://www.electronforge.io/config/makers |
| CI | GitHub runners | `macos-latest` = macOS 26 arm64; `windows-latest` = Server 2025; `ubuntu-latest` = 24.04. Actions: checkout@v7, setup-node@v7, upload-artifact@v7, download-artifact@v8, cache@v5. Headless GPU: `--use-angle=swiftshader --enable-unsafe-swiftshader` (WebGL2) plus `--enable-unsafe-webgpu` (SwiftShader WebGPU adapter) [E]. | https://raw.githubusercontent.com/actions/runner-images/main/README.md ; [E] scratchpad/stack |
| Repo pins | n/a | three ^0.186.1, rapier3d-compat ^0.21.0, electron ^44.5.1, electron-builder ^26.15.3, esbuild ^0.28.2, vite ^8.3.2, vite-plugin-singlefile ^2.3.3, vitest ^5.0.3. Scripts: `build`, `build:single`, `electron`, `dist` (`--publish never`). | R `/home/user/synth/package.json` |

**Stack recommendation [REC]:**
1. Keep WebGLRenderer as the default (stable everywhere, including Linux) with a CPU heightfield shared by mesh, raycast and Rapier collider. Treat WebGPURenderer + TSL as an opt-in "High" path only if the bloom/post stack is rebuilt on `RenderPipeline`.
2. Keep Rapier lazy-loaded from npm, never from a CDN.
3. Single-file build: worklet as a `data:` URL.
4. Electron: electron-builder v26 producing dmg (unsigned at first, with documented "Open Anyway" steps), NSIS (`oneClick: false`) and AppImage (toolset 1.0.3). Serve from a custom `app://` protocol if SAB is ever needed.

---

## 6. Recommended original feature spec (Orograph)

All rows in this section are [REC] unless tagged [R]. Existing values come from `src/core/params.js` and `docs/ARCHITECTURE.md`.

### 6.1 Deliberate differences, to stay original

| Area | Conductive Labs fact | Orograph choice | Status |
|---|---|---|---|
| Name and trade dress | "Terrain Synth" / "WTS"; contour-line faceplate artwork [C/S] | "Orograph"; own icon (contour mountain, orbit, glowing dot) | R `package.json`, `README.md` |
| Terrain names | Egg Crate, Drip Drop, Catmull-Rom, Checkered, Harmonic, Wav Sweep, Warp Check, Spines, Cris-Cross [C] | Swell, Ripple, Bessel, Dunes, Ridge, Massif, Craters, Terraces, Cells, Canyon, Spectra, Lattice, Vortex, Imported. Do not add CL names. | R `src/dsp/catalog.js` |
| Path names and controls | "Rose 3 Petals", "Cardioid x2"; SIZE, W:H, ROTATE, POS X/Y, MANGLE, O SYNC, WIN & MIR, PD TYPE [C] | Ellipse, Lissajous, Rose, Polygon, Star, Spiral, Scan, Spirograph, Figure 8, Epicycloid, Superformula, Scribble, each with generic Order + Shape controls; Size, Stretch, Rotate, Spin, Dot X/Y. New controls get our own names (Laps, Pace, below). | R `src/dsp/catalog.js`, `params.js` |
| Library counts | "17 math terrains", "18 paths" [C] | Never market matching counts | REC |
| Edges | Reflect [C] | Unit torus with seamless tables | R `docs/ARCHITECTURE.md` |
| Anti-aliasing | Per-note FFT brick-wall [C] | Speed-selected mip chain + 2× oversampling + half-band. Optional higher tiers are in §6.3. | R `src/dsp/dsp-core.js` |
| Modulation UI | Val/Lfo/Env/Exp buttons; "Expressive Mapper" with 4 slots per parameter; DAHDSR with 6 modes [C] | Per-control LFO + Env 2 depth (exists) plus one per-part **Links** list (source→destination). No "Mapper"/"Exp" naming. | R `params.js` (MOD_DEFAULT) ; REC |
| Parts | A–D, coloured blue/green/magenta/yellow [C] | Part 1–4, colours #ff7a45 / #3fd0c9 / #b98cff / #ffd23f | R `params.js` |
| Display colours | Green path + dot, yellow filled waveform, magenta partials, 24 palettes, 6 POV slots [C] | Theme tokens (dark/light), our own palettes. Avoid the green / yellow / magenta trio for path / waveform / spectrum. Use 4 camera bookmarks plus a free camera. | R `docs/ARCHITECTURE.md` (theme contract) ; REC |
| The dot | A slowed visualisation ball travelling the path; position comes from knobs or a mapped mouse [C] | The dot *is* the orbit centre and the main control: click to place, drag, flick. Pin / Roll (marble physics) / Drift modes. A separate comet-trail playhead shows traversal. | R `docs/ARCHITECTURE.md` ; REC |
| Input | Knobs only; the screen is output only [C] | Mouse, touch and keyboard first; MIDI optional | R `docs/ARCHITECTURE.md` (quality bar) |
| Image terrains | "4-in-1" continuous R→G→B→L morph [C] | Single-channel import with mirror tiling. At import: choose a channel, blur, and normalise. Use the A/B morph between two images instead of a channel morph. | R (`UserTerrain`) ; REC |
| Effects | 4 slots per part, 9 named topologies, 22 FX [C] | Per-part sends to a global ping-pong delay and convolution reverb; master chorus, warmth and limiter | R `docs/ARCHITECTURE.md` |
| Arp / sequencer | "Scale Repeats", 36 scales, 23 rhythms, 12 audition presets [C] | 16-step sequencer per part with slide and accent; 11 scales; our own Preview phrases and generative modes (§6.6) | R `params.js` (SEQ_STEPS, SCALES) |
| Help and docs | 323-entry Help+; User Guide article titles [C] | Write our own hints. Do not reuse CL wording or chapter titles. | REC |

### 6.2 Engine architecture and quality modes

- **Keep:**
  - per-sample path → transform → warp → trilinear mip lookup → A/B morph → Lift/Fold → DC block → drive → state-variable filter → amp envelope at 2×;
  - a 63-tap half-band decimator;
  - control blocks of 32 samples with one-pole smoothing [R] (`src/dsp/dsp-core.js`).
- **Add a global "Quality" setting** [REC]:

  | Mode | Oversampling | Mip bias | Notes |
  |---|---|---|---|
  | Eco | 1× | +1 octave | Low-power laptops |
  | Standard (default) | 2× | current | Current behaviour |
  | High | 4× | current | Second half-band stage |
  | Raw | 2× | −1 (mip off for detail) | Deliberate aliasing / lo-fi, as James suggests |
  | Render | 8× | current | Offline only, for WAV export |

- **Optional "Pristine" per-voice mode (§3.7 strategy A)** for slow-moving patches, gated behind a CPU benchmark. Use it only when the orbit is not audio-rate modulated [REC, I].
- **CPU target:** "16 simultaneous voices with unison 2 must run in under 35% of one core" [R] (`docs/ARCHITECTURE.md`). Benchmark the High and Pristine modes against it.

### 6.3 Parameter list (per part unless noted)

**Terrain**

| Param | Range | Default | Notes | Status |
|---|---|---|---|---|
| Terrain A / B | enum (14) | Swell / Massif | | R |
| Morph | 0–1 | 0 | A→B blend | R |
| Warp | 0–1 | 0 | Coordinate ripple of the land | R |
| Lift | 0.25–4× (exp) | 1 | Height / drive into the fold | R |
| Fold | 0–1 | 0 | Wavefold of peaks | R |
| Seed | 0–99 | 7 | Procedural variation | R |
| Detail | 0–1 | 0.5 | Fine-detail amount (raises spatial bandwidth; caps the octave count) | R |
| Import: Channel | Luma / R / G / B | Luma | Chosen at import, not morphable | REC (new) |
| Import: Smooth | 0–1 | 0.3 | Gaussian pre-blur (§3.4 recipe) | REC (new) |
| Import: Tile | Mirror / Wrap | Mirror | | R (`mirror` flag) ; REC to expose |

**Orbit ("path")**

| Param | Range | Default | Notes | Status |
|---|---|---|---|---|
| Path | enum (12) | Ellipse | | R |
| Order | 1–8 | 2 | Petals / sides / ratio | R |
| Shape | 0–1 | 0.5 | Per-path continuous control | R |
| Size | 0–0.5 (pow 1.6) | 0.22 | Brightness control | R |
| Stretch | −1–1 | 0 | Aspect, 2^(±1.5) | R |
| Rotate | 0–360° (wraps) | 0 | | R |
| Spin | −4..+4 Hz (bipow) | 0 | Continuous rotation | R |
| Dot X / Dot Y | 0–1 (wraps) | 0.5 / 0.5 | The dot | R |
| **Laps** | 1.00–8.00 | 1.00 | Hard-sync laps per period (§3.5). Fractional values give sync timbres. | REC (new) |
| **Pace** | −1..+1 | 0 | Traversal-speed warp (phase distortion). Amount of `t + p·sin t` style skew; 0 = even. | REC (new) |
| Pace shape | Bend / Skew / Pinch | Bend | Three PD curves of our own design | REC (new) |
| Traverse | Even (arc length) / Angle | Even | Angle mode adds natural PD on eccentric shapes | REC (new; check `src/dsp/paths.js` `pathLength`) |
| Direction | Forward / Ping-pong | Forward | Ping-pong closes open paths without a seam | REC (new) |
| Note→Size | −1..+1 | 0 | Keytrack of Size (Plaits-style brightness limit when negative) | REC (new) |

**Voice**

| Param | Range | Default | Status |
|---|---|---|---|
| Octave | −3..3 | 0 | R |
| Tune | ±12 st | 0 | R |
| Fine | ±100 ct | 0 | R |
| Glide | 0–2 s | 0 | R |
| Mode | Poly / Mono / Legato | Poly | R |
| Unison | 1–4 | 1 | R. Keep the max at 4 for CPU; CL offers 7. |
| Detune | 0–50 ct | 12 | R |
| Width | 0–1 | 0.6 | R |
| Velocity | 0–1 | 0.6 | R |
| Bend | 0–24 st | 2 | R |
| **Sub** | 0–1 | 0 | REC (new). One sine an octave down. A single sub, not CL's two. |
| **Air** | 0–1, plus tilt −1..1 (dark↔bright noise) | 0 / 0 | REC (new). Continuous noise colour rather than named colours. |

**Filter, envelopes and mix (all exist [R])**
- Filter: Off / Low / Band / High / Notch (default Low); Cutoff 30–18000 Hz exp (default 9000); Reso 0–1 (0.15); Env Amt ±1 (0.15, up to ±6 octaves); Key Trk 0–1 (0.5); Drive 0–1 (0).
- Amp envelope: A 0.001–8 s (0.005), D 0.001–8 s (0.35), S 0–1 (0.75), R 0.001–10 s (0.45).
- Env 2: A 0.01, D 0.6, S 0.25, R 0.5 (same ranges).
- Mix: Level 0.75; Pan ±1; Delay send 0.12; Reverb send 0.22; Mute; Solo.
- Possible additions [REC]: a Comb filter type, and a Vowel type with our own formant table. Generic DSP, own implementation.

**Modulation**

| Item | Range | Default | Status |
|---|---|---|---|
| Per control: LFO shape | Sine / Triangle / Saw / Square / S&H / Drift | Sine | R |
| LFO rate | 0.01–30 Hz, or synced 4 bar..1/32 | 0.5 Hz / 1/4 | R |
| LFO depth | ±1 | 0 | R |
| Env 2 depth | ±1 | 0 | R |
| Retrig | on / off | off | R |
| Add shape **Steps** | 16-step drawn LFO, matching the sequencer length (CL uses 32) | n/a | REC (new) |
| **Links** (per part) | Up to 8 rows. Source ∈ {velocity, mod wheel, aftertouch/pressure, key, MPE slide, Macro 1–4, marble speed, marble height, Env 1}. Destination = any modulatable control. Amount ±1. Curve: lin / soft / hard. | empty | REC (new). Replaces the hard-wired wheel→morph [R] with a visible default row. |
| Macros (global) | 4 knobs, each driving up to 8 targets | 0 | REC (new) |

**Dot / marble** (part state `dot: {mode, gravity, friction, driftSpeed}` [R])

| Param | Range | Default | Status |
|---|---|---|---|
| Mode | Pin / Roll / Drift | Pin | R |
| Gravity | 0–2 g | 1 | REC ranges for existing fields |
| Friction | 0–1 | 0.3 | REC |
| Drift speed | 0.01–2 Hz | 0.15 | REC |
| Bounce | 0–0.9 | 0.2 | REC (new) |
| Tilt | ±1, with a mod source tilting world gravity | 0 | REC (new) |
| Flick strength | 0–2 | 1 | REC (new) |

**Global (all exist [R])**
- Volume 0.8; Tempo 40–240 (112); Swing 0–0.6 (0); Key A; Scale Minor (11 scales).
- Delay: division 1/8. (dotted eighth); Feedback 0–0.95 (0.42); Tone 0.55; Return 0.7.
- Reverb: Size 0.62; Damp 0.45; Return 0.75.
- Chorus 0.15; Warmth 0.15; Keys mode Selected / Layer.
- Add [REC]: Quality (§6.2); Pristine on/off; Output limiter ceiling (−0.3 dBFS default).

### 6.4 "Place the dot" interaction

1. **Click or tap the terrain** to raycast and set Dot X/Y, with a spring animation of about 120 ms [R behaviour; REC timing]. Raycast against the CPU heightfield mesh, because GPU displacement is invisible to Raycaster (§5). Use three-mesh-bvh if the mesh is denser than about 256² [REC].
2. **Drag the dot** to move it continuously (writes are smoothed by the audio engine).
   - Shift-drag: Size.
   - Alt-drag: Rotate.
   - Wheel over the dot: Size.
   - Wheel elsewhere: camera zoom.
   - Drag empty space: orbit the camera, using OrbitControls with damping and `maxPolarAngle ≈ π/2` [REC] (§5).
3. **Flick** in Roll mode throws the Rapier marble (sphere on a heightfield collider built from the same Float32Array; note it is column-major) [R/REC].
4. **Keyboard:** arrow keys nudge the dot by 1/64 (Shift for 1/8); `[` and `]` change Size [REC] (naogit prior art §4.1).
5. **Mirror view:** the top-down minimap lets you place the dot precisely even when the 3D view is occluded [REC] (riccardomonaco prior art).
6. **MPE:** slide moves the dot Y and pressure scales Size, relative to where the note started (Zabetian mapping) [REC] (§3.11).

### 6.5 Visuals

- **Render modes:** Shaded relief (default), Wireframe, Contour (top-down), Heat (top-down), Points [REC].
- **Height colouring** from our own palettes (about 6), each defined for dark and light themes [REC].
- **Overlays:**
  - base orbit (thin);
  - modulated orbit (bright);
  - per-voice orbits in part colour, a cue taken from Image-In [S];
  - a comet-trail playhead whose trail density shows Pace/PD. Use a constant visual lap of about 1.5 s rather than CL's note-scaled ball [REC].
- **Readouts:** waveform scope and harmonic bars in our own colours; modulation-range ghost arcs on knobs; an XY "orbit scope" (raw x/y of the orbit) [REC].
- **Post:** bloom on the dot and trail only (selective emissive), with a reduced-motion setting [REC]. On WebGL use UnrealBloomPass or pmndrs (but note its peer cap is <0.187); on WebGPU use `bloom()` via `RenderPipeline` (§5).
- **Performance:** the target is 60 fps on integrated GPUs at medium quality [R] (`docs/ARCHITECTURE.md`).

### 6.6 Sound and music features

- **Exists [R]:**
  - 16-step sequencer per part with degree, octave, velocity, gate, slide and accent;
  - arp (mode, rate, octaves, gate, hold);
  - patches, scenes, and JSON import/export;
  - 24-bit WAV recording;
  - MIDI learn;
  - omni or multi-channel MIDI.

  Source: `docs/ARCHITECTURE.md`.
- **Add [REC]:**
  - **Dot locks:** each sequencer step can store Dot X/Y and Size; the dot glides between steps. This answers the users' "terrains drive sequences" wish (§2) in our own form. It is distinct from CL's 5-point part-volume vector [C].
  - **Waypoints:** draw a polyline of up to 8 dot positions with per-segment times; loop, ping-pong or one-shot.
  - **Explore:** generative mode where the marble roams under slowly rotating gravity, quantised to scale on terrain extrema (users' "generative / NDLR-like" wish).
  - **Preview:** a key that plays a short, tempo-synced phrase on the selected part.
  - **Stems export:** record each part to a separate WAV, answering the multi-out wish (§2).
  - **Real-world terrain:** import user-supplied DEM/heightmap PNGs. Do not fetch from Google Maps (licensing not researched; see §7).

### 6.7 Distribution

- Electron (§5):
  - macOS dmg + zip (arm64 + x64), unsigned at first;
  - Windows NSIS with `oneClick: false`;
  - Linux AppImage with `toolsets.appimage: "1.0.3"`.
- Single offline HTML via `build:single` [R]. Optional PWA with a raised precache limit.
- CI: three-OS matrix, `--publish never`, artifacts uploaded; SwiftShader flags for headless visual smoke tests [REC] (§5).

---

## 7. Open questions and unknowns

1. **The user's "browser demo".** Is it a real conductivelabs.com feature or a memory of the hardware UI? The page could not be read [U]. Worth asking the user for a screenshot or a description of what they saw.
2. **CL details** that are only in the blocked Manual and User Guide PDFs: full names of the 17 terrains and 18 paths; exact ranges (SIZE span, ROTATE span, envelope maxima, LFO shape list); mirror/window semantics; PD algorithms; sequencer step count. None of these are needed for clean-room work. Do not try to obtain them by bypassing protections.
3. **CL band-limiting specifics.** Does the FFT update per block or per cycle? How does it handle audio-rate path modulation? What DC handling and image pre-filtering does it use? [U]
4. **Is 48 kHz fixed** on CL hardware? It is confirmed only from the talk [C]. For us: support whatever rate the AudioContext runs at (44.1/48/96 kHz) and validate the DC-blocker R and mip bias per rate [REC].
5. **Orograph-specific checks:**
   - Does `src/dsp/paths.js` already use arc-length traversal for all shapes?
   - Is rose closure handled for odd orders (risk of an octave error, §3.5)?
   - Does the superformula path close for odd symmetry?
6. **CPU feasibility** of the High (4×) and Pristine (per-cycle FFT) modes inside the 35%-of-a-core budget. A benchmark is needed; consider WASM [I].
7. **Renderer.** Is WebGPURenderer worth it given Linux WebGPU limits and the r186 "experimental" status? Default WebGL until the post stack is ported [REC]. pmndrs postprocessing pins three <0.187, so watch for r187.
8. **Firefox headless AudioContext** stayed suspended even after a click. Probably no audio device on the test machine; unconfirmed [E/U].
9. **Signing costs and availability:** Apple Developer ID and notarisation; Azure Artifact Signing country eligibility. Without signing, plan for Gatekeeper and SmartScreen friction [S].
10. **Legal (not researched):** trademark status of "Terrain Synth" and "WTS"; any CL patents; licensing of real-world elevation data for a "map of your hike" feature. Get counsel review before release.
11. **AppImage toolset "1.0.3"** is labelled beta in the v26 docs. Re-test on Ubuntu 24.04+ and Fedora in CI [S].
12. **Unverified community claims** (ModWiggler, Gearspace summaries; Kickstarter-only figures such as "552 LFOs") should not appear in marketing or docs [U].