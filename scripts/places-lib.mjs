// Pure helpers for scripts/build-places.mjs (Node built-ins only), kept apart
// so the tests can check them without the network: PNG decode and 16-bit
// grey encode (zlib), terrarium heights, area resampling, 16-bit
// normalisation, local map projection and the Bright Star Catalogue reader.

import zlib from 'node:zlib';

// ---- PNG ---------------------------------------------------------------------

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decode a non-interlaced PNG (grey, grey+alpha, RGB or RGBA; 8 or 16 bits).
 * @returns {{width:number, height:number, bitDepth:number, colorType:number, channels:number, data:Uint8Array}}
 *   data is the unfiltered sample bytes, row after row (16-bit samples big-endian).
 */
export function decodePng(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) throw new Error('Not a PNG file');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let pos = 8, header = null;
  const idat = [];
  while (pos + 8 <= b.length) {
    const len = dv.getUint32(pos), type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    const body = b.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      header = { width: dv.getUint32(pos + 8), height: dv.getUint32(pos + 12), bitDepth: b[pos + 16], colorType: b[pos + 17], interlace: b[pos + 20] };
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!header) throw new Error('PNG has no header');
  const { width, height, bitDepth, colorType, interlace } = header;
  const channels = CHANNELS[colorType];
  if (!channels || (bitDepth !== 8 && bitDepth !== 16) || interlace) throw new Error(`Unsupported PNG (type ${colorType}, ${bitDepth} bit, interlace ${interlace})`);
  const raw = zlib.inflateSync(Buffer.concat(idat.map(x => Buffer.from(x))));
  const bpp = channels * (bitDepth / 8), stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw new Error('PNG data is cut short');
  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)], src = y * (stride + 1) + 1, out = y * stride, prev = out - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x];
      const a = x >= bpp ? data[out + x - bpp] : 0, up = y > 0 ? data[prev + x] : 0, c = y > 0 && x >= bpp ? data[prev + x - bpp] : 0;
      data[out + x] = (type === 0 ? v : type === 1 ? v + a : type === 2 ? v + up : type === 3 ? v + ((a + up) >> 1) : v + paeth(a, up, c)) & 255;
    }
  }
  return { width, height, bitDepth, colorType, channels, data };
}

function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(body).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/**
 * 16-bit greyscale PNG of `values` (Uint16Array, w x h), each row filtered
 * with whichever of the five PNG filters gives the smallest sum of bytes
 * (the usual heuristic), deflated at level 9. Deterministic.
 */
