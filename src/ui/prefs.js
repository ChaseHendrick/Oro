// Per-device preferences (not part of a song or patch): visual quality, map
// render style, palette, auto-rotate, motion and tips. Persisted under
// localStorage['orograph.settings'] and restored into store.ui at startup.
// The theme preference is stored separately by theme.js (its own key is part
// of the cross-module theme contract) but is mirrored here as well.

export const SETTINGS_KEY = 'orograph.settings';

export const PREF_DEFAULTS = Object.freeze({
  theme: 'system',
  quality: 'high',
  renderStyle: 'relief',
  palette: 0,
  autoRotate: 1,
  reduceMotion: 'system', // 'system' | 'on' | 'off'
  showTips: 1,
  keysOpen: 1,
  mapCollapsed: 0,
  audioQuality: 'standard',
});

const VALID = {
  theme: v => ['system', 'dark', 'light'].includes(v),
  quality: v => ['high', 'medium', 'low'].includes(v),
  renderStyle: v => ['relief', 'wire', 'contour', 'heat', 'points'].includes(v),
  palette: v => Number.isInteger(v) && v >= 0 && v < 32,
  autoRotate: v => v === 0 || v === 1,
  reduceMotion: v => ['system', 'on', 'off'].includes(v),
  showTips: v => v === 0 || v === 1,
  keysOpen: v => v === 0 || v === 1,
  mapCollapsed: v => v === 0 || v === 1,
  audioQuality: v => ['eco', 'standard', 'high', 'pristine', 'raw'].includes(v),
};

/** Keep only known keys with valid values; fill the rest from defaults. */
export function sanitizePrefs(src) {
  const out = { ...PREF_DEFAULTS };
  if (!src || typeof src !== 'object') return out;
  for (const key of Object.keys(PREF_DEFAULTS)) {
    let v = src[key];
    if (typeof PREF_DEFAULTS[key] === 'number' && typeof v === 'boolean') v = v ? 1 : 0;
    if (VALID[key](v)) out[key] = v;
  }
  return out;
}

export function loadPrefs(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(SETTINGS_KEY);
    return sanitizePrefs(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...PREF_DEFAULTS };
  }
}

export function savePrefs(prefs, storage = globalThis.localStorage) {
  try { storage?.setItem(SETTINGS_KEY, JSON.stringify(sanitizePrefs(prefs))); } catch { /* blocked */ }
}

// Store-backed keys (live in store.ui so visuals and other modules can react).
export const UI_PREF_KEYS = ['quality', 'renderStyle', 'palette', 'autoRotate', 'audioQuality'];

/**
 * Restore preferences into the store and keep them persisted. Returns an
 * object for the UI-only keys that do not live in the store.
 */
export function createPrefs({ store }) {
  let prefs = loadPrefs();
  const listeners = new Set();
  store.batch(() => {
    for (const key of UI_PREF_KEYS) {
      if (store.get('ui.' + key) !== prefs[key]) store.set('ui.' + key, prefs[key], { source: 'prefs' });
    }
  });

  let timer = 0;
  const persistSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => savePrefs({ ...prefs, theme: store.get('ui.theme') }), 150);
  };
  const offs = UI_PREF_KEYS.map(key => store.subscribe('ui.' + key, () => {
    const v = store.get('ui.' + key);
    if (VALID[key](v)) { prefs[key] = v; persistSoon(); }
  }));
  offs.push(store.subscribe('ui.theme', persistSoon));

  return {
    get: key => prefs[key],
    set(key, value) {
      if (!(key in PREF_DEFAULTS) || !VALID[key](value)) return;
      if (UI_PREF_KEYS.includes(key)) { store.set('ui.' + key, value, { source: 'ui' }); return; }
      prefs[key] = value;
      persistSoon();
      for (const fn of listeners) fn(key, value);
    },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    flush() { clearTimeout(timer); savePrefs({ ...prefs, theme: store.get('ui.theme') }); },
    dispose() { offs.forEach(off => off()); },
  };
}
