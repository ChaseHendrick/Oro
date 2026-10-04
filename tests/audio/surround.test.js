// 2.12 surround export: the WAVE_FORMAT_EXTENSIBLE header, the export plan,
// the mix-down helpers, a 5.1 export with the real DSP, and the saved data
// (3D parameters optional, defaults unchanged, listening modes never saved).
import { describe, it, expect } from 'vitest';
import { wavHeader, wavHeaderExtensible, decodeWav, wavInfo, WAV_EXT_HEADER_BYTES } from '../../src/audio/wav.js';
import { encodeStemPieces, planStems, stemOptions, addStereoToSurround, fillLfe, exportStems, exportSize, SURROUND_SPREAD } from '../../src/audio/stems.js';
import { normaliseEvents, passInit, renderDspHere } from '../../src/audio/bounce.js';
import { readZip } from '../../src/audio/zip.js';
import { createStoreSync } from '../../src/audio/sync.js';
import { jobFor, buildTerrainLevels } from '../../src/audio/terrain-jobs.js';
import { createStore } from '../../src/core/store.js';
import { defaultState, defaultPart, PART_PARAMS, SPACE_PARAM_IDS } from '../../src/core/params.js';
import { sanitizePart, migrateState } from '../../src/core/migrate.js';
import { partPatch } from '../../src/presets/presets.js';
import { SURROUND_LAYOUTS } from '../../src/dsp/spatial.js';

const blobBytes = async (pieces) => new Uint8Array(await new Blob(pieces).arrayBuffer());

describe('WAVE_FORMAT_EXTENSIBLE', () => {
  it('writes the 68-byte header with the 5.1 mask and PCM sub-format', () => {
    const h = wavHeaderExtensible({ sampleRate: 48000, channels: 6, bitsPerSample: 24, frames: 10, channelMask: 0x3F });
    expect(h.length).toBe(WAV_EXT_HEADER_BYTES);
    const v = new DataView(h.buffer);
    const ascii = (o, n) => String.fromCharCode(...h.subarray(o, o + n));
    expect(ascii(0, 4)).toBe('RIFF'); expect(ascii(8, 4)).toBe('WAVE'); expect(ascii(12, 4)).toBe('fmt ');
    expect(v.getUint32(16, true)).toBe(40);
    expect(v.getUint16(20, true)).toBe(0xFFFE);
    expect(v.getUint16(22, true)).toBe(6);
    expect(v.getUint32(28, true)).toBe(48000 * 18);
    expect(v.getUint16(32, true)).toBe(18);
    expect(v.getUint16(36, true)).toBe(22);
    expect(v.getUint16(38, true)).toBe(24);
    expect(v.getUint32(40, true)).toBe(0x3F);
    expect(Array.from(h.subarray(44, 60))).toEqual([1, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xAA, 0, 0x38, 0x9B, 0x71]);
    expect(ascii(60, 4)).toBe('data');
    expect(v.getUint32(64, true)).toBe(180);
    expect(v.getUint32(4, true)).toBe(60 + 180);
    // float sub-format
    expect(wavHeaderExtensible({ sampleRate: 48000, channels: 8, bitsPerSample: 32, frames: 1, format: 3, channelMask: 0x63F })[44]).toBe(3);
  });

  it('round-trips 6 and 8 channels through the decoder, every channel in its place', async () => {
    for (const [layout, bits] of [['5.1', 24], ['7.1', 32], ['5.1', 16]]) {
      const L = SURROUND_LAYOUTS[layout];
      const frames = 300;
      const chans = Array.from({ length: L.channels }, (_, c) => Float32Array.from({ length: frames }, (_, i) => ((c + 1) / 10) * Math.sin(i / (5 + c))));
      const bytes = await blobBytes(await encodeStemPieces(chans, frames, 48000, { bits, dither: false, channelMask: L.mask }));
      const info = wavInfo(bytes);
      expect(info.channels).toBe(L.channels);
      expect(info.channelMask).toBe(L.mask);
      expect(info.float).toBe(bits === 32);
      const d = decodeWav(bytes);
      for (let c = 0; c < L.channels; c++) for (let i = 0; i < frames; i++) expect(Math.abs(d.channels[c][i] - chans[c][i])).toBeLessThan(bits === 16 ? 1e-4 : 1e-6);
    }
  });

  it('stereo files keep the plain 44-byte header', async () => {
    const chans = [new Float32Array(4), new Float32Array(4)];
    const pieces = await encodeStemPieces(chans, 4, 48000, { bits: 24, dither: false });
    expect(Array.from(pieces[0])).toEqual(Array.from(wavHeader({ sampleRate: 48000, channels: 2, bitsPerSample: 24, frames: 4 })));
  });
});

