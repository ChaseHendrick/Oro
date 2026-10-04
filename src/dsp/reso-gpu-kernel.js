// GPU Resonator (2.12): the WGSL compute kernels and their JS mirror.
//
// The membrane is the 2.10 scheme of src/dsp/resonator.js on a finer grid:
//
//   lap  = u[W] + u[E] + u[N] + u[S] - 4 u
//   new  = (2 u - A1 up + s (al lap - mu lp)) * inv,   lp <- lap
//
// with strike pulses added at the first sub-step of each internal sample, the
// Resonate drive at every sub-step, and the two pickups read after the last.
// State per grid: u, up, lp (f32, W * W each, W = n + 2, zero border).
//
// One dispatch advances up to K sub-steps. Each workgroup owns a 16 x 16 tile
// and loads it with a K-cell halo into workgroup memory, so it can take K
// steps with no global synchronisation (the valid region shrinks by one cell
// per step and ends exactly on the tile). Results are identical to stepping
// the whole grid; the halo only recomputes neighbours' cells. Dispatches
// alternate between two state buffers (read one, write the other).
//
// jsStep() below is the same arithmetic in the same order on the whole grid,
// rounded to f32 after every operation, so tests can check the kernel's math
// against the CPU Resonator without a GPU.

export const TILE = 16;
export const KSTEPS = 8;                 // sub-steps per dispatch (halo width)
export const REGION = TILE + 2 * KSTEPS; // 32
export const UNIFORM_STRIDE = 256;       // bytes per dispatch record (dynamic offset alignment)
export const AMP_STRIDE = 5;             // per sample: drive, strike slots 0..3
export const OUT_STRIDE = 8;             // per sample: 4 left + 4 right pickup cells
export const MAX_ENT = 128;              // excitation cells per chunk (5 bumps of at most 25)

// Dispatch record (u32/f32 words): n, W, S, stepBase, nSteps, sampleBase,
// entBase, nEnt, A1, inv, al, mu, r, pad x3, pick[8]
export const REC_WORDS = 24;

const PARAMS = /* wgsl */`
struct Params {
  n: u32, W: u32, S: u32, stepBase: u32,
  nSteps: u32, sampleBase: u32, entBase: u32, nEnt: u32,
  A1: f32, inv: f32, al: f32, mu: f32,
  r: f32, p0: u32, p1: u32, p2: u32,
  pick: array<vec4<u32>, 2>,
};
@group(0) @binding(0) var<uniform> p: Params;
`;

export const WGSL_STEP = PARAMS + /* wgsl */`
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;
@group(0) @binding(3) var<storage, read> stiff: array<f32>;
@group(0) @binding(4) var<storage, read> entCell: array<u32>;
@group(0) @binding(5) var<storage, read> entW: array<f32>;
@group(0) @binding(6) var<storage, read> amps: array<f32>;
@group(0) @binding(7) var<storage, read_write> outp: array<f32>;

const T: u32 = ${TILE}u;
const K: u32 = ${KSTEPS}u;
const R: u32 = ${REGION}u;
const RR: u32 = ${REGION * REGION}u;
var<workgroup> a: array<f32, ${2 * REGION * REGION}>;
var<workgroup> l: array<f32, ${REGION * REGION}>;

fn inside(gx: i32, gy: i32) -> bool {
  return gx >= 1 && gy >= 1 && gx <= i32(p.n) && gy <= i32(p.n);
}

@compute @workgroup_size(${TILE}, ${TILE})
fn advance(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let W = p.W;
  let WW = W * W;
  let ox = i32(wg.x * T) + 1 - i32(K);
  let oy = i32(wg.y * T) + 1 - i32(K);
  for (var q = li; q < RR; q += T * T) {
    let gx = ox + i32(q % R);
    let gy = oy + i32(q / R);
    var u0 = 0.0; var u1 = 0.0; var l0 = 0.0;
    if (inside(gx, gy)) {
      let k = u32(gy) * W + u32(gx);
      u0 = src[k]; u1 = src[WW + k]; l0 = src[2u * WW + k];
    }
    a[q] = u0; a[RR + q] = u1; l[q] = l0;
  }
  workgroupBarrier();
  var cur = 0u;
  for (var t = 0u; t < p.nSteps; t++) {
    let g = p.stepBase + t;
    let sub = g % p.S;
    let smp = p.sampleBase + g / p.S;
    let lo = i32(t) + 1;
    let hi = i32(R) - 2 - i32(t);
    let cu = cur * RR;
    let pu = (1u - cur) * RR;
    for (var q = li; q < RR; q += T * T) {
      let lx = i32(q % R);
      let ly = i32(q / R);
      let gx = ox + lx;
      let gy = oy + ly;
      if (lx >= lo && lx <= hi && ly >= lo && ly <= hi && inside(gx, gy)) {
        let c = a[cu + q];
        let lap = a[cu + q - 1u] + a[cu + q + 1u] + a[cu + q - R] + a[cu + q + R] - 4.0 * c;
        let k = u32(gy) * W + u32(gx);
        a[pu + q] = (2.0 * c - p.A1 * a[pu + q] + stiff[k] * (p.al * lap - p.mu * l[q])) * p.inv;
        l[q] = lap;
      }
    }
    workgroupBarrier();
    if (li < p.nEnt) {
      let e = p.entBase + li;
      let k = entCell[e];
      let lx = i32(k % W) - ox;
      let ly = i32(k / W) - oy;
      if (lx >= 0 && ly >= 0 && lx < i32(R) && ly < i32(R)) {
        let m = smp * ${AMP_STRIDE}u;
        let w = e * ${AMP_STRIDE}u;
        var v = entW[w] * amps[m];
        if (sub == 0u) {
          v = v + (entW[w + 1u] * amps[m + 1u] + entW[w + 2u] * amps[m + 2u] + entW[w + 3u] * amps[m + 3u] + entW[w + 4u] * amps[m + 4u]);
        }
        let q = u32(ly) * R + u32(lx);
        a[pu + q] = a[pu + q] + v;
      }
    }
    workgroupBarrier();
    if (sub == p.S - 1u && li < 8u) {
      let k = p.pick[li / 4u][li % 4u];
      let lx = i32(k % W) - ox;
      let ly = i32(k / W) - oy;
      if (lx >= i32(K) && ly >= i32(K) && lx < i32(K + T) && ly < i32(K + T)) {
        outp[smp * ${OUT_STRIDE}u + li] = a[pu + u32(ly) * R + u32(lx)];
      }
    }
    cur = 1u - cur;
  }
  for (var q = li; q < RR; q += T * T) {
    let lx = i32(q % R);
    let ly = i32(q / R);
    let gx = ox + lx;
    let gy = oy + ly;
    if (lx >= i32(K) && ly >= i32(K) && lx < i32(K + T) && ly < i32(K + T) && inside(gx, gy)) {
      let k = u32(gy) * W + u32(gx);
      dst[k] = a[cur * RR + q];
      dst[WW + k] = a[(1u - cur) * RR + q];
      dst[2u * WW + k] = l[q];
    }
  }
}
`;

