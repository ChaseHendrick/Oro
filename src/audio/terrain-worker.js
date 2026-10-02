// Dedicated worker for the audio host's heavy pure-JS work: terrain mip chains
// (25-100 ms each at 512 x 512) and reverb impulse responses (up to ~100 ms for
// a 7 s room). Bundled into a classic script by vite.config.js
// (virtual:worklet:...), so it can start from a Blob or data: URL.
//
// in:  {t:'ping'} | {t:'job', id, job}
// out: {t:'pong'} | {t:'done', id, result, ms} (buffers transferred) | {t:'error', id, message}

import { runJob, transferablesOf } from './terrain-jobs.js';

self.onmessage = (e) => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.t === 'ping') { self.postMessage({ t: 'pong' }); return; }
  if (m.t !== 'job') return;
  const t0 = performance.now();
  try {
    const result = runJob(m.job);
    self.postMessage({ t: 'done', id: m.id, result, ms: performance.now() - t0 }, transferablesOf(result));
  } catch (err) {
    self.postMessage({ t: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
