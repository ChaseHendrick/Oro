// Real places (2.10): Earth, Moon and Mars height maps built by
// scripts/build-places.mjs into public/places/ (16-bit grey PNGs plus
// places.json). Nothing is fetched until the person opens Real places, and
// a chosen place becomes an ordinary imported terrain (kind 'image') with a
// placeId, so sessions, undo and the DSP need nothing new.

import { heightFromPng, heightsToPlanes, smoothHeights } from './heightmap.js';
import { bytesToBase64 } from './importers.js';

export const PLACE_BODIES = Object.freeze(['earth', 'moon', 'mars']);
export const PLACE_ID_RE = /^(earth|moon|mars|sky)-[a-z0-9-]{1,40}$/;
const DIR = 'places/';

export const PLACE_CREDITS = Object.freeze({
  terrarium: 'Earth: AWS Terrain Tiles. 3DEP, SRTM and GMTED2010 data courtesy of the U.S. Geological Survey; ETOPO1 from NOAA; EU-DEM produced using Copernicus data and information funded by the European Union; other sources as listed in the Third-party notices.',
  lola: 'Moon: LRO LOLA global elevation (NASA Goddard Space Flight Center), mosaic by USGS Astrogeology Science Center.',
  mola: 'Mars: MGS MOLA global elevation (NASA Goddard Space Flight Center), mosaic by USGS Astrogeology Science Center.',
  bsc5: 'Stars: Yale Bright Star Catalogue, 5th revised edition (Hoffleit and Warren 1991), via CDS.',
});

/** Credits line for the About tab and the guide. */
export const REAL_DATA_CREDITS = 'Earth: AWS Terrain Tiles (USGS, NOAA, Copernicus and others). Moon: NASA LRO LOLA. Mars: NASA MGS MOLA (USGS Astrogeology mosaics). Stars: Yale Bright Star Catalogue. Weather: Open-Meteo.com (CC BY 4.0).';

export function placesUrl(file, base) {
  const root = base || globalThis.document?.baseURI || 'http://localhost/';
  return new URL(DIR + file, root).href;
}

const OFFLINE = 'Real places could not be loaded. They need the web app or the desktop app with its places folder; the single-file offline build does not include them.';
let manifest = null;

function validEntry(e) {
  return e && typeof e === 'object' && PLACE_ID_RE.test(e.id) && typeof e.name === 'string' && /^[a-z0-9-]+\.png$/.test(e.file)
    && [e.lat, e.lon, e.minM, e.maxM].every(Number.isFinite);
}

/** places.json (cached once it loads). Throws a readable error when it cannot be fetched. */
export async function loadPlaces({ fetchFn = globalThis.fetch, base } = {}) {
  if (manifest) return manifest;
  let json;
  try {
    const res = await fetchFn(placesUrl('places.json', base));
    if (!res.ok) throw new Error(String(res.status));
    json = await res.json();
  } catch {
    throw new Error(OFFLINE);
  }
  if (!json || typeof json !== 'object') throw new Error(OFFLINE);
  const out = { sources: json.sources || {}, sky: json.sky && Array.isArray(json.sky.views) ? json.sky : null };
  for (const body of PLACE_BODIES) out[body] = Array.isArray(json[body]) ? json[body].filter(validEntry) : [];
  manifest = out;
  return out;
}

/** Tests. */
export function _resetPlaces() { manifest = null; }

/** Height field (Float32Array, n x n) -> a stored terrain, exactly as an import stores one. */
export function heightsToUserTerrain(heights, n, { name, placeId, smooth = 0 } = {}) {
  const field = smooth > 0 ? smoothHeights(heights, n, smooth, 'mirror') : heights;
  const planes = heightsToPlanes(field);
  return {
    name: String(name || 'Terrain').slice(0, 80), kind: 'image', w: n, h: n, mirror: 1,
    data: bytesToBase64(planes.hi), lo: bytesToBase64(planes.lo),
    ...(placeId && PLACE_ID_RE.test(placeId) ? { placeId } : {}),
  };
}

/** Fetch one place's PNG and turn it into a stored terrain. */
export async function placeTerrain(entry, { fetchFn = globalThis.fetch, base } = {}) {
  let bytes;
  try {
    const res = await fetchFn(placesUrl(entry.file, base));
    if (!res.ok) throw new Error(String(res.status));
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    throw new Error(`${entry.name} could not be loaded. ${OFFLINE}`);
  }
  const { heights, n } = await heightFromPng(bytes, { channel: 'r', size: 256 });
  return heightsToUserTerrain(heights, n, { name: entry.name, placeId: entry.id });
}

export function formatMetres(m) {
  const v = Math.round(m);
  return `${v < 0 ? '\u2212' : ''}${Math.abs(v).toLocaleString('en-US')} m`;
}

export function formatCoord(lat, lon) {
  const f = (v, pos, neg) => `${Math.abs(v).toFixed(2)}° ${v >= 0 ? pos : neg}`;
  return `${f(lat, 'N', 'S')}, ${f(lon, 'E', 'W')}`;
}

/** Short facts for a place, all taken from the processed data in places.json. */
export function placeFacts(entry) {
  const lines = [];
  if (Number.isFinite(entry.rawMinM) && Number.isFinite(entry.rawMaxM)) {
    lines.push(`Elevation in this view: ${formatMetres(entry.rawMinM)} to ${formatMetres(entry.rawMaxM)}`);
  }
  lines.push(`${formatCoord(entry.lat, entry.lon)}, ${entry.widthKm} km across`);
  if (entry.sourceMetresPerPixel) lines.push(`Source data about ${entry.sourceMetresPerPixel} m per pixel`);
  if (entry.source === 'lola') lines.push('Heights are relative to a sphere of radius 1,737.4 km');
  if (entry.source === 'mola') lines.push('Heights are relative to the Mars areoid (its "sea level")');
  return lines;
}
