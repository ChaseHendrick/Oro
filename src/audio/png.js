// A small streaming PNG decoder for height maps.
//
// Why not just draw the file into a canvas? A canvas hands back 8-bit,
// colour-managed pixels: a 16-bit digital elevation model (DEM) loses 8 of
// its 16 bits before we see it, and a height map whose values only use a
// narrow band of the range turns into a few terraces. Reading the file
// ourselves keeps every bit and treats the samples as data, not light.
//
// Supported: every PNG colour type (grey, RGB, palette, grey + alpha, RGBA),
// every bit depth (1, 2, 4, 8, 16), tRNS transparency, all five scanline
// filters and Adam7 interlacing. The zlib stream is inflated with the
// platform's DecompressionStream('deflate') and unfiltered as it arrives, so a
// large DEM is never held in memory as a whole: rows are handed to a callback
// and can be reduced on the fly. CRCs are not checked (the zlib stream has its
// own Adler-32 checksum, which DecompressionStream verifies), so a file with a
// damaged ancillary chunk still opens, as it does in browsers.

export const PNG_SIGNATURE = Object.freeze([137, 80, 78, 71, 13, 10, 26, 10]);
/** Largest image we agree to decode (pixels); bigger files are almost certainly hostile or a mistake. */
export const MAX_PNG_PIXELS = 120e6;
export const MAX_PNG_SIDE = 65535;
const YIELD_MS = 8;
const SLICE_BYTES = 1 << 16;

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

// Adam7: [x0, y0, dx, dy] of each pass.
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

