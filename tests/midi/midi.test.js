import { describe, it, expect, beforeEach } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState, MAX_PARTS, PART_PARAM_MAP, GLOBAL_PARAM_MAP, fromNorm, stepToMidi } from '../../src/core/params.js';
import { createMusic } from '../../src/music/music.js';
import { createMidi, STORAGE_KEY, applyVelocityCurve } from '../../src/midi/midi.js';
import { detectMpcPort, portStem, MPC_GUIDE } from '../../src/midi/mpc.js';
import { createClockFollower } from '../../src/midi/clock.js';
import { makeRng } from '../../src/music/patterns.js';
import { addTrack, moveTrack } from '../../src/core/tracks.js';
import { createFakeClock, createFakeEngine, createMemoryStorage } from '../music/fakes.js';
import { fakeInput, fakeOutput, fakeAccess, fakeNavigator } from './fake-midi.js';

async function setup({ inputs, outputs, storage = createMemoryStorage(), permission = 'granted', tempo = 120, presets = null } = {}) {
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  const state = defaultState();
  state.global.tempo = tempo;
  const store = createStore(state);
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  const mpcIn = fakeInput('in-1', 'MPC XL MIDI 1', 'Akai');
  const mpcOut = fakeOutput('out-1', 'MPC XL MIDI 1', 'Akai');
  const access = fakeAccess({ inputs: inputs || [mpcIn], outputs: outputs || [mpcOut, fakeOutput('out-2', 'MPC XL MIDI 2', 'Akai')] });
  const nav = fakeNavigator(access, { permission });
  const midi = await createMidi({ store, router: music.router, engine, transport: music.transport, presets, navigator: nav, storage, secure: true, perfNow: clock.perfNow, timers: clock.timers });
  return { clock, engine, store, music, midi, access, nav, mpcIn, mpcOut, storage };
}

describe('MPC port detection', () => {
  const ports = (...names) => names.map((name, i) => ({ id: String(i), name, state: 'connected' }));
  it('uses the only MPC port', () => {
    expect(detectMpcPort(ports('IAC Driver Bus 1', 'MPC MIDI 1 & 2')).name).toBe('MPC MIDI 1 & 2');
  });
  it('picks port 1 among ports of the same MPC', () => {
    expect(detectMpcPort(ports('MPC XL MIDI 2', 'MPC XL MIDI 1', 'MPC XL MIDI 3')).name).toBe('MPC XL MIDI 1');
    expect(detectMpcPort(ports('MPC XL Port 2', 'MPC XL Port 1')).name).toBe('MPC XL Port 1');
    expect(detectMpcPort(ports('MPC XL MIDI One', 'MPC XL MIDI 2')).name).toBe('MPC XL MIDI One');
  });
  it('asks the user when the choice is unclear and never picks other gear', () => {
    expect(detectMpcPort(ports('MPC XL', 'MIDIIN2 (MPC XL)'))).toBeNull();
    expect(detectMpcPort(ports('MPC One MIDI 1', 'MPC XL MIDI 1'))).toBeNull();
    expect(detectMpcPort(ports('Arturia KeyStep', 'Launchpad'))).toBeNull();
    expect(detectMpcPort([])).toBeNull();
  });
  it('computes stems as specified', () => {
    expect(portStem('MPC XL MIDI 12')).toBe('mpcxl');
    expect(portStem('MPC XL Port 3')).toBe('mpcxl');
    expect(portStem('MPC MIDI 1 & 2')).toBe('mpcmidi1&2');
  });
  it('ships a complete setup guide', () => {
    expect(MPC_GUIDE.map(s => s.title)).toEqual([
      'Connect', 'Play Orograph from the MPC pads', 'Twist Q-Links to control Orograph',
      'Play the MPC from Orograph', 'Sync tempo', 'Troubleshooting',
    ]);
    const text = JSON.stringify(MPC_GUIDE);
    expect(text).not.toMatch(/\u2014/); // no em dashes in user-facing copy
    for (const s of MPC_GUIDE) expect(s.steps.length).toBeGreaterThan(0);
  });
});

