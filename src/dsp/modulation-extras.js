import { fastSin } from './terrain-math.js';
// Delay, attack, hold, decay, sustain and release envelopes. These helpers
// complement the legacy ADSR fast path, which remains unchanged at defaults.
export const ENV_STAGE = Object.freeze({ idle: 0, delay: 1, attack: 2, hold: 3, decay: 4, sustain: 5, release: 6, reverseDecay: 7, reverseAttack: 8 });
const FLOOR = 0.001, OVERSHOOT = 1.2;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

/** Config layout: delay, attack, hold, decay, sustain, release, mode. */
export class SixStageEnvelope {
  constructor() {
    this.config = new Float64Array([0, 0.01, 0, 0.6, 0.25, 0.5, 0]);
    this.stage = 0; this.value = 0; this.elapsed = 0; this.gate = false; this.from = 0;
    this.dt = -1; this.attackC = this.decayC = this.releaseC = 0; this.times = new Float64Array(3).fill(-1);
  }
  configure(config, dt = this.dt) {
    this.config.set(config);
    if (dt !== this.dt || this.times[0] !== config[1] || this.times[1] !== config[3] || this.times[2] !== config[5]) {
      this.dt = dt;
      this.times[0] = config[1]; this.times[1] = config[3]; this.times[2] = config[5];
      this.attackC = Math.exp(Math.log((OVERSHOOT - 1) / OVERSHOOT) * dt / Math.max(1e-6, config[1]));
      this.decayC = Math.exp(Math.log(FLOOR) * dt / Math.max(1e-6, config[3]));
      this.releaseC = Math.exp(Math.log(FLOOR) * dt / Math.max(1e-6, config[5]));
    }
  }
  trigger(keepLevel = false) {
    if (!keepLevel) this.value = 0;
    this.gate = true; this.stage = this.config[0] > 0 ? 1 : (this.config[6] === 5 ? 3 : 2);
    if (this.config[6] === 5 && !this.config[0]) this.value = 1;
    this.elapsed = 0; this.from = this.value;
  }
  release(force = false) {
    this.gate = false;
    if (!force && (this.config[6] === 1 || this.config[6] === 4)) return;
    if (this.stage) { this.stage = 6; this.elapsed = 0; this.from = this.value; }
  }
  enter(stage) { this.stage = stage; this.elapsed = 0; this.from = this.value; }
  sample(dt) {
    if (dt !== this.dt) this.configure(this.config, dt);
    const c = this.config, mode = c[6];
    this.elapsed += dt;
    switch (this.stage) {
      case 1:
        if (this.elapsed >= c[0]) { this.enter(mode === 5 ? 3 : 2); if (mode === 5) this.value = 1; }
        break;
      case 2: {
        const coefficient = this.attackC;
        this.value = OVERSHOOT + (this.value - OVERSHOOT) * coefficient;
        if (this.value >= 1 || this.elapsed >= c[1]) { this.value = 1; this.enter(c[2] > 0 ? 3 : 4); }
        break;
      }
      case 3:
        this.value = 1;
        if (this.elapsed >= c[2]) this.enter(4);
        break;
      case 4: {
        const target = mode === 2 || mode === 5 ? 0 : c[4];
        const coefficient = this.decayC;
        this.value = target + (this.value - target) * coefficient;
        if (this.elapsed >= c[3]) {
          this.value = target;
          if (mode === 2 && this.gate) { this.value = 0; this.enter(c[0] > 0 ? 1 : 2); }
          else if (mode === 3 && this.gate) this.enter(7);
          else if (mode === 1) this.enter(6);
          else if (mode === 5) { this.stage = 0; this.value = 0; }
          else this.enter(5);
        }
        break;
      }
      case 5:
        this.value = c[4];
        if (!this.gate && mode !== 4) this.enter(6);
        break;
      case 6: {
        const coefficient = this.releaseC;
        this.value = -FLOOR + (this.value + FLOOR) * coefficient;
        if (this.value <= 0 || this.elapsed >= c[5]) { this.stage = 0; this.value = 0; }
        break;
      }
      case 7: {
        const t = clamp(this.elapsed / Math.max(1e-6, c[3]), 0, 1);
        this.value = c[4] + (1 - c[4]) * t;
        if (t >= 1) this.enter(8);
        break;
      }
      case 8: {
        const t = clamp(this.elapsed / Math.max(1e-6, c[1]), 0, 1);
        this.value = 1 - t;
        if (t >= 1) { this.value = 0; this.enter(c[0] > 0 ? 1 : 2); }
        break;
      }
      default: this.value = 0;
    }
    return this.value;
  }
  reset() { this.stage = 0; this.value = 0; this.elapsed = 0; this.gate = false; this.from = 0; }
  copyFrom(other) { this.configure(other.config, other.dt); this.stage = other.stage; this.value = other.value; this.elapsed = other.elapsed; this.gate = other.gate; this.from = other.from; }
}

/** Skew changes the duration of the two half cycles without a phase jump. */
export function skewLfoPhase(phase, skew) {
  if (!skew) return phase;
  const division = 0.5 + 0.45 * clamp(skew, -1, 1);
  return phase < division ? 0.5 * phase / division : 0.5 + 0.5 * (phase - division) / (1 - division);
}
/** A 32-step ramp, with duration and optional smoothstep interpolation. */
export function steppedLfo(steps, base, phase, stepSeconds, glide, smooth, count = 32) {
  const x = phase * count, index = Math.min(count - 1, Math.floor(x));
  const current = steps[base + index], prior = steps[base + (index ? index - 1 : count - 1)];
  const seconds = Math.max(0.002, Math.max(0, glide) * stepSeconds);
  let t = clamp((x - index) * stepSeconds / seconds, 0, 1);
  if (smooth) t += clamp(smooth, 0, 1) * (t * t * (3 - 2 * t) - t);
  return prior + t * (current - prior);
}

/** Stateless UI preview. elapsedSeconds controls delay/attack/count; Infinity previews steady shape. */
export function previewLfo(settings, phase, periodSeconds = 1 / (settings.lfoRate || 0.5), elapsedSeconds = Infinity, random0 = 0, random1 = 0) {
  let ph=phase+(settings.lfoPhase || 0); ph-=Math.floor(ph); ph=skewLfoPhase(ph,settings.lfoSkew || 0);
  let value=0;
  switch (settings.lfoShape || 0) {
    case 0: value=fastSin(ph); break;
    case 1: value=ph < .25 ? 4*ph : ph < .75 ? 2-4*ph : 4*ph-4; break;
    case 2: value=2*ph-1; break;
    case 3: value=ph < .5 ? 1 : -1; break;
    case 4: value=random1; break;
    case 5: value=random0+(random1-random0)*ph*ph*(3-2*ph); break;
    case 6: if (settings.steps?.length) value=steppedLfo(settings.steps,0,ph,periodSeconds/settings.steps.length,settings.stepGlide || 0,settings.stepSmooth || 0,settings.steps.length); break;
  }
  const age=elapsedSeconds-(settings.lfoDelay || 0);
  const gain=age <= 0 ? 0 : settings.lfoAttack ? Math.min(1,age/settings.lfoAttack) : 1;
  const completed=Number.isFinite(elapsedSeconds) && settings.lfoCount && age >= settings.lfoCount*periodSeconds;
  return clamp((settings.lfoOffset || 0)+(completed ? 0 : value*gain),-1,1);
}
