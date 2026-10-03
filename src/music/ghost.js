// v2.9 Ghost replay: record what a person plays on one track (keys and MIDI
// notes, knob moves, the dot path) in transport beats, then let it play back
// on that track in a loop while the transport runs.
//
// Recording listens, it never changes anything:
//   * notes: the router's 'sched' events of that track from people (keys,
//     MIDI, the computer keyboard...) and from its arpeggiator, so what was
//     heard is what comes back;
//   * knobs: store writes to parts.N.params.X with source 'ui' or 'midi'
//     (mute, solo and the pedal routing are left out);
//   * the dot: centerX / centerY written by a person, at most DOT_HZ times a
//     second and only when it moves.
// The length runs from the bar recording started in to Stop, rounded up to
// whole bars (GHOST_MAX_BARS at most; it stops by itself there or at
// GHOST_MAX_EVENTS events). The ghost is stored as parts.N.ghost.
//
// Replay rides its own lookahead timer, like the sequencer: notes go to the
// engine with the 'ghost' source at exact audio times, knob values and the dot
// as timed engine params messages (never the store, so the knobs keep their
// own values and Undo is untouched). Stop, a stopped transport, or a removed
// ghost sends the track's own values back.

import { isPersonSource } from './capture.js';
import { GHOST_MAX_BARS, GHOST_MAX_EVENTS, ghostParam, sanitizeGhost, lowerBound, dotAtBeat, ghostSummary } from './ghost-data.js';
import { createEmitter } from './emitter.js';

export const DOT_HZ = 30;
export const TICK_MS = 25;
const SOURCE = 'ghost';
const GAP = 0.003;   // seconds between a ghost note-off and a new note-on

