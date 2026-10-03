// v1.1 pedal latency compensation and the sample-rate choice: the pure
// helpers, the saved rig settings, the rig glue (engine + router), the
// transport/arp scheduling offset on a fake clock, and the DSP's dry delay for
// Send mode parts.
import { describe, it, expect, vi } from 'vitest';
import { compensationMs, partLeadSeconds, dryDelaySamples, pedalMode, MAX_COMP_MS } from '../../src/pedals/latency-comp.js';
import {
  defaultRig, sanitizeRig, loadRig, saveRig, RIG_KEY, contextSampleRate, savedContextSampleRate, SAMPLE_RATE_OPTIONS,
} from '../../src/pedals/rig-settings.js';
import { createPedalRig } from '../../src/ui/pedal-rig.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createMusic, ARP } from '../../src/music/music.js';
import { START_DELAY, LOOKAHEAD } from '../../src/music/transport.js';
import { MAX_LEAD } from '../../src/music/router.js';
import { MAX_DRY_DELAY_SEC } from '../../src/dsp/dsp-core.js';
import { createFakeClock, createFakeEngine, createMemoryStorage } from '../music/fakes.js';
import { makeDSP } from '../dsp/helpers.js';

// ------------------------------------------------------------------ helpers

describe('latency compensation helpers', () => {
  it('adds the manual offset to the measured round trip, only when on', () => {
    expect(compensationMs({ compensate: 0, lastLatencyMs: 40, compOffsetMs: 5 })).toBe(0);
    expect(compensationMs({ compensate: 1, lastLatencyMs: 40, compOffsetMs: 5 })).toBe(45);
    expect(compensationMs({ compensate: 1, lastLatencyMs: 40, compOffsetMs: -10 })).toBe(30);
    // No ping yet: the offset alone (so a known latency can be typed in).
    expect(compensationMs({ compensate: 1, lastLatencyMs: null, compOffsetMs: 33 })).toBe(33);
    // Never negative, never past the cap.
    expect(compensationMs({ compensate: 1, lastLatencyMs: 10, compOffsetMs: -50 })).toBe(0);
    expect(compensationMs({ compensate: 1, lastLatencyMs: 1900, compOffsetMs: 200 })).toBe(MAX_COMP_MS);
    expect(compensationMs(null)).toBe(0);
  });

  it('moves only parts through the pedals, and only while the send runs', () => {
    expect(pedalMode({ pedalSend: 0, pedalInsert: 0 })).toBe(null);
    expect(pedalMode({ pedalSend: 0.4, pedalInsert: 0 })).toBe('send');
    expect(pedalMode({ pedalSend: 0, pedalInsert: 1 })).toBe('insert');
    expect(partLeadSeconds({ pedalInsert: 1 }, 40, true)).toBeCloseTo(0.04, 12);
    expect(partLeadSeconds({ pedalSend: 0.5 }, 40, true)).toBeCloseTo(0.04, 12);
    expect(partLeadSeconds({ pedalSend: 0 }, 40, true)).toBe(0);
    expect(partLeadSeconds({ pedalInsert: 1 }, 40, false)).toBe(0);
    expect(partLeadSeconds({ pedalInsert: 1 }, 0, true)).toBe(0);
  });

  it('turns the round trip into a dry delay in samples', () => {
    expect(dryDelaySamples(40, 48000)).toBe(1920);
    expect(dryDelaySamples(40, 44100)).toBe(1764);
    expect(dryDelaySamples(37.5, 44100)).toBe(Math.round(0.0375 * 44100));
    expect(dryDelaySamples(0, 48000)).toBe(0);
    expect(dryDelaySamples(9999, 48000)).toBe(MAX_COMP_MS * 48);
    expect(MAX_DRY_DELAY_SEC * 1000).toBe(MAX_COMP_MS);
    expect(MAX_LEAD * 1000).toBe(MAX_COMP_MS);
  });
});

// ------------------------------------------------------------------ settings

