// v2.10 Night sky projection, live weather (mocked fetch) and Sonify your data.
import { describe, it, expect, vi } from 'vitest';
import { starPeak, projectStar, skyHeights } from '../../src/audio/sky.js';
import { mapWeather, searchPlaces, fetchWeather, createWeatherPoller, sanitizePlace, loadWeatherPrefs, saveWeatherPrefs, geocodeUrl } from '../../src/core/weather.js';
import { WeatherBank, WEATHER_GLIDE } from '../../src/dsp/weather-sources.js';
import { parseData, seriesTerrain, gridTerrain, melodySteps, writeMelody, resample1D, seriesStats, DATA_MAX_ROWS } from '../../src/music/data-sonify.js';
import { LINK_SOURCES, defaultState, SCALES, SCALE_NAMES, stepToMidi, activeSeq } from '../../src/core/params.js';
import { createStore } from '../../src/core/store.js';
import { createHistory } from '../../src/core/history.js';
import { makeDSP, render } from '../dsp/helpers.js';

describe('night sky', () => {
  it('a brighter star is a higher peak', () => {
    expect(starPeak(-1.46)).toBeGreaterThan(starPeak(0.5));
    expect(starPeak(0.5)).toBeGreaterThan(starPeak(5.5));
    const view = { raDeg: 90, decDeg: 0, widthDeg: 40 };
    const { heights, used } = skyHeights([[85, 0, 4.5], [95, 0, 0.5]], view, 128);
    expect(used).toBe(2);
    const peak = (ra) => { const p = projectStar(view, ra, 0), x = Math.round(p.x * 128 - 0.5), y = Math.round(p.y * 128 - 0.5); return heights[y * 128 + x]; };
    expect(peak(95)).toBeGreaterThan(peak(85));
    expect(Math.max(...heights)).toBeLessThanOrEqual(starPeak(0.5));
    expect(peak(95)).toBeGreaterThan(0.85 * starPeak(0.5));
  });

  it('projects north up and east to the left, like a star chart', () => {
    const v = { raDeg: 100, decDeg: 20, widthDeg: 30 };
    expect(projectStar(v, 100, 20)).toEqual({ x: 0.5, y: 0.5 });
    expect(projectStar(v, 105, 20).x).toBeLessThan(0.5);
    expect(projectStar(v, 100, 25).y).toBeLessThan(0.5);
    expect(projectStar(v, 280, -20)).toBe(null);
    expect(projectStar({ whole: true }, 0, 90)).toEqual({ x: 1, y: 0 });
  });
});

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

