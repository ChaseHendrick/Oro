// Original digital virtual-analog filters. The ladder follows cascaded
// trapezoidal one-pole integrators with an implicit feedback solve. This
// preserves the loop topology; nonlinear colour is solved at the input.
// The diode colour uses a coupled passive four-cell ladder and an asymmetric
// saturation curve. These are musical digital models, not hardware clones.
// Background: Huovilainen, DAFx2004, Non-Linear Digital Implementation of the
// Moog Ladder Filter: https://www.dafx.de/paper-archive/2004/P_061.PDF

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
function sat(x) {
  if (x >= 3) return 1;
  if (x <= -3) return -1;
  const x2 = x * x;
  return x * (27 + x2) / (27 + 9 * x2);
}
function satDerivative(x) {
  if (x >= 3 || x <= -3) return 0;
  const x2 = x * x, den = 27 + 9 * x2;
  return ((27 + 3 * x2) * den - (27 * x + x * x2) * 18 * x) / (den * den);
}

export class AnalogFilter {
  constructor() {
    this.state = new Float64Array(8);
    this.inverse = new Float64Array(16);
    this.augmented = new Float64Array(32);
    this.response = new Float64Array(4);
    this.work = new Float64Array(4);
    this.mode = 8; this.g = 0.1; this.G = 0.1 / 1.1; this.k = 0; this.formant = 0.5; this.lastDiodeG = -1;
  }
  reset() { this.state.fill(0); }
  copyFrom(other) { this.state.set(other.state); }
  configure(mode, g, resonance, formant = 0.5) {
    this.mode = mode;
    this.g = clamp(Number.isFinite(g) ? g : 0.1, 1e-6, 12);
    this.G = this.g / (1 + this.g);
    this.k = 3.95 * clamp(resonance, 0, 1);
    this.formant = clamp(formant, 0, 1);
    if (mode === 11 && this.g !== this.lastDiodeG) this.prepareDiode();
  }
  prepareDiode() {
    const g = this.g, a = this.augmented;
    a.fill(0);
    // (I - g*A), with A the conductance matrix of a coupled RC ladder.
    for (let row = 0; row < 4; row++) {
      a[row * 8 + row] = 1 + (row === 3 ? g : 2 * g);
      if (row) a[row * 8 + row - 1] = -g;
      if (row < 3) a[row * 8 + row + 1] = -g;
      a[row * 8 + 4 + row] = 1;
    }
    for (let row = 0; row < 4; row++) {
      const divisor = a[row * 8 + row];
      for (let col = 0; col < 8; col++) a[row * 8 + col] /= divisor;
      for (let other = 0; other < 4; other++) {
        if (other === row) continue;
        const mult = a[other * 8 + row];
        for (let col = 0; col < 8; col++) a[other * 8 + col] -= mult * a[row * 8 + col];
      }
    }
    for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) this.inverse[row * 4 + col] = a[row * 8 + 4 + col];
    for (let row = 0; row < 4; row++) this.response[row] = g * this.inverse[row * 4];
    this.lastDiodeG = g;
  }
  sample(x, channel = 0) {
    const offset = channel * 4, s = this.state;
    if (this.mode === 10) {
      const g = this.g, k = Math.max(0.04, 2 - this.k * 0.49);
      const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
      const v3 = x - s[offset + 1], band = a1 * s[offset] + a2 * v3;
      const low = s[offset + 1] + a2 * s[offset] + a3 * v3;
      s[offset] = 2 * band - s[offset]; s[offset + 1] = 2 * low - s[offset + 1];
      const high = x - k * band - low;
      const blend = this.formant * 2;
      return blend <= 1 ? low + blend * (high + low - low) : high + (2 - blend) * low;
    }
    if (this.mode === 11) return this.diode(x, offset);
    const G = this.G, complement = 1 - G;
    const G2 = G * G, G3 = G2 * G, G4 = G3 * G;
    const stored = complement * (G3 * s[offset] + G2 * s[offset + 1] + G * s[offset + 2] + s[offset + 3]);
    let input;
    const drive = this.mode === 7 ? 1.5 : this.mode === 9 ? 4 : 0;
    if (!drive) input = (x - this.k * stored) / (1 + this.k * G4);
    else {
      input = (x - this.k * stored) / (1 + this.k * G4);
      for (let i = 0; i < 4; i++) {
        const argument = drive * (x - this.k * (G4 * input + stored));
        const error = input - sat(argument) / drive;
        input -= error / (1 + this.k * G4 * satDerivative(argument));
      }
    }
    let value = input;
    for (let i = 0; i < 4; i++) {
      const output = G * value + complement * s[offset + i];
      s[offset + i] = 2 * output - s[offset + i];
      value = output;
    }
    if (!Number.isFinite(value) || Math.abs(value) > 32) { for (let i = 0; i < 4; i++) s[offset + i] = 0; return 0; }
    return value * (1 + this.k * 0.35);
  }
  diode(x, offset) {
    const s = this.state, inverse = this.inverse, work = this.work, response = this.response;
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let col = 0; col < 4; col++) sum += inverse[row * 4 + col] * s[offset + col];
      work[row] = sum;
    }
    const k = this.k * 0.8, bias = 0.12, drive = 2.5;
    let input = (x - k * work[3]) / (1 + k * response[3]);
    for (let i = 0; i < 4; i++) {
      const argument = drive * (x - k * (response[3] * input + work[3])) + bias;
      const error = input - (sat(argument) - sat(bias)) / drive;
      input -= error / (1 + k * response[3] * satDerivative(argument));
    }
    let output = 0;
    for (let row = 0; row < 4; row++) {
      const value = work[row] + response[row] * input;
      s[offset + row] = 2 * value - s[offset + row];
      if (row === 3) output = value;
    }
    if (!Number.isFinite(output) || Math.abs(output) > 32) { for (let i = 0; i < 4; i++) s[offset + i] = 0; return 0; }
    return output * (1 + k * 0.45);
  }
}
