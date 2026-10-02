// Round D DSP features: travel (Even, Ping-pong), Key>Size, Air, Comb and
// Vowel filters, the Steps LFO, Links and their sources, timed parameter
// changes, and the quality modes.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TERRAINS, PATHS } from '../../src/dsp/catalog.js';
import { OrographDSP, QUALITY_MODES, HALFBAND_4X } from '../../src/dsp/dsp-core.js';
import { pathPoint, evenPhase, pingPong, travelPhase, travelBlock } from '../../src/dsp/paths.js';
import { MAX_PARTS, MOD_PARAM_IDS, PART_PARAM_MAP, PART_PARAM_INDEX as PIX, defaultLinks, defaultMods, toNorm } from '../../src/core/params.js';
import { terrainHeight } from '../../src/dsp/terrain-math.js';
import { SR, makeDSP, render, rms, peak, allFinite, spectrum, terrainChain } from './helpers.js';
import { REF_SCENES, REF_FRAMES, renderScene } from './fixtures/reference-scenes.js';

// These renders are heavy and the suite may share the machine: be patient.
vi.setConfig({ testTimeout: 120000 });

const T = Object.fromEntries(TERRAINS.map((t, i) => [t.id, i]));
const P = Object.fromEntries(PATHS.map((p, i) => [p.id, i]));
const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);
const db = (x) => 20 * Math.log10(x + 1e-30);
const on = (note, vel = 1, time = 0, part = 0) => ({ t: 'noteOn', part, note, vel, time });
const off = (note, time = 0, part = 0) => ({ t: 'noteOff', part, note, time });
const PLAIN = { filterType: 0, pathShape: P.ellipse, pathOrder: 1, size: 0.3, attack: 0.001, sustain: 1, velSens: 0 };
const NOISE = { size: 0, air: 1, airTone: 0, attack: 0.001, sustain: 1, velSens: 0, keyTrack: 0, filterEnv: 0 };

function maxDelta(a, from, to) {
  let m = 0;
  for (let i = Math.max(1, Math.round(from)); i < Math.round(to); i++) m = Math.max(m, Math.abs(a[i] - a[i - 1]));
  return m;
}

function tone(note, params = {}, { seconds = 0.6, terrain = T.swell, mods = null, msgs = [], quality = null } = {}) {
  const dsp = makeDSP({ terrainA: terrain, params: { ...PLAIN, ...params }, mods });
  if (quality) dsp.handleMessage({ t: 'quality', mode: quality });
  for (const m of msgs) dsp.handleMessage(m);
  dsp.handleMessage(on(note));
  return { dsp, ...render(dsp, seconds) };
}

/** Amplitude of the sinusoid at exactly f Hz (Hann-windowed single-bin DFT). */
function toneAmp(x, f, start = 8000, N = 16384) {
  let re = 0, im = 0, ws = 0;
  for (let n = 0; n < N; n++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / N);
    const a = 2 * Math.PI * f * n / SR;
    ws += w; re += x[start + n] * w * Math.cos(a); im -= x[start + n] * w * Math.sin(a);
  }
  return 2 * Math.hypot(re, im) / ws;
}

/** Power (dB) that is NOT on the harmonic grid of f0. */
function inharmonicDb(x, f0, start = 8000, N = 16384) {
  const mag = spectrum(x, start, N);
  const bin = SR / N;
  const mask = new Uint8Array(N / 2);
  for (let h = 1; h * f0 < SR / 2 + 10 * bin; h++) {
    const c = Math.round(h * f0 / bin);
    for (let k = c - 6; k <= c + 6; k++) if (k >= 0 && k < N / 2) mask[k] = 1;
  }
  let tot = 0, inh = 0;
  for (let k = 3; k < N / 2; k++) { const p = mag[k] * mag[k]; tot += p; if (!mask[k]) inh += p; }
  return 10 * Math.log10(inh / tot);
}

/** Average power spectrum (Welch, Hann, 4096) of a stretch of signal. */
function welch(x, from, to, N = 4096) {
  const acc = new Float64Array(N / 2);
  let frames = 0;
  for (let s = from; s + N <= to; s += N / 2) {
    const m = spectrum(x, s, N);
    for (let k = 0; k < N / 2; k++) acc[k] += m[k] * m[k];
    frames++;
  }
  for (let k = 0; k < N / 2; k++) acc[k] /= frames;
  return acc;
}
const bandPower = (S, f0, f1, N = 4096) => {
  let p = 0;
  for (let k = Math.ceil(f0 * N / SR); k <= Math.floor(f1 * N / SR); k++) p += S[k];
  return p;
};

describe('defaults are transparent', () => {
  it('every Round D control at its default renders bit-identically to the engine before Round D', () => {
    const file = fileURLToPath(new URL('./fixtures/reference-v1.f32', import.meta.url));
    const buf = readFileSync(file);
    const ref = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const defaults = { laps: 1, pace: 0, sub: 0, traverse: 0, direction: 0, noteSize: 0, air: 0, airTone: 0, formant: 0.5 };
    const extra = [
      { t: 'quality', mode: 'standard' },
      { t: 'links', part: 0, links: defaultLinks() },
      { t: 'global', p: { macro1: 0, macro2: 0, macro3: 0, macro4: 0 } },
      { t: 'mods', part: 0, m: defaultMods() },
    ];
    let worst = 0;
    REF_SCENES.forEach((scene, i) => {
      const r = renderScene(scene, {
        makeDSP: (o) => { const d = makeDSP(o); for (const m of extra) d.handleMessage(m); if (scene.mods) d.handleMessage({ t: 'mods', part: 0, m: scene.mods }); return d; },
        render,
      }, defaults);
      for (let k = 0; k < REF_FRAMES; k++) {
        worst = Math.max(worst, Math.abs(r.L[k] - ref[2 * i * REF_FRAMES + k]), Math.abs(r.R[k] - ref[(2 * i + 1) * REF_FRAMES + k]));
      }
    });
    console.log(`[round-d] reference scenes with every Round D default sent explicitly: max |difference| = ${worst}`);
    expect(worst).toBeLessThanOrEqual(1e-9);
  });
});

