// Pure helpers for the Sampler card: no DOM. A take is 16-bit PCM, mono or
// stereo, plus a start/end region in 0..1 and optional slice marks in frames.

import { MAX_SLICES, SAMPLER_MAX_B64, SAMPLER_MAX_SECONDS, SAMPLER_RATE } from '../dsp/sampler.js';

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

/** Smallest gap between neighbouring slice marks, in source frames. */
export const MIN_SLICE_FRAMES = 256;
/** Pointer slop for a slice mark, in CSS pixels (wider for a coarse pointer). */
export const SLICE_HIT_PX = 8;
export const SLICE_HIT_COARSE = 14;

/**
 * Fit a stereo pair to the same capped length. A missing side is mono.
 * `right` is null when the take has one channel.
 */
export function fitStereo(left, right, rate, maxSeconds = SAMPLER_MAX_SECONDS) {
  const L = fitSample(left && left.length ? left : right, rate, maxSeconds);
  const Rsrc = right && typeof right.length === 'number' ? right : null;
  const Lsrc = left && typeof left.length === 'number' ? left : null;
  if (!Lsrc || !Rsrc || !Lsrc.length || !Rsrc.length) return { ...L, right: null, stereo: false };
  const n = L.data.length;
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) R[i] = finite(Rsrc[i]);
  return { data: L.data, right: R, rate: L.rate, trimmed: L.trimmed || Rsrc.length > n || Lsrc.length > n, stereo: true };
}

/**
 * A looper payload ({L, R, sampleRate}) as a capped buffer that keeps both
 * channels. Null when there is nothing to take. Does not throw.
 */
export function loopToSample(loop, maxSeconds = SAMPLER_MAX_SECONDS) {
  if (!loop || typeof loop !== 'object') return null;
  const L = loop.L && typeof loop.L.length === 'number' ? loop.L : null;
  const R = loop.R && typeof loop.R.length === 'number' ? loop.R : null;
  if ((!L || !L.length) && (!R || !R.length)) return null;
  const rate = Number(loop.sampleRate);
  return fitStereo(L, R, Number.isFinite(rate) && rate > 0 ? rate : SAMPLER_RATE, maxSeconds);
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

/**
 * Index of the slice mark under the pointer, or -1. Marks are hit before a
 * region handle, and only within `slop` pixels.
 */
export function pickSliceMark(x, width, slices, length, slop = SLICE_HIT_PX) {
  const n = length | 0;
  if (!(n > 0) || !(width > 0) || !slices || !slices.length) return -1;
  let best = -1;
  let bestD = slop + 1;
  for (let i = 0; i < slices.length; i++) {
    const d = Math.abs(x - (slices[i] / n) * width);
    if (d <= slop && d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/**
 * Move one mark. It cannot cross its neighbours, and neighbouring marks stay
 * at least `gap` frames apart. The last mark also stays `gap` frames before
 * the end so the last slice has some audio.
 */
export function moveSliceMark(index, frame, slices, length, gap = MIN_SLICE_FRAMES) {
  if (!slices || index < 0 || index >= slices.length) return slices ? slices.slice() : [];
  const next = slices.slice();
  const g = gap > 1 ? gap : MIN_SLICE_FRAMES;
  const prev = index > 0 ? next[index - 1] + g : 0;
  const hi = index + 1 < next.length ? next[index + 1] - g : Math.max(0, (length | 0) - g);
  if (hi < prev) return next;
  let f = Math.round(Number(frame));
  if (!Number.isFinite(f)) f = next[index];
  if (f < prev) f = prev;
  if (f > hi) f = hi;
  next[index] = f;
  return next;
}

/**
 * Insert a mark, in order. Refuses the 32-slice limit and a mark that would
 * sit within `gap` frames of another.
 */
export function addSliceMark(frame, slices, length, gap = MIN_SLICE_FRAMES, max = MAX_SLICES) {
  const cur = slices ? slices.slice() : [];
  if (cur.length >= max) return { slices: cur, added: false, reason: 'limit' };
  const g = gap > 1 ? gap : MIN_SLICE_FRAMES;
  const n = length | 0;
  let f = Math.round(Number(frame));
  if (!Number.isFinite(f)) return { slices: cur, added: false, reason: 'bad' };
  if (f < 0) f = 0;
  const hi = Math.max(0, n - g);
  if (f > hi) f = hi;
  for (const s of cur) if (Math.abs(s - f) < g) return { slices: cur, added: false, reason: 'gap' };
  cur.push(f);
  cur.sort((a, b) => a - b);
  return { slices: cur, added: true, reason: '', index: cur.indexOf(f) };
}

/** Remove one mark. The last remaining mark clears the list (even slices again). */
export function deleteSliceMark(index, slices) {
  if (!slices || index < 0 || index >= slices.length) return slices ? slices.slice() : [];
  if (slices.length <= 1) return [];
  return slices.filter((_, i) => i !== index);
}

/** Start frames for `count` even pieces. Marks that would break the gap are left out. */
export function evenSliceMarks(count, length, gap = MIN_SLICE_FRAMES) {
  const n = Math.max(0, length | 0);
  const c = Math.max(2, count | 0);
  const g = gap > 1 ? gap : MIN_SLICE_FRAMES;
  if (n < g) return n > 0 ? [0] : [];
  const out = [0];
  for (let i = 1; i < c && out.length < MAX_SLICES; i++) {
    let f = Math.round(i * n / c);
    const prev = out[out.length - 1];
    if (f < prev + g) f = prev + g;
    if (f > n - g) break;
    out.push(f);
  }
  return out;
}

/**
 * Nearest zero crossing of the channel sum within `windowMs` of `frame`.
 * The frame itself is returned when nothing in the window changes sign.
 */
export function nearestZeroCross(left, right, frame, rate, windowMs = 12) {
  const n = left && left.length ? left.length : 0;
  if (n < 2) return Math.max(0, Math.round(Number(frame) || 0));
  const win = Math.max(1, Math.round((rate > 0 ? rate : SAMPLER_RATE) * windowMs / 1000));
  const at = Math.max(0, Math.min(n - 1, Math.round(Number(frame) || 0)));
  const a = Math.max(1, at - win);
  const b = Math.min(n - 1, at + win);
  const sum = (i) => {
    const l = left[i] || 0;
    const r = right && right.length === n ? (right[i] || 0) : 0;
    return right && right.length === n ? l + r : l;
  };
  let best = at;
  let bestD = Infinity;
  for (let i = a; i <= b; i++) {
    const p = sum(i - 1);
    const c = sum(i);
    if ((p <= 0 && c > 0) || (p >= 0 && c < 0) || c === 0) {
      const hit = Math.abs(p) <= Math.abs(c) ? i - 1 : i;
      const d = Math.abs(hit - at);
      if (d < bestD) { bestD = d; best = hit; }
    }
  }
  return best;
}
