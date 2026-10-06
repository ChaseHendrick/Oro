// Dedicated worker for offline score renders on a page (2.17.1), so a long
// render no longer stalls the interface. Bundled into a classic script by
// vite.config.js (virtual:worklet:...), started by score-render-host.js.
//
// in:  {t:'ping'} | {t:'render', id, input, opts}
// out: {t:'pong'} | {t:'progress', id, f} | {t:'done', id, result} (left and right transferred)
//      | {t:'error', id, message}

import { renderScore } from './score-render.js';

self.onmessage = async (e) => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.t === 'ping') { self.postMessage({ t: 'pong' }); return; }
  if (m.t !== 'render') return;
  try {
    const result = await renderScore(m.input, { ...(m.opts || {}), onProgress: (f) => self.postMessage({ t: 'progress', id: m.id, f }) });
    const transfer = result.ok ? [result.left.buffer, result.right.buffer] : [];
    self.postMessage({ t: 'done', id: m.id, result }, transfer);
  } catch (err) {
    self.postMessage({ t: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
