// Sonify your data (2.10): pasted numbers or a CSV become a terrain or a
// melody. Pure parsing and mapping here; src/ui/data-panel.js is the UI.
//
//   parseData(text)          -> { columns: [{ name, values }], rows, truncated } or { error }
//   seriesTerrain(values, n) -> the series as heights along x, more and more
//                               smoothed from front (y = 0) to back
//   gridTerrain(columns, n)  -> multi-column data as a 2D grid (x = columns, y = rows)
//   melodySteps(values, ...) -> sequencer steps, as scale degrees of the global key/scale
//   writeMelody(store, part, values) -> those steps in the track's active pattern (one undo step)

import { SEQ_STEPS, SCALES, SCALE_NAMES, defaultStep, activeSeq, patternPath, clamp } from '../core/params.js';
import { isTrack } from '../core/tracks.js';
import { keepLocks } from './locks.js';

export const DATA_MAX_CHARS = 2_000_000;
export const DATA_MAX_ROWS = 10_000;
export const DATA_MAX_COLS = 32;

const NUM_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;

/** A cell -> number, or null. Accepts quotes, a decimal comma (when commas do not split cells), and spaces between thousands. */
export function toNumber(cell, decimalComma = false) {
  let t = String(cell ?? '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim();
  if (decimalComma && /^[+-]?\d+,\d+$/.test(t)) t = t.replace(',', '.');
  t = t.replace(/(\d)[ _](?=\d{3}\b)/g, '$1');
  if (!NUM_RE.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

function splitter(lines) {
  const sample = lines.slice(0, 20);
  for (const d of ['\t', ';', ',']) {
    const counts = sample.map(l => l.split(d).length - 1);
    if (counts[0] > 0 && counts.filter(c => c === counts[0]).length >= Math.ceil(sample.length * 0.8)) return d;
  }
  if (sample.some(l => /\S\s+\S/.test(l))) return /\s+/;
  return null;
}

function splitCsvLine(line, d) {
  if (d !== ',' && d !== ';' && d !== '\t') return line.trim().split(d);
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (ch === d && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Pasted text or a CSV file -> numeric columns. Accepts one number per line,
 * numbers on one line, or a table split by commas, semicolons, tabs or spaces
 * with an optional header row. Non-numbers in a column are skipped.
 */
export function parseData(text) {
  if (typeof text !== 'string' || !text.trim()) return { error: 'Paste some numbers first.' };
  if (text.length > DATA_MAX_CHARS) return { error: `That is ${(text.length / 1e6).toFixed(1)} million characters. Paste or drop up to 2 million.` };
  let lines = text.split(/\r\n|\n|\r/).map(l => l.replace(/^﻿/, '')).filter(l => l.trim() && !/^\s*#/.test(l));
  // A single line of numbers is one series.
  if (lines.length === 1) {
    const cells = lines[0].split(/[\s,;]+/).filter(Boolean);
    if (cells.length > 1 && cells.every(c => toNumber(c) != null)) lines = cells;
  }
  let truncated = 0;
  const d = splitter(lines);
  const decimalComma = d !== ',' && d !== null;
  const table = lines.map(l => (d === null ? [l.trim()] : splitCsvLine(l, d)).slice(0, DATA_MAX_COLS));
  const first = table[0] || [];
  const header = first.some(c => String(c).trim() && toNumber(c, decimalComma) == null) && first.filter(c => toNumber(c, decimalComma) == null).length >= first.length / 2;
  let body = header ? table.slice(1) : table;
  if (body.length > DATA_MAX_ROWS) { truncated = body.length - DATA_MAX_ROWS; body = body.slice(0, DATA_MAX_ROWS); }
  const width = Math.max(0, ...body.map(r => r.length));
  const columns = [];
  for (let c = 0; c < width; c++) {
    const values = [];
    for (const r of body) { const v = toNumber(r[c], decimalComma); if (v != null) values.push(v); }
    if (values.length >= 2) {
      const name = header && String(first[c] ?? '').trim() ? String(first[c]).trim().replace(/^"(.*)"$/, '$1').slice(0, 40) : `Column ${c + 1}`;
      columns.push({ name, values });
    }
  }
  if (!columns.length) return { error: 'No numbers found. Paste one number per line, or a table with numbers in at least one column (two or more values).' };
  return { columns, rows: body.length, truncated };
}

/** { min, max, count } of a series. */
export function seriesStats(values) {
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  return { min, max, count: values.length };
}

/** Resample a series to n points: bin averages when shrinking, straight lines when stretching. */
export function resample1D(values, n) {
  const m = values.length, out = new Float64Array(n);
  if (!m) return out;
  if (m === 1) return out.fill(values[0]);
  if (m >= n) {
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * m / n), b = Math.max(a + 1, Math.floor((i + 1) * m / n));
      let s = 0;
      for (let k = a; k < b; k++) s += values[k];
      out[i] = s / (b - a);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const p = i * (m - 1) / (n - 1), k = Math.min(m - 2, Math.floor(p)), f = p - k;
      out[i] = values[k] + (values[k + 1] - values[k]) * f;
    }
  }
  return out;
}

function normalise(arr) {
  const { min, max } = seriesStats(arr), span = max - min;
  for (let i = 0; i < arr.length; i++) arr[i] = span > 0 ? (arr[i] - min) / span : 0.5;
  return arr;
}

function blur(line, sigma) {
  const n = line.length;
  if (sigma < 0.3) return Float64Array.from(line);
  const r = Math.ceil(sigma * 3), w = [];
  let sum = 0;
  for (let k = -r; k <= r; k++) { const v = Math.exp(-(k * k) / (2 * sigma * sigma)); w.push(v); sum += v; }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -r; k <= r; k++) {
      let j = i + k;
      while (j < 0 || j >= n) j = j < 0 ? -j - 1 : 2 * n - j - 1;   // mirror at the edges
      s += line[j] * w[k + r];
    }
    out[i] = s / sum;
  }
  return out;
}

/** One series as a ridge: heights along x; row y is smoothed more the further back it is. */
export function seriesTerrain(values, n = 256) {
  const line = normalise(resample1D(values, n));
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const row = blur(line, (y / (n - 1)) * n / 10);
    for (let x = 0; x < n; x++) out[y * n + x] = row[x];
  }
  return out;
}

/** Several columns as a 2D grid: each column scaled to its own range, x across columns, y down the rows. */
export function gridTerrain(columns, n = 256) {
  const cols = columns.map(c => normalise(resample1D(c.values, n)));
  const out = new Float32Array(n * n);
  const across = new Float64Array(cols.length);
  for (let y = 0; y < n; y++) {
    for (let c = 0; c < cols.length; c++) across[c] = cols[c][y];
    const row = resample1D(across, n);
    for (let x = 0; x < n; x++) out[y * n + x] = row[x];
  }
  return out;
}

/** Scale length of a global scaleType (index into SCALE_NAMES). */
export function scaleLength(scaleType) {
  return (SCALES[SCALE_NAMES[scaleType]] || SCALES.Minor).length;
}

/**
 * A series -> `length` sequencer steps (of SEQ_STEPS), each on, with the value
 * mapped low..high to scale degrees 0..scaleLen * octaves: always in key.
 */
export function melodySteps(values, { length = 16, scaleLen = 7, octaves = 2, old = null } = {}) {
  const len = clamp(Math.round(length) || 16, 1, SEQ_STEPS);
  const v = normalise(resample1D(values, len));
  const top = Math.max(1, Math.round(scaleLen * octaves));
  const steps = Array.from({ length: SEQ_STEPS }, defaultStep);
  for (let i = 0; i < len; i++) Object.assign(steps[i], { on: 1, degree: Math.round(v[i] * top), vel: 0.8, gate: 0.5 });
  return keepLocks(steps, old);
}

/** Write a melody into the track's active pattern in one store batch (one undo step). */
export function writeMelody(store, part, values) {
  const p = Number(part);
  if (!isTrack(store, p)) return null;
  const seq = activeSeq(store.get(`parts.${p}`)) || {};
  const steps = melodySteps(values, { length: seq.length || 16, scaleLen: scaleLength(store.get('global.scaleType') ?? 1), old: seq.steps });
  const path = patternPath(store, p);
  store.batch(() => {
    store.set(`${path}.steps`, steps, { source: 'music' });
    if (!seq.enabled) store.set(`parts.${p}.seqOn`, 1, { source: 'music' });
  });
  return steps;
}
