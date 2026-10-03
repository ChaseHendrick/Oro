import { describe, it, expect } from 'vitest';
import {
  createVersionStore, createVersionScheduler, createVersions, memoryBackend, thinVersions, capVersions,
  externalize, internalize, diffSummary, hashString, INDEX_KEY, QUIET_MS, MAX_WAIT_MS,
} from '../../src/core/versions.js';
import { createStore } from '../../src/core/store.js';
import { createHistory } from '../../src/core/history.js';
import { defaultState } from '../../src/core/params.js';
import { groupByDay, dayLabel } from '../../src/ui/version-panel.js';

const DAY = 86400000;
function fakeTimers() {
  let t = 0, id = 0;
  const list = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms) { list.set(++id, { fn, at: t + ms }); return id; },
    clearTimeout(i) { list.delete(i); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...list.entries()].filter(([, e]) => e.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        list.delete(due[0]); t = due[1].at; due[1].fn();
      }
      t = end;
    },
  };
}

describe('version scheduling', () => {
  it('saves after two quiet minutes, or after ten minutes of changes, and on close', () => {
    const clock = fakeTimers();
    const saves = [];
    const s = createVersionScheduler({ save: (k) => saves.push([k, clock.now()]), timers: clock, now: clock.now });
    s.changed();
    clock.advance(QUIET_MS - 1000);
    expect(saves).toEqual([]);
    s.changed();                       // a new change restarts the quiet wait
    clock.advance(QUIET_MS - 1);
    expect(saves).toEqual([]);
    clock.advance(1);
    expect(saves).toEqual([['auto', 2 * QUIET_MS - 1000]]);
    clock.advance(10 * QUIET_MS);
    expect(saves).toHaveLength(1);     // nothing changed, nothing saved
    // continuous changes every 30 s: one version once they have gone on for ten minutes
    const start = clock.now();
    for (let i = 0; i <= 21; i++) { s.changed(); clock.advance(30000); }
    expect(saves[1]).toEqual(['auto', start + MAX_WAIT_MS]);
    s.changed();
    expect(s.pending()).toBe(true);
    s.flush('close');
    expect(saves[saves.length - 1][0]).toBe('close');
    expect(s.flush('close')).toBe(null);   // nothing pending
    s.pause(true);
    s.changed();
    expect(s.pending()).toBe(false);
  });
});

describe('retention', () => {
  const now = new Date(2026, 9, 3, 12).getTime();
  const v = (daysAgo, h = 0, name = '') => ({ id: `${daysAgo}-${h}`, time: now - daysAgo * DAY + h * 3600000, name, size: 10, blobs: [] });

  it('keeps 7 days in full, one a day for 60 days, and named versions', () => {
    const list = [v(90, 0, 'Demo'), v(70), v(30, -3), v(30, -1), v(30, -2), v(8, -5), v(8, -1), v(6, -2), v(6, -1), v(0)].sort((a, b) => a.time - b.time);
    const { keep, drop } = thinVersions(list, now);
    expect(keep.map(x => x.id)).toEqual(['90-0', '30--1', '8--1', '6--2', '6--1', '0-0']);
    expect(drop.map(x => x.id).sort()).toEqual(['30--2', '30--3', '70-0', '8--5'].sort());
  });

  it('drops the oldest unnamed versions first to fit the size cap, counting shared blobs once', () => {
    const list = [{ id: 'a', size: 100, blobs: ['x'], name: 'Keep' }, { id: 'b', size: 100, blobs: ['x'] }, { id: 'c', size: 100, blobs: ['x'] }, { id: 'd', size: 100, blobs: ['x'] }];
    const sizes = { x: 1000 };
    expect(capVersions(list, sizes, 1400).drop).toEqual([]);
    const r = capVersions(list, sizes, 1250);
    expect(r.drop.map(x => x.id)).toEqual(['b', 'c']);
    expect(capVersions(list, sizes, 10).keep.map(x => x.id)).toEqual(['a', 'd']);   // named and newest stay
  });
});

