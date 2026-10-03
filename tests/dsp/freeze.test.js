// v2.8 Freeze: a track rendered offline into a loop and played in step with
// the transport instead of its voices (src/audio/freeze.js, OroDSP {t:'freeze'}).
import { describe, it, expect } from 'vitest';
import { OroDSP } from '../../src/dsp/dsp-core.js';
import { terrainChain, render, rms, allFinite, SR } from './helpers.js';
import { sequencerEvents } from '../../src/audio/bounce-events.js';
import {
  renderFrozenLoop, freezeLoopBeats, patternBeats, canFreeze, freezeSignature, sameSignature, createFreezeController,
} from '../../src/audio/freeze.js';
import { defaultState } from '../../src/core/params.js';
import { createStore } from '../../src/core/store.js';
import { moveTrack } from '../../src/core/tracks.js';

const TEMPO = 120;
const PATCH = { filterType: 1, cutoff: 3000, attack: 0.002, decay: 0.2, sustain: 0.6, release: 0.15, unison: 2, detune: 10, level: 0.8, delaySend: 0, reverbSend: 0 };

function session() {
  const st = defaultState(2);
  st.global.tempo = TEMPO;
  const p = st.parts[0];
  Object.assign(p.params, PATCH);
  p.seqOn = 1;
  const steps = p.patterns[0].steps;
  [0, 3, 6, 8, 11, 14].forEach((i, k) => Object.assign(steps[i], { on: 1, degree: [0, 2, 4, 1, 5, 3][k], gate: 0.6 }));
  return st;
}

function initFor(st) {
  const init = [{ t: 'tracks', count: st.parts.length }, { t: 'global', p: { ...st.global } }];
  st.parts.forEach((p, i) => init.push({ t: 'params', part: i, p: { ...p.params } }));
  init.push({ t: 'terrain', part: 0, slot: 0, levels: terrainChain(0) }, { t: 'terrain', part: 0, slot: 1, levels: terrainChain(1) });
  init.push({ t: 'watch', part: -1 });
  return init;
}
const timed = (evs) => evs.map(e => ({ ...e.msg, time: e.time }));

function liveDSP(st, bars) {
  const dsp = new OroDSP(SR);
  for (const m of initFor(st)) dsp.handleMessage(m);
  for (const m of timed(sequencerEvents(st, bars))) dsp.handleMessage(m);
  return dsp;
}

async function frozenLoop(st, beats = 4, warmLoops = 2) {
  const events = timed(sequencerEvents(st, Math.ceil((warmLoops + 1) * beats / 4) + 1));
  return renderFrozenLoop({ sampleRate: SR, init: [...initFor(st), ...events], part: 0, beats, tempo: TEMPO, warmLoops });
}

function frozenDSP(st, loop, transport = { playing: true, beatTime: 0, beat: 0 }) {
  const dsp = new OroDSP(SR);
  for (const m of initFor(st)) dsp.handleMessage(m);
  dsp.handleMessage({ t: 'freeze', part: 0, L: loop.L, R: loop.R, frames: loop.frames, beats: loop.beats });
  dsp.handleMessage({ t: 'transport', ...transport });
  return dsp;
}

// CPU time (not wall time, so other test files running in parallel do not skew it), best of 3
const cpu = (fn) => {
  let best = Infinity;
  for (let k = 0; k < 3; k++) { const c0 = process.cpuUsage(); fn(); const c = process.cpuUsage(c0); best = Math.min(best, (c.user + c.system) / 1000); }
  return best;
};

