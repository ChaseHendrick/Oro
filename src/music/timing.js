// Shared timebase. Everything musical is scheduled in AudioContext seconds so
// notes land sample-accurately; this module converts between that clock and
// performance.now() milliseconds (used by MIDI timestamps, MIDI input events
// and setTimeout-driven UI callbacks).
//
// The engine may not exist (tests, failed audio) or may not have started yet
// (context suspended until a user gesture). In both cases callers get a usable
// clock and running() tells them whether audio time is actually advancing.

const perfNowDefault = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
// Largest disagreement (seconds) between getOutputTimestamp() and the coarse
// currentTime-based mapping before the timestamp is treated as stale.
const MAX_SKEW = 0.25;

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
    const latency = (c.outputLatency || 0) + (c.baseLatency || 0);
    const p = perfNow();
    if (typeof c.getOutputTimestamp === 'function') {
      try {
        const ts = c.getOutputTimestamp();
        if (ts && ts.performanceTime > 0 && ts.contextTime > 0 && c.state === 'running') {
          // A stale timestamp (just after resume or an output device switch)
          // can be off by seconds, which would throw every scheduled event far
          // into the past or future. Trust it only when it roughly agrees with
          // the coarse mapping below; in normal running they agree to a few ms.
          const fine = ts.contextTime - ts.performanceTime / 1000;
          const coarse = c.currentTime - latency - p / 1000;
          if (Math.abs(fine - coarse) < MAX_SKEW) return { contextTime: ts.contextTime, performanceTime: ts.performanceTime };
        }
      } catch { /* some browsers throw while suspended */ }
    }
    return { contextTime: c.currentTime - latency, performanceTime: p };
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
