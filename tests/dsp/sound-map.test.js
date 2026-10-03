// v2.8: the drum library, the sound map (features, projection, navigation,
// Shuffle kit), the engine side of library pads and auditions, saved data.
import { describe, it, expect } from 'vitest';
import { SYNTH_DRUMS, synthDrum, DRUM_LIBRARY_SIZE, KIT_PADS, KIT_BASE_NOTE, KitPlayer, defaultDrum, sanitizeDrum, pcmToBase64 } from '../../src/dsp/drum-kit.js';
import { renderLibraryDrum, libraryInfo, libraryList, DRUM_CATEGORIES, LIBRARY_PCM_RATE } from '../../src/dsp/drum-library.js';
import {
  measureDrum, featureVector, fitProjection, libraryMap, libraryMapAsync, buildSoundMap, projectVector,
  nearestInDirection, similarTo, shuffleKit, KIT_ROLES, SAMPLE_CAT,
} from '../../src/dsp/sound-map.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { migrateState } from '../../src/core/migrate.js';
import { createStoreSync } from '../../src/audio/sync.js';
import { makeDSP, render, SR } from './helpers.js';

const peak = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const corr = (a, b) => {
  const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let c = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
  return c / Math.sqrt(va * vb);
};

describe('drum library', () => {
  it('has 128 named sounds in eight categories, at least ten of each', () => {
    const list = libraryList();
    expect(list).toHaveLength(DRUM_LIBRARY_SIZE);
    expect(DRUM_LIBRARY_SIZE).toBe(128);
    expect(new Set(list.map(e => e.name)).size).toBe(list.length);
    for (let c = 0; c < DRUM_CATEGORIES.length; c++) expect(list.filter(e => e.cat === c).length).toBeGreaterThanOrEqual(10);
    for (const e of list) expect(e.name.length).toBeLessThanOrEqual(24);
    expect(libraryInfo(-1)).toBeNull();
    expect(libraryInfo(DRUM_LIBRARY_SIZE)).toBeNull();
  });

  it('keeps indices 0..7 exactly the 2.7 synth drums', () => {
    for (let i = 0; i < SYNTH_DRUMS.length; i++) {
      expect(libraryInfo(i).name).toBe(SYNTH_DRUMS[i]);
      for (const sr of [44100, 48000]) expect(same(renderLibraryDrum(i, sr), synthDrum(i, sr))).toBe(true);
    }
  });

  it('renders every sound the same way each time: finite, peak 0.9, at most 1.5 s', () => {
    for (let i = SYNTH_DRUMS.length; i < DRUM_LIBRARY_SIZE; i++) {
      const a = renderLibraryDrum(i, SR), b = renderLibraryDrum(i, SR);
      expect(a !== b).toBe(true);
      expect(same(a, b)).toBe(true);
      expect(a.every(Number.isFinite)).toBe(true);
      expect(peak(a)).toBeCloseTo(0.9, 5);
      expect(a.length).toBeLessThanOrEqual(1.5 * SR);
      expect(Math.abs(a[a.length - 1])).toBeLessThan(1e-3);
    }
    expect(renderLibraryDrum(DRUM_LIBRARY_SIZE, SR)).toBeNull();
    expect(renderLibraryDrum(1.5, SR)).toBeNull();
  });

  it('gives different sounds for different indices and works at other rates', () => {
    const a = renderLibraryDrum(20, SR), b = renderLibraryDrum(21, SR);
    expect(same(a, b)).toBe(false);
    const lo = renderLibraryDrum(20, 22050);
    expect(lo.length / 22050).toBeCloseTo(a.length / SR, 2);
  });
});

