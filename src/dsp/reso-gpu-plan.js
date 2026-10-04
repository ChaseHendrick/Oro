// GPU Resonator (2.12): turns the worklet's per-sample control frames into
// GPU work, and the GPU's pickup readings back into audio.
//
// The plan owns a Resonator on the GPU grid (128, 192 or 256 nodes a side).
// It never steps that membrane itself: it only uses the 2.10 code for the
// stiffness, the lowest mode, the per-sub-step coefficients, the strike and
// drive stencils, the pulse shapes and the pickups, so the GPU runs the same
// physics as the CPU Resonator. A block (BLOCK internal samples) is cut into
// chunks (at most CHUNK samples, and a new one at every strike) with constant
// coefficients and stencils; each chunk becomes dispatch records of at most
// KSTEPS sub-steps (see reso-gpu-kernel.js).
//
// JsMembrane runs the same records on the CPU in f32 (the kernel's mirror),
// for tests and as a reference.

import { Resonator } from './resonator.js';
import { KSTEPS, AMP_STRIDE, OUT_STRIDE, MAX_ENT, UNIFORM_STRIDE, jsStep, jsExcite, jsResub } from './reso-gpu-kernel.js';

/**
 * GPU detail setting -> grid (interior nodes a side) and the most sub-steps
 * per internal sample. The sub-step limits scale with the grid so every
 * detail reaches about the same pitch ceiling (about 1.4 kHz on flat land).
 */
export const GPU_DETAILS = Object.freeze({
  128: Object.freeze({ n: 128, sub: 16 }),
  192: Object.freeze({ n: 192, sub: 24 }),
  256: Object.freeze({ n: 256, sub: 32 }),
});
export const GPU_DETAIL_DEFAULT = 128;
/** Floats per internal sample from the worklet: x, fTarget, dotX, dotY, strikeAmp, strikeX, strikeY, mode, decay, tone, listen. */
export const FRAME = 11;
export const BLOCK = 256;                // internal samples per GPU job
export const CHUNK = 64;                 // samples per coefficient update (about 2.7 ms)
export const LATENCY_BLOCKS = 3;         // the worklet reads the output this many blocks late
export const MAX_STRIKES_PER_BLOCK = 32;
export const MAX_CHUNKS = BLOCK / CHUNK + MAX_STRIKES_PER_BLOCK;
export const MAX_SUB = 32;
export const MAX_RECORDS = Math.ceil(BLOCK * MAX_SUB / KSTEPS) + 3 * MAX_CHUNKS;
const REC = UNIFORM_STRIDE / 4;          // words per record
export const OP_STEP = 0, OP_RESUB = 1;

/** Added latency (seconds) of the GPU path at host rate `sr`. */
export function gpuLatencySec(sr) {
  const D = Math.max(1, Math.round(sr / 24000));
  return LATENCY_BLOCKS * BLOCK * D / sr;
}

export function gpuDetail(v) {
  return GPU_DETAILS[Math.round(Number(v))] || GPU_DETAILS[GPU_DETAIL_DEFAULT];
}

/**
 * Highest note (Hz) the grid plays at its own pitch (above it notes ring
 * whole octaves lower), from the lowest mode g1 of -S Lap and the most
 * sub-steps: the Resonator's LAM2_MAX bound.
 */
export function pitchCeiling(g1, sub, fs) {
  const th = 2 * Math.asin(Math.min(1, Math.sqrt(0.45 * g1) / 2));
  return th * sub * fs / (2 * Math.PI);
}

class PlanResonator extends Resonator {
  constructor(sr, grid) { super(sr, 'standard', grid); this.resubR = 0; }
  // the GPU keeps the membrane: only note the ratio for a resub dispatch
  resubstep(S) { if (S !== this.S) this.resubR = this.S / S; this.S = S; }
}

export class ResoGpuPlan {
  constructor(sr, grid) {
    this.grid = grid;
    this.n = grid.n; this.W = grid.n + 2;
    this.R = new PlanResonator(sr, grid);
    this.D = this.R.D; this.fs = this.R.fs;
    this.records = new ArrayBuffer(MAX_RECORDS * UNIFORM_STRIDE);
    this.ru = new Uint32Array(this.records); this.rf = new Float32Array(this.records);
    this.ops = new Uint8Array(MAX_RECORDS);
    this.nRec = 0;
    this.entCell = new Uint32Array(MAX_CHUNKS * MAX_ENT);
    this.entW = new Float32Array(MAX_CHUNKS * MAX_ENT * AMP_STRIDE);
    this.nEntAll = 0;
    this.amps = new Float32Array(BLOCK * AMP_STRIDE);
    this.chStart = new Int32Array(MAX_CHUNKS); this.chLen = new Int32Array(MAX_CHUNKS);
    this.chPick = new Float64Array(MAX_CHUNKS * OUT_STRIDE);
    this.nChunks = 0; this.nSamples = 0;
    this.cfg = [NaN, NaN, NaN, NaN];
    this.strikesInBlock = 0;
    this.started = false;
  }

