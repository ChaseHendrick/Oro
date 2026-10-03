// Version history (v2.12): saved snapshots of the session over time.
//
// A version is the persisted session (store.serialize()) at a moment, kept in
// IndexedDB through durable storage under its own keys, so the autosaved
// session itself is never touched:
//   orograph.versions.index        the list (JSON), newest last
//   orograph.versions.v.<id>       one version's session JSON
//   orograph.versions.b.<hash>     a large string (imported terrain, noise
//                                  recording, drum sample) shared by content
// Strings of BLOB_MIN characters or more are stored once by a 64-bit content
// hash and referenced as {"$blob": hash}, so a hundred versions of a session
// with one imported terrain hold one copy of it.
//
// When: automatically once the session has changed and then been quiet for
// two minutes (or after ten minutes of continuous changes), when the app is
// closed or hidden with unsaved changes, and on Save version (named). An
// unchanged session never makes a new automatic version.
// Retention: everything from the last 7 days, then the newest version of
// each day for 60 days, plus every named version; then a size cap drops the
// oldest unnamed versions first. Blobs no version uses are deleted.

import { describeEdit } from './history.js';
import { NOTE_NAMES, SCALE_NAMES } from './params.js';

export const VERSION_PREFIX = 'orograph.versions.';
export const INDEX_KEY = `${VERSION_PREFIX}index`;
export const BLOB_MIN = 4096;
export const QUIET_MS = 2 * 60 * 1000;
export const MAX_WAIT_MS = 10 * 60 * 1000;
export const FULL_DAYS = 7;
export const DAILY_DAYS = 60;
export const SIZE_CAP = 200 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
// Store writes that are not edits: the moving dot, the engine, preferences, previews.
const IGNORE = new Set(['physics', 'engine', 'prefs', 'transport', 'theme', 'load', 'voice', 'lock', 'version']);

/** 64-bit content hash of a string (two independent 32-bit hashes) plus its length, as hex. */
export function hashString(s) {
  let a = 0x811c9dc5, b = 0x9747b28c;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995); b ^= b >>> 15;
  }
  b = Math.imul(b ^ (b >>> 13), 0xc2b2ae35); b ^= b >>> 16;
  const hex = (x) => (x >>> 0).toString(16).padStart(8, '0');
  return `${hex(a)}${hex(b)}${s.length.toString(16)}`;
}

/** Replace large strings by {$blob: hash}. Returns { obj, blobs: Map<hash, string> }. */
export function externalize(state, min = BLOB_MIN) {
  const blobs = new Map();
  const walk = (v) => {
    if (typeof v === 'string') {
      if (v.length < min) return v;
      const hsh = hashString(v);
      blobs.set(hsh, v);
      return { $blob: hsh };
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = walk(v[k]); return o; }
    return v;
  };
  return { obj: walk(state), blobs };
}

/** Put the blobs back (getBlob(hash) -> string). */
export function internalize(obj, getBlob) {
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      if (typeof v.$blob === 'string' && Object.keys(v).length === 1) {
        const s = getBlob(v.$blob);
        if (typeof s !== 'string') throw new Error('A part of this version is missing');
        return s;
      }
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k]);
      return o;
    }
    return v;
  };
  return walk(obj);
}

function diffPaths(a, b, path, depth, out) {
  if (a === b) return;
  const objA = a && typeof a === 'object', objB = b && typeof b === 'object';
  if (objA && objB && depth < 4 && !('$blob' in a) && !('$blob' in b)) {
    if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) {
      if (path === 'parts') out.push(a.length < b.length ? `+track:${b.length}` : `-track:${a.length}`);
      else if (/^parts\.\d+\.patterns$/.test(path) && b.length > a.length) { out.push(`+pattern:${path.split('.')[1]}`); return; }
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (Array.isArray(a) && Array.isArray(b) && (Number(k) >= a.length || Number(k) >= b.length)) continue;
      diffPaths(a[k], b[k], path ? `${path}.${k}` : k, depth + 1, out);
    }
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push(path);
}

