// Jam together (2.12): the messages people's computers send each other, and
// the checks every message goes through before anything acts on it.
//
// The host relays everything: a guest ("up") only ever talks to the host and
// the host ("down") talks to every guest. Each message is a small JSON object
// with a type `t`. sanitizeMessage() rebuilds it from scratch, keeping only
// the fields its type allows, each checked and clamped; a message of an
// unknown type, or one that fails a check, is dropped (null). Nothing in a
// message is ever run as code, used as HTML, or merged into an object as it
// came (session data goes through src/core/migrate.js).

export const PROTOCOL_VERSION = 1;
export const MAX_PEOPLE = 6;                 // host + 5 guests
export const GUEST_IDS = Object.freeze(['p1', 'p2', 'p3', 'p4', 'p5']);
export const HOST_ID = 'h';
export const NAME_MAX = 24;
export const CHAT_MAX = 500;
export const CHAT_RATE = Object.freeze({ count: 5, windowMs: 10000 });
// Raw message sizes (characters of JSON), checked before parsing.
export const MAX_MESSAGE_CHARS = 16 * 1024;          // everything ordinary
export const MAX_PART_CHARS = 8 * 1024 * 1024;       // a whole track (it may carry an imported terrain)
export const MAX_SNAPSHOT_CHARS = 24 * 1024 * 1024;  // the host's session, host to guest only
export const ROLES = Object.freeze(['owner', 'mod', 'member']);
export const MOD_ACTIONS = Object.freeze(['muteMic', 'unmuteMic', 'muteChat', 'unmuteChat', 'remove', 'ban', 'lock', 'unlock', 'clearChat', 'reclaim', 'makeMod', 'unmakeMod', 'giveTrack', 'handGlobal']);
export const SYS_KINDS = Object.freeze(['join', 'leave', 'muteMic', 'unmuteMic', 'muteChat', 'unmuteChat', 'remove', 'ban', 'lock', 'unlock', 'clearChat', 'reclaim', 'makeMod', 'unmakeMod', 'giveTrack', 'handGlobal', 'claim', 'release', 'voiceOn', 'voiceOff', 'rate', 'chatMuted', 'end']);
// The parts of a track a person can edit, and the global sections.
export const PART_KEYS = Object.freeze(['params', 'mods', 'seqOn', 'patterns', 'activePattern', 'chain', 'arp', 'dot', 'links', 'funcPoints', 'drum', 'userTerrain', 'trackFx', 'noiseRecording', 'smart', 'chord', 'ghost', 'name', 'color', 'patchName']);
export const GLOBAL_KEYS = Object.freeze(['global', 'tuning', 'operator']);
const KICK_REASONS = ['removed', 'banned', 'ended', 'full', 'locked', 'version'];
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const TRACK_ID = /^[\w-]{1,24}$/;
const PEER_ID = /^(h|p[1-5])$/;
const FINGERPRINT = /^[0-9A-F]{4}-[0-9A-F]{4}$/;
const JAM_ID = /^[a-z0-9]{6,16}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const bool = (v) => v === true || v === 1;
export const isPeerId = (v) => typeof v === 'string' && PEER_ID.test(v);
export const isTrackId = (v) => typeof v === 'string' && TRACK_ID.test(v);

// Control characters, and the direction overrides that can make text read differently than it is.
const UNSAFE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** A display name: plain text, one line, 1..NAME_MAX characters, or null. */
export function sanitizeName(v) {
  if (typeof v !== 'string') return null;
  const s = Array.from(v.replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim()).slice(0, NAME_MAX).join('').trim();
  return s || null;
}

/** Chat text: plain text, at most CHAT_MAX characters (longer is cut), or null when empty. */
export function sanitizeChat(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(UNSAFE_CHARS, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!s) return null;
  const chars = Array.from(s);
  return chars.length > CHAT_MAX ? chars.slice(0, CHAT_MAX).join('') : s;
}

/** A store sub-path inside a track or global section: up to 8 keys or indices, or null. */
export function sanitizePath(v) {
  if (!Array.isArray(v) || v.length > 8) return null;
  const out = [];
  for (const k of v) {
    if (typeof k === 'number' && Number.isInteger(k) && k >= 0 && k < 4096) out.push(k);
    else if (typeof k === 'string' && /^[\w-]{1,40}$/.test(k) && !BAD_KEYS.has(k)) out.push(/^\d+$/.test(k) ? Number(k) : k);
    else return null;
  }
  return out;
}

