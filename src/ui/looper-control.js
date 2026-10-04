// Looper control (v1.2): the one object the top-bar loop button, the Loop
// dock tab, the keyboard shortcuts and MIDI-learned buttons all drive. It
// wraps engine.looper (src/audio/looper.js), keeps the looper settings for
// this device (localStorage 'orograph.looper', not part of a song), and runs
// Resample and Export WAV.
//
// Resample: the current loop, or (when the looper is empty) a few bars
// captured from the master output, becomes a wavetable user terrain in the
// selected part's slot A or B (src/audio/resample.js), named "Resample N".
//
// Follow tempo (v2.8): when the tempo changes, a loop recorded in bars is
// time-stretched (src/dsp/time-stretch.js, pitch kept) to the same number of
// bars at the new tempo, from an untouched copy of the loop as it was
// recorded so repeated changes do not pile up artefacts. Fit to tempo does it
// once on demand, and also snaps a free-length loop to whole bars.

import { createEmitter } from '../audio/emitter.js';
import { resampleToWavetable, nextResampleName, noteName, SLICE_MODES } from '../audio/resample.js';
import { addUserTerrain } from '../audio/importers.js';
import { LOOP_BARS, DEFAULT_BARS, MAX_LOOP_SECONDS, loopFrames } from '../audio/looper-core.js';
import { stretchToLength } from '../dsp/time-stretch.js';
import { recordingName } from './record.js';

export const LOOPER_PREFS_KEY = 'orograph.looper';
export const EXPORT_FORMATS = Object.freeze(['pcm24', 'float32']);
export const LOOPER_PREF_DEFAULTS = Object.freeze({
  bars: DEFAULT_BARS, volume: 1, feedback: 1, slot: 'A', slice: 'auto', root: 48, format: 'pcm24', follow: 0,
  speed: 1,
});
/** Relative tempo difference below which a loop counts as already in time. */
const FIT_TOLERANCE = 0.001;
const FIT_DELAY_MS = 350;

const unit = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const VALID = {
  bars: v => LOOP_BARS.includes(v),
  volume: unit,
  feedback: unit,
  slot: v => v === 'A' || v === 'B',
  slice: v => SLICE_MODES.includes(v),
  root: v => Number.isInteger(v) && v >= 24 && v <= 84,
  format: v => EXPORT_FORMATS.includes(v),
  follow: v => v === 0 || v === 1,
  speed: v => typeof v === 'number' && Number.isFinite(v) && v >= -2 && v <= 2,
};

/** Signed tape rate, -2..2. Exactly +/-1, +/-0.5, +/-2 and 0 stay exact. Near +/-1 snaps so the integer playhead still applies. */
export function quantizeSignedSpeed(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  const c = n < -2 ? -2 : n > 2 ? 2 : n;
  if (Math.abs(c) < 1e-4) return 0;
  if (Math.abs(c - 1) < 1e-4) return 1;
  if (Math.abs(c + 1) < 1e-4) return -1;
  if (c === 0.5 || c === -0.5 || c === 2 || c === -2) return c;
  return c;
}

/**
 * Slider bend -1..1. Center is exactly +1.00x. The right half runs up to
 * +2.00x. The left half runs down through a stop to 2.00x backward.
 */
export function tapeBendToRate(bend) {
  const b = Math.max(-1, Math.min(1, Number(bend) || 0));
  if (Math.abs(b) < 1e-4) return 1;
  return quantizeSignedSpeed(b >= 0 ? 1 + b : 1 + b * 3);
}

/** Inverse of tapeBendToRate. */
export function tapeRateToBend(rate) {
  const r = quantizeSignedSpeed(rate);
  if (r >= 1) return Math.max(0, Math.min(1, r - 1));
  return Math.max(-1, Math.min(0, (r - 1) / 3));
}

/** "1.00×" or "2.00× back". */
export function tapeSpeedText(rate) {
  const r = quantizeSignedSpeed(rate);
  const text = `${Math.abs(r).toFixed(2)}\u00d7`;
  return r < -1e-6 ? `${text} back` : text;
}

function signedSpeedFrom(src) {
  if (!src || typeof src.speed !== 'number' || !Number.isFinite(src.speed)) return 1;
  const sp = src.speed;
  const rev = src.reverse;
  const legacy = (sp === 0.5 || sp === 1 || sp === 2) && (rev === 0 || rev === 1);
  return quantizeSignedSpeed(legacy ? (rev ? -sp : sp) : sp);
}

