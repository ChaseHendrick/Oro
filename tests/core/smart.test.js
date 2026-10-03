import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState, defaultPart, PART_PARAM_MAP, toNorm, fromNorm } from '../../src/core/params.js';
import { migrateState, sanitizePart } from '../../src/core/migrate.js';
import { createHistory, describeEdit } from '../../src/core/history.js';
import {
  SMART_KNOBS, SMART_MAX_TARGETS, SMART_CURVES, smartCurve, smartTargetNorm, smartTargetValue, sanitizeSmart, defaultSmart,
  readSmart, writeSmart, applySmartKnob, setSmartMap, editSmartMap, removeSmartMap, renameSmartKnob, clearSmartKnob,
  smartKnobLabel, smartTargetLabel, isSmartTarget,
} from '../../src/core/smart.js';
import { createPresets, sanitizePatch } from '../../src/presets/presets.js';
import { partWithPatch } from '../../src/presets/apply.js';
import { createMusic } from '../../src/music/music.js';
import { createMidi } from '../../src/midi/midi.js';
import { describeTarget } from '../../src/ui/settings-midi.js';
import { createFakeClock, createFakeEngine, createMemoryStorage } from '../music/fakes.js';
import { fakeInput, fakeOutput, fakeAccess, fakeNavigator } from '../midi/fake-midi.js';

const knobs = (...list) => ({ knobs: Array.from({ length: SMART_KNOBS }, (_, i) => list[i] || { name: '', value: 0, maps: [] }) });
const rel = (v, want) => Math.abs(v / want - 1);
function fakeTimers() {
  let id = 0; const q = new Map();
  return { setTimeout: (fn) => { q.set(++id, fn); return id; }, clearTimeout: (i) => q.delete(i), flush: () => { const fns = [...q.values()]; q.clear(); fns.forEach(f => f()); } };
}

describe('smart control mapping math', () => {
  it('shapes the knob travel with each curve', () => {
    expect(SMART_CURVES).toHaveLength(4);
    for (const c of [0, 1, 2, 3]) { expect(smartCurve(c, 0)).toBe(0); expect(smartCurve(c, 1)).toBe(1); }
    expect(smartCurve(0, 0.5)).toBe(0.5);
    expect(smartCurve(1, 0.5)).toBe(0.25);
    expect(smartCurve(2, 0.5)).toBe(0.75);
    expect(smartCurve(3, 0.25)).toBeCloseTo(0.15625, 10);
    expect(smartCurve(0, 2)).toBe(1);
    expect(smartCurve(0, NaN)).toBe(0);
  });

  it('maps a knob position across a range, inverted ranges included', () => {
    const up = { id: 'morph', min: 0.2, max: 0.8, curve: 0 };
    const down = { id: 'morph', min: 0.8, max: 0.2, curve: 0 };
    expect(smartTargetNorm(up, 0)).toBeCloseTo(0.2, 10);
    expect(smartTargetNorm(up, 0.5)).toBeCloseTo(0.5, 10);
    expect(smartTargetNorm(up, 1)).toBeCloseTo(0.8, 10);
    expect(smartTargetNorm(down, 0)).toBeCloseTo(0.8, 10);
    expect(smartTargetNorm(down, 0.25)).toBeCloseTo(0.65, 10);
    expect(smartTargetNorm(down, 1)).toBeCloseTo(0.2, 10);
  });

  it('follows the parameter curve (cutoff moves in octaves)', () => {
    const def = PART_PARAM_MAP.cutoff;
    const map = { id: 'cutoff', min: toNorm(def, 200), max: toNorm(def, 3200), curve: 0 };
    expect(smartTargetValue(map, 0)).toBeCloseTo(200, 6);
    expect(smartTargetValue(map, 0.5)).toBeCloseTo(800, 6);
    expect(smartTargetValue(map, 1)).toBeCloseTo(3200, 6);
    expect(smartTargetValue({ id: 'nope', min: 0, max: 1 }, 0.5)).toBeNaN();
  });

  it('accepts every sound setting as a target, envelope times included, but not the mix controls', () => {
    expect(isSmartTarget('cutoff')).toBe(true);
    expect(isSmartTarget('filter2Cutoff')).toBe(true);
    expect(isSmartTarget('attack')).toBe(true);
    expect(isSmartTarget('release')).toBe(true);
    expect(isSmartTarget('mute')).toBe(false);
    expect(isSmartTarget('solo')).toBe(false);
    expect(isSmartTarget('pedalSend')).toBe(false);
    expect(smartTargetLabel('filter2Cutoff')).toBe('Filter 2 cutoff');
    expect(smartTargetLabel('cutoff')).toBe('Cutoff');
  });

  it('labels knobs by name, then first target, then number', () => {
    expect(smartKnobLabel({ name: 'Bright', maps: [{ id: 'cutoff' }] }, 0)).toBe('Bright');
    expect(smartKnobLabel({ name: '', maps: [{ id: 'cutoff' }] }, 0)).toBe('Cutoff');
    expect(smartKnobLabel({ name: '', maps: [] }, 4)).toBe('Smart 5');
  });
});

