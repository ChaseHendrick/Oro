import { describe, it, expect } from 'vitest';
import { createStoreSync } from '../../src/audio/sync.js';
import { createEmitter } from '../../src/audio/emitter.js';
import { createStore } from '../../src/core/store.js';
import { defaultState, DEFAULT_PARTS, PART_PARAMS, MOD_PARAM_IDS, GLOBAL_PARAMS } from '../../src/core/params.js';
import { OrographDSP } from '../../src/dsp/dsp-core.js';

function setup() {
  const store = createStore(defaultState());
  const batches = [];
  const globals = [];
  let pending = null;
  const sync = createStoreSync({
    store,
    post: (msgs) => batches.push(msgs),
    onGlobal: (g, changed) => globals.push(changed),
    defer: (fn) => { pending = fn; },
  });
  const run = () => { const f = pending; pending = null; if (f) f(); };
  return { store, sync, batches, globals, run };
}

describe('store sync', () => {
  it('snapshot covers every part, every mod, the globals and the watched part', () => {
    const { sync } = setup();
    const snap = sync.snapshot();
    const params = snap.filter(m => m.t === 'params');
    const mods = snap.filter(m => m.t === 'mods');
    expect(params.length).toBe(DEFAULT_PARTS);
    expect(mods.length).toBe(DEFAULT_PARTS);
    for (const p of params) expect(Object.keys(p.p).length).toBe(PART_PARAMS.length);
    for (const m of mods) expect(Object.keys(m.m).sort()).toEqual([...MOD_PARAM_IDS].sort());
    const g = snap.find(m => m.t === 'global');
    expect(Object.keys(g.p).length).toBe(GLOBAL_PARAMS.length);
    expect(snap[snap.length - 1]).toEqual({ t: 'watch', part: 0 });
  });

  it('coalesces a burst of changes into one batch with the latest values', () => {
    const { store, batches, run } = setup();
    store.set('parts.1.params.cutoff', 500);
    store.set('parts.1.params.cutoff', 700);
    store.set('parts.1.params.morph', 0.3);
    store.set('parts.3.mods.size.lfoDepth', 0.4);
    store.set('global.tempo', 128);
    store.set('parts.1.seqOn', 1);        // not for the DSP
    expect(batches.length).toBe(0);
    run();
    expect(batches.length).toBe(1);
    const b = batches[0];
    expect(b).toContainEqual({ t: 'params', part: 1, p: { cutoff: 700, morph: 0.3 } });
    expect(b).toContainEqual({ t: 'global', p: { tempo: 128 } });
    const mods = b.find(m => m.t === 'mods');
    expect(mods.part).toBe(3);
    expect(mods.m.size.lfoDepth).toBe(0.4);
    expect(Object.keys(mods.m)).toEqual(['size']);
    expect(b.length).toBe(3);
  });

  it('store.batch of a whole patch becomes one message per part', () => {
    const { store, batches, run } = setup();
    store.batch(() => {
      for (const id of ['cutoff', 'resonance', 'attack', 'level']) store.set(`parts.2.params.${id}`, 0.5);
      store.set('parts.2.mods', store.get('parts.2.mods'));
    });
    run();
    expect(batches.length).toBe(1);
    const params = batches[0].filter(m => m.t === 'params');
    expect(params.length).toBe(1);
    expect(Object.keys(params[0].p).sort()).toEqual(['attack', 'cutoff', 'level', 'resonance']);
    expect(batches[0].filter(m => m.t === 'mods').length).toBe(1);
  });

  it('resends everything on a full load, a parts replace or a part replace', () => {
    const { store, batches, run } = setup();
    const st = store.serialize();
    st.parts[0].params.cutoff = 1234;
    store.load(st);
    run();
    expect(batches[0].filter(m => m.t === 'params').length).toBe(DEFAULT_PARTS);
    expect(batches[0].find(m => m.t === 'params' && m.part === 0).p.cutoff).toBe(1234);
    expect(batches[0].some(m => m.t === 'watch')).toBe(true);

    store.set('parts.2', { ...store.get('parts.2'), params: { ...store.get('parts.2.params'), fold: 0.9 } });
    run();
    expect(batches[1].map(m => m.t)).toEqual(['params', 'mods', 'links', 'trackFx', 'noiseRecording']);
    expect(batches[1][0].p.fold).toBe(0.9);
    expect(Object.keys(batches[1][0].p).length).toBe(PART_PARAMS.length);
  });

  it('sends watch on selected part and transport stop when ui.playing drops', () => {
    const { store, batches, run } = setup();
    store.set('ui.selectedPart', 2);
    run();
    expect(batches[0]).toEqual([{ t: 'watch', part: 2 }]);
    store.set('ui.playing', 1);
    run();
    expect(batches.length).toBe(1);   // starting is anchored by the sequencer itself
    store.set('ui.playing', 0);
    run();
    expect(batches[1]).toEqual([{ t: 'transport', playing: false }]);
  });

  it('drops non-numeric and unknown values', () => {
    const { store, batches, run } = setup();
    store.set('parts.0.params.cutoff', 'loud');
    store.set('parts.0.params.bogus', 3);
    store.set('parts.9.params.cutoff', 3);
    store.set('parts.0.mods.notAParam', { lfoDepth: 1 });
    run();
    expect(batches.length).toBe(0);
  });

  it('tells the host effects which globals changed', () => {
    const { store, globals, run } = setup();
    store.set('global.delayFeedback', 0.6);
    store.set('global.chorus', 0.4);
    run();
    expect(globals[0].sort()).toEqual(['chorus', 'delayFeedback']);
    store.load(store.serialize());
    run();
    expect(globals[1]).toBe(null);
  });

  it('flush() posts pending changes synchronously (before a note)', () => {
    const { store, sync, batches } = setup();
    store.set('parts.0.params.size', 0.3);
    sync.flush();
    expect(batches.length).toBe(1);
    sync.flush();
    expect(batches.length).toBe(1);
  });

  it('every message it produces is accepted by the real DSP', () => {
    const { store, sync, batches, run } = setup();
    const dsp = new OrographDSP(48000);
    for (const m of sync.snapshot()) dsp.handleMessage(m);
    store.set('parts.1.params.cutoff', 2000);
    store.set('parts.1.mods.cutoff', { lfoShape: 2, lfoRate: 3, lfoSync: 0, lfoDiv: 5, lfoDepth: 0.5, envDepth: 0, retrig: 1 });
    run();
    for (const m of batches[0]) dsp.handleMessage(m);
    const P = dsp.parts[1];
    expect(P.params[PART_PARAMS.findIndex(p => p.id === 'cutoff')]).toBe(2000);
    expect(P.lfoShape[MOD_PARAM_IDS.indexOf('cutoff')]).toBe(2);
  });
});

