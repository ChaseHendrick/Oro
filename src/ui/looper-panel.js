// Looper UI (v1.2): the LOOP dock tab (every looper control) and the compact
// loop button in the top bar's transport (state, position ring, and a menu).
// Both drive ctx.looper (src/ui/looper-control.js). Right-click or long-press
// a looper button to MIDI-learn it.

import { h, s, createScope, setText, setAttr } from './dom.js';
import { schedule, addLoop } from './frame.js';
import { createSegmented, createMiniSlider } from './controls.js';
import { openMenu } from './menu.js';
import { icon } from './icons.js';
import { noteName } from '../audio/resample.js';

const RING_LEN = 100;

/** A throwaway binding over a getter/setter, so the shared controls can drive looper settings. */
function localBinding(def, get, set, subscribe) {
  return {
    def, id: def.id, scope: 'local', part: () => null, path: () => def.id, modPath: () => null, learnTarget: () => null,
    get, set: (v) => set(v), reset() { set(def.default); }, subscribe,
  };
}

/** One-line description of what the looper is doing, for the status line and screen readers. */
export function looperStatusText(st) {
  if (!st || !st.available) return (st && st.reason) || 'The looper is not available here.';
  const sr = st.sampleRate || 48000;
  const secs = (f) => `${(f / sr).toFixed(1)} s`;
  const bars = st.loopBars ? `${st.loopBars} bar${st.loopBars > 1 ? 's' : ''}, ` : '';
  const layers = st.layers ? `, ${st.layers} layer${st.layers > 1 ? 's' : ''} to undo` : '';
  if (st.busy === 'capture') return 'Recording the output for Resample...';
  if (st.busy === 'resample') return 'Making a terrain from the loop...';
  if (st.busy === 'export') return 'Saving the loop...';
  switch (st.state) {
    case 'armed': return 'Waiting for the next bar to start recording.';
    case 'record': {
      if (st.recTarget) {
        const per = st.recTarget / (st.bars || 1);
        return `Recording bar ${Math.min(st.bars, Math.floor(st.recPos / per) + 1)} of ${Math.round(st.recTarget / per)}.`;
      }
      return `Recording ${secs(st.recPos)}. Press again to close the loop.`;
    }
    case 'play': return st.cue ? 'Loop waits for bar 1.' : `Playing ${bars}${secs(st.len)}${layers}.`;
    case 'overdub': return `Overdubbing ${bars}${secs(st.len)}${layers}.`;
    case 'paused': return `Stopped (${bars}${secs(st.len)}). Press Play, or start the transport.`;
    default: return 'Empty. With the transport playing, recording starts on the next bar and lasts the chosen bars; stopped, it runs until you press again.';
  }
}

function ringSvg() {
  return s('svg', { class: 'loop-ring', viewBox: '0 0 36 36', 'aria-hidden': 'true', focusable: 'false' },
    s('circle', { class: 'loop-ring-track', cx: '18', cy: '18', r: '16', pathLength: String(RING_LEN) }),
    s('circle', { class: 'loop-ring-fill', cx: '18', cy: '18', r: '16', pathLength: String(RING_LEN), transform: 'rotate(-90 18 18)' }));
}

/** MIDI learn menu items for a looper action button. */
function learnItems(ctx, id, label) {
  if (!ctx.midiOk || !ctx.midiOk() || !ctx.learn) return [];
  const target = { scope: 'action', id };
  const mapping = ctx.findMapping(target);
  const items = [{ label: 'MIDI Learn', icon: icon('learn'), hint: mapping ? `CC ${mapping.cc}` : '', onSelect: () => ctx.learn.start(target, label) }];
  if (mapping) items.push({ label: 'Remove MIDI mapping', icon: icon('close'), onSelect: () => ctx.unmap(target) });
  return items;
}

function attachLearnMenu(ctx, scope, el, id, label, extra = () => []) {
  let at = 0;
  scope.on(el, 'contextmenu', (e) => {
    e.preventDefault();
    if (!ctx.layers || performance.now() - at < 800) return;
    at = performance.now();
    const items = [{ heading: label }, ...extra(), ...learnItems(ctx, id, label)];
    if (items.length > 1) openMenu(ctx.layers, el, items, { label: `${label} options` });
  });
}

