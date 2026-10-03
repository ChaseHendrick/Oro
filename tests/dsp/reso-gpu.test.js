import { describe, it, expect } from 'vitest';
import { Resonator } from '../../src/dsp/resonator.js';
import { ResoGpuPlan, JsMembrane, FRAME, BLOCK, GPU_DETAILS, pitchCeiling, gpuLatencySec } from '../../src/dsp/reso-gpu-plan.js';
import { WGSL_STEP, WGSL_RESUB, OUT_STRIDE } from '../../src/dsp/reso-gpu-kernel.js';
import { FloatRing } from '../../src/dsp/reso-ring.js';
import { UnderrunWatch, chooseEngine, UNDERRUN_LIMIT } from '../../src/dsp/reso-gpu-policy.js';
import { ResoFeed } from '../../src/dsp/reso-feed.js';

const SR = 48000;

function hills(size = 64) {
  const d = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    d[y * size + x] = 0.6 * Math.sin(2 * Math.PI * x / size) * Math.cos(4 * Math.PI * y / size) + 0.3 * Math.exp(-((x - 20) ** 2 + (y - 40) ** 2) / 60);
  }
  return { size, data: d };
}
const flat = (size = 64) => ({ size, data: new Float32Array(size * size) });

// frames for `count` samples: a strike at sample 0, then drive x(i)
function frames(count, { hz = 220, mode = 1, decay = 1.5, tone = 0.5, dot = [0.3, 0.4], drive = null } = {}) {
  const f = new Float32Array(count * FRAME);
  for (let i = 0; i < count; i++) {
    const o = i * FRAME;
    f[o] = drive ? drive(i) : 0; f[o + 1] = hz; f[o + 2] = dot[0]; f[o + 3] = dot[1];
    if (i === 0 && mode === 1) { f[o + 4] = 1; f[o + 5] = dot[0]; f[o + 6] = dot[1]; }
    f[o + 7] = mode; f[o + 8] = decay; f[o + 9] = tone; f[o + 10] = 0;
  }
  return f;
}

// the GPU path on the CPU: plan + kernel mirror, block by block -> stereo
function runGpuMirror(grid, terrain, fr, count) {
  const plan = new ResoGpuPlan(SR, grid);
  plan.terrain(terrain, null, 0);
  const mem = new JsMembrane(grid.n);
  mem.setStiffness(plan.stiffness);
  const out = new Float32Array(2 * count);
  for (let at = 0; at < count; at += BLOCK) {
    const len = Math.min(BLOCK, count - at);
    plan.plan(fr, at * FRAME, len);
    plan.finish(mem.run(plan), out, 2 * at);
  }
  return { out, plan, mem };
}

// the 2.10 CPU Resonator stepped by hand with the same input
function runCpu(quality, terrain, count, { hz = 220, mode = 1, decay = 1.5, tone = 0.5, dot = [0.3, 0.4], drive = null } = {}) {
  const R = new Resonator(SR, quality);
  R.configure(mode, 1, decay, tone, 1, 0);
  R.derive([terrain], null, 0);
  R.setNote(hz, true);
  R.setDot(dot[0], dot[1]);
  if (mode === 1) R.strike(dot[0], dot[1], 1);
  const out = new Float32Array(2 * count);
  for (let at = 0; at < count; at += 64) {
    R.control(Math.min(64, count - at) * R.D);
    for (let i = at; i < Math.min(count, at + 64); i++) { R.step(drive ? drive(i) : 0); out[2 * i] = R.hl[3]; out[2 * i + 1] = R.hr[3]; }
  }
  return out;
}

function relErr(a, b) {
  let d = 0, m = 0;
  for (let i = 0; i < a.length; i++) { d = Math.max(d, Math.abs(a[i] - b[i])); m = Math.max(m, Math.abs(b[i])); }
  return d / m;
}

// strongest frequency of x near f (Goertzel scan)
function peakNear(x, fs, f) {
  let best = 0, bf = 0;
  for (let q = 0.7 * f; q <= 1.3 * f; q += 0.002 * f) {
    const w = 2 * Math.PI * q / fs, c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < x.length; i++) { const s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
    const p = s1 * s1 + s2 * s2 - c * s1 * s2;
    if (p > best) { best = p; bf = q; }
  }
  return bf;
}

