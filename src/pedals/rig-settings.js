// Per-device settings of the pedal rig (v1.1): which outputs carry the main mix
// and the pedal send, the send ceiling, the pedal return, and which MIDI pedal
// profiles are switched on, on which channel, what drives each pedal's
// modulated controls (Macro, Guitar level or an LFO, MOD_SLOTS per pedal), and
// whether patches may recall pedal presets. Like the audio quality these
// belong to the computer and the cables, not to a song, so they live in
// localStorage['orograph.pedals'] and never in sessions, scenes or patches
// (scenes and patches only store which pedal preset to call up, see
// pedal-presets.js).

import { PEDAL_PROFILES, PEDAL_IDS, findControl } from './profiles.js';
import { PEDAL_SOURCES, LFO_SHAPES, MAP_CURVES } from './pedal-midi.js';
import { DEFAULT_GATE_DB, GATE_MIN_DB, GATE_MAX_DB } from './guitar-notes.js';
import { MAX_PARTS } from '../core/params.js';

export const RIG_KEY = 'orograph.pedals';

/** Output pairs, by their first 0-based channel. */
export const OUTPUT_PAIRS = Object.freeze([0, 2, 4, 6].map(first => Object.freeze({ value: first, label: `Outputs ${first + 1}/${first + 2}` })));
/** Send ceilings offered in Settings (dBFS). -18 suits pedals that clip near +5 dBu. */
export const SEND_CEILINGS = Object.freeze([-30, -24, -18, -12]);
export const RETURN_LAYOUT_OPTIONS = Object.freeze([
  Object.freeze({ value: 'stereo', label: 'Stereo return' }),
  Object.freeze({ value: 'mono+guitar', label: 'Mono return + guitar' }),
]);
/**
 * Audio context sample rate (Settings > Pedals). 'auto' leaves it to the
 * browser (usually the device's rate); the MPC XL runs at 44.1 kHz. The engine
 * cannot swap its AudioContext while running, so a change applies on the next
 * start (Settings offers a Reload button).
 */
export const SAMPLE_RATE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'auto', label: 'Auto' }),
  Object.freeze({ value: 44100, label: '44.1 kHz' }),
  Object.freeze({ value: 48000, label: '48 kHz' }),
]);
/** Manual latency offset range (ms), added to the measured round trip. */
export const COMP_OFFSET_RANGE = Object.freeze({ min: -200, max: 200 });
/**
 * Guitar plays notes: which track. 'sel' follows the selected track (and
 * Layer key mode); a numbered track past the end of the list plays nothing.
 */
export const GUITAR_TARGETS = Object.freeze([
  Object.freeze({ value: 'sel', label: 'Selected track' }),
  ...Array.from({ length: MAX_PARTS }, (_, p) => Object.freeze({ value: p, label: `Track ${p + 1}` })),
]);
/** Guitar input channel, 1-based as on the interface. */
export const GUITAR_CHANNELS = Object.freeze([1, 2]);
/** Single-note tracking stays the default; chord tracking is experimental. */
export const GUITAR_MODE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'single', label: 'Single' }),
  Object.freeze({ value: 'chords', label: 'Chords' }),
]);
export const CAPTURE_SLOTS = Object.freeze([Object.freeze({ value: 'A', label: 'Slot A' }), Object.freeze({ value: 'B', label: 'Slot B' })]);
export { GATE_MIN_DB as GUITAR_GATE_MIN_DB, GATE_MAX_DB as GUITAR_GATE_MAX_DB };

/** What each input channel carries in a return layout (for Settings). */
export function guitarChannelOptions(layout) {
  return layout === 'mono+guitar'
    ? [{ value: 1, label: 'Ch 1 (pedals)' }, { value: 2, label: 'Ch 2 (guitar DI)' }]
    : [{ value: 1, label: 'Ch 1 (left)' }, { value: 2, label: 'Ch 2 (right)' }];
}