/** A JSON value with no forbidden keys, at most `depth` deep (or undefined when it is not one). */
export function plainValue(v, depth = 12) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (depth <= 0) return undefined;
  if (Array.isArray(v)) {
    const out = [];
    for (const x of v) { const c = plainValue(x, depth - 1); if (c === undefined) return undefined; out.push(c); }
    return out;
  }
  if (isObj(v)) {
    const out = {};
    for (const k of Object.keys(v)) {
      if (BAD_KEYS.has(k)) return undefined;
      const c = plainValue(v[k], depth - 1);
      if (c === undefined) return undefined;
      out[k] = c;
    }
    return out;
  }
  return undefined;
}

const time = (v) => (fin(v) && v >= 0 && v < 1e13 ? v : null);

function note(m) {
  if (!isTrackId(m.track)) return null;
  const n = Math.round(Number(m.n));
  if (!(n >= 0 && n <= 127) || !fin(m.v) || time(m.at) == null) return null;
  return { track: m.track, n, v: clamp(m.v, 0, 1), at: m.at };
}

function edit(m) {
  const scope = m.scope === 'global' ? 'global' : 'track';
  if (scope === 'track' && !isTrackId(m.track)) return null;
  if (scope === 'global' ? !GLOBAL_KEYS.includes(m.key) : !PART_KEYS.includes(m.key)) return null;
  const path = sanitizePath(m.path == null ? [] : m.path);
  if (!path) return null;
  const value = plainValue(m.value);
  if (value === undefined) return null;
  return scope === 'global' ? { scope, key: m.key, path, value } : { scope, track: m.track, key: m.key, path, value };
}

function peerEntry(p) {
  if (!isObj(p) || !isPeerId(p.id)) return null;
  const name = sanitizeName(p.name);
  if (!name) return null;
  return {
    id: p.id, name,
    role: ROLES.includes(p.role) ? p.role : 'member',
    voice: bool(p.voice), micMuted: bool(p.micMuted), chatMuted: bool(p.chatMuted), selfMuted: bool(p.selfMuted),
    rtt: fin(p.rtt) ? clamp(Math.round(p.rtt), 0, 60000) : null,
    fp: typeof p.fp === 'string' && FINGERPRINT.test(p.fp) ? p.fp : '',
  };
}

function owners(m) {
  const tracks = {};
  if (isObj(m.tracks)) {
    let n = 0;
    for (const k of Object.keys(m.tracks)) {
      if (n >= 64) break;
      if (isTrackId(k) && !BAD_KEYS.has(k) && isPeerId(m.tracks[k])) { tracks[k] = m.tracks[k]; n++; }
    }
  }
  return { tracks, global: isPeerId(m.global) ? m.global : HOST_ID };
}

function sys(m) {
  if (!SYS_KINDS.includes(m.kind)) return null;
  const out = { kind: m.kind, at: time(m.at) ?? 0 };
  if (isPeerId(m.who)) out.who = m.who;
  if (isPeerId(m.by)) out.by = m.by;
  const name = sanitizeName(m.name);
  if (name) out.name = name;
  if (isTrackId(m.track)) out.track = m.track;
  if (typeof m.fp === 'string' && FINGERPRINT.test(m.fp)) out.fp = m.fp;
  return out;
}

