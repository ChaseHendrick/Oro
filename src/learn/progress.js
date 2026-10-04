const KEY = 'oro.learn.v1';

export function createProgress(storage) {
  function read() {
    try {
      const raw = storage && storage.getItem(KEY);
      const data = raw ? JSON.parse(raw) : {};
      return data && typeof data === 'object' ? data : {};
    } catch { return {}; }
  }
  function write(data) {
    try { storage && storage.setItem(KEY, JSON.stringify(data)); } catch { /* private mode */ }
  }
  return {
    completed(id) { return !!read()[id]; },
    mark(id) { const data = read(); data[id] = 1; write(data); },
    allDone(ids) { const data = read(); return ids.every((id) => data[id]); },
  };
}
