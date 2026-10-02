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
    if (!raw) return null;
    return migrateState(JSON.parse(raw));
  } catch (err) {
    console.warn('[orograph] ignoring unreadable saved session', err);
    return null;
  }
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
  let firstChange = null;   // time of the oldest unsaved change

  function clear() {
    if (timer != null) { timers.clearTimeout(timer); timer = null; }
  }

  function flush() {
    clear();
    if (firstChange == null) return false;
    firstChange = null;
    if (!storage) return false;
    try {
      storage.setItem(SESSION_KEY, JSON.stringify(store.serialize()));
      return true;
    } catch { return false; /* storage full or blocked */ }
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
    pending: () => firstChange != null,
    dispose() { clear(); },
  };
}
