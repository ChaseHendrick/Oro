// MIDI to pedals: CC / Program Change / bypass / tap for the profiles in
// profiles.js, with the rules from docs/PEDALS.md:
//   * CCs are sent only when the 7-bit value changes;
//   * at most about 100 messages per second per pedal, with coalescing, because
//     the Purr-ting, Xero and Nucleo share one 31.25 kbaud TRS cable (about 1000
//     three-byte messages per second in total) and an LFO must not starve a tap;
//   * every message carries a timestamp (Web MIDI `output.send(bytes, ms)`), so
//     scheduled changes land on time even when the main thread is busy.
//
// Nothing here touches Web MIDI directly: the caller passes `send(bytes, timeMs)`
// (for example a wrapper around a MIDIOutput), which keeps this unit-testable
// and lets the integrator route pedal traffic to whichever port reaches the MPC.
//
// Times are milliseconds on the same clock as `now()` (performance.now() by
// default, the Web MIDI timestamp base).

import {
  getProfile, findControl, encodeControl, ccBytes, pcBytes, engageControl, tapControl,
  checkProgram, withChannel, PEDAL_PROFILES, decodeContinuous, decodeSwitch,
} from './profiles.js';

export const DEFAULT_RATE_HZ = 100;
export const DEFAULT_LOOKAHEAD_MS = 20;
// One-off messages (tap, transport, presets, switches) are never coalesced, so
// they can go to Web MIDI well ahead and let its scheduler keep time: a busy
// main thread then cannot make a tap late.
export const DEFAULT_EXACT_LOOKAHEAD_MS = 250;

// Same shapes as the synth's Links curves (LINK_CURVES in src/core/params.js),
// applied to a 0..1 source: Linear y = x, Soft y = x^2, Hard y = sqrt(x).
export const MAP_CURVES = Object.freeze(['Linear', 'Soft', 'Hard']);

/** Orograph values that can drive pedal controls. `bipolar` sources run -1..1. */
export const PEDAL_SOURCES = Object.freeze([
  { id: 'macro1', label: 'Macro 1', bipolar: false },
  { id: 'macro2', label: 'Macro 2', bipolar: false },
  { id: 'macro3', label: 'Macro 3', bipolar: false },
  { id: 'macro4', label: 'Macro 4', bipolar: false },
  { id: 'lfo1', label: 'Pedal LFO 1', bipolar: true },
  { id: 'lfo2', label: 'Pedal LFO 2', bipolar: true },
  { id: 'env1', label: 'Part 1 envelope', bipolar: false },
  { id: 'env2', label: 'Part 2 envelope', bipolar: false },
  { id: 'env3', label: 'Part 3 envelope', bipolar: false },
  { id: 'env4', label: 'Part 4 envelope', bipolar: false },
  { id: 'guitar', label: 'Guitar level', bipolar: false },
].map(Object.freeze));
const SOURCE_MAP = Object.fromEntries(PEDAL_SOURCES.map(s => [s.id, s]));

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(Number(v) || 0, 0, 1);

function curveIndex(curve) {
  if (typeof curve === 'number') return clamp(Math.round(curve), 0, MAP_CURVES.length - 1);
  const i = MAP_CURVES.findIndex(n => n.toLowerCase() === String(curve || '').toLowerCase());
  return i < 0 ? 0 : i;
}

/** Apply a mapping curve to 0..1. */
export function shapeCurve(x, curve = 0) {
  const u = clamp01(x);
  switch (curveIndex(curve)) {
    case 1: return u * u;
    case 2: return Math.sqrt(u);
    default: return u;
  }
}

/**
 * Source value -> pedal control value 0..1 for one mapping.
 * Bipolar sources (-1..1) are first folded to 0..1. `min > max` inverts.
 */
export function mapValue(value, { min = 0, max = 1, curve = 0, bipolar = false } = {}) {
  const v = Number(value) || 0;
  const u = bipolar ? (v + 1) / 2 : v;
  return clamp01(min + (max - min) * shapeCurve(u, curve));
}

export const LFO_SHAPES = Object.freeze(['sine', 'triangle', 'saw', 'square', 'random']);

