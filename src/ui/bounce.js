// Bounce: render a number of bars of the sequencers offline (faster than real
// time, sample-exact) to a 24-bit WAV, optionally with one stem per part.

import { NUM_PARTS } from '../core/params.js';
import { h, createScope, setText, listen, has, downloadBlob } from './dom.js';
import { openPopover } from './layers.js';
import { recordingName } from './record.js';
import { icon } from './icons.js';

export function bounceName(date, suffix = '') {
  return recordingName(date).replace('orograph-', 'orograph-bounce-').replace('.wav', `${suffix}.wav`);
}

export function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'part';
}

export function bounceSupported(ctx) {
  return has(ctx.engine, 'bounce') && !!ctx.music && has(ctx.music, 'renderEvents');
}

export function openBounce(ctx, anchor) {
  const scope = createScope();
  const { store, engine, music } = ctx;
  const ok = bounceSupported(ctx);
  let bars = 4, stems = false, fx = true, tail = 2, busy = false;

  const barsSel = h('select', { class: 'select-native', 'aria-label': 'Bars to render' }, [1, 2, 4, 8, 16, 32, 64].map(b => h('option', { value: String(b) }, `${b} bar${b > 1 ? 's' : ''}`)));
  barsSel.value = '4';
  const tailSel = h('select', { class: 'select-native', 'aria-label': 'Reverb and delay tail' }, [0, 1, 2, 4, 8].map(t => h('option', { value: String(t) }, t ? `${t} s tail` : 'No tail')));
  tailSel.value = '2';
  const stemsBtn = h('button', { type: 'button', class: 'toggle toggle--sm', 'aria-pressed': 'false' }, 'Stems per part');
  const fxBtn = h('button', { type: 'button', class: 'toggle toggle--sm is-on', 'aria-pressed': 'true' }, 'Effects');
  const go = h('button', { type: 'button', class: 'btn btn--primary btn--sm', html: icon('bounce') + '<span>Render WAV</span>', disabled: !ok });
  const bar = h('div', { class: 'bounce-progress', hidden: true }, h('span', { class: 'bounce-fill' }));
  const status = h('p', { class: 'popover-note bounce-status' });
  const sel = (el) => h('div', { class: 'select select--sm' }, el, h('span', { class: 'select-caret', html: icon('chevron-down'), 'aria-hidden': 'true' }));
  const body = h('div', { class: 'bounce-pop' },
    h('div', { class: 'popover-title' }, 'Bounce to WAV'),
    h('p', { class: 'popover-note' }, ok
      ? 'Renders the sequencers and arpeggiators offline, sample-exact, at the current tempo. Parts that are not sequenced stay silent.'
      : 'Bouncing needs the audio and music engines, which are not available here. Use Record instead.'),
    h('div', { class: 'bounce-grid' }, sel(barsSel), sel(tailSel), stemsBtn, fxBtn),
    bar, status,
    h('div', { class: 'bounce-actions' }, go));

  const toggle = (btn, on) => { btn.classList.toggle('is-on', on); btn.setAttribute('aria-pressed', String(on)); };
  scope.on(stemsBtn, 'click', () => { stems = !stems; toggle(stemsBtn, stems); });
  scope.on(fxBtn, 'click', () => { fx = !fx; toggle(fxBtn, fx); });
  scope.on(barsSel, 'change', () => { bars = Number(barsSel.value); });
  scope.on(tailSel, 'change', () => { tail = Number(tailSel.value); });
  scope.add(listen(engine, 'bounce', (p) => {
    if (!busy || !p || !p.total) return;
    bar.firstChild.style.transform = `scaleX(${Math.min(1, p.done / p.total)})`;
  }));

  scope.on(go, 'click', async () => {
    if (busy || !ok) return;
    busy = true;
    go.disabled = true;
    bar.hidden = false;
    bar.firstChild.style.transform = 'scaleX(0)';
    setText(status, 'Rendering...');
    const started = new Date();
    try {
      await ctx.startAudio();
      const parts = Array.from({ length: NUM_PARTS }, (_, i) => i);
      const events = await music.renderEvents(bars, { parts });
      const res = await engine.bounce({ bars, stems, fx, tailSeconds: tail, events });
      if (res && res.mix) downloadBlob(res.mix, bounceName(started));
      if (stems && res && Array.isArray(res.stems)) {
        res.stems.forEach((b, i) => { if (b) setTimeout(() => downloadBlob(b, bounceName(started, `-part${i + 1}-${slug(store.get(`parts.${i}.name`))}`)), 250 * (i + 1)); });
      }
      bar.firstChild.style.transform = 'scaleX(1)';
      setText(status, 'Done. Check your downloads.');
      ctx.toast('Bounce saved', { kind: 'success', detail: bounceName(started) });
    } catch (err) {
      console.warn('[ui] bounce failed', err);
      setText(status, 'The render did not finish. Try fewer bars, or use Record.');
      ctx.toast('Bounce did not work', { kind: 'error' });
    } finally {
      busy = false;
      go.disabled = false;
    }
  });

  return openPopover(ctx.layers, anchor, body, { className: 'popover--bounce', label: 'Bounce to WAV', placement: 'bottom-end', onClose: () => scope.dispose() });
}
