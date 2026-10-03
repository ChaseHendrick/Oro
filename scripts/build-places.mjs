#!/usr/bin/env node
// Builds the "Real places" assets in public/places/ (run by hand; the output
// is committed, the app never calls these services):
//
//   earth-<id>.png  Earth: AWS Terrain Tiles (terrarium PNG tiles), stitched
//   moon-<id>.png   Moon: LRO LOLA global DEM, 256 pixels per degree (USGS)
//   mars-<id>.png   Mars: MGS MOLA global DEM, 128 pixels per degree (USGS)
//   stars.json      Yale Bright Star Catalogue, 5th revised edition (CDS V/50)
//   places.json     names, coordinates, real elevation ranges, sources
//
// Each place is cropped to a square on the ground, resampled to 256 x 256
// and stretched over 16 bits; places.json keeps the real range in metres.
// The planetary DEMs are gigabytes, so only the needed parts of the needed
// rows are read with HTTP range requests.
//
//   node scripts/build-places.mjs            (PLACES_CACHE=dir caches downloads)
//
// Node built-ins only.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  decodePng, encodeGray16Png, terrariumHeights, resampleArea, normalise16,
  lonLatToPixel, metresPerPixel, localToLatLon, parseBscLine,
} from './places-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'places');
const SIZE = 256;
const CACHE = process.env.PLACES_CACHE || '';

const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const LOLA = 'https://planetarymaps.usgs.gov/mosaic/Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif';
const MOLA = 'https://planetarymaps.usgs.gov/mosaic/Mars_MGS_MOLA_DEM_mosaic_global_463m.tif';
const BSC5 = 'https://cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz';

// Crop centres are the commonly published coordinates of each feature;
// widthKm is the side of the square on the ground.
const EARTH = [
  { id: 'grand-canyon', name: 'Grand Canyon', lat: 36.0990, lon: -112.1120, widthKm: 24, fact: 'Carved by the Colorado River through the Colorado Plateau in Arizona, USA.' },
  { id: 'everest', name: 'Mount Everest', lat: 27.9881, lon: 86.9250, widthKm: 20, fact: 'The highest mountain above sea level, on the border of Nepal and China.' },
  { id: 'mariana-trench', name: 'Mariana Trench', lat: 11.3500, lon: 142.2000, widthKm: 200, fact: 'Around Challenger Deep, the deepest known part of the ocean floor. Ocean depths come from coarser bathymetry.' },
  { id: 'yosemite', name: 'Yosemite Valley', lat: 37.7300, lon: -119.5900, widthKm: 16, fact: 'A glacier-carved valley in California, USA, between El Capitan and Half Dome.' },
  { id: 'eyjafjallajokull', name: 'Eyjafjallajökull', lat: 63.6314, lon: -19.6083, widthKm: 24, fact: 'An ice-capped volcano in southern Iceland whose 2010 eruption closed much of Europe\'s airspace.' },
  { id: 'fuji', name: 'Mount Fuji', lat: 35.3606, lon: 138.7274, widthKm: 30, fact: 'The highest mountain in Japan, a symmetrical stratovolcano.' },
  { id: 'kilimanjaro', name: 'Kilimanjaro', lat: -3.0674, lon: 37.3556, widthKm: 50, fact: 'The highest mountain in Africa, a volcano in Tanzania.' },
  { id: 'matterhorn', name: 'Matterhorn', lat: 45.9763, lon: 7.6586, widthKm: 12, fact: 'A pyramid-shaped peak of the Alps on the border of Switzerland and Italy.' },
  { id: 'mauna-kea', name: 'Mauna Kea', lat: 19.8207, lon: -155.4681, widthKm: 60, fact: 'A volcano on the island of Hawaii. Measured from its base on the sea floor it is taller than Everest.' },
  { id: 'dead-sea', name: 'Dead Sea Rift', lat: 31.5000, lon: 35.4800, widthKm: 60, fact: 'The shores of the Dead Sea are the lowest land on Earth, in the rift between Israel, the West Bank and Jordan.' },
];

const MOON = [
  { id: 'tycho', name: 'Tycho', lat: -43.31, lon: -11.36, widthKm: 150, fact: 'A young crater about 85 km across, the centre of the brightest ray system on the Moon.' },
  { id: 'copernicus', name: 'Copernicus', lat: 9.62, lon: -20.08, widthKm: 160, fact: 'A crater about 93 km across with terraced walls and central peaks.' },
  { id: 'apennines', name: 'Montes Apenninus', lat: 18.91, lon: -3.67, widthKm: 400, fact: 'The mountain range on the south-east edge of Mare Imbrium, near the Apollo 15 landing site.' },
  { id: 'shackleton', name: 'Shackleton crater', lat: -89.67, lon: 129.78, widthKm: 50, fact: 'A crater about 21 km across at the lunar south pole. Its floor never sees the Sun.' },
];

