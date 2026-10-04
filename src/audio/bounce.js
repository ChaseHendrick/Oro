// Offline bounce: render bars of the session faster than real time, sample
// exact, through the same DSP and effect graph as the live engine.
//
// Each pass is an OfflineAudioContext with the 'orograph' worklet and a fresh
// createFx() graph. An offline context does not deliver port messages before
// it renders, so the whole session goes in processorOptions.init: the store
// snapshot, the terrain tables, then every event as a timed protocol message
// (noteOn / noteOff / params carry `time`; the DSP applies them at that sample).
// Messages the protocol cannot time are posted at their moment by suspending
// the render there. Progress also rides on suspend points.
//
// Stems render each track on its own (the others muted, solos cleared) with
// its own sends into the effects, so a stem sounds like that track in the mix:
// one file per track that plays.
// When the context cannot load the worklet, the DSP runs here on the main
// thread in short slices and its three stereo outputs are played through the
// offline effect graph instead.

import { MAX_PARTS } from '../core/params.js';
import { createFx } from './fx.js';
import { encodePCM24, wavBlobFromPieces } from './wav.js';
import { loadWorkletModule } from './worklet-loader.js';

export const MAX_BOUNCE_SECONDS = 15 * 60;
export const MAX_TAIL_SECONDS = 30;
const QUANTUM = 128;
const PROGRESS_POINTS = 24;
const ENCODE_FRAMES = 1 << 16;
const YIELD_MS = 10;
const IR_WAIT_MS = 30000;
// The DSP schedules these by their `time` field (docs/ARCHITECTURE.md, Round D).
const TIMED = new Set(['noteOn', 'noteOff', 'params']);

/** The error a cancelled render rejects with (err.cancelled). */
export function cancelError() { const e = new Error('Export cancelled'); e.name = 'CancelError'; e.cancelled = true; return e; }
const CANCEL_CHECK_FRAMES = 32 * QUANTUM;
const finite = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const yieldTask = () => new Promise(r => setTimeout(r, 0));

/** Bounce options with defaults and limits applied. */
export function bounceOptions(o = {}, tempo = 112) {
  const bars = clamp(Math.round(finite(o.bars, 4)), 1, 512);
  const tailSeconds = clamp(finite(o.tailSeconds, 2), 0, MAX_TAIL_SECONDS);
  const bpm = clamp(finite(tempo, 112), 20, 400);
  const songSeconds = bars * 4 * 60 / bpm;
  if (songSeconds + tailSeconds > MAX_BOUNCE_SECONDS) {
    throw new Error(`That would be ${Math.round(songSeconds + tailSeconds)} s of audio; bounces are limited to ${MAX_BOUNCE_SECONDS / 60} minutes`);
  }
  return { bars, tailSeconds, songSeconds, totalSeconds: songSeconds + tailSeconds, stems: !!o.stems, fx: o.fx !== false };
}

/**
 * Normalise an event list: [{time, msg}] sorted by time, each msg a copy with
 * its `time` set to the event time. Anything malformed is dropped.
 */
export function normaliseEvents(events, songSeconds = Infinity) {
  if (!Array.isArray(events)) return [];
  const out = [];
  events.forEach((e, i) => {
    if (!e || typeof e !== 'object' || !e.msg || typeof e.msg !== 'object' || typeof e.msg.t !== 'string') return;
    const time = Math.max(0, finite(e.time, finite(e.msg.time, 0)));
    // Note-ons at or after the end would only sound in the tail; offs always pass so nothing hangs.
    if (e.msg.t === 'noteOn' && time >= songSeconds) return;
    out.push({ time, msg: { ...e.msg, time }, i });
  });
  out.sort((a, b) => a.time - b.time || a.i - b.i);
  return out.map(({ time, msg }) => ({ time, msg }));
}

