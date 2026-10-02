import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPedalMidi, createLfoSource, mapValue, shapeCurve, PEDAL_SOURCES } from '../../src/pedals/pedal-midi.js';
import { createStore } from '../../src/core/store.js';

// A pedal-midi with a fake clock and a fake MIDI port that logs everything.
function rig(opts = {}) {
  const clock = { t: 1000 };
  const sent = [];
  const pm = createPedalMidi({
    send: (bytes, ts) => sent.push({ bytes: [...bytes], ts }),
    now: () => clock.t,
    autoPump: false,
    ...opts,
  });
  // Advance the clock in 1 ms steps, pumping like the timer would.
  const run = (ms, each) => {
    for (let i = 0; i < ms; i++) {
      if (each) each(clock.t);
      pm.pump(clock.t);
      clock.t += 1;
    }
    pm.pump(clock.t);
  };
  // Let everything queued go out (stepping the clock, so slots keep their times).
  const drain = (ms = 5000) => run(ms);
  return { pm, clock, sent, run, drain };
}
const status = (ch) => 0xb0 | (ch - 1);
const forCC = (sent, ch, cc) => sent.filter(s => s.bytes[0] === status(ch) && s.bytes[1] === cc);

afterEach(() => { vi.useRealTimers(); });

describe('CC sending', () => {
  it('sends a CC on the pedal channel with the encoded value', () => {
    const { pm, sent } = rig();
    expect(pm.set('purrting', 'mix', 0.5)).toBe(true);
    expect(pm.set('lostAndFound', 'mix', 1)).toBe(true);
    pm.pump();
    expect(sent.map(s => s.bytes)).toEqual([[0xb0, 23, 64], [0xb1, 15, 127]]);
    expect(sent[0].ts).toBe(1000);
  });

  it('sends only when the 7-bit value changes', () => {
    const { pm, sent, run } = rig();
    pm.set('purrting', 'rate', 0.5); run(20);
    pm.set('purrting', 'rate', 0.5); run(20);
    pm.set('purrting', 'rate', 0.501); run(20); // still 64
    pm.set('purrting', 'rate', 0.52); run(20);  // 66
    expect(sent.map(s => s.bytes[2])).toEqual([64, 66]);
    expect(pm.stats().unchanged).toBeGreaterThanOrEqual(2);
  });

  it('rate-limits a 1 kHz control stream to about 100 Hz and still lands on the final value', () => {
    const { pm, sent, run, drain } = rig();
    let v = 0;
    run(1000, () => { v = (v + 0.013) % 1; pm.set('purrting', 'depth', v); });
    pm.set('purrting', 'depth', 0.25);
    drain();
    const msgs = forCC(sent, 1, 15);
    // At least 10 ms apart is at most 100 per second; and the budget is used.
    for (let i = 1; i < msgs.length; i++) expect(msgs[i].ts - msgs[i - 1].ts).toBeGreaterThanOrEqual(10 - 1e-9);
    const inFirstSecond = msgs.filter(m => m.ts < 2000).length;
    expect(inFirstSecond).toBeGreaterThanOrEqual(97);
    expect(inFirstSecond).toBeLessThanOrEqual(100);
    expect(msgs[msgs.length - 1].bytes[2]).toBe(32);
    expect(pm.stats().coalesced).toBeGreaterThan(800);
  });

  it('coalesces changes inside one slot: only the latest value goes out', () => {
    const { pm, sent, run } = rig({ lookaheadMs: 0 });
    pm.set('purrting', 'mix', 0.1);
    pm.pump(); // goes now
    pm.set('purrting', 'mix', 0.2);
    pm.set('purrting', 'mix', 0.3);
    pm.set('purrting', 'mix', 0.4);
    run(15);
    expect(sent.map(s => s.bytes[2])).toEqual([13, 51]);
    expect(sent[1].ts - sent[0].ts).toBeCloseTo(10, 6);
  });

  it('drops a pending change that returns to what the pedal already has', () => {
    const { pm, sent, run } = rig({ lookaheadMs: 0 });
    pm.set('purrting', 'mix', 0.5);
    pm.pump();
    pm.set('purrting', 'mix', 0.9);
    pm.set('purrting', 'mix', 0.5);
    run(30);
    expect(sent.map(s => s.bytes[2])).toEqual([64]);
  });

  it('shares each pedal\'s budget fairly between controls, and pedals do not share budgets', () => {
    const { pm, sent, run, drain } = rig();
    let v = 0;
    run(1000, () => {
      v += 0.0101;
      pm.set('purrting', 'rate', v % 1);
      pm.set('purrting', 'depth', (v * 1.7) % 1);
      pm.set('lostAndFound', 'blend', (v * 0.9) % 1);
    });
    drain();
    const first = (list) => list.filter(s => s.ts < 2000);
    const purr = first(sent.filter(s => s.bytes[0] === 0xb0)).length;
    const rate = first(forCC(sent, 1, 14)).length, depth = first(forCC(sent, 1, 15)).length;
    const lf = first(sent.filter(s => s.bytes[0] === 0xb1)).length;
    expect(purr).toBeLessThanOrEqual(100);
    expect(purr).toBeGreaterThanOrEqual(97);
    expect(Math.abs(rate - depth)).toBeLessThanOrEqual(2);
    expect(lf).toBeGreaterThanOrEqual(97);
  });
});

