// Golf (v2.9): an 18-hole course played with the Roll marble on the map (a
// round is the front nine or the full 18), plus a driving range. Everything
// here is pure (no DOM, no three.js) so the course, the par,
// the sink rule and the score keeping are tested in Node; src/ui/golf.js runs
// the game and src/visual/fun-layer.js draws the hole and the aim line.
//
// Positions are terrain coordinates (u, v in tiles, the map wraps every 1);
// heights are the normalised land height (-1..1) from a `heightAt(u, v)`
// function, so the par follows the land you are playing on. Speeds are world
// units per second, like the marble physics (one tile is 10 world units).

import { mulberry32 } from '../dsp/terrain-math.js';

export const HOLES = 18;              // the whole course; a round plays the first 9 or all 18
export const ROUND_LENGTHS = Object.freeze([9, 18]);
// Fixed, so every computer lays out the same course on the same land.
export const COURSE_SEED = 0x6f726f29;
export const HOLE_RADIUS = 0.04;      // tiles: the ball must stop or roll slowly within this of the hole
export const SINK_SPEED = 2.5;        // world units / s: slower than this over the hole drops the ball
export const REST_SPEED = 0.15;       // world units / s: below this the ball counts as stopped
export const REST_TIME = 0.5;         // s it has to stay that slow
export const SHOT_TIMEOUT = 15;       // s: a ball still wobbling after this long is played where it is
export const MAX_STROKES = 10;        // a hole ends here, scored as 10
export const MAX_SHOT = 9;            // world units / s at full power
export const MIN_ROUGH = 0.3;         // a hole wants at least this much land change on the way
export const MAX_HOLE_SLOPE = 1.0;    // normalised height per tile: holes sit on fairly level ground
export const MIN_DIST = 0.12;         // tiles from tee to hole

// The marble's feel for golf, the same on every computer (see dot-sim setOverride).
export const GOLF_PHYSICS = Object.freeze({ mode: 1, gravity: 0.5, friction: 0.5, bounce: 0.15, flick: 0.5, tiltX: 0, tiltY: 0 });

const TAU = Math.PI * 2;
const wrap = (x) => x - Math.floor(x);
const delta = (a, b) => { const d = a - b; return d - Math.round(d); };
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** Seed for hole i (0-based). */
export function holeSeed(i) {
  return (Math.imul(i + 1, 0x9e3779b1) ^ COURSE_SEED) >>> 0;
}

/** Shortest distance between two points on the wrapping map, in tiles. */
export function torusDist(u0, v0, u1, v1) {
  return Math.hypot(delta(u1, u0), delta(v1, v0));
}

/** How much the land rises and falls along the straight path from a to b (sum of |height change|). */
export function roughness(heightAt, u0, v0, u1, v1, n = 24) {
  const du = delta(u1, u0), dv = delta(v1, v0);
  let prev = heightAt(wrap(u0), wrap(v0)), sum = 0;
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const h = heightAt(wrap(u0 + du * t), wrap(v0 + dv * t));
    sum += Math.abs(h - prev);
    prev = h;
  }
  return sum;
}

/** Steepness of the land at (u, v): normalised height per tile. */
export function slopeAt(heightAt, u, v, e = 0.01) {
  const gx = (heightAt(wrap(u + e), v) - heightAt(wrap(u - e), v)) / (2 * e);
  const gz = (heightAt(u, wrap(v + e)) - heightAt(u, wrap(v - e))) / (2 * e);
  return Math.hypot(gx, gz);
}

/**
 * Walk downhill from (u, v) to the bottom of the dip it is in (at most
 * `reach` tiles away), so a hole sits where a ball can come to rest.
 */
export function settleSpot(heightAt, u, v, reach = 0.08, step = 0.004) {
  let cu = u, cv = v, h = heightAt(wrap(u), wrap(v));
  for (let k = 0; k < 60; k++) {
    const e = step;
    const gx = heightAt(wrap(cu + e), wrap(cv)) - heightAt(wrap(cu - e), wrap(cv));
    const gz = heightAt(wrap(cu), wrap(cv + e)) - heightAt(wrap(cu), wrap(cv - e));
    const g = Math.hypot(gx, gz);
    if (g < 1e-9) break;
    const nu = cu - (gx / g) * step, nv = cv - (gz / g) * step;
    if (Math.hypot(nu - u, nv - v) > reach) break;
    const nh = heightAt(wrap(nu), wrap(nv));
    if (nh >= h) break;
    cu = nu; cv = nv; h = nh;
  }
  return { u: wrap(cu), v: wrap(cv) };
}

