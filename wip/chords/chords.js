// Polyphonic guitar note tracking ("Chords" mode of Guitar plays notes, v1.1).
// Pure and allocation-free per frame, like pitch.js, so it runs on the main
// thread (createGuitarInput feeds it sample blocks posted by the guitar
// worklet), in the ScriptProcessor fallback, or in Node tests.
//
// Method (written for Orograph; the multi-pitch part follows the idea of
// A. Klapuri, "Multiple fundamental frequency estimation by summing harmonic
// amplitudes", ISMIR 2006):
//
//   1. Onsets: a rise of the high-frequency envelope (first difference of the
//      input, 64-sample sub-blocks), as in the single-note tracker. After an
//      onset only the samples since the pick are analysed, so the previous
//      chord does not leak into the new one.
//   2. Spectrum: Hann window over the newest segment (2048 to 4096 samples at
//      44.1 / 48 kHz, 4096 to 8192 above), zero padded 2x, real FFT, magnitude
//      scaled to sinusoid amplitude. Then spectral whitening: the magnitude
//      is divided by the band level (30 overlapping triangular bands up to
//      about 5.5 kHz) raised to 0.67, which evens out loud and quiet strings.
//   3. Iterative estimation and cancellation: every candidate fundamental from
//      D2 to F#6 in quarter tones gets a salience, the sum over its first
//      harmonics of the largest whitened magnitude near each harmonic, each
//      weighted by (f0 + 52) / (m f0 + 320) so the low harmonics (and so the
//      true fundamental rather than its octave) count most. The best
//      candidate's pitch is refined from its interpolated partial peaks
//      (allowing for string inharmonicity), and its partials are cancelled
//      from the residual spectrum: each partial's main lobe is subtracted, at
//      most up to the larger of its neighbouring partials (spectral
//      smoothness), so a partial shared with another note keeps the part that
//      belongs to that note. Repeat until the next salience falls below a
//      fraction of the first one, below the noise floor, or 6 notes.
//   4. Octave errors: a note an octave, a twelfth or two octaves from a note
//      already found needs clearly more salience of its own (its partials all
//      sit on the lower note's), so a single string never brings its octave.
//   5. Per-note hysteresis: a note starts after 2 consecutive frames that hear
//      it (or 1 frame right after a strong pick), and ends after 3 frames
//      without it, when its partials fall below the gate, or when the whole
//      input does. A note that is picked again (its level jumps at an onset)
//      is retriggered; a string left ringing under a new pick is not.
//
// Latency (measured in tests/pedals/guitar-chords.test.js on synthetic
// strings): the first analysis after a pick waits for half a window, 2048
// samples (43 ms at 48 kHz, 46 ms at 44.1 kHz), and a note normally needs a
// second frame one hop (512 samples, about 11 ms) later, so chords start about
// 45 to 60 ms after the pick. The single-note tracker is about 30 to 60 ms.
//
// Cost: one 8192-point real FFT (as a 4096-point complex FFT), whitening and
// the salience search per frame, about 94 frames a second while something
// sounds; nothing while the input is below the gate.

import { createFft, freqToMidi, gainToDb, dbToGain } from './signal.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const CHORD_MAX_NOTES = 6;
/** Typical delay from a pick to its notes (ms) at 44.1 / 48 kHz; see the header. */
export const CHORD_LATENCY_MS = 55;

/** Window length for a sample rate: 4096 up to 50 kHz (85-93 ms), 8192 above. */
export function chordWindowSize(sampleRate) {
  return sampleRate > 50000 ? 8192 : 4096;
}

