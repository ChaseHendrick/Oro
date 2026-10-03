// v1.1 guitar in the pedal rig (src/ui/pedal-rig.js, the model behind
// Settings > Pedals > Guitar): the saved Guitar settings reach the host's
// tracker, tracker events reach the note router, and Capture turns a recorded
// note (synthetic sine and saw here) into a wavetable terrain stored and
// selected on a part through the importer's path (addUserTerrain).
import { describe, it, expect, vi } from 'vitest';
import { createPedalRig, noteLabel } from '../../src/ui/pedal-rig.js';
import { createStore } from '../../src/core/store.js';
import { defaultState, MAX_PARTS } from '../../src/core/params.js';
import { RIG_KEY, defaultRig, sanitizeRig, guitarChannelOptions, GUITAR_TARGETS } from '../../src/pedals/rig-settings.js';
import { addUserTerrain } from '../../src/audio/importers.js';
import { TERRAIN_INDEX } from '../../src/dsp/catalog.js';
import { decodeUserTerrain, base64ToBytes } from '../../src/dsp/terrains.js';
import { makeRandom } from '../../src/pedals/signal.js';

const SR = 48000;

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

/** A held note: 0.2 s of near-silence, then a decaying tone. */
function heldNote(freq, { seconds = 2, harmonics = 1, saw = false } = {}) {
  const n = Math.round((0.2 + seconds) * SR);
  const x = new Float32Array(n);
  const rnd = makeRandom(5);
  const s0 = Math.round(0.2 * SR);
  for (let i = 0; i < n; i++) {
    let v = 0;
    if (i >= s0) {
      const t = (i - s0) / SR;
      for (let k = 1; k <= harmonics; k++) {
        if (k * freq >= SR / 2) break;
        v += (saw ? (k % 2 ? 1 : -1) / k : (k === 1 ? 1 : 0)) * Math.sin(2 * Math.PI * k * freq * t);
      }
      v *= 0.5 * Math.exp(-t / 1.2);
    }
    x[i] = v + 1e-4 * (rnd() * 2 - 1);
  }
  return x;
}

function noise(seconds = 2) {
  const x = new Float32Array(Math.round(seconds * SR));
  const rnd = makeRandom(9);
  for (let i = 0; i < x.length; i++) x[i] = 0.3 * (rnd() * 2 - 1);
  return x;
}

function fakeHost(samples) {
  const ls = {};
  return {
    configure: vi.fn(), setReturn: vi.fn(async () => ({})), ping: vi.fn(), resetGuard: vi.fn(), listInputs: vi.fn(async () => []),
    setGuitar: vi.fn(async (o) => o),
    captureGuitar: vi.fn(async ({ onProgress } = {}) => {
      for (const p of [0.25, 0.5, 0.75, 1]) onProgress && onProgress(p);
      return typeof samples === 'function' ? samples() : { ok: true, samples, sampleRate: SR };
    }),
    status: () => ({ active: false }),
    on: (t, fn) => { (ls[t] ||= new Set()).add(fn); return () => ls[t].delete(fn); },
    emit: (t, e) => { for (const fn of ls[t] || []) fn(e); },
  };
}

function setup({ samples = null, prefs = null } = {}) {
  const store = createStore(defaultState());
  const host = fakeHost(samples);
  const router = { noteOn: vi.fn(), noteOff: vi.fn(), resolve: (t) => (t === 'sel' ? [store.get('ui.selectedPart')] : [t]) };
  const engine = { pedals: host, bend: vi.fn() };
  const storage = memStorage(prefs ? { [RIG_KEY]: JSON.stringify(prefs) } : {});
  const rig = createPedalRig({ store, engine, midi: null, router, storage, micGranted: async () => true });
  const captures = [];
  rig.on('capture', (c) => captures.push(c));
  return { store, host, router, engine, rig, captures, storage };
}

