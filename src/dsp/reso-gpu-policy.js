// GPU Resonator (2.12) decisions: which engine runs, and when a running GPU
// membrane has fallen too far behind and the CPU Resonator takes over.

export const UNDERRUN_LIMIT = 3;         // underruns ...
export const UNDERRUN_WINDOW_SEC = 2;    // ... within this long fall back
export const UNDERRUN_LONG_SEC = 0.25;   // one underrun this long falls back at once
export const ARM_TIMEOUT_SEC = 2;        // the GPU's first output must arrive within this

/**
 * Engine to run: 'gpu' only when asked for and WebGPU can run it.
 * @param {{requested: string, hasGpu: boolean, adapter?: boolean, lost?: boolean, fellBehind?: boolean, error?: string}} o
 * @returns {{engine: 'cpu'|'gpu', reason: string}}
 */
export function chooseEngine(o) {
  if (o.requested !== 'gpu') return { engine: 'cpu', reason: '' };
  if (!o.hasGpu) return { engine: 'cpu', reason: 'WebGPU is not available in this browser' };
  if (o.adapter === false) return { engine: 'cpu', reason: 'No WebGPU graphics adapter was found' };
  if (o.error) return { engine: 'cpu', reason: `The GPU could not start the Resonator (${o.error})` };
  if (o.lost) return { engine: 'cpu', reason: 'The GPU device was lost' };
  if (o.fellBehind) return { engine: 'cpu', reason: 'The GPU fell behind real time' };
  return { engine: 'gpu', reason: '' };
}

/**
 * Underrun bookkeeping at the internal sample rate `fs`. miss(i) for every
 * sample i whose GPU output was not there in time, ok() for one that was;
 * miss returns true once the CPU Resonator should take over.
 */
export class UnderrunWatch {
  constructor(fs) {
    this.fs = fs;
    this.window = Math.round(UNDERRUN_WINDOW_SEC * fs);
    this.long = Math.round(UNDERRUN_LONG_SEC * fs);
    this.events = new Float64Array(UNDERRUN_LIMIT);
    this.count = 0; this.run = 0; this.total = 0;
  }
  ok() { this.run = 0; }
  miss(i) {
    this.total++;
    if (this.run++ === 0) {
      // a new underrun: keep the last UNDERRUN_LIMIT start times
      const e = this.events;
      for (let k = 0; k < e.length - 1; k++) e[k] = e[k + 1];
      e[e.length - 1] = i;
      if (this.count < e.length) this.count++;
      if (this.count >= e.length && i - e[0] <= this.window) return true;
    }
    return this.run >= this.long;
  }
}
