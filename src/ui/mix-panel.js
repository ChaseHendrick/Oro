// MIX tab: four channel strips (level fader, activity meter, pan, delay and
// reverb sends, mute / solo, part colour and name) and the master section
// (delay, reverb, chorus, warmth, volume with a stereo meter).

import { NUM_PARTS, PART_COLORS, GLOBAL_PARAM_MAP, formatValue, clamp } from '../core/params.js';
import { h, createScope, setText } from './dom.js';
import { schedule, addLoop } from './frame.js';
import { createKnob } from './knob.js';
import { createToggle, createMiniSlider, createSelect } from './controls.js';
import { partVars, applyVars } from './color.js';

export function dbFromPeak(peak) {
  return peak > 1e-6 ? 20 * Math.log10(peak) : -120;
}

/** Peak (linear) to meter height 0..1 over a -60..+3 dB scale. */
export function meterPos(peak) {
  return clamp((dbFromPeak(peak) + 60) / 63, 0, 1);
}

export function createMixPanel(ctx) {
  const scope = createScope();
  const { store, binder } = ctx;
  const strips = [];
  for (let i = 0; i < NUM_PARTS; i++) strips.push(createStrip(ctx, scope, i));

  // ---- master
  const g = (id, opts = {}) => {
    const k = createKnob(ctx, binder.globalParam(id), { size: 'sm', ...opts });
    scope.add(k.dispose);
    return k.el;
  };
  const delayTime = createSelect(ctx, binder.globalParam('delayDiv'), { label: 'Delay time', className: 'select--sm' });
  scope.add(delayTime.dispose);
  const volume = createMiniSlider(ctx, binder.globalParam('masterVolume'), { vertical: true, relative: true, ariaLabel: 'Master volume', className: 'fader', format: v => Math.round(v * 100) + '%' });
  scope.add(volume.dispose);
  const volVal = h('span', { class: 'fader-value' });
  const meterL = h('span', { class: 'meter-fill' }), meterR = h('span', { class: 'meter-fill' });
  const peakL = h('span', { class: 'meter-peak' }), peakR = h('span', { class: 'meter-peak' });
  const meter = h('div', { class: 'meter meter--stereo', 'aria-hidden': 'true' },
    h('span', { class: 'meter-ch' }, meterL, peakL), h('span', { class: 'meter-ch' }, meterR, peakR));
  const renderVol = () => setText(volVal, formatValue(binder.globalParam('masterVolume').def, store.get('global.masterVolume') ?? 0.8));
  scope.add(binder.globalParam('masterVolume').subscribe(() => schedule(renderVol)));
  renderVol();

  const ceilingKnob = GLOBAL_PARAM_MAP.ceiling ? g('ceiling', { ariaLabel: () => 'Limiter ceiling', caption: 'both' }) : null;
  const master = h('section', { class: 'mix-master', 'aria-labelledby': 'sec-master' },
    h('header', { class: 'section-head' }, h('h3', { class: 'section-title', id: 'sec-master' }, 'Master')),
    h('div', { class: 'master-body' },
      h('div', { class: 'master-fx' },
        h('div', { class: 'fx-card' },
          h('div', { class: 'fx-title' }, h('span', null, 'Delay'), delayTime.el),
          h('div', { class: 'knob-row' }, g('delayFeedback', { ariaLabel: l => `Delay ${l}` }), g('delayTone', { ariaLabel: l => `Delay ${l}` }), g('delayLevel', { ariaLabel: l => `Delay ${l}` }))),
        h('div', { class: 'fx-card' },
          h('div', { class: 'fx-title' }, h('span', null, 'Reverb')),
          h('div', { class: 'knob-row' }, g('reverbSize', { ariaLabel: l => `Reverb ${l}` }), g('reverbDamp', { ariaLabel: l => `Reverb ${l}` }), g('reverbLevel', { ariaLabel: l => `Reverb ${l}` }))),
        h('div', { class: 'fx-card' },
          h('div', { class: 'fx-title' }, h('span', null, 'Colour')),
          h('div', { class: 'knob-row' }, g('chorus'), g('saturation')))),
      h('div', { class: 'master-out' },
        h('div', { class: 'fader-wrap' }, volume.el, meter),
        h('div', { class: 'strip-caption' }, h('span', { class: 'mini-label' }, 'Volume'), volVal)),
      h('div', { class: 'master-limit' }, ceilingKnob)));

  const el = h('div', { class: 'dock-pane dock-pane--mix' },
    h('div', { class: 'mix-strips', role: 'group', 'aria-label': 'Part channels' }, strips.map(s => s.el)),
    master);

  // ---- meters (one loop for everything)
  const levels = new Float32Array(NUM_PARTS);
  const kicks = new Float32Array(NUM_PARTS);
  if (ctx.notes) scope.add(ctx.notes.on(({ part, vel, on }) => { if (on && part >= 0 && part < NUM_PARTS) kicks[part] = Math.max(kicks[part], vel ?? 0.8); }));
  let mL = 0, mR = 0, hL = 0, hR = 0, holdT = 0;
  scope.add(addLoop((t) => {
    if (!el.isConnected || el.offsetParent === null) return;
    for (let i = 0; i < NUM_PARTS; i++) {
      const voices = ctx.tele ? ctx.tele.activeVoices(i) : 0;
      const lvl = store.get(`parts.${i}.params.level`) ?? 0.75;
      const muted = store.get(`parts.${i}.params.mute`);
      let target = voices > 0 ? Math.min(1, 0.5 + 0.12 * voices) * lvl : 0;
      if (kicks[i] > 0) { target = Math.max(target, kicks[i] * lvl); kicks[i] = 0; }
      if (muted) target = 0;
      levels[i] = target > levels[i] ? target : levels[i] * 0.9;
      strips[i].setMeter(levels[i]);
    }
    const peak = ctx.tele ? ctx.tele.peak() : null;
    let pl = 0, pr = 0;
    if (peak) { pl = meterPos(peak[0] || 0); pr = meterPos(peak[1] || 0); }
    else if (ctx.engine && typeof ctx.engine.level === 'function') {
      try { const lv = ctx.engine.level(); pl = pr = clamp(lv, 0, 1); } catch { /* ignore */ }
    }
    mL = pl > mL ? pl : mL * 0.88 + pl * 0.12;
    mR = pr > mR ? pr : mR * 0.88 + pr * 0.12;
    if (pl >= hL || pr >= hR || t - holdT > 1200) { hL = Math.max(pl, t - holdT > 1200 ? 0 : hL); hR = Math.max(pr, t - holdT > 1200 ? 0 : hR); holdT = t; }
    meterL.style.transform = `scaleY(${mL.toFixed(3)})`;
    meterR.style.transform = `scaleY(${mR.toFixed(3)})`;
    peakL.style.bottom = (hL * 100).toFixed(1) + '%';
    peakR.style.bottom = (hR * 100).toFixed(1) + '%';
    meter.classList.toggle('is-hot', Math.max(pl, pr) > meterPos(0.98));
  }));

  return { el, dispose: scope.dispose };
}

