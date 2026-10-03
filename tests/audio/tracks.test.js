// Audio host side of tracks (v1.3): the store sync tells the DSP about the
// track list before anything else, slots follow their tracks through the sync,
// the terrain manager and a live DSP, and bounces make one stem per track.
import { describe, it, expect } from 'vitest';
import { createStoreSync } from '../../src/audio/sync.js';
import { createTerrainManager } from '../../src/audio/terrain-manager.js';
import { stemParts, passInit, normaliseEvents, renderDspHere } from '../../src/audio/bounce.js';
import { sequencerEvents } from '../../src/audio/bounce-events.js';
import { buildTerrainLevels, jobFor } from '../../src/audio/terrain-jobs.js';
import { createStore } from '../../src/core/store.js';
import { MAX_PARTS, PART_PARAM_INDEX, defaultState } from '../../src/core/params.js';
import { addTrack, removeTrack, moveTrack, duplicateTrack, REPLACE_TRACKS } from '../../src/core/tracks.js';
import { OroDSP } from '../../src/dsp/dsp-core.js';

function syncSetup(state = defaultState()) {
  const store = createStore(state);
  const batches = [];
  let pending = null;
  const sync = createStoreSync({ store, post: (msgs) => batches.push(msgs), defer: (fn) => { pending = fn; } });
  const run = () => { const f = pending; pending = null; if (f) f(); };
  return { store, sync, batches, run };
}

