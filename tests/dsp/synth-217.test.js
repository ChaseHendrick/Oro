import { describe, it, expect } from 'vitest';
import { OroDSP } from '../../src/dsp/dsp-core.js';
import { TouchBank, TOUCH_RELEASE } from '../../src/dsp/touch-sources.js';
import { TrackEffects, FX_TYPES, defaultTrackFx } from '../../src/dsp/track-effects.js';
import { FX_TYPE_MAP, fxParamScale, formatFxParam, TRANCE_PATTERNS } from '../../src/dsp/track-fx-config.js';
import { LINK_SOURCES, LINK_CURVES, PART_PARAM_MAP, MOD_PARAM_IDS } from '../../src/core/params.js';
import { wavBlobFromPieces, encodeFloat32, decodeWav } from '../../src/audio/wav.js';
import { encodeBuffer } from '../../src/audio/bounce.js';
import { loadPatch, render, SR } from '../presets/render.js';

const TAU = Math.PI * 2;
const rms = (a, s = 0, e = a.length) => { let x = 0; for (let i = s; i < e; i++) x += a[i] * a[i]; return Math.sqrt(x / Math.max(1, e - s)); };

describe('touch sources', () => {
  it('appends four Touch Link sources after the pad stick', () => {
    expect(LINK_SOURCES.slice(35)).toEqual(['Pad Stick X', 'Pad Stick Y', 'Touch X', 'Touch Y', 'Touch Height', 'Touch Down']);
  });

  it('follows a touch quickly and lets Down glide home', () => {
    const b = new TouchBank();
    b.set([0.5, -0.4, 0.8, 1], 2, true);
    for (let i = 0; i < 100; i++) b.step(0.001);
    expect(b.out[0]).toBeCloseTo(0.5, 2);
    expect(b.out[3]).toBeCloseTo(1, 2);
    expect(b.rigAmount(2)).toBeCloseTo(1, 2);
    expect(b.rigAmount(1)).toBe(0);
    b.set([0.5, -0.4, 0.8, 0], 2, true);
    b.step(0.1);
    expect(b.out[3]).toBeGreaterThan(0.5);             // still gliding
    for (let i = 0; i < 40; i++) b.step(TOUCH_RELEASE / 5);
    expect(b.out[3]).toBeLessThan(1e-3);
  });

  it('runs the FX rig in the engine: the touched track opens its filter and sends echo', () => {
    const CUT = MOD_PARAM_IDS.indexOf('cutoff');
    const play = (touch, part = 0) => {
      const dsp = new OroDSP(SR);
      loadPatch(dsp, 0, { params: { cutoff: 600, filterType: 1, resonance: 0.1, delaySend: 0, reverbSend: 0, attack: 0.001, sustain: 1 } });
      if (touch) dsp.handleMessage({ t: 'touch', v: [1, 1, 0, 1], part, fx: true });
      dsp.handleMessage({ t: 'noteOn', part: 0, note: 48, vel: 0.9 });
      const out = render(dsp, 0.5);
      const v = dsp.parts[0].voices.find((x) => x.active);
      return { cutoff: v.modPlain[CUT], dly: rms(out.D, SR * 0.25) };
    };
    const plain = play(false), touched = play(true), other = play(true, 1);
    expect(plain.cutoff).toBeCloseTo(600, 0);
    expect(touched.cutoff).toBeGreaterThan(5000);
    expect(other.cutoff).toBeCloseTo(600, 0);          // only the touched track
    expect(plain.dly).toBeLessThan(1e-6);
    expect(touched.dly).toBeGreaterThan(1e-4);
  });

  it('touch without fx moves only the Link sources', () => {
    const dsp = new OroDSP(SR);
    dsp.handleMessage({ t: 'touch', v: [0.3, 0.2, 0.1, 1], part: 0, fx: false });
    render(dsp, 0.15);
    expect(dsp.touch.out[0]).toBeCloseTo(0.3, 2);
    expect(dsp.touch.rigAmount(0)).toBe(0);
  });
});

function highpass(x) {
  // a 2 kHz first-order high-pass, enough to tell bright from dark
  const a = Math.exp(-TAU * 2000 / SR), y = new Float32Array(x.length);
  let px = 0, py = 0;
  for (let i = 0; i < x.length; i++) { py = a * (py + x[i] - px); px = x[i]; y[i] = py; }
  return y;
}

