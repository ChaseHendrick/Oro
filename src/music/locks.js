// Dot locks: a sequencer step can carry a spot on the map (lx, ly). When a
// locked step plays, the part's dot (centerX / centerY) glides there, so a
// pattern can walk the orbit between regions of the terrain in time with the
// music, the way a parameter lock works on a hardware step sequencer.
//
// Two halves:
//   * pure store edits (setStepLock, clearStepLock, clearLocks, lockCurrentDot)
//   * createLockPlayer(): the runtime that the transport feeds with every
//     locked step it schedules. It starts each glide when the step is heard
//     (same audio-time -> setTimeout alignment as the transport's 'step'
//     event), animates it at about 60 Hz with store writes tagged
//     { source: 'lock' }, and records dot moves into the sounding step while
//     ui.lockRecord is on.
//
// The user always wins: any other write to the dot cancels the glide in
// flight, and locks that come due while the user is still moving the dot are
// skipped (see USER_HOLD_MS).

import { NUM_PARTS, SEQ_STEPS, defaultStep, clamp } from '../core/params.js';

export const LOCK_SOURCE = 'lock';
export const FRAME_MS = 16;          // glide update period (about 60 Hz)
// A lock that comes due within this long after the user last moved the dot is
// skipped, so a drag (or a knob turn) is never yanked away mid-gesture. A drag
// writes at 30-60 Hz, so this only bites while the user is actually moving it.
export const USER_HOLD_MS = 250;
// Sources that count as "the user moved the dot" for lock recording.
const RECORD_SOURCES = new Set(['visual', 'ui', 'midi']);
// Writers that move the dot on their own (marble physics, drift, tours) and
// should neither cancel glides nor be recorded. The visuals currently tag every
// write 'visual', so in non-Pin dot modes 'visual' is treated as simulated too
// (see isUserMove). A write may also say so explicitly with meta.user.
const SIM_SOURCES = new Set([LOCK_SOURCE, 'physics', 'sim']);
const META = Object.freeze({ source: LOCK_SOURCE });

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Wrap into [0, 1): the map is a torus. */
export function wrap01(v) {
  const w = v - Math.floor(v);
  return w >= 1 ? 0 : w;
}

/** Signed shortest way round the torus from `from` to `to`, in [-0.5, 0.5]. */
export function wrapDelta(from, to) {
  const d = to - from;
  return d - Math.round(d);
}

/** Gentle ease-in-out (smoothstep): starts and lands softly, no overshoot. */
export function easeInOut(k) {
  const x = clamp(k, 0, 1);
  return x * x * (3 - 2 * x);
}

// Store values are kept tidy (six decimals, like the visuals write them) and
// strictly inside [0, 1).
function tidy(v) {
  const r = Math.round(wrap01(v) * 1e6) / 1e6;
  return r >= 1 ? 0 : r;
}

// 'sel' (or nothing) means the selected part, like the pattern tools.
function partIndex(store, part) {
  const p = part === 'sel' || part == null ? store.get('ui.selectedPart') || 0 : Number(part);
  return Number.isInteger(p) && p >= 0 && p < NUM_PARTS ? p : null;
}

const validStep = (i) => Number.isInteger(i) && i >= 0 && i < SEQ_STEPS;
const stepPath = (p, i) => `parts.${p}.seq.steps.${i}`;

function writeStep(store, p, i, fields) {
  const cur = store.get(stepPath(p, i)) || {};
  const next = { ...defaultStep(), ...cur, ...fields };
  store.set(stepPath(p, i), next, { source: 'music' });
  return next;
}