/** The main loop button (Record / Play / Overdub) with its position ring. */
function mainButton(ctx, scope, { compact = false } = {}) {
  const lp = ctx.looper;
  const ring = ringSvg();
  const iconEl = h('span', { class: 'loop-icon' });
  const glyph = h('span', { class: 'loop-glyph' }, ring, iconEl);
  const label = h('span', { class: 'loop-label' });
  const btn = h('button', { type: 'button', class: ['loop-main', compact && 'loop-main--compact'], dataset: { tone: 'idle' } }, glyph, compact ? null : label);
  scope.on(btn, 'click', () => lp.main());
  let lastTone = '', lastIcon = '';
  const fill = ring.querySelector('.loop-ring-fill');
  function render() {
    const v = lp.view();
    const st = lp.status();
    if (v.tone !== lastTone) { btn.dataset.tone = v.tone; lastTone = v.tone; }
    // In the top bar an empty looper shows the loop arrows, so it does not look like a second Record button.
    const ico = compact && v.tone === 'idle' ? 'loop' : v.icon;
    if (ico !== lastIcon) { iconEl.innerHTML = icon(ico); lastIcon = ico; }
    setText(label, v.label);
    setAttr(btn, 'aria-label', v.aria + (compact ? ' (Q)' : ''));
    btn.dataset.tip = compact ? `${v.aria} (Q). Right-click for more` : `${v.aria} (Q)`;
    btn.disabled = !lp.available;
    btn.classList.toggle('is-busy', !!st.busy);
  }
  let lastP = -2;
  function frame() {
    const p = lp.progress();
    const q = p == null ? -1 : Math.round(p * 400) / 400;
    if (q === lastP) return;
    lastP = q;
    ring.classList.toggle('is-hidden', p == null);
    fill.style.strokeDashoffset = p == null ? String(RING_LEN) : String(RING_LEN * (1 - p));
  }
  scope.add(lp.on('change', () => schedule(render)));
  let stopLoop = null;
  const watch = () => {
    const st = lp.status();
    const active = st.state !== 'empty' || st.busy;
    if (active && !stopLoop) stopLoop = addLoop(frame);
    else if (!active && stopLoop) { stopLoop(); stopLoop = null; frame(); }
  };
  scope.add(lp.on('change', watch));
  scope.add(() => { if (stopLoop) stopLoop(); });
  render();
  watch();
  frame();
  return { btn, render };
}

/** Compact loop button for the top bar transport. */
export function createLooperButton(ctx) {
  const scope = createScope();
  if (!ctx.looper) return { el: null, dispose: () => {} };
  const lp = ctx.looper;
  const { btn } = mainButton(ctx, scope, { compact: true });
  btn.classList.add('transport-btn', 'loop-btn');
  attachLearnMenu(ctx, scope, btn, 'looper.main', 'Loop record / play / overdub', () => {
    const st = lp.status();
    const has = st.len > 0;
    return [
      { label: st.state === 'paused' ? 'Play loop' : 'Stop loop', icon: icon(st.state === 'paused' ? 'play' : 'stop'), hint: 'Shift+Q', disabled: !has, onSelect: () => lp.stop() },
      { label: 'Undo last layer', icon: icon('undo'), hint: 'B', disabled: !st.layers, onSelect: () => lp.undo() },
      { label: 'Clear loop', icon: icon('trash'), hint: 'Shift+B', disabled: st.state === 'empty', danger: true, onSelect: () => lp.clear() },
      { label: 'Open the Loop panel', icon: icon('loop'), onSelect: () => ctx.store.set('ui.panel', 'loop', { source: 'ui' }) },
      { separator: true },
    ];
  });
  return { el: btn, dispose: scope.dispose };
}