describe('pitch envelope', () => {
  it('is appended with a neutral default', () => {
    expect(PART_PARAM_MAP.pitchEnv).toMatchObject({ min: -48, max: 48, default: 0, group: 'env2' });
  });

  it('starts the note high and falls to its pitch with Envelope 2', () => {
    const play = (pitchEnv) => {
      const dsp = new OroDSP(SR);
      loadPatch(dsp, 0, { params: { pitchEnv, env2Attack: 0.001, env2Decay: 0.25, env2Sustain: 0, env2Release: 0.1 } });
      dsp.handleMessage({ t: 'noteOn', part: 0, note: 45, vel: 0.9 });
      render(dsp, 0.02);
      const early = dsp.parts[0].voices.find((v) => v.active).hz;
      render(dsp, 1);
      return { early, late: dsp.parts[0].voices.find((v) => v.active).hz };
    };
    const flat = play(0), up = play(24), down = play(-12);
    expect(flat.early).toBeCloseTo(110, 0);
    expect(up.early).toBeGreaterThan(200);           // most of two octaves up at the start
    expect(down.early).toBeLessThan(90);
    expect(up.late).toBeCloseTo(110, 0);             // and back on the note
  });
});

describe('link curves', () => {
  it('appends remap curves after Linear, Soft and Hard', () => {
    expect(LINK_CURVES.slice(0, 3)).toEqual(['Linear', 'Soft', 'Hard']);
    expect(LINK_CURVES).toEqual(expect.arrayContaining(['S-curve', 'Steps', 'Invert', 'Rectify', 'Half']));
  });
});