describe('rig settings: compensation and sample rate', () => {
  it('defaults to off, no offset, Auto', () => {
    expect(defaultRig()).toMatchObject({ compensate: 0, compOffsetMs: 0, sampleRate: 'auto', lastLatencyMs: null });
    expect(SAMPLE_RATE_OPTIONS.map(o => o.value)).toEqual(['auto', 44100, 48000, 96000]);
  });

  it('sanitizes the new fields', () => {
    const s = sanitizeRig({ compensate: true, compOffsetMs: 999, sampleRate: 88200 });
    expect(s.compensate).toBe(1);
    expect(s.compOffsetMs).toBe(200);
    expect(s.sampleRate).toBe('auto');
    expect(sanitizeRig({ compOffsetMs: -12.34 }).compOffsetMs).toBe(-12.3);
    expect(sanitizeRig({ compOffsetMs: 'x' }).compOffsetMs).toBe(0);
    expect(sanitizeRig({ sampleRate: '44100' }).sampleRate).toBe('auto');
    expect(sanitizeRig({ sampleRate: 44100 }).sampleRate).toBe(44100);
  });

  it('persists per computer and survives a reload', () => {
    const st = createMemoryStorage();
    saveRig({ ...defaultRig(), compensate: 1, compOffsetMs: 4.5, lastLatencyMs: 41.2, sampleRate: 44100 }, st);
    const back = loadRig(st);
    expect(back).toMatchObject({ compensate: 1, compOffsetMs: 4.5, lastLatencyMs: 41.2, sampleRate: 44100 });
    expect(JSON.parse(st.getItem(RIG_KEY)).sampleRate).toBe(44100);
  });

  it('gives main.js the context rate to ask for (undefined = the browser decides)', () => {
    expect(contextSampleRate({ sampleRate: 'auto' })).toBe(undefined);
    expect(contextSampleRate({ sampleRate: 44100 })).toBe(44100);
    expect(contextSampleRate({ sampleRate: 48000 })).toBe(48000);
    expect(contextSampleRate({ sampleRate: 96000 })).toBe(96000);
    expect(contextSampleRate(null)).toBe(undefined);
    const st = createMemoryStorage();
    expect(savedContextSampleRate(st)).toBe(undefined);
    saveRig({ ...defaultRig(), sampleRate: 44100 }, st);
    expect(savedContextSampleRate(st)).toBe(44100);
    st.setItem(RIG_KEY, '{broken');
    expect(savedContextSampleRate(st)).toBe(undefined);
    expect(savedContextSampleRate(null)).toBe(undefined);
  });
});

// ------------------------------------------------------------------ rig glue

function rigSetup({ prefs, active = true, sampleRate = 48000 } = {}) {
  const storage = createMemoryStorage();
  if (prefs) storage.setItem(RIG_KEY, JSON.stringify(prefs));
  const store = createStore(defaultState());
  const ls = {};
  const host = {
    active,
    configure: vi.fn(), setReturn: vi.fn(async () => ({})), resetGuard: vi.fn(), listInputs: vi.fn(async () => []),
    ping: vi.fn(async () => ({ ok: true, latencyMs: 42.04, confidence: 0.9 })),
    status: () => ({ active: host.active }),
    on: (t, fn) => { (ls[t] ||= new Set()).add(fn); return () => ls[t].delete(fn); },
  };
  const engine = { pedals: host, sampleRate, outputDeviceId: 'default', setOutputDevice: vi.fn(async () => 'default'), setPedalCompensation: vi.fn() };
  const router = { setLead: vi.fn() };
  const reload = vi.fn();
  const rig = createPedalRig({ store, engine, midi: null, router, storage, micGranted: async () => false, reload });
  const lead = () => router.setLead.mock.calls.at(-1)[0];
  return { rig, host, engine, router, reload, store, storage, lead };
}