describe('travel: Even and Ping-pong', () => {
  it('evenPhase moves the dot at constant speed along the curve', () => {
    const pt = { x: 0, y: 0 };
    const arc = (s, o, p, a, b) => {
      let L = 0;
      pathPoint(s, a, o, p, pt);
      let px = pt.x, py = pt.y;
      for (let k = 1; k <= 16; k++) { pathPoint(s, a + (b - a) * k / 16, o, p, pt); L += Math.hypot(pt.x - px, pt.y - py); px = pt.x; py = pt.y; }
      return L;
    };
    for (const [s, o, p] of [[P.spiro, 3, 0.4], [P.rose, 3, 0], [P.lissa, 2, 0.5], [P.spiral, 3, 0.3]]) {
      const N = 400;
      const steps = [], nat = [];
      for (let i = 0; i < N; i++) {
        steps.push(arc(s, o, p, evenPhase(s, o, p, i / N), i + 1 < N ? evenPhase(s, o, p, (i + 1) / N) : 1 - 1e-9));
        nat.push(arc(s, o, p, i / N, (i + 1) / N));
      }
      const spread = (a) => { const m = a.reduce((x, y) => x + y) / a.length; return [Math.min(...a) / m, Math.max(...a) / m]; };
      const [lo, hi] = spread(steps), [nlo, nhi] = spread(nat);
      expect(lo).toBeGreaterThan(0.9);
      expect(hi).toBeLessThan(1.1);
      expect(nhi / nlo).toBeGreaterThan(1.3);    // Natural really is uneven on these
    }
    // endpoints fixed, monotonic
    let prev = -1;
    for (let i = 0; i <= 1000; i++) {
      const t = evenPhase(P.star, 5, 0.2, i / 1000 * 0.999999);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
    expect(evenPhase(P.cusp, 2, 0.5, 0)).toBe(0);
  });

  it('pingPong and travelPhase run each lap 0 -> 1 -> 0, symmetric in time', () => {
    for (let i = 0; i <= 200; i++) {
      const phi = i / 200;
      const a = travelPhase(phi, { direction: 1 }), b = travelPhase(1 - phi, { direction: 1 });
      expect(Math.abs(a - b)).toBeLessThan(1e-9);
    }
    expect(pingPong(0.25)).toBeCloseTo(0.5, 12);
    expect(pingPong(0.5)).toBeLessThan(1);          // the turning point stays on the end of an open path
    expect(pingPong(0.5)).toBeGreaterThan(0.999999);
    const T4 = new Float64Array([0.1, 0.4, 0.6, 0.9]);
    travelBlock(P.ellipse, 1, 4, T4, 0.5, 0, 1, 0);
    expect([...T4].map(x => +x.toFixed(9))).toEqual([0.2, 0.8, 0.8, 0.2]);
  });

  it('Even and Ping-pong keep the pitch: the tone stays periodic at the note frequency', () => {
    const f = mtof(45);
    for (const params of [{ traverse: 1, pathShape: P.spiro, pathOrder: 3 }, { direction: 1, pathShape: P.rose, pathOrder: 3 },
      { traverse: 1, direction: 1, pathShape: P.scan, size: 0.4 }, { direction: 1, laps: 1.5, pathShape: P.cusp }]) {
      const r = tone(45, params, { terrain: T.massif });
      const inh = inharmonicDb(r.L, f);
      expect(inh, JSON.stringify(params)).toBeLessThan(-45);
      expect(toneAmp(r.L, f), JSON.stringify(params)).toBeGreaterThan(1e-3);
    }
  });

  it('Ping-pong makes every cycle symmetric in time and removes the Scan jump', () => {
    // f0 = 375 Hz: one cycle is exactly 128 host samples; the half-band is
    // linear phase, so the cycle is mirrored about phase 0 (host sample 14.5).
    // Only the 8 Hz DC blocker is not linear phase (~1 degree at f0).
    const note = 69 + 12 * Math.log2(375 / 440);
    const r = tone(note, { pathShape: P.scan, pathOrder: 1, direction: 1, size: 0.3, centerY: 0.37 }, { terrain: T.massif, seconds: 0.5 });
    let err = 0, sig = 0;
    for (let n = 8000; n < 8000 + 2048; n++) {
      const m = 29 + 128 * 128 - n;      // mirror image of n (mod one cycle)
      err += (r.L[n] - r.L[m]) ** 2; sig += r.L[n] ** 2;
    }
    const symDb = 10 * Math.log10(err / sig);
    console.log(`[round-d] ping-pong cycle symmetry error ${symDb.toFixed(1)} dB`);
    expect(symDb).toBeLessThan(-30);
    // Scan forward jumps once per cycle (harmonics fall at 6 dB/octave);
    // ping-pong turns around instead (a corner: 12 dB/octave)
    const lowNote = 69 + 12 * Math.log2(93.75 / 440), f0 = 93.75;
    const opts = { terrain: T.swell, seconds: 0.6 };
    const fwd = tone(lowNote, { pathShape: P.scan, pathOrder: 1, size: 0.3, centerY: 0.37 }, opts);
    const pp = tone(lowNote, { pathShape: P.scan, pathOrder: 1, size: 0.3, centerY: 0.37, direction: 1 }, opts);
    const tilt = (x) => {
      let lo = 0, hi = 0;
      for (let h = 1; h <= 6; h++) lo += toneAmp(x, h * f0) ** 2;
      for (let h = 40; h <= 80; h++) hi += toneAmp(x, h * f0) ** 2;
      return 10 * Math.log10(hi / lo);
    };
    const tf = tilt(fwd.L), tp = tilt(pp.L);
    console.log(`[round-d] Scan, harmonics 40-80 vs 1-6: forward ${tf.toFixed(1)} dB, ping-pong ${tp.toFixed(1)} dB`);
    expect(tp).toBeLessThan(tf - 10);
  });

  it('switching Direction, Travel, Path or Order mid-note crossfades instead of clicking', () => {
    for (const change of [{ direction: 1 }, { traverse: 1 }, { pathShape: P.star }, { pathOrder: 5 }]) {
      const dsp = makeDSP({ terrainA: T.massif, params: { ...PLAIN, pathShape: P.spiro, pathOrder: 2 } });
      dsp.handleMessage(on(52));
      const a = render(dsp, 0.4);
      dsp.handleMessage({ t: 'params', part: 0, p: change });
      const b = render(dsp, 0.4);
      const steady = Math.max(maxDelta(a.L, 0.2 * SR, 0.4 * SR), maxDelta(b.L, 0.2 * SR, 0.4 * SR));
      const sw = maxDelta(b.L, 0, 0.05 * SR);
      expect(sw, JSON.stringify(change)).toBeLessThan(1.3 * steady);
      expect(allFinite(b.L)).toBe(true);
    }
  });
});

describe('Key>Size', () => {
  it('scales each voice orbit by 2^(noteSize (note - 60) / 24), clamped to 0..0.5', () => {
    const dsp = makeDSP({ terrainA: T.swell, params: { size: 0.2, noteSize: -1 } });
    dsp.handleMessage(on(84)); dsp.handleMessage(on(36));
    render(dsp, 0.1);
    const [hi, lo] = dsp.parts[0].voices;
    expect(hi.sSize).toBeCloseTo(0.2 * Math.pow(2, -1), 4);
    expect(lo.sSize).toBeCloseTo(Math.min(0.5, 0.2 * 2), 4);
    const grow = makeDSP({ terrainA: T.swell, params: { size: 0.3, noteSize: 1 } });
    grow.handleMessage(on(96));
    render(grow, 0.05);
    expect(grow.parts[0].voices[0].sSize).toBeCloseTo(0.5, 6);
    // telemetry shows the voice's real orbit size
    const tele = [];
    dsp.postMessage = (m) => tele.push(m);
    render(dsp, 0.05);
    expect(tele[tele.length - 1].n.size).toBeCloseTo(toNorm(PART_PARAM_MAP.size, lo.sSize), 3);
  });
});

describe('Air', () => {
  it('adds noise at a level that does not depend on Air Tone, after the DC blocker and following the amp envelope', () => {
    const levels = [];
    for (const airTone of [-1, 0, 1]) {
      const dsp = makeDSP({ terrainA: T.swell, params: { ...NOISE, filterType: 0, airTone, release: 0.1 } });
      dsp.handleMessage(on(60));
      const r = render(dsp, 0.5);
      dsp.handleMessage(off(60));
      const t = render(dsp, 0.4);
      levels.push(db(rms(r.L, 4800)));
      expect(rms(t.L, Math.round(0.25 * SR))).toBeLessThan(1e-3 * rms(r.L, 4800));   // released with the envelope
    }
    // 0.3 RMS at Air 1, times the part level (0.75^2) and the voice headroom (0.5)
    const expected = db(0.3 * 0.75 * 0.75 * 0.5);
    console.log(`[round-d] Air 1 level for tone -1/0/+1: ${levels.map(l => l.toFixed(1)).join(' / ')} dBFS (target ${expected.toFixed(1)})`);
    for (const l of levels) expect(Math.abs(l - expected)).toBeLessThan(1.5);
  });

  it('Air Tone tilts the noise from dark to bright', () => {
    const lowShare = (airTone) => {
      const dsp = makeDSP({ terrainA: T.swell, params: { ...NOISE, filterType: 0, airTone } });
      dsp.handleMessage(on(60));
      const r = render(dsp, 0.6);
      const S = welch(r.L, 4800, r.L.length);
      return bandPower(S, 20, 600) / bandPower(S, 20, 20000);
    };
    const dark = lowShare(-1), mid = lowShare(0), bright = lowShare(1);
    console.log(`[round-d] Air share of power below 600 Hz: dark ${(100 * dark).toFixed(1)}%, neutral ${(100 * mid).toFixed(1)}%, bright ${(100 * bright).toFixed(2)}%`);
    expect(dark).toBeGreaterThan(6 * mid);
    expect(bright).toBeLessThan(0.1 * mid);
  });

  it('is independent per voice and decorrelated in stereo', () => {
    const dsp = makeDSP({ terrainA: T.swell, params: { ...NOISE, filterType: 0, unison: 2, spread: 0 } });
    dsp.handleMessage(on(60));
    const r = render(dsp, 0.3);
    let dot = 0, nl = 0, nr = 0;
    for (let i = 4000; i < r.L.length; i++) { dot += r.L[i] * r.R[i]; nl += r.L[i] ** 2; nr += r.R[i] ** 2; }
    expect(Math.abs(dot / Math.sqrt(nl * nr))).toBeLessThan(0.2);
  });
});

describe('Comb filter', () => {
  const combSpectrum = (formant, resonance = 0.8, cutoff = 400) => {
    const dsp = makeDSP({ terrainA: T.swell, params: { ...NOISE, filterType: 5, cutoff, resonance, formant } });
    dsp.handleMessage(on(60));
    const r = render(dsp, 1.2);
    expect(allFinite(r.L)).toBe(true);
    return welch(r.L, 9600, r.L.length);
  };

  it('Vowel = 1 rings at multiples of the comb frequency, 0 at its odd half-multiples', () => {
    const fc = 400;
    const peaksAt = (S, offset) => {
      let on = 0, offp = 0;
      for (let k = 1; k <= 10; k++) {
        on += bandPower(S, (k + offset) * fc - 25, (k + offset) * fc + 25);
        offp += bandPower(S, (k + offset + 0.5) * fc - 25, (k + offset + 0.5) * fc + 25);
      }
      return 10 * Math.log10(on / offp);
    };
    const pos = combSpectrum(1), neg = combSpectrum(0);
    const posRatio = peaksAt(pos, 0), negRatio = peaksAt(neg, -0.5);
    console.log(`[round-d] comb peak-to-valley: positive ${posRatio.toFixed(1)} dB, negative ${negRatio.toFixed(1)} dB`);
    expect(posRatio).toBeGreaterThan(10);
    expect(negRatio).toBeGreaterThan(10);
    // and the other way round they are valleys
    expect(peaksAt(pos, -0.5)).toBeLessThan(-10);
    // more Reso, sharper teeth
    expect(peaksAt(combSpectrum(1, 0.2), 0)).toBeLessThan(posRatio - 4);
  });

  it('stays stable and bounded at every setting, also under fast modulation', () => {
    for (const formant of [0, 0.5, 1]) {
      for (const resonance of [0, 1]) {
        for (const cutoff of [30, 140, 2000, 18000]) {
          const dsp = makeDSP({
            terrainA: T.cells, params: { filterType: 5, cutoff, resonance, formant, lift: 4, drive: 1, air: 1, sustain: 1, size: 0.4 },
            mods: { cutoff: { lfoDepth: 0.6, lfoRate: 25 }, formant: { lfoDepth: 0.5, lfoRate: 13, lfoShape: 4 }, resonance: { envDepth: 1 } },
          });
          for (const n of [36, 55, 79]) dsp.handleMessage(on(n));
          const r = render(dsp, 1.0);
          const tag = `f${formant} r${resonance} c${cutoff}`;
          expect(allFinite(r.L) && allFinite(r.R), tag).toBe(true);
          expect(peak(r.L), tag).toBeLessThanOrEqual(4);
          // no build-up: the last 0.3 s are not much louder than 0.2 .. 0.5 s
          expect(rms(r.L, 0.7 * SR), tag).toBeLessThan(2 * rms(r.L, 0.2 * SR, 0.5 * SR) + 1e-6);
        }
      }
    }
  });
});

describe('Vowel filter', () => {
  const vowelSpectrum = (formant, cutoff = 1000, resonance = 0.5) => {
    const dsp = makeDSP({ terrainA: T.swell, params: { ...NOISE, filterType: 6, cutoff, resonance, formant } });
    dsp.handleMessage(on(60));
    const r = render(dsp, 1.2);
    expect(allFinite(r.L)).toBe(true);
    return welch(r.L, 9600, r.L.length);
  };
  const peakNear = (S, lo, hi) => {
    let best = -1, at = 0;
    for (let k = Math.ceil(lo * 4096 / SR); k <= Math.floor(hi * 4096 / SR); k++) if (S[k] > best) { best = S[k]; at = k; }
    return at * SR / 4096;
  };

  it('puts its resonances where the vowel says (A, I, U) and Cutoff shifts them', () => {
    const A = vowelSpectrum(0), I = vowelSpectrum(0.5), U = vowelSpectrum(1);
    // first formant: A ~780, I ~300, U ~340; second: A ~1240, I ~2280, U ~760
    expect(Math.abs(peakNear(A, 550, 1000) - 780)).toBeLessThan(80);
    expect(Math.abs(peakNear(I, 200, 450) - 300)).toBeLessThan(50);
    expect(Math.abs(peakNear(A, 1050, 1600) - 1240)).toBeLessThan(110);
    expect(Math.abs(peakNear(I, 1800, 2700) - 2280)).toBeLessThan(180);
    expect(Math.abs(peakNear(U, 600, 950) - 760)).toBeLessThan(80);
    // A is open (energy around 800 Hz), I closed with a high second formant
    expect(bandPower(A, 650, 900) / bandPower(I, 650, 900)).toBeGreaterThan(4);
    expect(bandPower(I, 2180, 2380) / bandPower(A, 2180, 2380)).toBeGreaterThan(3);
    // Cutoff 2 kHz moves everything up an octave
    const A2 = vowelSpectrum(0, 2000);
    expect(Math.abs(peakNear(A2, 1200, 2000) - 1560)).toBeLessThan(160);
  });

  it('Reso sharpens the formants', () => {
    const soft = vowelSpectrum(0.5, 1000, 0), sharp = vowelSpectrum(0.5, 1000, 1);
    const q = (S) => bandPower(S, 270, 330) / bandPower(S, 380, 500);
    expect(q(sharp)).toBeGreaterThan(2 * q(soft));
  });

  it('stays stable under extreme settings and fast vowel sweeps', () => {
    for (const resonance of [0, 1]) {
      for (const cutoff of [30, 1000, 18000]) {
        const dsp = makeDSP({
          terrainA: T.fm, params: { filterType: 6, cutoff, resonance, lift: 4, fold: 1, drive: 1, sustain: 1, unison: 3 },
          mods: { formant: { lfoDepth: 1, lfoRate: 30, lfoShape: 3 }, cutoff: { lfoDepth: 1, lfoRate: 17 } },
        });
        for (const n of [24, 60, 108]) dsp.handleMessage(on(n));
        const r = render(dsp, 0.8);
        expect(allFinite(r.L) && allFinite(r.R)).toBe(true);
        expect(peak(r.L)).toBeLessThanOrEqual(4);
      }
    }
  });

  it('changing the filter type mid-note crossfades (Low -> Comb -> Vowel -> High -> Off)', () => {
    const dsp = makeDSP({ terrainA: T.massif, params: { ...PLAIN, filterType: 1, cutoff: 3000, resonance: 0.3 } });
    dsp.handleMessage(on(50));
    const first = render(dsp, 0.3);
    let steady = maxDelta(first.L, 0.1 * SR, 0.3 * SR);
    for (const ft of [5, 6, 3, 0, 2, 1]) {
      dsp.handleMessage({ t: 'params', part: 0, p: { filterType: ft } });
      const r = render(dsp, 0.3);
      const after = maxDelta(r.L, 0.1 * SR, 0.3 * SR);
      const sw = maxDelta(r.L, 0, 0.03 * SR);
      expect(sw, `to type ${ft}`).toBeLessThan(1.3 * Math.max(steady, after));
      steady = after;
    }
  });
});

describe('Steps LFO', () => {
  it('holds each of the 16 values for 1/16 of the period with a short glide between them', () => {
    const steps = Array.from({ length: 16 }, (_, i) => ((i * 7) % 16) / 7.5 - 1);
    const dsp = makeDSP({ terrainA: T.swell, params: { pan: 0 }, mods: { pan: { lfoShape: 6, lfoRate: 1, lfoDepth: 0.5, steps } } });
    const slot = MOD_PARAM_IDS.indexOf('pan');
    const P0 = dsp.parts[0];
    // per control block: phase and value
    const vals = [];
    for (let b = 0; b < Math.round(SR / 32); b++) {
      render(dsp, 32 / SR, null, 32);
      vals.push([P0.lfoPhase[slot], P0.lfoVal[slot]]);
    }
    let held = 0, gliding = 0;
    for (const [ph, val] of vals) {
      const i = Math.min(15, Math.floor(ph * 16));
      const tIn = (ph * 16 - i) / 16;     // seconds into the step at 1 Hz
      if (tIn >= 0.002) { expect(val).toBeCloseTo(steps[i], 9); held++; }
      else {
        const prev = steps[(i + 15) % 16];
        expect(val).toBeCloseTo(prev + (steps[i] - prev) * tIn / 0.002, 9);
        gliding++;
      }
    }
    expect(held).toBeGreaterThan(1300);
    expect(gliding).toBeGreaterThan(10);
    // and it reaches the voices: telemetry pan follows base + depth * step
    const tele = [];
    dsp.postMessage = (m) => tele.push(m);
    render(dsp, 1);
    const seen = new Set(tele.map(m => Math.round((m.n.pan - 0.5) / 0.5 * 1000)));
    let hits = 0;
    for (const s of steps) if (seen.has(Math.round(s * 1000))) hits++;
    expect(hits).toBeGreaterThanOrEqual(14);
  });

  it('accepts lfoShape 6 and keeps the default steps until told otherwise', () => {
    const dsp = makeDSP({ terrainA: T.swell, mods: { morph: { lfoShape: 6, lfoDepth: 0.3, lfoRate: 4 } } });
    const slot = MOD_PARAM_IDS.indexOf('morph');
    expect(dsp.parts[0].lfoShape[slot]).toBe(6);
    expect(dsp.parts[0].lfoSteps[slot * 16 + 3]).toBeCloseTo(-0.9, 12);
    const r = render(dsp, 0.2);
    expect(allFinite(r.L)).toBe(true);
  });
});

describe('Links', () => {
  function collect(dsp, seconds) {
    const tele = [];
    dsp.postMessage = (m) => tele.push(m);
    render(dsp, seconds);
    return tele;
  }

  it('the default Link reproduces the old Mod Wheel -> Morph; an empty set removes it', () => {
    const dsp = makeDSP({ terrainA: T.swell });
    dsp.handleMessage({ t: 'wheel', part: 0, v: 0.6 });
    expect(collect(dsp, 0.1).pop().n.morph).toBeCloseTo(0.6, 9);
    dsp.handleMessage({ t: 'links', part: 0, links: [] });
    expect(collect(dsp, 0.1).pop().n.morph).toBe(0);
    dsp.handleMessage({ t: 'links', part: 0, links: [{ src: 1, dst: 'cutoff', amt: -0.5, curve: 0 }] });
    const base = toNorm(PART_PARAM_MAP.cutoff, PART_PARAM_MAP.cutoff.default);
    expect(collect(dsp, 0.1).pop().n.cutoff).toBeCloseTo(base - 0.3, 9);
    // per voice too: a held note follows the wheel
    dsp.handleMessage({ t: 'links', part: 0, links: defaultLinks() });
    dsp.handleMessage(on(60));
    render(dsp, 0.05);
    expect(dsp.parts[0].voices[0].modNorm[MOD_PARAM_IDS.indexOf('morph')]).toBeCloseTo(0.6, 9);
  });

  it('applies curves to macros (part-wide, also while idle) and ignores invalid routes', () => {
    const dsp = makeDSP({ terrainA: T.swell, params: { warp: 0, fold: 0, drive: 0 } });
    dsp.handleMessage({ t: 'links', part: 0, links: [
      { src: 5, dst: 'warp', amt: 1, curve: 0 }, { src: 6, dst: 'fold', amt: 1, curve: 1 }, { src: 7, dst: 'drive', amt: 0.5, curve: 2 },
      { src: 99, dst: 'warp', amt: 1 }, { src: 0, dst: 'level', amt: 1 }, null, { src: 1, dst: 'nope', amt: 1 },
    ] });
    expect(dsp.parts[0].nLinks).toBe(3);
    dsp.handleMessage({ t: 'global', p: { macro1: 0.4, macro2: 0.5, macro3: 0.64 } });
    const n = collect(dsp, 0.1).pop().n;
    expect(n.warp).toBeCloseTo(0.4, 9);
    expect(n.fold).toBeCloseTo(0.25, 9);
    expect(n.drive).toBeCloseTo(0.4, 9);
  });

  it('routes the per-voice sources: velocity, key, random, Env 1, Env 2', () => {
    const dsp = makeDSP({ terrainA: T.swell, params: { pan: 0, env2Attack: 0.001, env2Decay: 0.05, env2Sustain: 0 } });
    dsp.handleMessage({ t: 'links', part: 0, links: [
      { src: 0, dst: 'cutoff', amt: -0.5, curve: 0 }, { src: 3, dst: 'pan', amt: 0.5, curve: 0 }, { src: 13, dst: 'stretch', amt: 0.5, curve: 0 },
      { src: 11, dst: 'fold', amt: 1, curve: 0 }, { src: 12, dst: 'warp', amt: 1, curve: 0 },
    ] });
    dsp.handleMessage(on(36, 0.2)); dsp.handleMessage(on(84, 1));
    render(dsp, 0.3);
    const [a, b] = dsp.parts[0].voices;
    const S = (id) => MOD_PARAM_IDS.indexOf(id);
    const baseCut = toNorm(PART_PARAM_MAP.cutoff, PART_PARAM_MAP.cutoff.default);
    expect(a.modNorm[S('cutoff')]).toBeCloseTo(baseCut - 0.1, 9);
    expect(b.modNorm[S('cutoff')]).toBeCloseTo(baseCut - 0.5, 9);
    // Key = (note - 60) / 48: -0.5 and +0.5
    expect(a.modNorm[S('pan')]).toBeCloseTo(0.5 - 0.5 * 0.5, 9);
    expect(b.modNorm[S('pan')]).toBeCloseTo(0.5 + 0.5 * 0.5, 9);
    expect(a.modNorm[S('stretch')]).not.toBeCloseTo(b.modNorm[S('stretch')], 3);
    expect(Math.abs(a.modNorm[S('stretch')] - 0.5)).toBeLessThanOrEqual(0.5);
    // Env 1 sits on the sustain (0.75), Env 2 has decayed to 0
    expect(a.modNorm[S('fold')]).toBeCloseTo(0.75, 2);
    expect(a.modNorm[S('warp')]).toBeLessThan(0.01);
  });

  it('routes pressure and slide, channel-wide or per note, with smoothing', () => {
    const dsp = makeDSP({ terrainA: T.swell });
    dsp.handleMessage({ t: 'links', part: 0, links: [{ src: 2, dst: 'morph', amt: 1, curve: 0 }, { src: 4, dst: 'fold', amt: 1, curve: 0 }] });
    dsp.handleMessage(on(60)); dsp.handleMessage(on(67));
    render(dsp, 0.05);
    dsp.handleMessage({ t: 'pressure', part: 0, v: 0.3 });
    dsp.handleMessage({ t: 'pressure', part: 0, v: 0.9, note: 67 });
    dsp.handleMessage({ t: 'slide', part: 0, v: 0.6, note: 60 });
    const v0 = dsp.parts[0].voices[0], v1 = dsp.parts[0].voices[1];
    const S = (id) => MOD_PARAM_IDS.indexOf(id);
    render(dsp, 0.002);
    expect(v1.modNorm[S('morph')]).toBeLessThan(0.9);       // smoothed, not a jump
    render(dsp, 0.2);
    expect(v0.modNorm[S('morph')]).toBeCloseTo(0.3, 6);
    expect(v1.modNorm[S('morph')]).toBeCloseTo(0.9, 6);
    expect(v0.modNorm[S('fold')]).toBeCloseTo(0.6, 6);
    expect(v1.modNorm[S('fold')]).toBeCloseTo(0, 6);
  });

  it('routes the marble (smoothed ~30 Hz physics) and the terrain height under the dot', () => {
    const dsp = makeDSP({ terrainA: T.massif, params: { centerX: 0.31, centerY: 0.62 } });
    dsp.handleMessage({ t: 'links', part: 0, links: [
      { src: 9, dst: 'warp', amt: 1, curve: 0 }, { src: 10, dst: 'pan', amt: 0.5, curve: 0 }, { src: 14, dst: 'fold', amt: 1, curve: 0 },
    ] });
    dsp.handleMessage({ t: 'marble', part: 0, speed: 0.8, height: -0.4 });
    let tele = collect(dsp, 0.01);
    expect(tele.length === 0 || tele.pop().n.warp < 0.79).toBe(true);
    tele = collect(dsp, 0.4);
    const n = tele.pop().n;
    expect(n.warp).toBeCloseTo(0.8, 4);
    expect(n.pan).toBeCloseTo(0.5 - 0.2, 4);
    dsp.handleMessage(on(60));
    render(dsp, 0.1);
    const v = dsp.parts[0].voices[0];
    const chain = terrainChain(T.massif);
    const h = terrainHeight(chain[0].data, chain[0].size, null, 0, 0, v.sWarp, v.sCx, v.sCy);
    expect(v.terrH).toBeCloseTo(h, 6);
    expect(v.modNorm[MOD_PARAM_IDS.indexOf('fold')]).toBeCloseTo(Math.max(0, h), 2);
  });

  it('telemetry includes link contributions and the terrain height under the modulated dot', () => {
    const dsp = makeDSP({ terrainA: T.ridge, params: { centerX: 0.2, centerY: 0.7 } });
    dsp.handleMessage({ t: 'links', part: 0, links: [{ src: 0, dst: 'size', amt: -0.5, curve: 0 }] });
    let tele = collect(dsp, 0.1);
    const chain = terrainChain(T.ridge);
    const idle = tele.pop();
    expect(idle.terrainHeight).toBeCloseTo(terrainHeight(chain[0].data, chain[0].size, null, 0, 0, 0, 0.2, 0.7), 6);
    dsp.handleMessage(on(60, 1));
    tele = collect(dsp, 0.1);
    const m = tele.pop();
    const baseSize = toNorm(PART_PARAM_MAP.size, PART_PARAM_MAP.size.default);
    expect(m.n.size).toBeCloseTo(baseSize - 0.5, 6);
    expect(Number.isFinite(m.terrainHeight)).toBe(true);
    expect(m.quality).toBe('standard');
  });
});

describe('timed parameter changes', () => {
  const firstDiff = (a, b, thr = 0) => { for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > thr) return i; return -1; };

  it('land on the exact sample, for voice parameters and for the mixer', () => {
    // Mixer changes act after the decimator: exactly at the sample. Voice
    // changes reach the output through the half-band, whose newest taps are
    // tiny, so the first float32-visible difference may come a sample or two
    // later; never earlier.
    for (const [p, slack] of [[{ level: 0.2 }, 0], [{ cutoff: 300 }, 3], [{ pan: -1 }, 3]]) {
      const firsts = [];
      for (const at of [3000, 3037, 4500.4]) {
        const mk = () => { const d = makeDSP({ terrainA: T.massif }); d.handleMessage(on(57, 0.9)); return d; };
        const ref = render(mk(), 0.15);
        const dsp = mk();
        dsp.handleMessage({ t: 'params', part: 0, p, time: at / SR });
        const r = render(dsp, 0.15);
        firsts.push(firstDiff(r.L, ref.L));
        // and the bulk of it is there within the decimator's latency plus one control block
        const big = firstDiff(r.L, ref.L, 1e-3);
        expect(big - Math.round(at), JSON.stringify(p)).toBeLessThan(15 + 32 + 16);
      }
      [3000, 3037, 4500].forEach((at, i) => {
        expect(firsts[i], JSON.stringify(p)).toBeGreaterThanOrEqual(at);
        expect(firsts[i] - at, JSON.stringify(p)).toBeLessThanOrEqual(slack);
      });
    }
  });

  it('ramps linearly over `ramp` seconds and takes the short way round for the dot and rotate', () => {
    const dsp = makeDSP({ terrainA: T.swell, params: { centerX: 0.9, rotate: 350, size: 0.1 } });
    dsp.handleMessage(on(60));
    render(dsp, 0.05);
    const t0 = dsp.lastTime + 0.02;
    dsp.handleMessage({ t: 'params', part: 0, p: { centerX: 0.1, rotate: 10, size: 0.3, filterType: 3 }, time: t0, ramp: 0.2 });
    const P0 = dsp.parts[0];
    const seen = [];
    render(dsp, 0.4, (d, time) => seen.push([time, P0.params[PIX.centerX], P0.params[PIX.rotate], P0.params[PIX.size], P0.params[PIX.filterType]]));
    for (const [time, cx, rot, size, ft] of seen) {
      if (time < t0) { expect(cx).toBeCloseTo(0.9, 9); expect(ft).toBe(1); continue; }
      expect(ft).toBe(3);                                   // switches jump at the time
      expect(cx > 0.85 || cx < 0.15).toBe(true);           // never through the middle
      expect(rot > 345 || rot < 15).toBe(true);
      const x = Math.min(1, (time - t0) / 0.2);
      expect(size).toBeCloseTo(0.1 + 0.2 * x, 1);
    }
    expect(P0.params[PIX.centerX]).toBeCloseTo(0.1, 9);
    expect(P0.params[PIX.rotate]).toBeCloseTo(10, 9);
    expect(P0.params[PIX.size]).toBeCloseTo(0.3, 9);
  });

  it('a ramp without a time starts now; a later plain change cancels it', () => {
    const dsp = makeDSP({ terrainA: T.swell, params: { warp: 0 } });
    dsp.handleMessage({ t: 'params', part: 0, p: { warp: 1 }, ramp: 0.1 });
    render(dsp, 0.05);
    const mid = dsp.parts[0].params[PIX.warp];
    expect(mid).toBeGreaterThan(0.35); expect(mid).toBeLessThan(0.65);
    dsp.handleMessage({ t: 'params', part: 0, p: { warp: 0.2 } });
    render(dsp, 0.1);
    expect(dsp.parts[0].params[PIX.warp]).toBe(0.2);
  });

  it('notes scheduled with their step see the step parameters (params first at equal times)', () => {
    const dsp = makeDSP({ terrainA: T.swell, params: { centerX: 0.5 } });
    const t = 0.05;
    dsp.handleMessage(on(60, 1, t));
    dsp.handleMessage({ t: 'params', part: 0, p: { centerX: 0.8 }, time: t });
    render(dsp, 0.1);
    expect(dsp.parts[0].voices[0].sCx).toBeCloseTo(0.8, 6);
  });
});

