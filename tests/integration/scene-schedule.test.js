// Cross-module contracts on the way from a scene to sound:
//
//   scene -> store -> music transport/router -> engine note messages   (live playback)
//   scene -> store -> music.renderEvents                                (offline bounce)
//   store -> audio/sync.js -> DSP parameter messages                    (what the worklet hears)
//   MPC clock -> midi.js -> transport -> engine                         (follow mode)
//
// They run in Node with the fake clock from tests/music/fakes.js, so the
// timing is exact and the whole file takes a few seconds.

import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { NUM_PARTS, PART_PARAMS, GLOBAL_PARAMS, MOD_PARAM_IDS, defaultState, fromNorm } from '../../src/core/params.js';
import { migrateState } from '../../src/core/migrate.js';
import { createMusic } from '../../src/music/music.js';
import { START_DELAY } from '../../src/music/transport.js';
import { makeRng } from '../../src/music/patterns.js';
import { createPresets } from '../../src/presets/presets.js';
import { FACTORY_SCENES } from '../../src/presets/factory-scenes.js';
import { createStoreSync } from '../../src/audio/sync.js';
import { createMidi } from '../../src/midi/midi.js';
import { createFakeClock, createFakeEngine, createMemoryStorage } from '../music/fakes.js';
import { fakeInput, fakeOutput, fakeAccess, fakeNavigator } from '../midi/fake-midi.js';

const stripMeta = ({ name, description, id, factory, ...state }) => state;
const r6 = (v) => Math.round(v * 1e6) / 1e6;

function sceneMusic(k, { seed = 7, startSec = 2 } = {}) {
  const clock = createFakeClock({ startSec });
  const engine = createFakeEngine(clock);
  const store = createStore(migrateState(stripMeta(FACTORY_SCENES[k])));
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow, random: makeRng(seed) });
  return { clock, engine, store, music };
}

/** Each part's note-ons and note-offs pair up per pitch; returns the pitches left open. */
function openNotes(events) {
  const open = new Map();
  for (const e of events.slice().sort((a, b) => a.time - b.time || (a.type === 'off' ? -1 : 1))) {
    const k = `${e.part}:${e.note}`;
    if (e.type === 'on') open.set(k, (open.get(k) || 0) + 1);
    else if (e.type === 'off' && open.get(k)) open.set(k, open.get(k) - 1);
  }
  return [...open].filter(([, n]) => n > 0).map(([k]) => k);
}

describe('scene -> music schedule', () => {
  it('renders the same events for the same scene every time (two independent sessions)', () => {
    for (let k = 0; k < FACTORY_SCENES.length; k++) {
      const a = sceneMusic(k, { seed: 3 }).music.renderEvents(4);
      const b = sceneMusic(k, { seed: 3 }).music.renderEvents(4);
      expect(a.length, FACTORY_SCENES[k].name).toBeGreaterThan(1);
      expect(b, FACTORY_SCENES[k].name).toEqual(a);
    }
  });

  it('live playback schedules exactly the notes the offline render produces (2 bars of every scene)', () => {
    for (let k = 0; k < FACTORY_SCENES.length; k++) {
      const name = FACTORY_SCENES[k].name;
      const live = sceneMusic(k, { seed: 11 });
      const offline = sceneMusic(k, { seed: 11 }).music.renderEvents(2);
      const spb = 60 / live.store.get('global.tempo');
      const t0 = live.clock.now();
      live.music.transport.play();
      live.clock.advance(8 * spb + 0.5);
      const anchor = t0 + START_DELAY;
      const end = 8 * spb;
      const liveOns = live.engine.ons()
        .map(e => ({ part: e.part, note: e.note, vel: r6(e.vel), time: r6(e.time - anchor) }))
        .filter(e => e.time < end - 1e-6);
      const offOns = offline.filter(e => e.msg.t === 'noteOn').map(e => ({ part: e.msg.part, note: e.msg.note, vel: r6(e.msg.vel), time: r6(e.time) }));
      const key = (e) => `${e.part}|${e.note}|${e.time.toFixed(4)}|${e.vel}`;
      expect(liveOns.map(key).sort(), name).toEqual(offOns.map(key).sort());
      live.music.transport.stop();
      live.music.dispose();
    }
  });

  it('stopping the transport at any moment leaves no note hanging', () => {
    for (let k = 0; k < FACTORY_SCENES.length; k++) {
      for (const stopAfter of [0.37, 1.01, 2.5, 3.333]) {
        const { clock, engine, music } = sceneMusic(k);
        music.transport.play();
        clock.advance(stopAfter);
        music.transport.stop();
        clock.advance(2);
        // Every note-on has a note-off at or after it; nothing is scheduled after the stop + lookahead.
        expect(openNotes(engine.events), `${FACTORY_SCENES[k].name} stopped at ${stopAfter} s`).toEqual([]);
        const stopTime = clock.now() - 2;
        const late = engine.ons().filter(e => e.time > stopTime + 0.2);
        expect(late, `${FACTORY_SCENES[k].name}: notes after stop`).toEqual([]);
        music.dispose();
      }
    }
  });

  it('a key or tempo change mid-play keeps the grid and never hangs a note', () => {
    const { clock, engine, store, music } = sceneMusic(0);
    music.transport.play();
    clock.advance(1.3);
    store.set('global.scaleRoot', 4);
    store.set('global.tempo', 160);
    clock.advance(1.1);
    store.set('global.scaleType', 10);
    store.set('parts.1.seq.rate', 5);
    clock.advance(1.2);
    music.transport.stop();
    clock.advance(2);
    expect(openNotes(engine.events)).toEqual([]);
    const ons = engine.ons(0).map(e => e.time);
    for (let i = 1; i < ons.length; i++) expect(ons[i]).toBeGreaterThan(ons[i - 1]);
    music.dispose();
  });
});

