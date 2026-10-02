import { describe, it, expect } from 'vitest';
import { TERRAINS, PATHS } from '../../src/dsp/catalog.js';
import { OrographDSP, HALFBAND, CTRL } from '../../src/dsp/dsp-core.js';
import { MOD_PARAM_IDS } from '../../src/core/params.js';
import { SR, makeDSP, render, rms, peak, allFinite, spectrum, terrainChain } from './helpers.js';

const T = Object.fromEntries(TERRAINS.map((t, i) => [t.id, i]));
const P = Object.fromEntries(PATHS.map((p, i) => [p.id, i]));
const on = (note, vel = 0.8, time = 0, part = 0) => ({ t: 'noteOn', part, note, vel, time });
const off = (note, time = 0, part = 0) => ({ t: 'noteOff', part, note, time });

function maxDelta(a, from, to) {
  let m = 0;
  for (let i = Math.max(1, from); i < to; i++) m = Math.max(m, Math.abs(a[i] - a[i - 1]));
  return m;
}

function firstAbove(a, thr) {
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > thr) return i;
  return -1;
}

/** Fraction of spectral power (dB) that is NOT at a harmonic of f0: aliasing for a periodic tone. */
function inharmonicDb(x, f0, start, N = 32768) {
  const mag = spectrum(x, start, N);
  const bin = SR / N;
  const mask = new Uint8Array(N / 2);
  for (let h = 1; h * f0 < SR / 2 + 10 * bin; h++) {
    const c = Math.round(h * f0 / bin);
    for (let k = c - 6; k <= c + 6; k++) if (k >= 0 && k < N / 2) mask[k] = 1;
  }
  let tot = 0, inh = 0;
  for (let k = 3; k < N / 2; k++) { const p = mag[k] * mag[k]; tot += p; if (!mask[k]) inh += p; }
  return 10 * Math.log10(inh / tot);
}

