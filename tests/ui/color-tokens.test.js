import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contrast, parseColor, ensureContrast, partVars, hexToRgb, rgbToHex, terrainRamp } from '../../src/ui/color.js';
import { PART_COLORS } from '../../src/core/params.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.resolve(here, '../../src/styles/theme.css'), 'utf8');

function tokens(theme) {
  const m = css.match(new RegExp(`:root\\[data-theme="${theme}"\\] \\{([\\s\\S]*?)\\n\\}`));
  const out = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^\s*(--[\w-]+):\s*([^;]+);/);
    if (mm) out[mm[1]] = mm[2].trim();
  }
  return out;
}

describe('colour helpers', () => {
  it('parses and formats colours', () => {
    expect(hexToRgb('#ff7a45')).toEqual({ r: 255, g: 122, b: 69 });
    expect(hexToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(rgbToHex({ r: 255, g: 122, b: 69 })).toBe('#ff7a45');
    expect(parseColor('rgba(10, 20, 30, 0.5)')).toEqual({ r: 10, g: 20, b: 30 });
    expect(contrast(parseColor('#000'), parseColor('#fff'))).toBeCloseTo(21, 0);
  });
  it('ensureContrast reaches the requested ratio', () => {
    for (const bg of ['#fbf8f1', '#0e1320']) {
      for (const fg of PART_COLORS) {
        const out = ensureContrast(fg, bg, 4.5);
        expect(contrast(parseColor(out), parseColor(bg))).toBeGreaterThanOrEqual(4.49);
      }
    }
  });
  it('gives every part colour readable ink and visible arcs in both themes', () => {
    for (const theme of ['dark', 'light']) {
      const t = tokens(theme);
      const surfaces = [t['--panel-solid'], t['--panel-2'], t['--panel-3']];
      for (const c of PART_COLORS) {
        const v = partVars(c, theme, surfaces);
        for (const bg of surfaces) {
          expect(contrast(parseColor(v['--part-ink']), parseColor(bg))).toBeGreaterThanOrEqual(4.5);
          expect(contrast(parseColor(v['--part']), parseColor(bg))).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });
  it('builds a 256-step terrain ramp', () => {
    const lut = terrainRamp('#3fd0c9', 'dark');
    expect(lut.length).toBe(768);
  });
});

describe('theme tokens (WCAG AA)', () => {
  for (const theme of ['dark', 'light']) {
    const t = tokens(theme);
    const surfaces = ['--panel-solid', '--panel-2', '--bg'];
    it(`${theme}: body text levels reach 4.5:1 on every surface`, () => {
      for (const fg of ['--text', '--text-2', '--text-3', '--accent-ink', '--success', '--warn', '--error']) {
        for (const bg of surfaces) {
          const ratio = contrast(parseColor(t[fg]), parseColor(t[bg]));
          expect(ratio, `${fg} on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
    it(`${theme}: primary button text reaches 4.5:1`, () => {
      expect(contrast(parseColor(t['--accent-contrast']), parseColor(t['--accent']))).toBeGreaterThanOrEqual(4.5);
    });
    it(`${theme}: secondary text stays readable on raised controls`, () => {
      for (const fg of ['--text', '--text-2']) {
        expect(contrast(parseColor(t[fg]), parseColor(t['--panel-3']))).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});
