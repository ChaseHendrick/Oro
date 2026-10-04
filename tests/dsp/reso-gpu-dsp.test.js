// 2.12 GPU Resonator through the whole DSP: the offline path (capture, the
// host on its JS mirror backend, play) at 44.1, 48 and 96 kHz, the feed's
// buffer reuse on the MessagePort transport, and the CPU default untouched.
import { describe, it, expect } from 'vitest';
import { ResoGpuHost } from '../../src/audio/reso-gpu-host.js';
import { ResoFeed, terrainFor } from '../../src/dsp/reso-feed.js';
import { FRAME, BLOCK, LATENCY_BLOCKS } from '../../src/dsp/reso-gpu-frame.js';
import { gpuLatencySec } from '../../src/dsp/reso-gpu-plan.js';
import { Resonator } from '../../src/dsp/resonator.js';
import { TERRAIN_INDEX } from '../../src/dsp/catalog.js';
import { makeDSP, render, allFinite } from './helpers.js';

const GRID = { n: 32, sub: 4 };   // small grid: the JS mirror stays quick
const PARAMS = { resoOn: 1, resoMix: 1, resoDecay: 3, resoTone: 0.8, filterType: 0 };
const NOTE = 57;                  // 220 Hz
const play = (d, t, k) => {
  if (k === 0) d.handleMessage({ t: 'noteOn', part: 0, note: NOTE, vel: 110 });
  if (k === 40) d.handleMessage({ t: 'noteOff', part: 0, note: NOTE });
};

function goertzel(x, start, n, f, sr) {
  const c = 2 * Math.cos(2 * Math.PI * f / sr);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = x[start + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n)) + c * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2));
}

describe('GPU Resonator offline path through the DSP', () => {
  for (const sr of [44100, 48000, 96000]) {
    it(`captures, renders and plays back at ${sr / 1000} kHz with the fixed latency`, async () => {
      const seconds = 0.5;
      const cap = makeDSP({ sr, terrainA: TERRAIN_INDEX.crater, params: PARAMS });
      cap.handleMessage({ t: 'resoGpu', op: 'capture', grid: GRID });
      render(cap, seconds, play);
      const R = cap.parts[0].reso;
      const frames = cap.resoGpu.takeCapture().get(0);
      // one frame per internal sample (the internal rate is sr / D, about 24 kHz)
      expect(R.fs).toBeGreaterThan(22000);
      expect(Math.abs(frames.length / FRAME - Math.round(seconds * sr) / R.D)).toBeLessThanOrEqual(1);

      const host = new ResoGpuHost({ backend: 'js' });
      const wet = await host.renderOffline({ frames, sr, grid: GRID, terrain: terrainFor(cap.parts[0], GRID.n) });
      expect(wet.length).toBe(2 * frames.length / FRAME);
      expect(allFinite(wet)).toBe(true);

      const dsp = makeDSP({ sr, terrainA: TERRAIN_INDEX.crater, params: PARAMS });
      dsp.handleMessage({ t: 'resoGpu', op: 'play', grid: GRID, wet: [[0, wet]] });
      const out = render(dsp, seconds, play);
      expect(allFinite(out.L) && allFinite(out.R)).toBe(true);
      // Mix 1: only the membrane is heard, and it starts LATENCY_BLOCKS blocks late
      const lat = gpuLatencySec(sr);
      expect(lat).toBeCloseTo(LATENCY_BLOCKS * BLOCK * R.D / sr, 9);
      expect(lat).toBeGreaterThan(0.031);
      expect(lat).toBeLessThan(0.036);
      const latN = Math.round(lat * sr);
      let early = 0, late = 0;
      for (let i = 0; i < latN - 8 * R.D; i++) early = Math.max(early, Math.abs(out.L[i]));
      for (let i = latN; i < out.L.length; i++) late = Math.max(late, Math.abs(out.L[i]));
      expect(early).toBeLessThan(1e-6);
      expect(late).toBeGreaterThan(1e-3);
      // it rings at the note
      const n = 8192, at = out.L.length - n, hz = 440 * Math.pow(2, (NOTE - 69) / 12);
      const on = goertzel(out.L, at, n, hz, sr);
      expect(on).toBeGreaterThan(4 * goertzel(out.L, at, n, hz * 1.19, sr));
      expect(on).toBeGreaterThan(4 * goertzel(out.L, at, n, hz / 1.19, sr));
    }, 120000);
  }
});

describe('GPU Resonator feed on the MessagePort transport', () => {
  it('reuses the chunk buffers the host hands back', () => {
    const R = new Resonator(48000, 'eco');
    R.configure(1, 1, 1.5, 0.5, 1, 0);
    R.derive([{ size: 64, data: new Float32Array(64 * 64) }], null, 0);
    R.setNote(220, true);
    const sent = [];
    const link = { grid: GRID, toHost: (m, xfer) => sent.push({ data: m.data, xfer: xfer && xfer[0] }), fellBack() {}, status() {} };
    const f = new ResoFeed(link, { reso: R, terrA: null, terrB: null, resoMorph: 0 }, 1, 'live');
    R.feed = f;
    f.ready(null);
    R.control(128);
    for (let i = 0; i < BLOCK; i++) f.tick(R, 0);
    expect(sent.length).toBe(1);
    expect(sent[0].xfer).toBe(sent[0].data.buffer);
    f.recycle(sent[0].data);
    for (let i = 0; i < BLOCK; i++) f.tick(R, 0);
    // the second block went out in a fresh buffer and the recycled one is now being filled
    expect(sent.length).toBe(2);
    expect(f.chunk).toBe(sent[0].data);
    f.recycle(new Float32Array(3));   // the wrong size is ignored
    expect(f.nPool).toBe(0);
  });
});

describe('GPU Resonator leaves the CPU default alone', () => {
  it('a DSP that never hears of the GPU has no link and no feed', () => {
    const dsp = makeDSP({ terrainA: TERRAIN_INDEX.crater, params: PARAMS });
    render(dsp, 0.1, play);
    expect(dsp.resoGpu).toBe(null);
    expect(dsp.parts[0].reso.feed).toBe(null);
  });

  it('detaching hands every part back to the CPU Resonator', () => {
    const run = (gpu) => {
      const dsp = makeDSP({ terrainA: TERRAIN_INDEX.crater, params: PARAMS });
      if (gpu) { dsp.handleMessage({ t: 'resoGpu', op: 'attach', port: null, grid: GRID }); dsp.handleMessage({ t: 'resoGpu', op: 'detach' }); }
      return render(dsp, 0.3, play);
    };
    const a = run(false), b = run(true);
    expect(b.L).toEqual(a.L);
    expect(b.R).toEqual(a.R);
  }, 60000);
});
