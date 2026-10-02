// Guitar plays notes (v1.1, docs/PEDALS.md "Guitar as notes"): turns the pitch
// tracker's events (createPitchTracker in pitch.js, run by createGuitarInput in
// guitar.js) into notes on one part through the note router, so the guitar
// behaves like any other keyboard: source 'guitar', MIDI out echo, Layer mode,
// the arpeggiator and sustain all apply as they do to the on-screen keys.
//
// The tracker already decides note-on at an onset (with pitch hysteresis),
// note-off when its own envelope drops below the gate, legato note changes,
// and bends relative to the sounding note. This driver adds:
//   * one sounding guitar note at a time (a legato change releases the old one);
//   * a second, independent gate on the level stream: the note ends when the
//     envelope falls `GATE_HYSTERESIS_DB` below the gate even if the tracker
//     still hears a pitch (a muted string with hum on it);
//   * bends sent to the part's pitch bend, scaled into the part's Bend range
//     (params.bendRange, 0..24 semitones). A part with Bend at 0 cannot bend,
//     so the guitar steps through notes instead; without any range (an engine
//     or store without the param) DEFAULT_BEND_RANGE (+/-2 semitones) is used.
//
// Pure: no Web Audio. Tests feed it synthetic tracker / level events.

import { MAX_PARTS } from '../core/params.js';

export const GUITAR_SOURCE = 'guitar';
export const DEFAULT_BEND_RANGE = 2;
/** Tracker bend range while bends are off: a bend past ~0.9 semitones becomes the next note. */
export const STEP_BEND_RANGE = 0.5;
export const GATE_HYSTERESIS_DB = 3;
export const DEFAULT_GATE_DB = -50;
export const GATE_MIN_DB = -75;
export const GATE_MAX_DB = -20;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** 'sel' or a track index 0..numParts-1 (tracks that do not exist yet resolve to none in the router). */
export function normalizeTarget(t, numParts = MAX_PARTS) {
  if (t === 'sel' || t == null || t === '') return 'sel';
  const n = Math.round(Number(t));
  return Number.isInteger(n) && n >= 0 && n < numParts ? n : 'sel';
}

/**
 * @param {object} o
 * @param {object} o.store   the app store (reads parts.N.params.bendRange)
 * @param {object} o.router  createRouter(): noteOn(target, note, vel, source), noteOff(target, note, source), resolve(target)
 * @param {object} [o.engine] engine.bend(part, -1..1)
 * @param {string} [o.source] note source tag for the router (v1.4 Voice plays notes uses 'voice')
 */
