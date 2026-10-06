import { describe, it, expect } from 'vitest';
import { createAgentApi, installBridge, agentOptIn, noteNumber, paramValue, HELP, MUTATING } from '../../src/agent/api.js';
import { createStore } from '../../src/core/store.js';
import { defaultState, PART_PARAM_MAP } from '../../src/core/params.js';
import { createMusic } from '../../src/music/music.js';
import { createPresets } from '../../src/presets/presets.js';
import { createFakeClock, createFakeEngine } from '../music/fakes.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

async function setup() {
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  const store = createStore(defaultState());
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  const presets = createPresets({ store, storage: memoryStorage() });
  await presets.ready;
  const history = { undone: 0, undo() { this.undone++; }, redo() {} };
  const api = createAgentApi({ store, engine, music, presets, getUi: () => ({ history }), version: '9.9.9', timers: clock.timers });
  return { clock, engine, store, music, presets, api, history };
}

describe('agent api helpers', () => {
  it('reads note names and numbers', () => {
    expect(noteNumber('A4')).toBe(69);
    expect(noteNumber('C#3')).toBe(49);
    expect(noteNumber('Bb2')).toBe(46);
    expect(noteNumber(60)).toBe(60);
    expect(noteNumber('H4')).toBeNaN();
  });
  it('turns option names into enum values and clamps numbers', () => {
    expect(paramValue(PART_PARAM_MAP.filterType, 'Ladder warm')).toEqual({ value: 7 });
    expect(paramValue(PART_PARAM_MAP.filterType, 'nope').error).toMatch(/not one of/);
    expect(paramValue(PART_PARAM_MAP.cutoff, 1e9)).toMatchObject({ value: PART_PARAM_MAP.cutoff.max, clamped: true });
    expect(paramValue(PART_PARAM_MAP.unison, 3.6).value).toBe(4);
  });
  it('documents every method it has', async () => {
    const { api } = await setup();
    for (const m of HELP) expect(typeof api[m.name], m.name).toBe('function');
    for (const name of MUTATING) expect(typeof api[name], name).toBe('function');
  });
  it('knows when a page opted in', () => {
    expect(agentOptIn({ search: '?agent=1', hash: '' })).toBe(true);
    expect(agentOptIn({ search: '?agent', hash: '' })).toBe(true);
    expect(agentOptIn({ search: '', hash: '#agent' })).toBe(true);
    expect(agentOptIn({ search: '?agent=0', hash: '' })).toBe(false);
    expect(agentOptIn({ search: '', hash: '#p=abc' })).toBe(false);
  });
});

describe('agent api', () => {
  it('describes the session and its state', async () => {
    const { api } = await setup();
    const d = api.describe();
    expect(d.ok).toBe(true);
    expect(d.text).toMatch(/wave terrain/);
    const s = api.state();
    expect(s.tracks).toHaveLength(4);
    expect(s.tracks[0]).toMatchObject({ index: 0, dot: { mode: 'Pin' } });
  });

  it('sets parameters by name, clamped and as undoable agent edits', async () => {
    const { api, store } = await setup();
    const seen = [];
    store.subscribe('parts', (path, value, meta) => seen.push(meta && meta.source));
    const r = api.set(0, { cutoff: 1200, filterType: 'SEM', nonsense: 1 });
    expect(r.ok).toBe(false);
    expect(r.set).toEqual({ cutoff: 1200, filterType: 10 });
    expect(r.errors[0].param).toBe('nonsense');
    expect(store.get('parts.0.params.cutoff')).toBe(1200);
    expect(seen).toContain('agent');
    expect(api.set('Track 2', 'resonance', 0.4).track).toBe(1);
    expect(api.set(99, 'cutoff', 1).ok).toBe(false);
    expect(api.setGlobal({ tempo: 300 }).set.tempo).toBe(240);
  });

  it('lists and loads patches and scenes by name', async () => {
    const { api, store } = await setup();
    const bass = api.patches({ category: 'Bass' });
    expect(bass.patches.length).toBeGreaterThan(3);
    expect(api.loadPatch(1, 'basalt bass')).toMatchObject({ ok: true, patch: 'Basalt Bass' });
    expect(store.get('parts.1.patchName')).toBe('Basalt Bass');
    expect(api.loadPatch(1, 'no such patch').ok).toBe(false);
    expect(api.scenes().scenes.length).toBeGreaterThan(0);
  });

  it('adds, names and removes tracks', async () => {
    const { api, store } = await setup();
    const r = api.addTrack({ name: 'Strings', patch: 'Tidal Flats' });
    expect(r.ok).toBe(true);
    expect(store.get(`parts.${r.track}.name`)).toBe('Strings');
    expect(store.get(`parts.${r.track}.patchName`)).toBe('Tidal Flats');
    expect(api.removeTrack('Strings')).toMatchObject({ ok: true, removed: r.track });
    expect(store.get('parts')).toHaveLength(4);
  });

  it('plays notes and chords on a track', async () => {
    const { api, engine, clock } = await setup();
    expect(api.note(0, 'A4', { dur: 0.1 }).ok).toBe(true);
    expect(api.chord(1, 'Am7', { dur: 0.1 })).toMatchObject({ ok: true, notes: [69, 72, 76, 79] });
    clock.advance(0.3);
    expect(engine.ons().some((e) => e.part === 0 && e.note === 69)).toBe(true);
    expect(engine.offs().some((e) => e.part === 1 && e.note === 79)).toBe(true);
    expect(api.note(0, 'Z9').ok).toBe(false);
  });

  it('writes a sequencer pattern and moves the dot', async () => {
    const { api, store } = await setup();
    expect(api.pattern(0, [0, null, 2, null, { degree: 4, accent: 1 }])).toMatchObject({ ok: true });
    const steps = store.get('parts.0.patterns.0.steps');
    expect(steps[0]).toMatchObject({ on: 1, degree: 0 });
    expect(steps[1].on).toBe(0);
    expect(steps[4]).toMatchObject({ on: 1, degree: 4, accent: 1 });
    expect(store.get('parts.0.seqOn')).toBe(1);
    expect(api.dot(0, { x: 0.25, y: 1.75, mode: 'roll', cruise: 0.6 })).toMatchObject({ ok: true, mode: 'Roll' });
    expect(store.get('parts.0.params.centerX')).toBe(0.25);
    expect(store.get('parts.0.params.centerY')).toBe(0.75);
    expect(store.get('parts.0.dot')).toMatchObject({ mode: 1, cruise: 0.6 });
  });

  it('runs the score desk and undo through the same object', async () => {
    const { api, history } = await setup();
    const r = api.play('title A\nbpm 120\nbars 1\nviolin A4 0 1 0.8\n');
    expect(r.ok).toBe(true);
    expect(api.status()).toMatchObject({ ok: true, playing: true, title: 'A' });
    expect(api.stop().ok).toBe(true);
    expect(api.compose({ style: 'strings' }).ok).toBe(true);
    expect(api.undo().ok).toBe(true);
    expect(history.undone).toBe(1);
  });
});

