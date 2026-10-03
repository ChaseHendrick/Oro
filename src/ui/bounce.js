// Bounce: render a number of bars of the sequencers offline (faster than real
// time, sample-exact) to a 24-bit WAV, optionally with one stem per track.
// Files are named orograph-bounce-YYYYMMDD-HHMMSS.wav, and stems add
// -trackN plus the track's name (-track3-bass).

import { partCount } from '../core/tracks.js';
import { h, createScope, setText, listen, has, downloadBlob } from './dom.js';
import { openPopover } from './layers.js';
import { recordingName } from './record.js';
import { createSegmented, createToggle } from './controls.js';
import { icon } from './icons.js';
import { saveSessionMidi } from './midi-file-tools.js';

export const BOUNCE_BARS = [1, 2, 4, 8, 16, 32, 64];
export const BOUNCE_TAILS = [0, 1, 2, 4, 8];

export function bounceName(date, suffix = '') {
  return recordingName(date).replace('oro-', 'oro-bounce-').replace('.wav', `${suffix}.wav`);
}

/** File name for track `index` (0-based, named `name` when given) of a stems bounce. */
export function stemName(date, index, name) {
  return bounceName(date, `-track${index + 1}${name ? '-' + slug(name) : ''}`);
}

export function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'part';
}

/** Seconds of music in `bars` 4/4 bars at `bpm`. */
export function bounceSeconds(bars, bpm) {
  return (Math.max(1, bars) * 4 * 60) / Math.max(1, bpm || 120);
}

export function bounceSupported(ctx) {
  return has(ctx.engine, 'bounce') && !!ctx.music && has(ctx.music, 'renderEvents');
}

/** A throwaway binding over a local value, so the shared controls can drive popover options. */
function localBinding(def, initial) {
  let value = initial;
  const fns = new Set();
  return {
    def, id: def.id, scope: 'local', part: () => null, path: () => def.id, modPath: () => null, learnTarget: () => null,
    get: () => value,
    set(v) { if (v === value) return; value = v; fns.forEach(fn => fn()); },
    reset() { this.set(def.default); },
    subscribe(fn) { fns.add(fn); return () => fns.delete(fn); },
  };
}

