// Lazy-loading boundaries (2.11). Rarely used panels (Settings, Help, Golf,
// the terrain library, real places, data, formula, Imprint, the sound map)
// live in their own chunks and load on first use. `prefetchWhenIdle` warms
// them after start-up so a later click opens them without a wait.
//
// The single-file build inlines every chunk, so the same code works there.

/**
 * Wrap a dynamic import. `load()` imports once (a failed import may be
 * retried), `get()` is the module once loaded (else null), and `run(fn)` calls
 * fn(module) at once when loaded or after loading (then it returns a promise).
 */
export function lazy(loader) {
  let promise = null;
  let mod = null;
  function load() {
    if (!promise) {
      promise = Promise.resolve().then(loader).then(
        (m) => { mod = m; return m; },
        (err) => { promise = null; throw err; });
    }
    return promise;
  }
  return {
    load,
    get: () => mod,
    run(fn, label = 'feature') {
      if (mod) return fn(mod);
      return load().then(fn, (err) => { console.warn(`[ui] ${label} could not load`, err); return null; });
    },
    prefetch() { load().catch(() => { /* retried on use */ }); },
  };
}

/**
 * A modal-like handle ({ isOpen, close, select }) for a dialog whose module
 * may still be loading. Already loaded: the real handle, opened synchronously.
 * Otherwise the stub counts as open until it is closed, remembers the last
 * select(), and swaps in the real dialog when the module arrives.
 */
export function deferredDialog(lz, open, label = 'dialog') {
  const ready = lz.get();
  if (ready) return open(ready);
  let real = null;
  let cancelled = false;
  let tab = null;
  const handle = {
    isOpen: () => (real ? real.isOpen() : !cancelled),
    close: (...args) => { if (real) return real.close(...args); cancelled = true; return undefined; },
    select: (id) => { if (real && real.select) return real.select(id); tab = id; return undefined; },
    current: () => (real && real.current ? real.current() : tab),
    ready: lz.load().then((m) => {
      if (cancelled) return null;
      real = open(m);
      if (tab != null && real && real.select) real.select(tab);
      return real;
    }, (err) => {
      cancelled = true;
      console.warn(`[ui] ${label} could not load`, err);
      return null;
    }),
  };
  return handle;
}

/** Warm lazy chunks once the page is idle (or after `delay` ms at most). */
export function prefetchWhenIdle(list, delay = 4000) {
  const go = () => { for (const lz of list) lz.prefetch(); };
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  setTimeout(() => {
    if (typeof g.requestIdleCallback === 'function') g.requestIdleCallback(go, { timeout: delay });
    else go();
  }, Math.min(1500, delay));
}

// The lazy chunks, in one place so the boundaries are easy to see.
export const chunks = {
  settings: lazy(() => import('./settings.js')),
  help: lazy(() => import('./help.js')),
  golf: lazy(() => import('./golf.js')),
  terrainLibrary: lazy(() => import('./terrain-library.js')),
  realPlaces: lazy(() => import('./real-places.js')),
  dataPanel: lazy(() => import('./data-panel.js')),
  formula: lazy(() => import('./formula-terrain.js')),
  imprint: lazy(() => import('./imprint-panel.js')),
  soundMap: lazy(() => import('./sound-map-view.js')),
};