describe('engine basics', () => {
  it('is silent with no notes and when idle', () => {
    const dsp = makeDSP({ terrainA: T.swell });
    const r = render(dsp, 0.2);
    expect(peak(r.L)).toBe(0);
    expect(peak(r.DL)).toBe(0);
  });

  it('plays the built-in default terrain before any terrain message arrives', () => {
    const dsp = new OrographDSP(SR);
    dsp.handleMessage(on(57));
    const r = render(dsp, 0.3);
    expect(rms(r.L, 2000)).toBeGreaterThan(0.01);
  });

  it('renders non-silent, finite, bounded audio for every terrain on several paths', { timeout: 60000 }, () => {
    const shapes = [P.ellipse, P.lissa, P.scan, P.spiro, P.super, P.scribble];
    const report = [];
    for (const [id, ti] of Object.entries(T)) {
      if (id === 'user') continue;
      const levels = [];
      for (const s of shapes) {
        const dsp = makeDSP({ terrainA: ti, params: { pathShape: s, pathOrder: 3 } });
        dsp.handleMessage(on(52));
        const r = render(dsp, 0.25);
        expect(allFinite(r.L) && allFinite(r.R)).toBe(true);
        expect(peak(r.L)).toBeLessThanOrEqual(4);
        const level = rms(r.L, 1200);
        expect(level).toBeGreaterThan(2e-3);
        levels.push(level);
      }
      report.push(`${id.padEnd(8)} ${levels.map(l => (20 * Math.log10(l)).toFixed(1)).join(' ')}`);
    }
    console.log(`[dsp] RMS dBFS per terrain for ${shapes.map(s => PATHS[s].id).join(', ')}\n` + report.join('\n'));
  });

  it('releases to exact silence and frees the voice', () => {
    const dsp = makeDSP({ terrainA: T.massif, params: { release: 0.2 } });
    dsp.handleMessage(on(60));
    render(dsp, 0.3);
    expect(dsp.parts[0].activeCount()).toBe(1);
    dsp.handleMessage(off(60));
    const r = render(dsp, 0.5);
    expect(dsp.parts[0].activeCount()).toBe(0);
    // the 0.2 s release has finished (plus the decimator's few-sample tail)
    expect(peak(r.L, Math.round(0.25 * SR))).toBe(0);
    expect(rms(r.L, 0, 2000)).toBeGreaterThan(0.005);
  });

  it('does not click on attack, release or retrigger', () => {
    // sustain 1 so the steady state is as loud as the attack peak
    const dsp = makeDSP({ terrainA: T.swell, params: { filterType: 0, pathOrder: 1, sustain: 1 } });
    const r0 = render(dsp, 0.05);
    dsp.handleMessage(on(57, 1));
    const a = render(dsp, 0.6);
    dsp.handleMessage(on(57, 1)); // retrigger while sounding
    const b = render(dsp, 0.3);
    dsp.handleMessage(off(57));
    const c = render(dsp, 0.8);
    expect(peak(r0.L)).toBe(0);
    const steady = maxDelta(a.L, Math.round(0.3 * SR), Math.round(0.6 * SR));
    const attack = maxDelta(a.L, 0, Math.round(0.02 * SR));
    const retrig = maxDelta(b.L, 0, Math.round(0.02 * SR));
    const release = maxDelta(c.L, 0, Math.round(0.05 * SR));
    console.log(`[dsp] max |Δsample|: steady ${steady.toFixed(4)}, attack ${attack.toFixed(4)}, retrigger ${retrig.toFixed(4)}, release ${release.toFixed(4)}`);
    expect(steady).toBeGreaterThan(0);
    expect(attack).toBeLessThan(1.3 * steady);
    expect(retrig).toBeLessThan(1.3 * steady);
    expect(release).toBeLessThan(1.3 * steady);
  });

  it('does not thump at note-on when the orbit sits on high ground (DC blocker pre-initialised)', () => {
    const dsp = makeDSP({ terrainA: T.massif, params: { centerX: 0.8, centerY: 0.3, size: 0.05, filterType: 0, attack: 0.002 } });
    dsp.handleMessage(on(48, 1));
    const r = render(dsp, 0.3);
    const period = Math.round(SR / (440 * Math.pow(2, (48 - 69) / 12)));
    let worst = 0;
    for (let k = 1; k < 8; k++) {
      let s = 0;
      for (let i = k * period; i < (k + 1) * period; i++) s += r.L[i];
      worst = Math.max(worst, Math.abs(s / period));
    }
    expect(worst).toBeLessThan(0.05 * peak(r.L));
  });

  it('starts scheduled notes on the exact sample', () => {
    const onsets = [];
    for (const offset of [1000, 1037, 1500.4]) {
      const dsp = makeDSP({ terrainA: T.swell });
      dsp.handleMessage(on(60, 0.8, offset / SR));
      const r = render(dsp, 0.1);
      onsets.push(firstAbove(r.L, 1e-9));
    }
    // identical engine latency, so onsets differ exactly by the scheduled offsets
    expect(onsets[1] - onsets[0]).toBe(37);
    expect(onsets[2] - onsets[0]).toBe(500);
    // and the latency itself is the decimator's group delay, a handful of samples
    expect(onsets[0] - 1000).toBeGreaterThanOrEqual(-12);
    expect(onsets[0] - 1000).toBeLessThanOrEqual(1);
  });

  it('schedules note-offs sample-accurately too', () => {
    const dsp = makeDSP({ terrainA: T.swell, params: { release: 0.001 } });
    dsp.handleMessage(on(60, 0.8, 0));
    dsp.handleMessage(off(60, 4000 / SR));
    render(dsp, 4000 / SR - 1 / SR, null, 64);
    expect(dsp.parts[0].voices[0].gate).toBe(true);
    render(dsp, 2 / SR, null, 2);
    expect(dsp.parts[0].voices[0].gate).toBe(false);
  });
});

