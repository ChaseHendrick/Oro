// Score desk. oro.play / oro.compose for an agent, and the same thing from
// the page. A score is checked in score.js, then its notes are scheduled
// like the patch preview: a short timer, exact audio times, one note-off
// each. Tracks are borrowed for the duration and put back afterwards, so a
// score never becomes an undo step and never ends up in the saved session.
//
// 2.17:
//   * voicing 'tint' (2.16) keeps each track's land and only changes its
//     envelope and filter; voicing 'patch' plays every voice through its own
//     orchestra patch (orchestra.js)
//   * tracks 'add' (the default) gives voices their own tracks, up to 16,
//     and removes them afterwards; 'share' packs voices onto the tracks there are
//   * drum pieces beyond the classic kit get kit tracks of their own
//   * everything borrowed is kept by track id, so a reorder, a removed track
//     or a loaded session can never be written over; loading a session or a
//     panic stops the score, and the autosave always stores the tracks as
//     they were (cleanState)
//   * the restore waits for release tails; cue events fire as cues pass

import { deepClone } from '../core/store.js';
import { MAX_PARTS, defaultPart } from '../core/params.js';
import { nextTrackColor, newTrackId } from '../core/tracks.js';
import { defaultDrum } from '../dsp/drum-kit.js';
import { partWithPatch } from '../presets/apply.js';
import { LOOKAHEAD, INTERVAL_MS, swingBeat } from './transport.js';
import { check, compose, schema, percOnKit } from './score.js';
import { voicePatch, percussionKits } from './orchestra.js';

const SOURCE = 'score';
const META = Object.freeze({ source: SOURCE });
const FREE_LEAD = 0.05;
const PATCH_LEAD = 0.25;   // patch voicing: time for the new lands to reach the engine
const TAIL = 2.5;          // seconds after the last note before the tracks are put back

const TINT = {
  terrain: { attack: 0.03, decay: 0.4, sustain: 0.7, release: 0.5, cutoff: 7000, filterType: 1, pluck: 0 },
  physical: { attack: 0.002, decay: 0.8, sustain: 0.15, release: 0.4, pluck: 0.85, pluckDecay: 1.4, cutoff: 6000, filterType: 1 },
  fm: { attack: 0.01, decay: 0.5, sustain: 0.4, release: 0.6, phaseMod: 0.45, phaseRatio: 2, cutoff: 8000, filterType: 1 },
  additive: { attack: 0.02, decay: 0.3, sustain: 0.8, release: 0.4, inharmAmount: 0.65, cutoff: 5000, filterType: 1 },
  subtractive: { attack: 0.01, decay: 0.25, sustain: 0.5, release: 0.3, cutoff: 1800, resonance: 0.35, filterType: 1 },
  wavetable: { attack: 0.01, decay: 0.3, sustain: 0.8, release: 0.3, cutoff: 400, filterType: 1 },
  vector: { attack: 0.4, decay: 0.6, sustain: 0.8, release: 1.2, cutoff: 2500, filterType: 1 },
  granular: { attack: 0.25, decay: 0.8, sustain: 0.6, release: 1.4, cutoff: 3200, filterType: 1, reverbSend: 0.45 },
  resonator: { attack: 0.002, decay: 2, sustain: 0, release: 1.5, resoOn: 1, resoMix: 0.85, resoDecay: 2.4, resoTone: 0.32, cutoff: 1400, filterType: 1 },
  noise: { attack: 0.8, decay: 1, sustain: 0.9, release: 2, air: 0.8, size: 0.04, cutoff: 6000, filterType: 1 },
  drum: {},
  perc: {},
};

/**
 * Which track each voice plays on. Pure (tested on its own).
 * Returns { slots: [{ part, kind: 'pitched'|'kit'|'perc', voice?, family?, kit?, name, add }],
 *   partOf: Map(voice -> part), percPart: Map(kit -> part), fallback: Set(perc voices on the kit), warnings }
 */
