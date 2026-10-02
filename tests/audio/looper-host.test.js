import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createLooper } from '../../src/audio/looper.js';
import { createFx } from '../../src/audio/fx.js';
import { wavInfo } from '../../src/audio/wav.js';

// A Web Audio stand-in that only records the graph: every node can connect,
// every AudioParam accepts automation, every create* works.
function fakeContext(sampleRate = 48000) {
  const edges = [];
  let n = 0;
  const param = (v = 0) => ({ value: v, setValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {}, cancelAndHoldAtTime() {}, linearRampToValueAtTime() {}, setValueCurveAtTime() {} });
  const makeNode = (kind) => {
    let self = null;
    const node = {
      kind, id: ++n,
      connect(dst) { edges.push([self, dst && dst.__owner ? dst.__owner : dst]); return dst; },
      disconnect(dst) { for (let i = edges.length - 1; i >= 0; i--) if (edges[i][0] === self && (!dst || edges[i][1] === dst)) edges.splice(i, 1); },
      start() {}, stop() {},
      getFloatTimeDomainData() {},
    };
    self = new Proxy(node, {
      get(t, k) {
        if (k in t) return t[k];
        if (typeof k === 'string' && /^(gain|frequency|Q|delayTime|threshold|knee|ratio|attack|release|detune|pan)$/.test(k)) { const p = param(); p.__owner = self; t[k] = p; return p; }
        return undefined;
      },
      set(t, k, v) { t[k] = v; return true; },
    });
    return self;
  };
  const ctx = new Proxy({ sampleRate, currentTime: 0, destination: makeNode('destination') }, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k === 'string' && k.startsWith('create')) {
        if (k === 'createBuffer') return (ch, len) => ({ length: len, getChannelData: () => new Float32Array(len), copyToChannel() {} });
        return () => makeNode(k.slice(6));
      }
      return undefined;
    },
  });
  const reach = (from, to) => {
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length) {
      const a = stack.pop();
      if (a === to) return true;
      for (const [x, y] of edges) if (x === a && !seen.has(y)) { seen.add(y); stack.push(y); }
    }
    return false;
  };
  return { ctx, edges, reach, makeNode };
}

class FakeWorkletNode {
  constructor(ctx, name, opts) {
    this.name = name; this.opts = opts;
    this.sent = [];
    this.port = { postMessage: (m) => this.sent.push(m), onmessage: null };
    FakeWorkletNode.last = this;
    FakeWorkletNode.edges = FakeWorkletNode.edges || [];
  }
  connect(dst) { FakeWorkletNode.edges.push([this, dst]); return dst; }
  disconnect() {}
}

let saved;
beforeAll(() => { saved = globalThis.AudioWorkletNode; globalThis.AudioWorkletNode = FakeWorkletNode; });
afterAll(() => { globalThis.AudioWorkletNode = saved; });

describe('looper on the master bus', () => {
  it('taps after the effects and returns before the limiter, so the loop cannot reach its own input', () => {
    const { ctx, reach, edges } = fakeContext();
    const fx = createFx(ctx, { computeIR: () => new Promise(() => {}) });
    expect(fx.masterTap).toBeTruthy();
    expect(fx.masterReturn).toBeTruthy();
    // The return feeds the limiter and the output (what the recorder taps)...
    expect(reach(fx.masterReturn, fx.limiter)).toBe(true);
    expect(reach(fx.masterReturn, fx.output)).toBe(true);
    // ...and nothing downstream of the return leads back to the tap.
    expect(reach(fx.masterReturn, fx.masterTap)).toBe(false);
    // The effects are upstream of the tap (the reverb's convolver is installed
    // later, once its impulse response is built, into the same return bus).
    expect(reach(fx.dryIn, fx.masterTap)).toBe(true);
    expect(reach(fx.delayIn, fx.masterTap)).toBe(true);

    const looper = createLooper(ctx, { input: fx.masterTap, output: fx.masterReturn, worklet: true });
    const node = FakeWorkletNode.last;
    expect(looper.available).toBe(true);
    expect(node.name).toBe('orograph-looper');
    expect(node.opts.outputChannelCount).toEqual([2]);
    expect(edges.some(([a, b]) => a === fx.masterTap && b === node)).toBe(true);
    expect(FakeWorkletNode.edges.some(([a, b]) => a === node && b === fx.masterReturn)).toBe(true);
    looper.dispose();
    fx.dispose();
  });

  it('forwards controls and answers getLoop / exportWav from worklet replies', async () => {
    const { ctx, makeNode } = fakeContext(44100);
    const looper = createLooper(ctx, { input: makeNode('in'), output: makeNode('out'), worklet: true });
    const node = FakeWorkletNode.last;
    looper.main(); looper.undo(); looper.setBars(4); looper.setBars(3); looper.setFeedback(0.5); looper.setMute(true);
    looper.transport({ playing: true, beatTime: 1, beat: 0, spb: 0.5 });
    expect(node.sent.map(m => m.t)).toEqual(['main', 'undo', 'bars', 'bars', 'feedback', 'mute', 'transport']);
    expect(node.sent[3].v).toBe(2);
    const changes = [];
    looper.on('change', (s) => changes.push(s.state));
    node.port.onmessage({ data: { t: 'state', state: 'play', len: 100, layers: 0, capturing: false } });
    expect(changes).toEqual(['play']);
    expect(looper.status().len).toBe(100);

    const p = looper.exportWav({ format: 'float32' });
    const req = node.sent[node.sent.length - 1];
    expect(req.t).toBe('get');
    const L = new Float32Array([0.1, 0.2, 0.3]), R = new Float32Array([0, -0.1, 0.4]);
    node.port.onmessage({ data: { t: 'loop', id: req.id, L, R, len: 3, sampleRate: 44100 } });
    const blob = await p;
    const info = wavInfo(new Uint8Array(await blob.arrayBuffer()));
    expect(info).toMatchObject({ sampleRate: 44100, frames: 3, bitsPerSample: 32, float: true });

    const c = looper.capture({ bars: 1 });
    const creq = node.sent[node.sent.length - 1];
    expect(creq).toMatchObject({ t: 'capture', bars: 1 });
    node.port.onmessage({ data: { t: 'captured', id: creq.id, L, R, frames: 3, sampleRate: 44100 } });
    expect((await c).len).toBe(3);
    looper.dispose();
  });

  it('reports why when the worklet is missing', async () => {
    const { ctx, makeNode } = fakeContext();
    const looper = createLooper(ctx, { input: makeNode('in'), output: makeNode('out'), worklet: false });
    expect(looper.available).toBe(false);
    expect(looper.reason).toMatch(/AudioWorklet/);
    looper.main();
    await expect(looper.getLoop()).rejects.toThrow(/AudioWorklet/);
  });
});
