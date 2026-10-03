// Generates every Oro icon from one parametric drawing:
//   build/icon.svg, build/icon.png (1024, macOS grid), build/icon.ico (16..256)
//   public/favicon.svg, public/icon-192.png, public/icon-512.png,
//   public/icon-maskable-512.png, public/apple-touch-icon.png (180)
// plus a preview sheet in /tmp/orograph-shots/packaging/.
//
//   node dev/packaging/make-icons.cjs
//
// The artwork: stacked contour ridges forming a mountain, a tilted orbit ring
// around the summit (its back half hidden by the land) and the glowing dot.
// Small sizes use a simplified drawing with thicker strokes so it reads at 16 px.

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const SHOTS = '/tmp/orograph-shots/packaging';

const COPPER = '#ff7a45';
const r1 = (v) => Math.round(v * 10) / 10;

// Art space is 0..1000 on both axes and covers the icon tile.
const DETAIL = {
  full: {
    ridges: [
      { peakY: 245, color: '#ffa274', width: 30 },
      { peakY: 345, color: COPPER, width: 30 },
      { peakY: 445, color: '#e85f37', width: 30 },
      { peakY: 545, color: '#c4472f', width: 30 },
    ],
    drop: 470, hwLeft: 330, hwRight: 400, shoulder: 70, step: 6,
    ring: { cx: 500, cy: 455, rx: 345, ry: 100, tilt: -11, width: 18 },
    dot: { angle: 38, r: 40, glow: 120 },
  },
  // Two well separated ridges, a heavier ring and a big dot: survives 16 px.
  small: {
    ridges: [
      { peakY: 200, color: '#ff8b57', width: 104 },
      { peakY: 545, color: '#d9512c', width: 104 },
    ],
    drop: 520, hwLeft: 400, hwRight: 430, shoulder: 0, step: 20,
    ring: { cx: 500, cy: 420, rx: 405, ry: 118, tilt: -11, width: 66 },
    dot: { angle: 32, r: 104, glow: 170 },
    plain: true,
  },
  // In between, for 48 and 64 px (Windows Explorer, Linux docks).
  medium: {
    ridges: [
      { peakY: 230, color: '#ff9a68', width: 52 },
      { peakY: 390, color: COPPER, width: 52 },
      { peakY: 550, color: '#d24f2f', width: 52 },
    ],
    drop: 480, hwLeft: 360, hwRight: 410, shoulder: 55, step: 12,
    ring: { cx: 500, cy: 440, rx: 370, ry: 108, tilt: -11, width: 32 },
    dot: { angle: 36, r: 62, glow: 150 },
  },
};

function ridgeY(x, peakX, peakY, d) {
  const dx = x - peakX;
  const t = Math.min(1, Math.abs(dx) / (dx < 0 ? d.hwLeft : d.hwRight));
  // Steep near the summit, easing out to a flat valley floor.
  let y = peakY + d.drop * (1 - Math.pow(1 - t, 1.85));
  // A shoulder on the right flank keeps the silhouette from looking like a plain chevron.
  if (d.shoulder) y -= d.shoulder * Math.exp(-Math.pow((x - (peakX + 175)) / 70, 2));
  return y;
}

function ridgePath(peakX, peakY, d, closeTo) {
  const pts = [];
  // Run well past the tile so the lines still reach the edges when the drawing
  // is shrunk into a safe zone (maskable / touch icons); the tile clip trims them.
  for (let x = -300; x <= 1300; x += d.step) pts.push([x, ridgeY(x, peakX, peakY, d)]);
  // Make sure the exact summit is a vertex so the peak stays crisp.
  pts.push([peakX, peakY]);
  pts.sort((a, b) => a[0] - b[0]);
  const line = 'M' + pts.map(([x, y]) => `${r1(x)} ${r1(y)}`).join(' L');
  return closeTo === undefined ? line : `${line} L1300 ${closeTo} L-300 ${closeTo} Z`;
}

function ringPoint(ring, deg) {
  const a = (deg * Math.PI) / 180;
  const t = (ring.tilt * Math.PI) / 180;
  const x = ring.rx * Math.cos(a);
  const y = ring.ry * Math.sin(a);
  return [ring.cx + x * Math.cos(t) - y * Math.sin(t), ring.cy + x * Math.sin(t) + y * Math.cos(t)];
}

