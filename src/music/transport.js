// Transport and lookahead scheduler.
//
// A setInterval wakes every INTERVAL_MS and schedules every sequencer step,
// arp step and MIDI clock pulse that falls inside the next LOOKAHEAD seconds of
// AudioContext time, passing exact timestamps to the engine so timing does not
// depend on when the JavaScript happens to run.
//
// Beat <-> time is a piecewise-linear tempo map anchored at (anchorTime,
// anchorBeat). Tempo changes re-anchor at the scheduling frontier so nothing
// already queued moves. In follow mode the anchor is moved by every incoming
// MIDI clock pulse (see src/midi/clock.js), and events are only scheduled a
// few pulses ahead of the last one received, so the external clock leads.
//
// Dot locks (see locks.js) ride on the same scheduler: a locked step hands its
// spot to the lock player with the step's audio time, and the player starts
// the glide when that moment is heard.

import { NUM_PARTS, SEQ_RATES, stepToMidi, clamp } from '../core/params.js';
import { createEmitter } from './emitter.js';
import { MIN_GAP, LATE_WINDOW } from './router.js';
import { createLockPlayer, wrap01 } from './locks.js';

export const LOOKAHEAD = 0.12;       // seconds of audio scheduled ahead
export const INTERVAL_MS = 25;       // scheduler wake-up period
export const START_DELAY = 0.06;     // headroom so the first notes are not late
export const PPQ = 24;               // MIDI clock pulses per quarter note
const EXT_AHEAD_BEATS = 6 / PPQ;     // follow mode: schedule at most a 16th past the last pulse received
const SLIDE_OVERLAP = 0.004;         // a slid note overlaps the next one by this much (legato)
const HEARD_KEEP = 8;                // per part: recently scheduled steps kept to answer "which step is sounding"

/** Delay of the off-beat 16th, in beats. Swing 0.6 (the maximum) = a 3:1 shuffle. */
export function swingOffsetBeats(swing) {
  return (clamp(Number(swing) || 0, 0, 0.6) / 0.6) * 0.125;
}

/**
 * Time-warp within each eighth note: the first 16th is stretched and the
 * second compressed, so every subdivision (16ths, 32nds, the arp) swings
 * consistently and eighth-note positions never move.
 */
export function swingBeat(beat, swing) {
  const d = swingOffsetBeats(swing);
  if (d <= 0) return beat;
  const e = Math.floor(beat * 2 + 1e-9) / 2;
  const f = Math.max(0, beat - e);
  return f <= 0.25 ? e + f * (0.25 + d) / 0.25 : e + 0.25 + d + (f - 0.25) * (0.25 - d) / 0.25;
}

const isTriplet = (rateIdx) => /T$/.test((SEQ_RATES[rateIdx] || {}).name || '');
const finite = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** The lock a step carries when it plays, or null. A switched-off sequencer moves nothing. */
export function stepLock(seq, step) {
  if (!seq || !seq.enabled || !step || !step.lock) return null;
  return { x: wrap01(finite(step.lx, 0.5)), y: wrap01(finite(step.ly, 0.5)) };
}

