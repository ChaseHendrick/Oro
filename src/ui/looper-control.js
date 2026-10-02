// Looper control (v1.2): the one object the top-bar loop button, the Loop
// dock tab, the keyboard shortcuts and MIDI-learned buttons all drive. It
// wraps engine.looper (src/audio/looper.js), keeps the looper settings for
// this device (localStorage 'orograph.looper', not part of a song), and runs
// Resample and Export WAV.
//
// Resample: the current loop, or (when the looper is empty) a few bars
// captured from the master output, becomes a wavetable user terrain in the
// selected part's slot A or B (src/audio/resample.js), named "Resample N".

import { createEmitter } from '../audio/emitter.js';
import { resampleToWavetable, nextResampleName, noteName, SLICE_MODES } from '../audio/resample.js';
import { addUserTerrain } from '../audio/importers.js';
import { LOOP_BARS, DEFAULT_BARS } from '../audio/looper-core.js';
import { recordingName } from './record.js';

export const LOOPER_PREFS_KEY = 'orograph.looper';
export const EXPORT_FORMATS = Object.freeze(['pcm24', 'float32']);
export const LOOPER_PREF_DEFAULTS = Object.freeze({
  bars: DEFAULT_BARS, volume: 1, feedback: 1, slot: 'A', slice: 'auto', root: 48, format: 'pcm24',
});

const unit = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const VALID = {
  bars: v => LOOP_BARS.includes(v),
  volume: unit,
  feedback: unit,
  slot: v => v === 'A' || v === 'B',
  slice: v => SLICE_MODES.includes(v),
  root: v => Number.isInteger(v) && v >= 24 && v <= 84,
  format: v => EXPORT_FORMATS.includes(v),
};

export function sanitizeLooperPrefs(src) {
  const out = { ...LOOPER_PREF_DEFAULTS };
  if (!src || typeof src !== 'object') return out;
  for (const k of Object.keys(out)) if (VALID[k](src[k])) out[k] = src[k];
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
  return recordingName(date).replace('orograph-', 'orograph-loop-');
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
    let pos = st.pos;
    if (st.posAt && nowMs > st.posAt) pos += ((nowMs - st.posAt) / 1000) * (st.sampleRate || 48000);
    return (pos % st.len) / st.len;
  }
  return null;
}

/**
 * @param {object} o
 * @param {object} o.store
 * @param {object|null} o.engine        needs engine.looper
 * @param {object|null} [o.music]       transport for the tempo (follows MIDI clock)
 * @param {(msg, opts) => void} [o.toast]
 * @param {() => Promise} [o.startAudio]
 * @param {(blob, name) => void} [o.download]
 * @param {Storage} [o.storage]
 */
export function createLooperControl({ store, engine = null, music = null, toast = () => {}, startAudio = async () => true, download = () => {}, storage = globalThis.localStorage, resample = resampleToWavetable } = {}) {
  const events = createEmitter();
  const looper = engine && engine.looper ? engine.looper : null;
  const available = !!(looper && looper.available);
  const reason = available ? '' : (looper && looper.reason) || 'The looper needs the audio engine, which is not available here.';
  let prefs = loadLooperPrefs(storage);
  let st = looper ? { ...looper.status(), posAt: 0 } : { state: 'empty', len: 0 };
  let busy = '';            // '' | 'resample' | 'capture' | 'export'
  const offs = [];

  const changed = () => events.emit('change', api.status());
  if (looper) {
    offs.push(looper.on('change', (s) => { st = { ...st, ...s, posAt: performance.now() }; changed(); }));
    offs.push(looper.on('pos', (s) => { st = { ...st, ...s, posAt: performance.now() }; events.emit('pos', st); }));
    offs.push(looper.on('error', (e) => { if (e && e.reason === 'memory') toast('The looper ran out of memory', { kind: 'error', detail: 'Try a shorter loop, or Clear to free the undo layers.' }); }));
    offs.push(looper.on('info', (e) => { if (e && e.reason === 'nothing-to-undo') toast('Nothing to undo', { kind: 'info', timeout: 1600 }); }));
    // Settings travel to the worklet once at start.
    if (available) {
      looper.setBars(prefs.bars);
      looper.setVolume(prefs.volume);
      looper.setFeedback(prefs.feedback);
    }
  }

  const tempo = () => {
    const t = music && music.transport && typeof music.transport.tempo === 'function' ? music.transport.tempo() : Number(store.get('global.tempo'));
    return Number.isFinite(t) && t > 0 ? t : 120;
  };
  const playing = () => !!store.get('ui.playing');

  function setBusy(v) { busy = v; changed(); }

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
    resample: resampleNow,
    exportWav: exportNow,
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
