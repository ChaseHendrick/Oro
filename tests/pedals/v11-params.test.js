// v1.1 pedal wiring: parameters, the Guitar Level link source, migration of
// v1.0 sessions, and patches leaving the pedal routing alone.
import { describe, it, expect } from 'vitest';
import {
  PART_PARAMS, PART_PARAM_MAP, PART_PARAM_INDEX, PEDAL_PARAM_IDS, LINK_SOURCES, STATE_VERSION, defaultState, defaultPart,
} from '../../src/core/params.js';
import { migrateState, sanitizeParams, sanitizeLinks } from '../../src/core/migrate.js';
import { partWithPatch } from '../../src/presets/apply.js';
import { sanitizePatch, createPresets } from '../../src/presets/presets.js';
import { createStore } from '../../src/core/store.js';

describe('pedal parameters', () => {
  it('adds Pedal send, Pre and Insert to every part, off by default', () => {
    expect(PEDAL_PARAM_IDS).toEqual(['pedalSend', 'pedalPre', 'pedalInsert']);
    expect(PART_PARAM_MAP.pedalSend).toMatchObject({ group: 'mix', curve: 'lin', min: 0, max: 1, default: 0 });
    expect(PART_PARAM_MAP.pedalPre).toMatchObject({ group: 'mix', curve: 'bool', default: 0 });
    expect(PART_PARAM_MAP.pedalInsert).toMatchObject({ group: 'mix', curve: 'bool', default: 0 });
    for (const id of PEDAL_PARAM_IDS) expect(PART_PARAM_MAP[id].mod).toBeFalsy();
    for (const p of defaultState().parts) for (const id of PEDAL_PARAM_IDS) expect(p.params[id]).toBe(0);
  });

  it('appends them, so the worklet slots of older parameters do not move', () => {
    const n = PART_PARAMS.length;
    expect(PART_PARAM_INDEX.pedalSend).toBe(n - 3);
    expect(PART_PARAM_INDEX.pedalInsert).toBe(n - 1);
    expect(PART_PARAM_INDEX.formant).toBe(n - 4);
    expect(PART_PARAM_INDEX.terrainA).toBe(0);
  });

  it('adds Guitar Level as the last Links source and keeps the older indices', () => {
    expect(LINK_SOURCES[LINK_SOURCES.length - 1]).toBe('Guitar Level');
    expect(LINK_SOURCES.indexOf('Terrain Height')).toBe(14);
    expect(LINK_SOURCES.indexOf('Macro 1')).toBe(5);
    const links = sanitizeLinks([{ src: 15, dst: 'cutoff', amt: 0.5, curve: 0 }, { src: 99, dst: 'morph', amt: 1, curve: 0 }]);
    expect(links[0]).toEqual({ src: 15, dst: 'cutoff', amt: 0.5, curve: 0 });
    expect(links[1].src).toBe(LINK_SOURCES.length - 1);
  });

  it('clamps and rounds pedal values like any other parameter', () => {
    const p = sanitizeParams(PART_PARAMS, { pedalSend: 2, pedalPre: 0.7, pedalInsert: -1 });
    expect(p.pedalSend).toBe(1);
    expect(p.pedalPre).toBe(1);
    expect(p.pedalInsert).toBe(0);
    expect(sanitizeParams(PART_PARAMS, { pedalSend: 'loud' }).pedalSend).toBe(0);
  });
});

describe('migrating saved sessions', () => {
  it('loads a v1.0 session (no pedal params) with the pedal routing off', () => {
    const old = JSON.parse(JSON.stringify(defaultState()));
    old.version = 1;
    for (const p of old.parts) for (const id of PEDAL_PARAM_IDS) delete p.params[id];
    old.parts[2].params.cutoff = 1234;
    old.parts[1].links = [{ src: 5, dst: 'morph', amt: 0.4, curve: 1 }];
    const m = migrateState(old);
    expect(STATE_VERSION).toBe(2);
    expect(m.version).toBe(STATE_VERSION);
    for (const p of m.parts) for (const id of PEDAL_PARAM_IDS) expect(p.params[id]).toBe(0);
    expect(m.parts[2].params.cutoff).toBe(1234);
    expect(m.parts[1].links).toEqual([{ src: 5, dst: 'morph', amt: 0.4, curve: 1 }]);
  });

  it('keeps pedal routing saved by v1.1', () => {
    const s = defaultState();
    s.parts[0].params.pedalSend = 0.6;
    s.parts[0].params.pedalInsert = 1;
    s.parts[3].params.pedalPre = 1;
    const m = migrateState(JSON.parse(JSON.stringify(s)));
    expect(m.parts[0].params.pedalSend).toBe(0.6);
    expect(m.parts[0].params.pedalInsert).toBe(1);
    expect(m.parts[3].params.pedalPre).toBe(1);
    expect(migrateState(m)).toEqual(m);
  });

  it('still turns garbage into the default state', () => {
    expect(migrateState(null)).toEqual(defaultState());
    expect(migrateState('nope').version).toBe(STATE_VERSION);
  });
});

describe('patches and the pedal routing', () => {
  it('loading a patch keeps the part\'s pedal routing, like Mute and Solo', () => {
    const base = defaultPart(0);
    base.params.pedalSend = 0.7; base.params.pedalPre = 1; base.params.pedalInsert = 1;
    const next = partWithPatch(base, { name: 'X', params: { cutoff: 500, pedalSend: 0, pedalInsert: 0 } });
    expect(next.params.cutoff).toBe(500);
    expect(next.params.pedalSend).toBe(0.7);
    expect(next.params.pedalPre).toBe(1);
    expect(next.params.pedalInsert).toBe(1);
  });

  it('never stores pedal routing in a patch', () => {
    const clean = sanitizePatch({ name: 'Y', params: { cutoff: 300, pedalSend: 1, pedalPre: 1, pedalInsert: 1, mute: 1 } });
    expect(clean.params.cutoff).toBe(300);
    for (const id of [...PEDAL_PARAM_IDS, 'mute']) expect(clean.params).not.toHaveProperty(id);

    const store = createStore(defaultState());
    store.set('parts.0.params.pedalSend', 0.5);
    store.set('parts.0.params.pedalInsert', 1);
    const mem = new Map();
    const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
    const presets = createPresets({ store, storage });
    presets.savePatch(0, 'Through the pedals');
    const saved = JSON.parse(mem.get('orograph.presets.v1')).patches.find(p => p.name === 'Through the pedals');
    expect(saved).toBeTruthy();
    for (const id of PEDAL_PARAM_IDS) expect(saved.params).not.toHaveProperty(id);
    // Loading a factory patch on that part leaves the routing as it was.
    presets.loadPatch(0, presets.patches()[0].id);
    expect(store.get('parts.0.params.pedalSend')).toBe(0.5);
    expect(store.get('parts.0.params.pedalInsert')).toBe(1);
  });
});
