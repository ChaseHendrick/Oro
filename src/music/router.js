// Note router: turns key presses from the on-screen keyboard, MIDI and the
// computer keyboard into engine notes. Handles Selected/Layer key modes, the
// sustain pedal and a per-part arpeggiator.
//
// The arpeggiator is clocked by the transport's scheduler (see transport.js):
// with the transport stopped it free-runs from the first key press, and while
// the transport plays it locks to the bar grid so it stays in time with the
// sequencer and with external clock.
//
// Per-track state lives in MAX_PARTS slots that follow their tracks when the
// track list is reordered (src/core/tracks.js). A removed track's state is
// dropped here; the engine releases and fades out its sound itself.
//
// v2.8 Chord trigger (src/music/chord-trigger.js): with a track's chord on,
// each key it receives (keyboard, MIDI, and so the arpeggiator's input) and
// each sequencer note plays the chord built on it. The notes a key or step
// started are remembered, so its release stops exactly those even if the
// chord changes in between. Arp output is not expanded again.
//
// v2.9 Capture (src/music/capture.js): the keys people play (before the chord
// trigger) are kept for about the last CAPTURE_BARS bars per track id, for
// turning a phrase into a pattern afterwards.

import { MAX_PARTS, SEQ_RATES, ARP_RHYTHMS, clamp } from '../core/params.js';
import { partCount, watchTracks, permute, inversePerm } from '../core/tracks.js';
import { createEmitter } from './emitter.js';
import { sanitizeChord, chordNotes } from './chord-trigger.js';
import { createCaptureBuffer, isPersonSource, CAPTURE_BARS } from './capture.js';

export const ARP = { OFF: 0, UP: 1, DOWN: 2, UPDOWN: 3, RANDOM: 4, PLAYED: 5, CHORD: 6 };
export const MIN_GAP = 0.003;      // seconds kept between a note-off and the next note-on of the same voice
export const LATE_WINDOW = 0.04;   // a grid step missed by less than this still plays (immediately)
// Notes of a chord arrive a few ms apart over MIDI; wait this long before the
// first arp step so Down/Chord modes see the whole chord.
export const GATHER_MS = 8;
// Pedal latency compensation (src/pedals/latency-comp.js): the most a part's
// sequenced notes may be sent ahead of the time they should be heard.
export const MAX_LEAD = 0.5;

const SOURCES_WITHOUT_ROUTE = new Set(['seq', 'arp']);