export function planTracks(receipt, count, { tracks = 'add' } = {}) {
  const warnings = [];
  const order = [];
  for (const v of receipt.voices) if (!order.includes(v.voice)) order.push(v.voice);
  const familyOf = (v) => receipt.voices.find((x) => x.voice === v).family;
  const drums = order.filter((v) => familyOf(v) === 'drum');
  const perc = order.filter((v) => familyOf(v) === 'perc');
  const pitched = order.filter((v) => familyOf(v) !== 'drum' && familyOf(v) !== 'perc');
  const kitsUsed = [...new Set(receipt.score.notes.filter((n) => n.family === 'perc').map((n) => n.kit))].sort((a, b) => a - b);
  const room = tracks === 'share' ? count : MAX_PARTS;
  const slots = [];
  const partOf = new Map();
  const percPart = new Map();
  const fallback = new Set();
  let next = count;   // the next added track's index
  const addSlot = (slot) => {
    if (next >= room) return -1;
    const part = next++;
    slots.push({ ...slot, part, add: true });
    return part;
  };
  // the classic kit sits on the last track there is (2.16), or on a new one
  const needKit = drums.length > 0 || (perc.length > 0 && tracks === 'share');
  let kitPart = -1;
  if (needKit) {
    if (count > 1 || (count === 1 && !pitched.length)) { kitPart = count - 1; slots.push({ part: kitPart, kind: 'kit', name: 'Kit', add: false }); }
    else kitPart = addSlot({ kind: 'kit', name: 'Kit' });
    if (kitPart < 0) { kitPart = 0; slots.push({ part: 0, kind: 'kit', name: 'Kit', add: false }); }
    for (const v of drums) partOf.set(v, kitPart);
  }
  // pitched voices: the other existing tracks first, then new ones
  const free = [];
  for (let i = 0; i < count; i++) if (i !== kitPart) free.push(i);
  const pitchedParts = [];
  for (const v of pitched) {
    let part;
    if (free.length) part = free.shift();
    else part = addSlot({ kind: 'pitched', voice: v, family: familyOf(v), name: v });
    if (part >= 0) {
      if (!slots.some((s) => s.part === part)) slots.push({ part, kind: 'pitched', voice: v, family: familyOf(v), name: v, add: false });
      partOf.set(v, part);
      pitchedParts.push(part);
    }
  }
  /** A track for the classic kit when none was planned: a free one, a new one, or the last pitched one. */
  function fallbackKit() {
    let part = free.length ? free.shift() : addSlot({ kind: 'kit', name: 'Kit' });
    if (part >= 0) {
      if (!slots.some((s) => s.part === part)) slots.push({ part, kind: 'kit', name: 'Kit', add: false });
      return part;
    }
    if (pitchedParts.length > 1) {
      part = pitchedParts.pop();
      const slot = slots.find((s) => s.part === part);
      for (const [v, p] of partOf) if (p === part) partOf.set(v, pitchedParts[pitchedParts.length - 1]);
      Object.assign(slot, { kind: 'kit', name: 'Kit' });
      delete slot.voice; delete slot.family;
      warnings.push({ line: 0, field: 'tracks', message: 'All 16 tracks are in use, so two pitched voices share a track to make room for the drum pads.', fix: 'Use fewer voices.' });
      return part;
    }
    part = slots.length ? slots[0].part : 0;
    if (!slots.some((s) => s.part === part)) slots.push({ part, kind: 'kit', name: 'Kit', add: false });
    return part;
  }
  // voices left over share the pitched tracks (2.16 behaviour)
  const left = pitched.filter((v) => !partOf.has(v));
  if (left.length) {
    const pool = pitchedParts.length ? pitchedParts : [kitPart >= 0 ? kitPart : 0];
    warnings.push({ line: 0, field: 'tracks', message: `${pitched.length} pitched voices share ${pool.length} track${pool.length === 1 ? '' : 's'}. Voices on one track use one sound.`, fix: tracks === 'share' ? 'Play with { tracks: "add" }, add tracks, or use fewer voices.' : 'Use fewer voices: Oro has 16 tracks.' });
    left.forEach((v, i) => {
      const part = pool[i % pool.length];
      partOf.set(v, part);
      const slot = slots.find((s) => s.part === part);
      if (slot) slot.name = `${slot.name}+${v}`.slice(0, 40);
    });
  }
  // drum pieces: kit tracks of their own, or the classic kit's pads
  for (const k of kitsUsed) {
    if (tracks === 'share') break;
    const name = kitsUsed.length > 1 ? `Percussion ${k}` : 'Percussion';
    let part = addSlot({ kind: 'perc', kit: k, name });
    // all 16 tracks exist: an existing track no voice uses can still hold a kit
    if (part < 0 && free.length) { part = free.shift(); slots.push({ part, kind: 'perc', kit: k, name, add: false }); }
    if (part >= 0) percPart.set(k, part);
  }
  for (const v of perc) {
    const k = receipt.score.notes.find((n) => n.voice === v).kit;
    if (percPart.has(k)) partOf.set(v, percPart.get(k));
    else {
      // the pads only sound on a track that is a kit (2.17.1: before, they
      // could land on a pitched track and play as low notes)
      if (kitPart < 0) kitPart = fallbackKit();
      fallback.add(v);
      partOf.set(v, kitPart);
    }
  }
  if (fallback.size) {
    warnings.push({ line: 0, field: 'tracks', message: `No room for a percussion kit, so ${[...fallback].join(', ')} play pads of the classic kit.`, fix: 'Play with { tracks: "add" } or free a track.' });
  }
  if (drums.length && pitched.length && kitPart >= 0 && pitchedParts.includes(kitPart)) {
    warnings.push({ line: 0, field: 'tracks', message: 'Only one track, so the kit and the notes share it. Drums will not sound like a kit.', fix: 'Add a track before playing a score with both.' });
  }
  return { slots, partOf, percPart, fallback, warnings };
}

