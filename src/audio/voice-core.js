// Voice input (v1.4): the pure half. Settings that belong to the computer
// (which microphone, gain, monitoring, the optional processing), the
// getUserMedia constraints, the "should we monitor by default" rule for a
// laptop's built-in microphone and speakers, the input meter maths and the
// plain-language messages for permission and device problems. No Web Audio
// here, so Node tests can prove all of it; src/audio/voice-host.js builds the
// graph and src/ui/voice-rig.js ties it to the app.
//
// Like the pedal rig, these settings live in localStorage['orograph.voice'] and
// never in sessions, scenes or patches: a song should not switch a microphone on.

import { dbToGain, gainToDb } from '../pedals/signal.js';
import { DEFAULT_GATE_DB, GATE_MIN_DB, GATE_MAX_DB } from '../pedals/guitar-notes.js';
import { MAX_PARTS } from '../core/params.js';

export const VOICE_KEY = 'orograph.voice';
/** Note source tag of Voice plays notes (the router, MIDI echo and Layer mode see it like 'guitar'). */
export const VOICE_SOURCE = 'voice';

export const INPUT_GAIN_MIN_DB = -12;
export const INPUT_GAIN_MAX_DB = 36;
export const VOICE_LEVEL_MAX = 2;
export const MONITOR_MODES = Object.freeze(['auto', 'on', 'off']);
export const MONITOR_OPTIONS = Object.freeze([
  Object.freeze({ value: 'auto', label: 'Auto' }),
  Object.freeze({ value: 'on', label: 'On' }),
  Object.freeze({ value: 'off', label: 'Off' }),
]);
export const CHANNEL_MODES = Object.freeze(['mono', 'stereo']);
export const CHANNEL_OPTIONS = Object.freeze([
  Object.freeze({ value: 'mono', label: 'Mono' }),
  Object.freeze({ value: 'stereo', label: 'Stereo' }),
]);
export const VOICE_CAPTURE_SLOTS = Object.freeze([Object.freeze({ value: 'A', label: 'Slot A' }), Object.freeze({ value: 'B', label: 'Slot B' })]);
/** Voice plays notes: louder default gate than the guitar, a room is noisier than a DI. */
export const VOICE_GATE_DB = -45;
export { GATE_MIN_DB as VOICE_GATE_MIN_DB, GATE_MAX_DB as VOICE_GATE_MAX_DB };

// ---------------------------------------------------------------- processing

/** Rumble filter: 80 Hz, 12 dB/octave (Butterworth). */
export const HIGHPASS = Object.freeze({ frequency: 80, Q: Math.SQRT1_2 });
/** A gentle vocal compressor: about 3 to 4 dB of gain reduction on a normal phrase. */
export const COMPRESSOR = Object.freeze({ threshold: -20, knee: 12, ratio: 2.5, attack: 0.006, release: 0.18, makeupDb: 3 });
/**
 * De-esser: the band above `crossover` (Linkwitz-Riley, 24 dB/octave, so the
 * two bands sum flat) goes through a fast compressor. The low band waits
 * `lowDelay` seconds, the look-ahead of the browsers' DynamicsCompressorNode,
 * so the bands stay in step.
 */
export const DEESSER = Object.freeze({ crossover: 5500, threshold: -32, knee: 6, ratio: 6, attack: 0.001, release: 0.06, lowDelay: 0.006 });
/** Pitch tracker range and steadiness for singing and humming (src/pedals/pitch.js). */
export const VOICE_TRACKER = Object.freeze({ minFreq: 70, maxFreq: 1100, clarityThreshold: 0.85, hysteresisCents: 45 });
/**
 * Feedback guard tuned for a voice (src/pedals/pedal-loop.js createFeedbackDetector).
 * A sung note wobbles (vibrato, breath) where a howl is a steady sine, so the
 * steadiness bars are higher and the hold times longer than for the pedal return.
 */
export const VOICE_GUARD = Object.freeze({
  thresholdDb: -12, holdMs: 600, clarityMin: 0.975,
  quietThresholdDb: -30, quietHoldMs: 2500, quietClarityMin: 0.99,
  riseWindowMs: 400, riseStepDb: 1.5, riseFloorDb: -50, clipDb: -0.3, clipMs: 400,
  howlSpreadCents: 10,
});