  get g1() { return this.R.g1; }
  get ready() { return this.R.g1 > 0; }
  /** Stiffness (Float64Array, W * W) after terrain(). */
  get stiffness() { return this.R.s; }

  /** Derive the stiffness and lowest mode from single mip levels ({size, data}) of terrains A and B. */
  terrain(a, b, morph) {
    this.R.derive(a ? [a] : null, b ? [b] : null, morph);
    return this.R.g1;
  }

  /** Highest note at its own pitch (Hz) for the current terrain. */
  ceiling() { return pitchCeiling(this.R.g1, this.grid.sub, this.fs); }

  record(op) {
    const r = this.nRec++;
    this.ops[r] = op;
    const o = r * REC, u = this.ru, f = this.rf, R = this.R;
    u[o] = this.n; u[o + 1] = this.W; u[o + 2] = R.S;
    f[o + 8] = R.A1; f[o + 9] = R.inv; f[o + 10] = R.al; f[o + 11] = R.mu;
    return o;
  }

  /**
   * Plan `count` (<= BLOCK) samples of frames (FRAME floats each from `at`).
   * Fills records, entries and amplitudes; returns the number of records.
   */
  plan(frames, at, count) {
    const R = this.R, n = this.n, W = this.W, D = this.D;
    this.nRec = 0; this.nEntAll = 0; this.nChunks = 0; this.nSamples = count;
    this.strikesInBlock = 0;
    const amps = this.amps;
    let i = 0;
    while (i < count) {
      const fo = at + i * FRAME;
      const mode = frames[fo + 7], decay = frames[fo + 8], tone = frames[fo + 9], listen = frames[fo + 10];
      const c = this.cfg;
      if (mode !== c[0] || decay !== c[1] || tone !== c[2] || listen !== c[3]) {
        R.configure(mode, 0.5, decay, tone, 1, listen);
        c[0] = mode; c[1] = decay; c[2] = tone; c[3] = listen;
      }
      if (frames[fo + 1] > 0) {
        R.fTarget = frames[fo + 1];
        if (!this.started) { R.fCur = R.fTarget; this.started = true; }   // the stream starts at the note
      }
      R.setDot(frames[fo + 2], frames[fo + 3]);
      if (frames[fo + 4] > 0 && this.strikesInBlock < MAX_STRIKES_PER_BLOCK) {
        this.strikesInBlock++;
        R.fCur = R.fTarget;
        R.strike(frames[fo + 5], frames[fo + 6], frames[fo + 4]);
      }
      let len = 1;
      while (i + len < count && len < CHUNK && !(frames[fo + len * FRAME + 4] > 0)) len++;
      if (this.nChunks >= MAX_CHUNKS) len = count - i;   // never: strikes are capped above
      if (R.g1 > 0) R.control(len * D);
      if (R.resubR !== 0) {
        const o = this.record(OP_RESUB);
        this.rf[o + 12] = R.resubR;
        R.resubR = 0;
      }
      // per-sample amplitudes: drive (every sub-step) and the strike pulses (first sub-step)
      const drive = R.mode === 2;
      for (let s = i; s < i + len; s++) {
        const x = frames[at + s * FRAME], m = s * AMP_STRIDE;
        amps[m] = drive && x !== 0 ? x * R.gDrive : 0;
        for (let p = 0; p < 4; p++) {
          const amp = R.pAmp[p];
          if (amp === 0) { amps[m + 1 + p] = 0; continue; }
          const t = R.pT[p];
          amps[m + 1 + p] = amp * R.pulse[t] * R.gStrike;
          if (t + 1 >= R.pulse.length) R.pAmp[p] = 0; else R.pT[p] = t + 1;
        }
      }
      // excitation cells of this chunk: the drive bump and every strike slot still pulsing
      const entBase = this.nEntAll;
      let nEnt = 0;
      const add = (cell, src, w) => {
        let e = -1;
        for (let q = 0; q < nEnt; q++) if (this.entCell[entBase + q] === cell) { e = entBase + q; break; }
        if (e < 0) {
          if (nEnt >= MAX_ENT) return;
          e = entBase + nEnt++;
          this.entCell[e] = cell;
          this.entW.fill(0, e * AMP_STRIDE, e * AMP_STRIDE + AMP_STRIDE);
        }
        this.entW[e * AMP_STRIDE + src] = w;
      };
      if (drive) for (let q = 0; q < R.dCnt; q++) add(R.dIdx[q], 0, R.dW[q]);
      for (let p = 0; p < 4; p++) {
        // active at the chunk start (the loop above may have just finished it)
        let used = false;
        for (let s = i; s < i + len && !used; s++) if (amps[s * AMP_STRIDE + 1 + p] !== 0) used = true;
        if (!used) continue;
        const base = p * 25;
        for (let q = 0; q < R.pCnt[p]; q++) add(R.pIdx[base + q], 1 + p, R.pW[base + q]);
      }
      this.nEntAll += nEnt;
      // pickups: border cells read nothing (weight 0 on an interior cell)
      const ch = this.nChunks++;
      this.chStart[ch] = i; this.chLen[ch] = len;
      const pick = [0, 0, 0, 0, 0, 0, 0, 0];
      for (let j = 0; j < 8; j++) {
        const k = R.kIdx[j], gx = k % W, gy = (k - gx) / W;
        const ok = gx >= 1 && gy >= 1 && gx <= n && gy <= n;
        pick[j] = ok ? k : W + 1;
        this.chPick[ch * OUT_STRIDE + j] = ok ? R.kW[j] : 0;
      }
      const steps = len * R.S;
      for (let sb = 0; sb < steps; sb += KSTEPS) {
        const o = this.record(OP_STEP), u = this.ru;
        u[o + 3] = sb; u[o + 4] = Math.min(KSTEPS, steps - sb); u[o + 5] = i;
        u[o + 6] = entBase; u[o + 7] = nEnt;
        for (let j = 0; j < 8; j++) u[o + 16 + j] = pick[j];
      }
      i += len;
    }
    return this.nRec;
  }

