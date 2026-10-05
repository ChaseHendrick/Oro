// Score desk. oro.play / oro.compose for an agent, and the same thing from
// the page. A score is checked in score.js, then its notes are scheduled
// like the patch preview: a short timer, exact audio times, one note-off
// each. Track colour is borrowed for the duration and put back on stop,
// so a score does not become an undo step and does not keep the session.

import { deepClone } from '../core/store.js';
import { LOOKAHEAD, INTERVAL_MS, swingBeat } from './transport.js';
import { check, compose, schema } from './score.js';

const SOURCE = 'score';
const FREE_LEAD = 0.05;

const TINT = {
  terrain: { attack: 0.03, decay: 0.4, sustain: 0.7, release: 0.5, cutoff: 7000, filterType: 1, pluck: 0 },
  physical: { attack: 0.002, decay: 0.8, sustain: 0.15, release: 0.4, pluck: 0.85, pluckDecay: 1.4, cutoff: 6000, filterType: 1 },
  fm: { attack: 0.01, decay: 0.5, sustain: 0.4, release: 0.6, phaseMod: 0.45, phaseRatio: 2, cutoff: 8000, filterType: 1 },
  additive: { attack: 0.02, decay: 0.3, sustain: 0.8, release: 0.4, inharmAmount: 0.65, cutoff: 5000, filterType: 1 },
  subtractive: { attack: 0.01, decay: 0.25, sustain: 0.5, release: 0.3, cutoff: 1800, resonance: 0.35, filterType: 1 },
  wavetable: { attack: 0.01, decay: 0.3, sustain: 0.8, release: 0.3, cutoff: 400, filterType: 1 },
  vector: { attack: 0.4, decay: 0.6, sustain: 0.8, release: 1.2, cutoff: 2500, filterType: 1 },
  granular: { attack: 0.25, decay: 0.8, sustain: 0.6, release: 1.4, cutoff: 3200, filterType: 1, reverbSend: 0.45 },
  drum: {},
};

export function createScoreDesk({ store, router, timebase, timers }) {
  let current = '';
  let active = null;
  let timer = null;
  let snap = null;

  function stop(reason = 'stop') {
    const a = active;
    active = null;
    if (timer) { timers.clearInterval(timer); timer = null; }
    if (a) {
      const now = timebase.now();
      for (const n of a.notes) {
        if (n.sentOn && !n.sentOff) router._engineOff(n.part, n.note, Math.max(now, n.at + 0.005), SOURCE);
        n.sentOn = n.sentOff = true;
      }
    }
    restore();
    return reason;
  }

  function tick() {
    const a = active;
    if (!a) return;
    const now = timebase.now();
    const horizon = now + LOOKAHEAD;
    let open = false;
    for (const n of a.notes) {
      if (!n.sentOn) {
        if (n.on >= horizon) { open = true; continue; }
        n.at = Math.max(n.on, now);
        n.sentOn = true;
        router._engineOn(n.part, n.note, n.vel, n.at, SOURCE);
      }
      if (!n.sentOff) {
        const off = Math.max(n.off, n.at + 0.01);
        if (off >= horizon) { open = true; continue; }
        n.sentOff = true;
        router._engineOff(n.part, n.note, Math.max(off, now), SOURCE);
      }
    }
    if (!open && now >= a.end) stop('end');
  }

  function play(input) {
    const text = input == null || input === '' ? current : input;
    const receipt = check(text);
    if (!receipt.ok) return receipt;
    stop('restart');
    const plan = assign(store, receipt);
    receipt.warnings = receipt.warnings.concat(plan.warnings);
    receipt.voices = plan.voices;
    apply(plan);
    const spb = 60 / receipt.score.bpm;
    const start = timebase.now() + FREE_LEAD;
    const swing = receipt.score.swing || 0;
    const at = (beat) => start + swingBeat(beat, swing) * spb;
    const notes = [];
    for (const n of receipt.score.notes) {
      const part = plan.partOf.get(n.voice);
      if (part == null) continue;
      const on = at(n.beat);
      notes.push({
        part, note: n.midi, vel: n.vel, on, off: Math.max(on + 0.02, at(n.beat + n.len)),
        at: on, sentOn: false, sentOff: false,
      });
    }
    current = receipt.text;
    active = { notes, end: start + receipt.durationSeconds };
    if (!timer) timer = timers.setInterval(tick, INTERVAL_MS);
    tick();
    return receipt;
  }

  function apply(plan) {
    snap = new Map();
    const parts = store.get('parts') || [];
    store.batch(() => {
      for (let i = 0; i < parts.length; i++) {
        const solo = store.get(`parts.${i}.params.solo`);
        if (!plan.used.has(i) && !solo) continue;
        snap.set(i, shot(i));
        if (solo) store.set(`parts.${i}.params.solo`, 0, { source: 'score' });
      }
      for (const [part, tint] of plan.tints) {
        if (!snap.has(part)) snap.set(part, shot(part));
        store.set(`parts.${part}.params.mute`, 0, { source: 'score' });
        store.set(`parts.${part}.params.solo`, 0, { source: 'score' });
        store.set(`parts.${part}.name`, tint.name, { source: 'score' });
        store.set(`parts.${part}.drum.on`, tint.drum ? 1 : 0, { source: 'score' });
        for (const [k, v] of Object.entries(tint.params)) {
          store.set(`parts.${part}.params.${k}`, v, { source: 'score' });
        }
        if (tint.pan != null) store.set(`parts.${part}.params.pan`, tint.pan, { source: 'score' });
      }
    });
  }

  function shot(i) {
    return {
      params: deepClone(store.get(`parts.${i}.params`)),
      drumOn: store.get(`parts.${i}.drum.on`) ? 1 : 0,
      name: store.get(`parts.${i}.name`),
    };
  }

  function restore() {
    if (!snap) return;
    const saved = snap;
    snap = null;
    store.batch(() => {
      for (const [i, s] of saved) {
        store.set(`parts.${i}.params`, s.params, { source: 'score' });
        store.set(`parts.${i}.drum.on`, s.drumOn, { source: 'score' });
        store.set(`parts.${i}.name`, s.name, { source: 'score' });
      }
    });
  }

  return {
    play(input) { return play(input); },
    stop() { stop('stop'); return { ok: true, stopped: true }; },
    compose(input) {
      const receipt = compose(input);
      if (receipt.ok) current = receipt.text;
      return receipt;
    },
    schema,
    getScore: () => current,
    playing: () => !!active,
    dispose() { stop('dispose'); },
  };
}

