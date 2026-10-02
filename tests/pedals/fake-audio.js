// A tiny stand-in for AudioContext that records the graph, so routing code can
// be checked in Node. Only what src/pedals uses is implemented.

export function fakeContext({ maxChannelCount = 2, sampleRate = 48000, refuseChannels = false } = {}) {
  const edges = [];
  class Node {
    constructor(kind, extra = {}) {
      this.kind = kind;
      this.channelCount = 2;
      this.channelCountMode = 'max';
      this.channelInterpretation = 'speakers';
      Object.assign(this, extra);
    }
    connect(to, out = 0, inp = 0) { edges.push({ from: this, to, out, inp }); return to; }
    disconnect(to) {
      for (let i = edges.length - 1; i >= 0; i--) if (edges[i].from === this && (to === undefined || edges[i].to === to)) edges.splice(i, 1);
    }
  }
  const param = (v) => ({
    value: v,
    setTargetAtTime(x) { this.value = x; }, setValueAtTime(x) { this.value = x; },
    linearRampToValueAtTime(x) { this.value = x; }, cancelScheduledValues() {},
  });
  const destination = new Node('destination', { maxChannelCount, channelCountMode: 'explicit' });
  if (refuseChannels) {
    let cc = 2;
    Object.defineProperty(destination, 'channelCount', {
      get() { return cc; },
      set(v) { if (v > 2) throw new Error('IndexSizeError: channel count not supported'); cc = v; },
    });
  }
  const ctx = {
    sampleRate, currentTime: 0, state: 'running', destination, edges,
    createGain() { const n = new Node('gain'); n.gain = param(1); return n; },
    createChannelMerger(n = 6) { return new Node('merger', { numberOfInputs: n }); },
    createChannelSplitter(n = 6) { return new Node('splitter', { numberOfOutputs: n }); },
    createWaveShaper() { return new Node('shaper', { curve: null, oversample: 'none' }); },
    createAnalyser() { return new Node('analyser', { fftSize: 2048, getFloatTimeDomainData() {} }); },
    createMediaStreamSource(stream) { return new Node('mediaSource', { mediaStream: stream }); },
  };
  /** Edges leaving `from` (optionally only to `to`). */
  ctx.out = (from, to) => edges.filter(e => e.from === from && (to === undefined || e.to === to));
  return ctx;
}
