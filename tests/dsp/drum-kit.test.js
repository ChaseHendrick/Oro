// Drum kits (v2.7): the synthesized kit, transient slicing, the pad player,
// saved data, the engine, sync, the sequencer lanes and bounce events.
import { describe, it, expect } from 'vitest';
import {
  KIT_PADS, KIT_BASE_NOTE, SYNTH_DRUMS, synthDrum, sliceTransients, pcmToBase64, base64ToPcm,
  KitPlayer, defaultDrum, sanitizeDrum, sanitizeLanes,
} from '../../src/dsp/drum-kit.js';
import { createStore } from '../../src/core/store.js';
import { defaultState, SEQ_STEPS } from '../../src/core/params.js';
import { migrateState } from '../../src/core/migrate.js';
import { createStoreSync } from '../../src/audio/sync.js';
import { sequencerEvents } from '../../src/audio/bounce-events.js';
import { snapshotState } from '../../src/core/history.js';
import { createMusic } from '../../src/music/music.js';
import { START_DELAY } from '../../src/music/transport.js';
import { createFakeClock, createFakeEngine } from '../music/fakes.js';
import { makeDSP, render, SR } from './helpers.js';

const peak = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const rms = (a, from = 0, to = a.length) => { let s = 0; for (let i = from; i < to; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, to - from)); };

/** A recording with short decaying noise bursts at `times` (seconds) over faint noise. */
function taps(times, seconds = 2, sr = SR) {
  const out = new Float32Array(Math.round(seconds * sr));
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296 * 2 - 1; };
  for (let i = 0; i < out.length; i++) out[i] = 0.002 * rnd();
  for (const t of times) {
    const o = Math.round(t * sr);
    for (let i = 0; i < sr * 0.12 && o + i < out.length; i++) out[o + i] += 0.8 * rnd() * Math.exp(-i / (sr * 0.02));
  }
  return out;
}

describe('synthesized kit', () => {
  it('makes eight deterministic, finite, normalised one-shots', () => {
    expect(SYNTH_DRUMS).toHaveLength(KIT_PADS);
    for (let i = 0; i < KIT_PADS; i++) {
      const a = synthDrum(i, SR), b = synthDrum(i, SR);
      expect(a.length).toBeGreaterThan(SR * 0.05);
      expect(Array.from(a)).toEqual(Array.from(b));
      expect(a.every(Number.isFinite)).toBe(true);
      expect(peak(a)).toBeCloseTo(0.9, 5);
      expect(Math.abs(a[a.length - 1])).toBeLessThan(1e-3);
    }
  });
});

describe('transient slicing', () => {
  it('finds each tap and cuts a slice starting just before it', () => {
    const times = [0.1, 0.45, 0.8, 1.2, 1.6];
    const slices = sliceTransients(taps(times), SR);
    expect(slices).toHaveLength(times.length);
    slices.forEach((s, k) => {
      expect(Math.abs(s.start / SR - times[k])).toBeLessThan(0.012);
      expect(peak(s.data)).toBeCloseTo(0.9, 5);
      expect(Math.abs(s.data[0])).toBe(0);
    });
  });

  it('keeps the strongest hits up to the limit, in time order', () => {
    const slices = sliceTransients(taps([0.1, 0.3, 0.5, 0.7, 0.9, 1.1]), SR, 3);
    expect(slices).toHaveLength(3);
    for (let k = 1; k < slices.length; k++) expect(slices[k].start).toBeGreaterThan(slices[k - 1].start);
  });

  it('returns nothing for silence or a clip too short to read', () => {
    expect(sliceTransients(new Float32Array(SR), SR)).toEqual([]);
    expect(sliceTransients(new Float32Array(100), SR)).toEqual([]);
  });

  it('round-trips 16-bit PCM through base64', () => {
    const a = synthDrum(1, SR);
    const b = base64ToPcm(pcmToBase64(a));
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i += 97) expect(Math.abs(b[i] - a[i])).toBeLessThan(1 / 32767 + 1e-7);
  });
});