describe('GPU Resonator kernel mirror', () => {
  it('matches the CPU FDTD on a small grid (Strike)', () => {
    const t = hills(), count = 600;
    const cpu = runCpu('eco', t, count);
    const { out } = runGpuMirror({ n: 24, sub: 1 }, t, frames(count), count);
    expect(relErr(out, cpu)).toBeLessThan(1e-4);
  });

  it('matches the CPU FDTD with sub-steps and Resonate drive', () => {
    const t = hills(), count = 700;
    const drive = (i) => 0.3 * Math.sin(i * 0.07) + 0.2 * Math.sin(i * 0.31);
    const opts = { hz: 500, mode: 2, decay: 0.8, tone: 0.8, drive };
    const cpu = runCpu('standard', t, count, opts);
    const { out, plan } = runGpuMirror({ n: 32, sub: 2 }, t, frames(count, opts), count);
    expect(plan.R.S).toBe(2);
    expect(relErr(out, cpu)).toBeLessThan(1e-4);
  });

  it('WGSL keeps the same update equations', () => {
    expect(WGSL_STEP).toContain('(2.0 * c - p.A1 * a[pu + q] + stiff[k] * (p.al * lap - p.mu * l[q])) * p.inv');
    expect(WGSL_STEP).toContain('a[cu + q - 1u] + a[cu + q + 1u] + a[cu + q - R] + a[cu + q + R] - 4.0 * c');
    expect(WGSL_RESUB).toContain('st[k] - (st[k] - st[WW + k]) * p.r');
    expect(OUT_STRIDE).toBe(8);
  });

  it('stays stable at the largest grid near its ceiling', () => {
    const grid = GPU_DETAILS[256];
    const plan0 = new ResoGpuPlan(SR, grid);
    plan0.terrain(hills(), null, 0);
    const hz = 0.95 * plan0.ceiling(), count = 80;
    const fr = frames(count, { hz, decay: 20, tone: 1 });
    const { out, plan, mem } = runGpuMirror(grid, hills(), fr, count);
    expect(plan.R.S).toBe(32);
    let peak = 0;
    for (const v of out) { expect(Number.isFinite(v)).toBe(true); peak = Math.max(peak, Math.abs(v)); }
    expect(peak).toBeGreaterThan(1e-6);
    let umax = 0;
    for (const v of mem.st.u) umax = Math.max(umax, Math.abs(v));
    expect(umax).toBeLessThan(1);
  }, 60000);
});

describe('GPU Resonator pitch', () => {
  it('rings at the note on the 128 grid up to its ceiling', () => {
    const grid = GPU_DETAILS[128];
    const plan = new ResoGpuPlan(SR, grid);
    plan.terrain(flat(), null, 0);
    const ceil = plan.ceiling();
    expect(ceil).toBeGreaterThan(1300);    // CPU Resonator: about 300 to 650 Hz
    for (const hz of [110, 440, 0.97 * ceil]) {
      const count = Math.min(2400, Math.ceil(24000 * 30 / hz) + 120);
      const { out } = runGpuMirror(grid, flat(), frames(count, { hz, decay: 20, tone: 0, dot: [0.5, 0.5] }), count);
      const tail = new Float32Array(count - 120);
      for (let i = 0; i < tail.length; i++) tail[i] = out[2 * (i + 120)] + out[2 * (i + 120) + 1];
      expect(Math.abs(peakNear(tail, 24000, hz) / hz - 1)).toBeLessThan(0.01);
    }
  }, 60000);

  it('reports the ceilings by grid and folds notes above them', () => {
    const ceilings = {};
    for (const d of [128, 192, 256]) {
      const plan = new ResoGpuPlan(SR, GPU_DETAILS[d]);
      plan.terrain(flat(), null, 0);
      ceilings[d] = plan.ceiling();
      expect(ceilings[d]).toBeCloseTo(pitchCeiling(plan.g1, GPU_DETAILS[d].sub, 24000), 6);
      expect(ceilings[d]).toBeGreaterThan(1300);
      plan.R.configure(1, 1, 1.5, 0.5, 1, 0);
      plan.R.fTarget = plan.R.fCur = 1.5 * ceilings[d];
      plan.R.control(64);
      expect(plan.R.fPlayed).toBeCloseTo(0.75 * ceilings[d], 6);
    }
  });

  it('adds a fixed latency of three blocks', () => {
    expect(gpuLatencySec(48000)).toBeCloseTo(3 * 256 * 2 / 48000, 9);
  });
});