describe('pedal rig: latency compensation', () => {
  it('stays off until Compensate is switched on', async () => {
    const { rig, engine, router } = rigSetup({ prefs: { ...defaultRig(), lastLatencyMs: 40 } });
    await rig.restore();
    expect(engine.setPedalCompensation).toHaveBeenLastCalledWith(0);
    expect(router.setLead).toHaveBeenLastCalledWith(null);
    expect(rig.status().compensation).toMatchObject({ on: false, ms: 0, applied: false });
  });

  it('applies the ping plus the offset to the engine and to sequenced parts through the pedals', async () => {
    const { rig, engine, router, store, storage, lead } = rigSetup();
    await rig.restore();
    await rig.set({ compensate: 1 });
    // No ping yet, no offset: nothing to move.
    expect(engine.setPedalCompensation).toHaveBeenLastCalledWith(0);
    await rig.ping();
    expect(rig.prefs.lastLatencyMs).toBe(42);
    expect(engine.setPedalCompensation).toHaveBeenLastCalledWith(42);
    await rig.set({ compOffsetMs: 3 });
    expect(engine.setPedalCompensation).toHaveBeenLastCalledWith(45);
    expect(JSON.parse(storage.getItem(RIG_KEY))).toMatchObject({ compensate: 1, compOffsetMs: 3, lastLatencyMs: 42 });
    const fn = lead();
    expect(typeof fn).toBe('function');
    // Part 0 dry, part 1 Insert, part 2 Send.
    store.set('parts.1.params.pedalInsert', 1);
    store.set('parts.2.params.pedalSend', 0.5);
    expect(fn(0)).toBe(0);
    expect(fn(1)).toBeCloseTo(0.045, 12);
    expect(fn(2)).toBeCloseTo(0.045, 12);
    expect(rig.status().compensation).toMatchObject({ on: true, ms: 45, measuredMs: 42, offsetMs: 3, applied: true });
    await rig.set({ compensate: 0 });
    expect(engine.setPedalCompensation).toHaveBeenLastCalledWith(0);
    expect(router.setLead).toHaveBeenLastCalledWith(null);
    expect(router.setLead.mock.calls.length).toBeGreaterThan(1);
  });

  it('moves nothing while the pedal send is not running', async () => {
    const { rig, host, store, lead } = rigSetup({ prefs: { ...defaultRig(), compensate: 1, lastLatencyMs: 30 }, active: false });
    await rig.restore();
    store.set('parts.0.params.pedalInsert', 1);
    expect(lead()(0)).toBe(0);
    expect(rig.status().compensation.applied).toBe(false);
    host.active = true;   // the lead is read live, every scheduler tick
    expect(lead()(0)).toBeCloseTo(0.03, 12);
  });

  it('lets go of the router when disposed', async () => {
    const { rig, router } = rigSetup({ prefs: { ...defaultRig(), compensate: 1, lastLatencyMs: 30 } });
    await rig.restore();
    rig.dispose();
    expect(router.setLead).toHaveBeenLastCalledWith(null);
  });
});

describe('pedal rig: sample rate', () => {
  it('stores the choice and asks for a restart, which reloads the app', async () => {
    const { rig, reload, storage } = rigSetup({ sampleRate: 48000 });
    expect(rig.sampleRate()).toMatchObject({ choice: 'auto', want: null, running: 48000, pending: false, refused: false });
    await rig.set({ sampleRate: 44100 });
    expect(rig.sampleRate()).toMatchObject({ choice: 44100, want: 44100, pending: true });
    expect(loadRig(storage).sampleRate).toBe(44100);
    expect(savedContextSampleRate(storage)).toBe(44100);
    rig.reload();
    expect(reload).toHaveBeenCalledTimes(1);
    // Back to what the engine started with: no restart needed.
    await rig.set({ sampleRate: 'auto' });
    expect(rig.sampleRate().pending).toBe(false);
  });

  it('after a restart at 44.1 kHz nothing is pending; a refused rate is reported', () => {
    const ok = rigSetup({ prefs: { ...defaultRig(), sampleRate: 44100 }, sampleRate: 44100 });
    expect(ok.rig.sampleRate()).toMatchObject({ choice: 44100, running: 44100, pending: false, refused: false });
    const no = rigSetup({ prefs: { ...defaultRig(), sampleRate: 44100 }, sampleRate: 48000 });
    expect(no.rig.sampleRate()).toMatchObject({ pending: false, refused: true });
  });
});

// ------------------------------------------------------------------ scheduling

