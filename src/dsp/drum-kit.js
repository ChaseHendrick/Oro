// Drum kits (v2.7): eight one-shot pads per track. The default kit is
// synthesized here (no recorded samples), and any recording can be sliced at
// its transients into a kit, the way a phone recording of tapping on a desk
// becomes drums.
//
// KitPlayer runs in the audio engine at the host rate. MIDI notes 36..43 (C2..G2
// play pads 1..8; other notes wrap onto the pads.
//
// v2.8: a pad's `synth` indexes the drum library (src/dsp/drum-library.js).
// Indices 0..7 are exactly the eight SYNTH_DRUMS below; the rest are
// generated from their index, so a saved index always gives the same sound.

export const KIT_PADS = 8;
export const KIT_BASE_NOTE = 36;
export const KIT_VOICES = 16;
export const SYNTH_DRUMS = ['Kick', 'Snare', 'Closed hat', 'Open hat', 'Clap', 'Low tom', 'High tom', 'Rim'];
/** v2.8 number of sounds in the drum library (SYNTH_DRUMS first, then generated variants). */
export const DRUM_LIBRARY_SIZE = 128;
/** v2.8 two extra player slots (after the eight pads) for auditioning sounds. */
const PREVIEW_SLOTS = 2;

/** Deterministic noise in -1..1. */
function noiseGen(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
}

/** One synthesized drum (index into SYNTH_DRUMS) at sample rate sr. */
export function synthDrum(i, sr = 48000) {
  const len = Math.round(sr * [0.6, 0.35, 0.09, 0.45, 0.35, 0.5, 0.4, 0.08][i]);
  const out = new Float32Array(len);
  const nz = noiseGen(0x9e37 + i * 977);
  let ph = 0, lp = 0, hp = 0, bp1 = 0, bp2 = 0;
  for (let n = 0; n < len; n++) {
    const t = n / sr;
    let y = 0;
    switch (i) {
      case 0: { // kick: sine falling from 150 to 45 Hz, plus a click
        const f = 45 + 105 * Math.exp(-t * 28);
        ph += f / sr; y = Math.sin(2 * Math.PI * ph) * Math.exp(-t * 6.5) + 0.3 * nz() * Math.exp(-t * 400);
        break;
      }
      case 1: { // snare: body at 190 Hz plus bright noise
        ph += 190 / sr; const x = nz(); hp = 0.75 * (hp + x - lp); lp = x;
        y = 0.55 * Math.sin(2 * Math.PI * ph) * Math.exp(-t * 22) + 0.75 * hp * Math.exp(-t * 14);
        break;
      }
      case 2: case 3: { // hats: high-passed noise, closed short, open longer
        const x = nz(); hp = 0.55 * (hp + x - lp); lp = x;
        y = 0.6 * hp * Math.exp(-t * (i === 2 ? 55 : 7.5));
        break;
      }
      case 4: { // clap: three quick bursts then a tail of band-passed noise
        const x = nz(); bp1 += 0.35 * (x - bp1); bp2 += 0.35 * (bp1 - bp2); const b = bp1 - bp2;
        const burst = [0, 0.011, 0.022].some(o => t >= o && t < o + 0.008) ? 1 : 0;
        y = 1.6 * b * (burst ? 1 : Math.exp(-(t - 0.03) * 16) * (t > 0.03 ? 1 : 0));
        break;
      }
      case 5: case 6: { // toms: falling sine
        const f0 = i === 5 ? 110 : 180, f = f0 * (1 + 0.6 * Math.exp(-t * 30));
        ph += f / sr; y = 0.9 * Math.sin(2 * Math.PI * ph) * Math.exp(-t * (i === 5 ? 7 : 9));
        break;
      }
      default: { // rim: short high tone plus click
        ph += 1700 / sr; y = 0.5 * Math.sin(2 * Math.PI * ph) * Math.exp(-t * 90) + 0.4 * nz() * Math.exp(-t * 600);
      }
    }
    out[n] = y;
  }
  return normalise(fade(out, sr));
}

function fade(a, sr, ms = 3) {
  const n = Math.min(a.length, Math.round(sr * ms / 1000));
  for (let i = 0; i < n; i++) a[a.length - 1 - i] *= i / n;
  return a;
}

function normalise(a, peak = 0.9) {
  let m = 0;
  for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m) m = v; }
  if (m > 1e-9) { const g = peak / m; for (let i = 0; i < a.length; i++) a[i] *= g; }
  return a;
}

/**
 * Cut a mono recording at its transients into up to `max` hits. Onsets are
 * where a short energy envelope jumps well above a slower one; each slice
 * runs to the next onset (at most 1.5 s), gets a 2 ms fade-in, a 10 ms
 * fade-out and is normalised. Returns [{ data, start }] in time order.
 */
