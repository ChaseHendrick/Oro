// Small DSP helpers shared by the pedal loop (ping / cross-correlation), the
// pitch tracker and the wavetable capture. Pure functions, no Web Audio, so the
// same code runs in Node tests, on the main thread and inside the AudioWorklet.
//
// Kept separate from src/audio/importers.js on purpose: that file belongs to the
// audio host and pulls in image decoding; the worklet bundle should stay tiny.

/** Smallest power of two >= n (n >= 1). */
export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** In-place iterative radix-2 complex FFT, forward (e^{-i}). Length must be a power of two. */
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
 * Radix-2 complex FFT with precomputed bit reversal and twiddles, for code
 * that runs the same size thousands of times a second (the pitch tracker).
 */
export function createFft(n) {
  const rev = new Uint32Array(n);
  const bits = Math.round(Math.log2(n));
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const half = n >> 1;
  const cs = new Float64Array(half), sn = new Float64Array(half);
  for (let k = 0; k < half; k++) { cs[k] = Math.cos(2 * Math.PI * k / n); sn[k] = -Math.sin(2 * Math.PI * k / n); }
  function forward(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const h = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0, t = 0; k < h; k++, t += step) {
          const a = i + k, b = a + h;
          const wr = cs[t], wi = sn[t];
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }
  function inverse(re, im) {
    for (let i = 0; i < n; i++) im[i] = -im[i];
    forward(re, im);
    const g = 1 / n;
    for (let i = 0; i < n; i++) { re[i] *= g; im[i] = -im[i] * g; }
  }
  return { n, forward, inverse };
}

/**
 * Linear autocorrelation r[t] = sum_j x[j] x[j + t] of up to maxLen real
 * samples, via a real-input FFT of size N = 2 * nextPow2(maxLen) done as two
 * complex FFTs of size N / 2 (pack even/odd samples, unpack, square, repack).
 * About four times cheaper than the plain complex route.
 */
export function createAutocorrelator(maxLen) {
  const N = 2 * nextPow2(maxLen), M = N >> 1;
  const f = createFft(M);
  const zr = new Float64Array(M), zi = new Float64Array(M);
  const pw = new Float64Array(M + 1);
  const c = new Float64Array(M + 1), s = new Float64Array(M + 1);
  for (let k = 0; k <= M; k++) { c[k] = Math.cos(2 * Math.PI * k / N); s[k] = Math.sin(2 * Math.PI * k / N); }
  const out = new Float64Array(N);
  /** Fills and returns `out` (length N): out[t] for t < len is the autocorrelation at lag t. */
  function compute(x, start = 0, len = x.length - start) {
    zr.fill(0); zi.fill(0);
    for (let j = 0; j < len; j++) { if (j & 1) zi[j >> 1] = x[start + j]; else zr[j >> 1] = x[start + j]; }
    f.forward(zr, zi);
    // Unpack the spectrum of the real signal: X[k] = E[k] + W^k O[k], W = e^{-2 pi i / N}.
    for (let k = 0; k <= M; k++) {
      const a = k % M, b = (M - k) % M;
      const Zr = zr[a], Zi = zi[a], Cr = zr[b], Ci = -zi[b];
      const Er = (Zr + Cr) * 0.5, Ei = (Zi + Ci) * 0.5;
      const Or = (Zi - Ci) * 0.5, Oi = -(Zr - Cr) * 0.5;
      const Xr = Er + c[k] * Or + s[k] * Oi;
      const Xi = Ei + c[k] * Oi - s[k] * Or;
      pw[k] = Xr * Xr + Xi * Xi;
    }
    // Repack the (real, even) power spectrum and invert with one half-size FFT.
    for (let k = 0; k < M; k++) {
      const Er = (pw[k] + pw[M - k]) * 0.5;
      const d = (pw[k] - pw[M - k]) * 0.5;
      const Or = d * c[k], Oi = d * s[k];
      zr[k] = Er - Oi;
      zi[k] = Or;
    }
    f.inverse(zr, zi);
    for (let m = 0; m < M; m++) { out[2 * m] = zr[m]; out[2 * m + 1] = zi[m]; }
    return out;
  }
  return { N, compute };
}

/** In-place inverse FFT (scaled by 1/n), via the conjugation trick. */
export function ifft(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  const g = 1 / n;
  for (let i = 0; i < n; i++) { re[i] *= g; im[i] = -im[i] * g; }
}

/**
 * Linear cross-correlation c[l] = sum_n a[n] * b[n + l] for l = 0 .. maxLag,
 * i.e. how well `b` matches `a` delayed by l samples. FFT based, zero padded so
 * nothing wraps around.
 * @param {ArrayLike<number>} a reference
 * @param {ArrayLike<number>} b signal that lags the reference
 * @param {number} maxLag
 * @returns {Float64Array} length maxLag + 1
 */
export function crossCorrelate(a, b, maxLag = b.length - 1) {
  const L = Math.max(0, Math.min(Math.floor(maxLag), b.length - 1));
  const n = nextPow2(a.length + b.length);
  const ar = new Float64Array(n), ai = new Float64Array(n);
  const br = new Float64Array(n), bi = new Float64Array(n);
  for (let i = 0; i < a.length; i++) ar[i] = a[i];
  for (let i = 0; i < b.length; i++) br[i] = b[i];
  fft(ar, ai);
  fft(br, bi);
  // conj(A) * B  ->  correlation with b lagging a.
  for (let k = 0; k < n; k++) {
    const r = ar[k] * br[k] + ai[k] * bi[k];
    const i = ar[k] * bi[k] - ai[k] * br[k];
    ar[k] = r; ai[k] = i;
  }
  ifft(ar, ai);
  return ar.slice(0, L + 1);
}

/**
 * Parabolic interpolation around index i of y: returns the fractional offset
 * (-0.5..0.5) of the true extremum and its interpolated value.
 */
export function parabolic(y, i) {
  if (i <= 0 || i >= y.length - 1) return { offset: 0, value: y[i] };
  const a = y[i - 1], b = y[i], c = y[i + 1];
  const den = a - 2 * b + c;
  if (Math.abs(den) < 1e-18) return { offset: 0, value: b };
  let offset = 0.5 * (a - c) / den;
  if (offset > 0.5) offset = 0.5; else if (offset < -0.5) offset = -0.5;
  return { offset, value: b - 0.25 * (a - c) * offset };
}

export const dbToGain = (db) => Math.pow(10, db / 20);
export const gainToDb = (g) => (g > 1e-12 ? 20 * Math.log10(g) : -240);

/** RMS of a[start .. start + n). */
export function rms(a, start = 0, n = a.length - start) {
  let s = 0;
  const end = Math.min(a.length, start + n);
  for (let i = start; i < end; i++) s += a[i] * a[i];
  return end > start ? Math.sqrt(s / (end - start)) : 0;
}

/** Largest absolute sample value. */
export function peakAbs(a) {
  let p = 0;
  for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > p) p = v; }
  return p;
}

/** Frequency (Hz) -> fractional MIDI note number (A4 = 440 Hz = 69). */
export function freqToMidi(f) { return 69 + 12 * Math.log2(f / 440); }
/** Fractional MIDI note -> Hz. */
export function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 (with padding) of a byte array, without btoa (works in Node and workers). */
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

/** Small deterministic PRNG (for test signals and dither); returns 0..1. */
export function makeRandom(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
