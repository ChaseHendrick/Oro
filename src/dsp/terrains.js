// Procedural terrain tables for the wave terrain oscillator.
//
// Every table lives on the unit torus: it is built only from functions that are
// periodic with an integer number of cycles per unit (sines, periodic lattices,
// sin²-based distances), so value and slope are continuous across the edges and
// an orbit can wander anywhere without clicks. Tables are deterministic for
// (index, seed, detail), zero-mean and scaled to max|h| = 1.
//
// Sound design notes: smooth terrains with few spatial partials (Swell, Bessel,
// Ripple) give round tones whose brightness tracks the orbit Size; noisy
// terrains (Massif, Ridge, Craters) give rich, evolving spectra as the dot
// moves; hard-edged ones (Terraces, Lattice, Cells) buzz.

import {
  TAU, clamp, smoothstep, smootherstep, mulberry32, fastSin, fastCos,
  makeGradientGrid, gradientNoise, addNoiseRow, makeCellGrid, worley,
} from './terrain-math.js';
import { TERRAINS } from './catalog.js';

const T = Object.fromEntries(TERRAINS.map((t, i) => [t.id, i]));

/** Zero mean, max|h| = 1, in place. Returns data. */
export function normalise(data) {
  const n = data.length;
  if (!n) return data;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += data[i];
  const mean = sum / n;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = data[i] - mean;
    data[i] = v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  if (peak > 1e-12) {
    const g = 1 / peak;
    for (let i = 0; i < n; i++) data[i] *= g;
  }
  return data;
}

function seededRng(index, seed) {
  return mulberry32(((seed | 0) * 1013904223 + (index + 1) * 2654435761) >>> 0);
}

/** fBm from a list of gradient grids (one per octave) with per-octave weights. */
function fbm(grids, weights, u, v) {
  let s = 0;
  for (let o = 0; o < grids.length; o++) s += weights[o] * gradientNoise(grids[o], u, v);
  return s;
}

/** row[i] = fBm at (i / size, v) for every i, using the row-wise noise kernel. */
function fbmRow(oct, v, size, row) {
  row.fill(0);
  for (let o = 0; o < oct.grids.length; o++) addNoiseRow(oct.grids[o], v, size, row, oct.weights[o]);
  return row;
}

function octaveGrids(rng, basePeriod, octaves) {
  const grids = [], weights = [];
  for (let o = 0; o < octaves; o++) {
    grids.push(makeGradientGrid(basePeriod << o, rng));
    weights.push(Math.pow(0.5, o));
  }
  return { grids, weights };
}

// ---------------------------------------------------------------------------
// Individual terrains. Each fills `out` (size*size) with raw heights; the
// caller normalises.

function genSwell(out, size, rng, detail) {
  // A handful of low integer-frequency plane waves with random phases: smooth
  // hills, mostly low spatial partials, so tones stay round and vocal.
  const comps = [[1, 0, 1], [0, 1, 1]];
  const pool = [[1, 1], [1, -1], [2, 0], [0, 2], [2, 1], [1, 2], [2, -1], [1, -2]];
  for (let i = 0; i < 3; i++) {
    const k = pool.splice(Math.floor(rng() * pool.length), 1)[0];
    comps.push([k[0], k[1], 0.35 + 0.3 * rng()]);
  }
  const extra = Math.round(detail * 6);
  for (let i = 0; i < extra; i++) {
    let kx = 0, ky = 0;
    while (Math.abs(kx) + Math.abs(ky) < 3) {
      kx = Math.floor(rng() * 9) - 4;
      ky = Math.floor(rng() * 9) - 4;
    }
    comps.push([kx, ky, (0.25 + 0.25 * rng()) * detail * 2.2 / Math.hypot(kx, ky)]);
  }
  const ph = comps.map(() => rng());
  // cos(2π(kx u + ky v + φ)) = cos A cos B - sin A sin B: per-column and per-row
  // tables turn every component into two multiplies per sample.
  const nc = comps.length;
  const cu = new Float64Array(nc * size), su = new Float64Array(nc * size);
  const cv = new Float64Array(nc * size), sv = new Float64Array(nc * size);
  for (let c = 0; c < nc; c++) {
    const k = comps[c];
    for (let i = 0; i < size; i++) {
      cu[c * size + i] = k[2] * fastCos(k[0] * i / size);
      su[c * size + i] = k[2] * fastSin(k[0] * i / size);
      cv[c * size + i] = fastCos(k[1] * i / size + ph[c]);
      sv[c * size + i] = fastSin(k[1] * i / size + ph[c]);
    }
  }
  for (let j = 0; j < size; j++) {
    const r = j * size;
    out.fill(0, r, r + size);
    for (let c = 0; c < nc; c++) {
      const cb = cv[c * size + j], sb = sv[c * size + j];
      const o = c * size;
      for (let i = 0; i < size; i++) out[r + i] += cu[o + i] * cb - su[o + i] * sb;
    }
  }
}