describe('store -> audio sync -> DSP messages', () => {
  // What the worklet would hold after applying every message the sync posted.
  function mirror() {
    const m = { global: {}, parts: Array.from({ length: NUM_PARTS }, () => ({ params: {}, mods: {}, links: null })), watch: null };
    m.apply = (msgs) => {
      for (const msg of msgs) {
        if (msg.t === 'global') Object.assign(m.global, msg.p);
        else if (msg.t === 'params') Object.assign(m.parts[msg.part].params, msg.p);
        else if (msg.t === 'mods') for (const [id, v] of Object.entries(msg.m)) m.parts[msg.part].mods[id] = { ...(m.parts[msg.part].mods[id] || {}), ...v };
        else if (msg.t === 'links') m.parts[msg.part].links = msg.links;
        else if (msg.t === 'watch') m.watch = msg.part;
      }
    };
    return m;
  }

  function expectInSync(store, m, label) {
    for (const def of GLOBAL_PARAMS) expect(m.global[def.id], `${label}: global.${def.id}`).toBe(store.get(`global.${def.id}`));
    for (let p = 0; p < NUM_PARTS; p++) {
      for (const def of PART_PARAMS) expect(m.parts[p].params[def.id], `${label}: part ${p} ${def.id}`).toBe(store.get(`parts.${p}.params.${def.id}`));
      for (const id of MOD_PARAM_IDS) {
        const want = store.get(`parts.${p}.mods.${id}`);
        const got = m.parts[p].mods[id];
        for (const f of ['lfoShape', 'lfoRate', 'lfoSync', 'lfoDiv', 'lfoDepth', 'envDepth', 'retrig']) expect(got && got[f], `${label}: part ${p} mod ${id}.${f}`).toBe(want[f]);
        expect(got && got.steps, `${label}: part ${p} mod ${id}.steps`).toEqual(want.steps);
      }
      expect(m.parts[p].links, `${label}: part ${p} links`).toEqual(store.get(`parts.${p}.links`));
    }
    expect(m.watch, `${label}: watched part`).toBe(store.get('ui.selectedPart'));
  }

  it('after any mix of patch loads, scene loads, knob moves and deep edits the DSP holds the store\'s values', { timeout: 30000 }, () => {
    const store = createStore(defaultState());
    const presets = createPresets({ store, storage: createMemoryStorage() });
    const queue = [];
    const sync = createStoreSync({ store, post: (msgs) => m.apply(msgs), defer: (fn) => queue.push(fn) });
    const m = mirror();
    m.apply(sync.snapshot());
    const drain = () => { while (queue.length) queue.shift()(); };
    const rng = makeRng(99);
    const patches = presets.patches();
    const ops = [
      () => presets.loadPatch(Math.floor(rng() * 4), patches[Math.floor(rng() * patches.length)].id),
      () => presets.loadScene(Math.floor(rng() * FACTORY_SCENES.length)),
      () => { const def = PART_PARAMS[Math.floor(rng() * PART_PARAMS.length)]; store.set(`parts.${Math.floor(rng() * 4)}.params.${def.id}`, fromNorm(def, rng())); },
      () => { const def = GLOBAL_PARAMS[Math.floor(rng() * GLOBAL_PARAMS.length)]; store.set(`global.${def.id}`, fromNorm(def, rng())); },
      () => { const id = MOD_PARAM_IDS[Math.floor(rng() * MOD_PARAM_IDS.length)]; store.set(`parts.${Math.floor(rng() * 4)}.mods.${id}.lfoDepth`, rng() * 2 - 1); },
      () => { const id = MOD_PARAM_IDS[Math.floor(rng() * MOD_PARAM_IDS.length)]; store.set(`parts.${Math.floor(rng() * 4)}.mods.${id}.steps.${Math.floor(rng() * 16)}`, rng() * 2 - 1); },
      () => store.set(`parts.${Math.floor(rng() * 4)}.links.0.amt`, rng() * 2 - 1),
      () => store.set(`parts.${Math.floor(rng() * 4)}.links`, [{ src: 3, dst: 'cutoff', amt: 0.5, curve: 1 }]),
      () => presets.randomizePatch(Math.floor(rng() * 4), { rng }),
      () => store.batch(() => { store.set('parts.2.params.cutoff', 500 + rng() * 5000); store.set('parts.2.params.morph', rng()); }),
      () => store.set('ui.selectedPart', Math.floor(rng() * 4)),
      () => store.load(migrateState(stripMeta(FACTORY_SCENES[Math.floor(rng() * FACTORY_SCENES.length)]))),
      () => store.set('parts.1.seq.steps.3.on', 1),
    ];
    for (let i = 0; i < 400; i++) {
      ops[Math.floor(rng() * ops.length)]();
      if (rng() < 0.4) { drain(); expectInSync(store, m, `after op ${i}`); }
    }
    drain();
    expectInSync(store, m, 'at the end');
    sync.dispose && sync.dispose();
  });

  it('a rebuilt DSP gets the whole state back from snapshot()', () => {
    const store = createStore(migrateState(stripMeta(FACTORY_SCENES[4])));
    store.set('ui.selectedPart', 3);
    const sync = createStoreSync({ store, post: () => {}, defer: () => {} });
    const m = mirror();
    m.apply(sync.snapshot());
    expectInSync(store, m, 'snapshot');
  });
});

