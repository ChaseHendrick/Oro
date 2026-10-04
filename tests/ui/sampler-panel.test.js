import { describe, it, expect } from 'vitest';
import { SAMPLER_MAX_B64, SAMPLER_MAX_SECONDS, SAMPLER_RATE, sanitizeSampler } from '../../src/dsp/sampler.js';
import { pcmToBase64 } from '../../src/dsp/drum-kit.js';
import {
  REGION_GAP, midiNoteName, maxPcmSamples, cleanSampleName, fitSample, mixToMono, loopToSample,
  waveformPeaks, moveRegionHandle, pickRegionHandle,
} from '../../src/ui/sampler-model.js';

describe('sampler sample fit', () => {
  it('names a file without its extension, and caps the length', () => {
    expect(cleanSampleName('take.wav')).toBe('take');
    expect(cleanSampleName('notes.final.aiff')).toBe('notes.final');
    expect(cleanSampleName('Dr. Who')).toBe('Dr. Who');
    expect(cleanSampleName('.wav')).toBe('Sample');
    expect(cleanSampleName('x'.repeat(80))).toHaveLength(40);
  });

  it('trims to 16 seconds and to the base64 ceiling', () => {
    const long = fitSample(new Float32Array(SAMPLER_RATE * (SAMPLER_MAX_SECONDS + 2)), SAMPLER_RATE);
    expect(long.data.length).toBe(SAMPLER_RATE * SAMPLER_MAX_SECONDS);
    expect(long.trimmed).toBe(true);
    expect(long.rate).toBe(SAMPLER_RATE);

    const fast = fitSample(new Float32Array(96000 * SAMPLER_MAX_SECONDS), 96000);
    expect(fast.data.length).toBe(maxPcmSamples());
    expect(fast.data.length).toBeLessThan(96000 * SAMPLER_MAX_SECONDS);
    expect(fast.trimmed).toBe(true);
    expect(fast.rate).toBe(96000);

    const short = fitSample(new Float32Array([0.25, -0.5, 0]), 44100);
    expect([...short.data]).toEqual([0.25, -0.5, 0]);
    expect(short.trimmed).toBe(false);
    expect(short.rate).toBe(44100);
    expect(fitSample(new Float32Array([1]), 1000).rate).toBe(8000);
    expect(fitSample(new Float32Array([1]), Number.NaN).rate).toBe(SAMPLER_RATE);
  });

  it('keeps a capped buffer inside the sampler base64 limit', () => {
    const n = maxPcmSamples();
    expect(4 * Math.ceil((n * 2) / 3)).toBeLessThanOrEqual(SAMPLER_MAX_B64);
    expect(4 * Math.ceil(((n + 1) * 2) / 3)).toBeGreaterThan(SAMPLER_MAX_B64);
    const fit = fitSample(new Float32Array(SAMPLER_RATE * 20).fill(0.2), SAMPLER_RATE);
    const saved = sanitizeSampler({ on: 1, name: 'Recording', sample: { rate: fit.rate, data: pcmToBase64(fit.data) } });
    expect(saved.sample).not.toBeNull();
    expect(saved.sample.data.length).toBeLessThanOrEqual(SAMPLER_MAX_B64);
  });
});

describe('sampler loop grab', () => {
  it('mixes stereo to mono and ignores an empty loop', () => {
    const mono = mixToMono(new Float32Array([1, 1, 1]), new Float32Array([-1, 1]));
    expect([...mono]).toEqual([0, 1, 1]);
    expect([...mixToMono(new Float32Array([0.5, -0.5]), null)]).toEqual([0.5, -0.5]);
    expect(mixToMono(null, null).length).toBe(0);

    const fit = loopToSample({
      L: new Float32Array([1, 1, 1, 1]),
      R: new Float32Array([-1, -1, -1, -1]),
      sampleRate: 48000,
    });
    expect([...fit.data]).toEqual([0, 0, 0, 0]);
    expect(fit.rate).toBe(48000);
    expect(fit.trimmed).toBe(false);
    expect(loopToSample(null)).toBeNull();
    expect(loopToSample({ L: new Float32Array(0), R: new Float32Array(0), sampleRate: 48000 })).toBeNull();
  });

  it('caps a long loop without throwing', () => {
    const n = SAMPLER_RATE * 20;
    const fit = loopToSample({ L: new Float32Array(n).fill(0.4), R: new Float32Array(n).fill(0.2), sampleRate: SAMPLER_RATE });
    expect(fit.data.length).toBe(SAMPLER_RATE * SAMPLER_MAX_SECONDS);
    expect(fit.data[0]).toBeCloseTo(0.3);
    expect(fit.trimmed).toBe(true);
  });
});

describe('sampler waveform region', () => {
  it('buckets peaks and stays flat when there is no audio', () => {
    const peaks = waveformPeaks(new Float32Array([0, 1, -0.5, 0.25]), 2);
    expect([...peaks.min]).toEqual([0, -0.5]);
    expect([...peaks.max]).toEqual([1, 0.25]);
    const empty = waveformPeaks(new Float32Array(0), 4);
    expect(empty.min.length).toBe(4);
    expect([...empty.max].every((v) => v === 0)).toBe(true);
  });

  it('keeps the region start before the end', () => {
    expect(moveRegionHandle('start', 0.2, 0, 1)).toEqual({ start: 0.2, end: 1 });
    expect(moveRegionHandle('end', 0.4, 0.2, 0.8)).toEqual({ start: 0.2, end: 0.4 });
    const stuck = moveRegionHandle('start', 0.99, 0.2, 0.5);
    expect(stuck.end - stuck.start).toBeGreaterThanOrEqual(REGION_GAP - 1e-12);
    expect(stuck.start).toBeLessThan(stuck.end);
    const low = moveRegionHandle('end', 0, 0, 1);
    expect(low).toEqual({ start: 0, end: REGION_GAP });
    const high = moveRegionHandle('start', 1, 0, 1);
    expect(high.end - high.start).toBeCloseTo(REGION_GAP);
    expect(high.end).toBe(1);
  });

  it('picks the handle under the pointer', () => {
    expect(pickRegionHandle(20, 100, 0.2, 0.8)).toBe('start');
    expect(pickRegionHandle(80, 100, 0.2, 0.8)).toBe('end');
    expect(pickRegionHandle(78, 100, 0.2, 0.8)).toBe('end');
    expect(pickRegionHandle(50, 100, 0.2, 0.8)).toBe('start');
  });

  it('names MIDI notes the way the keyboard does', () => {
    expect(midiNoteName(60)).toBe('C4');
    expect(midiNoteName(69)).toBe('A4');
    expect(midiNoteName(0)).toBe('C-1');
  });
});
