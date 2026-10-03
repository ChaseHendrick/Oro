// v2.9 Ghost replay controls (src/music/ghost.js): ctx.ghost, the Ghost block
// in the Seq tab, the track menu entries and the ghost dot on the map.

import { h, createScope, setText } from './dom.js';
import { addLoop } from './frame.js';
import { icon } from './icons.js';
import { partCount } from '../core/tracks.js';
import { createGhosts } from '../music/ghost.js';
import { GHOST_MAX_BARS } from '../music/ghost-data.js';
import { found } from '../core/fun.js';

const browserTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
};

/** Make ctx.ghost (null without the music engine) and keep the ghost dot on the map in step. */
export function installGhost(ctx, scope) {
  ctx.ghost = null;
  const m = ctx.music;
  if (!m || !m.router || !m.transport || !m.timebase) return null;
  const ghost = createGhosts({ store: ctx.store, router: m.router, transport: m.transport, timebase: m.timebase, timers: browserTimers });
  ctx.ghost = ghost;
  scope.add(() => ghost.dispose());
  scope.add(ghost.on('change', (e) => { if (e && e.kind === 'record-stop' && e.ok) found('badge', 'ghost-recorded'); }));
  const vis = ctx.visuals;
  if (vis && typeof vis.setGhost === 'function') {
    let shown = -1;
    scope.add(addLoop(() => {
      const p = Math.round(Number(ctx.store.get('ui.selectedPart')) || 0);
      const pos = ghost.dotAt(p);
      if (shown >= 0 && shown !== p) { vis.setGhost(shown, null); shown = -1; }
      if (pos) { vis.setGhost(p, pos); shown = p; } else if (shown === p) { vis.setGhost(p, null); shown = -1; }
    }));
  }
  return ghost;
}

const trackName = (store, i) => store.get(`parts.${i}.name`) || `Track ${i + 1}`;

/** Status line for track `p`. */
export function ghostStatus(ctx, p) {
  const g = ctx.ghost;
  if (!g) return 'Ghost replay needs the music engine, which is not available here.';
  if (g.isRecording(p)) return `Recording a ghost from bar ${g.recordingFrom() + 1}. Press Stop recording when you are done (${GHOST_MAX_BARS} bars at most).`;
  if (g.isRecording()) return 'A ghost is being recorded on another track.';
  const s = g.summary(p);
  if (!s) return 'Record a ghost of what you play here (notes, knob moves, the dot), then let it play while you play along on any track.';
  const what = `${s.bars} bar${s.bars === 1 ? '' : 's'} from bar ${s.startBar + 1}: ${s.notes} note${s.notes === 1 ? '' : 's'}, ${s.knobs} knob value${s.knobs === 1 ? '' : 's'}, ${s.dots} dot point${s.dots === 1 ? '' : 's'}`;
  if (g.isPlaying(p)) return ctx.store.get('ui.playing') ? `Ghost playing, ${what}.` : `Ghost on, ${what}. It plays while the transport runs.`;
  return `Ghost ready, ${what}.`;
}

/** The Ghost block of the Seq tab (for the selected track). */
export function createGhostBar(ctx) {
  const scope = createScope();
  const { store } = ctx;
  const sel = () => Math.max(0, Math.min(partCount(store) - 1, Math.round(Number(store.get('ui.selectedPart')) || 0)));
  const recText = h('span', { class: 'toggle-text' }, 'Record ghost');
  const playText = h('span', { class: 'toggle-text' }, 'Play ghost');
  const btn = (name, text, label) => h('button', { type: 'button', class: 'toggle toggle--sm has-icon seq-capture-btn seq-ghost-btn', 'aria-pressed': 'false', 'aria-label': label, html: icon(name) }, text);
  const recBtn = btn('record', recText, 'Record ghost');
  const playBtn = btn('ghost', playText, 'Play ghost');
  const clearBtn = h('button', { type: 'button', class: 'toggle toggle--sm has-icon seq-capture-btn seq-ghost-btn', 'aria-label': 'Clear ghost', html: icon('trash') + '<span class="toggle-text">Clear</span>' });
  const status = h('p', { class: 'seq-capture-status seq-ghost-status', role: 'status' });
  const el = h('div', { class: 'seq-ghost', role: 'group', 'aria-label': 'Ghost replay' },
    h('span', { class: 'mini-label' }, 'Ghost'),
    h('div', { class: 'seq-line seq-capture' }, recBtn, playBtn, clearBtn),
    status);
  let note = '';
  const g = ctx.ghost;
  function render() {
    const p = sel();
    const rec = !!g && g.isRecording(p), play = !!g && g.isPlaying(p), has = !!g && g.has(p);
    recBtn.setAttribute('aria-pressed', String(rec));
    recBtn.classList.toggle('is-on', rec);
    recText.textContent = rec ? 'Stop recording' : 'Record ghost';
    recBtn.setAttribute('aria-label', rec ? 'Stop recording ghost' : 'Record ghost');
    playBtn.setAttribute('aria-pressed', String(play));
    playBtn.classList.toggle('is-on', play);
    playText.textContent = play ? 'Stop ghost' : 'Play ghost';
    playBtn.setAttribute('aria-label', play ? 'Stop ghost' : 'Play ghost');
    recBtn.disabled = !g;
    playBtn.disabled = !g || !has;
    clearBtn.disabled = !g || !has;
    setText(status, note || ghostStatus(ctx, p));
  }
  const act = (fn) => () => {
    if (!g) return;
    const res = fn(sel());
    note = res && res.message && !res.ok ? res.message : '';
    render();
  };
  scope.on(recBtn, 'click', act((p) => g.toggleRecord(p)));
  scope.on(playBtn, 'click', act((p) => g.togglePlay(p)));
  scope.on(clearBtn, 'click', act((p) => g.clear(p)));
  if (g) scope.add(g.on('change', (e) => { if (e && e.kind === 'record-stop' && e.message) note = e.ok ? '' : e.message; render(); }));
  scope.add(store.subscribe('ui.selectedPart', () => { note = ''; render(); }));
  scope.add(store.subscribe('ui.playing', render));
  scope.add(store.subscribe('parts', (path) => { if (path === 'parts' || /^parts\.\d+(\.ghost)?$/.test(path)) render(); }));
  render();
  return { el, dispose: scope.dispose };
}

/** Track menu entries for track `i`. */
export function ghostMenuItems(ctx, i) {
  const g = ctx.ghost;
  if (!g) return [];
  const say = (res) => { if (res && res.message) ctx.toast(res.message, { kind: res.ok === false ? 'info' : 'success' }); };
  return [
    { label: g.isRecording(i) ? 'Stop recording ghost' : 'Record ghost', icon: icon('record'), onSelect: () => say(g.toggleRecord(i)) },
    { label: g.isPlaying(i) ? 'Stop ghost' : 'Play ghost', icon: icon('ghost'), disabled: !g.has(i), onSelect: () => say(g.togglePlay(i)) },
    { label: 'Clear ghost', icon: icon('trash'), disabled: !g.has(i), onSelect: () => say(g.clear(i)) },
  ];
}