const MARS = [
  { id: 'olympus-mons', name: 'Olympus Mons', lat: 18.65, lon: -133.80, widthKm: 800, fact: 'One of the largest volcanoes in the solar system, about 600 km across.' },
  { id: 'valles-marineris', name: 'Valles Marineris', lat: -13.90, lon: -59.20, widthKm: 1800, fact: 'A canyon system more than 4,000 km long. This view shows its central part.' },
  { id: 'hellas', name: 'Hellas basin', lat: -42.40, lon: 70.50, widthKm: 2800, fact: 'An impact basin about 2,300 km across that holds the lowest ground on Mars.' },
  { id: 'gale', name: 'Gale crater', lat: -5.40, lon: 137.80, widthKm: 220, fact: 'A crater about 154 km across with Mount Sharp at its centre, where the Curiosity rover landed in 2012.' },
];

// Night sky views: gnomonic fields centred on a constellation, plus the whole sky.
const SKY = [
  { id: 'orion', name: 'Orion', ra: 84, dec: 3, widthDeg: 34 },
  { id: 'ursa-major', name: 'Ursa Major', ra: 182, dec: 55, widthDeg: 36 },
  { id: 'cassiopeia', name: 'Cassiopeia', ra: 14, dec: 61, widthDeg: 26 },
  { id: 'scorpius', name: 'Scorpius', ra: 252, dec: -28, widthDeg: 32 },
  { id: 'southern-cross', name: 'Southern Cross and the Pointers', ra: 199, dec: -61, widthDeg: 30 },
  { id: 'whole-sky', name: 'Whole sky', whole: true },
];
const STAR_MAG_LIMIT = 5.5;
// Proper names for the stars a view can report as its brightest, checked
// against the catalogue's own Bayer name below.
const PROPER = { 1713: ['Rigel', 'Bet Ori'], 2061: ['Betelgeuse', 'Alp Ori'], 4905: ['Alioth', 'Eps UMa'], 4301: ['Dubhe', 'Alp UMa'],
  168: ['Schedar', 'Alp Cas'], 21: ['Caph', 'Bet Cas'], 264: ['Gamma Cassiopeiae', 'Gam Cas'], 6134: ['Antares', 'Alp Sco'], 5459: ['Alpha Centauri', 'Alp1Cen'],
  2491: ['Sirius', 'Alp CMa'], 4730: ['Acrux', 'Alp1Cru'], 5267: ['Hadar', 'Bet Cen'] };

// ---- fetching ------------------------------------------------------------------

