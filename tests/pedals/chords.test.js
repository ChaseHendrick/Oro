import { describe, it, expect } from 'vitest';
import { createChordTracker, createRealSpectrum, trackChords, chordWindowSize, CHORD_MAX_NOTES } from '../../src/pedals/chords.js';
import { makeRandom } from '../../src/pedals/signal.js';
import { pluck, strum, mix, midiToHz, GUITAR_NOTES } from './signals.js';

const HEAVY = 60000;
const rates = [44100, 48000, 96000];
const ons = (events) => events.filter(e => e.type === 'noteOn');
const noteSet = (events) => [...new Set(ons(events).map(e => e.note))].sort((a, b) => a - b);
const silenceAfter = (signal, sampleRate, seconds = 0.25) => {
  const out = new Float32Array(signal.length + Math.round(seconds * sampleRate));
  out.set(signal);
  return out;
};

describe('real magnitude spectrum', () => {
  it('matches a direct DFT, including DC and Nyquist', () => {
    const N = 64;
    const random = makeRandom(14);
    const input = Float64Array.from({ length: N }, (_, i) => 0.1 + 0.3 * Math.sin(2 * Math.PI * 7 * i / N) + 0.2 * Math.cos(2 * Math.PI * 31 * i / N) + (i % 2 ? 0.15 : -0.15) + random() * 0.02);
    const actual = new Float64Array(N / 2 + 1);
    createRealSpectrum(N).magnitude(input, actual, 2 / N);
    for (let k = 0; k <= N / 2; k++) {
      let re = 0, im = 0;
      for (let i = 0; i < N; i++) {
        re += input[i] * Math.cos(2 * Math.PI * k * i / N);
        im -= input[i] * Math.sin(2 * Math.PI * k * i / N);
      }
      expect(actual[k]).toBeCloseTo(Math.hypot(re, im) * 2 / N, 12);
    }
  });
});

