import { describe, it, expect } from 'vitest';
import { TrackEffects, FX_TYPES, defaultTrackFx, defaultFxSlot } from '../../src/dsp/track-effects.js';
import { FX_TYPE_MAP, FILTER_SEQ_PATTERNS, fxParamScale, formatFxParam, freqShiftHz } from '../../src/dsp/track-fx-config.js';

const SR = 24000, TAU = Math.PI * 2;
const NEW = ['freqshift', 'hyper', 'filterseq'];
function rack(type, params = {}) {
  const fx = new TrackEffects(SR), cfg = defaultTrackFx();
  cfg.slots[0] = { ...defaultFxSlot(type), mix: 1, ...params }; fx.configure(cfg); return fx;
}
function render(fx, seconds, signal) {
  const L = new Float64Array(Math.round(seconds * SR)), R = new Float64Array(L.length);
  for (let i = 0; i < L.length; i++) { const x = signal(i), y = fx.processSample(typeof x === 'number' ? x : x[0], typeof x === 'number' ? x : x[1]); L[i] = y.L; R[i] = y.R; }
  return { L, R };
}
function amplitude(values, hz, start = 0) {
  let re = 0, im = 0; for (let i = start; i < values.length; i++) { re += values[i] * Math.cos(TAU * hz * i / SR); im += values[i] * Math.sin(TAU * hz * i / SR); }
  return 2 * Math.hypot(re, im) / Math.max(1, values.length - start);
}
function rms(values, start = 0, end = values.length) { let e = 0; for (let i = start; i < end; i++) e += values[i] ** 2; return Math.sqrt(e / Math.max(1, end - start)); }
/** Normalized Shift position for a shift in Hz (inverse of the cubic curve). */
const shiftNorm = (hz) => (Math.cbrt(hz / 2000) + 1) / 2;
function noise(seed = 1) { let x = seed; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296 * 2 - 1; }; }

describe('new track effects: catalogue', () => {
  it('appends the three effects after the existing 27 so saved racks keep their meaning', () => {
    expect(FX_TYPES.length).toBe(31);
    expect(FX_TYPES.slice(-3).map(type => type.id)).toEqual(NEW);
    expect(FX_TYPE_MAP.tape.index).toBe(27);
    for (const id of NEW) { expect(FX_TYPE_MAP[id].params).toHaveLength(4); expect(FX_TYPE_MAP[id].defaults).toHaveLength(4); }
  });
  it('describes ranges and units for the UI', () => {
    expect(fxParamScale('freqshift', 0)).toMatchObject({ min: -2000, max: 2000, curve: 'bipow', k: 3, unit: 'Hz' });
    expect(freqShiftHz(0)).toBe(-2000); expect(freqShiftHz(1)).toBe(2000); expect(freqShiftHz(.5)).toBe(0);
    expect(Math.abs(freqShiftHz(.55))).toBeLessThan(2.1); // fine control near zero
    expect(formatFxParam('freqshift', 0, shiftNorm(100))).toBe('+100 Hz');
    expect(formatFxParam('freqshift', 2, .5)).toBe('Down'); expect(formatFxParam('freqshift', 2, 1)).toBe('Both');
    expect(fxParamScale('freqshift', 2).options).toEqual(['Up', 'Down', 'Both']);
    expect(formatFxParam('hyper', 0, 1)).toBe('5.00 Hz');
    expect(fxParamScale('filterseq', 0)).toMatchObject({ min: 0, max: FILTER_SEQ_PATTERNS.length - 1, curve: 'int' });
    expect(formatFxParam('filterseq', 0, 0)).toBe('Ramp up');
    for (const pattern of FILTER_SEQ_PATTERNS) expect(pattern.steps).toHaveLength(8);
  });
});

describe('new track effects: safety', () => {
  it('keep output finite and bounded for loud noise and extreme settings', () => {
    for (const id of NEW) for (const p of [0, 1]) {
      const fx = rack(id, { p1: p, p2: 1, p3: p, p4: p }), rnd = noise(7);
      fx.setTransport(400, NaN);
      const out = render(fx, 1, () => [rnd() * 2, rnd() * 2]);
      let peak = 0; for (let i = 0; i < out.L.length; i++) { expect(Number.isFinite(out.L[i]) && Number.isFinite(out.R[i])).toBe(true); peak = Math.max(peak, Math.abs(out.L[i]), Math.abs(out.R[i])); }
      expect(peak).toBeLessThanOrEqual(8);
      expect(rms(out.L, out.L.length / 2)).toBeLessThan(6);
    }
  });
  it('pass the input through bit-identically at Mix 0', () => {
    for (const id of NEW) {
      const fx = rack(id, { mix: 0 });
      for (let i = 0; i < 2000; i++) { const L = Math.sin(i * .37) * .8, R = Math.cos(i * .11) * .3, y = fx.processSample(L, R); expect(y.L).toBe(L); expect(y.R).toBe(R); }
    }
  });
  it('keep the slot object shape and buffers while processing', () => {
    for (const id of NEW) {
      const fx = rack(id), slot = fx.slots[0], keys = Object.keys(slot), hilbert = slot.hilbert, phases = slot.voicePhase;
      render(fx, .2, i => Math.sin(i * .05) * .3);
      expect(Object.keys(slot)).toEqual(keys); expect(slot.hilbert).toBe(hilbert); expect(slot.voicePhase).toBe(phases);
    }
  });
});

