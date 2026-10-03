// Modulation editor for one parameter: LFO shape, free rate or tempo-synced
// division, LFO depth, Envelope 2 depth, retrigger, a live animated preview
// and Clear. Writes parts.N.mods.<id>.<field>.

import { skewLfoPhase, steppedLfo, previewLfo } from '../dsp/modulation-extras.js';
import { LFO_SHAPES, SYNC_DIVS, MOD_DEFAULT, PART_PARAM_MAP, toNorm, clamp, formatValue, ENV_MODES, LINK_SOURCES, LINK_CURVES } from '../core/params.js';
import * as paramsModule from '../core/params.js';
import { h, createScope, setText, prefersReducedMotion } from './dom.js';
import { openPopover } from './layers.js';
import { addLoop, schedule } from './frame.js';
import { createKnob } from './knob.js';
import { createSegmented, createToggle, createSelect } from './controls.js';
import { icon } from './icons.js';

export const RATE_DEF = { id: 'lfoRate', label: 'Rate', curve: 'exp', min: 0.01, max: 30, default: MOD_DEFAULT.lfoRate, unit: 'Hz', hint: 'LFO speed in cycles per second' };
export const DEPTH_DEF = { id: 'lfoDepth', label: 'LFO', curve: 'lin', min: -1, max: 1, default: 0, hint: 'How far the LFO moves the knob (full = whole travel)' };
export const ENV_DEF = { id: 'envDepth', label: 'Envelope', curve: 'lin', min: -1, max: 1, default: 0, hint: 'How far Envelope 2 pushes the knob on each note' };
export const SHAPE_DEF = { id: 'lfoShape', label: 'Shape', curve: 'enum', min: 0, max: LFO_SHAPES.length - 1, default: 0, options: LFO_SHAPES };
export const DIV_DEF = { id: 'lfoDiv', label: 'Division', curve: 'enum', min: 0, max: SYNC_DIVS.length - 1, default: MOD_DEFAULT.lfoDiv, options: SYNC_DIVS.map(d => d.name) };
export const SYNC_DEF = { id: 'lfoSync', label: 'Sync', curve: 'bool', min: 0, max: 1, default: 0, hint: 'Lock the LFO to the tempo' };
export const RETRIG_DEF = { id: 'retrig', label: 'Retrig', curve: 'bool', min: 0, max: 1, default: 0, hint: 'Restart the LFO on each new note' };

export function formatDepth(v) {
  const p = Math.round(v * 100);
  return (p > 0 ? '+' : '') + p + '%';
}

function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export const STEP_COUNT = paramsModule.LFO_STEP_COUNT || 16;
export const DEFAULT_STEPS = paramsModule.DEFAULT_LFO_STEPS || Array.from({ length: STEP_COUNT }, (_, i) => Math.sin((i / STEP_COUNT) * Math.PI * 2));

/** LFO waveform value in -1..1 at a phase (cycles); S&H and Drift are seeded per cycle. */
export function lfoValue(shape, phase, steps, settings = null, hz = 1) {
  const cyc = Math.floor(phase);
  let p = phase - cyc;
  if (settings) {
    p = (p + (settings.lfoPhase || 0)) % 1;
    p = skewLfoPhase(p, settings.lfoSkew || 0);
    const raw = shape === 6 && (settings.stepGlide || settings.stepSmooth)
      ? steppedLfo(steps || DEFAULT_STEPS, 0, p, 1 / (Math.max(.01, hz) * STEP_COUNT), settings.stepGlide || 0, settings.stepSmooth || 0, STEP_COUNT)
      : lfoValue(shape, cyc + p, steps);
    return clamp(raw + (settings.lfoOffset || 0), -1, 1);
  }
  switch (shape) {
    case 6: {
      const arr = Array.isArray(steps) && steps.length ? steps : DEFAULT_STEPS;
      return clamp(Number(arr[Math.min(arr.length - 1, Math.floor(p * arr.length))]) || 0, -1, 1);
    }
    case 0: return Math.sin(2 * Math.PI * p);
    case 1: return 1 - 4 * Math.abs(((p + 0.25) % 1) - 0.5);
    case 2: return 2 * p - 1;
    case 3: return p < 0.5 ? 1 : -1;
    case 4: return hash(cyc) * 2 - 1;
    case 5: {
      const a = hash(cyc) * 2 - 1, b = hash(cyc + 1) * 2 - 1;
      const t = (1 - Math.cos(Math.PI * p)) / 2;
      return a + (b - a) * t;
    }
    default: return 0;
  }
}

