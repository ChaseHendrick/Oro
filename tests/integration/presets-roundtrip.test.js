// Cross-module contracts between the parameter registry, the migration, the
// store, the preset library and MIDI program change. Each test follows data
// through more than one module, the way the running app does:
//
//   main.js autosave   store.serialize -> JSON -> migrateState -> createStore
//   patch library      store -> savePatch -> storage -> createPresets -> loadPatch
//   sharing            exportJSON -> importJSON (another browser) -> load
//   factory content    factory scenes are built from factory patches by name
//   MIDI               program change n loads presets.patches()[n]

import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import {
  PART_PARAMS, GLOBAL_PARAMS, MOD_PARAM_IDS, LFO_SHAPES, toNorm, fromNorm, defaultState,
} from '../../src/core/params.js';
import { migrateState, sanitizePart } from '../../src/core/migrate.js';
import { createPresets, STORAGE_KEY } from '../../src/presets/presets.js';
import { FACTORY_PATCHES } from '../../src/presets/factory-patches.js';
import { FACTORY_SCENES } from '../../src/presets/factory-scenes.js';
import { partWithPatch } from '../../src/presets/apply.js';
import { createMidi } from '../../src/midi/midi.js';
import { createMusic } from '../../src/music/music.js';
import { createMemoryStorage, createFakeClock, createFakeEngine } from '../music/fakes.js';
import { fakeInput, fakeAccess, fakeNavigator } from '../midi/fake-midi.js';

const json = (v) => JSON.parse(JSON.stringify(v));
const stripMeta = ({ name, description, id, factory, ...state }) => state;
// What makes a part sound the way it does (everything a patch carries).
const sound = (part) => {
  const { mute, solo, ...params } = part.params;
  return json({ params, mods: part.mods, dot: part.dot, links: part.links, userTerrain: part.userTerrain });
};
// Mixer settings a scene may set on top of the patch it names.
const MIX_IDS = new Set(['level', 'pan', 'delaySend', 'reverbSend', 'mute', 'solo']);

/** The autosave path in src/main.js, start to finish. */
function autosaveRoundTrip(store) {
  const saved = JSON.stringify(store.serialize());
  return createStore(migrateState(JSON.parse(saved)));
}

describe('session persistence (store x migrate x params)', () => {
  it('every factory scene is a fixed point of the autosave round trip', () => {
    for (const scene of FACTORY_SCENES) {
      const store = createStore(migrateState(stripMeta(scene)));
      const once = autosaveRoundTrip(store);
      const twice = autosaveRoundTrip(once);
      expect(once.serialize(), scene.name).toEqual(store.serialize());
      expect(twice.serialize(), scene.name).toEqual(store.serialize());
    }
  });

  it('keeps user terrains, links, Steps LFOs, waypoints and dot locks across the round trip', () => {
    const store = createStore(migrateState(stripMeta(FACTORY_SCENES[1])));
    const ut = { name: 'ridges', kind: 'image', w: 4, h: 4, mirror: 1, data: Buffer.from(new Uint8Array(16).fill(7)).toString('base64') };
    store.batch(() => {
      store.set('parts.2.userTerrain.A', ut);
      store.set('parts.2.links', [{ src: 1, dst: 'morph', amt: 1, curve: 0 }, { src: 5, dst: 'warp', amt: -0.4, curve: 2 }]);
      store.set('parts.2.mods.size', { ...store.get('parts.2.mods.size'), lfoShape: LFO_SHAPES.indexOf('Steps'), lfoDepth: 0.5, steps: Array.from({ length: 16 }, (_, i) => (i % 2 ? -0.5 : 0.25)) });
      store.set('parts.2.dot.waypoints', [{ x: 0.1, y: 0.2, beats: 2 }, { x: 0.8, y: 0.6, beats: 4 }]);
      store.set('parts.2.dot.mode', 4);
      store.set('parts.2.patterns.0.steps.3', { ...store.get('parts.2.patterns.0.steps.3'), lock: 1, lx: 0.25, ly: 0.75 });
    });
    const back = autosaveRoundTrip(store);
    expect(back.get('parts.2.userTerrain.A')).toEqual(ut);
    expect(back.get('parts.2.links')).toEqual(store.get('parts.2.links'));
    expect(back.get('parts.2.mods.size')).toEqual(store.get('parts.2.mods.size'));
    expect(back.get('parts.2.dot')).toEqual(store.get('parts.2.dot'));
    expect(back.get('parts.2.patterns.0.steps.3')).toEqual(store.get('parts.2.patterns.0.steps.3'));
  });

  it('a stored value in range for every parameter survives the round trip exactly, and knob positions map back to it', () => {
    const state = defaultState();
    const pick = (def, n) => fromNorm(def, n);
    for (const n of [0, 0.37, 1]) {
      for (const def of PART_PARAMS) state.parts[0].params[def.id] = pick(def, n);
      for (const def of GLOBAL_PARAMS) state.global[def.id] = pick(def, n);
      const back = autosaveRoundTrip(createStore(state));
      for (const def of PART_PARAMS) {
        const v = back.get(`parts.0.params.${def.id}`);
        expect(v, `${def.id} at ${n}`).toBe(state.parts[0].params[def.id]);
        // A knob drawn at toNorm(v) and nudged by nothing must give v back (int/enum exactly).
        const again = fromNorm(def, toNorm(def, v));
        if (def.curve === 'int' || def.curve === 'enum' || def.curve === 'bool') expect(again, def.id).toBe(v);
        else expect(Math.abs(again - v), def.id).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(v)));
      }
      for (const def of GLOBAL_PARAMS) expect(back.get(`global.${def.id}`), `${def.id} at ${n}`).toBe(state.global[def.id]);
    }
  });
});

