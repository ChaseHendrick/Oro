// Height fields at full precision: the float pipeline between a decoded image
// and a stored UserTerrain, and the matching high-precision decoder that the
// terrain jobs use for it.
//
//   PNG (any depth) --heightFromPng--> Float32 0..1, n x n (area-averaged)
//   other images (canvas) ------------> Float32 0..1 (importers.js)
//        -> smoothHeights (Gaussian, mirror or wrap edges)
//        -> heightsToPlanes: 16-bit, range stretched, as two byte planes
//
// Storage: UserTerrain.data stays what every reader expects (one byte per
// sample, base64): it is the HIGH byte of the 16-bit value. The optional
// UserTerrain.lo holds the LOW bytes. Readers that do not know `lo` get the
// same terrain at 8 bits; decodeUserTerrainPrecise() combines both. Stretching
// the range before quantising costs nothing (tables are normalised to zero
// mean and unit peak anyway) and spends all 65536 levels on the relief.

import { base64ToBytes, normalise } from '../dsp/terrains.js';
import { decodePngRows, readPngChunks, expandPalette } from './png.js';

export const SMOOTH_MAX_SIGMA = 8;     // Gaussian sigma (in 256-sample units) at smooth = 1
export const CHANNELS = ['luma', 'r', 'g', 'b'];

// ---- colour ----------------------------------------------------------------------

/** sRGB code value 0..1 -> linear light. */
export function srgbDecode(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
/** Linear light -> sRGB code value 0..1 (float, not quantised). */
export function srgbEncode(y) {
  if (!(y > 0)) return 0;
  if (y >= 1) return 1;
  return y <= 0.0031308 ? 12.92 * y : 1.055 * Math.pow(y, 1 / 2.4) - 0.055;
}

let lut8 = null, lut16 = null;
function linLut(bits) {
  if (bits === 16) {
    if (!lut16) { lut16 = new Float32Array(65536); for (let i = 0; i < 65536; i++) lut16[i] = srgbDecode(i / 65535); }
    return lut16;
  }
  if (!lut8) { lut8 = new Float32Array(256); for (let i = 0; i < 256; i++) lut8[i] = srgbDecode(i / 255); }
  return lut8;
}

// ---- geometry ----------------------------------------------------------------------

/** Largest centred square inside w x h. */
export function centreCrop(w, h) {
  const size = Math.max(1, Math.min(w, h));
  return { sx: Math.floor((w - size) / 2), sy: Math.floor((h - size) / 2), size };
}

/**
 * Area weights for shrinking `size` samples to `n` cells (size >= n): source
 * sample i covers [i, i+1); cell j covers [j·s, (j+1)·s) with s = size / n.
 * Each sample overlaps at most two cells. Returns cell/weight arrays (c1 = -1
 * when the sample lies inside one cell); every cell's weights sum to s.
 */
export function axisWeights(size, n) {
  const s = size / n;
  const c0 = new Int32Array(size), c1 = new Int32Array(size);
  const w0 = new Float64Array(size), w1 = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const a = Math.min(n - 1, Math.floor(i / s + 1e-9));
    const edge = (a + 1) * s;
    c0[i] = a;
    if (i + 1 <= edge + 1e-9 || a + 1 >= n) { w0[i] = 1; c1[i] = -1; w1[i] = 0; }
    else { w0[i] = edge - i; c1[i] = a + 1; w1[i] = i + 1 - edge; }
  }
  return { s, c0, c1, w0, w1 };
}

// ---- PNG -> heights -----------------------------------------------------------------

/**
 * Per-pixel value function for a PNG: grey samples (and single channels) are
 * data and are averaged as they are; 'luma' of a colour image is perceived
 * brightness, averaged in linear light and re-encoded at the end, exactly like
 * the canvas path. Transparent pixels count as the lowest ground.
 */
