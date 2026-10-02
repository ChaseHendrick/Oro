import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import {
  decodePng, decodePngRows, readPngChunks, unfilterRow, pngLayout, isPng, crc32, MAX_PNG_PIXELS,
} from '../../src/audio/png.js';
import { encodePng, pngChunk } from './png-encode.js';

const rand = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const CH = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const COMBOS = [[0, 1], [0, 2], [0, 4], [0, 8], [0, 16], [2, 8], [2, 16], [3, 1], [3, 2], [3, 4], [3, 8], [4, 8], [4, 16], [6, 8], [6, 16]];

function randomImage(colorType, bitDepth, width, height, seed) {
  const r = rand(seed);
  const max = colorType === 3 ? Math.min(255, (1 << bitDepth) - 1) : (1 << bitDepth) - 1;
  const n = width * height * CH[colorType];
  return Array.from({ length: n }, () => Math.floor(r() * (max + 1)));
}

function palette(entries) {
  const p = new Uint8Array(entries * 3);
  for (let i = 0; i < entries; i++) { p[3 * i] = (i * 37) & 255; p[3 * i + 1] = (i * 91) & 255; p[3 * i + 2] = (i * 13) & 255; }
  return p;
}

describe('PNG chunks', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082);
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('recognises the signature and reads the header', () => {
    const png = encodePng({ width: 3, height: 2, colorType: 0, bitDepth: 16, samples: [0, 1, 2, 3, 4, 65535] });
    expect(isPng(png)).toBe(true);
    expect(isPng(new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0]))).toBe(false);
    const info = readPngChunks(png);
    expect(info.header).toMatchObject({ width: 3, height: 2, bitDepth: 16, colorType: 0, interlace: 0, channels: 1 });
    expect(info.idat.length).toBe(1);
  });

  it('lays out Adam7 passes, skipping empty ones', () => {
    const l1 = pngLayout({ width: 1, height: 1, bitDepth: 8, channels: 1, interlace: 1 });
    expect(l1.passes.length).toBe(1);
    const l = pngLayout({ width: 8, height: 8, bitDepth: 8, channels: 3, interlace: 1 });
    expect(l.passes.map(p => p.w * p.h)).toEqual([1, 1, 2, 4, 8, 16, 32]);
    expect(l.bpp).toBe(3);
    expect(pngLayout({ width: 9, height: 1, bitDepth: 2, channels: 1, interlace: 0 }).passes[0].rowBytes).toBe(3);
  });
});

describe('PNG scanline filters', () => {
  it('undoes Sub, Up, Average and Paeth (with wrap-around arithmetic)', () => {
    const prev = Uint8Array.from([10, 200, 30, 250]);
    const enc = (type, raw) => {
      const out = new Uint8Array(raw.length);
      const pa = (a, b, c) => { const p = a + b - c; const x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c); return x <= y && x <= z ? a : y <= z ? b : c; };
      for (let i = 0; i < raw.length; i++) {
        const a = i >= 2 ? raw[i - 2] : 0, b = prev[i], c = i >= 2 ? prev[i - 2] : 0;
        out[i] = (raw[i] - [0, a, b, (a + b) >> 1, pa(a, b, c)][type]) & 255;
      }
      return out;
    };
    const raw = Uint8Array.from([255, 0, 128, 7]);
    for (let type = 0; type <= 4; type++) {
      const row = enc(type, raw);
      unfilterRow(type, row, prev, 2);
      expect([...row]).toEqual([...raw]);
    }
    expect(() => unfilterRow(5, new Uint8Array(2), new Uint8Array(2), 1)).toThrow(/filter/);
  });
});