describe('smart controls in saved state', () => {
  it('is absent from new tracks and from older sessions', () => {
    expect('smart' in defaultPart(0)).toBe(false);
    const old = migrateState(JSON.parse(JSON.stringify(defaultState())));
    for (const p of old.parts) expect('smart' in p).toBe(false);
  });

  it('sanitizes: drops unknown, non-target, repeated and extra targets and clamps', () => {
    const src = { knobs: [
      { name: '  Grit  ', value: 3, maps: [
        { id: 'drive', min: -1, max: 2, curve: 9 },
        { id: 'mute', min: 0, max: 1 },
        { id: 'nope', min: 0, max: 1 },
        { id: 'drive', min: 0.5, max: 0.5 },
        { id: 'fold', min: 0.1, max: 0.9, curve: 1 },
        { id: 'warp' }, { id: 'morph' }, { id: 'size' },
      ] },
      null, 'junk',
    ] };
    const s = sanitizeSmart(src);
    expect(s.knobs).toHaveLength(SMART_KNOBS);
    expect(s.knobs[0].name).toBe('Grit');
    expect(s.knobs[0].value).toBe(1);
    expect(s.knobs[0].maps.map(m => m.id)).toEqual(['drive', 'fold', 'warp', 'morph']);
    expect(s.knobs[0].maps).toHaveLength(SMART_MAX_TARGETS);
    expect(s.knobs[0].maps[0]).toEqual({ id: 'drive', min: 0, max: 1, curve: 3 });
    expect(s.knobs[0].maps[2]).toEqual({ id: 'warp', min: 0, max: 1, curve: 0 });
    expect(s.knobs[1]).toEqual({ name: '', value: 0, maps: [] });
    expect(sanitizeSmart(null)).toBeNull();
    expect(sanitizeSmart({ knobs: 'x' })).toBeNull();
    expect(sanitizeSmart(defaultSmart())).toBeNull();
    expect(sanitizeSmart(knobs({ name: '', value: 0.7, maps: [{ id: 'solo' }] }))).toBeNull();
  });

  it('round-trips through a saved session (JSON) unchanged', () => {
    const state = defaultState();
    state.parts[1].smart = knobs(null, { name: 'Open', value: 0.4, maps: [{ id: 'cutoff', min: 0.3, max: 0.9, curve: 2 }, { id: 'resonance', min: 0.6, max: 0.1, curve: 0 }] });
    const once = migrateState(JSON.parse(JSON.stringify(state)));
    expect(once.parts[1].smart).toEqual(sanitizeSmart(state.parts[1].smart));
    expect('smart' in once.parts[0]).toBe(false);
    const twice = migrateState(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
    expect(sanitizePart(once.parts[1], 1).smart.knobs[1].maps[1]).toEqual({ id: 'resonance', min: 0.6, max: 0.1, curve: 0 });
  });
});

describe('smart controls and the store', () => {
  it('turning a knob writes every target and the knob position in one batch', () => {
    const store = createStore(defaultState());
    expect(setSmartMap(store, 0, 2, 'cutoff', 200, 3200)).toBe('added');
    expect(setSmartMap(store, 0, 2, 'resonance', 0.8, 0.1)).toBe('added');
    expect(setSmartMap(store, 0, 2, 'morph', 0, 1, { curve: 1 })).toBe('added');
    const seen = [];
    store.subscribe('', (path, value, meta) => seen.push([path, meta && meta.source, meta && meta.smart]));
    expect(applySmartKnob(store, 0, 2, 0.5)).toBe(true);
    expect(rel(store.get('parts.0.params.cutoff'), 800)).toBeLessThan(0.001);
    expect(store.get('parts.0.params.resonance')).toBeCloseTo(0.45, 3);
    expect(store.get('parts.0.params.morph')).toBeCloseTo(0.25, 3);
    expect(store.get('parts.0.smart.knobs.2.value')).toBe(0.5);
    expect(seen.every(([, src, smart]) => src === 'ui' && smart === true)).toBe(true);
    expect(seen.map(s => s[0])).toEqual(['parts.0.params.cutoff', 'parts.0.params.resonance', 'parts.0.params.morph', 'parts.0.smart.knobs.2.value']);
    // knob ends restore the learned values
    applySmartKnob(store, 0, 2, 0);
    expect(rel(store.get('parts.0.params.cutoff'), 200)).toBeLessThan(0.001);
    expect(store.get('parts.0.params.resonance')).toBeCloseTo(0.8, 3);
    applySmartKnob(store, 0, 2, 1);
    expect(rel(store.get('parts.0.params.cutoff'), 3200)).toBeLessThan(0.001);
    expect(store.get('parts.0.params.resonance')).toBeCloseTo(0.1, 3);
    // other tracks are untouched
    expect(store.get('parts.1.params.cutoff')).toBe(PART_PARAM_MAP.cutoff.default);
  });

  it('does nothing for an empty knob or a missing track', () => {
    const store = createStore(defaultState());
    const before = JSON.stringify(store.serialize());
    expect(applySmartKnob(store, 0, 0, 0.7)).toBe(false);
    expect(applySmartKnob(store, 9, 0, 0.7)).toBe(false);
    expect(setSmartMap(store, 0, 0, 'mute', 0, 1)).toBe('invalid');
    expect(setSmartMap(store, 0, 9, 'cutoff', 0, 1)).toBe('invalid');
    expect(JSON.stringify(store.serialize())).toBe(before);
  });

  it('adds, updates, edits, inverts, renames and removes mappings', () => {
    const store = createStore(defaultState());
    for (const id of ['cutoff', 'morph', 'warp', 'fold']) expect(setSmartMap(store, 0, 0, id, PART_PARAM_MAP[id].default, PART_PARAM_MAP[id].max)).toBe('added');
    expect(setSmartMap(store, 0, 0, 'size', 0.1, 0.2)).toBe('full');
    expect(setSmartMap(store, 0, 0, 'morph', 0.5, 0.25)).toBe('updated');
    expect(readSmart(store, 0).knobs[0].maps[1]).toEqual({ id: 'morph', min: 0.5, max: 0.25, curve: 0 });
    expect(editSmartMap(store, 0, 0, 1, { curve: 3, min: 0.9 })).toBe(true);
    expect(readSmart(store, 0).knobs[0].maps[1]).toEqual({ id: 'morph', min: 0.9, max: 0.25, curve: 3 });
    expect(renameSmartKnob(store, 0, 0, '  Wide  ')).toBe(true);
    expect(store.get('parts.0.smart.knobs.0.name')).toBe('Wide');
    expect(removeSmartMap(store, 0, 0, 0)).toBe(true);
    expect(readSmart(store, 0).knobs[0].maps.map(m => m.id)).toEqual(['morph', 'warp', 'fold']);
    expect(clearSmartKnob(store, 0, 0)).toBe(true);
    // nothing left: the field goes away entirely
    expect('smart' in store.get('parts.0')).toBe(false);
    writeSmart(store, 0, knobs({ name: 'Keep', value: 0, maps: [] }));
    expect(store.get('parts.0.smart.knobs.0.name')).toBe('Keep');
  });

  it('is one undo step per turn, labelled Smart controls', () => {
    const store = createStore(defaultState()), timers = fakeTimers();
    setSmartMap(store, 0, 0, 'cutoff', 500, 5000);
    const h = createHistory(store, { timers });
    const c0 = store.get('parts.0.params.cutoff');
    for (const v of [0.2, 0.4, 0.6]) applySmartKnob(store, 0, 0, v);
    timers.flush();
    expect(h.list().past).toEqual(['Smart controls, track 1']);
    h.undo();
    expect(store.get('parts.0.params.cutoff')).toBe(c0);
    expect(store.get('parts.0.smart.knobs.0.value')).toBe(0);
    expect(describeEdit('parts.2.smart')).toBe('Smart controls, track 3');
  });
});

describe('smart controls in patches', () => {
  it('saves with a patch and comes back on load; a patch without them clears them', () => {
    const store = createStore(defaultState());
    const presets = createPresets({ store, storage: createMemoryStorage() });
    setSmartMap(store, 0, 3, 'cutoff', 300, 6000);
    renameSmartKnob(store, 0, 3, 'Open');
    const id = presets.savePatch(0, 'Smart one');
    expect(presets.getPatch(id).smart).toEqual(store.get('parts.0.smart'));
    presets.loadPatch(1, id);
    expect(store.get('parts.1.smart')).toEqual(store.get('parts.0.smart'));
    expect(store.get('parts.1.smart')).not.toBe(store.get('parts.0.smart'));
    presets.initPatch(1);
    expect('smart' in store.get('parts.1')).toBe(false);
    // a track without smart controls loads a patch without them exactly as before
    const base = defaultPart(2);
    expect(Object.keys(partWithPatch(base, { name: 'X', params: {} }))).toEqual(Object.keys(partWithPatch({ ...base }, { name: 'X', params: {} })));
    expect('smart' in partWithPatch(base, { name: 'X', params: {} })).toBe(false);
    expect('smart' in sanitizePatch({ name: 'Y', params: {} })).toBe(false);
    expect(sanitizePatch({ name: 'Y', params: {}, smart: knobs({ name: '', value: 0, maps: [{ id: 'morph', min: 0, max: 1 }] }) }).smart.knobs[0].maps).toHaveLength(1);
  });
});

describe('smart knobs and MIDI learn', () => {
  it('learns a CC for a smart knob and turns it on the selected track', async () => {
    const clock = createFakeClock({ startSec: 1 });
    const engine = createFakeEngine(clock);
    const store = createStore(defaultState());
    const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
    const input = fakeInput('in-1', 'Keys', 'Test');
    const nav = fakeNavigator(fakeAccess({ inputs: [input], outputs: [fakeOutput('out-1', 'Keys', 'Test')] }), { permission: 'granted' });
    const midi = await createMidi({ store, router: music.router, engine, transport: music.transport, navigator: nav, storage: createMemoryStorage(), secure: true, perfNow: clock.perfNow, timers: clock.timers });
    setSmartMap(store, 0, 1, 'morph', 0, 1);
    setSmartMap(store, 1, 1, 'warp', 0, 1);
    await expect(midi.learn({ scope: 'smart', part: 'sel', id: 'smart9' })).rejects.toThrow();
    const p = midi.learn({ scope: 'smart', part: 'sel', id: 'smart2' });
    input.fire([0xb0, 20, 0]);
    expect(await p).toEqual({ cc: 20, channel: 1, target: { scope: 'smart', part: 'sel', id: 'smart2' } });
    input.fire([0xb0, 20, 127]);
    expect(store.get('parts.0.params.morph')).toBeCloseTo(1, 6);
    expect(store.get('parts.0.smart.knobs.1.value')).toBe(1);
    store.set('ui.selectedPart', 1);
    input.fire([0xb0, 20, 64]);
    expect(store.get('parts.1.params.warp')).toBeCloseTo(64 / 127, 3);
    expect(store.get('parts.0.params.morph')).toBeCloseTo(1, 6);
    expect(describeTarget({ scope: 'smart', part: 'sel', id: 'smart2' })).toBe('Smart knob 2 (selected track)');
  });
});
