// Note router: turns key presses from the on-screen keyboard, MIDI and the
// computer keyboard into engine notes. Handles Selected/Layer key modes, the
// sustain pedal and a per-part arpeggiator.
//
// The arpeggiator is clocked by the transport's scheduler (see transport.js):
// with the transport stopped it free-runs from the first key press, and while
// the transport plays it locks to the bar grid so it stays in time with the
// sequencer and with external clock.

import { NUM_PARTS, SEQ_RATES, clamp } from '../core/params.js';
import { createEmitter } from './emitter.js';

export const ARP = { OFF: 0, UP: 1, DOWN: 2, UPDOWN: 3, RANDOM: 4, PLAYED: 5, CHORD: 6 };
export const MIN_GAP = 0.003;      // seconds kept between a note-off and the next note-on of the same voice
export const LATE_WINDOW = 0.04;   // a grid step missed by less than this still plays (immediately)
// Notes of a chord arrive a few ms apart over MIDI; wait this long before the
// first arp step so Down/Chord modes see the whole chord.
export const GATHER_MS = 8;

const SOURCES_WITHOUT_ROUTE = new Set(['seq', 'arp']);

export function createRouter({ store, engine, timebase, timers, random = Math.random }) {
  const emitter = createEmitter();
  let kick = () => {};
  let order = 0;
  // `${source}:${note}` -> parts the note was sent to, so a note-off reaches the
  // same parts even if the key mode or selected part changed in between.
  const routes = new Map();

  const parts = Array.from({ length: NUM_PARTS }, () => ({
    down: new Map(),       // physically held keys: note -> { note, vel, order, sources:Set }
    sustainOn: false,
    sustained: new Map(),  // released while the pedal is down: note -> { note, vel, order }
    latched: [],           // arp hold: [{ note, vel, order }]
    sounding: new Map(),   // notes this router started directly (arp off): note -> vel
    cfgOn: false,
    cfgHold: false,
    arp: freshArp(),
  }));

  function freshArp() {
    return { running: false, index: 0, nextTime: null, nextBeat: null, pendingTime: null, rateIdx: null, fresh: false, gatherUntil: 0, lastRandom: -1 };
  }

  // ---------------------------------------------------------------- helpers

  const validPart = (p) => Number.isInteger(p) && p >= 0 && p < NUM_PARTS;

  function resolve(target) {
    if (target === 'sel' || target == null) {
      const sel = clamp(Math.round(store.get('ui.selectedPart') || 0), 0, NUM_PARTS - 1);
      if (Math.round(store.get('global.keyMode') || 0) === 1) {
        const list = [];
        for (let p = 0; p < NUM_PARTS; p++) if (!store.get(`parts.${p}.params.mute`)) list.push(p);
        return list.length ? list : [sel];
      }
      return [sel];
    }
    const p = Number(target);
    return validPart(p) ? [p] : [];
  }

  function arpSettings(p) {
    const a = store.get(`parts.${p}.arp`) || {};
    const rateIdx = clamp(Math.round(a.rate ?? 3), 0, SEQ_RATES.length - 1);
    return {
      mode: clamp(Math.round(a.mode || 0), 0, 6),
      rateIdx,
      rate: SEQ_RATES[rateIdx].beats,
      octaves: clamp(Math.round(a.octaves || 1), 1, 4),
      gate: clamp(Number.isFinite(a.gate) ? a.gate : 0.6, 0.05, 1),
      hold: !!a.hold,
    };
  }

  function announce(detail, time) {
    if (!emitter.has('note')) return;
    const delay = time > 0 ? timebase.heardDelayMs(time) : 0;
    if (delay < 4) emitter.emit('note', detail);
    else timers.setTimeout(() => emitter.emit('note', detail), delay);
  }

  function engineOn(part, note, vel, time, source) {
    if (note < 0 || note > 127) return;
    try { if (engine) engine.noteOn(part, note, vel, time, time > 0 ? source : undefined); } catch (err) { console.warn('[orograph] noteOn failed', err); }
    emitter.emit('sched', { part, note, vel, on: true, time, source });
    announce({ part, note, vel, on: true, source }, time);
  }

  function engineOff(part, note, time, source) {
    if (note < 0 || note > 127) return;
    try { if (engine) engine.noteOff(part, note, time, time > 0 ? source : undefined); } catch (err) { console.warn('[orograph] noteOff failed', err); }
    emitter.emit('sched', { part, note, vel: 0, on: false, time, source });
    announce({ part, note, vel: 0, on: false, source }, time);
  }

  function playDirect(p, note, vel, source) {
    const ps = parts[p];
    if (ps.sounding.has(note)) engineOff(p, note, 0, source);
    ps.sounding.set(note, vel);
    engineOn(p, note, vel, 0, source);
  }

  function releaseDirect(p, note, source) {
    const ps = parts[p];
    if (!ps.sounding.has(note)) return;
    ps.sounding.delete(note);
    engineOff(p, note, 0, source);
  }

  function poolOf(p) {
    const ps = parts[p];
    if (ps.cfgHold) return ps.latched.slice();
    const list = [];
    for (const e of ps.down.values()) list.push(e);
    for (const e of ps.sustained.values()) if (!ps.down.has(e.note)) list.push(e);
    return list;
  }

  function startArp(p) {
    const arp = parts[p].arp;
    if (arp.running) return;
    Object.assign(arp, freshArp(), { running: true, fresh: true, gatherUntil: timebase.now() + GATHER_MS / 1000 - 1e-6 });
    timers.setTimeout(() => kick(p), GATHER_MS);
  }

  function stopArp(p) {
    Object.assign(parts[p].arp, freshArp());
  }

  // ------------------------------------------------------------- key input

  function pressKey(p, note, vel, source) {
    const ps = parts[p];
    syncArpCfg(p);
    const othersDown = [...ps.down.keys()].some(n => n !== note);
    let entry = ps.down.get(note);
    if (entry) {
      entry.sources.add(source);
      entry.vel = vel;
    } else {
      entry = { note, vel, order: ++order, sources: new Set([source]) };
      ps.down.set(note, entry);
    }
    ps.sustained.delete(note);
    if (ps.cfgOn) {
      if (ps.cfgHold) {
        // A new gesture (no other key held) replaces the latched chord.
        if (!othersDown) ps.latched = [];
        if (!ps.latched.some(e => e.note === note)) ps.latched.push({ note, vel, order: entry.order });
      }
      startArp(p);
    } else {
      playDirect(p, note, vel, source);
    }
  }

  function releaseKey(p, note, source) {
    const ps = parts[p];
    const entry = ps.down.get(note);
    if (!entry) {
      // A stray note-off (e.g. key mode changed while held): make sure nothing hangs.
      if (!ps.sustainOn && !ps.cfgOn) releaseDirect(p, note, source);
      return;
    }
    if (entry.sources.has(source)) entry.sources.delete(source);
    else entry.sources.clear();
    if (entry.sources.size) return;
    ps.down.delete(note);
    if (ps.sustainOn) {
      ps.sustained.set(note, { note, vel: entry.vel, order: entry.order });
      return;
    }
    if (ps.cfgOn) {
      if (!poolOf(p).length) stopArp(p);
    } else {
      releaseDirect(p, note, source);
    }
  }

  function noteOn(target, note, vel = 0.8, source = 'ui') {
    note = Math.round(Number(note));
    if (!Number.isFinite(note) || note < 0 || note > 127) return;
    vel = clamp(Number.isFinite(vel) ? vel : 0.8, 0, 1);
    if (vel <= 0) { noteOff(target, note, source); return; }
    const list = resolve(target);
    if (!SOURCES_WITHOUT_ROUTE.has(source)) {
      const key = source + ':' + note;
      const prev = routes.get(key);
      routes.set(key, prev ? [...new Set([...prev, ...list])] : list);
    }
    for (const p of list) pressKey(p, note, vel, source);
  }

  function noteOff(target, note, source = 'ui') {
    note = Math.round(Number(note));
    if (!Number.isFinite(note)) return;
    const key = source + ':' + note;
    const list = routes.get(key) || resolve(target);
    routes.delete(key);
    for (const p of list) releaseKey(p, note, source);
  }

  function sustain(target, on) {
    on = !!on;
    let list = resolve(target);
    // Lifting the pedal must reach every part it went down on.
    if (!on && (target === 'sel' || target == null)) list = parts.map((ps, i) => (ps.sustainOn ? i : -1)).filter(i => i >= 0);
    for (const p of list) {
      const ps = parts[p];
      if (on) { ps.sustainOn = true; continue; }
      if (!ps.sustainOn) continue;
      ps.sustainOn = false;
      const released = [...ps.sustained.keys()];
      ps.sustained.clear();
      if (ps.cfgOn) {
        if (!poolOf(p).length) stopArp(p);
      } else {
        for (const n of released) if (!ps.down.has(n)) releaseDirect(p, n, 'sustain');
      }
    }
  }

  function allNotesOff(part) {
    const list = part == null ? parts.map((_, i) => i) : resolve(part);
    for (const p of list) {
      const ps = parts[p];
      ps.down.clear();
      ps.sustained.clear();
      ps.sustainOn = false;
      ps.latched = [];
      stopArp(p);
      for (const n of [...ps.sounding.keys()]) releaseDirect(p, n, 'panic');
      try { if (engine) engine.allNotesOff(p); } catch { /* engine not ready */ }
    }
    if (part == null) routes.clear();
    else for (const [k, v] of routes) if (v.every(p => list.includes(p))) routes.delete(k);
    // Lets other note sources (the patch preview) stop with a panic too.
    emitter.emit('allOff', { parts: list });
  }

  function heldNotes(part) {
    const p = resolve(part)[0];
    const out = new Set();
    if (p == null) return out;
    const ps = parts[p];
    for (const n of ps.down.keys()) out.add(n);
    for (const n of ps.sustained.keys()) out.add(n);
    if (ps.cfgOn && ps.cfgHold) for (const e of ps.latched) out.add(e.note);
    return out;
  }

  /** Held, sustained and latched keys of one part with their velocities (for the offline bounce). */
  function heldEntries(part) {
    const p = resolve(part)[0];
    if (p == null) return [];
    const ps = parts[p];
    const out = new Map();
    for (const e of ps.down.values()) out.set(e.note, { note: e.note, vel: e.vel });
    for (const e of ps.sustained.values()) if (!out.has(e.note)) out.set(e.note, { note: e.note, vel: e.vel });
    if (ps.cfgOn && ps.cfgHold) for (const e of ps.latched) if (!out.has(e.note)) out.set(e.note, { note: e.note, vel: e.vel });
    return [...out.values()];
  }

  // React to arp settings changing under held keys.
  function syncArpCfg(p) {
    const ps = parts[p];
    const cfg = arpSettings(p);
    const on = cfg.mode > 0;
    const wasOn = ps.cfgOn;
    const wasHold = ps.cfgHold;
    ps.cfgOn = on;
    ps.cfgHold = on && cfg.hold;
    if (wasOn && !on) {
      // Arp switched off: whatever is still held starts sounding directly.
      stopArp(p);
      ps.latched = [];
      for (const e of [...ps.down.values(), ...ps.sustained.values()]) playDirect(p, e.note, e.vel, 'arp');
      return;
    }
    if (!wasOn && on) {
      for (const n of [...ps.sounding.keys()]) releaseDirect(p, n, 'arp');
      if (ps.cfgHold) ps.latched = [...ps.down.values(), ...ps.sustained.values()].map(e => ({ note: e.note, vel: e.vel, order: e.order }));
      if (poolOf(p).length) startArp(p);
      return;
    }
    if (on && wasHold && !ps.cfgHold) {
      ps.latched = [];
      if (!poolOf(p).length) stopArp(p);
    } else if (on && !wasHold && ps.cfgHold) {
      ps.latched = [...ps.down.values(), ...ps.sustained.values()].map(e => ({ note: e.note, vel: e.vel, order: e.order }));
    }
  }

  const unsubs = [];
  for (let p = 0; p < NUM_PARTS; p++) {
    syncArpCfg(p);
    unsubs.push(store.subscribe(`parts.${p}.arp`, () => syncArpCfg(p)));
  }
  // Loading a whole session (a scene, undo) replaces the music: an arp chord
  // latched in the old one must not keep running into the new one, even when
  // the new part has Hold on too. Keys that are physically down still play.
  unsubs.push(store.subscribe('', (path) => {
    if (path !== '') return;
    for (let p = 0; p < NUM_PARTS; p++) {
      const ps = parts[p];
      if (!ps.latched.length) continue;
      ps.latched = ps.cfgHold ? [...ps.down.values(), ...ps.sustained.values()].map(e => ({ note: e.note, vel: e.vel, order: e.order })) : [];
      if (ps.arp.running && !poolOf(p).length) stopArp(p);
    }
  }));

  // -------------------------------------------------------- arp scheduling

  function nextArpNotes(p, cfg, pool) {
    const arp = parts[p].arp;
    const sorted = pool.slice().sort(cfg.mode === ARP.PLAYED ? (a, b) => a.order - b.order : (a, b) => a.note - b.note);
    const base = [];
    for (const e of sorted) if (!base.some(b => b.note === e.note)) base.push(e);
    if (cfg.mode === ARP.CHORD) {
      const oct = arp.index % cfg.octaves;
      arp.index++;
      return base.map(e => ({ note: e.note + 12 * oct, vel: e.vel })).filter(e => e.note <= 127);
    }
    const run = [];
    for (let o = 0; o < cfg.octaves; o++) for (const e of base) if (e.note + 12 * o <= 127) run.push({ note: e.note + 12 * o, vel: e.vel });
    const len = run.length;
    if (!len) return [];
    let i;
    switch (cfg.mode) {
      case ARP.DOWN: i = len - 1 - (arp.index % len); break;
      case ARP.UPDOWN: {
        const cycle = len > 1 ? 2 * len - 2 : 1;
        const k = arp.index % cycle;
        i = k < len ? k : cycle - k;
        break;
      }
      case ARP.RANDOM:
        i = Math.floor(random() * len) % len;
        if (len > 1 && i === arp.lastRandom) i = (i + 1 + Math.floor(random() * (len - 1))) % len;
        arp.lastRandom = i;
        break;
      case ARP.UP: case ARP.PLAYED: default: i = arp.index % len;
    }
    arp.index++;
    return [run[i]];
  }

  function playArpStep(p, cfg, pool, t, off) {
    for (const n of nextArpNotes(p, cfg, pool)) {
      engineOn(p, n.note, n.vel, t, 'arp');
      engineOff(p, n.note, off, 'arp');
    }
  }

  /**
   * Called by the transport scheduler. `grid` is null while the transport is
   * stopped; otherwise { spb, timeAt(beat, rateIdx), beatAt(time) }.
   */
  function scheduleArps(now, horizon, grid, tempo) {
    for (let p = 0; p < NUM_PARTS; p++) {
      const ps = parts[p];
      const arp = ps.arp;
      if (!arp.running) continue;
      const cfg = arpSettings(p);
      if (!cfg.mode) { syncArpCfg(p); continue; }
      const pool = poolOf(p);
      if (!pool.length) { stopArp(p); continue; }
      if (arp.fresh && now < arp.gatherUntil && timebase.running()) continue;
      if (grid) {
        if (arp.nextBeat == null || arp.rateIdx !== cfg.rateIdx) {
          const from = arp.nextBeat != null && arp.rateIdx != null
            ? grid.timeAt(arp.nextBeat, arp.rateIdx)
            : Math.max(arp.nextTime != null ? arp.nextTime : now, now);
          const b = grid.beatAt(from);
          const prev = Math.floor(b / cfg.rate + 1e-9);
          if (arp.fresh && from - grid.timeAt(prev * cfg.rate, cfg.rateIdx) < LATE_WINDOW) arp.nextBeat = prev * cfg.rate;
          else arp.nextBeat = Math.ceil(b / cfg.rate - 1e-9) * cfg.rate;
          arp.rateIdx = cfg.rateIdx;
          arp.nextTime = null;
        }
        for (let guard = 0; guard < 64; guard++) {
          let t = grid.timeAt(arp.nextBeat, cfg.rateIdx);
          if (t >= horizon) break;
          const step = Math.round(arp.nextBeat / cfg.rate);
          arp.nextBeat = (step + 1) * cfg.rate;
          if (t < now) {
            if (now - t > LATE_WINDOW) continue;
            t = now;
          }
          const tNext = grid.timeAt(arp.nextBeat, cfg.rateIdx);
          const off = Math.max(t + 0.01, Math.min(t + cfg.gate * cfg.rate * grid.spb, tNext - MIN_GAP));
          playArpStep(p, cfg, pool, t, off);
          arp.fresh = false;
        }
        arp.pendingTime = grid.timeAt(arp.nextBeat, cfg.rateIdx);
      } else {
        if (arp.nextBeat != null) {
          // Transport just stopped: carry on from where the grid had got to.
          arp.nextTime = Math.max(arp.pendingTime ?? now, now);
          arp.nextBeat = null;
          arp.rateIdx = null;
        }
        if (arp.nextTime == null) arp.nextTime = now;
        const dur = cfg.rate * 60 / clamp(tempo || 120, 20, 400);
        for (let guard = 0; guard < 64 && arp.nextTime < horizon; guard++) {
          let t = arp.nextTime;
          if (t < now - LATE_WINDOW) t = now;
          else if (t < now) t = now;
          const off = t + Math.max(0.01, Math.min(cfg.gate * dur, dur - MIN_GAP));
          playArpStep(p, cfg, pool, t, off);
          arp.fresh = false;
          arp.nextTime = t + dur;
        }
      }
    }
  }

  function arpActive() {
    return parts.some(ps => ps.arp.running);
  }

  return {
    noteOn, noteOff, sustain, allNotesOff, heldNotes, heldEntries, resolve,
    on: (type, fn) => emitter.on(type, fn),
    off: (type, fn) => emitter.off(type, fn),
    // Internal hooks used by the transport.
    scheduleArps, arpActive,
    setKick(fn) { kick = typeof fn === 'function' ? fn : () => {}; },
    _emit: (type, detail) => emitter.emit(type, detail),
    /** Drop queued `source` notes that would start after audio time `after` (engine side). */
    _cancelAfter(after, source) {
      try { if (engine && typeof engine.cancelNotes === 'function') engine.cancelNotes(after, source); } catch { /* engine not ready */ }
    },
    _engineOn: engineOn,
    _engineOff: engineOff,
    dispose() { for (const u of unsubs) u(); },
  };
}
