// Engine side of the v1.1 pedal loop (docs/PEDALS.md): the per-part pedal send
// bus, its safety limiter, the output map (main mix on outputs 1/2, pedal send
// on 3/4 when the device has the channels), the pedal return with its
// feedback guard, the Guitar Level link source and the latency ping.
//
//   DSP output 3 (sum of every part's Pedal send, pre or post fader)
//     -> sendBus -> musicGate -> send limiter (about -18 dBFS) -> outputs 3/4
//   effects master -> mainOut -> outputs 1/2 (or the plain stereo destination)
//   pedal return (getUserMedia, voice processing off)
//     -> level -> guard mute -> master bus, delay send, reverb send
//   one input channel of the return (the guitar tap; channel 2 = the clean DI
//   in "Mono return + guitar") -> pitch tracker (Guitar plays notes, events
//   'guitarNote') and Capture (captureGuitar records it for a wavetable)
//
// The return is never connected to anything that leads back into the send, so
// Oro cannot feed its own return into the pedals; a loop can only close
// outside (for example in the MPC's monitoring), and the guard mutes it then.
//
// Everything here is optional. Until enable() is called the graph is exactly
// the pre-v1.1 one (mainOut -> destination, the DSP's send bus silent), and
// every failure (no setSinkId, a stereo device, no getUserMedia, a refused
// permission) comes back as a plain-language reason while the synth keeps
// playing as before. The signal processing lives in src/pedals/; this file is
// glue, written against injectable `deps` so tests can run it on a fake context.

import {
  buildOutputRouting, createSendLimiter, openReturn, attachFeedbackGuard, measureRoundTrip, listAudioInputs, createCapture,
} from '../pedals/pedal-loop.js';
import { createGuitarInput } from '../pedals/guitar.js';
import { createEmitter } from './emitter.js';

export const DEFAULT_SEND_CHANNELS = Object.freeze([2, 3]);   // outputs 3 and 4 (0-based)
export const DEFAULT_MAIN_CHANNELS = Object.freeze([0, 1]);
export const DEFAULT_SEND_CEILING_DB = -18;
export const RETURN_LAYOUTS = Object.freeze(['stereo', 'mono+guitar']);
/** Guitar tap default: input channel 2 (0-based 1), the clean DI in "Mono return + guitar". */
export const DEFAULT_GUITAR_CHANNEL = 1;
export const CAPTURE_SECONDS = 3;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function validPair(p, fallback) {
  if (!Array.isArray(p) || p.length < 1 || p.length > 2) return fallback.slice();
  const out = p.map(c => Math.round(Number(c)));
  return out.every(c => Number.isInteger(c) && c >= 0 && c <= 31) ? out : fallback.slice();
}

const defaultDeps = {
  buildOutputRouting, createSendLimiter, openReturn, attachFeedbackGuard, measureRoundTrip, listAudioInputs, createGuitarInput, createCapture,
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
  loadPedalWorklets: (ctx) => import('../pedals/worklet-loader.js').then(m => m.loadPedalWorklets(ctx)).catch(() => ({ ok: false })),
  hasGetUserMedia: () => typeof navigator !== 'undefined' && !!navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function',
};

/**
 * @param {BaseAudioContext} ctx
 * @param {object} o
 * @param {AudioNode} o.sendBus   receives the DSP's pedal send output (stereo)
 * @param {AudioNode} o.mainOut   the master output; connected to ctx.destination by the engine
 * @param {AudioNode} o.masterIn  where the return joins the mix (the effects' dry bus)
 * @param {AudioNode} [o.delayIn] delay send input (the return's delay send goes here)
 * @param {AudioNode} [o.reverbIn] reverb send input
 * @param {(msg: object) => void} o.post  DSP messages: {t:'pedal', active}, {t:'guitar', v}
 * @param {object} [o.deps] replacements for the src/pedals functions (tests)
 */