/** Parts that get a stem: they play at least one note and are heard in the mix (not muted, solo rules). */
export function stemParts(state, events) {
  const parts = (state && state.parts) || [];
  const anySolo = parts.some(p => p && p.params && p.params.solo);
  const playing = new Set(events.filter(e => e.msg.t === 'noteOn').map(e => e.msg.part));
  const out = [];
  for (let i = 0; i < Math.min(parts.length, MAX_PARTS); i++) {
    const pr = (parts[i] && parts[i].params) || {};
    if (!playing.has(i) || pr.mute || (anySolo && !pr.solo)) continue;
    out.push(i);
  }
  return out;
}

/**
 * The processorOptions.init list for one pass. `solo` = part index for a
 * stem (everything else muted, solos cleared) or null for the mix.
 */
export function passInit({ snapshot, terrains = [], events, solo = null, extra = [] }) {
  const init = [...snapshot, ...extra];
  if (solo !== null) {
    // every track in the snapshot's list (the DSP's other parts are silent anyway)
    const tracks = snapshot.find(m => m && m.t === 'tracks');
    const count = tracks && Number.isInteger(tracks.count) ? Math.min(tracks.count, MAX_PARTS) : MAX_PARTS;
    for (let p = 0; p < count; p++) init.push({ t: 'params', part: p, p: { mute: p === solo ? 0 : 1, solo: 0 } });
  }
  // Only parts that play in this pass need their tables: processorOptions are
  // copied on the main thread, and each track's mip chains are ~2.8 MB.
  const playing = new Set(events.filter(e => e.msg.t === 'noteOn' && (solo === null || e.msg.part === solo)).map(e => e.msg.part));
  for (const m of terrains) if (playing.has(m.part)) init.push(m);
  // No telemetry from an offline render (nobody listens, and it would flood the port).
  init.push({ t: 'watch', part: -1 });
  const late = [];
  for (const e of events) {
    if (solo !== null && Number.isInteger(e.msg.part) && e.msg.part !== solo) continue;
    if (TIMED.has(e.msg.t) || e.time <= 0) init.push(e.msg);
    else late.push(e);
  }
  return { init, late };
}

function statsOf(chans, f, n, acc) {
  for (const d of chans) {
    for (let i = f; i < f + n; i++) {
      const v = d[i];
      if (!Number.isFinite(v)) { acc.bad++; continue; }
      const a = v < 0 ? -v : v;
      if (a > acc.peak) acc.peak = a;
      acc.sum += v * v;
    }
    acc.n += n;
  }
}

/**
 * Interleaved 24-bit WAV from an AudioBuffer, encoded in slices so the page
 * stays responsive, with its peak and RMS measured on the way.
 * @returns {Promise<{blob: Blob, stats: {peak, rms, bad}}>}
 */
export async function encodeBuffer(buffer) {
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const pieces = [];
  const acc = { peak: 0, sum: 0, bad: 0, n: 0 };
  let t0 = nowMs();
  for (let f = 0; f < buffer.length; f += ENCODE_FRAMES) {
    const n = Math.min(ENCODE_FRAMES, buffer.length - f);
    statsOf(chans, f, n, acc);
    pieces.push(encodePCM24(chans.map(ch => ch.subarray(f, f + n)), n));
    if (nowMs() - t0 > YIELD_MS) { await yieldTask(); t0 = nowMs(); }
  }
  const blob = wavBlobFromPieces({ sampleRate: buffer.sampleRate, channels: chans.length, frames: buffer.length, pieces });
  return { blob, stats: { peak: acc.peak, rms: Math.sqrt(acc.sum / Math.max(1, acc.n)), bad: acc.bad } };
}

/** Interleaved 24-bit WAV Blob from an AudioBuffer (see encodeBuffer). */
export async function audioBufferToWav(buffer) {
  return (await encodeBuffer(buffer)).blob;
}

