// Live performance mode (2.12): what pads, the setlist and the big controls
// do, without any DOM, so it runs under the fake clock in the tests.
//
// Quantised switching. While the transport runs, a pad set to Beat or Bar
// waits for the next beat or bar line of the transport's grid
// (transport.nextGridTime, unswung). Changes to what the sequencer plays
// (a scene, a section, a pattern, a setlist song) are applied a little
// before the line, ahead of the scheduler's lookahead, so the first step on
// the line already plays the new material; everything else (mutes, notes,
// drum hits, presets) is applied when the line is reached. Pressing a
// queued pad again cancels it, and a newer change of the same thing (the
// scene, one track's pattern, one track's mute) replaces a queued one.
// Stopped, or with Quantise Off, a pad acts at once; stopping the transport
// applies whatever was still waiting.

import { createEmitter } from '../music/emitter.js';
import { KIT_BASE_NOTE } from '../dsp/drum-kit.js';
import { applySmartKnob, readSmart, SMART_KNOBS } from '../core/smart.js';
import { REPLACE_TRACKS } from '../core/tracks.js';
import { clamp } from '../core/params.js';
import { readLive, patchLive, defaultPads, actionKind, QUANT_BEATS, stepSetlist, createTapTempo, PAD_COUNT } from './setup.js';

/** Seconds a sequencer change is applied before the line, beyond the scheduler's lookahead. */
export const SEQ_MARGIN = 0.03;
/** Seconds a drum pad's note is held (the kit plays one-shots). */
export const DRUM_GATE = 0.12;
/** Seconds a note pad sounds when it is not held (a MIDI button, a tap that ended before the line), with the transport stopped. */
export const TAP_GATE = 0.3;
const EPS = 0.005;
const META = { source: 'live' };

