// Looper host (v1.2): the 'orograph-looper' AudioWorkletNode on the master bus
// and a small promise API around its messages. See looper-core.js for the
// behaviour and engine.js for where it sits:
//
//   ... chorus -> warmth -> volume ──┬──> ceiling -> limiter -> clip -> out (recorder taps here)
//                                    │       ^
//                                    └─> looper ┘
//
// The looper hears the master after the effects and master volume but before
// the limiter, and plays into the limiter input. Its own output is downstream
// of its input, so the loop can only reach the loop again through overdub.
// The limiter catches loop + live peaks together, and the master recorder
// (post-limiter) records exactly what is heard, loop included.

import { createEmitter } from './emitter.js';
import { encodeWav } from './wav.js';
import { DEFAULT_BARS, sanitizeBars } from './looper-core.js';

export const LOOPER_ACTIONS = Object.freeze(['main', 'stop', 'undo', 'clear', 'mute']);

const REPLY_TIMEOUT_MS = 4000;

/**
 * @param {BaseAudioContext} ctx
 * @param {{input: AudioNode, output: AudioNode, worklet: boolean}} o
 *   input = the master tap (post-FX, pre-limiter); output = where the loop is mixed back (limiter input)
 */
export function createLooper(ctx, { input, output, worklet }) {
  const events = createEmitter();
  let node = null;
  let reason = '';
  if (!ctx) reason = 'The looper needs Web Audio, which this browser does not provide.';
  else if (!worklet) reason = 'The looper needs AudioWorklet, which could not load here.';
  else {
    try {
      node = new AudioWorkletNode(ctx, 'orograph-looper', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      });
    } catch (err) {
      node = null;
      reason = `The looper could not start (${(err && err.message) || err}).`;
    }
  }
  if (node) {
    input.connect(node);
    node.connect(output);
  }

  let state = {
    state: 'empty', len: 0, pos: 0, bars: DEFAULT_BARS, loopBars: 0, layers: 0, recPos: 0, recTarget: 0,
    cue: false, muted: false, volume: 1, feedback: 1, peak: 0, capturing: false, capture: -1,
    sampleRate: ctx ? ctx.sampleRate : 48000, edit: 0, loopSpb: 0,
    speed: 1, reverse: false, rate: 1, scrub: false, fpos: 0,
  };
  let nextId = 1;
  const waiting = new Map();   // id -> {resolve, reject, timer}

  function settle(id, fn) {
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    clearTimeout(w.timer);
    fn(w);
  }

  if (node) {
    node.port.onmessage = (e) => {
      const m = e.data;
      if (!m || typeof m.t !== 'string') return;
      if (m.t === 'state') {
        const prev = state.state;
        state = { ...state, ...m, capture: m.capturing ? state.capture : -1 };
        events.emit('change', { ...state, prev });
      } else if (m.t === 'pos') {
        state = {
          ...state, pos: m.pos, len: m.len, recPos: m.recPos, recTarget: m.recTarget, cue: m.cue, capture: m.capture, peak: m.peak,
          fpos: m.fpos, rate: m.rate, speed: m.speed, reverse: m.reverse, scrub: m.scrub,
        };
        events.emit('pos', { ...state });
      } else if (m.t === 'peaks') {
        state = { ...state, peaks: m.peaks, peaksLen: m.len, peaksEdit: m.edit };
        events.emit('peaks', { peaks: m.peaks, len: m.len, edit: m.edit });
      } else if (m.t === 'loop') {
        settle(m.id, (w) => w.resolve(m.len ? { L: m.L, R: m.R, len: m.len, sampleRate: m.sampleRate, loopBars: m.loopBars || 0, edit: m.edit || 0, loopSpb: m.loopSpb || 0 } : null));
      } else if (m.t === 'replaced') {
        settle(m.id, (w) => w.resolve({ ok: !!m.ok, edit: m.edit || 0 }));
      } else if (m.t === 'captured') {
        settle(m.id, (w) => {
          if (m.cancelled) w.resolve(null);
          else if (m.error) w.reject(new Error(m.error === 'busy' ? 'A capture is already running' : 'Not enough memory to capture'));
          else w.resolve({ L: m.L, R: m.R, len: m.frames, sampleRate: m.sampleRate });
        });
      } else if (m.t === 'info' || m.t === 'error') {
        events.emit(m.t, m);
      }
    };
  }

  const post = (m) => { if (node) { try { node.port.postMessage(m); } catch (err) { console.warn('[audio] looper message failed', err); } } };

  function request(msg, timeoutMs) {
    if (!node) return Promise.reject(new Error(reason));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => settle(id, (w) => w.reject(new Error('The looper did not answer (is audio running?)'))), timeoutMs) : 0;
      waiting.set(id, { resolve, reject, timer });
      post({ ...msg, id });
    });
  }

  const api = {
    get available() { return !!node; },
    get reason() { return reason; },
    get node() { return node; },
    /** Latest state from the worklet: {state, len, pos, bars, loopBars, layers, muted, volume, feedback, cue, capturing, edit, loopSpb, speed, reverse, rate, scrub, ...}. */
    status() { return { ...state }; },
    on(name, fn) { return events.on(name, fn); },
    off(name, fn) { events.off(name, fn); },
    /** Record / Play / Overdub cycle. */
    main() { post({ t: 'main' }); },
    /** Stop or restart the loop (no recording). */
    stop() { post({ t: 'stop' }); },
    undo() { post({ t: 'undo' }); },
    clear() { post({ t: 'clear' }); },
    setBars(n) { post({ t: 'bars', v: sanitizeBars(n) }); },
    setVolume(v) { post({ t: 'volume', v }); },
    setMute(on) { post({ t: 'mute', v: !!on }); },
    setFeedback(v) { post({ t: 'feedback', v }); },
    /**
     * Tape. `rate` is 0.5, 1 or 2. `reverse` flips direction. `scrub` is a
     * 0..1 position while the pointer is down, or null to release. Omit a
     * field to leave it unchanged.
     */
    setTape({ rate, reverse, scrub } = {}) {
      const msg = { t: 'tape' };
      if (rate != null) msg.rate = rate;
      if (reverse != null) msg.reverse = !!reverse;
      if (Object.prototype.hasOwnProperty.call(arguments[0] || {}, 'scrub')) msg.scrub = scrub;
      post(msg);
    },
    /** Transport anchor (engine.setTransport forwards it): {playing, beatTime, beat, spb}. */
    transport(t) { post({ t: 'transport', playing: !!t.playing, beatTime: t.beatTime, beat: t.beat, spb: t.spb }); },
    /** A copy of the current loop: {L, R, len, sampleRate, loopBars, edit, loopSpb} or null when empty. */
    getLoop() { return request({ t: 'get' }, REPLY_TIMEOUT_MS); },
    /**
     * Record `bars` of the master (post-FX, before the limiter) at full rate, untouched,
     * from the next bar line while the transport plays (else at once, at the session tempo).
     * Resolves to {L, R, len, sampleRate}, or null when cancelled (transport stopped while waiting).
     */
    capture({ bars = DEFAULT_BARS, frames = 0 } = {}) { return request({ t: 'capture', bars, frames }, 0); },
    cancelCapture() { post({ t: 'cancelCapture' }); },
    /**
     * v2.8 Follow tempo: swap the loop's audio for `L`/`R` (a stretched copy;
     * the buffers are transferred). `base` is the loop's `edit` the copy was
     * made from: when the loop changed since, nothing happens. `spb` is the
     * beat length the new audio fits, `bars` its length in bars.
     * Resolves to {ok, edit}.
     */
    replaceLoop({ L, R, base, spb = 0, bars = 0 }) {
      if (!node) return Promise.reject(new Error(reason));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => settle(id, (w) => w.reject(new Error('The looper did not answer (is audio running?)'))), REPLY_TIMEOUT_MS);
        waiting.set(id, { resolve, reject, timer });
        try { node.port.postMessage({ t: 'replace', id, L, R, base, spb, bars }, [L.buffer, R.buffer]); }
        catch (err) { settle(id, (w) => w.reject(err)); }
      });
    },
    /** The current loop as a WAV Blob: 24-bit with TPDF dither (default) or 32-bit float. */
    async exportWav({ format = 'pcm24' } = {}) {
      const loop = await api.getLoop();
      if (!loop) return null;
      const bytes = encodeWav([loop.L, loop.R], loop.sampleRate, { format: format === 'float32' ? 'float32' : 'pcm24' });
      return new Blob([bytes], { type: 'audio/wav' });
    },
    dispose() {
      for (const id of [...waiting.keys()]) settle(id, (w) => w.reject(new Error('The looper was shut down')));
      if (node) {
        try { input.disconnect(node); } catch { /* ignore */ }
        try { node.disconnect(); } catch { /* ignore */ }
        node.port.onmessage = null;
      }
      events.clear();
    },
  };
  return api;
}