describe('factory scenes x factory patches', () => {
  const byName = new Map(FACTORY_PATCHES.map(p => [p.name, p]));

  it('names a real factory patch on every part, so Next patch and the browser know where they are', () => {
    for (const scene of FACTORY_SCENES) {
      for (const [i, part] of scene.parts.entries()) expect(byName.has(part.patchName), `${scene.name} part ${i + 1}: "${part.patchName}"`).toBe(true);
    }
  });

  it('sounds exactly like the patch it names apart from the mixer', () => {
    for (const scene of FACTORY_SCENES) {
      for (const [i, part] of scene.parts.entries()) {
        const want = partWithPatch(part, byName.get(part.patchName));
        for (const def of PART_PARAMS) {
          if (MIX_IDS.has(def.id)) continue;
          expect(part.params[def.id], `${scene.name} part ${i + 1} ${def.id}`).toBe(want.params[def.id]);
        }
        expect(json(part.mods), `${scene.name} part ${i + 1} mods`).toEqual(json(want.mods));
        expect(json(part.links), `${scene.name} part ${i + 1} links`).toEqual(json(want.links));
      }
    }
  });

  it('loading a scene then reloading each part\'s own patch changes nothing but the mixer', () => {
    const storage = createMemoryStorage();
    for (let k = 0; k < FACTORY_SCENES.length; k++) {
      const store = createStore(defaultState());
      const presets = createPresets({ store, storage });
      expect(presets.loadScene(k)).toBe(true);
      for (let p = 0; p < store.get('parts').length; p++) {
        const before = store.get(`parts.${p}`);
        presets.loadPatch(p, before.patchName);
        const after = store.get(`parts.${p}`);
        const a = sound(before), b = sound(after);
        for (const id of MIX_IDS) { delete a.params[id]; delete b.params[id]; }
        expect(b, `${FACTORY_SCENES[k].name} part ${p + 1}`).toEqual(a);
        expect(after.patterns).toEqual(before.patterns);
        expect(after.seqOn).toBe(before.seqOn);
        expect(after.id).toBe(before.id);
        expect(after.arp).toEqual(before.arp);
      }
    }
  });
});

