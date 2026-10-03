// Capture (v2.9): turn what was just played on a track into its pattern.
//
// The router keeps a rolling buffer of the notes people play (on-screen and
// computer keys, MIDI, guitar and voice; never the sequencer, the arp, the
// patch preview or a bounce): about the last CAPTURE_BARS bars, keyed by the
// track's id so a reordered track keeps its notes. capturePhrase() turns the
// most recent phrase (back from the last note until a silence of
// PHRASE_GAP_BEATS) into steps:
//   * quantized to the pattern's step rate at the current tempo: on the
//     transport's grid while it plays, otherwise from the phrase's first note;
//   * the last N steps (N = the pattern length) ending at the last note, each
//     at its place in the pattern loop (step = grid position mod N);
//   * melodic tracks: notes become scale degrees in the global key and scale
//     (out-of-scale notes snap to the nearest scale note, the lower one on a
//     tie), velocity, gate from the held length; a note held over following
//     empty steps becomes tied steps, and a note held into a different next
//     note slides into it;
//   * drum kit tracks: note KIT_BASE_NOTE + r goes to lane r (other notes are
//     left out), velocity as the cell value.

import { SEQ_STEPS, SCALES, SCALE_NAMES, clamp } from '../core/params.js';
import { KIT_PADS, KIT_BASE_NOTE } from '../dsp/drum-kit.js';

export const CAPTURE_BARS = 16;
export const CAPTURE_MAX_NOTES = 2048;
/** A silence this long (in beats, two bars) separates one phrase from the next. */
export const PHRASE_GAP_BEATS = 8;
const LEGATO_SLACK = 0.1;   // of a step: a note released this close before the next one still counts as held into it

/** Note sources played by a person (not the sequencer, arp, previews or bounces). */
export function isPersonSource(source) {
  const s = String(source || '');
  return s === 'ui' || s === 'qwerty' || s === 'guitar' || s === 'voice' || s.startsWith('midi');
}

/**
 * The router's rolling buffer. `now()` in seconds (performance clock);
 * `windowSec()` how far back to keep (CAPTURE_BARS bars at the tempo).
 */
export function createCaptureBuffer({ now, windowSec }) {
  let notes = [];
  function prune(t) {
    const w = windowSec();
    let i = 0;
    while (i < notes.length && (notes.length - i > CAPTURE_MAX_NOTES || (notes[i].off ?? t) < t - w)) i++;
    if (i) notes = notes.slice(i);
  }
  return {
    on(track, note, vel) {
      const t = now();
      notes.push({ track, note, vel, on: t, off: null });
      prune(t);
    },
    off(track, note) {
      const t = now();
      for (let i = notes.length - 1; i >= 0; i--) {
        const n = notes[i];
        if (n.track === track && n.note === note && n.off == null) { n.off = t; return; }
      }
    },
    /** Copies of the notes kept for `track` (oldest first); `off` is null while a key is still down. */
    list(track) {
      prune(now());
      return notes.filter(n => n.track === track).map(n => ({ ...n }));
    },
    clear() { notes = []; },
  };
}

/** MIDI note -> { degree, octave, snapped } in the key (root, scale) above base octave `baseOctave` (see stepToMidi). */
export function noteToDegree(note, { root = 0, scaleType = 0, baseOctave = 3 } = {}) {
  const scale = SCALES[SCALE_NAMES[scaleType]] || SCALES.Minor;
  const len = scale.length;
  const rel = note - root - 12 * (baseOctave + 1);
  const oct = Math.floor(rel / 12);
  const pc = rel - 12 * oct;
  // nearest scale note, the lower one on a tie (the octave above counts as degree len)
  let best = 0, bestDist = Infinity;
  for (let i = 0; i <= len; i++) {
    const v = i < len ? scale[i] : 12 + scale[0];
    const dist = Math.abs(v - pc);
    if (dist < bestDist) { best = i; bestDist = dist; }
  }
  let degree = oct * len + best;
  let octave = 0;
  while (degree > 28 && octave < 2) { degree -= len; octave++; }
  while (degree < -21 && octave > -2) { degree += len; octave--; }
  return { degree: clamp(degree, -21, 28), octave, snapped: bestDist > 0 };
}

/**
 * The most recent phrase of `notes` ([{ note, vel, on, off }], seconds) as
 * pattern content. Options: spb (seconds per beat), rateBeats (beats per
 * step), length (N), root, scaleType, baseOctave, drum (a kit track),
 * now (seconds, ends notes still held), beatAt (time -> transport beat, or
 * null when the transport is stopped).
 * Returns { error: 'empty' | 'noPads' } or
 *   { kind: 'notes', steps: (step | null)[N], count, snapped, overlap, older }
 *   { kind: 'drum', lanes: number[KIT_PADS][SEQ_STEPS], count, outside, older }.
 */