function genRipple(out, size, rng, detail) {
  // cos(2π f ρ) with ρ the smooth toroidal distance; cos is even in ρ, so the
  // centre is smooth too. A weaker, seed-placed second stone adds interference.
  const centres = [
    [0.5, 0.5, 1, 6 + 8 * detail],
    [rng(), rng(), 0.45 + 0.2 * rng(), (6 + 8 * detail) * (0.7 + 0.6 * rng())],
  ];
  const damp = 1 / (0.33 * 0.33);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      let h = 0;
      for (let c = 0; c < centres.length; c++) {
        const C = centres[c];
        const a = fastSin(0.5 * (u - C[0])), b = fastSin(0.5 * (v - C[1]));
        const rho2 = (a * a + b * b) / (Math.PI * Math.PI);
        const rho = Math.sqrt(rho2);
        h += C[2] * fastCos(C[3] * rho) * Math.exp(-rho2 * damp);
      }
      out[j * size + i] = h;
    }
  }
}

function genBessel(out, size, rng, detail) {
  // cos(2π a u + β cos(2π b v)): along a circular orbit this is phase
  // modulation inside phase modulation, so the spectrum has Bessel-function
  // sidebands whose spread follows β (Detail). Two orientations keep it from
  // being one-directional.
  const a1 = 1 + Math.floor(rng() * 3), b1 = 1 + Math.floor(rng() * 3);
  const a2 = 1 + Math.floor(rng() * 3), b2 = 1 + Math.floor(rng() * 3);
  const p1 = rng(), p2 = rng();
  const beta = (0.6 + 3.4 * detail) / TAU; // in cycles
  const beta2 = beta * (0.6 + 0.5 * rng());
  const rowMod = new Float64Array(size), colMod = new Float64Array(size);
  for (let k = 0; k < size; k++) {
    rowMod[k] = beta * fastCos(b1 * k / size + p1);
    colMod[k] = beta2 * fastCos(b2 * k / size + p2);
  }
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      out[j * size + i] = fastCos(a1 * u + rowMod[j]) + 0.7 * fastCos(a2 * v + colMod[i]);
    }
  }
}

function genDunes(out, size, rng, detail) {
  // Ridges run along v; their phase s = f·u + meander(v) + wobble(u, v), with f an
  // integer so frac(s) tiles. The cross-section is a band-limited, Lanczos-
  // smoothed saw: long windward slope, steep lee face.
  const f = 3 + Math.floor(rng() * 4);
  const mk = 1 + Math.floor(rng() * 2);
  const mPh = rng();
  const H = 3 + Math.round(detail * 6);
  const coef = new Float64Array(H + 1);
  for (let h = 1; h <= H; h++) {
    const x = h / (H + 1);
    coef[h] = (Math.sin(Math.PI * x) / (Math.PI * x)) / h;
  }
  const wob = octaveGrids(rng, 2, 2);
  const amp = octaveGrids(rng, 2, 2);
  const wrow = new Float64Array(size), arow = new Float64Array(size);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    const meander = 0.55 * fastSin(mk * v + mPh);
    fbmRow(wob, v, size, wrow);
    fbmRow(amp, v, size, arow);
    for (let i = 0; i < size; i++) {
      const s = f * i / size + meander + 0.5 * wrow[i];
      let p = 0;
      for (let h = 1; h <= H; h++) p += coef[h] * fastSin(h * s);
      out[j * size + i] = p * (0.8 + 0.5 * arow[i]);
    }
  }
}

