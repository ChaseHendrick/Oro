// Turning the user's files into terrains.
//
//   PNG: decoded by our own reader (png.js) at the file's full bit depth, so a
//     16-bit height map (DEM) keeps all of its levels; grey values are heights
//     as they are (data, not light). Centre-cropped and area-averaged to at
//     most 256 x 256 (never upsampled). If our reader cannot open the file the
//     browser's decoder below gets a try.
//   other images (JPEG, WebP, GIF, BMP, SVG, and PNG as a fallback): drawn by
//     the browser, centre-cropped, reduced to 256 x 256 by area-averaging in
//     linear light, converted to luminance with the sRGB/Rec.709 weights and
//     re-encoded to sRGB, so a grey image keeps its grey levels and colour
//     images get perceptually right brightness.
//   Options for images: channel 'luma' | 'r' | 'g' | 'b' (one channel is used
//     as data), smooth 0..1 (Gaussian, in float), tile 'mirror' (reflect so any
//     image tiles) | 'wrap' (the image already tiles). Heights are kept as
//     16-bit values: UserTerrain.data is the high byte plane, UserTerrain.lo
//     the low one (see heightmap.js); readers that ignore `lo` still work.
//   WAV: read sample-exact (decodeAudioData only as a fallback, because it
//     resamples), split into single-cycle frames (a 'clm ' chunk's frame size,
//     else multiples of 2048, else 1024/512/256, else one cycle), each frame
//     band-limited and resampled to 256 samples through its spectrum, at most
//     256 frames, stored at 16 bits the same way.
//     UserTerrain {kind: 'wavetable', w: 256, h: frames, mirror: 1}.
//
// The pure helpers are exported for the Node unit tests; importTerrainFile is
// the browser entry used by the engine.

import { NUM_PARTS } from '../core/params.js';
import { TERRAIN_INDEX } from '../dsp/catalog.js';
import { wavInfo } from './wav.js';
import { isPng } from './png.js';
import {
  centreCrop, heightFromPng, smoothHeights, heightsToPlanes, srgbEncode, CHANNELS,
} from './heightmap.js';

export { centreCrop };

export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
export const TABLE_SIZE = 256;
export const MAX_FRAMES = 256;
const SINGLE_CYCLE_MAX = 4096;
const YIELD_MS = 8;

/** Longest synchronous main-thread step of the imports so far (ms), for diagnostics. */
export const importStats = { imports: 0, maxBlockMs: 0, lastBlockMs: 0, last: null, steps: {} };
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
function timedBlock(fn, step = 'other') {
  const t0 = nowMs();
  try { return fn(); } finally {
    const ms = nowMs() - t0;
    importStats.lastBlockMs = Math.max(importStats.lastBlockMs, ms);
    importStats.maxBlockMs = Math.max(importStats.maxBlockMs, ms);
    importStats.steps[step] = Math.max(importStats.steps[step] || 0, Math.round(ms * 10) / 10);
  }
}

// ---- base64 ------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 (with padding) of a byte array; no dependency on btoa. */
export function bytesToBase64(bytes) {
  const n = bytes.length;
  const parts = [];
  let chunk = '';
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    chunk += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
    if (chunk.length >= 8192) { parts.push(chunk); chunk = ''; }
  }
  if (i < n) {
    const a = bytes[i], b = i + 1 < n ? bytes[i + 1] : 0;
    const v = (a << 16) | (b << 8);
    chunk += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + (i + 1 < n ? B64[(v >> 6) & 63] : '=') + '=';
  }
  parts.push(chunk);
  return parts.join('');
}

// ---- colour ---------------------------------------------------------------------------

const SRGB_TO_LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 8-bit sRGB channel -> linear light 0..1. */
export function srgbToLinear(c8) { return SRGB_TO_LIN[c8 & 255]; }

/** Linear light 0..1 -> 8-bit sRGB code value. */
export function linearToSrgb8(y) {
  const c = y <= 0 ? 0 : y >= 1 ? 1 : (y <= 0.0031308 ? 12.92 * y : 1.055 * Math.pow(y, 1 / 2.4) - 0.055);
  return Math.round(c * 255);
}

