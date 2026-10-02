import { describe, it, expect, beforeEach } from 'vitest';
import { resolveTheme, nextPref, normalizePref, readStoredPref, writeStoredPref, THEME_KEY } from '../../src/ui/theme.js';
import { sanitizePrefs, loadPrefs, savePrefs, createPrefs, PREF_DEFAULTS, SETTINGS_KEY } from '../../src/ui/prefs.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';

function fakeStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), _m: m };
}

describe('theme', () => {
  it('resolves preferences against the OS setting', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('nonsense', true)).toBe('dark');
  });
  it('cycles System -> Dark -> Light -> System', () => {
    expect(nextPref('system')).toBe('dark');
    expect(nextPref('dark')).toBe('light');
    expect(nextPref('light')).toBe('system');
    expect(normalizePref(undefined)).toBe('system');
  });
  it('persists the preference and survives broken storage', () => {
    const st = fakeStorage();
    writeStoredPref('light', st);
    expect(st.getItem(THEME_KEY)).toBe('light');
    expect(readStoredPref(st)).toBe('light');
    const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    expect(readStoredPref(broken)).toBe('system');
    expect(() => writeStoredPref('dark', broken)).not.toThrow();
  });
});

describe('device preferences', () => {
  let storage;
  beforeEach(() => { storage = fakeStorage(); globalThis.localStorage = storage; });

  it('keeps only known keys with valid values', () => {
    const p = sanitizePrefs({ quality: 'ultra', renderStyle: 'wire', palette: 2, autoRotate: true, bogus: 1, showTips: 0 });
    expect(p.quality).toBe(PREF_DEFAULTS.quality);
    expect(p.renderStyle).toBe('wire');
    expect(p.palette).toBe(2);
    expect(p.autoRotate).toBe(1);
    expect(p.showTips).toBe(0);
    expect(p.bogus).toBeUndefined();
    expect(sanitizePrefs(null)).toEqual({ ...PREF_DEFAULTS });
  });

  it('round-trips through storage and ignores corrupt JSON', () => {
    savePrefs({ quality: 'low', renderStyle: 'heat' }, storage);
    expect(loadPrefs(storage).quality).toBe('low');
    storage.setItem(SETTINGS_KEY, '{not json');
    expect(loadPrefs(storage)).toEqual({ ...PREF_DEFAULTS });
  });

  it('restores saved settings into store.ui and persists changes', () => {
    savePrefs({ quality: 'medium', renderStyle: 'contour', palette: 1, autoRotate: 0 }, storage);
    const store = createStore(defaultState());
    const prefs = createPrefs({ store });
    expect(store.get('ui.quality')).toBe('medium');
    expect(store.get('ui.renderStyle')).toBe('contour');
    expect(store.get('ui.palette')).toBe(1);
    expect(store.get('ui.autoRotate')).toBe(0);
    store.set('ui.quality', 'low');
    prefs.set('showTips', 0);
    prefs.flush();
    const saved = JSON.parse(storage.getItem(SETTINGS_KEY));
    expect(saved.quality).toBe('low');
    expect(saved.showTips).toBe(0);
    prefs.dispose();
  });
});
