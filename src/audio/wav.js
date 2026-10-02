// RIFF/WAVE helpers.
//
// Writing: 24-bit integer PCM, built incrementally so a long recording never
// needs one giant Float32 copy: the recorder converts each incoming block to
// packed little-endian bytes straight away and the Blob is assembled from those
// pieces plus a 44-byte header at the end. The looper's export (v1.2) adds
// 24-bit with TPDF dither and 32-bit IEEE float (format tag 3), both at the
// context rate.
//
// Reading: a tolerant parser for the importer. decodeAudioData resamples to
// the context rate, which would break wavetable frame sizes (a 2048-sample
// frame recorded at 44.1 kHz turns into ~2229 samples at 48 kHz), so WAV files
// are read sample-exact here and decodeAudioData is only a fallback.

export const WAV_HEADER_BYTES = 44;
const INT24_MAX = 8388607;
const INT24_SCALE = 8388608;

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

/**
 * 44-byte canonical WAV header (format tag 1, integer PCM).
 * @returns {Uint8Array}
 */
export function wavHeader({ sampleRate, channels = 2, bitsPerSample = 24, frames, format = 1 }) {
  const sr = Math.round(sampleRate);
  const nch = Math.max(1, Math.round(channels));
  const blockAlign = nch * (bitsPerSample >> 3);
  const dataBytes = Math.max(0, Math.round(frames)) * blockAlign;
  const pad = dataBytes & 1;
  const buf = new ArrayBuffer(WAV_HEADER_BYTES);
  const v = new DataView(buf);
  writeAscii(v, 0, 'RIFF');
  v.setUint32(4, 36 + dataBytes + pad, true);
  writeAscii(v, 8, 'WAVE');
  writeAscii(v, 12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, format === 3 ? 3 : 1, true);
  v.setUint16(22, nch, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bitsPerSample, true);
  writeAscii(v, 36, 'data');
  v.setUint32(40, dataBytes, true);
  return new Uint8Array(buf);
}

/** Float sample -> signed 24-bit integer. NaN becomes 0, out-of-range clips. */
export function floatToInt24(x) {
  if (!(x === x)) return 0;
  if (x >= 1) return INT24_MAX;
  if (x <= -1) return -INT24_SCALE;
  const s = Math.round(x * INT24_SCALE);
  return s > INT24_MAX ? INT24_MAX : s;
}

/**
 * Interleave channels and pack as 24-bit little-endian PCM.
 * @param {Float32Array[]} channels one array per channel
 * @param {number} [frames] defaults to the first channel's length
 * @returns {Uint8Array}
 */
export function encodePCM24(channels, frames = channels[0] ? channels[0].length : 0) {
  const nch = channels.length;
  const out = new Uint8Array(frames * nch * 3);
  let o = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const ch = channels[c];
      const s = floatToInt24(i < ch.length ? ch[i] : 0);
      out[o] = s & 255;
      out[o + 1] = (s >> 8) & 255;
      out[o + 2] = (s >> 16) & 255;
      o += 3;
    }
  }
  return out;
}

/**
 * A complete 24-bit WAV file as a Blob from already-packed PCM pieces.
 * @param {Uint8Array[]} pieces output of encodePCM24, in order
 */
export function wavBlobFromPieces({ sampleRate, channels = 2, frames, pieces }) {
  const parts = [wavHeader({ sampleRate, channels, bitsPerSample: 24, frames }), ...pieces];
  if (((frames * channels * 3) & 1) === 1) parts.push(new Uint8Array(1));
  return new Blob(parts, { type: 'audio/wav' });
}

