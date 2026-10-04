// Listen-only pitch tuner. Pure: no DOM, no Web Audio, no graph writes.
//
// Pitch comes from a short cumulative mean normalized difference (the YIN
// idea, written from scratch for this file):
//   d(tau) = sum_j (x[j] - x[j + tau])^2 over a fixed window
//   cmnd(tau) = d(tau) / mean(d(1)..d(tau))
// The first valley under a small threshold is the period. Parabolic
// interpolation refines it. If twice that lag explains the wave clearly
// better, the first hit was a harmonic and the longer lag is kept, so a
// saw stays on its fundamental instead of jumping an octave.
//
// A reported note has confidence >= CLEAR_CONFIDENCE. Confidence is
// 1 - cmnd at the chosen lag (1 is a perfect repeat, 0 is not periodic).
// Silence, or a peak under SILENCE_PEAK, is not a note.

import { NOTE_NAMES } from '../core/params.js';

/** Peak absolute sample below this is silence, not a note. */
export const SILENCE_PEAK = 0.01;
/** Lowest confidence returned for a real note. Below this, hz is 0. */
export const CLEAR_CONFIDENCE = 0.5;

/** User-facing tuner words. ASCII only, no em dashes. */
export const TUNER_TEXT = Object.freeze({
  title: 'Tuner',
  voiceOff: 'Turn Voice on to tune.',
  inTune: 'In tune',
  flat: 'Flat',
  sharp: 'Sharp',
});

const DIP = 0.15;
const DIP_FALLBACK = 0.45;
const NONE = Object.freeze({ hz: 0, confidence: 0 });

function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * Reusable detector. `detect` does not allocate after construction.
 * The returned object is the same one every call: read it before the next call.
 * @param {number} sampleRate
 * @param {{minHz?: number, maxHz?: number, size?: number}} [opts]
 */