describe('voices', () => {
  it('steals the oldest held voice when all 8 are busy', () => {
    const dsp = makeDSP({ terrainA: T.swell });
    for (let i = 0; i < 8; i++) { dsp.handleMessage(on(60 + i)); render(dsp, 0.01); }
    expect(dsp.parts[0].activeCount()).toBe(8);
    dsp.handleMessage(on(72));
    render(dsp, 0.02);
    const notes = dsp.parts[0].voices.map(v => v.note).sort((a, b) => a - b);
    expect(notes).toEqual([61, 62, 63, 64, 65, 66, 67, 72]);
    expect(dsp.parts[0].activeCount()).toBe(8);
  });

  it('prefers stealing a released voice', () => {
    const dsp = makeDSP({ terrainA: T.swell, params: { release: 3 } });
    for (let i = 0; i < 8; i++) { dsp.handleMessage(on(60 + i)); render(dsp, 0.01); }
    dsp.handleMessage(off(64));
    render(dsp, 0.05);
    dsp.handleMessage(on(80));
    render(dsp, 0.02);
    const notes = dsp.parts[0].voices.map(v => v.note).sort((a, b) => a - b);
    expect(notes).toEqual([60, 61, 62, 63, 65, 66, 67, 80]);
  });

  it('frees a held voice once a sustain-0 envelope has died away', () => {
    const dsp = makeDSP({ terrainA: T.swell, params: { decay: 0.05, sustain: 0 } });
    dsp.handleMessage(on(60));
    render(dsp, 0.02);
    expect(dsp.parts[0].activeCount()).toBe(1);
    render(dsp, 0.3);
    expect(dsp.parts[0].activeCount()).toBe(0);
  });

  it('starts the pending note even if the stolen voice finishes its release first', () => {
    const dsp = makeDSP({ terrainA: T.swell, params: { release: 0.001 } });
    for (let i = 0; i < 8; i++) dsp.handleMessage(on(60 + i));
    render(dsp, 0.05);
    dsp.handleMessage(off(60));
    dsp.handleMessage(on(80));
    render(dsp, 0.05);
    expect(dsp.parts[0].voices.some(v => v.active && v.note === 80)).toBe(true);
  });

  it('steals without a click', () => {
    const dsp = makeDSP({ terrainA: T.swell, params: { filterType: 0, pathOrder: 1, unison: 1 } });
    for (let i = 0; i < 8; i++) dsp.handleMessage(on(48 + i * 3, 0.5));
    const a = render(dsp, 0.5);
    dsp.handleMessage(on(50, 0.5));
    const b = render(dsp, 0.1);
    const steady = maxDelta(a.L, Math.round(0.2 * SR), Math.round(0.5 * SR));
    const steal = maxDelta(b.L, 0, Math.round(0.02 * SR));
    expect(steal).toBeLessThan(1.3 * steady);
  });

  it('mono legato glides without retriggering', () => {
    const dsp = makeDSP({ terrainA: T.swell, params: { polyMode: 2, glide: 0.2 } });
    const v = dsp.parts[0].voices[0];
    dsp.handleMessage(on(60));
    render(dsp, 0.3);
    const lvlBefore = v.envLvl;
    expect(v.envStage).toBe(2); // decay/sustain
    dsp.handleMessage(on(72));
    render(dsp, 0.03);
    expect(v.envStage).toBe(2); // not retriggered
    expect(Math.abs(v.envLvl - lvlBefore)).toBeLessThan(0.1);
    expect(v.pitch).toBeGreaterThan(60.5);
    expect(v.pitch).toBeLessThan(71);
    render(dsp, 0.5);
    expect(v.pitch).toBeCloseTo(72, 1);
    expect(dsp.parts[0].activeCount()).toBe(1);
    // releasing the top note falls back to the held one
    dsp.handleMessage(off(72));
    render(dsp, 0.5);
    expect(v.note).toBe(60);
    expect(v.gate).toBe(true);
    expect(v.pitch).toBeCloseTo(60, 1);
    dsp.handleMessage(off(60));
    render(dsp, 1);
    expect(dsp.parts[0].activeCount()).toBe(0);
  });

  it('legato does not glide between detached notes; mono retriggers and always glides', () => {
    const dsp = makeDSP({ terrainA: T.swell, params: { polyMode: 2, glide: 0.3, release: 2 } });
    const v = dsp.parts[0].voices[0];
    dsp.handleMessage(on(60)); render(dsp, 0.2);
    dsp.handleMessage(off(60)); render(dsp, 0.05);
    dsp.handleMessage(on(67)); render(dsp, 0.01);
    expect(v.pitch).toBe(67);
    const mono = makeDSP({ terrainA: T.swell, params: { polyMode: 1, glide: 0.3 } });
    const w = mono.parts[0].voices[0];
    mono.handleMessage(on(60)); render(mono, 0.3);
    expect(w.envLvl).toBeLessThan(0.8); // settled on the 0.75 sustain
    mono.handleMessage(on(67)); render(mono, 0.003);
    expect(w.envLvl).toBeGreaterThan(0.95); // attack again
    expect(w.pitch).toBeLessThan(66);
  });

  it('applies pitch: octave, tune, fine, bend and unison detune', () => {
    const dsp = makeDSP({ terrainA: T.swell, params: { octave: 1, tune: 2, fine: 50, bendRange: 2 } });
    dsp.handleMessage(on(57));
    dsp.handleMessage({ t: 'bend', part: 0, v: 1 });
    render(dsp, 0.1);
    const v = dsp.parts[0].voices[0];
    const f = v.inc[0] * SR * 2;
    // 57 + 12 (octave) + 2 (tune) + 0.5 (fine) + 2 (bend) = 73.5
    expect(f).toBeCloseTo(440 * Math.pow(2, (73.5 - 69) / 12), 3);
    // unison 2 with 20 ct detune: ±10 ct
    dsp.handleMessage({ t: 'params', part: 0, p: { unison: 2, detune: 20 } });
    render(dsp, 0.05);
    expect(v.inc[1] / v.inc[0]).toBeCloseTo(Math.pow(2, 20 / 1200), 9);
  });

  it('unison spreads voices in stereo', () => {
    const mono = makeDSP({ terrainA: T.massif, params: { unison: 1 } });
    mono.handleMessage(on(55));
    const a = render(mono, 0.3);
    let d = 0;
    for (let i = 0; i < a.L.length; i++) d = Math.max(d, Math.abs(a.L[i] - a.R[i]));
    expect(d).toBe(0);
    const wide = makeDSP({ terrainA: T.massif, params: { unison: 3, detune: 20, spread: 1 } });
    wide.handleMessage(on(55));
    const b = render(wide, 0.3);
    let dot = 0, nl = 0, nr = 0;
    for (let i = 3000; i < b.L.length; i++) { dot += b.L[i] * b.R[i]; nl += b.L[i] ** 2; nr += b.R[i] ** 2; }
    expect(dot / Math.sqrt(nl * nr)).toBeLessThan(0.95);
  });
});

