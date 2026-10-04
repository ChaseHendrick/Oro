// Single-producer single-consumer ring of float frames (2.12 GPU Resonator).
//
// Lock-free: the writer only moves the write count and the reader only the
// read count (Int32 header, Atomics), so with a SharedArrayBuffer the audio
// thread and the GPU host can share it without ever waiting. The same class
// over a plain ArrayBuffer is the receiving side of the MessagePort transport.
// Counts run freely and wrap at 2^32; the capacity is a power of two so the
// index stays right across the wrap. Never allocates after construction.

const HEADER = 8;   // bytes: write count, read count

export class FloatRing {
  /** Bytes for a ring of `capacity` frames (power of two) of `stride` floats. */
  static bytes(capacity, stride) { return HEADER + capacity * stride * 4; }

  constructor(capacity, stride, buffer = null) {
    if (!(capacity > 0) || (capacity & (capacity - 1)) !== 0) throw new Error('FloatRing capacity must be a power of two');
    this.cap = capacity; this.mask = capacity - 1; this.stride = stride;
    const SAB = globalThis.SharedArrayBuffer;
    this.buffer = buffer || new ArrayBuffer(FloatRing.bytes(capacity, stride));
    this.shared = !!SAB && this.buffer instanceof SAB;
    this.head = new Int32Array(this.buffer, 0, 2);
    this.data = new Float32Array(this.buffer, HEADER, capacity * stride);
  }

  /** Frames written so far (wraps at 2^32). */
  get written() { return Atomics.load(this.head, 0) >>> 0; }
  get readCount() { return Atomics.load(this.head, 1) >>> 0; }
  /** Frames ready to read. */
  get available() { return (Atomics.load(this.head, 0) - Atomics.load(this.head, 1)) >>> 0; }
  /** Frames that can be written without overwriting unread ones. */
  get space() { return this.cap - this.available; }

  /** Write up to `frames` frames from src[at..]; returns how many fit. */
  write(src, at, frames) {
    const w = Atomics.load(this.head, 0), r = Atomics.load(this.head, 1);
    const n = Math.min(frames, this.cap - ((w - r) >>> 0));
    const st = this.stride, d = this.data;
    for (let i = 0; i < n; i++) {
      const o = ((w + i) & this.mask) * st, so = at + i * st;
      for (let c = 0; c < st; c++) d[o + c] = src[so + c];
    }
    Atomics.store(this.head, 0, (w + n) | 0);
    return n;
  }

  /** Read up to `frames` frames into dst[at..]; returns how many were there. */
  read(dst, at, frames) {
    const w = Atomics.load(this.head, 0), r = Atomics.load(this.head, 1);
    const n = Math.min(frames, (w - r) >>> 0);
    const st = this.stride, d = this.data;
    for (let i = 0; i < n; i++) {
      const o = ((r + i) & this.mask) * st, so = at + i * st;
      for (let c = 0; c < st; c++) dst[so + c] = d[o + c];
    }
    Atomics.store(this.head, 1, (r + n) | 0);
    return n;
  }

  /** Drop everything unread (reader side). */
  clear() { Atomics.store(this.head, 1, Atomics.load(this.head, 0)); }
}
