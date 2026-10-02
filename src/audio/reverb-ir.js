// Algorithmic stereo impulse response for the convolution reverb.
//
// The response is modelled as what a diffuse room does to a click:
//   silence (pre-delay) -> a handful of discrete early reflections -> a dense
//   exponentially decaying noise tail that fades in over a few milliseconds.
// Frequency-dependent damping comes from a time-varying low-pass on the tail
// noise: its cutoff starts near the top of the audio band and glides down
// exponentially. Below the cutoff a frequency decays at the room's RT60;
// once the cutoff has passed it, it also loses the filter's 12 dB/octave
// slope, so highs die first and the tail darkens as it decays, much like air
// and wall absorption (which grow with frequency). Damp sets how fast the
// cutoff falls, i.e. the RT60 that very high frequencies end up with.
// Left and right use independent noise and reflection patterns, which is what
// makes the reverb wide (low inter-channel correlation).
//
// Pure maths, no Web Audio: unit-tested in Node and called by fx.js.

import { mulberry32 } from '../dsp/terrain-math.js';

export const REVERB_MIN_TIME = 0.4;
export const REVERB_MAX_TIME = 7;
const LN1000 = Math.log(1000); // -60 dB in nepers

function clamp01(x) { return Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0; }

/** reverbSize 0..1 -> RT60 in seconds, exponential from 0.4 s to 7 s. */
export function reverbTime(size) {
  return REVERB_MIN_TIME * Math.pow(REVERB_MAX_TIME / REVERB_MIN_TIME, clamp01(size));
}

/** Bigger rooms have a longer gap before the first reflections. */
export function preDelayTime(size) {
  return 0.006 + 0.022 * clamp01(size);
}

/**
 * Damping model for a room: `fStart` is the tail's initial bandwidth (Hz),
 * the cutoff falls towards `fFloor` at rate `k` (1/s), and `highRT` is the
 * RT60 that frequencies far above the cutoff have while it falls (the
 * 12 dB/oct slope adds 2·8.686·k dB/s to the room's 60/rt dB/s).
 */
export function dampingModel(rt, damp) {
  const d = clamp01(damp);
  const ratio = 0.9 - 0.75 * d;              // highRT / rt: 0.9 (airy) .. 0.15 (dead)
  const k = (LN1000 / 2) * (1 / ratio - 1) / rt;
  // The cutoff glides towards a floor rather than to zero: rooms absorb little
  // below a few hundred hertz, so the low end keeps the full RT60 whatever Damp.
  return { fStart: 18000 - 6000 * d, fFloor: 500, k, highRT: rt * ratio };
}

function onePoleCoef(freq, sr) {
  return 1 - Math.exp(-2 * Math.PI * Math.min(freq, sr * 0.45) / sr);
}

const CUTOFF_STEP = 16;   // samples between cutoff updates (smooth enough, cheap)

function renderChannel(out, sr, rng, opts) {
  const { pre, rt, damping, fadeIn, erCount, erSpan, tailStart } = opts;
  const n = out.length;
  const decay = Math.exp(-LN1000 / (rt * sr));
  const fcStep = Math.exp(-damping.k * CUTOFF_STEP / sr);
  const start = Math.min(n, Math.round(tailStart * sr));
  const fadeN = Math.max(1, Math.round(fadeIn * sr));
  const floor = damping.fFloor;
  let excess = Math.max(0, damping.fStart - floor), a = onePoleCoef(floor + excess, sr);
  let s1 = 0, s2 = 0, env = 1;
  for (let i = start; i < n; i++) {
    const k = i - start;
    if (k % CUTOFF_STEP === 0) {
      a = onePoleCoef(floor + excess, sr);
      excess *= fcStep;
    }
    const w = rng() * 2 - 1;
    s1 += a * (w - s1);
    s2 += a * (s1 - s2);
    let y = s2 * env;
    env *= decay;
    if (k < fadeN) y *= 0.5 - 0.5 * Math.cos(Math.PI * k / fadeN);
    out[i] = y;
  }
  // Discrete early reflections: sparse, decaying, random polarity, each
  // smeared over three samples so they are not single-sample clicks.
  const erStart = pre + 0.003;
  let tailEnergy = 0;
  const probe = Math.min(n, start + Math.round(0.05 * sr));
  for (let i = start; i < probe; i++) tailEnergy += out[i] * out[i];
  const tailRms = Math.sqrt(tailEnergy / Math.max(1, probe - start)) || 0.1;
  // Reflections are a fixed number of spikes while the tail's energy grows with
  // the sample rate, so scale them to keep the same balance at 44.1 or 96 kHz.
  const erGain = tailRms * 9 * Math.sqrt(sr / 48000);
  for (let k = 0; k < erCount; k++) {
    const t = erStart + erSpan * Math.pow((k + rng()) / erCount, 1.4);
    const idx = Math.round(t * sr);
    if (idx + 2 >= n) continue;
    const g = erGain * Math.pow(0.82, k) * (rng() < 0.5 ? -1 : 1) * (0.6 + 0.4 * rng());
    out[idx] += 0.5 * g; out[idx + 1] += g; out[idx + 2] += 0.5 * g;
  }
}

/**
 * Generate a stereo impulse response.
 * @param {{sampleRate: number, size: number, damp: number, seed?: number}} o
 * @returns {{left: Float32Array, right: Float32Array, rt: number, preDelay: number, length: number}}
 *   Both channels are scaled together to unit average energy (sum of squares = 1),
 *   so a ConvolverNode with normalisation disabled has roughly unity power gain
 *   for broadband input whatever the size.
 */
export function generateImpulse({ sampleRate, size, damp, seed = 1 }) {
  const sr = sampleRate > 0 ? sampleRate : 48000;
  const s = clamp01(size), d = clamp01(damp);
  const rt = reverbTime(s);
  const pre = preDelayTime(s);
  const tailStart = pre + 0.002;
  const length = Math.max(64, Math.ceil((tailStart + rt) * sr));
  const opts = {
    pre, rt, damping: dampingModel(rt, d), tailStart,
    fadeIn: 0.008 + 0.025 * s,
    erCount: 12,
    erSpan: 0.02 + 0.06 * s,
  };
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  const base = (seed >>> 0) * 2654435761;
  renderChannel(left, sr, mulberry32((base + 0x1f2e3d) >>> 0), opts);
  renderChannel(right, sr, mulberry32((base + 0x9a8b7c) >>> 0), opts);

  // Short fade at the very end so truncation (at -60 dB) is inaudible.
  const fadeOut = Math.min(length >> 3, Math.round(0.05 * sr));
  for (let k = 0; k < fadeOut; k++) {
    const g = 0.5 - 0.5 * Math.cos(Math.PI * k / fadeOut);
    left[length - 1 - k] *= g; right[length - 1 - k] *= g;
  }

  let e = 0;
  for (let i = 0; i < length; i++) e += left[i] * left[i] + right[i] * right[i];
  e *= 0.5;
  const g = e > 0 ? 1 / Math.sqrt(e) : 0;
  for (let i = 0; i < length; i++) { left[i] *= g; right[i] *= g; }
  return { left, right, rt, preDelay: pre, length };
}