let crcTable = null;
/** CRC-32 (ISO 3309), as used by PNG chunks. Exported for building test files. */
export function crc32(bytes, start = 0, end = bytes.length) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function isPng(bytes) {
  if (!bytes || bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  return true;
}

const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const tag = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

/**
 * Walk the chunks of a PNG file.
 * @param {Uint8Array} bytes the whole file
 * @returns {{header: {width, height, bitDepth, colorType, interlace: 0|1, channels},
 *   palette: Uint8Array|null, trns: Uint8Array|null, idat: Uint8Array[], gamma: number}}
 * @throws Error with a message fit for the user when the file is not a usable PNG
 */
export function readPngChunks(bytes) {
  if (!isPng(bytes)) throw new Error('This is not a PNG file');
  let p = 8;
  let header = null, palette = null, trns = null, gamma = 0, ended = false;
  const idat = [];
  while (p + 8 <= bytes.length) {
    const len = u32(bytes, p);
    const type = tag(bytes, p + 4);
    const start = p + 8;
    if (len > bytes.length - start) {
      // A file cut short in its image data is damaged; anything after the image data is not needed.
      if (type === 'IDAT' || !header || !idat.length) throw new Error('This PNG file is cut short (incomplete download?)');
      break;
    }
    const data = bytes.subarray(start, start + len);
    if (!header && type !== 'IHDR') throw new Error('This PNG file is damaged (no header)');
    if (type === 'IHDR') {
      if (header) throw new Error('This PNG file is damaged (two headers)');
      if (len < 13) throw new Error('This PNG file is damaged (short header)');
      header = {
        width: u32(data, 0), height: u32(data, 4), bitDepth: data[8], colorType: data[9],
        compression: data[10], filter: data[11], interlace: data[12],
      };
      validateHeader(header);
      header.channels = CHANNELS[header.colorType];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'gAMA' && len >= 4) {
      gamma = u32(data, 0) / 100000;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
      break;
    } else if (!(type.charCodeAt(0) & 32)) {
      // Upper-case first letter = critical chunk we do not understand: the
      // spec says decoding must stop rather than guess.
      throw new Error(`This PNG file uses a feature Oro cannot read (${type.replace(/[^\x20-\x7e]/g, '?')})`);
    }
    p = start + len + 4; // skip the CRC
  }
  if (!header) throw new Error('This PNG file is damaged (no header)');
  if (!idat.length) throw new Error(ended ? 'This PNG file has no image data' : 'This PNG file is cut short (incomplete download?)');
  if (header.colorType === 3 && (!palette || palette.length < 3)) throw new Error('This PNG file is damaged (palette missing)');
  return { header, palette, trns, idat, gamma };
}

function validateHeader(h) {
  if (!(h.width > 0 && h.height > 0) || h.width > 0x7fffffff || h.height > 0x7fffffff) throw new Error('This PNG file has an invalid size');
  const depths = DEPTHS[h.colorType];
  if (!depths) throw new Error('This PNG file is damaged (unknown colour type)');
  if (!depths.includes(h.bitDepth)) throw new Error('This PNG file is damaged (invalid bit depth)');
  if (h.compression !== 0 || h.filter !== 0 || (h.interlace !== 0 && h.interlace !== 1)) throw new Error('This PNG file uses an unknown compression or filter method');
  // Row buffers are allocated whole, so very long rows are refused too.
  if (h.width * h.height > MAX_PNG_PIXELS || h.width > MAX_PNG_SIDE || h.height > MAX_PNG_SIDE) {
    throw new Error(`This PNG is ${h.width} x ${h.height} pixels; images up to about ${Math.round(MAX_PNG_PIXELS / 1e6)} megapixels (and ${MAX_PNG_SIDE} pixels a side) can be imported`);
  }
}

/**
 * Scanline geometry: bytes per complete pixel (the filters' left distance),
 * and for each (Adam7) pass its pixel grid and row length in bytes.
 */
export function pngLayout(header) {
  const { width: W, height: H, bitDepth, channels, interlace } = header;
  const bitsPerPixel = channels * bitDepth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const grids = interlace ? ADAM7 : [[0, 0, 1, 1]];
  const passes = [];
  for (const [x0, y0, dx, dy] of grids) {
    const w = W > x0 ? Math.ceil((W - x0) / dx) : 0;
    const h = H > y0 ? Math.ceil((H - y0) / dy) : 0;
    // An empty pass has no bytes at all, not even filter bytes.
    if (w && h) passes.push({ x0, y0, dx, dy, w, h, rowBytes: Math.ceil(w * bitsPerPixel / 8) });
  }
  return { bitsPerPixel, bpp, passes };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Undo one scanline's filter in place. `prev` is the previous unfiltered row of the same pass (zeros for the first). */
export function unfilterRow(type, cur, prev, bpp) {
  const n = cur.length;
  switch (type) {
    case 0: break;
    case 1: for (let i = bpp; i < n; i++) cur[i] = cur[i] + cur[i - bpp]; break;
    case 2: for (let i = 0; i < n; i++) cur[i] = cur[i] + prev[i]; break;
    case 3:
      for (let i = 0; i < bpp && i < n; i++) cur[i] = cur[i] + (prev[i] >> 1);
      for (let i = bpp; i < n; i++) cur[i] = cur[i] + ((cur[i - bpp] + prev[i]) >> 1);
      break;
    case 4:
      for (let i = 0; i < bpp && i < n; i++) cur[i] = cur[i] + prev[i];
      for (let i = bpp; i < n; i++) cur[i] = cur[i] + paeth(cur[i - bpp], prev[i], prev[i - bpp]);
      break;
    default: throw new Error(`This PNG file is damaged (unknown row filter ${type})`);
  }
}

/**
 * Feed inflated bytes in any chunking; complete rows come out unfiltered.
 * onRow(pass, rowInPass, row) receives a view that is reused for the next
 * row of that pass, so copy it if you keep it.
 */
export function createUnfilter(layout, onRow) {
  const { bpp, passes } = layout;
  let pi = 0, y = 0, fill = 0, filterType = -1;
  let cur = passes.length ? new Uint8Array(passes[0].rowBytes) : null;
  let prev = passes.length ? new Uint8Array(passes[0].rowBytes) : null;
  const done = () => pi >= passes.length;
  return {
    done,
    push(chunk) {
      let i = 0;
      const n = chunk.length;
      while (i < n && !done()) {
        if (filterType < 0) { filterType = chunk[i++]; continue; }
        const take = Math.min(cur.length - fill, n - i);
        cur.set(chunk.subarray(i, i + take), fill);
        fill += take; i += take;
        if (fill < cur.length) break;
        unfilterRow(filterType, cur, prev, bpp);
        onRow(pi, y, cur);
        const t = prev; prev = cur; cur = t;
        fill = 0; filterType = -1; y++;
        if (y >= passes[pi].h) {
          pi++; y = 0;
          if (!done()) { cur = new Uint8Array(passes[pi].rowBytes); prev = new Uint8Array(passes[pi].rowBytes); }
        }
      }
      // Bytes after the last row (some encoders pad) are ignored.
    },
  };
}

/** A function reading sample `c` of pixel `i` of an unfiltered row, as an integer. */
export function sampleReader(header) {
  const { bitDepth: d, channels: ch } = header;
  if (d === 16) return (row, i, c) => (row[2 * (i * ch + c)] << 8) | row[2 * (i * ch + c) + 1];
  if (d === 8) return (row, i, c) => row[i * ch + c];
  const mask = (1 << d) - 1;
  // Sub-byte depths only exist for one-channel types; pixels are packed MSB first.
  return (row, i) => {
    const bit = i * d;
    return (row[bit >> 3] >> (8 - d - (bit & 7))) & mask;
  };
}

const yieldTask = () => new Promise(r => setTimeout(r, 0));
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Inflate a zlib stream given as pieces, handing each output chunk to onData.
 * Yields to the event loop every few milliseconds of work so a big file never
 * freezes the page.
 */
export async function inflateZlib(pieces, onData, { stats } = {}) {
  if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot unpack PNG data (no DecompressionStream)');
  const stream = new Blob(pieces).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  let t0 = nowMs();
  try {
    for (;;) {
      let r;
      try { r = await reader.read(); } catch { throw new Error('This PNG file is damaged (its image data does not unpack)'); }
      if (r.done) break;
      // The platform may hand over the whole image in one chunk; slicing it
      // keeps each synchronous step short whatever the chunking.
      const chunk = r.value;
      for (let o = 0; o < chunk.length; o += SLICE_BYTES) {
        const b0 = nowMs();
        onData(o === 0 && chunk.length <= SLICE_BYTES ? chunk : chunk.subarray(o, o + SLICE_BYTES));
        if (stats) {
          const ms = nowMs() - b0;
          stats.maxBlockMs = Math.max(stats.maxBlockMs || 0, ms);
          if (stats.steps) stats.steps.png = Math.max(stats.steps.png || 0, Math.round(ms * 10) / 10);
        }
        if (nowMs() - t0 > YIELD_MS) { await yieldTask(); t0 = nowMs(); }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

/**
 * Decode a PNG row by row.
 * onRow({ y, x0, dx, count, row, read }) is called for every (pass) row:
 * pixel k of the row sits at image x = x0 + k * dx, and read(row, k, c) is its
 * sample c (integer, 0 .. 2^bitDepth - 1).
 * @param {Uint8Array} bytes the file
 * @param {Function} onRow
 * @param {{info?: object, stats?: object}} [opts] info: a readPngChunks result for these bytes (saves re-parsing)
 * @returns {Promise<object>} the parsed chunks ({header, palette, trns, ...}) plus the layout
 */
export async function decodePngRows(bytes, onRow, { info = null, stats } = {}) {
  const png = info || readPngChunks(bytes);
  const layout = pngLayout(png.header);
  const read = sampleReader(png.header);
  const un = createUnfilter(layout, (pass, y, row) => {
    const P = layout.passes[pass];
    onRow({ y: P.y0 + y * P.dy, x0: P.x0, dx: P.dx, count: P.w, row, read });
  });
  try {
    await inflateZlib(png.idat, (chunk) => un.push(chunk), { stats });
  } catch (err) {
    // Junk after the end of the zlib stream, or a damaged checksum after the
    // last row, is ignored by browsers too: every pixel is already here.
    if (!un.done()) throw err;
  }
  if (!un.done()) throw new Error('This PNG file is cut short (incomplete download?)');
  return { ...png, layout };
}

/** Palette (+ tRNS alpha) as one flat array of 8-bit RGB or RGBA entries. */
export function expandPalette(palette, trns) {
  const n = Math.floor(palette.length / 3);
  const ch = trns && trns.length ? 4 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0; i < n; i++) {
    out[i * ch] = palette[3 * i]; out[i * ch + 1] = palette[3 * i + 1]; out[i * ch + 2] = palette[3 * i + 2];
    if (ch === 4) out[i * ch + 3] = i < trns.length ? trns[i] : 255;
  }
  return { entries: n, channels: ch, data: out };
}

/**
 * Whole-image decode for small files and tests: samples as integers, palette
 * expanded to 8-bit RGB (RGBA when it has transparency). Out-of-range palette
 * indices read as black, as in browsers.
 * @returns {Promise<{width, height, bitDepth, colorType, channels, data: Uint16Array}>}
 */
export async function decodePng(bytes) {
  const info = readPngChunks(bytes);
  const { width: W, height: H, colorType } = info.header;
  const pal = colorType === 3 ? expandPalette(info.palette, info.trns) : null;
  const outCh = pal ? pal.channels : info.header.channels;
  const data = new Uint16Array(W * H * outCh);
  await decodePngRows(bytes, ({ y, x0, dx, count, row, read }) => {
    for (let k = 0; k < count; k++) {
      const o = (y * W + x0 + k * dx) * outCh;
      if (pal) {
        const idx = read(row, k, 0);
        if (idx < pal.entries) for (let c = 0; c < outCh; c++) data[o + c] = pal.data[idx * outCh + c];
      } else {
        for (let c = 0; c < outCh; c++) data[o + c] = read(row, k, c);
      }
    }
  }, { info });
  return { width: W, height: H, bitDepth: pal ? 8 : info.header.bitDepth, colorType, channels: outCh, data };
}
