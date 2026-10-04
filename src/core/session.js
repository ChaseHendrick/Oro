// Session autosave: the persisted part of the store (`global`, `parts`) is
// written to localStorage a short while after it changes.
//
// Two things matter beyond a plain debounce:
//   * A moving dot (Roll, Drift, Explore, Tour, a lock glide) writes the store
//     many times a second for as long as it moves. A debounce that restarts on
//     every change would then never save, so a save is also forced once the
//     oldest unsaved change is `maxWait` ms old.
//   * Closing or reloading the page right after a change must not lose it:
//     flush() saves at once, and main.js calls it on pagehide and when the
//     page is hidden.

import { readDurable, writeDurable, LARGE_STORAGE_MARKER } from './durable-storage.js';
import { migrateState } from './migrate.js';

export const SESSION_KEY = 'orograph.session.v1';
export const SAVE_DELAY_MS = 600;     // quiet time before a save
export const SAVE_MAX_WAIT_MS = 2000; // a change is never left unsaved longer than this

function safeStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/** The saved session, migrated to the current format, or null. */
export function loadSession(storage = safeStorage()) {
  try {
    const raw = storage && storage.getItem(SESSION_KEY);
    if (!raw || raw === LARGE_STORAGE_MARKER) return null;
    return migrateState(JSON.parse(raw));
  } catch (err) {
    console.warn('[orograph] ignoring unreadable saved session', err);
    return null;
  }
}

/** Read both small legacy saves and larger IndexedDB saves before boot. */
export async function loadSessionAsync(storage = safeStorage()) {
  try { const raw = await readDurable(SESSION_KEY, storage); return raw ? migrateState(JSON.parse(raw)) : null; }
  catch { return null; }
}

/**
 * Save `store.serialize()` after changes. Returns { schedule, flush, pending, dispose }:
 * schedule() marks the session changed, flush() saves now if anything is unsaved.
 */
export function createAutosave({
  store, storage = safeStorage(), delay = SAVE_DELAY_MS, maxWait = SAVE_MAX_WAIT_MS,
  timers = globalThis, now = () => Date.now(),
} = {}) {
  let timer = null;
  let latestSave = Promise.resolve(true);
  let saveRevision = 0, inFlight = false;
  let firstChange = null;   // time of the oldest unsaved change

  let payload = () => store.serialize();

  function clear() {
    if (timer != null) { timers.clearTimeout(timer); timer = null; }
  }

  function flush() {
    clear();
    if (firstChange == null) return false;
    const unsavedSince = firstChange, revision = ++saveRevision;
    firstChange = null;
    try {
      const result = writeDurable(SESSION_KEY, JSON.stringify(payload()), storage);
      inFlight = !result.immediate;
      latestSave = result.done.then(ok => {
        if (revision === saveRevision) {
          inFlight = false;
          if (!ok) {
            firstChange = firstChange == null ? unsavedSince : Math.min(firstChange, unsavedSince);
            console.warn('[orograph] session could not be saved; export a scene to keep it');
          }
        }
        return ok;
      });
      return result.immediate;
    } catch { firstChange = unsavedSince; inFlight = false; latestSave = Promise.resolve(false); return false; }
  }

  function schedule() {
    const t = now();
    if (firstChange == null) firstChange = t;
    clear();
    const wait = Math.max(0, Math.min(delay, firstChange + maxWait - t));
    timer = timers.setTimeout(flush, wait);
  }

  return {
    schedule,
    flush,
    pending: () => firstChange != null || inFlight,
    settled: () => latestSave,
    setPayload(fn) { payload = typeof fn === 'function' ? fn : () => store.serialize(); },
    dispose() { clear(); },
  };
}