export function createTransport({ store, engine, timebase, router, timers }) {
  const emitter = createEmitter();
  let playing = false;
  let follow = false;          // the "follow external clock" setting
  let external = false;        // the current run is driven by external clock
  let anchored = false;
  let anchorTime = 0;
  let anchorBeat = 0;
  let spb = 60 / tempoNow();
  let frontier = 0;
  let clockIdx = 0;
  let extLastBeat = -Infinity;
  let extStartBeat = 0;
  let extLastPulse = -Infinity;  // audio time of the latest external pulse (playing or not)
  let engineBeat = -1;
  let timer = null;
  // heard: [{ time, step }] of the latest scheduled steps, oldest first.
  const ps = Array.from({ length: NUM_PARTS }, () => ({ absStep: 0, rateIdx: null, tie: null, heard: [] }));
  const locks = createLockPlayer({ store, timebase, timers, currentStep, isPlaying: () => playing });

  function tempoNow() {
    return clamp(Number(store.get('global.tempo')) || 120, 20, 400);
  }

  const timeAt = (beat) => anchorTime + (beat - anchorBeat) * spb;
  const beatAt = (time) => anchorBeat + (time - anchorTime) / spb;
  const swungTime = (beat, rateIdx) => timeAt(isTriplet(rateIdx) ? beat : swingBeat(beat, store.get('global.swing')));

  const grid = {
    get spb() { return spb; },
    timeAt: swungTime,
    beatAt,
  };

  function setUiPlaying(v) {
    if (store.get('ui.playing') !== v) store.set('ui.playing', v, { source: 'transport' });
  }

  function emitState() {
    emitter.emit('state', { playing, external: follow, source: playing ? (external ? 'external' : 'internal') : null });
  }

  // While following, Play still works when no clock is arriving (nothing is
  // connected, or the master is stopped and not sending pulses).
  const clockArriving = () => timebase.now() - extLastPulse < 0.5;

  function ensureTimer() {
    if (!timer) timer = timers.setInterval(tick, INTERVAL_MS);
  }

  function stopTimer() {
    if (timer) { timers.clearInterval(timer); timer = null; }
  }

  function resetParts(beat) {
    for (let p = 0; p < NUM_PARTS; p++) {
      const seq = store.get(`parts.${p}.seq`) || {};
      const rateIdx = clamp(Math.round(seq.rate ?? 3), 0, SEQ_RATES.length - 1);
      const rate = SEQ_RATES[rateIdx].beats;
      ps[p].rateIdx = rateIdx;
      ps[p].absStep = Math.ceil(beat / rate - 1e-9);
      ps[p].tie = null;
      ps[p].heard = [];
    }
  }

  /** Index of the step of `part` being heard right now, or -1 (stopped, or before the first step). */
  function currentStep(part) {
    if (!playing || !(part >= 0 && part < NUM_PARTS)) return -1;
    const heardNow = timebase.perfToAudio(timebase.perfNow()) + 1e-4;
    const list = ps[part].heard;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].time <= heardNow) return list[i].step;
    return -1;
  }

  function releaseTies(now) {
    for (let p = 0; p < NUM_PARTS; p++) {
      const tie = ps[p].tie;
      if (!tie) continue;
      router._engineOff(p, tie.note, Math.max(now, tie.onTime + 0.01), 'seq');
      ps[p].tie = null;
    }
  }

  function announceStep(part, step, time, lock) {
    if (!emitter.has('step')) return;
    const detail = { part, step, time, lock };
    const delay = timebase.heardDelayMs(time);
    if (delay < 4) emitter.emit('step', detail);
    else timers.setTimeout(() => emitter.emit('step', detail), delay);
  }

  function playStep(p, seq, idx, t, tNext, rate) {
    const st = ps[p];
    const step = seq.steps && seq.steps[idx];
    st.heard.push({ time: t, step: idx });
    if (st.heard.length > HEARD_KEEP) st.heard.shift();
    // A lock moves the dot whether or not the step has a note.
    const lock = stepLock(seq, step);
    announceStep(p, idx, t, lock);
    if (lock) locks.schedule(p, idx, lock, t, clamp(finite(seq.lockGlide, 0.5), 0, 1) * Math.max(0, tNext - t));
    const active = seq.enabled && step && step.on;
    if (!active) {
      if (st.tie) { router._engineOff(p, st.tie.note, t, 'seq'); st.tie = null; }
      return;
    }
    const note = clamp(stepToMidi(step, seq.baseOctave ?? 3, store.get('global.scaleRoot') || 0, store.get('global.scaleType') || 0), 0, 127);
    const vel = step.accent ? 1 : clamp(Number.isFinite(step.vel) ? step.vel : 0.8, 0.01, 1);
    const gateEnd = Math.max(t + 0.01, Math.min(t + clamp(step.gate ?? 0.5, 0.05, 1) * rate * spb, tNext - MIN_GAP));
    if (st.tie && st.tie.note === note) {
      // Same pitch tied over: the note simply keeps sounding.
      if (!step.slide) { router._engineOff(p, note, gateEnd, 'seq'); st.tie = null; }
      return;
    }
    router._engineOn(p, note, vel, t, 'seq');
    if (st.tie) {
      router._engineOff(p, st.tie.note, t + SLIDE_OVERLAP, 'seq');
      st.tie = null;
    }
    if (step.slide) st.tie = { note, onTime: t };
    else router._engineOff(p, note, gateEnd, 'seq');
  }

  function scheduleSeq(now, horizon) {
    for (let p = 0; p < NUM_PARTS; p++) {
      const seq = store.get(`parts.${p}.seq`);
      if (!seq) continue;
      const st = ps[p];
      const rateIdx = clamp(Math.round(seq.rate ?? 3), 0, SEQ_RATES.length - 1);
      const rate = SEQ_RATES[rateIdx].beats;
      if (st.rateIdx !== rateIdx) {
        // Rate changed mid-play: continue from the same musical position on the new grid.
        const b = st.rateIdx == null ? beatAt(now) : st.absStep * SEQ_RATES[st.rateIdx].beats;
        st.absStep = Math.ceil(b / rate - 1e-9);
        st.rateIdx = rateIdx;
      }
      const len = clamp(Math.round(seq.length || 16), 1, 16);
      for (let guard = 0; guard < 64; guard++) {
        let t = swungTime(st.absStep * rate, rateIdx);
        if (t >= horizon) break;
        const idx = ((st.absStep % len) + len) % len;
        st.absStep++;
        if (t < now - LATE_WINDOW) {
          // Too late to be heard in time (tab was frozen): skip rather than pile up.
          if (st.tie) { router._engineOff(p, st.tie.note, now, 'seq'); st.tie = null; }
          continue;
        }
        if (t < now) t = now;
        const tNext = swungTime(st.absStep * rate, rateIdx);
        playStep(p, seq, idx, t, tNext, rate);
      }
    }
  }

  function scheduleClock(now, horizon) {
    for (let guard = 0; guard < 256; guard++) {
      const t = timeAt(clockIdx / PPQ);
      if (t >= horizon) break;
      if (t >= now - LATE_WINDOW) emitter.emit('clock', { type: 'tick', time: Math.max(t, now), index: clockIdx });
      clockIdx++;
    }
  }

  function anchorInternal(now) {
    spb = 60 / tempoNow();
    anchorTime = now + START_DELAY;
    anchorBeat = 0;
    frontier = now;
    clockIdx = 0;
    resetParts(0);
    anchored = true;
    emitter.emit('clock', { type: 'start', time: anchorTime - 0.001 });
    notifyEngine();
  }

  /**
   * Optional engine hook: "beat `beat` happens at audio time `beatTime`", so
   * tempo-synced LFOs line up with the bar. Sent on start, stop, tempo changes
   * and once per beat while following external clock.
   */
  function notifyEngine() {
    if (!engine || typeof engine.setTransport !== 'function') return;
    try { engine.setTransport({ playing: playing && anchored, beatTime: anchorTime, beat: anchorBeat, spb }); } catch { /* optional */ }
  }

  function tick() {
    if (!timebase.running()) return;
    const now = timebase.now();
    if (playing && !anchored && !external) anchorInternal(now);
    let horizon = now + LOOKAHEAD;
    const live = playing && anchored;
    if (live) {
      if (external) horizon = Math.min(horizon, timeAt(extLastBeat + EXT_AHEAD_BEATS));
      scheduleSeq(now, horizon);
      if (!external) scheduleClock(now, horizon);
      frontier = Math.max(frontier, horizon);
    }
    router.scheduleArps(now, horizon, live ? grid : null, tempoNow());
    if (!playing && !router.arpActive()) stopTimer();
  }

  function play() {
    if (playing) return true;
    if (follow && clockArriving()) {
      // The clock master starts and stops playback.
      setUiPlaying(0);
      emitState();
      return false;
    }
    playing = true;
    external = false;
    anchored = false;
    setUiPlaying(1);
    emitState();
    ensureTimer();
    tick();
    return true;
  }

  function stop() {
    if (!playing) { setUiPlaying(0); return; }
    const now = timebase.now();
    playing = false;
    releaseTies(now);
    locks.cancelAll();
    if (anchored && !external) emitter.emit('clock', { type: 'stop', time: now });
    notifyEngine();
    anchored = false;
    external = false;
    setUiPlaying(0);
    emitState();
    // Let the arps carry on free-running from where the grid was.
    if (router.arpActive()) { ensureTimer(); tick(); }
  }

  function toggle() {
    if (playing) stop(); else play();
    return playing;
  }

  function position() {
    if (!playing || !anchored) return { bar: 0, beat: 0, step: 0 };
    const heard = timebase.perfToAudio(timebase.perfNow());
    const b = Math.max(0, beatAt(heard));
    return { bar: Math.floor(b / 4), beat: Math.floor(b) % 4, step: Math.floor(b * 4) % 16 };
  }

  // --------------------------------------------------- external clock (follow)

  function setFollow(on) {
    on = !!on;
    if (on === follow) return;
    if (playing && external) stop();
    follow = on;
    extLastBeat = -Infinity;
    extLastPulse = -Infinity;
    emitState();
  }

  /** MIDI Start / Continue: armed; the next clock pulse is `beat`. Takes over internal playback. */
  function syncStart({ beat = 0 } = {}) {
    if (!follow) return;
    if (playing) {
      releaseTies(timebase.now());
      if (anchored && !external) emitter.emit('clock', { type: 'stop', time: timebase.now() });
    }
    playing = true;
    external = true;
    anchored = false;
    extStartBeat = beat;
    engineBeat = -1;
    setUiPlaying(1);
    emitState();
    ensureTimer();
  }

  /** One MIDI clock pulse at musical position `beat`, heard at audio `time`. */
  function syncTick({ beat, time, bpm }) {
    if (!follow) return;
    extLastPulse = Math.max(extLastPulse, timebase.now());
    if (!playing || !external) return;
    if (Number.isFinite(bpm) && bpm > 0) spb = 60 / clamp(bpm, 20, 400);
    if (!anchored) {
      anchored = true;
      anchorBeat = Number.isFinite(beat) ? beat : extStartBeat;
      anchorTime = time;
      frontier = time;
      resetParts(anchorBeat);
    } else {
      anchorBeat = beat;
      anchorTime = time;
    }
    extLastBeat = anchorBeat;
    if (Math.floor(anchorBeat) !== engineBeat) { engineBeat = Math.floor(anchorBeat); notifyEngine(); }
    tick();
  }

  function syncStop() {
    if (playing && external) stop();
  }

  // ------------------------------------------------------------- store glue

  const unsubs = [];
  unsubs.push(store.subscribe('global.tempo', () => {
    if (external) return;
    const next = 60 / tempoNow();
    if (!anchored) { spb = next; return; }
    if (Math.abs(next - spb) < 1e-9) return;
    const t0 = Math.max(frontier, timebase.now());
    anchorBeat = beatAt(t0);
    anchorTime = t0;
    spb = next;
    notifyEngine();
  }));
  unsubs.push(store.subscribe('ui.playing', (path, value, meta) => {
    if (meta && meta.source === 'transport') return;
    const want = !!store.get('ui.playing');
    if (want && !playing) play();
    else if (!want && playing) stop();
  }));

  function kick() {
    ensureTimer();
    tick();
  }

  return {
    play, stop, toggle, position,
    isPlaying: () => playing,
    isFollowing: () => follow,
    isExternal: () => playing && external,
    on: (type, fn) => emitter.on(type, fn),
    off: (type, fn) => emitter.off(type, fn),
    // Older contract shape kept for convenience: onStep((part, step, time, lock) => {}).
    onStep: (fn) => emitter.on('step', e => fn(e.part, e.step, e.time, e.lock)),
    currentStep,
    locks,
    setFollow, syncStart, syncTick, syncStop,
    tick, kick,
    tempo: () => (external ? 60 / spb : tempoNow()),
    beatAt: (time) => (anchored ? beatAt(time) : 0),
    dispose() { stopTimer(); locks.dispose(); for (const u of unsubs) u(); },
  };
}
