// Terrain table jobs: what to build for a part's A/B slot, a cache key for it,
// and the build itself (shared by the worker and the in-thread fallback, so
// both produce bit-identical tables). The same job runner also builds reverb
// impulse responses ({kind: 'ir'}), which are just as heavy and just as pure.

import { TERRAIN_INDEX } from '../dsp/catalog.js';
import { generateTerrain, decodeUserTerrain, buildMipChain } from '../dsp/terrains.js';
import { generateImpulse } from './reverb-ir.js';
import { decodeUserTerrainPrecise, hasLowPlane } from './heightmap.js';

export const FLAT_SIZE = 32;
export const MIP_MIN = 32;

/** 64-bit FNV-1a style hash of a string as 16 hex chars (two independent 32-bit lanes). */
export function hashString(str) {
  const s = String(str || '');
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) ^ (h2 >>> 15);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

// Imported terrains carry ~90 KB of base64; hashing it on every terrain-group
// knob move would be wasteful, so remember recent strings (Map lookups of an
// already-hashed string are cheap in every engine).
const hashMemo = new Map();
function memoHash(str) {
  let h = hashMemo.get(str);
  if (h === undefined) {
    h = hashString(str);
    if (hashMemo.size >= 16) hashMemo.delete(hashMemo.keys().next().value);
    hashMemo.set(str, h);
  }
  return h;
}

function finite(v, fallback) { return typeof v === 'number' && Number.isFinite(v) ? v : fallback; }

/**
 * Describe the table a slot needs.
 * @param {object} params a part's params
 * @param {object|null} userTerrain the part's userTerrain[slot]
 * @param {'A'|'B'} slot
 * @param {number} size table resolution (power of two)
 */
export function jobFor(params, userTerrain, slot, size) {
  const p = params || {};
  const index = Math.round(finite(p['terrain' + slot], slot === 'B' ? TERRAIN_INDEX.massif : TERRAIN_INDEX.swell));
  if (index === TERRAIN_INDEX.user) {
    const ut = userTerrain;
    if (!ut || typeof ut.data !== 'string' || !(ut.w >= 2) || !(ut.h >= 2)) return { kind: 'flat', size: FLAT_SIZE };
    const job = {
      kind: 'user', size,
      ut: { kind: ut.kind === 'wavetable' ? 'wavetable' : 'image', w: Math.round(ut.w), h: Math.round(ut.h), mirror: ut.mirror ? 1 : 0, data: ut.data },
    };
    // 16-bit imports carry their low bytes separately (see heightmap.js).
    if (hasLowPlane(ut)) job.ut.lo = ut.lo;
    return job;
  }
  // Detail is rounded to 0.01 for the cache key, so build with the same value.
  const detail = Math.round(Math.min(1, Math.max(0, finite(p.detail, 0.5))) * 100) / 100;
  const seed = Math.round(finite(p.seed, 7));
  return { kind: 'proc', size, index: Math.max(0, index), seed, detail };
}

export function jobKey(job) {
  if (job.kind === 'flat') return 'flat';
  if (job.kind === 'user') {
    const u = job.ut;
    return `u:${memoHash(u.data)}${u.lo ? '+' + memoHash(u.lo) : ''}:${u.kind}:${u.w}x${u.h}:${u.mirror}:${job.size}`;
  }
  return `p:${job.index}:${job.seed}:${Math.round(job.detail * 100)}:${job.size}`;
}

/** The full-resolution table for a job (Float32Array, size x size). */
export function buildTerrainData(job) {
  if (job.kind === 'flat') return new Float32Array(FLAT_SIZE * FLAT_SIZE);
  let data = null;
  if (job.kind === 'user') data = hasLowPlane(job.ut) ? decodeUserTerrainPrecise(job.ut, job.size) : decodeUserTerrain(job.ut, job.size);
  else data = generateTerrain(job.index, { size: job.size, seed: job.seed, detail: job.detail });
  return data || new Float32Array(job.size * job.size);
}

/** Mip chain for a table built by buildTerrainData. */
export function mipChainFor(job, data) {
  const size = job.kind === 'flat' ? FLAT_SIZE : job.size;
  return buildMipChain(data, size, Math.min(MIP_MIN, size));
}

/** Build the mip chain [{size, data: Float32Array}] for a job. Every level owns its buffer. */
export function buildTerrainLevels(job) {
  return mipChainFor(job, buildTerrainData(job));
}

/** Run any job: terrain kinds -> mip chain, 'ir' -> generateImpulse result. */
export function runJob(job) {
  if (job && job.kind === 'ir') return generateImpulse(job);
  return buildTerrainLevels(job);
}

/** The ArrayBuffers a job result can hand over without copying. */
export function transferablesOf(result) {
  if (Array.isArray(result)) return result.map(l => l.data.buffer);
  if (result && result.left) return [result.left.buffer, result.right.buffer];
  return [];
}
