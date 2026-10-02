// Runs the real AudioWorklet processors from src/pedals/guitar-worklet.js in
// Node with the few worklet globals they use stubbed, block by block like the
// browser's audio thread would.
import { describe, it, expect, beforeAll } from 'vitest';
import { pluck, midiToHz, strum } from './signals.js';
import { createChordWorkerCore } from '../../src/pedals/guitar-chord-worker.js';

const registry = {};
let posted = [];

beforeAll(async () => {
  globalThis.sampleRate = 48000;
  globalThis.currentFrame = 0;
  globalThis.currentTime = 0;
  globalThis.AudioWorkletProcessor = class {
    constructor() { this.port = { onmessage: null, postMessage: (m) => posted.push(m) }; }
  };
  globalThis.registerProcessor = (name, cls) => { registry[name] = cls; };
  await import('../../src/pedals/guitar-worklet.js');
});

function runBlocks(proc, signal, { startFrame = 0, channels = 1, makeInput } = {}) {
  for (let i = 0; i < signal.length; i += 128) {
    globalThis.currentFrame = startFrame + i;
    globalThis.currentTime = (startFrame + i) / 48000;
    const block = new Float32Array(128);
    block.set(signal.subarray(i, Math.min(signal.length, i + 128)));
    const input = makeInput ? makeInput(block) : Array.from({ length: channels }, () => block);
    proc.process([input], [[new Float32Array(128)]]);
  }
}

