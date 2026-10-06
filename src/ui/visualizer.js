// Visualizers (2.17.1): other things to look at in place of the 3D map.
//
//   Scope        the output as a wave, left and right, held still on the pitch
//   Spectrum     how loud each frequency is, 20 Hz to 20 kHz, with peak hold
//   Waterfall    the spectrum over time, scrolling, brighter where it is louder
//   Stereo field left against right (a goniometer): a vertical line is mono,
//                wide shapes are wide stereo; a correlation meter below
//   Halo         a ring of the spectrum around one cycle of the live wave
//
// They read the master output after the effects (the engine's analyser, so
// what you hear apart from the listening mode), through analysers of their
// own that are connected to nothing onward: they cannot change the sound.
// While one is showing, the 3D map stops drawing (setCovered) to save the
// GPU; dots that roll or drift keep moving, because they shape the sound.
// Everything is drawn on one 2D canvas, so it also works where WebGL does not.

import { h, createScope, watchSize, watchVisibility, pixelRatioOf } from './dom.js';
import { addLoop } from './frame.js';
import { findTrigger } from './scope.js';

export const VISUALIZERS = Object.freeze([
  { value: 'map', label: 'Map', icon: 'map', hint: 'The 3D land, the orbit and the dot' },
  { value: 'scope', label: 'Scope', icon: 'scope', hint: 'The wave you hear, left and right' },
  { value: 'spectrum', label: 'Spectrum', icon: 'spectrum', hint: 'Loudness by frequency, with peaks' },
  { value: 'waterfall', label: 'Waterfall', icon: 'waterfall', hint: 'The spectrum scrolling over time' },
  { value: 'vector', label: 'Stereo field', icon: 'vector', hint: 'Left against right, and how wide' },
  { value: 'halo', label: 'Halo', icon: 'halo', hint: 'A ring of frequencies around the live wave' },
]);
export const VISUALIZER_IDS = Object.freeze(VISUALIZERS.map((v) => v.value));

export const FFT_SIZE = 8192;
export const SCOPE_SIZE = 4096;
export const MIN_HZ = 20;
export const MAX_HZ = 20000;
export const DB_FLOOR = -96;
export const DB_TOP = -12;
export const TILT_DB_PER_OCTAVE = 3;   // a pink-noise tilt, so music reads roughly flat

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** The frequency at position t (0..1) on a log axis. */
export function logHz(t, lo = MIN_HZ, hi = MAX_HZ) {
  return lo * Math.pow(hi / lo, t);
}

/**
 * For `count` positions on a log frequency axis, the FFT bin range each one
 * covers: { from: Int32Array, to: Int32Array, hz: Float32Array }. Low
 * positions that fall between bins share the nearest bin.
 */
export function logBands(count, sampleRate, fftSize = FFT_SIZE, lo = MIN_HZ, hi = Math.min(MAX_HZ, sampleRate / 2)) {
  const bins = fftSize / 2;
  const binHz = sampleRate / fftSize;
  const from = new Int32Array(count), to = new Int32Array(count), hz = new Float32Array(count), at = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const f0 = logHz(i / count, lo, hi), f1 = logHz((i + 1) / count, lo, hi);
    let a = Math.floor(f0 / binHz), b = Math.ceil(f1 / binHz);
    a = clamp(a, 1, bins - 1);
    b = clamp(Math.max(b, a + 1), a + 1, bins);
    from[i] = a; to[i] = b; hz[i] = Math.sqrt(f0 * f1);
    // narrower than a bin: read between the two nearest bins instead (smooth low notes)
    at[i] = f1 - f0 < binHz ? clamp(hz[i] / binHz, 1, bins - 2) : -1;
  }
  return { from, to, hz, at };
}

/** dB of each band (the loudest bin in it), tilted so pink noise is flat, into out. */
export function bandLevels(freqDb, bands, out = new Float32Array(bands.from.length)) {
  for (let i = 0; i < out.length; i++) {
    let m = -Infinity;
    const at = bands.at ? bands.at[i] : -1;
    if (at >= 0) {
      const k = Math.floor(at), f = at - k, a = freqDb[k], b = freqDb[k + 1];
      m = Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * f : Math.max(a, b);
    } else for (let k = bands.from[i]; k < bands.to[i]; k++) if (freqDb[k] > m) m = freqDb[k];
    out[i] = Number.isFinite(m) ? m + TILT_DB_PER_OCTAVE * Math.log2(bands.hz[i] / 1000) : DB_FLOOR;
  }
  return out;
}