describe('store sync: tracks', () => {
  it('opens the snapshot with the track count and covers every track', () => {
    const { sync } = syncSetup(defaultState(7));
    const snap = sync.snapshot();
    expect(snap[0]).toEqual({ t: 'tracks', count: 7 });
    expect(snap.filter(m => m.t === 'params').map(m => m.part)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('posts the permutation at once, ahead of the new track\'s settings', () => {
    const { store, batches, run } = syncSetup();
    store.set('parts.2.params.cutoff', 700);   // pending for track 3 (t3) when the list changes
    addTrack(store, { index: 0 });               // a new first track pushes t3 to index 3
    expect(batches).toHaveLength(1);
    const [msg] = batches[0];
    expect(msg.t).toBe('tracks');
    expect(msg.count).toBe(5);
    expect(msg.fresh).toEqual([0]);
    expect(msg.perm.slice(0, 5)).toEqual([4, 0, 1, 2, 3]);
    run();
    const params = batches[1].filter(m => m.t === 'params');
    // the new track is sent in full, the pending change follows t3 to index 3
    expect(params.find(m => m.part === 0).p).toHaveProperty('terrainA');
    expect(params.find(m => m.part === 3).p.cutoff).toBe(700);
    expect(params.some(m => m.part >= 5)).toBe(false);
  });

  it('sends nothing for a write to a track that does not exist', () => {
    const { store, batches, run } = syncSetup();
    store.set('parts.6.params.cutoff', 300);
    run();
    expect(batches).toHaveLength(0);
  });

  it('keeps a mirrored DSP in step through add, move, duplicate, remove and a scene load', () => {
    const { store, batches, run } = syncSetup();
    const dsp = new OroDSP(48000);
    const apply = () => { run(); for (const b of batches.splice(0)) for (const m of b) dsp.handleMessage(m); };
    for (const m of createStoreSync({ store, post: () => {}, defer: () => {} }).snapshot()) dsp.handleMessage(m);
    const check = (label) => {
      const n = store.get('parts').length;
      expect(dsp.count, label).toBe(n);
      for (let p = 0; p < n; p++) expect(dsp.parts[p].params[PART_PARAM_INDEX.stretch], `${label} part ${p}`).toBeCloseTo(store.get(`parts.${p}.params.stretch`), 9);
    };
    store.batch(() => { for (let p = 0; p < 4; p++) store.set(`parts.${p}.params.stretch`, p / 10); });
    apply(); check('start');
    const tagged = dsp.parts[1];
    moveTrack(store, 1, 3); apply(); check('move');
    expect(dsp.parts[3]).toBe(tagged);           // the same DSP part, moved with its track
    addTrack(store); store.set('parts.4.params.stretch', -0.5); apply(); check('add');
    duplicateTrack(store, 3); apply(); check('duplicate');
    expect(dsp.parts[3]).toBe(tagged);
    removeTrack(store, 0); apply(); check('remove');
    expect(dsp.parts[2]).toBe(tagged);
    store.load(defaultState(2), { source: 'scene', [REPLACE_TRACKS]: true }); apply(); check('scene');
    expect(dsp.parts.slice(0, 2)).not.toContain(tagged);
  });
});

describe('terrain manager: tracks', () => {
  function fakeGenerator() {
    const jobs = [];
    return {
      size: 16, jobs, free: () => 1,
      run(job) { jobs.push(job); return Promise.resolve(buildTerrainLevels({ ...job, size: 16 })); },
    };
  }
  const settle = () => new Promise(r => setTimeout(r, 40));

  it('moves tables with their tracks and builds only the new ones', async () => {
    const store = createStore(defaultState());
    store.batch(() => { for (let p = 0; p < 4; p++) store.set(`parts.${p}.params.terrainA`, p); });
    const posts = [];
    const generator = fakeGenerator();
    const tm = createTerrainManager({ store, generator, debounceMs: 5, post: (m) => posts.push(m), emit: () => {} });
    await tm.whenIdle();
    const t1 = tm.get(1, 'A');
    const before = posts.length;
    moveTrack(store, 1, 3);
    await settle();
    await tm.whenIdle();
    expect(tm.get(3, 'A')).toEqual(t1);
    expect(posts.length).toBe(before);           // nothing regenerated or resent
    addTrack(store);
    await settle();
    await tm.whenIdle();
    expect(posts.filter(m => m.part === 4)).toHaveLength(2);
    expect(tm.messages().every(m => m.part < 5)).toBe(true);
    tm.dispose();
  });
});

describe('bounce: one stem per track', () => {
  it('picks every playing, audible track, including tracks past the fourth', () => {
    const st = defaultState(8);
    const on = (part) => ({ time: 0.1, msg: { t: 'noteOn', part, note: 60, vel: 1 } });
    const evs = normaliseEvents([on(0), on(5), on(7)], 1);
    expect(stemParts(st, evs)).toEqual([0, 5, 7]);
    st.parts[7].params.mute = 1;
    expect(stemParts(st, evs)).toEqual([0, 5]);
  });

  it('renders the sequencer of track 6 and its stem on its own', async () => {
    const st = defaultState(6);
    st.global.tempo = 120;
    st.parts[5].seqOn = 1;
    st.parts[5].patterns[0].steps[0] = { ...st.parts[5].patterns[0].steps[0], on: 1, gate: 0.5 };
    st.parts[0].seqOn = 1;
    st.parts[0].patterns[0].steps[8] = { ...st.parts[0].patterns[0].steps[8], on: 1, gate: 0.5 };
    const evs = normaliseEvents(sequencerEvents(st, 1), 2);
    expect([...new Set(evs.filter(e => e.msg.t === 'noteOn').map(e => e.msg.part))].sort()).toEqual([0, 5]);
    const store = createStore(st);
    const snapshot = createStoreSync({ store, post: () => {}, defer: () => {} }).snapshot();
    const terrains = [0, 5].flatMap(p => [0, 1].map(s => ({ t: 'terrain', part: p, slot: s, levels: buildTerrainLevels(jobFor(st.parts[p].params, null, s ? 'B' : 'A', 64)) })));
    const sr = 16000;
    const ctx = { sampleRate: sr, createBuffer(ch, length) { const d = Array.from({ length: ch }, () => new Float32Array(length)); return { length, numberOfChannels: ch, sampleRate: sr, getChannelData: (c) => d[c] }; } };
    const energy = async (solo) => {
      const { init, late } = passInit({ snapshot, terrains, events: evs, solo });
      const [dry] = await renderDspHere(ctx, init, late, Math.round(1.5 * sr), () => {});
      const L = dry.getChannelData(0);
      const half = Math.round(0.25 * sr);   // track 6 plays at 0 s, track 1 at 2 beats (1 s)
      let a = 0, b = 0;
      for (let i = 0; i < L.length; i++) { if (i < 2 * half) a += L[i] * L[i]; else b += L[i] * L[i]; }
      return { first: a, second: b };
    };
    const mix = await energy(null);
    const six = await energy(5);
    expect(mix.first).toBeGreaterThan(1e-3);
    expect(mix.second).toBeGreaterThan(1e-3);
    expect(six.first).toBeGreaterThan(1e-3);
    expect(six.second).toBeLessThan(mix.second * 0.05);  // track 1 muted in track 6's stem
    expect(MAX_PARTS).toBeGreaterThanOrEqual(6);
  });
});