function genRidge(out, size, rng, detail) {
  // Ridged multifractal: 1 - |noise| folds every zero crossing into a sharp
  // crest; each octave is weighted by the previous one so detail gathers on the
  // ridges, which is what gives the buzzy edge when an orbit crosses them.
  const octaves = 4 + Math.round(detail * 3);
  const base = 2 + Math.floor(rng() * 2);
  const { grids } = octaveGrids(rng, base, octaves);
  const nrow = new Float64Array(size), wrow = new Float64Array(size), srow = new Float64Array(size);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    wrow.fill(1);
    srow.fill(0);
    let amp = 1;
    for (let o = 0; o < octaves; o++) {
      nrow.fill(0);
      addNoiseRow(grids[o], v, size, nrow, 1);
      for (let i = 0; i < size; i++) {
        const n = nrow[i];
        let r = 1 - Math.sqrt(n * n + 0.0004) * 1.6;
        r *= r;
        srow[i] += r * amp * wrow[i];
        const w = r * 1.2;
        wrow[i] = w < 0 ? 0 : w > 1 ? 1 : w;
      }
      amp *= 0.5;
    }
    out.set(srow, j * size);
  }
}

function genMassif(out, size, rng, detail) {
  // fBm, 4 to 7 octaves by Detail. The two broad octaves are domain-warped
  // (offsets from periodic noise, so still periodic) to fold the ranges; the
  // fine octaves ride on top unwarped, evaluated a row at a time.
  const octaves = 4 + Math.round(detail * 3);
  const base = 2 + Math.floor(rng() * 2);
  const { grids, weights } = octaveGrids(rng, base, octaves);
  const warp = { grids: [makeGradientGrid(2, rng)], weights: [1] };
  const warp2 = { grids: [makeGradientGrid(2, rng)], weights: [1] };
  const ws = 0.12;
  const broad = 2;
  const fine = { grids: grids.slice(broad), weights: weights.slice(broad) };
  const wx = new Float64Array(size), wy = new Float64Array(size), frow = new Float64Array(size);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    fbmRow(warp, v, size, wx);
    fbmRow(warp2, v, size, wy);
    fbmRow(fine, v, size, frow);
    for (let i = 0; i < size; i++) {
      const uu = i / size + ws * wx[i];
      const vv = v + ws * wy[i];
      let h = frow[i];
      for (let o = 0; o < broad; o++) h += weights[o] * gradientNoise(grids[o], uu, vv);
      out[j * size + i] = h;
    }
  }
}

function craterProfile(x) {
  // bowl, raised rim, smooth fade to zero by x = 2 (C1 at the cut-off)
  if (x >= 2) return 0;
  const rim = 0.55 * Math.exp(-((x - 1) / 0.22) * ((x - 1) / 0.22));
  const x2 = x / 0.72;
  const bowl = Math.exp(-x2 * x2 * x2 * x2);
  return (rim - bowl) * (1 - smoothstep(1.35, 2, x));
}

function genCraters(out, size, rng, detail) {
  // Gentle rolling plains plus a field of craters, each stamped only over its
  // own footprint (with wrap) so the cost is proportional to crater area.
  const base = octaveGrids(rng, 3, 3);
  const row = new Float64Array(size);
  for (let j = 0; j < size; j++) {
    fbmRow(base, j / size, size, row);
    for (let i = 0; i < size; i++) out[j * size + i] = 0.25 * row[i];
  }
  const count = 9 + Math.round(detail * 22);
  for (let c = 0; c < count; c++) {
    const big = c < 4;
    const R = big ? 0.09 + 0.07 * rng() : 0.025 + 0.06 * rng() * rng() + 0.02;
    const cu = rng(), cv = rng();
    const depth = big ? 1 : 0.5 + 0.4 * rng();
    const ext = Math.ceil(2 * R * size) + 1;
    const ci = Math.floor(cu * size), cj = Math.floor(cv * size);
    for (let dj = -ext; dj <= ext; dj++) {
      const jj = ((cj + dj) % size + size) % size;
      const dv = (cj + dj) / size - cv;
      for (let di = -ext; di <= ext; di++) {
        const du = (ci + di) / size - cu;
        const x = Math.sqrt(du * du + dv * dv) / R;
        if (x >= 2) continue;
        const ii = ((ci + di) % size + size) % size;
        out[jj * size + ii] += depth * craterProfile(x);
      }
    }
  }
}

