// Sound map (v2.8): every drum library sound, plus the samples on the
// session's pads, as dots on a map where sounds that sound alike sit close
// together (src/dsp/sound-map.js). Hover or arrow keys audition, click or
// Enter puts the sound on the chosen pad, Similar swaps the pad for a close
// neighbour and Shuffle kit picks a matching kit for all eight pads.
import { h, createScope, setText, uniqueId, pixelRatioOf } from './dom.js';
import { openModal } from './modal.js';
import { ensureContrast } from './color.js';
import { sanitizeDrum, base64ToPcm, KIT_PADS, SYNTH_DRUMS } from '../dsp/drum-kit.js';
import { DRUM_CATEGORIES, libraryInfo, libraryPcm, LIBRARY_PCM_RATE } from '../dsp/drum-library.js';
import { libraryMapAsync, buildSoundMap, nearestInDirection, similarTo, shuffleKit, SAMPLE_CAT } from '../dsp/sound-map.js';

// Kick, Snare, Hat, Open hat, Clap, Tom, Rim, Perc, Sample (squares); toned per theme for 3:1 contrast
const CAT_COLORS = ['#ff8a3d', '#5aa9ff', '#ffd23f', '#7ddf64', '#ff4d6a', '#b98cff', '#4dd2ff', '#e86bf0', '#c8b08a'];
const CAT_NAMES = [...DRUM_CATEGORIES, 'Sample'];
const MARGIN = 14;
const pcmCache = new Map();
let shuffleSeed = 1 + Math.floor(Math.random() * 9000);

function pcmOf(data) {
  let pcm = pcmCache.get(data);
  if (!pcm) { pcm = base64ToPcm(data); if (pcmCache.size > 32) pcmCache.clear(); pcmCache.set(data, pcm); }
  return pcm;
}

/** Samples on any track's pads, for the map. */
function sessionSamples(store) {
  const out = [];
  for (const p of store.get('parts') || []) {
    if (!p || !p.drum) continue;
    for (const pd of sanitizeDrum(p.drum).pads) if (pd.sample) out.push({ name: pd.name, rate: pd.sample.rate, data: pd.sample.data, pcm: pcmOf(pd.sample.data) });
  }
  return out;
}

/**
 * Open the map for track `part`, aimed at pad `pad`. `onPad(k)` hears about
 * the pad chosen inside the map, so the drum panel can follow it.
 */