function createStrip(ctx, parentScope, i) {
  const { store, binder } = ctx;
  const P = (id) => binder.partParam(id, { part: i });
  const nameBtn = h('button', { type: 'button', class: 'strip-name', dataset: { tip: 'Click to select, double-click to rename' } });
  const patch = h('span', { class: 'strip-patch' });
  const colorInput = h('input', { type: 'color', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  const swatch = h('button', { type: 'button', class: 'strip-swatch', 'aria-label': `Change the colour of part ${i + 1}`, dataset: { tip: 'Part colour' } });
  const level = createMiniSlider(ctx, P('level'), { vertical: true, relative: true, ariaLabel: `Part ${i + 1} level`, className: 'fader' });
  const meterFill = h('span', { class: 'meter-fill' });
  const meter = h('div', { class: 'meter meter--mono', 'aria-hidden': 'true' }, h('span', { class: 'meter-ch' }, meterFill));
  const levelVal = h('span', { class: 'fader-value' });
  const knobs = ['pan', 'delaySend', 'reverbSend'].map(id => createKnob(ctx, P(id), { size: 'sm', ariaLabel: (l) => `Part ${i + 1} ${l}` }));
  const mute = createToggle(ctx, P('mute'), { label: 'M', className: 'toggle--mute', ariaLabel: `Mute part ${i + 1}`, tip: 'Mute' });
  const solo = createToggle(ctx, P('solo'), { label: 'S', className: 'toggle--solo', ariaLabel: `Solo part ${i + 1}`, tip: 'Solo' });
  for (const c of [level, ...knobs, mute, solo]) parentScope.add(c.dispose);

  const el = h('section', { class: 'strip', 'aria-label': `Part ${i + 1} channel`, dataset: { part: String(i) } },
    h('header', { class: 'strip-head' }, swatch, h('div', { class: 'strip-titles' }, nameBtn, patch), colorInput),
    h('div', { class: 'strip-body' },
      h('div', { class: 'strip-fader' }, h('div', { class: 'fader-wrap' }, level.el, meter), levelVal),
      h('div', { class: 'strip-knobs' }, knobs.map(k => k.el))),
    h('footer', { class: 'strip-foot' }, mute.el, solo.el));

  function render() {
    const name = store.get(`parts.${i}.name`) || `Part ${i + 1}`;
    setText(nameBtn, name);
    nameBtn.setAttribute('aria-label', `${name}: select this part`);
    setText(patch, store.get(`parts.${i}.patchName`) || 'Init');
    const color = store.get(`parts.${i}.color`) || PART_COLORS[i];
    colorInput.value = color;
    applyVars(el, partVars(color, document.documentElement.dataset.theme, ctx.panelBg()));
    el.classList.toggle('is-selected', binder.selected() === i);
    el.classList.toggle('is-muted', !!store.get(`parts.${i}.params.mute`));
    setText(levelVal, Math.round((store.get(`parts.${i}.params.level`) ?? 0.75) * 100) + '%');
  }
  const invalidate = () => schedule(render);
  parentScope.add(store.subscribe(`parts.${i}`, invalidate));
  parentScope.add(store.subscribe('ui.selectedPart', invalidate));
  parentScope.on(window, 'orograph:theme', invalidate);

  parentScope.on(nameBtn, 'click', () => store.set('ui.selectedPart', i, { source: 'ui' }));
  parentScope.on(nameBtn, 'dblclick', () => rename());
  parentScope.on(nameBtn, 'keydown', (e) => { if (e.key === 'F2') { e.preventDefault(); rename(); } });
  parentScope.on(swatch, 'click', () => colorInput.click());
  parentScope.on(colorInput, 'input', () => store.set(`parts.${i}.color`, colorInput.value, { source: 'ui' }));

  function rename() {
    const input = h('input', { class: 'field field--inline', type: 'text', value: store.get(`parts.${i}.name`) || '', maxlength: '40', 'aria-label': `Name for part ${i + 1}` });
    nameBtn.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && v) store.set(`parts.${i}.name`, v.slice(0, 40), { source: 'ui' });
      input.replaceWith(nameBtn);
      nameBtn.focus();
      render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  }

  render();
  return {
    el,
    setMeter(v) { meterFill.style.transform = `scaleY(${v.toFixed(3)})`; },
  };
}