export function encodeGray16Png(values, w, h) {
  const stride = w * 2, bpp = 2;
  const rows = new Uint8Array(h * stride);
  for (let i = 0; i < w * h; i++) { rows[i * 2] = values[i] >> 8; rows[i * 2 + 1] = values[i] & 255; }
  const out = new Uint8Array(h * (stride + 1));
  const cand = Array.from({ length: 5 }, () => new Uint8Array(stride));
  for (let y = 0; y < h; y++) {
    const cur = y * stride, prev = cur - stride;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = cand[f];
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const v = rows[cur + x], a = x >= bpp ? rows[cur + x - bpp] : 0, up = y > 0 ? rows[prev + x] : 0, ul = y > 0 && x >= bpp ? rows[prev + x - bpp] : 0;
        const p = f === 0 ? 0 : f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : paeth(a, up, ul);
        const d = (v - p) & 255;
        c[x] = d;
        sum += d < 128 ? d : 256 - d;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    out[y * (stride + 1)] = best;
    out.set(cand[best], y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 16; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from(SIG), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from(out), { level: 9, memLevel: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- heights -----------------------------------------------------------------

/** Mapzen / AWS terrarium encoding: metres = R * 256 + G + B / 256 - 32768. */
export function terrariumHeight(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

/** Heights (Float64Array, w x h) of a decoded terrarium tile. */
export function terrariumHeights(png) {
  if (png.bitDepth !== 8 || png.channels < 3) throw new Error('A terrarium tile is an 8-bit RGB(A) PNG');
  const n = png.width * png.height, out = new Float64Array(n), c = png.channels, d = png.data;
  for (let i = 0; i < n; i++) out[i] = terrariumHeight(d[i * c], d[i * c + 1], d[i * c + 2]);
  return out;
}

/**
 * Area-weighted resample of a w x h grid to dw x dh (each output cell is the
 * mean of the source area it covers; upsampling falls back to bilinear).
 */
export function resampleArea(src, w, h, dw, dh) {
  const out = new Float64Array(dw * dh);
  if (dw > w || dh > h) {
    for (let y = 0; y < dh; y++) {
      const sy = Math.max(0, Math.min(h - 1, (y + 0.5) * h / dh - 0.5)), y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), fy = sy - y0;
      for (let x = 0; x < dw; x++) {
        const sx = Math.max(0, Math.min(w - 1, (x + 0.5) * w / dw - 0.5)), x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0;
        const a = src[y0 * w + x0] * (1 - fx) + src[y0 * w + x1] * fx, b = src[y1 * w + x0] * (1 - fx) + src[y1 * w + x1] * fx;
        out[y * dw + x] = a * (1 - fy) + b * fy;
      }
    }
    return out;
  }
  const axis = (n, m) => {
    // For each output cell: list of [source index, weight].
    const cells = [];
    const scale = n / m;
    for (let j = 0; j < m; j++) {
      const a = j * scale, b = (j + 1) * scale, list = [];
      for (let i = Math.floor(a); i < Math.min(n, Math.ceil(b)); i++) {
        const wgt = Math.min(b, i + 1) - Math.max(a, i);
        if (wgt > 1e-12) list.push([i, wgt / scale]);
      }
      cells.push(list);
    }
    return cells;
  };
  const ax = axis(w, dw), ay = axis(h, dh);
  const tmp = new Float64Array(dw * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < dw; x++) {
    let s = 0;
    for (const [i, wgt] of ax[x]) s += src[y * w + i] * wgt;
    tmp[y * dw + x] = s;
  }
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    let s = 0;
    for (const [i, wgt] of ay[y]) s += tmp[i * dw + x] * wgt;
    out[y * dw + x] = s;
  }
  return out;
}

/** Stretch heights over 0..65535. Returns the 16-bit grid and the real range it covers. */
export function normalise16(values) {
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  const out = new Uint16Array(values.length), span = max - min;
  if (span > 0) for (let i = 0; i < values.length; i++) out[i] = Math.max(0, Math.min(65535, Math.round((values[i] - min) / span * 65535)));
  return { data: out, min, max };
}

// ---- maps --------------------------------------------------------------------

/** Web Mercator: lat/lon -> global pixel position at zoom z (256-pixel tiles). */
export function lonLatToPixel(lat, lon, z) {
  const n = 256 * 2 ** z, r = lat * Math.PI / 180;
  return { x: (lon + 180) / 360 * n, y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n };
}

/** Ground metres per pixel of a Web Mercator tile pyramid at latitude `lat`, zoom z. */
export function metresPerPixel(lat, z) {
  return 156543.03392804097 * Math.cos(lat * Math.PI / 180) / 2 ** z;
}

/**
 * Inverse azimuthal equidistant projection about (lat0, lon0) on a sphere of
 * radius R: a point x east, y north (same unit as R) -> { lat, lon } degrees.
 */
export function localToLatLon(x, y, lat0, lon0, R) {
  const rad = Math.PI / 180, p1 = lat0 * rad, rho = Math.hypot(x, y);
  if (rho < 1e-12) return { lat: lat0, lon: lon0 };
  const c = rho / R;
  const lat = Math.asin(Math.cos(c) * Math.sin(p1) + y * Math.sin(c) * Math.cos(p1) / rho);
  let lon = lon0 + Math.atan2(x * Math.sin(c), rho * Math.cos(p1) * Math.cos(c) - y * Math.sin(p1) * Math.sin(c)) / rad;
  lon = ((lon + 180) % 360 + 360) % 360 - 180;
  return { lat: lat / rad, lon };
}

// ---- Bright Star Catalogue ---------------------------------------------------

/**
 * One line of the Yale Bright Star Catalogue, 5th revised edition (CDS V/50
 * `catalog`, fixed columns): { hr, name, ra, dec, mag } with J2000 degrees,
 * or null for the entries without a position or V magnitude (novae, clusters).
 */
export function parseBscLine(line) {
  if (line.length < 107) return null;
  const hr = parseInt(line.slice(0, 4), 10);
  const rah = line.slice(75, 77).trim(), ram = line.slice(77, 79).trim(), ras = line.slice(79, 83).trim();
  const sign = line[83], ded = line.slice(84, 86).trim(), dem = line.slice(86, 88).trim(), des = line.slice(88, 90).trim();
  const vmag = line.slice(102, 107).trim();
  if (!rah || !ded || !vmag) return null;
  const ra = (Number(rah) + Number(ram) / 60 + Number(ras) / 3600) * 15;
  const dec = (sign === '-' ? -1 : 1) * (Number(ded) + Number(dem) / 60 + Number(des) / 3600);
  const mag = Number(vmag);
  if (![hr, ra, dec, mag].every(Number.isFinite)) return null;
  return { hr, name: line.slice(4, 14).trim(), ra, dec, mag };
}
