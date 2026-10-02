// audioWorklet.addModule for bundled code strings, shared by the live engine
// and the offline bounce. Blob URL first; file:// pages refuse Blob URLs for
// audioWorklet.addModule, so a data: URL is the second try.

const ADD_MODULE_TIMEOUT_MS = 10000;

export function withTimeout(promise, ms, what) {
  let timer = 0;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * audioWorklet.addModule with the Blob URL -> data: URL fallback.
 * @returns {Promise<{ok: boolean, via: 'blob'|'data'|null, errors: string[]}>}
 */
export async function loadWorkletModule(ctx, code) {
  const errors = [];
  if (!ctx || !ctx.audioWorklet || typeof AudioWorkletNode !== 'function') {
    return { ok: false, via: null, errors: ['AudioWorklet is not available (needs a secure context)'] };
  }
  let blobUrl = null;
  try {
    blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    await withTimeout(ctx.audioWorklet.addModule(blobUrl), ADD_MODULE_TIMEOUT_MS, 'addModule(blob)');
    return { ok: true, via: 'blob', errors };
  } catch (err) {
    errors.push(String((err && err.message) || err));
  } finally {
    if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch { /* ignore */ } }
  }
  try {
    await withTimeout(ctx.audioWorklet.addModule('data:text/javascript;charset=utf-8,' + encodeURIComponent(code)), ADD_MODULE_TIMEOUT_MS, 'addModule(data)');
    return { ok: true, via: 'data', errors };
  } catch (err) {
    errors.push(String((err && err.message) || err));
  }
  return { ok: false, via: null, errors };
}
