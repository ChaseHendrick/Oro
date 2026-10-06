// Offline score rendering (2.17): a score in, a finished stereo mix out,
// with no page and no Web Audio. It runs the same OroDSP the app runs (at
// Pristine quality by default), with the same tracks the score desk would
// build (planTracks + voicedPart), then the app's master chain in plain
// JavaScript:
//
//   dry ──────────────────────────────────────────┐
//   delay send ─> ping-pong delay (fx.js maths) ───┼─> chorus ─> warmth ─> volume
//   reverb send ─> 70 Hz HP ─> convolution with ───┘      ─> loudness (BS.1770) ─> look-ahead limiter ─> out
//                  the app's own impulse (reverb-ir.js)
//
// The reverb is a real convolution (uniformly partitioned FFT) with the
// impulse the app's ConvolverNode uses, so a render sounds like the app.
// Loudness is measured as in ITU-R BS.1770 (K-weighting, 400 ms blocks,
// absolute and relative gates) and brought to `loudness` LUFS (default -14)
// before a look-ahead limiter holds the peaks under `ceiling` dBFS.
// encodeScoreWav() writes 24-bit WAV with TPDF dither (or 32-bit float).

import { OroDSP } from '../dsp/dsp-core.js';
import { createStore } from '../core/store.js';
import { defaultState, defaultPart, MAX_PARTS } from '../core/params.js';
import { createStoreSync } from '../audio/sync.js';
import { jobFor, jobKey, buildTerrainLevels } from '../audio/terrain-jobs.js';
import { generateImpulse } from '../audio/reverb-ir.js';
import { delaySeconds, delayToneFreqs, chorusSettings, warmthSettings, volumeGain } from '../audio/fx.js';
import { encodeWav } from '../audio/wav.js';
import { check } from './score.js';
import { planTracks, voicedPart } from './desk.js';
import { swingBeat } from './transport.js';

