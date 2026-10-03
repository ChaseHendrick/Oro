// Live weather (2.10, opt-in, off by default). Open-Meteo's free API is
// called from the person's own browser: the city search sends the typed
// name to the geocoding API, the forecast request sends only the chosen
// coordinates (rounded to 2 decimals, about 1 km). Nothing else leaves the
// computer. The chosen place lives in this computer's local storage, never
// in the session, so a shared song does not carry anyone's location.
//
// Readings become four global Link sources (see src/dsp/weather-sources.js):
//   Weather Wind   0..1  wind speed at 10 m, 0 to 60 km/h
//   Weather Rain   0..1  precipitation, square root of 0 to 10 mm
//   Weather Temp  -1..1  temperature, -20 to 40 C (10 C is 0)
//   Weather Clouds 0..1  cloud cover, 0 to 100 %

export const WEATHER_INTERVAL_MS = 10 * 60 * 1000;
export const WEATHER_KEY = 'oro.weather.v1';
export const WEATHER_ATTRIBUTION = 'Weather data by Open-Meteo.com';
export const WEATHER_LINK = 'https://open-meteo.com/';
const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = 15000;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Open-Meteo `current` block -> [wind, rain, temp, clouds] Link source values. */
export function mapWeather(current) {
  const c = current && typeof current === 'object' ? current : {};
  const wind = num(c.wind_speed_10m), rain = num(c.precipitation), temp = num(c.temperature_2m), cloud = num(c.cloud_cover);
  return [
    wind == null ? 0 : clamp(wind / 60, 0, 1),
    rain == null ? 0 : clamp(Math.sqrt(Math.max(0, rain) / 10), 0, 1),
    temp == null ? 0 : clamp((temp - 10) / 30, -1, 1),
    cloud == null ? 0 : clamp(cloud / 100, 0, 1),
  ];
}

/** A checked place: { name, country, admin1, lat, lon } or null. */
export function sanitizePlace(p) {
  if (!p || typeof p !== 'object') return null;
  const lat = Number(p.lat ?? p.latitude), lon = Number(p.lon ?? p.longitude);
  if (!(Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  const text = (v) => (typeof v === 'string' ? v.slice(0, 80) : '');
  return { name: text(p.name) || 'Chosen place', country: text(p.country), admin1: text(p.admin1), lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
}

export function placeLabel(p) {
  return [p.name, p.admin1 && p.admin1 !== p.name ? p.admin1 : '', p.country].filter(Boolean).join(', ');
}

async function getJson(fetchFn, url) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
  try {
    const res = await fetchFn(url, ctrl ? { signal: ctrl.signal } : undefined);
    if (!res || !res.ok) throw new Error(`The weather service answered ${res ? res.status : 'nothing'}`);
    return await res.json();
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('The weather service did not answer in time');
    if (err instanceof TypeError) throw new Error('No connection to the weather service');
    throw err;
  } finally { if (timer) clearTimeout(timer); }
}

export function geocodeUrl(name) {
  return `${GEO}?name=${encodeURIComponent(String(name).trim().slice(0, 80))}&count=5&language=en&format=json`;
}

export function forecastUrl(place) {
  return `${FORECAST}?latitude=${place.lat.toFixed(2)}&longitude=${place.lon.toFixed(2)}&current=temperature_2m,wind_speed_10m,precipitation,cloud_cover`;
}

/** Up to 5 matching places for a typed city name. */
export async function searchPlaces(name, { fetchFn = globalThis.fetch } = {}) {
  if (!String(name || '').trim()) return [];
  const json = await getJson(fetchFn, geocodeUrl(name));
  return (Array.isArray(json?.results) ? json.results : []).map(sanitizePlace).filter(Boolean).slice(0, 5);
}

/** Current readings at a place: { values, current: { temperature, wind, precipitation, cloud }, time }. */
export async function fetchWeather(place, { fetchFn = globalThis.fetch } = {}) {
  const json = await getJson(fetchFn, forecastUrl(place));
  const c = json?.current;
  if (!c || typeof c !== 'object') throw new Error('The weather service sent no current readings');
  return {
    values: mapWeather(c),
    current: { temperature: num(c.temperature_2m), wind: num(c.wind_speed_10m), precipitation: num(c.precipitation), cloud: num(c.cloud_cover) },
    time: typeof c.time === 'string' ? c.time.slice(0, 20) : '',
  };
}

export function loadWeatherPrefs(storage = globalThis.localStorage) {
  try {
    const v = JSON.parse(storage?.getItem(WEATHER_KEY) || 'null');
    return { on: !!v?.on, place: sanitizePlace(v?.place) };
  } catch { return { on: false, place: null }; }
}

export function saveWeatherPrefs(prefs, storage = globalThis.localStorage) {
  try { storage?.setItem(WEATHER_KEY, JSON.stringify({ on: !!prefs.on, place: sanitizePlace(prefs.place) })); } catch { /* storage blocked */ }
}

/**
 * Polls the weather for one place while on. onReading({ values, current, time, first })
 * and onStatus({ status: 'off'|'loading'|'ok'|'error', message }).
 */
export function createWeatherPoller({ fetchFn = globalThis.fetch, timers = globalThis, interval = WEATHER_INTERVAL_MS, onReading = () => {}, onStatus = () => {} } = {}) {
  let place = null, timer = null, gen = 0, readings = 0, last = null;
  const state = { status: 'off', message: '' };
  const status = (s, message = '') => { state.status = s; state.message = message; onStatus({ ...state }); };

  async function poll() {
    const g = gen;
    if (!place) return;
    if (!last) status('loading');
    try {
      const r = await fetchWeather(place, { fetchFn });
      if (g !== gen) return;
      last = r;
      onReading({ ...r, first: readings++ === 0 });
      status('ok');
    } catch (err) {
      if (g !== gen) return;
      // Keep the last readings (the sources hold still) and try again next time.
      status('error', err?.message || 'The weather could not be loaded');
    }
  }

  return {
    state,
    get place() { return place; },
    get last() { return last; },
    start(p) {
      const sp = sanitizePlace(p);
      if (!sp) return false;
      this.stop();
      place = sp; gen++; readings = 0; last = null;
      timer = timers.setInterval(poll, interval);
      poll();
      return true;
    },
    refresh() { return poll(); },
    stop() {
      gen++;
      if (timer != null) timers.clearInterval(timer);
      timer = null; place = null; last = null;
      if (state.status !== 'off') status('off');
    },
  };
}
