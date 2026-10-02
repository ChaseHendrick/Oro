# Bugs found in the deep bug hunt

Found with `tests/e2e/app-deep.cjs` (headless Chromium, SwiftShader GL) and by reading the
code paths listed under "Reviewed, no bug found". Only bugs that were reproduced, or verified
by reading the code, are listed.

Run used: `node tests/e2e/app-deep.cjs http://127.0.0.1:5292/` on base `e405c61`
(182 passed, 4 failed). After the fixes below, `ONLY=scenes,persistence,midi` gives
101 passed, 0 failed.

| # | Severity | Bug | Status |
|---|---|---|---|
| 1 | High | Session autosave never runs while any dot moves | Fixed |
| 2 | Medium | A change made just before closing or reloading the page is lost | Fixed |
| 3 | Medium | EXT badge and read-only tempo stay on after an external MIDI clock stops arriving | Fixed |
| 4 | Low | Following external clock drops sequencer steps after a main-thread stall | Fixed |
| 5 | (test) | Scene timing checks counted wall time, not audio time | Test fixed |

## 1. Session autosave never runs while any dot moves (high)

**Reproduced:** `persistence`: "autosave still happens while a dot moves". Tempo set to 101,
then 3 s of dot writes every 50 ms (what Drift does): the saved session still had tempo 97.

**Root cause:** `src/main.js` saved the session with a plain debounce: every store change
cleared the timer and started a new 600 ms one. A moving dot (Roll, Drift, Explore, Tour,
dot-lock glides) writes `parts.N.params.centerX/Y` every 15 to 50 ms, so the timer never
fired. With any moving dot in the session nothing was saved at all, and closing the app lost
everything. First Light, the scene loaded on first launch, has a Drift part (as do Glass
Archipelago and Signal Fault), so a new player's session was never saved.

**Fix:** `src/core/session.js` (`createAutosave`): still saves 600 ms after the last change,
but never leaves a change unsaved for more than 2 s (`SAVE_MAX_WAIT_MS`). `main.js` uses it.

