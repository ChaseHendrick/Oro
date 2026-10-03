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
//
// Pedal latency compensation (src/pedals/latency-comp.js): the router may give
// a part a lead (router.leadFor). That part's steps are scheduled up to the
// lead further ahead and sent to the engine that much earlier (never in the
// past); everything else here (step announcements, locks, currentStep, MIDI
// out) stays on the heard time.

// Tracks: every track in the list plays the pattern it has selected
// (activePattern) while its seqOn is set. Per-track scheduling state follows
// the track when the list is reordered (src/core/tracks.js).

// Probability and ratchets: a step that is on plays this pass when
// stepPlays() says so (a hash of the seed, the track and the step count since
// Play, so it is repeatable); `probSeed` sets the seed and each Play moves on
// to the next one. A ratchet of N splits the step into N equal hits, each with
// the step's gate scaled to its share and RATCHET_DECAY times the velocity of
// the hit before it. A slide applies to the last hit.

import { MAX_PARTS, SEQ_RATES, RATCHET_DECAY, stepToMidi, stepPlays, stepRatchet, stepChance, activeSeq, clamp } from '../core/params.js';

// v2.6 humanize: up to this late (s) at Humanize time 1, and this share of velocity either way at Humanize velocity 1
export const HUMAN_TIME_MAX = 0.02;
export const HUMAN_VEL_MAX = 0.3;
import { partCount, watchTracks, permute } from '../core/tracks.js';
import { createEmitter } from './emitter.js';
import { MIN_GAP, LATE_WINDOW } from './router.js';
import { createLockPlayer, wrap01 } from './locks.js';

export const LOOKAHEAD = 0.12;       // seconds of audio scheduled ahead (normal)
// When the main thread stalls (garbage collection, a heavy redraw, a busy
// machine) the scheduler wakes late and steps would be dropped as too late.
// After a stall the lookahead grows to cover a stall of the same length,
// then shrinks back over a few seconds of smooth running.
export const MAX_LOOKAHEAD = 0.5;
const LOOKAHEAD_TAU = 0.8;           // seconds: time constant of the way back to normal
export const INTERVAL_MS = 25;       // scheduler wake-up period
export const START_DELAY = 0.06;     // headroom so the first notes are not late
export const PPQ = 24;               // MIDI clock pulses per quarter note
const EXT_AHEAD_BEATS = 6 / PPQ;     // follow mode: schedule a 16th past the last pulse received (more after a stall)
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

