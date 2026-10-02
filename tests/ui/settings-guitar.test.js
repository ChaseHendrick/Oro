// Settings > Pedals > Guitar on a fake DOM: the real pane, rig, pedal host
// (fake AudioContext, fake capture node) and note router. Checks the controls
// reach the rig, tracker notes reach the engine, and Capture shows its
// progress, the detected pitch, or a clear error.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { installFakeDom } from './fake-dom.js';
import { fakeContext } from '../pedals/fake-audio.js';
import { createPedalHost } from '../../src/audio/pedal-host.js';
import { createPedalRig } from '../../src/ui/pedal-rig.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createMusic } from '../../src/music/music.js';
import { TERRAIN_INDEX } from '../../src/dsp/catalog.js';
import { makeRandom } from '../../src/pedals/signal.js';
import { RIG_KEY } from '../../src/pedals/rig-settings.js';
import { createFakeClock, createFakeEngine } from '../music/fakes.js';

let dom, createPedalSettings;
beforeAll(async () => {
  dom = installFakeDom();
  ({ createPedalSettings } = await import('../../src/ui/settings-pedals.js'));
});
afterAll(() => dom.restore());

const SR = 48000;
function sineNote(freq) {
  const x = new Float32Array(Math.round(2.2 * SR));
  for (let i = Math.round(0.2 * SR); i < x.length; i++) {
    const t = i / SR - 0.2;
    x[i] = 0.5 * Math.exp(-t / 1.2) * Math.sin(2 * Math.PI * freq * t);
  }
  return x;
}

function setup(recording) {
  const ctx = fakeContext({ maxChannelCount: 4 });
  const g = () => ctx.createGain();
  const guitars = [];
  const host = createPedalHost(ctx, {
    sendBus: g(), mainOut: g(), masterIn: g(),
    deps: {
      hasGetUserMedia: () => true,
      loadPedalWorklets: async () => ({ ok: true }),
      openReturn: async (c, id, o) => ({ ok: true, output: g(), guitar: o.layout === 'mono+guitar' ? g() : null, source: c.createMediaStreamSource({}), warnings: [], settings: null, close() {} }),
      attachFeedbackGuard: () => ({ reset() {}, dispose() {}, status: () => ({ muted: false, outside: false }) }),
      createGuitarInput: (c, node) => {
        const ls = {};
        const gi = { node, via: 'worklet', configure: vi.fn(), dispose: vi.fn(), on: (t, fn) => { (ls[t] ||= new Set()).add(fn); return () => ls[t].delete(fn); }, emit: (t, e) => { for (const fn of ls[t] || []) fn(e); } };
        guitars.push(gi);
        return gi;
      },
      createCapture: (c) => ({ input: g(), dropouts: 0, start: async () => {}, stop: async () => [recording], dispose() {} }),
      sleep: async () => {},
    },
  });
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  engine.pedals = host;
  const store = createStore(defaultState());
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  const storage = { m: new Map(), getItem(k) { return this.m.get(k) ?? null; }, setItem(k, v) { this.m.set(k, v); } };
  const rig = createPedalRig({ store, engine, midi: null, router: music.router, storage, micGranted: async () => true });
  const uiCtx = { pedals: rig, midi: null, startAudio: async () => {}, toast: vi.fn() };
  const pane = createPedalSettings(uiCtx);
  dom.flush();
  const group = pane.el.querySelectorAll('section').find(s => /^Guitar/.test(s.querySelector('h3').textContent));
  const button = (re) => group.querySelectorAll('button').find(b => re.test(b.textContent) || re.test(b.innerHTML));
  return { host, rig, store, engine, guitars, uiCtx, pane, group, button, music, storage };
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); dom.flush(); };

