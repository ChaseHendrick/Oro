import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  makeChirp, makeMls, findDelay, softClip, limiterCurve, limiterGains, createFeedbackDetector,
  planRouting, buildOutputRouting, createSendLimiter, openReturn, returnConstraints, analyseRun, combineRuns,
  applyOutputDevice,
} from '../../src/pedals/pedal-loop.js';
import { makeRandom, dbToGain, gainToDb, rms } from '../../src/pedals/signal.js';
import { fakeContext } from './fake-audio.js';
import { pluck } from './signals.js';

// Signal-heavy tests: generous timeouts, the CI box may be busy.
const HEAVY = 60000;

const SR = 48000;

// Band-limited fractional delay (Hann-windowed sinc), so "the true delay" is exact.
function delayed(x, d, len, gain = 1) {
  const out = new Float32Array(len);
  const H = 32;
  for (let n = 0; n < len; n++) {
    const p = n - d;
    const i0 = Math.floor(p);
    let s = 0;
    for (let k = i0 - H; k <= i0 + H; k++) {
      if (k < 0 || k >= x.length) continue;
      const u = p - k;
      const w = 0.5 + 0.5 * Math.cos(Math.PI * u / (H + 1));
      s += x[k] * (Math.abs(u) < 1e-12 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u)) * w;
    }
    out[n] = s * gain;
  }
  return out;
}
function addNoise(y, ref, snrDb, seed = 1) {
  const r = makeRandom(seed);
  const p = rms(ref) ** 2;
  // Uniform noise has variance a^2 / 3.
  const a = Math.sqrt(3 * p / Math.pow(10, snrDb / 10));
  for (let i = 0; i < y.length; i++) y[i] += a * (r() * 2 - 1);
  return y;
}
/** Linear-phase FIR low-pass (windowed sinc), group delay (taps - 1) / 2. */
function firLowpass(x, cutoffHz, taps = 63) {
  const h = new Float64Array(taps);
  const fc = cutoffHz / SR;
  const M = taps - 1;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const m = i - M / 2;
    const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / M);
    h[i] = (m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m)) * w;
    sum += h[i];
  }
  const y = new Float32Array(x.length);
  for (let n = 0; n < x.length; n++) {
    let s = 0;
    for (let i = 0; i < taps && i <= n; i++) s += h[i] * x[n - i];
    y[n] = s / sum;
  }
  return { y, groupDelay: M / 2 };
}

describe('ping signals', () => {
  it('chirp: length, level, click-free ends and a rising sweep', () => {
    const c = makeChirp(SR, { f0: 200, f1: 10000, duration: 0.12 });
    expect(c.length).toBe(Math.round(0.12 * SR));
    let peak = 0;
    for (const v of c) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(1);
    expect(peak).toBeGreaterThan(0.99);
    expect(Math.abs(c[0])).toBeLessThan(1e-6);
    expect(Math.abs(c[c.length - 1])).toBeLessThan(1e-3);
    const zc = (a, b) => { let n = 0; for (let i = a + 1; i < b; i++) if ((c[i - 1] < 0) !== (c[i] < 0)) n++; return n; };
    const tenth = Math.floor(c.length / 10);
    // Zero crossings per second ~ 2 f: about 200-300 Hz at the start, 7-10 kHz at the end.
    const fStart = zc(0, tenth) / 2 / (tenth / SR), fEnd = zc(c.length - tenth, c.length) / 2 / (tenth / SR);
    expect(fStart).toBeGreaterThan(150); expect(fStart).toBeLessThan(400);
    expect(fEnd).toBeGreaterThan(6000); expect(fEnd).toBeLessThan(10500);
    // Never above 0.45 fs even when asked.
    const low = makeChirp(8000, { f1: 20000 });
    expect(low.every(Number.isFinite)).toBe(true);
  });

  it('MLS: maximal length, balanced, two-valued autocorrelation', () => {
    for (let o = 4; o <= 16; o++) {
      const m = makeMls(o);
      expect(m.length).toBe((1 << o) - 1);
      expect(m.reduce((a, v) => a + v, 0)).toBe(1);
    }
    const m = makeMls(9);
    for (let lag = 1; lag < m.length; lag++) {
      let ac = 0;
      for (let i = 0; i < m.length; i++) ac += m[i] * m[(i + lag) % m.length];
      expect(ac).toBe(-1);
    }
    expect(() => makeMls(3)).toThrow(/4 to 16/);
  });
});