function pngValueFn(png, channel) {
  const { colorType, bitDepth } = png.header;
  const max = (1 << bitDepth) - 1;
  const inv = 1 / max;
  const trns = png.trns;
  const t16 = (o) => (trns[o] << 8) | trns[o + 1];
  const ci = channel === 'r' ? 0 : channel === 'g' ? 1 : channel === 'b' ? 2 : -1;
  if (colorType === 0) {
    const tg = trns && trns.length >= 2 ? t16(0) : -1;
    return { linear: false, fn: (row, k, read) => { const s = read(row, k, 0); return s === tg ? 0 : s * inv; } };
  }
  if (colorType === 4) return { linear: false, fn: (row, k, read) => read(row, k, 0) * inv * (read(row, k, 1) * inv) };
  if (colorType === 3) {
    const pal = expandPalette(png.palette, trns);
    const vals = new Float64Array(256);
    const L = linLut(8);
    for (let i = 0; i < 256; i++) {
      if (i >= pal.entries) { vals[i] = 0; continue; }
      const o = i * pal.channels;
      const a = pal.channels === 4 ? pal.data[o + 3] / 255 : 1;
      vals[i] = (ci < 0 ? 0.2126 * L[pal.data[o]] + 0.7152 * L[pal.data[o + 1]] + 0.0722 * L[pal.data[o + 2]] : pal.data[o + ci] / 255) * a;
    }
    return { linear: ci < 0, fn: (row, k, read) => vals[read(row, k, 0)] };
  }
  // RGB (2) and RGBA (6)
  const hasA = colorType === 6;
  const tr = !hasA && trns && trns.length >= 6 ? [t16(0), t16(2), t16(4)] : null;
  const alpha = hasA ? (row, k, read) => read(row, k, 3) * inv
    : tr ? (row, k, read) => (read(row, k, 0) === tr[0] && read(row, k, 1) === tr[1] && read(row, k, 2) === tr[2] ? 0 : 1)
      : null;
  if (ci >= 0) {
    return { linear: false, fn: alpha ? (row, k, read) => read(row, k, ci) * inv * alpha(row, k, read) : (row, k, read) => read(row, k, ci) * inv };
  }
  const L = linLut(bitDepth);
  const lum = (row, k, read) => 0.2126 * L[read(row, k, 0)] + 0.7152 * L[read(row, k, 1)] + 0.0722 * L[read(row, k, 2)];
  return { linear: true, fn: alpha ? (row, k, read) => lum(row, k, read) * alpha(row, k, read) : lum };
}

/**
 * Decode a PNG straight into an n x n height field (centre-cropped square,
 * area-averaged, never upsampled: n = min(size, crop)).
 * @param {Uint8Array} bytes the PNG file
 * @param {{channel?: 'luma'|'r'|'g'|'b', size?: number, stats?: object}} [o]
 * @returns {Promise<{heights: Float32Array, n: number, bitDepth: number, colorType: number, width: number, height: number}>}
 */
export async function heightFromPng(bytes, { channel = 'luma', size = 256, stats } = {}) {
  const png = readPngChunks(bytes);
  const { width: W, height: H, bitDepth, colorType } = png.header;
  const crop = centreCrop(W, H);
  const n = Math.max(1, Math.min(size, crop.size));
  const ax = axisWeights(crop.size, n);
  const { linear, fn } = pngValueFn(png, CHANNELS.includes(channel) ? channel : 'luma');
  const acc = new Float64Array(n * n);
  const line = new Float64Array(n);
  const x1 = crop.sx + crop.size;
  await decodePngRows(bytes, ({ y, x0, dx, count, row, read }) => {
    const yy = y - crop.sy;
    if (yy < 0 || yy >= crop.size) return;
    // pixels of this (pass) row that fall inside the crop
    const kStart = Math.max(0, Math.ceil((crop.sx - x0) / dx));
    const kEnd = Math.min(count - 1, Math.floor((x1 - 1 - x0) / dx));
    if (kEnd < kStart) return;
    line.fill(0);
    for (let k = kStart; k <= kEnd; k++) {
      const xx = x0 + k * dx - crop.sx;
      const v = fn(row, k, read);
      line[ax.c0[xx]] += v * ax.w0[xx];
      const c1 = ax.c1[xx];
      if (c1 >= 0) line[c1] += v * ax.w1[xx];
    }
    const r0 = ax.c0[yy] * n, w0 = ax.w0[yy];
    for (let j = 0; j < n; j++) acc[r0 + j] += line[j] * w0;
    const c1 = ax.c1[yy];
    if (c1 >= 0) {
      const r1 = c1 * n, w1 = ax.w1[yy];
      for (let j = 0; j < n; j++) acc[r1 + j] += line[j] * w1;
    }
  }, { info: png, stats });
  const norm = 1 / (ax.s * ax.s);
  const heights = new Float32Array(n * n);
  for (let i = 0; i < heights.length; i++) heights[i] = linear ? srgbEncode(acc[i] * norm) : acc[i] * norm;
  return { heights, n, bitDepth, colorType, width: W, height: H };
}