describe('KitPlayer', () => {
  const block = (kp, n = SR) => { const L = new Float32Array(n), R = new Float32Array(n); kp.render(L, R, 0, n); return { L, R }; };

  it('plays a pad for its note, wraps other notes onto the pads and ignores velocity 0', () => {
    const kp = new KitPlayer(SR);
    const data = new Float32Array(1000).fill(0.5);
    kp.setPad(0, { data, rate: SR, gain: 1 });
    kp.trigger(KIT_BASE_NOTE, 0);
    expect(kp.busy).toBe(false);
    kp.trigger(KIT_BASE_NOTE + KIT_PADS, 1);   // wraps to pad 1
    expect(kp.busy).toBe(true);
    const { L, R } = block(kp, 2000);
    expect(L[10]).toBeCloseTo(0.5, 6);          // centre pan: equal power, unity at the centre
    expect(R[10]).toBeCloseTo(0.5, 6);
    expect(L[1500]).toBe(0);
    expect(kp.busy).toBe(false);
  });

  it('pitch +12 plays twice as fast', () => {
    const kp = new KitPlayer(SR);
    kp.setPad(0, { data: new Float32Array(1000).fill(0.5), rate: SR, gain: 1, pitch: 12 });
    kp.trigger(KIT_BASE_NOTE, 1);
    const { L } = block(kp, 2000);
    expect(L[490]).toBeGreaterThan(0.4);
    expect(L[510]).toBe(0);
  });

  it('a pad cuts off others in its choke group', () => {
    const kp = new KitPlayer(SR);
    kp.setPad(2, { data: new Float32Array(SR).fill(0.5), rate: SR, gain: 1, choke: 1 });
    kp.setPad(3, { data: new Float32Array(SR).fill(0.5), rate: SR, gain: 1, choke: 1 });
    kp.trigger(KIT_BASE_NOTE + 3, 1);
    block(kp, 100);
    kp.trigger(KIT_BASE_NOTE + 2, 1);
    block(kp, SR * 0.1);
    const open = kp.voices.find(v => v.on && v.pad === 3);
    expect(open).toBeUndefined();
  });

  it('decay below 1 fades the sound out sooner', () => {
    const full = new KitPlayer(SR), short = new KitPlayer(SR);
    for (const kp of [full, short]) kp.setPad(0, { data: new Float32Array(SR).fill(0.5), rate: SR, gain: 1 });
    short.setPad(0, { decay: 0.2 });
    full.trigger(KIT_BASE_NOTE, 1); short.trigger(KIT_BASE_NOTE, 1);
    const a = block(full), b = block(short);
    expect(rms(b.L, SR / 2, SR)).toBeLessThan(rms(a.L, SR / 2, SR) * 0.01);
  });
});

