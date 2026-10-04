// GPU Resonator (2.12) host: runs the parts' membranes in WebGPU compute
// shaders, in a dedicated worker where the browser offers WebGPU there, else
// on the main thread. Loaded only when the GPU engine is chosen.
//
// The worklet streams control frames (reso-feed.js); every BLOCK frames the
// host plans the block (reso-gpu-plan.js), encodes its dispatches in one
// command buffer, reads the pickup cells back with mapAsync and streams the
// stereo result to the worklet. The same membrane can render a captured frame
// stream offline as fast as the GPU allows (bounce).

import { WGSL_STEP, WGSL_RESUB, TILE, UNIFORM_STRIDE, AMP_STRIDE, OUT_STRIDE, MAX_ENT } from '../dsp/reso-gpu-kernel.js';
import { ResoGpuPlan, JsMembrane, BLOCK, FRAME, MAX_RECORDS, MAX_CHUNKS, OP_RESUB } from '../dsp/reso-gpu-plan.js';
import { FloatRing } from '../dsp/reso-ring.js';

const RING_FRAMES = 8192;
const PUMP_MS = 2;
const STATUS_MS = 1000;

/** A WebGPU device, or an Error saying why not. */
export async function openDevice(gpu = globalThis.navigator && globalThis.navigator.gpu) {
  if (!gpu) throw new Error('WebGPU is not available here');
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error('No WebGPU graphics adapter was found');
  return adapter.requestDevice();
}

const pipes = new WeakMap();
function pipelines(device) {
  let p = pipes.get(device);
  if (p) return p;
  const S = GPUShaderStage.COMPUTE;
  const uni = { binding: 0, visibility: S, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 96 } };
  const ro = (binding) => ({ binding, visibility: S, buffer: { type: 'read-only-storage' } });
  const rw = (binding) => ({ binding, visibility: S, buffer: { type: 'storage' } });
  const stepLayout = device.createBindGroupLayout({ entries: [uni, ro(1), rw(2), ro(3), ro(4), ro(5), ro(6), rw(7)] });
  const resubLayout = device.createBindGroupLayout({ entries: [uni, rw(1)] });
  const stepMod = device.createShaderModule({ code: WGSL_STEP });
  const resubMod = device.createShaderModule({ code: WGSL_RESUB });
  const mk = (layout, module, entryPoint) => device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module, entryPoint },
  });
  p = { stepLayout, resubLayout, step: mk(stepLayout, stepMod, 'advance'), resubA: mk(resubLayout, resubMod, 'resubA'), resubB: mk(resubLayout, resubMod, 'resubB') };
  pipes.set(device, p);
  return p;
}

/** One membrane in GPU buffers. run(plan) resolves to the raw pickup readings. */
export class GpuMembrane {
  constructor(device, n) {
    this.device = device; this.n = n; this.W = n + 2;
    const cells = this.W * this.W, U = GPUBufferUsage;
    const buf = (size, usage) => device.createBuffer({ size: Math.ceil(size / 4) * 4, usage });
    this.state = [buf(3 * cells * 4, U.STORAGE | U.COPY_DST), buf(3 * cells * 4, U.STORAGE | U.COPY_DST)];
    this.stiff = buf(cells * 4, U.STORAGE | U.COPY_DST);
    this.ent = buf(MAX_CHUNKS * MAX_ENT * 4, U.STORAGE | U.COPY_DST);
    this.entW = buf(MAX_CHUNKS * MAX_ENT * AMP_STRIDE * 4, U.STORAGE | U.COPY_DST);
    this.amps = buf(BLOCK * AMP_STRIDE * 4, U.STORAGE | U.COPY_DST);
    this.out = buf(BLOCK * OUT_STRIDE * 4, U.STORAGE | U.COPY_SRC);
    this.read = buf(BLOCK * OUT_STRIDE * 4, U.MAP_READ | U.COPY_DST);
    this.uni = buf(MAX_RECORDS * UNIFORM_STRIDE, U.UNIFORM | U.COPY_DST);
    const P = this.p = pipelines(device);
    const b = (buffer) => ({ buffer });
    const u = { binding: 0, resource: { buffer: this.uni, offset: 0, size: 96 } };
    this.stepBG = [0, 1].map(c => device.createBindGroup({ layout: P.stepLayout, entries: [
      u, { binding: 1, resource: b(this.state[c]) }, { binding: 2, resource: b(this.state[1 - c]) },
      { binding: 3, resource: b(this.stiff) }, { binding: 4, resource: b(this.ent) }, { binding: 5, resource: b(this.entW) },
      { binding: 6, resource: b(this.amps) }, { binding: 7, resource: b(this.out) },
    ] }));
    this.resubBG = [0, 1].map(c => device.createBindGroup({ layout: P.resubLayout, entries: [u, { binding: 1, resource: b(this.state[c]) }] }));
    this.cur = 0;
    this.raw = new Float32Array(BLOCK * OUT_STRIDE);
  }

