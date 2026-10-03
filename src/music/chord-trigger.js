// v2.8 Chord trigger: each key a track receives plays a whole chord built on
// it. The chord is a preset (Triad, 7th, Sus2, Sus4, Power, Octaves) or one
// learned from held keys, either moved up and down as it is (chromatic) or
// kept in the global key and scale (In key: built from scale steps, so in
// C major a D plays D minor and a G plays G major).
//
// Saved per track as parts.N.chord = { on, preset, inKey, notes } (absent =
// off; notes = the learned chord as semitones above its lowest note). The
// note router (src/music/router.js) applies it to the sequencer, to keys
// going into the arpeggiator, the on-screen and computer keyboard and MIDI.

import { SCALES, SCALE_NAMES, clamp } from '../core/params.js';

/**
 * Presets: `semis` above the played note when chromatic; `steps` (scale
 * steps above it) and `octave` (an extra note 12 semitones up) when In key.
 */
export const CHORD_PRESETS = Object.freeze([
  { id: 'triad', name: 'Triad', semis: [0, 4, 7], steps: [0, 2, 4] },
  { id: 'seventh', name: '7th', semis: [0, 4, 7, 10], steps: [0, 2, 4, 6] },
  { id: 'sus2', name: 'Sus2', semis: [0, 2, 7], steps: [0, 1, 4] },
  { id: 'sus4', name: 'Sus4', semis: [0, 5, 7], steps: [0, 3, 4] },
  { id: 'power', name: 'Power', semis: [0, 7, 12], steps: [0, 4], octave: true },
  { id: 'octaves', name: 'Octaves', semis: [0, 12], steps: [0], octave: true },
].map(p => Object.freeze(p)));
/** Preset index that plays the learned chord. */
export const CHORD_LEARNED = CHORD_PRESETS.length;
export const CHORD_PRESET_NAMES = Object.freeze([...CHORD_PRESETS.map(p => p.name), 'Learned']);
export const MAX_CHORD_NOTES = 8;
/** A learned chord spans at most this many semitones. */
export const MAX_CHORD_SPAN = 36;

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function defaultChord() {
  return { on: 0, preset: 0, inKey: 0, notes: [0, 4, 7] };
}

/** A saved chord trigger setting made safe (missing or broken = off). */
export function sanitizeChord(src) {
  const d = defaultChord();
  if (!src || typeof src !== 'object') return d;
  let notes = Array.isArray(src.notes) ? src.notes.map(n => Math.round(num(n, NaN))).filter(n => Number.isFinite(n) && n >= 0 && n <= MAX_CHORD_SPAN) : [];
  notes = [...new Set(notes)].sort((a, b) => a - b).slice(0, MAX_CHORD_NOTES);
  if (!notes.length || notes[0] !== 0) notes = notes.length ? [0, ...notes.filter(n => n !== 0)].slice(0, MAX_CHORD_NOTES) : d.notes.slice();
  return {
    on: num(src.on, 0) ? 1 : 0,
    preset: Math.round(clamp(num(src.preset, 0), 0, CHORD_LEARNED)),
    inKey: num(src.inKey, 0) ? 1 : 0,
    notes,
  };
}

/** Learn a chord from held MIDI notes: semitones above the lowest (null for none). */
export function learnChord(held) {
  const list = [...new Set((held || []).map(n => Math.round(Number(n))).filter(n => Number.isFinite(n) && n >= 0 && n <= 127))].sort((a, b) => a - b);
  if (!list.length) return null;
  const notes = list.map(n => n - list[0]).filter(n => n <= MAX_CHORD_SPAN).slice(0, MAX_CHORD_NOTES);
  return notes;
}

/**
 * Position of MIDI note n in the scale (root, scale): k = index of the
 * highest scale note at or below n (counted across octaves), r = semitones
 * above that scale note (0 when n is in the scale).
 */
function scalePos(n, root, scale) {
  const len = scale.length;
  const rel = n - root;
  const oct = Math.floor(rel / 12);
  const pc = rel - oct * 12;
  let i = len - 1;
  while (i > 0 && scale[i] > pc) i--;
  return { k: oct * len + i, r: pc - scale[i] };
}

function scaleNote(k, root, scale) {
  const len = scale.length;
  const oct = Math.floor(k / len);
  return root + oct * 12 + scale[k - oct * len];
}

/**
 * The notes key `note` plays with `chord` (sanitized). In key, the chord is
 * built from scale steps above the played note (a note outside the scale
 * keeps its offset from the scale note below it). Notes outside 0..127 are
 * dropped; the played note always comes first.
 */
export function chordNotes(note, chord, { root = 0, scaleType = 0 } = {}) {
  const c = chord;
  const out = [];
  const push = (n) => { if (n >= 0 && n <= 127 && !out.includes(n)) out.push(n); };
  const learned = c.preset >= CHORD_LEARNED;
  const preset = learned ? null : CHORD_PRESETS[c.preset] || CHORD_PRESETS[0];
  if (!c.inKey) {
    for (const s of learned ? c.notes : preset.semis) push(note + s);
    return out;
  }
  const scale = SCALES[SCALE_NAMES[Math.round(num(scaleType, 0))]] || SCALES.Major;
  const rt = ((Math.round(num(root, 0)) % 12) + 12) % 12;
  const at = scalePos(note, rt, scale);
  if (learned) {
    // the learned shape moved by scale steps: each learned note keeps its
    // place in the scale relative to the learned lowest note (taken as a scale note)
    const base = scalePos(60, 0, SCALES.Major);
    for (const s of c.notes) {
      const p = scalePos(60 + s, 0, SCALES.Major);
      push(scaleNote(at.k + (p.k - base.k), rt, scale) + at.r + p.r);
    }
    return out;
  }
  for (const st of preset.steps) push(scaleNote(at.k + st, rt, scale) + at.r);
  if (preset.octave) push(note + 12);
  return out;
}
