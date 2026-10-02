// Orograph audio host: AudioContext, the DSP (AudioWorklet, or a
// ScriptProcessor running the same OrographDSP class on the main thread when
// worklets cannot load), the effect graph, store forwarding, terrain tables,
// file import, recording and offline bounces. See docs/ARCHITECTURE.md
// "Audio host API" and "Round D additions".
//
// Worklet and worker code is bundled to strings by vite.config.js
// (virtual:worklet:...). Each is loaded from a Blob URL first; file:// pages
// refuse Blob URLs for audioWorklet.addModule, so a data: URL is the second
// try, and only when both fail (strict CSP) does the host fall back to the
// main-thread ScriptProcessor.

import workletCode from 'virtual:worklet:src/dsp/worklet.js';
import recorderCode from 'virtual:worklet:src/audio/recorder-worklet.js';
import terrainWorkerCode from 'virtual:worklet:src/audio/terrain-worker.js';
import { NUM_PARTS } from '../core/params.js';
import { createEmitter } from './emitter.js';
import { createFx } from './fx.js';
import { createStoreSync } from './sync.js';
import { createTerrainGenerator } from './terrain-generator.js';
import { createTerrainManager } from './terrain-manager.js';
import { createRecorder, MAX_RECORD_SECONDS } from './recorder.js';
import { importTerrainFile as importIntoStore, importStats } from './importers.js';
import { wavHeader } from './wav.js';
import { loadWorkletModule, withTimeout } from './worklet-loader.js';
import { bounceOptions, normaliseEvents, stemParts, passInit, renderPass, encodeBuffer } from './bounce.js';
import { sequencerEvents } from './bounce-events.js';

export { loadWorkletModule };

const SCRIPT_BUFFER = 1024;
const RESUME_TIMEOUT_MS = 2500;
const MAX_RECOVERIES = 3;
export const QUALITY_MODES = Object.freeze(['eco', 'standard', 'high', 'pristine', 'raw']);

function validPart(part) {
  return Number.isInteger(part) && part >= 0 && part < NUM_PARTS;
}
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const validNote = (n) => n === undefined || n === null || Number.isFinite(n);
const finiteOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
const QUANTUM_FRAMES = 128;

/**
 * Build the audio host. Never needs a user gesture: the context starts
 * suspended until start() is called from one.
 * @param {object} o
 * @param {object} o.store
 * @param {'auto'|'worklet'|'script'} [o.mode] force the DSP host (tests); 'auto' prefers the worklet
 * @param {boolean} [o.inlineTerrain] generate terrains on the main thread (tests)
 * @param {number} [o.sampleRate] request a context rate (default: the device's)
 * @param {number} [o.maxRecordSeconds]
 */
