// Tape controls on the looper: varispeed (pitch follows speed), reverse,
// scrub, once-per-index overdub, and a bit-identical rate +1 path.
import { describe, it, expect } from 'vitest';
import { LooperCore, sanitizeTapeSpeed } from '../../src/audio/looper-core.js';

const BLOCK = 128;

function rig(sr = 48000, opts = {}) {
  const msgs = [];
  const core = new LooperCore(sr, { emit: (m) => msgs.push(m), ...opts });
  let frame = 0;
  const outL = [];
  const api = {
    core, msgs, sr,
    get frame() { return frame; },
    send(m) { core.handle(m, frame); },
    run(n, input = () => 0, keep = true) {
      const blocks = Math.ceil(n / BLOCK);
      const iL = new Float32Array(BLOCK);
      const oL = new Float32Array(BLOCK);
      const oR = new Float32Array(BLOCK);
      for (let b = 0; b < blocks; b++) {
        for (let i = 0; i < BLOCK; i++) iL[i] = input(frame + i);
        core.process(iL, iL, oL, oR, BLOCK, frame);
        if (keep) for (let i = 0; i < BLOCK; i++) outL.push(oL[i]);
        frame += BLOCK;
      }
    },
    out: () => Float32Array.from(outL),
    clearOut() { outL.length = 0; },
  };
  return api;
}

/** Record `frames` (rounded up to blocks), close the loop, and let the play fade finish. */
function record(r, input, frames = 8192) {
  r.send({ t: 'main' });
  r.run(frames, input, false);
  r.send({ t: 'main' });
  r.run(r.core.fadeLen + BLOCK, () => 0, false);
  return r.core.len;
}

function untilRate(r, target, cap = 96000) {
  let n = 0;
  while (r.core.rate !== target && n < cap) { r.run(BLOCK, () => 0, false); n += BLOCK; }
  expect(r.core.rate).toBe(target);
}

/** Independent linear read, matching the tape head off unity. */
function lin(buf, pos, len) {
  let p = pos % len;
  if (p < 0) p += len;
  const i0 = Math.floor(p);
  const f = p - i0;
  if (f === 0) return buf[i0];
  const i1 = i0 + 1 >= len ? 0 : i0 + 1;
  return buf[i0] * (1 - f) + buf[i1] * f;
}

function peakOf(buf) {
  let m = 0;
  for (let i = 0; i < buf.length; i++) { const a = buf[i] < 0 ? -buf[i] : buf[i]; if (a > m) m = a; }
  return m;
}

describe('looper tape: unity stays an integer read', () => {
  it('rate 1 forward matches a direct integer read of the loop', () => {
    const r = rig();
    const len = record(r, (f) => Math.sin(f * 0.017));
    const L = Float32Array.from(r.core.L.subarray(0, len));
    // Explicit normal-forward tape must not leave the integer path.
    r.send({ t: 'tape', rate: 1, reverse: false, scrub: null });
    expect(r.core.rate).toBe(1);
    expect(r.core.frac).toBe(false);
    const p = r.core.pos;
    r.clearOut();
    r.run(512);
    const o = r.out();
    expect(o.length).toBe(512);
    for (let k = 0; k < o.length; k++) expect(o[k]).toBe(L[(p + k) % len]);
    expect(r.core.pos).toBe((p + 512) % len);
  });

  it('a speed glide back to normal returns to that same integer read', () => {
    const r = rig();
    const len = record(r, (f) => Math.sin(f * 0.013));
    const L = Float32Array.from(r.core.L.subarray(0, len));
    r.send({ t: 'tape', rate: 2 });
    untilRate(r, 2);
    r.send({ t: 'tape', rate: 1 });
    untilRate(r, 1);
    expect(r.core.frac).toBe(false);
    const p = r.core.pos;
    r.clearOut();
    r.run(256);
    const o = r.out();
    for (let k = 0; k < o.length; k++) expect(o[k]).toBe(L[(p + k) % len]);
  });
});

