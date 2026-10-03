// v1.1 pedal LFOs (several modulated controls per pedal, sent as CCs only on
// change, at most about 100 per second per pedal) and pedal presets recalled by
// scenes and patches (Program Change; patches only with the opt-in setting).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState, STATE_VERSION } from '../../src/core/params.js';
import { migrateState, migrateScene } from '../../src/core/migrate.js';
import { createPresets, STORAGE_KEY, PRESET_VERSION, sanitizeScene, sanitizePatch } from '../../src/presets/presets.js';
import { createPedalRig } from '../../src/ui/pedal-rig.js';
import { createLfoSource } from '../../src/pedals/pedal-midi.js';
import { RIG_KEY, defaultRig, sanitizeRig, MOD_SLOTS } from '../../src/pedals/rig-settings.js';
import { sanitizePedalPresets, programHint, describePedalPresets } from '../../src/pedals/pedal-presets.js';
import { createMidi } from '../../src/midi/midi.js';
import { fakeOutput, fakeAccess, fakeNavigator } from '../midi/fake-midi.js';
import { createMemoryStorage } from '../music/fakes.js';

afterEach(() => { vi.useRealTimers(); });

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

/** A rig on fake timers (Date.now as the MIDI clock) with a sendRaw spy. */
function lfoRig({ prefs, transport = null } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const storage = memStorage(prefs ? { [RIG_KEY]: JSON.stringify(prefs) } : {});
  const store = createStore(defaultState());
  const sent = [];
  const midi = { status: 'ready', sendRaw: vi.fn((bytes, ts) => { sent.push({ bytes: [...bytes], ts }); return true; }) };
  const rig = createPedalRig({ store, midi, storage, transport, clock: { now: () => Date.now() } });
  return { rig, sent, store, storage };
}

const ccs = (sent, status, cc) => sent.filter(s => s.bytes[0] === status && s.bytes[1] === cc);

