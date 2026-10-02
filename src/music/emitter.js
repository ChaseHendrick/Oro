// Minimal event emitter shared by the music, MIDI and preset modules.
// Listener errors are caught so one broken UI widget cannot stop the
// scheduler or the MIDI input handler that is emitting.

export function createEmitter() {
  const map = new Map();
  return {
    on(type, fn) {
      if (typeof fn !== 'function') return () => {};
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
      return () => this.off(type, fn);
    },
    off(type, fn) {
      const set = map.get(type);
      if (set) set.delete(fn);
    },
    emit(type, detail) {
      const set = map.get(type);
      if (!set || set.size === 0) return;
      for (const fn of [...set]) {
        try { fn(detail); } catch (err) { console.error(`[orograph] ${type} listener failed`, err); }
      }
    },
    has(type) {
      const set = map.get(type);
      return !!(set && set.size);
    },
  };
}