/**
 * @param {'full'|'small'} detail
 * @param {'mac'|'rounded'|'square'} frame  mac = Apple icon grid with margin and shadow,
 *        rounded = full-canvas rounded tile, square = full-bleed (iOS / maskable)
 * @param {number} contentScale  shrink the drawing inside a full-bleed square (safe zone)
 */
function iconSvg({ detail = 'full', frame = 'rounded', contentScale = 1, size = 1024, id = 'og' } = {}) {
  const d = DETAIL[detail];
  const peakX = 470;
  const radius = frame === 'square' ? 0 : 225;
  const tile = frame === 'mac' ? { x: 100, y: 100, s: 824 } : { x: 0, y: 0, s: 1024 };
  const k = tile.s / 1000;

  const ridges = d.ridges.map((r, i) => {
    const fillId = `${id}-land${i}`;
    return `<path d="${ridgePath(peakX + i * 10, r.peakY, d, 1300)}" fill="url(#${fillId})"/>` +
      `<path d="${ridgePath(peakX + i * 10, r.peakY, d)}" fill="none" stroke="${r.color}" stroke-width="${r.width}" stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join('\n      ');

  const landGradients = d.ridges.map((r, i) => {
    const top = r.peakY;
    return `<linearGradient id="${id}-land${i}" x1="0" y1="${top}" x2="0" y2="1000" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#231b5c"/><stop offset="1" stop-color="#0d0a26"/></linearGradient>`;
  }).join('\n    ');

  const ring = d.ring;
  const ringEl = (cls) => `<ellipse cx="${ring.cx}" cy="${ring.cy}" rx="${ring.rx}" ry="${ring.ry}" transform="rotate(${ring.tilt} ${ring.cx} ${ring.cy})" ${cls}/>`;
  const [dx, dy] = ringPoint(ring, d.dot.angle);

  const content = `
      <!-- back of the orbit: drawn first so the land hides it -->
      ${ringEl(`fill="none" stroke="#ffc9ad" stroke-opacity="0.55" stroke-width="${ring.width}"`)}
      ${d.plain ? '' : `<circle cx="${peakX}" cy="${d.ridges[0].peakY + 140}" r="360" fill="url(#${id}-halo)"/>`}
      ${ridges}
      <!-- front of the orbit -->
      <g clip-path="url(#${id}-front)">
        ${ringEl(`fill="none" stroke="#ffd9c4" stroke-width="${ring.width}"`)}
      </g>
      <circle cx="${r1(dx)}" cy="${r1(dy)}" r="${d.dot.glow}" fill="url(#${id}-glow)"/>
      <circle cx="${r1(dx)}" cy="${r1(dy)}" r="${d.dot.r}" fill="#fff3ea"/>`;

  const inner = contentScale === 1
    ? content
    : `<g transform="translate(${500 * (1 - contentScale)} ${500 * (1 - contentScale)}) scale(${contentScale})">${content}</g>`;

  const shadow = frame === 'mac'
    ? `<filter id="${id}-shadow" x="-10%" y="-10%" width="120%" height="125%">
        <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.35"/></filter>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
  <title>Oro</title>
  <defs>
    <radialGradient id="${id}-sky" cx="500" cy="330" r="760" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#2f2678"/><stop offset="0.55" stop-color="#18133f"/><stop offset="1" stop-color="#0b0920"/>
    </radialGradient>
    <radialGradient id="${id}-halo">
      <stop offset="0" stop-color="${COPPER}" stop-opacity="0.32"/><stop offset="1" stop-color="${COPPER}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${id}-glow">
      <stop offset="0" stop-color="#fff1e6" stop-opacity="0.95"/><stop offset="0.35" stop-color="#ff9a6a" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${COPPER}" stop-opacity="0"/>
    </radialGradient>
    ${landGradients}
    <clipPath id="${id}-tile"><rect x="0" y="0" width="1000" height="1000" rx="${radius}"/></clipPath>
    <clipPath id="${id}-front">
      <rect x="-200" y="${ring.cy}" width="1400" height="800" transform="rotate(${ring.tilt} ${ring.cx} ${ring.cy})"/>
    </clipPath>
    ${shadow}
  </defs>
  <g transform="translate(${tile.x} ${tile.y}) scale(${k})"${frame === 'mac' ? ` filter="url(#${id}-shadow)"` : ''}>
    <g clip-path="url(#${id}-tile)">
      <rect width="1000" height="1000" fill="url(#${id}-sky)"/>${inner}
    </g>${frame === 'square' ? '' : `
    <rect x="1.5" y="1.5" width="997" height="997" rx="${radius - 1.5}" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="3"/>`}
  </g>
</svg>
`;
}