describe('quality modes', () => {
  it('exposes the five modes and a 4x half-band with -80 dB where it matters', () => {
    expect(QUALITY_MODES).toEqual(['eco', 'standard', 'high', 'pristine', 'raw']);
    let worst = -Infinity;
    for (let i = 0; i <= 1000; i++) {
      const f = i / 1000 * 0.5;
      let re = 0, im = 0;
      for (let n = 0; n < HALFBAND_4X.length; n++) { re += HALFBAND_4X[n] * Math.cos(2 * Math.PI * f * n); im -= HALFBAND_4X[n] * Math.sin(2 * Math.PI * f * n); }
      if (f >= 0.355) worst = Math.max(worst, 20 * Math.log10(Math.hypot(re, im) + 1e-300));
    }
    expect(worst).toBeLessThan(-79);
  });

  it('every mode plays the same note at the same level, finite, with the same timing (within 4 samples)', () => {
    const onset = {}, level = {};
    for (const mode of QUALITY_MODES) {
      const r = tone(52, { unison: 2 }, { terrain: T.massif, quality: mode, seconds: 0.5 });
      expect(allFinite(r.L) && allFinite(r.R), mode).toBe(true);
      level[mode] = db(rms(r.L, 4800));
      onset[mode] = r.L.findIndex(x => Math.abs(x) > 1e-4);
    }
    console.log(`[round-d] level per mode (dBFS): ${QUALITY_MODES.map(m => `${m} ${level[m].toFixed(2)}`).join(', ')}; onsets ${JSON.stringify(onset)}`);
    for (const mode of QUALITY_MODES) {
      expect(Math.abs(level[mode] - level.standard), mode).toBeLessThan(1);
      expect(Math.abs(onset[mode] - onset.standard), mode).toBeLessThanOrEqual(4);
    }
  });

  it('switching modes mid-note is click-free', () => {
    const order = ['standard', 'eco', 'high', 'pristine', 'raw', 'standard', 'high', 'eco', 'pristine', 'standard'];
    const dsp = makeDSP({ terrainA: T.massif, params: { ...PLAIN, unison: 2, filterType: 1, cutoff: 6000, size: 0.3 } });
    dsp.handleMessage(on(57));
    let prev = render(dsp, 0.3);
    for (let i = 1; i < order.length; i++) {
      dsp.handleMessage({ t: 'quality', mode: order[i] });
      const r = render(dsp, 0.3);
      const steady = Math.max(maxDelta(prev.L, 0.1 * SR, 0.3 * SR), maxDelta(r.L, 0.1 * SR, 0.3 * SR));
      const sw = maxDelta(r.L, 0, 0.04 * SR);
      const before = rms(prev.L, 0.15 * SR), after = rms(r.L, 0.15 * SR);
      expect(sw, `${order[i - 1]} -> ${order[i]}`).toBeLessThan(1.2 * steady);
      expect(Math.abs(db(after / before)), `${order[i - 1]} -> ${order[i]}`).toBeLessThan(1);
      expect(dsp.quality).toBe(order[i]);
      prev = r;
    }
  });

  it('a mode change during a crossfade waits for it, and a chord stays continuous through the switch', () => {
    const dsp = makeDSP({ terrainA: T.ridge, params: { ...PLAIN, release: 0.3 } });
    for (const n of [48, 55, 60, 64]) dsp.handleMessage(on(n, 0.7));
    render(dsp, 0.2);
    dsp.handleMessage({ t: 'quality', mode: 'high' });
    dsp.handleMessage({ t: 'quality', mode: 'eco' });
    expect(dsp.quality).toBe('high');
    const r = render(dsp, 0.1);
    expect(dsp.quality).toBe('eco');
    expect(allFinite(r.L)).toBe(true);
    expect(dsp.parts[0].activeCount()).toBe(4);
  });

  it('Pristine removes the aliasing Standard leaves (folded high notes, hard sync, Scan)', () => {
    for (const [params, note] of [[{ fold: 0.7, lift: 2, size: 0.4 }, 84], [{ laps: 1.5, pace: 0.4, size: 0.4 }, 72], [{ pathShape: P.scan, size: 0.5 }, 100]]) {
      const f0 = mtof(note);
      const std = inharmonicDb(tone(note, params, { terrain: T.massif, seconds: 0.8 }).L, f0);
      const pr = inharmonicDb(tone(note, params, { terrain: T.massif, seconds: 0.8, quality: 'pristine' }).L, f0);
      console.log(`[round-d] inharmonic energy ${JSON.stringify(params)} @${note}: standard ${std.toFixed(1)} dB, pristine ${pr.toFixed(1)} dB`);
      expect(pr).toBeLessThan(std - 10);
      expect(pr).toBeLessThan(-44);
    }
  });

  it('High (4x) aliases less than Standard; Raw (mips off) more', () => {
    const f0 = mtof(96);
    const p = { size: 0.4 };
    const std = inharmonicDb(tone(96, p, { terrain: T.massif, seconds: 0.8 }).L, f0);
    const high = inharmonicDb(tone(96, p, { terrain: T.massif, seconds: 0.8, quality: 'high' }).L, f0);
    const raw = inharmonicDb(tone(96, p, { terrain: T.massif, seconds: 0.8, quality: 'raw' }).L, f0);
    console.log(`[round-d] MIDI 96 inharmonic: standard ${std.toFixed(1)}, high ${high.toFixed(1)}, raw ${raw.toFixed(1)} dB`);
    expect(high).toBeLessThan(std - 3);
    expect(raw).toBeGreaterThan(std + 6);
  });

  it('Pristine spreads the table builds of a low chord over a few control blocks (no CPU spike)', () => {
    const dsp = makeDSP({ terrainA: T.massif, params: { ...PLAIN, unison: 2 } });
    dsp.handleMessage({ t: 'quality', mode: 'pristine' });
    const perBlock = [];
    let pts = 0;
    const build = dsp.buildTable.bind(dsp);
    dsp.buildTable = (...a) => { build(...a); pts += dsp.tabLen; };
    for (let i = 0; i < 8; i++) dsp.handleMessage(on(28 + 2 * i));
    for (let b = 0; b < 40; b++) { pts = 0; render(dsp, 32 / SR, null, 32); perBlock.push(pts); }
    expect(Math.max(...perBlock)).toBeLessThanOrEqual(4096 + 2048);
    render(dsp, 0.03);
    expect(dsp.parts[0].voices.every(v => v.tw === 1)).toBe(true);
  });

  it('Pristine falls back to direct rendering while the orbit is modulated fast, and returns when it settles', () => {
    const dsp = makeDSP({ terrainA: T.massif, params: { ...PLAIN }, mods: { size: { lfoDepth: 0.3, lfoRate: 20 } } });
    dsp.handleMessage({ t: 'quality', mode: 'pristine' });
    dsp.handleMessage(on(60));
    render(dsp, 0.3);
    const v = dsp.parts[0].voices[0];
    expect(v.tw).toBe(0);
    dsp.handleMessage({ t: 'mods', part: 0, m: { size: { lfoDepth: 0 } } });
    const r = render(dsp, 0.4);
    expect(v.tw).toBe(1);
    expect(maxDelta(r.L, 0, r.L.length)).toBeLessThan(0.2);
  });
});

