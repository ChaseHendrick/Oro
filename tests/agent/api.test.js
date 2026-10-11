import { describe, it, expect } from 'vitest';
import { createAgentApi, installBridge, agentOptIn, noteNumber, paramValue, HELP, MUTATING } from '../../src/agent/api.js';
import { createStore } from '../../src/core/store.js';
import { defaultState, PART_PARAM_MAP } from '../../src/core/params.js';
import { createMusic } from '../../src/music/music.js';
import { createPresets } from '../../src/presets/presets.js';
import { moveTrack } from '../../src/core/tracks.js';
import { createFakeClock, createFakeEngine } from '../music/fakes.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

async function setup({ visuals = null } = {}) {
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  const store = createStore(defaultState());
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  const presets = createPresets({ store, storage: memoryStorage() });
  await presets.ready;
  const history = { undone: 0, undo() { this.undone++; }, redo() {} };
  const api = createAgentApi({ store, engine, music, presets, visuals, getUi: () => ({ history }), version: '9.9.9', timers: clock.timers });
  return { clock, engine, store, music, presets, api, history };
}

describe('agent api helpers', () => {
  it('reads note names and numbers', () => {
    expect(noteNumber('A4')).toBe(69);
    expect(noteNumber('C#3')).toBe(49);
    expect(noteNumber('Bb2')).toBe(46);
    expect(noteNumber('B#3')).toBe(60);
    expect(noteNumber('Cb4')).toBe(59);
    expect(noteNumber(60)).toBe(60);
    expect(noteNumber('H4')).toBeNaN();
    for (const n of [-1, 128, 60.5, Infinity]) expect(noteNumber(n)).toBeNaN();
  });
  it('turns option names into enum values and clamps numbers', () => {
    expect(paramValue(PART_PARAM_MAP.filterType, 'Ladder warm')).toEqual({ value: 7 });
    expect(paramValue(PART_PARAM_MAP.filterType, 'nope').error).toMatch(/not one of/);
    expect(paramValue(PART_PARAM_MAP.cutoff, 1e9)).toMatchObject({ value: PART_PARAM_MAP.cutoff.max, clamped: true });
    expect(paramValue(PART_PARAM_MAP.unison, 3.6).value).toBe(4);
    for (const value of [null, undefined, '', ' ', [], {}, Infinity, NaN]) expect(paramValue(PART_PARAM_MAP.cutoff, value).error).toMatch(/number/);
  });
  it('documents every method it has', async () => {
    const { api } = await setup();
    for (const m of HELP) expect(typeof api[m.name], m.name).toBe('function');
    for (const name of MUTATING) expect(typeof api[name], name).toBe('function');
    for (const [name, value] of Object.entries(api)) if (typeof value === 'function') expect(HELP.some((m) => m.name === name), name).toBe(true);
    expect(api.help().methods.find((m) => m.name === 'dot')).toMatchObject({ requiresAgentOptIn: true });
    api.help().methods[0].name = 'changed';
    expect(api.help().methods[0].name).toBe('help');
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
    const before = store.get('parts.0.params.cutoff');
    const r = api.set(0, { cutoff: 1200, filterType: 'SEM', nonsense: 1 });
    expect(r.ok).toBe(false);
    expect(r.set).toEqual({});
    expect(r.errors[0].param).toBe('nonsense');
    expect(store.get('parts.0.params.cutoff')).toBe(before);
    expect(seen).toEqual([]);
    expect(api.set(0, { cutoff: 1200, filterType: 'SEM' })).toMatchObject({ ok: true, set: { cutoff: 1200, filterType: 10 } });
    expect(seen).toContain('agent');
    expect(api.set('Track 2', 'resonance', 0.4).track).toBe(1);
    expect(api.set(99, 'cutoff', 1).ok).toBe(false);
    expect(api.setGlobal({ tempo: 300 }).set.tempo).toBe(240);
  });

  it('rejects malformed parameter batches and preserves all values on global errors', async () => {
    const { api, store } = await setup();
    const before = store.serialize();
    for (const values of [null, [], {}, true, { cutoff: null }, { cutoff: '' }, { constructor: 1 }]) expect(api.set(0, values).ok).toBe(false);
    expect(api.setGlobal({ tempo: 130, scaleRoot: 'not a key' }).ok).toBe(false);
    expect(api.setGlobal({ tempo: 130, scaleType: 'not a scale' }).ok).toBe(false);
    expect(store.serialize()).toEqual(before);
    expect(api.setGlobal({ scaleRoot: 'Bb', scaleType: 'Minor' })).toMatchObject({ ok: true, set: { scaleRoot: 10, scaleType: 1 } });
    expect(api.params(0).params.find((p) => p.id === 'cutoff')).toMatchObject({ curve: 'exp', min: PART_PARAM_MAP.cutoff.min });
  });

  it('uses stable track ids when names are duplicated', async () => {
    const { api, store } = await setup();
    const id = store.get('parts.1.id');
    store.set('parts.1.name', store.get('parts.0.name'));
    expect(api.set('Track 1', 'cutoff', 555).ok).toBe(false);
    expect(api.set(id, 'cutoff', 555)).toMatchObject({ ok: true, track: 1 });
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

  it('resolves exact or unique library names before making changes', async () => {
    const { api, store } = await setup();
    const before = store.serialize();
    expect(api.loadPatch(0, '').ok).toBe(false);
    expect(api.loadPatch(0, 'bass')).toMatchObject({ ok: false, matches: expect.any(Array) });
    expect(api.loadScene('').ok).toBe(false);
    for (const options of [{ patch: 'not a patch' }, { patch: 'bass' }, { patch: null }, { name: '' }, { name: [] }, { patches: 'Basalt Bass' }, null]) expect(api.addTrack(options).ok).toBe(false);
    expect(store.serialize()).toEqual(before);
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

  it('rejects malformed performance commands before playing any notes', async () => {
    const { api, engine } = await setup();
    for (const opts of [{ dur: -1 }, { dur: NaN }, { dur: 3e6 }, { vel: 1.1 }, { velocity: 0.5 }, null]) expect(api.note(0, 60, opts).ok).toBe(false);
    for (const notes of [[], ['C4', 'H4'], [60, 128], 'Gmaj9']) expect(api.chord(0, notes).ok).toBe(false);
    expect(engine.ons()).toEqual([]);
  });

  it('extends retriggered agent notes and leaves keyboard and other-track notes held', async () => {
    const { api, music, engine, clock } = await setup();
    music.router.noteOn(0, 60, 0.8, 'ui');
    api.note(0, 60, { dur: 0.4 });
    api.note(1, 60, { dur: 0.7 });
    clock.advance(0.2);
    api.note(0, 60, { dur: 0.6 });
    engine.clear(); // the router rearticulates a pitch at each note-on
    clock.advance(0.25);
    expect(music.router.heldNotes(0)).toContain(60);
    expect(music.router.heldNotes(1)).toContain(60);
    expect(engine.offs(0)).toHaveLength(0);
    clock.advance(0.4);
    expect(music.router.heldNotes(0)).toContain(60);
    expect(music.router.heldNotes(1)).not.toContain(60);
    music.router.noteOff(0, 60, 'ui');
    expect(engine.offs(0)).toHaveLength(1);
  });

  it('releases the original track after a reorder', async () => {
    const { api, store, music, clock } = await setup();
    api.note(0, 60, { dur: 0.2 });
    moveTrack(store, 0, 2);
    expect(music.router.heldNotes(2)).toContain(60);
    clock.advance(0.3);
    expect(music.router.heldNotes(2)).not.toContain(60);
  });

  it('cancels old agent deadlines when Panic, session load or track removal interrupts', async () => {
    for (const interruption of ['panic', 'load', 'remove']) {
      const { api, store, music, clock } = await setup();
      api.note(0, 60, { dur: 0.4 });
      clock.advance(0.1);
      if (interruption === 'panic') music.router.allNotesOff();
      else if (interruption === 'load') store.load(defaultState());
      else api.removeTrack(0);
      api.note(0, 60, { dur: 0.8 });
      clock.advance(0.4);
      expect(music.router.heldNotes(0), interruption).toContain(60);
      clock.advance(0.5);
      expect(music.router.heldNotes(0), interruption).not.toContain(60);
    }
  });

  it('releases agent notes on a same-id load without losing a keyboard-held pitch', async () => {
    const { api, store, music, clock, engine } = await setup();
    music.router.noteOn(0, 60, 0.8, 'ui');
    api.note(0, 60, { dur: 0.4 });
    api.note(0, 64, { dur: 0.4 });
    clock.advance(0.1);
    engine.clear();
    store.load(defaultState());
    expect(music.router.heldNotes(0)).toEqual(new Set([60]));
    expect(engine.offs(0).map((e) => e.note)).toEqual([64]);
    clock.advance(1);
    expect(music.router.heldNotes(0)).toEqual(new Set([60]));
    expect(engine.offs(0).map((e) => e.note)).toEqual([64]);
    music.router.noteOff(0, 60, 'ui');
    expect(music.router.heldNotes(0).size).toBe(0);
  });

  it('leaves no old agent source held when a different pitch follows a session load', async () => {
    const { api, store, music, clock } = await setup();
    api.note(0, 60, { dur: 0.4 });
    clock.advance(0.1);
    store.load(defaultState());
    expect(music.router.heldNotes(0).size).toBe(0);
    api.note(0, 67, { dur: 0.8 });
    clock.advance(0.4);
    expect(music.router.heldNotes(0)).toEqual(new Set([67]));
    clock.advance(0.5);
    expect(music.router.heldNotes(0).size).toBe(0);
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
    expect(api.dot(0, { x: -0.25, y: 2.25, bounce: 4 })).toMatchObject({ ok: true, x: 0.75, y: 0.25, bounce: 0.95 });
  });

  it('rejects invalid map options atomically and sends validated touches', async () => {
    const touches = [];
    const { api, store } = await setup({ visuals: { touch: (ev) => { touches.push(ev); return ev; } } });
    const before = store.serialize();
    for (const opts of [{ x: 0.1, mode: 'Rolling' }, { x: 0.1, mode: 1.5 }, { x: '0.3' }, { x: NaN }, { cruise: null }, { keepRolling: true }, null]) expect(api.dot(0, opts).ok).toBe(false);
    expect(store.serialize()).toEqual(before);
    for (const opts of [{ phase: 'drag' }, { mode: 'Move' }, { x: null }, { y: Infinity }, { u: 0.3 }, null]) expect(api.touch(opts).ok).toBe(false);
    expect(touches).toEqual([]);
    expect(api.touch({ x: -0.25, y: 1.25, mode: 'fx', phase: 'down' })).toMatchObject({ ok: true, u: 0.75, v: 0.25, phase: 'down' });
    expect(api.touch({ phase: 'up', mode: 'fx' }).ok).toBe(true);
  });

  it('rejects malformed patterns without replacing the active pattern or enabling playback', async () => {
    const { api, store } = await setup();
    const before = store.serialize();
    for (const steps of [[], new Array(17).fill(0), [0, '2'], [undefined], [0, NaN], [{ degree: 29 }], [{ vel: '0.8' }], [{ gate: 0 }], [{ ratchet: 5 }], [{ degre: 2 }]]) expect(api.pattern(0, steps).ok).toBe(false);
    expect(api.pattern(0, [0], { on: 1 }).ok).toBe(false);
    expect(store.serialize()).toEqual(before);
    expect(api.pattern(0, [{ degree: 0, accent: true, slide: false, prob: 0.5, ratchet: 3 }, null], { on: false })).toMatchObject({ ok: true, steps: 8 });
    expect(store.get('parts.0.seqOn')).toBe(0);
    expect(store.get('parts.0.patterns.0.steps.2')).toMatchObject({ on: 1, accent: 1, slide: 0, prob: 0.5, ratchet: 3 });
  });

  it('validates transport actions before changing tempo or playback', async () => {
    const { api, store } = await setup();
    const before = store.get('global.tempo');
    for (const cmd of ['plaay', null, {}, { tempo: 130, playing: true }, { tempo: 130, play: true, stop: true }, { tempo: 130, play: 'yes' }, { tempo: null }]) expect(api.transport(cmd).ok).toBe(false);
    expect(store.get('global.tempo')).toBe(before);
    expect(api.transport({ tempo: 130, play: true })).toMatchObject({ ok: true, playing: true, tempo: 130 });
    expect(api.transport('stop')).toMatchObject({ ok: true, playing: false });
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

  it('rejects inherited calls and malformed args, returning useful failure receipts', async () => {
    const { api, store } = await setup();
    const win = fakeWindow(), src = replies();
    installBridge(win, api, { allowMutating: () => true });
    for (const type of ['constructor', 'toString', '__defineGetter__']) await win.send({ source: 'oro-agent', type }, src);
    expect(src.got.every((r) => r.msg.ok === false)).toBe(true);
    const before = store.get('parts.0.params.cutoff');
    await win.send({ source: 'oro-agent', type: 'set', args: 'invalid' }, src);
    expect(src.got.at(-1).msg.error).toMatch(/array/);
    await win.send({ source: 'oro-agent', type: 'set', args: [0, { cutoff: 1200, misspelled: 1 }] }, src);
    expect(src.got.at(-1).msg).toMatchObject({ ok: false, error: expect.any(String), fix: expect.any(String), result: { ok: false, set: {} } });
    expect(store.get('parts.0.params.cutoff')).toBe(before);
  });

  it('resubscribes one sender without duplicating events or exhausting subscriber slots', async () => {
    const { api } = await setup();
    const win = fakeWindow(), src = replies();
    const dispose = installBridge(win, api);
    for (let i = 0; i < 12; i++) await win.send({ source: 'oro-agent', type: 'subscribe', events: ['score'] }, src);
    expect(src.got.every((r) => r.msg.ok)).toBe(true);
    await win.send({ source: 'oro-agent', type: 'subscribe', events: ['not-an-event'] }, src);
    expect(src.got.at(-1).msg.ok).toBe(false);
    src.got.length = 0;
    api.play('bpm 120\nbars 1\nviolin A4 0 1 0.8\n');
    expect(src.got.filter((r) => r.msg.type === 'event' && r.msg.data.type === 'start')).toHaveLength(1);
    dispose();
    src.got.length = 0;
    api.stop();
    expect(src.got).toEqual([]);
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
