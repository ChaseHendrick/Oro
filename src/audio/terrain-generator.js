// Runs heavy pure-JS jobs (terrain tables, see terrain-jobs.js, and reverb
// impulse responses) without stalling the UI.
//
// A 512 x 512 table plus its mip chain takes 25-100 ms of CPU depending on the
// terrain, so the preferred path is a small pool of dedicated workers started
// from the bundled worker code (Blob URL, then data: URL for file:// pages).
// When workers cannot start (strict CSP, very old browser) jobs run on the
// main thread, one step per macrotask, with the same 512 x 512 resolution, so each
// step stays around the 50 ms long-task budget.

import { buildTerrainData, mipChainFor, runJob } from './terrain-jobs.js';

const HANDSHAKE_MS = 4000;

function spawnWorker(url) {
  return new Promise((resolve) => {
    let w;
    try { w = new Worker(url); } catch { resolve(null); return; }
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      w.onmessage = null;
      w.onerror = null;
      if (!ok) { try { w.terminate(); } catch { /* already dead */ } }
      resolve(ok ? w : null);
    };
    const timer = setTimeout(() => finish(false), HANDSHAKE_MS);
    w.onmessage = (e) => { if (e.data && e.data.t === 'pong') finish(true); };
    w.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); finish(false); };
    try { w.postMessage({ t: 'ping' }); } catch { finish(false); }
  });
}

const nextTask = (fn) => setTimeout(fn, 0);

/**
 * @param {{code?: string, size?: number, inlineSize?: number, workers?: number, forceInline?: boolean}} o
 * @returns {Promise<{mode: 'worker'|'inline', via: string, size: number, free(): number,
 *   run(job): Promise<any>, stats(): object, dispose(): void}>}
 *   run() always accepts a job (it queues when busy); free() says how many
 *   jobs would start right away, so a caller can hold back and re-prioritise.
 */
