// Colour maths for part colours. A part colour is chosen for a dark night
// background; on the light ivory theme the same yellow would vanish, so the UI
// derives a tone that keeps at least 3:1 contrast (WCAG non-text contrast)
// against the panel colour of whichever theme is active.

export function hexToRgb(hex) {
  let s = String(hex || '').trim().replace('#', '');
  if (s.length === 3) s = s.split('').map(c => c + c).join('');
  const n = parseInt(s.slice(0, 6), 16);
  if (!Number.isFinite(n) || s.length < 6) return { r: 128, g: 128, b: 128 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }) {
  const c = v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}

/** Parse '#rrggbb', '#rgb' or 'rgb(a)(r, g, b[, a])' into {r, g, b}. */
export function parseColor(str) {
  const s = String(str || '').trim();
  const m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (m) return { r: +m[1], g: +m[2], b: +m[3] };
  return hexToRgb(s);
}

export function mix(a, b, t) {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

function channel(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function luminance({ r, g, b }) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Move `fg` towards black or white (whichever direction increases contrast
 * against `bg`) until it reaches `ratio`. Keeps the hue recognisable.
 */
export function ensureContrast(fg, bg, ratio) {
  const f = typeof fg === 'string' ? parseColor(fg) : fg;
  const b = typeof bg === 'string' ? parseColor(bg) : bg;
  if (contrast(f, b) >= ratio) return rgbToHex(f);
  const target = luminance(b) > 0.4 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  let lo = 0, hi = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (contrast(mix(f, target, mid), b) >= ratio) hi = mid; else lo = mid;
  }
  // Rounding to 8-bit channels can land a hair under the ratio; step on until it holds.
  let hex = rgbToHex(mix(f, target, hi));
  while (contrast(hexToRgb(hex), b) < ratio && hi < 1) {
    hi = Math.min(1, hi + 0.004);
    hex = rgbToHex(mix(f, target, hi));
  }
  return hex;
}

export function withAlpha(hex, a) {
  const { r, g, b } = typeof hex === 'string' ? parseColor(hex) : hex;
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
}

/**
 * CSS custom properties for one part colour in the active theme.
 * `--part` is safe for arcs, borders and small glyphs; `--part-ink` is safe
 * for text (4.5:1); the soft / glow variants are decorative.
 */
export function partVars(hex, theme, surfaces) {
  // Tune against every surface the colour can sit on (panels, cards, raised
  // controls), so it holds its contrast on the least favourable one.
  const list = (Array.isArray(surfaces) ? surfaces : [surfaces]).filter(Boolean);
  if (!list.length) list.push(theme === 'light' ? '#fbf7ef' : '#0f1422');
  const base = parseColor(hex);
  let ui = rgbToHex(base), ink = rgbToHex(base);
  for (const bg of list) {
    ui = ensureContrast(ui, bg, 3);
    ink = ensureContrast(ink, bg, 4.6);
  }
  return {
    '--part-raw': rgbToHex(base),
    '--part': ui,
    '--part-ink': ink,
    '--part-soft': withAlpha(ui, theme === 'light' ? 0.12 : 0.16),
    '--part-line': withAlpha(ui, theme === 'light' ? 0.4 : 0.45),
    '--part-glow': withAlpha(base, theme === 'light' ? 0 : 0.55),
    '--part-contrast': luminance(parseColor(ui)) > 0.35 ? '#0b0f18' : '#ffffff',
  };
}

export function applyVars(el, vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v);
  }
}

/**
 * Terrain colour ramp (height -1..1 -> rgb) built from the part colour, used by
 * thumbnails and the flat map so previews look like the 3D view's palette.
 */
export function terrainRamp(hex, theme) {
  const p = parseColor(hex);
  const stops = theme === 'light'
    ? [[0, mix({ r: 233, g: 223, b: 204 }, p, 0.08)], [0.45, mix({ r: 214, g: 196, b: 168 }, p, 0.35)], [0.75, mix(p, { r: 120, g: 70, b: 40 }, 0.25)], [1, mix(p, { r: 60, g: 30, b: 15 }, 0.45)]]
    : [[0, { r: 8, g: 11, b: 22 }], [0.4, mix({ r: 18, g: 26, b: 48 }, p, 0.2)], [0.75, mix({ r: 30, g: 40, b: 70 }, p, 0.7)], [1, mix(p, { r: 255, g: 255, b: 255 }, 0.55)]];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k], [t1, c1] = stops[k + 1];
    const c = mix(c0, c1, Math.min(1, Math.max(0, (t - t0) / (t1 - t0))));
    lut[i * 3] = c.r; lut[i * 3 + 1] = c.g; lut[i * 3 + 2] = c.b;
  }
  return lut;
}
