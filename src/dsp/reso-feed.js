// GPU Resonator (2.12), audio-thread side.
//
// The AudioWorklet cannot use WebGPU, so a part's membrane can run on the GPU
// elsewhere (a worker, or the main thread) while this side streams it one
// control frame per internal sample (the drive sample, the note, the dot, any
// strike and the settings; see FRAME in reso-gpu-plan.js) and reads the two
// pickups back a fixed LATENCY_BLOCKS * BLOCK samples later. Nothing here
// ever waits: when an output sample is missing the last one fades instead
// (an underrun), and repeated or long underruns hand the part back to the
// CPU Resonator with a short crossfade (UnderrunWatch).
//
// Transport: SharedArrayBuffer rings (FloatRing) when the host offers them
// (crossOriginIsolated pages), else MessagePort chunks of one block. In the
// MessagePort transport the chunk buffers are transferred to the host and
// handed back (POOL of them), so after the first few blocks this side makes
// no new arrays; the browser's own message passing still allocates, which is
// why the SharedArrayBuffer rings are preferred.
//
// Offline (bounce): 'capture' records every part's frames (the membrane's
// input never depends on its own output, so one dry pass fixes it), the GPU
// renders them as fast as it can, and 'play' reads the result back at the
// same latency as live playing.

import { FloatRing } from './reso-ring.js';
import { FRAME, BLOCK, LATENCY_BLOCKS } from './reso-gpu-frame.js';
import { UnderrunWatch, ARM_TIMEOUT_SEC } from './reso-gpu-policy.js';

const WAIT = 0, ARM = 1, GPU = 2, CPU = 3, CAPTURE = 4, PLAY = 5;
const XFADE_SEC = 0.05;
const HOLD_DECAY = 0.995;
const STATUS_SEC = 1;
const POOL = 8;
const NO_TRANSFER = [];                                   // spare chunk buffers (MessagePort transport)

function levelFor(chain, want) {
  if (!chain || !chain.length) return null;
  let best = chain[0];
  for (const L of chain) if (L.size >= want) best = L;
  const cells = best.size * best.size;
  // the message copies the data anyway: only trim a longer buffer
  return { size: best.size, data: best.data.length === cells ? best.data : best.data.slice(0, cells) };
}

/** Terrain levels for a GPU grid of n nodes a side, as the host's plan wants them. */
export function terrainFor(P, n) {
  const morph = Math.max(0, Math.min(1, P.resoMorph));
  return { a: levelFor(P.terrA, 2 * (n + 1)), b: morph > 1e-4 ? levelFor(P.terrB, 2 * (n + 1)) : null, morph };
}

export class ResoFeed {
  constructor(link, P, id, kind) {
    this.link = link; this.P = P; this.id = id;
    this.state = kind === 'capture' ? CAPTURE : kind === 'play' ? PLAY : WAIT;
    const R = P.reso;
    this.fs = R.fs;
    this.L = LATENCY_BLOCKS * BLOCK;
    this.w = 0;                                   // frames written since the stream started
    this.frame = new Float32Array(FRAME);
    this.pend = new Float64Array(24); this.nPend = 0;   // queued strikes (x, y, amp)
    this.chunk = new Float32Array(BLOCK * FRAME); this.fill = 0;
    this.pool = new Array(POOL).fill(null); this.nPool = 0;   // chunk buffers back from the host
    this.msg = { t: 'frames', id, data: null }; this.xfer = [null];
    this.outRing = null;                          // frames to the host (SAB mode)
    this.inRing = null;                           // pickups from the host
    this.got = new Float32Array(2);
    this.lastL = 0; this.lastR = 0;
    this.xf = 0; this.dxf = 1 / Math.max(1, Math.round(XFADE_SEC * this.fs));
    this.fade = 0;                                // GPU -> CPU crossfade left
    this.armMiss = 0;
    this.watch = new UnderrunWatch(this.fs);
    this.minFill = Infinity; this.statusN = 0;
    this.captured = []; this.wet = null;
  }

