// Shared helpers for the DSP tests: offline rendering, WAV writing, spectra.
import { OroDSP } from '../../src/dsp/dsp-core.js';
import { generateTerrain, buildMipChain } from '../../src/dsp/terrains.js';

export const SR = 48000;
const chainCache = new Map();

export function terrainChain(index, opts = {}) {
  const key = `${index}|${opts.seed ?? 7}|${opts.detail ?? 0.5}|${opts.size ?? 512}`;
  if (!chainCache.has(key)) {
    const size = opts.size ?? 512;
    chainCache.set(key, buildMipChain(generateTerrain(index, { size, seed: opts.seed ?? 7, detail: opts.detail ?? 0.5 }), size));
  }
  return chainCache.get(key);
}

/** New engine with optional terrains for part 0..n and params applied. */
export function makeDSP({ sr = SR, part = 0, params = {}, mods = null, terrainA = null, terrainB = null } = {}) {
  const dsp = new OroDSP(sr);
  if (terrainA !== null) dsp.handleMessage({ t: 'terrain', part, slot: 0, levels: terrainChain(terrainA) });
  if (terrainB !== null) dsp.handleMessage({ t: 'terrain', part, slot: 1, levels: terrainChain(terrainB) });
  if (params) dsp.handleMessage({ t: 'params', part, p: params });
  if (mods) dsp.handleMessage({ t: 'mods', part, m: mods });
  return dsp;
}

/**
 * Render `seconds` of audio in 128-frame blocks. `script(dsp, time, blockIndex)`
 * runs before each block (for timed messages). Returns { L, R, dly, rev, time }.
 */
export function render(dsp, seconds, script = null, block = 128) {
  const sr = dsp.sr;
  const total = Math.round(seconds * sr);
  const L = new Float32Array(total), R = new Float32Array(total);
  const DL = new Float32Array(total), DR = new Float32Array(total);
  const VL = new Float32Array(total), VR = new Float32Array(total);
  const bl = new Float32Array(block), br = new Float32Array(block);
  const dl = new Float32Array(block), dr = new Float32Array(block);
  const rl = new Float32Array(block), rr = new Float32Array(block);
  let t = dsp.lastTime || 0;
  let i = 0, k = 0;
  while (i < total) {
    const n = Math.min(block, total - i);
    if (script) script(dsp, t, k);
    dsp.process(bl, br, dl, dr, rl, rr, n, t);
    L.set(bl.subarray(0, n), i); R.set(br.subarray(0, n), i);
    DL.set(dl.subarray(0, n), i); DR.set(dr.subarray(0, n), i);
    VL.set(rl.subarray(0, n), i); VR.set(rr.subarray(0, n), i);
    i += n; t += n / sr; k++;
  }
  dsp.lastTime = t;
  return { L, R, DL, DR, VL, VR, time: t };
}

export function rms(a, from = 0, to = a.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

export function peak(a, from = 0, to = a.length) {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(a[i]));
  return p;
}

export function allFinite(a) {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
}

/** Magnitude spectrum (Hann window) of a power-of-two length frame via radix-2 FFT. */
export function spectrum(x, start, n) {
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = x[start + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  const mag = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

/** 16-bit stereo WAV bytes. */
export function wavBytes(L, R, sr) {
  const n = L.length;
  const buf = new ArrayBuffer(44 + n * 4);
  const dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    dv.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
    dv.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
  }
  return new Uint8Array(buf);
}
