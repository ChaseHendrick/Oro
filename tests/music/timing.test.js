import { describe, it, expect } from 'vitest';
import { createTimebase } from '../../src/music/timing.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createMusic } from '../../src/music/music.js';
import { createFakeClock, createFakeEngine } from './fakes.js';

function fakeEngine({ currentTime, perf, ts, latency = 0.04 }) {
  return {
    context: {
      currentTime, state: 'running', outputLatency: latency, baseLatency: 0,
      getOutputTimestamp: () => ts,
    },
    perf,
  };
}

describe('timebase', () => {
  it('uses getOutputTimestamp when it agrees with the audio clock', () => {
    // Heard now: audio 9.96 s at 20 000 ms (40 ms of output latency).
    const e = fakeEngine({ currentTime: 10, perf: 20000, ts: { contextTime: 9.962, performanceTime: 20001 } });
    const tb = createTimebase(e, { perfNow: () => e.perf });
    expect(tb.audioToPerf(10.962)).toBeCloseTo(21001, 6);
    expect(tb.perfToAudio(20001)).toBeCloseTo(9.962, 9);
  });

  it('ignores a stale timestamp that is seconds off and falls back to currentTime', () => {
    // Left over from before a suspend: contextTime 0.5 s at 3 000 ms, while the clock is at 10 s / 20 000 ms.
    const e = fakeEngine({ currentTime: 10, perf: 20000, ts: { contextTime: 0.5, performanceTime: 3000 } });
    const tb = createTimebase(e, { perfNow: () => e.perf });
    expect(tb.audioToPerf(10)).toBeCloseTo(20040, 6);
    expect(tb.heardDelayMs(10.5)).toBeCloseTo(540, 6);
  });
});

describe('external clock guard', () => {
  it('anchors a pulse whose mapped time is seconds away at now, so steps and synced LFOs stay put', () => {
    const clock = createFakeClock({ startSec: 1 });
    const engine = createFakeEngine(clock);
    const anchors = [];
    engine.setTransport = (a) => anchors.push({ ...a, now: clock.ctx.currentTime });
    const s = defaultState();
    s.parts[0].seq.enabled = 1;
    s.parts[0].seq.steps.forEach(st => { st.on = 1; });
    const store = createStore(s);
    const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
    const t = music.transport;
    t.setFollow(true);
    t.syncStart({ beat: 0 });
    const spp = 0.5 / 24;
    for (let i = 0; i < 72; i++) {
      clock.advance(spp, 0.002);
      // The pulses on beats 1 and 2 arrive with broken times, 30 s in the future and in the past.
      const bad = i === 24 ? 30 : i === 48 ? -30 : 0;
      t.syncTick({ beat: i / 24, time: clock.ctx.currentTime + bad, bpm: 120 });
    }
    // The engine is told where each beat is; none of those anchors may be seconds off.
    expect(anchors.length).toBeGreaterThanOrEqual(3);
    for (const a of anchors) expect(Math.abs(a.beatTime - a.now)).toBeLessThan(0.5);
    // Three beats of 16ths, none dropped, all on the grid.
    const ons = engine.ons(0);
    expect(ons.length).toBeGreaterThanOrEqual(12);
    for (let i = 1; i < ons.length; i++) expect(ons[i].time - ons[i - 1].time).toBeCloseTo(0.125, 3);
  });
});