/**
 * A main-thread LFO for pedal CCs. Free (rateHz) or tempo-synced (`beats` per
 * cycle). While the rate stays the same, valueAt() is a pure function of time,
 * so values can be computed slightly ahead and sent with a timestamp. When the
 * rate, the tempo or `phase` changes, the cycle count is re-anchored at that
 * moment so the wave carries on from where it was instead of jumping.
 * `depth` (0..1) scales the output around the middle: 1 sweeps the whole
 * min..max range of a mapping, 0.5 the middle half.
 * Fields (shape, rateHz, beats, phase, depth) may be changed in place.
 */
export function createLfoSource({ shape = 'sine', rateHz = 0.5, beats = 0, phase = 0, depth = 1, seed = 1 } = {}) {
  const lfo = { shape, rateHz, beats, phase, depth };
  const hash = (n) => {
    let x = (Math.floor(n) * 374761393 + seed * 668265263) | 0;
    x = Math.imul(x ^ (x >>> 13), 1274126177);
    return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
  };
  // Cycles = anchor.cycles + (sec - anchor.sec) * hz. The first anchor is
  // (0, phase), which is the plain formula sec * hz + phase.
  let anchor = null;
  const hzFor = (bpm) => {
    const hz = lfo.beats > 0 ? (clamp(Number(bpm) || 120, 1, 1000) / 60) / lfo.beats : Number(lfo.rateHz) || 0;
    return Number.isFinite(hz) ? hz : 0;
  };
  lfo.cyclesAt = (sec, bpm = 120) => {
    const hz = hzFor(bpm);
    if (!anchor) anchor = { sec: 0, cycles: lfo.phase, hz, phase: lfo.phase };
    if (hz !== anchor.hz || lfo.phase !== anchor.phase) {
      const at = anchor.cycles + (sec - anchor.sec) * anchor.hz;
      anchor = { sec, cycles: at + (lfo.phase - anchor.phase), hz, phase: lfo.phase };
    }
    return anchor.cycles + (sec - anchor.sec) * hz;
  };
  /** -1..1 (times depth) at `sec` seconds (any clock), `bpm` for synced LFOs. */
  lfo.valueAt = (sec, bpm = 120) => {
    const c = lfo.cyclesAt(sec, bpm);
    const p = c - Math.floor(c);
    const d = clamp(Number.isFinite(lfo.depth) ? lfo.depth : 1, 0, 1);
    let v;
    switch (lfo.shape) {
      case 'triangle': v = p < 0.5 ? 4 * p - 1 : 3 - 4 * p; break;
      case 'saw': v = 2 * p - 1; break;
      case 'square': v = p < 0.5 ? 1 : -1; break;
      case 'random': v = hash(c) * 2 - 1; break;
      default: v = Math.sin(2 * Math.PI * p);
    }
    return v * d;
  };
  return lfo;
}

/**
 * @param {object} o
 * @param {(bytes: number[], timeMs: number) => void} o.send
 * @param {() => number} [o.now] ms clock (default performance.now)
 * @param {number} [o.rateHz] messages per second per pedal for continuous controls
 * @param {number} [o.lookaheadMs] hand continuous CCs to `send` this far ahead of their slot
 * @param {number} [o.exactLookaheadMs] hand one-off messages over this far ahead
 * @param {Array<string|object|{profile, channel, id}>} [o.pedals] defaults to the four documented pedals
 * @param {boolean} [o.autoPump] run the dispatcher on timers (false: call pump() yourself)
 * @param {(fn: Function, ms: number) => any} [o.setTimer]
 * @param {(handle: any) => void} [o.clearTimer]
 */