/** "Cutoff, track 2; new pattern on track 3" (versions as externalized objects). */
export function diffSummary(prev, next, max = 3) {
  if (!prev) return 'First version';
  const paths = [];
  diffPaths(prev, next, '', 0, paths);
  const items = [];
  for (const p of paths) {
    let label;
    if (p.startsWith('+track:')) label = `Added track ${p.slice(7)}`;
    else if (p.startsWith('-track:')) label = `Removed track ${p.slice(7)}`;
    else if (p.startsWith('+pattern:')) label = `new pattern on track ${Number(p.slice(9)) + 1}`;
    else if (/^parts\.\d+\.noiseRecording/.test(p)) label = `Noise recording, track ${Number(p.split('.')[1]) + 1}`;
    else label = describeEdit(p);
    if (!items.includes(label)) items.push(label);
  }
  if (!items.length) return 'No changes';
  const shown = items.slice(0, max).map((s, i) => (i === 0 ? s[0].toUpperCase() + s.slice(1) : s));
  return shown.join('; ') + (items.length > max ? `; and ${items.length - max} more` : '');
}

const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

/**
 * Which versions to keep: named ones always; everything from the last
 * `fullDays`; the newest of each day up to `dailyDays`; nothing older.
 * `list` oldest first. Returns { keep, drop }.
 */
export function thinVersions(list, now, { fullDays = FULL_DAYS, dailyDays = DAILY_DAYS } = {}) {
  const keep = [], drop = [];
  const newestOfDay = new Map();
  for (const v of list) {
    const k = dayKey(v.time);
    const cur = newestOfDay.get(k);
    if (!cur || v.time >= cur.time) newestOfDay.set(k, v);
  }
  for (const v of list) {
    const age = now - v.time;
    const ok = !!v.name || age <= fullDays * DAY || (age <= dailyDays * DAY && newestOfDay.get(dayKey(v.time)) === v);
    (ok ? keep : drop).push(v);
  }
  return { keep, drop };
}

/** Bytes used by `list` (docs plus each blob once). */
export function totalSize(list, blobSizes) {
  const blobs = new Set();
  let n = 0;
  for (const v of list) { n += v.size || 0; for (const b of v.blobs || []) blobs.add(b); }
  for (const b of blobs) n += blobSizes[b] || 0;
  return n;
}

/** Drop the oldest unnamed versions (never the newest one) until `list` fits `cap`. Returns { keep, drop }. */
export function capVersions(list, blobSizes, cap = SIZE_CAP) {
  const keep = list.slice(), drop = [];
  while (totalSize(keep, blobSizes) > cap) {
    const i = keep.findIndex((v, k) => !v.name && k < keep.length - 1);
    if (i < 0) break;
    drop.push(...keep.splice(i, 1));
  }
  return { keep, drop };
}

function describeState(state) {
  const g = (state && state.global) || {};
  const tracks = Array.isArray(state && state.parts) ? state.parts.length : 0;
  const key = `${NOTE_NAMES[Math.round(g.scaleRoot) || 0] || 'C'} ${SCALE_NAMES[Math.round(g.scaleType) || 0] || ''}`.trim();
  return { tracks, tempo: Math.round((Number(g.tempo) || 120) * 10) / 10, key };
}

/** The durable-storage backend (IndexedDB only, never localStorage). */
export async function durableBackend() {
  const { readDurable, writeDurable, removeDurable } = await import('./durable-storage.js');
  return {
    get: (k) => readDurable(k, null),
    set: (k, v) => writeDurable(k, v, null).done,
    remove: (k) => removeDurable(k),
  };
}

/** A Map-backed backend (tests). */
export function memoryBackend(map = new Map()) {
  return { map, get: async (k) => (map.has(k) ? map.get(k) : null), set: async (k, v) => { map.set(k, v); return true; }, remove: async (k) => map.delete(k) };
}

/**
 * The version list and its storage. All writes are serialised.
 * { ready, list(), save(state, {name, kind}), get(id), rename(id, name), remove(id), on(fn) }
 */
