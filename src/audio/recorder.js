// Master recorder: taps the post-limiter output and produces a 24-bit stereo
// WAV (or 32-bit float, 2.17) at the context rate. Audio arrives in blocks (from the recorder worklet,
// or a ScriptProcessor when worklets are unavailable) and is packed to 24-bit
// immediately, so memory holds the final file's bytes and nothing more.

import { encodePCM24, encodeFloat32, wavBlobFromPieces } from './wav.js';

export const MAX_RECORD_SECONDS = 20 * 60;
const STOP_TIMEOUT_MS = 1500;

/**
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} source stereo node to record (the master output)
 * @param {{worklet: boolean, onEvent: (e: object) => void, maxSeconds?: number}} o
 */
export function createRecorder(ctx, source, { worklet, onEvent = () => {}, maxSeconds = MAX_RECORD_SECONDS }) {
  const sr = ctx.sampleRate;
  const maxFrames = Math.round(maxSeconds * sr);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  mute.connect(ctx.destination);

  let node = null;
  let mode = 'script';
  if (worklet) {
    try {
      node = new AudioWorkletNode(ctx, 'orograph-recorder', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      });
      mode = 'worklet';
    } catch {
      node = null;
    }
  }
  if (!node) {
    node = ctx.createScriptProcessor(4096, 2, 1);
    node.channelCountMode = 'explicit';
    node.channelInterpretation = 'speakers';
  }
  source.connect(node);
  node.connect(mute);

  let session = null;      // {pieces, frames, resolveStop, timer}
  let lastResult = null;   // {blob, duration, reason} of the most recent finished recording

  function addBlock(L, R, n) {
    if (!session) return;
    session.pieces.push(session.format === 'float32' ? encodeFloat32([L, R], n) : encodePCM24([L, R], n));
    session.frames += n;
  }

  function finalize(reason) {
    const s = session;
    if (!s) return lastResult;
    session = null;
    clearTimeout(s.timer);
    const blob = wavBlobFromPieces({ sampleRate: sr, channels: 2, frames: s.frames, pieces: s.pieces, format: s.format });
    lastResult = { blob, duration: s.frames / sr, frames: s.frames, reason };
    onEvent({ state: 'stopped', ...lastResult });
    for (const fn of s.waiters) fn(lastResult);
    return lastResult;
  }

  if (mode === 'worklet') {
    node.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.t === 'chunk') addBlock(m.L, m.R, m.frames);
      else if (m.t === 'done' && session) finalize(m.reason === 'limit' ? 'limit' : session.reason || 'stop');
    };
  } else {
    node.onaudioprocess = (e) => {
      if (!session || session.stopping) return;
      const ib = e.inputBuffer;
      const L = ib.getChannelData(0);
      const R = ib.numberOfChannels > 1 ? ib.getChannelData(1) : L;
      const n = Math.min(L.length, maxFrames - session.frames);
      if (n > 0) addBlock(L, R, n);
      if (session.frames >= maxFrames) finalize('limit');
    };
  }

  return {
    mode,
    isRecording: () => !!session,
    /** Seconds captured so far in the current recording. */
    elapsed: () => (session ? session.frames / sr : 0),
    maxSeconds,
    start({ format } = {}) {
      if (session) return;
      session = { pieces: [], frames: 0, waiters: [], timer: 0, reason: null, stopping: false, format: format === 'float32' ? 'float32' : 'pcm24' };
      if (mode === 'worklet') node.port.postMessage({ t: 'start', maxFrames });
      onEvent({ state: 'recording', duration: 0 });
    },
    /** Resolves to the finished recording (also when it already stopped at the time limit). */
    stop() {
      if (!session) return Promise.resolve(lastResult);
      const s = session;
      return new Promise((resolve) => {
        s.waiters.push(resolve);
        if (s.stopping) return;
        s.stopping = true;
        s.reason = 'stop';
        if (mode === 'worklet') {
          node.port.postMessage({ t: 'stop' });
          // A suspended context never renders the final block; do not hang.
          s.timer = setTimeout(() => { if (session === s) finalize('stop'); }, STOP_TIMEOUT_MS);
        } else {
          finalize('stop');
        }
      });
    },
    dispose() {
      if (session) finalize('stop');
      try { source.disconnect(node); } catch { /* ignore */ }
      try { node.disconnect(); mute.disconnect(); } catch { /* ignore */ }
    },
  };
}