describe('FloatRing', () => {
  it('wraps around and keeps order', () => {
    const r = new FloatRing(8, 2), src = new Float32Array(10), dst = new Float32Array(10);
    let next = 0, expectNext = 0;
    for (let round = 0; round < 50; round++) {
      for (let i = 0; i < 5; i++) { src[2 * i] = next; src[2 * i + 1] = -next; next++; }
      expect(r.write(src, 0, 5)).toBe(5);
      expect(r.read(dst, 0, 5)).toBe(5);
      for (let i = 0; i < 5; i++) { expect(dst[2 * i]).toBe(expectNext); expect(dst[2 * i + 1]).toBe(-expectNext); expectNext++; }
    }
  });
  it('survives the 2^32 count wrap', () => {
    const r = new FloatRing(4, 1);
    r.head[0] = -2; r.head[1] = -2;      // 2^32 - 2
    const v = new Float32Array([1, 2, 3, 4]), o = new Float32Array(4);
    expect(r.write(v, 0, 4)).toBe(4);
    expect(r.available).toBe(4);
    expect(r.read(o, 0, 4)).toBe(4);
    expect([...o]).toEqual([1, 2, 3, 4]);
  });
  it('reports underrun and overflow instead of waiting', () => {
    const r = new FloatRing(4, 1), o = new Float32Array(4);
    expect(r.read(o, 0, 1)).toBe(0);
    expect(r.write(new Float32Array(6), 0, 6)).toBe(4);
    expect(r.space).toBe(0);
    expect(() => new FloatRing(6, 1)).toThrow();
  });
});

describe('GPU Resonator fallback decisions', () => {
  it('chooses the engine', () => {
    expect(chooseEngine({ requested: 'cpu', hasGpu: true }).engine).toBe('cpu');
    expect(chooseEngine({ requested: 'gpu', hasGpu: true, adapter: true }).engine).toBe('gpu');
    expect(chooseEngine({ requested: 'gpu', hasGpu: false }).engine).toBe('cpu');
    expect(chooseEngine({ requested: 'gpu', hasGpu: true, adapter: false }).engine).toBe('cpu');
    expect(chooseEngine({ requested: 'gpu', hasGpu: true, lost: true }).reason).toMatch(/lost/);
    expect(chooseEngine({ requested: 'gpu', hasGpu: true, fellBehind: true }).engine).toBe('cpu');
    for (const r of ['WebGPU', 'adapter', 'lost', 'behind']) expect(JSON.stringify(chooseEngine({ requested: 'gpu', hasGpu: r !== 'WebGPU', adapter: r !== 'adapter', lost: r === 'lost', fellBehind: r === 'behind' }))).not.toMatch(/—/);
  });
  it('falls back after repeated or long underruns only', () => {
    const fs = 24000;
    let w = new UnderrunWatch(fs);
    for (let k = 0; k < UNDERRUN_LIMIT - 1; k++) { expect(w.miss(k * 1000)).toBe(false); w.ok(); }
    expect(w.miss(UNDERRUN_LIMIT * 1000)).toBe(true);
    w = new UnderrunWatch(fs);
    for (let k = 0; k < 10; k++) { expect(w.miss(k * 3 * fs)).toBe(false); w.ok(); }
    w = new UnderrunWatch(fs);
    let fell = false;
    for (let i = 0; i < fs; i++) if (w.miss(i)) { fell = true; expect(i).toBeGreaterThanOrEqual(0.25 * fs - 1); break; }
    expect(fell).toBe(true);
  });

  it('crossfades in, then back to the CPU on underruns without waiting', () => {
    const R = new Resonator(SR, 'eco');
    R.configure(1, 1, 1.5, 0.5, 1, 0);
    R.derive([hills()], null, 0);
    R.setNote(220, true); R.setDot(0.3, 0.4);
    const sent = [], notes = [];
    const link = { grid: { n: 128, sub: 16 }, toHost: (m) => sent.push(m), fellBack: (f, reason) => notes.push(reason), status() {} };
    const f = new ResoFeed(link, { reso: R, terrA: null, terrB: null, resoMorph: 0 }, 1, 'live');
    R.feed = f;
    expect(f.active).toBe(false);
    f.ready(null);
    expect(f.active).toBe(true);
    R.control(128);
    const steps = (n, give) => { for (let i = 0; i < n; i++) { if (give) f.receive(new Float32Array([0.5, 0.5])); f.tick(R, 0); } };
    steps(f.L, false);                     // latency: nothing read yet
    expect(sent.filter(m => m.t === 'frames').length).toBe(3);
    steps(2000, true);                     // GPU answers: crossfade, then GPU only
    expect(f.onGpu).toBe(true);
    expect(R.hl[3]).toBeCloseTo(0.5, 6);
    steps(0.3 * 24000, false);             // GPU stops answering
    expect(f.onGpu).toBe(false);
    expect(notes.length).toBe(1);
    expect(f.active).toBe(false);
    steps(2000, false);                    // the CPU membrane carries on
    expect(Number.isFinite(R.hl[3])).toBe(true);
  });
});
