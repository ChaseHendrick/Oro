import { describe, it, expect } from 'vitest';
import { TrackEffects, FX_TYPES, FX_ROUTINGS, defaultTrackFx, defaultFxSlot, sanitizeTrackFx } from '../../src/dsp/track-effects.js';

const SR = 24000, TAU = Math.PI * 2;
function rack(type, params = {}, routing = 0) {
  const fx = new TrackEffects(SR), cfg = defaultTrackFx(); cfg.routing = routing;
  cfg.slots[0] = { ...defaultFxSlot(type), mix: 1, ...params }; fx.configure(cfg); return fx;
}
function settle(fx, n = SR * .3) { for (let i = 0; i < n; i++) fx.processSample(0, 0, 0); }
function render(fx, seconds, signal = i => .1 * Math.sin(TAU * 440 * i / SR), sc = 0) {
  const L = new Float64Array(Math.round(seconds * SR)), R = new Float64Array(L.length);
  for (let i = 0; i < L.length; i++) { const input = signal(i), y = fx.processSample(input, input, typeof sc === 'function' ? sc(i) : sc); L[i] = y.L; R[i] = y.R; }
  return { L, R };
}
function rms(values, start = 0) { let e = 0; for (let i = start; i < values.length; i++) e += values[i] ** 2; return Math.sqrt(e / Math.max(1, values.length - start)); }
function amplitude(values, hz, start = 0) {
  let re = 0, im = 0; for (let i = start; i < values.length; i++) { re += values[i] * Math.cos(TAU * hz * i / SR); im += values[i] * Math.sin(TAU * hz * i / SR); }
  return 2 * Math.hypot(re, im) / Math.max(1, values.length - start);
}
function bandPeak(values, lo, hi, start = 0) { let peak = 0; for (let hz = lo; hz <= hi; hz += 2) peak = Math.max(peak, amplitude(values, hz, start)); return peak; }
function tone(type, params, hz, gain = .1) { const fx = rack(type, params); settle(fx); return render(fx, .8, i => gain * Math.sin(TAU * hz * i / SR)).L; }

describe('track effect catalogue and bypass', () => {
  it('provides distinct processors and ten routing layouts with independent defaults', () => {
    expect(FX_TYPES.filter(type => type.id !== 'bypass').length).toBeGreaterThanOrEqual(22);
    expect(new Set(FX_TYPES.map(type => type.id)).size).toBe(FX_TYPES.length);
    expect(FX_ROUTINGS.length).toBeGreaterThanOrEqual(9);
    const first = defaultTrackFx(), second = defaultTrackFx(); first.slots[0].mix = 1;
    expect(first.slots[1].mix).toBe(0); expect(second.slots[0].mix).toBe(0);
  });
  it('sanitizes malformed persisted values and always keeps four slots', () => {
    const fx = sanitizeTrackFx({ routing: 100, sidechain: '<bad>', slots: [{ type: 'duck', mix: NaN, p1: -1, p2: 9 }, { type: 'unknown' }] });
    expect(fx.routing).toBe(FX_ROUTINGS.length - 1); expect(fx.sidechain).toBe('self'); expect(fx.slots).toHaveLength(4);
    expect(fx.slots[0]).toMatchObject({ type: 'duck', mix: .5, p1: 0, p2: 1 }); expect(fx.slots[1].type).toBe('bypass');
    expect(sanitizeTrackFx({ sidechain: 'track-7' }).sidechain).toBe('track-7');
  });
  it('keeps four bypass slots and four zero-mix active slots bit-identical under every routing', () => {
    for (const route of FX_ROUTINGS) for (const active of [false, true]) {
      const fx = new TrackEffects(SR), cfg = defaultTrackFx(); cfg.routing = route.id;
      if (active) cfg.slots = ['delay', 'overdrive', 'eq4', 'ott'].map(type => ({ ...defaultFxSlot(type), mix: 0 }));
      fx.configure(cfg);
      for (let i = 0; i < 200; i++) { const L = Math.sin(i) * 12, R = Math.cos(i) * 2; const out = fx.processSample(L, R); expect(out.L).toBe(L); expect(out.R).toBe(R); }
    }
  });
  it('reuses render output, meter and all slot histories', () => {
    const fx = rack('shimmer'), out = fx.out, meter = fx.meter(), history = fx.slots[0].bufL, fdn = fx.slots[0].fdn[0];
    const keys = Object.keys(fx.slots[0]);
    for (let i = 0; i < 10000; i++) expect(fx.processSample(Math.sin(i) * .1, 0)).toBe(out);
    expect(fx.meter()).toBe(meter); expect(fx.slots[0].bufL).toBe(history); expect(fx.slots[0].fdn[0]).toBe(fdn);
    expect(Object.keys(fx.slots[0])).toEqual(keys);
    expect(meter.peak).toBeGreaterThan(0); expect(meter.rms).toBeGreaterThan(0);
  });
});

