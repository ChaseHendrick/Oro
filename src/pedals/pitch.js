// Guitar analysis, pure and allocation-free per block so it can run inside an
// AudioWorklet (guitar-worklet.js), on the main thread, or in Node tests.
//
//   createEnvelopeFollower  attack / release / gate, dB-scaled 0..1 output (a Links source)
//   createMpm               McLeod Pitch Method (McLeod and Wyvill 2005): NSDF via FFT
//                           autocorrelation, key maxima, k threshold, parabolic peak,
//                           plus an octave guard
//   createPitchTracker      2048 window, 256 hop, onset detection, note on/off with
//                           hysteresis, pitch bend for bends and vibrato
//
// Track the clean DI (before fuzz or drive): distortion adds strong harmonics and
// intermodulation that make any period detector less sure.

import { createAutocorrelator, parabolic, freqToMidi, gainToDb, dbToGain } from './signal.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------- envelope follower

/**
 * Peak envelope follower. `attackMs` / `releaseMs` are one-pole time constants
 * (time to cover 63% of a step). The gate opens at `gateDb` and closes
 * `gateHysteresisDb` below it, so a note ringing out at the threshold does not chatter.
 * `value` maps floorDb..ceilDb (default gateDb..0 dBFS) to 0..1: guitar dynamics
 * are heard in dB, so a linear mapping would put all the playing in the top tenth.
 */
export function createEnvelopeFollower({
  sampleRate = 48000, attackMs = 3, releaseMs = 150, gateDb = -60, gateHysteresisDb = 3,
  floorDb = null, ceilDb = 0,
} = {}) {
  const st = { level: 0, db: -240, value: 0, open: false };
  let a = 0, r = 0;
  const cfg = { attackMs, releaseMs, gateDb, gateHysteresisDb, floorDb, ceilDb };
  function coeffs() {
    a = Math.exp(-1 / (Math.max(0.01, cfg.attackMs) * 0.001 * sampleRate));
    r = Math.exp(-1 / (Math.max(0.01, cfg.releaseMs) * 0.001 * sampleRate));
  }
  coeffs();
  function update() {
    st.db = gainToDb(st.level);
    if (st.open) { if (st.db < cfg.gateDb - cfg.gateHysteresisDb) st.open = false; }
    else if (st.db >= cfg.gateDb) st.open = true;
    const lo = cfg.floorDb != null ? cfg.floorDb : cfg.gateDb;
    st.value = st.open ? clamp((st.db - lo) / (cfg.ceilDb - lo), 0, 1) : 0;
  }
  return {
    get level() { return st.level; },
    get db() { return st.db; },
    get value() { return st.value; },
    get open() { return st.open; },
    /** Feed one block; returns the state after its last sample. */
    process(block) {
      let e = st.level;
      for (let i = 0; i < block.length; i++) {
        const x = block[i] < 0 ? -block[i] : block[i];
        e = x > e ? a * e + (1 - a) * x : r * e + (1 - r) * x;
      }
      st.level = e < 1e-12 ? 0 : e;
      update();
      return st;
    },
    configure(o = {}) { Object.assign(cfg, o); coeffs(); update(); },
    reset() { st.level = 0; st.open = false; update(); },
  };
}

// ---------------------------------------------------------------- McLeod pitch method

/**
 * @param {object} o
 * @param {number} o.sampleRate
 * @param {number} [o.size] maximum window length (2048)
 * @param {number} [o.minFreq] lowest pitch searched (70 Hz covers drop D)
 * @param {number} [o.maxFreq] highest pitch (1400 Hz: the 24th fret of the high E is 1319 Hz)
 * @param {number} [o.k] MPM threshold: first key maximum >= k * highest is the period
 * @param {number} [o.octaveMargin] prefer twice the period when its NSDF beats ours by this much
 *   (and leaves at most half as much unexplained)
 */
