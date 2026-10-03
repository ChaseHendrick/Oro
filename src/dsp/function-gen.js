// Function (v2.4): a drawable multi-segment curve per track, played per
// voice as a looping LFO or a one-shot envelope from each note start, and
// used as the 'Function' Link source. Points are [x, y] with x rising from
// 0 to 1 and y in -1..1; Smooth bends each segment into an S curve.

export const FUNC_MAX_POINTS = 16;
export const FUNC_MODES = ['Loop', 'Once'];

export function defaultFuncPoints() {
  return [[0, 0], [0.2, 1], [0.55, -0.35], [1, 0]];
}

/** Keep 2..16 finite points, x clamped to 0..1 and rising, first at 0 and last at 1. */
export function sanitizeFuncPoints(src) {
  if (!Array.isArray(src)) return defaultFuncPoints();
  const pts = [];
  for (const p of src) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = Number(p[0]), y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    pts.push([Math.min(1, Math.max(0, x)), Math.min(1, Math.max(-1, y))]);
    if (pts.length >= FUNC_MAX_POINTS) break;
  }
  if (pts.length < 2) return defaultFuncPoints();
  pts.sort((a, b) => a[0] - b[0]);
  pts[0][0] = 0; pts[pts.length - 1][0] = 1;
  return pts.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
}

/** Value at phase 0..1 of flat points xs/ys (n of them). */
export function funcValue(xs, ys, n, phase, smooth) {
  if (n < 2) return 0;
  const t = phase <= 0 ? 0 : phase >= 1 ? 1 : phase;
  let i = 0;
  while (i < n - 2 && t > xs[i + 1]) i++;
  const x0 = xs[i], x1 = xs[i + 1], span = x1 - x0;
  let k = span > 1e-9 ? (t - x0) / span : 1;
  if (smooth > 0) k += smooth * (k * k * (3 - 2 * k) - k);
  return ys[i] + (ys[i + 1] - ys[i]) * k;
}
