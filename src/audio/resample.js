// Resample (v1.2): any stereo audio (the looper's loop, or bars captured from
// the master output) -> a wavetable user terrain, through the same cycle
// extractor and 16-bit planes as guitar Capture (src/pedals/guitar.js).
//
// Pitched material (a held note, a drone, a riff on one pitch) goes through
// captureToWavetable itself. Anything else (drums, chords, noise, a whole mix)
// has no single period, so it is sliced into frames of a fixed period instead:
// either one derived from the tempo (the beat divided by powers of two until it
// lands between 55 and 110 Hz, so the slices stay in step with the music) or
// the period of a chosen root note. Playing that note on the new terrain plays
// each slice at its original speed.
//
// Every frame is band-limited before it becomes a table row (only harmonics
// the period and the 256-sample row can hold are kept, and DC is dropped), so
// the existing mip-mapped tables play it back without aliasing. Levels are
// evened out across frames (at most +12 dB) and the whole table is scaled to
// full range in the 16-bit planes.

import { captureToWavetable, extractCycle, framesToPlanes, WAVETABLE_WIDTH, WAVETABLE_MAX_FRAMES } from '../pedals/guitar.js';
import { createMpm } from '../pedals/pitch.js';
import { bytesToBase64, freqToMidi, midiToFreq, gainToDb } from '../pedals/signal.js';

export const SLICE_MODES = Object.freeze(['auto', 'tempo', 'root']);
export const RESAMPLE_PREFIX = 'Resample';
export const TEMPO_FREQ_LOW = 55;           // tempo slices land in [55, 110) Hz
const MAX_GAIN_DB = 12;
const SILENT_DB = -60;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** MIDI note -> 'C3' (C4 = 60, as on the keyboard). */
export function noteName(m) {
  const n = Math.round(m);
  return Number.isFinite(n) ? `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}` : '?';
}

/**
 * The next free "Resample N" name: one more than the highest N used by any
 * part's user terrain in `state` (a store snapshot or store.serialize()).
 */
export function nextResampleName(state) {
  let top = 0;
  const re = new RegExp(`^${RESAMPLE_PREFIX} (\\d+)$`);
  for (const p of (state && Array.isArray(state.parts) ? state.parts : [])) {
    const ut = p && p.userTerrain;
    for (const slot of ['A', 'B']) {
      const m = ut && ut[slot] && typeof ut[slot].name === 'string' ? re.exec(ut[slot].name) : null;
      if (m) top = Math.max(top, Number(m[1]));
    }
  }
  return `${RESAMPLE_PREFIX} ${top + 1}`;
}

/**
 * Slice period from the tempo: the beat frequency doubled until it lies in
 * [TEMPO_FREQ_LOW, 2 * TEMPO_FREQ_LOW). `division` is the note value (16 = a 1/16 note).
 */
export function tempoSlice(bpm, sampleRate) {
  const beatHz = clamp(Number(bpm) || 120, 20, 400) / 60;
  const k = Math.max(0, Math.ceil(Math.log2(TEMPO_FREQ_LOW / beatHz) - 1e-9));
  const freq = beatHz * Math.pow(2, k);
  return { freq, period: sampleRate / freq, division: 4 * Math.pow(2, k) };
}

/** Average to mono and remove the DC offset. */
export function monoNoDc(L, R) {
  const n = L.length;
  const out = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) { const v = 0.5 * (L[i] + (R ? R[i] : L[i])); out[i] = v; mean += v; }
  mean = n ? mean / n : 0;
  if (mean !== 0) for (let i = 0; i < n; i++) out[i] -= mean;
  return out;
}

/**
 * Is there one steady pitch across the material? MPM on windows spread over
 * it: pitched when most audible windows are clear and agree within 3%.
 * @returns {{pitched: boolean, period: number, freq: number, clarity: number, windows: number, agree: number}}
 */
export function steadyPitch(x, sampleRate, { windows = 16, size = 4096, minFreq = 55, maxFreq = 1500 } = {}) {
  const res = { pitched: false, period: 0, freq: 0, clarity: 0, windows: 0, agree: 0 };
  if (x.length < size) return res;
  const mpm = createMpm({ sampleRate, size, minFreq, maxFreq, k: 0.9 });
  let peak = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
  if (gainToDb(peak) < SILENT_DB) return res;
  const est = [];
  let audible = 0;
  for (let w = 0; w < windows; w++) {
    const s = Math.round((x.length - size) * w / Math.max(1, windows - 1));
    const r = mpm.analyze(x, s, size);
    if (gainToDb(r.rms * Math.SQRT2) < gainToDb(peak) - 30) continue;
    audible++;
    if (r.clarity >= 0.9 && r.period > 0) est.push(r);
  }
  res.windows = audible;
  if (audible < 2 || est.length < Math.max(2, Math.ceil(0.75 * audible))) return res;
  const periods = est.map(r => r.period).sort((a, b) => a - b);
  const P = periods[periods.length >> 1];
  const agree = est.filter(r => Math.abs(r.period - P) <= 0.03 * P).length;
  res.period = P;
  res.freq = sampleRate / P;
  res.clarity = est.reduce((s, r) => s + r.clarity, 0) / est.length;
  res.agree = agree / audible;
  res.pitched = agree >= Math.ceil(0.75 * audible);
  return res;
}