/** Par from the distance (tiles) and the land on the way. */
export function parFor(dist, rough) {
  return clamp(Math.round(2 + dist / 0.18 + Math.min(2, Math.max(0, rough) * 0.6)), 2, 6);
}

/**
 * Hole i: start, hole, distance and par. Candidates come from the hole's own
 * seed; the cup settles into the nearest dip, and the first candidate with
 * some land in between and level ground at the cup wins (or the best of them on very flat or very steep land).
 */
export function layoutHole(i, heightAt = () => 0) {
  const seed = holeSeed(i);
  const rng = mulberry32(seed);
  // later holes are a little longer; the back nine starts a bit longer again
  const want = i < 9 ? 0.16 + 0.025 * i : 0.2 + 0.02 * (i - 9);
  let best = null;
  for (let k = 0; k < 10; k++) {
    const su = 0.1 + 0.8 * rng(), sv = 0.1 + 0.8 * rng();
    const ang = rng() * TAU;
    const reach = want + 0.06 * rng();
    // the cup goes in the dip nearest the spot the seed picked
    const spot = settleSpot(heightAt, su + Math.cos(ang) * reach, sv + Math.sin(ang) * reach);
    const hu = spot.u, hv = spot.v;
    const dist = torusDist(su, sv, hu, hv);
    const rough = roughness(heightAt, su, sv, hu, hv);
    const slope = slopeAt(heightAt, hu, hv);
    const ok = rough >= MIN_ROUGH && slope <= MAX_HOLE_SLOPE && dist >= MIN_DIST;
    const score = Math.min(rough, 1.5) - 0.5 * slope;
    const c = { su, sv, hu, hv, dist, rough, ok, score };
    if (!best || (ok && !best.ok) || (ok === best.ok && score > best.score)) best = c;
    if (ok) break;
  }
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  return {
    index: i, seed,
    start: { u: r6(best.su), v: r6(best.sv) },
    hole: { u: r6(best.hu), v: r6(best.hv) },
    dist: best.dist, rough: best.rough,
    par: parFor(best.dist, best.rough),
  };
}

/** The first `holes` holes (9 or 18) for the land given by heightAt. */
export function layoutCourse(heightAt, holes = 9) {
  const n = holes === 18 ? 18 : 9;
  return Array.from({ length: n }, (_, i) => layoutHole(i, heightAt));
}

/** "Front nine" or "Full 18". */
export function roundName(holes) {
  return holes === 18 ? 'Full 18' : 'Front nine';
}

/** True when the ball drops: within the hole and slow enough. */
export function sinks(dist, speed) {
  return dist <= HOLE_RADIUS && speed <= SINK_SPEED;
}

/** Tracks whether a rolling ball has come to rest. Returns true once it has. */
export function createRest() {
  return { slow: 0, t: 0 };
}
export function restStep(rest, speed, dt) {
  rest.t += dt;
  rest.slow = speed < REST_SPEED ? rest.slow + dt : 0;
  return rest.slow >= REST_TIME || rest.t >= SHOT_TIMEOUT;
}

/** "Hole 3: 4 strokes (par 3)" */
export function holeMessage(n, strokes, par) {
  return `Hole ${n}: ${strokes} stroke${strokes === 1 ? '' : 's'} (par ${par})`;
}

/** Badges earned by finishing a hole. */
export function holeBadges(strokes, par) {
  const out = ['golf-first-hole'];
  if (strokes === 1) out.push('golf-hole-in-one');
  if (strokes < par) out.push('golf-under-par');
  return out;
}

/** Badges earned by finishing the round. */
export function roundBadges(total, parTotal) {
  const out = ['golf-round'];
  if (total < parTotal) out.push('golf-under-par');
  return out;
}

const posInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);

/**
 * Saved scores in a known shape: { best9, best18, bestHoles: [18], rounds,
 * bestDrive } (best totals for each round length, best strokes per hole,
 * rounds finished, longest driving range shot in yards).
 */