export function sanitizeLooperPrefs(src) {
  const out = { ...LOOPER_PREF_DEFAULTS };
  if (!src || typeof src !== 'object') return out;
  for (const k of Object.keys(out)) {
    if (k === 'speed') continue;
    if (VALID[k](src[k])) out[k] = src[k];
  }
  out.speed = signedSpeedFrom(src);
  return out;
}

export function loadLooperPrefs(storage = globalThis.localStorage) {
  try { const raw = storage && storage.getItem(LOOPER_PREFS_KEY); return sanitizeLooperPrefs(raw ? JSON.parse(raw) : null); } catch { return { ...LOOPER_PREF_DEFAULTS }; }
}

export function saveLooperPrefs(prefs, storage = globalThis.localStorage) {
  try { if (storage) storage.setItem(LOOPER_PREFS_KEY, JSON.stringify(sanitizeLooperPrefs(prefs))); } catch { /* blocked */ }
}

/** File name for a loop export: orograph-loop-YYYYMMDD-HHMMSS.wav. */
export function loopFileName(date = new Date()) {
  return recordingName(date).replace('oro-', 'oro-loop-');
}

/**
 * How the main loop button looks and what pressing it does, for a looper status.
 * @returns {{tone: 'idle'|'armed'|'record'|'play'|'overdub'|'paused'|'off', icon, label, aria, next}}
 */
export function looperView(st, { available = true, playing = false } = {}) {
  if (!available) return { tone: 'off', icon: 'loop', label: 'Loop', aria: 'Looper not available', next: '' };
  const s = st && st.state;
  switch (s) {
    case 'armed': return { tone: 'armed', icon: 'record', label: 'Wait', aria: 'Looper armed: recording starts on the next bar. Press to cancel', next: 'cancel' };
    case 'record': return { tone: 'record', icon: 'record', label: 'Rec', aria: st.recTarget ? 'Looper recording. Press to close the loop at the next bar' : 'Looper recording. Press to close the loop and play it', next: 'close' };
    case 'play': return { tone: 'play', icon: 'play', label: st.cue ? 'Cued' : 'Play', aria: st.cue ? 'Loop waiting for bar 1. Press to overdub' : 'Loop playing. Press to overdub', next: 'overdub' };
    case 'overdub': return { tone: 'overdub', icon: 'plus', label: 'Dub', aria: 'Loop overdubbing. Press to stop overdubbing and keep playing', next: 'play' };
    case 'paused': return { tone: 'paused', icon: 'loop', label: 'Stopped', aria: 'Loop stopped. Press to play it', next: 'play' };
    default: return { tone: 'idle', icon: 'record', label: 'Loop', aria: playing ? 'Looper empty. Press to record from the next bar' : 'Looper empty. Press to record now, press again to close the loop', next: 'record' };
  }
}

/** 0..1 progress for the position ring (null hides it). */
export function looperProgress(st, nowMs = 0) {
  if (!st) return null;
  if (st.capture >= 0 && st.capturing) return st.capture;
  if (st.state === 'record') return st.recTarget ? Math.min(1, st.recPos / st.recTarget) : null;
  if ((st.state === 'play' || st.state === 'overdub') && st.len > 0 && !st.cue) {
    let pos = typeof st.fpos === 'number' && Number.isFinite(st.fpos) ? st.fpos : st.pos;
    const rate = st.scrub ? 0 : (typeof st.rate === 'number' && Number.isFinite(st.rate) ? st.rate : 1);
    if (st.posAt && nowMs > st.posAt) pos += ((nowMs - st.posAt) / 1000) * (st.sampleRate || 48000) * rate;
    const m = pos % st.len;
    return (m < 0 ? m + st.len : m) / st.len;
  }
  return null;
}

/**
 * @param {object} o
 * @param {object} o.store
 * @param {object|null} o.engine        needs engine.looper
 * @param {object|null} [o.music]       transport for the tempo (follows MIDI clock)
 * @param {(msg, opts) => void} [o.toast]
 * @param {() => boolean} [o.quietUndo] true to skip the "Nothing to undo" toast (the B of the Konami code)
 * @param {() => Promise} [o.startAudio]
 * @param {(blob, name) => void} [o.download]
 * @param {Storage} [o.storage]
 */
