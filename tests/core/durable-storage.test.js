import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';

function storage(limit = Infinity) {
  const data = new Map();
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, raw) => { if (raw.length > limit) throw new Error('quota'); data.set(key, raw); }, removeItem: key => data.delete(key) };
}
function indexedDBFake() {
  const data = new Map(), state = { failedOpens: 0, blockedOpens: 0, failedTransactions: 0, abortedWrites: 0, opens: 0 };
  const db = {
    objectStoreNames: { contains: () => true }, close() { db.onclose?.(); },
    transaction() {
      if (state.failedTransactions-- > 0) throw new Error('database closed');
      const transaction = {};
      transaction.objectStore = () => ({
        get(key) { const request = {}; queueMicrotask(() => { request.result = data.get(key); request.onsuccess?.(); }); return request; },
        put(raw, key) { queueMicrotask(() => { if (state.abortedWrites-- > 0) transaction.onabort?.(); else { data.set(key, raw); transaction.oncomplete?.(); } }); },
        delete(key) { queueMicrotask(() => { data.delete(key); transaction.oncomplete?.(); }); },
      });
      return transaction;
    },
  };
  const api = { open() { state.opens++; const request = {}; queueMicrotask(() => { if (state.failedOpens-- > 0) request.onerror?.(); else if (state.blockedOpens-- > 0) request.onblocked?.(); else { request.result = db; request.onsuccess?.(); } }); return request; } };
  return { api, db, data, state };
}
beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('durable storage order and failures', () => {
  it('commits large data before publishing its locator and supports an immediate same-page read', async () => {
    const fake = indexedDBFake(); vi.stubGlobal('indexedDB', fake.api);
    const { writeDurable, readDurable, LARGE_STORAGE_MARKER } = await import('../../src/core/durable-storage.js');
    const local = storage(50); local.setItem('document', 'old');
    const save = writeDurable('document', 'x'.repeat(200), local);
    expect(save.immediate).toBe(false); expect(local.getItem('document')).toBe('old');
    expect(await readDurable('document', local)).toBe('x'.repeat(200));
    expect(await save.done).toBe(true); expect(local.getItem('document')).toBe(LARGE_STORAGE_MARKER);
  });
  it('a small replacement wins over an older pending large write and removes its stale database copy', async () => {
    const fake = indexedDBFake(); vi.stubGlobal('indexedDB', fake.api);
    const { writeDurable, readDurable } = await import('../../src/core/durable-storage.js'), local = storage(50);
    const old = writeDurable('document', 'x'.repeat(200), local), latest = writeDurable('document', 'new', local);
    expect(latest.immediate).toBe(true); expect(await latest.done).toBe(true); expect(await old.done).toBe(true);
    expect(await readDurable('document', local)).toBe('new'); expect(fake.data.has('document')).toBe(false);
    local.removeItem('document'); expect(await readDurable('document', local)).toBe(null);
  });
  it.each(['failedOpens', 'blockedOpens'])('retries %s instead of caching a permanent null database', async (failure) => {
    const fake = indexedDBFake(); fake.state[failure] = 1; vi.stubGlobal('indexedDB', fake.api);
    const { writeDurable, readDurable } = await import('../../src/core/durable-storage.js'), local = storage(20);
    expect(await writeDurable('document', 'x'.repeat(100), local).done).toBe(false);
    expect(await writeDurable('document', 'y'.repeat(100), local).done).toBe(true);
    expect(await readDurable('document', local)).toBe('y'.repeat(100)); expect(fake.state.opens).toBe(2);
  });
  it('handles a closed database or aborted transaction without rejecting app startup or save promises', async () => {
    const fake = indexedDBFake(); vi.stubGlobal('indexedDB', fake.api);
    const { writeDurable, readDurable } = await import('../../src/core/durable-storage.js'), local = storage(20);
    await writeDurable('document', 'x'.repeat(100), local).done;
    fake.state.failedTransactions = 1; expect(await readDurable('document', local)).toBe(null);
    expect(await readDurable('document', local)).toBe('x'.repeat(100));
    fake.state.abortedWrites = 1; expect(await writeDurable('document', 'y'.repeat(100), local).done).toBe(false);
    expect(await writeDurable('document', 'z'.repeat(100), local).done).toBe(true);
  });
  it('does not report success when an immutable stale local entry hides its database locator', async () => {
    const fake = indexedDBFake(); vi.stubGlobal('indexedDB', fake.api);
    const { writeDurable } = await import('../../src/core/durable-storage.js');
    const local = { getItem: () => 'old', setItem() { throw new Error('read-only'); }, removeItem() { throw new Error('read-only'); } };
    expect(await writeDurable('document', 'new', local).done).toBe(false);
    expect(fake.data.get('document')).toBe('new');
  });
  it('reopens after a version-change close', async () => {
    const fake = indexedDBFake(); vi.stubGlobal('indexedDB', fake.api);
    const { writeDurable, readDurable } = await import('../../src/core/durable-storage.js');
    await writeDurable('document', 'stored', null).done; fake.db.onversionchange();
    expect(await readDurable('document', null)).toBe('stored'); expect(fake.state.opens).toBe(2);
  });
  it('keeps failed autosaves dirty for a later explicit retry', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const { createAutosave } = await import('../../src/core/session.js');
    const store = createStore(defaultState()), local = storage(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setItem = local.setItem; local.setItem = () => { throw new Error('quota'); };
    const autosave = createAutosave({ store, storage: local }); autosave.schedule(); expect(autosave.flush()).toBe(false);
    expect(await autosave.settled()).toBe(false); expect(autosave.pending()).toBe(true);
    local.setItem = setItem; expect(autosave.flush()).toBe(true); expect(await autosave.settled()).toBe(true); expect(autosave.pending()).toBe(false);
    autosave.dispose(); warn.mockRestore();
  });
  it('merges edits made before an asynchronous library load and saves them after hydration', async () => {
    const fake = indexedDBFake(); vi.stubGlobal('indexedDB', fake.api);
    const { createPresets, STORAGE_KEY } = await import('../../src/presets/presets.js');
    const { LARGE_STORAGE_MARKER } = await import('../../src/core/durable-storage.js');
    fake.data.set(STORAGE_KEY, JSON.stringify({ patches: [{ id: 'saved-patch', name: 'Stored patch', params: { cutoff: 500 } }], scenes: [], favorites: ['saved-patch'] }));
    const local = storage(50); local.setItem(STORAGE_KEY, LARGE_STORAGE_MARKER);
    const store = createStore(defaultState()), presets = createPresets({ store, storage: local });
    const id = presets.savePatch(0, 'Early patch'); presets.setFavorite(3, id);
    await presets.ready; expect(presets.getPatch(id).name).toBe('Early patch'); expect(presets.getPatch('saved-patch').name).toBe('Stored patch');
    expect(presets.programPatch(0).id).toBe('saved-patch'); expect(presets.programPatch(3).id).toBe(id);
    expect(await presets.settled()).toBe(true);
    const reload = createPresets({ store: createStore(defaultState()), storage: local }); await reload.ready;
    expect(reload.getPatch(id).name).toBe('Early patch'); expect(reload.getPatch('saved-patch').name).toBe('Stored patch');
    expect(reload.programPatch(3).id).toBe(id);
  });
});