  setStiffness(s) { this.device.queue.writeBuffer(this.stiff, 0, Float32Array.from(s)); }

  reset() {
    const z = new Float32Array(3 * this.W * this.W);
    for (const s of this.state) this.device.queue.writeBuffer(s, 0, z);
    this.cur = 0;
  }

  async run(plan) {
    const q = this.device.queue, P = this.p, g = this.n / TILE;
    q.writeBuffer(this.uni, 0, plan.records, 0, plan.nRec * UNIFORM_STRIDE);
    if (plan.nEntAll > 0) {
      q.writeBuffer(this.ent, 0, plan.entCell, 0, plan.nEntAll);
      q.writeBuffer(this.entW, 0, plan.entW, 0, plan.nEntAll * AMP_STRIDE);
    }
    q.writeBuffer(this.amps, 0, plan.amps, 0, plan.nSamples * AMP_STRIDE);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    let pipe = null;
    const use = (p) => { if (pipe !== p) { pass.setPipeline(p); pipe = p; } };
    for (let r = 0; r < plan.nRec; r++) {
      const off = [r * UNIFORM_STRIDE];
      if (plan.ops[r] === OP_RESUB) {
        use(P.resubA); pass.setBindGroup(0, this.resubBG[this.cur], off); pass.dispatchWorkgroups(g, g);
        use(P.resubB); pass.setBindGroup(0, this.resubBG[this.cur], off); pass.dispatchWorkgroups(g, g);
      } else {
        use(P.step); pass.setBindGroup(0, this.stepBG[this.cur], off); pass.dispatchWorkgroups(g, g);
        this.cur ^= 1;
      }
    }
    pass.end();
    const bytes = plan.nSamples * OUT_STRIDE * 4;
    enc.copyBufferToBuffer(this.out, 0, this.read, 0, bytes);
    q.submit([enc.finish()]);
    await this.read.mapAsync(GPUMapMode.READ, 0, bytes);
    this.raw.set(new Float32Array(this.read.getMappedRange(0, bytes)));
    this.read.unmap();
    return this.raw;
  }

  destroy() {
    for (const b of [...this.state, this.stiff, this.ent, this.entW, this.amps, this.out, this.read, this.uni]) { try { b.destroy(); } catch { /* ignore */ } }
  }
}

/** The JS mirror behind the same async interface (tests, and a debugging aid). */
class JsBackend {
  constructor(n) { this.m = new JsMembrane(n); }
  setStiffness(s) { this.m.setStiffness(s); }
  reset() { this.m.reset(); }
  async run(plan) { return this.m.run(plan); }
  destroy() {}
}

/**
 * The host. `device` a GPUDevice, or null with backend 'js'. onStatus gets
 * {gpuMs, blockMs, membranes} once a second and {lost, reason} on device loss.
 */
export class ResoGpuHost {
  constructor({ device = null, backend = 'webgpu', onStatus = () => {} } = {}) {
    this.device = device; this.backend = backend; this.onStatus = onStatus;
    this.entries = new Map();
    this.port = null;
    this.timer = 0;
    this.gpuMs = 0; this.blocks = 0; this.worstMs = 0; this.lastStatus = 0;
    this.dead = false;
    if (device && device.lost) device.lost.then((info) => {
      if (this.dead) return;
      this.dead = true;
      const reason = 'The GPU device was lost' + (info && info.message ? ` (${info.message})` : '');
      this.post({ t: 'fail', reason });
      this.onStatus({ lost: true, reason });
    });
  }

  membrane(n) { return this.backend === 'js' ? new JsBackend(n) : new GpuMembrane(this.device, n); }

  attachPort(port) {
    this.port = port;
    port.onmessage = (e) => this.message(e.data);
    if (!this.timer) this.timer = setInterval(() => this.pump(), PUMP_MS);
  }

  post(m, transfer) { if (this.port) { try { this.port.postMessage(m, transfer || []); } catch { /* ignore */ } } }

