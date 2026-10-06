// Score desk panel (2.17): the score desk an agent uses, for people too.
// Write a score from a prompt or a style, edit the text, play it on the
// tracks (they are put back afterwards), render it offline to a 24-bit or
// 32-bit float WAV, save it as MIDI, or copy a link that opens it in Oro.

import { h, createScope, setText, downloadBlob } from './dom.js';
import { openPopover } from './layers.js';
import { icon } from './icons.js';
import { STYLES } from '../music/score-styles.js';

const KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const fileName = (title, ext) => `${String(title || 'oro-score').replace(/[^\w-]+/g, '-').replace(/^-|-$/g, '') || 'oro-score'}.${ext}`;

export function openScorePanel(ctx, anchor) {
  const scope = createScope();
  const { music } = ctx;
  const desk = music && music.score;
  const sel = (label, options, value) => {
    const el = h('select', { class: 'select-native', 'aria-label': label }, options.map(([v, t]) => h('option', { value: v }, t)));
    el.value = value;
    return h('div', { class: 'select select--sm' }, el, h('span', { class: 'select-caret', html: icon('chevron-down'), 'aria-hidden': 'true' }));
  };
  const field = (label, control) => h('label', { class: 'bounce-field' }, h('span', { class: 'mini-label' }, label), control);

  const prompt = h('input', { type: 'text', class: 'field', maxlength: '200', placeholder: 'anime opening song in D minor, lofi with rain, trap beat...', 'aria-label': 'Describe the music' });
  const styleSel = sel('Style', [['', 'From the words'], ...Object.keys(STYLES).map((s) => [s, s])], '');
  const keySel = sel('Key', [['', 'Any key'], ...KEYS.map((k) => [k, k])], '');
  const modeSel = sel('Mode', [['', 'Either'], ['major', 'Major'], ['minor', 'Minor']], '');
  const writeBtn = h('button', { type: 'button', class: 'btn btn--sm' }, 'Write');
  const text = h('textarea', { class: 'field mono score-text', rows: '10', spellcheck: 'false', 'aria-label': 'Score text' });
  text.value = desk ? desk.getScore() : '';
  const voicingSel = sel('Voicing', [['', 'As written'], ['patch', 'Instrument patches'], ['tint', 'Track colours']], '');
  const tracksSel = sel('Tracks', [['add', 'Add tracks'], ['share', 'Share tracks']], 'add');
  const playBtn = h('button', { type: 'button', class: 'btn btn--primary btn--sm', html: icon('play') + '<span>Play</span>' });
  const stopBtn = h('button', { type: 'button', class: 'btn btn--sm', html: icon('stop') + '<span>Stop</span>' });
  const fmtSel = sel('WAV format', [['pcm24', '24-bit'], ['float32', '32-bit float']], ctx.prefs && ctx.prefs.get ? ctx.prefs.get('wavFormat') : 'pcm24');
  const renderBtn = h('button', { type: 'button', class: 'btn btn--sm', html: icon('bounce') + '<span>Render WAV</span>' });
  const midiBtn = h('button', { type: 'button', class: 'btn btn--sm btn--ghost' }, 'Save MIDI');
  const linkBtn = h('button', { type: 'button', class: 'btn btn--sm btn--ghost', html: icon('link') + '<span>Copy link</span>' });
  const status = h('p', { class: 'popover-note score-status', role: 'status', 'aria-live': 'polite' });
  const issues = h('ul', { class: 'score-issues' });

  const body = h('div', { class: 'bounce-pop score-pop' },
    h('div', { class: 'popover-title' }, 'Score desk'),
    h('p', { class: 'popover-note' }, 'Describe a piece or pick a style, then play it on Oro\'s own instruments. Tracks are borrowed while it plays and put back after. Agents use the same desk: oro.help() in the console.'),
    h('div', { class: 'score-row' }, prompt, writeBtn),
    h('div', { class: 'bounce-grid' }, field('Style', styleSel), field('Key', keySel), field('Mode', modeSel)),
    text,
    issues,
    h('div', { class: 'bounce-grid' }, field('Voicing', voicingSel), field('Tracks', tracksSel), field('Format', fmtSel)),
    h('div', { class: 'bounce-actions' }, playBtn, stopBtn, renderBtn),
    h('div', { class: 'bounce-actions' }, midiBtn, linkBtn),
    status);

  const value = (wrap) => wrap.querySelector('select').value;
  function show(r, what) {
    issues.textContent = '';
    if (!r) return;
    if (!r.ok) {
      for (const e of r.errors.slice(0, 6)) issues.appendChild(h('li', { class: 'score-issue is-error' }, `${e.line ? `Line ${e.line}: ` : ''}${e.message} ${e.fix || ''}`));
      setText(status, `${r.errors.length} thing${r.errors.length === 1 ? '' : 's'} to fix.`);
      return;
    }
    for (const w of (r.warnings || []).slice(0, 4)) issues.appendChild(h('li', { class: 'score-issue' }, `${w.message} ${w.fix || ''}`));
    const cues = (r.cues || []).slice(0, 6).map((c) => `${c.name} ${c.seconds}s`).join(', ');
    setText(status, `${what}: ${r.score.title}, ${r.score.bars} bars at ${r.score.bpm} BPM, ${r.durationSeconds} s, ${r.noteCount} notes${cues ? `. Cues: ${cues}` : ''}.`);
  }

  scope.on(writeBtn, 'click', () => {
    const r = desk.compose({ prompt: prompt.value, style: value(styleSel) || undefined, key: value(keySel) || undefined, mode: value(modeSel) || undefined });
    if (r.ok) text.value = r.text;
    show(r, 'Written');
  });
  scope.on(prompt, 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); writeBtn.click(); } });
  scope.on(playBtn, 'click', async () => {
    if (ctx.startAudio) await ctx.startAudio();
    const opts = { tracks: value(tracksSel) };
    if (value(voicingSel)) opts.voicing = value(voicingSel);
    show(desk.play(text.value, opts), 'Playing');
  });
  scope.on(stopBtn, 'click', () => { desk.stop(); setText(status, 'Stopped. The tracks are back as they were.'); });
  scope.on(fmtSel.querySelector('select'), 'change', () => { try { ctx.prefs.set('wavFormat', value(fmtSel)); } catch { /* no prefs */ } });
  let rendering = false;
  scope.on(renderBtn, 'click', async () => {
    if (rendering) return;
    const r = desk.check(text.value);
    if (!r.ok) { show(r, 'Render'); return; }
    rendering = true;
    renderBtn.disabled = true;
    try {
      const [{ encodeScoreWav }, { renderScoreInBackground }] = await Promise.all([import('../music/score-render.js'), import('../music/score-render-host.js')]);
      const out = await renderScoreInBackground(text.value, {
        voicing: value(voicingSel) || undefined,
        onProgress: (f) => setText(status, `Rendering ${Math.round(f * 100)}%...`),
      });
      if (!out.ok) { show(out.receipt, 'Render'); return; }
      const bytes = encodeScoreWav(out, { format: value(fmtSel) });
      downloadBlob(new Blob([bytes], { type: 'audio/wav' }), fileName(out.receipt.score.title, 'wav'));
      setText(status, `Rendered ${out.stats.seconds} s at ${out.stats.loudness} LUFS (${value(fmtSel) === 'float32' ? '32-bit float' : '24-bit'}). Check your downloads.`);
    } catch (err) {
      console.warn('[ui] score render failed', err);
      setText(status, 'The render did not finish.');
    } finally {
      rendering = false;
      renderBtn.disabled = false;
    }
  });
  scope.on(midiBtn, 'click', async () => {
    const r = desk.check(text.value);
    if (!r.ok) { show(r, 'MIDI'); return; }
    const { scoreMidi } = await import('../music/score-export.js');
    downloadBlob(new Blob([scoreMidi(r)], { type: 'audio/midi' }), fileName(r.score.title, 'mid'));
    setText(status, 'MIDI saved. Check your downloads.');
  });
  scope.on(linkBtn, 'click', async () => {
    const r = desk.check(text.value);
    if (!r.ok) { show(r, 'Link'); return; }
    const { scoreLink } = await import('../music/score-export.js');
    const url = await scoreLink(r.text, location.origin + location.pathname);
    try { await navigator.clipboard.writeText(url); setText(status, 'Link copied. It opens Oro with this score ready to play.'); } catch { setText(status, url); }
  });
  // the desk's progress while the panel is open
  if (music && typeof music.on === 'function') {
    const onScore = (e) => {
      if (e.type === 'cue') setText(status, `Cue ${e.name} at ${e.seconds} s.`);
      else if (e.type === 'end' && e.reason === 'end') setText(status, 'Finished. The tracks go back in a moment.');
    };
    music.on('score', onScore);
    scope.add(() => music.off('score', onScore));
  }

  return openPopover(ctx.layers, anchor, body, { className: 'popover--bounce popover--score', label: 'Score desk', placement: 'bottom-end', focus: 'input', onClose: () => scope.dispose() });
}