describe('access and status', () => {
  it('reports unsupported without throwing', async () => {
    const store = createStore(defaultState());
    const midi = await createMidi({ store, router: null, navigator: {}, storage: null });
    expect(midi.supported).toBe(false);
    expect(midi.status).toBe('unsupported');
    await midi.connect();
    expect(midi.inputs()).toEqual([]);
    expect(midi.statusText()).toMatch(/Chrome/);
  });

  it('reports denied permission', async () => {
    const store = createStore(defaultState());
    const err = new Error('nope'); err.name = 'SecurityError';
    const nav = fakeNavigator(fakeAccess(), { reject: err });
    const midi = await createMidi({ store, router: null, navigator: nav, storage: null });
    expect(midi.status).toBe('idle');
    await midi.connect();
    expect(midi.status).toBe('denied');
  });

  it('auto-connects only when permission is already granted, without sysex', async () => {
    const a = await setup({ permission: 'prompt' });
    expect(a.midi.status).toBe('idle');
    expect(a.nav.calls).toHaveLength(0);
    const b = await setup({ permission: 'granted' });
    expect(b.midi.status).toBe('ready');
    expect(b.nav.calls).toEqual([{ sysex: false }]);
  });

  it('lists ports and auto-selects the MPC output', async () => {
    const { midi } = await setup();
    expect(midi.inputs()).toEqual([{ id: 'in-1', name: 'MPC XL MIDI 1', manufacturer: 'Akai', state: 'connected', enabled: true, isMpc: true }]);
    expect(midi.outputs()).toHaveLength(2);
    expect(midi.getSettings().outputId).toBe('out-1');
    expect(midi.getSettings().outputAuto).toBe(true);
  });
});

describe('input routing', () => {
  it('omni mode plays the selected part with the velocity curve', async () => {
    const { midi, mpcIn, engine, store } = await setup();
    store.set('ui.selectedPart', 1);
    mpcIn.fire([0x93, 60, 64]);
    expect(engine.ons()).toEqual([{ type: 'on', part: 1, note: 60, vel: 64 / 127, time: 0 }]);
    mpcIn.fire([0x93, 60, 0]); // velocity 0 = note off
    expect(engine.offs()).toHaveLength(1);
    midi.setSetting('velocityCurve', 'soft');
    mpcIn.fire([0x90, 62, 64]);
    expect(engine.ons()[1].vel).toBeCloseTo(applyVelocityCurve(64 / 127, 'soft'), 9);
    expect(applyVelocityCurve(0.5, 'soft')).toBeGreaterThan(0.5);
    expect(applyVelocityCurve(0.5, 'hard')).toBeLessThan(0.5);
  });

  it('multi mode routes channels to parts', async () => {
    const { midi, mpcIn, engine } = await setup();
    midi.setSetting('channelMode', 'multi');
    midi.setSetting('multiChannels', [1, 2, 10, 4]);
    mpcIn.fire([0x99, 36, 100]); // channel 10
    mpcIn.fire([0x91, 40, 100]); // channel 2
    mpcIn.fire([0x95, 40, 100]); // channel 6: nobody listens
    expect(engine.ons().map(e => e.part)).toEqual([2, 1]);
    mpcIn.fire([0x89, 36, 0]);
    expect(engine.offs().map(e => e.part)).toEqual([2]);
  });

  it('omni target can be a fixed part', async () => {
    const { midi, mpcIn, engine } = await setup();
    midi.setSetting('omniTarget', 3);
    mpcIn.fire([0x90, 50, 100]);
    expect(engine.ons()[0].part).toBe(3);
  });

  it('scale pad mode maps pads to scale degrees of the global key', async () => {
    const { midi, mpcIn, engine, store } = await setup();
    midi.setSetting('padMode', 'scale');
    store.set('global.scaleRoot', 9); // A
    store.set('global.scaleType', 1); // minor
    const expected = (deg) => stepToMidi({ degree: deg, octave: 0 }, 2, 9, 1);
    mpcIn.fire([0x90, 36, 100]);
    mpcIn.fire([0x90, 37, 100]);
    mpcIn.fire([0x90, 43, 100]);
    expect(engine.ons().map(e => e.note)).toEqual([45, expected(1), expected(7)]);
    expect(expected(7)).toBe(57);
    // key change while held: the note-off still releases the original note
    store.set('global.scaleRoot', 0);
    mpcIn.fire([0x80, 37, 0]);
    expect(engine.offs()[0].note).toBe(expected(1));
  });

  it('learns the pad base note from the next pad hit', async () => {
    const { midi, mpcIn } = await setup();
    const p = midi.learnPadBase();
    mpcIn.fire([0x90, 37, 90]);
    expect(await p).toBe(37);
    expect(midi.getSettings().padBaseNote).toBe(37);
  });

  it('handles mod wheel, pitch bend, sustain and all notes off', async () => {
    const { mpcIn, engine } = await setup();
    mpcIn.fire([0xb0, 1, 127]);
    mpcIn.fire([0xe0, 0, 0]);
    mpcIn.fire([0xe0, 0, 64]);
    expect(engine.events.filter(e => e.type === 'wheel')).toEqual([{ type: 'wheel', part: 0, v: 1 }]);
    expect(engine.events.filter(e => e.type === 'bend').map(e => e.v)).toEqual([-1, 0]);
    mpcIn.fire([0xb0, 64, 127]);
    mpcIn.fire([0x90, 60, 100]);
    mpcIn.fire([0x80, 60, 0]);
    expect(engine.offs()).toHaveLength(0);
    mpcIn.fire([0xb0, 64, 0]);
    expect(engine.offs()).toHaveLength(1);
    mpcIn.fire([0x90, 61, 100]);
    mpcIn.fire([0xb0, 123, 0]);
    expect(engine.events.some(e => e.type === 'allOff')).toBe(true);
  });

  it('program change loads a patch when enabled', async () => {
    const loaded = [];
    const presets = { patches: () => [{ id: 'a' }, { id: 'b' }], loadPatch: (p, id) => loaded.push([p, id]) };
    const { midi, mpcIn } = await setup({ presets });
    mpcIn.fire([0xc0, 1]);
    expect(loaded).toEqual([]);
    midi.setSetting('programChange', true);
    mpcIn.fire([0xc0, 1]);
    mpcIn.fire([0xc0, 9]);
    expect(loaded).toEqual([[0, 'b']]);
  });

  it('emits activity for LEDs and can disable an input', async () => {
    const { midi, mpcIn, engine } = await setup();
    const acts = [];
    midi.on('activity', a => acts.push(a));
    mpcIn.fire([0x90, 60, 100]);
    expect(acts[0]).toEqual({ dir: 'in', kind: 'note', port: 'MPC XL MIDI 1' });
    midi.setInputEnabled('in-1', false);
    mpcIn.fire([0x90, 61, 100]);
    expect(engine.ons()).toHaveLength(1);
    expect(engine.offs()).toHaveLength(1); // held note released when the input was switched off
    expect(midi.inputs()[0].enabled).toBe(false);
  });
});