export function createTransport({ store, engine, timebase, router, timers, lockPlayer = null, probSeed = 1 }) {
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
  let lookahead = LOOKAHEAD;   // adaptive, see adaptLookahead()
  let lastTickMs = null;       // performance time of the previous timer tick
  let runs = -1;               // Plays so far (minus one): advances the probability seed
  // heard: [{ time, step }] of the latest scheduled steps, oldest first.
  const freshState = () => ({ absStep: 0, rateIdx: null, tie: null, heard: [] });
  let ps = Array.from({ length: MAX_PARTS }, freshState);
  const count = () => partCount(store);
  /** The pattern track `p` plays, with `enabled` = its seqOn (null for no track). */
  const seqOf = (p) => activeSeq(store.get(`parts.${p}`));
  // The offline renderer (render.js) swaps in a lock player that records the
  // glides as engine messages instead of animating the store.
  const locks = lockPlayer || createLockPlayer({ store, timebase, timers, currentStep, isPlaying: () => playing });

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
    if (!timer) { timer = timers.setInterval(tick, INTERVAL_MS); lastTickMs = null; }
  }

  function stopTimer() {
    if (timer) { timers.clearInterval(timer); timer = null; }
    lastTickMs = null;
  }

  /** Grow the lookahead after a late wake-up, shrink it back while ticks arrive on time. */
  function adaptLookahead() {
    const ms = timebase.perfNow();
    if (lastTickMs != null) {
      const gap = (ms - lastTickMs) / 1000;
      if (gap > 0.6 * lookahead) lookahead = Math.min(MAX_LOOKAHEAD, Math.max(lookahead, 1.5 * gap));
      // Time-based, so a burst of catch-up ticks does not shrink it at once.
      else lookahead -= (lookahead - LOOKAHEAD) * (1 - Math.exp(-gap / LOOKAHEAD_TAU));
    }
    lastTickMs = ms;
  }

  function resetParts(beat) {
    runs++;
    for (let p = 0; p < MAX_PARTS; p++) {
      const seq = seqOf(p) || {};
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
    if (!playing || !(part >= 0 && part < count())) return -1;
    const heardNow = timebase.perfToAudio(timebase.perfNow()) + 1e-4;
    const list = ps[part].heard;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].time <= heardNow) return list[i].step;
    return -1;
  }

  const leadOf = (p) => (typeof router.leadFor === 'function' ? router.leadFor(p) : 0);

  function releaseTies(now) {
    for (let p = 0; p < count(); p++) {
      const tie = ps[p].tie;
      if (!tie) continue;
      router._engineOff(p, tie.note, Math.max(now, tie.onTime + 0.01), 'seq', tie.lead);
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

  // A tied note ends with the lead it started with, so a lead that changes
  // mid-tie can never put its note-off before its note-on.
  function playStep(p, seq, idx, t, tNext, rate, lead = 0, abs = 0) {
    const st = ps[p];
    const step = seq.steps && seq.steps[idx];
    st.heard.push({ time: t, step: idx });
    if (st.heard.length > HEARD_KEEP) st.heard.shift();
    // A lock moves the dot whether or not the step has a note.
    const lock = stepLock(seq, step);
    announceStep(p, idx, t, lock);
    if (lock) locks.schedule(p, idx, lock, t, clamp(finite(seq.lockGlide, 0.5), 0, 1) * Math.max(0, tNext - t));
    const active = seq.enabled && step && step.on && stepPlays(step, (probSeed | 0) + runs, p, abs);
    if (!active) {
      if (st.tie) { router._engineOff(p, st.tie.note, t, 'seq', st.tie.lead); st.tie = null; }
      return;
    }
    const note = clamp(stepToMidi(step, seq.baseOctave ?? 3, store.get('global.scaleRoot') || 0, store.get('global.scaleType') || 0), 0, 127);
    let vel = step.accent ? 1 : clamp(Number.isFinite(step.vel) ? step.vel : 0.8, 0.01, 1);
    // humanize: a late push and a velocity wobble, the same each time this step of this pass plays
    const hT = clamp(finite(seq.humanTime, 0), 0, 1), hV = clamp(finite(seq.humanVel, 0), 0, 1);
    if (hT > 0) { const d = hT * HUMAN_TIME_MAX * stepChance(((probSeed | 0) + runs) ^ 0x51ed, p, abs); t += d; if (t > tNext - 0.002) t = tNext - 0.002; }
    if (hV > 0) vel = clamp(vel * (1 + hV * HUMAN_VEL_MAX * (2 * stepChance(((probSeed | 0) + runs) ^ 0x2a7c, p, abs) - 1)), 0.01, 1);
    const gateSec = clamp(step.gate ?? 0.5, 0.05, 1) * rate * spb;
    const hits = stepRatchet(step);
    if (hits === 1) { playHit(p, note, vel, gateSec, step.slide, t, tNext, lead, 0.01); return; }
    const span = tNext - t;
    for (let i = 0; i < hits; i++) {
      const ti = t + span * i / hits;
      const tiNext = i + 1 === hits ? tNext : t + span * (i + 1) / hits;
      // The minimum note length shrinks with very short hits so a hit never outlasts its slot.
      playHit(p, note, clamp(vel * RATCHET_DECAY ** i, 0.01, 1), gateSec / hits, i + 1 === hits && step.slide, ti, tiNext, lead,
        Math.min(0.01, (tiNext - ti) / 2));
    }
  }

  /** One note of a step (a ratcheted step plays several), with ties and slides. */
  function playHit(p, note, vel, gateSec, slide, t, tNext, lead, minLen) {
    const st = ps[p];
    const gateEnd = Math.max(t + minLen, Math.min(t + gateSec, tNext - MIN_GAP));
    if (st.tie && st.tie.note === note) {
      // Same pitch tied over: the note simply keeps sounding.
      if (!slide) { router._engineOff(p, note, gateEnd, 'seq', st.tie.lead); st.tie = null; }
      return;
    }
    router._engineOn(p, note, vel, t, 'seq', lead);
    if (st.tie) {
      router._engineOff(p, st.tie.note, t + SLIDE_OVERLAP, 'seq', st.tie.lead);
      st.tie = null;
    }
    if (slide) st.tie = { note, onTime: t, lead };
    else router._engineOff(p, note, gateEnd, 'seq', lead);
  }

  function scheduleSeq(now, horizon) {
    const n = count();
    for (let p = 0; p < n; p++) {
      const seq = seqOf(p);
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
      // A part through the pedals with compensation on looks further ahead.
      const lead = leadOf(p);
      const reach = horizon + lead;
      for (let guard = 0; guard < 64; guard++) {
        let t = swungTime(st.absStep * rate, rateIdx);
        if (t >= reach) break;
        const idx = ((st.absStep % len) + len) % len;
        st.absStep++;
        if (t < now - LATE_WINDOW) {
          // Too late to be heard in time (tab was frozen): skip rather than pile up.
          if (st.tie) { router._engineOff(p, st.tie.note, now, 'seq', st.tie.lead); st.tie = null; }
          continue;
        }
        if (t < now) t = now;
        const tNext = swungTime(st.absStep * rate, rateIdx);
        playStep(p, seq, idx, t, tNext, rate, lead, st.absStep - 1);
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
    // Leave room for the largest compensation lead, so the first notes of a
    // part through the pedals can go out early too.
    const maxLead = typeof router.maxLead === 'function' ? router.maxLead() : 0;
    anchorTime = now + START_DELAY + maxLead;
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
    if (!timebase.running()) { lastTickMs = null; return; }
    if (timer) adaptLookahead();
    const now = timebase.now();
    if (playing && !anchored && !external) anchorInternal(now);
    let horizon = now + lookahead;
    const live = playing && anchored;
    if (live) {
      // Following: stay close behind the master, but after a stall reach as far
      // ahead as the grown lookahead so late pulses do not drop steps. Stop
      // cancels whatever was queued past it (see stop()).
      if (external) horizon = Math.min(horizon, timeAt(extLastBeat + Math.max(EXT_AHEAD_BEATS, lookahead / spb)));
      scheduleSeq(now, horizon);
      if (!external) scheduleClock(now, horizon);
      // Compensated parts are scheduled up to their lead past the horizon;
      // a tempo change must re-anchor beyond what they already queued.
      const maxLead = typeof router.maxLead === 'function' ? router.maxLead() : 0;
      frontier = Math.max(frontier, horizon + maxLead);
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
    // Steps queued ahead of the stop must not play after it.
    if (typeof router._cancelAfter === 'function') router._cancelAfter(now, 'seq');
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
    const now = timebase.now();
    extLastPulse = Math.max(extLastPulse, now);
    if (!playing || !external) return;
    // A pulse is heard about now (give or take the output latency). A time
    // seconds away means the clock mapping hiccuped; anchoring there would
    // push every step far into the future or drop them all as late.
    if (!Number.isFinite(time) || Math.abs(time - now) > 1) time = now;
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
  // A reordered track keeps its place in the bar and its tied note; a new
  // track joins on the next step of the grid; a removed one is dropped (the
  // engine releases what it was playing).
  unsubs.push(watchTracks(store, ({ perm, fresh, count: n }) => {
    ps = permute(ps, perm, fresh, freshState);
    for (let p = n; p < MAX_PARTS; p++) ps[p] = freshState();
    if (playing && anchored) {
      const b = Math.max(beatAt(Math.max(frontier, timebase.now())), 0);
      for (const i of fresh) {
        const seq = seqOf(i) || {};
        const rateIdx = clamp(Math.round(seq.rate ?? 3), 0, SEQ_RATES.length - 1);
        ps[i].rateIdx = rateIdx;
        ps[i].absStep = Math.ceil(b / SEQ_RATES[rateIdx].beats - 1e-9);
      }
    }
  }));
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

  /**
   * Audio time of the first `div`-beat grid line at or after audio time `from`
   * (swung like the sequencer when `swing`), or null while the transport is
   * not running on a grid. Used by the preview and Explore notes so they land
   * in time with the sequencer.
   */
  function nextGridTime(div = 0.25, from = timebase.now(), { swing = true } = {}) {
    if (!playing || !anchored || !(div > 0)) return null;
    const b = beatAt(from);
    const k = Math.ceil(b / div - 1e-9);
    const beat = k * div;
    return swing ? timeAt(swingBeat(beat, store.get('global.swing'))) : timeAt(beat);
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
    /** Seconds currently scheduled ahead (LOOKAHEAD, more after a stall). */
    lookahead: () => lookahead,
    beatAt: (time) => (anchored ? beatAt(time) : 0),
    /** Audio time of musical position `beat` (unswung), or null while not running on a grid. */
    timeAtBeat: (beat) => (playing && anchored && Number.isFinite(beat) ? timeAt(beat) : null),
    nextGridTime,
    /** Seconds per beat right now (the external clock's while following). */
    spb: () => (anchored ? spb : 60 / tempoNow()),
    dispose() { stopTimer(); locks.dispose(); for (const u of unsubs) u(); },
  };
}
