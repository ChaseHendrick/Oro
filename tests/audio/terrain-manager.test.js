import { describe, it, expect } from 'vitest';
import { createTerrainManager } from '../../src/audio/terrain-manager.js';
import { createTerrainGenerator } from '../../src/audio/terrain-generator.js';
import { jobFor, jobKey, hashString, buildTerrainLevels } from '../../src/audio/terrain-jobs.js';
import { createStore } from '../../src/core/store.js';
import { defaultState, NUM_PARTS } from '../../src/core/params.js';
import { TERRAIN_INDEX } from '../../src/dsp/catalog.js';
import { generateTerrain } from '../../src/dsp/terrains.js';
import { bytesToBase64 } from '../../src/audio/importers.js';
import { OrographDSP } from '../../src/dsp/dsp-core.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Fake generator: tiny tables, controllable concurrency, records jobs. */
function fakeGenerator({ size = 16, slots = 1, delay = 5 } = {}) {
  let busy = 0;
  const jobs = [];
  return {
    size,
    jobs,
    free: () => slots - busy,
    run(job) {
      busy++;
      jobs.push(job);
      return new Promise((resolve) => setTimeout(() => {
        busy--;
        if (job.kind === 'flat') { resolve(buildTerrainLevels(job)); return; }
        const s = job.size;
        const d = new Float32Array(s * s).fill(job.index ?? 0.5);
        resolve([{ size: s, data: d }, { size: s / 2, data: new Float32Array(s * s / 4) }]);
      }, delay));
    },
  };
}

function setup(genOpts) {
  const store = createStore(defaultState());
  const posts = [];
  const events = [];
  const generator = fakeGenerator(genOpts);
  const tm = createTerrainManager({
    store,
    generator,
    debounceMs: 10,
    post: (msg, transfer) => posts.push({ msg, transfer }),
    emit: (name, payload) => events.push({ name, ...payload }),
  });
  return { store, tm, posts, events, generator };
}

describe('terrain jobs', () => {
  it('rounds detail to 0.01 in the key and the build', () => {
    const a = jobFor({ terrainA: 5, seed: 7, detail: 0.501 }, null, 'A', 512);
    const b = jobFor({ terrainA: 5, seed: 7, detail: 0.499 }, null, 'A', 512);
    expect(jobKey(a)).toBe(jobKey(b));
    expect(a.detail).toBe(0.5);
    expect(jobKey(jobFor({ terrainA: 5, seed: 8, detail: 0.5 }, null, 'A', 512))).not.toBe(jobKey(a));
    expect(jobKey(jobFor({ terrainA: 5, seed: 7, detail: 0.5 }, null, 'A', 256))).not.toBe(jobKey(a));
  });

  it('keys imported terrains by content and falls back to flat without data', () => {
    const ut = { name: 'x', kind: 'image', w: 4, h: 4, mirror: 1, data: bytesToBase64(new Uint8Array(16).fill(9)) };
    const p = { terrainB: TERRAIN_INDEX.user };
    const k1 = jobKey(jobFor(p, ut, 'B', 64));
    const k2 = jobKey(jobFor(p, { ...ut, name: 'renamed' }, 'B', 64));
    const k3 = jobKey(jobFor(p, { ...ut, data: bytesToBase64(new Uint8Array(16).fill(10)) }, 'B', 64));
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(jobFor(p, null, 'B', 64)).toEqual({ kind: 'flat', size: 32 });
    expect(hashString('abc')).not.toBe(hashString('abd'));
    expect(hashString('abc')).toHaveLength(16);
  });

  it('builds the same table as the DSP generator, with a mip chain', () => {
    const levels = buildTerrainLevels(jobFor({ terrainA: 2, seed: 3, detail: 0.25 }, null, 'A', 128));
    expect(levels.map(l => l.size)).toEqual([128, 64, 32]);
    const ref = generateTerrain(2, { size: 128, seed: 3, detail: 0.25 });
    expect(Buffer.compare(Buffer.from(levels[0].data.buffer), Buffer.from(ref.buffer))).toBe(0);
    const buffers = new Set(levels.map(l => l.data.buffer));
    expect(buffers.size).toBe(levels.length);   // transferable independently
  });
});

