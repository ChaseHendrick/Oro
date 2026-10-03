# Changelog

All notable changes to Oro (called Orograph until 2.3) are listed here. The [user guide](docs/USER-GUIDE.md)
explains every feature in detail.

## 2.10.0 (October 2026)

* **Resonator: hear the shape of the land.** The track's terrain also becomes a vibrating
  drumhead. **Strike** plays each note by striking it where the dot is; **Resonate** lets the
  voice drive it. Peaks and craters change how it rings. The lowest mode follows the note;
  very high notes ring an octave or more lower (the guide explains the limits and CPU cost).
* **Imprint.** Turn a recording into a landscape: one cycle of it is written along the
  dot's orbit, so on the path you hear the sound itself, and the land around it blends into
  the old terrain. **Time** mode lays successive cycles on rings, so a bigger orbit plays
  later in the recording.
* **Real places.** Play real terrain: 10 places on Earth (including the Grand Canyon,
  Everest and the Mariana Trench), 4 on the Moon (Tycho, Copernicus, Montes Apenninus,
  Shackleton) and 4 on Mars (Olympus Mons, Valles Marineris, Hellas, Gale), from AWS Terrain
  Tiles and NASA and USGS elevation data. They load only when you choose one.
* **Night sky.** A terrain made from 2,887 real stars (Yale Bright Star Catalogue), brighter
  stars as higher peaks, with Orion, Ursa Major, Cassiopeia, Scorpius and the Southern Cross.
* **Live weather.** Pick a city and its wind, rain, temperature and cloud become four new
  Links sources (weather data by Open-Meteo.com). Off until you turn it on.
* **Sonify your data.** Paste numbers or a CSV and turn them into a terrain or a melody.

## 2.9.0 (October 2026)

**Sequencing**
* **Song mode.** Chain a track's patterns (A A B C...) with repeats, and the track plays
  the whole arrangement.
* **Parameter locks.** Any step can set its own value for any sound control, in a new
  Lock row of the step grid.
* **Capture.** Oro keeps listening while you play; press Capture to turn what you just
  played into the pattern, even if you weren't recording.
* **MIDI files.** Export a pattern or the whole session as a .mid (with arpeggiators and
  the chord trigger), or import one; chords can keep the highest or lowest note or split
  across tracks, and accents survive the round trip.
* **Microtuning.** Built-in tunings (just intonation, Pythagorean, meantone, Werckmeister
  III, 19, 24 and 31 equal) and Scala .scl and .kbm files, with a reference pitch. Pitch
  bend and Tune move through the tuning's own notes.