export function golfScores(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const holes = Array.isArray(src.bestHoles) ? src.bestHoles : [];
  return {
    best9: posInt(src.best9),
    best18: posInt(src.best18),
    bestHoles: Array.from({ length: HOLES }, (_, i) => posInt(holes[i])),
    rounds: Number.isInteger(src.rounds) && src.rounds > 0 ? src.rounds : 0,
    bestDrive: posInt(src.bestDrive),
  };
}

/** Best total saved for a round of `holes` (9 or 18), or null. */
export function bestTotal(scores, holes) {
  return holes === 18 ? scores.best18 : scores.best9;
}

/** Scores after finishing hole i in `strokes`. Returns { scores, best } (best: a new best for that hole). */
export function recordHole(raw, i, strokes) {
  const scores = golfScores(raw);
  const prev = scores.bestHoles[i];
  const best = posInt(strokes) !== null && (prev === null || strokes < prev);
  if (best) scores.bestHoles[i] = strokes;
  return { scores, best };
}

/** Scores after a finished round of `holes` (9 or 18) in `total` strokes. Returns { scores, best }. */
export function recordRound(raw, total, holes = 9) {
  const scores = golfScores(raw);
  const key = holes === 18 ? 'best18' : 'best9';
  const best = posInt(total) !== null && (scores[key] === null || total < scores[key]);
  if (best) scores[key] = total;
  scores.rounds += 1;
  return { scores, best };
}

// ------------------------------------------------------------------ driving range
// Distances are a game measure: one world unit (a tenth of a tile) is 20 yards,
// so a full-power shot on flat land goes about 200.
export const YARDS_PER_UNIT = 20;
export const YARDS_PER_TILE = YARDS_PER_UNIT * 10;
export const RANGE_SEED = 0x72616e67;
export const RANGE_FLAGS = Object.freeze([50, 100, 150, 200]);

/** Yards for a distance in tiles (rounded). */
export function yardsFor(tiles) {
  return Math.max(0, Math.round(tiles * YARDS_PER_TILE));
}

/**
 * How far the ball has gone from the tee. The map wraps, so the ball's moves
 * are added up frame by frame (each much shorter than half a tile) and a long
 * shot is never cut short at the edge of a tile.
 */
export function createCarry(u, v) {
  return { u, v, du: 0, dv: 0 };
}
export function carryStep(carry, u, v) {
  carry.du += delta(u, carry.u);
  carry.dv += delta(v, carry.v);
  carry.u = u; carry.v = v;
  return carry;
}
/** Straight-line distance from the tee so far, in yards. */
export function carryYards(carry) {
  return yardsFor(Math.hypot(carry.du, carry.dv));
}

/** The range's tee (in a dip, so the ball rests there) and the direction its flags run, the same every time on the same land. */
export function rangeTee(heightAt = () => 0) {
  const rng = mulberry32(RANGE_SEED);
  const spot = settleSpot(heightAt, 0.2 + 0.6 * rng(), 0.2 + 0.6 * rng());
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  return { u: r6(spot.u), v: r6(spot.v), angle: Math.round(rng() * TAU * 1e6) / 1e6 };
}

/** Distance flags along the range: [{ yards, dx, dz }] (world offsets from the tee). */
export function rangeFlags(tee, yards = RANGE_FLAGS) {
  const c = Math.cos(tee.angle), s = Math.sin(tee.angle);
  return yards.map((y) => {
    const d = y / YARDS_PER_UNIT;
    return { yards: y, dx: Math.round(c * d * 1e6) / 1e6, dz: Math.round(s * d * 1e6) / 1e6 };
  });
}

/** Scores after a range shot of `yards`. Returns { scores, best }. */
export function recordDrive(raw, yards) {
  const scores = golfScores(raw);
  const best = posInt(yards) !== null && (scores.bestDrive === null || yards > scores.bestDrive);
  if (best) scores.bestDrive = yards;
  return { scores, best };
}

/** Scale degree for a range shot's note: longer shots play higher (0..14). */
export function driveDegree(yards) {
  return clamp(Math.round(Math.max(0, yards) / 20), 0, 14);
}

/** Sum of the scored holes (null entries skipped). */
export function sumStrokes(list) {
  let s = 0;
  for (const v of list) if (Number.isFinite(v)) s += v;
  return s;
}