describe('surround plan and mix-down', () => {
  const state = () => {
    const s = defaultState();
    for (const p of [0, 1]) { s.parts[p].seqOn = 1; s.parts[p].patterns[0].steps[0].on = 1; }
    return s;
  };
  const evs = (s) => normaliseEvents([{ time: 0, msg: { t: 'noteOn', part: 0, note: 60, vel: 1 } }, { time: 0, msg: { t: 'noteOn', part: 1, note: 64, vel: 1 } }], 2);

  it('Off leaves the plan exactly as before', () => {
    const s = state();
    expect(planStems(s, evs(s), { surround: 'off' })).toEqual(planStems(s, evs(s), {}));
    expect(stemOptions({}).surround).toBe('off');
    expect(stemOptions({ surround: '9.2' }).surround).toBe('off');
  });

  it('5.1 adds a dry speaker pass and an effects pass, neither a file of its own', () => {
    const s = state();
    s.parts[0].params.reverbSend = 0.4;
    const passes = planStems(s, evs(s), { surround: '5.1' });
    const sur = passes.find(p => p.kind === 'surround');
    expect(sur.surround).toBe(6);
    expect(sur.file).toBe(false);
    expect(sur.extra.find(m => m.t === 'surround')).toMatchObject({ layout: '5.1', spread: 0 });
    for (const m of sur.extra.filter(m => m.t === 'params')) expect(m.p).toEqual({ delaySend: 0, reverbSend: 0, sendA: 0, sendB: 0 });
    const fx = passes.find(p => p.kind === 'surround-fx');
    expect(fx.tap).toBe('bus');
    expect(fx.extra[0]).toMatchObject({ t: 'stemTap', dry: 0 });
    // no sends anywhere: no effects pass
    for (const p of s.parts) for (const k of ['delaySend', 'reverbSend', 'sendA', 'sendB']) p.params[k] = 0;
    expect(planStems(s, evs(s), { surround: '7.1', spread: true }).find(p => p.kind === 'surround-fx')).toBeUndefined();
    expect(planStems(s, evs(s), { surround: '7.1', spread: true }).find(p => p.kind === 'surround').extra.find(m => m.t === 'surround').spread).toBe(SURROUND_SPREAD);
    // a 6-channel file counts as three stereo files in the size estimate
    const a = exportSize(s, { bars: 4 }), b = exportSize(s, { bars: 4, surround: '5.1' });
    expect(b.files).toBe(a.files + 1);
    expect(b.bytes).toBeGreaterThan(a.bytes * 1.3);
  });

  it('effects go to front left/right, Spread moves a fixed share of power to the rear pair', () => {
    const L = SURROUND_LAYOUTS['5.1'];
    const acc = Array.from({ length: 6 }, () => new Float32Array(4));
    addStereoToSurround(acc, L, [1, 1, 1, 1], [0.5, 0.5, 0.5, 0.5], 4, 0);
    expect(acc[0][0]).toBe(1); expect(acc[1][0]).toBe(0.5); expect(acc[4][0]).toBe(0);
    const s = Array.from({ length: 6 }, () => new Float32Array(1));
    addStereoToSurround(s, L, [1], [0], 1, SURROUND_SPREAD);
    expect(s[0][0] ** 2 + s[4][0] ** 2).toBeCloseTo(1, 6);
    expect(s[4][0] ** 2).toBeCloseTo(SURROUND_SPREAD, 6);
  });

  it('LFE is a low-pass of the mix: bass through, treble gone', () => {
    const L = SURROUND_LAYOUTS['5.1'];
    const n = 48000;
    const mk = (hz) => { const a = Array.from({ length: 6 }, () => new Float32Array(n)); for (let i = 0; i < n; i++) a[0][i] = a[1][i] = Math.sin(2 * Math.PI * hz * i / 48000); return a; };
    const level = (a) => { let p = 0; for (let i = n / 2; i < n; i++) p = Math.max(p, Math.abs(a[3][i])); return p; };
    const lo = mk(40), hi = mk(2000);
    fillLfe(lo, L, n, 48000); fillLfe(hi, L, n, 48000);
    expect(level(lo)).toBeGreaterThan(0.8);
    expect(level(hi)).toBeLessThan(0.001);
  });
});

