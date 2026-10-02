// Minimal event emitter for the engine. A throwing listener must never break
// the audio host (telemetry arrives ~60 times a second), so errors are caught
// and reported once per event name.

export function createEmitter() {
  const map = new Map();
  const warned = new Set();

  function on(name, fn) {
    if (typeof fn !== 'function') return () => {};
    let set = map.get(name);
    if (!set) { set = new Set(); map.set(name, set); }
    set.add(fn);
    return () => off(name, fn);
  }

  function off(name, fn) {
    const set = map.get(name);
    if (set) set.delete(fn);
  }

  function emit(name, payload) {
    const set = map.get(name);
    if (!set || set.size === 0) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (err) {
        if (!warned.has(name)) { warned.add(name); console.error(`[audio] '${name}' listener failed`, err); }
      }
    }
  }

  function count(name) {
    const set = map.get(name);
    return set ? set.size : 0;
  }

  function clear() { map.clear(); }

  return { on, off, emit, count, clear };
}
