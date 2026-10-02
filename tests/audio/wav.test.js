import { describe, it, expect } from 'vitest';
import {
  wavHeader, floatToInt24, encodePCM24, encodeWav24, wavBlobFromPieces, decodeWav, riffChunks, clmFrameSize, WAV_HEADER_BYTES, wavInfo,
} from '../../src/audio/wav.js';

const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

function readInt24(b, o) {
  let v = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
  if (v & 0x800000) v |= ~0xffffff;
  return v;
}

/** Build a WAV file with arbitrary format and extra chunks (for the reader tests). */
function makeWav({ sampleRate = 44100, channels = 1, bits = 16, tag = 1, samples, extra = [] }) {
  const bytesPer = bits >> 3;
  const frames = samples[0].length;
  const dataSize = frames * channels * bytesPer;
  const chunks = [];
  const fmt = new DataView(new ArrayBuffer(16));
  fmt.setUint16(0, tag, true); fmt.setUint16(2, channels, true); fmt.setUint32(4, sampleRate, true);
  fmt.setUint32(8, sampleRate * channels * bytesPer, true); fmt.setUint16(12, channels * bytesPer, true); fmt.setUint16(14, bits, true);
  chunks.push(['fmt ', new Uint8Array(fmt.buffer)]);
  for (const e of extra) chunks.push(e);
  const data = new DataView(new ArrayBuffer(dataSize));
  let p = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const x = samples[c][i];
      if (tag === 3) data.setFloat32(p, x, true);
      else if (bits === 16) data.setInt16(p, Math.max(-32768, Math.min(32767, Math.round(x * 32768))), true);
      else if (bits === 8) data.setUint8(p, Math.round(x * 128 + 128));
      p += bytesPer;
    }
  }
  chunks.push(['data', new Uint8Array(data.buffer)]);
  let total = 12;
  for (const [, b] of chunks) total += 8 + b.length + (b.length & 1);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  const put = (o, s) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  put(0, 'RIFF'); v.setUint32(4, total - 8, true); put(8, 'WAVE');
  let o = 12;
  for (const [id, b] of chunks) {
    put(o, id); v.setUint32(o + 4, b.length, true); out.set(b, o + 8);
    o += 8 + b.length + (b.length & 1);
  }
  return out;
}

describe('wav writer', () => {
  it('writes a canonical 44-byte 24-bit stereo header', () => {
    const h = wavHeader({ sampleRate: 48000, channels: 2, bitsPerSample: 24, frames: 1000 });
    const v = new DataView(h.buffer);
    expect(h.length).toBe(WAV_HEADER_BYTES);
    expect(ascii(h, 0, 4)).toBe('RIFF');
    expect(ascii(h, 8, 4)).toBe('WAVE');
    expect(ascii(h, 12, 4)).toBe('fmt ');
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1);           // integer PCM
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint32(28, true)).toBe(48000 * 6);   // byte rate
    expect(v.getUint16(32, true)).toBe(6);           // block align
    expect(v.getUint16(34, true)).toBe(24);
    expect(ascii(h, 36, 4)).toBe('data');
    expect(v.getUint32(40, true)).toBe(6000);
    expect(v.getUint32(4, true)).toBe(36 + 6000);
  });

  it('converts and clips samples to 24-bit', () => {
    expect(floatToInt24(0)).toBe(0);
    expect(floatToInt24(0.5)).toBe(4194304);
    expect(floatToInt24(-0.5)).toBe(-4194304);
    expect(floatToInt24(1)).toBe(8388607);
    expect(floatToInt24(0.99999999)).toBe(8388607);
    expect(floatToInt24(-1)).toBe(-8388608);
    expect(floatToInt24(3.2)).toBe(8388607);
    expect(floatToInt24(-7)).toBe(-8388608);
    expect(floatToInt24(NaN)).toBe(0);
    expect(floatToInt24(Infinity)).toBe(8388607);
    expect(floatToInt24(1 / 8388608)).toBe(1);
  });

  it('interleaves little-endian 24-bit frames', () => {
    const L = new Float32Array([0.5, -1, 0]);
    const R = new Float32Array([-0.5, 2, 1 / 8388608]);
    const b = encodePCM24([L, R]);
    expect(b.length).toBe(3 * 2 * 3);
    expect(readInt24(b, 0)).toBe(4194304);
    expect(readInt24(b, 3)).toBe(-4194304);
    expect(readInt24(b, 6)).toBe(-8388608);
    expect(readInt24(b, 9)).toBe(8388607);
    expect(readInt24(b, 12)).toBe(0);
    expect(readInt24(b, 15)).toBe(1);
    expect([b[0], b[1], b[2]]).toEqual([0x00, 0x00, 0x40]);
  });

  it('has the right total length and round-trips through the reader', () => {
    const n = 1234;
    const L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = Math.sin(i * 0.05) * 0.9; R[i] = Math.cos(i * 0.031) * 0.7; }
    const bytes = encodeWav24([L, R], 44100);
    expect(bytes.length).toBe(44 + n * 6);
    const d = decodeWav(bytes);
    expect(d.sampleRate).toBe(44100);
    expect(d.frames).toBe(n);
    expect(d.channels.length).toBe(2);
    expect(d.bitsPerSample).toBe(24);
    let maxErr = 0;
    for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(d.channels[0][i] - L[i]), Math.abs(d.channels[1][i] - R[i]));
    expect(maxErr).toBeLessThan(1 / 8388608 + 1e-9);
  });

  it('builds the same file from pieces as in one go', async () => {
    const n = 5000;
    const L = new Float32Array(n).map((_, i) => Math.sin(i / 7));
    const R = new Float32Array(n).map((_, i) => Math.sin(i / 11));
    const pieces = [];
    for (let o = 0; o < n; o += 1024) pieces.push(encodePCM24([L.subarray(o, o + 1024), R.subarray(o, o + 1024)]));
    const blob = wavBlobFromPieces({ sampleRate: 48000, channels: 2, frames: n, pieces });
    expect(blob.type).toBe('audio/wav');
    const a = new Uint8Array(await blob.arrayBuffer());
    const b = encodeWav24([L, R], 48000);
    expect(a.length).toBe(b.length);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
  });

  it('pads odd-sized mono 24-bit data', () => {
    const bytes = encodeWav24([new Float32Array(3)], 8000);
    expect(bytes.length).toBe(44 + 9 + 1);
    expect(new DataView(bytes.buffer).getUint32(40, true)).toBe(9);
    expect(new DataView(bytes.buffer).getUint32(4, true)).toBe(36 + 10);
  });
});

