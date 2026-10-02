import { describe, it, expect, beforeAll } from 'vitest';
import { createRecorder } from '../../src/audio/recorder.js';
import { decodeWav } from '../../src/audio/wav.js';

// ---- the AudioWorkletProcessor, run in Node with a minimal global scope ----------
let Processor = null;
beforeAll(async () => {
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage: () => {}, onmessage: null }; } };
  globalThis.registerProcessor = (name, cls) => { if (name === 'orograph-recorder') Processor = cls; };
  await import('../../src/audio/recorder-worklet.js');
});

function makeProcessor() {
  const p = new Processor();
  const out = [];
  p.port.postMessage = (m) => out.push(m);
  const send = (m) => p.port.onmessage({ data: m });
  const quantum = (fill) => {
    const L = new Float32Array(128).map((_, i) => fill(i, 0));
    const R = new Float32Array(128).map((_, i) => fill(i, 1));
    p.process([[L, R]], [[new Float32Array(128)]]);
  };
  return { p, out, send, quantum };
}

describe('recorder worklet processor', () => {
  it('records only while armed and ships every frame in order', () => {
    const { out, send, quantum } = makeProcessor();
    let n = 0;
    quantum(() => 9);                     // not armed: ignored
    send({ t: 'start', maxFrames: 0 });
    for (let q = 0; q < 70; q++) quantum((i, c) => (c ? -1 : 1) * (n + i) / 1e5), n += 128;
    send({ t: 'stop' });
    quantum(() => 9);                     // after stop: ignored
    const chunks = out.filter(m => m.t === 'chunk');
    const done = out.find(m => m.t === 'done');
    expect(done).toEqual({ t: 'done', frames: 70 * 128, reason: 'stop' });
    expect(chunks.reduce((s, c) => s + c.frames, 0)).toBe(70 * 128);
    expect(chunks.length).toBe(3);        // 2 full 4096-frame blocks + the remainder
    const L = new Float32Array(70 * 128);
    let o = 0;
    for (const c of chunks) { L.set(c.L.subarray(0, c.frames), o); o += c.frames; }
    for (let i = 0; i < L.length; i += 997) expect(L[i]).toBeCloseTo(i / 1e5, 6);
    expect(chunks[0].R[5]).toBeCloseTo(-5 / 1e5, 6);
  });

  it('stops by itself at the frame limit', () => {
    const { out, send, quantum } = makeProcessor();
    send({ t: 'start', maxFrames: 1000 });
    for (let q = 0; q < 20; q++) quantum(() => 0.5);
    const done = out.find(m => m.t === 'done');
    expect(done).toEqual({ t: 'done', frames: 1000, reason: 'limit' });
    expect(out.filter(m => m.t === 'chunk').reduce((s, c) => s + c.frames, 0)).toBe(1000);
    expect(out.filter(m => m.t === 'done').length).toBe(1);
  });

  it('records silence when nothing is connected', () => {
    const { p, out, send } = makeProcessor();
    send({ t: 'start' });
    p.process([[]], [[new Float32Array(128)]]);
    send({ t: 'stop' });
    const c = out.find(m => m.t === 'chunk');
    expect(c.frames).toBe(128);
    expect(c.L.subarray(0, 128).every(v => v === 0)).toBe(true);
  });
});

// ---- main-thread side, ScriptProcessor path with a fake context ----------------
function fakeContext(sampleRate = 48000) {
  const node = () => ({ connect() {}, disconnect() {} });
  const sp = { ...node(), onaudioprocess: null };
  return {
    sampleRate,
    destination: node(),
    createGain: () => ({ ...node(), gain: { value: 1 } }),
    createScriptProcessor: () => sp,
    sp,
  };
}

function feed(ctx, frames, value) {
  const L = new Float32Array(frames).fill(value), R = new Float32Array(frames).fill(-value);
  ctx.sp.onaudioprocess({ inputBuffer: { numberOfChannels: 2, getChannelData: (c) => (c ? R : L) } });
}

describe('recorder (ScriptProcessor fallback)', () => {
  it('produces a 24-bit stereo WAV of exactly the captured frames', async () => {
    const ctx = fakeContext(44100);
    const events = [];
    const rec = createRecorder(ctx, { connect() {}, disconnect() {} }, { worklet: false, onEvent: e => events.push(e) });
    expect(rec.mode).toBe('script');
    feed(ctx, 4096, 0.9);                 // before start: ignored
    rec.start();
    for (let i = 0; i < 10; i++) feed(ctx, 4096, 0.25);
    expect(rec.elapsed()).toBeCloseTo(40960 / 44100, 9);
    const r = await rec.stop();
    expect(r.frames).toBe(40960);
    expect(r.reason).toBe('stop');
    const wav = decodeWav(new Uint8Array(await r.blob.arrayBuffer()));
    expect(wav.sampleRate).toBe(44100);
    expect(wav.bitsPerSample).toBe(24);
    expect(wav.channels.length).toBe(2);
    expect(wav.frames).toBe(40960);
    expect(wav.channels[0][123]).toBeCloseTo(0.25, 6);
    expect(wav.channels[1][40000]).toBeCloseTo(-0.25, 6);
    expect(events.map(e => e.state)).toEqual(['recording', 'stopped']);
    expect(rec.isRecording()).toBe(false);
  });

  it('caps a recording at the time limit, emits the event and still hands the file to stop()', async () => {
    const ctx = fakeContext(1000);
    const events = [];
    const rec = createRecorder(ctx, { connect() {}, disconnect() {} }, { worklet: false, maxSeconds: 5, onEvent: e => events.push(e) });
    rec.start();
    for (let i = 0; i < 10; i++) feed(ctx, 1024, 0.1);
    expect(rec.isRecording()).toBe(false);
    const last = events[events.length - 1];
    expect(last).toMatchObject({ state: 'stopped', reason: 'limit', frames: 5000 });
    expect(last.duration).toBeCloseTo(5, 9);
    const r = await rec.stop();
    expect(r.blob).toBe(last.blob);
    expect(r.blob.size).toBe(44 + 5000 * 6);
  });
});