describe('Settings > Pedals > Guitar', () => {
  it('shows the guitar controls, off by default, with Capture waiting for the return', () => {
    const { group, button } = setup(sineNote(220));
    expect(group).toBeTruthy();
    const text = group.textContent;
    for (const label of ['Input channel', 'Guitar plays notes', 'Single', 'Chords', 'Part', 'Gate', 'Bends as pitch bend', 'Capture']) expect(text).toContain(label);
    expect(text).toMatch(/Not tested with a real guitar yet/);
    expect(button(/Guitar plays notes/).getAttribute('aria-pressed')).toBe('false');
    expect(button(/^Single$/).getAttribute('aria-checked')).toBe('true');
    expect(button(/^Chords$/).getAttribute('aria-checked')).toBe('false');
    expect(button(/<span>Capture<\/span>/).disabled).toBe(true);
  });

  it('persists chord mode, explains its latency and disables bends without losing the Single preference', async () => {
    const { rig, group, button, guitars, storage } = setup(sineNote(220));
    button(/Guitar plays notes/).click();
    await rig.set({ returnEnabled: 1, returnLayout: 'mono+guitar' });
    await settle();
    button(/^Chords$/).click();
    await settle();
    expect(rig.prefs.guitarMode).toBe('chords');
    expect(JSON.parse(storage.m.get(RIG_KEY)).guitarMode).toBe('chords');
    expect(button(/^Chords$/).getAttribute('aria-checked')).toBe('true');
    expect(button(/Bends as pitch bend/).disabled).toBe(true);
    expect(rig.prefs.guitarBends).toBe(1);
    expect(guitars[0].configure).toHaveBeenLastCalledWith(expect.objectContaining({ guitarMode: 'chords' }));
    expect(group.textContent).toMatch(/Chords are experimental and respond more slowly than Single/);
    expect(group.textContent).toContain('Not tested with a real guitar yet');
    expect(group.textContent).toContain('Capture does not record chords');
    button(/^Single$/).click();
    await settle();
    expect(button(/Bends as pitch bend/).disabled).toBe(false);
    expect(button(/Bends as pitch bend/).getAttribute('aria-pressed')).toBe('true');
    expect(rig.prefs.guitarMode).toBe('single');
  });

  it('shows every heard chord note and clears the display when the tracker clears or notes are switched off', async () => {
    const { rig, group, guitars } = setup(sineNote(220));
    await rig.set({ guitarNotes: 1, guitarMode: 'chords', returnEnabled: 1, returnLayout: 'mono+guitar' });
    await settle();
    const out = group.querySelector('p.guitar-pitch');
    guitars[0].emit('pitch', { mode: 'chords', notes: [40, 47, 52, 56, 59, 64], heard: [40, 47, 52, 56, 59, 64], voiced: true, time: 0.5 });
    dom.flush();
    expect(out.textContent).toBe('Hearing E2, B2, E3, G#3, B3, E4');
    guitars[0].emit('pitch', { mode: 'chords', notes: [], heard: [], voiced: false, time: 0.7 });
    dom.flush();
    expect(out.textContent).toBe('Hearing no clear chord notes');
    guitars[0].emit('pitch', { mode: 'chords', notes: [45, 52, 57], heard: [45, 52, 57], voiced: true });
    await rig.set({ guitarNotes: 0 });
    dom.flush();
    expect(out.textContent).toBe('');
  });

  it('keeps Single pitch telemetry readable after returning from Chords', async () => {
    const { rig, group, button, guitars } = setup(sineNote(220));
    await rig.set({ guitarNotes: 1, guitarMode: 'chords', returnEnabled: 1, returnLayout: 'mono+guitar' });
    await settle();
    guitars[0].emit('pitch', { mode: 'chords', notes: [40, 47], heard: [40, 47], voiced: true });
    dom.flush();
    button(/^Single$/).click();
    await settle();
    guitars[0].emit('pitch', { voiced: true, midi: 45, freq: 110, clarity: 0.96 });
    dom.flush();
    expect(group.querySelector('p.guitar-pitch').textContent).toBe('Hearing A2 (110.0 Hz)');
  });

  it('turns guitar notes on, opens the return and plays the selected part from the tracker', async () => {
    const { rig, group, button, engine, guitars, music } = setup(sineNote(220));
    button(/Guitar plays notes/).click();
    await settle();
    expect(rig.prefs.guitarNotes).toBe(1);
    await rig.set({ returnEnabled: 1, returnLayout: 'mono+guitar' });
    await settle();
    // The channel picker describes the layout's channels.
    expect(group.textContent).toContain('Ch 2 (guitar DI)');
    expect(button(/<span>Capture<\/span>/).disabled).toBe(false);
    expect(guitars).toHaveLength(1);
    const sched = [];
    music.router.on('sched', e => sched.push(e));
    guitars[0].emit('noteOn', { note: 45, velocity: 0.6 });
    guitars[0].emit('noteOff', { note: 45 });
    expect(engine.events.filter(e => e.type === 'on' || e.type === 'off').map(e => `${e.type}:${e.part}:${e.note}`)).toEqual(['on:0:45', 'off:0:45']);
    expect(sched.every(e => e.source === 'guitar')).toBe(true);
  });

  it('captures a held note into the part and shows the pitch it found', { timeout: 60000 }, async () => {
    const { rig, group, button, store, uiCtx } = setup(sineNote(220));
    await rig.set({ guitarNotes: 1, guitarMode: 'chords', returnEnabled: 1, returnLayout: 'mono+guitar' });
    await settle();
    button(/<span>Capture<\/span>/).click();
    await settle();
    await settle();
    expect(group.textContent).toMatch(/Captured A3 \(220\.\d Hz\), \d+ frames, now on part 1, slot A\./);
    expect(store.get('parts.0.userTerrain.A')).toMatchObject({ kind: 'wavetable', name: 'Guitar A3' });
    expect(store.get('parts.0.params.terrainA')).toBe(TERRAIN_INDEX.user);
    expect(uiCtx.toast).toHaveBeenCalledWith(expect.stringMatching(/Captured Guitar A3 into part 1, slot A/), expect.anything());
    expect(rig.guitarNotes.config).toMatchObject({ enabled: true, guitarMode: 'chords' });
  });

  it('shows a clear error when there is no stable pitch', { timeout: 60000 }, async () => {
    const rnd = makeRandom(11);
    const noise = new Float32Array(2 * SR).map(() => 0.3 * (rnd() * 2 - 1));
    const { rig, group, button, store } = setup(noise);
    await rig.set({ returnEnabled: 1 });
    await settle();
    button(/<span>Capture<\/span>/).click();
    await settle();
    await settle();
    const out = group.querySelector('p.guitar-capture');
    expect(out.textContent).toMatch(/could not find a steady pitch/);
    expect(out.classList.contains('is-bad')).toBe(true);
    expect(store.get('parts.0.userTerrain.A')).toBe(null);
  });
});