export function createGhosts({ store, router, transport, timebase, timers }) {
  const emitter = createEmitter();
  let rec = null;                 // the recording in progress
  const playing = new Map();      // track id -> { frontier, sounding: Set, touched: Set }
  let timer = null;

  const parts = () => (Array.isArray(store.get('parts')) ? store.get('parts') : []);
  const idOf = (p) => parts()[p]?.id;
  const indexOf = (id) => parts().findIndex(t => t && t.id === id);
  const nowBeat = (t = timebase.now()) => transport.beatAt(t);
  const ghostOf = (p) => sanitizeOrNull(store.get(`parts.${p}.ghost`));
  const cache = new WeakMap();
  function sanitizeOrNull(g) {
    if (!g || typeof g !== 'object') return null;
    // the store holds sanitized ghosts (migrate.js); keep the arrays sorted copies once
    if (!cache.has(g)) cache.set(g, sanitizeGhost(g));
    return cache.get(g);
  }
  const changed = (detail) => emitter.emit('change', detail || {});

  function ensureTimer() {
    if (!timer && (rec || playing.size)) timer = timers.setInterval(tick, TICK_MS);
  }
  function stopTimer() {
    if (timer && !rec && !playing.size) { timers.clearInterval(timer); timer = null; }
  }

  // ---------------------------------------------------------------- recording

  function record(part) {
    const id = idOf(part);
    if (typeof id !== 'string') return { ok: false, message: 'There is no track to record a ghost on.' };
    if (rec) stopRecording();
    if (playing.has(id)) stop(part);
    if (!transport.isPlaying()) transport.play();
    const b = Math.max(0, nowBeat());
    const startBar = Math.floor(b / 4);
    rec = {
      id, startBeat: startBar * 4, startBar, lastBeat: b,
      params0: { ...(store.get(`parts.${part}.params`) || {}) },
      notes: [], knobs: [], dots: [], count: 0, held: new Set(),
      lastKnob: new Map(), dotSec: -1, dotLast: null, dotPending: null, dotWriteSec: -1,
    };
    ensureTimer();
    changed({ part, kind: 'record' });
    return { ok: true, message: `Recording a ghost from bar ${startBar + 1}. Play notes, turn knobs or move the dot, then press Stop recording.` };
  }

  const relBeat = (t) => Math.max(0, nowBeat(t) - rec.startBeat);
  function full() {
    if (rec.count < GHOST_MAX_EVENTS) return false;
    queueAutoStop('events');
    return true;
  }
  let autoStop = null;
  function queueAutoStop(why) {
    if (autoStop) return;
    autoStop = why;
    timers.setTimeout(() => { const w = autoStop; autoStop = null; if (rec) stopRecording({ why: w }); }, 0);
  }

  const offs = [];
  if (router && typeof router.on === 'function') {
    offs.push(router.on('sched', (e) => {
      if (!rec || !e || full()) return;
      if (!(isPersonSource(e.source) || e.source === 'arp')) return;
      if (idOf(e.part) !== rec.id) return;
      const b = relBeat(e.time > 0 ? e.time : timebase.now());
      if (e.on) { rec.notes.push([b, e.note, e.vel]); rec.held.add(e.note); } else { rec.notes.push([b, e.note, 0]); rec.held.delete(e.note); }
      rec.count++;
    }));
  }
  offs.push(store.subscribe('parts', (path, value, meta) => {
    if (!rec) return;
    const m = /^parts\.(\d+)\.params\.(\w+)$/.exec(path);
    if (!m || idOf(Number(m[1])) !== rec.id || typeof value !== 'number' || !Number.isFinite(value)) return;
    const src = meta && meta.source, id = m[2];
    const person = src === 'ui' || (typeof src === 'string' && src.startsWith('midi'));
    if (id === 'centerX' || id === 'centerY') {
      if (person || (src === 'visual' && meta.user === true)) dotMoved(Number(m[1]));
      return;
    }
    if (!person || !ghostParam(id) || full()) return;
    const sec = timebase.now(), b = relBeat(sec);
    const last = rec.lastKnob.get(id);
    // A knob drag writes every frame: keep about 60 values a second.
    if (last && sec - last.sec < 1 / 60) { last.e[2] = value; return; }
    const e = [b, id, value];
    rec.knobs.push(e);
    rec.lastKnob.set(id, { sec, e });
    rec.count++;
  }));

  function dotMoved(p) {
    const x = Number(store.get(`parts.${p}.params.centerX`)), y = Number(store.get(`parts.${p}.params.centerY`));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const sec = timebase.now(), b = relBeat(sec);
    // After a still moment, hold the old spot until now so replay does not drift towards the new one.
    if (rec.dotLast && rec.dotWriteSec >= 0 && sec - rec.dotWriteSec > 0.1 && !rec.dotPending) {
      const bpsec = 1 / (60 / (transport.tempo ? transport.tempo() : 120));
      pushDot(Math.max(rec.dotLast[0], b - bpsec / DOT_HZ), rec.dotLast[1], rec.dotLast[2]);
    }
    rec.dotWriteSec = sec;
    if (rec.dotSec >= 0 && sec - rec.dotSec < 1 / DOT_HZ) { rec.dotPending = [b, x, y]; return; }
    rec.dotPending = null;
    if (rec.dotLast && Math.abs(rec.dotLast[1] - x) < 1e-4 && Math.abs(rec.dotLast[2] - y) < 1e-4) return;
    rec.dotSec = sec;
    pushDot(b, x, y);
  }
  function pushDot(b, x, y) {
    if (full()) return;
    const e = [b, x, y];
    rec.dots.push(e);
    rec.dotLast = e;
    rec.count++;
  }

  /** Stop recording: the ghost replaces the track's old one (unless nothing was played). */
  function stopRecording({ why } = {}) {
    if (!rec) return { ok: false, message: 'No ghost is being recorded.' };
    const r = rec;
    rec = null;
    stopTimer();
    const p = indexOf(r.id);
    if (p < 0) { const res = { ok: false, message: 'The track was removed, so the ghost was not kept.' }; changed({ kind: 'record-stop', ...res }); return res; }
    if (r.dotPending) pushDotTo(r, r.dotPending);
    const end = Math.max(0, (transport.isPlaying() ? nowBeat() : r.lastBeat) - r.startBeat);
    const bars = Math.max(1, Math.min(GHOST_MAX_BARS, Math.ceil(end / 4 - 1e-6)));
    const len = bars * 4;
    const endB = Math.min(end, len);
    for (const n of r.held) r.notes.push([endB, n, 0]);
    // Each loop starts from the values the knobs and the dot had when recording began.
    const knobIds = [...new Set(r.knobs.map(e => e[1]))];
    const knobs = [...knobIds.map(id => [0, id, Number(r.params0[id])]).filter(e => Number.isFinite(e[2])), ...r.knobs];
    const dots = r.dots.length && Number.isFinite(r.params0.centerX) ? [[0, r.params0.centerX, r.params0.centerY], ...r.dots] : r.dots;
    const ghost = sanitizeGhost({ bars, startBar: r.startBar, notes: r.notes.filter(e => e[0] <= len), knobs: knobs.filter(e => e[0] <= len), dots: dots.filter(e => e[0] <= len) });
    if (!ghost) { const res = { ok: false, message: 'Nothing was recorded: play notes, turn knobs or move the dot while recording.' }; changed({ part: p, kind: 'record-stop', ...res }); return res; }
    store.set(`parts.${p}.ghost`, ghost, { source: 'ghost' });
    const s = ghostSummary(ghost);
    const lead = why === 'bars' ? `Recording stopped at ${GHOST_MAX_BARS} bars. ` : why === 'events' ? 'Recording stopped: the ghost is full. ' : '';
    const res = { ok: true, ghost, message: `${lead}Ghost recorded: ${s.bars} bar${s.bars === 1 ? '' : 's'}, ${s.notes} note${s.notes === 1 ? '' : 's'}, ${s.knobs} knob value${s.knobs === 1 ? '' : 's'}, ${s.dots} dot point${s.dots === 1 ? '' : 's'}.` };
    changed({ part: p, kind: 'record-stop', ...res });
    return res;
  }
  function pushDotTo(r, e) {
    if (r.count >= GHOST_MAX_EVENTS) return;
    r.dots.push(e); r.count++;
  }

  // ---------------------------------------------------------------- replay

  function play(part) {
    const id = idOf(part);
    if (typeof id !== 'string' || !ghostOf(part)) return { ok: false, message: 'This track has no ghost yet. Record one first.' };
    if (rec && rec.id === id) stopRecording();
    if (!playing.has(id)) playing.set(id, { frontier: null, sounding: new Set(), touched: new Set() });
    if (!transport.isPlaying()) transport.play();
    ensureTimer();
    tick();
    changed({ part, kind: 'play' });
    return { ok: true, message: 'Ghost playing. Play along on any track.' };
  }

  /** Stop scheduling one track's ghost, silence what it started and give the track its own values back. */
  function quiet(id, st, now) {
    const p = indexOf(id);
    if (p < 0) return;
    for (const n of st.sounding) router._engineOff(p, n, now, SOURCE);
    st.sounding.clear();
    if (st.touched.size) {
      const own = {};
      const params = store.get(`parts.${p}.params`) || {};
      for (const k of st.touched) if (typeof params[k] === 'number') own[k] = params[k];
      router._engineParams(p, own, now, 0);
      st.touched.clear();
    }
    st.frontier = null;
  }
  function cancelQueued(now) {
    if (typeof router._cancelAfter === 'function') router._cancelAfter(now, SOURCE);
    // Every ghost's queued notes went: the others schedule again from now.
    for (const st of playing.values()) if (st.frontier != null) st.frontier = nowBeat(now);
  }

  function stop(part) {
    const id = typeof part === 'string' ? part : idOf(part);
    const st = playing.get(id);
    if (!st) return { ok: false };
    playing.delete(id);
    const now = timebase.now();
    cancelQueued(now);
    quiet(id, st, now);
    stopTimer();
    changed({ part: indexOf(id), kind: 'stop' });
    return { ok: true, message: 'Ghost stopped.' };
  }

  function clear(part) {
    const id = idOf(part);
    if (typeof id !== 'string') return { ok: false };
    if (playing.has(id)) stop(part);
    if (rec && rec.id === id) { rec = null; stopTimer(); }
    if (store.get(`parts.${part}.ghost`) === undefined) return { ok: false, message: 'This track has no ghost.' };
    store.set(`parts.${part}.ghost`, undefined, { source: 'ghost' });
    changed({ part, kind: 'clear' });
    return { ok: true, message: 'Ghost cleared.' };
  }

  function tick() {
    if (rec && transport.isPlaying() && nowBeat() - rec.startBeat >= GHOST_MAX_BARS * 4) queueAutoStop('bars');
    if (rec && !transport.isPlaying()) stopRecording();
    else if (rec) rec.lastBeat = nowBeat();
    if (!playing.size) { stopTimer(); return; }
    const now = timebase.now();
    if (!transport.isPlaying()) {
      const live = [...playing].filter(([, st]) => st.frontier != null);
      if (live.length) { cancelQueued(now); for (const [id, st] of live) quiet(id, st, now); }
      return;
    }
    const horizon = now + (typeof transport.lookahead === 'function' ? transport.lookahead() : 0.12);
    const b1 = nowBeat(horizon);
    for (const [id, st] of [...playing]) {
      const p = indexOf(id);
      const g = p >= 0 ? ghostOf(p) : null;
      if (!g) { playing.delete(id); if (p >= 0) quiet(id, st, now); changed({ part: p, kind: 'stop' }); continue; }
      const b0 = st.frontier != null ? st.frontier : nowBeat(now);
      if (b1 > b0) scheduleRange(p, g, st, Math.max(0, b0), b1, now);
      st.frontier = Math.max(b0, b1);
    }
    stopTimer();
  }

  function timeOf(beat, now) {
    const t = transport.timeAtBeat(beat);
    return t == null ? null : Math.max(t, now);
  }

  function scheduleRange(p, g, st, b0, b1, now) {
    if (b1 <= b0) return;
    const L = g.bars * 4, origin = g.startBar * 4;
    const lead = typeof router.leadFor === 'function' ? router.leadFor(p) : 0;
    const k0 = Math.floor((b0 - origin) / L), k1 = Math.floor((b1 - origin) / L);
    for (let k = k0; k <= k1; k++) {
      const base = origin + k * L;
      // A new pass: whatever the last pass left sounding stops first.
      if (base >= b0 && base < b1 && st.sounding.size) {
        const t = timeOf(base, now);
        if (t != null) { for (const n of st.sounding) router._engineOff(p, n, Math.max(now, t - GAP), SOURCE, lead); st.sounding.clear(); }
      }
      const lo = Math.max(b0 - base, 0), hi = Math.min(b1 - base, L);
      if (hi <= lo) continue;
      // knobs and dot first, so a note at the same moment hears them
      const params = new Map();
      for (let i = lowerBound(g.knobs, lo); i < g.knobs.length && g.knobs[i][0] < hi; i++) {
        const [b, id, v] = g.knobs[i];
        const t = timeOf(base + b, now);
        if (t == null) continue;
        if (!params.has(t)) params.set(t, {});
        params.get(t)[id] = v;
        st.touched.add(id);
      }
      for (let i = lowerBound(g.dots, lo); i < g.dots.length && g.dots[i][0] < hi; i++) {
        const [b, x, y] = g.dots[i];
        const t = timeOf(base + b, now);
        if (t == null) continue;
        if (!params.has(t)) params.set(t, {});
        Object.assign(params.get(t), { centerX: x, centerY: y });
        st.touched.add('centerX'); st.touched.add('centerY');
      }
      for (const [t, pv] of params) router._engineParams(p, pv, t, lead);
      for (let i = lowerBound(g.notes, lo); i < g.notes.length && g.notes[i][0] < hi; i++) {
        const [b, n, v] = g.notes[i];
        const t = timeOf(base + b, now);
        if (t == null) continue;
        if (v > 0) {
          if (st.sounding.has(n)) router._engineOff(p, n, Math.max(now, t - GAP), SOURCE, lead);
          router._engineOn(p, n, v, t, SOURCE, lead);
          st.sounding.add(n);
        } else if (st.sounding.has(n)) {
          router._engineOff(p, n, t, SOURCE, lead);
          st.sounding.delete(n);
        }
      }
    }
  }

  // A transport stop silences the ghosts at once (they carry on with the next Play).
  if (transport && typeof transport.on === 'function') {
    offs.push(transport.on('state', (e) => {
      if (e && e.playing) { ensureTimer(); return; }
      if (rec) stopRecording();
      const now = timebase.now();
      const live = [...playing].filter(([, st]) => st.frontier != null);
      if (live.length) { cancelQueued(now); for (const [id, st] of live) quiet(id, st, now); }
    }));
  }
  // A ghost removed (Undo, a scene or session load) stops playing.
  offs.push(store.subscribe('parts', (path) => {
    if (!playing.size || !(path === 'parts' || /^parts\.\d+(\.ghost)?$/.test(path))) return;
    for (const [id] of [...playing]) {
      const p = indexOf(id);
      if (p < 0 || !ghostOf(p)) stop(id);
    }
  }));
  offs.push(store.subscribe('', (path) => { if (path === '' && playing.size) for (const [id] of [...playing]) { const p = indexOf(id); if (p < 0 || !ghostOf(p)) stop(id); } }));

  /** The ghost dot of track `part` as heard right now ({ u, v }), or null when it is not playing. */
  function dotAt(part) {
    const id = idOf(part);
    if (!playing.has(id) || !transport.isPlaying()) return null;
    const g = ghostOf(part);
    if (!g || !g.dots.length) return null;
    const heard = typeof timebase.perfToAudio === 'function' ? timebase.perfToAudio(timebase.perfNow()) : timebase.now();
    const b = nowBeat(heard);
    if (b < g.startBar * 4 && b < 0) return null;
    return dotAtBeat(g, b);
  }

  return {
    record, stopRecording, play, stop, clear, tick, dotAt,
    toggleRecord: (part) => (rec && rec.id === idOf(part) ? stopRecording() : record(part)),
    togglePlay: (part) => (playing.has(idOf(part)) ? stop(part) : play(part)),
    isRecording: (part) => !!rec && (part == null || rec.id === idOf(part)),
    isPlaying: (part) => playing.has(idOf(part)),
    has: (part) => !!ghostOf(part),
    get: (part) => ghostOf(part),
    summary: (part) => ghostSummary(ghostOf(part)),
    recordingFrom: () => (rec ? rec.startBar : null),
    on: (type, fn) => emitter.on(type, fn),
    off: (type, fn) => emitter.off(type, fn),
    dispose() {
      if (rec) rec = null;
      for (const [id] of [...playing]) stop(id);
      if (timer) { timers.clearInterval(timer); timer = null; }
      for (const off of offs) { try { off(); } catch { /* gone */ } }
    },
  };
}
