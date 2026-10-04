// GPU Resonator (2.12) controller, imported only when the GPU engine is
// chosen. Starts the host in a worker when the browser offers WebGPU to
// workers (preferred: the GPU's readbacks never wait on the main thread),
// else on the main thread; hands the worklet a MessagePort to it; and renders
// the GPU membranes for a bounce (capture pass, GPU, play pass).

import workerCode from 'virtual:worklet:src/audio/reso-gpu-worker.js';
import { ResoGpuHost, openDevice } from './reso-gpu-host.js';
import { terrainFor } from '../dsp/reso-feed.js';

const HELLO_MS = 5000;
const QUANTUM = 128;

function startWorker(onStatus) {
  return new Promise((resolve, reject) => {
    let url = null, w = null;
    try {
      url = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
      w = new Worker(url);
    } catch (err) { if (url) URL.revokeObjectURL(url); reject(err); return; }
    const timer = setTimeout(() => { w.terminate(); reject(new Error('the GPU worker did not start')); }, HELLO_MS);
    const pending = new Map();
    let nextId = 1;
    w.onmessage = (e) => {
      const m = e.data;
      if (m.t === 'hello') {
        clearTimeout(timer); URL.revokeObjectURL(url);
        if (!m.ok) { w.terminate(); reject(new Error(m.reason)); return; }
        resolve({
          where: 'worker',
          connect() { const ch = new MessageChannel(); w.postMessage({ t: 'port', port: ch.port2 }, [ch.port2]); return ch.port1; },
          renderOffline(job) {
            return new Promise((res, rej) => {
              const id = nextId++;
              pending.set(id, { res, rej });
              w.postMessage({ t: 'offline', id, job });
            });
          },
          dispose() { try { w.postMessage({ t: 'dispose' }); } catch { /* ignore */ } setTimeout(() => w.terminate(), 100); },
        });
      } else if (m.t === 'status') onStatus(m.s);
      else if (m.t === 'offline') {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (p) { if (m.error) p.rej(new Error(m.error)); else p.res(m.wet); }
      }
    };
    w.onerror = (e) => { clearTimeout(timer); w.terminate(); reject(new Error(e.message || 'the GPU worker failed')); };
    w.postMessage({ t: 'init' });
  });
}

/**
 * Start the GPU host. Rejects (with the reason) when WebGPU cannot run it.
 * backend 'js' runs the kernel's CPU mirror instead (tests and debugging).
 */
export async function createResoGpu({ onStatus = () => {}, backend = 'webgpu', worker = true } = {}) {
  if (backend === 'webgpu' && worker && typeof Worker === 'function') {
    try { return await startWorker(onStatus); } catch { /* no WebGPU in workers here: main thread */ }
  }
  const device = backend === 'js' ? null : await openDevice();
  const host = new ResoGpuHost({ device, backend, onStatus });
  return {
    where: 'main',
    connect() { const ch = new MessageChannel(); host.attachPort(ch.port2); return ch.port1; },
    renderOffline: (job) => host.renderOffline(job),
    dispose: () => host.dispose(),
  };
}

/**
 * Bounce: the extra init messages that make an offline pass play the GPU
 * membranes, or null when no part uses the Resonator. Runs the pass once on
 * this thread to capture each part's control frames (the membrane's input
 * does not depend on its output), renders them on the GPU, and returns them
 * for the real pass, which must run the DSP the same way (renderDspHere).
 */
export async function offlineResoInit(gpu, { init, late, frames, sampleRate, grid, onFrames = () => {}, isCancelled = null }) {
  const { OroDSP } = await import('../dsp/dsp-core.js');
  const dsp = new OroDSP(sampleRate);
  dsp.postMessage = () => {};
  for (const m of init) dsp.handleMessage(m);
  const lateReso = late.some(e => e.msg && e.msg.t === 'params' && e.msg.p && Number(e.msg.p.resoOn) > 0);
  if (!dsp.parts.some(P => P.reso !== null && P.resoMode !== 0) && !lateReso) return null;
  dsp.handleMessage({ t: 'resoGpu', op: 'capture', grid });
  const sc = Array.from({ length: 6 }, () => new Float32Array(QUANTUM));
  let li = 0, t0 = performance.now();
  for (let f = 0; f < frames; f += QUANTUM) {
    const n = Math.min(QUANTUM, frames - f);
    const t = f / sampleRate;
    while (li < late.length && late[li].time <= t + 1e-9) dsp.handleMessage(late[li++].msg);
    dsp.process(sc[0], sc[1], sc[2], sc[3], sc[4], sc[5], n, t);
    if (performance.now() - t0 > 30) {
      onFrames(f); await new Promise(r => setTimeout(r, 0)); t0 = performance.now();
      if (isCancelled && isCancelled()) throw new Error('cancelled');
    }
  }
  const wet = [];
  for (const [part, fr] of dsp.resoGpu.takeCapture()) {
    if (!fr.length) continue;
    const P = dsp.parts[part];
    const terrain = terrainFor(P, grid.n);
    wet.push([part, await gpu.renderOffline({ frames: fr, sr: sampleRate, grid, terrain })]);
  }
  return [{ t: 'resoGpu', op: 'play', grid, wet }];
}