// Per type: [allowed direction, builder(m) -> fields or null]. 'up' = guest
// to host, 'down' = host to guest, 'both' = either way.
const TYPES = {
  hello: ['up', (m) => (m.v === PROTOCOL_VERSION && sanitizeName(m.name) ? { v: PROTOCOL_VERSION, name: sanitizeName(m.name) } : null)],
  ping: ['both', (m) => (fin(m.id) && time(m.t0) != null ? { id: Math.round(m.id), t0: m.t0 } : null)],
  pong: ['both', (m) => (fin(m.id) && time(m.t0) != null && time(m.t1) != null && time(m.t2) != null ? { id: Math.round(m.id), t0: m.t0, t1: m.t1, t2: m.t2 } : null)],
  chat: ['both', (m, dir) => {
    const text = sanitizeChat(m.text);
    if (!text) return null;
    if (dir === 'up') return { text };
    if (!isPeerId(m.from)) return null;
    return { from: m.from, text, at: time(m.at) ?? 0, id: fin(m.id) ? Math.round(m.id) : 0 };
  }],
  sys: ['down', sys],
  note: ['both', (m, dir) => { const n = note(m); if (!n) return null; if (dir === 'down') { if (!isPeerId(m.from)) return null; n.from = m.from; } return n; }],
  edit: ['both', (m, dir) => { const e = edit(m); if (!e) return null; if (dir === 'down') { if (!isPeerId(m.from)) return null; e.from = m.from; } return e; }],
  part: ['both', (m, dir) => {
    if (!isTrackId(m.track) || !isObj(m.data)) return null;
    const data = plainValue(m.data, 16);
    if (data === undefined) return null;
    const out = { track: m.track, data };
    if (dir === 'down') { if (!isPeerId(m.from)) return null; out.from = m.from; }
    return out;
  }],
  claim: ['up', (m) => (isTrackId(m.track) ? { track: m.track } : null)],
  release: ['up', (m) => (isTrackId(m.track) ? { track: m.track } : null)],
  play: ['up', (m) => ({ on: bool(m.on) })],
  voice: ['up', (m) => ({ on: bool(m.on), selfMuted: bool(m.selfMuted) })],
  mod: ['up', (m) => {
    if (!MOD_ACTIONS.includes(m.action)) return null;
    const out = { action: m.action };
    if (m.target != null) { if (!isPeerId(m.target)) return null; out.target = m.target; }
    if (m.track != null) { if (!isTrackId(m.track)) return null; out.track = m.track; }
    return out;
  }],
  resync: ['up', () => ({})],
  bye: ['both', () => ({})],
  welcome: ['down', (m) => {
    if (m.v !== PROTOCOL_VERSION || !isPeerId(m.you) || !JAM_ID.test(m.jam)) return null;
    return { v: PROTOCOL_VERSION, you: m.you, jam: m.jam, host: sanitizeName(m.host) || 'Host' };
  }],
  snap: ['down', (m) => (typeof m.data === 'string' && m.data.length <= MAX_SNAPSHOT_CHARS ? { data: m.data, first: bool(m.first) } : null)],
  roster: ['down', (m) => {
    if (!Array.isArray(m.peers) || m.peers.length > MAX_PEOPLE) return null;
    const peers = [];
    const seen = new Set();
    for (const p of m.peers) { const e = peerEntry(p); if (e && !seen.has(e.id)) { seen.add(e.id); peers.push(e); } }
    return { peers, locked: bool(m.locked) };
  }],
  owners: ['down', owners],
  transport: ['down', (m) => {
    const out = { playing: bool(m.playing) };
    if (out.playing) {
      if (!fin(m.beat) || time(m.at) == null) return null;
      out.beat = clamp(m.beat, -1e6, 1e9);
      out.at = m.at;
    }
    return out;
  }],
  voicemap: ['down', (m) => {
    const slots = {};
    if (isObj(m.slots)) {
      let n = 0;
      for (const k of Object.keys(m.slots)) {
        if (n >= 8) break;
        if (/^[\w-]{1,8}$/.test(k) && !BAD_KEYS.has(k) && (m.slots[k] === null || isPeerId(m.slots[k]))) { slots[k] = m.slots[k]; n++; }
      }
    }
    return { slots };
  }],
  clear: ['down', () => ({})],
  kicked: ['down', (m) => ({ reason: KICK_REASONS.includes(m.reason) ? m.reason : 'ended' })],
};

export const MESSAGE_TYPES = Object.freeze(Object.keys(TYPES));

/** The largest raw message (characters) allowed for a type in a direction. */
export function sizeLimit(type, dir) {
  if (type === 'snap') return dir === 'down' ? MAX_SNAPSHOT_CHARS + 1024 : 0;
  if (type === 'part' || type === 'edit') return MAX_PART_CHARS;
  return MAX_MESSAGE_CHARS;
}

/**
 * Check and rebuild one decoded message travelling in direction `dir`
 * ('up' or 'down'). Returns a fresh object { t, ...fields } or null.
 */
export function sanitizeMessage(m, dir) {
  if (!isObj(m) || typeof m.t !== 'string' || !Object.prototype.hasOwnProperty.call(TYPES, m.t)) return null;
  const [allowed, build] = TYPES[m.t];
  if (allowed !== 'both' && allowed !== dir) return null;
  let fields;
  try { fields = build(m, dir); } catch { fields = null; }
  return fields ? { t: m.t, ...fields } : null;
}

/**
 * Parse and check raw text from the network. `dir` is the direction it
 * travelled. Returns the message or null (too big, not JSON, failed checks).
 */
export function decodeMessage(raw, dir) {
  if (typeof raw !== 'string' || raw.length > MAX_SNAPSHOT_CHARS + 1024 || raw.length < 7) return null;
  // The type is near the start; read it cheaply to apply its size limit before parsing.
  const head = /^\{"t":"([a-z]{2,10})"/.exec(raw);
  if (!head || raw.length > sizeLimit(head[1], dir)) return null;
  let m;
  try { m = JSON.parse(raw); } catch { return null; }
  return sanitizeMessage(m, dir);
}

/** Encode a message for the network (`t` first, as decodeMessage expects). */
export function encodeMessage(m) {
  const { t, ...rest } = m;
  return JSON.stringify({ t, ...rest });
}

export const isFingerprint = (v) => typeof v === 'string' && FINGERPRINT.test(v);
