// v1.1 pedal rig: the saved per-device settings and the controller that ties
// them to the engine's pedal host and to MIDI for the pedal profiles.
import { describe, it, expect, vi } from 'vitest';
import { defaultRig, sanitizeRig, loadRig, saveRig, RIG_KEY, pairChannels, OUTPUT_PAIRS, defaultModSlot } from '../../src/pedals/rig-settings.js';
import { createPedalRig } from '../../src/ui/pedal-rig.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { PEDAL_IDS } from '../../src/pedals/profiles.js';

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

describe('rig settings', () => {
  it('defaults to everything off, send on outputs 3/4 at -18 dB', () => {
    const d = defaultRig();
    expect(d).toMatchObject({ enabled: 0, mainPair: 0, sendPair: 2, ceilingDb: -18, returnEnabled: 0, returnLayout: 'stereo', outputDeviceId: 'default' });
    expect(Object.keys(d.pedals)).toEqual(PEDAL_IDS);
    expect(d.pedals.purrting).toEqual({ enabled: 0, channel: 1, mods: [defaultModSlot(), defaultModSlot()] });
    expect(d.patchesRecallPedals).toBe(0);
    expect(d.pedals.lostAndFound.channel).toBe(2);
    expect(pairChannels(2)).toEqual([2, 3]);
    expect(OUTPUT_PAIRS.map(p => p.label)).toEqual(['Outputs 1/2', 'Outputs 3/4', 'Outputs 5/6', 'Outputs 7/8']);
  });

  it('drops unknown or invalid values', () => {
    const s = sanitizeRig({
      enabled: true, sendPair: 3, ceilingDb: 0, returnLayout: 'quad', returnLevel: 9, mystery: 1, lastLatencyMs: -4,
      pedals: { purrting: { enabled: 1, channel: 40, mods: [{ source: 'macro2', control: 'tap' }] }, xero: { mods: [{ control: 'volume1', source: 'guitar' }] }, nope: {} },
    });
    expect(s.enabled).toBe(1);
    expect(s.sendPair).toBe(2);
    expect(s.ceilingDb).toBe(-18);
    expect(s.returnLayout).toBe('stereo');
    expect(s.returnLevel).toBe(2);
    expect(s.lastLatencyMs).toBe(null);
    expect(s).not.toHaveProperty('mystery');
    expect(s.pedals.purrting).toEqual({ enabled: 1, channel: 16, mods: [{ ...defaultModSlot(), source: 'macro2' }, defaultModSlot()] });  // a trigger cannot follow
    expect(s.pedals.xero.mods[0]).toMatchObject({ source: 'guitar', control: 'volume1' });
    expect(s.pedals).not.toHaveProperty('nope');
  });

  it('round-trips through storage and survives garbage', () => {
    const st = memStorage();
    saveRig({ ...defaultRig(), enabled: 1, sendPair: 4 }, st);
    expect(loadRig(st)).toMatchObject({ enabled: 1, sendPair: 4 });
    expect(loadRig(memStorage({ [RIG_KEY]: '{not json' }))).toEqual(defaultRig());
    expect(loadRig(null)).toEqual(defaultRig());
  });
});

function fakeHost() {
  const ls = {};
  const host = {
    configure: vi.fn((o) => ({ ...o })),
    setReturn: vi.fn(async (o) => ({ ...o })),
    ping: vi.fn(async () => ({ ok: true, latencyMs: 38.26, confidence: 0.9 })),
    resetGuard: vi.fn(),
    listInputs: vi.fn(async () => []),
    status: () => ({ active: true }),
    on: (t, fn) => { (ls[t] ||= new Set()).add(fn); return () => ls[t].delete(fn); },
    emit: (t, e) => { for (const fn of ls[t] || []) fn(e); },
  };
  return host;
}

function setup({ prefs, midiOk = true, granted = true } = {}) {
  const storage = memStorage(prefs ? { [RIG_KEY]: JSON.stringify(prefs) } : {});
  const store = createStore(defaultState());
  const host = fakeHost();
  const engine = { pedals: host, outputDeviceId: 'default', setOutputDevice: vi.fn(async function (id) { engine.outputDeviceId = id; return id; }), listOutputDevices: async () => [] };
  const sent = [];
  const midi = midiOk ? { status: 'ready', sendRaw: vi.fn((bytes, ts, out) => { sent.push({ bytes, out }); return true; }) } : null;
  const rig = createPedalRig({ store, engine, midi, storage, micGranted: async () => granted });
  return { rig, host, engine, midi, sent, store, storage };
}

