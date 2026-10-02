import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createAutosave, loadSession, SESSION_KEY, SAVE_DELAY_MS, SAVE_MAX_WAIT_MS } from '../../src/core/session.js';
import { createFakeClock, createMemoryStorage } from '../music/fakes.js';

function setup() {
  const clock = createFakeClock();
  const storage = createMemoryStorage();
  const store = createStore(defaultState());
  const autosave = createAutosave({ store, storage, timers: clock.timers, now: () => clock.perfNow() });
  store.subscribe('global', autosave.schedule);
  store.subscribe('parts', autosave.schedule);
  const savedTempo = () => { const raw = storage.getItem(SESSION_KEY); return raw ? JSON.parse(raw).global.tempo : null; };
  return { clock, storage, store, autosave, savedTempo };
}

describe('session autosave', () => {
  it('saves a short while after a change', () => {
    const { clock, store, savedTempo } = setup();
    store.set('global.tempo', 97, { source: 'test' });
    clock.advance(SAVE_DELAY_MS / 1000 - 0.05);
    expect(savedTempo()).toBe(null);
    clock.advance(0.1);
    expect(savedTempo()).toBe(97);
  });

  it('still saves while a moving dot writes the store every 50 ms (regression: the debounce never fired)', () => {
    const { clock, store, savedTempo } = setup();
    store.set('global.tempo', 101, { source: 'test' });
    let x = 0.3;
    // 3 s of Drift-like dot writes: each one restarts a plain debounce.
    for (let i = 0; i < 60; i++) {
      x = (x + 0.003) % 1;
      store.set('parts.1.params.centerX', x, { source: 'physics', user: false });
      clock.advance(0.05);
    }
    expect(savedTempo()).toBe(101);
  });

  it('never leaves a change unsaved longer than the maximum wait', () => {
    const { clock, store, storage } = setup();
    let saves = 0;
    const set = storage.setItem;
    storage.setItem = (k, v) => { saves++; set(k, v); };
    for (let i = 0; i < 200; i++) {   // 10 s of continuous changes
      store.set('parts.0.params.centerX', (i % 100) / 100 + 0.001, { source: 'physics', user: false });
      clock.advance(0.05);
    }
    expect(saves).toBeGreaterThanOrEqual(Math.floor(10000 / SAVE_MAX_WAIT_MS) - 1);
    expect(saves).toBeLessThanOrEqual(Math.ceil(10000 / SAVE_MAX_WAIT_MS) + 1);
  });

  it('flush() saves a change at once (page hide or reload) and does nothing when clean', () => {
    const { store, autosave, savedTempo, storage } = setup();
    expect(autosave.flush()).toBe(false);
    store.set('global.tempo', 133, { source: 'test' });
    expect(autosave.pending()).toBe(true);
    expect(autosave.flush()).toBe(true);
    expect(savedTempo()).toBe(133);
    expect(autosave.pending()).toBe(false);
    expect(loadSession(storage).global.tempo).toBe(133);
  });

  it('survives storage that throws, and a corrupt saved session', () => {
    const store = createStore(defaultState());
    const bad = { getItem: () => '{not json', setItem: () => { throw new Error('quota'); } };
    const a = createAutosave({ store, storage: bad, timers: createFakeClock().timers });
    a.schedule();
    expect(a.flush()).toBe(false);
    const warn = console.warn;
    console.warn = () => {};
    try { expect(loadSession(bad)).toBe(null); } finally { console.warn = warn; }
  });
});