* **Ghost replay.** Record a performance on a track (notes, knob moves and the dot's path)
  and play it back as a ghost while you play something else.

**Sharing**
* **Postcards.** A 1080 by 1080 picture of your terrain with the sound hidden inside the
  file, plus a link that loads the sound in Oro on the web. Share to X, Facebook, Bluesky,
  Threads, Reddit and LinkedIn, or through your phone's share sheet.

**The Operator panel** (Settings > Operator), all off until you turn it on
* **Drop damage and water damage:** crackle, cutouts, a knocked-out-of-tune oscillator,
  a muffled and fizzing sound, mains hum and short-outs. Water dries out unless it stays
  wet; Repair fixes both. On phones a hard jolt can count as a drop.
* **Quirks:** Glitch, Slowdown and a Kill screen. **Vintage:** a 12-bit early-sampler sound.
  **Free Play:** turn it off and Oro wants a coin (press C).
* **Service:** test tones and a MIDI monitor. **Bookkeeping:** play stats, badges, and how
  many secrets you have found.

**Play**
* **Golf:** 9 or 18 holes, or the driving range, rolling the marble across the terrain.
* **Seed from a word:** any word always gives the same terrain and sound.
* **Day and night** colours that follow your local time, and **a pet** that lives on the map.
* There are secrets. Bookkeeping keeps count.

**Fixes**
* The Dot glide and Humanize sliders now change playback. They saved their values where
  the sequencer never read them (Dot glide since 1.1.0, Humanize since 2.6.0).
* Keys and MIDI play a frozen track live on top of its loop.
* Smart controls can reach envelope times and every other sound setting.
* Undo can step back through a looper stretch, and the older overdubs after it.
* Scenes keep your current tuning and Operator switches unless they were saved with them.

## 2.8.0 (October 2026)

* **Sound map** for drum kits: 128 drum sounds made by Oro, plus your sliced samples, laid
  out so similar sounds sit together. Hover or use the arrow keys to hear them, click to
  put one on a pad. **Similar** finds a close alternative and **Shuffle kit** picks eight
  that belong together.
* **Euclid fills and the groove pad.** Euclid spreads a number of hits evenly along a
  lane. The groove pad writes a whole beat from complexity and loudness, in four styles,
  with an optional fill at the end.
* **Smart controls.** Eight knobs at the top of the Sound tab for each track. Each knob
  moves up to four settings at once, each over its own range (reversed ranges work), with
  a choice of curve. Add settings with **Learn** or from a list. Saved with the track,
  scenes and patches, undoable, and MIDI-learnable.
* **Time stretch** that keeps pitch: the looper's **Follow tempo** and **Fit to tempo**
  keep a loop in time when the tempo changes, and noise recordings get **Stretch...**.
* **Send effects.** Two shared effects every track can send to: **Send A**, a reverb with
  size, decay time, damping and pre-delay, and **Send B**, a delay that can follow the
  tempo, with feedback, tone and ping-pong. They sit alongside each track's existing
  Delay and Reverb sends, which are unchanged.
* **Freeze.** The snowflake on a track renders its pattern to audio and plays that
  instead, which uses far less processing. Editing the sound unfreezes it.
* **Chord trigger.** One key plays a whole chord: learn your own or pick a preset, and
  optionally keep it in the song's key.

## 2.7.0 (October 2026)

* **Drum kit mode.** Any track can become an eight-pad drum kit with eight sequencer
  lanes. It starts with a synthesized kit, and each pad has pitch, decay, level, pan and
  a choke group.
* **Import & slice** and **Record 4 s & slice** cut a recording at its hits into up to
  eight pads, so a phone recording of tapping on a desk becomes a kit.
* The Humanize controls in the Seq tab no longer overlap.

## 2.6.0 (October 2026)

* **Undo and redo** with a history list (top bar, Cmd/Ctrl+Z, Shift+Cmd+Z or Ctrl+Y). Drags
  count as one step; up to 60 steps.
* **Humanize** for each pattern: notes up to 20 ms late and velocity up to ±30%, different
  every pass.

## 2.5.0 (October 2026)

* **Probability and ratchets.** Each sequencer step has a chance to play (0 to 100%) and
  can play 1 to 4 times within its length, each repeat a little softer. Existing patterns
  are unchanged.
* **Three new track effects:** a **Frequency shifter** (single-sideband, up, down or both
  sides, with feedback), **Hyper dimension** (six detuned voices spread wide, plus short
  reflections) and a **Filter sequencer** (eight patterns stepping the cutoff in
  sixteenths, synced to the tempo). The rack now has 30 effects.

## 2.4.0 (October 2026)

* **Via for Links.** Each link can be scaled by a second source (for example Mod Wheel →
  Cutoff via Velocity).
* **Function.** Draw a curve of up to 16 points per track and use it as a looping LFO or a
  one-shot envelope from each note (per voice), free or tempo-synced, with Smooth S curves.
* **Turing.** A new global source: a looping random sequence with Chance, Length and Step.

## 2.3.0 (October 2026)

* **Orograph is now Oro.** The app, window, installers (Oro-mac-arm64.dmg and so on), offline
  file, recordings (oro-YYYYMMDD-HHMMSS.wav) and documentation use the new name. Nothing is
  lost: the desktop app keeps using the same data folder, so your sessions, settings and
  window layout carry over, and updates keep arriving through the same channel. The web
  app moves to hendrickresearch.com/music/oro/ (the old address forwards there).

* **Warp modes.** PWM, Quantize, Flip and Spiral change how the point travels the path
  each cycle, with a modulatable Warp amt (Laps and Pace already cover sync and bend).
* **Formula terrains.** Type z = f(x, y) to build terrain A or B, with r, th, noise() and
  about thirty maths functions; fill A and B at t = 0 and t = 1 so Morph animates the
  formula. A safe parser: formulas can only do maths.

## 2.2.0 (October 2026)

* **Filter 2.** A second filter per voice with Serial, Parallel and Split (left/right)
  routing and its own Cutoff, Reso, Env Amt, Key Trk and Mix. Types: Low 12, Low 24,
  Band, High 12, High 24, Notch, Peak, Phaser, Comb +, Comb − and Low-pass gate (cutoff
  and level follow the amp envelope).
* **Bigger unison.** Up to 16 copies, with **Blend** (centre against the detuned copies),
  **Spread** modes (Linear, Super, Exp, Random per note), **Stack** (octaves and fifths)
  and **Map spread**, which lets each copy read the land at its own spot around the dot.
* With every new control at its default, patches sound exactly as before.

## 2.1.0 (October 2026)

* **Science sources.** Nine new Link sources driven by real dynamical systems from the
  author's research, set up in a new **Science sources** card (Mod > Links + Macros):
  **Neuron** and **Neuron Spike** (the Hodgkin-Huxley equations at the 1952 constants, which
  rest, or fire once a note kicks them, or fire on their own, depending on Current),
  **Lorenz**, **Pendulum 1** and **2** (a double pendulum held at a set energy),
  **Smooth Random** (Matérn-type random wandering, Rough to Silky), **Collapse** and the
  per-voice **Swirl X** and **Swirl Y** (point vortices spiralling to a collapse in time
  with the tempo, one vortex per voice). They also work as sources for each parameter's own
  controller slots. Each model is checked against its paper's numbers in the tests.
* **Pendulum dot mode.** The dot rides the tip of a double pendulum hung where you put it:
  gentle at low Energy, chaotic above it. Settings: Energy, Reach and Speed.
* **Remembers where you were.** The selected track and the camera now come back when you
  reopen Orograph, along with everything it already kept (every track's sound, patterns
  and dot, and your settings).

## 2.0.2 (October 2026)

* **The map has no edge.** The land repeats in every direction, and now it looks and plays
  that way: no walls, no seam lines between the copies, no frame around the play area. Drag,
  glide, roll or tour the dot as far as you like; when it heads towards the edge of the view
  the camera follows it (never while you are dragging it). The displayed land (11 x 11 copies,
  detailed in the middle and coarser towards the distance) stays centred under the camera, so
  even fully zoomed out the land reaches the edges of the view and melts into the fog. The
  minimap moves the dot within the copy you are looking at.
* **Optional frame-rate cap** (Settings > General > Frame rate): Uncapped (the default), 30,
  60 or 120. It saves battery and heat on laptops; the dot, glides and physics still move by
  the real time that passed, and the sound is unaffected.
* **A calmer map for photosensitive players.** Fast modulation (a per-note envelope on Morph,
  Warp or Lift, as in the first scene's bass) used to bounce the whole map several times a
  second, and the glow pulsed the whole screen with every note. The map's shape now eases
  into changes (0.2 s, 0.45 s with Reduced motion) and the glow follows the level slowly and
  over a smaller range, keeping large-area changes under three a second (WCAG 2.3.1). This is
  only what you see: the sound, and the way a rolling dot moves, are unchanged. Reduced
  motion set to Off in Settings now also overrides the system setting on the map.

## 2.0.1 (October 2026)

* Smaller desktop apps. Electron ships Chromium's interface text in about 55 languages
  (220 language folders on the Mac); Orograph's interface is English, so only the English
  files are bundled now. On Apple silicon the app is about 50 MB smaller on disk and the
  download about 13 MB smaller; Windows and Linux save about 9 MB on disk. A computer set
  to another language still works (Chromium falls back to English).

## 2.0.0 (October 2026): Expanded synthesis and performance

* Eight unison copies, two seven-wave subs, coloured noise and imported recording loops,
  eleven morphable partial profiles, phase and ring modulation, and a Karplus-Strong pluck.
* Three ladder colours, SEM and diode-inspired digital filter types. These are original
  algorithms, not measured replicas of named hardware circuits.
* Nineteen mathematical terrains, twenty paths, a browsable offline library of 320
  original generated images, 512 by 512 tables, complete audio-file terrains, live image
  channel morphing and Cartesian/polar mapping. Window, Mangle and mirroring shape paths.
* Forty modulation targets, independent six-stage envelopes and four controller slots
  on each target. LFO skew, phase, offset, delay, fade-in, up to 32 loops and a 32-step
  sequencer with glide and smoothing. Expression, sustain and breath MIDI sources.
* Four effect slots per track, 27 effects and ten routing layouts. Includes shimmer,
  granular pitch shift, flanger, phaser, overdrive, decimator, four-band EQ, sidechain
  ducking and three-band upward/downward compression.
* Vector mixing, 40 scales, 28 arp trigger rhythms, 36 ordered MIDI patch favourites,
  author/folder metadata, 24 palettes, six camera angles, six render styles and named
  saved views. Larger imported sessions and libraries use IndexedDB storage.
* Desktop update checks, optional background downloads for Windows installer/Linux
  AppImage builds, and an explicit saved-session restart/install action. Mac, portable
  Windows and Linux archive builds offer release notices and manual downloads.
* Existing parameter and catalog IDs retain their meanings. Older 16-step LFO patterns
  are expanded by repeating each cell twice, preserving their original timing.
* Browser minimap sampling reuses warped source grids and a bounded-error colour lookup.
  The measured moving-terrain scene used about 60% less render-loop JavaScript time
  at the same resolution and approximately 60 fps, with no frame cap or audio change.
* New oscillator and effects paths have focused spectral, tuning, stability, lifecycle
  and performance tests. Maximum 16-track/four-effect loads depend on the computer;
  dense patches benefit from lower quality or fewer simultaneous voices.

## 1.5.1 (October 2026): Pedal profile explanation

* Settings > Pedals explains why these MIDI pedal profiles are included:
  **Why these pedals?** These are the ones I have. The user guide and pedal notes
  include the same explanation.

## 1.5.0 (October 2026): Experimental guitar chords

* **Settings > Pedals > Guitar > Tracking** offers **Single** and **Chords**. Single
  remains the default. Chords detects several pitches from one clean guitar input
  and sends individual notes through the same router, arpeggiator and MIDI output.
* Audio is sampled by an AudioWorklet or ScriptProcessor fallback. Chord analysis
  runs in a separate Worker to keep its heavier calculations off the audio thread. Mode changes, retargeting, closing the return and quiet
  input release the previous notes. Capture still records one held note.
* The pane lists heard chord notes. Bends remain available in Single mode, with the
  preference retained when switching to Chords. Tracking mode is saved per computer.
* Chords is experimental and responds more slowly than Single. Quiet strings and
  octave-doubled strings can be missed; distortion makes detection harder. Validated
  with generated signals, not real guitar or pedal hardware.
* Panic clears the guitar and voice drivers' held notes, so a late input note-off
  cannot stop a newer keyboard note. A Panic on one Layer track preserves source
  routes on the other tracks.

## 1.4.0 (October 2026): Voice input

### Voice

* **Settings > Voice** brings in a microphone, a plain laptop microphone included: pick the
  input, switch **Voice** on, set the **Input gain** with a meter and a **Clip** light (it
  tells a clipping microphone from too much gain), choose **Mono** or **Stereo**.
* **Clean by default.** The browser's echo cancellation, noise suppression and auto gain are
  off, Orograph asks for its own audio rate (48 kHz on most computers) and 24-bit, so the
  browser does not resample, and the audio context keeps its interactive latency.
  **Mic Cleanup** turns noise suppression and echo cancellation on for singing into a laptop
  with its speakers playing.
* **Monitor** (Auto, On, Off). Auto hears the voice only with headphones or an audio
  interface, and stays off for a laptop's built-in microphone with its built-in speakers,
  with a "use headphones to avoid feedback" hint. A feedback guard, tuned for voices, is
  armed whenever the microphone is open and mutes a howl, a runaway or clipping.
* **Optional processing**, all off by default: a high-pass at 80 Hz, a gentle compressor and
  a split-band de-esser. A voice strip sets level, pan and the delay and reverb sends.
* **Looping vocals.** The voice joins the master like a part, so the looper records and
  overdubs it and Resample turns vocal loops into terrains. With Monitor off the voice is
  not heard but still reaches the looper. The voice never reaches the pedal send and is
  never routed back into itself.
* **Voice plays notes.** The guitar's pitch tracker follows singing or humming and plays a
  chosen part (note source `voice`), with a gate and slides and vibrato as pitch bend.
* **Capture** a sung note into a wavetable terrain on the voice's part (named, for example,
  Voice A3).
* **Voice Level** is a new Links source (0 to 1, the envelope of the voice), so singing can
  move the terrain. It is appended after Guitar Level, so saved links keep their meaning and
  the session format is unchanged.
* **Permissions.** Settings > Voice says why the microphone is needed before the browser
  asks, and explains what to do when access is refused, no microphone is found or another
  app holds it, with **Try again**. The desktop app's macOS microphone description now
  mentions vocals.
* Voice settings belong to the computer (stored with the browser, like the pedal rig) and
  are never saved in sessions, scenes or patches. The microphone reopens at start only when
  permission was already given.
* The feedback guard on the voice tells a howl from singing by pitch as well as steadiness: a
  howl holds one exact pitch, a sung note wobbles. A note starting out of silence no longer
  counts as a runaway level. A very loud note held almost perfectly straight for over half a
  second can still trip it; press **Unmute**.
* Voice input has been tested with simulated signals, not yet with real microphones.

### Fixes

* **Guitar plays notes** on Track 5 to 16 now plays that track; it fell back to the selected
  track in 1.3.0.

## 1.3.0 (October 2026): Tracks

* New: an open track list. Sessions start with four tracks as before; add up to 16 with the
  **+** button next to the track tabs (or the **Add track** tile at the end of the mixer).
  The track menu (the **...** button, or right-click a tab or a mixer strip) renames,
  duplicates, moves and removes tracks, and a removed track comes back with **Undo** in the
  notice. Drag a tab to reorder it, or press **Alt+Left** / **Alt+Right** on a tab; **F2**
  renames. A session always keeps at least one track.
* Tracks scroll sideways in the top bar when they do not fit (a compact strip with 44 px
  targets on phones), and the mixer strips scroll too. Keys **1** to **9** select tracks 1
  to 9.
* Each track can hold several patterns (up to 16). The new picker in the Seq tab's Pattern
  block adds a pattern (a copy of the current one), chooses which one plays and removes one.
  Patterns and tracks have stable ids, ready for an arrangement timeline.
* Removing a track releases its notes and fades it out over 80 ms; reordering never
  interrupts a sound; tracks you are not using cost no audio processing. Loading a scene
  replaces the track list with a short crossfade.
* MIDI: per-track channels for all 16 tracks (track N listens and sends on channel N by
  default). Settings saved with four parts keep their channels. Notes held on an external
  synth are released when tracks move.
* Bounce: one stem per track that plays, named after the track (for example
  `-track3-bass.wav`).
* Sessions and scenes saved by earlier versions load as four tracks, each part's pattern
  becoming its pattern 1. The saved format is now version 4.

## 1.2.2 (October 2026)

* A bigger map to play on. The whole 3 x 3 field of terrain copies is now playable: drag the
  dot across a tile edge and it carries on into the neighbouring copy (the land repeats, so
  the sound is the same as wrapping), up to a wall at the outer edge. It no longer jumps to
  the opposite side. Clicking glides straight to the spot you clicked, and the arrow keys
  stop at the outer edge too. The neighbouring copies are only lightly dimmed now, with
  faint seams where the land repeats and a frame around the outer edge.
* A rolling marble or a modulated dot that crosses a seam also moves on to the next copy
  instead of jumping back across the tile.

## 1.2.1 (October 2026)

* Smoother visuals. The minimap (top right of the map) rebuilds its terrain image on every
  frame while the land moves, instead of about 6 times a second, and draws the orbit and dot
  on every frame instead of every other one; the terrain image is about 3 times cheaper to
  build. The One cycle and Harmonics displays now ease towards each engine update every
  frame instead of stepping, with meter-style bars (fast up, slower down).

## 1.2.0 (October 2026): Looper and resampling

### Looper

* A **looper** on the master output, in the new **Loop** tab and as a loop button in the top
  bar. One button cycles **Record**, **Play** and **Overdub**; **Stop**, **Undo**, **Clear**,
  **Mute**, a loop **Volume** and an overdub **Feedback** (0 to 100%, how much of the loop
  each overdub pass keeps) sit next to it. A ring around the button shows where the loop is.
* **Locked to the tempo.** With the transport playing, recording starts on the next bar line
  and closes by itself after 1, 2, 4 or 8 bars (2 by default), exact to the sample. A press
  just after a bar line still starts on that bar. With the transport stopped, recording
  starts at once and a second press closes the loop at any length.
* **Follows the transport.** Stop stops the loop; Play restarts it on bar 1. Following
  external MIDI clock works the same way.
* **Overdub** sums new playing onto the loop on every pass. **Undo** steps back one overdub
  layer at a time (up to 8 layers, within a memory limit).
* **Clean sound.** Loops are stored as 32-bit float at the audio rate, never resampled.
  The loop seam, punching in and out of overdub, starting, stopping, undo and every level
  change are faded over a few milliseconds, so nothing clicks. Stacked overdubs pass a
  gentle soft limit instead of clipping, and Feedback never goes above 100%.
* **No feedback loops.** The looper listens to the master after the effects and before the
  limiter, and plays back into the limiter, so the loop is never recorded into itself
  except by overdub. Record (R) captures the loop together with everything else.
* **Export WAV** saves the loop as 24-bit with TPDF dither, or as 32-bit float, at the
  audio rate. Bounces and stems are unchanged and do not include the loop.

### Resample

* **Resample** turns the loop, or, when the looper is empty, the chosen number of bars of
  the output, into a wavetable terrain in slot A or B of the selected part, named
  Resample 1, Resample 2 and so on. Play the new terrain, loop it and resample again.
* It uses the same high-precision path as guitar Capture (16-bit tables): with a steady
  pitch it cuts one cycle per frame at that pitch. Material without one (drums, chords, a
  whole mix) is cut at a fixed period from the tempo or from a root note you choose, and
  the message says which. Every frame is band-limited, DC-free and levelled.

### Controls

* Keyboard: **Q** record / play / overdub, **Shift+Q** stop or restart the loop, **B** undo,
  **Shift+B** clear, **M** mute.
* **MIDI Learn** on the looper buttons and Resample: right-click (or long-press) a button and
  press a button on your controller.

## 1.1.2 (October 2026)

* Fixed: grabbing the dot made it jump when its position was modulated (by an LFO, Env 2 or
  a Link, as in the Basalt Bass patch) or still easing. The dot is now picked up exactly
  where it is drawn, follows the cursor, and eases instead of jumping whenever what moves it
  changes (grab, release, a glide starting).
* Orograph on hendrickresearch.com has a back arrow to the Music page.

## 1.1.1 (October 2026)

* Fixed: on Macs in Chrome, a gray rectangle could cover the 3D map while dragging the dot or
  zooming at Visual quality High or Medium. Bright glows could overflow the high-range image
  the glow effect works on; invalid pixels are now cleaned up before the glow, and Apple
  graphics chips skip the multisampling step that showed the same symptom (Retina screens
  already render at 2x).

## 1.1.0 (October 2026): guitar pedals

The first public release. It includes everything in 0.1.0 below.

Planned for 1.2: chord tracking for the guitar input (polyphonic pitch detection).

Orograph can now run parts through a real pedalboard. These features follow the pedal and
MPC XL manuals but **have not been tested with real pedals or a real MPC XL yet**. See
[docs/PEDALS.md](docs/PEDALS.md) for what is wired and what still needs the hardware.

### Pedal loop

* A **Pedal** send on every part in the Mix tab, with **Pre** (before the level fader) and
  **Ins** (Insert: hear the part only through the pedals). The controls appear once the
  pedal send is switched on, and do nothing until then.
* **Settings > Pedals**: choose the output device and which outputs carry the main mix
  and the pedal send (main on 1/2 and the send on 3/4 by default). Needs a device with four
  or more outputs and a browser that can choose one (Chrome, Edge or the desktop app); on a
  stereo device the send stays off and Orograph says why.
* A safety limiter on the send, about -18 dB by default, so hot outputs stay inside what
  pedals accept.
* **Pedal return** from an audio input, with echo cancellation, noise suppression and
  automatic gain switched off. It joins the master and can feed the delay and reverb, but
  never goes back into the send. A feedback guard mutes it if it starts to howl or run
  away.
* **Ping** measures the round trip through the pedals and keeps the result for this
  computer.
* **Latency compensation** (Settings > Pedals > Compensate, plus a manual Offset in ms):
  sequencer notes and the arpeggiator on the transport go out early by the round trip for
  parts through the pedals, so the pedal return lands on the beat; parts in Send mode also
  delay their dry sound by the same amount so dry and pedals line up. Notes played live
  cannot be sent early. Not tested with real pedals.
* **Sample rate** choice (Auto, 44.1 kHz, 48 kHz) in Settings > Pedals to match the device;
  the MPC XL runs at 44.1 kHz. Applies after a restart, with a Reload now button. Not tested
  with a real MPC XL.
* **Guitar Level**, a new Links source: with the "Mono return + guitar" input layout, the
  guitar on input channel 2 can move any modulatable control.

### Guitar

* **Guitar plays notes** (Settings > Pedals > Guitar, off by default): single guitar notes
  play the selected part or a chosen part through the normal note path (source "guitar"),
  so the arpeggiator, sustain, Layer mode and MIDI out work as with any keyboard. Choose
  the input channel (the clean DI on channel 2 by default in "Mono return + guitar") and a
  gate. Notes start at the pick with pitch hysteresis and end when the level falls below
  the gate or the pitch moves to another note. **Bends as pitch bend** sends bends and
  vibrato to the part's pitch bend within its Bend range (a part without a range uses
  +/-2 semitones). Only runs while the pedal return is open.
