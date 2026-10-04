import { describe, it, expect, vi } from 'vitest';
import { lazy, deferredDialog, chunks } from '../../src/ui/lazy.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('lazy chunks (2.11)', () => {
  it('imports once, then runs synchronously', async () => {
    const loader = vi.fn(async () => ({ hello: (x) => `hi ${x}` }));
    const lz = lazy(loader);
    expect(lz.get()).toBe(null);
    const first = lz.run((m) => m.hello('a'));
    expect(first).toBeInstanceOf(Promise);
    expect(await first).toBe('hi a');
    expect(lz.run((m) => m.hello('b'))).toBe('hi b');   // loaded: no promise
    await lz.load();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('retries a failed import and reports it without throwing from run()', async () => {
    let fail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lz = lazy(async () => { if (fail) throw new Error('offline'); return { ok: 1 }; });
    expect(await lz.run((m) => m.ok, 'thing')).toBe(null);
    expect(warn).toHaveBeenCalled();
    fail = false;
    expect(await lz.run((m) => m.ok)).toBe(1);
    warn.mockRestore();
  });

  it('a deferred dialog opens when loaded and keeps the last tab', async () => {
    const real = { open: true, tab: null, isOpen() { return this.open; }, close() { this.open = false; }, select(t) { this.tab = t; } };
    const open = vi.fn(() => real);
    const lz = lazy(async () => ({}));
    const d = deferredDialog(lz, open);
    expect(d.isOpen()).toBe(true);           // counts as open while loading
    d.select('midi');
    await d.ready;
    expect(open).toHaveBeenCalledTimes(1);
    expect(real.tab).toBe('midi');
    d.close();
    expect(d.isOpen()).toBe(false);
    // once loaded, the next open is synchronous and returns the real handle
    expect(deferredDialog(lz, () => real)).toBe(real);
  });

  it('a deferred dialog closed before loading never opens', async () => {
    const open = vi.fn();
    const d = deferredDialog(lazy(async () => ({})), open);
    d.close();
    expect(d.isOpen()).toBe(false);
    expect(await d.ready).toBe(null);
    expect(open).not.toHaveBeenCalled();
  });

  it('every registered chunk resolves to its module', async () => {
    const want = {
      settings: 'openSettings', help: 'openHelp', golf: 'startGolf', terrainLibrary: 'openTerrainLibrary',
      realPlaces: 'openRealPlaces', dataPanel: 'openDataPanel', formula: 'openFormulaTerrain', imprint: 'openImprint', soundMap: 'openSoundMap',
    };
    expect(Object.keys(chunks).sort()).toEqual(Object.keys(want).sort());
    for (const [k, fn] of Object.entries(want)) {
      const m = await chunks[k].load();
      expect(typeof m[fn]).toBe('function');
    }
    await tick();
  });
});
