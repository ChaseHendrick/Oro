// The agent API (2.17): window.oro, for bots, agents and scripts.
//
// Everything a person can do from the panels, an agent can do from here,
// with plain arguments (names, not indices) and a receipt back:
//
//   oro.help()                          every method with its arguments and an example
//   oro.describe()                      the session in a few sentences (for a model to read)
//   oro.state()                         tempo, key, tracks, transport, score desk
//   score:  play, stop, compose, check, schema, getScore, status, render, link
//   sound:  params, get, set, setGlobal, patches, loadPatch, scenes, loadScene
//   tracks: tracks, addTrack, removeTrack, select
//   play:   start, note, chord, transport, pattern, panic
//   map:    dot, touch, show (the 3D map or a visualizer)
//   edit:   undo, redo
//   events: on('score' | 'step' | 'note', fn)
//
// The same calls work over postMessage (installBridge): send
//   { source: 'oro-agent', id, type: 'set', args: [0, 'cutoff', 1200] }
// and the page answers { source: 'oro', id, type, ok, result } (or error).
// Reading and the score desk work from any page; calls that change the
// session need the page opened with ?agent=1 (or #agent), so a page that
// merely embeds Oro cannot rewrite someone's work.

import { PART_PARAMS, GLOBAL_PARAMS, PART_PARAM_MAP, GLOBAL_PARAM_MAP, NOTE_NAMES, SCALE_NAMES, DOT_MODES, SEQ_STEPS, patternPath, defaultStep, clamp } from '../core/params.js';
import { deepClone } from '../core/store.js';
import * as tracksLib from '../core/tracks.js';
import { resolveVoice } from '../music/score.js';

export const API_VERSION = 2;
const META = Object.freeze({ source: 'agent' });
const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const VIEW_IDS = Object.freeze(['map', 'scope', 'spectrum', 'waterfall', 'vector', 'halo']);
const VIEW_NAMES = Object.freeze({ terrain: 'map', '3d': 'map', oscilloscope: 'scope', analyzer: 'spectrum', analyser: 'spectrum', spectrogram: 'waterfall', stereo: 'vector', 'stereo field': 'vector', goniometer: 'vector', ring: 'halo' });
const CHORD_IVS = { maj: [0, 4, 7], min: [0, 3, 7], m: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7], 7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], min7: [0, 3, 7, 10] };

/** Methods that change the session: over postMessage they need ?agent=1. */
export const MUTATING = Object.freeze(new Set([
  'set', 'setGlobal', 'loadPatch', 'loadScene', 'addTrack', 'removeTrack', 'select', 'note', 'chord', 'transport',
  'pattern', 'dot', 'touch', 'undo', 'redo', 'start', 'show',
]));

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const ok = (result = {}) => ({ ok: true, ...result });
const fail = (message, fix = '', extra = {}) => ({ ok: false, error: message, fix, ...extra });