* **Capture**: records a held guitar note, finds its pitch and turns it into a wavetable
  terrain (attack to decay along one axis), stored and selected in slot A or B of the
  guitar's part the same way an imported WAV is. Shows progress, the note it found, or why
  it could not find a steady pitch.
* Neither has been tested with a real guitar, interface or MPC; only unit tests on
  synthetic signals have run.

### Pedal MIDI

* Profiles for the OBNE Purr-ting, Chase Bliss Lost + Found, Cornerstone Nucleo and Walrus
  Xero: MIDI channel per pedal, a warning when two pedals on one cable share a channel,
  Effect on and Bypass, Tap tempo at the song tempo, and preset recall by Program Change.
* Two **Mod** slots per pedal: each moves one pedal control from a Macro, the guitar level
  or its own **pedal LFO** (sine, triangle, saw, square or random; rate in Hz or synced to
  the tempo; depth, range and curve). Values go out only when they change, at most about
  100 messages a second per pedal. Rigs saved with the earlier single "Follow" setting
  load it into the first slot.
* **Scenes recall pedal presets**: a scene can store one preset per pedal (or leave it as
  it is) and sends them as Program Change on each switched-on pedal's channel when it
  loads. Each pedal's own numbering is kept (the Lost + Found's 0 is Live). Set them in the
  Save scene form or with the pedal button on your own scenes in the browser.
