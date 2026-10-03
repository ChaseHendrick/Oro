import { describe, it, expect } from 'vitest';
import { createStoreSync } from '../../src/audio/sync.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { defaultTrackFx, defaultFxSlot } from '../../src/dsp/track-fx-config.js';
import { encodeNoiseRecording } from '../../src/dsp/noise-recording.js';
function setup(sampleRate = 48000) {
  const store = createStore(defaultState()), batches = [];
  let queued = null;
  const sync = createStoreSync({ store, post: messages => batches.push(messages), defer: fn => { queued = fn; }, sampleRate: () => sampleRate });
  return { store, sync, batches, run: () => { queued?.(); queued = null; } };
}
describe('persisted rack and recorded noise forwarding', () => {
  it('includes four bypass slots and empty recorded noise for fresh live and bounce DSP snapshots', () => {
    const { store, sync } = setup();
    const snapshots = sync.snapshot(false), n = store.get('parts').length;
    expect(snapshots.filter(m => m.t === 'trackFx')).toHaveLength(n);
    expect(snapshots.filter(m => m.t === 'noiseRecording')).toHaveLength(n);
    expect(snapshots.find(m => m.t === 'trackFx')).toMatchObject({ part: 0, sidechainIndex: -1, fx: defaultTrackFx() });
    expect(snapshots.find(m => m.t === 'noiseRecording').data).toEqual(new Float32Array(0));
  });
  it('coalesces rack changes, sends clean copies and resolves stable sidechain track IDs', () => {
    const { store, batches, run, sync } = setup(), fx = defaultTrackFx();
    fx.sidechain = store.get('parts.2.id'); fx.slots[1] = { ...defaultFxSlot('duck'), p1: 1.5 };
    store.set('parts.0.trackFx', fx); store.set('parts.0.trackFx.routing', 4); run();
    expect(batches[0]).toHaveLength(1); expect(batches[0][0]).toMatchObject({ t: 'trackFx', part: 0, sidechainIndex: 2, fx: { routing: 4 } });
    expect(batches[0][0].fx.slots[1].p1).toBe(1); expect(batches[0][0].fx.slots).not.toBe(fx.slots);
    expect(sync.snapshot().find(m => m.t === 'trackFx' && m.part === 0).sidechainIndex).toBe(2);
    store.set('parts.0.trackFx.sidechain', 'mix'); run(); expect(batches[1][0].sidechainIndex).toBe(-2);
  });
  it('keeps the sidechain attached to its source when tracks reorder or disappear', () => {
    const { store, batches, run } = setup(), fx = defaultTrackFx(), parts = store.get('parts');
    fx.sidechain = parts[2].id; store.set('parts.0.trackFx', fx); run();
    store.set('parts', [parts[2], parts[0], parts[1], ...parts.slice(3)]); run();
    const updates = batches.flat().filter(m => m.t === 'trackFx'); expect(updates.at(-store.get('parts').length + 1)).toMatchObject({ part: 1, sidechainIndex: 0 });
    store.set('parts', store.get('parts').slice(1)); run();
    expect(batches.at(-1).find(m => m.t === 'trackFx' && m.part === 0).sidechainIndex).toBe(-1);
  });
  it('decodes recorded noise at the target rate only when noise or whole-part state changes', () => {
    const { store, sync, batches, run } = setup(48000), input = new Float32Array(800).map((_, i) => Math.sin(i / 10) * .5);
    store.set('parts.1.noiseRecording', encodeNoiseRecording(input, 8000, 'Fixture')); run();
    expect(batches[0][0]).toMatchObject({ t: 'noiseRecording', part: 1 }); expect(batches[0][0].data.length).toBe(4800);
    store.set('parts.1.params.cutoff', 1700); run(); expect(batches[1].some(m => m.t === 'noiseRecording')).toBe(false);
    expect(sync.snapshot().find(m => m.t === 'noiseRecording' && m.part === 1).data.length).toBe(4800);
    store.set('parts.1.noiseRecording', null); run(); expect(batches[2][0].data.length).toBe(0);
  });
});
