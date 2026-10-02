import { describe, it, expect } from 'vitest';
import {
  resampleToWavetable, nextResampleName, tempoSlice, steadyPitch, monoNoDc, noteName, TEMPO_FREQ_LOW,
} from '../../src/audio/resample.js';
import { addUserTerrain } from '../../src/audio/importers.js';
import { base64ToBytes, decodeUserTerrain } from '../../src/dsp/terrains.js';
import { sanitizePart, migrateState } from '../../src/core/migrate.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { TERRAIN_INDEX } from '../../src/dsp/catalog.js';
import { fft } from '../../src/pedals/signal.js';

const SR = 48000;
const rand = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

/** A held note with a few harmonics and a slow decay, stereo, with some DC. */
function pitched(freq, seconds = 1.5, sr = SR) {
  const n = Math.round(seconds * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.01) * Math.exp(-t * 0.8);
    const ph = 2 * Math.PI * freq * t;
    const v = env * (0.6 * Math.sin(ph) + 0.25 * Math.sin(2 * ph + 0.3) + 0.12 * Math.sin(3 * ph + 1.1));
    L[i] = v + 0.05; R[i] = 0.9 * v + 0.05;
  }
  return { L, R };
}

/** Drum-like noise bursts on a beat grid: no steady pitch. */
function unpitched(seconds = 2, bpm = 120, sr = SR) {
  const n = Math.round(seconds * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  const r = rand(7);
  const beat = Math.round(60 / bpm * sr / 2);
  for (let i = 0; i < n; i++) {
    const k = i % beat;
    const env = Math.exp(-k / (0.04 * sr));
    L[i] = env * (r() * 2 - 1) * 0.7;
    R[i] = env * (r() * 2 - 1) * 0.7;
  }
  return { L, R };
}

/** 16-bit table rows (hi/lo planes) as -1..1 floats. */
function rows(ut) {
  const hi = base64ToBytes(ut.data), lo = base64ToBytes(ut.lo);
  const out = [];
  for (let r = 0; r < ut.h; r++) {
    const row = new Float64Array(ut.w);
    for (let i = 0; i < ut.w; i++) row[i] = ((hi[r * ut.w + i] << 8) | lo[r * ut.w + i]) / 32767.5 - 1;
    out.push(row);
  }
  return out;
}

function validTerrain(ut) {
  expect(ut.kind).toBe('wavetable');
  expect(ut.w).toBe(256);
  expect(ut.h).toBeGreaterThanOrEqual(2);
  expect(ut.h).toBeLessThanOrEqual(256);
  expect(ut.mirror).toBe(1);
  expect(base64ToBytes(ut.data).length).toBe(ut.w * ut.h);
  expect(base64ToBytes(ut.lo).length).toBe(ut.w * ut.h);
  const part = sanitizePart({ userTerrain: { A: ut } }, 0);
  expect(part.userTerrain.A).not.toBeNull();
  const table = decodeUserTerrain(part.userTerrain.A, 128);
  expect(table.every(Number.isFinite)).toBe(true);
}

describe('resample helpers', () => {
  it('names count up from the highest Resample N in use', () => {
    const st = defaultState();
    expect(nextResampleName(st)).toBe('Resample 1');
    st.parts[0].userTerrain = { A: { name: 'Resample 1' }, B: null };
    st.parts[2].userTerrain = { A: { name: 'Guitar A2' }, B: { name: 'Resample 3' } };
    expect(nextResampleName(st)).toBe('Resample 4');
    st.parts[1].userTerrain = { A: { name: 'Resample 12 copy' }, B: null };
    expect(nextResampleName(st)).toBe('Resample 4');
    expect(nextResampleName(null)).toBe('Resample 1');
  });

  it('tempo slices land between 55 and 110 Hz on the beat grid', () => {
    for (const bpm of [60, 90, 112, 120, 174]) {
      const t = tempoSlice(bpm, SR);
      expect(t.freq).toBeGreaterThanOrEqual(TEMPO_FREQ_LOW);
      expect(t.freq).toBeLessThan(2 * TEMPO_FREQ_LOW);
      // A whole number of slices per beat.
      const perBeat = t.freq * 60 / bpm;
      expect(Math.abs(perBeat - Math.round(perBeat))).toBeLessThan(1e-9);
    }
    expect(tempoSlice(120, SR).division).toBe(4 * 32);
  });

  it('removes DC when mixing to mono', () => {
    const L = new Float32Array(1000).fill(0.3), R = new Float32Array(1000).fill(0.1);
    const m = monoNoDc(L, R);
    expect(Math.max(...m.map(Math.abs))).toBeLessThan(1e-6);
  });

  it('tells pitched from unpitched material', () => {
    const p = pitched(220);
    expect(steadyPitch(monoNoDc(p.L, p.R), SR).pitched).toBe(true);
    const u = unpitched();
    expect(steadyPitch(monoNoDc(u.L, u.R), SR).pitched).toBe(false);
  });
});

describe('resampleToWavetable', () => {
  it('turns a pitched loop into a wavetable through the Capture path', () => {
    const { L, R } = pitched(220);
    const res = resampleToWavetable(L, R, SR, { name: 'Resample 1' });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('pitch');
    expect(res.freq).toBeGreaterThan(220 * 0.99);
    expect(res.freq).toBeLessThan(220 * 1.01);
    expect(noteName(res.note)).toBe('A3');
    expect(res.detail).toMatch(/Pitch found: A3/);
    expect(res.userTerrain.name).toBe('Resample 1');
    validTerrain(res.userTerrain);
  });

  it('slices unpitched material at a tempo period and says so', () => {
    const { L, R } = unpitched(2, 120);
    const res = resampleToWavetable(L, R, SR, { tempo: 120, name: 'Resample 2' });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('tempo');
    expect(res.pitchFound).toBe(false);
    expect(res.detail).toMatch(/No steady pitch found/);
    expect(res.freq).toBeCloseTo(tempoSlice(120, SR).freq, 9);
    validTerrain(res.userTerrain);
    // One row per whole slice period (2 s at 64 Hz: 128 periods, less the edges).
    expect(res.userTerrain.h).toBe(Math.floor((L.length - res.periodSamples - 2) / res.periodSamples));
  });

  it('slices at a chosen root note', () => {
    const { L, R } = unpitched(1);
    const res = resampleToWavetable(L, R, SR, { slice: 'root', rootNote: 48 });
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('root');
    expect(res.freq).toBeCloseTo(130.8128, 3);
    expect(res.detail).toMatch(/C3/);
    validTerrain(res.userTerrain);
  });

  it('works at 44.1 kHz too', () => {
    const { L, R } = pitched(110, 2, 44100);
    const res = resampleToWavetable(L, R, 44100);
    expect(res.ok).toBe(true);
    expect(res.mode).toBe('pitch');
    expect(Math.abs(res.freq - 110)).toBeLessThan(1.5);
  });

  it('band-limits each frame to what the period and the row can hold, without DC, at full scale', () => {
    const { L, R } = unpitched(1);
    // Root note 100 (2.6 kHz): an 18-sample period holds only 8 harmonics.
    const res = resampleToWavetable(L, R, SR, { slice: 'root', rootNote: 100 });
    expect(res.ok).toBe(true);
    const H = Math.floor(res.periodSamples / 2) - 1;
    let worstAlias = 0, worstDc = 0, peak = 0, inBand = 0;
    for (const row of rows(res.userTerrain)) {
      const re = Float64Array.from(row), im = new Float64Array(row.length);
      fft(re, im);
      for (let k = 1; k < 128; k++) {
        const mag = Math.hypot(re[k], im[k]) / 128;
        if (k > H) worstAlias = Math.max(worstAlias, mag); else inBand = Math.max(inBand, mag);
      }
      worstDc = Math.max(worstDc, Math.abs(re[0] / 256));
      for (const v of row) peak = Math.max(peak, Math.abs(v));
    }
    expect(inBand).toBeGreaterThan(0.05);
    expect(worstAlias).toBeLessThan(1e-3);           // only 16-bit rounding noise up there
    expect(worstDc).toBeLessThan(1e-3);
    expect(peak).toBeGreaterThan(0.99);               // normalised to the full 16-bit range
  });

  it('refuses silence and too-short audio with a reason', () => {
    const z = new Float32Array(SR);
    expect(resampleToWavetable(z, z, SR)).toMatchObject({ ok: false });
    expect(resampleToWavetable(new Float32Array(100), null, SR).reason).toMatch(/too short/);
  });
});

describe('resample into the store', () => {
  it('stores the terrain in the chosen part and slot, selects it, and is repeatable', async () => {
    const store = createStore(defaultState());
    const a = pitched(220);
    const name1 = nextResampleName(store.serialize());
    const r1 = resampleToWavetable(a.L, a.R, SR, { name: name1 });
    await addUserTerrain(store, 1, 'B', r1.userTerrain, { source: 'resample' });
    expect(store.get('parts.1.userTerrain.B').name).toBe('Resample 1');
    expect(store.get('parts.1.userTerrain.B').lo).toBe(r1.userTerrain.lo);
    expect(store.get('parts.1.params.terrainB')).toBe(TERRAIN_INDEX.user);

    // Again, into slot A, from different material.
    const u = unpitched();
    const name2 = nextResampleName(store.serialize());
    const r2 = resampleToWavetable(u.L, u.R, SR, { name: name2 });
    await addUserTerrain(store, 1, 'A', r2.userTerrain, { source: 'resample' });
    expect(store.get('parts.1.userTerrain.A').name).toBe('Resample 2');
    expect(nextResampleName(store.serialize())).toBe('Resample 3');

    // A saved session with resampled terrains loads unchanged (no migration needed).
    const back = migrateState(JSON.parse(JSON.stringify(store.serialize())));
    expect(back.parts[1].userTerrain.A.name).toBe('Resample 2');
    expect(back.parts[1].userTerrain.B.data).toBe(r1.userTerrain.data);
    expect(back.parts[1].userTerrain.B.lo).toBe(r1.userTerrain.lo);
  });
});