describe('pedal rig', () => {
  it('turns the send on with the saved device and channel map', async () => {
    const { rig, host, engine, storage } = setup();
    await rig.set({ enabled: 1, outputDeviceId: 'mpc-xl', sendPair: 4, ceilingDb: -24 });
    expect(engine.setOutputDevice).toHaveBeenCalledWith('mpc-xl');
    expect(host.configure).toHaveBeenLastCalledWith({ enabled: true, mainChannels: [0, 1], sendChannels: [4, 5], ceilingDb: -24 });
    expect(JSON.parse(storage.m.get(RIG_KEY))).toMatchObject({ enabled: 1, outputDeviceId: 'mpc-xl', sendPair: 4 });
    // Changing only the return does not touch the outputs again.
    host.configure.mockClear();
    await rig.set({ returnEnabled: 1, returnDeviceId: 'in-3-4', returnLayout: 'mono+guitar', returnLevel: 0.7 });
    expect(host.configure).not.toHaveBeenCalled();
    expect(host.setReturn).toHaveBeenLastCalledWith({ enabled: true, deviceId: 'in-3-4', layout: 'mono+guitar', level: 0.7, delay: 0, reverb: 0 });
  });

  it('restores the rig at start-up, reopening the return only with permission', async () => {
    const prefs = { ...defaultRig(), enabled: 1, returnEnabled: 1 };
    const a = setup({ prefs, granted: true });
    await a.rig.restore();
    expect(a.host.configure).toHaveBeenCalledTimes(1);
    expect(a.host.setReturn).toHaveBeenCalledTimes(1);
    const b = setup({ prefs, granted: false });
    await b.rig.restore();
    expect(b.host.configure).toHaveBeenCalledTimes(1);
    expect(b.host.setReturn).not.toHaveBeenCalled();
    const c = setup();
    await c.rig.restore();
    expect(c.host.configure).not.toHaveBeenCalled();
  });

  it('sends pedal MIDI with each profile\'s own encoding and channel', async () => {
    const { rig, sent } = setup();
    expect(rig.pedalAction('purrting', 'on').ok).toBe(false);   // not switched on yet
    await rig.setPedal('purrting', { enabled: 1 });
    expect(rig.pedalAction('purrting', 'on').ok).toBe(true);
    // Purr-ting: CC 85, inverted (0 = on), channel 1.
    expect(sent.pop().bytes).toEqual([0xb0, 85, 0]);
    rig.pedalAction('purrting', 'bypass');
    expect(sent.pop().bytes).toEqual([0xb0, 85, 127]);
    await rig.setPedal('lostAndFound', { enabled: 1, channel: 5 });
    expect(rig.pedalAction('lostAndFound', 'program', 0).ok).toBe(true);
    expect(sent.pop().bytes).toEqual([0xc4, 0]);
    expect(rig.pedalAction('lostAndFound', 'program', 300).ok).toBe(false);
    await rig.set({ midiOutputId: 'mpc-port-a' });
    rig.pedalAction('purrting', 'on');
    expect(sent.pop()).toEqual({ bytes: [0xb0, 85, 0], out: 'mpc-port-a' });
  });

  it('warns when two pedals on one cable share a channel', async () => {
    const { rig } = setup();
    await rig.setPedal('purrting', { enabled: 1 });
    await rig.setPedal('xero', { enabled: 1, channel: 1 });
    const c = rig.conflicts();
    expect(c).toHaveLength(1);
    expect(c[0].message).toMatch(/Purr-ting and .*Xero.* both on channel 1/);
    await rig.setPedal('xero', { channel: 3 });
    expect(rig.conflicts()).toEqual([]);
  });

  it('lets a pedal control follow a macro or the guitar level', async () => {
    const { rig, sent, store, host } = setup();
    await rig.setPedal('purrting', { enabled: 1 });
    await rig.setPedalMod('purrting', 0, { source: 'macro1', control: 'mix' });
    sent.length = 0;
    store.set('global.macro1', 0.5);
    expect(sent.pop().bytes).toEqual([0xb0, 23, 64]);
    await rig.setPedal('xero', { enabled: 1 });
    await rig.setPedalMod('xero', 1, { source: 'guitar', control: 'volume1' });
    host.emit('guitar', { level: 1 });
    expect(sent.pop().bytes).toEqual([0xb2, 2, 127]);
  });

  it('keeps the last ping and reports a missing MIDI connection', async () => {
    const { rig } = setup({ midiOk: false });
    await rig.ping();
    expect(rig.prefs.lastLatencyMs).toBe(38.3);
    await rig.setPedal('nucleo', { enabled: 1 });
    expect(rig.pedalAction('nucleo', 'on')).toMatchObject({ ok: false, reason: expect.stringMatching(/MIDI/) });
    expect(rig.status().midi.available).toBe(false);
  });

  it('works without an engine at all', async () => {
    const store = createStore(defaultState());
    const rig = createPedalRig({ store, engine: null, midi: null, storage: memStorage() });
    expect(rig.supported).toBe(false);
    await rig.set({ enabled: 1 });
    expect(rig.status().audio).toBe(null);
    expect((await rig.ping()).ok).toBe(false);
    await rig.restore();
    rig.dispose();
  });
});