/** Relative luminance (linear) of an 8-bit sRGB colour (Rec.709 primaries). */
export function luminance(r, g, b) {
  return 0.2126 * SRGB_TO_LIN[r] + 0.7152 * SRGB_TO_LIN[g] + 0.0722 * SRGB_TO_LIN[b];
}

// Separable area resampling: output cell j covers source [j·s, (j+1)·s) with
// fractional weights at both ends, so any ratio averages exactly what it covers.
function areaAxis(srcLen, outLen) {
  const s = srcLen / outLen;
  const idx = [], wts = [];
  for (let j = 0; j < outLen; j++) {
    const a = j * s, b = (j + 1) * s;
    const i0 = Math.floor(a), i1 = Math.min(srcLen, Math.ceil(b));
    const ii = [], ww = [];
    for (let i = i0; i < i1; i++) {
      const w = Math.min(b, i + 1) - Math.max(a, i);
      if (w > 1e-9) { ii.push(Math.min(i, srcLen - 1)); ww.push(w / s); }
    }
    idx.push(ii); wts.push(ww);
  }
  return { idx, wts };
}

/**
 * RGBA (unpremultiplied, sRGB) -> out x out heights 0..1 (float).
 * channel 'luma': perceived brightness, area-averaged in linear light and
 * re-encoded to sRGB (a grey image keeps its grey levels). 'r' | 'g' | 'b':
 * that channel's code value, averaged as data. Transparent pixels count as
 * black (lowest ground).
 */
export function rgbaToHeightF(rgba, w, h, out = TABLE_SIZE, channel = 'luma') {
  const ci = channel === 'r' ? 0 : channel === 'g' ? 1 : channel === 'b' ? 2 : -1;
  const val = ci < 0
    ? (q) => (0.2126 * SRGB_TO_LIN[rgba[q]] + 0.7152 * SRGB_TO_LIN[rgba[q + 1]] + 0.0722 * SRGB_TO_LIN[rgba[q + 2]]) * (rgba[q + 3] / 255)
    : (q) => (rgba[q + ci] / 255) * (rgba[q + 3] / 255);
  const finish = (s) => (ci < 0 ? srgbEncode(s) : s);
  const res = new Float32Array(out * out);
  if (w % out === 0 && h % out === 0) {
    // Integer ratios (the browser path always reads back 1x or 2x the table
    // size): one pass, each source pixel added straight into its output cell.
    // The two loops are written out so the hot path has no per-pixel call.
    const kx = w / out, ky = h / out;
    const acc = new Float64Array(out * out);
    const L = SRGB_TO_LIN;
    for (let y = 0; y < h; y++) {
      const orow = Math.floor(y / ky) * out;
      let q = y * w * 4;
      if (ci < 0) {
        for (let x = 0; x < w; x++, q += 4) {
          const a = rgba[q + 3];
          if (a === 0) continue;
          const lum = 0.2126 * L[rgba[q]] + 0.7152 * L[rgba[q + 1]] + 0.0722 * L[rgba[q + 2]];
          acc[orow + ((x / kx) | 0)] += a === 255 ? lum : lum * (a / 255);
        }
      } else {
        for (let x = 0; x < w; x++, q += 4) {
          const a = rgba[q + 3];
          if (a === 0) continue;
          acc[orow + ((x / kx) | 0)] += (rgba[q + ci] / 255) * (a / 255);
        }
      }
    }
    const inv = 1 / (kx * ky);
    for (let i = 0; i < res.length; i++) res[i] = finish(acc[i] * inv);
    return res;
  }
  const lin = new Float64Array(w * h);
  for (let p = 0, q = 0; p < w * h; p++, q += 4) lin[p] = val(q);
  const ax = areaAxis(w, out), ay = areaAxis(h, out);
  const rows = new Float64Array(h * out);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let j = 0; j < out; j++) {
      const ii = ax.idx[j], ww = ax.wts[j];
      let s = 0;
      for (let k = 0; k < ii.length; k++) s += lin[r + ii[k]] * ww[k];
      rows[y * out + j] = s;
    }
  }
  for (let i = 0; i < out; i++) {
    const ii = ay.idx[i], ww = ay.wts[i];
    for (let j = 0; j < out; j++) {
      let s = 0;
      for (let k = 0; k < ii.length; k++) s += rows[ii[k] * out + j] * ww[k];
      res[i * out + j] = finish(s);
    }
  }
  return res;
}

