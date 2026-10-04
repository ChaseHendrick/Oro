// Voice input (v1.4), engine side: a microphone channel mixed into the master
// so it is heard, looped and resampled like everything else.
//
//   getUserMedia (voice-call processing off unless Mic Cleanup)
//     -> [mono: input channel 1 only] -> input gain
//     -> high-pass 80 Hz -> compressor -> de-esser     (each optional, off by default)
//     -> level -> pan -> guard mute ─┬─> heard (Monitor) ─┬─> master (effects' dry bus)
//                                    │                    ├─> delay send
//                                    │                    └─> reverb send
//                                    └─> loop only (1 - Monitor) -> looper input
//   raw input -> meter (peak, clip light)
//   after input gain, mono -> pitch tracker + envelope (Voice plays notes,
//     Voice Level link source, events 'voiceNote' / 'level') and Capture
//
// Nothing here connects to anything that leads back into the microphone
// path: the voice only feeds the master, the effect sends and the looper
// input, never the pedal send. The feedback guard (src/pedals/pedal-loop.js,
// tuned by VOICE_GUARD) watches the voice after level and pan and is armed
// whenever the microphone is open, whether or not Monitor is on. With Monitor
// off the voice is not heard but still reaches the looper, so a laptop can
// record vocals without the speakers feeding them back.
//
// Every failure (no getUserMedia, a refused permission, no microphone)
// comes back as a plain-language reason in status(); the synth carries on.
// Written against injectable `deps` so tests can run it on a fake context.

import { attachFeedbackGuard, createCapture, listAudioInputs } from '../pedals/pedal-loop.js';
import { createGuitarInput } from '../pedals/guitar.js';
import { createEmitter } from './emitter.js';
import {
  voiceConstraints, settingsWarnings, voiceErrorReason, meterReading, createClipLight, NO_CAPTURE_REASON,
  HIGHPASS, COMPRESSOR, DEESSER, VOICE_TRACKER, VOICE_GUARD, CHANNEL_MODES, INPUT_GAIN_MIN_DB, INPUT_GAIN_MAX_DB, VOICE_LEVEL_MAX,
  VOICE_GATE_DB,
} from './voice-core.js';
import { dbToGain } from '../pedals/signal.js';

