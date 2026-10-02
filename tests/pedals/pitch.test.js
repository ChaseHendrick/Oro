import { describe, it, expect } from 'vitest';
import { createEnvelopeFollower, createMpm, createPitchTracker, trackBuffer, quantizeNote, createPeriodicityMeter } from '../../src/pedals/pitch.js';
import { makeRandom, dbToGain } from '../../src/pedals/signal.js';
import { pluck, mix, GUITAR_NOTES, midiToHz } from './signals.js';

// Signal-heavy tests: generous timeouts, the CI box may be busy.
const HEAVY = 60000;

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const nameOf = (m) => NAMES[m % 12] + (Math.floor(m / 12) - 1);
const notesOf = (events) => events.filter(e => e.type !== 'bend').map(e => (e.type === 'noteOn' ? '+' : '-') + e.note + (e.legato ? 'L' : ''));
const bendsOf = (events) => events.filter(e => e.type === 'bend').map(e => e.semitones);

describe('envelope follower', () => {
  it('attack and release are one-pole time constants', () => {
    const sr = 48000;
    const env = createEnvelopeFollower({ sampleRate: sr, attackMs: 5, releaseMs: 100, gateDb: -80 });
    const one = new Float32Array(Math.round(0.005 * sr)).fill(1);
    expect(env.process(one).level).toBeCloseTo(1 - Math.exp(-1), 2);
    env.process(new Float32Array(sr).fill(1));
    expect(env.level).toBeCloseTo(1, 4);
    env.process(new Float32Array(Math.round(0.1 * sr)));
    expect(env.level).toBeCloseTo(Math.exp(-1), 2);
  });

  it('gate opens at gateDb, closes 3 dB lower, and the output is dB-scaled 0..1', () => {
    const sr = 48000;
    const env = createEnvelopeFollower({ sampleRate: sr, attackMs: 1, releaseMs: 1, gateDb: -40 });
    const at = (db) => new Float32Array(4800).fill(dbToGain(db));
    expect(env.process(at(-45)).open).toBe(false);
    expect(env.value).toBe(0);
    expect(env.process(at(-38)).open).toBe(true);
    expect(env.process(at(-42)).open).toBe(true);   // inside the hysteresis
    expect(env.process(at(-44)).open).toBe(false);
    env.process(at(-20));
    expect(env.value).toBeCloseTo(0.5, 2);           // -20 dB is half way from -40 to 0
    env.process(at(0));
    expect(env.value).toBeCloseTo(1, 2);
    env.configure({ gateDb: -60 });
    env.process(at(-30));
    expect(env.value).toBeCloseTo(0.5, 2);
  });
});

describe('McLeod pitch method', () => {
  it('pure tones from 70 Hz to 1.4 kHz within half a cent, clarity near 1', () => {
    const sr = 48000;
    const mpm = createMpm({ sampleRate: sr });
    for (const f of [70, 82.41, 110, 196, 329.63, 659.26, 987.77, 1318.51, 1400]) {
      const x = new Float32Array(2048);
      for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * f * i / sr + 0.3);
      const r = mpm.analyze(x);
      expect(Math.abs(1200 * Math.log2(r.freq / f))).toBeLessThan(0.5);
      expect(r.clarity).toBeGreaterThan(0.98);
    }
  });

  it('noise has low clarity, silence has none', () => {
    const rnd = makeRandom(2);
    const x = new Float32Array(2048).map(() => rnd() * 2 - 1);
    expect(createMpm({ sampleRate: 48000 }).analyze(x).clarity).toBeLessThan(0.6);
    expect(createMpm({ sampleRate: 48000 }).analyze(new Float32Array(2048)).clarity).toBe(0);
    expect(createPeriodicityMeter({ sampleRate: 48000 }).measure(x).clarity).toBeLessThan(0.6);
  });

  it('octave guard: a weak or missing fundamental still reads as the fundamental', () => {
    const sr = 48000;
    const mpm = createMpm({ sampleRate: sr });
    for (const [f, amps] of [[82.41, [0.05, 1, 0.6, 0.7, 0.3]], [110, [0, 1, 0.8, 0.5, 0.4]], [146.83, [0.15, 1, 0.1, 0.6, 0.05, 0.3]]]) {
      const x = new Float32Array(2048);
      for (let i = 0; i < x.length; i++) for (let k = 0; k < amps.length; k++) x[i] += amps[k] * Math.sin(2 * Math.PI * f * (k + 1) * i / sr + k);
      const r = mpm.analyze(x);
      expect(Math.abs(1200 * Math.log2(r.freq / f))).toBeLessThan(2);
    }
  });
});