describe('findDelay recovers a known delay within one sample', () => {
  const chirp = makeChirp(SR);
  const mls = makeMls(13);
  const rows = [];

  it.each([
    ['chirp', 1234, 40], ['chirp', 1777.37, 20], ['chirp', 2400.5, 6], ['chirp', 3000.25, 0], ['chirp', 2111.8, -6],
    ['mls', 960.6, 20], ['mls', 3333.3, 0], ['mls', 1500.5, -10],
  ])('%s, delay %f samples, SNR %i dB', { timeout: HEAVY }, (kind, d, snr) => {
    const ref = kind === 'mls' ? mls : chirp;
    const y = addNoise(delayed(ref, d, ref.length + 4200, 0.5), ref, snr, Math.round(d));
    const r = findDelay(ref, y, { sampleRate: SR });
    rows.push({ kind, d, snr, err: +(r.lag - d).toFixed(3), confidence: +r.confidence.toFixed(3) });
    // White MLS has a broader, rounder correlation peak than the chirp, so its
    // sub-sample estimate is a little looser; both stay well inside one sample.
    expect(Math.abs(r.lag - d)).toBeLessThan(snr >= 20 ? (kind === 'mls' ? 0.25 : 0.1) : 1);
    // A white MLS loses its top octave in any band-limited chain (here the
    // fractional-delay filter), so it cannot correlate to 1; the default chirp
    // stays below 10 kHz and does.
    expect(r.confidence).toBeGreaterThan(snr >= 20 ? (kind === 'mls' ? 0.7 : 0.9) : snr >= 0 ? 0.15 : 0.08);
  });

  it('through a linear-phase tone filter (known group delay) and soft clipping', () => {
    const d = 2048.4;
    const base = delayed(chirp, d, chirp.length + 4000, 0.8);
    const { y, groupDelay } = firLowpass(base, 3000);
    for (let i = 0; i < y.length; i++) y[i] = Math.tanh(2.5 * y[i]); // fuzz-ish, memoryless
    addNoise(y, chirp, 20, 4);
    const r = findDelay(chirp, y, { sampleRate: SR });
    rows.push({ kind: 'chirp lowpass+clip', d: d + groupDelay, snr: 20, err: +(r.lag - d - groupDelay).toFixed(3), confidence: +r.confidence.toFixed(3) });
    expect(Math.abs(r.lag - (d + groupDelay))).toBeLessThan(1);
    expect(r.confidence).toBeGreaterThan(0.5);
  }, HEAVY);

  it('picks the dry path, not a louder echo from a delay pedal, and keeps its confidence', () => {
    const y = new Float32Array(chirp.length + 15000);
    for (let i = 0; i < chirp.length; i++) { y[1500 + i] += 0.6 * chirp[i]; y[1500 + 9600 + i] += 0.9 * chirp[i]; }
    addNoise(y, chirp, 30, 2);
    const r = findDelay(chirp, y, { sampleRate: SR });
    expect(Math.abs(r.lag - 1500)).toBeLessThan(0.2);
    expect(r.echoes).toBe(1);
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it('reports an inverted pedal (polarity flip)', () => {
    const y = delayed(chirp, 700, chirp.length + 3000, -0.3);
    const r = findDelay(chirp, y, { sampleRate: SR });
    expect(r.inverted).toBe(true);
    expect(Math.abs(r.lag - 700)).toBeLessThan(0.1);
  });

  it('has no confidence in noise or silence', () => {
    const r = makeRandom(9);
    const noise = new Float32Array(chirp.length + 4000).map(() => r() * 2 - 1);
    expect(findDelay(chirp, noise, { sampleRate: SR }).confidence).toBeLessThan(0.15);
    const quiet = findDelay(chirp, new Float32Array(chirp.length + 4000), { sampleRate: SR });
    expect(quiet.confidence).toBe(0);
    expect(Number.isNaN(quiet.lag)).toBe(true);
    // Report for the record (vitest prints console output).
    console.log('[pedals] delay recovery (samples):\n' + rows.map(x => `  ${x.kind.padEnd(19)} true ${String(x.d).padStart(8)}  SNR ${String(x.snr).padStart(3)} dB  error ${String(x.err).padStart(7)}  confidence ${x.confidence}`).join('\n'));
  });

  it('respects minLag / maxLag', () => {
    const y = delayed(chirp, 5000, chirp.length + 6000, 1);
    expect(findDelay(chirp, y, { minLag: 4000, maxLag: 6000, sampleRate: SR }).lagInt).toBe(5000);
    expect(findDelay(chirp, y, { minLag: 0, maxLag: 3000, sampleRate: SR }).confidence).toBeLessThan(0.3);
  });
});

describe('round trip analysis from a two-channel capture', () => {
  it('measures the return relative to the recorded send, whatever the capture offset', () => {
    const ref = makeChirp(SR);
    for (const [offset, d] of [[3000, 1440.5], [123, 2400], [7000, 3360.25]]) {
      const len = offset + ref.length + 20000;
      const chRef = delayed(ref, offset, len, dbToGain(-24));
      const chRet = addNoise(delayed(ref, offset + d, len, dbToGain(-30)), chRef, 25, offset);
      const r = analyseRun(ref, chRef, chRet, SR, 400);
      expect(r.ok).toBe(true);
      expect(Math.abs(r.samples - d)).toBeLessThan(0.5);
      expect(r.ms).toBeCloseTo(d / SR * 1000, 1);
    }
  }, HEAVY);

  it('says what went wrong when nothing played or nothing came back', () => {
    const ref = makeChirp(SR);
    expect(analyseRun(ref, new Float32Array(30000), new Float32Array(30000), SR).reason).toMatch(/did not play/);
    const chRef = delayed(ref, 1000, 30000);
    const r = analyseRun(ref, chRef, new Float32Array(30000), SR);
    const all = combineRuns([r, r, r], SR);
    expect(all.ok).toBe(false);
    expect(all.reason).toMatch(/No clear ping came back/);
    expect(all.reason).not.toMatch(/\u2014/);
  });

  it('combines runs with a median and trusts agreeing runs more', () => {
    const run = (samples, confidence = 0.95) => ({ ok: true, samples, ms: samples / SR * 1000, confidence, inverted: false });
    const agree = combineRuns([run(1440), run(1440.2), run(1439.9)], SR);
    expect(agree.latencySamples).toBe(1440);
    expect(agree.latencyMs).toBeCloseTo(30, 3);
    expect(agree.confidence).toBeGreaterThan(0.9);
    const disagree = combineRuns([run(1440), run(1800), run(2400)], SR);
    expect(disagree.confidence).toBeLessThan(agree.confidence / 2);
    // Two of three agreeing is a majority: full strength. One of three is not.
    const bad = { ok: false, reason: 'Nothing came back from the pedals.' };
    const partly = combineRuns([run(1440), run(1440), bad], SR);
    expect(partly.ok).toBe(true);
    expect(partly.confidence).toBeCloseTo(0.95, 6);
    const lone = combineRuns([run(1440), bad, bad], SR);
    expect(lone.confidence).toBeCloseTo(0.475, 6);
  });
});

describe('send limiter', () => {
  it('curve: identity below the knee, monotonic, never past the ceiling', () => {
    expect(softClip(0.3)).toBe(0.3);
    expect(softClip(-0.5)).toBe(-0.5);
    expect(softClip(100)).toBeLessThanOrEqual(1);
    const c = limiterCurve(4097);
    for (let i = 1; i < c.length; i++) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]);
    expect(Math.max(...c)).toBeLessThanOrEqual(1);
  });

  it('the whole chain holds -18 dBFS and leaves quiet signals untouched', () => {
    const curve = limiterCurve(4097);
    const { pre, post } = limiterGains(-18, 4);
    // WaveShaper: linear interpolation of the curve over input -1..1, clamped at the ends.
    const shape = (x) => {
      const p = (Math.max(-1, Math.min(1, x)) + 1) / 2 * (curve.length - 1);
      const i = Math.min(curve.length - 2, Math.floor(p));
      return curve[i] + (curve[i + 1] - curve[i]) * (p - i);
    };
    const ceil = dbToGain(-18);
    let worst = 0;
    for (let x = -4; x <= 4; x += 0.001) {
      const y = post * shape(pre * x);
      worst = Math.max(worst, Math.abs(y));
      if (Math.abs(x) <= 0.5 * ceil) expect(Math.abs(y - x)).toBeLessThan(1e-6);
    }
    expect(gainToDb(worst)).toBeLessThanOrEqual(-18 + 1e-6);
    expect(gainToDb(worst)).toBeGreaterThan(-18.1);
  });

  it('builds input -> shaper (4x oversampled) -> output with the right gains', () => {
    const ctx = fakeContext();
    const lim = createSendLimiter(ctx);
    expect(lim.ceilingDb).toBe(-18);
    expect(lim.input.gain.value).toBeCloseTo(1 / (4 * dbToGain(-18)), 6);
    expect(lim.output.gain.value).toBeCloseTo(dbToGain(-18), 6);
    const shaper = ctx.out(lim.input)[0].to;
    expect(shaper.kind).toBe('shaper');
    expect(shaper.oversample).toBe('4x');
    expect(ctx.out(shaper)[0].to).toBe(lim.output);
    lim.setCeiling(-12);
    expect(lim.output.gain.value).toBeCloseTo(dbToGain(-12), 6);
    expect(lim.setCeiling(20)).toBe(0);
  });
});