* **Patches can recall pedal presets** too, but only with **Patches recall pedal presets**
  switched on in Settings > Pedals. It is off by default, so a shared patch never changes
  your pedals.

### Other changes

* Sessions saved by 0.1.0 load with every pedal setting off. Patches do not store the
  pedal routing, and loading a patch keeps the part's routing.
* The saved state format is now version 3 and the preset library and export files version
  2. Both only add the optional pedal presets: older scenes, patches and export files load
  unchanged, with no pedal presets.
* Bounces render every part dry (the pedals are hardware).
* Desktop app: audio-only capture is allowed for Orograph's own page, and macOS asks for
  the microphone with a short explanation.

### Not in this version yet

* Polyphonic (chord) guitar tracking, and compensating the patch preview and Explore
  notes. Live guitar notes are played as they arrive and are not latency compensated.
* Pedal LFOs synced to the tempo follow its speed but are not locked to the bar line.

## 0.1.0 (October 2026, not released on its own)

The first public version: a complete wave terrain synthesizer that runs as a desktop app
on Mac, Windows and Linux, in a web browser, or offline from a single HTML file.

### Sound engine

* Wave terrain oscillator: a closed path traced over a height map once per cycle, run by
  default at twice the output sample rate with mip-mapped terrain and half-band
  decimation filters to keep aliasing down.