export function createLiveController({
  store, music = null, presets = null, timers = globalThis,
  getVersions = () => null, togglePlay = null, panic = null, now = () => Date.now(),
} = {}) {
  if (!store) throw new Error('createLiveController needs a store');
  const emitter = createEmitter();
  const transport = music && music.transport;
  const router = music && music.router;
  const timebase = music && music.timebase;
  const queue = [];          // { id, pad, song, slot, kind, run, start, boundary, fireAt, fired, held, timer }
  const held = new Map();    // pad index -> { track, notes, source }
  const gates = new Set();   // timers that end notes
  let lastScene = null;      // id of the scene loaded last (pads show it as active)
  let pos = -1;              // setlist position (-1: no song loaded from the setlist yet)
  let seq = 0;
  let disposed = false;
  const tapper = createTapTempo({ now });
  const changed = () => { if (!disposed) emitter.emit('change'); };
  const unsubs = [];

  const audioNow = () => (timebase ? timebase.now() : now() / 1000);
  const parts = () => (Array.isArray(store.get('parts')) ? store.get('parts') : []);
  const live = () => readLive(store.get('live'));
  const userScenes = () => {
    try { return presets ? presets.scenes().filter(s => !s.factory) : []; } catch { return []; }
  };
  const allScenes = () => { try { return presets ? presets.scenes() : []; } catch { return []; } };

  /** The 16 pads: the saved ones, or the defaults built from the session. */
  function pads() {
    const saved = live().pads;
    if (saved) return saved;
    return defaultPads({ parts: parts(), global: store.get('global'), ui: { selectedPart: store.get('ui.selectedPart') } }, userScenes());
  }

  function trackOf(pad) {
    const n = parts().length;
    const t = pad.track === 'sel' ? clamp(Math.round(Number(store.get('ui.selectedPart')) || 0), 0, Math.max(0, n - 1)) : pad.track;
    return Number.isInteger(t) && t >= 0 && t < n ? t : -1;
  }

  /** Why a pad cannot act right now ('' when it can). */
  function missing(pad) {
    if (!pad) return 'Empty pad';
    switch (pad.type) {
      case 'scene': return allScenes().some(s => s.id === pad.scene) ? '' : 'That scene is no longer in your library';
      case 'section': return parts().some(p => Array.isArray(p.patterns) && p.patterns.length > pad.pattern) ? '' : `No track has pattern ${pad.pattern + 1}`;
      case 'pattern': {
        const t = trackOf(pad);
        if (t < 0) return `There is no track ${pad.track + 1}`;
        return (parts()[t].patterns || []).length > pad.pattern ? '' : `Track ${t + 1} has no pattern ${pad.pattern + 1}`;
      }
      case 'mute': case 'solo': case 'drum': case 'note':
        return trackOf(pad) < 0 ? `There is no track ${Number(pad.track) + 1}` : '';
      case 'smart': {
        const t = trackOf(pad);
        if (t < 0) return `There is no track ${Number(pad.track) + 1}`;
        const knobs = readSmart(store, t).knobs;
        return pad.values.some((v, k) => v != null && knobs[k] && knobs[k].maps.length) ? '' : 'Those smart controls have no targets on this track';
      }
      default: return '';
    }
  }

  /** Whether a pad's effect is in place now (a pad lights up, steady, while it is). */
  function isActive(pad, i) {
    if (!pad) return false;
    const list = parts();
    switch (pad.type) {
      case 'scene': return lastScene != null && pad.scene === lastScene;
      case 'section': {
        const with_ = list.filter(p => Array.isArray(p.patterns) && p.patterns.length > pad.pattern);
        return with_.length > 0 && with_.every(p => Math.round(Number(p.activePattern) || 0) === pad.pattern);
      }
      case 'pattern': { const t = trackOf(pad); return t >= 0 && Math.round(Number(list[t].activePattern) || 0) === pad.pattern; }
      case 'mute': { const t = trackOf(pad); return t >= 0 && !!(list[t].params && list[t].params.mute); }
      case 'solo': { const t = trackOf(pad); return t >= 0 && !!(list[t].params && list[t].params.solo); }
      case 'drum': case 'note': return held.has(i);
      case 'macros': return pad.values.every((v, k) => Math.abs((Number(store.get(`global.macro${k + 1}`)) || 0) - v) < EPS);
      case 'smart': {
        const t = trackOf(pad);
        if (t < 0) return false;
        const knobs = readSmart(store, t).knobs;
        const set = pad.values.map((v, k) => [v, knobs[k]]).filter(([v, kn]) => v != null && kn && kn.maps.length);
        return set.length > 0 && set.every(([v, kn]) => Math.abs((Number(kn.value) || 0) - v) < EPS);
      }
      default: return false;
    }
  }

  const queuedFor = (i) => queue.find(e => e.pad === i) || null;

  /** 'empty' | 'missing' | 'queued' | 'active' | 'armed' for pad `i`. */
  function status(i, list = pads()) {
    const pad = list[i];
    if (!pad) return 'empty';
    if (queuedFor(i)) return 'queued';
    if (missing(pad)) return 'missing';
    return isActive(pad, i) ? 'active' : 'armed';
  }

  /** How far a queued pad (or 'song') is through its wait, 0..1, or null when it is not queued. */
  function progress(i) {
    const e = queuedFor(i);
    if (!e) return null;
    const span = e.boundary - e.start;
    return span > 0 ? clamp((audioNow() - e.start) / span, 0, 1) : 1;
  }

  // ------------------------------------------------------------ actions

  function noteOn(t, notes, vel, source) {
    if (!router) return;
    for (const n of notes) router.noteOn(t, n, vel, source);
  }
  function noteOff(t, notes, source) {
    if (!router) return;
    for (const n of notes) router.noteOff(t, n, source);
  }
  function later(fn, sec) {
    const id = timers.setTimeout(() => { gates.delete(id); fn(); }, Math.max(0, sec * 1000));
    gates.add(id);
  }
  /** One beat at the tempo while playing, else TAP_GATE. */
  const tapGate = () => (transport && transport.isPlaying() ? (typeof transport.spb === 'function' ? transport.spb() : 0.5) : TAP_GATE);

  function releaseHeld(i) {
    const h = held.get(i);
    if (!h) return;
    held.delete(i);
    noteOff(h.track, h.notes, h.source);
    changed();
  }

  /** Do what pad `i` does, now. `hold`: a note pad keeps sounding until release(i). */
  function fire(pad, i, { hold = true } = {}) {
    const list = parts();
    switch (pad.type) {
      case 'scene':
        if (presets && presets.loadScene(pad.scene)) lastScene = pad.scene;
        break;
      case 'section':
        store.batch(() => {
          list.forEach((p, t) => {
            if (Array.isArray(p.patterns) && p.patterns.length > pad.pattern && Math.round(Number(p.activePattern) || 0) !== pad.pattern) {
              store.set(`parts.${t}.activePattern`, pad.pattern, META);
            }
          });
        });
        break;
      case 'pattern': {
        const t = trackOf(pad);
        if (t >= 0 && (list[t].patterns || []).length > pad.pattern) store.set(`parts.${t}.activePattern`, pad.pattern, META);
        break;
      }
      case 'mute': case 'solo': {
        const t = trackOf(pad);
        if (t >= 0) store.set(`parts.${t}.params.${pad.type}`, store.get(`parts.${t}.params.${pad.type}`) ? 0 : 1, META);
        break;
      }
      case 'drum': {
        const t = trackOf(pad);
        if (t < 0) break;
        const note = KIT_BASE_NOTE + pad.pad;
        const source = `live${i}`;
        if (router) router.noteOn(t, note, pad.vel, source);
        held.set(i, { track: t, notes: [], source });
        later(() => { if (router) router.noteOff(t, note, source); if (held.get(i) && held.get(i).source === source) { held.delete(i); changed(); } }, DRUM_GATE);
        break;
      }
      case 'note': {
        const t = trackOf(pad);
        if (t < 0) break;
        releaseHeld(i);
        const source = `live${i}`;
        noteOn(t, pad.notes, pad.vel, source);
        held.set(i, { track: t, notes: pad.notes.slice(), source });
        if (!hold) later(() => { if (held.get(i) && held.get(i).source === source) releaseHeld(i); }, tapGate());
        break;
      }
      case 'macros':
        store.batch(() => pad.values.forEach((v, k) => { if (store.get(`global.macro${k + 1}`) !== v) store.set(`global.macro${k + 1}`, v, META); }));
        break;
      case 'smart': {
        const t = trackOf(pad);
        if (t < 0) break;
        store.batch(() => pad.values.forEach((v, k) => { if (v != null && k < SMART_KNOBS) applySmartKnob(store, t, k, v, META); }));
        break;
      }
      default: break;
    }
    changed();
  }

  // -------------------------------------------------------------- queue

  /** The grid line `div` beats long that a change of `kind` can still make, or null when it should happen now. */
  function boundary(div, kind) {
    if (!transport || !timebase || !transport.isPlaying() || typeof transport.nextGridTime !== 'function') return null;
    const t0 = audioNow();
    let lead = EPS;
    if (kind === 'seq') {
      const ahead = typeof transport.lookahead === 'function' ? transport.lookahead() : 0.12;
      const comp = router && typeof router.maxLead === 'function' ? router.maxLead() : 0;
      lead = ahead + comp + SEQ_MARGIN;
    }
    const time = transport.nextGridTime(div, t0 + lead, { swing: false });
    if (time == null || !Number.isFinite(time)) return null;
    return { time, fireAt: time - lead, start: t0 };
  }

  function clearTimer(e) { if (e.timer != null) { timers.clearTimeout(e.timer); e.timer = null; } }

  function remove(e) {
    clearTimer(e);
    const k = queue.indexOf(e);
    if (k >= 0) queue.splice(k, 1);
  }

  function arm(e, sec) {
    clearTimer(e);
    e.timer = timers.setTimeout(() => check(e), Math.max(0, sec * 1000));
  }

  function run(e) {
    if (e.fired) return;
    e.fired = true;
    clearTimer(e);
    try { e.run(); } catch (err) { console.warn('[live] action failed', err); }
    const left = e.boundary - audioNow();
    // Keep showing it as queued until the line itself.
    if (left > 0.002 && transport && transport.isPlaying()) arm(e, left);
    else remove(e);
    changed();
  }

  function check(e) {
    e.timer = null;
    if (!queue.includes(e)) return;
    if (e.fired) { remove(e); changed(); return; }
    if (!transport || !transport.isPlaying()) { run(e); return; }
    const left = e.fireAt - audioNow();
    if (left > 0.001) { arm(e, timebase && !timebase.running() ? 0.05 : Math.max(0.004, left)); return; }
    run(e);
  }

  function enqueue(entry, b) {
    for (const old of queue.filter(q => !q.fired && q.slot === entry.slot)) remove(old);
    const e = { id: ++seq, fired: false, timer: null, ...entry, start: b.start, boundary: b.time, fireAt: b.fireAt };
    queue.push(e);
    arm(e, e.fireAt - audioNow());
    changed();
    return e;
  }

  function slotOf(pad, i) {
    switch (pad.type) {
      case 'scene': return 'scene';
      case 'section': return 'section';
      case 'pattern': return `pattern:${pad.track}`;
      case 'mute': case 'solo': return `${pad.type}:${pad.track}`;
      case 'macros': return 'macros';
      case 'smart': return `smart:${pad.track}`;
      default: return `pad:${i}`;
    }
  }

  /**
   * Press pad `i`. Returns 'fired', 'queued', 'cancelled' (it was queued),
   * 'busy' (already applied, waiting for its line), 'missing' or 'empty'.
   * `hold` false: a note pad ends by itself (MIDI buttons).
   */
  function press(i, { hold = true } = {}) {
    if (!(i >= 0 && i < PAD_COUNT)) return 'empty';
    const pad = pads()[i];
    if (!pad) return 'empty';
    const q = queuedFor(i);
    if (q) {
      if (q.fired) return 'busy';
      remove(q);
      changed();
      return 'cancelled';
    }
    if (missing(pad)) return 'missing';
    const div = QUANT_BEATS[pad.quant];
    if (div) {
      const kind = actionKind(pad.type);
      const b = boundary(div, kind);
      if (b) {
        enqueue({ pad: i, slot: slotOf(pad, i), kind, held: hold, run: () => {
          const e = queue.find(x => x.pad === i);
          fire(pad, i, { hold: e ? e.held : false });
        } }, b);
        return 'queued';
      }
    }
    fire(pad, i, { hold });
    return 'fired';
  }

  /** Let go of pad `i` (note pads stop; a queued note pad will play a short note). */
  function release(i) {
    const q = queuedFor(i);
    if (q && !q.fired) { q.held = false; return; }
    if (held.has(i)) {
      const h = held.get(i);
      if (h.notes.length) releaseHeld(i);
    }
  }

  function cancel(i) {
    const q = queuedFor(i);
    if (!q || q.fired) return false;
    remove(q);
    changed();
    return true;
  }

  function cancelAll() {
    for (const e of queue.slice()) if (!e.fired) remove(e);
    changed();
  }

  // ------------------------------------------------------------ setlist

  const setlist = () => live().setlist;

  async function songState(entry) {
    if (entry.kind !== 'version') return null;
    const v = getVersions && getVersions();
    if (!v || typeof v.get !== 'function') throw new Error('Version history is not available');
    return v.get(entry.ref);
  }

  function applySong(index, entry, state) {
    if (entry.kind === 'scene') {
      if (!presets || !presets.loadScene(entry.ref)) return false;
      lastScene = entry.ref;
    } else {
      if (!state || typeof state !== 'object') return false;
      const next = JSON.parse(JSON.stringify(state));
      delete next.live;
      const cur = store.get('live');
      if (cur && typeof cur === 'object') next.live = JSON.parse(JSON.stringify(cur));
      store.load(next, { source: 'restore', [REPLACE_TRACKS]: true });
      lastScene = null;
    }
    pos = index;
    changed();
    return true;
  }

  function songMissing(entry) {
    if (!entry) return 'No song there';
    if (entry.kind === 'scene') return allScenes().some(s => s.id === entry.ref) ? '' : 'That scene is no longer in your library';
    const v = getVersions && getVersions();
    if (!v) return 'Version history is not available';
    try { return v.list().some(x => x.id === entry.ref) ? '' : 'That version is no longer stored'; } catch { return ''; }
  }

  const songQueued = () => queue.find(e => e.pad === 'song') || null;

  /**
   * Load setlist song `index`. While the transport runs, songChange 'bar'
   * waits for the next bar, 'confirm' returns 'confirm' unless `confirmed`
   * (then waits for the bar), 'now' loads at once. Resolves to 'loaded',
   * 'queued', 'confirm', 'missing' or 'failed'.
   */
  async function goTo(index, { confirmed = false } = {}) {
    const list = setlist();
    const entry = list[index];
    if (!entry || songMissing(entry)) return 'missing';
    const { songChange } = live();
    const running = !!(transport && transport.isPlaying());
    if (running && songChange === 'confirm' && !confirmed) return 'confirm';
    let state = null;
    try { state = await songState(entry); } catch (err) { console.warn('[live] could not read the version', err); return 'failed'; }
    if (running && songChange !== 'now') {
      const b = boundary(QUANT_BEATS.bar, 'seq');
      if (b) {
        enqueue({ pad: 'song', song: index, slot: 'scene', kind: 'seq', held: false, run: () => applySong(index, entry, state) }, b);
        return 'queued';
      }
    }
    return applySong(index, entry, state) ? 'loaded' : 'failed';
  }

  /** Next / previous song. A queued song change is cancelled instead. */
  function step(dir, opts) {
    const q = songQueued();
    if (q && !q.fired) { remove(q); changed(); return Promise.resolve('cancelled'); }
    const n = setlist().length;
    if (!n) return Promise.resolve('empty');
    if (dir < 0 && pos <= 0) return Promise.resolve('start');
    if (dir > 0 && pos >= n - 1) return Promise.resolve('end');
    return goTo(stepSetlist(pos, dir, n), opts);
  }

  // ----------------------------------------------------- setup and misc

  function writeLive(patch, meta = META) {
    const next = patchLive(store.get('live'), patch);
    store.set('live', next || undefined, meta);
    if (pos >= setlist().length) pos = setlist().length - 1;
    changed();
  }

  /** Save one pad (null clears it); the first edit keeps the other default pads as they were. */
  function setPad(i, pad) {
    if (!(i >= 0 && i < PAD_COUNT)) return;
    const list = pads().slice();
    list[i] = pad;
    writeLive({ pads: list });
  }

  function setTempo(bpm) {
    const v = clamp(Math.round(Number(bpm) || 0), 40, 240);
    if (!(v > 0)) return;
    if (store.get('global.tempo') !== v) store.set('global.tempo', v, META);
    changed();
  }

  function tap() {
    const bpm = tapper.tap();
    if (bpm != null) setTempo(bpm);
    return bpm;
  }

  function doPanic() {
    cancelAll();
    for (const i of [...held.keys()]) releaseHeld(i);
    if (panic) panic();
    else {
      if (router) router.allNotesOff();
      if (music && music.engine && typeof music.engine.panic === 'function') music.engine.panic();
    }
    changed();
  }

  function play() {
    if (togglePlay) return togglePlay();
    if (transport) transport.toggle();
    return undefined;
  }

  // Stopping the transport applies what was still waiting (it would never reach its line).
  if (transport && typeof transport.on === 'function') {
    unsubs.push(transport.on('state', (st) => {
      if (st && st.playing) return;
      for (const e of queue.slice()) { if (e.fired) remove(e); else run(e); }
      changed();
    }));
  }
  if (presets && typeof presets.on === 'function') {
    unsubs.push(presets.on('change', (d) => {
      if (d && d.kind === 'scene' && d.action === 'load') { lastScene = d.id || null; changed(); }
    }));
  }

  return {
    pads, status, progress, missing: (i) => missing(pads()[i]),
    press, release, cancel, cancelAll,
    queued: () => queue.map(e => ({ pad: e.pad, song: e.song, slot: e.slot, kind: e.kind, start: e.start, boundary: e.boundary, fireAt: e.fireAt, fired: e.fired })),
    setlist, position: () => pos, setPosition: (p) => { pos = Number.isInteger(p) ? clamp(p, -1, setlist().length - 1) : -1; changed(); },
    goTo, next: (o) => step(1, o), prev: (o) => step(-1, o), songQueued: () => !!songQueued(), songProgress: () => progress('song'),
    queuedSong: () => { const q = songQueued(); return q ? q.song : -1; },
    songMissing: (i) => songMissing(setlist()[i]),
    setup: live, writeLive, setPad,
    setTempo, tap, panic: doPanic, play,
    lastScene: () => lastScene,
    on: (type, fn) => emitter.on(type, fn),
    dispose() {
      disposed = true;
      for (const e of queue.slice()) remove(e);
      for (const id of gates) timers.clearTimeout(id);
      gates.clear();
      for (const i of [...held.keys()]) { const h = held.get(i); held.delete(i); noteOff(h.track, h.notes, h.source); }
      for (const u of unsubs) { try { u(); } catch { /* ignore */ } }
    },
  };
}