/**
 * RGBA (unpremultiplied, sRGB) -> out x out luminance bytes, area-averaged in
 * linear light. Transparent pixels count as black (lowest ground).
 */
export function rgbaToHeight(rgba, w, h, out = TABLE_SIZE) {
  const f = rgbaToHeightF(rgba, w, h, out, 'luma');
  const bytes = new Uint8Array(f.length);
  for (let i = 0; i < f.length; i++) bytes[i] = Math.round(f[i] * 255);
  return bytes;
}

// ---- file type -------------------------------------------------------------------------

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'jfif', 'webp', 'gif', 'bmp', 'avif']);

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * Decide how to read a file from its first bytes, falling back to name/MIME.
 * @returns {'image'|'svg'|'wav'|null}
 */
export function sniffType(head, name = '', mime = '') {
  const b = head || new Uint8Array(0);
  const tag = (o, s) => b.length >= o + s.length && [...s].every((ch, i) => b[o + i] === ch.charCodeAt(0));
  if ((tag(0, 'RIFF') || tag(0, 'RF64')) && tag(8, 'WAVE')) return 'wav';
  if (tag(0, 'RIFF') && tag(8, 'WEBP')) return 'image';
  if (b.length >= 4 && b[0] === 0x89 && tag(1, 'PNG')) return 'image';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image';
  if (tag(0, 'GIF8') || tag(0, 'BM')) return 'image';
  const ext = extOf(name);
  const type = String(mime || '').toLowerCase();
  let text = '';
  for (let i = 0; i < Math.min(b.length, 256); i++) text += String.fromCharCode(b[i]);
  text = text.replace(/^﻿|^\xEF\xBB\xBF/, '').trimStart();
  if (ext === 'svg' || type === 'image/svg+xml' || /^<svg[\s>]/i.test(text) || (/^<\?xml/i.test(text) && /<svg/i.test(text))) return 'svg';
  if (ext === 'wav' || ext === 'wave' || /^audio\/(x-)?(wav|wave|vnd\.wave)$/.test(type)) return 'wav';
  if (IMAGE_EXT.has(ext) || (type.startsWith('image/') && type !== 'image/svg+xml')) return 'image';
  return null;
}

// ---- wavetables ---------------------------------------------------------------------------

/**
 * How to cut `length` samples into single-cycle frames.
 * @returns {{frameSize: number, count: number, mode: 'clm'|'serum'|'pow2'|'single'|'chop'}}
 *   'chop' = arbitrary audio cut into 2048-sample slices (tail dropped).
 */
export function detectFrameSize(length, { clm = 0 } = {}) {
  const n = Math.floor(length);
  if (!(n >= 2)) throw new Error('This WAV file has no usable audio');
  if (clm >= 16 && n >= clm) return { frameSize: clm, count: Math.floor(n / clm), mode: 'clm' };
  if (n % 2048 === 0) return { frameSize: 2048, count: n / 2048, mode: 'serum' };
  for (const s of [1024, 512, 256]) if (n % s === 0) return { frameSize: s, count: n / s, mode: 'pow2' };
  if (n <= SINGLE_CYCLE_MAX) return { frameSize: n, count: 1, mode: 'single' };
  return { frameSize: 2048, count: Math.floor(n / 2048), mode: 'chop' };
}

/** Which frames to keep when there are more than `max`: evenly spread, first and last included. */
export function selectFrames(count, max = MAX_FRAMES) {
  if (count <= max) return Array.from({ length: count }, (_, i) => i);
  return Array.from({ length: max }, (_, i) => Math.round(i * (count - 1) / (max - 1)));
}

function isPow2(n) { return n > 0 && (n & (n - 1)) === 0; }

/** In-place iterative radix-2 complex FFT (forward, e^{-i}). */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/**
 * Band-limited resampling of one period: take the spectrum of the frame,
 * keep harmonics 1 .. min(N/2, outLen/2 - 1) (DC removed), and resynthesise
 * outLen samples. Exact for any frame length (FFT for powers of two, a direct
 * DFT of the kept harmonics otherwise).
 * @param {ArrayLike<number>} src
 * @param {number} offset first sample of the frame in src
 * @param {number} n frame length
 * @param {number} outLen power of two
 * @returns {Float64Array}
 */
