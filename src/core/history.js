// Undo history (v2.6): snapshots of the saved state (everything but `ui`)
// taken after each edit settles, so a knob drag or a burst of key presses is
// one step. Imported terrains and recordings are large and are always
// replaced, never edited in place, so snapshots share them by reference, and
// drum pad samples (base64 strings) are shared the same way.
//
// Edits from people (the UI, MIDI, scene and patch loads, imports) are
// recorded; the moving dot, the engine and preference writes are not, and a
// wholesale load (a session restore) just becomes the new starting point.

import { deepClone } from './store.js';
import { PART_PARAM_MAP, GLOBAL_PARAM_MAP } from './params.js';

const IGNORE = new Set(['physics', 'engine', 'prefs', 'transport', 'theme', 'history', 'load', 'voice', 'lock', 'version']);
const SHARED = ['userTerrain', 'noiseRecording'];

/** A drum kit with each pad's sample string shared (strings are immutable). */
function cloneDrum(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.pads)) return deepClone(d);
  return { ...deepClone({ ...d, pads: [] }), pads: d.pads.map((p) => (p && typeof p === 'object' ? { ...p, sample: p.sample && typeof p.sample === 'object' ? { ...p.sample } : p.sample ?? null } : p)) };
}

export function snapshotState(store) {
  const root = store.get('') || {};
  const out = {};
  for (const k of Object.keys(root)) {
    if (k === 'ui') continue;
    if (k === 'parts' && Array.isArray(root.parts)) {
      out.parts = root.parts.map((p) => {
        if (!p || typeof p !== 'object') return deepClone(p);
        const rest = {};
        for (const key of Object.keys(p)) if (!SHARED.includes(key) && key !== 'drum') rest[key] = p[key];
        const copy = deepClone(rest);
        for (const key of SHARED) if (key in p) copy[key] = p[key];
        if ('drum' in p) copy.drum = cloneDrum(p.drum);
        return copy;
      });
    } else out[k] = deepClone(root[k]);
  }
  return out;
}

/** A short name for an edit, from its store path ("Cutoff, track 2"). */
export function describeEdit(path, meta = {}) {
  if (meta.source === 'scene') return 'Load scene';
  if (meta.source === 'preset') return 'Load patch';
  if (meta.source === 'import') return 'Import';
  if (meta.source === 'capture') return 'Capture';
  if (meta.source === 'imprint') return 'Imprint';
  if (meta.source === 'restore') return 'Restore version';
  const k = String(path || '').split('.');
  if (k[0] === 'global' && k[1]) return GLOBAL_PARAM_MAP[k[1]]?.label || 'Global setting';
  if (k[0] === 'parts' && k.length >= 2) {
    const track = `track ${Number(k[1]) + 1}`;
    if (k.length === 2) return `Track ${Number(k[1]) + 1}`;
    if (k[2] === 'params' && k[3]) return `${PART_PARAM_MAP[k[3]]?.label || k[3]}, ${track}`;
    const names = { mods: 'Modulation', links: 'Links', patterns: 'Sequencer', drum: 'Drum kit', dot: 'Dot', trackFx: 'Track effects', funcPoints: 'Function', chain: 'Song mode', userTerrain: 'Terrain', arp: 'Arpeggiator', name: 'Rename', color: 'Colour', smart: 'Smart controls' };
    return `${names[k[2]] || 'Edit'}, ${track}`;
  }
  if (k[0] === 'parts') return 'Tracks';
  if (k[0] === 'tuning') return 'Tuning';
  if (k[0] === 'operator') return 'Operator panel';
  return 'Edit';
}

export function createHistory(store, { limit = 60, quiet = 350, timers = globalThis } = {}) {
  let cur = snapshotState(store);
  let past = [], future = [];
  let timer = 0, pending = null;
  const listeners = new Set();
  const notify = () => { for (const fn of listeners) { try { fn(); } catch { /* ignore */ } } };

  function commit() {
    if (!pending) return;
    timers.clearTimeout(timer); timer = 0;
    past.push({ state: pending.before, label: pending.label });
    if (past.length > limit) past.shift();
    future = [];
    pending = null;
    cur = snapshotState(store);
    notify();
  }

  const off = store.subscribe('', (path, value, meta = {}) => {
    if (path === 'ui' || String(path).startsWith('ui.')) return;
    if (IGNORE.has(meta.source)) {
      // a wholesale replacement that is not an edit becomes the new start
      if (path === '' && meta.source !== 'history' && !pending) { cur = snapshotState(store); }
      return;
    }
    if (!pending) pending = { before: cur, label: describeEdit(path, meta) };
    else if (pending.label !== describeEdit(path, meta)) pending.label = describeEdit(path, meta);
    timers.clearTimeout(timer);
    timer = timers.setTimeout(commit, quiet);
  });

  function restore(state) {
    store.load(state, { source: 'history' });
    cur = snapshotState(store);
  }

  return {
    get canUndo() { return past.length > 0 || !!pending; },
    get canRedo() { return future.length > 0; },
    /** Labels, oldest first, and how many of them can be undone. */
    list() { return { past: past.map(e => e.label), future: future.map(e => e.label).reverse() }; },
    undo() {
      commit();
      const e = past.pop();
      if (!e) return null;
      future.push({ state: snapshotState(store), label: e.label });
      restore(e.state);
      notify();
      return e.label;
    },
    redo() {
      commit();
      const e = future.pop();
      if (!e) return null;
      past.push({ state: snapshotState(store), label: e.label });
      restore(e.state);
      notify();
      return e.label;
    },
    /** Undo back until `count` edits remain (for the history list). */
    undoTo(count) { let n = 0; while (past.length > Math.max(0, count) && this.undo()) n++; return n; },
    flush: commit,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    dispose() { off(); timers.clearTimeout(timer); listeners.clear(); },
  };
}
