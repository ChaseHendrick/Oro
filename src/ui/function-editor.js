// The track's Function (v2.4): a drawable curve used as the 'Function' Link
// source. Click to add a point, drag to move one, double-click (or
// right-click) to remove one; the end points stay at the edges.
import { h, createScope } from './dom.js';
import { schedule } from './frame.js';
import { createKnob } from './knob.js';
import { createSelect, createToggle } from './controls.js';
import { funcValue, sanitizeFuncPoints, FUNC_MAX_POINTS } from '../dsp/function-gen.js';

const W = 280, H = 112, PAD = 8;

export function createFunctionEditor(ctx) {
  const scope = createScope();
  const { store, binder } = ctx;
  const path = () => `parts.${binder.selected()}.funcPoints`;
  const get = () => sanitizeFuncPoints(store.get(path()));
  const put = (pts) => store.set(path(), sanitizeFuncPoints(pts), { source: 'ui' });

  const canvas = h('canvas', { class: 'func-canvas', width: String(W * 2), height: String(H * 2), role: 'img', 'aria-label': 'Function curve. Click to add a point, drag to move, double-click to remove.' });
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  const g = canvas.getContext && canvas.getContext('2d');
  const toPx = (x, y) => [PAD + x * (W - 2 * PAD), PAD + (1 - (y + 1) / 2) * (H - 2 * PAD)];
  const fromPx = (px, py) => [(px - PAD) / (W - 2 * PAD), 1 - 2 * (py - PAD) / (H - 2 * PAD)].map((v, i) => i === 0 ? Math.min(1, Math.max(0, v)) : Math.min(1, Math.max(-1, v)));

  function draw() {
    if (!g) return;
    const pts = get(), smooth = Number(store.get(`parts.${binder.selected()}.params.funcSmooth`)) || 0;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const css = getComputedStyle(canvas);
    g.setTransform(2, 0, 0, 2, 0, 0);
    g.clearRect(0, 0, W, H);
    g.strokeStyle = css.getPropertyValue('--border') || '#888'; g.lineWidth = 1;
    const [, mid] = toPx(0, 0);
    g.beginPath(); g.moveTo(PAD, mid); g.lineTo(W - PAD, mid); g.stroke();
    g.strokeStyle = css.getPropertyValue('--accent') || '#c96'; g.lineWidth = 2;
    g.beginPath();
    for (let i = 0; i <= 200; i++) {
      const t = i / 200, [px, py] = toPx(t, funcValue(xs, ys, pts.length, t, smooth));
      if (i) g.lineTo(px, py); else g.moveTo(px, py);
    }
    g.stroke();
    g.fillStyle = css.getPropertyValue('--text') || '#eee';
    for (const [x, y] of pts) { const [px, py] = toPx(x, y); g.beginPath(); g.arc(px, py, 4, 0, Math.PI * 2); g.fill(); }
  }

  let drag = -1;
  const local = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height]; };
  const hit = (pts, px, py) => pts.findIndex(([x, y]) => { const [qx, qy] = toPx(x, y); return Math.hypot(qx - px, qy - py) < 9; });
  scope.on(canvas, 'pointerdown', (e) => {
    const [px, py] = local(e), pts = get();
    let i = hit(pts, px, py);
    if (e.button === 2) { if (i > 0 && i < pts.length - 1) { pts.splice(i, 1); put(pts); } return; }
    if (i < 0 && pts.length < FUNC_MAX_POINTS) {
      const [x, y] = fromPx(px, py);
      pts.push([x, y]); pts.sort((a, b) => a[0] - b[0]);
      i = pts.findIndex(p => p[0] === x && p[1] === y);
      put(pts);
    }
    drag = i;
    if (drag >= 0) canvas.setPointerCapture?.(e.pointerId);
  });
  scope.on(canvas, 'pointermove', (e) => {
    if (drag < 0) return;
    const pts = get(), [x, y] = fromPx(...local(e));
    const lo = drag === 0 ? 0 : pts[drag - 1][0], hi = drag === pts.length - 1 ? 1 : pts[drag + 1][0];
    pts[drag] = [drag === 0 ? 0 : drag === pts.length - 1 ? 1 : Math.min(hi, Math.max(lo, x)), y];
    put(pts);
  });
  scope.on(canvas, 'pointerup', () => { drag = -1; });
  scope.on(canvas, 'dblclick', (e) => {
    const pts = get(), i = hit(pts, ...local(e));
    if (i > 0 && i < pts.length - 1) { pts.splice(i, 1); put(pts); }
  });
  scope.on(canvas, 'contextmenu', (e) => e.preventDefault());

  const mode = createSelect(ctx, binder.partParam('funcMode'), { label: 'Function mode', className: 'select--sm' });
  const sync = createToggle(ctx, binder.partParam('funcSync'), { label: 'Sync', className: 'toggle--sm' });
  const div = createSelect(ctx, binder.partParam('funcDiv'), { label: 'Function length', className: 'select--sm' });
  const rate = createKnob(ctx, binder.partParam('funcRate'), { size: 'sm' });
  const smooth = createKnob(ctx, binder.partParam('funcSmooth'), { size: 'sm' });
  for (const c of [mode, sync, div, rate, smooth]) scope.add(c.dispose);
  const reset = h('button', { type: 'button', class: 'btn btn--ghost btn--xs' }, 'Reset');
  scope.on(reset, 'click', () => put(null));

  scope.add(store.subscribe('parts', (p) => { if (p === 'parts' || /^parts\.\d+(\.funcPoints.*|\.params\.funcSmooth)?$/.test(p)) schedule(draw); }));
  scope.add(store.subscribe('ui.selectedPart', () => schedule(draw)));
  schedule(draw);

  const el = h('section', { class: 'links-function', 'aria-labelledby': 'sec-function' },
    h('header', { class: 'section-head' }, h('h3', { class: 'section-title', id: 'sec-function' }, 'Function'), reset),
    h('p', { class: 'links-note' }, 'Draw a curve, then pick Function as a link source. Click to add a point, drag to move, double-click to remove.'),
    h('div', { class: 'func-body' }, canvas,
      h('div', { class: 'func-controls' }, mode.el, h('div', { class: 'func-sync' }, sync.el, div.el), h('div', { class: 'knob-row' }, rate.el, smooth.el))));
  return { el, dispose: scope.dispose };
}
