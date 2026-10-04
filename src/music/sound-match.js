// Make a patch from a sound. Offline, experimental, no network.
// The search compares a coarse spectrum and an envelope. A caller can inject
// a render of each candidate. This file does not pretend to run the synth
// unless that render is passed in.

import { TERRAINS, PATHS, TERRAIN_INDEX, PATH_INDEX } from '../dsp/catalog.js';
import { generateTerrain } from '../dsp/terrains.js';
import { samplePath } from '../dsp/paths.js';
import { sampleBilinear } from '../dsp/terrain-math.js';

const BANDS = 32;

function hann(i, n) {
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, n - 1));
}

export function featuresOf(samples, rate = 48000) {
  const x = samples instanceof Float32Array ? samples : Float32Array.from(samples || []);
  const n = x.length;
  let rms = 0;
  for (let i = 0; i < n; i++) rms += x[i] * x[i];
  rms = n ? Math.sqrt(rms / n) : 0;
  const env = [];
  const slices = 8;
  for (let s = 0; s < slices; s++) {
    const a = Math.floor((s * n) / slices);
    const b = Math.floor(((s + 1) * n) / slices);
    let e = 0;
    const len = Math.max(1, b - a);
    for (let i = a; i < b; i++) e += x[i] * x[i];
    env.push(Math.sqrt(e / len));
  }
  const spec = new Array(BANDS).fill(0);
  const use = Math.min(n, 512);
  if (use > 16) {
    for (let k = 1; k < BANDS; k++) {
      const w = (2 * Math.PI * k) / use;
      let re = 0;
      let im = 0;
      for (let i = 0; i < use; i++) {
        const s = x[i] * hann(i, use);
        re += s * Math.cos(w * i);
        im -= s * Math.sin(w * i);
      }
      spec[k] = Math.hypot(re, im) / use;
    }
  }
  let num = 0;
  let den = 0;
  for (let k = 0; k < BANDS; k++) {
    const f = (k * rate) / use;
    num += f * spec[k];
    den += spec[k];
  }
  return { rms, env, spec, centroid: den > 1e-8 ? num / den : 0, rate };
}

export function scoreFeatures(sample, candidate) {
  const a = sample.spec || [];
  const b = candidate.spec || [];
  let d = 0;
  for (let i = 0; i < BANDS; i++) d += Math.abs(Math.log(1 + (a[i] || 0)) - Math.log(1 + (b[i] || 0)));
  const ea = sample.env || [];
  const eb = candidate.env || [];
  for (let i = 0; i < 8; i++) d += Math.abs((ea[i] || 0) - (eb[i] || 0));
  return d;
}

function usableTerrains() {
  return TERRAINS.filter((t) => t.id !== 'user');
}
function usablePaths() {
  return PATHS.filter((p) => !p.hidden && p.id !== 'oro');
}

/** At most 24 real terrain and path pairs, plus a few filter and envelope values. */
export function buildCandidates() {
  const terrains = usableTerrains();
  const paths = usablePaths();
  const out = [];
  const filters = [0.3, 0.7];
  const attacks = [0.01, 0.2];
  let n = 0;
  for (let i = 0; i < terrains.length && n < 24; i++) {
    for (let j = 0; j < paths.length && n < 24; j += 3) {
      const terrain = terrains[i];
      const path = paths[j];
      out.push({
        terrain: terrain.id,
        path: path.id,
        params: {
          terrainA: TERRAIN_INDEX[terrain.id],
          pathShape: PATH_INDEX[path.id],
          cutoff: filters[n % 2] > 0.5 ? 4000 : 800,
          attack: attacks[n % 2],
        },
      });
      n++;
    }
  }
  return out;
}

export const CANDIDATES = buildCandidates();

const terrainCache = new Map();

function terrainOf(id) {
  if (terrainCache.has(id)) return terrainCache.get(id);
  const index = TERRAIN_INDEX[id];
  const data = Number.isInteger(index) ? generateTerrain(index, { size: 64 }) : null;
  const size = data ? Math.round(Math.sqrt(data.length)) : 0;
  const table = data && size ? { data, size } : null;
  terrainCache.set(id, table);
  return table;
}

/**
 * One cycle of the land under the path, before filters and effects.
 * Path points sit near radius 1. Size 0.28 around the middle of the map
 * is the same reading the voice uses: centre plus the path, then bilinear.
 */
export function renderCandidateWave(candidate, n = 512) {
  const out = new Float32Array(n);
  const table = candidate && terrainOf(candidate.terrain);
  const shape = candidate ? PATH_INDEX[candidate.path] : undefined;
  if (!table || !Number.isInteger(shape)) return out;
  const pts = samplePath(shape, 2, 0.5, n);
  const orbit = 0.28;
  for (let i = 0; i < n; i++) {
    const u = 0.5 + pts[i * 2] * orbit;
    const v = 0.5 + pts[i * 2 + 1] * orbit;
    const h = sampleBilinear(table.data, table.size, u, v);
    out[i] = Number.isFinite(h) ? h * 2 - 1 : 0;
  }
  return out;
}

export function searchFromFeatures(sampleFeatures, list) {
  let best = null;
  for (const item of list) {
    const distance = scoreFeatures(sampleFeatures, item.features || item);
    if (!best || distance < best.distance) best = { ...item, distance };
  }
  return best ? { ...best, tried: list.length } : null;
}

/**
 * Search. The default render is one cycle of the terrain under the path.
 * Pass a function to use a different recording of each candidate.
 */
export function searchPatch(samples, rate, renderCandidate = renderCandidateWave) {
  const sample = featuresOf(samples, rate);
  const list = CANDIDATES.map((c) => {
    if (typeof renderCandidate !== 'function') return { ...c, features: { spec: [], env: [] } };
    const audio = renderCandidate(c);
    return { ...c, features: featuresOf(audio, rate) };
  });
  const best = searchFromFeatures(sample, list);
  if (!best) return null;
  return { terrain: best.terrain, path: best.path, params: best.params, distance: best.distance, tried: best.tried };
}

export function applyPatch(store, partIndex, result) {
  if (!result) return [];
  const p = `parts.${partIndex}.params`;
  const paths = [];
  if (typeof result.params.terrainA === 'number') {
    store.set(`${p}.terrainA`, result.params.terrainA, { source: 'ui' });
    paths.push(`${p}.terrainA`);
  }
  if (typeof result.params.pathShape === 'number') {
    store.set(`${p}.pathShape`, result.params.pathShape, { source: 'ui' });
    paths.push(`${p}.pathShape`);
  }
  for (const id of ['cutoff', 'attack']) {
    if (typeof result.params[id] === 'number') {
      store.set(`${p}.${id}`, result.params[id], { source: 'ui' });
      paths.push(`${p}.${id}`);
    }
  }
  return paths;
}
