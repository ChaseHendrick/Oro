const KEY = 'oro.learn.rescue';

export const keysToRestore = Object.freeze(['ui.selectedPart', 'ui.panel', 'ui.audioQuality', 'playing']);

export function takeRescue(serializeFn, storage) {
  try {
    const json = serializeFn();
    storage.setItem(KEY, typeof json === 'string' ? json : JSON.stringify(json));
    return true;
  } catch { return false; }
}

export function restoreRescue(storage) {
  try {
    const raw = storage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clearRescue(storage) {
  try { storage.removeItem(KEY); } catch { /* ignore */ }
}