export function createLooperControl({ store, engine = null, music = null, toast = () => {}, quietUndo = () => false, startAudio = async () => true, download = () => {}, storage = globalThis.localStorage, resample = resampleToWavetable } = {}) {
  const events = createEmitter();
  const looper = engine && engine.looper ? engine.looper : null;
  const available = !!(looper && looper.available);
  const reason = available ? '' : (looper && looper.reason) || 'The looper needs the audio engine, which is not available here.';
  let prefs = loadLooperPrefs(storage);
  let st = looper ? { ...looper.status(), posAt: 0 } : { state: 'empty', len: 0 };
  let busy = '';            // '' | 'resample' | 'capture' | 'export' | 'stretch'
  const offs = [];
  // Follow tempo: the loop as recorded ({L, R, sampleRate, spb, bars, edit});
  // valid while the looper's `edit` still matches (nothing else changed it).
  let source = null;
  let fitting = false, fitAgain = false, fitTimer = 0, lastPosCheck = 0;

  const changed = () => events.emit('change', api.status());
  if (looper) {
    offs.push(looper.on('change', (s) => {
      st = { ...st, ...s, posAt: performance.now() };
      if (st.state === 'empty') source = null;
      changed();
      if (prefs.follow) scheduleFit();
    }));
    offs.push(looper.on('pos', (s) => {
      st = { ...st, ...s, posAt: performance.now() };
      events.emit('pos', st);
      // An external clock moves the tempo without a store change: look about once a second.
      if (prefs.follow && st.posAt - lastPosCheck > 1000) { lastPosCheck = st.posAt; if (needsFit()) scheduleFit(); }
    }));
    offs.push(looper.on('peaks', (p) => {
      if (!p || !p.peaks) return;
      st = { ...st, peaks: p.peaks, peaksLen: p.len, peaksEdit: p.edit };
      events.emit('peaks', st);
    }));
    offs.push(looper.on('error', (e) => { if (e && e.reason === 'memory') toast('The looper ran out of memory', { kind: 'error', detail: 'Try a shorter loop, or Clear to free the undo layers.' }); }));
    offs.push(looper.on('info', (e) => { if (e && e.reason === 'nothing-to-undo' && !quietUndo()) toast('Nothing to undo', { kind: 'info', timeout: 1600 }); }));
    // Settings travel to the worklet once at start.
    if (available) {
      looper.setBars(prefs.bars);
      looper.setVolume(prefs.volume);
      looper.setFeedback(prefs.feedback);
      if (typeof looper.setTape === 'function' && prefs.speed !== 1) {
        looper.setTape({ rate: Math.abs(prefs.speed), reverse: prefs.speed < 0 });
      }
    }
  }

  const tempo = () => {
    const t = music && music.transport && typeof music.transport.tempo === 'function' ? music.transport.tempo() : Number(store.get('global.tempo'));
    return Number.isFinite(t) && t > 0 ? t : 120;
  };
  const playing = () => !!store.get('ui.playing');

  function setBusy(v) { busy = v; changed(); }

  // ---------------------------------------------------------------- follow tempo
  const targetSpb = () => 60 / tempo();
  const barLoop = () => st.len > 0 && st.loopBars > 0 && st.loopSpb > 0;
  function needsFit() {
    return available && !!prefs.follow && barLoop() && (st.state === 'play' || st.state === 'paused')
      && Math.abs(st.loopSpb - targetSpb()) / st.loopSpb > FIT_TOLERANCE;
  }
  function scheduleFit() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => { if (needsFit()) fitToTempo(); }, FIT_DELAY_MS);
  }

  /**
   * Stretch the loop (pitch kept) to its bars at the current tempo. A loop
   * without bars is fitted to the nearest whole number of bars. Resolves to
   * {ok, bars, reason}.
   */
  async function fitToTempo({ manual = false } = {}) {
    if (!available) { if (manual) guard(); return { ok: false, reason: reason }; }
    if (fitting) { fitAgain = true; return { ok: false, reason: 'busy' }; }
    if (!(st.len > 0)) { if (manual) toast('The loop is empty', { kind: 'info', detail: 'Record a loop first.' }); return { ok: false, reason: 'empty' }; }
    if (st.state !== 'play' && st.state !== 'paused') {
      if (manual) toast('Finish recording or overdubbing first', { kind: 'info' });
      return { ok: false, reason: 'state' };
    }
    if (busy) return { ok: false, reason: 'busy' };
    fitting = true;
    setBusy('stretch');
    try {
      let src = source && source.edit === st.edit ? source : null;
      if (!src) {
        const loop = await looper.getLoop();
        if (!loop) return { ok: false, reason: 'empty' };
        src = { L: loop.L, R: loop.R, sampleRate: loop.sampleRate, spb: loop.loopSpb || 0, bars: loop.loopSpb > 0 ? loop.loopBars || 0 : 0, edit: loop.edit };
      }
      const spb = targetSpb();
      const sr = src.sampleRate || st.sampleRate || 48000;
      let bars = src.bars;
      if (!(bars > 0)) bars = Math.max(1, Math.round(src.L.length / sr / (4 * spb)));
      const length = loopFrames(bars, spb, sr);
      if (length > MAX_LOOP_SECONDS * sr) {
        if (manual) toast('The loop would be too long at this tempo', { kind: 'info', detail: `Loops can last up to ${MAX_LOOP_SECONDS} seconds.` });
        return { ok: false, reason: 'too-long' };
      }
      if (length === st.len && Math.abs(st.loopSpb - spb) / spb <= FIT_TOLERANCE) {
        source = { ...src, bars };
        return { ok: true, bars, unchanged: true };
      }
      // Let the busy state paint before the stretch takes the main thread.
      await new Promise(r => setTimeout(r, 0));
      const out = stretchToLength(src.L, src.R, length, { sampleRate: sr, loop: true });
      const res = await looper.replaceLoop({ L: out.L, R: out.R, base: src.edit, spb, bars });
      if (!res || !res.ok) {
        if (manual) toast('The loop changed while it was being stretched', { kind: 'info', detail: 'Try Fit to tempo again.' });
        return { ok: false, reason: 'changed' };
      }
      source = { ...src, bars, edit: res.edit };
      st = { ...st, edit: res.edit, loopSpb: spb, loopBars: bars };
      if (manual) toast(`Loop fitted to ${bars} bar${bars > 1 ? 's' : ''} at ${Math.round(tempo() * 10) / 10} BPM`, { kind: 'success', timeout: 2200 });
      return { ok: true, bars };
    } catch (err) {
      if (manual) toast('The loop could not be stretched', { kind: 'error', detail: String((err && err.message) || err) });
      return { ok: false, reason: String((err && err.message) || err) };
    } finally {
      fitting = false;
      setBusy('');
      if (fitAgain) { fitAgain = false; if (prefs.follow) scheduleFit(); }
    }
  }
  if (looper && available) offs.push(store.subscribe('global.tempo', () => { if (prefs.follow) scheduleFit(); }));
  offs.push(() => clearTimeout(fitTimer));

  function guard() {
    if (!available) { toast('The looper is not available', { kind: 'info', detail: reason }); return false; }
    return true;
  }

  async function run(fn) {
    if (!guard()) return;
    await startAudio();
    fn();
  }

  function setPref(key, value) {
    if (!VALID[key] || !VALID[key](value)) return;
    const next = sanitizeLooperPrefs({ ...prefs, [key]: value });
    if (next[key] === prefs[key]) return;
    prefs = next;
    saveLooperPrefs(prefs, storage);
    if (available) {
      if (key === 'bars') looper.setBars(prefs.bars);
      else if (key === 'volume') looper.setVolume(prefs.volume);
      else if (key === 'feedback') looper.setFeedback(prefs.feedback);
      else if (key === 'speed' && typeof looper.setTape === 'function') looper.setTape({ rate: Math.abs(prefs.speed), reverse: prefs.speed < 0 });
      else if (key === 'follow' && prefs.follow) scheduleFit();
    }
    events.emit('prefs', { ...prefs });
    changed();
  }

  async function resampleNow() {
    if (!guard() || busy) return { ok: false, reason: busy ? 'busy' : reason };
    await startAudio();
    const count = Math.max(1, (store.get('parts') || []).length);
    const part = Math.max(0, Math.min(count - 1, Math.round(Number(store.get('ui.selectedPart')) || 0)));
    const slot = prefs.slot;
    let audio = null;
    try {
      if (st.len > 0 && st.state !== 'record' && st.state !== 'armed') {
        setBusy('resample');
        audio = await looper.getLoop();
      }
      if (!audio) {
        setBusy('capture');
        toast(`Resample: recording ${prefs.bars} bar${prefs.bars > 1 ? 's' : ''} of the output${playing() ? ' from the next bar' : ''}`, { kind: 'info', timeout: 2600 });
        audio = await looper.capture({ bars: prefs.bars });
        if (!audio) { setBusy(''); toast('Resample was cancelled', { kind: 'info' }); return { ok: false, reason: 'cancelled' }; }
        setBusy('resample');
      }
      // Let the button paint before the analysis takes the main thread.
      await new Promise(r => setTimeout(r, 0));
      const name = nextResampleName(store.serialize());
      const res = resample(audio.L, audio.R, audio.sampleRate, { slice: prefs.slice, tempo: tempo(), rootNote: prefs.root, name });
      if (!res || !res.ok) {
        toast('Resample did not work', { kind: 'error', detail: (res && res.reason) || 'Unknown problem' });
        return { ok: false, reason: res && res.reason };
      }
      await addUserTerrain(store, part, slot, { ...res.userTerrain, name }, { source: 'resample' });
      toast(`${name} is on Part ${part + 1}, terrain ${slot}`, { kind: 'success', detail: res.detail });
      return { ok: true, name, part, slot, mode: res.mode, detail: res.detail };
    } catch (err) {
      toast('Resample did not work', { kind: 'error', detail: String((err && err.message) || err) });
      return { ok: false, reason: String((err && err.message) || err) };
    } finally {
      setBusy('');
    }
  }

  async function exportNow() {
    if (!guard() || busy) return null;
    if (!(st.len > 0)) { toast('The loop is empty', { kind: 'info', detail: 'Record a loop first, then export it.' }); return null; }
    setBusy('export');
    try {
      const blob = await looper.exportWav({ format: prefs.format });
      if (!blob) { toast('The loop is empty', { kind: 'info' }); return null; }
      const name = loopFileName(new Date());
      download(blob, name);
      toast('Loop saved', { kind: 'success', detail: `${name} (${prefs.format === 'float32' ? '32-bit float' : '24-bit'})` });
      return blob;
    } catch (err) {
      toast('The loop could not be exported', { kind: 'error', detail: String((err && err.message) || err) });
      return null;
    } finally {
      setBusy('');
    }
  }

  const api = {
    available,
    reason,
    status() { return { ...st, busy, available, prefs: { ...prefs } }; },
    prefs() { return { ...prefs }; },
    view() { return looperView(st, { available, playing: playing() }); },
    progress(nowMs = performance.now()) { return looperProgress(st, nowMs); },
    on(name, fn) { return events.on(name, fn); },
    setPref,
    main: () => run(() => looper.main()),
    stop: () => run(() => looper.stop()),
    undo: () => run(() => looper.undo()),
    clear: () => run(() => looper.clear()),
    /** Mute is a performance control: it is not remembered between sessions. */
    toggleMute() { if (guard()) looper.setMute(!st.muted); },
    /** Move the playhead. `pos` is 0..1 while the pointer is down, or null on release. */
    scrub(pos) {
      if (!available || !looper || typeof looper.setTape !== 'function') return;
      if (pos == null) looper.setTape({ scrub: null });
      else looper.setTape({ scrub: Math.max(0, Math.min(1, Number(pos) || 0)) });
    },
    resample: resampleNow,
    exportWav: exportNow,
    /** v2.8: stretch the loop to the current tempo now (pitch kept). */
    fitToTempo: () => fitToTempo({ manual: true }),
    /** MIDI-learned buttons ('looper.main' ...). */
    action(id) {
      switch (id) {
        case 'looper.main': return api.main();
        case 'looper.stop': return api.stop();
        case 'looper.undo': return api.undo();
        case 'looper.clear': return api.clear();
        case 'looper.mute': return api.toggleMute();
        case 'looper.resample': return api.resample();
        default: return undefined;
      }
    },
    dispose() { for (const off of offs) off(); },
  };
  return api;
}

export { noteName };
