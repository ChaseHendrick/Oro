// Game controller Link sources (2.11): the right stick's X and Y, -1..1. The
// main thread sends {t:'pad', v:[x, y]} only when the stick moves; each value
// follows its target with a short smoothing (PAD_SMOOTH seconds) so a 60 Hz
// poll never steps. Idle (never set) the bank does nothing and reads 0.

export const PAD_COUNT = 2;              // Pad Stick X, Pad Stick Y (LINK_SOURCES order)
export const PAD_SMOOTH = 0.03;          // seconds (one-pole time constant)

export class PadBank {
  constructor() {
    this.out = new Float32Array(PAD_COUNT);
    this.target = new Float32Array(PAD_COUNT);
    this.active = false;
  }

  /** New stick position; snap jumps straight there (a rebuilt DSP catching up). */
  set(values, snap = false) {
    if (!values || typeof values.length !== 'number') return;
    for (let i = 0; i < PAD_COUNT; i++) {
      const v = Number(values[i]);
      const t = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
      this.target[i] = t;
      if (snap) this.out[i] = t;
    }
    this.active = true;
  }

  /** Advance by dt seconds. */
  step(dt) {
    if (!this.active) return;
    const k = 1 - Math.exp(-Math.max(0, dt) / PAD_SMOOTH);
    let moving = false;
    for (let i = 0; i < PAD_COUNT; i++) {
      const d = this.target[i] - this.out[i];
      if (Math.abs(d) < 1e-5) this.out[i] = this.target[i];
      else { this.out[i] += d * k; moving = true; }
    }
    this.active = moving;
  }
}