/** 'A4' / 'C#3' / 'Bb2' / 69 -> MIDI note, or NaN. */
export function noteNumber(x) {
  if (typeof x === 'number') return Number.isFinite(x) ? Math.round(clamp(x, 0, 127)) : NaN;
  const m = String(x || '').trim().match(/^([A-Ga-g])([#b]?)(-?\d)$/);
  if (!m) return NaN;
  const pc = (LETTER[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  const n = (Number(m[3]) + 1) * 12 + pc;
  return n >= 0 && n <= 127 ? n : NaN;
}

/** 'D' / 'f#' / 'Bb' -> pitch class 0..11, or -1. */
export function pitchClass(name) {
  const m = String(name || '').trim().match(/^([A-Ga-g])([#b]?)$/);
  if (!m) return -1;
  return (LETTER[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
}

/** A parameter value from a number, a boolean or an option name. */
export function paramValue(def, value) {
  if (def.curve === 'enum' && typeof value === 'string') {
    const i = (def.options || []).findIndex((o) => String(o).toLowerCase() === value.trim().toLowerCase());
    if (i < 0) return { error: `"${value}" is not one of ${def.label}'s options.`, fix: `Use one of: ${(def.options || []).join(', ')}.` };
    return { value: i };
  }
  if (typeof value === 'boolean') value = value ? 1 : 0;
  const v = Number(value);
  if (!Number.isFinite(v)) return { error: `${def.label} needs a number.`, fix: `Give a number from ${def.min} to ${def.max}.` };
  let out = clamp(v, def.min, def.max);
  if (def.curve === 'int' || def.curve === 'enum' || def.curve === 'bool') out = Math.round(out);
  return { value: out, clamped: out !== v };
}

function describeParam(def, value) {
  const d = { id: def.id, label: def.label, group: def.group, min: def.min, max: def.max, default: def.default };
  if (def.unit) d.unit = def.unit;
  if (def.options) d.options = def.options.slice();
  if (def.hint) d.hint = def.hint;
  if (def.mod) d.modulatable = true;
  if (value !== undefined) d.value = value;
  return d;
}

/**
 * Build window.oro. deps: { store, engine, music, presets, visuals, getUi, version, timers }.
 * Every method returns a plain object (or a promise of one) with ok true or an error and a fix.
 */
export function createAgentApi({ store, engine = null, music = null, presets = null, visuals = null, getUi = () => null, version = '', timers = globalThis } = {}) {
  const parts = () => store.get('parts') || [];
  const ui = () => { try { return getUi() || null; } catch { return null; } };
  const listeners = { score: new Set(), step: new Set(), note: new Set() };
  if (music && typeof music.on === 'function') music.on('score', (e) => { for (const fn of listeners.score) try { fn(e); } catch { /* a listener's problem */ } });
  if (music && music.transport && typeof music.transport.on === 'function') {
    try { music.transport.on('step', (e) => { for (const fn of listeners.step) try { fn(e); } catch { /* ignore */ } }); } catch { /* optional */ }
  }
  if (music && music.router && typeof music.router.on === 'function') {
    try { music.router.on('note', (e) => { for (const fn of listeners.note) try { fn(e); } catch { /* ignore */ } }); } catch { /* optional */ }
  }

  /** A track by index, id, or name ('sel' = the selected one). */
  function track(t) {
    const list = parts();
    if (t == null || t === 'sel') return Math.max(0, Math.min(list.length - 1, Math.round(num(store.get('ui.selectedPart'), 0))));
    if (typeof t === 'number') return Number.isInteger(t) && t >= 0 && t < list.length ? t : -1;
    const s = String(t).toLowerCase();
    const i = list.findIndex((p) => p && (String(p.id).toLowerCase() === s || String(p.name).toLowerCase() === s));
    return i;
  }
  const noTrack = (t) => fail(`There is no track ${JSON.stringify(t)}.`, `Use an index from 0 to ${parts().length - 1}, a track name, or 'sel'.`);

  function summary(p, i) {
    return {
      index: i, id: p.id, name: p.name, patch: p.patchName || 'Init',
      drum: !!(p.drum && p.drum.on), mute: !!(p.params && p.params.mute), solo: !!(p.params && p.params.solo),
      level: p.params ? p.params.level : null, sequencer: !!p.seqOn,
      dot: { mode: DOT_MODES[Math.round(num(p.dot && p.dot.mode, 0))] || 'Pin', x: p.params ? p.params.centerX : 0.5, y: p.params ? p.params.centerY : 0.5 },
    };
  }

  const api = {
    version: API_VERSION,
    appVersion: version,

    help() {
      return ok({ version: API_VERSION, methods: HELP, postMessage: BRIDGE_HELP, scoreGrammar: 'oro.schema()' });
    },

    describe() {
      const g = store.get('global') || {};
      const list = parts();
      const key = `${NOTE_NAMES[Math.round(num(g.scaleRoot, 0))] || 'C'} ${SCALE_NAMES[Math.round(num(g.scaleType, 0))] || 'Major'}`;
      const lines = [
        `Oro ${version || ''} is a wave terrain synthesizer: each track's sound is the height of a 3D landscape read along a loop around a dot.`.replace('  ', ' '),
        `Tempo ${Math.round(num(g.tempo, 112))} BPM, key ${key}. The sequencer is ${store.get('ui.playing') ? 'playing' : 'stopped'}.`,
        `${list.length} track${list.length === 1 ? '' : 's'}: ${list.map((p, i) => `${i} "${p.name}" (${p.drum && p.drum.on ? 'drum kit' : p.patchName || 'Init'}${p.params && p.params.mute ? ', muted' : ''})`).join('; ')}.`,
      ];
      const st = music && music.score ? music.score.status() : null;
      if (st && st.playing) lines.push(`A score, "${st.title}", is playing (${st.seconds} of ${st.durationSeconds} s).`);
      lines.push('Call oro.help() for every method, oro.schema() for the score grammar.');
      return ok({ text: lines.join(' ') });
    },

    state() {
      const g = store.get('global') || {};
      return ok({
        tempo: g.tempo, key: NOTE_NAMES[Math.round(num(g.scaleRoot, 0))], scale: SCALE_NAMES[Math.round(num(g.scaleType, 0))],
        playing: !!store.get('ui.playing'), selected: track('sel'),
        audio: engine && engine.context ? engine.context.state : 'none',
        tracks: parts().map(summary),
        score: music && music.score ? music.score.status() : null,
      });
    },

    // ------------------------------------------------------------ score desk
    play(score, opts) { return music.score.play(score, opts || {}); },
    stop() { return music.score.stop(); },
    compose(opts) { return music.score.compose(opts || {}); },
    check(score) { return music.score.check(score); },
    schema() { return music.score.schema(); },
    getScore() { return music.score.getScore(); },
    status() { return ok(music.score.status()); },
    /** Offline render of a score: { ok, url (a blob URL of the WAV), stats }. download: true saves it too. */
    async render(score, opts = {}) {
      const [{ encodeScoreWav }, { renderScoreInBackground }] = await Promise.all([import('../music/score-render.js'), import('../music/score-render-host.js')]);
      const { download, onProgress, ...renderOpts } = opts;
      const r = await renderScoreInBackground(score == null ? music.score.getScore() : score, { ...renderOpts, onProgress });
      if (!r.ok) return r.receipt;
      const bytes = encodeScoreWav(r, { format: opts.bits === 32 || opts.format === 'float32' ? 'float32' : 'pcm24' });
      const blob = new Blob([bytes], { type: 'audio/wav' });
      const url = typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(blob) : null;
      if (download && url && typeof document !== 'undefined') {
        const a = document.createElement('a');
        a.href = url; a.download = `${String(r.receipt.score.title || 'oro-score').replace(/[^\w-]+/g, '-')}.wav`;
        document.body.appendChild(a); a.click(); a.remove();
      }
      return ok({ url, bytes: bytes.length, stats: r.stats, tracks: r.tracks, durationSeconds: r.receipt.durationSeconds, ranIn: r.ranIn, blob });
    },
    async link(score) {
      const { scoreLink } = await import('../music/score-export.js');
      const r = music.score.check(score == null ? music.score.getScore() : score);
      if (!r.ok) return r;
      return ok({ url: await scoreLink(r.text, typeof location !== 'undefined' ? location.origin + location.pathname : undefined), hash: r.hash });
    },

    // ----------------------------------------------------------------- sound
    params(t = 'sel') {
      if (t === 'global') {
        const g = store.get('global') || {};
        return ok({ params: GLOBAL_PARAMS.map((d) => describeParam(d, g[d.id])) });
      }
      const i = track(t);
      if (i < 0) return noTrack(t);
      const p = parts()[i].params || {};
      return ok({ track: i, params: PART_PARAMS.map((d) => describeParam(d, p[d.id])) });
    },
    get(path) {
      if (typeof path !== 'string') return fail('get needs a store path.', "Try 'global.tempo' or 'parts.0.params.cutoff'.");
      return ok({ path, value: deepClone(store.get(path)) });
    },
    /** set(track, 'cutoff', 1200) or set(track, { cutoff: 1200, resonance: 0.3 }). Clamped, undoable. */
    set(t, idOrValues, value) {
      const i = track(t);
      if (i < 0) return noTrack(t);
      const values = typeof idOrValues === 'object' && idOrValues ? idOrValues : { [idOrValues]: value };
      const done = {}, errors = [];
      store.batch(() => {
        for (const [id, v] of Object.entries(values)) {
          const def = PART_PARAM_MAP[id];
          if (!def) { errors.push({ param: id, error: `${id} is not a track parameter.`, fix: 'oro.params() lists them.' }); continue; }
          const r = paramValue(def, v);
          if (r.error) { errors.push({ param: id, error: r.error, fix: r.fix }); continue; }
          store.set(`parts.${i}.params.${id}`, r.value, META);
          done[id] = r.value;
        }
      });
      return { ok: errors.length === 0, track: i, set: done, errors };
    },
    setGlobal(idOrValues, value) {
      const values = typeof idOrValues === 'object' && idOrValues ? idOrValues : { [idOrValues]: value };
      const done = {}, errors = [];
      store.batch(() => {
        for (const [id, v] of Object.entries(values)) {
          const def = GLOBAL_PARAM_MAP[id];
          if (!def) { errors.push({ param: id, error: `${id} is not a global parameter.`, fix: "oro.params('global') lists them." }); continue; }
          const pc = id === 'scaleRoot' && typeof v === 'string' ? pitchClass(v) : null;
          if (pc === -1) { errors.push({ param: id, error: `"${v}" is not a key.`, fix: 'Use a note name such as D, F# or Bb.' }); continue; }
          const r = paramValue(def, pc ?? v);
          if (r.error) { errors.push({ param: id, error: r.error, fix: r.fix }); continue; }
          store.set(`global.${id}`, r.value, META);
          done[id] = r.value;
        }
      });
      return { ok: errors.length === 0, set: done, errors };
    },
    patches({ category, search } = {}) {
      if (!presets) return fail('The patch library is not loaded.');
      const q = search ? String(search).toLowerCase() : '';
      const list = presets.patches().filter((p) => (!category || String(p.category).toLowerCase() === String(category).toLowerCase())
        && (!q || p.name.toLowerCase().includes(q) || (p.tags || []).some((t) => t.toLowerCase().includes(q))));
      return ok({ categories: presets.categories(), patches: list.map((p) => ({ id: p.id, name: p.name, category: p.category, tags: p.tags })) });
    },
    loadPatch(t, nameOrId) {
      if (!presets) return fail('The patch library is not loaded.');
      const i = track(t);
      if (i < 0) return noTrack(t);
      const s = String(nameOrId || '').toLowerCase();
      const p = presets.patches().find((x) => x.id === nameOrId || x.name.toLowerCase() === s) || presets.patches().find((x) => x.name.toLowerCase().includes(s));
      if (!p) return fail(`No patch called "${nameOrId}".`, 'oro.patches({ search }) finds one.');
      presets.loadPatch(i, p.id);
      return ok({ track: i, patch: p.name });
    },
    scenes() {
      if (!presets) return fail('The patch library is not loaded.');
      return ok({ scenes: presets.scenes().map((s) => ({ id: s.id, name: s.name, tempo: s.tempo, key: s.key, description: s.description })) });
    },
    loadScene(nameOrId) {
      if (!presets) return fail('The patch library is not loaded.');
      const s = String(nameOrId || '').toLowerCase();
      const list = presets.scenes();
      const scene = list.find((x) => x.id === nameOrId || x.name.toLowerCase() === s) || list.find((x) => x.name.toLowerCase().includes(s));
      if (!scene) return fail(`No scene called "${nameOrId}".`, 'oro.scenes() lists them.');
      presets.loadScene(scene.id);
      return ok({ scene: scene.name });
    },

    // ---------------------------------------------------------------- tracks
    tracks() { return ok({ tracks: parts().map(summary) }); },
    addTrack({ patch, name } = {}) {
      const at = tracksLib.addTrack(store, { select: false });
      if (at < 0) return fail('All 16 tracks are in use.', 'Remove a track first.');
      if (name) tracksLib.renameTrack(store, at, String(name));
      if (patch) { const r = api.loadPatch(at, patch); if (!r.ok) return { ...r, track: at }; }
      return ok({ track: at, name: parts()[at].name });
    },
    removeTrack(t) {
      const i = track(t);
      if (i < 0) return noTrack(t);
      if (parts().length <= 1) return fail('The last track cannot be removed.');
      tracksLib.removeTrack(store, i);
      return ok({ removed: i });
    },
    select(t) {
      const i = track(t);
      if (i < 0) return noTrack(t);
      store.set('ui.selectedPart', i, { source: 'ui' });
      return ok({ selected: i });
    },

    // ------------------------------------------------------------------ play
    /** Start audio (browsers need a click on the page first; the desktop app does not). */
    async start() {
      const u = ui();
      const started = u && u.startAudio ? await u.startAudio() : engine && engine.start ? (await engine.start(), true) : false;
      return started ? ok({ audio: engine && engine.context ? engine.context.state : 'running' }) : fail('Audio did not start.', 'Click anywhere on the page once, then call oro.start() again.');
    },
    note(t, note, { vel = 0.8, dur = 0.5 } = {}) {
      const i = track(t);
      if (i < 0) return noTrack(t);
      const n = noteNumber(note);
      if (!Number.isFinite(n)) return fail(`"${note}" is not a note.`, 'Use a name like A4 or a MIDI number.');
      music.router.noteOn(i, n, clamp(num(vel, 0.8), 0, 1));
      timers.setTimeout(() => { try { music.router.noteOff(i, n); } catch { /* gone */ } }, Math.max(10, num(dur, 0.5) * 1000));
      return ok({ track: i, note: n, dur });
    },
    chord(t, notes, opts = {}) {
      let list = Array.isArray(notes) ? notes.map(noteNumber) : null;
      if (!list) {
        const m = String(notes || '').match(/^([A-G])([#b]?)(maj7|min7|sus2|sus4|maj|min|dim|aug|m7|7|m)?(\d)?$/);
        if (!m) return fail(`"${notes}" is not a chord.`, 'Use Cmaj, Am7, F#m4 or a list of notes.');
        const root = noteNumber(`${m[1]}${m[2] || ''}${m[4] || 4}`);
        list = (CHORD_IVS[m[3] || 'maj']).map((x) => root + x);
      }
      if (list.some((n) => !Number.isFinite(n))) return fail('One of the notes is not a note.');
      const results = list.map((n) => api.note(t, n, opts));
      return results.every((r) => r.ok) ? ok({ notes: list }) : results.find((r) => !r.ok);
    },
    /** transport('play' | 'stop' | 'toggle') or transport({ play, tempo }). */
    transport(cmd) {
      const tr = music && music.transport;
      if (!tr) return fail('The sequencer is not running here.');
      const o = typeof cmd === 'string' ? { [cmd]: true } : cmd || {};
      if (o.tempo != null) { const r = api.setGlobal('tempo', o.tempo); if (!r.ok) return r; }
      if (o.toggle) tr.toggle();
      else if (o.play === true || o.play === 'play') tr.play();
      else if (o.stop || o.play === false) tr.stop();
      return ok({ playing: tr.isPlaying(), tempo: store.get('global.tempo') });
    },
    /**
     * pattern(track, steps): the active pattern's 16 steps. Each step is null
     * (off), a scale degree (0 = the key's root), or { degree, octave, vel, gate, accent, slide }.
     */
    pattern(t, steps, { on = true } = {}) {
      const i = track(t);
      if (i < 0) return noTrack(t);
      if (!Array.isArray(steps)) return fail('pattern needs an array of up to 16 steps.', 'Example: [0, null, 2, null, 4, null, 2, null]');
      const path = patternPath(store, i);
      const old = (store.get(path) || {}).steps || [];
      const next = Array.from({ length: SEQ_STEPS }, (_, k) => {
        const base = { ...defaultStep(), ...(old[k] || {}) };
        const s = steps[k % Math.max(1, steps.length)];
        if (k >= steps.length && steps.length >= SEQ_STEPS) return base;
        if (s == null || s === false) return { ...base, on: 0 };
        if (typeof s === 'number') return { ...base, on: 1, degree: Math.round(s) };
        return { ...base, on: 1, ...Object.fromEntries(Object.entries(s).filter(([k2]) => ['degree', 'octave', 'vel', 'gate', 'accent', 'slide', 'prob', 'ratchet'].includes(k2))) };
      });
      store.batch(() => {
        store.set(`${path}.steps`, next, META);
        if (on) store.set(`parts.${i}.seqOn`, 1, META);
      });
      return ok({ track: i, steps: next.filter((s) => s.on).length });
    },
    panic() {
      const u = ui();
      if (u && u.panic) u.panic(); else if (music && music.router) music.router.allNotesOff();
      return ok();
    },

    // ------------------------------------------------------------------- map
    /** dot(track, { x, y, mode: 'roll', ... }): move the dot (0..1) and set what it does. */
    dot(t, { x, y, mode, gravity, friction, bounce, cruise } = {}) {
      const i = track(t);
      if (i < 0) return noTrack(t);
      const done = {};
      store.batch(() => {
        if (x != null) { store.set(`parts.${i}.params.centerX`, ((num(x, 0.5) % 1) + 1) % 1, { source: 'visual', user: true }); done.x = x; }
        if (y != null) { store.set(`parts.${i}.params.centerY`, ((num(y, 0.5) % 1) + 1) % 1, { source: 'visual', user: true }); done.y = y; }
        if (mode != null) {
          const m = typeof mode === 'number' ? mode : DOT_MODES.findIndex((d) => d.toLowerCase() === String(mode).toLowerCase());
          if (m >= 0 && m < DOT_MODES.length) { store.set(`parts.${i}.dot.mode`, m, META); done.mode = DOT_MODES[m]; }
        }
        for (const [k, v] of Object.entries({ gravity, friction, bounce, cruise })) {
          if (v != null && Number.isFinite(Number(v))) { store.set(`parts.${i}.dot.${k}`, clamp(Number(v), 0, k === 'bounce' ? 0.95 : 1), META); done[k] = v; }
        }
      });
      return ok({ track: i, ...done });
    },
    /** touch({ x, y, phase: 'down'|'move'|'up', mode: 'strum'|'fx' }): the touch tool, without a pointer. */
    touch({ x = 0.5, y = 0.5, phase = 'move', mode } = {}) {
      if (!visuals || typeof visuals.touch !== 'function') return fail('The touch tool needs the 3D map.');
      return ok(visuals.touch({ u: num(x, 0.5), v: num(y, 0.5), phase, mode }) || {});
    },

    /** show('map' | 'scope' | 'spectrum' | 'waterfall' | 'vector' | 'halo'): what the viewport shows (2.17.1). */
    show(name) {
      const s = String(name || '').trim().toLowerCase();
      const id = VIEW_NAMES[s] || s;
      if (!VIEW_IDS.includes(id)) return fail(`"${name}" is not a view.`, `Use one of: ${VIEW_IDS.join(', ')}.`);
      store.set('ui.visualizer', id, { source: 'ui' });
      return ok({ showing: id });
    },

    // ------------------------------------------------------------------ edit
    undo() { const u = ui(); if (!u || !u.history) return fail('Undo is not available here.'); u.history.undo(); return ok(); },
    redo() { const u = ui(); if (!u || !u.history) return fail('Redo is not available here.'); u.history.redo(); return ok(); },

    // ---------------------------------------------------------------- events
    /** on('score' | 'step' | 'note', fn) -> off(). Score events: start, cue, end. */
    on(type, fn) {
      if (!listeners[type] || typeof fn !== 'function') return () => {};
      listeners[type].add(fn);
      return () => listeners[type].delete(fn);
    },
    /** Which voice name a word means ('vln' -> 'violin'), or null. */
    voice(word) { return resolveVoice(word); },
  };
  return api;
}

/** Every method, for oro.help() (kept by hand next to the code above). */
export const HELP = Object.freeze([
  { name: 'help', args: '', returns: 'this list' },
  { name: 'describe', args: '', returns: '{ text } the session in a few sentences' },
  { name: 'state', args: '', returns: '{ tempo, key, scale, playing, tracks, score }' },
  { name: 'play', args: 'score text or JSON, { voicing: "patch"|"tint", tracks: "add"|"share" }', returns: 'receipt: ok, errors with fixes, cues in seconds, voices and their tracks', example: 'oro.play("bpm 120\\nbars 1\\npiano Cmaj 0 4 0.8")' },
  { name: 'stop', args: '', returns: '{ ok }' },
  { name: 'compose', args: '{ prompt, style, bpm, key, mode, bars, seed, voicing }', returns: 'receipt with text', example: 'oro.compose({ prompt: "anime opening song in D minor" })' },
  { name: 'check', args: 'score', returns: 'receipt (nothing plays)' },
  { name: 'schema', args: '', returns: 'voices, orchestra, drums, chords, styles, limits' },
  { name: 'status', args: '', returns: '{ playing, title, seconds, durationSeconds, cue }' },
  { name: 'render', args: 'score?, { bits: 24|32, quality, loudness, download }', returns: '{ url, stats } a WAV rendered offline', example: 'await oro.render(null, { bits: 32, download: true })' },
  { name: 'link', args: 'score?', returns: '{ url } that opens Oro with the score on the desk' },
  { name: 'params', args: "track | 'global'", returns: 'every parameter with range, unit, options and value' },
  { name: 'get', args: "store path, e.g. 'global.tempo'", returns: '{ value }' },
  { name: 'set', args: "track, id, value  or  track, { id: value }", returns: '{ set, errors } (clamped, undoable)', example: "oro.set(0, { cutoff: 1200, filterType: 'Ladder warm' })" },
  { name: 'setGlobal', args: "id, value  or  { id: value }", returns: '{ set, errors }', example: "oro.setGlobal({ tempo: 128, scaleRoot: 'D' })" },
  { name: 'patches', args: '{ category, search }', returns: '{ categories, patches }' },
  { name: 'loadPatch', args: 'track, name or id', returns: '{ patch }', example: "oro.loadPatch(0, 'Basalt Bass')" },
  { name: 'scenes', args: '', returns: '{ scenes }' },
  { name: 'loadScene', args: 'name or id', returns: '{ scene }' },
  { name: 'tracks', args: '', returns: '{ tracks }' },
  { name: 'addTrack', args: '{ patch, name }', returns: '{ track }' },
  { name: 'removeTrack', args: 'track', returns: '{ removed }' },
  { name: 'select', args: 'track', returns: '{ selected }' },
  { name: 'start', args: '', returns: 'starts audio (after a click on the page in a browser)' },
  { name: 'note', args: "track, 'A4' or 69, { vel, dur }", returns: '{ note }' },
  { name: 'chord', args: "track, 'Am7' or ['A3','C4','E4'], { vel, dur }", returns: '{ notes }' },
  { name: 'transport', args: "'play' | 'stop' | 'toggle' | { play, tempo }", returns: '{ playing, tempo }' },
  { name: 'pattern', args: 'track, [16 steps: null | degree | { degree, octave, vel, gate, accent, slide }]', returns: '{ steps }', example: 'oro.pattern(0, [0, null, 2, null, 4, null, 7, null])' },
  { name: 'panic', args: '', returns: 'stops every note' },
  { name: 'dot', args: "track, { x, y, mode: 'Pin'|'Roll'|'Drift'|'Explore'|'Tour'|'Pendulum', gravity, friction, bounce, cruise }", returns: '{ x, y, mode }', example: "oro.dot(0, { x: 0.3, y: 0.7, mode: 'Roll', cruise: 0.5 })" },
  { name: 'touch', args: "{ x, y, phase: 'down'|'move'|'up', mode: 'strum'|'fx' }", returns: 'what the touch did' },
  { name: 'show', args: "'map' | 'scope' | 'spectrum' | 'waterfall' | 'vector' | 'halo'", returns: '{ showing } what the viewport shows', example: "oro.show('spectrum')" },
  { name: 'undo', args: '', returns: '{ ok }' },
  { name: 'redo', args: '', returns: '{ ok }' },
  { name: 'on', args: "'score' | 'step' | 'note', fn", returns: 'an off() function' },
]);

export const BRIDGE_HELP = Object.freeze({
  send: "{ source: 'oro-agent', id: 'any', type: '<method>', args: [ ... ] }",
  reply: "{ source: 'oro', id, type, ok, result } or { ..., ok: false, error }",
  events: "{ source: 'oro-agent', type: 'subscribe', events: ['score', 'step'] } -> { source: 'oro', type: 'event', event, data }",
  permission: 'Reading and the score desk work from any page. Changing the session needs the Oro page opened with ?agent=1.',
});

/**
 * Answer postMessage calls with `api`. Returns a dispose function.
 * allowMutating(): whether calls in MUTATING may run (the page opted in).
 */
export function installBridge(win, api, { allowMutating = () => false } = {}) {
  const subscribers = [];
  const reply = (event, payload) => {
    try { event.source && event.source.postMessage({ source: 'oro', ...payload }, event.origin && event.origin !== 'null' ? event.origin : '*'); } catch { /* the other window has gone */ }
  };
  const forward = (kind) => (data) => {
    for (const s of subscribers) if (s.events.has(kind)) {
      try { s.target.postMessage({ source: 'oro', type: 'event', event: kind, data: JSON.parse(JSON.stringify(data ?? null)) }, s.origin); } catch { /* gone */ }
    }
  };
  const offs = ['score', 'step', 'note'].map((k) => api.on(k, forward(k)));
  async function onMessage(event) {
    const data = event.data;
    if (!data || data.source !== 'oro-agent' || typeof data.type !== 'string') return;
    const { id = null, type } = data;
    if (type === 'subscribe') {
      if (subscribers.length >= 8 || !event.source) { reply(event, { id, type, ok: false, error: 'Too many subscribers.' }); return; }
      const events = new Set((Array.isArray(data.events) ? data.events : ['score']).filter((e) => ['score', 'step', 'note'].includes(e)));
      subscribers.push({ target: event.source, origin: event.origin && event.origin !== 'null' ? event.origin : '*', events });
      reply(event, { id, type, ok: true, result: { events: [...events] } });
      return;
    }
    if (type === 'unsubscribe') {
      for (let i = subscribers.length - 1; i >= 0; i--) if (subscribers[i].target === event.source) subscribers.splice(i, 1);
      reply(event, { id, type, ok: true });
      return;
    }
    const fn = api[type];
    if (typeof fn !== 'function' || type === 'on') { reply(event, { id, type, ok: false, error: `Oro has no ${type}.`, fix: "Send type 'help' for the list." }); return; }
    if (MUTATING.has(type) && !allowMutating()) {
      reply(event, { id, type, ok: false, error: `${type} changes the session, so it needs the Oro page opened with ?agent=1.`, fix: 'Open Oro with ?agent=1 in its address, then send it again.' });
      return;
    }
    // 2.16 form: { type: 'play', score } and { type: 'compose', prompt, ... }
    let args = Array.isArray(data.args) ? data.args : null;
    if (!args) {
      if (type === 'play' || type === 'check' || type === 'render' || type === 'link') args = [data.score, data.options || {}];
      else if (type === 'compose') { const { source, id: _i, type: _t, ...rest } = data; args = [rest]; }
      else args = [];
    }
    try {
      const result = await fn(...args);
      const clean = result && typeof result === 'object' ? JSON.parse(JSON.stringify(result, (k, v) => (v instanceof Blob ? undefined : v))) : result;
      // the 2.16 reply carried `receipt`; keep it for old callers
      reply(event, { id, type, ok: !(clean && clean.ok === false), result: clean, receipt: clean });
    } catch (err) {
      reply(event, { id, type, ok: false, error: String(err && err.message || err) });
    }
  }
  win.addEventListener('message', onMessage);
  return () => { win.removeEventListener('message', onMessage); for (const off of offs) off(); };
}

/** True when the page was opened for agents (?agent=1, ?agent, or #agent). */
export function agentOptIn(loc = typeof location !== 'undefined' ? location : null) {
  if (!loc) return false;
  try {
    const q = new URLSearchParams(loc.search || '');
    if (q.has('agent') && q.get('agent') !== '0') return true;
  } catch { /* old browser */ }
  return /(^#|&)agent(=1)?($|&)/.test(loc.hash || '');
}