describe('patch library across parts, storage and files', () => {
  function tweak(store) {
    store.batch(() => {
      store.set('parts.0.params.cutoff', 777);
      store.set('parts.0.params.terrainA', 3);
      store.set('parts.0.params.mute', 1);
      store.set('parts.0.mods.morph', { ...store.get('parts.0.mods.morph'), lfoShape: LFO_SHAPES.indexOf('Steps'), lfoDepth: 0.6, lfoSync: 1, steps: Array.from({ length: 16 }, (_, i) => Math.sin(i)) });
      store.set('parts.0.links', [{ src: 1, dst: 'morph', amt: 1, curve: 0 }, { src: 3, dst: 'cutoff', amt: 0.3, curve: 1 }]);
      store.set('parts.0.dot', { ...store.get('parts.0.dot'), mode: 4, waypoints: [{ x: 0.2, y: 0.3, beats: 1 }, { x: 0.7, y: 0.9, beats: 2 }], tourMode: 1 });
    });
  }

  it('Save patch on part 1 then Load it on part 4 copies the whole sound and nothing else', () => {
    const store = createStore(migrateState(stripMeta(FACTORY_SCENES[0])));
    const presets = createPresets({ store, storage: createMemoryStorage() });
    tweak(store);
    const id = presets.savePatch(0, 'Integration Patch');
    const p3Before = store.get('parts.3');
    expect(presets.loadPatch(3, id)).toBe(true);
    const p3 = store.get('parts.3');
    expect(sound(p3)).toEqual(sound(store.get('parts.0')));
    expect(p3.patchName).toBe('Integration Patch');
    expect(p3.params.mute).toBe(p3Before.params.mute);
    expect(p3.patterns).toEqual(p3Before.patterns);
    expect(p3.seqOn).toBe(p3Before.seqOn);
    expect(p3.id).toBe(p3Before.id);
    expect(p3.arp).toEqual(p3Before.arp);
    expect(p3.name).toBe(p3Before.name);
    expect(p3.color).toBe(p3Before.color);
    // Editing the loaded copy never reaches the saved patch or the source part.
    store.set('parts.3.dot.waypoints.0.x', 0.99);
    store.set('parts.3.mods.morph.steps.0', -1);
    expect(store.get('parts.0.dot.waypoints.0.x')).toBe(0.2);
    expect(presets.getPatch(id).dot.waypoints[0].x).toBe(0.2);
  });

  it('a saved patch survives a restart (storage) and an export/import into another browser', async () => {
    const storage = createMemoryStorage();
    const store = createStore(migrateState(stripMeta(FACTORY_SCENES[2])));
    const presets = createPresets({ store, storage });
    tweak(store);
    const id = presets.savePatch(0, 'Travelling Patch');
    expect(JSON.parse(storage.getItem(STORAGE_KEY)).patches).toHaveLength(1);

    // Restart: a new library reads the same storage.
    const store2 = createStore(defaultState());
    const presets2 = createPresets({ store: store2, storage });
    expect(presets2.loadPatch(1, id)).toBe(true);
    expect(sound(store2.get('parts.1'))).toEqual(sound(store.get('parts.0')));

    // Another browser: export, import, load by name.
    const file = await presets.exportJSON('patch', id).text();
    const store3 = createStore(defaultState());
    const presets3 = createPresets({ store: store3, storage: createMemoryStorage() });
    expect(await presets3.importJSON(file)).toEqual({ patches: 1, scenes: 0 });
    expect(presets3.loadPatch(2, 'Travelling Patch')).toBe(true);
    expect(sound(store3.get('parts.2'))).toEqual(sound(store.get('parts.0')));
  });

  it('exporting the current session and importing it elsewhere gives the same session', async () => {
    const store = createStore(migrateState(stripMeta(FACTORY_SCENES[3])));
    const presets = createPresets({ store, storage: createMemoryStorage() });
    tweak(store);
    store.set('global.tempo', 131);
    const file = await presets.exportJSON('current').text();
    const store2 = createStore(defaultState());
    const presets2 = createPresets({ store: store2, storage: createMemoryStorage() });
    await presets2.importJSON(file);
    const scene = presets2.scenes().find(s => !s.factory);
    expect(scene).toBeTruthy();
    expect(presets2.loadScene(scene.id)).toBe(true);
    expect(store2.serialize()).toEqual(store.serialize());
  });

  it('every factory patch loads onto every part as a fixed point of the part sanitizer', () => {
    const store = createStore(defaultState());
    const presets = createPresets({ store, storage: createMemoryStorage() });
    for (const patch of presets.patches()) {
      for (let p = 0; p < store.get('parts').length; p++) {
        expect(presets.loadPatch(p, patch.id), patch.name).toBe(true);
        const part = store.get(`parts.${p}`);
        expect(sanitizePart(part, p), `${patch.name} on part ${p + 1}`).toEqual(part);
        for (const id of MOD_PARAM_IDS) expect(part.mods[id].steps, `${patch.name} ${id}`).toHaveLength(16);
      }
    }
  });
});

describe('MIDI program change x preset library', () => {
  it('program change n on the MPC loads presets.patches()[n] on the selected part', async () => {
    const clock = createFakeClock({ startSec: 1 });
    const engine = createFakeEngine(clock);
    const store = createStore(migrateState(stripMeta(FACTORY_SCENES[0])));
    const storage = createMemoryStorage();
    const presets = createPresets({ store, storage });
    const music = createMusic({ store, engine, presets, timers: clock.timers, perfNow: clock.perfNow });
    const input = fakeInput('in1', 'MPC MIDI 1', 'Akai');
    const access = fakeAccess({ inputs: [input] });
    const midi = await createMidi({ store, router: music.router, engine, transport: music.transport, presets, navigator: fakeNavigator(access, { permission: 'granted' }), storage, secure: true, perfNow: clock.perfNow });
    expect(midi.status).toBe('ready');
    midi.setSetting('programChange', true);
    store.set('ui.selectedPart', 2);
    for (const n of [0, 5, 17, presets.patches().length - 1]) {
      input.fire([0xc0, n]);
      expect(store.get('parts.2.patchName'), `program ${n}`).toBe(presets.patches()[n].name);
    }
    // Out of range: nothing changes.
    const before = store.get('parts.2.patchName');
    input.fire([0xc0, 127]);
    expect(store.get('parts.2.patchName')).toBe(before);
  });
});
