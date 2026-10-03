// v2.9 coin slot: with Free Play off, Oro plays only while a credit runs.
// Each coin is one credit; a credit starts with the first note after it is
// needed and lasts CREDIT_MS of wall-clock play time. Pure logic with an
// injected clock, so tests can run it on a fake one.

export const CREDIT_MS = 3 * 60 * 1000;
export const MAX_CREDITS = 99;

export function createCoinGate({ now = () => Date.now(), creditMs = CREDIT_MS } = {}) {
  let credits = 0;        // coins not yet started
  let until = 0;          // end of the running credit (ms), 0 = none
  let coins = 0;          // coins inserted since this gate was made

  const running = (t = now()) => until > 0 && t < until;

  return {
    /** Adds one credit. Returns the number of coins inserted so far. */
    insert() {
      if (credits < MAX_CREDITS) credits++;
      return ++coins;
    },
    /** Whether a note may sound now; starts the next credit when the running one is over. */
    allow(t = now()) {
      if (running(t)) return true;
      until = 0;
      if (credits <= 0) return false;
      credits--;
      until = t + creditMs;
      return true;
    },
    /** Credits left, counting the one that is running. */
    credits(t = now()) { return credits + (running(t) ? 1 : 0); },
    /** Milliseconds left on the running credit (0 when none runs). */
    left(t = now()) { return running(t) ? until - t : 0; },
    running,
    coins: () => coins,
    reset() { credits = 0; until = 0; },
  };
}

/** "2:41" for a number of milliseconds. */
export function formatLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