/** 0..1 for a dB value between the floor and the top. */
export const dbNorm = (db) => clamp((db - DB_FLOOR) / (DB_TOP - DB_FLOOR), 0, 1);

/** Samples from `start` to the next rising zero crossing: one period, or 0 when none is clear. */
export function estimatePeriod(buf, start, maxLen = buf.length >> 1) {
  let armed = false;
  const end = Math.min(buf.length, start + maxLen);
  for (let i = start + 2; i < end; i++) {
    if (buf[i] < -0.01) armed = true;
    if (armed && buf[i - 1] <= 0 && buf[i] > 0) return i - start;
  }
  return 0;
}

/** Correlation of left and right, -1 (opposite) .. 1 (mono). 0 when silent. */
export function correlation(L, R) {
  let lr = 0, ll = 0, rr = 0;
  for (let i = 0; i < L.length; i++) { lr += L[i] * R[i]; ll += L[i] * L[i]; rr += R[i] * R[i]; }
  const d = Math.sqrt(ll * rr);
  return d > 1e-12 ? clamp(lr / d, -1, 1) : 0;
}

// -------------------------------------------------------------------- colours

let probe = null;
/** Any CSS colour as [r, g, b, a] (0..255), through a 1x1 canvas. */
function rgbaOf(css, fallback = [128, 128, 128, 255]) {
  try {
    if (!probe) { probe = document.createElement('canvas'); probe.width = probe.height = 1; }
    const g = probe.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = '#000';
    g.fillStyle = css;
    g.fillRect(0, 0, 1, 1);
    return Array.from(g.getImageData(0, 0, 1, 1).data);
  } catch { return fallback; }
}

function readColors(el) {
  const cs = getComputedStyle(el);
  const v = (name, d) => cs.getPropertyValue(name).trim() || d;
  const c = {
    bg: v('--bg', '#070a12'), text: v('--text', '#e8ecf6'), dim: v('--text-dim', '#6f7a92'),
    part: v('--part', '#3fd0c9'), accent: v('--accent', '#8fb6ff'), grid: v('--scope-grid', 'rgba(150,168,214,0.14)'),
  };
  const bg = rgbaOf(c.bg), part = rgbaOf(c.part), accent = rgbaOf(c.accent), text = rgbaOf(c.text);
  c.bgRgb = bg;
  c.light = (bg[0] + bg[1] + bg[2]) / 3 > 140;
  // the waterfall's colour map: background, track colour, accent, then text colour at the loudest
  c.lut = new Uint8ClampedArray(256 * 3);
  const stops = [[0, bg], [0.38, part], [0.72, accent], [1, text]];
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, a] = stops[k], [t1, b] = stops[k + 1];
    const f = clamp((t - t0) / (t1 - t0), 0, 1);
    for (let j = 0; j < 3; j++) c.lut[i * 3 + j] = a[j] + (b[j] - a[j]) * f;
  }
  return c;
}

// ------------------------------------------------------------------- the view

/**
 * The visualizer layer for the viewport. ctx: { store, engine, visuals }.
 * Returns { el, dispose }. It follows ui.visualizer.
 */