/** One-shot encoder: Float32 channels -> 24-bit WAV bytes. */
export function encodeWav24(channels, sampleRate) {
  const frames = channels[0] ? channels[0].length : 0;
  const head = wavHeader({ sampleRate, channels: channels.length, bitsPerSample: 24, frames });
  const body = encodePCM24(channels, frames);
  const pad = body.length & 1;
  const out = new Uint8Array(head.length + body.length + pad);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/**
 * Small deterministic noise source for dither (xorshift32), uniform in [0, 1).
 * Deterministic so exports are reproducible and testable.
 */
export function createDitherRng(seed = 0x9e3779b9) {
  let x = (seed >>> 0) || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

/**
 * Interleave and pack as 24-bit PCM with TPDF dither: two uniform noises of
 * one LSB each are added before rounding (triangular, +-1 LSB peak), which
 * turns the quantisation error into a constant, signal-independent noise floor
 * near -141 dBFS instead of distortion on quiet tails. Exact digital silence
 * stays exactly zero.
 */
export function encodePCM24Dither(channels, frames = channels[0] ? channels[0].length : 0, rng = createDitherRng()) {
  const nch = channels.length;
  const out = new Uint8Array(frames * nch * 3);
  let o = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const ch = channels[c];
      const x = i < ch.length ? ch[i] : 0;
      let s = 0;
      if (x === x && x !== 0) {
        const v = x * INT24_SCALE + (rng() - rng());
        s = Math.round(v);
        if (s > INT24_MAX) s = INT24_MAX; else if (s < -INT24_SCALE) s = -INT24_SCALE;
      }
      out[o] = s & 255;
      out[o + 1] = (s >> 8) & 255;
      out[o + 2] = (s >> 16) & 255;
      o += 3;
    }
  }
  return out;
}

/** Interleave as 32-bit little-endian IEEE float (no quantisation; NaN/Inf become 0). */
export function encodeFloat32(channels, frames = channels[0] ? channels[0].length : 0) {
  const nch = channels.length;
  const out = new Uint8Array(frames * nch * 4);
  const view = new DataView(out.buffer);
  let o = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const ch = channels[c];
      const x = i < ch.length ? ch[i] : 0;
      view.setFloat32(o, Number.isFinite(x) ? x : 0, true);
      o += 4;
    }
  }
  return out;
}

/**
 * One-shot WAV encoder for the looper export.
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {{format?: 'pcm24'|'float32', dither?: boolean, rng?: () => number}} [o]
 *   'pcm24' (default) is 24-bit with TPDF dither unless dither is false; 'float32' is IEEE float.
 * @returns {Uint8Array}
 */
export function encodeWav(channels, sampleRate, { format = 'pcm24', dither = true, rng } = {}) {
  const frames = channels[0] ? channels[0].length : 0;
  const isFloat = format === 'float32';
  const head = wavHeader({ sampleRate, channels: channels.length, bitsPerSample: isFloat ? 32 : 24, frames, format: isFloat ? 3 : 1 });
  const body = isFloat ? encodeFloat32(channels, frames) : dither ? encodePCM24Dither(channels, frames, rng) : encodePCM24(channels, frames);
  const pad = body.length & 1;
  const out = new Uint8Array(head.length + body.length + pad);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

// ---- reading -----------------------------------------------------------------

function ascii(bytes, off, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[off + i]);
  return s;
}

/**
 * Walk the RIFF chunk list. Tolerates a wrong RIFF size, odd-size padding and
 * a truncated last chunk (common in files written by streaming recorders).
 * @returns {{id: string, offset: number, size: number}[]} offset = start of chunk data
 */
export function riffChunks(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let p = 12;
  while (p + 8 <= bytes.length) {
    const id = ascii(bytes, p, 4);
    let size = view.getUint32(p + 4, true);
    const start = p + 8;
    if (size > bytes.length - start) size = bytes.length - start;
    chunks.push({ id, offset: start, size });
    p = start + size + (size & 1);
  }
  return chunks;
}

/** Frame size from a wavetable 'clm ' chunk ("<!>2048 ..."), or 0. */
export function clmFrameSize(text) {
  const m = /<!>\s*(\d{2,5})/.exec(String(text || ''));
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return n >= 16 && n <= 65536 ? n : 0;
}

/**
 * Parse a WAV header without decoding the samples.
 * Supports integer PCM 8/16/24/32-bit, IEEE float 32/64-bit and the
 * WAVE_FORMAT_EXTENSIBLE wrapper of either.
 * @returns {{sampleRate, channels: number, frames, bitsPerSample, float: boolean, clm: number,
 *   readMono(start: number, count: number, out?: Float32Array): Float32Array,
 *   readChannel(c: number, start: number, count: number, out?: Float32Array): Float32Array}}
 * @throws Error when the file is not a readable WAV
 */