describe('looper tape: varispeed and reverse', () => {
  it('keeps half, normal and double exact, and a speed in between', () => {
    expect(sanitizeTapeSpeed(0.5)).toBe(0.5);
    expect(sanitizeTapeSpeed(1)).toBe(1);
    expect(sanitizeTapeSpeed(2)).toBe(2);
    expect(sanitizeTapeSpeed(1.25)).toBe(1.25);
    expect(sanitizeTapeSpeed(1.00005)).toBe(1);
    expect(sanitizeTapeSpeed(0)).toBe(0);
    expect(sanitizeTapeSpeed(4)).toBe(2);
    expect(sanitizeTapeSpeed(Number.NaN)).toBe(1);
  });

  it('a stop is silent and finite', () => {
    const r = rig();
    record(r, (f) => Math.sin(f * 0.05));
    r.send({ t: 'tape', rate: 0 });
    untilRate(r, 0);
    r.clearOut();
    r.run(128);
    expect(r.out().every((v) => v === 0)).toBe(true);
    expect(Number.isFinite(r.core.fpos)).toBe(true);
  });

  it('reverse plays samples backward, one integer step at a time', () => {
    const r = rig();
    const len = record(r, (f) => ((f % 997) - 498) / 500);
    const L = Float32Array.from(r.core.L.subarray(0, len));
    r.send({ t: 'tape', reverse: true });
    untilRate(r, -1);
    const p = r.core.pos;
    r.clearOut();
    r.run(300);
    const o = r.out();
    for (let k = 0; k < o.length; k++) {
      const idx = (p - k) % len;
      expect(o[k]).toBe(L[idx < 0 ? idx + len : idx]);
    }
  });

  it('half speed follows a linear read at 0.5 samples per frame', () => {
    const r = rig();
    const len = record(r, (f) => Math.sin(f * 0.05));
    const L = Float32Array.from(r.core.L.subarray(0, len));
    r.send({ t: 'tape', rate: 0.5 });
    untilRate(r, 0.5);
    const p0 = r.core.fpos;
    r.clearOut();
    r.run(128);
    const o = r.out();
    for (let k = 0; k < o.length; k++) expect(o[k]).toBeCloseTo(lin(L, p0 + 0.5 * k, len), 5);
    let delta = r.core.fpos - p0;
    if (delta < 0) delta += len;
    expect(delta).toBeCloseTo(64, 4);
  });

  it('double speed advances 2 samples per frame', () => {
    const r = rig();
    const len = record(r, (f) => Math.sin(f * 0.02));
    const L = Float32Array.from(r.core.L.subarray(0, len));
    r.send({ t: 'tape', rate: 2 });
    untilRate(r, 2);
    const p0 = r.core.fpos;
    r.clearOut();
    r.run(64);
    const o = r.out();
    for (let k = 0; k < o.length; k++) expect(o[k]).toBeCloseTo(lin(L, p0 + 2 * k, len), 5);
    let delta = r.core.fpos - p0;
    if (delta < 0) delta += len;
    expect(delta).toBeCloseTo(o.length * 2, 4);
  });
});

describe('looper tape: scrub', () => {
  it('moves the playhead toward the finger, and a fast move is quieter', () => {
    const r = rig();
    const len = record(r, () => 0.8);
    const start = r.core.pos;
    // A finger move of about one scrub time-constant: level near full.
    const slowTarget = Math.min(len - 1, start + 960);
    r.send({ t: 'tape', scrub: slowTarget / len });
    r.clearOut();
    r.run(64);
    const slowPeak = peakOf(r.out());
    expect(Math.abs(r.core.fpos - slowTarget)).toBeLessThan(Math.abs(start - slowTarget));

    // Let that move settle, then flick across most of the loop.
    r.run(16000, () => 0, false);
    const mid = r.core.fpos;
    const fastTarget = mid < len * 0.5 ? len * 0.92 : len * 0.08;
    r.send({ t: 'tape', scrub: fastTarget / len });
    r.clearOut();
    r.run(64);
    const fastPeak = peakOf(r.out());
    expect(fastPeak).toBeLessThan(slowPeak * 0.5);
    const after = r.core.fpos;
    expect(Math.abs(after - fastTarget)).toBeLessThan(Math.abs(mid - fastTarget));

    // Held still, the strip is nearly silent.
    r.run(20000, () => 0, false);
    r.clearOut();
    r.run(256);
    expect(peakOf(r.out())).toBeLessThan(0.02);

    // Release resumes play at the new position, still at normal speed.
    r.send({ t: 'tape', scrub: null });
    expect(r.core.scrubbing).toBe(false);
    expect(r.core.state).toBe('play');
    const p = r.core.pos;
    r.run(128, () => 0, false);
    expect(r.core.pos).toBe((p + 128) % len);
    expect(r.core.rate).toBe(1);
  });
});

