import { describe, it, expect } from 'vitest';
import { createStore } from '../../src/core/store.js';
import { defaultState, defaultStep } from '../../src/core/params.js';
import { migrateState } from '../../src/core/migrate.js';
import { createMusic } from '../../src/music/music.js';
import { START_DELAY } from '../../src/music/transport.js';
import { easeInOut, wrapDelta, wrap01, keepLocks, USER_HOLD_MS, FRAME_MS } from '../../src/music/locks.js';
import { makeRng } from '../../src/music/patterns.js';
import { createFakeClock, createFakeEngine } from './fakes.js';

const CX = 'parts.0.params.centerX';
const CY = 'parts.0.params.centerY';

function setup({ tempo = 120, dot = [0.5, 0.5] } = {}) {
  const clock = createFakeClock({ startSec: 1 });
  const engine = createFakeEngine(clock);
  const s = defaultState();
  s.global.tempo = tempo;
  s.parts[0].params.centerX = dot[0];
  s.parts[0].params.centerY = dot[1];
  const store = createStore(s);
  const music = createMusic({ store, engine, timers: clock.timers, perfNow: clock.perfNow });
  // Every write to part 0's dot, with the (fake) wall time it happened at.
  const writes = [];
  store.subscribe('parts.0.params', (path, value, meta) => {
    if (path === CX || path === CY) writes.push({ at: clock.now(), axis: path === CX ? 'x' : 'y', value, source: meta && meta.source });
  });
  const lockWrites = (axis) => writes.filter(w => w.source === 'lock' && (!axis || w.axis === axis));
  return { clock, engine, store, music, writes, lockWrites, t0: clock.ctx.currentTime };
}

/** Pattern for part `p`: `n` steps, locks as {index: [x, y]}, notes on the listed steps. */
function pattern(store, p, { rate = 3, n = 4, locks = {}, notes = [], glide = 0.5, enabled = 1 } = {}) {
  const seq = store.get(`parts.${p}.seq`);
  seq.enabled = enabled;
  seq.rate = rate;
  seq.length = n;
  seq.lockGlide = glide;
  seq.steps = seq.steps.map((st, i) => {
    const l = locks[i];
    return { ...defaultStep(), on: notes.includes(i) ? 1 : 0, lock: l ? 1 : 0, lx: l ? l[0] : 0.5, ly: l ? l[1] : 0.5 };
  });
  store.set(`parts.${p}.seq`, seq);
}

describe('lock maths', () => {
  it('takes the shortest way round the torus', () => {
    expect(wrapDelta(0.95, 0.05)).toBeCloseTo(0.1, 12);
    expect(wrapDelta(0.05, 0.95)).toBeCloseTo(-0.1, 12);
    expect(wrapDelta(0.2, 0.6)).toBeCloseTo(0.4, 12);
    expect(wrapDelta(0.2, 0.8)).toBeCloseTo(-0.4, 12);
    expect(wrap01(1)).toBe(0);
    expect(wrap01(-0.25)).toBeCloseTo(0.75, 12);
  });

  it('eases in and out without overshoot', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 12);
    expect(easeInOut(0.1)).toBeLessThan(0.1);
    expect(easeInOut(0.9)).toBeGreaterThan(0.9);
    let prev = 0;
    for (let k = 0.01; k <= 1; k += 0.01) { const e = easeInOut(k); expect(e).toBeGreaterThanOrEqual(prev); prev = e; }
  });
});

