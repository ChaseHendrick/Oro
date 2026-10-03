// Test doubles shared by the music, MIDI and preset tests: a manual clock that
// drives setTimeout/setInterval and a fake AudioContext time together, and an
// engine that records every scheduled note.

export function createFakeClock({ startSec = 0 } = {}) {
  let now = startSec;
  let seq = 0;
  const timeouts = new Map();
  const intervals = new Map();
  const ctx = {
    currentTime: startSec,
    state: 'running',
    // The sample at contextTime is heard at performanceTime: zero output latency here.
    getOutputTimestamp() { return { contextTime: ctx.currentTime, performanceTime: now * 1000 }; },
  };
  const timers = {
    setTimeout(fn, ms) { const id = ++seq; timeouts.set(id, { fn, at: now + Math.max(0, ms) / 1000 }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn, ms) { const id = ++seq; intervals.set(id, { fn, every: ms / 1000, at: now + ms / 1000 }); return id; },
    clearInterval(id) { intervals.delete(id); },
  };
  function runDue() {
    for (let guard = 0; guard < 10000; guard++) {
      let next = null;
      for (const [id, t] of timeouts) if (t.at <= now + 1e-9 && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) break;
      timeouts.delete(next[0]);
      next[1].fn();
    }
    for (const [, iv] of intervals) {
      while (iv.at <= now + 1e-9) { iv.at += iv.every; iv.fn(); }
    }
  }
  return {
    ctx,
    timers,
    perfNow: () => now * 1000,
    now: () => now,
    /** Advance wall clock and audio clock together in small steps. */
    advance(sec, stepSec = 0.005) {
      const end = now + sec;
      while (now < end - 1e-12) {
        now = Math.min(end, now + stepSec);
        if (ctx.state === 'running') ctx.currentTime = now;
        runDue();
      }
    },
    /** Advance wall time only (audio suspended). */
    advanceWall(sec) { now += sec; runDue(); },
    pendingIntervals: () => intervals.size,
  };
}

export function createFakeEngine(clock) {
  const events = [];
  return {
    context: clock ? clock.ctx : { currentTime: 0, state: 'running' },
    events,
    noteOn(part, note, vel = 0.8, time = 0) { events.push({ type: 'on', part, note, vel, time }); },
    noteOff(part, note, time = 0) { events.push({ type: 'off', part, note, time }); },
    // v2.9 parameter locks (timed engine-only params)
    scheduleParams(part, p, time = 0) { events.push({ type: 'params', part, p: { ...p }, time }); },
    allNotesOff(part) { events.push({ type: 'allOff', part }); },
    panic() { events.push({ type: 'panic' }); },
    bend(part, v) { events.push({ type: 'bend', part, v }); },
    wheel(part, v) { events.push({ type: 'wheel', part, v }); },
    pressure(part, v, note) { events.push(note === undefined ? { type: 'pressure', part, v } : { type: 'pressure', part, v, note }); },
    slide(part, v, note) { events.push(note === undefined ? { type: 'slide', part, v } : { type: 'slide', part, v, note }); },
    of(type) { return events.filter(e => e.type === type); },
    ons(part) { return events.filter(e => e.type === 'on' && (part == null || e.part === part)); },
    offs(part) { return events.filter(e => e.type === 'off' && (part == null || e.part === part)); },
    clear() { events.length = 0; },
  };
}

export function createMemoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
  };
}
