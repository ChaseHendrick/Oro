// Drum sound library (v2.8). Index 0..7 are the eight synth drums of 2.7
// (synthDrum, unchanged, so saved kits sound exactly as before); 8..127 are
// variants made by a handful of small generators (kick, snare, hats, clap,
// tom, rim and seven kinds of percussion). Every variant is computed from
// its index alone: the parameters come from a low-discrepancy sequence, the
// noise from a seeded generator. Nothing is recorded or shipped as audio.
//
// The audio engine renders a sound the first time a pad asks for it and
// keeps it (OroDSP.drumSound), so a kit message never renders it twice.

import { synthDrum, SYNTH_DRUMS, DRUM_LIBRARY_SIZE } from './drum-kit.js';

export const DRUM_CATEGORIES = ['Kick', 'Snare', 'Hat', 'Open hat', 'Clap', 'Tom', 'Rim', 'Perc'];
const ORIGINAL_CATS = [0, 1, 2, 3, 4, 5, 5, 6];
const PERC_KINDS = ['cowbell', 'shaker', 'conga', 'zap', 'block', 'cymbal', 'noise'];
const BASE_NAMES = {
  kick: 'Kick', snare: 'Snare', hat: 'Hat', ohat: 'Open hat', clap: 'Clap', tom: 'Tom', rim: 'Rim',
  cowbell: 'Cowbell', shaker: 'Shaker', conga: 'Conga', zap: 'Zap', block: 'Block', cymbal: 'Cymbal', noise: 'Noise',
};
// generated sounds per category, in library order after the eight originals
const BLOCKS = [['kick', 0, 18], ['snare', 1, 16], ['hat', 2, 14], ['ohat', 3, 10], ['clap', 4, 10], ['tom', 5, 14], ['rim', 6, 10], ['perc', 7, 28]];

// Additive recurrence with the generalised golden ratio for 8 dimensions
// (well spread for any count, no correlation between dimensions).
const R8 = [0.921599319634, 0.849345305950, 0.782756056098, 0.721387448739, 0.664830181950, 0.612707043358, 0.564670394293, 0.520399851198];
function params(k) {
  const u = new Array(8);
  for (let j = 0; j < 8; j++) { const x = 0.5 + k * R8[j]; u[j] = x - Math.floor(x); }
  return u;
}

function buildInfo() {
  const out = SYNTH_DRUMS.map((name, i) => ({ index: i, name, cat: ORIGINAL_CATS[i], kind: 'original', u: null }));
  const counts = {};
  for (const [kind, cat, n] of BLOCKS) {
    for (let j = 0; j < n; j++) {
      const k = kind === 'perc' ? PERC_KINDS[j % PERC_KINDS.length] : kind;
      counts[k] = (counts[k] || 0) + 1;
      // categories walk different stretches of the sequence
      const u = params(1 + j + cat * 37);
      out.push({ index: out.length, name: `${BASE_NAMES[k]} ${counts[k]}`, cat, kind: k, u });
    }
  }
  return out;
}

const INFO = buildInfo();
if (INFO.length !== DRUM_LIBRARY_SIZE) throw new Error('drum library size mismatch');

/** { index, name, cat (index into DRUM_CATEGORIES), kind } for library sound i, or null. */
export function libraryInfo(i) {
  const e = INFO[i];
  return e ? { index: e.index, name: e.name, cat: e.cat, kind: e.kind } : null;
}
export function libraryList() { return INFO.map((e) => ({ index: e.index, name: e.name, cat: e.cat, kind: e.kind })); }

// ---- small DSP helpers -----------------------------------------------------

function noiseGen(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296) * 2 - 1; };
}
function bandpass(fc, q, sr) {
  const w = 2 * Math.PI * Math.min(fc, sr * 0.45) / sr, al = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + al;
  const b0 = al / a0, b2 = -al / a0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => { const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
}
const TAU = 2 * Math.PI;
const METAL = [1, 1.3478, 1.6631, 1.9293, 2.5617, 3.1854];
const lenOf = (sec, sr) => Math.max(16, Math.round(sr * Math.min(1.5, sec)));

function finish(a, sr) {
  // fade the end (longer for sounds cut at the length limit), then peak 0.9
  const n = Math.min(a.length, Math.round(sr * Math.max(0.003, Math.min(0.06, a.length / sr * 0.08))));
  for (let i = 0; i < n; i++) a[a.length - 1 - i] *= i / n;
  let m = 0;
  for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > m) m = v; }
  if (m > 1e-9) { const g = 0.9 / m; for (let i = 0; i < a.length; i++) a[i] *= g; }
  return a;
}

