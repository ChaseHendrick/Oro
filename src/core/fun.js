// Secrets, achievements and small scores (v2.9). Kept on this computer only
// (localStorage, never the session or the network): finding a secret or
// earning a badge is about the person, not the song.
//
//   found('secret', 'konami')        -> true the first time, false after
//   found('badge', 'first-drop')
//   has('secret', 'konami'), list('badge') -> [{ id, at }]
//   funData('golf') / setFunData('golf', {...})  small JSON values (scores)
//   onFun(fn) -> unsubscribe; fn({ kind, id }) on each new find
//
// Every read and write is wrapped: private windows and blocked storage just
// mean nothing is remembered.

const KEY = 'oro.fun.v1';
const MAX_DATA_BYTES = 16384;
let store = null;           // injected for tests
const listeners = new Set();

function storage() {
  if (store) return store;
  try { return globalThis.localStorage || null; } catch { return null; }
}

function read() {
  try {
    const raw = storage()?.getItem(KEY);
    const v = raw ? JSON.parse(raw) : null;
    if (v && typeof v === 'object') return { secret: v.secret || {}, badge: v.badge || {}, data: v.data || {} };
  } catch { /* ignore */ }
  return { secret: {}, badge: {}, data: {} };
}

function write(v) {
  try { storage()?.setItem(KEY, JSON.stringify(v)); } catch { /* ignore */ }
}

const kindOk = (k) => k === 'secret' || k === 'badge';
const idOk = (id) => typeof id === 'string' && /^[a-z0-9-]{1,40}$/.test(id);

/** Record a find. True only the first time. */
export function found(kind, id, now = Date.now()) {
  if (!kindOk(kind) || !idOk(id)) return false;
  const v = read();
  if (v[kind][id]) return false;
  v[kind][id] = now;
  write(v);
  for (const fn of listeners) { try { fn({ kind, id }); } catch { /* ignore */ } }
  return true;
}

export function has(kind, id) {
  return kindOk(kind) && !!read()[kind][id];
}

/** Finds of one kind, oldest first. */
export function list(kind) {
  if (!kindOk(kind)) return [];
  return Object.entries(read()[kind]).map(([id, at]) => ({ id, at: Number(at) || 0 })).sort((a, b) => a.at - b.at);
}

export function funData(key) {
  if (!idOk(key)) return null;
  const v = read().data[key];
  return v === undefined ? null : v;
}

export function setFunData(key, value) {
  if (!idOk(key)) return false;
  const v = read();
  v.data[key] = value;
  if (JSON.stringify(v.data).length > MAX_DATA_BYTES) return false;
  write(v);
  return true;
}

export function onFun(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Forget every secret, badge and score. */
export function resetFun() {
  try { storage()?.removeItem(KEY); } catch { /* ignore */ }
}

/** Tests: use a fake storage (null restores localStorage). */
export function _useStorage(s) { store = s; }