  /** True while the frame stream runs (the Resonator then stays awake). */
  get active() { return this.state === ARM || this.state === GPU || this.state === CAPTURE || this.state === PLAY; }
  get onGpu() { return this.state === GPU; }

  strike(x, y, amp) {
    if (this.nPend >= 8) return;
    const o = this.nPend++ * 3;
    this.pend[o] = x; this.pend[o + 1] = y; this.pend[o + 2] = amp;
  }

  /** The host has the membrane: start streaming (live). */
  ready(rings) {
    if (this.state !== WAIT) return;
    if (rings) { this.outRing = new FloatRing(rings.cap, FRAME, rings.frames); this.inRing = new FloatRing(rings.cap, 2, rings.out); }
    else this.inRing = new FloatRing(8192, 2);
    this.w = 0; this.xf = 0; this.armMiss = 0;
    this.state = ARM;
  }

  /** Pickup samples from the host (MessagePort transport). */
  receive(data) {
    if (this.inRing && !this.inRing.shared) this.inRing.write(data, 0, data.length >> 1);
  }

  /** Terrain for the host's membrane after the part's CPU membrane was derived. */
  terrain() {
    if (this.state === CPU || this.state === CAPTURE || this.state === PLAY) return;
    this.link.toHost({ t: 'terrain', id: this.id, ...terrainFor(this.P, this.link.grid.n) });
  }

  writeFrame(R, x) {
    const f = this.frame;
    f[0] = x; f[1] = R.fTarget; f[2] = R.dotX; f[3] = R.dotY;
    if (this.nPend > 0) {
      const p = this.pend;
      f[4] = p[2]; f[5] = p[0]; f[6] = p[1];
      for (let k = 3; k < this.nPend * 3; k++) p[k - 3] = p[k];
      this.nPend--;
    } else { f[4] = 0; f[5] = 0; f[6] = 0; }
    f[7] = R.mode; f[8] = R.decay; f[9] = R.tone; f[10] = R.listen;
    if (this.state === CAPTURE || this.outRing === null) {
      this.chunk.set(f, this.fill * FRAME);
      if (++this.fill === BLOCK) {
        // capture is offline (a bounce), so it may keep every block
        if (this.state === CAPTURE) { this.captured.push(this.chunk); this.chunk = new Float32Array(BLOCK * FRAME); }
        else {
          const c = this.chunk;
          this.chunk = this.nPool > 0 ? this.takePooled() : new Float32Array(BLOCK * FRAME);
          this.msg.data = c; this.xfer[0] = c.buffer;
          this.link.toHost(this.msg, this.xfer);
          this.msg.data = null; this.xfer[0] = null;
        }
        this.fill = 0;
      }
    } else if (this.outRing.write(f, 0, 1) === 0) {
      // the host stopped reading: count it as falling behind
      this.miss(R);
    }
  }

  takePooled() {
    const c = this.pool[--this.nPool];
    this.pool[this.nPool] = null;
    return c;
  }

  /** A chunk buffer the host has finished with (MessagePort transport). */
  recycle(data) {
    if (this.nPool < POOL && data && data.length === BLOCK * FRAME) this.pool[this.nPool++] = data;
  }

  /** Every recorded frame (capture), as one array. */
  takeCapture() {
    const out = new Float32Array((this.captured.length * BLOCK + this.fill) * FRAME);
    let o = 0;
    for (const c of this.captured) { out.set(c, o); o += c.length; }
    out.set(this.chunk.subarray(0, this.fill * FRAME), o);
    return out;
  }

  push(R, l, r) {
    const hl = R.hl, hr = R.hr;
    hl[0] = hl[1]; hl[1] = hl[2]; hl[2] = hl[3]; hl[3] = l;
    hr[0] = hr[1]; hr[1] = hr[2]; hr[2] = hr[3]; hr[3] = r;
  }