**Regression tests:** `tests/core/session.test.js` ("still saves while a moving dot writes the
store every 50 ms", "never leaves a change unsaved longer than the maximum wait").

## 2. A change made just before closing or reloading is lost (medium)

**Reproduced:** `persistence`: "a change made just before a reload is kept". Tempo set to 133,
reload 80 ms later: the app came back with the previous saved tempo (101).

**Root cause:** the session was only written by the debounce timer; nothing saved pending
changes when the page was hidden or unloaded.

**Fix:** `main.js` calls `autosave.flush()` on `pagehide` and when `visibilitychange` reports
the page hidden. `flush()` writes only when something is unsaved.

**Regression test:** `tests/core/session.test.js` ("flush() saves a change at once").

## 3. EXT badge and read-only tempo stick after the external clock stops (medium)

**Reproduced:** `midi`: "when the clock stops arriving, the EXT badge goes away and the tempo
can be edited again". 1.5 s after MIDI Stop and no more pulses: `externalClock.active` was
false, but the badge was still shown and the tempo field still read-only.

**Root cause:** the top bar (`src/ui/topbar.js`) redraws the badge on the MIDI module's
`clock` events. `src/midi/midi.js` only emitted those on incoming pulses, Start, Continue and
Stop. A clock that simply stops arriving (master switched off or unplugged, or one that stops
sending pulses while stopped) produces no message, so the UI was never told and the tempo
stayed locked until some other MIDI event.

**Fix:** `midi.js` arms a timer on incoming pulses (`watchQuiet`) and emits a `clock` event
once the follower stops counting the clock as active (`CLOCK_ACTIVE_MS`, 500 ms, now exported
from `src/midi/clock.js`). `clock` events now also carry `active`. `createMidi` takes optional
`timers` so tests can drive this.

**Regression tests:** `tests/midi/midi.test.js` ("announces when the clock stops arriving",
"keeps the clock active while pulses keep coming, without an event per pulse").

## 4. Following external clock drops steps after a main-thread stall (low, fixed)

**Seen:** `midi`: "sequencer steps follow the clock" counted 13 step events in 3 s (expected
more than 20) during a run where other test processes were loading the CPU. Run alone, the
same scenario gives 53 to 54 step events, so this is not reproducible on an idle machine.

**Root cause (verified by reading `src/music/transport.js`, `tick()`):** in follow mode the
scheduling horizon is capped at a 16th note past the last received pulse
(`EXT_AHEAD_BEATS`). When the main thread stalls for longer than that plus `LATE_WINDOW`
(40 ms), the pulses queued during the stall arrive in a burst and the steps that fell inside
the stall are skipped as too late. In internal mode the lookahead grows after a stall
(`adaptLookahead`, up to 0.5 s), so later stalls are covered; follow mode has no such margin.

**Fix:** the follow-mode horizon now reaches `max(a 16th, the adaptive lookahead)` past the
last pulse, so after one stall the lookahead grows and later stalls are covered, as in
internal mode. The cost of scheduling further ahead was notes playing after Stop, so Stop
(internal or MIDI) now cancels the sequencer notes queued past the stop time: sequencer
notes carry a `seq` tag to the worklet, and a new `{t:'cancelNotes', after, tag}` message
drops tagged note-ons later than `after` together with their own note-offs. Notes already
sounding keep their note-off; arp, preview and played notes are untouched. Regression tests:
`tests/music/transport.test.js` (follow-mode stall; fails without the fix) and
`tests/dsp/round-d.test.js` (cancelNotes).

**MIDI out:** messages handed to the browser with a future timestamp cannot be recalled, so
scheduled notes for an external device are now held in `src/midi/midi.js` until 150 ms
before they are due (`OUT_HOLD_MS`); Stop drops the held sequencer notes along with the
engine's (router `cancel` event). Normal playback is unchanged, since the usual lookahead
(0.12 s) is inside that window. Test: `tests/midi/midi.test.js`.

## 5. Scene timing checks used wall time (test problem, fixed in the test)

**Seen:** `scenes`: "Paper Maps" counted 14/14/7/27 steps over two bars (expected about
16/16/8/32), and "Glass Archipelago" still had voices 7.5 s after Stop. Both happened only
while other processes loaded the CPU; run alone, both pass. A browser probe of Glass
Archipelago showed balanced note-ons and note-offs and every voice ending within its release
time after Stop.

**Cause:** the checks timed the two bars and the release wait with `performance.now()`, but
the sequencer and the envelopes run on the AudioContext clock, which falls behind wall time
when the audio thread is starved.

**Fix (test only):** `tests/e2e/app-deep.cjs` gained `T.audioSleep()` and an `{ audio: true }`
option for `T.watch()` and `T.waitVoicesZero()`, polled on `context.currentTime` with a wall
time cap; the scenes section uses them. Thresholds are unchanged. The script also takes
`SINGLE_DIR` so parallel runs do not share the single-file build folder.

## Reviewed, no bug found

* **Dot locks while the marble rolls** (`src/music/locks.js`, `src/visual/dot-sim.js`): a
  scratch integration of the dot simulation and the transport's lock player in Roll, Drift,
  Explore and Tour modes showed the dot landing exactly on each lock at the end of its glide,
  and moving on from there. Lock writes (`source: 'lock'`) teleport the marble, simulated
  writes are never treated as user moves, and patch or scene loads cancel glides.
* **Step locks and Dot glide** (`lockGlide`): glide length is `lockGlide` of the step,
  0 jumps; locks on steps past the pattern length never play; clear, shift and randomise
  keep or drop locks as documented.
* **Tour and Explore**: route building, ping-pong and once modes, yielding to outside moves
  and blending back, Explore note spacing and grid snapping.
* **Theme switching**: `index.html` and `src/ui/theme.js` resolve the preference the same way
  (including the hosting site's key); the persistence section's theme checks pass.
* **Preset and scene load with `migrateState`**: values are clamped, unknown keys dropped,
  waypoints and locks survive a round trip; the patches, scenes and persistence sections pass.
* **MIDI clock in and out**: Start, Continue, Song Position, Stop, tempo following and 24 PPQ
  output behave as specified (apart from bugs 3 and 4).