describe('dot lock playback', () => {
  it('glides from the current spot to the lock over lockGlide of a step, starting when the step is heard', () => {
    const { clock, store, music, lockWrites, t0 } = setup({ tempo: 120 });
    pattern(store, 0, { locks: { 0: [0.8, 0.3] }, glide: 0.5 });
    music.transport.play();
    clock.advance(0.4);
    const start = t0 + START_DELAY;          // step 0 is heard here
    const dur = 0.5 * 0.125;                 // half a 16th at 120 bpm
    const xs = lockWrites('x');
    const ys = lockWrites('y');
    expect(xs.length).toBeGreaterThanOrEqual(3);
    expect(xs[0].at).toBeGreaterThanOrEqual(start - 1e-9);
    // Every intermediate value sits exactly on the eased curve for the moment it was written.
    for (const w of xs.slice(0, -1)) expect(w.value).toBeCloseTo(0.5 + 0.3 * easeInOut((w.at - start) / dur), 5);
    for (const w of ys.slice(0, -1)) expect(w.value).toBeCloseTo(0.5 - 0.2 * easeInOut((w.at - start) / dur), 5);
    // Lands exactly on the lock, about one frame after the glide time.
    expect(xs.at(-1).value).toBe(0.8);
    expect(ys.at(-1).value).toBe(0.3);
    expect(xs.at(-1).at).toBeGreaterThanOrEqual(start + dur - 1e-9);
    expect(xs.at(-1).at).toBeLessThan(start + dur + (FRAME_MS + 6) / 1000);
    // Roughly 60 updates a second.
    for (let i = 1; i < xs.length; i++) expect(xs[i].at - xs[i - 1].at).toBeLessThan((FRAME_MS + 6) / 1000);
    expect(store.get(CX)).toBe(0.8);
    expect(music.transport.locks.gliding(0)).toBe(false);
  });

  it('wraps across the edge of the map instead of crossing it', () => {
    const { clock, store, music, lockWrites } = setup({ tempo: 60, dot: [0.95, 0.1] });
    pattern(store, 0, { rate: 0, locks: { 0: [0.05, 0.9] }, glide: 0.8 });
    music.transport.play();
    clock.advance(1);
    const xs = lockWrites('x').map(w => w.value);
    const ys = lockWrites('y').map(w => w.value);
    expect(xs.length).toBeGreaterThan(10);
    for (const v of xs) {
      expect(v >= 0 && v < 1).toBe(true);
      expect(v >= 0.95 || v <= 0.05 + 1e-9).toBe(true);
    }
    for (const v of ys) expect(v >= 0.9 - 1e-9 || v <= 0.1 + 1e-9).toBe(true);
    // Unwrapped, x only ever moves forwards (+0.1) and y backwards (-0.2).
    const unwrap = (vals, from) => vals.map(v => from + wrapDelta(from, v));
    const ux = unwrap(xs, 0.95), uy = unwrap(ys, 0.1);
    for (let i = 1; i < ux.length; i++) { expect(ux[i]).toBeGreaterThanOrEqual(ux[i - 1]); expect(uy[i]).toBeLessThanOrEqual(uy[i - 1]); }
    expect(store.get(CX)).toBe(0.05);
    expect(store.get(CY)).toBe(0.9);
  });

  it('jumps at the step time when lockGlide is 0', () => {
    const { clock, store, music, lockWrites, t0 } = setup({ tempo: 120 });
    pattern(store, 0, { locks: { 2: [0.25, 0.75] }, glide: 0 });
    music.transport.play();
    clock.advance(0.5);
    const xs = lockWrites('x'), ys = lockWrites('y');
    expect(xs).toHaveLength(1);
    expect(ys).toHaveLength(1);
    expect(xs[0].value).toBe(0.25);
    expect(ys[0].value).toBe(0.75);
    const stepTime = t0 + START_DELAY + 2 * 0.125;
    expect(xs[0].at).toBeGreaterThanOrEqual(stepTime - 1e-9);
    expect(xs[0].at).toBeLessThan(stepTime + 0.006);
  });

  it('moves the dot on lock-only steps, reports locks on step events, and ignores a switched-off sequencer', () => {
    const { clock, store, music, engine, lockWrites } = setup({ tempo: 120 });
    pattern(store, 0, { locks: { 1: [0.3, 0.6] }, notes: [0], glide: 0 });
    pattern(store, 1, { locks: { 0: [0.1, 0.1] }, notes: [0], glide: 0, enabled: 0 });
    const events = [];
    music.transport.on('step', e => events.push(e));
    music.transport.play();
    clock.advance(0.4);
    const p0 = events.filter(e => e.part === 0);
    expect(p0[0].lock).toBeNull();
    expect(p0[1].lock).toEqual({ x: 0.3, y: 0.6 });
    expect(p0[2].lock).toBeNull();
    expect(events.filter(e => e.part === 1).every(e => e.lock === null)).toBe(true);
    // Step 1 has no note but still moved the dot; part 1's sequencer is off so its dot stays put.
    expect(engine.ons(0)).toHaveLength(1);
    expect(lockWrites('x').map(w => w.value)).toEqual([0.3]);
    expect(store.get('parts.1.params.centerX')).toBe(0.5);
  });

  it('lets a newer lock for the same part take over from the one in flight', () => {
    const { clock, store, music, lockWrites } = setup();
    const locks = music.transport.locks;
    const t = clock.ctx.currentTime;
    locks.schedule(0, 0, { x: 0.9, y: 0.5 }, t + 0.01, 1);
    locks.schedule(0, 1, { x: 0.1, y: 0.5 }, t + 0.3, 0.2);
    clock.advance(1.2);
    const xs = lockWrites('x');
    const before = xs.filter(w => w.at < t + 0.3 - 1e-9);
    const after = xs.filter(w => w.at >= t + 0.3 - 1e-9);
    expect(before.length).toBeGreaterThan(5);
    expect(before.at(-1).value).toBeLessThan(0.9); // the first glide never finished
    // From its takeover point the second glide heads straight for 0.1 and nothing else writes.
    for (let i = 1; i < after.length; i++) expect(after[i].value).toBeLessThanOrEqual(after[i - 1].value);
    expect(after.at(-1).value).toBe(0.1);
    expect(after.at(-1).at).toBeLessThan(t + 0.3 + 0.2 + 0.025);
    expect(store.get(CX)).toBe(0.1);
  });
});

