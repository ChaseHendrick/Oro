// The viewport's signal card: a live oscilloscope (engine analyser, triggered
// on a rising zero crossing so the trace stands still) next to a "cycle view"
// that computes one exact waveform period by walking the current path across
// the terrain with the same maths the oscillator uses.

import { PART_PARAM_MAP, fromNorm, MOD_PARAM_IDS } from '../core/params.js';
import { h, createScope, watchSize, watchVisibility } from './dom.js';
import { addLoop } from './frame.js';
import { pathPoint, makeTransform, applyTransform, terrainHeight, shapeHeight, cyclePhase } from './dsp-bridge.js';

const CYCLE_IDS = ['pathShape', 'pathOrder', 'pathParam', 'size', 'stretch', 'rotate', 'centerX', 'centerY', 'morph', 'warp', 'lift', 'fold', 'laps', 'pace', 'paceShape'];
const MODDED = new Set(MOD_PARAM_IDS);

/**
 * One oscillator cycle as `n` samples. `p` holds plain parameter values;
 * tables are {size, data}. Returns a Float32Array (empty if no terrain A).
 */
export function sampleCycle(p, tableA, tableB, n = 256, spinPhase = 0, out = new Float32Array(n)) {
  if (!tableA || !tableA.data) return out.fill(0);
  const xf = makeTransform(p.stretch, p.size, p.rotate, spinPhase, p.centerX, p.centerY);
  const pt = { x: 0, y: 0 }, uv = { u: 0, v: 0 };
  const B = tableB && tableB.data ? tableB : null;
  const laps = p.laps ?? 1, pace = p.pace ?? 0, curve = p.paceShape ?? 0;
  for (let i = 0; i < n; i++) {
    pathPoint(p.pathShape, cyclePhase(i / n, laps, pace, curve), p.pathOrder, p.pathParam, pt);
    applyTransform(xf, pt.x, pt.y, uv);
    const hgt = terrainHeight(tableA.data, tableA.size, B ? B.data : null, B ? B.size : 0, p.morph, p.warp, uv.u, uv.v);
    out[i] = shapeHeight(hgt, p.lift, p.fold);
  }
  return out;
}

/**
 * Magnitudes of harmonics 1..count of one periodic cycle (plain DFT; the
 * cycle is short, so this is cheaper than setting up an FFT).
 */
export function harmonics(samples, count = 16, out = new Float32Array(count)) {
  const n = samples.length;
  for (let k = 1; k <= count; k++) {
    let re = 0, im = 0;
    const w = (2 * Math.PI * k) / n;
    for (let i = 0; i < n; i++) {
      re += samples[i] * Math.cos(w * i);
      im -= samples[i] * Math.sin(w * i);
    }
    out[k - 1] = (2 / n) * Math.hypot(re, im);
  }
  return out;
}

/** Index of a rising zero crossing (with a little hysteresis) in the first half. */
export function findTrigger(buf, limit = buf.length >> 1) {
  let armed = false;
  for (let i = 1; i < limit; i++) {
    if (buf[i] < -0.01) armed = true;
    if (armed && buf[i - 1] <= 0 && buf[i] > 0) return i;
  }
  return 0;
}

function sizeCanvas(c, size) {
  if (!size.width || !size.height) return 0;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(size.width * dpr)), hgt = Math.max(1, Math.round(size.height * dpr));
  if (c.width !== w || c.height !== hgt) { c.width = w; c.height = hgt; }
  return dpr;
}

function readColors(el) {
  const cs = getComputedStyle(el);
  return {
    line: cs.getPropertyValue('--part').trim() || '#3fd0c9',
    glow: cs.getPropertyValue('--part-glow').trim() || 'transparent',
    grid: cs.getPropertyValue('--scope-grid').trim() || 'rgba(128,128,128,0.2)',
    fill: cs.getPropertyValue('--part-soft').trim() || 'transparent',
  };
}

