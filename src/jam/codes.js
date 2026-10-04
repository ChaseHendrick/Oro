// Jam together (2.12): invite and reply codes.
//
// Oro has no signalling server. The host's connection offer (an SDP with
// every ICE candidate already gathered) is packed into an invite code the
// host sends by any means they like; the friend's answer comes back the same
// way as a reply code. A code is
//
//   ORO-JAM-I1.<payload>.<word>      invite (I) or reply (R), format 1
//
// where <payload> is the JSON payload compressed with deflate-raw
// (CompressionStream) and written as base64url, and <word> is a short check
// word computed from the payload. Both people can read the word to each
// other to be sure they hold the same code, and a code that was cut short
// or changed while being copied fails the check instead of half-working.
// Without CompressionStream the payload is stored uncompressed (format 0).

export const CODE_KIND = Object.freeze({ invite: 'I', reply: 'R' });
export const MAX_CODE_CHARS = 60000;       // longer pastes are refused before decoding
export const MAX_PAYLOAD_BYTES = 128 * 1024; // decompressed JSON
export const MAX_SDP_CHARS = 48000;

// An original list of short, plain words (no two alike), for check words.
const WORDS = (
  'acorn amber anchor apple arch aspen atlas autumn badge bagel bamboo banjo barley basil beacon bean '
  + 'beech bell berry birch biscuit bison blossom bluff boat bolt bongo boot bramble brass breeze brick '
  + 'brook bubble bucket cabin cactus camel candle canoe canyon cargo carrot cedar cello chalk cherry chess '
  + 'chime cider cinder citrus clay cliff clover cobalt cocoa comet copper coral cotton cove crane crater '
  + 'cricket crown cymbal daisy delta denim dew dingo dolphin dove drum dune eagle echo elm ember fable '
  + 'falcon fern fiddle fig finch fjord flute fog forest fossil fox frost gecko geyser ginger glacier '
  + 'glove gong granite grape gravel grove guava gull harbor harp hazel heron hill honey horizon iris '
  + 'island ivory jade jasmine jelly jetty juniper kayak kelp kettle kiwi koala lagoon lantern larch '
  + 'lark lava lemon lilac lime linen lotus lute lynx magnet mango maple marble marsh meadow melon '
  + 'mesa mint mirror moss moth nectar nest nickel nutmeg oak oasis oboe ocean olive onyx opal orbit '
  + 'orchid otter owl oyster paddle palm panda papaya parsley pearl pebble pepper piano pine plum '
  + 'pond poppy prairie puffin quartz quill radish rain raven reed ridge river robin rocket rose saddle '
  + 'sage salmon sand sapphire satin shell sierra silk silver sitar sky slate sloth snow sparrow spruce '
  + 'squash star stone storm sugar summit swan tango teal thistle thunder tide tiger timber toast topaz '
  + 'tulip tundra turnip velvet violin walnut wave whale wheat willow wind wren yarrow yew zebra zinc '
  + 'zither ukulele umber valley vapor atoll beetle canary dahlia egret fennel garnet hammock ibis jigsaw kumquat'
).split(' ');

export const CHECK_WORDS = Object.freeze(WORDS.slice(0, 256));

export class CodeError extends Error {
  constructor(message, reason) { super(message); this.name = 'CodeError'; this.reason = reason; }
}

/** 32-bit FNV-1a of a string. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** The check word for a code payload. */
export function checkWord(payload) {
  return CHECK_WORDS[fnv1a(String(payload)) % CHECK_WORDS.length];
}

// ------------------------------------------------------------------ base64url

export function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new CodeError('This code has characters that do not belong in it. Copy it again.', 'chars');
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  let bin;
  try { bin = atob(b64); } catch { throw new CodeError('This code looks damaged. Copy it again.', 'base64'); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------- compression

const hasCompression = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

async function readAll(readable, limit) {
  const reader = readable.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { try { await reader.cancel(); } catch { /* ignore */ } throw new CodeError('This code is too large to be an Oro jam code.', 'size'); }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function deflate(bytes) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(bytes); writer.close();
  return readAll(cs.readable, Infinity);
}

async function inflate(bytes, limit) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  // Errors surface on the readable side; keep the writer's own promises quiet.
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  try { return await readAll(ds.readable, limit); } catch (err) {
    if (err instanceof CodeError) throw err;
    throw new CodeError('This code looks damaged. Copy it again.', 'inflate');
  }
}

// ----------------------------------------------------------------------- codes

/** Pack `payload` (a plain object) as an invite ('invite') or reply ('reply') code. */
export async function packCode(kind, payload) {
  const k = CODE_KIND[kind];
  if (!k) throw new Error(`unknown code kind ${kind}`);
  const json = new TextEncoder().encode(JSON.stringify(payload));
  if (json.length > MAX_PAYLOAD_BYTES) throw new CodeError('This connection offer is too large to fit in a code.', 'size');
  const zip = hasCompression();
  const body = toBase64Url(zip ? await deflate(json) : json);
  return `ORO-JAM-${k}${zip ? 1 : 0}.${body}.${checkWord(body)}`;
}