describe('MIDI learn', () => {
  it('binds the next CC and scales it through the knob curve', async () => {
    const { midi, mpcIn, store, storage } = await setup();
    const learned = [];
    midi.on('learn', e => learned.push(e));
    const p = midi.learn({ scope: 'part', part: 'sel', id: 'cutoff' });
    expect(midi.isLearning()).toBe(true);
    mpcIn.fire([0xb2, 21, 0]);
    const mapping = await p;
    expect(mapping).toEqual({ cc: 21, channel: 3, target: { scope: 'part', part: 'sel', id: 'cutoff' } });
    expect(learned).toHaveLength(1);
    mpcIn.fire([0xb2, 21, 127]);
    expect(store.get('parts.0.params.cutoff')).toBeCloseTo(PART_PARAM_MAP.cutoff.max, 6);
    // 'sel' resolves at message time
    store.set('ui.selectedPart', 2);
    mpcIn.fire([0xb2, 21, 64]);
    expect(store.get('parts.2.params.cutoff')).toBeCloseTo(fromNorm(PART_PARAM_MAP.cutoff, 64 / 127), 6);
    expect(store.get('parts.0.params.cutoff')).toBeCloseTo(PART_PARAM_MAP.cutoff.max, 6);
    // a CC on another channel is not this mapping
    mpcIn.fire([0xb5, 21, 0]);
    expect(store.get('parts.2.params.cutoff')).toBeCloseTo(fromNorm(PART_PARAM_MAP.cutoff, 64 / 127), 6);
    // persisted
    expect(JSON.parse(storage.getItem(STORAGE_KEY)).mappings).toHaveLength(1);
  });

  it('maps global targets, replaces duplicates, unmaps and survives reload', async () => {
    const { midi, mpcIn, store, storage } = await setup();
    let p = midi.learn({ scope: 'global', id: 'tempo' });
    mpcIn.fire([0xb0, 30, 0]);
    await p;
    mpcIn.fire([0xb0, 30, 127]);
    expect(store.get('global.tempo')).toBe(GLOBAL_PARAM_MAP.tempo.max);
    p = midi.learn({ scope: 'part', part: 1, id: 'morph' });
    mpcIn.fire([0xb0, 30, 10]); // same CC now goes to morph only
    await p;
    expect(midi.mappings()).toEqual([{ cc: 30, channel: 1, target: { scope: 'part', part: 1, id: 'morph' } }]);
    const again = await createMidi({ store, router: null, navigator: fakeNavigator(fakeAccess()), storage });
    expect(again.mappings()).toHaveLength(1);
    midi.unmap(30);
    expect(midi.mappings()).toHaveLength(0);
  });

  it('ignores channel mode CCs while learning and can be cancelled', async () => {
    const { midi, mpcIn } = await setup();
    const p = midi.learn({ scope: 'part', part: 'sel', id: 'warp' });
    mpcIn.fire([0xb0, 123, 0]);
    expect(midi.isLearning()).toBe(true);
    midi.cancelLearn();
    expect(await p).toBeNull();
    await expect(midi.learn({ scope: 'part', id: 'nope' })).rejects.toThrow();
  });

  it('accepts store paths and the older call shapes', async () => {
    const { midi, mpcIn, store } = await setup();
    const p = midi.learn('parts.2.params.warp');
    mpcIn.fire([0xb0, 40, 127]);
    expect(await p).toMatchObject({ cc: 40, target: { scope: 'part', part: 2, id: 'warp' } });
    expect(store.get('parts.2.params.warp')).toBe(1);
    const g = midi.learn('global.swing');
    mpcIn.fire([0xb0, 41, 0]);
    expect((await g).target).toEqual({ scope: 'global', id: 'swing' });
    midi.setChannelMode('multi');
    expect(midi.getSettings().channelMode).toBe('multi');
    midi.setInput('nope');
    expect(midi.inputs()[0].enabled).toBe(false);
    midi.setInput('all');
    expect(midi.inputs()[0].enabled).toBe(true);
  });

  it('suggests 16 Q-Link targets', async () => {
    const { midi } = await setup();
    const t = midi.qlinkTargets();
    expect(t).toHaveLength(16);
    expect(t[0]).toEqual({ scope: 'part', part: 'sel', id: 'centerX', label: 'Dot X' });
    expect(t.map(x => x.id)).toContain('delaySend');
  });
});

