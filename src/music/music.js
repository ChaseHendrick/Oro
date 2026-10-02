// Music module entry: note router + arpeggiator, transport + step sequencer,
// pattern tools and dot locks, all sharing one AudioContext-based timebase.

import { createTimebase, defaultTimers } from './timing.js';
import { createRouter } from './router.js';
import { createTransport } from './transport.js';
import { randomizePattern, clearPattern, shiftPattern } from './patterns.js';
import { setStepLock, clearStepLock, clearLocks, lockCurrentDot } from './locks.js';

export { swingBeat, swingOffsetBeats, PPQ, LOOKAHEAD } from './transport.js';
export { ARP } from './router.js';
export { LOCK_SOURCE, wrap01, wrapDelta, easeInOut } from './locks.js';

/**
 * createMusic({ store, engine }) -> { router, transport, randomizePattern, clearPattern, shiftPattern,
 *   setStepLock, clearStepLock, clearLocks, lockCurrentDot, setLockRecord, isLockRecording, currentStep }
 * `part` may be an index or 'sel' (the selected part) everywhere.
 * `timers`, `perfNow` and `random` are injectable for tests.
 */
export function createMusic({ store, engine = null, timers = defaultTimers, perfNow, random } = {}) {
  if (!store) throw new Error('createMusic needs a store');
  const timebase = createTimebase(engine, perfNow ? { perfNow } : {});
  const router = createRouter({ store, engine, timebase, timers, random });
  const transport = createTransport({ store, engine, timebase, router, timers });
  router.setKick(() => transport.kick());

  function currentStep(part) {
    const p = part === 'sel' || part == null ? store.get('ui.selectedPart') || 0 : Number(part);
    return transport.currentStep(p);
  }

  return {
    router,
    transport,
    timebase,
    randomizePattern: (part, opts = {}) => randomizePattern(store, part, opts),
    clearPattern: (part) => clearPattern(store, part),
    shiftPattern: (part, dir) => shiftPattern(store, part, dir),
    // Dot locks. Positions are map coordinates 0..1 (wrapped).
    setStepLock: (part, step, x, y) => setStepLock(store, part, step, x, y),
    clearStepLock: (part, step) => clearStepLock(store, part, step),
    clearLocks: (part) => clearLocks(store, part),
    /** Lock `step` (default: the step sounding now) to where the part's dot is. */
    lockCurrentDot: (part, step) => lockCurrentDot(store, part, step == null ? currentStep(part) : step),
    setLockRecord: (on) => transport.locks.setRecord(on),
    isLockRecording: () => transport.locks.isRecording(),
    currentStep,
    dispose() {
      transport.stop();
      router.allNotesOff();
      transport.dispose();
      router.dispose();
    },
  };
}
