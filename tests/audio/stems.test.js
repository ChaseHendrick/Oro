import { describe, it, expect } from 'vitest';
import { createZipWriter, readZip, crc32Update, dosDateTime } from '../../src/audio/zip.js';
import { crc32 } from '../../src/audio/png.js';
import {
  stemOptions, songBars, sanitizeFileName, stemFileName, uniqueNames, estimateBytes, planStems, encodeStemWav,
  autoTailFrames, exportStems, exportSize, keyName, SIZE_WARN, SIZE_MAX, DEFAULT_PATTERN,
} from '../../src/audio/stems.js';
import { normaliseEvents, passInit, renderDspHere } from '../../src/audio/bounce.js';
import { decodeWav, createDitherRng } from '../../src/audio/wav.js';
import { createStoreSync } from '../../src/audio/sync.js';
import { jobFor, buildTerrainLevels } from '../../src/audio/terrain-jobs.js';
import { createStore } from '../../src/core/store.js';
import { defaultState } from '../../src/core/params.js';
import { parseMidi } from '../../src/music/midi-file.js';

const bytes = (s) => new TextEncoder().encode(s);

describe('zip writer', () => {
  it('writes valid local headers, a central directory and CRCs that a reader round-trips', () => {
    const z = createZipWriter({ asBlob: false });
    const big = new Uint8Array(70000).map((_, i) => (i * 31) & 255);
    const date = new Date(2026, 9, 2, 21, 41, 30);
    z.add('README.txt', 'hello\r\n', { date });
    z.add('01 Bass 112bpm A Minor.wav', [big.subarray(0, 1000), big.subarray(1000)], { date });
    z.add('Ünïcode é.mid', new Uint8Array(0), { date });
    const out = z.finish();
    expect(out.length).toBe(z.size);
    const v = new DataView(out.buffer);
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    expect(v.getUint16(8, true)).toBe(0);            // stored
    expect(v.getUint16(6, true) & 0x0800).toBe(0x0800);  // UTF-8 names
    expect(v.getUint32(out.length - 22, true)).toBe(0x06054b50);
    expect(v.getUint16(out.length - 22 + 10, true)).toBe(3);
    const files = readZip(out);
    expect(files.map(f => f.name)).toEqual(['README.txt', '01 Bass 112bpm A Minor.wav', 'Ünïcode é.mid']);
    expect(new TextDecoder().decode(files[0].data)).toBe('hello\r\n');
    expect(files[1].data).toEqual(big);
    expect(files[1].crc).toBe(crc32(big));
    expect(files[2].data.length).toBe(0);
    const dt = dosDateTime(date);
    expect(files[0].date).toBe(dt.date);
    expect(files[0].time).toBe(dt.time);
    expect(dt.date >> 9).toBe(46);
    // a corrupted byte is caught by the CRC
    const bad = out.slice();
    bad[30 + 'README.txt'.length] ^= 1;
    expect(() => readZip(bad)).toThrow(/CRC/);
  });

  it('computes CRC-32 incrementally like the PNG one', () => {
    const a = bytes('The quick brown fox '), b = bytes('jumps over the lazy dog');
    expect(crc32Update(crc32Update(0, a), b)).toBe(crc32(bytes('The quick brown fox jumps over the lazy dog')));
    expect(crc32Update(0, bytes('123456789'))).toBe(0xcbf43926);
  });

  it('builds a Blob archive by default', async () => {
    const z = createZipWriter();
    z.add('a.txt', 'abc');
    const blob = z.finish();
    expect(blob.type).toBe('application/zip');
    expect(readZip(new Uint8Array(await blob.arrayBuffer()))[0].name).toBe('a.txt');
  });
});