  message(m) {
    if (!m) return;
    if (m.t === 'closeAll') { for (const id of [...this.entries.keys()]) this.drop(id); return; }
    if (m.t === 'open') {
      if (this.dead) { this.post({ t: 'fail', id: m.id, reason: 'The GPU device was lost' }); return; }
      try {
        const plan = new ResoGpuPlan(m.sr, m.grid);
        const shared = !!m.sab && globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';
        const mk = (stride) => new FloatRing(RING_FRAMES, stride, shared ? new SharedArrayBuffer(FloatRing.bytes(RING_FRAMES, stride)) : null);
        const e = { id: m.id, plan, mem: this.membrane(m.grid.n), inbox: mk(FRAME), outRing: shared ? mk(2) : null, busy: false, ready: false, terrain: null,
          block: new Float32Array(BLOCK * FRAME), out: new Float32Array(BLOCK * 2) };
        this.entries.set(m.id, e);
      } catch (err) {
        this.post({ t: 'fail', id: m.id, reason: `The GPU could not start the Resonator (${err.message || err})` });
      }
    } else if (m.t === 'terrain') {
      const e = this.entries.get(m.id);
      if (e) e.terrain = m;
    } else if (m.t === 'frames') {
      const e = this.entries.get(m.id);
      if (e && !e.outRing) e.inbox.write(m.data, 0, m.data.length / FRAME);
    } else if (m.t === 'close') {
      this.drop(m.id);
    }
  }

  drop(id) {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    e.closed = true;
    if (!e.busy) e.mem.destroy();
  }

  pump() {
    for (const e of this.entries.values()) if (!e.busy) this.work(e);
    const now = Date.now();
    if (now - this.lastStatus >= STATUS_MS) {
      this.lastStatus = now;
      if (this.blocks > 0) this.onStatus({ gpuMs: this.gpuMs / this.blocks, worstMs: this.worstMs, membranes: this.entries.size });
      this.gpuMs = 0; this.blocks = 0; this.worstMs = 0;
    }
  }

  async work(e) {
    e.busy = true;
    try {
      if (e.terrain) {
        const t = e.terrain; e.terrain = null;
        e.plan.terrain(t.a, t.b, t.morph);
        e.mem.setStiffness(e.plan.stiffness);
        if (!e.ready) {
          e.ready = true; e.mem.reset();
          this.post({ t: 'ready', id: e.id, g1: e.plan.g1, ceiling: e.plan.ceiling(),
            rings: e.outRing ? { cap: RING_FRAMES, frames: e.inbox.buffer, out: e.outRing.buffer } : null });
        }
      }
      while (e.ready && !e.closed && e.inbox.available >= BLOCK) {
        e.inbox.read(e.block, 0, BLOCK);
        const t0 = performance.now();
        e.plan.plan(e.block, 0, BLOCK);
        const raw = await e.mem.run(e.plan);
        e.plan.finish(raw, e.out, 0);
        const ms = performance.now() - t0;
        this.gpuMs += ms; this.blocks++; if (ms > this.worstMs) this.worstMs = ms;
        if (e.closed) break;
        if (e.outRing) e.outRing.write(e.out, 0, BLOCK);
        else this.post({ t: 'out', id: e.id, data: e.out.slice() });
      }
    } catch (err) {
      this.post({ t: 'fail', id: e.id, reason: `The GPU stopped (${(err && err.message) || err})` });
      this.drop(e.id);
    } finally {
      e.busy = false;
      if (e.closed) e.mem.destroy();
    }
  }

  /**
   * Offline: render a captured frame stream (FRAME floats per sample) with
   * the part's terrain. Resolves to stereo (2 floats per sample).
   */
  async renderOffline({ frames, sr, grid, terrain }) {
    const plan = new ResoGpuPlan(sr, grid);
    const mem = this.membrane(grid.n);
    try {
      plan.terrain(terrain.a, terrain.b, terrain.morph);
      mem.setStiffness(plan.stiffness);
      mem.reset();
      const count = Math.floor(frames.length / FRAME);
      const wet = new Float32Array(2 * count);
      for (let at = 0; at < count; at += BLOCK) {
        const len = Math.min(BLOCK, count - at);
        plan.plan(frames, at * FRAME, len);
        const raw = await mem.run(plan);
        plan.finish(raw, wet, 2 * at);
      }
      return wet;
    } finally { mem.destroy(); }
  }

  dispose() {
    clearInterval(this.timer); this.timer = 0;
    for (const id of [...this.entries.keys()]) this.drop(id);
    if (this.port) { this.port.onmessage = null; try { this.port.close(); } catch { /* ignore */ } }
    this.port = null; this.dead = true;
  }
}