function drawTrace(c, size, colors, samples, count, { fill = false, scale = 1 } = {}) {
  const dpr = sizeCanvas(c, size);
  if (!dpr) return false;
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  g.strokeStyle = colors.grid;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, Math.round(H / 2) + 0.5); g.lineTo(W, Math.round(H / 2) + 0.5);
  g.stroke();
  if (!count) return;
  const mid = H / 2, amp = (H / 2 - 3 * dpr) * scale;
  g.beginPath();
  for (let i = 0; i < count; i++) {
    const x = (i / (count - 1)) * W;
    const v = samples(i);
    const y = mid - Math.max(-1.2, Math.min(1.2, v)) * amp;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  if (fill) {
    g.save();
    g.lineTo(W, mid); g.lineTo(0, mid); g.closePath();
    g.fillStyle = colors.fill;
    g.fill();
    g.restore();
    g.beginPath();
    for (let i = 0; i < count; i++) {
      const x = (i / (count - 1)) * W;
      const y = mid - Math.max(-1.2, Math.min(1.2, samples(i))) * amp;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
  }
  g.lineJoin = 'round';
  // A soft halo from a wide translucent stroke: much cheaper than shadowBlur.
  if (document.documentElement.dataset.theme !== 'light') {
    g.lineWidth = 5 * dpr;
    g.strokeStyle = colors.glow;
    g.globalAlpha = 0.35;
    g.stroke();
    g.globalAlpha = 1;
  }
  g.lineWidth = 1.6 * dpr;
  g.strokeStyle = colors.line;
  g.stroke();
}

/** Harmonic bars on a 48 dB log scale relative to the strongest harmonic. */
function drawBars(c, size, colors, mags) {
  const dpr = sizeCanvas(c, size);
  if (!dpr) return;
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  let max = 0;
  for (const m of mags) max = Math.max(max, m);
  const top = 16 * dpr, bottom = H - 4 * dpr, pad = 6 * dpr;
  const n = mags.length;
  const slot = (W - pad * 2) / n;
  const bw = Math.max(1, slot * 0.62);
  g.fillStyle = colors.grid;
  g.fillRect(pad, bottom, W - pad * 2, Math.max(1, dpr));
  if (max < 1e-6) return;
  g.fillStyle = colors.line;
  for (let k = 0; k < n; k++) {
    const db = 20 * Math.log10(Math.max(mags[k], 1e-9) / max);
    const v = Math.max(0, Math.min(1, (db + 48) / 48));
    const hgt = v * (bottom - top);
    if (hgt < 0.5) continue;
    g.globalAlpha = k === 0 ? 1 : 0.85;
    g.fillRect(pad + k * slot + (slot - bw) / 2, bottom - hgt, bw, hgt);
  }
  g.globalAlpha = 1;
}

export function createScopeCard(ctx) {
  const scope = createScope();
  const scopeCanvas = h('canvas', { class: 'scope-canvas', 'aria-hidden': 'true' });
  const cycleCanvas = h('canvas', { class: 'scope-canvas', 'aria-hidden': 'true' });
  const harmCanvas = h('canvas', { class: 'scope-canvas', 'aria-hidden': 'true' });
  const note = h('span', { class: 'scope-note' });
  const el = h('div', { class: 'scope-card', role: 'group', 'aria-label': 'Signal views' },
    h('figure', { class: 'scope-cell', dataset: { tip: 'Live output, triggered so the wave stands still', tipPlace: 'top-start' } },
      scopeCanvas, h('figcaption', { class: 'scope-label' }, 'Output', note)),
    h('figure', { class: 'scope-cell', dataset: { tip: 'One exact cycle: the height of the land under the moving point, sampled along the path', tipPlace: 'top-start' } },
      cycleCanvas, h('figcaption', { class: 'scope-label' }, 'One cycle')),
    h('figure', { class: 'scope-cell scope-cell--harm', dataset: { tip: 'Strength of the first 16 harmonics of that cycle (log scale)', tipPlace: 'top-start' } },
      harmCanvas, h('figcaption', { class: 'scope-label' }, 'Harmonics')));

  const analyser = ctx.engine && ctx.engine.analyser;
  let buf = null;
  if (analyser && typeof analyser.getFloatTimeDomainData === 'function') {
    buf = new Float32Array(Math.min(4096, analyser.fftSize || 2048));
  } else {
    note.textContent = ' (no audio)';
  }

  const cycle = new Float32Array(192);
  let cycleDirty = true;
  let colors = readColors(el);
  const recolor = () => { colors = readColors(el); scopeCanvas.dataset.silent = '0'; cycleDirty = true; };
  scope.on(window, 'orograph:theme', recolor);
  if (ctx.bus) scope.add(ctx.bus.on('part-colors', recolor));
  const markDirty = () => { cycleDirty = true; };
  scope.add(ctx.store.subscribe('parts', markDirty));
  scope.add(ctx.store.subscribe('ui.selectedPart', markDirty));
  if (ctx.terrains) scope.add(ctx.terrains.on(markDirty));

  function cycleParams(part) {
    const base = ctx.store.get(`parts.${part}.params`) || {};
    const p = {};
    for (const id of CYCLE_IDS) {
      let v = base[id] ?? PART_PARAM_MAP[id].default;
      if (MODDED.has(id)) {
        const n = ctx.tele ? ctx.tele.norm(part, id) : null;
        if (n != null) v = fromNorm(PART_PARAM_MAP[id], n);
      }
      p[id] = v;
    }
    return p;
  }

  const vis = watchVisibility(el);
  scope.add(vis.dispose);
  const resized = () => { scopeCanvas.dataset.silent = '0'; scopeCanvas.dataset.drawn = '0'; cycleDirty = true; };
  const scopeSize = watchSize(scopeCanvas, resized);
  const cycleSize = watchSize(cycleCanvas, resized);
  const harmSize = watchSize(harmCanvas, resized);
  scope.add(harmSize.dispose);
  const harm = new Float32Array(16);
  scope.add(scopeSize.dispose);
  scope.add(cycleSize.dispose);

  let peakHold = 0;
  scope.add(addLoop(() => {
    if (!vis.visible() || !el.isConnected) return;
    // Scope
    if (buf && analyser) {
      try { analyser.getFloatTimeDomainData(buf); } catch { /* context closed */ }
      const start = findTrigger(buf);
      const count = Math.min(1024, buf.length - start);
      let peak = 0;
      for (let i = 0; i < buf.length; i += 4) peak = Math.max(peak, Math.abs(buf[i]));
      peakHold = Math.max(peak, peakHold * 0.92);
      const silent = peakHold < 1e-4;
      if (!(silent && scopeCanvas.dataset.silent === '1')) {
        const gain = peakHold > 0.02 ? Math.min(4, 0.9 / peakHold) : 1;
        const drawn = drawTrace(scopeCanvas, scopeSize.size, colors, i => buf[start + i] * gain, count);
        scopeCanvas.dataset.silent = silent && drawn !== false ? '1' : '0';
      }
    } else if (scopeCanvas.dataset.drawn !== '1') {
      drawTrace(scopeCanvas, scopeSize.size, colors, () => 0, 0);
      scopeCanvas.dataset.drawn = '1';
    }
    // Cycle (every frame while telemetry moves the parameters, otherwise on change)
    const part = ctx.binder.selected();
    if (cycleDirty || (ctx.tele && ctx.tele.fresh())) {
      cycleDirty = false;
      const p = cycleParams(part);
      const A = ctx.terrains ? ctx.terrains.get(part, 'A') : null;
      const B = ctx.terrains ? ctx.terrains.get(part, 'B') : null;
      const spin = ctx.tele ? ctx.tele.spinPhase(part) : null;
      sampleCycle(p, A, B, cycle.length, spin || 0, cycle);
      drawTrace(cycleCanvas, cycleSize.size, colors, i => cycle[i % cycle.length], cycle.length + 1, { fill: true, scale: 1 / 1.25 });
      harmonics(cycle, harm.length, harm);
      drawBars(harmCanvas, harmSize.size, colors, harm);
    }
  }));

  return { el, dispose: scope.dispose };
}