// Sub-step count change keeping the velocity (resonator.js resubstep), in place.
export const WGSL_RESUB = PARAMS + /* wgsl */`
@group(0) @binding(1) var<storage, read_write> st: array<f32>;

@compute @workgroup_size(${TILE}, ${TILE})
fn resubA(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.n || id.y >= p.n) { return; }
  let WW = p.W * p.W;
  let k = (id.y + 1u) * p.W + id.x + 1u;
  st[WW + k] = st[k] - (st[k] - st[WW + k]) * p.r;
}

@compute @workgroup_size(${TILE}, ${TILE})
fn resubB(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= p.n || id.y >= p.n) { return; }
  let W = p.W;
  let WW = W * W;
  let k = (id.y + 1u) * W + id.x + 1u;
  st[2u * WW + k] = st[WW + k - 1u] + st[WW + k + 1u] + st[WW + k - W] + st[WW + k + W] - 4.0 * st[WW + k];
}
`;

const f = Math.fround;

/**
 * JS mirror of one kernel sub-step on the whole grid (f32 after every
 * operation, same order as the WGSL). `st` = {u, up, lp} Float32Arrays; the
 * new displacement is written into st.up and the two are swapped.
 */
export function jsStep(st, s, n, W, A1, inv, al, mu) {
  const u = st.u, up = st.up, lp = st.lp;
  A1 = f(A1); inv = f(inv); al = f(al); mu = f(mu);
  for (let j = 1; j <= n; j++) {
    for (let i = 1; i <= n; i++) {
      const k = j * W + i;
      const c = u[k];
      const lap = f(f(f(f(u[k - 1] + u[k + 1]) + u[k - W]) + u[k + W]) - f(4 * c));
      up[k] = f(f(f(f(2 * c) - f(A1 * up[k])) + f(s[k] * f(f(al * lap) - f(mu * lp[k])))) * inv);
      lp[k] = lap;
    }
  }
  st.u = up; st.up = u;
}

/** Excitation at one sub-step (mirror of the kernel's entry loop). */
export function jsExcite(st, entCell, entW, entBase, nEnt, amps, smp, sub) {
  const u = st.u, m = smp * AMP_STRIDE;
  for (let i = 0; i < nEnt; i++) {
    const e = entBase + i, w = e * AMP_STRIDE;
    let v = f(entW[w] * amps[m]);
    if (sub === 0) {
      v = f(v + f(f(f(f(entW[w + 1] * amps[m + 1]) + f(entW[w + 2] * amps[m + 2])) + f(entW[w + 3] * amps[m + 3])) + f(entW[w + 4] * amps[m + 4])));
    }
    const k = entCell[e];
    u[k] = f(u[k] + v);
  }
}

/** Resub mirror: up from the velocity ratio r, then lp = Lap(up). */
export function jsResub(st, n, W, r) {
  const u = st.u, up = st.up, lp = st.lp;
  r = f(r);
  for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) { const k = j * W + i; up[k] = f(u[k] - f(f(u[k] - up[k]) * r)); }
  for (let j = 1; j <= n; j++) for (let i = 1; i <= n; i++) {
    const k = j * W + i;
    lp[k] = f(f(f(f(f(up[k - 1] + up[k + 1]) + up[k - W]) + up[k + W])) - f(4 * up[k]));
  }
}