export function openSoundMap(ctx, { part, pad = 0, onPad } = {}) {
  const { store } = ctx;
  const scope = createScope();
  const drumNow = () => sanitizeDrum(store.get(`parts.${part}.drum`));
  let points = [], cursor = -1, hover = -1, target = Math.max(0, Math.min(KIT_PADS - 1, pad | 0)), similar = null;
  let lastPlay = 0, playTimer = 0;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  const helpId = uniqueId('smap-help');
  const help = h('p', { class: 'smap-help', id: helpId },
    'Sounds that sound alike sit close together: darker sounds to the left, brighter to the right, longer sounds higher up. ',
    'Hover or use the arrow keys to hear a sound; click it or press Enter to put it on the chosen pad. Space plays the sound again.');
  const padBtns = Array.from({ length: KIT_PADS }, (_, k) => h('button', { type: 'button', class: 'smap-pad', role: 'radio', 'aria-checked': 'false', tabindex: '-1' }));
  const padGroup = h('div', { class: 'smap-pads', role: 'radiogroup', 'aria-label': 'Pad to fill' }, ...padBtns);
  const canvas = h('canvas', { class: 'smap-canvas', tabindex: '0', role: 'application', 'aria-roledescription': 'sound map', 'aria-label': 'Sound map', 'aria-describedby': helpId });
  const stage = h('div', { class: 'smap-stage' }, canvas);
  const info = h('p', { class: 'smap-info', 'aria-live': 'polite' }, 'Measuring the sounds…');
  const swatches = CAT_NAMES.map(() => h('span', { class: 'smap-swatch', 'aria-hidden': 'true' }));
  const legend = h('ul', { class: 'smap-legend', 'aria-label': 'Colours' }, ...CAT_NAMES.map((n, c) => h('li', { class: ['smap-key', c === SAMPLE_CAT && 'is-sample'] }, swatches[c], n)));
  const playBtn = h('button', { type: 'button', class: 'btn btn--sm' }, 'Play');
  const useBtn = h('button', { type: 'button', class: 'btn btn--sm btn--primary' }, 'Use on pad 1');
  const simBtn = h('button', { type: 'button', class: 'btn btn--sm', title: 'Swap the pad for a sound close to it (press again for the next one)' }, 'Similar');
  const shufBtn = h('button', { type: 'button', class: 'btn btn--sm', title: 'Put a matching sound on all eight pads' }, 'Shuffle kit');
  const actions = h('div', { class: 'smap-actions' }, playBtn, useBtn, simBtn, shufBtn);
  for (const b of [playBtn, useBtn, simBtn, shufBtn]) b.disabled = true;

  const content = h('div', { class: 'smap' }, help, padGroup, stage, info, actions, legend);
  const modal = openModal(ctx.layers, ctx.root, { title: 'Sound map', content, className: 'modal--smap', wide: true, initialFocus: canvas, onClose: () => { clearTimeout(playTimer); scope.dispose(); } });

  // ---- helpers
  const padPoint = (k) => {
    const pd = drumNow().pads[k];
    if (!pd) return -1;
    if (pd.sample) return points.findIndex(p => p.sample && p.sample.data === pd.sample.data);
    return points.findIndex(p => p.index === pd.synth);
  };
  const label = (p) => `${p.name}, ${CAT_NAMES[p.cat].toLowerCase()}${p.desc ? ': ' + p.desc : ''}`;
  const say = (text) => setText(info, text);

  function play(i) {
    const p = points[i], eng = ctx.engine;
    if (!p || !eng || typeof eng.previewDrum !== 'function') return;
    const pd = drumNow().pads[target];
    eng.previewDrum(part, p.sample ? { pcm: pcmOf(p.sample.data), rate: p.sample.rate } : p.index >= SYNTH_DRUMS.length && libraryPcm(p.index) ? { pcm: libraryPcm(p.index), rate: LIBRARY_PCM_RATE } : { synth: p.index }, { gain: pd ? pd.level : 0.8, pitch: pd ? pd.pitch : 0 });
    lastPlay = performance.now();
  }
  // hovering plays at most every 70 ms; the latest dot wins
  function playSoon(i) {
    clearTimeout(playTimer);
    const wait = 70 - (performance.now() - lastPlay);
    if (wait <= 0) play(i); else playTimer = setTimeout(() => play(i), wait);
  }

  function assign(i, k = target) {
    const p = points[i];
    if (!p) return;
    const d = drumNow();
    d.pads[k] = { ...d.pads[k], name: p.name.slice(0, 24), synth: p.sample ? -1 : p.index, sample: p.sample ? { rate: p.sample.rate, data: p.sample.data } : null };
    store.set(`parts.${part}.drum`, d, { source: 'ui' });
  }

  function setTarget(k, focus = false) {
    target = k;
    padBtns.forEach((b, j) => { b.setAttribute('aria-checked', String(j === k)); b.tabIndex = j === k ? 0 : -1; b.classList.toggle('is-on', j === k); });
    if (focus) padBtns[k].focus();
    setText(useBtn, `Use on pad ${k + 1}`);
    similar = null;
    if (onPad) onPad(k);
    const i = padPoint(k);
    if (i >= 0) cursor = i;
    draw();
  }

  function refreshPads() {
    const d = drumNow();
    padBtns.forEach((b, k) => { setText(b, `${k + 1} ${d.pads[k].name}`); b.setAttribute('aria-label', `Pad ${k + 1}: ${d.pads[k].name}`); });
  }

  // ---- drawing
  const toPx = (p, W, H) => [MARGIN + p.x * (W - 2 * MARGIN), MARGIN + (1 - p.y) * (H - 2 * MARGIN)];
  let colors = CAT_COLORS;

  function draw() {
    const g = canvas.getContext && canvas.getContext('2d');
    if (!g) return;
    const W = canvas.clientWidth, H = canvas.clientHeight, dpr = pixelRatioOf(3);
    if (!W || !H) return;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
    const cs = getComputedStyle(canvas);
    const v = (n, d) => cs.getPropertyValue(n).trim() || d;
    const bg = v('--panel-3', '#182033');
    colors = CAT_COLORS.map(c => ensureContrast(c, bg, 3));
    colors.forEach((c, i) => { swatches[i].style.background = c; });
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.strokeStyle = v('--border', 'rgba(150,160,200,.15)'); g.lineWidth = 1;
    for (let k = 1; k < 4; k++) {
      const x = Math.round(MARGIN + k * (W - 2 * MARGIN) / 4) + 0.5, y = Math.round(MARGIN + k * (H - 2 * MARGIN) / 4) + 0.5;
      g.beginPath(); g.moveTo(x, MARGIN); g.lineTo(x, H - MARGIN); g.moveTo(MARGIN, y); g.lineTo(W - MARGIN, y); g.stroke();
    }
    const r = coarse ? 5.5 : 4.5;
    points.forEach((p) => {
      const [x, y] = toPx(p, W, H);
      g.fillStyle = colors[p.cat];
      g.beginPath();
      if (p.cat === SAMPLE_CAT) g.rect(x - r, y - r, 2 * r, 2 * r); else g.arc(x, y, r, 0, 2 * Math.PI);
      g.fill();
    });
    const text = v('--text', '#e8ecf6'), text2 = v('--text-2', '#adb6cb');
    g.font = `600 10px ${v('--font-ui', 'system-ui')}`; g.textBaseline = 'middle';
    // the kit: a ring and the pad number on each pad's sound, the chosen pad stronger
    for (let k = 0; k < KIT_PADS; k++) {
      const i = padPoint(k);
      if (i < 0) continue;
      const [x, y] = toPx(points[i], W, H);
      g.strokeStyle = k === target ? v('--part', '#3fd0c9') : text2; g.lineWidth = k === target ? 2.5 : 1.25;
      g.beginPath(); g.arc(x, y, r + (k === target ? 5 : 3), 0, 2 * Math.PI); g.stroke();
      g.fillStyle = text2; g.fillText(String(k + 1), x + r + 6, y - r - 4);
    }
    if (hover >= 0 && points[hover]) {
      const [x, y] = toPx(points[hover], W, H);
      g.strokeStyle = text; g.lineWidth = 1.5;
      g.beginPath(); g.arc(x, y, r + 4, 0, 2 * Math.PI); g.stroke();
    }
    const shown = hover >= 0 ? hover : cursor;
    if (cursor >= 0 && points[cursor]) {
      const [x, y] = toPx(points[cursor], W, H);
      g.strokeStyle = v('--focus', '#a6c5ff'); g.lineWidth = 2; g.setLineDash([3, 2]);
      g.beginPath(); g.arc(x, y, r + 8, 0, 2 * Math.PI); g.stroke(); g.setLineDash([]);
    }
    if (shown >= 0 && points[shown]) {
      const p = points[shown], [x, y] = toPx(p, W, H);
      g.font = `600 12px ${v('--font-ui', 'system-ui')}`;
      const tw = g.measureText(p.name).width + 12;
      const lx = Math.min(W - tw - 4, Math.max(4, x + 12)), ly = Math.max(4, Math.min(H - 24, y - 30));
      g.fillStyle = v('--panel-solid', '#0e1320'); g.strokeStyle = v('--border-strong', '#556'); g.lineWidth = 1;
      g.beginPath(); g.rect(lx, ly, tw, 20); g.fill(); g.stroke();
      g.fillStyle = text; g.fillText(p.name, lx + 6, ly + 10);
    }
  }

  function nearestAt(ev) {
    const rect = canvas.getBoundingClientRect(), W = rect.width, H = rect.height;
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    let best = -1, bd = (coarse || ev.pointerType === 'touch') ? 26 : 16;
    points.forEach((p, i) => { const [x, y] = toPx(p, W, H); const d = Math.hypot(x - mx, y - my); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  // ---- events
  scope.on(canvas, 'pointermove', (ev) => {
    if (!points.length || ev.pointerType === 'touch') return;
    const i = nearestAt(ev);
    if (i === hover) return;
    hover = i;
    if (i >= 0) playSoon(i);
    draw();
  });
  scope.on(canvas, 'pointerleave', () => { if (hover >= 0) { hover = -1; draw(); } });
  scope.on(canvas, 'click', (ev) => {
    const i = nearestAt(ev);
    if (i < 0) return;
    cursor = i; hover = -1;
    assign(i); play(i);
    say(`Pad ${target + 1} is now ${label(points[i])}.`);
    draw();
  });
  const DIRS = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
  scope.on(canvas, 'keydown', (e) => {
    if (!points.length) return;
    if (DIRS[e.key]) {
      e.preventDefault();
      const from = cursor >= 0 ? cursor : 0;
      const next = nearestInDirection(points, from, ...DIRS[e.key]);
      if (next < 0) { say(`No sound further ${e.key.slice(5).toLowerCase()} of ${points[from].name}.`); return; }
      cursor = next; hover = -1; play(next); say(label(points[next]));
      draw();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (cursor < 0) return;
      assign(cursor); play(cursor);
      say(`Pad ${target + 1} is now ${label(points[cursor])}.`);
    } else if (e.key === ' ') {
      e.preventDefault();
      if (cursor >= 0) play(cursor);
    } else if (e.key === 'Home') {
      e.preventDefault();
      const i = padPoint(target);
      if (i >= 0) { cursor = i; play(i); say(label(points[i])); draw(); }
    }
  });
  scope.on(canvas, 'focus', draw);
  scope.on(canvas, 'blur', draw);
  padBtns.forEach((b, k) => scope.on(b, 'click', () => setTarget(k)));
  scope.on(padGroup, 'keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    setTarget((target + step + KIT_PADS) % KIT_PADS, true);
  });
  scope.on(playBtn, 'click', () => { if (cursor >= 0) play(cursor); });
  scope.on(useBtn, 'click', () => {
    if (cursor < 0) return;
    assign(cursor); play(cursor);
    say(`Pad ${target + 1} is now ${label(points[cursor])}.`);
  });
  scope.on(simBtn, 'click', () => {
    const cur = padPoint(target);
    if (cur < 0) { say(`The sound on pad ${target + 1} is not on the map.`); return; }
    if (!similar || similar.pad !== target || similar.last !== cur) similar = { pad: target, anchor: cur, k: 0, last: -1 };
    const list = similarTo(points, similar.anchor);
    if (!list.length) return;
    const next = list[similar.k % list.length];
    similar.k++;
    assign(next); similar.last = next;
    cursor = next; play(next);
    say(`Pad ${target + 1} is now ${label(points[next])}, close to ${points[similar.anchor].name}.`);
    draw();
  });
  scope.on(shufBtn, 'click', () => {
    const seed = shuffleSeed++;
    const kit = shuffleKit(seed);
    const d = drumNow();
    kit.forEach((li, k) => { d.pads[k] = { ...d.pads[k], name: libraryInfo(li).name, synth: li, sample: null }; });
    store.set(`parts.${part}.drum`, d, { source: 'ui' });
    similar = null;
    cursor = padPoint(target);
    if (cursor >= 0) play(cursor);
    say(`Shuffled kit ${seed}: ${kit.map(li => libraryInfo(li).name).join(', ')}.`);
    draw();
  });

  scope.add(store.subscribe(`parts.${part}.drum`, () => { refreshPads(); draw(); }));
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => draw());
    ro.observe(stage);
    scope.add(() => ro.disconnect());
  } else scope.on(window, 'resize', draw);
  if (typeof MutationObserver === 'function') {
    const mo = new MutationObserver(() => draw());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] });
    scope.add(() => mo.disconnect());
  }

  refreshPads();
  setTarget(target);
  libraryMapAsync().then(() => {
    if (!modal.isOpen()) return;
    points = buildSoundMap(sessionSamples(store));
    const i = padPoint(target);
    cursor = i >= 0 ? i : 0;
    for (const b of [playBtn, useBtn, simBtn, shufBtn]) b.disabled = false;
    const nS = points.filter(p => p.cat === SAMPLE_CAT).length;
    say(`${points.length - nS} synthesized sounds${nS ? ` and ${nS} sample${nS === 1 ? '' : 's'} from this session` : ''}. Now on pad ${target + 1}: ${label(points[cursor])}.`);
    draw();
  }).catch((err) => { console.warn('[ui] the sound map could not be measured', err); say('The sound map could not be built.'); });
  return modal;
}
