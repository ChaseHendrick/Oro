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
  const useBtn = h('button', { type: 'button', class: 'btn btn--sm', hidden: true }, 'Use this patch');
  useBtn.hidden = true;
  const panel = h('div', { class: 'sound-match', hidden: true },
    h('h3', { class: 'section-title' }, 'Match a sound'),
    h('p', { class: 'sound-match-hint' }, 'Experimental. This picks a terrain and a path from a short list. It does not render each patch, so the result is a starting point, not a copy of the sound.'),
    file, searchBtn, useBtn, status);
  panel.hidden = true;
  const button = h('button', { type: 'button', class: 'btn btn--ghost btn--sm' }, 'Match a sound');

  async function readFile(f) {
    if (decode) return decode(f);
    const ctxAudio = new AudioContext();
    const audio = await ctxAudio.decodeAudioData(await f.arrayBuffer());
    const ch = audio.getChannelData(0);
    return { samples: ch, rate: audio.sampleRate };
  }

  scope.on(button, 'click', () => { panel.hidden = false; });
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
    result = searchPatch(buffer.samples, buffer.rate);
    if (!result) { setText(status, 'No audio in that file.'); return; }
    const t = TERRAINS.find((x) => x.id === result.terrain);
    const p = PATHS.find((x) => x.id === result.path);
    setText(status, `Closest: ${t ? t.name : result.terrain}, ${p ? p.name : result.path}.`);
    useBtn.hidden = false;
  });
  scope.on(useBtn, 'click', () => {
    if (!result || !ctx.store) return;
    const part = ctx.store.get('ui.selectedPart') || 0;
    applyPatch(ctx.store, part, result);
    panel.hidden = true;
  });

  return { button, panel, dispose: scope.dispose, open() { panel.hidden = false; } };
}