export function createGuitarNotes({ store, router, engine = null, numParts = MAX_PARTS, source = GUITAR_SOURCE } = {}) {
  const cfg = { enabled: false, target: 'sel', gateDb: DEFAULT_GATE_DB, bends: true };
  let current = null;   // { note, parts: number[], target }
  let bentParts = [];   // parts whose pitch bend this driver moved away from 0
  const stats = { notes: 0, lastNote: null, lastVelocity: 0, bends: 0 };
  const listeners = new Set();
  const emit = (e) => { for (const fn of [...listeners]) { try { fn(e); } catch (err) { console.error('[guitar notes] listener failed', err); } } };

  function partsFor(target) {
    try {
      const list = router && typeof router.resolve === 'function' ? router.resolve(target) : [];
      return Array.isArray(list) ? list.filter(p => Number.isInteger(p)) : [];
    } catch { return []; }
  }

  /** Smallest Bend range of the parts the guitar plays (so no part bends past its range). */
  function bendRange(parts = partsFor(cfg.target)) {
    let r = Infinity;
    for (const p of parts) {
      const v = store ? Number(store.get(`parts.${p}.params.bendRange`)) : NaN;
      if (Number.isFinite(v)) r = Math.min(r, v);
    }
    return Number.isFinite(r) ? clamp(Math.round(r), 0, 24) : DEFAULT_BEND_RANGE;
  }

  /** What the tracker needs: its gate and how far a bend may go before it becomes a new note. */
  function trackerConfig() {
    const r = bendRange();
    return { gateDb: cfg.gateDb, bendRange: cfg.bends && r > 0 ? r : STEP_BEND_RANGE };
  }

  function sendBend(parts, v) {
    if (!engine || typeof engine.bend !== 'function') return;
    for (const p of parts) { try { engine.bend(p, v); } catch { /* engine not ready */ } }
  }

  function unbend() {
    if (bentParts.length) { sendBend(bentParts, 0); bentParts = []; }
  }

  function release(reason = 'off') {
    if (!current) { unbend(); return; }
    const c = current;
    current = null;
    unbend();
    try { router.noteOff(c.target, c.note, source); } catch (err) { console.warn('[guitar notes] noteOff failed', err); }
    emit({ type: 'noteOff', note: c.note, parts: c.parts, reason });
  }

  function noteOn(e) {
    const note = Math.round(Number(e.note));
    if (!Number.isFinite(note) || note < 0 || note > 127) return;
    release('legato');
    const target = cfg.target;
    const parts = partsFor(target);
    if (!parts.length) return;
    const vel = clamp(Number.isFinite(e.velocity) ? e.velocity : 0.8, 0.05, 1);
    current = { note, parts, target };
    stats.notes++; stats.lastNote = note; stats.lastVelocity = vel;
    try { router.noteOn(target, note, vel, source); } catch (err) { console.warn('[guitar notes] noteOn failed', err); current = null; return; }
    emit({ type: 'noteOn', note, velocity: vel, parts, legato: !!e.legato, freq: e.freq });
  }

  function bend(e) {
    if (!current || !cfg.bends) return;
    const r = bendRange(current.parts);
    if (!(r > 0)) return;
    const semis = Number(e.semitones);
    if (!Number.isFinite(semis)) return;
    const v = clamp(semis / r, -1, 1);
    sendBend(current.parts, v);
    bentParts = v !== 0 ? current.parts.slice() : [];
    stats.bends++;
    emit({ type: 'bend', semitones: semis, value: v, parts: current.parts });
  }

  /** One tracker or level event: {type: 'noteOn'|'noteOff'|'bend'|'level'|'stop', ...}. */
  function handle(e) {
    if (!e || !e.type) return;
    if (e.type === 'stop') { release('stop'); return; }
    if (!cfg.enabled) return;
    switch (e.type) {
      case 'noteOn': noteOn(e); break;
      case 'noteOff': if (current && Math.round(e.note) === current.note) release('tracker'); break;
      case 'bend': bend(e); break;
      case 'level':
        if (current && Number.isFinite(e.db) && e.db < cfg.gateDb - GATE_HYSTERESIS_DB) release('gate');
        break;
      default: break;
    }
  }

  function configure(o = {}) {
    const before = { ...cfg };
    if (o.enabled != null) cfg.enabled = !!o.enabled;
    if (o.target !== undefined) cfg.target = normalizeTarget(o.target, numParts);
    if (o.gateDb != null && Number.isFinite(Number(o.gateDb))) cfg.gateDb = clamp(Number(o.gateDb), GATE_MIN_DB, GATE_MAX_DB);
    if (o.bends != null) cfg.bends = !!o.bends;
    if (!cfg.enabled && before.enabled) release('disabled');
    else if (current && cfg.target !== before.target) release('target');
    else if (current && before.bends && !cfg.bends) unbend();
    return { ...cfg };
  }

  return {
    handle,
    configure,
    trackerConfig,
    bendRange: () => bendRange(),
    /** Release the sounding note (return closed, notes switched off). */
    stop: () => release('stop'),
    get config() { return { ...cfg }; },
    get source() { return source; },
    get sounding() { return current ? current.note : null; },
    stats: () => ({ ...stats, sounding: current ? current.note : null }),
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    dispose() { release('stop'); listeners.clear(); },
  };
}
