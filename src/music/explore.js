// Explore mode notes (music.exploreNote): the visuals report every local peak
// or valley the marble rolls over, and this turns them into in-key notes.
//
//   pitch     height -1..1 spread over dot.exploreRange octaves of the global
//             scale, starting from the part's sequencer octave (lower for
//             wider ranges so the middle stays put)
//   velocity  from |height|: high peaks and deep valleys play louder
//   density   dot.exploreRate 0..1 sets the shortest gap between notes, from
//             two beats down to a 16th; extrema arriving faster are dropped
//   timing    while the transport plays, notes snap to the next 16th
//
// Only parts in Explore dot mode with exploreNotes on make sound.

import { NUM_PARTS, SCALES, SCALE_NAMES, DOT_MODES, stepToMidi, clamp } from '../core/params.js';

const SOURCE = 'explore';
export const EXPLORE_MODE = DOT_MODES.indexOf('Explore');
export const GRID = 0.25;              // beats: notes snap to 16ths while the transport runs

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Shortest gap between Explore notes, in beats, for exploreRate 0..1 (2 beats .. a 16th). */
export function exploreGapBeats(rate) {
  return 2 * Math.pow(8, -clamp(num(rate, 0.5), 0, 1));
}

/**
 * The note for a height (-1..1) over `range` octaves. Returns the MIDI note;
 * the lowest note is the key root in octave `baseOctave - floor((range - 1) / 2)`.
 */
export function exploreNoteFor(height, { range = 2, baseOctave = 3, root = 0, scaleType = 1 } = {}) {
  const scale = SCALES[SCALE_NAMES[scaleType]] || SCALES.Minor;
  const r = clamp(Math.round(num(range, 2)), 1, 4);
  const total = r * scale.length;
  const t = (clamp(num(height, 0), -1, 1) + 1) / 2;
  const degree = Math.round(t * total);
  const lowOct = clamp(Math.round(num(baseOctave, 3)) - Math.floor((r - 1) / 2), 0, 7);
  return clamp(stepToMidi({ degree, octave: 0 }, lowOct, root, scaleType), 0, 127);
}

export function createExplorer({ store, router, timebase, transport = null, emit = () => {} }) {
  const last = new Array(NUM_PARTS).fill(-Infinity);

  function partIndex(part) {
    const p = part === 'sel' || part == null ? Math.round(store.get('ui.selectedPart') || 0) : Number(part);
    return Number.isInteger(p) && p >= 0 && p < NUM_PARTS ? p : null;
  }

  function spb() {
    if (transport && typeof transport.spb === 'function') {
      const s = transport.spb();
      if (s > 0) return s;
    }
    return 60 / clamp(num(store.get('global.tempo'), 120), 20, 400);
  }

  /** e = { part, kind: 'peak' | 'valley', height, x, y }. Returns the note played or null. */
  function exploreNote(e = {}) {
    const p = partIndex(e.part);
    if (p == null) return null;
    const dot = store.get(`parts.${p}.dot`) || {};
    if (Math.round(num(dot.mode, 0)) !== EXPLORE_MODE || !dot.exploreNotes) return null;
    const height = num(e.height, NaN);
    if (!Number.isFinite(height)) return null;
    if (!timebase.running()) return null;
    const now = timebase.now();
    const beat = spb();
    const gap = exploreGapBeats(dot.exploreRate) * beat;
    let time = now;
    if (transport && typeof transport.nextGridTime === 'function') {
      const g = transport.nextGridTime(GRID, now + 0.005);
      if (g != null) time = g;
    }
    // A little slack so notes that are exactly one gap apart (snapped to the grid) still pass.
    if (time - last[p] < gap - 0.002) return null;
    last[p] = time;
    const seq = store.get(`parts.${p}.seq`) || {};
    const note = exploreNoteFor(height, {
      range: dot.exploreRange,
      baseOctave: seq.baseOctave,
      root: Math.round(num(store.get('global.scaleRoot'), 0)),
      scaleType: Math.round(num(store.get('global.scaleType'), 1)),
    });
    const vel = clamp(0.3 + 0.7 * Math.abs(height), 0.2, 1);
    // Long enough to sing, short enough to end before the next note can come.
    const length = clamp(gap * 0.85, 0.06, 1.5);
    router._engineOn(p, note, vel, time, SOURCE);
    router._engineOff(p, note, time + length, SOURCE);
    const out = { part: p, note, vel, time, length, kind: e.kind === 'valley' ? 'valley' : 'peak', x: num(e.x, null), y: num(e.y, null) };
    emit(out);
    return out;
  }

  return {
    exploreNote,
    /** Forget the rate limiter (e.g. after a mode change), so the next extremum plays at once. */
    reset(part) { if (part == null) last.fill(-Infinity); else if (part >= 0 && part < NUM_PARTS) last[part] = -Infinity; },
  };
}
