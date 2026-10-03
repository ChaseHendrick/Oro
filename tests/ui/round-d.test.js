import { describe, it, expect } from 'vitest';
import { harmonics } from '../../src/ui/scope.js';
import { cyclePhase } from '../../src/ui/dsp-bridge.js';
import { formatParam } from '../../src/ui/formats.js';
import { sanitizeLink, suggestLink, LINK_SOURCES, LINK_CURVES, MAX_LINKS } from '../../src/ui/links-panel.js';
import { bounceName, stemName, slug } from '../../src/ui/bounce.js';
import { lfoValue, STEP_COUNT } from '../../src/ui/mod-popover.js';
import { freshMod } from '../../src/ui/mod-panel.js';
import { BEAT_CHOICES, DOT_DEFS } from '../../src/ui/dot-settings.js';
import { PART_PARAM_MAP, MOD_PARAM_IDS, MOD_DEFAULT } from '../../src/core/params.js';

describe('harmonic bars', () => {
  it('finds the harmonics of a known waveform', () => {
    const n = 192;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * i) / n) + 0.5 * Math.sin((2 * Math.PI * 3 * i) / n);
    const h = harmonics(x, 8);
    expect(h[0]).toBeCloseTo(1, 3);
    expect(h[1]).toBeCloseTo(0, 3);
    expect(h[2]).toBeCloseTo(0.5, 3);
  });
});

describe('cycle phase with Laps', () => {
  it('traces the path laps times per cycle', () => {
    expect(cyclePhase(0.25, 1, 0, 0)).toBeCloseTo(0.25);
    expect(cyclePhase(0.25, 2, 0, 0)).toBeCloseTo(0.5);
    expect(cyclePhase(0.75, 2, 0, 0)).toBeCloseTo(0.5);
    expect(cyclePhase(0.5, 1.5, 0, 0)).toBeCloseTo(0.75);
    const v = cyclePhase(0.3, 3, 0.5, 1);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });
});

describe('display formats', () => {
  it('reads naturally', () => {
    expect(formatParam(PART_PARAM_MAP.laps, 1)).toBe('1 lap');
    expect(formatParam(PART_PARAM_MAP.laps, 3)).toBe('3 laps');
    expect(formatParam(PART_PARAM_MAP.laps, 2.5)).toBe('2.50 laps');
    expect(formatParam(PART_PARAM_MAP.pan, 0)).toBe('Centre');
    expect(formatParam(PART_PARAM_MAP.pan, -0.3)).toBe('L 30');
    expect(formatParam(PART_PARAM_MAP.pace, 0.5)).toBe('+50%');
    if (PART_PARAM_MAP.formant) {
      expect(formatParam(PART_PARAM_MAP.formant, 0)).toBe('A');
      expect(formatParam(PART_PARAM_MAP.formant, 1)).toBe('U');
      expect(formatParam(PART_PARAM_MAP.formant, 0.125)).toBe('A-E');
    }
    if (PART_PARAM_MAP.airTone) expect(formatParam(PART_PARAM_MAP.airTone, -0.4)).toBe('Dark 40%');
    expect(formatParam(PART_PARAM_MAP.cutoff, 2500)).toMatch(/kHz/);
  });
});

describe('links', () => {
  it('sanitises and suggests links', () => {
    const l = sanitizeLink({ src: 99, dst: 'nope', amt: 4, curve: -2 });
    expect(l.src).toBe(LINK_SOURCES.length - 1);
    expect(MOD_PARAM_IDS).toContain(l.dst);
    expect(l.amt).toBe(1);
    expect(l.curve).toBe(0);
    const existing = [];
    for (let i = 0; i < MAX_LINKS; i++) existing.push(suggestLink(existing));
    expect(existing.length).toBe(MAX_LINKS);
    expect(LINK_CURVES.length).toBe(3);
  });
});

describe('bounce, steps LFO and dot settings', () => {
  it('names bounce files', () => {
    expect(bounceName(new Date(2026, 0, 2, 3, 4, 5))).toBe('oro-bounce-20260102-030405.wav');
    expect(bounceName(new Date(2026, 0, 2, 3, 4, 5), '-part1-bass')).toBe('oro-bounce-20260102-030405-part1-bass.wav');
    expect(stemName(new Date(2026, 0, 2, 3, 4, 5), 2)).toBe('oro-bounce-20260102-030405-track3.wav');
    expect(stemName(new Date(2026, 0, 2, 3, 4, 5), 5, 'Glass Bells')).toBe('oro-bounce-20260102-030405-track6-glass-bells.wav');
    expect(slug('Glass Orbit!')).toBe('glass-orbit');
    expect(slug('')).toBe('part');
  });
  it('plays the step values for the Steps shape', () => {
    const steps = Array.from({ length: STEP_COUNT }, (_, i) => (i % 2 ? -1 : 1));
    expect(lfoValue(6, 0.01, steps)).toBe(1);
    expect(lfoValue(6, 1 / STEP_COUNT + 0.001, steps)).toBe(-1);
    expect(lfoValue(6, 0.5)).toBeGreaterThanOrEqual(-1);
  });
  it('gives each cleared modulation its own step list', () => {
    const a = freshMod(), b = freshMod();
    expect(a.lfoDepth).toBe(0);
    if (Array.isArray(MOD_DEFAULT.steps)) {
      expect(a.steps).not.toBe(b.steps);
      expect(a.steps).toEqual(MOD_DEFAULT.steps);
    }
  });
  it('offers sensible Tour timings and dot ranges', () => {
    expect(BEAT_CHOICES[0]).toBe(0.25);
    expect(BEAT_CHOICES[BEAT_CHOICES.length - 1]).toBe(16);
    expect(DOT_DEFS.bounce.max).toBeLessThan(1);
    expect(DOT_DEFS.exploreRange.max).toBe(4);
  });
});