function genTerraces(out, size, rng, detail) {
  // Soft quantisation of fBm: flat plateaus joined by smootherstep risers.
  const oct = octaveGrids(rng, 2 + Math.floor(rng() * 2), 4);
  const row = new Float64Array(size);
  let peak = 1e-9;
  for (let j = 0; j < size; j++) {
    fbmRow(oct, j / size, size, row);
    for (let i = 0; i < size; i++) {
      const h = row[i];
      out[j * size + i] = h;
      const a = Math.abs(h);
      if (a > peak) peak = a;
    }
  }
  const levels = 5 + Math.round(detail * 4);
  const w = 0.28 - 0.18 * detail; // riser half-width: sharper steps with more detail
  for (let k = 0; k < size * size; k++) {
    const x = out[k] / peak;
    const y = (x + 1) * 0.5 * levels;
    const q = Math.floor(y);
    const f = y - q;
    const step = q + smootherstep(0.5 - w, 0.5 + w, f);
    out[k] = step / levels * 2 - 1 + 0.08 * x;
  }
}

function genCells(out, size, rng, detail) {
  // Smooth-min Worley F1 squared: rounded basin floors at the feature points,
  // softened creases where cells meet. Detail adds a finer cell layer.
  const P = 4 + Math.floor(rng() * 3);
  const g1 = makeCellGrid(P, rng);
  const g2 = makeCellGrid(P * 2 + 1, rng);
  const fine = 0.35 * detail;
  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const d1 = worley(g1, u, v, 0.18);
      let h = d1 * d1;
      if (fine > 0) {
        const d2 = worley(g2, u, v, 0.18);
        h += fine * d2 * d2;
      }
      out[j * size + i] = h;
    }
  }
}

function genCanyon(out, size, rng, detail) {
  // A plateau cut along the zero contour of warped fBm: 1 - exp(-(n/w)²) is a
  // smooth-floored valley with steep walls; a finer network joins with Detail.
  const a = octaveGrids(rng, 2, 3);
  const b = octaveGrids(rng, 4, 2);
  const warpX = { grids: [makeGradientGrid(2, rng)], weights: [1] };
  const warpY = { grids: [makeGradientGrid(2, rng)], weights: [1] };
  const top = octaveGrids(rng, 4, 3);
  const w1 = 0.11, w2 = 0.07;
  const wx = new Float64Array(size), wy = new Float64Array(size);
  const trow = new Float64Array(size), brow = new Float64Array(size);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    fbmRow(warpX, v, size, wx);
    fbmRow(warpY, v, size, wy);
    fbmRow(top, v, size, trow);
    fbmRow(b, v, size, brow);
    for (let i = 0; i < size; i++) {
      const uu = i / size + 0.08 * wx[i];
      const vv = v + 0.08 * wy[i];
      const n1 = fbm(a.grids, a.weights, uu, vv) / w1;
      const n2 = brow[i] / w2;
      const valley1 = 1 - Math.exp(-n1 * n1);
      const valley2 = 1 - detail * 0.6 * Math.exp(-n2 * n2);
      out[j * size + i] = valley1 * valley2 * (1 + 0.15 * trow[i]);
    }
  }
}

