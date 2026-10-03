import { describe, it, expect } from 'vitest';
import { createPresets, STORAGE_KEY, FORMAT } from '../../src/presets/presets.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createMemoryStorage } from '../music/fakes.js';
function library(storage = createMemoryStorage()) { return createPresets({ store: createStore(defaultState()), storage }); }
describe('favorite bank persistence and program change', () => {
  it('clears every favorite reference when deleting a patch by name', async () => {
    const presets = library(); await presets.ready;
    const id = presets.savePatch(0, 'Remove by name');
    presets.setFavorite(0, id); presets.setFavorite(35, id);
    expect(presets.deleteUser('patch', 'Remove by name')).toBe(true);
    expect(presets.favorites().every(favorite => favorite === null)).toBe(true);
    expect(presets.programPatch(0).factory).toBe(true);
  });
  it('returns to factory program order after its last favorited user patch is deleted', async () => {
    const presets = library(); await presets.ready;
    const factory = presets.programPatch(0), id = presets.savePatch(0, 'Temporary patch'); presets.setFavorite(7, id);
    expect(presets.programPatch(7).id).toBe(id); presets.deleteUser('patch', id);
    expect(presets.favorites().every(favorite => favorite === null)).toBe(true); expect(presets.programPatch(0).id).toBe(factory.id);
  });
  it('round-trips a bank of factory favorites even with no user patches or scenes', async () => {
    const original = library(); await original.ready;
    const id = original.patches()[4].id; original.setFavorite(10, id);
    const file = await original.exportJSON('all').text(), restored = library(); await restored.ready;
    expect(await restored.importJSON(file)).toEqual({ patches: 0, scenes: 0 }); expect(restored.programPatch(10).id).toBe(id); expect(restored.programPatch(0)).toBe(null);
  });
  it('clears stale saved favorite IDs and persists valid slots through reload', async () => {
    const storage = createMemoryStorage(); storage.setItem(STORAGE_KEY, JSON.stringify({ format: FORMAT, patches: [], scenes: [], favorites: ['missing-id'] }));
    const presets = library(storage); await presets.ready; expect(presets.programPatch(0)?.factory).toBe(true);
    const id = presets.patches()[3].id; presets.setFavorite(35, id); await presets.settled();
    const reload = library(storage); await reload.ready; expect(reload.favorites()[35].id).toBe(id); expect(reload.programPatch(35).id).toBe(id);
  });
  it('imports user favorite references against new IDs and rejects invalid files without changing the bank', async () => {
    const presets = library(); await presets.ready;
    const id = presets.savePatch(0, 'My favorite'); presets.setFavorite(2, id);
    const file = await presets.exportJSON('all').text(), restored = library(); await restored.ready; await restored.importJSON(file);
    expect(restored.programPatch(2).name).toBe('My favorite'); expect(restored.programPatch(2).id).not.toBe(id);
    const before = restored.favorites().map(patch => patch?.id || null);
    await expect(restored.importJSON(JSON.stringify({ favorites: [] }))).rejects.toThrow('No Orograph');
    expect(restored.favorites().map(patch => patch?.id || null)).toEqual(before);
    expect(restored.setFavorite(0, { name: 'Injected', params: {} })).toBe(false); expect(restored.programPatch(-1)).toBe(null);
  });
});