export function createPedalHost(ctx, { sendBus, mainOut, masterIn, delayIn = null, reverbIn = null, post = () => {}, deps: overrides = {} } = {}) {
  if (!ctx || !sendBus || !mainOut || !masterIn) throw new Error('createPedalHost needs a context, the send bus, the main output and the master input');
  const deps = { ...defaultDeps, ...overrides };
  const events = createEmitter();
  const stereo = (node) => { node.channelCount = 2; node.channelCountMode = 'explicit'; node.channelInterpretation = 'speakers'; return node; };
  const gain = (v) => { const g = stereo(ctx.createGain()); g.gain.value = v; return g; };
  const glide = (param, v, tau = 0.02) => {
    try { param.cancelScheduledValues(ctx.currentTime); param.setTargetAtTime(v, ctx.currentTime, tau); } catch { param.value = v; }
  };

  // ---- send side
  const musicGate = gain(1);          // the ping mutes the music on the send
  const limiter = deps.createSendLimiter(ctx, { ceilingDb: DEFAULT_SEND_CEILING_DB });
  sendBus.connect(musicGate);
  musicGate.connect(limiter.input);

  // ---- return side (built once; silent until a return is open)
  const retLevel = gain(1);           // the return level the person sets
  const retMute = gain(1);            // the feedback guard ramps this to 0
  const retDelay = gain(0);
  const retReverb = gain(0);
  retLevel.connect(retMute);
  retMute.connect(masterIn);
  retMute.connect(retDelay);
  retMute.connect(retReverb);
  if (delayIn) retDelay.connect(delayIn);
  if (reverbIn) retReverb.connect(reverbIn);

  let disposed = false;
  let enabled = false;
  let active = false;
  let sendChannels = DEFAULT_SEND_CHANNELS.slice();
  let mainChannels = DEFAULT_MAIN_CHANNELS.slice();
  let routing = null;
  let routingInfo = { mode: 'off', reason: null, channelCount: 2, maxChannelCount: ctx.destination ? ctx.destination.maxChannelCount : 2 };
  let mainToDest = true;               // the engine connected mainOut -> destination

  let ret = null;
  const retCfg = { enabled: false, deviceId: '', layout: 'stereo', level: 1, delay: 0, reverb: 0 };
  let retInfo = { open: false, reason: null, warnings: [], settings: null };
  let guard = null;
  let guardTrip = null;
  let guitar = null;
  let guitarLevel = 0, guitarSent = 0;   // the DSP starts at 0
  // Guitar plays notes / Capture: one channel of the return, tracked on demand.
  const guitarCfg = { channel: DEFAULT_GUITAR_CHANNEL, notes: false, guitarMode: 'single', tracker: { gateDb: -50, bendRange: 2 } };
  let tap = null;            // { node, owned: AudioNode[] } carrying only guitarCfg.channel
  let noteInput = null;      // the createGuitarInput whose note events become 'guitarNote'
  let noteShared = false;    // noteInput is the Guitar Level input (not ours to dispose)
  let noteOffs = [];
  let capturing = null;      // { progress } while captureGuitar runs
  let lastPing = null;
  let pinging = false;
  let queue = Promise.resolve();

  const changed = () => { if (!disposed) events.emit('change', status()); };

  function setActive(a) {
    if (a === active) return;
    active = a;
    post({ t: 'pedal', active });
  }

  // ---------------------------------------------------------------- routing

  function connectMainToDest() {
    if (mainToDest) return;
    try { mainOut.connect(ctx.destination); mainToDest = true; } catch { /* closed context */ }
  }
  function disconnectMainFromDest() {
    if (!mainToDest) return;
    try { mainOut.disconnect(ctx.destination); } catch { /* was not connected */ }
    mainToDest = false;
  }

  function teardownRouting() {
    if (!routing) return;
    try { limiter.output.disconnect(routing.sendIn); } catch { /* ignore */ }
    try { mainOut.disconnect(routing.mainIn); } catch { /* ignore */ }
    try { routing.dispose(); } catch { /* ignore */ }
    routing = null;
  }

  function applyRouting() {
    teardownRouting();
    if (!enabled || disposed) {
      connectMainToDest();
      routingInfo = { mode: 'off', reason: null, channelCount: 2, maxChannelCount: ctx.destination.maxChannelCount };
      setActive(false);
      return routingInfo;
    }
    try {
      const r = deps.buildOutputRouting(ctx, { sendChannels, mainChannels });
      // Built first, swapped second: the main mix is never off the destination
      // for longer than these two calls.
      disconnectMainFromDest();
      mainOut.connect(r.mainIn);
      limiter.output.connect(r.sendIn);
      routing = r;
      routingInfo = { mode: r.mode, reason: r.reason, channelCount: r.channelCount, maxChannelCount: r.maxChannelCount ?? ctx.destination.maxChannelCount };
    } catch (err) {
      teardownRouting();
      connectMainToDest();
      routingInfo = { mode: 'stereo', reason: `The outputs could not be set up (${(err && err.message) || err}), so the pedal send is off.`, channelCount: 2, maxChannelCount: ctx.destination.maxChannelCount };
    }
    setActive(routingInfo.mode === 'multichannel');
    return routingInfo;
  }

  /**
   * Turn the pedal send on or off and set the channel map / ceiling.
   * sendChannels / mainChannels are 0-based ([2, 3] = outputs 3 and 4).
   */
  function configure({ enabled: on = enabled, sendChannels: sc = sendChannels, mainChannels: mc = mainChannels, ceilingDb } = {}) {
    if (disposed) return status();
    enabled = !!on;
    sendChannels = validPair(sc, DEFAULT_SEND_CHANNELS);
    mainChannels = validPair(mc, DEFAULT_MAIN_CHANNELS);
    if (ceilingDb != null && Number.isFinite(Number(ceilingDb))) limiter.setCeiling(clamp(Number(ceilingDb), -40, -6));
    applyRouting();
    changed();
    return status();
  }

  /** Rebuild the output map (call after the output device changed: its channel count may differ). */
  function refresh() {
    if (disposed) return status();
    if (enabled) applyRouting();
    changed();
    return status();
  }

  // ---------------------------------------------------------------- return

  function postGuitar(v) {
    if (Math.abs(v - guitarSent) < 0.002 && !(v === 0 && guitarSent !== 0)) return;
    guitarSent = v;
    post({ t: 'guitar', v });
  }

  function closeReturn() {
    closeGuitarTap();
    if (guitar) { try { guitar.dispose(); } catch { /* ignore */ } guitar = null; }
    guitarLevel = 0;
    postGuitar(0);
    if (guard) { try { guard.dispose(); } catch { /* ignore */ } guard = null; }
    guardTrip = null;
    if (ret) {
      try { ret.output.disconnect(retLevel); } catch { /* ignore */ }
      try { ret.close(); } catch { /* ignore */ }
      ret = null;
    }
    // A fresh return starts unmuted.
    try { retMute.gain.cancelScheduledValues(ctx.currentTime); } catch { /* ignore */ }
    retMute.gain.value = 1;
    retInfo = { ...retInfo, open: false, settings: null };
  }

  async function openReturnNow() {
    const r = await deps.openReturn(ctx, retCfg.deviceId || '', { layout: retCfg.layout });
    if (disposed) { if (r && r.ok) r.close(); return; }
    if (!r || !r.ok) {
      retInfo = { open: false, reason: (r && r.reason) || 'The pedal return could not be opened.', warnings: [], settings: null };
      return;
    }
    ret = r;
    ret.output.connect(retLevel);
    retInfo = { open: true, reason: null, warnings: r.warnings || [], settings: r.settings || null };
    try {
      guard = deps.attachFeedbackGuard(ctx, {
        input: ret.output, gain: retMute,
        onTrip: (st) => { guardTrip = { kind: st.kind, reason: st.reason }; changed(); },
      });
    } catch (err) {
      guard = null;
      retInfo.warnings = [...retInfo.warnings, `The feedback guard could not start (${(err && err.message) || err}). Keep the send low.`];
    }
    if (retCfg.layout === 'mono+guitar' && ret.guitar) {
      try {
        await deps.loadPedalWorklets(ctx);
        if (!ret || disposed) return;
        guitar = deps.createGuitarInput(ctx, ret.guitar);
        guitar.on('level', (e) => {
          guitarLevel = clamp(num(e && e.value, 0), 0, 1);
          postGuitar(guitarLevel);
          events.emit('guitar', { level: guitarLevel, db: e && e.db });
        });
      } catch (err) {
        guitar = null;
        retInfo.warnings = [...retInfo.warnings, `Guitar tracking could not start (${(err && err.message) || err}).`];
      }
    }
    await syncGuitarNotes();
  }

  // ---------------------------------------------------------------- guitar notes / capture

  /** The node carrying only input channel guitarCfg.channel of the open return (built on demand). */
  function guitarTap() {
    if (!ret) return null;
    if (tap) return tap.node;
    const ch = guitarCfg.channel;
    if (retCfg.layout === 'mono+guitar' && ch === 1 && ret.guitar) {
      tap = { node: ret.guitar, owned: [] };
    } else if (ret.source && typeof ctx.createChannelSplitter === 'function') {
      const split = ctx.createChannelSplitter(2);
      const g = ctx.createGain();
      g.channelCount = 1; g.channelCountMode = 'explicit'; g.channelInterpretation = 'discrete';
      ret.source.connect(split);
      split.connect(g, ch);
      tap = { node: g, owned: [g, split], from: ret.source, split };
    } else {
      // No raw source (a stand-in return): its output is the best we have.
      tap = { node: ret.output, owned: [] };
    }
    return tap.node;
  }

  function closeNoteInput() {
    const had = !!noteInput;
    for (const off of noteOffs) { try { off(); } catch { /* ignore */ } }
    noteOffs = [];
    if (noteInput && noteShared) {
      try { noteInput.configure({ guitarMode: 'single' }); } catch { /* old input */ }
    }
    if (noteInput && !noteShared) { try { noteInput.dispose(); } catch { /* ignore */ } }
    noteInput = null;
    noteShared = false;
    // Whatever the guitar was holding must not hang.
    if (had) events.emit('guitarNote', { type: 'stop' });
  }

  function closeGuitarTap() {
    closeNoteInput();
    if (tap) {
      if (tap.from && tap.split) { try { tap.from.disconnect(tap.split); } catch { /* ignore */ } }
      for (const n of tap.owned) { try { n.disconnect(); } catch { /* ignore */ } }
      tap = null;
    }
  }

  async function syncGuitarNotes() {
    if (disposed) return;
    if (!guitarCfg.notes || !ret) { closeNoteInput(); return; }
    if (!noteInput) {
      const node = guitarTap();
      if (!node) return;
      if (guitar && node === ret.guitar) {
        noteInput = guitar;           // the Guitar Level input already tracks this channel
        noteShared = true;
      } else {
        try {
          await deps.loadPedalWorklets(ctx);
          if (!ret || disposed || noteInput || !guitarCfg.notes) return;
          noteInput = deps.createGuitarInput(ctx, node, { guitarMode: guitarCfg.guitarMode, tracker: { ...guitarCfg.tracker } });
          noteShared = false;
        } catch (err) {
          noteInput = null;
          retInfo.warnings = [...retInfo.warnings, `Guitar notes could not start (${(err && err.message) || err}).`];
          return;
        }
      }
      const fwd = (type) => noteInput.on(type, (e) => events.emit('guitarNote', { ...e, type }));
      noteOffs = ['noteOn', 'noteOff', 'bend', 'level', 'pitch'].map(fwd).filter(f => typeof f === 'function');
    }
    try { noteInput.configure({ guitarMode: guitarCfg.guitarMode, tracker: { ...guitarCfg.tracker } }); } catch { /* old input */ }
  }

  /**
   * Guitar plays notes and Capture: which input channel (0-based; 1 = channel
   * 2, the clean DI in "Mono return + guitar"), whether to track notes, and the
   * tracker's gate (dB) and bend range (semitones). Tracking only runs while
   * the return is open; note events come out as host.on('guitarNote').
   */
  function setGuitar(o = {}) {
    const run = queue.then(async () => {
      if (disposed) return status();
      const ch = o.channel != null ? clamp(Math.round(Number(o.channel)) || 0, 0, 1) : guitarCfg.channel;
      if (ch !== guitarCfg.channel) { guitarCfg.channel = ch; closeGuitarTap(); }
      if (o.guitarMode !== undefined) {
        const mode = o.guitarMode === 'chords' ? 'chords' : 'single';
        if (mode !== guitarCfg.guitarMode) {
          guitarCfg.guitarMode = mode;
          // Release through the router before a different detector takes over.
          if (noteInput) events.emit('guitarNote', { type: 'stop' });
        }
      }
      if (o.notes != null) guitarCfg.notes = !!o.notes;
      if (o.gateDb != null && Number.isFinite(Number(o.gateDb))) guitarCfg.tracker.gateDb = clamp(Number(o.gateDb), -90, 0);
      if (o.bendRange != null && Number.isFinite(Number(o.bendRange))) guitarCfg.tracker.bendRange = clamp(Number(o.bendRange), 0.1, 24);
      await syncGuitarNotes();
      changed();
      return status();
    });
    queue = run.catch(() => {});
    return run;
  }

  /**
   * Record the guitar channel for `seconds` (Capture). Resolves to
   * {ok: true, samples: Float32Array, sampleRate} or {ok: false, reason}.
   * onProgress(0..1) is called while recording.
   */
  async function captureGuitar({ seconds = CAPTURE_SECONDS, onProgress = null } = {}) {
    const fail = (reason) => ({ ok: false, reason });
    if (disposed) return fail('The audio engine was shut down.');
    if (!ret) return fail('Turn on the pedal return first, so Oro can hear the guitar.');
    if (capturing) return fail('A capture is already running.');
    if (ctx.state && ctx.state !== 'running') return fail('Start the audio first, then try Capture again.');
    const secs = clamp(num(Number(seconds), CAPTURE_SECONDS), 0.5, 10);
    capturing = { progress: 0 };
    changed();
    let cap = null, node = null;
    try {
      await deps.loadPedalWorklets(ctx);
      node = guitarTap();
      if (!node || !ret) return fail('The pedal return closed before the capture started.');
      cap = deps.createCapture(ctx, { channels: 1, maxSeconds: secs + 0.5 });
      node.connect(cap.input);
      await cap.start();
      const steps = Math.max(1, Math.round(secs * 10));
      for (let i = 1; i <= steps; i++) {
        await deps.sleep(secs * 1000 / steps);
        if (disposed || !ret) return fail('The pedal return closed during the capture.');
        capturing.progress = i / steps;
        if (onProgress) { try { onProgress(capturing.progress); } catch { /* listener bug */ } }
      }
      const out = await cap.stop();
      const samples = out && out[0];
      if (!samples || !samples.length) return fail('Nothing was recorded. Check the input and try again.');
      if (cap.dropouts) return fail('The browser was too busy to record cleanly. Close other tabs and try again.');
      return { ok: true, samples, sampleRate: ctx.sampleRate };
    } catch (err) {
      return fail(`The capture failed (${(err && err.message) || err}).`);
    } finally {
      if (cap) {
        try { if (node) node.disconnect(cap.input); } catch { /* ignore */ }
        try { cap.dispose(); } catch { /* ignore */ }
      }
      capturing = null;
      changed();
    }
  }

  /**
   * Pedal return settings. enabled/deviceId/layout reopen the input; level,
   * delay and reverb (0..1, level up to 2) only move gains. Never throws: a
   * failure lands in status().ret.reason. Calls are queued, so quick changes
   * never open two inputs at once.
   */
  function setReturn(opts = {}) {
    const run = queue.then(async () => {
      if (disposed) return status();
      const before = { enabled: retCfg.enabled, deviceId: retCfg.deviceId, layout: retCfg.layout };
      if (opts.enabled != null) retCfg.enabled = !!opts.enabled;
      if (opts.deviceId != null) retCfg.deviceId = String(opts.deviceId);
      if (opts.layout != null && RETURN_LAYOUTS.includes(opts.layout)) retCfg.layout = opts.layout;
      if (opts.level != null) retCfg.level = clamp(num(Number(opts.level), 1), 0, 2);
      if (opts.delay != null) retCfg.delay = clamp(num(Number(opts.delay), 0), 0, 1);
      if (opts.reverb != null) retCfg.reverb = clamp(num(Number(opts.reverb), 0), 0, 1);
      glide(retLevel.gain, retCfg.level);
      glide(retDelay.gain, retCfg.delay);
      glide(retReverb.gain, retCfg.reverb);
      const reopen = before.enabled !== retCfg.enabled || (retCfg.enabled && (before.deviceId !== retCfg.deviceId || before.layout !== retCfg.layout || !ret));
      if (reopen) {
        closeReturn();
        if (retCfg.enabled) {
          if (!deps.hasGetUserMedia()) retInfo = { open: false, reason: 'This browser cannot capture audio here. Oro needs a secure page (https or localhost) or the desktop app to hear the pedal return.', warnings: [], settings: null };
          else await openReturnNow();
        } else retInfo = { open: false, reason: null, warnings: [], settings: null };
      }
      changed();
      return status();
    });
    queue = run.catch(() => {});
    return run;
  }

  /** Unmute the return after the feedback guard muted it. */
  function resetGuard() {
    guardTrip = null;
    if (guard) guard.reset();
    changed();
  }

  // ---------------------------------------------------------------- ping

  /**
   * Round trip of the pedal loop in ms (src/pedals measureRoundTrip): a chirp
   * on the send with the music and the return monitor muted, cross-correlated
   * against the return. Needs the send on outputs 3/4 and an open return.
   */
  async function ping(opts = {}) {
    const fail = (reason) => ({ ok: false, latencyMs: NaN, latencySamples: NaN, confidence: 0, reason });
    if (disposed) return fail('The audio engine was shut down.');
    if (!active) return fail(enabled ? (routingInfo.reason || 'The pedal send is not running on its own outputs.') : 'Turn on the pedal send first.');
    if (!ret) return fail('Turn on the pedal return first, so the ping has something to listen to.');
    if (pinging) return fail('A ping is already running.');
    pinging = true;
    events.emit('ping', { running: true });
    try {
      await deps.loadPedalWorklets(ctx);
      const res = await deps.measureRoundTrip(ctx, {
        sendNode: limiter.input,
        returnNode: ret.output,
        mute: () => {
          const lvl = retCfg.level;
          glide(musicGate.gain, 0, 0.005);
          glide(retLevel.gain, 0, 0.005);
          return () => { glide(musicGate.gain, 1, 0.01); glide(retLevel.gain, lvl, 0.01); };
        },
        ...opts,
      });
      lastPing = { ...res, at: Date.now() };
      return res;
    } catch (err) {
      lastPing = { ...fail(`The ping failed (${(err && err.message) || err}).`), at: Date.now() };
      return lastPing;
    } finally {
      pinging = false;
      events.emit('ping', { running: false });
      changed();
    }
  }

  // ---------------------------------------------------------------- info

  function status() {
    const g = guard ? guard.status() : null;
    return {
      supported: {
        chooseOutput: typeof ctx.setSinkId === 'function',
        capture: !!deps.hasGetUserMedia(),
        maxChannels: ctx.destination ? ctx.destination.maxChannelCount : 2,
      },
      enabled,
      active,
      routing: { ...routingInfo },
      sendChannels: sendChannels.slice(),
      mainChannels: mainChannels.slice(),
      ceilingDb: limiter.ceilingDb,
      ret: {
        ...retCfg, ...retInfo,
        muted: !!(guardTrip || (g && g.muted)),
        muteReason: guardTrip ? guardTrip.reason : null,
        outsideReason: g && g.outside ? g.outsideReason : null,
      },
      guitar: {
        on: !!guitar, level: guitarLevel, via: guitar ? guitar.via : null,
        channel: guitarCfg.channel, notes: guitarCfg.notes, tracking: !!noteInput,
        guitarMode: guitarCfg.guitarMode,
        gateDb: guitarCfg.tracker.gateDb, bendRange: guitarCfg.tracker.bendRange,
        capturing: !!capturing, captureProgress: capturing ? capturing.progress : 0,
      },
      ping: lastPing ? { ...lastPing } : null,
      pinging,
    };
  }

  function dispose() {
    if (disposed) return;
    closeReturn();
    disposed = true;
    teardownRouting();
    connectMainToDest();
    setActive(false);
    for (const n of [musicGate, retLevel, retMute, retDelay, retReverb]) { try { n.disconnect(); } catch { /* ignore */ } }
    try { sendBus.disconnect(musicGate); } catch { /* ignore */ }
    limiter.dispose();
    events.clear();
  }

  return {
    configure, refresh, setReturn, setGuitar, captureGuitar, resetGuard, ping, status, dispose,
    listInputs: () => deps.listAudioInputs(),
    get active() { return active; },
    get enabled() { return enabled; },
    on: (name, fn) => events.on(name, fn),
    off: (name, fn) => events.off(name, fn),
    /** Nodes for tests and diagnostics. */
    nodes: { musicGate, limiter, retLevel, retMute, retDelay, retReverb },
  };
}