/** The LOOP dock tab. */
export function createLooperPanel(ctx) {
  const scope = createScope();
  const lp = ctx.looper;
  if (!lp) {
    return { el: h('div', { class: 'dock-pane dock-pane--loop' }, h('p', { class: 'panel-error' }, 'The looper needs the audio engine, which is not available here.')), dispose: () => {} };
  }
  const prefSub = (fn) => lp.on('prefs', fn);
  const statusSub = (fn) => lp.on('change', fn);

  // ---- transport row
  const { btn: main } = mainButton(ctx, scope);
  attachLearnMenu(ctx, scope, main, 'looper.main', 'Loop record / play / overdub');
  const tool = (name, ico, text, id, fn) => {
    const b = h('button', { type: 'button', class: 'loop-tool', 'aria-label': text, dataset: { tip: text }, html: icon(ico) + `<span class="loop-tool-text">${name}</span>` });
    scope.on(b, 'click', fn);
    attachLearnMenu(ctx, scope, b, id, text);
    return b;
  };
  const stopBtn = tool('Stop', 'stop', 'Stop the loop (Shift+Q)', 'looper.stop', () => lp.stop());
  const undoBadge = h('span', { class: 'loop-badge', 'aria-hidden': 'true' });
  const undoBtn = tool('Undo', 'undo', 'Undo the last overdub layer (B)', 'looper.undo', () => lp.undo());
  undoBtn.appendChild(undoBadge);
  const clearBtn = tool('Clear', 'trash', 'Clear the loop (Shift+B)', 'looper.clear', () => lp.clear());
  clearBtn.classList.add('loop-tool--danger');
  const muteBtn = tool('Mute', 'speaker', 'Mute the loop (M)', 'looper.mute', () => lp.toggleMute());
  muteBtn.setAttribute('aria-pressed', 'false');

  // ---- settings
  const barsBinding = localBinding({ id: 'loopBars', label: 'Loop length', default: 2 }, () => lp.prefs().bars, (v) => lp.setPref('bars', Number(v)), prefSub);
  const bars = createSegmented(ctx, barsBinding, {
    label: 'Loop length in bars', size: 'sm',
    options: [1, 2, 4, 8].map(n => ({ value: n, label: String(n), aria: `${n} bar${n > 1 ? 's' : ''}`, tip: `${n} bar${n > 1 ? 's' : ''} when the transport plays` })),
  });
  scope.add(bars.dispose);
  const pct = (v) => `${Math.round(v * 100)}%`;
  const volBinding = localBinding({ id: 'loopVolume', label: 'Loop volume', min: 0, max: 1, default: 1, curve: 'lin', hint: 'Loop volume' }, () => lp.prefs().volume, (v) => lp.setPref('volume', v), prefSub);
  const vol = createMiniSlider(ctx, volBinding, { ariaLabel: 'Loop volume', format: pct, className: 'loop-slider' });
  scope.add(vol.dispose);
  const fbBinding = localBinding({ id: 'loopFeedback', label: 'Overdub feedback', min: 0, max: 1, default: 1, curve: 'lin', hint: 'How much of the loop each overdub pass keeps (100% keeps it all)' }, () => lp.prefs().feedback, (v) => lp.setPref('feedback', v), prefSub);
  const fb = createMiniSlider(ctx, fbBinding, { ariaLabel: 'Overdub feedback', format: pct, className: 'loop-slider' });
  scope.add(fb.dispose);
  const volVal = h('span', { class: 'loop-value mono' });
  const fbVal = h('span', { class: 'loop-value mono' });

  // ---- resample + export
  const resampleText = h('span', null, 'Resample');
  const resampleBtn = h('button', { type: 'button', class: 'btn btn--sm loop-action', dataset: { tip: 'Turn the loop (or, when empty, bars of the output) into a terrain on the selected part' } },
    h('span', { class: 'loop-btn-icon', html: icon('resample'), 'aria-hidden': 'true' }), resampleText);
  scope.on(resampleBtn, 'click', () => lp.resample());
  attachLearnMenu(ctx, scope, resampleBtn, 'looper.resample', 'Resample');
  const slotBinding = localBinding({ id: 'loopSlot', label: 'Terrain slot', default: 'A' }, () => lp.prefs().slot, (v) => lp.setPref('slot', v), prefSub);
  const slot = createSegmented(ctx, slotBinding, { label: 'Resample into terrain slot', size: 'sm', options: [{ value: 'A', label: 'A', aria: 'Slot A' }, { value: 'B', label: 'B', aria: 'Slot B' }] });
  scope.add(slot.dispose);
  const sliceSel = h('select', { class: 'select-native', 'aria-label': 'How Resample cuts the audio into frames' },
    h('option', { value: 'auto' }, 'Find pitch'),
    h('option', { value: 'tempo' }, 'Tempo slices'),
    h('optgroup', { label: 'Root note' }, ...Array.from({ length: 37 }, (_, i) => 36 + i).map(n => h('option', { value: `root:${n}` }, `Root ${noteName(n)}`))));
  const sliceVal = () => { const p = lp.prefs(); return p.slice === 'root' ? `root:${p.root}` : p.slice; };
  sliceSel.value = sliceVal();
  scope.on(sliceSel, 'change', () => {
    const v = sliceSel.value;
    if (v.startsWith('root:')) { lp.setPref('root', Number(v.slice(5))); lp.setPref('slice', 'root'); } else lp.setPref('slice', v);
  });
  const exportBtn = h('button', { type: 'button', class: 'btn btn--sm loop-action', html: icon('export') + '<span>Export WAV</span>', dataset: { tip: 'Save the loop as a WAV file at the audio rate' } });
  scope.on(exportBtn, 'click', () => lp.exportWav());
  const fmtSel = h('select', { class: 'select-native', 'aria-label': 'Export format' }, h('option', { value: 'pcm24' }, '24-bit'), h('option', { value: 'float32' }, '32-bit float'));
  fmtSel.value = lp.prefs().format;
  scope.on(fmtSel, 'change', () => lp.setPref('format', fmtSel.value));
  const sel = (el) => h('div', { class: 'select select--sm' }, el, h('span', { class: 'select-caret', html: icon('chevron-down'), 'aria-hidden': 'true' }));

  const status = h('p', { class: 'loop-status', role: 'status', 'aria-live': 'polite' });
  const field = (label, ...kids) => h('div', { class: 'loop-field' }, h('span', { class: 'mini-label' }, label), ...kids);

  const el = h('div', { class: 'dock-pane dock-pane--loop' },
    h('section', { class: 'loop-card', 'aria-labelledby': 'sec-loop' },
      h('header', { class: 'section-head' }, h('h3', { class: 'section-title', id: 'sec-loop' }, 'Looper')),
      h('div', { class: 'loop-top' }, main, h('div', { class: 'loop-tools', role: 'group', 'aria-label': 'Loop tools' }, stopBtn, undoBtn, clearBtn, muteBtn)),
      status,
      h('div', { class: 'loop-grid' },
        field('Bars', bars.el),
        field('Volume', h('div', { class: 'loop-slider-row' }, vol.el, volVal)),
        field('Feedback', h('div', { class: 'loop-slider-row' }, fb.el, fbVal)))),
    h('section', { class: 'loop-card', 'aria-labelledby': 'sec-resample' },
      h('header', { class: 'section-head' }, h('h3', { class: 'section-title', id: 'sec-resample' }, 'Resample')),
      h('p', { class: 'loop-note' }, 'Makes a wavetable terrain from the loop, or from the chosen bars of the output when the looper is empty. With no steady pitch it cuts the audio at a period from the tempo or a root note.'),
      h('div', { class: 'loop-actions' }, resampleBtn, field('Slot', slot.el), field('Frames', sel(sliceSel)))),
    h('section', { class: 'loop-card', 'aria-labelledby': 'sec-loop-export' },
      h('header', { class: 'section-head' }, h('h3', { class: 'section-title', id: 'sec-loop-export' }, 'Export')),
      h('div', { class: 'loop-actions' }, exportBtn, field('Format', sel(fmtSel)))));

  function render() {
    const st = lp.status();
    const has = st.len > 0;
    setText(status, looperStatusText(st));
    stopBtn.innerHTML = icon(st.state === 'paused' ? 'play' : 'stop') + `<span class="loop-tool-text">${st.state === 'paused' ? 'Play' : 'Stop'}</span>`;
    setAttr(stopBtn, 'aria-label', st.state === 'paused' ? 'Play the loop (Shift+Q)' : 'Stop the loop (Shift+Q)');
    stopBtn.disabled = !lp.available || !(has || st.state === 'record' || st.state === 'armed');
    undoBtn.disabled = !lp.available || !st.layers;
    setText(undoBadge, st.layers ? String(st.layers) : '');
    clearBtn.disabled = !lp.available || st.state === 'empty';
    muteBtn.disabled = !lp.available;
    setAttr(muteBtn, 'aria-pressed', String(!!st.muted));
    muteBtn.classList.toggle('is-on', !!st.muted);
    resampleBtn.disabled = !lp.available || !!st.busy || st.state === 'record' || st.state === 'armed';
    resampleText.textContent = st.busy === 'capture' ? 'Recording...' : st.busy === 'resample' ? 'Working...' : 'Resample';
    exportBtn.disabled = !lp.available || !has || !!st.busy;
    setText(volVal, pct(st.prefs.volume));
    setText(fbVal, pct(st.prefs.feedback));
    if (sliceSel.value !== sliceVal()) sliceSel.value = sliceVal();
    if (fmtSel.value !== st.prefs.format) fmtSel.value = st.prefs.format;
  }
  scope.add(statusSub(() => schedule(render)));
  scope.add(prefSub(() => schedule(render)));
  if (!lp.available) {
    for (const c of [bars, vol, fb, slot]) c.setDisabled(true, lp.reason);
    sliceSel.disabled = true; fmtSel.disabled = true;
  }
  render();
  return { el, dispose: scope.dispose };
}