describe('postMessage bridge', () => {
  function fakeWindow() {
    const listeners = new Set();
    return {
      addEventListener: (t, fn) => listeners.add(fn),
      removeEventListener: (t, fn) => listeners.delete(fn),
      async send(data, source) { for (const fn of listeners) await fn({ data, source, origin: 'https://agent.example' }); },
    };
  }
  function replies() {
    const got = [];
    return { got, postMessage: (msg, origin) => got.push({ msg, origin }) };
  }

  it('answers calls with ids and keeps the 2.16 message shape working', async () => {
    const { api } = await setup();
    const win = fakeWindow(), src = replies();
    installBridge(win, api, { allowMutating: () => false });
    await win.send({ source: 'oro-agent', id: 7, type: 'schema' }, src);
    expect(src.got[0].msg).toMatchObject({ source: 'oro', id: 7, type: 'schema', ok: true });
    expect(src.got[0].origin).toBe('https://agent.example');
    await win.send({ source: 'oro-agent', type: 'play', score: 'bpm 120\nbars 1\nviolin A4 0 1 0.8\n' }, src);
    expect(src.got[1].msg.receipt.ok).toBe(true);
    await win.send({ source: 'oro-agent', id: 'c', type: 'compose', prompt: 'strings' }, src);
    expect(src.got[2].msg.result.score.style).toBe('strings');
    await win.send({ source: 'not-oro', type: 'schema' }, src);
    expect(src.got).toHaveLength(3);
  });

  it('refuses session changes unless the page opted in', async () => {
    const { api, store } = await setup();
    const win = fakeWindow(), src = replies();
    let allowed = false;
    installBridge(win, api, { allowMutating: () => allowed });
    await win.send({ source: 'oro-agent', id: 1, type: 'set', args: [0, 'cutoff', 999] }, src);
    expect(src.got[0].msg).toMatchObject({ ok: false });
    expect(src.got[0].msg.error).toMatch(/agent=1/);
    expect(store.get('parts.0.params.cutoff')).not.toBe(999);
    allowed = true;
    await win.send({ source: 'oro-agent', id: 2, type: 'set', args: [0, 'cutoff', 999] }, src);
    expect(src.got[1].msg).toMatchObject({ ok: true });
    expect(store.get('parts.0.params.cutoff')).toBe(999);
    await win.send({ source: 'oro-agent', id: 3, type: 'nonsense' }, src);
    expect(src.got[2].msg.error).toMatch(/no nonsense/);
  });

  it('forwards score events to subscribers', async () => {
    const { api, clock } = await setup();
    const win = fakeWindow(), src = replies();
    installBridge(win, api);
    await win.send({ source: 'oro-agent', id: 's', type: 'subscribe', events: ['score'] }, src);
    expect(src.got[0].msg.result.events).toEqual(['score']);
    api.play('title E\nbpm 120\nbars 1\ncue go 2\nviolin A4 0 2 0.8\n');
    clock.advance(1.5);
    const events = src.got.filter((g) => g.msg.type === 'event').map((g) => g.msg.data.type);
    expect(events).toEqual(expect.arrayContaining(['start', 'cue']));
  });
});
