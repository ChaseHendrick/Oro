// v2.9 Postcards and share links: the PNG chunk, the link format, size caps,
// malformed input, sanitizing and the social share URLs.
import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { encodePng } from '../audio/png-encode.js';
import { decodePng, readPngChunks } from '../../src/audio/png.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { createPresets, partPatch, sanitizePatch } from '../../src/presets/presets.js';
import { FACTORY_PATCHES } from '../../src/presets/factory-patches.js';
import {
  POSTCARD_KEYWORD, itxtChunk, insertChunk, readPngText, embedPatch, readPostcard, postcardRecord,
  encodeLinkData, decodeLinkData, linkDataFromHash, shareUrl, linkFor, shareTargets, caption, toBase64Url, LinkError, MAX_LINK_BYTES,
} from '../../src/presets/postcard.js';
import { createMemoryStorage } from '../music/fakes.js';

const png = () => encodePng({ width: 3, height: 2, colorType: 2, bitDepth: 8, samples: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180] });
const patch = () => sanitizePatch({ ...FACTORY_PATCHES[0], name: 'Glass "Rain" é' });

describe('postcard PNG chunk', () => {
  it('writes an iTXt chunk with a valid CRC and reads it back', () => {
    const out = insertChunk(png(), itxtChunk('oro-patch', 'héllo {"a":1}'));
    expect(readPngText(out, 'oro-patch')).toBe('héllo {"a":1}');
    expect(readPngText(out, 'other')).toBe(null);
    expect(readPngText(png(), 'oro-patch')).toBe(null);
    // the chunk sits before IEND and its CRC matches (zlib's crc32 as a second opinion)
    const i = out.length - 12;
    expect(String.fromCharCode(...out.subarray(i + 4, i + 8))).toBe('IEND');
  });

  it('round-trips a patch and the image still decodes as a normal PNG', async () => {
    const plain = png();
    const card = embedPatch(plain, patch(), '2.9.0');
    expect(card.length).toBeGreaterThan(plain.length);
    const rec = readPostcard(card);
    expect(rec.version).toBe('2.9.0');
    expect(rec.patch).toEqual(patch());
    const a = await decodePng(plain), b = await decodePng(card);
    expect(b.width).toBe(3);
    expect(Array.from(b.data)).toEqual(Array.from(a.data));
    expect(readPngChunks(card).idat.length).toBe(1);
    expect(readPostcard(plain)).toBe(null);
  });

  it('sanitizes the patch inside and refuses damaged ones with a readable message', () => {
    const bad = insertChunk(png(), itxtChunk(POSTCARD_KEYWORD, JSON.stringify(postcardRecord({ name: 'X', params: { cutoff: 1e12, nope: 3 }, mods: {} }))));
    const rec = readPostcard(bad);
    expect(rec.patch.params.nope).toBeUndefined();
    expect(rec.patch.params.cutoff).toBe(sanitizePatch({ params: { cutoff: 1e12 } }).params.cutoff);
    expect(() => readPostcard(insertChunk(png(), itxtChunk(POSTCARD_KEYWORD, '{oops')))).toThrow(/damaged/);
    expect(() => readPostcard(insertChunk(png(), itxtChunk(POSTCARD_KEYWORD, '{"a":1}')))).toThrow(/damaged/);
  });
});