function musicSetup({ tempo = 120 } = {}) {
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  // Record when each note was handed to the engine, to check nothing lands in the past.
  const on0 = engine.noteOn, off0 = engine.noteOff;
  engine.noteOn = (part, note, vel, time) => { on0(part, note, vel, time); engine.events.at(-1).sentAt = clock.now(); };
  engine.noteOff = (part, note, time) => { off0(part, note, time); engine.events.at(-1).sentAt = clock.now(); };
  const s = defaultState();
  s.global.tempo = tempo;
  s.global.swing = 0;
  const store = createStore(s);
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  return { clock, engine, store, music };
}

function fillPattern(store, part, { rate = 3, steps = 16, slide = () => 0 } = {}) {
  const seq = store.get(`parts.${part}.patterns.0`);
  store.set(`parts.${part}.seqOn`, 1);
  seq.rate = rate;
  seq.length = steps;
  seq.steps = seq.steps.map((st, i) => ({ ...st, on: 1, degree: i % 7, gate: 0.5, slide: slide(i) ? 1 : 0 }));
  store.set(`parts.${part}.patterns.0`, seq);
}

describe('transport: scheduling offset for parts through the pedals', () => {
  const LEAD = 0.045;

  it('sends a compensated part early, keeps the others and the step announcements on the grid', () => {
    const { clock, engine, store, music } = musicSetup({ tempo: 120 });
    fillPattern(store, 0);
    fillPattern(store, 1);
    music.router.setLead((p) => (p === 1 ? LEAD : 0));
    expect(music.router.maxLead()).toBeCloseTo(LEAD, 12);
    const steps = [];
    music.transport.on('step', (e) => { if (e.part === 1) steps.push({ ...e, at: clock.now() }); });
    const t0 = clock.ctx.currentTime;
    music.transport.play();
    clock.advance(2.05);
    // The grid starts later by the largest lead, so the first note can go out early too.
    const start = t0 + START_DELAY + LEAD;
    const dry = engine.ons(0), ped = engine.ons(1);
    expect(dry.length).toBeGreaterThanOrEqual(16);
    expect(ped.length).toBeGreaterThanOrEqual(16);
    for (let i = 0; i < 16; i++) {
      expect(dry[i].time).toBeCloseTo(start + i * 0.125, 9);
      expect(ped[i].time).toBeCloseTo(start + i * 0.125 - LEAD, 9);
      expect(ped[i].note).toBe(dry[i].note);
    }
    // The gate keeps its length.
    expect(engine.offs(1)[0].time - ped[0].time).toBeCloseTo(0.0625, 9);
    // Step announcements (visuals, lock flashes) stay on the heard time.
    expect(steps.length).toBeGreaterThanOrEqual(15);
    for (let i = 0; i < 15; i++) expect(steps[i].time).toBeCloseTo(start + i * 0.125, 9);
    // Nothing is ever sent for a time already past.
    for (const e of engine.events) if (e.type === 'on' || e.type === 'off') expect(e.time).toBeGreaterThanOrEqual(e.sentAt - 1e-9);
    music.transport.stop();
  });

  it('looks further ahead for a compensated part so its notes are not late', () => {
    const { clock, engine, store, music } = musicSetup({ tempo: 120 });
    fillPattern(store, 2);
    music.router.setLead((p) => (p === 2 ? LEAD : 0));
    music.transport.play();
    clock.advance(1.5);
    const ons = engine.ons(2);
    expect(ons.length).toBeGreaterThan(8);
    // The first note has the usual start headroom; every later one reaches the
    // engine ahead of its (early) time by about the normal lookahead.
    expect(ons[0].time - ons[0].sentAt).toBeCloseTo(START_DELAY, 9);
    for (const e of ons.slice(1)) expect(e.time - e.sentAt).toBeGreaterThan(LOOKAHEAD - 0.03);
    music.transport.stop();
  });

  it('clamps to now instead of scheduling in the past when the lead is switched on mid-play', () => {
    const { clock, engine, store, music } = musicSetup({ tempo: 120 });
    fillPattern(store, 0);
    music.transport.play();
    clock.advance(0.5);
    music.router.setLead(() => 0.4);   // far more than the lookahead
    clock.advance(1);
    for (const e of engine.events) if (e.type === 'on' || e.type === 'off') expect(e.time).toBeGreaterThanOrEqual(e.sentAt - 1e-9);
    // Later notes are fully compensated.
    const late = engine.ons(0).filter(e => e.sentAt > 1.8);
    expect(late.length).toBeGreaterThan(0);
    const grid = (t) => (t + 0.4 - (1 + START_DELAY)) / 0.125;
    for (const e of late) expect(Math.abs(grid(e.time) - Math.round(grid(e.time)))).toBeLessThan(1e-6);
    music.transport.stop();
  });

  it('ends a tied note with the lead it started with', () => {
    const { clock, engine, store, music } = musicSetup({ tempo: 120 });
    // Steps 0..3 slide into each other on the same pitch: one long note.
    fillPattern(store, 0, { slide: (i) => i < 3 });
    const seq = store.get('parts.0.patterns.0');
    seq.steps = seq.steps.map((s, i) => ({ ...s, degree: i < 4 ? 0 : i % 7 }));
    store.set('parts.0.patterns.0', seq);
    music.router.setLead(() => 0.02);
    music.transport.play();
    clock.advance(0.2);
    music.router.setLead(() => 0.3);   // grows while the tie is held
    clock.advance(1);
    const first = engine.ons(0)[0];
    const off = engine.offs(0).find(e => e.note === first.note && e.time > first.time);
    expect(off).toBeTruthy();
    expect(off.time).toBeGreaterThan(first.time);
    music.transport.stop();
  });

  it('shifts the arp while the transport runs, keeps the 16ths spacing', () => {
    const { clock, engine, store, music } = musicSetup({ tempo: 120 });
    store.set('parts.3.arp', { ...store.get('parts.3.arp'), mode: ARP.UP, rate: 3, octaves: 1, gate: 0.5, hold: 0 });
    music.router.setLead((p) => (p === 3 ? LEAD : 0));
    music.transport.play();
    clock.advance(0.3);
    engine.clear();
    music.router.noteOn(3, 60, 0.8, 'ui');
    music.router.noteOn(3, 64, 0.8, 'ui');
    clock.advance(1.2);
    const ons = engine.ons(3);
    expect(ons.length).toBeGreaterThan(5);
    // After the live first step, arp notes are a 16th apart and LEAD ahead of the grid.
    const grid = (t) => (t + LEAD - (1 + START_DELAY + LEAD)) / 0.125;
    for (const e of ons.slice(2)) expect(Math.abs(grid(e.time) - Math.round(grid(e.time)))).toBeLessThan(1e-6);
    for (const e of engine.events) if (e.type === 'on' || e.type === 'off') expect(e.time).toBeGreaterThanOrEqual(e.sentAt - 1e-9);
    music.transport.stop();
    music.router.allNotesOff();
  });

  it('a free-running arp and live notes are not moved', () => {
    const { clock, engine, store, music } = musicSetup({ tempo: 120 });
    music.router.setLead(() => LEAD);
    music.router.noteOn(0, 60, 0.8, 'ui');
    expect(engine.ons(0)[0].time).toBe(0);   // live: "now"
    music.router.noteOff(0, 60, 'ui');
    store.set('parts.1.arp', { ...store.get('parts.1.arp'), mode: ARP.UP, rate: 3, octaves: 1, gate: 0.5, hold: 0 });
    music.router.noteOn(1, 60, 0.8, 'ui');
    clock.advance(0.6);
    const ons = engine.ons(1);
    expect(ons.length).toBeGreaterThan(2);
    for (let i = 1; i < ons.length; i++) expect(ons[i].time - ons[i - 1].time).toBeCloseTo(0.125, 9);
    music.router.allNotesOff();
  });

  it('with no lead, timing is exactly as before', () => {
    const a = musicSetup(); const b = musicSetup();
    fillPattern(a.store, 0); fillPattern(b.store, 0);
    b.music.router.setLead(() => 0);
    a.music.transport.play(); b.music.transport.play();
    a.clock.advance(1); b.clock.advance(1);
    expect(b.engine.ons(0).map(e => e.time)).toEqual(a.engine.ons(0).map(e => e.time));
  });
});

