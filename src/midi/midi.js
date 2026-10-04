// Web MIDI: inputs play parts and move knobs, outputs mirror Oro's notes
// and clock to external gear (an Akai MPC in particular, see mpc.js).
//
// createMidi() never throws: without Web MIDI it returns an object with
// supported = false and status 'unsupported', so the UI can explain why.
// Access is only requested from connect() (a click in the UI) unless the
// browser reports the permission was already granted.

import { MAX_PARTS, PART_PARAM_MAP, GLOBAL_PARAM_MAP, fromNorm, clamp, stepToMidi } from '../core/params.js';
import { partCount, watchTracks } from '../core/tracks.js';
import { createEmitter } from '../music/emitter.js';
import { createTimebase } from '../music/timing.js';
import { isMpcPort, detectMpcPort } from './mpc.js';
import { applySmartKnob, SMART_KNOBS } from '../core/smart.js';
import { LIVE_ACTIONS } from '../live/setup.js';
import { createClockFollower, clockBytes, parseSongPosition, CLOCK, START, CONTINUE, STOP, SONG_POSITION, CLOCK_ACTIVE_MS } from './clock.js';

export const STORAGE_KEY = 'orograph.midi';

export const DEFAULT_SETTINGS = Object.freeze({
  channelMode: 'omni',        // 'omni' | 'multi'
  omniTarget: 'sel',          // 'sel' | a track index 0..MAX_PARTS-1
  // Per track position (track 1, track 2, ...): the channel it listens to in
  // multi mode and sends on. Track i uses channel i by default.
  multiChannels: Array.from({ length: MAX_PARTS }, (_, i) => (i % 16) + 1),
  padMode: 'notes',           // 'notes' | 'scale'
  padBaseNote: 36,
  velocityCurve: 'linear',    // 'linear' | 'soft' | 'hard'
  outputId: null,
  sendNotes: false,
  outChannels: Array.from({ length: MAX_PARTS }, (_, i) => (i % 16) + 1),
  sendClock: false,
  followClock: false,
  programChange: false,
  mpe: false,                 // MPE lower zone: channel 1 = master, 2..16 = one note each
});

// MPE (lower zone). Member channels carry one note each with its own pitch
// bend (+/-48 semitones unless the controller sets another range with RPN 0),
// CC74 slide and channel pressure. The master channel (1) speaks for the zone.
export const MPE_MASTER = 1;
export const MPE_BEND_RANGE = 48;
const CC_SLIDE = 74;
/** Scheduled notes go to the MIDI port this long before they are due (ms); see noteOut. */
export const OUT_HOLD_MS = 150;
const RPN_CCS = new Set([101, 100, 6, 38]);

export const QLINK_PARAMS = [
  'centerX', 'centerY', 'size', 'rotate', 'morph', 'warp', 'fold', 'lift',
  'pathParam', 'stretch', 'cutoff', 'resonance', 'drive', 'filterEnv', 'reverbSend', 'delaySend',
];

// CC 120-127 are channel mode messages (all notes off etc.): never learn them.
const LEARNABLE_MAX_CC = 119;
// v1.2: buttons that can be MIDI-learned. A mapped CC fires the action when it
// crosses 64 upwards (press on a momentary button); the UI listens for
// midi.on('action', {id}) and does the rest.
// 2.12 live mode: the 16 pads, Next and Previous song, and Play / stop (appended).
/** v2.12: what a mapping listens to, for labels: "CC 20" or "note 36". */
export function mappingControl(m) {
  if (m && Number.isInteger(m.note)) return `note ${m.note}`;
  return `CC ${m && m.cc != null ? m.cc : '?'}`;
}

export const LEARNABLE_ACTIONS = Object.freeze(['looper.main', 'looper.stop', 'looper.undo', 'looper.clear', 'looper.mute', 'looper.resample', ...LIVE_ACTIONS]);
const ACTION_REPEAT_MS = 250;     // a controller that only sends "press" (127) still retriggers after this

const STATUS_TEXT = {
  idle: 'MIDI is off. Press Connect MIDI to use a controller or an MPC.',
  connecting: 'Asking the browser for MIDI access...',
  ready: 'MIDI is connected.',
  denied: 'MIDI access was blocked. Allow MIDI devices in the site settings (the icon in the address bar), then reload.',
  error: 'MIDI could not start.',
  unsupported: 'This browser does not offer Web MIDI. Use Chrome, Edge, Opera or the Oro desktop app.',
};

const INSECURE_TEXT = 'MIDI needs a secure page. Open Oro over https, from localhost, or use the desktop app.';

function safeStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

const isChannel = (v) => Number.isInteger(v) && v >= 1 && v <= 16;

export function sanitizeSettings(src = {}) {
  const d = DEFAULT_SETTINGS;
  const s = src && typeof src === 'object' ? src : {};
  // Settings saved with four parts keep their four channels; the tracks after
  // them get their defaults (track i on channel i).
  const chans = (v, def) => (Array.isArray(v) && v.length >= 1 && v.length <= MAX_PARTS && v.every(isChannel)
    ? [...v, ...def.slice(v.length)] : def.slice());
  const target = s.omniTarget === 'sel' || (Number.isInteger(s.omniTarget) && s.omniTarget >= 0 && s.omniTarget < MAX_PARTS) ? s.omniTarget : d.omniTarget;
  return {
    channelMode: s.channelMode === 'multi' ? 'multi' : 'omni',
    omniTarget: target,
    multiChannels: chans(s.multiChannels, d.multiChannels),
    padMode: s.padMode === 'scale' ? 'scale' : 'notes',
    padBaseNote: Number.isFinite(s.padBaseNote) ? clamp(Math.round(s.padBaseNote), 0, 127) : d.padBaseNote,
    velocityCurve: ['linear', 'soft', 'hard'].includes(s.velocityCurve) ? s.velocityCurve : d.velocityCurve,
    outputId: typeof s.outputId === 'string' && s.outputId ? s.outputId : null,
    sendNotes: !!s.sendNotes,
    outChannels: chans(s.outChannels, d.outChannels),
    sendClock: !!s.sendClock,
    followClock: !!s.followClock,
    programChange: !!s.programChange,
    mpe: !!s.mpe,
  };
}

