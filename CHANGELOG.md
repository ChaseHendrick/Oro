# Changelog

All notable changes to Orograph are listed here. The [user guide](docs/USER-GUIDE.md)
explains every feature in detail.

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
