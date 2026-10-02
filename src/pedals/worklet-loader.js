// Loads the pedal / guitar AudioWorklet processors into a context once.
// Same Blob URL -> data: URL fallback as the audio host (file:// pages refuse
// Blob URLs for addModule). Browser only: the import below is a string the
// vite plugin in vite.config.js builds from guitar-worklet.js.

import code from 'virtual:worklet:src/pedals/guitar-worklet.js';

const loaded = new WeakMap();

async function addModule(ctx, url) {
  let timer = 0;
  try {
    return await Promise.race([
      ctx.audioWorklet.addModule(url),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('addModule timed out')), 10000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @returns {Promise<{ok: boolean, via: 'blob'|'data'|null, errors: string[], reason: string|null}>}
 *   ok false means createCapture / createGuitarInput will use their ScriptProcessor fallback.
 */
export function loadPedalWorklets(ctx) {
  if (!ctx) return Promise.resolve({ ok: false, via: null, errors: ['no context'], reason: 'Audio is not running yet.' });
  if (loaded.has(ctx)) return loaded.get(ctx);
  const p = (async () => {
    const errors = [];
    if (!ctx.audioWorklet || typeof AudioWorkletNode !== 'function') {
      return { ok: false, via: null, errors: ['AudioWorklet is not available'], reason: 'This browser has no AudioWorklet here, so guitar tracking runs on the main thread.' };
    }
    let url = null;
    try {
      url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      await addModule(ctx, url);
      return { ok: true, via: 'blob', errors, reason: null };
    } catch (err) {
      errors.push(String((err && err.message) || err));
    } finally {
      if (url) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }
    }
    try {
      await addModule(ctx, 'data:text/javascript;charset=utf-8,' + encodeURIComponent(code));
      return { ok: true, via: 'data', errors, reason: null };
    } catch (err) {
      errors.push(String((err && err.message) || err));
    }
    return { ok: false, via: null, errors, reason: 'The guitar worklet could not load, so guitar tracking runs on the main thread.' };
  })();
  loaded.set(ctx, p);
  return p;
}