// ---------------------------------------------------------------- settings

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const flag = (v, d) => (v === true || v === 1 ? 1 : v === false || v === 0 ? 0 : d);
const str = (v, d) => (typeof v === 'string' ? v.slice(0, 300) : d);

/** Voice plays notes / Capture target: 'sel' or a track index. */
export function voiceTargets(numParts = MAX_PARTS) {
  return [{ value: 'sel', label: 'Selected track' }, ...Array.from({ length: numParts }, (_, p) => ({ value: p, label: `Track ${p + 1}` }))];
}

export function defaultVoicePrefs() {
  return {
    enabled: 0,
    deviceId: '',
    cleanup: 0,             // Mic Cleanup: the browser's noise suppression and echo cancellation
    channels: 'mono',
    inputGainDb: 0,
    monitor: 'auto',
    highpass: 0,
    compressor: 0,
    deesser: 0,
    level: 1,
    pan: 0,
    delay: 0,
    reverb: 0,
    notes: 0,
    target: 'sel',
    gateDb: VOICE_GATE_DB,
    bends: 1,
    captureSlot: 'A',
  };
}

export function sanitizeVoicePrefs(src, { numParts = MAX_PARTS } = {}) {
  const d = defaultVoicePrefs();
  if (!src || typeof src !== 'object') return d;
  const t = src.target;
  const target = t === 'sel' ? 'sel' : (Number.isInteger(t) && t >= 0 && t < numParts ? t : d.target);
  return {
    enabled: flag(src.enabled, d.enabled),
    deviceId: str(src.deviceId, d.deviceId),
    cleanup: flag(src.cleanup, d.cleanup),
    channels: CHANNEL_MODES.includes(src.channels) ? src.channels : d.channels,
    inputGainDb: Math.round(clamp(num(src.inputGainDb, d.inputGainDb), INPUT_GAIN_MIN_DB, INPUT_GAIN_MAX_DB) * 2) / 2,
    monitor: MONITOR_MODES.includes(src.monitor) ? src.monitor : d.monitor,
    highpass: flag(src.highpass, d.highpass),
    compressor: flag(src.compressor, d.compressor),
    deesser: flag(src.deesser, d.deesser),
    level: clamp(num(src.level, d.level), 0, VOICE_LEVEL_MAX),
    pan: clamp(num(src.pan, d.pan), -1, 1),
    delay: clamp(num(src.delay, d.delay), 0, 1),
    reverb: clamp(num(src.reverb, d.reverb), 0, 1),
    notes: flag(src.notes, d.notes),
    target,
    gateDb: Math.round(clamp(num(src.gateDb, d.gateDb), GATE_MIN_DB, GATE_MAX_DB)),
    bends: flag(src.bends, d.bends),
    captureSlot: src.captureSlot === 'B' ? 'B' : 'A',
  };
}

export function loadVoicePrefs(storage = globalThis.localStorage, opts) {
  try {
    const raw = storage && storage.getItem(VOICE_KEY);
    return sanitizeVoicePrefs(raw ? JSON.parse(raw) : null, opts);
  } catch {
    return defaultVoicePrefs();
  }
}

export function saveVoicePrefs(prefs, storage = globalThis.localStorage, opts) {
  try { if (storage) storage.setItem(VOICE_KEY, JSON.stringify(sanitizeVoicePrefs(prefs, opts))); } catch { /* storage full or blocked */ }
}

// ---------------------------------------------------------------- constraints

/**
 * getUserMedia constraints for the voice. By default every voice-call process
 * is off (echo cancellation, noise suppression, auto gain), which is what a
 * singer wants: the browser's processing pumps, gates breaths and dulls the top
 * end. Mic Cleanup (cleanup) turns noise suppression and echo cancellation on
 * for people singing into a laptop with its speakers playing; auto gain stays
 * off either way, because it fights the input gain and the compressor.
 * The rate asked for is the audio context's (48 kHz when unknown), so the
 * browser does not resample; 24-bit is asked for where the device offers it.
 * Everything is `ideal`, so a device that cannot do it still opens.
 */
