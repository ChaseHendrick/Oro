// Time stretch (v2.8): change the length of recorded audio without changing
// its pitch, offline, with WSOLA (waveform-similarity overlap-add).
//
// The output is built from Hann-windowed frames of the input placed every
// `hop` samples (half a frame). The frames are read from the input at
// hop / ratio intervals, so a ratio above 1 reads more slowly (a longer
// result) and below 1 faster. Each frame's read position may move up to
// `seek` seconds either way, to wherever the input looks most like the
// natural continuation of the previous frame (the highest normalised cross
// correlation over the half frame they overlap), so the waveform carries on
// smoothly and the pitch stays where it was.
//
// Plain functions on Float32Arrays, no allocation per sample, no DOM: the
// looper's Follow tempo and the noise recording's Stretch run it on the main
// thread, and the tests run it in Node. The search is done coarsely first
// (every few lags, every few samples) and refined around the best lag at full
// resolution, which keeps a minute of stereo audio well under a second.
//
// `loop: true` treats the input as a loop (reads wrap around) and makes the
// output one too: frames wrap around the end of the output, so a stretched
// loop stays seamless. A ratio of exactly 1 returns copies of the input.

export const MIN_RATIO = 0.125;
export const MAX_RATIO = 8;
const FRAME_SECONDS = 0.046;   // about 2200 samples at 48 kHz
const SEEK_SECONDS = 0.012;    // covers one period of pitches down to about 83 Hz

const clampRatio = (r) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));

/** Periodic Hann window of length n (sums to 1 at 50% overlap). */
export function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** A copy of `x` with `pad` samples before and after: wrapped around for a loop, zeros otherwise. */
function padded(x, pad, loop) {
  const n = x.length;
  const out = new Float32Array(n + 2 * pad);
  out.set(x, pad);
  if (loop && n > 0) {
    for (let i = 0; i < pad; i++) {
      out[pad - 1 - i] = x[(((n - 1 - i) % n) + n) % n];
      out[pad + n + i] = x[i % n];
    }
  }
  return out;
}

/**
 * Normalised cross correlation of a[ia ..] and b[ib ..] over `len` samples,
 * reading every `stride`-th sample. 0 when either side is silent.
 */
function ncc(a, ia, b, ib, len, stride) {
  let ab = 0, aa = 0, bb = 0;
  for (let j = 0; j < len; j += stride) {
    const x = a[ia + j], y = b[ib + j];
    ab += x * y; aa += x * x; bb += y * y;
  }
  const d = aa * bb;
  return d > 1e-20 ? ab / Math.sqrt(d) : 0;
}

/**
 * Stretch one or more channels to `ratio` times their length, keeping the pitch.
 *
 * @param {Float32Array|Float32Array[]} input one channel, or a list of equally long channels
 * @param {number} ratio output length / input length (MIN_RATIO..MAX_RATIO)
 * @param {object} [o]
 * @param {number} [o.sampleRate] sets the frame and search sizes (48000)
 * @param {boolean} [o.loop] the input is a loop: wrap reads, and make the output loop seamlessly
 * @param {number} [o.length] exact output length in samples (overrides round(n * ratio))
 * @returns {Float32Array|Float32Array[]} the same shape as `input`
 */
