// AudioWorkletProcessor 'orograph-recorder': captures its stereo input while
// armed and ships it to the main thread in ~85 ms blocks (buffers transferred).
// Bundled into a classic script by vite.config.js (virtual:worklet:...).
//
// in:  {t:'start', maxFrames} | {t:'stop'}
// out: {t:'chunk', L, R, frames} | {t:'done', frames, reason: 'stop'|'limit'}
// The single output is silent; it exists so the node can be pulled by the
// destination through a muted gain in every browser.

const BLOCK = 4096;

class OroRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.armed = false;
    this.frames = 0;
    this.maxFrames = Infinity;
    this.fill = 0;
    this.L = null;
    this.R = null;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.t === 'start') {
        this.armed = true;
        this.frames = 0;
        this.fill = 0;
        this.maxFrames = m.maxFrames > 0 ? m.maxFrames : Infinity;
        this.L = new Float32Array(BLOCK);
        this.R = new Float32Array(BLOCK);
      } else if (m.t === 'stop') {
        if (this.armed) this.finish('stop');
      }
    };
  }

  ship() {
    if (!this.fill) return;
    const L = this.L, R = this.R, n = this.fill;
    this.port.postMessage({ t: 'chunk', L, R, frames: n }, [L.buffer, R.buffer]);
    this.L = new Float32Array(BLOCK);
    this.R = new Float32Array(BLOCK);
    this.fill = 0;
  }

  finish(reason) {
    this.ship();
    this.armed = false;
    this.port.postMessage({ t: 'done', frames: this.frames, reason });
  }

  process(inputs) {
    if (!this.armed) return true;
    const input = inputs[0];
    const a = input && input[0];
    const b = input && (input[1] || input[0]);
    const n = (a && a.length) || 128;
    let i = 0;
    while (i < n && this.armed) {
      const room = Math.min(BLOCK - this.fill, n - i, this.maxFrames - this.frames);
      if (a) {
        this.L.set(a.subarray(i, i + room), this.fill);
        this.R.set(b.subarray(i, i + room), this.fill);
      } else {
        this.L.fill(0, this.fill, this.fill + room);
        this.R.fill(0, this.fill, this.fill + room);
      }
      this.fill += room;
      this.frames += room;
      i += room;
      if (this.frames >= this.maxFrames) { this.finish('limit'); break; }
      if (this.fill >= BLOCK) this.ship();
    }
    return true;
  }
}

registerProcessor('orograph-recorder', OroRecorder);