describe('MPC clock -> transport -> engine', () => {
  async function rig(k = 0) {
    const clock = createFakeClock({ startSec: 1 });
    const engine = createFakeEngine(clock);
    const store = createStore(migrateState(stripMeta(FACTORY_SCENES[k])));
    const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow, random: makeRng(5) });
    const input = fakeInput('in1', 'MPC MIDI 1', 'Akai');
    const output = fakeOutput('out1', 'MPC MIDI 1', 'Akai');
    const access = fakeAccess({ inputs: [input], outputs: [output] });
    const midi = await createMidi({ store, router: music.router, engine, transport: music.transport, navigator: fakeNavigator(access, { permission: 'granted' }), storage: createMemoryStorage(), secure: true, perfNow: clock.perfNow });
    return { clock, engine, store, music, midi, input, output };
  }

  function pulses(clock, input, bpm, beats) {
    const spt = 60 / bpm / 24;
    for (let i = 0; i < beats * 24; i++) { clock.advance(spt, 0.002); input.fire([0xf8], clock.perfNow()); }
  }

  it('follows Start, a 120 bpm clock, a jump to 96 bpm and Stop, with every note released', async () => {
    const { clock, engine, store, music, midi, input } = await rig(0);
    midi.setSetting('followClock', true);
    input.fire([0xfa], clock.perfNow());
    pulses(clock, input, 120, 8);
    expect(store.get('global.tempo')).toBe(120);
    expect(music.transport.isExternal()).toBe(true);
    pulses(clock, input, 96, 8);
    expect(Math.abs(store.get('global.tempo') - 96)).toBeLessThanOrEqual(1);
    const stopAt = clock.now();
    input.fire([0xfc], clock.perfNow());
    expect(music.transport.isPlaying()).toBe(false);
    clock.advance(2);
    expect(engine.ons().length).toBeGreaterThan(20);
    expect(openNotes(engine.events)).toEqual([]);
    expect(engine.ons().filter(e => e.time > stopAt + 0.2)).toEqual([]);
  });

  it('notes mirrored to the MPC are released after Stop as well', async () => {
    const { clock, music, midi, output } = await rig(3);
    midi.setSetting('sendNotes', true);
    music.transport.play();
    clock.advance(2.2);
    music.transport.stop();
    clock.advance(1);
    const open = new Map();
    for (const s of output.sent) {
      const [st, note, vel] = s.data;
      const k = `${st & 0x0f}:${note}`;
      if ((st & 0xf0) === 0x90 && vel > 0) open.set(k, (open.get(k) || 0) + 1);
      else if ((st & 0xf0) === 0x80 || ((st & 0xf0) === 0x90 && vel === 0)) open.set(k, Math.max(0, (open.get(k) || 0) - 1));
    }
    expect([...open].filter(([, n]) => n > 0)).toEqual([]);
  });
});
