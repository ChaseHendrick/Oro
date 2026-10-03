// Day and night (v2.9): a gentle tint over the map palette that follows the
// local hour. Warm at dawn, neutral through the day, orange at dusk and a
// deep blue at night. The tint multiplies the palette (linear RGB); the UI
// asks for it at most once a minute and the map eases to it slowly, so the
// land never flickers.

// [hour, r, g, b], in order; the list wraps from 24 back to 0.
export const DAY_KEYS = [
  [0, 0.52, 0.62, 1.0],
  [4.5, 0.52, 0.62, 1.0],
  [6.5, 1.1, 0.88, 0.78],    // dawn
  [9, 1.0, 1.0, 1.0],
  [16, 1.0, 1.0, 1.0],       // noon stays neutral
  [18.5, 1.14, 0.84, 0.62],  // dusk
  [20.5, 0.56, 0.64, 1.0],
  [24, 0.52, 0.62, 1.0],
];

/** Tint [r, g, b] for a local hour (0..24, fractions allowed), written into out. */
export function dayTint(hour, out = [1, 1, 1]) {
  let h = Number(hour);
  if (!Number.isFinite(h)) h = 12;
  h = ((h % 24) + 24) % 24;
  for (let i = 1; i < DAY_KEYS.length; i++) {
    const a = DAY_KEYS[i - 1], b = DAY_KEYS[i];
    if (h <= b[0]) {
      const t = b[0] > a[0] ? (h - a[0]) / (b[0] - a[0]) : 0;
      const s = t * t * (3 - 2 * t);
      for (let c = 0; c < 3; c++) out[c] = Math.round((a[c + 1] + (b[c + 1] - a[c + 1]) * s) * 1000) / 1000;
      return out;
    }
  }
  out[0] = DAY_KEYS[0][1]; out[1] = DAY_KEYS[0][2]; out[2] = DAY_KEYS[0][3];
  return out;
}

/** Local hour of a Date as a number (14.5 = half past two in the afternoon). */
export function hourOf(date) {
  return date.getHours() + date.getMinutes() / 60;
}

/** Name of the time of day, for the settings hint. */
export function dayPhase(hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  if (h < 5) return 'night';
  if (h < 8) return 'dawn';
  if (h < 17) return 'day';
  if (h < 20) return 'dusk';
  return 'night';
}

/** The night owl hours: midnight to four in the morning. */
export function isNightOwlHour(hour) {
  const h = Number(hour);
  return Number.isFinite(h) && h >= 0 && h < 4;
}

/**
 * Move `cur` toward `target` by at most `maxStep` per channel. Returns true
 * while it is still moving.
 */
export function stepTint(cur, target, maxStep) {
  let moving = false;
  for (let c = 0; c < 3; c++) {
    const d = target[c] - cur[c];
    if (Math.abs(d) <= maxStep) cur[c] = target[c];
    else { cur[c] += Math.sign(d) * maxStep; moving = true; }
  }
  return moving;
}
