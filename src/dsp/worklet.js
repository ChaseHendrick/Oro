// AudioWorkletProcessor 'orograph': a thin shell around OroDSP.
//
// Bundled into a single classic script by vite.config.js (virtual:worklet:...)
// and loaded through a Blob URL, so ordinary imports work here.
//
// Node options: numberOfInputs 0, numberOfOutputs 3, outputChannelCount
// [2, 2, 2] -> outputs[0] dry mix, outputs[1] delay send, outputs[2] reverb
// send. The live host (v1.1) asks for a fourth stereo output, outputs[3], the
// pedal send bus; with three outputs (offline bounces) it is not rendered. Messages on node.port follow docs/ARCHITECTURE.md; telemetry goes back
// the same way. A message may also be an array of messages (one postMessage
// for a batch of parameter changes). processorOptions.init may carry an array
// of messages applied in the constructor, before the first render quantum:
// an OfflineAudioContext does not deliver port messages until it has rendered,
// and a live host can use it to start with the right patch and terrains.

import { OroDSP } from './dsp-core.js';
import { DspLoadMeter } from './load-meter.js';

class OroProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // The global sampleRate is the context's real rate; processorOptions only
    // documents what the host expected.
    const sr = typeof sampleRate === 'number' && sampleRate > 0
      ? sampleRate
      : (options && options.processorOptions && options.processorOptions.sampleRate) || 48000;
    const measure=options?.processorOptions?.measureLoad === true;
    const precise=typeof globalThis.performance?.now === 'function';
    this.loadMeter=measure ? new DspLoadMeter(sr,!precise) : null;
    this.loadClock=measure ? (precise ? globalThis.performance.now.bind(globalThis.performance) : Date.now) : null;
    this.dsp = new OroDSP(sr);
    this.dsp.postMessage = (msg) => this.port.postMessage(msg);
    const init = options && options.processorOptions && options.processorOptions.init;
    if (Array.isArray(init)) for (const m of init) this.dsp.handleMessage(m);
    this.port.onmessage = (e) => {
      const data = e.data;
      if (Array.isArray(data)) for (const m of data) this.dsp.handleMessage(m);
      else this.dsp.handleMessage(data);
    };
    // Scratch for any output the host left unconnected or mono, allocated once
    // and grown only if the render quantum ever changes size.
    this.scratch = [];
  }

  channel(output, ch, frames, slot) {
    const c = output && output[ch];
    if (c && c.length >= frames) return c;
    let s = this.scratch[slot];
    if (!s || s.length < frames) { s = new Float32Array(frames); this.scratch[slot] = s; }
    return s;
  }

  process(inputs, outputs) {
    const started=this.loadMeter ? this.loadClock() : 0;
    const dry = outputs[0], dly = outputs[1], rev = outputs[2];
    const frames = (dry && dry[0] && dry[0].length) || 128;
    const L = this.channel(dry, 0, frames, 0);
    const R = dry && dry.length > 1 ? this.channel(dry, 1, frames, 1) : this.channel(null, 0, frames, 1);
    const DL = this.channel(dly, 0, frames, 2);
    const DR = dly && dly.length > 1 ? this.channel(dly, 1, frames, 3) : this.channel(null, 0, frames, 3);
    const VL = this.channel(rev, 0, frames, 4);
    const VR = rev && rev.length > 1 ? this.channel(rev, 1, frames, 5) : this.channel(null, 0, frames, 5);
    const ped = outputs.length > 3 ? outputs[3] : null;
    const PL = ped ? this.channel(ped, 0, frames, 6) : null;
    const PR = ped ? (ped.length > 1 ? this.channel(ped, 1, frames, 7) : this.channel(null, 0, frames, 7)) : null;
    this.dsp.process(L, R, DL, DR, VL, VR, frames, globalThis.currentTime, PL, PR);
    // a mono dry output still gets both channels
    if (dry && dry.length === 1) for (let i = 0; i < frames; i++) dry[0][i] = 0.5 * (L[i] + R[i]);
    if (this.loadMeter) {
      const report=this.loadMeter.record(this.loadClock()-started,frames);
      if (report) this.port.postMessage(report);
    }
    return true;
  }
}

registerProcessor('orograph', OroProcessor);