export function capturePhrase(notes, { spb = 0.5, rateBeats = 0.25, length = SEQ_STEPS, root = 0, scaleType = 0, baseOctave = 3, drum = false, now = 0, beatAt = null } = {}) {
  const list = (Array.isArray(notes) ? notes : [])
    .filter(n => n && Number.isFinite(n.note) && Number.isFinite(n.on))
    .sort((a, b) => a.on - b.on);
  if (!list.length) return { error: 'empty' };
  const endOf = (n) => (Number.isFinite(n.off) ? n.off : now);
  // the most recent phrase: back from the last note while the silences stay short
  const gap = PHRASE_GAP_BEATS * spb;
  let s = list.length - 1;
  for (let i = s - 1; i >= 0; i--) {
    if (endOf(list[i]) >= list[s].on - gap) s = i; else break;
  }
  const phrase = list.slice(s);
  const N = clamp(Math.round(length) || SEQ_STEPS, 1, SEQ_STEPS);
  const d = rateBeats * spb;
  const t0 = phrase[0].on;
  const pos = typeof beatAt === 'function' ? (t) => beatAt(t) / rateBeats : (t) => (t - t0) / d;
  const items = phrase.map(n => ({ ...n, abs: Math.round(pos(n.on)), dur: Math.max(0, endOf(n) - n.on) / d }));
  const lastAbs = Math.max(...items.map(n => n.abs));
  const from = lastAbs - N + 1;
  const inWin = items.filter(n => n.abs >= from);
  const older = items.length - inWin.length;
  const stepOf = (abs) => ((abs % N) + N) % N;

  if (drum) {
    const lanes = Array.from({ length: KIT_PADS }, () => new Array(SEQ_STEPS).fill(0));
    let count = 0, outside = 0;
    for (const n of inWin) {
      const r = Math.round(n.note) - KIT_BASE_NOTE;
      if (!(r >= 0 && r < KIT_PADS)) { outside++; continue; }
      const c = stepOf(n.abs);
      const v = clamp(Math.round(clamp(n.vel ?? 0.8, 0, 1) * 100) / 100, 0.01, 1);
      if (!lanes[r][c]) count++;
      lanes[r][c] = Math.max(lanes[r][c], v);
    }
    if (!count) return { error: 'noPads', outside };
    return { kind: 'drum', lanes, count, outside, older };
  }

  // one note per step: the loudest (the first played on a tie)
  const byAbs = new Map();
  let overlap = 0;
  for (const n of inWin) {
    const cur = byAbs.get(n.abs);
    if (!cur) { byAbs.set(n.abs, n); continue; }
    overlap++;
    if ((n.vel ?? 0) > (cur.vel ?? 0)) byAbs.set(n.abs, n);
  }
  const kept = [...byAbs.values()].sort((a, b) => a.abs - b.abs);
  const key = { root, scaleType, baseOctave };
  const steps = new Array(N).fill(null);
  let snapped = 0;
  kept.forEach((n, k) => {
    const deg = noteToDegree(Math.round(n.note), key);
    if (deg.snapped) snapped++;
    const vel = clamp(Math.round(clamp(n.vel ?? 0.8, 0, 1) * 100) / 100, 0, 1);
    const next = kept[k + 1];
    // a note held clearly past its step ties over the empty steps after it
    let covered = 1;
    if (n.dur > 1.25) {
      const want = Math.round(n.dur);
      while (covered < want && n.abs + covered <= lastAbs && !(next && n.abs + covered >= next.abs)) covered++;
    }
    for (let j = 0; j < covered; j++) {
      const last = j === covered - 1;
      steps[stepOf(n.abs + j)] = {
        on: 1, degree: deg.degree, octave: deg.octave, vel,
        gate: last ? clamp(Math.round((n.dur - j) * 100) / 100, 0.05, 1) : 1,
        slide: last ? 0 : 1, accent: 0,
      };
    }
    // held into a different next note on the following step: slide (legato)
    const lastStep = n.abs + covered - 1;
    if (next && next.abs === lastStep + 1 && Math.round(next.note) !== Math.round(n.note) && endOf(n) >= next.on - LEGATO_SLACK * d) {
      steps[stepOf(lastStep)].slide = 1;
    }
  });
  return { kind: 'notes', steps, count: kept.length, snapped, overlap, older };
}
