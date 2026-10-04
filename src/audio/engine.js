// Oro audio host: AudioContext, the DSP (AudioWorklet, or a
// ScriptProcessor running the same OroDSP class on the main thread when
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
import looperCode from 'virtual:worklet:src/audio/looper-worklet.js';
import terrainWorkerCode from 'virtual:worklet:src/audio/terrain-worker.js';
import { MAX_PARTS } from '../core/params.js';
import { partCount, watchTracks, permute } from '../core/tracks.js';
import { createEmitter } from './emitter.js';
import { createFx, volumeGain } from './fx.js';
import { createListen, LISTEN_VALUES } from './listen.js';
import { SURROUND_LAYOUTS } from '../dsp/spatial.js';
import { createStoreSync } from './sync.js';
import { createTerrainGenerator } from './terrain-generator.js';
import { createTerrainManager } from './terrain-manager.js';
import { createRecorder, MAX_RECORD_SECONDS } from './recorder.js';
import { createLooper } from './looper.js';
import { decodeNoiseRecording } from '../dsp/noise-recording.js';
import { importNoiseRecording } from './noise-import.js';
import { importTerrainFile as importIntoStore, importStats } from './importers.js';
import { wavHeader } from './wav.js';
import { loadWorkletModule, withTimeout } from './worklet-loader.js';
import { bounceOptions, normaliseEvents, stemParts, passInit, renderPass, encodeBuffer } from './bounce.js';
import { sequencerEvents } from './bounce-events.js';
import { renderFrozenLoop } from './freeze.js';
import { createPedalHost } from './pedal-host.js';
import { createVoiceHost } from './voice-host.js';
import { dryDelaySamples, MAX_COMP_MS } from '../pedals/latency-comp.js';
import { OPERATOR_ACTIONS } from '../dsp/damage.js';

export { loadWorkletModule };

const SCRIPT_BUFFER = 1024;
const RESUME_TIMEOUT_MS = 2500;
const MAX_RECOVERIES = 3;
export const QUALITY_MODES = Object.freeze(['eco', 'standard', 'high', 'pristine', 'raw']);