describe('live weather', () => {
  it('maps readings to link source ranges', () => {
    expect(mapWeather({ wind_speed_10m: 30, precipitation: 2.5, temperature_2m: 25, cloud_cover: 50 })).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(mapWeather({ wind_speed_10m: 200, precipitation: 99, temperature_2m: -60, cloud_cover: 140 })).toEqual([1, 1, -1, 1]);
    expect(mapWeather(null)).toEqual([0, 0, 0, 0]);
    expect(LINK_SOURCES.slice(-4)).toEqual(['Weather Wind', 'Weather Rain', 'Weather Temp', 'Weather Clouds']);
    expect(LINK_SOURCES.indexOf('Function')).toBe(30);
    expect(LINK_SOURCES.indexOf('Weather Wind')).toBe(31);
  });

  it('searches by name and sends only rounded coordinates for the weather', async () => {
    const urls = [];
    const fetchFn = vi.fn(async (url) => {
      urls.push(url);
      if (url.includes('geocoding')) return okJson({ results: [{ name: 'Oslo', country: 'Norway', admin1: 'Oslo', latitude: 59.91273, longitude: 10.74609, population: 1 }, { name: 'Bad', latitude: 'x' }] });
      return okJson({ current: { time: '2026-10-03T12:00', temperature_2m: 10, wind_speed_10m: 12, precipitation: 0, cloud_cover: 75 } });
    });
    const found = await searchPlaces('Oslo', { fetchFn });
    expect(found).toEqual([{ name: 'Oslo', country: 'Norway', admin1: 'Oslo', lat: 59.91, lon: 10.75 }]);
    expect(geocodeUrl('São Paulo')).toContain('name=S%C3%A3o%20Paulo');
    const r = await fetchWeather(found[0], { fetchFn });
    expect(r.values).toEqual([0.2, 0, 0, 0.75]);
    const q = new URL(urls[1]);
    expect([...q.searchParams.keys()]).toEqual(['latitude', 'longitude', 'current']);
    expect(q.searchParams.get('latitude')).toBe('59.91');
  });

  it('polls, reports errors gracefully and stops', async () => {
    let fail = false, intervalFn = null;
    const fetchFn = async () => { if (fail) throw new TypeError('Failed to fetch'); return okJson({ current: { wind_speed_10m: 60 } }); };
    const timers = { setInterval: (fn) => { intervalFn = fn; return 1; }, clearInterval: vi.fn() };
    const readings = [], statuses = [];
    const p = createWeatherPoller({ fetchFn, timers, onReading: r => readings.push(r), onStatus: s => statuses.push(s) });
    p.start({ name: 'X', lat: 1, lon: 2 });
    await vi.waitFor(() => expect(readings.length).toBe(1));
    expect(readings[0].values[0]).toBe(1);
    expect(readings[0].first).toBe(true);
    fail = true;
    await intervalFn();
    expect(p.state).toMatchObject({ status: 'error', message: 'No connection to the weather service' });
    expect(p.last.values[0]).toBe(1);
    const bad = createWeatherPoller({ fetchFn: async () => ({ ok: false, status: 503 }), timers, onStatus: s => statuses.push(s) });
    bad.start({ lat: 0, lon: 0 });
    await vi.waitFor(() => expect(bad.state.status).toBe('error'));
    expect(bad.state.message).toMatch(/503/);
    p.stop();
    expect(p.state.status).toBe('off');
    expect(timers.clearInterval).toHaveBeenCalled();
    expect(p.start({ lat: 100, lon: 0 })).toBe(false);
  });

  it('keeps the chosen place on this computer only', () => {
    const mem = new Map(), storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
    expect(loadWeatherPrefs(storage)).toEqual({ on: false, place: null });
    saveWeatherPrefs({ on: true, place: { name: 'Oslo', lat: 59.912, lon: 10.746 } }, storage);
    expect(loadWeatherPrefs(storage)).toEqual({ on: true, place: sanitizePlace({ name: 'Oslo', lat: 59.91, lon: 10.75 }) });
    expect(JSON.stringify(defaultState())).not.toMatch(/weather/i);
    expect(loadWeatherPrefs({ getItem: () => '{bad' })).toEqual({ on: false, place: null });
  });

  it('glides to new readings over 30 seconds', () => {
    const b = new WeatherBank();
    b.step(1);
    expect(Array.from(b.out)).toEqual([0, 0, 0, 0]);
    b.set([1, 0.5, -1, 0]);
    b.step(WEATHER_GLIDE / 2);
    expect(b.out[0]).toBeCloseTo(0.5, 5); expect(b.out[2]).toBeCloseTo(-0.5, 5);
    b.step(WEATHER_GLIDE / 2 + 0.01);
    expect(Array.from(b.out)).toEqual([1, 0.5, -1, 0]);
    expect(b.active).toBe(false);
    b.set([0, 0, 0, 0], true);
    expect(Array.from(b.out)).toEqual([0, 0, 0, 0]);
    b.set([NaN, 9, -9, 0.2]);
    expect(Array.from(b.target).map(v => Math.round(v * 10) / 10)).toEqual([0, 1, -1, 0.2]);
  });

  it('a weather link is silent until weather arrives, then moves the sound', () => {
    const link = [{ src: LINK_SOURCES.indexOf('Weather Wind'), dst: 'size', amt: 0.9, curve: 0 }];
    const play = (links, weather) => {
      const dsp = makeDSP({ params: {} });
      if (links) dsp.handleMessage({ t: 'links', part: 0, links });
      if (weather) dsp.handleMessage({ t: 'weather', v: weather, snap: true });
      return render(dsp, 0.3, (d, t, k) => { if (k === 0) d.handleMessage({ t: 'noteOn', part: 0, note: 57, vel: 1, time: 0 }); }).L;
    };
    const plain = play(null), idle = play(link), windy = play(link, [1, 0, 0, 0]);
    expect(Array.from(idle)).toEqual(Array.from(plain));
    let diff = 0;
    for (let i = 0; i < plain.length; i++) diff += Math.abs(plain[i] - windy[i]);
    expect(diff).toBeGreaterThan(1);
  });
});