describe('rig settings: guitar', () => {
  it('defaults to notes off, the selected part, channel 2, a -50 dB gate, bends on, slot A', () => {
    expect(defaultRig()).toMatchObject({ guitarNotes: 0, guitarTarget: 'sel', guitarChannel: 2, guitarGateDb: -50, guitarBends: 1, captureSlot: 'A' });
    const s = sanitizeRig({ guitarNotes: true, guitarTarget: MAX_PARTS, guitarChannel: 3, guitarGateDb: -500, guitarBends: 'yes', captureSlot: 'C' });
    expect(s).toMatchObject({ guitarNotes: 1, guitarTarget: 'sel', guitarChannel: 2, guitarGateDb: -75, guitarBends: 1, captureSlot: 'A' });
    expect(sanitizeRig({ guitarTarget: 3, guitarChannel: 1, captureSlot: 'B', guitarGateDb: -33.4 })).toMatchObject({ guitarTarget: 3, guitarChannel: 1, captureSlot: 'B', guitarGateDb: -33 });
    expect(sanitizeRig({ guitarTarget: 7 })).toMatchObject({ guitarTarget: 7 });   // track 8 (when it exists)
    expect(GUITAR_TARGETS.map(t => t.label)).toEqual(['Selected track', ...Array.from({ length: MAX_PARTS }, (_, i) => `Track ${i + 1}`)]);
    expect(guitarChannelOptions('mono+guitar')[1].label).toMatch(/guitar DI/);
    expect(guitarChannelOptions('stereo').map(o => o.value)).toEqual([1, 2]);
  });

  it('names notes like the keyboard', () => {
    expect(noteLabel(45)).toBe('A2');
    expect(noteLabel(60)).toBe('C4');
    expect(noteLabel(61.2)).toBe('C#4');
  });
});

describe('pedal rig: guitar plays notes', () => {
  it('sends the saved guitar settings to the host tracker at start-up and on change', async () => {
    const { rig, host } = setup();
    await rig.restore();
    expect(host.setGuitar).toHaveBeenLastCalledWith({ channel: 1, notes: false, guitarMode: 'single', gateDb: -50, bendRange: 2 });
    await rig.set({ guitarNotes: 1, guitarChannel: 1, guitarGateDb: -40 });
    expect(host.setGuitar).toHaveBeenLastCalledWith({ channel: 0, notes: true, guitarMode: 'single', gateDb: -40, bendRange: 2 });
    await rig.set({ guitarBends: 0 });
    expect(host.setGuitar.mock.calls.at(-1)[0].bendRange).toBe(0.5);
  });

  it('routes tracker notes to the chosen part with source "guitar" and follows its Bend range', async () => {
    const { rig, host, router, engine, store } = setup();
    await rig.set({ guitarNotes: 1, guitarTarget: 2 });
    host.emit('guitarNote', { type: 'noteOn', note: 50, velocity: 0.5 });
    expect(router.noteOn).toHaveBeenCalledWith(2, 50, 0.5, 'guitar');
    host.emit('guitarNote', { type: 'bend', semitones: 1 });
    expect(engine.bend).toHaveBeenLastCalledWith(2, 0.5);
    host.emit('guitarNote', { type: 'stop' });
    expect(router.noteOff).toHaveBeenCalledWith(2, 50, 'guitar');
    host.setGuitar.mockClear();
    store.set('parts.2.params.bendRange', 7);
    expect(host.setGuitar).toHaveBeenLastCalledWith(expect.objectContaining({ bendRange: 7 }));
    host.emit('guitarNote', { type: 'pitch', voiced: true, freq: 110, midi: 45, clarity: 0.97 });
    expect(rig.status().guitar.pitch).toMatchObject({ freq: 110, midi: 45 });
  });

  it('ignores tracker notes while Guitar plays notes is off', async () => {
    const { host, router, rig } = setup();
    await rig.restore();
    host.emit('guitarNote', { type: 'noteOn', note: 50, velocity: 0.5 });
    expect(router.noteOn).not.toHaveBeenCalled();
  });
});