/** Peak and RMS of a rendered buffer (diagnostics, tests). */
export function bufferStats(buffer) {
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const acc = { peak: 0, sum: 0, bad: 0, n: 0 };
  statsOf(chans, 0, buffer.length, acc);
  return { peak: acc.peak, rms: Math.sqrt(acc.sum / Math.max(1, acc.n)), bad: acc.bad };
}

/**
 * Render with the DSP on this thread (no worklet in the offline context):
 * returns its dry / delay / reverb outputs as three stereo AudioBuffers.
 */
export async function renderDspHere(octx, init, late, frames, onFrames = () => {}, isCancelled = null, surN = 0) {
  const { OroDSP } = await import('../dsp/dsp-core.js');
  const sr = octx.sampleRate;
  const dsp = new OroDSP(sr);
  dsp.postMessage = () => {};
  for (const m of init) dsp.handleMessage(m);
  const bufs = [0, 1, 2].map(() => octx.createBuffer(2, frames, sr));
  const ch = bufs.flatMap(b => [b.getChannelData(0), b.getChannelData(1)]);
  // 2.12 surround pass: a fourth buffer, one channel per speaker (0 and 1 stay silent: they are bufs[0])
  const surBuf = surN ? octx.createBuffer(surN, frames, sr) : null;
  if (surBuf) bufs.push(surBuf);
  const surCh = surBuf ? Array.from({ length: surN }, (_, c) => surBuf.getChannelData(c)) : null;
  let li = 0;
  let t0 = nowMs();
  for (let f = 0; f < frames; f += QUANTUM) {
    const n = Math.min(QUANTUM, frames - f);
    const t = f / sr;
    while (li < late.length && late[li].time <= t + 1e-9) dsp.handleMessage(late[li++].msg);
    dsp.process(ch[0].subarray(f, f + n), ch[1].subarray(f, f + n), ch[2].subarray(f, f + n), ch[3].subarray(f, f + n),
      ch[4].subarray(f, f + n), ch[5].subarray(f, f + n), n, t, null, null, surCh ? surCh.map(c => c.subarray(f, f + n)) : null);
    if (isCancelled && (f & (CANCEL_CHECK_FRAMES - 1)) === 0 && isCancelled()) throw cancelError();
    if (nowMs() - t0 > YIELD_MS) { onFrames(f + n); await yieldTask(); t0 = nowMs(); if (isCancelled && isCancelled()) throw cancelError(); }
  }
  onFrames(frames);
  return bufs;
}

/**
 * One offline pass -> AudioBuffer.
 * @param {object} o
 * @param {number} o.sampleRate
 * @param {number} o.frames
 * @param {object[]} o.init processorOptions.init messages
 * @param {{time, msg}[]} o.late messages to post at their time
 * @param {object} o.global effect settings (store global)
 * @param {boolean} o.fx
 * @param {string} o.workletCode
 * @param {Function} [o.computeIR]
 * @param {(frames: number) => void} [o.onFrames] progress within the pass
 */
