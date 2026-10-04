// Pitch tuner: sines, harmonic-rich saws, silence, and note naming.
// No browser. A reported note has confidence >= CLEAR_CONFIDENCE (0.5),
// which is 1 minus the cumulative mean normalized difference at the period.
import { describe, it, expect } from 'vitest';
import { detectPitch, hzToNote, CLEAR_CONFIDENCE, TUNER_TEXT } from '../../src/audio/tuner.js';

const SR = 48000;
const N = 4096;

function sine(hz, amp = 0.5, n = N) {
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return o;
}

/** Naive bipolar phase ramp (aliased saw). */
function saw(hz, amp = 0.5, n = N) {
  const o = new Float32Array(n);
  let phase = 0;
  const step = hz / SR;
  for (let i = 0; i < n; i++) {
    o[i] = amp * (2 * phase - 1);
    phase += step;
    if (phase >= 1) phase -= 1;
  }
  return o;
}

function centsOff(got, hz) {
  return Math.abs(1200 * Math.log2(got / hz));
}

describe('detectPitch', () => {
  it('finds sines within 5 cents', () => {
    for (const hz of [82.41, 110, 440, 1000]) {
      const r = detectPitch(sine(hz), SR);
      expect(r.confidence, `confidence at ${hz}`).toBeGreaterThan(CLEAR_CONFIDENCE);
      expect(r.confidence).toBeGreaterThan(0.5);
      expect(centsOff(r.hz, hz), `cents at ${hz} (got ${r.hz})`).toBeLessThan(5);
    }
  });

  it('keeps a naive saw on the fundamental, not the octave above', () => {
    for (const hz of [110, 220]) {
      const r = detectPitch(saw(hz), SR);
      expect(r.hz, `saw ${hz}`).toBeGreaterThan(0);
      expect(centsOff(r.hz, hz), `saw cents at ${hz} (got ${r.hz})`).toBeLessThan(15);
      expect(r.hz).toBeLessThan(hz * 1.5);
      expect(r.hz).toBeGreaterThan(hz * 0.75);
    }
  });

  it('returns no note for silence or a very quiet sine', () => {
    expect(detectPitch(new Float32Array(N), SR)).toEqual({ hz: 0, confidence: 0 });
    const quiet = detectPitch(sine(440, 0.001), SR);
    expect(quiet.hz).toBe(0);
    expect(quiet.confidence).toBe(0);
  });
});

describe('hzToNote', () => {
  it('maps 440 Hz at A4 = 440 to A4', () => {
    const a = hzToNote(440, 440);
    expect(a.note).toBe(69);
    expect(a.octave).toBe(4);
    expect(a.name).toBe('A');
    expect(a.cents).toBe(0);
  });

  it('maps 440 Hz against A4 = 442 as slightly flat of A4', () => {
    // midi = 69 + 12 * log2(440/442) = 68.92148..., rounds to 69.
    // cents = (midi - 69) * 100 = -7.851..., one decimal is -7.9.
    const b = hzToNote(440, 442);
    expect(b.note).toBe(69);
    expect(b.octave).toBe(4);
    expect(b.name).toBe('A');
    expect(b.cents).toBe(-7.9);
    expect(b.cents).toBeLessThan(0);
  });
});

describe('tuner copy', () => {
  it('has no em dashes in user-facing strings', () => {
    for (const s of Object.values(TUNER_TEXT)) {
      expect(s).not.toMatch(/\u2014/);
      expect(s).not.toMatch(/\u2013/);
    }
    expect(TUNER_TEXT.voiceOff).toBe('Turn Voice on to tune.');
    expect(TUNER_TEXT.inTune).toBe('In tune');
    expect(TUNER_TEXT.flat).toBe('Flat');
    expect(TUNER_TEXT.sharp).toBe('Sharp');
  });
});