describe('modulation and telemetry', () => {
  function collect(dsp, seconds) {
    const tele = [];
    dsp.postMessage = (m) => tele.push(m);
    render(dsp, seconds);
    return tele;
  }

  it('posts telemetry ~60 times per second with the contract shape', () => {
    const dsp = makeDSP({ terrainA: T.swell });
    dsp.handleMessage(on(60));
    const tele = collect(dsp, 1);
    expect(tele.length).toBeGreaterThanOrEqual(58);
    expect(tele.length).toBeLessThanOrEqual(62);
    const m = tele[tele.length - 1];
    expect(m.t).toBe('tele');
    expect(m.part).toBe(0);
    expect(Object.keys(m.n).sort()).toEqual([...MOD_PARAM_IDS].sort());
    expect(m.voices).toHaveLength(1);
    expect(m.voices[0].note).toBe(60);
    expect(m.voices[0].amp).toBeGreaterThan(0.1);
    expect(m.peak[0]).toBeGreaterThan(0);
    expect(m.activeVoices).toEqual([1, 0, 0, 0]);
    expect(m.spinPhase).toBeGreaterThanOrEqual(0);
  });

  it('LFOs move the telemetry values, also while idle', () => {
    const dsp = makeDSP({ terrainA: T.swell, mods: { size: { lfoDepth: 0.3, lfoRate: 4 }, rotate: { lfoDepth: 0.2, lfoRate: 3, lfoShape: 1 } }, params: { rotate: 350 } });
    const idle = collect(dsp, 1);
    const sizes = idle.map(m => m.n.size);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeGreaterThan(0.5);
    // rotate wraps instead of clamping: values on both sides of the 0/1 seam
    const rots = idle.map(m => m.n.rotate);
    expect(rots.every(r => r >= 0 && r < 1)).toBe(true);
    expect(rots.some(r => r < 0.2)).toBe(true);
    expect(rots.some(r => r > 0.8)).toBe(true);
  });

  it('Envelope 2 depth modulates per voice and shows in telemetry', () => {
    const dsp = makeDSP({ terrainA: T.swell, mods: { cutoff: { envDepth: -0.5 } }, params: { env2Attack: 0.001, env2Decay: 0.3, env2Sustain: 0 } });
    dsp.handleMessage(on(60));
    const tele = collect(dsp, 1);
    const cut = tele.map(m => m.n.cutoff);
    const base = dsp.parts[0].baseNorm[MOD_PARAM_IDS.indexOf('cutoff')];
    expect(Math.min(...cut.slice(0, 5))).toBeLessThan(base - 0.3);
    expect(cut[cut.length - 1]).toBeCloseTo(base, 2);
  });

  it('tempo-synced LFOs follow the tempo and the transport anchor', () => {
    const dsp = makeDSP({ terrainA: T.swell, mods: { morph: { lfoDepth: 0.5, lfoSync: 1, lfoDiv: 5, lfoShape: 2 } } });
    dsp.handleMessage({ t: 'global', p: { tempo: 120 } });
    dsp.handleMessage({ t: 'transport', playing: true, beatTime: 0, beat: 0 });
    const tele = collect(dsp, 2);
    // 1/4 at 120 bpm = 2 Hz saw: count wraps (big downward jumps)
    let wraps = 0;
    for (let i = 1; i < tele.length; i++) if (tele[i].n.morph < tele[i - 1].n.morph - 0.2) wraps++;
    expect(wraps).toBeGreaterThanOrEqual(3);
    expect(wraps).toBeLessThanOrEqual(4);
  });

  it('mod wheel adds to morph', () => {
    const dsp = makeDSP({ terrainA: T.swell });
    dsp.handleMessage({ t: 'wheel', part: 0, v: 0.6 });
    const tele = collect(dsp, 0.1);
    expect(tele[tele.length - 1].n.morph).toBeCloseTo(0.6, 5);
  });

  it('every LFO shape stays bipolar within depth', () => {
    for (let shape = 0; shape < 6; shape++) {
      const dsp = makeDSP({ terrainA: T.swell, params: { pan: 0 }, mods: { pan: { lfoDepth: 0.25, lfoRate: 7, lfoShape: shape } } });
      const v = collect(dsp, 1).map(m => m.n.pan);
      expect(Math.min(...v)).toBeGreaterThanOrEqual(0.25 - 1e-9);
      expect(Math.max(...v)).toBeLessThanOrEqual(0.75 + 1e-9);
      expect(Math.max(...v) - Math.min(...v)).toBeGreaterThan(0.15);
    }
  });
});