async function get(url, start, end, tries = 4) {
  const key = CACHE && crypto.createHash('sha1').update(`${url}|${start}|${end}`).digest('hex');
  if (key && fs.existsSync(path.join(CACHE, key))) return new Uint8Array(fs.readFileSync(path.join(CACHE, key)));
  for (let attempt = 1; ; attempt++) {
    try {
      const headers = start != null ? { Range: `bytes=${start}-${end - 1}` } : {};
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      if (start != null && res.status !== 206) throw new Error('the server ignored the byte range');
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (start != null && bytes.length !== end - start) throw new Error(`short read ${bytes.length} of ${end - start}`);
      if (key) { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(path.join(CACHE, key), bytes); }
      return bytes;
    } catch (err) {
      if (attempt >= tries) throw new Error(`${url}: ${err.message}`);
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ---- GeoTIFF rows by range request ----------------------------------------------

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 11: 4, 12: 8, 16: 8 };

async function tiffInfo(url) {
  const head = await get(url, 0, 65536);
  const dv = new DataView(head.buffer);
  const le = head[0] === 0x49, big = dv.getUint16(2, le) === 43;
  const u64 = (v, o) => Number(v.getBigUint64(o, le));
  const ifd = big ? u64(dv, 8) : dv.getUint32(4, le);
  const buf = ifd + 4096 <= head.length ? head.subarray(ifd) : await get(url, ifd, ifd + 4096);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = big ? u64(v, 0) : v.getUint16(0, le);
  const tags = {};
  for (let i = 0; i < n; i++) {
    const e = big ? 8 + i * 20 : 2 + i * 12;
    const tag = v.getUint16(e, le), type = v.getUint16(e + 2, le), count = big ? u64(v, e + 4) : v.getUint32(e + 4, le);
    const vo = big ? e + 12 : e + 8, inline = count * (TYPE_SIZE[type] || 1) <= (big ? 8 : 4);
    const first = type === 3 ? v.getUint16(vo, le) : type === 16 ? u64(v, vo) : v.getUint32(vo, le);
    tags[tag] = { type, count, value: first, offset: inline ? -1 : (big ? u64(v, vo) : v.getUint32(vo, le)) };
  }
  const info = {
    url, le, width: tags[256].value, height: tags[257].value, bits: tags[258].value, compression: tags[259].value,
    rowsPerStrip: tags[278]?.value ?? 0, sampleFormat: tags[339]?.value ?? 1, strips: tags[273],
  };
  if (info.compression !== 1 || info.rowsPerStrip !== 1) throw new Error(`${url}: only uncompressed one-row strips are supported`);
  return info;
}

async function stripOffsets(info, r0, r1) {
  const s = info.strips, size = TYPE_SIZE[s.type];
  const bytes = await get(info.url, s.offset + r0 * size, s.offset + (r1 + 1) * size);
  const dv = new DataView(bytes.buffer);
  return Array.from({ length: r1 - r0 + 1 }, (_, i) => size === 8 ? Number(dv.getBigUint64(i * 8, info.le)) : dv.getUint32(i * 4, info.le));
}

function readSample(dv, i, info) {
  if (info.bits === 16) return info.sampleFormat === 2 ? dv.getInt16(i * 2, info.le) : dv.getUint16(i * 2, info.le);
  if (info.bits === 32 && info.sampleFormat === 3) return dv.getFloat32(i * 4, info.le);
  throw new Error('unsupported sample type');
}

/**
 * A square of `widthKm` on a planet (equirectangular global DEM, `ppd`
 * pixels per degree, west edge -180, north edge 90) seen from straight
 * above (azimuthal equidistant about its centre): bilinear samples on a
 * 512 x 512 grid, averaged down to SIZE.
 */
async function planetPlace(place, ds) {
  const N = SIZE * 2, half = place.widthKm / 2, info = ds.info;
  const coords = new Float64Array(N * N * 2);
  const need = new Map();   // row -> [minCol, maxCol]
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = ((i + 0.5) / N * 2 - 1) * half, y = (1 - (j + 0.5) / N * 2) * half;
    const { lat, lon } = localToLatLon(x, y, place.lat, place.lon, ds.radiusKm);
    const row = Math.max(0, Math.min(info.height - 1, (90 - lat) * ds.ppd - 0.5));
    let col = (lon + 180) * ds.ppd - 0.5;
    col = ((col % info.width) + info.width) % info.width;
    coords[(j * N + i) * 2] = row; coords[(j * N + i) * 2 + 1] = col;
    const r0 = Math.floor(row), c0 = Math.floor(col);
    for (const r of [r0, Math.min(info.height - 1, r0 + 1)]) {
      const span = need.get(r) || [Infinity, -Infinity];
      span[0] = Math.min(span[0], c0); span[1] = Math.max(span[1], Math.min(info.width - 1, c0 + 1));
      need.set(r, span);
    }
  }
  const rows = [...need.keys()].sort((a, b) => a - b);
  const offsets = await stripOffsets(info, rows[0], rows[rows.length - 1]);
  const bps = info.bits / 8;
  const data = new Map();
  let bytes = 0;
  await pool(rows, 24, async (r) => {
    const [c0, c1] = need.get(r);
    // A crop across the date line or round a pole reads the whole row.
    const wraps = c1 - c0 > info.width / 2;
    const a = wraps ? 0 : c0, b = wraps ? info.width - 1 : c1;
    const start = offsets[r - rows[0]] + a * bps, buf = await get(info.url, start, start + (b - a + 1) * bps);
    bytes += buf.length;
    const dv = new DataView(buf.buffer), vals = new Float64Array(b - a + 1);
    for (let k = 0; k < vals.length; k++) vals[k] = readSample(dv, k, info) * ds.scale;
    data.set(r, { a, vals });
  });
  const at = (r, c) => { const d = data.get(r); return d.vals[Math.min(d.vals.length - 1, Math.max(0, c - d.a))]; };
  const grid = new Float64Array(N * N);
  let rawMin = Infinity, rawMax = -Infinity;
  for (let p = 0; p < N * N; p++) {
    const row = coords[p * 2], col = coords[p * 2 + 1];
    const r0 = Math.floor(row), r1 = Math.min(info.height - 1, r0 + 1), fr = row - r0;
    const c0 = Math.floor(col), c1 = Math.min(info.width - 1, c0 + 1), fc = col - c0;
    const top = at(r0, c0) * (1 - fc) + at(r0, c1) * fc, bot = at(r1, c0) * (1 - fc) + at(r1, c1) * fc;
    const v = top * (1 - fr) + bot * fr;
    grid[p] = v;
    for (const s of [at(r0, c0), at(r0, c1), at(r1, c0), at(r1, c1)]) { if (s < rawMin) rawMin = s; if (s > rawMax) rawMax = s; }
  }
  console.log(`  ${place.id}: ${rows.length} rows, ${(bytes / 1048576).toFixed(1)} MB read`);
  return { heights: resampleArea(grid, N, N, SIZE, SIZE), rawMin, rawMax, sourceMetresPerPixel: Math.round(Math.PI / 180 * ds.radiusKm * 1000 / ds.ppd) };
}

// ---- Earth tiles -------------------------------------------------------------

async function earthPlace(place) {
  const target = place.widthKm * 1000 / 768;
  const z = Math.max(1, Math.min(15, Math.round(Math.log2(metresPerPixel(place.lat, 0) / target))));
  const mpp = metresPerPixel(place.lat, z), c = lonLatToPixel(place.lat, place.lon, z);
  const W = Math.round(place.widthKm * 1000 / mpp), x0 = Math.round(c.x - W / 2), y0 = Math.round(c.y - W / 2);
  const tx0 = Math.floor(x0 / 256), tx1 = Math.floor((x0 + W - 1) / 256), ty0 = Math.floor(y0 / 256), ty1 = Math.floor((y0 + W - 1) / 256);
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push({ tx, ty });
  const tiles = new Map();
  await pool(jobs, 8, async ({ tx, ty }) => {
    const png = decodePng(await get(`${TERRARIUM}/${z}/${tx}/${ty}.png`));
    tiles.set(`${tx}/${ty}`, terrariumHeights(png));
  });
  const grid = new Float64Array(W * W);
  let rawMin = Infinity, rawMax = -Infinity;
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const gx = x0 + x, gy = y0 + y, t = tiles.get(`${Math.floor(gx / 256)}/${Math.floor(gy / 256)}`);
    const v = t[(gy % 256) * 256 + (gx % 256)];
    grid[y * W + x] = v;
    if (v < rawMin) rawMin = v;
    if (v > rawMax) rawMax = v;
  }
  console.log(`  ${place.id}: zoom ${z}, ${jobs.length} tiles, ${W} px across`);
  return { heights: resampleArea(grid, W, W, SIZE, SIZE), rawMin, rawMax, zoom: z, sourceMetresPerPixel: Math.round(mpp) };
}