function genSpectra(out, size, rng, detail) {
  // Wavetable: v selects a waveform (sine -> triangle -> saw -> square -> pulse
  // and back, via 0.5 - 0.5 cos 2πv, so it tiles with zero slope at the turn);
  // each row is one band-limited single cycle in u. Lanczos sigma tames Gibbs.
  const K = Math.min(Math.floor(size / 4), 24 + Math.round(detail * 72));
  const shapes = 5;
  const basis = [];
  const pulseW = 0.2 + 0.1 * rng();
  for (let s = 0; s < shapes; s++) {
    const row = new Float64Array(size);
    for (let k = 1; k <= K; k++) {
      let a = 0, phase = 0; // phase in cycles, sine basis
      if (s === 0) { if (k === 1) a = 1; }
      else if (s === 1) { if (k & 1) { a = ((k >> 1) & 1 ? -1 : 1) / (k * k); } }
      else if (s === 2) { a = (k & 1 ? 1 : -1) / k; }
      else if (s === 3) { if (k & 1) a = 1 / k; }
      else { a = Math.sin(Math.PI * k * pulseW) / k; phase = 0.25; }
      if (a === 0) continue;
      const x = k / (K + 1);
      a *= Math.sin(Math.PI * x) / (Math.PI * x);
      // the 1/8-cycle offset keeps the square/pulse edges off the table seam
      for (let i = 0; i < size; i++) row[i] += a * fastSin(k * (i / size + 0.125) + phase);
    }
    let mean = 0, peak = 1e-9;
    for (let i = 0; i < size; i++) mean += row[i];
    mean /= size;
    for (let i = 0; i < size; i++) { row[i] -= mean; peak = Math.max(peak, Math.abs(row[i])); }
    for (let i = 0; i < size; i++) row[i] /= peak;
    basis.push(row);
  }
  for (let j = 0; j < size; j++) {
    const m = (0.5 - 0.5 * Math.cos(TAU * j / size)) * (shapes - 1);
    const s0 = Math.min(shapes - 2, Math.floor(m));
    const f = m - s0;
    const A = basis[s0], B = basis[s0 + 1];
    for (let i = 0; i < size; i++) out[j * size + i] = A[i] + f * (B[i] - A[i]);
  }
}

function genLattice(out, size, rng, detail) {
  // tanh(k sin sin): a checkerboard whose edges sharpen with Detail.
  const f = 3 + Math.floor(rng() * 4);
  const k = 1 + 6 * detail;
  const norm = 1 / Math.tanh(k);
  const su = new Float64Array(size), sv = new Float64Array(size);
  // a quarter-cycle offset puts the seams on plateau centres, not on edges
  const pu = 0.25 + rng() * 0.1, pv = 0.25 + rng() * 0.1;
  for (let i = 0; i < size; i++) { su[i] = fastSin(f * i / size + pu); sv[i] = fastSin(f * i / size + pv); }
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) out[j * size + i] = Math.tanh(k * su[i] * sv[j]) * norm;
  }
}

function genVortex(out, size, rng, detail) {
  // A torus cannot carry a single smooth vortex (the winding has to cancel
  // somewhere), so the arms live inside a disc of smooth toroidal radius 0.31,
  // which is smaller than the closest seam (1/π ≈ 0.318), and fade to a gentle
  // periodic swirl outside. The centre fades to 0 where the angle is undefined.
  const arms = 2 + Math.floor(rng() * 4);
  const twist = 2.5 + 6 * detail;
  const dir = rng() < 0.5 ? -1 : 1;
  const bg = [];
  for (let c = 0; c < 4; c++) bg.push([Math.floor(rng() * 3) + 1, Math.floor(rng() * 5) - 2, rng(), 0.5 + 0.5 * rng()]);
  for (let j = 0; j < size; j++) {
    const v = j / size;
    const dy = v - 0.5;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const dx = u - 0.5;
      const a = fastSin(0.5 * dx), b = fastSin(0.5 * dy);
      const rho = Math.sqrt(a * a + b * b) / Math.PI;
      const phi = Math.atan2(dy, dx) / TAU;
      const armsH = fastCos(dir * arms * phi + twist * rho * 2.2);
      const winIn = smoothstep(0, 0.06, rho);
      const winOut = 1 - smoothstep(0.17, 0.31, rho);
      let back = 0;
      for (let c = 0; c < bg.length; c++) {
        const B = bg[c];
        back += B[3] * fastSin(B[0] * u + B[1] * v + B[2]);
      }
      out[j * size + i] = armsH * winIn * winOut + 0.3 * back * (1 - winOut) + 0.05 * back;
    }
  }
}