describe('pedal LFOs', () => {
  it('drive a control as CCs, only on change and at most about 100 a second per pedal', async () => {
    const { rig, sent } = lfoRig();
    await rig.setPedal('lostAndFound', { enabled: 1 });
    // A fast saw over the whole range changes on almost every 10 ms slot.
    await rig.setPedalMod('lostAndFound', 0, { source: 'lfo', control: 'ramp', lfoShape: 'saw', lfoRate: 5 });
    vi.advanceTimersByTime(2000);
    const msgs = ccs(sent, 0xb1, 20); // Lost + Found on channel 2, CC 20 Ramp
    expect(msgs.length).toBeGreaterThan(150);
    expect(msgs.length).toBeLessThanOrEqual(205); // 100 per second, plus the lookahead
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i].ts - msgs[i - 1].ts).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(msgs[i].bytes[2]).not.toBe(msgs[i - 1].bytes[2]); // never the same value twice
    }
    rig.dispose();
  });

  it('a slow or shallow LFO sends far fewer messages; depth 0 sends the middle once', async () => {
    const { rig, sent } = lfoRig();
    await rig.setPedal('purrting', { enabled: 1 });
    await rig.setPedalMod('purrting', 0, { source: 'lfo', control: 'mix', lfoShape: 'triangle', lfoRate: 0.05 });
    vi.advanceTimersByTime(1000);
    const slow = ccs(sent, 0xb0, 23).length;
    expect(slow).toBeGreaterThan(0);
    expect(slow).toBeLessThan(30); // 0.05 Hz triangle: about 25 steps of 127 per second
    sent.length = 0;
    await rig.setPedalMod('purrting', 0, { lfoDepth: 0 });
    vi.advanceTimersByTime(1000);
    expect(ccs(sent, 0xb0, 23).map(s => s.bytes[2])).toEqual([64]);
    rig.dispose();
  });

  it('min, max and curve shape the range; square at depth 1 swings between them', async () => {
    const { rig, sent } = lfoRig();
    await rig.setPedal('purrting', { enabled: 1 });
    await rig.setPedalMod('purrting', 0, { source: 'lfo', control: 'time', lfoShape: 'square', lfoRate: 1, min: 0.25, max: 0.75 });
    vi.advanceTimersByTime(3000);
    const values = new Set(ccs(sent, 0xb0, 21).map(s => s.bytes[2]));
    expect([...values].sort((a, b) => a - b)).toEqual([32, 95]);
    rig.dispose();
  });

  it('follows the tempo when synced (two cycles per second at 120 BPM, 1/4)', async () => {
    let bpm = 120;
    const { rig, sent } = lfoRig({ transport: { tempo: () => bpm } });
    await rig.setPedal('purrting', { enabled: 1 });
    await rig.setPedalMod('purrting', 0, { source: 'lfo', control: 'mix', lfoShape: 'square', lfoSync: 1, lfoBeats: 1 });
    vi.advanceTimersByTime(2000);
    // Square: one change per half cycle, so about 8 messages in 2 s at 2 Hz.
    const n = ccs(sent, 0xb0, 23).length;
    expect(n).toBeGreaterThanOrEqual(7);
    expect(n).toBeLessThanOrEqual(10);
    sent.length = 0;
    bpm = 60;
    vi.advanceTimersByTime(2000);
    const m = ccs(sent, 0xb0, 23).length;
    expect(m).toBeGreaterThanOrEqual(3);
    expect(m).toBeLessThanOrEqual(6);
    rig.dispose();
  });

  it('two modulated controls per pedal, each with its own source', async () => {
    const { rig, sent, store } = lfoRig();
    expect(MOD_SLOTS).toBeGreaterThanOrEqual(2);
    await rig.setPedal('purrting', { enabled: 1 });
    await rig.setPedalMod('purrting', 0, { source: 'macro2', control: 'mix' });
    await rig.setPedalMod('purrting', 1, { source: 'lfo', control: 'filter', lfoShape: 'sine', lfoRate: 2 });
    store.set('global.macro2', 1);
    vi.advanceTimersByTime(500);
    expect(ccs(sent, 0xb0, 23).pop().bytes).toEqual([0xb0, 23, 127]);
    expect(ccs(sent, 0xb0, 22).length).toBeGreaterThan(10);
    // A second slot on the same control is ignored; the first stays in charge.
    await rig.setPedalMod('purrting', 1, { control: 'mix' });
    expect(rig.pedalMidi.mappings().map(m => m.control)).toEqual(['mix']);
    // Turning the LFO slot off stops the LFO clock.
    await rig.setPedalMod('purrting', 1, { source: '' });
    sent.length = 0;
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([]);
    rig.dispose();
  });

  it('an LFO keeps its phase when its rate changes (no jump)', () => {
    const lfo = createLfoSource({ shape: 'saw', rateHz: 1 });
    const before = lfo.valueAt(100.3);
    lfo.rateHz = 3;
    expect(lfo.valueAt(100.3)).toBeCloseTo(before, 9);
    expect(lfo.cyclesAt(100.4) - lfo.cyclesAt(100.3)).toBeCloseTo(0.3, 9);
    expect(createLfoSource({ shape: 'square', depth: 0.5 }).valueAt(0)).toBe(0.5);
  });

  it('old rigs with one Follow mapping load it into the first slot', () => {
    const s = sanitizeRig({ pedals: { purrting: { enabled: 1, followSource: 'macro3', followControl: 'mix' } } });
    expect(s.pedals.purrting.mods[0]).toMatchObject({ source: 'macro3', control: 'mix', min: 0, max: 1 });
    expect(s.pedals.purrting.mods[1].source).toBe('');
    expect(s.pedals.purrting).not.toHaveProperty('followSource');
    const bad = sanitizeRig({ pedals: { purrting: { mods: [{ source: 'lfo', lfoShape: 'zigzag', lfoRate: 99, lfoBeats: 3, curve: 'Hard', min: -2 }] } } });
    expect(bad.pedals.purrting.mods[0]).toMatchObject({ source: 'lfo', lfoShape: 'sine', lfoRate: 10, lfoBeats: 4, curve: 2, min: 0 });
  });
});

// ------------------------------------------------------------------ presets

const PP = { purrting: 12, lostAndFound: 0, nucleo: 5 };