describe('mixer, filter and safety', () => {
  it('routes sends, mute and solo', () => {
    const dsp = makeDSP({ terrainA: T.massif, params: { delaySend: 0.5, reverbSend: 0.25 } });
    dsp.handleMessage(on(60));
    const r = render(dsp, 0.3);
    const dry = rms(r.L, 6000), dl = rms(r.DL, 6000), rv = rms(r.VL, 6000);
    expect(dl / dry).toBeCloseTo(0.5, 2);
    expect(rv / dry).toBeCloseTo(0.25, 2);
    dsp.handleMessage({ t: 'params', part: 0, p: { mute: 1 } });
    const m = render(dsp, 0.2);
    expect(peak(m.L, 2000)).toBe(0);
    dsp.handleMessage({ t: 'params', part: 0, p: { mute: 0 } });
    dsp.handleMessage({ t: 'params', part: 1, p: { solo: 1 } });
    const s = render(dsp, 0.2);
    expect(peak(s.L, 2000)).toBe(0);
  });

  it('pans with equal power', () => {
    const dsp = makeDSP({ terrainA: T.massif, params: { pan: -1 } });
    dsp.handleMessage(on(60));
    const r = render(dsp, 0.3);
    expect(rms(r.R, 3000)).toBeLessThan(1e-6);
    expect(rms(r.L, 3000)).toBeGreaterThan(0.01);
  });

  it('the low-pass filter darkens and resonance stays bounded', () => {
    const hf = (cutoff, res = 0.1) => {
      const dsp = makeDSP({ terrainA: T.ridge, params: { cutoff, resonance: res, filterEnv: 0, keyTrack: 0, size: 0.45 } });
      dsp.handleMessage(on(48));
      const r = render(dsp, 0.5);
      expect(allFinite(r.L)).toBe(true);
      const mag = spectrum(r.L, 8000, 8192);
      let lo = 0, hi = 0;
      for (let k = 1; k < 4096; k++) { if (k * SR / 8192 < 1000) lo += mag[k] ** 2; else hi += mag[k] ** 2; }
      return { ratio: hi / lo, peak: peak(r.L) };
    };
    const open = hf(18000), closed = hf(300);
    expect(closed.ratio).toBeLessThan(open.ratio * 0.05);
    const screaming = hf(2000, 1);
    expect(screaming.peak).toBeLessThanOrEqual(4);
  });

  it('every filter type and the folder/drive render finite audio', () => {
    for (let ft = 0; ft < 5; ft++) {
      const dsp = makeDSP({ terrainA: T.cells, terrainB: T.fm, params: { filterType: ft, morph: 0.5, warp: 0.7, lift: 3, fold: 0.8, drive: 0.7, resonance: 0.9 } });
      dsp.handleMessage(on(64));
      const r = render(dsp, 0.2);
      expect(allFinite(r.L) && allFinite(r.R)).toBe(true);
      expect(rms(r.L, 1000)).toBeGreaterThan(1e-4);
    }
  });

  it('Lift 1 / Fold 0 is clean; Fold adds upper harmonics', () => {
    const bright = (fold) => {
      const dsp = makeDSP({ terrainA: T.swell, params: { filterType: 0, fold, pathOrder: 1 } });
      dsp.handleMessage(on(48, 1));
      const r = render(dsp, 0.5);
      const mag = spectrum(r.L, 8000, 8192);
      let lo = 0, hi = 0;
      for (let k = 1; k < 4096; k++) { if (k * SR / 8192 < 2000) lo += mag[k] ** 2; else hi += mag[k] ** 2; }
      return hi / lo;
    };
    expect(bright(0.8)).toBeGreaterThan(bright(0) * 10);
  });

  it('never exceeds ±4 and never outputs NaN, even when abused', () => {
    const dsp = new OrographDSP(SR);
    const bad = new Float32Array(32 * 32).fill(NaN);
    for (let p = 0; p < 4; p++) {
      dsp.handleMessage({ t: 'params', part: p, p: { level: 1, lift: 4, fold: 1, resonance: 1, unison: 4, drive: 1, filterType: 1, cutoff: 3000 } });
      for (let i = 0; i < 8; i++) dsp.handleMessage(on(36 + i * 7 + p, 1, 0, p));
    }
    dsp.handleMessage({ t: 'terrain', part: 2, slot: 0, levels: [{ size: 32, data: bad }] });
    dsp.handleMessage({ t: 'params', part: 0, p: { cutoff: NaN, size: Infinity } });
    const r = render(dsp, 0.5);
    expect(allFinite(r.L) && allFinite(r.R) && allFinite(r.DL) && allFinite(r.VL)).toBe(true);
    expect(peak(r.L)).toBeLessThanOrEqual(4);
    expect(peak(r.R)).toBeLessThanOrEqual(4);
  });

  it('allOff releases and panic silences immediately', () => {
    const dsp = makeDSP({ terrainA: T.swell, params: { release: 0.5 } });
    for (let i = 0; i < 4; i++) dsp.handleMessage(on(60 + i));
    dsp.handleMessage(on(70, 0.8, 10));          // far-future note, cancelled by allOff
    render(dsp, 0.1);
    dsp.handleMessage({ t: 'allOff', part: 0 });
    expect(dsp.parts[0].voices.every(v => !v.gate)).toBe(true);
    expect(dsp.events.length).toBe(0);
    const r = render(dsp, 0.1);
    expect(rms(r.L)).toBeGreaterThan(0.001); // still releasing
    dsp.handleMessage({ t: 'panic' });
    const s = render(dsp, 0.05);
    expect(peak(s.L)).toBe(0);
    expect(dsp.parts[0].activeCount()).toBe(0);
  });

  it('crossfades instead of clicking when a terrain arrives mid-note', () => {
    const dsp = makeDSP({ terrainA: T.swell, params: { filterType: 0, pathOrder: 1 } });
    dsp.handleMessage(on(57, 1));
    const a = render(dsp, 0.4);
    dsp.handleMessage({ t: 'terrain', part: 0, slot: 0, levels: terrainChain(T.massif) });
    const b = render(dsp, 0.2);
    const steadyA = maxDelta(a.L, Math.round(0.2 * SR), Math.round(0.4 * SR));
    const steadyB = maxDelta(b.L, Math.round(0.1 * SR), Math.round(0.2 * SR));
    const swap = maxDelta(b.L, 0, Math.round(0.05 * SR));
    expect(swap).toBeLessThan(1.3 * Math.max(steadyA, steadyB));
  });

  it('half-band decimator has >= 60 dB stopband', () => {
    let worst = -Infinity, pass = 0;
    for (let i = 0; i <= 1000; i++) {
      const f = i / 1000 * 0.5; // cycles per oversampled sample
      let re = 0, im = 0;
      for (let n = 0; n < HALFBAND.length; n++) { re += HALFBAND[n] * Math.cos(2 * Math.PI * f * n); im -= HALFBAND[n] * Math.sin(2 * Math.PI * f * n); }
      const db = 20 * Math.log10(Math.hypot(re, im) + 1e-300);
      if (f >= 0.29) worst = Math.max(worst, db);
      if (f <= 0.2) pass = Math.max(pass, Math.abs(db));
    }
    console.log(`[dsp] decimator: stopband (>= 0.29 fs2) worst ${worst.toFixed(1)} dB, passband (<= 0.2 fs2) ripple ${pass.toFixed(3)} dB`);
    expect(worst).toBeLessThan(-60);
    expect(pass).toBeLessThan(0.05);
  });
});