describe('feedback guard', () => {
  // Poll like the analyser: the newest 2048 samples every 25 ms.
  function poll(signal, { every = 25 } = {}) {
    const det = createFeedbackDetector({ sampleRate: SR });
    const step = Math.round(every * SR / 1000);
    for (let end = 2048; end <= signal.length; end += step) {
      const st = det.observe(signal.subarray(end - 2048, end), end / SR * 1000);
      if (st.tripped) return { ...st, atMs: end / SR * 1000 };
    }
    return { ...det.state, atMs: null };
  }
  const sine = (f, sec, dbAt) => { const x = new Float32Array(Math.round(sec * SR)); for (let i = 0; i < x.length; i++) x[i] = dbToGain(dbAt(i / SR)) * Math.SQRT2 * Math.sin(2 * Math.PI * f * i / SR); return x; };

  it('trips on a runaway loop (growing tone) before it gets loud for long', () => {
    // Loop gain above one: +30 dB per second from -50 dBFS RMS.
    const r = poll(sine(740, 3, (t) => Math.min(-1, -50 + 30 * t)));
    expect(r.tripped).toBe(true);
    expect(['runaway', 'howl']).toContain(r.kind);
    expect(r.atMs).toBeLessThan(1700); // crosses -9 dBFS at ~1.37 s
    expect(r.reason).toMatch(/muted it/);
  }, HEAVY);

  it('trips on a steady howl after the hold time', () => {
    const r = poll(sine(1200, 2, (t) => (t < 0.5 ? -80 : -6)));
    expect(r.tripped).toBe(true);
    expect(r.kind).toBe('howl');
    expect(r.atMs).toBeGreaterThan(800);
    expect(r.atMs).toBeLessThan(1100);
  }, HEAVY);

  it('also catches a quieter howl held down by the send limiter, after a longer hold', () => {
    const r = poll(sine(660, 3, (t) => (t < 0.3 ? -80 : -18)));
    expect(r.tripped).toBe(true);
    expect(r.kind).toBe('howl');
    expect(r.atMs).toBeGreaterThan(1500);
    expect(r.atMs).toBeLessThan(2100);
  }, HEAVY);

  it('trips when the return is pinned at full scale', () => {
    const x = new Float32Array(SR);
    for (let i = 0; i < x.length; i++) x[i] = (Math.floor(i / 100) % 2 ? 1 : -1) * (1 - (i % 7) * 1e-4) * (0.5 + 0.5 * makeRandom(i)());
    for (let i = 0; i < x.length; i += 50) x[i] = 1;
    const r = poll(x);
    expect(r.tripped).toBe(true);
  }, HEAVY);

  it('never trips on loud guitar playing, quiet tones or loud noise', () => {
    // Loud picked notes every 400 ms for 5 s (peaks near -1 dBFS).
    const notes = [40, 47, 52, 55, 59, 64];
    const play = new Float32Array(5 * SR);
    for (let k = 0; k < 12; k++) {
      const p = pluck({ sampleRate: SR, freq: 440 * Math.pow(2, (notes[k % 6] - 69) / 12), duration: 1.2, start: 0, amp: 0.9, seed: k });
      const at = Math.round(k * 0.4 * SR);
      for (let i = 0; i < p.length && at + i < play.length; i++) play[at + i] += p[i];
    }
    let peak = 0;
    for (const v of play) peak = Math.max(peak, Math.abs(v));
    for (let i = 0; i < play.length; i++) play[i] *= dbToGain(-1) / peak;
    expect(poll(play).tripped).toBe(false);
    expect(poll(sine(440, 3, () => -30)).tripped).toBe(false);
    const r = makeRandom(4);
    const noise = new Float32Array(3 * SR).map(() => 0.7 * (r() * 2 - 1));
    expect(poll(noise).tripped).toBe(false);
  }, HEAVY);

  it('stays tripped until reset', () => {
    const det = createFeedbackDetector({ sampleRate: SR });
    const loud = sine(900, 1, () => -3);
    let t = 0;
    for (let end = 2048; end <= loud.length; end += 1200, t += 25) det.observe(loud.subarray(end - 2048, end), t);
    expect(det.tripped).toBe(true);
    det.observe(new Float32Array(2048), t + 25);
    expect(det.tripped).toBe(true);
    det.reset();
    expect(det.tripped).toBe(false);
  });
});