export const RENDER_QUALITIES = Object.freeze(['eco', 'standard', 'high', 'pristine']);
export const MAX_RENDER_SECONDS = 300;
const BLOCK = 128;
const LEAD = 0.05;            // seconds of silence before the first note
const FEED = 0.05;            // events reach the DSP this far ahead of their time

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * Render a score. Options: sampleRate (48000), quality ('pristine'),
 * voicing (the score's, else 'patch'), tail (seconds after the last bar, 3),
 * loudness (target LUFS, -14; null keeps the app's level), ceiling (dBFS, -1),
 * master (false skips delay, reverb, chorus and warmth), onProgress(fraction).
 * Returns { ok, receipt, sampleRate, left, right, stats } or { ok: false, receipt }.
 */
export async function renderScore(input, opts = {}) {
  const receipt = check(input);
  if (!receipt.ok) return { ok: false, receipt };
  const sr = clamp(Math.round(num(opts.sampleRate, 48000)), 22050, 192000);
  const quality = RENDER_QUALITIES.includes(opts.quality) ? opts.quality : 'pristine';
  const voicing = opts.voicing || receipt.score.voicing || 'patch';
  const tail = clamp(num(opts.tail, 3), 0, 30);
  const seconds = receipt.durationSeconds + LEAD + tail;
  if (seconds > MAX_RENDER_SECONDS) {
    return { ok: false, receipt: { ...receipt, ok: false, errors: [{ line: 0, field: 'length', message: `${Math.round(seconds)} s is over the ${MAX_RENDER_SECONDS / 60} minute render limit.`, fix: 'Split the piece.' }] } };
  }
  const progress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  // ---- the tracks the desk would build, as a session of their own
  const plan = planTracks(receipt, 0, { tracks: 'add' });
  const parts = plan.slots.slice().sort((a, b) => a.part - b.part).map((s, i) => {
    const base = defaultPart(i, { name: s.name });
    return voicedPart(base, s, receipt, voicing);
  });
  if (!parts.length) parts.push(defaultPart(0));
  const state = defaultState();
  state.parts = parts.slice(0, MAX_PARTS);
  state.global = { ...state.global, tempo: Math.round(clamp(receipt.score.bpm, 40, 240)), ...(opts.global || {}) };
  const store = createStore(state);
  const g = store.get('global');

  // ---- the DSP, brought up to that session
  const dsp = new OroDSP(sr);
  dsp.postMessage = () => {};
  dsp.handleMessage({ t: 'quality', mode: quality });
  const sync = createStoreSync({ store, post: () => {}, defer: () => {}, sampleRate: () => sr });
  for (const m of sync.snapshot(false)) dsp.handleMessage(m);
  const cache = new Map();
  state.parts.forEach((p, part) => {
    ['A', 'B'].forEach((slot, s) => {
      const job = jobFor(p.params, p.userTerrain && p.userTerrain[slot], slot, 512);
      const key = jobKey(job);
      if (!cache.has(key)) cache.set(key, buildTerrainLevels(job));
      // the engine may keep the buffers: every track gets its own copies
      const levels = cache.get(key).map((l) => ({ size: l.size, data: new Float32Array(l.data) }));
      dsp.handleMessage({ t: 'terrain', part, slot: s, levels });
    });
  });
  dsp.handleMessage({ t: 'watch', part: -1 });

  // ---- the notes, as timed protocol messages
  const spb = 60 / receipt.score.bpm;
  const swing = receipt.score.swing || 0;
  const at = (beat) => LEAD + swingBeat(beat, swing) * spb;
  const events = [];
  for (const n of receipt.score.notes) {
    const part = plan.partOf.get(n.voice);
    if (part == null) continue;
    const note = plan.fallback.has(n.voice) ? 36 : n.midi;
    const on = at(n.beat), off = Math.max(on + 0.02, at(n.beat + n.len));
    events.push({ time: on, msg: { t: 'noteOn', part, note, vel: n.vel, time: on } });
    events.push({ time: off, msg: { t: 'noteOff', part, note, time: off } });
  }
  events.sort((a, b) => a.time - b.time || (a.msg.t === 'noteOff' ? -1 : 1));

  // ---- render the three buses
  const frames = Math.ceil(seconds * sr);
  const dry = [new Float32Array(frames), new Float32Array(frames)];
  const dly = [new Float32Array(frames), new Float32Array(frames)];
  const rev = [new Float32Array(frames), new Float32Array(frames)];
  const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK), dl = new Float32Array(BLOCK), dr = new Float32Array(BLOCK);
  const rl = new Float32Array(BLOCK), rr = new Float32Array(BLOCK);
  let next = 0;
  let lastReport = 0;
  for (let f = 0; f < frames; f += BLOCK) {
    const n = Math.min(BLOCK, frames - f);
    const t = f / sr;
    while (next < events.length && events[next].time < t + FEED) dsp.handleMessage(events[next++].msg);
    bl.fill(0); br.fill(0); dl.fill(0); dr.fill(0); rl.fill(0); rr.fill(0);
    dsp.process(bl, br, dl, dr, rl, rr, n, t);
    dry[0].set(n === BLOCK ? bl : bl.subarray(0, n), f); dry[1].set(n === BLOCK ? br : br.subarray(0, n), f);
    dly[0].set(n === BLOCK ? dl : dl.subarray(0, n), f); dly[1].set(n === BLOCK ? dr : dr.subarray(0, n), f);
    rev[0].set(n === BLOCK ? rl : rl.subarray(0, n), f); rev[1].set(n === BLOCK ? rr : rr.subarray(0, n), f);
    if (f - lastReport >= sr) {
      lastReport = f;
      progress(0.85 * f / frames);
      // let a browser breathe; Node does not need it
      if (opts.yieldEvery && (f / sr) % opts.yieldEvery < BLOCK / sr) await new Promise((r) => setTimeout(r, 0));
    }
  }

  // ---- master chain
  const out = [new Float32Array(frames), new Float32Array(frames)];
  const master = opts.master !== false;
  for (let c = 0; c < 2; c++) out[c].set(dry[c]);
  if (master) {
    const delayLevel = num(g.delayLevel, 0.7);
    if (delayLevel > 0) {
      const wet = pingPong(dly[0], dly[1], sr, delaySeconds(g.tempo, num(g.delayDiv, 3)), num(g.delayFeedback, 0.42), num(g.delayTone, 0.55));
      for (let c = 0; c < 2; c++) for (let i = 0; i < frames; i++) out[c][i] += wet[c][i] * delayLevel;
    }
    progress(0.88);
    const reverbLevel = num(g.reverbLevel, 0.75);
    if (reverbLevel > 0) {
      const ir = generateImpulse({ sampleRate: sr, size: num(g.reverbSize, 0.62), damp: num(g.reverbDamp, 0.45) });
      const hp = [biquadRun(rev[0], 'high', 70, 0.6, sr), biquadRun(rev[1], 'high', 70, 0.6, sr)];
      const wl = convolve(hp[0], ir.left), wr = convolve(hp[1], ir.right);
      for (let i = 0; i < frames; i++) { out[0][i] += wl[i] * reverbLevel; out[1][i] += wr[i] * reverbLevel; }
    }
    progress(0.94);
    chorus(out, sr, num(g.chorus, 0.15));
    warmth(out, num(g.saturation, 0.15));
  }
  const vol = volumeGain(num(g.masterVolume, 0.8));
  for (let c = 0; c < 2; c++) for (let i = 0; i < frames; i++) out[c][i] *= vol;

  const before = loudness(out[0], out[1], sr);
  let gain = 1;
  if (opts.loudness !== null && Number.isFinite(before)) {
    const target = clamp(num(opts.loudness, -14), -40, -5);
    gain = Math.pow(10, clamp(target - before, -24, 18) / 20);
  }
  const ceiling = Math.pow(10, clamp(num(opts.ceiling, -1), -12, 0) / 20);
  const limited = limit(out, sr, gain, ceiling);
  const after = loudness(out[0], out[1], sr);
  progress(1);
  let peak = 0;
  for (let c = 0; c < 2; c++) for (let i = 0; i < frames; i++) { const a = Math.abs(out[c][i]); if (a > peak) peak = a; }
  return {
    ok: true,
    receipt,
    sampleRate: sr,
    left: out[0],
    right: out[1],
    tracks: plan.slots.map((s) => ({ part: s.part, name: s.name, kind: s.kind, voice: s.voice || null })),
    stats: {
      seconds: Math.round(frames / sr * 1000) / 1000,
      quality, voicing,
      loudnessBefore: round2(before), loudness: round2(after),
      peakDb: round2(20 * Math.log10(Math.max(peak, 1e-9))),
      limiterMaxReductionDb: round2(limited),
    },
  };
}

/** WAV bytes for a render: 24-bit with TPDF dither (default) or 32-bit float. */
export function encodeScoreWav(render, { format = 'pcm24' } = {}) {
  return encodeWav([render.left, render.right], render.sampleRate, { format: format === 'float32' ? 'float32' : 'pcm24', dither: true });
}

const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

// ------------------------------------------------------------------ filters

function biquadCoefs(kind, hz, q, sr) {
  const w = 2 * Math.PI * clamp(hz, 5, sr * 0.45) / sr, cs = Math.cos(w), a = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (kind === 'low') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; } else { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; }
  const a0 = 1 + a;
  return [b0 / a0, b1 / a0, b2 / a0, -2 * cs / a0, (1 - a) / a0];
}

