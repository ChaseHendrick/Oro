// Colour data for the 3D map: terrain palettes (one ramp per theme), the two
// atmospheres (night and dawn) and helpers to blend them. Pure data and maths,
// no three.js, so the minimap and the tests can use it too.
//
// Every colour is authored in sRGB hex and converted once to linear RGB,
// because the renderer lights and blends in linear space.

export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c) {
  const v = c <= 0 ? 0 : c >= 1 ? 1 : c;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** '#rrggbb' -> [r, g, b] linear. Bad input gives mid grey. */
export function hexToLinear(hex) {
  const s = String(hex || '').replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map(ch => ch + ch).join('') : s.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [0.21, 0.21, 0.21];
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
}

const lin = (list) => list.map(hexToLinear);

// Six stops from the lowest valleys to the highest peaks.
export const PALETTES = [
  {
    name: 'Nocturne',
    tint: 0.22,
    dark: lin(['#060920', '#141d4a', '#243a77', '#29709a', '#5aa6c6', '#c2e6f2']),
    light: lin(['#36636f', '#648f86', '#a49b76', '#c6a984', '#ddc6a3', '#f3e8d5']),
  },
  {
    name: 'Aurora',
    tint: 0.18,
    dark: lin(['#020d0d', '#05302b', '#0d6555', '#27ab92', '#a29ef6', '#f1e8ff']),
    light: lin(['#2f7f7a', '#5fae9c', '#9fd0b8', '#cdcaee', '#ddd5f2', '#f6f2ff']),
  },
  {
    name: 'Ember',
    tint: 0.14,
    dark: lin(['#0a0506', '#2c0e0e', '#641e15', '#b44a1d', '#eb9a3b', '#fff0c8']),
    light: lin(['#7a3f2e', '#b26a4c', '#d69a72', '#e8bf98', '#f2dcc2', '#fdf5ea']),
  },
  {
    name: 'Glacier',
    tint: 0.2,
    dark: lin(['#020711', '#08203d', '#174a77', '#4589bb', '#a6d3ee', '#f4fbff']),
    light: lin(['#3f6a92', '#6e98bf', '#a2c2dc', '#c9dfee', '#e3eff7', '#fbfdff']),
  },
  {
    name: 'Mono',
    tint: 0.38,
    dark: lin(['#040507', '#12151b', '#272b34', '#4a505c', '#8b93a1', '#e8ebf1']),
    light: lin(['#55514b', '#7d7972', '#a5a19a', '#c8c4bd', '#e2dfd9', '#f8f7f4']),
  },
];

// Additional authored ramps, appended so the original five palette ids stay stable.
const EXTRA_RAMPS = [
  ['Forest', ['#04110a','#123c20','#2e6338','#57904d','#a6bd70','#edf2bf']],
  ['Desert', ['#19100c','#563628','#966246','#c9945f','#e6c28a','#fff1cc']],
  ['Ocean', ['#020b17','#072d55','#075d80','#1b94a1','#66c7c6','#d6fcdf']],
  ['Rose', ['#180713','#4b1735','#842853','#bd4977','#e895ab','#ffe4df']],
  ['Cobalt', ['#030819','#111b56','#273f9e','#4866d2','#91a4f2','#e5eaff']],
  ['Copper', ['#140b07','#472519','#80412b','#b56b40','#dcaa79','#f9e6c6']],
  ['Jade', ['#021410','#063f32','#15745a','#39a77c','#89d3a9','#dcffe6']],
  ['Amethyst', ['#0b041b','#29174c','#523778','#8058a7','#bb91d2','#f2ddff']],
  ['Solar', ['#1c0902','#702503','#bb5304','#e39b16','#f8d650','#fff9ba']],
  ['Sepia', ['#0d0b07','#342e1e','#625338','#9a855e','#c9b68d','#f6eccf']],
  ['Viridis', ['#440154','#414487','#2a788e','#22a884','#7ad151','#fde725']],
  ['Magma', ['#000004','#3b0f70','#8c2981','#de4968','#fe9f6d','#fcfdbf']],
  ['Icefire', ['#06243b','#216e91','#8ec1cc','#e5cdb3','#f0dfcc','#fff5e6']],
  ['Moss', ['#11160b','#363f19','#647230','#959b4e','#c7c57f','#f2ebbf']],
  ['Candy', ['#21123c','#615799','#cc78bf','#f3a6c0','#f5d1b8','#fff1d8']],
  ['Neon', ['#070b1c','#0b326d','#0c8090','#46d584','#b7e348','#ffecab']],
  ['Autumn', ['#1c0c08','#5c2515','#a94b1e','#d28329','#e1bb52','#f2e3aa']],
  ['Slate', ['#080f19','#233343','#496278','#7f97a8','#bac8cf','#f0f1eb']],
  ['Sandstone', ['#211620','#5b3a45','#936253','#bf9477','#dfc6a2','#fff1cf']],
];
for (const [name, colors] of EXTRA_RAMPS) {
  const dark = lin(colors);
  // Dawn ramps retain each authored hue while lifting the valley to paper.
  const light = dark.map((rgb, i) => rgb.map((c, k) => c * 0.58 + [0.72, 0.69, 0.62][k] * (0.32 + i * 0.012)));
  PALETTES.push({ name, tint: 0.16, dark, light });
}

// Heat-map style: one perceptual ramp, the same on both themes.
export const HEAT_RAMP = lin(['#0b0726', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf']);

export const PALETTE_NAMES = PALETTES.map(p => p.name);

function toHex(c) {
  const h = (x) => Math.round(linearToSrgb(x) * 255).toString(16).padStart(2, '0');
  return '#' + h(c[0]) + h(c[1]) + h(c[2]);
}

/** The palettes as sRGB hex ramps (valley to peak), for swatches in the UI. */
export const PALETTE_INFO = PALETTES.map(p => ({ name: p.name, dark: p.dark.map(toHex), light: p.light.map(toHex) }));

// Atmospheres. Scalars blend linearly, colours blend in linear RGB.
export const THEMES = {
  dark: {
    zenith: hexToLinear('#03050d'),
    horizon: hexToLinear('#1a2552'),
    ground: hexToLinear('#04060d'),
    fog: hexToLinear('#111a3a'),
    sunDir: [-0.42, 0.58, -0.7],
    sunColor: hexToLinear('#bccbff'),
    sunIntensity: 1.7,
    skyAmb: hexToLinear('#3c4f96'),
    groundAmb: hexToLinear('#08090f'),
    ambIntensity: 0.38,
    rim: hexToLinear('#8aa6ff'),
    rimIntensity: 0.55,
    contour: hexToLinear('#a9d8ff'),
    contourAlpha: 0.2,
    grid: hexToLinear('#8fb6ff'),
    gridAlpha: 0.1,
    edgeFade: hexToLinear('#0c1330'),
    stars: 1,
    aurora: 0.85,
    sun: 0,
    haze: 0.25,
    fogDensity: 0.022,
    bloomStrength: 0.62,
    bloomRadius: 0.55,
    bloomThreshold: 0.62,
    glow: 1,          // emissive gain for lines, rings, beads
    particles: 0,     // 0 fireflies, 1 pollen
    exposure: 1.05,
  },
  light: {
    zenith: hexToLinear('#7fb2df'),
    horizon: hexToLinear('#f7e8d4'),
    ground: hexToLinear('#e8dac4'),
    fog: hexToLinear('#f1e4d1'),
    sunDir: [0.55, 0.62, -0.56],
    sunColor: hexToLinear('#fff0d8'),
    sunIntensity: 1.0,
    skyAmb: hexToLinear('#b9d0ea'),
    groundAmb: hexToLinear('#b39874'),
    ambIntensity: 0.5,
    rim: hexToLinear('#fff6e8'),
    rimIntensity: 0.18,
    contour: hexToLinear('#4a3622'),
    contourAlpha: 0.26,
    grid: hexToLinear('#5a4632'),
    gridAlpha: 0.08,
    edgeFade: hexToLinear('#efe2cf'),
    stars: 0,
    aurora: 0,
    sun: 1,
    haze: 0.75,
    fogDensity: 0.016,
    bloomStrength: 0.22,
    bloomRadius: 0.4,
    bloomThreshold: 1.6,
    glow: 0.7,
    particles: 1,
    exposure: 0.92,
  },
};

function lerpArr(a, b, t, out) {
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

/** Fresh mutable atmosphere object shaped like THEMES.dark (allocate once, then blend into it). */
export function makeAtmosphere() {
  const o = {};
  for (const [k, v] of Object.entries(THEMES.dark)) o[k] = Array.isArray(v) ? v.slice() : v;
  return o;
}

/** Blend dark (t = 0) to light (t = 1) into `out` without allocating. */
export function blendAtmosphere(t, out) {
  const a = THEMES.dark, b = THEMES.light;
  for (const k in a) {
    const va = a[k], vb = b[k];
    if (Array.isArray(va)) lerpArr(va, vb, t, out[k]);
    else out[k] = va + (vb - va) * t;
  }
  return out;
}

/** Palette ramp for theme blend t, written into out (array of six [r, g, b]). */
export function blendRamp(index, t, out) {
  const p = PALETTES[((index % PALETTES.length) + PALETTES.length) % PALETTES.length];
  for (let i = 0; i < 6; i++) lerpArr(p.dark[i], p.light[i], t, out[i]);
  return out;
}

/** Evaluate a 6-stop ramp at x in [0, 1] (smooth piecewise linear) into out [r, g, b]. */
export function sampleRamp(ramp, x, out) {
  const f = (x <= 0 ? 0 : x >= 1 ? 1 : x) * (ramp.length - 1);
  const i = Math.min(Math.floor(f), ramp.length - 2);
  let a = f - i;
  a = a * a * (3 - 2 * a);
  const c0 = ramp[i], c1 = ramp[i + 1];
  out[0] = c0[0] + (c1[0] - c0[0]) * a;
  out[1] = c0[1] + (c1[1] - c0[1]) * a;
  out[2] = c0[2] + (c1[2] - c0[2]) * a;
  return out;
}

/**
 * Part colour as used in the scene. On the light theme saturated yellows and
 * cyans vanish against ivory, so the colour is pulled darker and richer there;
 * on the dark theme it is used as is. Returns linear [r, g, b] in out.
 */
export function sceneColor(hex, themeT, out) {
  return sceneColorLinear(hexToLinear(hex), themeT, out);
}

/** sceneColor() for an already linear [r, g, b] (no allocation). */
export function sceneColorLinear(c, themeT, out) {
  const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const k = 1 - themeT * Math.min(0.62, Math.max(0, (lum - 0.12) * 1.25));
  out[0] = c[0] * k; out[1] = c[1] * k; out[2] = c[2] * k;
  return out;
}
