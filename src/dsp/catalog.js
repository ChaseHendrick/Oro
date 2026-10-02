// Catalog of terrain and path (orbit) types.
// Pure data, no DOM: imported by the UI, the visuals and the audio worklet bundle.
// The index of an entry in these arrays is the numeric value stored in the
// `terrainA` / `terrainB` / `pathShape` parameters, so only ever APPEND entries.

export const TERRAINS = [
  { id: 'swell',    name: 'Swell',    desc: 'Rolling sine hills. Smooth, round, vocal tones.' },
  { id: 'ripple',   name: 'Ripple',   desc: 'Concentric waves around a centre, like a stone in a pond.' },
  { id: 'fm',       name: 'Bessel',   desc: 'Cosine field bent by a second cosine: FM-style bells and growls.' },
  { id: 'dunes',    name: 'Dunes',    desc: 'Wind-blown parallel ridges with a slow meander.' },
  { id: 'ridge',    name: 'Ridge',    desc: 'Sharp ridged noise mountains: bright, buzzy edges.' },
  { id: 'massif',   name: 'Massif',   desc: 'Layered fractal mountains: complex, evolving spectra.' },
  { id: 'crater',   name: 'Craters',  desc: 'A field of impact craters with raised rims.' },
  { id: 'terrace',  name: 'Terraces', desc: 'Stepped plateaus: hard edges, square-ish, gritty.' },
  { id: 'cells',    name: 'Cells',    desc: 'Cellular (Worley) basins: hollow, nasal tones.' },
  { id: 'canyon',   name: 'Canyon',   desc: 'Deep folded valleys carved through a plateau.' },
  { id: 'spectra',  name: 'Spectra',  desc: 'Classic waveforms stacked like a wavetable: sine to tri to saw to square.' },
  { id: 'lattice',  name: 'Lattice',  desc: 'A soft checkerboard grid: hollow square-wave buzz.' },
  { id: 'vortex',   name: 'Vortex',   desc: 'Spiral arms winding out from the centre.' },
  { id: 'user',     name: 'Imported', desc: 'Your own image (heightmap) or WAV wavetable.' },
];

// Every path is a closed curve traced once per oscillator cycle (t in [0,1)).
// `order` is an integer 1..8 and `param` a continuous 0..1 shape control;
// `orderLabel` / `paramLabel` describe what they do for that shape.
export const PATHS = [
  { id: 'ellipse',  name: 'Ellipse',     orderLabel: 'Harmonic', paramLabel: 'Skew',    desc: 'Circle that can be skewed into a line. The purest tone.' },
  { id: 'lissa',    name: 'Lissajous',   orderLabel: 'Ratio',    paramLabel: 'Phase',   desc: 'Two sine motions at a frequency ratio of n:(n+1).' },
  { id: 'rose',     name: 'Rose',        orderLabel: 'Petals',   paramLabel: 'Bloom',   desc: 'A rhodonea flower with n petals.' },
  { id: 'polygon',  name: 'Polygon',     orderLabel: 'Sides',    paramLabel: 'Round',   desc: 'Straight-edged polygon (triangle at 3) that can be rounded off.' },
  { id: 'star',     name: 'Star',        orderLabel: 'Points',   paramLabel: 'Pinch',   desc: 'A star with n points and adjustable inner radius.' },
  { id: 'spiral',   name: 'Spiral',      orderLabel: 'Turns',    paramLabel: 'Core',    desc: 'Spirals out and back in each cycle.' },
  { id: 'scan',     name: 'Scan',        orderLabel: 'Zigzag',   paramLabel: 'Slant',   desc: 'A straight sweep across the map, like reading a wavetable row.' },
  { id: 'spiro',    name: 'Spirograph',  orderLabel: 'Loops',    paramLabel: 'Pen',     desc: 'Hypotrochoid loops, like the classic drawing toy.' },
  { id: 'eight',    name: 'Figure 8',    orderLabel: 'Lobes',    paramLabel: 'Width',   desc: 'Lemniscate-style figure eight with extra lobes.' },
  { id: 'cusp',     name: 'Epicycloid',  orderLabel: 'Cusps',    paramLabel: 'Depth',   desc: 'A wheel rolling around a wheel: cardioids and cusps.' },
  { id: 'super',    name: 'Superformula', orderLabel: 'Symmetry', paramLabel: 'Pinch',  desc: 'Gielis superformula blobs and pinched stars.' },
  { id: 'scribble', name: 'Scribble',    orderLabel: 'Seed',     paramLabel: 'Chaos',   desc: 'A smooth random closed loop. Change the seed for a new one.' },
];

export const TERRAIN_NAMES = TERRAINS.map(t => t.name);
export const PATH_NAMES = PATHS.map(p => p.name);
export const TERRAIN_INDEX = Object.fromEntries(TERRAINS.map((t, i) => [t.id, i]));
export const PATH_INDEX = Object.fromEntries(PATHS.map((p, i) => [p.id, i]));