describe('clock in', () => {
  it('estimates a jittery 120 bpm clock to within 0.3 bpm', () => {
    const f = createClockFollower();
    const rng = makeRng(5);
    const spt = 500 / 24;
    let bpm = 0;
    for (let i = 0; i < 96; i++) bpm = f.pulse(1000 + i * spt + (rng() - 0.5) * 4).bpm;
    expect(Math.abs(bpm - 120)).toBeLessThan(0.3);
    expect(Math.abs(f.displayBpm() - 120)).toBeLessThan(0.3);
  });

  it('smooths the pulse times it reports', () => {
    const f = createClockFollower();
    const rng = makeRng(9);
    const spt = 500 / 24;
    let worstRaw = 0, worstFit = 0;
    for (let i = 0; i < 200; i++) {
      const ideal = 1000 + i * spt;
      const raw = ideal + (rng() - 0.5) * 4;
      const { time } = f.pulse(raw);
      if (i > 60) { worstRaw = Math.max(worstRaw, Math.abs(raw - ideal)); worstFit = Math.max(worstFit, Math.abs(time - ideal)); }
    }
    expect(worstFit).toBeLessThan(worstRaw);
    expect(worstFit).toBeLessThan(1);
  });

  it('follows a tempo change within about a beat', () => {
    const f = createClockFollower();
    let t = 0;
    for (let i = 0; i < 96; i++) { t += 500 / 24; f.pulse(t); }
    let bpm = 0;
    for (let i = 0; i < 24; i++) { t += (60000 / 90) / 24; bpm = f.pulse(t).bpm; }
    expect(Math.abs(bpm - 90)).toBeLessThan(0.5);
  });

  it('tracks Start, Song Position and Continue', () => {
    const f = createClockFollower();
    f.start();
    expect(f.pulse(0).beat).toBe(0);
    expect(f.pulse(20).beat).toBeCloseTo(1 / 24, 9);
    f.stop();
    f.songPosition(8); // 8 sixteenths = beat 2
    f.continue();
    expect(f.pulse(40).beat).toBe(2);
  });

  it('drives the transport from an MPC in follow mode', async () => {
    const { midi, mpcIn, music, clock, store, engine } = await setup({ tempo: 90 });
    const seq = store.get('parts.0.patterns.0');
    store.set('parts.0.seqOn', 1);
    seq.steps.forEach(s => { s.on = 1; });
    store.set('parts.0.patterns.0', seq);
    midi.setSetting('followClock', true);
    expect(music.transport.isFollowing()).toBe(true);
    const clocks = [];
    midi.on('clock', c => clocks.push(c));
    mpcIn.fire([0xfa], clock.perfNow());
    expect(music.transport.isPlaying()).toBe(true);
    const spt = 0.5 / 24;
    for (let i = 0; i < 24 * 4; i++) {
      clock.advance(spt, 0.004);
      mpcIn.fire([0xf8], clock.perfNow());
    }
    expect(midi.externalClock.active).toBe(true);
    expect(Math.abs(midi.externalClock.bpm - 120)).toBeLessThan(0.5);
    expect(store.get('global.tempo')).toBe(120);
    expect(clocks.at(-1).running).toBe(true);
    const ons = engine.ons(0);
    expect(ons.length).toBeGreaterThanOrEqual(14);
    for (let i = 1; i < ons.length; i++) expect(ons[i].time - ons[i - 1].time).toBeCloseTo(0.125, 2);
    mpcIn.fire([0xfc], clock.perfNow());
    expect(music.transport.isPlaying()).toBe(false);
  });

  it('announces when the clock stops arriving, so the EXT badge can go (regression)', async () => {
    const { midi, mpcIn, clock } = await setup({ tempo: 90 });
    midi.setSetting('followClock', true);
    const clocks = [];
    midi.on('clock', c => clocks.push(c));
    mpcIn.fire([0xfa], clock.perfNow());
    for (let i = 0; i < 48; i++) { clock.advance(0.5 / 24, 0.004); mpcIn.fire([0xf8], clock.perfNow()); }
    mpcIn.fire([0xfc], clock.perfNow());
    expect(midi.externalClock.active).toBe(true);
    expect(clocks.at(-1)).toMatchObject({ running: false, active: true });
    const n = clocks.length;
    // No more pulses: nothing else would ever tell the UI before this fix.
    clock.advance(0.7, 0.01);
    expect(midi.externalClock.active).toBe(false);
    expect(clocks.length).toBe(n + 1);
    expect(clocks.at(-1)).toMatchObject({ running: false, active: false });
    clock.advance(2, 0.01);
    expect(clocks.length).toBe(n + 1);
  });

  it('keeps the clock active while pulses keep coming, without an event per pulse', async () => {
    const { midi, mpcIn, clock } = await setup({ tempo: 120 });
    midi.setSetting('followClock', true);
    const clocks = [];
    midi.on('clock', c => clocks.push(c));
    for (let i = 0; i < 24 * 8; i++) { clock.advance(0.5 / 24, 0.004); mpcIn.fire([0xf8], clock.perfNow()); }
    expect(midi.externalClock.active).toBe(true);
    expect(clocks.every(c => c.active)).toBe(true);
    expect(clocks.length).toBeLessThan(24);
  });
});