export function createVisualizer(ctx, viewportEl) {
  const scope = createScope();
  const { store } = ctx;
  const canvas = h('canvas', { class: 'viz-canvas', 'aria-hidden': 'true' });
  const label = h('div', { class: 'viz-label' });
  const el = h('div', { class: 'viz-layer', role: 'img', hidden: true }, canvas, label);
  viewportEl.appendChild(el);

  let mode = 'map';
  let colors = null;
  let tap = null;   // { ac, src, split, mono, left, right, freq, timeL, timeR, timeM }
  const size = watchSize(canvas, () => { dirty = true; });
  scope.add(size.dispose);
  const vis = watchVisibility(el);
  scope.add(vis.dispose);
  let dirty = true;
  const recolor = () => { colors = null; dirty = true; };
  scope.on(window, 'orograph:theme', recolor);
  if (ctx.bus) scope.add(ctx.bus.on('part-colors', recolor));
  scope.add(store.subscribe('ui.selectedPart', recolor));

  function connect() {
    const engine = ctx.engine;
    const ac = engine && engine.context;
    const src = engine && engine.analyser;
    if (!ac || !src || typeof ac.createAnalyser !== 'function') return null;
    if (tap && tap.ac === ac && tap.src === src) return tap;
    disconnect();
    try {
      const split = ac.createChannelSplitter(2);
      const mk = (n, smooth) => { const a = ac.createAnalyser(); a.fftSize = n; a.smoothingTimeConstant = smooth; return a; };
      const mono = mk(FFT_SIZE, 0.55), left = mk(SCOPE_SIZE, 0), right = mk(SCOPE_SIZE, 0);
      src.connect(mono);
      src.connect(split);
      split.connect(left, 0);
      split.connect(right, 1);
      tap = {
        ac, src, split, mono, left, right,
        freq: new Float32Array(mono.frequencyBinCount),
        timeL: new Float32Array(SCOPE_SIZE), timeR: new Float32Array(SCOPE_SIZE), timeM: new Float32Array(SCOPE_SIZE),
      };
    } catch (err) {
      console.warn('[ui] visualizer could not listen to the output', err);
      tap = null;
    }
    return tap;
  }
  function disconnect() {
    if (!tap) return;
    try { tap.src.disconnect(tap.mono); } catch { /* gone */ }
    try { tap.src.disconnect(tap.split); } catch { /* gone */ }
    try { tap.split.disconnect(); } catch { /* gone */ }
    tap = null;
  }

  // per-mode state
  let bands = null, levels = null, shown = null, peaks = null, bandsFor = '';
  let lastT = 0, peakHold = 0, silentFor = 0, shownPeriod = 0, corrShown = 0, scrollAcc = 0, column = null;

  function ensureBands(count, sr) {
    const key = `${count}|${sr}`;
    if (bandsFor === key) return;
    bandsFor = key;
    bands = logBands(count, sr, FFT_SIZE);
    levels = new Float32Array(count);
    shown = new Float32Array(count).fill(DB_FLOOR);
    peaks = new Float32Array(count).fill(DB_FLOOR);
  }

  function setMode(next) {
    const m = VISUALIZER_IDS.includes(next) ? next : 'map';
    if (m === mode) return;
    mode = m;
    const on = mode !== 'map';
    el.hidden = !on;
    viewportEl.dataset.viz = mode;
    try { ctx.visuals && typeof ctx.visuals.setCovered === 'function' && ctx.visuals.setCovered(on); } catch { /* the map has gone */ }
    if (!on) disconnect();
    const meta = VISUALIZERS.find((v) => v.value === mode);
    el.setAttribute('aria-label', on ? `${meta.label} visualizer: ${meta.hint}` : '');
    label.textContent = on ? `${meta.label} · ${meta.hint}` : '';
    bandsFor = ''; dirty = true; column = null; scrollAcc = 0; silentFor = 0;
  }
  scope.add(store.subscribe('ui.visualizer', () => setMode(store.get('ui.visualizer'))));
  setMode(store.get('ui.visualizer'));

  scope.add(addLoop((t) => {
    if (mode === 'map' || !vis.visible() || !el.isConnected) { lastT = t; return; }
    const elapsed = lastT ? clamp((t - lastT) / 1000, 0, 0.5) : 1 / 60;
    const dt = Math.min(0.1, elapsed);
    lastT = t;
    if (!colors) colors = readColors(el);
    const dpr = pixelRatioOf(2);
    const W = Math.max(1, Math.round(size.size.width * dpr)), H = Math.max(1, Math.round(size.size.height * dpr));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; dirty = true; column = null; }
    const g = canvas.getContext('2d');
    const tp = connect();
    let peak = 0;
    if (tp) {
      try {
        tp.left.getFloatTimeDomainData(tp.timeL);
        tp.right.getFloatTimeDomainData(tp.timeR);
        if (mode === 'spectrum' || mode === 'waterfall' || mode === 'halo') tp.mono.getFloatFrequencyData(tp.freq);
      } catch { /* the context closed */ }
      for (let i = 0; i < SCOPE_SIZE; i++) {
        const m = (tp.timeL[i] + tp.timeR[i]) * 0.5;
        tp.timeM[i] = m;
        const a = Math.abs(tp.timeL[i]) > Math.abs(tp.timeR[i]) ? Math.abs(tp.timeL[i]) : Math.abs(tp.timeR[i]);
        if (a > peak) peak = a;
      }
    }
    peakHold = Math.max(peak, peakHold * Math.exp(-dt / 0.35));
    const silent = peakHold < 2e-4;
    silentFor = silent ? silentFor + dt : 0;
    const S = { g, W, H, dpr, dt, elapsed, tp, colors, silent };
    if (mode === 'scope') drawScope(S);
    else if (mode === 'spectrum') drawSpectrum(S);
    else if (mode === 'waterfall') drawWaterfall(S);
    else if (mode === 'vector') drawVector(S);
    else if (mode === 'halo') drawHalo(S);
    if (!tp || silentFor > 0.6) idleNote(S, tp ? 'Play a note to see the sound' : 'Start the audio to see the sound');
    dirty = false;
  }));

  // ------------------------------------------------------------- drawing

  function clear(S, alpha = 1) {
    const { g, W, H, colors: c } = S;
    g.globalAlpha = alpha;
    g.fillStyle = c.bg;
    g.fillRect(0, 0, W, H);
    g.globalAlpha = 1;
  }

  function idleNote(S, text) {
    const { g, W, H, dpr, colors: c } = S;
    g.fillStyle = c.dim;
    g.font = `${Math.round(13 * dpr)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, W / 2, H / 2 + (mode === 'halo' ? Math.min(W, H) * 0.32 : 0));
  }

  function hGrid(S, rows) {
    const { g, W, H, colors: c } = S;
    g.strokeStyle = c.grid;
    g.lineWidth = 1;
    g.beginPath();
    for (const y of rows) { const yy = Math.round(y * H) + 0.5; g.moveTo(0, yy); g.lineTo(W, yy); }
    g.stroke();
  }

  function drawScope(S) {
    const { g, W, H, dpr, tp, colors: c } = S;
    clear(S);
    hGrid(S, [0.25, 0.5, 0.75]);
    if (!tp) return;
    const start = findTrigger(tp.timeM, SCOPE_SIZE >> 1);
    // about three periods of the pitch, at least 6 ms and at most the buffer
    const period = estimatePeriod(tp.timeM, start, SCOPE_SIZE >> 2);
    const sr = tp.ac.sampleRate || 48000;
    const want = clamp(period ? period * 3 : 1024, Math.round(sr * 0.006), SCOPE_SIZE - start - 1);
    shownPeriod = shownPeriod ? shownPeriod + (want - shownPeriod) * (1 - Math.exp(-S.dt / 0.15)) : want;
    const n = clamp(Math.round(shownPeriod), 32, SCOPE_SIZE - start - 1);
    const gain = peakHold > 0.02 ? Math.min(4, 0.85 / peakHold) : 1;
    const amp = (H / 2) * 0.9;
    const trace = (buf, color, width, alpha) => {
      g.globalAlpha = alpha;
      g.strokeStyle = color;
      g.lineWidth = width * dpr;
      g.lineJoin = 'round';
      g.beginPath();
      for (let i = 0; i <= n; i++) {
        const x = (i / n) * W, y = H / 2 - clamp(buf[start + i] * gain, -1.05, 1.05) * amp;
        if (i) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.stroke();
      g.globalAlpha = 1;
    };
    trace(tp.timeR, c.accent, 1.6, 0.75);
    trace(tp.timeL, c.part, 2.2, 1);
    if (gain > 1.05) corner(S, `x${gain.toFixed(1)}`);
  }

  function corner(S, text) {
    const { g, W, H, dpr, colors: c } = S;
    g.fillStyle = c.dim;
    g.font = `${Math.round(11 * dpr)}px system-ui, sans-serif`;
    g.textAlign = 'right';
    g.textBaseline = 'bottom';
    g.fillText(text, W - 12 * dpr, H - 10 * dpr);
  }

  function spectrumLevels(S, count) {
    const { tp, dt } = S;
    ensureBands(count, tp ? tp.ac.sampleRate : 48000);
    if (tp) bandLevels(tp.freq, bands, levels); else levels.fill(DB_FLOOR);
    const fall = 40 * dt, peakFall = 14 * dt;   // dB per second down; up at once
    for (let i = 0; i < count; i++) {
      const v = Math.max(DB_FLOOR, levels[i]);
      shown[i] = v > shown[i] ? v : Math.max(v, shown[i] - fall);
      peaks[i] = shown[i] > peaks[i] ? shown[i] : Math.max(shown[i], peaks[i] - peakFall);
    }
  }

  function drawSpectrum(S) {
    const { g, W, H, dpr, colors: c } = S;
    const count = clamp(Math.round(W / (3 * dpr)), 48, 480);
    spectrumLevels(S, count);
    clear(S);
    // frequency lines and labels
    g.strokeStyle = c.grid;
    g.lineWidth = 1;
    g.fillStyle = c.dim;
    g.font = `${Math.round(10.5 * dpr)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    const top = 56 * dpr, bottom = H - 26 * dpr, span = Math.max(1, bottom - top);
    const xOf = (hz) => (Math.log(hz / MIN_HZ) / Math.log(MAX_HZ / MIN_HZ)) * W;
    g.beginPath();
    for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = Math.round(xOf(hz)) + 0.5;
      g.moveTo(x, top); g.lineTo(x, bottom);
      g.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), x, H - 8 * dpr);
    }
    for (let db = DB_TOP; db >= DB_FLOOR; db -= 12) { const y = Math.round(bottom - dbNorm(db) * span) + 0.5; g.moveTo(0, y); g.lineTo(W, y); }
    g.stroke();
    // the curve, filled
    const x = (i) => ((i + 0.5) / count) * W;
    const y = (db) => bottom - dbNorm(db) * span;
    const grad = g.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, c.accent);
    grad.addColorStop(1, c.part);
    g.beginPath();
    g.moveTo(0, bottom);
    for (let i = 0; i < count; i++) g.lineTo(x(i), y(shown[i]));
    g.lineTo(W, bottom);
    g.closePath();
    g.globalAlpha = 0.28;
    g.fillStyle = grad;
    g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = grad;
    g.lineWidth = 2 * dpr;
    g.lineJoin = 'round';
    g.beginPath();
    for (let i = 0; i < count; i++) { if (i) g.lineTo(x(i), y(shown[i])); else g.moveTo(x(i), y(shown[i])); }
    g.stroke();
    // peak hold
    g.strokeStyle = c.text;
    g.globalAlpha = 0.45;
    g.lineWidth = 1 * dpr;
    g.beginPath();
    for (let i = 0; i < count; i++) { if (i) g.lineTo(x(i), y(peaks[i])); else g.moveTo(x(i), y(peaks[i])); }
    g.stroke();
    g.globalAlpha = 1;
    corner(S, `${TILT_DB_PER_OCTAVE} dB/oct tilt`);
  }

  function drawWaterfall(S) {
    const { g, W, H, dpr, elapsed, colors: c } = S;
    const rows = clamp(Math.round(H / dpr), 64, 720);
    spectrumLevels(S, rows);
    if (dirty || !column) { clear(S); column = null; }
    // about 70 CSS pixels a second, whatever the frame rate
    scrollAcc += elapsed * 70 * dpr;
    const step = Math.floor(scrollAcc);
    if (step < 1) return;
    scrollAcc -= step;
    const cw = Math.min(step, W);
    g.drawImage(canvas, cw, 0, W - cw, H, 0, 0, W - cw, H);
    if (!column || column.width !== cw || column.height !== H) column = g.createImageData(cw, H);
    const d = column.data, lut = c.lut;
    for (let yy = 0; yy < H; yy++) {
      // low notes at the bottom
      const band = clamp(Math.floor((1 - yy / H) * rows), 0, rows - 1);
      const k = Math.round(Math.pow(dbNorm(levels[band]), 1.8) * 255) * 3;
      for (let xx = 0; xx < cw; xx++) {
        const o = (yy * cw + xx) * 4;
        d[o] = lut[k]; d[o + 1] = lut[k + 1]; d[o + 2] = lut[k + 2]; d[o + 3] = 255;
      }
    }
    g.putImageData(column, W - cw, 0);
  }

  function drawVector(S) {
    const { g, W, H, dpr, dt, tp, colors: c } = S;
    // phosphor: the last frames fade over about a tenth of a second
    clear(S, dirty ? 1 : 1 - Math.exp(-dt / 0.09));
    const R = Math.min(W, H) * 0.4, cx = W / 2, cy = H / 2 - 10 * dpr;
    g.strokeStyle = c.grid;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(cx, cy - R); g.lineTo(cx, cy + R);
    g.moveTo(cx - R, cy); g.lineTo(cx + R, cy);
    g.moveTo(cx - R * 0.707, cy - R * 0.707); g.lineTo(cx + R * 0.707, cy + R * 0.707);
    g.moveTo(cx + R * 0.707, cy - R * 0.707); g.lineTo(cx - R * 0.707, cy + R * 0.707);
    g.stroke();
    g.fillStyle = c.dim;
    g.font = `${Math.round(10.5 * dpr)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.fillText('L', cx - R * 0.74, cy - R * 0.74);
    g.fillText('R', cx + R * 0.74, cy - R * 0.74);
    if (!tp) return;
    const gain = peakHold > 0.02 ? Math.min(4, 0.8 / peakHold) : 1;
    g.strokeStyle = c.part;
    g.globalAlpha = 0.7;
    g.lineWidth = 1.2 * dpr;
    g.beginPath();
    for (let i = 0; i < SCOPE_SIZE; i += 2) {
      const l = tp.timeL[i] * gain, r = tp.timeR[i] * gain;
      // mid up, side across: a mono sound is a vertical line
      const px = cx + clamp((r - l) * 0.707, -1.2, 1.2) * R, py = cy - clamp((l + r) * 0.707, -1.2, 1.2) * R;
      if (i) g.lineTo(px, py); else g.moveTo(px, py);
    }
    g.stroke();
    g.globalAlpha = 1;
    // correlation, -1 to 1
    const corr = correlation(tp.timeL, tp.timeR);
    corrShown += (corr - corrShown) * (1 - Math.exp(-dt / 0.25));
    const mw = Math.min(W * 0.5, 320 * dpr), mx = cx - mw / 2, my = H - 34 * dpr, mh = 4 * dpr;
    g.fillStyle = c.grid;
    g.fillRect(mx, my, mw, mh);
    g.fillStyle = corrShown < 0 ? c.accent : c.part;
    const zero = mx + mw / 2, at = zero + corrShown * mw / 2;
    g.fillRect(Math.min(zero, at), my, Math.max(1, Math.abs(at - zero)), mh);
    g.fillStyle = c.dim;
    g.textBaseline = 'top';
    g.textAlign = 'left'; g.fillText('-1', mx, my + 8 * dpr);
    g.textAlign = 'right'; g.fillText('+1', mx + mw, my + 8 * dpr);
    g.textAlign = 'center'; g.fillText(`Correlation ${corrShown >= 0 ? '+' : ''}${corrShown.toFixed(2)}`, cx, my + 8 * dpr);
  }

  function drawHalo(S) {
    const { g, W, H, dpr, tp, colors: c } = S;
    const half = 72;
    spectrumLevels(S, half);
    clear(S);
    const cx = W / 2, cy = H / 2;
    const base = Math.min(W, H) * 0.2;
    const reach = Math.min(W, H) * 0.24;
    // bars: low notes at the top, mirrored left and right
    g.lineCap = 'round';
    g.lineWidth = Math.max(1.5 * dpr, (2 * Math.PI * base / (half * 2)) * 0.55);
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < half; i++) {
        const a = -Math.PI / 2 + side * ((i + 0.5) / half) * Math.PI;
        const len = 2 * dpr + Math.pow(dbNorm(shown[i]), 1.6) * reach;
        const t = i / (half - 1);
        g.strokeStyle = t < 0.5 ? c.part : c.accent;
        g.globalAlpha = 0.55 + 0.45 * dbNorm(shown[i]);
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * (base + 6 * dpr), cy + Math.sin(a) * (base + 6 * dpr));
        g.lineTo(cx + Math.cos(a) * (base + 6 * dpr + len), cy + Math.sin(a) * (base + 6 * dpr + len));
        g.stroke();
      }
    }
    g.globalAlpha = 1;
    // one period of the live wave, wrapped around the circle
    g.strokeStyle = c.text;
    g.lineWidth = 1.6 * dpr;
    g.beginPath();
    if (tp && !S.silent) {
      const start = findTrigger(tp.timeM, SCOPE_SIZE >> 1);
      let n = estimatePeriod(tp.timeM, start, SCOPE_SIZE >> 2);
      if (n < 16) n = Math.min(512, SCOPE_SIZE - start - 1);
      const gain = peakHold > 0.02 ? Math.min(4, 0.9 / peakHold) : 1;
      const steps = 256;
      for (let k = 0; k <= steps; k++) {
        const s = tp.timeM[start + Math.min(n - 1, Math.floor((k % steps) / steps * n))] * gain;
        const r = base * (0.7 + 0.25 * clamp(s, -1, 1));
        const a = -Math.PI / 2 + (k / steps) * 2 * Math.PI;
        const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
        if (k) g.lineTo(px, py); else g.moveTo(px, py);
      }
    } else {
      g.arc(cx, cy, base * 0.7, 0, Math.PI * 2);
    }
    g.globalAlpha = 0.85;
    g.stroke();
    g.globalAlpha = 1;
  }

  return {
    el,
    mode: () => mode,
    dispose() {
      scope.dispose();
      disconnect();
      try { ctx.visuals && typeof ctx.visuals.setCovered === 'function' && ctx.visuals.setCovered(false); } catch { /* gone */ }
      delete viewportEl.dataset.viz;
      el.remove();
    },
  };
}