export const VOICE_CAPTURE_SECONDS = 3;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function isElectron() { return typeof navigator !== 'undefined' && /Electron\//.test(navigator.userAgent || ''); }
function isMac() { return typeof navigator !== 'undefined' && /Mac/.test((navigator.platform || '') + (navigator.userAgent || '')); }

async function defaultOpenMic(constraints) {
  const md = typeof navigator !== 'undefined' && navigator.mediaDevices;
  return md.getUserMedia(constraints);
}

const defaultDeps = {
  openMic: defaultOpenMic,
  attachFeedbackGuard, createCapture, listAudioInputs, createGuitarInput,
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  loadPedalWorklets: (ctx) => import('../pedals/worklet-loader.js').then(m => m.loadPedalWorklets(ctx)).catch(() => ({ ok: false })),
  hasGetUserMedia: () => typeof navigator !== 'undefined' && !!navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function',
  platform: () => ({ electron: isElectron(), mac: isMac() }),
};

/**
 * @param {BaseAudioContext} ctx
 * @param {object} o
 * @param {AudioNode} o.masterIn  the effects' dry bus (where the voice is heard)
 * @param {AudioNode} [o.delayIn] delay send input
 * @param {AudioNode} [o.reverbIn] reverb send input
 * @param {AudioNode} [o.loopIn]  the looper's input: carries the voice while Monitor is off
 * @param {(msg: object) => void} [o.post] DSP messages: {t: 'voiceLevel', v} (Voice Level link source)
 * @param {object} [o.deps] replacements (tests)
 */
export function createVoiceHost(ctx, { masterIn, delayIn = null, reverbIn = null, loopIn = null, post = () => {}, deps: overrides = {} } = {}) {
  if (!ctx || !masterIn) throw new Error('createVoiceHost needs a context and the master input');
  const deps = { ...defaultDeps, ...overrides };
  const events = createEmitter();
  const stereo = (node) => { node.channelCount = 2; node.channelCountMode = 'explicit'; node.channelInterpretation = 'speakers'; return node; };
  const mono = (node) => { node.channelCount = 1; node.channelCountMode = 'explicit'; node.channelInterpretation = 'speakers'; return node; };
  const gain = (v, shape = stereo) => { const g = shape(ctx.createGain()); g.gain.value = v; return g; };
  const glide = (param, v, tau = 0.015) => {
    try { param.cancelScheduledValues(ctx.currentTime); param.setTargetAtTime(v, ctx.currentTime, tau); } catch { param.value = v; }
  };

  // ---- graph (built once; silent until the microphone opens)
  const inGain = gain(1);
  const chainNodes = [];
  /** An optional stage: input -> dry -> output, input -> process -> wet -> output; on/off crossfades. */
  function stage(build) {
    const input = gain(1), output = gain(1), dry = gain(1), wet = gain(0);
    const { first, last, nodes } = build();
    input.connect(dry); dry.connect(output);
    input.connect(first); last.connect(wet); wet.connect(output);
    chainNodes.push(input, output, dry, wet, ...nodes);
    let on = false;
    return {
      input, output, dry, wet, nodes,
      get on() { return on; },
      set(v) { on = !!v; glide(dry.gain, on ? 0 : 1); glide(wet.gain, on ? 1 : 0); },
    };
  }
  const has = (m) => typeof ctx[m] === 'function';
  const hp = stage(() => {
    if (!has('createBiquadFilter')) { const g = gain(1); return { first: g, last: g, nodes: [g] }; }
    const f = stereo(ctx.createBiquadFilter());
    f.type = 'highpass'; f.frequency.value = HIGHPASS.frequency; f.Q.value = HIGHPASS.Q;
    return { first: f, last: f, nodes: [f] };
  });
  const comp = stage(() => {
    if (!has('createDynamicsCompressor')) { const g = gain(1); return { first: g, last: g, nodes: [g] }; }
    const c = stereo(ctx.createDynamicsCompressor());
    c.threshold.value = COMPRESSOR.threshold; c.knee.value = COMPRESSOR.knee; c.ratio.value = COMPRESSOR.ratio;
    c.attack.value = COMPRESSOR.attack; c.release.value = COMPRESSOR.release;
    const makeup = gain(dbToGain(COMPRESSOR.makeupDb));
    c.connect(makeup);
    return { first: c, last: makeup, nodes: [c, makeup] };
  });
  const deess = stage(() => {
    if (!has('createDynamicsCompressor') || !has('createBiquadFilter') || !has('createDelay')) { const g = gain(1); return { first: g, last: g, nodes: [g] }; }
    const split = gain(1), sum = gain(1);
    const bq = (type) => { const f = stereo(ctx.createBiquadFilter()); f.type = type; f.frequency.value = DEESSER.crossover; f.Q.value = Math.SQRT1_2; return f; };
    const lp1 = bq('lowpass'), lp2 = bq('lowpass'), hp1 = bq('highpass'), hp2 = bq('highpass');
    const lowDelay = stereo(ctx.createDelay(0.05));
    lowDelay.delayTime.value = DEESSER.lowDelay;
    const c = stereo(ctx.createDynamicsCompressor());
    c.threshold.value = DEESSER.threshold; c.knee.value = DEESSER.knee; c.ratio.value = DEESSER.ratio;
    c.attack.value = DEESSER.attack; c.release.value = DEESSER.release;
    split.connect(lp1); lp1.connect(lp2); lp2.connect(lowDelay); lowDelay.connect(sum);
    split.connect(hp1); hp1.connect(hp2); hp2.connect(c); c.connect(sum);
    return { first: split, last: sum, nodes: [split, sum, lp1, lp2, hp1, hp2, lowDelay, c] };
  });
  inGain.connect(hp.input);
  hp.output.connect(comp.input);
  comp.output.connect(deess.input);

  const level = gain(1);
  const panner = has('createStereoPanner') ? stereo(ctx.createStereoPanner()) : gain(1);
  const guardMute = gain(1);
  const heard = gain(0);
  const loopOnly = gain(0);
  const delaySend = gain(0);
  const reverbSend = gain(0);
  deess.output.connect(level);
  level.connect(panner);
  panner.connect(guardMute);
  guardMute.connect(heard);
  heard.connect(masterIn);
  heard.connect(delaySend);
  heard.connect(reverbSend);
  if (delayIn) delaySend.connect(delayIn);
  if (reverbIn) reverbSend.connect(reverbIn);
  if (loopIn) { guardMute.connect(loopOnly); loopOnly.connect(loopIn); }
  // Mono tap for the tracker and Capture: after the input gain, before the processing.
  const tap = gain(1, mono);
  inGain.connect(tap);

  const cfg = {
    enabled: false, deviceId: '', cleanup: false, channels: 'mono', inputGainDb: 0, monitor: false,
    highpass: false, compressor: false, deesser: false, level: 1, pan: 0, delay: 0, reverb: 0,
    tracker: { ...VOICE_TRACKER, gateDb: VOICE_GATE_DB, bendRange: 2 },
  };
  let disposed = false;
  let mic = null;            // { stream, source, track, owned: AudioNode[], meters: AnalyserNode[] }
  let info = { open: false, reason: null, warnings: [], settings: null, label: '' };
  let guard = null, guardTrip = null;
  let tracker = null, trackerOffs = [];
  let voiceLevel = 0, voiceSent = 0;
  let capturing = null;
  let feed = null;
  let queue = Promise.resolve();
  const clip = createClipLight();
  let meterBuf = null;

  const changed = () => { if (!disposed) events.emit('change', status()); };

  function postLevel(v) {
    if (Math.abs(v - voiceSent) < 0.002 && !(v === 0 && voiceSent !== 0)) return;
    voiceSent = v;
    post({ t: 'voiceLevel', v });
  }

  function applyGains() {
    glide(inGain.gain, dbToGain(cfg.inputGainDb));
    hp.set(cfg.highpass);
    comp.set(cfg.compressor);
    deess.set(cfg.deesser);
    glide(level.gain, cfg.level);
    if (panner.pan) glide(panner.pan, cfg.pan);
    glide(delaySend.gain, cfg.delay);
    glide(reverbSend.gain, cfg.reverb);
    const open = !!mic;
    glide(heard.gain, open && cfg.monitor ? 1 : 0);
    glide(loopOnly.gain, open && !cfg.monitor ? 1 : 0);
  }

  // ---------------------------------------------------------------- open / close

  function stopFeed() {
    if (!feed) return;
    try { tap.disconnect(feed.sp); } catch { /* already gone */ }
    try { feed.sp.disconnect(); } catch { /* already gone */ }
    try { feed.sink.disconnect(); } catch { /* already gone */ }
    feed.sp.onaudioprocess = null;
    feed = null;
  }

  /** Copy the mic, after the input gain, into the synth for the vocoder. The copy is silent, so it does not double the voice in the master. */
  function startFeed() {
    if (feed || !mic || typeof ctx.createScriptProcessor !== 'function') return;
    let sp;
    try { sp = ctx.createScriptProcessor(256, 1, 1); } catch { return; }
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sp.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const copy = new Float32Array(input.length);
      copy.set(input);
      e.outputBuffer.getChannelData(0).fill(0);
      post({ t: 'voicePcm', pcm: copy });
    };
    try {
      tap.connect(sp);
      sp.connect(sink);
      sink.connect(masterIn);
      feed = { sp, sink };
    } catch {
      try { sp.disconnect(); } catch { /* ignore */ }
      try { sink.disconnect(); } catch { /* ignore */ }
      sp.onaudioprocess = null;
    }
  }

  function closeTracker() {
    for (const off of trackerOffs) { try { off(); } catch { /* ignore */ } }
    trackerOffs = [];
    if (tracker) { try { tracker.dispose(); } catch { /* ignore */ } tracker = null; events.emit('voiceNote', { type: 'stop' }); }
    voiceLevel = 0;
    postLevel(0);
  }

  function closeMic(reason = null) {
    stopFeed();
    closeTracker();
    if (guard) { try { guard.dispose(); } catch { /* ignore */ } guard = null; }
    guardTrip = null;
    if (mic) {
      for (const n of mic.owned) { try { n.disconnect(); } catch { /* ignore */ } }
      if (mic.track) mic.track.onended = null;
      if (mic.stream && typeof mic.stream.getTracks === 'function') for (const t of mic.stream.getTracks()) { try { t.stop(); } catch { /* ignore */ } }
      mic = null;
    }
    try { guardMute.gain.cancelScheduledValues(ctx.currentTime); } catch { /* ignore */ }
    guardMute.gain.value = 1;
    clip.reset();
    info = { ...info, open: false, reason, settings: null };
    applyGains();
  }

  async function openMicNow() {
    const constraints = voiceConstraints({ deviceId: cfg.deviceId, cleanup: cfg.cleanup, channels: cfg.channels, sampleRate: ctx.sampleRate });
    let stream;
    try {
      stream = await deps.openMic(constraints);
    } catch (err) {
      info = { open: false, reason: voiceErrorReason(err, deps.platform()), warnings: [], settings: null, label: '', error: err && err.name };
      return;
    }
    if (disposed || !cfg.enabled) { for (const t of (stream && stream.getTracks ? stream.getTracks() : [])) { try { t.stop(); } catch { /* ignore */ } } return; }
    const track = stream && typeof stream.getAudioTracks === 'function' ? stream.getAudioTracks()[0] : null;
    if (!track) {
      info = { open: false, reason: voiceErrorReason({ name: 'NotFoundError' }), warnings: [], settings: null, label: '' };
      return;
    }
    const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
    const source = ctx.createMediaStreamSource(stream);
    const owned = [source];
    const meters = [];
    const meter = () => { const a = ctx.createAnalyser(); a.fftSize = 1024; meters.push(a); owned.push(a); return a; };
    if (cfg.channels === 'mono' && typeof ctx.createChannelSplitter === 'function') {
      // Mono: input channel 1 only (an interface's first input, or either side of a laptop's array mic).
      const split = ctx.createChannelSplitter(2);
      const one = gain(1, mono);
      source.connect(split);
      split.connect(one, 0);
      one.connect(inGain);
      split.connect(meter(), 0);
      owned.push(split, one);
    } else {
      source.connect(inGain);
      if (typeof ctx.createChannelSplitter === 'function') {
        const split = ctx.createChannelSplitter(2);
        source.connect(split);
        split.connect(meter(), 0);
        split.connect(meter(), 1);
        owned.push(split);
      } else source.connect(meter());
    }
    mic = { stream, source, track, owned, meters };
    track.onended = () => {
      if (!mic || mic.track !== track) return;
      closeMic('The microphone was disconnected. Plug it back in or pick another input, then press Try again.');
      changed();
    };
    info = { open: true, reason: null, warnings: settingsWarnings(settings, { cleanup: cfg.cleanup, sampleRate: ctx.sampleRate }), settings, label: track.label || '' };
    try {
      guard = deps.attachFeedbackGuard(ctx, {
        input: panner, gain: guardMute, ...VOICE_GUARD,
        onTrip: (st) => { guardTrip = { kind: st.kind }; changed(); },
      });
    } catch (err) {
      guard = null;
      info.warnings = [...info.warnings, `The feedback guard could not start (${(err && err.message) || err}). Use headphones and keep Monitor off with speakers.`];
    }
    applyGains();
    startFeed();
    await startTracker();
  }

  async function startTracker() {
    if (!mic || tracker) return;
    try {
      await deps.loadPedalWorklets(ctx);
      if (!mic || disposed || tracker) return;
      tracker = deps.createGuitarInput(ctx, tap, { tracker: { ...cfg.tracker } });
    } catch (err) {
      tracker = null;
      info.warnings = [...info.warnings, `Voice tracking could not start (${(err && err.message) || err}).`];
      return;
    }
    trackerOffs.push(tracker.on('level', (e) => {
      voiceLevel = clamp(num(e && e.value, 0), 0, 1);
      postLevel(voiceLevel);
      events.emit('level', { level: voiceLevel, db: e && e.db });
    }));
    for (const type of ['noteOn', 'noteOff', 'bend', 'level', 'pitch']) {
      trackerOffs.push(tracker.on(type, (e) => events.emit('voiceNote', { ...e, type })));
    }
    trackerOffs = trackerOffs.filter(f => typeof f === 'function');
  }

  /**
   * Voice settings (any subset). enabled / deviceId / cleanup / channels
   * reopen the microphone; everything else only moves gains. Never throws:
   * a failure lands in status().reason. Calls are queued, so quick changes
   * never open two microphones at once.
   */
  function set(o = {}) {
    const run = queue.then(async () => {
      if (disposed) return status();
      const before = { enabled: cfg.enabled, deviceId: cfg.deviceId, cleanup: cfg.cleanup, channels: cfg.channels };
      if (o.enabled != null) cfg.enabled = !!o.enabled;
      if (o.deviceId != null) cfg.deviceId = String(o.deviceId);
      if (o.cleanup != null) cfg.cleanup = !!o.cleanup;
      if (o.channels != null && CHANNEL_MODES.includes(o.channels)) cfg.channels = o.channels;
      if (o.inputGainDb != null) cfg.inputGainDb = clamp(num(Number(o.inputGainDb), 0), INPUT_GAIN_MIN_DB, INPUT_GAIN_MAX_DB);
      if (o.monitor != null) cfg.monitor = !!o.monitor;
      for (const k of ['highpass', 'compressor', 'deesser']) if (o[k] != null) cfg[k] = !!o[k];
      if (o.level != null) cfg.level = clamp(num(Number(o.level), 1), 0, VOICE_LEVEL_MAX);
      if (o.pan != null) cfg.pan = clamp(num(Number(o.pan), 0), -1, 1);
      if (o.delay != null) cfg.delay = clamp(num(Number(o.delay), 0), 0, 1);
      if (o.reverb != null) cfg.reverb = clamp(num(Number(o.reverb), 0), 0, 1);
      if (o.gateDb != null && Number.isFinite(Number(o.gateDb))) cfg.tracker.gateDb = clamp(Number(o.gateDb), -90, 0);
      if (o.bendRange != null && Number.isFinite(Number(o.bendRange))) cfg.tracker.bendRange = clamp(Number(o.bendRange), 0.1, 24);
      if (tracker && (o.gateDb != null || o.bendRange != null)) { try { tracker.configure({ tracker: { gateDb: cfg.tracker.gateDb, bendRange: cfg.tracker.bendRange } }); } catch { /* old input */ } }
      const reopen = before.enabled !== cfg.enabled || (cfg.enabled && (!mic || before.deviceId !== cfg.deviceId || before.cleanup !== cfg.cleanup || before.channels !== cfg.channels));
      if (reopen) {
        closeMic();
        if (cfg.enabled) {
          if (!deps.hasGetUserMedia()) info = { open: false, reason: NO_CAPTURE_REASON, warnings: [], settings: null, label: '' };
          else await openMicNow();
        } else info = { open: false, reason: null, warnings: [], settings: null, label: '' };
      }
      applyGains();
      changed();
      return status();
    });
    queue = run.catch(() => {});
    return run;
  }

  /** Unmute the voice after the feedback guard muted it. */
  function resetGuard() {
    guardTrip = null;
    if (guard) guard.reset();
    changed();
  }

  // ---------------------------------------------------------------- meter

  /** Input meter: peak position 0..1 (-60..0 dBFS after the input gain) and the clip light. */
  function meter() {
    if (!mic || !mic.meters.length) return { open: false, pos: 0, peakDb: -240, rawDb: -240, clip: false, clipKind: null };
    let peak = 0;
    for (const a of mic.meters) {
      if (!meterBuf || meterBuf.length !== a.fftSize) meterBuf = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(meterBuf);
      for (let i = 0; i < meterBuf.length; i++) { const v = Math.abs(meterBuf[i]); if (v > peak) peak = v; }
    }
    const r = meterReading(peak, cfg.inputGainDb);
    const light = clip.update(r, deps.now());
    return { open: true, pos: r.pos, peakDb: r.peakDb, rawDb: r.rawDb, clip: light.on, clipKind: light.kind };
  }

  // ---------------------------------------------------------------- capture

  /**
   * Record the voice (mono, after the input gain) for `seconds`. Resolves to
   * {ok: true, samples, sampleRate} or {ok: false, reason}.
   */
  async function capture({ seconds = VOICE_CAPTURE_SECONDS, onProgress = null } = {}) {
    const fail = (reason) => ({ ok: false, reason });
    if (disposed) return fail('The audio engine was shut down.');
    if (!mic) return fail('Turn on Voice first, so Oro can hear you.');
    if (capturing) return fail('A capture is already running.');
    if (ctx.state && ctx.state !== 'running') return fail('Start the audio first, then try Capture again.');
    const secs = clamp(num(Number(seconds), VOICE_CAPTURE_SECONDS), 0.5, 10);
    capturing = { progress: 0 };
    changed();
    let cap = null;
    try {
      await deps.loadPedalWorklets(ctx);
      if (!mic) return fail('The microphone closed before the capture started.');
      cap = deps.createCapture(ctx, { channels: 1, maxSeconds: secs + 0.5 });
      tap.connect(cap.input);
      await cap.start();
      const steps = Math.max(1, Math.round(secs * 10));
      for (let i = 1; i <= steps; i++) {
        await deps.sleep(secs * 1000 / steps);
        if (disposed || !mic) return fail('The microphone closed during the capture.');
        capturing.progress = i / steps;
        if (onProgress) { try { onProgress(capturing.progress); } catch { /* listener bug */ } }
      }
      const out = await cap.stop();
      const samples = out && out[0];
      if (!samples || !samples.length) return fail('Nothing was recorded. Check the microphone and try again.');
      if (cap.dropouts) return fail('The browser was too busy to record cleanly. Close other tabs and try again.');
      return { ok: true, samples, sampleRate: ctx.sampleRate };
    } catch (err) {
      return fail(`The capture failed (${(err && err.message) || err}).`);
    } finally {
      if (cap) {
        try { tap.disconnect(cap.input); } catch { /* ignore */ }
        try { cap.dispose(); } catch { /* ignore */ }
      }
      capturing = null;
      changed();
    }
  }

  // ---------------------------------------------------------------- info

  function status() {
    const g = guard ? guard.status() : null;
    const muted = !!(guardTrip || (g && g.muted));
    const kind = guardTrip ? guardTrip.kind : (g && g.kind) || null;
    return {
      supported: { capture: !!deps.hasGetUserMedia() },
      enabled: cfg.enabled,
      deviceId: cfg.deviceId,
      cleanup: cfg.cleanup,
      channels: cfg.channels,
      inputGainDb: cfg.inputGainDb,
      monitor: cfg.monitor,
      processing: { highpass: cfg.highpass, compressor: cfg.compressor, deesser: cfg.deesser },
      level: cfg.level, pan: cfg.pan, delay: cfg.delay, reverb: cfg.reverb,
      ...info,
      guardArmed: !!guard,
      muted,
      muteReason: muted ? (kind === 'clipping'
        ? 'The voice was clipping, so Oro muted it. Turn the input gain down, then press Unmute.'
        : 'The voice started feeding back, so Oro muted it. Use headphones or turn Monitor off, then press Unmute.') : null,
      tracking: !!tracker,
      voiceLevel,
      capturing: !!capturing, captureProgress: capturing ? capturing.progress : 0,
    };
  }

  function dispose() {
    if (disposed) return;
    closeMic();
    disposed = true;
    for (const n of [inGain, ...chainNodes, level, panner, guardMute, heard, loopOnly, delaySend, reverbSend, tap]) { try { n.disconnect(); } catch { /* ignore */ } }
    events.clear();
  }

  applyGains();

  return {
    set, resetGuard, meter, capture, status, dispose,
    listInputs: () => deps.listAudioInputs(),
    get open() { return !!mic; },
    on: (name, fn) => events.on(name, fn),
    off: (name, fn) => events.off(name, fn),
    /** Nodes for tests and diagnostics. */
    nodes: { inGain, hp, comp, deess, level, panner, guardMute, heard, loopOnly, delaySend, reverbSend, tap },
  };
}