/** Real-input magnitude spectrum of length-N frames via one N/2 complex FFT. */
function createRealSpectrum(N) {
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
  hopSize = windowSize >> 3,
  minSegment = windowSize >> 1,
  maxNotes = CHORD_MAX_NOTES,
  minMidi = 38,              // D2 (drop D)
  maxMidi = 88,              // E6, the 24th fret of the high E string
  maxHarmonics = 30,
  maxPartialHz = 2500,
  inharmonicity = 1e-4,      // typical B of a wound guitar string; partial m sits at m f0 sqrt(1 + B m^2)
  alpha = 52,                // salience weight (f0 + alpha) / (m f0 + beta)
  beta = 320,
  whitenPower = 0.33,        // Klapuri's nu: band level ^ (nu - 1)
  relThreshold = 0.2,        // next note's salience vs the first one's
  octaveThreshold = 0.25,    // the same for a note an octave / twelfth / two octaves from one found
  noiseFactor = 1.5,          // salience vs the noise floor's
  levelRangeDb = 20,         // a note this far below the loudest is dropped
  octaveRangeDb = 10,        // a harmonic-related note's own energy this far below the loudest note's is dropped
  gateDb = -50,
  onsetRiseDb = 6,
  onFrames = 2,
  offFrames = 3,
  strongOnset = 0.6,         // a note this salient (vs the first) in the first frame after a pick starts at once
  retrigDb = 3,
  trace = null,
} = {}) {
  const cfg = { gateDb, onsetRiseDb, relThreshold, octaveThreshold };
  const W = windowSize;
  const N = 2 * W;                 // FFT size (2x zero padding)
  const spec = createRealSpectrum(N);
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
  const found = [];          // this frame's notes: { midi, freq, sal, level, ownLevel }
  const prop = Array.from({ length: maxNotes + 3 }, () => ({ midi: 0, freq: 0, sal: 0, level: -240, ownLevel: -240 }));
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
      for (const st of notes.values()) st.preLevel = st.level;
    } else if (pos - lastOnsetPos < 0.02 * sampleRate && levelDb > onsetPeakDb) {
      onsetPeakDb = levelDb;
    }
  }

  const velocityOf = (db) => clamp(0.15 + 0.85 * (db - cfg.gateDb) / (-3 - cfg.gateDb), 0.05, 1);
  const tOf = (sample) => sample / sampleRate;

  function emitOn(midi, st, sample) {
    st.on = true;
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

  const harmonicsOf = (f0) => Math.max(1, Math.min(maxHarmonics, Math.floor(maxPartialHz / f0)));

  /**
   * Cancel the partials trackPartials just found from the residual: each
   * partial's Hann main lobe, at most up to the mean of its neighbouring
   * partials (spectral smoothness), so a partial shared with another note
   * (an octave's fundamental on this note's second harmonic) keeps that
   * note's share.
   */
  function cancel(H, L) {
    const lobeBins = 2 * N / L;
    for (let h = 0; h < H; h++) {
      let amt = partA[h];
      if (!(amt > 0)) continue;
      if (h > 0) {
        const nb = h + 1 < H ? 0.5 * (partA[h - 1] + partA[h + 1]) : partA[h - 1];
        if (amt > nb) amt = nb;
      }
      if (!(amt > 0)) continue;
      const p = partP[h];
      const k0 = Math.max(0, Math.ceil(p - lobeBins)), k1 = Math.min(K - 1, Math.floor(p + lobeBins));
      for (let k = k0; k <= k1; k++) {
        const v = R[k] - amt * hannLobe((k - p) * L / N);
        R[k] = v > 0 ? v : 0;
      }
    }
    peaks();
  }

  /** Multi-pitch estimate of the current segment into `found`. */
  function estimate(L) {
    found.length = 0;
    // Window the newest L samples, zero pad to N.
    const { win, scale } = hann(L);
    const end = pos;
    for (let i = 0; i < L; i++) frame[i] = ring[(end - L + i) % W] * win[i];
    frame.fill(0, L);
    spec.magnitude(frame, X, scale);
    whiten();
    // Noise floor of the whitened spectrum: median over the analysed band (by sampling every other bin).
    const k0 = Math.max(1, Math.floor(60 / binHz));
    let n = 0;
    for (let k = k0; k <= maxBin; k += 2) R[n++] = Y[k];
    const tmp = R.subarray(0, n);
    tmp.sort();
    const noise = tmp[n >> 1];
    for (let k = 0; k < K; k++) R[k] = Y[k];
    peaks();

    // Pass 1, greedy: the most salient candidate on the residual, its pitch
    // refined from its partials, cancelled; repeat. This proposes notes.
    let first = 0, nc = 0;
    for (let iter = 0; iter < maxNotes + 3; iter++) {
      let best = -1, bs = 0;
      for (let i = 0; i < cands.length; i++) {
        const v = salienceOf(cands[i], P);
        if (v > bs) { bs = v; best = i; }
      }
      if (best < 0) break;
      const c = cands[best];
      if (trace) trace.push({ iter, midi: c.midi, sal: bs, rel: first > 0 ? bs / first : 1, noise: noise * c.wsum });
      if (bs < noiseFactor * noise * c.wsum) break;
      if (iter > 0 && bs < 0.5 * cfg.relThreshold * first) break;
      if (iter === 0) first = bs;
      const freq = trackPartials(c.f0, harmonicsOf(c.f0));
      cancel(harmonicsOf(c.f0), L);
      const midi = Math.round(freqToMidi(freq));
      if (midi < minMidi || midi > maxMidi) continue;
      let dup = false;
      for (let i = 0; i < nc; i++) if (prop[i].midi === midi) { dup = true; break; }
      if (!dup) { prop[nc].midi = midi; prop[nc].freq = freq; nc++; }
    }
    if (!nc) return;

    // Pass 2, from the lowest proposal up: measure each on what the notes below
    // it leave over, so an octave or a high partial is never credited with
    // energy that belongs to a lower string.
    const list = prop.slice(0, nc).sort((p, q) => p.freq - q.freq);
    for (let k = 0; k < K; k++) R[k] = Y[k];
    peaks();
    let maxSal = 0, peakOwn = -240;
    for (const pr of list) {
      const H = harmonicsOf(pr.freq);
      const freq = trackPartials(pr.freq, H);
      let s2 = 0, energy = 0, own = 0;
      for (let h = 0; h < H; h++) {
        const k = partBin[h];
        if (k < 0) continue;
        s2 += partA[h] * (freq + alpha) / ((h + 1) * freq + beta);
        energy += X[k] * X[k];
        const r = partA[h] / G[k];
        own += r * r;
      }
      pr.freq = freq;
      pr.midi = Math.round(freqToMidi(freq));
      pr.sal = s2;
      pr.level = gainToDb(Math.sqrt(energy));
      pr.ownLevel = gainToDb(Math.sqrt(own));
      if (s2 > maxSal) maxSal = s2;
      if (pr.ownLevel > peakOwn) peakOwn = pr.ownLevel;
      cancel(H, L);
    }
    for (const pr of list) {
      if (pr.midi < minMidi || pr.midi > maxMidi || found.length >= maxNotes) continue;
      if (pr.sal < cfg.relThreshold * maxSal || pr.ownLevel < peakOwn - levelRangeDb || pr.level < cfg.gateDb - 6) continue;
      // On a harmonic of a lower note (octave, twelfth, two octaves ...) it has no
      // partial of its own: it must stand out clearly from what that note explains.
      let dup = false, related = false;
      for (const f of found) {
        if (f.midi === pr.midi) { dup = true; break; }
        const r = pr.freq / f.freq;
        const m = Math.round(r);
        if (m >= 2 && m <= 16 && Math.abs(1200 * Math.log2(r / m)) < 40) related = true;
      }
      if (dup) continue;
      if (related && (pr.sal < cfg.octaveThreshold * maxSal || pr.ownLevel < peakOwn - octaveRangeDb)) continue;
      found.push({ midi: pr.midi, freq: pr.freq, sal: maxSal > 0 ? pr.sal / maxSal : 1, level: pr.level, ownLevel: pr.ownLevel });
    }
  }

  function analyseFrame() {
    const sample = pos;
    stats.frames++;
    const quiet = envDb < cfg.gateDb - 3;
    lastFrame.time = tOf(sample); lastFrame.db = envDb;
    if (quiet) {
      if (soundingCount || notes.size) releaseAll(sample);
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
      } else if (soundingCount < maxNotes && (st.hits >= onFrames || (strong && f.sal >= strongOnset))) {
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
      const v = block[i];
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
    lastOnsetPos = -1e12; onsetPeakDb = -240; envDb = -240; segStart = 0; nextFrame = hopSize; freshOnset = false;
    notes.clear(); soundingCount = 0;
    lastFrame.heard = []; lastFrame.notes = []; lastFrame.analysed = false;
  }

  return {
    process,
    reset,
    /** Release every sounding note now (returns the noteOff events). */
    releaseAll() { events.length = 0; releaseAll(pos); return events; },
    configure(o = {}) {
      if (o.gateDb != null && Number.isFinite(Number(o.gateDb))) cfg.gateDb = Number(o.gateDb);
      if (o.onsetRiseDb != null) cfg.onsetRiseDb = o.onsetRiseDb;
      if (o.relThreshold != null) cfg.relThreshold = o.relThreshold;
      if (o.octaveThreshold != null) cfg.octaveThreshold = o.octaveThreshold;
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