/** Sources a pedal can follow from Settings (a subset of PEDAL_SOURCES). */
export const FOLLOW_SOURCES = Object.freeze(PEDAL_SOURCES.filter(s => /^macro\d$/.test(s.id) || s.id === 'guitar'));
/** What can drive a pedal's modulated control: Off, Macro 1-4, Guitar level, or the slot's own LFO. */
export const MOD_SOURCES = Object.freeze([
  Object.freeze({ id: '', label: 'Off' }),
  ...FOLLOW_SOURCES.map(s => Object.freeze({ id: s.id, label: s.label })),
  Object.freeze({ id: 'lfo', label: 'LFO' }),
]);
/** Modulated controls per pedal (each with its own source and, for LFO, its own LFO). */
export const MOD_SLOTS = 2;
/** Free-running LFO rates, Hz. CCs go out at most about 100 times a second per pedal anyway. */
export const LFO_RATE_MIN = 0.02;
export const LFO_RATE_MAX = 10;
/** Tempo-synced LFO lengths, in beats per cycle. */
export const LFO_BEAT_OPTIONS = Object.freeze([
  { value: 0.25, label: '1/16' }, { value: 0.5, label: '1/8' }, { value: 1, label: '1/4' }, { value: 2, label: '1/2' },
  { value: 4, label: '1 bar' }, { value: 8, label: '2 bars' }, { value: 16, label: '4 bars' }, { value: 32, label: '8 bars' },
].map(Object.freeze));
export { LFO_SHAPES, MAP_CURVES };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const flag = (v, d) => (v === 0 || v === 1 ? v : typeof v === 'boolean' ? (v ? 1 : 0) : d);
const str = (v, d, max = 200) => (typeof v === 'string' ? v.slice(0, max) : d);

export function defaultModSlot() {
  return {
    source: '', control: '', min: 0, max: 1, curve: 0,
    lfoShape: 'sine', lfoSync: 0, lfoRate: 0.5, lfoBeats: 4, lfoDepth: 1,
  };
}

export function defaultPedalEntry(id) {
  const p = PEDAL_PROFILES[id];
  return { enabled: 0, channel: p ? p.channel : 1, mods: Array.from({ length: MOD_SLOTS }, defaultModSlot) };
}

export function defaultRig() {
  return {
    enabled: 0,
    outputDeviceId: 'default',
    mainPair: 0,
    sendPair: 2,
    ceilingDb: -18,
    returnEnabled: 0,
    returnDeviceId: '',
    returnLayout: 'stereo',
    returnLevel: 1,
    returnDelay: 0,
    returnReverb: 0,
    midiOutputId: '',
    // Off by default: a shared patch must never change someone's pedals unasked. Scenes always recall theirs.
    patchesRecallPedals: 0,
    lastLatencyMs: null,
    // Latency compensation (src/pedals/latency-comp.js): off by default.
    compensate: 0,
    compOffsetMs: 0,
    sampleRate: 'auto',
    guitarNotes: 0,
    guitarMode: 'single',
    guitarTarget: 'sel',
    guitarChannel: 2,
    guitarGateDb: DEFAULT_GATE_DB,
    guitarBends: 1,
    captureSlot: 'A',
    pedals: Object.fromEntries(PEDAL_IDS.map(id => [id, defaultPedalEntry(id)])),
  };
}

export function sanitizeModSlot(id, src) {
  const d = defaultModSlot();
  const s = src && typeof src === 'object' ? src : {};
  // Only a continuous or switch control of this pedal can be modulated.
  const c = typeof s.control === 'string' ? findControl(PEDAL_PROFILES[id], s.control) : null;
  const curve = typeof s.curve === 'string' ? MAP_CURVES.indexOf(s.curve) : num(s.curve, d.curve);
  return {
    source: MOD_SOURCES.some(m => m.id === s.source) ? s.source : '',
    control: c && c.kind !== 'trigger' ? c.id : '',
    min: clamp(num(s.min, d.min), 0, 1),
    max: clamp(num(s.max, d.max), 0, 1),
    curve: Math.round(clamp(curve < 0 ? 0 : curve, 0, MAP_CURVES.length - 1)),
    lfoShape: LFO_SHAPES.includes(s.lfoShape) ? s.lfoShape : d.lfoShape,
    lfoSync: flag(s.lfoSync, d.lfoSync),
    lfoRate: clamp(num(s.lfoRate, d.lfoRate), LFO_RATE_MIN, LFO_RATE_MAX),
    lfoBeats: LFO_BEAT_OPTIONS.some(o => o.value === s.lfoBeats) ? s.lfoBeats : d.lfoBeats,
    lfoDepth: clamp(num(s.lfoDepth, d.lfoDepth), 0, 1),
  };
}

