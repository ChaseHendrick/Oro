// Terrain previews: small shaded heightmap thumbnails in the part's palette,
// drawn from the engine's live tables when available and from the DSP
// generators otherwise (for the picker grid). Cached, generated lazily so
// opening the picker never stalls the audio thread's neighbour, the UI.

import { terrainRamp } from './color.js';
import { generateTerrain, hasGenerator } from './dsp-bridge.js';

/**
 * Draw a terrain table into a canvas with a colour ramp and hill shading.
 * `data` is size*size heights in [-1, 1] (row-major, v down).
 */
export function drawTerrain(canvas, table, { color = '#3fd0c9', theme = 'dark', contours = false } = {}) {
  const ctx2 = canvas.getContext('2d');
  if (!ctx2) return;
  const W = canvas.width, H = canvas.height;
  if (!table || !table.data) {
    ctx2.clearRect(0, 0, W, H);
    return;
  }
  const { data, size } = table;
  const lut = terrainRamp(color, theme);
  const img = ctx2.createImageData(W, H);
  const px = img.data;
  const sx = size / W, sy = size / H;
  const at = (x, y) => {
    const i = ((Math.floor(y * sy) % size) + size) % size;
    const j = ((Math.floor(x * sx) % size) + size) % size;
    return data[i * size + j];
  };
  const light = theme === 'light' ? 0.55 : 0.75;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const h = at(x, y);
      const slope = (at(x - 1, y - 1) - at(x + 1, y + 1));
      let li = Math.round(((h + 1) / 2) * 255);
      li = li < 0 ? 0 : li > 255 ? 255 : li;
      const shade = 1 + slope * light * (W / 32);
      const k = shade < 0.55 ? 0.55 : shade > 1.45 ? 1.45 : shade;
      const o = (y * W + x) * 4;
      px[o] = lut[li * 3] * k;
      px[o + 1] = lut[li * 3 + 1] * k;
      px[o + 2] = lut[li * 3 + 2] * k;
      px[o + 3] = 255;
      if (contours) {
        const band = Math.floor((h + 1) * 5);
        const right = Math.floor((at(x + 1, y) + 1) * 5), down = Math.floor((at(x, y + 1) + 1) * 5);
        if (band !== right || band !== down) {
          const c = theme === 'light' ? 0.78 : 1.35;
          px[o] *= c; px[o + 1] *= c; px[o + 2] *= c;
        }
      }
    }
  }
  ctx2.putImageData(img, 0, 0);
}

/** Downsample a large table to `n` x `n` (box filter) for fast thumbnails. */
export function downsample(table, n) {
  if (!table || !table.data) return null;
  const { data, size } = table;
  if (size <= n) return table;
  const k = size / n;
  const out = new Float32Array(n * n);
  const step = Math.max(1, Math.floor(k / 2));
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let sum = 0, cnt = 0;
      const y0 = Math.floor(y * k), x0 = Math.floor(x * k);
      for (let yy = 0; yy < k; yy += step) {
        for (let xx = 0; xx < k; xx += step) {
          sum += data[(y0 + Math.floor(yy)) * size + x0 + Math.floor(xx)];
          cnt++;
        }
      }
      out[y * n + x] = sum / cnt;
    }
  }
  return { size: n, data: out };
}

const cache = new Map();
const queue = [];
let pumping = false;
let urgent = false;

function runJob() {
  const job = queue.shift();
  if (!job) return false;
  if (!cache.has(job.key)) cache.set(job.key, generateTerrain(job.index, { size: job.size, seed: job.seed, detail: job.detail }));
  for (const cb of job.cbs) { try { cb(cache.get(job.key)); } catch { /* widget gone */ } }
  return true;
}

function pump() {
  if (pumping) return;
  pumping = true;
  const next = () => {
    if (!queue.length) { pumping = false; urgent = false; return; }
    if (urgent || typeof requestIdleCallback !== 'function') {
      // Someone is looking at the picker: one small table per task keeps input responsive.
      setTimeout(() => { runJob(); next(); }, 0);
    } else {
      requestIdleCallback((deadline) => {
        do { if (!runJob()) break; } while (deadline.timeRemaining() > 12);
        next();
      }, { timeout: 400 });
    }
  };
  next();
}

/** Get (or lazily generate) a preview table for a terrain type. */
export function previewTable(index, { seed = 7, detail = 0.5, size = 64 } = {}, cb, now = false) {
  if (!hasGenerator) { cb(null); return; }
  const key = `${index}|${seed}|${detail.toFixed(2)}|${size}`;
  if (cache.has(key)) { cb(cache.get(key)); return; }
  if (now) urgent = true;
  const pending = queue.find(j => j.key === key);
  if (pending) { pending.cbs.push(cb); return; }
  queue.push({ key, index, seed, detail, size, cbs: [cb] });
  if (cache.size > 160) cache.delete(cache.keys().next().value);
  pump();
}

/** Generate every terrain's preview in idle time so the picker opens instantly. */
export function prewarmPreviews(count, opts) {
  for (let i = 0; i < count; i++) previewTable(i, opts, () => {});
}
