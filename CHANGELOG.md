# Changelog

All notable changes to Orograph are listed here. The [user guide](docs/USER-GUIDE.md)
explains every feature in detail.

## 0.1.0 (first release, October 2026)

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
* Guitar pedal integration is planned for version 1.1 ([design notes](docs/PEDALS.md)).