describe('freeze', () => {
  it('loop lengths: whole pattern passes filling whole bars', () => {
    expect(freezeLoopBeats(4)).toBe(4);
    expect(freezeLoopBeats(3)).toBe(12);
    expect(freezeLoopBeats(1.25)).toBe(5);
    expect(freezeLoopBeats(16 / 6)).toBeCloseTo(8, 9);
    expect(freezeLoopBeats(4, 2)).toBe(8);
    expect(freezeLoopBeats(3, 1)).toBe(6);
    expect(freezeLoopBeats(0)).toBe(0);
    expect(patternBeats(session().parts[0])).toBe(4);
  });

  it('only freezes a track with a playing pattern and a pinned dot', () => {
    const st = session();
    expect(canFreeze(st.parts[0]).ok).toBe(true);
    expect(canFreeze(st.parts[1]).ok).toBe(false);
    const moving = JSON.parse(JSON.stringify(st.parts[0])); moving.dot.mode = 2;
    expect(canFreeze(moving).reason).toMatch(/Pin/);
    const empty = JSON.parse(JSON.stringify(st.parts[0])); for (const s of empty.patterns[0].steps) s.on = 0;
    expect(canFreeze(empty).ok).toBe(false);
  });

  it('frozen playback matches the live render, aligned with the transport, at a fraction of the CPU', async () => {
    const st = session();
    const loop = await frozenLoop(st);
    expect(loop.frames).toBe(2 * SR);       // 4 beats at 120 bpm
    expect(allFinite(loop.L) && allFinite(loop.R)).toBe(true);
    expect(rms(loop.L)).toBeGreaterThan(0.01);

    let live = null, frozen = null;
    // render time only (building a DSP and loading its tables is the same either way)
    const lives = [0, 1, 2].map(() => liveDSP(st, 4));
    const frozens = [0, 1, 2].map(() => { const d = frozenDSP(st, loop); for (const m of timed(sequencerEvents(st, 4))) d.handleMessage(m); return d; });
    const idle = [0, 1, 2].map(() => { const d = new OroDSP(SR); for (const m of initFor(st)) d.handleMessage(m); return d; });
    let k1 = 0, k2 = 0, k3 = 0;
    const tIdle = cpu(() => { render(idle[k3++], 8); });   // the engine with nothing playing
    const tLive = cpu(() => { live = render(lives[k1++], 8); });
    const tFrozen = cpu(() => { frozen = render(frozens[k2++], 8); });
    // the third pass (the one captured) is the same audio, up to Float32 rounding
    const a = Math.round(4 * SR), b = Math.round(6 * SR);
    const err = rms(Float32Array.from(live.L.subarray(a, b), (x, i) => x - frozen.L[a + i]));
    expect(err / rms(live.L, a, b)).toBeLessThan(1e-4);
    // the other passes match in overall level (live passes differ in detail:
    // the two unison copies start at random phases on every note)
    const ratio = rms(frozen.L, 2 * SR, 8 * SR) / rms(live.L, 2 * SR, 8 * SR);
    console.log(`[freeze] level of frozen against live over passes 2 to 4: ${(20 * Math.log10(ratio)).toFixed(2)} dB`);
    expect(Math.abs(20 * Math.log10(ratio))).toBeLessThan(2);
    // the frozen track ignores its notes and costs much less to render
    const own = (t) => Math.max(0.5, t - tIdle);
    console.log(`[freeze] 8 s, one track: idle engine ${tIdle.toFixed(0)} ms; with the track live ${tLive.toFixed(0)} ms, frozen ${tFrozen.toFixed(0)} ms; the track's own cost ${own(tLive).toFixed(0)} ms live, ${own(tFrozen).toFixed(0)} ms frozen (${(100 * (1 - own(tFrozen) / own(tLive))).toFixed(0)}% less)`);
    expect(tFrozen).toBeLessThan(tLive);
    expect(own(tFrozen)).toBeLessThan(0.4 * own(tLive));
  }, 60000);

  it('follows the transport: silent before beat 0 and when stopped, in place mid-song', async () => {
    const st = session();
    const loop = await frozenLoop(st);
    const gain = (st.parts[0].params.level ** 2) * 0.5;
    // the transport starts 0.5 s into the render
    const d1 = frozenDSP(st, loop, { playing: true, beatTime: 0.5, beat: 0 });
    const r1 = render(d1, 1.5);
    expect(rms(r1.L, 0, Math.round(0.49 * SR))).toBe(0);
    const at = Math.round(0.5 * SR) + 20000;
    expect(r1.L[at]).toBeCloseTo(loop.L[20000] * gain, 5);
    // a transport anchored at beat 2 (half way through the loop) at time 0
    const d2 = frozenDSP(st, loop, { playing: true, beatTime: 0, beat: 2 });
    const r2 = render(d2, 0.5);
    expect(r2.L[12345]).toBeCloseTo(loop.L[SR + 12345] * gain, 5);
    // stop: the loop fades out within a few tens of ms
    d2.handleMessage({ t: 'transport', playing: false });
    const r3 = render(d2, 0.2);
    expect(rms(r3.L, Math.round(0.05 * SR))).toBe(0);
  }, 60000);

  it('unfreezing crossfades back to the voices, which play the next notes again', async () => {
    const st = session();
    const loop = await frozenLoop(st);
    const d = frozenDSP(st, loop);
    render(d, 0.5);
    d.handleMessage({ t: 'freeze', part: 0, L: null });
    render(d, 0.1);
    expect(d.parts[0].frozen).toBe(null);
    d.handleMessage({ t: 'noteOn', part: 0, note: 60, vel: 0.8 });
    const r = render(d, 0.2);
    expect(d.parts[0].activeCount()).toBeGreaterThan(0);
    expect(rms(r.L)).toBeGreaterThan(0.005);
  }, 60000);

  it('the controller unfreezes on sound edits but not on mix moves, and follows reorders', async () => {
    const store = createStore(session());
    const calls = [];
    const fake = { L: new Float32Array(10), R: new Float32Array(10), frames: 9, beats: 4, ms: 1 };
    const engine = { renderFreeze: async () => fake, setFrozen: (i, loop) => calls.push([i, !!loop]) };
    const fz = createFreezeController({ store, engine, renderEvents: () => [] });
    const unfrozen = [];
    fz.on('unfrozen', (e) => unfrozen.push(e));
    expect((await fz.freeze(1)).ok).toBe(false);             // no pattern
    expect((await fz.freeze(0)).ok).toBe(true);
    expect(fz.isFrozen(0)).toBe(true);
    store.set('parts.0.params.level', 0.3, { source: 'ui' });   // mix only
    store.set('parts.0.params.sendA', 0.5, { source: 'ui' });
    store.set('parts.0.name', 'Bass', { source: 'ui' });
    expect(fz.isFrozen(0)).toBe(true);
    moveTrack(store, 0, 1);                                    // the freeze moves with its track
    expect(fz.isFrozen(1)).toBe(true);
    expect(fz.isFrozen(0)).toBe(false);
    store.set('parts.1.params.cutoff', 800, { source: 'ui' }); // the sound changed
    expect(fz.isFrozen(1)).toBe(false);
    expect(unfrozen).toEqual([{ part: 1, reason: 'edit' }]);
    expect(calls).toEqual([[0, true], [1, false]]);
    // tempo changes what the pattern plays: unfreeze too
    expect((await fz.freeze(1)).ok).toBe(true);
    store.set('global.tempo', 100, { source: 'ui' });
    expect(fz.isFrozen(1)).toBe(false);
    fz.dispose();
  });

  it('signatures ignore mix settings and dot-lock moves, but see the sound', () => {
    const st = session();
    const p = st.parts[0];
    const s0 = freezeSignature(p, st.global);
    const mix = JSON.parse(JSON.stringify(p)); mix.params.level = 0.1; mix.params.mute = 1; mix.params.sendB = 1;
    expect(sameSignature(freezeSignature(mix, st.global), s0)).toBe(true);
    const snd = JSON.parse(JSON.stringify(p)); snd.params.morph = 0.5;
    expect(sameSignature(freezeSignature(snd, st.global), s0)).toBe(false);
    const locked = JSON.parse(JSON.stringify(p)); locked.patterns[0].steps[0].lock = 1;
    const l0 = freezeSignature(locked, st.global);
    locked.params.centerX = 0.9;
    expect(sameSignature(freezeSignature(locked, st.global), l0)).toBe(true);
  });
});