describe('bypass, presets, tap and transport', () => {
  it('bypass honours the Purr-ting inverted On/Off and always sends', () => {
    const { pm, sent, run } = rig();
    expect(pm.bypass('purrting', false).ok).toBe(true); // engaged -> 0
    run(5);
    expect(pm.bypass('purrting', true).ok).toBe(true);  // bypassed -> 127
    run(5);
    pm.bypass('purrting', true); run(5);                 // again: the pedal may have been stomped
    pm.engage('purrting', true); run(5);
    expect(sent.map(s => s.bytes)).toEqual([[0xb0, 85, 0], [0xb0, 85, 127], [0xb0, 85, 127], [0xb0, 85, 0]]);
  });

  it('Nucleo bypass uses CC 0 with the usual direction and says it is unconfirmed', () => {
    const { pm, sent, run } = rig();
    const r = pm.bypass('nucleo', false);
    run(2);
    expect(r).toMatchObject({ ok: true, unconfirmed: true });
    expect(sent[0].bytes).toEqual([0xb0 | 3, 0, 127]);
  });

  it('explains when a pedal has no documented bypass', () => {
    const { pm, sent } = rig();
    for (const id of ['lostAndFound', 'xero']) {
      const r = pm.bypass(id, true);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/no documented bypass/);
      expect(r.reason).not.toMatch(/\u2014/);
    }
    expect(pm.bypass('nope', true).ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('Program Change checks the range, sends at once and forgets the cached CC values', () => {
    const { pm, sent, run } = rig();
    pm.set('purrting', 'mix', 0.5); run(20);
    expect(pm.programChange('purrting', 0).ok).toBe(false);
    expect(pm.programChange('xero', 3).ok).toBe(false);
    expect(pm.programChange('purrting', 12).ok).toBe(true);
    expect(pm.programChange('lostAndFound', 0).ok).toBe(true); // PC 0 = live
    run(5);
    pm.set('purrting', 'mix', 0.5); run(20); // same value, but the preset moved the knob: resend
    expect(sent.map(s => s.bytes)).toEqual([[0xb0, 23, 64], [0xc0, 12], [0xc1, 0], [0xb0, 23, 64]]);
  });

  it('a preset change overrides smooth changes queued before it', () => {
    const { pm, sent, run } = rig({ lookaheadMs: 0 });
    pm.set('purrting', 'mix', 0.1);
    pm.pump();
    pm.set('purrting', 'mix', 0.9); // pending for the next slot
    pm.programChange('purrting', 3);
    run(30);
    expect(sent.map(s => s.bytes)).toEqual([[0xb0, 23, 13], [0xc0, 3]]);
  });

  it('tap goes out exactly on time even during a CC flood', () => {
    const { pm, sent, run, clock } = rig();
    let v = 0;
    const tapAt = clock.t + 333.5;
    pm.tap('purrting', { time: tapAt });
    run(600, () => { v = (v + 0.017) % 1; pm.set('purrting', 'smear', v); });
    const taps = forCC(sent, 1, 86);
    expect(taps).toHaveLength(1);
    expect(taps[0].ts).toBe(tapAt);
    expect(taps[0].bytes[2]).toBe(127);
  });

  it('one-off messages reach Web MIDI early, so a stalled main thread cannot make a tap late', () => {
    const { pm, sent, clock } = rig();
    const at = clock.t + 200;
    pm.tap('purrting', { time: at });
    pm.pump(clock.t); // handed over now, 200 ms ahead, stamped with its own time
    expect(sent).toEqual([{ bytes: [0xb0, 86, 127], ts: at }]);
    // And it does not hold smooth CCs back until then.
    pm.set('purrting', 'mix', 0.5);
    pm.pump(clock.t);
    expect(sent[1]).toEqual({ bytes: [0xb0, 23, 64], ts: clock.t });
    // Beyond the window it waits, so clearQueue() can still cancel it.
    pm.tap('purrting', { time: clock.t + 1000 });
    pm.pump(clock.t);
    expect(sent).toHaveLength(2);
    pm.clearQueue('purrting');
    pm.pump(clock.t + 2000);
    expect(sent).toHaveLength(2);
  });

  it('tapTempo schedules taps on the beat (Lost + Found tap is CC 93 on channel 2)', () => {
    const { pm, sent, drain, clock } = rig();
    const start = clock.t + 50;
    const r = pm.tapTempo('lostAndFound', 120, { taps: 4, startMs: start });
    expect(r.ok).toBe(true);
    drain();
    expect(sent.map(s => s.bytes)).toEqual(Array(4).fill([0xb1, 93, 127]));
    expect(sent.map(s => s.ts)).toEqual([start, start + 500, start + 1000, start + 1500]);
    expect(pm.tapTempo('xero', 120).ok).toBe(false);
    expect(pm.tapTempo('purrting', 5).reason).toMatch(/between 20 and 400/);
  });

  it('looper transport triggers on the Xero (CC 20-24 on its channel)', () => {
    const { pm, sent, run } = rig();
    expect(pm.trigger('xero', 'record').ok).toBe(true);
    expect(pm.trigger('xero', 'stopRecord').ok).toBe(true);
    expect(pm.set('xero', 'play', 1)).toBe(true); // set() on a trigger fires it
    run(3);
    expect(sent.map(s => s.bytes)).toEqual([[0xb2, 22, 127], [0xb2, 23, 127], [0xb2, 20, 127]]);
    expect(pm.trigger('xero', 'rewind').ok).toBe(false);
  });
});

describe('scheduled sends', () => {
  it('holds a future change until the lookahead window and stamps it with its time', () => {
    const { pm, sent, clock } = rig();
    const at = clock.t + 200;
    pm.set('purrting', 'filter', 0.75, { time: at });
    pm.pump(clock.t + 150);
    expect(sent).toHaveLength(0);
    pm.pump(at - 20);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ bytes: [0xb0, 22, 95], ts: at });
  });

  it('coalesces two scheduled changes that fall in one slot, keeping the later one', () => {
    const { pm, sent, drain, clock } = rig();
    pm.set('purrting', 'filter', 0.2, { time: clock.t + 100 });
    pm.set('purrting', 'filter', 0.6, { time: clock.t + 105 });
    drain();
    expect(sent).toEqual([{ bytes: [0xb0, 22, 76], ts: 1105 }]);
  });

  it('spaces scheduled changes of different controls by the rate limit, in time order', () => {
    const { pm, sent, drain, clock } = rig();
    const t = clock.t + 100;
    pm.set('purrting', 'rate', 0.1, { time: t });
    pm.set('purrting', 'depth', 0.2, { time: t });
    pm.set('purrting', 'shape', 0.3, { time: t });
    drain();
    expect(sent.map(s => s.ts)).toEqual([t, t + 10, t + 20]);
  });

  it('runs by itself on timers when autoPump is on', () => {
    vi.useFakeTimers();
    const sent = [];
    const pm = createPedalMidi({ send: (b, ts) => sent.push({ b, ts }), now: () => Date.now() });
    const t0 = Date.now();
    pm.set('purrting', 'mix', 0.1);
    pm.set('purrting', 'mix', 0.2); // has to wait for the next 10 ms slot
    pm.set('purrting', 'rate', 0.3, { time: t0 + 300 });
    expect(sent).toHaveLength(2); // the first slot plus one handed over inside the 20 ms lookahead
    vi.advanceTimersByTime(400);
    expect(sent.map(s => s.b[1])).toEqual([23, 23, 14]);
    expect(sent[2].ts).toBe(t0 + 300);
    pm.dispose();
  });
});