/**
 * The track `base` set up to play slot `s` of planTracks() (a copy; base is
 * not changed). Shared by the desk and the offline renderer (score-render.js).
 */
export function voicedPart(base, s, receipt, voicing) {
  let part = deepClone(base);
  if (s.kind === 'kit') {
    part.drum = voicing === 'patch' || s.add ? { ...defaultDrum(), on: 1 } : { ...(part.drum || defaultDrum()), on: 1 };
  } else if (s.kind === 'perc') {
    const voices = receipt.score.notes.filter((n) => n.family === 'perc').map((n) => n.voice);
    part.drum = percussionKits([...new Set(voices)]).kits[s.kit - 1] || { ...defaultDrum(), on: 1 };
  } else {
    const patch = voicing === 'patch' ? voicePatch(s.voice) : null;
    if (patch) part = partWithPatch(part, patch);
    else for (const [k, v] of Object.entries(TINT[s.family] || {})) part.params[k] = v;
    part.drum = { ...(part.drum || defaultDrum()), on: 0 };
    if (part.sampler) part.sampler = { ...part.sampler, on: 0 };
  }
  part.name = String(s.name || part.name).slice(0, 40);
  part.seqOn = 0;
  part.params = { ...part.params, mute: 0, solo: 0 };
  const panNote = s.voice ? receipt.score.notes.find((n) => n.voice === s.voice && n.pan != null) : null;
  if (panNote) part.params.pan = panNote.pan;
  return part;
}