export function createPedalMidi({
  send,
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  rateHz = DEFAULT_RATE_HZ,
  lookaheadMs = DEFAULT_LOOKAHEAD_MS,
  exactLookaheadMs = DEFAULT_EXACT_LOOKAHEAD_MS,
  pedals: initialPedals = Object.keys(PEDAL_PROFILES),
  autoPump = true,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
} = {}) {
  if (typeof send !== 'function') throw new Error('createPedalMidi needs a send(bytes, timeMs) function');
  const interval = 1000 / clamp(Number(rateHz) || DEFAULT_RATE_HZ, 1, 1000);
  const pedals = new Map();
  const mappings = new Map();
  const lfos = new Map();
  const listeners = new Set();
  const stats = { sent: 0, coalesced: 0, unchanged: 0, errors: 0 };
  let seq = 0;
  let timer = null;
  let timerAt = Infinity;
  let ticker = null;
  let lastError = null;
  let mapSeq = 0;

  function emit(e) { for (const fn of [...listeners]) { try { fn(e); } catch { /* listener bug */ } } }

  // ------------------------------------------------------------ pedals

  function addPedal(spec, opts = {}) {
    const s = typeof spec === 'string' || (spec && spec.controls) ? { profile: spec, ...opts } : { ...spec, ...opts };
    let profile = getProfile(s.profile);
    if (!profile) return null;
    if (s.channel != null) profile = withChannel(profile, s.channel);
    const id = String(s.id || profile.id);
    pedals.set(id, {
      id, profile, queue: [], lastSlot: -Infinity,
      sent: new Map(),      // key -> 7-bit value the pedal should have
      values: new Map(),    // controlId -> last requested value (0..1 or boolean)
      program: null, sentCount: 0,
    });
    return id;
  }
  for (const p of initialPedals) addPedal(p);

  function removePedal(id) { return pedals.delete(id); }

  function setChannel(id, channel) {
    const p = pedals.get(id);
    const ch = Math.round(Number(channel));
    if (!p || !(ch >= 1 && ch <= 16)) return false;
    p.profile = withChannel(p.profile, ch);
    p.sent.clear(); // a different channel is a different listener
    return true;
  }

  // ------------------------------------------------------------ queue

  // The value the pedal will hold at time t, as far as queued-but-unsent
  // messages tell: a Program Change in between makes it unknown.
  function priorValue(p, key, t) {
    let v = p.sent.get(key);
    for (const e of p.queue) {
      if (e.time > t) break;
      if (e.kind === 'pc') v = undefined;
      else if (e.key === key) v = e.value7;
    }
    return v;
  }

  function insert(p, entry) {
    entry.seq = seq++;
    let i = p.queue.length;
    while (i > 0 && (p.queue[i - 1].time > entry.time)) i--;
    p.queue.splice(i, 0, entry);
    wake();
  }

  function enqueueCC(p, control, value7, t, { force = false, exact = false } = {}) {
    const key = 'cc:' + control.cc;
    const bytes = ccBytes(p.profile.channel, control.cc, value7);
    if (exact) {
      // Switches and triggers replace any pending smooth change of the same control.
      p.queue = p.queue.filter(e => !(e.key === key && !e.exact && e.time <= t));
      if (!force && priorValue(p, key, t) === value7) { stats.unchanged++; return true; }
      insert(p, { key, kind: 'cc', bytes, value7, time: t, exact: true, force });
      return true;
    }
    const nowMs = now();
    const pending = p.queue.find(e => e.key === key && !e.exact && (Math.abs(e.time - t) < interval || (e.time <= nowMs && t <= nowMs)));
    if (pending) {
      stats.coalesced++;
      pending.value7 = value7;
      pending.bytes = bytes;
      // A due change keeps its place in line (first come, first served across
      // controls); only a change scheduled for later moves to its new time.
      if (t > pending.time && t > nowMs) { p.queue.splice(p.queue.indexOf(pending), 1); pending.time = t; insert(p, pending); }
      // Back to what the pedal already has: nothing left to send.
      if (!force && !pending.force && priorValue(p, key, pending.time - 1e-9) === value7) {
        p.queue.splice(p.queue.indexOf(pending), 1);
      }
      return true;
    }
    if (!force && priorValue(p, key, t) === value7) { stats.unchanged++; return true; }
    insert(p, { key, kind: 'cc', bytes, value7, time: t, exact: false, force });
    return true;
  }

  function dispatch(p, e, ts) {
    try {
      send(e.bytes, ts);
      stats.sent++;
      p.sentCount++;
      if (e.kind === 'pc') p.sent.clear(); // a preset recall moves the pedal's knobs
      else if (e.key) p.sent.set(e.key, e.value7);
      emit({ type: 'sent', pedal: p.id, bytes: e.bytes, time: ts });
    } catch (err) {
      stats.errors++;
      lastError = String((err && err.message) || err);
      emit({ type: 'error', pedal: p.id, message: lastError });
    }
  }

  /** Hand every due message to `send`. Returns the ms time of the next wake-up (Infinity when idle). */
  function pump(at = now()) {
    let next = Infinity;
    const horizon = at + lookaheadMs;
    const exactHorizon = at + Math.max(lookaheadMs, exactLookaheadMs);
    for (const p of pedals.values()) {
      // 1. Exact messages (tap, transport, switches, presets) go at their own
      //    time and never wait behind a rate-limited CC.
      for (let i = 0; i < p.queue.length;) {
        const e = p.queue[i];
        if (e.time > exactHorizon) break; // the queue is sorted by time
        if (!e.exact) { i++; continue; }
        p.queue.splice(i, 1);
        if (e.kind === 'pc') {
          // Smooth changes meant for before the preset change are overwritten by it anyway.
          const before = p.queue.length;
          p.queue = p.queue.filter(x => x.exact || x.time > e.time || (x.time === e.time && x.seq > e.seq));
          i -= before - p.queue.length;
          if (i < 0) i = 0;
        }
        // Not counted against the CC slots: they are rare, and counting one
        // handed over 250 ms early would hold every CC back until then.
        dispatch(p, e, Math.max(e.time, at));
      }
      // 2. Continuous CCs: one per slot, slots at least `interval` apart.
      for (;;) {
        const idx = p.queue.findIndex(x => !x.exact);
        if (idx < 0) break;
        const e = p.queue[idx];
        let slot = Math.max(e.time, p.lastSlot + interval);
        if (slot < at) slot = at;
        if (slot > horizon) { next = Math.min(next, slot - lookaheadMs); break; }
        p.queue.splice(idx, 1);
        if (!e.force && p.sent.get(e.key) === e.value7) { stats.unchanged++; continue; }
        dispatch(p, e, slot);
        p.lastSlot = slot;
      }
      const exact = p.queue.find(x => x.exact);
      if (exact) next = Math.min(next, exact.time - Math.max(lookaheadMs, exactLookaheadMs));
    }
    return next;
  }

  function wake() {
    if (!autoPump) return;
    const next = pump();
    if (next === Infinity) return;
    if (timer != null && timerAt <= next) return;
    if (timer != null) clearTimer(timer);
    timerAt = next;
    timer = setTimer(() => { timer = null; timerAt = Infinity; wake(); }, Math.max(1, next - now()));
  }

  // ------------------------------------------------------------ actions

  /** Continuous or switch control to `value` (0..1, or boolean for switches). */
  function set(pedalId, controlId, value, { time, force = false } = {}) {
    const p = pedals.get(pedalId);
    const control = p && findControl(p.profile, controlId);
    if (!control) return false;
    if (control.kind === 'trigger') return trigger(pedalId, controlId, { time }).ok;
    const t = time != null ? time : now();
    const value7 = encodeControl(control, value);
    p.values.set(control.id, control.kind === 'switch' ? !!(typeof value === 'number' ? value >= 0.5 : value) : clamp01(value));
    return enqueueCC(p, control, value7, t, { force, exact: control.kind === 'switch' });
  }

  /** Program Change; `program` is the raw data byte, checked against the profile's range. */
  function programChange(pedalId, program, { time } = {}) {
    const p = pedals.get(pedalId);
    if (!p) return { ok: false, reason: 'That pedal is not set up.' };
    const check = checkProgram(p.profile, program);
    if (!check.ok) return check;
    const t = time != null ? time : now();
    p.program = Number(program);
    insert(p, { key: null, kind: 'pc', bytes: pcBytes(p.profile.channel, program), time: t, exact: true, force: true });
    return { ok: true, reason: null };
  }

  /**
   * Bypass (true) or engage (false) the effect, through the pedal's engage
   * switch with its own encoding (the Purr-ting sends 0 for on). Always sent:
   * the owner may have stomped the pedal since we last told it anything.
   */
  function bypass(pedalId, bypassed, { time } = {}) {
    const p = pedals.get(pedalId);
    if (!p) return { ok: false, reason: 'That pedal is not set up.' };
    const control = engageControl(p.profile);
    if (!control) return { ok: false, reason: `${p.profile.name} has no documented bypass message, so Orograph cannot switch it.` };
    const t = time != null ? time : now();
    p.values.set(control.id, !bypassed);
    enqueueCC(p, control, encodeControl(control, !bypassed), t, { force: true, exact: true });
    return { ok: true, reason: null, unconfirmed: control.encodingVerified === false };
  }

  /** Effect on (true) or off (false). Same as bypass(id, !on). */
  function engage(pedalId, on, opts) { return bypass(pedalId, !on, opts); }

  /** Momentary control (tap, looper transport). Sent exactly at `time`, never coalesced. */
  function trigger(pedalId, controlId, { time } = {}) {
    const p = pedals.get(pedalId);
    const control = p && findControl(p.profile, controlId);
    if (!control) return { ok: false, reason: 'That control is not part of this pedal.' };
    const t = time != null ? time : now();
    enqueueCC(p, control, encodeControl(control, 1), t, { force: true, exact: true });
    return { ok: true, reason: null };
  }

  function tap(pedalId, opts) {
    const p = pedals.get(pedalId);
    const control = p && tapControl(p.profile);
    if (!control) return { ok: false, reason: p ? `${p.profile.name} has no tap tempo message.` : 'That pedal is not set up.' };
    return trigger(pedalId, control.id, opts);
  }

  /** Schedule `taps` taps at `bpm`, starting at `startMs`. Returns the tap times. */
  function tapTempo(pedalId, bpm, { taps = 4, startMs } = {}) {
    const b = Number(bpm);
    if (!(b >= 20 && b <= 400)) return { ok: false, reason: 'Tap tempo needs a tempo between 20 and 400 BPM.', times: [] };
    const start = startMs != null ? startMs : now();
    const times = [];
    for (let i = 0; i < Math.max(1, Math.round(taps)); i++) {
      const t = start + i * 60000 / b;
      const r = tap(pedalId, { time: t });
      if (!r.ok) return { ...r, times };
      times.push(t);
    }
    return { ok: true, reason: null, times };
  }

  /** Forget what the pedal holds (power cycle, preset loaded by foot); the next set() always sends. */
  function invalidate(pedalId) {
    const list = pedalId ? [pedals.get(pedalId)].filter(Boolean) : [...pedals.values()];
    for (const p of list) p.sent.clear();
  }

  /** Re-send every value Orograph has asked for (after a pedal was power-cycled). */
  function refresh(pedalId, { time } = {}) {
    const p = pedals.get(pedalId);
    if (!p) return false;
    for (const [controlId, v] of p.values) {
      const c = findControl(p.profile, controlId);
      if (c && c.kind !== 'trigger') enqueueCC(p, c, encodeControl(c, v), time != null ? time : now(), { force: true, exact: c.kind === 'switch' });
    }
    return true;
  }

  /** Drop everything not yet handed to `send` (panic / stop). */
  function clearQueue(pedalId) {
    for (const p of pedals.values()) if (!pedalId || p.id === pedalId) p.queue.length = 0;
  }

  /** What Orograph has asked each pedal for, to store with scenes. */
  function getState() {
    const out = {};
    for (const p of pedals.values()) {
      out[p.id] = { profile: p.profile.id, channel: p.profile.channel, program: p.program, values: Object.fromEntries(p.values) };
    }
    return out;
  }

  /** Recall a getState() snapshot: Program Change first, then every value (forced). */
  function applyState(state, { time } = {}) {
    if (!state || typeof state !== 'object') return false;
    const t = time != null ? time : now();
    for (const [id, s] of Object.entries(state)) {
      const p = pedals.get(id);
      if (!p || !s) continue;
      if (s.program != null) programChange(id, s.program, { time: t });
      for (const [controlId, v] of Object.entries(s.values || {})) set(id, controlId, v, { time: t, force: true });
    }
    return true;
  }

  /** The last value read back from a 7-bit CC, for showing pedal state when it echoes CCs. */
  function decode(pedalId, controlId, value7) {
    const p = pedals.get(pedalId);
    const c = p && findControl(p.profile, controlId);
    if (!c) return null;
    return c.kind === 'switch' ? decodeSwitch(value7, c) : decodeContinuous(value7, c);
  }

  // ------------------------------------------------------------ mapping layer

  /**
   * Route an Orograph source to a pedal control.
   * @param {{source: string, pedal: string, control: string, min?: number, max?: number, curve?: number|string}} m
   * @returns {string|null} mapping id
   */
  function map(m) {
    if (!m || (!SOURCE_MAP[m.source] && !lfos.has(m.source))) return null;
    const p = pedals.get(m.pedal);
    const control = p && findControl(p.profile, m.control);
    if (!control || control.kind === 'trigger') return null;
    const id = m.id || `map${++mapSeq}`;
    const src = SOURCE_MAP[m.source];
    mappings.set(id, {
      id, source: m.source, pedal: m.pedal, control: control.id,
      min: clamp01(m.min ?? 0), max: clamp01(m.max ?? 1), curve: curveIndex(m.curve ?? 0),
      bipolar: src ? src.bipolar : true,
    });
    return id;
  }
  function unmap(id) { return mappings.delete(id); }
  function clearMappings() { mappings.clear(); }
  function listMappings() { return [...mappings.values()].map(m => ({ ...m })); }

  /** Push a source value; every mapping from that source updates its pedal control. */
  function input(source, value, { time } = {}) {
    let n = 0;
    for (const m of mappings.values()) {
      if (m.source !== source) continue;
      if (set(m.pedal, m.control, mapValue(value, m), { time })) n++;
    }
    return n;
  }

  /** Macros from the store (global.macro1..4) drive their mappings. Returns an unsubscribe function. */
  function bindStore(store, { initial = true } = {}) {
    if (!store || typeof store.subscribe !== 'function') return () => {};
    const last = {};
    const read = () => {
      for (let i = 1; i <= 4; i++) {
        const v = Number(store.get(`global.macro${i}`));
        if (Number.isFinite(v) && v !== last[i]) { last[i] = v; input(`macro${i}`, v); }
      }
    };
    if (initial) read();
    return store.subscribe('global', read);
  }

  /** Register a pedal LFO (see createLfoSource) under a source id such as 'lfo1'. */
  function addLfo(id, lfo, { bpm = () => 120 } = {}) {
    if (!id || !lfo || typeof lfo.valueAt !== 'function') return false;
    lfos.set(id, { lfo, bpm });
    return true;
  }
  function removeLfo(id) { return lfos.delete(id); }

  /**
   * Evaluate the LFOs slightly ahead (lookahead) and push their values with that
   * timestamp, so the CC stream is as steady as the MIDI scheduler, not the timer.
   */
  function tick(at = now()) {
    const t = at + lookaheadMs;
    for (const [id, { lfo, bpm }] of lfos) {
      const b = typeof bpm === 'function' ? Number(bpm()) || 120 : Number(bpm) || 120;
      input(id, lfo.valueAt(t / 1000, b), { time: t });
    }
    return pump(at);
  }

  function start(periodMs = interval) {
    if (ticker != null) return;
    const loop = () => { tick(); ticker = setTimer(loop, periodMs); };
    ticker = setTimer(loop, periodMs);
  }
  function stop() {
    if (ticker != null) clearTimer(ticker);
    ticker = null;
  }

  function dispose() {
    stop();
    if (timer != null) clearTimer(timer);
    timer = null;
    clearQueue();
    listeners.clear();
  }

  return {
    get rateHz() { return 1000 / interval; },
    get intervalMs() { return interval; },
    get lastError() { return lastError; },
    addPedal, removePedal, setChannel,
    pedals: () => [...pedals.values()].map(p => ({ id: p.id, name: p.profile.name, channel: p.profile.channel, profile: p.profile, pending: p.queue.length, sent: p.sentCount })),
    profile: (id) => (pedals.get(id) || {}).profile || null,
    set, programChange, bypass, engage, trigger, tap, tapTempo,
    invalidate, refresh, clearQueue, getState, applyState, decode,
    map, unmap, clearMappings, mappings: listMappings, input, bindStore,
    addLfo, removeLfo, tick, start, stop,
    pump,
    stats: () => ({ ...stats, pending: [...pedals.values()].reduce((n, p) => n + p.queue.length, 0) }),
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    dispose,
  };
}
