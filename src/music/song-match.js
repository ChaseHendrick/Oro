// Match a song (2.11): tempo and key of a piece of audio, worked out offline
// in the browser. Pure (no DOM, no Web Audio): takes mono samples and their
// rate, so it is tested in Node with synthetic audio.
//
// Tempo: a spectral flux onset strength envelope (log magnitude, half-wave
// rectified, local mean removed), its autocorrelation, and a comb over the
// candidate beat periods for 60..200 BPM (the period and its multiples). A
// candidate whose half period is also strong is marked down (the onsets come
// twice as fast, so the true beat is probably double), and a broad preference
// for tempos near 120 settles the remaining half/double ties.
//
// Key: a chromagram (STFT bins folded onto the 12 pitch classes, 55 Hz to
// 2 kHz) averaged over the audio, correlated with the 24 rotations of the
// Krumhansl-Kessler major and minor key profiles; the best two keys are
// reported. Profiles: C. L. Krumhansl and E. J. Kessler (1982), "Tracing the
// dynamic changes in perceived tonal organization in a spatial representation
// of musical keys", Psychological Review 89(4), 334-368; as tabulated in
// C. L. Krumhansl (1990), Cognitive Foundations of Musical Pitch, Oxford
// University Press. Published research values (probe tone ratings).

export const KK_MAJOR = Object.freeze([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]);
export const KK_MINOR = Object.freeze([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]);
export const KEY_NAMES = Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']);

export const MIN_BPM = 60, MAX_BPM = 200;
export const MAX_SECONDS = 90;           // only the first 90 s are analysed (enough, and quick)
export const ANALYSIS_RATE = 11025;
export const LOW_CONFIDENCE = 0.35;

const ONSET_N = 512, ONSET_HOP = 128;
const CHROMA_N = 4096, CHROMA_HOP = 2048;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---------------------------------------------------------------- helpers

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

const hann = (n) => { const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); return w; };

/** Mix channels (Float32Arrays) to mono. */
export function toMono(channels) {
  if (!channels || !channels.length) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const n = channels[0].length, out = new Float32Array(n), k = 1 / channels.length;
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] * k;
  return out;
}

/** Box-filter decimation to about ANALYSIS_RATE, at most MAX_SECONDS long. Returns { x, sr }. */
export function prepare(samples, sr) {
  const f = Math.max(1, Math.floor(sr / ANALYSIS_RATE));
  const outSr = sr / f;
  const n = Math.min(Math.floor(samples.length / f), Math.floor(MAX_SECONDS * outSr));
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0, o = i * f; j < f; j++) s += samples[o + j];
    x[i] = s / f;
  }
  return { x, sr: outSr };
}

// ---------------------------------------------------------------- tempo

/** Onset strength envelope (spectral flux). Returns { env, rate } (frames per second). */
export function onsetEnvelope(x, sr) {
  const frames = Math.max(0, Math.floor((x.length - ONSET_N) / ONSET_HOP) + 1);
  const env = new Float32Array(frames);
  const w = hann(ONSET_N), re = new Float32Array(ONSET_N), im = new Float32Array(ONSET_N);
  const bins = ONSET_N / 2;
  const magA = new Float32Array(bins), magB = new Float32Array(bins);
  let prev = new Float32Array(bins), have = false;
  const flux = (cur, f) => {
    let s = 0;
    if (have) for (let k = 1; k < bins; k++) { const d = cur[k] - prev[k]; if (d > 0) s += d; }
    env[f] = s;
    prev.set(cur); have = true;
  };
  // Two real frames per complex FFT: frame a in the real part, b in the imaginary.
  for (let f = 0; f < frames; f += 2) {
    const oa = f * ONSET_HOP, ob = (f + 1) * ONSET_HOP, two = f + 1 < frames;
    for (let i = 0; i < ONSET_N; i++) { re[i] = x[oa + i] * w[i]; im[i] = two ? x[ob + i] * w[i] : 0; }
    fft(re, im);
    for (let k = 1; k < bins; k++) {
      const r1 = re[k], i1 = im[k], r2 = re[ONSET_N - k], i2 = im[ONSET_N - k];
      const ar = 0.5 * (r1 + r2), ai = 0.5 * (i1 - i2), br = 0.5 * (i1 + i2), bi = 0.5 * (r2 - r1);
      magA[k] = Math.log1p(100 * Math.sqrt(ar * ar + ai * ai));
      magB[k] = Math.log1p(100 * Math.sqrt(br * br + bi * bi));
    }
    flux(magA, f);
    if (two) flux(magB, f + 1);
  }
  const rate = sr / ONSET_HOP;
  // remove the local mean (about 0.4 s) and keep what rises above it, then smooth a little
  const half = Math.max(1, Math.round(0.2 * rate));
  const hp = new Float32Array(frames);
  let acc = 0, lo = 0, hi = -1;
  for (let i = 0; i < frames; i++) {
    while (hi < Math.min(frames - 1, i + half)) acc += env[++hi];
    while (lo < i - half) acc -= env[lo++];
    const v = env[i] - acc / (hi - lo + 1);
    hp[i] = v > 0 ? v : 0;
  }
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = 0.25 * (hp[i - 1] || 0) + 0.5 * hp[i] + 0.25 * (hp[i + 1] || 0);
  return { env: out, rate };
}

