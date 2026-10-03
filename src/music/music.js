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
import { capturePhrase } from './capture.js';
import { SEQ_STEPS, SEQ_RATES, NOTE_NAMES, SCALE_NAMES, defaultStep, patternPath, clamp } from '../core/params.js';
import { isTrack } from '../core/tracks.js';
import { KIT_BASE_NOTE, KIT_PADS } from '../dsp/drum-kit.js';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const noteName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

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

  /**
   * v2.9 Capture: the phrase just played on track `part` (people's keys and
   * MIDI, see capture.js) becomes its active pattern (drum kit tracks: its
   * lanes), as one undo step. Dot and parameter locks stay on their steps.
   * Returns { ok, message }.
   */
  function capture(part = 'sel') {
    const p = part === 'sel' || part == null ? Math.round(store.get('ui.selectedPart') || 0) : Number(part);
    if (!isTrack(store, p)) return { ok: false, message: 'Nothing captured: there is no track to capture into.' };
    const path = patternPath(store, p);
    const pat = store.get(path) || {};
    const rateIdx = clamp(Math.round(pat.rate ?? 3), 0, SEQ_RATES.length - 1);
    const N = clamp(Math.round(pat.length || SEQ_STEPS), 1, SEQ_STEPS);
    const drum = !!store.get(`parts.${p}.drum.on`);
    const root = Number(store.get('global.scaleRoot')) || 0, scaleType = Number(store.get('global.scaleType')) || 0;
    const grid = transport.isPlaying() && transport.timeAtBeat(0) != null;
    const res = capturePhrase(router.captured(p), {
      spb: transport.spb(), rateBeats: SEQ_RATES[rateIdx].beats, length: N, root, scaleType,
      baseOctave: Math.round(pat.baseOctave ?? 3), drum, now: timebase.perfNow() / 1000,
      beatAt: grid ? (t) => transport.beatAt(timebase.perfToAudio(t * 1000)) : null,
    });
    if (res.error === 'empty') return { ok: false, message: 'Nothing captured: play some notes on this track first (keys or MIDI).' };
    if (res.error === 'noPads') {
      return { ok: false, message: `Nothing captured: none of the notes were on the kit's pads (${noteName(KIT_BASE_NOTE)} to ${noteName(KIT_BASE_NOTE + KIT_PADS - 1)}).` };
    }
    const turnOn = !store.get(`parts.${p}.seqOn`);
    const meta = { source: 'capture' };
    store.batch(() => {
      if (res.kind === 'drum') {
        const old = Array.isArray(pat.drumLanes) ? pat.drumLanes : [];
        store.set(`${path}.drumLanes`, res.lanes.map((lane, r) => lane.map((v, i) => (i < N ? v : Number(old[r] && old[r][i]) || 0))), meta);
      } else {
        const old = Array.isArray(pat.steps) ? pat.steps : [];
        const steps = Array.from({ length: SEQ_STEPS }, (_, i) => {
          const o = old[i] || defaultStep();
          if (i >= N) return { ...o };
          const { lock, lx, ly, plocks } = o;
          return { ...defaultStep(), lock: lock ? 1 : 0, lx: lx ?? 0.5, ly: ly ?? 0.5, ...(res.steps[i] || {}), ...(plocks ? { plocks: { ...plocks } } : {}) };
        });
        store.set(`${path}.steps`, steps, meta);
      }
      if (turnOn) store.set(`parts.${p}.seqOn`, 1, meta);
    });
    let msg = `Captured ${plural(res.count, res.kind === 'drum' ? 'hit' : 'note')} into ${pat.name || 'the pattern'} (${N} steps of ${SEQ_RATES[rateIdx].name}).`;
    if (res.snapped) msg += ` ${plural(res.snapped, 'note')} outside ${NOTE_NAMES[root]} ${SCALE_NAMES[scaleType] || ''} moved to the nearest scale note.`;
    if (res.overlap) msg += ` ${plural(res.overlap, 'note')} sharing a step with a louder one left out.`;
    if (res.outside) msg += ` ${plural(res.outside, 'note')} not on a pad left out.`;
    if (res.older) msg += ` Kept the last ${N} steps.`;
    if (turnOn) msg += ' Sequencer switched on.';
    return { ok: true, message: msg.replace(/ {2,}/g, ' ') };
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
    /** v2.9 song mode: the chain entry of `part` being heard, or -1. */
    chainEntry: (part = 'sel') => transport.chainEntry(part === 'sel' || part == null ? store.get('ui.selectedPart') || 0 : Number(part)),
    capture,
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
      explorer.dispose();
      transport.stop();
      router.allNotesOff();
      for (const u of unsubs) u();
      transport.dispose();
      router.dispose();
    },
  };
}