export async function createEngine({ store, mode: wantMode = 'auto', inlineTerrain = false, sampleRate, maxRecordSeconds = MAX_RECORD_SECONDS, terrainWorkers = 2 } = {}) {
  if (!store) throw new Error('createEngine needs the store');
  const events = createEmitter();
  const genPromise = createTerrainGenerator({ code: terrainWorkerCode, workers: terrainWorkers, forceInline: inlineTerrain });

  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  let ctx = null;
  if (AC) {
    try {
      ctx = new AC(sampleRate ? { latencyHint: 'interactive', sampleRate } : { latencyHint: 'interactive' });
    } catch {
      try { ctx = new AC(); } catch (err) { console.warn('[audio] Web Audio is unavailable', err); ctx = null; }
    }
  }

  let dspMode = 'none';
  let workletVia = null;
  const loadErrors = [];
  let recorderWorklet = false;
  if (ctx) {
    if (wantMode !== 'script') {
      const [main, rec] = await Promise.all([loadWorkletModule(ctx, workletCode), loadWorkletModule(ctx, recorderCode)]);
      if (main.ok) { dspMode = 'worklet'; workletVia = main.via; } else loadErrors.push(...main.errors);
      recorderWorklet = rec.ok;
    }
    if (dspMode === 'none') dspMode = 'script';
  }

  let fx = null;
  let send = () => {};            // (msg | msg[], transfer?) -> DSP
  let node = null;                // AudioWorkletNode or ScriptProcessorNode
  let scriptParts = [];           // extra nodes of the script host
  let recoveries = 0;
  let lastTele = null;
  let disposed = false;

  const onTele = (m) => { lastTele = m; events.emit('tele', m); };

  // Host state the DSP needs that does not live in the persisted store: the
  // quality mode (device setting), the channel controllers and the transport
  // anchor. snapshot() replays it, so a rebuilt DSP keeps playing the same way.
  let quality = QUALITY_MODES.includes(store.get('ui.audioQuality')) ? store.get('ui.audioQuality') : 'standard';
  const controllers = Array.from({ length: NUM_PARTS }, () => ({ bend: 0, wheel: 0, pressure: 0, slide: 0 }));
  const marbles = Array.from({ length: NUM_PARTS }, () => null);
  let transportMsg = null;
  const hostState = () => {
    const out = [{ t: 'quality', mode: quality }];
    controllers.forEach((c, part) => {
      if (c.bend) out.push({ t: 'bend', part, v: c.bend });
      if (c.wheel) out.push({ t: 'wheel', part, v: c.wheel });
      if (c.pressure) out.push({ t: 'pressure', part, v: c.pressure });
      if (c.slide) out.push({ t: 'slide', part, v: c.slide });
    });
    marbles.forEach((m) => { if (m) out.push({ ...m }); });
    if (transportMsg && transportMsg.playing) out.push({ ...transportMsg });
    return out;
  };

  const sync = createStoreSync({
    store,
    post: (msgs) => send(msgs),
    onGlobal: (g, changed) => { if (fx) fx.set(g, changed); },
    extra: hostState,
  });

  function buildWorkletSource(init) {
    const n = new AudioWorkletNode(ctx, 'orograph', {
      numberOfInputs: 0,
      numberOfOutputs: 3,
      outputChannelCount: [2, 2, 2],
      processorOptions: { sampleRate: ctx.sampleRate, init },
    });
    n.port.onmessage = (e) => {
      const m = e.data;
      if (m && m.t === 'tele') onTele(m);
    };
    n.onprocessorerror = (e) => recover(e);
    n.connect(fx.dryIn, 0);
    n.connect(fx.delayIn, 1);
    n.connect(fx.reverbIn, 2);
    node = n;
    send = (msgs, transfer) => {
      try { n.port.postMessage(msgs, transfer || []); } catch (err) { console.error('[audio] post to DSP failed', err); }
    };
  }

  async function buildScriptSource(init) {
    const { OrographDSP } = await import('../dsp/dsp-core.js');
    const dsp = new OrographDSP(ctx.sampleRate);
    dsp.postMessage = (m) => { if (m && m.t === 'tele') onTele(m); };
    for (const m of init) dsp.handleMessage(m);
    let sp;
    try { sp = ctx.createScriptProcessor(SCRIPT_BUFFER, 0, 6); } catch { sp = ctx.createScriptProcessor(SCRIPT_BUFFER, 1, 6); }
    sp.onaudioprocess = (e) => {
      const ob = e.outputBuffer;
      const t = Number.isFinite(e.playbackTime) ? e.playbackTime : ctx.currentTime;
      try {
        dsp.process(ob.getChannelData(0), ob.getChannelData(1), ob.getChannelData(2), ob.getChannelData(3),
          ob.getChannelData(4), ob.getChannelData(5), ob.length, t);
      } catch (err) {
        for (let c = 0; c < ob.numberOfChannels; c++) ob.getChannelData(c).fill(0);
        if (!buildScriptSource.warned) { buildScriptSource.warned = true; console.error('[audio] DSP failed in the ScriptProcessor', err); }
      }
    };
    const split = ctx.createChannelSplitter(6);
    sp.connect(split);
    const targets = [fx.dryIn, fx.delayIn, fx.reverbIn];
    const merges = targets.map((dst, k) => {
      const m = ctx.createChannelMerger(2);
      split.connect(m, 2 * k, 0);
      split.connect(m, 2 * k + 1, 1);
      m.connect(dst);
      return m;
    });
    node = sp;
    scriptParts = [split, ...merges];
    send = (msgs) => {
      const list = Array.isArray(msgs) ? msgs : [msgs];
      for (const m of list) {
        try { dsp.handleMessage(m); } catch (err) { console.error('[audio] DSP message failed', err); }
      }
    };
  }

  function teardownSource() {
    if (node) {
      try { node.disconnect(); } catch { /* ignore */ }
      if (node.port) node.port.onmessage = null;
      if ('onaudioprocess' in node) node.onaudioprocess = null;
    }
    for (const n of scriptParts) { try { n.disconnect(); } catch { /* ignore */ } }
    scriptParts = [];
    node = null;
    send = () => {};
  }

  let terrain = null;

  // Rebuild the DSP node (worklet first, the main-thread host as the fallback)
  // and replay the patch and the terrain tables into it. The tables travel in
  // the constructor's init list, so the new node never renders a single block
  // on empty terrain. Overlapping requests (two processor errors in a row)
  // share one rebuild.
  let rebuilding = null;
  function rebuildSource() {
    if (!rebuilding) {
      rebuilding = (async () => {
        teardownSource();
        const init = [...sync.snapshot(), ...(terrain ? terrain.messages() : [])];
        try {
          if (dspMode === 'worklet' && recoveries <= MAX_RECOVERIES) buildWorkletSource(init);
          else { dspMode = 'script'; await buildScriptSource(init); }
        } catch (err) {
          console.error('[audio] could not rebuild the DSP', err);
          dspMode = 'script';
          await buildScriptSource(init);
        }
        events.emit('state', { state: ctx.state, mode: dspMode });
      })().finally(() => { rebuilding = null; });
    }
    return rebuilding;
  }

  // A processor that throws is dead for good: rebuild it. After repeated
  // failures the main-thread host takes over.
  async function recover(reason) {
    if (disposed) return;
    console.error('[audio] the DSP processor stopped', reason);
    if (rebuilding) return rebuilding;
    recoveries++;
    await rebuildSource();
  }

  if (ctx) {
    fx = createFx(ctx, {
      global: store.get('global') || {},
      // Reverb impulse responses are built by the same worker pool as terrains.
      computeIR: (opts) => genPromise.then(g => g.run({ kind: 'ir', ...opts })),
    });
    const init = sync.snapshot();
    if (dspMode === 'worklet') {
      try {
        buildWorkletSource(init);
      } catch (err) {
        loadErrors.push(String((err && err.message) || err));
        dspMode = 'script';
      }
    }
    if (dspMode === 'script') await buildScriptSource(init);
    if (loadErrors.length && dspMode === 'script' && wantMode !== 'script') {
      console.warn('[audio] AudioWorklet unavailable, using the ScriptProcessor fallback:', loadErrors.join(' | '));
    }
  }

  const generator = await genPromise;
  terrain = createTerrainManager({
    store,
    post: (msg, transfer) => send(msg, transfer),
    emit: (name, payload) => events.emit(name, payload),
    generator,
  });

  const recorder = ctx ? createRecorder(ctx, fx.output, {
    worklet: recorderWorklet,
    maxSeconds: maxRecordSeconds,
    onEvent: (e) => events.emit('recording', e),
  }) : null;

  // ---- context state ----------------------------------------------------------------
  let wantRunning = false;
  const resumeIfWanted = () => {
    if (!ctx || disposed || !wantRunning) return;
    if (ctx.state === 'running' || ctx.state === 'closed') return;
    ctx.resume().catch(() => { /* needs a gesture; the next one will retry */ });
  };
  let lastState = ctx ? ctx.state : 'none';
  const onState = () => {
    const prev = lastState;
    lastState = ctx.state;
    events.emit('state', { state: ctx.state, mode: dspMode });
    // iOS/Safari 'interrupted' (calls, other apps) ends on its own; asking to
    // resume lets it come back as soon as the system allows. Some versions
    // end an interruption in 'suspended' rather than 'running': nobody asked
    // for that pause, so resume it too (a deliberate suspend() is left alone).
    if (ctx.state === 'interrupted' || (ctx.state === 'suspended' && prev === 'interrupted')) resumeIfWanted();
  };
  const onVisibility = () => { if (typeof document !== 'undefined' && !document.hidden) resumeIfWanted(); };
  // The output device can change under us (unplugged headphones fall back to
  // the default); keep outputDeviceId truthful and tell the settings panel.
  const onSinkChange = () => {
    const id = ctx && typeof ctx.sinkId === 'string' ? ctx.sinkId : '';
    outputDeviceId = id || 'default';
    events.emit('state', { state: ctx.state, mode: dspMode, sinkId: outputDeviceId });
    resumeIfWanted();
  };
  // Chromium fires 'error' on the context when the output device fails
  // (unplugged mid-play, driver reset). Fall back to the system default
  // output, which is what a person expects to keep hearing.
  const onCtxError = (e) => {
    console.warn('[audio] the audio output failed', e && (e.error || e.message || e.type));
    events.emit('state', { state: ctx.state, mode: dspMode, sinkId: outputDeviceId, error: 'output' });
    if (outputDeviceId !== 'default' && typeof ctx.setSinkId === 'function') {
      engine.setOutputDevice('default').catch(() => { /* nothing better to fall back to */ });
    } else resumeIfWanted();
  };
  const gestureEvents = ['pointerdown', 'keydown', 'touchend'];
  if (ctx) {
    if (typeof ctx.addEventListener === 'function') {
      ctx.addEventListener('statechange', onState);
      ctx.addEventListener('sinkchange', onSinkChange);
      ctx.addEventListener('error', onCtxError);
    } else ctx.onstatechange = onState;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
      for (const ev of gestureEvents) document.addEventListener(ev, resumeIfWanted, { capture: true, passive: true });
    }
  }

  // ---- level meter -----------------------------------------------------------------------
  const levelBuf = ctx ? new Float32Array(fx.analyser.fftSize) : null;
  let levelVal = 0, levelAt = 0;

  let outputDeviceId = 'default';
  let sinkQueue = Promise.resolve();

  const post = (msg) => { sync.flush(); send(msg); };

  // Quality follows the persisted device setting in the store; setQuality()
  // is the direct route (the settings panel calls both).
  function applyQuality(mode, force = false) {
    if (!QUALITY_MODES.includes(mode)) return false;
    if (mode === quality && !force) return true;
    quality = mode;
    post({ t: 'quality', mode });
    events.emit('quality', { mode });
    return true;
  }
  const offQuality = store.subscribe('ui.audioQuality', () => { applyQuality(store.get('ui.audioQuality')); });

  // Marble updates arrive ~30 times a second per rolling part; one port
  // message per task carries all of them, and unchanged values are dropped.
  let marbleQueued = null;
  const flushMarbles = () => {
    const q = marbleQueued;
    marbleQueued = null;
    if (q && q.length) send(q);
  };

  let bouncing = false;
  let lastBounce = null;

  const engine = {
    get context() { return ctx; },
    get analyser() { return fx ? fx.analyser : null; },
    /** 'worklet' | 'script' | 'none' (no Web Audio at all). */
    get mode() { return dspMode; },
    get sampleRate() { return ctx ? ctx.sampleRate : 0; },
    /** Seconds from scheduling to the speaker, as far as the browser reports it. */
    get latency() { return ctx ? (ctx.baseLatency || 0) + (ctx.outputLatency || 0) : 0; },
    get outputDeviceId() { return outputDeviceId; },
    get recording() { return !!(recorder && recorder.isRecording()); },

    async start() {
      wantRunning = true;
      if (!ctx) return 'none';
      if (ctx.state !== 'running' && ctx.state !== 'closed') {
        try { await withTimeout(ctx.resume(), RESUME_TIMEOUT_MS, 'resume'); } catch (err) { console.warn('[audio] could not start audio yet', err); }
      }
      return ctx.state;
    },

    noteOn(part, note, vel = 0.8, time = 0) {
      if (!validPart(part) || !Number.isFinite(note)) return;
      post({ t: 'noteOn', part, note, vel: Number.isFinite(vel) ? vel : 0.8, time: Number.isFinite(time) ? time : 0 });
    },
    noteOff(part, note, time = 0) {
      if (!validPart(part) || !Number.isFinite(note)) return;
      post({ t: 'noteOff', part, note, time: Number.isFinite(time) ? time : 0 });
    },
    allNotesOff(part) {
      if (part === undefined || part === null) post({ t: 'allOff' });
      else if (validPart(part)) post({ t: 'allOff', part });
    },
    panic() {
      post({ t: 'panic' });
      if (fx) fx.panic();
    },
    bend(part, v) {
      if (!validPart(part) || !Number.isFinite(v)) return;
      controllers[part].bend = clamp(v, -1, 1);
      post({ t: 'bend', part, v: controllers[part].bend });
    },
    wheel(part, v) {
      if (!validPart(part) || !Number.isFinite(v)) return;
      controllers[part].wheel = clamp(v, 0, 1);
      post({ t: 'wheel', part, v: controllers[part].wheel });
    },
    /** Anchor tempo-synced LFOs to the sequencer: beat `beat` sounds at audio time `beatTime`. */
    setTransport({ playing = false, beatTime = 0, beat = 0, spb } = {}) {
      const msgs = [];
      const t = { t: 'transport', playing: !!playing, beatTime: Number.isFinite(beatTime) ? beatTime : 0, beat: Number.isFinite(beat) ? beat : 0 };
      if (Number.isFinite(spb) && spb > 0) {
        msgs.push({ t: 'global', p: { tempo: 60 / spb } });
        t.spb = spb;
      }
      msgs.push(t);
      transportMsg = t;
      sync.flush();
      send(msgs);
    },

    /** Channel pressure 0..1 (all voices of the part), or per-note pressure when `note` is given (poly AT / MPE). */
    pressure(part, v, note) {
      if (!validPart(part) || !Number.isFinite(v) || !validNote(note)) return;
      const val = clamp(v, 0, 1);
      if (note === undefined || note === null) { controllers[part].pressure = val; post({ t: 'pressure', part, v: val }); }
      else post({ t: 'pressure', part, v: val, note });
    },
    /** MPE slide (CC74) 0..1, for the part or one note. */
    slide(part, v, note) {
      if (!validPart(part) || !Number.isFinite(v) || !validNote(note)) return;
      const val = clamp(v, 0, 1);
      if (note === undefined || note === null) { controllers[part].slide = val; post({ t: 'slide', part, v: val }); }
      else post({ t: 'slide', part, v: val, note });
    },
    /** From the visuals' physics: marble speed 0..1 and the height under it -1..1. */
    marble(part, speed, height) {
      if (!validPart(part) || !Number.isFinite(speed) || !Number.isFinite(height)) return;
      const m = { t: 'marble', part, speed: clamp(speed, 0, 1), height: clamp(height, -1, 1) };
      const last = marbles[part];
      if (last && Math.abs(last.speed - m.speed) < 1e-4 && Math.abs(last.height - m.height) < 1e-4) return;
      marbles[part] = m;
      if (!marbleQueued) { marbleQueued = []; queueMicrotask(flushMarbles); }
      const i = marbleQueued.findIndex(x => x.part === part);
      if (i >= 0) marbleQueued[i] = m; else marbleQueued.push(m);
    },
    /** Oversampling / anti-aliasing mode: 'eco' | 'standard' | 'high' | 'pristine' | 'raw'. Returns the mode in use. */
    setQuality(mode) {
      applyQuality(mode);
      return quality;
    },
    get quality() { return quality; },

    on(name, fn) { return events.on(name, fn); },
    off(name, fn) { events.off(name, fn); },

    getTerrain(part, slot) { return terrain.get(part, slot); },
    /** Resolves when every part's terrain tables match the store (tests, loading screens). */
    whenTerrainsReady() { return terrain.whenIdle(); },
    /** Image or WAV -> userTerrain + terrain enum 'user'. Image options: { channel: 'luma'|'r'|'g'|'b', smooth: 0..1, tile: 'mirror'|'wrap' }. */
    importTerrainFile(part, slot, file, options) { return importIntoStore(store, part, slot, file, options); },

    /**
     * Offline render of `events` (music.renderEvents; a plain sequencer
     * render of the store when omitted) through the DSP and the effects.
     * Resolves to { mix: Blob, stems: (Blob|null)[] } (24-bit WAV); stems has
     * one entry per part (null for parts that play nothing) when asked for.
     * Progress: engine.on('bounce', {done, total, stage, part}).
     */
    async bounce(opts = {}) {
      if (disposed) throw new Error('The audio engine was shut down');
      if (bouncing) throw new Error('A bounce is already running');
      bouncing = true;
      const t0 = performance.now();
      try {
        const o = bounceOptions(opts, store.get('global.tempo'));
        const sr = Math.round(finiteOr(opts.sampleRate, ctx ? ctx.sampleRate : 48000));
        const frames = Math.max(QUANTUM_FRAMES, Math.ceil(o.totalSeconds * sr));
        const evs = normaliseEvents(Array.isArray(opts.events) ? opts.events : sequencerEvents(store.serialize(), o.bars), o.songSeconds);
        await terrain.whenIdle();
        sync.flush();
        // The live transport anchor is in live context seconds; an offline
        // render starts its bar at 0 (events from music.renderEvents say so too).
        const snapshot = sync.snapshot().filter(m => m.t !== 'transport');
        snapshot.push({ t: 'transport', playing: true, beatTime: 0, beat: 0, spb: 60 / clamp(Number(store.get('global.tempo')) || 112, 20, 400) });
        if (opts.quality && QUALITY_MODES.includes(opts.quality)) snapshot.push({ t: 'quality', mode: opts.quality });
        const terrains = terrain.messages();
        const global = { ...(store.get('global') || {}) };
        const stemList = o.stems ? stemParts(store.serialize(), evs) : [];
        const passes = [{ solo: null }, ...stemList.map(p => ({ solo: p }))];
        const total = frames * passes.length;
        let done = 0;
        // Every pass uses the same reverb: build its impulse response once.
        const irs = new Map();
        const computeIR = (irOpts) => {
          const key = JSON.stringify(irOpts);
          if (!irs.has(key)) irs.set(key, genPromise.then(g => g.run({ kind: 'ir', ...irOpts })));
          return irs.get(key);
        };
        const progress = (stage, part, f) => events.emit('bounce', { done: Math.min(total, done + f), total, stage, part });
        progress('mix', null, 0);
        const out = { mix: null, stems: o.stems ? new Array(NUM_PARTS).fill(null) : [] };
        const info = { passes: [] };
        for (const pass of passes) {
          const stage = pass.solo === null ? 'mix' : 'stem';
          const { init, late } = passInit({ snapshot, terrains, events: evs, solo: pass.solo });
          const r = await renderPass({
            sampleRate: sr, frames, init, late, global, fx: o.fx, workletCode,
            computeIR,
            forceMainThread: dspMode !== 'worklet' && !opts.worklet,
            onFrames: (f) => progress(stage, pass.solo, f),
          });
          if (disposed) throw new Error('The audio engine was shut down');
          const { blob, stats: level } = await encodeBuffer(r.buffer);
          info.passes.push({ stage, part: pass.solo, via: r.via, ...level });
          if (pass.solo === null) out.mix = blob; else out.stems[pass.solo] = blob;
          done += frames;
          progress(stage, pass.solo, 0);
        }
        lastBounce = { ...info, seconds: o.totalSeconds, sampleRate: sr, events: evs.length, ms: Math.round(performance.now() - t0) };
        events.emit('bounce', { done: total, total, stage: 'done', part: null });
        return out;
      } finally {
        bouncing = false;
      }
    },
    get bouncing() { return bouncing; },

    async startRecording() {
      if (!recorder) throw new Error('Recording needs Web Audio, which this browser does not provide');
      recorder.start();
    },
    async stopRecording() {
      if (!recorder) return new Blob([wavHeader({ sampleRate: 48000, frames: 0 })], { type: 'audio/wav' });
      const r = await recorder.stop();
      return r ? r.blob : new Blob([wavHeader({ sampleRate: ctx.sampleRate, frames: 0 })], { type: 'audio/wav' });
    },
    /** Seconds captured by the running recording (0 when idle). */
    recordingElapsed() { return recorder ? recorder.elapsed() : 0; },

    /** Smoothed output level 0..1 (RMS x √2, so a full-scale sine reads 1). */
    level() {
      if (!ctx) return 0;
      const t = performance.now();
      if (t - levelAt < 8) return levelVal;
      const dt = levelAt ? Math.min(0.25, (t - levelAt) / 1000) : 1 / 60;
      levelAt = t;
      let target = 0;
      if (ctx.state === 'running') {
        fx.analyser.getFloatTimeDomainData(levelBuf);
        let s = 0;
        for (let i = 0; i < levelBuf.length; i++) s += levelBuf[i] * levelBuf[i];
        target = Math.min(1, Math.sqrt(s / levelBuf.length) * Math.SQRT2);
      }
      const tau = target > levelVal ? 0.03 : 0.25;
      levelVal += (target - levelVal) * (1 - Math.exp(-dt / tau));
      if (levelVal < 1e-6) levelVal = 0;
      return levelVal;
    },
    /** Latest telemetry message (or null). */
    telemetry() { return lastTele; },

    async listOutputDevices() {
      if (!ctx || typeof ctx.setSinkId !== 'function') return [];
      const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : null;
      if (!md || typeof md.enumerateDevices !== 'function') return [];
      let list = [];
      try { list = await md.enumerateDevices(); } catch { return []; }
      const outs = list.filter(d => d.kind === 'audiooutput').map((d, i) => ({
        deviceId: d.deviceId || 'default',
        id: d.deviceId || 'default',
        groupId: d.groupId || '',
        label: d.label || (d.deviceId === 'default' || !d.deviceId ? 'System default' : `Output ${i + 1}`),
      }));
      if (!outs.some(d => d.deviceId === 'default')) outs.unshift({ deviceId: 'default', id: 'default', groupId: '', label: 'System default' });
      return outs;
    },
    async setOutputDevice(id) {
      if (!ctx || ctx.state === 'closed') throw new Error('Audio output is not available in this browser');
      if (typeof ctx.setSinkId !== 'function') throw new Error('This browser cannot choose an audio output; change it in your system sound settings');
      const sink = !id || id === 'default' ? '' : String(id);
      // One switch at a time: a second choice made while the first is still
      // opening the device waits for it instead of racing it.
      const run = sinkQueue.then(async () => {
        if (disposed) throw new Error('The audio engine was shut down');
        const current = typeof ctx.sinkId === 'string' ? ctx.sinkId : '';
        if (current !== sink) {
          try {
            await ctx.setSinkId(sink);
          } catch (err) {
            const name = err && err.name;
            if (name === 'NotFoundError') throw new Error('That audio output is no longer available');
            if (name === 'NotAllowedError' || name === 'SecurityError') throw new Error('This page is not allowed to choose the audio output');
            throw err;
          }
        }
        outputDeviceId = sink || 'default';
        events.emit('state', { state: ctx.state, mode: dspMode, sinkId: outputDeviceId });
        // Some systems pause the context while they reopen the device.
        resumeIfWanted();
        return outputDeviceId;
      });
      sinkQueue = run.catch(() => {});
      return run;
    },

    /** Rebuild the DSP from the store (voices are silenced; patch and terrains are replayed). */
    async restartDSP() {
      if (!ctx || disposed) return dspMode;
      await rebuildSource();
      return dspMode;
    },

    /** Diagnostics for tests and the settings panel. */
    stats() {
      return {
        mode: dspMode,
        workletVia,
        loadErrors: [...loadErrors],
        recorder: recorder ? recorder.mode : null,
        recoveries,
        state: ctx ? ctx.state : 'none',
        sampleRate: ctx ? ctx.sampleRate : 0,
        latency: engine.latency,
        terrain: terrain.stats(),
        generator: generator.stats(),
        fx: fx ? fx.stats() : null,
        import: { ...importStats },
        sync: sync.stats(),
        quality,
        bounce: lastBounce,
      };
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
        for (const ev of gestureEvents) document.removeEventListener(ev, resumeIfWanted, { capture: true });
      }
      terrain.dispose();
      offQuality();
      sync.dispose();
      generator.dispose();
      if (recorder) recorder.dispose();
      teardownSource();
      if (fx) fx.dispose();
      events.clear();
      if (ctx) {
        if (typeof ctx.removeEventListener === 'function') {
          ctx.removeEventListener('statechange', onState);
          ctx.removeEventListener('sinkchange', onSinkChange);
          ctx.removeEventListener('error', onCtxError);
        }
        try { await ctx.close(); } catch { /* already closed */ }
      }
    },
  };

  return engine;
}
