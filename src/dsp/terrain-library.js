// Original procedural imagery, created specifically for Oro. No remote
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
    attribution: 'Original procedural imagery for Oro', width: 512, height: 512,
  }))));
export const TERRAIN_LIBRARY_CATEGORIES = Object.freeze(FAMILIES.map(x => x[1]));
// v2.9 hidden entries, listed only once unlocked (see src/ui/eggs.js).
export const HIDDEN_TERRAINS = Object.freeze([
  Object.freeze({
    id: 'original-cabinet', name: 'Cabinet', family: 'cabinet', category: 'Arcade', desc: 'A control deck with a joystick and six round buttons',
    seed: 1981, variant: 0, familyIndex: -1, hidden: true,
    attribution: 'Original procedural imagery for Oro', width: 512, height: 512,
  }),
]);
const ENTRIES = new Map([...TERRAIN_LIBRARY, ...HIDDEN_TERRAINS].map(x => [x.id, x]));

export function libraryEntry(id) { return ENTRIES.get(id) || null; }
/** `hidden`: also list the hidden entries (first). */
export function searchTerrainLibrary(query = '', category = '', { hidden = false } = {}) {
  const q = String(query).trim().toLowerCase();
  const list = hidden ? [...HIDDEN_TERRAINS, ...TERRAIN_LIBRARY] : TERRAIN_LIBRARY;
  return list.filter(e => (!category || e.category === category) && (!q || `${e.name} ${e.desc} ${e.id}`.toLowerCase().includes(q)));
}

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** Rounded-rectangle signed distance (negative inside). */
const boxDist = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r, qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

/**
 * The Cabinet heightmap at (u, v) in [0, 1): a raised control deck with a
 * ball-top joystick in a round gate on the left and two rows of three dished
 * buttons on the right, over gently ribbed ground. Returns -1..1.
 */
export function cabinetHeight(u, v) {
  let z = -0.62 + 0.04 * Math.cos(2 * Math.PI * 6 * v);
  const deck = boxDist(u, v, 0.5, 0.52, 0.42, 0.24, 0.06);
  z += 0.5 * (1 - smooth(-0.012, 0.012, deck));
  if (deck < 0) {
    // joystick: a round gate groove, a thin shaft and a ball on top
    const jr = Math.hypot(u - 0.27, v - 0.52);
    z -= 0.1 * (1 - smooth(0.006, 0.014, Math.abs(jr - 0.09)));
    z += 0.5 * (1 - smooth(0.012, 0.022, jr));
    const ball = 0.065 - jr;
    if (ball > 0) z = Math.max(z, 0.35 + 0.65 * Math.sqrt(1 - (jr / 0.065) ** 2));
    // buttons: 2 rows of 3, slightly offset like a fighting stick
    for (let row = 0; row < 2; row++) {
      for (let k = 0; k < 3; k++) {
        const bx = 0.54 + k * 0.105, by = 0.45 + row * 0.15 - k * 0.018;
        const br = Math.hypot(u - bx, v - by);
        if (br < 0.06) {
          const rim = 1 - smooth(0.04, 0.05, br);
          const dish = 0.08 * (1 - (br / 0.04) ** 2);
          z = Math.max(z, -0.12 + 0.62 * rim - (br < 0.04 ? dish : 0));
        }
      }
    }
  }
  return Math.max(-1, Math.min(1, z));
}

/** Actual original image pixels. Resolution defaults to 512; 64 is used only for thumbnails. */
export function generateLibraryRgba(id, size = 512) {
  const e = typeof id === 'string' ? libraryEntry(id) : id;
  if (!e || !ENTRIES.has(e.id)) throw new Error('Unknown original terrain image');
  const n = Math.max(2, Math.min(1024, Math.round(size))), data = new Uint8Array(n * n * 4), rng = mulberry32(e.seed);
  if (e.family === 'cabinet') {
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const z = cabinetHeight((x + 0.5) / n, (y + 0.5) / n), o = (y * n + x) * 4;
      data[o] = Math.round(127.5 + 127.5 * z);
      data[o + 1] = Math.round(90 + 110 * Math.max(0, z));
      data[o + 2] = Math.round(60 + 60 * (1 - Math.abs(z)));
      data[o + 3] = 255;
    }
    return { width: n, height: n, data };
  }
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
