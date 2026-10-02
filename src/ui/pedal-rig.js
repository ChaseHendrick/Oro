// The pedal rig (v1.1, docs/PEDALS.md): ties the saved rig settings
// (src/pedals/rig-settings.js) to the engine's pedal host (output map, send
// limiter, return, feedback guard, ping) and to MIDI for the pedal profiles
// (src/pedals/pedal-midi.js over Web MIDI). Settings > Pedals and the mixer
// strips read and change it through this object; nothing here is needed for
// the synth to work, and every part copes with a missing engine, host or MIDI.

import { createEmitter } from '../audio/emitter.js';
import { PEDAL_IDS, PEDAL_PROFILES, channelConflicts, withChannel } from '../pedals/profiles.js';
import { createPedalMidi } from '../pedals/pedal-midi.js';
import { loadRig, saveRig, sanitizeRig, pairChannels, contextSampleRate } from '../pedals/rig-settings.js';
import { compensationMs, partLeadSeconds } from '../pedals/latency-comp.js';

const AUDIO_KEYS = ['enabled', 'outputDeviceId', 'mainPair', 'sendPair', 'ceilingDb'];
const RETURN_KEYS = ['returnEnabled', 'returnDeviceId', 'returnLayout', 'returnLevel', 'returnDelay', 'returnReverb'];
const COMP_KEYS = ['compensate', 'compOffsetMs', 'lastLatencyMs'];

/**
 * @param {object} o
 * @param {object} o.store
 * @param {object|null} o.engine  needs engine.pedals for audio; setOutputDevice for the device picker
 * @param {object|null} o.midi    needs midi.sendRaw for pedal MIDI
 * @param {object|null} [o.router] the note router (src/music/router.js): its setLead takes the latency compensation
 * @param {Storage} [o.storage]
 * @param {() => Promise<boolean>} [o.micGranted] whether the return may reopen without a prompt
 * @param {() => void} [o.reload] restarts the app (a sample-rate change applies on the next start)
 */
export function createPedalRig({ store, engine = null, midi = null, router = null, storage = globalThis.localStorage, micGranted = defaultMicGranted, reload = defaultReload } = {}) {
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
  });
  offs.push(pmidi.on((e) => { if (e.type === 'error') { lastError = e.message; changed(); } }));

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
    for (const id of PEDAL_IDS) {
      const p = prefs.pedals[id];
      if (p.enabled && p.followSource && p.followControl) pmidi.map({ source: p.followSource, pedal: id, control: p.followControl });
    }
    // Push the current macro values through the new mappings.
    for (let i = 1; i <= 4; i++) {
      const v = Number(store.get(`global.macro${i}`));
      if (Number.isFinite(v)) pmidi.input(`macro${i}`, v);
    }
  }
  const lastMacro = {};
  offs.push(store.subscribe('global', () => {
    for (let i = 1; i <= 4; i++) {
      const v = Number(store.get(`global.macro${i}`));
      if (Number.isFinite(v) && v !== lastMacro[i]) { lastMacro[i] = v; pmidi.input(`macro${i}`, v); }
    }
  }));
  if (host) offs.push(host.on('guitar', (e) => pmidi.input('guitar', e.level)));

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
    changed();
    return status();
  }

  function setPedal(id, patch = {}) {
    if (!PEDAL_PROFILES[id]) return Promise.resolve(status());
    return set({ pedals: { [id]: { ...prefs.pedals[id], ...patch } } });
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
      lastError,
    };
  }

  /** At start-up: bring the saved rig back. The return only reopens without a prompt. */
  async function restore() {
    applyMidi();
    applyCompensation();
    if (!host) return status();
    if (prefs.enabled) await applyAudio();
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
    events.clear();
  }

  return {
    get prefs() { return sanitizeRig(prefs); },
    get host() { return host; },
    get pedalMidi() { return pmidi; },
    get supported() { return !!host; },
    set, setPedal, reconnectReturn, ping, pedalAction, conflicts, status, restore, dispose,
    compensation, sampleRate,
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

async function defaultMicGranted() {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  if (!nav || !nav.permissions || typeof nav.permissions.query !== 'function') return false;
  const p = await nav.permissions.query({ name: 'microphone' });
  return !!p && p.state === 'granted';
}
