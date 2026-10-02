// Patch preview (music.preview, key P): plays a short phrase that suits the
// part's patch category, in the global key and tempo. While the transport
// runs, the phrase starts on the next beat and swings with the sequencer.
//
// Notes are fed to the engine with the same lookahead scheme as the
// transport (a 25 ms timer schedules whatever falls in the next 120 ms), and
// each note-off is only sent when it comes due. Stopping therefore never
// leaves anything hanging: every note that was started gets exactly one
// note-off, and notes not yet sent are simply dropped.

import { activeSeq, clamp } from '../core/params.js';
import { isTrack } from '../core/tracks.js';
import { PHRASES, phraseEvents, phraseLength, guessCategory } from './phrases.js';
import { swingBeat, LOOKAHEAD, INTERVAL_MS } from './transport.js';

const SOURCE = 'preview';
const FREE_LEAD = 0.03;   // seconds of headroom before the first note when the transport is stopped

export function createPreview({ store, router, timebase, timers, transport = null, presets = null, getPresets = () => presets, emit = () => {} }) {
  let active = null;      // { part, category, phrase, notes: [...], end }
  let timer = null;
  const rotation = {};    // category -> index of the phrase played last

  function partIndex(part) {
    const p = part === 'sel' || part == null ? Math.round(store.get('ui.selectedPart') || 0) : Number(part);
    return isTrack(store, p) ? p : null;
  }

  /** Category of the part's patch: the preset library first, then a guess from the sound. */
  function categoryOf(p) {
    const name = store.get(`parts.${p}.patchName`);
    const presets = getPresets();
    if (presets && typeof presets.getPatch === 'function' && name) {
      try {
        const patch = presets.getPatch(name);
        if (patch && PHRASES[patch.category]) return patch.category;
      } catch { /* a broken preset store must not stop the preview */ }
    }
    return guessCategory(store.get(`parts.${p}.params`) || {}, activeSeq(store.get(`parts.${p}`)) || {});
  }

  function ensureTimer() {
    if (!timer) timer = timers.setInterval(tick, INTERVAL_MS);
  }

  function stopTimer() {
    if (timer) { timers.clearInterval(timer); timer = null; }
  }

  function tick() {
    const a = active;
    if (!a) { stopTimer(); return; }
    if (!timebase.running()) return;
    const now = timebase.now();
    const horizon = now + LOOKAHEAD;
    let open = false;
    for (const n of a.notes) {
      if (!n.sentOn) {
        if (n.on >= horizon) { open = true; continue; }
        n.at = Math.max(n.on, now);
        n.sentOn = true;
        router._engineOn(a.part, n.note, n.vel, n.at, SOURCE);
      }
      if (!n.sentOff) {
        const off = Math.max(n.off, n.at + 0.01);
        if (off >= horizon) { open = true; continue; }
        n.sentOff = true;
        router._engineOff(a.part, n.note, Math.max(off, now), SOURCE);
      }
    }
    if (!open && now >= a.end) finish('end');
  }

  function finish(reason) {
    const a = active;
    if (!a) return;
    active = null;
    stopTimer();
    emit({ part: a.part, playing: false, reason, category: a.category, phrase: a.phrase });
  }

  /** Stop the preview now: note-offs for whatever is sounding, nothing new starts. */
  function stop(reason = 'stop') {
    const a = active;
    if (!a) return false;
    const now = timebase.now();
    for (const n of a.notes) {
      if (n.sentOn && !n.sentOff) router._engineOff(a.part, n.note, Math.max(now, n.at + 0.005), SOURCE);
      n.sentOn = n.sentOff = true;
    }
    finish(reason);
    return true;
  }

  /**
   * Play a phrase on `part` ('sel' = the selected part). Options: category
   * (override), phrase (index or name within the category). Calling it again
   * restarts with the next phrase of the category.
   */
  function preview(part = 'sel', opts = {}) {
    const p = partIndex(part);
    if (p == null) return null;
    if (active) stop('restart');
    const category = PHRASES[opts.category] ? opts.category : categoryOf(p);
    const set = PHRASES[category];
    let idx;
    if (Number.isInteger(opts.phrase)) idx = clamp(opts.phrase, 0, set.list.length - 1);
    else if (typeof opts.phrase === 'string' && set.list.some(x => x.name === opts.phrase)) idx = set.list.findIndex(x => x.name === opts.phrase);
    else idx = ((rotation[category] ?? -1) + 1) % set.list.length;
    rotation[category] = idx;
    const phrase = set.list[idx];

    const root = Math.round(store.get('global.scaleRoot') || 0);
    const scaleType = Math.round(store.get('global.scaleType') ?? 1);
    const swing = store.get('global.swing') || 0;
    const now = timebase.now();
    // On the sequencer's grid when it runs (next beat), otherwise right away at the set tempo.
    let timeOf;
    const gridStart = transport && typeof transport.nextGridTime === 'function' ? transport.nextGridTime(1, now + 0.01, { swing: false }) : null;
    if (gridStart != null && typeof transport.timeAtBeat === 'function') {
      const startBeat = Math.round(transport.beatAt(gridStart));
      timeOf = (b) => transport.timeAtBeat(startBeat + swingBeat(b, swing));
    } else {
      const spb = 60 / clamp(Number(store.get('global.tempo')) || 120, 20, 400);
      const start = now + FREE_LEAD;
      timeOf = (b) => start + swingBeat(b, swing) * spb;
    }
    const notes = phraseEvents(phrase, { baseOctave: set.baseOctave, root, scaleType }).map(e => {
      const on = timeOf(e.beat);
      return { note: e.note, vel: e.vel, on, off: Math.max(on + 0.02, timeOf(e.end)), at: on, sentOn: false, sentOff: false };
    });
    if (!notes.length) return null;
    const end = Math.max(...notes.map(n => n.off));
    active = { part: p, category, phrase: phrase.name, notes, end };
    const info = { part: p, playing: true, category, phrase: phrase.name, start: notes[0].on, duration: end - notes[0].on, beats: phraseLength(phrase) };
    emit(info);
    ensureTimer();
    tick();
    return info;
  }

  return {
    preview,
    stop,
    isPlaying: () => !!active,
    current: () => (active ? { part: active.part, category: active.category, phrase: active.phrase } : null),
    categoryOf: (part) => { const p = partIndex(part); return p == null ? null : categoryOf(p); },
    dispose() { stop('dispose'); stopTimer(); },
  };
}
