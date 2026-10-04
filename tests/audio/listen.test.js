// 2.12 listening modes: the maths of each mode, the live stage's wiring
// (with a small fake Web Audio graph) and the per-computer preference.
import { describe, it, expect } from 'vitest';
import { renderListen, crossfeedGains, createListen, LISTEN_VALUES, CROSSFEED } from '../../src/audio/listen.js';
import { sanitizePrefs, PREF_DEFAULTS, UI_PREF_KEYS } from '../../src/ui/prefs.js';

const SR = 48000;
const tone = (hz, n = SR / 2, amp = 0.5) => Float64Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * hz * i / SR));
const noise = (n, seed) => { let s = seed >>> 0; return Float64Array.from({ length: n }, () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 31 - 1; }); };
const rms = (a, from = 0) => { let s = 0; for (let i = from; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / (a.length - from)); };
const db = (x) => 20 * Math.log10(x);

describe('Mono check', () => {
  it('a centred sound keeps its level (never louder), a hard-panned one is shared at half', () => {
    const x = tone(440);
    const c = renderListen('mono', x, x, SR);
    for (let i = 0; i < x.length; i++) { expect(c.L[i]).toBe(x[i]); expect(c.R[i]).toBe(x[i]); }
    const z = new Float64Array(x.length);
    const hard = renderListen('mono', x, z, SR);
    expect(rms(hard.L)).toBeCloseTo(rms(x) / 2, 9);
    // uncorrelated left and right fall by 3 dB, as a real mono sum does
    const u = renderListen('mono', noise(SR, 1), noise(SR, 2), SR);
    expect(db(rms(u.L) / rms(noise(SR, 1)))).toBeCloseTo(-3, 0);
    // out of phase cancels
    const neg = x.map(v => -v);
    expect(rms(renderListen('mono', x, neg, SR).L)).toBe(0);
  });
});

describe('Headphones crossfeed', () => {
  it('direct and cross gains keep a centred low tone at unity and the treble at 1', () => {
    const g = crossfeedGains();
    expect(g.direct + g.cross).toBeCloseTo(1, 12);
    expect(g.direct * Math.pow(10, g.shelfDb / 20)).toBeCloseTo(1, 12);
    expect(db(g.cross)).toBeCloseTo(CROSSFEED.levelDb, 9);
  });

  it('is symmetric: swapping the inputs swaps the outputs', () => {
    const a = noise(SR / 4, 7), b = noise(SR / 4, 9);
    const p = renderListen('headphones', a, b, SR), q = renderListen('headphones', b, a, SR);
    for (let i = 0; i < a.length; i++) { expect(q.L[i]).toBeCloseTo(p.R[i], 12); expect(q.R[i]).toBeCloseTo(p.L[i], 12); }
  });

  it('a centred low tone stays within half a dB; a hard-left bass reaches the right ear quieter and late', () => {
    const x = tone(100);
    const c = renderListen('headphones', x, x, SR);
    expect(Math.abs(db(rms(c.L, 4800) / rms(x, 4800)))).toBeLessThan(0.5);
    const z = new Float64Array(x.length);
    const h = renderListen('headphones', x, z, SR);
    const right = db(rms(h.R, 4800) / rms(x, 4800)), left = db(rms(h.L, 4800) / rms(x, 4800));
    expect(right).toBeLessThan(left - 3);
    expect(right).toBeGreaterThan(-14);
    const d = Math.round(CROSSFEED.delayMs * SR / 1000);
    for (let i = 0; i < d; i++) expect(h.R[i]).toBe(0);
  });
});

describe('Swap and Small speaker', () => {
  it('Swap exchanges left and right exactly', () => {
    const a = noise(1000, 3), b = noise(1000, 4);
    const s = renderListen('swap', a, b, SR);
    for (let i = 0; i < a.length; i++) { expect(s.L[i]).toBe(b[i]); expect(s.R[i]).toBe(a[i]); }
  });
  it('Small speaker takes away the deep bass and keeps the middle', () => {
    const lo = tone(50), mid = tone(1500);
    const a = renderListen('small', lo, lo, SR), b = renderListen('small', mid, mid, SR);
    expect(db(rms(a.L, 4800) / rms(lo, 4800))).toBeLessThan(-20);
    expect(db(rms(b.L, 4800) / rms(mid, 4800))).toBeGreaterThan(-3);
  });
  it('Normal is the input unchanged', () => {
    const a = noise(500, 5), b = noise(500, 6);
    const n = renderListen('normal', a, b, SR);
    expect(Array.from(n.L)).toEqual(Array.from(a));
    expect(Array.from(n.R)).toEqual(Array.from(b));
  });
});

/** A tiny fake of the Web Audio nodes createListen uses: records connections and gains. */
function fakeCtx() {
  const edges = new Set();
  let id = 0;
  const param = (v) => ({ value: v, setValueAtTime(x) { this.value = x; }, linearRampToValueAtTime(x) { this.value = x; }, cancelScheduledValues() {}, setTargetAtTime(x) { this.value = x; } });
  const node = (kind, extra = {}) => {
    const n = { kind, id: id++, ...extra };
    n.connect = (dst, o = 0, i = 0) => { edges.add(`${n.id}:${o}>${dst.id}:${i}`); return dst; };
    n.disconnect = (dst) => { for (const e of [...edges]) if (e.startsWith(`${n.id}:`) && (!dst || e.includes(`>${dst.id}:`))) edges.delete(e); };
    return n;
  };
  return {
    edges, currentTime: 0,
    createGain: () => node('gain', { gain: param(1) }),
    createChannelSplitter: () => node('split'),
    createChannelMerger: () => node('merge'),
    createBiquadFilter: () => node('biquad', { frequency: param(350), Q: param(1), gain: param(0), type: 'lowpass' }),
    createDelay: () => node('delay', { delayTime: param(0) }),
    node,
  };
}

describe('the live stage', () => {
  it('Normal is input -> gain 1 -> output; other modes build their path and glide over', () => {
    const ctx = fakeCtx();
    const out = ctx.node('dest');
    const L = createListen(ctx, out, 'normal');
    expect(L.mode).toBe('normal');
    expect(L.input.gain.value).toBe(1);
    const toOut = [...ctx.edges].filter(e => e.endsWith(`>${out.id}:0`));
    expect(toOut).toHaveLength(1);
    expect(L.set('mono')).toBe('mono');
    expect(L.set('nonsense')).toBe('normal');
    for (const m of LISTEN_VALUES) expect(L.set(m)).toBe(m);
    L.dispose();
  });

  it('the preference is per computer, validated, Normal by default, and kept out of sessions', () => {
    expect(PREF_DEFAULTS.listenMode).toBe('normal');
    expect(PREF_DEFAULTS.liveSurround).toBe('off');
    expect(sanitizePrefs({ listenMode: 'mono', liveSurround: '5.1' })).toMatchObject({ listenMode: 'mono', liveSurround: '5.1' });
    expect(sanitizePrefs({ listenMode: 'loud', liveSurround: '9.1' })).toMatchObject({ listenMode: 'normal', liveSurround: 'off' });
    expect(UI_PREF_KEYS).toContain('listenMode');
  });
});
