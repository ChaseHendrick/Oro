// v2.8 Follow tempo: the looper core's replace message and the looper
// control's time-stretch fit.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { LooperCore, loopFrames } from '../../src/audio/looper-core.js';
import { createLooperControl, sanitizeLooperPrefs, LOOPER_PREF_DEFAULTS } from '../../src/ui/looper-control.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createEmitter } from '../../src/audio/emitter.js';
import { createMemoryStorage } from '../music/fakes.js';

const SR = 48000, BLOCK = 128;

function rig() {
  const msgs = [];
  const core = new LooperCore(SR, { emit: (m) => msgs.push(m) });
  let frame = 0;
  const iL = new Float32Array(BLOCK), oL = new Float32Array(BLOCK), oR = new Float32Array(BLOCK);
  const out = [];
  return {
    core, msgs, out,
    send(m) { core.handle(m, frame); },
    run(n, input = () => 0) {
      for (let b = 0; b < Math.ceil(n / BLOCK); b++) {
        for (let i = 0; i < BLOCK; i++) iL[i] = input(frame + i);
        core.process(iL, iL, oL, oR, BLOCK, frame);
        for (let i = 0; i < BLOCK; i++) out.push(oL[i]);
        frame += BLOCK;
      }
    },
  };
}
const sine = (f, n) => Float32Array.from({ length: n }, (_, i) => 0.4 * Math.sin(2 * Math.PI * f * i / SR));

/** A one-bar loop recorded at 120 BPM, playing. */
function recorded() {
  const r = rig();
  r.send({ t: 'bars', v: 1 });
  r.send({ t: 'transport', playing: true, beatTime: 0, beat: 0, spb: 0.5 });
  r.send({ t: 'main' });
  r.run(96000 + BLOCK, (f) => 0.4 * Math.sin(2 * Math.PI * 200 * f / SR));
  return r;
}

describe('looper core: replace (Follow tempo)', () => {
  it('records the beat length and counts edits', () => {
    const r = recorded();
    expect(r.core.state).toBe('play');
    expect(r.core.len).toBe(96000);
    expect(r.core.loopBars).toBe(1);
    expect(r.core.loopSpb).toBe(0.5);
    expect(r.core.edit).toBe(1);
    expect(r.core.info()).toMatchObject({ edit: 1, loopSpb: 0.5 });
  });

  it('swaps in stretched audio, keeps the position in proportion and keeps the undo layers', () => {
    const r = recorded();
    r.send({ t: 'main' }); r.run(1024); r.send({ t: 'main' });   // one overdub layer
    expect(r.core.layers.length).toBe(1);
    const edit = r.core.edit;
    const pos = r.core.pos;
    const L = sine(200, 72000), R = sine(200, 72000);
    r.send({ t: 'replace', id: 7, L, R, base: edit, spb: 0.375, bars: 1 });
    expect(r.msgs.filter(m => m.t === 'replaced').pop()).toEqual({ t: 'replaced', id: 7, ok: true, edit: edit + 1 });
    expect(r.core.len).toBe(72000);
    expect(r.core.pos).toBe(Math.floor(pos * 72000 / 96000));
    expect(r.core.layers).toHaveLength(2);   // the overdub, then the audio from before the stretch
    expect(r.core.loopSpb).toBe(0.375);
    expect(r.core.loopBars).toBe(1);
    // crossfades without a click and then plays the new audio
    r.out.length = 0;
    r.run(4096);
    expect(r.out.every(Number.isFinite)).toBe(true);
    let jump = 0;
    for (let i = 1; i < r.out.length; i++) jump = Math.max(jump, Math.abs(r.out[i] - r.out[i - 1]));
    expect(jump).toBeLessThan(0.08);
    r.run(80000);
    expect(r.core.pos).toBeLessThan(72000);
  });

  it('undo after a stretch brings back the audio from before it, then the older overdubs (v2.9)', () => {
    const r = recorded();
    const original = Float32Array.from(r.core.L);
    r.send({ t: 'main' }); r.run(1024, () => 0.2); r.send({ t: 'main' });   // an overdub
    r.run(256);
    const overdubbed = Float32Array.from(r.core.L);
    const L = sine(200, 72000), R = sine(200, 72000);
    r.send({ t: 'replace', id: 1, L, R, base: r.core.edit, spb: 0.375, bars: 1 });
    expect(r.core.len).toBe(72000);
    r.send({ t: 'undo' });
    expect(r.core.len).toBe(96000);
    expect(r.core.loopSpb).toBe(0.5);
    expect(Array.from(r.core.L)).toEqual(Array.from(overdubbed));
    expect(r.core.pos).toBeLessThan(96000);
    r.send({ t: 'undo' });
    expect(r.core.len).toBe(96000);
    expect(Array.from(r.core.L)).toEqual(Array.from(original));
    expect(r.core.layers).toHaveLength(0);
    r.run(4096);
    expect(r.out.every(Number.isFinite)).toBe(true);
  });

  it('refuses a stale copy, a wrong shape and a loop that is recording or overdubbing', () => {
    const r = recorded();
    const ok = (m) => { r.send({ t: 'replace', id: 1, ...m }); return r.msgs.filter(x => x.t === 'replaced').pop().ok; };
    expect(ok({ L: sine(200, 50000), R: sine(200, 50000), base: r.core.edit - 1 })).toBe(false);
    expect(ok({ L: sine(200, 50000), R: sine(200, 40000), base: r.core.edit })).toBe(false);
    expect(ok({ L: [1, 2], R: [1, 2], base: r.core.edit })).toBe(false);
    r.send({ t: 'main' });   // overdub
    expect(ok({ L: sine(200, 50000), R: sine(200, 50000) })).toBe(false);
    expect(r.core.len).toBe(96000);
    const empty = rig();
    empty.send({ t: 'replace', id: 2, L: sine(200, 50000), R: sine(200, 50000) });
    expect(empty.msgs.pop()).toEqual({ t: 'replaced', id: 2, ok: false, edit: 0 });
  });
});

