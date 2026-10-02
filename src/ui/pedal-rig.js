// The pedal rig (v1.1, docs/PEDALS.md): ties the saved rig settings
// (src/pedals/rig-settings.js) to the engine's pedal host (output map, send
// limiter, return, feedback guard, ping) and to MIDI for the pedal profiles
// (src/pedals/pedal-midi.js over Web MIDI), plus the guitar on the return:
// Guitar plays notes (src/pedals/guitar-notes.js into the note router) and
// Capture (a held note -> a wavetable terrain on a part). Settings > Pedals and the mixer
// strips read and change it through this object; nothing here is needed for
// the synth to work, and every part copes with a missing engine, host or MIDI.
// It also drives the pedals' modulated controls (Macros, Guitar level, pedal
// LFOs) and sends the pedal presets stored with scenes and patches when they
// load (patches only with "Patches recall pedal presets" on).

import { createEmitter } from '../audio/emitter.js';
import { PEDAL_IDS, PEDAL_PROFILES, channelConflicts, withChannel } from '../pedals/profiles.js';
import { createPedalMidi, createLfoSource } from '../pedals/pedal-midi.js';
import { loadRig, saveRig, sanitizeRig, pairChannels, contextSampleRate } from '../pedals/rig-settings.js';
import { compensationMs, partLeadSeconds } from '../pedals/latency-comp.js';
import { createGuitarNotes } from '../pedals/guitar-notes.js';
import { captureToWavetable } from '../pedals/guitar.js';
import { addUserTerrain } from '../audio/importers.js';
import { CAPTURE_SECONDS } from '../audio/pedal-host.js';
import { partCount } from '../core/tracks.js';

const AUDIO_KEYS = ['enabled', 'outputDeviceId', 'mainPair', 'sendPair', 'ceilingDb'];
const RETURN_KEYS = ['returnEnabled', 'returnDeviceId', 'returnLayout', 'returnLevel', 'returnDelay', 'returnReverb'];
const COMP_KEYS = ['compensate', 'compOffsetMs', 'lastLatencyMs'];
const GUITAR_KEYS = ['guitarNotes', 'guitarMode', 'guitarTarget', 'guitarChannel', 'guitarGateDb', 'guitarBends'];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** MIDI note -> 'A2' (C4 = 60, as on the keyboard). */
export function noteLabel(m) {
  const n = Math.round(m);
  return Number.isFinite(n) ? `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}` : '?';
}

/**
 * @param {object} o
 * @param {object} o.store
 * @param {object|null} o.engine  needs engine.pedals for audio; setOutputDevice for the device picker
 * @param {object|null} o.midi    needs midi.sendRaw for pedal MIDI
 * @param {object|null} [o.router] the note router (src/music/router.js): its setLead takes the latency compensation, and receives Guitar plays notes
 * @param {object|null} [o.presets] preset library; its scene / patch 'load' events carry pedal presets
 * @param {object|null} [o.transport] for the tempo of synced LFOs (follows external clock); else global.tempo
 * @param {Storage} [o.storage]
 * @param {() => Promise<boolean>} [o.micGranted] whether the return may reopen without a prompt
 * @param {() => void} [o.reload] restarts the app (a sample-rate change applies on the next start)
 * @param {object} [o.clock] { now, setTimer, clearTimer } for the pedal MIDI scheduler (tests)
 */