describe('emitter', () => {
  it('isolates throwing listeners and supports off()', () => {
    const e = createEmitter();
    const got = [];
    const errs = console.error;
    console.error = () => {};
    e.on('x', () => { throw new Error('boom'); });
    const off = e.on('x', (v) => got.push(v));
    e.emit('x', 1);
    off();
    e.emit('x', 2);
    console.error = errs;
    expect(got).toEqual([1]);
    expect(e.count('x')).toBe(1);
  });
});

describe('store sync: Round D state', () => {
  it('forwards links on change, in the snapshot and on load', () => {
    const { store, sync, batches, run } = setup();
    const snap = sync.snapshot();
    const links = snap.filter(m => m.t === 'links');
    expect(links.length).toBe(DEFAULT_PARTS);
    expect(links[0]).toEqual({ t: 'links', part: 0, links: [{ src: 1, dst: 'morph', amt: 1, curve: 0 }] });
    store.set('parts.2.links', [{ src: 5, dst: 'cutoff', amt: -0.5, curve: 2 }, { src: 99, dst: 'notAParam', amt: 1, curve: 0 }]);
    run();
    expect(batches[0]).toEqual([{ t: 'links', part: 2, links: [{ src: 5, dst: 'cutoff', amt: -0.5, curve: 2 }] }]);
    store.set('parts.2.links.0.amt', 0.25);
    run();
    expect(batches[1][0].links[0].amt).toBe(0.25);
    store.load(store.serialize());
    run();
    expect(batches[2].filter(m => m.t === 'links').length).toBe(DEFAULT_PARTS);
  });

  it('forwards macros, the ceiling and every other global', () => {
    const { store, batches, run } = setup();
    store.set('global.macro3', 0.7);
    store.set('global.ceiling', -3);
    run();
    expect(batches[0]).toEqual([{ t: 'global', p: { macro3: 0.7, ceiling: -3 } }]);
  });

  it('sends the Steps LFO values as a clean 32-value array', () => {
    const { store, batches, run } = setup();
    const steps = Array.from({ length: 32 }, (_, i) => (i % 2 ? 2 : -0.5));
    store.set('parts.1.mods.morph.steps', steps);
    store.set('parts.1.mods.morph.lfoShape', 6);
    run();
    const m = batches[0].find(x => x.t === 'mods').m.morph;
    expect(m.lfoShape).toBe(6);
    expect(m.steps.length).toBe(32);
    expect(m.steps[1]).toBe(1);          // clamped
    expect(m.steps).not.toBe(steps);     // copied
  });

  it('appends host state (quality, controllers) to the snapshot', () => {
    const store = createStore(defaultState());
    const sync = createStoreSync({ store, post: () => {}, defer: () => {}, extra: () => [{ t: 'quality', mode: 'high' }] });
    expect(sync.snapshot().slice(-1)).toEqual([{ t: 'quality', mode: 'high' }]);
  });
});