export function createScoreDesk({ store, router, timebase, timers, emit = () => {} }) {
  let current = '';
  let active = null;     // { notes, cues, end, start, title, ... }
  let timer = null;
  let borrowed = null;   // { parts: Map(id -> part), added: Set(id), tempo, selected }
  let tailUntil = -Infinity;

  function stop(reason = 'stop') {
    const a = active;
    active = null;
    tailUntil = -Infinity;
    if (timer) { timers.clearInterval(timer); timer = null; }
    if (a) {
      const now = timebase.now();
      for (const n of a.notes) {
        if (n.sentOn && !n.sentOff) router._engineOff(n.part, n.note, Math.max(now, n.at + 0.005), SOURCE);
        n.sentOn = n.sentOff = true;
      }
      emit({ type: 'end', reason, title: a.title });
    }
    restore();
    return reason;
  }

  /** A whole new session arrived: the borrowed tracks are gone, never write them back. */
  function abandon() {
    borrowed = null;
    stop('load');
  }

  function tick() {
    const a = active;
    if (!a) {
      if (borrowed && timebase.now() >= tailUntil) { if (timer) { timers.clearInterval(timer); timer = null; } restore(); }
      return;
    }
    const now = timebase.now();
    const horizon = now + LOOKAHEAD;
    // note-ons in time order from a cursor; offs from the small sounding list
    while (a.next < a.notes.length && a.notes[a.next].on < horizon) {
      const n = a.notes[a.next++];
      n.at = Math.max(n.on, now);
      n.sentOn = true;
      router._engineOn(n.part, n.note, n.vel, n.at, SOURCE);
      a.sounding.push(n);
    }
    for (let i = a.sounding.length - 1; i >= 0; i--) {
      const n = a.sounding[i];
      const off = Math.max(n.off, n.at + 0.01);
      if (off >= horizon) continue;
      n.sentOff = true;
      router._engineOff(n.part, n.note, Math.max(off, now), SOURCE);
      a.sounding.splice(i, 1);
    }
    while (a.cue < a.cues.length && a.cues[a.cue].at <= now + 0.005) {
      const c = a.cues[a.cue++];
      emit({ type: 'cue', name: c.name, seconds: c.seconds, title: a.title });
    }
    if (a.next >= a.notes.length && !a.sounding.length && now >= a.end) {
      // the last note-off is out: keep the tracks a little longer for the tails
      emit({ type: 'end', reason: 'end', title: a.title });
      active = null;
      tailUntil = now + TAIL;
    }
  }

  function play(input, opts = {}) {
    const text = input == null || input === '' ? current : input;
    const receipt = check(text);
    if (!receipt.ok) return receipt;
    stop('restart');
    const voicing = opts.voicing || receipt.score.voicing || 'tint';
    const tracks = opts.tracks === 'share' ? 'share' : 'add';
    const count = (store.get('parts') || []).length;
    const plan = planTracks(receipt, count, { tracks });
    receipt.warnings = receipt.warnings.concat(plan.warnings);
    receipt.voicing = voicing;
    receipt.voices = receipt.voices.map((v) => ({ ...v, part: plan.partOf.get(v.voice) }));
    borrow(plan, receipt, voicing);
    receipt.tracks = plan.slots.map((s) => ({ part: s.part, name: s.name, added: s.add, kind: s.kind }));
    const spb = 60 / receipt.score.bpm;
    const start = timebase.now() + (voicing === 'patch' || plan.slots.some((s) => s.add) ? PATCH_LEAD : FREE_LEAD);
    const swing = receipt.score.swing || 0;
    const at = (beat) => start + swingBeat(beat, swing) * spb;
    const notes = [];
    for (const n of receipt.score.notes) {
      const part = plan.partOf.get(n.voice);
      if (part == null) continue;
      const note = plan.fallback.has(n.voice) ? percOnKit(n.voice) : n.midi;
      const on = at(n.beat);
      notes.push({ part, note, vel: n.vel, on, off: Math.max(on + 0.02, at(n.beat + n.len)), at: on, sentOn: false, sentOff: false });
    }
    notes.sort((x, y) => x.on - y.on);
    const cues = receipt.cues.map((c) => ({ ...c, at: start + c.seconds }));
    current = receipt.text;
    active = { notes, next: 0, sounding: [], cues, cue: 0, start, end: start + receipt.durationSeconds, title: receipt.score.title };
    receipt.startsIn = Math.round((start - timebase.now()) * 1000) / 1000;
    emit({ type: 'start', title: receipt.score.title, durationSeconds: receipt.durationSeconds });
    if (!timer) timer = timers.setInterval(tick, INTERVAL_MS);
    tick();
    return receipt;
  }

  // ---------------------------------------------------------------- borrowing

  function borrow(plan, receipt, voicing) {
    const parts = (store.get('parts') || []).slice();
    const keep = { parts: new Map(), added: new Set(), tempo: store.get('global.tempo') };
    // added tracks first (one write of the whole list), then the sounds
    const fresh = plan.slots.filter((s) => s.add);
    if (fresh.length) {
      const list = parts.slice();
      for (const s of fresh) {
        const p = defaultPart(list.length, { name: s.name, color: nextTrackColor(list) });
        p.id = newTrackId(list);
        list.push(p);
        keep.added.add(p.id);
      }
      store.set('parts', list, META);
    }
    const all = store.get('parts') || [];
    store.batch(() => {
      // a soloed track that is not in the score would silence it
      all.forEach((p, i) => {
        if (!p || !p.params || !p.params.solo || plan.slots.some((s) => s.part === i)) return;
        if (!keep.parts.has(p.id)) keep.parts.set(p.id, deepClone(p));
        store.set(`parts.${i}.params.solo`, 0, META);
      });
      for (const s of plan.slots) {
        const base = all[s.part];
        if (!base) continue;
        if (!keep.added.has(base.id) && !keep.parts.has(base.id)) keep.parts.set(base.id, deepClone(base));
        store.set(`parts.${s.part}`, voicedPart(base, s, receipt, voicing), META);
      }
      if (!store.get('ui.playing') && Number.isFinite(receipt.score.bpm)) store.set('global.tempo', Math.round(receipt.score.bpm), META);
    });
    borrowed = keep;
  }

  function restore() {
    tailUntil = -Infinity;
    if (!borrowed) return;
    const keep = borrowed;
    borrowed = null;
    const parts = store.get('parts') || [];
    store.batch(() => {
      parts.forEach((p, i) => { if (p && keep.parts.has(p.id)) store.set(`parts.${i}`, keep.parts.get(p.id), META); });
      if (keep.added.size) store.set('parts', (store.get('parts') || []).filter((p) => !keep.added.has(p.id)), META);
      if (keep.tempo != null && store.get('global.tempo') !== keep.tempo) store.set('global.tempo', keep.tempo, META);
    });
    const sel = store.get('ui.selectedPart');
    const n = (store.get('parts') || []).length;
    if (Number.isInteger(sel) && sel >= n) store.set('ui.selectedPart', Math.max(0, n - 1), META);
  }

  /** A serialized session with every borrowed track as it was (for the autosave). */
  function cleanState(state) {
    if (!borrowed || !state || !Array.isArray(state.parts)) return state;
    const keep = borrowed;
    const out = { ...state, parts: state.parts.filter((p) => !keep.added.has(p && p.id)).map((p) => (keep.parts.has(p && p.id) ? deepClone(keep.parts.get(p.id)) : p)) };
    if (keep.tempo != null && out.global) out.global = { ...out.global, tempo: keep.tempo };
    return out;
  }

  /** Where the score is: for oro.status(). */
  function status() {
    const a = active;
    if (!a) return { playing: false, restoring: !!borrowed };
    const now = timebase.now();
    const t = Math.max(0, now - a.start);
    const passed = a.cues.filter((c) => c.at <= now);
    return {
      playing: true, title: a.title, seconds: Math.round(t * 1000) / 1000,
      durationSeconds: Math.round((a.end - a.start) * 1000) / 1000,
      cue: passed.length ? passed[passed.length - 1].name : null,
    };
  }

  return {
    play(input, opts) { return play(input, opts); },
    stop() { stop('stop'); return { ok: true, stopped: true }; },
    compose(input) {
      const receipt = compose(input);
      if (receipt.ok) current = receipt.text;
      return receipt;
    },
    check,
    schema,
    /** Put a score on the desk without playing it (a #score= link). */
    load(text) {
      const r = check(text);
      if (r.ok) current = r.text;
      return r;
    },
    getScore: () => current,
    playing: () => !!active,
    borrowing: () => !!borrowed,
    status,
    cleanState,
    abandon,
    /** Stop when someone else adds, removes or moves tracks (not the desk itself). */
    tracksChanged(meta) { if ((active || borrowed) && !(meta && meta.source === SOURCE)) stop('tracks'); },
    panic(parts) { if (active || borrowed) stop('panic'); return parts; },
    dispose() { stop('dispose'); },
  };
}