export function createPedalRig({
  store, engine = null, midi = null, router = null, presets = null, transport = null,
  storage = globalThis.localStorage, micGranted = defaultMicGranted, reload = defaultReload, analyse = captureToWavetable, clock = {},
} = {}) {
  const events = createEmitter();
  const host = engine && engine.pedals ? engine.pedals : null;
  let prefs = loadRig(storage);
  // The rate main.js asked the engine for when it started (same storage).
  const bootRate = contextSampleRate(prefs);
  let lastError = null;
  let disposed = false;
  const offs = [];

  const changed = () => { if (!disposed) events.emit('change', status()); };
  if (host) offs.push(host.on('change', changed));

  // ---------------------------------------------------------------- MIDI
  const midiOk = () => !!(midi && typeof midi.sendRaw === 'function');
  const pmidi = createPedalMidi({
    pedals: [],
    send: (bytes, ts) => {
      if (!midiOk()) throw new Error('MIDI is not connected');
      if (!midi.sendRaw(bytes, ts, prefs.midiOutputId || null)) throw new Error('No MIDI output is selected, or it was unplugged');
    },
    ...(clock.now ? { now: clock.now } : {}),
    ...(clock.setTimer ? { setTimer: clock.setTimer } : {}),
    ...(clock.clearTimer ? { clearTimer: clock.clearTimer } : {}),
  });
  const nowMs = () => (clock.now ? clock.now() : (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  // An LFO can fail 100 times a second (output unplugged): report each new problem once.
  offs.push(pmidi.on((e) => { if (e.type === 'error' && e.message !== lastError) { lastError = e.message; changed(); } }));

  // Tempo for synced pedal LFOs: the transport's (it follows external clock), else the tempo knob.
  const tempo = () => {
    let b = NaN;
    if (transport && typeof transport.tempo === 'function') { try { b = Number(transport.tempo()); } catch { b = NaN; } }
    if (!(b > 0)) b = Number(store.get('global.tempo'));
    return b > 0 ? b : 120;
  };
  // One LFO per modulation slot that uses one, kept across edits so its phase carries on.
  const lfos = new Map();

  function pushMacros() {
    for (let i = 1; i <= 4; i++) {
      const v = Number(store.get(`global.macro${i}`));
      if (Number.isFinite(v)) pmidi.input(`macro${i}`, v);
    }
  }

  function applyMidi() {
    const present = new Set(pmidi.pedals().map(p => p.id));
    for (const id of PEDAL_IDS) {
      const want = prefs.pedals[id];
      if (want.enabled) {
        if (!present.has(id)) pmidi.addPedal({ profile: id, channel: want.channel });
        else if (pmidi.profile(id).channel !== want.channel) pmidi.setChannel(id, want.channel);
      } else if (present.has(id)) pmidi.removePedal(id);
    }
    pmidi.clearMappings();
    const wanted = new Set();
    for (const id of PEDAL_IDS) {
      const p = prefs.pedals[id];
      if (!p.enabled) continue;
      const used = new Set();
      p.mods.forEach((m, slot) => {
        // Two slots on one control would fight: the first one wins (the card says so).
        if (!m.source || !m.control || used.has(m.control)) return;
        used.add(m.control);
        let source = m.source;
        if (source === 'lfo') {
          source = lfoId(id, slot);
          wanted.add(source);
          const opts = { shape: m.lfoShape, rateHz: m.lfoRate, beats: m.lfoSync ? m.lfoBeats : 0, depth: m.lfoDepth };
          const have = lfos.get(source);
          if (have) Object.assign(have, opts);
          else {
            const lfo = createLfoSource(opts);
            lfos.set(source, lfo);
            pmidi.addLfo(source, lfo, { bpm: tempo });
          }
        }
        pmidi.map({ id: `${id}:${slot}`, source, pedal: id, control: m.control, min: m.min, max: m.max, curve: m.curve });
      });
    }
    for (const key of [...lfos.keys()]) if (!wanted.has(key)) { pmidi.removeLfo(key); lfos.delete(key); }
    // The LFO clock runs only while some pedal control follows an LFO.
    if (lfos.size && midiOk()) pmidi.start(); else pmidi.stop();
    // Push the current macro values through the new mappings.
    pushMacros();
  }
  const lastMacro = {};
  offs.push(store.subscribe('global', () => {
    for (let i = 1; i <= 4; i++) {
      const v = Number(store.get(`global.macro${i}`));
      if (Number.isFinite(v) && v !== lastMacro[i]) { lastMacro[i] = v; pmidi.input(`macro${i}`, v); }
    }
  }));
  if (host) offs.push(host.on('guitar', (e) => pmidi.input('guitar', e.level)));

  // ---------------------------------------------------------------- guitar
  const notes = createGuitarNotes({ store, router, engine });
  let lastPitch = null;      // Single pitch, or { mode: 'chords', notes, heard }, for the display
  let capture = null;        // { stage, progress, ... } of the running or last Capture
  if (host) {
    offs.push(host.on('guitarNote', (e) => {
      if (e && e.type === 'pitch') {
        lastPitch = e.mode === 'chords'
          ? { mode: 'chords', notes: [...(e.notes || [])], heard: [...(e.heard || [])], voiced: !!e.voiced, time: e.time }
          : e.voiced ? { freq: e.freq, midi: e.midi, clarity: e.clarity } : null;
        events.emit('pitch', lastPitch);
        return;
      }
      notes.handle(e);
    }));
  }
  offs.push(notes.on((e) => events.emit('guitarNote', e)));
  let trackerSent = '';
  function applyGuitar() {
    notes.configure({ enabled: !!prefs.guitarNotes, guitarMode: prefs.guitarMode, target: prefs.guitarTarget, gateDb: prefs.guitarGateDb, bends: !!prefs.guitarBends });
    if (!host || typeof host.setGuitar !== 'function') return Promise.resolve(null);
    const tc = notes.trackerConfig();
    trackerSent = JSON.stringify([prefs.guitarChannel, prefs.guitarNotes, prefs.guitarMode, tc]);
    return host.setGuitar({ channel: prefs.guitarChannel - 1, notes: !!prefs.guitarNotes, guitarMode: prefs.guitarMode, gateDb: tc.gateDb, bendRange: tc.bendRange });
  }
  // The tracker's bend range follows the played part's Bend (and which part that is).
  offs.push(store.subscribe('', (path) => {
    if (!prefs.guitarNotes) return;
    if (path !== '' && !/bendRange|selectedPart|keyMode|^parts$|^parts\.\d+$|^ui$/.test(path)) return;
    const tc = notes.trackerConfig();
    if (JSON.stringify([prefs.guitarChannel, prefs.guitarNotes, prefs.guitarMode, tc]) !== trackerSent) applyGuitar();
  }));

  // ---------------------------------------------------------------- pedal presets
  const recent = new Map(); // `${id}:${program}` -> ms, so a patch loaded into several parts sends once
  /**
   * Send stored pedal presets ({ pedalId: program }) as Program Change on each
   * switched-on pedal's channel. Pedals that are off, or have no such preset,
   * are skipped. Controls that follow a Macro are sent again after the change,
   * so the mapping stays in charge of them. Returns one result per pedal.
   */
  function recallPresets(map, { from = 'scene' } = {}) {
    const out = [];
    if (!map || typeof map !== 'object') return out;
    const t = nowMs();
    for (const [id, program] of Object.entries(map)) {
      const want = prefs.pedals[id];
      if (!want) { out.push({ pedal: id, program, ok: false, reason: 'Unknown pedal.' }); continue; }
      if (!want.enabled) { out.push({ pedal: id, program, ok: false, skipped: true, reason: 'This pedal is switched off in Settings > Pedals.' }); continue; }
      if (!midiOk()) { out.push({ pedal: id, program, ok: false, reason: 'MIDI is not available here.' }); continue; }
      const key = `${id}:${program}`;
      if (recent.has(key) && t - recent.get(key) < 50) { out.push({ pedal: id, program, ok: true, repeat: true }); continue; }
      recent.set(key, t);
      out.push({ pedal: id, program, ...pmidi.programChange(id, program, { time: t }) });
    }
    if (out.some(r => r.ok && !r.repeat)) pushMacros();
    events.emit('recall', { from, results: out });
    return out;
  }
  if (presets && typeof presets.on === 'function') {
    const onPreset = (e) => {
      if (!e || e.action !== 'load' || !e.pedalPresets) return;
      if (e.kind === 'scene') recallPresets(e.pedalPresets, { from: 'scene' });
      else if (e.kind === 'patch' && prefs.patchesRecallPedals) recallPresets(e.pedalPresets, { from: 'patch' });
    };
    const off = presets.on('change', onPreset);
    offs.push(typeof off === 'function' ? off : () => { if (typeof presets.off === 'function') presets.off('change', onPreset); });
  }

  /** The preset each pedal was last sent from here (null when unknown), to fill in a scene or patch. */
  function lastPrograms() {
    const st = pmidi.getState();
    const out = {};
    for (const id of PEDAL_IDS) if (st[id] && st[id].program != null) out[id] = st[id].program;
    return out;
  }

  // ---------------------------------------------------------------- audio
  async function applyOutputDevice() {
    if (!engine || typeof engine.setOutputDevice !== 'function') return;
    const want = prefs.outputDeviceId || 'default';
    if ((engine.outputDeviceId || 'default') === want) return;
    try { await engine.setOutputDevice(want); } catch (err) { lastError = `The output device could not be used: ${(err && err.message) || err}`; }
  }

  async function applyAudio() {
    if (!host) return;
    if (prefs.enabled) await applyOutputDevice();
    host.configure({
      enabled: !!prefs.enabled,
      mainChannels: pairChannels(prefs.mainPair),
      sendChannels: pairChannels(prefs.sendPair),
      ceilingDb: prefs.ceilingDb,
    });
  }

  function applyReturn() {
    if (!host) return Promise.resolve(null);
    return host.setReturn({
      enabled: !!prefs.returnEnabled, deviceId: prefs.returnDeviceId, layout: prefs.returnLayout,
      level: prefs.returnLevel, delay: prefs.returnDelay, reverb: prefs.returnReverb,
    });
  }

  // ------------------------------------------------------- latency compensation
  // Sequenced notes of parts through the pedals go out early (router), and the
  // dry sound of Send mode parts waits for the return (engine / DSP). Both only
  // act while the pedal send really runs; see src/pedals/latency-comp.js.
  const sendActive = () => !!(host && host.active);
  const leadFn = (p) => partLeadSeconds(store.get(`parts.${p}.params`), compensationMs(prefs), sendActive());
  function applyCompensation() {
    const ms = compensationMs(prefs);
    if (engine && typeof engine.setPedalCompensation === 'function') {
      try { engine.setPedalCompensation(ms); } catch (err) { lastError = `Latency compensation could not be applied: ${(err && err.message) || err}`; }
    }
    if (router && typeof router.setLead === 'function') router.setLead(ms > 0 ? leadFn : null);
  }

  /** Change rig settings (any subset). Saves, then applies what changed. */
  async function set(patch = {}) {
    const before = prefs;
    prefs = sanitizeRig({ ...prefs, ...patch, pedals: { ...prefs.pedals, ...(patch.pedals || {}) } });
    saveRig(prefs, storage);
    lastError = null;
    const diff = (keys) => keys.some(k => before[k] !== prefs[k]);
    if (JSON.stringify(before.pedals) !== JSON.stringify(prefs.pedals)) applyMidi();
    if (diff(COMP_KEYS)) applyCompensation();
    changed();
    if (diff(AUDIO_KEYS)) await applyAudio();
    if (diff(RETURN_KEYS)) await applyReturn();
    if (diff(GUITAR_KEYS)) await applyGuitar();
    changed();
    return status();
  }

  function setPedal(id, patch = {}) {
    if (!PEDAL_PROFILES[id]) return Promise.resolve(status());
    return set({ pedals: { [id]: { ...prefs.pedals[id], ...patch } } });
  }

  /** Change one modulation slot of a pedal (source, control, min, max, curve, lfo*). */
  function setPedalMod(id, slot, patch = {}) {
    if (!PEDAL_PROFILES[id] || !prefs.pedals[id].mods[slot]) return Promise.resolve(status());
    const mods = prefs.pedals[id].mods.map((m, i) => (i === slot ? { ...m, ...patch } : m));
    return setPedal(id, { mods });
  }

  /** Reopen the return with the saved settings (after a refused permission or an unplugged input). */
  async function reconnectReturn() {
    if (!host) return null;
    await host.setReturn({ enabled: false });
    return applyReturn();
  }

  async function ping() {
    if (!host) return { ok: false, reason: 'The pedal loop needs Web Audio, which is not running here.' };
    const res = await host.ping();
    if (res && res.ok) {
      prefs = sanitizeRig({ ...prefs, lastLatencyMs: Math.round(res.latencyMs * 10) / 10 });
      saveRig(prefs, storage);
      applyCompensation();
    }
    changed();
    return res;
  }

  /** Send something to a pedal: 'on' | 'bypass' | 'tap' | 'program' (arg = preset number). */
  function pedalAction(id, action, arg) {
    if (!prefs.pedals[id] || !prefs.pedals[id].enabled) return { ok: false, reason: 'Turn this pedal on first.' };
    if (!midiOk()) return { ok: false, reason: 'MIDI is not available here.' };
    let r;
    if (action === 'on') r = pmidi.engage(id, true);
    else if (action === 'bypass') r = pmidi.bypass(id, true);
    else if (action === 'tap') {
      const bpm = Number(store.get('global.tempo')) || 120;
      r = pmidi.tapTempo(id, bpm, { taps: 4 });
    } else if (action === 'program') r = pmidi.programChange(id, Number(arg));
    else r = { ok: false, reason: 'Unknown pedal action.' };
    changed();
    return r;
  }

  /** The track Capture writes to: the guitar's track (when it exists), or the selected track. */
  function capturePart() {
    const t = prefs.guitarTarget;
    const n = partCount(store);
    if (t === 'sel' || !(t < n)) return Math.max(0, Math.min(n - 1, Math.round(Number(store.get('ui.selectedPart')) || 0)));
    return t;
  }

  function setCapture(c) { capture = c; events.emit('capture', { ...c }); changed(); }

  /**
   * Capture: record a held note from the guitar channel, turn it into a
   * wavetable terrain (attack to decay along one axis), store it in the
   * part's terrain slot (prefs.captureSlot) the way the importer does and
   * select it. Progress, the detected pitch and failures come out as 'capture'
   * events {stage: 'recording'|'analysing'|'done'|'error', progress, ...}.
   */
  async function captureNote({ seconds = CAPTURE_SECONDS } = {}) {
    const fail = (reason) => { setCapture({ stage: 'error', progress: 0, reason }); return { ok: false, reason }; };
    if (!host || typeof host.captureGuitar !== 'function') return fail('Capture needs Web Audio, which is not running here.');
    if (capture && (capture.stage === 'recording' || capture.stage === 'analysing')) return { ok: false, reason: 'A capture is already running.' };
    const part = capturePart();
    const slot = prefs.captureSlot;
    setCapture({ stage: 'recording', progress: 0, part, slot });
    // The held note is for the wavetable, not the synth: pause Guitar plays notes while recording.
    const muteNotes = !!prefs.guitarNotes;
    if (muteNotes) notes.configure({ enabled: false, guitarMode: prefs.guitarMode, target: prefs.guitarTarget, gateDb: prefs.guitarGateDb, bends: !!prefs.guitarBends });
    let rec;
    try {
      rec = await host.captureGuitar({ seconds, onProgress: (p) => setCapture({ stage: 'recording', progress: p, part, slot }) });
    } finally {
      if (muteNotes) notes.configure({ enabled: !!prefs.guitarNotes, guitarMode: prefs.guitarMode, target: prefs.guitarTarget, gateDb: prefs.guitarGateDb, bends: !!prefs.guitarBends });
    }
    if (!rec || !rec.ok) return fail((rec && rec.reason) || 'Nothing was recorded.');
    setCapture({ stage: 'analysing', progress: 1, part, slot });
    // Let the progress paint before the analysis takes the main thread.
    await new Promise(r => setTimeout(r, 0));
    let res;
    try { res = analyse(rec.samples, rec.sampleRate, { name: 'Guitar capture' }); } catch (err) { res = { ok: false, reason: `The analysis failed (${(err && err.message) || err}).` }; }
    if (!res || !res.ok) return fail((res && res.reason) || 'Orograph could not find a steady pitch.');
    const name = `Guitar ${noteLabel(res.note)}`;
    try {
      await addUserTerrain(store, part, slot, { ...res.userTerrain, name });
    } catch (err) {
      return fail(`The terrain could not be stored (${(err && err.message) || err}).`);
    }
    const done = { stage: 'done', progress: 1, part, slot, name, freq: res.freq, note: res.note, frames: res.userTerrain.h, clarity: res.clarity };
    setCapture(done);
    return { ok: true, ...done };
  }

  function conflicts() {
    const list = PEDAL_IDS.filter(id => prefs.pedals[id].enabled).map(id => withChannel(PEDAL_PROFILES[id], prefs.pedals[id].channel));
    return channelConflicts(list);
  }

  /** What the latency compensation does right now. */
  function compensation() {
    const ms = compensationMs(prefs);
    return {
      on: !!prefs.compensate,
      ms,
      measuredMs: prefs.lastLatencyMs,
      offsetMs: prefs.compOffsetMs,
      // Nothing moves while the send is off (no part goes through the pedals).
      applied: ms > 0 && sendActive(),
    };
  }

  /** The sample rate asked for, the one running, and whether a restart is needed. */
  function sampleRate() {
    const want = contextSampleRate(prefs);
    const running = engine && Number.isFinite(engine.sampleRate) ? engine.sampleRate : 0;
    return {
      choice: prefs.sampleRate,
      want: want || null,
      running,
      pending: want !== bootRate,
      // Asked for at start-up but the browser gave something else.
      refused: !!(bootRate && want === bootRate && running && running !== bootRate),
    };
  }

  function status() {
    return {
      prefs: sanitizeRig(prefs),
      compensation: compensation(),
      sampleRate: sampleRate(),
      audio: host ? host.status() : null,
      midi: { available: midiOk(), status: midi ? midi.status : 'unsupported', stats: pmidi.stats(), lastError: pmidi.lastError },
      conflicts: conflicts(),
      guitar: { notes: notes.stats(), pitch: lastPitch, capture: capture ? { ...capture } : null, bendRange: notes.bendRange() },
      lastError,
    };
  }

  /** At start-up: bring the saved rig back. The return only reopens without a prompt. */
  async function restore() {
    applyMidi();
    applyCompensation();
    if (!host) return status();
    if (prefs.enabled) await applyAudio();
    await applyGuitar();
    if (prefs.returnEnabled) {
      let ok = false;
      try { ok = await micGranted(); } catch { ok = false; }
      if (ok) await applyReturn();
    }
    changed();
    return status();
  }

  function dispose() {
    disposed = true;
    if (router && typeof router.setLead === 'function') router.setLead(null);
    for (const off of offs) { try { off(); } catch { /* ignore */ } }
    pmidi.dispose();
    notes.dispose();
    events.clear();
  }

  // Read-only view of the settings, rebuilt only when they change (the Settings
  // pane reads it once per control on every change).
  let view = null, viewOf = null;
  function prefsView() {
    if (viewOf !== prefs) { view = deepFreeze(sanitizeRig(prefs)); viewOf = prefs; }
    return view;
  }

  return {
    get prefs() { return prefsView(); },
    get host() { return host; },
    get pedalMidi() { return pmidi; },
    get supported() { return !!host; },
    get guitarNotes() { return notes; },
    set, setPedal, setPedalMod, reconnectReturn, ping, pedalAction, captureNote, conflicts, status, restore, dispose,
    compensation, sampleRate, recallPresets, lastPrograms,
    /** Restart the app so a new sample rate takes effect (the session autosaves on the way out). */
    reload: () => reload(),
    listInputs: () => (host ? host.listInputs() : Promise.resolve([])),
    listOutputs: () => (engine && typeof engine.listOutputDevices === 'function' ? engine.listOutputDevices() : Promise.resolve([])),
    on: (name, fn) => events.on(name, fn),
  };
}

function defaultReload() {
  if (typeof location !== 'undefined' && typeof location.reload === 'function') location.reload();
}

const lfoId = (pedal, slot) => `lfo:${pedal}:${slot}`;

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

async function defaultMicGranted() {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  if (!nav || !nav.permissions || typeof nav.permissions.query !== 'function') return false;
  const p = await nav.permissions.query({ name: 'microphone' });
  return !!p && p.state === 'granted';
}
