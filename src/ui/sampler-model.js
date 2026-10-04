// Pure helpers for the Sampler card: no DOM. The card stores one mono sample
// (base64 16-bit PCM) plus a start/end region in 0..1.

import { SAMPLER_MAX_B64, SAMPLER_MAX_SECONDS, SAMPLER_RATE } from '../dsp/sampler.js';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Smallest gap between the region start and end, as a fraction of the sample. */
export const REGION_GAP = 0.001;

/** MIDI note to a name (C4 is 60). */
export function midiNoteName(n) {
  const m = Math.round(Number(n));
  if (!Number.isFinite(m)) return '';
  const i = ((m % 12) + 12) % 12;
  return `${NOTE_NAMES[i]}${Math.floor(m / 12) - 1}`;
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Longest PCM buffer whose 16-bit base64 form fits in `maxB64`.
 * base64 length is 4 * ceil(byteLength / 3), and byteLength is 2 samples.
 */
export function maxPcmSamples(maxB64 = SAMPLER_MAX_B64) {
  const groups = Math.floor(Math.max(0, maxB64) / 4);
  return Math.floor(groups * 3 / 2);
}

/**
 * File name for the sample slot: drop a short extension, collapse spaces,
 * fall back, and stay inside the 40 character name limit.
 */
export function cleanSampleName(name, fallback = 'Sample') {
  let base = String(name || '').trim().replace(/\.[A-Za-z0-9]{1,5}$/, '');
  base = base.replace(/\s+/g, ' ').trim();
  return (base || fallback).slice(0, 40);
}

/**
 * Trim mono audio to SAMPLER_MAX_SECONDS and to the base64 size limit.
 * `rate` is clamped to the range sanitizeSampler keeps (8000..96000).
 * Returns a new Float32Array so the caller can drop the source buffer.
 */
export function fitSample(data, rate, maxSeconds = SAMPLER_MAX_SECONDS) {
  const src = data && typeof data.length === 'number' ? data : [];
  let r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) r = SAMPLER_RATE;
  r = Math.round(Math.min(96000, Math.max(8000, r)));
  const byTime = Math.max(0, Math.floor(maxSeconds * r));
  const limit = Math.min(byTime, maxPcmSamples());
  const n = Math.max(0, Math.min(src.length, limit));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = src[i];
    out[i] = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  }
  return { data: out, rate: r, trimmed: n < src.length };
}

/** Average a stereo pair to mono. A missing side is used as-is. */
export function mixToMono(left, right) {
  const L = left && typeof left.length === 'number' ? left : null;
  const R = right && typeof right.length === 'number' ? right : null;
  const nL = L ? L.length : 0;
  const nR = R ? R.length : 0;
  if (!nL && !nR) return new Float32Array(0);
  if (!nR) return copyFinite(L, nL);
  if (!nL) return copyFinite(R, nR);
  const n = Math.max(nL, nR);
  const out = new Float32Array(n);
  const both = Math.min(nL, nR);
  for (let i = 0; i < both; i++) {
    const a = L[i], b = R[i];
    const l = typeof a === 'number' && Number.isFinite(a) ? a : 0;
    const r = typeof b === 'number' && Number.isFinite(b) ? b : 0;
    out[i] = (l + r) * 0.5;
  }
  for (let i = both; i < nL; i++) out[i] = finite(L[i]);
  for (let i = both; i < nR; i++) out[i] = finite(R[i]);
  return out;
}

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function copyFinite(src, n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = finite(src[i]);
  return out;
}

/**
 * A looper getLoop() payload ({L, R, sampleRate}) as a capped mono buffer.
 * Null when there is nothing to take. Does not throw.
 */
export function loopToSample(loop, maxSeconds = SAMPLER_MAX_SECONDS) {
  if (!loop || typeof loop !== 'object') return null;
  const mono = mixToMono(loop.L, loop.R);
  if (!mono.length) return null;
  const rate = Number(loop.sampleRate);
  return fitSample(mono, Number.isFinite(rate) && rate > 0 ? rate : SAMPLER_RATE, maxSeconds);
}

/**
 * Min and max of `data` in `columns` buckets, for a waveform.
 * Empty audio is a flat zero, not a placeholder shape.
 */
export function waveformPeaks(data, columns) {
  const cols = Math.max(1, Math.min(4096, columns | 0));
  const min = new Float32Array(cols);
  const max = new Float32Array(cols);
  const n = data && data.length ? data.length : 0;
  if (!n) return { min, max };
  const step = n / cols;
  for (let i = 0; i < cols; i++) {
    let a = Math.floor(i * step);
    let b = Math.floor((i + 1) * step);
    if (b <= a) b = a + 1;
    if (a >= n) a = n - 1;
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = a; j < b && j < n; j++) {
      const v = data[j];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo === Infinity) { lo = 0; hi = 0; }
    min[i] = lo;
    max[i] = hi;
  }
  return { min, max };
}

/**
 * Move the start or end handle. The result always has end - start >= gap,
 * both inside 0..1. The dragged handle stops at the gap instead of crossing
 * the other one. A region that is already too small is opened up first.
 */
export function moveRegionHandle(which, value, start, end, gap = REGION_GAP) {
  const g = gap > 0 && gap < 1 ? gap : REGION_GAP;
  let s = clamp01(start);
  let e = clamp01(end);
  if (e < s) { const t = s; s = e; e = t; }
  if (e - s < g) {
    if (s + g <= 1) e = s + g;
    else { e = 1; s = 1 - g; }
  }
  const v = clamp01(value);
  if (which === 'end') {
    e = v;
    if (e < s + g) e = s + g;
    if (e > 1) e = 1;
    if (e < s + g) s = e - g;
  } else {
    s = v;
    if (s > e - g) s = e - g;
    if (s < 0) s = 0;
    if (s > e - g) e = s + g;
  }
  return { start: s, end: e };
}

/**
 * Which handle a pointer is on. Within `slop` pixels the nearer handle wins.
 * Further away, the nearer handle is still returned so a drag from anywhere
 * can move a boundary.
 */
export function pickRegionHandle(x, width, start, end, slop = 10) {
  const w = width > 0 ? width : 1;
  const sx = clamp01(start) * w;
  const ex = clamp01(end) * w;
  const ds = Math.abs(x - sx);
  const de = Math.abs(x - ex);
  if (ds <= slop && ds <= de) return 'start';
  if (de <= slop && de < ds) return 'end';
  return ds <= de ? 'start' : 'end';
}