/** Also accepts store paths ('parts.0.params.cutoff', 'parts.sel.params.morph', 'global.tempo') or a bare id. */
function sanitizeTarget(t) {
  if (typeof t === 'string' && t.startsWith('action:')) return sanitizeTarget({ scope: 'action', id: t.slice(7) });
  if (t && typeof t === 'object' && t.scope === 'action') return LEARNABLE_ACTIONS.includes(t.id) ? { scope: 'action', id: t.id } : null;
  if (typeof t === 'string') {
    let m = /^parts\.(sel|\d+)\.params\.(\w+)$/.exec(t);
    if (m) return sanitizeTarget({ scope: 'part', part: m[1] === 'sel' ? 'sel' : Number(m[1]), id: m[2] });
    m = /^global\.(\w+)$/.exec(t);
    if (m) return sanitizeTarget({ scope: 'global', id: m[1] });
    if (PART_PARAM_MAP[t]) return { scope: 'part', part: 'sel', id: t };
    if (GLOBAL_PARAM_MAP[t]) return { scope: 'global', id: t };
    return null;
  }
  if (!t || typeof t !== 'object') return null;
  if (t.scope === 'global') return GLOBAL_PARAM_MAP[t.id] ? { scope: 'global', id: t.id } : null;
  // v2.8 smart knobs: { scope: 'smart', part: 'sel' | index, id: 'smart1'..'smart8' }
  if (t.scope === 'smart') {
    const m = /^smart(\d+)$/.exec(String(t.id));
    if (!m || !(Number(m[1]) >= 1 && Number(m[1]) <= SMART_KNOBS)) return null;
    const part = t.part === 'sel' || t.part == null ? 'sel' : Number(t.part);
    if (part !== 'sel' && !(Number.isInteger(part) && part >= 0 && part < MAX_PARTS)) return null;
    return { scope: 'smart', part, id: `smart${Number(m[1])}` };
  }
  if (t.scope === 'part' || t.scope == null) {
    if (!PART_PARAM_MAP[t.id]) return null;
    const part = t.part === 'sel' || t.part == null ? 'sel' : Number(t.part);
    if (part !== 'sel' && !(Number.isInteger(part) && part >= 0 && part < MAX_PARTS)) return null;
    return { scope: 'part', part, id: t.id };
  }
  return null;
}

function sameTarget(a, b) {
  return a.scope === b.scope && a.id === b.id && (a.scope === 'global' || a.scope === 'action' || a.part === b.part);
}

function sanitizeMappings(list) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    const target = sanitizeTarget(m && m.target);
    if (!target) continue;
    const channel = m.channel == null ? null : Number(m.channel);
    if (channel !== null && !isChannel(channel)) continue;
    // v2.12: buttons (actions) can also be learned from a note, e.g. drum pads.
    const note = m.note == null ? null : Number(m.note);
    if (note !== null) {
      if (target.scope === 'action' && Number.isInteger(note) && note >= 0 && note <= 127) out.push({ note, channel, target });
      continue;
    }
    const cc = Number(m.cc);
    if (!Number.isInteger(cc) || cc < 0 || cc > LEARNABLE_MAX_CC) continue;
    out.push({ cc, channel, target });
  }
  return out;
}

export function applyVelocityCurve(v, curve) {
  v = clamp(v, 0, 1);
  if (curve === 'soft') return Math.pow(v, 0.6);   // light touch reaches loud notes sooner
  if (curve === 'hard') return Math.pow(v, 1.7);   // needs a firm hit for full velocity
  return v;
}

