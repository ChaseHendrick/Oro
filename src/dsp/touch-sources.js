// Touch on the map (2.17): four Link sources and the FX rig of the touch tool.
//
//   Touch X       -1..1  left to right across the map where the finger is
//   Touch Y       -1..1  down to up
//   Touch Height  -1..1  the height of the land under the finger
//   Touch Down     0..1  1 while touching; glides back to 0 when you let go
//
// The main thread sends {t:'touch', v:[x, y, h, down], part, fx} as the
// pointer moves. Each value follows its target with a short smoothing, and
// Down lets go slowly, so whatever the touch drives glides home on release.
// With fx on, the touched track also gets the touch tool's own rig (see
// TOUCH_RIG): no store writes, no undo steps, nothing saved. Idle (never
// touched) the bank does nothing and every source reads 0.

export const TOUCH_COUNT = 4;          // Touch X, Touch Y, Touch Height, Touch Down (LINK_SOURCES order)
export const TOUCH_SMOOTH = 0.015;     // seconds (one-pole time constant) for x, y, height
export const TOUCH_ATTACK = 0.01;      // Down rises this fast
export const TOUCH_RELEASE = 0.35;     // and falls back this slowly

/**
 * The FX rig, in normalised knob travel per unit of each source (scaled by Down):
 * left and right sweep the filter, up opens resonance and throws echo and
 * reverb, down drives it harder, and high ground folds the wave.
 */
export const TOUCH_RIG = Object.freeze({
  cutoff: 0.45,      // x times this
  resonance: 0.32,   // max(0, y) times this
  drive: 0.45,       // max(0, -y) times this
  fold: 0.3,         // max(0, height) times this
  echo: 0.65,        // extra delay send at the top
  space: 0.55,       // extra reverb send at the top
});

export class TouchBank {
  constructor() {
    this.out = new Float32Array(TOUCH_COUNT);
    this.target = new Float32Array(TOUCH_COUNT);
    this.active = false;
    this.part = -1;
    this.fx = false;
  }

  /** New touch values; part is the touched track, fx whether its rig runs. */
  set(values, part = -1, fx = false) {
    if (values && typeof values.length === 'number') {
      for (let i = 0; i < TOUCH_COUNT; i++) {
        const v = Number(values[i]);
        const lo = i === 3 ? 0 : -1;
        this.target[i] = Number.isFinite(v) ? Math.max(lo, Math.min(1, v)) : 0;
      }
    }
    this.part = Number.isInteger(part) ? part : -1;
    this.fx = !!fx;
    this.active = true;
  }

  /** Advance by dt seconds. */
  step(dt) {
    if (!this.active) return;
    const d = Math.max(0, dt);
    const k = 1 - Math.exp(-d / TOUCH_SMOOTH);
    let moving = false;
    for (let i = 0; i < TOUCH_COUNT; i++) {
      const diff = this.target[i] - this.out[i];
      if (Math.abs(diff) < 1e-5) { this.out[i] = this.target[i]; continue; }
      const kk = i === 3 ? 1 - Math.exp(-d / (diff > 0 ? TOUCH_ATTACK : TOUCH_RELEASE)) : k;
      this.out[i] += diff * kk;
      moving = true;
    }
    this.active = moving;
  }

  /** How much rig the part gets right now (0 when it is not the touched track or fx is off). */
  rigAmount(part) {
    return this.fx && part === this.part ? this.out[3] : 0;
  }
}