export function createVersionStore({ backend, now = () => Date.now(), cap = SIZE_CAP } = {}) {
  let index = { v: 1, versions: [], blobSizes: {} };
  let lastObj = null;          // externalized object of the newest version (for summaries)
  let queue = Promise.resolve();
  const listeners = new Set();
  const notify = () => { for (const fn of listeners) { try { fn(); } catch { /* ignore */ } } };
  const run = (fn) => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };
  const vKey = (id) => `${VERSION_PREFIX}v.${id}`;
  const bKey = (h) => `${VERSION_PREFIX}b.${h}`;

  const ready = run(async () => {
    try {
      const raw = await backend.get(INDEX_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && Array.isArray(parsed.versions)) index = { v: 1, versions: parsed.versions, blobSizes: parsed.blobSizes || {} };
    } catch { /* start a fresh list */ }
    const last = index.versions[index.versions.length - 1];
    if (last) { try { lastObj = JSON.parse(await backend.get(vKey(last.id))); } catch { lastObj = null; } }
  });

  async function prune() {
    const t = now();
    const thin = thinVersions(index.versions, t);
    const cut = capVersions(thin.keep, index.blobSizes, cap);
    const drop = [...thin.drop, ...cut.drop];
    if (!drop.length) return [];
    index.versions = cut.keep;
    const used = new Set(index.versions.flatMap(v => v.blobs || []));
    for (const v of drop) await backend.remove(vKey(v.id));
    for (const h of Object.keys(index.blobSizes)) if (!used.has(h)) { await backend.remove(bKey(h)); delete index.blobSizes[h]; }
    return drop;
  }

  const writeIndex = () => backend.set(INDEX_KEY, JSON.stringify(index));

  return {
    ready,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Versions, oldest first (copies). */
    list: () => index.versions.map(v => ({ ...v })),
    get latest() { const v = index.versions[index.versions.length - 1]; return v ? { ...v } : null; },
    /**
     * Save `state` as a version. kind: 'auto' | 'close' | 'manual' | 'restore'.
     * An automatic save of a session equal to the newest version is skipped (resolves null).
     */
    save(state, { name = '', kind = 'auto' } = {}) {
      return run(async () => {
        const { obj, blobs } = externalize(state);
        const doc = JSON.stringify(obj);
        const hash = hashString(doc);
        const last = index.versions[index.versions.length - 1];
        if (!name && last && last.hash === hash) return null;
        let t = now();
        if (last && t <= last.time) t = last.time + 1;
        const id = `${t.toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
        for (const [h, s] of blobs) {
          if (index.blobSizes[h] !== undefined) continue;
          if (!await backend.set(bKey(h), s)) throw new Error('The version could not be saved');
          index.blobSizes[h] = s.length;
        }
        if (!await backend.set(vKey(id), doc)) throw new Error('The version could not be saved');
        const entry = { id, time: t, name: String(name || '').slice(0, 80), kind, hash, size: doc.length, blobs: [...blobs.keys()], summary: diffSummary(lastObj, obj), ...describeState(state) };
        index.versions.push(entry);
        lastObj = obj;
        await prune();
        await writeIndex();
        notify();
        return { ...entry };
      });
    },
    /** The session of version `id`. */
    get(id) {
      return run(async () => {
        const raw = await backend.get(vKey(id));
        if (!raw) throw new Error('This version is no longer stored');
        const obj = JSON.parse(raw);
        const need = new Map();
        const v = index.versions.find(e => e.id === id);
        for (const h of (v && v.blobs) || []) need.set(h, await backend.get(bKey(h)));
        return internalize(obj, (h) => need.get(h));
      });
    },
    rename(id, name) {
      return run(async () => {
        const v = index.versions.find(e => e.id === id);
        if (!v) return false;
        v.name = String(name || '').trim().slice(0, 80);
        await writeIndex();
        notify();
        return true;
      });
    },
    remove(id) {
      return run(async () => {
        const i = index.versions.findIndex(e => e.id === id);
        if (i < 0) return false;
        const [v] = index.versions.splice(i, 1);
        await backend.remove(vKey(v.id));
        const used = new Set(index.versions.flatMap(e => e.blobs || []));
        for (const h of v.blobs || []) if (!used.has(h)) { await backend.remove(bKey(h)); delete index.blobSizes[h]; }
        if (i === index.versions.length) {
          const last = index.versions[index.versions.length - 1];
          lastObj = last ? JSON.parse(await backend.get(vKey(last.id))) : null;
        }
        await writeIndex();
        notify();
        return true;
      });
    },
    size: () => totalSize(index.versions, index.blobSizes),
    settled: () => queue,
  };
}

/**
 * When to save automatically: after `quietMs` without changes, or at once
 * when changes have gone on for `maxMs`. save(kind) does the work.
 */
export function createVersionScheduler({ save, timers = globalThis, now = () => Date.now(), quietMs = QUIET_MS, maxMs = MAX_WAIT_MS } = {}) {
  let timer = null, first = null, paused = false;
  const clear = () => { if (timer != null) { timers.clearTimeout(timer); timer = null; } };
  function fire(kind = 'auto') {
    clear();
    if (first == null) return null;
    first = null;
    return save(kind);
  }
  return {
    changed() {
      if (paused) return;
      const t = now();
      if (first == null) first = t;
      clear();
      if (t - first >= maxMs) { fire('auto'); return; }
      timer = timers.setTimeout(() => fire('auto'), quietMs);
    },
    flush: (kind = 'close') => fire(kind),
    pending: () => first != null,
    pause(on) { paused = !!on; if (paused) { clear(); first = null; } },
    dispose: clear,
  };
}

/**
 * The app's version history: the store, the scheduler on store edits, and
 * preview / restore. Only one per page (getVersions()).
 */
export function createVersions({ store, backend, timers = globalThis, now = () => Date.now(), quietMs, maxMs, cap, migrate = (s) => s } = {}) {
  const versions = createVersionStore({ backend, now, cap });
  const saveCurrent = (kind, name = '') => versions.save(store.serialize(), { kind, name }).catch((err) => { console.warn('[versions] save failed', err); return null; });
  const scheduler = createVersionScheduler({ save: (kind) => saveCurrent(kind), timers, now, quietMs, maxMs });
  let previewing = null;   // { id, entry, keep }
  const listeners = new Set();
  const notify = () => { for (const fn of listeners) { try { fn(); } catch { /* ignore */ } } };
  const off = store.subscribe('', (path, value, meta = {}) => {
    if (path === 'ui' || String(path).startsWith('ui.')) return;
    if (IGNORE.has(meta.source)) return;
    scheduler.changed();
  });

  return {
    store: versions,
    scheduler,
    ready: versions.ready,
    on(fn) { listeners.add(fn); const o = versions.on(fn); return () => { listeners.delete(fn); o(); }; },
    list: () => versions.list(),
    get previewing() { return previewing ? { id: previewing.id, entry: { ...previewing.entry } } : null; },
    /** Save version (named or not): always makes a version. */
    saveNamed: (name) => versions.save(store.serialize(), { kind: 'manual', name: String(name || '').trim() || 'Saved version' }),
    saveNow: (kind = 'auto') => saveCurrent(kind),
    /** Load a version temporarily (not undoable, not a change). */
    async preview(id) {
      if (!previewing) await scheduler.flush('auto');
      const state = migrate(await versions.get(id));
      const entry = versions.list().find(v => v.id === id) || { id };
      if (!previewing) previewing = { keep: store.serialize() };
      previewing.id = id; previewing.entry = entry;
      scheduler.pause(true);
      store.load(state, { source: 'version' });
      notify();
    },
    /** Leave the preview: the session as it was before it. */
    goBack() {
      if (!previewing) return false;
      const keep = previewing.keep;
      previewing = null;
      store.load(keep, { source: 'version' });
      scheduler.pause(false);
      notify();
      return true;
    },
    /** Make the previewed version (with any edits made while previewing) the session. */
    async keep() {
      if (!previewing) return false;
      const target = store.serialize();
      const keep = previewing.keep;
      previewing = null;
      store.load(keep, { source: 'version' });
      scheduler.pause(false);
      await versions.save(keep, { kind: 'restore' }).catch(() => null);
      store.load(target, { source: 'restore' });
      notify();
      return true;
    },
    /** Make version `id` the session: the current state becomes a version first; undoable. */
    async restore(id) {
      if (previewing && previewing.id === id) return this.keep();
      if (previewing) this.goBack();
      const state = migrate(await versions.get(id));
      scheduler.flush('auto');
      await saveCurrent('restore');
      store.load(state, { source: 'restore' });
      notify();
      return true;
    },
    rename: (id, name) => versions.rename(id, name),
    remove: (id) => versions.remove(id),
    get: (id) => versions.get(id).then(migrate),
    /** App closing or hidden: leave any preview and save unsaved changes. */
    close() {
      if (previewing) {
        const keep = previewing.keep;
        previewing = null;
        store.load(keep, { source: 'version' });
        scheduler.pause(false);
      }
      return scheduler.flush('close');
    },
    dispose() { off(); scheduler.dispose(); listeners.clear(); },
  };
}

let current = null, starting = null;
/** Start version history for the app (main.js, after the UI). Safe to call again. */
export function startVersions({ store, migrate } = {}) {
  if (!starting) starting = (async () => {
    const mig = migrate || (await import('./migrate.js')).migrateState;
    current = createVersions({ store, backend: await durableBackend(), migrate: mig });
    const onHide = () => { try { current.close(); } catch { /* ignore */ } };
    // capture: runs before the session autosave flush, so a preview is never saved as the session
    window.addEventListener('pagehide', onHide, true);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && !current.previewing && current.scheduler.pending()) current.scheduler.flush('close'); }, true);
    return current;
  })();
  return starting;
}
export const getVersions = () => current;
