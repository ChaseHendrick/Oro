// Tour mode: the dot travels through the part's waypoints in time with the
// tempo. Each waypoint carries `beats`, the travel time to the next one.
//
//   Loop       1 -> 2 -> ... -> n -> 1 -> ...
//   Ping-pong  1 -> 2 -> ... -> n -> ... -> 2 -> 1 -> ...
//   Once       1 -> 2 -> ... -> n, then it stays on the last waypoint
//
// The route is a Catmull-Rom curve through the waypoints, taken the shortest
// way round the torus (like dot-lock glides), so corners are rounded and the
// dashed route drawn on the map is exactly the path the dot follows. Along each
// leg the time is eased with a cubic Hermite curve: the dot slows into every
// waypoint and lands on it on the beat; at a turnaround (Ping-pong) or the end
// of a Once tour it comes fully to rest.
//
// Everything here is pure and allocation-free after makePlan(): the visuals
// rebuild the plan when the waypoints change and evaluate it every frame.

import { MAX_WAYPOINTS } from '../core/params.js';

export const TOUR_LOOP = 0, TOUR_PINGPONG = 1, TOUR_ONCE = 2;
// Speed at a waypoint as a fraction of the leg's average speed (1 = no easing).
export const ARRIVE_SPEED = 0.45;
const N = MAX_WAYPOINTS;

function finite(v, d) { return typeof v === 'number' && Number.isFinite(v) ? v : d; }
function wrapDelta(from, to) { const d = to - from; return d - Math.round(d); }
function wrap01(x) { const w = x - Math.floor(x); return w >= 1 ? 0 : w; }

/** Empty plan with room for MAX_WAYPOINTS waypoints (allocate once per part). */
export function makePlan() {
  return {
    n: 0,                    // waypoints in use
    mode: TOUR_LOOP,
    legs: 0,                 // legs travelled forward (n - 1 open, n for a loop)
    // Unwrapped control points: index 1..n (+1 for the loop's return), with
    // Catmull-Rom neighbours at index 0 and the end.
    px: new Float64Array(N + 3), py: new Float64Array(N + 3),
    beats: new Float64Array(N + 1),   // leg durations
    start: new Float64Array(N + 2),   // cumulative start beat of each leg
    forward: 0,              // beats for one forward pass (sum of legs)
    period: 0,               // beats per cycle (2 x forward for Ping-pong); Infinity for Once
    key: '',
  };
}

/** Stable string for change detection (positions rounded to 1e-5). */
export function planKey(waypoints, mode) {
  let k = String(mode);
  if (Array.isArray(waypoints)) {
    for (const w of waypoints) k += `|${Math.round(finite(w && w.x, 0.5) * 1e5)},${Math.round(finite(w && w.y, 0.5) * 1e5)},${finite(w && w.beats, 2)}`;
  }
  return k;
}

/** Fill `plan` from waypoints [{x, y, beats}] and a tour mode (TOUR_LOOP ...). */
export function buildPlan(waypoints, mode, plan = makePlan()) {
  const list = Array.isArray(waypoints) ? waypoints : [];
  const n = Math.min(N, list.length);
  const m = mode === TOUR_PINGPONG || mode === TOUR_ONCE ? mode : TOUR_LOOP;
  plan.n = n;
  plan.mode = m;
  plan.key = planKey(list.slice(0, n), m);
  if (n === 0) { plan.legs = 0; plan.forward = 0; plan.period = 0; return plan; }
  const loop = m === TOUR_LOOP && n > 1;
  plan.legs = loop ? n : n - 1;
  // Unwrap: every next waypoint is placed the shortest way round from the previous one.
  const px = plan.px, py = plan.py;
  px[1] = wrap01(finite(list[0].x, 0.5));
  py[1] = wrap01(finite(list[0].y, 0.5));
  const last = loop ? n + 1 : n;
  for (let i = 2; i <= last; i++) {
    const w = list[(i - 1) % n];
    px[i] = px[i - 1] + wrapDelta(px[i - 1], wrap01(finite(w.x, 0.5)));
    py[i] = py[i - 1] + wrapDelta(py[i - 1], wrap01(finite(w.y, 0.5)));
  }
  if (loop) {
    // The loop closes on the first waypoint, possibly one tile over: carry
    // that tile offset to the neighbours so the curve is the same every lap.
    const ox = px[n + 1] - px[1], oy = py[n + 1] - py[1];
    px[0] = px[n] - ox; py[0] = py[n] - oy;
    px[n + 2] = px[2] + ox; py[n + 2] = py[2] + oy;
  } else {
    px[0] = px[1]; py[0] = py[1];
    px[n + 1] = px[n]; py[n + 1] = py[n];
  }
  let t = 0;
  for (let i = 0; i < plan.legs; i++) {
    const b = Math.min(16, Math.max(0.25, finite(list[i].beats, 2)));
    plan.beats[i] = b;
    plan.start[i] = t;
    t += b;
  }
  plan.start[plan.legs] = t;
  plan.forward = t;
  plan.period = m === TOUR_ONCE || n === 1 ? Infinity : m === TOUR_PINGPONG ? 2 * t : t;
  return plan;
}