describe('experimental chord tracker', () => {
  it('scales its window duration with sample rate', () => {
    for (const rate of [22050, 44100, 48000, 88200, 96000, 192000]) {
      const size = chordWindowSize(rate);
      expect(size & (size - 1)).toBe(0);
      expect(size / rate).toBeGreaterThanOrEqual(0.08);
      expect(size / rate).toBeLessThan(0.16);
    }
  });

  it.each(rates)('%i Hz: isolated guitar notes have no harmonic ghosts', { timeout: HEAVY }, (sampleRate) => {
    for (const note of GUITAR_NOTES) {
      const signal = pluck({ sampleRate, freq: midiToHz(note), duration: 0.45, seed: note });
      const { events } = trackChords(signal, sampleRate);
      expect(ons(events).map(e => e.note), `MIDI ${note}`).toEqual([note]);
      const first = ons(events)[0];
      expect(first.time - 0.1).toBeGreaterThan(0.07);
      expect(first.time - 0.1).toBeLessThan(0.16);
      expect(Math.abs(1200 * Math.log2(first.freq / midiToHz(note)))).toBeLessThan(12);
      expect(first.sample).toBe(Math.round(first.time * sampleRate));
      expect(first.velocity).toBeGreaterThan(0);
      expect(first.velocity).toBeLessThanOrEqual(1);
    }
  });

  it.each(rates)('%i Hz: clean independent triads are fully detected', { timeout: HEAVY }, (sampleRate) => {
    for (const notes of [[48, 52, 55], [52, 55, 59]]) {
      for (const seed of [1, 2, 3]) {
        const { events, tracker } = trackChords(strum(notes, { sampleRate, seed, duration: 0.55 }), sampleRate);
        expect(noteSet(events)).toEqual(notes);
        expect(ons(events)).toHaveLength(notes.length);
        expect(tracker.sounding).toEqual(notes);
      }
    }
  });

  it.each(rates)('%i Hz: conservative common voicings create no extra notes', { timeout: HEAVY }, (sampleRate) => {
    // Shared harmonics make octave strings ambiguous. This regression checks
    // conservative precision and at least three useful notes, not full recall.
    const voicings = [[40, 47, 52, 55, 59, 64], [45, 52, 57, 60, 64], [48, 52, 55, 60, 64], [43, 47, 50, 55, 59, 67], [50, 57, 62, 66]];
    for (const notes of voicings) for (const seed of [1, 2]) {
      const { events } = trackChords(strum(notes, { sampleRate, seed, duration: 0.55 }), sampleRate);
      const actual = noteSet(events);
      expect(actual.length, String(notes)).toBeGreaterThanOrEqual(3);
      expect(actual.filter(m => !notes.includes(m)), String(notes)).toEqual([]);
      expect(actual.length).toBeLessThanOrEqual(CHORD_MAX_NOTES);
      expect(ons(events)).toHaveLength(actual.length);
    }
  });

  it('detects a low fifth without also emitting its upper partials', { timeout: HEAVY }, () => {
    for (const seed of [1, 2, 3, 4]) expect(noteSet(trackChords(strum([40, 47], { seed, duration: 0.55 }), 48000).events)).toEqual([40, 47]);
  });

  it('uses periodicity to retain a weak or missing fundamental', { timeout: HEAVY }, () => {
    for (const note of [40, 45, 64]) for (const amplitudes of [[0.08, 1, 0.6, 0.7, 0.3, 0.4, 0.2], [0, 1, 0.8, 0.5, 0.4, 0.3]]) {
      expect(noteSet(trackChords(pluck({ freq: midiToHz(note), amps: amplitudes, duration: 0.55 }), 48000).events)).toEqual([note]);
    }
  });

  it.each(rates)('%i Hz: broadband noise, DC and silence produce no notes', { timeout: HEAVY }, (sampleRate) => {
    const random = makeRandom(42);
    const noise = Float32Array.from({ length: Math.round(sampleRate * 0.6) }, () => (random() * 2 - 1) * 0.3);
    for (const signal of [noise, new Float32Array(noise.length).fill(0.3), new Float32Array(noise.length)]) {
      const { events } = trackChords(signal, sampleRate);
      expect(events).toEqual([]);
    }
  });

  it('ignores a short unpitched transient', () => {
    const random = makeRandom(7);
    const signal = new Float32Array(24000);
    for (let i = 4800; i < 4900; i++) signal[i] = random() * 2 - 1;
    expect(trackChords(signal, 48000).events).toEqual([]);
  });

  it('releases one independent string while the others still ring', { timeout: HEAVY }, () => {
    const sampleRate = 48000;
    const signal = mix(sampleRate, [
      { sig: pluck({ freq: midiToHz(52), start: 0.1, duration: 0.3, noise: 0 }) },
      { sig: pluck({ freq: midiToHz(55), start: 0.1, duration: 0.7, noise: 0 }) },
      { sig: pluck({ freq: midiToHz(59), start: 0.1, duration: 0.7, noise: 0 }) },
    ]);
    const { events, frames, tracker } = trackChords(signal, sampleRate, {}, { frames: true });
    expect(noteSet(events)).toEqual([52, 55, 59]);
    const off = events.find(e => e.type === 'noteOff' && e.note === 52);
    expect(off.time).toBeGreaterThan(0.4);
    expect(off.time).toBeLessThan(0.6);
    expect(frames.find(f => f.time > off.time && f.time < 0.75).notes).toEqual([55, 59]);
    expect(events.filter(e => e.type === 'noteOff').map(e => e.note).sort((a, b) => a - b)).toEqual([52, 55, 59]);
    expect(tracker.sounding).toEqual([]);
  });

  it('closes all notes promptly on silence and can play again', { timeout: HEAVY }, () => {
    const first = silenceAfter(strum([52, 55, 59], { duration: 0.35 }), 48000);
    const second = strum([52, 55, 59], { duration: 0.35 });
    const signal = mix(first.length + second.length + 12000, [{ sig: first }, { at: first.length, sig: second }]);
    const { events, tracker } = trackChords(signal, 48000);
    for (const note of [52, 55, 59]) {
      expect(ons(events).filter(e => e.note === note)).toHaveLength(2);
      expect(events.filter(e => e.type === 'noteOff' && e.note === note)).toHaveLength(2);
    }
    const off = events.filter(e => e.type === 'noteOff').slice(0, 3);
    expect(Math.max(...off.map(e => e.time))).toBeLessThan(0.5);
    expect(tracker.sounding).toEqual([]);
  });

  it('is deterministic across sample block sizes', { timeout: HEAVY }, () => {
    const signal = silenceAfter(strum([52, 55, 59], { duration: 0.35 }), 48000);
    const expected = trackChords(signal, 48000, {}, { block: 128 }).events;
    for (const block of [1, 997, 2048]) expect(trackChords(signal, 48000, {}, { block }).events).toEqual(expected);
  });

  it('releaseAll and reset clear public sounding state', { timeout: HEAVY }, () => {
    const signal = strum([52, 55, 59], { duration: 0.4 });
    const tracker = createChordTracker();
    tracker.process(signal);
    expect(tracker.sounding).toEqual([52, 55, 59]);
    const off = tracker.releaseAll().slice();
    expect(off.map(e => e.note).sort((a, b) => a - b)).toEqual([52, 55, 59]);
    expect(tracker.releaseAll()).toEqual([]);
    expect(tracker.sounding).toEqual([]);
    tracker.reset();
    expect(tracker.samples).toBe(0);
    expect(tracker.found).toEqual([]);
    expect(tracker.lastFrame.time).toBe(0);
    expect(noteSet(tracker.process(signal))).toEqual([52, 55, 59]);
  });

  it('rejects invalid scheduling sizes and ignores non-finite configuration', () => {
    for (const options of [{ sampleRate: 0 }, { windowSize: 3000 }, { hopSize: 0 }, { minSegment: 0 }, { maxNotes: 7 }, { maxMidi: 20 }, { maxHarmonics: 0 }]) {
      expect(() => createChordTracker(options)).toThrow(RangeError);
    }
    const tracker = createChordTracker();
    tracker.configure({ gateDb: NaN, relThreshold: Infinity, onsetRiseDb: NaN });
    expect(tracker.process(new Float32Array(8192).fill(NaN))).toEqual([]);
    expect(tracker.lastFrame.db).toBe(-240);
  });
});
