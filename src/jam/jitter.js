// Jam together (2.12): when to play a note someone else played.
//
// A remote note carries `at`, the moment (on the jam clock, ms) it was meant
// to be heard where it was played. It reaches us some time later, and that
// "transit" time wobbles. Playing each note the moment it arrives would
// smear the rhythm by the wobble, so every note from a person is held back
// by the same delay:
//
//   play at  at + delay,   delay = max(MIN, transit + 2 x jitter)
//
// where `transit` is a running estimate of how long their notes take to
// arrive and `jitter` is the larger of their transit wobble and the clock
// sync's round-trip jitter. Notes keep their spacing exactly as long as the
// delay holds still. The delay grows at once when notes start arriving late
// and shrinks back slowly, a little per note, so a short burst of lag does
// not keep squeezing the timing.

export const MIN_DELAY_MS = 40;
export const MAX_DELAY_MS = 1000;
export const STALE_MS = 1500;      // a note-on this late is dropped instead of played
const RISE = 0.25;                 // transit estimate: how fast it follows a slower note
const FALL = 0.02;                 //   ... and a faster one
const DEV = 0.1;                   // jitter estimate smoothing
const SHRINK = 0.02;               // the delay's step back toward its target per note

export function createJitterBuffer({ minMs = MIN_DELAY_MS, maxMs = MAX_DELAY_MS } = {}) {
  let transit = null;   // ms
  let dev = 0;          // mean deviation of transit (ms)
  let delay = minMs;

  function target(rttJitter) {
    const j = Math.max(dev, Number.isFinite(rttJitter) ? rttJitter : 0);
    return Math.min(maxMs, Math.max(minMs, (transit ?? 0) + 2 * j));
  }

  return {
    /**
     * A note stamped `at` arrived at `arrival` (both jam clock ms). Updates
     * the estimates; returns the delay now in force.
     */
    observe(at, arrival, rttJitter = 0) {
      const t = arrival - at;
      if (!Number.isFinite(t)) return delay;
      if (transit == null) transit = t;
      else {
        dev += DEV * (Math.abs(t - transit) - dev);
        transit += (t > transit ? RISE : FALL) * (t - transit);
      }
      const want = target(rttJitter);
      // Late note: grow at once (with room for this note). Otherwise ease back.
      if (want > delay || t > delay) delay = Math.min(maxMs, Math.max(want, t + dev));
      else delay += SHRINK * (want - delay);
      delay = Math.min(maxMs, Math.max(minMs, delay));
      return delay;
    },
    /** Jam-clock time to play a note stamped `at`. */
    playout(at) { return at + delay; },
    get delay() { return delay; },
    get transit() { return transit; },
    get jitter() { return dev; },
    reset() { transit = null; dev = 0; delay = minMs; },
  };
}

/**
 * Schedule one remote note event. `now` is the jam clock now (ms). Returns
 * { at: jam-clock ms to play, late } or null to drop it. Note-offs are never
 * dropped (a stuck note is worse than a late one) and never land before the
 * note-on they end: pass the on's play time as `onAt`.
 */
export function scheduleNote({ at, on, now, buffer, onAt = null, minGapMs = 5 }) {
  let t = buffer.playout(at);
  const late = t < now;
  if (late) {
    if (on && now - t > STALE_MS) return null;
    t = now;
  }
  if (!on && onAt != null) t = Math.max(t, onAt + minGapMs);
  return { at: t, late };
}

export const SNAP_CHOICES = Object.freeze([
  { id: 'off', label: 'Off', beats: 0 },
  { id: '16', label: '1/16', beats: 0.25 },
  { id: '8', label: '1/8', beats: 0.5 },
]);

/** Beats of a snap setting ('off' -> 0). */
export function snapBeats(id) {
  const c = SNAP_CHOICES.find(s => s.id === id);
  return c ? c.beats : 0;
}
