import { describe, it, expect } from 'vitest';
import {
  bounceOptions, normaliseEvents, stemParts, passInit, renderDspHere, MAX_BOUNCE_SECONDS,
} from '../../src/audio/bounce.js';
import { sequencerEvents, swingBeat } from '../../src/audio/bounce-events.js';
import { createStoreSync } from '../../src/audio/sync.js';
import { jobFor, buildTerrainLevels } from '../../src/audio/terrain-jobs.js';
import { createStore } from '../../src/core/store.js';
import { defaultState, NUM_PARTS } from '../../src/core/params.js';

const ev = (time, msg) => ({ time, msg });

describe('bounce options', () => {
  it('applies defaults and limits', () => {
    expect(bounceOptions({}, 120)).toMatchObject({ bars: 4, tailSeconds: 2, songSeconds: 8, totalSeconds: 10, stems: false, fx: true });
    expect(bounceOptions({ bars: 0.2, tailSeconds: -3, fx: false, stems: 1 }, 120)).toMatchObject({ bars: 1, tailSeconds: 0, fx: false, stems: true });
    expect(bounceOptions({ tailSeconds: 999 }, 120).tailSeconds).toBe(30);
    expect(() => bounceOptions({ bars: 512 }, 40)).toThrow(/minutes/);
    expect(MAX_BOUNCE_SECONDS).toBe(900);
  });
});

describe('event lists', () => {
  it('sorts stably, stamps each message with its time and drops junk', () => {
    const list = normaliseEvents([
      ev(0.5, { t: 'noteOff', part: 0, note: 60 }),
      ev(0, { t: 'noteOn', part: 0, note: 60, vel: 1, time: 99 }),
      null, { time: 1 }, ev(0.5, { t: 'noteOn', part: 1, note: 62 }), ev(-2, { t: 'params', part: 0, p: { morph: 1 } }),
      ev(9, { t: 'noteOn', part: 0, note: 64 }), ev(9, { t: 'noteOff', part: 0, note: 64 }),
    ], 8);
    expect(list.map(e => [e.time, e.msg.t, e.msg.time])).toEqual([
      [0, 'noteOn', 0], [0, 'params', 0], [0.5, 'noteOff', 0.5], [0.5, 'noteOn', 0.5], [9, 'noteOff', 9],
    ]);
    expect(normaliseEvents('nope')).toEqual([]);
  });

  it('picks stem parts: playing, not muted, solo rules', () => {
    const st = defaultState();
    const evs = normaliseEvents([ev(0, { t: 'noteOn', part: 0, note: 60 }), ev(0, { t: 'noteOn', part: 2, note: 60 }), ev(0, { t: 'noteOn', part: 3, note: 60 })]);
    expect(stemParts(st, evs)).toEqual([0, 2, 3]);
    st.parts[3].params.mute = 1;
    expect(stemParts(st, evs)).toEqual([0, 2]);
    st.parts[2].params.solo = 1;
    expect(stemParts(st, evs)).toEqual([2]);
  });

  it('builds the init list: timed messages inline, others posted later, stems muted around one part', () => {
    const evs = normaliseEvents([
      ev(0, { t: 'transport', playing: true, beatTime: 0, beat: 0 }),
      ev(0.25, { t: 'noteOn', part: 0, note: 60, vel: 1 }), ev(0.25, { t: 'noteOn', part: 1, note: 67, vel: 1 }),
      ev(0.5, { t: 'bend', part: 1, v: 0.5 }), ev(0.75, { t: 'params', part: 1, p: { centerX: 0.2 }, ramp: 0.1 }),
    ]);
    const terrains = [0, 1, 2, 3].map(part => ({ t: 'terrain', part, slot: 0 }));
    const mix = passInit({ snapshot: [{ t: 'global', p: {} }], terrains, events: evs });
    expect(mix.init.map(m => m.t)).toEqual(['global', 'terrain', 'terrain', 'watch', 'transport', 'noteOn', 'noteOn', 'params']);
    expect(mix.init.filter(m => m.t === 'terrain').map(m => m.part)).toEqual([0, 1]);   // only parts that play
    expect(mix.init.find(m => m.t === 'watch').part).toBe(-1);
    expect(mix.late.map(e => e.msg.t)).toEqual(['bend']);
    const stem = passInit({ snapshot: [], terrains, events: evs, solo: 1 });
    expect(stem.init.filter(m => m.t === 'terrain').map(m => m.part)).toEqual([1]);
    const mutes = stem.init.filter(m => m.t === 'params' && m.p.mute !== undefined);
    expect(mutes.map(m => [m.part, m.p.mute, m.p.solo])).toEqual([[0, 1, 0], [1, 0, 0], [2, 1, 0], [3, 1, 0]]);
    expect(stem.init.filter(m => m.t === 'noteOn').map(m => m.part)).toEqual([1]);
    expect(stem.init.some(m => m.t === 'transport')).toBe(true);
  });
});