describe('saved data', () => {
  it('defaults to the synthesized kit, off, with the hats in one choke group', () => {
    const d = sanitizeDrum(undefined);
    expect(d).toEqual(defaultDrum());
    expect(d.on).toBe(0);
    expect(d.pads.map(p => p.synth)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(d.pads.filter(p => p.choke === 1).map(p => p.name)).toEqual(['Closed hat', 'Open hat']);
  });

  it('clamps settings, marks sampled pads and drops oversized samples', () => {
    const data = pcmToBase64(new Float32Array(480).fill(0.25));
    const d = sanitizeDrum({ on: 5, pads: [
      { name: '  ', pitch: 99, decay: 0, level: 4, pan: -3, choke: 9, synth: 420 },
      { name: 'Desk knock', sample: { rate: 1, data } },
      { sample: { rate: 48000, data: 'A'.repeat(600000) } },
    ] });
    expect(d.on).toBe(1);
    // v2.8: synth indexes the 128-sound drum library (was clamped to 7 in 2.7)
    expect(d.pads[0]).toMatchObject({ name: 'Kick', pitch: 24, decay: 0.02, level: 1, pan: -1, choke: 4, synth: 127 });
    expect(d.pads[1]).toMatchObject({ name: 'Desk knock', synth: -1, sample: { rate: 8000, data } });
    expect(d.pads[2].sample).toBeNull();
    expect(d.pads[2].synth).toBe(2);
  });

  it('keeps lanes only when they hold a hit, clamped and rounded', () => {
    expect(sanitizeLanes(undefined, SEQ_STEPS)).toBeNull();
    expect(sanitizeLanes([[0, 0]], SEQ_STEPS)).toBeNull();
    const l = sanitizeLanes([[0.123, 2, -1]], SEQ_STEPS);
    expect(l).toHaveLength(KIT_PADS);
    expect(l[0].slice(0, 3)).toEqual([0.12, 1, 0]);
    expect(l[7]).toHaveLength(SEQ_STEPS);
  });

  it('round-trips a session with a kit and lanes, and leaves old sessions without them', () => {
    const st = JSON.parse(JSON.stringify(defaultState()));
    const plain = migrateState(JSON.parse(JSON.stringify(st)));
    expect(plain.parts[0].drum.on).toBe(0);
    expect('drumLanes' in plain.parts[0].patterns[0]).toBe(false);
    st.parts[0].drum = { on: 1, pads: [{ name: 'Tap', sample: { rate: 48000, data: pcmToBase64(new Float32Array(64).fill(0.1)) } }] };
    st.parts[0].patterns[0].drumLanes = [[1, 0, 0.5]];
    const m = migrateState(st);
    expect(m.parts[0].drum.pads[0].synth).toBe(-1);
    expect(m.parts[0].patterns[0].drumLanes[0].slice(0, 3)).toEqual([1, 0, 0.5]);
    expect(migrateState(JSON.parse(JSON.stringify(m)))).toEqual(m);
  });

  it('undo snapshots copy pad settings but share sample data', () => {
    const s = defaultState();
    s.parts[0].drum.pads[0] = { ...s.parts[0].drum.pads[0], synth: -1, sample: { rate: 48000, data: 'AAAA' } };
    const store = createStore(s);
    const snap = snapshotState(store);
    store.set('parts.0.drum.pads.0.pitch', 7);
    expect(snap.parts[0].drum.pads[0].pitch).toBe(0);
    expect(snap.parts[0].drum.pads[0].sample).toEqual({ rate: 48000, data: 'AAAA' });
    expect(snap.parts[0].drum.pads[0].sample).not.toBe(store.get('parts.0.drum.pads.0.sample'));
  });
});

describe('engine', () => {
  it('a kit track plays pads for its notes; off, the track is a synth again', () => {
    const dsp = makeDSP({ terrainA: 0 });
    dsp.handleMessage({ t: 'kit', part: 0, on: 1, pads: SYNTH_DRUMS.map((_, i) => ({ synth: i, gain: 0.8, pitch: 0, decay: 1, pan: 0, choke: 0 })) });
    const kick = render(dsp, 0.4, (d, t, b) => { if (b === 0) d.handleMessage({ t: 'noteOn', part: 0, note: KIT_BASE_NOTE, vel: 1 }); });
    expect(peak(kick.L)).toBeGreaterThan(0.05);
    // the kick's energy sits low: well under 1 kHz of zero crossings
    let zc = 0; for (let i = 1; i < SR * 0.2; i++) if ((kick.L[i - 1] < 0) !== (kick.L[i] < 0)) zc++;
    expect(zc / 0.2).toBeLessThan(1000);
    expect(kick.L.every(Number.isFinite)).toBe(true);
  });

  it('a settings-only update keeps the pad sound', () => {
    const dsp = makeDSP({ terrainA: 0 });
    const pads = SYNTH_DRUMS.map((_, i) => ({ synth: i, gain: 0.8, pitch: 0, decay: 1, pan: 0, choke: 0 }));
    dsp.handleMessage({ t: 'kit', part: 0, on: 1, pads });
    const before = dsp.partAt(0).kit.pads[1].data;
    dsp.handleMessage({ t: 'kit', part: 0, on: 1, pads: pads.map(p => ({ ...p, synth: undefined, keep: 1, pitch: 3 })) });
    expect(dsp.partAt(0).kit.pads[1].data).toBe(before);
    expect(dsp.partAt(0).kit.pads[1].pitch).toBe(3);
  });
});

describe('sync', () => {
  function setup() {
    const store = createStore(defaultState());
    const batches = [];
    let pending = null;
    const sync = createStoreSync({ store, post: (m) => batches.push(m), onGlobal: () => {}, defer: (fn) => { pending = fn; } });
    const run = () => { const f = pending; pending = null; if (f) f(); };
    return { store, sync, batches, run };
  }

  it('sends each pad sound once, then only settings while a knob moves', () => {
    const { store, sync, batches, run } = setup();
    sync.snapshot();
    const data = pcmToBase64(new Float32Array(256).fill(0.2));
    store.set('parts.0.drum', { ...defaultDrum(), on: 1, pads: defaultDrum().pads.map((p, i) => (i === 0 ? { ...p, synth: -1, sample: { rate: 48000, data } } : p)) });
    run();
    let kit = batches.at(-1).find(m => m.t === 'kit');
    expect(kit.pads[0].pcm).toBeInstanceOf(Float32Array);
    expect(kit.pads[1].synth).toBe(1);
    store.set('parts.0.drum.pads.0.pitch', 5);
    run();
    kit = batches.at(-1).find(m => m.t === 'kit');
    expect(kit.pads.every(p => p.keep === 1 && !p.pcm)).toBe(true);
    expect(kit.pads[0].pitch).toBe(5);
    // a full snapshot always carries the sounds
    const snapKit = sync.snapshot().find(m => m.t === 'kit' && m.part === 0);
    expect(snapKit.pads[0].pcm).toBeInstanceOf(Float32Array);
  });
});

describe('sequencer lanes', () => {
  function kitSession() {
    const st = JSON.parse(JSON.stringify(defaultState()));
    st.global.tempo = 120; st.global.swing = 0;
    st.parts[0].seqOn = 1;
    st.parts[0].drum.on = 1;
    const pat = st.parts[0].patterns[0];
    pat.steps.forEach(s => { s.on = 1; });           // melodic steps are ignored on a kit track
    pat.drumLanes = Array.from({ length: KIT_PADS }, () => new Array(SEQ_STEPS).fill(0));
    for (let c = 0; c < 16; c += 4) pat.drumLanes[0][c] = 1;   // kick on the beat
    pat.drumLanes[2][2] = 0.5;                                   // one closed hat
    return st;
  }

  it('bounce plays the lanes as pad notes at their velocities', () => {
    const ev = sequencerEvents(kitSession(), 1).filter(e => e.msg.t === 'noteOn' && e.msg.part === 0);
    expect(ev.map(e => e.msg.note)).toEqual([36, 38, 36, 36, 36]);
    expect(ev.map(e => e.time)).toEqual([0, 0.25, 0.5, 1, 1.5].map(t => expect.closeTo(t, 9)));
    expect(ev[1].msg.vel).toBe(0.5);
  });

  it('the live transport plays the same hits', () => {
    const clock = createFakeClock({ startSec: 1 });
    const engine = createFakeEngine(clock);
    const store = createStore(kitSession());
    const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
    const t0 = clock.ctx.currentTime + START_DELAY;
    music.transport.play();
    clock.advance(1.9);
    music.transport.stop();
    const ons = engine.ons(0).filter(e => e.time < t0 + 1.95);
    expect(ons.map(e => e.note)).toEqual([36, 38, 36, 36, 36]);
    expect(ons.map(e => e.time - t0)).toEqual([0, 0.25, 0.5, 1, 1.5].map(t => expect.closeTo(t, 6)));
    expect(ons[1].vel).toBeCloseTo(0.5, 6);
  });
});
