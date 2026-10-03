// v2.9 Postcards and share links: one track's sound (its patch) travelling
// outside Oro, either hidden in a PNG image or packed into a link.
//
//   PNG: an iTXt chunk with keyword 'oro-patch' holding the postcard record
//     as UTF-8 JSON: { format: 'oro-postcard', version, patch }. The image is
//     still an ordinary PNG; other programs ignore the chunk.
//   Link: https://www.hendrickresearch.com/music/oro/#p=<data> where data is
//     'z.' + base64url(deflate-raw(record JSON)), or 'j.' + base64url(JSON)
//     when this browser cannot compress.
//
// Everything read back goes through sanitizePatch (the same code as a patch
// file import) and is size-capped while it is being read. Pure functions:
// they run in Node for the tests.

import { crc32, isPng } from '../audio/png.js';
import { sanitizePatch } from './presets.js';

export const POSTCARD_KEYWORD = 'oro-patch';
export const POSTCARD_FORMAT = 'oro-postcard';
export const SHARE_BASE = 'https://www.hendrickresearch.com/music/oro/';
export const SITE_SHORT = 'hendrickresearch.com/music/oro';
/** Largest decompressed link payload accepted (bytes). */
export const MAX_LINK_BYTES = 256 * 1024;
/** Largest link data string read at all (characters). */
export const MAX_LINK_CHARS = 512 * 1024;
/** Largest postcard text chunk read from an image (bytes). */
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
/** Above this many characters of link data, imported terrains are left out of the link. */
export const LINK_SOFT_CHARS = 12000;

const enc = new TextEncoder();

// ------------------------------------------------------------------ base64url

export function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error('bad base64');
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ------------------------------------------------------------------ records

/** The postcard record for a patch (see partPatch in presets.js). */
export function postcardRecord(patch, version = '') {
  return { format: POSTCARD_FORMAT, version: String(version || '').slice(0, 20), patch };
}

/** A record (or a bare patch) -> { patch: sanitized, version } or null. */
export function readRecord(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const src = obj.format === POSTCARD_FORMAT ? obj.patch : obj;
  const patch = sanitizePatch(src);
  if (!patch) return null;
  return { patch, version: typeof obj.version === 'string' ? obj.version.slice(0, 20) : '' };
}

// ------------------------------------------------------------------ PNG chunks

const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const tagAt = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

/** One PNG chunk (length, type, data, CRC). */
export function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** An uncompressed iTXt chunk: keyword (Latin-1, 1 to 79 bytes) and UTF-8 text. */
export function itxtChunk(keyword, text) {
  if (!/^[\x20-\x7e]{1,79}$/.test(keyword)) throw new Error('PNG text keywords are 1 to 79 plain characters');
  const kw = enc.encode(keyword), body = enc.encode(String(text));
  const data = new Uint8Array(kw.length + 5 + body.length);
  data.set(kw, 0);
  // keyword NUL, compression flag 0, method 0, empty language NUL, empty translated keyword NUL
  data.set(body, kw.length + 5);
  return pngChunk('iTXt', data);
}

/** `png` with `chunk` inserted just before IEND. */
export function insertChunk(png, chunk) {
  if (!isPng(png)) throw new Error('This is not a PNG file');
  let p = 8;
  while (p + 8 <= png.length) {
    const len = u32(png, p);
    if (tagAt(png, p + 4) === 'IEND') {
      const out = new Uint8Array(png.length + chunk.length);
      out.set(png.subarray(0, p), 0);
      out.set(chunk, p);
      out.set(png.subarray(p), p + chunk.length);
      return out;
    }
    p += 12 + len;
  }
  throw new Error('This PNG file has no end marker');
}

/**
 * The text of the first iTXt (uncompressed) or tEXt chunk named `keyword`,
 * or null. Throws when that chunk is larger than `maxBytes`.
 */
export function readPngText(png, keyword, { maxBytes = MAX_CHUNK_BYTES } = {}) {
  if (!isPng(png)) return null;
  const kw = enc.encode(keyword);
  let p = 8;
  while (p + 8 <= png.length) {
    const len = u32(png, p), type = tagAt(png, p + 4), start = p + 8;
    if (len > png.length - start) return null;
    if (type === 'IEND') return null;
    if ((type === 'iTXt' || type === 'tEXt') && len > kw.length && kw.every((c, i) => png[start + i] === c) && png[start + kw.length] === 0) {
      if (len > maxBytes) throw new Error('The sound in this image is too large to load');
      const data = png.subarray(start + kw.length + 1, start + len);
      if (type === 'tEXt') return new TextDecoder('latin1').decode(data);
      if (data[0] !== 0) return null;   // compressed iTXt: not written by Oro
      let q = 2;
      for (let n = 0; n < 2; n++) { while (q < data.length && data[q] !== 0) q++; q++; }
      if (q > data.length) return null;
      return new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(q));
    }
    p = start + len + 4;
  }
  return null;
}

/** A copy of the PNG bytes carrying `patch` (and Oro's version) as a postcard. */
export function embedPatch(png, patch, version) {
  return insertChunk(png, itxtChunk(POSTCARD_KEYWORD, JSON.stringify(postcardRecord(patch, version))));
}

/**
 * The postcard in PNG bytes: { patch (sanitized), version }, or null when the
 * image has none. Throws with a message fit for a person when it has one that
 * cannot be read.
 */