async function render(page, svg, size, file) {
  await page.setViewportSize({ width: size, height: size });
  const sized = svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${sized}</body></html>`);
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  if (file) fs.writeFileSync(file, png);
  return png;
}

// ICO with PNG-compressed entries (supported since Windows Vista), largest last.
function buildIco(entries) {
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, png }, i) => {
    const o = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, o);
    header.writeUInt8(size >= 256 ? 0 : size, o + 1);
    header.writeUInt8(0, o + 2);
    header.writeUInt8(0, o + 3);
    header.writeUInt16LE(1, o + 4);
    header.writeUInt16LE(32, o + 6);
    header.writeUInt32LE(png.length, o + 8);
    header.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.png)]);
}

async function main() {
  fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'public'), { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  const appIcon = iconSvg({ detail: 'full', frame: 'mac' });
  const tileFull = iconSvg({ detail: 'full', frame: 'rounded' });
  const tileSmall = iconSvg({ detail: 'small', frame: 'rounded', id: 'ogs' });
  const tileMedium = iconSvg({ detail: 'medium', frame: 'rounded', id: 'ogm' });
  const pick = (s) => (s <= 32 ? tileSmall : s <= 64 ? tileMedium : tileFull);
  const maskable = iconSvg({ detail: 'full', frame: 'square', contentScale: 0.8 });
  const touch = iconSvg({ detail: 'full', frame: 'square', contentScale: 0.92 });

  fs.writeFileSync(path.join(ROOT, 'build', 'icon.svg'), appIcon);
  fs.writeFileSync(path.join(ROOT, 'public', 'favicon.svg'), tileSmall.replace(/width="1024" height="1024"/, 'width="32" height="32"'));

  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  await render(page, appIcon, 1024, path.join(ROOT, 'build', 'icon.png'));
  await render(page, tileFull, 512, path.join(ROOT, 'public', 'icon-512.png'));
  await render(page, tileFull, 192, path.join(ROOT, 'public', 'icon-192.png'));
  await render(page, maskable, 512, path.join(ROOT, 'public', 'icon-maskable-512.png'));
  await render(page, touch, 180, path.join(ROOT, 'public', 'apple-touch-icon.png'));

  const icoEntries = [];
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    icoEntries.push({ size, png: await render(page, pick(size), size) });
  }
  fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), buildIco(icoEntries));

  // Preview sheet: every size on a dark and a light surface, at 1:1 pixels.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const cell = (svg, s) => `<div style="display:inline-block;margin:8px;vertical-align:bottom;text-align:center">
    <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${s}" height="${s}"><br><small>${s}</small></div>`;
  const row = (bg, fg) => `<div style="background:${bg};color:${fg};padding:12px">
    ${sizes.map((s) => cell(pick(s), s)).join('')}
    ${cell(appIcon, 256)}${cell(maskable, 128)}${cell(touch, 90)}</div>`;
  await page.setViewportSize({ width: 1400, height: 760 });
  await page.setContent(`<!doctype html><body style="margin:0;font:12px system-ui">${row('#1e1e1e', '#ddd')}${row('#f4f4f4', '#333')}</body>`);
  await page.screenshot({ path: path.join(SHOTS, 'icons-preview.png'), fullPage: true });

  // Magnified small sizes so pixel-level legibility can be judged.
  const zoom = (png, s) => `<img src="data:image/png;base64,${png.toString('base64')}" width="${s * 5}" height="${s * 5}" style="image-rendering:pixelated;margin:6px;vertical-align:bottom">`;
  await page.setContent(`<!doctype html><body style="margin:0;background:#2a2a2a">${icoEntries.slice(0, 5).map((e) => zoom(e.png, e.size)).join('')}</body>`);
  await page.screenshot({ path: path.join(SHOTS, 'icons-small-zoom.png'), fullPage: true });

  await browser.close();
  console.log('icons written to build/ and public/; previews in', SHOTS);
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { iconSvg, buildIco };