export async function createMidi({
  store,
  router,
  engine = null,
  transport = null,
  presets = null,
  navigator: nav = globalThis.navigator,
  storage = safeStorage(),
  secure = globalThis.isSecureContext,
  perfNow,
  timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
} = {}) {
  const emitter = createEmitter();
  const timebase = createTimebase(engine, perfNow ? { perfNow } : {});
  const now = () => timebase.perfNow();
  const supported = !!(nav && typeof nav.requestMIDIAccess === 'function');

  let access = null;
  let connecting = null;
  let status = supported ? 'idle' : 'unsupported';
  // Web MIDI only exists on secure pages, so an http:// page looks "unsupported" too.
  let error = supported ? null : (secure === false ? INSECURE_TEXT : STATUS_TEXT.unsupported);
  let settings = { ...DEFAULT_SETTINGS };
  let outputManual = false;
  let outputName = null;          // remembered so a manual choice survives a new port id
  let inputPrefs = {};            // port name -> enabled
  let mappings = [];
  let learnPending = null;
  let padLearnPending = null;
  let output = null;
  const attached = new Map();     // input id -> input
  const heldIn = new Map();       // `${port}:${ch}:${note}` -> { targets, mapped, source, port }
  const heldOut = new Map();      // `${ch}:${note}` -> count of note-ons without an off yet
  const usedOutChannels = new Set();
  let lastFutureSendMs = -Infinity;
  const follower = createClockFollower();
  let clockSourceId = null;
  let lastTempoWrite = -Infinity;
  let lastClockEmit = { bpm: 0, running: false, active: false, at: -Infinity };
  let quietTimer = null;          // fires once the incoming clock has gone quiet (see watchQuiet)
  let inClockCount = 0;
  let outClockCount = 0;
  // MPE: per input and channel, the note it is playing and its expression.
  // Kept per channel even before a note arrives, because controllers send a
  // note's starting bend / slide / pressure just before its note-on.
  const mpeState = new Map();     // `${port}:${ch}` -> { note, mapped, parts, bend, slide, pressure }
  const rpn = new Map();          // `${port}:${ch}` -> { msb, lsb }
  let memberBendRange = MPE_BEND_RANGE;

  // ------------------------------------------------------------ persistence

  function load() {
    if (!storage) return;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      settings = sanitizeSettings(data.settings);
      outputManual = !!data.outputManual;
      outputName = typeof data.outputName === 'string' ? data.outputName : null;
      inputPrefs = data.inputPrefs && typeof data.inputPrefs === 'object' ? { ...data.inputPrefs } : {};
      mappings = sanitizeMappings(data.mappings);
    } catch { /* corrupt or blocked storage: start fresh */ }
  }

  function persist() {
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify({ settings, outputManual, outputName, inputPrefs, mappings }));
    } catch { /* storage full or blocked */ }
  }

  load();
  if (transport && typeof transport.setFollow === 'function') transport.setFollow(settings.followClock);

  const emitChange = (what) => emitter.emit('change', { what });

  // ------------------------------------------------------------------ ports

  const portList = (map) => (map ? [...map.values()] : []);

  function inputEnabled(port) {
    const v = inputPrefs[port.name];
    return v === undefined ? true : !!v;
  }

  function attach(input) {
    if (attached.has(input.id)) return;
    input.onmidimessage = (e) => handleMessage(input, e);
    attached.set(input.id, input);
  }

  function detach(input) {
    if (attached.get(input.id) === input || attached.has(input.id)) {
      try { input.onmidimessage = null; } catch { /* port gone */ }
      attached.delete(input.id);
    }
    releaseInputNotes(input.id);
    for (const k of [...mpeState.keys()]) if (k.startsWith(input.id + ':')) mpeState.delete(k);
    if (clockSourceId === input.id) {
      clockSourceId = null;
      if (settings.followClock && transport) transport.syncStop();
      follower.reset();
      emitClock(true);
    }
  }

  function syncInputs() {
    if (!access) return;
    for (const input of portList(access.inputs)) {
      if (input.state === 'disconnected' || !inputEnabled(input)) detach(input);
      else attach(input);
    }
    for (const [id, input] of attached) {
      if (!access.inputs.get || !access.inputs.get(id)) detach(input);
    }
  }

  function chooseOutput() {
    if (!access) { output = null; return; }
    const outs = portList(access.outputs).filter(o => o.state !== 'disconnected');
    let pick = null;
    if (outputManual) {
      if (settings.outputId) pick = outs.find(o => o.id === settings.outputId) || (outputName && outs.find(o => o.name === outputName)) || null;
    } else {
      pick = detectMpcPort(outs);
    }
    if (pick) {
      if (output !== pick) { output = pick; error = null; }
      settings.outputId = pick.id;
      outputName = pick.name;
    } else {
      output = null;
      if (!outputManual) settings.outputId = null;
    }
  }

  function handleOutputLost(port) {
    const name = (port && port.name) || outputName || 'MIDI output';
    output = null;
    heldOut.clear();
    error = `${name} was disconnected, so Oro stopped sending to it. Reconnect it and it will be picked up again.`;
    emitChange('devices');
  }

  function onStateChange(e) {
    const port = e && e.port;
    if (!port) return;
    if (port.type === 'input') {
      if (port.state === 'disconnected') detach(port);
      else if (inputEnabled(port)) attach(port);
    } else if (port.type === 'output') {
      if (port.state === 'disconnected') {
        if (output && output.id === port.id) handleOutputLost(port);
      } else {
        const before = output;
        chooseOutput();
        if (output && output !== before && error && /disconnected/.test(error)) error = null;
      }
    }
    emitChange('devices');
  }

  // `quiet` is the automatic attempt at startup: if it fails, stay idle and
  // let the user's own Connect click report what went wrong.
  async function connect({ quiet = false } = {}) {
    if (!supported) { status = 'unsupported'; emitChange('status'); return api; }
    if (access) return api;
    if (connecting) return connecting;
    status = 'connecting';
    error = null;
    emitChange('status');
    connecting = (async () => {
      try {
        access = await nav.requestMIDIAccess({ sysex: false });
      } catch (err) {
        const name = err && err.name;
        access = null;
        if (quiet) {
          status = 'idle';
          error = null;
        } else {
          status = name === 'SecurityError' || name === 'NotAllowedError' ? 'denied' : 'error';
          error = status === 'denied'
            ? STATUS_TEXT.denied
            : `MIDI could not start: ${(err && err.message) || err}`;
        }
        emitChange('status');
        return api;
      } finally {
        connecting = null;
      }
      access.onstatechange = onStateChange;
      syncInputs();
      chooseOutput();
      status = 'ready';
      emitChange('status');
      return api;
    })();
    return connecting;
  }

  // ------------------------------------------------------------ input side

  const isMember = (ch) => settings.mpe && ch !== MPE_MASTER;

  // A numbered target past the end of the track list falls back to the selected track.
  const omni = () => (settings.omniTarget === 'sel' || settings.omniTarget < partCount(store) ? settings.omniTarget : 'sel');

  function targetsFor(ch) {
    // In MPE mode every channel of the zone plays the same target (the selected part or Layer).
    if (settings.mpe) return [omni()];
    if (settings.channelMode === 'multi') {
      const out = [];
      const n = partCount(store);
      settings.multiChannels.forEach((c, p) => { if (c === ch && p < n) out.push(p); });
      return out;
    }
    return [omni()];
  }

  function partsFor(targets) {
    const set = new Set();
    for (const t of targets) {
      const list = router && typeof router.resolve === 'function'
        ? router.resolve(t)
        : [t === 'sel' ? clamp(store.get('ui.selectedPart') || 0, 0, partCount(store) - 1) : t];
      for (const p of list) set.add(p);
    }
    return [...set];
  }

  function mapPadNote(note) {
    if (settings.padMode !== 'scale') return note;
    const root = Math.round(store.get('global.scaleRoot') || 0);
    const scaleType = Math.round(store.get('global.scaleType') || 0);
    const base = settings.padBaseNote;
    // Degree 0 lands on the key's root at or just above the base note.
    const baseOctave = Math.ceil((base - root) / 12) - 1;
    const n = stepToMidi({ degree: note - base, octave: 0 }, baseOctave, root, scaleType);
    return n >= 0 && n <= 127 ? n : null;
  }

  function activity(dir, kind, port) {
    emitter.emit('activity', { dir, kind, port: (port && port.name) || '' });
  }

  // v2.12: notes learned as buttons fire their action and are not played.
  const noteHits = (ch, note) => mappings.filter(m => m.note === note && (m.channel == null || m.channel === ch));
  const swallowed = new Set();
  function noteAction(input, ch, note, vel) {
    if (learnPending && learnPending.target.scope === 'action') {
      const { target, resolve } = learnPending;
      learnPending = null;
      const mapping = { note, channel: ch, target };
      mappings = mappings.filter(m => !sameTarget(m.target, target) && !(m.note === note && (m.channel === ch || m.channel == null)));
      mappings.push(mapping);
      persist();
      emitter.emit('learn', { target, note, channel: ch });
      emitChange('mappings');
      resolve({ ...mapping, target: { ...target } });
      swallowed.add(`${input && input.id}:${ch}:${note}`);
      return true;
    }
    const hits = noteHits(ch, note);
    if (!hits.length) return false;
    for (const m of hits) emitter.emit('action', { id: m.target.id, value: vel });
    swallowed.add(`${input && input.id}:${ch}:${note}`);
    return true;
  }

  function noteOnIn(input, ch, note, vel) {
    if (noteAction(input, ch, note, vel)) return;
    if (padLearnPending) {
      const p = padLearnPending;
      padLearnPending = null;
      setSetting('padBaseNote', note);
      p.resolve(note);
    }
    const targets = targetsFor(ch);
    if (!targets.length || !router) return;
    const mapped = mapPadNote(note);
    if (mapped == null) return;
    const key = `${input.id}:${ch}:${note}`;
    if (heldIn.has(key)) noteOffIn(input, ch, note);
    const source = `midi:${input.id}:${ch}`;
    heldIn.set(key, { targets, mapped, source, port: input.id });
    const v = Math.max(1 / 127, applyVelocityCurve(vel / 127, settings.velocityCurve));
    for (const t of targets) router.noteOn(t, mapped, v, source);
    if (isMember(ch)) mpeNoteOn(input, ch, mapped, targets);
  }

  function noteOffIn(input, ch, note) {
    if (swallowed.delete(`${input && input.id}:${ch}:${note}`)) return;
    if (!router) return;
    const key = `${input.id}:${ch}:${note}`;
    const held = heldIn.get(key);
    if (held) {
      heldIn.delete(key);
      for (const t of held.targets) router.noteOff(t, held.mapped, held.source);
      if (isMember(ch)) mpeNoteOff(input, ch, held.mapped);
      return;
    }
    const mapped = mapPadNote(note);
    if (mapped == null) return;
    for (const t of targetsFor(ch)) router.noteOff(t, mapped, `midi:${input.id}:${ch}`);
  }

  function releaseInputNotes(portId) {
    if (!router) return;
    for (const [key, held] of [...heldIn]) {
      if (held.port !== portId) continue;
      heldIn.delete(key);
      for (const t of held.targets) router.noteOff(t, held.mapped, held.source);
    }
  }

  // Last value and trigger time per action mapping (rising-edge detection).
  const actionLatch = new Map();
  function applyAction(m, value, learning = false) {
    const key = `${m.cc}:${m.channel}:${m.target.id}`;
    const prev = actionLatch.get(key) || { v: 0, at: -Infinity };
    const t = now();
    const press = value >= 64 && (prev.v < 64 || t - prev.at >= ACTION_REPEAT_MS);
    actionLatch.set(key, { v: value, at: press ? t : prev.at });
    // The press that teaches the mapping only teaches it.
    if (press && !learning) emitter.emit('action', { id: m.target.id, value });
  }

  function applyMapping(m, value) {
    const n = value / 127;
    const { target } = m;
    if (target.scope === 'action') { applyAction(m, value); return; }
    if (target.scope === 'global') {
      const def = GLOBAL_PARAM_MAP[target.id];
      if (def) store.set(`global.${target.id}`, fromNorm(def, n), { source: 'midi' });
      return;
    }
    if (target.scope === 'smart') {
      const p = target.part === 'sel' ? clamp(Math.round(store.get('ui.selectedPart') || 0), 0, partCount(store) - 1) : target.part;
      if (p < partCount(store)) applySmartKnob(store, p, Number(target.id.slice(5)) - 1, n, { source: 'midi' });
      return;
    }
    const def = PART_PARAM_MAP[target.id];
    if (!def) return;
    const p = target.part === 'sel' ? clamp(Math.round(store.get('ui.selectedPart') || 0), 0, partCount(store) - 1) : target.part;
    if (!(p < partCount(store))) return;
    store.set(`parts.${p}.params.${target.id}`, fromNorm(def, n), { source: 'midi' });
  }

  function ccIn(input, ch, cc, value) {
    // MPE expression and bend-range setup are performance data, never learnable.
    if (settings.mpe) {
      if (RPN_CCS.has(cc)) { rpnIn(input, ch, cc, value); return; }
      if (cc === CC_SLIDE) { slideIn(input, ch, value / 127); return; }
    }
    const controlSource = { 11: 'expression', 64: 'sustainLevel', 2: 'breath' }[cc];
    if (controlSource && engine?.controlSource) for (const p of partsFor(targetsFor(ch))) engine.controlSource(p, controlSource, value / 127);
    if (learnPending && cc <= LEARNABLE_MAX_CC) {
      const { target, resolve } = learnPending;
      learnPending = null;
      const mapping = { cc, channel: ch, target };
      mappings = mappings.filter(m => !sameTarget(m.target, target) && !(m.note == null && m.cc === cc && (m.channel === ch || m.channel == null)));
      mappings.push(mapping);
      persist();
      emitter.emit('learn', { target, cc, channel: ch });
      emitChange('mappings');
      resolve({ ...mapping, target: { ...target } });
      if (target.scope === 'action') applyAction(mapping, value, true);
      else applyMapping(mapping, value);
      return;
    }
    const hits = mappings.filter(m => m.note == null && m.cc === cc && (m.channel == null || m.channel === ch));
    if (hits.length) { for (const m of hits) applyMapping(m, value); return; }
    const targets = targetsFor(ch);
    if (!targets.length) return;
    switch (cc) {
      case 1:
        if (engine && engine.wheel) for (const p of partsFor(targets)) engine.wheel(p, value / 127);
        break;
      case 64:
        if (router) for (const t of targets) router.sustain(t, value >= 64);
        break;
      case 120:
      case 123:
        if (router) for (const t of targets) router.allNotesOff(t);
        break;
      case 121:
        for (const p of partsFor(targets)) {
          if (engine && engine.bend) engine.bend(p, 0);
          if (engine && engine.wheel) engine.wheel(p, 0);
          if (engine?.controlSource) for (const source of ['expression','sustainLevel','breath']) engine.controlSource(p, source, 0);
        }
        if (router) for (const t of targets) router.sustain(t, false);
        break;
      default: break;
    }
  }

  function bendIn(input, ch, lsb, msb) {
    const v = clamp((((msb << 7) | lsb) - 8192) / 8192, -1, 1);
    if (isMember(ch)) { mpeBendIn(input, ch, v); return; }
    if (!engine || !engine.bend) return;
    for (const p of partsFor(targetsFor(ch))) engine.bend(p, v);
  }

  // ------------------------------------------------- pressure / aftertouch / MPE

  const call = (fn, ...args) => {
    if (!engine || typeof engine[fn] !== 'function') return false;
    try { engine[fn](...args); return true; } catch (err) { console.warn(`[orograph] engine.${fn} failed`, err); return false; }
  };

  /** Channel pressure: every voice of the channel's parts, or one note on an MPE member channel. */
  function channelPressureIn(input, ch, value) {
    const v = value / 127;
    if (isMember(ch)) {
      const st = mpeChannel(input, ch);
      st.pressure = v;
      if (st.note != null) for (const p of st.parts) call('pressure', p, v, st.note);
      return;
    }
    for (const p of partsFor(targetsFor(ch))) call('pressure', p, v);
  }

  /** Polyphonic aftertouch: pressure for one held key. */
  function polyPressureIn(input, ch, note, value) {
    const held = heldIn.get(`${input.id}:${ch}:${note}`);
    const mapped = held ? held.mapped : mapPadNote(note);
    if (mapped == null) return;
    for (const p of partsFor(held ? held.targets : targetsFor(ch))) call('pressure', p, value / 127, mapped);
  }

  function slideIn(input, ch, v) {
    if (isMember(ch)) {
      const st = mpeChannel(input, ch);
      st.slide = v;
      if (st.note != null) for (const p of st.parts) call('slide', p, v, st.note);
      return;
    }
    // The master channel's CC74 speaks for the whole zone.
    for (const p of partsFor(targetsFor(ch))) call('slide', p, v);
  }

  function mpeChannel(input, ch) {
    const key = `${input.id}:${ch}`;
    let st = mpeState.get(key);
    if (!st) { st = { note: null, parts: [], bend: 0, slide: null, pressure: null }; mpeState.set(key, st); }
    return st;
  }

  /**
   * Per-note bend in semitones. Uses engine.noteBend(part, note, semitones)
   * when the engine has it; otherwise the part's whole bend follows the most
   * recently played MPE note (scaled into the part's bend range), which is
   * right for one note at a time and close for chords.
   */
  function sendNoteBend(p, note, semis) {
    if (call('noteBend', p, note, semis)) return;
    const range = Math.max(1, Number(store.get(`parts.${p}.params.bendRange`)) || 2);
    call('bend', p, clamp(semis / range, -1, 1));
  }

  function mpeNoteOn(input, ch, note, targets) {
    const st = mpeChannel(input, ch);
    st.note = note;
    st.parts = partsFor(targets);
    for (const p of st.parts) {
      sendNoteBend(p, note, st.bend * memberBendRange);
      if (st.slide != null) call('slide', p, st.slide, note);
      if (st.pressure != null) call('pressure', p, st.pressure, note);
    }
  }

  function mpeNoteOff(input, ch, note) {
    const st = mpeState.get(`${input.id}:${ch}`);
    if (st && st.note === note) { st.note = null; st.parts = []; }
  }

  function mpeBendIn(input, ch, v) {
    const st = mpeChannel(input, ch);
    st.bend = v;
    if (st.note != null) for (const p of st.parts) sendNoteBend(p, st.note, v * memberBendRange);
  }

  /** RPN 0 (pitch bend sensitivity) on a member channel sets the member bend range. */
  function rpnIn(input, ch, cc, value) {
    const key = `${input.id}:${ch}`;
    const r = rpn.get(key) || { msb: 127, lsb: 127 };
    rpn.set(key, r);
    if (cc === 101) r.msb = value;
    else if (cc === 100) r.lsb = value;
    else if (cc === 6 && r.msb === 0 && r.lsb === 0 && ch !== MPE_MASTER) memberBendRange = clamp(value, 1, 96);
    else if (cc === 6 && r.msb === 0 && r.lsb === 6 && ch === MPE_MASTER) memberBendRange = MPE_BEND_RANGE; // MPE configuration resets ranges
  }

  function resetMpe() {
    mpeState.clear();
    rpn.clear();
    memberBendRange = MPE_BEND_RANGE;
  }

  function programIn(ch, program) {
    if (!settings.programChange || !presets) return;
    const list = presets.patches();
    const patch = typeof presets.programPatch === 'function' ? presets.programPatch(program) : list[program];
    if (!patch) return;
    for (const p of partsFor(targetsFor(ch))) presets.loadPatch(p, patch.id);
  }

  function emitClock(force = false) {
    const bpm = follower.displayBpm();
    const running = follower.running;
    const t = now();
    const active = follower.active(t);
    if (force || running !== lastClockEmit.running || active !== lastClockEmit.active || (Math.abs(bpm - lastClockEmit.bpm) >= 0.1 && t - lastClockEmit.at > 200)) {
      lastClockEmit = { bpm, running, active, at: t };
      emitter.emit('clock', { bpm, running, active });
    }
  }

  // No message marks the end of a clock: it simply stops arriving (the master
  // was switched off, unplugged, or stops sending clock while stopped). Once
  // the follower no longer counts it as active, say so, so the UI drops the
  // EXT badge and makes the tempo editable again.
  function watchQuiet() {
    if (quietTimer != null) return;
    const wait = Math.max(10, follower.lastPulseMs() + CLOCK_ACTIVE_MS - now() + 10);
    quietTimer = timers.setTimeout(() => {
      quietTimer = null;
      if (follower.active(now())) { watchQuiet(); return; }
      emitClock(true);
    }, wait);
  }

  function systemIn(input, data, ms) {
    const status = data[0];
    if (status === 0xfe) return; // active sensing
    const isClock = status === CLOCK || status === START || status === CONTINUE || status === STOP || status === SONG_POSITION;
    if (!isClock) { activity('in', 'other', input); return; }
    // Follow one clock source; switch only if it has gone quiet.
    if (clockSourceId && clockSourceId !== input.id && follower.active(ms)) return;
    clockSourceId = input.id;
    const follow = settings.followClock && transport;
    switch (status) {
      case CLOCK: {
        const tick = follower.pulse(ms);
        if ((inClockCount++ % 6) === 0) activity('in', 'clock', input);
        if (follow) {
          // Every pulse goes to the transport (it ignores them unless the MPC
          // started it), so it knows a clock is arriving.
          transport.syncTick({ beat: tick.beat, time: timebase.perfToAudio(tick.time), bpm: tick.bpm });
        }
        if (follow && tick.running) {
          const tempo = Math.round(follower.displayBpm());
          if (tempo >= 40 && tempo <= 240 && tempo !== store.get('global.tempo') && ms - lastTempoWrite > 250) {
            lastTempoWrite = ms;
            store.set('global.tempo', tempo, { source: 'clock' });
          }
        }
        emitClock();
        watchQuiet();
        return;
      }
      case START:
        follower.start();
        activity('in', 'clock', input);
        if (follow) transport.syncStart({ beat: 0 });
        emitClock(true);
        return;
      case CONTINUE:
        follower.continue();
        activity('in', 'clock', input);
        if (follow) transport.syncStart({ beat: follower.position / 24 });
        emitClock(true);
        return;
      case STOP:
        follower.stop();
        activity('in', 'clock', input);
        if (follow) transport.syncStop();
        emitClock(true);
        return;
      case SONG_POSITION:
        if (data.length >= 3) follower.songPosition(parseSongPosition(data));
        activity('in', 'clock', input);
        return;
      default: return;
    }
  }

  function handleMessage(input, e) {
    const data = e && e.data;
    if (!data || !data.length) return;
    const ms = e.timeStamp > 0 ? e.timeStamp : now();
    // v2.9 Operator panel MIDI monitor (nothing is copied while no one listens)
    if (emitter.has('monitor')) emitter.emit('monitor', { bytes: Array.from(data), port: (input && input.name) || '', time: ms });
    try {
      const status = data[0];
      if (status >= 0xf0) { systemIn(input, data, ms); return; }
      const type = status & 0xf0;
      const ch = (status & 0x0f) + 1;
      switch (type) {
        case 0x90:
          activity('in', 'note', input);
          if (data[2] > 0) noteOnIn(input, ch, data[1], data[2]);
          else noteOffIn(input, ch, data[1]);
          break;
        case 0x80:
          activity('in', 'note', input);
          noteOffIn(input, ch, data[1]);
          break;
        case 0xb0:
          activity('in', 'cc', input);
          ccIn(input, ch, data[1], data[2]);
          break;
        case 0xe0:
          activity('in', 'other', input);
          bendIn(input, ch, data[1], data[2]);
          break;
        case 0xd0:
          activity('in', 'other', input);
          channelPressureIn(input, ch, data[1]);
          break;
        case 0xa0:
          activity('in', 'other', input);
          polyPressureIn(input, ch, data[1], data[2]);
          break;
        case 0xc0:
          activity('in', 'other', input);
          programIn(ch, data[1]);
          break;
        default:
          activity('in', 'other', input);
      }
    } catch (err) {
      console.warn('[orograph] MIDI message failed', err);
    }
  }

  // ----------------------------------------------------------- output side

  function send(bytes, ms) {
    if (!output) return false;
    if (output.state === 'disconnected') { handleOutputLost(output); return false; }
    try {
      if (ms != null && ms > now()) { output.send(bytes, ms); lastFutureSendMs = Math.max(lastFutureSendMs, ms); }
      else output.send(bytes);
      return true;
    } catch (err) {
      handleOutputLost(output);
      return false;
    }
  }

  // Messages handed to the browser with a future timestamp cannot be recalled,
  // so scheduled notes are held here until shortly before they are due. Stop
  // can then drop the ones queued past it (router 'cancel'), as the engine does.
  const pendingOut = [];
  function dropPending(entry) {
    timers.clearTimeout(entry.id);
    const i = pendingOut.indexOf(entry);
    if (i >= 0) pendingOut.splice(i, 1);
  }
  function clearPendingOut() { for (const entry of [...pendingOut]) dropPending(entry); }
  function cancelOut({ after, source } = {}) {
    for (const entry of [...pendingOut]) {
      const e = entry.e;
      if (!e.on || !(e.time > after) || (source != null && e.source !== source) || !pendingOut.includes(entry)) continue;
      dropPending(entry);
      // its own note-off, if that is still waiting too
      const off = pendingOut.find(o => !o.e.on && o.e.part === e.part && o.e.note === e.note && o.e.source === e.source && o.e.time >= e.time);
      if (off) dropPending(off);
    }
  }

  function noteOut(e) {
    if (!settings.sendNotes || !output) return;
    if (String(e.source || '').startsWith('midi')) return; // never echo a controller back to itself
    const ms = e.time > 0 ? timebase.audioToPerf(e.time) : null;
    if (ms != null && ms - now() > OUT_HOLD_MS) {
      const entry = { e, id: 0 };
      entry.id = timers.setTimeout(() => { dropPending(entry); sendNote(e, ms); }, ms - now() - OUT_HOLD_MS);
      pendingOut.push(entry);
      return;
    }
    sendNote(e, ms);
  }

  function sendNote(e, ms) {
    if (!settings.sendNotes || !output) return;
    const chan = settings.outChannels[e.part];
    if (!isChannel(chan)) return;
    const ch = chan - 1;
    const note = clamp(Math.round(e.note), 0, 127);
    const key = `${chan}:${note}`;
    if (e.on) {
      const vel = clamp(Math.round(e.vel * 127), 1, 127);
      if (send([0x90 | ch, note, vel], ms)) {
        heldOut.set(key, (heldOut.get(key) || 0) + 1);
        usedOutChannels.add(chan);
        activity('out', 'note', output);
      }
    } else {
      if (send([0x80 | ch, note, 0], ms)) {
        const c = (heldOut.get(key) || 0) - 1;
        if (c > 0) heldOut.set(key, c); else heldOut.delete(key);
      }
    }
  }

  function clockOut(e) {
    if (!settings.sendClock || !output) return;
    if (transport && transport.isFollowing && transport.isFollowing()) return;
    const bytes = clockBytes(e.type);
    if (!bytes) return;
    const ms = e.type === 'stop' ? null : timebase.audioToPerf(e.time);
    if (send(bytes, ms) && (e.type !== 'tick' || (outClockCount++ % 6) === 0)) activity('out', 'clock', output);
  }

  function releaseOutputNotes() {
    for (const key of heldOut.keys()) {
      const [chan, note] = key.split(':').map(Number);
      send([0x80 | (chan - 1), note, 0]);
    }
    heldOut.clear();
  }

  function panic() {
    if (router) router.allNotesOff();
    if (engine && typeof engine.panic === 'function') { try { engine.panic(); } catch { /* not started */ } }
    clearPendingOut();
    if (!output) return;
    try { if (typeof output.clear === 'function') output.clear(); } catch { /* not implemented everywhere */ }
    releaseOutputNotes();
    // the channels of the tracks in the list, plus any that sent notes
    const chans = new Set([...settings.outChannels.slice(0, partCount(store)), ...usedOutChannels]);
    const sweep = () => {
      for (const chan of chans) {
        const ch = chan - 1;
        send([0xb0 | ch, 64, 0]);
        send([0xb0 | ch, 123, 0]);
        send([0xb0 | ch, 120, 0]);
      }
    };
    sweep();
    // Notes already queued with future timestamps can still arrive after this;
    // a second sweep once they are past catches them.
    if (lastFutureSendMs > now()) {
      const at = lastFutureSendMs + 20;
      for (const chan of chans) send([0xb0 | (chan - 1), 123, 0], at);
    }
    activity('out', 'other', output);
  }

  if (router && typeof router.on === 'function') { router.on('sched', noteOut); router.on('cancel', cancelOut); }
  // Channels belong to track positions: when tracks move, are added or are
  // removed, notes held on the old channels are released so none can hang.
  watchTracks(store, () => { if (output && heldOut.size) releaseOutputNotes(); });
  if (transport && typeof transport.on === 'function') {
    transport.on('clock', clockOut);
    transport.on('state', (s) => {
      // Stopping must never leave the external synth hanging.
      if (!s.playing && settings.sendNotes && output) setTimeoutSafe(() => releaseStaleOut(), 250);
    });
  }

  function setTimeoutSafe(fn, ms) { try { setTimeout(fn, ms); } catch { fn(); } }

  // After a stop, notes still counted as held beyond their queued note-offs
  // belong to ties the transport already closed; nothing else should remain.
  function releaseStaleOut() {
    if (!router || !output) return;
    const held = new Set();
    for (let p = 0; p < partCount(store); p++) for (const n of router.heldNotes(p)) held.add(`${settings.outChannels[p]}:${n}`);
    for (const key of [...heldOut.keys()]) {
      if (held.has(key)) continue;
      const [chan, note] = key.split(':').map(Number);
      send([0x80 | (chan - 1), note, 0]);
      heldOut.delete(key);
    }
  }

  // --------------------------------------------------------------- settings

  function setSetting(key, value) {
    if (!(key in DEFAULT_SETTINGS)) return false;
    if (key === 'outputId') {
      const prevOut = output;
      if (value === 'auto' || value === undefined) {
        outputManual = false;
      } else {
        outputManual = true;
        settings.outputId = value ? String(value) : null;
        outputName = null;
        if (value && access) { const o = access.outputs.get && access.outputs.get(String(value)); if (o) outputName = o.name; }
      }
      if (prevOut && settings.sendNotes) releaseOutputNotes();
      chooseOutput();
      if (!outputManual || !value) error = null;
      persist();
      emitChange('settings');
      return true;
    }
    const before = settings[key];
    const next = sanitizeSettings({ ...settings, [key]: value });
    settings = { ...next, outputId: settings.outputId };
    if (key === 'followClock' && transport && typeof transport.setFollow === 'function') transport.setFollow(settings.followClock);
    if (key === 'mpe' && before !== settings.mpe) resetMpe();
    if (key === 'sendNotes' && before && !settings.sendNotes) releaseOutputNotes();
    if (key === 'sendClock' && before && !settings.sendClock && output) send([STOP]);
    persist();
    emitChange('settings');
    return true;
  }

  function setInputEnabled(id, on) {
    const input = access && access.inputs.get ? access.inputs.get(id) : null;
    if (!input) return false;
    inputPrefs[input.name] = !!on;
    if (on && input.state !== 'disconnected') attach(input); else detach(input);
    persist();
    emitChange('devices');
    return true;
  }

  // --------------------------------------------------------------- learning

  function learn(target) {
    const t = sanitizeTarget(target);
    if (!t) return Promise.reject(new Error('Unknown MIDI learn target'));
    if (learnPending) learnPending.resolve(null);
    return new Promise((resolve) => { learnPending = { target: t, resolve }; });
  }

  function cancelLearn() {
    if (learnPending) { const p = learnPending; learnPending = null; p.resolve(null); }
    if (padLearnPending) { const p = padLearnPending; padLearnPending = null; p.resolve(null); }
  }

  /** Resolves with the next note number received and stores it as padBaseNote. */
  function learnPadBase() {
    if (padLearnPending) padLearnPending.resolve(null);
    return new Promise((resolve) => { padLearnPending = { resolve }; });
  }

  function unmap(ccOrTarget) {
    const before = mappings.length;
    if (typeof ccOrTarget === 'number') mappings = mappings.filter(m => m.note != null || m.cc !== ccOrTarget);
    else {
      const t = sanitizeTarget(ccOrTarget);
      if (t) mappings = mappings.filter(m => !sameTarget(m.target, t));
    }
    if (mappings.length !== before) { persist(); emitChange('mappings'); }
  }

  function clearMappings() {
    mappings = [];
    persist();
    emitChange('mappings');
  }

  function qlinkTargets() {
    return QLINK_PARAMS.map(id => ({ scope: 'part', part: 'sel', id, label: PART_PARAM_MAP[id].label }));
  }

  // -------------------------------------------------------------------- API

  const api = {
    get supported() { return supported; },
    get secure() { return secure !== false; },
    get status() { return status; },
    get error() { return error; },
    get externalClock() { return { active: follower.active(now()), bpm: follower.displayBpm() }; },
    get output() { return output ? { id: output.id, name: output.name } : null; },
    statusText() { return error || STATUS_TEXT[status] || ''; },
    connect,
    inputs() {
      return portList(access && access.inputs).map(i => ({
        id: i.id, name: i.name, manufacturer: i.manufacturer || '', state: i.state,
        enabled: inputEnabled(i), isMpc: isMpcPort(i.name),
      }));
    },
    outputs() {
      return portList(access && access.outputs).map(o => ({
        id: o.id, name: o.name, manufacturer: o.manufacturer || '', state: o.state, isMpc: isMpcPort(o.name),
      }));
    },
    setInputEnabled,
    /**
     * Raw bytes to a MIDI output (v1.1 pedal profiles): `outputId` picks a port,
     * otherwise the output chosen in Settings > MIDI & MPC. `ms` is a Web MIDI
     * timestamp (performance.now() clock). Returns false when nothing was sent.
     */
    sendRaw(bytes, ms, outputId) {
      let port = output;
      if (outputId && access && access.outputs && typeof access.outputs.get === 'function') port = access.outputs.get(String(outputId)) || null;
      if (!port || port.state === 'disconnected' || !Array.isArray(bytes) || !bytes.length) return false;
      try {
        if (ms != null && ms > now()) port.send(bytes, ms); else port.send(bytes);
        activity('out', 'other', port);
        return true;
      } catch { return false; }
    },
    /** Older shape: enable one input only, or 'all'. */
    setInput(id) {
      if (!access) return false;
      for (const input of portList(access.inputs)) setInputEnabled(input.id, id === 'all' || input.id === id);
      return true;
    },
    setChannelMode(mode) { return setSetting('channelMode', mode); },
    getSettings() { return { ...settings, multiChannels: settings.multiChannels.slice(), outChannels: settings.outChannels.slice(), outputAuto: !outputManual }; },
    setSetting,
    mappings() { return mappings.map(m => (m.note != null ? { note: m.note, channel: m.channel, target: { ...m.target } } : { cc: m.cc, channel: m.channel, target: { ...m.target } })); },
    learn,
    cancelLearn,
    learnPadBase,
    isLearning() { return !!learnPending; },
    unmap,
    clearMappings,
    qlinkTargets,
    panic,
    on: (type, fn) => emitter.on(type, fn),
    off: (type, fn) => emitter.off(type, fn),
  };

  // Reconnect silently only when the browser says permission was already given.
  if (supported) {
    try {
      if (nav.permissions && typeof nav.permissions.query === 'function') {
        const perm = await nav.permissions.query({ name: 'midi' });
        if (perm && perm.state === 'granted') await connect({ quiet: true });
      }
    } catch { /* permissions API missing or 'midi' not a known name */ }
  }

  return api;
}
