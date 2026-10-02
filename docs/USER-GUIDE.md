# Orograph user guide

Orograph is a synthesizer you play by moving a glowing dot over a landscape. This guide
explains what every part of it does and why, for a musician who likes to know what is
going on under the hood. It describes version 1.1.1, including the guitar pedal features
([section 15](#15-guitar-pedals)).

![Orograph in the dark theme: the 3D map with the dot and its orbit, the Map panel on the right, the Sound tab below](screenshots/orograph-dark.webp)

**Contents**

1. [What wave terrain synthesis is](#1-what-wave-terrain-synthesis-is)
2. [Your first five minutes](#2-your-first-five-minutes)
3. [A tour of the screen](#3-a-tour-of-the-screen)
4. [The map and the dot](#4-the-map-and-the-dot)
5. [Terrains](#5-terrains)
6. [Paths](#6-paths)
7. [Sound: voice, filter, envelopes](#7-sound-voice-filter-envelopes)
8. [Modulation](#8-modulation)
9. [Music: parts, sequencer, arpeggiator](#9-music-parts-sequencer-arpeggiator)
10. [Patches and scenes](#10-patches-and-scenes)
11. [Mixing and effects](#11-mixing-and-effects)
12. [Recording and bouncing](#12-recording-and-bouncing)
13. [Settings](#13-settings)
14. [MIDI and the Akai MPC XL](#14-midi-and-the-akai-mpc-xl)
15. [Guitar pedals](#15-guitar-pedals)
16. [Keyboard shortcuts](#16-keyboard-shortcuts)
17. [Troubleshooting](#17-troubleshooting)
18. [Credits and clean-room statement](#18-credits-and-clean-room-statement)

---

## 1. What wave terrain synthesis is

Picture a landscape seen from above. Every point on it has a height. Now trace a closed
loop over it, again and again, and write down the height under your pencil as you go.
That list of heights is a waveform. Play it back fast enough and you hear a tone.

That is the whole idea, and it fits in one line:

```
sample(t) = height( path(t) )
```

In a little more detail, for a note of frequency *f*:

```
phase      φ(t)  = frac(f · t)                         one trip round the loop per cycle
point      (u,v) = dot + rotate(θ) · scale(size, stretch) · path(φ)
sample     s(t)  = shape( height(u, v) )               shape = Lift and Fold
```

* **Pitch** is how fast the point goes round the loop. At A4 (440 Hz) it laps the loop
  440 times a second.
* **Timbre** is the shape of the land under the loop. A loop over gentle hills gives a
  round, nearly sinusoidal tone. A loop that crosses sharp ridges or cliffs picks up
  sudden changes in height, and sudden changes mean high harmonics.
* **Movement** comes from changing either side: move the loop (the dot, its size, its
  rotation) or change the land (morph between two terrains, warp it). Because both are
  continuous, small moves give small, smooth changes in tone. It behaves a lot like a
  wavetable, except that the "table" is two-dimensional and you can wander through it in
  any direction.

A few facts about Orograph's version of the technique:

* **The map wraps.** The landscape is a torus: walk off the right edge and you come back
  on the left, walk off the top and you come back at the bottom. Every terrain is built
  so that its height and slope match across the seams, so the dot and the loop can go
  anywhere without clicks. Map coordinates run from 0 to 1 in each direction.
* **Heights are normalised.** Every built-in terrain is scaled so its highest peak or
  deepest valley reaches exactly 1 and its average height is 0, so switching terrains
  does not jump in level.
* **Two terrains at once.** Each part holds Terrain A and Terrain B and blends them with
  Morph: `h = (1 − morph) · A + morph · B`.
* **Aliasing is handled.** A loop that crosses a lot of detail at a high pitch can produce
  harmonics above what the sample rate can carry, which fold back as harsh tones. Orograph
  runs its oscillator at twice the output sample rate by default, reads each terrain from
  a pre-smoothed copy (a "mip level") chosen from how fast the point is travelling, and
  filters the result back down. The [quality modes](#audio-quality) let you trade
  processing for cleanliness, or turn the smoothing off on purpose.

The technique comes from computer music research around 1978 to 1986 (Rich Gold, Yasuhiro
Mitsuhashi, Alberto Borgonovo and Goffredo Haus). The [research brief](RESEARCH.md) has
the history, the maths of every terrain and path family, and the reasoning behind
Orograph's design.

---

## 2. Your first five minutes

1. **Open Orograph.** In a browser you will see a **Start** button: browsers only let a
   page make sound after you click or press a key, so click it (or press almost any key).
   The first time, Orograph loads a factory scene called **First Light** with four parts
   ready to play.
2. **Press Space** (or the Play button in the top bar). The parts play their sequencer
   patterns together. Press Space again to stop.
3. **Click anywhere on the 3D map.** The dot glides there and the sound changes with it.
   Try a few places: valleys, slopes, the top of a ridge.
4. **Twist a few knobs** in the Map panel on the right: **Size** (a bigger loop crosses
   more land and usually sounds brighter), **Morph** (blend Terrain A into Terrain B),
   **Warp** (the land itself ripples) and **Fold** (adds sparkle).
5. **Pick a part** with the keys **1** to **4** (or click a part tab at the top). The map
   always shows the selected part's land and dot. Step through its patches with the **‹**
   and **›** arrows beside the patch name in the top bar.
6. **Play notes** with your computer keyboard: the row **A W S E D F T G Y H U J K O L P ;
   '** is a piano keyboard starting at C. **Z** and **X** move it down and up an octave.
   **Shift + P** plays a short phrase that suits the current patch.
7. **Change the dot's behaviour** with the buttons at the top right of the map: try
   **Roll**, then drag the dot and let go. It becomes a marble that rolls downhill, and the
   sound follows it.

Orograph saves your session in the browser (or the desktop app) as you go, so next time it
opens where you left off.

---

## 3. A tour of the screen

| Area | What is there |
|---|---|
| **Top bar** | The four part tabs (name, patch, a light that shows notes), the patch browser (with Preview, Save, Dice and Init), the transport (Play, tempo, Record, Bounce), and buttons for the Macros, MIDI, theme, Settings and Help. |
| **3D map** (centre) | The selected part's land, its loop (the path) and the dot. View, style and palette buttons at the top left, dot behaviour at the top right, a minimap in the corner, the signal views at the bottom left, the dot's position at the bottom right. |
| **Map panel** (right) | Terrain A and B, the terrain knobs, the path picker and the path knobs. Collapse it with the arrow in its header. |
| **Dock** (bottom) | Four tabs: **Sound** (voice, filter, envelopes), **Mod** (every LFO and envelope depth, plus Links and Macros), **Seq** (sequencer, arpeggiator, key and scale) and **Mix** (channel strips and master effects). |
| **Keyboard** (very bottom) | An on-screen piano with octave buttons, a sustain button, and pitch bend and mod wheel strips. Hide it with the arrow on the right. |

On a phone or a narrow window the layout switches to tabs along the bottom: **Map**,
**Sound**, **Mod**, **Seq**, **Mix** and **Keys**.

### Knobs

Every knob works the same way:

* **Drag** up or down (or left and right). Hold **Shift** for fine control.
* **Scroll** over a knob to nudge it.
* **Double-click** (or Ctrl / Cmd + click) to reset it to its default.
* With a knob focused, the **arrow keys** adjust it and **Page Up / Page Down** take big
  steps. **Enter** lets you type an exact value.
* **Right-click** (or long-press on a touch screen) for a menu: **Modulate...**, **MIDI
  Learn**, **Remove MIDI mapping**, **Type a value...** and **Reset**.

A knob that is being modulated shows a thin outer arc for its range and a small bead that
follows the live value coming back from the sound engine.

### Signal views

The card at the bottom left of the map shows three things, all for the selected part:

* **Output**: an oscilloscope of what you are hearing, triggered so the trace stands still.
* **One cycle**: one exact period of the waveform, computed by walking the current path
  over the current land with the same maths the oscillator uses (including Laps and Pace).
  It updates as you move the dot, so you can see the tone you are about to hear.
* **Harmonics**: the strength of the first 16 harmonics of that cycle, on a logarithmic
  scale that spans 48 dB. The first, lighter bar is the Sub oscillator, an octave below.

---

## 4. The map and the dot

The **dot** is the centre of the loop. Its position is two numbers, **Dot X** (west to east)
and **Dot Y** (north to south), each from 0 to 1. Each part has its own dot; the map shows
the selected part.

### Moving around

| Do this | What happens |
|---|---|
| Click or tap the land | The dot glides to that spot. |
| Drag the dot | Moves it exactly where you put it. |
| Drag the empty sky, or drag with the right or middle mouse button | Turns the camera. |
| Scroll, or pinch with two fingers | Zooms. |
| Click the map, then use the **arrow keys** | Nudges the dot (hold Shift for smaller steps). **+** and **−** zoom. |
| **Shift**-drag the dot | Changes the loop's **Size**. |
| **Alt**-drag the dot | **Rotates** the loop. |
| Scroll over the dot | Changes the loop's **Size** (elsewhere, scrolling zooms). |
| **[** and **]** while the map has focus | Shrink and grow the loop (hold Shift for smaller steps). Elsewhere these keys step through patches. |

The **view buttons** at the top left choose a camera (**Orbit**, **Top** and **Low**),
switch **auto-rotate** on or off (a slow circle round the map in Orbit view), choose a
**map style** (**Relief** for shaded land, **Wireframe**, **Contours**, **Heat map** to colour
by height, or **Points**) and open the **palette** of land colours.

On the map, a thin line shows the loop as the knobs set it and a bright line shows it as it
actually moves, with modulation. When notes are playing and their loops differ (for
example with Key>Size, or a link from velocity), each voice's loop is drawn too. Numbered
square badges mark [dot locks](#dot-locks-in-the-sequencer) and flash when their step plays;
numbered round pins and a dashed route show a Tour; rings open where the Explore marble
passes a peak or a valley.

The **minimap** in the top right corner of the view is a flat, top-down picture of the whole
map with the loop and the dot. Click or drag on it to place the dot precisely; it is the
quickest way to jump across the map.

The readout at the bottom right shows the dot's position and, while sound is running, the
height of the land under it (**h**, from −1 to +1).

If your computer cannot run the 3D view (WebGL switched off or unavailable), Orograph shows
a flat, top-down map in its place. Click or drag on it to move the dot. Everything else
works as usual, except placing Tour waypoints, which needs the 3D map.

### Dot behaviours

The buttons at the top right of the map set what the dot does on its own. The sliders
button next to them opens the settings for the current behaviour.

* **Pin** keeps the dot exactly where you put it.
* **Roll** turns the dot into a marble that rolls downhill under gravity, using a real
  physics engine. Drag it and let go mid-movement to throw it (a "flick").
  Settings: **Gravity** (up to 2 g), **Friction** (how fast it slows down), **Bounce**,
  **Flick** (how hard a throw sends it) and **Tilt X / Tilt Y**, which lean the whole world
  by up to about 17 degrees so the marble drifts in one direction.
* **Drift** lets the dot wander slowly and smoothly by itself. Setting: **Speed**.
* **Explore** lets the marble roam under a slowly turning push, and plays an in-key note
  whenever it passes a peak or the bottom of a valley. Higher ground plays higher notes,
  and high peaks and deep valleys play louder. Notes use the global key and scale and start
  from the part's sequencer octave; while the transport runs they snap to the next
  sixteenth. Settings: the marble controls above, plus **Density** (the shortest gap
  between notes, from two beats down to a sixteenth), **Range** (how many octaves the
  land's height spans, 1 to 4) and **Play notes** (switch the notes off to keep only the
  movement).
* **Tour** moves the dot through up to 8 **waypoints** in time with the tempo. Turn on
  **Edit on map**, then click the map to add a waypoint, drag one to move it, or right-click
  (or long-press) one to delete it. Each waypoint has its own travel time to the next one,
  from a quarter of a beat to 16 beats. The dot follows a smooth curve through the
  waypoints (the dashed route on the map), slows into each one and lands on it on the beat.
  The tour can **Loop**, go back and forth (**Ping-pong**) or play **Once** and stop at the
  last waypoint.

While the marble moves, its speed and the height under it are sent to the sound engine,
where they are available as modulation sources (**Marble Speed** and **Marble Height**, see
[Links](#links)).

### Dot locks

The sequencer can also move the dot: each step can carry a **dot lock**, a spot the dot
glides to when that step plays. See [Dot locks in the sequencer](#dot-locks-in-the-sequencer).

---

## 5. Terrains

Each part has two terrain slots, **A** and **B**. Click a slot to open a grid of every
terrain with a live preview, then pick one. The knobs below the slots shape the land:

| Knob | What it does |
|---|---|
| **Morph** | Blends from Terrain A (0) to Terrain B (1). |
| **Warp** | Bends the map's coordinates with smooth waves, so the land itself ripples. Applied identically to the sound and the picture. |
| **Lift** | Scales the height (0.25x to 4x) before Fold, like driving a signal harder into a shaper. |
| **Fold** | Wavefolds the peaks back down. Adds bright harmonics; combined with Lift it can get wild. |
| **Seed** | Picks a different variation (0 to 99) of the procedural terrains. |
| **Detail** | How much fine detail a procedural terrain gets. The exact meaning depends on the terrain. |

Seed and Detail rebuild the terrain tables, which takes a moment; Morph, Warp, Lift and Fold
are instant and can be modulated.

### The built-in terrains

These descriptions say what each one *tends* to sound like. The loop's size and position
matter just as much, so treat them as starting points.

| Terrain | The land | What it tends to sound like |
|---|---|---|
| **Swell** | A few broad, rolling sine hills. | Smooth, round, vocal tones. Brightness follows the loop's Size closely. |
| **Ripple** | Concentric waves around a centre, like a stone dropped in a pond, with a weaker second stone for interference. | Round tones whose brightness follows Size; a loop that crosses more rings picks up more harmonics. |
| **Bessel** | A cosine field bent by a second cosine. Along a circular loop this is phase modulation inside phase modulation. | FM-style bells and growls. Detail spreads the sidebands wider. |
| **Dunes** | Wind-blown parallel ridges with a long gentle side and a steep face, meandering slowly. | Crossing the ridges reads their saw-like profile; running along them is calmer. |
| **Ridge** | Sharp ridged noise mountains where detail gathers on the crests. | Bright, buzzy edges whenever the loop crosses a crest. |
| **Massif** | Layered fractal mountains (4 to 7 layers of detail). | Complex, evolving spectra. Small moves of the dot change the tone a lot. |
| **Craters** | Gentle plains scattered with impact craters and raised rims. | Mostly calm, with sharp accents where the loop crosses a rim. |
| **Terraces** | Stepped plateaus joined by short risers. | Hard edges: square-ish, gritty tones. |
| **Cells** | Rounded basins where cells meet in soft creases. | Hollow, nasal tones. |
| **Canyon** | A plateau cut by deep, steep-walled valleys. | Flat tops broken by sharp dips; loops that cross a valley get a pulse-like edge. |
| **Spectra** | A wavetable laid out as land: each row (west to east) is one band-limited single cycle, and moving north or south morphs sine, triangle, saw, square and pulse. | Classic synth waveforms. Use the **Scan** path to read one row like a wavetable, and move **Dot Y** to pick the waveform. Detail sets how many harmonics each wave has. |
| **Lattice** | A soft checkerboard whose edges sharpen with Detail. | Hollow, square-wave buzz. |
| **Vortex** | Spiral arms winding out of a centre inside a disc, with a gentle swirl outside it. | Crossing the arms gives a run of harmonics that shifts as you move round the centre; outside the disc it is gentler. |
| **Imported** | Your own image or WAV file. | Whatever you bring. See below. |

### Importing your own terrain

Click the small import button next to a slot (or drop a file straight onto the slot) to
load your own land into it.

**Images become height maps.** Bright is high, dark is low. Before importing, Orograph asks:

* **Height from**: **Brightness**, or a single colour channel (**Red**, **Green**, **Blue**),
  which is handy for maps that store height in one channel.
* **Smoothing**: softens the image before use. Photos usually need some; clean
  gradients need little.
* **Edges**: **Mirror** reflects the image so any picture tiles without a seam. **Wrap**
  keeps it as it is, for images that already tile.

Images are centre-cropped to a square and reduced to at most 256 by 256 points.

**16-bit height maps (DEMs).** Real elevation data, such as a digital elevation model
exported as a 16-bit greyscale PNG, is read by Orograph's own PNG decoder at full 16-bit
precision instead of through the browser (which would cut it to 8 bits and add colour
management). Grey values are treated as heights, not as light. This keeps gentle slopes
smooth instead of turning them into tiny terraces, so real mountains and coastlines become
playable land.

**WAV files become wavetables.** Orograph reads the file sample-exact and splits it into
single-cycle frames: it uses the frame size stored in the file if there is one (a `clm`
chunk, as many wavetable editors write), otherwise multiples of 2048 samples, then 1024,
512 or 256, and failing all of those it treats the file as one cycle. Each frame is
band-limited and resampled to 256 points, up to 256 frames. On the map each frame becomes
one row, so the **Scan** path plays one frame and **Dot Y** moves through the table, just
like Spectra.

Imported files can be up to 25 MB. Your terrain is saved with the session and with any
patch or scene you save from that part.

---

## 6. Paths

The **path** is the closed loop the point traces once per cycle. Click the path button in
the Map panel to choose a shape from a grid of drawings. Every path has two shape controls
whose names change with the path: **Order** (a whole number from 1 to 8) and **Shape** (a
continuous control from 0 to 1).

| Path | Order is | Shape is | The loop |
|---|---|---|---|
| **Ellipse** | Harmonic | Skew | A circle that can be skewed into a line. The purest tone. |
| **Lissajous** | Ratio | Phase | Two sine motions at a frequency ratio of n to n+1. |
| **Rose** | Petals | Bloom | A flower with n petals. |
| **Polygon** | Sides | Round | A straight-edged polygon (a triangle at 3) that can be rounded off. |
| **Star** | Points | Pinch | A star with n points and an adjustable inner radius. |
| **Spiral** | Turns | Core | Spirals out and back in each cycle. |
| **Scan** | Zigzag | Slant | A straight sweep across the map, like reading one row of a wavetable. |
| **Spirograph** | Loops | Pen | Looping curves like the classic drawing toy. |
| **Figure 8** | Lobes | Width | A figure eight, with extra lobes at higher orders. |
| **Epicycloid** | Cusps | Depth | A wheel rolling round a wheel: cardioids and cusps. |
| **Superformula** | Symmetry | Pinch | Rounded blobs through to pinched stars. |
| **Scribble** | Seed | Chaos | A smooth random closed loop. Change Order for a new one. |

### Placing and sizing the loop

| Knob | Range | What it does |
|---|---|---|
| **Size** | 0 to 0.5 (half the map's width) | The loop's radius. Bigger crosses more land and usually sounds brighter. At 0 the loop shrinks to a single point, the height under it stops changing, and the terrain oscillator falls silent (Sub and Air still play if they are up). |
| **Stretch** | −1 to +1 | Squashes the loop wide or tall: up to about 2.8 times wider and 0.35 times as tall at +1, the reverse at −1. |
| **Rotate** | 0 to 360° | Turns the loop. Modulating it wraps round smoothly. |
| **Spin** | −4 to +4 Hz | Rotates the loop continuously, all voices of the part together. Slow spins make slow, cyclic sweeps of the tone; faster spins make it shimmer. |
| **Dot X / Dot Y** | 0 to 1 | Where the dot sits. The same as moving it on the map. |

The exact transform, shared by the sound and the picture, is:

```
ax = 2^(1.5 · stretch),  ay = 2^(−1.5 · stretch)
x  = path.x · ax · size,  y = path.y · ay · size
θ  = rotate + 360° · spin phase
u  = dotX + x cos θ − y sin θ,   v = dotY + x sin θ + y cos θ     (wrapped into 0..1)
```

### How the point travels: Laps, Pace and Travel

These three change *when* the point is where along the loop, without changing the loop's
shape. They are the most "synth-like" controls in Orograph.

**Laps** (1 to 8) traces the loop that many times per cycle and restarts it at the start of
every cycle. At whole numbers the waveform simply repeats (2 laps sound an octave up, 3 an
octave and a fifth). In-between values cut the last lap short and restart, which is exactly
what **hard sync** does on an analogue synth: the pitch stays on the note, and sweeping Laps
gives the classic tearing sync sound. The restart is smoothed (band-limited) so it does not
alias.

**Pace** (−1 to +1) speeds the point up and slows it down within each cycle, a form of
**phase distortion**. At 0 the point moves at the path's natural speed. **Curve** picks how
Pace bends the speed:

* **Bend**: one speed-up and one slow-down per cycle.
* **Skew**: splits the cycle into two halves at different speeds, with smoothed knees, in
  the manner of classic phase distortion synths. Positive and negative Pace move the knee
  in opposite directions.
* **Pinch**: two symmetric speed-ups per cycle.

Pace is applied before Laps: `t = frac(laps · g(φ))`, where `g` is the Pace curve.

**Even speed** (the **Travel** setting) changes how the point moves along the loop.
Normally it follows the curve's maths, so it rushes round some corners and dawdles on
others. With Even speed on, it moves at a constant speed along the loop's length.

**Ping-pong** (the **Direction** setting) runs each lap forward and then backward. The
waveform of each lap becomes a mirror image of itself, and open-ended loops such as
**Scan** never jump from end to start. It is applied after Pace and Laps.

**Key>Size** (−1 to +1) makes the loop's size follow the keyboard. Negative values shrink
the loop for higher notes (and grow it for lower ones), which keeps high notes from turning
harsh, much like brightness tracking on a filter. The rule is
`size × 2^(keySize · (note − 60) / 24)`, so at −1 the loop is half the size two octaves
above middle C.

---

## 7. Sound: voice, filter, envelopes

Everything here is in the **Sound** tab and applies to the selected part. The signal flow of
one voice is: oscillator (path over terrain, then Lift and Fold) → plus Sub and Air →
Drive → filter → amp envelope → pan. Because Sub and Air go in before the filter, the
filter and the amp envelope shape them too.

### Voice

| Control | What it does |
|---|---|
| **Poly / Mono / Legato** | Poly plays up to 8 notes per part. Mono plays one note at a time (last note wins) and glides on every note if Glide is up. Legato is Mono that only glides between overlapping notes and does not restart the envelopes, which is how acid-style slides work. |
| **Octave** | ±3 octaves. |
| **Tune** | ±12 semitones. |
| **Fine** | ±100 cents. Can be modulated (for vibrato). |
| **Glide** | Portamento time, 0 to 2 seconds. |
| **Bend** | Pitch bend range, 0 to 24 semitones. |
| **Sub** | A clean sine one octave below each note, added before the filter. |
| **Unison** | Stacks 1 to 4 copies of each voice. |
| **Detune** | How far apart the unison copies are, 0 to 50 cents. |
| **Width** | How far the unison copies spread across the stereo field. |
| **Velocity** | How much playing harder makes the note louder. |
| **Air** | A breathy noise layer that follows the amp envelope and goes through the filter. |
| **Air Tone** | The colour of that noise, from dark (−1) to bright (+1). |

### Filter

Choose the type from the menu in the Filter card.

| Type | What it does |
|---|---|
| **Off** | No filtering. |
| **Low**, **Band**, **High**, **Notch** | A smooth two-pole state-variable filter. **Cutoff** sets the frequency (30 Hz to 18 kHz) and **Reso** the resonance. |
| **Comb** | A comb filter: a very short delay fed back into itself, which gives metallic, resonant and plucked-string colours. **Cutoff** sets the comb's frequency, **Reso** its feedback, and **Vowel** blends between a comb with peaks at every multiple of that frequency and one with peaks halfway between them, which sounds hollower. |
| **Vowel** | A formant filter that morphs through the vowels A, E, I, O and U as you turn **Vowel**. **Reso** sharpens the formants and **Cutoff** shifts them up or down by up to an octave around 1 kHz. |

The other filter controls:

* **Drive** pushes the signal into gentle saturation before the filter.
* **Env Amt** sends Envelope 2 to the cutoff, up to ±6 octaves.
* **Key Trk** makes the cutoff follow the note you play (1 = fully).

The **Vowel** knob is dimmed unless the filter type is Comb or Vowel.

### Envelopes

* **Amp envelope** (Envelope 1) shapes the volume of each note: Attack (1 ms to 8 s),
  Decay (to 8 s), Sustain level, Release (to 10 s). The attack aims a little past full
  level and stops there, the way analogue envelopes do, which gives a snappier start.
* **Envelope 2** has the same four stages. It drives the filter's **Env Amt** and every
  **Env 2** depth in the Mod tab, so one envelope can open the filter, grow the loop and
  morph the land at the same time.

The graphs above each envelope show its shape as you turn the knobs.

---

## 8. Modulation

![The Mod tab: every modulatable control with its LFO shape, rate, depth, Envelope 2 depth and a live bar](screenshots/orograph-dark-mod.webp)

### A modulator for every knob

Eighteen controls can move on their own: **Morph**, **Warp**, **Lift**, **Fold**, **Shape**,
**Size**, **Stretch**, **Rotate**, **Dot X**, **Dot Y**, **Fine**, **Cutoff**, **Reso**,
**Drive**, **Pan**, **Laps**, **Pace** and **Vowel**. Each one has its own LFO and its own
Envelope 2 depth, per part.

Right-click a knob and choose **Modulate...** to open its editor:

* **LFO shape**: Sine, Triangle, Saw, Square, S&H (sample and hold), Drift (smooth random)
  and **Steps** (see below).
* **Speed**: a free rate from 0.01 to 30 Hz, or **Sync** to lock it to the tempo with
  divisions from 4 bars down to 1/32, including dotted and triplet values.
* **Retrig** restarts the LFO with each new note (when no other notes are held).
* **Amount**: **LFO** depth and **Env 2** depth, each from −100% to +100% of the knob's full
  travel.

The animated preview shows the knob's base position, the LFO swinging round it and, while
notes play, the live value.

The **Mod** tab shows all eighteen at once in a table: shape, rate, depth, Env 2 depth,
retrigger and a live bar for each, with **Clear all** to start again.

**The maths.** Modulation is added in "knob space", where 0 is the knob fully left and 1
fully right:

```
n = clamp( knob + LFO · lfoDepth + Env2 · envDepth + links, 0, 1 )
```

then turned back into a real value through the knob's own curve. So 50% depth always means
"half the knob's travel", whatever the units. Rotate, Dot X and Dot Y wrap round instead of
stopping at the ends.

### Steps LFO

The **Steps** shape is a 16-step sequence of values instead of a waveform. Pick Steps and a
row of bars appears: draw on it with the mouse or a finger, or focus a bar and use the arrow
keys. Double-click resets it. Each step holds its value for one sixteenth of the LFO's
period, with a 2 ms slew so the steps do not click. Synced to 1 bar, that is a classic
16-step modulation sequence.

### Links

**Links** (Mod tab, **Links + Macros**) route a source to any of the eighteen modulatable
controls, with an amount and a response curve. Each part can have up to 8.

| Source | Range |
|---|---|
| **Velocity** | 0 to 1, per note |
| **Mod Wheel** | 0 to 1 |
| **Pressure** | 0 to 1 (channel or per-note aftertouch) |
| **Key** | −1 to +1 across four octaves either side of middle C, per note |
| **Slide** | 0 to 1 (MPE slide, CC 74) |
| **Macro 1** to **Macro 4** | 0 to 1 |
| **Marble Speed** | 0 to 1 |
| **Marble Height** | −1 to +1 |
| **Env 1**, **Env 2** | 0 to 1, per note |
| **Random** | −1 to +1, a new value for each note |
| **Terrain Height** | −1 to +1, the height of the land under the dot |
| **Guitar Level** | 0 to 1, how loud the guitar on the pedal return's second channel is (see [Guitar pedals](#15-guitar-pedals)) |

**Curve** shapes the response: **Linear**, **Soft** (squared: gentle at first, strong at the
end) or **Hard** (square root: strong at first). **Amount** runs from −100% to +100%. Links
are added after the LFO and Envelope 2, per voice.

Every new part starts with one link, **Mod Wheel → Morph** at +100%, so the mod wheel
morphs between the two terrains. You can change or delete it like any other link.

### Macros

The four **Macro** knobs are shared by all parts. They live in two places: the **Macros**
button in the top bar (always one click away while you play) and the Links + Macros view.
On their own they do nothing; use them as Link sources to build one-knob gestures that move
several controls in several parts at once. They are MIDI-learnable, which makes them ideal
for an MPC Q-Link or a hardware fader.

---

## 9. Music: parts, sequencer, arpeggiator

![The Seq tab in the light theme: the 16-step grid with note, octave, velocity, gate, accent, slide and dot rows](screenshots/orograph-light-seq.webp)

### Parts

Orograph has **four parts**, each a complete synth with its own terrains, path, dot, sound,
modulation, pattern and arpeggiator. Select one with its tab or the keys **1** to **4**. The
light on each tab flashes when that part plays a note.

**Keys play** (Seq tab) decides what the keyboard and MIDI play: **Selected** (the part you
are looking at) or **Layer** (every part that is not muted, all at once).

### Key, scale, tempo and swing

These are shared by all parts:

* **Key** and **Scale**: Major, Minor, Dorian, Phrygian, Lydian, Mixolydian, Pent Maj,
  Pent Min, Blues, Harm Min and Chromatic.
* **Tempo**: 40 to 240 BPM, in the top bar. Drag the number or type into it.
* **Swing**: 0 to 60%. It delays every off-beat sixteenth; the maximum is a 3:1 shuffle.
  Triplet rates are not swung.

### The step sequencer

Each part has a 16-step sequencer. Turn on **Seq on** for the parts you want to hear, then
press Play.

| Control | What it does |
|---|---|
| **Seq on** | Whether this part's pattern plays when the transport runs. |
| Step rate | 1/4, 1/8, 1/8T, 1/16, 1/16T or 1/32. |
| **Length** | 1 to 16 steps. Steps beyond the length are greyed out. |
| **Octave** | The base octave of the pattern, C0 to C7. |
| Tools | **Randomise**, **Clear**, and **Shift** the pattern one step left or right. |

The grid has one column per step and one row per setting:

* **Step**: on or off. Click a pad, or drag across pads to paint them.
* **Note**: the pitch, written as a note name. Drag up or down, scroll, or use the arrow
  keys (Page Up / Page Down jump by seven scale steps).
* **Oct**: shifts that step by −2 to +2 octaves. Click to cycle.
* **Vel**: velocity. Drag the bars.
* **Gate**: how long the note lasts, from 5% to 100% of the step. Drag the bars.
* **Accent**: plays the step at full velocity.
* **Slide**: holds the note into the next one so they overlap. In **Legato** mode with some
  **Glide**, that gives a smooth pitch slide without restarting the envelope.
* **Dot**: a dot lock (below).

**Steps store scale degrees, not fixed notes.** A step says "the third note of the scale",
not "C sharp". Change the key or scale and every pattern follows, staying in key. Setting a
step while the transport is stopped plays it so you can hear what you chose.

### Dot locks in the sequencer

The **Dot** row lets the sequencer move the dot, so each step can sit on a different patch
of land.

* Click a step's **Dot** cell to lock it to where the dot is right now. A tiny map in the
  cell shows the spot.
* **Shift**-click a locked cell to move its lock to where the dot is now.
* Click a locked cell again to clear it.
* **Dot glide** sets how long the dot takes to reach each locked spot, from **Jump** (instant)
  to a whole step.
* **Rec dot**: while the transport is playing, moving the dot records its position into
  whichever step is sounding. Turn it on, press Play, and perform a path across the map.

Locked spots are marked on the 3D map with numbers. If you grab the dot while a lock is
gliding it, your hand wins.

### Arpeggiator

Each part also has an arpeggiator (the **Arp** row in the Seq tab). Hold a chord and it
plays the notes one at a time.

* **Mode**: Off, Up, Down, Up/Down, Random, As Played (in the order you pressed them) and
  Chord (the whole chord on every step).
* **Rate**: the same choices as the sequencer.
* **Octaves**: 1 to 4.
* **Gate**: 5% to 100% of each step.
* **Hold**: latches the chord so it keeps playing after you let go. Playing a new chord
  replaces it.

### Preview

**Shift + P** plays a short phrase, about two bars long, on the selected part. The phrase
suits the patch's category (a bass line for a bass, held chords for a pad, and so on) and
uses the current key and tempo. If the transport is running, the phrase starts on the next
beat and swings with everything else. The **Preview** button in the patch browser does the
same. Press either one again to stop the phrase. It is the quickest way to hear a patch in
context.

### The on-screen keyboard

* Strike lower on a key to play louder, higher to play softer.
* Drag across the keys for a glissando. Several fingers work on a touch screen.
* The arrows change octave (or press **Z** and **X**). **C** and **V** change the computer
  keyboard's velocity, shown as **Vel**.
* **Sustain** holds notes like a sustain pedal.
* The two strips are **pitch bend** (springs back to the centre) and **mod wheel** (stays
  where you leave it; by default it morphs between the two terrains).

The keyboard lights up the notes the selected part is playing (every part's notes in
Layer mode), including notes from the sequencer and the arpeggiator. The computer keys follow their physical positions, so they work the same on
non-English keyboard layouts.

---

## 10. Patches and scenes

A **patch** is the sound of one part: terrains, path, sound, modulation, links and the dot's
behaviour. It does not include the sequencer pattern. A **scene** is everything: all four
parts with their patterns, plus tempo and key.

The patch browser sits in the top bar:

* **‹** and **›** step through patches for the selected part. So do **[** and **]**, as long
  as the map does not have keyboard focus.
* Click the patch name to open the browser: search, switch between **Patches** and
  **Scenes**, and click to load. Patches are grouped by category.
* **Preview** plays a short phrase with the patch (the same as Shift + P).
* **Save** stores the selected part's sound as a patch of your own.
* **Dice** rolls a new random patch.
* **Init** starts from a clean, simple patch.
* At the bottom of the browser: **Save scene**, and **Export** / **Import** to move your own
  patches and scenes between computers as a JSON file.

Your own patches and scenes are marked **User** and can be deleted (click the bin twice).
Factory ones cannot. Orograph comes with more than fifty factory patches in ten categories
(Bass, Lead, Pad, Keys, Pluck, Bell, Texture, Drone, FX and Arp) and seven factory scenes
(First Light, Glass Archipelago, Neon Coastline, Isoline Pulse, Paper Maps, Continental
Shelf and Signal Fault).

**Where things are kept.** Your session (everything on screen) is saved automatically as you
work. Your own patches and scenes are kept separately. Both live in the browser's storage
for the page you use (or in the desktop app's own storage), so clearing site data in the
browser also clears them. Export them to a file if you want a backup.

---

## 11. Mixing and effects

The **Mix** tab has a channel strip for each part:

* **Level** fader with an activity meter.
* **Pan**, **Delay** send and **Reverb** send.
* **M** (mute) and **S** (solo).
* **Pedal** send with **Pre** and **Ins**, shown only while the pedal send is switched on
  (see [Guitar pedals](#15-guitar-pedals)).
* Click the part's name to select it, double-click (or press F2) to rename it, and click the
  colour swatch to change the part's colour everywhere in the app.

The **Master** section:

| Effect | Controls |
|---|---|
| **Delay** | A stereo ping-pong delay synced to the tempo. **Time** (1/2 down to 1/32, including dotted and triplet values), **Feedback**, **Tone** (dark and full to thin and bright) and **Return**. Changing the time bends the pitch smoothly, like a tape delay, instead of clicking. |
| **Reverb** | A convolution reverb whose impulse response Orograph generates itself. **Size**, **Damp** (how quickly the highs die away) and **Return**. |
| **Colour** | **Chorus** (on the whole mix) and **Warmth** (soft saturation that keeps the loudness about the same as you turn it up). |
| **Volume** | The master fader, with a stereo peak meter. |
| **Ceiling** | The output limiter's ceiling, from −6 dB to 0 dB (default −0.3 dB). Peaks never go above it, and quieter material passes at the same level whatever the ceiling. |

The chain is: parts → sends into delay and reverb → chorus → warmth → volume → limiter →
output. The limiter is always on, so the output never goes above the ceiling.

---

## 12. Recording and bouncing

### Record

Press **R** or the red record button in the top bar to start recording, and again to stop.
Orograph saves a **24-bit stereo WAV** of exactly what you hear (after the limiter) to your
downloads folder, named with the date and time, for example `orograph-20261002-143015.wav`.
A recording stops and saves by itself after 20 minutes.

### Bounce

**Bounce** (the button next to Record, or Settings > Audio > Bounce) renders the sequencers
offline, faster than real time and sample-exact, without you having to play along.

* **Length**: 1 to 64 bars. The popover shows how many seconds that is at the current
  tempo.
* **Tail**: 0 to 8 seconds extra at the end, so delay and reverb can ring out.
* **Files**: **Mix** (one stereo file) or **Mix + stems** (the mix plus one file per part;
  each stem is that part on its own, with its own sends into the effects, so it sounds like
  it does in the mix).
* **Effects**: render with the delay, reverb, chorus and warmth, or dry.

Only what the sequencers, arpeggiators and dot locks play is rendered; parts without a
pattern stay silent. Files are 24-bit WAVs named like
`orograph-bounce-20261002-143015.wav`, and stems add `-part1`, `-part2` and so on.

---

## 13. Settings

Open **Settings** with the gear button or the **,** key.

### General

* **Theme**: **System** (follow your computer's light or dark setting), **Dark** or
  **Light**. The theme button in the top bar cycles through the same three. When
  Orograph runs on hendrickresearch.com and you have not chosen a theme in Orograph yet, it
  follows the website's own Appearance setting.
* **Reduce motion**: calms animations. System follows your computer's setting.
* **Show tips**: hover hints and the map hint.
* **Visual quality** for the 3D map:

  | Setting | What it renders | Cost |
  |---|---|---|
  | **High** | Up to 2x pixel density, glow (bloom), 4x anti-aliasing | Heaviest on the graphics chip |
  | **Medium** | Up to 1.5x pixel density, glow, 4x anti-aliasing | A good choice for laptops with built-in graphics |
  | **Low** | 1x pixel density, no glow, no anti-aliasing | Lightest; use it if the map stutters |

  Visual quality never changes the sound.
* **Map style**, **Palette** (the colours of the land from valleys to peaks, shown as
  swatches) and **Auto-rotate**.

### Audio

* The engine's state, mode (AudioWorklet, or a slower fallback on old browsers), sample
  rate and latency, with **Start audio**, **Test tone** and **Panic** (stop every note).
* **Output device**: choose where the sound goes, in browsers that allow it (Chrome and
  Edge) and in the desktop app. Elsewhere, change the output in your computer's sound
  settings.
* **Bounce...** (see above).

<a id="audio-quality"></a>
**Oscillator quality** trades processing for a cleaner tone. It is a setting for this
computer, not part of a patch.

| Mode | What it does | Cost |
|---|---|---|
| **Eco** | Runs the oscillator at the output rate (no oversampling) and reads slightly smoother terrain. | Lightest. Some aliasing on high notes. |
| **Standard** | Two times oversampling. The default. | Balanced. |
| **High** | Four times oversampling in two stages. | Roughly twice the oscillator work of Standard. Cleaner high notes. |
| **Pristine** | Standard, plus a band-limited single cycle per voice, rebuilt about every 256 samples and crossfaded, whenever the loop is steady. Falls back to Standard for a voice whose loop is being moved at audio rate. | Extra work per voice. The cleanest tone. |
| **Raw** | Two times oversampling with the terrain smoothing switched off. | Like Standard. Deliberately gritty and digital: aliasing on purpose. |

### MIDI & MPC, Pedals, Shortcuts, About

Covered in the next sections. **About** shows the version and licence.

---

## 14. MIDI and the Akai MPC XL

MIDI works in the **desktop app** and in **Chrome, Edge or Opera** on a secure page (https,
localhost, or the offline file). Safari does not support Web MIDI. In a browser, click
**Connect MIDI** in Settings > MIDI & MPC and allow access when asked; the desktop app does
not need to ask.

### What Orograph understands

* **Notes** and **velocity**, with a **velocity curve** (Soft, Linear, Hard).
* **Pitch bend**, **mod wheel** (CC 1), **sustain** (CC 64), **channel pressure** and
  **polyphonic aftertouch** (both available as the **Pressure** link source).
* **All notes off** and **all sound off** (CC 123 and 120), and **reset controllers**
  (CC 121).
* **Program change**, if you turn it on: program 0 (shown as 1 on many devices) loads the
  first patch in the patch list, program 1 the second, and so on.
* **MIDI clock**: follow an external clock, or send one.
* **MPE** (lower zone): each note on its own channel (2 to 16) with its own pitch bend
  (±48 semitones), **Slide** (CC 74) and pressure. Leave MPE off for an MPC.

### Routing

* **Omni**: any channel plays one part (the selected part, or a part you choose).
* **Multi**: each part listens on its own channel.
* **Send notes** plays another instrument (such as the MPC) from Orograph's keyboard,
  sequencer and arpeggiator, with an output channel per part.
* **MPC pads**: **Notes** plays the pitches the pads send; **Scale** maps the pads onto the
  current key and scale, starting from a **base note** (press **Learn** and hit your lowest
  pad to set it).

### MIDI Learn

Right-click any knob, including the Macros and the master controls, and choose **MIDI
Learn**, then move a knob or fader on your controller. **Remove MIDI mapping** undoes it.
The **Mappings** table in Settings lists everything with its CC and channel, and lets you
remove any of them.

The **Q-Link learn** wizard maps all 16 of the MPC's Q-Link knobs in one pass: it asks you
to twist each Q-Link in turn, and you can go **Back**, **Skip** or finish early. In order,
the Q-Links control: Dot X, Dot Y, Size, Rotate, Morph, Warp, Fold, Lift, Shape, Stretch,
Cutoff, Reso, Drive, Env Amt, Reverb send and Delay send, for the selected part.

### Clock

Only one device should lead the tempo. Turning on one of these turns the other off:

* **Follow MPC clock**: the MPC sets the tempo and starts and stops Orograph. The tempo
  shows an **EXT** badge.
* **Send clock to MPC**: Orograph sets the tempo. On the MPC, set Sync Receive to MIDI
  Clock.

### Akai MPC XL in brief

The full walkthrough is in **Settings > MIDI & MPC** and in [MPC-XL.md](MPC-XL.md). The short
version:

1. Connect the MPC XL's **USB-C** port to the computer with a cable that carries data. Keep
   the MPC in **Standalone** mode. On Windows, if no MIDI port appears, install the MPC XL
   driver from Akai's inMusic Software Center.
2. In Orograph, **Connect MIDI**. Ports whose name contains "MPC" are recognised
   automatically and Orograph prefers Port 1.
3. **To play Orograph from the pads**: on the MPC, enable USB MIDI Port 1 under Menu >
   Preferences > MIDI / Sync, make a MIDI track whose output is USB MIDI Port 1, and play.
   Choose **Notes** or **Scale** for the pads in Orograph.
4. **To map the Q-Links**: run the **Q-Link learn** wizard.
5. **To play the MPC from Orograph**: set a track's MIDI input on the MPC to USB MIDI Port 1
   on a specific channel with monitoring on, then turn on **Send notes** in Orograph.
6. **Tempo**: use either Follow MPC clock or Send clock to MPC, never both.

None of this has been tested on a physical MPC XL yet. The steps come from Akai's
documentation, so treat menu names as guidance and use the MPC's MIDI monitor to confirm
what is being sent.

---

## 15. Guitar pedals

Version 1.1 can send parts out to a pedalboard and bring the pedals back in. It follows the
pedal and MPC XL manuals but **has not been tested with real pedals or a real MPC XL yet**,
so start with the send low and check each step. Everything lives in **Settings > Pedals**;
with the pedal send off, Orograph sounds exactly as before.

**Pedal send.** Switch on **Pedal send**, pick an **Output device** with four or more
outputs (for example the MPC XL over USB) and choose which outputs carry the **Main mix**
(1/2 by default) and the **Send** (3/4). Then turn up a part's **Pedal** knob in the Mix
tab. **Pre** takes the send before the part's level fader; **Ins** (Insert) mutes the
part's own sound so you only hear it through the pedals. A limiter keeps the send at about
-18 dB (**Send ceiling**), below what most pedals accept. If the device only has two
outputs, or the browser cannot choose an output, the send stays off and the pane says why.
Choosing an output works in Chrome, Edge and the desktop app.

**Pedal return.** Switch on **Pedal return** and pick the **Input** the pedals come back on.
The browser asks once for permission to use it. Orograph turns off echo cancellation, noise
suppression and automatic gain so the pedals sound as they are. The return joins the master
mix, and **Return to delay** and **Return to reverb** send it into the effects; it never
goes back into the pedal send. If it starts to feed back, Orograph mutes it and shows an
**Unmute return** button. With **Mono return + guitar**, input channel 1 is the pedals and
channel 2 is your guitar, which drives the **Guitar Level** Links source.

**Guitar.** The Guitar group listens to one channel of the pedal return, so it only works
while the return is open. **Input channel** picks it: with **Mono return + guitar** use
channel 2, the clean DI (track the guitar before any drive or fuzz; distortion makes the
pitch harder to find). Nothing here has been tried with a real guitar yet.

* **Guitar plays notes** (off by default) turns single notes into notes on a part, like
  playing the keyboard: **Part** is the selected part (which also follows Layer key mode)
  or Part 1 to 4. A note starts when you pick it and the pitch is steady (expect a few
  tens of milliseconds), a hammer-on, pull-off or slide changes to the new note, and the
  note ends when you mute the string or it decays below the **Gate**. Lower the gate to
  catch quieter playing; raise it if hum or string noise starts notes. Guitar notes go
  through the same path as other notes, so the arpeggiator, sustain and MIDI out (Send
  notes in MIDI & MPC) all apply. Play one note at a time; chords are not tracked.
* **Bends as pitch bend**: bends and vibrato move the part's pitch bend, scaled to the
  part's **Bend** range in the Sound panel (2 semitones by default). A bend wider than the
  range becomes a new note. With this off, or with Bend at 0, a bend steps from note to
  note instead.
* **Capture** records one held note (about three seconds) and turns it into a wavetable
  terrain: Orograph finds the note's pitch, cuts one cycle at a time from the pick attack
  to the decay and lays them out along one axis of the map. Choose **Slot A** or **Slot
  B**, press **Capture**, then pick one note and let it ring. The bar shows the progress,
  then the pane shows the note and frequency it found, and the terrain is stored and
  selected in that slot of the guitar's part (the selected part when Part is "Selected
  part"), just like an imported WAV. If there is no steady pitch (a chord, a muted string,
  silence) Orograph says so and changes nothing.

**Latency.** **Ping** plays a short chirp on the send with the music muted and times how long
it takes to come back (expect tens of milliseconds). Bypass delay, reverb and looper pedals
first. The result is kept for this computer. Switch on **Compensate** to make up for it:

* Parts in **Insert** mode: sequencer notes, and the arpeggiator while the transport plays,
  are sent out early by the round trip, so what comes back from the pedals lands on the
  beat. The step lights, dot locks and MIDI out stay on the beat.
* Parts with a **Pedal** send (not Insert): the same notes go out early, and the part's
  own dry sound (with its delay and reverb sends) is held back by the round trip, so the dry
  sound and the pedals line up, on the beat.
* **Offset** (in ms) is added to the measured round trip. Use it to fine tune by ear, or on
  its own if Ping cannot hear the return.
* Notes you play live (keys, MIDI in, or the arpeggiator with the transport stopped) cannot
  be sent early. An Insert part played live is heard a round trip late, and a Send part
  played live has its dry sound delayed to match the pedals.
* Nothing moves while the pedal send is off. Parts without a Pedal send are never moved.
* The transport waits the round trip before the first beat after you press Play.

**Sample rate.** The MPC XL runs at 44.1 kHz. **Sample rate** offers **Auto** (the browser
decides, usually the device's rate), **44.1 kHz** and **48 kHz**. The audio engine cannot
change rate while running, so a new choice applies after a restart: press **Reload now**
(the session is saved first). If the browser refuses the rate, the pane says so and keeps
running at its own rate.

**Pedal MIDI.** Switch on the pedals you have (OBNE Purr-ting, Chase Bliss Lost + Found,
Cornerstone Nucleo, Walrus Xero) and set each one's MIDI channel; Orograph warns when two
pedals on the same cable share a channel. Each card has **Effect on**, **Bypass**, **Tap
tempo** (four taps at the song tempo) and **Send preset** where the pedal supports them.
Messages go to the output chosen in MIDI & MPC unless you pick another one here. Values
marked as not confirmed come from the manuals but have not been checked on the pedal.

**Moving pedal controls.** Each pedal card has two **Mod** slots. In each, pick a
**Source** (Off, Macro 1-4, Guitar level or LFO) and the pedal **Control** it moves. **Min**
and **Max** set the range sent to the pedal (set Min above Max to turn it upside down) and
**Curve** shapes it (Linear, Soft, Hard). With **LFO** you also get the **Shape** (sine,
triangle, saw, square, random), the rate in **Hz** or synced to the **Tempo** (from 1/16
note to 8 bars per cycle, following the song tempo or external clock), and **Depth**, how
much of the range it sweeps around the middle. Orograph only sends a value when it changes,
and never more than about 100 messages a second per pedal, so a fast LFO cannot crowd out a
tap or a preset change. If both slots pick the same control, the first one wins.

**Pedal presets in scenes and patches.** When you save a scene or a patch with pedals
switched on, the save form has a **Pedal presets** section: type a preset number for each
pedal, or leave a box empty to leave that pedal as it is. Numbers mean what they mean on the
pedal: on the Lost + Found 0 is **Live**, the Purr-ting's presets start at 1. Your own
scenes and patches also have a pedal button in the browser to change these later. Loading a
scene sends its presets (Program Change) to the pedals switched on in Settings > Pedals.
Patches only do so when **Patches recall pedal presets** is on in Settings > Pedals; it is
off by default, so loading a patch someone shared with you never changes your pedals.
After a preset change, controls that follow a Macro are sent again so the Macro stays in
charge.

These settings belong to this computer, not to a song: only the preset numbers travel with
scenes and patches. Patches never change a part's pedal routing, and bounces render every
part dry, with no compensation. Routing details for the MPC XL are in [PEDALS.md](PEDALS.md). As with the rest of
this chapter, pedal LFOs and preset recall have only been tested with simulated MIDI, not
with the real pedals.

---

## 16. Keyboard shortcuts

Press **?** in the app to see this list at any time. Shortcuts do nothing while you are
typing in a text field.

**Playing**

| Keys | Action |
|---|---|
| Space | Play / stop |
| A W S E D F T G Y H U J K O L P ; ' | Play notes, from C up to the F an octave higher |
| Z / X | Keyboard octave down / up |
| C / V | Keyboard velocity down / up |
| R | Record on / off (saves a WAV) |
| Shift + P | Preview the selected part with a short phrase (P alone plays a note) |

**Navigating**

| Keys | Action |
|---|---|
| 1, 2, 3, 4 | Select a part |
| [ / ] | Previous / next patch (loop Size when the map has focus) |
| , | Settings |
| ? | Help |
| Esc | Close menus and dialogs, cancel MIDI Learn |

**Knobs**

| Do this | Action |
|---|---|
| Drag | Up / down (or left / right) to change |
| Shift + drag | Fine adjustment |
| Double-click, or Ctrl / Cmd + click | Reset to default |
| Arrow keys | Adjust the focused knob; Page Up / Page Down for big steps |
| Enter | Type an exact value |
| Right-click (long-press on touch) | Modulate, MIDI Learn, Reset |

**Map**

| Do this | Action |
|---|---|
| Click | Move the dot (or add a waypoint while editing a Tour) |
| Shift + drag the dot | Change the loop's Size |
| Alt + drag the dot | Rotate the loop |
| Wheel | Over the dot: Size. Elsewhere: zoom |
| Arrow keys (map focused) | Nudge the dot; Shift for smaller steps |
| [ / ] (map focused) | Shrink / grow the loop |
| + / − (map focused) | Zoom in / out |

**Sequencer**

| Do this | Action |
|---|---|
| Arrow keys | Left / right move along a row; up / down change the value |
| Space or Enter | Toggle the focused step, accent or slide |
| Drag | Paint across pads or bars |
| Shift + click on a Dot cell | Move that step's dot lock to where the dot is now |

---

## 17. Troubleshooting

**No sound.**
* Click **Start**, or click anywhere on the page: browsers keep audio off until you
  interact.
* Check the master **Volume** in the Mix tab and that the part is not muted, or that
  another part is not soloed.
* Check the loop's **Size**: at 0 the loop is a single point and the terrain oscillator
  makes no sound.
* Settings > Audio shows whether the engine is running. Try **Test tone**.
* In a browser, check that the tab is not muted and that the right output is selected.

**Crackles or dropouts.**
* Set **Oscillator quality** to Standard or Eco (Settings > Audio).
* Use fewer **Unison** voices on busy parts.
* Lower **Visual quality** (Settings > General) so the graphics leave more time for the
  sound.
* Close other heavy tabs or apps.

**The map stutters or the fan spins up.** Lower **Visual quality** to Medium or Low and turn
off **Auto-rotate**. On laptops, plug in power: some systems slow the graphics chip on
battery.

**The 3D map is replaced by a flat map.** Your browser could not start WebGL. Check that
hardware acceleration is on in the browser's settings. Everything except placing Tour
waypoints still works with the flat map.

**High notes sound harsh or metallic.** That is aliasing. Try **Key>Size** below 0, a smaller
**Size**, a smoother terrain, or **High** / **Pristine** quality. Or enjoy it: **Raw** mode
exists for that sound.

**MIDI device not found.**
* Use the desktop app, or Chrome / Edge on a secure page. Safari has no Web MIDI.
* Click **Connect MIDI** and allow access. If you blocked it once, allow MIDI in the site
  settings (the icon in the address bar) and reload.
* Close other music software that may be holding the port (older Windows MIDI drivers let
  only one program use a port).
* Try another USB cable: some only carry power.
* For an MPC, see the troubleshooting list in [MPC-XL.md](MPC-XL.md).

**Stuck notes.** Press **Panic** (Settings > Audio or MIDI). It stops every note in Orograph
and sends sustain off, all sound off and all notes off to the MIDI output.

**An import did not work.** Use a PNG or JPEG image, or a WAV file, under 25 MB. Very
detailed photos make noisy, harsh land: raise **Smoothing**.

**I lost my patches.** Your own patches and scenes live in the browser's storage for the page
you use. A different browser, a private window, or clearing site data starts empty. Use
**Export** for backups.

**The desktop app will not open the first time.** Orograph is not signed with a paid
certificate, so macOS and Windows ask you to confirm once. The [README](../README.md#download)
explains each system step by step.

---

## 18. Credits and clean-room statement

**Clean room.** Orograph is an independent implementation of wave terrain synthesis, written
from first principles and published mathematics. No code, graphics, sounds or presets from
any other product were used. It was inspired by the idea behind the Conductive Labs Terrain
Synth. Terrain Synth is a trademark of Conductive Labs; Orograph is not affiliated with,
endorsed by, or connected to Conductive Labs. Orograph's terrains, patches, scenes, icons
and diagrams were made for it. The paths are classic mathematical curves, including Johan
Gielis's superformula.

**The idea.** Wave terrain synthesis was described by Rich Gold (the "terrain reader",
1978 to 1979), Yasuhiro Mitsuhashi ("Audio Signal Synthesis by Functions of Two Variables",
1982) and Alberto Borgonovo and Goffredo Haus (1984 and 1986), and later developed by Curtis
Roads, Stuart James and others. The [research brief](RESEARCH.md) lists the sources.

**Built with** [three.js](https://threejs.org) (3D graphics, MIT licence),
[Rapier](https://rapier.rs) (marble physics, Apache 2.0 licence), Web Audio and Web MIDI,
and [Electron](https://www.electronjs.org) for the desktop app. The full list of libraries
and their licences is in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

**Made by** Chase ([Hendrick Research](https://www.hendrickresearch.com)), written with the
help of Claude Code. Orograph is free and open source under the [MIT licence](../LICENSE).