describe('fallback sequencer events', () => {
  function session(edit) {
    const st = defaultState();
    st.global.tempo = 120;
    const seq = st.parts[0].seq;
    seq.enabled = 1; seq.rate = 3; seq.length = 4;                  // 16ths, 4-step loop
    seq.steps[0] = { ...seq.steps[0], on: 1, degree: 0, gate: 0.5 };
    seq.steps[2] = { ...seq.steps[2], on: 1, degree: 2, gate: 1, slide: 1 };
    seq.steps[3] = { ...seq.steps[3], on: 1, degree: 4, accent: 1, lock: 1, lx: 0.1, ly: 0.9 };
    if (edit) edit(st);
    return st;
  }

  it('renders steps, gates, slides, accents and locks for every bar', () => {
    const evs = sequencerEvents(session(), 1);
    expect(evs[0].msg).toMatchObject({ t: 'transport', playing: true, beatTime: 0, beat: 0, spb: 0.5 });
    const ons = evs.filter(e => e.msg.t === 'noteOn');
    const offs = evs.filter(e => e.msg.t === 'noteOff');
    expect(ons.length).toBe(12);                       // 3 notes x 4 loops of a 4-step pattern in one bar
    expect(offs.length).toBe(ons.length);
    expect(ons[0].time).toBe(0);
    expect(ons[1].time).toBeCloseTo(2 * 0.125, 9);    // step 2 at a 16th = 0.125 s
    expect(ons[2].msg.vel).toBe(1);                   // accent
    // the slid note overlaps the next one (legato) instead of ending at its gate
    const slidOff = offs.find(e => e.msg.note === ons[1].msg.note && e.time > ons[1].time);
    expect(slidOff.time).toBeCloseTo(ons[2].time + 0.004, 9);
    const locks = evs.filter(e => e.msg.t === 'params');
    expect(locks.length).toBe(4);
    expect(locks[0].msg).toMatchObject({ part: 0, p: { centerX: 0.1, centerY: 0.9 } });
    expect(locks[0].msg.ramp).toBeCloseTo(0.5 * 0.125, 9);
    for (let i = 1; i < evs.length; i++) expect(evs[i].time).toBeGreaterThanOrEqual(evs[i - 1].time);
    expect(Math.max(...evs.map(e => e.time))).toBeLessThanOrEqual(2);
  });

  it('swings off-beat 16ths like the transport and skips disabled or excluded parts', () => {
    expect(swingBeat(0.25, 0)).toBe(0.25);
    expect(swingBeat(0.25, 0.6)).toBeCloseTo(0.375, 9);
    expect(swingBeat(0.5, 0.6)).toBe(0.5);
    const swung = sequencerEvents(session((st) => { st.global.swing = 0.6; st.parts[0].seq.steps[1].on = 1; }), 1);
    const on1 = swung.filter(e => e.msg.t === 'noteOn')[1];
    expect(on1.time).toBeCloseTo(0.375 * 0.5, 9);
    expect(sequencerEvents(session(), 1, { parts: [1, 2] }).filter(e => e.msg.t === 'noteOn').length).toBe(0);
    expect(sequencerEvents(session((st) => { st.parts[0].seq.enabled = 0; }), 2).length).toBe(1);
  });
});

