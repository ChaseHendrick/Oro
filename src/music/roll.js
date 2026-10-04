// Piano roll notes on the existing step pattern.
// The first note of a step is the step itself (what the grid Note cell shows).
// Further notes on that step are `extras`. A start quarter `q` of 1, 2 or 3
// delays the note by that many quarter-steps. Both are omitted when unused
// so an old pattern stays the same object shape.

import { SCALES, SCALE_NAMES, clamp, PLOCK_IDS } from '../core/params.js';

export const QUARTER = 4;
export const MAX_EXTRAS = 8;

/** Audio time of quarter `q` (0..3) inside a step that runs from `t` to `tNext`. */
export function quarterTime(t, tNext, q) {
  const k = clamp(Math.round(q) || 0, 0, 3);
  return t + (tNext - t) * k / QUARTER;
}

/**
 * MIDI note to a sequencer degree and octave, or null when the note is not
 * in the scale (the grid only stores scale degrees). Prefers octave 0.
 */
export function midiToDegree(midi, baseOctave, root, scaleType) {
  const scale = SCALES[SCALE_NAMES[scaleType]] || SCALES.Minor;
  const len = scale.length;
  const n = Math.round(Number(midi));
  if (!(n >= 0 && n <= 127)) return null;
  const pc = ((n - root) % 12 + 12) % 12;
  const idx = scale.indexOf(pc);
  if (idx < 0) return null;
  const semis = n - root - scale[idx];
  if (semis % 12 !== 0) return null;
  const midiOct = semis / 12;
  const base = Math.round(Number(baseOctave) || 0);
  let best = null;
  for (let octave = -2; octave <= 2; octave++) {
    const floorPart = midiOct - (base + 1 + octave);
    if (!Number.isInteger(floorPart)) continue;
    const degree = floorPart * len + idx;
    if (degree < -21 || degree > 28) continue;
    const score = Math.abs(octave) * 100 + Math.abs(degree);
    if (!best || score < best.score) best = { degree, octave, score };
  }
  return best ? { degree: best.degree, octave: best.octave } : null;
}

function samePitch(a, b) {
  return Math.round(a.degree) === Math.round(b.degree) && Math.round(a.octave || 0) === Math.round(b.octave || 0);
}

function cleanNote(n) {
  const q = Math.round(n.q) || 0;
  const out = {
    degree: clamp(Math.round(Number(n.degree) || 0), -21, 28),
    octave: clamp(Math.round(Number(n.octave) || 0), -2, 2),
    vel: clamp(typeof n.vel === 'number' && Number.isFinite(n.vel) ? n.vel : 0.8, 0, 1),
    gate: clamp(typeof n.gate === 'number' && Number.isFinite(n.gate) ? n.gate : 0.5, 0.05, 1),
  };
  if (q >= 1 && q <= 3) out.q = q;
  return out;
}

/** Notes on a step: the grid note first (if it is on), then extras. An off step is silent, so nothing is drawn. */
export function notesOf(step) {
  const out = [];
  if (!step || !step.on) return out;
  out.push({ ...cleanNote(step), first: true });
  const extras = step && Array.isArray(step.extras) ? step.extras : [];
  for (const ex of extras) out.push({ ...cleanNote(ex), first: false });
  return out;
}

/**
 * Paint one note. The first note (step off, or the same pitch as the step)
 * writes on, degree, octave, vel and gate. A different pitch is an extra and
 * does not change the step's degree, so the grid Note cell keeps the first.
 */
export function paintNote(step, note) {
  const cur = step && typeof step === 'object' ? { ...step } : {};
  const painted = cleanNote(note);
  const extras = Array.isArray(cur.extras) ? cur.extras.map((e) => ({ ...e })) : [];
  const firstOff = !cur.on;
  if (firstOff || samePitch(cur, painted)) {
    const next = { ...cur, on: 1, degree: painted.degree, octave: painted.octave, vel: painted.vel, gate: painted.gate };
    if (painted.q) next.q = painted.q;
    else delete next.q;
    if (extras.length) next.extras = extras;
    else delete next.extras;
    return next;
  }
  const i = extras.findIndex((e) => samePitch(e, painted));
  const extra = { degree: painted.degree, octave: painted.octave, vel: painted.vel, gate: painted.gate };
  if (painted.q) extra.q = painted.q;
  if (i >= 0) extras[i] = extra;
  else if (extras.length < MAX_EXTRAS) extras.push(extra);
  const next = { ...cur };
  if (extras.length) next.extras = extras;
  return next;
}

/** Remove the note with this degree and octave. Deleting the first promotes an extra. */
export function eraseNote(step, note) {
  const cur = step && typeof step === 'object' ? { ...step } : {};
  const extras = Array.isArray(cur.extras) ? cur.extras.map((e) => ({ ...e })) : [];
  const target = { degree: note.degree, octave: note.octave || 0 };
  if (cur.on && samePitch(cur, target)) {
    if (!extras.length) {
      const next = { ...cur, on: 0 };
      delete next.q;
      delete next.extras;
      return next;
    }
    const [head, ...rest] = extras;
    const promoted = cleanNote(head);
    const next = { ...cur, on: 1, degree: promoted.degree, octave: promoted.octave, vel: promoted.vel, gate: promoted.gate };
    if (promoted.q) next.q = promoted.q;
    else delete next.q;
    if (rest.length) next.extras = rest;
    else delete next.extras;
    return next;
  }
  const filtered = extras.filter((e) => !samePitch(e, target));
  const next = { ...cur };
  if (filtered.length) next.extras = filtered;
  else delete next.extras;
  return next;
}

/** Lane curve sample at a quarter, or null. Values are 0..1. */
export function laneAt(lane, stepIndex, q, length) {
  if (!lane || !Array.isArray(lane.curve)) return null;
  const len = clamp(Math.round(length) || 16, 1, 16);
  if (stepIndex < 0 || stepIndex >= len) return null;
  const u = lane.curve[stepIndex * 4 + clamp(Math.round(q) || 0, 0, 3)];
  return typeof u === 'number' && Number.isFinite(u) ? clamp(u, 0, 1) : null;
}

export function lanePointCount(length) {
  return clamp(Math.round(length) || 16, 1, 16) * 4;
}

export function isLaneId(id) {
  return PLOCK_IDS.includes(id);
}