export function timeStretch(input, ratio, { sampleRate = 48000, loop = false, length } = {}) {
  const single = !Array.isArray(input);
  const chans = single ? [input] : input;
  const n = chans.length ? chans[0].length : 0;
  let r = Number(ratio);
  if (!Number.isFinite(r) || r <= 0) r = 1;
  const M = Math.max(1, Math.round(Number.isFinite(length) && length > 0 ? length : n * clampRatio(r)));
  if (Number.isFinite(length) && length > 0 && n > 0) r = M / n;
  r = clampRatio(r);
  const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
  // Identity and degenerate inputs: copies (zero-padded or cut to the length).
  if (n < 4 || M === n) {
    const out = chans.map((c) => { const o = new Float32Array(M); o.set(c.subarray(0, Math.min(n, M))); return o; });
    return single ? out[0] : out;
  }

  let N = 2 * Math.round((FRAME_SECONDS * sr) / 2);
  N = Math.max(64, Math.min(N, 2 * Math.floor(Math.max(n, M) / 2)));
  const H = N >> 1;
  const D = Math.max(1, Math.round(SEEK_SECONDS * sr));
  const coarse = Math.max(1, Math.round(sr / 8000));   // lag step of the first pass
  const stride = Math.max(1, Math.round(sr / 12000));  // samples skipped by the first pass
  const win = hann(N);

  // Mono mix for the search; the same read positions are used for every channel.
  const mono = new Float32Array(n);
  for (const c of chans) for (let i = 0; i < n; i++) mono[i] += c[i];
  const pad = N + D + H + 4;
  const pm = padded(mono, pad, loop);
  const pc = chans.map(c => padded(c, pad, loop));
  const lo = -pad, hi = n + pad - N - 1;               // valid frame starts in padded space
  const inRange = (s) => Math.min(hi, Math.max(lo, s));

  // Output frames: centred on k * step, so the first frame's peak is at sample 0.
  let K, outStart, inStart;
  if (loop) {
    K = Math.max(1, Math.round(M / H));
    outStart = (k) => Math.round((k * M) / K) - H;
    inStart = (k) => (k * n) / K - H;
  } else {
    K = Math.ceil(M / H) + 2;
    outStart = (k) => k * H - H;
    inStart = (k) => (k * H) / r - H;
  }

  const acc = chans.map(() => new Float64Array(M));
  const wsum = new Float64Array(M);
  let prev = null, first = null;
  for (let k = 0; k < K; k++) {
    const nominal = inRange(Math.round(inStart(k)));
    let best = nominal;
    if (prev != null) {
      // Natural continuation of the previous frame (one output hop on), compared
      // over the half frame that overlaps.
      const target = inRange(prev + outStart(k) - outStart(k - 1));
      // In a loop the last frame also runs into the first one (across the seam):
      // its second half should look like the start of frame 0, one loop later.
      const hopOut = M - (outStart(k) + H);   // output samples from this frame to frame 0, one loop on
      const seam = loop && k === K - 1 && K > 2 ? first + n - hopOut : null;
      const score = (s, st) => {
        let sc = ncc(pm, s + pad, pm, target + pad, H, st);
        if (seam != null && s + hopOut <= hi) sc += ncc(pm, s + hopOut + pad, pm, first + n + pad, H, st);
        return sc;
      };
      let bestScore = -Infinity, bestLag = 0;
      for (let d = -D; d <= D; d += coarse) {
        const s = nominal + d;
        if (s < lo || s > hi) continue;
        const sc = score(s, stride);
        if (sc > bestScore) { bestScore = sc; bestLag = d; }
      }
      if (coarse > 1 && bestScore > -Infinity) {
        const center = bestLag;
        for (let d = center - coarse + 1; d <= center + coarse - 1; d++) {
          const s = nominal + d;
          if (d === center || d < -D || d > D || s < lo || s > hi) continue;
          const sc = score(s, 1);
          if (sc > bestScore) { bestScore = sc; bestLag = d; }
        }
      }
      if (bestScore > 0) best = nominal + bestLag;
    } else first = best;
    const o0 = outStart(k);
    for (let i = 0; i < N; i++) {
      let o = o0 + i;
      if (loop) o = ((o % M) + M) % M;
      else if (o < 0 || o >= M) continue;
      const w = win[i];
      const src = best + pad + i;
      for (let c = 0; c < pc.length; c++) acc[c][o] += w * pc[c][src];
      wsum[o] += w;
    }
    prev = best;
  }

  const out = acc.map((a) => {
    const o = new Float32Array(M);
    for (let i = 0; i < M; i++) {
      const w = wsum[i];
      const v = w > 1e-6 ? a[i] / w : 0;
      o[i] = Number.isFinite(v) ? v : 0;
    }
    return o;
  });
  return single ? out[0] : out;
}

/** Stretch a stereo pair (or mono, with R === L) to exactly `length` samples. */
export function stretchToLength(L, R, length, { sampleRate = 48000, loop = false } = {}) {
  if (!R || R === L) { const m = timeStretch(L, length / Math.max(1, L.length), { sampleRate, loop, length }); return { L: m, R: m }; }
  const [a, b] = timeStretch([L, R], length / Math.max(1, L.length), { sampleRate, loop, length });
  return { L: a, R: b };
}