describe('frequency shifter', () => {
  it('moves a sine by the set number of hertz and suppresses the other sideband', () => {
    for (const [hz, input] of [[100, 440], [-150, 1000], [600, 200]]) {
      const out = render(rack('freqshift', { p1: shiftNorm(hz), p2: 0, p3: 0 }), 1, i => .5 * Math.sin(TAU * input * i / SR));
      const start = SR / 4;
      expect(amplitude(out.L, input + hz, start)).toBeGreaterThan(.45);
      expect(amplitude(out.L, input - hz, start)).toBeLessThan(.02);
      expect(amplitude(out.L, input, start)).toBeLessThan(.02);
    }
  });
  it('shifts the left channel up and the right channel down in Both', () => {
    const out = render(rack('freqshift', { p1: shiftNorm(100), p2: 0, p3: 1 }), 1, i => .5 * Math.sin(TAU * 440 * i / SR)), start = SR / 4;
    expect(amplitude(out.L, 540, start)).toBeGreaterThan(.45); expect(amplitude(out.L, 340, start)).toBeLessThan(.02);
    expect(amplitude(out.R, 340, start)).toBeGreaterThan(.45); expect(amplitude(out.R, 540, start)).toBeLessThan(.02);
    const down = render(rack('freqshift', { p1: shiftNorm(100), p2: 0, p3: .5 }), 1, i => .5 * Math.sin(TAU * 440 * i / SR));
    expect(amplitude(down.L, 340, start)).toBeGreaterThan(.45);
  });
  it('feedback adds further shifted copies that decay', () => {
    const fx = rack('freqshift', { p1: shiftNorm(100), p2: 1, p3: 0, p4: .2 });
    const out = render(fx, 1, i => .3 * Math.sin(TAU * 440 * i / SR)), start = SR / 2;
    expect(amplitude(out.L, 640, start)).toBeGreaterThan(.1);
    const tail = render(fx, 3, () => 0);
    expect(rms(tail.L, tail.L.length - SR / 2)).toBeLessThan(1e-3);
  });
});

describe('hyper dimension', () => {
  it('makes left and right differ for a mono input', () => {
    for (const params of [{}, { p3: 1, p4: 0 }, { p3: 0, p4: 1 }]) {
      const out = render(rack('hyper', params), 1, i => .5 * Math.sin(TAU * 330 * i / SR));
      const diff = rms(out.L.map((x, i) => x - out.R[i]), SR / 4);
      expect(diff).toBeGreaterThan(.05); expect(rms(out.L, SR / 4)).toBeGreaterThan(.1);
    }
  });
  it('stays centred when Width and Dimension are zero', () => {
    const out = render(rack('hyper', { p3: 0, p4: 0 }), .5, i => .5 * Math.sin(TAU * 330 * i / SR));
    for (let i = 0; i < out.L.length; i++) expect(out.L[i]).toBeCloseTo(out.R[i], 12);
  });
  it('detunes the voices more as Detune rises', () => {
    // share of the output power left at the input frequency: pitch modulation moves it into sidebands
    const carrier = (detune) => {
      const out = render(rack('hyper', { p1: .8, p2: detune, p3: 0, p4: 0 }), 2, i => .5 * Math.sin(TAU * 1000 * i / SR));
      return amplitude(out.L, 1000, SR / 2) / (Math.SQRT2 * rms(out.L, SR / 2));
    };
    expect(carrier(0)).toBeGreaterThan(.9);
    expect(carrier(1)).toBeLessThan(carrier(0) * .7);
  });
});

describe('filter sequencer', () => {
  function stepLevels(bpm, pattern, steps = 8) {
    const fx = rack('filterseq', { p1: pattern / (FILTER_SEQ_PATTERNS.length - 1), p2: 0, p3: .2, p4: 1 });
    fx.setTransport(bpm, 0);
    const step = Math.round(SR * 15 / bpm), out = render(fx, step * steps / SR, i => .3 * Math.sin(TAU * 2000 * i / SR));
    return Array.from({ length: steps }, (_, s) => rms(out.L, s * step + step / 4, (s + 1) * step));
  }
  it('opens and closes on each sixteenth note at 120 BPM', () => {
    const levels = stepLevels(120, 2); // Pulse: open, closed, ...
    for (let s = 0; s < 8; s++) {
      if (s % 2 === 0) expect(levels[s]).toBeGreaterThan(.15); else expect(levels[s]).toBeLessThan(.05);
    }
  });
  it('follows the tempo: steps are shorter at 150 BPM', () => {
    const levels = stepLevels(150, 2);
    for (let s = 0; s < 8; s++) expect(levels[s] > .1).toBe(s % 2 === 0);
    const ramp = stepLevels(150, 0);
    // after the first steps' onset transient, each step is brighter than the last
    for (let s = 3; s < 8; s++) expect(ramp[s]).toBeGreaterThan(ramp[s - 1]);
    expect(ramp[7]).toBeGreaterThan(ramp[2] * 5);
  });
  it('locks the steps to the song position while the transport plays', () => {
    const fx = rack('filterseq', { p1: 2 / 7, p2: 0, p3: .2, p4: 1 });
    fx.setTransport(120, .25); // the second sixteenth: a closed step of Pulse
    let closed = render(fx, .1, i => .3 * Math.sin(TAU * 2000 * i / SR));
    expect(rms(closed.L, SR * .02)).toBeLessThan(.05);
    fx.setTransport(120, .5); // the third sixteenth: open
    closed = render(fx, .1, i => .3 * Math.sin(TAU * 2000 * i / SR));
    expect(rms(closed.L, SR * .02)).toBeGreaterThan(.15);
  });
  it('leaves the signal almost unfiltered at Depth zero', () => {
    const fx = rack('filterseq', { p1: 2 / 7, p2: 0, p3: 0, p4: 0 });
    const out = render(fx, .5, i => .3 * Math.sin(TAU * 500 * i / SR));
    expect(amplitude(out.L, 500, SR / 10)).toBeGreaterThan(.29);
  });
});
