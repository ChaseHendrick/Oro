// Renders every procedural terrain (tiled 2x2 so seams would show) plus every
// path shape into PNG contact sheets: node dev/dsp/terrain-preview.mjs [outDir]
import { writeFileSync, mkdirSync } from 'node:fs';
import { TERRAINS, PATHS } from '../../src/dsp/catalog.js';
import { generateTerrain } from '../../src/dsp/terrains.js';
import { samplePath } from '../../src/dsp/paths.js';
import { encodePNG } from './png.mjs';

const outDir = process.argv[2] || '/tmp/orograph-shots/dsp';
mkdirSync(outDir, { recursive: true });

// Terrain sheet: 4 columns of 2x2-tiled 128px tiles (256px each).
const S = 128, TILE = 2 * S, COLS = 4;
const terr = TERRAINS.map((t, i) => i).filter(i => TERRAINS[i].id !== 'user');
const rowsN = Math.ceil(terr.length / COLS);
const W = COLS * (TILE + 8), H = rowsN * (TILE + 8);
const img = new Uint8Array(W * H * 3).fill(30);
terr.forEach((idx, n) => {
  const t0 = performance.now();
  const d = generateTerrain(idx, { size: 512, seed: 7, detail: 0.5 });
  const ms = performance.now() - t0;
  console.log(TERRAINS[idx].id.padEnd(8), ms.toFixed(1), 'ms');
  const ox = (n % COLS) * (TILE + 8) + 4, oy = Math.floor(n / COLS) * (TILE + 8) + 4;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const sx = ((x % S) * 4), sy = ((y % S) * 4);
      const h = d[sy * 512 + sx];
      const g = Math.max(0, Math.min(255, Math.round((h * 0.5 + 0.5) * 255)));
      const o = ((oy + y) * W + ox + x) * 3;
      img[o] = g; img[o + 1] = Math.round(g * 0.9 + 20 * (h > 0)); img[o + 2] = Math.round(g * 0.8 + 40 * (h < 0));
    }
  }
});
writeFileSync(`${outDir}/terrains.png`, encodePNG(img, W, H));

// Path sheet: each shape at orders 1..4 and params 0, 0.5, 1.
const P = 120, PW = 12 * (P + 6), PH = 4 * 3 * (P + 6);
const pim = new Uint8Array(PW * PH * 3).fill(20);
PATHS.forEach((path, s) => {
  for (let o = 1; o <= 4; o++) {
    [0, 0.5, 1].forEach((param, pi) => {
      const pts = samplePath(s, o, param, 2000);
      const ox = s * (P + 6) + 3, oy = ((o - 1) * 3 + pi) * (P + 6) + 3;
      for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) {
        const q = ((oy + y) * PW + ox + x) * 3; pim[q] = pim[q + 1] = pim[q + 2] = 40;
      }
      for (let i = 0; i < 2000; i++) {
        const x = Math.round((pts[2 * i] * 0.48 + 0.5) * (P - 1)), y = Math.round((-pts[2 * i + 1] * 0.48 + 0.5) * (P - 1));
        const q = ((oy + y) * PW + ox + x) * 3;
        pim[q] = 255; pim[q + 1] = 160 + Math.round(90 * i / 2000); pim[q + 2] = 60;
      }
    });
  }
});
writeFileSync(`${outDir}/paths.png`, encodePNG(pim, PW, PH));
console.log('wrote', `${outDir}/terrains.png`, `${outDir}/paths.png`);
