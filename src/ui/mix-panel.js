// MIX tab: one channel strip per track (level fader, activity meter, pan,
// delay and reverb sends, mute / solo, track colour and name; the strips
// scroll sideways when they do not fit, and an Add track tile ends the row)
// and the master section
// (delay, reverb, chorus, warmth, volume with a stereo meter). While the pedal
// send is switched on in Settings > Pedals (v1.1), each strip also shows its
// Pedal send with Pre and Insert.
// v2.8: each strip also has Send A and Send B (post-fader sends to the two
// shared return buses, see src/dsp/send-fx.js) and a Freeze button
// (src/audio/freeze.js); the Send effects section below sets up the returns.

import { createVectorMix } from './vector-mix.js';
import { createTrackFxPanel } from './track-fx-panel.js';
import { MAX_PARTS, PART_COLORS, GLOBAL_PARAM_MAP, PART_PARAM_MAP, formatValue, clamp } from '../core/params.js';
import { FREEZE_BAR_CHOICES } from '../audio/freeze.js';
import { partCount } from '../core/tracks.js';
import { h, createScope, setText } from './dom.js';
import { icon } from './icons.js';
import { addTrackAction, openTrackMenu, toggleFreeze } from './track-actions.js';
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
  // One strip per track, built when the track list grows and disposed when
  // it shrinks (a strip reads its track by index, so a reorder only re-renders).
  const strips = [];
  const stripRow = h('div', { class: 'mix-strips', role: 'group', 'aria-label': 'Track channels' });
  const addTile = h('button', {
    type: 'button', class: 'strip-add', 'aria-label': 'Add track',
    dataset: { tip: `Add a track (up to ${MAX_PARTS})` },
  }, h('span', { class: 'strip-add-icon', html: icon('plus'), 'aria-hidden': 'true' }), h('span', null, 'Add track'));
  scope.on(addTile, 'click', () => addTrackAction(ctx));
  function syncStrips() {
    const n = partCount(store);
    while (strips.length > n) { const s = strips.pop(); s.dispose(); s.el.remove(); }
    while (strips.length < n) { const s = createStrip(ctx, strips.length); strips.push(s); stripRow.insertBefore(s.el, addTile); }
    addTile.disabled = n >= MAX_PARTS;
  }
  stripRow.appendChild(addTile);
  syncStrips();
  scope.add(store.subscribe('parts', (path) => { if (path === 'parts' || path === '') syncStrips(); }));
  scope.add(() => { for (const s of strips) s.dispose(); });

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

  const vector = createVectorMix(ctx), trackFx = createTrackFxPanel(ctx);
  scope.add(vector.dispose); scope.add(trackFx.dispose);
  const sends = createSendSection(ctx, scope, g);
  const el = h('div', { class: 'dock-pane dock-pane--mix' }, stripRow, vector.el, trackFx.el, master, sends);

  // ---- meters (one loop for everything)
  const levels = new Float32Array(MAX_PARTS);
  const kicks = new Float32Array(MAX_PARTS);
  if (ctx.notes) scope.add(ctx.notes.on(({ part, vel, on }) => { if (on && part >= 0 && part < MAX_PARTS) kicks[part] = Math.max(kicks[part], vel ?? 0.8); }));
  let mL = 0, mR = 0, hL = 0, hR = 0, holdT = 0;
  scope.add(addLoop((t) => {
    if (!el.isConnected || el.offsetParent === null) return;
    for (let i = 0; i < strips.length; i++) {
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

function createStrip(ctx, i) {
  const { store, binder } = ctx;
  const parentScope = createScope();
  const P = (id) => binder.partParam(id, { part: i });
  const nameBtn = h('button', { type: 'button', class: 'strip-name', dataset: { tip: 'Click to select, double-click to rename' } });
  const patch = h('span', { class: 'strip-patch' });
  const colorInput = h('input', { type: 'color', class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  const swatch = h('button', { type: 'button', class: 'strip-swatch', 'aria-label': `Change the colour of track ${i + 1}`, dataset: { tip: 'Track colour' } });
  const level = createMiniSlider(ctx, P('level'), { vertical: true, relative: true, ariaLabel: `Track ${i + 1} level`, className: 'fader' });
  const meterFill = h('span', { class: 'meter-fill' });
  const meter = h('div', { class: 'meter meter--mono', 'aria-hidden': 'true' }, h('span', { class: 'meter-ch' }, meterFill));
  const levelVal = h('span', { class: 'fader-value' });
  const knobs = ['pan', 'delaySend', 'reverbSend'].map(id => createKnob(ctx, P(id), { size: 'sm', ariaLabel: (l) => `Track ${i + 1} ${l}` }));
  const mute = createToggle(ctx, P('mute'), { label: 'M', className: 'toggle--mute', ariaLabel: `Mute track ${i + 1}`, tip: 'Mute' });
  const solo = createToggle(ctx, P('solo'), { label: 'S', className: 'toggle--solo', ariaLabel: `Solo track ${i + 1}`, tip: 'Solo' });
  // v2.8 Send A (reverb) and Send B (delay), post-fader
  const sendKnobs = [['sendA', 'Send A, to the shared reverb'], ['sendB', 'Send B, to the shared delay']]
    .map(([id, what]) => createKnob(ctx, P(id), { size: 'sm', ariaLabel: () => `Track ${i + 1} ${what}` }));
  for (const c of [level, ...knobs, ...sendKnobs, mute, solo]) parentScope.add(c.dispose);
  // v2.8 Freeze
  const fz = ctx.freeze || null;
  const freezeBtn = h('button', {
    type: 'button', class: 'toggle toggle--freeze has-icon', 'aria-pressed': 'false', 'aria-label': `Freeze track ${i + 1}`,
    dataset: { tip: fz ? 'Freeze: play this track from a rendered loop of its pattern to save processing. Editing its sound makes it live again' : 'Freeze needs the audio engine, which is not available here' },
    html: icon('freeze'),
  });
  if (!fz) freezeBtn.disabled = true;
  parentScope.on(freezeBtn, 'click', () => toggleFreeze(ctx, i));
  // Pedal send (v1.1): only shown while the pedal send runs, so the mixer is unchanged otherwise.
  const hasPedal = !!PART_PARAM_MAP.pedalSend;
  const pedalKnob = hasPedal ? createKnob(ctx, P('pedalSend'), { size: 'sm', ariaLabel: () => `Track ${i + 1} pedal send` }) : null;
  const pedalPre = hasPedal ? createToggle(ctx, P('pedalPre'), { label: 'Pre', className: 'toggle--pedal', ariaLabel: `Track ${i + 1} pedal send before the fader`, tip: 'Pedal send before the level fader' }) : null;
  const pedalIns = hasPedal ? createToggle(ctx, P('pedalInsert'), { label: 'Ins', className: 'toggle--pedal toggle--insert', ariaLabel: `Track ${i + 1} insert: hear it only through the pedals`, tip: 'Insert: mute the dry sound, hear this track only through the pedals' }) : null;
  for (const c of [pedalKnob, pedalPre, pedalIns]) if (c) { parentScope.add(c.dispose); c.el.classList.add('is-pedal-ctl'); }

  const el = h('section', { class: 'strip', 'aria-label': `Track ${i + 1} channel`, dataset: { part: String(i) } },
    h('header', { class: 'strip-head' }, swatch, h('div', { class: 'strip-titles' }, nameBtn, patch), colorInput),
    h('div', { class: 'strip-body' },
      h('div', { class: 'strip-fader' }, h('div', { class: 'fader-wrap' }, level.el, meter), levelVal),
      h('div', { class: 'strip-knobs' }, knobs.map(k => k.el), pedalKnob ? pedalKnob.el : null)),
    h('div', { class: 'strip-sends', role: 'group', 'aria-label': `Track ${i + 1} sends to the shared returns` }, sendKnobs.map(k => k.el)),
    h('footer', { class: 'strip-foot' }, mute.el, solo.el, freezeBtn, pedalPre ? pedalPre.el : null, pedalIns ? pedalIns.el : null));

  function render() {
    if (!store.get(`parts.${i}`)) return;  // the track was just removed; this strip is going too
    const name = store.get(`parts.${i}.name`) || `Track ${i + 1}`;
    setText(nameBtn, name);
    nameBtn.setAttribute('aria-label', `${name}: select this track`);
    const frozen = !!(fz && fz.isFrozen(i)), busy = !!(fz && fz.isBusy(i));
    setText(patch, (frozen ? 'Frozen: ' : busy ? 'Freezing: ' : '') + (store.get(`parts.${i}.patchName`) || 'Init'));
    el.classList.toggle('is-frozen', frozen);
    freezeBtn.classList.toggle('is-on', frozen);
    freezeBtn.classList.toggle('is-busy', busy);
    freezeBtn.setAttribute('aria-pressed', String(frozen));
    freezeBtn.setAttribute('aria-busy', String(busy));
    freezeBtn.setAttribute('aria-label', `${frozen ? 'Unfreeze' : busy ? 'Cancel freezing' : 'Freeze'} track ${i + 1}`);
    const color = store.get(`parts.${i}.color`) || PART_COLORS[i % PART_COLORS.length];
    colorInput.value = color;
    applyVars(el, partVars(color, document.documentElement.dataset.theme, ctx.panelBg()));
    el.classList.toggle('is-selected', binder.selected() === i);
    el.classList.toggle('is-muted', !!store.get(`parts.${i}.params.mute`));
    setText(levelVal, Math.round((store.get(`parts.${i}.params.level`) ?? 0.75) * 100) + '%');
    if (hasPedal) {
      const rig = ctx.pedals;
      const on = !!(rig && rig.prefs.enabled);
      el.classList.toggle('has-pedal', on);
      el.classList.toggle('is-insert', on && !!store.get(`parts.${i}.params.pedalInsert`));
    }
  }
  const invalidate = () => schedule(render);
  parentScope.add(store.subscribe(`parts.${i}`, invalidate));
  parentScope.add(store.subscribe('ui.selectedPart', invalidate));
  parentScope.on(window, 'orograph:theme', invalidate);
  if (hasPedal && ctx.pedals) parentScope.add(ctx.pedals.on('change', invalidate));
  if (fz) parentScope.add(fz.on('change', invalidate));

  parentScope.on(nameBtn, 'click', () => store.set('ui.selectedPart', i, { source: 'ui' }));
  parentScope.on(nameBtn, 'dblclick', () => rename());
  parentScope.on(nameBtn, 'keydown', (e) => { if (e.key === 'F2') { e.preventDefault(); rename(); } });
  // Right-click (or the context-menu key) on the strip head: the track menu.
  parentScope.on(el.firstChild, 'contextmenu', (e) => { e.preventDefault(); store.set('ui.selectedPart', i, { source: 'ui' }); openTrackMenu(ctx, nameBtn, i); });
  parentScope.on(swatch, 'click', () => colorInput.click());
  parentScope.on(colorInput, 'input', () => store.set(`parts.${i}.color`, colorInput.value, { source: 'ui' }));

  function rename() {
    const input = h('input', { class: 'field field--inline', type: 'text', value: store.get(`parts.${i}.name`) || '', maxlength: '40', 'aria-label': `Name for track ${i + 1}` });
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
    dispose: parentScope.dispose,
  };
}


/**
 * The Send effects section: Send A (reverb) and Send B (delay) return
 * settings, and the length of new frozen loops.
 */
function createSendSection(ctx, scope, g) {
  const { store, binder } = ctx;
  const toggle = (id, label) => {
    const t = createToggle(ctx, binder.globalParam(id), { label, className: 'toggle--sm', ariaLabel: `Send B ${label}` });
    scope.add(t.dispose);
    return t;
  };
  const syncT = toggle('sendBSync', 'Sync');
  const pingT = toggle('sendBPingPong', 'Ping-pong');
  const div = createSelect(ctx, binder.globalParam('sendBDiv'), { label: 'Send B delay time (note value)', className: 'select--sm' });
  scope.add(div.dispose);
  const msKnob = g('sendBTime', { ariaLabel: () => 'Send B delay time in milliseconds' });
  const timeBox = h('div', { class: 'sends-time' }, h('span', { class: 'mini-label' }, 'Time'), div.el);
  const renderSync = () => {
    const on = !!store.get('global.sendBSync');
    timeBox.hidden = !on;
    msKnob.hidden = on;
  };
  scope.add(binder.globalParam('sendBSync').subscribe(() => schedule(renderSync)));
  renderSync();
  const lengthBinding = { ...binder.uiValue('freezeBars', FREEZE_BAR_CHOICES, 0), def: { id: 'freezeBars', label: 'Freeze length', default: 0 } };
  const lengthSel = createSelect(ctx, lengthBinding, {
    label: 'Length of new frozen loops',
    className: 'select--sm',
    options: FREEZE_BAR_CHOICES.map(b => ({ value: b, label: b === 0 ? 'Auto' : `${b} bar${b > 1 ? 's' : ''}` })),
  });
  scope.add(lengthSel.dispose);
  const A = (id, label) => g(id, { ariaLabel: () => `Send A ${label}` });
  const B = (id, label) => g(id, { ariaLabel: () => `Send B ${label}` });
  return h('section', { class: 'mix-sends', 'aria-labelledby': 'sec-sends' },
    h('header', { class: 'section-head' }, h('h3', { class: 'section-title', id: 'sec-sends' }, 'Send effects')),
    h('div', { class: 'sends-body' },
      h('div', { class: 'fx-card fx-card--send' },
        h('div', { class: 'fx-title' }, h('span', null, 'Send A reverb')),
        h('div', { class: 'knob-row' }, A('sendASize', 'size'), A('sendADecay', 'decay'), A('sendADamp', 'damping'), A('sendAPredelay', 'pre-delay'), A('sendAReturn', 'return level'))),
      h('div', { class: 'fx-card fx-card--send' },
        h('div', { class: 'fx-title' }, h('span', null, 'Send B delay'), h('span', { class: 'sends-toggles' }, syncT.el, pingT.el)),
        h('div', { class: 'knob-row' }, timeBox, msKnob, B('sendBFeedback', 'feedback'), B('sendBTone', 'tone'), B('sendBReturn', 'return level'))),
      h('div', { class: 'fx-card fx-card--freeze' },
        h('div', { class: 'fx-title' }, h('span', null, 'Freeze')),
        h('div', { class: 'field-col' }, h('span', { class: 'mini-label' }, 'Loop length'), lengthSel.el),
        h('p', { class: 'sends-note' }, 'Auto: whole passes of the pattern that fill whole bars.'))));
}