  /** Pickup cells read back (OUT_STRIDE per sample) -> stereo (2 per sample) into out from `at`. */
  finish(raw, out, at) {
    for (let c = 0; c < this.nChunks; c++) {
      const w = this.chPick, o = c * OUT_STRIDE;
      for (let s = this.chStart[c], end = s + this.chLen[c]; s < end; s++) {
        const r = s * OUT_STRIDE;
        out[at + 2 * s] = raw[r] * w[o] + raw[r + 1] * w[o + 1] + raw[r + 2] * w[o + 2] + raw[r + 3] * w[o + 3];
        out[at + 2 * s + 1] = raw[r + 4] * w[o + 4] + raw[r + 5] * w[o + 5] + raw[r + 6] * w[o + 6] + raw[r + 7] * w[o + 7];
      }
    }
  }
}

/** The kernel's math on the CPU (f32), driven by the same records as the GPU. */
export class JsMembrane {
  constructor(n) {
    this.n = n; this.W = n + 2;
    const cells = this.W * this.W;
    this.st = { u: new Float32Array(cells), up: new Float32Array(cells), lp: new Float32Array(cells) };
    this.s = new Float32Array(cells);
    this.raw = new Float32Array(BLOCK * OUT_STRIDE);
  }
  setStiffness(s) { this.s.set(s.subarray ? s.subarray(0, this.s.length) : s); }
  reset() { this.st.u.fill(0); this.st.up.fill(0); this.st.lp.fill(0); }
  /** Run a planned block; returns the raw pickup readings. */
  run(plan) {
    const st = this.st, n = this.n, W = this.W, u = plan.ru, f = plan.rf, raw = this.raw;
    for (let r = 0; r < plan.nRec; r++) {
      const o = r * REC;
      if (plan.ops[r] === OP_RESUB) { jsResub(st, n, W, f[o + 12]); continue; }
      const S = u[o + 2], base = u[o + 3], cnt = u[o + 4], s0 = u[o + 5];
      for (let t = 0; t < cnt; t++) {
        const g = base + t, sub = g % S, smp = s0 + Math.floor(g / S);
        jsStep(st, this.s, n, W, f[o + 8], f[o + 9], f[o + 10], f[o + 11]);
        jsExcite(st, plan.entCell, plan.entW, u[o + 6], u[o + 7], plan.amps, smp, sub);
        if (sub === S - 1) for (let j = 0; j < 8; j++) raw[smp * OUT_STRIDE + j] = st.u[u[o + 16 + j]];
      }
    }
    return raw;
  }
}
