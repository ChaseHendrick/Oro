// The looper control (shared by the top bar, the Loop tab, shortcuts and MIDI)
// over a fake engine.looper, and the Loop tab on the fake DOM.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { installFakeDom } from './fake-dom.js';
import {
  createLooperControl, sanitizeLooperPrefs, looperView, looperProgress, loopFileName, LOOPER_PREFS_KEY, LOOPER_PREF_DEFAULTS,
} from '../../src/ui/looper-control.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { TERRAIN_INDEX } from '../../src/dsp/catalog.js';
import { wavInfo } from '../../src/audio/wav.js';
import { createEmitter } from '../../src/audio/emitter.js';
import { createMemoryStorage } from '../music/fakes.js';

const SR = 48000;
function tone(freq = 220, seconds = 1.5) {
  const n = Math.round(seconds * SR);
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = 0.5 * Math.sin(2 * Math.PI * freq * i / SR) + 0.2 * Math.sin(4 * Math.PI * freq * i / SR);
  return { L, R: L.slice(), len: n, sampleRate: SR };
}

function fakeLooper({ loop = null } = {}) {
  const ev = createEmitter();
  const calls = [];
  let st = { state: loop ? 'play' : 'empty', len: loop ? loop.len : 0, pos: 0, layers: 0, muted: false, bars: 2, sampleRate: SR };
  const l = {
    available: true, reason: '', calls,
    status: () => ({ ...st }),
    on: (n, fn) => ev.on(n, fn),
    main: () => calls.push('main'), stop: () => calls.push('stop'), undo: () => calls.push('undo'), clear: () => calls.push('clear'),
    setBars: (v) => calls.push(`bars:${v}`), setVolume: (v) => calls.push(`volume:${v}`), setFeedback: (v) => calls.push(`feedback:${v}`),
    setMute: (v) => { calls.push(`mute:${v}`); st = { ...st, muted: v }; ev.emit('change', st); },
    getLoop: async () => (loop ? { ...loop } : null),
    capture: vi.fn(async () => tone(110, 2)),
    exportWav: async ({ format }) => new Blob([new (await import('../../src/audio/wav.js')).encodeWav([loop.L, loop.R], SR, { format })]),
    set(s) { st = { ...st, ...s }; ev.emit('change', st); },
  };
  return l;
}

function setup(opts = {}) {
  const store = createStore(defaultState());
  const looper = fakeLooper(opts);
  const toast = vi.fn();
  const download = vi.fn();
  const storage = opts.storage || createMemoryStorage();
  const ctl = createLooperControl({ store, engine: { looper }, toast, download, storage });
  return { store, looper, toast, download, storage, ctl };
}

describe('looper settings', () => {
  it('keeps only valid values', () => {
    expect(sanitizeLooperPrefs(null)).toEqual(LOOPER_PREF_DEFAULTS);
    expect(sanitizeLooperPrefs({ bars: 3, volume: 2, feedback: 0.5, slot: 'C', slice: 'root', root: 60, format: 'mp3' }))
      .toEqual({ ...LOOPER_PREF_DEFAULTS, feedback: 0.5, slice: 'root', root: 60 });
    expect(LOOPER_PREF_DEFAULTS.bars).toBe(2);
    expect(LOOPER_PREF_DEFAULTS.feedback).toBe(1);
  });

  it('sends the saved settings to the looper at start and saves changes', () => {
    const storage = createMemoryStorage();
    storage.setItem(LOOPER_PREFS_KEY, JSON.stringify({ bars: 4, feedback: 0.7 }));
    const { looper, ctl } = setup({ storage });
    expect(looper.calls).toEqual(['bars:4', 'volume:1', 'feedback:0.7']);
    ctl.setPref('bars', 8);
    ctl.setPref('bars', 5);            // refused
    expect(looper.calls.slice(-1)).toEqual(['bars:8']);
    expect(JSON.parse(storage.getItem(LOOPER_PREFS_KEY)).bars).toBe(8);
  });
});