// ---- generators (u: eight numbers in 0..1) ---------------------------------

// Envelopes are running products (e *= m per sample) instead of exp() calls,
// which keeps rendering cheap enough for the audio thread.
const GEN = {
  kick(u, sr, nz) {
    const fEnd = 40 + 30 * u[0], fStart = fEnd * (1.8 + 4.2 * u[1]), sweep = 14 + 46 * u[2];
    const dr = 3 + 11 * u[3], click = 0.06 + 0.5 * u[4], drive = 1 + 5 * u[5] * u[5], clickDr = 250 + 500 * u[6], clp = 0.15 + 0.7 * u[7];
    const out = new Float32Array(lenOf(6.9 / dr + 0.03, sr)), td = Math.tanh(drive);
    const mS = Math.exp(-sweep / sr), mA = Math.exp(-dr / sr), mC = Math.exp(-clickDr / sr);
    let ph = 0, cl = 0, eS = 1, eA = 1, eC = click;
    for (let n = 0; n < out.length; n++) {
      ph += (fEnd + (fStart - fEnd) * eS) / sr; cl += clp * (nz() - cl);
      out[n] = Math.tanh(drive * (Math.sin(TAU * ph) * eA + cl * eC)) / td;
      eS *= mS; eA *= mA; eC *= mC;
    }
    return out;
  },
  snare(u, sr, nz) {
    const fT = 150 + 130 * u[0], ratio = 1.4 + 0.5 * u[1], toneDr = 12 + 28 * u[2], noiseDr = 8 + 22 * u[3];
    const hpA = 0.45 + 0.45 * u[4], mix = 0.4 + 0.45 * u[5], lpC = 0.25 + 0.7 * u[6], snap = 0.6 * u[7];
    const out = new Float32Array(lenOf(6.9 / Math.min(toneDr, noiseDr) + 0.02, sr));
    const mB = Math.exp(-50 / sr), mT = Math.exp(-toneDr / sr), mN = Math.exp(-noiseDr / sr), mP = Math.exp(-200 / sr);
    let p1 = 0, p2 = 0, hp = 0, xl = 0, lp = 0, eB = 0.3, eT = 1, eN = 1, eP = snap;
    for (let n = 0; n < out.length; n++) {
      const fb = 1 + eB;
      p1 += fT * fb / sr; p2 += fT * ratio * fb / sr;
      const tone = (Math.sin(TAU * p1) + 0.45 * Math.sin(TAU * p2)) * eT;
      const x = nz(); hp = hpA * (hp + x - xl); xl = x; lp += lpC * (hp - lp);
      out[n] = (1 - mix) * tone + mix * 1.6 * lp * (eN + eP);
      eB *= mB; eT *= mT; eN *= mN; eP *= mP;
    }
    return out;
  },
  hat(u, sr, nz, open = false) {
    const base = 300 + 260 * u[0], metal = 0.25 + 0.7 * u[1];
    const dr = open ? 3.5 + 7 * u[2] : 28 + 60 * u[2], a = 0.35 + 0.45 * u[3], lpC = 0.5 + 0.5 * u[4], det = 0.06 * (u[5] - 0.5);
    const out = new Float32Array(lenOf(6.9 / dr + 0.02, sr));
    const inc = METAL.map((r, k) => base * r * (1 + det * k) / sr), ph = new Float64Array(6);
    const m = Math.exp(-dr / sr);
    let x1 = 0, h1 = 0, h1p = 0, h2 = 0, l = 0, e = 1;
    for (let n = 0; n < out.length; n++) {
      let sq = 0;
      for (let k = 0; k < 6; k++) { ph[k] += inc[k]; if (ph[k] >= 1) ph[k] -= 1; sq += ph[k] < 0.5 ? 1 : -1; }
      const x = metal * sq / 6 + (1 - metal) * nz();
      h1 = a * (h1 + x - x1); x1 = x; h2 = a * (h2 + h1 - h1p); h1p = h1; l += lpC * (h2 - l);
      out[n] = l * e; e *= m;
    }
    return out;
  },
  ohat(u, sr, nz) { return GEN.hat(u, sr, nz, true); },
  clap(u, sr, nz) {
    const bursts = 2 + Math.floor(u[0] * 3.999), gap = 0.006 + 0.009 * u[1], bp = bandpass(800 + 1700 * u[2], 0.8 + 2.4 * u[3], sr);
    const tailDr = 9 + 20 * u[4], tailLvl = 0.5 + 0.5 * u[5], burstDr = 180 + 220 * u[6], ts = (bursts - 1) * gap;
    const out = new Float32Array(lenOf(ts + 6.9 / tailDr + 0.02, sr));
    const mB = Math.exp(-burstDr / sr), mT = Math.exp(-tailDr / sr), gapN = Math.max(1, Math.round(gap * sr)), tsN = (bursts - 1) * gapN;
    let eB = 1, eT = tailLvl;
    for (let n = 0; n < out.length; n++) {
      if (n > 0 && n <= tsN && n % gapN === 0) eB = 1;
      out[n] = bp(nz()) * Math.max(eB, n >= tsN ? eT : 0);
      eB *= mB; if (n >= tsN) eT *= mT;
    }
    return out;
  },
  tom(u, sr, nz) {
    const f0 = 65 + 260 * u[0] * u[0], bend = 0.15 + 0.85 * u[1], bendRate = 15 + 35 * u[2], dr = 4 + 9 * u[3];
    const over = 0.08 + 0.35 * u[4], skin = 0.04 + 0.3 * u[5], sk = bandpass(f0 * 5, 1.2, sr);
    const out = new Float32Array(lenOf(6.9 / dr + 0.02, sr));
    const mB = Math.exp(-bendRate / sr), m1 = Math.exp(-dr / sr), m2 = Math.exp(-dr * 2.2 / sr), mS = Math.exp(-70 / sr);
    let p1 = 0, p2 = 0, eB = bend, e1 = 1, e2 = over, eS = skin * 3;
    for (let n = 0; n < out.length; n++) {
      const f = f0 * (1 + eB);
      p1 += f / sr; p2 += f * 1.59 / sr;
      out[n] = Math.sin(TAU * p1) * e1 + Math.sin(TAU * p2) * e2 + sk(nz()) * eS;
      eB *= mB; e1 *= m1; e2 *= m2; eS *= mS;
    }
    return out;
  },
  rim(u, sr, nz) {
    const f1 = 650 + 1500 * u[0], f2 = f1 * (1.3 + u[1]), dr = 45 + 90 * u[2], click = 0.2 + 0.6 * u[3], wood = 0.6 * u[4], fw = 280 + 200 * u[5];
    const out = new Float32Array(lenOf(6.9 / dr + 0.015, sr));
    const m1 = Math.exp(-dr / sr), m2 = Math.exp(-dr * 0.6 / sr), mC = Math.exp(-700 / sr);
    let p1 = 0, p2 = 0, p3 = 0, e1 = 1, e2 = wood, eC = click;
    for (let n = 0; n < out.length; n++) {
      p1 += f1 / sr; p2 += f2 / sr; p3 += fw / sr;
      out[n] = (0.55 * Math.sin(TAU * p1) + 0.35 * Math.sin(TAU * p2)) * e1 + Math.sin(TAU * p3) * e2 + nz() * eC;
      e1 *= m1; e2 *= m2; eC *= mC;
    }
    return out;
  },
  cowbell(u, sr) {
    const f = 480 + 260 * u[0], f2 = f * (1.45 + 0.12 * u[1]), bp = bandpass(f * 1.6, 2.5, sr), d1 = 35 + 30 * u[2], d2 = 5 + 8 * u[3];
    const out = new Float32Array(lenOf(6.9 / d2, sr));
    const m1 = Math.exp(-d1 / sr), m2 = Math.exp(-d2 / sr);
    let p1 = 0, p2 = 0, e1 = 0.65, e2 = 0.35;
    for (let n = 0; n < out.length; n++) {
      p1 += f / sr; p2 += f2 / sr; if (p1 >= 1) p1 -= 1; if (p2 >= 1) p2 -= 1;
      out[n] = bp((p1 < 0.5 ? 1 : -1) + (p2 < 0.5 ? 1 : -1)) * (e1 + e2);
      e1 *= m1; e2 *= m2;
    }
    return out;
  },
  shaker(u, sr, nz) {
    const att = 0.008 + 0.03 * u[0], dr = 14 + 30 * u[1], a = 0.3 + 0.4 * u[2];
    const out = new Float32Array(lenOf(att + 6.9 / dr, sr));
    const attN = Math.max(1, Math.round(att * sr)), m = Math.exp(-dr / sr);
    let x1 = 0, hp = 0, e = 1;
    for (let n = 0; n < out.length; n++) {
      const x = nz();
      hp = a * (hp + x - x1); x1 = x;
      if (n < attN) out[n] = hp * (n / attN) * (n / attN); else { out[n] = hp * e; e *= m; }
    }
    return out;
  },
  conga(u, sr, nz) {
    const f = 170 + 280 * u[0], bend = 0.05 + 0.25 * u[1], dr = 8 + 12 * u[2], slap = 0.1 + 0.5 * u[3], bp = bandpass(2500, 1.5, sr);
    const out = new Float32Array(lenOf(6.9 / dr, sr));
    const mB = Math.exp(-40 / sr), mA = Math.exp(-dr / sr), mS = Math.exp(-90 / sr);
    let ph = 0, eB = bend, eA = 1, eS = slap * 2;
    for (let n = 0; n < out.length; n++) {
      ph += f * (1 + eB) / sr;
      out[n] = Math.sin(TAU * ph) * eA + bp(nz()) * eS;
      eB *= mB; eA *= mA; eS *= mS;
    }
    return out;
  },
  zap(u, sr) {
    const top = 1500 + 3500 * u[0], low = 50 + 120 * u[1], sweep = 20 + 60 * u[2], dr = 7 + 18 * u[3];
    const out = new Float32Array(lenOf(6.9 / dr, sr));
    const mS = Math.exp(-sweep / sr), mA = Math.exp(-dr / sr);
    let ph = 0, eS = top - low, eA = 1;
    for (let n = 0; n < out.length; n++) {
      ph += (low + eS) / sr;
      out[n] = Math.sin(TAU * ph) * eA;
      eS *= mS; eA *= mA;
    }
    return out;
  },
  block(u, sr, nz) {
    const fc = 550 + 1400 * u[0], q = 10 + 30 * u[1], bp1 = bandpass(fc, q, sr), bp2 = bandpass(fc * (2.1 + 0.6 * u[2]), q * 0.6, sr);
    const out = new Float32Array(lenOf(6.9 * q / (Math.PI * fc) + 0.02, sr));
    const m = Math.exp(-1500 / sr);
    let e = 0.2;
    for (let n = 0; n < out.length; n++) {
      const x = (n < 2 ? 1 : 0) + nz() * e;
      out[n] = bp1(x) + 0.4 * bp2(x);
      e *= m;
    }
    return out;
  },
  cymbal(u, sr, nz) {
    const base = 360 + 300 * u[0], metal = 0.4 + 0.5 * u[1], dr = 1.6 + 2.8 * u[2], a = 0.4 + 0.3 * u[3];
    const out = new Float32Array(lenOf(6.9 / dr, sr));
    const inc = METAL.map((r) => base * r * 1.07 / sr), ph = new Float64Array(6);
    const m = Math.exp(-dr / sr), mA = Math.exp(-400 / sr);
    let x1 = 0, h1 = 0, h1p = 0, h2 = 0, e = 1, eA = 1;
    for (let n = 0; n < out.length; n++) {
      let sq = 0;
      for (let k = 0; k < 6; k++) { ph[k] += inc[k]; if (ph[k] >= 1) ph[k] -= 1; sq += ph[k] < 0.5 ? 1 : -1; }
      const x = metal * sq / 6 + (1 - metal) * nz();
      h1 = a * (h1 + x - x1); x1 = x; h2 = a * (h2 + h1 - h1p); h1p = h1;
      out[n] = h2 * e * (1 - eA);
      e *= m; eA *= mA;
    }
    return out;
  },
  noise(u, sr, nz) {
    const c0 = 0.05 + 0.6 * u[0], dr = 6 + 18 * u[1], sweep = 3 + 25 * u[2];
    const out = new Float32Array(lenOf(6.9 / dr, sr));
    const mS = Math.exp(-sweep / sr), mA = Math.exp(-dr / sr);
    let lp = 0, lp2 = 0, eS = c0, eA = 1;
    for (let n = 0; n < out.length; n++) {
      const c = Math.min(0.95, eS + 0.02);
      lp += c * (nz() - lp); lp2 += c * (lp - lp2);
      out[n] = lp2 * eA;
      eS *= mS; eA *= mA;
    }
    return out;
  },
};

/** Render library sound i at rate sr into a new Float32Array (no caching), or null when out of range. */
export function renderLibraryDrum(i, sr = 48000) {
  if (!Number.isInteger(i) || i < 0 || i >= DRUM_LIBRARY_SIZE) return null;
  if (i < SYNTH_DRUMS.length) return synthDrum(i, sr);
  const e = INFO[i];
  return finish(GEN[e.kind](e.u, sr, noiseGen(0x7f4a + i * 7919)), sr);
}
