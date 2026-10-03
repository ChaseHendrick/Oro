import { describe, it, expect, vi } from 'vitest';
import { MinimapTerrainSampler, minimapSrgbByte } from '../../src/visual/minimap-sampling.js';
import { HeightField } from '../../src/visual/heightfield.js';
import { linearToSrgb } from '../../src/visual/palettes.js';
import { createMinimap } from '../../src/visual/hud.js';

const SIZE = 16;
function source(phase, size = 32) {
  return Float32Array.from({ length: size * size }, (_, i) => Math.sin(i % size / size * Math.PI * 2 + phase) * Math.cos(Math.floor(i / size) / size * Math.PI * 2));
}
function reference(field) {
  return Float32Array.from({ length: SIZE * SIZE }, (_, i) => field.norm((i % SIZE + .5) / SIZE, (Math.floor(i / SIZE) + .5) / SIZE));
}
function setup() {
  const field = new HeightField(), sampler = new MinimapTerrainSampler(SIZE), out = new Float32Array(SIZE * SIZE);
  field.setTable('A', source(0), 32); field.setTable('B', source(.8), 32);
  return { field, sampler, out };
}

describe('cached minimap terrain sampling', () => {
  it('equals direct height sampling across morph, warp and lift without rebuilding unchanged tables', () => {
    const { field, sampler, out } = setup();
    for (const warp of [0, .15, .5, 1]) {
      let lookups;
      for (const morph of [0, .1, .4, 1]) {
        field.setShape(morph, warp, .5 + morph * 2);
        sampler.sample(field, out); expect(out).toEqual(reference(field));
        if (lookups !== undefined) expect(sampler.lookups).toBe(lookups);
        lookups = sampler.lookups;
      }
    }
  });
  it('keeps both source fades live and invalidates on new image/channel/mapping tables', () => {
    const { field, sampler, out } = setup();
    sampler.sample(field, out);
    field.setTable('A', source(1.7, 64), 64, true); field.setTable('B', source(2.3), 32, true);
    for (const warp of [0, .4]) for (const a of [0, .2, .7]) for (const b of [0, .4, .8]) {
      field.setShape(.6, warp, 1); field.setFade('A', a); field.setFade('B', b);
      sampler.sample(field, out); expect(out).toEqual(reference(field));
    }
    field.setFade('A', 1); field.setFade('B', 1); sampler.sample(field, out); expect(out).toEqual(reference(field));
  });
  it('refreshes reused source arrays on installation and clears removed sources', () => {
    const { field, sampler, out } = setup(); sampler.sample(field, out);
    field.A.data.fill(.75); field.setTable('A', field.A.data, 32); sampler.sample(field, out);
    expect(out).toEqual(reference(field)); expect(out[0]).toBe(.75);
    field.setTable('A', null, 0); field.setTable('B', null, 0); sampler.sample(field, out);
    expect(out.every(value => value === 0)).toBe(true);
  });
  it('keeps sRGB channel output within one byte for all palette/shading amplitudes', () => {
    for (let i = -1000; i <= 101000; i++) {
      const value = i / 100000;
      const expected = Math.round(linearToSrgb(value) * 255);
      expect(Math.abs(minimapSrgbByte(value) - expected)).toBeLessThanOrEqual(1);
    }
    expect(minimapSrgbByte(NaN)).toBe(0); expect(minimapSrgbByte(Infinity)).toBe(255);
  });
  it('recolours cached heights when palette, lighting, tint or lift changes', () => {
    let pixels;
    const context = { createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: image => { pixels = image.data.slice(); }, clearRect() {}, drawImage() {} };
    const element = () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, removeEventListener() {}, remove() {}, getContext: () => context });
    vi.stubGlobal('document', { createElement: element }); vi.stubGlobal('window', { devicePixelRatio: 1 });
    try {
      const { field } = setup(), minimap = createMinimap(element());
      const ramp = Array.from({ length: 6 }, (_, i) => [.03 + i * .1, .02 + i * .07, .01 + i * .04]);
      const draw = (colors = ramp, tint = [.2, .3, .4], amount = 0, sun = [1, 1, 0]) => { minimap.renderTerrain(field, colors, tint, amount, sun); return pixels; };
      const before = draw();
      expect(draw(ramp.map(color => [...color].reverse()))).not.toEqual(before);
      expect(draw(ramp, [.8, .1, .2], .8)).not.toEqual(before);
      expect(draw(ramp, [.2, .3, .4], 0, [-1, 1, 0])).not.toEqual(before);
      field.setShape(0, 0, 2.5); expect(draw()).not.toEqual(before);
      expect(pixels.every((value, i) => i % 4 !== 3 || value === 255)).toBe(true);
      minimap.dispose();
    } finally { vi.unstubAllGlobals(); }
  });
});