* Four parts with eight voices each, Poly, Mono and Legato modes, glide, up to four
  unison voices with detune and stereo width, velocity sensitivity and pitch bend range.
* Thirteen procedural terrains (Swell, Ripple, Bessel, Dunes, Ridge, Massif, Craters,
  Terraces, Cells, Canyon, Spectra, Lattice, Vortex) with Seed and Detail, on a seamless
  wrapping map.
* Two terrains per part with Morph, plus Warp, Lift and Fold.
* Twelve paths (Ellipse, Lissajous, Rose, Polygon, Star, Spiral, Scan, Spirograph,
  Figure 8, Epicycloid, Superformula, Scribble) with Order and Shape controls, Size,
  Stretch, Rotate and Spin.
* Laps (hard sync, band-limited at the restart) and Pace (phase distortion) with three
  curves: Bend, Skew and Pinch.
* Travel (Natural or Even speed along the path), Direction (Forward or Ping-pong) and
  Key>Size (the loop's size follows the keyboard).
* Sub oscillator and an Air noise layer with its own tone control.
* Filter types Low, Band, High and Notch (state-variable), Comb and Vowel, with drive,
  envelope amount and key tracking.
* Amp envelope and a second envelope for the filter and modulation.
* Five oscillator quality modes: Eco, Standard, High, Pristine and Raw.

### Import

* Images as height maps, with a choice of brightness or one colour channel, smoothing,
  and mirrored or wrapped edges.
* 16-bit PNG height maps (DEMs) decoded at full precision by Orograph's own PNG reader.
* WAV files as wavetables, split into single-cycle frames (frame size from the file's
  `clm` chunk when present).

### Map and dot

* Interactive 3D map with Orbit, Top and Low views, auto-rotate, and Relief, Wireframe,
  Contours, Heat map and Points styles, in several colour palettes.
* Click to move the dot, drag it, nudge it with the arrow keys, or place it on the
  minimap. Shift-drag or scroll over the dot to change the loop's size, Alt-drag it to
  rotate the loop.
* The map draws the loop as set and as modulated, per-voice loops, numbered dot-lock
  badges, the Tour route and Explore pings.
* Dot behaviours: Pin, Roll (a physics marble you can flick, with gravity, friction,
  bounce and world tilt), Drift, Explore (the marble plays in-key notes at peaks and
  valleys) and Tour (up to eight waypoints in time with the tempo, edited on the map).
* A flat map stands in when the 3D view cannot start.
* Signal views: live oscilloscope, the exact single cycle under the current path, and
  its first 16 harmonics next to the Sub.

### Modulation

* A dedicated LFO and Envelope 2 depth for each of 18 modulatable controls, with seven
  shapes (Sine, Triangle, Saw, Square, S&H, Drift and a drawable 16-step Steps shape),
  free or tempo-synced rates and retrigger.
* The Mod tab overview with live bars for every modulated control.
* Links: up to eight routings per part from 15 sources (including velocity, pressure,
  MPE slide, the marble, the envelopes, random and the terrain height under the dot) to
  any modulatable control, with Linear, Soft and Hard curves.
* Four global Macros, usable as Link sources and MIDI-learnable, in the Mod tab and a
  top-bar popover.

### Music

* A 16-step sequencer per part storing scale degrees, so patterns follow the key and
  scale, with per-step octave, velocity, gate, accent and slide, selectable rate and
  length, randomise, clear and shift.
* Dot locks: per-step dot positions with adjustable glide, and recording of dot moves
  into the playing step.
* An arpeggiator per part: Up, Down, Up/Down, Random, As Played and Chord, over one to
  four octaves, with gate and hold.
* Global key, eleven scales, tempo and swing. Keys can play the selected part or layer
  every unmuted part.
* Patch preview: Shift + P (or the Preview button) plays a short phrase suited to the
  patch's category.
* On-screen keyboard with velocity by strike position, glissando, multi-touch, sustain,
  pitch bend and mod wheel strips, and computer keyboard play.

### Patches and scenes

* More than fifty factory patches in ten categories and seven factory scenes.
* Save your own patches and scenes, random patches, Init, search, and JSON export and
  import.
* The session is saved automatically between visits.

### Mixing, recording and export

* Channel strips with level, pan, delay and reverb sends, mute, solo, renaming and part
  colours.
* Master effects: tempo-synced ping-pong delay, generated convolution reverb, chorus,
  warmth, master volume and a limiter with an adjustable ceiling.
* Recording of the output to a 24-bit stereo WAV.
* Offline bounce of 1 to 64 bars to a 24-bit WAV, faster than real time, with optional
  stems per part, effects on or off, and a tail of up to 8 seconds.

### MIDI and the Akai MPC XL

* Web MIDI input with Omni or per-part channels, velocity curves, sustain, mod wheel,
  pitch bend, channel and polyphonic aftertouch, and program change.
* MPE (lower zone) with per-note pitch bend, slide and pressure.
* MIDI Learn on knobs, a mapping table, and a learn wizard for all 16 MPC Q-Links.
* MPC pad modes (Notes or Scale with a learnable base note) and automatic detection of
  MPC ports.
* Note output per part, MIDI clock follow or send (one direction at a time), and Panic.
* An in-app MPC XL setup guide. It is written from Akai's documentation and has not yet
  been tested on a physical MPC XL.

### App

* Dark and light themes that can follow the system, reduce-motion support, keyboard
  shortcuts for the main actions, and a touch-friendly layout for phones.
* Visual quality settings (High, Medium, Low) and audio output device selection where
  the browser allows it.
* Desktop apps for macOS (Apple silicon and Intel), Windows (installer and portable) and
  Linux (AppImage and tar.gz), plus a single-file offline HTML version and a web build,
  with GitHub Actions workflows that build them and publish them from the main branch.

### Known limitations

* The desktop apps are not signed with paid Apple or Microsoft certificates, so the first
  launch needs one extra confirmation. The README explains how.
* MIDI works best in the desktop app or in Chrome, Edge or Opera. Safari has no Web
  MIDI.
* Guitar pedal integration was planned for version 1.1 ([design notes](docs/PEDALS.md)).