export async function renderPass({ sampleRate, frames, init, late = [], global = {}, fx = true, workletCode, computeIR = null, onFrames = () => {}, forceMainThread = false, tap = null, isCancelled = null, surround = 0 }) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OAC) throw new Error('This browser cannot render offline; use Record instead');
  // 2.12 surround (surround = channel count, 6 or 8): the DSP's dry speaker
  // feeds straight to the file, no effects (the planner zeroes every send;
  // the returns come from a separate stereo pass)
  const surN = surround >= 6 ? surround : 0;
  const octx = new OAC({ numberOfChannels: surN || 2, length: frames, sampleRate });
  if (surN) { octx.destination.channelCount = surN; octx.destination.channelInterpretation = 'discrete'; }
  // v2.11 tap 'bus': record the sum before the master chorus, warmth, volume and limiter
  const sink = tap === 'bus' && !surN ? octx.createGain() : null;
  const graph = surN ? { dispose() {}, whenReverbReady: () => Promise.resolve() } : createFx(octx, { global, destination: sink || octx.destination, computeIR, effects: fx });
  if (sink) graph.bus.connect(octx.destination);
  let cancelled = false, rejectCancel = null;
  const cancelled$ = new Promise((_, reject) => { rejectCancel = reject; });
  cancelled$.catch(() => {});
  const sends = (connect) => {
    if (surN) { connect(octx.destination, 0); connect(octx.destination, 4); return; }
    connect(graph.dryIn, 0); if (fx) { connect(graph.delayIn, 1); connect(graph.reverbIn, 2); }
  };
  // Suspend points: frame -> actions, merged so two never share a render quantum.
  const points = new Map();
  const at = (frame, fn) => {
    const q = Math.max(QUANTUM, Math.min(frames - QUANTUM, Math.round(frame / QUANTUM) * QUANTUM));
    if (q <= 0 || q >= frames) return false;
    if (!points.has(q)) points.set(q, []);
    points.get(q).push(fn);
    return true;
  };
  let via = 'worklet';
  let node = null;
  const loaded = !forceMainThread && workletCode ? await loadWorkletModule(octx, workletCode) : { ok: false };
  if (loaded.ok) {
    node = new AudioWorkletNode(octx, 'orograph', surN ? {
      numberOfInputs: 0, numberOfOutputs: 5, outputChannelCount: [2, 2, 2, 2, surN],
      processorOptions: { sampleRate, init },
    } : {
      numberOfInputs: 0, numberOfOutputs: 3, outputChannelCount: [2, 2, 2],
      processorOptions: { sampleRate, init },
    });
    sends((dst, out) => node.connect(dst, out));
    const early = [];
    for (const e of late) if (!at(Math.round(e.time * sampleRate), () => node.port.postMessage(e.msg))) early.push(e.msg);
    if (early.length) node.port.postMessage(early);
    for (let k = 1; k < PROGRESS_POINTS; k++) { const f = Math.round(frames * k / PROGRESS_POINTS); at(f, () => onFrames(f)); }
    // v2.11 cancel: look every half second of audio and stop there (the context is left suspended)
    if (isCancelled) for (let f = Math.round(sampleRate / 2); f < frames; f += Math.round(sampleRate / 2)) at(f, () => { if (!cancelled && isCancelled()) { cancelled = true; rejectCancel(cancelError()); } });
  } else {
    via = 'main-thread';
    let bufs;
    try { bufs = await renderDspHere(octx, init, late, frames, (f) => onFrames(0.5 * f), isCancelled, surN); }
    catch (err) { graph.dispose(); throw err; }
    sends((dst, out) => {
      const s = octx.createBufferSource();
      s.buffer = bufs[out === 4 ? 3 : out];
      s.connect(dst);
      s.start(0);
    });
    for (let k = 1; k < PROGRESS_POINTS; k++) { const f = Math.round(frames * k / PROGRESS_POINTS); at(f, () => onFrames(0.5 * (frames + f))); }
  }
  for (const [frame, fns] of points) {
    octx.suspend(frame / sampleRate).then(() => {
      for (const fn of fns) { try { fn(); } catch (err) { console.error('[audio] bounce step failed', err); } }
      if (cancelled) return undefined;
      return octx.resume();
    }).catch((err) => console.error('[audio] bounce suspend failed', err));
  }
  // The impulse response is built by a worker; never wait on it forever.
  await Promise.race([graph.whenReverbReady(), new Promise(r => setTimeout(r, IR_WAIT_MS))]);
  let buffer;
  try {
    buffer = isCancelled ? await Promise.race([octx.startRendering(), cancelled$]) : await octx.startRendering();
  } finally {
    try { if (node) { node.port.onmessage = null; node.disconnect(); } } catch { /* ignore */ }
    graph.dispose();
  }
  onFrames(frames);
  return { buffer, via };
}