export function sliceTransients(mono, sr, max = KIT_PADS) {
  const hop = Math.max(1, Math.round(sr * 0.005));
  const frames = Math.floor(mono.length / hop);
  if (frames < 4) return [];
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0; const o = f * hop;
    for (let j = 0; j < hop; j++) { const v = mono[o + j]; e += v * v; }
    env[f] = Math.sqrt(e / hop);
  }
  let peak = 0; for (const e of env) if (e > peak) peak = e;
  if (peak < 1e-4) return [];
  const floor = peak * 0.06, minGap = Math.round(0.08 / 0.005);
  let slow = env[0];
  const cands = [];
  let last = -minGap;
  for (let f = 1; f < frames; f++) {
    slow += (env[f] - slow) * 0.08;
    const rise = env[f] - Math.max(env[f - 1], slow * 1.0);
    if (env[f] > floor && env[f] > slow * 1.8 && rise > 0 && f - last >= minGap) { cands.push({ f, s: env[f] - slow }); last = f; }
  }
  if (!cands.length) cands.push({ f: 0, s: 1 });
  // keep the strongest `max` onsets, in time order
  const keep = cands.sort((a, b) => b.s - a.s).slice(0, max).sort((a, b) => a.f - b.f);
  const out = [];
  for (let k = 0; k < keep.length; k++) {
    const start = Math.max(0, keep[k].f * hop - Math.round(sr * 0.003));
    const nextStart = k + 1 < keep.length ? keep[k + 1].f * hop - Math.round(sr * 0.003) : mono.length;
    const end = Math.min(nextStart, start + Math.round(sr * 1.5), mono.length);
    if (end - start < sr * 0.01) continue;
    const d = mono.slice(start, end);
    const fi = Math.min(d.length, Math.round(sr * 0.002));
    for (let i = 0; i < fi; i++) d[i] *= i / fi;
    out.push({ data: normalise(fade(d, sr, 10)), start });
  }
  return out;
}

/** Float32 -1..1 to a base64 string of 16-bit little-endian PCM, and back. */
export function pcmToBase64(data) {
  const b = new Uint8Array(data.length * 2);
  for (let i = 0; i < data.length; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767)));
    b[2 * i] = v & 255; b[2 * i + 1] = (v >> 8) & 255;
  }
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function base64ToPcm(str) {
  const s = atob(str), n = s.length >> 1, out = new Float32Array(n);
  for (let i = 0; i < n; i++) { let v = s.charCodeAt(2 * i) | (s.charCodeAt(2 * i + 1) << 8); if (v >= 32768) v -= 65536; out[i] = v / 32767; }
  return out;
}

/** Plays pads at the host rate: linear-interpolated sample playback with pitch, decay, level, pan and choke groups. */
export class KitPlayer {
  constructor(sr) {
    this.sr = sr;
    this.pads = Array.from({ length: KIT_PADS + PREVIEW_SLOTS }, () => ({ data: null, rate: sr, gain: 1, pitch: 0, decay: 1, pan: 0, choke: 0 }));
    this.voices = Array.from({ length: KIT_VOICES }, () => ({ on: false, pad: 0, pos: 0, inc: 1, g: 0, gl: 0, gr: 0, k: 1, age: 0 }));
    this.counter = 0;
    this.previewSlot = 0;
  }
  get busy() { return this.voices.some(v => v.on); }
  setPad(i, p) {
    const pad = this.pads[i];
    if (!pad || !p) return;
    if (p.data !== undefined) { pad.data = p.data; pad.rate = p.rate || this.sr; }
    for (const k of ['gain', 'pitch', 'decay', 'pan', 'choke']) if (Number.isFinite(p[k])) pad[k] = p[k];
  }
  /** Start a pad (note number wraps onto the eight pads) at velocity 0..1. */
  trigger(note, vel) {
    const i = (((note - KIT_BASE_NOTE) % KIT_PADS) + KIT_PADS) % KIT_PADS, pad = this.pads[i];
    if (!pad.data || !(vel > 0)) return;
    if (pad.choke > 0) for (const v of this.voices) if (v.on && this.pads[v.pad].choke === pad.choke) v.k = Math.min(v.k, Math.exp(-1 / (0.004 * this.sr)));
    let v = this.voices.find(x => !x.on);
    if (!v) v = this.voices.reduce((a, b) => (a.age < b.age ? a : b));
    const ang = (Math.max(-1, Math.min(1, pad.pan)) + 1) * Math.PI / 4;
    v.on = true; v.pad = i; v.pos = 0; v.age = ++this.counter;
    v.inc = pad.rate / this.sr * Math.pow(2, pad.pitch / 12);
    v.g = pad.gain * vel; v.gl = Math.cos(ang) * Math.SQRT2; v.gr = Math.sin(ang) * Math.SQRT2;
    // Decay 1 plays the whole sound; lower values fade it out sooner
    const len = pad.data.length / Math.max(1e-6, v.inc);
    v.k = pad.decay >= 0.999 ? 1 : Math.exp(-6.9 / Math.max(1, len * Math.max(0.02, pad.decay)));
  }
  /**
   * v2.8: play a sound that is not on a pad (the sound map's audition). It
   * uses one of two spare slots in turn; an earlier audition fades out in
   * about 4 ms, so moving across many sounds never piles them up.
   */
  preview(data, rate, vel = 0.9, gain = 0.8, pitch = 0) {
    if (!data || !data.length || !(vel > 0)) return;
    const fast = Math.exp(-1 / (0.004 * this.sr));
    this.previewSlot = (this.previewSlot + 1) % PREVIEW_SLOTS;
    const i = KIT_PADS + this.previewSlot;
    for (const v of this.voices) {
      if (!v.on || v.pad < KIT_PADS) continue;
      if (v.pad === i) v.on = false; else v.k = Math.min(v.k, fast);
    }
    const pad = this.pads[i];
    pad.data = data; pad.rate = rate || this.sr;
    let v = this.voices.find(x => !x.on);
    if (!v) v = this.voices.reduce((a, b) => (a.age < b.age ? a : b));
    v.on = true; v.pad = i; v.pos = 0; v.age = ++this.counter;
    v.inc = pad.rate / this.sr * Math.pow(2, (Number.isFinite(pitch) ? pitch : 0) / 12);
    v.g = (Number.isFinite(gain) ? gain : 0.8) * Math.min(1, vel); v.gl = 1; v.gr = 1; v.k = 1;
  }
  /** Add the sounding pads into L/R from `off` for `n` samples. */
  render(L, R, off, n) {
    for (const v of this.voices) {
      if (!v.on) continue;
      const d = this.pads[v.pad].data, last = d.length - 1;
      let pos = v.pos, g = v.g;
      const inc = v.inc, k = v.k, gl = v.gl, gr = v.gr;
      for (let j = off; j < off + n; j++) {
        const i0 = pos | 0;
        if (i0 >= last || g < 1e-5) { v.on = false; break; }
        const fr = pos - i0, s = (d[i0] + (d[i0 + 1] - d[i0]) * fr) * g;
        L[j] += s * gl; R[j] += s * gr;
        pos += inc; g *= k;
      }
      v.pos = pos; v.g = g;
    }
  }
}