export function readPostcard(png) {
  let text;
  try { text = readPngText(png, POSTCARD_KEYWORD); } catch (err) { throw new Error(err.message || 'The sound in this image could not be read'); }
  if (text == null) return null;
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('The sound in this image is damaged'); }
  const rec = readRecord(obj);
  if (!rec) throw new Error('The sound in this image is damaged');
  return rec;
}

// ------------------------------------------------------------------ links

const canCompress = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

async function streamBytes(readable, maxBytes) {
  const reader = readable.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      reader.cancel().catch(() => {});
      throw new LinkError('too-big', 'This shared sound is too large to open');
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of parts) { out.set(part, o); o += part.length; }
  return out;
}

function pipeThrough(bytes, stream, maxBytes) {
  const writer = stream.writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  return streamBytes(stream.readable, maxBytes);
}

/** A share link problem; `reason` is 'malformed', 'too-big' or 'not-a-sound'. */
export class LinkError extends Error {
  constructor(reason, message) { super(message); this.reason = reason; }
}

/** The data part of a share link for a record. `compress: false` forces the plain form. */
export async function encodeLinkData(record, { compress = canCompress() } = {}) {
  const bytes = enc.encode(JSON.stringify(record));
  if (compress) return 'z.' + toBase64Url(await pipeThrough(bytes, new CompressionStream('deflate-raw'), Infinity));
  return 'j.' + toBase64Url(bytes);
}

/**
 * Link data -> { patch (sanitized like a patch import), version }.
 * The decompressed size is capped at `maxBytes` while it is being inflated.
 * @throws LinkError
 */
export async function decodeLinkData(data, { maxBytes = MAX_LINK_BYTES } = {}) {
  const malformed = () => new LinkError('malformed', 'This link is damaged or incomplete');
  if (typeof data !== 'string' || data.length < 3 || data.length > MAX_LINK_CHARS) {
    if (typeof data === 'string' && data.length > MAX_LINK_CHARS) throw new LinkError('too-big', 'This shared sound is too large to open');
    throw malformed();
  }
  const kind = data.slice(0, 2);
  if (kind !== 'z.' && kind !== 'j.') throw malformed();
  let raw;
  try { raw = fromBase64Url(data.slice(2)); } catch { throw malformed(); }
  let bytes;
  if (kind === 'z.') {
    if (typeof DecompressionStream !== 'function') throw new LinkError('malformed', 'This browser cannot open compressed links. Try a current browser');
    try { bytes = await pipeThrough(raw, new DecompressionStream('deflate-raw'), maxBytes); } catch (err) {
      if (err instanceof LinkError) throw err;
      throw malformed();
    }
  } else {
    if (raw.length > maxBytes) throw new LinkError('too-big', 'This shared sound is too large to open');
    bytes = raw;
  }
  let obj;
  try { obj = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw malformed(); }
  const rec = readRecord(obj);
  if (!rec) throw new LinkError('not-a-sound', 'This link does not hold an Oro sound');
  return rec;
}

/** The link data in a location hash ('#p=...'), or null. */
export function linkDataFromHash(hash) {
  const h = String(hash || '').replace(/^#/, '');
  if (!h) return null;
  for (const piece of h.split('&')) {
    if (piece.startsWith('p=')) {
      try { return decodeURIComponent(piece.slice(2)); } catch { return piece.slice(2); }
    }
  }
  return null;
}

export const shareUrl = (data) => `${SHARE_BASE}#p=${data}`;

/**
 * The link for a patch. A link with an imported terrain is usually far too
 * long to share, so above LINK_SOFT_CHARS the imported terrains are left out
 * (the postcard image keeps them): { url, data, trimmed }.
 */
export async function linkFor(patch, version, opts) {
  let data = await encodeLinkData(postcardRecord(patch, version), opts);
  let trimmed = false;
  if (data.length > LINK_SOFT_CHARS && patch && patch.userTerrain) {
    const { userTerrain, ...rest } = patch;
    data = await encodeLinkData(postcardRecord(rest, version), opts);
    trimmed = true;
  }
  return { url: shareUrl(data), data, trimmed };
}

// ------------------------------------------------------------------ sharing text

export const shareText = (name) => `A sound I made in Oro: "${String(name || 'Untitled')}".`;
/** The caption for posts: text and link together. */
export const caption = (name, url) => `${shareText(name)} Open it: ${url}`;

/** Public share pages of the social sites, each opened in a new tab. */
export function shareTargets(url, name) {
  const e = encodeURIComponent;
  const text = `${shareText(name)} Open it:`;
  const full = caption(name, url);
  return [
    { id: 'x', label: 'X', href: `https://x.com/intent/post?text=${e(text)}&url=${e(url)}` },
    { id: 'facebook', label: 'Facebook', href: `https://www.facebook.com/sharer/sharer.php?u=${e(url)}` },
    { id: 'bluesky', label: 'Bluesky', href: `https://bsky.app/intent/compose?text=${e(full)}` },
    { id: 'threads', label: 'Threads', href: `https://www.threads.net/intent/post?text=${e(full)}` },
    { id: 'reddit', label: 'Reddit', href: `https://www.reddit.com/submit?url=${e(url)}&title=${e(`A sound I made in Oro: "${String(name || 'Untitled')}"`)}` },
    { id: 'linkedin', label: 'LinkedIn', href: `https://www.linkedin.com/sharing/share-offsite/?url=${e(url)}` },
  ];
}