describe('stem WAV encoding', () => {
  const ramp = (n, k = 1) => Float32Array.from({ length: n }, (_, i) => k * Math.sin(i / 7) * 0.5);

  it('writes 24-bit integer and 32-bit float headers', () => {
    const L = ramp(100), R = ramp(100, -1);
    const w24 = encodeStemWav([L, R], 96000, { bits: 24, dither: false });
    const v = new DataView(w24.buffer);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(96000);
    expect(v.getUint32(28, true)).toBe(96000 * 6);
    expect(v.getUint16(32, true)).toBe(6);
    expect(v.getUint16(34, true)).toBe(24);
    expect(v.getUint32(40, true)).toBe(600);
    const d24 = decodeWav(w24);
    expect(d24.channels[0][13]).toBeCloseTo(L[13], 6);
    const wf = encodeStemWav([L, R], 88200, { bits: 32 });
    const vf = new DataView(wf.buffer);
    expect(vf.getUint16(20, true)).toBe(3);
    expect(vf.getUint16(34, true)).toBe(32);
    expect(vf.getUint32(28, true)).toBe(88200 * 8);
    const df = decodeWav(wf);
    expect(df.float).toBe(true);
    expect(df.channels[1][57]).toBe(R[57]);
    const w16 = decodeWav(encodeStemWav([L, R], 44100, { bits: 16, dither: false }));
    expect(w16.bitsPerSample).toBe(16);
    expect(w16.channels[0][20]).toBeCloseTo(L[20], 4);
  });

  it('TPDF dither is unbiased with the expected noise power, and keeps silence silent', () => {
    const n = 200000;
    const lsb = 1 / 32768;
    const x = 0.3 * lsb;          // a third of a step: without dither this rounds to 0
    const L = new Float32Array(n).fill(x), R = new Float32Array(n);
    const plain = decodeWav(encodeStemWav([L, R], 48000, { bits: 16, dither: false }));
    expect(plain.channels[0].every(v => v === 0)).toBe(true);
    const d = decodeWav(encodeStemWav([L, R], 48000, { bits: 16, dither: true }));
    let sum = 0, sq = 0, maxSteps = 0;
    for (const v of d.channels[0]) { const e = v / lsb - 0.3; sum += e; sq += e * e; maxSteps = Math.max(maxSteps, Math.abs(v / lsb)); }
    const mean = sum / n, power = sq / n - mean * mean;
    expect(Math.abs(mean)).toBeLessThan(0.01);              // unbiased: the average is the input
    // triangular +-1 LSB (variance 1/6) plus rounding (1/12): 1/4 LSB^2
    expect(power).toBeGreaterThan(0.22);
    expect(power).toBeLessThan(0.28);
    expect(maxSteps).toBeLessThanOrEqual(2);
    expect(d.channels[1].every(v => v === 0)).toBe(true);   // exact silence stays exact
    // the dither noise is triangular: zero-centred error, rarely near the edges
    const rng = createDitherRng(7);
    let edge = 0;
    for (let i = 0; i < 100000; i++) if (Math.abs(rng() - rng()) > 0.9) edge++;
    expect(edge / 100000).toBeLessThan(0.02);
  });
});