describe('aliasing', () => {
  it('mip-mapping keeps high notes clean (inharmonic energy, massif, size 0.4)', { timeout: 60000 }, () => {
    const tone = (note, mips) => {
      const dsp = makeDSP({ terrainA: T.massif, params: { filterType: 0, size: 0.4, pathOrder: 1, attack: 0.001, sustain: 1, velSens: 0 } });
      if (!mips) dsp.mipBias = -99;
      dsp.handleMessage(on(note, 1));
      const r = render(dsp, 1.0);
      return inharmonicDb(r.L, 440 * Math.pow(2, (note - 69) / 12), 8000);
    };
    const low = tone(48, true), high = tone(96, true), highRaw = tone(96, false);
    const mid = tone(84, true), midRaw = tone(84, false);
    console.log(`[dsp] inharmonic (aliased) energy: MIDI 48 ${low.toFixed(1)} dB | MIDI 84 ${mid.toFixed(1)} dB (no mips ${midRaw.toFixed(1)}) | MIDI 96 ${high.toFixed(1)} dB (no mips ${highRaw.toFixed(1)})`);
    expect(low).toBeLessThan(-50);
    expect(mid).toBeLessThan(-38);
    expect(high).toBeLessThan(-30);
    expect(high).toBeLessThan(highRaw - 10);
  });
});