// Original periodic analytical surfaces. Integer spatial frequencies preserve
// continuity of the value and slope across the table's torus boundaries.
function analytical(out, size, rng, detail, mode) {
  const phase = rng(), n = 1 + Math.round(detail * 5), z = rng();
  const partials = Array.from({ length: 10 }, (_, k) => ({ x: 1 + Math.floor(rng() * (n + 2)), y: 1 + Math.floor(rng() * (n + 2)), p: rng(), a: (rng() - 0.5) / (k + 1) }));
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const x = i / size, y = j / size, sx = fastSin(x), sy = fastSin(y);
    let v;
    if (mode === 0) v = fastCos(n * x + phase) + fastCos((n + 1) * y) + 0.7 * fastCos(n * x + (n + 1) * y + 0.4 * fastSin(x - y));
    else if (mode === 1) v = fastSin(n * x) * fastCos(n * y) + fastSin(n * y) * fastCos(z) + fastSin(z) * fastCos(n * x);
    else if (mode === 2) v = sx * sy + detail * fastSin(2 * x + phase) * fastSin(3 * y);
    else if (mode === 3) v = fastCos(n * x) * fastCos(n * y) + 0.35 * detail * fastCos(2 * n * x + phase) * fastCos(2 * n * y);
    else if (mode === 4) { v = 0; for (const a of partials) v += a.a * fastSin(a.x * x + a.y * y + a.p); }
    else v = fastCos(n * Math.sqrt(0.001 + sx * sx + sy * sy) + phase + detail * fastSin(x + y));
    out[j * size + i] = v;
  }
}
const genInterference = (a,n,r,d) => analytical(a,n,r,d,0);
const genGyroid = (a,n,r,d) => analytical(a,n,r,d,1);
const genSaddle = (a,n,r,d) => analytical(a,n,r,d,2);
const genEggbox = (a,n,r,d) => analytical(a,n,r,d,3);
const genHarmonics = (a,n,r,d) => analytical(a,n,r,d,4);
const genOrbit = (a,n,r,d) => analytical(a,n,r,d,5);

const GENERATORS = {
  [T.swell]: genSwell,
  [T.ripple]: genRipple,
  [T.fm]: genBessel,
  [T.dunes]: genDunes,
  [T.ridge]: genRidge,
  [T.massif]: genMassif,
  [T.crater]: genCraters,
  [T.terrace]: genTerraces,
  [T.cells]: genCells,
  [T.canyon]: genCanyon,
  [T.spectra]: genSpectra,
  [T.lattice]: genLattice,
  [T.vortex]: genVortex,
  [T.interference]: genInterference, [T.gyroid]: genGyroid, [T.saddle]: genSaddle,
  [T.eggbox]: genEggbox, [T.harmonics]: genHarmonics, [T.orbit]: genOrbit,
};

/**
 * Build terrain `index` (into TERRAINS) as a normalised size x size table.
 * Returns null for 'user' (imported) terrains, which come from decodeUserTerrain().
 */
export function generateTerrain(index, { size = 512, seed = 7, detail = 0.5 } = {}) {
  const gen = GENERATORS[index];
  if (!gen) return null;
  const n = Math.max(4, Math.round(size));
  const out = new Float32Array(n * n);
  gen(out, n, seededRng(index, seed), clamp(Number.isFinite(detail) ? detail : 0.5, 0, 1));
  for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i])) out[i] = 0;
  return normalise(out);
}

// ---------------------------------------------------------------------------
// Imported terrains.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = new Int16Array(256).fill(-1);
for (let i = 0; i < 64; i++) B64_LOOKUP[B64.charCodeAt(i)] = i;
B64_LOOKUP['-'.charCodeAt(0)] = 62; // tolerate the URL-safe alphabet
B64_LOOKUP['_'.charCodeAt(0)] = 63;

/** Base64 -> Uint8Array without atob (absent in some worker scopes). */
export function base64ToBytes(str) {
  const s = String(str || '');
  const out = new Uint8Array(Math.floor(s.length * 3 / 4) + 3);
  let acc = 0, bits = 0, n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 256 ? B64_LOOKUP[c] : -1;
    if (v < 0) continue; // skips '=', whitespace, data-URL junk
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 255;
    }
  }
  return out.subarray(0, n);
}

/** Map an integer source index into [0, n) for a periodic (mirror = false) or mirrored-periodic axis. */
function mapIndex(k, n, mirror) {
  const period = mirror ? 2 * n : n;
  let m = k % period;
  if (m < 0) m += period;
  return m < n ? m : period - 1 - m;
}

function catmull(p0, p1, p2, p3, t) {
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}