export function resampleCycle(src, offset, n, outLen = TABLE_SIZE) {
  const H = Math.min(Math.floor(n / 2), outLen / 2 - 1);
  const ar = new Float64Array(H + 1), ai = new Float64Array(H + 1);
  if (isPow2(n)) {
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = src[offset + i];
    fft(re, im);
    for (let k = 1; k <= H; k++) { ar[k] = re[k]; ai[k] = im[k]; }
  } else {
    for (let k = 1; k <= H; k++) {
      let sr = 0, si = 0;
      const w = -2 * Math.PI * k / n;
      for (let i = 0; i < n; i++) {
        const x = src[offset + i];
        sr += x * Math.cos(w * i);
        si += x * Math.sin(w * i);
      }
      ar[k] = sr; ai[k] = si;
    }
  }
  // Resynthesis at the new length M: x[m] = Σ_k g_k Re(X_k e^{+i 2π k m / M}) with
  // g_k = 2/n (each positive harmonic stands for itself and its mirror image),
  // or 1/n for the source's Nyquist bin, which exists only once. A forward FFT
  // of conj(X_k) g_k yields conj of that sum, whose real part is the same.
  const re = new Float64Array(outLen), im = new Float64Array(outLen);
  for (let k = 1; k <= H; k++) {
    const g = (2 * k === n ? 1 : 2) / n;
    re[k] = ar[k] * g; im[k] = -ai[k] * g;
  }
  fft(re, im);
  return re;
}

/**
 * Remove the jump where an arbitrary (non-periodic) slice wraps around, by
 * spreading the end-to-start step linearly across the slice.
 */
export function closeLoop(frame, offset, n) {
  const out = new Float64Array(n);
  const step = frame[offset] - frame[offset + n - 1];
  for (let i = 0; i < n; i++) out[i] = frame[offset + i] + step * (i / n);
  return out;
}