describe('terrain manager', () => {
  it('fills all 4 parts x 2 slots at start, generating each distinct table once', async () => {
    const { tm, posts, events, generator } = setup();
    await tm.whenIdle();
    expect(events.length).toBe(NUM_PARTS * 2);
    expect(new Set(events.map(e => `${e.part}${e.slot}`)).size).toBe(8);
    expect(generator.jobs.length).toBe(2);           // default patch: Swell + Massif everywhere
    expect(posts.length).toBe(8);
    for (let p = 0; p < NUM_PARTS; p++) {
      expect(tm.get(p, 'A').size).toBe(16);
      expect(tm.get(p, 1).data).toBe(tm.get(p, 'B').data);
    }
    expect(tm.get(9, 'A')).toBe(null);
    expect(tm.get(0, 'C')).toBe(null);
  });

  it('posts copies (transfer list) so the cache stays valid', async () => {
    const { tm, posts } = setup();
    await tm.whenIdle();
    const { msg, transfer } = posts[0];
    expect(msg.t).toBe('terrain');
    expect([0, 1]).toContain(msg.slot);
    expect(transfer.length).toBe(msg.levels.length);
    expect(transfer[0]).toBe(msg.levels[0].data.buffer);
    expect(msg.levels[0].data).not.toBe(tm.get(msg.part, msg.slot).data);
    expect([...msg.levels[0].data]).toEqual([...tm.get(msg.part, msg.slot).data]);
  });

  it('debounces bursts and only builds the last wanted table', async () => {
    const { store, tm, events, generator } = setup();
    await tm.whenIdle();
    const before = generator.jobs.length;
    events.length = 0;
    for (let s = 0; s < 20; s++) store.set('parts.1.params.seed', s);
    await sleep(2);
    expect(generator.jobs.length).toBe(before);       // still debouncing
    await tm.whenIdle();
    expect(generator.jobs.length - before).toBe(2);   // A and B for seed 19
    expect(generator.jobs.slice(-2).every(j => j.seed === 19)).toBe(true);
    expect(events.length).toBe(2);
    expect(events.every(e => e.part === 1)).toBe(true);
  });

  it('serves repeats from the cache and ignores unrelated changes', async () => {
    const { store, tm, events, generator } = setup();
    await tm.whenIdle();
    store.set('parts.0.params.terrainA', 3);
    await tm.whenIdle();
    const n = generator.jobs.length;
    store.set('parts.0.params.terrainA', 0);
    await tm.whenIdle();
    store.set('parts.0.params.terrainA', 3);
    await tm.whenIdle();
    expect(generator.jobs.length).toBe(n);
    expect(tm.stats().cacheHits).toBeGreaterThanOrEqual(2);
    const ev = events.length;
    store.set('parts.0.params.cutoff', 100);
    store.set('parts.0.params.morph', 0.5);
    await sleep(30);
    await tm.whenIdle();
    expect(events.length).toBe(ev);
  });

  it('evicts least-recently used tables beyond the cache size', async () => {
    const store = createStore(defaultState());
    const generator = fakeGenerator();
    const tm = createTerrainManager({ store, generator, debounceMs: 1, cacheSize: 3, post: () => {}, emit: () => {} });
    await tm.whenIdle();
    for (let s = 0; s < 4; s++) { store.set('parts.0.params.seed', s); await tm.whenIdle(); }
    expect(tm.stats().cached).toBe(3);
    expect(tm.stats().evicted).toBeGreaterThan(0);
  });

  it('reacts to imports, whole-state loads and resendAll', async () => {
    const { store, tm, events, posts } = setup();
    await tm.whenIdle();
    events.length = 0;
    const ut = { name: 'pic', kind: 'image', w: 4, h: 4, mirror: 1, data: bytesToBase64(new Uint8Array(16).fill(200)) };
    store.batch(() => {
      store.set('parts.3.userTerrain.B', ut);
      store.set('parts.3.params.terrainB', TERRAIN_INDEX.user);
    });
    await tm.whenIdle();
    expect(events.map(e => `${e.part}${e.slot}`)).toEqual(['3B']);

    events.length = 0;
    const st = store.serialize();
    st.parts[2].params.terrainA = 7;
    store.load(st);
    await tm.whenIdle();
    expect(events.map(e => `${e.part}${e.slot}`)).toEqual(['2A']);

    const n = posts.length;
    tm.resendAll();
    expect(posts.length - n).toBe(8);
  });

  it('selecting Imported with nothing imported gives a flat (silent) table', async () => {
    const { store, tm } = setup();
    await tm.whenIdle();
    store.set('parts.1.params.terrainA', TERRAIN_INDEX.user);
    await tm.whenIdle();
    const t = tm.get(1, 'A');
    expect(t.size).toBe(32);
    expect(t.data.every(v => v === 0)).toBe(true);
  });

  it('terrain messages are accepted by the real DSP', async () => {
    const generator = await createTerrainGenerator({ code: '', inlineSize: 64 });
    const store = createStore(defaultState());
    store.set('parts.2.params.terrainB', 9);
    const dsp = new OrographDSP(48000);
    const before = dsp.parts[2].terrB;
    const tm = createTerrainManager({ store, generator, post: (msg) => dsp.handleMessage(msg), emit: () => {} });
    await tm.whenIdle();
    const chain = dsp.parts[2].terrB;
    expect(chain).not.toBe(before);
    expect(chain[0].size).toBe(64);
    expect(chain[chain.length - 1].size).toBeLessThanOrEqual(4);   // the DSP extends the chain
    expect([...chain[0].data]).toEqual([...tm.get(2, 'B').data]);
    tm.dispose();
  });

  it('keeps going when other work (reverb IRs) shares the generator', async () => {
    const generator = await createTerrainGenerator({ code: '', inlineSize: 32 });
    const store = createStore(defaultState());
    const st = store.serialize();
    st.parts.forEach((p, i) => { p.params.terrainA = i + 1; p.params.terrainB = i + 5; });
    store.load(st);
    const tm = createTerrainManager({ store, generator, post: () => {}, emit: () => {} });
    // An IR job queued behind the first terrain job used to leave the rest of the queue stranded.
    const ir = generator.run({ kind: 'ir', sampleRate: 8000, size: 0, damp: 0.5 });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('terrain queue stalled')), 3000));
    await Promise.race([Promise.all([tm.whenIdle(), ir]), timeout]);
    expect(tm.stats().generated).toBe(8);
    expect((await ir).left.length).toBeGreaterThan(0);
    tm.dispose();
  });

  it('runs a real generator on the main thread (no workers in Node) within the long-task budget', async () => {
    // warm the JIT first: the budget is about steady-state work, not V8 compiling the generators
    for (let i = 0; i < 13; i++) buildTerrainLevels(jobFor({ terrainA: i, detail: 1 }, null, 'A', 64));
    const generator = await createTerrainGenerator({ code: '', inlineSize: 256 });
    expect(generator.mode).toBe('inline');
    expect(generator.size).toBe(256);
    const store = createStore(defaultState());
    const st = store.serialize();
    st.parts.forEach((p, i) => { p.params.terrainA = [4, 6, 8, 9][i]; p.params.terrainB = [5, 7, 10, 12][i]; p.params.detail = 1; });
    store.load(st);
    let maxGap = 0, last = performance.now(), stop = false;
    const probe = async () => { while (!stop) { await sleep(0); const t = performance.now(); maxGap = Math.max(maxGap, t - last); last = t; } };
    const p = probe();
    const tm = createTerrainManager({ store, generator, post: () => {}, emit: () => {} });
    await tm.whenIdle();
    stop = true;
    await p;
    expect(tm.get(3, 'B').size).toBe(256);
    expect(generator.stats().jobs).toBe(8);
    // Generation and mip building are separate macrotasks, so the event loop
    // regains control between them. Absolute times depend on the machine and on
    // vitest's parallel workers; the browser e2e measures real long tasks.
    console.log('[inline terrain] max block ms', generator.stats().maxInlineBlockMs.toFixed(1), 'max event-loop gap ms', maxGap.toFixed(1));
    expect(generator.stats().maxInlineBlockMs).toBeLessThan(150);
    expect(maxGap).toBeLessThan(generator.stats().maxInlineBlockMs + 40);
  });
});
