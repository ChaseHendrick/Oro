import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createMusic } from '../../src/music/music.js';
import { createMidi, STORAGE_KEY, LEARNABLE_ACTIONS } from '../../src/midi/midi.js';
import { createFakeClock, createFakeEngine, createMemoryStorage } from '../music/fakes.js';
import { fakeInput, fakeOutput, fakeAccess, fakeNavigator } from './fake-midi.js';

async function setup(storage = createMemoryStorage()) {
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  const store = createStore(defaultState());
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  const input = fakeInput('in-1', 'Pads', 'Acme');
  const access = fakeAccess({ inputs: [input], outputs: [fakeOutput('out-1', 'Pads', 'Acme')] });
  const midi = await createMidi({ store, router: music.router, engine, transport: music.transport, navigator: fakeNavigator(access, { permission: 'granted' }), storage, secure: true, perfNow: clock.perfNow, timers: clock.timers });
  return { midi, input, clock, storage, store };
}

describe('MIDI learn for looper buttons', () => {
  it('lists the looper actions', () => {
    expect(LEARNABLE_ACTIONS).toContain('looper.main');
    expect(LEARNABLE_ACTIONS).toContain('looper.resample');
  });

  it('learns a CC for an action, fires on each press only, and persists', async () => {
    const { midi, input, clock, storage, store } = await setup();
    const fired = [];
    midi.on('action', (e) => fired.push(e.id));
    const p = midi.learn({ scope: 'action', id: 'looper.main' });
    input.fire([0xb0, 80, 127]);
    expect(await p).toEqual({ cc: 80, channel: 1, target: { scope: 'action', id: 'looper.main' } });
    expect(fired).toEqual([]);                       // the teaching press does nothing else
    input.fire([0xb0, 80, 0]);
    input.fire([0xb0, 80, 127]);
    input.fire([0xb0, 80, 127]);                     // held / repeated at once: one press
    input.fire([0xb0, 80, 0]);
    expect(fired).toEqual(['looper.main']);
    clock.advance(0.3);
    input.fire([0xb0, 80, 127]);
    expect(fired).toEqual(['looper.main', 'looper.main']);
    // Params are untouched and the mapping survives a reload.
    expect(store.get('global.tempo')).toBe(defaultState().global.tempo);
    expect(JSON.parse(storage.getItem(STORAGE_KEY)).mappings[0].target).toEqual({ scope: 'action', id: 'looper.main' });
    const again = await createMidi({ store, router: null, navigator: fakeNavigator(fakeAccess()), storage });
    expect(again.mappings()).toEqual([{ cc: 80, channel: 1, target: { scope: 'action', id: 'looper.main' } }]);
    midi.unmap({ scope: 'action', id: 'looper.main' });
    expect(midi.mappings()).toHaveLength(0);
  });

  it('refuses unknown actions', async () => {
    const { midi } = await setup();
    await expect(midi.learn({ scope: 'action', id: 'format.disk' })).rejects.toThrow();
  });
});