/** Remove whitespace, quotes and line breaks that chat apps and email add around pasted codes. */
export function tidyCode(text) {
  return String(text == null ? '' : text).replace(/[\s"'`<>​-‍﻿]/g, '');
}

/**
 * Read a pasted code. `expect` is 'invite' or 'reply'. Returns
 * { kind, payload, word }; throws CodeError with a friendly message.
 */
export async function unpackCode(text, expect) {
  const code = tidyCode(text);
  if (!code) throw new CodeError('Paste a code first.', 'empty');
  if (code.length > MAX_CODE_CHARS) throw new CodeError('This is too long to be an Oro jam code.', 'size');
  const m = /^ORO-JAM-([IR])([01])\.([A-Za-z0-9_-]+)\.([a-z]+)$/.exec(code);
  if (!m) {
    if (/^ORO-JAM-/i.test(code)) throw new CodeError('This code is incomplete. Copy all of it, including the word at the end.', 'shape');
    throw new CodeError('This is not an Oro jam code.', 'shape');
  }
  const kind = m[1] === 'I' ? 'invite' : 'reply';
  if (expect && kind !== expect) {
    throw new CodeError(expect === 'invite' ? 'This is a reply code. Paste it on the host\'s computer, under Invite.' : 'This is an invite code. Paste it under Join a jam.', 'kind');
  }
  if (checkWord(m[3]) !== m[4]) throw new CodeError('This code does not match its check word. Copy it again.', 'check');
  let bytes = fromBase64Url(m[3]);
  if (m[2] === '1') {
    if (!hasCompression()) throw new CodeError('This browser cannot read compressed jam codes.', 'support');
    bytes = await inflate(bytes, MAX_PAYLOAD_BYTES);
  } else if (bytes.length > MAX_PAYLOAD_BYTES) throw new CodeError('This is too long to be an Oro jam code.', 'size');
  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new CodeError('This code looks damaged. Copy it again.', 'json'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new CodeError('This code looks damaged. Copy it again.', 'json');
  return { kind, payload, word: m[4] };
}

// ------------------------------------------------------------------- payloads

const JAM_ID = /^[a-z0-9]{6,16}$/;
const SLOT_ID = /^p[1-5]$/;

/** A connection description from a code: { type, sdp } or null. */
export function sanitizeDescription(d, type) {
  if (!d || typeof d !== 'object' || d.type !== type || typeof d.sdp !== 'string') return null;
  if (d.sdp.length > MAX_SDP_CHARS || !d.sdp.startsWith('v=0')) return null;
  // SDP is line based text; nothing else belongs in it.
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(d.sdp)) return null;
  return { type, sdp: d.sdp };
}

/** { v, jam, slot, host, desc } from an invite payload, or null. */
export function readInvite(p) {
  if (!p || p.v !== 1 || !JAM_ID.test(p.jam) || !SLOT_ID.test(p.slot)) return null;
  const desc = sanitizeDescription(p.desc, 'offer');
  if (!desc) return null;
  const host = typeof p.host === 'string' ? p.host.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '').trim().slice(0, 24) : '';
  return { v: 1, jam: p.jam, slot: p.slot, host, desc };
}

/** { v, jam, slot, desc } from a reply payload, or null. */
export function readReply(p) {
  if (!p || p.v !== 1 || !JAM_ID.test(p.jam) || !SLOT_ID.test(p.slot)) return null;
  const desc = sanitizeDescription(p.desc, 'answer');
  return desc ? { v: 1, jam: p.jam, slot: p.slot, desc } : null;
}

/**
 * The connection's key as a short fingerprint ("3F9A-12C0") from the SDP's
 * DTLS certificate fingerprint, or '' when there is none. The certificate is
 * the per-jam random key a ban refers to.
 */
export function sdpFingerprint(sdp) {
  const m = /a=fingerprint:\S+\s+([0-9A-Fa-f:]+)/.exec(String(sdp || ''));
  if (!m) return '';
  const hex = m[1].replace(/:/g, '').toUpperCase();
  if (hex.length < 16) return '';
  const h = fnv1a(hex).toString(16).toUpperCase().padStart(8, '0');
  return `${h.slice(0, 4)}-${h.slice(4)}`;
}

/** A random id of `n` lower-case letters and digits. */
export function randomId(n = 10, random = defaultRandomBytes) {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = random(n);
  let s = '';
  for (let i = 0; i < n; i++) s += abc[bytes[i] % abc.length];
  return s;
}

function defaultRandomBytes(n) {
  const out = new Uint8Array(n);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') globalThis.crypto.getRandomValues(out);
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}
