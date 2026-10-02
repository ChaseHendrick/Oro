// Test files for the audio harness, built in the browser: PNGs of any depth
// (CompressionStream + our CRC), and deliberately odd or broken files.

import { crc32 } from '../../src/audio/png.js';
import { encodeWav24 } from '../../src/audio/wav.js';

const CH = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

async function deflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** PNG from integer samples (row-major, channels interleaved), Up filter on every row. */
export async function makePng({ width, height, colorType = 0, bitDepth = 16, sample, name = 'map.png' }) {
  const ch = CH[colorType];
  const bpr = Math.ceil(width * ch * bitDepth / 8);
  const raw = new Uint8Array((bpr + 1) * height);
  let prev = new Uint8Array(bpr);
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(bpr);
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < ch; c++) {
        const v = sample(x, y, c);
        if (bitDepth === 16) { row[2 * (x * ch + c)] = v >> 8; row[2 * (x * ch + c) + 1] = v & 255; } else row[x * ch + c] = v;
      }
    }
    raw[y * (bpr + 1)] = 2;   // Up
    for (let i = 0; i < bpr; i++) raw[y * (bpr + 1) + 1 + i] = (row[i] - prev[i]) & 255;
    prev = row;
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = bitDepth; ihdr[9] = colorType;
  const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array(0))];
  return new File(parts, name, { type: 'image/png' });
}

/** A minimal RIFF/WAVE with arbitrary fmt fields and data bytes. */
export function makeRawWav({ format = 1, channels = 1, sampleRate = 44100, bits = 16, data = new Uint8Array(0), extraChunks = [], extensible = false, name = 'odd.wav' }) {
  const fmtLen = extensible ? 40 : 16;
  const fmt = new DataView(new ArrayBuffer(fmtLen));
  fmt.setUint16(0, extensible ? 0xfffe : format, true);
  fmt.setUint16(2, channels, true);
  fmt.setUint32(4, sampleRate, true);
  fmt.setUint32(8, sampleRate * channels * bits / 8, true);
  fmt.setUint16(12, channels * bits / 8, true);
  fmt.setUint16(14, bits, true);
  if (extensible) { fmt.setUint16(16, 22, true); fmt.setUint16(18, bits, true); fmt.setUint16(24, format, true); }
  const ck = (id, bytes) => {
    const h = new DataView(new ArrayBuffer(8));
    for (let i = 0; i < 4; i++) h.setUint8(i, id.charCodeAt(i));
    h.setUint32(4, bytes.length, true);
    return bytes.length & 1 ? [new Uint8Array(h.buffer), bytes, new Uint8Array(1)] : [new Uint8Array(h.buffer), bytes];
  };
  const body = [...ck('fmt ', new Uint8Array(fmt.buffer)), ...extraChunks.flatMap(([id, b]) => ck(id, b)), ...ck('data', data)];
  const size = 4 + body.reduce((n, b) => n + b.length, 0);
  const head = new DataView(new ArrayBuffer(12));
  [82, 73, 70, 70].forEach((c, i) => head.setUint8(i, c));
  head.setUint32(4, size, true);
  [87, 65, 86, 69].forEach((c, i) => head.setUint8(8 + i, c));
  return new File([new Uint8Array(head.buffer), ...body], name, { type: 'audio/wav' });
}

/** One cycle of a saw per 2048 samples, `frames` cycles, as 8-bit unsigned / float64 / 24-bit extensible WAVs. */
export function oddWavs() {
  const n = 2048 * 4;
  const saw = Array.from({ length: n }, (_, i) => 2 * ((i % 2048) / 2048) - 1);
  const u8 = Uint8Array.from(saw, v => Math.round(128 + v * 127));
  const f64 = new Float64Array(saw);
  const s24 = encodeWav24([Float32Array.from(saw)], 48000).subarray(44);
  return {
    u8: makeRawWav({ bits: 8, data: u8, name: 'u8.wav', extraChunks: [['LIST', new Uint8Array(5)]] }),
    f64: makeRawWav({ format: 3, bits: 64, data: new Uint8Array(f64.buffer), name: 'f64.wav' }),
    ext24: makeRawWav({ bits: 24, data: s24, extensible: true, name: 'ext24.wav', sampleRate: 48000 }),
    empty: makeRawWav({ bits: 16, data: new Uint8Array(0), name: 'nodata.wav' }),
    alaw: makeRawWav({ format: 6, bits: 8, data: new Uint8Array(100), name: 'alaw.wav' }),
  };
}
