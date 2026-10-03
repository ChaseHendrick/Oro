// Recording: start/stop the engine's WAV recorder, show elapsed time, and save
// the result as orograph-YYYYMMDD-HHMMSS.wav (local time of the start).

import { has, downloadBlob, listen } from './dom.js';

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function recordingName(date = new Date()) {
  return `oro-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.wav`;
}

export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export function createRecorder(ctx, { onState } = {}) {
  const { engine } = ctx;
  const supported = has(engine, 'startRecording') && has(engine, 'stopRecording') && engine.mode !== 'none';
  let recording = false;
  let busy = false;
  let startedAt = 0;
  let startDate = null;

  const emit = () => { if (onState) onState({ recording, busy, startedAt }); };

  async function start() {
    if (!supported || recording || busy) return;
    busy = true; emit();
    try {
      await ctx.startAudio();
      await engine.startRecording();
      recording = true;
      startedAt = performance.now();
      startDate = new Date();
    } catch (err) {
      console.warn('[ui] recording failed to start', err);
      ctx.toast('Recording could not start', { kind: 'error', detail: 'The audio engine refused to record. Try again after pressing Start.' });
    } finally {
      busy = false; emit();
    }
  }

  function save(blob, note) {
    if (blob && blob.size > 44) {
      const name = recordingName(startDate || new Date());
      downloadBlob(blob, name);
      ctx.toast(note || 'Recording saved', { kind: 'success', detail: name });
    } else {
      ctx.toast('The recording was empty', { kind: 'warn' });
    }
  }

  // The engine stops by itself at its length limit; save what it captured.
  const offEvents = listen(engine, 'recording', (e) => {
    if (!recording || busy || !e || e.state !== 'stopped' || e.reason !== 'limit') return;
    recording = false;
    save(e.blob, 'Recording reached its time limit and was saved');
    emit();
  });

  async function stop() {
    if (!recording || busy) return;
    busy = true; emit();
    try {
      const blob = await engine.stopRecording();
      recording = false;
      save(blob);
    } catch (err) {
      console.warn('[ui] recording failed to stop', err);
      recording = false;
      ctx.toast('Recording could not be saved', { kind: 'error' });
    } finally {
      busy = false; emit();
    }
  }

  return {
    supported,
    isRecording: () => recording,
    /** Milliseconds recorded: the engine's captured length when it reports one. */
    elapsed() {
      if (!recording) return 0;
      if (has(engine, 'recordingElapsed')) {
        const secs = Number(engine.recordingElapsed());
        if (Number.isFinite(secs) && secs > 0) return secs * 1000;
      }
      return performance.now() - startedAt;
    },
    toggle: () => (recording ? stop() : start()),
    start, stop,
    dispose: offEvents,
  };
}
