# A land-first layout for Oro (research only)

Written 2026-10-04. This is not a design to build yet. The current layout stays.
Do not copy another instrument's panel, and do not arrange Oro like a hardware
mixer beside a small screen. Oro is a screen instrument. The land is the control.

## What is on screen today

Desktop, from [src/styles/layout.css](../src/styles/layout.css):

| Region | Role |
|---|---|
| Top bar | Tracks, patch, play, tempo, record, loop, bounce, undo, settings |
| Stage | The 3D land, the path, and the dot. This is the instrument. |
| Map column | Terrain A/B, morph, path shape, and the path knobs for the selected track |
| Dock | Sound, Mod, Seq, Mix, Loop, in a strip about 236 to 330 px tall |
| Keys | The on-screen keyboard |

Narrow windows already stack these and show one at a time (Map, Sound, Mod, Seq, Mix, Keys).
The map column can collapse. The dock fades its bottom edge when a tab is taller than the strip.

Two names collide. The guide says "click the map" and means the stage. The right-hand
column is also titled Map. A new player can click the column of knobs and wonder why the dot did not move.

The Sound tab does not repeat the land. It is the voice, filter, sampler, and envelopes.
The Mod tab is the routings. Seq is the grid, the piano roll, and the chain. So the
dock is not a duplicate of the map. It is five different jobs forced into one short strip.
On a laptop the strip is 236 px, and Sound, Seq, and Mix all scroll. The land, which is
the reason to open Oro, is whatever space is left.

## What other people learned (and what not to take)

Wave-terrain work that is public, not a product to imitate:

* A student instrument at Aalborg (Mitsuhashi-style terrain, MPE controller) kept the
  interface small on purpose. The 3D land was the control. Extra knobs were few and
  high level, because the terrain already makes the timbre complicated. Their note was
  that a wall of ambiguous controls fights the picture.
* Browser demos of the same idea (a height map, a closed path, a dot) put the picture
  in the middle and leave parameters in a side list. People come for the picture.

General synth-UI practice, stated as principles rather than a layout to copy:

* Group by the signal, not by an alphabetical list of parameters. Oro already does
  this in pieces: land and path in the column, voice and filter in Sound, routings in Mod.
* Show a control when that part of the sound is on. A vocoder, a sampler, or a second
  filter that is off should not take a permanent seat.
* Performance and sound design are different visits. One wants tracks, play, and the
  land. The other wants every knob. Vital-style products switch the main view
  (voice, effects, matrix) instead of showing all of them at once. The lesson is the
  switch, not their panes.
* Draw modulation on the control it moves. A routing list is the index. It should
  not be the only way to see that the envelope opens the filter.

Hardware wave-terrain panels put encoders around a display. That is a physical
instrument. Copying it onto a monitor wastes the display and is the wrong model for Oro.

## A layout that stays Oro

Four modes, one land. The land never leaves. The chrome around it changes.

**Play.** Default after Start. The stage fills the window. A thin bar keeps tracks,
play, tempo, and record. Four macros and the track level sit on the land as a small
glass card, because those are the knobs a player actually turns. The keyboard can
hide. The map column and the dock are closed.

**Shape.** Opens a sheet from the bottom, one chapter at a time: Land, Path, Voice,
Filter, Space. Land is today's map column (terrains, morph, the path picture).
Voice and Filter are today's Sound tab. Space is the send to delay and reverb, which
is currently buried in Mix. Chapters that are off (sampler, vocoder, resonator) are
a line, not a block of knobs. The 16-step grid is not in this sheet.

**Move.** Drag a source (envelope, LFO, key, the other dot, voice level) onto a knob
or onto the land. A line shows the link on that control. The Mod list stays, as the
index of every link, including ones whose knob is not on screen.

**Time.** A strip of steps under the land, not a second application. The piano roll
opens over the stage, translucent, so the land is still there. Loop and mix are
drawers. The pattern chain stays the song. No arranger.

What this keeps, because it is already Oro and not a borrowed panel:

* Several colored paths on one shared land.
* The dot is dragged on the land, not on a thumbnail.
* The grid stays the place for probability, ratchet, accent, slide, and locks.
* The piano roll does not replace the grid.

## What to measure before building it

Do not replace the dock in one release. The first experiment is a Play switch that
hides the dock and the map column and remembers that choice. Then watch:

* Can a new player move the dot without opening a panel?
* How long to change the terrain, compared with the column that is always open?
* How long to find filter cutoff?
* Does the keyboard stay reachable when the dock is hidden?

If Play is slower for sound design, Shape has to open on the chapter the player
last used, not always on Land.

## What not to do

* Do not build this file. It is notes.
* Do not rename the Map column until the guide, the tips, and the collapse button
  change together. Today "map" means both the stage and the column.
* Do not add a second piano roll, a clip launcher, or a hardware-style encoder ring.
* Do not hide the step grid behind the roll. Step locks still live on the grid.
