// Experimental polyphonic guitar tracker. Pure JavaScript, with no Web Audio
// dependency. Run outside the audio rendering callback: a polyphonic analysis
// costs more than one 128-sample audio quantum on typical hardware.
//
// A full Hann-windowed spectrum separates nearby guitar notes. A coherent
// harmonic series uses the existing McLeod tracker, including strings with a
// weak fundamental. Multiple strings use a nonnegative joint fit of plucked
// harmonic profiles, so each candidate must explain energy without predicting
// strong missing partials. Conservative harmonic guards suppress extra notes.
//
// Clean independent triads work best. Octave doublings and other strings with
// overlapping harmonics can be omitted, and exact octaves are ambiguous.
// Uneven levels, strong distortion, bends and real pickups remain limitations.
// Synthetic fixtures are useful regression evidence, not hardware validation.

import { createFft, freqToMidi, gainToDb, dbToGain } from './signal.js';
import { createMpm } from './pitch.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const CHORD_MAX_NOTES = 6;
/** Approximate clean-input onset delay at 44.1 / 48 kHz (ms). */
export const CHORD_LATENCY_MS = 110;

/** Power-of-two window lasting at least 80 ms. */
export function chordWindowSize(sampleRate) {
  let size = 1024;
  while (size < sampleRate * 0.08) size *= 2;
  return size;
}

/** Real-input magnitude spectrum of length-N frames via one N/2 complex FFT. */
export function createRealSpectrum(N) {
  const M = N >> 1;
  const f = createFft(M);
  const zr = new Float64Array(M), zi = new Float64Array(M);
  const c = new Float64Array(M + 1), s = new Float64Array(M + 1);
  for (let k = 0; k <= M; k++) { c[k] = Math.cos(2 * Math.PI * k / N); s[k] = Math.sin(2 * Math.PI * k / N); }
  /** x: Float64Array(N) (zero padded by the caller). Writes |X[k]| * scale for k = 0..M into mag. */
  function magnitude(x, mag, scale) {
    for (let j = 0; j < M; j++) { zr[j] = x[2 * j]; zi[j] = x[2 * j + 1]; }
    f.forward(zr, zi);
    for (let k = 0; k <= M; k++) {
      const a = k % M, b = (M - k) % M;
      const Zr = zr[a], Zi = zi[a], Cr = zr[b], Ci = -zi[b];
      const Er = (Zr + Cr) * 0.5, Ei = (Zi + Ci) * 0.5;
      const Or = (Zi - Ci) * 0.5, Oi = -(Zr - Cr) * 0.5;
      const Xr = Er + c[k] * Or + s[k] * Oi;
      const Xi = Ei + c[k] * Oi - s[k] * Or;
      mag[k] = Math.sqrt(Xr * Xr + Xi * Xi) * scale;
    }
  }
  return { N, M, magnitude };
}

/** Normalised Hann main-lobe magnitude at x window-bins from its centre (1 at 0, 0 at |x| >= 2). */
function hannLobe(x) {
  const ax = x < 0 ? -x : x;
  if (ax >= 2) return 0;
  if (ax < 1e-9) return 1;
  if (Math.abs(ax - 1) < 1e-9) return 0.5;
  const px = Math.PI * ax;
  return Math.abs(Math.sin(px) / px / (1 - ax * ax));
}

/**
 * Polyphonic note tracker.
 * process(block) accepts any block size and returns the events it produced
 * (array reused per call):
 *   { type: 'noteOn',  note, velocity, time, sample, freq }
 *   { type: 'noteOff', note, time, sample }
 * Times are seconds since the tracker started, at the moment of the decision.
 * lastFrame describes the newest analysis: { time, heard: [midi], notes: [midi sounding], db }.
 */