async function presetRig({ recall = 0, enabled = ['purrting', 'lostAndFound'] } = {}) {
  const store = createStore(defaultState());
  const presets = createPresets({ store, storage: createMemoryStorage() });
  const out = fakeOutput('out-1', 'USB MIDI Interface');
  const access = fakeAccess({ outputs: [out] });
  const midi = await createMidi({ store, router: null, navigator: fakeNavigator(access, { permission: 'granted' }), storage: null, secure: true, perfNow: () => 0 });
  const rigPrefs = defaultRig();
  rigPrefs.midiOutputId = 'out-1';
  rigPrefs.patchesRecallPedals = recall;
  for (const id of enabled) rigPrefs.pedals[id].enabled = 1;
  const rig = createPedalRig({ store, midi, presets, storage: memStorage({ [RIG_KEY]: JSON.stringify(rigPrefs) }), clock: { now: () => 0 } });
  await rig.restore();
  return { store, presets, rig, out };
}

describe('scenes and patches recall pedal presets', () => {
  it('loading a scene sends its Program Changes to the pedals that are switched on', async () => {
    const { presets, rig, out } = await presetRig();
    const id = presets.saveScene('Gig A', { pedalPresets: PP });
    expect(presets.getScene(id).pedalPresets).toEqual(PP);
    const recalls = [];
    rig.on('recall', (e) => recalls.push(e));
    out.sent.length = 0;
    presets.loadScene(id);
    // Purr-ting channel 1 PC 12, Lost + Found channel 2 PC 0 (Live). The Nucleo is off: left alone.
    expect(out.bytes()).toEqual([[0xc0, 12], [0xc1, 0]]);
    expect(recalls[0].results.find(r => r.pedal === 'nucleo')).toMatchObject({ ok: false, skipped: true });
    // A scene without pedal presets leaves every pedal as it is.
    out.sent.length = 0;
    presets.loadScene(presets.saveScene('Gig B', { pedalPresets: null }));
    expect(out.bytes()).toEqual([]);
    rig.dispose();
  });

  it('patches recall pedal presets only when the setting is on', async () => {
    const off = await presetRig({ recall: 0 });
    expect(off.rig.prefs.patchesRecallPedals).toBe(0);
    const pid = off.presets.savePatch(0, 'Shared patch', { pedalPresets: { purrting: 3 } });
    off.out.sent.length = 0;
    off.presets.loadPatch(0, pid);
    expect(off.out.bytes()).toEqual([]);
    await off.rig.set({ patchesRecallPedals: 1 });
    off.presets.loadPatch(1, pid);
    expect(off.out.bytes()).toEqual([[0xc0, 3]]);
    off.rig.dispose();
  });

  it('a patch loaded into several parts at once sends its preset once', async () => {
    const { presets, out, rig } = await presetRig({ recall: 1 });
    const pid = presets.savePatch(0, 'Layer', { pedalPresets: { lostAndFound: 7 } });
    out.sent.length = 0;
    for (let p = 0; p < 4; p++) presets.loadPatch(p, pid);
    expect(out.bytes()).toEqual([[0xc1, 7]]);
    // Init and Dice never touch the pedals.
    out.sent.length = 0;
    presets.initPatch(0);
    presets.randomizePatch(1);
    expect(out.bytes()).toEqual([]);
    rig.dispose();
  });

  it('re-saving keeps, replaces or clears the stored presets; setPedalPresets edits them', async () => {
    const { presets, rig } = await presetRig();
    const id = presets.saveScene('Set', { pedalPresets: { purrting: 4 } });
    presets.saveScene('Set');
    expect(presets.getScene(id).pedalPresets).toEqual({ purrting: 4 });
    presets.saveScene('Set', { pedalPresets: { nucleo: 9 } });
    expect(presets.getScene(id).pedalPresets).toEqual({ nucleo: 9 });
    expect(presets.setPedalPresets('scene', id, { lostAndFound: 0 })).toBe(true);
    expect(presets.scenes().find(s => s.id === id).pedalPresets).toEqual({ lostAndFound: 0 });
    presets.setPedalPresets('scene', id, null);
    expect(presets.getScene(id)).not.toHaveProperty('pedalPresets');
    expect(presets.setPedalPresets('scene', 'f-nope', { purrting: 1 })).toBe(false);
    rig.dispose();
  });
});

