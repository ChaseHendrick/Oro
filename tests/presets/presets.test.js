import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState, defaultPart, PART_PARAM_MAP, MOD_PARAM_IDS, NUM_PARTS } from '../../src/core/params.js';
import { migrateState, sanitizePart } from '../../src/core/migrate.js';
import { createPresets, STORAGE_KEY } from '../../src/presets/presets.js';
import { FACTORY_PATCHES, CATEGORIES } from '../../src/presets/factory-patches.js';
import { FACTORY_SCENES, parsePattern } from '../../src/presets/factory-scenes.js';
import { partWithPatch } from '../../src/presets/apply.js';
import { randomPatch } from '../../src/presets/random-patch.js';
import { makeRng } from '../../src/music/patterns.js';
import { createMemoryStorage } from '../music/fakes.js';

const stripMeta = ({ name, description, ...state }) => state;

describe('factory patches', () => {
  it('has at least 40 patches across every category', () => {
    expect(FACTORY_PATCHES.length).toBeGreaterThanOrEqual(40);
    for (const c of CATEGORIES) expect(FACTORY_PATCHES.filter(p => p.category === c).length).toBeGreaterThanOrEqual(3);
    expect(new Set(FACTORY_PATCHES.map(p => p.name)).size).toBe(FACTORY_PATCHES.length);
  });

  it('only uses known parameters with values that survive migration unchanged', () => {
    for (const patch of FACTORY_PATCHES) {
      for (const id of Object.keys(patch.params)) expect(PART_PARAM_MAP[id], `${patch.name}: ${id}`).toBeTruthy();
      for (const id of Object.keys(patch.mods || {})) expect(MOD_PARAM_IDS, `${patch.name}: mod ${id}`).toContain(id);
      const part = partWithPatch(defaultPart(0), patch);
      expect(sanitizePart(part, 0), patch.name).toEqual(part);
    }
  });

  it('gives every patch modulation and a distinctive terrain and orbit', () => {
    const combos = new Set();
    for (const p of FACTORY_PATCHES) {
      expect(Object.keys(p.mods || {}).length, p.name).toBeGreaterThan(0);
      const key = [p.params.terrainA, p.params.terrainB, p.params.pathShape, p.params.pathOrder ?? 2].join('/');
      expect(combos.has(key), `${p.name} repeats ${key}`).toBe(false);
      combos.add(key);
    }
  });

  it('never uses em dashes in names or tags', () => {
    expect(JSON.stringify(FACTORY_PATCHES)).not.toMatch(/\u2014/);
  });
});

describe('factory scenes', () => {
  it('has at least six four-part songs that survive migration unchanged', () => {
    expect(FACTORY_SCENES.length).toBeGreaterThanOrEqual(6);
    for (const scene of FACTORY_SCENES) {
      expect(migrateState(scene), scene.name).toEqual(stripMeta(scene));
      expect(scene.parts).toHaveLength(NUM_PARTS);
      for (const part of scene.parts) {
        expect(part.seq.enabled, `${scene.name}/${part.name}`).toBe(1);
        expect(part.seq.steps.slice(0, part.seq.length).some(s => s.on), `${scene.name}/${part.name}`).toBe(true);
      }
      expect(scene.description.length).toBeGreaterThan(20);
    }
    expect(new Set(FACTORY_SCENES.map(s => s.global.tempo)).size).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(FACTORY_SCENES.map(s => [s.name, s.description]))).not.toMatch(/\u2014/);
  });

  it('opens with an inviting A minor groove', () => {
    const s = FACTORY_SCENES[0];
    expect(s.global.scaleRoot).toBe(9);
    expect(s.global.scaleType).toBe(1);
    expect(s.global.tempo).toBeGreaterThanOrEqual(100);
    expect(s.global.tempo).toBeLessThanOrEqual(112);
    expect(s.parts[0].patchName).toMatch(/Bass/);
  });

  it('parses the step notation', () => {
    const { steps, length } = parsePattern('0! . 4~ 2\' -1, 3> 5< 7*', { gate: 0.4 });
    expect(length).toBe(8);
    expect(steps[0]).toMatchObject({ on: 1, degree: 0, accent: 1, gate: 0.4 });
    expect(steps[1].on).toBe(0);
    expect(steps[2]).toMatchObject({ degree: 4, slide: 1 });
    expect(steps[3]).toMatchObject({ degree: 2, octave: 1 });
    expect(steps[4]).toMatchObject({ degree: -1, octave: -1 });
    expect(steps[5].gate).toBe(0.95);
    expect(steps[6].gate).toBe(0.2);
    expect(steps[7].vel).toBe(0.55);
    expect(() => parsePattern('x')).toThrow();
  });
});