function biquadRun(x, kind, hz, q, sr) {
  const [b0, b1, b2, a1, a2] = biquadCoefs(kind, hz, q, sr);
  const y = new Float32Array(x.length);
  let z1 = 0, z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i], o = b0 * v + z1;
    z1 = b1 * v - a1 * o + z2; z2 = b2 * v - a2 * o;
    y[i] = o;
  }
  return y;
}

/** The app's ping-pong delay (fx.js): mono in, repeats alternate and darken. */
function pingPong(inL, inR, sr, seconds, feedback, tone) {
  const n = inL.length, d = Math.max(1, Math.round(seconds * sr));
  const lineL = new Float32Array(d), lineR = new Float32Array(d);
  const t = delayToneFreqs(tone);
  const hp = biquadCoefs('high', t.highpass, Math.SQRT1_2, sr), lp = biquadCoefs('low', t.lowpass, Math.SQRT1_2, sr);
  const st = new Float64Array(8);
  const step = (x, c, k) => { const o = c[0] * x + st[k]; st[k] = c[1] * x - c[3] * o + st[k + 1]; st[k + 1] = c[2] * x - c[4] * o; return o; };
  const outL = new Float32Array(n), outR = new Float32Array(n);
  let pos = 0;
  const fb = clamp(feedback, 0, 0.95);
  for (let i = 0; i < n; i++) {
    const yl = lineL[pos], yr = lineR[pos];
    const fl = step(step(yl, hp, 0), lp, 2), fr = step(step(yr, hp, 4), lp, 6);
    outL[i] = fl; outR[i] = fr;
    lineL[pos] = (inL[i] + inR[i]) * 0.5 + fr * fb;
    lineR[pos] = fl * fb;
    if (++pos === d) pos = 0;
  }
  return [outL, outR];
}