/** Lock `step` of `part` ('sel' = selected) to map position (x, y). Returns the step or null. */
export function setStepLock(store, part, step, x, y) {
  const p = partIndex(store, part);
  const i = Number(step);
  if (p == null || !validStep(i) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return writeStep(store, p, i, { lock: 1, lx: tidy(x), ly: tidy(y) });
}

/** Remove the lock from one step (the spot resets to the default too). */
export function clearStepLock(store, part, step) {
  const p = partIndex(store, part);
  const i = Number(step);
  if (p == null || !validStep(i)) return null;
  const d = defaultStep();
  return writeStep(store, p, i, { lock: d.lock, lx: d.lx, ly: d.ly });
}

/** Remove every lock from a part's pattern, leaving the notes alone. */
export function clearLocks(store, part) {
  const p = partIndex(store, part);
  if (p == null) return;
  const steps = store.get(`parts.${p}.seq.steps`);
  if (!Array.isArray(steps)) return;
  const d = defaultStep();
  store.set(`parts.${p}.seq.steps`, steps.map(s => ({ ...s, lock: d.lock, lx: d.lx, ly: d.ly })), { source: 'music' });
}

/** Lock `step` to wherever the part's dot is right now. */
export function lockCurrentDot(store, part, step) {
  const p = partIndex(store, part);
  if (p == null) return null;
  const x = num(store.get(`parts.${p}.params.centerX`), 0.5);
  const y = num(store.get(`parts.${p}.params.centerY`), 0.5);
  return setStepLock(store, p, step, x, y);
}

/** `steps` with the lock fields of `old` carried over step by step (used by the pattern randomiser). */
export function keepLocks(steps, old) {
  if (!Array.isArray(old)) return steps;
  return steps.map((s, i) => {
    const o = old[i];
    if (!o) return s;
    return { ...s, lock: o.lock ? 1 : 0, lx: num(o.lx, s.lx), ly: num(o.ly, s.ly) };
  });
}

/**
 * The runtime half. `currentStep(part)` -> index of the step being heard (or
 * -1) and `isPlaying()` come from the transport.
 */
export function createLockPlayer({ store, timebase, timers, currentStep = () => -1, isPlaying = () => false }) {
  const glides = new Array(NUM_PARTS).fill(null);
  const pending = Array.from({ length: NUM_PARTS }, () => new Set());
  const lastUser = new Array(NUM_PARTS).fill(-Infinity);
  const cx = (p) => `parts.${p}.params.centerX`;
  const cy = (p) => `parts.${p}.params.centerY`;

  function write(p, x, y) {
    store.batch(() => {
      store.set(cx(p), tidy(x), META);
      store.set(cy(p), tidy(y), META);
    });
  }

  function stopGlide(p) {
    const g = glides[p];
    if (!g) return;
    glides[p] = null;
    if (g.timer != null) timers.clearTimeout(g.timer);
  }

  function cancelPending(p) {
    for (const id of pending[p]) timers.clearTimeout(id);
    pending[p].clear();
  }

  /** Stop part `p`'s glide and forget its queued locks (all parts when omitted). */
  function cancel(p) {
    if (p == null) { for (let i = 0; i < NUM_PARTS; i++) cancel(i); return; }
    stopGlide(p);
    cancelPending(p);
  }

  function frame(p, g) {
    if (glides[p] !== g) return;
    g.timer = null;
    // Progress comes from the clock, not from counting frames, so a late timer
    // (busy main thread, background tab) catches up instead of dragging the glide out.
    const k = (timebase.perfNow() - g.t0) / g.ms;
    if (k >= 1) {
      glides[p] = null;
      write(p, g.tx, g.ty);
      return;
    }
    const e = easeInOut(k);
    write(p, g.fx + g.dx * e, g.fy + g.dy * e);
    g.timer = timers.setTimeout(() => frame(p, g), FRAME_MS);
  }

  function start(p, lock, t0, seconds) {
    if (timebase.perfNow() - lastUser[p] < USER_HOLD_MS) return;
    stopGlide(p);
    const fx = wrap01(num(store.get(cx(p)), 0.5));
    const fy = wrap01(num(store.get(cy(p)), 0.5));
    const tx = wrap01(lock.x), ty = wrap01(lock.y);
    const dx = wrapDelta(fx, tx), dy = wrapDelta(fy, ty);
    const ms = Math.max(0, seconds * 1000);
    if (ms < 1 || (Math.abs(dx) < 1e-7 && Math.abs(dy) < 1e-7)) { write(p, tx, ty); return; }
    const g = { fx, fy, dx, dy, tx, ty, t0, ms, timer: null };
    glides[p] = g;
    frame(p, g);
  }

  /**
   * A locked step of part `p` plays at audio time `time`: glide the dot to
   * lock {x, y} over `seconds`, starting when that moment is heard.
   */
  function schedule(p, step, lock, time, seconds) {
    if (!(p >= 0 && p < NUM_PARTS) || !lock) return;
    const t0 = timebase.audioToPerf(time);
    const delay = timebase.heardDelayMs(time);
    if (delay < 4) { start(p, lock, t0, seconds); return; }
    let id = null;
    id = timers.setTimeout(() => { pending[p].delete(id); start(p, lock, t0, seconds); }, delay);
    pending[p].add(id);
  }

  // ------------------------------------------------------------- the user

  function dotMode(p) {
    return Math.round(num(store.get(`parts.${p}.dot.mode`), 0));
  }

  /** Did a person move this dot (as opposed to a lock, the marble or a tour)? */
  function isUserMove(p, meta) {
    const src = meta && meta.source;
    if (src === LOCK_SOURCE) return false;
    if (meta && typeof meta.user === 'boolean') return meta.user;
    if (SIM_SOURCES.has(src)) return false;
    // In Pin mode only a pointer moves the dot; in the other modes the visuals'
    // simulation writes the same source many times a second.
    if (src === 'visual') return dotMode(p) === 0;
    return true;
  }

  const isRecording = () => !!store.get('ui.lockRecord');

  function setRecord(on) {
    store.set('ui.lockRecord', on ? 1 : 0, { source: 'music' });
    return isRecording();
  }

  function record(p, meta) {
    if (!isRecording() || !isPlaying()) return;
    if (!RECORD_SOURCES.has(meta && meta.source)) return;
    if (p !== Math.round(num(store.get('ui.selectedPart'), 0))) return;
    const i = currentStep(p);
    if (!validStep(i)) return;
    const lx = tidy(num(store.get(cx(p)), 0.5));
    const ly = tidy(num(store.get(cy(p)), 0.5));
    const st = store.get(stepPath(p, i)) || {};
    if (st.lock && st.lx === lx && st.ly === ly) return;
    const seq = store.get(`parts.${p}.seq`) || {};
    const len = clamp(Math.round(num(seq.length, SEQ_STEPS)), 1, SEQ_STEPS);
    const hasNotes = Array.isArray(seq.steps) && seq.steps.slice(0, len).some(s => s && s.on);
    store.batch(() => {
      writeStep(store, p, i, { lock: 1, lx, ly });
      // An empty, switched-off pattern is switched on so the recorded motion
      // plays back. A pattern with notes the user switched off stays off.
      if (!seq.enabled && !hasNotes) store.set(`parts.${p}.seq.enabled`, 1, { source: 'music' });
    });
  }

  function onDot(p, path, meta) {
    if (meta && meta.source === LOCK_SOURCE) return;
    if (path !== cx(p) && path !== cy(p)) {
      // The whole part (or session) was replaced: a patch or scene load, an
      // undo. Whatever was gliding belongs to the old state.
      cancel(p);
      return;
    }
    if (!isUserMove(p, meta)) return;
    lastUser[p] = timebase.perfNow();
    stopGlide(p);
    record(p, meta);
  }

  const unsubs = [];
  for (let p = 0; p < NUM_PARTS; p++) {
    unsubs.push(store.subscribe(cx(p), (path, v, meta) => onDot(p, path, meta)));
    unsubs.push(store.subscribe(cy(p), (path, v, meta) => onDot(p, path, meta)));
  }

  return {
    schedule,
    cancel,
    cancelAll: () => cancel(),
    gliding: (p) => !!glides[p],
    isUserMove,
    setRecord,
    isRecording,
    dispose() {
      cancel();
      for (const u of unsubs) u();
      unsubs.length = 0;
    },
  };
}