export function createChordTracker({
  sampleRate = 48000,
  windowSize = chordWindowSize(sampleRate),
  hopSize = windowSize >> 2,
  minSegment = windowSize,
  maxNotes = CHORD_MAX_NOTES,
  minMidi = 38,              // D2 (drop D)
  maxMidi = 88,              // E6, the 24th fret of the high E string
  maxHarmonics = 30,
  maxPartialHz = 5000,
  inharmonicity = 1e-4,      // typical B of a wound guitar string; partial m sits at m f0 sqrt(1 + B m^2)
  alpha = 52,                // salience weight (f0 + alpha) / (m f0 + beta)
  beta = 320,
  whitenPower = 1,          // 1 keeps the original magnitude; lower values whiten the spectrum
  relThreshold = 0.28,        // next note's salience vs the first one's
  octaveThreshold = 0.65,   // an octave needs strong evidence of its own
  noiseFactor = 8,          // strongest spectral peak relative to median noise magnitude
  gateDb = -50,
  onsetRiseDb = 6,
  onFrames = 2,
  offFrames = 4,
  strongOnset = 0.6,         // a note this salient (vs the first) in the first frame after a pick starts at once
  retrigDb = 3,
} = {}) {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new RangeError('Invalid chord tracker sample rate');
  if (!Number.isInteger(windowSize) || windowSize < 256 || (windowSize & (windowSize - 1))) throw new RangeError('Chord window must be a power of two');
  if (!Number.isInteger(hopSize) || hopSize < 1 || hopSize > windowSize) throw new RangeError('Invalid chord hop size');
  if (!Number.isInteger(minSegment) || minSegment < 256 || minSegment > windowSize) throw new RangeError('Invalid chord segment size');
  if (!Number.isInteger(maxNotes) || maxNotes < 1 || maxNotes > CHORD_MAX_NOTES) throw new RangeError('Invalid chord note limit');
  if (!Number.isInteger(minMidi) || !Number.isInteger(maxMidi) || minMidi < 0 || maxMidi > 127 || minMidi > maxMidi) throw new RangeError('Invalid chord note range');
  if (!Number.isInteger(maxHarmonics) || maxHarmonics < 1 || maxHarmonics > 64) throw new RangeError('Invalid chord harmonic limit');
  const cfg = { gateDb, onsetRiseDb, relThreshold, octaveThreshold };
  const W = windowSize;
  const N = 2 * W;                 // FFT size (2x zero padding)
  const spec = createRealSpectrum(N);
  const monophonic = createMpm({ sampleRate, size: W, minFreq: 440 * 2 ** ((minMidi - 69) / 12), maxFreq: 440 * 2 ** ((maxMidi - 69) / 12) });
  const K = spec.M + 1;            // bins 0..N/2
  const binHz = sampleRate / N;
  const ring = new Float32Array(W);
  const frame = new Float64Array(N);
  const X = new Float64Array(K);   // magnitude (sinusoid amplitude)
  const Y = new Float64Array(K);   // whitened
  const R = new Float64Array(K);   // residual
  const P = new Float64Array(K);   // residual peaks
  const G = new Float64Array(K);   // whitening gain per bin

  // ---- whitening bands (centres c_b = 229 (10^((b+1)/21.4) - 1) Hz, b = 0..29)
  const NB = 30;
  const centre = new Float64Array(NB + 2);
  for (let b = 0; b < NB + 2; b++) centre[b] = 229 * (Math.pow(10, b / 21.4) - 1);   // centre[b+1] = band b
  const maxBin = Math.min(K - 1, Math.floor(centre[NB] / binHz));
  const bandSigma = new Float64Array(NB + 2);
  const bandGain = new Float64Array(NB + 2);

  // ---- candidates: quarter tones from minMidi - 0.5 to maxMidi + 0.5, with their harmonic search ranges
  const cands = [];
  for (let m = minMidi - 0.5; m <= maxMidi + 0.5 + 1e-9; m += 0.25) {
    const f0 = 440 * Math.pow(2, (m - 69) / 12);
    const H = Math.max(1, Math.min(maxHarmonics, Math.floor(Math.min(maxPartialHz, (maxBin - 2) * binHz) / f0)));
    const lo = new Int32Array(H), hi = new Int32Array(H), w = new Float64Array(H);
    for (let h = 0; h < H; h++) {
      const mm = h + 1;
      const fc = mm * f0 * Math.sqrt(1 + inharmonicity * mm * mm);
      // +-3 % (about half a semitone), narrower for high harmonics so neighbours never overlap.
      const half = Math.max(1.5 * binHz, fc * Math.min(0.03, 0.4 / mm));
      lo[h] = Math.max(1, Math.floor((fc - half) / binHz));
      hi[h] = Math.min(maxBin, Math.ceil((fc + half) / binHz));
      w[h] = (f0 + alpha) / (mm * f0 + beta);
    }
    let wsum = 0;
    for (let h = 0; h < H; h++) wsum += w[h];
    cands.push({ midi: m, f0, H, lo, hi, w, wsum });
  }
  const partA = new Float64Array(maxHarmonics + 2);
  const partP = new Float64Array(maxHarmonics + 2);
  const partBin = new Int32Array(maxHarmonics + 2);

  // ---- Hann windows per segment length (cached; lengths are minSegment + k hop or W)
  const hannCache = new Map();
  function hann(L) {
    let h = hannCache.get(L);
    if (!h) {
      const win = new Float64Array(L);
      let sum = 0;
      for (let i = 0; i < L; i++) { win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / L); sum += win[i]; }
      h = { win, scale: 2 / sum };
      hannCache.set(L, h);
    }
    return h;
  }

  // ---- onset detection (64-sample sub-blocks, high-frequency envelope)
  const SUB = 64;
  const envBlocks = Math.max(2, Math.ceil(0.015 * sampleRate / SUB));
  const hist = new Float32Array(envBlocks * 2 + 2);
  const lvl = new Float32Array(envBlocks);
  let histN = 0, lvlN = 0, subPeak = 0, subLevel = 0, subFill = 0, prevX = 0;
  const refractory = Math.round(0.06 * sampleRate);
  let lastOnsetPos = -1e12, onsetPeakDb = -240, envDb = -240;

  let pos = 0;
  let segStart = 0;          // first sample of the analysed segment (the latest onset, else the stream start)
  let nextFrame = hopSize;   // sample index of the next analysis
  let freshOnset = false;    // the next frame is the first after a pick
  let onsetStrength = 0;     // dB the HF envelope rose at that pick

  // ---- note state: midi -> { on, hits, miss, level, preLevel, freq }
  const notes = new Map();
  let soundingCount = 0;
  const started = new Set();
  const found = [];          // this frame's notes: { midi, freq, sal, level, ownLevel }
  const lastFrame = { time: 0, heard: [], notes: [], db: -240, analysed: false };
  const events = [];
  const stats = { frames: 0, analysed: 0 };

  function subBlockDone() {
    const db = gainToDb(subPeak);
    const levelDb = gainToDb(subLevel);
    if (histN === hist.length) { hist.copyWithin(0, 1); histN--; }
    hist[histN++] = db;
    lvl[lvlN++ % envBlocks] = levelDb;
    subPeak = 0; subLevel = 0; subFill = 0;
    let cur = -240, ref = -240, level = -240;
    for (let i = Math.max(0, histN - envBlocks); i < histN; i++) if (hist[i] > cur) cur = hist[i];
    for (let i = Math.max(0, histN - 2 * envBlocks); i < histN - envBlocks; i++) if (hist[i] > ref) ref = hist[i];
    for (let i = 0; i < Math.min(lvlN, envBlocks); i++) if (lvl[i] > level) level = lvl[i];
    envDb = level;
    if (envDb < cfg.gateDb - 3 && (soundingCount || notes.size)) {
      releaseAll(pos); started.clear(); found.length = 0; freshOnset = false;
      lastFrame.time = tOf(pos); lastFrame.db = envDb;
      lastFrame.heard = []; lastFrame.notes = []; lastFrame.analysed = false;
    }
    const blockStart = pos - SUB;
    if (histN > envBlocks && levelDb >= cfg.gateDb && db >= ref + cfg.onsetRiseDb && db >= cur - 0.01 && blockStart - lastOnsetPos >= refractory) {
      // Pin the pick to the first sample whose slope clearly rises above what came before.
      const thr = Math.max(dbToGain(ref + 3), dbToGain(db) * 0.1);
      let at = blockStart;
      for (let s = Math.max(1, pos - 2 * SUB, pos - W + 2); s < pos; s++) {
        const d = ring[s % W] - ring[(s - 1) % W];
        if ((d < 0 ? -d : d) >= thr) { at = s; break; }
      }
      lastOnsetPos = at;
      onsetPeakDb = levelDb;
      onsetStrength = db - ref;
      segStart = at;
      nextFrame = at + minSegment;
      freshOnset = true;
      started.clear();
      for (const st of notes.values()) st.preLevel = st.level;
    } else if (pos - lastOnsetPos < 0.02 * sampleRate && levelDb > onsetPeakDb) {
      onsetPeakDb = levelDb;
    }
  }

  const velocityOf = (db) => clamp(0.15 + 0.85 * (db - cfg.gateDb) / (-3 - cfg.gateDb), 0.05, 1);
  const tOf = (sample) => sample / sampleRate;

  function emitOn(midi, st, sample) {
    st.on = true;
    started.add(midi);
    soundingCount++;
    const vel = velocityOf(Math.max(onsetPeakDb, st.level));
    events.push({ type: 'noteOn', note: midi, velocity: vel, time: tOf(sample), sample, freq: st.freq });
  }
  function emitOff(midi, st, sample) {
    if (!st.on) return;
    st.on = false;
    soundingCount--;
    events.push({ type: 'noteOff', note: midi, time: tOf(sample), sample });
  }
  function releaseAll(sample) {
    for (const [m, st] of notes) emitOff(m, st, sample);
    notes.clear();
    soundingCount = 0;
  }

  /** Whitened spectrum Y from X (bands up to maxBin). */
  function whiten() {
    if (whitenPower === 1) {
      G.fill(1); Y.set(X); Y.fill(0, maxBin + 1);
      return;
    }
    for (let b = 1; b <= NB; b++) {
      const fl = centre[b - 1], fc = centre[b], fh = centre[b + 1];
      const k0 = Math.max(1, Math.ceil(fl / binHz)), k1 = Math.min(maxBin, Math.floor(fh / binHz));
      let e = 0, ws = 0;
      for (let k = k0; k <= k1; k++) {
        const f = k * binHz;
        const h = f <= fc ? (f - fl) / (fc - fl) : (fh - f) / (fh - fc);
        if (h <= 0) continue;
        e += h * X[k] * X[k]; ws += h;
      }
      bandSigma[b] = Math.sqrt(ws > 0 ? e / ws : 0);
    }
    // Gains at the band centres, interpolated linearly in between.
    const p = whitenPower - 1;
    for (let b = 1; b <= NB; b++) bandGain[b] = Math.pow(Math.max(1e-6, bandSigma[b]), p);
    let b = 1;
    for (let k = 0; k <= maxBin; k++) {
      const f = k * binHz;
      while (b < NB && f > centre[b + 1]) b++;
      let g;
      if (f <= centre[1]) g = bandGain[1];
      else if (b >= NB) g = bandGain[NB];
      else {
        const t = (f - centre[b]) / (centre[b + 1] - centre[b]);
        g = (1 - t) * bandGain[b] + t * bandGain[b + 1];
      }
      G[k] = g;
      Y[k] = X[k] * g;
    }
    for (let k = maxBin + 1; k < K; k++) Y[k] = 0;
  }

  function salienceOf(c, S) {
    let s = 0;
    for (let h = 0; h < c.H; h++) {
      let mx = 0;
      for (let k = c.lo[h]; k <= c.hi[h]; k++) if (S[k] > mx) mx = S[k];
      s += c.w[h] * mx;
    }
    return s;
  }

  /** P = the residual's local maxima only (so the slope of a neighbour's lobe never counts). */
  function peaks() {
    P[0] = 0;
    for (let k = 1; k < maxBin; k++) P[k] = R[k] > R[k - 1] && R[k] >= R[k + 1] ? R[k] : 0;
    for (let k = maxBin; k < K; k++) P[k] = 0;
  }

  /**
   * Partials of a note near f0 on the residual: partBin / partP (interpolated
   * bin) / partA (whitened amplitude, 0 = none found) for h = 0..H-1. Returns
   * the refined fundamental.
   */
  function trackPartials(f0, H) {
    let prevF = 0, prevM = 0, step = f0, fNum = 0, fDen = 0;
    for (let h = 0; h < H; h++) {
      const m = h + 1;
      const pred = prevM ? prevF + (m - prevM) * step : m * f0 * Math.sqrt(1 + inharmonicity * m * m);
      const tol = Math.max(1.5 * binHz, Math.min(0.035 * m, 0.15) * f0);
      const lo = Math.max(1, Math.floor((pred - tol) / binHz)), hi = Math.min(maxBin - 1, Math.ceil((pred + tol) / binHz));
      let pk = -1, mx = 0;
      for (let k = lo; k <= hi; k++) if (P[k] > mx) { mx = P[k]; pk = k; }
      partBin[h] = pk;
      partA[h] = mx;
      if (pk < 0) { partP[h] = pred / binHz; continue; }
      const a = R[pk - 1], b0 = R[pk], d = R[pk + 1];
      const den = a - 2 * b0 + d;
      const off = den < 0 ? clamp(0.5 * (a - d) / den, -0.5, 0.5) : 0;
      partP[h] = pk + off;
      const fm = partP[h] * binHz;
      if (prevM) {
        const st = (fm - prevF) / (m - prevM);
        if (st > step * 0.97 && st < step * 1.03) step = st;
      } else if (m === 1) step = fm;
      prevF = fm; prevM = m;
      if (h < 8) {
        const wgt = mx * mx / m;
        fNum += wgt * fm / (m * Math.sqrt(1 + inharmonicity * m * m));
        fDen += wgt;
      }
    }
    return fDen > 0 ? fNum / fDen : f0;
  }

  const harmonicsOf = (f0) => Math.max(1, Math.min(maxHarmonics, Math.floor(Math.min(maxPartialHz, (maxBin - 2) * binHz) / f0)));

  // Jointly fit all proposed notes to the same magnitude spectrum. A note must
  // explain energy without predicting strong missing partials; this prevents
  // a high note from also producing a fictional lower fundamental.
  const shapes = [];
  for (const position of [0.06, 0.12, 0.18, 0.24, 0.3]) {
    for (const brightness of [0, 0.035, 0.1]) {
      const amplitudes = new Float64Array(maxHarmonics);
      for (let h = 0; h < maxHarmonics; h++) {
        const m = h + 1;
        const amp = Math.abs(Math.sin(Math.PI * m * position)) / m * Math.exp(-brightness * (m - 1));
        amplitudes[h] = amp;
      }
      shapes.push(amplitudes);
    }
  }
  const fit = new Float64Array(K);
  const noiseBins = new Float64Array(Math.ceil(maxBin / 2));
  const columns = [];
  const columnSize = maxHarmonics * (Math.ceil(4 * N / minSegment) + 2);
  const columnPool = Array.from({ length: (maxMidi - minMidi + 1) * shapes.length }, () => ({
    midi: 0, freq: 0, indices: new Int32Array(columnSize), values: new Float64Array(columnSize),
    length: 0, norm: 0, gain: 0, score: 0,
  }));
  const selected = [];

  /** Multi-pitch estimate of the current segment into `found`. */
  function estimate(L) {
    found.length = 0;
    const { win, scale } = hann(L);
    for (let i = 0; i < L; i++) frame[i] = ring[(pos - L + i) % W];
    const mono = monophonic.analyze(frame, 0, L);
    for (let i = 0; i < L; i++) frame[i] *= win[i];
    frame.fill(0, L);
    spec.magnitude(frame, X, scale);
    let peak = 0, ni = 0;
    for (let k = 1; k <= maxBin; k++) {
      if (X[k] > peak) peak = X[k];
      if (k & 1) noiseBins[ni++] = X[k];
    }
    noiseBins.sort();
    if (!(peak > noiseFactor * noiseBins[ni >> 1])) return;
    // A coherent harmonic series is a single string, including a weak or
    // absent fundamental. Independent strings contribute non-harmonic peaks.
    // An exact octave doubling is ambiguous and deliberately stays one note.
    if (mono.clarity > 0.97 && mono.freq > 0) {
      let independent = false;
      for (let k = 2; k < maxBin; k++) {
        if (X[k] < peak * 0.12 || X[k] <= X[k - 1] || X[k] < X[k + 1]) continue;
        const den = X[k - 1] - 2 * X[k] + X[k + 1];
        const offset = den < 0 ? clamp(0.5 * (X[k - 1] - X[k + 1]) / den, -0.5, 0.5) : 0;
        const ratio = (k + offset) * binHz / mono.freq;
        const harmonic = Math.round(ratio);
        if (harmonic > 12) continue;
        if (harmonic < 1 || Math.abs(1200 * Math.log2(ratio / harmonic)) > 45) { independent = true; break; }
      }
      const midi = Math.round(freqToMidi(mono.freq));
      if (!independent && midi >= minMidi && midi <= maxMidi) {
        const level = gainToDb(mono.rms * Math.SQRT2);
        found.push({ midi, freq: mono.freq, sal: 1, level, ownLevel: level });
        return;
      }
    }
    whiten();
    R.set(Y); peaks();
    columns.length = 0; selected.length = 0;
    for (let k = 0; k < K; k++) fit[k] = Y[k];
    const lobeBins = 2 * N / L;
    for (let midi = minMidi; midi <= maxMidi; midi++) {
      let best = null, sal = 0;
      for (const c of cands) {
        if (Math.abs(c.midi - midi) > 0.25) continue;
        const v = salienceOf(c, P);
        if (v > sal) { sal = v; best = c; }
      }
      if (!best) continue;
      let freq = trackPartials(best.f0, harmonicsOf(best.f0));
      if (Math.abs(freqToMidi(freq) - midi) > 0.45) continue;
      const H = harmonicsOf(freq);
      trackPartials(freq, H);
      if (partBin[0] >= 0) freq = partP[0] * binHz / Math.sqrt(1 + inharmonicity);
      let support = 0;

      for (let h = 0; h < Math.min(8, H); h++) if (partBin[h] >= 0 && X[partBin[h]] > peak * 0.035) support++;
      if (support < Math.min(3, H) || partBin[0] < 0 || X[partBin[0]] < peak * 0.12) continue;
      for (const shape of shapes) {
        const column = columnPool[columns.length];
        const { indices, values } = column;
        let norm = 0, length = 0;
        for (let h = 0; h < H; h++) {
          const m = h + 1;
          const predicted = m * freq * Math.sqrt(1 + inharmonicity * m * m) / binHz;
          const p = partBin[h] >= 0 ? partP[h] : predicted;
          const low = Math.max(1, Math.ceil(p - lobeBins));
          const high = Math.min(maxBin, Math.floor(p + lobeBins));
          for (let k = low; k <= high; k++) {
            const amp = hannLobe((k - p) * L / N);
            const value = shape[h] * amp * G[k];
            if (!(value > 0)) continue;
            indices[length] = k; values[length++] = value; norm += value * value;
          }
        }
        if (norm > 0) {
          column.midi = midi; column.freq = freq; column.norm = norm; column.length = length;
          column.gain = 0; column.score = 0; columns.push(column);
        }
      }
    }
    // Matching pursuit proposes the most useful strings. Existing strings
    // are re-fitted after each addition, because shared harmonics contain
    // contributions from both notes.
    for (let iter = 0; iter < maxNotes; iter++) {
      let best = null, score = 0, gain = 0;
      for (const c of columns) {
        if (selected.some(n => n.midi === c.midi)) continue;
        let dot = 0;
        for (let j = 0; j < c.length; j++) dot += fit[c.indices[j]] * c.values[j];
        if (dot <= 0) continue;
        const improvement = dot * dot / c.norm;
        if (improvement > score) { score = improvement; best = c; gain = dot / c.norm; }
      }
      if (!best) break;
      if (iter && score < cfg.relThreshold * cfg.relThreshold * selected[0].score) break;
      best.gain = gain; best.score = score; selected.push(best);
      for (let j = 0; j < best.length; j++) fit[best.indices[j]] -= gain * best.values[j];
      for (let cycle = 0; cycle < 3; cycle++) for (let n = 0; n < selected.length; n++) {
        const prior = selected[n];
        for (let j = 0; j < prior.length; j++) fit[prior.indices[j]] += prior.gain * prior.values[j];
        let next = prior, nextGain = 0, nextScore = 0;
        for (const c of columns) {
          if (c.midi !== prior.midi) continue;
          let dot = 0;
          for (let j = 0; j < c.length; j++) dot += fit[c.indices[j]] * c.values[j];
          const score = Math.max(0, dot) ** 2 / c.norm;
          if (score > nextScore) { next = c; nextScore = score; nextGain = dot / c.norm; }
        }
        next.gain = nextGain; next.score = nextScore; selected[n] = next;
        for (let j = 0; j < next.length; j++) fit[next.indices[j]] -= nextGain * next.values[j];
      }
    }
    let strongest = 0;
    for (const c of selected) strongest = Math.max(strongest, c.gain * Math.sqrt(c.norm));
    for (const c of selected) {
      const sal = c.gain * Math.sqrt(c.norm) / strongest;
      const level = gainToDb(c.gain);
      let harmonic = 0;
      for (const n of columns) {
        if (n.midi >= c.midi) continue;
        const ratio = c.freq / n.freq, m = Math.round(ratio);
        if (m >= 2 && Math.abs(1200 * Math.log2(ratio / m)) < 45) harmonic = Math.max(harmonic, m);
      }
      if (harmonic >= 3 || (harmonic === 2 && sal < cfg.octaveThreshold)) continue;
      if (sal < cfg.relThreshold || level < cfg.gateDb - 6) continue;
      found.push({ midi: c.midi, freq: c.freq, sal, level, ownLevel: level });
    }
  }

  function analyseFrame() {
    const sample = pos;
    stats.frames++;
    const quiet = envDb < cfg.gateDb - 3;
    lastFrame.time = tOf(sample); lastFrame.db = envDb;
    if (quiet) {
      if (soundingCount || notes.size) releaseAll(sample);
      started.clear();
      freshOnset = false;
      lastFrame.heard = []; lastFrame.notes = []; lastFrame.analysed = false;
      return;
    }
    const L = Math.min(W, pos - segStart, pos);
    if (L < minSegment) return;
    stats.analysed++;
    estimate(L);
    lastFrame.analysed = true;
    const fresh = freshOnset;
    freshOnset = false;
    const strong = fresh && onsetStrength >= cfg.onsetRiseDb + 6;
    for (const st of notes.values()) st.seen = false;
    for (const f of found) {
      let st = notes.get(f.midi);
      if (!st) { st = { on: false, hits: 0, miss: 0, level: f.level, preLevel: -240, freq: f.freq, seen: false }; notes.set(f.midi, st); }
      st.seen = true;
      st.hits++;
      st.miss = 0;
      st.freq = f.freq;
      const prev = st.preLevel;
      st.level = f.level;
      if (st.on) {
        // Picked again: retrigger; left ringing under a new pick: carry on.
        if (fresh && f.level >= prev + retrigDb) { emitOff(f.midi, st, sample); if (soundingCount < maxNotes) emitOn(f.midi, st, sample); }
      } else if (!started.has(f.midi) && soundingCount < maxNotes && (st.hits >= onFrames || (strong && f.sal >= strongOnset))) {
        emitOn(f.midi, st, sample);
      }
    }
    for (const [m, st] of notes) {
      if (st.seen) continue;
      st.hits = 0;
      st.miss++;
      if (!st.on) { notes.delete(m); continue; }
      if (st.miss >= offFrames) { emitOff(m, st, sample); notes.delete(m); }
    }
    lastFrame.heard = found.map(f => f.midi).sort((a, b) => a - b);
    const on = [];
    for (const [m, st] of notes) if (st.on) on.push(m);
    lastFrame.notes = on.sort((a, b) => a - b);
  }

  /** Feed samples (any block size). Returns the events produced (array reused per call). */
  function process(block) {
    events.length = 0;
    for (let i = 0; i < block.length; i++) {
      const v = Number.isFinite(block[i]) ? block[i] : 0;
      ring[pos % W] = v;
      pos++;
      const a = v < 0 ? -v : v;
      if (a > subLevel) subLevel = a;
      const d = v - prevX;
      prevX = v;
      const ad = d < 0 ? -d : d;
      if (ad > subPeak) subPeak = ad;
      if (++subFill === SUB) subBlockDone();
      if (pos >= nextFrame) { nextFrame += hopSize; analyseFrame(); }
    }
    return events;
  }

  /** Forget everything (no events: the caller releases what it holds). */
  function reset() {
    ring.fill(0); pos = 0; histN = 0; lvlN = 0; subPeak = 0; subLevel = 0; subFill = 0; prevX = 0;
    lastOnsetPos = -1e12; onsetPeakDb = -240; onsetStrength = 0; envDb = -240; segStart = 0; nextFrame = hopSize; freshOnset = false;
    notes.clear(); started.clear(); soundingCount = 0;
    found.length = 0; events.length = 0; stats.frames = 0; stats.analysed = 0;
    lastFrame.time = 0; lastFrame.db = -240;
    lastFrame.heard = []; lastFrame.notes = []; lastFrame.analysed = false;
  }

  return {
    process,
    reset,
    /** Release every sounding note now (returns the noteOff events). */
    releaseAll() { events.length = 0; releaseAll(pos); started.clear(); lastFrame.notes = []; return events; },
    configure(o = {}) {
      for (const [key, lo, hi] of [['gateDb', -120, 0], ['onsetRiseDb', 2, 30], ['relThreshold', 0.05, 1], ['octaveThreshold', 0.05, 1]]) {
        if (o[key] != null && Number.isFinite(Number(o[key]))) cfg[key] = clamp(Number(o[key]), lo, hi);
      }
    },
    /** The notes found in the newest analysed frame (for tests and diagnostics). */
    get found() { return found.map(f => ({ ...f })); },
    get lastFrame() { return lastFrame; },
    get sounding() { return lastFrame.notes.slice(); },
    get samples() { return pos; },
    get stats() { return { ...stats }; },
    sampleRate, windowSize: W, hopSize, minSegment, fftSize: N,
  };
}

/** Run a chord tracker over a whole buffer (tests, offline analysis). */
export function trackChords(samples, sampleRate, opts = {}, { block = 128, frames = false } = {}) {
  const tr = createChordTracker({ sampleRate, ...opts });
  const events = [];
  const fr = [];
  let lastT = -1;
  for (let i = 0; i < samples.length; i += block) {
    const ev = tr.process(samples.subarray(i, Math.min(samples.length, i + block)));
    for (const e of ev) events.push({ ...e });
    if (frames && tr.lastFrame.time > lastT) { lastT = tr.lastFrame.time; fr.push({ ...tr.lastFrame, heard: tr.lastFrame.heard.slice(), notes: tr.lastFrame.notes.slice() }); }
  }
  return { events, frames: fr, tracker: tr };
}