export function createMpm({ sampleRate, size = 2048, minFreq = 70, maxFreq = 1400, k = 0.9, octaveMargin = 0.02 } = {}) {
  const ac = createAutocorrelator(size);
  const x = new Float64Array(size);
  const nsdf = new Float64Array(size);
  const keys = new Int32Array(size);
  const minTau = Math.max(2, Math.floor(sampleRate / maxFreq));
  const maxTau = Math.min(size - 2, Math.ceil(sampleRate / minFreq) + 2);
  const result = { freq: 0, period: 0, clarity: 0, rms: 0, tauMax: 0, full: false };

  /**
   * Analyse buf[start .. start + len). Zeroed or missing history is fine: the
   * NSDF normalisation only counts the samples that overlap.
   * @returns {{freq, period, clarity, rms, tauMax, full}} (the same object every call)
   */
  function analyze(buf, start = 0, len = buf.length - start) {
    len = Math.min(len, size, buf.length - start);
    result.freq = 0; result.period = 0; result.clarity = 0; result.tauMax = 0; result.full = false;
    if (len < 2 * minTau + 4) { result.rms = 0; return result; }
    let mean = 0;
    for (let i = 0; i < len; i++) mean += buf[start + i];
    mean /= len;
    let energy = 0;
    for (let i = 0; i < len; i++) { const v = buf[start + i] - mean; x[i] = v; energy += v * v; }
    result.rms = Math.sqrt(energy / len);
    if (result.rms < 1e-6) return result;

    const re = ac.compute(x, 0, len);

    // The NSDF is only meaningful while enough samples overlap; half the window is the usual limit.
    const tauMax = Math.min(maxTau, len >> 1);
    result.tauMax = tauMax;
    result.full = tauMax >= maxTau;
    let m = 2 * energy;
    nsdf[0] = 1;
    for (let t = 1; t <= tauMax + 1 && t < len; t++) {
      m -= x[t - 1] * x[t - 1] + x[len - t] * x[len - t];
      nsdf[t] = m > 1e-12 ? 2 * re[t] / m : 0;
    }

    // Key maxima: the highest point of each positive lobe after the first
    // negative-going zero crossing (the lobe around lag 0 is not a period).
    let t = 1;
    while (t <= tauMax && nsdf[t] > 0) t++;
    let nk = 0, best = -1;
    while (t <= tauMax) {
      while (t <= tauMax && nsdf[t] <= 0) t++;
      if (t > tauMax) break;
      let peak = t;
      while (t <= tauMax && nsdf[t] > 0) { if (nsdf[t] > nsdf[peak]) peak = t; t++; }
      // A lobe cut off by tauMax has no proven maximum unless it already turned down.
      if (peak >= minTau && peak < tauMax) {
        keys[nk++] = peak;
        if (best < 0 || nsdf[peak] > nsdf[best]) best = peak;
      }
    }
    if (nk === 0) return result;
    const thr = k * nsdf[best];
    let pick = best;
    for (let i = 0; i < nk; i++) if (nsdf[keys[i]] >= thr) { pick = keys[i]; break; }
    let p = parabolic(nsdf, pick);
    let period = pick + p.offset, clarity = p.value;

    // Octave guard: a strong second harmonic can make half the true period pass
    // the k test. The true period then also shows up at twice our lag with a
    // clearly higher NSDF; a genuinely periodic signal never does that.
    const twice = period * 2;
    if (twice <= tauMax) {
      let alt = -1;
      for (let i = 0; i < nk; i++) {
        if (Math.abs(keys[i] - twice) <= Math.max(2, twice * 0.03) && (alt < 0 || nsdf[keys[i]] > nsdf[alt])) alt = keys[i];
      }
      // Switch when twice the lag explains the signal clearly better: higher by
      // octaveMargin and leaving at most half of what our lag leaves unexplained.
      if (alt > 0 && nsdf[alt] > clarity + octaveMargin && 1 - clarity > 2 * (1 - nsdf[alt])) {
        p = parabolic(nsdf, alt);
        period = alt + p.offset; clarity = p.value;
      }
    }
    result.period = period;
    result.clarity = clamp(clarity, 0, 1);
    result.freq = period > 0 ? sampleRate / period : 0;
    return result;
  }

  return { analyze, minTau, maxTau, size, nsdf };
}

