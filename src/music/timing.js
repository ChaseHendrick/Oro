// Shared timebase. Everything musical is scheduled in AudioContext seconds so
// notes land sample-accurately; this module converts between that clock and
// performance.now() milliseconds (used by MIDI timestamps, MIDI input events
// and setTimeout-driven UI callbacks).
//
// The engine may not exist (tests, failed audio) or may not have started yet
// (context suspended until a user gesture). In both cases callers get a usable
// clock and running() tells them whether audio time is actually advancing.

const perfNowDefault = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function createTimebase(engine, { perfNow = perfNowDefault } = {}) {
  const ctx = () => (engine && engine.context) || null;

  function now() {
    const c = ctx();
    return c ? c.currentTime : perfNow() / 1000;
  }

  function running() {
    const c = ctx();
    return !c || c.state === undefined || c.state === 'running';
  }

  // A matched (audio seconds, performance ms) pair for "what is being heard
  // right now". getOutputTimestamp() already accounts for output latency; the
  // fallback approximates it from the context's latency hints.
  function anchor() {
    const c = ctx();
    if (!c) { const p = perfNow(); return { contextTime: p / 1000, performanceTime: p }; }
    if (typeof c.getOutputTimestamp === 'function') {
      try {
        const ts = c.getOutputTimestamp();
        if (ts && ts.performanceTime > 0 && ts.contextTime > 0 && c.state === 'running') {
          return { contextTime: ts.contextTime, performanceTime: ts.performanceTime };
        }
      } catch { /* some browsers throw while suspended */ }
    }
    const latency = (c.outputLatency || 0) + (c.baseLatency || 0);
    return { contextTime: c.currentTime - latency, performanceTime: perfNow() };
  }

  /** performance.now() time (ms) at which audio time `t` reaches the speakers. */
  function audioToPerf(t) {
    const a = anchor();
    return a.performanceTime + (t - a.contextTime) * 1000;
  }

  /** Audio time whose sample is heard at performance time `ms`. */
  function perfToAudio(ms) {
    const a = anchor();
    return a.contextTime + (ms - a.performanceTime) / 1000;
  }

  /** Milliseconds from now until audio time `t` is heard (never negative). */
  function heardDelayMs(t) {
    return Math.max(0, audioToPerf(t) - perfNow());
  }

  return { now, running, audioToPerf, perfToAudio, heardDelayMs, perfNow };
}

export const defaultTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};