function pack(voices, room, partOf, used, warnings) {
  if (!voices.length || room < 1) return;
  if (voices.length > room) {
    warnings.push({ line: 0, field: 'tracks', message: `${voices.length} desks share ${room} track${room === 1 ? '' : 's'}. Desks on one track use one colour.`, fix: 'Add tracks, or use fewer voices.' });
  }
  voices.forEach((v, i) => {
    const part = i % room;
    partOf.set(v, part);
    used.add(part);
  });
}

function assign(store, receipt) {
  const warnings = [];
  const parts = store.get('parts') || [];
  const n = parts.length;
  const voices = [];
  const partOf = new Map();
  const order = [];
  for (const v of receipt.voices) if (!order.includes(v.voice)) order.push(v.voice);
  const drums = order.filter((v) => receipt.voices.find((x) => x.voice === v).family === 'drum');
  const pitched = order.filter((v) => !drums.includes(v));
  const used = new Set();
  if (drums.length && pitched.length && n <= 1) {
    warnings.push({ line: 0, field: 'tracks', message: 'Only one track, so the kit and the notes share it. Drums will not sound like a kit.', fix: 'Add a track before playing a score with both.' });
    for (const v of order) partOf.set(v, 0);
    used.add(0);
  } else if (drums.length && n >= 1) {
    const drumPart = n - 1;
    used.add(drumPart);
    for (const v of drums) partOf.set(v, drumPart);
    const room = Math.max(0, n - 1);
    pack(pitched, room, partOf, used, warnings);
  } else {
    pack(pitched, n, partOf, used, warnings);
  }
  const tints = new Map();
  for (const [voice, part] of partOf) {
    const family = receipt.voices.find((x) => x.voice === voice).family;
    const prev = tints.get(part);
    const panNote = receipt.score.notes.find((note) => note.voice === voice && note.pan != null);
    if (!prev) {
      tints.set(part, {
        name: family === 'drum' ? 'Kit' : voice,
        drum: family === 'drum',
        params: { ...(TINT[family] || {}) },
        pan: panNote ? panNote.pan : null,
      });
    } else {
      prev.name = `${prev.name}+${voice}`.slice(0, 40);
      if (family !== 'drum' && prev.drum) {
        warnings.push({ line: 0, field: 'tracks', message: `${voice} shares the kit track, so it plays as a drum pad.`, fix: 'Add a track so pitched desks are not on the kit.' });
      }
    }
  }
  for (const v of receipt.voices) {
    voices.push({ ...v, part: partOf.get(v.voice) });
  }
  return { warnings, voices, partOf, tints, used };
}