/**
 * How periodic a block is: the NSDF value at its period (0 = noise, 1 = a
 * perfectly steady tone). A howling feedback loop is one loud, very steady
 * tone, which is what the feedback guard looks for. Reuses its buffers.
 */
export function createPeriodicityMeter({ sampleRate, size = 2048, minFreq = 50, maxFreq = 4000 } = {}) {
  const mpm = createMpm({ sampleRate, size, minFreq, maxFreq, k: 0.9 });
  return {
    size,
    measure(block) {
      const len = Math.min(block.length, size);
      const r = mpm.analyze(block, block.length - len, len);
      return { clarity: r.clarity, freq: r.freq, rms: r.rms };
    },
  };
}

// ---------------------------------------------------------------- pitch tracker

/** Snap a fractional MIDI pitch to a note with hysteresis: a new note must come within ±h semitones of its own pitch. */
export function quantizeNote(midi, current = null, hysteresis = 0.4) {
  const m = Math.round(midi);
  if (current == null || m === current) return m;
  return Math.abs(midi - current) >= 1 - hysteresis ? m : current;
}

function median3(a, b, c) {
  return a > b ? (b > c ? b : a > c ? c : a) : (a > c ? a : b > c ? c : b);
}

/**
 * Monophonic guitar note tracker.
 * process(block) accepts any block size and returns the events it produced:
 *   { type: 'noteOn',  note, velocity, time, sample, freq, legato }
 *   { type: 'noteOff', note, time, sample }
 *   { type: 'bend',    semitones, time, sample }   (relative to the sounding note)
 * Times are seconds since the tracker started (sample / sampleRate) and are the
 * moment the decision was made, i.e. they include the detection latency.
 */
