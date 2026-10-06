// The touch tool (2.17): what a press or a drag on the map does when the
// touch mode is not Move. The visuals report touches ({ phase, mode, part,
// u, v, height, x, y }, see visuals.js); this turns them into sound.
//
//   Strum  drag across the land and it plays in-key notes on the selected
//          track: higher ground plays higher notes (the height is spread over
//          three octaves of the key), every new note as the finger crosses a
//          contour, louder the faster you drag. On a drum kit the height picks
//          the pad.
//   FX     hold and drag: left and right sweep the filter, up opens the
//          resonance and throws echo and reverb, down drives it harder, and
//          high ground folds the wave. Let go and everything glides back
//          (the rig runs in the engine, src/dsp/touch-sources.js, so nothing
//          is written to the session).
//
// Both modes also move the four Touch Link sources (Touch X, Y, Height and
// Down), so any control can follow the finger.

import { exploreNoteFor } from './explore.js';
import { activeSeq, clamp } from '../core/params.js';
import { KIT_BASE_NOTE, KIT_PADS } from '../dsp/drum-kit.js';

export const STRUM_GAP_MS = 35;        // fastest note rate while strumming
export const STRUM_NOTE_S = 0.4;       // how long a strummed note is held
export const STRUM_RANGE = 3;          // octaves the land's height spans

/** The note a height plays on a track (in key; a kit pad on a drum track). */
export function strumNote(store, part, height) {
  const p = store.get(`parts.${part}`) || {};
  if (p.drum && p.drum.on) return KIT_BASE_NOTE + clamp(Math.round(((clamp(height, -1, 1) + 1) / 2) * (KIT_PADS - 1)), 0, KIT_PADS - 1);
  const seq = activeSeq(p) || {};
  return exploreNoteFor(height, {
    range: STRUM_RANGE,
    baseOctave: Math.round(Number(seq.baseOctave ?? 3)),
    root: Math.round(Number(store.get('global.scaleRoot')) || 0),
    scaleType: Math.round(Number(store.get('global.scaleType')) || 0),
  });
}

export function createTouchTool({ store, engine = null, router = null, timers = globalThis, now = () => performance.now() }) {
  let last = null;        // { note, at, x, y, time }
  const held = new Set(); // `${part}:${note}` waiting for their note-off

  function noteOn(part, note, vel) {
    if (!router) return;
    const key = `${part}:${note}`;
    if (held.has(key)) { try { router.noteOff(part, note); } catch { /* gone */ } }
    held.add(key);
    try { router.noteOn(part, note, vel); } catch { return; }
    timers.setTimeout(() => {
      if (!held.delete(key)) return;
      try { router.noteOff(part, note); } catch { /* gone */ }
    }, STRUM_NOTE_S * 1000);
  }

  /** Handle one touch event from the visuals. Returns what it did. */
  function handle(ev) {
    if (!ev || typeof ev !== 'object') return null;
    const part = Number.isInteger(ev.part) ? ev.part : Math.round(Number(store.get('ui.selectedPart')) || 0);
    const down = ev.phase === 'up' ? 0 : 1;
    const fx = ev.mode === 'fx';
    if (engine && typeof engine.touchMap === 'function') engine.touchMap(part, ev.x, ev.y, ev.height, down, fx);
    if (ev.mode !== 'strum') { if (ev.phase === 'up') last = null; return { mode: ev.mode, down }; }
    if (ev.phase === 'up') { last = null; return { mode: 'strum', down: 0 }; }
    const t = Number.isFinite(ev.time) ? ev.time : now();
    const note = strumNote(store, part, ev.height);
    // speed across the screen sets the velocity
    let vel = 0.7;
    if (last && t > last.time) {
      const d = Math.hypot(ev.x - last.x, ev.y - last.y) / ((t - last.time) / 1000);
      vel = clamp(0.45 + d * 0.12, 0.45, 1);
    }
    const fresh = !last || ev.phase === 'down';
    if (fresh || (note !== last.note && t - last.at >= STRUM_GAP_MS)) {
      noteOn(part, note, vel);
      last = { note, at: t, x: ev.x, y: ev.y, time: t };
      return { mode: 'strum', note, vel };
    }
    last.x = ev.x; last.y = ev.y; last.time = t;
    return { mode: 'strum', note: null };
  }

  return {
    handle,
    dispose() {
      for (const key of held) { const [p, n] = key.split(':').map(Number); try { router && router.noteOff(p, n); } catch { /* gone */ } }
      held.clear();
    },
  };
}