describe('MIDI out', () => {
  it('sends 24 PPQ clock with Start and Stop: 48 pulses in 1 s at 120 bpm', async () => {
    const { midi, mpcOut, music, clock } = await setup({ tempo: 120 });
    midi.setSetting('sendClock', true);
    music.transport.play();
    clock.advance(1.5);
    music.transport.stop();
    const sent = mpcOut.sent;
    expect(sent[0].data).toEqual([0xfa]);
    const ticks = sent.filter(s => s.data[0] === 0xf8);
    const t0 = ticks[0].timestamp;
    expect(sent[0].timestamp).toBeLessThanOrEqual(t0);
    const firstSecond = ticks.filter(s => s.timestamp >= t0 && s.timestamp < t0 + 1000 - 1e-6);
    expect(firstSecond).toHaveLength(48);
    expect(ticks[1].timestamp - ticks[0].timestamp).toBeCloseTo(500 / 24, 6);
    expect(sent.at(-1).data).toEqual([0xfc]);
  });

  it('mirrors sequencer notes on each part\'s channel with timestamps', async () => {
    const { midi, mpcOut, music, clock, store } = await setup({ tempo: 120 });
    midi.setSetting('sendNotes', true);
    midi.setSetting('outChannels', [5, 2, 3, 4]);
    const seq = store.get('parts.0.patterns.0');
    store.set('parts.0.seqOn', 1); seq.steps[0].on = 1; seq.steps[0].degree = 0;
    store.set('parts.0.patterns.0', seq);
    const t0 = clock.perfNow();
    music.transport.play();
    clock.advance(0.3);
    const ons = mpcOut.sent.filter(s => (s.data[0] & 0xf0) === 0x90);
    expect(ons[0].data).toEqual([0x94, 57, Math.round(0.8 * 127)]);
    expect(ons[0].timestamp).toBeCloseTo(t0 + 60, 3); // START_DELAY 60 ms, no output latency in the fake
    const offs = mpcOut.sent.filter(s => (s.data[0] & 0xf0) === 0x80);
    expect(offs[0].timestamp - ons[0].timestamp).toBeCloseTo(62.5, 3);
  });

  it('does not echo controller notes back out', async () => {
    const { midi, mpcIn, mpcOut, music } = await setup();
    midi.setSetting('sendNotes', true);
    mpcIn.fire([0x90, 60, 100]);
    expect(mpcOut.sent).toHaveLength(0);
    music.router.noteOn('sel', 64, 0.5, 'ui');
    expect(mpcOut.sent.map(s => s.data)).toEqual([[0x90, 64, 64]]);
  });

  it('holds far-ahead sequencer notes until shortly before they are due, so Stop can drop them', async () => {
    const { midi, mpcOut, music, clock } = await setup();
    midi.setSetting('sendNotes', true);
    const t = clock.ctx.currentTime;
    music.router._engineOn(0, 60, 1, t + 0.05, 'seq');   // near: sent at once, timestamped
    music.router._engineOn(0, 62, 1, t + 0.40, 'seq');   // far: held
    music.router._engineOff(0, 62, t + 0.45, 'seq');
    music.router._engineOn(0, 64, 1, t + 0.40, 'seq');   // far: held, then dropped too
    expect(mpcOut.bytes()).toEqual([[0x90, 60, 127]]);
    clock.advance(0.1);
    music.router._cancelAfter(t + 0.3, 'seq');           // notes after 0.3 s are dropped, with their note-offs
    expect(mpcOut.bytes()).toEqual([[0x90, 60, 127]]);
    music.router._engineOn(0, 65, 1, t + 0.5, 'seq');    // queued after the cancel: plays
    clock.advance(0.6);
    expect(mpcOut.bytes()).toEqual([[0x90, 60, 127], [0x90, 65, 127]]);
  });

  it('panic sends note-offs then CC64, CC123, CC120 on the used channels', async () => {
    const { midi, mpcOut, music } = await setup();
    midi.setSetting('sendNotes', true);
    music.router.noteOn(1, 62, 1, 'ui');
    mpcOut.sent.length = 0;
    midi.panic();
    expect(mpcOut.bytes()).toEqual([
      [0x81, 62, 0],
      [0xb0, 64, 0], [0xb0, 123, 0], [0xb0, 120, 0],
      [0xb1, 64, 0], [0xb1, 123, 0], [0xb1, 120, 0],
      [0xb2, 64, 0], [0xb2, 123, 0], [0xb2, 120, 0],
      [0xb3, 64, 0], [0xb3, 123, 0], [0xb3, 120, 0],
    ]);
  });

  it('stops sending when the output disconnects and picks the MPC up again', async () => {
    const { midi, mpcOut, music, access } = await setup();
    midi.setSetting('sendNotes', true);
    const changes = [];
    midi.on('change', c => changes.push(c.what));
    access.unplug(mpcOut);
    expect(midi.output).toBeNull();
    expect(midi.error).toMatch(/disconnected/);
    expect(changes).toContain('devices');
    music.router.noteOn(0, 60, 1, 'ui');
    expect(mpcOut.sent).toHaveLength(0);
    access.plug(mpcOut);
    expect(midi.output.id).toBe('out-1');
    expect(midi.error).toBeNull();
    music.router.noteOn(0, 61, 1, 'ui');
    expect(mpcOut.sent).toHaveLength(1);
  });

  it('handles a send that throws mid-play', async () => {
    const { midi, mpcOut, music, clock } = await setup();
    midi.setSetting('sendClock', true);
    music.transport.play();
    clock.advance(0.2);
    mpcOut.state = 'pending';
    mpcOut.send = () => { throw new Error('gone'); };
    expect(() => clock.advance(0.3)).not.toThrow();
    expect(midi.output).toBeNull();
    expect(midi.error).toMatch(/disconnected/);
  });

  it('keeps a manual output choice over auto-detection', async () => {
    const synth = fakeOutput('out-9', 'Some Synth');
    const mpc = fakeOutput('out-1', 'MPC XL MIDI 1');
    const { midi, access } = await setup({ outputs: [synth] });
    expect(midi.output).toBeNull(); // never auto-picks non-MPC gear
    midi.setSetting('outputId', 'out-9');
    access.plug(mpc);
    expect(midi.output.id).toBe('out-9');
    midi.setSetting('outputId', 'auto');
    expect(midi.output.id).toBe('out-1');
  });

  it('releases held input notes when the input disconnects', async () => {
    const { mpcIn, access, engine } = await setup();
    mpcIn.fire([0x90, 60, 100]);
    access.unplug(mpcIn);
    expect(engine.offs().map(e => e.note)).toEqual([60]);
  });
});