describe('pedal rig: capture', () => {
  it.each([
    ['sine', 220, { harmonics: 1 }, 57],
    ['saw', 110, { harmonics: 40, saw: true }, 45],
  ])('turns a held %s into a wavetable terrain on the selected part and selects it', { timeout: 60000 }, async (kind, freq, opts, midi) => {
    const { rig, store, captures } = setup({ samples: heldNote(freq, opts) });
    store.set('ui.selectedPart', 1);
    const r = await rig.captureNote();
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ part: 1, slot: 'A', name: `Guitar ${noteLabel(midi)}` });
    expect(Math.abs(1200 * Math.log2(r.freq / freq))).toBeLessThan(2);
    // Progress while recording, then analysing, then done with the pitch.
    expect(captures.map(c => c.stage)).toEqual(['recording', 'recording', 'recording', 'recording', 'recording', 'analysing', 'done']);
    expect(captures.filter(c => c.stage === 'recording').map(c => c.progress)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    // Stored like an imported WAV wavetable and selected in slot A.
    const ut = store.get('parts.1.userTerrain.A');
    expect(ut).toMatchObject({ kind: 'wavetable', w: 256, mirror: 1, name: `Guitar ${noteLabel(midi)}` });
    expect(ut.h).toBe(r.frames);
    expect(ut.h).toBeGreaterThanOrEqual(2);
    expect(base64ToBytes(ut.data).length).toBe(256 * ut.h);
    expect(base64ToBytes(ut.lo).length).toBe(256 * ut.h);
    expect(store.get('parts.1.params.terrainA')).toBe(TERRAIN_INDEX.user);
    expect(store.get('parts.0.userTerrain.A')).toBe(null);
    const dec = decodeUserTerrain(ut, 64);
    expect(dec.length).toBe(64 * 64);
    expect(dec.every(Number.isFinite)).toBe(true);
    expect(rig.status().guitar.capture).toMatchObject({ stage: 'done', note: expect.any(Number) });
  });

  it('does not play the synth from the held note while capturing, and resumes after', { timeout: 60000 }, async () => {
    let host;
    const ctx = setup({ prefs: { guitarNotes: true }, samples: () => {
      host.emit('guitarNote', { type: 'noteOn', note: 57, velocity: 0.5 });
      return { ok: true, samples: heldNote(220), sampleRate: SR };
    } });
    host = ctx.host;
    await ctx.rig.restore();
    const r = await ctx.rig.captureNote();
    expect(r.ok).toBe(true);
    expect(ctx.router.noteOn).not.toHaveBeenCalled();
    host.emit('guitarNote', { type: 'noteOn', note: 50, velocity: 0.5 });
    expect(ctx.router.noteOn).toHaveBeenCalledTimes(1);
  });

  it('writes to the guitar\'s fixed part and the chosen slot', { timeout: 60000 }, async () => {
    const { rig, store } = setup({ samples: heldNote(196, { harmonics: 6, saw: true }) });
    await rig.set({ guitarTarget: 3, captureSlot: 'B' });
    const r = await rig.captureNote();
    expect(r).toMatchObject({ ok: true, part: 3, slot: 'B' });
    expect(store.get('parts.3.userTerrain.B').kind).toBe('wavetable');
    expect(store.get('parts.3.params.terrainB')).toBe(TERRAIN_INDEX.user);
    expect(store.get('parts.3.userTerrain.A')).toBe(null);
  });

  it('explains a recording with no stable pitch and stores nothing', { timeout: 60000 }, async () => {
    const { rig, store, captures } = setup({ samples: noise() });
    const before = store.get('parts.0.params.terrainA');
    const r = await rig.captureNote();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/steady pitch/);
    expect(captures.at(-1)).toMatchObject({ stage: 'error', reason: expect.stringMatching(/steady pitch/) });
    expect(store.get('parts.0.userTerrain.A')).toBe(null);
    expect(store.get('parts.0.params.terrainA')).toBe(before);
  });

  it('passes on why the recording failed', async () => {
    const { rig, captures } = setup({ samples: () => ({ ok: false, reason: 'Turn on the pedal return first, so Orograph can hear the guitar.' }) });
    const r = await rig.captureNote();
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/pedal return/) });
    expect(captures.at(-1).stage).toBe('error');
  });

  it('says so without an engine', async () => {
    const rig = createPedalRig({ store: createStore(defaultState()), engine: null, storage: memStorage() });
    expect((await rig.captureNote()).reason).toMatch(/Web Audio/);
  });
});

describe('addUserTerrain', () => {
  it('stores and selects a terrain like an import, and refuses a damaged one', async () => {
    const store = createStore(defaultState());
    const data = Buffer.alloc(256 * 2).toString('base64');
    const ut = await addUserTerrain(store, 2, 'b', { name: 'x.wav', kind: 'wavetable', w: 256, h: 2, mirror: 1, data, extra: 1 });
    expect(ut).toEqual({ name: 'x', kind: 'wavetable', w: 256, h: 2, mirror: 1, data });
    expect(store.get('parts.2.userTerrain.B')).toEqual(ut);
    expect(store.get('parts.2.params.terrainB')).toBe(TERRAIN_INDEX.user);
    await expect(addUserTerrain(store, 2, 'A', { w: 1, h: 1, data: '' })).rejects.toThrow(/empty or damaged/);
    await expect(addUserTerrain(store, 9, 'A', { w: 256, h: 2, data })).rejects.toThrow(/no track/);
    await expect(addUserTerrain(store, 0, 'C', { w: 256, h: 2, data })).rejects.toThrow(/slot/);
  });
});
