// Real places (2.10): Earth, Moon, Mars and the night sky as terrains.
// Opened from the terrain slot's "Real places" button (and the image
// library). Data is fetched only when this opens, and a place only when it
// is chosen; it then becomes the slot's imported terrain.

import { h, setText } from './dom.js';
import { openPopover } from './layers.js';
import { addUserTerrain } from '../audio/importers.js';
import { loadPlaces, placeTerrain, placeFacts, PLACE_CREDITS } from '../audio/places.js';
import { skyTerrain } from '../audio/sky.js';
import { found } from '../core/fun.js';

const TABS = [
  { id: 'earth', label: 'Earth', credit: 'terrarium' },
  { id: 'moon', label: 'Moon', credit: 'lola' },
  { id: 'mars', label: 'Mars', credit: 'mola' },
  { id: 'sky', label: 'Night sky', credit: 'bsc5' },
];
const TERRARIUM_DOCS = 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md';
let lastTab = 'earth';

function skyFacts(v) {
  const lines = [`${v.stars} stars to magnitude 5.5. Brighter stars are higher peaks.`, `Brightest: ${v.brightest} (HR ${v.brightestHr}, magnitude ${v.brightestMag})`];
  lines.push(v.whole ? 'The whole sky, right ascension across and declination down' : `Centred on right ascension ${(v.raDeg / 15).toFixed(1)} h, declination ${v.decDeg}°, ${v.widthDeg}° across`);
  return lines;
}

export function openRealPlaces(ctx, anchor, slot) {
  const part = ctx.binder.selected();
  let tab = lastTab, data = null, busy = false, pop;
  const tablist = h('div', { class: 'tabs places-tabs', role: 'tablist', 'aria-label': 'Where' });
  const tabBtns = TABS.map(t => {
    const b = h('button', { type: 'button', class: 'tab-btn', role: 'tab', id: `places-tab-${t.id}`, 'aria-controls': 'places-panel' }, t.label);
    b.addEventListener('click', () => { tab = lastTab = t.id; render(); });
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const i = (TABS.findIndex(x => x.id === tab) + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
      tab = lastTab = TABS[i].id; render(); tabBtns[i].focus();
    });
    tablist.appendChild(b);
    return b;
  });
  const list = h('div', { class: 'places-list', role: 'tabpanel', id: 'places-panel' });
  const detail = h('div', { class: 'places-detail', 'aria-live': 'polite' }, 'Loading the list of places…');
  const credit = h('p', { class: 'places-credit' });
  const body = h('div', { class: 'places-pop' },
    h('div', { class: 'popover-title' }, `Real places for terrain ${slot}`),
    h('p', { class: 'popover-note' }, 'Real elevation data from Earth, the Moon and Mars, and real stars. Choose one to load it.'),
    tablist, list, detail, credit);

  function showDetail(entry) {
    const lines = tab === 'sky' ? skyFacts(entry) : placeFacts(entry);
    detail.replaceChildren(h('strong', null, entry.name), entry.fact ? h('span', null, entry.fact) : null, h('ul', null, lines.map(l => h('li', null, l))));
  }

  function renderCredit(t) {
    const src = data?.sources?.[t.credit === 'bsc5' ? 'bsc5' : t.credit];
    const parts = [PLACE_CREDITS[t.credit] + ' '];
    if (t.credit === 'terrarium') parts.push(h('a', { href: TERRARIUM_DOCS, target: '_blank', rel: 'noopener noreferrer' }, 'Full attribution'), '.');
    else if (src?.url) parts.push(h('a', { href: src.url.replace(/\/[^/]*$/, '/'), target: '_blank', rel: 'noopener noreferrer' }, 'Source'), '.');
    credit.replaceChildren(...parts);
  }

  async function choose(entry, button) {
    if (busy) return;
    busy = true; button.disabled = true; setText(detail, `Loading ${entry.name}…`);
    try {
      const ut = tab === 'sky' ? await skyTerrain(entry) : await placeTerrain(entry);
      await addUserTerrain(ctx.store, part, slot, ut, { source: 'ui' });
      found('badge', tab === 'sky' ? 'night-sky' : `place-${tab}`);
      ctx.toast(`Loaded ${entry.name} into terrain ${slot}`, { kind: 'success' });
      pop.close('select');
    } catch (err) {
      setText(detail, err.message || 'That place could not be loaded.');
      button.disabled = false;
    } finally { busy = false; }
  }

  function render() {
    const t = TABS.find(x => x.id === tab) || TABS[0];
    tabBtns.forEach((b, i) => { const on = TABS[i].id === tab; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
    list.setAttribute('aria-labelledby', `places-tab-${tab}`);
    renderCredit(t);
    if (!data) return;
    const entries = tab === 'sky' ? (data.sky?.views || []) : data[tab] || [];
    const current = ctx.store.get(`parts.${part}.userTerrain.${slot}`)?.placeId;
    list.replaceChildren(...entries.map(entry => {
      const sub = tab === 'sky' ? `${entry.stars} stars` : `${entry.widthKm} km across`;
      const b = h('button', { type: 'button', class: ['places-item', entry.id === current && 'is-current'], 'aria-pressed': String(entry.id === current) }, entry.name, h('small', null, sub));
      b.addEventListener('click', () => choose(entry, b));
      b.addEventListener('focus', () => showDetail(entry));
      b.addEventListener('pointerenter', () => showDetail(entry));
      return b;
    }));
    if (!entries.length) setText(detail, 'Nothing here yet.');
    else showDetail(entries.find(e => e.id === current) || entries[0]);
    pop?.reposition();
  }

  pop = openPopover(ctx.layers, anchor, body, { className: 'popover--places', label: `Real places for terrain ${slot}`, placement: 'bottom-start' });
  render();
  loadPlaces().then((d) => { data = d; if (pop.isOpen()) render(); }).catch((err) => setText(detail, err.message));
  return pop;
}