describe('robustness of the new messages', () => {
  it('ignores malformed Round D messages', () => {
    const dsp = new OrographDSP(SR);
    for (const m of [{ t: 'links', part: 0, links: 'x' }, { t: 'links', part: 9, links: [] }, { t: 'pressure', part: 0, v: NaN },
      { t: 'slide', part: 0, v: 3, note: 'x' }, { t: 'marble', part: 0, speed: Infinity, height: -9 }, { t: 'quality', mode: 'ultra' },
      { t: 'params', part: 0, p: { cutoff: NaN }, time: 0.1 }, { t: 'params', part: 0, p: { nope: 1 }, time: 1, ramp: 2 },
      { t: 'params', part: 0, p: { size: 0.3 }, time: 'soon', ramp: -1 }, { t: 'mods', part: 0, m: { size: { lfoShape: 99, steps: [NaN, 'a'] } } }]) {
      expect(() => dsp.handleMessage(m)).not.toThrow();
    }
    expect(dsp.quality).toBe('standard');
    dsp.handleMessage(on(60));
    const r = render(dsp, 0.2);
    expect(allFinite(r.L)).toBe(true);
  });

  it('runs every mode at 44.1 and 96 kHz with odd block sizes', () => {
    for (const sr of [44100, 96000]) {
      for (const mode of QUALITY_MODES) {
        const dsp = new OrographDSP(sr);
        dsp.handleMessage({ t: 'terrain', part: 0, slot: 0, levels: terrainChain(T.ripple) });
        dsp.handleMessage({ t: 'params', part: 0, p: { filterType: 5, air: 0.4, traverse: 1, cutoff: 200 } });
        dsp.handleMessage({ t: 'quality', mode });
        dsp.handleMessage(on(69));
        const r = render(dsp, 0.2, null, 333);
        expect(allFinite(r.L), `${sr} ${mode}`).toBe(true);
        expect(rms(r.L, 2000), `${sr} ${mode}`).toBeGreaterThan(0.002);
      }
    }
  });
});