// ---- output ------------------------------------------------------------------

function writePlace(body, place, r, extra) {
  const { data, min, max } = normalise16(r.heights);
  const file = `${body}-${place.id}.png`;
  const png = encodeGray16Png(data, SIZE, SIZE);
  fs.writeFileSync(path.join(OUT, file), png);
  const round = (v) => Math.round(v);
  return {
    id: `${body}-${place.id}`, name: place.name, lat: place.lat, lon: place.lon, widthKm: place.widthKm, file, bytes: png.length,
    minM: Number(min.toFixed(2)), maxM: Number(max.toFixed(2)), rawMinM: round(r.rawMin), rawMaxM: round(r.rawMax),
    sourceMetresPerPixel: r.sourceMetresPerPixel, ...extra, fact: place.fact,
  };
}

function gnomonicInside(view, ra, dec) {
  const rad = Math.PI / 180, d0 = view.dec * rad, d = dec * rad, da = (ra - view.ra) * rad;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(da);
  if (cosc <= 0) return false;
  const X = Math.cos(d) * Math.sin(da) / cosc, Y = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(da)) / cosc;
  const t = Math.tan(view.widthDeg / 2 * rad);
  return Math.abs(X) <= t && Math.abs(Y) <= t;
}

async function buildSky() {
  const text = zlib.gunzipSync(await get(BSC5)).toString('latin1');
  const all = text.split('\n').map(parseBscLine).filter(Boolean);
  const betelgeuse = all.find(s => s.hr === 2061);
  if (!betelgeuse || Math.abs(betelgeuse.ra - 88.79) > 0.02 || Math.abs(betelgeuse.mag - 0.5) > 0.01) throw new Error('BSC5 columns did not parse as expected');
  for (const [hr, [, bayer]] of Object.entries(PROPER)) {
    const s = all.find(x => x.hr === Number(hr));
    if (!s || !s.name.replace(/\s+/g, ' ').includes(bayer.replace(/\s+/g, ' '))) throw new Error(`HR ${hr} is not ${bayer} (${s?.name})`);
  }
  const stars = all.filter(s => s.mag <= STAR_MAG_LIMIT).sort((a, b) => a.mag - b.mag || a.hr - b.hr);
  const json = { source: 'Yale Bright Star Catalogue, 5th revised edition (Hoffleit and Warren 1991), CDS catalogue V/50', url: BSC5, epoch: 'J2000',
    magLimit: STAR_MAG_LIMIT, count: stars.length, fields: ['raDeg', 'decDeg', 'vMag', 'hr'],
    stars: stars.map(s => [Number(s.ra.toFixed(3)), Number(s.dec.toFixed(3)), Number(s.mag.toFixed(2)), s.hr]) };
  const body = JSON.stringify(json);
  fs.writeFileSync(path.join(OUT, 'stars.json'), body);
  const views = SKY.map(v => {
    const inside = v.whole ? stars : stars.filter(s => gnomonicInside(v, s.ra, s.dec));
    const top = inside[0];
    const proper = PROPER[top.hr]?.[0] || top.name.replace(/^\d+/, '').trim() || `HR ${top.hr}`;
    return { id: `sky-${v.id}`, name: v.name, ...(v.whole ? { whole: true } : { raDeg: v.ra, decDeg: v.dec, widthDeg: v.widthDeg }),
      stars: inside.length, brightest: proper, brightestHr: top.hr, brightestMag: top.mag };
  });
  console.log(`  stars.json: ${stars.length} stars to V ${STAR_MAG_LIMIT}, ${body.length} bytes`);
  return { file: 'stars.json', bytes: Buffer.byteLength(body), magLimit: STAR_MAG_LIMIT, count: stars.length, views };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const manifest = {
    version: 1, size: SIZE, bits: 16,
    note: 'Heights are 16-bit grey PNGs. Elevation in metres = minM + value / 65535 * (maxM - minM). rawMinM and rawMaxM are the extremes of the source pixels in the crop.',
    sources: {
      terrarium: { name: 'AWS Terrain Tiles (terrarium encoding)', url: `${TERRARIUM}/{z}/{x}/{y}.png`, docs: 'https://github.com/tilezen/joerd/blob/master/docs/attribution.md' },
      lola: { name: 'LRO LOLA Global DEM 118 m (LDEM_256, March 2014), 256 pixels per degree, heights relative to a 1737.4 km sphere', url: LOLA, credit: 'NASA Goddard Space Flight Center LOLA team; mosaic by USGS Astrogeology Science Center' },
      mola: { name: 'MGS MOLA Global DEM 463 m (MEGDR merge), 128 pixels per degree, heights relative to the Mars areoid', url: MOLA, credit: 'NASA Goddard Space Flight Center MOLA team; mosaic by USGS Astrogeology Science Center' },
      bsc5: { name: 'Yale Bright Star Catalogue, 5th revised edition (Hoffleit and Warren 1991)', url: BSC5, credit: 'Yale University Observatory; distributed by NASA ADC and CDS' },
    },
    earth: [], moon: [], mars: [], sky: null,
  };
  console.log('Earth');
  for (const p of EARTH) manifest.earth.push(writePlace('earth', p, await earthPlace(p), { source: 'terrarium' }));
  const lola = { info: await tiffInfo(LOLA), ppd: 256, scale: 0.5, radiusKm: 1737.4 };
  console.log('Moon');
  for (const p of MOON) manifest.moon.push(writePlace('moon', p, await planetPlace(p, lola), { source: 'lola' }));
  const mola = { info: await tiffInfo(MOLA), ppd: 128, scale: 1, radiusKm: 3396.19 };
  console.log('Mars');
  for (const p of MARS) manifest.mars.push(writePlace('mars', p, await planetPlace(p, mola), { source: 'mola' }));
  console.log('Night sky');
  manifest.sky = await buildSky();
  fs.writeFileSync(path.join(OUT, 'places.json'), JSON.stringify(manifest, null, 1) + '\n');
  const total = fs.readdirSync(OUT).reduce((s, f) => s + fs.statSync(path.join(OUT, f)).size, 0);
  console.log(`public/places: ${(total / 1024).toFixed(0)} KB in total`);
}

main().catch((err) => { console.error(err); process.exit(1); });
