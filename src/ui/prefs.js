// Per-device preferences (not part of a song or patch): visual quality, map
// render style, palette, auto-rotate, motion and tips. Persisted under
// localStorage['orograph.settings'] and restored into store.ui at startup.
// The theme preference is stored separately by theme.js (its own key is part
// of the cross-module theme contract) but is mirrored here as well.

import { CAMERA_VIEWS, sanitizeSavedCameraViews, sanitizeCameraView } from '../visual/camera-view.js';

export const SETTINGS_KEY = 'orograph.settings';

export const PREF_DEFAULTS = Object.freeze({
  theme: 'system',
  quality: 'high',
  fpsCap: 0,
  renderScale: 'auto', // 3D map resolution: 'auto' or 'full' (v2.11)
  renderStyle: 'relief',
  view: 'orbit',
  savedCameraViews: [],
  palette: 0,
  autoRotate: 1,
  reduceMotion: 'system', // 'system' | 'on' | 'off'
  showTips: 1,
  keysOpen: 1,
  mapCollapsed: 0,
  audioQuality: 'standard',
  lastTrack: '',      // id of the track that was selected (v2.1)
  lastCamera: null,   // the camera when the app was last closed (v2.1)
  dayNight: 0,        // tint the map by the local hour (v2.9)
  pet: 0,             // the pet on the map (v2.9)
  smartOpen: 1,       // the Smart controls card in the Sound tab is open (2.11)
  listenMode: 'normal', // what you hear: normal, headphones, mono, small, swap (2.12, never in exports)
  liveSurround: 'off',  // play 3D tracks on surround speakers: 'off', '5.1', '7.1' (2.12)
  wavFormat: 'pcm24',   // Bounce and Record: 'pcm24' or 'float32' (2.17)
  touchMode: 'move',    // what a click or drag on the map does: 'move', 'strum', 'fx' (2.17)
  visualizer: 'map',    // what the viewport shows: the 3D map or a visualizer (2.17.1)
});

const VALID = {
  theme: v => ['system', 'dark', 'light'].includes(v),
  quality: v => ['high', 'medium', 'low'].includes(v),
  fpsCap: v => [0, 30, 60, 120].includes(v),
  renderScale: v => ['auto', 'full'].includes(v),
  renderStyle: v => ['relief', 'wire', 'contour', 'heat', 'points', 'normals'].includes(v),
  view: v => CAMERA_VIEWS.includes(v),
  savedCameraViews: v => Array.isArray(v),
  palette: v => Number.isInteger(v) && v >= 0 && v < 24,
  autoRotate: v => v === 0 || v === 1,
  reduceMotion: v => ['system', 'on', 'off'].includes(v),
  showTips: v => v === 0 || v === 1,
  keysOpen: v => v === 0 || v === 1,
  mapCollapsed: v => v === 0 || v === 1,
  audioQuality: v => ['eco', 'standard', 'high', 'pristine', 'raw'].includes(v),
  lastTrack: v => typeof v === 'string' && v.length <= 64,
  lastCamera: v => v === null || !!sanitizeCameraView(v),
  dayNight: v => v === 0 || v === 1,
  pet: v => v === 0 || v === 1,
  smartOpen: v => v === 0 || v === 1,
  listenMode: v => ['normal', 'headphones', 'mono', 'small', 'swap'].includes(v),
  liveSurround: v => ['off', '5.1', '7.1'].includes(v),
  wavFormat: v => ['pcm24', 'float32'].includes(v),
  touchMode: v => ['move', 'strum', 'fx'].includes(v),
  visualizer: v => ['map', 'scope', 'spectrum', 'waterfall', 'vector', 'halo'].includes(v),
};

/** Keep only known keys with valid values; fill the rest from defaults. */
export function sanitizePrefs(src) {
  const out = { ...PREF_DEFAULTS };
  if (!src || typeof src !== 'object') return out;
  for (const key of Object.keys(PREF_DEFAULTS)) {
    let v = key === 'savedCameraViews' ? sanitizeSavedCameraViews(src[key]) : key === 'lastCamera' ? sanitizeCameraView(src[key]) : src[key];
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
export const UI_PREF_KEYS = ['view', 'quality', 'fpsCap', 'renderScale', 'renderStyle', 'palette', 'autoRotate', 'audioQuality', 'listenMode', 'liveSurround', 'touchMode', 'visualizer'];

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
      prefs[key] = key === 'savedCameraViews' ? sanitizeSavedCameraViews(value) : key === 'lastCamera' ? sanitizeCameraView(value) : value;
      persistSoon();
      for (const fn of listeners) fn(key, value);
    },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    flush() { clearTimeout(timer); savePrefs({ ...prefs, theme: store.get('ui.theme') }); },
    dispose() { offs.forEach(off => off()); },
  };
}
