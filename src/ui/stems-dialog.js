// Export stems dialog (2.11), opened from the Bounce popover and loaded on
// demand. Renders every track, the optional send returns and the full mix
// offline and saves one .zip (src/audio/stems.js).

import '../styles/archive.css';
import { h, setText, has } from './dom.js';
import { saveBlob } from './save-file.js';
import { openModal } from './modal.js';
import {
  exportStems, exportSize, STEM_RATES, STEM_TAILS, DEFAULT_PATTERN, SIZE_MAX, songBars,
} from '../audio/stems.js';

const BARS = [1, 2, 4, 8, 16, 32, 64, 128];
const gb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${Math.max(0.1, b / 1e6).toFixed(1)} MB`);

export function openStemsDialog(ctx) {
  const { store, engine, music } = ctx;
  const ok = has(engine, 'renderPasses');
  let busy = false, cancelled = false;

  const select = (label, options, value) => {
    const el = h('select', { class: 'select-native', 'aria-label': label }, options.map(([v, t]) => h('option', { value: String(v) }, t)));
    el.value = String(value);
    return el;
  };
  const field = (label, control, hint) => h('label', { class: 'stems-field' }, h('span', { class: 'mini-label' }, label), control, hint ? h('span', { class: 'setting-hint' }, hint) : null);
  const check = (label, on, hint) => {
    const input = h('input', { type: 'checkbox' });
    input.checked = on;
    return { input, el: h('label', { class: 'stems-check' }, input, h('span', null, label, hint ? h('span', { class: 'setting-hint' }, hint) : null)) };
  };

  const length = select('Length', [['song', 'Whole song'], ...BARS.map(b => [b, `${b} bar${b > 1 ? 's' : ''}`])], 4);
  const rate = select('Sample rate', STEM_RATES.map(r => [r, `${r / 1000} kHz`]), 48000);
  const bits = select('Bit depth', [[16, '16-bit'], [24, '24-bit'], [32, '32-bit float']], 24);
  const tail = select('Tail after the last bar', STEM_TAILS.map(t => [t, t === 'auto' ? 'Auto (until silent)' : t ? `${t} s` : 'No tail']), 'auto');
  const norm = select('Normalise', [['off', 'Off'], ['common', 'Peak, common gain'], ['each', 'Peak, each file']], 'off');
  const wet = select('Send effects on the stems', [['wet', 'Wet: with sends'], ['dry', 'Dry: no sends']], 'wet');
  const fader = select('Fader', [['post', 'Post-fader'], ['pre', 'Pre-fader']], 'post');
  const dither = check('Dither', true, 'TPDF, for 16 and 24-bit');
  const returns = check('Send returns as their own files', false, 'Send A, Send B, delay and reverb. Only with dry stems: wet stems already hold their sends, so separate returns would count them twice.');
  const master = check('Master processing on stems', false, 'Off: stems are taken before the master chorus, warmth, volume and limiter, so they add up exactly to "Mix (no master processing)", which is saved too. On: every file goes through them like the mix.');
  const pattern = h('input', { type: 'text', class: 'input stems-pattern', value: DEFAULT_PATTERN, 'aria-label': 'File name pattern', spellcheck: 'false' });

  const bar = h('div', { class: 'bounce-progress', hidden: true, role: 'progressbar', 'aria-label': 'Export progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, h('span', { class: 'bounce-fill' }));
  const info = h('p', { class: 'stems-info mono' });
  const status = h('p', { class: 'popover-note stems-status', role: 'status', 'aria-live': 'polite' });
  const go = h('button', { type: 'button', class: 'btn btn--primary btn--sm', disabled: !ok }, 'Export zip');
  const cancel = h('button', { type: 'button', class: 'btn btn--sm', hidden: true }, 'Cancel');

  const content = h('div', { class: 'stems-dialog' },
    h('p', { class: 'popover-note' }, ok
      ? 'Renders each track on its own, through its own track effects, plus the full mix, all the same length from bar 1. The zip also holds the MIDI, a tempo map and a README.'
      : 'Exporting stems needs the audio engine, which is not available here.'),
    h('div', { class: 'stems-grid' },
      field('Length', h('div', { class: 'select select--sm' }, length)),
      field('Tail', h('div', { class: 'select select--sm' }, tail)),
      field('Sample rate', h('div', { class: 'select select--sm' }, rate)),
      field('Bit depth', h('div', { class: 'select select--sm' }, bits)),
      field('Stems', h('div', { class: 'select select--sm' }, wet)),
      field('Fader', h('div', { class: 'select select--sm' }, fader)),
      field('Normalise', h('div', { class: 'select select--sm' }, norm))),
    dither.el, returns.el, master.el,
    field('File names', pattern, 'Use {index}, {track name}, {tempo} and {key}'),
    info, bar, status,
    h('div', { class: 'bounce-actions' }, cancel, go));

  const options = () => ({
    length: length.value === 'song' ? 'song' : 'bars', bars: Number(length.value) || 4,
    sampleRate: Number(rate.value), bits: Number(bits.value), dither: dither.input.checked,
    normalise: norm.value, wet: wet.value === 'wet', returns: returns.input.checked, master: master.input.checked,
    tail: tail.value === 'auto' ? 'auto' : Number(tail.value), fader: fader.value, pattern: pattern.value,
  });

  let size = null;
  const refresh = () => {
    dither.input.disabled = bits.value === '32' || busy;
    returns.input.disabled = wet.value === 'wet' || busy;
    try {
      const st = store.serialize();
      size = exportSize(st, options());
      const bars = length.value === 'song' ? songBars(st) : Number(length.value);
      setText(info, `${bars} bar${bars > 1 ? 's' : ''}, ${size.files} file${size.files > 1 ? 's' : ''}, up to ${gb(size.bytes)}${size.refuse ? ': too large' : size.warn ? ': large' : ''}`);
      go.disabled = !ok || busy || size.refuse;
      if (size.refuse) setText(status, `This export would pass the ${SIZE_MAX / 1e9} GB limit. Use fewer bars, a lower sample rate or bit depth.`);
      else if (!busy) setText(status, size.warn ? 'This is a big export. It can take a while and needs free memory and disk space.' : '');
    } catch (err) {
      size = null;
      go.disabled = true;
      setText(info, '');
      setText(status, err && err.message ? err.message : 'These settings do not work.');
    }
  };
  for (const el of [length, rate, bits, tail, norm, wet, fader, dither.input, returns.input, master.input]) el.addEventListener('change', refresh);
  refresh();

  const setProgress = (f) => {
    const v = Math.max(0, Math.min(1, f));
    bar.firstChild.style.transform = `scaleX(${v})`;
    bar.setAttribute('aria-valuenow', String(Math.round(v * 100)));
  };
  const setBusy = (on) => {
    busy = on;
    for (const el of [length, rate, bits, tail, norm, wet, fader, pattern, master.input]) el.disabled = on;
    cancel.hidden = !on;
    bar.hidden = !on && bar.hidden;
    refresh();
  };

  cancel.addEventListener('click', () => { cancelled = true; setText(status, 'Stopping...'); });
  go.addEventListener('click', async () => {
    if (busy || !ok || (size && size.refuse)) return;
    cancelled = false;
    setBusy(true);
    bar.hidden = false;
    setProgress(0);
    setText(status, 'Rendering...');
    try {
      await ctx.startAudio();
      const res = await exportStems({
        state: store.serialize(), engine, options: options(),
        render: has(music, 'renderEvents') ? (bars, o) => music.renderEvents(bars, o) : null,
        isCancelled: () => cancelled || !modal.isOpen(),
        onProgress: (p) => { setProgress(p.fraction); if (p.label) setText(status, `${p.stage === 'encode' ? 'Saving' : 'Rendering'} ${p.label}... ${Math.round(p.fraction * 100)}%`); },
      });
      setProgress(1);
      const how = await saveBlob(res.blob, res.name);
      if (how === 'cancelled') setText(status, 'Not saved: the save dialog was closed.');
      else {
        setText(status, `Done: ${res.files.length} files in ${res.name} (${gb(res.bytes)}).`);
        ctx.toast('Stems saved', { kind: 'success', detail: res.name });
      }
    } catch (err) {
      if (err && err.cancelled) setText(status, 'Export cancelled.');
      else {
        console.warn('[ui] stems export failed', err);
        setText(status, err && err.message && err.message.length < 200 ? `The export did not finish: ${err.message}` : 'The export did not finish. Try fewer bars or a lower sample rate.');
      }
    } finally {
      setBusy(false);
    }
  });

  const modal = openModal(ctx.layers, ctx.root, { title: 'Export stems', content, className: 'stems-modal', onClose: () => { cancelled = true; } });
  return modal;
}
