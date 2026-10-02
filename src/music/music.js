// Music module entry: note router + arpeggiator, transport + step sequencer,
// pattern tools and dot locks, all sharing one AudioContext-based timebase.
// Round D adds the patch preview, Explore-mode notes and offline event
// rendering for bounces.

import { createTimebase, defaultTimers } from './timing.js';
import { createRouter } from './router.js';
import { createTransport } from './transport.js';
import { createEmitter } from './emitter.js';
import { randomizePattern, clearPattern, shiftPattern } from './patterns.js';
import { setStepLock, clearStepLock, clearLocks, lockCurrentDot } from './locks.js';
import { createPreview } from './preview.js';
import { createExplorer } from './explore.js';
import { renderSessionEvents } from './render.js';

export { swingBeat, swingOffsetBeats, PPQ, LOOKAHEAD } from './transport.js';
export { ARP } from './router.js';
export { LOCK_SOURCE, wrap01, wrapDelta, easeInOut } from './locks.js';
export { PHRASES, adaptDegree, guessCategory } from './phrases.js';
export { exploreGapBeats, exploreNoteFor, EXPLORE_MODE } from './explore.js';

/**
 * createMusic({ store, engine, presets }) -> { router, transport, randomizePattern, clearPattern, shiftPattern,
 *   setStepLock, clearStepLock, clearLocks, lockCurrentDot, setLockRecord, isLockRecording, currentStep,
 *   preview, stopPreview, isPreviewing, exploreNote, renderEvents, on, off }
 * `part` may be an index or 'sel' (the selected part) everywhere.
 * `presets` (optional) lets the preview pick phrases by patch category.
 * `timers`, `perfNow` and `random` are injectable for tests.
 */
export function createMusic({ store, engine = null, presets = null, timers = defaultTimers, perfNow, random } = {}) {
  if (!store) throw new Error('createMusic needs a store');
  const emitter = createEmitter();
  const timebase = createTimebase(engine, perfNow ? { perfNow } : {});
  const router = createRouter({ store, engine, timebase, timers, random });
  const transport = createTransport({ store, engine, timebase, router, timers });
  router.setKick(() => transport.kick());
  let presetLib = presets;
  const previewer = createPreview({
    store, router, timebase, timers, transport,
    getPresets: () => presetLib,
    emit: (e) => emitter.emit('preview', e),
  });
  const explorer = createExplorer({ store, router, timebase, transport, emit: (e) => emitter.emit('explore', e) });

  const unsubs = [];
  // A panic or all-notes-off also ends the preview, and so does loading a whole new session.
  unsubs.push(router.on('allOff', () => previewer.stop('panic')));
  unsubs.push(store.subscribe('', (path) => { if (path === '') previewer.stop('load'); }));

  function currentStep(part) {
    const p = part === 'sel' || part == null ? store.get('ui.selectedPart') || 0 : Number(part);
    return transport.currentStep(p);
  }

  function renderEvents(bars = 4, { parts } = {}) {
    return renderSessionEvents(store, bars, { parts, held: (p) => router.heldEntries(p), random });
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
    /** Play a short phrase suited to the part's patch. Returns { part, category, phrase, start, duration } or null. */
    preview: (part = 'sel', opts) => previewer.preview(part, opts),
    stopPreview: () => previewer.stop('stop'),
    isPreviewing: () => previewer.isPlaying(),
    previewCategory: (part = 'sel') => previewer.categoryOf(part),
    /** Explore mode: a marble passed a peak or valley ({ part, kind, height, x, y }). */
    exploreNote: (e) => explorer.exploreNote(e),
    /** Sequencer + arp notes and dot-lock glides for an offline bounce: [{ time, msg }], beat 0 at time 0. */
    renderEvents,
    setPresets(p) { presetLib = p || null; },
    on: (type, fn) => emitter.on(type, fn),
    off: (type, fn) => emitter.off(type, fn),
    dispose() {
      previewer.dispose();
      transport.stop();
      router.allNotesOff();
      for (const u of unsubs) u();
      transport.dispose();
      router.dispose();
    },
  };
}