export function createPitchTracker({
  sampleRate = 48000,
  windowSize = 2048,
  hopSize = 256,
  minFreq = 70,
  maxFreq = 1400,
  clarityThreshold = 0.88,
  hysteresisCents = 40,
  bendRange = 2,
  gateDb = -50,
  onsetRiseDb = 6,
  stableFrames = 2,
  releaseMs = 40,
  bendStepCents = 1,
  k = 0.9,
} = {}) {
  const cfg = { clarityThreshold, hysteresis: hysteresisCents / 100, bendRange, gateDb, onsetRiseDb, stableFrames, releaseMs, bendStep: bendStepCents / 100 };
  const mpm = createMpm({ sampleRate, size: windowSize, minFreq, maxFreq, k });
  const ring = new Float32Array(windowSize);
  const frame = new Float32Array(windowSize);
  let pos = 0;            // samples consumed
  let hopFill = 0;

  // Onset detection in 64-sample sub-blocks on the first difference of the input
  // (+6 dB/octave). A pick is a burst of high frequencies while a ringing string
  // has already lost most of its upper harmonics, so re-picking a sounding note
  // stands out clearly here even when its overall level barely rises. The
  // envelope window spans one period of the lowest note (14 ms at 70 Hz) so a
  // low E does not look like a string of onsets.
  const SUB = 64;
  const envBlocks = Math.max(2, Math.ceil(0.015 * sampleRate / SUB));
  const hist = new Float32Array(envBlocks * 2 + 2); // sub-block HF peaks (dB), newest last
  const lvl = new Float32Array(envBlocks);          // sub-block level peaks (dB), ring
  let histN = 0, lvlN = 0;
  let subPeak = 0, subLevel = 0, subFill = 0, prevX = 0;
  // Level envelope over the last 40 ms: a string decays a few dB per second,
  // so falling 20 dB that fast can only be a palm mute or a lifted finger.
  const dropBlocks = Math.max(2, Math.ceil(0.04 * sampleRate / SUB));
  const envHist = new Float32Array(dropBlocks).fill(-240);
  let envHistN = 0;
  let muted = false;
  let quietUntilPick = false; // after a mute, the dying tail must not start a note
  let onsetPos = -1;        // sample index of the latest onset
  let onsetPending = false; // an onset happened since the last analysis frame
  let lastOnsetPos = -1e12;
  let onsetPeakDb = -240;
  const refractory = Math.round(0.06 * sampleRate);
  let envDb = -240;

  // Note state
  let state = 'idle';       // 'idle' | 'on'
  let note = null, velocity = 0, lastBend = 0;
  let cand = [];            // recent voiced pitches while waiting for a stable note
  let retrig = false;       // waiting for the pitch of a new pick while the old note sounds
  let smooth = [];          // last three voiced pitches (median filter)
  let prevP = [];           // smoothed pitches, newest last
  let unvoicedSamples = 0;
  let octaveSuspect = 0;
  const lastFrame = { time: 0, freq: 0, midi: 0, clarity: 0, db: -240, voiced: false, trusted: false };

  const events = [];
  const emit = (e) => { events.push(e); };
  const tOf = (sample) => sample / sampleRate;

  function subBlockDone() {
    const db = gainToDb(subPeak);
    const levelDb = gainToDb(subLevel);
    if (histN === hist.length) { hist.copyWithin(0, 1); histN--; }
    hist[histN++] = db;
    lvl[lvlN++ % envBlocks] = levelDb;
    subPeak = 0; subLevel = 0; subFill = 0;
    // Current HF envelope: max over the newest envBlocks; reference: the envBlocks before that.
    let cur = -240, ref = -240, level = -240;
    for (let i = Math.max(0, histN - envBlocks); i < histN; i++) if (hist[i] > cur) cur = hist[i];
    for (let i = Math.max(0, histN - 2 * envBlocks); i < histN - envBlocks; i++) if (hist[i] > ref) ref = hist[i];
    for (let i = 0; i < Math.min(lvlN, envBlocks); i++) if (lvl[i] > level) level = lvl[i];
    envDb = level;
    const old = envHist[envHistN % dropBlocks];
    envHist[envHistN++ % dropBlocks] = level;
    if (envHistN > dropBlocks && level < old - 20) muted = true;
    const blockStart = pos - SUB;
    if (histN > envBlocks && levelDb >= cfg.gateDb && db >= ref + cfg.onsetRiseDb && db >= cur - 0.01 && blockStart - lastOnsetPos >= refractory) {
      // Pin the onset to the first sample whose HF content clearly rises above
      // what came before: even 1 ms of pre-pick silence in the analysis window
      // costs the NSDF about 0.15 of clarity on a low E, a hop or two of delay.
      const thr = Math.max(dbToGain(ref + 3), dbToGain(db) * 0.1);
      let at = blockStart;
      const from = Math.max(1, pos - 2 * SUB, pos - windowSize + 2);
      for (let s = from; s < pos; s++) {
        const d = ring[s % windowSize] - ring[(s - 1) % windowSize];
        if ((d < 0 ? -d : d) >= thr) { at = s; break; }
      }
      onsetPos = at;
      lastOnsetPos = at;
      onsetPending = true;
      onsetPeakDb = levelDb;
    } else if (onsetPos >= 0 && pos - onsetPos < 0.02 * sampleRate && levelDb > onsetPeakDb) {
      onsetPeakDb = levelDb;
    }
  }

  function noteOn(n, time, sample, freq, legato) {
    note = n;
    velocity = clamp(0.15 + 0.85 * (onsetPeakDb - cfg.gateDb) / (-3 - cfg.gateDb), 0.05, 1);
    emit({ type: 'noteOn', note: n, velocity, time, sample, freq, legato: !!legato });
    state = 'on';
    lastBend = 0;
    octaveSuspect = 0;
  }

  function noteOff(time, sample) {
    if (note == null) return;
    if (lastBend !== 0) { emit({ type: 'bend', semitones: 0, time, sample }); lastBend = 0; }
    emit({ type: 'noteOff', note, time, sample });
    note = null;
    state = 'idle';
  }

  function bendTo(semis, time, sample) {
    const b = clamp(semis, -cfg.bendRange, cfg.bendRange);
    if (Math.abs(b - lastBend) >= cfg.bendStep || (b === 0 && lastBend !== 0)) {
      lastBend = b;
      emit({ type: 'bend', semitones: b, time, sample });
    }
  }

  function stable(list) {
    if (list.length < cfg.stableFrames) return null;
    const recent = list.slice(-cfg.stableFrames);
    let lo = Infinity, hi = -Infinity;
    for (const v of recent) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo > 0.5) return null;
    const sorted = recent.slice().sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  }

  function analyseFrame() {
    const sample = pos;
    const time = tOf(sample);
    // Nothing sounding and nothing to wait for: skip the FFTs (most of the CPU).
    if (state === 'idle' && !onsetPending && envDb < cfg.gateDb - 6) {
      lastFrame.time = time; lastFrame.freq = 0; lastFrame.midi = 0; lastFrame.clarity = 0;
      lastFrame.db = envDb; lastFrame.voiced = false; lastFrame.trusted = false;
      cand = [];
      if (envDb < cfg.gateDb) quietUntilPick = false;
      return;
    }
    // Unroll the ring buffer, oldest first.
    const w = windowSize;
    const head = pos % w;
    frame.set(ring.subarray(head), 0);
    frame.set(ring.subarray(0, head), w - head);
    // After an onset only the new note counts: earlier samples (silence or the
    // previous note) would hold the old pitch for half a window.
    let start = 0;
    const avail = Math.min(w, pos);
    if (onsetPos >= 0 && pos - onsetPos < avail) start = w - (pos - onsetPos);
    else start = w - avail;
    const r = mpm.analyze(frame, start, w - start);
    const trusted = r.period > 0 && (r.full || r.period * 2 <= r.tauMax);
    const voiced = trusted && r.clarity >= cfg.clarityThreshold && r.freq >= minFreq && r.freq <= maxFreq && envDb >= cfg.gateDb;
    const midi = r.freq > 0 ? freqToMidi(r.freq) : 0;
    lastFrame.time = time; lastFrame.freq = r.freq; lastFrame.midi = midi; lastFrame.clarity = r.clarity;
    lastFrame.db = envDb; lastFrame.voiced = voiced; lastFrame.trusted = trusted;

    const newOnset = onsetPending;
    onsetPending = false;
    const mute = muted && !newOnset;
    muted = false;
    if (mute && state === 'on') { noteOff(time, sample); retrig = false; cand = []; quietUntilPick = true; return; }
    if (newOnset || envDb < cfg.gateDb) quietUntilPick = false;
    if (quietUntilPick) return;
    if (newOnset) {
      cand = [];
      smooth = [];
      prevP = [];
      if (state === 'on') retrig = true;
    }

    if (!voiced) {
      // Still waiting for the first sure estimate of a fresh pick (the window
      // still mixes the old and new string): not a release, so the old note
      // hands straight over to the new one instead of leaving a gap.
      const fresh = onsetPos >= 0 && envDb >= cfg.gateDb && (pos - onsetPos) < 0.12 * sampleRate;
      const waiting = fresh && (!trusted || retrig);
      if (!waiting) cand = [];
      if (state === 'on') {
        unvoicedSamples += hopSize;
        if (envDb < cfg.gateDb - 3 || (!waiting && unvoicedSamples >= cfg.releaseMs * 0.001 * sampleRate)) {
          noteOff(time, sample);
          retrig = false;
        }
      }
      return;
    }
    unvoicedSamples = 0;

    if (state !== 'on' || retrig) {
      cand.push(midi);
      if (cand.length > 8) cand.shift();
      const m = stable(cand);
      if (m == null) return;
      const n = quantizeNote(m, null, cfg.hysteresis);
      if (state === 'on') noteOff(time, sample);
      retrig = false;
      noteOn(n, time, sample, r.freq, false);
      smooth = [m, m, m];
      prevP = [m, m, m];
      bendTo(m - n, time, sample);
      return;
    }

    // Sounding note: median-of-three pitch, then bend / legato / octave guard.
    smooth.push(midi);
    if (smooth.length > 3) smooth.shift();
    const p = smooth.length === 3 ? median3(smooth[0], smooth[1], smooth[2]) : midi;
    const prev = prevP.length ? prevP[prevP.length - 1] : p;
    const jump = p - prev;
    const aj = Math.abs(jump);
    const octaveJump = Math.abs(aj - 12) < 0.5 || Math.abs(aj - 19) < 0.5 || Math.abs(aj - 24) < 0.5;
    if (octaveJump && octaveSuspect < 4) {
      // A lone octave (or twelfth) jump without a pick is almost always a
      // detector error; believe it only when it persists for four hops.
      octaveSuspect++;
      return;
    }
    octaveSuspect = 0;
    prevP.push(p);
    if (prevP.length > 4) prevP.shift();
    const before = prevP.length >= 3 ? prevP[prevP.length - 3] : prevP[0];
    const abrupt = Math.abs(p - before) >= 0.6;
    const dev = p - note;
    const target = quantizeNote(p, note, cfg.hysteresis);
    if ((abrupt && target !== note) || Math.abs(dev) > cfg.bendRange + cfg.hysteresis) {
      // Hammer-on, pull-off, slide, or a bend past the bend range: a new note, legato.
      cand.push(p);
      const m = stable(cand.slice(-cfg.stableFrames));
      if (m == null && abrupt) return;
      const n = quantizeNote(m != null ? m : p, note, cfg.hysteresis);
      if (n !== note) {
        noteOff(time, sample);
        noteOn(n, time, sample, r.freq, true);
        cand = [];
        bendTo((m != null ? m : p) - n, time, sample);
        return;
      }
    }
    cand = [];
    bendTo(dev, time, sample);
  }

  /** Feed samples (any block size). Returns the events produced (array reused per call). */
  function process(block) {
    events.length = 0;
    for (let i = 0; i < block.length; i++) {
      const v = block[i];
      ring[pos % windowSize] = v;
      pos++;
      const a = v < 0 ? -v : v;
      if (a > subLevel) subLevel = a;
      const d = v - prevX;
      prevX = v;
      const ad = d < 0 ? -d : d;
      if (ad > subPeak) subPeak = ad;
      if (++subFill === SUB) subBlockDone();
      if (++hopFill === hopSize) { hopFill = 0; analyseFrame(); }
    }
    return events;
  }

  function reset() {
    ring.fill(0); pos = 0; hopFill = 0; histN = 0; lvlN = 0; subPeak = 0; subLevel = 0; subFill = 0; prevX = 0;
    onsetPos = -1; onsetPending = false; lastOnsetPos = -1e12; envDb = -240; envHist.fill(-240); envHistN = 0; muted = false; quietUntilPick = false;
    state = 'idle'; note = null; cand = []; retrig = false; smooth = []; prevP = []; unvoicedSamples = 0; lastBend = 0;
  }

  return {
    process,
    reset,
    configure(o = {}) {
      if (o.clarityThreshold != null) cfg.clarityThreshold = o.clarityThreshold;
      if (o.hysteresisCents != null) cfg.hysteresis = o.hysteresisCents / 100;
      if (o.bendRange != null) cfg.bendRange = o.bendRange;
      if (o.gateDb != null) cfg.gateDb = o.gateDb;
      if (o.onsetRiseDb != null) cfg.onsetRiseDb = o.onsetRiseDb;
      if (o.releaseMs != null) cfg.releaseMs = o.releaseMs;
    },
    get note() { return note; },
    get lastFrame() { return lastFrame; },
    get samples() { return pos; },
    get sampleRate() { return sampleRate; },
    hopSize, windowSize,
  };
}

/**
 * Run a tracker over a whole buffer (tests, offline analysis). Returns the
 * events and, if `frames` is set, every analysis frame.
 */
export function trackBuffer(samples, sampleRate, opts = {}, { block = 128, frames = false } = {}) {
  const tr = createPitchTracker({ sampleRate, ...opts });
  const events = [];
  const fr = [];
  for (let i = 0; i < samples.length; i += block) {
    const ev = tr.process(samples.subarray(i, Math.min(samples.length, i + block)));
    for (const e of ev) events.push({ ...e });
    if (frames && tr.lastFrame.time > (fr.length ? fr[fr.length - 1].time : -1)) fr.push({ ...tr.lastFrame });
  }
  return { events, frames: fr };
}
