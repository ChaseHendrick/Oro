// Operator panel Bookkeeping (v2.9): local-only play statistics, kept in
// this browser's localStorage. Nothing is ever sent anywhere. Every storage
// access is wrapped, so a private window or blocked storage just means the
// numbers start from zero each time.

export const BOOKKEEPING_KEY = 'orograph.bookkeeping';
export const BOOK_FIELDS = ['seconds', 'notes', 'sessions', 'patches'];

const empty = () => ({ seconds: 0, notes: 0, sessions: 0, patches: 0, since: 0 });

/** Any stored value -> clean counters (whole, non-negative numbers). */
export function sanitizeBook(src) {
  const out = empty();
  if (!src || typeof src !== 'object') return out;
  for (const k of [...BOOK_FIELDS, 'since']) {
    const v = Number(src[k]);
    out[k] = Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  }
  return out;
}

/**
 * @param {object} [o]
 * @param {Storage|null} [o.storage] defaults to localStorage when there is one
 * @param {() => number} [o.now] ms clock for the "since" date
 */
export function createBookkeeping({ storage, now = () => Date.now() } = {}) {
  let store = storage;
  if (store === undefined) { try { store = globalThis.localStorage || null; } catch { store = null; } }
  let data = empty();
  try { const raw = store && store.getItem(BOOKKEEPING_KEY); if (raw) data = sanitizeBook(JSON.parse(raw)); } catch { data = empty(); }
  if (!data.since) data.since = Math.floor(now());
  let dirty = false;

  function save() {
    dirty = false;
    try { if (store) store.setItem(BOOKKEEPING_KEY, JSON.stringify(data)); return true; } catch { return false; }
  }

  return {
    /** A copy of the counters. */
    get: () => ({ ...data }),
    /** Adds `n` to a counter (saved on the next flush()). */
    add(field, n = 1) {
      if (!BOOK_FIELDS.includes(field) || !(n > 0)) return;
      data[field] += Math.floor(n);
      dirty = true;
    },
    flush() { return dirty ? save() : true; },
    reset() { data = empty(); data.since = Math.floor(now()); return save(); },
  };
}

/** Seconds -> "2 h 05 min", "4 min 10 s" or "12 s". */
export function formatPlayTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(r).padStart(2, '0')} s`;
  return `${r} s`;
}