export function wavInfo(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const chunks = riffChunks(bytes);
  if (!chunks) throw new Error('Not a WAV file (missing RIFF/WAVE header)');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fmt = chunks.find(c => c.id === 'fmt ');
  const data = chunks.find(c => c.id === 'data');
  if (!fmt || fmt.size < 16) throw new Error('This WAV file has no format chunk');
  if (!data) throw new Error('This WAV file has no audio data');
  let tag = view.getUint16(fmt.offset, true);
  const nch = view.getUint16(fmt.offset + 2, true);
  const sampleRate = view.getUint32(fmt.offset + 4, true);
  const blockAlign = view.getUint16(fmt.offset + 12, true);
  const bits = view.getUint16(fmt.offset + 14, true);
  if (tag === 0xfffe && fmt.size >= 26) tag = view.getUint16(fmt.offset + 24, true);
  const isFloat = tag === 3;
  if (!(tag === 1 || tag === 3)) throw new Error('Unsupported WAV encoding (compressed audio); save it as PCM or float WAV');
  if (nch < 1 || nch > 32 || !sampleRate) throw new Error('Invalid WAV format header');
  const bytesPer = bits >> 3;
  if (isFloat ? !(bits === 32 || bits === 64) : !(bits === 8 || bits === 16 || bits === 24 || bits === 32)) {
    throw new Error(`Unsupported WAV bit depth (${bits}-bit)`);
  }
  const stride = blockAlign >= nch * bytesPer ? blockAlign : nch * bytesPer;
  const frames = Math.floor(data.size / stride);
  const clmChunk = chunks.find(c => c.id === 'clm ');
  const clm = clmChunk ? clmFrameSize(ascii(bytes, clmChunk.offset, Math.min(clmChunk.size, 64))) : 0;

  const sampleAt = (q) => {
    let s;
    if (isFloat) s = bits === 32 ? view.getFloat32(q, true) : view.getFloat64(q, true);
    else if (bits === 16) s = view.getInt16(q, true) / 32768;
    else if (bits === 24) {
      let v = bytes[q] | (bytes[q + 1] << 8) | (bytes[q + 2] << 16);
      if (v & 0x800000) v |= ~0xffffff;
      s = v / INT24_SCALE;
    } else if (bits === 32) s = view.getInt32(q, true) / 2147483648;
    else s = (bytes[q] - 128) / 128;
    return Number.isFinite(s) ? s : 0;
  };
  const span = (start, count) => {
    const a = Math.max(0, Math.min(frames, Math.floor(start)));
    return [a, Math.max(0, Math.min(frames - a, Math.floor(count)))];
  };

  return {
    sampleRate, channels: nch, frames, bitsPerSample: bits, float: isFloat, clm,
    /** One channel, frames [start, start + count). */
    readChannel(c, start, count, out) {
      const [a, n] = span(start, count);
      const dst = out || new Float32Array(n);
      let p = data.offset + a * stride + c * bytesPer;
      for (let i = 0; i < n; i++, p += stride) dst[i] = sampleAt(p);
      return dst;
    },
    /** Average of all channels, frames [start, start + count). */
    readMono(start, count, out) {
      const [a, n] = span(start, count);
      const dst = out || new Float32Array(n);
      const g = 1 / nch;
      let p = data.offset + a * stride;
      for (let i = 0; i < n; i++, p += stride) {
        let sum = 0;
        for (let c = 0; c < nch; c++) sum += sampleAt(p + c * bytesPer);
        dst[i] = sum * g;
      }
      return dst;
    },
  };
}

/**
 * Decode a whole WAV file without resampling.
 * @returns {{sampleRate, channels: Float32Array[], frames, bitsPerSample, float: boolean, clm: number}}
 * @throws Error when the file is not a readable WAV
 */
export function decodeWav(buffer) {
  const info = wavInfo(buffer);
  const channels = [];
  for (let c = 0; c < info.channels; c++) channels.push(info.readChannel(c, 0, info.frames));
  return { sampleRate: info.sampleRate, channels, frames: info.frames, bitsPerSample: info.bitsPerSample, float: info.float, clm: info.clm };
}
