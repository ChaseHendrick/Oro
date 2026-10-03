// 2.11 polish: the bounce dialog's weather note and the remembered Smart controls card.
import { describe, it, expect } from 'vitest';
import { usesWeatherLinks } from '../../src/ui/bounce.js';
import { sanitizePrefs, PREF_DEFAULTS } from '../../src/ui/prefs.js';
import { createStore } from '../../src/core/store.js';
import { defaultState, LINK_SOURCES } from '../../src/core/params.js';

describe('bounce weather note', () => {
  it('shows only when a track links from a weather source', () => {
    const store = createStore(defaultState());
    expect(usesWeatherLinks(store)).toBe(false);
    store.set('parts.1.links', [{ src: LINK_SOURCES.indexOf('Weather Rain'), dst: 'morph', amt: 0, curve: 0 }]);
    expect(usesWeatherLinks(store)).toBe(false);          // amount 0 does nothing
    store.set('parts.1.links', [{ src: LINK_SOURCES.indexOf('Weather Rain'), dst: 'morph', amt: 0.5, curve: 0 }]);
    expect(usesWeatherLinks(store)).toBe(true);
    store.set('parts.1.links', [{ src: LINK_SOURCES.indexOf('Lorenz'), dst: 'morph', amt: 0.5, curve: 0 }]);
    expect(usesWeatherLinks(store)).toBe(false);
  });
});

describe('Smart controls card preference', () => {
  it('defaults to open and keeps only 0 or 1', () => {
    expect(PREF_DEFAULTS.smartOpen).toBe(1);
    expect(sanitizePrefs({ smartOpen: 0 }).smartOpen).toBe(0);
    expect(sanitizePrefs({ smartOpen: false }).smartOpen).toBe(0);
    expect(sanitizePrefs({ smartOpen: 'no' }).smartOpen).toBe(1);
  });
});

describe('on-screen keyboard width (2.11)', () => {
  it('keeps 1 to 3 octaves up to laptop widths and adds octaves on wide screens', async () => {
    const { octavesFor, keyboardStart } = await import('../../src/ui/piano.js');
    expect([300, 600, 900, 1200, 1350].map(octavesFor)).toEqual([1, 2, 3, 3, 3]);
    expect(octavesFor(1400)).toBe(4);
    expect(octavesFor(2400)).toBe(7);
    expect(octavesFor(9000)).toBe(7);
    // the old ranges are unchanged
    expect(keyboardStart(4, 3)).toBe(3);
    expect(keyboardStart(4, 2)).toBe(4);
    expect(keyboardStart(7, 3)).toBe(6);
    // wider ranges keep the computer keyboard's octave near the middle and stay inside MIDI
    expect(keyboardStart(4, 5)).toBe(2);
    for (let oct = 1; oct <= 7; oct++) for (let span = 1; span <= 7; span++) {
      const lo = 12 * (keyboardStart(oct, span) + 1);
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(lo + 12 * span).toBeLessThanOrEqual(128);
    }
  });
});