// ------------------------------------------------------------------ DSP dry delay

const SR = 48000;

function run(dsp, seconds) {
  const total = Math.round(seconds * SR);
  const out = { L: new Float32Array(total), D: new Float32Array(total), P: new Float32Array(total) };
  const b = Array.from({ length: 8 }, () => new Float32Array(128));
  let t = 0;
  for (let i = 0; i < total; i += 128) {
    const n = Math.min(128, total - i);
    dsp.process(b[0], b[1], b[2], b[3], b[4], b[5], n, t, b[6], b[7]);
    out.L.set(b[0].subarray(0, n), i); out.D.set(b[2].subarray(0, n), i); out.P.set(b[6].subarray(0, n), i);
    t += n / SR;
  }
  return out;
}

function voice(params, { active = true, delay = 0 } = {}) {
  const dsp = makeDSP({ terrainA: 0, terrainB: 1, params: { level: 0.75, delaySend: 0.3, sustain: 1, attack: 0.001, ...params } });
  dsp.handleMessage({ t: 'pedal', active });
  if (delay) dsp.handleMessage({ t: 'dryDelay', samples: delay });
  dsp.handleMessage({ t: 'noteOn', part: 0, note: 57, vel: 0.9, time: 0 });
  return dsp;
}

/** Largest |a[i + lag] - b[i]| over the settled part of the render. */
function shiftedDiff(a, b, lag, from) {
  let m = 0;
  for (let i = from; i + lag < a.length; i++) m = Math.max(m, Math.abs(a[i + lag] - b[i]));
  return m;
}