/** Normalised autocorrelation (lag 0 = 1) of a mean-removed envelope, up to maxLag. */
export function autocorr(env, maxLag) {
  const n = env.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n || 1;
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) e[i] = env[i] - mean;
  const L = Math.min(maxLag, n - 1);
  const ac = new Float32Array(Math.max(1, L + 1));
  for (let lag = 0; lag <= L; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += e[i] * e[i + lag];
    ac[lag] = s / (n - lag);
  }
  const z = ac[0] || 1;
  for (let i = 0; i < ac.length; i++) ac[i] /= z;
  if (!(ac[0] > 0)) ac.fill(0);
  return ac;
}

const at = (ac, lag) => {
  const i = Math.floor(lag), f = lag - i;
  if (i < 0 || i + 1 >= ac.length) return 0;
  return ac[i] * (1 - f) + ac[i + 1] * f;
};

/** Score for one tempo: the comb over the beat period and its multiples, less the half period, times the 120 BPM preference. */
function tempoScore(ac, rate, bpm) {
  const L = 60 * rate / bpm;
  const comb = at(ac, L) + 0.5 * at(ac, 2 * L) + 0.33 * at(ac, 3 * L) + 0.25 * at(ac, 4 * L);
  const fast = Math.max(0, at(ac, L / 2));
  const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120), 2));
  return (comb - 0.6 * fast) * prior;
}

/**
 * Tempo of an onset envelope: { bpm, confidence (0..1), alt } where alt is
 * the half or double tempo, whichever scored better.
 */
export function estimateTempo(env, rate) {
  if (!env || env.length < rate * 3) return { bpm: null, confidence: 0, alt: null };
  const maxLag = Math.ceil(4 * 60 * rate / MIN_BPM) + 2;
  const ac = autocorr(env, maxLag);
  let best = -Infinity, bestBpm = 120;
  for (let b = MIN_BPM; b <= MAX_BPM + 1e-9; b += 0.25) {
    const s = tempoScore(ac, rate, b);
    if (s > best) { best = s; bestBpm = b; }
  }
  // refine
  for (let b = bestBpm - 0.25; b <= bestBpm + 0.25 + 1e-9; b += 0.02) {
    const s = tempoScore(ac, rate, b);
    if (s > best) { best = s; bestBpm = b; }
  }
  const strength = at(ac, 60 * rate / bestBpm);
  const confidence = clamp01((strength - 0.1) / 0.45);
  const half = bestBpm / 2, dbl = bestBpm * 2;
  const sh = half >= MIN_BPM / 1.5 ? tempoScore(ac, rate, half) : -Infinity;
  const sd = dbl <= MAX_BPM * 1.5 ? tempoScore(ac, rate, dbl) : -Infinity;
  const alt = sh === -Infinity && sd === -Infinity ? null : Math.round(sh >= sd ? half : dbl);
  return { bpm: Math.round(bestBpm * 10) / 10, confidence, alt };
}

// ---------------------------------------------------------------- key