/** Even out frame levels (at most +maxGainDb, silent frames left alone). */
function levelFrames(frames, maxGainDb = MAX_GAIN_DB) {
  const peaks = frames.map(f => { let m = 0; for (let i = 0; i < f.length; i++) m = Math.max(m, Math.abs(f[i])); return m; });
  const top = Math.max(0, ...peaks);
  if (!(top > 0)) return;
  const maxG = Math.pow(10, maxGainDb / 20);
  const floor = top * Math.pow(10, SILENT_DB / 20);
  frames.forEach((f, k) => {
    if (peaks[k] <= floor) return;
    const g = Math.min(top / peaks[k], maxG);
    for (let i = 0; i < f.length; i++) f[i] *= g;
  });
}

/** Fixed-period slicing: `count` frames of `period` samples spread over x. */
export function sliceFrames(x, period, { width = WAVETABLE_WIDTH, frames: want = 0 } = {}) {
  const usable = x.length - period - 2;
  const fit = Math.floor(usable / period);
  if (fit < 2) return null;
  const count = clamp(want > 0 ? Math.round(want) : fit, 2, Math.min(WAVETABLE_MAX_FRAMES, fit));
  const out = [];
  for (let k = 0; k < count; k++) out.push(extractCycle(x, usable * k / (count - 1), period, width));
  return out;
}

/**
 * Stereo audio -> a wavetable UserTerrain.
 * @param {Float32Array} L
 * @param {Float32Array} R
 * @param {number} sampleRate
 * @param {object} [o]
 * @param {'auto'|'tempo'|'root'} [o.slice] auto: pitch detection, else tempo slices
 * @param {number} [o.tempo] BPM for tempo slices
 * @param {number} [o.rootNote] MIDI note for root slices
 * @param {string} [o.name]
 * @returns {{ok: true, userTerrain, mode: 'pitch'|'tempo'|'root', freq, note, periodSamples, frames: number, detail: string, pitchFound: boolean}
 *   | {ok: false, reason: string}}
 */
export function resampleToWavetable(L, R, sampleRate, { slice = 'auto', tempo = 120, rootNote = 48, name = `${RESAMPLE_PREFIX} 1`, width = WAVETABLE_WIDTH } = {}) {
  if (!L || !(sampleRate > 0)) return { ok: false, reason: 'There is no audio to resample.' };
  if (L.length < 0.1 * sampleRate) return { ok: false, reason: 'The audio is too short to resample. Record at least a beat.' };
  const x = monoNoDc(L, R);
  let peak = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
  if (gainToDb(peak) < SILENT_DB) return { ok: false, reason: 'The audio is silent. Play something into the loop first.' };
  const label = String(name || RESAMPLE_PREFIX).slice(0, 80);
  const mode = SLICE_MODES.includes(slice) ? slice : 'auto';

  if (mode === 'auto') {
    const p = steadyPitch(x, sampleRate);
    if (p.pitched) {
      const cap = captureToWavetable(x, sampleRate, { name: label, normalize: 'each', maxGainDb: MAX_GAIN_DB, minFreq: 55, maxFreq: 1500, width });
      if (cap.ok) {
        return {
          ok: true, userTerrain: cap.userTerrain, mode: 'pitch', pitchFound: true,
          freq: cap.freq, note: cap.note, periodSamples: cap.periodSamples, frames: cap.userTerrain.h,
          detail: `Pitch found: ${noteName(cap.note)} (${cap.freq.toFixed(1)} Hz), ${cap.userTerrain.h} frames.`,
        };
      }
    }
  }

  let freq, detail, used;
  if (mode === 'root') {
    const note = clamp(Math.round(Number(rootNote) || 48), 12, 108);
    freq = midiToFreq(note);
    used = 'root';
    detail = `Sliced at the period of ${noteName(note)} (${freq.toFixed(1)} Hz). Play ${noteName(note)} to hear it at the original speed.`;
  } else {
    const t = tempoSlice(tempo, sampleRate);
    freq = t.freq;
    used = 'tempo';
    const note = freqToMidi(freq);
    detail = `${mode === 'auto' ? 'No steady pitch found, so the audio was' : 'The audio was'} sliced at a period from the tempo (a 1/${t.division} note, ${freq.toFixed(1)} Hz). Play ${noteName(note)} to hear it near the original speed.`;
  }
  const period = sampleRate / freq;
  const frames = sliceFrames(x, period, { width });
  if (!frames) return { ok: false, reason: 'The audio is too short for that slice length. Record a longer loop.' };
  levelFrames(frames);
  const { hi, lo } = framesToPlanes(frames);
  return {
    ok: true,
    userTerrain: { name: label, kind: 'wavetable', w: width, h: frames.length, mirror: 1, data: bytesToBase64(hi), lo: bytesToBase64(lo) },
    mode: used,
    pitchFound: false,
    freq,
    note: freqToMidi(freq),
    periodSamples: period,
    frames: frames.length,
    detail: `${detail} ${frames.length} frames.`,
  };
}