export function voiceConstraints({ deviceId = '', cleanup = false, channels = 'mono', sampleRate = 0 } = {}) {
  const on = !!cleanup;
  const audio = {
    echoCancellation: on,
    noiseSuppression: on,
    autoGainControl: false,
    channelCount: { ideal: channels === 'stereo' ? 2 : 1 },
    sampleRate: { ideal: sampleRate > 0 ? sampleRate : 48000 },
    sampleSize: { ideal: 24 },
    latency: { ideal: 0 },
  };
  if (deviceId && deviceId !== 'default') audio.deviceId = { exact: deviceId };
  return { audio, video: false };
}

/**
 * What the browser actually gave (track.getSettings()) against what was asked:
 * plain-language warnings, none when it matches.
 */
export function settingsWarnings(settings, { cleanup = false, sampleRate = 0 } = {}) {
  const s = settings || {};
  const out = [];
  if (!cleanup) {
    if (s.echoCancellation === true) out.push('The browser kept echo cancellation on, which can make the voice sound thin.');
    if (s.noiseSuppression === true) out.push('The browser kept noise suppression on, which can cut off quiet notes and breaths.');
  }
  if (s.autoGainControl === true) out.push('The browser kept auto gain on, so the level will move by itself.');
  if (s.sampleRate && sampleRate && s.sampleRate !== sampleRate) {
    out.push(`The microphone runs at ${s.sampleRate} Hz and Oro at ${sampleRate} Hz, so the browser resamples it.`);
  }
  return out;
}

// ---------------------------------------------------------------- monitoring default

const cleanLabel = (l) => String(l || '').replace(/^(default|communications)\s*-\s*/i, '').trim();

const RX_HEADPHONES = /head ?phones?|headset|ear ?phones?|ear ?buds?|airpods|\bbuds\b|in-?ear|\bbeats\b|wh-1000|bose (qc|quiet)/i;
const RX_INTERFACE = /\busb\b|interface|scarlett|focusrite|\bmotu\b|audient|\bevo\b|universal audio|apollo|\bvolt\b|steinberg|\bur\d{2}|presonus|behringer|\bumc\d|\bzoom\b|tascam|roland|\brme\b|babyface|fireface|\bssl\b|\bmpc\b|apogee|arturia|native instruments|komplete|\baudio ?box\b|\bshure mv|rode|yeti|blue snowball|at2020/i;
const RX_BUILTIN_IN = /built-?in|internal|macbook|imac|\bmac ?(mini|studio)\b|laptop|microphone array|mic array|integrated|realtek|intel.*(smart sound|sst)|conexant|\bsof\b|pch|sound blaster/i;
const RX_SPEAKERS = /speakers?|built-?in output|internal|macbook|imac|laptop|realtek|display audio|\bhdmi\b|displayport|\bmonitor\b|\btv\b|sound bar|soundbar/i;

/** 'builtin' | 'headset' | 'external' | 'unknown' for an input label (enumerateDevices). */
export function classifyInput(label) {
  const l = cleanLabel(label);
  if (!l) return 'unknown';
  if (RX_HEADPHONES.test(l)) return 'headset';
  if (RX_INTERFACE.test(l)) return 'external';
  if (RX_BUILTIN_IN.test(l)) return 'builtin';
  return 'unknown';
}

/** 'headphones' | 'interface' | 'speakers' | 'unknown' for an output label. */
export function classifyOutput(label) {
  const l = cleanLabel(label);
  if (!l) return 'unknown';
  if (RX_HEADPHONES.test(l)) return 'headphones';
  if (RX_INTERFACE.test(l)) return 'interface';
  if (RX_SPEAKERS.test(l)) return 'speakers';
  return 'unknown';
}

export const HEADPHONES_HINT = 'Use headphones to avoid feedback: a microphone near speakers hears itself and starts to howl.';

/**
 * Monitor default (Monitor: Auto). Hearing yourself is only safe when the
 * sound cannot reach the microphone: on with headphones or an audio
 * interface, off with speakers (a laptop's own speakers and microphone above
 * all) and off when the devices are unknown (names stay hidden until the
 * browser may use the microphone). The feedback guard stays armed either way.
 * @returns {{on: boolean, reason: 'headphones'|'interface'|'speakers'|'unknown', input: string, output: string, hint: string|null}}
 */