export async function createTerrainGenerator({ code = '', size = 512, inlineSize = 512, workers = 2, forceInline = false } = {}) {
  const pool = [];
  let via = 'inline';
  if (!forceInline && code && typeof Worker === 'function') {
    let blobUrl = null;
    try { blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })); } catch { blobUrl = null; }
    const candidates = [];
    if (blobUrl) candidates.push(['blob', blobUrl]);
    candidates.push(['data', 'data:text/javascript;charset=utf-8,' + encodeURIComponent(code)]);
    for (const [kind, url] of candidates) {
      const first = await spawnWorker(url);
      if (!first) continue;
      pool.push(first);
      via = kind;
      const more = await Promise.all(Array.from({ length: Math.max(0, workers - 1) }, () => spawnWorker(url)));
      for (const w of more) if (w) pool.push(w);
      break;
    }
    if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch { /* ignore */ } }
  }

  const st = { jobs: 0, errors: 0, maxJobMs: 0, totalJobMs: 0, maxInlineBlockMs: 0 };
  let disposed = false;
  // Callers that hold work back while free() is 0 (the terrain manager) must
  // hear when capacity returns, whoever's job just finished.
  const freeListeners = new Set();
  const notifyFree = () => queueMicrotask(() => { if (!disposed) for (const fn of [...freeListeners]) fn(); });
  const done = (ms) => { st.jobs++; st.totalJobMs += ms; st.maxJobMs = Math.max(st.maxJobMs, ms); };

  // ---- main-thread runner: the fallback, and the safety net if every worker dies ----
  const inlineQueue = [];
  let inlineBusy = false;
  const timed = (fn) => {
    const t0 = performance.now();
    const r = fn();
    const ms = performance.now() - t0;
    st.maxInlineBlockMs = Math.max(st.maxInlineBlockMs, ms);
    return [r, ms];
  };
  function inlineNext() {
    if (inlineBusy || disposed || !inlineQueue.length) return;
    inlineBusy = true;
    const { job, resolve, reject } = inlineQueue.shift();
    const fail = (err) => { st.errors++; inlineBusy = false; reject(err); inlineNext(); notifyFree(); };
    nextTask(() => {
      try {
        if (job.kind === 'ir') {
          const [r, ms] = timed(() => runJob(job));
          done(ms); inlineBusy = false; resolve(r); inlineNext(); notifyFree();
          return;
        }
        // Table and mip chain as two tasks: the longest block is one of them, not their sum.
        const [data, ms1] = timed(() => buildTerrainData(job));
        nextTask(() => {
          try {
            const [levels, ms2] = timed(() => mipChainFor(job, data));
            done(ms1 + ms2); inlineBusy = false; resolve(levels); inlineNext(); notifyFree();
          } catch (err) { fail(err); }
        });
      } catch (err) { fail(err); }
    });
  }
  const runInline = (job) => new Promise((resolve, reject) => { inlineQueue.push({ job, resolve, reject }); inlineNext(); });

  // ---- worker pool ----
  const idle = [...pool];
  const alive = new Set(pool);
  const pending = new Map();   // id -> {resolve, reject, worker}
  const backlog = [];          // jobs waiting for a free worker
  let nextId = 1;

  function dispatch(job, resolve, reject) {
    const w = idle.pop();
    const id = nextId++;
    pending.set(id, { resolve, reject, worker: w });
    try { w.postMessage({ t: 'job', id, job }); } catch (err) { pending.delete(id); idle.push(w); reject(err); }
  }

  function drainBacklog() {
    while (backlog.length && idle.length && !disposed) {
      const b = backlog.shift();
      dispatch(b.job, b.resolve, b.reject);
    }
    if (!alive.size) while (backlog.length) { const b = backlog.shift(); runInline(b.job).then(b.resolve, b.reject); }
  }

  const api = {
    mode: pool.length ? 'worker' : 'inline',
    via,
    size: pool.length ? size : inlineSize,
    workers: pool.length,
    free() {
      if (disposed) return 0;
      if (!alive.size) return inlineBusy || inlineQueue.length ? 0 : 1;
      return Math.max(0, idle.length - backlog.length);
    },
    run(job) {
      if (disposed) return Promise.reject(new Error('disposed'));
      if (!alive.size) return runInline(job);
      return new Promise((resolve, reject) => {
        if (idle.length && !backlog.length) dispatch(job, resolve, reject);
        else backlog.push({ job, resolve, reject });
      });
    },
    /** Call fn whenever a job finishes (capacity may be free again). Returns an unsubscribe function. */
    onFree(fn) { freeListeners.add(fn); return () => freeListeners.delete(fn); },
    stats: () => ({ ...st, mode: api.mode, via: api.via, workers: alive.size }),
    dispose() {
      disposed = true;
      freeListeners.clear();
      for (const w of alive) { try { w.terminate(); } catch { /* ignore */ } }
      alive.clear();
      for (const p of pending.values()) p.reject(new Error('disposed'));
      pending.clear();
      for (const b of backlog.splice(0)) b.reject(new Error('disposed'));
      for (const b of inlineQueue.splice(0)) b.reject(new Error('disposed'));
    },
  };

  for (const w of pool) {
    w.onmessage = (e) => {
      const m = e.data;
      if (!m || (m.t !== 'done' && m.t !== 'error')) return;
      const rec = pending.get(m.id);
      if (!rec) return;
      pending.delete(m.id);
      if (!disposed && alive.has(w)) idle.push(w);
      if (m.t === 'done') { done(m.ms || 0); rec.resolve(m.result); }
      else { st.errors++; rec.reject(new Error(m.message || 'job failed')); }
      drainBacklog();
      notifyFree();
    };
    w.onerror = (e) => {
      if (e && e.preventDefault) e.preventDefault();
      // A crashed worker takes its job with it; the rest of the pool carries on,
      // and if none is left the main-thread runner takes over at the smaller size.
      for (const [id, rec] of pending) {
        if (rec.worker === w) { pending.delete(id); st.errors++; rec.reject(new Error('worker crashed')); }
      }
      alive.delete(w);
      const i = idle.indexOf(w);
      if (i >= 0) idle.splice(i, 1);
      try { w.terminate(); } catch { /* ignore */ }
      if (!alive.size) { api.mode = 'inline'; api.via = 'inline'; api.size = inlineSize; }
      drainBacklog();
      notifyFree();
    };
  }
  return api;
}