describe('offline render on the main thread (real DSP)', { timeout: 60000 }, () => {
  function fakeOfflineContext(sampleRate) {
    return {
      sampleRate,
      createBuffer(channels, length) {
        const data = Array.from({ length: channels }, () => new Float32Array(length));
        return { length, numberOfChannels: channels, sampleRate, getChannelData: (c) => data[c] };
      },
    };
  }

  it('plays timed notes at their sample and applies late messages', async () => {
    const sr = 24000;
    const store = createStore(defaultState());
    store.set('parts.0.params.attack', 0.001);
    store.set('parts.0.params.release', 0.01);
    store.set('parts.0.params.delaySend', 0.5);
    const sync = createStoreSync({ store, post: () => {}, defer: () => {} });
    const terrains = [];
    for (let p = 0; p < NUM_PARTS; p++) {
      for (const [s, slot] of [[0, 'A'], [1, 'B']]) terrains.push({ t: 'terrain', part: p, slot: s, levels: buildTerrainLevels(jobFor(store.get(`parts.${p}.params`), null, slot, 64)) });
    }
    const evs = normaliseEvents([
      ev(0.1, { t: 'noteOn', part: 0, note: 57, vel: 1 }),
      ev(0.3, { t: 'noteOff', part: 0, note: 57 }),
      ev(0.2, { t: 'wheel', part: 0, v: 1 }),
    ]);
    const { init, late } = passInit({ snapshot: sync.snapshot(), terrains, events: evs });
    const frames = Math.round(0.6 * sr);
    let lastProgress = 0;
    const [dry, delay, reverb] = await renderDspHere(fakeOfflineContext(sr), init, late, frames, (f) => { lastProgress = f; });
    expect(lastProgress).toBe(frames);
    const L = dry.getChannelData(0);
    const rms = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += L[i] * L[i]; return Math.sqrt(s / (b - a)); };
    const onAt = Math.round(0.1 * sr);
    expect(rms(0, onAt - 64)).toBeLessThan(1e-6);            // silent before the note-on sample
    expect(rms(onAt + 200, onAt + 2400)).toBeGreaterThan(0.01);
    expect(rms(Math.round(0.4 * sr), frames)).toBeLessThan(1e-3);  // released
    let delayEnergy = 0;
    for (const v of delay.getChannelData(0)) delayEnergy += v * v;
    expect(delayEnergy).toBeGreaterThan(0);
    expect(reverb.getChannelData(1).every(Number.isFinite)).toBe(true);
  });
});

describe('bounce encoding', () => {
  it('encodes a rendered buffer to 24-bit WAV and measures it on the way', async () => {
    const { encodeBuffer, bufferStats } = await import('../../src/audio/bounce.js');
    const { decodeWav } = await import('../../src/audio/wav.js');
    const n = 70000;   // more than one encode slice
    const L = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(i / 10));
    const R = Float32Array.from({ length: n }, (_, i) => (i === 1234 ? NaN : -0.25));
    const buffer = { numberOfChannels: 2, length: n, sampleRate: 48000, getChannelData: (c) => (c ? R : L) };
    const { blob, stats } = await encodeBuffer(buffer);
    expect(stats).toEqual(bufferStats(buffer));
    expect(stats.bad).toBe(1);
    expect(stats.peak).toBeCloseTo(0.5, 4);
    const wav = decodeWav(new Uint8Array(await blob.arrayBuffer()));
    expect(wav).toMatchObject({ sampleRate: 48000, frames: n, bitsPerSample: 24 });
    expect(wav.channels[0][157]).toBeCloseTo(L[157], 6);
    expect(wav.channels[1][1234]).toBe(0);   // NaN is written as silence
  });
});