describe('protocol robustness', () => {
  it('ignores malformed messages', () => {
    const dsp = new OrographDSP(SR);
    for (const m of [null, 1, 'x', {}, { t: 'nope' }, { t: 'params', part: 9, p: { level: 1 } }, { t: 'params', part: 0, p: null },
      { t: 'terrain', part: 0, slot: 0, levels: [{ size: 100, data: new Float32Array(10) }] }, { t: 'noteOn', part: 0, note: NaN },
      { t: 'mods', part: 0, m: { nope: {}, size: null } }, { t: 'watch', part: 7 }, { t: 'bend', part: 0, v: 'x' }]) {
      expect(() => dsp.handleMessage(m)).not.toThrow();
    }
    const r = render(dsp, 0.05);
    expect(allFinite(r.L)).toBe(true);
  });

  it('runs at other sample rates and odd block sizes', () => {
    for (const sr of [44100, 96000]) {
      const dsp = new OrographDSP(sr);
      dsp.handleMessage({ t: 'terrain', part: 0, slot: 0, levels: terrainChain(T.ripple) });
      dsp.handleMessage(on(69));
      const r = render(dsp, 0.2, null, 333);
      expect(allFinite(r.L)).toBe(true);
      expect(rms(r.L, 2000)).toBeGreaterThan(0.005);
    }
  });
});

describe('control block', () => {
  it('uses a 32-sample control rate', () => {
    expect(CTRL).toBe(32);
  });
});