function fakeLooper(loop) {
  const ev = createEmitter();
  const replaced = [];
  let st = { state: 'play', len: loop.len, pos: 0, layers: 0, bars: 2, sampleRate: SR, loopBars: loop.loopBars, loopSpb: loop.loopSpb, edit: loop.edit };
  return {
    available: true, reason: '', replaced, gets: 0,
    status: () => ({ ...st }),
    on: (n, fn) => ev.on(n, fn),
    setBars() {}, setVolume() {}, setFeedback() {},
    async getLoop() { this.gets++; return { ...loop, L: loop.L.slice(), R: loop.R.slice() }; },
    async replaceLoop(m) {
      replaced.push(m);
      st = { ...st, len: m.L.length, loopSpb: m.spb, loopBars: m.bars, edit: st.edit + 1 };
      ev.emit('change', st);
      return { ok: true, edit: st.edit };
    },
    set(s) { st = { ...st, ...s }; ev.emit('change', st); },
  };
}

describe('looper control: Fit to tempo and Follow tempo', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps the new preference off by default', () => {
    expect(LOOPER_PREF_DEFAULTS.follow).toBe(0);
    expect(sanitizeLooperPrefs({ follow: 1 }).follow).toBe(1);
    expect(sanitizeLooperPrefs({ follow: 'yes' }).follow).toBe(0);
  });

  it('stretches a bar loop to its bars at the new tempo, keeping the pitch', async () => {
    const n = loopFrames(2, 0.5, SR);
    const looper = fakeLooper({ L: sine(250, n), R: sine(250, n), len: n, sampleRate: SR, loopBars: 2, loopSpb: 0.5, edit: 3 });
    const store = createStore(defaultState());
    store.set('global.tempo', 150);
    const toast = vi.fn();
    const ctl = createLooperControl({ store, engine: { looper }, toast, storage: createMemoryStorage() });
    const res = await ctl.fitToTempo();
    expect(res).toMatchObject({ ok: true, bars: 2 });
    const m = looper.replaced[0];
    expect(m.L.length).toBe(loopFrames(2, 0.4, SR));
    expect(m).toMatchObject({ base: 3, spb: 0.4, bars: 2 });
    let zc = 0;
    for (let i = 1; i < m.L.length; i++) if (m.L[i - 1] < 0 && m.L[i] >= 0) zc++;
    expect(Math.abs(zc / (m.L.length / SR) / 250 - 1)).toBeLessThan(0.01);
    // A second change stretches again from the untouched original (no new fetch).
    store.set('global.tempo', 100);
    await ctl.fitToTempo();
    expect(looper.gets).toBe(1);
    expect(looper.replaced[1].L.length).toBe(loopFrames(2, 0.6, SR));
    ctl.dispose();
  });

  it('fits a free-length loop to whole bars', async () => {
    const n = Math.round(3.9 * SR);
    const looper = fakeLooper({ L: sine(200, n), R: sine(200, n), len: n, sampleRate: SR, loopBars: 0, loopSpb: 0, edit: 1 });
    const store = createStore(defaultState());
    store.set('global.tempo', 120);
    const ctl = createLooperControl({ store, engine: { looper }, toast: vi.fn(), storage: createMemoryStorage() });
    expect(await ctl.fitToTempo()).toMatchObject({ ok: true, bars: 2 });
    expect(looper.replaced[0].L.length).toBe(loopFrames(2, 0.5, SR));
    ctl.dispose();
  });

  it('follows tempo changes only when Follow tempo is on, and not while overdubbing', async () => {
    vi.useFakeTimers();
    const n = loopFrames(1, 0.5, SR);
    const looper = fakeLooper({ L: sine(200, n), R: sine(200, n), len: n, sampleRate: SR, loopBars: 1, loopSpb: 0.5, edit: 1 });
    const store = createStore(defaultState());
    store.set('global.tempo', 120);
    const ctl = createLooperControl({ store, engine: { looper }, toast: vi.fn(), storage: createMemoryStorage() });
    store.set('global.tempo', 140);
    await vi.advanceTimersByTimeAsync(1000);
    expect(looper.replaced).toHaveLength(0);
    ctl.setPref('follow', 1);
    looper.set({ state: 'overdub' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(looper.replaced).toHaveLength(0);
    looper.set({ state: 'play' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(looper.replaced).toHaveLength(1);
    expect(looper.replaced[0].L.length).toBe(loopFrames(1, 60 / 140, SR));
    // already in time: nothing more to do
    await vi.advanceTimersByTimeAsync(1000);
    expect(looper.replaced).toHaveLength(1);
    ctl.dispose();
  });
});