describe('sound map', () => {
  it('measures every library sound with finite features', () => {
    const { points, raws } = libraryMap();
    expect(points).toHaveLength(DRUM_LIBRARY_SIZE);
    for (const r of raws) {
      for (const v of Object.values(r)) expect(Number.isFinite(v)).toBe(true);
      expect(r.flatness).toBeGreaterThanOrEqual(0); expect(r.flatness).toBeLessThanOrEqual(1);
      expect(featureVector(r).every(Number.isFinite)).toBe(true);
    }
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0); expect(p.y).toBeLessThanOrEqual(1);
      expect(p.z.every(Number.isFinite)).toBe(true);
    }
  });

  it('measures what it says: a sine has its pitch and is tonal, noise is noisy and bright', () => {
    const sine = Float32Array.from({ length: SR / 2 }, (_, i) => Math.sin(2 * Math.PI * 200 * i / SR) * Math.exp(-i / SR * 6));
    let s = 1;
    const noise = Float32Array.from({ length: SR / 4 }, (_, i) => { s = (s * 1103515245 + 12345) >>> 0; return (s / 4294967296 * 2 - 1) * Math.exp(-i / SR * 30); });
    const a = measureDrum(sine, SR), b = measureDrum(noise, SR);
    expect(Math.abs(a.pitch - 200)).toBeLessThan(SR / 2048);
    expect(a.flatness).toBeLessThan(0.1);
    expect(b.flatness).toBeGreaterThan(0.5);
    expect(b.centroid).toBeGreaterThan(a.centroid * 10);
    expect(a.length).toBeGreaterThan(b.length);
  });

  it('projects deterministically, brighter to the right and longer higher up', () => {
    const { points, raws } = libraryMap();
    const again = fitProjection(raws.map(featureVector));
    again.pts.forEach((p, i) => { expect(p[0]).toBe(points[i].x); expect(p[1]).toBe(points[i].y); });
    expect(corr(points.map(p => p.x), raws.map(r => Math.log2(r.centroid)))).toBeGreaterThan(0.9);
    expect(corr(points.map(p => p.y), raws.map(r => Math.log2(r.length + 0.005)))).toBeGreaterThan(0.75);
    const mean = (cat, k) => { const ps = points.filter(p => p.cat === cat); return ps.reduce((s, p) => s + p[k], 0) / ps.length; };
    expect(mean(0, 'x')).toBeLessThan(mean(2, 'x'));   // kicks left of hats
    expect(mean(3, 'y')).toBeGreaterThan(mean(2, 'y')); // open hats above closed hats
  });

  it('builds the same map asynchronously', async () => {
    const lib = await libraryMapAsync((fn) => fn());
    expect(lib).toBe(libraryMap());
  });

  it('places session samples with the library axes, once per sample', () => {
    const pcm = renderLibraryDrum(0, SR);
    const data = pcmToBase64(pcm);
    const pts = buildSoundMap([{ name: 'Rec 1', rate: SR, data, pcm }, { name: 'Copy', rate: SR, data, pcm }]);
    expect(pts).toHaveLength(DRUM_LIBRARY_SIZE + 1);
    const smp = pts.at(-1);
    expect(smp).toMatchObject({ cat: SAMPLE_CAT, name: 'Rec 1', index: -1, sample: { rate: SR, data } });
    // a recording of the synth kick lands next to the synth kick
    const kick = pts[0];
    expect(Math.hypot(smp.x - kick.x, smp.y - kick.y)).toBeLessThan(0.08);
    const p = projectVector(featureVector(measureDrum(pcm, SR)), libraryMap().proj);
    expect(p.z.every(Number.isFinite)).toBe(true);
  });

  it('moves to the nearest sound in a direction, or nowhere', () => {
    const pts = [{ x: 0.5, y: 0.5 }, { x: 0.7, y: 0.52 }, { x: 0.9, y: 0.5 }, { x: 0.5, y: 0.8 }, { x: 0.2, y: 0.2 }];
    expect(nearestInDirection(pts, 0, 1, 0)).toBe(1);
    expect(nearestInDirection(pts, 1, 1, 0)).toBe(2);
    expect(nearestInDirection(pts, 0, 0, 1)).toBe(3);
    expect(nearestInDirection(pts, 2, 1, 0)).toBe(-1);
    expect(nearestInDirection(pts, 0, -1, 0)).toBe(4);
  });

  it('finds similar sounds in the same category, nearest first', () => {
    const { points } = libraryMap();
    const list = similarTo(points, 0);
    expect(list.length).toBe(points.filter(p => p.cat === 0).length - 1);
    expect(list.every(i => points[i].cat === 0 && i !== 0)).toBe(true);
    const d = (i) => Math.hypot(...points[i].z.map((x, j) => x - points[0].z[j]));
    for (let k = 1; k < list.length; k++) expect(d(list[k])).toBeGreaterThanOrEqual(d(list[k - 1]));
    expect(similarTo(points, 0, { anyCategory: true }).length).toBe(points.length - 1);
  });

  it('shuffles a kit with one sound per role, the same for the same seed', () => {
    const { points } = libraryMap();
    for (const seed of [1, 2, 99, 12345]) {
      const kit = shuffleKit(seed);
      expect(kit).toHaveLength(KIT_PADS);
      expect(kit).toEqual(shuffleKit(seed));
      kit.forEach((li, k) => expect(points[li].cat).toBe(KIT_ROLES[k]));
    }
    const kits = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(s => shuffleKit(s).join(',')));
    expect(kits.size).toBeGreaterThan(4);
  });
});

