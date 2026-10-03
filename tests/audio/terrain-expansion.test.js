import { describe, it, expect } from 'vitest';
import { TERRAIN_LIBRARY, searchTerrainLibrary, generateLibraryRgba, terrainLibraryPng } from '../../src/dsp/terrain-library.js';
import { TERRAINS, TERRAIN_INDEX, PATHS, PATH_INDEX } from '../../src/dsp/catalog.js';
import { readPngChunks, decodePng, crc32 } from '../../src/audio/png.js';
import { readTerrainFile, importTerrainFile, bytesToBase64, audioTerrainFromSource } from '../../src/audio/importers.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { REPLACE_TRACKS } from '../../src/core/tracks.js';
import { sanitizeUserTerrain } from '../../src/dsp/user-terrain.js';
import { jobFor, jobKey, buildTerrainData, decodeImportedTerrain } from '../../src/audio/terrain-jobs.js';
import { pathPoint, pathBlockAt, shapePathPoint } from '../../src/dsp/paths.js';
import { generateTerrain, base64ToBytes } from '../../src/dsp/terrains.js';
import { wavHeader } from '../../src/audio/wav.js';

describe('Orograph terrain expansion', () => {
  it('appends registries without moving imported terrains or old paths', () => {
    expect(TERRAIN_INDEX.user).toBe(13); expect(PATH_INDEX.scribble).toBe(11);
    expect(TERRAINS.filter(t => t.id !== 'user').length).toBeGreaterThanOrEqual(18);
    expect(PATHS.length).toBeGreaterThanOrEqual(20);
    for (let k = 14; k < TERRAINS.length; k++) {
      const a = generateTerrain(k), b = generateTerrain(k);
      expect(a.length).toBe(512 * 512); expect(a).toEqual(b);
      expect(Math.max(...a.subarray(0, 4096).map(Math.abs))).toBeGreaterThan(0.05);
    }
  });
  it('contains 320 distinct original images and real 512 RGBA PNGs', async () => {
    expect(TERRAIN_LIBRARY.length).toBe(320);
    expect(new Set(TERRAIN_LIBRARY.map(e => crc32(generateLibraryRgba(e.id, 16).data))).size).toBe(320);
    expect(searchTerrainLibrary('', 'Rings')).toHaveLength(32);
    expect(searchTerrainLibrary('Strata 01')).toHaveLength(1);
    const bytes = terrainLibraryPng(TERRAIN_LIBRARY[0].id), header = readPngChunks(bytes).header;
    expect(header).toMatchObject({ width: 512, height: 512, colorType: 6 });
    const png = await decodePng(bytes); expect(png.data.length).toBe(512 * 512 * 4);
  });
  it('retains all image channels through save sanitization and continuously blends them', async () => {
    const file = new File([terrainLibraryPng('original-prisms-013')], 'prisms.png', { type: 'image/png' });
    const ut = await readTerrainFile(file, 'prisms', { smooth: 0 });
    const saved = sanitizeUserTerrain(JSON.parse(JSON.stringify({ ...ut, libraryId: 'original-prisms-013' })));
    expect(saved.channels).toEqual(ut.channels); expect(saved.libraryId).toBe('original-prisms-013');
    const red = decodeImportedTerrain(saved, 32, 0), green = decodeImportedTerrain(saved, 32, 1), half = decodeImportedTerrain(saved, 32, 0.5);
    expect(red).not.toEqual(green);
    for (let i = 0; i < half.length; i++) expect(half[i]).toBeCloseTo((red[i] + green[i]) / 2, 6);
    const p = { terrainA: TERRAIN_INDEX.user, imageChannelA: 0 };
    expect(jobKey(jobFor(p, saved, 'A', 512))).not.toBe(jobKey(jobFor({ ...p, imageChannelA: 1 }, saved, 'A', 512)));
    expect(jobKey(jobFor(p, saved, 'A', 512))).not.toBe(jobKey(jobFor({ ...p, imageMappingA: 1 }, saved, 'A', 512)));
  });
  it('preserves chosen-channel legacy imports and polar maps images and wavetables', () => {
    const data = bytesToBase64(Uint8Array.from({ length: 64 }, (_, i) => (i * 41) & 255));
    for (const kind of ['image', 'wavetable']) {
      const ut = { kind, w: 8, h: 8, mirror: 1, data };
      const cart = decodeImportedTerrain(ut, 32, 0), legacy = decodeImportedTerrain(ut, 32, 2.8), polar = decodeImportedTerrain(ut, 32, 0, 1);
      expect(cart).toEqual(legacy); expect(polar).not.toEqual(cart); expect(polar.every(Number.isFinite)).toBe(true);
      expect(buildTerrainData(jobFor({ terrainA: 13, imageMappingA: 1 }, ut, 'A', 32))).toEqual(polar);
    }
  });
  it('maps an arbitrary complete recording including its tail and browser decoded compressed audio', async () => {
    const samples = Float32Array.from({ length: 12345 }, (_, i) => i / 12344 * 2 - 1);
    const source = { length: samples.length, sampleRate: 48000, read: (a, n) => samples.subarray(a, a + n) };
    const ut = await audioTerrainFromSource(source, { yieldToUI: false });
    expect(ut).toMatchObject({ kind: 'audio', w: 512, h: 512, audio: { sampleRate: 48000, duration: samples.length / 48000 } });
    const raw = base64ToBytes(ut.data); expect(raw[0]).toBe(0); expect(raw.at(-1)).toBe(255);
    const mp3 = new File(['ID3 compressed fixture'], 'song.mp3', { type: 'audio/mpeg' });
    const decoded = await readTerrainFile(mp3, 'song', { decodeAudioData: async () => ({ numberOfChannels: 1, sampleRate: 48000, getChannelData: () => samples }) });
    expect(decoded.kind).toBe('audio'); expect(decoded.data).toBe(ut.data);
    const wav = new Uint8Array(44 + samples.length * 4); wav.set(wavHeader({ sampleRate: 48000, channels: 1, bitsPerSample: 32, frames: samples.length, format: 3 }));
    new Float32Array(wav.buffer, 44).set(samples);
    const exact = await readTerrainFile(new File([wav], 'recording.wav'));
    expect(exact.data).toBe(ut.data); expect(sanitizeUserTerrain(exact).audio).toEqual(exact.audio);
  });
  it('keeps delayed terrain imports on their stable track and in selection order across reorders', async () => {
    const store = createStore(defaultState());
    let release, started;
    const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { started = resolve; });
    const decoded = { numberOfChannels: 1, sampleRate: 48000, getChannelData: () => Float32Array.of(-1, 0, 1, 0) };
    const first = importTerrainFile(store, 0, 'A', new File(['ID3 first'], 'First.mp3', { type: 'audio/mpeg' }), { decodeAudioData: async () => { started(); await gate; return decoded; } });
    await ready;
    const parts = store.get('parts').slice();
    [parts[0], parts[1]] = [parts[1], parts[0]]; store.set('parts', parts);
    const later = importTerrainFile(store, 1, 'A', new File(['ID3 later'], 'Later.mp3', { type: 'audio/mpeg' }), { decodeAudioData: async () => decoded });
    release(); await Promise.all([first, later]);
    expect(store.get('parts.0.userTerrain.A')).toBeNull();
    expect(store.get('parts.1.userTerrain.A').name).toBe('Later');
    expect(store.get('parts.1.params.terrainA')).toBe(TERRAIN_INDEX.user);
  });
  it.each(['remove and reuse id', 'replace scene'])('rejects a pending terrain import after %s', async operation => {
    const store = createStore(defaultState());
    let release, started;
    const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { started = resolve; });
    const pending = importTerrainFile(store, 0, 'A', new File(['ID3 delayed'], 'Delayed.mp3', { type: 'audio/mpeg' }), { decodeAudioData: async () => { started(); await gate; return { numberOfChannels: 1, sampleRate: 48000, getChannelData: () => Float32Array.of(-1, 0, 1, 0) }; } });
    const outcome = pending.catch(error => error);
    await ready;
    if (operation === 'replace scene') store.load(store.serialize(), { [REPLACE_TRACKS]: true });
    else {
      const parts = store.get('parts').slice();
      store.batch(() => { store.set('parts', parts.slice(1)); store.set('parts', parts); });
    }
    release(); expect((await outcome).message).toMatch(/removed or replaced/);
    expect(store.get('parts.0.userTerrain.A')).toBeNull();
    expect(store.get('parts.1.userTerrain.A')).toBeNull();
  });
  it('keeps new arbitrary-phase kernels consistent and shaping bounded with an exact identity', () => {
    const T = Float64Array.from({ length: 128 }, (_, i) => i / 128), X = new Float64Array(128), Y = new Float64Array(128), pt = {};
    for (let s = 12; s < 20; s++) {
      pathBlockAt(s, 4, 128, T, 0.4, 0.001, X, Y);
      for (let i = 0; i < 128; i++) { pathPoint(s, T[i], 4, 0.4 + (i + 1) * 0.001, pt); expect(X[i]).toBeCloseTo(pt.x, 12); expect(Y[i]).toBeCloseTo(pt.y, 12); }
    }
    expect(shapePathPoint(-0.4, 0.7, 0.2, 0, 0, 0, pt)).toEqual({ x: -0.4, y: 0.7 });
    shapePathPoint(-0.4, -0.7, 0.5, 0, 0, 3, pt); expect(pt).toEqual({ x: 0.4, y: 0.7 });
    shapePathPoint(1, 1, 0, 1, 1, 0, pt); expect(pt).toEqual({ x: 0, y: 0 });
    for (const t of T) for (const m of [-1, 1]) { shapePathPoint(Math.cos(t * 6.28), Math.sin(t * 6.28), t, 0.7, m, 3, pt); expect(Math.abs(pt.x)).toBeLessThanOrEqual(1); expect(Math.abs(pt.y)).toBeLessThanOrEqual(1); }
  });
});