describe('settings', () => {
  let storage;
  beforeEach(() => { storage = createMemoryStorage(); });
  it('validates and persists settings', async () => {
    const { midi } = await setup({ storage });
    // one channel per track position, track i on channel i by default
    const defaults = Array.from({ length: MAX_PARTS }, (_, i) => i + 1);
    midi.setSetting('multiChannels', [1, 2, 99, 4]);
    expect(midi.getSettings().multiChannels).toEqual(defaults);
    // a list saved with four parts keeps its channels; the tracks after them get the defaults
    midi.setSetting('multiChannels', [3, 3, 2, 1]);
    expect(midi.getSettings().multiChannels).toEqual([3, 3, 2, 1, ...defaults.slice(4)]);
    midi.setSetting('padBaseNote', 48);
    midi.setSetting('channelMode', 'multi');
    const saved = JSON.parse(storage.getItem(STORAGE_KEY));
    expect(saved.settings.padBaseNote).toBe(48);
    expect(saved.settings.channelMode).toBe('multi');
    storage.setItem(STORAGE_KEY, '{not json');
    const fresh = await setup({ storage });
    expect(fresh.midi.getSettings().channelMode).toBe('omni');
  });
});

describe('tracks (v1.3): one channel per track position, up to 16', () => {
  it('routes channels 5 to 8 to tracks 5 to 8 in multi mode once those tracks exist', async () => {
    const { midi, mpcIn, engine, store } = await setup();
    midi.setSetting('channelMode', 'multi');
    mpcIn.fire([0x96, 40, 100]);                 // channel 7, no track 7 yet
    expect(engine.ons()).toEqual([]);
    for (let i = 0; i < 4; i++) addTrack(store);
    for (let ch = 1; ch <= 9; ch++) mpcIn.fire([0x90 | (ch - 1), 50 + ch, 100]);
    expect(engine.ons().map(e => e.part)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);  // channel 9: no track 9
  });

  it('plays a numbered omni target only while that track exists', async () => {
    const { midi, mpcIn, engine, store } = await setup();
    store.set('ui.selectedPart', 1);
    midi.setSetting('omniTarget', 6);
    expect(midi.getSettings().omniTarget).toBe(6);
    mpcIn.fire([0x90, 60, 100]);
    mpcIn.fire([0x80, 60, 0]);
    expect(engine.ons().map(e => e.part)).toEqual([1]);   // falls back to the selected track
    for (let i = 0; i < 3; i++) addTrack(store);
    mpcIn.fire([0x90, 61, 100]);
    expect(engine.ons().map(e => e.part)).toEqual([1, 6]);
  });

  it('sends track 6 on channel 6 and releases held notes when the tracks move', async () => {
    const { midi, mpcOut, music, store } = await setup();
    midi.setSetting('sendNotes', true);
    addTrack(store); addTrack(store);
    music.router.noteOn(5, 62, 1, 'ui');
    expect(mpcOut.bytes()).toEqual([[0x95, 62, 127]]);
    moveTrack(store, 5, 0);
    expect(mpcOut.bytes()).toEqual([[0x95, 62, 127], [0x85, 62, 0]]);
  });
});