describe('2.17 effects', () => {
  const NEW = ['transient', 'trancegate', 'disperser', 'tapestop', 'reverser', 'peq', 'bbd', 'grainloop', 'tapeecho'];
  const rack = (type, p = {}, mix = 1) => {
    const fx = new TrackEffects(SR);
    const cfg = defaultTrackFx();
    cfg.slots[0] = { type, mix, p1: FX_TYPE_MAP[type].defaults[0], p2: FX_TYPE_MAP[type].defaults[1], p3: FX_TYPE_MAP[type].defaults[2], p4: FX_TYPE_MAP[type].defaults[3], ...p };
    fx.configure(cfg);
    fx.setTransport(120, NaN);
    return fx;
  };
  const run = (fx, seconds, signal) => {
    const L = new Float32Array(Math.round(seconds * SR)), R = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) { const x = signal(i); const y = fx.processSample(x, x); L[i] = y.L; R[i] = y.R; }
    return { L, R };
  };
  const sine = (hz, amp = 0.5) => (i) => amp * Math.sin(TAU * hz * i / SR);

  it('appends nine effects after the vocoder, with units for the UI', () => {
    expect(FX_TYPES.slice(32).map((t) => t.id)).toEqual(NEW);
    expect(FX_TYPE_MAP.vocoder.index).toBe(31);
    expect(fxParamScale('peq', 0)).toMatchObject({ min: 20, max: 20000, unit: 'Hz' });
    expect(fxParamScale('trancegate', 0).options).toHaveLength(TRANCE_PATTERNS.length);
    expect(formatFxParam('tapestop', 0, 1)).toBe('Stop');
    expect(formatFxParam('peq', 1, 1)).toBe('+18.0 dB');
  });

  it('stays finite and bounded at every extreme', () => {
    for (const type of NEW) for (const v of [0, 1]) {
      const out = run(rack(type, { p1: v, p2: v, p3: v, p4: v }), 0.6, (i) => (i % 9000 < 40 ? 0.9 : 0) + sine(220, 0.3)(i));
      for (let i = 0; i < out.L.length; i++) expect(Number.isFinite(out.L[i])).toBe(true);
      expect(rms(out.L)).toBeLessThan(4);
    }
  });

  it('tape stop runs down to silence and spins back up', () => {
    const fx = rack('tapestop', { p1: 0, p2: 0.05, p3: 0.05 });
    const before = run(fx, 0.2, sine(330));
    const cfg = defaultTrackFx();
    cfg.slots[0] = { type: 'tapestop', mix: 1, p1: 1, p2: 0.05, p3: 0.05, p4: 0.5 };
    fx.configure(cfg);
    const stopped = run(fx, 0.5, sine(330));
    cfg.slots[0].p1 = 0; fx.configure(cfg);
    const after = run(fx, 0.6, sine(330));
    expect(rms(before.L, SR * 0.1)).toBeGreaterThan(0.2);
    expect(rms(stopped.L, SR * 0.3)).toBeLessThan(1e-3);
    expect(rms(after.L, SR * 0.4)).toBeGreaterThan(0.2);
  });

  it('the trance gate opens and closes in its pattern', () => {
    const out = run(rack('trancegate', { p1: 0, p2: 0.5, p3: 0, p4: 1 }), 1, () => 0.5);   // eighths at 120 BPM
    const step = SR * 0.125;   // a sixteenth
    expect(rms(out.L, step * 0.2, step * 0.6)).toBeGreaterThan(0.4);      // step 1 open
    expect(rms(out.L, step * 1.2, step * 1.8)).toBeLessThan(0.05);        // step 2 closed
  });

  it('the parametric band boosts at its frequency', () => {
    const at = (hz) => rms(run(rack('peq', { p1: Math.log(1000 / 20) / Math.log(1000), p2: 1, p3: 0.4, p4: 0 }), 0.3, sine(hz, 0.1)).L, SR * 0.1);
    expect(at(1000) / 0.0707).toBeGreaterThan(6);    // about +18 dB
    expect(at(100) / 0.0707).toBeLessThan(1.6);
  });

  it('the disperser moves phase, not level', () => {
    const out = run(rack('disperser', { p1: 0.5, p2: 1 }), 0.4, sine(500, 0.5));
    expect(rms(out.L, SR * 0.2) / (0.5 / Math.SQRT2)).toBeCloseTo(1, 1);
  });

  it('the bucket brigade delay repeats a click after its time', () => {
    const p1 = Math.log(0.1 / 0.005) / Math.log(120);    // 100 ms
    // the click comes once the slot has faded fully wet (12 ms), so the output is only the echo
    const at = Math.round(SR * 0.05);
    const out = run(rack('bbd', { p1, p2: 0, p3: 0, p4: 0 }), 0.3, (i) => (i >= at && i < at + 48 ? 0.8 : 0));
    let peakAt = 0;
    for (let i = at + 200; i < out.L.length; i++) if (Math.abs(out.L[i]) > Math.abs(out.L[peakAt])) peakAt = i;
    expect(Math.abs((peakAt - at) / SR - 0.1)).toBeLessThan(0.01);
  });

  it('the reverser and the grain looper make sound from what they hear', () => {
    expect(rms(run(rack('reverser'), 1, sine(440)).L, SR * 0.7)).toBeGreaterThan(0.05);
    expect(rms(run(rack('grainloop', { p1: 0.2, p2: 0.3 }), 1, sine(440)).L, SR * 0.5)).toBeGreaterThan(0.05);
    expect(rms(run(rack('tapeecho'), 1, (i) => (i < 480 ? 0.8 : 0)).L, SR * 0.3)).toBeGreaterThan(1e-3);
  });

  it('the transient shaper pushes the attack of a hit', () => {
    const hit = (i) => { const t = i / SR % 0.25; return Math.sin(TAU * 200 * t) * Math.exp(-t * 18) * 0.5; };
    const flat = run(rack('transient', { p1: 0.5, p2: 0.5 }), 1, hit);
    const punch = run(rack('transient', { p1: 1, p2: 0.5 }), 1, hit);
    const attack = (x) => rms(x.L, SR * 0.5, SR * 0.5 + SR * 0.01);
    expect(attack(punch)).toBeGreaterThan(attack(flat) * 1.2);
  });
});

describe('32-bit float WAV', () => {
  it('writes and reads back float files', async () => {
    const L = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 7) * 1.5);   // above full scale survives
    const R = Float32Array.from({ length: 1000 }, () => -0.25);
    const blob = wavBlobFromPieces({ sampleRate: 48000, channels: 2, frames: 1000, pieces: [encodeFloat32([L, R])], format: 'float32' });
    const wav = decodeWav(new Uint8Array(await blob.arrayBuffer()));
    expect(wav).toMatchObject({ sampleRate: 48000, frames: 1000 });
    expect(wav.channels[0][3]).toBeCloseTo(L[3], 6);
    expect(Math.max(...wav.channels[0])).toBeGreaterThan(1.4);
  });

  it('bounces to 32-bit float when asked', async () => {
    const L = Float32Array.from({ length: 70000 }, (_, i) => 0.5 * Math.sin(i / 10));
    const buffer = { numberOfChannels: 2, length: L.length, sampleRate: 48000, getChannelData: () => L };
    const { blob } = await encodeBuffer(buffer, { format: 'float32' });
    const wav = decodeWav(new Uint8Array(await blob.arrayBuffer()));
    expect(wav.bitsPerSample).toBe(32);
    expect(wav.channels[1][157]).toBeCloseTo(L[157], 6);
  });
});