export function openBounce(ctx, anchor) {
  const scope = createScope();
  const { store, engine, music } = ctx;
  const ok = bounceSupported(ctx);
  let busy = false;

  const barsSel = h('select', { class: 'select-native', 'aria-label': 'Bars to render' }, BOUNCE_BARS.map(b => h('option', { value: String(b) }, `${b} bar${b > 1 ? 's' : ''}`)));
  barsSel.value = '4';
  const tailSel = h('select', { class: 'select-native', 'aria-label': 'Reverb and delay tail' }, BOUNCE_TAILS.map(t => h('option', { value: String(t) }, t ? `${t} s tail` : 'No tail')));
  tailSel.value = '2';
  const output = localBinding({ id: 'bounceOutput', label: 'Files', default: 'mix' }, 'mix');
  const fx = localBinding({ id: 'bounceFx', label: 'Effects', default: 1 }, 1);
  const outSeg = createSegmented(ctx, output, {
    label: 'Files to save', size: 'sm', className: 'seg--grow',
    options: [{ value: 'mix', label: 'Mix', tip: 'One stereo file of everything' }, { value: 'stems', label: 'Mix + stems', tip: 'The mix plus one file per track that plays' }],
  });
  const fxToggle = createToggle(ctx, fx, { label: 'Effects', className: 'toggle--switch', ariaLabel: 'Render with delay, reverb and master effects' });
  scope.add(outSeg.dispose);
  scope.add(fxToggle.dispose);

  const go = h('button', { type: 'button', class: 'btn btn--primary btn--sm', html: icon('bounce') + '<span>Render WAV</span>', disabled: !ok });
  // v2.9: the same bars as notes, one MIDI track per sequencer that is on
  const midiBtn = h('button', { type: 'button', class: 'btn btn--sm', 'aria-label': 'Save the sequencers as a MIDI file', dataset: { tip: 'Save these bars of every track whose sequencer is on as a .mid file' } }, 'Save MIDI');
  const bar = h('div', { class: 'bounce-progress', hidden: true, role: 'progressbar', 'aria-label': 'Render progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, h('span', { class: 'bounce-fill' }));
  const status = h('p', { class: 'popover-note bounce-status', role: 'status', 'aria-live': 'polite' });
  const length = h('p', { class: 'bounce-length mono' });
  const sel = (el) => h('div', { class: 'select select--sm' }, el, h('span', { class: 'select-caret', html: icon('chevron-down'), 'aria-hidden': 'true' }));
  const field = (label, control) => h('div', { class: 'bounce-field' }, h('span', { class: 'mini-label' }, label), control);
  const body = h('div', { class: 'bounce-pop' },
    h('div', { class: 'popover-title' }, 'Bounce to WAV'),
    h('p', { class: 'popover-note' }, ok
      ? 'Renders the sequencers and arpeggiators offline at the current tempo, sample-exact and faster than real time. Parts without a pattern stay silent.'
      : 'Bouncing needs the audio and music engines, which are not available here yet. Record still captures everything you play.'),
    h('div', { class: 'bounce-grid' }, field('Length', sel(barsSel)), field('Tail', sel(tailSel))),
    field('Files', outSeg.el),
    h('div', { class: 'bounce-row' }, h('span', { class: 'bounce-row-text' }, 'Effects', h('span', { class: 'setting-hint' }, 'Delay, reverb, chorus and warmth')), fxToggle.el),
    length, bar, status,
    h('div', { class: 'bounce-actions' }, midiBtn, go));

  const renderLength = () => {
    const bars = Number(barsSel.value);
    const secs = bounceSeconds(bars, store.get('global.tempo'));
    const tail = Number(tailSel.value);
    setText(length, `${bars} bar${bars > 1 ? 's' : ''} at ${Math.round(store.get('global.tempo') || 120)} BPM: ${secs.toFixed(1)} s${tail ? ` + ${tail} s tail` : ''}`);
  };
  scope.on(barsSel, 'change', renderLength);
  scope.on(tailSel, 'change', renderLength);
  scope.add(store.subscribe('global.tempo', renderLength));
  renderLength();
  if (!ok) {
    for (const el of [barsSel, tailSel]) el.disabled = true;
    outSeg.setDisabled(true, 'Bouncing is not available here');
    fxToggle.setDisabled(true, 'Bouncing is not available here');
  }

  const setProgress = (f) => {
    bar.firstChild.style.transform = `scaleX(${Math.max(0, Math.min(1, f))})`;
    bar.setAttribute('aria-valuenow', String(Math.round(Math.max(0, Math.min(1, f)) * 100)));
  };
  scope.add(listen(engine, 'bounce', (p) => {
    if (!busy || !p || !p.total) return;
    setProgress(p.done / p.total);
    setText(status, `Rendering... ${Math.round((p.done / p.total) * 100)}%`);
  }));

  scope.on(midiBtn, 'click', () => {
    try { setText(status, saveSessionMidi(store, Number(barsSel.value), music)); } catch (err) { console.warn('[ui] MIDI export failed', err); setText(status, 'The MIDI file could not be made.'); }
  });

  scope.on(go, 'click', async () => {
    if (busy || !ok) return;
    busy = true;
    go.disabled = true;
    bar.hidden = false;
    setProgress(0);
    setText(status, 'Rendering...');
    const started = new Date();
    const bars = Number(barsSel.value);
    const stems = output.get() === 'stems';
    try {
      await ctx.startAudio();
      const parts = Array.from({ length: partCount(store) }, (_, i) => i);
      const events = await music.renderEvents(bars, { parts });
      const res = await engine.bounce({ bars, stems, fx: !!fx.get(), tailSeconds: Number(tailSel.value), events });
      if (!res || !res.mix) throw new Error('The engine returned no audio');
      downloadBlob(res.mix, bounceName(started));
      let saved = 1;
      if (stems && Array.isArray(res.stems)) {
        // Browsers drop downloads fired in the same tick, so space them out a little.
        const names = parts.map(i => store.get(`parts.${i}.name`));
        res.stems.forEach((b, i) => { if (b) { saved++; setTimeout(() => downloadBlob(b, stemName(started, i, names[i])), 250 * (i + 1)); } });
      }
      setProgress(1);
      setText(status, saved > 1 ? `Done. ${saved} files are on their way to your downloads.` : 'Done. Check your downloads.');
      ctx.toast('Bounce saved', { kind: 'success', detail: bounceName(started) });
    } catch (err) {
      console.warn('[ui] bounce failed', err);
      setText(status, 'The render did not finish. Try fewer bars, or use Record instead.');
      ctx.toast('Bounce did not work', { kind: 'error' });
    } finally {
      busy = false;
      go.disabled = false;
    }
  });

  return openPopover(ctx.layers, anchor, body, { className: 'popover--bounce', label: 'Bounce to WAV', placement: 'bottom-end', onClose: () => scope.dispose() });
}