/** Frames (Float64Array each) -> bytes, one shared scale so relative levels survive. */
export function framesToBytes(frames) {
  let peak = 0;
  for (const f of frames) for (let i = 0; i < f.length; i++) { const a = Math.abs(f[i]); if (a > peak) peak = a; }
  const w = frames[0] ? frames[0].length : 0;
  const bytes = new Uint8Array(w * frames.length);
  const g = peak > 1e-12 ? 127.5 / peak : 0;
  let o = 0;
  for (const f of frames) {
    for (let i = 0; i < w; i++) {
      const v = Math.round(127.5 + f[i] * g);
      bytes[o++] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  return bytes;
}

/**
 * Frames -> 16-bit samples (one shared scale, centred on 32767.5 like the
 * 8-bit form) as high and low byte planes. The high plane alone is a valid
 * 8-bit table for readers that ignore the low one.
 */
export function framesToPlanes(frames) {
  let peak = 0;
  for (const f of frames) for (let i = 0; i < f.length; i++) { const a = Math.abs(f[i]); if (a > peak) peak = a; }
  const w = frames[0] ? frames[0].length : 0;
  const hi = new Uint8Array(w * frames.length), lo = new Uint8Array(w * frames.length);
  const g = peak > 1e-12 ? 32767.5 / peak : 0;
  let o = 0;
  for (const f of frames) {
    for (let i = 0; i < w; i++, o++) {
      const v = Math.round(32767.5 + f[i] * g);
      const c = v < 0 ? 0 : v > 65535 ? 65535 : v;
      hi[o] = c >> 8;
      lo[o] = c & 255;
    }
  }
  return { hi, lo };
}

const yieldTask = () => new Promise(r => setTimeout(r, 0));

/**
 * Wavetable UserTerrain from any sample source. Only the frames that end up in
 * the table are read, so a long file costs no more than 256 frames' work.
 * @param {{length: number, clm?: number, read(start: number, n: number): ArrayLike<number>}} source
 * @param {{name?: string, yieldToUI?: boolean}} [o]
 */
export async function wavetableFromSource(source, { name = 'Wavetable', yieldToUI = true } = {}) {
  const det = detectFrameSize(source.length, { clm: source.clm || 0 });
  if (det.count < 1) throw new Error('This WAV file is shorter than one wavetable frame');
  const picks = selectFrames(det.count);
  const frames = [];
  let t0 = Date.now();
  let blockStart = nowMs();
  for (const f of picks) {
    const raw = source.read(f * det.frameSize, det.frameSize);
    const cycle = det.mode === 'chop' ? closeLoop(raw, 0, det.frameSize) : raw;
    frames.push(resampleCycle(cycle, 0, det.frameSize, TABLE_SIZE));
    if (yieldToUI && Date.now() - t0 > YIELD_MS) {
      importStats.maxBlockMs = Math.max(importStats.maxBlockMs, nowMs() - blockStart);
      await yieldTask();
      t0 = Date.now(); blockStart = nowMs();
    }
  }
  importStats.maxBlockMs = Math.max(importStats.maxBlockMs, nowMs() - blockStart);
  // The store needs h >= 2; a single cycle simply becomes two identical rows.
  if (frames.length === 1) frames.push(frames[0]);
  const [data, lo] = timedBlock(() => { const pl = framesToPlanes(frames); return [bytesToBase64(pl.hi), bytesToBase64(pl.lo)]; }, 'wavetable');
  return {
    name: cleanName(name),
    kind: 'wavetable',
    w: TABLE_SIZE,
    h: frames.length,
    mirror: 1,
    data,
    lo,
    frameSize: det.frameSize,
    frameMode: det.mode,
    frameCount: det.count,
  };
}

/**
 * Mono samples -> wavetable UserTerrain.
 * @param {Float32Array} mono
 * @param {{clm?: number, name?: string, yieldToUI?: boolean}} [o]
 */
export function wavetableFromSamples(mono, { clm = 0, ...rest } = {}) {
  return wavetableFromSource({ length: mono.length, clm, read: (start, n) => mono.subarray(start, start + n) }, rest);
}

export function mixToMono(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  const g = 1 / channels.length;
  for (const c of channels) for (let i = 0; i < n; i++) out[i] += c[i] * g;
  return out;
}

export function cleanName(name) {
  const base = String(name || '').replace(/\.[a-z0-9]{1,5}$/i, '').trim();
  return (base || 'Imported').slice(0, 80);
}

// ---- browser glue ----------------------------------------------------------------------------

function readFmtSampleRate(bytes) {
  // RIFF header + 'fmt ' as the first chunk is the common case; good enough for a hint.
  const u8 = new Uint8Array(bytes);
  for (let p = 12; p + 16 < u8.length && p < 4096;) {
    const id = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
    const size = u8[p + 4] | (u8[p + 5] << 8) | (u8[p + 6] << 16) | (u8[p + 7] << 24);
    if (id === 'fmt ') return (u8[p + 12] | (u8[p + 13] << 8) | (u8[p + 14] << 16) | (u8[p + 15] << 24)) >>> 0;
    p += 8 + size + (size & 1);
  }
  return 0;
}

/** A lazily-read sample source for a WAV file (exact samples, no resampling). */
async function audioSource(buffer) {
  let firstError = null;
  try {
    const info = wavInfo(new Uint8Array(buffer));
    return { length: info.frames, clm: info.clm, read: (start, n) => info.readMono(start, n) };
  } catch (err) {
    firstError = err;
  }
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OAC) throw firstError;
  // Decode at the file's own rate so frame sizes are not resampled.
  const rate = Math.min(384000, Math.max(8000, readFmtSampleRate(buffer) || 44100));
  try {
    const oc = new OAC(1, 1, rate);
    const audio = await oc.decodeAudioData(buffer.slice(0));
    const ch = [];
    for (let c = 0; c < audio.numberOfChannels; c++) ch.push(audio.getChannelData(c));
    const mono = mixToMono(ch);
    return { length: mono.length, clm: 0, read: (start, n) => mono.subarray(start, start + n) };
  } catch {
    throw firstError || new Error('This WAV file could not be decoded');
  }
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function loadImageElement(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This image could not be decoded')); };
    img.src = url;
  });
}

/**
 * An SVG with only a viewBox has no intrinsic size, and browsers then draw it
 * into a 300 x 150 default box. Give the root element an explicit size
 * (longest side 1024, the viewBox aspect) so it rasterises predictably.
 */