describe('never fighting the user', () => {
  it('cancels the glide when the user moves the dot, then plays later locks again', () => {
    const { clock, store, music, lockWrites, t0 } = setup({ tempo: 60 });
    // Quarter notes at 60 bpm: 1 s steps, 0.8 s glides.
    pattern(store, 0, { rate: 0, n: 2, locks: { 0: [0.9, 0.9], 1: [0.1, 0.5] }, glide: 0.8 });
    music.transport.play();
    const start = t0 + START_DELAY;
    clock.advance(START_DELAY + 0.4);
    expect(music.transport.locks.gliding(0)).toBe(true);
    const yMid = store.get(CY);
    store.set(CX, 0.2, { source: 'visual' });
    expect(music.transport.locks.gliding(0)).toBe(false);
    const n = lockWrites().length;
    clock.advance(0.5);
    expect(lockWrites()).toHaveLength(n);
    expect(store.get(CX)).toBe(0.2);
    expect(store.get(CY)).toBe(yMid);
    // Step 1 comes 0.6 s after the move, well past the hold: it glides from where the user left the dot.
    clock.advance(0.3);
    const later = lockWrites('x').filter(w => w.at >= start + 1 - 1e-9);
    expect(later.length).toBeGreaterThan(5);
    expect(later.at(-1).value).toBeLessThan(0.2);
    clock.advance(start + 1.9 - clock.now());
    expect(store.get(CX)).toBe(0.1);
  });

  it('skips a lock that comes due while the user is still moving the dot', () => {
    const { clock, store, music, lockWrites, t0 } = setup({ tempo: 60 });
    pattern(store, 0, { rate: 0, n: 2, locks: { 1: [0.1, 0.1] }, glide: 0 });
    music.transport.play();
    const step1 = t0 + START_DELAY + 1;
    clock.advance(step1 - clock.now() - USER_HOLD_MS / 2000);
    store.set(CX, 0.7, { source: 'ui' });
    clock.advance(0.5);
    expect(lockWrites()).toHaveLength(0);
    expect(store.get(CX)).toBe(0.7);
    // Next time round the loop (2 s later) the lock plays again.
    clock.advance(2);
    expect(store.get(CX)).toBe(0.1);
  });

  it('stops gliding and forgets queued locks when the transport stops', () => {
    const { clock, store, music, lockWrites } = setup({ tempo: 60 });
    pattern(store, 0, { rate: 0, n: 1, locks: { 0: [0.9, 0.2] }, glide: 1 });
    music.transport.play();
    clock.advance(START_DELAY + 0.3);
    expect(music.transport.locks.gliding(0)).toBe(true);
    const x = store.get(CX);
    music.transport.stop();
    expect(music.transport.locks.gliding(0)).toBe(false);
    const n = lockWrites().length;
    clock.advance(3);
    expect(lockWrites()).toHaveLength(n);
    expect(store.get(CX)).toBe(x);
  });

  it('cancels a queued lock that has not been heard yet when the transport stops', () => {
    const { clock, store, music, lockWrites } = setup({ tempo: 120 });
    pattern(store, 0, { locks: { 0: [0.9, 0.2] }, glide: 0 });
    music.transport.play(); // step 0 is scheduled 60 ms ahead
    music.transport.stop();
    clock.advance(0.5);
    expect(lockWrites()).toHaveLength(0);
    expect(store.get(CX)).toBe(0.5);
  });

  it('lets the marble keep rolling under a glide, but a flagged user move still wins', () => {
    const { clock, store, music } = setup({ tempo: 60 });
    store.set('parts.0.dot.mode', 1); // Roll: the visuals write 'visual' from the physics
    pattern(store, 0, { rate: 0, n: 1, locks: { 0: [0.9, 0.9] }, glide: 1 });
    music.transport.play();
    clock.advance(START_DELAY + 0.2);
    store.set(CX, 0.55, { source: 'visual' });
    expect(music.transport.locks.gliding(0)).toBe(true);
    store.set(CX, 0.4, { source: 'visual', user: true });
    expect(music.transport.locks.gliding(0)).toBe(false);
  });

  it('drops the glide when the part is replaced by a patch or scene load', () => {
    const { clock, store, music } = setup({ tempo: 60 });
    pattern(store, 0, { rate: 0, n: 1, locks: { 0: [0.9, 0.9] }, glide: 1 });
    music.transport.play();
    clock.advance(START_DELAY + 0.2);
    expect(music.transport.locks.gliding(0)).toBe(true);
    const part = store.get('parts.0');
    store.set('parts.0', { ...part, params: { ...part.params, centerX: 0.33 } }, { source: 'preset' });
    expect(music.transport.locks.gliding(0)).toBe(false);
    clock.advance(0.5);
    expect(store.get(CX)).toBe(0.33);
  });
});

