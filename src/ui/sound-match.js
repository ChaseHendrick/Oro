// Experimental: search a few terrains and paths for a spectrum close to a file.

import { h, createScope, setText } from './dom.js';
import { TERRAINS, PATHS } from '../dsp/catalog.js';
import { searchPatch, applyPatch } from '../music/sound-match.js';
import '../styles/sound-match.css';

export function createSoundMatch(ctx, { decode } = {}) {
  const scope = createScope();
  let buffer = null;
  let result = null;
  const status = h('p', { class: 'sound-match-status', role: 'status' });
  const file = h('input', { type: 'file', accept: 'audio/*', 'aria-label': 'Audio file' });
  const searchBtn = h('button', { type: 'button', class: 'btn btn--sm', disabled: true }, 'Search');
  searchBtn.disabled = true;
  const useBtn = h('button', { type: 'button', class: 'btn btn--sm', hidden: true }, 'Use this patch');
  useBtn.hidden = true;
  const closeBtn = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-label': 'Close match a sound' }, 'Close');
  const panel = h('div', { class: 'sound-match', hidden: true },
    h('div', { class: 'sound-match-head' },
      h('h3', { class: 'section-title' }, 'Match a sound'),
      closeBtn),
    h('p', { class: 'sound-match-hint' }, 'Experimental. Oro plays one cycle of each land and path and keeps the closest spectrum. Filters and effects are not part of the search.'),
    file, searchBtn, useBtn, status);
  panel.hidden = true;
  const button = h('button', { type: 'button', class: 'btn btn--ghost btn--sm', 'aria-expanded': 'false' }, 'Match a sound');
  let onToggle = null;

  function setOpen(on) {
    const open = !!on;
    panel.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    button.setAttribute('aria-pressed', open ? 'true' : 'false');
    if (onToggle) onToggle(open);
  }

  async function readFile(f) {
    if (decode) return decode(f);
    const ctxAudio = new AudioContext();
    try {
      const audio = await ctxAudio.decodeAudioData(await f.arrayBuffer());
      const ch = audio.getChannelData(0);
      return { samples: new Float32Array(ch), rate: audio.sampleRate };
    } finally {
      try { await ctxAudio.close(); } catch { /* already closed */ }
    }
  }

  scope.on(button, 'click', () => setOpen(panel.hidden));
  scope.on(closeBtn, 'click', () => setOpen(false));
  scope.on(file, 'change', async () => {
    const f = file.files && file.files[0];
    buffer = null;
    result = null;
    useBtn.hidden = true;
    searchBtn.disabled = true;
    if (!f) return;
    try {
      buffer = await readFile(f);
      searchBtn.disabled = !(buffer && buffer.samples && buffer.samples.length);
      setText(status, searchBtn.disabled ? 'No audio in that file.' : 'Ready to search.');
    } catch {
      setText(status, 'No audio in that file.');
    }
  });
  scope.on(searchBtn, 'click', () => {
    if (!buffer) return;
    searchBtn.disabled = true;
    setText(status, 'Searching lands and paths.');
    setTimeout(() => {
      try {
        result = searchPatch(buffer.samples, buffer.rate);
        if (!result) { setText(status, 'No audio in that file.'); useBtn.hidden = true; return; }
        const t = TERRAINS.find((x) => x.id === result.terrain);
        const p = PATHS.find((x) => x.id === result.path);
        setText(status, `Closest: ${t ? t.name : result.terrain}, ${p ? p.name : result.path}.`);
        useBtn.hidden = false;
      } finally {
        searchBtn.disabled = !(buffer && buffer.samples && buffer.samples.length);
      }
    }, 0);
  });
  scope.on(useBtn, 'click', () => {
    if (!result || !ctx.store) return;
    const part = ctx.store.get('ui.selectedPart') || 0;
    applyPatch(ctx.store, part, result);
    setOpen(false);
  });

  return {
    button, panel, dispose: scope.dispose,
    open() { setOpen(true); },
    close() { setOpen(false); },
    isOpen: () => !panel.hidden,
    onToggle(fn) { onToggle = fn; },
  };
}