/** LFO frequency in Hz for a mod setting at a tempo. */
export function lfoHz(mod, tempo) {
  if (mod.lfoSync) {
    const div = SYNC_DIVS[clamp(Math.round(mod.lfoDiv), 0, SYNC_DIVS.length - 1)];
    return (tempo / 60) / div.beats;
  }
  return mod.lfoRate;
}

export function openModPopover(ctx, binding, anchor) {
  const id = binding.def.id;
  const def = PART_PARAM_MAP[id];
  if (!def || !def.mod) return null;
  const part = binding.part();
  const scope = createScope();
  const fixed = { part };
  const f = (field, d) => ctx.binder.modField(id, field, d, fixed);
  const partName = ctx.store.get(`parts.${part}.name`) || `Part ${part + 1}`;

  const shapeSeg = createSegmented(ctx, f('lfoShape', SHAPE_DEF), {
    label: 'LFO shape', iconOnly: true, size: 'sm', className: 'seg--lfo',
    options: LFO_SHAPES.map((name, i) => ({ value: i, label: name, icon: `lfo-${i}` })),
  });
  const rateKnob = createKnob(ctx, f('lfoRate', RATE_DEF), { size: 'sm', caption: 'both', learnable: false });
  const divSelect = createSelect(ctx, f('lfoDiv', DIV_DEF), { label: 'Sync division', className: 'select--sm' });
  const syncToggle = createToggle(ctx, f('lfoSync', SYNC_DEF), { label: 'Sync', className: 'toggle--sm' });
  const depthKnob = createKnob(ctx, f('lfoDepth', DEPTH_DEF), { size: 'sm', caption: 'both', format: formatDepth, learnable: false });
  const envKnob = createKnob(ctx, f('envDepth', ENV_DEF), { size: 'sm', caption: 'both', format: formatDepth, learnable: false });
  const retrig = createToggle(ctx, f('retrig', RETRIG_DEF), { label: 'Retrig', className: 'toggle--sm' });
  for (const c of [shapeSeg, rateKnob, divSelect, syncToggle, depthKnob, envKnob, retrig]) scope.add(c.dispose);

  const rateSlot = h('div', { class: 'modpop-rate' }, rateKnob.el, h('div', { class: 'modpop-div' }, h('span', { class: 'mini-label' }, 'Division'), divSelect.el));
  const stepsEditor = createStepsEditor(ctx, `parts.${part}.mods.${id}.steps`, def.label);
  scope.add(stepsEditor.dispose);
  const preview = h('canvas', { class: 'modpop-preview', 'aria-hidden': 'true' });
  const readout = h('div', { class: 'modpop-readout' });
  const clearBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', html: icon('close') + '<span>Clear</span>' });

  const fieldControl = (field, label, min, max, options, curve = 'lin') => {
    const d = { id: field, label, min, max, default: MOD_DEFAULT[field], ...(['lfoDelay','lfoAttack','envDelay','envAttack','envHold','envDecay','envRelease'].includes(field) ? { unit: 's' } : {}), curve: options ? 'enum' : curve, ...(options ? { options } : {}) };
    const control = options ? createSelect(ctx, f(field, d), { label, className: 'select--sm' })
      : createKnob(ctx, f(field, d), { size: 'sm', caption: 'both', learnable: false });
    scope.add(control.dispose);
    return options ? h('label', { class: 'modpop-field' }, h('span', { class: 'mini-label' }, label), control.el) : control.el;
  };
  const lfoExtras = h('details', { class: 'modpop-extra' }, h('summary', null, 'LFO timing and shape'),
    h('div', { class: 'knob-grid knob-grid--4' },
      fieldControl('lfoSkew', 'Skew', -1, 1), fieldControl('lfoPhase', 'Phase', 0, 1), fieldControl('lfoOffset', 'Offset', -1, 1),
      fieldControl('lfoCount', 'Loops (0 = continuous)', 0, 32, null, 'int'), fieldControl('lfoDelay', 'Delay seconds', 0, 8),
      fieldControl('lfoAttack', 'Fade seconds', 0, 8), fieldControl('stepGlide', 'Step glide', 0, 1), fieldControl('stepSmooth', 'Step smooth', 0, 1)));
  const own = createToggle(ctx, f('envOwn', { id: 'envOwn', label: 'Own envelope', curve: 'bool', min: 0, max: 1, default: 0 }), { label: 'Own envelope' });
  scope.add(own.dispose);
  const envelopeControls = h('div', { class: 'modpop-ownenv' },
    fieldControl('envMode', 'Envelope mode', 0, 5, ENV_MODES),
    h('div', { class: 'knob-grid knob-grid--4' },
      fieldControl('envDelay', 'Delay seconds', 0, 8), fieldControl('envAttack', 'Attack seconds', 0.001, 8),
      fieldControl('envHold', 'Hold seconds', 0, 8), fieldControl('envDecay', 'Decay seconds', 0.001, 8),
      fieldControl('envSustain', 'Sustain', 0, 1), fieldControl('envRelease', 'Release seconds', 0.001, 10)));
  const envExtras = h('details', { class: 'modpop-extra' }, h('summary', null, 'Parameter envelope'), own.el, envelopeControls);
  const controllers = h('details', { class: 'modpop-extra' }, h('summary', null, 'Four controller slots'),
    ...[1, 2, 3, 4].map(n => h('div', { class: 'modpop-controller' },
      fieldControl(`ctrl${n}Source`, `Controller ${n}`, 0, LINK_SOURCES.length - 1, LINK_SOURCES),
      fieldControl(`ctrl${n}Depth`, `Depth ${n}`, -1, 1),
      fieldControl(`ctrl${n}Curve`, `Curve ${n}`, 0, LINK_CURVES.length - 1, LINK_CURVES))));

  const body = h('div', { class: 'modpop' },
    h('header', { class: 'modpop-head' },
      h('div', null, h('div', { class: 'modpop-kicker' }, 'Modulate'), h('div', { class: 'modpop-title' }, def.label)),
      h('span', { class: 'part-chip', style: { '--chip': ctx.store.get(`parts.${part}.color`) } }, partName)),
    h('div', { class: 'modpop-preview-wrap' }, preview, readout),
    h('div', { class: 'modpop-row' }, h('span', { class: 'mini-label' }, 'LFO shape'), shapeSeg.el),
    stepsEditor.el,
    h('div', { class: 'modpop-grid' },
      h('div', { class: 'modpop-col' }, h('div', { class: 'mini-label' }, 'Speed'), rateSlot, h('div', { class: 'modpop-toggles' }, syncToggle.el, retrig.el)),
      h('div', { class: 'modpop-col' }, h('div', { class: 'mini-label' }, 'Amount'), h('div', { class: 'modpop-knobs' }, depthKnob.el, envKnob.el))),
    lfoExtras, envExtras, controllers,
    h('footer', { class: 'modpop-foot' },
      h('span', { class: 'modpop-hint' }, 'Depth is in knob travel. Enable Own envelope to use this parameter’s six-stage envelope.'), clearBtn));

  const modPath = `parts.${part}.mods.${id}`;
  const getMod = () => ({ ...MOD_DEFAULT, ...(ctx.store.get(modPath) || {}) });
  function syncUi() {
    const m = getMod();
    rateSlot.classList.toggle('is-synced', !!m.lfoSync);
    stepsEditor.el.hidden = m.lfoShape !== 6;
    envelopeControls.hidden = !m.envOwn;
    const hz = lfoHz(m, ctx.store.get('global.tempo') || 120);
    setText(readout, `${LFO_SHAPES[m.lfoShape] || 'Sine'} at ${hz >= 10 ? hz.toFixed(1) : hz.toFixed(2)} Hz`);
  }
  scope.add(ctx.store.subscribe(modPath, syncUi));
  syncUi();

  scope.on(clearBtn, 'click', () => {
    const fresh = { ...MOD_DEFAULT };
    if (Array.isArray(MOD_DEFAULT.steps)) fresh.steps = [...MOD_DEFAULT.steps];
    ctx.store.set(modPath, fresh, { source: 'ui' });
  });

  // Animated preview: the knob's base position, the LFO swinging around it,
  // and (when the engine reports it) the live value.
  const t0 = performance.now();
  scope.add(addLoop(() => {
    if (!preview.isConnected) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(preview.clientWidth * dpr), H = Math.round(preview.clientHeight * dpr);
    if (!W || !H) return;
    if (preview.width !== W || preview.height !== H) { preview.width = W; preview.height = H; }
    const g = preview.getContext('2d');
    const cs = getComputedStyle(body);
    const col = cs.getPropertyValue('--part').trim() || '#3fd0c9';
    const grid = cs.getPropertyValue('--scope-grid').trim() || 'rgba(128,128,128,.2)';
    g.clearRect(0, 0, W, H);
    const m = getMod();
    const base = toNorm(def, ctx.store.get(`parts.${part}.params.${id}`) ?? def.default);
    const hz = lfoHz(m, ctx.store.get('global.tempo') || 120);
    const cycles = 2;
    // With reduced motion the wave stands still; the shape and depth still read.
    const now = prefersReducedMotion() ? 0 : (performance.now() - t0) / 1000;
    const age = Math.max(0, now - m.lfoDelay);
    const phaseNow = age * hz;
    const sample = (phase, elapsed = Infinity) => previewLfo(m, phase, 1 / Math.max(.01, hz), elapsed,
      hash(Math.floor(phase) - 1) * 2 - 1, hash(Math.floor(phase)) * 2 - 1);
    const pad = 4 * dpr;
    const y = n => H - pad - clamp(n, 0, 1) * (H - pad * 2);
    g.strokeStyle = grid; g.lineWidth = 1;
    g.setLineDash([3 * dpr, 4 * dpr]);
    g.beginPath(); g.moveTo(0, y(base)); g.lineTo(W, y(base)); g.stroke();
    g.setLineDash([]);
    g.beginPath();
    for (let i = 0; i <= 160; i++) {
      const ph = (i / 160) * cycles + Math.floor(phaseNow);
      const n = base + sample(ph) * m.lfoDepth;
      const x = (i / 160) * W;
      if (i === 0) g.moveTo(x, y(n)); else g.lineTo(x, y(n));
    }
    g.strokeStyle = col; g.lineWidth = 1.6 * dpr; g.lineJoin = 'round';
    g.stroke();
    const frac = (phaseNow % 1) / cycles;
    const dotN = base + sample(phaseNow, now) * m.lfoDepth;
    g.fillStyle = col;
    g.beginPath(); g.arc(frac * W, y(dotN), 3.2 * dpr, 0, Math.PI * 2); g.fill();
    const liveN = ctx.tele ? ctx.tele.norm(part, id) : null;
    if (liveN != null) {
      g.strokeStyle = col; g.lineWidth = 2 * dpr;
      g.beginPath(); g.moveTo(W - 2 * dpr, y(liveN) - 5 * dpr); g.lineTo(W - 2 * dpr, y(liveN) + 5 * dpr); g.stroke();
    }
  }));

  const pop = openPopover(ctx.layers, anchor, body, {
    className: 'popover--mod', label: `Modulate ${def.label}`, placement: 'bottom-start', focus: '.seg-btn[tabindex="0"]',
    onClose: () => scope.dispose(),
  });
  body.style.setProperty('--part', getComputedStyle(document.documentElement).getPropertyValue('--part'));
  return pop;
}

