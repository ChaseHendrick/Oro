// Audition phrases for the patch preview (music.preview, key P).
//
// Each category has a few short, original phrases written in scale degrees of
// a 7-note scale (0 = key root, 7 = the root an octave up, negatives go
// below), so they follow the global key. Scales with fewer or more notes are
// handled by adaptDegree(), which keeps chord tones on chord tones instead of
// squashing the phrase index by index.
//
// A note is [beat, degree | [degrees], lengthBeats, velocity]. Beats are
// quarter notes from the start of the phrase.

import { SCALES, SCALE_NAMES, stepToMidi, clamp } from '../core/params.js';

const ROLL = (from, degrees, len, vel, step = 0.25) => degrees.map((d, i) => [from + i * step, d, len, vel]);

export const PHRASES = {
  Bass: {
    baseOctave: 2,
    list: [
      { name: 'Pocket', notes: [
        [0, 0, 0.7, 0.95], [0.75, 0, 0.2, 0.55], [1, 7, 0.35, 0.8], [1.5, 4, 0.4, 0.7],
        [2, 0, 0.45, 0.9], [2.75, 2, 0.2, 0.6], [3, 3, 0.45, 0.75], [3.5, 4, 0.4, 0.8],
        [4, -2, 0.7, 0.95], [4.75, -2, 0.2, 0.55], [5, 5, 0.35, 0.8], [5.5, 2, 0.4, 0.7],
        [6, -1, 0.45, 0.85], [6.5, 1, 0.4, 0.7], [7, 4, 0.4, 0.75], [7.5, -3, 0.4, 0.8],
      ] },
      { name: 'Stepping', notes: [
        [0, 0, 0.85, 0.9], [1, 2, 0.85, 0.75], [2, 4, 0.85, 0.8], [3, 5, 0.85, 0.75],
        [4, 7, 0.85, 0.9], [5, 5, 0.85, 0.75], [6, 4, 0.85, 0.8], [7, 1, 0.85, 0.75],
      ] },
      { name: 'Octave Pump', notes: ROLL(0, [0, 7, 0, 7, 0, 7, 4, 6, -2, 5, -2, 5, -3, 4, -3, -1], 0.35, 0.8, 0.5) },
    ],
  },
  Lead: {
    baseOctave: 4,
    list: [
      { name: 'Call', notes: [
        [0, 4, 0.45, 0.8], [0.5, 5, 0.45, 0.75], [1, 7, 1.4, 0.9], [2.5, 6, 0.45, 0.7], [3, 4, 0.9, 0.8],
        [4, 2, 0.45, 0.75], [4.5, 4, 0.45, 0.75], [5, 1, 1.4, 0.85], [6.5, 2, 0.45, 0.7], [7, 0, 0.95, 0.8],
      ] },
      { name: 'Climb', notes: [
        ...ROLL(0, [0, 2, 4], 0.2, 0.7), [0.75, 7, 1.2, 0.95], [2, 6, 0.45, 0.75], [2.5, 7, 0.45, 0.8], [3, 9, 0.9, 0.9],
        [4, 8, 0.45, 0.75], [4.5, 7, 0.45, 0.75], [5, 4, 0.9, 0.8], [6, 5, 0.45, 0.75], [6.5, 4, 0.45, 0.7], [7, 2, 0.95, 0.8],
      ] },
      // Overlapping notes: legato patches glide between them.
      { name: 'Glide', notes: [
        [0, 7, 1.6, 0.85], [1.5, 9, 1.1, 0.8], [2.5, 8, 0.6, 0.75], [3, 7, 2.6, 0.85], [5.5, 4, 0.6, 0.75], [6, 5, 1.9, 0.8],
      ] },
    ],
  },
  Pad: {
    baseOctave: 3,
    list: [
      { name: 'Drift', notes: [[0, [0, 4, 9], 3.8, 0.7], [4, [-2, 2, 7], 3.8, 0.7]] },
      { name: 'Suspend', notes: [[0, [0, 3, 7], 1.9, 0.65], [2, [0, 2, 7], 1.9, 0.7], [4, [-4, 0, 5], 3.8, 0.7]] },
      { name: 'Wide', notes: [[0, [0, 4], 7.8, 0.7], [0, 9, 3.8, 0.6], [4, 8, 3.8, 0.6]] },
    ],
  },
  Keys: {
    baseOctave: 3,
    list: [
      { name: 'Comp', notes: [
        [0, [0, 2, 4, 7], 0.9, 0.8], [1.5, [0, 2, 4, 7], 0.4, 0.6], [2, [-2, 0, 2, 5], 0.9, 0.75], [3.5, [-1, 1, 4], 0.4, 0.6],
        [4, [-3, 1, 4, 6], 1.8, 0.75], [6, [0, 2, 4, 7], 1.9, 0.8],
      ] },
      { name: 'Song', notes: [
        [0, [0, 4], 3.8, 0.6], [0, 9, 0.9, 0.8], [1, 8, 0.4, 0.7], [1.5, 7, 0.4, 0.7], [2, 6, 0.9, 0.75], [3, 4, 0.9, 0.75],
        [4, [-2, 2], 3.8, 0.6], [4, 7, 1.4, 0.8], [5.5, 9, 0.4, 0.7], [6, 7, 1.9, 0.8],
      ] },
    ],
  },
  Pluck: {
    baseOctave: 4,
    list: [
      { name: 'Ripple', notes: [
        ...ROLL(0, [0, 2, 4, 7, 4, 2, 0, 2, 4, 7, 9, 7, 4, 2, 4, 7], 0.2, 0.75),
        ...ROLL(4, [-2, 0, 2, 5, 2, 0, -2, 0, 2, 5, 7, 5, 2, 0, 2, 5], 0.2, 0.75),
      ] },
      { name: 'Pizz', notes: [
        [0, 0, 0.3, 0.85], [1, 4, 0.3, 0.7], [1.5, 2, 0.3, 0.7], [2, 7, 0.3, 0.8], [3, 4, 0.3, 0.7], [3.5, 9, 0.3, 0.75],
        [4, 8, 0.3, 0.8], [5, 4, 0.3, 0.7], [5.5, 2, 0.3, 0.7], [6, 5, 0.3, 0.75], [7, 4, 0.6, 0.8],
      ] },
    ],
  },
  Bell: {
    baseOctave: 4,
    list: [
      { name: 'Chime', notes: [[0, 7, 1.4, 0.8], [1.5, 4, 1.4, 0.7], [3, 9, 2.8, 0.75], [6, 2, 1.9, 0.65]] },
      { name: 'Peal', notes: [[0, [0, 7], 2.8, 0.75], [1, 4, 1.8, 0.6], [3, 11, 2.4, 0.7], [4.5, 9, 1.4, 0.6], [6, 7, 1.9, 0.7]] },
    ],
  },
  Texture: {
    baseOctave: 3,
    list: [
      { name: 'Haze', notes: [[0, 0, 5.5, 0.7], [2, 4, 5.5, 0.65], [4, 9, 3.8, 0.6]] },
      { name: 'Glint', notes: [[0, [0, 7], 7.8, 0.65], [1, 11, 2.5, 0.5], [4, 9, 3.8, 0.55]] },
    ],
  },
  Drone: {
    baseOctave: 2,
    list: [
      { name: 'Ground', notes: [[0, [0, 4], 7.8, 0.75]] },
      { name: 'Fifths', notes: [[0, 0, 7.8, 0.75], [2, [4, 7], 5.8, 0.6]] },
    ],
  },
  FX: {
    baseOctave: 4,
    list: [
      { name: 'Hits', notes: [[0, 7, 0.9, 0.9], [1.5, 0, 0.4, 0.7], [2, 4, 1.9, 0.8]] },
      { name: 'Echo', notes: [[0, 0, 0.2, 0.9], [0.75, 7, 0.2, 0.7], [1.5, 4, 0.2, 0.6], [3, 9, 0.9, 0.8]] },
    ],
  },
  Arp: {
    baseOctave: 4,
    list: [
      { name: 'Climber', notes: [
        ...ROLL(0, [0, 2, 4, 7, 9, 7, 4, 2, 0, 2, 4, 7, 11, 9, 7, 4], 0.2, 0.75),
        ...ROLL(4, [-2, 0, 2, 5, 7, 5, 2, 0, -2, 0, 2, 5, 9, 7, 5, 2], 0.2, 0.75),
      ] },
      { name: 'Bouncer', notes: [
        ...ROLL(0, [0, 7, 4, 7, 0, 7, 4, 9, 0, 7, 4, 7, 2, 9, 4, 11], 0.2, 0.75),
        ...ROLL(4, [-2, 5, 2, 5, -2, 5, 2, 7, -1, 6, 4, 6, 1, 8, 4, 9], 0.2, 0.75),
      ] },
    ],
  },
};