/** The app's master chorus: two short delays swept by slow sines in opposite directions. */
function chorus(out, sr, amount) {
  const ch = chorusSettings(amount);
  if (ch.wet <= 0) return;
  const n = out[0].length, size = Math.ceil(0.05 * sr) + 4;
  const bufL = new Float32Array(size), bufR = new Float32Array(size);
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const l = out[0][i], r = out[1][i];
    bufL[pos] = l; bufR[pos] = r;
    const dL = (0.0125 + ch.depth * Math.sin(2 * Math.PI * 0.31 * t)) * sr;
    const dR = (0.0145 - ch.depth * Math.sin(2 * Math.PI * 0.23 * t)) * sr;
    out[0][i] = l * ch.dry + readFrac(bufL, pos, dL, size) * ch.wet;
    out[1][i] = r * ch.dry + readFrac(bufR, pos, dR, size) * ch.wet;
    if (++pos === size) pos = 0;
  }
}

function readFrac(buf, pos, delay, size) {
  let p = pos - delay;
  while (p < 0) p += size;
  const i = p | 0, f = p - i, j = i + 1 === size ? 0 : i + 1;
  return buf[i] + (buf[j] - buf[i]) * f;
}

/** The app's warmth stage: tanh around a fixed curve, level-compensated. */
function warmth(out, amount) {
  const w = warmthSettings(amount);
  for (let c = 0; c < 2; c++) {
    const x = out[c];
    for (let i = 0; i < x.length; i++) x[i] = Math.tanh(8 * clamp(x[i] * w.pre, -1, 1)) * w.post;
  }
}

// ------------------------------------------------------------- convolution

function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/** Uniformly partitioned overlap-save convolution of x with h (output length = x). */
export function convolve(x, h, B = 2048) {
  const N = 2 * B, P = Math.max(1, Math.ceil(h.length / B));
  const Hr = [], Hi = [];
  for (let p = 0; p < P; p++) {
    const r = new Float64Array(N), i = new Float64Array(N);
    for (let k = 0; k < B && p * B + k < h.length; k++) r[k] = h[p * B + k];
    fft(r, i, false);
    Hr.push(r); Hi.push(i);
  }
  const Xr = Array.from({ length: P }, () => new Float64Array(N)), Xi = Array.from({ length: P }, () => new Float64Array(N));
  const y = new Float32Array(x.length);
  const prev = new Float64Array(B);
  const accR = new Float64Array(N), accI = new Float64Array(N);
  let head = 0;
  for (let start = 0; start < x.length; start += B) {
    head = (head + P - 1) % P;
    const r = Xr[head], im = Xi[head];
    for (let k = 0; k < B; k++) { r[k] = prev[k]; const v = start + k < x.length ? x[start + k] : 0; r[B + k] = v; prev[k] = v; }
    im.fill(0);
    fft(r, im, false);
    accR.fill(0); accI.fill(0);
    for (let p = 0; p < P; p++) {
      const s = (head + p) % P, ar = Xr[s], ai = Xi[s], hr = Hr[p], hi = Hi[p];
      for (let k = 0; k < N; k++) { accR[k] += ar[k] * hr[k] - ai[k] * hi[k]; accI[k] += ar[k] * hi[k] + ai[k] * hr[k]; }
    }
    fft(accR, accI, true);
    for (let k = 0; k < B && start + k < x.length; k++) y[start + k] = accR[B + k];
  }
  return y;
}

