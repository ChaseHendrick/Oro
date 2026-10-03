// v2.10 Real places: build helpers (terrarium decode, resample, normalise),
// the shipped assets (places.json integrity) and loading a place as a terrain.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  decodePng, encodeGray16Png, terrariumHeight, terrariumHeights, resampleArea, normalise16,
  localToLatLon, lonLatToPixel, parseBscLine, crc32,
} from '../../scripts/places-lib.mjs';
import { loadPlaces, placeTerrain, placeFacts, formatMetres, _resetPlaces, PLACE_ID_RE, PLACE_BODIES } from '../../src/audio/places.js';
import { sanitizeUserTerrain } from '../../src/dsp/user-terrain.js';
import { migrateState } from '../../src/core/migrate.js';
import { defaultState } from '../../src/core/params.js';

const DIR = path.resolve(__dirname, '../../public/places');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'places.json'), 'utf8'));
const fakeFetch = async (url) => {
  const file = path.join(DIR, new URL(url).pathname.split('/').pop());
  if (!fs.existsSync(file)) return { ok: false, status: 404 };
  const buf = fs.readFileSync(file);
  return { ok: true, status: 200, json: async () => JSON.parse(buf.toString('utf8')), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
};

function rgbPng(w, h, pixels) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = pixels[y * w * 3 + x];
  const chunk = (type, body) => {
    const b = Buffer.alloc(12 + body.length);
    b.writeUInt32BE(body.length, 0); b.write(type, 4, 'ascii'); body.copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, 8 + body.length)), 8 + body.length);
    return b;
  };
  const ihdr = Buffer.from([0, 0, 0, w, 0, 0, 0, h, 8, 2, 0, 0, 0]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

describe('build helpers', () => {
  it('decodes terrarium heights (R * 256 + G + B / 256 - 32768)', () => {
    expect(terrariumHeight(128, 0, 0)).toBe(0);
    expect(terrariumHeight(162, 144, 0)).toBe(8848);
    expect(terrariumHeight(85, 104, 128)).toBeCloseTo(-10904 + 0.5, 6);
    const png = decodePng(rgbPng(2, 1, [128, 0, 0, 162, 144, 0]));
    expect([png.width, png.height, png.channels]).toEqual([2, 1, 3]);
    expect(Array.from(terrariumHeights(png))).toEqual([0, 8848]);
  });

  it('round-trips 16-bit grey PNGs and encodes deterministically', () => {
    const v = Uint16Array.from({ length: 64 }, (_, i) => (i * 1031) % 65536);
    const a = encodeGray16Png(v, 8, 8), b = encodeGray16Png(v, 8, 8);
    expect(Buffer.compare(a, b)).toBe(0);
    const d = decodePng(a);
    expect([d.width, d.height, d.bitDepth, d.colorType]).toEqual([8, 8, 16, 0]);
    for (let i = 0; i < 64; i++) expect((d.data[i * 2] << 8) | d.data[i * 2 + 1]).toBe(v[i]);
  });

  it('resamples by area (mean kept) and normalises to the full 16-bit range, the same every time', () => {
    const src = Float64Array.from({ length: 30 * 30 }, (_, i) => Math.sin(i * 0.37) * 100 + (i % 30));
    const r1 = resampleArea(src, 30, 30, 8, 8), r2 = resampleArea(src, 30, 30, 8, 8);
    expect(Array.from(r1)).toEqual(Array.from(r2));
    const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
    expect(mean(r1)).toBeCloseTo(mean(src), 6);
    const n = normalise16(r1);
    expect(Math.min(...n.data)).toBe(0); expect(Math.max(...n.data)).toBe(65535);
    expect(n.min).toBe(Math.min(...r1)); expect(n.max).toBe(Math.max(...r1));
    expect(Array.from(normalise16(r2).data)).toEqual(Array.from(n.data));
    expect(Array.from(normalise16([5, 5]).data)).toEqual([0, 0]);
  });

  it('projects map positions', () => {
    expect(localToLatLon(0, 0, 10, 20, 1737.4)).toEqual({ lat: 10, lon: 20 });
    const north = localToLatLon(0, 100, 0, 0, 1737.4);
    expect(north.lat).toBeCloseTo(100 / 1737.4 * 180 / Math.PI, 6);
    const p = lonLatToPixel(0, 0, 1);
    expect([p.x, p.y]).toEqual([256, 256]);
  });

  it('reads the Bright Star Catalogue fixed columns', () => {
    const line = '2061 58Alp OriBD+07 1055  39801113271 224I   4506  Alp Ori  054945.4+072319055510.3+072425199.79-08.96 0.50  +1.85 +2.06 +1.28   M1-2Ia-Iab        e+0.026+0.009 +.005+021SB         9.9 174.4AE   6*';
    const s = parseBscLine(line);
    expect(s.hr).toBe(2061);
    expect(s.ra).toBeCloseTo((5 + 55 / 60 + 10.3 / 3600) * 15, 6);
    expect(s.dec).toBeCloseTo(7 + 24 / 60 + 25 / 3600, 6);
    expect(s.mag).toBe(0.5);
    expect(parseBscLine('short')).toBe(null);
  });
});

describe('shipped places', () => {
  it('lists real files with the right sizes, all small enough', () => {
    let total = 0;
    for (const body of PLACE_BODIES) {
      expect(manifest[body].length).toBeGreaterThanOrEqual(4);
      for (const e of manifest[body]) {
        expect(e.id).toMatch(PLACE_ID_RE);
        expect(e.id.startsWith(body + '-')).toBe(true);
        expect(e.file).toBe(`${e.id}.png`);
        const stat = fs.statSync(path.join(DIR, e.file));
        expect(stat.size).toBe(e.bytes);
        expect(e.maxM).toBeGreaterThan(e.minM);
        expect(e.rawMinM).toBeLessThanOrEqual(Math.round(e.minM) + 1);
        expect(e.rawMaxM).toBeGreaterThanOrEqual(Math.round(e.maxM) - 1);
        expect(Math.abs(e.lat)).toBeLessThanOrEqual(90);
        expect(manifest.sources[e.source]).toBeTruthy();
        expect(e.fact).not.toMatch(/\u2014/);
      }
    }
    expect(manifest.earth.length).toBeGreaterThanOrEqual(10);
    const stars = JSON.parse(fs.readFileSync(path.join(DIR, manifest.sky.file), 'utf8'));
    expect(stars.stars.length).toBe(manifest.sky.count);
    expect(fs.statSync(path.join(DIR, manifest.sky.file)).size).toBe(manifest.sky.bytes);
    expect(manifest.sky.views.map(v => v.id)).toEqual(expect.arrayContaining(['sky-orion', 'sky-ursa-major', 'sky-cassiopeia', 'sky-scorpius', 'sky-southern-cross', 'sky-whole-sky']));
    for (const f of fs.readdirSync(DIR)) total += fs.statSync(path.join(DIR, f)).size;
    expect(total).toBeLessThan(2.5 * 1024 * 1024);
  });

  it('every PNG is 256 x 256 16-bit grey spanning the full range', () => {
    const e = manifest.earth[0];
    const d = decodePng(fs.readFileSync(path.join(DIR, e.file)));
    expect([d.width, d.height, d.bitDepth, d.colorType]).toEqual([256, 256, 16, 0]);
    let lo = 65535, hi = 0;
    for (let i = 0; i < d.data.length; i += 2) { const v = (d.data[i] << 8) | d.data[i + 1]; lo = Math.min(lo, v); hi = Math.max(hi, v); }
    expect([lo, hi]).toEqual([0, 65535]);
  });

  it('loads a place as an imported terrain that survives saving', async () => {
    _resetPlaces();
    const places = await loadPlaces({ fetchFn: fakeFetch, base: 'http://x/' });
    const moon = places.moon.find(p => p.id === 'moon-tycho');
    const ut = await placeTerrain(moon, { fetchFn: fakeFetch, base: 'http://x/' });
    expect([ut.w, ut.h, ut.kind, ut.placeId, ut.name]).toEqual([256, 256, 'image', 'moon-tycho', 'Tycho']);
    const saved = sanitizeUserTerrain(JSON.parse(JSON.stringify(ut)));
    expect(saved.placeId).toBe('moon-tycho');
    expect(saved.data).toBe(ut.data); expect(saved.lo).toBe(ut.lo);
    const st = defaultState();
    st.parts[0].userTerrain = { A: ut, B: null };
    const back = migrateState(JSON.parse(JSON.stringify(migrateState(st))));
    expect(back.parts[0].userTerrain.A.placeId).toBe('moon-tycho');
    expect(back.parts[0].userTerrain.A.data).toBe(ut.data);
    expect(sanitizeUserTerrain({ ...ut, placeId: 'venus-x' }).placeId).toBeUndefined();
  });

  it('gives facts from the data and a readable error offline', async () => {
    const e = manifest.earth.find(p => p.id === 'earth-everest');
    expect(placeFacts(e)[0]).toBe(`Elevation in this view: ${formatMetres(e.rawMinM)} to ${formatMetres(e.rawMaxM)}`);
    expect(formatMetres(-10902)).toBe('−10,902 m');
    _resetPlaces();
    await expect(loadPlaces({ fetchFn: async () => { throw new TypeError('offline'); }, base: 'http://x/' })).rejects.toThrow(/could not be loaded/);
    await expect(placeTerrain(e, { fetchFn: async () => ({ ok: false, status: 404 }), base: 'http://x/' })).rejects.toThrow(/Mount Everest could not be loaded/);
  });
});
