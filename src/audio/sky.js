// Night sky terrain (2.10): real stars from the Yale Bright Star Catalogue
// (public/places/stars.json, built by scripts/build-places.mjs) projected
// into a height map. Every star is a soft peak whose height follows its
// brightness: magnitude is already logarithmic, so height is linear in
// magnitude and the faintest stars still show. Peaks combine with max, so
// a brighter star is always a higher peak however crowded its neighbours.

import { placesUrl, heightsToUserTerrain } from './places.js';

const RAD = Math.PI / 180;

/** Peak height 0..1 of a star of V magnitude `mag` (limit = faintest star used). */
export function starPeak(mag, limit = 5.5) {
  const v = (limit + 1 - mag) / (limit + 2.5);
  return v < 0.05 ? 0.05 : v > 1 ? 1 : v;
}

/**
 * Sky position -> 0..1 map position (x right, y down), or null when outside.
 * A view is { whole: true } (equirectangular, RA increasing to the left as
 * on a star chart) or { raDeg, decDeg, widthDeg } (gnomonic, north up, east left).
 */
export function projectStar(view, ra, dec) {
  if (view.whole) return { x: 1 - (((ra % 360) + 360) % 360) / 360, y: (90 - dec) / 180 };
  const d0 = view.decDeg * RAD, d = dec * RAD, da = (ra - view.raDeg) * RAD;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(da);
  if (cosc <= 0) return null;
  const X = Math.cos(d) * Math.sin(da) / cosc;
  const Y = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(da)) / cosc;
  const t = Math.tan(view.widthDeg / 2 * RAD);
  const x = 0.5 - X / (2 * t), y = 0.5 - Y / (2 * t);
  return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
}

/**
 * Height field (Float32Array n x n, 0..1) of `stars` ([raDeg, decDeg, vMag, ...]) in `view`.
 * @returns {{ heights: Float32Array, used: number }}
 */
export function skyHeights(stars, view, n = 256, { limit = 5.5 } = {}) {
  const out = new Float32Array(n * n);
  const scale = n / 256 * (view.whole ? 0.55 : 1);
  let used = 0;
  for (const s of stars) {
    if (!Array.isArray(s) || !(s[2] <= limit)) continue;
    const p = projectStar(view, s[0], s[1]);
    if (!p) continue;
    used++;
    const a = starPeak(s[2], limit);
    const sigma = Math.max(0.7, scale * (1 + 2.2 * a));
    const cx = p.x * n - 0.5, cy = p.y * n - 0.5, r = Math.ceil(sigma * 3), inv = 1 / (2 * sigma * sigma);
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(n - 1, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(n - 1, Math.ceil(cx + r)); x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2, v = a * Math.exp(-d2 * inv);
        if (v > out[y * n + x]) out[y * n + x] = v;
      }
    }
  }
  return { heights: out, used };
}

let starsCache = null;
export async function loadStars({ fetchFn = globalThis.fetch, base } = {}) {
  if (starsCache) return starsCache;
  const res = await fetchFn(placesUrl('stars.json', base));
  if (!res.ok) throw new Error('The star catalogue could not be loaded');
  const json = await res.json();
  if (!json || !Array.isArray(json.stars)) throw new Error('The star catalogue is damaged');
  starsCache = json;
  return json;
}

/** A night sky view (from places.json sky.views) as a stored terrain. */
export async function skyTerrain(view, opts = {}) {
  const cat = await loadStars(opts);
  const n = view.whole ? 512 : 256;
  const { heights } = skyHeights(cat.stars, view, n, { limit: cat.magLimit || 5.5 });
  return heightsToUserTerrain(heights, n, { name: `Night sky: ${view.name}`, placeId: view.id });
}