describe('sound fixes from the factory bug hunt', () => {
  const lfShareDb = (x, from = 0) => {
    // two one-poles at 20 Hz: what is left is below hearing and only costs headroom
    const a = 1 - Math.exp(-2 * Math.PI * 20 / SR);
    let y1 = 0, y2 = 0, lf = 0, tot = 0;
    for (let i = 0; i < x.length; i++) { y1 += a * (x[i] - y1); y2 += a * (y1 - y2); if (i >= from) { lf += y2 * y2; tot += x[i] * x[i]; } }
    return 10 * Math.log10(lf / tot);
  };

  it('changing Unison or Width mid-note glides instead of clicking (1 -> 2 -> 4 -> 1, Width sweep)', () => {
    const dsp = makeDSP({ terrainA: T.massif, params: { ...PLAIN, unison: 1, detune: 12, spread: 0.6 } });
    dsp.handleMessage(on(52));
    let prev = render(dsp, 0.3);
    for (const change of [{ unison: 2 }, { unison: 4 }, { spread: 0 }, { spread: 1 }, { unison: 1 }, { unison: 3, spread: 0.3 }]) {
      dsp.handleMessage({ t: 'params', part: 0, p: change });
      const r = render(dsp, 0.3);
      for (const ch of ['L', 'R']) {
        const steady = Math.max(maxDelta(prev[ch], 0.15 * SR, 0.3 * SR), maxDelta(r[ch], 0.15 * SR, 0.3 * SR));
        expect(maxDelta(r[ch], 0, 0.03 * SR), `${JSON.stringify(change)} ${ch}`).toBeLessThan(1.25 * steady);
      }
      prev = r;
    }
    expect(dsp.parts[0].voices[0].uRun).toBe(3);
    expect(dsp.parts[0].voices[0].stereo).toBe(true);
  });

  it('an orbit envelope (pluck) no longer thumps below 20 Hz', () => {
    const dsp = makeDSP({
      terrainA: T.ripple, terrainB: T.swell,
      params: { size: 0.03, morph: 0.2, attack: 0.001, decay: 0.55, sustain: 0, release: 0.35, env2Attack: 0.001, env2Decay: 0.16, env2Sustain: 0, filterType: 1, cutoff: 5000 },
      mods: { size: { envDepth: 0.38 }, morph: { envDepth: 0.25 } },
    });
    for (let i = 0; i < 6; i++) { dsp.handleMessage(on(60 + 2 * i, 0.8, 0.01 + 0.25 * i)); dsp.handleMessage(off(60 + 2 * i, 0.2 + 0.25 * i)); }
    const r = render(dsp, 1.8);
    const lf = lfShareDb(r.L);
    console.log(`[round-d] size-envelope pluck: energy below 20 Hz ${lf.toFixed(1)} dB of the total`);
    expect(lf).toBeLessThan(-25);
  });

  it('Drive on an asymmetric wave leaves no DC behind a low-pass', () => {
    const dsp = makeDSP({ terrainA: T.ridge, terrainB: T.terrace, params: { ...PLAIN, morph: 0.3, lift: 1.8, fold: 0.2, drive: 0.6, filterType: 1, cutoff: 1800, size: 0.21, pathShape: P.cusp, pathOrder: 3 } });
    dsp.handleMessage(on(41));
    const r = render(dsp, 1.5);
    let s = 0, s2 = 0;
    for (let i = Math.round(0.5 * SR); i < r.L.length; i++) { s += r.L[i]; s2 += r.L[i] ** 2; }
    const n = r.L.length - Math.round(0.5 * SR);
    const dcRatio = Math.abs(s / n) / Math.sqrt(s2 / n);
    console.log(`[round-d] driven low-pass: DC ${(100 * dcRatio).toFixed(2)}% of RMS`);
    expect(dcRatio).toBeLessThan(0.01);
  });
});

