// Offline event rendering for bounces (music.renderEvents).
//
// Rather than re-implementing the sequencer, this runs a second router and
// transport on a private copy of the session, driven by a simulated clock,
// and records what they would send to the engine. That keeps swing, slides,
// ties, rates, triplets, arps and dot locks identical to live playback.
//
// Output: [{ time, msg }] sorted by time, beat 0 at time 0. `msg` is a
// worklet protocol message whose own `time` equals the event time:
//   { t: 'transport', playing: true, beatTime: 0, beat: 0, spb } at 0, so synced LFOs line up
//   { t: 'noteOn', part, note, vel, time } / { t: 'noteOff', part, note, time }
//   { t: 'params', part, p: { centerX, centerY }, time, ramp }    dot-lock glides (ramp in seconds)
// Every note that starts inside the render is released by its end, and
// nothing starts at or after the end.

import { NUM_PARTS, clamp } from '../core/params.js';
import { createStore } from '../core/store.js';
import { createTimebase } from './timing.js';
import { createRouter } from './router.js';
import { createTransport, START_DELAY } from './transport.js';
import { wrap01 } from './locks.js';

// Simulated scheduler period (s). It must stay below LOOKAHEAD (so each tick's
// horizon covers the next tick) and START_DELAY (so a held arp still lands on beat 0).
const STEP = 0.05;
const EPS = 1e-9;

const noTimers = {
  setInterval: () => 0, clearInterval: () => {},
  setTimeout: () => 0, clearTimeout: () => {},
};

const tidy = (v) => Math.round(v * 1e9) / 1e9;

/**
 * Render `bars` bars of the session in `store`. Options:
 *   parts   part indices to include (default all)
 *   held    (part) => [{ note, vel }] keys held or latched live; parts whose
 *           arpeggiator is on replay them so an arp hold ends up in the bounce
 *   random  RNG for the Random arp mode
 */
export function renderSessionEvents(store, bars = 4, { parts, held = null, random = Math.random } = {}) {
  const nBars = clamp(Math.round(Number(bars) || 4), 1, 512);
  const include = new Set((Array.isArray(parts) && parts.length ? parts : Array.from({ length: NUM_PARTS }, (_, i) => i))
    .map(Number).filter(p => Number.isInteger(p) && p >= 0 && p < NUM_PARTS));
  // A private copy of the session: the offline transport writes ui.playing and
  // the router subscribes to arp settings, none of which may touch the live app.
  const state = store.serialize();
  const off = createStore({ ...state, ui: { selectedPart: Math.round(store.get('ui.selectedPart') || 0) } });
  for (let p = 0; p < NUM_PARTS; p++) {
    if (!include.has(p) && off.get(`parts.${p}.seq`)) off.set(`parts.${p}.seq.enabled`, 0);
  }

  const clock = { t: 0 };
  const raw = [];
  let order = 0;
  const engine = {
    context: { get currentTime() { return clock.t; }, state: 'running' },
    noteOn(part, note, vel, time) { raw.push({ kind: 'on', part, note, vel, time, order: order++ }); },
    noteOff(part, note, time) { raw.push({ kind: 'off', part, note, time, order: order++ }); },
    allNotesOff() {}, panic() {}, bend() {}, wheel() {},
  };
  const timebase = createTimebase(engine, { perfNow: () => clock.t * 1000 });
  const glides = [];
  const lockPlayer = {
    schedule(p, step, lock, time, seconds) { glides.push({ part: p, x: lock.x, y: lock.y, time, ramp: Math.max(0, seconds), order: order++ }); },
    cancel() {}, cancelAll() {}, gliding: () => false, setRecord: () => false, isRecording: () => false, dispose() {},
  };
  const router = createRouter({ store: off, engine, timebase, timers: noTimers, random });
  const transport = createTransport({ store: off, engine: null, timebase, router, timers: noTimers, lockPlayer });
  router.setKick(() => {});

  // Arp hold (or keys still down): the arpeggiator keeps playing them, so the bounce does too.
  if (typeof held === 'function') {
    for (const p of include) {
      const arp = off.get(`parts.${p}.arp`) || {};
      if (!arp.mode) continue;
      let list = [];
      try { list = held(p) || []; } catch { list = []; }
      for (const e of list) if (e && Number.isFinite(e.note)) router.noteOn(p, e.note, Number.isFinite(e.vel) ? e.vel : 0.8, 'bounce');
    }
  }

  transport.play();
  const spb = 60 / clamp(Number(off.get('global.tempo')) || 120, 20, 400);
  const start = START_DELAY;            // where the transport anchors beat 0 when started at t = 0
  const end = start + nBars * 4 * spb;
  for (clock.t = 0; clock.t < end + STEP; clock.t += STEP) transport.tick();
  transport.dispose();
  router.dispose();

  // Notes: drop anything starting at or after the end, release everything by the end.
  raw.sort((a, b) => a.time - b.time || a.order - b.order);
  const events = [{ time: 0, msg: { t: 'transport', playing: true, beatTime: 0, beat: 0, spb } }];
  const sounding = new Map();
  const push = (time, msg) => events.push({ time, msg: { ...msg, time } });
  for (const e of raw) {
    if (!include.has(e.part)) continue;
    const key = e.part * 128 + e.note;
    const t = tidy(Math.max(0, e.time - start));
    if (e.kind === 'on') {
      if (e.time >= end - EPS) continue;
      sounding.set(key, (sounding.get(key) || 0) + 1);
      push(t, { t: 'noteOn', part: e.part, note: e.note, vel: e.vel });
    } else {
      const n = sounding.get(key) || 0;
      if (!n) continue;
      if (n > 1) sounding.set(key, n - 1); else sounding.delete(key);
      push(Math.min(t, tidy(end - start)), { t: 'noteOff', part: e.part, note: e.note });
    }
  }
  const last = tidy(end - start);
  for (const [key, n] of sounding) {
    for (let i = 0; i < n; i++) push(last, { t: 'noteOff', part: Math.floor(key / 128), note: key % 128 });
  }
  for (const g of glides) {
    if (!include.has(g.part) || g.time >= end - EPS) continue;
    const t = tidy(Math.max(0, g.time - start));
    events.push({ time: t, msg: { t: 'params', part: g.part, p: { centerX: wrap01(g.x), centerY: wrap01(g.y) }, time: t, ramp: tidy(Math.min(g.ramp, end - g.time)) } });
  }
  // Stable: same-time events keep scheduling order (a slide's next note-on before the old note-off).
  return events.sort((a, b) => a.time - b.time);
}
