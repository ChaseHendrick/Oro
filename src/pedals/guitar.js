// Guitar input for Oro (docs/PEDALS.md, "Guitar as modulation / notes / terrain").
//
//   createGuitarInput(ctx, sourceNode)  envelope follower + pitch tracker on the
//       input, in the 'orograph-guitar' AudioWorklet (guitar-worklet.js) when it is
//       loaded, else through a ScriptProcessor. Optional Chords estimation
//       uses a dedicated Worker, with a main-thread fallback. Emits
//       'noteOn' / 'noteOff' / 'bend' / 'level' / 'pitch' with AudioContext times.
//   captureToWavetable(samples, sampleRate)  a held note -> a wavetable terrain:
//       finds the note's period, cuts one cycle at a time from the attack to the
//       decay, and returns a UserTerrain in the same shape as
//       src/audio/importers.js wavetables ({kind: 'wavetable', w: 256, h: frames,
//       mirror: 1, data, lo}).
//
// Both live paths use guitar-analysis.js, backed by pitch.js or chords.js.

import { fft, ifft, nextPow2, freqToMidi, gainToDb, bytesToBase64 } from './signal.js';
import { createMpm, createEnvelopeFollower } from './pitch.js';
import { createGuitarAnalysis, normalizeGuitarMode } from './guitar-analysis.js';
import { createChordRunner } from './guitar-chord-runner.js';

export { createPitchTracker, createEnvelopeFollower, createMpm, trackBuffer, quantizeNote } from './pitch.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const WAVETABLE_WIDTH = 256;   // = TABLE_SIZE in src/audio/importers.js
export const WAVETABLE_MAX_FRAMES = 256; // = MAX_FRAMES in src/audio/importers.js

// ---------------------------------------------------------------- capture -> wavetable