// ---- saved data ----------------------------------------------------------
// part.drum = { on, pads: [8 x { name, synth (index into the drum library,
// 0..7 = SYNTH_DRUMS, -1 for a sample), sample: null | { rate, data (base64 16-bit PCM) }, pitch (st),
// decay (0..1), level (0..1), pan (-1..1), choke (0 none, 1..4) }] }
// pattern.drumLanes = 8 rows of SEQ_STEPS velocities (0 = off), absent until used.

export const KIT_SAMPLE_MAX_SECONDS = 2;

export function defaultDrum() {
  return { on: 0, pads: SYNTH_DRUMS.map((name, i) => ({ name, synth: i, sample: null, pitch: 0, decay: 1, level: 0.8, pan: 0, choke: i === 2 || i === 3 ? 1 : 0 })) };
}

const clampN = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function sanitizeDrum(src) {
  const base = defaultDrum();
  if (!src || typeof src !== 'object') return base;
  const pads = base.pads.map((b, i) => {
    const p = Array.isArray(src.pads) ? src.pads[i] : null;
    if (!p || typeof p !== 'object') return b;
    const sample = p.sample && typeof p.sample.data === 'string' && p.sample.data.length > 0
      && p.sample.data.length <= Math.ceil(KIT_SAMPLE_MAX_SECONDS * 96000 * 2 / 3) * 4 + 8
      ? { rate: clampN(p.sample.rate, 8000, 96000, 48000), data: p.sample.data } : null;
    return {
      name: typeof p.name === 'string' && p.name.trim() ? p.name.slice(0, 24) : b.name,
      synth: sample ? -1 : Math.round(clampN(p.synth, 0, DRUM_LIBRARY_SIZE - 1, b.synth)),
      sample,
      pitch: clampN(p.pitch, -24, 24, 0), decay: clampN(p.decay, 0.02, 1, 1), level: clampN(p.level, 0, 1, 0.8),
      pan: clampN(p.pan, -1, 1, 0), choke: Math.round(clampN(p.choke, 0, 4, b.choke)),
    };
  });
  return { on: src.on ? 1 : 0, pads };
}

/** 8 rows of `steps` velocities, or null when absent or empty. */
export function sanitizeLanes(src, steps) {
  if (!Array.isArray(src)) return null;
  let any = false;
  const out = Array.from({ length: KIT_PADS }, (_, r) => Array.from({ length: steps }, (_, c) => {
    const v = clampN(Array.isArray(src[r]) ? src[r][c] : 0, 0, 1, 0);
    if (v > 0) any = true;
    return Math.round(v * 100) / 100;
  }));
  return any ? out : null;
}
