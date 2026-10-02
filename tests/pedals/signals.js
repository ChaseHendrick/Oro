// Synthetic guitar-like test signals with a pitch we know exactly.
// Additive synthesis instead of Karplus-Strong because KS's real pitch depends
// on its loop filter's phase delay; here every harmonic's frequency is set
// directly, so cents errors measure the tracker and nothing else.

import { makeRandom } from '../../src/pedals/signal.js';

/**
 * A plucked string: harmonics |sin(pi k beta)| / k (pluck position beta),
 * higher harmonics dying faster, a 2 ms pick-noise burst, optional
 * inharmonicity B (f_k = k f0 sqrt(1 + B k^2)), vibrato and bends.
 * @returns {Float32Array}
 */
export function pluck({
  sampleRate = 48000, freq = 110, duration = 1.2, start = 0.1, amp = 0.5,
  harmonics = 30, beta = 0.18, decay = 1.6, brightDecay = 0.12, inharm = 0,
  amps = null, vibrato = null, bend = null, noise = 0.0005, pickNoise = 0.15, seed = 1,
  pitchAt = null,
} = {}) {
  const n = Math.round((start + duration) * sampleRate);
  const out = new Float32Array(n);
  const rnd = makeRandom(seed);
  const K = harmonics;
  const a = new Float64Array(K + 1), tau = new Float64Array(K + 1), ratio = new Float64Array(K + 1), ph = new Float64Array(K + 1);
  let norm = 0;
  for (let k = 1; k <= K; k++) {
    a[k] = amps ? (amps[k - 1] || 0) : Math.abs(Math.sin(Math.PI * k * beta)) / k;
    tau[k] = decay / (1 + brightDecay * (k - 1));
    ratio[k] = k * Math.sqrt(1 + inharm * k * k);
    ph[k] = rnd() * 2 * Math.PI;
    norm += a[k];
  }
  const g = norm > 0 ? amp / norm * 2 : 0;
  const s0 = Math.round(start * sampleRate);
  const nyq = sampleRate / 2;
  for (let i = s0; i < n; i++) {
    const t = (i - s0) / sampleRate;
    let f = pitchAt ? pitchAt(t) : freq;
    if (vibrato && t >= (vibrato.delay || 0)) f *= Math.pow(2, vibrato.cents * Math.sin(2 * Math.PI * vibrato.rate * (t - (vibrato.delay || 0))) / 1200);
    if (bend) {
      const { at, rise, semis, hold = 1e9, fall = rise } = bend;
      let b = 0;
      if (t >= at && t < at + rise) b = semis * (t - at) / rise;
      else if (t >= at + rise && t < at + rise + hold) b = semis;
      else if (t >= at + rise + hold && t < at + rise + hold + fall) b = semis * (1 - (t - at - rise - hold) / fall);
      f *= Math.pow(2, b / 12);
    }
    let s = 0;
    for (let k = 1; k <= K; k++) {
      const fk = f * ratio[k];
      ph[k] += 2 * Math.PI * fk / sampleRate;
      if (fk >= nyq * 0.95 || a[k] === 0) continue;
      s += a[k] * Math.exp(-t / tau[k]) * Math.sin(ph[k]);
    }
    let v = s * g;
    if (t < 0.002) v += pickNoise * amp * (rnd() * 2 - 1) * (1 - t / 0.002);
    out[i] = v;
  }
  if (noise > 0) for (let i = 0; i < n; i++) out[i] += noise * (rnd() * 2 - 1);
  return out;
}

/** Concatenate/mix signals at given start samples into one buffer. */
export function mix(len, parts) {
  const out = new Float32Array(len);
  for (const { at = 0, sig, gain = 1 } of parts) {
    for (let i = 0; i < sig.length && at + i < len; i++) out[at + i] += sig[i] * gain;
  }
  return out;
}

/** Standard tuning open strings and a few fretted notes, E2 (82.41 Hz) to E6 (1318.5 Hz). */
export const GUITAR_NOTES = [40, 45, 50, 55, 59, 64, 69, 76, 81, 86, 88];

export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** A deterministic strum, with a separate plucked string for each MIDI note. */
export function strum(notes, {
  sampleRate = 48000, start = 0.1, duration = 1.5, spread = 0.008, amp = 0.35, seed = 1,
  levels = null, decay = 2.2, up = false,
} = {}) {
  const n = Math.round((start + duration) * sampleRate);
  const order = up ? notes.slice().reverse() : notes.slice();
  const parts = order.map((m, i) => {
    const s = (seed * 7919 + m * 31 + i * 17) % 1000;
    const level = levels ? levels[notes.indexOf(m)] : 0.8 + 0.4 * ((s % 97) / 97);
    const sig = pluck({
      sampleRate, freq: midiToHz(m), duration: duration - i * spread, start: 0, amp: amp * level,
      beta: 0.12 + 0.12 * ((s % 13) / 13), decay: decay * (m < 52 ? 1.2 : 0.9),
      inharm: m < 50 ? 1.5e-4 : 5e-5, harmonics: 40, seed: seed * 101 + i, noise: 0,
    });
    return { at: Math.round((start + i * spread) * sampleRate), sig };
  });
  const out = mix(n, parts);
  const rnd = makeRandom(seed * 13 + 5);
  for (let i = 0; i < n; i++) out[i] += 0.0003 * (rnd() * 2 - 1);
  return out;
}