describe('looper button view', () => {
  it('names the state and the next action', () => {
    expect(looperView({ state: 'empty' })).toMatchObject({ tone: 'idle', icon: 'record' });
    expect(looperView({ state: 'empty' }, { playing: true }).aria).toMatch(/next bar/);
    expect(looperView({ state: 'armed' }).tone).toBe('armed');
    expect(looperView({ state: 'record', recTarget: 10 }).aria).toMatch(/next bar/);
    expect(looperView({ state: 'play' })).toMatchObject({ tone: 'play', label: 'Play' });
    expect(looperView({ state: 'play', cue: true }).label).toBe('Cued');
    expect(looperView({ state: 'overdub' })).toMatchObject({ tone: 'overdub', label: 'Dub' });
    expect(looperView({ state: 'paused' }).tone).toBe('paused');
    expect(looperView({ state: 'play' }, { available: false }).tone).toBe('off');
  });

  it('works out the ring position, extrapolating between position reports', () => {
    expect(looperProgress({ state: 'empty' })).toBe(null);
    expect(looperProgress({ state: 'record', recPos: 50, recTarget: 200 })).toBe(0.25);
    expect(looperProgress({ state: 'record', recPos: 50, recTarget: 0 })).toBe(null);
    expect(looperProgress({ state: 'play', pos: 0, len: 48000, posAt: 1000, sampleRate: 48000 }, 1500)).toBeCloseTo(0.5, 6);
    expect(looperProgress({ state: 'play', pos: 24000, len: 48000, posAt: 1000, sampleRate: 48000 }, 1750)).toBeCloseTo(0.25, 6);
  });

  it('names exports by date', () => {
    expect(loopFileName(new Date(2026, 9, 2, 13, 4, 5))).toBe('oro-loop-20261002-130405.wav');
  });
});

describe('looper control', () => {
  it('routes buttons, shortcuts and MIDI actions', async () => {
    const { looper, ctl } = setup();
    await ctl.main(); await ctl.stop(); await ctl.undo(); await ctl.clear();
    await ctl.action('looper.main');
    ctl.toggleMute();
    expect(looper.calls.filter(c => !/^(bars|volume|feedback):/.test(c))).toEqual(['main', 'stop', 'undo', 'clear', 'main', 'mute:true']);
  });

  it('resamples the current loop into the selected part and chosen slot, as Resample 1, 2 ...', async () => {
    const { store, ctl, toast, looper } = setup({ loop: tone(220) });
    store.set('ui.selectedPart', 2);
    ctl.setPref('slot', 'B');
    const r1 = await ctl.resample();
    expect(r1).toMatchObject({ ok: true, name: 'Resample 1', part: 2, slot: 'B', mode: 'pitch' });
    expect(store.get('parts.2.userTerrain.B')).toMatchObject({ kind: 'wavetable', name: 'Resample 1' });
    expect(store.get('parts.2.params.terrainB')).toBe(TERRAIN_INDEX.user);
    expect(toast).toHaveBeenCalledWith('Resample 1 is on Part 3, terrain B', expect.objectContaining({ kind: 'success' }));
    const r2 = await ctl.resample();
    expect(r2.name).toBe('Resample 2');
    expect(looper.capture).not.toHaveBeenCalled();
  });

  it('records bars of the output when the looper is empty, and says when it sliced at the tempo', async () => {
    const { store, ctl, looper } = setup();
    ctl.setPref('bars', 1);
    looper.capture.mockImplementationOnce(async () => {
      // Noise: no pitch to find.
      let seed = 3;
      const L = new Float32Array(SR * 2).map(() => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed / 4294967296) * 2 - 1; });
      return { L, R: L, len: L.length, sampleRate: SR };
    });
    const r = await ctl.resample();
    expect(looper.capture).toHaveBeenCalledWith({ bars: 1 });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('tempo');
    expect(r.detail).toMatch(/No steady pitch found/);
    expect(store.get('parts.0.userTerrain.A').name).toBe('Resample 1');
  });

  it('exports the loop as a dithered 24-bit WAV (or 32-bit float) and names the file', async () => {
    const { ctl, download, looper } = setup({ loop: tone(220, 0.5) });
    let blob = await ctl.exportWav();
    expect(download).toHaveBeenCalledWith(blob, expect.stringMatching(/^oro-loop-\d{8}-\d{6}\.wav$/));
    expect(wavInfo(new Uint8Array(await blob.arrayBuffer()))).toMatchObject({ bitsPerSample: 24, float: false, sampleRate: SR, channels: 2 });
    ctl.setPref('format', 'float32');
    blob = await ctl.exportWav();
    expect(wavInfo(new Uint8Array(await blob.arrayBuffer()))).toMatchObject({ bitsPerSample: 32, float: true });
    looper.set({ len: 0, state: 'empty' });
    expect(await ctl.exportWav()).toBe(null);
  });

  it('explains itself when there is no looper', async () => {
    const toast = vi.fn();
    const ctl = createLooperControl({ store: createStore(defaultState()), engine: null, toast, storage: createMemoryStorage() });
    expect(ctl.available).toBe(false);
    await ctl.main();
    expect(toast).toHaveBeenCalledWith('The looper is not available', expect.objectContaining({ detail: expect.stringMatching(/audio engine/) }));
  });
});