describe('version store', () => {
  const big = 'Q'.repeat(10000);
  const state = (tempo, extra = {}) => ({ global: { tempo, scaleRoot: 9, scaleType: 1 }, parts: [{ params: { cutoff: 0.5 }, noiseRecording: { data: big }, ...extra }] });

  it('shares large unchanged strings between versions by content hash', async () => {
    const backend = memoryBackend();
    let t = 1000;
    const store = createVersionStore({ backend, now: () => t });
    await store.ready;
    for (let i = 0; i < 100; i++) { t += 60000; await store.save(state(100 + i)); }
    expect(store.list()).toHaveLength(100);
    const blobKeys = [...backend.map.keys()].filter(k => k.includes('.b.'));
    expect(blobKeys).toHaveLength(1);
    expect(store.size()).toBeLessThan(100 * 300 + big.length + 1);
    // the same session again is not a new automatic version, a named save always is
    expect(await store.save(state(199))).toBe(null);
    const named = await store.save(state(199), { name: 'Chorus idea', kind: 'manual' });
    expect(named).toMatchObject({ name: 'Chorus idea', tracks: 1, tempo: 199, key: 'A Minor' });
    expect(await store.get(store.list()[5].id)).toEqual(state(105));
    // a new terrain adds one blob; deleting every version using it removes it
    t += 60000;
    const v2 = await store.save(state(120, { userTerrain: { A: { data: 'Z'.repeat(5000) } } }));
    expect([...backend.map.keys()].filter(k => k.includes('.b.'))).toHaveLength(2);
    await store.remove(v2.id);
    expect([...backend.map.keys()].filter(k => k.includes('.b.'))).toHaveLength(1);
    // the index survives a reload
    const again = createVersionStore({ backend, now: () => t });
    await again.ready;
    expect(again.list().map(x => x.id)).toEqual(store.list().map(x => x.id));
    expect(JSON.parse(backend.map.get(INDEX_KEY)).versions).toHaveLength(101);
  });

  it('applies the size cap when saving', async () => {
    const backend = memoryBackend();
    let t = 0;
    const store = createVersionStore({ backend, now: () => (t += 1000), cap: 3000 });
    for (let i = 0; i < 10; i++) await store.save({ global: { tempo: i, note: 'n'.repeat(900) }, parts: [] });
    expect(store.size()).toBeLessThanOrEqual(3000);
    expect(store.list().length).toBeLessThan(10);
    expect(store.list().at(-1).tempo).toBe(9);
    expect([...backend.map.keys()].filter(k => k.includes('.v.'))).toHaveLength(store.list().length);
  });

  it('externalizes and summarises changes', () => {
    const a = defaultState(), b = defaultState();
    b.parts[1].params.cutoff = 0.1;
    b.parts[2].patterns.push({ ...b.parts[2].patterns[0], id: 'p2' });
    b.parts[0].noiseRecording = { data: 'x'.repeat(5000) };
    const ea = externalize(a).obj, eb = externalize(b);
    expect(eb.blobs.size).toBe(1);
    expect(internalize(eb.obj, h => eb.blobs.get(h))).toEqual(b);
    expect(diffSummary(ea, eb.obj, 2)).toBe('Noise recording, track 1; Cutoff, track 2; and 1 more');
    b.parts[0].noiseRecording = a.parts[0].noiseRecording;
    expect(diffSummary(ea, externalize(b).obj)).toBe('Cutoff, track 2; new pattern on track 3');
    expect(diffSummary(null, ea)).toBe('First version');
    expect(diffSummary(ea, ea)).toBe('No changes');
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });
});

describe('preview, restore and go back', () => {
  async function setup() {
    const clock = fakeTimers();
    const store = createStore(defaultState());
    const history = createHistory(store, { timers: clock });
    const v = createVersions({ store, backend: memoryBackend(), timers: clock, now: () => clock.now() + 1e12 });
    await v.ready;
    return { clock, store, history, v };
  }

  it('previews temporarily, goes back, and restores undoably', async () => {
    const { clock, store, history, v } = await setup();
    store.set('global.tempo', 100);
    clock.advance(QUIET_MS);              // quiet: the automatic version
    await v.store.settled();
    expect(v.list()).toHaveLength(1);
    const first = v.list()[0];
    store.set('global.tempo', 150);
    clock.advance(1000);
    history.flush();
    await v.preview(first.id);
    expect(store.get('global.tempo')).toBe(100);
    expect(v.previewing.id).toBe(first.id);
    expect(v.list()).toHaveLength(2);     // the unsaved change was kept as a version first
    clock.advance(QUIET_MS * 2);
    await v.store.settled();
    expect(v.list()).toHaveLength(2);     // a preview is not an edit
    v.goBack();
    expect(store.get('global.tempo')).toBe(150);
    expect(v.previewing).toBe(null);
    expect(history.list().past.at(-1)).not.toBe('Restore version');

    await v.restore(first.id);
    expect(store.get('global.tempo')).toBe(100);
    history.flush();
    expect(history.list().past.at(-1)).toBe('Restore version');
    history.undo();
    expect(store.get('global.tempo')).toBe(150);

    // Keep this: the previewed version becomes the session, undo goes back
    store.set('global.tempo', 170);
    history.flush();
    await v.preview(first.id);
    await v.keep();
    expect(store.get('global.tempo')).toBe(100);
    history.flush();
    history.undo();
    expect(store.get('global.tempo')).toBe(170);
    expect(v.list().some(x => x.tempo === 170)).toBe(true);
  });

  it('leaves a preview when the app closes', async () => {
    const { store, v } = await setup();
    const saved = await v.saveNamed('Start');
    store.set('global.tempo', 133);
    await v.preview(saved.id);
    await v.close();
    expect(store.get('global.tempo')).toBe(133);
    expect(v.previewing).toBe(null);
  });

  it('groups by day for the panel', () => {
    const now = new Date(2026, 9, 3, 12).getTime();
    expect(dayLabel(now - 3600000, now)).toBe('Today');
    expect(dayLabel(now - DAY, now)).toBe('Yesterday');
    const g = groupByDay([{ time: now - 2 * DAY }, { time: now }, { time: now - 60000 }], now);
    expect(g.map(x => [x.label, x.items.length])).toEqual([['Today', 2], ['Yesterday', 0], [g[1].label, 1]].filter(x => x[1]));
  });
});