// ---------------------------------------------------------------- loudness

/** Integrated loudness (LUFS) of a stereo signal, ITU-R BS.1770-4. -Infinity for silence. */
export function loudness(L, R, sr) {
  const [s1, s2] = kWeights(sr);
  const hop = Math.round(0.1 * sr);
  // K-weighted mean squares per 100 ms; a 400 ms block is four of them (75% overlap)
  const subs = [];
  const st = new Float64Array(16);
  let acc = 0, count = 0;
  const kStep = (v, o) => {
    let y = s1[0] * v + s1[1] * st[o] + s1[2] * st[o + 1] - s1[3] * st[o + 2] - s1[4] * st[o + 3];
    st[o + 1] = st[o]; st[o] = v; st[o + 3] = st[o + 2]; st[o + 2] = y;
    const x = y;
    y = s2[0] * x + s2[1] * st[o + 4] + s2[2] * st[o + 5] - s2[3] * st[o + 6] - s2[4] * st[o + 7];
    st[o + 5] = st[o + 4]; st[o + 4] = x; st[o + 7] = st[o + 6]; st[o + 6] = y;
    return y;
  };
  for (let i = 0; i < L.length; i++) {
    const a = kStep(L[i], 0), b = kStep(R[i], 8);
    acc += a * a + b * b;
    if (++count === hop) { subs.push(acc); acc = 0; count = 0; }
  }
  const z = [];
  for (let i = 0; i + 4 <= subs.length; i++) z.push((subs[i] + subs[i + 1] + subs[i + 2] + subs[i + 3]) / (4 * hop));
  const lk = (m) => -0.691 + 10 * Math.log10(m);
  const abs = z.filter((m) => m > 0 && lk(m) > -70);
  if (!abs.length) return -Infinity;
  const rel = lk(abs.reduce((x, y) => x + y, 0) / abs.length) - 10;
  const gated = abs.filter((m) => lk(m) > rel);
  return lk(gated.reduce((x, y) => x + y, 0) / gated.length);
}

function kWeights(fs) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / fs);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const s1 = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan(Math.PI * f0 / fs);
  a0 = 1 + K / Q + K * K;
  const s2 = [1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  return [s1, s2];
}

// ----------------------------------------------------------------- limiter

/**
 * Gain, then a stereo-linked look-ahead peak limiter (1.5 ms look-ahead,
 * instant attack over the look-ahead, 120 ms release) holding |x| <= ceiling.
 * Works in place. Returns the deepest gain reduction in dB.
 */
function limit(out, sr, gain, ceiling) {
  const n = out[0].length, look = Math.max(1, Math.round(0.0015 * sr));
  const rel = 1 - Math.exp(-1 / (0.12 * sr));
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(Math.abs(out[0][i]), Math.abs(out[1][i])) * gain;
    need[i] = a > ceiling ? ceiling / a : 1;
  }
  // the gain must already be down when the peak arrives: minimum over the look-ahead window
  const want = new Float32Array(n);
  const dq = new Int32Array(n);
  let h = 0, t = 0;
  for (let i = 0; i < n + look; i++) {
    if (i < n) { while (t > h && need[dq[t - 1]] >= need[i]) t--; dq[t++] = i; }
    const j = i - look;
    if (j >= 0) {
      while (dq[h] < j - look) h++;
      want[j] = need[dq[h]];
    }
  }
  let g = 1, deepest = 1;
  for (let i = 0; i < n; i++) {
    // ramp down across the look-ahead, recover with the release
    const w = want[i];
    g = w < g ? g + (w - g) / look * 2 : g + (w - g) * rel;
    const k = Math.min(g, need[i]) * gain;
    out[0][i] *= k; out[1][i] *= k;
    if (g < deepest) deepest = g;
  }
  return 20 * Math.log10(deepest);
}