/** Periodic box pre-blur along one axis, used before shrinking so detail averages instead of aliasing. */
function boxBlurAxis(src, w, h, radius, alongX, mirror) {
  if (radius < 0.5) return src;
  const out = new Float32Array(w * h);
  const r = Math.max(1, Math.round(radius));
  const inv = 1 / (2 * r + 1);
  if (alongX) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -r; k <= r; k++) s += src[y * w + mapIndex(x + k, w, mirror)];
        out[y * w + x] = s * inv;
      }
    }
  } else {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = -r; k <= r; k++) s += src[mapIndex(y + k, h, mirror) * w + x];
        out[y * w + x] = s * inv;
      }
    }
  }
  return out;
}

/**
 * Decode a stored UserTerrain ({kind, w, h, mirror, data: base64 Uint8 w*h})
 * into a normalised, seamlessly tiling size x size table.
 *   image:      mirror = 1 reflects both axes (2w x 2h period, seamless);
 *               mirror = 0 crossfades the image with a half-period-shifted
 *               copy under a sin² weight so the seams vanish.
 *   wavetable:  rows are single-cycle frames, so x is already periodic;
 *               mirror = 1 reflects the frame axis, mirror = 0 crossfades it.
 * Resampling is Catmull-Rom (with a box pre-blur when shrinking) followed by a
 * gentle [1 2 1] smoothing pass.
 */
export function decodeUserTerrain(userTerrain, size = 512) {
  const S = Math.max(4, Math.round(size));
  const ut = userTerrain || {};
  const w = Math.max(2, Math.round(ut.w || 0)), h = Math.max(2, Math.round(ut.h || 0));
  const bytes = typeof ut.data === 'string' ? base64ToBytes(ut.data)
    : ut.data instanceof Uint8Array ? ut.data : new Uint8Array(0);
  // Optional low byte plane (16-bit height maps): sample = (hi << 8 | lo) / 65535.
  const lo = typeof ut.lo === 'string' && ut.lo.length ? base64ToBytes(ut.lo)
    : ut.lo instanceof Uint8Array ? ut.lo : null;
  let src = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (i >= bytes.length) { src[i] = 0; continue; }
    src[i] = lo && i < lo.length ? ((bytes[i] << 8) | lo[i]) / 32767.5 - 1 : bytes[i] / 127.5 - 1;
  }
  const wavetable = ut.kind === 'wavetable';
  const mirror = !!ut.mirror;
  const mirrorX = mirror && !wavetable;
  const mirrorY = mirror;
  const periodX = mirrorX ? 2 * w : w;
  const periodY = mirrorY ? 2 * h : h;
  const sx = periodX / S, sy = periodY / S;
  if (sx > 1.5) src = boxBlurAxis(src, w, h, (sx - 1) / 2, true, mirrorX);
  if (sy > 1.5) src = boxBlurAxis(src, w, h, (sy - 1) / 2, false, mirrorY);

  const out = new Float32Array(S * S);
  const xi = new Int32Array(4 * S), xt = new Float64Array(S);
  for (let i = 0; i < S; i++) {
    const x = i * sx;
    const x0 = Math.floor(x);
    xt[i] = x - x0;
    for (let k = 0; k < 4; k++) xi[4 * i + k] = mapIndex(x0 - 1 + k, w, mirrorX);
  }
  const rows = new Float64Array(4);
  for (let j = 0; j < S; j++) {
    const y = j * sy;
    const y0 = Math.floor(y);
    const ty = y - y0;
    for (let i = 0; i < S; i++) {
      for (let k = 0; k < 4; k++) {
        const r = mapIndex(y0 - 1 + k, h, mirrorY) * w;
        rows[k] = catmull(src[r + xi[4 * i]], src[r + xi[4 * i + 1]], src[r + xi[4 * i + 2]], src[r + xi[4 * i + 3]], xt[i]);
      }
      out[j * S + i] = catmull(rows[0], rows[1], rows[2], rows[3], ty);
    }
  }

  let res = out;
  // Seam removal for axes that are not naturally periodic.
  const blendX = !wavetable && !mirror;
  const blendY = !mirror;
  if (blendX || blendY) {
    const tmp = new Float32Array(S * S);
    const half = S >> 1;
    if (blendX) {
      for (let j = 0; j < S; j++) {
        for (let i = 0; i < S; i++) {
          const wgt = Math.sin(Math.PI * i / S) ** 2;
          tmp[j * S + i] = wgt * res[j * S + i] + (1 - wgt) * res[j * S + ((i + half) % S)];
        }
      }
      res.set(tmp);
    }
    if (blendY) {
      for (let j = 0; j < S; j++) {
        const wgt = Math.sin(Math.PI * j / S) ** 2;
        const jj = ((j + half) % S) * S;
        for (let i = 0; i < S; i++) tmp[j * S + i] = wgt * res[j * S + i] + (1 - wgt) * res[jj + i];
      }
      res.set(tmp);
    }
  }

  // gentle periodic [1 2 1]/4 smoothing in both axes
  const tmp = new Float32Array(S * S);
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const l = res[j * S + (i === 0 ? S - 1 : i - 1)], r = res[j * S + (i === S - 1 ? 0 : i + 1)];
      tmp[j * S + i] = 0.25 * l + 0.5 * res[j * S + i] + 0.25 * r;
    }
  }
  for (let j = 0; j < S; j++) {
    const up = (j === 0 ? S - 1 : j - 1) * S, dn = (j === S - 1 ? 0 : j + 1) * S;
    for (let i = 0; i < S; i++) res[j * S + i] = 0.25 * tmp[up + i] + 0.5 * tmp[j * S + i] + 0.25 * tmp[dn + i];
  }
  for (let i = 0; i < res.length; i++) if (!Number.isFinite(res[i])) res[i] = 0;
  return normalise(res);
}