describe('wav reader', () => {
  it('reads 16-bit, 8-bit and float files sample-exact (no resampling)', () => {
    const s = new Float32Array(2048).map((_, i) => Math.sin(2 * Math.PI * i / 2048) * 0.5);
    for (const [bits, tag, tol] of [[16, 1, 1 / 32768], [8, 1, 1 / 128], [32, 3, 1e-7]]) {
      const d = decodeWav(makeWav({ sampleRate: 44100, bits, tag, samples: [s] }));
      expect(d.frames).toBe(2048);
      expect(d.sampleRate).toBe(44100);
      let e = 0;
      for (let i = 0; i < 2048; i++) e = Math.max(e, Math.abs(d.channels[0][i] - s[i]));
      expect(e).toBeLessThanOrEqual(tol + 1e-9);
    }
  });

  it('skips unknown chunks with odd sizes and reads the clm frame size', () => {
    const clm = new TextEncoder().encode('<!>2048 10000000 wavetable (orograph test)');
    const junk = new Uint8Array(7).fill(1);
    const s = new Float32Array(4096).fill(0.25);
    const bytes = makeWav({ samples: [s], extra: [['junk', junk], ['clm ', clm]] });
    const chunks = riffChunks(bytes).map(c => c.id);
    expect(chunks).toEqual(['fmt ', 'junk', 'clm ', 'data']);
    const d = decodeWav(bytes);
    expect(d.clm).toBe(2048);
    expect(d.frames).toBe(4096);
  });

  it('reads frame ranges and a mono mix without decoding the whole file', () => {
    const n = 1000;
    const L = new Float32Array(n).map((_, i) => i / n), R = new Float32Array(n).map((_, i) => -i / n + 0.5);
    const info = wavInfo(encodeWav24([L, R], 22050));
    expect(info).toMatchObject({ sampleRate: 22050, channels: 2, frames: n, bitsPerSample: 24 });
    const m = info.readMono(100, 10);
    expect(m.length).toBe(10);
    for (let i = 0; i < 10; i++) expect(m[i]).toBeCloseTo(0.25, 6);
    const r = info.readChannel(1, 995, 50);              // clipped to the end of the data
    expect(r.length).toBe(5);
    expect(r[0]).toBeCloseTo(-0.495, 6);
  });

  it('parses clm text defensively', () => {
    expect(clmFrameSize('<!>2048 01000000 wavetable')).toBe(2048);
    expect(clmFrameSize('<!>  256 x')).toBe(256);
    expect(clmFrameSize('nothing here')).toBe(0);
    expect(clmFrameSize('<!>3 tiny')).toBe(0);
  });

  it('rejects non-WAV and compressed WAV with readable errors', () => {
    expect(() => decodeWav(new Uint8Array(100))).toThrow(/Not a WAV/);
    const s = [new Float32Array(16)];
    const adpcm = makeWav({ samples: s, bits: 16, tag: 2 });
    expect(() => decodeWav(adpcm)).toThrow(/compressed/);
  });
});