describe('Loop tab', () => {
  let dom, createLooperPanel, looperStatusText;
  beforeAll(async () => {
    dom = installFakeDom();
    ({ createLooperPanel, looperStatusText } = await import('../../src/ui/looper-panel.js'));
  });
  afterAll(() => dom.restore());

  it('describes every state in plain words, without em dashes', () => {
    const base = { available: true, sampleRate: 48000, bars: 2, prefs: {} };
    const texts = [
      looperStatusText({ ...base, state: 'empty' }),
      looperStatusText({ ...base, state: 'armed' }),
      looperStatusText({ ...base, state: 'record', recPos: 100000, recTarget: 192000 }),
      looperStatusText({ ...base, state: 'record', recPos: 96000, recTarget: 0 }),
      looperStatusText({ ...base, state: 'play', len: 192000, loopBars: 2, layers: 3 }),
      looperStatusText({ ...base, state: 'overdub', len: 96000, loopBars: 1 }),
      looperStatusText({ ...base, state: 'paused', len: 96000 }),
      looperStatusText({ ...base, busy: 'capture' }),
      looperStatusText({ available: false, reason: 'No AudioWorklet here.' }),
    ];
    expect(texts[2]).toBe('Recording bar 2 of 2.');
    expect(texts[3]).toMatch(/2\.0 s/);
    expect(texts[4]).toBe('Playing 2 bars, 4.0 s, 3 layers to undo.');
    expect(texts[8]).toBe('No AudioWorklet here.');
    for (const t of texts) expect(t).not.toMatch(/\u2014/);
  });

  it('builds the panel, labels its buttons and drives the looper', async () => {
    const { store, ctl, looper } = setup({ loop: tone(220, 0.5) });
    const ctx = { store, looper: ctl, layers: null, midiOk: () => false, findMapping: () => null, learn: null };
    const panel = createLooperPanel(ctx);
    dom.flush();
    const buttons = panel.el.querySelectorAll('button');
    const byLabel = (re) => buttons.find(b => re.test(b.getAttribute('aria-label') || ''));
    const main = byLabel(/Loop playing/);
    expect(main).toBeTruthy();
    expect(main.dataset.tone).toBe('play');
    main.click();
    byLabel(/Undo the last overdub/);                  // present (disabled with no layers)
    expect(byLabel(/Undo the last overdub/).disabled).toBe(true);
    looper.set({ layers: 2 });
    dom.flush();
    expect(byLabel(/Undo the last overdub/).disabled).toBe(false);
    byLabel(/Undo the last overdub/).click();
    byLabel(/Mute the loop/).click();
    await new Promise(r => setTimeout(r, 0));
    expect(looper.calls).toContain('main');
    expect(looper.calls).toContain('undo');
    expect(looper.calls).toContain('mute:true');
    dom.flush();
    expect(byLabel(/Mute the loop/).getAttribute('aria-pressed')).toBe('true');
    const status = panel.el.querySelector('p.loop-status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    panel.dispose();
  });
});

describe('looper undo toast (2.11)', () => {
  it('stays quiet while quietUndo() says the key belonged to something else', () => {
    const looper = fakeLooper();
    const ev = createEmitter();
    looper.on = (n, fn) => ev.on(n, fn);
    let quiet = true;
    const toast = vi.fn();
    createLooperControl({ store: createStore(defaultState()), engine: { looper }, toast, quietUndo: () => quiet, storage: createMemoryStorage() });
    ev.emit('info', { reason: 'nothing-to-undo' });
    expect(toast).not.toHaveBeenCalled();
    quiet = false;
    ev.emit('info', { reason: 'nothing-to-undo' });
    expect(toast).toHaveBeenCalledWith('Nothing to undo', expect.anything());
  });
});