describe('denormals', () => {
  it('a held note on a collapsed orbit (Size 0) never leaves subnormal numbers in the voice state', () => {
    const dsp = makeDSP({ terrainA: T.massif, params: { size: 0.2, sustain: 1, filterType: 0, drive: 0.3 } });
    dsp.handleMessage(on(48));
    render(dsp, 0.2);
    dsp.handleMessage({ t: 'params', part: 0, p: { size: 0 } });
    render(dsp, 20, null, 512);
    const v = dsp.parts[0].voices[0];
    const sub = (x) => x !== 0 && Math.abs(x) < 2.2250738585072014e-308;
    for (const k of ['dcyL', 'dcyR', 'dcxL', 'pdyL', 'pdyR', 'ic1L', 'ic2L', 'tlL']) expect(sub(v[k]), k).toBe(false);
    expect(v.active).toBe(true);
  });
});

describe('telemetry watch', () => {
  it('watch part -1 turns telemetry off and a part number turns it back on', () => {
    const dsp = makeDSP({ terrainA: T.swell });
    const tele = [];
    dsp.postMessage = (m) => tele.push(m);
    render(dsp, 0.1);
    expect(tele.length).toBeGreaterThan(0);
    expect(tele.every(m => m.part === 0)).toBe(true);
    dsp.handleMessage({ t: 'watch', part: -1 });
    tele.length = 0;
    dsp.handleMessage(on(60));
    render(dsp, 0.2);
    expect(tele).toEqual([]);
    expect(allFinite(render(dsp, 0.05).L)).toBe(true);
    dsp.handleMessage({ t: 'watch', part: 2 });
    render(dsp, 0.1);
    expect(tele.length).toBeGreaterThan(0);
    expect(tele.every(m => m.part === 2)).toBe(true);
    // out-of-range parts (past the MAX_PARTS slots) are ignored
    dsp.handleMessage({ t: 'watch', part: MAX_PARTS });
    tele.length = 0;
    render(dsp, 0.05);
    expect(tele.every(m => m.part === 2)).toBe(true);
  });
});

describe('cancelNotes', () => {
  it('drops tagged note-ons after the given time with their own note-offs, keeps the rest', () => {
    const dsp = makeDSP({ terrainA: T.swell });
    const seq = (m) => ({ ...m, tag: 'seq' });
    dsp.handleMessage(seq(on(60, 1, 0.10))); dsp.handleMessage(seq(off(60, 0.30)));   // starts before: kept
    dsp.handleMessage(seq(on(62, 1, 0.40))); dsp.handleMessage(seq(off(62, 0.45)));   // after: dropped
    dsp.handleMessage(seq(on(64, 1, 0.50))); dsp.handleMessage(seq(off(64, 0.55)));   // after: dropped
    dsp.handleMessage(on(67, 1, 0.50)); dsp.handleMessage(off(67, 0.60));             // untagged (arp, preview): kept
    dsp.handleMessage({ t: 'cancelNotes', after: 0.2, tag: 'seq' });
    const left = dsp.events.filter(e => e.type !== 2).map(e => [e.type, e.note, e.time]);
    expect(left).toEqual([[1, 60, 0.10], [0, 60, 0.30], [1, 67, 0.50], [0, 67, 0.60]]);
  });
});