describe('mapping layer', () => {
  it('maps a 0..1 source through range and curve', () => {
    expect(mapValue(0, { min: 0.2, max: 0.8 })).toBeCloseTo(0.2);
    expect(mapValue(1, { min: 0.2, max: 0.8 })).toBeCloseTo(0.8);
    expect(mapValue(0.5, { min: 0.2, max: 0.8, curve: 'Soft' })).toBeCloseTo(0.35);
    expect(mapValue(0.25, { curve: 2 })).toBeCloseTo(0.5);
    expect(mapValue(0.25, { min: 1, max: 0 })).toBeCloseTo(0.75); // inverted range
    expect(mapValue(-1, { bipolar: true })).toBe(0);
    expect(mapValue(0, { bipolar: true })).toBeCloseTo(0.5);
    expect(shapeCurve(4)).toBe(1);
    expect(PEDAL_SOURCES.map(s => s.id)).toContain('env3');
  });

  it('macros drive pedal CCs, straight from the store', () => {
    const { pm, sent, run } = rig();
    const store = createStore();
    expect(pm.map({ source: 'macro2', pedal: 'purrting', control: 'mix', min: 0.2, max: 0.8 })).toBeTruthy();
    const off = pm.bindStore(store); // pushes the current macro (0) once
    run(20);
    store.set('global.macro2', 1, { source: 'knob' }); run(20);
    store.set('global.macro2', 0, { source: 'knob' }); run(20);
    store.set('global.tempo', 99); run(20); // unrelated change: nothing new
    off();
    store.set('global.macro2', 0.5); run(20);
    expect(sent.map(s => s.bytes)).toEqual([[0xb0, 23, 25], [0xb0, 23, 102], [0xb0, 23, 25]]);
  });

  it('a part envelope and the guitar level are sources too; one source can drive several pedals', () => {
    const { pm, sent, run } = rig();
    pm.map({ source: 'env2', pedal: 'lostAndFound', control: 'blend' });
    pm.map({ source: 'env2', pedal: 'purrting', control: 'volume', min: 1, max: 0 });
    pm.map({ source: 'guitar', pedal: 'purrting', control: 'expression', curve: 'Hard' });
    expect(pm.input('env2', 0.7)).toBe(2);
    expect(pm.input('guitar', 0.25)).toBe(1);
    run(30);
    expect(sent.map(s => s.bytes)).toEqual(expect.arrayContaining([[0xb1, 18, 89], [0xb0, 27, 38], [0xb0, 11, 64]]));
    expect(sent).toHaveLength(3);
  });

  it('rejects mappings to unknown sources, pedals, controls and triggers', () => {
    const { pm } = rig();
    expect(pm.map({ source: 'nope', pedal: 'purrting', control: 'mix' })).toBeNull();
    expect(pm.map({ source: 'macro1', pedal: 'nope', control: 'mix' })).toBeNull();
    expect(pm.map({ source: 'macro1', pedal: 'purrting', control: 'nope' })).toBeNull();
    expect(pm.map({ source: 'macro1', pedal: 'purrting', control: 'tap' })).toBeNull();
    const id = pm.map({ source: 'macro1', pedal: 'purrting', control: 'mix' });
    expect(pm.mappings()).toHaveLength(1);
    expect(pm.unmap(id)).toBe(true);
    expect(pm.mappings()).toHaveLength(0);
  });

  it('a pedal LFO is computed ahead and sent with timestamps on the slot grid', () => {
    const { pm, sent, clock } = rig();
    const lfo = createLfoSource({ shape: 'sine', rateHz: 1 });
    pm.addLfo('lfo1', lfo);
    pm.map({ source: 'lfo1', pedal: 'lostAndFound', control: 'ramp' });
    for (let i = 0; i < 100; i++) { pm.tick(clock.t); clock.t += 10; }
    pm.pump(clock.t + 100);
    const msgs = sent.filter(s => s.bytes[1] === 20);
    expect(msgs.length).toBeGreaterThan(80);
    // Each value matches the LFO at its own timestamp (within one 7-bit step).
    for (const m of msgs) {
      const expected = Math.round(((lfo.valueAt(m.ts / 1000) + 1) / 2) * 127);
      expect(Math.abs(m.bytes[2] - expected)).toBeLessThanOrEqual(2);
    }
    for (let i = 1; i < msgs.length; i++) expect(msgs[i].ts - msgs[i - 1].ts).toBeGreaterThanOrEqual(10 - 1e-9);
  });

  it('LFO shapes and tempo sync', () => {
    const synced = createLfoSource({ shape: 'saw', beats: 4 });
    expect(synced.cyclesAt(2, 120)).toBeCloseTo(1); // 4 beats at 120 BPM = 2 s
    expect(createLfoSource({ shape: 'square' }).valueAt(0)).toBe(1);
    expect(createLfoSource({ shape: 'triangle', rateHz: 1 }).valueAt(0.25)).toBeCloseTo(0);
    const r = createLfoSource({ shape: 'random', rateHz: 4 });
    expect(r.valueAt(0.01)).toBe(r.valueAt(0.2)); // held within a cycle
    expect(Math.abs(r.valueAt(0.3))).toBeLessThanOrEqual(1);
  });
});