describe('pedal preset data and migration', () => {
  it('keeps each profile\'s Program Change meaning', () => {
    // Purr-ting presets run 1-127, so 0 is dropped; the Lost + Found's 0 (Live) is kept.
    expect(sanitizePedalPresets({ purrting: 0, lostAndFound: 0, nucleo: 128, xero: 3, nope: 1, 'purr': 2 })).toEqual({ lostAndFound: 0 });
    expect(sanitizePedalPresets({ purrting: 1.5 })).toBe(null);
    expect(sanitizePedalPresets([1, 2])).toBe(null);
    expect(programHint('lostAndFound')).toBe('0 = Live, 1-127 saved presets');
    expect(programHint('purrting')).toBe('1-127');
    expect(describePedalPresets({ purrting: 12, lostAndFound: 0 })).toBe('Purr-ting 12, Lost + Found Live (0)');
  });

  it('old scenes and patches load unchanged, with no pedal presets', () => {
    const old = { ...JSON.parse(JSON.stringify(defaultState())), version: 2, name: 'Old', description: 'v1.1 beta' };
    const scene = sanitizeScene(old);
    expect(scene).not.toHaveProperty('pedalPresets');
    expect(scene).toEqual({ ...migrateState(old), name: 'Old', description: 'v1.1 beta' });
    expect(scene.version).toBe(STATE_VERSION);
    expect(migrateScene({ ...old, version: 1 })).toEqual(migrateState(old));
    const patch = sanitizePatch({ name: 'P', params: { cutoff: 900 } });
    expect(patch).not.toHaveProperty('pedalPresets');
    expect(sanitizePatch({ name: 'P', params: {}, pedalPresets: { purrting: 0 } })).not.toHaveProperty('pedalPresets');
    expect(sanitizeScene({ ...old, pedalPresets: { nucleo: 3 } }).pedalPresets).toEqual({ nucleo: 3 });
  });

  it('a version 1 library loads unchanged and is saved back in the current format', () => {
    const storage = createMemoryStorage();
    const oldScene = { ...JSON.parse(JSON.stringify(defaultState())), version: 2, name: 'Mine', description: '', id: 'u-1' };
    const oldPatch = { name: 'My pad', category: 'User', tags: [], params: { cutoff: 1200 }, mods: {}, id: 'u-2' };
    storage.setItem(STORAGE_KEY, JSON.stringify({ format: 'orograph-presets', version: 1, patches: [oldPatch], scenes: [oldScene] }));
    const store = createStore(defaultState());
    const presets = createPresets({ store, storage });
    const scene = presets.getScene('u-1');
    expect(scene).not.toHaveProperty('pedalPresets');
    expect(scene.parts).toEqual(migrateState(oldScene).parts);
    expect(presets.getPatch('u-2')).not.toHaveProperty('pedalPresets');
    expect(presets.getPatch('u-2').params).toEqual({ cutoff: 1200 });
    presets.setPedalPresets('patch', 'u-2', { purrting: 9 });
    const saved = JSON.parse(storage.getItem(STORAGE_KEY));
    expect(PRESET_VERSION).toBe(3);
    expect(saved.version).toBe(PRESET_VERSION);
    expect(saved.patches[0].pedalPresets).toEqual({ purrting: 9 });
    expect(saved.scenes[0]).not.toHaveProperty('pedalPresets');
  });

  it('imports a version 1 export, and exports carry pedal presets', async () => {
    const store = createStore(defaultState());
    const presets = createPresets({ store, storage: createMemoryStorage() });
    const v1 = { format: 'orograph-presets', version: 1, patches: [{ name: 'Old patch', params: { cutoff: 500 } }], scenes: [{ ...defaultState(), version: 1, name: 'Old scene' }] };
    expect(await presets.importJSON(JSON.stringify(v1))).toEqual({ patches: 1, scenes: 1 });
    const imported = presets.scenes().find(s => s.name === 'Old scene');
    expect(imported.pedalPresets).toBe(null);
    presets.saveScene('With pedals', { pedalPresets: { lostAndFound: 0 } });
    const text = await presets.exportJSON('scene').text();
    const data = JSON.parse(text);
    expect(data.version).toBe(PRESET_VERSION);
    expect(data.scenes.find(s => s.name === 'With pedals').pedalPresets).toEqual({ lostAndFound: 0 });
  });
});