describe('output routing', () => {
  it('plans 4 discrete channels when the device has them, stereo with a reason when not', () => {
    expect(planRouting(32)).toEqual({ mode: 'multichannel', channelCount: 4, reason: null });
    expect(planRouting(4).mode).toBe('multichannel');
    const st = planRouting(2);
    expect(st.mode).toBe('stereo');
    expect(st.reason).toMatch(/outputs 3 and 4/);
    expect(st.reason).toMatch(/MPC XL/);
    expect(st.reason).not.toMatch(/\u2014/);
    expect(planRouting(4, { sendChannels: [4, 5] }).reason).toMatch(/6 or more outputs/);
    expect(planRouting(8, { sendChannels: [1, 2] }).reason).toMatch(/overlap/);
    expect(planRouting(4, { sendChannels: [2] })).toMatchObject({ mode: 'multichannel', channelCount: 3 });
  });

  it('multichannel: destination discrete, main to outputs 1/2 and the send to 3/4', () => {
    const ctx = fakeContext({ maxChannelCount: 24 });
    const r = buildOutputRouting(ctx);
    expect(r.mode).toBe('multichannel');
    expect(r.reason).toBeNull();
    expect(ctx.destination.channelCount).toBe(4);
    expect(ctx.destination.channelInterpretation).toBe('discrete');
    const merger = ctx.edges.find(e => e.to === ctx.destination).from;
    expect(merger.kind).toBe('merger');
    const into = ctx.edges.filter(e => e.to === merger).map(e => ({ src: e.from, out: e.out, inp: e.inp }));
    const mainSplit = ctx.out(r.mainIn)[0].to, sendSplit = ctx.out(r.sendIn)[0].to;
    expect(into).toEqual(expect.arrayContaining([
      { src: mainSplit, out: 0, inp: 0 }, { src: mainSplit, out: 1, inp: 1 },
      { src: sendSplit, out: 0, inp: 2 }, { src: sendSplit, out: 1, inp: 3 },
    ]));
    expect(r.setStereoSendMix(1)).toBe(false);
    r.dispose();
    expect(ctx.destination.channelCount).toBe(2);
  });

  it('stereo fallback: main straight out, send kept running but silent', () => {
    const ctx = fakeContext({ maxChannelCount: 2 });
    const r = buildOutputRouting(ctx);
    expect(r.mode).toBe('stereo');
    expect(r.reason).toMatch(/switched off/);
    expect(ctx.out(r.mainIn)[0].to).toBe(ctx.destination);
    const mute = ctx.out(r.sendIn)[0].to;
    expect(mute.gain.value).toBe(0);
    expect(ctx.out(mute)[0].to).toBe(ctx.destination);
    expect(r.setStereoSendMix(0.5)).toBe(true);
    expect(mute.gain.value).toBe(0.5);
  });

  it('falls back to stereo with a reason when the device refuses the channel count', () => {
    const ctx = fakeContext({ maxChannelCount: 8, refuseChannels: true });
    const r = buildOutputRouting(ctx);
    expect(r.mode).toBe('stereo');
    expect(r.reason).toMatch(/would not open 4 channels/);
    expect(ctx.out(r.mainIn)[0].to).toBe(ctx.destination);
  });

  it('applyOutputDevice explains browsers without setSinkId', async () => {
    const r = await applyOutputDevice(fakeContext(), 'mpc');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Chrome and Edge/);
    const ctx = fakeContext({ maxChannelCount: 24 });
    ctx.setSinkId = async () => {};
    expect(await applyOutputDevice(ctx, 'mpc')).toMatchObject({ ok: true, maxChannelCount: 24 });
  });
});