function sanitizePedal(id, src) {
  const base = defaultPedalEntry(id);
  const s = src && typeof src === 'object' ? src : {};
  let mods = Array.isArray(s.mods) ? s.mods : null;
  // Rigs saved before pedal LFOs had one "Follow" mapping: it becomes the first slot.
  if (!mods && (s.followSource || s.followControl)) mods = [{ source: s.followSource, control: s.followControl }];
  return {
    enabled: flag(s.enabled, base.enabled),
    channel: Math.round(clamp(num(s.channel, base.channel), 1, 16)),
    // A slot runs only when both its source and control are chosen; either may be set first.
    mods: Array.from({ length: MOD_SLOTS }, (_, i) => sanitizeModSlot(id, mods && mods[i])),
  };
}

/** Keep only known keys with valid values; fill the rest from the defaults. */
export function sanitizeRig(src) {
  const d = defaultRig();
  if (!src || typeof src !== 'object') return d;
  const pairs = OUTPUT_PAIRS.map(p => p.value);
  return {
    enabled: flag(src.enabled, d.enabled),
    outputDeviceId: str(src.outputDeviceId, d.outputDeviceId) || 'default',
    mainPair: pairs.includes(src.mainPair) ? src.mainPair : d.mainPair,
    sendPair: pairs.includes(src.sendPair) ? src.sendPair : d.sendPair,
    ceilingDb: SEND_CEILINGS.includes(src.ceilingDb) ? src.ceilingDb : d.ceilingDb,
    returnEnabled: flag(src.returnEnabled, d.returnEnabled),
    returnDeviceId: str(src.returnDeviceId, d.returnDeviceId),
    returnLayout: RETURN_LAYOUT_OPTIONS.some(o => o.value === src.returnLayout) ? src.returnLayout : d.returnLayout,
    returnLevel: clamp(num(src.returnLevel, d.returnLevel), 0, 2),
    returnDelay: clamp(num(src.returnDelay, d.returnDelay), 0, 1),
    returnReverb: clamp(num(src.returnReverb, d.returnReverb), 0, 1),
    midiOutputId: str(src.midiOutputId, d.midiOutputId),
    patchesRecallPedals: flag(src.patchesRecallPedals, d.patchesRecallPedals),
    lastLatencyMs: Number.isFinite(src.lastLatencyMs) && src.lastLatencyMs >= 0 && src.lastLatencyMs < 2000 ? src.lastLatencyMs : null,
    compensate: flag(src.compensate, d.compensate),
    compOffsetMs: Math.round(clamp(num(src.compOffsetMs, d.compOffsetMs), COMP_OFFSET_RANGE.min, COMP_OFFSET_RANGE.max) * 10) / 10,
    sampleRate: SAMPLE_RATE_OPTIONS.some(o => o.value === src.sampleRate) ? src.sampleRate : d.sampleRate,
    guitarNotes: flag(src.guitarNotes, d.guitarNotes),
    guitarMode: GUITAR_MODE_OPTIONS.some(o => o.value === src.guitarMode) ? src.guitarMode : d.guitarMode,
    guitarTarget: GUITAR_TARGETS.some(t => t.value === src.guitarTarget) ? src.guitarTarget : d.guitarTarget,
    guitarChannel: GUITAR_CHANNELS.includes(src.guitarChannel) ? src.guitarChannel : d.guitarChannel,
    guitarGateDb: Math.round(clamp(num(src.guitarGateDb, d.guitarGateDb), GATE_MIN_DB, GATE_MAX_DB)),
    guitarBends: flag(src.guitarBends, d.guitarBends),
    captureSlot: CAPTURE_SLOTS.some(t => t.value === src.captureSlot) ? src.captureSlot : d.captureSlot,
    pedals: Object.fromEntries(PEDAL_IDS.map(id => [id, sanitizePedal(id, src.pedals && src.pedals[id])])),
  };
}

export function loadRig(storage = globalThis.localStorage) {
  try {
    const raw = storage && storage.getItem(RIG_KEY);
    return sanitizeRig(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultRig();
  }
}

export function saveRig(rig, storage = globalThis.localStorage) {
  try { if (storage) storage.setItem(RIG_KEY, JSON.stringify(sanitizeRig(rig))); } catch { /* storage full or blocked */ }
}

/** The sampleRate to ask createEngine for: undefined for 'auto' (the browser's choice). */
export function contextSampleRate(rig) {
  const v = rig && rig.sampleRate;
  return v === 44100 || v === 48000 ? v : undefined;
}

/**
 * Read the saved sample-rate choice before the engine starts (main.js). Never
 * throws; anything unreadable means 'auto'.
 */
export function savedContextSampleRate(storage = globalThis.localStorage) {
  return contextSampleRate(loadRig(storage));
}

/** 0-based channels of an output pair. */
export function pairChannels(first) {
  return [first, first + 1];
}
