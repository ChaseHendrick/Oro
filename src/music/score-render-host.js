// Page renders of a score (2.17.1). The Score desk panel and oro.render()
// run the offline renderer (score-render.js) in a worker so the interface
// stays smooth for the whole render. Where a worker cannot start (no Worker,
// a strict content policy, Node) the same render runs on the main thread,
// pausing once a second of audio so the page can still draw.

import { renderScore } from './score-render.js';

const HANDSHAKE_MS = 4000;
let codePromise = null;

function workerCode() {
  if (!codePromise) codePromise = import('virtual:worklet:src/music/score-render-worker.js').then((m) => m.default).catch(() => '');
  return codePromise;
}

function spawn(url) {
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
      if (!ok) { try { w.terminate(); } catch { /* already gone */ } }
      resolve(ok ? w : null);
    };
    const timer = setTimeout(() => finish(false), HANDSHAKE_MS);
    w.onmessage = (e) => { if (e.data && e.data.t === 'pong') finish(true); };
    w.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); finish(false); };
    try { w.postMessage({ t: 'ping' }); } catch { finish(false); }
  });
}

async function startWorker() {
  if (typeof Worker !== 'function') return null;
  const code = await workerCode();
  if (!code) return null;
  let blobUrl = null;
  try { blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })); } catch { blobUrl = null; }
  try {
    if (blobUrl) { const w = await spawn(blobUrl); if (w) return w; }
    return await spawn('data:text/javascript;charset=utf-8,' + encodeURIComponent(code));
  } finally {
    if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch { /* fine */ } }
  }
}

/**
 * renderScore() off the main thread. Same options and result; onProgress
 * still reports. opts.inline forces the main thread. The result says where
 * it ran (result.ranIn: 'worker' | 'page').
 */
export async function renderScoreInBackground(input, opts = {}) {
  const { onProgress, inline, ...rest } = opts;
  const worker = inline ? null : await startWorker().catch(() => null);
  if (!worker) {
    const r = await renderScore(input, { ...rest, onProgress, yieldEvery: rest.yieldEvery ?? 1 });
    return { ...r, ranIn: 'page' };
  }
  try {
    const r = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => {
        const m = e.data || {};
        if (m.t === 'progress') { if (typeof onProgress === 'function') { try { onProgress(m.f); } catch { /* the caller's problem */ } } }
        else if (m.t === 'done') resolve(m.result);
        else if (m.t === 'error') reject(new Error(m.message || 'The render failed.'));
      };
      worker.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); reject(new Error((e && e.message) || 'The render worker stopped.')); };
      worker.postMessage({ t: 'render', id: 1, input, opts: rest });
    });
    return { ...r, ranIn: 'worker' };
  } finally {
    try { worker.terminate(); } catch { /* already gone */ }
  }
}
