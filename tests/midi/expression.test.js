// Aftertouch, MPE and learnable macros / global parameters.

import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState, GLOBAL_PARAM_MAP, fromNorm } from '../../src/core/params.js';
import { createMusic } from '../../src/music/music.js';
import { createMidi, MPE_BEND_RANGE, sanitizeSettings } from '../../src/midi/midi.js';
import { createFakeClock, createFakeEngine, createMemoryStorage } from '../music/fakes.js';
import { fakeInput, fakeOutput, fakeAccess, fakeNavigator } from './fake-midi.js';

async function setup({ engine: makeEngine, mpe = false } = {}) {
  const clock = createFakeClock({ startSec: 1 });
  const engine = makeEngine ? makeEngine(clock) : createFakeEngine(clock);
  const store = createStore(defaultState());
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  const input = fakeInput('in-1', 'Expressive Keys');
  const access = fakeAccess({ inputs: [input], outputs: [fakeOutput('out-1', 'Synth')] });
  const midi = await createMidi({ store, router: music.router, engine, transport: music.transport, navigator: fakeNavigator(access, { permission: 'granted' }), storage: createMemoryStorage(), secure: true, perfNow: clock.perfNow });
  if (mpe) midi.setSetting('mpe', true);
  return { clock, engine, store, music, midi, input };
}

/** An engine that also implements per-note bend. */
function noteBendEngine(clock) {
  const e = createFakeEngine(clock);
  e.noteBend = (part, note, semis) => e.events.push({ type: 'noteBend', part, note, semis });
  return e;
}

const bend14 = (v) => { const x = Math.round(8192 + v * 8191); return [x & 0x7f, x >> 7]; };

describe('aftertouch', () => {
  it('sends channel pressure to every voice of the target parts', async () => {
    const { input, engine, store } = await setup();
    store.set('ui.selectedPart', 2);
    input.fire([0xd0, 127]);
    input.fire([0xd0, 0]);
    expect(engine.of('pressure')).toEqual([{ type: 'pressure', part: 2, v: 1 }, { type: 'pressure', part: 2, v: 0 }]);
  });

  it('sends poly aftertouch to the held note, through the pad scale mapping', async () => {
    const { input, engine, midi, store } = await setup();
    midi.setSetting('padMode', 'scale');
    store.set('global.scaleRoot', 9);
    input.fire([0x90, 37, 100]);
    const note = engine.ons()[0].note;
    input.fire([0xa0, 37, 64]);
    expect(engine.of('pressure')).toEqual([{ type: 'pressure', part: 0, v: 64 / 127, note }]);
  });

  it('reaches every part in Layer mode', async () => {
    const { input, engine, store } = await setup();
    store.set('global.keyMode', 1);
    store.set('parts.3.params.mute', 1);
    input.fire([0xd0, 100]);
    expect(engine.of('pressure').map(e => e.part)).toEqual([0, 1, 2]);
  });

  it('is ignored safely by an engine without pressure support', async () => {
    const { input, engine } = await setup({ engine: (clock) => { const e = createFakeEngine(clock); delete e.pressure; delete e.slide; return e; } });
    expect(() => { input.fire([0xd0, 90]); input.fire([0xa0, 60, 90]); }).not.toThrow();
    input.fire([0x90, 60, 100]);
    expect(engine.ons()).toHaveLength(1);
  });
});