describe('saved data and the engine', () => {
  it('keeps library pads through sanitize, JSON and migration', () => {
    const d = defaultDrum();
    d.on = 1;
    d.pads[0] = { ...d.pads[0], name: 'Kick 4', synth: 11 };
    d.pads[7] = { ...d.pads[7], name: 'Cymbal 2', synth: 127 };
    const back = sanitizeDrum(JSON.parse(JSON.stringify(sanitizeDrum(d))));
    expect(back).toEqual(sanitizeDrum(d));
    expect(back.pads[0]).toMatchObject({ name: 'Kick 4', synth: 11, sample: null });
    expect(back.pads[7].synth).toBe(127);
    expect(sanitizeDrum({ pads: [{ synth: 128.4 }] }).pads[0].synth).toBe(127);
    expect(sanitizeDrum({ pads: [{ synth: -3 }] }).pads[0].synth).toBe(0);
    const st = defaultState();
    st.parts[0].drum = d;
    expect(migrateState(JSON.parse(JSON.stringify(st))).parts[0].drum.pads[0].synth).toBe(11);
    // a default kit is unchanged
    expect(sanitizeDrum(defaultDrum())).toEqual(defaultDrum());
  });

  it('sync renders library sounds past the first eight on the main thread and sends them as audio', () => {
    const store = createStore(defaultState());
    const batches = [];
    let pending = null;
    createStoreSync({ store, post: (m) => batches.push(m), defer: (fn) => { pending = fn; } }).snapshot();
    const d = defaultDrum(); d.on = 1; d.pads[2] = { ...d.pads[2], synth: 50 };
    store.set('parts.0.drum', d);
    pending();
    const kit = batches.at(-1).find(m => m.t === 'kit');
    expect(kit.pads[2].pcm).toBeInstanceOf(Float32Array);
    expect(kit.pads[2].rate).toBe(LIBRARY_PCM_RATE);
    expect(same(kit.pads[2].pcm, renderLibraryDrum(50, LIBRARY_PCM_RATE))).toBe(true);
    expect(kit.pads[0].synth).toBe(0);           // the original eight are still built by the engine
    store.set('parts.0.drum.pads.2.pitch', 3);    // a knob move resends settings only
    pending();
    const next = batches.at(-1).find(m => m.t === 'kit');
    expect(next.pads[2]).toMatchObject({ keep: 1, pitch: 3 });
    expect(next.pads[2].pcm).toBeUndefined();
  });

  it('the engine plays library pads, renders each sound once and keeps 0..7 as before', () => {
    const dsp = makeDSP({ terrainA: 0 });
    const pads = Array.from({ length: KIT_PADS }, (_, i) => ({ synth: i === 3 ? 70 : i, gain: 0.8, pitch: 0, decay: 1, pan: 0, choke: 0 }));
    dsp.handleMessage({ t: 'kit', part: 0, on: 1, pads });
    const kit = dsp.partAt(0).kit;
    expect(same(kit.pads[3].data, renderLibraryDrum(70, dsp.sr))).toBe(true);
    for (const i of [0, 1, 2, 4, 5, 6, 7]) expect(same(kit.pads[i].data, synthDrum(i, dsp.sr))).toBe(true);
    const held = kit.pads[3].data;
    dsp.handleMessage({ t: 'kit', part: 1, on: 1, pads });
    expect(dsp.partAt(1).kit.pads[3].data).toBe(held);
    const out = render(dsp, 0.3, (d, t, b) => { if (b === 0) d.handleMessage({ t: 'noteOn', part: 0, note: KIT_BASE_NOTE + 3, vel: 1 }); });
    expect(peak(out.L)).toBeGreaterThan(0.02);
    expect(out.L.every(Number.isFinite)).toBe(true);
  });

  it('auditions a sound on a kit track without changing its pads, and not on a synth track', () => {
    const dsp = makeDSP({ terrainA: 0 });
    dsp.handleMessage({ kind: 'x', t: 'kitPreview', part: 0, synth: 40 });
    const silent = render(dsp, 0.1);
    expect(peak(silent.L)).toBe(0);
    dsp.handleMessage({ t: 'kit', part: 0, on: 1, pads: SYNTH_DRUMS.map((_, i) => ({ synth: i, gain: 0.8, pitch: 0, decay: 1, pan: 0, choke: 0 })) });
    const before = dsp.partAt(0).kit.pads.slice(0, KIT_PADS).map(p => p.data);
    const out = render(dsp, 0.3, (d, t, b) => { if (b === 0) d.handleMessage({ t: 'kitPreview', part: 0, synth: 40, vel: 1, gain: 0.8 }); });
    expect(peak(out.L)).toBeGreaterThan(0.02);
    expect(dsp.partAt(0).kit.pads.slice(0, KIT_PADS).map(p => p.data)).toEqual(before);
    const pcm = new Float32Array(2000).fill(0.5);
    const out2 = render(dsp, 0.1, (d, t, b) => { if (b === 0) d.handleMessage({ t: 'kitPreview', part: 0, pcm, rate: 48000 }); });
    expect(peak(out2.L)).toBeGreaterThan(0.02);
  });

  it('a new audition fades the previous one instead of stacking', () => {
    const kp = new KitPlayer(48000);
    const long = new Float32Array(48000).fill(0.5);
    for (let k = 0; k < 6; k++) kp.preview(long, 48000);
    const L = new Float32Array(2400), R = new Float32Array(2400);
    kp.render(L, R, 0, 2400);
    expect(kp.voices.filter(v => v.on).length).toBeLessThanOrEqual(2);
    // after ~50 ms only the newest audition is left, at its own level
    expect(L[2399]).toBeCloseTo(0.5 * 0.8 * 0.9, 3);
  });
});