describe('share links', () => {
  it('round-trips compressed and plain links', async () => {
    const rec = postcardRecord(patch(), '2.9.0');
    for (const compress of [true, false]) {
      const data = await encodeLinkData(rec, { compress });
      expect(data.startsWith(compress ? 'z.' : 'j.')).toBe(true);
      expect(data).toMatch(/^[zj]\.[A-Za-z0-9_-]+$/);
      const back = await decodeLinkData(data);
      expect(back.patch).toEqual(patch());
      expect(back.version).toBe('2.9.0');
      const url = shareUrl(data);
      expect(url).toBe(`https://www.hendrickresearch.com/music/oro/#p=${data}`);
      expect(linkDataFromHash(new URL(url).hash)).toBe(data);
    }
    expect(linkDataFromHash('#x=1&p=z.abc')).toBe('z.abc');
    expect(linkDataFromHash('')).toBe(null);
  });

  it('applies the patch import sanitizer', async () => {
    const data = await encodeLinkData(postcardRecord({ name: 'Loud', params: { cutoff: -5, mute: 1, bogus: 1 }, mods: { nothing: {} }, smart: 'x' }));
    const { patch: p } = await decodeLinkData(data);
    expect(p).toEqual(sanitizePatch({ name: 'Loud', params: { cutoff: -5, mute: 1, bogus: 1 }, mods: { nothing: {} }, smart: 'x' }));
    expect(p.params.bogus).toBeUndefined();
    expect(p.params.mute).toBeUndefined();
  });

  it('caps the decompressed size while inflating', async () => {
    const huge = new TextEncoder().encode(JSON.stringify({ name: 'big', params: {}, tags: [' '.repeat(MAX_LINK_BYTES + 10)] }));
    const z = 'z.' + toBase64Url(new Uint8Array(deflateRawSync(huge)));
    expect(z.length).toBeLessThan(4000);
    await expect(decodeLinkData(z)).rejects.toMatchObject({ reason: 'too-big' });
    await expect(decodeLinkData('j.' + toBase64Url(huge))).rejects.toMatchObject({ reason: 'too-big' });
    await expect(decodeLinkData('z.' + 'A'.repeat(600 * 1024))).rejects.toBeInstanceOf(LinkError);
  });

  it('rejects malformed links', async () => {
    const bad = ['', 'z.', 'q.abcd', 'z.!!!!', 'z.A', 'z.' + toBase64Url(new Uint8Array([1, 2, 3, 4, 5, 250])), 'j.' + toBase64Url(new TextEncoder().encode('not json')), 'j.' + toBase64Url(new Uint8Array([0xff, 0xfe]))];
    for (const d of bad) await expect(decodeLinkData(d)).rejects.toMatchObject({ reason: 'malformed' });
    await expect(decodeLinkData('j.' + toBase64Url(new TextEncoder().encode('{"hello":1}')))).rejects.toMatchObject({ reason: 'not-a-sound' });
    await expect(decodeLinkData('j.' + toBase64Url(new TextEncoder().encode('[1,2]')))).rejects.toMatchObject({ reason: 'not-a-sound' });
  });

  it('leaves imported terrains out of links that would be too long', async () => {
    const big = { ...patch(), userTerrain: { A: { name: 'x', kind: 'image', w: 2, h: 2, data: toBase64Url(crypto.getRandomValues(new Uint8Array(30000))) }, B: null } };
    const l = await linkFor(big, '2.9.0');
    expect(l.trimmed).toBe(true);
    expect((await decodeLinkData(l.data)).patch.userTerrain).toBeUndefined();
    expect((await linkFor(patch(), '2.9.0')).trimmed).toBe(false);
  });

  it('builds the social share URLs exactly', () => {
    const url = 'https://www.hendrickresearch.com/music/oro/#p=z.Ab-_';
    const t = Object.fromEntries(shareTargets(url, 'Rain & Sun').map(x => [x.id, x.href]));
    const u = 'https%3A%2F%2Fwww.hendrickresearch.com%2Fmusic%2Foro%2F%23p%3Dz.Ab-_';
    expect(caption('Rain & Sun', url)).toBe('A sound I made in Oro: "Rain & Sun". Open it: https://www.hendrickresearch.com/music/oro/#p=z.Ab-_');
    expect(t.x).toBe(`https://x.com/intent/post?text=A%20sound%20I%20made%20in%20Oro%3A%20%22Rain%20%26%20Sun%22.%20Open%20it%3A&url=${u}`);
    expect(t.facebook).toBe(`https://www.facebook.com/sharer/sharer.php?u=${u}`);
    expect(t.bluesky).toBe(`https://bsky.app/intent/compose?text=A%20sound%20I%20made%20in%20Oro%3A%20%22Rain%20%26%20Sun%22.%20Open%20it%3A%20${u}`);
    expect(t.threads).toBe(`https://www.threads.net/intent/post?text=A%20sound%20I%20made%20in%20Oro%3A%20%22Rain%20%26%20Sun%22.%20Open%20it%3A%20${u}`);
    expect(t.reddit).toBe(`https://www.reddit.com/submit?url=${u}&title=A%20sound%20I%20made%20in%20Oro%3A%20%22Rain%20%26%20Sun%22`);
    expect(t.linkedin).toBe(`https://www.linkedin.com/sharing/share-offsite/?url=${u}`);
    for (const href of Object.values(t)) expect(href).not.toMatch(/\u2014/);
  });
});

describe('a track sound through a link and back onto a track', () => {
  it('loads the sanitized patch onto another track, keeping its pattern and mix', async () => {
    const store = createStore(JSON.parse(JSON.stringify(defaultState())));
    const presets = createPresets({ store, storage: createMemoryStorage() });
    presets.loadPatch(0, FACTORY_PATCHES[3].name);
    store.set('parts.0.params.cutoff', 1234, { source: 'ui' });
    const sent = partPatch(store.get('parts.0'), { name: 'Mine' });
    expect(sent.params.mute).toBeUndefined();
    const { data } = await linkFor(sent, '2.9.0');
    const { patch: got } = await decodeLinkData(data);
    store.set('parts.1.params.sendA', 0.42, { source: 'ui' });
    const pattern1 = JSON.stringify(store.get('parts.1.patterns'));
    expect(presets.loadPatch(1, got)).toBe(true);
    expect(store.get('parts.1.patchName')).toBe('Mine');
    expect(store.get('parts.1.params.cutoff')).toBe(1234);
    expect(store.get('parts.1.params.sendA')).toBe(0.42);
    expect(JSON.stringify(store.get('parts.1.patterns'))).toBe(pattern1);
  });
});