describe('lock recording', () => {
  it('writes user dot moves into the step that is sounding, latest wins', () => {
    const { clock, store, music, t0 } = setup({ tempo: 120 });
    pattern(store, 0, { n: 16, notes: [0, 4, 8, 12] });
    expect(music.isLockRecording()).toBe(false);
    expect(music.setLockRecord(true)).toBe(true);
    expect(store.get('ui.lockRecord')).toBe(1);
    music.transport.play();
    clock.advance(START_DELAY + 3 * 0.125 + 0.03);
    expect(music.currentStep(0)).toBe(3);
    store.batch(() => {
      store.set(CX, 0.25, { source: 'visual' });
      store.set(CY, 0.75, { source: 'visual' });
    });
    expect(store.get('parts.0.seq.steps.3')).toMatchObject({ lock: 1, lx: 0.25, ly: 0.75, on: 0 });
    store.set(CX, 0.3, { source: 'midi' });
    expect(store.get('parts.0.seq.steps.3')).toMatchObject({ lock: 1, lx: 0.3, ly: 0.75 });
    // The next step gets its own lock; notes stay as they were.
    clock.advance(0.125);
    expect(music.currentStep(0)).toBe(4);
    store.set(CY, 1.25 - 1, { source: 'ui' });
    const steps = store.get('parts.0.seq.steps');
    expect(steps[4]).toMatchObject({ lock: 1, lx: 0.3, ly: 0.25, on: 1 });
    expect(steps.filter(s => s.lock).length).toBe(2);
    // Locks and other parts' moves are not recorded; nothing is recorded once stopped or with recording off.
    store.set('parts.1.params.centerX', 0.9, { source: 'visual' });
    expect(store.get('parts.1.seq.steps').some(s => s.lock)).toBe(false);
    store.set('ui.lockRecord', 0, { source: 'ui' });
    expect(music.isLockRecording()).toBe(false);
    clock.advance(0.125);
    store.set(CX, 0.6, { source: 'visual' });
    expect(store.get('parts.0.seq.steps.5.lock')).toBe(0);
    music.setLockRecord(true);
    music.transport.stop();
    store.set(CX, 0.65, { source: 'visual' });
    expect(store.get('parts.0.seq.steps').filter(s => s.lock).length).toBe(2);
    // What was recorded is clean state.
    const state = store.serialize();
    expect(migrateState(state).parts[0].seq).toEqual(state.parts[0].seq);
  });

  it('records into the selected part only, and plays the recording back on the next loop', () => {
    const { clock, store, music } = setup({ tempo: 120 });
    pattern(store, 0, { n: 4, notes: [0], glide: 0 });
    pattern(store, 2, { n: 4, notes: [0], glide: 0 });
    store.set('ui.selectedPart', 2);
    music.setLockRecord(true);
    music.transport.play();
    clock.advance(START_DELAY + 0.125 + 0.02);
    store.set(CX, 0.4, { source: 'visual' });
    expect(store.get('parts.0.seq.steps').some(s => s.lock)).toBe(false);
    store.set('parts.2.params.centerX', 0.15, { source: 'visual' });
    expect(store.get('parts.2.seq.steps.1')).toMatchObject({ lock: 1, lx: 0.15 });
    // The user drags elsewhere afterwards; next time round step 1 brings the dot back.
    clock.advance(0.2);
    store.set('parts.2.params.centerX', 0.85, { source: 'visual' });
    expect(store.get('parts.2.seq.steps.2')).toMatchObject({ lock: 1, lx: 0.85 });
    clock.advance(0.38);
    expect(store.get('parts.2.params.centerX')).toBe(0.15);
  });

  it('switches an empty, switched-off pattern on so the recording plays', () => {
    const { clock, store, music } = setup({ tempo: 120 });
    pattern(store, 0, { n: 4, enabled: 0 });
    music.setLockRecord(true);
    music.transport.play();
    clock.advance(START_DELAY + 0.02);
    store.set(CX, 0.2, { source: 'visual' });
    expect(store.get('parts.0.seq.enabled')).toBe(1);
    expect(store.get('parts.0.seq.steps.0')).toMatchObject({ lock: 1, lx: 0.2 });
    // A switched-off pattern with notes keeps its switch, but still gets the lock.
    pattern(store, 0, { n: 4, enabled: 0, notes: [1] });
    clock.advance(0.125);
    store.set(CX, 0.35, { source: 'visual' });
    expect(store.get('parts.0.seq.enabled')).toBe(0);
    expect(store.get(`parts.0.seq.steps.${music.currentStep(0)}`)).toMatchObject({ lock: 1, lx: 0.35 });
  });
});

