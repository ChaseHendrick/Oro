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

import { PART_PARAMS, GLOBAL_PARAMS, PART_PARAM_MAP, GLOBAL_PARAM_MAP, NOTE_NAMES, SCALE_NAMES, DOT_MODES, SEQ_STEPS, RATCHET_MAX, patternPath, defaultStep, clamp } from '../core/params.js';
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
const record = (v) => v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const wrap = (v) => ((v % 1) + 1) % 1;

function optionsError(value, allowed, method) {
  if (!record(value)) return fail(`${method} needs an options object.`, `Use { ${allowed.join(', ')} }.`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) return fail(`Unknown ${method} option: ${unknown.join(', ')}.`, `Use only: ${allowed.join(', ')}.`);
  return null;
}

/** Resolve exact names/ids first; a partial name must identify just one item. */
function namedItem(list, nameOrId, kind, lookup) {
  if (typeof nameOrId !== 'string' || !nameOrId.trim()) return fail(`Give a ${kind} name or id.`, `${lookup} lists them.`);
  const q = nameOrId.trim().toLowerCase();
  const exact = list.find((item) => String(item.id).toLowerCase() === q || item.name.toLowerCase() === q);
  const matches = exact ? [exact] : list.filter((item) => item.name.toLowerCase().includes(q));
  if (matches.length === 1) return { item: matches[0] };
  return fail(matches.length ? `More than one ${kind} matches "${nameOrId}".` : `No ${kind} called "${nameOrId}".`, `Choose an exact name or id from ${lookup}.`, { matches: matches.map(({ id, name }) => ({ id, name })) });
}