  miss(R) {
    if (this.state === GPU && this.watch.miss(this.w)) this.fallBack(R, 'The GPU fell behind real time');
  }

  /** Back to the CPU Resonator (from rest, crossfading from the GPU's last output). */
  fallBack(R, reason) {
    if (this.state === CPU) return;
    const wasGpu = this.state === GPU || (this.state === ARM && this.xf > 0);
    this.state = CPU;
    R.u.fill(0); R.up.fill(0); R.lp.fill(0); R.pAmp.fill(0);
    this.fade = wasGpu ? 1 : 0;
    this.link.fellBack(this, reason);
  }

  /** One internal sample: the frame out, the pickups in (or the CPU membrane). */
  tick(R, x) {
    const st = this.state;
    if (st === WAIT || st === CPU) {
      R.step(x);
      if (this.fade > 0) {
        this.lastL *= HOLD_DECAY; this.lastR *= HOLD_DECAY;
        const g = this.fade;
        R.hl[3] = R.hl[3] * (1 - g) + this.lastL * g; R.hr[3] = R.hr[3] * (1 - g) + this.lastR * g;
        this.fade = Math.max(0, g - this.dxf);
      }
      return;
    }
    if (st === CAPTURE) { this.writeFrame(R, x); this.w++; this.push(R, 0, 0); return; }
    if (st === PLAY) {
      const i = this.w++ - this.L, wet = this.wet;
      if (wet !== null && i >= 0 && 2 * i + 1 < wet.length) this.push(R, wet[2 * i], wet[2 * i + 1]);
      else this.push(R, 0, 0);
      return;
    }
    // live: ARM (CPU audible, crossfading in once the GPU answers) or GPU
    this.writeFrame(R, x);
    if (this.state === CPU) { R.step(x); return; }
    let ok = false;
    if (this.w >= this.L) {
      const avail = this.inRing.available;
      if (avail - 1 < this.minFill) this.minFill = avail === 0 ? 0 : avail - 1;
      ok = this.inRing.read(this.got, 0, 1) === 1;
    }
    this.w++;
    let gl, gr;
    if (ok) { gl = this.lastL = this.got[0]; gr = this.lastR = this.got[1]; this.watch.ok(); }
    else { gl = this.lastL *= HOLD_DECAY; gr = this.lastR *= HOLD_DECAY; }
    if (this.state === ARM) {
      R.step(x);
      if (ok || this.xf > 0) {
        this.xf = Math.min(1, this.xf + this.dxf);
        const g = this.xf;
        R.hl[3] = R.hl[3] * (1 - g) + gl * g; R.hr[3] = R.hr[3] * (1 - g) + gr * g;
        if (g >= 1) { this.state = GPU; R.u.fill(0); R.up.fill(0); R.lp.fill(0); R.pAmp.fill(0); }
      } else if (this.w > this.L && ++this.armMiss > ARM_TIMEOUT_SEC * this.fs) {
        this.fallBack(R, 'The GPU did not answer in time');
      }
    } else {
      this.push(R, gl, gr);
      if (!ok) this.miss(R);
    }
    if (++this.statusN >= STATUS_SEC * this.fs) {
      this.link.status(this, this.minFill === Infinity ? 0 : this.minFill);
      this.statusN = 0; this.minFill = Infinity;
    }
  }
}

/** The DSP's link to the GPU host: one feed per part with Resonator on. */
export class ResoGpuLink {
  constructor(dsp) {
    this.dsp = dsp;
    this.kind = null;         // 'live' | 'capture' | 'play'
    this.port = null;
    this.grid = { n: 128, sub: 16 };
    this.nextId = 1;
    this.feeds = new Map();   // id -> feed
    this.wet = new Map();     // part -> Float32Array (play)
    this.failed = false;
    this.underruns = 0;
  }

