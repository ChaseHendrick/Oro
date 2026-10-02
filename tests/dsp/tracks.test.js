// The DSP side of tracks (v1.3): MAX_PARTS parts exist, {t:'tracks'} says how
// many are in use. Parts past the count cost nothing, any part in use renders
// like the first one, a reorder moves the parts without touching the sound,
// and a removed track fades out instead of clicking.
import { describe, it, expect } from 'vitest';
import { OrographDSP } from '../../src/dsp/dsp-core.js';
import { MAX_PARTS, DEFAULT_PARTS } from '../../src/core/params.js';
import { TERRAINS } from '../../src/dsp/catalog.js';
import { SR, render, rms, peak, allFinite, terrainChain } from './helpers.js';

const T = Object.fromEntries(TERRAINS.map((t, i) => [t.id, i]));
const swap = (a, b) => { const p = Array.from({ length: MAX_PARTS }, (_, i) => i); p[a] = b; p[b] = a; return p; };

function dspWith(count, part, { note = 57, params = {} } = {}) {
  const dsp = new OrographDSP(SR);
  dsp.handleMessage({ t: 'tracks', count });
  dsp.handleMessage({ t: 'terrain', part, slot: 0, levels: terrainChain(T.swell) });
  dsp.handleMessage({ t: 'params', part, p: { attack: 0.002, release: 0.05, ...params } });
  if (note != null) dsp.handleMessage({ t: 'noteOn', part, note, vel: 1 });
  return dsp;
}

/** Largest jump between neighbouring samples. */
function maxStep(a, from = 1, to = a.length) {
  let m = 0;
  for (let i = Math.max(1, from); i < to; i++) m = Math.max(m, Math.abs(a[i] - a[i - 1]));
  return m;
}

describe('track count', () => {
  it('starts with the default four tracks and ignores notes for parts past the count', () => {
    const dsp = new OrographDSP(SR);
    expect(dsp.parts).toHaveLength(MAX_PARTS);
    expect(dsp.count).toBe(DEFAULT_PARTS);
    dsp.handleMessage({ t: 'terrain', part: 5, slot: 0, levels: terrainChain(T.swell) });
    dsp.handleMessage({ t: 'noteOn', part: 5, note: 60, vel: 1 });
    expect(dsp.parts[5].activeCount()).toBe(0);
    expect(rms(render(dsp, 0.1).L)).toBe(0);
    dsp.handleMessage({ t: 'tracks', count: 99 });
    expect(dsp.count).toBe(MAX_PARTS);
    dsp.handleMessage({ t: 'tracks', count: 0 });
    expect(dsp.count).toBe(1);
  });

  it('renders track 6 exactly like track 1', () => {
    const a = render(dspWith(6, 0), 0.3);
    const b = render(dspWith(6, 5), 0.3);
    expect(rms(a.L)).toBeGreaterThan(0.01);
    expect(allFinite(b.L)).toBe(true);
    let diff = 0;
    for (let i = 0; i < a.L.length; i++) diff = Math.max(diff, Math.abs(a.L[i] - b.L[i]), Math.abs(a.R[i] - b.R[i]));
    expect(diff).toBeLessThan(1e-6);
    expect(rms(b.DL)).toBeCloseTo(rms(a.DL), 6);
  });

  it('plays sixteen tracks at once', () => {
    const dsp = new OrographDSP(SR);
    dsp.handleMessage({ t: 'tracks', count: MAX_PARTS });
    for (let p = 0; p < MAX_PARTS; p++) {
      dsp.handleMessage({ t: 'terrain', part: p, slot: 0, levels: terrainChain(T.swell) });
      dsp.handleMessage({ t: 'params', part: p, p: { level: 0.3 } });
      dsp.handleMessage({ t: 'noteOn', part: p, note: 40 + 2 * p, vel: 0.7 });
    }
    const out = render(dsp, 0.2);
    expect(allFinite(out.L)).toBe(true);
    expect(dsp.parts.every(P => P.activeCount() === 1)).toBe(true);
    expect(rms(out.L)).toBeGreaterThan(0.01);
  });

  it('does no work for parts past the count (no LFOs, ramps or buses)', () => {
    const dsp = new OrographDSP(SR);
    dsp.handleMessage({ t: 'tracks', count: 2 });
    const seen = new Set();
    const lfos = dsp.advanceLfos.bind(dsp);
    dsp.advanceLfos = (P, dt) => { seen.add(P.index); return lfos(P, dt); };
    render(dsp, 0.05);
    expect([...seen].sort()).toEqual([0, 1]);
  });
});