describe('pedal return input', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('asks for raw audio: echo cancellation, noise suppression and auto gain all off', () => {
    const c = returnConstraints('dev1', 44100);
    expect(c.audio).toMatchObject({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, deviceId: { exact: 'dev1' }, sampleRate: { ideal: 44100 } });
    expect(c.video).toBe(false);
    expect(returnConstraints().audio.deviceId).toBeUndefined();
  });

  it('opens the device, returns source + gain, and splits mono return + guitar', async () => {
    const stopped = [];
    const track = { getSettings: () => ({ echoCancellation: false, sampleRate: 48000 }), stop: () => stopped.push(1) };
    const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
    let asked = null;
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async (c) => { asked = c; return stream; } } });
    const ctx = fakeContext();
    const r = await openReturn(ctx, 'mpc-in', { layout: 'mono+guitar', gain: 0.5 });
    expect(r.ok).toBe(true);
    expect(asked.audio.autoGainControl).toBe(false);
    expect(r.source.kind).toBe('mediaSource');
    expect(r.gain.gain.value).toBe(0.5);
    expect(r.guitar).toBeTruthy();
    const split = ctx.out(r.source)[0].to;
    expect(split.kind).toBe('splitter');
    expect(ctx.out(split).map(e => [e.to, e.out])).toEqual([[r.gain, 0], [r.guitar, 1]]);
    expect(r.warnings).toEqual([]);
    r.close();
    expect(stopped).toHaveLength(1);
  });

  it('turns permission and device errors into plain reasons, never throws', async () => {
    const err = (name) => Object.assign(new Error(name), { name });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => { throw err('NotAllowedError'); } } });
    expect((await openReturn(fakeContext(), 'x')).reason).toMatch(/needs permission/);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => { throw err('NotFoundError'); } } });
    expect((await openReturn(fakeContext(), 'x')).reason).toMatch(/not connected/);
    vi.stubGlobal('navigator', {});
    expect((await openReturn(fakeContext(), 'x')).reason).toMatch(/secure page/);
  });

  it('warns when the browser keeps voice processing on', async () => {
    const track = { getSettings: () => ({ echoCancellation: true, autoGainControl: true, sampleRate: 44100 }), stop() {} };
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) } });
    const r = await openReturn(fakeContext(), null);
    expect(r.ok).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/echo cancellation on/);
    expect(r.warnings.join(' ')).toMatch(/auto gain control on/);
    expect(r.warnings.join(' ')).toMatch(/resamples/);
  });
});
