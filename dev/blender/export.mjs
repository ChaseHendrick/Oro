// Exports a blended Oro terrain (5x5 tiles) and a Rose orbit for the Blender hero render,
// using the app's own terrain, path and transform code (read-only imports from src/dsp).
// usage: node export.mjs out.json ['{"seedA":11,...}']   (optional JSON overrides)
import { generateTerrain } from '/home/user/synth/src/dsp/terrains.js';
import { samplePath, pathPoint } from '/home/user/synth/src/dsp/paths.js';
import { terrainHeight, makeTransform, applyTransform } from '/home/user/synth/src/dsp/terrain-math.js';
import { TERRAIN_INDEX, PATH_INDEX } from '/home/user/synth/src/dsp/catalog.js';
import fs from 'node:fs';

const cfg = Object.assign({
  terrainA: 'swell', seedA: 11, detailA: 0.35,
  terrainB: 'dunes', seedB: 5, detailB: 0.1,
  morph: 0.3,
  path: 'rose', order: 5, param: 0.38,       // Rose: 5 petals, Bloom 0.38 = round petals meeting near the centre
  stretch: 0, size: 0.22, rotate: 0, cx: 0.75, cy: 0.6,
  dotT: 0.0,                                  // phase of the dot on the orbit (0 = a petal tip)
  tiles: 5, R: 760, nOrbit: 1440,
}, process.argv[3] ? JSON.parse(process.argv[3]) : {});

const N = 512;
const A = generateTerrain(TERRAIN_INDEX[cfg.terrainA], { size: N, seed: cfg.seedA, detail: cfg.detailA });
const B = generateTerrain(TERRAIN_INDEX[cfg.terrainB], { size: N, seed: cfg.seedB, detail: cfg.detailB });
// The app's own height lookup (A/B morph, no warp): exactly what the audio engine reads.
const h = (u, v) => terrainHeight(A, N, B, N, cfg.morph, 0, u, v);

const { R, tiles } = cfg, u0 = -(tiles - 1) / 2;
const grid = new Array(R * R);
for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
  const u = u0 + tiles * i / (R - 1), v = u0 + tiles * j / (R - 1);
  grid[j * R + i] = +h(u, v).toFixed(4);
}

const shape = PATH_INDEX[cfg.path];
const pts = samplePath(shape, cfg.order, cfg.param, cfg.nOrbit);
const xf = makeTransform(cfg.stretch, cfg.size, cfg.rotate, 0, cfg.cx, cfg.cy, {});
const out = { u: 0, v: 0 }, orbit = [];
for (let k = 0; k < cfg.nOrbit; k++) {
  applyTransform(xf, pts[2 * k], pts[2 * k + 1], out);
  orbit.push([+out.u.toFixed(5), +out.v.toFixed(5), +h(out.u, out.v).toFixed(4)]);
}
const p = pathPoint(shape, cfg.dotT, cfg.order, cfg.param, { x: 0, y: 0 });
applyTransform(xf, p.x, p.y, out);
const dot = [out.u, out.v, h(out.u, out.v)];
fs.writeFileSync(process.argv[2], JSON.stringify({ R, tiles, u0, grid, orbit, dotT: cfg.dotT, dot, center: [cfg.cx, cfg.cy], cfg }));
console.log('exported', R, tiles, orbit.length, 'dot', dot.map(x => x.toFixed(3)).join(' '));