describe('effect impulse, spectrum and dynamics', () => {
  it('places delay echoes at the selected time and ping-pong echoes alternate channels', () => {
    const fx = rack('delay', { p1: 0, p2: .5, p3: 1, p4: 0 }); settle(fx);
    const out = render(fx, .1, i => i === 0 ? 1 : 0);
    expect(out.L[SR * .02]).toBeCloseTo(1, 5); expect(Math.abs(out.L[SR * .04])).toBeGreaterThan(.3);
    expect(out.L.slice(1, SR * .02).every(x => Math.abs(x) < 1e-8)).toBe(true);
    const ping = rack('pingpong', { p1: 0, p2: .7, p3: 1, p4: 1 }); settle(ping);
    const at = []; for (let i = 0; i < SR * .08; i++) { const y = ping.processSample(i === 0 ? 1 : 0, 0); if ([480, 960, 1440].includes(i)) at.push([y.L, y.R]); }
    expect(at[0][0]).toBeGreaterThan(.45); expect(Math.abs(at[0][1])).toBeLessThan(1e-6);
    expect(at[1][1]).toBeGreaterThan(.2); expect(Math.abs(at[1][0])).toBeLessThan(1e-6);
    expect(at[2][0]).toBeGreaterThan(.1);
  });
  it('reverb has a diffuse decaying tail and shimmer adds an octave region', () => {
    const fx = rack('reverb', { p2: .25 }); settle(fx); const impulse = render(fx, 2, i => i === 0 ? 1 : 0).L;
    expect(rms(impulse.slice(SR * .05, SR * .25))).toBeGreaterThan(.001);
    expect(rms(impulse.slice(SR * 1.5))).toBeLessThan(rms(impulse.slice(SR * .1, SR * .5)));
    const rev = tone('reverb', { p1: .65, p2: .55, p3: .45, p4: .8 }, 440, .2);
    const shimmer = tone('shimmer', { p4: 1 }, 440, .2);
    expect(bandPeak(shimmer, 840, 920, SR * .4)).toBeGreaterThan(bandPeak(rev, 840, 920, SR * .4) * 3);
  });
  it('granular grains transpose audio into the selected octave region', () => {
    const pitched = tone('granular', { p1: .75, p3: 0, p4: 0 }, 440);
    expect(bandPeak(pitched, 850, 910, SR * .4)).toBeGreaterThan(.025);
    expect(bandPeak(pitched, 850, 910, SR * .4)).toBeGreaterThan(amplitude(pitched, 440, SR * .4) * 10);
  });
  it('ring modulation produces measured sum and difference sidebands', () => {
    const ring = tone('ringmod', { p1: Math.log(300 / 20) / Math.log(100), p2: 1 }, 1000);
    expect(amplitude(ring, 700, SR * .3)).toBeGreaterThan(.045); expect(amplitude(ring, 1300, SR * .3)).toBeGreaterThan(.045);
    expect(amplitude(ring, 1000, SR * .3)).toBeLessThan(.001);
  });
  it('EQ bands and filter slopes alter their intended frequency regions', () => {
    const lp = { p1: Math.log(800 / 20) / Math.log(900), p2: 0, p3: 0, p4: 1 };
    const hp = { ...lp };
    expect(rms(tone('lowpass', lp, 5000), SR * .3)).toBeLessThan(rms(tone('lowpass', lp, 100), SR * .3) * .02);
    expect(rms(tone('highpass', hp, 100), SR * .3)).toBeLessThan(rms(tone('highpass', hp, 5000), SR * .3) * .03);
    for (const [field, hz] of [['p1', 40], ['p2', 500], ['p3', 3000], ['p4', 11000]]) {
      const flat = rms(tone('eq4', {}, hz), SR * .3), boost = rms(tone('eq4', { [field]: 1 }, hz), SR * .3), cut = rms(tone('eq4', { [field]: 0 }, hz), SR * .3);
      expect(boost).toBeGreaterThan(flat * 2); expect(cut).toBeLessThan(flat * .5);
    }
  });
  it('overdrive, distortion and warmth add harmonics through different transfer curves', () => {
    const drive = tone('overdrive', { p1: .8, p2: 1, p3: .5, p4: .6 }, 300, .1);
    const distortion = tone('distortion', { p1: .8, p2: .2, p3: .8, p4: 1 }, 300, .1);
    const warmth = tone('warmth', { p1: .8, p2: .5, p3: 1, p4: .5 }, 300, .1);
    expect(amplitude(drive, 900, SR * .3)).toBeGreaterThan(.05); expect(amplitude(warmth, 900, SR * .3)).toBeGreaterThan(.005);
    expect(rms(drive, SR * .3)).not.toBeCloseTo(rms(distortion, SR * .3), 2); expect(rms(warmth, SR * .3)).not.toBeCloseTo(rms(drive, SR * .3), 2);
  });
  it('decimator has exact quantization steps and independent sample holding', () => {
    const fx = rack('decimator', { p1: 0, p2: 0, p3: 0, p4: 0 }); settle(fx);
    for (let i = 0; i < 100; i++) { const y = fx.processSample(Math.sin(i) * .7, .2).L; expect(y * 4).toBeCloseTo(Math.round(y * 4), 8); }
    const held = rack('decimator', { p1: 1, p2: 1, p3: 0, p4: 0 }); settle(held);
    const out = render(held, .1, i => i / (SR * .1)).L; let changes = 0; for (let i = 1; i < out.length; i++) if (Math.abs(out[i] - out[i - 1]) > 1e-8) changes++;
    expect(changes).toBeLessThan(45); expect(changes).toBeGreaterThan(25);
  });
  it('ducking follows external sidechain and compressors reduce loud audio but OTT lifts quiet audio', () => {
    const dryDuck = rack('duck', { p1: 1, p2: .5, p3: 0, p4: .2 }); settle(dryDuck);
    const wetDuck = rack('duck', { p1: 1, p2: .5, p3: 0, p4: .2 }); settle(wetDuck);
    expect(rms(render(wetDuck, .5, undefined, .8).L, SR * .2)).toBeLessThan(rms(render(dryDuck, .5).L, SR * .2) * .03);
    expect(wetDuck.meter().reduction).toBeLessThan(.03);
    const loud = tone('compressor', { p1: .3, p2: 1, p3: 0, p4: .2 }, 440, .8);
    expect(rms(loud, SR * .3)).toBeLessThan(.06);
    const quietOtt = tone('ott', { p1: 1, p2: 0, p3: .5, p4: 1 }, 120, .003);
    const loudOtt = tone('ott', { p1: 1, p2: 0, p3: .5, p4: 1 }, 120, 1);
    expect(rms(quietOtt, SR * .3)).toBeGreaterThan(.003 * Math.SQRT1_2 * 2);
    expect(rms(loudOtt, SR * .3)).toBeLessThan(.6);
  });
  it('limiter enforces its ceiling and the gate attenuates quiet input', () => {
    const ceiling = Math.pow(10, -6 / 20), limiter = rack('limiter', { p1: .5, p2: .8, p3: .5 }); settle(limiter);
    const out = render(limiter, .3, i => i % 131 < 3 ? 2 : .05 * Math.sin(i)).L;
    expect(Math.max(...out.map(Math.abs))).toBeLessThanOrEqual(ceiling + 1e-8);
    const gated = tone('gate', { p1: .9, p2: 0, p3: 0, p4: 0 }, 440, .005);
    expect(rms(gated, SR * .3)).toBeLessThan(.00001);
  });
  it('chorus, flanger and phaser have distinct moving impulse responses', () => {
    const signatures = [];
    for (const type of ['chorus', 'flanger', 'phaser']) {
      const fx = rack(type, { p1: .7, p2: .8, p3: .7, p4: .8 }); settle(fx);
      const response = render(fx, .25, i => i === 0 ? 1 : 0), early = rms(response.L.slice(0, 120)), late = rms(response.L.slice(120));
      expect(rms(response.L)).toBeGreaterThan(.001); signatures.push([early, late, response.L[240]].map(x => x.toFixed(5)).join(':'));
    }
    expect(new Set(signatures).size).toBe(3);
  });
  it('tremolo and auto pan modulate gain while stereo width preserves or separates mid and side', () => {
    const tremolo = rack('tremolo', { p1: 1, p2: 1, p3: 0, p4: 0 }); settle(tremolo);
    const trem = render(tremolo, .3, () => .2);
    expect(Math.max(...trem.L) - Math.min(...trem.L)).toBeGreaterThan(.18);
    expect(rms(trem.L.map((x, i) => x - trem.R[i]))).toBeLessThan(1e-8);
    const pan = rack('autopan', { p1: 1, p2: 1, p3: 0, p4: .5 }); settle(pan);
    const panned = render(pan, .3, () => .2); expect(rms(panned.L.map((x, i) => x - panned.R[i]))).toBeGreaterThan(.1);
    const mono = rack('stereo', { p1: 0, p2: .5, p3: 0, p4: 0 }); settle(mono);
    expect(mono.processSample(.2, -.2).L).toBeCloseTo(0, 7); expect(mono.out.R).toBeCloseTo(0, 7);
    const wide = rack('stereo', { p1: 1, p2: .5, p3: 0, p4: 0 }); settle(wide);
    expect(wide.processSample(.2, -.2).L).toBeCloseTo(.4, 7); expect(wide.out.R).toBeCloseTo(-.4, 7);
  });
  it('comb feedback rings, envelope wah follows level, and tape colours a pure tone', () => {
    const comb = rack('comb', { p1: .3, p2: .9, p3: .8 }); settle(comb);
    const impulse = render(comb, .2, i => i === 0 ? 1 : 0).L;
    expect(rms(impulse.slice(100, 1000))).toBeGreaterThan(.005);
    const wahQuiet = tone('wah', { p1: 1, p2: .7, p3: 1, p4: .3 }, 300, .01), wahLoud = tone('wah', { p1: 1, p2: .7, p3: 1, p4: .3 }, 300, .4);
    expect(rms(wahQuiet, SR * .3) / .01).toBeGreaterThan(rms(wahLoud, SR * .3) / .4 * 3);
    const tape = tone('tape', { p1: 1, p2: 0, p3: 1, p4: 0 }, 300, .2);
    expect(amplitude(tape, 900, SR * .3)).toBeGreaterThan(.005);
  });
});