describe('PNG decoding', { timeout: 60000 }, () => {
  it('decodes every colour type and bit depth exactly, plain and interlaced, every filter', async () => {
    let seed = 1;
    for (const [colorType, bitDepth] of COMBOS) {
      for (const [width, height] of [[13, 7], [1, 1], [3, 9], [16, 16]]) {
        for (const interlace of [false, true]) {
          for (const filter of ['cycle', 0, 1, 2, 3, 4]) {
            if (filter !== 'cycle' && (width !== 13 || interlace)) continue;
            const samples = randomImage(colorType, bitDepth, width, height, seed++);
            const pal = colorType === 3 ? palette(1 << bitDepth) : undefined;
            const png = encodePng({ width, height, colorType, bitDepth, samples, filter, interlace, palette: pal });
            const d = await decodePng(png);
            const label = `ct${colorType} d${bitDepth} ${width}x${height} il${+interlace} f${filter}`;
            expect(d.width, label).toBe(width);
            if (colorType === 3) {
              const want = samples.flatMap(i => [pal[3 * i], pal[3 * i + 1], pal[3 * i + 2]]);
              expect([...d.data], label).toEqual(want);
            } else {
              expect([...d.data], label).toEqual(samples);
            }
          }
        }
      }
    }
  });

  it('keeps all 16 bits of a grey DEM', async () => {
    const W = 64, H = 64;
    const samples = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) samples.push(30000 + x * 3 + y);   // a narrow band of levels
    const d = await decodePng(encodePng({ width: W, height: H, colorType: 0, bitDepth: 16, samples }));
    expect(new Set(d.data).size).toBe(new Set(samples).size);
    expect(d.data[W * H - 1]).toBe(30000 + 63 * 3 + 63);
  });

  it('expands palette transparency to RGBA', async () => {
    const pal = palette(4);
    const png = encodePng({ width: 2, height: 2, colorType: 3, bitDepth: 2, samples: [0, 1, 2, 3], palette: pal, trns: Uint8Array.from([0, 128]) });
    const d = await decodePng(png);
    expect(d.channels).toBe(4);
    expect([d.data[3], d.data[7], d.data[11], d.data[15]]).toEqual([0, 128, 255, 255]);
  });

  it('streams rows: a zlib stream split over many IDAT chunks decodes the same', async () => {
    const samples = randomImage(2, 16, 40, 30, 99);
    const a = await decodePng(encodePng({ width: 40, height: 30, colorType: 2, bitDepth: 16, samples, idatSplit: 1 }));
    const b = await decodePng(encodePng({ width: 40, height: 30, colorType: 2, bitDepth: 16, samples, idatSplit: 17 }));
    expect([...b.data]).toEqual([...a.data]);
    let rows = 0;
    await decodePngRows(encodePng({ width: 40, height: 30, colorType: 2, bitDepth: 16, samples, interlace: true }), () => { rows++; });
    expect(rows).toBe(4 + 4 + 4 + 8 + 7 + 15 + 15);   // rows per Adam7 pass for 30 lines
  });

  it('skips unknown ancillary chunks but refuses unknown critical ones', async () => {
    const samples = [1, 2, 3, 4];
    const ok = encodePng({ width: 2, height: 2, colorType: 0, bitDepth: 8, samples, extra: [pngChunk('tEXt', new TextEncoder().encode('Comment\0hi')), pngChunk('gAMA', Uint8Array.from([0, 0, 177, 143]))] });
    expect([...(await decodePng(ok)).data]).toEqual(samples);
    const bad = encodePng({ width: 2, height: 2, colorType: 0, bitDepth: 8, samples, extra: [pngChunk('XYZW', new Uint8Array(1))] });
    await expect(decodePng(bad)).rejects.toThrow(/cannot read/);
  });

  it('accepts junk after a complete zlib stream, as browsers do', async () => {
    const samples = [10, 20, 30, 40, 50, 60];
    const png = encodePng({ width: 3, height: 2, colorType: 0, bitDepth: 8, samples });
    const info = readPngChunks(png);
    const junk = new Uint8Array(info.idat[0].length + 5);
    junk.set(info.idat[0]);
    junk.set([1, 2, 3, 4, 5], info.idat[0].length);
    const rows = [];
    await decodePngRows(png, ({ row }) => rows.push(...row), { info: { ...info, idat: [junk] } });
    expect(rows).toEqual(samples);
  });

  it('turns damaged and hostile files into clear errors', async () => {
    const good = encodePng({ width: 8, height: 8, colorType: 0, bitDepth: 8, samples: new Array(64).fill(7) });
    // truncated in the middle of the image data
    await expect(decodePng(good.subarray(0, good.length - 20))).rejects.toThrow(/cut short|damaged/);
    // corrupt deflate stream (Adler-32 / structure)
    const broken = Uint8Array.from(good);
    const idatAt = broken.findIndex((_, i) => broken[i] === 73 && broken[i + 1] === 68 && broken[i + 2] === 65 && broken[i + 3] === 84);
    for (let i = idatAt + 6; i < idatAt + 12; i++) broken[i] ^= 0x5a;
    await expect(decodePng(broken)).rejects.toThrow(/damaged|cut short/);
    // a zlib stream that ends early (fewer rows than the header promises)
    const short = encodePng({ width: 8, height: 8, colorType: 0, bitDepth: 8, samples: new Array(64).fill(7) });
    const info = readPngChunks(short);
    const z = deflateSync(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]));
    await expect(decodePngRows(short, () => {}, { info: { ...info, idat: [z] } })).rejects.toThrow(/cut short/);
    // not a PNG / wrong header / absurd size
    await expect(decodePng(new Uint8Array(20))).rejects.toThrow(/not a PNG/);
    const hdr = Uint8Array.from(good);
    hdr[24] = 16; hdr[25] = 3;  // palette images cannot be 16-bit
    await expect(decodePng(hdr)).rejects.toThrow(/bit depth/);
    const huge = Uint8Array.from(good);
    new DataView(huge.buffer).setUint32(16, 100000); new DataView(huge.buffer).setUint32(20, 100000);
    await expect(decodePng(huge)).rejects.toThrow(/megapixels/);
    const thin = Uint8Array.from(good);
    new DataView(thin.buffer).setUint32(16, 1000000); new DataView(thin.buffer).setUint32(20, 1);
    await expect(decodePng(thin)).rejects.toThrow(/megapixels/);
    expect(MAX_PNG_PIXELS).toBeGreaterThan(60e6);
    // palette image without a palette
    const noPal = encodePng({ width: 2, height: 2, colorType: 3, bitDepth: 8, samples: [0, 0, 0, 0] });
    await expect(decodePng(noPal)).rejects.toThrow(/palette/);
  });
});
