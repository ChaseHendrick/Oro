import { sampleBilinear, warpPoint } from '../dsp/terrain-math.js';
import { linearToSrgb } from './palettes.js';

// Interpolation keeps the eventual 8-bit channel within one unit of direct
// sRGB evaluation. The minimap otherwise evaluates three powers per pixel.
const LUT_SIZE = 4096;
const SRGB = Float64Array.from({ length: LUT_SIZE + 1 }, (_, i) => linearToSrgb(i / LUT_SIZE) * 255);
export function minimapSrgbByte(value) {
  if (!(value > 0)) return 0;
  if (value >= 1) return 255;
  const position = value * LUT_SIZE, index = Math.floor(position), fraction = position - index;
  return Math.round(SRGB[index] + fraction * (SRGB[index + 1] - SRGB[index]));
}

/** Reuses warped sample grids; only morph and table fades change every frame. */
export class MinimapTerrainSampler {
  constructor(size) {
    this.size = size; this.count = size * size; this.warp = NaN; this.sourceVersion = -1;
    this.u = new Float64Array(this.count); this.v = new Float64Array(this.count);
    this.point = { u: 0, v: 0 };
    this.tables = Array.from({ length: 4 }, () => ({ data: null, size: 0, valid: false, grid: new Float64Array(this.count) }));
    this.lookups = 0;
  }
  invalidate() { for (const table of this.tables) table.valid = false; }
  refresh(index, data, size) {
    const table = this.tables[index];
    if (table.valid && table.data === data && table.size === size) return;
    table.data = data; table.size = size; table.valid = true;
    if (!data) { table.grid.fill(0); return; }
    for (let i = 0; i < this.count; i++) table.grid[i] = sampleBilinear(data, size, this.u[i], this.v[i]);
    this.lookups += this.count;
  }
  sample(field, out) {
    const warp = field.warp > 0 ? field.warp : 0;
    if (warp !== this.warp) {
      this.warp = warp;
      const n = this.size, point = this.point;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const k = j * n + i, u = (i + .5) / n, v = (j + .5) / n;
        if (warp) { warpPoint(u, v, warp, point); this.u[k] = point.u; this.v[k] = point.v; }
        else { this.u[k] = u; this.v[k] = v; }
      }
      this.invalidate();
    }
    if (field.tableVersion !== this.sourceVersion) { this.sourceVersion = field.tableVersion; this.invalidate(); }
    const A = field.A, B = field.B;
    this.refresh(0, A.data, A.size); this.refresh(1, A.data ? A.prev : null, A.prevSize);
    this.refresh(2, B.data, B.size); this.refresh(3, B.data ? B.prev : null, B.prevSize);
    const a = this.tables[0].grid, a0 = this.tables[1].grid, b = this.tables[2].grid, b0 = this.tables[3].grid;
    const fadeA = A.fade, fadeB = B.fade, previousA = fadeA < 1 && A.prev, previousB = fadeB < 1 && B.prev;
    const morph = B.data ? field.morph : 0;
    for (let i = 0; i < this.count; i++) {
      const av = previousA ? a0[i] + (a[i] - a0[i]) * fadeA : a[i];
      const bv = previousB ? b0[i] + (b[i] - b0[i]) * fadeB : b[i];
      out[i] = morph <= 0 ? av : morph >= 1 ? bv : av + morph * (bv - av);
    }
    return out;
  }
}