describe('looper tape: overdub once per index, and undo', () => {
  it('half speed does not stack the input, double speed does not skip', () => {
    const r = rig();
    const len = record(r, () => 0);
    r.send({ t: 'tape', rate: 0.5 });
    untilRate(r, 0.5);
    r.send({ t: 'main' });
    r.run(r.core.fadeLen + 512, () => 0, false);
    const p0 = r.core.fpos;
    const N = 2000;
    r.run(N, () => 0.5, false);
    let hot = 0, peak = 0;
    for (let k = 2; k < N * 0.5 - 2; k++) {
      const idx = Math.floor(p0 + k) % len;
      const v = r.core.L[idx];
      if (v > peak) peak = v;
      if (v > 0.2) hot++;
    }
    expect(hot).toBeGreaterThan(N * 0.4);
    expect(peak).toBeGreaterThan(0.4);
    expect(peak).toBeLessThan(0.75);

    const d = rig();
    record(d, () => 0, 48000);
    d.send({ t: 'tape', rate: 2 });
    untilRate(d, 2);
    d.send({ t: 'main' });
    d.run(d.core.fadeLen + 256, () => 0, false);
    const q0 = d.core.fpos;
    const M = 800;
    d.run(M, () => 0.4, false);
    let skipped = 0, dPeak = 0, written = 0;
    const travel = M * 2;
    for (let k = 4; k < travel - 4; k++) {
      const idx = Math.floor(q0 + k) % d.core.len;
      const v = d.core.L[idx];
      if (v > dPeak) dPeak = v;
      if (v < 0.05) skipped++;
      else written++;
    }
    expect(skipped).toBe(0);
    expect(written).toBeGreaterThan(travel * 0.8);
    expect(dPeak).toBeGreaterThan(0.3);
    expect(dPeak).toBeLessThan(0.7);
  });

  it('undo while reversed restores the audio and does not throw', () => {
    const r = rig();
    record(r, () => 0.2, 48000);
    const base = Float32Array.from(r.core.L.subarray(0, r.core.len));
    r.send({ t: 'tape', reverse: true });
    untilRate(r, -1);
    r.send({ t: 'main' });
    r.run(4000, () => 0.55, false);
    // The layer in progress was actually written somewhere behind the head.
    let changed = false;
    for (let i = 0; i < r.core.len; i++) if (Math.abs(r.core.L[i] - base[i]) > 0.05) { changed = true; break; }
    expect(changed).toBe(true);
    expect(() => r.send({ t: 'undo' })).not.toThrow();
    expect(Array.from(r.core.L.subarray(0, r.core.len))).toEqual(Array.from(base));
    r.clearOut();
    r.run(1024);
    expect(r.out().every(Number.isFinite)).toBe(true);
    expect(r.core.state).toBe('play');
  });
});

describe('looper tape: peak overview', () => {
  it('scans the loop in chunks and posts peaks', () => {
    const r = rig();
    record(r, (f) => (f % 100) / 100, 8192);
    expect(r.core.len).toBeGreaterThan(2048);
    // One block scans a chunk, not the whole loop.
    r.core.peakScanAt = 0;
    r.core.peakAcc.fill(0);
    r.run(BLOCK, () => 0, false);
    expect(r.core.peakScanAt).toBeGreaterThan(0);
    expect(r.core.peakScanAt).toBeLessThan(r.core.len);
    expect(r.core.peakScanAt).toBeLessThanOrEqual(2048);
    r.run(8000, () => 0, false);
    const peaks = r.msgs.filter(m => m.t === 'peaks');
    expect(peaks.length).toBeGreaterThan(0);
    expect(peaks[0].peaks.length).toBe(192);
    expect(peaks[0].len).toBe(r.core.len);
    let max = 0;
    for (const v of peaks[0].peaks) if (v > max) max = v;
    expect(max).toBeGreaterThan(0.2);
  });
});