export function createRouter({ store, engine, timebase, timers, random = Math.random }) {
  const emitter = createEmitter();
  let kick = () => {};
  let order = 0;
  // part -> seconds its sequenced notes are sent early (pedal latency
  // compensation); null = none. Set by the pedal rig.
  let leadFn = null;
  // (part, note, source) -> false to keep a note-on from the engine; null = every note plays
  let gate = null;
  // `${source}:${note}` -> parts the note was sent to, so a note-off reaches the
  // same parts even if the key mode or selected part changed in between.
  const routes = new Map();
  const captureBuf = createCaptureBuffer({
    now: () => timebase.perfNow() / 1000,
    windowSec: () => CAPTURE_BARS * 4 * 60 / clamp(Number(store.get('global.tempo')) || 120, 20, 400),
  });
  const trackId = (p) => store.get(`parts.${p}.id`);

  const freshPart = () => ({
    down: new Map(),       // physically held keys: note -> { note, vel, order, sources:Set }
    sustainOn: false,
    sustained: new Map(),  // released while the pedal is down: note -> { note, vel, order }
    latched: [],           // arp hold: [{ note, vel, order }]
    sounding: new Map(),   // notes this router started directly (arp off): note -> vel
    raw: new Map(),        // v2.8 keys physically down before the chord trigger: note -> vel (Learn)
    chordKeys: new Map(),  // v2.8 `${source}:${note}` -> chord notes that key pressed
    seqChords: new Map(),  // v2.8 note -> queue of chord note lists started by sequencer notes
    cfgOn: false,
    cfgHold: false,
    arp: freshArp(),
  });
  let parts = Array.from({ length: MAX_PARTS }, freshPart);
  const count = () => partCount(store);
  const live = () => parts.slice(0, count());

  function freshArp() {
    return { running: false, index: 0, rhythmIndex: 0, nextTime: null, nextBeat: null, pendingTime: null, rateIdx: null, fresh: false, gatherUntil: 0, lastRandom: -1 };
  }

  // ---------------------------------------------------------------- helpers

  const validPart = (p) => Number.isInteger(p) && p >= 0 && p < count();

  /** The track's chord trigger setting when it is on, else null (the default: nothing changes). */
  function chordOf(p) {
    const c = store.get(`parts.${p}.chord`);
    if (!c || !c.on) return null;
    if (store.get(`parts.${p}.drum.on`)) return null;   // a drum kit plays pads, not chords
    return sanitizeChord(c);
  }
  function chordFor(p, note) {
    const c = chordOf(p);
    if (!c) return null;
    return chordNotes(note, c, { root: Number(store.get('global.scaleRoot')) || 0, scaleType: Number(store.get('global.scaleType')) || 0 });
  }

  function resolve(target) {
    if (target === 'sel' || target == null) {
      const n = count();
      const sel = clamp(Math.round(store.get('ui.selectedPart') || 0), 0, n - 1);
      if (Math.round(store.get('global.keyMode') || 0) === 1) {
        // Layer: every unmuted track in the list
        const list = [];
        for (let p = 0; p < n; p++) if (!store.get(`parts.${p}.params.mute`)) list.push(p);
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
      rhythm: clamp(Math.round(a.rhythm || 0), 0, ARP_RHYTHMS.length - 1),
    };
  }

  function announce(detail, time) {
    if (!emitter.has('note')) return;
    const delay = time > 0 ? timebase.heardDelayMs(time) : 0;
    if (delay < 4) emitter.emit('note', detail);
    else timers.setTimeout(() => emitter.emit('note', detail), delay);
  }

  /** Seconds part `p`'s sequenced notes go out early (0..MAX_LEAD). */
  function leadFor(p) {
    if (!leadFn || !validPart(p)) return 0;
    let v = 0;
    try { v = Number(leadFn(p)); } catch { v = 0; }
    return Number.isFinite(v) && v > 0 ? Math.min(v, MAX_LEAD) : 0;
  }

  /**
   * Engine time for a note heard at `time` sent `lead` seconds early, never in
   * the past. Only the engine call moves: 'sched' (MIDI out) and 'note'
   * (visuals) keep the heard time.
   */
  function engineTime(time, lead) {
    if (!(lead > 0) || !(time > 0)) return time;
    return Math.max(time - lead, timebase.now());
  }

  function engineOn(part, note, vel, time, source, lead = 0) {
    if (note < 0 || note > 127) return;
    // v2.9 Free Play off (src/ui/coin-slot.js): no credit, no sound
    if (gate !== null && !gate(part, note, source)) return;
    const et = engineTime(time, lead);
    try { if (engine) engine.noteOn(part, note, vel, et, time > 0 ? source : undefined); } catch (err) { console.warn('[orograph] noteOn failed', err); }
    emitter.emit('sched', { part, note, vel, on: true, time, source });
    announce({ part, note, vel, on: true, source }, time);
  }

  /** v2.9 parameter locks: part parameter values heard from `time`, sent `lead` early like the notes. */
  function engineParams(part, p, time, lead = 0) {
    const et = engineTime(time, lead);
    try { if (engine && typeof engine.scheduleParams === 'function') engine.scheduleParams(part, p, et); } catch (err) { console.warn('[orograph] params failed', err); }
    emitter.emit('params', { part, p, time });
  }

  function engineOff(part, note, time, source, lead = 0) {
    if (note < 0 || note > 127) return;
    const et = engineTime(time, lead);
    try { if (engine) engine.noteOff(part, note, et, time > 0 ? source : undefined); } catch (err) { console.warn('[orograph] noteOff failed', err); }
    emitter.emit('sched', { part, note, vel: 0, on: false, time, source });
    announce({ part, note, vel: 0, on: false, source }, time);
  }

  // v2.8 sequencer notes with the chord trigger: each note-on queues the
  // chord it started and the matching note-off (they always come in order)
  // stops that chord.
  function seqOn(part, note, vel, time, source, lead = 0) {
    const notes = source === 'seq' && validPart(part) ? chordFor(part, note) : null;
    if (!notes) { engineOn(part, note, vel, time, source, lead); return; }
    const q = parts[part].seqChords;
    if (!q.has(note)) q.set(note, []);
    q.get(note).push(notes);
    for (const n of notes) engineOn(part, n, vel, time, source, lead);
  }
  function seqOff(part, note, time, source, lead = 0) {
    const q = source === 'seq' && validPart(part) ? parts[part].seqChords.get(note) : null;
    if (!q || !q.length) { engineOff(part, note, time, source, lead); return; }
    const notes = q.shift();
    if (!q.length) parts[part].seqChords.delete(note);
    for (const n of notes) engineOff(part, n, time, source, lead);
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

  function pressKey(p, note, vel, source, tag = source) {
    const ps = parts[p];
    syncArpCfg(p);
    const othersDown = [...ps.down.keys()].some(n => n !== note);
    let entry = ps.down.get(note);
    if (entry) {
      entry.sources.add(tag);
      entry.vel = vel;
    } else {
      entry = { note, vel, order: ++order, sources: new Set([tag]) };
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

  function releaseKey(p, note, source, tag = source) {
    const ps = parts[p];
    const entry = ps.down.get(note);
    if (!entry) {
      // A stray note-off (e.g. key mode changed while held): make sure nothing hangs.
      if (!ps.sustainOn && !ps.cfgOn) releaseDirect(p, note, source);
      return;
    }
    if (entry.sources.has(tag)) entry.sources.delete(tag);
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
    const person = isPersonSource(source);
    for (const p of list) {
      const ps = parts[p];
      if (person) captureBuf.on(trackId(p), note, vel);
      ps.raw.set(note, vel);
      const notes = chordFor(p, note);
      if (!notes) { pressKey(p, note, vel, source); continue; }
      // one held-source tag per key, so two keys sharing a chord note each hold it
      const key = source + ':' + note;
      const prev = ps.chordKeys.get(key);
      if (prev) for (const n of prev) releaseKey(p, n, source, key);
      ps.chordKeys.set(key, notes);
      for (const n of notes) pressKey(p, n, vel, source, key);
    }
  }

  function noteOff(target, note, source = 'ui') {
    note = Math.round(Number(note));
    if (!Number.isFinite(note)) return;
    const key = source + ':' + note;
    const list = routes.get(key) || resolve(target);
    routes.delete(key);
    const person = isPersonSource(source);
    for (const p of list) {
      const ps = parts[p];
      if (person) captureBuf.off(trackId(p), note);
      ps.raw.delete(note);
      const notes = ps.chordKeys.get(key);
      if (!notes) { releaseKey(p, note, source); continue; }
      ps.chordKeys.delete(key);
      for (const n of notes) releaseKey(p, n, source, key);
    }
  }

  function sustain(target, on) {
    on = !!on;
    let list = resolve(target);
    // Lifting the pedal must reach every part it went down on.
    if (!on && (target === 'sel' || target == null)) list = live().map((ps, i) => (ps.sustainOn ? i : -1)).filter(i => i >= 0);
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
    const list = part == null ? live().map((_, i) => i) : resolve(part);
    for (const p of list) {
      const ps = parts[p];
      ps.down.clear();
      ps.sustained.clear();
      ps.sustainOn = false;
      ps.latched = [];
      ps.raw.clear(); ps.chordKeys.clear(); ps.seqChords.clear();
      stopArp(p);
      for (const n of [...ps.sounding.keys()]) releaseDirect(p, n, 'panic');
      try { if (engine) engine.allNotesOff(p); } catch { /* engine not ready */ }
    }
    if (part == null) routes.clear();
    else for (const [key, route] of routes) {
      const remaining = route.filter(p => !list.includes(p));
      if (remaining.length) routes.set(key, remaining);
      else routes.delete(key);
    }
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
  for (let p = 0; p < count(); p++) syncArpCfg(p);
  // The track list changed shape: per-track state follows its track, a new
  // track starts empty and a removed one is forgotten (its sound is released
  // by the engine). Routed note-offs follow their tracks too. Registered
  // before the listener below, so that one already sees the moved state.
  unsubs.push(watchTracks(store, ({ perm, fresh, count: n }) => {
    parts = permute(parts, perm, fresh, freshPart);
    for (let p = n; p < MAX_PARTS; p++) parts[p] = freshPart();
    const inv = inversePerm(perm);
    for (const [k, list] of [...routes]) {
      const next = list.map(p => inv[p]).filter(p => p >= 0 && p < n);
      if (next.length) routes.set(k, next); else routes.delete(k);
    }
  }));
  // React to arp settings changing under held keys.
  unsubs.push(store.subscribe('parts', (path) => {
    if (path === '' || path === 'parts') { for (let p = 0; p < count(); p++) syncArpCfg(p); return; }
    const m = /^parts\.(\d+)(\.arp(\..*)?)?$/.exec(path);
    if (m && Number(m[1]) < count()) syncArpCfg(Number(m[1]));
  }));
  // Loading a whole session (a scene, undo) replaces the music: an arp chord
  // latched in the old one must not keep running into the new one, even when
  // the new part has Hold on too. Keys that are physically down still play.
  unsubs.push(store.subscribe('', (path) => {
    if (path !== '') return;
    for (let p = 0; p < count(); p++) {
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

  function playArpStep(p, cfg, pool, t, off, lead = 0) {
    const steps = ARP_RHYTHMS[cfg.rhythm]?.steps || ARP_RHYTHMS[0].steps;
    const phase = parts[p].arp.rhythmIndex++;
    if (!steps[phase % steps.length]) return;
    for (const n of nextArpNotes(p, cfg, pool)) {
      engineOn(p, n.note, n.vel, t, 'arp', lead);
      engineOff(p, n.note, off, 'arp', lead);
    }
  }

  /**
   * Called by the transport scheduler. `grid` is null while the transport is
   * stopped; otherwise { spb, timeAt(beat, rateIdx), beatAt(time) }.
   */
  function scheduleArps(now, horizon, grid, tempo) {
    for (let p = 0; p < count(); p++) {
      const ps = parts[p];
      const arp = ps.arp;
      if (!arp.running) continue;
      const cfg = arpSettings(p);
      if (!cfg.mode) { syncArpCfg(p); continue; }
      const pool = poolOf(p);
      if (!pool.length) { stopArp(p); continue; }
      if (arp.fresh && now < arp.gatherUntil && timebase.running()) continue;
      if (grid) {
        // On the grid the arp is sequenced: a part through the pedals is
        // scheduled early (and further ahead) by its latency compensation.
        const lead = leadFor(p);
        const reach = horizon + lead;
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
          if (t >= reach) break;
          const step = Math.round(arp.nextBeat / cfg.rate);
          arp.nextBeat = (step + 1) * cfg.rate;
          if (t < now) {
            if (now - t > LATE_WINDOW) continue;
            t = now;
          }
          const tNext = grid.timeAt(arp.nextBeat, cfg.rateIdx);
          const off = Math.max(t + 0.01, Math.min(t + cfg.gate * cfg.rate * grid.spb, tNext - MIN_GAP));
          playArpStep(p, cfg, pool, t, off, lead);
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
    return live().some(ps => ps.arp.running);
  }

  return {
    noteOn, noteOff, sustain, allNotesOff, heldNotes, heldEntries, resolve,
    /** v2.9 coin slot: fn(part, note, source) -> whether a note-on may sound; null removes the gate. */
    setGate: (fn) => { gate = typeof fn === 'function' ? fn : null; },
    on: (type, fn) => emitter.on(type, fn),
    off: (type, fn) => emitter.off(type, fn),
    // Internal hooks used by the transport.
    scheduleArps, arpActive,
    setKick(fn) { kick = typeof fn === 'function' ? fn : () => {}; },
    /**
     * Pedal latency compensation: fn(part) -> seconds that part's sequenced
     * notes (step sequencer, arp on the grid) are sent early; null turns it off.
     */
    setLead(fn) { leadFn = typeof fn === 'function' ? fn : null; },
    leadFor,
    /** The largest lead of any part (the transport starts this much later). */
    maxLead() {
      let m = 0;
      if (leadFn) for (let p = 0; p < count(); p++) m = Math.max(m, leadFor(p));
      return m;
    },
    _emit: (type, detail) => emitter.emit(type, detail),
    /** Drop queued `source` notes that would start after audio time `after` (engine side). */
    _cancelAfter(after, source) {
      try { if (engine && typeof engine.cancelNotes === 'function') engine.cancelNotes(after, source); } catch { /* engine not ready */ }
      emitter.emit('cancel', { after, source });
    },
    // The transport's sequencer notes go through the chord trigger here.
    _engineOn: seqOn,
    _engineOff: seqOff,
    _engineParams: engineParams,
    /** v2.9 notes people played on track `part` lately (see capture.js): [{ note, vel, on, off }], seconds. */
    captured(part) {
      const p = resolve(part)[0];
      return p == null ? [] : captureBuf.list(trackId(p));
    },
    /** v2.8 keys physically held on track `part` (before the chord trigger), lowest first: what Learn captures. */
    rawHeld(part) {
      const p = resolve(part)[0];
      return p == null ? [] : [...parts[p].raw.keys()].sort((a, b) => a - b);
    },
    dispose() { for (const u of unsubs) u(); },
  };
}