describe('lock editing', () => {
  it('sets, captures, clears and survives migration', () => {
    const { store, music } = setup();
    expect(music.setStepLock(0, 2, 1.25, -0.25)).toMatchObject({ lock: 1, lx: 0.25, ly: 0.75 });
    expect(music.setStepLock(0, 16, 0.5, 0.5)).toBeNull();
    expect(music.setStepLock(9, 0, 0.5, 0.5)).toBeNull();
    store.set(CX, 0.125);
    store.set(CY, 0.875);
    expect(music.lockCurrentDot(0, 5)).toMatchObject({ lock: 1, lx: 0.125, ly: 0.875 });
    expect(music.lockCurrentDot(0)).toBeNull(); // stopped: no sounding step
    store.set('ui.selectedPart', 0);
    expect(music.setStepLock('sel', 7, 0.6, 0.4)).toMatchObject({ lock: 1 });
    let state = store.serialize();
    expect(migrateState(state).parts[0].seq).toEqual(state.parts[0].seq);
    expect(music.clearStepLock(0, 2)).toMatchObject({ lock: 0, lx: 0.5, ly: 0.5 });
    expect(store.get('parts.0.seq.steps').filter(s => s.lock).length).toBe(2);
    music.clearLocks(0);
    expect(store.get('parts.0.seq.steps').some(s => s.lock)).toBe(false);
    state = store.serialize();
    expect(migrateState(state).parts[0].seq).toEqual(state.parts[0].seq);
  });

  it('rotates locks with their steps, clears them with the pattern, and keeps them through randomise', () => {
    const { store, music } = setup();
    const seq = store.get('parts.0.seq');
    seq.length = 8;
    store.set('parts.0.seq', seq);
    music.setStepLock(0, 0, 0.1, 0.2);
    music.setStepLock(0, 7, 0.3, 0.4);
    music.setStepLock(0, 12, 0.9, 0.9); // outside the pattern length
    music.shiftPattern(0, 1);
    let st = store.get('parts.0.seq.steps');
    expect(st[1]).toMatchObject({ lock: 1, lx: 0.1, ly: 0.2 });
    expect(st[0]).toMatchObject({ lock: 1, lx: 0.3, ly: 0.4 });
    expect(st[12]).toMatchObject({ lock: 1, lx: 0.9 });
    music.shiftPattern(0, -1);
    st = store.get('parts.0.seq.steps');
    expect(st[0]).toMatchObject({ lock: 1, lx: 0.1 });
    expect(st[7]).toMatchObject({ lock: 1, lx: 0.3 });
    const locked = st.map(s => [s.lock, s.lx, s.ly]);
    music.randomizePattern(0, { density: 0.9, rng: makeRng(5) });
    st = store.get('parts.0.seq.steps');
    expect(st.some(s => s.on)).toBe(true);
    expect(st.map(s => [s.lock, s.lx, s.ly])).toEqual(locked);
    music.clearPattern(0);
    st = store.get('parts.0.seq.steps');
    expect(st.every(s => !s.lock && !s.on)).toBe(true);
    expect(keepLocks([{ on: 1 }], null)).toEqual([{ on: 1 }]);
  });
});
