// Original procedural imagery, created specifically for Orograph. No remote
// assets or photographs. Stable recipes generate real RGBA PNGs on demand.
import { fastSin, fastCos, mulberry32 } from './terrain-math.js';
import { crc32, PNG_SIGNATURE } from '../audio/png.js';

const FAMILIES = [
  ['strata', 'Strata', 'Layered flowing bands'], ['petals', 'Petals', 'Radial harmonic flowers'],
  ['woven', 'Woven', 'Crossing woven wave fields'], ['islands', 'Islands', 'Rounded archipelago relief'],
  ['rings', 'Rings', 'Nested rippling rings'], ['facets', 'Facets', 'Angular folded facets'],
  ['currents', 'Currents', 'Bent fluid wavefronts'], ['cells', 'Cells', 'Periodic cellular contours'],
  ['clouds', 'Clouds', 'Soft layered Fourier clouds'], ['prisms', 'Prisms', 'Chromatic geometric interference'],
];
export const TERRAIN_LIBRARY = Object.freeze(FAMILIES.flatMap(([family, category, desc], fi) =>
  Array.from({ length: 32 }, (_, variant) => Object.freeze({
    id: `original-${family}-${String(variant + 1).padStart(3, '0')}`, name: `${category} ${String(variant + 1).padStart(2, '0')}`,
    family, category, desc, seed: (fi + 1) * 1009 + variant * 7919, variant, familyIndex: fi,
    attribution: 'Original procedural imagery for Orograph', width: 512, height: 512,
  }))));
export const TERRAIN_LIBRARY_CATEGORIES = Object.freeze(FAMILIES.map(x => x[1]));
const ENTRIES = new Map(TERRAIN_LIBRARY.map(x => [x.id, x]));

export function libraryEntry(id) { return ENTRIES.get(id) || null; }
export function searchTerrainLibrary(query = '', category = '') {
  const q = String(query).trim().toLowerCase();
  return TERRAIN_LIBRARY.filter(e => (!category || e.category === category) && (!q || `${e.name} ${e.desc} ${e.id}`.toLowerCase().includes(q)));
}

/** Actual original image pixels. Resolution defaults to 512; 64 is used only for thumbnails. */
export function generateLibraryRgba(id, size = 512) {
  const e = typeof id === 'string' ? libraryEntry(id) : id;
  if (!e || !ENTRIES.has(e.id)) throw new Error('Unknown original terrain image');
  const n = Math.max(2, Math.min(1024, Math.round(size))), data = new Uint8Array(n * n * 4), rng = mulberry32(e.seed);
  const a = 1 + Math.floor(rng() * 7), b = 1 + Math.floor(rng() * 7), ph = rng(), twist = rng() * 0.8;
  const partials = Array.from({ length: 5 }, (_, k) => [1 + Math.floor(rng() * 6), 1 + Math.floor(rng() * 6), rng(), 1 / (k + 2)]);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = x / n, v = y / n, sx = fastSin(u), sy = fastSin(v), r = Math.sqrt(sx * sx + sy * sy + 0.0001);
    let z;
    switch (e.familyIndex) {
      case 0: z = fastSin(a * v + twist * fastSin(b * u) + ph); break;
      case 1: z = fastCos(a * r + ph) * fastCos(b * (u + v)); break;
      case 2: z = fastSin(a * u + ph) * fastSin(b * v + twist * fastSin(u)); break;
      case 3: z = Math.tanh(2 * (fastSin(a * u + ph) + fastCos(b * v) - twist)); break;
      case 4: z = fastCos(a * r + twist * fastSin(b * (u - v)) + ph); break;
      case 5: z = 2 * Math.abs(fastSin(a * u + ph) * fastCos(b * v)) - 1; break;
      case 6: z = fastSin(a * u + b * v + twist * fastCos(2 * v + ph)); break;
      case 7: z = fastCos(a * u + ph) + fastCos(b * v) + fastCos(a * u - b * v); z /= 3; break;
      case 8: z = 0; for (const p of partials) z += p[3] * fastSin(p[0] * u + p[1] * v + p[2]); z /= 1.45; break;
      default: z = fastSin(a * u + ph) * fastCos(b * v + ph) + 0.3 * fastSin((a + b) * (u - v)); z /= 1.3;
    }
    const o = (y * n + x) * 4;
    data[o] = Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, z)));
    data[o + 1] = Math.round(127.5 + 127.5 * fastSin(0.28 * z + ph + 0.3 * fastSin(b * v)));
    data[o + 2] = Math.round(127.5 + 127.5 * fastCos(0.24 * z + ph + 0.2 * fastSin(a * u)));
    data[o + 3] = 255;
  }
  return { width: n, height: n, data };
}

function chunk(type, data) {
  const out = new Uint8Array(data.length + 12), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8); dv.setUint32(data.length + 8, crc32(out, 4, data.length + 8));
  return out;
}
function storedZlib(raw) {
  const count = Math.ceil(raw.length / 65535), out = new Uint8Array(raw.length + count * 5 + 6);
  out[0] = 0x78; out[1] = 0x01;
  let pos = 2, a = 1, b = 0;
  for (let start = 0; start < raw.length; start += 65535) {
    const len = Math.min(65535, raw.length - start), inv = len ^ 65535;
    out[pos++] = start + len === raw.length ? 1 : 0;
    out[pos++] = len & 255; out[pos++] = len >> 8; out[pos++] = inv & 255; out[pos++] = inv >> 8;
    out.set(raw.subarray(start, start + len), pos); pos += len;
  }
  for (const value of raw) { a = (a + value) % 65521; b = (b + a) % 65521; }
  new DataView(out.buffer).setUint32(pos, ((b << 16) | a) >>> 0);
  return out;
}

/** Standards-compliant RGBA PNG; pure JS keeps standalone file builds offline. */
export function encodeLibraryPng(image) {
  const { width, height, data } = image, stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = new Uint8Array(13), dv = new DataView(header.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height); header[8] = 8; header[9] = 6;
  const chunks = [Uint8Array.from(PNG_SIGNATURE), chunk('IHDR', header), chunk('IDAT', storedZlib(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let offset = 0; for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}
export function terrainLibraryPng(id, size = 512) { return encodeLibraryPng(generateLibraryRgba(id, size)); }
