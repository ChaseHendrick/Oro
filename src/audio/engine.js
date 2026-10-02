// Orograph audio host: AudioContext, the DSP (AudioWorklet, or a
// ScriptProcessor running the same OrographDSP class on the main thread when
// worklets cannot load), the effect graph, store forwarding, terrain tables,
// file import and recording. See docs/ARCHITECTURE.md "Audio host API".
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

const SCRIPT_BUFFER = 1024;
const ADD_MODULE_TIMEOUT_MS = 10000;
const RESUME_TIMEOUT_MS = 2500;
const MAX_RECOVERIES = 3;

function withTimeout(promise, ms, what) {
  let timer = 0;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * audioWorklet.addModule with the Blob URL -> data: URL fallback.
 * @returns {Promise<{ok: boolean, via: 'blob'|'data'|null, errors: string[]}>}
 */
export async function loadWorkletModule(ctx, code) {
  const errors = [];
  if (!ctx || !ctx.audioWorklet || typeof AudioWorkletNode !== 'function') {
    return { ok: false, via: null, errors: ['AudioWorklet is not available (needs a secure context)'] };
  }
  let blobUrl = null;
  try {
    blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    await withTimeout(ctx.audioWorklet.addModule(blobUrl), ADD_MODULE_TIMEOUT_MS, 'addModule(blob)');
    return { ok: true, via: 'blob', errors };
  } catch (err) {
    errors.push(String((err && err.message) || err));
  } finally {
    if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch { /* ignore */ } }
  }
  try {
    await withTimeout(ctx.audioWorklet.addModule('data:text/javascript;charset=utf-8,' + encodeURIComponent(code)), ADD_MODULE_TIMEOUT_MS, 'addModule(data)');
    return { ok: true, via: 'data', errors };
  } catch (err) {
    errors.push(String((err && err.message) || err));
  }
  return { ok: false, via: null, errors };
}

function validPart(part) {
  return Number.isInteger(part) && part >= 0 && part < NUM_PARTS;
}

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

  const sync = createStoreSync({
    store,
    post: (msgs) => send(msgs),
    onGlobal: (g, changed) => { if (fx) fx.set(g, changed); },
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
  // and replay the patch and the terrain tables into it.
  async function rebuildSource() {
    teardownSource();
    const init = sync.snapshot();
    try {
      if (dspMode === 'worklet' && recoveries <= MAX_RECOVERIES) buildWorkletSource(init);
      else { dspMode = 'script'; await buildScriptSource(init); }
    } catch (err) {
      console.error('[audio] could not rebuild the DSP', err);
      dspMode = 'script';
      await buildScriptSource(init);
    }
    if (terrain) terrain.resendAll();
    events.emit('state', { state: ctx.state, mode: dspMode });
  }

  // A processor that throws is dead for good: rebuild it. After repeated
  // failures the main-thread host takes over.
  async function recover(reason) {
    if (disposed) return;
    console.error('[audio] the DSP processor stopped', reason);
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
  const onState = () => {
    events.emit('state', { state: ctx.state, mode: dspMode });
    // iOS/Safari 'interrupted' (calls, other apps) ends on its own; asking to
    // resume lets it come back as soon as the system allows.
    if (ctx.state === 'interrupted') resumeIfWanted();
  };
  const onVisibility = () => { if (typeof document !== 'undefined' && !document.hidden) resumeIfWanted(); };
  const gestureEvents = ['pointerdown', 'keydown', 'touchend'];
  if (ctx) {
    if (typeof ctx.addEventListener === 'function') ctx.addEventListener('statechange', onState);
    else ctx.onstatechange = onState;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
      for (const ev of gestureEvents) document.addEventListener(ev, resumeIfWanted, { capture: true, passive: true });
    }
  }

  // ---- level meter -----------------------------------------------------------------------
  const levelBuf = ctx ? new Float32Array(fx.analyser.fftSize) : null;
  let levelVal = 0, levelAt = 0;

  let outputDeviceId = 'default';

  const post = (msg) => { sync.flush(); send(msg); };

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
    bend(part, v) { if (validPart(part) && Number.isFinite(v)) post({ t: 'bend', part, v: Math.max(-1, Math.min(1, v)) }); },
    wheel(part, v) { if (validPart(part) && Number.isFinite(v)) post({ t: 'wheel', part, v: Math.max(0, Math.min(1, v)) }); },
    /** Anchor tempo-synced LFOs to the sequencer: beat `beat` sounds at audio time `beatTime`. */
    setTransport({ playing = false, beatTime = 0, beat = 0, spb } = {}) {
      const msgs = [];
      if (Number.isFinite(spb) && spb > 0) msgs.push({ t: 'global', p: { tempo: 60 / spb } });
      msgs.push({ t: 'transport', playing: !!playing, beatTime: Number.isFinite(beatTime) ? beatTime : 0, beat: Number.isFinite(beat) ? beat : 0 });
      sync.flush();
      send(msgs);
    },

    on(name, fn) { return events.on(name, fn); },
    off(name, fn) { events.off(name, fn); },

    getTerrain(part, slot) { return terrain.get(part, slot); },
    /** Resolves when every part's terrain tables match the store (tests, loading screens). */
    whenTerrainsReady() { return terrain.whenIdle(); },
    importTerrainFile(part, slot, file) { return importIntoStore(store, part, slot, file); },

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
      if (!ctx) throw new Error('Audio output is not available in this browser');
      if (typeof ctx.setSinkId !== 'function') throw new Error('This browser cannot choose an audio output; change it in your system sound settings');
      const sink = !id || id === 'default' ? '' : String(id);
      await ctx.setSinkId(sink);
      outputDeviceId = sink || 'default';
      events.emit('state', { state: ctx.state, mode: dspMode, sinkId: outputDeviceId });
      return outputDeviceId;
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
      sync.dispose();
      generator.dispose();
      if (recorder) recorder.dispose();
      teardownSource();
      if (fx) fx.dispose();
      events.clear();
      if (ctx) {
        if (typeof ctx.removeEventListener === 'function') ctx.removeEventListener('statechange', onState);
        try { await ctx.close(); } catch { /* already closed */ }
      }
    },
  };

  return engine;
}