export const PHRASE_CATEGORIES = Object.keys(PHRASES);

const MAJOR_REF = [0, 2, 4, 5, 7, 9, 11];
const MINOR_REF = [0, 2, 3, 5, 7, 8, 10];
const degreeMaps = new Map();

/**
 * Index map from 7-note degrees to the degrees of `scaleType`. Each degree of
 * a major (or, when the scale has no major third, minor) reference scale goes
 * to the nearest note of the target scale, so a triad stays a triad in a
 * pentatonic or blues scale.
 */
function degreeMap(scaleType) {
  if (degreeMaps.has(scaleType)) return degreeMaps.get(scaleType);
  const scale = SCALES[SCALE_NAMES[scaleType]] || SCALES.Minor;
  let map = null;
  if (scale.length !== 7) {
    const ref = scale.includes(4) && !scale.includes(3) ? MAJOR_REF : scale.length === 12 ? MAJOR_REF : MINOR_REF;
    map = ref.map((semi) => {
      let best = 0, dist = Infinity;
      scale.forEach((s, i) => { const d = Math.abs(s - semi); if (d < dist) { dist = d; best = i; } });
      return best;
    });
  }
  degreeMaps.set(scaleType, map);
  return map;
}

/** A 7-note-scale degree expressed in the degrees of `scaleType`. */
export function adaptDegree(degree, scaleType) {
  const map = degreeMap(scaleType);
  if (!map) return degree;
  const len = (SCALES[SCALE_NAMES[scaleType]] || SCALES.Minor).length;
  const oct = Math.floor(degree / 7);
  const idx = ((degree % 7) + 7) % 7;
  return oct * len + map[idx];
}

