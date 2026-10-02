// Test helper: a straightforward PNG encoder (any colour type, bit depth,
// filter choice and Adam7 interlacing), so the decoder can be checked against
// files whose every sample is known. Node only (uses node:zlib).

import { deflateSync } from 'node:zlib';
import { crc32 } from '../../src/audio/png.js';

const CH = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function packRow(samples, count, ch, depth) {
  const bytes = new Uint8Array(Math.ceil(count * ch * depth / 8));
  if (depth === 16) {
    for (let i = 0; i < count * ch; i++) { bytes[2 * i] = samples[i] >> 8; bytes[2 * i + 1] = samples[i] & 255; }
  } else if (depth === 8) {
    bytes.set(samples.slice(0, count * ch));
  } else {
    for (let i = 0; i < count; i++) {
      const bit = i * depth;
      bytes[bit >> 3] |= samples[i] << (8 - depth - (bit & 7));
    }
  }
  return bytes;
}

function filterRow(type, raw, prior, bpp) {
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const a = i >= bpp ? raw[i - bpp] : 0, b = prior[i], c = i >= bpp ? prior[i - bpp] : 0;
    const pred = type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : paeth(a, b, c);
    out[i] = (raw[i] - pred) & 255;
  }
  return out;
}

/**
 * @param {object} o
 * @param {number} o.width
 * @param {number} o.height
 * @param {number} o.colorType 0 | 2 | 3 | 4 | 6
 * @param {number} o.bitDepth
 * @param {ArrayLike<number>} o.samples width * height * channels integers, row-major
 * @param {number|'cycle'} [o.filter] filter type for every row, or 'cycle' through 0..4
 * @param {boolean} [o.interlace]
 * @param {Uint8Array} [o.palette] RGB triples (colour type 3)
 * @param {Uint8Array} [o.trns]
 * @param {number} [o.idatSplit] split the zlib stream over this many IDAT chunks
 * @param {Uint8Array[]} [o.extraChunks] raw chunks inserted before IDAT
 */
export function encodePng({ width, height, colorType, bitDepth, samples, filter = 'cycle', interlace = false, palette, trns, idatSplit = 1, extra = [] }) {
  const ch = CH[colorType];
  const bpp = Math.max(1, (ch * bitDepth) >> 3);
  const grids = interlace ? ADAM7 : [[0, 0, 1, 1]];
  const raw = [];
  let rowNo = 0;
  for (const [x0, y0, dx, dy] of grids) {
    const w = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const h = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    if (!w || !h) continue;
    let prior = new Uint8Array(Math.ceil(w * ch * bitDepth / 8));
    for (let r = 0; r < h; r++) {
      const y = y0 + r * dy;
      const s = [];
      for (let k = 0; k < w; k++) {
        const x = x0 + k * dx;
        for (let c = 0; c < ch; c++) s.push(samples[(y * width + x) * ch + c]);
      }
      const row = packRow(s, w, ch, bitDepth);
      const type = filter === 'cycle' ? rowNo % 5 : filter;
      raw.push(type, ...filterRow(type, row, prior, bpp));
      prior = row;
      rowNo++;
    }
  }
  const z = deflateSync(Uint8Array.from(raw));
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = bitDepth; ihdr[9] = colorType; ihdr[12] = interlace ? 1 : 0;
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (palette) parts.push(chunk('PLTE', palette));
  if (trns) parts.push(chunk('tRNS', trns));
  for (const e of extra) parts.push(e);
  const step = Math.ceil(z.length / idatSplit);
  for (let i = 0; i < z.length; i += step) parts.push(chunk('IDAT', z.subarray(i, i + step)));
  parts.push(chunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export { chunk as pngChunk };