  message(m) {
    const op = m.op;
    if (op === 'attach' || op === 'capture' || op === 'play') {
      if (this.kind === 'live') this.stop('');
      this.kind = op === 'attach' ? 'live' : op;
      if (m.grid && m.grid.n > 0) this.grid = { n: m.grid.n, sub: m.grid.sub };
      this.failed = false;
      if (op === 'attach') {
        this.port = m.port || null;
        if (this.port) this.port.onmessage = (e) => this.fromHost(e.data);
      }
      if (op === 'play' && m.wet) for (const [part, wet] of m.wet) this.wet.set(part, wet);
      for (const P of this.dsp.parts) this.ensure(P);
    } else if (op === 'detach') {
      this.stop('');
    }
  }

  /** Called after a part's Resonator settings change: open or close its feed. */
  ensure(P) {
    const R = P.reso;
    if (this.kind === null || R === null) return;
    if (P.resoMode === 0) {
      if (this.kind === 'live' && R.feed !== null) { this.close(R.feed); R.feed = null; }
      return;
    }
    if (R.feed !== null && R.feed.state !== CPU) return;
    if (this.kind === 'live' && (this.failed || this.port === null)) return;
    const id = this.nextId++;
    const f = new ResoFeed(this, P, id, this.kind);
    if (this.kind === 'play') f.wet = this.wet.get(P.index) || null;
    R.feed = f;
    this.feeds.set(id, f);
    if (this.kind === 'live') {
      this.toHost({ t: 'open', id, sr: R.sr, grid: this.grid, sab: typeof SharedArrayBuffer === 'function' });
      if (R.ready) f.terrain();
    }
  }

  close(f) {
    this.feeds.delete(f.id);
    if (this.kind === 'live') this.toHost({ t: 'close', id: f.id });
  }

  /** Every live feed back to the CPU (crossfading), and the port closed. */
  stop(reason) {
    // feeds stay on their Resonator in the CPU state so the crossfade can finish
    for (const f of [...this.feeds.values()]) f.fallBack(f.P.reso, reason);
    this.feeds.clear();
    if (this.port) { try { this.port.postMessage({ t: 'closeAll' }); this.port.onmessage = null; this.port.close(); } catch { /* ignore */ } }
    this.port = null; this.kind = null;
  }

  toHost(m, transfer) {
    if (this.port) { try { this.port.postMessage(m, transfer || NO_TRANSFER); } catch { /* ignore */ } }
  }

  fromHost(m) {
    if (!m) return;
    const f = this.feeds.get(m.id);
    if (m.t === 'fail' && m.id === undefined) { this.failed = true; this.stopAll(m.reason || 'The GPU stopped'); return; }
    if (!f) return;
    if (m.t === 'ready') f.ready(m.rings || null);
    else if (m.t === 'out') f.receive(m.data);
    else if (m.t === 'recycle') f.recycle(m.data);
    else if (m.t === 'fail') f.fallBack(f.P.reso, m.reason || 'The GPU stopped');
  }

  stopAll(reason) {
    for (const f of [...this.feeds.values()]) f.fallBack(f.P.reso, reason);
  }

  fellBack(f, reason) {
    if (this.kind !== 'live') return;
    this.feeds.delete(f.id);
    this.toHost({ t: 'close', id: f.id });
    if (reason) {
      // one notice; later parts stay on the CPU until the GPU engine is chosen again
      if (!this.failed) this.dsp.postMessage({ t: 'resoGpu', ev: 'fallback', reason });
      this.failed = true;
    }
  }

  status(f, minFill) {
    this.dsp.postMessage({ t: 'resoGpu', ev: 'status', id: f.id, onGpu: f.onGpu, latencyMs: 1000 * f.L / f.fs, headroomMs: 1000 * minFill / f.fs, underruns: f.watch.total });
  }

  /** Capture pass: every part's frames, by part index. */
  takeCapture() {
    const out = new Map();
    for (const f of this.feeds.values()) out.set(f.P.index, f.takeCapture());
    return out;
  }
}