describe('guitar worklet processors', () => {
  it('registers both processors', () => {
    expect(Object.keys(registry).sort()).toEqual(['orograph-guitar', 'orograph-pedal-capture']);
  });

  it("'orograph-guitar' posts notes with exact context times, plus level and pitch", () => {
    posted = [];
    const proc = new registry['orograph-guitar']({ processorOptions: { channel: 1 } });
    const sig = pluck({ sampleRate: 48000, freq: midiToHz(52), duration: 0.8, start: 0.1 });
    // Channel 1 carries the guitar; channel 0 is silence (the "mono return + guitar" layout).
    const startFrame = 96000; // the context had been running for 2 s
    runBlocks(proc, sig, { startFrame, makeInput: (b) => [new Float32Array(128), b] });
    const on = posted.find(m => m.t === 'noteOn');
    expect(on).toBeTruthy();
    expect(on.note).toBe(52);
    const latencyMs = (on.time - (startFrame / 48000 + 0.1)) * 1000;
    expect(latencyMs).toBeGreaterThan(5);
    expect(latencyMs).toBeLessThan(45);
    const levels = posted.filter(m => m.t === 'level');
    expect(levels.length).toBeGreaterThan(60); // ~100 Hz over 0.9 s
    expect(Math.max(...levels.map(l => l.value))).toBeGreaterThan(0.8);
    expect(posted.filter(m => m.t === 'pitch').length).toBeGreaterThan(20);
  });

  it("'orograph-guitar' keeps time through missing input and stops on request", () => {
    posted = [];
    const proc = new registry['orograph-guitar']({ processorOptions: {} });
    globalThis.currentFrame = 0;
    expect(proc.process([[]], [[new Float32Array(128)]])).toBe(true);
    proc.port.onmessage({ data: { t: 'config', tracker: { gateDb: -40 }, envelope: { attackMs: 1 } } });
    proc.port.onmessage({ data: { t: 'stop' } });
    expect(proc.process([[]], [[new Float32Array(128)]])).toBe(false);
  });

  it("'orograph-guitar' ships context-aligned chord samples for analysis outside the audio thread", () => {
    posted = [];
    const proc = new registry['orograph-guitar']({ processorOptions: { guitarMode: 'chords' } });
    const startFrame = 96000;
    runBlocks(proc, strum([52, 55, 59], { duration: 0.5 }), { startFrame });
    const batches = posted.filter(event => event.t === 'samples');
    expect(batches.length).toBeGreaterThan(20);
    expect(batches.every(event => event.data.length === 1024)).toBe(true);
    expect(batches[0].time).toBe(2);
    batches.forEach((event, index) => expect(event.time).toBeCloseTo(2 + index * 1024 / 48000, 10));
    expect(posted.filter(event => event.t === 'noteOn' || event.t === 'bend')).toEqual([]);
    const results = [];
    const worker = createChordWorkerCore(message => results.push(message));
    worker({ t: 'config', sampleRate: 48000, revision: 0 });
    batches.forEach((batch, id) => worker({ ...batch, id, sampleRate: 48000 }));
    const events = results.flatMap(result => result.events);
    const ons = events.filter(event => event.t === 'noteOn');
    expect([...new Set(ons.map(event => event.note))].sort((a, b) => a - b)).toEqual([52, 55, 59]);
    expect(ons.every(event => event.time > 2.1 && event.time < 2.4)).toBe(true);
    expect(posted.filter(event => event.t === 'bend')).toEqual([]);
    expect(results.find(result => result.pitch?.notes.length === 3).pitch).toMatchObject({ mode: 'chords', notes: [52, 55, 59], voiced: true });
    const before = posted.length;
    proc.port.onmessage({ data: { t: 'config', guitarMode: 'single' } });
    expect(posted.at(-1)).toMatchObject({ t: 'pitch', mode: 'single', voiced: false });
    expect(posted.slice(before).filter(event => event.t === 'samples')).toEqual([]);
    proc.port.onmessage({ data: { t: 'stop' } });
  });

  it("'orograph-guitar' discards partial sample batches on reset or mode changes", () => {
    posted = [];
    const proc = new registry['orograph-guitar']({ processorOptions: { guitarMode: 'chords' } });
    runBlocks(proc, new Float32Array(896).fill(0.5));
    expect(posted.filter(event => event.t === 'samples')).toEqual([]);
    proc.port.onmessage({ data: { t: 'reset' } });
    runBlocks(proc, new Float32Array(1024).fill(-0.25), { startFrame: 896 });
    const batch = posted.find(event => event.t === 'samples');
    expect(batch.data.every(value => value === -0.25)).toBe(true);
    expect(batch.time).toBeCloseTo(896 / 48000, 10);
    proc.port.onmessage({ data: { t: 'config', guitarMode: 'single', revision: 1 } });
    proc.port.onmessage({ data: { t: 'config', guitarMode: 'chords', revision: 2 } });
    const before = posted.length;
    runBlocks(proc, new Float32Array(1024).fill(0.75), { startFrame: 1920 });
    expect(posted.slice(before).find(event => event.t === 'samples')).toMatchObject({ revision: 2, mode: 'chords' });
    proc.port.onmessage({ data: { t: 'stop' } });
    expect(proc.process([[]])).toBe(false);
  });

  it("'orograph-pedal-capture' records channels sample-aligned in chunks", () => {
    posted = [];
    const proc = new registry['orograph-pedal-capture']({ processorOptions: { channels: 2 } });
    const n = 20000;
    const ramp = new Float32Array(n).map((_, i) => i);
    proc.port.onmessage({ data: { t: 'start', maxFrames: 1e9 } });
    runBlocks(proc, ramp, { makeInput: (b) => [b, b.map(v => -v)] });
    proc.port.onmessage({ data: { t: 'stop' } });
    const chunks = posted.filter(m => m.t === 'chunk');
    const total = chunks.reduce((s, c) => s + c.frames, 0);
    expect(total).toBe(Math.ceil(n / 128) * 128);
    const L = new Float32Array(total), R = new Float32Array(total);
    let o = 0;
    for (const c of chunks) { L.set(c.data[0], o); R.set(c.data[1], o); o += c.frames; }
    for (let i = 0; i < n; i++) { expect(L[i]).toBe(i); expect(R[i]).toBe(-i); }
    expect(posted[posted.length - 1]).toMatchObject({ t: 'done', reason: 'stop' });
  });

  it("'orograph-pedal-capture' stops at its frame limit and fills missing channels with silence", () => {
    posted = [];
    const proc = new registry['orograph-pedal-capture']({ processorOptions: { channels: 2 } });
    proc.port.onmessage({ data: { t: 'start', maxFrames: 1000 } });
    runBlocks(proc, new Float32Array(4096).fill(0.5), { makeInput: (b) => [b] });
    const chunks = posted.filter(m => m.t === 'chunk');
    expect(chunks.reduce((s, c) => s + c.frames, 0)).toBe(1000);
    expect(chunks[0].data[1].every(v => v === 0)).toBe(true);
    expect(posted.find(m => m.t === 'done').reason).toBe('limit');
  });
});