describe('state, channels and robustness', () => {
  it('getState / applyState recall presets first, then every value', () => {
    const a = rig();
    a.pm.programChange('purrting', 7);
    a.pm.set('purrting', 'mix', 0.25);
    a.pm.bypass('purrting', false);
    a.run(30);
    const snap = a.pm.getState();
    expect(snap.purrting).toMatchObject({ program: 7, channel: 1, values: { mix: 0.25, onOff: true } });
    const b = rig();
    b.pm.applyState(JSON.parse(JSON.stringify(snap)));
    b.run(40);
    expect(b.sent[0].bytes).toEqual([0xc0, 7]);
    expect(b.sent.slice(1).map(s => s.bytes)).toEqual(expect.arrayContaining([[0xb0, 23, 32], [0xb0, 85, 0]]));
    expect(b.sent).toHaveLength(3);
  });

  it('addPedal with another channel and id, refresh and invalidate', () => {
    const { pm, sent, run } = rig({ pedals: [] });
    expect(pm.addPedal({ profile: 'purrting', channel: 5, id: 'purr2' })).toBe('purr2');
    pm.set('purr2', 'mix', 1); run(20);
    pm.set('purr2', 'mix', 1); run(20); // unchanged
    pm.invalidate('purr2');
    pm.set('purr2', 'mix', 1); run(20); // forgotten: sent again
    pm.refresh('purr2'); run(20);
    expect(sent.map(s => s.bytes)).toEqual(Array(3).fill([0xb4, 23, 127]));
    expect(pm.setChannel('purr2', 6)).toBe(true);
    pm.set('purr2', 'mix', 1); run(20);
    expect(sent[sent.length - 1].bytes[0]).toBe(0xb5);
  });

  it('never throws on unknown ids or a failing port, and counts the errors', () => {
    let fail = true;
    const pm = createPedalMidi({ send: () => { if (fail) throw new Error('port gone'); }, autoPump: false, now: () => 0 });
    const events = [];
    pm.on(e => events.push(e.type));
    expect(pm.set('nope', 'mix', 1)).toBe(false);
    expect(pm.set('purrting', 'nope', 1)).toBe(false);
    pm.set('purrting', 'mix', 1);
    expect(() => pm.pump(0)).not.toThrow();
    expect(pm.stats().errors).toBe(1);
    expect(pm.lastError).toBe('port gone');
    expect(events).toEqual(['error']);
    fail = false;
    pm.set('purrting', 'mix', 1); // the failed send never reached the pedal, so it is retried
    pm.pump(20);
    expect(pm.stats().sent).toBe(1);
  });

  it('requires a send function', () => {
    expect(() => createPedalMidi({})).toThrow(/send/);
  });
});
