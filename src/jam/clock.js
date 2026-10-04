// Jam together (2.12): clock sync, NTP style.
//
// Every jam runs on the host's clock (its performance.now(), in ms). A guest
// sends ping {t0} (its own clock), the host answers pong {t0, t1, t2} with
// the times it received the ping and sent the pong, and the guest notes t3
// when the pong arrives. For one exchange
//
//   offset = ((t1 - t0) + (t2 - t3)) / 2     host clock minus guest clock
//   rtt    = (t3 - t0) - (t2 - t1)           time on the wire, both ways
//
// The offset is exact when the two directions take equally long; a delay on
// one side only skews it by half that delay. Exchanges with the smallest
// round trip had the least waiting on either side, so the estimate averages
// the offsets of the best (lowest-rtt) samples of a recent window and
// ignores the rest.

export const CLOCK_WINDOW = 24;      // samples kept
export const CLOCK_BEST = 0.25;      // share of the window (lowest rtt) the offset uses

export function createClockSync({ window = CLOCK_WINDOW, best = CLOCK_BEST } = {}) {
  let samples = [];   // { offset, rtt, at } newest last
  let est = null;     // { offset, rtt, jitter }

  function compute() {
    if (!samples.length) { est = null; return; }
    const byRtt = samples.slice().sort((a, b) => a.rtt - b.rtt);
    const k = Math.max(1, Math.min(byRtt.length, Math.max(3, Math.round(byRtt.length * best))));
    const top = byRtt.slice(0, k);
    // Weight the very best a little more.
    let wsum = 0, osum = 0;
    top.forEach((s, i) => { const w = 1 / (1 + i); wsum += w; osum += w * s.offset; });
    const rtts = samples.map(s => s.rtt).sort((a, b) => a - b);
    const median = rtts[Math.floor(rtts.length / 2)];
    // Round-trip jitter: the mean distance of each round trip from the median.
    const jitter = rtts.reduce((a, r) => a + Math.abs(r - median), 0) / rtts.length;
    est = { offset: osum / wsum, rtt: median, minRtt: rtts[0], jitter };
  }

  return {
    /** Add one exchange (all in ms). Returns false for an impossible sample. */
    add(t0, t1, t2, t3) {
      if (![t0, t1, t2, t3].every(Number.isFinite)) return false;
      const rtt = (t3 - t0) - (t2 - t1);
      if (!(rtt >= 0) || t3 < t0 || t2 < t1 || rtt > 60000) return false;
      samples.push({ offset: ((t1 - t0) + (t2 - t3)) / 2, rtt, at: t3 });
      if (samples.length > window) samples.shift();
      compute();
      return true;
    },
    get ready() { return samples.length >= 3; },
    get count() { return samples.length; },
    /** Host clock minus local clock (ms), 0 until there is a sample. */
    get offset() { return est ? est.offset : 0; },
    /** Median round trip (ms) of the window, or null. */
    get rtt() { return est ? est.rtt : null; },
    get minRtt() { return est ? est.minRtt : null; },
    /** Mean deviation of the round trips from their median (ms). */
    get jitter() { return est ? est.jitter : 0; },
    toHost: (localMs) => localMs + (est ? est.offset : 0),
    toLocal: (hostMs) => hostMs - (est ? est.offset : 0),
    reset() { samples = []; est = null; },
  };
}

/** The host's own "sync": its clock is the jam clock. */
export function hostClock() {
  return {
    add: () => false, ready: true, count: 0, offset: 0, rtt: 0, minRtt: 0, jitter: 0,
    toHost: (ms) => ms, toLocal: (ms) => ms, reset() {},
  };
}

/** How often to ping (ms): quickly at first, then every couple of seconds. */
export function pingInterval(count) {
  return count < 8 ? 250 : 2000;
}