describe('routing, changes and stability', () => {
  it('implements parallel and serial branch arithmetic rather than selecting the same chain', () => {
    const cfg = defaultTrackFx(); cfg.slots = [0, 1, 2, 3].map(i => ({ ...defaultFxSlot('stereo'), mix: 1, p1: .5, p2: [.2, .4, .6, .8][i], p3: 0, p4: 0 }));
    const values = [];
    for (let routing = 0; routing < 10; routing++) { const fx = new TrackEffects(SR); fx.configure({ ...cfg, routing }); settle(fx, SR * .8); for (let i = 0; i < 2000; i++) fx.processSample(.2, .2); values.push([fx.out.L, fx.out.R]); }
    const expected = [[.064, .064], [.16, .16], [.132, .132], [.072, .072], [.064, .12], [.1466666667, .0746666667], [.0746666667, .1466666667], [.132, .132], [.2, .064], [.132, .132]];
    for (let route = 0; route < 10; route++) { expect(values[route][0], `route ${route} left`).toBeCloseTo(expected[route][0], 5); expect(values[route][1], `route ${route} right`).toBeCloseTo(expected[route][1], 5); }
    expect(new Set(values.map(v => v.map(x => x.toFixed(4)).join(':'))).size).toBeGreaterThanOrEqual(8);
  });
  it('all ten layouts produce distinct responses for asymmetric multitone stereo input', () => {
    const cfg = defaultTrackFx(); cfg.slots = [
      { ...defaultFxSlot('lowpass'), mix: .85, p1: .45 },
      { ...defaultFxSlot('overdrive'), mix: .7 },
      { ...defaultFxSlot('delay'), mix: .8, p1: 0 },
      { ...defaultFxSlot('ringmod'), mix: .65, p1: .5 },
    ];
    const signatures = [];
    for (const route of FX_ROUTINGS) {
      const fx = new TrackEffects(SR); fx.configure({ ...cfg, routing: route.id }); settle(fx, SR * .4);
      let eL = 0, eR = 0, cross = 0;
      for (let i = 0; i < SR * .2; i++) { const y = fx.processSample(.15 * Math.sin(TAU * 130 * i / SR) + .07 * Math.sin(TAU * 2300 * i / SR), .1 * Math.sin(TAU * 700 * i / SR) - .06 * Math.sin(TAU * 4500 * i / SR)); eL += y.L * y.L; eR += y.R * y.R; cross += y.L * y.R; }
      signatures.push([eL, eR, cross].map(x => x.toFixed(3)).join(':'));
    }
    expect(new Set(signatures).size).toBe(10);
  });
  it('smooths effect replacement and routing changes without a one-sample discontinuity', () => {
    const fx = rack('overdrive', { p1: .8 }); settle(fx); for (let i = 0; i < SR; i++) fx.processSample(.1, .1);
    const before = fx.out.L, cfg = defaultTrackFx(); cfg.slots[0] = { ...defaultFxSlot('highpass'), mix: 1 }; cfg.routing = 1; fx.configure(cfg);
    expect(Math.abs(fx.processSample(.1, .1).L - before)).toBeLessThan(.003);
    settle(fx); fx.reset(); expect(fx.meter().peak).toBe(0); expect(fx.out.L).toBe(0);
  });
  it('every real effect produces finite bounded output at extreme settings and releases after reset', () => {
    for (const type of FX_TYPES.filter(type => type.id !== 'bypass')) for (const value of [0, 1]) {
      const fx = rack(type.id, { p1: value, p2: value, p3: value, p4: value }); settle(fx, SR * .15);
      let energy = 0; for (let i = 0; i < SR * .3; i++) { const x = i === 0 ? 4 : .2 * Math.sin(i * .183) + .03 * Math.sin(i * .011); const y = fx.processSample(x, -x * .8, i % 512 < 128 ? 1 : 0); expect(Number.isFinite(y.L) && Number.isFinite(y.R), type.id).toBe(true); expect(Math.max(Math.abs(y.L), Math.abs(y.R)), type.id).toBeLessThanOrEqual(8.001); energy += y.L * y.L + y.R * y.R; }
      expect(energy, type.id).toBeGreaterThan(0); fx.reset(); expect(fx.meter().rms).toBe(0);
    }
  });
});
