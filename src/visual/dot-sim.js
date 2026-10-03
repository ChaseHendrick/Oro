// Everything that moves the dots on its own, for every track at once:
// Roll and Explore marbles, Drift, Tour, plus the store writes and the
// engine's marble telemetry that go with them. No three.js here, so the whole
// behaviour runs (and is tested) in Node with a real store.
//
//   const sim = createDotSim({ store, engine, fieldFor, ensureField, getMusic, emit });
//   sim.step(dt, now)                   physics, tours, Explore notes, writes
//   sim.isActive(p); sim.state(p)       is the dot simulated, and where is it
//   sim.hold(p, u, v); sim.release(p, vx, vz); sim.teleport(p, u, v)
//   sim.userWrite(p, u, v, force)       a person moved the dot
//   sim.setOverride(p, dot | null)      dot settings on top of the stored ones
//
// Store writes carry who moved the dot, so dot-lock recording and the lock
// glides can tell people from simulations:
//   simulated moves (Roll, Drift, Explore, Tour)  { source: 'physics', user: false }
//   a person (drag, click, keys, minimap)          { source: 'visual', user: true }
// Writes are throttled per part (the selected part more often) and rounded
// to six decimals; nothing in step() allocates apart from Explore events.
//
// Outside moves (a dot-lock glide, a knob, a preset) win: a marble or a
// drifter is put where the store says, and a tour steps aside while they keep
// coming, then glides back onto its route.

import { MAX_PARTS } from '../core/params.js';
import { createPhysics, MODE_PIN, MODE_EXPLORE, MODE_TOUR, BALL_RADIUS } from './physics.js';
import { Explorer, PEAK, exploreDelta, exploreRefractory } from './explore.js';
import { makePlan, buildPlan, tourPoint, planKey } from './tour.js';
import { wrap01, wrapDelta, uToX, wrapWorld } from './heightfield.js';

export const SIM_META = Object.freeze({ source: 'physics', user: false });
export const USER_META = Object.freeze({ source: 'visual', user: true });
export const WRITE_MS_SELECTED = 15;
export const WRITE_MS_OTHER = 50;
export const MARBLE_MS = 33;            // engine.marble() about 30 times a second
export const MARBLE_SPEED_REF = 8;      // world units / s that count as full Marble Speed
export const YIELD_MS = 260;            // a tour waits this long after an outside move
export const BLEND_MS = 450;            // then glides back onto its route in this long

function num(v, d) { return typeof v === 'number' && Number.isFinite(v) ? v : d; }
function smooth(t) { const x = t <= 0 ? 0 : t >= 1 ? 1 : t; return x * x * (3 - 2 * x); }