describe('5.1 export with the real DSP', { timeout: 120000 }, () => {
  const sr = 24000;
  function setup(edit) {
    const store = createStore(defaultState());
    store.set('global.tempo', 240);
    for (const p of [0, 1]) {
      store.set(`parts.${p}.params.attack`, 0.001);
      store.set(`parts.${p}.params.release`, 0.02);
      store.set(`parts.${p}.params.level`, 0.6);
      for (const k of ['delaySend', 'reverbSend']) store.set(`parts.${p}.params.${k}`, 0);
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
      passes: [],
      async renderPasses({ frames, passes, onPass, isCancelled }) {
        for (let i = 0; i < passes.length; i++) {
          const pass = passes[i];
          this.passes.push(pass.kind);
          const { init, late } = passInit({ snapshot: sync.snapshot(), terrains, events: pass.events, solo: pass.solo, extra: pass.extra });
          const bufs = await renderDspHere(fakeCtx, init, late, Math.round(frames(i)), () => {}, isCancelled, pass.surround || 0);
          let out = bufs[0];
          if (pass.surround) {
            // what the offline graph does: dry (front left/right) plus the speaker output, discrete
            const sur = bufs[3];
            for (let c = 0; c < 2; c++) sur.getChannelData(c).set(bufs[0].getChannelData(c));
            out = sur;
          }
          await onPass(out, pass, i);
        }
        return true;
      },
    };
    return { store, engine };
  }

  it('a 3D track at 110 degrees lands on the right surround; the plain track stays on front left/right, matching its stem', async () => {
    const { store, engine } = setup((s) => { s.set('parts.1.params.space', 1); s.set('parts.1.params.spaceAz', 110); });
    const res = await exportStems({ state: store.serialize(), engine, options: { bars: 1, bits: 32, tail: 0.5, sampleRate: 48000, surround: '5.1', wet: false } });
    expect(engine.passes).toContain('surround');
    expect(engine.passes).not.toContain('surround-fx');
    const files = readZip(new Uint8Array(await res.blob.arrayBuffer()));
    const surFile = files.find(f => /surround 5\.1/i.test(f.name));
    expect(surFile).toBeTruthy();
    const wav = decodeWav(surFile.data);
    expect(wav.channels).toHaveLength(6);
    expect(wavInfo(surFile.data).channelMask).toBe(0x3F);
    const energy = wav.channels.map(ch => ch.reduce((s, x) => s + x * x, 0));
    expect(energy[5]).toBeGreaterThan(1e-3);          // Rs: the 3D track
    expect(energy[3]).toBe(0);                         // LFE off
    expect(energy[2] + energy[4]).toBeLessThan(energy[5] * 1e-6);
    // track 1 (plain) alone is on front left/right: the same samples as its own stem
    const stem = decodeWav(files.find(f => /^01 /.test(f.name)).data);
    let diff = 0;
    for (let i = 0; i < stem.frames; i++) diff = Math.max(diff, Math.abs(stem.channels[0][i] - wav.channels[0][i]), Math.abs(stem.channels[1][i] - wav.channels[1][i]));
    expect(diff).toBeLessThan(1e-5);
    const readme = new TextDecoder().decode(files.find(f => f.name === 'README.txt').data);
    expect(readme).toMatch(/5\.1 surround mix \(6 channels in the order L, R, C, LFE, Ls, Rs/);
    expect(readme).not.toMatch(/[–—]/);
  });
});

describe('saved data', () => {
  it('3D parameters are appended, default Off, clamped on load; old sessions load unchanged', () => {
    const ids = PART_PARAMS.map(p => p.id);
    const at = ids.indexOf('space');
    expect(ids.slice(at, at + 5)).toEqual(['space', 'spaceAz', 'spaceEl', 'spaceDist', 'spaceAir']);
    // 2.13 sampler params are appended after 3D (append-only; they are not last forever)
    expect(ids.slice(at + 5, at + 9)).toEqual(['smpSpeed', 'smpStart', 'smpEnd', 'smpPos']);
    const def = defaultPart(0).params;
    expect(def).toMatchObject({ space: 0, spaceAz: 0, spaceEl: 0, spaceDist: 1, spaceAir: 1 });
    const p = sanitizePart({ params: { space: 9, spaceAz: 400, spaceEl: -90, spaceDist: 0.01, spaceAir: 0.7 } }, 0);
    expect(p.params).toMatchObject({ space: 3, spaceAz: 180, spaceEl: -40, spaceDist: 0.5, spaceAir: 1 });
    // a session saved before 2.12 has none of them: it loads with 3D off everywhere
    const old = JSON.parse(JSON.stringify(defaultState()));
    for (const part of old.parts) for (const id of SPACE_PARAM_IDS) delete part.params[id];
    const m = migrateState(old);
    for (const part of m.parts) expect(part.params.space).toBe(0);
  });

  it('patches never carry the 3D position (it belongs to the mix, like the sends)', () => {
    const part = defaultPart(0);
    part.params.space = 2; part.params.spaceAz = 45;
    const patch = partPatch(part, { name: 'x' });
    for (const id of SPACE_PARAM_IDS) expect(patch.params[id]).toBeUndefined();
  });

  it('listening modes and live surround are never in a saved session', () => {
    const store = createStore(defaultState());
    store.set('ui.listenMode', 'mono');
    store.set('ui.liveSurround', '5.1');
    const json = JSON.stringify(store.serialize());
    expect(json).not.toMatch(/listenMode|liveSurround/);
  });
});
