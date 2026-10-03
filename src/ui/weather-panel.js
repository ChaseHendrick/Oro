// Live weather (2.10): opt-in, off by default. One poller for the whole app
// (started at launch only if the person turned it on before); the panel in
// Links shows it. The chosen place is kept in this computer's local storage
// (src/core/weather.js), not in the session.

import { h, setText } from './dom.js';
import { openPopover } from './layers.js';
import {
  createWeatherPoller, searchPlaces, loadWeatherPrefs, saveWeatherPrefs, placeLabel,
  WEATHER_ATTRIBUTION, WEATHER_LINK,
} from '../core/weather.js';
import { found } from '../core/fun.js';

let poller = null, engine = null, latest = null;
const subs = new Set();
const notify = () => { for (const fn of subs) { try { fn(); } catch { /* ignore */ } } };

/** Create the app's weather poller; resumes polling if it was left on. Safe to call more than once. */
export function initWeather(ctx) {
  engine = ctx?.engine || engine;
  if (poller) return poller;
  poller = createWeatherPoller({
    onReading: (r) => { latest = r; engine?.setWeather?.(r.values); found('badge', 'weather'); notify(); },
    onStatus: notify,
  });
  const prefs = loadWeatherPrefs();
  if (prefs.on && prefs.place) poller.start(prefs.place);
  return poller;
}

const show = (v, unit, digits = 1) => (v == null ? 'not reported' : `${v.toFixed(digits)} ${unit}`);

export function openWeatherPanel(ctx, anchor) {
  initWeather(ctx);
  let prefs = loadWeatherPrefs(), pop;
  const onBox = h('input', { type: 'checkbox', id: 'weather-on' });
  const city = h('input', { type: 'search', class: 'field', placeholder: 'City or town', 'aria-label': 'Search for a city', maxlength: '80' });
  const searchBtn = h('button', { type: 'button', class: 'btn btn--sm' }, 'Search');
  const results = h('div', { class: 'weather-results', 'aria-live': 'polite' });
  const where = h('p', { class: 'popover-note' });
  const status = h('p', { class: 'popover-note weather-status', 'aria-live': 'polite' });
  const values = h('dl', { class: 'weather-values' });
  const body = h('div', { class: 'places-pop' },
    h('div', { class: 'popover-title' }, 'Live weather'),
    h('p', { class: 'popover-note' }, 'Off by default. When on, Oro asks Open-Meteo for the current weather at your chosen place every 10 minutes, sending only its coordinates. The place is kept on this computer, not in your session.'),
    h('label', { class: 'data-row', for: 'weather-on' }, onBox, h('span', null, 'Use live weather')),
    h('div', { class: 'data-row' }, city, searchBtn), results, where, values, status,
    h('p', { class: 'places-credit' }, 'In Links, choose Weather Wind, Weather Rain, Weather Temp or Weather Clouds as a source. Changes glide over 30 seconds.'),
    h('p', { class: 'places-credit' }, h('a', { href: WEATHER_LINK, target: '_blank', rel: 'noopener noreferrer' }, WEATHER_ATTRIBUTION), ' (CC BY 4.0, free for non-commercial use).'));

  function render() {
    onBox.checked = !!prefs.on;
    setText(where, prefs.place ? `Place: ${placeLabel(prefs.place)} (${prefs.place.lat}, ${prefs.place.lon})` : 'No place chosen yet. Search for a city.');
    const st = poller.state;
    status.dataset.kind = st.status;
    setText(status, !prefs.on ? 'Live weather is off.' : st.status === 'loading' ? 'Getting the weather…'
      : st.status === 'error' ? `${st.message}. Oro will try again in 10 minutes; the sources keep their last values.`
        : st.status === 'ok' ? `Updated${latest?.time ? ` (${latest.time.replace('T', ' ')} local time)` : ''}.` : '');
    const c = prefs.on && latest ? latest.current : null;
    values.hidden = !c;
    if (c) {
      values.replaceChildren(
        h('dt', null, 'Wind'), h('dd', null, show(c.wind, 'km/h')),
        h('dt', null, 'Rain'), h('dd', null, show(c.precipitation, 'mm')),
        h('dt', null, 'Temperature'), h('dd', null, show(c.temperature, '°C')),
        h('dt', null, 'Clouds'), h('dd', null, show(c.cloud, '%', 0)));
    }
    pop?.reposition();
  }

  function apply() {
    saveWeatherPrefs(prefs);
    if (prefs.on && prefs.place) {
      if (poller.place?.lat !== prefs.place.lat || poller.place?.lon !== prefs.place.lon || poller.state.status === 'off') { latest = null; poller.start(prefs.place); }
    } else if (poller.state.status !== 'off' || poller.place) {
      poller.stop(); latest = null;
      engine?.setWeather?.([0, 0, 0, 0]);
    }
    render();
  }

  async function search() {
    const q = city.value.trim();
    if (!q) return;
    searchBtn.disabled = true;
    setText(results, 'Searching…');
    try {
      const list = await searchPlaces(q);
      if (!list.length) { setText(results, 'No places found with that name.'); return; }
      results.replaceChildren(...list.map(p => {
        const b = h('button', { type: 'button', class: 'places-item' }, p.name, h('small', null, [p.admin1, p.country].filter(Boolean).join(', ')));
        b.addEventListener('click', () => { prefs = { ...prefs, place: p, on: true }; results.replaceChildren(); apply(); });
        return b;
      }));
    } catch (err) {
      setText(results, `${err.message || 'The search failed'}. Check your connection and try again.`);
    } finally { searchBtn.disabled = false; pop?.reposition(); }
  }

  onBox.addEventListener('change', () => { prefs = { ...prefs, on: onBox.checked }; if (onBox.checked && !prefs.place) city.focus(); apply(); });
  searchBtn.addEventListener('click', search);
  city.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
  subs.add(render);
  pop = openPopover(ctx.layers, anchor, body, { className: 'popover--places', label: 'Live weather', placement: 'bottom-start', onClose: () => subs.delete(render) });
  render();
  return pop;
}
