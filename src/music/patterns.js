// Musical pattern tools for the step sequencer: a randomiser that writes
// something you would actually keep, plus clear and rotate.
//
// Patterns are scale degrees, so the generator works in degree space and
// finds the 3rd and 5th inside whatever scale is selected (pentatonic,
// blues and chromatic scales have them at different indices).

import { NUM_PARTS, SEQ_STEPS, SCALES, SCALE_NAMES, defaultStep, clamp } from '../core/params.js';

/** Small deterministic PRNG (mulberry32) so tests and "same seed" are repeatable. */
export function makeRng(seed = 1) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Metric weight of a 16th-note position: downbeat > half bar > beats > 8ths > 16ths. */
export function stepStrength(i) {
  if (i % 16 === 0) return 1;
  if (i % 8 === 0) return 0.85;
  if (i % 4 === 0) return 0.7;
  if (i % 2 === 0) return 0.45;
  return 0.25;
}

/** Indices of the chord tones (root, 3rd, 5th) and the octave size for a scale. */
export function chordDegrees(scaleType) {
  const scale = SCALES[SCALE_NAMES[scaleType]] || SCALES.Minor;
  const find = (...semis) => {
    for (const s of semis) { const i = scale.indexOf(s); if (i >= 0) return i; }
    return Math.min(2, scale.length - 1);
  };
  return { root: 0, third: find(3, 4, 2, 5), fifth: find(7, 6, 8), octave: scale.length };
}

function pickWeighted(rng, entries) {
  let total = 0;
  for (const [, w] of entries) total += w;
  let r = rng() * total;
  for (const [v, w] of entries) { r -= w; if (r <= 0) return v; }
  return entries[entries.length - 1][0];
}

/**
 * Generate a 16-step pattern.
 *   style 'bass': roots and fifths on strong beats, octave pops, short gates.
 *   style 'melody': stepwise motion between chord tones, wider range.
 */
export function generatePattern({ length = 16, density = 0.6, rng = Math.random, style = 'melody', scaleType = 1 } = {}) {
  length = clamp(Math.round(length), 1, SEQ_STEPS);
  density = clamp(Number.isFinite(density) ? density : 0.6, 0, 1);
  const { third, fifth, octave } = chordDegrees(scaleType);
  const bass = style === 'bass';
  const steps = Array.from({ length: SEQ_STEPS }, defaultStep);

  // Rhythm: probability follows metric strength, then guarantee an anchor on 1.
  const on = [];
  for (let i = 0; i < length; i++) {
    const s = stepStrength(i);
    const p = clamp(density * (0.45 + 1.1 * s), 0, 0.97);
    on.push(density > 0 && rng() < p);
  }
  if (density > 0) on[0] = true;
  // Avoid long dead stretches at higher densities: fill the strongest empty beat.
  if (density >= 0.5) {
    for (let i = 4; i < length; i += 4) {
      if (!on[i] && !on[i - 1] && !on[i - 2] && !on[i - 3]) on[i] = true;
    }
  }

  const lo = -2;
  const hi = bass ? octave + fifth : octave + fifth + 1;
  let prev = 0;
  for (let i = 0; i < length; i++) {
    if (!on[i]) continue;
    const s = stepStrength(i);
    let degree;
    if (i === 0) {
      degree = 0;
    } else if (s >= 0.7 || rng() < (bass ? 0.55 : 0.3)) {
      degree = bass
        ? pickWeighted(rng, [[0, 0.5], [fifth, 0.25], [octave, 0.12], [third, 0.08], [fifth - octave, 0.05]])
        : pickWeighted(rng, [[0, 0.32], [fifth, 0.26], [third, 0.24], [octave, 0.1], [third + octave, 0.08]]);
    } else {
      const move = pickWeighted(rng, [[1, 0.3], [-1, 0.32], [2, 0.12], [-2, 0.12], [0, 0.14]]);
      degree = prev + move;
    }
    degree = clamp(degree, lo, hi);
    prev = degree;
    const st = steps[i];
    st.on = 1;
    st.degree = degree;
    st.octave = 0;
    // Occasional octave jump, more idiomatic in bass lines.
    if (rng() < (bass ? 0.1 : 0.05)) st.octave = bass ? 1 : (degree > octave ? -1 : 1);
    st.vel = Math.round(clamp(0.6 + 0.28 * s + (rng() - 0.5) * 0.12, 0.3, 1) * 100) / 100;
    st.gate = Math.round(clamp((bass ? 0.38 : 0.5) + rng() * (bass ? 0.3 : 0.4), 0.1, 1) * 100) / 100;
    st.accent = rng() < (s >= 0.7 ? 0.16 : 0.04) ? 1 : 0;
  }
  // Slides only into a following note, and sparingly.
  for (let i = 0; i < length - 1; i++) {
    if (steps[i].on && steps[i + 1].on && rng() < (bass ? 0.12 : 0.08)) steps[i].slide = 1;
  }
  return steps;
}

function partIndex(store, part) {
  const p = part === 'sel' || part == null ? store.get('ui.selectedPart') || 0 : Number(part);
  return Number.isInteger(p) && p >= 0 && p < NUM_PARTS ? p : null;
}

export function randomizePattern(store, part, { density = 0.6, rng = Math.random } = {}) {
  const p = partIndex(store, part);
  if (p == null) return null;
  const seq = store.get(`parts.${p}.seq`) || {};
  const style = (seq.baseOctave ?? 3) <= 2 ? 'bass' : 'melody';
  const steps = generatePattern({ length: seq.length || 16, density, rng, style, scaleType: store.get('global.scaleType') ?? 1 });
  store.batch(() => {
    store.set(`parts.${p}.seq.steps`, steps, { source: 'music' });
    if (!seq.enabled) store.set(`parts.${p}.seq.enabled`, 1, { source: 'music' });
  });
  return steps;
}

export function clearPattern(store, part) {
  const p = partIndex(store, part);
  if (p == null) return;
  store.set(`parts.${p}.seq.steps`, Array.from({ length: SEQ_STEPS }, defaultStep), { source: 'music' });
}

/** Rotate the active steps (within the pattern length) by one step, wrapping. */
export function shiftPattern(store, part, dir = 1) {
  const p = partIndex(store, part);
  if (p == null) return;
  const seq = store.get(`parts.${p}.seq`);
  if (!seq || !Array.isArray(seq.steps)) return;
  const len = clamp(Math.round(seq.length || 16), 1, SEQ_STEPS);
  const d = dir < 0 ? -1 : 1;
  const steps = seq.steps.map(s => ({ ...s }));
  const head = steps.slice(0, len);
  const rotated = head.map((_, i) => head[((i - d) % len + len) % len]);
  store.set(`parts.${p}.seq.steps`, [...rotated, ...steps.slice(len)], { source: 'music' });
}