describe('sonify your data', () => {
  it('parses one column, one line, CSV with a header and decimal commas', () => {
    expect(parseData('3\n7.5\n\n# note\n-2e1').columns[0].values).toEqual([3, 7.5, -20]);
    expect(parseData('1, 2, 3, 4').columns[0].values).toEqual([1, 2, 3, 4]);
    const csv = parseData('date,temp,"rain mm"\n2024-01-01,3.5,0\n2024-01-02,4,1.25\n2024-01-03,x,2');
    expect(csv.columns.map(c => c.name)).toEqual(['temp', 'rain mm']);
    expect(csv.columns[0].values).toEqual([3.5, 4]);
    expect(csv.rows).toBe(3);
    expect(parseData('a;b\n1,5;2\n3,25;4').columns[0].values).toEqual([1.5, 3.25]);
    expect(parseData('x\ty\n1\t2\n3\t4').columns.length).toBe(2);
  });

  it('refuses bad input with a reason and caps the size', () => {
    expect(parseData('').error).toMatch(/Paste/);
    expect(parseData('hello\nworld').error).toMatch(/No numbers/);
    expect(parseData('5').error).toMatch(/No numbers/);
    expect(parseData('1\n'.repeat(1_100_000)).error).toMatch(/million/);
    const big = parseData(Array.from({ length: DATA_MAX_ROWS + 5 }, (_, i) => i).join('\n'));
    expect(big.truncated).toBe(5);
    expect(big.columns[0].values.length).toBe(DATA_MAX_ROWS);
    expect(seriesStats([4, -1, 9])).toEqual({ min: -1, max: 9, count: 3 });
  });

  it('makes a ridge (smoother towards the back) and a grid terrain', () => {
    const n = 64, t = seriesTerrain([0, 10, 0, 10, 0, 10, 0, 10], n);
    expect(t.length).toBe(n * n);
    const range = (y) => { let lo = 1, hi = 0; for (let x = 0; x < n; x++) { lo = Math.min(lo, t[y * n + x]); hi = Math.max(hi, t[y * n + x]); } return hi - lo; };
    expect(range(0)).toBeCloseTo(1, 5);
    expect(range(n - 1)).toBeLessThan(range(0) * 0.5);
    const g = gridTerrain([{ values: [0, 1] }, { values: [5, 5, 5] }, { values: [1, 0] }], 16);
    expect(g[0]).toBe(0); expect(g[15]).toBe(1);
    expect(Array.from(resample1D([0, 10], 3))).toEqual([0, 5, 10]);
    expect(Array.from(resample1D([1, 3, 5, 7], 2))).toEqual([2, 6]);
  });

  it('turns a series into notes of the current scale, in one undo step', () => {
    const steps = melodySteps([0, 1, 2, 3, 4, 5, 6, 7], { length: 8, scaleLen: 5 });
    expect(steps.length).toBe(16);
    expect(steps.slice(0, 8).every(s => s.on === 1)).toBe(true);
    expect(steps[8].on).toBe(0);
    expect(steps[0].degree).toBe(0); expect(steps[7].degree).toBe(10);
    for (let i = 1; i < 8; i++) expect(steps[i].degree).toBeGreaterThanOrEqual(steps[i - 1].degree);

    const store = createStore(defaultState());
    store.set('global.scaleType', SCALE_NAMES.indexOf('Pent Min'));
    const timers = { setTimeout: () => 0, clearTimeout: () => {} };
    const history = createHistory(store, { timers });
    const before = JSON.stringify(activeSeq(store.get('parts.0')).steps);
    writeMelody(store, 0, [5, 1, 9, 3, 7]);
    history.flush();
    const seq = activeSeq(store.get('parts.0'));
    const root = store.get('global.root') ?? 0;
    const pent = SCALES['Pent Min'];
    for (const s of seq.steps.slice(0, seq.length)) {
      expect(s.on).toBe(1);
      expect(pent).toContain(((stepToMidi(s, seq.baseOctave, root, store.get('global.scaleType')) - root) % 12 + 12) % 12);
    }
    expect(store.get('parts.0.seqOn')).toBe(1);
    history.undo();
    expect(JSON.stringify(activeSeq(store.get('parts.0')).steps)).toBe(before);
    expect(writeMelody(store, 99, [1, 2])).toBe(null);
  });
});