// ---- smoothing and storage --------------------------------------------------------

/** smooth 0..1 -> Gaussian sigma in samples of an n-sample-wide field. */
export function smoothSigma(amount, n = 256) {
  const a = Math.max(0, Math.min(1, Number.isFinite(amount) ? amount : 0));
  return SMOOTH_MAX_SIGMA * Math.pow(a, 1.5) * (n / 256);
}

function edgeIndex(k, n, mirror) {
  if (mirror) {
    const period = 2 * n;
    let m = k % period;
    if (m < 0) m += period;
    return m < n ? m : period - 1 - m;
  }
  let m = k % n;
  return m < 0 ? m + n : m;
}

/**
 * Box widths whose three successive passes approximate a Gaussian of `sigma`
 * (the widths are odd; see "fast almost-Gaussian filtering").
 */
export function gaussBoxes(sigma, passes = 3) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / passes + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - passes * wl * wl - 4 * passes * wl - 3 * passes) / (-4 * wl - 4));
  return Array.from({ length: passes }, (_, i) => (i < m ? wl : wu));
}

/**
 * Near-Gaussian blur of an n x n field: three running-sum box passes per
 * axis, so the cost does not grow with the amount (a few milliseconds at
 * 256 x 256 even at full smoothing). 'mirror' reflects at the edges (the same
 * reflection the mirrored terrain uses to tile), 'wrap' treats the field as
 * already periodic.
 */
export function smoothHeights(src, n, amount, tile = 'mirror') {
  const sigma = smoothSigma(amount, n);
  if (sigma < 0.2) return Float32Array.from(src);
  const mirror = tile !== 'wrap';
  const boxes = gaussBoxes(sigma).map(w => Math.min((w - 1) >> 1, n));
  let a = Float32Array.from(src);
  let b = new Float32Array(n * n);
  const line = new Float64Array(n + 2 * Math.max(...boxes) + 1);
  // One box pass along x (alongX) or y, from `from` into `to`.
  const pass = (from, to, r, alongX) => {
    if (r < 1) { to.set(from); return; }
    const inv = 1 / (2 * r + 1);
    for (let k = 0; k < n; k++) {
      // padded copy of row/column k: indices -r .. n-1+r
      for (let i = -r; i < n + r; i++) {
        const j = edgeIndex(i, n, mirror);
        line[i + r] = alongX ? from[k * n + j] : from[j * n + k];
      }
      let acc = 0;
      for (let i = 0; i < 2 * r + 1; i++) acc += line[i];
      for (let i = 0; i < n; i++) {
        if (alongX) to[k * n + i] = acc * inv; else to[i * n + k] = acc * inv;
        acc += line[i + 2 * r + 1] - line[i];
      }
    }
  };
  for (const alongX of [true, false]) {
    for (const r of boxes) { pass(a, b, r, alongX); const t = a; a = b; b = t; }
  }
  return a;
}

/**
 * Float samples -> 16-bit values stretched over min..max, as high and low
 * byte planes. A flat field becomes all zeros.
 */
export function heightsToPlanes(values) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const n = values.length;
  const hiBytes = new Uint8Array(n), loBytes = new Uint8Array(n);
  const span = hi - lo;
  if (!(span > 1e-12)) return { hi: hiBytes, lo: loBytes, min: Number.isFinite(lo) ? lo : 0, max: Number.isFinite(hi) ? hi : 0 };
  const g = 65535 / span;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    const q = Number.isFinite(v) ? Math.round((v - lo) * g) : 0;
    const c = q < 0 ? 0 : q > 65535 ? 65535 : q;
    hiBytes[i] = c >> 8;
    loBytes[i] = c & 255;
  }
  return { hi: hiBytes, lo: loBytes, min: lo, max: hi };
}

// ---- decoding stored terrains at 16 bits ------------------------------------------

function catmull(p0, p1, p2, p3, t) {
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

function boxBlurAxis(src, w, h, radius, alongX, mirror) {
  if (radius < 0.5) return src;
  const out = new Float32Array(w * h);
  const r = Math.max(1, Math.round(radius));
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      if (alongX) for (let k = -r; k <= r; k++) s += src[y * w + edgeIndex(x + k, w, mirror)];
      else for (let k = -r; k <= r; k++) s += src[edgeIndex(y + k, h, mirror) * w + x];
      out[y * w + x] = s * inv;
    }
  }
  return out;
}