describe('note quantisation with hysteresis', () => {
  it('a new note must come within ±40 cents of its own pitch', () => {
    expect(quantizeNote(60.3)).toBe(60);
    expect(quantizeNote(60.55, 60)).toBe(60); // past half way but not within 40 cents of 61
    expect(quantizeNote(60.62, 60)).toBe(61);
    expect(quantizeNote(59.45, 60)).toBe(60);
    expect(quantizeNote(59.38, 60)).toBe(59);
    expect(quantizeNote(62.1, 60)).toBe(62);
  });
});

describe('pitch tracker on synthetic plucked strings', () => {
  const report = [];
  const cases = [];
  for (const sr of [48000, 44100]) for (const m of GUITAR_NOTES) cases.push([sr, m]);

  it.each(cases)('%i Hz: MIDI %i plays the right note quickly and in tune', { timeout: HEAVY }, (sr, m) => {
    const start = 0.1;
    // Exact harmonics: measures the tracker itself.
    const clean = pluck({ sampleRate: sr, freq: midiToHz(m), duration: 0.9, start, seed: m });
    const a = trackBuffer(clean, sr, {}, { frames: true });
    // Real strings are slightly inharmonic (stiffness): upper partials run sharp.
    const stiff = pluck({ sampleRate: sr, freq: midiToHz(m), duration: 0.9, start, seed: m + 1, inharm: m < 50 ? 1e-4 : 2e-5 });
    const b = trackBuffer(stiff, sr, {}, { frames: true });
    for (const run of [a, b]) {
      const ons = run.events.filter(e => e.type === 'noteOn');
      expect(ons.map(e => e.note)).toEqual([m]);
      expect(run.events.filter(e => e.type === 'noteOff')).toHaveLength(0);
    }
    const latency = (a.events.find(e => e.type === 'noteOn').time - start) * 1000;
    const cents = (run) => {
      const v = run.frames.filter(f => f.voiced && f.time > start + 0.1 && f.time < start + 0.85).map(f => Math.abs(f.midi - m) * 100).sort((x, y) => x - y);
      return { med: v[v.length >> 1], max: v[v.length - 1] };
    };
    const ca = cents(a), cb = cents(b);
    report.push({ sr, m, latency, ca, cb });
    // Low E needs a full 2 periods of 70 Hz before it can be sure: ~29 ms + a hop or two.
    expect(latency).toBeLessThanOrEqual(m <= 45 ? 45 : m <= 59 ? 35 : 25);
    // Above 1 kHz the period is only ~36 samples and the parabolic peak fit has
    // about a cent of bias; far below what anyone hears (about 5 cents).
    expect(ca.med).toBeLessThan(m > 81 ? 1.5 : 0.5);
    expect(ca.max).toBeLessThan(2);
    expect(cb.med).toBeLessThan(12);
  });

  it('prints the accuracy / latency table', () => {
    const lines = report.map(r => `  ${String(r.sr).padEnd(6)} ${nameOf(r.m).padEnd(4)} ${midiToHz(r.m).toFixed(1).padStart(7)} Hz  first note ${r.latency.toFixed(1).padStart(5)} ms   exact harmonics: median ${r.ca.med.toFixed(2)} c, max ${r.ca.max.toFixed(2)} c   stiff string: median ${r.cb.med.toFixed(2)} c`);
    console.log('[pedals] pitch tracker, synthetic plucks (time from pick to note-on; cents vs true f0):\n' + lines.join('\n'));
    expect(report.length).toBe(22);
  });

  it('vibrato bends without retriggering', () => {
    const sr = 48000;
    for (const [m, cents] of [[55, 30], [40, 45], [76, 40]]) {
      const ev = trackBuffer(pluck({ sampleRate: sr, freq: midiToHz(m), duration: 1.5, vibrato: { rate: 5.5, cents, delay: 0.2 } }), sr).events;
      expect(notesOf(ev)).toEqual(['+' + m]);
      const b = bendsOf(ev);
      expect(Math.max(...b)).toBeGreaterThan(cents / 100 * 0.7);
      expect(Math.min(...b)).toBeLessThan(-cents / 100 * 0.7);
    }
  }, HEAVY);

  it('string bends become pitch bend, up to the bend range, and back', () => {
    const sr = 48000;
    for (const rise of [0.06, 0.15, 0.3]) {
      const ev = trackBuffer(pluck({ sampleRate: sr, freq: midiToHz(59), duration: 1.5, bend: { at: 0.3, rise, semis: 2, hold: 0.4, fall: 0.2 } }), sr).events;
      expect(notesOf(ev)).toEqual(['+59']);
      const b = bendsOf(ev);
      expect(Math.max(...b)).toBeGreaterThan(1.95);
      expect(Math.abs(b[b.length - 1])).toBeLessThan(0.1);
    }
  }, HEAVY);

  it('a bend past the bend range hands over to the next note, legato', () => {
    const ev = trackBuffer(pluck({ sampleRate: 48000, freq: midiToHz(64), duration: 1.2, bend: { at: 0.3, rise: 0.2, semis: 3, hold: 0.4, fall: 0.2 } }), 48000).events;
    expect(notesOf(ev)).toEqual(['+64', '-64', '+66L']);
  }, HEAVY);

  it('a wider bend range keeps a 3 semitone bend as one note', () => {
    const ev = trackBuffer(pluck({ sampleRate: 48000, freq: midiToHz(64), duration: 1.2, bend: { at: 0.3, rise: 0.2, semis: 3, hold: 0.4, fall: 0.2 } }), 48000, { bendRange: 12 }).events;
    expect(notesOf(ev)).toEqual(['+64']);
    expect(Math.max(...bendsOf(ev))).toBeGreaterThan(2.9);
  }, HEAVY);

  it('octave-prone tones (weak or missing fundamental, bridge pickup) stay in the right octave', () => {
    const sr = 48000;
    const cases = [
      [40, { amps: [0.08, 1, 0.6, 0.7, 0.3, 0.4, 0.2, 0.25, 0.1, 0.1] }],
      [45, { amps: [0, 1, 0.8, 0.5, 0.4, 0.3, 0.2] }],
      [50, { amps: [0.2, 1, 0.1, 0.5, 0.05, 0.3] }],
      [40, { beta: 0.06, harmonics: 40 }],
      [52, { beta: 0.06, harmonics: 40, inharm: 1e-4 }],
      [57, { amps: [0.1, 1, 0.3, 0.8, 0.2, 0.6] }],
    ];
    for (const [m, o] of cases) {
      const ev = trackBuffer(pluck({ sampleRate: sr, freq: midiToHz(m), duration: 1.2, ...o }), sr).events;
      expect(notesOf(ev), `MIDI ${m} ${JSON.stringify(o)}`).toEqual(['+' + m]);
    }
  }, HEAVY);

  it('hammer-ons and pull-offs are legato note changes', () => {
    const sr = 48000;
    const on = trackBuffer(pluck({ sampleRate: sr, duration: 1, pitchAt: (t) => midiToHz(t < 0.4 ? 57 : 59) }), sr).events;
    expect(notesOf(on)).toEqual(['+57', '-57', '+59L']);
    const offEv = trackBuffer(pluck({ sampleRate: sr, duration: 1, pitchAt: (t) => midiToHz(t < 0.4 ? 59 : 57) }), sr).events;
    expect(notesOf(offEv)).toEqual(['+59', '-59', '+57L']);
    const legatoLatency = (on.find(e => e.legato).time - 0.5) * 1000;
    expect(legatoLatency).toBeLessThan(60);
  }, HEAVY);

  it('a picked melody: every note, handing over without gaps', () => {
    const sr = 48000;
    const seq = [[40, 0.1], [47, 0.5], [52, 0.9], [55, 1.3], [64, 1.7]];
    for (const keep of [0, 0.25]) {
      // The fretting hand damps the previous note, fully or partly (keep = what still rings).
      const parts = seq.map(([m, t], i) => {
        const sig = pluck({ sampleRate: sr, freq: midiToHz(m), duration: 2.2 - t, start: 0, seed: m });
        const next = seq[i + 1];
        if (next) {
          const cut = Math.round((next[1] - t) * sr);
          for (let j = cut; j < sig.length; j++) sig[j] *= keep + (1 - keep) * Math.exp(-(j - cut) / (0.02 * sr));
        }
        return { at: Math.round(t * sr), sig };
      });
      const ev = trackBuffer(mix(Math.round(2.2 * sr), parts), sr).events;
      expect(notesOf(ev)).toEqual(['+40', '-40', '+47', '-47', '+52', '-52', '+55', '-55', '+64']);
      // Each hand-over: off and on at the same moment, 25-75 ms after the pick.
      for (let i = 1; i < seq.length; i++) {
        const onE = ev.filter(e => e.type === 'noteOn')[i];
        const offE = ev.filter(e => e.type === 'noteOff')[i - 1];
        expect(offE.time).toBe(onE.time);
        expect((onE.time - seq[i][1]) * 1000).toBeLessThan(75);
      }
    }
  }, HEAVY);

  it('re-picking a ringing note retriggers it', () => {
    const sr = 48000;
    const a = pluck({ sampleRate: sr, freq: midiToHz(52), duration: 1.3, start: 0 });
    const b = pluck({ sampleRate: sr, freq: midiToHz(52), duration: 0.9, start: 0, seed: 9 });
    const at = Math.round(0.5 * sr);
    const sig = new Float32Array(Math.round(1.4 * sr));
    for (let i = 0; i < sig.length; i++) sig[i] = (a[i] || 0) * (i < at ? 1 : 0.25) + (i >= at ? b[i - at] || 0 : 0);
    expect(notesOf(trackBuffer(sig, sr).events)).toEqual(['+52', '-52', '+52']);
  }, HEAVY);

  it('a palm mute ends the note fast and the dying tail does not restart it', () => {
    const sr = 48000;
    const s = pluck({ sampleRate: sr, freq: midiToHz(57), duration: 1 });
    const cut = Math.round(0.6 * sr);
    for (let i = cut; i < s.length; i++) s[i] *= Math.exp(-(i - cut) / (0.01 * sr));
    const ev = trackBuffer(s, sr).events;
    expect(notesOf(ev)).toEqual(['+57', '-57']);
    expect((ev.find(e => e.type === 'noteOff').time - 0.6) * 1000).toBeLessThan(50);
  }, HEAVY);

  it('a note ringing out ends below the gate', () => {
    const ev = trackBuffer(pluck({ sampleRate: 48000, freq: midiToHz(64), duration: 4, decay: 0.4 }), 48000).events;
    expect(notesOf(ev)).toEqual(['+64', '-64']);
  }, HEAVY);

  it('noise, hum, silence and a note below the gate produce nothing', () => {
    const sr = 48000;
    const r = makeRandom(5);
    expect(trackBuffer(new Float32Array(sr).map(() => 0.3 * (r() * 2 - 1)), sr).events).toEqual([]);
    const hum = new Float32Array(sr).map((_, i) => 0.2 * Math.sin(2 * Math.PI * 60 * i / sr));
    expect(trackBuffer(hum, sr).events).toEqual([]);
    expect(trackBuffer(new Float32Array(sr), sr).events).toEqual([]);
    expect(trackBuffer(pluck({ sampleRate: sr, freq: 220, amp: dbToGain(-62), noise: 0 }), sr).events).toEqual([]);
  }, HEAVY);

  it('works with any block size and is deterministic', () => {
    const sig = pluck({ sampleRate: 48000, freq: midiToHz(50), duration: 0.8 });
    const a = trackBuffer(sig, 48000, {}, { block: 128 }).events;
    const b = trackBuffer(sig, 48000, {}, { block: 1000 }).events;
    expect(b).toEqual(a);
    const tr = createPitchTracker({ sampleRate: 48000 });
    tr.process(sig);
    tr.reset();
    expect(tr.samples).toBe(0);
    expect(tr.note).toBeNull();
  }, HEAVY);

  it('costs a few percent of one core while playing and almost nothing in silence', () => {
    const sr = 48000;
    const sig = pluck({ sampleRate: sr, freq: midiToHz(45), duration: 4 });
    // CPU time, not wall time: the test machine may be busy with other work.
    const cpu = (x) => {
      let best = Infinity;
      for (let k = 0; k < 3; k++) { const c0 = process.cpuUsage(); trackBuffer(x, sr); const c = process.cpuUsage(c0); best = Math.min(best, (c.user + c.system) / 1000); }
      return best / (x.length / sr * 1000) * 100;
    };
    const playing = cpu(sig), quiet = cpu(new Float32Array(sig.length));
    console.log(`[pedals] tracker CPU (Node, one core): ${playing.toFixed(2)}% while a note sounds, ${quiet.toFixed(2)}% in silence`);
    expect(playing).toBeLessThan(25);
    expect(quiet).toBeLessThan(1);
  }, HEAVY);
});
