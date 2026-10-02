// Voice input (v1.4): ties the saved voice settings (src/audio/voice-core.js)
// to the engine's voice host (src/audio/voice-host.js), resolves Monitor: Auto
// from the input and output device names, runs Voice plays notes (the guitar
// notes driver with source 'voice' into the note router) and Capture (a sung
// note -> a wavetable terrain, through the guitar's captureToWavetable).
// Settings > Voice reads and changes it through this object. Nothing here is
// needed for the synth to work: without an engine or a microphone it reports why.

import { createEmitter } from '../audio/emitter.js';
import {
  loadVoicePrefs, saveVoicePrefs, sanitizeVoicePrefs, resolveMonitor, VOICE_SOURCE, MIC_WHY,
} from '../audio/voice-core.js';
import { VOICE_CAPTURE_SECONDS } from '../audio/voice-host.js';
import { createGuitarNotes } from '../pedals/guitar-notes.js';
import { captureToWavetable } from '../pedals/guitar.js';
import { addUserTerrain } from '../audio/importers.js';
import { MAX_PARTS } from '../core/params.js';
import { partCount } from '../core/tracks.js';
import { noteLabel } from './pedal-rig.js';

const OPEN_KEYS = ['enabled', 'deviceId', 'cleanup', 'channels'];
const NOTE_KEYS = ['notes', 'target', 'gateDb', 'bends'];

/** Voice capture analysis: a sung note is less steady than a string, so a wider pitch window. */
export function analyseVoice(samples, sampleRate) {
  return captureToWavetable(samples, sampleRate, { name: 'Voice capture', minFreq: 70, maxFreq: 1100 });
}

/**
 * @param {object} o
 * @param {object} o.store
 * @param {object|null} o.engine   needs engine.voice; listOutputDevices / outputDeviceId for Monitor: Auto
 * @param {object|null} [o.router] the note router: receives Voice plays notes
 * @param {Storage} [o.storage]
 * @param {() => Promise<string>} [o.micPermission] 'granted' | 'denied' | 'prompt' | 'unknown'
 * @param {object} [o.mediaDevices] for 'devicechange' (tests pass a stub)
 */