function setup(storage = createMemoryStorage()) {
  const store = createStore(defaultState());
  const presets = createPresets({ store, storage, random: makeRng(11) });
  return { store, presets, storage };
}

describe('presets API', () => {
  it('lists patches and categories', () => {
    const { presets } = setup();
    const list = presets.patches();
    expect(list.length).toBe(FACTORY_PATCHES.length);
    expect(list[0]).toMatchObject({ id: 'f-basalt-bass', name: 'Basalt Bass', category: 'Bass', factory: true });
    expect(presets.categories()).toEqual(CATEGORIES);
  });

  it('loads a patch but keeps the part\'s sequence, arp, name, colour and mute', () => {
    const { store, presets } = setup();
    const seq = store.get('parts.1.seq');
    seq.steps[3].on = 1;
    store.set('parts.1.seq', seq);
    store.set('parts.1.name', 'Lead line');
    store.set('parts.1.params.mute', 1);
    store.set('parts.1.arp.mode', 2);
    const events = [];
    presets.on('change', e => events.push(e));
    expect(presets.loadPatch(1, 'f-cirque-bell')).toBe(true);
    const part = store.get('parts.1');
    expect(part.patchName).toBe('Cirque Bell');
    expect(part.params.pathShape).toBe(FACTORY_PATCHES.find(p => p.name === 'Cirque Bell').params.pathShape);
    expect(part.seq.steps[3].on).toBe(1);
    expect(part.arp.mode).toBe(2);
    expect(part.name).toBe('Lead line');
    expect(part.params.mute).toBe(1);
    expect(events[0]).toMatchObject({ kind: 'patch', action: 'load', part: 1 });
    expect(presets.loadPatch(1, 'nope')).toBe(false);
  });

  it('steps through patches with wrap-around', () => {
    const { store, presets } = setup();
    presets.loadPatch(0, 'f-basalt-bass');
    presets.nextPatch(0, 1);
    expect(store.get('parts.0.patchName')).toBe(FACTORY_PATCHES[1].name);
    presets.nextPatch(0, -1);
    presets.nextPatch(0, -1);
    expect(store.get('parts.0.patchName')).toBe(FACTORY_PATCHES.at(-1).name);
  });

  it('saves, reloads, overwrites and deletes user patches', () => {
    const { store, presets, storage } = setup();
    presets.loadPatch(2, 'f-tidal-flats');
    store.set('parts.2.params.cutoff', 1234);
    const id = presets.savePatch(2, 'My Flats');
    expect(store.get('parts.2.patchName')).toBe('My Flats');
    const saved = presets.patches().find(p => p.id === id);
    expect(saved).toMatchObject({ name: 'My Flats', category: 'Pad', factory: false });
    // Reload from storage in a fresh instance.
    const again = createPresets({ store: createStore(defaultState()), storage });
    expect(again.patches().some(p => p.id === id)).toBe(true);
    again.loadPatch(0, id);
    expect(again.patches().find(p => p.id === id).name).toBe('My Flats');
    // Same name again updates in place.
    store.set('parts.2.params.cutoff', 2000);
    expect(presets.savePatch(2, 'My Flats')).toBe(id);
    expect(presets.getPatch(id).params.cutoff).toBe(2000);
    // A factory name is not overwritten.
    const other = presets.savePatch(2, 'Basalt Bass');
    expect(presets.patches().find(p => p.id === other).name).toBe('Basalt Bass 2');
    // A custom category survives a reload and shows up in categories().
    const custom = presets.savePatch(2, 'Field Notes', { category: 'Sketches' });
    const reloaded = createPresets({ store: createStore(defaultState()), storage });
    expect(reloaded.patches().find(p => p.id === custom).category).toBe('Sketches');
    expect(reloaded.categories()).toContain('Sketches');
    presets.deleteUser('patch', custom);
    expect(presets.deleteUser('patch', id)).toBe(true);
    expect(presets.patches().some(p => p.id === id)).toBe(false);
    expect(JSON.parse(storage.getItem(STORAGE_KEY)).patches).toHaveLength(1);
  });

  it('initialises and randomises parts with valid values', () => {
    const { store, presets } = setup();
    presets.loadPatch(0, 'f-fault-line');
    presets.initPatch(0);
    expect(store.get('parts.0.patchName')).toBe('Init');
    expect(store.get('parts.0.params')).toEqual(defaultPart(0).params);
    for (let seed = 1; seed <= 150; seed++) {
      const patch = randomPatch(makeRng(seed));
      const part = partWithPatch(defaultPart(0), patch);
      expect(sanitizePart(part, 0)).toEqual(part);
      expect(CATEGORIES).toContain(patch.category);
    }
    const p = presets.randomizePatch(3);
    expect(store.get('parts.3.patchName')).toBe(p.name);
  });

  it('lists and loads scenes, and saves your own', () => {
    const { store, presets } = setup();
    const list = presets.scenes();
    expect(list[0]).toMatchObject({ id: 'f-first-light', name: 'First Light', factory: true, tempo: 104, key: 'A Minor' });
    store.set('ui.selectedPart', 2);
    expect(presets.loadScene(0)).toBe(true);
    expect(store.get('global.tempo')).toBe(104);
    expect(store.get('parts.0.patchName')).toBe('Basalt Bass');
    expect(store.get('ui.selectedPart')).toBe(2);
    presets.loadScene('f-neon-coastline');
    expect(store.get('global.scaleRoot')).toBe(4);
    store.set('global.tempo', 99);
    const id = presets.saveScene('Night Drive', { description: 'mine' });
    presets.loadScene(0);
    presets.loadScene(id);
    expect(store.get('global.tempo')).toBe(99);
    expect(presets.scenes().find(s => s.id === id)).toMatchObject({ name: 'Night Drive', factory: false, description: 'mine' });
    expect(presets.loadScene(999)).toBe(false);
  });

  it('exports and imports JSON, rejecting junk', async () => {
    const a = setup();
    a.presets.loadPatch(0, 'f-pebble-pluck');
    a.presets.savePatch(0, 'Pebbles');
    a.presets.saveScene('Whole thing');
    const blob = a.presets.exportJSON('all');
    expect(blob.type).toBe('application/json');
    const b = setup();
    const res = await b.presets.importJSON(await blob.text());
    expect(res).toEqual({ patches: 1, scenes: 1 });
    expect(b.presets.patches().some(p => p.name === 'Pebbles')).toBe(true);
    // Importing again keeps both, with a new name.
    await b.presets.importJSON(await blob.text());
    expect(b.presets.patches().filter(p => p.name.startsWith('Pebbles')).map(p => p.name)).toEqual(['Pebbles', 'Pebbles 2']);
    // A single factory patch export, then a File-like object.
    const one = a.presets.exportJSON('patch', 'f-cirque-bell');
    const file = { text: () => one.text() };
    expect(await b.presets.importJSON(file)).toEqual({ patches: 1, scenes: 0 });
    // Out-of-range values are clamped on the way in.
    await b.presets.importJSON(JSON.stringify({ name: 'Wild', params: { cutoff: 1e9, bogus: 3 }, mods: { morph: { lfoDepth: 7 } } }));
    const wild = b.presets.getPatch(b.presets.patches().find(p => p.name === 'Wild').id);
    expect(wild.params).toEqual({ cutoff: 18000 });
    expect(wild.mods.morph.lfoDepth).toBe(1);
    await expect(b.presets.importJSON('not json')).rejects.toThrow(/JSON/);
    await expect(b.presets.importJSON('{"hello": 1}')).rejects.toThrow(/No Orograph/);
  });

  it('survives broken or missing storage', () => {
    const storage = createMemoryStorage();
    storage.setItem(STORAGE_KEY, '{oops');
    const { presets } = setup(storage);
    expect(presets.patches().length).toBe(FACTORY_PATCHES.length);
    const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    const c = createPresets({ store: createStore(defaultState()), storage: blocked });
    expect(c.savePatch(0, 'x')).toBeTruthy();
    const d = createPresets({ store: createStore(defaultState()), storage: null });
    expect(d.scenes().length).toBe(FACTORY_SCENES.length);
  });
});
