// A minimal store-only ZIP writer and reader (2.11 stems export).
//
// Entries are stored uncompressed (method 0): audio barely compresses and a
// stored entry can be streamed from encoder pieces without ever holding the
// whole archive in one buffer. The writer takes each entry as a list of
// Uint8Array pieces, works out its CRC-32 on the way and keeps a Blob of it,
// so a browser can page large exports out of memory. Names are UTF-8 (flag
// bit 11). No ZIP64: the stems export refuses archives near 4 GB.
//
// The reader is small and strict (it checks every CRC); the tests use it for
// round trips.

let table = null;
function crcTable() {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

/** Continue a CRC-32 over `bytes` (start with crc32Update(0, ...)). */
export function crc32Update(crc, bytes) {
  const t = crcTable();
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const ZIP_LIMIT = 0xffffffff;
const utf8 = (s) => new TextEncoder().encode(String(s));

/** MS-DOS time and date words for a Date (local time, 2 s resolution, 1980 onwards). */
export function dosDateTime(date = new Date()) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function localHeader(name, crc, size, dt) {
  const n = utf8(name);
  const b = new Uint8Array(30 + n.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true);          // version needed
  v.setUint16(6, 0x0800, true);      // UTF-8 names
  v.setUint16(8, 0, true);           // stored
  v.setUint16(10, dt.time, true);
  v.setUint16(12, dt.date, true);
  v.setUint32(14, crc, true);
  v.setUint32(18, size, true);
  v.setUint32(22, size, true);
  v.setUint16(26, n.length, true);
  v.setUint16(28, 0, true);
  b.set(n, 30);
  return b;
}

function centralHeader(name, crc, size, dt, offset) {
  const n = utf8(name);
  const b = new Uint8Array(46 + n.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, 0x0314, true);      // made by: Unix, 2.0
  v.setUint16(6, 20, true);
  v.setUint16(8, 0x0800, true);
  v.setUint16(10, 0, true);
  v.setUint16(12, dt.time, true);
  v.setUint16(14, dt.date, true);
  v.setUint32(16, crc, true);
  v.setUint32(20, size, true);
  v.setUint32(24, size, true);
  v.setUint16(28, n.length, true);
  v.setUint32(38, (0o100644 << 16) >>> 0, true);   // -rw-r--r--
  v.setUint32(42, offset, true);
  b.set(n, 46);
  return b;
}

/**
 * createZipWriter() -> { add(name, pieces, {date}), size, names, finish() -> Blob }.
 * `pieces` is a Uint8Array, a string (written as UTF-8) or an array of Uint8Arrays.
 * `asBlob: false` keeps plain Uint8Arrays (finish() then returns one Uint8Array).
 */
export function createZipWriter({ asBlob = typeof Blob !== 'undefined' } = {}) {
  const parts = [];
  const central = [];
  const names = [];
  let offset = 0;
  return {
    get size() { return offset + central.reduce((s, c) => s + c.length, 0) + 22; },
    names,
    add(name, data, { date = new Date() } = {}) {
      const pieces = typeof data === 'string' ? [utf8(data)] : data instanceof Uint8Array ? [data] : data;
      let crc = 0, size = 0;
      for (const p of pieces) { crc = crc32Update(crc, p); size += p.length; }
      const dt = dosDateTime(date);
      const head = localHeader(name, crc, size, dt);
      if (offset + head.length + size + 1024 > ZIP_LIMIT) throw new Error('The archive would be larger than 4 GB');
      central.push(centralHeader(name, crc, size, dt, offset));
      parts.push(head);
      if (asBlob) parts.push(new Blob(pieces));
      else parts.push(...pieces);
      offset += head.length + size;
      names.push(name);
      return { crc, size };
    },
    finish() {
      const cdSize = central.reduce((s, c) => s + c.length, 0);
      const end = new Uint8Array(22);
      const v = new DataView(end.buffer);
      v.setUint32(0, 0x06054b50, true);
      v.setUint16(8, central.length, true);
      v.setUint16(10, central.length, true);
      v.setUint32(12, cdSize, true);
      v.setUint32(16, offset, true);
      const all = [...parts, ...central, end];
      if (asBlob) return new Blob(all, { type: 'application/zip' });
      const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
      let o = 0;
      for (const p of all) { out.set(p, o); o += p.length; }
      return out;
    },
  };
}

/**
 * Read a stored (method 0) ZIP: [{name, data, crc, date}] in central
 * directory order. Throws on anything malformed or a CRC mismatch.
 */
export function readZip(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let e = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (v.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('No end of central directory');
  const count = v.getUint16(e + 10, true);
  let p = v.getUint32(e + 16, true);
  const dec = new TextDecoder();
  const out = [];
  for (let k = 0; k < count; k++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('Bad central directory entry');
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extra = v.getUint16(p + 30, true), comment = v.getUint16(p + 32, true);
    const at = v.getUint32(p + 42, true);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
    if (method !== 0) throw new Error('Only stored entries are supported');
    if (v.getUint32(at, true) !== 0x04034b50) throw new Error('Bad local header');
    const lName = v.getUint16(at + 26, true), lExtra = v.getUint16(at + 28, true);
    if (dec.decode(b.subarray(at + 30, at + 30 + lName)) !== name) throw new Error('Local and central names differ');
    if (v.getUint32(at + 14, true) !== crc || v.getUint32(at + 18, true) !== size) throw new Error('Local and central headers differ');
    const start = at + 30 + lName + lExtra;
    const data = b.subarray(start, start + size);
    if (crc32Update(0, data) !== crc) throw new Error(`CRC mismatch in ${name}`);
    out.push({ name, data, crc, date: v.getUint16(p + 14, true), time: v.getUint16(p + 12, true) });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}
