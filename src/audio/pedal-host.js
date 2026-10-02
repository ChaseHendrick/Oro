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
//
// The return is never connected to anything that leads back into the send, so
// Orograph cannot feed its own return into the pedals; a loop can only close
// outside (for example in the MPC's monitoring), and the guard mutes it then.
//
// Everything here is optional. Until enable() is called the graph is exactly
// the pre-v1.1 one (mainOut -> destination, the DSP's send bus silent), and
// every failure (no setSinkId, a stereo device, no getUserMedia, a refused
// permission) comes back as a plain-language reason while the synth keeps
// playing as before. The signal processing lives in src/pedals/; this file is
// glue, written against injectable `deps` so tests can run it on a fake context.

import {
  buildOutputRouting, createSendLimiter, openReturn, attachFeedbackGuard, measureRoundTrip, listAudioInputs,
} from '../pedals/pedal-loop.js';
import { createGuitarInput } from '../pedals/guitar.js';
import { createEmitter } from './emitter.js';

export const DEFAULT_SEND_CHANNELS = Object.freeze([2, 3]);   // outputs 3 and 4 (0-based)
export const DEFAULT_MAIN_CHANNELS = Object.freeze([0, 1]);
export const DEFAULT_SEND_CEILING_DB = -18;
export const RETURN_LAYOUTS = Object.freeze(['stereo', 'mono+guitar']);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function validPair(p, fallback) {
  if (!Array.isArray(p) || p.length < 1 || p.length > 2) return fallback.slice();
  const out = p.map(c => Math.round(Number(c)));
  return out.every(c => Number.isInteger(c) && c >= 0 && c <= 31) ? out : fallback.slice();
}

const defaultDeps = {
  buildOutputRouting, createSendLimiter, openReturn, attachFeedbackGuard, measureRoundTrip, listAudioInputs, createGuitarInput,
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
          if (!deps.hasGetUserMedia()) retInfo = { open: false, reason: 'This browser cannot capture audio here. Orograph needs a secure page (https or localhost) or the desktop app to hear the pedal return.', warnings: [], settings: null };
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
      guitar: { on: !!guitar, level: guitarLevel, via: guitar ? guitar.via : null },
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
    configure, refresh, setReturn, resetGuard, ping, status, dispose,
    listInputs: () => deps.listAudioInputs(),
    get active() { return active; },
    get enabled() { return enabled; },
    on: (name, fn) => events.on(name, fn),
    off: (name, fn) => events.off(name, fn),
    /** Nodes for tests and diagnostics. */
    nodes: { musicGate, limiter, retLevel, retMute, retDelay, retReverb },
  };
}