async function sizedSvgBlob(file) {
  const text = await file.text();
  if (typeof DOMParser !== 'function') return new Blob([text], { type: 'image/svg+xml' });
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length) {
    throw new Error('This SVG file could not be read');
  }
  const len = (a) => { const v = root.getAttribute(a); return v && !/%/.test(v) ? parseFloat(v) : NaN; };
  let w = len('width'), h = len('height');
  if (!(w > 0 && h > 0)) {
    const vb = String(root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const aw = vb[2] > 0 ? vb[2] : (w > 0 ? w : 1), ah = vb[3] > 0 ? vb[3] : (h > 0 ? h : 1);
    const k = 1024 / Math.max(aw, ah);
    w = aw * k; h = ah * k;
    root.setAttribute('width', String(w));
    root.setAttribute('height', String(h));
  }
  return new Blob([new XMLSerializer().serializeToString(doc)], { type: 'image/svg+xml' });
}

/** Browser: image file -> 256 x 256 luminance bytes (8-bit form of imageFileToHeightF). */
export async function imageFileToHeight(file, kind = 'image') {
  const { heights } = await imageFileToHeightF(file, kind, 'luma');
  const bytes = new Uint8Array(heights.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(heights[i] * 255);
  return bytes;
}

/** Browser: image file drawn by the browser -> {heights: Float32Array 0..1, n: 256}. */
export async function imageFileToHeightF(file, kind = 'image', channel = 'luma') {
  let src = null, w = 0, h = 0;
  const owned = [];
  if (kind !== 'svg' && typeof createImageBitmap === 'function') {
    try {
      src = await createImageBitmap(file);
      owned.push(src);
      w = src.width; h = src.height;
    } catch { src = null; }
  }
  if (!src) {
    const blob = kind === 'svg' ? await sizedSvgBlob(file) : file;
    src = await loadImageElement(blob);
    w = src.naturalWidth || 1024; h = src.naturalHeight || 1024;
  }
  try {
    if (!(w > 0 && h > 0)) throw new Error('This image has no pixels');
    const crop = centreCrop(w, h);
    // The browser does the big reduction (or rasterises SVG crisply) at 2x the
    // table size; the last 2:1 step is averaged here in linear light. Reading
    // back 512 x 512 instead of the full image keeps every main-thread step short.
    const T = kind === 'svg' || crop.size >= 2 * TABLE_SIZE ? 2 * TABLE_SIZE : Math.max(TABLE_SIZE, crop.size);
    let drawSrc = src, sx = crop.sx, sy = crop.sy, sw = crop.size;
    if (owned.length) {
      try {
        drawSrc = await createImageBitmap(src, crop.sx, crop.sy, crop.size, crop.size, { resizeWidth: T, resizeHeight: T, resizeQuality: 'high' });
        owned.push(drawSrc);
        sx = 0; sy = 0; sw = T;
      } catch { drawSrc = src; }
    }
    const canvas = makeCanvas(T, T);
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    const rgba = timedBlock(() => {
      g.drawImage(drawSrc, sx, sy, sw, sw, 0, 0, T, T);
      return g.getImageData(0, 0, T, T).data;
    }, 'canvas');
    await yieldTask();
    return { heights: timedBlock(() => rgbaToHeightF(rgba, T, T, TABLE_SIZE, channel), 'reduce'), n: TABLE_SIZE };
  } finally {
    for (const b of owned) { try { b.close(); } catch { /* ignore */ } }
  }
}

function slotName(slot) {
  if (slot === 0 || slot === 'A' || slot === 'a') return 'A';
  if (slot === 1 || slot === 'B' || slot === 'b') return 'B';
  return null;
}

export const DEFAULT_SMOOTH = 0.3;

/** Normalised image import options (see the header comment). */
export function importOptions(o) {
  const src = o && typeof o === 'object' ? o : {};
  const smooth = typeof src.smooth === 'number' && Number.isFinite(src.smooth) ? Math.max(0, Math.min(1, src.smooth)) : DEFAULT_SMOOTH;
  return {
    channel: CHANNELS.includes(src.channel) ? src.channel : 'luma',
    smooth,
    tile: src.tile === 'wrap' ? 'wrap' : 'mirror',
  };
}

/**
 * Height field of an image file: our own PNG reader for PNG (full bit depth,
 * samples as data), the browser's decoder for everything else, and for PNG
 * only when this browser cannot inflate (no DecompressionStream). A PNG our
 * reader finds damaged is refused with its reason rather than handed to the
 * browser, which would happily return the readable top part of a cut-off
 * file and leave the rest of the terrain flat.
 * @returns {Promise<{heights: Float32Array, n: number, via: string, bits: number}>}
 */
async function imageHeights(file, kind, head, channel) {
  if (kind === 'image' && isPng(head) && typeof DecompressionStream === 'function') {
    const r = await heightFromPng(new Uint8Array(await file.arrayBuffer()), { channel, size: TABLE_SIZE, stats: importStats });
    return { heights: r.heights, n: r.n, via: 'png', bits: r.bitDepth };
  }
  const r = await imageFileToHeightF(file, kind, channel);
  return { ...r, via: 'canvas', bits: 8 };
}

// Imports into the same slot commit in the order they were started, so a slow
// big file chosen first can never overwrite a small one chosen after it.
const slotQueues = new WeakMap();   // store -> Map(slot key -> promise of the latest import)

/**
 * Import a File/Blob into a part's terrain slot: sets parts.N.userTerrain[slot]
 * and parts.N.params.terrain[slot] = Imported in one store.batch.
 * @param {object} [options] images only: { channel: 'luma'|'r'|'g'|'b', smooth: 0..1 (default 0.3), tile: 'mirror'|'wrap' }
 * @returns {Promise<object>} the stored UserTerrain
 */
export async function importTerrainFile(store, part, slot, file, options) {
  const p = Math.round(Number(part));
  if (!(p >= 0 && p < NUM_PARTS)) throw new Error(`There is no part ${part}`);
  const S = slotName(slot);
  if (!S) throw new Error(`Terrain slot must be A or B, not ${slot}`);
  if (!file || typeof file.slice !== 'function') throw new Error('No file was given to import');
  const label = file.name ? `"${String(file.name).slice(0, 60)}"` : 'That file';
  if (!(file.size > 0)) throw new Error(`${label} is empty`);
  if (file.size > MAX_IMPORT_BYTES) {
    throw new Error(`${label} is ${(file.size / 1048576).toFixed(1)} MB; files up to 25 MB can be imported`);
  }
  let slotQueue = slotQueues.get(store);
  if (!slotQueue) { slotQueue = new Map(); slotQueues.set(store, slotQueue); }
  const key = `${p}${S}`;
  const prev = slotQueue.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chain = prev.then(() => mine);
  slotQueue.set(key, chain);
  try {
    const ut = await readTerrainFile(file, label, options);
    await prev;
    importStats.imports++;
    timedBlock(() => store.batch(() => {
      store.set(`parts.${p}.userTerrain.${S}`, ut, { source: 'import' });
      store.set(`parts.${p}.params.terrain${S}`, TERRAIN_INDEX.user, { source: 'import' });
    }), 'store');
    return ut;
  } finally {
    release();
    if (slotQueue.get(key) === chain) slotQueue.delete(key);
  }
}

/** File -> UserTerrain (no store involved). */
export async function readTerrainFile(file, label = 'That file', options) {
  const head = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  const kind = sniffType(head, file.name, file.type);
  if (!kind) throw new Error(`${label} is not an image or a WAV file. Use PNG, JPEG, WebP, GIF, BMP or SVG, or a WAV wavetable`);
  if (kind === 'wav') {
    const source = await audioSource(await file.arrayBuffer());
    const { frameSize, frameMode, frameCount, ...rest } = await wavetableFromSource(source, { name: file.name || 'Wavetable' });
    importStats.last = { via: 'wav', frameSize, frameMode, frameCount, h: rest.h };
    return rest;
  }
  const opts = importOptions(options);
  let { heights, n, via, bits } = await imageHeights(file, kind, head, opts.channel);
  if (n < 2) { heights = new Float32Array(4).fill(heights[0] || 0); n = 2; }
  const smoothed = timedBlock(() => smoothHeights(heights, n, opts.smooth, opts.tile), 'smooth');
  const planes = timedBlock(() => heightsToPlanes(smoothed), 'planes');
  const data = timedBlock(() => bytesToBase64(planes.hi), 'base64');
  const lo = timedBlock(() => bytesToBase64(planes.lo), 'base64');
  importStats.last = { via, bits, n, ...opts };
  return { name: cleanName(file.name || 'Image'), kind: 'image', w: n, h: n, mirror: opts.tile === 'wrap' ? 0 : 1, data, lo };
}
