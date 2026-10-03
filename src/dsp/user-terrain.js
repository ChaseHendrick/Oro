// Pure saved-terrain schema. Shared by migration, imports and worker jobs.
import { base64ToBytes } from './terrains.js';

export const USER_TERRAIN_MAX_AXIS = 1024;
export const IMAGE_CHANNELS = Object.freeze(['r', 'g', 'b', 'luma']);

function plane(src, count) {
  if (!src || typeof src.data !== 'string' || src.data.length > Math.ceil(count / 3) * 4 + 16) return null;
  if (base64ToBytes(src.data).length !== count) return null;
  const out = { data: src.data };
  if (typeof src.lo === 'string' && src.lo.length <= Math.ceil(count / 3) * 4 + 16 && base64ToBytes(src.lo).length === count) out.lo = src.lo;
  return out;
}

export function sanitizeUserTerrain(src) {
  if (!src || typeof src !== 'object') return null;
  const w = Math.round(src.w), h = Math.round(src.h);
  if (!(w >= 2 && h >= 2 && w <= USER_TERRAIN_MAX_AXIS && h <= USER_TERRAIN_MAX_AXIS)) return null;
  const main = plane(src, w * h);
  if (!main) return null;
  const out = { name: String(src.name || 'Imported').slice(0, 80), kind: ['image', 'wavetable', 'audio'].includes(src.kind) ? src.kind : 'image', w, h, mirror: src.mirror ? 1 : 0, ...main };
  if (src.channels && typeof src.channels === 'object') {
    const channels = {};
    for (const key of IMAGE_CHANNELS) { const p = plane(src.channels[key], w * h); if (p) channels[key] = p; }
    if (IMAGE_CHANNELS.every(k => channels[k])) out.channels = channels;
  }
  if (typeof src.libraryId === 'string' && /^original-[a-z]+-\d{3}$/.test(src.libraryId)) out.libraryId = src.libraryId;
  if (src.audio && Number.isFinite(src.audio.sampleRate) && Number.isFinite(src.audio.duration)) {
    out.audio = { sampleRate: Math.max(8000, Math.min(384000, src.audio.sampleRate)), duration: Math.max(0, src.audio.duration) };
  }
  return out;
}
