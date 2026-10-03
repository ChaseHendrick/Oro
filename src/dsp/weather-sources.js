// Live weather Link sources (2.10). The main thread sends the latest mapped
// readings ({t:'weather', v:[wind, rain, temp, clouds]}); each source glides
// to its new value in a straight line over WEATHER_GLIDE seconds, so a
// 10-minute update never steps. Idle (never set) the bank does nothing.

export const WEATHER_COUNT = 4;          // Weather Wind, Rain, Temp, Clouds (LINK_SOURCES order)
export const WEATHER_GLIDE = 30;         // seconds to reach a new reading
// Temp is -1..1 (cold..hot); the others are 0..1.
const LO = [0, 0, -1, 0];

export class WeatherBank {
  constructor() {
    this.out = new Float32Array(WEATHER_COUNT);
    this.target = new Float32Array(WEATHER_COUNT);
    this.rate = new Float32Array(WEATHER_COUNT);
    this.active = false;
  }

  /** New readings; snap jumps straight there (a rebuilt DSP catching up). */
  set(values, snap = false) {
    if (!values || typeof values.length !== 'number') return;
    for (let i = 0; i < WEATHER_COUNT; i++) {
      const v = Number(values[i]);
      const t = Number.isFinite(v) ? Math.max(LO[i], Math.min(1, v)) : 0;
      this.target[i] = t;
      if (snap) this.out[i] = t;
      this.rate[i] = Math.abs(t - this.out[i]) / WEATHER_GLIDE;
    }
    this.active = true;
  }

  /** Advance by dt seconds. */
  step(dt) {
    if (!this.active) return;
    let moving = false;
    for (let i = 0; i < WEATHER_COUNT; i++) {
      const d = this.target[i] - this.out[i], s = this.rate[i] * dt;
      if (Math.abs(d) <= s || d === 0) this.out[i] = this.target[i];
      else { this.out[i] += d > 0 ? s : -s; moving = true; }
    }
    this.active = moving;
  }
}