/** 'A4' / 'C#3' / 'Bb2' / 69 -> MIDI note, or NaN. */
export function noteNumber(x) {
  if (typeof x === 'number') return Number.isInteger(x) && x >= 0 && x <= 127 ? x : NaN;
  const m = String(x || '').trim().match(/^([A-Ga-g])([#b]?)(-?\d)$/);
  if (!m) return NaN;
  const pc = LETTER[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
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
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return { error: `${def.label} needs a number.`, fix: `Give a number from ${def.min} to ${def.max}.` };
  const v = Number(value);
  if (!Number.isFinite(v)) return { error: `${def.label} needs a number.`, fix: `Give a number from ${def.min} to ${def.max}.` };
  let out = clamp(v, def.min, def.max);
  if (def.curve === 'int' || def.curve === 'enum' || def.curve === 'bool') out = Math.round(out);
  return { value: out, clamped: out !== v };
}

function describeParam(def, value) {
  const d = { id: def.id, label: def.label, group: def.group, curve: def.curve, min: def.min, max: def.max, default: def.default };
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
  const heldNotes = new Map(); // stable track id + pitch -> latest agent strike
  const indexOf = (id) => parts().findIndex((p) => p.id === id);
  function forgetNote(key, held) { timers.clearTimeout(held.timer); heldNotes.delete(key); }
  function clearNotes(release = false) {
    for (const [key, held] of [...heldNotes]) {
      forgetNote(key, held);
      if (!release) continue;
      const at = indexOf(held.id);
      if (at >= 0) try { music.router.noteOff(at, held.note, held.source); } catch { /* gone */ }
    }
  }
  store.subscribe('', (path) => {
    // The router keeps physically held keys across a same-id session load.
    // Timed agent notes are no longer held: release only their own sources.
    if (path === '') clearNotes(true);
    else if (path === 'parts') for (const [key, held] of heldNotes) if (indexOf(held.id) < 0) forgetNote(key, held);
  });
  if (music && typeof music.on === 'function') music.on('score', (e) => { for (const fn of listeners.score) try { fn(e); } catch { /* a listener's problem */ } });
  if (music && music.transport && typeof music.transport.on === 'function') {
    try { music.transport.on('step', (e) => { for (const fn of listeners.step) try { fn(e); } catch { /* ignore */ } }); } catch { /* optional */ }
  }
  if (music && music.router && typeof music.router.on === 'function') {
    try { music.router.on('note', (e) => { for (const fn of listeners.note) try { fn(e); } catch { /* ignore */ } }); } catch { /* optional */ }
    music.router.on('allOff', ({ parts: stopped }) => {
      for (const [key, held] of heldNotes) if (stopped.includes(indexOf(held.id))) forgetNote(key, held);
    });
  }

  /** A track by index, id, or name ('sel' = the selected one). */
  function track(t) {
    const list = parts();
    if (t == null || t === 'sel') return Math.max(0, Math.min(list.length - 1, Math.round(num(store.get('ui.selectedPart'), 0))));
    if (typeof t === 'number') return Number.isInteger(t) && t >= 0 && t < list.length ? t : -1;
    if (typeof t !== 'string') return -1;
    const s = t.trim().toLowerCase();
    const byId = list.findIndex((p) => p && String(p.id).toLowerCase() === s);
    if (byId >= 0) return byId;
    const matches = list.map((p, i) => p && String(p.name).toLowerCase() === s ? i : -1).filter((i) => i >= 0);
    return matches.length === 1 ? matches[0] : -1;
  }
  const noTrack = (t) => fail(`There is no unique track ${JSON.stringify(t)}.`, `Use an index from 0 to ${parts().length - 1}, a stable id from oro.tracks(), a unique track name, or 'sel'.`);

  function setParams(defs, idOrValues, value, path, extra = {}) {
    const values = record(idOrValues) ? idOrValues : typeof idOrValues === 'string' && idOrValues ? { [idOrValues]: value } : null;
    if (!values || !Object.keys(values).length) return fail('Give a parameter name and value, or a non-empty parameter object.', 'Use oro.params() or oro.params(\'global\') to discover parameters.', { ...extra, set: {}, errors: [] });
    const done = {}, errors = [];
    for (const [id, v] of Object.entries(values)) {
      const def = Object.hasOwn(defs, id) ? defs[id] : null;
      if (!def) { errors.push({ param: id, error: `${id} is not a ${path === 'global' ? 'global' : 'track'} parameter.`, fix: path === 'global' ? "oro.params('global') lists them." : 'oro.params() lists them.' }); continue; }
      const pc = path === 'global' && id === 'scaleRoot' && typeof v === 'string' ? pitchClass(v) : null;
      if (pc === -1) { errors.push({ param: id, error: `"${v}" is not a key.`, fix: 'Use a note name such as D, F# or Bb.' }); continue; }
      const r = paramValue(def, pc ?? v);
      if (r.error) { errors.push({ param: id, error: r.error, fix: r.fix }); continue; }
      done[id] = r.value;
    }
    if (errors.length) return fail('No parameters changed: the batch has invalid values.', 'Correct errors and send the complete batch again.', { ...extra, set: {}, errors });
    store.batch(() => { for (const [id, v] of Object.entries(done)) store.set(`${path}.${id}`, v, META); });
    return ok({ ...extra, set: done, errors: [] });
  }

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
      return ok({ version: API_VERSION, docs: 'docs/AGENT-API.md', methods: HELP.map((m) => ({ ...m, requiresAgentOptIn: MUTATING.has(m.name) })), postMessage: { ...BRIDGE_HELP }, scoreGrammar: 'oro.schema()', validation: { parameterBatches: 'atomic; invalid batches do not change any parameter', numbers: 'parameter numbers clamp to their discovered range', coordinates: 'finite terrain coordinates wrap into [0, 1)', patterns: '1..16 steps; shorter lists repeat to fill 16' } });
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
      return setParams(PART_PARAM_MAP, idOrValues, value, `parts.${i}.params`, { track: i });
    },
    setGlobal(idOrValues, value) {
      return setParams(GLOBAL_PARAM_MAP, idOrValues, value, 'global');
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
      const r = namedItem(presets.patches(), nameOrId, 'patch', 'oro.patches({ search })');
      if (!r.item) return r;
      const p = r.item;
      presets.loadPatch(i, p.id);
      return ok({ track: i, patch: p.name });
    },
    scenes() {
      if (!presets) return fail('The patch library is not loaded.');
      return ok({ scenes: presets.scenes().map((s) => ({ id: s.id, name: s.name, tempo: s.tempo, key: s.key, description: s.description })) });
    },
    loadScene(nameOrId) {
      if (!presets) return fail('The patch library is not loaded.');
      const r = namedItem(presets.scenes(), nameOrId, 'scene', 'oro.scenes()');
      if (!r.item) return r;
      const scene = r.item;
      presets.loadScene(scene.id);
      return ok({ scene: scene.name });
    },

    // ---------------------------------------------------------------- tracks
    tracks() { return ok({ tracks: parts().map(summary) }); },
    addTrack(opts = {}) {
      const error = optionsError(opts, ['patch', 'name'], 'addTrack');
      if (error) return error;
      const { patch, name } = opts;
      if (name !== undefined && (typeof name !== 'string' || !name.trim())) return fail('The track name must be a non-empty string.');
      let patchId;
      if (patch !== undefined) {
        if (!presets) return fail('The patch library is not loaded.');
        const r = namedItem(presets.patches(), patch, 'patch', 'oro.patches({ search })');
        if (!r.item) return r;
        patchId = r.item.id;
      }
      const at = tracksLib.addTrack(store, { select: false });
      if (at < 0) return fail('All 16 tracks are in use.', 'Remove a track first.');
      if (name) tracksLib.renameTrack(store, at, String(name));
      if (patchId !== undefined) presets.loadPatch(at, patchId);
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
    note(t, note, opts = {}) {
      const i = track(t);
      if (i < 0) return noTrack(t);
      const error = optionsError(opts, ['vel', 'dur'], 'note');
      if (error) return error;
      const { vel = 0.8, dur = 0.5 } = opts;
      if (!finite(vel) || vel < 0 || vel > 1) return fail('Note velocity must be a number from 0 to 1.');
      if (!finite(dur) || dur <= 0 || dur * 1000 > 2147483647) return fail('Note duration must be a positive finite number of seconds within the timer limit.');
      const n = noteNumber(note);
      if (!Number.isFinite(n)) return fail(`"${note}" is not a note.`, 'Use a name like A4 or a MIDI number.');
      if (!music || !music.router) return fail('The note router is not available here.');
      const id = parts()[i].id, key = `${id}:${n}`;
      const previous = heldNotes.get(key);
      if (previous) { forgetNote(key, previous); music.router.noteOff(i, n, previous.source); }
      const held = { id, note: n, source: `agent:${id}` };
      music.router.noteOn(i, n, vel, held.source);
      heldNotes.set(key, held);
      held.timer = timers.setTimeout(() => {
        if (heldNotes.get(key) !== held) return;
        heldNotes.delete(key);
        const at = indexOf(id);
        if (at >= 0) try { music.router.noteOff(at, n, held.source); } catch { /* gone */ }
      }, Math.max(10, dur * 1000));
      return ok({ track: i, note: n, vel, dur: Math.max(0.01, dur) });
    },
    chord(t, notes, opts = {}) {
      let list = Array.isArray(notes) ? notes.map(noteNumber) : null;
      if (!list) {
        const m = String(notes || '').match(/^([A-G])([#b]?)(maj7|min7|sus2|sus4|maj|min|dim|aug|m7|7|m)?(\d)?$/);
        if (!m) return fail(`"${notes}" is not a chord.`, 'Use Cmaj, Am7, F#m4 or a list of notes.');
        const root = noteNumber(`${m[1]}${m[2] || ''}${m[4] || 4}`);
        list = (CHORD_IVS[m[3] || 'maj']).map((x) => root + x);
      }
      if (!list.length || list.some((n) => !Number.isInteger(n) || n < 0 || n > 127)) return fail('A chord needs one or more valid MIDI notes from 0 to 127.', 'Use note names like C4 or integer MIDI numbers.');
      list = [...new Set(list)];
      const results = list.map((n) => api.note(t, n, opts));
      return results.every((r) => r.ok) ? ok({ notes: list }) : results.find((r) => !r.ok);
    },
    /** transport('play' | 'stop' | 'toggle') or transport({ play, tempo }). */
    transport(cmd) {
      const tr = music && music.transport;
      if (!tr) return fail('The sequencer is not running here.');
      if (typeof cmd === 'string' && !['play', 'stop', 'toggle'].includes(cmd)) return fail(`Unknown transport command "${cmd}".`, "Use 'play', 'stop', 'toggle', or { play: true, tempo: 120 }.");
      const o = typeof cmd === 'string' ? { [cmd]: true } : cmd;
      const error = optionsError(o, ['play', 'stop', 'toggle', 'tempo'], 'transport');
      if (error) return error;
      if (!Object.keys(o).length) return fail('Give a transport command or tempo.');
      if (Object.entries(o).some(([key, value]) => key !== 'tempo' && typeof value !== 'boolean')) return fail('Transport play, stop and toggle must be booleans.');
      const controls = ['play', 'stop', 'toggle'].filter((key) => Object.hasOwn(o, key));
      if (controls.length > 1) return fail('Give one transport action at a time.', "Use { play: false } to stop, or { play: true, tempo: 120 } to start.");
      if (Object.hasOwn(o, 'tempo')) { const r = api.setGlobal('tempo', o.tempo); if (!r.ok) return r; }
      if (o.toggle) tr.toggle();
      else if (o.play === true || o.play === 'play') tr.play();
      else if (o.stop || o.play === false) tr.stop();
      return ok({ playing: tr.isPlaying(), tempo: store.get('global.tempo') });
    },
    /**
     * pattern(track, steps): the active pattern's 16 steps. Each step is null
     * (off), a scale degree (0 = the key's root), or { degree, octave, vel, gate, accent, slide }.
     */
    pattern(t, steps, opts = {}) {
      const i = track(t);
      if (i < 0) return noTrack(t);
      const error = optionsError(opts, ['on'], 'pattern');
      if (error) return error;
      const { on = true } = opts;
      if (typeof on !== 'boolean') return fail('Pattern on must be a boolean.');
      if (!Array.isArray(steps) || !steps.length || steps.length > SEQ_STEPS) return fail('pattern needs an array of 1 to 16 steps.', 'Example: [0, null, 2, null, 4, null, 2, null]. Shorter arrays repeat.');
      const fields = { degree: [-21, 28, true], octave: [-2, 2, true], vel: [0, 1], gate: [0.05, 1], accent: [0, 1, true], slide: [0, 1, true], prob: [0, 1], ratchet: [1, RATCHET_MAX, true] };
      const validated = [];
      for (let k = 0; k < steps.length; k++) {
        const s = steps[k];
        if (s === null || s === false) { validated.push(null); continue; }
        const v = typeof s === 'number' ? { degree: s } : s;
        const err = optionsError(v, Object.keys(fields), `step ${k}`);
        if (err) return err;
        const step = {};
        for (const [id, value] of Object.entries(v)) {
          const [min, max, integer] = fields[id];
          const n = (id === 'accent' || id === 'slide') && typeof value === 'boolean' ? Number(value) : value;
          if (!finite(n) || n < min || n > max || (integer && !Number.isInteger(n))) return fail(`Step ${k} ${id} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}.`, 'Correct the step and send the pattern again.');
          step[id] = n;
        }
        validated.push(step);
      }
      const path = patternPath(store, i);
      const old = (store.get(path) || {}).steps || [];
      const next = Array.from({ length: SEQ_STEPS }, (_, k) => {
        const base = { ...defaultStep(), ...(old[k] || {}) };
        const s = validated[k % validated.length];
        return s === null ? { ...base, on: 0 } : { ...base, on: 1, ...s };
      });
      store.batch(() => {
        store.set(`${path}.steps`, next, META);
        if (on) store.set(`parts.${i}.seqOn`, 1, META);
      });
      return ok({ track: i, steps: next.filter((s) => s.on).length });
    },
    panic() {
      clearNotes();
      const u = ui();
      if (u && u.panic) u.panic(); else if (music && music.router) music.router.allNotesOff();
      return ok();
    },

    // ------------------------------------------------------------------- map
    /** dot(track, { x, y, mode: 'roll', ... }): move the dot (0..1) and set what it does. */
    dot(t, opts = {}) {
      const i = track(t);
      if (i < 0) return noTrack(t);
      const error = optionsError(opts, ['x', 'y', 'mode', 'gravity', 'friction', 'bounce', 'cruise'], 'dot');
      if (error) return error;
      const { x, y, mode, gravity, friction, bounce, cruise } = opts;
      const done = {};
      for (const [key, v] of Object.entries({ x, y, gravity, friction, bounce, cruise })) {
        if (v === undefined) continue;
        if (!finite(v)) return fail(`Dot ${key} must be a finite number.`, 'Nothing changed; correct the options and send again.');
        done[key] = key === 'x' || key === 'y' ? wrap(v) : clamp(v, 0, key === 'bounce' ? 0.95 : 1);
      }
      let m;
      if (mode !== undefined) {
        m = Number.isInteger(mode) ? mode : typeof mode === 'string' ? DOT_MODES.findIndex((d) => d.toLowerCase() === mode.trim().toLowerCase()) : -1;
        if (m < 0 || m >= DOT_MODES.length) return fail(`"${mode}" is not a dot mode.`, `Use one of: ${DOT_MODES.join(', ')}.`);
        done.mode = DOT_MODES[m];
      }
      store.batch(() => {
        if (x !== undefined) store.set(`parts.${i}.params.centerX`, done.x, { source: 'visual', user: true });
        if (y !== undefined) store.set(`parts.${i}.params.centerY`, done.y, { source: 'visual', user: true });
        if (m !== undefined) store.set(`parts.${i}.dot.mode`, m, META);
        for (const k of ['gravity', 'friction', 'bounce', 'cruise']) if (Object.hasOwn(done, k)) store.set(`parts.${i}.dot.${k}`, done[k], META);
      });
      return ok({ track: i, ...done });
    },
    /** touch({ x, y, phase: 'down'|'move'|'up', mode: 'strum'|'fx' }): the touch tool, without a pointer. */
    touch(opts = {}) {
      const error = optionsError(opts, ['x', 'y', 'phase', 'mode'], 'touch');
      if (error) return error;
      const { x = 0.5, y = 0.5, phase = 'move', mode } = opts;
      if (!finite(x) || !finite(y)) return fail('Touch x and y must be finite numbers.');
      if (!['down', 'move', 'up'].includes(phase)) return fail(`"${phase}" is not a touch phase.`, "Use 'down', 'move', or 'up'.");
      if (mode !== undefined && !['strum', 'fx'].includes(mode)) return fail(`"${mode}" is not a touch mode.`, "Use 'strum' or 'fx'.");
      if (!visuals || typeof visuals.touch !== 'function') return fail('The touch tool needs the 3D map.');
      return ok(visuals.touch({ u: wrap(x), v: wrap(y), phase, mode }) || {});
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
  { name: 'getScore', args: '', returns: 'the current score on the desk' },
  { name: 'voice', args: 'voice name or alias', returns: "canonical voice name or null", example: "oro.voice('vln')" },
  { name: 'status', args: '', returns: '{ playing, title, seconds, durationSeconds, cue }' },
  { name: 'render', args: 'score?, { bits: 24|32, quality, loudness, download }', returns: '{ url, stats } a WAV rendered offline', example: 'await oro.render(null, { bits: 32, download: true })' },
  { name: 'link', args: 'score?', returns: '{ url } that opens Oro with the score on the desk' },
  { name: 'params', args: "track | 'global'", returns: 'every parameter with range, unit, options and value' },
  { name: 'get', args: "store path, e.g. 'global.tempo'", returns: '{ value }' },
  { name: 'set', args: "track, id, value  or  track, { id: value }", returns: '{ set, errors } (atomic, clamped, undoable)', example: "oro.set(0, { cutoff: 1200, filterType: 'Ladder warm' })" },
  { name: 'setGlobal', args: "id, value  or  { id: value }", returns: '{ set, errors } (atomic, clamped)', example: "oro.setGlobal({ tempo: 128, scaleRoot: 'D' })" },
  { name: 'patches', args: '{ category, search }', returns: '{ categories, patches }' },
  { name: 'loadPatch', args: 'track, name or id', returns: '{ patch }', example: "oro.loadPatch(0, 'Basalt Bass')" },
  { name: 'scenes', args: '', returns: '{ scenes }' },
  { name: 'loadScene', args: 'name or id', returns: '{ scene }' },
  { name: 'tracks', args: '', returns: '{ tracks }' },
  { name: 'addTrack', args: '{ patch, name }', returns: '{ track }' },
  { name: 'removeTrack', args: 'track', returns: '{ removed }' },
  { name: 'select', args: 'track', returns: '{ selected }' },
  { name: 'start', args: '', returns: 'starts audio (after a click on the page in a browser)' },
  { name: 'note', args: "track, 'A4' or integer MIDI 0..127, { vel: 0..1, dur: positive seconds }", returns: '{ note, vel, dur }' },
  { name: 'chord', args: "track, 'Am7' or ['A3','C4','E4'], { vel, dur }", returns: '{ notes }' },
  { name: 'transport', args: "'play' | 'stop' | 'toggle' | { play, tempo }", returns: '{ playing, tempo }' },
  { name: 'pattern', args: 'track, [1..16 steps: null | degree | { degree, octave, vel, gate, accent, slide, prob, ratchet }], { on: boolean }', returns: '{ steps } (short lists repeat; invalid steps change nothing)', example: 'oro.pattern(0, [0, null, 2, null, 4, null, 7, null])' },
  { name: 'panic', args: '', returns: 'stops every note' },
  { name: 'dot', args: "track, { x, y, mode: 'Pin'|'Roll'|'Drift'|'Explore'|'Tour'|'Pendulum', gravity, friction, bounce, cruise }", returns: '{ x, y, mode }', example: "oro.dot(0, { x: 0.3, y: 0.7, mode: 'Roll', cruise: 0.5 })" },
  { name: 'touch', args: "{ x, y, phase: 'down'|'move'|'up', mode: 'strum'|'fx' }", returns: 'what the touch did; send up to release', example: "oro.touch({ x: 0.3, y: 0.7, phase: 'down', mode: 'strum' })" },
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
  args: 'When supplied, args must be an array. Failure replies include error, fix, and the result receipt.',
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
      const requested = data.events === undefined ? ['score'] : data.events;
      if (!Array.isArray(requested) || !requested.length || requested.some((e) => !['score', 'step', 'note'].includes(e))) { reply(event, { id, type, ok: false, error: 'Subscribe events must be a non-empty array of score, step or note.', fix: "Use events: ['score']." }); return; }
      const origin = event.origin && event.origin !== 'null' ? event.origin : '*';
      const existing = subscribers.find((s) => s.target === event.source && s.origin === origin);
      if ((!existing && subscribers.length >= 8) || !event.source) { reply(event, { id, type, ok: false, error: 'Too many subscribers.' }); return; }
      const events = new Set(requested);
      if (existing) existing.events = events;
      else subscribers.push({ target: event.source, origin, events });
      reply(event, { id, type, ok: true, result: { events: [...events] } });
      return;
    }
    if (type === 'unsubscribe') {
      for (let i = subscribers.length - 1; i >= 0; i--) if (subscribers[i].target === event.source) subscribers.splice(i, 1);
      reply(event, { id, type, ok: true });
      return;
    }
    const fn = Object.hasOwn(api, type) && HELP.some((m) => m.name === type) ? api[type] : null;
    if (typeof fn !== 'function' || type === 'on') { reply(event, { id, type, ok: false, error: `Oro has no ${type}.`, fix: "Send type 'help' for the list." }); return; }
    if (MUTATING.has(type) && !allowMutating()) {
      reply(event, { id, type, ok: false, error: `${type} changes the session, so it needs the Oro page opened with ?agent=1.`, fix: 'Open Oro with ?agent=1 in its address, then send it again.' });
      return;
    }
    // 2.16 form: { type: 'play', score } and { type: 'compose', prompt, ... }
    if (Object.hasOwn(data, 'args') && !Array.isArray(data.args)) { reply(event, { id, type, ok: false, error: 'Message args must be an array.', fix: "Use args: [ ... ] or omit args for a method with no arguments." }); return; }
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
      reply(event, { id, type, ok: !(clean && clean.ok === false), result: clean, receipt: clean, ...(clean && clean.ok === false ? { error: clean.error || 'The call failed; see result.errors.', fix: clean.fix || '' } : {}) });
    } catch (err) {
      reply(event, { id, type, ok: false, error: String(err && err.message || err) });
    }
  }
  win.addEventListener('message', onMessage);
  return () => { win.removeEventListener('message', onMessage); subscribers.length = 0; for (const off of offs) off(); };
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