// Cubic Hermite time easing on [0, 1] with end speeds a (start) and b (end).
export function easeLeg(t, a, b) {
  const t2 = t * t, t3 = t2 * t;
  return (t3 - 2 * t2 + t) * a + (-2 * t3 + 3 * t2) + (t3 - t2) * b;
}

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Point on leg i at curve parameter s (0..1), unwrapped, into out.u / out.v. */
export function legPoint(plan, i, s, out) {
  const px = plan.px, py = plan.py;
  out.u = catmull(px[i], px[i + 1], px[i + 2], px[i + 3], s);
  out.v = catmull(py[i], py[i + 1], py[i + 2], py[i + 3], s);
  return out;
}

/**
 * Where the dot is `beat` beats into the tour. Writes wrapped out.u / out.v,
 * plus out.leg (index), out.k (0..1 along the leg, eased), out.done (Once
 * finished). Returns false when the plan has no waypoints.
 */
export function tourPoint(plan, beat, out) {
  out.done = false;
  if (!plan.n) return false;
  if (plan.legs === 0) {
    out.u = wrap01(plan.px[1]); out.v = wrap01(plan.py[1]); out.leg = 0; out.k = 0;
    out.done = plan.mode === TOUR_ONCE;
    return true;
  }
  const b = beat > 0 && Number.isFinite(beat) ? beat : 0;
  let f;                       // beats into a forward pass
  if (plan.mode === TOUR_ONCE) {
    f = b >= plan.forward ? plan.forward : b;
    out.done = b >= plan.forward;
  } else {
    const ph = b % plan.period;
    f = plan.mode === TOUR_PINGPONG && ph > plan.forward ? plan.period - ph : ph;
  }
  // Find the leg (at most 8: a linear scan is fastest).
  let i = 0;
  while (i < plan.legs - 1 && f >= plan.start[i + 1]) i++;
  const t = Math.min(1, Math.max(0, (f - plan.start[i]) / plan.beats[i]));
  // A loop never stops; open tours rest at their ends (the turnaround or the finish).
  const open = plan.mode !== TOUR_LOOP;
  const a = open && i === 0 ? 0 : ARRIVE_SPEED;
  const e = open && i === plan.legs - 1 ? 0 : ARRIVE_SPEED;
  const k = easeLeg(t, a, e);
  legPoint(plan, i, k, out);
  out.u = wrap01(out.u); out.v = wrap01(out.v);
  out.leg = i; out.k = k;
  return true;
}

/**
 * Sample the whole route (for the dashed line): `per` points per leg plus the
 * end point, unwrapped and continuous, into uv (u, v pairs). Returns the count.
 */
export function sampleRoute(plan, per, uv, tmp) {
  if (plan.legs === 0) return 0;
  let k = 0;
  for (let i = 0; i < plan.legs; i++) {
    for (let j = 0; j < per; j++) {
      legPoint(plan, i, j / per, tmp);
      uv[k * 2] = tmp.u; uv[k * 2 + 1] = tmp.v; k++;
    }
  }
  legPoint(plan, plan.legs - 1, 1, tmp);
  uv[k * 2] = tmp.u; uv[k * 2 + 1] = tmp.v; k++;
  return k;
}