describe('DSP dry delay for Send mode parts', () => {
  const N = dryDelaySamples(40, SR);   // 1920 samples

  it('delays the dry sound and its delay send by exactly the round trip; the pedal send is not delayed', () => {
    const ref = run(voice({ pedalSend: 0.5 }), 0.4);
    const comp = run(voice({ pedalSend: 0.5 }, { delay: N }), 0.4);
    const peak = Math.max(...ref.L.map(Math.abs));
    expect(peak).toBeGreaterThan(0.01);
    // Silent until the delayed sound arrives.
    expect(Math.max(...comp.L.subarray(0, N - 1).map(Math.abs))).toBe(0);
    // Same sound, N samples later (after the level smoothing has settled).
    expect(shiftedDiff(comp.L, ref.L, N, 4800)).toBeLessThan(1e-4 * peak);
    expect(shiftedDiff(comp.D, ref.D, N, 4800)).toBeLessThan(1e-4 * peak);
    // The pedals get the part on time.
    expect(comp.P).toEqual(ref.P);
  });

  it('does nothing for Insert parts, dry parts, or while the pedal loop is off', () => {
    const plain = run(voice({ pedalSend: 0 }), 0.2);
    expect(run(voice({ pedalSend: 0 }, { delay: N }), 0.2).L).toEqual(plain.L);
    const ins = run(voice({ pedalSend: 1, pedalInsert: 1 }), 0.2);
    const insC = run(voice({ pedalSend: 1, pedalInsert: 1 }, { delay: N }), 0.2);
    expect(insC.P).toEqual(ins.P);
    expect(insC.L).toEqual(ins.L);
    const off = run(voice({ pedalSend: 0.5 }, { active: false }), 0.2);
    expect(run(voice({ pedalSend: 0.5 }, { active: false, delay: N }), 0.2).L).toEqual(off.L);
  });

  it('caps the delay and lets the delayed tail finish after the note ends', () => {
    const dsp = voice({ pedalSend: 0.5, release: 0.01 }, { delay: 10 * SR });
    expect(dsp.dryDelayN).toBe(Math.round(MAX_DRY_DELAY_SEC * SR));
    dsp.handleMessage({ t: 'dryDelay', samples: N });
    dsp.handleMessage({ t: 'noteOff', part: 0, note: 57, time: 0.1 });
    const o = run(dsp, 0.3);
    // Sound continues for about N samples past the release.
    const lastLoud = o.L.findLastIndex(x => Math.abs(x) > 1e-4);
    expect(lastLoud).toBeGreaterThan(Math.round(0.1 * SR) + N - 200);
    expect(o.L.every(Number.isFinite)).toBe(true);
  });
});
