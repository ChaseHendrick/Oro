// Per-device settings of the pedal rig (v1.1): which outputs carry the main mix
// and the pedal send, the send ceiling, the pedal return, and which MIDI pedal
// profiles are switched on, on which channel. Like the audio quality these
// belong to the computer and the cables, not to a song, so they live in
// localStorage['orograph.pedals'] and never in sessions, scenes or patches.

import { PEDAL_PROFILES, PEDAL_IDS, findControl } from './profiles.js';
import { PEDAL_SOURCES } from './pedal-midi.js';
import { DEFAULT_GATE_DB, GATE_MIN_DB, GATE_MAX_DB } from './guitar-notes.js';

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
/** Guitar plays notes: which part. 'sel' follows the selected part (and Layer key mode). */
export const GUITAR_TARGETS = Object.freeze([
  Object.freeze({ value: 'sel', label: 'Selected part' }),
  ...[0, 1, 2, 3].map(p => Object.freeze({ value: p, label: `Part ${p + 1}` })),
]);
/** Guitar input channel, 1-based as on the interface. */
export const GUITAR_CHANNELS = Object.freeze([1, 2]);
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

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const flag = (v, d) => (v === 0 || v === 1 ? v : typeof v === 'boolean' ? (v ? 1 : 0) : d);
const str = (v, d, max = 200) => (typeof v === 'string' ? v.slice(0, max) : d);

export function defaultPedalEntry(id) {
  const p = PEDAL_PROFILES[id];
  return { enabled: 0, channel: p ? p.channel : 1, followSource: '', followControl: '' };
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
    lastLatencyMs: null,
    // Latency compensation (src/pedals/latency-comp.js): off by default.
    compensate: 0,
    compOffsetMs: 0,
    sampleRate: 'auto',
    guitarNotes: 0,
    guitarTarget: 'sel',
    guitarChannel: 2,
    guitarGateDb: DEFAULT_GATE_DB,
    guitarBends: 1,
    captureSlot: 'A',
    pedals: Object.fromEntries(PEDAL_IDS.map(id => [id, defaultPedalEntry(id)])),
  };
}

function sanitizePedal(id, src) {
  const base = defaultPedalEntry(id);
  const s = src && typeof src === 'object' ? src : {};
  const out = {
    enabled: flag(s.enabled, base.enabled),
    channel: Math.round(clamp(num(s.channel, base.channel), 1, 16)),
    followSource: FOLLOW_SOURCES.some(f => f.id === s.followSource) ? s.followSource : '',
    followControl: '',
  };
  // Only a continuous or switch control of this pedal can follow a source.
  const c = typeof s.followControl === 'string' ? findControl(PEDAL_PROFILES[id], s.followControl) : null;
  if (c && c.kind !== 'trigger') out.followControl = c.id;
  // A follow mapping runs only when both halves are chosen; either may be set first.
  return out;
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
    lastLatencyMs: Number.isFinite(src.lastLatencyMs) && src.lastLatencyMs >= 0 && src.lastLatencyMs < 2000 ? src.lastLatencyMs : null,
    compensate: flag(src.compensate, d.compensate),
    compOffsetMs: Math.round(clamp(num(src.compOffsetMs, d.compOffsetMs), COMP_OFFSET_RANGE.min, COMP_OFFSET_RANGE.max) * 10) / 10,
    sampleRate: SAMPLE_RATE_OPTIONS.some(o => o.value === src.sampleRate) ? src.sampleRate : d.sampleRate,
    guitarNotes: flag(src.guitarNotes, d.guitarNotes),
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
