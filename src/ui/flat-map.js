// A flat, top-down map of the selected part's terrain with its path and dot.
// The UI shows it when the 3D view cannot start (no WebGL), so placing the dot
// anywhere on the map always works: click or drag to move it.
//
// Kept cheap because it can run on software rendering: sizes and colours are
// cached (no layout or style reads per frame), the terrain image is rebuilt at
// most a few times a second, and glows are layered strokes, not shadowBlur.

import { PART_PARAM_MAP, fromNorm, clamp } from '../core/params.js';
import { h, createScope, watchSize, watchVisibility } from './dom.js';
import { addLoop } from './frame.js';
import { drawTerrain } from './terrain-art.js';
import { pathPoint, makeTransform, applyTransform, terrainHeight } from './dsp-bridge.js';
import { partCount } from '../core/tracks.js';

const RES = 112;
const REBUILD_MS = 120;

export function createFlatMap(container, { store, terrains, tele = null, source = 'ui' }) {
  const scope = createScope();
  const canvas = h('canvas', { class: 'flatmap-canvas', 'aria-label': 'Map of the terrain. Click or drag to move the dot.', role: 'img' });
  const el = h('div', { class: 'flatmap' }, canvas);
  container.appendChild(el);
  const terrainCanvas = document.createElement('canvas');
  terrainCanvas.width = RES; terrainCanvas.height = RES;
  let terrainKey = '';
  let lastBuild = 0;
  let dirty = true;
  const sel = () => clamp(Math.round(store.get('ui.selectedPart') || 0), 0, partCount(store) - 1);
  const size = watchSize(canvas, () => { dirty = true; });
  const vis = watchVisibility(el);
  scope.add(size.dispose);
  scope.add(vis.dispose);

  let color = '#3fd0c9';
  let theme = 'dark';
  const readStyle = () => {
    color = getComputedStyle(el).getPropertyValue('--part').trim() || color;
    theme = document.documentElement.dataset.theme || 'dark';
    dirty = true;
  };
  readStyle();
  scope.on(window, 'orograph:theme', () => requestAnimationFrame(readStyle));
  scope.add(store.subscribe('ui.selectedPart', () => requestAnimationFrame(readStyle)));
  scope.add(store.subscribe('parts', (path) => { if (/\.color$/.test(path)) requestAnimationFrame(readStyle); }));

  function live(part, id) {
    const base = store.get(`parts.${part}.params.${id}`);
    const n = tele ? tele.norm(part, id) : null;
    return n != null ? fromNorm(PART_PARAM_MAP[id], n) : base;
  }

  function rebuildTerrain(part, now) {
    const morph = live(part, 'morph') || 0, warp = live(part, 'warp') || 0;
    const key = `${part}|${morph.toFixed(2)}|${warp.toFixed(2)}|${theme}|${color}`;
    if (!dirty && (key === terrainKey || now - lastBuild < REBUILD_MS)) return;
    const A = terrains.get(part, 'A'), B = terrains.get(part, 'B');
    dirty = false;
    terrainKey = key;
    lastBuild = now;
    if (!A) { drawTerrain(terrainCanvas, null); return; }
    const data = new Float32Array(RES * RES);
    for (let y = 0; y < RES; y++) {
      for (let x = 0; x < RES; x++) {
        data[y * RES + x] = terrainHeight(A.data, A.size, B ? B.data : null, B ? B.size : 0, morph, warp, x / RES, y / RES);
      }
    }
    drawTerrain(terrainCanvas, { size: RES, data }, { color: store.get(`parts.${part}.color`), theme, contours: true });
  }

  function geometry() {
    const { width, height } = size.size;
    const side = Math.min(width, height) * 0.92;
    return { side, left: (width - side) / 2, top: (height - side) / 2 };
  }

  const pt = { x: 0, y: 0 }, uv = { u: 0, v: 0 };
  const P = {};
  function draw(now) {
    const part = sel();
    rebuildTerrain(part, now);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(size.size.width * dpr), H = Math.round(size.size.height * dpr);
    if (!W || !H) return;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, W, H);
    const { side, left, top } = geometry();
    const S = side * dpr, L = left * dpr, T = top * dpr;
    g.imageSmoothingEnabled = true;
    g.fillStyle = theme === 'light' ? 'rgba(90,60,25,0.10)' : 'rgba(0,0,0,0.35)';
    g.fillRect(L + 4 * dpr, T + 8 * dpr, S, S);
    g.drawImage(terrainCanvas, L, T, S, S);

    for (const id of ['pathShape', 'pathOrder', 'pathParam', 'size', 'stretch', 'rotate', 'centerX', 'centerY']) P[id] = live(part, id);
    const spin = tele ? tele.spinPhase(part) || 0 : 0;
    const xf = makeTransform(P.stretch, P.size, P.rotate, spin, P.centerX, P.centerY);
    g.save();
    g.beginPath();
    g.rect(L, T, S, S);
    g.clip();
    g.beginPath();
    let px = null, py = null;
    for (let i = 0; i <= 200; i++) {
      pathPoint(P.pathShape, (i % 200) / 200, P.pathOrder, P.pathParam, pt);
      applyTransform(xf, pt.x, pt.y, uv);
      const x = L + (uv.u - Math.floor(uv.u)) * S, y = T + (uv.v - Math.floor(uv.v)) * S;
      if (px == null || Math.abs(x - px) > S / 2 || Math.abs(y - py) > S / 2) g.moveTo(x, y); else g.lineTo(x, y);
      px = x; py = y;
    }
    g.lineJoin = 'round';
    if (theme !== 'light') {
      g.strokeStyle = color;
      g.globalAlpha = 0.28;
      g.lineWidth = 7 * dpr;
      g.stroke();
      g.globalAlpha = 1;
    }
    g.strokeStyle = color;
    g.lineWidth = 2 * dpr;
    g.stroke();
    const cx = L + (P.centerX - Math.floor(P.centerX)) * S, cy = T + (P.centerY - Math.floor(P.centerY)) * S;
    g.fillStyle = color;
    g.globalAlpha = 0.25;
    g.beginPath(); g.arc(cx, cy, 13 * dpr, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;
    g.beginPath(); g.arc(cx, cy, 6 * dpr, 0, Math.PI * 2); g.fill();
    g.lineWidth = 2 * dpr;
    g.strokeStyle = theme === 'light' ? '#fffaf0' : '#0b1020';
    g.stroke();
    g.restore();
  }

  scope.add(addLoop((now) => { if (vis.visible() && el.isConnected) draw(now); }));
  if (terrains) scope.add(terrains.on(() => { dirty = true; }));

  let dragging = null;
  function moveTo(e) {
    const r = canvas.getBoundingClientRect();
    const { side, left, top } = geometry();
    const u = (e.clientX - r.left - left) / side, v = (e.clientY - r.top - top) / side;
    if (dragging === 'start' && (u < -0.02 || u > 1.02 || v < -0.02 || v > 1.02)) return false;
    const part = sel();
    store.batch(() => {
      store.set(`parts.${part}.params.centerX`, clamp(u, 0, 1), { source });
      store.set(`parts.${part}.params.centerY`, clamp(v, 0, 1), { source });
    });
    return true;
  }
  scope.on(canvas, 'pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging = 'start';
    if (!moveTo(e)) { dragging = null; return; }
    dragging = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    el.classList.add('is-dragging');
  });
  scope.on(canvas, 'pointermove', (e) => { if (dragging === e.pointerId) moveTo(e); });
  const end = () => { dragging = null; el.classList.remove('is-dragging'); };
  scope.on(canvas, 'pointerup', end);
  scope.on(canvas, 'pointercancel', end);

  return { el, canvas, dispose() { scope.dispose(); el.remove(); } };
}