// Any of the DSP's MAX_PARTS slots; note-ons are further limited to the
// tracks that exist (see engine.noteOn), the DSP ignores the rest anyway.
function validPart(part) {
  return Number.isInteger(part) && part >= 0 && part < MAX_PARTS;
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
 * @param {number} [o.sampleRate] request a context rate (default: the device's). The
 *   context cannot be swapped later: Settings > Pedals stores the choice and main.js
 *   passes it here on the next start (src/pedals/rig-settings.js).
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
      // A rate the browser or device refuses (96 kHz on some hardware): run at the device's own rate.
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch {
        try { ctx = new AC(); } catch (err) { console.warn('[audio] Web Audio is unavailable', err); ctx = null; }
      }
    }
  }

  let dspMode = 'none';
  let workletVia = null;
  const loadErrors = [];
  let recorderWorklet = false;
  let looperWorklet = false;
  if (ctx) {
    if (wantMode !== 'script') {
      const [main, rec, loop] = await Promise.all([loadWorkletModule(ctx, workletCode), loadWorkletModule(ctx, recorderCode), loadWorkletModule(ctx, looperCode)]);
      if (main.ok) { dspMode = 'worklet'; workletVia = main.via; } else loadErrors.push(...main.errors);
      recorderWorklet = rec.ok;
      looperWorklet = loop.ok;
    }
    if (dspMode === 'none') dspMode = 'script';
  }

  let fx = null;
  let send = () => {};            // (msg | msg[], transfer?) -> DSP
  let node = null;                // AudioWorkletNode or ScriptProcessorNode
  let scriptParts = [];           // extra nodes of the script host
  let recoveries = 0;
  let lastTele = null, lastLoad = null;
  let disposed = false;

  // v2.9 Operator panel: the latest damage reading, so a rebuilt DSP and a bounce start from it
  let opReading = null;
  let notesPlayed = 0;
  const onTele = (m) => { lastTele = m; if (m.op) opReading = m.op; events.emit('tele', m); };

  // Host state the DSP needs that does not live in the persisted store: the
  // quality mode (device setting), the channel controllers and the transport
  // anchor. snapshot() replays it, so a rebuilt DSP keeps playing the same way.
  let quality = QUALITY_MODES.includes(store.get('ui.audioQuality')) ? store.get('ui.audioQuality') : 'standard';
  let controllers = Array.from({ length: MAX_PARTS }, () => ({ bend: 0, wheel: 0, pressure: 0, slide: 0, expression: 0, sustainLevel: 0, breath: 0 }));
  let marbles = Array.from({ length: MAX_PARTS }, () => null);
  // v2.8 frozen loops ({t:'freeze'} messages) per track slot, replayed into a rebuilt DSP
  let frozenMsgs = Array.from({ length: MAX_PARTS }, () => null);
  let transportMsg = null;
  // v1.1 pedal loop state the DSP needs back after a rebuild.
  let pedalMsg = null, guitarMsg = null, dryDelayMsg = null;
  let voiceMsg = null;            // v1.4 Voice Level link source
  let weatherMsg = null;          // v2.10 live weather link sources
  let padMsg = null;              // v2.11 game controller right stick link sources
  let surroundMsg = null;         // 2.12 live surround ({t:'surround', layout, spread}) while it is on
  let pedalCompMs = 0;
  const hostState = () => {
    const out = [{ t: 'quality', mode: quality }];
    if (pedalMsg && pedalMsg.active) out.push({ ...pedalMsg });
    if (dryDelayMsg && dryDelayMsg.samples) out.push({ ...dryDelayMsg });
    if (guitarMsg && guitarMsg.v) out.push({ ...guitarMsg });
    if (voiceMsg && voiceMsg.v) out.push({ ...voiceMsg });
    if (weatherMsg) out.push({ ...weatherMsg, snap: true });
    if (padMsg) out.push({ ...padMsg, snap: true });
    if (surroundMsg) out.push({ ...surroundMsg });
    controllers.forEach((c, part) => {
      if (c.bend) out.push({ t: 'bend', part, v: c.bend });
      if (c.wheel) out.push({ t: 'wheel', part, v: c.wheel });
      if (c.pressure) out.push({ t: 'pressure', part, v: c.pressure });
      if (c.slide) out.push({ t: 'slide', part, v: c.slide });
      for (const source of ['expression','sustainLevel','breath']) if (c[source]) out.push({ t: source, part, v: c[source] });
    });
    marbles.forEach((m) => { if (m) out.push({ ...m }); });
    if (transportMsg && transportMsg.playing) out.push({ ...transportMsg });
    if (opReading && (opReading.dmg > 0 || opReading.wet > 0)) out.push({ t: 'opState', dmg: opReading.dmg, wet: opReading.wet, dir: opReading.dir });
    return out;
  };

  const sync = createStoreSync({
    store,
    sampleRate: () => ctx?.sampleRate || 48000,
    post: (msgs) => send(msgs),
    onGlobal: (g, changed) => { if (fx) fx.set(g, changed); },
    extra: hostState,
  });
  // Channel controllers and marble readings follow their tracks when the
  // track list is reordered; a new track starts at rest. (The sync above has
  // already told the DSP, which moves its parts the same way.)
  const offTracks = watchTracks(store, ({ perm, fresh }) => {
    controllers = permute(controllers, perm, fresh, () => ({ bend: 0, wheel: 0, pressure: 0, slide: 0, expression: 0, sustainLevel: 0, breath: 0 }));
    marbles = permute(marbles, perm, fresh, () => null);
    frozenMsgs = permute(frozenMsgs, perm, fresh, () => null);
    for (let p = partCount(store); p < MAX_PARTS; p++) { controllers[p] = { bend: 0, wheel: 0, pressure: 0, slide: 0, expression: 0, sustainLevel: 0, breath: 0 }; marbles[p] = null; frozenMsgs[p] = null; }
    marbles.forEach((m, p) => { if (m) marbles[p] = { ...m, part: p }; });
    frozenMsgs.forEach((m, p) => { if (m) frozenMsgs[p] = { ...m, part: p }; });
  });

  function buildWorkletSource(init) {
    // Output 3 is the v1.1 pedal send bus (silent until the pedal loop runs).
    // 2.12 live surround adds a fifth output, one channel per speaker
    const surN = surroundMsg ? SURROUND_LAYOUTS[surroundMsg.layout].channels : 0;
    const n = new AudioWorkletNode(ctx, 'orograph', {
      numberOfInputs: 0,
      numberOfOutputs: surN ? 5 : 4,
      outputChannelCount: surN ? [2, 2, 2, 2, surN] : [2, 2, 2, 2],
      processorOptions: { sampleRate: ctx.sampleRate, init, measureLoad: true },
    });
    n.port.onmessage = (e) => {
      const m = e.data;
      if (m && m.t === 'tele') onTele(m);
      else if (m?.t === 'load') { lastLoad = m; events.emit('load', m); }
      else if (m?.t === 'resoGpu') onResoGpu(m);
    };
    n.onprocessorerror = (e) => recover(e);
    n.connect(fx.dryIn, 0);
    n.connect(fx.delayIn, 1);
    n.connect(fx.reverbIn, 2);
    n.connect(pedalSendBus, 3);
    if (surN && surroundOut) n.connect(surroundOut, 4);
    node = n;
    send = (msgs, transfer) => {
      try { n.port.postMessage(msgs, transfer || []); } catch (err) { console.error('[audio] post to DSP failed', err); }
    };
  }

  async function buildScriptSource(init) {
    const { OroDSP } = await import('../dsp/dsp-core.js');
    const dsp = new OroDSP(ctx.sampleRate);
    dsp.postMessage = (m) => { if (m && m.t === 'tele') onTele(m); else if (m && m.t === 'resoGpu') onResoGpu(m); };
    for (const m of init) dsp.handleMessage(m);
    let sp;
    try { sp = ctx.createScriptProcessor(SCRIPT_BUFFER, 0, 8); } catch { sp = ctx.createScriptProcessor(SCRIPT_BUFFER, 1, 8); }
    sp.onaudioprocess = (e) => {
      const ob = e.outputBuffer;
      const t = Number.isFinite(e.playbackTime) ? e.playbackTime : ctx.currentTime;
      try {
        const ped = ob.numberOfChannels >= 8;
        dsp.process(ob.getChannelData(0), ob.getChannelData(1), ob.getChannelData(2), ob.getChannelData(3),
          ob.getChannelData(4), ob.getChannelData(5), ob.length, t,
          ped ? ob.getChannelData(6) : null, ped ? ob.getChannelData(7) : null);
      } catch (err) {
        for (let c = 0; c < ob.numberOfChannels; c++) ob.getChannelData(c).fill(0);
        if (!buildScriptSource.warned) { buildScriptSource.warned = true; console.error('[audio] DSP failed in the ScriptProcessor', err); }
      }
    };
    const split = ctx.createChannelSplitter(8);
    sp.connect(split);
    const targets = [fx.dryIn, fx.delayIn, fx.reverbIn, pedalSendBus];
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
        const init = [...sync.snapshot(), ...(terrain ? terrain.messages() : []), ...frozenMsgs.filter(Boolean)];
        try {
          if (dspMode === 'worklet' && recoveries <= MAX_RECOVERIES) buildWorkletSource(init);
          else { dspMode = 'script'; await buildScriptSource(init); }
        } catch (err) {
          console.error('[audio] could not rebuild the DSP', err);
          dspMode = 'script';
          await buildScriptSource(init);
        }
        events.emit('state', { state: ctx.state, mode: dspMode });
        // a new DSP needs its own link to the GPU Resonator host
        if (resoGpu) { const port = resoGpu.connect(); send([{ t: 'resoGpu', op: 'attach', port, grid: resoGpuGrid }], [port]); }
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

  // mainOut: the master output on its way to the device. The pedal host moves
  // it onto outputs 1/2 of a multichannel map when the pedal send is on.
  let mainOut = null, pedalSendBus = null, pedals = null;
  // 2.12 listening modes (src/audio/listen.js): after every capture point, right before mainOut
  let listen = null;
  // 2.12 live surround: the DSP's fifth output -> master volume -> device channels 3 and up
  let surroundOut = null;
  // v1.4 voice input; looperIn sums the master tap and the voice while its Monitor is off.
  let voice = null, looperIn = null;
  if (ctx) {
    const stereoNode = () => { const g = ctx.createGain(); g.channelCount = 2; g.channelCountMode = 'explicit'; g.channelInterpretation = 'speakers'; return g; };
    mainOut = stereoNode();
    mainOut.connect(ctx.destination);
    pedalSendBus = stereoNode();
    listen = createListen(ctx, mainOut, LISTEN_VALUES.includes(store.get('ui.listenMode')) ? store.get('ui.listenMode') : 'normal');
    fx = createFx(ctx, {
      destination: listen.input,
      global: store.get('global') || {},
      // Reverb impulse responses are built by the same worker pool as terrains.
      computeIR: (opts) => genPromise.then(g => g.run({ kind: 'ir', ...opts })),
    });
    try {
      pedals = createPedalHost(ctx, {
        sendBus: pedalSendBus, mainOut, masterIn: fx.dryIn, delayIn: fx.delayIn, reverbIn: fx.reverbIn,
        post: (m) => {
          if (m.t === 'pedal') pedalMsg = m; else if (m.t === 'guitar') guitarMsg = m;
          sync.flush(); send(m);
        },
      });
    } catch (err) {
      console.warn('[audio] the pedal loop is unavailable', err);
      pedals = null;
    }
    looperIn = stereoNode();
    fx.masterTap.connect(looperIn);
    try {
      voice = createVoiceHost(ctx, {
        masterIn: fx.dryIn, delayIn: fx.delayIn, reverbIn: fx.reverbIn, loopIn: looperIn,
        post: (m) => { voiceMsg = m; sync.flush(); send(m); },
      });
    } catch (err) {
      console.warn('[audio] voice input is unavailable', err);
      voice = null;
    }
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

  // v1.2 looper: hears the master after the effects (fx.masterTap, through
  // looperIn, which also carries the unmonitored voice) and plays into the
  // limiter input (fx.masterReturn). See src/audio/looper.js.
  const looper = createLooper(ctx, { input: looperIn, output: fx ? fx.masterReturn : null, worklet: looperWorklet });

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
    // A different device can have a different number of outputs.
    if (pedals) pedals.refresh();
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

  // 2.12 GPU Resonator: store ui.resoEngine ('cpu' | 'gpu', session only) and
  // ui.resoGpuDetail (128 | 192 | 256). The GPU code loads only when chosen.
  let resoGpu = null, resoGpuGrid = null, resoGpuSeq = 0;
  const resoGrid = () => ({ n: [128, 192, 256].includes(Number(store.get('ui.resoGpuDetail'))) ? Number(store.get('ui.resoGpuDetail')) : 128, sub: { 128: 16, 192: 24, 256: 32 }[Number(store.get('ui.resoGpuDetail'))] || 16 });
  function onResoGpu(m) {
    events.emit('resoGpu', m);
    if (m.ev === 'fallback' && store.get('ui.resoEngine') === 'gpu') store.set('ui.resoEngine', 'cpu', { source: 'engine' });
  }
  async function applyResoEngine() {
    const seq = ++resoGpuSeq;
    const want = store.get('ui.resoEngine') === 'gpu' && !disposed;
    const grid = resoGrid();
    if (!want || (resoGpuGrid && resoGpuGrid.n !== grid.n)) {
      if (resoGpu) { send({ t: 'resoGpu', op: 'detach' }); resoGpu.dispose(); resoGpu = null; resoGpuGrid = null; events.emit('resoGpu', { ev: 'stopped' }); }
      if (!want) return;
    }
    if (resoGpu) return;
    try {
      const mod = await import('./reso-gpu.js');
      const g = await mod.createResoGpu({ onStatus: (st) => {
        events.emit('resoGpu', { ev: 'host', ...st });
        if (st.lost) onResoGpu({ t: 'resoGpu', ev: 'fallback', reason: st.reason });
      } });
      if (seq !== resoGpuSeq || disposed) { g.dispose(); return; }
      resoGpu = g; resoGpuGrid = grid;
      const port = g.connect();
      send([{ t: 'resoGpu', op: 'attach', port, grid }], [port]);
      events.emit('resoGpu', { ev: 'started', where: g.where, latencyMs: 1000 * (await import('../dsp/reso-gpu-plan.js')).gpuLatencySec(ctx ? ctx.sampleRate : 48000) });
    } catch (err) {
      if (seq === resoGpuSeq) onResoGpu({ t: 'resoGpu', ev: 'fallback', reason: String((err && err.message) || err) });
    }
  }
  const offResoEngine = [store.subscribe('ui.resoEngine', applyResoEngine), store.subscribe('ui.resoGpuDetail', applyResoEngine)];
  /**
   * Bounce and stems with the GPU engine on: render the pass's membranes on
   * the GPU first (reso-gpu.js offlineResoInit) and return the extra init
   * messages that play them, or null (GPU engine off, no Resonator in the
   * pass, or the GPU failed: the pass then uses the CPU Resonator).
   */
  async function gpuResoInit({ init, late, frames, sampleRate, isCancelled = null }) {
    if (!resoGpu) return null;
    try {
      return await (await import('./reso-gpu.js')).offlineResoInit(resoGpu, { init, late, frames, sampleRate, grid: resoGpuGrid, isCancelled });
    } catch (err) {
      if (!(err && err.message === 'cancelled')) console.warn('[audio] GPU Resonator render fell back to the CPU', err);
      return null;
    }
  }

  // 2.12 listening mode: a per-computer preference in store.ui
  const offListen = store.subscribe('ui.listenMode', () => { if (listen) listen.set(store.get('ui.listenMode')); });

  // 2.12 live surround. Only with the AudioWorklet engine, an output device
  // that reports 6 (5.1) or 8 (7.1) channels and the pedal send off (it uses
  // the extra outputs itself). Untested on real surround hardware.
  function surroundSupport() {
    const max = ctx && ctx.destination ? ctx.destination.maxChannelCount || 2 : 0;
    const pedalOn = !!(pedals && pedals.status().enabled);
    const layouts = Object.values(SURROUND_LAYOUTS).filter(L => L.channels <= max).map(L => L.id);
    let reason = null;
    if (!ctx) reason = 'The audio engine is not running.';
    else if (dspMode !== 'worklet') reason = 'Surround playback needs the AudioWorklet engine, which this browser is not using.';
    else if (max < 6) reason = `Your audio device reports only ${max} output${max === 1 ? '' : 's'}. Surround playback needs 6 (5.1) or 8 (7.1).`;
    else if (pedalOn) reason = 'The pedal send uses the extra outputs. Switch it off in Settings > Pedals to play surround.';
    return { ok: !reason, reason, maxChannels: max, layouts, layout: surroundMsg ? surroundMsg.layout : null };
  }
  async function setSurround(layout, spread = 0) {
    const want = layout && SURROUND_LAYOUTS[layout] && surroundSupport().layouts.includes(layout) && surroundSupport().ok ? layout : null;
    const before = surroundMsg ? surroundMsg.layout : null;
    if (want === before && (!want || surroundMsg.spread === spread)) return surroundSupport();
    if (surroundOut) { try { surroundOut.disconnect(); } catch { /* ignore */ } surroundOut = null; }
    if (want) {
      const N = SURROUND_LAYOUTS[want].channels;
      surroundMsg = { t: 'surround', layout: want, spread: Math.max(0, Math.min(1, +spread || 0)) };
      try { ctx.destination.channelCount = N; ctx.destination.channelInterpretation = 'discrete'; } catch (err) { console.warn('[audio] surround outputs could not be set', err); }
      surroundOut = ctx.createGain();
      surroundOut.channelCount = N; surroundOut.channelCountMode = 'explicit'; surroundOut.channelInterpretation = 'discrete';
      surroundOut.gain.value = volumeGain(Number(store.get('global.masterVolume') ?? 0.8));
      surroundOut.connect(ctx.destination);
    } else {
      surroundMsg = null;
      try { ctx.destination.channelCount = 2; ctx.destination.channelInterpretation = 'speakers'; } catch { /* ignore */ }
    }
    if (want !== before) await rebuildSource();
    else post(surroundMsg || { t: 'surround', layout: null });
    return surroundSupport();
  }
  const applyLiveSurround = () => {
    const v = store.get('ui.liveSurround');
    setSurround(v === '5.1' || v === '7.1' ? v : null).catch(err => console.warn('[audio] surround playback failed', err));
  };
  const offLiveSur = store.subscribe('ui.liveSurround', applyLiveSurround);
  if (ctx && store.get('ui.liveSurround') && store.get('ui.liveSurround') !== 'off') applyLiveSurround();
  const offSurVol = store.subscribe('global.masterVolume', () => {
    if (surroundOut) surroundOut.gain.setTargetAtTime(volumeGain(Number(store.get('global.masterVolume') ?? 0.8)), ctx.currentTime, 0.02);
  });

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

  // The session for an offline render at rate `sr`, starting at beat 0. The
  // live transport anchor is in live context seconds; an offline render
  // starts its bar at 0 (events from music.renderEvents say so too). The
  // pedals are hardware and cannot take part in an offline render: it plays
  // every part dry (Insert ignored, no pedal send).
  function offlineSnapshot(sr) {
    const snapshot = sync.snapshot().filter(m => m.t !== 'transport' && m.t !== 'pedal' && m.t !== 'guitar' && m.t !== 'voiceLevel' && m.t !== 'dryDelay' && m.t !== 'surround').map(m => m.t === 'noiseRecording' ? { ...m, data: decodeNoiseRecording(store.get(`parts.${m.part}.noiseRecording`), sr) } : m);
    snapshot.push({ t: 'transport', playing: true, beatTime: 0, beat: 0, spb: 60 / clamp(Number(store.get('global.tempo')) || 112, 20, 400) });
    return snapshot;
  }

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
    /**
     * v1.2 looper on the master bus (src/audio/looper.js): main(), stop(), undo(), clear(),
     * setBars(n), setVolume(v), setMute(on), setFeedback(v), getLoop(), capture({bars}),
     * exportWav({format}), status(), on('change' | 'pos' | 'info' | 'error', fn).
     * `available` is false (with `reason`) when AudioWorklet cannot load.
     */
    get looper() { return looper; },
    /**
     * v1.1 pedal loop (src/audio/pedal-host.js), or null without Web Audio:
     * configure({enabled, sendChannels, mainChannels, ceilingDb}), setReturn({...}),
     * ping(), resetGuard(), status(), on('change' | 'guitar' | 'ping', fn).
     */
    get pedals() { return pedals; },
    /**
     * v1.4 voice input (src/audio/voice-host.js), or null without Web Audio:
     * set({enabled, deviceId, cleanup, channels, inputGainDb, monitor, highpass, compressor,
     * deesser, level, pan, delay, reverb, gateDb, bendRange}), meter(), capture(), resetGuard(),
     * status(), on('change' | 'level' | 'voiceNote', fn).
     */
    get voice() { return voice; },
    /**
     * Pedal latency compensation (src/pedals/latency-comp.js): delay the dry
     * sound of Send mode parts (pedal send above 0, Insert off) by `ms` while
     * the pedal send runs, so it lines up with the pedal return. 0 = off.
     * Returns the delay in samples.
     */
    setPedalCompensation(ms) {
      pedalCompMs = Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_COMP_MS) : 0;
      const samples = ctx ? dryDelaySamples(pedalCompMs, ctx.sampleRate) : 0;
      if (dryDelayMsg && dryDelayMsg.samples === samples) return samples;
      dryDelayMsg = { t: 'dryDelay', samples };
      post(dryDelayMsg);
      return samples;
    },
    get pedalCompensationMs() { return pedalCompMs; },

    async start() {
      wantRunning = true;
      if (!ctx) return 'none';
      if (ctx.state !== 'running' && ctx.state !== 'closed') {
        try { await withTimeout(ctx.resume(), RESUME_TIMEOUT_MS, 'resume'); } catch (err) { console.warn('[audio] could not start audio yet', err); }
      }
      return ctx.state;
    },

    noteOn(part, note, vel = 0.8, time = 0, tag) {
      if (!validPart(part) || part >= partCount(store) || !Number.isFinite(note)) return;
      const msg = { t: 'noteOn', part, note, vel: Number.isFinite(vel) ? vel : 0.8, time: Number.isFinite(time) ? time : 0 };
      notesPlayed++;
      if (typeof tag === 'string') msg.tag = tag;
      post(msg);
    },
    noteOff(part, note, time = 0, tag) {
      if (!validPart(part) || !Number.isFinite(note)) return;
      const msg = { t: 'noteOff', part, note, time: Number.isFinite(time) ? time : 0 };
      if (typeof tag === 'string') msg.tag = tag;
      post(msg);
    },
    /**
     * v2.8 audition a drum sound on a drum kit track without putting it on a
     * pad: `sound` is { synth } (a drum library index) or { pcm, rate }.
     */
    previewDrum(part, sound, { vel = 0.9, gain = 0.8, pitch = 0 } = {}) {
      if (!validPart(part) || part >= partCount(store) || !sound) return;
      const msg = { t: 'kitPreview', part, vel: Number.isFinite(vel) ? vel : 0.9, gain: Number.isFinite(gain) ? gain : 0.8, pitch: Number.isFinite(pitch) ? pitch : 0 };
      if (sound.pcm instanceof Float32Array) { msg.pcm = sound.pcm; msg.rate = Number.isFinite(sound.rate) ? sound.rate : 48000; }
      else if (Number.isInteger(sound.synth) && sound.synth >= 0) msg.synth = sound.synth;
      else return;
      post(msg);
    },
    /**
     * v2.9 parameter locks: part parameter values `p` from audio time `time`
     * (0 = now). Only the engine changes; the store keeps the knob values.
     */
    scheduleParams(part, p, time = 0) {
      if (!validPart(part) || part >= partCount(store) || !p || typeof p !== 'object') return;
      post({ t: 'params', part, p: { ...p }, time: Number.isFinite(time) ? time : 0 });
    },
    /** Drop queued notes (with `tag`, if given) that would start after audio time `after`. */
    cancelNotes(after, tag) {
      const msg = { t: 'cancelNotes', after: Number.isFinite(after) ? after : 0 };
      if (typeof tag === 'string') msg.tag = tag;
      post(msg);
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
    /** v2.10 live weather: [wind, rain, temp, clouds] (the DSP glides there over 30 s; snap jumps). */
    setWeather(values, { snap = false } = {}) {
      if (!values || values.length !== 4 || !Array.from(values).every(Number.isFinite)) return;
      weatherMsg = { t: 'weather', v: Array.from(values) };
      post({ ...weatherMsg, snap: !!snap });
    },
    /** 2.11 game controller right stick [x, y], -1..1 (the DSP smooths it). */
    setPadStick(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      padMsg = { t: 'pad', v: [clamp(x, -1, 1), clamp(y, -1, 1)] };
      post(padMsg);
    },
    controlSource(part, source, v) {
      if (!validPart(part) || !['expression','sustainLevel','breath'].includes(source) || !Number.isFinite(v)) return;
      controllers[part][source] = clamp(v, 0, 1); post({ t: source, part, v: controllers[part][source] });
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
      // The looper starts recordings on bar lines and follows Play / Stop.
      looper.transport({ ...t, spb: t.spb || (60 / clamp(Number(store.get('global.tempo')) || 120, 20, 400)) });
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
    /**
     * v2.9 Operator panel actions: 'drop' | 'spill' (value: strength 0..1),
     * 'repair' (value: 'drop' | 'water' | 'all'), 'tone' (value: 'off' | 'sine' | 'pink' | 'left' | 'right' | 'polarity').
     */
    operator(action, value) {
      if (!OPERATOR_ACTIONS.includes(action)) return;
      if (action === 'repair' && opReading) {
        opReading = { ...opReading, dmg: value === 'water' ? opReading.dmg : 0, wet: value === 'drop' ? opReading.wet : 0 };
      }
      post({ t: 'opAction', a: action, v: value });
    },
    /** The latest Operator panel reading from the DSP ({dmg, wet, shock, cents, tone}) or null. */
    operatorState() { return opReading; },
    /** Notes started since the engine was created (Bookkeeping). */
    get notesPlayed() { return notesPlayed; },
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
    importTerrainFile(part, slot, file, options) { return importIntoStore(store, part, slot, file, { decodeAudioData: ctx ? b => ctx.decodeAudioData(b) : undefined, ...options }); },
    async importNoiseFile(part, file) {
      return importNoiseRecording(store, ctx, part, file);
    },

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
        // Frozen tracks render live here: a bounce does not need the CPU saving.
        const snapshot = offlineSnapshot(sr);
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
        // one stem slot per track (null for tracks that play nothing)
        const out = { mix: null, stems: o.stems ? new Array(partCount(store)).fill(null) : [] };
        const info = { passes: [] };
        for (const pass of passes) {
          const stage = pass.solo === null ? 'mix' : 'stem';
          const { init, late } = passInit({ snapshot, terrains, events: evs, solo: pass.solo });
          const gpuInit = await gpuResoInit({ init, late, frames, sampleRate: sr });
          const r = await renderPass({
            sampleRate: sr, frames, init: gpuInit ? [...init, ...gpuInit] : init, late, global, fx: o.fx, workletCode,
            computeIR,
            forceMainThread: (dspMode !== 'worklet' && !opts.worklet) || !!gpuInit,
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

    /**
     * 2.11 stems export (src/audio/stems.js): render `passes` one at a time,
     * handing each AudioBuffer to `onPass(buffer, pass, index)` before the
     * next starts, so only one is held. A pass is { solo, extra, events }
     * (see passInit); `frames(index)` gives each pass its length. Stops
     * between passes when isCancelled() says so (resolves false).
     */
    async renderPasses({ sampleRate, frames, passes = [], onPass, onFrames = () => {}, isCancelled = () => false } = {}) {
      if (disposed) throw new Error('The audio engine was shut down');
      if (bouncing) throw new Error('A bounce is already running');
      bouncing = true;
      try {
        const sr = Math.round(finiteOr(sampleRate, ctx ? ctx.sampleRate : 48000));
        await terrain.whenIdle();
        sync.flush();
        const snapshot = offlineSnapshot(sr);
        const terrains = terrain.messages();
        const global = { ...(store.get('global') || {}) };
        const irs = new Map();
        const computeIR = (irOpts) => {
          const key = JSON.stringify(irOpts);
          if (!irs.has(key)) irs.set(key, genPromise.then(g => g.run({ kind: 'ir', ...irOpts })));
          return irs.get(key);
        };
        for (let i = 0; i < passes.length; i++) {
          if (isCancelled()) return false;
          const pass = passes[i];
          const { init, late } = passInit({ snapshot, terrains, events: pass.events || [], solo: pass.solo ?? null, extra: pass.extra || [] });
          const n = Math.max(QUANTUM_FRAMES, Math.round(typeof frames === 'function' ? frames(i) : frames));
          const gpuInit = await gpuResoInit({ init, late, frames: n, sampleRate: sr, isCancelled });
          if (isCancelled()) return false;
          const r = await renderPass({
            sampleRate: sr, frames: n,
            init: gpuInit ? [...init, ...gpuInit] : init, late, global, fx: true, workletCode, computeIR, tap: pass.tap || null, surround: pass.surround || 0, isCancelled,
            forceMainThread: dspMode !== 'worklet' || !!gpuInit,
            onFrames: (f) => onFrames(i, f),
          });
          if (disposed) throw new Error('The audio engine was shut down');
          await onPass(r.buffer, pass, i);
        }
        return true;
      } finally {
        bouncing = false;
      }
    },

    /**
     * v2.8 Freeze: render track `part`'s loop offline (src/audio/freeze.js):
     * `events` from music.renderEvents starting at beat 0, `beats` the loop
     * length at `tempo`, `warmLoops` passes before the one kept, `others`
     * renders the other tracks too (for a sidechain). Resolves to the loop
     * for setFrozen(); nothing is played until then.
     */
    async renderFreeze(part, { events = [], beats, tempo, warmLoops = 1, others = false, isCancelled, onProgress } = {}) {
      if (disposed) throw new Error('The audio engine was shut down');
      if (!validPart(part)) throw new Error('There is no such track');
      const sr = ctx ? ctx.sampleRate : 48000;
      await terrain.whenIdle();
      sync.flush();
      const evs = normaliseEvents(events);
      const parts = new Set(others ? Array.from({ length: partCount(store) }, (_, i) => i) : [part]);
      const init = [...offlineSnapshot(sr), ...terrain.messages().filter(m => parts.has(m.part))];
      for (const e of evs) if (!Number.isInteger(e.msg.part) || parts.has(e.msg.part)) init.push(e.msg);
      return renderFrozenLoop({ sampleRate: sr, init, part, beats, tempo: tempo || Number(store.get('global.tempo')) || 112, warmLoops, isCancelled, onProgress });
    },
    /** v2.8: play `loop` (from renderFreeze) for track `part` instead of its voices; null goes back to the voices. */
    setFrozen(part, loop) {
      if (!validPart(part)) return;
      if (loop && loop.L && loop.R) {
        const msg = { t: 'freeze', part, L: loop.L, R: loop.R, frames: loop.frames, beats: loop.beats };
        frozenMsgs[part] = msg;
        post(msg);
      } else {
        frozenMsgs[part] = null;
        post({ t: 'freeze', part, L: null });
      }
    },

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
    dspLoad() { return lastLoad; },

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
        if (pedals) pedals.refresh();
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

    /** 2.12 listening mode now playing ('normal', 'headphones', 'mono', 'small', 'swap'). */
    get listenMode() { return listen ? listen.mode : 'normal'; },
    setListenMode(m) { return listen ? listen.set(m) : 'normal'; },
    /** 2.12 live surround: { ok, reason, maxChannels, layouts, layout }. */
    surroundSupport,
    /** 2.12 live surround on ('5.1' / '7.1') or off (null). Rebuilds the DSP node. */
    setSurround,

    /** Diagnostics for tests and the settings panel. */
    stats() {
      return {
        mode: dspMode,
        workletVia,
        loadErrors: [...loadErrors],
        recorder: recorder ? recorder.mode : null,
        looper: looper.available ? looper.status().state : null,
        recoveries,
        state: ctx ? ctx.state : 'none',
        sampleRate: ctx ? ctx.sampleRate : 0,
        latency: engine.latency,
        terrain: terrain.stats(),
        generator: generator.stats(),
        fx: fx ? fx.stats() : null,
        pedals: pedals ? pedals.status() : null,
        listen: listen ? listen.mode : null,
        surround: surroundMsg ? surroundMsg.layout : null,
        voice: voice ? voice.status() : null,
        pedalCompensation: { ms: pedalCompMs, samples: dryDelayMsg ? dryDelayMsg.samples : 0 },
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
      for (const off of offResoEngine) off();
      if (resoGpu) { resoGpu.dispose(); resoGpu = null; }
      offListen();
      offSurVol();
      offLiveSur();
      offTracks();
      sync.dispose();
      generator.dispose();
      if (recorder) recorder.dispose();
      looper.dispose();
      if (pedals) { try { pedals.dispose(); } catch { /* ignore */ } }
      if (voice) { try { voice.dispose(); } catch { /* ignore */ } }
      teardownSource();
      if (listen) listen.dispose();
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
