// AudioWorkletProcessor 'orograph-looper': runs LooperCore (looper-core.js) on
// its stereo input and plays the loop on its stereo output. Bundled into a
// classic script by vite.config.js (virtual:worklet:...).
//
// in:  the LooperCore control messages ({t:'main'} ... see looper-core.js); an array is applied in order.
//      Tape is {t:'tape', rate, reverse, scrub}: rate 0.5 | 1 | 2, reverse flips direction,
//      scrub is a 0..1 position while the pointer is down, or null on release.
// out: {t:'state', ...} on changes, {t:'pos', ...} about 30 times a second,
//      {t:'peaks', peaks, len, edit} when a chunked peak scan of the loop finishes,
//      {t:'loop', id, L, R, len} for 'get', {t:'captured', id, L, R} for 'capture'

import { LooperCore } from './looper-core.js';

class OroLooper extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.core = new LooperCore(sampleRate, {
      emit: (msg, transfer) => {
        try { this.port.postMessage(msg, transfer || []); } catch { /* port closed */ }
      },
      ...(o.core || {}),
    });
    this.port.onmessage = (e) => {
      const list = Array.isArray(e.data) ? e.data : [e.data];
      for (const m of list) this.core.handle(m, currentFrame);
    };
    this.core.notify();
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const out = outputs[0];
    const a = input && input[0];
    const b = input && (input[1] || input[0]);
    const oL = out[0], oR = out[1] || out[0];
    const n = oL ? oL.length : 128;
    this.core.process(a || null, b || null, oL, oR, n, currentFrame);
    return true;
  }
}

registerProcessor('orograph-looper', OroLooper);
