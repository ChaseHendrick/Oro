// Music module entry: note router + arpeggiator, transport + step sequencer,
// and pattern tools, all sharing one AudioContext-based timebase.

import { createTimebase, defaultTimers } from './timing.js';
import { createRouter } from './router.js';
import { createTransport } from './transport.js';
import { randomizePattern, clearPattern, shiftPattern } from './patterns.js';

export { swingBeat, swingOffsetBeats, PPQ, LOOKAHEAD } from './transport.js';
export { ARP } from './router.js';

/**
 * createMusic({ store, engine }) -> { router, transport, randomizePattern, clearPattern, shiftPattern }
 * `timers`, `perfNow` and `random` are injectable for tests.
 */
export function createMusic({ store, engine = null, timers = defaultTimers, perfNow, random } = {}) {
  if (!store) throw new Error('createMusic needs a store');
  const timebase = createTimebase(engine, perfNow ? { perfNow } : {});
  const router = createRouter({ store, engine, timebase, timers, random });
  const transport = createTransport({ store, engine, timebase, router, timers });
  router.setKick(() => transport.kick());

  return {
    router,
    transport,
    timebase,
    randomizePattern: (part, opts = {}) => randomizePattern(store, part, opts),
    clearPattern: (part) => clearPattern(store, part),
    shiftPattern: (part, dir) => shiftPattern(store, part, dir),
    dispose() {
      transport.stop();
      router.allNotesOff();
      transport.dispose();
      router.dispose();
    },
  };
}