export function monitorDefault({ inputLabel = '', outputLabel = '' } = {}) {
  const input = classifyInput(inputLabel);
  const output = classifyOutput(outputLabel);
  if (output === 'headphones') return { on: true, reason: 'headphones', input, output, hint: null };
  if (output === 'interface') return { on: true, reason: 'interface', input, output, hint: 'Monitoring is on because the output looks like an audio interface. If it drives speakers in the same room, use headphones or turn Monitor off.' };
  if (output === 'speakers') {
    const both = input === 'builtin';
    return { on: false, reason: 'speakers', input, output, hint: both ? `Monitoring is off because the built-in microphone would hear the built-in speakers. ${HEADPHONES_HINT}` : `Monitoring is off because the output looks like speakers. ${HEADPHONES_HINT}` };
  }
  return { on: false, reason: 'unknown', input, output, hint: `Monitoring is off until Oro knows the output is headphones. ${HEADPHONES_HINT}` };
}

/** Monitor setting ('auto' | 'on' | 'off') + the devices -> whether the voice is heard. */
export function resolveMonitor(mode, devices = {}) {
  const auto = monitorDefault(devices);
  if (mode === 'on') return { ...auto, on: true, auto: false, hint: auto.on ? null : HEADPHONES_HINT };
  if (mode === 'off') return { ...auto, on: false, auto: false, hint: null };
  return { ...auto, auto: true };
}

// ---------------------------------------------------------------- meter

/** dBFS where the converter (or the system's own input gain) is clipping. */
export const INPUT_CLIP_DB = -0.1;
/** How long the clip light stays on after an over. */
export const CLIP_HOLD_MS = 1500;

/**
 * One meter reading from the raw input peak (0..1+ linear, before the input
 * gain) and the input gain in dB. `input` = the microphone itself clipped
 * (lower the level in the system's sound settings or on the interface);
 * `gain` = Oro's input gain pushed it over full scale.
 */
export function meterReading(rawPeak, gainDb) {
  const raw = Math.abs(num(rawPeak, 0));
  const g = dbToGain(clamp(num(gainDb, 0), INPUT_GAIN_MIN_DB, INPUT_GAIN_MAX_DB));
  const post = raw * g;
  const rawDb = gainToDb(raw);
  const peakDb = gainToDb(post);
  const clip = rawDb >= INPUT_CLIP_DB ? 'input' : post >= 1 ? 'gain' : null;
  // Meter position: -60..0 dBFS mapped to 0..1.
  const pos = clamp((peakDb + 60) / 60, 0, 1);
  return { rawDb, peakDb, pos, clip };
}

/** Clip light with a hold: feed it readings, it says whether to light and why. */
export function createClipLight({ holdMs = CLIP_HOLD_MS } = {}) {
  let until = -Infinity, kind = null;
  return {
    update(reading, now) {
      if (reading && reading.clip) { until = now + holdMs; if (kind !== 'input') kind = reading.clip; }
      if (now >= until) kind = null;
      return { on: now < until, kind };
    },
    reset() { until = -Infinity; kind = null; },
  };
}

// ---------------------------------------------------------------- messages

export const MIC_WHY = 'Oro uses the microphone only while Voice is enabled: to let you hear yourself with the synth, loop your vocals, play a track by singing or humming, capture a sung note as a terrain, and let your voice move the terrain. The sound stays on this computer and is only recorded when you record or loop it.';

/** A refused or failed getUserMedia -> what to tell the person. */
export function voiceErrorReason(err, { electron = false, mac = false } = {}) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    if (electron && mac) return 'macOS is blocking the microphone for Oro. Allow it in System Settings > Privacy & Security > Microphone, then press Try again.';
    if (electron) return 'The system is blocking the microphone for Oro. Allow microphone access in your system privacy settings, then press Try again.';
    return 'Microphone access is blocked for this page. Allow it in the browser (the icon at the left of the address bar, or the site settings), then press Try again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No microphone was found. Plug one in, or check that the computer\'s microphone is switched on, then press Try again.';
  if (name === 'OverconstrainedError') return 'That microphone is not connected any more. Pick another input or plug it back in.';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'Another app is using the microphone, or the system blocked it. Close the other app and press Try again.';
  return `The microphone could not be opened (${(err && err.message) || err || 'unknown error'}).`;
}

export const NO_CAPTURE_REASON = 'This browser cannot use a microphone here. Oro needs a secure page (https or localhost) or the desktop app for Voice.';