/** Catmull-Rom sample of x at fractional position p (clamped at the ends). */
function cubicAt(x, p) {
  const i = Math.floor(p);
  const t = p - i;
  const n = x.length - 1;
  const p0 = x[clamp(i - 1, 0, n)], p1 = x[clamp(i, 0, n)], p2 = x[clamp(i + 1, 0, n)], p3 = x[clamp(i + 2, 0, n)];
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

/**
 * One period starting at fractional sample `start` with length `period`,
 * band-limited to the harmonics the source could hold (below its Nyquist) and
 * the table can hold (below width / 2), phase-aligned so the fundamental starts
 * like a sine. Aligning every frame the same way keeps the terrain's rows in
 * step, so slow pitch drift does not smear the map into diagonal stripes.
 */
export function extractCycle(x, start, period, width = WAVETABLE_WIDTH) {
  const L = Math.max(width, nextPow2(Math.ceil(period)));
  const re = new Float64Array(L), im = new Float64Array(L);
  for (let j = 0; j < L; j++) re[j] = cubicAt(x, start + j * period / L);
  fft(re, im);
  const H = Math.max(1, Math.min(Math.floor(period / 2) - 1, width / 2 - 1));
  const phi1 = Math.atan2(im[1], re[1]);
  const shift = -Math.PI / 2 - phi1;
  const or = new Float64Array(width), oi = new Float64Array(width);
  for (let h = 1; h <= H; h++) {
    const mag = Math.hypot(re[h], im[h]);
    const ph = Math.atan2(im[h], re[h]) + h * shift;
    // Positive and mirrored bins so the inverse FFT is real.
    or[h] = mag * Math.cos(ph) / L; oi[h] = mag * Math.sin(ph) / L;
    or[width - h] = or[h]; oi[width - h] = -oi[h];
  }
  ifft(or, oi);
  const out = new Float64Array(width);
  for (let i = 0; i < width; i++) out[i] = or[i] * width;
  return out;
}

/** Frames -> 16-bit planes centred on 32767.5 (high byte = the 8-bit table), one shared scale. */
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

function envelope(x, win) {
  const n = Math.floor(x.length / win);
  const env = new Float64Array(n);
  for (let b = 0; b < n; b++) {
    let s = 0;
    for (let i = b * win; i < (b + 1) * win; i++) s += x[i] * x[i];
    env[b] = Math.sqrt(s / win);
  }
  return env;
}

/**
 * A recorded held note -> wavetable terrain frames, attack to decay.
 * @param {Float32Array} samples mono recording (the clean DI is best)
 * @param {number} sampleRate
 * @param {object} [o]
 * @param {number} [o.frames] how many rows (2..256); default as many as fit, up to 256
 * @param {'each'|'shared'} [o.normalize] 'each' lifts quiet decay frames (up to maxGainDb) so the
 *   terrain is about timbre, not loudness; 'shared' keeps the natural fade
 * @returns {{ok: true, userTerrain, frames, freq, note, periodSamples, clarity, startSec, endSec}
 *   | {ok: false, reason: string}}
 */
export function captureToWavetable(samples, sampleRate, {
  name = 'Guitar capture', frames: wantFrames = 0, width = WAVETABLE_WIDTH, minFreq = 60, maxFreq = 1500,
  normalize = 'each', maxGainDb = 24, floorDb = -40,
} = {}) {
  const x = samples;
  if (!x || !(sampleRate > 0) || x.length < 0.2 * sampleRate) {
    return { ok: false, reason: 'The recording is too short. Hold one note for at least half a second.' };
  }
  const win = Math.max(64, Math.round(0.01 * sampleRate));
  const env = envelope(x, win);
  let peakB = 0;
  for (let b = 1; b < env.length; b++) if (env[b] > env[peakB]) peakB = b;
  const peakDb = gainToDb(env[peakB]);
  if (peakDb < -60) return { ok: false, reason: 'The recording is silent. Check the input and play a little louder.' };
  // Attack: first block within 20 dB of the peak. End: last block above floorDb (relative).
  let a = 0;
  while (a < peakB && gainToDb(env[a]) < peakDb - 20) a++;
  let e = env.length - 1;
  while (e > peakB && gainToDb(env[e]) < peakDb + floorDb) e--;
  const attack = a * win;
  const end = Math.min(x.length, (e + 1) * win);

  // The note's pitch: median of confident MPM estimates across the steady part.
  const mpm = createMpm({ sampleRate, size: 4096, minFreq, maxFreq, k: 0.9 });
  const steady = Math.min(end - 1, attack + Math.round(0.04 * sampleRate));
  const span = 4096;
  const est = [];
  for (let k = 0; k < 9; k++) {
    const s = Math.round(steady + (end - steady - span) * k / 8);
    if (s < 0 || s + span > x.length) continue;
    const r = mpm.analyze(x, s, span);
    if (r.clarity >= 0.85 && r.period > 0) est.push({ period: r.period, clarity: r.clarity });
  }
  if (est.length < 2) {
    return { ok: false, reason: 'Oro could not find a steady pitch. Hold one clear note (no chords) for about a second, then try Capture again.' };
  }
  est.sort((p, q) => p.period - q.period);
  const P = est[est.length >> 1].period;
  const clarity = est.reduce((s, r) => s + r.clarity, 0) / est.length;

  const usable = end - attack - 2 * P;
  const fit = Math.floor(usable / P);
  if (fit < 2) return { ok: false, reason: 'The note is too short to capture. Let it ring for a moment longer.' };
  const count = clamp(wantFrames > 0 ? Math.round(wantFrames) : fit, 2, Math.min(WAVETABLE_MAX_FRAMES, fit));

  // Local period near each frame (strings go a little sharp in the attack),
  // kept within 6% of the note's period so a noisy estimate cannot jump octaves.
  const local = createMpm({ sampleRate, size: 2048, minFreq: sampleRate / (P * 1.06) - 1, maxFreq: sampleRate / (P * 0.94) + 1, k: 0.9 });
  const frames = [];
  let prevP = P;
  for (let k = 0; k < count; k++) {
    const s = attack + (usable - P) * k / Math.max(1, count - 1);
    let p = prevP;
    const len = Math.min(2048, Math.max(Math.ceil(4 * P), 512));
    const s0 = Math.floor(s);
    if (s0 + len <= x.length) {
      const r = local.analyze(x, s0, len);
      if (r.clarity >= 0.8 && Math.abs(r.period - P) <= 0.06 * P) p = r.period;
    }
    prevP = p;
    frames.push(extractCycle(x, s, p, width));
  }

  // Levels: 'each' brings every frame up to the loudest, limited to maxGainDb
  // so the noise at the end of the decay is not blown up.
  const peaks = frames.map(f => { let m = 0; for (let i = 0; i < f.length; i++) m = Math.max(m, Math.abs(f[i])); return m; });
  const top = Math.max(...peaks);
  if (normalize === 'each') {
    const maxG = Math.pow(10, maxGainDb / 20);
    frames.forEach((f, k) => {
      const g = peaks[k] > 1e-12 ? Math.min(top / peaks[k], maxG) : 1;
      for (let i = 0; i < f.length; i++) f[i] *= g;
    });
  }
  const { hi, lo } = framesToPlanes(frames);
  const freq = sampleRate / P;
  const note = freqToMidi(freq);
  return {
    ok: true,
    userTerrain: {
      name: String(name || 'Guitar capture').slice(0, 80),
      kind: 'wavetable',
      w: width,
      h: frames.length,
      mirror: 1,
      data: bytesToBase64(hi),
      lo: bytesToBase64(lo),
    },
    frames,
    freq,
    note,
    periodSamples: P,
    clarity,
    startSec: attack / sampleRate,
    endSec: end / sampleRate,
  };
}

// ---------------------------------------------------------------- live input (browser)

/**
 * Track a guitar on `source` (an AudioNode: openReturn(...).guitar, or a
 * MediaStreamAudioSourceNode of the DI). Load the worklet first with
 * loadPedalWorklets(ctx) from worklet-loader.js; without it the same analysis
 * runs on the main thread (less steady timing, same results).
 *
 * Events (all times are AudioContext seconds):
 *   noteOn {note, velocity, time, freq, legato}  noteOff {note, time}
 *   bend {semitones, time}   level {value 0..1, db, open, time} at ~100 Hz
 *   pitch {mode: 'single', freq, midi, clarity, voiced, time} at ~30 Hz
 *      or {mode: 'chords', notes: [MIDI], heard: [MIDI], voiced, time}.
 * Chords is optional; the default Single detector also serves Voice input.
 */
export function createGuitarInput(ctx, source, { channel = 0, guitarMode = 'single', tracker = {}, envelope = {}, envRateHz = 100, pitchRateHz = 30 } = {}) {
  const listeners = new Map();
  const emit = (type, e) => { for (const fn of [...(listeners.get(type) || [])]) { try { fn(e); } catch (err) { console.error('[guitar] listener failed', err); } } };
  const state = { level: 0, db: -240, guitarMode: normalizeGuitarMode(guitarMode), revision: 0, notes: new Set() };
  let node = null, via = 'worklet', script = null;
  let disposed = false;
  let chordRunner = null, trackerOptions = { ...tracker };

  function releaseNotes() {
    for (const note of [...state.notes]) handle({ t: 'noteOff', note, mode: state.guitarMode, time: ctx.currentTime });
    handle({ t: 'pitch', mode: state.guitarMode, notes: [], voiced: false, time: ctx.currentTime });
  }

  function chords() {
    if (!chordRunner) chordRunner = createChordRunner({
      sampleRate: ctx.sampleRate, tracker: trackerOptions, emit: handle,
      onReset: () => { if (!disposed && state.guitarMode === 'chords') releaseNotes(); },
    });
    return chordRunner;
  }

  function handle(m) {
    if (disposed || !m || !m.t) return;
    // A mode change can overtake messages already queued by the audio thread.
    if (m.mode && m.mode !== state.guitarMode && m.t !== 'level') return;
    if (m.revision !== undefined && m.revision !== state.revision && m.t !== 'level') return;
    if (m.t === 'samples') { if (state.guitarMode === 'chords') chords().process(m.data, m.time); return; }
    if (m.t === 'level') { state.level = m.value; state.db = m.db; }
    if (m.t === 'noteOn') state.notes.add(m.note);
    if (m.t === 'noteOff') {
      if (!state.notes.has(m.note)) return;
      state.notes.delete(m.note);
    }
    const { t, ...rest } = m;
    emit(t, rest);
  }

  try {
    node = new AudioWorkletNode(ctx, 'orograph-guitar', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { channel, guitarMode: state.guitarMode, revision: state.revision, tracker, envelope, envRateHz, pitchRateHz },
    });
    node.port.onmessage = (e) => handle(e.data);
  } catch {
    via = 'script';
    const tr = createGuitarAnalysis({ sampleRate: ctx.sampleRate, tracker });
    const env = createEnvelopeFollower({ sampleRate: ctx.sampleRate, ...envelope });
    // Large buffer: this path only runs when the worklet cannot, and a busy main
    // thread drops small ScriptProcessor buffers (gaps the tracker hears as notes ending).
    const size = 2048;
    node = ctx.createScriptProcessor(size, 2, 1);
    let lastLevel = -1, lastPitch = -1, lastPlayback = null;
    script = { tr, env, dropouts: 0 };
    node.onaudioprocess = (ev) => {
      if (disposed) return;
      const ib = ev.inputBuffer;
      const x = ib.getChannelData(Math.min(channel, ib.numberOfChannels - 1));
      const step = size / ctx.sampleRate;
      // A busy main thread makes the browser skip callbacks: count the gaps.
      if (lastPlayback != null && ev.playbackTime - lastPlayback > 1.5 * step) script.dropouts++;
      lastPlayback = ev.playbackTime;
      // playbackTime is when this callback's output starts playing; the input it
      // hands us is the buffer that ended where that output begins, so it
      // started two buffers before playbackTime.
      const t0 = ev.playbackTime - 2 * step;
      if (state.guitarMode === 'chords') chords().process(x.slice(), t0);
      else {
        const before = tr.samples;
        for (const e of tr.process(x)) handle({ t: e.type, ...e, mode: 'single', time: t0 + (e.sample - before) / ctx.sampleRate });
      }
      const s = env.process(x);
      const now = ev.playbackTime;
      if (now - lastLevel >= 1 / envRateHz) { lastLevel = now; handle({ t: 'level', value: s.value, db: s.db, open: s.open, time: now }); }
      if (state.guitarMode === 'single' && now - lastPitch >= 1 / pitchRateHz) {
        lastPitch = now;
        handle({ t: 'pitch', ...tr.pitch, time: now });
      }
    };
  }
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(node);
  node.connect(sink);
  sink.connect(ctx.destination);
  if (state.guitarMode === 'chords') chords();

  return {
    via,
    /** ScriptProcessor fallback only: callbacks the browser skipped (main thread too busy). */
    get dropouts() { return script ? script.dropouts : 0; },
    get chordAnalysisMode() { return chordRunner ? chordRunner.mode : null; },
    get analysisDropouts() { return chordRunner ? chordRunner.dropouts : 0; },
    get level() { return state.level; },
    get db() { return state.db; },
    get note() { return state.notes.size ? [...state.notes].at(-1) : null; },
    get notes() { return [...state.notes].sort((a, b) => a - b); },
    get guitarMode() { return state.guitarMode; },
    on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn); },
    off(type, fn) { const s = listeners.get(type); if (s) s.delete(fn); },
    /** Change tracker / envelope settings live (clarityThreshold, hysteresisCents, bendRange, gateDb, attackMs, releaseMs ...). */
    configure({ guitarMode: value, tracker: t = {}, envelope: e = {} } = {}) {
      if (disposed) return;
      const mode = value === undefined ? state.guitarMode : normalizeGuitarMode(value);
      const changed = mode !== state.guitarMode;
      trackerOptions = { ...trackerOptions, ...t };
      if (changed) {
        releaseNotes();
        state.guitarMode = mode;
        state.revision++;
        chordRunner?.dispose(); chordRunner = null;
      }
      if (mode === 'chords') chords().configure(t);
      if (via === 'worklet') node.port.postMessage({ t: 'config', guitarMode: mode, revision: state.revision, tracker: t, envelope: e });
      else {
        if (changed) script.tr.reset();
        script.tr.configure({ tracker: t });
        script.env.configure(e);
        if (mode === 'single') handle({ t: 'pitch', ...script.tr.pitch, time: ctx.currentTime });
      }
    },
    dispose() {
      if (disposed) return;
      for (const note of [...state.notes]) handle({ t: 'noteOff', note, mode: state.guitarMode, time: ctx.currentTime });
      disposed = true;
      chordRunner?.dispose(); chordRunner = null;
      try { source.disconnect(node); } catch { /* ignore */ }
      try { node.disconnect(); sink.disconnect(); } catch { /* ignore */ }
      if (via === 'worklet') { try { node.port.postMessage({ t: 'stop' }); } catch { /* ignore */ } }
      else node.onaudioprocess = null;
      listeners.clear();
    },
  };
}
