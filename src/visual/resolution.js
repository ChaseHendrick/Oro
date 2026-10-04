// Render-resolution budget for the 3D map (2.11).
//
// Big or dense screens (a 5K2K ultrawide, a Retina laptop) would otherwise
// draw 8 to 11 million pixels a frame. In Auto (the default) the drawing
// buffer is capped at MAX_PIXELS and the browser scales the canvas up with
// CSS; a dynamic scale then lowers the internal resolution while frames run
// slow and raises it again when there is headroom. Full keeps the old
// behaviour: device pixels up to the quality preset's pixel-ratio cap.
// Only the 3D canvas is affected; the interface stays at native resolution.

export const RENDER_SCALES = ['auto', 'full'];
export const MAX_PIXELS = 4.5e6;   // drawing-buffer budget in Auto
export const MIN_SCALE = 0.5;      // dynamic scale floor (of the budget ratio)

/**
 * The pixel ratio for a canvas of cssW x cssH CSS pixels: the device ratio,
 * capped by the quality preset, and in Auto also by the pixel budget.
 */
export function budgetPixelRatio(cssW, cssH, dpr, qualityCap, mode = 'auto', maxPixels = MAX_PIXELS) {
  const base = Math.min(dpr > 0 ? dpr : 1, qualityCap > 0 ? qualityCap : 1);
  if (mode === 'full') return base;
  const area = Math.max(1, cssW) * Math.max(1, cssH);
  return Math.min(base, Math.sqrt(maxPixels / area));
}

/** Round a pixel ratio to 1/32 steps so tiny changes do not reallocate targets. */
export function quantizeRatio(pr) {
  return Math.max(1 / 32, Math.round(pr * 32) / 32);
}

/**
 * Dynamic resolution: feed it the gap between painted frames and the frame
 * time it should hold (the display frame, or the frame-rate cap's); it
 * returns the scale (MIN_SCALE..1) to apply to the budget pixel ratio.
 * Slow frames step down quickly; steps back up wait for steady headroom,
 * and wait longer each time an increase had to be undone (no flicker).
 */
export function createDynamicScale({ min = MIN_SCALE, down = 0.85, up = 1.1, slow = 1.3, fast = 1.1, upWait = 2500, maxUpWait = 30000 } = {}) {
  let scale = 1;
  let ratio = 1;          // smoothed frame gap / target
  let lastChange = -Infinity;
  let calmSince = NaN;    // when frames last became fast enough
  let wait = upWait;
  let lastUp = -Infinity;
  let settleUntil = 0;
  return {
    get scale() { return scale; },
    get ratio() { return ratio; },
    /** Ignore frames for `ms` (after a resize, a quality change or a stall). */
    settle(now, ms = 1000) { settleUntil = Math.max(settleUntil, now + ms); ratio = 1; calmSince = NaN; },
    reset() { scale = 1; ratio = 1; lastChange = -Infinity; calmSince = NaN; wait = upWait; lastUp = -Infinity; settleUntil = 0; },
    /** One painted frame; returns true when the scale changed. */
    frame(now, gapMs, targetMs) {
      if (now < settleUntil || !(gapMs > 0) || !(targetMs > 0) || gapMs > 1000) return false;
      ratio += (gapMs / targetMs - ratio) * 0.1;
      if (ratio < fast) { if (!Number.isFinite(calmSince)) calmSince = now; } else calmSince = NaN;
      if (now - lastChange < 500) return false;
      if (ratio > slow && scale > min) {
        if (now - lastUp < 3000) wait = Math.min(maxUpWait, wait * 2); // that step up was too much
        scale = Math.max(min, scale * down);
        lastChange = now; calmSince = NaN; ratio = 1; settleUntil = now + 300;
        return true;
      }
      if (scale < 1 && Number.isFinite(calmSince) && now - calmSince >= wait) {
        scale = Math.min(1, scale * up);
        lastChange = now; lastUp = now; calmSince = now;
        return true;
      }
      return false;
    },
  };
}