describe('reorder', () => {
  it('moves a sounding part to its new index without changing a sample', () => {
    const ref = dspWith(4, 0);
    const moved = dspWith(4, 0);
    const a1 = render(ref, 0.15), b1 = render(moved, 0.15);
    moved.handleMessage({ t: 'tracks', count: 4, perm: swap(0, 2), fresh: [] });
    expect(moved.parts[2].activeCount()).toBe(1);
    expect(moved.parts[0].activeCount()).toBe(0);
    const a2 = render(ref, 0.15), b2 = render(moved, 0.15);
    let diff = 0;
    for (const [x, y] of [[a1.L, b1.L], [a2.L, b2.L], [a2.R, b2.R]]) for (let i = 0; i < x.length; i++) diff = Math.max(diff, Math.abs(x[i] - y[i]));
    expect(diff).toBeLessThan(1e-9);
    // the note-off now goes to the part's new index
    moved.handleMessage({ t: 'noteOff', part: 2, note: 57 });
    render(moved, 0.3);
    expect(moved.parts[2].activeCount()).toBe(0);
  });

  it('moves queued notes with their part', () => {
    const dsp = dspWith(4, 1, { note: null });
    render(dsp, 0.01);
    dsp.handleMessage({ t: 'noteOn', part: 1, note: 60, vel: 1, time: dsp.lastTime + 0.05 });
    dsp.handleMessage({ t: 'tracks', count: 4, perm: swap(1, 3), fresh: [] });
    render(dsp, 0.1);
    expect(dsp.parts[3].activeCount()).toBe(1);
    expect(dsp.parts[1].activeCount()).toBe(0);
  });

  it('ignores a malformed permutation', () => {
    const dsp = dspWith(4, 0);
    const before = dsp.parts.slice();
    dsp.handleMessage({ t: 'tracks', count: 4, perm: [0, 0, 1] });
    dsp.handleMessage({ t: 'tracks', count: 4, perm: Array(MAX_PARTS).fill(0) });
    expect(dsp.parts).toEqual(before);
  });
});

describe('removing and adding tracks', () => {
  it('fades a removed, sounding track out in about 80 ms without a click, then frees it', () => {
    const dsp = dspWith(4, 1, { params: { release: 4 } });
    const steady = render(dsp, 0.2);
    const stepBefore = maxStep(steady.L, steady.L.length - 4800);
    // track 2 leaves the list: its part goes to the last slot and fades
    const perm = Array.from({ length: MAX_PARTS }, (_, i) => i);
    perm.splice(1, 1); perm.push(1);
    dsp.handleMessage({ t: 'tracks', count: 3, perm, fresh: [] });
    const P = dsp.parts[MAX_PARTS - 1];
    expect(P.activeCount()).toBe(1);
    const fade = render(dsp, 0.2);
    expect(maxStep(fade.L)).toBeLessThan(stepBefore * 1.05 + 1e-6);
    expect(peak(fade.L, Math.round(0.1 * SR))).toBe(0);      // silent after ~0.1 s
    expect(peak(fade.L, 0, Math.round(0.02 * SR))).toBeGreaterThan(0.01); // not cut off
    expect(P.activeCount()).toBe(0);                          // its voices stopped (release was 4 s)
    expect(dsp.dormant(P)).toBe(true);
    expect(rms(render(dsp, 0.05).L)).toBe(0);
  });

  it('starts a new track clean in a fresh slot', () => {
    const dsp = dspWith(4, 0);
    render(dsp, 0.05);
    dsp.handleMessage({ t: 'params', part: 4, p: { cutoff: 123 } });  // stale settings in the unused slot
    dsp.handleMessage({ t: 'tracks', count: 5, fresh: [4] });
    expect(dsp.parts[4].params[0]).toBe(dsp.parts[3].params[0]);  // terrainA back at its default
    expect(dsp.parts[4].activeCount()).toBe(0);
    expect(dsp.parts[4].index).toBe(4);
    dsp.handleMessage({ t: 'terrain', part: 4, slot: 0, levels: terrainChain(T.swell) });
    dsp.handleMessage({ t: 'noteOn', part: 4, note: 50, vel: 1 });
    expect(dsp.parts[4].activeCount()).toBe(1);
    expect(allFinite(render(dsp, 0.05).L)).toBe(true);
  });

  it('reports telemetry voice counts for the tracks in use only', () => {
    const dsp = dspWith(6, 5);
    const tele = [];
    dsp.postMessage = (m) => tele.push(m);
    render(dsp, 0.1);
    const m = tele[tele.length - 1];
    expect(m.count).toBe(6);
    expect(m.activeVoices).toEqual([0, 0, 0, 0, 0, 1]);
  });
});
