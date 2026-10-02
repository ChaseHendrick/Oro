// Tiny observable state store addressed by dotted paths, e.g.
//   store.get('parts.0.params.cutoff')
//   store.set('parts.0.params.cutoff', 1200, { source: 'knob' })
//   const off = store.subscribe('parts.0.params', (path, value, meta) => { ... })
//
// A listener fires when the changed path and its prefix overlap in either
// direction: setting 'parts.0' notifies a 'parts.0.params.cutoff' listener and
// vice versa. Listeners whose prefix is deeper than the changed path receive the
// changed (ancestor) path, so they should re-read what they need with get().
//
// The root holds the persisted song/patch state (`global`, `parts`) plus a
// non-persisted `ui` branch (selected part, theme, transport, etc.).

import { defaultState } from './params.js';

export const DEFAULT_UI = Object.freeze({
  selectedPart: 0,
  theme: 'system',        // 'system' | 'dark' | 'light'
  playing: 0,             // sequencer transport
  audioStarted: 0,
  midiLearn: 0,
  view: 'orbit',          // camera preset: 'orbit' | 'top' | 'low'
  panel: 'sound',         // lower panel tab
  keyboardOctave: 4,
  quality: 'high',        // 'high' | 'medium' | 'low'
});

function splitPath(path) {
  return path === '' ? [] : String(path).split('.');
}

function overlaps(a, b) {
  if (a === '' || b === '') return true;
  if (a === b) return true;
  if (a.length < b.length) return b.startsWith(a) && b[a.length] === '.';
  return a.startsWith(b) && a[b.length] === '.';
}

export function deepClone(v) {
  return v == null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v));
}

export function createStore(initial = defaultState()) {
  let root = { ...deepClone(initial), ui: { ...DEFAULT_UI, ...(initial.ui || {}) } };
  const listeners = new Set();
  let batchDepth = 0;
  let pending = [];

  function get(path = '') {
    let node = root;
    for (const key of splitPath(path)) {
      if (node == null) return undefined;
      node = node[key];
    }
    return node;
  }

  function emit(path, value, meta) {
    if (batchDepth > 0) { pending.push([path, value, meta]); return; }
    for (const l of [...listeners]) {
      if (overlaps(l.prefix, path)) {
        try { l.fn(path, value, meta); } catch (err) { console.error('[store] listener error', err); }
      }
    }
  }

  function set(path, value, meta = {}) {
    const keys = splitPath(path);
    if (keys.length === 0) {
      root = { ...value, ui: root.ui };
      emit('', root, meta);
      return;
    }
    let node = root;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (node[k] == null || typeof node[k] !== 'object') node[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
      node = node[k];
    }
    const last = keys[keys.length - 1];
    if (node[last] === value && (value === null || typeof value !== 'object')) return;
    node[last] = value;
    emit(path, value, meta);
  }

  function subscribe(prefix, fn) {
    const entry = { prefix: prefix || '', fn };
    listeners.add(entry);
    return () => listeners.delete(entry);
  }

  /** Group many set() calls; listeners run once per change after the batch ends. */
  function batch(fn) {
    batchDepth++;
    try { fn(); } finally {
      batchDepth--;
      if (batchDepth === 0 && pending.length) {
        const queued = pending; pending = [];
        for (const [p, v, m] of queued) emit(p, v, m);
      }
    }
  }

  /** Persistable snapshot (no `ui`). */
  function serialize() {
    const { ui, ...rest } = root;
    return deepClone(rest);
  }

  /** Replace the persisted state wholesale (scene load / undo); keeps ui. */
  function load(state, meta = { source: 'load' }) {
    root = { ...deepClone(state), ui: root.ui };
    emit('', root, meta);
  }

  return { get, set, subscribe, batch, serialize, load };
}