/**
 * Thirty-two-step LFO editor: drag across the bars to draw values (-1..1),
 * arrows move and adjust when focused, double-click restores the default.
 */
export function createStepsEditor(ctx, path, label) {
  const scope = createScope();
  const bars = [];
  const wrap = h('div', { class: 'steps-edit', role: 'group', 'aria-label': `${label} LFO steps` });
  for (let i = 0; i < STEP_COUNT; i++) {
    const fill = h('span', { class: 'steps-fill' });
    const bar = h('span', { class: 'steps-bar', role: 'slider', tabindex: i === 0 ? '0' : '-1', 'aria-label': `Step ${i + 1}`, 'aria-valuemin': '-100', 'aria-valuemax': '100' }, fill);
    bars.push(bar);
    wrap.appendChild(bar);
  }
  const get = () => {
    const v = ctx.store.get(path);
    return Array.isArray(v) && v.length === STEP_COUNT ? v.map(Number) : [...DEFAULT_STEPS];
  };
  const put = (arr) => ctx.store.set(path, arr.map(x => Math.round(clamp(x, -1, 1) * 1000) / 1000), { source: 'ui' });
  function render() {
    get().forEach((v, i) => {
      const f = bars[i].firstChild;
      f.style.top = v >= 0 ? `${(1 - v) * 50}%` : '50%';
      f.style.height = `${Math.abs(v) * 50}%`;
      bars[i].setAttribute('aria-valuenow', String(Math.round(v * 100)));
    });
  }
  let drawing = null;
  const valueAt = (e) => {
    const r = wrap.getBoundingClientRect();
    const i = clamp(Math.floor(((e.clientX - r.left) / r.width) * STEP_COUNT), 0, STEP_COUNT - 1);
    const v = clamp(1 - ((e.clientY - r.top) / r.height) * 2, -1, 1);
    return [i, Math.abs(v) < 0.04 ? 0 : v];
  };
  scope.on(wrap, 'pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    drawing = e.pointerId;
    try { wrap.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const [i, v] = valueAt(e);
    const arr = get(); arr[i] = v; put(arr);
    bars[i].focus({ preventScroll: true });
  });
  scope.on(wrap, 'pointermove', (e) => {
    if (drawing !== e.pointerId) return;
    const [i, v] = valueAt(e);
    const arr = get();
    if (arr[i] !== v) { arr[i] = v; put(arr); }
  });
  const end = () => { drawing = null; };
  scope.on(wrap, 'pointerup', end);
  scope.on(wrap, 'pointercancel', end);
  scope.on(wrap, 'dblclick', () => put([...DEFAULT_STEPS]));
  bars.forEach((bar, i) => scope.on(bar, 'keydown', (e) => {
    const arr = get();
    let n = -1;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); arr[i] = clamp(arr[i] + (e.key === 'ArrowUp' ? 0.1 : -0.1), -1, 1); put(arr); return; }
    if (e.key === 'ArrowRight') n = Math.min(STEP_COUNT - 1, i + 1);
    else if (e.key === 'ArrowLeft') n = Math.max(0, i - 1);
    if (n >= 0) { e.preventDefault(); e.stopPropagation(); bars.forEach((b, k) => { b.tabIndex = k === n ? 0 : -1; }); bars[n].focus(); }
  }));
  scope.add(ctx.store.subscribe(path, () => schedule(render)));
  render();
  return { el: h('div', { class: 'modpop-steps' }, h('span', { class: 'mini-label' }, 'Steps (draw)'), wrap), dispose: scope.dispose };
}

export function describeMod(m, tempo) {
  if (!m) return 'Off';
  const parts = [];
  if (Math.abs(m.lfoDepth) > 0.0005) parts.push(`LFO ${formatDepth(m.lfoDepth)} ${LFO_SHAPES[m.lfoShape]} ${m.lfoSync ? SYNC_DIVS[m.lfoDiv]?.name : formatValue(RATE_DEF, m.lfoRate)}`);
  if (Math.abs(m.envDepth) > 0.0005) parts.push(`${m.envOwn ? 'Own envelope' : 'Env 2'} ${formatDepth(m.envDepth)}`);
  for (let n = 1; n <= 4; n++) if (Math.abs(m[`ctrl${n}Depth`] || 0) > 0.0005) parts.push(`${LINK_SOURCES[m[`ctrl${n}Source`]]} ${formatDepth(m[`ctrl${n}Depth`])}`);
  return parts.length ? parts.join(', ') : 'Off';
}