/** MIDI note for a phrase degree in the given key. */
export function phraseNote(degree, baseOctave, root, scaleType) {
  return stepToMidi({ degree: adaptDegree(degree, scaleType), octave: 0 }, baseOctave, root, scaleType);
}

/**
 * Guess a category from the sound itself, for random and imported patches
 * whose category is not one of the factory ones.
 */
export function guessCategory(params = {}, seq = {}) {
  const n = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const attack = n(params.attack, 0.005);
  const decay = n(params.decay, 0.35);
  const sustain = n(params.sustain, 0.75);
  const mono = n(params.polyMode, 0) > 0;
  if (attack >= 0.4) return 'Pad';
  if (sustain <= 0.05 && decay >= 1.5) return 'Bell';
  if (sustain <= 0.12) return 'Pluck';
  if (mono && (n(params.octave, 0) < 0 || n(params.cutoff, 9000) < 1500 || n(seq.baseOctave, 3) <= 2)) return 'Bass';
  if (mono) return 'Lead';
  return 'Keys';
}

/**
 * The notes of one phrase as [{ beat, end, note, vel }], resolved in the key,
 * sorted, with doubled notes merged and re-struck notes shortened so the
 * same key never overlaps itself (that would steal or hang a voice).
 */
export function phraseEvents(phrase, { baseOctave = 3, root = 0, scaleType = 1 } = {}) {
  const out = [];
  for (const [beat, deg, len, vel] of phrase.notes) {
    for (const d of Array.isArray(deg) ? deg : [deg]) {
      const note = phraseNote(d, baseOctave, root, scaleType);
      if (note < 0 || note > 127) continue;
      out.push({ beat, end: beat + Math.max(0.05, len), note, vel: clamp(vel, 0.05, 1) });
    }
  }
  out.sort((a, b) => a.beat - b.beat || a.note - b.note);
  const kept = [];
  const last = new Map();
  for (const e of out) {
    const prev = last.get(e.note);
    if (prev && Math.abs(prev.beat - e.beat) < 1e-9) { prev.end = Math.max(prev.end, e.end); prev.vel = Math.max(prev.vel, e.vel); continue; }
    if (prev && prev.end > e.beat - 0.02) prev.end = Math.max(prev.beat + 0.05, e.beat - 0.02);
    kept.push(e);
    last.set(e.note, e);
  }
  return kept;
}

export function phraseLength(phrase) {
  let end = 0;
  for (const [beat, , len] of phrase.notes) end = Math.max(end, beat + len);
  return end;
}