describe('names, options and sizes', () => {
  it('fills the naming pattern and makes it safe', () => {
    expect(stemFileName(DEFAULT_PATTERN, { index: 3, name: 'Bass', tempo: 112, key: 'A Minor' })).toBe('03 Bass 112bpm A Minor.wav');
    expect(stemFileName(DEFAULT_PATTERN, { index: 1, name: 'a/b:c*?"<>|', tempo: 120.5, key: 'C# Major' })).toBe('01 a b c 120.5bpm C# Major.wav');
    expect(sanitizeFileName('  ..con..  ')).toBe('_con');
    expect(sanitizeFileName('NUL.txt')).toBe('_NUL.txt');
    expect(sanitizeFileName('\u0000\u0007')).toBe('stem');
    expect(sanitizeFileName('x'.repeat(300)).length).toBe(120);
    expect(sanitizeFileName('tab\tand\nnewline')).toBe('tab and newline');
    expect(uniqueNames(['a.wav', 'A.wav', 'a.wav', 'b'])).toEqual(['a.wav', 'A (2).wav', 'a (3).wav', 'b']);
  });

  it('applies option defaults and rules', () => {
    expect(stemOptions({})).toMatchObject({ length: 'bars', bars: 4, sampleRate: 48000, bits: 24, dither: true, normalise: 'off', wet: true, returns: false, tail: 'auto', fader: 'post' });
    expect(stemOptions({ bits: 32, dither: true }).dither).toBe(false);          // float needs no dither
    expect(stemOptions({ wet: true, returns: true }).returns).toBe(false);      // returns come with dry stems
    expect(stemOptions({ wet: false, returns: true, sampleRate: 22050, tail: 99 })).toMatchObject({ returns: true, sampleRate: 48000, tail: 30 });
  });

  it('estimates sizes and flags big exports', () => {
    expect(estimateBytes({ seconds: 10, sampleRate: 48000, bits: 24, files: 3 })).toBe(3 * (480000 * 6 + 244) + 65536);
    const st = defaultState();
    st.global.tempo = 60;
    st.parts[0].seqOn = 1;
    st.parts[0].patterns[0].steps[0].on = 1;
    const small = exportSize(st, { bars: 4 });
    expect(small).toMatchObject({ bars: 4, files: 3, warn: false, refuse: false });
    st.parts[1].seqOn = 1;
    st.parts[1].patterns[0].steps[0].on = 1;
    const big = exportSize(st, { bars: 200, sampleRate: 96000, bits: 32, tail: 0 });   // 800 s, 4 files of ~614 MB
    expect(big.bytes).toBeGreaterThan(SIZE_WARN);
    expect(big.warn).toBe(true);
    expect(big.refuse).toBe(big.bytes > SIZE_MAX);
  });

  it('measures the whole song from the longest chain', () => {
    const st = defaultState();
    expect(songBars(st)).toBe(4);                      // nothing plays: one 16-step pattern of 16ths
    st.parts[0].seqOn = 1;
    st.parts[0].patterns[0].length = 8;                 // 8 sixteenths = half a bar
    expect(songBars(st)).toBe(1);
    st.parts[1].seqOn = 1;
    st.parts[1].patterns.push({ ...st.parts[1].patterns[0], id: 'p2', rate: 0 });   // 16 quarter notes = 4 bars
    st.parts[1].chain = { on: 1, entries: [{ pattern: 0, repeats: 2 }, { pattern: 1, repeats: 3 }] };
    expect(songBars(st)).toBe(2 + 12);
    expect(keyName(st)).toMatch(/^[A-G]#? \w+/);
  });

  it('finds where the tail falls below -90 dB', () => {
    const sr = 1000;
    const L = new Float32Array(3000), R = new Float32Array(3000);
    L[1000] = 0.5; R[1733] = 1e-4; L[2500] = 1e-5;     // the last one is below -90 dBFS
    expect(autoTailFrames([L, R], 1000, sr)).toBe(1734);
    expect(autoTailFrames([new Float32Array(3000)], 1200, sr)).toBe(1200);
  });
});

describe('stem passes', () => {
  const st = () => {
    const s = defaultState();
    s.parts[0].params.reverbSend = 0.3;
    s.parts[1].params.sendA = 0.4;
    s.parts[2].params.mute = 1;
    return s;
  };
  const evs = normaliseEvents([0, 1, 2].map(part => ({ time: 0, msg: { t: 'noteOn', part, note: 60, vel: 1 } })).concat([
    { time: 0.5, msg: { t: 'params', part: 0, p: { reverbSend: 1, cutoff: 0.2 } } },
  ]));

  it('plans the mix, one stem per audible track, and the returns', () => {
    const wet = planStems(st(), evs, {});
    expect(wet.map(p => p.id)).toEqual(['mix', 'mixraw', 'track1', 'track2']);
    expect(wet.map(p => p.tap)).toEqual([null, 'bus', 'bus', 'bus']);
    expect(planStems(st(), evs, { master: true }).map(p => [p.id, p.tap])).toEqual([['mix', null], ['track1', null], ['track2', null]]);
    expect(wet[2].extra).toEqual([{ t: 'stemTap', streams: 1 }]);
    const pre = planStems(st(), evs, { fader: 'pre' });
    expect(pre[2].extra[1]).toEqual({ t: 'params', part: 0, p: { level: 1 } });
    const dry = planStems(st(), evs, { wet: false, returns: true });
    expect(dry.map(p => p.id)).toEqual(['mix', 'mixraw', 'track1', 'track2', 'sendA', 'delay', 'reverb']);
    expect(dry[2].extra[1].p).toEqual({ delaySend: 0, reverbSend: 0, sendA: 0, sendB: 0 });
    // a parameter lock cannot bring a dry stem's send back
    const lock = dry[2].events.find(e => e.msg.t === 'params');
    expect(lock.msg.p).toEqual({ cutoff: 0.2 });
    const rev = dry.find(p => p.id === 'reverb');
    expect(rev.extra[0]).toEqual({ t: 'stemTap', dry: 0, streams: 1 });
    expect(rev.extra[1].p).toEqual({ delaySend: 0, sendA: 0, sendB: 0 });
    expect(rev.events.find(e => e.msg.t === 'params').msg.p).toEqual({ reverbSend: 1, cutoff: 0.2 });
  });
});

describe('stems export with the real DSP', { timeout: 120000 }, () => {
  const sr = 24000;
  function setup(edit) {
    const store = createStore(defaultState());
    store.set('global.tempo', 240);
    for (const p of [0, 1]) {
      store.set(`parts.${p}.params.attack`, 0.001);
      store.set(`parts.${p}.params.release`, 0.02);
      store.set(`parts.${p}.params.level`, 0.6);
      store.set(`parts.${p}.seqOn`, 1);
      const steps = store.get(`parts.${p}.patterns.0.steps`).map((s, i) => ({ ...s, on: i % 4 === p ? 1 : 0, degree: p * 2, gate: 0.5 }));
      store.set(`parts.${p}.patterns.0.steps`, steps);
    }
    if (edit) edit(store);
    const sync = createStoreSync({ store, post: () => {}, defer: () => {} });
    const terrains = [];
    for (let p = 0; p < store.get('parts').length; p++) {
      for (const [s, slot] of [[0, 'A'], [1, 'B']]) terrains.push({ t: 'terrain', part: p, slot: s, levels: buildTerrainLevels(jobFor(store.get(`parts.${p}.params`), null, slot, 64)) });
    }
    const fakeCtx = { sampleRate: sr, createBuffer(ch, length) { const d = Array.from({ length: ch }, () => new Float32Array(length)); return { length, numberOfChannels: ch, sampleRate: sr, getChannelData: c => d[c] }; } };
    const engine = {
      seen: [],
      async renderPasses({ frames, passes, onPass, isCancelled }) {
        for (let i = 0; i < passes.length; i++) {
          if (isCancelled()) return false;
          const pass = passes[i];
          this.seen.push(frames(i));
          const { init, late } = passInit({ snapshot: sync.snapshot(), terrains, events: pass.events, solo: pass.solo, extra: pass.extra });
          this.progress = 0;
          const [dry] = await renderDspHere(fakeCtx, init, late, Math.round(frames(i)), (f) => { this.progress = f; }, isCancelled);
          // a stand-in for the master chain: not linear, skipped by the 'bus' tap
          if (pass.tap !== 'bus') for (let c = 0; c < 2; c++) { const d = dry.getChannelData(c); for (let k = 0; k < d.length; k++) d[k] = 0.5 * Math.tanh(2 * d[k]); }
          await onPass(dry, pass, i);
        }
        return true;
      },
    };
    return { store, engine };
  }

  it('makes a zip whose stems line up and add up to the mix (sends off)', async () => {
    const { store, engine } = setup((s) => { for (const p of [0, 1]) { s.set(`parts.${p}.params.delaySend`, 0); s.set(`parts.${p}.params.reverbSend`, 0); } });
    const res = await exportStems({ state: store.serialize(), engine, options: { bars: 1, bits: 32, tail: 0.5, sampleRate: 48000 }, date: new Date(2026, 9, 3, 9, 41) });
    // the fake engine renders at its own rate; lengths come from the request
    const files = readZip(new Uint8Array(await res.blob.arrayBuffer()));
    const names = files.map(f => f.name);
    expect(names.filter(n => n.endsWith('.wav'))).toHaveLength(4);
    expect(names[1]).toMatch(/^00 Mix \(no master processing\) 240bpm /);
    expect(names[0]).toMatch(/^00 Full mix 240bpm /);
    expect(names[2]).toMatch(/^01 Track 1|^01 /);
    expect(names).toContain('README.txt');
    expect(names).toContain('Tempo map.mid');
    expect(names.some(n => /^Oro session 240bpm .*\.mid$/.test(n))).toBe(true);
    const wavs = files.filter(f => f.name.endsWith('.wav')).map(f => decodeWav(f.data));
    expect(new Set(wavs.map(w => w.frames)).size).toBe(1);   // all the same length
    expect(wavs[0].frames).toBe(Math.round(48000 * 1.5));
    const [, mix, a, b] = wavs;
    let err = 0, energy = 0;
    for (let c = 0; c < 2; c++) for (let i = 0; i < mix.frames; i++) {
      const d = mix.channels[c][i] - a.channels[c][i] - b.channels[c][i];
      err += d * d; energy += mix.channels[c][i] ** 2;
    }
    expect(energy).toBeGreaterThan(1);
    expect(err / energy).toBeLessThan(1e-6);
    const midi = parseMidi(files.find(f => f.name.startsWith('Oro session')).data);
    expect(midi.bpm).toBeCloseTo(240, 3);
    expect(parseMidi(files.find(f => f.name === 'Tempo map.mid').data).tempos).toHaveLength(1);
    const readme = new TextDecoder().decode(files.find(f => f.name === 'README.txt').data);
    expect(readme).toMatch(/Tempo: 240 BPM, constant/);
    expect(readme).toMatch(/Bit depth: 32-bit float/);
    expect(readme).toMatch(/Place every WAV file at bar 1/);
    expect(readme).not.toMatch(/—/);
  });

  it('renders dry stems plus a Send A return that holds only the effect, with an automatic tail', async () => {
    const { engine, store } = setup((s) => { for (const p of [0, 1]) { s.set(`parts.${p}.params.delaySend`, 0); s.set(`parts.${p}.params.reverbSend`, 0); } s.set('parts.0.params.sendA', 0.6); });
    const res = await exportStems({ state: store.serialize(), engine, options: { bars: 1, bits: 24, wet: false, returns: true, normalise: 'common', sampleRate: 48000 } });
    const files = readZip(new Uint8Array(await res.blob.arrayBuffer()));
    const wavs = files.filter(f => f.name.endsWith('.wav'));
    expect(wavs.map(f => f.name.replace(/ 240bpm.*$/, ''))).toEqual(['00 Full mix', '00 Mix (no master processing)', '01 Track 1', '02 Track 2', '03 Send A reverb return']);
    expect(engine.seen[0]).toBe(48000 + 30 * 48000);   // the mix renders the longest tail ...
    expect(res.frames).toBeLessThan(engine.seen[0]);   // ... and is cut where it falls silent
    expect(res.frames).toBeGreaterThan(48000);
    expect(engine.seen.slice(1).every(f => f === res.frames)).toBe(true);
    const [, mix, a, b, ret] = wavs.map(f => decodeWav(f.data));
    let retEnergy = 0, err = 0, energy = 0, peak = 0;
    for (let c = 0; c < 2; c++) for (let i = 0; i < mix.frames; i++) {
      retEnergy += ret.channels[c][i] ** 2;
      const d = mix.channels[c][i] - a.channels[c][i] - b.channels[c][i] - ret.channels[c][i];
      err += d * d; energy += mix.channels[c][i] ** 2;
      for (const w of [mix, a, b, ret]) peak = Math.max(peak, Math.abs(w.channels[c][i]));
    }
    expect(retEnergy).toBeGreaterThan(0.01);
    expect(err / energy).toBeLessThan(1e-5);          // dry stems + return = mix
    expect(peak).toBeCloseTo(10 ** (-1 / 20), 3);       // common gain: the loudest file peaks at -1 dBFS
  });

  it('with master processing off, dry stems plus returns sum to the no-master mix within 1e-6', async () => {
    // unison with random spread: each track's voices draw random phases, so this also checks that a track
    // alone draws the same ones as in the mix (per-track random streams)
    const edit = (s) => { for (const p of [0, 1]) { s.set(`parts.${p}.params.delaySend`, 0); s.set(`parts.${p}.params.reverbSend`, 0); s.set(`parts.${p}.params.unison`, 6); s.set(`parts.${p}.params.unisonMode`, 3); } s.set('parts.1.params.sendA', 0.7); };
    const sum = async (master) => {
      const { engine, store } = setup(edit);
      const res = await exportStems({ state: store.serialize(), engine, options: { bars: 1, bits: 32, tail: 0.25, wet: false, returns: true, master } });
      const w = readZip(new Uint8Array(await res.blob.arrayBuffer())).filter(f => f.name.endsWith('.wav')).map(f => ({ name: f.name, ...decodeWav(f.data) }));
      const mixes = w.filter(x => x.name.startsWith('00 ')), stems = w.filter(x => !x.name.startsWith('00 '));
      let worst = 0;
      const ref = mixes[mixes.length - 1];
      for (let c = 0; c < 2; c++) for (let i = 0; i < ref.frames; i++) worst = Math.max(worst, Math.abs(ref.channels[c][i] - stems.reduce((acc, x) => acc + x.channels[c][i], 0)));
      return { names: w.map(x => x.name.replace(/ 240bpm.*$/, '')), worst };
    };
    const off = await sum(false);
    expect(off.names).toEqual(['00 Full mix', '00 Mix (no master processing)', '01 Track 1', '02 Track 2', '03 Send A reverb return']);
    expect(off.worst).toBeLessThan(1e-6);
    const on = await sum(true);
    expect(on.names).toEqual(['00 Full mix', '01 Track 1', '02 Track 2', '03 Send A reverb return']);
    expect(on.worst).toBeGreaterThan(1e-5);    // each file through the (not linear) master chain
  });

  it('cancels in the middle of a stem and keeps nothing', async () => {
    const { engine, store } = setup();
    let cancel = false;
    const t0 = Date.now();
    const run = exportStems({ state: store.serialize(), engine, options: { bars: 16, tail: 0 }, isCancelled: () => { if (engine.progress > 4096) cancel = true; return cancel; } });
    await expect(run).rejects.toMatchObject({ cancelled: true, message: 'Export cancelled' });
    expect(engine.seen).toHaveLength(1);                  // stopped inside the first pass
    expect(engine.progress).toBeLessThan(engine.seen[0] / 4);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('stops when cancelled', async () => {
    const { engine, store } = setup();
    let n = 0;
    await expect(exportStems({ state: store.serialize(), engine, options: { bars: 1, tail: 0 }, onProgress: () => {}, isCancelled: () => ++n > 3 })).rejects.toThrow(/cancelled/);
  });
});