export function createDotSim({
  store, engine = null, fieldFor, ensureField = () => {}, rapier = true, importer = null,
  parts = MAX_PARTS, getMusic = () => null, emit = () => {}, clock = () => performance.now(),
} = {}) {
  const physics = createPhysics({ fieldFor, rapier, importer, parts });
  const CX = [], CY = [];
  for (let p = 0; p < parts; p++) { CX.push(`parts.${p}.params.centerX`); CY.push(`parts.${p}.params.centerY`); }

  const P = [];
  for (let p = 0; p < parts; p++) {
    P.push({
      mode: MODE_PIN,
      dot: {},
      explorer: new Explorer(p + 1),
      wind: { x: 0, z: 0 },
      tour: {
        plan: makePlan(), beat: 0, synced: false, held: false,
        yieldUntil: -Infinity, yielding: false,
        fromU: 0, fromV: 0, t0: -Infinity,
        // shown position (also the state() object for Tour)
        u: 0.5, v: 0.5, x: 0, y: 0, z: 0, vx: 0, vz: 0, held: false,
        pt: { u: 0, v: 0, leg: 0, k: 0, done: false },
      },
      pendU: 0, pendV: 0, pending: false, meta: SIM_META, lastWrite: -Infinity, wroteU: NaN, wroteV: NaN,
      marbleAt: -Infinity, marbleOn: false, override: null,
    });
  }
  let sel = 0;
  let writing = false;
  let wPart = 0, wU = 0, wV = 0, wMeta = SIM_META;

  // ------------------------------------------------------------------ store
  function writeBatch() {
    store.set(CX[wPart], wU, wMeta);
    store.set(CY[wPart], wV, wMeta);
  }

  function queue(p, u, v, meta) {
    const s = P[p];
    // A person's move must not be relabelled as simulated by a later sim
    // write inside the same throttle interval.
    if (meta === USER_META || !s.pending || s.meta !== USER_META) s.meta = meta;
    s.pendU = wrap01(u); s.pendV = wrap01(v);
    s.pending = true;
  }

  function flush(p, now, force) {
    const s = P[p];
    if (!s.pending) return;
    const interval = p === sel ? WRITE_MS_SELECTED : WRITE_MS_OTHER;
    if (!force && now - s.lastWrite < interval) return;
    let u = Math.round(s.pendU * 1e6) / 1e6, v = Math.round(s.pendV * 1e6) / 1e6;
    if (u >= 1) u = 0;
    if (v >= 1) v = 0;
    s.pending = false;
    s.lastWrite = now;
    const meta = s.meta;
    s.meta = SIM_META;
    // compare with what was last written (store.get() would split the path every frame)
    if (s.wroteU === u && s.wroteV === v) return;
    s.wroteU = u; s.wroteV = v;
    wPart = p; wU = u; wV = v; wMeta = meta;
    writing = true;
    try { store.batch(writeBatch); } finally { writing = false; }
  }

  function storeCenter(p, out) {
    out.u = num(store.get(CX[p]), 0.5);
    out.v = num(store.get(CY[p]), 0.5);
    return out;
  }
  const _c = { u: 0, v: 0 };

  // ------------------------------------------------------------------ modes
  function tourActive(p) { return P[p].mode === MODE_TOUR && P[p].tour.plan.n > 0; }

  function startBlend(p, now) {
    const t = P[p].tour;
    t.fromU = t.u; t.fromV = t.v; t.t0 = now;
  }

  function syncPart(p, force) {
    const s = P[p];
    const stored = store.get(`parts.${p}.dot`) || {};
    const dot = s.override ? { ...stored, ...s.override } : stored;
    s.dot = dot;
    const mode = Math.round(num(dot.mode, MODE_PIN));
    storeCenter(p, _c);
    if (mode !== MODE_PIN && mode !== MODE_TOUR) ensureField(p);
    physics.setParams(p, dot);
    const wasMode = s.mode;
    physics.setMode(p, mode, _c.u, _c.v);
    s.mode = mode;
    const now = clock();
    if (mode === MODE_EXPLORE && wasMode !== MODE_EXPLORE) resetExplorer(p);
    if (wasMode !== mode && physics.isMarble(p) === false && s.marbleOn) marbleOff(p);
    // Tour: rebuild the route when the waypoints or the tour mode changed.
    const t = s.tour;
    const key = mode === MODE_TOUR ? planKey(dot.waypoints, Math.round(num(dot.tourMode, 0))) : '';
    if (mode === MODE_TOUR) {
      if (wasMode !== MODE_TOUR) {
        t.beat = 0;
        t.synced = false;
        t.u = _c.u; t.v = _c.v;
        t.yieldUntil = -Infinity; t.yielding = false;
        buildPlan(dot.waypoints, Math.round(num(dot.tourMode, 0)), t.plan);
        startBlend(p, now);
      } else if (force || key !== t.plan.key) {
        buildPlan(dot.waypoints, Math.round(num(dot.tourMode, 0)), t.plan);
        startBlend(p, now);
      }
      placeTourState(p);
    }
  }

  function syncAll(force) { for (let p = 0; p < parts; p++) syncPart(p, force); }

  function resetExplorer(p) {
    const st = physics.state(p);
    const hf = fieldFor(p);
    P[p].explorer.reset(hf && hf.ready ? hf.norm(st.u, st.v) : 0, st.u, st.v);
  }

  function placeTourState(p) {
    const t = P[p].tour;
    t.x = wrapWorld(uToX(t.u)); t.z = wrapWorld(uToX(t.v));
    const hf = fieldFor(p);
    t.y = hf && hf.ready ? hf.yAt(t.x, t.z) + BALL_RADIUS : BALL_RADIUS;
  }

  /** Someone else moved the dot (a lock glide, a knob, a preset). */
  function external(p) {
    storeCenter(p, _c);
    const s = P[p];
    s.wroteU = _c.u; s.wroteV = _c.v;
    if (physics.isActive(p)) {
      physics.teleport(p, _c.u, _c.v);
      if (s.mode === MODE_EXPLORE) resetExplorer(p);
    }
    if (s.mode === MODE_TOUR) {
      const t = s.tour;
      t.u = _c.u; t.v = _c.v;
      t.yieldUntil = clock() + YIELD_MS;
      t.yielding = true;
      placeTourState(p);
    }
    // A pending simulated write would drag the dot back: drop it.
    if (s.meta !== USER_META) s.pending = false;
  }

  const offStore = store.subscribe('', (path, value, meta) => {
    if (path === '' || path === 'parts') { syncAll(true); for (let p = 0; p < parts; p++) external(p); return; }
    const m = /^parts\.(\d+)(?:\.(\w+)(?:\.(\w+))?)?/.exec(path);
    if (!m) return;
    const p = Number(m[1]);
    if (!(p >= 0 && p < parts)) return;
    const branch = m[2], leaf = m[3];
    if (!branch) { syncPart(p, true); external(p); return; }
    if (branch === 'dot') { syncPart(p, false); return; }
    if (branch === 'params' && (leaf === undefined || leaf === 'centerX' || leaf === 'centerY')) {
      if (writing || meta === SIM_META || meta === USER_META) return;
      external(p);
    }
  });

  // ------------------------------------------------------------------ music
  function transportBeat() {
    const music = getMusic();
    const tr = music && music.transport;
    if (!tr || typeof tr.isPlaying !== 'function' || !tr.isPlaying() || typeof tr.beatAt !== 'function') return NaN;
    try {
      const tb = music.timebase;
      let audio = NaN;
      if (tb && typeof tb.perfToAudio === 'function') audio = tb.perfToAudio(typeof tb.perfNow === 'function' ? tb.perfNow() : performance.now());
      else if (engine && engine.context) audio = engine.context.currentTime;
      const b = tr.beatAt(audio);
      return Number.isFinite(b) && b >= 0 ? b : NaN;
    } catch { return NaN; }
  }

  function tempo() {
    const music = getMusic();
    const tr = music && music.transport;
    if (tr && typeof tr.tempo === 'function') {
      try { const t = Number(tr.tempo()); if (t > 0 && Number.isFinite(t)) return t; } catch { /* fall back to the knob */ }
    }
    return bpmKnob;
  }
  let bpmKnob = 120;
  const readTempo = () => { bpmKnob = Math.min(400, Math.max(20, num(store.get('global.tempo'), 120))); };
  readTempo();
  const offTempo = store.subscribe('global', readTempo);

  // ------------------------------------------------------------------ engine
  const hasMarble = () => !!engine && typeof engine.marble === 'function';

  function marbleOff(p) {
    P[p].marbleOn = false;
    if (!hasMarble()) return;
    const hf = fieldFor(p), st = physics.state(p);
    try { engine.marble(p, 0, hf && hf.ready ? clampH(hf.norm(st.u, st.v)) : 0); } catch { /* engine busy */ }
  }

  function clampH(h) { return h < -1 ? -1 : h > 1 ? 1 : h; }

  function reportMarbles(now) {
    if (!hasMarble()) return;
    for (let p = 0; p < parts; p++) {
      if (!physics.isMarble(p)) continue;
      const s = P[p];
      if (now - s.marbleAt < MARBLE_MS) continue;
      s.marbleAt = now;
      s.marbleOn = true;
      const st = physics.state(p);
      const hf = fieldFor(p);
      const sp = st.held ? 0 : Math.sqrt(st.vx * st.vx + st.vz * st.vz) / MARBLE_SPEED_REF;
      try { engine.marble(p, sp > 1 ? 1 : sp, hf && hf.ready ? clampH(hf.norm(st.u, st.v)) : 0); } catch { /* engine busy */ }
    }
  }

  // ------------------------------------------------------------------ step
  function stepTour(p, dt, now, beatNow, bpm) {
    const s = P[p], t = s.tour;
    const plan = t.plan;
    if (Number.isFinite(beatNow)) {
      if (!t.synced) { t.synced = true; startBlend(p, now); }
      t.beat = beatNow;
    } else {
      if (t.synced) { t.synced = false; }
      t.beat += (dt * bpm) / 60;
    }
    if (!tourPoint(plan, t.beat, t.pt)) return;
    if (t.held) return;
    if (now < t.yieldUntil) return;
    if (t.yielding) { t.yielding = false; startBlend(p, now); }
    let u = t.pt.u, v = t.pt.v;
    const k = smooth((now - t.t0) / BLEND_MS);
    if (k < 1) {
      u = t.fromU + wrapDelta(u, t.fromU) * k;   // wrapDelta(a, b) is a - b folded
      v = t.fromV + wrapDelta(v, t.fromV) * k;
    }
    t.u = wrap01(u); t.v = wrap01(v);
    placeTourState(p);
    queue(p, t.u, t.v, SIM_META);
  }

  function step(dt, now = clock(), skip = -1) {
    if (!(dt > 0)) dt = 0;
    const h = Math.min(dt, 0.1);
    // Explore: turn the push before the physics step.
    for (let p = 0; p < parts; p++) {
      const s = P[p];
      if (s.mode !== MODE_EXPLORE) continue;
      const st = physics.state(p);
      if (st.held) continue;
      s.explorer.step(h, num(s.dot.exploreRate, 0.5), Math.sqrt(st.vx * st.vx + st.vz * st.vz), s.wind, physics.gravity(p), st.u, st.v);
      physics.setWind(p, s.wind.x, s.wind.z);
    }
    physics.step(h);
    let beatNow = NaN, bpm = 0, tours = false;
    for (let p = 0; p < parts; p++) if (tourActive(p)) { tours = true; break; }
    if (tours) { beatNow = transportBeat(); bpm = tempo(); }
    for (let p = 0; p < parts; p++) {
      const s = P[p];
      if (p !== skip) {
        if (physics.isActive(p)) {
          const st = physics.state(p);
          if (!st.held) {
            queue(p, st.u, st.v, SIM_META);
            if (s.mode === MODE_EXPLORE && h > 0) detect(p, st, h);
          }
        } else if (tourActive(p)) {
          stepTour(p, h, now, beatNow, bpm);
        }
      }
      flush(p, now, false);
    }
    reportMarbles(now);
  }

  function detect(p, st, h) {
    const s = P[p];
    const hf = fieldFor(p);
    if (!hf || !hf.ready) return;
    const rate = num(s.dot.exploreRate, 0.5);
    const det = s.explorer.detector;
    const found = det.push(hf.norm(st.u, st.v), st.u, st.v, h, exploreDelta(rate), exploreRefractory(rate));
    if (!found) return;
    s.explorer.heard();
    emit('extremum', {
      part: p, kind: found === PEAK ? 'peak' : 'valley', height: det.height,
      x: wrap01(det.u), y: wrap01(det.v), speed: Math.min(1, Math.sqrt(st.vx * st.vx + st.vz * st.vz) / MARBLE_SPEED_REF),
    });
  }

  // ------------------------------------------------------------------ API
  syncAll(true);

  return {
    physics,
    get writing() { return writing; },
    setSelected(p) { sel = p; },
    step,
    syncPart, syncAll,

    mode(p) { return P[p].mode; },
    /** True when something other than a person moves this dot. */
    isActive(p) { return physics.isActive(p) || tourActive(p); },
    anyActive() { for (let p = 0; p < parts; p++) if (physics.isActive(p) || tourActive(p)) return true; return false; },
    isMarble(p) { return physics.isMarble(p); },
    engineName(p) { return P[p].mode === MODE_TOUR ? 'tour' : physics.engineName(p); },
    /** u, v (wrapped), x, y, z (world, centre tile), vx, vz, held. */
    state(p) { return P[p].mode === MODE_TOUR ? P[p].tour : physics.state(p); },
    tourPlan(p) { return P[p].tour.plan; },
    tourBeat(p) { return P[p].tour.beat; },

    /** A person grabbed the dot: it follows them exactly. */
    hold(p, u, v) {
      const s = P[p];
      if (physics.isActive(p)) physics.hold(p, u, v);
      if (s.mode === MODE_TOUR) {
        const t = s.tour;
        t.held = true; t.u = wrap01(u); t.v = wrap01(v);
        placeTourState(p);
      }
    },

    /** Let go: a marble keeps the throw (scaled by Flick), a tour glides back to its route. */
    release(p, vx = 0, vz = 0) {
      const s = P[p];
      if (physics.isActive(p)) {
        physics.release(p, vx, vz);
        if (s.mode === MODE_EXPLORE) resetExplorer(p);
      }
      if (s.mode === MODE_TOUR && s.tour.held) {
        s.tour.held = false;
        startBlend(p, clock());
      }
    },

    /** The dot was put somewhere by a person without a drag (keys): no throw. */
    teleport(p, u, v) {
      const s = P[p];
      if (physics.isActive(p)) {
        physics.teleport(p, u, v);
        if (s.mode === MODE_EXPLORE) resetExplorer(p);
      }
      if (s.mode === MODE_TOUR) {
        const t = s.tour;
        t.u = wrap01(u); t.v = wrap01(v);
        t.yieldUntil = clock() + YIELD_MS * 3;
        t.yielding = true;
        placeTourState(p);
      }
    },

    /** A person moved the dot to (u, v). `force` writes now instead of at the throttle. */
    userWrite(p, u, v, force = false, now = clock()) {
      queue(p, u, v, USER_META);
      if (force) flush(p, now, true);
    },

    flush(p, now = clock()) { flush(p, now, true); },

    /** A simulated move to (u, v), written now (like a marble's, never an edit). */
    simWrite(p, u, v, now = clock()) {
      queue(p, u, v, SIM_META);
      flush(p, now, true);
    },

    /**
     * Play part p with these dot settings on top of the stored ones (v2.9
     * Golf), without writing them to the session; null goes back.
     */
    setOverride(p, dot) {
      if (!(p >= 0 && p < parts)) return;
      P[p].override = dot && typeof dot === 'object' ? { ...dot } : null;
      syncPart(p, true);
    },

    dispose() {
      offStore();
      offTempo();
      for (let p = 0; p < parts; p++) if (P[p].marbleOn) marbleOff(p);
      physics.dispose();
    },
  };
}