describe('MPE', () => {
  it('is off by default and validated as a boolean setting', async () => {
    const { midi } = await setup();
    expect(midi.getSettings().mpe).toBe(false);
    expect(sanitizeSettings({ mpe: 1 }).mpe).toBe(true);
    expect(sanitizeSettings({}).mpe).toBe(false);
  });

  it('plays member channels on the selected part with per-note bend, slide and pressure', async () => {
    const { input, engine, store } = await setup({ mpe: true, engine: noteBendEngine });
    store.set('ui.selectedPart', 1);
    // Channel 2: the starting bend and slide arrive before the note, as MPE controllers send them.
    input.fire([0xe1, ...bend14(0)]);
    input.fire([0xb1, 74, 64]);
    input.fire([0x91, 60, 100]);
    // Channel 3: a second note.
    input.fire([0x92, 64, 90]);
    expect(engine.ons().map(e => [e.part, e.note])).toEqual([[1, 60], [1, 64]]);
    expect(engine.of('slide')).toEqual([{ type: 'slide', part: 1, v: 64 / 127, note: 60 }]);
    engine.clear();
    // Bend only the first note up a whole tone: 2 / 48 of the range.
    input.fire([0xe1, ...bend14(2 / MPE_BEND_RANGE)]);
    const nb = engine.of('noteBend');
    expect(nb).toHaveLength(1);
    expect(nb[0]).toMatchObject({ part: 1, note: 60 });
    expect(nb[0].semis).toBeCloseTo(2, 1);
    input.fire([0xd2, 100]);   // pressure on channel 3 = the second note
    input.fire([0xb2, 74, 20]); // slide on channel 3
    expect(engine.of('pressure')).toEqual([{ type: 'pressure', part: 1, v: 100 / 127, note: 64 }]);
    expect(engine.of('slide')).toEqual([{ type: 'slide', part: 1, v: 20 / 127, note: 64 }]);
    expect(engine.of('bend')).toHaveLength(0);
    input.fire([0x81, 60, 0]);
    input.fire([0x82, 64, 0]);
    expect(engine.offs().map(e => e.note)).toEqual([60, 64]);
  });

  it('uses the master channel for zone-wide bend, pressure and slide', async () => {
    const { input, engine } = await setup({ mpe: true, engine: noteBendEngine });
    input.fire([0x91, 60, 100]);
    engine.clear();
    input.fire([0xe0, ...bend14(1)]);
    input.fire([0xd0, 50]);
    input.fire([0xb0, 74, 127]);
    expect(engine.of('bend')).toHaveLength(1);
    expect(engine.of('bend')[0].v).toBeCloseTo(1, 3);
    expect(engine.of('pressure')).toEqual([{ type: 'pressure', part: 0, v: 50 / 127 }]);
    expect(engine.of('slide')).toEqual([{ type: 'slide', part: 0, v: 1 }]);
    expect(engine.of('noteBend')).toHaveLength(0);
  });

  it('honours a member bend range set with RPN 0', async () => {
    const { input, engine } = await setup({ mpe: true, engine: noteBendEngine });
    for (const [cc, v] of [[101, 0], [100, 0], [6, 24]]) input.fire([0xb1, cc, v]);
    input.fire([0x91, 62, 100]);
    engine.clear();
    input.fire([0xe1, ...bend14(0.5)]);
    expect(engine.of('noteBend')[0].semis).toBeCloseTo(12, 1);
  });

  it('falls back to the part bend scaled into its bend range without per-note bend', async () => {
    const { input, engine, store } = await setup({ mpe: true });
    store.set('parts.0.params.bendRange', 12);
    input.fire([0x91, 60, 100]);
    engine.clear();
    input.fire([0xe1, ...bend14(6 / 48)]);
    const b = engine.of('bend');
    expect(b).toHaveLength(1);
    expect(b[0].v).toBeCloseTo(0.5, 2);
  });

  it('never learns or maps the MPE expression controllers', async () => {
    const { input, midi, store } = await setup({ mpe: true });
    const p = midi.learn({ scope: 'global', id: 'macro1' });
    input.fire([0xb1, 74, 90]);    // slide on a member channel
    input.fire([0xb0, 101, 0]);    // RPN select on the master channel
    expect(midi.isLearning()).toBe(true);
    input.fire([0xb0, 21, 127]);
    const m = await p;
    expect(m).toMatchObject({ cc: 21, channel: 1, target: { scope: 'global', id: 'macro1' } });
    expect(store.get('global.macro1')).toBe(1);
  });

  it('switching MPE off restores ordinary channel handling', async () => {
    const { input, engine, midi } = await setup({ mpe: true });
    midi.setSetting('mpe', false);
    input.fire([0x91, 60, 100]);
    input.fire([0xe1, ...bend14(1)]);
    expect(engine.of('bend')).toHaveLength(1);
    expect(engine.of('bend')[0].v).toBeCloseTo(1, 3);
  });
});

describe('learnable macros and global parameters', () => {
  it('learns each macro and drives it from a CC', async () => {
    const { input, midi, store } = await setup();
    for (let i = 1; i <= 4; i++) {
      const p = midi.learn({ scope: 'global', part: null, id: `macro${i}` });
      input.fire([0xb0, 20 + i, 64]);
      expect(await p).toMatchObject({ cc: 20 + i, target: { scope: 'global', id: `macro${i}` } });
    }
    input.fire([0xb0, 23, 127]);
    expect(store.get('global.macro3')).toBe(1);
    expect(store.get('global.macro1')).toBeCloseTo(64 / 127, 9);
    expect(midi.mappings().filter(m => m.target.scope === 'global')).toHaveLength(4);
  });

  it('learns any global parameter through its own curve', async () => {
    const { input, midi, store } = await setup();
    for (const id of ['ceiling', 'swing', 'reverbLevel', 'scaleRoot']) {
      const p = midi.learn(`global.${id}`);
      input.fire([0xb0, 40, 0]);
      await p;
      input.fire([0xb0, 40, 100]);
      expect(store.get(`global.${id}`)).toBeCloseTo(fromNorm(GLOBAL_PARAM_MAP[id], 100 / 127), 9);
      midi.unmap({ scope: 'global', id });
    }
  });
});
