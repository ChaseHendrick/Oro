import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createMusic } from '../../src/music/music.js';
import { createMidi } from '../../src/midi/midi.js';
import { createFakeClock, createFakeEngine, createMemoryStorage } from '../music/fakes.js';
import { fakeInput, fakeAccess, fakeNavigator } from './fake-midi.js';
async function setup() {
  const clock = createFakeClock({ startSec: 1 }), engine = createFakeEngine(clock), store = createStore(defaultState());
  engine.controlSource = (part, source, v) => engine.events.push({ type: 'controlSource', part, source, v });
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow }), input = fakeInput('controller', 'Keys');
  const midi = await createMidi({ store, engine, router: music.router, transport: music.transport, storage: createMemoryStorage(), navigator: fakeNavigator(fakeAccess({ inputs: [input] }), { permission: 'granted' }), secure: true, perfNow: clock.perfNow });
  return { store, engine, midi, music, input };
}
describe('common MIDI controllers as modulation sources', () => {
  it('sends CC2 breath, CC11 expression and continuous CC64 sustain to the selected track', async () => {
    const { store, engine, input, music } = await setup(); store.set('ui.selectedPart', 2);
    input.fire([0xb0, 2, 32]); input.fire([0xb0, 11, 96]); input.fire([0xb0, 64, 60]);
    expect(engine.of('controlSource')).toEqual([
      { type: 'controlSource', part: 2, source: 'breath', v: 32 / 127 },
      { type: 'controlSource', part: 2, source: 'expression', v: 96 / 127 },
      { type: 'controlSource', part: 2, source: 'sustainLevel', v: 60 / 127 },
    ]); music.dispose();
  });
  it.each([[2, 'breath'], [11, 'expression'], [64, 'sustainLevel']])('keeps CC%d source data working while the CC learns and controls a knob', async (cc, source) => {
    const { store, engine, input, midi, music } = await setup(), learned = midi.learn({ scope: 'global', id: 'macro1' });
    input.fire([0xb0, cc, 80]); await learned; expect(store.get('global.macro1')).toBeCloseTo(80 / 127);
    expect(engine.of('controlSource').at(-1)).toEqual({ type: 'controlSource', part: 0, source, v: 80 / 127 });
    input.fire([0xb0, cc, 20]); expect(store.get('global.macro1')).toBeCloseTo(20 / 127);
    expect(engine.of('controlSource').at(-1)).toEqual({ type: 'controlSource', part: 0, source, v: 20 / 127 }); music.dispose();
  });
  it('retains ordinary sustain note release and resets all three sources with CC121', async () => {
    const { input, engine, music } = await setup();
    input.fire([0x90, 60, 100]); input.fire([0xb0, 64, 127]); input.fire([0x80, 60, 0]);
    expect(engine.offs()).toHaveLength(0);
    input.fire([0xb0, 2, 110]); input.fire([0xb0, 11, 75]); engine.clear(); input.fire([0xb0, 121, 0]);
    expect(engine.of('controlSource')).toEqual(['expression', 'sustainLevel', 'breath'].map(source => ({ type: 'controlSource', part: 0, source, v: 0 })));
    expect(engine.offs()).toHaveLength(1); music.dispose();
  });
  it('reaches every unmuted Layer track and only the channel targets in multitimbral mode', async () => {
    const { input, engine, store, midi, music } = await setup(); store.set('global.keyMode', 1); store.set('parts.2.params.mute', 1);
    input.fire([0xb0, 11, 100]); expect(engine.of('controlSource').map(event => event.part)).toEqual([0, 1, 3]);
    engine.clear(); midi.setSetting('channelMode', 'multi'); midi.setSetting('multiChannels', [1, 2, 3, 2]);
    input.fire([0xb1, 2, 90]); expect(engine.of('controlSource').map(event => event.part)).toEqual([1, 3]); music.dispose();
  });
});