/** Chroma (12 values, summing to 1) averaged over the audio, and how uneven it is. */
export function chromagram(x, sr) {
  const chroma = new Float64Array(12);
  const frames = Math.max(0, Math.floor((x.length - CHROMA_N) / CHROMA_HOP) + 1);
  const w = hann(CHROMA_N), re = new Float32Array(CHROMA_N), im = new Float32Array(CHROMA_N);
  // bin -> pitch class, with a weight that falls off between semitones
  const kLo = Math.max(1, Math.ceil(55 * CHROMA_N / sr)), kHi = Math.min(CHROMA_N / 2 - 1, Math.floor(2000 * CHROMA_N / sr));
  const pc = new Int8Array(kHi + 1), wt = new Float32Array(kHi + 1);
  for (let k = kLo; k <= kHi; k++) {
    const midi = 69 + 12 * Math.log2((k * sr / CHROMA_N) / 440);
    const r = Math.round(midi);
    pc[k] = ((r % 12) + 12) % 12;
    wt[k] = Math.max(0, 1 - 2 * Math.abs(midi - r));
  }
  const frame = new Float64Array(12);
  for (let f = 0; f < frames; f++) {
    const o = f * CHROMA_HOP;
    for (let i = 0; i < CHROMA_N; i++) { re[i] = x[o + i] * w[i]; im[i] = 0; }
    fft(re, im);
    frame.fill(0);
    for (let k = kLo; k <= kHi; k++) if (wt[k] > 0) frame[pc[k]] += wt[k] * Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    for (let i = 0; i < 12; i++) chroma[i] += frame[i];
  }
  let sum = 0, max = 0, min = Infinity;
  for (let i = 0; i < 12; i++) { sum += chroma[i]; if (chroma[i] > max) max = chroma[i]; if (chroma[i] < min) min = chroma[i]; }
  const out = new Float64Array(12);
  if (sum > 0) for (let i = 0; i < 12; i++) out[i] = chroma[i] / sum;
  const mean = sum / 12;
  return { chroma: out, contrast: mean > 0 ? (max - min) / mean : 0, energy: sum };
}

function pearson(a, b, rot) {
  let ma = 0, mb = 0;
  for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
  ma /= 12; mb /= 12;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[(i + rot) % 12] - ma, y = b[i] - mb;
    sab += x * y; saa += x * x; sbb += y * y;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

/** Every key's correlation with the chroma, best first: [{ root, mode: 'major'|'minor', r }]. */
export function rankKeys(chroma) {
  const list = [];
  for (let root = 0; root < 12; root++) {
    list.push({ root, mode: 'major', r: pearson(chroma, KK_MAJOR, root) });
    list.push({ root, mode: 'minor', r: pearson(chroma, KK_MINOR, root) });
  }
  return list.sort((a, b) => b.r - a.r);
}

export const keyName = (k) => (k ? `${KEY_NAMES[k.root]} ${k.mode}` : '');

/** The key of some audio: { best, next } each { root, mode, r, confidence } or null when unsure. */
export function estimateKey(x, sr) {
  const { chroma, contrast, energy } = chromagram(x, sr);
  if (!(energy > 0)) return { best: null, next: null, confidence: 0 };
  const ranked = rankKeys(chroma);
  // A flat chroma (noise) correlates with something by chance; how uneven it is says whether it is tonal at all.
  const tonal = clamp01((contrast - 0.25) / 0.6);
  const conf = (k) => clamp01(k.r) * tonal;
  const best = { ...ranked[0], confidence: conf(ranked[0]) };
  const next = { ...ranked[1], confidence: conf(ranked[1]) };
  return { best, next, confidence: best.confidence };
}

// ---------------------------------------------------------------- both

/**
 * Analyse mono samples at rate sr. Returns
 * { seconds, quiet, tempo: { bpm, confidence, alt }, key: { best, next, confidence } }.
 */
export function analyseSong(samples, sr) {
  const { x, sr: r } = prepare(samples, sr);
  let peak = 0, sq = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; sq += x[i] * x[i]; }
  const rms = Math.sqrt(sq / (x.length || 1));
  const seconds = x.length / r;
  if (rms < 1e-4 || peak < 1e-3 || seconds < 3) {
    return { seconds, quiet: true, tempo: { bpm: null, confidence: 0, alt: null }, key: { best: null, next: null, confidence: 0 } };
  }
  const { env, rate } = onsetEnvelope(x, r);
  return { seconds, quiet: false, tempo: estimateTempo(env, rate), key: estimateKey(x, r) };
}

/** Plain words for a result, e.g. "About 124 BPM, A minor (next: C major)". */
export function describeResult(res) {
  if (!res || res.quiet) return 'That was too quiet or too short to tell. Try a louder part of the song, at least 10 seconds long.';
  const parts = [];
  const t = res.tempo, k = res.key;
  parts.push(t.bpm && t.confidence >= LOW_CONFIDENCE ? `About ${Math.round(t.bpm)} BPM` : t.bpm ? `Maybe ${Math.round(t.bpm)} BPM (not sure)` : 'No steady beat found');
  if (k.best && k.confidence >= LOW_CONFIDENCE) parts.push(`${keyName(k.best)} (next: ${keyName(k.next)})`);
  else if (k.best) parts.push(`maybe ${keyName(k.best)} (not sure)`);
  else parts.push('no clear key');
  return `${parts.join(', ')}.`;
}