export function createVoiceRig({
  store, engine = null, router = null, storage = globalThis.localStorage,
  micPermission = defaultMicPermission, analyse = analyseVoice,
  mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : null,
} = {}) {
  const events = createEmitter();
  const host = engine && engine.voice ? engine.voice : null;
  const numParts = MAX_PARTS;
  let prefs = loadVoicePrefs(storage, { numParts });
  let devices = { inputLabel: '', outputLabel: '' };
  let monitor = resolveMonitor(prefs.monitor, devices);
  let permission = 'unknown';
  let capture = null;
  let lastPitch = null;
  let disposed = false;
  const offs = [];

  const changed = () => { if (!disposed) events.emit('change', status()); };
  if (host) offs.push(host.on('change', changed));

  // ---------------------------------------------------------------- notes
  const notes = createGuitarNotes({ store, router, engine, numParts, source: VOICE_SOURCE });
  if (host) {
    offs.push(host.on('voiceNote', (e) => {
      if (e && e.type === 'pitch') { lastPitch = e.voiced ? { freq: e.freq, midi: e.midi, clarity: e.clarity } : null; events.emit('pitch', lastPitch); return; }
      notes.handle(e);
    }));
    offs.push(host.on('level', (e) => events.emit('level', e)));
  }
  offs.push(notes.on((e) => events.emit('voiceNote', e)));
  const notesCfg = () => ({ enabled: !!prefs.notes, target: prefs.target, gateDb: prefs.gateDb, bends: !!prefs.bends });
  let trackerSent = '';
  function applyNotes() {
    notes.configure(notesCfg());
    if (!host) return Promise.resolve(null);
    const tc = notes.trackerConfig();
    trackerSent = JSON.stringify(tc);
    return host.set({ gateDb: tc.gateDb, bendRange: tc.bendRange });
  }
  // The tracker's bend range follows the played part's Bend (and which part that is).
  offs.push(store.subscribe('', (path) => {
    if (!prefs.notes) return;
    if (path !== '' && !/bendRange|selectedPart|keyMode|^parts$|^parts\.\d+$|^ui$/.test(path)) return;
    if (JSON.stringify(notes.trackerConfig()) !== trackerSent) applyNotes();
  }));

  // ---------------------------------------------------------------- devices / monitor
  async function refreshDevices() {
    let inputs = [], outputs = [];
    try { inputs = host ? (await host.listInputs()) || [] : []; } catch { inputs = []; }
    try { outputs = engine && typeof engine.listOutputDevices === 'function' ? (await engine.listOutputDevices()) || [] : []; } catch { outputs = []; }
    const st = host ? host.status() : null;
    const wantIn = prefs.deviceId || 'default';
    const inDev = inputs.find(d => d.deviceId === wantIn) || inputs.find(d => d.deviceId === 'default') || (wantIn === 'default' ? inputs[0] : null);
    const outId = (engine && engine.outputDeviceId) || 'default';
    const outDev = outputs.find(d => d.deviceId === outId) || outputs.find(d => d.deviceId === 'default');
    devices = {
      // The open track's own name is the most reliable.
      inputLabel: (st && st.open && st.label) || (inDev && inDev.label) || '',
      outputLabel: (outDev && outDev.label) || '',
    };
    return { inputs, outputs };
  }

  function applyMonitor() {
    monitor = resolveMonitor(prefs.monitor, devices);
    if (host) return host.set({ monitor: monitor.on });
    return Promise.resolve(null);
  }

  async function reevaluate() {
    await refreshDevices();
    await applyMonitor();
    changed();
  }
  const onDeviceChange = () => { if (!disposed) reevaluate().catch(() => {}); };
  if (mediaDevices && typeof mediaDevices.addEventListener === 'function') {
    mediaDevices.addEventListener('devicechange', onDeviceChange);
    offs.push(() => mediaDevices.removeEventListener('devicechange', onDeviceChange));
  }
  if (engine && typeof engine.on === 'function') {
    // A new output device (headphones plugged in, Settings > Audio) can change Monitor: Auto.
    offs.push(engine.on('state', (e) => { if (e && e.sinkId !== undefined) onDeviceChange(); }));
  }

  // ---------------------------------------------------------------- apply
  function mixPatch() {
    return {
      inputGainDb: prefs.inputGainDb, highpass: !!prefs.highpass, compressor: !!prefs.compressor, deesser: !!prefs.deesser,
      level: prefs.level, pan: prefs.pan, delay: prefs.delay, reverb: prefs.reverb,
    };
  }

  async function applyOpen() {
    if (!host) return null;
    // Monitor is decided before the microphone opens, so a laptop never
    // plays the voice out of its speakers even for a moment.
    if (prefs.enabled) { await refreshDevices(); monitor = resolveMonitor(prefs.monitor, devices); }
    await host.set({ ...mixPatch(), monitor: monitor.on, enabled: !!prefs.enabled, deviceId: prefs.deviceId, cleanup: !!prefs.cleanup, channels: prefs.channels });
    if (prefs.enabled) {
      // Device names appear once the browser may use the microphone: decide again with them.
      await reevaluate();
      const st = host.status();
      if (st.open) permission = 'granted';
      else if (st.error === 'NotAllowedError' || st.error === 'SecurityError') permission = 'denied';
    }
    return host.status();
  }

  /** Change voice settings (any subset). Saves, then applies what changed. */
  async function set(patch = {}) {
    const before = prefs;
    prefs = sanitizeVoicePrefs({ ...prefs, ...patch }, { numParts });
    saveVoicePrefs(prefs, storage, { numParts });
    const diff = (keys) => keys.some(k => before[k] !== prefs[k]);
    changed();
    if (!host) return status();
    if (diff(OPEN_KEYS)) await applyOpen();
    else {
      await host.set(mixPatch());
      if (before.monitor !== prefs.monitor) await applyMonitor();
    }
    if (diff(NOTE_KEYS)) await applyNotes();
    changed();
    return status();
  }

  /** Reopen the microphone with the saved settings (after a refused permission or an unplugged input). */
  async function reconnect() {
    if (!host) return null;
    await host.set({ enabled: false });
    if (!prefs.enabled) prefs = sanitizeVoicePrefs({ ...prefs, enabled: 1 }, { numParts });
    saveVoicePrefs(prefs, storage, { numParts });
    await applyOpen();
    changed();
    return status();
  }

  // ---------------------------------------------------------------- capture
  function capturePart() {
    const t = prefs.target;
    const n = partCount(store);
    if (t === 'sel' || !(t < n)) return Math.max(0, Math.min(n - 1, Math.round(Number(store.get('ui.selectedPart')) || 0)));
    return t;
  }
  function setCapture(c) { capture = c; events.emit('capture', { ...c }); changed(); }

  /**
   * Capture: record a sung or hummed note, turn it into a wavetable terrain
   * and store it in the track's terrain slot the way the importer does.
   */
  async function captureNote({ seconds = VOICE_CAPTURE_SECONDS } = {}) {
    const fail = (reason) => { setCapture({ stage: 'error', progress: 0, reason }); return { ok: false, reason }; };
    if (!host) return fail('Capture needs Web Audio, which is not running here.');
    if (capture && (capture.stage === 'recording' || capture.stage === 'analysing')) return { ok: false, reason: 'A capture is already running.' };
    const part = capturePart();
    const slot = prefs.captureSlot;
    setCapture({ stage: 'recording', progress: 0, part, slot });
    // The held note is for the wavetable, not the synth: pause Voice plays notes while recording.
    const muteNotes = !!prefs.notes;
    if (muteNotes) notes.configure({ ...notesCfg(), enabled: false });
    let rec;
    try {
      rec = await host.capture({ seconds, onProgress: (p) => setCapture({ stage: 'recording', progress: p, part, slot }) });
    } finally {
      if (muteNotes) notes.configure(notesCfg());
    }
    if (!rec || !rec.ok) return fail((rec && rec.reason) || 'Nothing was recorded.');
    setCapture({ stage: 'analysing', progress: 1, part, slot });
    await new Promise(r => setTimeout(r, 0));
    let res;
    try { res = analyse(rec.samples, rec.sampleRate); } catch (err) { res = { ok: false, reason: `The analysis failed (${(err && err.message) || err}).` }; }
    if (!res || !res.ok) {
      const reason = (res && res.reason) || 'Orograph could not find a steady pitch.';
      return fail(reason.replace('Hold one clear note (no chords)', 'Sing or hum one steady note (no vibrato)').replace('play a little louder', 'sing a little louder'));
    }
    const name = `Voice ${noteLabel(res.note)}`;
    try {
      await addUserTerrain(store, part, slot, { ...res.userTerrain, name }, { source: 'voice' });
    } catch (err) {
      return fail(`The terrain could not be stored (${(err && err.message) || err}).`);
    }
    const done = { stage: 'done', progress: 1, part, slot, name, freq: res.freq, note: res.note, frames: res.userTerrain.h, clarity: res.clarity };
    setCapture(done);
    return { ok: true, ...done };
  }

  // ---------------------------------------------------------------- info
  function status() {
    return {
      prefs: { ...prefs },
      supported: !!host,
      audio: host ? host.status() : null,
      monitor: { ...monitor },
      devices: { ...devices },
      permission,
      notes: notes.stats(),
      pitch: lastPitch,
      capture: capture ? { ...capture } : null,
      bendRange: notes.bendRange(),
    };
  }

  /** At start-up: bring the saved settings back. The microphone only reopens without a prompt. */
  async function restore() {
    try { permission = await micPermission(); } catch { permission = 'unknown'; }
    if (!host) { changed(); return status(); }
    await host.set(mixPatch());
    await applyNotes();
    if (prefs.enabled && permission === 'granted') await applyOpen();
    else { await refreshDevices(); await applyMonitor(); }
    changed();
    return status();
  }

  function dispose() {
    disposed = true;
    for (const off of offs) { try { off(); } catch { /* ignore */ } }
    notes.dispose();
    events.clear();
  }

  return {
    get prefs() { return { ...prefs }; },
    get host() { return host; },
    get supported() { return !!host; },
    get notes() { return notes; },
    why: MIC_WHY,
    set, reconnect, captureNote, status, restore, dispose,
    refresh: reevaluate,
    meter: () => (host ? host.meter() : { open: false, pos: 0, clip: false, clipKind: null }),
    resetGuard: () => { if (host) host.resetGuard(); },
    listInputs: () => (host ? host.listInputs() : Promise.resolve([])),
    on: (name, fn) => events.on(name, fn),
  };
}

async function defaultMicPermission() {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  if (!nav || !nav.permissions || typeof nav.permissions.query !== 'function') return 'unknown';
  try {
    const p = await nav.permissions.query({ name: 'microphone' });
    return p && p.state ? p.state : 'unknown';
  } catch { return 'unknown'; }
}