/** True when a stored UserTerrain carries the low byte plane. */
export function hasLowPlane(ut) {
  return !!ut && typeof ut.lo === 'string' && ut.lo.length > 0;
}

/**
 * UserTerrain with a `lo` plane -> normalised size x size table, the 16-bit
 * counterpart of decodeUserTerrain() in src/dsp/terrains.js (same Catmull-Rom
 * resampling, box pre-blur when shrinking and [1 2 1] finishing pass).
 * One difference by design: an image stored with mirror = 0 was imported with
 * "Wrap", i.e. the person says it already tiles, so it is not cross-faded.
 */
export function decodeUserTerrainPrecise(userTerrain, size = 512) {
  const S = Math.max(4, Math.round(size));
  const ut = userTerrain || {};
  const w = Math.max(2, Math.round(ut.w || 0)), h = Math.max(2, Math.round(ut.h || 0));
  const hiB = base64ToBytes(ut.data);
  const loB = base64ToBytes(ut.lo);
  let src = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (i >= hiB.length) { src[i] = 0; continue; }
    src[i] = i < loB.length ? ((hiB[i] << 8) | loB[i]) / 32767.5 - 1 : hiB[i] / 127.5 - 1;
  }
  const wavetable = ut.kind === 'wavetable';
  const mirror = !!ut.mirror;
  const mirrorX = mirror && !wavetable;
  const mirrorY = mirror;
  const sx = (mirrorX ? 2 * w : w) / S, sy = (mirrorY ? 2 * h : h) / S;
  if (sx > 1.5) src = boxBlurAxis(src, w, h, (sx - 1) / 2, true, mirrorX);
  if (sy > 1.5) src = boxBlurAxis(src, w, h, (sy - 1) / 2, false, mirrorY);

  let res = new Float32Array(S * S);
  const xi = new Int32Array(4 * S), xt = new Float64Array(S);
  for (let i = 0; i < S; i++) {
    const x = i * sx, x0 = Math.floor(x);
    xt[i] = x - x0;
    for (let k = 0; k < 4; k++) xi[4 * i + k] = edgeIndex(x0 - 1 + k, w, mirrorX);
  }
  const rows = new Float64Array(4);
  for (let j = 0; j < S; j++) {
    const y = j * sy, y0 = Math.floor(y), ty = y - y0;
    const r = [0, 1, 2, 3].map(k => edgeIndex(y0 - 1 + k, h, mirrorY) * w);
    for (let i = 0; i < S; i++) {
      for (let k = 0; k < 4; k++) rows[k] = catmull(src[r[k] + xi[4 * i]], src[r[k] + xi[4 * i + 1]], src[r[k] + xi[4 * i + 2]], src[r[k] + xi[4 * i + 3]], xt[i]);
      res[j * S + i] = catmull(rows[0], rows[1], rows[2], rows[3], ty);
    }
  }
  if (wavetable && !mirror) {
    // frame axis is not periodic: cross-fade with a half-period shifted copy (as the DSP decoder does)
    const tmp = new Float32Array(S * S);
    const half = S >> 1;
    for (let j = 0; j < S; j++) {
      const wgt = Math.sin(Math.PI * j / S) ** 2;
      const jj = ((j + half) % S) * S;
      for (let i = 0; i < S; i++) tmp[j * S + i] = wgt * res[j * S + i] + (1 - wgt) * res[jj + i];
    }
    res = tmp;
  }
  const tmp = new Float32Array(S * S);
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const l = res[j * S + (i === 0 ? S - 1 : i - 1)], rr = res[j * S + (i === S - 1 ? 0 : i + 1)];
      tmp[j * S + i] = 0.25 * l + 0.5 * res[j * S + i] + 0.25 * rr;
    }
  }
  for (let j = 0; j < S; j++) {
    const up = (j === 0 ? S - 1 : j - 1) * S, dn = (j === S - 1 ? 0 : j + 1) * S;
    for (let i = 0; i < S; i++) res[j * S + i] = 0.25 * tmp[up + i] + 0.5 * tmp[j * S + i] + 0.25 * tmp[dn + i];
  }
  for (let i = 0; i < res.length; i++) if (!Number.isFinite(res[i])) res[i] = 0;
  return normalise(res);
}