export function createTuner(sampleRate, { minHz = 50, maxHz = 1200, size = 4096 } = {}) {
  const rate = sampleRate;
  const loHz = minHz > 0 ? minHz : 50;
  const hiHz = maxHz > loHz ? maxHz : 1200;
  const capN = Math.max(64, size | 0);
  const capTau = Math.max(8, capN >> 1);
  const x = new Float64Array(capN);
  const diff = new Float64Array(capTau + 3);
  const cmnd = new Float64Array(capTau + 3);
  const out = { hz: 0, confidence: 0 };

  function none() {
    out.hz = 0;
    out.confidence = 0;
    return out;
  }

  function detect(samples) {
    if (!samples || samples.length < 64 || !(rate > 0) || !Number.isFinite(rate)) return none();
    const len = samples.length < capN ? samples.length : capN;
    const start = samples.length - len;
    let peak = 0;
    for (let i = 0; i < len; i++) {
      const v = samples[start + i];
      if (!Number.isFinite(v)) return none();
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    if (peak < SILENCE_PEAK) return none();

    let mean = 0;
    for (let i = 0; i < len; i++) mean += samples[start + i];
    mean /= len;
    for (let i = 0; i < len; i++) x[i] = samples[start + i] - mean;

    const minTau = Math.max(2, Math.floor(rate / hiHz));
    let maxTau = Math.min(len >> 1, Math.ceil(rate / loHz) + 1);
    if (maxTau > capTau) maxTau = capTau;
    const width = len - maxTau;
    if (width < 32 || maxTau <= minTau + 2) return none();

    for (let tau = 1; tau <= maxTau; tau++) {
      let sum = 0;
      for (let j = 0; j < width; j++) {
        const d = x[j] - x[j + tau];
        sum += d * d;
      }
      diff[tau] = sum;
    }

    cmnd[0] = 1;
    let acc = 0;
    for (let tau = 1; tau <= maxTau; tau++) {
      acc += diff[tau];
      cmnd[tau] = acc > 1e-18 ? (diff[tau] * tau) / acc : 1;
    }

    let tau = minTau;
    while (tau < maxTau && cmnd[tau] > DIP) tau++;
    if (tau >= maxTau) {
      let best = minTau;
      let bestV = cmnd[minTau];
      for (let t = minTau + 1; t <= maxTau; t++) {
        if (cmnd[t] < bestV) { bestV = cmnd[t]; best = t; }
      }
      if (!(bestV <= DIP_FALLBACK)) return none();
      tau = best;
    } else {
      while (tau + 1 <= maxTau && cmnd[tau + 1] < cmnd[tau]) tau++;
    }

    // Harmonic check: step to twice the lag only when that valley is a
    // clearly better repeat. An equal valley (a true period and its double)
    // stays on the shorter lag, which is the fundamental.
    for (let hop = 0; hop < 3; hop++) {
      const target = tau * 2;
      if (target + 1 >= maxTau) break;
      const lo = Math.max(tau + 2, Math.floor(target * 0.96));
      const hi = Math.min(maxTau - 1, Math.ceil(target * 1.04));
      if (lo >= hi) break;
      let alt = lo;
      for (let t = lo + 1; t <= hi; t++) if (cmnd[t] < cmnd[alt]) alt = t;
      if (cmnd[alt] + 0.03 < cmnd[tau] && cmnd[alt] < 0.25) tau = alt;
      else break;
    }

    if (tau < 1 || tau > maxTau) return none();
    let offset = 0;
    if (tau > 0 && tau < maxTau) {
      const y0 = cmnd[tau - 1];
      const y1 = cmnd[tau];
      const y2 = cmnd[tau + 1];
      const den = (y0 - 2 * y1) + y2;
      if (den !== 0 && Number.isFinite(den)) {
        offset = 0.5 * (y0 - y2) / den;
        if (offset > 0.5) offset = 0.5;
        else if (offset < -0.5) offset = -0.5;
      }
    }
    const period = tau + offset;
    if (!(period > 1)) return none();
    const hz = rate / period;
    if (!(hz > 0) || !Number.isFinite(hz)) return none();
    if (hz < loHz * 0.97 || hz > hiHz * 1.03) return none();
    const y = cmnd[tau];
    let confidence = 1 - y;
    if (!Number.isFinite(confidence)) return none();
    confidence = clamp(confidence, 0, 1);
    if (confidence < CLEAR_CONFIDENCE) return none();
    out.hz = hz;
    out.confidence = confidence;
    return out;
  }

  return { detect, sampleRate: rate, size: capN };
}

/**
 * One-shot pitch estimate.
 * @param {ArrayLike<number>} samples
 * @param {number} sampleRate
 * @param {{minHz?: number, maxHz?: number}} [opts]
 * @returns {{hz: number, confidence: number}}
 */
export function detectPitch(samples, sampleRate, opts = {}) {
  const n = samples && samples.length ? samples.length : 0;
  if (!n) return { hz: 0, confidence: 0 };
  const tuner = createTuner(sampleRate, {
    minHz: opts.minHz == null ? 50 : opts.minHz,
    maxHz: opts.maxHz == null ? 1200 : opts.maxHz,
    size: n,
  });
  const r = tuner.detect(samples);
  return { hz: r.hz, confidence: r.confidence };
}

/**
 * Equal-tempered name for a frequency. `note` is the MIDI number with
 * A4 = 69 at `refHz`. Octave is scientific (MIDI 69 is A4). Cents are
 * one decimal in -50..50. Names are sharps, from NOTE_NAMES.
 * @param {number} hz
 * @param {number} [refHz]
 * @returns {{note: number, octave: number, cents: number, name: string}}
 */
export function hzToNote(hz, refHz = 440) {
  const empty = { note: 0, octave: 0, cents: 0, name: '' };
  if (!(hz > 0) || !Number.isFinite(hz)) return empty;
  const ref = refHz > 0 && Number.isFinite(refHz) ? refHz : 440;
  const midi = 69 + 12 * Math.log2(hz / ref);
  if (!Number.isFinite(midi)) return empty;
  const note = Math.round(midi);
  let cents = (midi - note) * 100;
  cents = Math.round(cents * 10) / 10;
  if (cents > 50) cents = 50;
  else if (cents < -50) cents = -50;
  if (cents === 0) cents = 0;
  const pc = ((note % 12) + 12) % 12;
  const octave = Math.floor(note / 12) - 1;
  return { note, octave, cents, name: NOTE_NAMES[pc] || '' };
}
