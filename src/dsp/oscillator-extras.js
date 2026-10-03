// Original oscillator building blocks. All live state is allocated before
// rendering. Texture loops are synthesized here, not field recordings.
import { fastSin } from './terrain-math.js';

const TAU = 2 * Math.PI;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export function polyBlep(phase, increment) {
  const dt = Math.min(0.49, Math.max(1e-12, increment));
  if (phase < dt) { const t = phase / dt; return t + t - t * t - 1; }
  if (phase > 1 - dt) { const t = (phase - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
/** Seven sub voices: sine, triangle, saw, pulse25%, square, organ, soft saw. */
export function subWave(type, phase, increment) {
  if (type === 0) return fastSin(phase);
  if (type === 2) return 2 * phase - 1 - polyBlep(phase, increment);
  if (type === 3 || type === 4) {
    const duty = type === 3 ? 0.25 : 0.5;
    const edge = (phase - duty + 1) % 1;
    return (phase < duty ? 1 : -1) - (2 * duty - 1) + polyBlep(phase, increment) - polyBlep(edge, increment);
  }
  let value = 0, norm = 0;
  const max = type === 1 ? 15 : type === 5 ? 3 : 12;
  for (let k = 1; k <= max; k++) {
    const f = k * increment;
    if (f >= 0.49) break;
    const nyquist = f > 0.4 ? (0.49 - f) / 0.09 : 1;
    let amp;
    if (type === 1) { if (!(k & 1)) continue; amp = (k % 4 === 1 ? 1 : -1) / (k * k); }
    else if (type === 5) amp = k === 1 ? 1 : k === 2 ? 0.4 : 0.2;
    else amp = Math.pow(0.72, k - 1) / k;
    value += amp * nyquist * fastSin(phase * k); norm += Math.abs(amp);
  }
  return norm > 0 ? value / norm : 0;
}

export const PROFILE_PARTIALS = 12;
/** Original banks of ratios. Descriptive labels denote sound colours. */
export const INHARMONIC_RATIOS = Array.from({ length: 11 }, (_, profile) => {
  const ratios = new Float64Array(PROFILE_PARTIALS);
  for (let i = 0; i < PROFILE_PARTIALS; i++) {
    const k = i + 1;
    switch (profile) {
      case 1: ratios[i] = Math.pow(k, 1.12); break;
      case 2: ratios[i] = Math.pow(k, 0.86); break;
      case 3: ratios[i] = 2 * k - 1; break;
      case 4: ratios[i] = k === 1 ? 1 : k * Math.sqrt(1 + 0.021 * (k * k - 1)); break;
      case 5: ratios[i] = k === 1 ? 1 : 1 + Math.pow(k - 1, 1.52); break;
      case 6: ratios[i] = [1, 2.756, 5.404, 8.933, 13.35, 18.64, 24.8, 31.83, 39.72, 48.49, 58.11, 68.61][i]; break;
      case 7: ratios[i] = Math.pow((1 + Math.sqrt(5)) / 2, i); break;
      case 8: ratios[i] = 1 + i * 0.37 + (i % 3) * 0.08; break;
      case 9: ratios[i] = k * Math.pow(2, (i === 0 ? 0 : (i & 1 ? 17 : -13)) / 1200); break;
      case 10: ratios[i] = k === 1 ? 1 : 1 + ((i * 7) % 17) * 0.71; break;
      default: ratios[i] = k;
    }
  }
  return ratios;
});
export function profileRatio(profile, partial) {
  const p = clamp(profile, 0, 10), a = Math.floor(p), b = Math.min(10, a + 1);
  return INHARMONIC_RATIOS[a][partial] + (p - a) * (INHARMONIC_RATIOS[b][partial] - INHARMONIC_RATIOS[a][partial]);
}

export class ColourNoise {
  constructor(sampleRate, seed = 1) {
    this.seed = seed | 0 || 1; this.previous = 0; this.brown = 0;
    this.blue = new Float64Array(32); this.blueCoeff = new Float64Array(32); this.blueIndex = 0;
    this.blueCoeff[0]=1; let blueNorm=1;
    for (let i=1;i<32;i++) { this.blueCoeff[i]=this.blueCoeff[i-1]*(i-1-0.5)/i; blueNorm+=this.blueCoeff[i]*this.blueCoeff[i]; }
    this.blueNorm=1/Math.sqrt(blueNorm);
    this.pink = new Float64Array(5); this.alpha = new Float64Array(5); this.scale = new Float64Array(5);
    this.setRate(sampleRate);
  }
  setRate(sampleRate) {
    for (let i = 0; i < 5; i++) {
      const a = 1 - Math.exp(-TAU * Math.min(sampleRate * 0.2, 31.25 * Math.pow(4, i)) / sampleRate);
      this.alpha[i] = a; this.scale[i] = Math.sqrt((2 - a) / a);
    }
    this.brownAlpha = 1 - Math.exp(-TAU * 20 / sampleRate);
    this.brownScale = Math.sqrt((2 - this.brownAlpha) / this.brownAlpha);
  }
  reset(seed = 1) { this.seed = seed | 0 || 1; this.previous = 0; this.brown = 0; this.pink.fill(0); this.blue.fill(0); this.blueIndex=0; }
  sample(type) {
    let seed = this.seed; seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; this.seed = seed;
    const white = seed * 4.656612873077393e-10 * Math.sqrt(3);
    if (type === 2) {
      let sum = 0;
      for (let i = 0; i < 5; i++) { this.pink[i] += this.alpha[i] * (white - this.pink[i]); sum += this.pink[i] * this.scale[i]; }
      return sum / 3.925;
    }
    if (type === 3) {
      this.blue[this.blueIndex]=white;
      let value=0;
      for (let i=0;i<32;i++) value+=this.blueCoeff[i]*this.blue[(this.blueIndex-i)&31];
      this.blueIndex=(this.blueIndex+1)&31;
      return value*this.blueNorm;
    }
    if (type === 4) { this.brown += this.brownAlpha * (white - this.brown); return this.brown * this.brownScale; }
    return white;
  }
}

const TEXTURES = new Map();
/** Generated and seam-faded at setup time, shared by tracks at this rate. */
export function noiseTextures(sampleRate) {
  let textures = TEXTURES.get(sampleRate);
  if (textures) return textures;
  const seconds = 4, n = Math.ceil(seconds * sampleRate);
  textures = Array.from({ length: 3 }, () => new Float32Array(n));
  const noise = new ColourNoise(sampleRate, 0x31af45);
  let rumble = 0, wave = 0, click = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate, x = noise.sample(1);
    rumble += (1 - Math.exp(-TAU * 90 / sampleRate)) * (x - rumble);
    wave += (1 - Math.exp(-TAU * 1200 / sampleRate)) * (x - wave);
    if ((i % Math.round(sampleRate * 0.287)) === 0) click = (i & 1 ? -1 : 1) * 0.7;
    click *= 0.87;
    textures[0][i] = 0.13 * x + 0.6 * rumble + click;
    textures[1][i] = wave * (0.5 + 0.45 * Math.sin(TAU * t / seconds)) * 3;
    textures[2][i] = 1.1 * rumble + 0.12 * x + 0.1 * Math.sin(TAU * (150 * t + 1.5 * Math.sin(TAU * t / seconds)));
  }
  for (const data of textures) fadeLoop(data, sampleRate);
  TEXTURES.set(sampleRate, textures);
  return textures;
}
/** Fade both edges to zero with a raised cosine, making the wrap continuous. */
export function fadeLoop(data, sampleRate) {
  const fade = Math.min(Math.floor(data.length / 4), Math.round(sampleRate * 0.04));
  for (let i = 0; i < fade; i++) {
    const t = i / Math.max(1, fade - 1);
    const weight = 0.5 - 0.5 * Math.cos(Math.PI * t);
    data[i] *= weight;
    data[data.length - 1 - i] *= weight;
  }
  if (data.length) { data[0]=0; data[data.length-1]=0; }
  return data;
}
export function loopSample(data, position) {
  if (!data || !data.length) return 0;
  const p = position - Math.floor(position / data.length) * data.length;
  const i = Math.floor(p), t = p - i;
  return data[i] + t * (data[(i + 1) % data.length] - data[i]);
}

/**
 * Extended Karplus-Strong loop: a noise excitation, weighted one-zero loss
 * filter, fractional allpass tuning and pitch-compensated decay. See Jaffe
 * and Smith, CMJ7(2),1983. The loop evolves independently of the terrain.
 */
export class KarplusStrong {
  constructor(sampleRate, minFreq = 8, capacityRate = sampleRate) {
    this.sampleRate = sampleRate;
    this.buffer = new Float64Array(Math.ceil(capacityRate / minFreq) + 8);
    this.length = 8; this.index = 0; this.previous = 0; this.apX = 0; this.apY = 0;
    this.coefficient = 0; this.loss = 0.99; this.weight = 0.5; this.dispersion = 0; this.dispX = 0; this.dispY = 0;
  }
  tune(freq, decay = 1, tone = 0.5, dispersion = 0) {
    const fs = this.sampleRate, f = clamp(freq, fs / (this.buffer.length - 8), fs * 0.2);
    const omega = TAU * f / fs;
    this.weight = 0.5 * (1 - clamp(tone, 0, 1)) + 0.04;
    const filterPhase = Math.atan2(this.weight * Math.sin(omega), 1 - this.weight + this.weight * Math.cos(omega));
    const filterDelay = filterPhase / omega;
    this.dispersion = clamp(dispersion, 0, 1) * 0.6;
    const dispPhase = 2 * Math.atan((1 - this.dispersion) / (1 + this.dispersion) * Math.tan(omega / 2));
    const total = fs / f - filterDelay - (this.dispersion ? dispPhase / omega : 0);
    const length = Math.max(2, Math.min(this.buffer.length - 2, Math.floor(total)));
    const fractional = total - length;
    const a = Math.tan(fractional * omega / 2) / Math.tan(omega / 2);
    this.coefficient = (1 - a) / (1 + a);
    const magnitude = Math.hypot(1 - this.weight + this.weight * Math.cos(omega), this.weight * Math.sin(omega));
    this.loss = Math.min(0.99995, Math.pow(0.001, 1 / (Math.max(0.05, decay) * f)) / Math.max(1e-9, magnitude));
    this.length = length;
    if (this.index >= length) this.index %= length;
  }
  trigger(freq, decay, tone, dispersion, seed = 1) {
    this.tune(freq, decay, tone, dispersion);
    let random = seed | 0 || 1, sum = 0;
    for (let i = 0; i < this.length; i++) {
      random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
      const v = random * 4.656612873077393e-10;
      this.buffer[i] = v; sum += v;
    }
    const mean = sum / this.length;
    for (let i = 0; i < this.length; i++) this.buffer[i] -= mean;
    this.index = 0; this.previous = this.buffer[this.length - 1]; this.apX = this.apY = this.dispX = this.dispY = 0;
  }
  sample() {
    const x = this.buffer[this.index];
    const filtered = (1 - this.weight) * x + this.weight * this.previous; this.previous = x;
    const tuned = this.coefficient * filtered + this.apX - this.coefficient * this.apY;
    this.apX = filtered; this.apY = tuned;
    let y = tuned;
    if (this.dispersion) {
      y = this.dispersion * tuned + this.dispX - this.dispersion * this.dispY;
      this.dispX = tuned; this.dispY = y;
    }
    this.buffer[this.index] = Math.abs(y) < 1e-20 ? 0 : clamp(y * this.loss, -4, 4);
    if (++this.index === this.length) this.index = 0;
    return x;
  }
  reset() { this.buffer.fill(0,0,this.length); this.index = 0; this.previous = this.apX = this.apY = this.dispX = this.dispY = 0; }
  copyFrom(other) {
    this.buffer.set(other.buffer);
    for (const key of ['length','index','previous','apX','apY','coefficient','loss','weight','dispersion','dispX','dispY']) this[key] = other[key];
  }
}