// ---------------------------------------------------------------------------
// Mip chain.

// 15-tap Blackman-windowed half-band low-pass (cut-off at the new Nyquist).
// Odd taps only (plus the centre), ~70 dB stopband, unity DC gain.
const MIP_TAPS = (() => {
  const N = 7;
  const taps = [];
  let sum = 0;
  for (let k = -N; k <= N; k++) {
    const x = k / 2;
    const sinc = k === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const win = 0.42 + 0.5 * Math.cos(Math.PI * k / (N + 1)) + 0.08 * Math.cos(2 * Math.PI * k / (N + 1));
    const c = 0.5 * sinc * win;
    taps.push(Math.abs(c) < 1e-12 ? 0 : c);
    sum += c;
  }
  return taps.map(c => c / sum);
})();
const MIP_HALF = (MIP_TAPS.length - 1) >> 1;

function halveWrap(src, size) {
  const h = size >> 1;
  const rows = new Float32Array(h * size); // decimated along x
  for (let j = 0; j < size; j++) {
    const r = j * size;
    for (let i = 0; i < h; i++) {
      const c = 2 * i;
      let s = 0;
      for (let k = -MIP_HALF; k <= MIP_HALF; k++) {
        const t = MIP_TAPS[k + MIP_HALF];
        if (t === 0) continue;
        s += t * src[r + ((c + k + size) % size)];
      }
      rows[j * h + i] = s;
    }
  }
  const out = new Float32Array(h * h);
  for (let j = 0; j < h; j++) {
    const c = 2 * j;
    for (let i = 0; i < h; i++) {
      let s = 0;
      for (let k = -MIP_HALF; k <= MIP_HALF; k++) {
        const t = MIP_TAPS[k + MIP_HALF];
        if (t === 0) continue;
        s += t * rows[((c + k + size) % size) * h + i];
      }
      out[j * h + i] = s;
    }
  }
  return out;
}

/**
 * Mip chain [{size, data}], level 0 = the input. Each next level is low-passed
 * at its new Nyquist and decimated 2x (sample i of level L+1 sits on sample 2i
 * of level L, so all levels share the u = i / size grid). Not renormalised, so
 * the oscillator level stays constant when it crossfades between levels.
 */
export function buildMipChain(data, size, minSize = 32) {
  const levels = [{ size, data }];
  let cur = data, s = size;
  while (s > minSize && s % 2 === 0 && s >= 8) {
    cur = halveWrap(cur, s);
    s >>= 1;
    levels.push({ size: s, data: cur });
  }
  return levels;
}
