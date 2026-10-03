import { describe, it, expect } from 'vitest';
import { importNoiseRecording } from '../../src/audio/noise-import.js';
import { decodeNoiseRecording } from '../../src/dsp/noise-recording.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { moveTrack, removeTrack, addTrack, REPLACE_TRACKS } from '../../src/core/tracks.js';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function setup() {
  const store = createStore(defaultState()), decode = deferred(), started = deferred();
  const samples = new Float32Array([.25, -.5, .75, 0]);
  const buffer = { length: samples.length, numberOfChannels: 1, getChannelData: () => samples };
  const context = { sampleRate: 8000, decodeAudioData: () => { started.resolve(); return decode.promise; } };
  const file = { name: 'Slow.wav', size: 4, arrayBuffer: async () => new ArrayBuffer(4) };
  return { store, context, file, started, complete: () => decode.resolve(buffer) };
}

describe('recorded-noise import track identity', () => {
  it('follows the original track when it moves during audio decode', async () => {
    const { store, context, file, started, complete } = setup(), id = store.get('parts.1.id');
    const pending = importNoiseRecording(store, context, 1, file);
    await started.promise; moveTrack(store, 1, 3); complete();
    const recording = await pending, at = store.get('parts').findIndex(track => track.id === id);
    expect(at).toBe(3); expect(store.get(`parts.${at}.noiseRecording`)).toBe(recording);
    expect(store.get(`parts.${at}.params.airType`)).toBe(8);
    expect(store.get('parts.1.noiseRecording')).toBeNull();
    const decoded = decodeNoiseRecording(recording);
    expect(decoded).toHaveLength(4);
    [.25, -.5, .75, 0].forEach((value, i) => expect(decoded[i]).toBeCloseTo(value, 4));
  });
  it('rejects a removed destination and leaves the track shifted into its old position unchanged', async () => {
    const { store, context, file, started, complete } = setup();
    const pending = importNoiseRecording(store, context, 1, file), rejected = expect(pending).rejects.toThrow('removed or replaced');
    await started.promise; removeTrack(store, 1); complete(); await rejected;
    for (const track of store.get('parts')) { expect(track.noiseRecording).toBeNull(); expect(track.params.airType).toBe(0); }
  });
  it('stays cancelled if a removed track ID is reused before decode completes', async () => {
    const { store, context, file, started, complete } = setup(), old = store.get('parts.3');
    const pending = importNoiseRecording(store, context, 3, file), rejected = expect(pending).rejects.toThrow('removed or replaced');
    await started.promise; store.batch(() => { removeTrack(store, 3); addTrack(store, { part: old }); }); complete(); await rejected;
    expect(store.get('parts.3.id')).toBe(old.id); expect(store.get('parts.3.noiseRecording')).toBeNull();
  });
  it('rejects a scene replacement even if it contains the same track IDs', async () => {
    const { store, context, file, started, complete } = setup();
    const pending = importNoiseRecording(store, context, 1, file), rejected = expect(pending).rejects.toThrow('removed or replaced');
    await started.promise; store.set('parts', defaultState().parts, { [REPLACE_TRACKS]: true }); complete(); await rejected;
    expect(store.get('parts.1.noiseRecording')).toBeNull();
  });
});
